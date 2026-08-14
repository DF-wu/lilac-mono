import type { LilacBus } from "@stanley2058/lilac-event-bus";

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
import { startGithubWebhookServer } from "../github/webhook/github-webhook-server";

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
  ]);
}
