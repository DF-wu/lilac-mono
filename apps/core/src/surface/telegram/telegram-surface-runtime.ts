import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import type { LilacBus } from "@stanley2058/lilac-event-bus";
import {
  isTelegramSurfaceUsable,
  resolveTelegramDbPath,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import { Result, type Result as ResultType } from "better-result";

import { ConversationThreadOperationFailed } from "../../conversation/thread-service";
import type { CustomCommandManager } from "../../custom-commands/manager";
import { toReplyChainMessage } from "../bridge/request-composition/reply-chain";
import type { TranscriptStore } from "../../transcript/transcript-store";
import type { DurableWorkflowStore } from "../../workflow/durable-workflow-store";
import type { WorkflowProgressTarget } from "../../workflow/workflow-domain";
import { shouldSuppressRouterForWorkflowReply } from "../../workflow/workflow-router-suppression";
import type { SurfaceAdapter, SurfaceAdapterEventSource } from "../adapter";
import { bridgeAdapterToBus } from "../bridge/publish-to-bus";
import { bridgeBusToAdapter } from "../bridge/subscribe-from-bus";
import { createDescriptorBoundSurfaceEventSource } from "../produced-ref-guard";
import type { SurfaceRuntimeDescriptor } from "../runtime-descriptor";
import { TelegramAdapter } from "./telegram-adapter";
import { isTelegramChatAllowed } from "./telegram-guards";
import { tryParseTelegramSessionId } from "./telegram-ids";
import { startTelegramRequestRouter } from "./telegram-request-router";
import {
  createTelegramRelayPolicy,
  createTelegramSurfaceRuntimeDescriptor,
} from "./telegram-runtime-descriptor";
import {
  createTelegramRuntimeHealthPort,
  type TelegramRuntimeHealthProvider,
} from "./telegram-runtime-health";

/**
 * Fork-owned wiring between the Telegram surface and the core runtime.
 *
 * Everything the upstream runtime files need to know about Telegram lives
 * here, so `create-core-runtime.ts` and `compose-builtin-surface-runtimes.ts`
 * carry only one-line call sites and stay close to upstream.
 */

type TelegramSurfaceRuntimeLogger = {
  debug(message: string, context: Readonly<Record<string, unknown>>): void;
  warn(message: string, context: Readonly<Record<string, unknown>>): void;
};

export type TelegramSurfaceRuntimeInput = {
  readonly adapter: SurfaceAdapter & { stopIngress(): Promise<void> };
  readonly eventSource: SurfaceAdapterEventSource;
  readonly healthProvider: TelegramRuntimeHealthProvider;
  readonly customCommands?: CustomCommandManager;
  readonly getWorkflowStore?: () => DurableWorkflowStore;
  readonly config?: Record<string, unknown>;
};

export type TelegramSurfaceRuntimeDeps = {
  readonly bus: LilacBus;
  readonly blobStore: BlobStore;
  readonly subscriptionId: (name: string) => string;
  readonly getTranscriptStore: () => TranscriptStore | undefined;
  readonly logger: TelegramSurfaceRuntimeLogger;
};

/**
 * Construct the adapter only when the surface can actually run. An enabled
 * surface without a token is a configuration mistake worth a warning, but it
 * must not stop the rest of the core from starting.
 */
export function resolveTelegramAdapterForStartup(input: {
  readonly config: CoreConfig;
  readonly customCommands: CustomCommandManager;
  readonly logger: TelegramSurfaceRuntimeLogger;
}): TelegramAdapter | null {
  const telegram = input.config.surface.telegram;
  if (isTelegramSurfaceUsable(input.config)) {
    return new TelegramAdapter({
      customCommands: input.customCommands,
      ...(telegram.apiRoot ? { apiRoot: telegram.apiRoot } : {}),
    });
  }
  if (telegram.enabled) {
    input.logger.warn("telegram surface enabled but no token available; skipping", {
      configKey: "surface.telegram.token",
    });
  }
  return null;
}

export function telegramSurfaceRuntimeInput(input: {
  readonly adapter: TelegramAdapter;
  readonly customCommands: CustomCommandManager;
  readonly getWorkflowStore: () => DurableWorkflowStore;
}): TelegramSurfaceRuntimeInput {
  return {
    adapter: input.adapter,
    eventSource: createDescriptorBoundSurfaceEventSource("telegram", input.adapter),
    healthProvider: input.adapter,
    customCommands: input.customCommands,
    getWorkflowStore: input.getWorkflowStore,
  };
}

/**
 * Some Telegram settings only take effect on a fresh connection; surface them
 * on hot reload instead of silently keeping the old values.
 */
export async function refreshTelegramCoreConfig(
  adapter: TelegramAdapter | null,
  logger: TelegramSurfaceRuntimeLogger,
): Promise<void> {
  const refresh = await adapter?.refreshCoreConfig();
  if (!refresh || refresh.restartRequiredFor.length === 0) return;
  logger.warn("telegram config change requires a core restart", {
    configKeys: refresh.restartRequiredFor.map((field) => `surface.telegram.${field}`),
  });
}

export type TelegramConversationMemoryInput = {
  /** The Telegram history index the conversation thread store attaches as a source. */
  readonly dbPath: string;
  /** Author name reported for the bot's own messages in that index. */
  readonly botName: string;
};

/**
 * Conversation memory only sees Telegram history when the surface is running:
 * the adapter owns `telegram-surface.db`, so without it there is nothing to
 * attach and the store keeps its empty placeholder views.
 */
export function telegramConversationMemoryInput(input: {
  readonly adapter: TelegramAdapter | null;
  readonly config: CoreConfig;
}): TelegramConversationMemoryInput | undefined {
  if (!input.adapter) return undefined;
  return {
    dbPath: resolveTelegramDbPath(input.config),
    botName: input.config.surface.telegram.botName,
  };
}

/**
 * Attachment hydration for Telegram conversation summaries. The history index
 * projects attachment metadata only; bytes are never fetched here, so a
 * hydrated Telegram message carries whatever the adapter's `readMsg` reports
 * (currently nothing) and the summarizer sees metadata text instead.
 */
export async function hydrateTelegramConversationAttachments(input: {
  readonly adapter: TelegramAdapter | null;
  readonly ref: { readonly channelId: string; readonly messageId: string };
}): Promise<
  ResultType<
    {
      ref: { surface: "telegram"; channelId: string; messageId: string };
      attachments: ReturnType<typeof toReplyChainMessage>["attachments"];
    },
    ConversationThreadOperationFailed
  >
> {
  const ref = { surface: "telegram" as const, ...input.ref };
  if (!input.adapter) {
    return Result.err(
      new ConversationThreadOperationFailed({
        operation: "summarize-thread",
        message: "Telegram conversation storage is unavailable",
      }),
    );
  }
  const read = await input.adapter.readMsg({ platform: "telegram", ...input.ref });
  return read.match<
    ResultType<
      {
        ref: { surface: "telegram"; channelId: string; messageId: string };
        attachments: ReturnType<typeof toReplyChainMessage>["attachments"];
      },
      ConversationThreadOperationFailed
    >
  >({
    err: (error) =>
      Result.err(
        new ConversationThreadOperationFailed({
          operation: "summarize-thread",
          message: error.message,
        }),
      ),
    ok: (message) =>
      message
        ? Result.ok({ ref, attachments: toReplyChainMessage(message).attachments })
        : Result.err(
            new ConversationThreadOperationFailed({
              operation: "summarize-thread",
              message: `Surface message not found: ${input.ref.messageId}`,
            }),
          ),
  });
}

/**
 * Workflow progress targets are rechecked against the live chat allowlist so
 * a chat removed from `allowedChatIds` stops receiving cards. Other platforms
 * keep their own authorization and pass through unchanged.
 */
export function createTelegramWorkflowTargetAuthorizer(
  getCoreConfig: () => Promise<CoreConfig>,
): (target: WorkflowProgressTarget) => Promise<boolean> {
  return async (target) => {
    if (target.platform !== "telegram") return true;
    const parsed = tryParseTelegramSessionId(target.channelId);
    if (!parsed) return false;
    return isTelegramChatAllowed({ cfg: await getCoreConfig(), chatId: parsed.chatId });
  };
}

export function createTelegramSurfaceRuntimeEntry(
  telegram: TelegramSurfaceRuntimeInput,
  deps: TelegramSurfaceRuntimeDeps,
): SurfaceRuntimeDescriptor<"telegram"> {
  return createTelegramSurfaceRuntimeDescriptor({
    adapter: telegram.adapter,
    health: createTelegramRuntimeHealthPort(telegram.healthProvider),
    requestIngress: {
      start: async () => {
        const id = deps.subscriptionId("telegram-request-router");
        const getWorkflowStore = telegram.getWorkflowStore;
        const router = await startTelegramRequestRouter({
          adapter: telegram.adapter,
          bus: deps.bus,
          blobStore: deps.blobStore,
          subscriptionId: id,
          ...(telegram.customCommands ? { customCommands: telegram.customCommands } : {}),
          ...(telegram.config ? { config: telegram.config } : {}),
          ...(getWorkflowStore
            ? {
                shouldSuppressAdapterEvent: async ({ evt }) =>
                  shouldSuppressRouterForWorkflowReply({
                    store: getWorkflowStore(),
                    event: evt,
                  }),
              }
            : {}),
        });
        deps.logger.debug("Telegram request router started", { subscriptionId: id });
        return router;
      },
    },
    adapterIngress: {
      start: async () => {
        const id = deps.subscriptionId("telegram-adapter-to-bus");
        const handle = await bridgeAdapterToBus({
          eventSource: telegram.eventSource,
          platform: "telegram",
          bus: deps.bus,
          subscriptionId: id,
          transcriptStore: deps.getTranscriptStore(),
        });
        await telegram.adapter.connect();
        deps.logger.debug("Telegram adapter ingress started", { subscriptionId: id });
        return {
          platform: "telegram" as const,
          stop: async () => {
            await telegram.adapter.stopIngress();
            await handle.stop();
          },
        };
      },
    },
    createRelay: (guardedAdapter) => {
      const policy = createTelegramRelayPolicy();
      return {
        ...policy,
        lifecycle: {
          platform: "telegram" as const,
          start: async () => {
            const id = deps.subscriptionId("bus-to-telegram");
            const relay = await bridgeBusToAdapter({
              adapter: guardedAdapter,
              blobStore: deps.blobStore,
              bus: deps.bus,
              platform: "telegram",
              policy,
              subscriptionId: id,
              transcriptStore: deps.getTranscriptStore(),
            });
            deps.logger.debug("Telegram output relay started", { subscriptionId: id });
            return relay;
          },
        },
      };
    },
  });
}
