import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type Redis from "ioredis";
import SuperJSON from "superjson";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import {
  captureDeadLetterAcceptance,
  createManagedEventDeadLetterRecord,
  type EventDeadLetter,
  type EventDeadLetterAcceptance,
  type EventDeadLetterAcceptFailed,
  type EventDeadLetterRecord,
} from "./event-dead-letter";
import { managedRedisPhysicalGroup } from "./redis-managed-delivery";

const DEFAULT_RECORD_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_INDEX_MAX_LEN = 10_000;
const ENCRYPTION_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const CIPHERTEXT_VERSION = 1 as const;
const CIPHERTEXT_ALGORITHM = "aes-256-gcm" as const;

export type RedisEventDeadLetterOptions = {
  readonly redis: Redis;
  /** Dedicated 32-byte key. The adapter copies it during construction. */
  readonly encryptionKey: Uint8Array;
  readonly keyPrefix?: string;
  /** TTL for encrypted complete records and evidence. */
  readonly recordTtlSeconds?: number;
  /** Exact maximum number of payload-free metadata entries retained in the index sorted set. */
  readonly indexMaxLen?: number;
};

export type PreparedRedisEventDeadLetter = {
  readonly id: string;
  readonly record: { readonly key: string; readonly value: string };
  readonly evidence?: { readonly key: string; readonly value: string };
  readonly index: {
    readonly key: string;
    readonly fields: readonly string[];
    readonly score: number;
    readonly maxLen: number;
  };
  readonly ttlSeconds: number;
};

export class RedisEventDeadLetterConfigInvalid extends TaggedError(
  "RedisEventDeadLetterConfigInvalid",
)<{
  readonly option: "recordTtlSeconds" | "indexMaxLen" | "encryptionKey";
  readonly value: number;
  readonly message: string;
}> {}

export class RedisEventDeadLetterEncryptFailed extends TaggedError(
  "RedisEventDeadLetterEncryptFailed",
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class RedisEventDeadLetterCiphertextInvalid extends TaggedError(
  "RedisEventDeadLetterCiphertextInvalid",
)<{
  readonly message: string;
}> {}

export class RedisEventDeadLetterContextMismatch extends TaggedError(
  "RedisEventDeadLetterContextMismatch",
)<{
  readonly expectedKind: RedisEventDeadLetterCiphertextKind;
  readonly actualKind: RedisEventDeadLetterCiphertextKind;
  readonly expectedIdentity: RedisEventDeadLetterStorageIdentity;
  readonly message: string;
}> {}

export class RedisEventDeadLetterAuthenticationFailed extends TaggedError(
  "RedisEventDeadLetterAuthenticationFailed",
)<{
  readonly expectedIdentity: RedisEventDeadLetterStorageIdentity;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class RedisEventDeadLetterRecordInvalid extends TaggedError(
  "RedisEventDeadLetterRecordInvalid",
)<{
  readonly message: string;
}> {}

type RedisEventDeadLetterConfig = {
  readonly recordTtlSeconds: number;
  readonly indexMaxLen: number;
  readonly encryptionKey: Uint8Array;
};

export function validateRedisEventDeadLetterConfig(options: {
  readonly recordTtlSeconds: number;
  readonly indexMaxLen: number;
  readonly encryptionKey: Uint8Array;
}): ResultType<RedisEventDeadLetterConfig, RedisEventDeadLetterConfigInvalid> {
  for (const option of ["recordTtlSeconds", "indexMaxLen"] as const) {
    const value = options[option];
    if (!Number.isSafeInteger(value) || value < 1) {
      return Result.err(
        new RedisEventDeadLetterConfigInvalid({
          option,
          value,
          message: `${option} must be a positive safe integer`,
        }),
      );
    }
  }
  if (options.encryptionKey.byteLength !== ENCRYPTION_KEY_BYTES) {
    return Result.err(
      new RedisEventDeadLetterConfigInvalid({
        option: "encryptionKey",
        value: options.encryptionKey.byteLength,
        message: `encryptionKey must contain exactly ${ENCRYPTION_KEY_BYTES} bytes`,
      }),
    );
  }
  return Result.ok({
    recordTtlSeconds: options.recordTtlSeconds,
    indexMaxLen: options.indexMaxLen,
    encryptionKey: Buffer.from(options.encryptionKey),
  });
}

export type RedisEventDeadLetterCiphertextKind = "record" | "evidence";

export type RedisEventDeadLetterStorageIdentity = {
  readonly deadLetterId: string;
  readonly storageKey: string;
};

const ciphertextEnvelopeSchema = z.strictObject({
  version: z.literal(CIPHERTEXT_VERSION),
  algorithm: z.literal(CIPHERTEXT_ALGORITHM),
  kind: z.enum(["record", "evidence"]),
  nonce: z.string(),
  authTag: z.string(),
  ciphertext: z.string(),
});

type RedisEventDeadLetterCiphertextEnvelope = z.output<typeof ciphertextEnvelopeSchema>;

function authenticatedData(
  kind: RedisEventDeadLetterCiphertextKind,
  identity: RedisEventDeadLetterStorageIdentity,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: CIPHERTEXT_VERSION,
      kind,
      deadLetterId: identity.deadLetterId,
      storageKey: identity.storageKey,
    }),
    "utf8",
  );
}

