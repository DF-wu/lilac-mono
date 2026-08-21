import type { LilacBus } from "@stanley2058/lilac-event-bus";

import type { CustomCommandManager } from "../custom-commands/manager";
import { startGithubWebhookServer } from "../github/webhook/github-webhook-server";
import type { TranscriptStore } from "../transcript/transcript-store";
import type { SurfaceAdapter, SurfaceAdapterEventSource } from "../surface/adapter";
import { bridgeAdapterToBus } from "../surface/bridge/publish-to-bus";
import { bridgeBusToAdapter } from "../surface/bridge/subscribe-from-bus";
import {
  createDiscordRelayPolicy,
  createDiscordSurfaceRuntimeDescriptor,
} from "../surface/discord/discord-runtime-descriptor";
import {
  createConfiguredGithubSurfaceRuntimeDescriptor,
  createGithubRelayPolicy,
} from "../surface/github/github-runtime-descriptor";
import {
  SurfaceRuntimeRegistry,
  type SurfaceRelayRecovery,
  type SurfaceRuntimeHealthPort,
} from "../surface/runtime-descriptor";
import {
  createTelegramRelayPolicy,
  createTelegramSurfaceRuntimeDescriptor,
} from "../surface/telegram/telegram-runtime-descriptor";
import type { TelegramRuntimeHealthProvider } from "../surface/telegram/telegram-runtime-health";
import { createTelegramRuntimeHealthPort } from "../surface/telegram/telegram-runtime-health";
import { startTelegramRequestRouter } from "../surface/telegram/telegram-request-router";
import type { DurableWorkflowStore } from "../workflow/durable-workflow-store";
import { shouldSuppressRouterForWorkflowReply } from "../workflow/workflow-router-suppression";

type BuiltinSurfaceRuntimeLogger = {
  debug(message: string, context: Readonly<Record<string, unknown>>): void;
  info(message: string, context: Readonly<Record<string, unknown>>): void;
  warn(message: string, context: Readonly<Record<string, unknown>>): void;
};

export type ComposeBuiltinSurfaceRuntimesInput = {
  readonly discordAdapter: SurfaceAdapter;
  readonly githubAdapter: SurfaceAdapter;
  readonly descriptorBoundDiscordEventSource: SurfaceAdapterEventSource;
  readonly discordHealth?: SurfaceRuntimeHealthPort;
  readonly telegram?: {
    readonly adapter: SurfaceAdapter & { stopIngress(): Promise<void> };
    readonly eventSource: SurfaceAdapterEventSource;
    readonly healthProvider: TelegramRuntimeHealthProvider;
    readonly customCommands?: CustomCommandManager;
    readonly getWorkflowStore?: () => DurableWorkflowStore;
    readonly config?: Record<string, unknown>;
  };
  readonly bus: LilacBus;
  readonly subscriptionPrefix: string;
  readonly webhookSecret: string | undefined;
  readonly githubAppCredentialsAvailable: boolean;
  readonly getTranscriptStore: () => TranscriptStore | undefined;
  readonly activateRestoredDiscordOutputChains: SurfaceRelayRecovery<"discord">["activateRestoredOutputChains"];
  readonly logger: BuiltinSurfaceRuntimeLogger;
  readonly reportFatalError: (error: Error) => void;
};

export function composeBuiltinSurfaceRuntimes(input: ComposeBuiltinSurfaceRuntimesInput) {
  const subscriptionId = (name: string) => `${input.subscriptionPrefix}:${name}`;
  const telegram = input.telegram;

  return SurfaceRuntimeRegistry.create([
    createDiscordSurfaceRuntimeDescriptor({
      adapter: input.discordAdapter,
      ...(input.discordHealth ? { health: input.discordHealth } : {}),
      adapterIngress: {
        start: async () => {
          const id = subscriptionId("adapter-to-bus");
          const handle = await bridgeAdapterToBus({
            eventSource: input.descriptorBoundDiscordEventSource,
            platform: "discord",
            bus: input.bus,
            subscriptionId: id,
            transcriptStore: input.getTranscriptStore(),
          });
          input.logger.debug("bridgeAdapterToBus started", { subscriptionId: id });
          return { platform: "discord", stop: () => handle.stop() };
        },
      },
      createRelay: (guardedAdapter) => {
        const policy = createDiscordRelayPolicy(guardedAdapter, {
          activateRestoredOutputChains: input.activateRestoredDiscordOutputChains,
        });
        return {
          ...policy,
          lifecycle: {
            platform: "discord",
            start: async () => {
              const id = subscriptionId("bus-to-adapter");
              const relay = await bridgeBusToAdapter({
                adapter: guardedAdapter,
                bus: input.bus,
                platform: "discord",
                policy,
                subscriptionId: id,
                transcriptStore: input.getTranscriptStore(),
              });
              input.logger.debug("bridgeBusToAdapter started", { subscriptionId: id });
              return relay;
            },
          },
        };
      },
    }),
    createConfiguredGithubSurfaceRuntimeDescriptor({
      adapter: input.githubAdapter,
      webhookSecret: input.webhookSecret,
      appCredentialsAvailable: input.githubAppCredentialsAvailable,
      logger: input.logger,
      requestIngress: {
        start: async () =>
          await startGithubWebhookServer({
            bus: input.bus,
            subscriptionId: subscriptionId("github-webhook"),
            reportFatalError: input.reportFatalError,
          }),
      },
      createRelay: (guardedAdapter) => {
        const policy = createGithubRelayPolicy();
        return {
          ...policy,
          lifecycle: {
            platform: "github",
            start: async () => {
              const id = subscriptionId("bus-to-github");
              const relay = await bridgeBusToAdapter({
                adapter: guardedAdapter,
                bus: input.bus,
                platform: "github",
                policy,
                subscriptionId: id,
                transcriptStore: input.getTranscriptStore(),
              });
              input.logger.debug("GitHub output relay started", { subscriptionId: id });
              return relay;
            },
          },
        };
      },
    }),
    ...(telegram
      ? [
          createTelegramSurfaceRuntimeDescriptor({
            adapter: telegram.adapter,
            health: createTelegramRuntimeHealthPort(telegram.healthProvider),
            requestIngress: {
              start: async () => {
                const id = subscriptionId("telegram-request-router");
                const getWorkflowStore = telegram.getWorkflowStore;
                const router = await startTelegramRequestRouter({
                  adapter: telegram.adapter,
                  bus: input.bus,
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
                input.logger.debug("Telegram request router started", { subscriptionId: id });
                return router;
              },
            },
            adapterIngress: {
              start: async () => {
                const id = subscriptionId("telegram-adapter-to-bus");
                const handle = await bridgeAdapterToBus({
                  eventSource: telegram.eventSource,
                  platform: "telegram",
                  bus: input.bus,
                  subscriptionId: id,
                  transcriptStore: input.getTranscriptStore(),
                });
                await telegram.adapter.connect();
                input.logger.debug("Telegram adapter ingress started", { subscriptionId: id });
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
                    const id = subscriptionId("bus-to-telegram");
                    const relay = await bridgeBusToAdapter({
                      adapter: guardedAdapter,
                      bus: input.bus,
                      platform: "telegram",
                      policy,
                      subscriptionId: id,
                      transcriptStore: input.getTranscriptStore(),
                    });
                    input.logger.debug("Telegram output relay started", { subscriptionId: id });
                    return relay;
                  },
                },
              };
            },
          }),
        ]
      : []),
  ]);
}
