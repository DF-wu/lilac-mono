import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLilacBus, lilacEventTypes, type RawBus } from "@stanley2058/lilac-event-bus";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils/core-config/v2";
import { Result } from "better-result";
import type { Update } from "grammy/types";

import {
  connectAndValidateSurfaceAdapters,
  disconnectSurfaceAdapters,
  startSurfaceAdapterIngress,
  startSurfaceOutputs,
  stopSurfaceAdapterIngress,
  stopSurfaceOutputs,
  type ConnectedSurfaceAdapters,
  type SurfaceAdapterIngressHandles,
  type SurfaceRelayHandles,
  type SurfaceRequestIngressHandles,
} from "../../../src/runtime/surface-runtime-lifecycle";
import type { AdapterEventHandler, SurfaceAdapter } from "../../../src/surface/adapter";
import type { AdapterMessageCreatedEvent } from "../../../src/surface/events";
import { discordSurfaceProtocol } from "../../../src/surface/discord/discord-surface-protocol";
import { createDescriptorBoundSurfaceEventSource } from "../../../src/surface/produced-ref-guard";
import { SurfaceRuntimeRegistry } from "../../../src/surface/runtime-descriptor";
import { TelegramAdapter } from "../../../src/surface/telegram/telegram-adapter";
import { TelegramSurfaceStore } from "../../../src/surface/telegram/store/telegram-surface-store";
import { createTelegramSurfaceRuntimeEntry } from "../../../src/surface/telegram/telegram-surface-runtime";
import { DurableWorkflowStore } from "../../../src/workflow/durable-workflow-store";
import { startWorkflowActionResolver } from "../../../src/workflow/workflow-action-resolver";
import {
  canonicalJsonSha256,
  WORKFLOW_RUNTIME_VERSION,
} from "../../../src/workflow/workflow-definition";
import { WorkflowWaitResolver } from "../../../src/workflow/workflow-wait-resolver";
import { getTestBlobStore } from "../../helpers/blob-store";
import { createInMemoryDeliveryBus } from "../../helpers/in-memory-delivery-bus";
import {
  normalizeWorkflowResourcePolicy,
  workflowStoreValue,
} from "../../workflow/workflow-store-test-helpers";
import { workflowSourceArtifactReferenceForTest } from "../../workflow/workflow-test-blob-store";
import { FakeBotApiServer } from "./fake-bot-api-server";
import { makeMessage, makeReplyTo } from "./telegram-fixtures";