function decodeCanonicalBase64(value: string, expectedBytes?: number): Buffer | null {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) return null;
  if (expectedBytes !== undefined && decoded.byteLength !== expectedBytes) return null;
  return decoded;
}

export function decodeRedisEventDeadLetterCiphertextEnvelope(
  encoded: string,
): ResultType<RedisEventDeadLetterCiphertextEnvelope, RedisEventDeadLetterCiphertextInvalid> {
  let serialized: unknown;
  try {
    serialized = JSON.parse(encoded);
  } catch {
    return Result.err(
      new RedisEventDeadLetterCiphertextInvalid({
        message: "Dead-letter ciphertext envelope is not valid JSON",
      }),
    );
  }
  const decoded = ciphertextEnvelopeSchema.safeParse(serialized);
  if (!decoded.success) {
    return Result.err(
      new RedisEventDeadLetterCiphertextInvalid({
        message: "Dead-letter ciphertext envelope is invalid or unsupported",
      }),
    );
  }
  if (
    decodeCanonicalBase64(decoded.data.nonce, NONCE_BYTES) === null ||
    decodeCanonicalBase64(decoded.data.authTag, AUTH_TAG_BYTES) === null ||
    decodeCanonicalBase64(decoded.data.ciphertext) === null
  ) {
    return Result.err(
      new RedisEventDeadLetterCiphertextInvalid({
        message: "Dead-letter ciphertext envelope contains invalid binary fields",
      }),
    );
  }
  return Result.ok(decoded.data);
}

