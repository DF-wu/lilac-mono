import { describe, expect, it, spyOn } from "bun:test";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import { Panic, Result, type Result as ResultType } from "better-result";

import {
  createLilacBus,
  EventDeliveryStartFailed,
  EventDeliveryStopped,
  EventDeliveryStopFailed,
  lilacEventTypes,
  type CmdRequestMessageData,
  type EventDeliveryDoneError,
  type Message,
  type PublishOptions,
  type RawDeliveryAction,
  type RawDeliveryHandler,
  type RawBus,
} from "@stanley2058/lilac-event-bus";

import {
  applyHeartbeatLifecycleDeliveryPolicy,
  HeartbeatLifecycleRequestIdMissing,
  HeartbeatLifecycleSessionIdMissing,
  startHeartbeatService,
} from "../../src/heartbeat/heartbeat-service";
import { getHeartbeatQuietState } from "../../src/heartbeat/common";
import { startResultForTest, stopResultForTest } from "../helpers/result-raw-bus";

function createInMemoryRawBus(options?: {
  onDeliveryAction?: (message: Message<unknown>, action: RawDeliveryAction) => void;
  startPanic?: Panic;
  startFailure?: EventDeliveryStartFailed;
  stopFailure?: EventDeliveryStopFailed;
  doneFailure?: EventDeliveryDoneError;
  stopPanic?: Panic;
}): RawBus {
  const topics = new Map<string, Array<Message<unknown>>>();
  const deliverySubs = new Set<{
    topic: string;
    mode: "work" | "fanout" | "tail";
    handler: RawDeliveryHandler;
  }>();

  return {
    publish: async <TData>(msg: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
      const id = `${Date.now()}-${Math.random()}`;
      const stored: Message<unknown> = {
        topic: opts.topic,
        id,
        type: opts.type,
        ts: Date.now(),
        key: opts.key,
        headers: opts.headers,
        data: msg.data,
      };

      const list = topics.get(opts.topic) ?? [];
      list.push(stored);
      topics.set(opts.topic, list);

      for (const sub of deliverySubs) {
        if (sub.topic !== opts.topic) continue;
        const action = await sub.handler(stored, {
          cursor: id,
          mode: sub.mode,
          evidence: {
            source: {
              transport: "redis-streams",
              streamKey: opts.topic,
              topic: opts.topic,
              messageId: id,
            },
            wire: { kind: "bounded-complete", fields: [] },
          },
        });
        options?.onDeliveryAction?.(stored, action);
      }

      return { id, cursor: id };
    },
    subscribe: async (topic, subscriptionOptions, handler) => {
      if (options?.startPanic) throw options.startPanic;
      if (options?.startFailure) return Result.err(options.startFailure);

      const done = Promise.withResolvers<ResultType<void, EventDeliveryDoneError>>();
      if (options?.doneFailure) done.resolve(Result.err(options.doneFailure));
      const entry = { topic, mode: subscriptionOptions.mode, handler };
      deliverySubs.add(entry);
      return Result.ok({
        done: done.promise,
        stop: async () => {
          deliverySubs.delete(entry);
          if (!options?.doneFailure) done.resolve(Result.ok(undefined));
          if (options?.stopPanic) throw options.stopPanic;
          if (options?.stopFailure) return Result.err(options.stopFailure);
          return Result.ok(undefined);
        },
      });
    },
    fetch: async (topic: string) => {
      const existing = topics.get(topic) ?? [];
      return {
        messages: existing.map((msg) => ({ msg, cursor: msg.id })),
        next: existing.at(-1)?.id,
      };
    },
    close: async () => {},
  };
}

