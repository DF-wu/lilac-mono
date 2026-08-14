import { Result } from "better-result";
import { z } from "zod";

import type { EventDeadLetterReason } from "../event-dead-letter";
import type {
  ManagedAttempt,
  ManagedClaim,
  ManagedCompletedAttempts,
  ManagedExhaustionFailure,
  ManagedLease,
  ManagedTerminalMaterial,
} from "../redis-managed-delivery.ts";

const MAX_ATTEMPTS = 5;
const MAX_FAILURE_CHARS = 512;
const MAX_REASON_ISSUES = 32;
const MAX_TERMINAL_INDEX_VALUES = 32;
const MAX_TERMINAL_INDEX_VALUE_CHARS = 1_024;
const STREAM_ID_PATTERN = /^\d+-\d+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const redisIntegerSchema = z
  .union([z.number(), z.string().regex(/^-?(?:0|[1-9]\d*)$/)])
  .transform(Number)
  .pipe(z.number().int().safe());
const nonnegativeIntegerSchema = redisIntegerSchema.pipe(z.number().nonnegative());
const positiveIntegerSchema = redisIntegerSchema.pipe(z.number().positive());
const attemptSchema = redisIntegerSchema
  .pipe(z.number().min(1).max(MAX_ATTEMPTS))
  .transform((attempt) => attempt as ManagedAttempt);
const completedAttemptsSchema = redisIntegerSchema
  .pipe(z.number().min(0).max(MAX_ATTEMPTS))
  .transform((attempts) => attempts as ManagedCompletedAttempts);
const streamIdSchema = z.string().regex(STREAM_ID_PATTERN);
const deliveryIdSchema = z.string().regex(SHA256_PATTERN);
const leaseTokenSchema = z.string();
const scanCursorSchema = z.string().regex(/^\d+$/);

const panicSchema = z
  .tuple([z.literal("panic"), z.string()])
  .transform(([, message]) => ({ status: "panic", message }) as const);
const staleSchema = z.tuple([z.literal("stale")]).transform(() => ({ status: "stale" }) as const);

const terminalReasonSchema: z.ZodType<EventDeadLetterReason> = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("contract-invalid"),
    diagnostic: z.literal("event_bus.contract_invalid"),
    stage: z.enum(["transport", "envelope", "event_type", "headers", "topic", "key", "payload"]),
    eventType: z.string().max(MAX_FAILURE_CHARS).optional(),
    issues: z.array(z.string().max(MAX_FAILURE_CHARS)).max(MAX_REASON_ISSUES),
  }),
  z.strictObject({
    kind: z.literal("handler-error"),
    errorTag: z.string().max(MAX_FAILURE_CHARS),
    errorMessage: z.string().max(MAX_FAILURE_CHARS),
  }),
  z.strictObject({
    kind: z.literal("attempts-exhausted"),
    finalFailure: z.union([
      z.strictObject({
        kind: z.literal("handler-error"),
        errorTag: z.string().max(MAX_FAILURE_CHARS),
        errorMessage: z.string().max(MAX_FAILURE_CHARS),
      }),
      z.strictObject({ kind: z.literal("lease-expired") }),
    ]),
  }),
]);

const terminalReasonJsonSchema = z
  .string()
  .transform((value, context): unknown => {
    const parsed = Result.try({
      try: () => JSON.parse(value) as unknown,
      catch: () => new Error("Invalid terminal reason JSON"),
    });
    if (parsed.status === "error") {
      context.addIssue({ code: "custom", message: "Invalid terminal reason JSON" });
      return z.NEVER;
    }
    return parsed.value;
  })
  .pipe(terminalReasonSchema);

const terminalIndexFieldsSchema = z
  .array(z.string())
  .min(1)
  .max(MAX_TERMINAL_INDEX_VALUES)
  .refine((fields) => fields.length % 2 === 0)
  .refine((fields) =>
    fields.every(
      (value, index) =>
        Buffer.byteLength(value, "utf8") <= MAX_TERMINAL_INDEX_VALUE_CHARS &&
        (index % 2 !== 0 || value.length > 0),
    ),
  );