export function encryptRedisEventDeadLetterRecoveryValue(options: {
  readonly encryptionKey: Uint8Array;
  readonly kind: RedisEventDeadLetterCiphertextKind;
  readonly identity: RedisEventDeadLetterStorageIdentity;
  readonly plaintext: string;
}): ResultType<string, RedisEventDeadLetterConfigInvalid | RedisEventDeadLetterEncryptFailed> {
  const configResult = validateRedisEventDeadLetterConfig({
    recordTtlSeconds: 1,
    indexMaxLen: 1,
    encryptionKey: options.encryptionKey,
  });
  const resolved = configResult.match<
    | { readonly config: RedisEventDeadLetterConfig }
    | { readonly error: RedisEventDeadLetterConfigInvalid }
  >({
    ok: (config) => ({ config }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) return Result.err(resolved.error);
  const encryptionKey = Buffer.from(options.encryptionKey);
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(CIPHERTEXT_ALGORITHM, encryptionKey, nonce, {
      authTagLength: AUTH_TAG_BYTES,
    });
    cipher.setAAD(authenticatedData(options.kind, options.identity));
    const ciphertext = Buffer.concat([cipher.update(options.plaintext, "utf8"), cipher.final()]);
    const envelope: RedisEventDeadLetterCiphertextEnvelope = {
      version: CIPHERTEXT_VERSION,
      algorithm: CIPHERTEXT_ALGORITHM,
      kind: options.kind,
      nonce: nonce.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    return Result.ok(JSON.stringify(envelope));
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new RedisEventDeadLetterEncryptFailed({
        cause,
        message: "Dead-letter value encryption failed",
      }),
    );
  }
}

export function decryptRedisEventDeadLetterRecoveryValue(options: {
  readonly encryptionKey: Uint8Array;
  readonly kind: RedisEventDeadLetterCiphertextKind;
  readonly expectedIdentity: RedisEventDeadLetterStorageIdentity;
  readonly ciphertextEnvelope: string;
}): ResultType<
  string,
  | RedisEventDeadLetterConfigInvalid
  | RedisEventDeadLetterCiphertextInvalid
  | RedisEventDeadLetterContextMismatch
  | RedisEventDeadLetterAuthenticationFailed
> {
  const configResult = validateRedisEventDeadLetterConfig({
    recordTtlSeconds: 1,
    indexMaxLen: 1,
    encryptionKey: options.encryptionKey,
  });
  const config = configResult.match<RedisEventDeadLetterConfig | RedisEventDeadLetterConfigInvalid>(
    {
      ok: (value) => value,
      err: (error) => error,
    },
  );
  if (RedisEventDeadLetterConfigInvalid.is(config)) return Result.err(config);
  const envelopeResult = decodeRedisEventDeadLetterCiphertextEnvelope(options.ciphertextEnvelope);
  const envelope = envelopeResult.match<
    RedisEventDeadLetterCiphertextEnvelope | RedisEventDeadLetterCiphertextInvalid
  >({
    ok: (value) => value,
    err: (error) => error,
  });
  if (RedisEventDeadLetterCiphertextInvalid.is(envelope)) return Result.err(envelope);
  if (envelope.kind !== options.kind) {
    return Result.err(
      new RedisEventDeadLetterContextMismatch({
        expectedKind: options.kind,
        actualKind: envelope.kind,
        expectedIdentity: options.expectedIdentity,
        message: "Dead-letter ciphertext kind does not match the recovery operation",
      }),
    );
  }

  const nonce = decodeCanonicalBase64(envelope.nonce, NONCE_BYTES);
  const authTag = decodeCanonicalBase64(envelope.authTag, AUTH_TAG_BYTES);
  const ciphertext = decodeCanonicalBase64(envelope.ciphertext);
  if (!nonce || !authTag || !ciphertext) {
    return Result.err(
      new RedisEventDeadLetterCiphertextInvalid({
        message: "Dead-letter ciphertext envelope contains invalid binary fields",
      }),
    );
  }

  try {
    const decipher = createDecipheriv(CIPHERTEXT_ALGORITHM, config.encryptionKey, nonce, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(authenticatedData(options.kind, options.expectedIdentity));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return Result.ok(plaintext.toString("utf8"));
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new RedisEventDeadLetterAuthenticationFailed({
        expectedIdentity: options.expectedIdentity,
        cause,
        message: "Dead-letter ciphertext authentication failed for the expected storage identity",
      }),
    );
  }
}

const redisWireValueEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("string"), value: z.string(), truncated: z.boolean() }),
  z.strictObject({
    kind: z.literal("non-string"),
    valueType: z.enum([
      "array",
      "bigint",
      "boolean",
      "function",
      "null",
      "number",
      "object",
      "symbol",
      "undefined",
    ]),
  }),
]);

const redisEvidenceSourceSchema = z.strictObject({
  transport: z.literal("redis-streams"),
  streamKey: z.string(),
  topic: z.string(),
  messageId: z.string(),
});

const eventTransportEvidenceSchema = z.strictObject({
  source: redisEvidenceSourceSchema,
  wire: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("bounded-complete"), fields: z.array(z.string()) }),
    z.strictObject({
      kind: z.literal("controlled-reference"),
      locator: z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("redis-stream-entry"),
          streamKey: z.string(),
          messageId: z.string(),
        }),
        z.strictObject({
          kind: z.literal("redis-key"),
          key: z.string(),
          expiresAt: z.number(),
        }),
      ]),
      preview: z.strictObject({
        fields: z.array(redisWireValueEvidenceSchema),
        omittedValueCount: z.number().int().nonnegative(),
      }),
    }),
  ]),
});

