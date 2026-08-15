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
  createAttemptsExhaustedDeadLetterReason,
  createManagedEventDeadLetterRecord,
  createTailEventDeadLetterRecord,
  EventDeadLetterAcceptFailed,
  type EventDeadLetterAcceptance,
  type EventDeadLetterReason,
  type EventTransportEvidence,
} from "./event-dead-letter";
import {
  RedisConnectionPool,
  type RedisConnectionPoolOptions,
  type RedisConnectionPoolAutoscaleOptions,
  type RedisLease,
} from "./redis-connection-pool";
import {
  MANAGED_REDIS_HEARTBEAT_MS,
  managedRedisPhysicalGroup,
  RedisManagedDelivery,
  type ManagedClaim,
  type ManagedExhaustionFailure,
  type ManagedLease,
  type ManagedTerminalMaterial,
} from "./redis-managed-delivery";
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
const TAIL_REPLAY_TOPICS = new Set<Topic>(["evt.request", "evt.adapter"]);
const MAX_EVIDENCE_VALUES = 32;
const MAX_EVIDENCE_VALUE_CHARS = 1024;
const STRING_HEADERS_SCHEMA = z.record(z.string(), z.string());
const REDIS_STREAM_ID_PATTERN = /^\d+-\d+$/;
const HANDLER_FAILURE_SCHEMA = z.object({
  kind: z.literal("handler-error"),
  errorTag: z.string(),
  errorMessage: z.string(),
});
const DEAD_LETTER_REASON_SCHEMA = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("contract-invalid"),
    diagnostic: z.literal("event_bus.contract_invalid"),
    stage: z.enum(["transport", "envelope", "event_type", "headers", "topic", "key", "payload"]),
    eventType: z.string().optional(),
    issues: z.array(z.string()),
  }),
  HANDLER_FAILURE_SCHEMA,
  z.object({
    kind: z.literal("attempts-exhausted"),
    finalFailure: z.union([HANDLER_FAILURE_SCHEMA, z.object({ kind: z.literal("lease-expired") })]),
  }),
]);

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
  local boundary = last_delivered_id
  if pending > 0 then
    local pending_summary = redis.call("XPENDING", KEYS[1], name)
    boundary = pending_summary[2]
    if not boundary then return 0 end
  end
  if boundary == "0-0" then return 0 end
  if less_than(boundary, watermark) then watermark = boundary end
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

const redisStreamEntrySchema = z
  .array(z.unknown())
  .length(2)
  .pipe(z.tuple([z.unknown(), z.unknown()]))
  .transform(([id, fields]) => ({ id, fields }));
const redisReadStreamSchema = z
  .array(z.unknown())
  .length(2)
  .pipe(z.tuple([z.unknown(), z.array(redisStreamEntrySchema)]))
  .transform(([streamKey, entries]) => ({ streamKey, entries }));
const redisReadResponseSchema = z
  .array(z.unknown())
  .length(1)
  .pipe(z.tuple([redisReadStreamSchema]))
  .transform(([stream]) => stream)
  .nullable();
const redisRangeResponseSchema = z
  .array(z.unknown())
  .length(1)
  .pipe(z.tuple([redisStreamEntrySchema]))
  .transform(([entry]) => entry);
const redisWatermarkEntrySchema = z
  .array(z.unknown())
  .length(2)
  .pipe(z.tuple([z.unknown(), z.array(z.unknown())]))
  .transform(([id, fields]) => ({ id, fields }));
const redisWatermarkResponseSchema = z
  .array(redisWatermarkEntrySchema)
  .max(1)
  .transform(([entry]) => ({ entry: entry ?? null }));
const redisPendingSummarySchema = z
  .array(z.unknown())
  .min(3)
  .pipe(
    z
      .tuple([
        z.number().refine(isRedisCount),
        z.string().refine(isRedisStreamId).nullable(),
        z.unknown(),
      ])
      .rest(z.unknown()),
  )
  .transform(([count, oldestId]) => ({ count, oldestId }));
const redisOldestPendingEntrySchema = z
  .array(z.unknown())
  .min(3)
  .pipe(z.tuple([z.unknown(), z.unknown(), z.number().refine(isRedisCount)]).rest(z.unknown()))
  .transform(([, , oldestIdleMs]) => ({ oldestIdleMs }));
const redisOldestPendingResponseSchema = z
  .array(z.unknown())
  .length(1)
  .pipe(z.tuple([redisOldestPendingEntrySchema]))
  .transform(([entry]) => entry);
const redisCleanupPendingPresenceSchema = z
  .array(z.unknown())
  .transform((entries) => ({ hasPendingEntries: entries.length > 0 }));

