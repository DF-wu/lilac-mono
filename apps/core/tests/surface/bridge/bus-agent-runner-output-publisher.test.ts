import { describe, expect, it } from "bun:test";
import {
  createLilacBus,
  lilacEventTypes,
  type HandleContext,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";

import {
  AGENT_OUTPUT_FLUSH_BYTES,
  AGENT_OUTPUT_FLUSH_INTERVAL_MS,
  createAgentOutputPublisher,
  type AgentOutputFlushScheduler,
} from "../../../src/surface/bridge/bus-agent-runner/output-publisher";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createRecordingRawBus(options?: {
  beforePublish?: (type: string) => Promise<void>;
  failTypes?: ReadonlySet<string>;
}): RawBus & { messages: Array<Message<unknown>> } {
  const messages: Array<Message<unknown>> = [];
  return {
    messages,
    publish: async <TData>(message: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
      await options?.beforePublish?.(opts.type);
      if (options?.failTypes?.has(opts.type)) throw new Error(`failed ${opts.type}`);
      const id = String(messages.length + 1);
      messages.push({
        ...message,
        id,
        ts: Date.now(),
        topic: opts.topic,
        type: opts.type,
        key: opts.key,
        headers: opts.headers,
      });
      return { id, cursor: id };
    },
    subscribe: async <TData>(
      _topic: string,
      _options: SubscriptionOptions,
      _handler: (message: Message<TData>, context: HandleContext) => Promise<void>,
    ) => ({ stop: async () => {} }),
    fetch: async () => ({ messages: [] }),
    watermark: async () => null,
    close: async () => {},
  };
}

function createManualScheduler() {
  const scheduled: Array<{ callback: () => void; cancelled: boolean; delayMs: number }> = [];
  const schedule: AgentOutputFlushScheduler = (callback, delayMs) => {
    const entry = { callback, cancelled: false, delayMs };
    scheduled.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return {
    schedule,
    scheduled,
    runNext: () => {
      const next = scheduled.find((entry) => !entry.cancelled);
      if (!next) throw new Error("no scheduled flush");
      next.cancelled = true;
      next.callback();
    },
  };
}

function createPublisher(
  raw: ReturnType<typeof createRecordingRawBus>,
  scheduleFlush?: AgentOutputFlushScheduler,
  onError?: (label: string, error: unknown) => void,
) {
  return createAgentOutputPublisher({
    bus: createLilacBus(raw),
    headers: {
      request_id: "request:coalescing",
      session_id: "session:coalescing",
      request_client: "unknown",
    },
    scheduleFlush,
    onError,
  });
}

describe("request-local agent output publisher", () => {
  it("flushes adjacent text after 40ms and reconstructs it exactly", async () => {
    const raw = createRecordingRawBus();
    const scheduler = createManualScheduler();
    const publisher = createPublisher(raw, scheduler.schedule);

    publisher.publishText("alpha ");
    publisher.publishText("beta\n");

    expect(raw.messages).toEqual([]);
    expect(scheduler.scheduled[0]?.delayMs).toBe(AGENT_OUTPUT_FLUSH_INTERVAL_MS);
    scheduler.runNext();
    await publisher.drain();

    expect(raw.messages).toHaveLength(1);
    expect(raw.messages[0]).toMatchObject({
      type: lilacEventTypes.EvtAgentOutputDeltaText,
      data: { delta: "alpha beta\n" },
    });
  });

  it("flushes at 4KiB and keeps a following tool barrier ordered behind text", async () => {
    const textPublishStarted = deferred<void>();
    const releaseTextPublish = deferred<void>();
    const raw = createRecordingRawBus({
      beforePublish: async (type) => {
        if (type !== lilacEventTypes.EvtAgentOutputDeltaText) return;
        textPublishStarted.resolve();
        await releaseTextPublish.promise;
      },
    });
    const publisher = createPublisher(raw);
    const text = "x".repeat(AGENT_OUTPUT_FLUSH_BYTES);

    publisher.publishText(text);
    const toolPublished = publisher.publishToolCall({
      toolCallId: "tool:1",
      status: "start",
      display: "read_file",
    });
    await textPublishStarted.promise;
    expect(raw.messages).toEqual([]);

    releaseTextPublish.resolve();
    await toolPublished;

    expect(raw.messages.map((message) => message.type)).toEqual([
      lilacEventTypes.EvtAgentOutputDeltaText,
      lilacEventTypes.EvtAgentOutputToolCall,
    ]);
    expect(raw.messages[0]?.data).toEqual({ delta: text });
  });

  it("uses the latest adjacent reasoning snapshot and preserves lane boundaries", async () => {
    const raw = createRecordingRawBus();
    const publisher = createPublisher(raw);

    await publisher.publishReasoningBoundary({ delta: "" });
    publisher.publishReasoningSnapshot({ delta: "first", seq: 1 }, Buffer.byteLength("first"));
    publisher.publishReasoningSnapshot(
      { delta: "first second", seq: 2 },
      Buffer.byteLength(" second"),
    );
    publisher.publishText("answer");
    await publisher.publishResponseText({ finalText: "answer" });

    expect(raw.messages.map((message) => ({ type: message.type, data: message.data }))).toEqual([
      { type: lilacEventTypes.EvtAgentOutputDeltaReasoning, data: { delta: "" } },
      {
        type: lilacEventTypes.EvtAgentOutputDeltaReasoning,
        data: { delta: "first second", seq: 2 },
      },
      { type: lilacEventTypes.EvtAgentOutputDeltaText, data: { delta: "answer" } },
      {
        type: lilacEventTypes.EvtAgentOutputResponseText,
        data: { finalText: "answer" },
      },
    ]);
  });

  it("counts new reasoning bytes after a cumulative snapshot crosses 4KiB", async () => {
    const raw = createRecordingRawBus();
    const publisher = createPublisher(raw);
    let snapshot = "x".repeat(AGENT_OUTPUT_FLUSH_BYTES - 1);

    publisher.publishReasoningSnapshot({ delta: snapshot, seq: 1 }, Buffer.byteLength(snapshot));
    snapshot += "x";
    publisher.publishReasoningSnapshot({ delta: snapshot, seq: 2 }, 1);

    const firstPublishedSnapshot = snapshot;
    const trailingDeltaCount = 128;
    for (let index = 0; index < trailingDeltaCount; index += 1) {
      snapshot += "y";
      publisher.publishReasoningSnapshot({ delta: snapshot, seq: index + 3 }, 1);
    }
    await publisher.drain();

    expect(raw.messages).toHaveLength(2);
    expect(raw.messages.map((message) => message.data)).toEqual([
      { delta: firstPublishedSnapshot, seq: 2 },
      { delta: snapshot, seq: trailingDeltaCount + 2 },
    ]);
    const publishedBytes = raw.messages.reduce((total, message) => {
      const data = message.data;
      if (
        typeof data !== "object" ||
        data === null ||
        !("delta" in data) ||
        typeof data.delta !== "string"
      ) {
        throw new Error("expected a reasoning snapshot");
      }
      return total + Buffer.byteLength(data.delta);
    }, 0);
    expect(publishedBytes).toBe(
      Buffer.byteLength(firstPublishedSnapshot) + Buffer.byteLength(snapshot),
    );
  });

  it("continues ordered publication after a best-effort failure", async () => {
    const errors: string[] = [];
    const raw = createRecordingRawBus({
      failTypes: new Set([lilacEventTypes.EvtAgentOutputDeltaText]),
    });
    const publisher = createPublisher(raw, undefined, (label) => errors.push(label));

    publisher.publishText("lost transport write");
    await publisher.publishToolCall({
      toolCallId: "tool:after-failure",
      status: "start",
      display: "grep",
    });

    expect(errors).toEqual(["text delta"]);
    expect(raw.messages).toHaveLength(1);
    expect(raw.messages[0]?.type).toBe(lilacEventTypes.EvtAgentOutputToolCall);
  });
});