const eventDeadLetterRecordSchema: z.ZodType<EventDeadLetterRecord> = z.strictObject({
  version: z.literal(2),
  deadLetterId: z.string(),
  recordedAt: z.number(),
  source: z.strictObject({
    topic: z.string(),
    cursor: z.string(),
    messageId: z.string(),
    mode: z.enum(["work", "fanout", "tail"]),
  }),
  delivery: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("managed-v2"),
      physicalGroup: z.string(),
      attempt: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
      maxAttempts: z.literal(5),
    }),
    z.strictObject({ kind: z.literal("tail") }),
  ]),
  reason: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("contract-invalid"),
      diagnostic: z.literal("event_bus.contract_invalid"),
      stage: z.enum(["transport", "envelope", "event_type", "headers", "topic", "key", "payload"]),
      eventType: z.string().optional(),
      issues: z.array(z.string()),
    }),
    z.strictObject({
      kind: z.literal("handler-error"),
      errorTag: z.string(),
      errorMessage: z.string(),
    }),
    z.strictObject({
      kind: z.literal("attempts-exhausted"),
      finalFailure: z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("handler-error"),
          errorTag: z.string(),
          errorMessage: z.string(),
        }),
        z.strictObject({ kind: z.literal("lease-expired") }),
      ]),
    }),
  ]),
  evidence: eventTransportEvidenceSchema,
});

const MANAGED_GROUP_PROBE = "dead-letter-mode-probe";
const MANAGED_GROUP_INCARNATION_PROBE = "incarnation";
const REDIS_STREAM_ID_PATTERN = /^\d+-\d+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function managedPhysicalGroupHasMode(physicalGroup: string, mode: "work" | "fanout"): boolean {
  const durableProbe = managedRedisPhysicalGroup(mode, MANAGED_GROUP_PROBE);
  const durablePrefix = durableProbe.slice(0, -MANAGED_GROUP_PROBE.length);
  const ephemeralSuffix = `${MANAGED_GROUP_PROBE}:${MANAGED_GROUP_INCARNATION_PROBE}`;
  const ephemeralProbe = managedRedisPhysicalGroup(
    mode,
    MANAGED_GROUP_PROBE,
    true,
    MANAGED_GROUP_INCARNATION_PROBE,
  );
  const ephemeralPrefix = ephemeralProbe.slice(0, -ephemeralSuffix.length);
  if (physicalGroup.startsWith(durablePrefix)) {
    return physicalGroup.length > durablePrefix.length;
  }
  if (!physicalGroup.startsWith(ephemeralPrefix)) return false;
  const ephemeralIdentity = physicalGroup.slice(ephemeralPrefix.length);
  return ephemeralIdentity.slice(1, -1).includes(":");
}

function eventDeadLetterRecordSemanticIssue(record: EventDeadLetterRecord): string | null {
  if (!REDIS_STREAM_ID_PATTERN.test(record.source.messageId)) {
    return "Dead-letter source message id is not a Redis stream id";
  }
  if (record.source.cursor !== record.source.messageId) {
    return "Dead-letter source cursor and message id are inconsistent";
  }
  if (
    record.evidence.source.topic !== record.source.topic ||
    record.evidence.source.messageId !== record.source.messageId
  ) {
    return "Dead-letter source and evidence identities are inconsistent";
  }
  if (record.evidence.wire.kind === "controlled-reference") {
    const locator = record.evidence.wire.locator;
    if (
      locator.kind === "redis-stream-entry" &&
      (locator.streamKey !== record.evidence.source.streamKey ||
        locator.messageId !== record.evidence.source.messageId)
    ) {
      return "Referenced Redis source evidence identity is inconsistent";
    }
  }
  if (record.source.mode === "tail") {
    if (record.delivery.kind !== "tail") {
      return "Tail dead-letter source requires tail delivery identity";
    }
    return UUID_PATTERN.test(record.deadLetterId) ? null : "Tail dead-letter id is invalid";
  }
  if (record.delivery.kind !== "managed-v2") {
    return "Managed dead-letter source requires managed-v2 delivery identity";
  }
  if (!managedPhysicalGroupHasMode(record.delivery.physicalGroup, record.source.mode)) {
    return "Managed dead-letter physical group mode is inconsistent";
  }
  const expectedIdentity = createManagedEventDeadLetterRecord({
    topic: record.source.topic,
    cursor: record.source.cursor,
    mode: record.source.mode,
    physicalGroup: record.delivery.physicalGroup,
    attempt: record.delivery.attempt,
    recordedAt: record.recordedAt,
    reason: record.reason,
    evidence: record.evidence,
  });
  return expectedIdentity.deadLetterId === record.deadLetterId
    ? null
    : "Managed dead-letter id is inconsistent with its delivery identity";
}

