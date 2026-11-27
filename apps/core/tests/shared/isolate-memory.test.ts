import { afterEach, describe, expect, it } from "bun:test";

import {
  createIsolateMemoryCollector,
  decodeIsolateMemoryMessage,
  installIsolateMemoryResponder,
  type IsolateMemoryChannel,
  type IsolateMemoryMessage,
} from "../../src/shared/isolate-memory";

type Bus = {
  readonly open: () => IsolateMemoryChannel;
  readonly closed: () => number;
};

/** In-memory BroadcastChannel: a message reaches every other open endpoint, never the sender. */
function createBus(): Bus {
  const endpoints = new Set<{ listener?: (message: IsolateMemoryMessage) => void }>();
  let closed = 0;
  return {
    open: () => {
      const endpoint: { listener?: (message: IsolateMemoryMessage) => void } = {};
      endpoints.add(endpoint);
      return {
        postMessage: (message) => {
          for (const other of endpoints) {
            if (other !== endpoint) queueMicrotask(() => other.listener?.(message));
          }
        },
        onMessage: (listener) => {
          endpoint.listener = listener;
        },
        close: () => {
          endpoints.delete(endpoint);
          closed += 1;
        },
      };
    },
    closed: () => closed,
  };
}

/** A worker endpoint that only answers while `answering` is true. */
function installSwitchableWorker(bus: Bus, role: string, isolateId: string) {
  const state = { answering: true };
  const channel = bus.open();
  const gated: IsolateMemoryChannel = {
    postMessage: (message) => {
      if (state.answering) channel.postMessage(message);
    },
    onMessage: (listener) => channel.onMessage(listener),
    close: () => channel.close(),
  };
  installIsolateMemoryResponder(role, gated, isolateId);
  return state;
}

describe("isolate memory messages", () => {
  it("decodes requests and reports and rejects anything else", () => {
    expect(
      decodeIsolateMemoryMessage({ type: "isolate-memory.request", id: "r1" }).isOk(),
    ).toBeTrue();
    expect(
      decodeIsolateMemoryMessage({
        type: "isolate-memory.report",
        id: "r1",
        isolateId: "w1",
        role: "thread-search",
        heap: { heapUsed: 1, heapTotal: 2, external: 3, arrayBuffers: 4 },
      }).isOk(),
    ).toBeTrue();
    expect(decodeIsolateMemoryMessage({ type: "isolate-memory.request" }).isErr()).toBeTrue();
    expect(
      decodeIsolateMemoryMessage({ type: "isolate-memory.request", id: "r1", extra: true }).isErr(),
    ).toBeTrue();
    expect(decodeIsolateMemoryMessage("probe").isErr()).toBeTrue();
  });
});

describe("isolate memory collector", () => {
  it("reports every worker by role and its own heap counters", async () => {
    const bus = createBus();
    installSwitchableWorker(bus, "thread-search", "search-1");
    installSwitchableWorker(bus, "thread-materializer", "materializer-1");
    const collector = createIsolateMemoryCollector({ channel: bus.open(), timeoutMs: 50 });

    const round = await collector.collect();

    expect(round.unresponsive).toEqual([]);
    expect(round.workers.map((worker) => [worker.role, worker.isolateId])).toEqual([
      ["thread-materializer", "materializer-1"],
      ["thread-search", "search-1"],
    ]);
    for (const worker of round.workers) {
      expect(worker.heapUsed).toBeGreaterThan(0);
      expect(worker.heapTotal).toBeGreaterThanOrEqual(worker.heapUsed);
      expect(worker).not.toHaveProperty("rss");
    }
    collector.close();
  });

  it("marks a known worker that stops answering, then forgets it after repeated misses", async () => {
    const bus = createBus();
    installSwitchableWorker(bus, "thread-search", "search-1");
    const stalled = installSwitchableWorker(bus, "thread-summarization", "summary-1");
    const collector = createIsolateMemoryCollector({
      channel: bus.open(),
      timeoutMs: 20,
      maxMissedRounds: 2,
    });
    expect((await collector.collect()).workers).toHaveLength(2);

    stalled.answering = false;
    const missedOnce = await collector.collect();
    expect(missedOnce.workers.map((worker) => worker.isolateId)).toEqual(["search-1"]);
    expect(missedOnce.unresponsive).toEqual([
      { role: "thread-summarization", isolateId: "summary-1", missedRounds: 1 },
    ]);

    const forgotten = await collector.collect();
    expect(forgotten.unresponsive).toEqual([]);
    expect(forgotten.workers.map((worker) => worker.isolateId)).toEqual(["search-1"]);
    collector.close();
  });

  it("ignores reports for other rounds and settles pending rounds on close", async () => {
    const bus = createBus();
    const collector = createIsolateMemoryCollector({ channel: bus.open(), timeoutMs: 60_000 });
    const stray = bus.open();
    const pending = collector.collect();
    stray.postMessage({
      type: "isolate-memory.report",
      id: "another-round",
      isolateId: "w1",
      role: "thread-search",
      heap: { heapUsed: 1, heapTotal: 1, external: 0, arrayBuffers: 0 },
    });

    collector.close();

    expect(await pending).toEqual({ workers: [], unresponsive: [] });
    expect(await collector.collect()).toEqual({ workers: [], unresponsive: [] });
    expect(bus.closed()).toBe(1);
  });
});

describe("isolate memory over a real Worker", () => {
  let worker: Worker | undefined;
  afterEach(() => {
    worker?.terminate();
    worker = undefined;
  });

  it("collects the worker's own heap through BroadcastChannel", async () => {
    worker = new Worker(new URL("./fixtures/isolate-memory-worker.ts", import.meta.url).href, {
      type: "module",
    });
    const ready = Promise.withResolvers<void>();
    worker.onmessage = () => ready.resolve();
    worker.postMessage("ping");
    await ready.promise;
    const collector = createIsolateMemoryCollector({ timeoutMs: 1_000 });

    const round = await collector.collect();

    const reported = round.workers.find((entry) => entry.role === "fixture-worker");
    expect(reported).toBeDefined();
    expect(reported!.heapUsed).toBeGreaterThan(0);
    expect(reported!.heapUsed).not.toBe(process.memoryUsage().heapUsed);
    collector.close();
  });
});