function createFakeTimers() {
  let nextId = 1;
  const timeouts = new Map<number, { ms: number; fn: () => void }>();
  const intervals = new Map<number, { ms: number; fn: () => void }>();

  return {
    timeouts,
    intervals,
    timers: {
      setInterval(fn: () => void, ms: number) {
        const id = nextId++;
        intervals.set(id, { ms, fn });
        return id as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval(handle: ReturnType<typeof setInterval>) {
        intervals.delete(handle as unknown as number);
      },
      setTimeout(fn: () => void, ms: number) {
        const id = nextId++;
        timeouts.set(id, {
          ms,
          fn: () => {
            timeouts.delete(id);
            fn();
          },
        });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout(handle: ReturnType<typeof setTimeout>) {
        timeouts.delete(handle as unknown as number);
      },
    },
  };
}

function listTimeoutsMs(fakeTimers: ReturnType<typeof createFakeTimers>): number[] {
  return [...fakeTimers.timeouts.values()].map((entry) => entry.ms).sort((a, b) => a - b);
}

function createHeartbeatConfig(input?: {
  defaultOutputSession?: string;
  sessionModes?: Record<string, { model?: string }>;
}): CoreConfig {
  return {
    surface: {
      router: {
        defaultMode: "mention",
        sessionModes: input?.sessionModes ?? {},
        activeDebounceMs: 3000,
        activeGate: { enabled: false, timeoutMs: 2500 },
      },
      heartbeat: {
        enabled: true,
        cron: "*/30 * * * *",
        ...(input?.defaultOutputSession
          ? { defaultOutputSession: input.defaultOutputSession }
          : {}),
        quietAfterActivityMs: 300000,
        retryBusyMs: 60000,
      },
    },
  } as unknown as CoreConfig;
}

describe("heartbeat service", () => {
  it("falls back gracefully when quiet-hours timezone is invalid", () => {
    const quietState = getHeartbeatQuietState({
      nowMs: Date.UTC(2026, 2, 11, 10, 0, 0),
      quietHours: {
        start: "23:00",
        end: "08:00",
        timezone: "Asia/Taipai",
      },
    });

    expect(quietState.label).toBe("outside");
  });

  it("parks every owned lifecycle identifier error", () => {
    expect(
      applyHeartbeatLifecycleDeliveryPolicy(
        new HeartbeatLifecycleRequestIdMissing({ message: "request ID missing" }),
      ),
    ).toBe("park-pending");
    expect(
      applyHeartbeatLifecycleDeliveryPolicy(
        new HeartbeatLifecycleSessionIdMissing({ message: "session ID missing" }),
      ),
    ).toBe("park-pending");
  });

  it("commits unrelated and valid events while parking a lifecycle event without a session ID", async () => {
    const actions: RawDeliveryAction[] = [];
    const bus = createLilacBus(
      createInMemoryRawBus({
        onDeliveryAction: (_message, action) => actions.push(action),
      }),
    );
    const service = await startHeartbeatService({
      bus,
      subscriptionId: "hb-delivery-policy",
      config: createHeartbeatConfig(),
      now: () => Date.UTC(2026, 2, 11, 10, 0, 0),
    });

    await bus.publish(
      lilacEventTypes.EvtRequestReply,
      {},
      {
        headers: { request_id: "unrelated-request" },
      },
    );
    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "running" },
      { headers: { request_id: "valid-request", session_id: "discord-session" } },
    );
    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "running" },
      { headers: { request_id: "missing-session" } },
    );

    expect(actions.map((action) => action.disposition)).toEqual([
      "commit",
      "commit",
      "park-pending",
    ]);

    await service.stop();
  });

  it("adapts a typed lifecycle subscription start failure", async () => {
    const failure = new EventDeliveryStartFailed({
      cause: undefined,
      topic: "evt.request",
      message: "start unavailable",
    });
    const bus = createLilacBus(createInMemoryRawBus({ startFailure: failure }));

    await expect(
      startHeartbeatService({
        bus,
        subscriptionId: "hb-start-failure",
        config: createHeartbeatConfig(),
      }),
    ).rejects.toThrow("Heartbeat lifecycle subscription start failed: start unavailable");
  });

  it("adapts typed lifecycle subscription stop and done failures", async () => {
    const stopFailure = new EventDeliveryStopFailed({
      cause: undefined,
      topic: "evt.request",
      message: "cleanup unavailable",
    });
    const stopService = await startHeartbeatService({
      bus: createLilacBus(createInMemoryRawBus({ stopFailure })),
      subscriptionId: "hb-stop-failure",
      config: createHeartbeatConfig(),
    });
    await expect(stopService.stop()).rejects.toThrow(
      "Heartbeat lifecycle subscription stop failed: cleanup unavailable",
    );

    const doneFailure = new EventDeliveryStopped({
      reason: "requested",
      topic: "evt.request",
      cursor: "1-0",
      message: "delivery stopped",
    });
    const doneService = await startHeartbeatService({
      bus: createLilacBus(createInMemoryRawBus({ doneFailure })),
      subscriptionId: "hb-done-failure",
      config: createHeartbeatConfig(),
    });
    await expect(doneService.stop()).rejects.toThrow(
      "Heartbeat lifecycle subscription done failed: delivery stopped",
    );
  });

  it("preserves lifecycle cleanup precedence and Panic identity", async () => {
    const startPanic = new Panic({ message: "heartbeat startup invariant failed" });
    await expect(
      startHeartbeatService({
        bus: createLilacBus(createInMemoryRawBus({ startPanic })),
        subscriptionId: "hb-start-panic",
        config: createHeartbeatConfig(),
      }),
    ).rejects.toBe(startPanic);

    const stopFailure = new EventDeliveryStopFailed({
      cause: undefined,
      topic: "evt.request",
      message: "stop wins",
    });
    const doneFailure = new EventDeliveryStopped({
      reason: "requested",
      topic: "evt.request",
      cursor: "1-0",
      message: "done loses",
    });
    const precedenceService = await startHeartbeatService({
      bus: createLilacBus(createInMemoryRawBus({ stopFailure, doneFailure })),
      subscriptionId: "hb-cleanup-precedence",
      config: createHeartbeatConfig(),
    });
    await expect(precedenceService.stop()).rejects.toThrow(
      "Heartbeat lifecycle subscription stop failed: stop wins",
    );

    const panic = new Panic({ message: "heartbeat cleanup invariant failed" });
    const panicService = await startHeartbeatService({
      bus: createLilacBus(createInMemoryRawBus({ stopPanic: panic })),
      subscriptionId: "hb-cleanup-panic",
      config: createHeartbeatConfig(),
    });
    await expect(panicService.stop()).rejects.toBe(panic);
  });

  it("propagates Panic from lifecycle event handling", async () => {
    const panic = new Panic({ message: "lifecycle invariant failed" });
    const bus = createLilacBus(createInMemoryRawBus());
    const service = await startHeartbeatService({
      bus,
      subscriptionId: "hb-handler-panic",
      config: createHeartbeatConfig(),
    });
    const originalAdd = Set.prototype.add;
    const addSpy = spyOn(Set.prototype, "add").mockImplementation(function <T>(
      this: Set<T>,
      value: T,
    ): Set<T> {
      if (value === "panic-request") throw panic;
      return originalAdd.call(this, value);
    });

    try {
      await expect(
        bus.publish(
          lilacEventTypes.EvtRequestLifecycleChanged,
          { state: "running" },
          { headers: { request_id: "panic-request", session_id: "discord-session" } },
        ),
      ).rejects.toBe(panic);
    } finally {
      addSpy.mockRestore();
      await service.stop();
    }
  });

  it("schedules the next heartbeat wake from the cron expression", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const fakeTimers = createFakeTimers();
    const service = await startHeartbeatService({
      bus,
      subscriptionId: "hb-test",
      config: createHeartbeatConfig(),
      now: () => Date.UTC(2026, 2, 11, 10, 5, 0),
      timers: fakeTimers.timers,
    });

    expect(listTimeoutsMs(fakeTimers)).toEqual([25 * 60 * 1000]);

    await service.stop();
  });

  it("publishes an internal heartbeat request when idle", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const requests: Array<Message<CmdRequestMessageData>> = [];

    const sub = await startResultForTest(
      bus.subscribeTopic(
        "cmd.request",
        {
          mode: "fanout",
          subscriptionId: "hb-test-requests",
          consumerId: "hb-test-requests",
          offset: { type: "begin" },
        },
        async (msg) => {
          if (msg.type === lilacEventTypes.CmdRequestMessage) {
            requests.push(msg);
          }
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    const cfg = {
      surface: {
        heartbeat: {
          enabled: true,
          cron: "*/30 * * * *",
          quietAfterActivityMs: 300000,
          retryBusyMs: 60000,
        },
      },
    } as unknown as CoreConfig;

    const service = await startHeartbeatService({
      bus,
      subscriptionId: "hb-test",
      config: cfg,
      now: () => Date.UTC(2026, 2, 11, 10, 0, 0),
    });

    await service.tick("interval");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers?.session_id).toBe("__heartbeat__");
    expect(requests[0]?.data.runPolicy).toBe("idle_only_global");
    expect(requests[0]?.data.origin).toEqual({ kind: "heartbeat", reason: "interval" });
    expect(requests[0]?.data.messages[0]).toEqual({
      role: "user",
      content: expect.stringContaining("Last observed activity: none recorded."),
    });
    expect(String(requests[0]?.data.messages[0]?.content)).toContain(
      "Normal assistant output is discarded.",
    );
    expect(String(requests[0]?.data.messages[0]?.content)).toContain(
      "Default proactive output session: none configured; do not guess a destination.",
    );
    expect(String(requests[0]?.data.messages[0]?.content)).toContain(
      "When you are done, reply exactly HEARTBEAT_OK.",
    );

    await service.stop();
    await stopResultForTest(sub.stop());
  });

  it("includes configured default output session in the heartbeat prompt", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const requests: Array<Message<CmdRequestMessageData>> = [];

    const sub = await startResultForTest(
      bus.subscribeTopic(
        "cmd.request",
        {
          mode: "fanout",
          subscriptionId: "hb-test-requests",
          consumerId: "hb-test-requests",
          offset: { type: "begin" },
        },
        async (msg) => {
          if (msg.type === lilacEventTypes.CmdRequestMessage) {
            requests.push(msg);
          }
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    const cfg = {
      surface: {
        heartbeat: {
          enabled: true,
          defaultOutputSession: "discord/ops",
          cron: "*/30 * * * *",
          quietAfterActivityMs: 300000,
          retryBusyMs: 60000,
        },
      },
    } as unknown as CoreConfig;

    const service = await startHeartbeatService({
      bus,
      subscriptionId: "hb-test",
      config: cfg,
      now: () => Date.UTC(2026, 2, 11, 10, 0, 0),
    });

    await service.tick("interval");

    expect(requests).toHaveLength(1);
    expect(String(requests[0]?.data.messages[0]?.content)).toContain(
      "Default proactive output target: client=discord, session=ops.",
    );

    await service.stop();
    await stopResultForTest(sub.stop());
  });

  it("uses the canonical heartbeat session model override when configured", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const requests: Array<Message<CmdRequestMessageData>> = [];

    const sub = await startResultForTest(
      bus.subscribeTopic(
        "cmd.request",
        {
          mode: "fanout",
          subscriptionId: "hb-test-requests",
          consumerId: "hb-test-requests",
          offset: { type: "begin" },
        },
        async (msg) => {
          if (msg.type === lilacEventTypes.CmdRequestMessage) {
            requests.push(msg);
          }
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    const service = await startHeartbeatService({
      bus,
      subscriptionId: "hb-test",
      config: createHeartbeatConfig({
        sessionModes: {
          __heartbeat__: {
            model: "sonnet",
          },
        },
      }),
      now: () => Date.UTC(2026, 2, 11, 10, 0, 0),
    });

    await service.tick("interval");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.data.modelOverride).toBe("sonnet");

    await service.stop();
    await stopResultForTest(sub.stop());
  });

  it("uses the heartbeat alias model override when canonical key is absent", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const requests: Array<Message<CmdRequestMessageData>> = [];

    const sub = await startResultForTest(
      bus.subscribeTopic(
        "cmd.request",
        {
          mode: "fanout",
          subscriptionId: "hb-test-requests",
          consumerId: "hb-test-requests",
          offset: { type: "begin" },
        },
        async (msg) => {
          if (msg.type === lilacEventTypes.CmdRequestMessage) {
            requests.push(msg);
          }
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    const service = await startHeartbeatService({
      bus,
      subscriptionId: "hb-test",
      config: createHeartbeatConfig({
        sessionModes: {
          heartbeat: {
            model: "haiku",
          },
        },
      }),
      now: () => Date.UTC(2026, 2, 11, 10, 0, 0),
    });

    await service.tick("interval");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.data.modelOverride).toBe("haiku");

    await service.stop();
    await stopResultForTest(sub.stop());
  });

  it("prefers the canonical heartbeat key over the alias", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const requests: Array<Message<CmdRequestMessageData>> = [];

    const sub = await startResultForTest(
      bus.subscribeTopic(
        "cmd.request",
        {
          mode: "fanout",
          subscriptionId: "hb-test-requests",
          consumerId: "hb-test-requests",
          offset: { type: "begin" },
        },
        async (msg) => {
          if (msg.type === lilacEventTypes.CmdRequestMessage) {
            requests.push(msg);
          }
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    const service = await startHeartbeatService({
      bus,
      subscriptionId: "hb-test",
      config: createHeartbeatConfig({
        sessionModes: {
          __heartbeat__: {
            model: "sonnet",
          },
          heartbeat: {
            model: "haiku",
          },
        },
      }),
      now: () => Date.UTC(2026, 2, 11, 10, 0, 0),
    });

    await service.tick("interval");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.data.modelOverride).toBe("sonnet");

    await service.stop();
    await stopResultForTest(sub.stop());
  });

  it("suppresses while busy and retries later", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const requests: Array<Message<CmdRequestMessageData>> = [];
    const fakeTimers = createFakeTimers();
    let nowMs = Date.UTC(2026, 2, 11, 10, 0, 0);

    const sub = await startResultForTest(
      bus.subscribeTopic(
        "cmd.request",
        {
          mode: "fanout",
          subscriptionId: "hb-test-requests",
          consumerId: "hb-test-requests",
          offset: { type: "begin" },
        },
        async (msg) => {
          if (msg.type === lilacEventTypes.CmdRequestMessage) {
            requests.push(msg);
          }
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    const cfg = {
      surface: {
        heartbeat: {
          enabled: true,
          cron: "*/30 * * * *",
          quietAfterActivityMs: 300000,
          retryBusyMs: 60000,
        },
      },
    } as unknown as CoreConfig;

    const service = await startHeartbeatService({
      bus,
      subscriptionId: "hb-test",
      config: cfg,
      now: () => nowMs,
      timers: fakeTimers.timers,
    });

    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "running", ts: nowMs },
      {
        headers: {
          request_id: "req:1",
          session_id: "discord-session",
          request_client: "discord",
        },
      },
    );

    await service.tick("interval");

    expect(requests).toHaveLength(0);
    expect(listTimeoutsMs(fakeTimers)).toEqual([60000, 30 * 60 * 1000]);

    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "resolved", ts: nowMs },
      {
        headers: {
          request_id: "req:1",
          session_id: "discord-session",
          request_client: "discord",
        },
      },
    );

    nowMs += 300001;
    const retry = [...fakeTimers.timeouts.values()].find((entry) => entry.ms === 60000);
    retry?.fn();
    await Promise.resolve();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.data.origin).toEqual({ kind: "heartbeat", reason: "retry" });
    expect(String(requests[0]?.data.messages[0]?.content)).toContain(
      "Last observed activity: 2026-03-11T10:00:00.000Z (5m ago).",
    );

    await service.stop();
    await stopResultForTest(sub.stop());
  });

  it("treats restored active external requests as busy until lifecycle settles", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const requests: Array<Message<CmdRequestMessageData>> = [];
    const fakeTimers = createFakeTimers();
    let nowMs = Date.UTC(2026, 2, 11, 10, 0, 0);

    const sub = await startResultForTest(
      bus.subscribeTopic(
        "cmd.request",
        {
          mode: "fanout",
          subscriptionId: "hb-test-requests",
          consumerId: "hb-test-requests",
          offset: { type: "begin" },
        },
        async (msg) => {
          if (msg.type === lilacEventTypes.CmdRequestMessage) {
            requests.push(msg);
          }
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    const cfg = {
      surface: {
        heartbeat: {
          enabled: true,
          cron: "*/30 * * * *",
          quietAfterActivityMs: 300000,
          retryBusyMs: 60000,
        },
      },
    } as unknown as CoreConfig;

    const service = await startHeartbeatService({
      bus,
      subscriptionId: "hb-test",
      config: cfg,
      initialExternalState: {
        activeRequestIds: ["restored:req"],
      },
      now: () => nowMs,
      timers: fakeTimers.timers,
    });

    await service.tick("interval");

    expect(requests).toHaveLength(0);
    expect(listTimeoutsMs(fakeTimers)).toEqual([60000, 30 * 60 * 1000]);

    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "resolved", ts: nowMs },
      {
        headers: {
          request_id: "restored:req",
          session_id: "discord-session",
          request_client: "discord",
        },
      },
    );

    nowMs += 300001;
    const retry = [...fakeTimers.timeouts.values()].find((entry) => entry.ms === 60000);
    retry?.fn();
    await Promise.resolve();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.data.origin).toEqual({ kind: "heartbeat", reason: "retry" });

    await service.stop();
    await stopResultForTest(sub.stop());
  });

  it("coalesces concurrent ticks into a single heartbeat request", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const requests: Array<Message<CmdRequestMessageData>> = [];
    const fakeTimers = createFakeTimers();

    const sub = await startResultForTest(
      bus.subscribeTopic(
        "cmd.request",
        {
          mode: "fanout",
          subscriptionId: "hb-test-requests",
          consumerId: "hb-test-requests",
          offset: { type: "begin" },
        },
        async (msg) => {
          if (msg.type === lilacEventTypes.CmdRequestMessage) {
            requests.push(msg);
          }
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    const cfg = {
      surface: {
        heartbeat: {
          enabled: true,
          cron: "*/30 * * * *",
          quietAfterActivityMs: 300000,
          retryBusyMs: 60000,
        },
      },
    } as unknown as CoreConfig;

    const service = await startHeartbeatService({
      bus,
      subscriptionId: "hb-test",
      config: cfg,
      now: () => Date.UTC(2026, 2, 11, 10, 0, 0),
      timers: fakeTimers.timers,
    });

    const [first, second] = await Promise.all([service.tick("interval"), service.tick("retry")]);
    void first;
    void second;

    expect(requests).toHaveLength(1);

    await service.stop();
    await stopResultForTest(sub.stop());
  });
});