function decodeEventDeadLetterRecord(
  value: unknown,
):
  | { readonly status: "ok"; readonly value: EventDeadLetterRecord }
  | { readonly status: "error"; readonly message: string } {
  const decoded = eventDeadLetterRecordSchema.safeParse(value);
  if (!decoded.success) {
    return {
      status: "error",
      message: "Decrypted dead-letter record contract is invalid or unsupported",
    };
  }
  const semanticIssue = eventDeadLetterRecordSemanticIssue(decoded.data);
  return semanticIssue === null
    ? { status: "ok", value: decoded.data }
    : { status: "error", message: semanticIssue };
}

const redisEvidenceEntrySchema = z
  .tuple([z.string(), z.array(z.string())])
  .transform(([messageId, fields]) => ({ messageId, fields }));
const redisEvidenceEntriesSchema = z
  .tuple([redisEvidenceEntrySchema])
  .transform(([entry]) => entry);
const redisTransactionReceiptSchema = z
  .tuple([z.unknown(), z.unknown()])
  .transform(([error, value]) => ({ error, value }));
const redisAbortedTransactionSchema = z
  .custom<null | undefined | false | 0 | "">((value) => !value)
  .transform(() => ({ kind: "aborted" as const }));
const redisTransactionWithoutEvidenceSchema = z.union([
  redisAbortedTransactionSchema,
  z
    .tuple([
      redisTransactionReceiptSchema,
      redisTransactionReceiptSchema,
      redisTransactionReceiptSchema,
    ])
    .transform(([recordSet, zadd, zremrangebyrank]) => ({
      kind: "receipts" as const,
      sets: { evidence: undefined, record: recordSet },
      zadd,
      zremrangebyrank,
    })),
]);
const redisTransactionWithEvidenceSchema = z.union([
  redisAbortedTransactionSchema,
  z
    .tuple([
      redisTransactionReceiptSchema,
      redisTransactionReceiptSchema,
      redisTransactionReceiptSchema,
      redisTransactionReceiptSchema,
    ])
    .transform(([evidenceSet, recordSet, zadd, zremrangebyrank]) => ({
      kind: "receipts" as const,
      sets: { evidence: evidenceSet, record: recordSet },
      zadd,
      zremrangebyrank,
    })),
]);
const redisTimeSchema = z
  .tuple([
    z.string().transform(Number).refine(Number.isSafeInteger),
    z.string().transform(Number).refine(Number.isSafeInteger),
  ])
  .transform(([seconds, microseconds]) => ({ seconds, microseconds }));

type RedisDeadLetterEvidenceDecodeResult =
  | { readonly status: "ok"; readonly fields: readonly string[] }
  | { readonly status: "error"; readonly message: string };

function decodeRedisDeadLetterEvidenceEntry(
  entries: unknown,
  expectedMessageId: string,
): RedisDeadLetterEvidenceDecodeResult {
  const decoded = redisEvidenceEntriesSchema.safeParse(entries);
  if (!decoded.success) {
    return {
      status: "error",
      message: "Referenced Redis source evidence returned an invalid entry collection",
    };
  }
  if (
    !REDIS_STREAM_ID_PATTERN.test(expectedMessageId) ||
    decoded.data.messageId !== expectedMessageId
  ) {
    return {
      status: "error",
      message: "Referenced Redis source evidence returned an unexpected message id",
    };
  }
  if (decoded.data.fields.length === 0 || decoded.data.fields.length % 2 !== 0) {
    return {
      status: "error",
      message: "Referenced Redis source evidence returned invalid field pairs",
    };
  }
  return { status: "ok", fields: decoded.data.fields };
}