function seedReplyWait(store: DurableWorkflowStore, messageId = "anchor-1"): void {
  const resources = normalizeWorkflowResourcePolicy({
    agents: { maxConcurrent: 1, maxTotal: 1 },
    maxNestingDepth: 1,
    operationIdleTimeoutMs: 10000,
    waits: ["reply"],
  });
  const limits = {
    maxSourceBytes: 10000,
    maxInputBytes: 10000,
    maxOperationOutputBytes: 10000,
    maxResultBytes: 10000,
  };
  workflowStoreValue(
    store.createInvocation({
      revision: {
        revisionId: "revision-1",
        canonicalProjectId: "project-1",
        canonicalWorkspaceRoot: "/workspace",
        scope: "project",
        normalizedPath: "reply.js",
        name: "reply",
        snapshotArtifact: workflowSourceArtifactReferenceForTest("reply"),
        sourceSha256: "a".repeat(64),
        inputSchemaSha256: "b".repeat(64),
        resourcePolicySha256: canonicalJsonSha256({ resources, limits }),
        metadata: { name: "reply", description: "Wait for a reply" },
        inputSchema: { type: "object", additionalProperties: false },
        resources,
        limits,
        runtimeVersion: WORKFLOW_RUNTIME_VERSION,
        createdAt: 1,
      },
      run: {
        runId: "run-1",
        revisionId: "revision-1",
        state: "queued",
        inputSchemaSnapshot: { type: "object", additionalProperties: false },
        args: {},
        argsSha256: canonicalJsonSha256({}),
        origin: {
          requestId: "telegram:1001:origin",
          sessionId: "1001",
          client: "telegram",
          userId: "7",
          projectCwd: "/workspace",
        },
        completionTarget: { kind: "detached" },
        progressTarget: null,
        terminalDetail: null,
        result: null,
        resultArtifact: null,
        claimedBy: null,
        claimedAt: null,
        createdAt: 1,
        startedAt: null,
        updatedAt: 1,
        terminalAt: null,
      },
    }),
  );
  expect(store.tryClaimRun({ runId: "run-1", claimerId: "engine", now: 2 })).toMatchObject({
    state: "running",
  });
  expect(
    store.createOperation(
      {
        runId: "run-1",
        operationId: "wait-1",
        callSiteId: "site-1",
        parentOperationId: null,
        phase: null,
        label: "reply",
        kind: "wait",
        input: {},
        inputSha256: canonicalJsonSha256({}),
        state: "blocked",
        attempt: 0,
        requestId: null,
        output: null,
        resultArtifact: null,
        error: null,
        usage: null,
        claimedBy: null,
        claimedAt: null,
        createdAt: 3,
        startedAt: 3,
        updatedAt: 3,
        terminalAt: null,
      },
      "engine",
    ),
  ).toBe(true);
  expect(
    store.createWait(
      {
        runId: "run-1",
        operationId: "wait-1",
        state: "pending",
        match: {
          kind: "reply",
          platform: "telegram",
          channelId: "1001",
          messageId,
          fromUserId: "7",
        },
        matchKey: "telegram:1001",
        dueAt: null,
        deadlineAt: Date.now() + 60_000,
        resolverCursor: null,
        result: null,
        resolvedBy: null,
        claimedBy: null,
        claimedAt: null,
        createdAt: 3,
        updatedAt: 3,
        resolvedAt: null,
      },
      "engine",
    ),
  ).toBe(true);
}

function startupEvent(messageId: string, replyToMessageId?: string): AdapterMessageCreatedEvent {
  return {
    type: "adapter.message.created",
    platform: "telegram",
    ts: Date.now(),
    message: {
      ref: { platform: "telegram", channelId: "1001", messageId },
      session: { platform: "telegram", channelId: "1001" },
      userId: "7",
      userName: "Ada",
      text: "lilac continue",
      ts: Date.now(),
      raw: { telegram: { mentionsBot: true, isDMBased: true, replyToMessageId } },
    },
  };
}

