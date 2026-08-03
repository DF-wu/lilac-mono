import { describe, expect, it } from "bun:test";
import { Result } from "better-result";

import {
  createLilacBus,
  lilacEventTypes,
  type FetchOptions,
  type Message,
  type PublishMessage,
  type PublishOptions,
  type RawBus,
  type RawDeliveryDependencies,
  type RawDeliveryHandler,
  type RawMessageDecodeOutcome,
  type SubscriptionOptions,
} from "../index";

class CapturingRawBus implements RawBus {
  lastMessage: Omit<Message<unknown>, "id" | "ts"> | null = null;

  async publish<TData>(
    message: PublishMessage<TData>,
    _options: PublishOptions,
  ): Promise<{ id: string; cursor: string }> {
    this.lastMessage = message;
    return { id: "1-0", cursor: "1-0" };
  }

  async subscribe(
    _topic: string,
    _options: SubscriptionOptions,
    _handler: RawDeliveryHandler,
    _dependencies?: RawDeliveryDependencies,
  ) {
    return Result.ok({
      done: Promise.resolve(Result.ok(undefined)),
      stop: async () => Result.ok(undefined),
    });
  }

  async fetch(
    _topic: string,
    _options: FetchOptions,
  ): Promise<{ messages: Array<{ msg: RawMessageDecodeOutcome; cursor: string }>; next?: string }> {
    return { messages: [] };
  }

  async close(): Promise<void> {}
}

describe("run-oriented workflow events", () => {
  it("routes bounded run and operation summaries by run ID", async () => {
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);

    await bus.publish(lilacEventTypes.EvtWorkflowRunChanged, {
      runId: "run-1",
      revisionId: "revision-1",
      state: "running",
      previousState: "queued",
      ts: 100,
    });
    expect(raw.lastMessage).toMatchObject({
      topic: "evt.workflow",
      type: "evt.workflow.run.changed",
      key: "run-1",
    });

    await bus.publish(lilacEventTypes.EvtWorkflowOperationChanged, {
      runId: "run-1",
      revisionId: "revision-1",
      operationId: "operation-1",
      kind: "agent",
      state: "succeeded",
      phase: "audit",
      label: "Inspect",
      ts: 110,
    });
    expect(raw.lastMessage).toMatchObject({
      topic: "evt.workflow",
      type: "evt.workflow.operation.changed",
      key: "run-1",
    });

    await bus.publish(lilacEventTypes.EvtWorkflowProgressRequested, {
      runId: "run-1",
      revisionId: "revision-1",
      reason: "operation_changed",
      ts: 120,
    });
    expect(raw.lastMessage?.key).toBe("run-1");

    await bus.publish(lilacEventTypes.EvtWorkflowUsageChanged, {
      runId: "run-1",
      revisionId: "revision-1",
      operationId: "operation-1",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, agentCount: 1, activeAgents: 0 },
      ts: 130,
    });
    expect(raw.lastMessage?.key).toBe("run-1");

    await bus.publish(lilacEventTypes.EvtWorkflowResultReady, {
      runId: "run-1",
      revisionId: "revision-1",
      state: "succeeded",
      summary: "Complete",
      ts: 140,
    });
    expect(raw.lastMessage?.key).toBe("run-1");
  });

  it("exports workflow progress event names", () => {
    expect(lilacEventTypes.EvtWorkflowProgressRequested).toBe("evt.workflow.progress.requested");
    expect(lilacEventTypes.EvtWorkflowUsageChanged).toBe("evt.workflow.usage.changed");
    expect(lilacEventTypes.EvtWorkflowResultReady).toBe("evt.workflow.result.ready");
  });

  it("routes authenticated opaque surface actions by action ID", async () => {
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    await bus.publish(lilacEventTypes.EvtAdapterActionInvoked, {
      actionId: "opaque-action-token-1234",
      platform: "discord",
      userId: "user-1",
      messageRef: { platform: "discord", channelId: "channel-1", messageId: "card-1" },
      ts: 100,
    });
    expect(raw.lastMessage).toMatchObject({
      topic: "evt.adapter",
      type: "evt.adapter.action.invoked",
      key: "opaque-action-token-1234",
    });

    await bus.publish(lilacEventTypes.EvtWorkflowWaitResolverBarrier, {
      barrierId: "workflow-wait-barrier-1234",
      ts: 101,
    });
    expect(raw.lastMessage).toMatchObject({
      topic: "evt.adapter",
      type: "evt.adapter.workflow-wait-resolver.barrier",
      key: "workflow-wait-barrier-1234",
    });
  });
});