type RedisDeadLetterTransactionDecodeResult =
  | {
      readonly status: "ok";
      readonly value: {
        readonly sets: {
          readonly record: "OK";
          readonly evidence?: "OK";
        };
        readonly zadd: number;
        readonly zremrangebyrank: number;
      };
    }
  | { readonly status: "error"; readonly cause: Error };

type RedisDeadLetterTimeDecodeResult =
  | {
      readonly status: "ok";
      readonly value: { readonly seconds: number; readonly microseconds: number };
    }
  | { readonly status: "error"; readonly message: string };

function invalidRedisDeadLetterTransaction(): RedisDeadLetterTransactionDecodeResult {
  return {
    status: "error",
    cause: new Error("Redis dead-letter transaction returned an invalid receipt"),
  };
}

function decodeRedisDeadLetterTransactionId(
  results: unknown,
  hasEvidence: boolean,
): RedisDeadLetterTransactionDecodeResult {
  const decoded = (
    hasEvidence ? redisTransactionWithEvidenceSchema : redisTransactionWithoutEvidenceSchema
  ).safeParse(results);
  if (!decoded.success) return invalidRedisDeadLetterTransaction();
  if (decoded.data.kind === "aborted") {
    return {
      status: "error",
      cause: new Error("Redis dead-letter transaction was aborted"),
    };
  }

  const receipts = decoded.data;
  const commandReceipts = [
    ...(receipts.sets.evidence === undefined ? [] : [receipts.sets.evidence]),
    receipts.sets.record,
    receipts.zadd,
    receipts.zremrangebyrank,
  ];
  for (const receipt of commandReceipts) {
    if (receipt.error !== null) {
      return {
        status: "error",
        cause:
          receipt.error instanceof Error
            ? receipt.error
            : new Error("Redis dead-letter transaction returned an invalid command error"),
      };
    }
  }
  const evidenceSetValue = receipts.sets.evidence?.value;
  if (receipts.sets.evidence !== undefined && evidenceSetValue !== "OK") {
    return invalidRedisDeadLetterTransaction();
  }
  const recordSetValue = receipts.sets.record.value;
  if (recordSetValue !== "OK") return invalidRedisDeadLetterTransaction();
  const zaddValue = receipts.zadd.value;
  const zremrangebyrankValue = receipts.zremrangebyrank.value;
  if (
    typeof zaddValue !== "number" ||
    !Number.isSafeInteger(zaddValue) ||
    zaddValue < 0 ||
    typeof zremrangebyrankValue !== "number" ||
    !Number.isSafeInteger(zremrangebyrankValue) ||
    zremrangebyrankValue < 0
  ) {
    return invalidRedisDeadLetterTransaction();
  }
  return {
    status: "ok",
    value: {
      sets: {
        ...(evidenceSetValue === "OK" ? { evidence: evidenceSetValue } : {}),
        record: recordSetValue,
      },
      zadd: zaddValue,
      zremrangebyrank: zremrangebyrankValue,
    },
  };
}

function decodeRedisDeadLetterTime(value: unknown): RedisDeadLetterTimeDecodeResult {
  const decoded = redisTimeSchema.safeParse(value);
  if (!decoded.success) {
    return { status: "error", message: "Redis TIME returned an invalid dead-letter timestamp" };
  }
  return { status: "ok", value: decoded.data };
}

/** Explicit recovery-only helper. Normal delivery APIs never return dead-letter plaintext. */
export function decryptRedisEventDeadLetterRecord(options: {
  readonly encryptionKey: Uint8Array;
  readonly expectedIdentity: RedisEventDeadLetterStorageIdentity;
  readonly ciphertextEnvelope: string;
}): ResultType<
  EventDeadLetterRecord,
  | RedisEventDeadLetterConfigInvalid
  | RedisEventDeadLetterCiphertextInvalid
  | RedisEventDeadLetterContextMismatch
  | RedisEventDeadLetterAuthenticationFailed
  | RedisEventDeadLetterRecordInvalid
