import type Redis from "ioredis";
import SuperJSON from "superjson";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";
import { createLogger, errorMessage } from "@stanley2058/lilac-utils";
import type { Logger } from "@stanley2058/simple-module-logger";

import type { RawBus } from "./raw-bus";
import {
  EventDeliveryStartFailed,
  EventDeliveryStopFailed,
  EventDeliveryStopped,
  EventDeliveryTransportFailed,
  type EventDeliveryDoneError,
  type RawDeliveryAction,
  type RawDeliveryDependencies,
  type RawDeliveryHandler,
} from "./event-delivery";
import {
  checkedDeadLetterAcceptance,
  EventDeadLetterAcceptFailed,
  type EventDeadLetterAcceptance,
  type EventTransportEvidence,
} from "./event-dead-letter";
import {
  RedisConnectionPool,
  type RedisConnectionPoolOptions,
  type RedisConnectionPoolAutoscaleOptions,
} from "./redis-connection-pool";
import type {
  Cursor,
  FetchOptions,
  Offset,
  PublishOptions,
  PublishMessage,
  RawMessageDecodeOutcome,
  RedisMessageDecodeIssue,
  RedisWireValueEvidence,
  SubscriptionOptions,
  Topic,
} from "./types";

const DEFAULT_MAX_MESSAGES = 50;
const DEFAULT_BLOCK_MS = 1000;
const OUTPUT_STREAM_TTL_SECONDS = 24 * 60 * 60;
const TRIM_DEBOUNCE_MS = 100;
const EPHEMERAL_GROUP_PREFIX = "__lilac_ephemeral__:";
const TAIL_REPLAY_TOPICS = new Set<Topic>(["evt.request", "evt.adapter"]);
const MAX_EVIDENCE_VALUES = 32;
const MAX_EVIDENCE_VALUE_CHARS = 1024;
const STRING_HEADERS_SCHEMA = z.record(z.string(), z.string());
const REDIS_STREAM_ID_PATTERN = /^\d+-\d+$/;

const XADD_WITH_EXPIRY_SCRIPT = `
local id = redis.call("XADD", KEYS[1], unpack(ARGV, 2))
redis.call("EXPIRE", KEYS[1], ARGV[1])
return id
`;

const TRIM_ACKNOWLEDGED_PREFIX_SCRIPT = `
local groups = redis.call("XINFO", "GROUPS", KEYS[1])
if #groups == 0 then return 0 end

local function component_less_than(left, right)
  if string.len(left) ~= string.len(right) then return string.len(left) < string.len(right) end
  return left < right
end

local function less_than(left, right)
  local left_dash = string.find(left, "-", 1, true)
  local right_dash = string.find(right, "-", 1, true)
  local left_time = string.sub(left, 1, left_dash - 1)
  local right_time = string.sub(right, 1, right_dash - 1)
  if left_time ~= right_time then return component_less_than(left_time, right_time) end
  local left_sequence = string.sub(left, left_dash + 1)
  local right_sequence = string.sub(right, right_dash + 1)
  return component_less_than(left_sequence, right_sequence)
end

local watermark = nil
for _, fields in ipairs(groups) do
  local name = nil
  local pending = nil
  local last_delivered_id = nil
  for index = 1, #fields, 2 do
    if fields[index] == "name" then name = fields[index + 1] end
    if fields[index] == "pending" then pending = fields[index + 1] end
    if fields[index] == "last-delivered-id" then last_delivered_id = fields[index + 1] end
  end
  if not name or pending == nil or not last_delivered_id then return 0 end

  local boundary = last_delivered_id
  if pending > 0 then
    local pending_summary = redis.call("XPENDING", KEYS[1], name)
    boundary = pending_summary[2]
    if not boundary then return 0 end
  end
  if boundary == "0-0" then return 0 end
  if not watermark or less_than(boundary, watermark) then watermark = boundary end
end

return redis.call("XTRIM", KEYS[1], "MINID", "=", watermark)
`;

const TRIM_BEFORE_CHECKPOINT_SCRIPT = `
if redis.call("TYPE", KEYS[1]).ok ~= "stream" then return 0 end

local function component_less_than(left, right)
  if string.len(left) ~= string.len(right) then return string.len(left) < string.len(right) end
  return left < right
end

local function less_than(left, right)
  local left_dash = string.find(left, "-", 1, true)
  local right_dash = string.find(right, "-", 1, true)
  local left_time = string.sub(left, 1, left_dash - 1)
  local right_time = string.sub(right, 1, right_dash - 1)
  if left_time ~= right_time then return component_less_than(left_time, right_time) end
  return component_less_than(string.sub(left, left_dash + 1), string.sub(right, right_dash + 1))
end

local watermark = ARGV[1]
if watermark == "0-0" then return 0 end
local groups = redis.call("XINFO", "GROUPS", KEYS[1])
for _, fields in ipairs(groups) do
  local name = nil
  local pending = nil
  local last_delivered_id = nil
  for index = 1, #fields, 2 do
    if fields[index] == "name" then name = fields[index + 1] end
    if fields[index] == "pending" then pending = fields[index + 1] end
    if fields[index] == "last-delivered-id" then last_delivered_id = fields[index + 1] end
  end
  if not name or pending == nil or not last_delivered_id then return 0 end
  if string.sub(name, 1, string.len(ARGV[3])) ~= ARGV[3] then
    local boundary = last_delivered_id
    if pending > 0 then
      local pending_summary = redis.call("XPENDING", KEYS[1], name)
      boundary = pending_summary[2]
      if not boundary then return 0 end
    end
    if boundary == "0-0" then return 0 end
    if less_than(boundary, watermark) then watermark = boundary end
  end
end

local retained = redis.call("XREVRANGE", KEYS[1], watermark, "-", "COUNT", ARGV[2])
if #retained < tonumber(ARGV[2]) then return 0 end
local cutoff = retained[#retained][1]
return redis.call("XTRIM", KEYS[1], "MINID", "=", cutoff)
`;

