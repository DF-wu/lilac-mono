import { describe, expect, it } from "bun:test";
import {
  createLilacBus,
  EventDeliveryTransportFailed,
  lilacEventTypes,
  type EventDeliveryDoneError,
  type RawBus,
} from "@stanley2058/lilac-event-bus";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import { Panic, Result, type Result as ResultType } from "better-result";

import { composeBuiltinSurfaceRuntimes } from "../../src/runtime/compose-builtin-surface-runtimes";
import type {
  AdapterEventHandler,
  SurfaceAdapter,
  SurfaceAdapterEventSource,
} from "../../src/surface/adapter";
import { createDescriptorBoundSurfaceEventSource } from "../../src/surface/produced-ref-guard";
import type { SurfaceRuntimeHealthPort } from "../../src/surface/runtime-descriptor";
import type { TelegramAdapterHealthSnapshot } from "../../src/surface/telegram/telegram-adapter";
import { nativeSurfaceProtocol } from "../../src/surface/native/native-protocol";
import type { SurfaceRuntimeDescriptor } from "../../src/surface/runtime-descriptor";
import { createInMemoryDeliveryBus } from "../helpers/in-memory-delivery-bus";

function createComposition(input: {
  readonly webhookSecret?: string;
  readonly githubAppCredentialsAvailable: boolean;
  readonly discordHealth?: SurfaceRuntimeHealthPort;
  readonly telegramEnabled?: boolean;
  readonly discordEnabled?: boolean;
  readonly nativeDescriptor?: SurfaceRuntimeDescriptor<"native">;
  readonly rawBus?: RawBus;
  readonly telegramOnConnect?: (handler: AdapterEventHandler) => Promise<void>;
}) {
  const logs: Array<{
    readonly level: "debug" | "info" | "warn";
    readonly message: string;
    readonly context: Readonly<Record<string, unknown>>;
  }> = [];
  let adapterEventHandler: AdapterEventHandler | undefined;
  let transcriptStoreLookups = 0;
  let telegramConnections = 0;
  let telegramInitialized = false;
  const fatalErrors: Error[] = [];
  const discordAdapter = {} as SurfaceAdapter;
  const githubAdapter = {} as SurfaceAdapter;
  const telegramAdapter = Object.assign({} as SurfaceAdapter, {
    initialize: async () => {
      telegramInitialized = true;
    },
    connect: async () => {
      telegramConnections += 1;
      if (!input.telegramOnConnect) return;
      if (!adapterEventHandler) throw new Error("Telegram ingress was not subscribed");
      await input.telegramOnConnect(adapterEventHandler);
    },
    stopIngress: async () => undefined,
    getSelf: async () => {
      if (!telegramInitialized) throw new Error("telegram adapter: not connected");
      return { platform: "telegram", userId: "1", userName: "lilac" } as const;
    },
    readMsg: async () => Result.ok(null),
    listMsg: async () => Result.ok([]),
    getReplyContext: async () => Result.ok([]),
    planReplyChain: async () => Result.ok([]),
  });
  const eventSource: SurfaceAdapterEventSource = {
    subscribe: async (handler) => {
      adapterEventHandler = handler;
      return { stop: async () => undefined };
    },
  };
  const bus = createLilacBus(input.rawBus ?? createInMemoryDeliveryBus());
  const created = composeBuiltinSurfaceRuntimes({
    discordAdapter,
    discordEnabled: input.discordEnabled,
    nativeDescriptor: input.nativeDescriptor,
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
    bus,
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
    reportFatalError: (error) => fatalErrors.push(error),
  });
  if (created.status === "error") throw created.error;
  return {
    registry: created.value,
    discordAdapter,
    githubAdapter,
    telegramAdapter,
    bus,
    fatalErrors,
    getTelegramConnections: () => telegramConnections,
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
    expect(composition.getTelegramConnections()).toBe(0);
    await telegram.adapter.connect();
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
    expect(composition.fatalErrors).toEqual([]);
  });

  it("routes an update emitted when ingress starts after shared initialization exactly once", async () => {
    const composition = createComposition({
      githubAppCredentialsAvailable: false,
      telegramEnabled: true,
      telegramOnConnect: async (handler) => {
        await handler({
          type: "adapter.message.created",
          platform: "telegram",
          ts: 1,
          message: {
            ref: { platform: "telegram", channelId: "1001", messageId: "10" },
            session: { platform: "telegram", channelId: "1001" },
            ts: 1,
            userId: "7",
            userName: "Ada",
            text: "lilac hello",
            raw: { telegram: { mentionsBot: true, isDMBased: false, botUserId: "1" } },
          },
        });
      },
    });
    const telegram = composition.registry.entries().find((entry) => entry.platform === "telegram")!;
    const requests: string[] = [];
    await composition.bus.subscribeTopic(
      "cmd.request",
      { mode: "fanout", subscriptionId: "request-sink", consumerId: "request-sink" },
      async (message) => {
        if (message.type === lilacEventTypes.CmdRequestMessage)
          requests.push(message.headers!.request_id!);
        return Result.ok(undefined);
      },
      () => "park-pending",
    );
    const adapterIngress = await telegram.adapterIngress!.start();
    await telegram.adapter.connect();
    const requestIngress = await telegram.requestIngress!.start();
    try {
      await composition.telegramAdapter.connect();
      expect(requests).toEqual(["telegram:1001:10"]);
      expect(composition.getTelegramConnections()).toBe(1);
    } finally {
      await requestIngress.stop();
      await adapterIngress.stop();
      await composition.bus.close();
    }
  });

  for (const topic of ["evt.adapter", "evt.surface", "evt.request"] as const) {
    it.each(["rejected", "failed", "completed"] as const)(
      `reports an unexpectedly %s Telegram ${topic} router subscription and fails readiness`,
      async (termination) => {
        const raw = createInMemoryDeliveryBus();
        const done = Promise.withResolvers<ResultType<void, EventDeliveryDoneError>>();
        const rawBus: RawBus = {
          ...raw,
          subscribe: async (subscribedTopic, options, handler) => {
            const started = await raw.subscribe(subscribedTopic, options, handler);
            if (
              subscribedTopic !== topic ||
              options.mode === "tail" ||
              !options.subscriptionId.startsWith("focused:telegram-request-router:")
            )
              return started;
            return started.map((subscription) => ({
              done: done.promise,
              stop: async () => {
                done.resolve(Result.ok(undefined));
                return subscription.stop();
              },
            }));
          },
        };
        const composition = createComposition({
          githubAppCredentialsAvailable: false,
          telegramEnabled: true,
          rawBus,
        });
        const telegram = composition.registry
          .entries()
          .find((entry) => entry.platform === "telegram")!;
        const ingress = await telegram.requestIngress!.start();
        const failure = new EventDeliveryTransportFailed({
          operation: "read",
          topic,
          message: "Telegram router subscription lost",
          cause: new Error("read failed"),
        });
        const defect = new Panic({ message: "Telegram subscription defect" });
        try {
          if (termination === "rejected") done.reject(defect);
          if (termination === "failed") done.resolve(Result.err(failure));
          if (termination === "completed") done.resolve(Result.ok(undefined));
          await new Promise<void>((resolve) => setImmediate(resolve));
          for (const runtimeFullyStarted of [false, true]) {
            const health = await telegram.health!.getContribution({
              now: 1,
              runtimeFullyStarted,
              includeMemoryDiagnostics: false,
            });
            expect(health.checks.some((check) => !check.ok && check.impact === "ready")).toBe(true);
          }
          expect(composition.fatalErrors).toHaveLength(1);
          if (termination === "rejected") expect(composition.fatalErrors[0]).toBe(defect);
          if (termination === "failed") expect(composition.fatalErrors[0]).toBe(failure);
        } finally {
          await ingress.stop();
          await composition.bus.close();
        }
      },
    );
  }

  it("runs native without registering Discord ingress, relay or questions", () => {
    const composition = createComposition({
      githubAppCredentialsAvailable: false,
      discordEnabled: false,
      nativeDescriptor: { protocol: nativeSurfaceProtocol, adapter: {} as SurfaceAdapter },
    });
    expect(composition.registry.entries().map((entry) => entry.platform)).toEqual([
      "native",
      "github",
    ]);
    expect(composition.registry.adapterResolver().resolve("discord")).toBeNull();
    expect(composition.registry.questionResolver().entries()).toHaveLength(0);
    const native = composition.registry.entries()[0]!;
    expect(native.relay).toBeUndefined();
    expect(native.adapterIngress).toBeUndefined();
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

  it.each([false, true])(
    "preserves Discord ingress and relay with native enabled=%s",
    async (nativeEnabled) => {
      const composition = createComposition({
        webhookSecret: "webhook-secret",
        githubAppCredentialsAvailable: true,
        ...(nativeEnabled
          ? { nativeDescriptor: { protocol: nativeSurfaceProtocol, adapter: {} as SurfaceAdapter } }
          : {}),
      });
      const entries = composition.registry.entries();
      const discord = entries.find((entry) => entry.platform === "discord");
      const github = entries.find((entry) => entry.platform === "github");
      expect(entries.some((entry) => entry.platform === "native")).toBe(nativeEnabled);
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
    },
  );
});
