import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type Redis from "ioredis";
import SuperJSON from "superjson";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import {
  captureDeadLetterAcceptance,
  type EventDeadLetter,
  type EventDeadLetterAcceptance,
  type EventDeadLetterAcceptFailed,
  type EventDeadLetterRecordV1,
} from "./event-dead-letter";

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
  /** Exact maximum number of payload-free metadata entries retained in the index stream. */
  readonly indexMaxLen?: number;
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
  const config = validateRedisEventDeadLetterConfig({
    recordTtlSeconds: 1,
    indexMaxLen: 1,
    encryptionKey: options.encryptionKey,
  });
  if (config.status === "error") return Result.err(config.error);

  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(CIPHERTEXT_ALGORITHM, config.value.encryptionKey, nonce, {
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
  const config = validateRedisEventDeadLetterConfig({
    recordTtlSeconds: 1,
    indexMaxLen: 1,
    encryptionKey: options.encryptionKey,
  });
  if (config.status === "error") return Result.err(config.error);
  const envelope = decodeRedisEventDeadLetterCiphertextEnvelope(options.ciphertextEnvelope);
  if (envelope.status === "error") return Result.err(envelope.error);
  if (envelope.value.kind !== options.kind) {
    return Result.err(
      new RedisEventDeadLetterContextMismatch({
        expectedKind: options.kind,
        actualKind: envelope.value.kind,
        expectedIdentity: options.expectedIdentity,
        message: "Dead-letter ciphertext kind does not match the recovery operation",
      }),
    );
  }

  const nonce = decodeCanonicalBase64(envelope.value.nonce, NONCE_BYTES);
  const authTag = decodeCanonicalBase64(envelope.value.authTag, AUTH_TAG_BYTES);
  const ciphertext = decodeCanonicalBase64(envelope.value.ciphertext);
  if (!nonce || !authTag || !ciphertext) {
    return Result.err(
      new RedisEventDeadLetterCiphertextInvalid({
        message: "Dead-letter ciphertext envelope contains invalid binary fields",
      }),
    );
  }

  try {
    const decipher = createDecipheriv(CIPHERTEXT_ALGORITHM, config.value.encryptionKey, nonce, {
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

const eventDeadLetterRecordSchema: z.ZodType<EventDeadLetterRecordV1> = z.strictObject({
  version: z.literal(1),
  deadLetterId: z.string(),
  recordedAt: z.number(),
  source: z.strictObject({
    topic: z.string(),
    cursor: z.string(),
    messageId: z.string(),
    mode: z.enum(["work", "fanout", "tail"]),
  }),
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
  ]),
  evidence: eventTransportEvidenceSchema,
});

/** Explicit recovery-only helper. Normal delivery APIs never return dead-letter plaintext. */
export function decryptRedisEventDeadLetterRecord(options: {
  readonly encryptionKey: Uint8Array;
  readonly expectedIdentity: RedisEventDeadLetterStorageIdentity;
  readonly ciphertextEnvelope: string;
}): ResultType<
  EventDeadLetterRecordV1,
  | RedisEventDeadLetterConfigInvalid
  | RedisEventDeadLetterCiphertextInvalid
  | RedisEventDeadLetterContextMismatch
  | RedisEventDeadLetterAuthenticationFailed
  | RedisEventDeadLetterRecordInvalid
> {
  const decrypted = decryptRedisEventDeadLetterRecoveryValue({
    ...options,
    kind: "record",
  });
  if (decrypted.status === "error") return Result.err(decrypted.error);

  let serialized: unknown;
  try {
    serialized = SuperJSON.parse(decrypted.value);
  } catch {
    return Result.err(
      new RedisEventDeadLetterRecordInvalid({
        message: "Decrypted dead-letter record serialization is invalid",
      }),
    );
  }
  const record = eventDeadLetterRecordSchema.safeParse(serialized);
  if (!record.success) {
    return Result.err(
      new RedisEventDeadLetterRecordInvalid({
        message: "Decrypted dead-letter record contract is invalid or unsupported",
      }),
    );
  }
  if (record.data.deadLetterId !== options.expectedIdentity.deadLetterId) {
    return Result.err(
      new RedisEventDeadLetterContextMismatch({
        expectedKind: "record",
        actualKind: "record",
        expectedIdentity: options.expectedIdentity,
        message: "Decrypted dead-letter record does not match the expected dead-letter identity",
      }),
    );
  }
  return Result.ok(record.data);
}

/** Redis adapter that durably accepts an encrypted v1 record before source acknowledgement. */
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
    this.indexKey = `${keyPrefix}:records`;
    this.recordPrefix = `${keyPrefix}:record`;
    this.evidencePrefix = `${keyPrefix}:evidence`;
    const config = validateRedisEventDeadLetterConfig({
      recordTtlSeconds: options.recordTtlSeconds ?? DEFAULT_RECORD_TTL_SECONDS,
      indexMaxLen: options.indexMaxLen ?? DEFAULT_INDEX_MAX_LEN,
      encryptionKey: options.encryptionKey,
    });
    if (config.status === "error") throw config.error;
    this.recordTtlSeconds = config.value.recordTtlSeconds;
    this.indexMaxLen = config.value.indexMaxLen;
    this.encryptionKey = config.value.encryptionKey;
  }

  accept(
    record: EventDeadLetterRecordV1,
  ): Promise<ResultType<EventDeadLetterAcceptance, EventDeadLetterAcceptFailed>> {
    return captureDeadLetterAcceptance(async () => {
      const recordKey = `${this.recordPrefix}:${record.deadLetterId}`;
      const evidenceKey = `${this.evidencePrefix}:${record.deadLetterId}`;
      const expiresAt = Date.now() + this.recordTtlSeconds * 1000;
      let persistedRecord = record;
      let encodedEvidence: string | undefined;

      if (record.evidence.wire.kind === "controlled-reference") {
        const locator = record.evidence.wire.locator;
        let evidencePlaintext: string;
        if (locator.kind === "redis-stream-entry") {
          const entries = await this.redis.xrange(
            locator.streamKey,
            locator.messageId,
            locator.messageId,
          );
          const fields = entries[0]?.[1];
          if (!fields) throw new Error("Referenced Redis source evidence is no longer available");
          evidencePlaintext = SuperJSON.stringify({
            version: 1,
            source: record.evidence.source,
            fields,
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
        if (encryptedEvidence.status === "error") throw encryptedEvidence.error;
        encodedEvidence = encryptedEvidence.value;
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
      if (encryptedRecord.status === "error") throw encryptedRecord.error;

      const transaction = this.redis.multi();
      if (encodedEvidence !== undefined) {
        transaction.set(evidenceKey, encodedEvidence, "EX", this.recordTtlSeconds);
      }
      transaction.set(recordKey, encryptedRecord.value, "EX", this.recordTtlSeconds);
      transaction.xadd(
        this.indexKey,
        "MAXLEN",
        "=",
        String(this.indexMaxLen),
        "*",
        "version",
        "1",
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
        "expiresAt",
        String(expiresAt),
      );
      const results = await transaction.exec();
      if (!results) throw new Error("Redis dead-letter transaction was aborted");
      for (const [error] of results) {
        if (error) throw error;
      }
      const id = results.at(-1)?.[1];
      if (typeof id !== "string") throw new Error("Redis dead-letter XADD returned invalid id");
      return { id };
    });
  }
}

export function createRedisEventDeadLetter(
  options: RedisEventDeadLetterOptions,
): RedisEventDeadLetter {
  return new RedisEventDeadLetter(options);
}