function claimTuple(status: "claimed") {
  return z
    .tuple([
      z.literal(status),
      completedAttemptsSchema,
      leaseTokenSchema,
      deliveryIdSchema,
      nonnegativeIntegerSchema,
    ])
    .transform(
      ([decodedStatus, completedAttempts, token, deliveryId, leaseDeadline]) =>
        ({
          status: decodedStatus,
          claim: { completedAttempts, token, deliveryId, leaseDeadline } satisfies ManagedClaim,
        }) as const,
    );
}

function leaseTuple<TStatus extends "invoke" | "exhausted" | "extended" | "preparing">(
  status: TStatus,
) {
  return z
    .tuple([
      z.literal(status),
      attemptSchema,
      leaseTokenSchema,
      deliveryIdSchema,
      nonnegativeIntegerSchema,
    ])
    .transform(
      ([decodedStatus, attempt, token, deliveryId, leaseDeadline]) =>
        ({
          status: decodedStatus,
          lease: { attempt, token, deliveryId, leaseDeadline } satisfies ManagedLease,
        }) as const,
    );
}

const beginFreshResponseSchema = z.union([panicSchema, staleSchema, claimTuple("claimed")]);

const beginInvocationResponseSchema = z.union([
  panicSchema,
  staleSchema,
  leaseTuple("invoke"),
  leaseTuple("exhausted"),
]);

const heartbeatResponseSchema = z.union([panicSchema, staleSchema, leaseTuple("extended")]);

const commitResponseSchema = z.union([
  panicSchema,
  staleSchema,
  z.tuple([z.literal("committed")]).transform(() => ({ status: "committed" }) as const),
]);

const scheduleRetryResponseSchema = z.union([
  panicSchema,
  staleSchema,
  z
    .tuple([z.literal("scheduled"), nonnegativeIntegerSchema])
    .transform(([, dueAt]) => ({ status: "scheduled", dueAt }) as const),
  leaseTuple("exhausted"),
]);

const parkResponseSchema = z.union([
  panicSchema,
  staleSchema,
  z.tuple([z.literal("parked")]).transform(() => ({ status: "parked" }) as const),
]);

const beginTerminalResponseSchema = z.union([
  panicSchema,
  staleSchema,
  z
    .tuple([
      z.literal("preparing"),
      attemptSchema,
      leaseTokenSchema,
      deliveryIdSchema,
      nonnegativeIntegerSchema,
      terminalReasonJsonSchema,
    ])
    .transform(
      ([status, attempt, token, deliveryId, leaseDeadline, reason]) =>
        ({
          status,
          lease: { attempt, token, deliveryId, leaseDeadline } satisfies ManagedLease,
          reason,
        }) as const,
    ),
]);

const stageTerminalResponseSchema = z.union([
  panicSchema,
  staleSchema,
  z.tuple([z.literal("staged")]).transform(() => ({ status: "staged" }) as const),
]);

const finalizeTerminalResponseSchema = z.union([
  panicSchema,
  staleSchema,
  z
    .tuple([z.literal("finalized"), z.string()])
    .transform(([, id]) => ({ status: "finalized", id }) as const),
]);

const recoveryClaimedSchema = z
  .tuple([
    z.literal("claimed"),
    streamIdSchema,
    completedAttemptsSchema,
    leaseTokenSchema,
    deliveryIdSchema,
    nonnegativeIntegerSchema,
  ])
  .transform(
    ([status, id, completedAttempts, token, deliveryId, leaseDeadline]) =>
      ({
        status,
        id,
        claim: { completedAttempts, token, deliveryId, leaseDeadline } satisfies ManagedClaim,
      }) as const,
  );