const RETIRE_CONSUMER_GROUP_SCRIPT = `
if redis.call("TYPE", KEYS[1]).ok ~= "stream" then return 0 end
local groups = redis.call("XINFO", "GROUPS", KEYS[1])
local found = false
for _, fields in ipairs(groups) do
  for index = 1, #fields, 2 do
    if fields[index] == "name" and fields[index + 1] == ARGV[1] then found = true end
  end
end
if not found then return 0 end
if ARGV[2] ~= "1" then return -1 end
return redis.call("XGROUP", "DESTROY", KEYS[1], ARGV[1])
`;

function randomConsumerId(): string {
  // Bun + modern Node both support this.
  return crypto.randomUUID();
}

function redisIdForOffset(offset: Offset): string {
  switch (offset.type) {
    case "begin":
      return "0-0";
    case "now":
      return "$";
    case "cursor":
      return offset.cursor;
  }
}

function redisIdForOptionalOffset(offset: Offset | undefined): string {
  if (offset === undefined) return "$";
  return redisIdForOffset(offset);
}

type RedisReadEntry = {
  readonly id: string;
  readonly message: RawMessageDecodeOutcome;
  readonly evidence: EventTransportEvidence;
};
type RedisResponseDecodeResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "error"; readonly message: string };

function isRedisStreamId(value: string): boolean {
  return REDIS_STREAM_ID_PATTERN.test(value);
}

function isRedisCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function decodeRedisReadResponse(
  response: unknown,
  topic: Topic,
  expectedStreamKey: string,
  logger?: Logger,
): RedisResponseDecodeResult<readonly RedisReadEntry[]> {
  if (response === null) return { status: "ok", value: [] };
  if (!Array.isArray(response) || response.length !== 1) {
    return { status: "error", message: "Redis XREAD returned an invalid stream collection" };
  }
  const stream = response[0];
  if (
    !Array.isArray(stream) ||
    stream.length !== 2 ||
    stream[0] !== expectedStreamKey ||
    !Array.isArray(stream[1])
  ) {
    return { status: "error", message: "Redis XREAD returned an invalid stream entry" };
  }

  const entries: RedisReadEntry[] = [];
  for (const entry of stream[1]) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return { status: "error", message: "Redis XREAD returned an invalid message entry" };
    }
    if (typeof entry[0] !== "string" || !isRedisStreamId(entry[0])) {
      return { status: "error", message: "Redis XREAD returned an invalid message id" };
    }
    const id = entry[0];
    const fields = entry[1];
    entries.push({
      id,
      message: decodeMessage(topic, expectedStreamKey, id, fields, logger),
      evidence: redisTransportEvidence(topic, expectedStreamKey, id, fields),
    });
  }
  return { status: "ok", value: entries };
}

function decodeRedisWatermarkResponse(response: unknown): RedisResponseDecodeResult<string | null> {
  if (!Array.isArray(response)) {
    return { status: "error", message: "Redis XREVRANGE returned an invalid entry collection" };
  }
  if (response.length === 0) return { status: "ok", value: null };
  if (response.length !== 1) {
    return { status: "error", message: "Redis XREVRANGE returned too many entries" };
  }
  const latest = response[0];
  if (
    !Array.isArray(latest) ||
    latest.length !== 2 ||
    typeof latest[0] !== "string" ||
    !isRedisStreamId(latest[0]) ||
    !Array.isArray(latest[1])
  ) {
    return { status: "error", message: "Redis XREVRANGE returned an invalid entry" };
  }
  return { status: "ok", value: latest[0] };
}

type RedisFieldsDecodeResult =
  | { status: "ok"; value: Record<string, string> }
  | { status: "error"; issues: readonly RedisMessageDecodeIssue[] };

type SuperJsonDecodeResult = { status: "ok"; value: unknown } | { status: "error" };

function boundWireValue(value: unknown): RedisWireValueEvidence {
  if (value === null) return { kind: "non-string", valueType: "null" };
  if (Array.isArray(value)) return { kind: "non-string", valueType: "array" };
  switch (typeof value) {
    case "bigint":
      return { kind: "non-string", valueType: "bigint" };
    case "boolean":
      return { kind: "non-string", valueType: "boolean" };
    case "function":
      return { kind: "non-string", valueType: "function" };
    case "number":
      return { kind: "non-string", valueType: "number" };
    case "object":
      return { kind: "non-string", valueType: "object" };
    case "symbol":
      return { kind: "non-string", valueType: "symbol" };
    case "undefined":
      return { kind: "non-string", valueType: "undefined" };
    case "string":
      if (value.length <= MAX_EVIDENCE_VALUE_CHARS) {
        return { kind: "string", value, truncated: false };
      }
      return {
        kind: "string",
        value: value.slice(0, MAX_EVIDENCE_VALUE_CHARS),
        truncated: true,
      };
  }
  return { kind: "non-string", valueType: "undefined" };
}

