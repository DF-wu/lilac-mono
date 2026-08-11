import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLilacBus, lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import { parseCoreConfigV1ToUniversal, type CoreConfig } from "@stanley2058/lilac-utils";
import { Panic, Result, type Result as ResultType } from "better-result";
import SuperJSON from "superjson";

import {
  SurfaceInvalidInput,
  SurfaceOperationPartiallyCompleted,
  SurfacePlatformMismatch,
  SurfaceSessionMismatch,
  type SurfaceAdapter,
  type SurfaceAdapterEventSource,
  type SurfaceOperationError,
  type SurfaceOutputStream,
} from "../../src/surface/adapter";
import type {
  AgentRunnerQueueAttempt,
  AgentRunnerRecoveryEntry,
} from "../../src/surface/bridge/bus-agent-runner";
import {
  bridgeBusToAdapter,
  type BusToAdapterRelaySnapshot,
} from "../../src/surface/bridge/subscribe-from-bus";
import { DiscordAdapter } from "../../src/surface/discord/discord-adapter";
import {
  createDiscordRelayPolicy,
  createDiscordSurfaceRuntimeDescriptor,
} from "../../src/surface/discord/discord-runtime-descriptor";
import { GithubApiError } from "../../src/github/github-api";
import { GithubAdapter, type GithubAdapterApi } from "../../src/surface/github/github-adapter";
import {
  createGithubRelayPolicy,
  createGithubSurfaceRuntimeDescriptor,
} from "../../src/surface/github/github-runtime-descriptor";
import {
  createDescriptorBoundSurfaceEventSource,
  createDescriptorBoundWorkflowProgressPort,
} from "../../src/surface/produced-ref-guard";
import {
  SurfaceRelayRestoreApplyFailed,
  SurfaceRuntimeRegistry,
  workflowProgressOperationFailure,
  type RegisteredSurfacePlatform,
  type RegisteredSurfaceRuntimeDescriptor,
  type SurfaceRelayHandle,
  type SurfaceWorkflowProgressPort,
} from "../../src/surface/runtime-descriptor";
import type { AdapterEvent } from "../../src/surface/events";
import type { MsgRef, SessionRef } from "../../src/surface/types";
import { DiscordOutputStream } from "../../src/surface/discord/output/discord-output-stream";
import { GithubOutputStream } from "../../src/surface/github/output/github-output-stream";
import { clearGithubAck, getGithubAck, setGithubAck } from "../../src/github/github-state";
import {
  activateSurfaceRecovery,
  applySurfaceRecovery,
  connectAndValidateSurfaceAdapters,
  createPausedSurfaceRecoveryOwnership,
  disconnectSurfaceAdapters,
  prepareSurfaceRecovery,
  startSurfaceAdapterIngress,
  startSurfaceOutputs,
  stopIngressAndDrainSurfaceRecovery,
  stopSurfaceAdapterIngress,
  stopSurfaceOutputs,
  stopSurfaceRequestIngress,
  type ConnectedSurfaceAdapters,
  type SurfaceAdapterIngressHandles,
  type SurfaceRelayHandles,
  type SurfaceRequestIngressHandles,
} from "../../src/runtime/surface-runtime-lifecycle";
import {
  decodeGracefulRestartSnapshot,
  GRACEFUL_RESTART_SNAPSHOT_VERSION,
  SqliteGracefulRestartStore,
  type GracefulRestartSnapshotInput,
} from "../../src/runtime/graceful-restart-store";
import { createInMemoryDeliveryBus } from "../helpers/in-memory-delivery-bus";

type ProtocolLog = {
  readonly creates: string[];
  readonly edits: string[];
  readonly deletes: string[];
};

type ReferenceContract = {
  readonly platform: RegisteredSurfacePlatform;
  readonly sessionId: string;
  readonly requestId: string;
  readonly messageId: string;
  readonly missingMessageId: string;
  readonly expectedListSessionsError: SurfaceOperationError["_tag"];
  readonly expectedProviderOperation: "push-output" | "send-message";
  createAdapter(log?: ProtocolLog): SurfaceAdapter;
  createProviderFailureAdapter(): SurfaceAdapter;
  assertActionRendered(log: ProtocolLog): void;
};

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function discordConfig(): CoreConfig {
  const parsed = parseCoreConfigV1ToUniversal({
    surface: {
      discord: {
        botName: "lilac-test",
        allowedChannelIds: ["channel-1"],
      },
    },
  });
  return { ...parsed, agent: { ...parsed.agent, systemPrompt: "test" } };
}

function createProtocolLog(): ProtocolLog {
  return { creates: [], edits: [], deletes: [] };
}

function createGithubApi(
  log: ProtocolLog,
  input: { readonly createFailure?: GithubApiError } = {},
): GithubAdapterApi {
  let nextId = 100;
  return {
    getIssue: async () => ({ title: "Issue", body: "Body" }),
    listIssueComments: async () => [],
    createIssueComment: async ({ body }) => {
      if (input.createFailure) throw input.createFailure;
      log.creates.push(body);
      return { id: nextId++ };
    },
    getIssueComment: async ({ commentId }) => {
      if (commentId === 404) throw new GithubApiError(404, "/comments/404", "missing");
      return { id: commentId, body: "Comment" };
    },
    editIssueComment: async ({ body }) => {
      log.edits.push(body);
    },
    deleteIssueComment: async ({ commentId }) => {
      log.deletes.push(String(commentId));
    },
    createIssueReaction: async () => ({ id: 1 }),
    createIssueCommentReaction: async () => ({ id: 1 }),
    listIssueReactions: async () => [],
    listIssueCommentReactions: async () => [],
    deleteIssueReactionById: async () => undefined,
    deleteIssueCommentReactionById: async () => undefined,
    getGithubAppSlugOrNull: async () => "lilac-test",
  };
}

function reflectedString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
}

function reflectedArray(value: unknown, key: string): readonly unknown[] {
  if (typeof value !== "object" || value === null) return [];
  const field = Reflect.get(value, key);
  return Array.isArray(field) ? field : [];
}