const recoveryHandlerExhaustedSchema = z
  .tuple([
    z.literal("exhausted"),
    streamIdSchema,
    attemptSchema,
    leaseTokenSchema,
    deliveryIdSchema,
    nonnegativeIntegerSchema,
    z.literal("handler-error"),
    z.string(),
    z.string(),
  ])
  .transform(
    ([status, id, attempt, token, deliveryId, leaseDeadline, kind, errorTag, errorMessage]) =>
      ({
        status,
        id,
        lease: { attempt, token, deliveryId, leaseDeadline } satisfies ManagedLease,
        finalFailure: { kind, errorTag, errorMessage } satisfies ManagedExhaustionFailure,
      }) as const,
  );

const recoveryExpiredExhaustedSchema = z
  .tuple([
    z.literal("exhausted"),
    streamIdSchema,
    attemptSchema,
    leaseTokenSchema,
    deliveryIdSchema,
    nonnegativeIntegerSchema,
    z.literal("lease-expired"),
    z.literal(""),
    z.literal(""),
  ])
  .transform(
    ([status, id, attempt, token, deliveryId, leaseDeadline, kind]) =>
      ({
        status,
        id,
        lease: { attempt, token, deliveryId, leaseDeadline } satisfies ManagedLease,
        finalFailure: { kind } satisfies ManagedExhaustionFailure,
      }) as const,
  );

const recoveryPreparingTerminalSchema = z
  .tuple([
    z.literal("prepare-terminal"),
    streamIdSchema,
    attemptSchema,
    leaseTokenSchema,
    deliveryIdSchema,
    nonnegativeIntegerSchema,
    terminalReasonJsonSchema,
  ])
  .transform(
    ([status, id, attempt, token, deliveryId, leaseDeadline, reason]) =>
      ({
        status,
        id,
        lease: { attempt, token, deliveryId, leaseDeadline } satisfies ManagedLease,
        reason,
      }) as const,
  );

const terminalResponsePrefix = [
  z.literal("terminal"),
  streamIdSchema,
  attemptSchema,
  leaseTokenSchema,
  deliveryIdSchema,
  nonnegativeIntegerSchema,
  z.string().min(1),
  z.string().min(1),
  z.string().min(1),
] as const;
const terminalResponseSuffix = [
  z.string().min(1),
  terminalIndexFieldsSchema,
  nonnegativeIntegerSchema,
  positiveIntegerSchema,
  positiveIntegerSchema,
] as const;

const recoveryTerminalWithoutEvidenceSchema = z
  .tuple([
    ...terminalResponsePrefix,
    z.literal("0"),
    z.literal(""),
    z.literal(""),
    ...terminalResponseSuffix,
  ])
  .transform(
    ([
      status,
      id,
      attempt,
      token,
      deliveryId,
      leaseDeadline,
      terminalId,
      recordKey,
      recordValue,
      ,
      ,
      ,
      indexKey,
      fields,
      score,
      maxLen,
      ttlSeconds,
    ]) =>
      ({
        status,
        id,
        lease: { attempt, token, deliveryId, leaseDeadline } satisfies ManagedLease,
        material: {
          id: terminalId,
          record: { key: recordKey, value: recordValue },
          index: { key: indexKey, fields, score, maxLen },
          ttlSeconds,
        } satisfies ManagedTerminalMaterial,
      }) as const,
  );

const recoveryTerminalWithEvidenceSchema = z
  .tuple([
    ...terminalResponsePrefix,
    z.literal("1"),
    z.string().min(1),
    z.string().min(1),
    ...terminalResponseSuffix,
  ])
  .transform(
    ([
      status,
      id,
      attempt,
      token,
      deliveryId,
      leaseDeadline,
      terminalId,
      recordKey,
      recordValue,
      ,
      evidenceKey,
      evidenceValue,
      indexKey,
      fields,
      score,
      maxLen,
      ttlSeconds,
    ]) =>
      ({
        status,
        id,
        lease: { attempt, token, deliveryId, leaseDeadline } satisfies ManagedLease,
        material: {
          id: terminalId,
          record: { key: recordKey, value: recordValue },
          evidence: { key: evidenceKey, value: evidenceValue },
          index: { key: indexKey, fields, score, maxLen },
          ttlSeconds,
        } satisfies ManagedTerminalMaterial,
      }) as const,
  );