function boundWireEvidence(fields: unknown): {
  fields: readonly RedisWireValueEvidence[];
  omittedValueCount: number;
} {
  const values = Array.isArray(fields) ? fields : [fields];
  return {
    fields: values.slice(0, MAX_EVIDENCE_VALUES).map(boundWireValue),
    omittedValueCount: Math.max(0, values.length - MAX_EVIDENCE_VALUES),
  };
}

function redisTransportEvidence(
  topic: Topic,
  streamKey: string,
  id: string,
  fields: unknown,
): EventTransportEvidence {
  const source = { transport: "redis-streams" as const, streamKey, topic, messageId: id };
  if (
    Array.isArray(fields) &&
    fields.length <= MAX_EVIDENCE_VALUES &&
    fields.every((value) => typeof value === "string" && value.length <= MAX_EVIDENCE_VALUE_CHARS)
  ) {
    return { source, wire: { kind: "bounded-complete", fields } };
  }

  return {
    source,
    wire: {
      kind: "controlled-reference",
      locator: { kind: "redis-stream-entry", streamKey, messageId: id },
      preview: boundWireEvidence(fields),
    },
  };
}

function deliveryAction(value: RawDeliveryAction): RawDeliveryAction {
  if (typeof value !== "object" || value === null) {
    throw new Panic({ message: "Event delivery handler returned a non-object action" });
  }
  const disposition = Reflect.get(value, "disposition");
  switch (disposition) {
    case "commit":
    case "park-pending":
    case "stop":
      return value;
    case "dead-letter": {
      const record = Reflect.get(value, "record");
      if (typeof record !== "object" || record === null) {
        throw new Panic({ message: "Dead-letter disposition omitted its record" });
      }
      return value;
    }
    default:
      throw new Panic({ message: "Event delivery handler returned an unknown disposition" });
  }
}

function decodeRedisFields(fields: unknown): RedisFieldsDecodeResult {
  if (!Array.isArray(fields)) {
    return {
      status: "error",
      issues: [{ field: "entry", reason: "fields_not_array" }],
    };
  }

  const issues: RedisMessageDecodeIssue[] = [];
  if (fields.length % 2 !== 0) {
    issues.push({ field: "entry", reason: "odd_field_count" });
  }
  for (let index = 0; index < fields.length; index += 1) {
    if (typeof fields[index] !== "string") {
      issues.push({ field: "entry", reason: "non_string_field", index });
    }
  }
  if (issues.length > 0) return { status: "error", issues };

  const record: Record<string, string> = {};
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const key = fields[index];
    const value = fields[index + 1];
    if (typeof key === "string" && typeof value === "string") record[key] = value;
  }
  return { status: "ok", value: record };
}

function decodeSuperJson(value: string): SuperJsonDecodeResult {
  try {
    return { status: "ok", value: SuperJSON.parse(value) };
  } catch {
    return { status: "error" };
  }
}

function decodeMessage(
  topic: Topic,
  streamKey: string,
  id: string,
  fields: unknown,
  logger?: Logger,
): RawMessageDecodeOutcome {
  const failure = (issues: readonly RedisMessageDecodeIssue[]): RawMessageDecodeOutcome => {
    const evidence = boundWireEvidence(fields);
    logger?.warn("event_bus.transport_decode_failed", {
      topic,
      messageId: id,
      issues: issues.map((issue) => ({ field: issue.field, reason: issue.reason })),
      evidenceValueCount: evidence.fields.length,
      evidenceOmittedValueCount: evidence.omittedValueCount,
      evidenceTruncated: evidence.fields.some(
        (value) => value.kind === "string" && value.truncated,
      ),
    });
    return {
      _tag: "RedisMessageDecodeFailure",
      topic,
      id,
      error: {
        source: { transport: "redis-streams", streamKey, topic, messageId: id },
        issues,
        evidence,
      },
    };
  };

  const fieldsResult = decodeRedisFields(fields);
  if (fieldsResult.status === "error") return failure(fieldsResult.issues);
  const record = fieldsResult.value;

  let typeResult:
    | { status: "ok"; value: string }
    | { status: "error"; issue: RedisMessageDecodeIssue };
  const typeRaw = record["type"];
  if (typeRaw === undefined) {
    typeResult = { status: "error", issue: { field: "type", reason: "missing" } };
  } else if (typeRaw.length === 0) {
    typeResult = { status: "error", issue: { field: "type", reason: "empty" } };
  } else {
    typeResult = { status: "ok", value: typeRaw };
  }

  const tsRaw = record["ts"];
  const tsNumber = tsRaw === undefined || tsRaw.trim().length === 0 ? NaN : Number(tsRaw);
  let tsResult:
    | { status: "ok"; value: number }
    | { status: "error"; issue: RedisMessageDecodeIssue };
  if (tsRaw === undefined) {
    tsResult = { status: "error", issue: { field: "ts", reason: "missing" } };
  } else if (!Number.isFinite(tsNumber)) {
    tsResult = { status: "error", issue: { field: "ts", reason: "invalid_number" } };
  } else {
    tsResult = { status: "ok", value: tsNumber };
  }

  const dataRaw = record["data"];
  let dataResult:
    | { status: "ok"; value: unknown }
    | { status: "error"; issue: RedisMessageDecodeIssue };
  if (dataRaw === undefined) {
    dataResult = { status: "error", issue: { field: "data", reason: "missing" } };
  } else {
    const decoded = decodeSuperJson(dataRaw);
    dataResult =
      decoded.status === "ok"
        ? decoded
        : { status: "error", issue: { field: "data", reason: "invalid_superjson" } };
  }

  const headersRaw = record["headers"];
  let headersResult:
    | { status: "ok"; value: Record<string, string> | undefined }
    | { status: "error"; issue: RedisMessageDecodeIssue };
  if (headersRaw === undefined) {
    headersResult = { status: "ok", value: undefined };
  } else {
    const decoded = decodeSuperJson(headersRaw);
    if (decoded.status === "error") {
      headersResult = {
        status: "error",
        issue: { field: "headers", reason: "invalid_superjson" },
      };
    } else {
      const parsed = STRING_HEADERS_SCHEMA.safeParse(decoded.value);
      if (parsed.success) {
        headersResult = { status: "ok", value: parsed.data };
      } else {
        headersResult = {
          status: "error",
          issue: { field: "headers", reason: "not_string_record" },
        };
      }
    }
  }

  if (
    typeResult.status === "error" ||
    tsResult.status === "error" ||
    dataResult.status === "error" ||
    headersResult.status === "error"
  ) {
    const issues: RedisMessageDecodeIssue[] = [];
    if (typeResult.status === "error") issues.push(typeResult.issue);
    if (tsResult.status === "error") issues.push(tsResult.issue);
    if (dataResult.status === "error") issues.push(dataResult.issue);
    if (headersResult.status === "error") issues.push(headersResult.issue);
    return failure(issues);
  }

  return {
    topic,
    id,
    type: typeResult.value,
    ts: tsResult.value,
    key: record["key"],
    headers: headersResult.value,
    data: dataResult.value,
  };
}