> {
  const decryptedResult = decryptRedisEventDeadLetterRecoveryValue({
    ...options,
    kind: "record",
  });
  const decrypted = decryptedResult.match<
    | string
    | RedisEventDeadLetterConfigInvalid
    | RedisEventDeadLetterCiphertextInvalid
    | RedisEventDeadLetterContextMismatch
    | RedisEventDeadLetterAuthenticationFailed
  >({
    ok: (value) => value,
    err: (error) => error,
  });
  if (TaggedError.is(decrypted)) return Result.err(decrypted);

  let serialized: unknown;
  try {
    serialized = SuperJSON.parse(decrypted);
  } catch {
    return Result.err(
      new RedisEventDeadLetterRecordInvalid({
        message: "Decrypted dead-letter record serialization is invalid",
      }),
    );
  }
  const record = decodeEventDeadLetterRecord(serialized);
  if (record.status === "error") {
    return Result.err(
      new RedisEventDeadLetterRecordInvalid({
        message: record.message,
      }),
    );
  }
  if (record.value.deadLetterId !== options.expectedIdentity.deadLetterId) {
    return Result.err(
      new RedisEventDeadLetterContextMismatch({
        expectedKind: "record",
        actualKind: "record",
        expectedIdentity: options.expectedIdentity,
        message: "Decrypted dead-letter record does not match the expected dead-letter identity",
      }),
    );
  }
  return Result.ok(record.value);
}

/** Redis adapter that durably accepts an encrypted v2 record before source acknowledgement. */
export class RedisEventDeadLetter implements EventDeadLetter {
  private readonly redis: Redis;
  private readonly encryptionKey: Uint8Array;
  private readonly indexKey: string;
  private readonly recordPrefix: string;
  private readonly evidencePrefix: string;
  private readonly recordTtlSeconds: number;
  private readonly indexMaxLen: number;

  constructor(options: RedisEventDeadLetterOptions) {
    const keyPrefix = options.keyPrefix ?? "lilac:event-bus:dead-letter";
    this.redis = options.redis;
    this.indexKey = `${keyPrefix}:v2:records`;
    this.recordPrefix = `${keyPrefix}:v2:record`;
    this.evidencePrefix = `${keyPrefix}:v2:evidence`;
    const config = validateRedisEventDeadLetterConfig({
      recordTtlSeconds: options.recordTtlSeconds ?? DEFAULT_RECORD_TTL_SECONDS,
      indexMaxLen: options.indexMaxLen ?? DEFAULT_INDEX_MAX_LEN,
      encryptionKey: options.encryptionKey,
    });
    const validated = config.match<RedisEventDeadLetterConfig | RedisEventDeadLetterConfigInvalid>({
      ok: (value) => value,
      err: (error) => error,
    });
    if (RedisEventDeadLetterConfigInvalid.is(validated)) throw validated;
    this.recordTtlSeconds = validated.recordTtlSeconds;
    this.indexMaxLen = validated.indexMaxLen;
    this.encryptionKey = validated.encryptionKey;
  }

  accept(
    record: EventDeadLetterRecord,
  ): Promise<ResultType<EventDeadLetterAcceptance, EventDeadLetterAcceptFailed>> {
    return captureDeadLetterAcceptance(async () => {
      const prepared = await this.prepare(record);
      const transaction = this.redis.multi();
      if (prepared.evidence !== undefined) {
        transaction.set(prepared.evidence.key, prepared.evidence.value, "EX", prepared.ttlSeconds);
      }
      transaction.set(prepared.record.key, prepared.record.value, "EX", prepared.ttlSeconds);
      transaction.zadd(
        prepared.index.key,
        prepared.index.score,
        JSON.stringify(prepared.index.fields),
      );
      transaction.zremrangebyrank(prepared.index.key, 0, -prepared.index.maxLen - 1);
      const results = await transaction.exec();
      const receipt = decodeRedisDeadLetterTransactionId(results, prepared.evidence !== undefined);
      if (receipt.status === "error") throw receipt.cause;
      return { id: prepared.id };
    });
  }

  async serverTimeMs(): Promise<number> {
    const decoded = decodeRedisDeadLetterTime(await this.redis.time());
    if (decoded.status === "error") throw new Panic({ message: decoded.message });
    return decoded.value.seconds * 1000 + Math.floor(decoded.value.microseconds / 1000);
  }

