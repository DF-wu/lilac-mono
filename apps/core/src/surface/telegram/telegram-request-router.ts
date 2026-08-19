import {
  lilacEventTypes,
  type DeliveryDisposition,
  type EventDeliveryDoneError,
  type EvtAdapterMessageCreatedData,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
import { getCoreConfig, parseCoreConfigResult, type CoreConfig } from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import type { CustomCommandManager } from "../../custom-commands/manager";
import { adaptEventPublishResultToHost } from "../../shared/event-bus-result";
import type { SurfaceAdapter } from "../adapter";
import { formatTelegramMessageRequestId } from "../bridge/request-ids";
import {
  getSessionMode,
  normalizeGateText,
  parseLeadingModelOverride,
  resolveSessionGateEnabled,
  resolveSessionModelOverride,
  shouldRunDirectReplyMentionGate,
} from "../discord/discord-request-router/common";
import type { RouterGateDecision, RouterGateInput } from "../discord/discord-request-router/gate";
import { resolveTelegramBotMentionNames } from "./telegram-raw";
import {
  commandMetadata,
  composeTelegramMessages,
  messageRef,
  readMessage,
  telegramFlags,
} from "./telegram-request-router-composition";

export type { RouterGateDecision, RouterGateInput };

type TelegramRouterConfig = Record<string, unknown>;
type DebounceBuffer = {
  readonly event: EvtAdapterMessageCreatedData;
  timer: ReturnType<typeof setTimeout> | null;
};

export class TelegramRequestRoutingFailed extends TaggedError("TelegramRequestRoutingFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export type TelegramRequestRouter = {
  readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
  stop(): Promise<void>;
};

export type StartTelegramRequestRouterInput = {
  readonly adapter: SurfaceAdapter;
  readonly bus: LilacBus;
  readonly subscriptionId: string;
  readonly customCommands?: CustomCommandManager;
  readonly config?: TelegramRouterConfig;
  readonly routerGate?: (input: RouterGateInput) => Promise<RouterGateDecision>;
  readonly shouldSuppressAdapterEvent?: (input: {
    readonly evt: EvtAdapterMessageCreatedData;
  }) => Promise<{ readonly suppress: boolean; readonly reason?: string }>;
};

function deliveryPolicy(_error: TelegramRequestRoutingFailed): DeliveryDisposition {
  return "park-pending";
}

function configFromOverride(config: TelegramRouterConfig): CoreConfig {
  return parseCoreConfigResult(config).match({
    ok: (value) => value,
    err: (error) => {
      throw error;
    },
  });
}

export async function startTelegramRequestRouter(
  input: StartTelegramRequestRouterInput,
): Promise<TelegramRequestRouter> {
  const cfg = input.config ? configFromOverride(input.config) : await getCoreConfig();
  const buffers = new Map<string, DebounceBuffer>();

  const publishEvent = async (event: EvtAdapterMessageCreatedData): Promise<void> => {
    const self = await input.adapter.getSelf();
    if (self.platform !== "telegram") {
      throw new Panic({ message: "Telegram request router requires a Telegram adapter" });
    }
    const flags = telegramFlags(event);
    const isDm = flags.isDMBased === true;
    const mode = isDm ? "active" : getSessionMode(cfg, event.channelId, flags.parentChannelId);
    const botNames = resolveTelegramBotMentionNames({
      botName: cfg.surface.telegram.botName,
      botUsername: cfg.surface.telegram.botUsername,
    });
    const modelOverride =
      parseLeadingModelOverride({ text: event.text, botNames }) ??
      resolveSessionModelOverride(cfg, event.channelId, flags.parentChannelId);
    const customCommand = input.customCommands
      ? commandMetadata(input.customCommands, event.text, cfg.surface.telegram.botUsername)
      : null;
    if (!customCommand && mode === "mention" && !flags.mentionsBot && !flags.replyToBot) return;

    if (
      !isDm &&
      resolveSessionGateEnabled(cfg, event.channelId, flags.parentChannelId) &&
      shouldRunDirectReplyMentionGate({
        replyToBot: flags.replyToBot === true,
        mentionsBot: flags.mentionsBot === true,
        text: event.text,
        botNames,
      })
    ) {
      const repliedTo = flags.replyToMessageId
        ? await readMessage(input.adapter, {
            platform: "telegram",
            channelId: event.channelId,
            messageId: flags.replyToMessageId,
          })
        : null;
      const decision = await input.routerGate?.({
        sessionId: event.channelId,
        botName: cfg.surface.telegram.botName,
        messages: [
          {
            msgRef: messageRef(event),
            userId: event.userId,
            text: event.text,
            ts: event.ts,
            mentionsBot: flags.mentionsBot === true,
            replyToBot: flags.replyToBot === true,
          },
        ],
        context: {
          mode: "direct-reply-mention-disambiguation",
          triggerMessageText: normalizeGateText(event.text),
          repliedToMessageText: normalizeGateText(repliedTo?.text),
        },
      });
      if (decision && !decision.forward) return;
    }

    const composed = await composeTelegramMessages({
      adapter: input.adapter,
      event,
      botUserId: self.userId,
      botNames,
      modelOverride,
      inboundMedia: cfg.surface.telegram.inboundMedia,
    });
    const requestId = formatTelegramMessageRequestId({
      sessionId: event.channelId,
      messageId: event.messageId,
    });
    let triggerType: "active" | "mention" | "reply" = "active";
    if (flags.replyToBot) triggerType = "reply";
    else if (flags.mentionsBot) triggerType = "mention";
    adaptEventPublishResultToHost(
      await input.bus.publish(
        lilacEventTypes.CmdRequestMessage,
        {
          queue: "prompt",
          messages: composed.messages,
          ...(modelOverride ? { modelOverride } : {}),
          raw: {
            authenticatedOrigin: {
              platform: "telegram",
              userId: event.userId,
              messageRef: messageRef(event),
            },
            triggerType,
            chainMessageIds: composed.chainMessageIds,
            participantUserIds: [event.userId],
            ...customCommand,
          },
        },
        {
          headers: {
            request_id: requestId,
            session_id: event.channelId,
            request_client: "telegram",
          },
        },
      ),
    );
  };

  const flush = async (sessionId: string): Promise<void> => {
    const buffer = buffers.get(sessionId);
    if (!buffer) return;
    buffers.delete(sessionId);
    if (buffer.timer) clearTimeout(buffer.timer);
    await publishEvent(buffer.event);
  };

  const started = await input.bus.subscribeTopic(
    "evt.adapter",
    {
      mode: "fanout",
      subscriptionId: `${input.subscriptionId}:adapter`,
      consumerId: `${input.subscriptionId}:adapter:${process.pid}`,
    },
    async (message) => {
      if (
        message.type !== lilacEventTypes.EvtAdapterMessageCreated ||
        message.data.platform !== "telegram"
      ) {
        return Result.ok(undefined);
      }
      try {
        const suppressed = await input.shouldSuppressAdapterEvent?.({ evt: message.data });
        if (suppressed?.suppress) return Result.ok(undefined);
        const flags = telegramFlags(message.data);
        const mode = flags.isDMBased
          ? "active"
          : getSessionMode(cfg, message.data.channelId, flags.parentChannelId);
        if (mode === "active" && !flags.isDMBased && !flags.mentionsBot && !flags.replyToBot) {
          const previous = buffers.get(message.data.channelId);
          if (previous?.timer) clearTimeout(previous.timer);
          const buffer: DebounceBuffer = { event: message.data, timer: null };
          buffer.timer = setTimeout(
            () => void flush(message.data.channelId),
            cfg.surface.router.activeDebounceMs,
          );
          buffers.set(message.data.channelId, buffer);
          return Result.ok(undefined);
        }
        await publishEvent(message.data);
        return Result.ok(undefined);
      } catch (cause) {
        if (Panic.is(cause)) throw cause;
        return Result.err(
          new TelegramRequestRoutingFailed({
            cause,
            message: "Telegram request routing failed",
          }),
        );
      }
    },
    deliveryPolicy,
  );
  return started.match({
    err: (error) => {
      throw error;
    },
    ok: (subscription) => ({
      done: subscription.done,
      stop: async () => {
        for (const sessionId of buffers.keys()) await flush(sessionId);
        const stopped = await subscription.stop();
        stopped.match({
          ok: () => undefined,
          err: (error) => {
            throw error;
          },
        });
      },
    }),
  });
}