function decodeRedisReadResponse(
  response: unknown,
  topic: Topic,
  expectedStreamKey: string,
  logger?: Logger,
): RedisResponseDecodeResult<readonly RedisReadEntry[]> {
  const decoded = redisReadResponseSchema.safeParse(response);
  if (!decoded.success) {
    let message = "Redis XREAD returned an invalid stream collection";
    if (decoded.error.issues.some((issue) => issue.path.length >= 3)) {
      message = "Redis XREAD returned an invalid message entry";
    } else if (decoded.error.issues.some((issue) => issue.path.length > 0)) {
      message = "Redis XREAD returned an invalid stream entry";
    }
    return { status: "error", message };
  }
  if (decoded.data === null) return { status: "ok", value: [] };
  if (decoded.data.streamKey !== expectedStreamKey) {
    return { status: "error", message: "Redis XREAD returned an invalid stream entry" };
  }

  const entries: RedisReadEntry[] = [];
  for (const entry of decoded.data.entries) {
    if (typeof entry.id !== "string" || !isRedisStreamId(entry.id)) {
      return { status: "error", message: "Redis XREAD returned an invalid message id" };
    }
    entries.push({
      id: entry.id,
      message: decodeMessage(topic, decoded.data.streamKey, entry.id, entry.fields, logger),
      evidence: redisTransportEvidence(topic, decoded.data.streamKey, entry.id, entry.fields),
    });
  }
  return { status: "ok", value: entries };
}

function decodeRedisRangeResponse(
  response: unknown,
  topic: Topic,
  streamKey: string,
  expectedId: string,
  logger?: Logger,
): RedisResponseDecodeResult<RedisReadEntry> {
  const decoded = redisRangeResponseSchema.safeParse(response);
  if (!decoded.success) {
    return {
      status: "error",
      message: decoded.error.issues.some((issue) => issue.path.length > 0)
        ? "Redis XRANGE returned an invalid source entry"
        : "Redis XRANGE did not return exactly one source entry",
    };
  }
  if (
    decoded.data.id !== expectedId ||
    typeof decoded.data.id !== "string" ||
    !isRedisStreamId(decoded.data.id)
  ) {
    return { status: "error", message: "Redis XRANGE returned an invalid source entry" };
  }
  return {
    status: "ok",
    value: {
      id: decoded.data.id,
      message: decodeMessage(topic, streamKey, decoded.data.id, decoded.data.fields, logger),
      evidence: redisTransportEvidence(topic, streamKey, decoded.data.id, decoded.data.fields),
    },
  };
}

function decodeRedisWatermarkResponse(
  response: unknown,
): RedisResponseDecodeResult<{ readonly watermark: string | null }> {
  const decoded = redisWatermarkResponseSchema.safeParse(response);
  if (!decoded.success) {
    let message = "Redis XREVRANGE returned an invalid entry collection";
    if (decoded.error.issues.some((issue) => issue.path.length > 0)) {
      message = "Redis XREVRANGE returned an invalid entry";
    } else if (decoded.error.issues.some((issue) => issue.code === "too_big")) {
      message = "Redis XREVRANGE returned too many entries";
    }
    return { status: "error", message };
  }
  if (decoded.data.entry === null) return { status: "ok", value: { watermark: null } };
  if (typeof decoded.data.entry.id !== "string" || !isRedisStreamId(decoded.data.entry.id)) {
    return { status: "error", message: "Redis XREVRANGE returned an invalid entry" };
  }
  return { status: "ok", value: { watermark: decoded.data.entry.id } };
}

type RedisPendingSummaryValue = { readonly count: number; readonly oldestId: string | null };

function decodeRedisPendingSummary(
  response: unknown,
): RedisResponseDecodeResult<RedisPendingSummaryValue> {
  const decoded = redisPendingSummarySchema.safeParse(response);
  if (!decoded.success) {
    return {
      status: "error",
      message: decoded.error.issues.some((issue) => issue.path.length > 0)
        ? "Redis XPENDING returned invalid summary fields"
        : "Redis XPENDING returned an invalid summary",
    };
  }
  return { status: "ok", value: decoded.data };
}

function decodeRedisOldestPendingIdle(
  response: unknown,
): RedisResponseDecodeResult<{ readonly oldestIdleMs: number }> {
  const decoded = redisOldestPendingResponseSchema.safeParse(response);
  if (!decoded.success) {
    return { status: "error", message: "Redis XPENDING returned an invalid oldest entry" };
  }
  return { status: "ok", value: decoded.data };
}

function decodeRedisCleanupPendingPresence(
  response: unknown,
): RedisResponseDecodeResult<{ readonly hasPendingEntries: boolean }> {
  const decoded = redisCleanupPendingPresenceSchema.safeParse(response);
  if (!decoded.success) {
    return { status: "error", message: "Redis XPENDING returned an invalid cleanup response" };
  }
  return { status: "ok", value: decoded.data };
}

