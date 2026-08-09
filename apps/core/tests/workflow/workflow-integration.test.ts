import { workflowStoreValue } from "./workflow-store-test-helpers";
import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  createLilacBus,
  lilacEventTypes,
  type FetchOptions,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";
import {
  okResultForTest,
  startResultForTest,
  stopResultForTest,
  subscribeForTest,
  type TestRawMessageHandler,
} from "../helpers/result-raw-bus";
import type {
  AdapterEventHandler,
  SurfaceAdapter,
  SurfaceOutputStream,
} from "../../src/surface/adapter";
import type {
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
} from "../../src/surface/types";
import { ProgrammaticWorkflow } from "../../src/tool-server/tools/programmatic-workflow";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import { startWorkflowActionResolver } from "../../src/workflow/workflow-action-resolver";
import { WorkflowEngine } from "../../src/workflow/workflow-engine";
import { WorkflowProgressProjector } from "../../src/workflow/workflow-progress-projector";

function createWorkflowProgressProjectorForTest(
  input: Omit<ConstructorParameters<typeof WorkflowProgressProjector>[0], "reportFatalPanic">,
) {
  return new WorkflowProgressProjector({
    ...input,
    reportFatalPanic: (panic) => {
      throw panic;
    },
  });
}

class LiveRawBus implements RawBus {
  subscribe = subscribeForTest;
  private sequence = 0;
  private readonly subscriptions = new Set<{
    topic: string;
    handler: TestRawMessageHandler;
  }>();
  async publish<TData>(message: Omit<Message<TData>, "id" | "ts">, options: PublishOptions) {
    const id = `${++this.sequence}-0`;
    const stored: Message<TData> = { ...message, id, ts: Date.now(), topic: options.topic };
    for (const subscription of this.subscriptions) {
      if (subscription.topic === options.topic) {
        await subscription.handler(stored, id);
      }
    }
    return { id, cursor: id };
  }
  async openTestSubscription(
    topic: string,
    _options: SubscriptionOptions,
    handler: TestRawMessageHandler,
  ) {
    const subscription = { topic, handler };
    this.subscriptions.add(subscription);
    return { stop: async () => void this.subscriptions.delete(subscription) };
  }
  async fetch(_topic: string, _options: FetchOptions) {
    return { messages: [] };
  }
  async close() {
    this.subscriptions.clear();
  }
}
class WorkflowCardAdapter implements SurfaceAdapter {
  readonly contents: ContentOpts[] = [];
  readonly messages = new Map<string, SurfaceMessage>();
  sends = 0;
  edits = 0;
  async connect() {}
  async disconnect() {}
  async getSelf() {
    return { platform: "discord" as const, userId: "bot", userName: "bot" };
  }
  async listSessions() {
    return [];
  }
  async startOutput(): Promise<SurfaceOutputStream> {
    throw new Error("not used");
  }
  async sendMsg(session: SessionRef, content: ContentOpts, _opts?: SendOpts): Promise<MsgRef> {
    this.sends += 1;
    this.contents.push(content);
    const ref = {
      platform: "discord" as const,
      channelId: session.channelId,
      messageId: `workflow-card-${this.sends}`,
    };
    this.messages.set(ref.messageId, {
      ref,
      session: { platform: "discord", channelId: session.channelId },
      userId: "bot",
      text: content.text ?? "",
      ts: Date.now(),
    });
    return ref;
  }
  async readMsg(ref: MsgRef) {
    return this.messages.get(ref.messageId) ?? null;
  }
  async listMsg(_session: SessionRef, _opts?: LimitOpts) {
    return [...this.messages.values()];
  }
  async editMsg(ref: MsgRef, content: ContentOpts) {
    const current = this.messages.get(ref.messageId);
    if (!current) throw new Error("workflow card is missing");
    this.edits += 1;
    this.contents.push(content);
    this.messages.set(ref.messageId, { ...current, text: content.text ?? "" });
  }
  async deleteMsg() {}
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
function source(): string {
  return `import { defineWorkflow } from "@lilac/workflow";
export default defineWorkflow({
  name: "integration-audit",
  description: "Exercise the complete workflow integration",
  input: {
    type: "object",
    required: ["target", "token"],
    properties: {
      target: { type: "string" },
      token: { type: "string", sensitive: true },
    },
  },
  resources: {
    agents: { maxConcurrent: 1, maxTotal: 1 },
    waits: [],
  },
  async run({ args, phase, agent }) {
    return phase("audit", () => agent("Inspect " + args.target, { profile: "explore", label: "integration audit" }));
  },
});
`;
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for workflow integration");
    // test-wait-justification: polls integration state produced by independently scheduled workflow and bus workers
    await Bun.sleep(10);
  }
}
describe("unified workflow integration", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });
  it("authors, validates, dispatches through the request bus, persists, and projects the terminal result", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-integration-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    await fs.mkdir(workspaceRoot);
    const store = new DurableWorkflowStore(path.join(root, "workflow.sqlite"));
    const bus = createLilacBus(new LiveRawBus());
    const adapter = new WorkflowCardAdapter();
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "integration-projector",
      coalesceMs: 5,
      minEditIntervalMs: 0,
    });
    const actionResolver = await startWorkflowActionResolver({
      bus,
      store,
      subscriptionId: "integration-actions",
    });
    const tool = new ProgrammaticWorkflow({
      dataDir,
      store,
      bus,
      progressCards: projector,
    });
    const requestIds: string[] = [];
    const requestResponder = await startResultForTest(
      bus.subscribeTopic(
        "cmd.request",
        { mode: "fanout", subscriptionId: "integration-agent", offset: { type: "now" } },
        async (message) => {
          if (
            message.type === lilacEventTypes.CmdRequestMessage &&
            message.data.queue === "prompt"
          ) {
            const requestId = message.headers?.request_id;
            const sessionId = message.headers?.session_id;
            if (!requestId || !sessionId) throw new Error("workflow request missing identity");
            const workflow = z
              .object({
                workflow: z.strictObject({
                  runId: z.string(),
                  operationId: z.string(),
                  dispatchEpoch: z.string(),
                }),
              })
              .parse(message.data.raw).workflow;
            expect(
              store.authorizeWorkflowRequest({
                requestId,
                sessionId,
                platform: "unknown",
              })?.policy,
            ).toMatchObject(workflow);
            expect(
              store.claimWorkflowRequest({
                requestId,
                dispatchEpoch: workflow.dispatchEpoch,
                ownerId: "integration-agent",
                now: 100,
              }),
            ).toBe(true);
            requestIds.push(requestId);
            await bus.publish(
              lilacEventTypes.EvtRequestLifecycleChanged,
              { state: "running" },
              { headers: message.headers },
            );
            await bus.publish(
              lilacEventTypes.EvtAgentOutputResponseText,
              {
                finalText: "integration result",
                usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
              },
              { headers: message.headers },
            );
            expect(
              store.recordWorkflowRequestTerminal({
                requestId,
                runId: workflow.runId,
                operationId: workflow.operationId,
                dispatchEpoch: workflow.dispatchEpoch,
                ownerId: "integration-agent",
                state: "resolved",
                output: "integration result",
                usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
                now: 100,
              }),
            ).toBe(true);
            await bus.publish(
              lilacEventTypes.EvtRequestLifecycleChanged,
              { state: "resolved" },
              { headers: message.headers },
            );
          }
          return okResultForTest();
        },
        () => "commit",
      ),
    );
    const engine = new WorkflowEngine({
      bus,
      store,
      dataDir,
      subscriptionId: "integration-engine",
      pollMs: 5,
      now: () => 100,
    });
    const context = {
      requestId: "discord:channel-1:origin-1",
      sessionId: "channel-1",
      requestClient: "discord",
      cwd: workspaceRoot,
      projectRoot: workspaceRoot,
      safetyMode: "trusted" as const,
      serverOwnedRequest: true,
      authenticatedPrincipal: { platform: "discord" as const, userId: "user-1" },
      toolCallId: "integration-tool-1",
    };
    try {
      await projector.start();
      await tool.init();
      await tool.call(
        "workflow.definition.save",
        { scope: "project", name: "integration-audit", source: source() },
        { context },
      );
      await tool.call(
        "workflow.definition.validate",
        {
          scope: "auto",
          name: "integration-audit",
          args: { target: "src", token: "super-secret-value" },
        },
        { context },
      );
      const triggered = await tool.call(
        "workflow.run.trigger",
        {
          scope: "auto",
          name: "integration-audit",
          args: { target: "src", token: "super-secret-value" },
          progress: { requestOrigin: true },
        },
        { context },
      );
      const { runId } = z.object({ runId: z.string() }).parse(triggered);
      expect(workflowStoreValue(store.getRun(runId))?.state).toBe("queued");
      expect(adapter.contents[0]?.actions?.map((action) => action.label)).toEqual([
        "Pause",
        "Cancel",
      ]);
      expect(JSON.stringify(adapter.contents)).not.toContain("super-secret-value");
      await engine.start();
      expect(
        ["queued", "running", "succeeded"].includes(
          workflowStoreValue(store.getRun(runId))?.state ?? "",
        ),
      ).toBe(true);
      await waitFor(() => workflowStoreValue(store.getRun(runId))?.state === "succeeded");
      await waitFor(() =>
        adapter.contents.some((content) => content.text?.includes("**Succeeded**")),
      );
      const run = workflowStoreValue(store.getRun(runId));
      const operations = workflowStoreValue(store.listOperations(runId));
      const agentOperation = operations.find((operation) => operation.kind === "agent");
      expect(run).toMatchObject({
        result: "integration result",
        terminalDetail: "Workflow completed",
      });
      expect(operations.map((operation) => operation.kind).sort()).toEqual(["agent", "phase"]);
      expect(agentOperation).toMatchObject({
        state: "succeeded",
        output: "integration result",
        usage: { totalTokens: 11 },
      });
      expect(requestIds).toHaveLength(1);
      expect(agentOperation?.requestId).toBe(requestIds[0]);
      expect(requestIds[0]).toMatch(/^wfr:/u);
      expect(adapter.contents.at(-1)?.text).not.toContain("integration result");
      expect(adapter.contents.at(-1)?.actions).toEqual([]);
      expect(JSON.stringify(adapter.contents)).not.toContain("super-secret-value");
    } finally {
      await engine.stop();
      await stopResultForTest(requestResponder.stop());
      await actionResolver.stop();
      await projector.stop();
      await tool.destroy();
      await bus.close();
      store.close();
    }
  }, 20000);
  it("hard-restarts an active execution and recovers its journal plus existing surface binding", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-hard-restart-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    const dbPath = path.join(root, "workflow.sqlite");
    await fs.mkdir(workspaceRoot);
    let store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new LiveRawBus());
    const adapter = new WorkflowCardAdapter();
    const context = {
      requestId: "discord:channel-1:origin-1",
      sessionId: "channel-1",
      requestClient: "discord",
      cwd: workspaceRoot,
      projectRoot: workspaceRoot,
      safetyMode: "trusted" as const,
      serverOwnedRequest: true,
      authenticatedPrincipal: { platform: "discord" as const, userId: "user-1" },
      toolCallId: "restart-tool-1",
    };
    const firstProjector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "restart-projector-first",
      coalesceMs: 5,
      minEditIntervalMs: 0,
    });
    const tool = new ProgrammaticWorkflow({
      dataDir,
      store,
      bus,
      progressCards: firstProjector,
    });
    await tool.init();
    await firstProjector.start();
    await tool.call(
      "workflow.definition.save",
      { scope: "project", name: "integration-audit", source: source() },
      { context },
    );
    const triggered = await tool.call(
      "workflow.run.trigger",
      {
        scope: "auto",
        name: "integration-audit",
        args: { target: "restart", token: "restart-secret" },
      },
      { context },
    );
    const { runId } = z.object({ runId: z.string() }).parse(triggered);
    const firstBinding = workflowStoreValue(store.getSurfaceBinding(runId))?.messageRef;
    const firstEngine = new WorkflowEngine({
      bus,
      store,
      dataDir,
      subscriptionId: "restart-engine-first",
      pollMs: 5,
      now: () => 100,
      dispatchAgentRequest: async ({ signal }) => {
        return await new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ state: "cancelled", output: "", detail: "core stopped", usage: null }),
            { once: true },
          );
        });
      },
    });
    let restartedEngine: WorkflowEngine | null = null;
    let restartedProjector: WorkflowProgressProjector | null = null;
    try {
      await firstEngine.start();
      await waitFor(
        () => workflowStoreValue(store.listOperations(runId, { state: "dispatched" })).length === 1,
      );
      const persistedRequestId = workflowStoreValue(store.listOperations(runId)).find(
        (operation) => operation.kind === "agent",
      )?.requestId;
      if (!persistedRequestId) throw new Error("active operation did not persist its request ID");
      await firstEngine.stop();
      await firstProjector.stop();
      await tool.destroy();
      store.close();
      store = new DurableWorkflowStore(dbPath);
      restartedProjector = createWorkflowProgressProjectorForTest({
        bus,
        store,
        adapters: new Map([["discord", adapter]]),
        subscriptionId: "restart-projector-second",
        coalesceMs: 5,
        minEditIntervalMs: 0,
      });
      await restartedProjector.start();
      expect(workflowStoreValue(store.getSurfaceBinding(runId))?.messageRef).toEqual(firstBinding);
      expect(adapter.sends).toBe(1);
      let reconciled = false;
      restartedEngine = new WorkflowEngine({
        bus,
        store,
        dataDir,
        subscriptionId: "restart-engine-second",
        pollMs: 5,
        now: () => 60101,
        dispatchAgentRequest: async ({ requestId, reconcile }) => {
          expect(requestId).toBe(persistedRequestId);
          reconciled = reconcile;
          return { state: "resolved", output: "recovered result", detail: null, usage: null };
        },
      });
      await restartedEngine.start();
      await waitFor(() => workflowStoreValue(store.getRun(runId))?.state === "succeeded");
      await waitFor(() =>
        adapter.contents.some((content) => content.text?.includes("**Succeeded**")),
      );
      expect(reconciled).toBe(true);
      expect(
        workflowStoreValue(store.listOperations(runId))
          .map((operation) => operation.kind)
          .sort(),
      ).toEqual(["agent", "phase"]);
      expect(workflowStoreValue(store.getRun(runId))?.result).toBe("recovered result");
      expect(JSON.stringify(adapter.contents)).not.toContain("restart-secret");
      await restartedEngine.stop();
      await restartedProjector.stop();
    } finally {
      await restartedEngine?.stop();
      await restartedProjector?.stop();
      await firstEngine.stop();
      await firstProjector.stop();
      await tool.destroy();
      await bus.close();
      store.close();
    }
  }, 15000);
});
