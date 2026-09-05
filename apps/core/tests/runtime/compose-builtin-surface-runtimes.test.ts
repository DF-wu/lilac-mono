import { describe, expect, it } from "bun:test";
import { createLilacBus } from "@stanley2058/lilac-event-bus";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import { Panic } from "better-result";

import { composeBuiltinSurfaceRuntimes } from "../../src/runtime/compose-builtin-surface-runtimes";
import type {
  AdapterEventHandler,
  SurfaceAdapter,
  SurfaceAdapterEventSource,
} from "../../src/surface/adapter";
import { createDescriptorBoundSurfaceEventSource } from "../../src/surface/produced-ref-guard";
import type { SurfaceRuntimeHealthPort } from "../../src/surface/runtime-descriptor";
import type { TelegramAdapterHealthSnapshot } from "../../src/surface/telegram/telegram-adapter";
import { createInMemoryDeliveryBus } from "../helpers/in-memory-delivery-bus";

function createComposition(input: {
  readonly webhookSecret?: string;
  readonly githubAppCredentialsAvailable: boolean;
  readonly discordHealth?: SurfaceRuntimeHealthPort;
  readonly telegramEnabled?: boolean;
}) {
  const logs: Array<{
    readonly level: "debug" | "info" | "warn";
    readonly message: string;
    readonly context: Readonly<Record<string, unknown>>;
  }> = [];
  let adapterEventHandler: AdapterEventHandler | undefined;
  let transcriptStoreLookups = 0;
  const discordAdapter = {} as SurfaceAdapter;
  const githubAdapter = {} as SurfaceAdapter;
  const telegramAdapter = Object.assign({} as SurfaceAdapter, {
    connect: async () => undefined,
    stopIngress: async () => undefined,
    getSelf: async () => ({ platform: "telegram", userId: "1", userName: "lilac" }) as const,
  });
  const eventSource: SurfaceAdapterEventSource = {
    subscribe: async (handler) => {
      adapterEventHandler = handler;
      return { stop: async () => undefined };
    },
  };
  const created = composeBuiltinSurfaceRuntimes({
    discordAdapter,
    githubAdapter,
    descriptorBoundDiscordEventSource: createDescriptorBoundSurfaceEventSource(
      "discord",
      eventSource,
    ),
    ...(input.discordHealth ? { discordHealth: input.discordHealth } : {}),
    ...(input.telegramEnabled
      ? {
          telegram: {
            adapter: telegramAdapter,
            eventSource,
            healthProvider: {
              getHealthSnapshot: (): TelegramAdapterHealthSnapshot => ({
                connectionState: "ready",
                isReady: true,
              }),
            },
            config: {
              configVersion: 2,
              surface: {
                telegram: {
                  enabled: true,
                  botName: "lilac",
                  allowedChatIds: ["1001"],
                },
                router: {
                  defaultMode: "mention",
                  sessionModes: {},
                  activeDebounceMs: 1,
                  activeGate: { enabled: false, timeoutMs: 2500 },
                },
              },
            },
          },
        }
      : {}),
    bus: createLilacBus(createInMemoryDeliveryBus()),
    blobStore: {} as BlobStore,
    subscriptionPrefix: "focused",
    webhookSecret: input.webhookSecret,
    githubAppCredentialsAvailable: input.githubAppCredentialsAvailable,
    getTranscriptStore: () => {
      transcriptStoreLookups += 1;
      return undefined;
    },
    logger: {
      debug: (message, context) => logs.push({ level: "debug", message, context }),
      info: (message, context) => logs.push({ level: "info", message, context }),
      warn: (message, context) => logs.push({ level: "warn", message, context }),
    },
    reportFatalError: () => undefined,
  });
  if (created.status === "error") throw created.error;
  return {
    registry: created.value,
    discordAdapter,
    githubAdapter,
    telegramAdapter,
    logs,
    getAdapterEventHandler: () => adapterEventHandler,
    getTranscriptStoreLookups: () => transcriptStoreLookups,
  };
}

