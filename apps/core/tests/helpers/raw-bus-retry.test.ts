import { describe, expect, it } from "bun:test";
import { Result } from "better-result";

import {
  createLilacBus,
  EventDeliveryStopped,
  EventDeliveryTransportFailed,
  lilacEventTypes,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";

import { createInMemoryDeliveryBus } from "./in-memory-delivery-bus";
import {
  subscribeForTest,
  type TestRawMessageHandler,
  type TestRawSubscriptionHost,
} from "./result-raw-bus";

const retry = {
  disposition: "retry" as const,
  failure: { kind: "handler-error" as const, errorTag: "TestFailure", errorMessage: "retry" },
};

const durableOptions: SubscriptionOptions = {
  mode: "work",
  subscriptionId: "raw-bus-retry-test",
};

const tailOptions: SubscriptionOptions = { mode: "tail", offset: { type: "now" } };

async function publish(raw: RawBus): Promise<void> {
  await raw.publish(
    { topic: "test.retry", type: "test.retry", data: {} },
    { topic: "test.retry", type: "test.retry" },
  );
}

describe("RawBus retry test helpers", () => {
  it("tracks absolute output replay expiry in the in-memory bus", async () => {
    const bus = createLilacBus(createInMemoryDeliveryBus());
    expect(await bus.getOutputStreamExpiry("missing-request")).toEqual(
      Result.ok({ kind: "absent" }),
    );

    const published = await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "hello", seq: 1 },
      { headers: { request_id: "output-expiry-request" } },
    );
    if (published.status === "error") throw published.error;
    const replayDeadline = published.value.replayDeadline;
    if (replayDeadline === undefined) throw new Error("Missing in-memory output replay deadline");

    expect(await bus.getOutputStreamExpiry("output-expiry-request")).toEqual(
      Result.ok({ kind: "present", expiresAt: replayDeadline }),
    );
  });

  it("redelivers durable in-memory delivery through the fifth attempt before failing explicitly", async () => {
    const raw = createInMemoryDeliveryBus();
    const attempts: number[] = [];
    const started = await raw.subscribe("test.retry", durableOptions, async (_message, context) => {
      if (context.mode !== "tail") attempts.push(context.attempt);
      return retry;
    });
    if (started.status === "error") throw started.error;

    await publish(raw);

    expect(attempts).toEqual([1, 2, 3, 4, 5]);
    const done = await started.value.done;
    expect(done.status).toBe("error");
    if (done.status === "error") expect(done.error).toBeInstanceOf(EventDeliveryTransportFailed);
  });

  it("stops tail in-memory delivery retries as tail-cannot-park", async () => {
    const raw = createInMemoryDeliveryBus();
    let calls = 0;
    const started = await raw.subscribe("test.retry", tailOptions, async () => {
      calls += 1;
      return retry;
    });
    if (started.status === "error") throw started.error;

    await publish(raw);

    expect(calls).toBe(1);
    const done = await started.value.done;
    expect(done.status).toBe("error");
    if (done.status === "error") {
      expect(done.error).toBeInstanceOf(EventDeliveryStopped);
      if (done.error instanceof EventDeliveryStopped)
        expect(done.error.reason).toBe("tail-cannot-park");
    }
  });

  it("redelivers durable result-raw-bus delivery and records every retry action", async () => {
    const raw = new TestRawBus();
    const attempts: number[] = [];
    const started = await raw.subscribe("test.retry", durableOptions, async (_message, context) => {
      if (context.mode !== "tail") attempts.push(context.attempt);
      return retry;
    });
    if (started.status === "error") throw started.error;

    await raw.deliver();

    expect(attempts).toEqual([1, 2, 3, 4, 5]);
    expect(raw.actions).toEqual(["retry", "retry", "retry", "retry", "retry"]);
    const done = await started.value.done;
    expect(done.status).toBe("error");
    if (done.status === "error") expect(done.error).toBeInstanceOf(EventDeliveryTransportFailed);
  });

  it("stops tail result-raw-bus retries as tail-cannot-park", async () => {
    const raw = new TestRawBus();
    let calls = 0;
    const started = await raw.subscribe("test.retry", tailOptions, async () => {
      calls += 1;
      return retry;
    });
    if (started.status === "error") throw started.error;

    await raw.deliver();

    expect(calls).toBe(1);
    const done = await started.value.done;
    expect(done.status).toBe("error");
    if (done.status === "error") {
      expect(done.error).toBeInstanceOf(EventDeliveryStopped);
      if (done.error instanceof EventDeliveryStopped)
        expect(done.error.reason).toBe("tail-cannot-park");
    }
  });
});

class TestRawBus implements RawBus, TestRawSubscriptionHost {
  readonly subscribe = subscribeForTest;
  readonly actions: string[] = [];
  private handler: TestRawMessageHandler | null = null;

  async publish<TData>(
    _message: Omit<Message<TData>, "id" | "ts">,
    _options: PublishOptions,
  ): Promise<{ id: string; cursor: string }> {
    return { id: "unused", cursor: "unused" };
  }

  async openTestSubscription(
    _topic: string,
    _options: SubscriptionOptions,
    handler: TestRawMessageHandler,
  ) {
    this.handler = handler;
    return { stop: async () => {} };
  }

  async deliver(): Promise<void> {
    await this.handler?.(
      { topic: "test.retry", id: "test-retry-1", type: "test.retry", ts: 0, data: {} },
      "test-retry-1",
    );
  }

  onTestDeliveryAction(action: { readonly disposition: string }): void {
    this.actions.push(action.disposition);
  }

  async fetch() {
    return { messages: [] };
  }

  async close(): Promise<void> {}
}
