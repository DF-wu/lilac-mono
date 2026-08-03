import { describe, expect, it } from "bun:test";
import { Result, type Result as ResultType } from "better-result";
import Redis from "ioredis";
import SuperJSON from "superjson";
import {
  computeCoreLineagePrefixDigestV1,
  createLilacBus,
  createRedisStreamsBus,
  EventHandlerFailed,
  lilacEventTypes,
  outReqTopic,
  type CoreLineageAtomV1,
  type CoreLineageManifestV1,
  type DecodedMessage,
  type RawMessageDecodeOutcome,
  type RedisMessageDecodeFailure,
} from "../index";
import { env } from "@stanley2058/lilac-utils";
import type { ModelMessage } from "ai";

const TEST_REDIS_URL = env.redisUrl || "redis://127.0.0.1:6379";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function requireOk<TValue, TError>(result: ResultType<TValue, TError>): TValue {
  if (result.status === "error") throw result.error;
  return result.value;
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

async function pendingCount(redis: Redis, streamKey: string, group: string): Promise<number> {
  const summary = (await redis.xpending(streamKey, group)) as unknown;
  if (!Array.isArray(summary) || typeof summary[0] !== "number") {
    throw new Error("Redis returned an invalid pending summary");
  }
  return summary[0];
}

function requireDecodedMessage(message: RawMessageDecodeOutcome): DecodedMessage<unknown> {
  if (!("_tag" in message)) return message;
  throw new Error(`Expected a decoded message, received ${message._tag}`);
}

function requireDecodeFailure(message: RawMessageDecodeOutcome): RedisMessageDecodeFailure {
  if ("_tag" in message) return message;
  throw new Error("Expected a Redis message decode failure");
}

describe("RedisStreamsBus", () => {
  it("returns bounded evidence for malformed SuperJSON data", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("malformed-superjson")}`;
    const topic = "topic";
    const streamKey = `${keyPrefix}:${topic}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    try {
      const id = await redis.xadd(
        streamKey,
        "*",
        "type",
        "test.malformed",
        "ts",
        "123",
        "data",
        "{not-superjson",
      );
      if (typeof id !== "string") throw new Error("Redis did not return an entry id");

      const fetched = await raw.fetch(topic, { offset: { type: "begin" } });
      const failure = requireDecodeFailure(fetched.messages[0]!.msg);
      expect(failure.id).toBe(id);
      expect(failure.error.source).toEqual({
        transport: "redis-streams",
        streamKey,
        topic,
        messageId: id,
      });
      expect(failure.error.issues).toEqual([{ field: "data", reason: "invalid_superjson" }]);
      expect(failure.error.evidence.fields).toContainEqual({
        kind: "string",
        value: "{not-superjson",
        truncated: false,
      });
    } finally {
      await redis.del(streamKey);
      await raw.close();
      await redis.quit();
    }
  });

  it("reports missing and invalid envelope fields without fabricating values", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("invalid-fields")}`;
    const topic = "topic";
    const streamKey = `${keyPrefix}:${topic}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    try {
      await redis.xadd(streamKey, "*", "unexpected", "field");
      await redis.xadd(
        streamKey,
        "*",
        "type",
        "",
        "ts",
        "not-a-number",
        "data",
        SuperJSON.stringify({ ok: true }),
      );

      const fetched = await raw.fetch(topic, { offset: { type: "begin" }, limit: 10 });
      const missing = requireDecodeFailure(fetched.messages[0]!.msg);
      expect(missing.error.issues).toEqual([
        { field: "type", reason: "missing" },
        { field: "ts", reason: "missing" },
        { field: "data", reason: "missing" },
      ]);
      expect("type" in missing).toBe(false);
      expect("ts" in missing).toBe(false);

      const invalid = requireDecodeFailure(fetched.messages[1]!.msg);
      expect(invalid.error.issues).toEqual([
        { field: "type", reason: "empty" },
        { field: "ts", reason: "invalid_number" },
      ]);
      expect("type" in invalid).toBe(false);
      expect("ts" in invalid).toBe(false);
    } finally {
      await redis.del(streamKey);
      await raw.close();
      await redis.quit();
    }
  });

  it("rejects decoded headers containing non-string values", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("invalid-headers")}`;
    const topic = "topic";
    const streamKey = `${keyPrefix}:${topic}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    try {
      await redis.xadd(
        streamKey,
        "*",
        "type",
        "test.headers",
        "ts",
        "123",
        "data",
        SuperJSON.stringify(null),
        "headers",
        SuperJSON.stringify({ request_id: 42 }),
      );

      const fetched = await raw.fetch(topic, { offset: { type: "begin" } });
      const failure = requireDecodeFailure(fetched.messages[0]!.msg);
      expect(failure.error.issues).toEqual([{ field: "headers", reason: "not_string_record" }]);
    } finally {
      await redis.del(streamKey);
      await raw.close();
      await redis.quit();
    }
  });

  it("preserves the existing SuperJSON URL, Date, and header wire encoding", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("wire-compatibility")}`;
    const topic = "topic";
    const streamKey = `${keyPrefix}:${topic}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const data = {
      url: new URL("https://example.com/path?query=value"),
      date: new Date("2026-08-03T12:34:56.789Z"),
    };
    const headers = { request_id: "request-1" };
    try {
      const published = await raw.publish(
        { topic, type: "test.compatibility", headers, data },
        { topic, type: "test.compatibility", headers },
      );
      const entries = await redis.xrange(streamKey, published.id, published.id);
      const fields = entries[0]?.[1];
      if (!fields) throw new Error("Published Redis entry was not found");
      expect(fields[fields.indexOf("data") + 1]).toBe(SuperJSON.stringify(data));
      expect(fields[fields.indexOf("headers") + 1]).toBe(SuperJSON.stringify(headers));

      const fetched = await raw.fetch(topic, { offset: { type: "begin" } });
      const decoded = requireDecodedMessage(fetched.messages[0]!.msg);
      expect(decoded.data).toEqual(data);
      expect(decoded.headers).toEqual(headers);
    } finally {
      await redis.del(streamKey);
      await raw.close();
      await redis.quit();
    }
  });

  it("caps retained wire evidence by value count and string length", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("bounded-evidence")}`;
    const topic = "topic";
    const streamKey = `${keyPrefix}:${topic}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const oversizedData = "x".repeat(5000);
    const fields = ["type", "test.large", "ts", "123", "data", oversizedData];
    for (let index = 0; index < 20; index += 1) {
      fields.push(`extra-${index}`, `value-${index}`);
    }
    try {
      const id = await redis.xadd(streamKey, "*", ...fields);
      if (typeof id !== "string") throw new Error("Redis did not return an entry id");

      const fetched = await raw.fetch(topic, { offset: { type: "begin" } });
      const failure = requireDecodeFailure(fetched.messages[0]!.msg);
      expect(failure.error.source.messageId).toBe(id);
      expect(failure.error.evidence.fields).toHaveLength(32);
      expect(failure.error.evidence.omittedValueCount).toBe(fields.length - 32);
      const dataEvidence = failure.error.evidence.fields[5];
      expect(dataEvidence).toEqual({
        kind: "string",
        value: oversizedData.slice(0, 1024),
        truncated: true,
      });
      for (const value of failure.error.evidence.fields) {
        if (value.kind === "string") expect(value.value.length).toBeLessThanOrEqual(1024);
      }
    } finally {
      await redis.del(streamKey);
      await raw.close();
      await redis.quit();
    }
  });

  it("returns the latest durable topic watermark", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const raw = createRedisStreamsBus({
      redis,
      keyPrefix: `test:lilac-event-bus:${randomId("watermark")}`,
      ownsRedis: true,
    });
    try {
      expect(await raw.watermark("evt.adapter")).toBeNull();
      const first = await raw.publish(
        { topic: "evt.adapter", type: "test.first", data: {} },
        { topic: "evt.adapter", type: "test.first" },
      );
      const second = await raw.publish(
        { topic: "evt.adapter", type: "test.second", data: {} },
        { topic: "evt.adapter", type: "test.second" },
      );
      expect(await raw.watermark("evt.adapter")).toBe(second.cursor);
      expect(second.cursor).not.toBe(first.cursor);
    } finally {
      await raw.close();
    }
  });

  it("does not block publish while a tail subscription is blocked", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("hol")}`;
    const raw = createRedisStreamsBus({
      redis,
      keyPrefix,
      ownsRedis: true,
      subscriberPool: { max: 4, warm: 2 },
    });

    const topicA = "topic-a";
    const topicB = "topic-b";

    const sub = requireOk(
      await raw.subscribe(
        topicA,
        { mode: "tail", offset: { type: "now" }, batch: { maxWaitMs: 2000 } },
        async () => ({ disposition: "commit" }),
      ),
    );

    // test-wait-justification: the pooled subscriber exposes no client ID or readiness hook, so Redis cannot safely identify when this test's XREAD has entered BLOCK.
    await new Promise((r) => setTimeout(r, 50));

    const startedAt = Date.now();
    await raw.publish(
      { topic: topicB, type: "test.publish", data: { ok: true } },
      { topic: topicB, type: "test.publish" },
    );
    const publishMs = Date.now() - startedAt;

    // On the old single-connection implementation, this would be ~BLOCK ms.
    expect(publishMs).toBeLessThan(600);

    requireOk(await sub.stop());
    await raw.close();
  });

  it("stop() interrupts a blocking XREAD promptly", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("stop")}`;
    const raw = createRedisStreamsBus({
      redis,
      keyPrefix,
      ownsRedis: true,
      subscriberPool: { max: 2, warm: 1 },
    });

    const topic = "topic";

    const sub = requireOk(
      await raw.subscribe(
        topic,
        { mode: "tail", offset: { type: "now" }, batch: { maxWaitMs: 5000 } },
        async () => ({ disposition: "commit" }),
      ),
    );

    // test-wait-justification: the pooled subscriber exposes no client ID or readiness hook, so Redis cannot safely identify when this test's XREAD has entered BLOCK before stop() is timed.
    await new Promise((r) => setTimeout(r, 50));

    const startedAt = Date.now();
    requireOk(await sub.stop());
    requireOk(await sub.done);
    const stopMs = Date.now() - startedAt;

    expect(stopMs).toBeLessThan(600);
    await raw.close();
  });

  it("exposes tail subscription loop failures through done", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const raw = createRedisStreamsBus({
      redis,
      keyPrefix: `test:lilac-event-bus:${randomId("done-failure")}`,
      ownsRedis: true,
    });
    const sub = requireOk(
      await raw.subscribe(
        "topic",
        { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 250 } },
        async () => {
          throw new Error("tail handler failed");
        },
      ),
    );
    try {
      await raw.publish(
        { topic: "topic", type: "test.failure", data: {} },
        { topic: "topic", type: "test.failure" },
      );
      await expect(sub.done).rejects.toThrow("tail handler failed");
    } finally {
      await sub.stop().catch(() => undefined);
      await raw.close();
    }
  });

  it("publishes and tails output stream events", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("tail")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix, ownsRedis: true });
    const bus = createLilacBus(raw);

    const requestId = randomId("req");
    const topic = outReqTopic(requestId);

    const received: string[] = [];
    const delivered = Promise.withResolvers<void>();

    const sub = requireOk(
      await bus.subscribeTopic(
        topic,
        { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 250 } },
        async (msg) => {
          if (msg.type === lilacEventTypes.EvtAgentOutputDeltaText) {
            received.push(msg.data.delta);
            delivered.resolve();
          }
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      {
        delta: "hello",
        seq: 1,
      },
      { headers: { request_id: requestId } },
    );

    await delivered.promise;

    expect(received).toEqual(["hello"]);
    requireOk(await sub.stop());
    await bus.close();
  });

  it("refreshes a 24-hour TTL on request output streams", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("output-ttl")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const bus = createLilacBus(raw);
    const requestId = randomId("req");
    const topic = outReqTopic(requestId);
    const streamKey = `${keyPrefix}:${topic}`;

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "hello", seq: 1 },
      { headers: { request_id: requestId } },
    );

    const ttl = await redis.ttl(streamKey);
    expect(ttl).toBeGreaterThan(24 * 60 * 60 - 10);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60);

    await redis.del(streamKey);
    await bus.close();
    await redis.quit();
  });

  it("trims only entries acknowledged by every consumer group", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("acked-trim")}`;
    const streamKey = `${keyPrefix}:topic`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    let deliveriesA = 0;
    let deliveriesB = 0;
    const firstBAction = Promise.withResolvers<{ disposition: "commit" }>();
    const commitsAReady = Promise.withResolvers<void>();
    const firstBReady = Promise.withResolvers<void>();
    const secondBReady = Promise.withResolvers<void>();

    const subA = requireOk(
      await raw.subscribe(
        "topic",
        {
          mode: "fanout",
          subscriptionId: "group-a",
          consumerId: "consumer-a",
          offset: { type: "now" },
          batch: { maxWaitMs: 50 },
        },
        async () => {
          deliveriesA += 1;
          if (deliveriesA === 2) commitsAReady.resolve();
          return { disposition: "commit" };
        },
      ),
    );
    const subB = requireOk(
      await raw.subscribe(
        "topic",
        {
          mode: "fanout",
          subscriptionId: "group-b",
          consumerId: "consumer-b",
          offset: { type: "now" },
          batch: { maxWaitMs: 50 },
        },
        async () => {
          deliveriesB += 1;
          if (deliveriesB === 1) {
            firstBReady.resolve();
            return await firstBAction.promise;
          }
          secondBReady.resolve();
          return { disposition: "commit" };
        },
      ),
    );

    await raw.publish({ topic: "topic", type: "test", data: 1 }, { topic: "topic", type: "test" });
    await raw.publish({ topic: "topic", type: "test", data: 2 }, { topic: "topic", type: "test" });
    await Promise.all([commitsAReady.promise, firstBReady.promise]);

    await raw.flushPendingTrims();
    expect(await redis.xlen(streamKey)).toBe(2);

    firstBAction.resolve({ disposition: "commit" });
    await secondBReady.promise;
    await raw.flushPendingTrims();
    expect(await redis.xlen(streamKey)).toBe(1);

    requireOk(await subA.stop());
    requireOk(await subB.stop());
    await redis.del(streamKey);
    await raw.close();
    await redis.quit();
  });

  it("preserves evt.request history used by cursor recovery", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("tail-recovery")}`;
    const streamKey = `${keyPrefix}:evt.request`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    let deliveries = 0;
    const commitsReady = Promise.withResolvers<void>();
    const sub = requireOk(
      await raw.subscribe(
        "evt.request",
        {
          mode: "fanout",
          subscriptionId: "durable-group",
          consumerId: "consumer",
          offset: { type: "now" },
          batch: { maxWaitMs: 50 },
        },
        async () => {
          deliveries += 1;
          if (deliveries === 2) commitsReady.resolve();
          return { disposition: "commit" };
        },
      ),
    );

    await raw.publish(
      { topic: "evt.request", type: "test", data: 1 },
      { topic: "evt.request", type: "test" },
    );
    await raw.publish(
      { topic: "evt.request", type: "test", data: 2 },
      { topic: "evt.request", type: "test" },
    );
    await commitsReady.promise;
    await raw.flushPendingTrims();
    expect(await redis.xlen(streamKey)).toBe(2);

    requireOk(await sub.stop());
    await redis.del(streamKey);
    await raw.close();
    await redis.quit();
  });

  it("bounds evt.adapter history behind the durable checkpoint safety margin", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("adapter-checkpoint-trim")}`;
    const streamKey = `${keyPrefix}:evt.adapter`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const cursors: string[] = [];
    try {
      for (let index = 0; index < 150; index += 1) {
        const published = await raw.publish(
          { topic: "evt.adapter", type: "test", data: index },
          { topic: "evt.adapter", type: "test" },
        );
        cursors.push(published.cursor);
      }
      expect(await raw.trimBeforeCheckpoint("evt.adapter", cursors.at(-1)!, 20)).toBe(130);
      expect(await redis.xlen(streamKey)).toBe(20);
      expect(await redis.xrange(streamKey, cursors[129]!, cursors[129]!)).toHaveLength(0);
      expect(await redis.xrange(streamKey, cursors[130]!, cursors[130]!)).toHaveLength(1);
    } finally {
      await redis.del(streamKey);
      await raw.close();
      await redis.quit();
    }
  });

  it("does not reclaim beyond a lagging resolver checkpoint or durable group frontier", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("adapter-lag-frontier")}`;
    const streamKey = `${keyPrefix}:evt.adapter`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const cursors: string[] = [];
    try {
      for (let index = 0; index < 120; index += 1) {
        const published = await raw.publish(
          { topic: "evt.adapter", type: index === 100 ? "test.barrier" : "test", data: index },
          { topic: "evt.adapter", type: index === 100 ? "test.barrier" : "test" },
        );
        cursors.push(published.cursor);
      }

      await raw.trimBeforeCheckpoint("evt.adapter", cursors[49]!, 10);
      expect(await redis.xrange(streamKey, cursors[49]!, cursors[49]!)).toHaveLength(1);
      expect(await redis.xrange(streamKey, cursors[39]!, cursors[39]!)).toHaveLength(0);

      await redis.xgroup("CREATE", streamKey, "durable-adapter-reader", cursors[79]!);
      await raw.trimBeforeCheckpoint("evt.adapter", cursors.at(-1)!, 10);
      expect(await redis.xrange(streamKey, cursors[79]!, cursors[79]!)).toHaveLength(1);
      expect(await redis.xrange(streamKey, cursors[69]!, cursors[69]!)).toHaveLength(0);
      expect(await redis.xrange(streamKey, cursors[100]!, cursors[100]!)).toHaveLength(1);
    } finally {
      await redis.del(streamKey);
      await raw.close();
      await redis.quit();
    }
  });

  it("retires the pre-tail workflow wait group without pinning adapter retention", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("retired-workflow-waits")}`;
    const streamKey = `${keyPrefix}:evt.adapter`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    try {
      const first = await raw.publish(
        { topic: "evt.adapter", type: "test", data: 1 },
        { topic: "evt.adapter", type: "test" },
      );
      const second = await raw.publish(
        { topic: "evt.adapter", type: "test", data: 2 },
        { topic: "evt.adapter", type: "test" },
      );
      await redis.xgroup("CREATE", streamKey, "core:workflow-waits", first.cursor);

      expect(await raw.retireConsumerGroup("evt.adapter", "core:workflow-waits", true)).toBe(
        "destroyed",
      );
      expect(await redis.xinfo("GROUPS", streamKey)).toEqual([]);
      expect(await raw.trimBeforeCheckpoint("evt.adapter", second.cursor, 1)).toBe(1);
      expect(await redis.xlen(streamKey)).toBe(1);
    } finally {
      await redis.del(streamKey);
      await raw.close();
      await redis.quit();
    }
  });

  it("requires single-version confirmation before retiring registered pre-tail consumers", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("workflow-waits-rollout-guard")}`;
    const streamKey = `${keyPrefix}:evt.adapter`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    try {
      await raw.publish(
        { topic: "evt.adapter", type: "test", data: 1 },
        { topic: "evt.adapter", type: "test" },
      );
      await redis.xgroup("CREATE", streamKey, "core:workflow-waits", "0-0");
      await redis.xreadgroup(
        "GROUP",
        "core:workflow-waits",
        "old-core",
        "COUNT",
        1,
        "STREAMS",
        streamKey,
        ">",
      );

      await expect(
        raw.retireConsumerGroup("evt.adapter", "core:workflow-waits", false),
      ).rejects.toThrow("confirmed single-version rollout");
      expect(await raw.retireConsumerGroup("evt.adapter", "core:workflow-waits", true)).toBe(
        "destroyed",
      );
    } finally {
      await redis.del(streamKey);
      await raw.close();
      await redis.quit();
    }
  });

  it("preserves lagged evt.adapter entries when other groups acknowledge later entries", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("adapter-recovery")}`;
    const streamKey = `${keyPrefix}:evt.adapter`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    let deliveries = 0;
    const commitsReady = Promise.withResolvers<void>();
    const sub = requireOk(
      await raw.subscribe(
        "evt.adapter",
        {
          mode: "fanout",
          subscriptionId: "other-adapter-group",
          consumerId: "other-consumer",
          offset: { type: "now" },
          batch: { maxWaitMs: 50 },
        },
        async () => {
          deliveries += 1;
          if (deliveries === 2) commitsReady.resolve();
          return { disposition: "commit" };
        },
      ),
    );

    await raw.publish(
      { topic: "evt.adapter", type: "test.reply", data: 1 },
      { topic: "evt.adapter", type: "test.reply", retention: { maxLenApprox: 1 } },
    );
    await raw.publish(
      { topic: "evt.adapter", type: "test.barrier", data: 2 },
      { topic: "evt.adapter", type: "test.barrier", retention: { maxLenApprox: 1 } },
    );
    await commitsReady.promise;
    await raw.flushPendingTrims();
    expect(await redis.xlen(streamKey)).toBe(2);

    requireOk(await sub.stop());
    await redis.del(streamKey);
    await raw.close();
    await redis.quit();
  });

  it("destroys ephemeral consumer groups on stop", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("ephemeral")}`;
    const streamKey = `${keyPrefix}:topic`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const sub = requireOk(
      await raw.subscribe(
        "topic",
        {
          mode: "fanout",
          subscriptionId: "temporary-group",
          consumerId: "temporary-consumer",
          ephemeral: true,
          offset: { type: "now" },
          batch: { maxWaitMs: 50 },
        },
        async () => ({ disposition: "commit" }),
      ),
    );

    requireOk(await sub.stop());
    expect(await redis.xinfo("GROUPS", streamKey)).toEqual([]);

    await redis.del(streamKey);
    await raw.close();
    await redis.quit();
  });

  it("requires exclusive ephemeral consumer groups", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("ephemeral-owner")}`;
    const streamKey = `${keyPrefix}:topic`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const options = {
      mode: "fanout" as const,
      subscriptionId: "shared-temporary-group",
      ephemeral: true,
      offset: { type: "now" as const },
      batch: { maxWaitMs: 50 },
    };
    const owner = requireOk(
      await raw.subscribe("topic", { ...options, consumerId: "owner" }, async () => ({
        disposition: "commit",
      })),
    );
    const participant = await raw.subscribe(
      "topic",
      { ...options, consumerId: "participant" },
      async () => ({ disposition: "commit" }),
    );
    expect(participant.status).toBe("error");
    if (participant.status === "error") {
      expect(participant.error.message).toContain("Failed to initialize Redis delivery");
      expect(String(participant.error.cause)).toContain("Ephemeral consumer group already exists");
    }

    const durable = requireOk(
      await raw.subscribe(
        "topic",
        {
          mode: "fanout",
          subscriptionId: "shared-temporary-group",
          consumerId: "durable",
          offset: { type: "now" },
          batch: { maxWaitMs: 50 },
        },
        async () => ({ disposition: "commit" }),
      ),
    );

    const groups = await redis.xinfo("GROUPS", streamKey);
    expect(groups).toHaveLength(2);

    requireOk(await owner.stop());
    expect(await redis.xinfo("GROUPS", streamKey)).toHaveLength(1);
    requireOk(await durable.stop());

    await redis.del(streamKey);
    await raw.close();
    await redis.quit();
  });

  it("publishes tool-call progress events on the output stream", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("toolcall")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix, ownsRedis: true });
    const bus = createLilacBus(raw);

    const requestId = randomId("req");
    const topic = outReqTopic(requestId);

    const received: Array<{
      status: string;
      display: string;
    }> = [];
    const delivered = Promise.withResolvers<void>();

    const sub = requireOk(
      await bus.subscribeTopic(
        topic,
        { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 250 } },
        async (msg) => {
          if (msg.type === lilacEventTypes.EvtAgentOutputToolCall) {
            received.push({
              status: msg.data.status,
              display: msg.data.display,
            });
            if (received.length >= 2) delivered.resolve();
          }
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      {
        toolCallId: "call-1",
        status: "start",
        display: "[bash] ls -al",
      },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      {
        toolCallId: "call-1",
        status: "end",
        display: "[bash] ls -al",
        ok: true,
      },
      { headers: { request_id: requestId } },
    );

    await delivered.promise;

    expect(received).toEqual([
      { status: "start", display: "[bash] ls -al" },
      { status: "end", display: "[bash] ls -al" },
    ]);

    requireOk(await sub.stop());
    await bus.close();
  });

  it("fans out evt.request to different subscriptionIds", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("fanout")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix, ownsRedis: true });
    const bus = createLilacBus(raw);

    const requestId = randomId("req");

    let aCount = 0;
    let bCount = 0;
    const aDelivered = Promise.withResolvers<void>();
    const bDelivered = Promise.withResolvers<void>();

    const subA = requireOk(
      await bus.subscribeTopic(
        "evt.request",
        {
          mode: "fanout",
          subscriptionId: "adapter-a",
          consumerId: "a",
          offset: { type: "now" },
          batch: { maxWaitMs: 250 },
        },
        async (msg) => {
          if (msg.type === lilacEventTypes.EvtRequestReply) {
            aCount++;
          }
          aDelivered.resolve();
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    const subB = requireOk(
      await bus.subscribeTopic(
        "evt.request",
        {
          mode: "fanout",
          subscriptionId: "adapter-b",
          consumerId: "b",
          offset: { type: "now" },
          batch: { maxWaitMs: 250 },
        },
        async (msg) => {
          if (msg.type === lilacEventTypes.EvtRequestReply) {
            bCount++;
          }
          bDelivered.resolve();
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    await bus.publish(
      lilacEventTypes.EvtRequestReply,
      {},
      {
        headers: { request_id: requestId },
      },
    );

    await Promise.all([aDelivered.promise, bDelivered.promise]);

    expect(aCount).toBe(1);
    expect(bCount).toBe(1);
    const streamKey = `${keyPrefix}:evt.request`;
    expect(
      await eventually(
        () => pendingCount(redis, streamKey, "adapter-a"),
        (count) => count === 0,
      ),
    ).toBe(0);
    expect(
      await eventually(
        () => pendingCount(redis, streamKey, "adapter-b"),
        (count) => count === 0,
      ),
    ).toBe(0);

    requireOk(await subA.stop());
    requireOk(await subB.stop());
    await bus.close();
  });

  it("supports cursor resume in tail mode", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("cursor")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix, ownsRedis: true });
    const bus = createLilacBus(raw);

    const requestId = randomId("req");
    const topic = outReqTopic(requestId);

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      {
        delta: "a",
        seq: 1,
      },
      { headers: { request_id: requestId } },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      {
        delta: "b",
        seq: 2,
      },
      { headers: { request_id: requestId } },
    );

    const first = requireOk(
      await bus.fetchTopic(topic, {
        offset: { type: "begin" },
        limit: 1,
      }),
    );

    expect(first.messages.length).toBe(1);
    const cursor = first.messages[0]!.cursor;

    const received: string[] = [];
    const delivered = Promise.withResolvers<void>();

    const sub = requireOk(
      await bus.subscribeTopic(
        topic,
        {
          mode: "tail",
          offset: { type: "cursor", cursor },
          batch: { maxWaitMs: 250 },
        },
        async (msg) => {
          if (msg.type === lilacEventTypes.EvtAgentOutputDeltaText) {
            received.push(msg.data.delta);
            delivered.resolve();
          }
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    await delivered.promise;
    expect(received).toEqual(["b"]);

    requireOk(await sub.stop());
    await bus.close();
  });

  it("delivers cmd.request.message in work mode", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("work")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix, ownsRedis: true });
    const bus = createLilacBus(raw);

    const requestId = randomId("req");

    let received = 0;
    const delivered = Promise.withResolvers<void>();

    const sub = requireOk(
      await bus.subscribeTopic(
        "cmd.request",
        {
          mode: "work",
          subscriptionId: "agent-service",
          consumerId: "instance-1",
          offset: { type: "begin" },
          batch: { maxWaitMs: 250 },
        },
        async (msg) => {
          if (msg.type === lilacEventTypes.CmdRequestMessage) {
            received++;
          }
          delivered.resolve();
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        queue: "prompt",
        messages: [{ role: "user", content: "ping" }],
      },
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "unknown",
        },
      },
    );

    await delivered.promise;
    expect(received).toBe(1);
    expect(
      await eventually(
        () => pendingCount(redis, `${keyPrefix}:cmd.request`, "agent-service"),
        (count) => count === 0,
      ),
    ).toBe(0);

    requireOk(await sub.stop());
    await bus.close();
  });

  it("serializes complex objects with URLs and non-standard types using superjson", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("superjson")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix, ownsRedis: true });
    const bus = createLilacBus(raw);

    const requestId = randomId("req");

    // Create complex object with URL and special types
    const complexData = {
      queue: "prompt" as const,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Check out https://example.com/path?query=value",
            },
            {
              type: "file",
              data: new URL("https://example.com/example.pdf"),
              mediaType: "application/pdf",
            },
          ],
        },
      ] satisfies ModelMessage[],
      raw: {
        url: new URL("https://example.com/api"),
        date: new Date(),
        nested: {
          innerUrl: "https://nested.example.com",
        },
      },
    };

    let received: unknown;
    const delivered = Promise.withResolvers<void>();

    const sub = requireOk(
      await bus.subscribeTopic(
        "cmd.request",
        {
          mode: "work",
          subscriptionId: "test-agent",
          consumerId: "instance-1",
          offset: { type: "begin" },
          batch: { maxWaitMs: 250 },
        },
        async (msg) => {
          if (msg.type === lilacEventTypes.CmdRequestMessage) {
            received = msg.data;
          }
          delivered.resolve();
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    await bus.publish(lilacEventTypes.CmdRequestMessage, complexData, {
      headers: { request_id: requestId },
    });

    await delivered.promise;

    expect(received).toEqual(complexData);
    requireOk(await sub.stop());
    await bus.close();
  });

  it("preserves Core primary lineage through request transport", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("primary-lineage")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix, ownsRedis: true });
    const bus = createLilacBus(raw);
    const messages = [{ role: "user" as const, content: "canonical prompt" }];
    const atom = {
      kind: "surface",
      requestClient: "discord",
      surfaceId: "discord",
      sessionId: "channel-1",
      messageId: "message-1",
    } satisfies CoreLineageAtomV1;
    const corePrimaryLineage = {
      state: "complete",
      lineageVersion: 1,
      currentCanonicalStart: 0,
      segments: [
        {
          atoms: [atom],
          canonicalMessages: messages,
          canonicalStart: 0,
          canonicalEnd: 1,
          cumulativeAtomCount: 1,
          cumulativePrefixDigest: computeCoreLineagePrefixDigestV1([atom]),
        },
      ],
    } satisfies CoreLineageManifestV1;

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      { queue: "prompt", messages, corePrimaryLineage },
      { headers: { request_id: randomId("req") } },
    );
    const fetched = requireOk(
      await bus.fetchTopic("cmd.request", {
        offset: { type: "begin" },
        limit: 1,
      }),
    );

    expect(fetched.messages[0]?.msg.data).toEqual({
      queue: "prompt",
      messages,
      corePrimaryLineage,
    });
    await bus.close();
  });

  it("keeps work subscription loop alive after a handler error is committed by policy", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("work-loop")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix, ownsRedis: true });
    const bus = createLilacBus(raw);

    let calls = 0;
    let deliveredAfterError = false;
    const delivered = Promise.withResolvers<void>();

    const sub = requireOk(
      await bus.subscribeTopic(
        "cmd.request",
        {
          mode: "work",
          subscriptionId: "agent-service-loop",
          consumerId: "instance-1",
          offset: { type: "begin" },
          batch: { maxWaitMs: 250 },
        },
        async (msg) => {
          if (msg.type !== lilacEventTypes.CmdRequestMessage) return Result.ok(undefined);

          calls += 1;
          if (calls === 1) {
            return Result.err(new EventHandlerFailed({ message: "expected handler failure" }));
          }

          deliveredAfterError = true;
          delivered.resolve();
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        queue: "prompt",
        messages: [{ role: "user", content: "first" }],
      },
      {
        headers: {
          request_id: randomId("req"),
          session_id: "chan",
          request_client: "unknown",
        },
      },
    );

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        queue: "prompt",
        messages: [{ role: "user", content: "second" }],
      },
      {
        headers: {
          request_id: randomId("req"),
          session_id: "chan",
          request_client: "unknown",
        },
      },
    );

    await delivered.promise;

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(deliveredAfterError).toBe(true);
    expect(
      await eventually(
        () => pendingCount(redis, `${keyPrefix}:cmd.request`, "agent-service-loop"),
        (count) => count === 0,
      ),
    ).toBe(0);

    requireOk(await sub.stop());
    await bus.close();
  });
});