describe("built-in surface runtime composition", () => {
  it("registers Telegram only when its runtime input is present", () => {
    const disabled = createComposition({ githubAppCredentialsAvailable: false });
    const enabled = createComposition({
      githubAppCredentialsAvailable: false,
      telegramEnabled: true,
    });

    expect(disabled.registry.entries().map(({ platform }) => platform)).toEqual([
      "discord",
      "github",
    ]);
    expect(enabled.registry.entries().map(({ platform }) => platform)).toEqual([
      "discord",
      "github",
      "telegram",
    ]);
    const telegram = enabled.registry.entries()[2];
    expect(telegram?.adapterIngress).toBeDefined();
    expect(telegram?.requestIngress).toBeDefined();
    expect(telegram?.relay).toBeDefined();
    expect(telegram?.health).toBeDefined();
    expect(telegram?.workflowProgress).toBeDefined();
  });

  it("starts Telegram adapter ingress, request ingress, and output relay together", async () => {
    const composition = createComposition({
      githubAppCredentialsAvailable: false,
      telegramEnabled: true,
    });
    const telegram = composition.registry.entries()[2];
    if (!telegram?.adapterIngress || !telegram.requestIngress || !telegram.relay) {
      throw new Error("Telegram production composition is missing an ingress stage");
    }

    const adapterIngress = await telegram.adapterIngress.start();
    const requestIngress = await telegram.requestIngress.start();
    const relay = await telegram.relay.lifecycle.start();

    expect(composition.logs).toEqual(
      expect.arrayContaining([
        {
          level: "debug",
          message: "Telegram adapter ingress started",
          context: { subscriptionId: "focused:telegram-adapter-to-bus" },
        },
        {
          level: "debug",
          message: "Telegram request router started",
          context: { subscriptionId: "focused:telegram-request-router" },
        },
        {
          level: "debug",
          message: "Telegram output relay started",
          context: { subscriptionId: "focused:bus-to-telegram" },
        },
      ]),
    );

    await relay.stop();
    await requestIngress.stop();
    await adapterIngress.stop();
  });

  it("registers optional Discord health without adding it to other descriptors", () => {
    const health: SurfaceRuntimeHealthPort = {
      getContribution: () => ({ checks: [], info: { ready: true } }),
    };
    const composition = createComposition({
      githubAppCredentialsAvailable: false,
      discordHealth: health,
    });
    const [discord, github] = composition.registry.entries();

    expect(discord?.health).toBe(health);
    expect(github?.health).toBeUndefined();
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const)(
    "preserves static order and GitHub webhook=%s/App credentials=%s availability",
    (webhookConfigured, githubAppCredentialsAvailable) => {
      const composition = createComposition({
        ...(webhookConfigured ? { webhookSecret: "webhook-secret" } : {}),
        githubAppCredentialsAvailable,
      });
      const [discord, github] = composition.registry.entries();
      if (!discord || !github) throw new Error("missing built-in surface descriptors");
      const requestIngressAvailable = webhookConfigured && githubAppCredentialsAvailable;

      expect(composition.registry.entries().map(({ platform }) => platform)).toEqual([
        "discord",
        "github",
      ]);
      expect(discord.adapter).not.toBe(composition.discordAdapter);
      expect(github.adapter).not.toBe(composition.githubAdapter);
      expect(discord.adapterIngress).toBeDefined();
      expect(discord.requestIngress).toBeUndefined();
      expect(discord.relay).toBeDefined();
      expect(github.requestIngress !== undefined).toBe(requestIngressAvailable);
      expect(github.relay !== undefined).toBe(githubAppCredentialsAvailable);
      expect(composition.logs).toEqual([
        ...(requestIngressAvailable
          ? []
          : [
              {
                level: "warn" as const,
                message: "GitHub webhook ingress unavailable",
                context: {
                  subsystem: "request-ingress",
                  reason: webhookConfigured ? "app-credentials-missing" : "webhook-secret-missing",
                },
              },
            ]),
        ...(githubAppCredentialsAvailable
          ? []
          : [
              {
                level: "info" as const,
                message: "GitHub output relay unavailable",
                context: {
                  subsystem: "output-relay",
                  reason: "app-credentials-missing",
                },
              },
            ]),
      ]);
    },
  );

  it("preserves Discord ingress, transcript lookup, relay IDs, and logging", async () => {
    const composition = createComposition({
      webhookSecret: "webhook-secret",
      githubAppCredentialsAvailable: true,
    });
    const [discord, github] = composition.registry.entries();
    if (!discord?.adapterIngress || !discord.relay || !github?.relay) {
      throw new Error("missing expected built-in runtime ports");
    }

    const ingress = await discord.adapterIngress.start();
    const eventHandler = composition.getAdapterEventHandler();
    if (!eventHandler) throw new Error("Discord event source was not subscribed");
    await eventHandler({
      type: "adapter.request.cancel",
      platform: "discord",
      ts: 1,
      requestId: "discord:channel:message",
      sessionId: "channel",
    });
    expect(() =>
      eventHandler({
        type: "adapter.request.cancel",
        platform: "github",
        ts: 2,
        requestId: "github:octo/repo#1:1",
        sessionId: "octo/repo#1",
      }),
    ).toThrow(Panic);

    const discordRelay = await discord.relay.lifecycle.start();
    const githubRelay = await github.relay.lifecycle.start();

    expect(composition.getTranscriptStoreLookups()).toBe(3);
    expect(composition.logs).toEqual([
      {
        level: "debug",
        message: "bridgeAdapterToBus started",
        context: { subscriptionId: "focused:adapter-to-bus" },
      },
      {
        level: "debug",
        message: "bridgeBusToAdapter started",
        context: { subscriptionId: "focused:bus-to-adapter" },
      },
      {
        level: "debug",
        message: "GitHub output relay started",
        context: { subscriptionId: "focused:bus-to-github" },
      },
    ]);

    await githubRelay.stop();
    await discordRelay.stop();
    await ingress.stop();
  });
});