async function ensureGroup(options: {
  redis: Redis;
  streamKey: string;
  group: string;
  startId: string;
  logger?: Logger;
}): Promise<ResultType<boolean, RedisConsumerGroupEnsureFailed>> {
  try {
    const created = await options.redis.xgroup(
      "CREATE",
      options.streamKey,
      options.group,
      options.startId,
      "MKSTREAM",
    );
    if (created !== "OK") {
      return Result.err(
        new RedisConsumerGroupEnsureFailed({
          cause: new Error("Redis XGROUP CREATE returned an invalid response"),
          streamKey: options.streamKey,
          group: options.group,
          message: "Redis consumer-group initialization failed",
        }),
      );
    }

    options.logger?.info("created consumer group", {
      streamKey: options.streamKey,
      group: options.group,
      startId: options.startId,
    });
    return Result.ok(true);
  } catch (e) {
    if (Panic.is(e)) throw e;
    const msg = errorMessage(e);
    if (msg.includes("BUSYGROUP")) {
      options.logger?.debug("consumer group exists", {
        streamKey: options.streamKey,
        group: options.group,
      });
      return Result.ok(false);
    }
    return Result.err(
      new RedisConsumerGroupEnsureFailed({
        cause: e,
        streamKey: options.streamKey,
        group: options.group,
        message: "Redis consumer-group initialization failed",
      }),
    );
  }
}

class RedisConsumerGroupEnsureFailed extends TaggedError("RedisConsumerGroupEnsureFailed")<{
  readonly cause: unknown;
  readonly streamKey: string;
  readonly group: string;
  readonly message: string;
}> {}

/** Options for `RedisStreamsBus`. */
export type RedisStreamsBusOptions = {
  /** Connected ioredis instance. */
  redis: Redis;
  /**
   * Stream key prefix.
   *
   * Defaults to `lilac:event-bus`.
   */
  keyPrefix?: string;

  /**
   * If true, `close()` will call `redis.quit()`.
   *
   * Default: false (assume the caller owns the shared Redis client).
   */
  ownsRedis?: boolean;

  /**
   * Pool config for subscription connections.
   *
   * Subscriptions use blocking `XREAD`/`XREADGROUP`, which would otherwise block
   * publishes on a shared ioredis connection.
   */
  subscriberPool?: {
    /** Initial max duplicated clients used by subscriptions. Default: 16. */
    max?: number;
    /** Optional background warm-up count. Default: 0. */
    warm?: number;
    /** Optional autoscaling config (default disabled). */
    autoscale?: RedisConnectionPoolAutoscaleOptions;
  };
};

/** Redis Streams-backed implementation of `RawBus`. */
export class RedisStreamsBus implements RawBus {
  private readonly redis: Redis;
  private readonly keyPrefix: string;
  private readonly ownsRedis: boolean;
  private readonly logger: Logger;
  private readonly subPool: RedisConnectionPool;
  private readonly trimTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly activeTrims = new Set<Promise<void>>();
  private acknowledgedTrimPanic: Panic | null = null;
  private closing = false;

  /** Create a new bus using an existing ioredis client. */
  constructor(options: RedisStreamsBusOptions) {
    this.redis = options.redis;
    this.keyPrefix = options.keyPrefix ?? "lilac:event-bus";
    this.ownsRedis = options.ownsRedis ?? false;
    this.logger = createLogger({
      module: "event-bus:redis-streams",
    });

    const poolCfg = options.subscriberPool;
    const max = poolCfg?.max ?? 16;
    const warm = poolCfg?.warm ?? 0;
    const poolOpts: RedisConnectionPoolOptions = {
      base: this.redis,
      max,
      warm,
      onExhausted: "fallback_to_shared_with_warn",
      autoscale: poolCfg?.autoscale,
      logger: this.logger,
      label: "event-bus:subscribe",
    };

    this.subPool = new RedisConnectionPool(poolOpts);
  }