function createDiscordClient(
  log: ProtocolLog,
  input: { readonly channelFetchFailure?: object } = {},
) {
  let nextId = 100;
  const messages = new Map<string, object>();

  const createMessage = (options: unknown, forcedId?: string) => {
    const id = forcedId ?? String(nextId++);
    const message = {
      id,
      channelId: "channel-1",
      author: { id: "discord-bot" },
      content: reflectedString(options, "content") ?? "",
      embeds: reflectedArray(options, "embeds"),
      attachments: new Map<string, unknown>(),
      edit: async (next: unknown) => {
        log.edits.push(JSON.stringify(next));
        message.content = reflectedString(next, "content") ?? message.content;
        const embeds = reflectedArray(next, "embeds");
        if (embeds.length > 0) message.embeds = embeds;
        return message;
      },
      reply: async (next: unknown) => {
        log.creates.push(JSON.stringify(next));
        return createMessage(next);
      },
      delete: async () => {
        log.deletes.push(id);
      },
    };
    messages.set(id, message);
    return message;
  };

  const channel = {
    send: async (options: unknown) => {
      log.creates.push(JSON.stringify(options));
      return createMessage(options);
    },
    messages: {
      fetch: async (input: unknown) => {
        const messageId =
          typeof input === "string" ? input : (reflectedString(input, "message") ?? "missing");
        if (messageId === "missing") throw { code: 10_008 };
        return messages.get(messageId) ?? createMessage({}, messageId);
      },
    },
  };

  return {
    user: { id: "discord-bot" },
    channels: {
      fetch: async () => {
        if (input.channelFetchFailure) throw input.channelFetchFailure;
        return channel;
      },
    },
    destroy: async () => undefined,
  };
}

function createDiscordAdapter(
  log = createProtocolLog(),
  input: { readonly channelFetchFailure?: object } = {},
): DiscordAdapter {
  const adapter = new DiscordAdapter({
    config: discordConfig(),
    reportFatalPanic: () => undefined,
  });
  Reflect.set(adapter, "client", createDiscordClient(log, input));
  Reflect.set(adapter, "cfg", discordConfig());
  return adapter;
}

const DISCORD_REFERENCE: ReferenceContract = {
  platform: "discord",
  sessionId: "channel-1",
  requestId: "discord:channel-1:origin",
  messageId: "origin",
  missingMessageId: "missing",
  expectedListSessionsError: "SurfaceUnavailable",
  expectedProviderOperation: "push-output",
  createAdapter: (log = createProtocolLog()) => createDiscordAdapter(log),
  createProviderFailureAdapter: () =>
    createDiscordAdapter(createProtocolLog(), { channelFetchFailure: { status: 503 } }),
  assertActionRendered: (log) => {
    expect(log.creates.some((entry) => entry.includes("Cancel"))).toBe(true);
  },
};

const GITHUB_REFERENCE: ReferenceContract = {
  platform: "github",
  sessionId: "octo/repo#1",
  requestId: "github:octo/repo#1:origin",
  messageId: "origin",
  missingMessageId: "404",
  expectedListSessionsError: "SurfaceOperationUnsupported",
  expectedProviderOperation: "send-message",
  createAdapter: (log = createProtocolLog()) => new GithubAdapter({ api: createGithubApi(log) }),
  createProviderFailureAdapter: () =>
    new GithubAdapter({
      api: createGithubApi(createProtocolLog(), {
        createFailure: new GithubApiError(503, "/repos/octo/repo/issues/1/comments", "unavailable"),
      }),
    }),
  assertActionRendered: (log) => {
    expect(log.edits.some((entry) => entry.includes("Cancel"))).toBe(true);
  },
};

const REFERENCE_CASES = [
  ["Discord", DISCORD_REFERENCE],
  ["GitHub", GITHUB_REFERENCE],
] as const;

function sessionRef(reference: ReferenceContract): SessionRef {
  return reference.platform === "discord"
    ? { platform: "discord", channelId: reference.sessionId }
    : { platform: "github", channelId: reference.sessionId };
}

function msgRef(reference: ReferenceContract, messageId = reference.messageId): MsgRef {
  return reference.platform === "discord"
    ? { platform: "discord", channelId: reference.sessionId, messageId }
    : { platform: "github", channelId: reference.sessionId, messageId };
}

function oppositeSessionRef(reference: ReferenceContract): SessionRef {
  return reference.platform === "discord"
    ? { platform: "github", channelId: reference.sessionId }
    : { platform: "discord", channelId: reference.sessionId };
}

function oppositeMsgRef(reference: ReferenceContract): MsgRef {
  return reference.platform === "discord"
    ? { platform: "github", channelId: reference.sessionId, messageId: "wrong" }
    : { platform: "discord", channelId: reference.sessionId, messageId: "wrong" };
}

function relaySnapshot(reference: ReferenceContract): BusToAdapterRelaySnapshot {
  return {
    requestId: reference.requestId,
    sessionId: reference.sessionId,
    requestClient: reference.platform,
    platform: reference.platform,
    replyTo: msgRef(reference),
    createdOutputRefs: [msgRef(reference, "output-1")],
    activeOutputRefs: [msgRef(reference, "output-1")],
    visibleText: "partial output",
    toolStatus: [],
  };
}

type LifecycleState = {
  readonly calls: string[];
  readonly relay: SurfaceRelayHandle<"discord"> | SurfaceRelayHandle<"github">;
  readonly descriptor: RegisteredSurfaceRuntimeDescriptor;
};

function createReferenceDescriptor(
  reference: ReferenceContract,
  adapter: SurfaceAdapter,
  input: {
    readonly calls?: string[];
    readonly relayStartFailure?: Error;
  } = {},
): LifecycleState {
  const calls = input.calls ?? [];
  if (reference.platform === "discord") {
    const relay: SurfaceRelayHandle<"discord"> = {
      platform: "discord",
      beginDrain: async ({ deadlineMs }) => {
        calls.push(`drain:${deadlineMs}`);
      },
      snapshotRelays: () => [
        {
          ...relaySnapshot(reference),
          platform: "discord",
          requestClient: "discord",
          replyTo: { platform: "discord", channelId: reference.sessionId, messageId: "origin" },
          createdOutputRefs: [
            { platform: "discord", channelId: reference.sessionId, messageId: "output-1" },
          ],
          activeOutputRefs: [
            { platform: "discord", channelId: reference.sessionId, messageId: "output-1" },
          ],
        },
      ],
      prepareRestoreRelays: () =>
        Result.ok({
          platform: "discord",
          apply: async () => Result.ok(undefined),
          rollback: async () => Result.ok(undefined),
          activate: () => undefined,
        }),
      restoreRelays: async () => undefined,
      stop: async () => {
        calls.push("relay:stop");
      },
    };
    const descriptor = createDiscordSurfaceRuntimeDescriptor({
      adapter,
      adapterIngress: {
        start: async () => {
          calls.push("adapter-ingress:start");
          return {
            platform: "discord",
            stop: async () => {
              calls.push("adapter-ingress:stop");
            },
          };
        },
      },
      relay: {
        ...createDiscordRelayPolicy(adapter),
        lifecycle: {
          platform: "discord",
          start: async () => {
            calls.push("relay:start");
            if (input.relayStartFailure) throw input.relayStartFailure;
            return relay;
          },
        },
      },
    });
    return { calls, relay, descriptor };
  }

  const relay: SurfaceRelayHandle<"github"> = {
    platform: "github",
    beginDrain: async ({ deadlineMs }) => {
      calls.push(`drain:${deadlineMs}`);
    },
    snapshotRelays: () => [
      {
        ...relaySnapshot(reference),
        platform: "github",
        requestClient: "github",
        replyTo: { platform: "github", channelId: reference.sessionId, messageId: "origin" },
        createdOutputRefs: [
          { platform: "github", channelId: reference.sessionId, messageId: "output-1" },
        ],
        activeOutputRefs: [
          { platform: "github", channelId: reference.sessionId, messageId: "output-1" },
        ],
      },
    ],
    prepareRestoreRelays: () =>
      Result.ok({
        platform: "github",
        apply: async () => Result.ok(undefined),
        rollback: async () => Result.ok(undefined),
        activate: () => undefined,
      }),
    restoreRelays: async () => undefined,
    stop: async () => {
      calls.push("relay:stop");
    },
  };
  const descriptor = createGithubSurfaceRuntimeDescriptor({
    adapter,
    requestIngress: {
      start: async () => {
        calls.push("request-ingress:start");
        return {
          stop: async () => {
            calls.push("request-ingress:stop");
          },
        };
      },
    },
    relay: {
      ...createGithubRelayPolicy(),
      lifecycle: {
        platform: "github",
        start: async () => {
          calls.push("relay:start");
          if (input.relayStartFailure) throw input.relayStartFailure;
          return relay;
        },
      },
    },
  });
  return { calls, relay, descriptor };
}

