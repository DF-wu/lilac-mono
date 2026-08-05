import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";

import Redis from "ioredis";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { env } from "@stanley2058/lilac-utils";

import {
  EventDeadLetterAcceptFailed,
  RedisEventDeadLetterAuthenticationFailed,
  RedisEventDeadLetterCiphertextInvalid,
  RedisEventDeadLetterConfigInvalid,
  RedisEventDeadLetterContextMismatch,
  createLilacBus,
  createRedisEventDeadLetter,
  createRedisStreamsBus,
  decryptRedisEventDeadLetterRecord,
  decryptRedisEventDeadLetterRecoveryValue,
  encryptRedisEventDeadLetterRecoveryValue,
  lilacEventTypes,
  validateRedisEventDeadLetterConfig,
  type DeliveryDisposition,
  type EventDeadLetter,
  type EventDeadLetterAcceptance,
  type EventDeadLetterRecordV1,
} from "../index";

const TEST_REDIS_URL = env.redisUrl || "redis://127.0.0.1:6379";
const TEST_DEAD_LETTER_KEY = Buffer.alloc(32, 0x42);

class HandlerFailure extends TaggedError("HandlerFailure")<{
  readonly message: string;
}> {}

class CapturingDeadLetter implements EventDeadLetter {
  readonly records: EventDeadLetterRecordV1[] = [];

  constructor(
    private readonly acceptResult: (
      record: EventDeadLetterRecordV1,
    ) => Promise<ResultType<EventDeadLetterAcceptance, EventDeadLetterAcceptFailed>>,
  ) {}

  async accept(record: EventDeadLetterRecordV1) {
    this.records.push(record);
    return await this.acceptResult(record);
  }
}

function randomId(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function eventually<T>(
  operation: () => Promise<T>,
  predicate: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = await operation();
    if (predicate(value)) return value;
  }
  throw new Error("Observable Redis state did not converge before the test deadline");
}

async function pendingIds(
  redis: Redis,
  streamKey: string,
  group: string,
): Promise<readonly string[]> {
  const pending = (await redis.xpending(streamKey, group, "-", "+", 10)) as unknown;
  if (!Array.isArray(pending)) return [];
  return pending.flatMap((entry) => {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") return [];
    return [entry[0]];
  });
}

function redisFields(fields: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const key = fields[index];
    const value = fields[index + 1];
    if (key !== undefined && value !== undefined) result[key] = value;
  }
  return result;
}

async function publishRequest(
  bus: ReturnType<typeof createLilacBus>,
  requestId: string,
): Promise<string> {
  const published = await bus.publish(
    lilacEventTypes.CmdRequestMessage,
    { queue: "prompt", messages: [{ role: "user", content: "deliver" }] },
    { headers: { request_id: requestId } },
  );
  if (published.status === "error") throw published.error;
  return published.value.id;
}

function deadLetterRecordFixture(): EventDeadLetterRecordV1 {
  const topic = "cmd.request";
  const cursor = "1-0";
  return {
    version: 1,
    deadLetterId: "dead-letter-1",
    recordedAt: 1,
    source: { topic, cursor, messageId: cursor, mode: "work" },
    reason: {
      kind: "contract-invalid",
      diagnostic: "event_bus.contract_invalid",
      stage: "payload",
      issues: ["invalid payload"],
    },
    evidence: {
      source: {
        transport: "redis-streams",
        streamKey: "event-bus:cmd.request",
        topic,
        messageId: cursor,
      },
      wire: {
        kind: "bounded-complete",
        fields: ["type", "cmd.request.message"],
      },
    },
  };
}

function referencedDeadLetterRecordFixture(): EventDeadLetterRecordV1 {
  const record = deadLetterRecordFixture();
  return {
    ...record,
    evidence: {
      source: record.evidence.source,
      wire: {
        kind: "controlled-reference",
        locator: {
          kind: "redis-stream-entry",
          streamKey: record.evidence.source.streamKey,
          messageId: record.source.messageId,
        },
        preview: { fields: [], omittedValueCount: 0 },
      },
    },
  };
}