  private streamKey(topic: Topic): string {
    return `${this.keyPrefix}:${topic}`;
  }

  private isOutputTopic(topic: Topic): boolean {
    return topic.startsWith("out.req.");
  }

  private scheduleAcknowledgedTrim(topic: Topic, streamKey: string): void {
    if (
      this.closing ||
      this.isOutputTopic(topic) ||
      TAIL_REPLAY_TOPICS.has(topic) ||
      this.trimTimers.has(streamKey)
    ) {
      return;
    }

    const timer = setTimeout(() => {
      this.trimTimers.delete(streamKey);
      this.startAcknowledgedTrim(topic, streamKey);
    }, TRIM_DEBOUNCE_MS);
    timer.unref?.();
    this.trimTimers.set(streamKey, timer);
  }

  private startAcknowledgedTrim(topic: Topic, streamKey: string): void {
    const activeTrim = this.captureAcknowledgedTrim(topic, streamKey);
    this.activeTrims.add(activeTrim);
    void activeTrim.then(() => this.activeTrims.delete(activeTrim));
  }

  private async captureAcknowledgedTrim(topic: Topic, streamKey: string): Promise<void> {
    try {
      await this.trimAcknowledgedPrefix(topic, streamKey);
    } catch (cause) {
      if (Panic.is(cause)) {
        if (this.acknowledgedTrimPanic === null) this.acknowledgedTrimPanic = cause;
        return;
      }
      this.logger.error("event_bus.trim_failed", { topic }, cause);
    }
  }

  async flushPendingTrims(): Promise<void> {
    for (const [streamKey, timer] of this.trimTimers) {
      clearTimeout(timer);
      this.trimTimers.delete(streamKey);
      this.startAcknowledgedTrim(streamKey.slice(this.keyPrefix.length + 1), streamKey);
    }
    await Promise.allSettled(this.activeTrims);
    if (this.acknowledgedTrimPanic !== null) throw this.acknowledgedTrimPanic;
  }

  private async trimAcknowledgedPrefix(topic: Topic, streamKey: string): Promise<void> {
    const trimmed = await this.redis.eval(TRIM_ACKNOWLEDGED_PREFIX_SCRIPT, 1, streamKey);
    if (typeof trimmed !== "number" || !isRedisCount(trimmed)) {
      throw new Panic({ message: "Redis XTRIM returned an invalid count" });
    }
    if (trimmed > 0) {
      this.logger.debug("event_bus.trimmed", { topic, trimmed });
    }
  }

  async trimBeforeCheckpoint(
    topic: Topic,
    checkpoint: Cursor,
    safetyMargin: number,
  ): Promise<number> {
    const retainedCount = Math.max(1, Math.floor(safetyMargin));
    const trimmed = await this.redis.eval(
      TRIM_BEFORE_CHECKPOINT_SCRIPT,
      1,
      this.streamKey(topic),
      checkpoint,
      String(retainedCount),
      EPHEMERAL_GROUP_PREFIX,
    );
    if (typeof trimmed !== "number" || !isRedisCount(trimmed)) {
      throw new Panic({ message: "Redis XTRIM returned an invalid count" });
    }
    if (trimmed > 0) {
      this.logger.debug("event_bus.checkpoint_trimmed", { topic, checkpoint, trimmed });
    }
    return trimmed;
  }

  async retireConsumerGroup(
    topic: Topic,
    group: string,
    confirmSingleVersionRollout: boolean,
  ): Promise<"absent" | "destroyed"> {
    const result = await this.redis.eval(
      RETIRE_CONSUMER_GROUP_SCRIPT,
      1,
      this.streamKey(topic),
      group,
      confirmSingleVersionRollout ? "1" : "0",
    );
    if (result === -1) {
      throw new Error(
        `Refusing to retire consumer group ${group} without a confirmed single-version rollout`,
      );
    }
    if (result === 0) return "absent";
    if (result === 1) return "destroyed";
    throw new Panic({ message: "Redis XGROUP DESTROY returned an invalid result" });
  }

  /** Publish a message via `XADD`. */
  async publish<TData>(
    msg: PublishMessage<TData>,
    opts: PublishOptions,
  ): Promise<{ id: string; cursor: Cursor }> {
    const streamKey = this.streamKey(opts.topic);
    const ts = Date.now();
    const startedAt = Date.now();

    const fields: string[] = [
      "type",
      opts.type,
      "ts",
      String(ts),
      "data",
      SuperJSON.stringify(msg.data ?? null),
    ];

    if (opts.key) {
      fields.push("key", opts.key);
    }

    if (opts.headers) {
      fields.push("headers", SuperJSON.stringify(opts.headers));
    }

    // If requested, apply approximate trimming.
    // TODO: decide retention policy and move to config.
    const xaddArgs =
      opts.retention?.maxLenApprox && !TAIL_REPLAY_TOPICS.has(opts.topic)
        ? ["MAXLEN", "~", String(opts.retention.maxLenApprox), "*", ...fields]
        : ["*", ...fields];
    const id = this.isOutputTopic(opts.topic)
      ? await this.redis.eval(
          XADD_WITH_EXPIRY_SCRIPT,
          1,
          streamKey,
          String(OUTPUT_STREAM_TTL_SECONDS),
          ...xaddArgs,
        )
      : await this.redis.xadd(streamKey, ...xaddArgs);

    if (typeof id !== "string" || !isRedisStreamId(id)) {
      throw new Panic({ message: "Redis XADD returned invalid id" });
    }

    this.logger.debug("event_bus.publish", {
      topic: opts.topic,
      type: opts.type,
      key: opts.key,
      messageId: id,
      hasHeaders: Boolean(opts.headers),
      durationMs: Date.now() - startedAt,
    });

    return { id, cursor: id };
  }