async function realTelegramLifecycle(input: { token?: string; failRouterStart?: boolean } = {}) {
  const scratch = await mkdtemp(path.join(tmpdir(), "lilac-telegram-it-"));
  const server = new FakeBotApiServer();
  const dbPath = path.join(scratch, "telegram.db");
  const config = parseCoreConfigV2ToUniversal({
    configVersion: 2,
    surface: {
      telegram: {
        enabled: true,
        token: "000000:fake-token",
        botName: "lilac",
        allowedChatIds: ["1001"],
        dbPath,
        commandMenu: false,
      },
      router: { defaultMode: "mention", activeGate: { enabled: false } },
    },
  });
  const adapter = new TelegramAdapter({
    apiRoot: server.url,
    getConfig: async () => ({
      ...config,
      surface: {
        ...config.surface,
        telegram: {
          ...config.surface.telegram,
          token: input.token ?? config.surface.telegram.token,
        },
      },
    }),
  });
  const transport = createInMemoryDeliveryBus(
    undefined,
    undefined,
    true,
    (topic) => input.failRouterStart === true && topic === "evt.surface",
  );
  const replayDispositions: string[] = [];
  const raw: RawBus = {
    ...transport,
    subscribe: async (topic, options, handler) => {
      const subscription = await transport.subscribe(topic, options, handler);
      if (
        topic !== "evt.adapter" ||
        options.mode === "tail" ||
        options.subscriptionId !== "real:telegram-request-router:adapter"
      )
        return subscription;
      // An existing managed Redis group can deliver retained work before subscribe returns.
      const retained = await transport.fetch(topic, { offset: { type: "begin" } });
      for (const { msg, cursor } of retained.messages) {
        const action = await handler(msg, {
          mode: "fanout",
          cursor,
          deliveryId: "0".repeat(64),
          attempt: 1,
          leaseDeadline: Date.now() + 60_000,
          signal: new AbortController().signal,
          evidence: {
            source: { transport: "redis-streams", streamKey: topic, topic, messageId: cursor },
            wire: { kind: "bounded-complete", fields: [] },
          },
        });
        replayDispositions.push(action.disposition);
      }
      return subscription;
    },
    retireConsumerGroup: async () => "absent",
    trimBeforeCheckpoint: async () => 0,
  };
  const bus = createLilacBus(raw);
  const store = new DurableWorkflowStore(":memory:");
  seedReplyWait(store, "9");
  const fatalErrors: Error[] = [];
  const registry = workflowStoreValue(
    SurfaceRuntimeRegistry.create([
      createTelegramSurfaceRuntimeEntry(
        {
          adapter,
          eventSource: createDescriptorBoundSurfaceEventSource("telegram", adapter),
          healthProvider: adapter,
          getWorkflowStore: () => store,
          config: { configVersion: 2, surface: config.surface },
        },
        {
          bus,
          blobStore: await getTestBlobStore(),
          subscriptionId: (name) => `real:${name}`,
          getTranscriptStore: () => undefined,
          logger: { debug: () => undefined, warn: () => undefined },
          reportFatalError: (error) => fatalErrors.push(error),
        },
      ),
    ]),
  );
  const ingress: SurfaceAdapterIngressHandles = new Map();
  const requestIngress: SurfaceRequestIngressHandles = new Map();
  const relays: SurfaceRelayHandles = new Map();
  const connected: ConnectedSurfaceAdapters = new Map();
  const waitResolver = new WorkflowWaitResolver({ bus, store, subscriptionId: "real:waits" });
  let actions: { stop(): Promise<void> } | undefined;
  const requests: string[] = [];
  let resumptions = 0;
  const runCleanup = async (_label: string, cleanup: (() => Promise<void>) | undefined) =>
    cleanup?.();
  return {
    adapter,
    server,
    store,
    dbPath,
    bus,
    requests,
    replayDispositions,
    fatalErrors,
    connected,
    getResumptions: () => resumptions,
    installConsumers: async () => {
      await startSurfaceAdapterIngress({ registry, handles: ingress });
      await bus.subscribeTopic(
        "evt.workflow",
        { mode: "fanout", subscriptionId: "real:resumptions", consumerId: "resumptions" },
        async (message) => {
          if (message.type === lilacEventTypes.EvtWorkflowProgressRequested) resumptions += 1;
          return Result.ok(undefined);
        },
        () => "park-pending",
      );
      actions = await startWorkflowActionResolver({
        bus,
        store,
        subscriptionId: "real:actions",
        surfaceProtocolResolver: registry.protocolResolver(),
      });
      await waitResolver.start();
      await connectAndValidateSurfaceAdapters({ registry, connected });
      await bus.subscribeTopic(
        "cmd.request",
        { mode: "fanout", subscriptionId: "real:requests", consumerId: "requests" },
        async (message) => {
          if (message.type === lilacEventTypes.CmdRequestMessage)
            requests.push(message.headers!.request_id!);
          return Result.ok(undefined);
        },
        () => "park-pending",
      );
      await startSurfaceOutputs({ registry, requestIngress, relays });
    },
    startIngress: () => adapter.startIngress(),
    stop: async () => {
      await stopSurfaceAdapterIngress({ registry, handles: ingress, runCleanup, graceful: false });
      await stopSurfaceOutputs({ registry, requestIngress, relays, runCleanup });
      await waitResolver.stop();
      await actions?.stop();
      await disconnectSurfaceAdapters({ registry, connected, runCleanup });
      await bus.close();
      store.close();
      await server.close();
      await rm(scratch, { recursive: true, force: true });
    },
  };
}