function registryFor(descriptors: readonly RegisteredSurfaceRuntimeDescriptor[]) {
  const created = SurfaceRuntimeRegistry.create(descriptors);
  if (created.status === "error") throw created.error;
  return created.value;
}

function registryGuardedAdapter(
  reference: ReferenceContract,
  adapter: SurfaceAdapter,
): SurfaceAdapter {
  const resolved = registryFor([{ platform: reference.platform, adapter }])
    .adapterResolver()
    .resolve(reference.platform);
  if (!resolved) throw new Error(`Missing ${reference.platform} registry adapter`);
  return resolved.adapter;
}

async function createProductionBridge(
  reference: ReferenceContract,
  adapter: SurfaceAdapter,
  bus: LilacBus,
) {
  if (reference.platform === "discord") {
    return await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "discord",
      policy: createDiscordRelayPolicy(adapter),
      subscriptionId: `reference-discord-${crypto.randomUUID()}`,
      idleTimeoutMs: 10_000,
    });
  }
  return await bridgeBusToAdapter({
    adapter,
    bus,
    platform: "github",
    policy: createGithubRelayPolicy(),
    subscriptionId: `reference-github-${crypto.randomUUID()}`,
    idleTimeoutMs: 10_000,
  });
}

function observeOutputAborts(
  reference: ReferenceContract,
  abortReasons: Array<string | undefined>,
): () => void {
  if (reference.platform === "discord") {
    const abort = DiscordOutputStream.prototype.abort;
    const observed = spyOn(DiscordOutputStream.prototype, "abort").mockImplementation(
      function (this: DiscordOutputStream, reason) {
        abortReasons.push(reason);
        return abort.call(this, reason);
      },
    );
    return () => observed.mockRestore();
  }
  const abort = GithubOutputStream.prototype.abort;
  const observed = spyOn(GithubOutputStream.prototype, "abort").mockImplementation(
    function (this: GithubOutputStream, reason) {
      abortReasons.push(reason);
      return abort.call(this, reason);
    },
  );
  return () => observed.mockRestore();
}

function lifecycleMaps() {
  return {
    connected: new Map() as ConnectedSurfaceAdapters,
    adapterIngress: new Map() as SurfaceAdapterIngressHandles,
    requestIngress: new Map() as SurfaceRequestIngressHandles,
    relays: new Map() as SurfaceRelayHandles,
  };
}

async function runCleanup(_label: string, cleanup: (() => Promise<void>) | undefined) {
  await cleanup?.();
}

async function expectPanic(effect: () => Promise<unknown>): Promise<void> {
  const [settled] = await Promise.allSettled([effect()]);
  expect(settled?.status).toBe("rejected");
  if (settled?.status === "rejected") expect(Panic.is(settled.reason)).toBe(true);
}

function operationError<T>(result: ResultType<T, SurfaceOperationError>): SurfaceOperationError {
  expect(result.status).toBe("error");
  if (result.status === "ok") throw new Error("Expected a surface operation error");
  return result.error;
}

function outputStreamWith(result: { readonly created: MsgRef[]; readonly last: MsgRef }) {
  return {
    push: async () => Result.ok("visible" as const),
    finish: async () => Result.ok(result),
    abort: async () => Result.ok(undefined),
  } satisfies SurfaceOutputStream;
}

async function assertProducedRefGuards(reference: ReferenceContract): Promise<void> {
  const wrongRef = oppositeMsgRef(reference);
  const wrongSession = oppositeSessionRef(reference);

  const sessionsAdapter = reference.createAdapter();
  sessionsAdapter.listSessions = async () =>
    Result.ok([{ ref: wrongSession, kind: "thread" as const }]);
  await expectPanic(() => registryGuardedAdapter(reference, sessionsAdapter).listSessions());

  const messagesAdapter = reference.createAdapter();
  messagesAdapter.listMsg = async () =>
    Result.ok([
      {
        ref: wrongRef,
        session: sessionRef(reference),
        userId: "user",
        text: "wrong",
        ts: 1,
      },
    ]);
  await expectPanic(() =>
    registryGuardedAdapter(reference, messagesAdapter).listMsg(sessionRef(reference)),
  );

  const callbackAdapter = reference.createAdapter();
  callbackAdapter.startOutput = async (_session, options) => {
    options?.onMessageCreated?.(wrongRef);
    return Result.ok(outputStreamWith({ created: [msgRef(reference)], last: msgRef(reference) }));
  };
  await expectPanic(() =>
    registryGuardedAdapter(reference, callbackAdapter).startOutput(sessionRef(reference), {
      onMessageCreated: () => undefined,
    }),
  );

  const outputAdapter = reference.createAdapter();
  outputAdapter.startOutput = async () =>
    Result.ok(outputStreamWith({ created: [wrongRef], last: wrongRef }));
  const started = await registryGuardedAdapter(reference, outputAdapter).startOutput(
    sessionRef(reference),
  );
  if (started.status === "error") throw started.error;
  await expectPanic(() => started.value.finish());

  const partialAdapter = reference.createAdapter();
  partialAdapter.sendMsg = async () =>
    Result.err(
      new SurfaceOperationPartiallyCompleted({
        platform: reference.platform,
        operation: "send-message",
        created: wrongRef,
        message: "created before failure",
      }),
    );
  await expectPanic(() =>
    registryGuardedAdapter(reference, partialAdapter).sendMsg(sessionRef(reference), {
      text: "send",
    }),
  );

  const event: AdapterEvent = {
    type: "adapter.message.created",
    platform: reference.platform,
    message: {
      ref: wrongRef,
      session: sessionRef(reference),
      userId: "user",
      text: "wrong",
      ts: 1,
    },
    ts: 1,
  };
  const eventSource: SurfaceAdapterEventSource = {
    subscribe: async (handler) => {
      await handler(event);
      return { stop: async () => undefined };
    },
  };
  await expectPanic(async () => {
    await createDescriptorBoundSurfaceEventSource(reference.platform, eventSource).subscribe(
      () => undefined,
    );
  });

  const workflowPlatform: RegisteredSurfacePlatform = reference.platform;
  const workflow: SurfaceWorkflowProgressPort<RegisteredSurfacePlatform> = {
    configurationRevision: "test",
    checkMessage: async () => Result.ok("found"),
    send: async () => Result.ok(wrongRef),
    edit: async () => Result.ok(undefined),
  };
  await expectPanic(() =>
    createDescriptorBoundWorkflowProgressPort(workflowPlatform, workflow).send({
      channelId: reference.sessionId,
      content: { text: "send" },
    }),
  );
}