  /** Fetch messages via `XREAD` (non-durable, no consumer group). */
  async fetch(topic: Topic, opts: FetchOptions) {
    const streamKey = this.streamKey(topic);
    const limit = opts.limit ?? DEFAULT_MAX_MESSAGES;

    const startId = redisIdForOffset(opts.offset);

    const res = (await this.redis.xread(
      "COUNT",
      String(limit),
      "STREAMS",
      streamKey,
      startId,
    )) as unknown;

    const messages: Array<{
      msg: RawMessageDecodeOutcome;
      cursor: Cursor;
      evidence: EventTransportEvidence;
    }> = [];

    const decodedResponse = decodeRedisReadResponse(res, topic, streamKey, this.logger);
    if (decodedResponse.status === "error") throw new Error(decodedResponse.message);
    for (const entry of decodedResponse.value) {
      messages.push({
        msg: entry.message,
        cursor: entry.id,
        evidence: entry.evidence,
      });
    }

    const next = messages.length > 0 ? messages[messages.length - 1]!.cursor : undefined;
    return { messages, next };
  }

  async watermark(topic: Topic): Promise<Cursor | null> {
    const entries = (await this.redis.xrevrange(
      this.streamKey(topic),
      "+",
      "-",
      "COUNT",
      1,
    )) as unknown;
    const decoded = decodeRedisWatermarkResponse(entries);
    if (decoded.status === "error") throw new Error(decoded.message);
    return decoded.value;
  }