const claimRecoverableResponseSchema = z.union([
  panicSchema,
  z.tuple([z.literal("none")]).transform(() => ({ status: "none" }) as const),
  z
    .tuple([z.literal("orphans"), z.array(streamIdSchema).min(1)])
    .transform(([, orphanIds]) => ({ status: "orphans", orphanIds }) as const),
  recoveryClaimedSchema,
  recoveryHandlerExhaustedSchema,
  recoveryExpiredExhaustedSchema,
  recoveryPreparingTerminalSchema,
  recoveryTerminalWithoutEvidenceSchema,
  recoveryTerminalWithEvidenceSchema,
]);

const stateCleanupScanResponseSchema = z
  .tuple([scanCursorSchema, z.array(z.string())])
  .transform(([cursor, keys]) => ({ status: "scanned", cursor, keys }) as const);
const stateCleanupDeleteResponseSchema = z
  .number()
  .int()
  .safe()
  .nonnegative()
  .transform((deletedCount) => ({ status: "deleted", deletedCount }) as const);

export type DecodedPanic = { readonly status: "panic"; readonly message: string };
export type DecodedRecoveryResponse = z.output<typeof claimRecoverableResponseSchema>;

export function decodeBeginFreshResponse(value: unknown) {
  const parsed = beginFreshResponseSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : ({ status: "panic", message: "malformed beginFresh response" } satisfies DecodedPanic);
}

export function decodeBeginInvocationResponse(value: unknown) {
  const parsed = beginInvocationResponseSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : ({ status: "panic", message: "malformed beginInvocation response" } satisfies DecodedPanic);
}

export function decodeHeartbeatResponse(value: unknown) {
  const parsed = heartbeatResponseSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : ({ status: "panic", message: "malformed heartbeat response" } satisfies DecodedPanic);
}

export function decodeCommitResponse(value: unknown) {
  const parsed = commitResponseSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : ({ status: "panic", message: "malformed commit response" } satisfies DecodedPanic);
}

export function decodeScheduleRetryResponse(value: unknown) {
  const parsed = scheduleRetryResponseSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : ({ status: "panic", message: "malformed scheduleRetry response" } satisfies DecodedPanic);
}

export function decodeParkResponse(value: unknown) {
  const parsed = parkResponseSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : ({ status: "panic", message: "malformed park response" } satisfies DecodedPanic);
}

export function decodeClaimRecoverableResponse(
  value: unknown,
  phase: "discover" | "resolve-orphans",
): DecodedRecoveryResponse {
  const parsed = claimRecoverableResponseSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : {
        status: "panic",
        message:
          phase === "discover"
            ? "malformed claimRecoverable response"
            : "malformed orphan identity response",
      };
}

export function decodeBeginTerminalResponse(value: unknown) {
  const parsed = beginTerminalResponseSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : ({ status: "panic", message: "malformed beginTerminal response" } satisfies DecodedPanic);
}

export function decodeStageTerminalResponse(value: unknown) {
  const parsed = stageTerminalResponseSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : ({ status: "panic", message: "malformed stageTerminal response" } satisfies DecodedPanic);
}

export function decodeFinalizeTerminalResponse(value: unknown) {
  const parsed = finalizeTerminalResponseSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : ({ status: "panic", message: "malformed finalizeTerminal response" } satisfies DecodedPanic);
}

export function decodeStateCleanupScanResponse(value: unknown, expectedKeyPrefix: string) {
  const parsed = stateCleanupScanResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data.keys.some((key) => !key.startsWith(expectedKeyPrefix))) {
    return { status: "panic", message: "malformed state cleanup scan" } satisfies DecodedPanic;
  }
  return parsed.data;
}

export function decodeStateCleanupDeleteResponse(value: unknown, maximumDeletedCount: number) {
  const parsed = stateCleanupDeleteResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data.deletedCount > maximumDeletedCount) {
    return { status: "panic", message: "malformed state cleanup delete" } satisfies DecodedPanic;
  }
  return parsed.data;
}