class RedisPendingInspectionFailed extends TaggedError("RedisPendingInspectionFailed")<{
  readonly message: string;
}> {}

async function captureRedisPendingSummary(
  redis: Redis,
  streamKey: string,
  group: string,
): Promise<
  ResultType<{ count: number; oldestIdleMs: number | null }, RedisPendingInspectionFailed>
> {
  try {
    const summary = decodeRedisPendingSummary((await redis.xpending(streamKey, group)) as unknown);
    if (summary.status === "error") {
      return Result.err(new RedisPendingInspectionFailed({ message: summary.message }));
    }
    if (summary.value.count === 0) return Result.ok({ count: 0, oldestIdleMs: null });
    const oldest = decodeRedisOldestPendingIdle(
      (await redis.xpending(streamKey, group, "-", "+", 1)) as unknown,
    );
    if (oldest.status === "error") {
      return Result.err(new RedisPendingInspectionFailed({ message: oldest.message }));
    }
    return Result.ok({ count: summary.value.count, oldestIdleMs: oldest.value.oldestIdleMs });
  } catch {
    return Result.err(
      new RedisPendingInspectionFailed({ message: "Redis pending inspection failed" }),
    );
  }
}

type RedisFieldsDecodeResult =
  | { status: "ok"; value: { readonly fields: Record<string, string> } }
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
    case "retry": {
      const failure = Reflect.get(value, "failure");
      if (!HANDLER_FAILURE_SCHEMA.safeParse(failure).success) {
        throw new Panic({ message: "Retry disposition has an invalid handler failure" });
      }
      return value;
    }
    case "dead-letter": {
      const reason = Reflect.get(value, "reason");
      if (!DEAD_LETTER_REASON_SCHEMA.safeParse(reason).success) {
        throw new Panic({ message: "Dead-letter disposition has an invalid reason" });
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
  const record: Record<string, string> = {};
  let key: string | undefined;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (typeof field !== "string") {
      issues.push({ field: "entry", reason: "non_string_field", index });
    }
    if (index % 2 === 0) {
      key = typeof field === "string" ? field : undefined;
    } else {
      if (key !== undefined && typeof field === "string") record[key] = field;
      key = undefined;
    }
  }
  if (issues.length > 0) return { status: "error", issues };
  return { status: "ok", value: { fields: record } };
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
  const record = fieldsResult.value.fields;

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
  private readonly ownerId = randomConsumerId();
  private readonly trimTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly activeTrims = new Set<Promise<void>>();
  private readonly activeSubscriptionStops = new Set<
    () => Promise<ResultType<void, EventDeliveryStopFailed>>
  >();
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

  private async observePendingEntries(
    topic: Topic,
    streamKey: string,
    group: string,
    trigger: "parked" | "subscription_start",
  ): Promise<void> {
    const inspected = await captureRedisPendingSummary(this.redis, streamKey, group);
    const report = inspected.match<() => void>({
      err: () => () => {
        this.logger.warn("event_bus.pending_inspection_failed", { topic, group, trigger });
      },
      ok:
        ({ count: pendingCount, oldestIdleMs }) =>
        () => {
          if (pendingCount === 0) return;
          this.logger.warn("event_bus.pending_entries", {
            topic,
            group,
            trigger,
            pendingCount,
            oldestPendingIdleMs: oldestIdleMs,
          });
        },
    });
    report();
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

    const xaddArgs = ["*", ...fields];
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
    return decoded.value.watermark;
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
    if (opts.mode !== "tail" && this.isOutputTopic(topic)) {
      return Result.err(
        new EventDeliveryStartFailed({
          cause: new Error("Expiring output streams support tail subscriptions only"),
          topic,
          message: "Durable Redis delivery is not supported for output streams",
        }),
      );
    }

    const abortController = new AbortController();
    const acquired = await this.subPool.acquire();
    const lease = acquired.match<RedisLease | EventDeliveryStartFailed>({
      ok: (value) => value,
      err: (error) =>
        new EventDeliveryStartFailed({
          cause: error,
          topic,
          message: "Failed to acquire a Redis delivery connection",
        }),
    });
    if (EventDeliveryStartFailed.is(lease)) {
      return Result.err(lease);
    }

    const subRedis = lease.redis;
    let disconnectOnStop = false;
    let releaseUnhealthy = false;
    let group: string | null = null;
    let consumerId: string | null = null;
    let managedDelivery: RedisManagedDelivery | null = null;
    let managedRedisClient: Redis | null = null;
    let createdGroup = false;
    const ephemeral = opts.mode !== "tail" && Boolean(opts.ephemeral);
    const ephemeralIncarnation = ephemeral ? randomConsumerId() : undefined;
    const tailMaxMessages =
      opts.mode === "tail" ? (opts.batch?.maxMessages ?? DEFAULT_MAX_MESSAGES) : 1;
    const blockMs = Math.min(Math.max(1, opts.batch?.maxWaitMs ?? DEFAULT_BLOCK_MS), 1_000);

    try {
      if (opts.mode === "work" || opts.mode === "fanout") {
        consumerId = opts.consumerId ?? randomConsumerId();
        group = managedRedisPhysicalGroup(
          opts.mode,
          opts.subscriptionId,
          ephemeral,
          ephemeralIncarnation,
        );
        const ensuredGroup = await ensureGroup({
          redis: subRedis,
          streamKey,
          group,
          startId: "$",
          logger: this.logger,
        });
        const initializedGroup = ensuredGroup.match<boolean | EventDeliveryStartFailed>({
          ok: (value) => value,
          err: (error) =>
            new EventDeliveryStartFailed({
              cause: error,
              topic,
              message: "Failed to initialize Redis delivery",
            }),
        });
        if (EventDeliveryStartFailed.is(initializedGroup)) {
          if (!lease.shared) await lease.release({ unhealthy: true });
          return Result.err(initializedGroup);
        }
        createdGroup = initializedGroup;
        if (opts.ephemeral && !createdGroup) {
          throw new Error(`Ephemeral consumer group already exists: ${group}`);
        }
        if (!createdGroup) {
          void this.observePendingEntries(topic, streamKey, group, "subscription_start");
        }
        managedRedisClient = this.redis.duplicate();
        managedDelivery = new RedisManagedDelivery(
          managedRedisClient,
          streamKey,
          group,
          consumerId,
          this.ownerId,
        );
      }
    } catch (cause) {
      managedRedisClient?.disconnect();
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

    type EntryHandlingResult =
      | { readonly status: "advance" }
      | { readonly status: "park" }
      | { readonly status: "stop"; readonly error: EventDeliveryStopped }
      | { readonly status: "transport-error"; readonly error: EventDeliveryTransportFailed };

    const handleTailEntry = async (entry: RedisReadEntry): Promise<EntryHandlingResult> => {
      const id = entry.id;
      let action: RawDeliveryAction;
      try {
        action = deliveryAction(
          await handler(entry.message, { cursor: id, mode: "tail", evidence: entry.evidence }),
        );
      } catch (cause) {
        const phase = Panic.is(cause) ? "delivery-action" : "handler";
        await reportFatal(cause, id, phase);
        throw cause;
      }

      switch (action.disposition) {
        case "commit":
          return { status: "advance" };
        case "park-pending":
          return {
            status: "stop",
            error: new EventDeliveryStopped({
              reason: "tail-cannot-park",
              topic,
              cursor: id,
              message: "Tail delivery stopped because park-pending is not durable in tail mode",
            }),
          };
        case "retry":
          return {
            status: "stop",
            error: new EventDeliveryStopped({
              reason: "tail-cannot-park",
              topic,
              cursor: id,
              message: "Tail delivery stopped because retry is not supported in tail mode",
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
                await dependencies.deadLetter.accept(
                  createTailEventDeadLetterRecord({
                    topic,
                    cursor: id,
                    reason: action.reason,
                    evidence: entry.evidence,
                  }),
                ),
              );
            } catch (cause) {
              await reportFatal(cause, id, "dead-letter");
              throw cause;
            }
          }

          return accepted.match<EntryHandlingResult>({
            ok: () => ({ status: "advance" }),
            err: () => {
              dependencies.logger?.error("event_bus.dead_letter_failed", {
                topic,
                cursor: id,
                mode: opts.mode,
              });
              return {
                status: "stop",
                error: new EventDeliveryStopped({
                  reason: "dead-letter-failed",
                  topic,
                  cursor: id,
                  message: "Tail delivery stopped after dead-letter acceptance failed",
                }),
              };
            },
          });
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

    type ActiveAttempt = { shutdown(): void };
    let activeAttempt: ActiveAttempt | null = null;

    const runTailLoop = async (): Promise<ResultType<void, EventDeliveryDoneError>> => {
      if (opts.mode !== "tail") {
        throw new Panic({ message: "Tail delivery loop started for a durable subscription" });
      }
      let cursor = redisIdForOptionalOffset(opts.offset);
      while (!abortController.signal.aborted) {
        let response: unknown;
        try {
          response = await subRedis.xread(
            "COUNT",
            String(tailMaxMessages),
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
          const handled = await handleTailEntry(entry);
          if (handled.status === "stop") return Result.err(handled.error);
          if (handled.status === "transport-error") return Result.err(handled.error);
          if (handled.status === "park") {
            throw new Panic({ message: "Tail delivery produced an impossible park action" });
          }
          cursor = entry.id;
        }
      }
      return Result.ok(undefined);
    };

    const runDurableLoop = async (): Promise<ResultType<void, EventDeliveryDoneError>> => {
      if (
        opts.mode === "tail" ||
        group === null ||
        consumerId === null ||
        managedDelivery === null
      ) {
        throw new Panic({ message: "Managed Redis delivery started without durable identities" });
      }
      const mode = opts.mode;
      const physicalGroup = group;
      const managed = managedDelivery;

      type CapturedTransport<T> =
        | { readonly status: "ok"; readonly value: T }
        | { readonly status: "error"; readonly error: EventDeliveryTransportFailed };
      const captureTransport = async <T>(
        operation: () => Promise<T>,
        operationName: "read" | "ack",
        cursor: Cursor | undefined,
        message: string,
      ): Promise<CapturedTransport<T>> => {
        try {
          return { status: "ok", value: await operation() };
        } catch (cause) {
          if (Panic.is(cause)) throw cause;
          return {
            status: "error",
            error: new EventDeliveryTransportFailed({
              cause,
              operation: operationName,
              topic,
              cursor,
              message,
            }),
          };
        }
      };

      type LeaseLoss =
        | { readonly kind: "shutdown" }
        | { readonly kind: "stale" }
        | { readonly kind: "error"; readonly cause: unknown };
      const startLeaseHeartbeat = (id: Cursor, initialLease: ManagedLease) => {
        const attemptController = new AbortController();
        const lossResolvers = Promise.withResolvers<LeaseLoss>();
        let loss: LeaseLoss | null = null;
        let lease = initialLease;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let heartbeatTask: Promise<void> | null = null;

        const lose = (nextLoss: LeaseLoss): void => {
          if (loss !== null) return;
          loss = nextLoss;
          stopped = true;
          if (timer !== null) clearTimeout(timer);
          timer = null;
          attemptController.abort();
          lossResolvers.resolve(nextLoss);
        };
        const schedule = (): void => {
          if (stopped) return;
          timer = setTimeout(() => {
            timer = null;
            heartbeatTask = (async () => {
              try {
                const heartbeat = await managed.heartbeat(id, lease);
                if (heartbeat.status === "stale") {
                  lose({ kind: "stale" });
                  return;
                }
                lease = heartbeat.lease;
              } catch (cause) {
                lose({ kind: "error", cause });
                return;
              }
              schedule();
            })();
            void heartbeatTask;
          }, MANAGED_REDIS_HEARTBEAT_MS);
          timer.unref?.();
        };
        const control: ActiveAttempt = {
          shutdown: () => lose({ kind: "shutdown" }),
        };
        activeAttempt = control;
        schedule();

        return {
          signal: attemptController.signal,
          loss: lossResolvers.promise,
          currentLoss: (): LeaseLoss | null => loss,
          close: async (): Promise<void> => {
            stopped = true;
            if (timer !== null) clearTimeout(timer);
            timer = null;
            await heartbeatTask;
            if (activeAttempt === control) activeAttempt = null;
          },
        };
      };

      const handleLeaseLoss = async (id: Cursor, loss: LeaseLoss): Promise<EntryHandlingResult> => {
        if (loss.kind === "shutdown" || loss.kind === "stale") return { status: "advance" };
        if (Panic.is(loss.cause)) {
          await reportFatal(loss.cause, id, "delivery-action");
          throw loss.cause;
        }
        return {
          status: "transport-error",
          error: new EventDeliveryTransportFailed({
            cause: loss.cause,
            operation: "read",
            topic,
            cursor: id,
            message: "Redis delivery heartbeat failed",
          }),
        };
      };

      const loadRecoveryEntry = async (id: Cursor): Promise<CapturedTransport<RedisReadEntry>> =>
        captureTransport(
          async () => {
            if (!managedRedisClient) {
              throw new Panic({ message: "Managed Redis recovery connection is unavailable" });
            }
            const response = (await managedRedisClient.xrange(
              streamKey,
              id,
              id,
              "COUNT",
              1,
            )) as unknown;
            const decoded = decodeRedisRangeResponse(response, topic, streamKey, id, this.logger);
            if (decoded.status === "error") throw new Error(decoded.message);
            return decoded.value;
          },
          "read",
          id,
          "Redis delivery source recovery failed",
        );

      const deadLetterManaged = async (
        entry: RedisReadEntry,
        lease: ManagedLease,
        reason: EventDeadLetterReason,
      ): Promise<EntryHandlingResult> => {
        const scope = startLeaseHeartbeat(entry.id, lease);
        type Preparation =
          | {
              readonly status: "prepared";
              readonly material: ManagedTerminalMaterial;
            }
          | { readonly status: "failed"; readonly cause: unknown };
        const preparation: Promise<Preparation> = (async () => {
          try {
            if (!dependencies.deadLetter) {
              throw new Error("No event dead-letter adapter is configured");
            }
            const recordedAt = await dependencies.deadLetter.serverTimeMs();
            const record = createManagedEventDeadLetterRecord({
              topic,
              cursor: entry.id,
              mode,
              physicalGroup,
              attempt: lease.attempt,
              recordedAt,
              reason,
              evidence: entry.evidence,
            });
            return { status: "prepared", material: await dependencies.deadLetter.prepare(record) };
          } catch (cause) {
            return { status: "failed", cause };
          }
        })();
        const completed = await Promise.race([
          preparation,
          scope.loss.then(
            (lost): Preparation | { readonly status: "lease-lost"; loss: LeaseLoss } => ({
              status: "lease-lost",
              loss: lost,
            }),
          ),
        ]);
        await scope.close();
        const currentLoss = scope.currentLoss();
        if (currentLoss !== null) return handleLeaseLoss(entry.id, currentLoss);
        if (completed.status === "lease-lost") return handleLeaseLoss(entry.id, completed.loss);
        if (completed.status === "failed") {
          if (Panic.is(completed.cause)) {
            await reportFatal(completed.cause, entry.id, "dead-letter");
            throw completed.cause;
          }
          dependencies.logger?.error("event_bus.dead_letter_failed", {
            topic,
            cursor: entry.id,
            mode,
          });
          return {
            status: "transport-error",
            error: new EventDeliveryTransportFailed({
              cause: completed.cause,
              operation: "ack",
              topic,
              cursor: entry.id,
              message: "Redis managed dead-letter preparation failed",
            }),
          };
        }
        if (abortController.signal.aborted) return { status: "advance" };

        try {
          const staged = await managed.stageTerminal(entry.id, lease, completed.material);
          if (staged.status === "stale") return { status: "advance" };
          const finalized = await managed.finalizeTerminal(entry.id, lease);
          if (finalized.status === "stale") return { status: "advance" };
          this.scheduleAcknowledgedTrim(topic, streamKey);
          return { status: "advance" };
        } catch (cause) {
          if (Panic.is(cause)) {
            await reportFatal(cause, entry.id, "dead-letter");
            throw cause;
          }
          return {
            status: "transport-error",
            error: new EventDeliveryTransportFailed({
              cause,
              operation: "ack",
              topic,
              cursor: entry.id,
              message: "Redis managed dead-letter finalization failed",
            }),
          };
        }
      };

      const beginDeadLetterManaged = async (
        entry: RedisReadEntry,
        ownership: ManagedLease | ManagedClaim,
        reason: EventDeadLetterReason,
      ): Promise<EntryHandlingResult> => {
        const preparing = await captureTransport(
          () => managed.beginTerminal(entry.id, ownership, reason),
          "ack",
          entry.id,
          "Redis managed terminal preparation transition failed",
        );
        if (preparing.status === "error") {
          return { status: "transport-error", error: preparing.error };
        }
        if (preparing.value.status === "stale") return { status: "advance" };
        return deadLetterManaged(entry, preparing.value.lease, preparing.value.reason);
      };

      const handleManagedEntry = async (
        entry: RedisReadEntry,
        lease: ManagedLease,
      ): Promise<EntryHandlingResult> => {
        const scope = startLeaseHeartbeat(entry.id, lease);
        type HandlerCompletion =
          | { readonly status: "action"; readonly action: RawDeliveryAction }
          | { readonly status: "defect"; readonly cause: unknown };
        const handlerCompletion: Promise<HandlerCompletion> = (async () => {
          try {
            return {
              status: "action",
              action: deliveryAction(
                await handler(entry.message, {
                  cursor: entry.id,
                  mode,
                  evidence: entry.evidence,
                  deliveryId: lease.deliveryId,
                  attempt: lease.attempt,
                  leaseDeadline: lease.leaseDeadline,
                  signal: scope.signal,
                }),
              ),
            };
          } catch (cause) {
            const phase = Panic.is(cause) ? "delivery-action" : "handler";
            await reportFatal(cause, entry.id, phase);
            return { status: "defect", cause };
          }
        })();
        const completed = await Promise.race([
          handlerCompletion,
          scope.loss.then(
            (lost): HandlerCompletion | { readonly status: "lease-lost"; loss: LeaseLoss } => ({
              status: "lease-lost",
              loss: lost,
            }),
          ),
        ]);
        await scope.close();
        const currentLoss = scope.currentLoss();
        if (currentLoss !== null) return handleLeaseLoss(entry.id, currentLoss);
        if (completed.status === "lease-lost") return handleLeaseLoss(entry.id, completed.loss);
        if (completed.status === "defect") throw completed.cause;
        if (abortController.signal.aborted) return { status: "advance" };
        const action = completed.action;

        switch (action.disposition) {
          case "commit": {
            const committed = await captureTransport(
              () => managed.commit(entry.id, lease),
              "ack",
              entry.id,
              "Redis managed delivery commit failed",
            );
            if (committed.status === "error") {
              return { status: "transport-error", error: committed.error };
            }
            if (committed.value.status === "committed") {
              this.scheduleAcknowledgedTrim(topic, streamKey);
            }
            return { status: "advance" };
          }
          case "retry": {
            const retried = await captureTransport(
              () => managed.scheduleRetry(entry.id, lease, action.failure),
              "ack",
              entry.id,
              "Redis managed delivery retry scheduling failed",
            );
            if (retried.status === "error") {
              return { status: "transport-error", error: retried.error };
            }
            if (retried.value.status === "exhausted") {
              return beginDeadLetterManaged(
                entry,
                retried.value.lease,
                createAttemptsExhaustedDeadLetterReason({
                  finalFailure: retried.value.finalFailure,
                }),
              );
            }
            return { status: "advance" };
          }
          case "park-pending": {
            const parked = await captureTransport(
              () => managed.park(entry.id, lease),
              "ack",
              entry.id,
              "Redis managed delivery parking failed",
            );
            if (parked.status === "error") {
              return { status: "transport-error", error: parked.error };
            }
            if (parked.value.status === "parked") {
              void this.observePendingEntries(topic, streamKey, physicalGroup, "parked");
              return { status: "park" };
            }
            return { status: "advance" };
          }
          case "dead-letter":
            return beginDeadLetterManaged(entry, lease, action.reason);
          case "stop":
            return {
              status: "stop",
              error: new EventDeliveryStopped({
                reason: "requested",
                topic,
                cursor: entry.id,
                message: "Event delivery policy requested stop",
              }),
            };
        }
      };

      const invokeManagedEntry = async (
        entry: RedisReadEntry,
        claim: ManagedClaim,
      ): Promise<EntryHandlingResult> => {
        const begun = await captureTransport(
          () => managed.beginInvocation(entry.id, claim),
          "read",
          entry.id,
          "Redis managed invocation transition failed",
        );
        if (begun.status === "error") return { status: "transport-error", error: begun.error };
        if (begun.value.status === "stale") return { status: "advance" };
        if (begun.value.status === "exhausted") {
          throw new Panic({ message: "Managed recovery attempted a sixth invocation" });
        }
        return handleManagedEntry(entry, begun.value.lease);
      };

      const handleExhausted = async (
        id: Cursor,
        lease: ManagedLease,
        finalFailure: ManagedExhaustionFailure,
      ): Promise<EntryHandlingResult> => {
        const loaded = await loadRecoveryEntry(id);
        if (loaded.status === "error") {
          return { status: "transport-error", error: loaded.error };
        }
        return beginDeadLetterManaged(
          loaded.value,
          lease,
          createAttemptsExhaustedDeadLetterReason({ finalFailure }),
        );
      };

      while (!abortController.signal.aborted) {
        const recovered = await captureTransport(
          () => managed.claimRecoverable(),
          "read",
          undefined,
          "Redis managed delivery recovery failed",
        );
        if (recovered.status === "error") return Result.err(recovered.error);

        let recoveryHandled: EntryHandlingResult | null = null;
        const recovery = recovered.value;
        switch (recovery.status) {
          case "none":
            break;
          case "terminal": {
            const recoveryId = recovery.id;
            const recoveryLease = recovery.lease;
            const finalized = await captureTransport(
              () => managed.finalizeTerminal(recoveryId, recoveryLease),
              "ack",
              recoveryId,
              "Redis managed terminal recovery failed",
            );
            if (finalized.status === "error") return Result.err(finalized.error);
            if (finalized.value.status === "finalized") {
              this.scheduleAcknowledgedTrim(topic, streamKey);
            }
            recoveryHandled = { status: "advance" };
            break;
          }
          case "prepare-terminal": {
            const loaded = await loadRecoveryEntry(recovery.id);
            if (loaded.status === "error") return Result.err(loaded.error);
            recoveryHandled = await deadLetterManaged(
              loaded.value,
              recovery.lease,
              recovery.reason,
            );
            break;
          }
          case "exhausted":
            recoveryHandled = await handleExhausted(
              recovery.id,
              recovery.lease,
              recovery.finalFailure,
            );
            break;
          case "claimed": {
            const loaded = await loadRecoveryEntry(recovery.id);
            if (loaded.status === "error") return Result.err(loaded.error);
            recoveryHandled = await invokeManagedEntry(loaded.value, recovery.claim);
            break;
          }
        }
        if (recoveryHandled?.status === "stop") return Result.err(recoveryHandled.error);
        if (recoveryHandled?.status === "transport-error") {
          return Result.err(recoveryHandled.error);
        }
        if (abortController.signal.aborted) break;

        let response: unknown;
        try {
          response = await subRedis.xreadgroup(
            "GROUP",
            physicalGroup,
            consumerId,
            "COUNT",
            "1",
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
          const begun = await captureTransport(
            () => managed.beginFresh(entry.id),
            "read",
            entry.id,
            "Redis managed fresh delivery initialization failed",
          );
          if (begun.status === "error") return Result.err(begun.error);
          if (begun.value.status === "stale") continue;
          const handled = await invokeManagedEntry(entry, begun.value.claim);
          if (handled.status === "stop") return Result.err(handled.error);
          if (handled.status === "transport-error") return Result.err(handled.error);
        }
      }
      return Result.ok(undefined);
    };

    const runLoop = (): Promise<ResultType<void, EventDeliveryDoneError>> =>
      opts.mode === "tail" ? runTailLoop() : runDurableLoop();

    type CleanupAttempt =
      | { readonly status: "ok" }
      | { readonly status: "error"; readonly cause: unknown };
    let leaseCleanup: Promise<CleanupAttempt> | null = null;
    const cleanupLease = (): Promise<CleanupAttempt> => {
      leaseCleanup ??= (async () => {
        managedRedisClient?.disconnect();
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
            if (!ephemeralGroupDestroyed) {
              const destroyed = await this.redis.xgroup("DESTROY", streamKey, group);
              if (destroyed !== 1) {
                throw new Error("Redis XGROUP DESTROY returned an invalid cleanup response");
              }
              ephemeralGroupDestroyed = true;
            }
            await new RedisManagedDelivery(
              this.redis,
              streamKey,
              group,
              consumerId,
              this.ownerId,
            ).clearAllState();
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
            const pendingPresence = decodeRedisCleanupPendingPresence(pending);
            if (pendingPresence.status === "error") throw new Error(pendingPresence.message);
            if (!pendingPresence.value.hasPendingEntries) {
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

    let ephemeralGroupDestroyed = false;
    let stopSequence = Promise.resolve();
    const stop = async (): Promise<ResultType<void, EventDeliveryStopFailed>> => {
      const previousStop = stopSequence;
      const stopTurn = Promise.withResolvers<void>();
      stopSequence = stopTurn.promise;
      await previousStop;
      try {
        abortController.abort();
        activeAttempt?.shutdown();
        managedRedisClient?.disconnect();
        if (!lease.shared && blockMs > 500) {
          disconnectOnStop = true;
          subRedis.disconnect();
        }
        const completedLoop = await loopCompletion;
        const groupCleanup = await cleanupGroup();
        const released = await cleanupLease();

        if (completedLoop.status === "defect") {
          this.activeSubscriptionStops.delete(stop);
          throw completedLoop.cause;
        }
        if (groupCleanup.status === "error" && Panic.is(groupCleanup.cause)) {
          this.activeSubscriptionStops.delete(stop);
          throw groupCleanup.cause;
        }
        if (released.status === "error" && Panic.is(released.cause)) {
          this.activeSubscriptionStops.delete(stop);
          throw released.cause;
        }
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
        this.activeSubscriptionStops.delete(stop);
        return Result.ok(undefined);
      } finally {
        stopTurn.resolve();
      }
    };
    this.activeSubscriptionStops.add(stop);
    return Result.ok({
      done: running,
      stop,
    });
  }

  /** Close the bus (no-op unless `ownsRedis` was set). */
  async close(): Promise<void> {
    this.closing = true;
    const stopped = await Promise.allSettled(
      Array.from(this.activeSubscriptionStops, async (stop) => await stop()),
    );
    let stopFailure: unknown;
    for (const outcome of stopped) {
      if (outcome.status === "rejected") {
        stopFailure ??= outcome.reason;
      } else {
        outcome.value.match({
          ok: () => undefined,
          err: (error) => {
            stopFailure ??= error;
          },
        });
      }
    }
    for (const timer of this.trimTimers.values()) clearTimeout(timer);
    this.trimTimers.clear();
    await Promise.allSettled(this.activeTrims);
    await this.subPool.close();
    if (this.ownsRedis) {
      // Do not `disconnect()` because it drops queued commands; `quit()` is clean.
      await this.redis.quit();
    }

    if (stopFailure !== undefined) throw stopFailure;
    if (this.acknowledgedTrimPanic !== null) throw this.acknowledgedTrimPanic;
  }
}

/** Convenience factory for `RedisStreamsBus`. */
export function createRedisStreamsBus(options: RedisStreamsBusOptions): RedisStreamsBus {
  return new RedisStreamsBus(options);
}