  async prepare(record: EventDeadLetterRecord): Promise<PreparedRedisEventDeadLetter> {
    const decodedRecord = decodeEventDeadLetterRecord(record);
    if (decodedRecord.status === "error") throw new Error(decodedRecord.message);
    record = decodedRecord.value;
    const recordKey = `${this.recordPrefix}:${record.deadLetterId}`;
    const evidenceKey = `${this.evidencePrefix}:${record.deadLetterId}`;
    const expiresAt = (await this.serverTimeMs()) + this.recordTtlSeconds * 1000;
    let persistedRecord = record;
    let evidenceMaterial: PreparedRedisEventDeadLetter["evidence"];

    if (record.evidence.wire.kind === "controlled-reference") {
      const locator = record.evidence.wire.locator;
      let evidencePlaintext: string;
      if (locator.kind === "redis-stream-entry") {
        if (
          locator.streamKey !== record.evidence.source.streamKey ||
          locator.messageId !== record.evidence.source.messageId ||
          locator.messageId !== record.source.messageId ||
          record.evidence.source.topic !== record.source.topic
        ) {
          throw new Error("Referenced Redis source evidence identity is inconsistent");
        }
        const entries = (await this.redis.xrange(
          locator.streamKey,
          locator.messageId,
          locator.messageId,
        )) as unknown;
        const evidence = decodeRedisDeadLetterEvidenceEntry(entries, locator.messageId);
        if (evidence.status === "error") throw new Error(evidence.message);
        evidencePlaintext = SuperJSON.stringify({
          version: 2,
          source: record.evidence.source,
          fields: evidence.fields,
        });
      } else {
        const existingEvidence = await this.redis.get(locator.key);
        if (existingEvidence === null) {
          throw new Error("Referenced Redis key evidence is no longer available");
        }
        evidencePlaintext = existingEvidence;
      }
      const encryptedEvidence = encryptRedisEventDeadLetterRecoveryValue({
        encryptionKey: this.encryptionKey,
        kind: "evidence",
        identity: { deadLetterId: record.deadLetterId, storageKey: evidenceKey },
        plaintext: evidencePlaintext,
      });
      const encryptedEvidenceValue = encryptedEvidence.match<
        string | RedisEventDeadLetterConfigInvalid | RedisEventDeadLetterEncryptFailed
      >({
        ok: (value) => value,
        err: (error) => error,
      });
      if (TaggedError.is(encryptedEvidenceValue)) throw encryptedEvidenceValue;
      evidenceMaterial = { key: evidenceKey, value: encryptedEvidenceValue };
      persistedRecord = {
        ...record,
        evidence: {
          source: record.evidence.source,
          wire: {
            kind: "controlled-reference",
            locator: { kind: "redis-key", key: evidenceKey, expiresAt },
            preview: record.evidence.wire.preview,
          },
        },
      };
    }

    const encryptedRecord = encryptRedisEventDeadLetterRecoveryValue({
      encryptionKey: this.encryptionKey,
      kind: "record",
      identity: { deadLetterId: record.deadLetterId, storageKey: recordKey },
      plaintext: SuperJSON.stringify(persistedRecord),
    });
    const encryptedRecordValue = encryptedRecord.match<
      string | RedisEventDeadLetterConfigInvalid | RedisEventDeadLetterEncryptFailed
    >({
      ok: (value) => value,
      err: (error) => error,
    });
    if (TaggedError.is(encryptedRecordValue)) throw encryptedRecordValue;
    const indexFields = [
      "version",
      "2",
      "deadLetterId",
      record.deadLetterId,
      "recordedAt",
      String(record.recordedAt),
      "topic",
      record.source.topic,
      "mode",
      record.source.mode,
      "reason",
      record.reason.kind,
      "recordKey",
      recordKey,
    ];
    if (record.delivery.kind === "managed-v2") {
      indexFields.push(
        "physicalGroup",
        record.delivery.physicalGroup,
        "attempt",
        String(record.delivery.attempt),
      );
    }
    return {
      id: record.deadLetterId,
      record: { key: recordKey, value: encryptedRecordValue },
      ...(evidenceMaterial === undefined ? {} : { evidence: evidenceMaterial }),
      index: {
        key: this.indexKey,
        fields: indexFields,
        score: record.recordedAt,
        maxLen: this.indexMaxLen,
      },
      ttlSeconds: this.recordTtlSeconds,
    };
  }
}