  /** Subscribe with transport-owned delivery actions and typed operational Results. */
  async subscribe(
    topic: Topic,
    opts: SubscriptionOptions,
    handler: RawDeliveryHandler,
    dependencies: RawDeliveryDependencies = {},
  ): Promise<
    ResultType<
      {
        readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
        stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
      },
      EventDeliveryStartFailed
    >
  > {
    const streamKey = this.streamKey(topic);
    const abortController = new AbortController();
    const acquired = await this.subPool.acquire();
    if (acquired.status === "error") {
      return Result.err(
        new EventDeliveryStartFailed({
          cause: acquired.error,
          topic,
          message: "Failed to acquire a Redis delivery connection",
        }),
      );
    }
    const lease = acquired.value;

    const subRedis = lease.redis;
    let disconnectOnStop = false;
    let releaseUnhealthy = false;
    let group: string | null = null;
    let consumerId: string | null = null;
    let createdGroup = false;
    const ephemeral = opts.mode !== "tail" && Boolean(opts.ephemeral);
    const maxMessages = opts.batch?.maxMessages ?? DEFAULT_MAX_MESSAGES;
    const blockMs = Math.min(Math.max(1, opts.batch?.maxWaitMs ?? DEFAULT_BLOCK_MS), 30_000);

    try {
      if (opts.mode === "work" || opts.mode === "fanout") {
        if (!opts.ephemeral && opts.subscriptionId.startsWith(EPHEMERAL_GROUP_PREFIX)) {
          throw new Error(`Consumer group uses reserved prefix: ${EPHEMERAL_GROUP_PREFIX}`);
        }
        group = opts.ephemeral
          ? `${EPHEMERAL_GROUP_PREFIX}${opts.subscriptionId}`
          : opts.subscriptionId;
        consumerId = opts.consumerId ?? randomConsumerId();
        const startId = opts.offset?.type === "begin" ? "0-0" : "$";
        const ensuredGroup = await ensureGroup({
          redis: subRedis,
          streamKey,
          group,
          startId,
          logger: this.logger,
        });
        if (ensuredGroup.status === "error") {
          if (!lease.shared) await lease.release({ unhealthy: true });
          return Result.err(
            new EventDeliveryStartFailed({
              cause: ensuredGroup.error,
              topic,
              message: "Failed to initialize Redis delivery",
            }),
          );
        }
        createdGroup = ensuredGroup.value;
        if (opts.ephemeral && !createdGroup) {
          throw new Error(`Ephemeral consumer group already exists: ${group}`);
        }
      }
    } catch (cause) {
      if (!lease.shared) await lease.release({ unhealthy: true }).catch(() => undefined);
      if (Panic.is(cause)) throw cause;
      return Result.err(
        new EventDeliveryStartFailed({
          cause,
          topic,
          message: "Failed to initialize Redis delivery",
        }),
      );
    }

    const reportFatal = async (
      cause: unknown,
      cursor: Cursor,
      phase: "handler" | "dead-letter" | "delivery-action",
    ): Promise<void> => {
      try {
        await dependencies.reportFatal?.report(cause, { topic, cursor, phase });
      } catch (reportCause) {
        dependencies.logger?.error("event_bus.fatal_report_failed", { topic, cursor, phase });
        this.logger.error("event_bus.fatal_report_failed", { topic, cursor, phase }, reportCause);
      }
    };

    const acknowledge = async (
      id: Cursor,
    ): Promise<ResultType<void, EventDeliveryTransportFailed>> => {
      if (!group) return Result.ok(undefined);
      try {
        const acknowledged = await subRedis.xack(streamKey, group, id);
        if (acknowledged !== 1) {
          return Result.err(
            new EventDeliveryTransportFailed({
              cause: new Error(`Redis XACK acknowledged ${String(acknowledged)} entries`),
              operation: "ack",
              topic,
              cursor: id,
              message: "Redis delivery acknowledgement failed",
            }),
          );
        }
        this.scheduleAcknowledgedTrim(topic, streamKey);
        return Result.ok(undefined);
      } catch (cause) {
        if (Panic.is(cause)) throw cause;
        return Result.err(
          new EventDeliveryTransportFailed({
            cause,
            operation: "ack",
            topic,
            cursor: id,
            message: "Redis delivery acknowledgement failed",
          }),
        );
      }
    };

    const handleEntry = async (
      entry: RedisReadEntry,
    ): Promise<
      | { readonly status: "advance" }
      | { readonly status: "park" }
      | { readonly status: "stop"; readonly error: EventDeliveryStopped }
      | { readonly status: "transport-error"; readonly error: EventDeliveryTransportFailed }
    > => {
      const id = entry.id;
      let action: RawDeliveryAction;
      try {
        action = deliveryAction(
          await handler(entry.message, { cursor: id, mode: opts.mode, evidence: entry.evidence }),
        );
      } catch (cause) {
        const phase = Panic.is(cause) ? "delivery-action" : "handler";
        await reportFatal(cause, id, phase);
        throw cause;
      }

      switch (action.disposition) {
        case "commit": {
          const acknowledged = await acknowledge(id);
          if (acknowledged.status === "error") {
            return { status: "transport-error", error: acknowledged.error };
          }
          return { status: "advance" };
        }
        case "park-pending":
          if (opts.mode !== "tail") return { status: "park" };
          return {
            status: "stop",
            error: new EventDeliveryStopped({
              reason: "tail-cannot-park",
              topic,
              cursor: id,
              message: "Tail delivery stopped because park-pending is not durable in tail mode",
            }),
          };
        case "stop":
          return {
            status: "stop",
            error: new EventDeliveryStopped({
              reason: "requested",
              topic,
              cursor: id,
              message: "Event delivery policy requested stop",
            }),
          };
        case "dead-letter": {
          let accepted: ResultType<EventDeadLetterAcceptance, EventDeadLetterAcceptFailed>;
          if (!dependencies.deadLetter) {
            accepted = Result.err(
              new EventDeadLetterAcceptFailed({
                cause: undefined,
                message: "No event dead-letter adapter is configured",
              }),
            );
          } else {
            try {
              accepted = checkedDeadLetterAcceptance(
                await dependencies.deadLetter.accept(action.record),
              );
            } catch (cause) {
              await reportFatal(cause, id, "dead-letter");
              throw cause;
            }
          }

          if (accepted.status === "error") {
            dependencies.logger?.error("event_bus.dead_letter_failed", {
              topic,
              cursor: id,
              mode: opts.mode,
            });
            if (opts.mode !== "tail") return { status: "park" };
            return {
              status: "stop",
              error: new EventDeliveryStopped({
                reason: "dead-letter-failed",
                topic,
                cursor: id,
                message: "Tail delivery stopped after dead-letter acceptance failed",
              }),
            };
          }

          const acknowledged = await acknowledge(id);
          if (acknowledged.status === "error") {
            return { status: "transport-error", error: acknowledged.error };
          }
          return { status: "advance" };
        }
      }
    };

    const readFailure = (cause: unknown, cursor?: Cursor): EventDeliveryTransportFailed =>
      new EventDeliveryTransportFailed({
        cause,
        operation: "read",
        topic,
        cursor,
        message: "Redis delivery read failed",
      });

    const runLoop = async (): Promise<ResultType<void, EventDeliveryDoneError>> => {
      if (opts.mode === "tail") {
        let cursor = redisIdForOptionalOffset(opts.offset);
        while (!abortController.signal.aborted) {
          let response: unknown;
          try {
            response = await subRedis.xread(
              "COUNT",
              String(maxMessages),
              "BLOCK",
              String(blockMs),
              "STREAMS",
              streamKey,
              cursor,
            );
          } catch (cause) {
            if (Panic.is(cause)) throw cause;
            if (
              disconnectOnStop &&
              abortController.signal.aborted &&
              cause instanceof Error &&
              cause.name === "Error" &&
              cause.message === "Connection is closed."
            ) {
              return Result.ok(undefined);
            }
            releaseUnhealthy = true;
            return Result.err(readFailure(cause, cursor));
          }

          const decodedResponse = decodeRedisReadResponse(response, topic, streamKey, this.logger);
          if (decodedResponse.status === "error") {
            releaseUnhealthy = true;
            return Result.err(readFailure(new Error(decodedResponse.message), cursor));
          }
          for (const entry of decodedResponse.value) {
            const handled = await handleEntry(entry);
            if (handled.status === "stop") return Result.err(handled.error);
            if (handled.status === "transport-error") return Result.err(handled.error);
            if (handled.status === "park") {
              throw new Panic({ message: "Tail delivery produced an impossible park action" });
            }
            cursor = entry.id;
          }
        }
        return Result.ok(undefined);
      }

      if (!group || !consumerId) {
        throw new Panic({ message: "Redis delivery started without a group and consumer" });
      }
      while (!abortController.signal.aborted) {
        let response: unknown;
        try {
          response = await subRedis.xreadgroup(
            "GROUP",
            group,
            consumerId,
            "COUNT",
            String(maxMessages),
            "BLOCK",
            String(blockMs),
            "STREAMS",
            streamKey,
            ">",
          );
        } catch (cause) {
          if (Panic.is(cause)) throw cause;
          if (
            disconnectOnStop &&
            abortController.signal.aborted &&
            cause instanceof Error &&
            cause.name === "Error" &&
            cause.message === "Connection is closed."
          ) {
            return Result.ok(undefined);
          }
          releaseUnhealthy = true;
          return Result.err(readFailure(cause));
        }

        const decodedResponse = decodeRedisReadResponse(response, topic, streamKey, this.logger);
        if (decodedResponse.status === "error") {
          releaseUnhealthy = true;
          return Result.err(readFailure(new Error(decodedResponse.message)));
        }
        for (const entry of decodedResponse.value) {
          const handled = await handleEntry(entry);
          if (handled.status === "stop") return Result.err(handled.error);
          if (handled.status === "transport-error") return Result.err(handled.error);
        }
      }
      return Result.ok(undefined);
    };

    type CleanupAttempt =
      | { readonly status: "ok" }
      | { readonly status: "error"; readonly cause: unknown };
    let leaseCleanup: Promise<CleanupAttempt> | null = null;
    const cleanupLease = (): Promise<CleanupAttempt> => {
      leaseCleanup ??= (async () => {
        if (lease.shared) return { status: "ok" };
        try {
          await lease.release({ unhealthy: disconnectOnStop || releaseUnhealthy });
          return { status: "ok" };
        } catch (cause) {
          return { status: "error", cause };
        }
      })();
      return leaseCleanup;
    };

    type LoopCompletion =
      | { readonly status: "completed" }
      | { readonly status: "defect"; readonly cause: unknown };
    let settleLoopCompletion!: (completion: LoopCompletion) => void;
    const loopCompletion = new Promise<LoopCompletion>((resolve) => {
      settleLoopCompletion = resolve;
    });
    const running: Promise<ResultType<void, EventDeliveryDoneError>> = (async () => {
      try {
        const loopResult = await runLoop();
        const released = await cleanupLease();
        if (released.status === "error") {
          if (Panic.is(released.cause)) throw released.cause;
          return Result.err(
            new EventDeliveryTransportFailed({
              cause: released.cause,
              operation: "cleanup",
              topic,
              message: "Redis delivery lease cleanup failed",
            }),
          );
        }
        return loopResult;
      } catch (cause) {
        await cleanupLease();
        settleLoopCompletion({ status: "defect", cause });
        throw cause;
      } finally {
        settleLoopCompletion({ status: "completed" });
      }
    })();
    void running.catch(() => undefined);

    const cleanupGroup = async (): Promise<CleanupAttempt> => {
      try {
        if (group && consumerId) {
          if (ephemeral && createdGroup) {
            const destroyed = await this.redis.xgroup("DESTROY", streamKey, group);
            if (destroyed !== 1) {
              throw new Error("Redis XGROUP DESTROY returned an invalid cleanup response");
            }
            this.scheduleAcknowledgedTrim(topic, streamKey);
          } else {
            const pending = (await this.redis.xpending(
              streamKey,
              group,
              "-",
              "+",
              1,
              consumerId,
            )) as unknown;
            if (!Array.isArray(pending)) {
              throw new Error("Redis XPENDING returned an invalid cleanup response");
            }
            if (pending.length === 0) {
              const removed = await this.redis.xgroup("DELCONSUMER", streamKey, group, consumerId);
              if (typeof removed !== "number" || !isRedisCount(removed)) {
                throw new Error("Redis XGROUP DELCONSUMER returned an invalid cleanup response");
              }
            }
          }
        }
        return { status: "ok" };
      } catch (cause) {
        return { status: "error", cause };
      }
    };

    return Result.ok({
      done: running,
      stop: async () => {
        abortController.abort();
        if (!lease.shared && blockMs > 500) {
          disconnectOnStop = true;
          subRedis.disconnect();
        }
        const completedLoop = await loopCompletion;
        const groupCleanup = await cleanupGroup();
        const released = await cleanupLease();

        if (completedLoop.status === "defect") throw completedLoop.cause;
        if (groupCleanup.status === "error" && Panic.is(groupCleanup.cause)) {
          throw groupCleanup.cause;
        }
        if (released.status === "error" && Panic.is(released.cause)) throw released.cause;
        if (groupCleanup.status === "error") {
          return Result.err(
            new EventDeliveryStopFailed({
              cause: groupCleanup.cause,
              topic,
              message: "Redis delivery cleanup failed",
            }),
          );
        }
        if (released.status === "error") {
          return Result.err(
            new EventDeliveryStopFailed({
              cause: released.cause,
              topic,
              message: "Redis delivery lease cleanup failed",
            }),
          );
        }
        return Result.ok(undefined);
      },
    });
  }

  /** Close the bus (no-op unless `ownsRedis` was set). */
  async close(): Promise<void> {
    this.closing = true;
    for (const timer of this.trimTimers.values()) clearTimeout(timer);
    this.trimTimers.clear();
    await Promise.allSettled(this.activeTrims);
    await this.subPool.close();
    if (this.ownsRedis) {
      // Do not `disconnect()` because it drops queued commands; `quit()` is clean.
      await this.redis.quit();
    }

    if (this.acknowledgedTrimPanic !== null) throw this.acknowledgedTrimPanic;
  }
}

/** Convenience factory for `RedisStreamsBus`. */
export function createRedisStreamsBus(options: RedisStreamsBusOptions): RedisStreamsBus {
  return new RedisStreamsBus(options);
}