function recoveryIdentity(reference: ReferenceContract, requestId: string, messageId: string) {
  return {
    state: "durable" as const,
    projection: {
      requestId,
      requestClient: reference.platform,
      sessionId: reference.sessionId,
      source: "external" as const,
      platform: reference.platform,
      sessionRef: sessionRef(reference),
      messageRef: msgRef(reference, messageId),
      authenticationMetadataKind: "absent" as const,
      verifiedIngress: false,
    },
    assertedSafetyMode: "restricted" as const,
    parkedEventIds: [] as string[],
  };
}

function recoveryRequestId(reference: ReferenceContract, suffix: string): string {
  return reference.platform === "discord"
    ? `discord:${reference.sessionId}:${suffix}`
    : `github:${reference.sessionId}:${suffix}`;
}

function recoverySnapshot(reference: ReferenceContract): GracefulRestartSnapshotInput {
  const activeRequestId = recoveryRequestId(reference, "active");
  const queuedRequestId = recoveryRequestId(reference, "queued");
  const controlRequestId = recoveryRequestId(reference, "control");
  const eventId = `${reference.platform}-pel-1`;
  const activeIdentity = recoveryIdentity(reference, activeRequestId, "active");
  const queuedIdentity = recoveryIdentity(reference, queuedRequestId, "queued");
  const controlIdentity = {
    ...recoveryIdentity(reference, controlRequestId, "control"),
    parkedEventIds: [eventId],
  };
  const agent: AgentRunnerRecoveryEntry[] = [
    {
      queueEntryId: `${reference.platform}-active-entry`,
      kind: "active",
      requestId: activeRequestId,
      sessionId: reference.sessionId,
      requestClient: reference.platform,
      queue: "prompt",
      messages: [],
      identity: activeIdentity,
    },
    {
      queueEntryId: `${reference.platform}-queued-entry`,
      kind: "queued",
      requestId: queuedRequestId,
      sessionId: reference.sessionId,
      requestClient: reference.platform,
      queue: "prompt",
      messages: [],
      identity: queuedIdentity,
    },
  ];
  const queueAttempts: AgentRunnerQueueAttempt[] = [
    {
      eventId,
      controlRequestId,
      controlRequestClient: reference.platform,
      sessionId: reference.sessionId,
      kind: "queued-cancellation",
      detail: "cancelled during replacement",
      controlApplied: true,
      controlIdentity,
      pendingGroups: [
        {
          publicationIndex: 0,
          requestId: queuedRequestId,
          requestClient: reference.platform,
          targetQueueEntryIds: [`${reference.platform}-queued-entry`],
        },
      ],
    },
  ];
  return {
    version: GRACEFUL_RESTART_SNAPSHOT_VERSION,
    createdAt: Date.now(),
    deadlineMs: 3_000,
    queueAttemptProof: "complete",
    agent,
    queueAttempts,
    relays: [relaySnapshot(reference)],
  };
}

function decodeSnapshot(value: unknown) {
  return decodeGracefulRestartSnapshot({
    status: "completed",
    payload_json: SuperJSON.stringify(value),
  });
}

function requireDecodedCurrentSnapshot(reference: ReferenceContract) {
  const decoded = decodeSnapshot(recoverySnapshot(reference));
  if (decoded.status === "error") throw decoded.error;
  if (!decoded.value.value) throw new Error(`Expected populated ${reference.platform} v3 snapshot`);
  if (decoded.value.provenance !== "current") {
    throw new Error(`Expected current ${reference.platform} v3 snapshot provenance`);
  }
  return decoded.value.value;
}