async function waitForLifecycleCondition(isSatisfied: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!isSatisfied()) {
    if (Date.now() >= deadline) throw new Error("Telegram lifecycle condition did not settle");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("Telegram runtime lifecycle", () => {
  it.each(["queued bus", "outbox", "polling"] as const)(
    "routes %s startup delivery once with the real adapter",
    async (source) => {
      const fixture = await realTelegramLifecycle();
      try {
        const events = [startupEvent("10"), startupEvent("11", "9")];
        if (source === "queued bus") {
          for (const event of events) {
            const message = event.message;
            workflowStoreValue(
              await fixture.bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
                platform: "telegram",
                channelId: "1001",
                messageId: message.ref.messageId,
                userId: message.userId,
                userName: message.userName,
                text: message.text,
                ts: message.ts,
                raw: message.raw,
              }),
            );
          }
        }
        if (source === "outbox") {
          const index = new TelegramSurfaceStore(fixture.dbPath);
          for (const event of events) {
            index.enqueueIngress({
              dedupeKey: `created:1001:${event.message.ref.messageId}`,
              payloadJson: JSON.stringify(event),
              ts: event.ts,
            });
          }
          index.close();
        }
        if (source === "polling") {
          for (const [messageId, reply] of [
            [10, false],
            [11, true],
          ] as const) {
            fixture.server.enqueueMessage(
              makeMessage({
                message_id: messageId,
                from: { id: 7, is_bot: false, first_name: "Ada" },
                text: "lilac continue",
                ...(reply ? { reply_to_message: makeReplyTo({ message_id: 9 }) } : {}),
              }) as NonNullable<Update["message"]>,
            );
          }
        }
        await fixture.installConsumers();
        expect(fixture.server.callsOf("getUpdates")).toHaveLength(0);
        if (source === "queued bus") {
          expect(fixture.requests).toEqual(["telegram:1001:10"]);
          expect(fixture.replayDispositions).toEqual(["commit", "commit"]);
        } else {
          expect(fixture.requests).toEqual([]);
        }
        await fixture.startIngress();
        await fixture.adapter.whenReady();
        await waitForLifecycleCondition(
          () => fixture.requests.length === 1 && fixture.getResumptions() === 1,
        );
        await fixture.adapter.stopIngress();
        expect(fixture.requests).toEqual(["telegram:1001:10"]);
        expect(fixture.getResumptions()).toBe(1);
        expect(workflowStoreValue(fixture.store.getWait("run-1", "wait-1"))).toMatchObject({
          state: "resolved",
          result: { platform: "telegram", messageId: "11", text: "lilac continue" },
        });
        const index = new TelegramSurfaceStore(fixture.dbPath);
        expect(index.countPendingIngress()).toBe(0);
        index.close();
      } finally {
        await fixture.stop();
      }
      expect(fixture.fatalErrors).toEqual([]);
      expect(fixture.adapter.getHealthSnapshot().connectionState).toBe("disconnected");
      expect(fixture.connected.size).toBe(0);
    },
    15_000,
  );

  it.each(["identity", "token resolution", "consumer startup"] as const)(
    "cleans shared Telegram initialization after %s fails without starting ingress",
    async (failure) => {
      const fixture = await realTelegramLifecycle({
        ...(failure === "token resolution" ? { token: "" } : {}),
        failRouterStart: failure === "consumer startup",
      });
      if (failure === "identity") {
        fixture.server.failNext("getMe", { errorCode: 401, description: "Unauthorized" });
      }
      try {
        await expect(fixture.installConsumers()).rejects.toBeDefined();
        expect(fixture.connected.has("telegram")).toBe(true);
        expect(fixture.server.callsOf("getUpdates")).toHaveLength(0);
        if (failure === "consumer startup") {
          expect((await fixture.adapter.getSelf()).platform).toBe("telegram");
          expect((await fixture.adapter.listSessions()).status).toBe("ok");
        }
      } finally {
        await fixture.stop();
      }
      await expect(fixture.adapter.getSelf()).rejects.toThrow("telegram adapter: not connected");
      expect((await fixture.adapter.listSessions()).status).toBe("error");
      expect(fixture.adapter.getHealthSnapshot().connectionState).toBe("disconnected");
      expect(fixture.connected.size).toBe(0);
      expect(fixture.fatalErrors).toEqual([]);
    },
  );

  it("supervises polling failure after the initialized runtime starts ingress", async () => {
    const fixture = await realTelegramLifecycle();
    try {
      fixture.server.failNext("getUpdates", { errorCode: 401, description: "Unauthorized" });
      await fixture.installConsumers();
      await fixture.startIngress();
      await waitForLifecycleCondition(
        () => fixture.adapter.getHealthSnapshot().connectionState === "failed",
      );
      await expect(fixture.adapter.whenReady()).rejects.toThrow();
      expect(fixture.adapter.getHealthSnapshot()).toMatchObject({
        isReady: false,
        pollingExitFatal: true,
      });
    } finally {
      await fixture.stop();
    }
    expect(fixture.adapter.getHealthSnapshot().connectionState).toBe("disconnected");
    expect(fixture.connected.size).toBe(0);
    expect(fixture.fatalErrors).toEqual([]);
  });

  it("installs consumers before connect-time updates and retains one request and one workflow resumption", async () => {
    const store = new DurableWorkflowStore(":memory:");
    seedReplyWait(store);
    const raw: RawBus = {
      ...createInMemoryDeliveryBus(),
      retireConsumerGroup: async () => "absent",
      trimBeforeCheckpoint: async () => 0,
    };
    const bus = createLilacBus(raw);
    const requests: string[] = [];
    let resumptions = 0;
    await bus.subscribeTopic(
      "evt.workflow",
      { mode: "fanout", subscriptionId: "resumption-sink", consumerId: "resumption-sink" },
      async (message) => {
        if (
          message.type === lilacEventTypes.EvtWorkflowProgressRequested &&
          message.data.runId === "run-1"
        )
          resumptions += 1;
        return Result.ok(undefined);
      },
      () => "park-pending",
    );
    let handler: AdapterEventHandler | undefined;
    let initialized = false;
    let connects = 0;
    let disconnects = 0;
    const adapter = Object.assign({} as SurfaceAdapter, {
      initialize: async () => {
        initialized = true;
      },
      connect: async () => {
        connects += 1;
        if (!handler) throw new Error("Telegram ingress missing at connection");
        for (const [messageId, replyToMessageId] of [
          ["10", undefined],
          ["11", "anchor-1"],
        ] as const) {
          await handler({
            type: "adapter.message.created",
            platform: "telegram",
            ts: Date.now(),
            message: {
              ref: { platform: "telegram", channelId: "1001", messageId },
              session: { platform: "telegram", channelId: "1001" },
              userId: "7",
              userName: "Ada",
              text: "lilac continue",
              ts: Date.now(),
              raw: {
                telegram: { mentionsBot: true, isDMBased: false, botUserId: "1", replyToMessageId },
              },
            },
          });
        }
      },
      stopIngress: async () => undefined,
      disconnect: async () => {
        disconnects += 1;
      },
      getSelf: async () => {
        if (!initialized) throw new Error("telegram adapter: not connected");
        return { platform: "telegram", userId: "1", userName: "lilac" } as const;
      },
      readMsg: async () => Result.ok(null),
      listMsg: async () => Result.ok([]),
      getReplyContext: async () => Result.ok([]),
      planReplyChain: async () => Result.ok([]),
    });
    const fatalErrors: Error[] = [];
    let discordConnects = 0;
    let discordDisconnects = 0;
    const registry = workflowStoreValue(
      SurfaceRuntimeRegistry.create([
        {
          protocol: discordSurfaceProtocol,
          adapter: Object.assign({} as SurfaceAdapter, {
            connect: async () => {
              discordConnects += 1;
            },
            disconnect: async () => {
              discordDisconnects += 1;
            },
            getSelf: async () =>
              ({ platform: "discord", userId: "discord-bot", userName: "lilac" }) as const,
          }),
        },
        createTelegramSurfaceRuntimeEntry(
          {
            adapter,
            eventSource: {
              subscribe: async (listener) => {
                handler = listener;
                return { stop: async () => undefined };
              },
            },
            healthProvider: {
              getHealthSnapshot: () => ({ connectionState: "ready", isReady: true }),
            },
            getWorkflowStore: () => store,
            config: {
              configVersion: 2,
              surface: {
                telegram: { enabled: true, botName: "lilac", allowedChatIds: ["1001"] },
                router: { defaultMode: "mention", activeGate: { enabled: false } },
              },
            },
          },
          {
            bus,
            blobStore: await getTestBlobStore(),
            subscriptionId: (name) => `lifecycle:${name}`,
            getTranscriptStore: () => undefined,
            logger: { debug: () => undefined, warn: () => undefined },
            reportFatalError: (error) => fatalErrors.push(error),
          },
        ),
      ]),
    );
    const ingress: SurfaceAdapterIngressHandles = new Map();
    const requestIngress: SurfaceRequestIngressHandles = new Map();
    const relays: SurfaceRelayHandles = new Map();
    const connected: ConnectedSurfaceAdapters = new Map();
    const waitResolver = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "waits",
    });
    let actions: { stop(): Promise<void> } | undefined;
    const runCleanup = async (_label: string, cleanup: (() => Promise<void>) | undefined) =>
      cleanup?.();
    try {
      await startSurfaceAdapterIngress({ registry, handles: ingress });
      expect(connects).toBe(0);
      actions = await startWorkflowActionResolver({
        bus,
        store,
        subscriptionId: "actions",
        surfaceProtocolResolver: registry.protocolResolver(),
      });
      await waitResolver.start();
      await connectAndValidateSurfaceAdapters({
        registry,
        connected,
      });
      expect(connects).toBe(0);
      expect(discordConnects).toBe(1);
      await bus.subscribeTopic(
        "cmd.request",
        { mode: "fanout", subscriptionId: "request-sink", consumerId: "request-sink" },
        async (message) => {
          if (message.type === lilacEventTypes.CmdRequestMessage)
            requests.push(message.headers!.request_id!);
          return Result.ok(undefined);
        },
        () => "park-pending",
      );
      await startSurfaceOutputs({ registry, requestIngress, relays });
      await adapter.connect();

      expect(connects).toBe(1);
      expect(discordConnects).toBe(1);
      expect(requests).toEqual(["telegram:1001:10"]);
      expect(resumptions).toBe(1);
      expect(workflowStoreValue(store.getWait("run-1", "wait-1"))).toMatchObject({
        state: "resolved",
        result: { platform: "telegram", messageId: "11", text: "lilac continue" },
      });
    } finally {
      await stopSurfaceAdapterIngress({ registry, handles: ingress, runCleanup, graceful: false });
      await stopSurfaceOutputs({ registry, requestIngress, relays, runCleanup });
      await waitResolver.stop();
      await actions?.stop();
      await disconnectSurfaceAdapters({ registry, connected, runCleanup });
      await bus.close();
      store.close();
    }
    expect(fatalErrors).toEqual([]);
    expect(disconnects).toBe(1);
    expect(discordDisconnects).toBe(1);
  });
});