describe("result-based event delivery", () => {
  it("rejects malformed XRANGE evidence before starting a dead-letter transaction", async () => {
    const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    let xrangeResponse: unknown = [];
    let transactionCalls = 0;
    Reflect.set(redis, "xrange", async () => xrangeResponse);
    Reflect.set(redis, "multi", () => {
      transactionCalls += 1;
      throw new Error("unexpected dead-letter transaction");
    });
    const deadLetter = createRedisEventDeadLetter({
      redis,
      encryptionKey: TEST_DEAD_LETTER_KEY,
    });
    const malformedResponses: readonly unknown[] = [
      [],
      [
        ["1-0", ["type", "cmd.request.message"]],
        ["1-0", ["type", "cmd.request.message"]],
      ],
      [["2-0", ["type", "cmd.request.message"]]],
      [["1-0"]],
      [["1-0", "not-fields"]],
      [["1-0", ["type"]]],
      [["1-0", ["type", 42]]],
    ];

    for (const malformed of malformedResponses) {
      xrangeResponse = malformed;
      const accepted = await deadLetter.accept(referencedDeadLetterRecordFixture());
      expect(accepted.status).toBe("error");
      if (accepted.status === "error") {
        expect(accepted.error._tag).toBe("EventDeadLetterAcceptFailed");
      }
    }
    expect(transactionCalls).toBe(0);
    redis.disconnect();
  });

  it("rejects inconsistent source evidence identity before XRANGE or transaction", async () => {
    const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    let xrangeCalls = 0;
    let transactionCalls = 0;
    Reflect.set(redis, "xrange", async () => {
      xrangeCalls += 1;
      return [["1-0", ["type", "cmd.request.message"]]];
    });
    Reflect.set(redis, "multi", () => {
      transactionCalls += 1;
      throw new Error("unexpected dead-letter transaction");
    });
    const deadLetter = createRedisEventDeadLetter({
      redis,
      encryptionKey: TEST_DEAD_LETTER_KEY,
    });
    const record = referencedDeadLetterRecordFixture();
    const inconsistent: EventDeadLetterRecordV1 = {
      ...record,
      source: { ...record.source, messageId: "2-0" },
    };

    const accepted = await deadLetter.accept(inconsistent);
    expect(accepted.status).toBe("error");
    expect(xrangeCalls).toBe(0);
    expect(transactionCalls).toBe(0);
    redis.disconnect();
  });

  it("rejects truncated, bad SET, extra, and malformed XADD dead-letter transaction receipts", async () => {
    const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    let receipts: unknown = null;
    const transaction = {
      set: () => transaction,
      xadd: () => transaction,
      exec: async () => receipts,
    };
    Reflect.set(redis, "multi", () => transaction);
    const deadLetter = createRedisEventDeadLetter({
      redis,
      encryptionKey: TEST_DEAD_LETTER_KEY,
    });
    const malformedReceipts: readonly unknown[] = [
      [[null, "OK"]],
      [
        [null, "NOT_OK"],
        [null, "1-0"],
      ],
      [
        [null, "OK"],
        [null, "OK"],
        [null, "1-0"],
      ],
      [
        [null, "OK"],
        [null, "invalid-id"],
      ],
    ];

    for (const malformed of malformedReceipts) {
      receipts = malformed;
      const accepted = await deadLetter.accept(deadLetterRecordFixture());
      expect(accepted.status).toBe("error");
      if (accepted.status === "error") {
        expect(accepted.error._tag).toBe("EventDeadLetterAcceptFailed");
      }
    }

    Reflect.set(redis, "xrange", async () => [["1-0", ["type", "cmd.request.message"]]]);
    const referenced = referencedDeadLetterRecordFixture();
    receipts = [
      [null, "OK"],
      [null, "1-0"],
    ];
    const truncatedReferenced = await deadLetter.accept(referenced);
    expect(truncatedReferenced.status).toBe("error");
    redis.disconnect();
  });

  it("validates Redis dead-letter configuration as a Result before constructor signaling", () => {
    expect(
      validateRedisEventDeadLetterConfig({
        recordTtlSeconds: 60,
        indexMaxLen: 100,
        encryptionKey: TEST_DEAD_LETTER_KEY,
      }),
    ).toEqual(
      Result.ok({
        recordTtlSeconds: 60,
        indexMaxLen: 100,
        encryptionKey: TEST_DEAD_LETTER_KEY,
      }),
    );

    for (const invalid of [0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const validated = validateRedisEventDeadLetterConfig({
        recordTtlSeconds: invalid,
        indexMaxLen: 100,
        encryptionKey: TEST_DEAD_LETTER_KEY,
      });
      expect(validated.status).toBe("error");
      if (validated.status === "error") {
        expect(validated.error).toBeInstanceOf(RedisEventDeadLetterConfigInvalid);
        expect(validated.error.option).toBe("recordTtlSeconds");
      }
    }

    const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    expect(() =>
      createRedisEventDeadLetter({
        redis,
        encryptionKey: TEST_DEAD_LETTER_KEY,
        recordTtlSeconds: 60,
        indexMaxLen: 0,
      }),
    ).toThrow(RedisEventDeadLetterConfigInvalid);
    expect(() => createRedisEventDeadLetter({ redis, encryptionKey: Buffer.alloc(31) })).toThrow(
      RedisEventDeadLetterConfigInvalid,
    );
    redis.disconnect();
  });

  for (const disposition of ["commit", "park-pending", "stop", "dead-letter"] as const) {
    it(`owns the ${disposition} action in durable mode`, async () => {
      const redis = new Redis(TEST_REDIS_URL);
      const keyPrefix = `test:lilac-delivery:${randomId(disposition)}`;
      const streamKey = `${keyPrefix}:cmd.request`;
      const group = `group-${disposition}`;
      let sourceWasPendingAtAcceptance = false;
      const deadLetter = new CapturingDeadLetter(async (record) => {
        const pending = await pendingIds(redis, streamKey, group);
        sourceWasPendingAtAcceptance = pending.includes(record.source.messageId);
        return Result.ok({ id: `dead-${record.deadLetterId}` });
      });
      const raw = createRedisStreamsBus({ redis, keyPrefix });
      const bus = createLilacBus(raw, { deadLetter });
      const handled = Promise.withResolvers<void>();
      const started = await bus.subscribeTopic(
        "cmd.request",
        {
          mode: "work",
          subscriptionId: group,
          consumerId: "consumer",
          offset: { type: "begin" },
          batch: { maxWaitMs: 50 },
        },
        async () => {
          handled.resolve();
          return Result.err(new HandlerFailure({ message: "expected handler failure" }));
        },
        (): DeliveryDisposition => disposition,
      );
      if (started.status === "error") throw started.error;

      try {
        const messageId = await publishRequest(bus, randomId("request"));
        await handled.promise;
        if (disposition === "stop") {
          const done = await started.value.done;
          expect(done.status).toBe("error");
          if (done.status === "error" && done.error._tag === "EventDeliveryStopped") {
            expect(done.error.reason).toBe("requested");
          }
        }

        const expectedPending = disposition === "commit" || disposition === "dead-letter" ? 0 : 1;
        const pending = await eventually(
          () => pendingIds(redis, streamKey, group),
          (entries) => entries.length === expectedPending,
        );
        if (expectedPending === 1) expect(pending[0]).toBe(messageId);
        expect(deadLetter.records).toHaveLength(disposition === "dead-letter" ? 1 : 0);
        if (disposition === "dead-letter") expect(sourceWasPendingAtAcceptance).toBe(true);
      } finally {
        await started.value.stop();
        await redis.del(streamKey);
        await bus.close();
        await redis.quit();
      }
    });
  }

  it("parks durable delivery when dead-letter acceptance fails", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-delivery:${randomId("dead-fail-durable")}`;
    const streamKey = `${keyPrefix}:cmd.request`;
    const group = "dead-letter-failure";
    const deadLetter = new CapturingDeadLetter(async () =>
      Result.err(
        new EventDeadLetterAcceptFailed({ cause: undefined, message: "dead-letter unavailable" }),
      ),
    );
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const bus = createLilacBus(raw, { deadLetter });
    const handled = Promise.withResolvers<void>();
    const started = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "work",
        subscriptionId: group,
        offset: { type: "begin" },
        batch: { maxWaitMs: 50 },
      },
      async () => {
        handled.resolve();
        return Result.err(new HandlerFailure({ message: "reject" }));
      },
      () => "dead-letter",
    );
    if (started.status === "error") throw started.error;
    try {
      const id = await publishRequest(bus, randomId("request"));
      await handled.promise;
      const pending = await eventually(
        () => pendingIds(redis, streamKey, group),
        (entries) => entries.length === 1,
      );
      expect(pending[0]).toBe(id);
    } finally {
      await started.value.stop();
      await redis.del(streamKey);
      await bus.close();
      await redis.quit();
    }
  });

  it("does not transact or acknowledge when Redis dead-letter XRANGE evidence is malformed", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const originalDuplicate = redis.duplicate.bind(redis);
    const originalXrange = redis.xrange.bind(redis);
    const originalMulti = redis.multi.bind(redis);
    let xackCalls = 0;
    let transactionCalls = 0;
    Reflect.set(redis, "duplicate", () => {
      const duplicate = originalDuplicate();
      Reflect.set(duplicate, "xack", async () => {
        xackCalls += 1;
        return 1;
      });
      return duplicate;
    });
    Reflect.set(redis, "xrange", async () => [["0-0", ["type", "unknown.event"]]]);
    Reflect.set(redis, "multi", () => {
      transactionCalls += 1;
      return originalMulti();
    });

    const keyPrefix = `test:lilac-delivery:${randomId("dead-evidence-invalid")}`;
    const streamKey = `${keyPrefix}:cmd.request`;
    const group = "dead-evidence-invalid";
    const acceptance =
      Promise.withResolvers<ResultType<EventDeadLetterAcceptance, EventDeadLetterAcceptFailed>>();
    const redisDeadLetter = createRedisEventDeadLetter({
      redis,
      encryptionKey: TEST_DEAD_LETTER_KEY,
      keyPrefix: `${keyPrefix}:dead`,
    });
    const deadLetter: EventDeadLetter = {
      async accept(record) {
        const accepted = await redisDeadLetter.accept(record);
        acceptance.resolve(accepted);
        return accepted;
      },
    };
    const raw = createRedisStreamsBus({ redis, keyPrefix, subscriberPool: { max: 1 } });
    const bus = createLilacBus(raw, { deadLetter });
    const started = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "work",
        subscriptionId: group,
        consumerId: "consumer",
        offset: { type: "begin" },
        batch: { maxWaitMs: 50 },
      },
      async () => Result.ok(undefined),
      () => "commit",
    );
    if (started.status === "error") throw started.error;
    let stopped = false;
    try {
      const messageId = await redis.xadd(
        streamKey,
        "*",
        "type",
        "unknown.event",
        "ts",
        "1",
        "data",
        "x".repeat(2_000),
      );
      if (typeof messageId !== "string") throw new Error("Redis did not return a message id");
      const accepted = await acceptance.promise;
      expect(accepted.status).toBe("error");
      const stopResult = await started.value.stop();
      stopped = true;
      expect(stopResult.status).toBe("ok");
      expect(transactionCalls).toBe(0);
      expect(xackCalls).toBe(0);
      expect(await pendingIds(redis, streamKey, group)).toEqual([messageId]);
    } finally {
      if (!stopped) await started.value.stop().catch(() => undefined);
      Reflect.set(redis, "duplicate", originalDuplicate);
      Reflect.set(redis, "xrange", originalXrange);
      Reflect.set(redis, "multi", originalMulti);
      await redis.del(streamKey);
      await bus.close();
      await redis.quit();
    }
  });

  it("applies every disposition in tail mode", async () => {
    for (const disposition of ["commit", "park-pending", "stop", "dead-letter"] as const) {
      const redis = new Redis(TEST_REDIS_URL);
      const keyPrefix = `test:lilac-delivery:${randomId(`tail-${disposition}`)}`;
      const deadLetter = new CapturingDeadLetter(async (record) =>
        Result.ok({ id: `dead-${record.deadLetterId}` }),
      );
      const raw = createRedisStreamsBus({ redis, keyPrefix });
      const bus = createLilacBus(raw, { deadLetter });
      const firstId = await publishRequest(bus, randomId("request"));
      const secondId = await publishRequest(bus, randomId("request"));
      const seen: string[] = [];
      const advanced = Promise.withResolvers<void>();
      const started = await bus.subscribeTopic(
        "cmd.request",
        { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 50 } },
        async (message) => {
          seen.push(message.id);
          if (seen.length === 2) advanced.resolve();
          return Result.err(new HandlerFailure({ message: "policy fixture" }));
        },
        (): DeliveryDisposition => disposition,
      );
      if (started.status === "error") throw started.error;

      try {
        if (disposition === "commit" || disposition === "dead-letter") {
          await advanced.promise;
          expect(seen).toEqual([firstId, secondId]);
          if (disposition === "dead-letter") {
            await eventually(
              async () => deadLetter.records.length,
              (recordCount) => recordCount === 2,
            );
            expect(deadLetter.records).toHaveLength(2);
          } else {
            expect(deadLetter.records).toHaveLength(0);
          }
        } else {
          const done = await started.value.done;
          expect(done.status).toBe("error");
          if (done.status === "error" && done.error._tag === "EventDeliveryStopped") {
            expect(done.error.reason).toBe(
              disposition === "park-pending" ? "tail-cannot-park" : "requested",
            );
          }
          expect(seen).toEqual([firstId]);
        }
      } finally {
        await started.value.stop();
        await redis.del(`${keyPrefix}:cmd.request`);
        await bus.close();
        await redis.quit();
      }
    }
  });

  it("stops tail delivery on dead-letter failure without advancing its cursor", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-delivery:${randomId("tail-stop")}`;
    const streamKey = `${keyPrefix}:cmd.request`;
    const deadLetter = new CapturingDeadLetter(async () =>
      Result.err(
        new EventDeadLetterAcceptFailed({ cause: undefined, message: "dead-letter unavailable" }),
      ),
    );
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const bus = createLilacBus(raw, { deadLetter });
    const firstId = await publishRequest(bus, randomId("request"));

    const seen: string[] = [];
    const subscribe = () =>
      bus.subscribeTopic(
        "cmd.request",
        { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 50 } },
        async (message) => {
          seen.push(message.id);
          return Result.err(new HandlerFailure({ message: "reject" }));
        },
        () => "dead-letter",
      );

    const first = await subscribe();
    if (first.status === "error") throw first.error;
    const firstDone = await first.value.done;
    expect(firstDone.status).toBe("error");
    if (firstDone.status === "error" && firstDone.error._tag === "EventDeliveryStopped") {
      expect(firstDone.error.reason).toBe("dead-letter-failed");
    }

    const second = await subscribe();
    if (second.status === "error") throw second.error;
    const secondDone = await second.value.done;
    expect(secondDone.status).toBe("error");
    expect(seen).toEqual([firstId, firstId]);

    await first.value.stop();
    await second.value.stop();
    await redis.del(streamKey);
    await bus.close();
    await redis.quit();
  });

  it("reports rejected handlers and Panic as defects while stopping the loop", async () => {
    for (const cause of [new Error("rejected handler"), new Panic({ message: "handler panic" })]) {
      const redis = new Redis(TEST_REDIS_URL);
      const keyPrefix = `test:lilac-delivery:${randomId("defect")}`;
      const reported: unknown[] = [];
      const raw = createRedisStreamsBus({ redis, keyPrefix });
      const bus = createLilacBus(raw, {
        reportFatal: {
          report: (fatal) => {
            reported.push(fatal);
          },
        },
      });
      const started = await bus.subscribeTopic(
        "cmd.request",
        { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 50 } },
        async () => {
          throw cause;
        },
        () => "commit",
      );
      if (started.status === "error") throw started.error;
      try {
        await publishRequest(bus, randomId("request"));
        await expect(started.value.done).rejects.toBe(cause);
        expect(reported).toEqual([cause]);
      } finally {
        await started.value.stop().catch(() => undefined);
        await redis.del(`${keyPrefix}:cmd.request`);
        await bus.close();
        await redis.quit();
      }
    }
  });

  it("treats a broken handler Result as a reported defect", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-delivery:${randomId("broken-result")}`;
    const reported: unknown[] = [];
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const bus = createLilacBus(raw, {
      reportFatal: { report: (cause) => void reported.push(cause) },
    });
    const started = await bus.subscribeTopic(
      "cmd.request",
      { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 50 } },
      async () => {
        const broken = Result.ok(undefined);
        Reflect.set(broken, "status", "broken");
        return broken;
      },
      () => "commit",
    );
    if (started.status === "error") throw started.error;
    try {
      await publishRequest(bus, randomId("request"));
      await expect(started.value.done).rejects.toBeInstanceOf(Panic);
      expect(reported).toHaveLength(1);
      expect(Panic.is(reported[0])).toBe(true);
    } finally {
      await started.value.stop().catch(() => undefined);
      await redis.del(`${keyPrefix}:cmd.request`);
      await bus.close();
      await redis.quit();
    }
  });

  const malformedResults: ReadonlyArray<[string, () => ResultType<void, HandlerFailure>]> = [
    [
      "forged prototype",
      () => {
        const result = Result.ok(undefined);
        Object.setPrototypeOf(result, Object.prototype);
        return result;
      },
    ],
    [
      "missing Ok value",
      () => {
        const result = Result.ok(undefined);
        Reflect.deleteProperty(result, "value");
        return result;
      },
    ],
    [
      "non-undefined Ok value",
      () => {
        const result = Result.ok(undefined);
        Reflect.set(result, "value", "forged");
        return result;
      },
    ],
    [
      "missing Err error",
      () => {
        const result = Result.err(new HandlerFailure({ message: "missing" }));
        Reflect.deleteProperty(result, "error");
        return result;
      },
    ],
    [
      "invalid Err status",
      () => {
        const result = Result.err(new HandlerFailure({ message: "invalid status" }));
        Reflect.set(result, "status", "ok");
        return result;
      },
    ],
    [
      "non-tagged Err error",
      () => {
        const result = Result.err(new HandlerFailure({ message: "replaced" }));
        Reflect.set(result, "error", new Error("not owned"));
        return result;
      },
    ],
    [
      "incomplete tagged Err error",
      () => {
        const result = Result.err(new HandlerFailure({ message: "incomplete" }));
        Reflect.deleteProperty(result.error, "message");
        return result;
      },
    ],
    [
      "Panic Err error",
      () => {
        const result = Result.err(new HandlerFailure({ message: "replaced" }));
        Reflect.set(result, "error", new Panic({ message: "not an expected handler error" }));
        return result;
      },
    ],
    [
      "revoked Result",
      () => {
        const { proxy, revoke } = Proxy.revocable(Result.ok(undefined), {});
        revoke();
        return proxy;
      },
    ],
  ];

  for (const [label, malformedResult] of malformedResults) {
    it(`reports ${label} handler Result and preserves its pending entry`, async () => {
      const redis = new Redis(TEST_REDIS_URL);
      const keyPrefix = `test:lilac-delivery:${randomId(`handler-${label}`)}`;
      const streamKey = `${keyPrefix}:cmd.request`;
      const group = "malformed-handler";
      const reported = Promise.withResolvers<unknown>();
      const raw = createRedisStreamsBus({ redis, keyPrefix });
      const bus = createLilacBus(raw, {
        reportFatal: { report: (cause) => reported.resolve(cause) },
      });
      const started = await bus.subscribeTopic(
        "cmd.request",
        {
          mode: "work",
          subscriptionId: group,
          consumerId: "consumer",
          offset: { type: "begin" },
          batch: { maxWaitMs: 50 },
        },
        async () => malformedResult(),
        () => "commit",
      );
      if (started.status === "error") throw started.error;
      try {
        const id = await publishRequest(bus, randomId("request"));
        await reported.promise;
        await expect(started.value.done).rejects.toBeDefined();
        expect(await pendingIds(redis, streamKey, group)).toEqual([id]);
      } finally {
        await started.value.stop().catch(() => undefined);
        await redis.del(streamKey);
        await bus.close();
        await redis.quit();
      }
    });
  }

  const malformedAcceptances: ReadonlyArray<
    [string, () => Promise<ResultType<EventDeadLetterAcceptance, EventDeadLetterAcceptFailed>>]
  > = [
    [
      "forged prototype",
      async () => {
        const result = Result.ok({ id: "forged" });
        Object.setPrototypeOf(result, Object.prototype);
        return result;
      },
    ],
    [
      "missing Ok receipt",
      async () => {
        const result = Result.ok({ id: "missing" });
        Reflect.deleteProperty(result, "value");
        return result;
      },
    ],
    [
      "non-object receipt",
      async () => {
        const result = Result.ok({ id: "replaced" });
        Reflect.set(result, "value", null);
        return result;
      },
    ],
    [
      "missing receipt id",
      async () => {
        const result = Result.ok({ id: "missing" });
        Reflect.deleteProperty(result.value, "id");
        return result;
      },
    ],
    ["empty receipt id", async () => Result.ok({ id: "" })],
    [
      "revoked receipt",
      async () => {
        const result = Result.ok({ id: "revoked" });
        const { proxy, revoke } = Proxy.revocable(result.value, {});
        Reflect.set(result, "value", proxy);
        revoke();
        return result;
      },
    ],
    [
      "missing Err error",
      async () => {
        const result = Result.err(
          new EventDeadLetterAcceptFailed({ cause: undefined, message: "missing" }),
        );
        Reflect.deleteProperty(result, "error");
        return result;
      },
    ],
    [
      "invalid Err status",
      async () => {
        const result = Result.err(
          new EventDeadLetterAcceptFailed({ cause: undefined, message: "invalid status" }),
        );
        Reflect.set(result, "status", "ok");
        return result;
      },
    ],
    [
      "foreign Err error",
      async () => {
        const result = Result.err(
          new EventDeadLetterAcceptFailed({ cause: undefined, message: "replaced" }),
        );
        Reflect.set(result, "error", new HandlerFailure({ message: "foreign" }));
        return result;
      },
    ],
    [
      "Panic Err error",
      async () => {
        const result = Result.err(
          new EventDeadLetterAcceptFailed({ cause: undefined, message: "replaced" }),
        );
        Reflect.set(result, "error", new Panic({ message: "dead-letter panic payload" }));
        return result;
      },
    ],
    [
      "revoked Result",
      async () => {
        const { proxy, revoke } = Proxy.revocable(Result.ok({ id: "revoked" }), {});
        revoke();
        return proxy;
      },
    ],
    [
      "thrown Panic",
      async () => {
        throw new Panic({ message: "dead-letter adapter panic" });
      },
    ],
  ];

  for (const [label, malformedAcceptance] of malformedAcceptances) {
    it(`reports ${label} dead-letter acceptance and preserves its pending entry`, async () => {
      const redis = new Redis(TEST_REDIS_URL);
      const keyPrefix = `test:lilac-delivery:${randomId(`dead-${label}`)}`;
      const streamKey = `${keyPrefix}:cmd.request`;
      const group = "malformed-dead-letter";
      const reported = Promise.withResolvers<unknown>();
      const deadLetter = new CapturingDeadLetter(malformedAcceptance);
      const raw = createRedisStreamsBus({ redis, keyPrefix });
      const bus = createLilacBus(raw, {
        deadLetter,
        reportFatal: { report: (cause) => reported.resolve(cause) },
      });
      const started = await bus.subscribeTopic(
        "cmd.request",
        {
          mode: "work",
          subscriptionId: group,
          consumerId: "consumer",
          offset: { type: "begin" },
          batch: { maxWaitMs: 50 },
        },
        async () => Result.err(new HandlerFailure({ message: "dead-letter" })),
        () => "dead-letter",
      );
      if (started.status === "error") throw started.error;
      try {
        const id = await publishRequest(bus, randomId("request"));
        await reported.promise;
        await expect(started.value.done).rejects.toBeDefined();
        expect(await pendingIds(redis, streamKey, group)).toEqual([id]);
      } finally {
        await started.value.stop().catch(() => undefined);
        await redis.del(streamKey);
        await bus.close();
        await redis.quit();
      }
    });
  }

  it("treats XACK zero as an ack transport failure without trimming", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const originalDuplicate = redis.duplicate.bind(redis);
    Reflect.set(redis, "duplicate", () => {
      const duplicate = originalDuplicate();
      Reflect.set(duplicate, "xack", async () => 0);
      return duplicate;
    });
    const keyPrefix = `test:lilac-delivery:${randomId("xack-zero")}`;
    const streamKey = `${keyPrefix}:cmd.request`;
    const group = "xack-zero";
    const raw = createRedisStreamsBus({ redis, keyPrefix, subscriberPool: { max: 1 } });
    const bus = createLilacBus(raw);
    const started = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "work",
        subscriptionId: group,
        consumerId: "consumer",
        offset: { type: "begin" },
        batch: { maxWaitMs: 50 },
      },
      async () => Result.ok(undefined),
      () => "commit",
    );
    if (started.status === "error") throw started.error;
    try {
      const id = await publishRequest(bus, randomId("request"));
      const done = await started.value.done;
      expect(done.status).toBe("error");
      if (done.status === "error" && done.error._tag === "EventDeliveryTransportFailed") {
        expect(done.error.operation).toBe("ack");
      }
      expect(await pendingIds(redis, streamKey, group)).toEqual([id]);
      await raw.flushPendingTrims();
      expect(await redis.xlen(streamKey)).toBe(1);
    } finally {
      await started.value.stop();
      Reflect.set(redis, "duplicate", originalDuplicate);
      await redis.del(streamKey);
      await bus.close();
      await redis.quit();
    }
  });

  it("treats a malformed XACK response as an ack transport failure", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const originalDuplicate = redis.duplicate.bind(redis);
    Reflect.set(redis, "duplicate", () => {
      const duplicate = originalDuplicate();
      Reflect.set(duplicate, "xack", async () => "1");
      return duplicate;
    });
    const keyPrefix = `test:lilac-delivery:${randomId("xack-malformed")}`;
    const streamKey = `${keyPrefix}:cmd.request`;
    const group = "xack-malformed";
    const raw = createRedisStreamsBus({ redis, keyPrefix, subscriberPool: { max: 1 } });
    const bus = createLilacBus(raw);
    const started = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "work",
        subscriptionId: group,
        consumerId: "consumer",
        offset: { type: "begin" },
        batch: { maxWaitMs: 50 },
      },
      async () => Result.ok(undefined),
      () => "commit",
    );
    if (started.status === "error") throw started.error;
    try {
      const id = await publishRequest(bus, randomId("request"));
      const done = await started.value.done;
      expect(done.status).toBe("error");
      if (done.status === "error" && done.error._tag === "EventDeliveryTransportFailed") {
        expect(done.error.operation).toBe("ack");
      }
      expect(await pendingIds(redis, streamKey, group)).toEqual([id]);
    } finally {
      await started.value.stop();
      Reflect.set(redis, "duplicate", originalDuplicate);
      await redis.del(streamKey);
      await bus.close();
      await redis.quit();
    }
  });

  it("captures subscription transport rejection as a done Result", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const originalDuplicate = redis.duplicate.bind(redis);
    Reflect.set(redis, "duplicate", () => {
      const duplicate = originalDuplicate();
      Reflect.set(duplicate, "xread", async () => {
        throw new Error("forced transport failure");
      });
      return duplicate;
    });
    const raw = createRedisStreamsBus({
      redis,
      keyPrefix: `test:lilac-delivery:${randomId("transport")}`,
      subscriberPool: { max: 1 },
    });
    const started = await raw.subscribe(
      "topic",
      { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 50 } },
      async () => ({ disposition: "commit" }),
    );
    if (started.status === "error") throw started.error;
    const done = await started.value.done;
    expect(done.status).toBe("error");
    if (done.status === "error") expect(done.error._tag).toBe("EventDeliveryTransportFailed");
    Reflect.set(redis, "duplicate", originalDuplicate);
    await started.value.stop();
    await raw.close();
    await redis.quit();
  });

  it("keeps complete records and evidence encrypted in expiring keys", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-delivery:${randomId("redis-dead-letter")}`;
    const deadLetterPrefix = `${keyPrefix}:dead`;
    const streamKey = `${keyPrefix}:cmd.request`;
    const group = "invalid-contract";
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const bus = createLilacBus(raw, {
      deadLetter: createRedisEventDeadLetter({
        redis,
        encryptionKey: TEST_DEAD_LETTER_KEY,
        keyPrefix: deadLetterPrefix,
        recordTtlSeconds: 60,
        indexMaxLen: 2,
      }),
    });
    const started = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "work",
        subscriptionId: group,
        offset: { type: "begin" },
        batch: { maxWaitMs: 50 },
      },
      async () => Result.ok(undefined),
      () => "commit",
    );
    if (started.status === "error") throw started.error;
    try {
      const secretSentinel = `dead-letter-secret-${randomId("sentinel")}`;
      const id = await redis.xadd(
        streamKey,
        "*",
        "type",
        "unknown.event",
        "ts",
        "1",
        "data",
        secretSentinel.repeat(100),
      );
      if (typeof id !== "string") throw new Error("Redis did not return an entry id");
      await eventually(
        () => pendingIds(redis, streamKey, group),
        (pending) => pending.length === 0,
      );
      const records = await eventually(
        () => redis.xrange(`${deadLetterPrefix}:records`, "-", "+"),
        (entries) => entries.length === 1,
      );
      const indexFields = records[0]?.[1];
      if (!indexFields) throw new Error("Dead-letter index metadata is missing");
      const index = redisFields(indexFields);
      expect(index.reason).toBe("contract-invalid");
      expect(index.recordKey?.startsWith(`${deadLetterPrefix}:record:`)).toBe(true);
      expect(JSON.stringify(indexFields)).not.toContain(secretSentinel);
      expect(indexFields).not.toContain("record");
      const recordKey = index.recordKey;
      if (!recordKey) throw new Error("Dead-letter record locator is missing");
      const deadLetterId = index.deadLetterId;
      if (!deadLetterId) throw new Error("Dead-letter identity is missing");
      const recordTtl = await redis.ttl(recordKey);
      expect(recordTtl).toBeGreaterThan(0);
      expect(recordTtl).toBeLessThanOrEqual(60);
      const encodedRecord = await redis.get(recordKey);
      if (encodedRecord === null) throw new Error("Dead-letter record is missing");
      expect(encodedRecord).not.toContain(secretSentinel);
      const recovered = decryptRedisEventDeadLetterRecord({
        encryptionKey: TEST_DEAD_LETTER_KEY,
        expectedIdentity: { deadLetterId, storageKey: recordKey },
        ciphertextEnvelope: encodedRecord,
      });
      if (recovered.status === "error") throw recovered.error;
      expect(recovered.value.evidence.wire.kind).toBe("controlled-reference");
      const wire = recovered.value.evidence.wire;
      if (wire.kind === "controlled-reference" && wire.locator.kind === "redis-key") {
        const evidenceKey = wire.locator.key;
        expect(await redis.exists(evidenceKey)).toBe(1);
        const evidenceTtl = await redis.ttl(evidenceKey);
        expect(evidenceTtl).toBeGreaterThan(0);
        expect(evidenceTtl).toBeLessThanOrEqual(60);
        const encryptedEvidence = await redis.get(evidenceKey);
        expect(encryptedEvidence).not.toBeNull();
        expect(encryptedEvidence).not.toContain(secretSentinel);
        await redis.del(evidenceKey);
      }
      await redis.del(recordKey);
    } finally {
      await started.value.stop();
      await redis.del(streamKey, `${deadLetterPrefix}:records`);
      await bus.close();
      await redis.quit();
    }
  });

  it("bounds the payload-free dead-letter index while retaining complete records by TTL", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const deadLetterPrefix = `test:lilac-delivery:${randomId("bounded-dead-index")}`;
    const deadLetter = createRedisEventDeadLetter({
      redis,
      encryptionKey: TEST_DEAD_LETTER_KEY,
      keyPrefix: deadLetterPrefix,
      recordTtlSeconds: 60,
      indexMaxLen: 2,
    });
    const recordKeys: string[] = [];
    const sourceRecords: EventDeadLetterRecordV1[] = [];
    try {
      for (let index = 0; index < 5; index += 1) {
        const deadLetterId = `dead-letter-${index}`;
        const recordKey = `${deadLetterPrefix}:record:${deadLetterId}`;
        recordKeys.push(recordKey);
        const record: EventDeadLetterRecordV1 = {
          version: 1,
          deadLetterId,
          recordedAt: Date.now(),
          source: {
            topic: "test.topic",
            cursor: `${index}-0`,
            messageId: `${index}-0`,
            mode: "work",
          },
          reason: {
            kind: "handler-error",
            errorTag: "HandlerFailure",
            errorMessage: `private-error-${index}`,
          },
          evidence: {
            source: {
              transport: "redis-streams",
              streamKey: "private-source-stream",
              topic: "test.topic",
              messageId: `${index}-0`,
            },
            wire: {
              kind: "bounded-complete",
              fields: ["data", `private-payload-${index}`],
            },
          },
        };
        sourceRecords.push(record);
        const accepted = await deadLetter.accept(record);
        expect(accepted.status).toBe("ok");
      }

      const indexEntries = await redis.xrange(`${deadLetterPrefix}:records`, "-", "+");
      expect(indexEntries).toHaveLength(2);
      expect(JSON.stringify(indexEntries)).not.toContain("private-payload");
      expect(JSON.stringify(indexEntries)).not.toContain("private-error");
      for (const recordKey of recordKeys) {
        expect(recordKey.startsWith(`${deadLetterPrefix}:record:`)).toBe(true);
        expect(await redis.exists(recordKey)).toBe(1);
        const ttl = await redis.ttl(recordKey);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(60);
      }
      for (const [index, recordKey] of recordKeys.entries()) {
        const encrypted = await redis.get(recordKey);
        if (encrypted === null) throw new Error("Encrypted dead-letter record is missing");
        expect(encrypted).not.toContain("private-payload");
        expect(encrypted).not.toContain("private-error");
        const recovered = decryptRedisEventDeadLetterRecord({
          encryptionKey: TEST_DEAD_LETTER_KEY,
          expectedIdentity: {
            deadLetterId: sourceRecords[index]!.deadLetterId,
            storageKey: recordKey,
          },
          ciphertextEnvelope: encrypted,
        });
        expect(recovered).toEqual(Result.ok(sourceRecords[index]!));
      }
    } finally {
      await redis.del(`${deadLetterPrefix}:records`, ...recordKeys);
      await redis.quit();
    }
  });

  it("returns typed recovery errors for a wrong key and authentication corruption", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const deadLetterPrefix = `test:lilac-delivery:${randomId("dead-recovery-errors")}`;
    const recordKey = `${deadLetterPrefix}:record:recovery-errors`;
    const deadLetter = createRedisEventDeadLetter({
      redis,
      encryptionKey: TEST_DEAD_LETTER_KEY,
      keyPrefix: deadLetterPrefix,
      recordTtlSeconds: 60,
    });
    try {
      const accepted = await deadLetter.accept({
        version: 1,
        deadLetterId: "recovery-errors",
        recordedAt: 42,
        source: {
          topic: "test.topic",
          cursor: "1-0",
          messageId: "1-0",
          mode: "work",
        },
        reason: { kind: "handler-error", errorTag: "Denied", errorMessage: "secret" },
        evidence: {
          source: {
            transport: "redis-streams",
            streamKey: "source",
            topic: "test.topic",
            messageId: "1-0",
          },
          wire: { kind: "bounded-complete", fields: ["data", "secret"] },
        },
      });
      if (accepted.status === "error") throw accepted.error;
      const encrypted = await redis.get(recordKey);
      if (encrypted === null) throw new Error("Encrypted dead-letter record is missing");

      const wrongKey = decryptRedisEventDeadLetterRecord({
        encryptionKey: randomBytes(32),
        expectedIdentity: { deadLetterId: "recovery-errors", storageKey: recordKey },
        ciphertextEnvelope: encrypted,
      });
      expect(wrongKey.status).toBe("error");
      if (wrongKey.status === "error") {
        expect(wrongKey.error).toBeInstanceOf(RedisEventDeadLetterAuthenticationFailed);
      }

      const envelope = JSON.parse(encrypted);
      if (typeof envelope !== "object" || envelope === null) throw new Error("Envelope is invalid");
      Reflect.set(envelope, "authTag", Buffer.alloc(16, 0).toString("base64"));
      const corrupted = decryptRedisEventDeadLetterRecord({
        encryptionKey: TEST_DEAD_LETTER_KEY,
        expectedIdentity: { deadLetterId: "recovery-errors", storageKey: recordKey },
        ciphertextEnvelope: JSON.stringify(envelope),
      });
      expect(corrupted.status).toBe("error");
      if (corrupted.status === "error") {
        expect(corrupted.error).toBeInstanceOf(RedisEventDeadLetterAuthenticationFailed);
      }

      const malformed = decryptRedisEventDeadLetterRecord({
        encryptionKey: TEST_DEAD_LETTER_KEY,
        expectedIdentity: { deadLetterId: "recovery-errors", storageKey: recordKey },
        ciphertextEnvelope: "{}",
      });
      expect(malformed.status).toBe("error");
      if (malformed.status === "error") {
        expect(malformed.error).toBeInstanceOf(RedisEventDeadLetterCiphertextInvalid);
      }
    } finally {
      await redis.del(`${deadLetterPrefix}:records`, recordKey);
      await redis.quit();
    }
  });

  it("rejects ciphertext substitution between record storage identities", () => {
    const firstIdentity = {
      deadLetterId: "record-a",
      storageKey: "dead-letter:record:record-a",
    };
    const secondIdentity = {
      deadLetterId: "record-b",
      storageKey: "dead-letter:record:record-b",
    };
    const encrypted = encryptRedisEventDeadLetterRecoveryValue({
      encryptionKey: TEST_DEAD_LETTER_KEY,
      kind: "record",
      identity: firstIdentity,
      plaintext: "record-a-secret",
    });
    if (encrypted.status === "error") throw encrypted.error;

    expect(
      decryptRedisEventDeadLetterRecoveryValue({
        encryptionKey: TEST_DEAD_LETTER_KEY,
        kind: "record",
        expectedIdentity: firstIdentity,
        ciphertextEnvelope: encrypted.value,
      }),
    ).toEqual(Result.ok("record-a-secret"));
    const substituted = decryptRedisEventDeadLetterRecoveryValue({
      encryptionKey: TEST_DEAD_LETTER_KEY,
      kind: "record",
      expectedIdentity: secondIdentity,
      ciphertextEnvelope: encrypted.value,
    });
    expect(substituted.status).toBe("error");
    if (substituted.status === "error") {
      expect(substituted.error).toBeInstanceOf(RedisEventDeadLetterAuthenticationFailed);
    }
  });

  it("rejects cross-evidence substitution and record/evidence swaps", () => {
    const firstIdentity = {
      deadLetterId: "evidence-a",
      storageKey: "dead-letter:evidence:evidence-a",
    };
    const secondIdentity = {
      deadLetterId: "evidence-b",
      storageKey: "dead-letter:evidence:evidence-b",
    };
    const encryptedEvidence = encryptRedisEventDeadLetterRecoveryValue({
      encryptionKey: TEST_DEAD_LETTER_KEY,
      kind: "evidence",
      identity: firstIdentity,
      plaintext: "evidence-a-secret",
    });
    if (encryptedEvidence.status === "error") throw encryptedEvidence.error;
    const encryptedRecord = encryptRedisEventDeadLetterRecoveryValue({
      encryptionKey: TEST_DEAD_LETTER_KEY,
      kind: "record",
      identity: firstIdentity,
      plaintext: "record-a-secret",
    });
    if (encryptedRecord.status === "error") throw encryptedRecord.error;

    const substituted = decryptRedisEventDeadLetterRecoveryValue({
      encryptionKey: TEST_DEAD_LETTER_KEY,
      kind: "evidence",
      expectedIdentity: secondIdentity,
      ciphertextEnvelope: encryptedEvidence.value,
    });
    expect(substituted.status).toBe("error");
    if (substituted.status === "error") {
      expect(substituted.error).toBeInstanceOf(RedisEventDeadLetterAuthenticationFailed);
    }

    for (const swapped of [
      decryptRedisEventDeadLetterRecoveryValue({
        encryptionKey: TEST_DEAD_LETTER_KEY,
        kind: "record",
        expectedIdentity: firstIdentity,
        ciphertextEnvelope: encryptedEvidence.value,
      }),
      decryptRedisEventDeadLetterRecoveryValue({
        encryptionKey: TEST_DEAD_LETTER_KEY,
        kind: "evidence",
        expectedIdentity: firstIdentity,
        ciphertextEnvelope: encryptedRecord.value,
      }),
    ]) {
      expect(swapped.status).toBe("error");
      if (swapped.status === "error") {
        expect(swapped.error).toBeInstanceOf(RedisEventDeadLetterContextMismatch);
      }
    }
  });
});
