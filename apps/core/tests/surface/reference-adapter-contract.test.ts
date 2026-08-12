import { describe, expect, it, spyOn } from "bun:test";
import { createLilacBus, lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import { parseCoreConfigV1ToUniversal, type CoreConfig } from "@stanley2058/lilac-utils";
import { Result, type Result as ResultType } from "better-result";

import {
  SurfaceInvalidInput,
  SurfacePlatformMismatch,
  SurfaceSessionMismatch,
  type SurfaceAdapter,
  type SurfaceOperationError,
} from "../../src/surface/adapter";
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
  SurfaceRuntimeRegistry,
  type RegisteredSurfacePlatform,
  type RegisteredSurfaceRuntimeDescriptor,
} from "../../src/surface/runtime-descriptor";
import type { MsgRef, SessionRef } from "../../src/surface/types";
import { DiscordOutputStream } from "../../src/surface/discord/output/discord-output-stream";
import { GithubOutputStream } from "../../src/surface/github/output/github-output-stream";
import { clearGithubAck, getGithubAck, setGithubAck } from "../../src/github/github-state";
import {
  applySurfaceRecovery,
  prepareSurfaceRecovery,
} from "../../src/runtime/surface-runtime-lifecycle";
import {
  GRACEFUL_RESTART_SNAPSHOT_VERSION,
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

function createReferenceDescriptor(
  reference: ReferenceContract,
  adapter: SurfaceAdapter,
): RegisteredSurfaceRuntimeDescriptor {
  if (reference.platform === "discord") {
    return createDiscordSurfaceRuntimeDescriptor({
      adapter,
      adapterIngress: {
        start: async () => {
          throw new Error("Reference descriptor lifecycle is unused");
        },
      },
      relay: {
        ...createDiscordRelayPolicy(adapter),
        lifecycle: {
          platform: "discord",
          start: async () => {
            throw new Error("Reference descriptor lifecycle is unused");
          },
        },
      },
    });
  }

  return createGithubSurfaceRuntimeDescriptor({
    adapter,
    relay: {
      ...createGithubRelayPolicy(),
      lifecycle: {
        platform: "github",
        start: async () => {
          throw new Error("Reference descriptor lifecycle is unused");
        },
      },
    },
  });
}

function registryFor(descriptors: readonly RegisteredSurfaceRuntimeDescriptor[]) {
  const created = SurfaceRuntimeRegistry.create(descriptors);
  if (created.status === "error") throw created.error;
  return created.value;
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

function operationError<T>(result: ResultType<T, SurfaceOperationError>): SurfaceOperationError {
  expect(result.status).toBe("error");
  if (result.status === "ok") throw new Error("Expected a surface operation error");
  return result.error;
}

function recoverySnapshot(reference: ReferenceContract): GracefulRestartSnapshotInput {
  return {
    version: GRACEFUL_RESTART_SNAPSHOT_VERSION,
    createdAt: Date.now(),
    deadlineMs: 3_000,
    queueAttemptProof: "complete",
    agent: [],
    queueAttempts: [],
    relays: [relaySnapshot(reference)],
  };
}

describe("shared Discord/GitHub adapter and descriptor contract", () => {
  it("selects exactly one real relay from request_client with both descriptors active", async () => {
    const bus = createLilacBus(createInMemoryDeliveryBus());
    const discord = createReferenceDescriptor(DISCORD_REFERENCE, DISCORD_REFERENCE.createAdapter());
    const github = createReferenceDescriptor(GITHUB_REFERENCE, GITHUB_REFERENCE.createAdapter());
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
    "%s reanchors and cancels through shared relay bus handlers",
    async (_name, reference) => {
      const abortReasons: Array<string | undefined> = [];
      const restoreAbortObserver = observeOutputAborts(reference, abortReasons);
      const bus = createLilacBus(createInMemoryDeliveryBus());
      const descriptor = createReferenceDescriptor(reference, reference.createAdapter());
      const bridge = await createProductionBridge(reference, descriptor.adapter, bus);
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
    "%s owns output creation, finalization, skip, and cleanup outcomes",
    async (_name, reference) => {
      const log = createProtocolLog();
      const adapter = reference.createAdapter(log);
      const descriptor = createReferenceDescriptor(reference, adapter);
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
    "%s workflow progress checks, sends, edits, and preserves actions",
    async (_name, reference) => {
      const log = createProtocolLog();
      const descriptor = createReferenceDescriptor(reference, reference.createAdapter(log));
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
    },
  );

  it.each(REFERENCE_CASES)(
    "%s preserves one real guarded-stream hydration through recovery apply",
    async (_name, reference) => {
      const log = createProtocolLog();
      const descriptor = createReferenceDescriptor(reference, reference.createAdapter(log));
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
          snapshot: recoverySnapshot(reference),
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
      } finally {
        await bridge.stop();
        await bus.close();
      }
    },
  );
});