describe("shared Discord/GitHub adapter and descriptor contract", () => {
  it.each(REFERENCE_CASES)(
    "%s satisfies adapter, ingress, and output lifecycle ownership",
    async (_name, reference) => {
      const state = createReferenceDescriptor(reference, reference.createAdapter());
      const registry = registryFor([state.descriptor]);
      const handles = lifecycleMaps();

      await startSurfaceAdapterIngress({ registry, handles: handles.adapterIngress });
      await connectAndValidateSurfaceAdapters({ registry, connected: handles.connected });
      await startSurfaceOutputs({
        registry,
        requestIngress: handles.requestIngress,
        relays: handles.relays,
      });
      expect(state.calls).toContain("relay:start");
      await stopSurfaceAdapterIngress({
        registry,
        handles: handles.adapterIngress,
        runCleanup,
        graceful: false,
      });
      await stopSurfaceRequestIngress({
        registry,
        handles: handles.requestIngress,
        runCleanup,
        graceful: false,
      });
      await stopSurfaceOutputs({
        registry,
        requestIngress: handles.requestIngress,
        relays: handles.relays,
        runCleanup,
      });
      await disconnectSurfaceAdapters({ registry, connected: handles.connected, runCleanup });
      expect(handles.adapterIngress.size).toBe(0);
      expect(handles.requestIngress.size).toBe(0);
      expect(handles.relays.size).toBe(0);
      expect(handles.connected.size).toBe(0);
    },
  );

  it("rolls back every acquired surface resource when output startup fails", async () => {
    const calls: string[] = [];
    const discordAdapter = DISCORD_REFERENCE.createAdapter();
    const githubAdapter = GITHUB_REFERENCE.createAdapter();
    const discordDisconnect = discordAdapter.disconnect.bind(discordAdapter);
    discordAdapter.disconnect = async () => {
      calls.push("discord:disconnect");
      await discordDisconnect();
    };
    const githubDisconnect = githubAdapter.disconnect.bind(githubAdapter);
    githubAdapter.disconnect = async () => {
      calls.push("github:disconnect");
      await githubDisconnect();
    };
    const discord = createReferenceDescriptor(DISCORD_REFERENCE, discordAdapter, { calls });
    const startupFailure = new Error("GitHub relay startup failed");
    const github = createReferenceDescriptor(GITHUB_REFERENCE, githubAdapter, {
      calls,
      relayStartFailure: startupFailure,
    });
    const registry = registryFor([discord.descriptor, github.descriptor]);
    const handles = lifecycleMaps();

    await startSurfaceAdapterIngress({ registry, handles: handles.adapterIngress });
    await connectAndValidateSurfaceAdapters({ registry, connected: handles.connected });
    await expect(
      startSurfaceOutputs({
        registry,
        requestIngress: handles.requestIngress,
        relays: handles.relays,
      }),
    ).rejects.toBe(startupFailure);
    await stopSurfaceOutputs({
      registry,
      requestIngress: handles.requestIngress,
      relays: handles.relays,
      runCleanup,
    });
    await disconnectSurfaceAdapters({ registry, connected: handles.connected, runCleanup });
    await stopSurfaceAdapterIngress({
      registry,
      handles: handles.adapterIngress,
      runCleanup,
      graceful: false,
    });

    expect(calls).toContain("adapter-ingress:start");
    expect(calls).toContain("adapter-ingress:stop");
    expect(calls).toContain("request-ingress:start");
    expect(calls).toContain("request-ingress:stop");
    expect(calls).toContain("relay:stop");
    expect(calls).toContain("discord:disconnect");
    expect(calls).toContain("github:disconnect");
    expect(handles.adapterIngress.size).toBe(0);
    expect(handles.requestIngress.size).toBe(0);
    expect(handles.relays.size).toBe(0);
    expect(handles.connected.size).toBe(0);
  });

  it("disconnects both established adapters when post-connect platform validation fails", async () => {
    const disconnected: string[] = [];
    const discordAdapter = DISCORD_REFERENCE.createAdapter();
    const githubAdapter = GITHUB_REFERENCE.createAdapter();
    const discordDisconnect = discordAdapter.disconnect.bind(discordAdapter);
    discordAdapter.disconnect = async () => {
      disconnected.push("discord");
      await discordDisconnect();
    };
    const githubDisconnect = githubAdapter.disconnect.bind(githubAdapter);
    githubAdapter.disconnect = async () => {
      disconnected.push("github");
      await githubDisconnect();
    };
    const establishedFailure = new Error("established GitHub identity unavailable");
    githubAdapter.getSelf = async () => {
      throw establishedFailure;
    };
    const registry = registryFor([
      createReferenceDescriptor(DISCORD_REFERENCE, discordAdapter).descriptor,
      createReferenceDescriptor(GITHUB_REFERENCE, githubAdapter).descriptor,
    ]);
    const connected = new Map() as ConnectedSurfaceAdapters;

    await expect(connectAndValidateSurfaceAdapters({ registry, connected })).rejects.toBe(
      establishedFailure,
    );
    expect([...connected.keys()]).toEqual(["discord", "github"]);
    await disconnectSurfaceAdapters({ registry, connected, runCleanup });
    expect(disconnected).toEqual(["github", "discord"]);
    expect(connected.size).toBe(0);
  });

  it.each(REFERENCE_CASES)(
    "%s resolves exactly through the guarded registry and selects only its request client",
    async (_name, reference) => {
      const adapter = reference.createAdapter();
      const descriptor = createReferenceDescriptor(reference, adapter).descriptor;
      const registry = registryFor([descriptor]);
      const resolver = registry.adapterResolver();

      expect(resolver.registeredPlatforms()).toEqual([reference.platform]);
      const resolved = resolver.resolve(reference.platform);
      expect(resolved?.platform).toBe(reference.platform);
      expect((await resolved?.adapter.getSelf())?.platform).toBe(reference.platform);
      expect(resolver.resolve(reference.platform === "discord" ? "github" : "discord")).toBeNull();
      expect(resolver.resolve("slack")).toBeNull();
      expect(resolver.resolve("unknown")).toBeNull();

      const other =
        reference.platform === "discord"
          ? createReferenceDescriptor(GITHUB_REFERENCE, GITHUB_REFERENCE.createAdapter()).descriptor
          : createReferenceDescriptor(DISCORD_REFERENCE, DISCORD_REFERENCE.createAdapter())
              .descriptor;
      const completeRegistry = registryFor(
        reference.platform === "discord" ? [descriptor, other] : [other, descriptor],
      );
      expect(
        completeRegistry.entries().filter((entry) => entry.platform === reference.platform),
      ).toHaveLength(1);
    },
  );

  it("selects exactly one real relay from request_client with both descriptors active", async () => {
    const bus = createLilacBus(createInMemoryDeliveryBus());
    const discord = createReferenceDescriptor(
      DISCORD_REFERENCE,
      DISCORD_REFERENCE.createAdapter(),
    ).descriptor;
    const github = createReferenceDescriptor(
      GITHUB_REFERENCE,
      GITHUB_REFERENCE.createAdapter(),
    ).descriptor;
    const discordBridge = await createProductionBridge(DISCORD_REFERENCE, discord.adapter, bus);
    const githubBridge = await createProductionBridge(GITHUB_REFERENCE, github.adapter, bus);
    try {
      await bus.publish(
        lilacEventTypes.EvtRequestReply,
        {},
        {
          headers: {
            request_id: GITHUB_REFERENCE.requestId,
            session_id: GITHUB_REFERENCE.sessionId,
            request_client: "github",
          },
        },
      );
      await bus.publish(
        lilacEventTypes.EvtAgentOutputDeltaText,
        { delta: "github output" },
        { headers: { request_id: GITHUB_REFERENCE.requestId } },
      );
      expect(discordBridge.snapshotRelays()).toEqual([]);
      expect(githubBridge.snapshotRelays()).toMatchObject([
        {
          requestId: GITHUB_REFERENCE.requestId,
          requestClient: "github",
          platform: "github",
          visibleText: "github output",
        },
      ]);

      await bus.publish(
        lilacEventTypes.EvtRequestReply,
        {},
        {
          headers: {
            request_id: DISCORD_REFERENCE.requestId,
            session_id: DISCORD_REFERENCE.sessionId,
            request_client: "discord",
          },
        },
      );
      await bus.publish(
        lilacEventTypes.EvtAgentOutputDeltaText,
        { delta: "discord output" },
        { headers: { request_id: DISCORD_REFERENCE.requestId } },
      );
      expect(discordBridge.snapshotRelays()).toMatchObject([
        {
          requestId: DISCORD_REFERENCE.requestId,
          requestClient: "discord",
          platform: "discord",
          visibleText: "discord output",
        },
      ]);
      expect(githubBridge.snapshotRelays()).toHaveLength(1);
    } finally {
      await githubBridge.stop();
      await discordBridge.stop();
      await bus.close();
    }
  });

  it.each(REFERENCE_CASES)(
    "%s reanchors, cancels, and drains through shared relay bus handlers",
    async (_name, reference) => {
      const abortReasons: Array<string | undefined> = [];
      const restoreAbortObserver = observeOutputAborts(reference, abortReasons);
      const bus = createLilacBus(createInMemoryDeliveryBus());
      const descriptor = createReferenceDescriptor(reference, reference.createAdapter()).descriptor;
      const bridge = await createProductionBridge(reference, descriptor.adapter, bus);
      const registry = registryFor([descriptor]);
      try {
        await bus.publish(
          lilacEventTypes.EvtRequestReply,
          {},
          {
            headers: {
              request_id: reference.requestId,
              session_id: reference.sessionId,
              request_client: reference.platform,
            },
          },
        );
        await bus.publish(
          lilacEventTypes.EvtAgentOutputDeltaText,
          { delta: "before" },
          { headers: { request_id: reference.requestId } },
        );
        expect(bridge.snapshotRelays()).toMatchObject([
          { requestId: reference.requestId, visibleText: "before", streamTextPrefixChars: 0 },
        ]);

        await bus.publish(
          lilacEventTypes.CmdSurfaceOutputReanchor,
          { inheritReplyTo: true },
          {
            headers: {
              request_id: reference.requestId,
              session_id: reference.sessionId,
              request_client: reference.platform,
            },
          },
        );
        expect(abortReasons).toContain("reanchor");
        expect(bridge.snapshotRelays()).toMatchObject([
          { requestId: reference.requestId, streamTextPrefixChars: 6, activeOutputRefs: [] },
        ]);

        await bus.publish(
          lilacEventTypes.EvtAgentOutputDeltaText,
          { delta: " after" },
          { headers: { request_id: reference.requestId } },
        );
        expect(bridge.snapshotRelays()).toMatchObject([
          { visibleText: " after", streamTextPrefixChars: 6 },
        ]);
        await bus.publish(
          lilacEventTypes.CmdRequestMessage,
          {
            queue: "interrupt",
            messages: [],
            raw: { cancel: true, requiresActive: true },
          },
          {
            headers: {
              request_id: reference.requestId,
              session_id: reference.sessionId,
              request_client: reference.platform,
            },
          },
        );
        expect(abortReasons).toContain("cancel");
        expect(bridge.snapshotRelays()).toEqual([]);

        const drained = await stopIngressAndDrainSurfaceRecovery({
          stopAdapterIngress: async () => undefined,
          stopRouterIngress: async () => undefined,
          stopWorkflowRequestProducers: async () => undefined,
          stopRequestIngress: async () => undefined,
          stopRemainingRequestProducers: async () => undefined,
          registry,
          deadlineMs: 500,
          runCleanup,
          agentRunner: {
            beginDrain: async () => undefined,
            snapshotRecoverables: () => [],
            snapshotQueueAttempts: () => [],
            restoreRecoverables: () => undefined,
            prepareRecovery: () =>
              Result.ok({
                apply: () => Result.ok(undefined),
                rollback: () => undefined,
                activate: () => undefined,
              }),
          },
          relays: new Map([[reference.platform, bridge]]),
        });
        expect(drained).toEqual({ agent: [], queueAttempts: [], relays: [] });
      } finally {
        restoreAbortObserver();
        await bridge.stop();
        await bus.close();
      }
    },
  );

  it.each(REFERENCE_CASES)(
    "%s returns the closed operation algebra, validates nested refs, and declares optional behavior",
    async (_name, reference) => {
      const adapter = reference.createAdapter();
      const primary = operationError(await adapter.startOutput(oppositeSessionRef(reference)));
      expect(primary).toBeInstanceOf(SurfacePlatformMismatch);

      const nestedPlatform = operationError(
        await adapter.startOutput(sessionRef(reference), { replyTo: oppositeMsgRef(reference) }),
      );
      expect(nestedPlatform).toBeInstanceOf(SurfacePlatformMismatch);

      const nestedSession = operationError(
        await adapter.markRead(sessionRef(reference), {
          ...msgRef(reference),
          channelId: `${reference.sessionId}-other`,
        }),
      );
      expect(nestedSession).toBeInstanceOf(SurfaceSessionMismatch);

      const invalid = operationError(await adapter.sendMsg(sessionRef(reference), { text: "   " }));
      expect(invalid).toBeInstanceOf(SurfaceInvalidInput);

      const declared = operationError(await adapter.listSessions());
      expect(declared._tag).toBe(reference.expectedListSessionsError);

      const provider = await reference
        .createProviderFailureAdapter()
        .sendMsg(sessionRef(reference), { text: "provider failure" });
      expect(provider.status).toBe("error");
      if (provider.status === "ok") throw new Error("Expected provider failure");
      expect(provider.error._tag).toBe("SurfaceUnavailable");
      if (provider.error._tag !== "SurfaceUnavailable") throw provider.error;
      expect(provider.error.platform).toBe(reference.platform);
      expect(provider.error.operation).toBe(reference.expectedProviderOperation);
    },
  );

  it.each(REFERENCE_CASES)(
    "%s guards sessions, messages, events, callbacks, output, workflow, and partial refs",
    async (_name, reference) => {
      await assertProducedRefGuards(reference);
    },
  );

  it.each(REFERENCE_CASES)(
    "%s owns output creation, finalization, skip, and cleanup outcomes",
    async (_name, reference) => {
      const log = createProtocolLog();
      const adapter = reference.createAdapter(log);
      const descriptor = createReferenceDescriptor(reference, adapter).descriptor;
      const created: MsgRef[] = [];
      const started = await descriptor.adapter.startOutput(sessionRef(reference), {
        onMessageCreated: (ref) => created.push(ref),
      });
      if (started.status === "error") throw started.error;
      const finished = await started.value.finish();
      if (finished.status === "error") throw finished.error;
      expect(finished.value.created.length).toBeGreaterThan(0);
      expect(finished.value.created.every((ref) => ref.platform === reference.platform)).toBe(true);
      expect(finished.value.last.platform).toBe(reference.platform);
      if (reference.platform === "discord") expect(created).toEqual(finished.value.created);
      else expect(created).toEqual([]);

      const relay = descriptor.relay;
      if (!relay) throw new Error("Reference relay is missing");
      const valid = relay.refs.decodeReanchorTarget({
        ref: msgRef(reference),
        expectedSessionId: reference.sessionId,
      });
      expect(valid.status).toBe("ok");
      const crossPlatform = relay.refs.decodeReanchorTarget({
        ref: oppositeMsgRef(reference),
        expectedSessionId: reference.sessionId,
      });
      expect(crossPlatform.status).toBe("error");

      const initial = relay.refs.resolveInitialReplyTarget({
        requestId: reference.requestId,
        sessionId: reference.sessionId,
      });
      expect(initial.kind).toBe("target");

      if (reference.platform === "discord") {
        const skippedCleanup = createDiscordRelayPolicy(adapter).finalization?.cleanupSkippedOutput;
        if (!skippedCleanup) throw new Error("Discord skip cleanup is missing");
        await expect(
          skippedCleanup({
            ref: { platform: "discord", channelId: reference.sessionId, messageId: "skip" },
          }),
        ).resolves.toBeUndefined();
        expect(log.deletes).toContain("skip");
      } else {
        expect(createGithubRelayPolicy().finalization?.cleanupSkippedOutput).toBeUndefined();
        const requestId = `github-ack-${crypto.randomUUID()}`;
        const deleted: number[] = [];
        setGithubAck(requestId, {
          target: { kind: "issue", issueNumber: 1 },
          reactionId: 42,
        });
        try {
          const cleanup = createGithubRelayPolicy({
            acknowledgementApi: {
              deleteIssueReactionById: async ({ reactionId }) => {
                deleted.push(reactionId);
              },
              deleteIssueCommentReactionById: async () => undefined,
            },
          }).finalization?.clearIngressAcknowledgement;
          if (!cleanup) throw new Error("GitHub acknowledgement cleanup is missing");
          expect(await cleanup({ requestId, sessionId: GITHUB_REFERENCE.sessionId })).toEqual(
            Result.ok(undefined),
          );
          expect(deleted).toEqual([42]);
          expect(getGithubAck(requestId)).toBeUndefined();
        } finally {
          clearGithubAck(requestId);
        }
      }
    },
  );

  it.each(REFERENCE_CASES)(
    "%s workflow progress checks, sends, edits, classifies policy, and preserves actions",
    async (_name, reference) => {
      const log = createProtocolLog();
      const descriptor = createReferenceDescriptor(
        reference,
        reference.createAdapter(log),
      ).descriptor;
      const port = descriptor.workflowProgress;
      if (!port) throw new Error("Reference workflow progress port is missing");

      expect(
        await port.checkMessage({
          channelId: reference.sessionId,
          messageId: reference.missingMessageId,
        }),
      ).toEqual(Result.ok("missing"));
      const sent = await port.send({
        channelId: reference.sessionId,
        replyToMessageId: reference.messageId,
        silent: true,
        content: {
          text: "Queued",
          actions: [{ actionId: "cancel", label: "Cancel", style: "danger" }],
        },
      });
      if (sent.status === "error") throw new Error(`Unexpected ${reference.platform} send failure`);
      expect(sent.value.platform).toBe(reference.platform);
      reference.assertActionRendered(log);

      const edited = await port.edit(
        { channelId: reference.sessionId, messageId: sent.value.messageId },
        { text: "Running" },
      );
      expect(edited.status).toBe("ok");

      const permanent = workflowProgressOperationFailure(
        "send",
        new SurfaceInvalidInput({
          platform: reference.platform,
          operation: "send-message",
          field: "content",
          message: "invalid",
        }),
      );
      const providerFailure = await reference
        .createProviderFailureAdapter()
        .sendMsg(sessionRef(reference), { text: "provider failure" });
      if (providerFailure.status === "ok") throw new Error("Expected workflow provider failure");
      const retryable = workflowProgressOperationFailure("send", providerFailure.error);
      expect(permanent).toMatchObject({ disposition: "permanent", reason: "invalid-input" });
      expect(retryable).toMatchObject({ disposition: "retryable", reason: "unavailable" });
    },
  );

  it.each(REFERENCE_CASES)(
    "%s restores current and v1/v2 compatibility with identity, PEL, and queue-attempt correlation",
    (_name, reference) => {
      const current = recoverySnapshot(reference);
      const decoded = decodeSnapshot(current);
      if (decoded.status === "error") throw decoded.error;
      if (!decoded.value.value)
        throw new Error(`Expected populated ${reference.platform} current snapshot`);
      expect(decoded.value.provenance).toBe("current");
      expect(decoded.value.value.version).toBe(GRACEFUL_RESTART_SNAPSHOT_VERSION);
      expect(decoded.value.value.relays[0]?.requestClient).toBe(reference.platform);
      expect(decoded.value.value.queueAttempts[0]).toMatchObject({
        eventId: `${reference.platform}-pel-1`,
        controlApplied: true,
        pendingGroups: [{ targetQueueEntryIds: [`${reference.platform}-queued-entry`] }],
      });
      expect(decoded.value.value.agent[0]?.identity).toMatchObject({
        state: "durable",
        projection: {
          requestClient: reference.platform,
          platform: reference.platform,
          sessionId: reference.sessionId,
        },
      });

      for (const version of [1, 2] as const) {
        const legacy = {
          version,
          createdAt: current.createdAt,
          deadlineMs: current.deadlineMs,
          agent: [],
          relays: current.relays.map(({ requestClient: _requestClient, ...relay }) => relay),
        };
        const migrated = decodeSnapshot(legacy);
        expect(migrated.status).toBe("ok");
        if (migrated.status === "ok") {
          expect(migrated.value.provenance).toBe("migrated");
          expect(migrated.value.value?.relays[0]?.requestClient).toBe(reference.platform);
        }
      }
    },
  );

  it.each(REFERENCE_CASES)(
    "%s preserves real guarded-stream hydration through paused recovery orchestration",
    async (_name, reference) => {
      const decoded = requireDecodedCurrentSnapshot(reference);
      const log = createProtocolLog();
      const descriptor = createReferenceDescriptor(
        reference,
        reference.createAdapter(log),
      ).descriptor;
      const registry = registryFor([descriptor]);
      const bus = createLilacBus(createInMemoryDeliveryBus());
      const bridge = await createProductionBridge(reference, descriptor.adapter, bus);
      try {
        const probed = await descriptor.adapter.startOutput(sessionRef(reference), {
          preparationMode: "paused-recovery",
          resume: { created: [msgRef(reference, "output-1")] },
        });
        if (probed.status === "error") throw probed.error;
        expect(probed.value.hydrateRecovery).toBeFunction();
        expect(
          probed.value.hydrateRecovery?.([{ type: "text.set", text: "hydration probe" }]),
        ).toBe("visible");
        expect((await probed.value.abort("restore_probe")).status).toBe("ok");

        const prepared = prepareSurfaceRecovery({
          registry,
          snapshot: decoded,
          relays: new Map([[reference.platform, bridge]]),
          agentRunner: {
            prepareRecovery: () =>
              Result.ok({
                apply: () => Result.ok(undefined),
                rollback: () => undefined,
                activate: () => undefined,
              }),
          },
        });
        if (prepared.status === "error") throw prepared.error;
        expect((await applySurfaceRecovery(prepared.value)).status).toBe("ok");
        expect(bridge.snapshotRelays()).toEqual([]);
        expect(log.creates).toEqual([]);
        const paused = createPausedSurfaceRecoveryOwnership(prepared.value);
        await paused.rollback();
        expect(bridge.snapshotRelays()).toEqual([]);
      } finally {
        await bridge.stop();
        await bus.close();
      }
    },
  );

  it.each(REFERENCE_CASES)(
    "%s preflights unavailable recovery and owns paused apply, rollback, and activation",
    async (_name, reference) => {
      const snapshot = requireDecodedCurrentSnapshot(reference);
      const state = createReferenceDescriptor(reference, reference.createAdapter());
      const registry = registryFor([state.descriptor]);
      const unavailable = prepareSurfaceRecovery({
        registry,
        snapshot,
        relays: new Map(),
        agentRunner: {
          prepareRecovery: () =>
            Result.ok({
              apply: () => Result.ok(undefined),
              rollback: () => undefined,
              activate: () => undefined,
            }),
        },
      });
      expect(unavailable.status).toBe("error");
      if (unavailable.status === "error") {
        expect(unavailable.error).toMatchObject({ reason: "relay-handle-unavailable" });
      }

      const calls: string[] = [];
      const relay: SurfaceRelayHandle<RegisteredSurfacePlatform> = {
        ...state.relay,
        prepareRestoreRelays: () =>
          Result.ok({
            platform: reference.platform,
            apply: async () => {
              calls.push("relay:apply");
              return Result.ok(undefined);
            },
            rollback: async () => {
              calls.push("relay:rollback");
              return Result.ok(undefined);
            },
            activate: () => calls.push("relay:activate"),
          }),
      };
      const agentRunner = {
        prepareRecovery: () =>
          Result.ok({
            apply: () => {
              calls.push("agent:apply");
              return Result.ok(undefined);
            },
            rollback: () => calls.push("agent:rollback"),
            activate: () => calls.push("agent:activate"),
          }),
      };
      const prepared = prepareSurfaceRecovery({
        registry,
        snapshot,
        relays: new Map([[reference.platform, relay]]),
        agentRunner,
      });
      if (prepared.status === "error") throw prepared.error;
      expect((await applySurfaceRecovery(prepared.value)).status).toBe("ok");
      const paused = createPausedSurfaceRecoveryOwnership(prepared.value);
      await paused.rollback();
      expect(calls).toEqual(["relay:apply", "agent:apply", "relay:rollback", "agent:rollback"]);

      calls.length = 0;
      const activated = prepareSurfaceRecovery({
        registry,
        snapshot,
        relays: new Map([[reference.platform, relay]]),
        agentRunner,
      });
      if (activated.status === "error") throw activated.error;
      expect((await applySurfaceRecovery(activated.value)).status).toBe("ok");
      activateSurfaceRecovery(activated.value);
      expect(calls).toEqual(["relay:apply", "agent:apply", "relay:activate", "agent:activate"]);

      calls.length = 0;
      const failedRelay: SurfaceRelayHandle<RegisteredSurfacePlatform> = {
        ...relay,
        prepareRestoreRelays: () =>
          Result.ok({
            platform: reference.platform,
            apply: async () =>
              Result.err(
                new SurfaceRelayRestoreApplyFailed({
                  platform: reference.platform,
                  requestId: reference.requestId,
                  message: "apply failed",
                }),
              ),
            rollback: async () => {
              calls.push("failed:rollback");
              return Result.ok(undefined);
            },
            activate: () => calls.push("failed:activate"),
          }),
      };
      const failed = prepareSurfaceRecovery({
        registry,
        snapshot,
        relays: new Map([[reference.platform, failedRelay]]),
        agentRunner,
      });
      if (failed.status === "error") throw failed.error;
      expect((await applySurfaceRecovery(failed.value)).status).toBe("error");
      expect(calls).toEqual(["failed:rollback", "agent:rollback"]);
    },
  );

  it.each(REFERENCE_CASES)(
    "%s keeps snapshot reads non-destructive and applies explicit row disposition",
    async (_name, reference) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), `lilac-${reference.platform}-contract-`));
      tempDirs.push(dir);
      const store = new SqliteGracefulRestartStore(path.join(dir, "graceful-restart.db"));
      try {
        const snapshot = recoverySnapshot(reference);
        expect(store.saveCompletedSnapshot(snapshot).status).toBe("ok");
        const first = store.readCompletedSnapshot(snapshot.createdAt);
        expect(first.status).toBe("ok");
        if (first.status === "error" || first.value.state !== "loaded") {
          throw new Error("Expected loaded snapshot");
        }
        const second = store.readCompletedSnapshot(snapshot.createdAt);
        expect(second.status).toBe("ok");
        if (second.status === "ok") expect(second.value.state).toBe("loaded");
        expect(store.consumeCompletedSnapshot(first.value.rowToken).status).toBe("ok");
        const absent = store.readCompletedSnapshot();
        expect(absent.status).toBe("ok");
        if (absent.status === "ok") expect(absent.value.state).toBe("absent");

        const empty = {
          ...snapshot,
          agent: [],
          queueAttempts: [],
          relays: [],
        };
        expect(store.saveCompletedSnapshot(empty).status).toBe("ok");
        const emptyRead = store.readCompletedSnapshot(empty.createdAt);
        expect(emptyRead.status).toBe("ok");
        if (emptyRead.status === "error" || emptyRead.value.state !== "empty") {
          throw new Error("Expected empty snapshot");
        }
        expect(store.consumeCompletedSnapshot(emptyRead.value.rowToken).status).toBe("ok");

        const stale = { ...snapshot, createdAt: 1, deadlineMs: 1 };
        expect(store.saveCompletedSnapshot(stale).status).toBe("ok");
        const classified = store.readCompletedSnapshot(10);
        expect(classified.status).toBe("ok");
        if (classified.status === "ok") expect(classified.value.state).toBe("stale");
      } finally {
        store.close();
      }
    },
  );
});
