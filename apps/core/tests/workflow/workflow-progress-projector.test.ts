import { normalizeWorkflowResourcePolicy, workflowStoreValue } from "./workflow-store-test-helpers";
import { Database } from "bun:sqlite";
import { describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLilacBus,
  lilacEventTypes,
  type FetchOptions,
  type Message,
  type PublishOptions,
  type RawBus,
  type RawDeliveryAction,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";
import { Panic, Result } from "better-result";
import { formatTaggedErrorForLog } from "@stanley2058/lilac-utils";
import { subscribeForTest, type TestRawMessageHandler } from "../helpers/result-raw-bus";
import type {
  AdapterEventHandler,
  SurfaceAdapter,
  SurfaceOutputStream,
} from "../../src/surface/adapter";
import { SurfaceMessageNotFoundError } from "../../src/surface/adapter";
import { createDiscordWorkflowProgressPort } from "../../src/surface/discord/discord-runtime-descriptor";
import { createGithubWorkflowProgressPort } from "../../src/surface/github/github-runtime-descriptor";
import type {
  RegisteredSurfacePlatform,
  RegisteredSurfaceWorkflowProgressPort,
  SurfaceWorkflowProgressPort,
} from "../../src/surface/runtime-descriptor";
import type {
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
} from "../../src/surface/types";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import { startWorkflowActionResolver } from "../../src/workflow/workflow-action-resolver";
import { sha256 } from "../../src/workflow/workflow-definition";
import {
  WorkflowProgressProjector,
  WorkflowProgressSurfaceCallFailed,
  WorkflowProgressSurfaceCreated,
  WorkflowProgressSurfaceNotFound,
} from "../../src/workflow/workflow-progress-projector";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

type WorkflowProgressProjectorTestInput = Omit<
  ConstructorParameters<typeof WorkflowProgressProjector>[0],
  "reportFatalPanic"
> &
  Partial<Pick<ConstructorParameters<typeof WorkflowProgressProjector>[0], "reportFatalPanic">>;

function createWorkflowProgressProjectorForTest(input: WorkflowProgressProjectorTestInput) {
  return new WorkflowProgressProjector({
    reportFatalPanic: (panic) => {
      throw panic;
    },
    ...input,
  });
}
class CapturingRawBus implements RawBus {
  readonly subscribe = subscribeForTest;
  readonly publishedOutboxIds: string[] = [];
  commits = 0;
  onCommit: (() => void) | null = null;
  outboxPublicationFailure: Error | null = null;
  subscriptionStopFailure: Error | null = null;
  private sequence = 0;
  private readonly subscriptions: Array<{
    topic: string;
    handler: TestRawMessageHandler;
  }> = [];
  async publish<TData>(message: Omit<Message<TData>, "id" | "ts">, options: PublishOptions) {
    const outboxId = options.headers?.["workflow_outbox_id"];
    if (outboxId && this.outboxPublicationFailure) throw this.outboxPublicationFailure;
    if (outboxId) this.publishedOutboxIds.push(outboxId);
    const id = `${++this.sequence}-0`;
    const stored: Message<unknown> = { ...message, id, ts: Date.now() };
    for (const subscription of this.subscriptions) {
      if (subscription.topic !== message.topic) continue;
      await subscription.handler(stored, id);
    }
    return { id, cursor: id };
  }
  async openTestSubscription(
    topic: string,
    _options: SubscriptionOptions,
    handler: TestRawMessageHandler,
  ) {
    const subscription = { topic, handler };
    this.subscriptions.push(subscription);
    return {
      stop: async () => {
        if (this.subscriptionStopFailure) throw this.subscriptionStopFailure;
        const index = this.subscriptions.indexOf(subscription);
        if (index >= 0) this.subscriptions.splice(index, 1);
      },
    };
  }
  onTestDeliveryAction(action: RawDeliveryAction): void {
    if (action.disposition !== "commit" && action.disposition !== "dead-letter") return;
    this.commits += 1;
    this.onCommit?.();
  }
  async fetch(_topic: string, _options: FetchOptions) {
    return { messages: [] };
  }
  async close() {}
}
class ProjectionAdapter implements SurfaceAdapter {
  readonly contents: ContentOpts[] = [];
  readonly messages = new Map<string, SurfaceMessage>();
  sends = 0;
  edits = 0;
  reads = 0;
  failNextSend = false;
  failNextRead = false;
  failNextEditNotFound = false;
  sendRejection: { readonly value: unknown } | null = null;
  editFailure: Error | null = null;
  constructor(readonly platform: "discord" | "github" = "discord") {}
  async connect() {}
  async disconnect() {}
  async getSelf() {
    return { platform: this.platform, userId: "bot", userName: "bot" };
  }
  async listSessions() {
    return [];
  }
  async startOutput(): Promise<SurfaceOutputStream> {
    throw new Error("not used");
  }
  async sendMsg(session: SessionRef, content: ContentOpts, _opts?: SendOpts): Promise<MsgRef> {
    if (this.sendRejection) {
      const rejection = this.sendRejection.value;
      this.sendRejection = null;
      throw rejection;
    }
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("transient surface failure");
    }
    this.sends += 1;
    this.contents.push(content);
    const ref: MsgRef =
      this.platform === "discord"
        ? { platform: "discord", channelId: session.channelId, messageId: `card-${this.sends}` }
        : { platform: "github", channelId: session.channelId, messageId: `card-${this.sends}` };
    this.messages.set(ref.messageId, {
      ref,
      session,
      userId: "bot",
      text: content.text ?? "",
      ts: Date.now(),
    });
    return ref;
  }
  async readMsg(ref: MsgRef) {
    this.reads += 1;
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error("transient lookup failure");
    }
    return this.messages.get(ref.messageId) ?? null;
  }
  async listMsg(_session: SessionRef, _opts?: LimitOpts) {
    return [...this.messages.values()];
  }
  async editMsg(ref: MsgRef, content: ContentOpts) {
    if (this.editFailure) throw this.editFailure;
    if (this.failNextEditNotFound) {
      this.failNextEditNotFound = false;
      this.messages.delete(ref.messageId);
      throw new SurfaceMessageNotFoundError(this.platform, 10008, "missing");
    }
    const current = this.messages.get(ref.messageId);
    if (!current) throw new SurfaceMessageNotFoundError(this.platform, 10008, "missing");
    this.edits += 1;
    this.contents.push(content);
    this.messages.set(ref.messageId, { ...current, text: content.text ?? "" });
  }
  async deleteMsg(ref: MsgRef) {
    this.messages.delete(ref.messageId);
  }
  async getReplyContext() {
    return [];
  }
  async addReaction() {}
  async removeReaction() {}
  async listReactions() {
    return [];
  }
  async subscribe(_handler: AdapterEventHandler) {
    return { stop: async () => {} };
  }
  async getUnRead() {
    return [];
  }
  async markRead() {}
}
class BlockingProjectionAdapter extends ProjectionAdapter {
  private releaseSend: (() => void) | null = null;
  private resolveSendStarted: () => void = () => {};
  readonly sendStarted = new Promise<void>((resolve) => {
    this.resolveSendStarted = resolve;
  });
  release(): void {
    this.releaseSend?.();
  }
  override async sendMsg(
    session: SessionRef,
    content: ContentOpts,
    options?: SendOpts,
  ): Promise<MsgRef> {
    this.resolveSendStarted();
    await new Promise<void>((resolve) => {
      this.releaseSend = resolve;
    });
    return await super.sendMsg(session, content, options);
  }
}
function projectionPorts(
  adapter: ProjectionAdapter,
): Map<RegisteredSurfacePlatform, RegisteredSurfaceWorkflowProgressPort> {
  const ports = new Map<RegisteredSurfacePlatform, RegisteredSurfaceWorkflowProgressPort>();
  if (adapter.platform === "discord") {
    ports.set("discord", createDiscordWorkflowProgressPort(adapter));
  } else {
    ports.set("github", createGithubWorkflowProgressPort(adapter));
  }
  return ports;
}
function combinedProjectionPorts(
  ...adapters: readonly ProjectionAdapter[]
): Map<RegisteredSurfacePlatform, RegisteredSurfaceWorkflowProgressPort> {
  const ports = new Map<RegisteredSurfacePlatform, RegisteredSurfaceWorkflowProgressPort>();
  for (const adapter of adapters) {
    for (const [platform, port] of projectionPorts(adapter)) ports.set(platform, port);
  }
  return ports;
}
function createInvocation(
  store: DurableWorkflowStore,
  hasProgressTarget = true,
  platform: "discord" | "github" = "discord",
): void {
  store.createInvocation({
    revision: {
      revisionId: "revision-1",
      canonicalProjectId: "project-1",
      canonicalWorkspaceRoot: "/workspace",
      scope: "project",
      normalizedPath: "audit.js",
      name: "audit",
      snapshotArtifactId: `workflow-source:${HASH_A}`,
      sourceSha256: HASH_A,
      inputSchemaSha256: HASH_B,
      resourcePolicySha256: "c".repeat(64),
      metadata: { name: "audit", description: "Audit routes" },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { directory: { type: "string" }, token: { type: "string", sensitive: true } },
      },
      resources: normalizeWorkflowResourcePolicy({
        agents: { maxConcurrent: 2, maxTotal: 8 },
        maxNestingDepth: 4,
        operationIdleTimeoutMs: 10000,
        waits: [],
      }),
      limits: {
        maxSourceBytes: 100000,
        maxInputBytes: 10000,
        maxOperationOutputBytes: 10000,
        maxResultBytes: 10000,
      },
      runtimeVersion: "lilac-workflow-js-v4",
      createdAt: 10,
    },
    run: {
      runId: "run-1",
      revisionId: "revision-1",
      state: "queued",
      inputSchemaSnapshot: {
        type: "object",
        additionalProperties: false,
        properties: { directory: { type: "string" }, token: { type: "string", sensitive: true } },
      },
      args: { directory: "src", token: "secret" },
      argsSha256: "d".repeat(64),
      origin: {
        requestId: `${platform}:channel-1:origin-1`,
        sessionId: "channel-1",
        client: platform,
        userId: "user-1",
        projectCwd: "/workspace",
      },
      completionTarget: { kind: "durable_surface" },
      progressTarget: hasProgressTarget
        ? { platform, channelId: "channel-1", replyToMessageId: "origin-1" }
        : null,
      terminalDetail: null,
      result: null,
      resultArtifactId: null,
      claimedBy: null,
      claimedAt: null,
      createdAt: 10,
      startedAt: null,
      updatedAt: 10,
      terminalAt: null,
    },
  });
}
function contentActionToken(content: ContentOpts | undefined, label: string): string {
  const token = content?.actions?.find((action) => action.label === label)?.actionId;
  if (!token) throw new Error(`Missing ${label} action`);
  return token;
}
function actionToken(adapter: ProjectionAdapter, label: string): string {
  return contentActionToken(adapter.contents.at(-1), label);
}
function appliedSurfaceActionStatus(
  result: ReturnType<DurableWorkflowStore["applySurfaceAction"]>,
): string {
  expect(result.status).toBe("ok");
  if (result.status === "error") throw result.error;
  return result.value.status;
}
function tempDbPath(label: string): string {
  return join(tmpdir(), `${label}-${crypto.randomUUID()}.sqlite`);
}
describe("WorkflowProgressProjector", () => {
  it("uses unique stable tags for each workflow progress surface outcome", () => {
    const createdRef: MsgRef = {
      platform: "github",
      channelId: "octo/repo#1",
      messageId: "42",
    };
    const errors = [
      new WorkflowProgressSurfaceCreated({
        failureKind: "created",
        createdRef,
        message: "created",
      }),
      new WorkflowProgressSurfaceNotFound({
        failureKind: "not-found",
        createdRef: null,
        message: "not found",
      }),
      new WorkflowProgressSurfaceCallFailed({
        failureKind: "failed",
        createdRef: null,
        message: "failed",
      }),
    ];
    expect(errors.map((error) => error._tag)).toEqual([
      "WorkflowProgressSurfaceCreated",
      "WorkflowProgressSurfaceNotFound",
      "WorkflowProgressSurfaceCallFailed",
    ]);
    expect(errors.map((error) => formatTaggedErrorForLog(error).errorTag)).toEqual([
      "WorkflowProgressSurfaceCreated",
      "WorkflowProgressSurfaceNotFound",
      "WorkflowProgressSurfaceCallFailed",
    ]);
  });

  it("ignores event projection for a null target and rejects explicit card creation", async () => {
    const dbPath = tempDbPath("workflow-null-target");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "null-target",
      coalesceMs: 0,
      minEditIntervalMs: 0,
    });
    try {
      createInvocation(store, false);
      projector.requestProjection("run-1");
      // test-wait-justification: allows an asynchronously requested null-target projection to be ignored
      await Bun.sleep(20);
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toBeNull();
      expect(adapter.sends).toBe(0);
      await expect(projector.ensureInitialCard("run-1")).rejects.toThrow(
        "has no supported durable progress target",
      );
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("creates one durable binding and skips unchanged edits by rendered hash", async () => {
    const dbPath = tempDbPath("workflow-one-binding");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "one-binding",
      now: () => 20,
    });
    try {
      createInvocation(store);
      const first = await projector.ensureInitialCard("run-1");
      const binding = workflowStoreValue(store.getSurfaceBinding("run-1"));
      expect(binding?.messageRef).toEqual(first);
      expect(binding?.lastRenderedSha256).toHaveLength(64);
      const content = adapter.contents[0];
      expect(content?.text).toContain("## audit\nAudit routes\n\n**Queued**");
      expect(content?.attachments).toEqual([]);
      for (const internalValue of [
        "run-1",
        "revision-1",
        "project-1",
        "/workspace",
        "audit.js",
        HASH_A,
        HASH_B,
        "Resources and durability",
        "Hashes",
        "Source access",
        "tokens",
      ]) {
        expect(content?.text).not.toContain(internalValue);
      }
      await projector.ensureInitialCard("run-1");
      expect(adapter.sends).toBe(1);
      expect(adapter.edits).toBe(0);
      expect(workflowStoreValue(store.listSurfaceBindings())).toHaveLength(1);
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("coalesces repeated wakeups into one changed-state edit", async () => {
    const dbPath = tempDbPath("workflow-coalescing");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "coalescing",
      now: () => 100,
      coalesceMs: 5,
      minEditIntervalMs: 0,
    });
    try {
      createInvocation(store);
      await projector.ensureInitialCard("run-1");
      expect(store.tryClaimRun({ runId: "run-1", claimerId: "engine", now: 101 })?.state).toBe(
        "running",
      );
      projector.requestProjection("run-1");
      projector.requestProjection("run-1");
      // test-wait-justification: crosses the real coalescing window before asserting one projected edit
      await Bun.sleep(30);
      expect(adapter.edits).toBe(1);
      expect(adapter.contents.at(-1)?.text).toContain("**Running**");
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("schedules an event projection before transport commit", async () => {
    const dbPath = tempDbPath("workflow-schedule-before-commit");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "schedule-before-commit",
      coalesceMs: 1000000,
    });
    const order: string[] = [];
    const requestProjection = projector.requestProjection.bind(projector);
    const requestSpy = spyOn(projector, "requestProjection").mockImplementation((runId) => {
      order.push("schedule");
      requestProjection(runId);
    });
    raw.onCommit = () => order.push("commit");
    try {
      createInvocation(store);
      await projector.start();
      order.length = 0;
      await bus.publish(lilacEventTypes.EvtWorkflowProgressRequested, {
        runId: "run-1",
        revisionId: "revision-1",
        reason: "reconcile",
        ts: 20,
      });
      expect(order).toEqual(["schedule", "commit"]);
    } finally {
      requestSpy.mockRestore();
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("reconciles targeted runs at startup and recreates a missing bound card", async () => {
    const dbPath = tempDbPath("workflow-startup-reconcile");
    let store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    let projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "startup-first",
      now: () => 20,
    });
    try {
      createInvocation(store);
      await projector.start();
      expect(adapter.sends).toBe(1);
      const firstRef = workflowStoreValue(store.getSurfaceBinding("run-1"))?.messageRef;
      if (!firstRef) throw new Error("Missing startup binding");
      await projector.stop();
      store.close();
      adapter.messages.delete(firstRef.messageId);
      store = new DurableWorkflowStore(dbPath);
      projector = createWorkflowProgressProjectorForTest({
        bus,
        store,
        ports: projectionPorts(adapter),
        subscriptionId: "startup-second",
        now: () => 30,
      });
      await projector.start();
      expect(adapter.reads).toBe(1);
      expect(adapter.sends).toBe(2);
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))?.messageRef?.messageId).toBe(
        "card-2",
      );
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it.each(["discord", "github"] as const)(
    "repairs a persisted %s binding ref platform mismatch and does not duplicate after restart",
    async (platform) => {
      const dbPath = tempDbPath(`workflow-binding-platform-mismatch-${platform}`);
      let store = new DurableWorkflowStore(dbPath);
      const discordAdapter = new ProjectionAdapter("discord");
      const githubAdapter = new ProjectionAdapter("github");
      const targetAdapter = platform === "discord" ? discordAdapter : githubAdapter;
      const otherAdapter = platform === "discord" ? githubAdapter : discordAdapter;
      const bus = createLilacBus(new CapturingRawBus());
      let projector = createWorkflowProgressProjectorForTest({
        bus,
        store,
        ports: combinedProjectionPorts(discordAdapter, githubAdapter),
        subscriptionId: `binding-platform-mismatch-${platform}`,
        now: () => 20,
      });
      const mismatchedRef: MsgRef =
        platform === "discord"
          ? { platform: "github", channelId: "octo/repo#1", messageId: "42" }
          : { platform: "discord", channelId: "channel-1", messageId: "message-1" };
      try {
        createInvocation(store, true, platform);
        store.upsertSurfaceBinding({
          runId: "run-1",
          target: { platform, channelId: "channel-1", replyToMessageId: "origin-1" },
          messageRef: mismatchedRef,
          lastRenderedSha256: HASH_A,
          lastError: "retry due",
          retryCount: 2,
          nextAttemptAt: 20,
          createdAt: 10,
          updatedAt: 10,
        });

        const recreated = await projector.ensureInitialCard("run-1");
        expect(recreated.platform).toBe(platform);
        expect(targetAdapter.sends).toBe(1);
        expect(otherAdapter.sends).toBe(0);
        expect(otherAdapter.reads).toBe(0);
        expect(otherAdapter.edits).toBe(0);
        expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
          messageRef: recreated,
          lastError: null,
          retryCount: 0,
          nextAttemptAt: null,
        });
        expect(workflowStoreValue(store.getSurfaceBinding("run-1"))?.lastRenderedSha256).not.toBe(
          HASH_A,
        );

        await projector.stop();
        store.close();
        store = new DurableWorkflowStore(dbPath);
        projector = createWorkflowProgressProjectorForTest({
          bus,
          store,
          ports: combinedProjectionPorts(discordAdapter, githubAdapter),
          subscriptionId: `binding-platform-mismatch-${platform}-restarted`,
          now: () => 30,
        });
        await projector.start();

        expect(targetAdapter.sends).toBe(1);
        expect(otherAdapter.sends).toBe(0);
        expect(workflowStoreValue(store.getSurfaceBinding("run-1"))?.messageRef).toEqual(recreated);
      } finally {
        await projector.stop();
        await bus.close();
        store.close();
        rmSync(dbPath, { force: true });
      }
    },
  );
  it("repairs stale terminal cards, skips clean history, and retries failed bindings", async () => {
    const dbPath = tempDbPath("workflow-terminal-reconcile");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    let now = 20;
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "terminal-reconcile",
      now: () => now,
      coalesceMs: 0,
      minEditIntervalMs: 0,
      retryIntervalMs: 5,
    });
    try {
      createInvocation(store);
      await projector.ensureInitialCard("run-1");
      expect(
        store.transitionRun({
          runId: "run-1",
          from: "queued",
          to: "cancelled",
          now: 30,
        }),
      ).toBe(true);
      now = 40;
      await projector.reconcile();
      expect(adapter.reads).toBe(1);
      expect(adapter.contents.at(-1)?.text).toContain("**Cancelled**");
      await projector.reconcile();
      expect(adapter.reads).toBe(1);
      const binding = workflowStoreValue(store.getSurfaceBinding("run-1"));
      if (!binding) throw new Error("Missing terminal surface binding");
      store.upsertSurfaceBinding({
        ...binding,
        lastError: "transient terminal projection failure",
        retryCount: 1,
        nextAttemptAt: 100,
        updatedAt: 99,
      });
      now = 100;
      await projector.start();
      for (
        let attempt = 0;
        attempt < 100 && workflowStoreValue(store.getSurfaceBinding("run-1"))?.lastError !== null;
        attempt += 1
      ) {
        // test-wait-justification: polls for the projector's independently scheduled persisted retry
        await Bun.sleep(5);
      }
      expect(adapter.reads).toBe(2);
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
        lastError: null,
        retryCount: 0,
        nextAttemptAt: null,
      });
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("persists projection failures and retries with backoff", async () => {
    const dbPath = tempDbPath("workflow-projector-retry");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    let now = 100;
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "retry",
      now: () => now,
      coalesceMs: 0,
      minEditIntervalMs: 0,
      retryIntervalMs: 5,
    });
    try {
      createInvocation(store);
      adapter.failNextSend = true;
      await expect(projector.ensureInitialCard("run-1")).rejects.toThrow(
        "initial progress card could not be created",
      );
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
        messageRef: null,
        retryCount: 1,
        nextAttemptAt: 1100,
        lastError: "transient surface failure",
      });
      await projector.start();
      now = 1100;
      for (let attempt = 0; attempt < 100 && adapter.sends === 0; attempt += 1) {
        // test-wait-justification: polls for the projector's independently scheduled initial-card retry
        await Bun.sleep(5);
      }
      expect(adapter.sends).toBe(1);
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
        retryCount: 0,
        nextAttemptAt: null,
        lastError: null,
      });
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("keeps opaque non-Error surface rejections out of durable failures", async () => {
    const dbPath = tempDbPath("workflow-projector-opaque-rejection");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "opaque-rejection",
      now: () => 100,
    });
    try {
      createInvocation(store);
      adapter.sendRejection = { value: "provider-secret-rejection" };

      await expect(projector.ensureInitialCard("run-1")).rejects.toThrow(
        "Opaque workflow progress surface failure",
      );
      const binding = workflowStoreValue(store.getSurfaceBinding("run-1"));
      expect(binding?.lastError).toBe("Opaque workflow progress surface failure");
      expect(binding?.lastError).not.toContain("provider-secret-rejection");
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("clears a missing edit target and recreates the card on the next projection", async () => {
    const dbPath = tempDbPath("workflow-projector-missing-edit");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    let now = 20;
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "missing-edit",
      now: () => now,
    });
    try {
      createInvocation(store);
      const firstRef = await projector.ensureInitialCard("run-1");
      expect(store.tryClaimRun({ runId: "run-1", claimerId: "engine", now: 21 })?.state).toBe(
        "running",
      );
      adapter.failNextEditNotFound = true;
      now = 30;
      await expect(projector.ensureInitialCard("run-1")).rejects.toThrow(
        "initial progress card could not be created",
      );
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
        messageRef: null,
        lastRenderedSha256: null,
        retryCount: 1,
        lastError: "Workflow progress message was not found",
      });

      now = 40;
      const recreated = await projector.ensureInitialCard("run-1");
      expect(recreated.messageId).not.toBe(firstRef.messageId);
      expect(adapter.sends).toBe(2);
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("recovers persisted partial GitHub creation immediately after hard restart", async () => {
    const dbPath = tempDbPath("workflow-projector-created-outcome");
    let store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    let now = 20;
    let sends = 0;
    let edits = 0;
    const sentContents: ContentOpts[] = [];
    const editedContents: ContentOpts[] = [];
    const createdRef = {
      platform: "github" as const,
      channelId: "channel-1",
      messageId: "created-card",
    };
    const port: SurfaceWorkflowProgressPort<"github"> = {
      checkMessage: async () => Result.ok("found"),
      send: async (input) => {
        sends += 1;
        sentContents.push(input.content);
        return sends === 1
          ? Result.err({ kind: "created", ref: createdRef })
          : Result.ok(createdRef);
      },
      edit: async (_target, content) => {
        edits += 1;
        editedContents.push(content);
        return Result.ok(undefined);
      },
    };
    let projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: new Map([["github", port]]),
      subscriptionId: "created-outcome",
      now: () => now,
    });
    try {
      createInvocation(store, true, "github");
      await expect(projector.ensureInitialCard("run-1")).resolves.toEqual(createdRef);
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
        messageRef: createdRef,
        lastRenderedSha256: null,
        retryCount: 1,
        lastError: "Workflow progress message was created but could not be fully rendered",
      });
      expect(sends).toBe(1);
      expect(edits).toBe(0);
      const initialToken = contentActionToken(sentContents.at(-1), "Pause");
      expect(
        workflowStoreValue(store.getSurfaceActionByTokenSha256(sha256(initialToken)))
          ?.expectedMessageRef,
      ).toBeNull();

      await projector.stop();
      store.close();
      store = new DurableWorkflowStore(dbPath);
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
        messageRef: createdRef,
        lastRenderedSha256: null,
        retryCount: 1,
        nextAttemptAt: 1_020,
        lastError: "Workflow progress message was created but could not be fully rendered",
      });

      now = 21;
      projector = createWorkflowProgressProjectorForTest({
        bus,
        store,
        ports: new Map([["github", port]]),
        subscriptionId: "created-outcome-restarted",
        now: () => now,
      });
      await projector.start();
      expect(sends).toBe(1);
      expect(edits).toBe(1);
      const restartedContent = editedContents.at(-1);
      const restartedToken = contentActionToken(restartedContent, "Pause");
      expect(restartedToken).not.toBe(initialToken);
      const restartedHash = sha256(
        JSON.stringify({
          text: restartedContent?.text,
          actions: restartedContent?.actions,
          revision: HASH_A,
        }),
      );
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
        messageRef: createdRef,
        lastRenderedSha256: restartedHash,
        retryCount: 0,
        nextAttemptAt: null,
        lastError: null,
      });
      expect(
        workflowStoreValue(store.getSurfaceActionByTokenSha256(sha256(restartedToken)))
          ?.expectedMessageRef,
      ).toEqual(createdRef);
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(restartedToken),
            platform: "github",
            userId: "user-1",
            messageRef: { ...createdRef, messageId: "different-card" },
            now: 22,
          }),
        ),
      ).toBe("unauthorized");
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(restartedToken),
            platform: "github",
            userId: "user-1",
            messageRef: createdRef,
            now: 23,
          }),
        ),
      ).toBe("applied");
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("renders pause, resume, cancel, and terminal card states", async () => {
    const dbPath = tempDbPath("workflow-controls");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    let now = 20;
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "controls",
      now: () => now,
    });
    try {
      createInvocation(store);
      const messageRef = await projector.ensureInitialCard("run-1");
      expect(adapter.contents.at(-1)?.actions?.map((action) => action.label)).toEqual([
        "Pause",
        "Cancel",
      ]);
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(actionToken(adapter, "Pause")),
            platform: "discord",
            userId: "user-1",
            messageRef,
            now: ++now,
          }),
        ),
      ).toBe("applied");
      await projector.ensureInitialCard("run-1");
      expect(adapter.contents.at(-1)?.actions?.map((action) => action.label)).toEqual([
        "Resume",
        "Cancel",
      ]);
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(actionToken(adapter, "Resume")),
            platform: "discord",
            userId: "user-1",
            messageRef,
            now: ++now,
          }),
        ),
      ).toBe("applied");
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(actionToken(adapter, "Cancel")),
            platform: "discord",
            userId: "user-1",
            messageRef,
            now: ++now,
          }),
        ),
      ).toBe("applied");
      await projector.ensureInitialCard("run-1");
      expect(adapter.contents.at(-1)?.actions).toEqual([]);
      expect(adapter.contents.at(-1)?.text).toContain("**Cancelled**");
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("preserves workflow progress actions for GitHub cards", async () => {
    const dbPath = tempDbPath("workflow-github-controls");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter("github");
    const bus = createLilacBus(new CapturingRawBus());
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "github-controls",
      now: () => 20,
    });
    try {
      createInvocation(store, true, "github");
      const messageRef = await projector.ensureInitialCard("run-1");
      expect(adapter.contents.at(-1)?.actions?.map((action) => action.label)).toEqual([
        "Pause",
        "Cancel",
      ]);
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(actionToken(adapter, "Pause")),
            platform: "github",
            userId: "user-1",
            messageRef,
            now: 21,
          }),
        ),
      ).toBe("applied");
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("does not republish or reproject completed durable action outbox entries after restart", async () => {
    const dbPath = tempDbPath("workflow-action-outbox");
    let store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    const initialProjector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "outbox-initial",
      now: () => 20,
    });
    let resolver: Awaited<ReturnType<typeof startWorkflowActionResolver>> | null = null;
    try {
      createInvocation(store);
      const messageRef = await initialProjector.ensureInitialCard("run-1");
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(actionToken(adapter, "Pause")),
            platform: "discord",
            userId: "user-1",
            messageRef,
            now: 21,
          }),
        ),
      ).toBe("applied");
      resolver = await startWorkflowActionResolver({
        bus,
        store,
        subscriptionId: "outbox-resolver-first",
        now: () => 30,
      });
      expect(raw.publishedOutboxIds).toHaveLength(2);
      await resolver.stop();
      resolver = null;
      const projecting = createWorkflowProgressProjectorForTest({
        bus,
        store,
        ports: projectionPorts(adapter),
        subscriptionId: "outbox-projector-first",
        now: () => 30,
      });
      await projecting.start();
      expect([...workflowStoreValue(store.listPendingActionOutboxEvents(30))]).toEqual([]);
      expect([...workflowStoreValue(store.listPendingActionOutboxProjections())]).toEqual([]);
      await projecting.stop();
      await initialProjector.stop();
      store.close();
      store = new DurableWorkflowStore(dbPath);
      resolver = await startWorkflowActionResolver({
        bus,
        store,
        subscriptionId: "outbox-resolver-second",
        now: () => 40,
      });
      const restartedProjector = createWorkflowProgressProjectorForTest({
        bus,
        store,
        ports: projectionPorts(adapter),
        subscriptionId: "outbox-projector-second",
        now: () => 40,
      });
      await restartedProjector.start();
      expect(raw.publishedOutboxIds).toHaveLength(2);
      expect(new Set(raw.publishedOutboxIds).size).toBe(2);
      expect([...workflowStoreValue(store.listPendingActionOutboxProjections())]).toEqual([]);
      await restartedProjector.stop();
    } finally {
      await resolver?.stop();
      await initialProjector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("rolls back state, consumption, and both outbox rows when SQLite rejects the second row", async () => {
    const dbPath = tempDbPath("workflow-action-outbox-atomic-driver-failure");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "outbox-atomic-driver-failure",
      now: () => 20,
    });
    const inspection = new Database(dbPath);
    try {
      createInvocation(store);
      const messageRef = await projector.ensureInitialCard("run-1");
      const tokenSha256 = sha256(actionToken(adapter, "Pause"));
      inspection.run(`CREATE TRIGGER reject_workflow_progress_outbox
        BEFORE INSERT ON workflow_action_outbox
        WHEN NEW.event_type = 'evt.workflow.progress.requested'
        BEGIN
          SELECT RAISE(ABORT, 'reject deterministic second outbox row');
        END`);
      const applied = store.applySurfaceAction({
        tokenSha256,
        platform: "discord",
        userId: "user-1",
        messageRef,
        now: 21,
      });
      expect(applied.status).toBe("error");
      if (applied.status === "error") {
        expect(applied.error._tag).toBe("DurableWorkflowSqliteDriverFailure");
      }
      expect(workflowStoreValue(store.getRun("run-1"))?.state).toBe("queued");
      expect(
        workflowStoreValue(store.getSurfaceActionByTokenSha256(tokenSha256))?.consumedAt,
      ).toBeNull();
      expect([...workflowStoreValue(store.listPendingActionOutboxEvents(100))]).toEqual([]);
    } finally {
      inspection.close();
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("preserves Panic identity and rolls back a surface action before consumption and outbox", async () => {
    const dbPath = tempDbPath("workflow-action-outbox-atomic-panic");
    const panic = new Panic({ message: "surface action atomicity defect" });
    const store = new DurableWorkflowStore(dbPath, {
      testHooks: {
        afterSurfaceActionStateChange: () => {
          throw panic;
        },
      },
    });
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "outbox-atomic-panic",
      now: () => 20,
    });
    try {
      createInvocation(store);
      const messageRef = await projector.ensureInitialCard("run-1");
      const tokenSha256 = sha256(actionToken(adapter, "Pause"));
      expect(() =>
        store.applySurfaceAction({
          tokenSha256,
          platform: "discord",
          userId: "user-1",
          messageRef,
          now: 21,
        }),
      ).toThrow(panic);
      expect(workflowStoreValue(store.getRun("run-1"))?.state).toBe("queued");
      expect(
        workflowStoreValue(store.getSurfaceActionByTokenSha256(tokenSha256))?.consumedAt,
      ).toBeNull();
      expect([...workflowStoreValue(store.listPendingActionOutboxEvents(100))]).toEqual([]);
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("records external action outbox publication failures for durable retry", async () => {
    const dbPath = tempDbPath("workflow-action-outbox-publication-failure");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "outbox-publication-failure-projector",
      now: () => 20,
    });
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    let resolver: Awaited<ReturnType<typeof startWorkflowActionResolver>> | null = null;
    try {
      createInvocation(store);
      const messageRef = await projector.ensureInitialCard("run-1");
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(actionToken(adapter, "Pause")),
            platform: "discord",
            userId: "user-1",
            messageRef,
            now: 21,
          }),
        ),
      ).toBe("applied");
      raw.outboxPublicationFailure = new Error("outbox transport unavailable");
      resolver = await startWorkflowActionResolver({
        bus,
        store,
        subscriptionId: "outbox-publication-failure",
        now: () => 30,
      });
      expect(workflowStoreValue(store.listPendingActionOutboxEvents(10000))).toHaveLength(2);
      expect(raw.publishedOutboxIds).toEqual([]);
      expect(
        workflowStoreValue(store.listPendingActionOutboxEvents(10000)).every(
          (entry) => entry.publishedAt === null,
        ),
      ).toBe(true);
      expect(workflowStoreValue(store.listPendingActionOutboxEvents(10000))[0]).toMatchObject({
        attemptCount: 1,
        lastError: "Workflow action outbox publication failed",
      });
    } finally {
      warning.mockRestore();
      await resolver?.stop();
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("preserves Panic identity from action outbox publication", async () => {
    const dbPath = tempDbPath("workflow-action-outbox-panic");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "outbox-panic-projector",
      now: () => 20,
    });
    const panic = new Panic({ message: "outbox publication defect" });
    try {
      createInvocation(store);
      const messageRef = await projector.ensureInitialCard("run-1");
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(actionToken(adapter, "Pause")),
            platform: "discord",
            userId: "user-1",
            messageRef,
            now: 21,
          }),
        ),
      ).toBe("applied");
      raw.outboxPublicationFailure = panic;
      await expect(
        startWorkflowActionResolver({
          bus,
          store,
          subscriptionId: "outbox-panic",
          now: () => 30,
        }),
      ).rejects.toBe(panic);
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("reports projection timer Panic to the fatal supervisor", async () => {
    const dbPath = tempDbPath("workflow-projection-timer-panic");
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    const panic = new Panic({ message: "projection timer defect" });
    const firstReport = Promise.withResolvers<void>();
    const secondAttempt = Promise.withResolvers<void>();
    const reported: Panic[] = [];
    let attempts = 0;
    const getRun = spyOn(store, "getRun").mockImplementation(() => {
      attempts += 1;
      if (attempts === 2) secondAttempt.resolve();
      throw panic;
    });
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: new Map(),
      subscriptionId: "projection-timer-panic",
      coalesceMs: 0,
      minEditIntervalMs: 0,
      reportFatalPanic: (fatalPanic) => {
        reported.push(fatalPanic);
        firstReport.resolve();
      },
    });
    try {
      projector.requestProjection("run-panic");
      await firstReport.promise;
      projector.requestProjection("run-panic");
      await secondAttempt.promise;
      await Promise.resolve();
      expect(reported).toEqual([panic]);
    } finally {
      getRun.mockRestore();
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("reports detached action outbox projection Panic to the fatal supervisor", async () => {
    const dbPath = tempDbPath("workflow-projection-outbox-panic");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const panic = new Panic({ message: "projection outbox defect" });
    const reported = Promise.withResolvers<Panic>();
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "projection-outbox-panic",
      now: () => 20,
      retryIntervalMs: 1,
      reportFatalPanic: reported.resolve,
    });
    try {
      createInvocation(store);
      const messageRef = await projector.ensureInitialCard("run-1");
      await projector.start();
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(actionToken(adapter, "Pause")),
            platform: "discord",
            userId: "user-1",
            messageRef,
            now: 21,
          }),
        ),
      ).toBe("applied");
      adapter.editFailure = panic;

      await expect(reported.promise).resolves.toBe(panic);
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("adapts action and projector subscription lifecycle Result failures", async () => {
    const dbPath = tempDbPath("workflow-subscription-result-adapters");
    const store = new DurableWorkflowStore(dbPath);
    const startFailureRaw = new CapturingRawBus();
    Reflect.deleteProperty(startFailureRaw, "subscribe");
    const startFailureBus = createLilacBus(startFailureRaw);
    const projector = createWorkflowProgressProjectorForTest({
      bus: startFailureBus,
      store,
      ports: new Map(),
      subscriptionId: "projector-start-result-failure",
    });
    try {
      await expect(
        startWorkflowActionResolver({
          bus: startFailureBus,
          store,
          subscriptionId: "action-start-result-failure",
        }),
      ).rejects.toMatchObject({ _tag: "EventDeliveryStartFailed" });
      await expect(projector.start()).rejects.toMatchObject({ _tag: "EventDeliveryStartFailed" });
      const stopFailureRaw = new CapturingRawBus();
      const stopFailureBus = createLilacBus(stopFailureRaw);
      const actionResolver = await startWorkflowActionResolver({
        bus: stopFailureBus,
        store,
        subscriptionId: "action-stop-result-failure",
      });
      const stoppingProjector = createWorkflowProgressProjectorForTest({
        bus: stopFailureBus,
        store,
        ports: new Map(),
        subscriptionId: "projector-stop-result-failure",
      });
      await stoppingProjector.start();
      stopFailureRaw.subscriptionStopFailure = new Error("subscription cleanup unavailable");
      await expect(actionResolver.stop()).rejects.toMatchObject({
        _tag: "EventDeliveryStopFailed",
      });
      await expect(stoppingProjector.stop()).rejects.toMatchObject({
        _tag: "EventDeliveryStopFailed",
      });
      await stopFailureBus.close();
    } finally {
      await startFailureBus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("commits an authenticated action rejected by owner validation", async () => {
    const dbPath = tempDbPath("workflow-malformed-action-commit");
    const store = new DurableWorkflowStore(dbPath);
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    const resolver = await startWorkflowActionResolver({
      bus,
      store,
      subscriptionId: "malformed-action-commit",
      now: () => 20,
    });
    try {
      await bus.publish(lilacEventTypes.EvtAdapterActionInvoked, {
        actionId: "malformed-action-token",
        platform: "discord",
        userId: "user-1",
        messageRef: {
          platform: "github",
          channelId: "issue-1",
          messageId: "comment-1",
        },
        ts: 20,
      });
      expect(raw.commits).toBe(1);
    } finally {
      warning.mockRestore();
      await resolver.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("waits for an in-flight projection during shutdown", async () => {
    const dbPath = tempDbPath("workflow-projector-shutdown");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new BlockingProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "shutdown",
    });
    try {
      createInvocation(store);
      const projection = projector.ensureInitialCard("run-1");
      await adapter.sendStarted;
      let stopped = false;
      const stopping = projector.stop().then(() => {
        stopped = true;
      });
      // test-wait-justification: verifies shutdown remains pending while a real in-flight projection is blocked
      await Bun.sleep(10);
      expect(stopped).toBe(false);
      adapter.release();
      await projection;
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      adapter.release();
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
});
