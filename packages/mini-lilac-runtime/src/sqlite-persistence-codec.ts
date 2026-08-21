import SuperJSON from "superjson";
import { z } from "zod";

import {
  CorruptPersistedFields,
  isRecord,
  MalformedSerialization,
  UnsupportedVersion,
  type DecodedPersistedValue,
  type PersistedDataError,
  type PersistedDataIssueCode,
  type PersistenceProvenance,
} from "@stanley2058/lilac-utils";
import {
  miniLilacMessagesSchema,
  miniLilacReasoningSchema,
  miniLilacUserUIMessageSchema,
  type MiniLilacUIMessage,
  type MiniLilacUserUIMessage,
} from "@stanley2058/mini-lilac-client";
import {
  Panic,
  Result,
  type Err,
  type InferErr,
  type InferOk,
  type Ok,
  type Result as ResultType,
} from "better-result";

import {
  miniLilacPersistedModelMessagesSchema,
  miniLilacPersistedUserUiMessageSchema,
  miniLilacPersistedUiMessagesSchema,
  superJsonValueSchema,
  type MiniLilacPersistedModelMessageProjection,
  type MiniLilacPersistedSuperJsonValue,
  type MiniLilacPersistedUiMessageProjection,
  type MiniLilacPersistedUserUiMessageProjection,
} from "./sqlite-transcript-projection";

export type { MiniLilacPersistedSuperJsonValue } from "./sqlite-transcript-projection";

export const MINI_LILAC_PERSISTENCE_SCHEMA_VERSION = 8 as const;

const jsonValueSchema = z.json();
const commandRequestSchema = z.record(z.string(), jsonValueSchema);

export type MiniLilacPersistedJsonValue = z.output<typeof jsonValueSchema>;

type PersistedField =
  | "command_request"
  | "command_result"
  | "database_version"
  | "history_user_message"
  | "model_transcript"
  | "pending_finalization"
  | "terminal_result"
  | "ui_transcript";

type VersionedInput = {
  readonly schemaVersion: number;
  readonly recordId: string;
};

export type MiniLilacTranscriptCodecInput = VersionedInput & {
  readonly rawValues: readonly string[] | null;
};

export type MiniLilacTranscriptChainRow = {
  readonly id: number;
  readonly parentId: number | null;
  readonly depth: number;
  readonly valueJson: string;
  readonly hash: string;
};

export type MiniLilacMigrationTranscriptChainRow = MiniLilacTranscriptChainRow & {
  readonly sessionId: string;
  readonly lane: "model" | "ui";
};

const transcriptChainRowsSchema = z.array(
  z.strictObject({
    id: z.number().int().positive(),
    parentId: z.number().int().positive().nullable(),
    depth: z.number().int().positive(),
    valueJson: z.string(),
    hash: z.string(),
  }),
);
const migrationTranscriptChainRowsSchema = z.array(
  transcriptChainRowsSchema.element.extend({
    sessionId: z.string(),
    lane: z.enum(["model", "ui"]),
  }),
);

const steeringCommandPayloadSchema = z.strictObject({
  message: miniLilacUserUIMessageSchema,
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  clientCommandId: z.string().optional(),
});

const promoteMiniMainClaudeSessionBindingSchema = z.strictObject({
  providerId: z.string().min(1),
  requestId: z.string().min(1),
  attemptIndex: z.number().int().nonnegative(),
  nativeCwd: z.string().min(1),
  nativeLastModified: z.number().finite().nonnegative(),
  nativeContextTokens: z.number().int().nonnegative(),
  nativeContextMaxTokens: z.number().int().positive(),
  lastModelSpecifier: z.string().min(1),
  lastReasoning: z.string().min(1),
});
const promoteMiniNamedClaudeSessionBindingSchema = promoteMiniMainClaudeSessionBindingSchema.extend(
  {
    canonicalMessageCount: z.number().int().nonnegative(),
    canonicalHeadHash: z.string().min(1),
  },
);

const migrationIdentifierSchema = z.string().trim().min(1);
const migrationSessionSnapshotV4Schema = z.strictObject({
  id: migrationIdentifierSchema,
  activeRunId: migrationIdentifierSchema.nullable(),
  activeCompactionCommandId: migrationIdentifierSchema.nullable().optional(),
  status: z.enum(["idle", "streaming", "compacting", "cancelling", "error"]),
  cwd: z.string().min(1),
  model: migrationIdentifierSchema.nullable(),
  profile: migrationIdentifierSchema.nullable(),
  reasoning: miniLilacReasoningSchema.nullable(),
  title: z.string().max(100).optional(),
  inputTokens: z.number().int().nonnegative().nullable().optional(),
  inputTokensEstimated: z.boolean().optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  compactionThreshold: z.number().positive().max(1).optional(),
  queuedSteeringCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
});
const migrationSessionDataPartV4Schema = z.strictObject({
  type: z.literal("data-session"),
  id: migrationIdentifierSchema.optional(),
  data: migrationSessionSnapshotV4Schema,
});
const migrationCompactionMetricsV4Schema = {
  status: z.enum(["completed", "failed"]),
  messageCountBefore: z.number().int().nonnegative(),
  messageCountAfter: z.number().int().nonnegative().optional(),
  estimatedInputTokensBefore: z.number().int().nonnegative().optional(),
  estimatedInputTokensAfter: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
} as const;
const migrationCompactionEventV4Schema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("automatic"),
    reason: z.enum(["threshold", "overflow"]),
    ...migrationCompactionMetricsV4Schema,
  }),
  z.strictObject({
    source: z.literal("manual"),
    reason: z.literal("manual"),
    ...migrationCompactionMetricsV4Schema,
  }),
]);
const migrationCompactionDataPartV4Schema = z.strictObject({
  type: z.literal("data-compaction"),
  id: migrationIdentifierSchema.optional(),
  data: migrationCompactionEventV4Schema,
});
const migrationUiMessageEnvelopeSchema = z.looseObject({
  role: z.enum(["system", "user", "assistant"]),
  parts: z.array(superJsonValueSchema),
});

export type DecodedMiniMainClaudeBindingPromotion = z.output<
  typeof promoteMiniMainClaudeSessionBindingSchema
>;
export type DecodedMiniNamedClaudeBindingPromotion = z.output<
  typeof promoteMiniNamedClaudeSessionBindingSchema
>;
export type DecodedMiniLilacSteeringCommandPayload = z.output<typeof steeringCommandPayloadSchema>;
export type MigratedMiniLilacUiMessages = {
  readonly messages: MiniLilacUIMessage[];
  readonly changed: boolean;
};

export type MiniLilacCanonicalJsonCodecInput = VersionedInput & {
  readonly raw: string | null;
};

export type MiniLilacSuperJsonCodecInput = VersionedInput & {
  readonly raw: string | null;
  readonly field: "command_result" | "pending_finalization" | "terminal_result";
};

type DecodedVersion = {
  readonly version: 2 | 3 | 4 | 5 | 6 | 7 | 8;
  readonly provenance: Exclude<PersistenceProvenance, "missing-defaulted">;
};

function context(input: {
  readonly field: PersistedField;
  readonly version: number;
  readonly issueCode: PersistedDataIssueCode;
  readonly recordId: string;
}) {
  return {
    table: tableFor(input.field),
    field: input.field,
    version: input.version,
    issueCode: input.issueCode,
    recordId: input.recordId.slice(0, 128),
    message: `Persisted Mini Lilac ${input.field} ${input.issueCode}`,
  };
}

function tableFor(field: PersistedField): string {
  switch (field) {
    case "model_transcript":
    case "ui_transcript":
      return "transcript_nodes";
    case "command_request":
    case "command_result":
      return "commands";
    case "database_version":
      return "pragma_user_version";
    case "history_user_message":
      return "history_transitions";
    case "pending_finalization":
      return "pending_run_finalizations";
    case "terminal_result":
      return "runs";
  }
}

export function decodeMiniLilacDatabaseVersion(
  row: unknown,
): ResultType<number, CorruptPersistedFields> {
  const decoded = z.strictObject({ user_version: z.number().int().nonnegative() }).safeParse(row);
  if (decoded.success) return Result.ok(decoded.data.user_version);
  return Result.err(
    corrupt({
      field: "database_version",
      version: -1,
      issueCode: "invalid-row-version",
      recordId: "pragma-user-version",
    }),
  );
}

function corrupt(input: {
  readonly field: PersistedField;
  readonly version: number;
  readonly issueCode: PersistedDataIssueCode;
  readonly recordId: string;
}): CorruptPersistedFields {
  return new CorruptPersistedFields(context(input));
}

type AnyMiniResult = Ok<unknown, unknown> | Err<unknown, unknown>;
type MiniResultOutcome<R extends AnyMiniResult> =
  | { readonly ok: true; readonly value: InferOk<R> }
  | { readonly ok: false; readonly error: InferErr<R> };

function persistenceCodecResultOutcome<R extends AnyMiniResult>(result: R): MiniResultOutcome<R>;
function persistenceCodecResultOutcome<T, E>(
  result: ResultType<T, E>,
): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E } {
  return result.match<
    { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E }
  >({ ok: (value) => ({ ok: true, value }), err: (error) => ({ ok: false, error }) });
}

function decodeVersion(
  schemaVersion: number,
  field: PersistedField,
  recordId: string,
): ResultType<DecodedVersion, UnsupportedVersion | CorruptPersistedFields> {
  if (!Number.isInteger(schemaVersion) || schemaVersion < 2) {
    return Result.err(
      corrupt({
        field,
        version: schemaVersion,
        issueCode: "invalid-row-version",
        recordId,
      }),
    );
  }
  if (schemaVersion > MINI_LILAC_PERSISTENCE_SCHEMA_VERSION) {
    return Result.err(
      new UnsupportedVersion(
        context({
          field,
          version: schemaVersion,
          issueCode: "unsupported-version",
          recordId,
        }),
      ),
    );
  }
  switch (schemaVersion) {
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
    case 7:
    case 8:
      return Result.ok({
        version: schemaVersion,
        provenance:
          schemaVersion === MINI_LILAC_PERSISTENCE_SCHEMA_VERSION ? "current" : "migrated",
      });
  }
  return Result.err(
    corrupt({
      field,
      version: schemaVersion,
      issueCode: "invalid-row-version",
      recordId,
    }),
  );
}

function decodePlainJson(
  raw: string,
  input: VersionedInput & { readonly field: PersistedField },
): ResultType<MiniLilacPersistedJsonValue, MalformedSerialization | CorruptPersistedFields> {
  const parsed = Result.try<unknown, unknown>({
    try: () => JSON.parse(raw),
    catch: (cause) => cause,
  });
  const parsedOutcome = parsed.match<
    { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown }
  >({ ok: (value) => ({ ok: true, value }), err: (error) => ({ ok: false, error }) });
  if (!parsedOutcome.ok) {
    if (Panic.is(parsedOutcome.error)) throw parsedOutcome.error;
    return Result.err(
      new MalformedSerialization(
        context({
          field: input.field,
          version: input.schemaVersion,
          issueCode: "malformed-json",
          recordId: input.recordId,
        }),
      ),
    );
  }
  const value = parsedOutcome.value;
  const decoded = jsonValueSchema.safeParse(value);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    corrupt({
      field: input.field,
      version: input.schemaVersion,
      issueCode: "invalid-row-field",
      recordId: input.recordId,
    }),
  );
}

function decodeSuperJson(
  raw: string,
  input: VersionedInput & { readonly field: PersistedField },
): ResultType<unknown, MalformedSerialization | CorruptPersistedFields> {
  const parsed = Result.try<unknown, unknown>({
    try: () => JSON.parse(raw),
    catch: (cause) => cause,
  });
  const parsedOutcome = parsed.match<
    { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown }
  >({ ok: (value) => ({ ok: true, value }), err: (error) => ({ ok: false, error }) });
  if (!parsedOutcome.ok) {
    if (Panic.is(parsedOutcome.error)) throw parsedOutcome.error;
    return Result.err(
      new MalformedSerialization(
        context({
          field: input.field,
          version: input.schemaVersion,
          issueCode: "malformed-json",
          recordId: input.recordId,
        }),
      ),
    );
  }
  const envelope = parsedOutcome.value;
  if (
    !isRecord(envelope) ||
    !("json" in envelope) ||
    Object.keys(envelope).some((key) => key !== "json" && key !== "meta")
  ) {
    return Result.err(
      corrupt({
        field: input.field,
        version: input.schemaVersion,
        issueCode: "invalid-row-field",
        recordId: input.recordId,
      }),
    );
  }
  const superJson = Result.try<unknown, unknown>({
    try: () => SuperJSON.parse(raw),
    catch: (cause) => cause,
  });
  const superJsonOutcome = superJson.match<
    { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown }
  >({ ok: (value) => ({ ok: true, value }), err: (error) => ({ ok: false, error }) });
  if (superJsonOutcome.ok) return Result.ok(superJsonOutcome.value);
  if (Panic.is(superJsonOutcome.error)) throw superJsonOutcome.error;
  return Result.err(
    new MalformedSerialization(
      context({
        field: input.field,
        version: input.schemaVersion,
        issueCode: "malformed-json",
        recordId: input.recordId,
      }),
    ),
  );
}

export function migrateMiniLilacUiMessageValue(input: {
  readonly value: unknown;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<
  { readonly message: MiniLilacUIMessage | null; readonly changed: boolean },
  CorruptPersistedFields
> {
  const envelope = migrationUiMessageEnvelopeSchema.safeParse(input.value);
  if (!envelope.success) {
    return Result.err(
      corrupt({
        field: "ui_transcript",
        version: input.schemaVersion,
        issueCode: "invalid-transcript-messages",
        recordId: input.recordId,
      }),
    );
  }
  const parts: MiniLilacPersistedSuperJsonValue[] = [];
  let changed = false;
  for (const part of envelope.data.parts) {
    if (migrationSessionDataPartV4Schema.safeParse(part).success) {
      changed = true;
      continue;
    }
    const legacyCompaction = migrationCompactionDataPartV4Schema.safeParse(part);
    if (legacyCompaction.success) {
      const { status, ...data } = legacyCompaction.data.data;
      parts.push({
        type: legacyCompaction.data.type,
        ...(legacyCompaction.data.id === undefined ? {} : { id: legacyCompaction.data.id }),
        data: {
          ...data,
          phase: status,
          ...(status === "completed" ? { outcome: "compacted" as const } : {}),
        },
      });
      changed = true;
      continue;
    }
    parts.push(part);
  }
  if (parts.length === 0 && changed && envelope.data.role !== "user") {
    return Result.ok({ message: null, changed: true });
  }
  const candidate = changed ? { ...envelope.data, parts } : input.value;
  const message = miniLilacMessagesSchema.element.safeParse(candidate);
  if (!message.success) {
    return Result.err(
      corrupt({
        field: "ui_transcript",
        version: input.schemaVersion,
        issueCode: "invalid-transcript-messages",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ message: message.data, changed });
}

function migrateMiniLilacUiMessageValues(input: {
  readonly values: readonly MiniLilacPersistedSuperJsonValue[];
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<MigratedMiniLilacUiMessages, CorruptPersistedFields> {
  const messages: MiniLilacUIMessage[] = [];
  let changed = false;
  for (const [index, value] of input.values.entries()) {
    const migrated = migrateMiniLilacUiMessageValue({
      value,
      schemaVersion: input.schemaVersion,
      recordId: `${input.recordId}:${index}`,
    });
    const migratedOutcome = persistenceCodecResultOutcome(migrated);
    if (!migratedOutcome.ok) return Result.err(migratedOutcome.error);
    changed ||= migratedOutcome.value.changed;
    if (migratedOutcome.value.message !== null) messages.push(migratedOutcome.value.message);
  }
  return Result.ok({ messages, changed });
}

export function decodeMiniLilacMigrationUiTranscript(
  input: MiniLilacTranscriptCodecInput,
): ResultType<DecodedPersistedValue<MigratedMiniLilacUiMessages>, PersistedDataError> {
  const version = decodeVersion(input.schemaVersion, "ui_transcript", input.recordId);
  const versionOutcome = persistenceCodecResultOutcome(version);
  if (!versionOutcome.ok) return Result.err(versionOutcome.error);
  if (input.rawValues === null) {
    return Result.ok({
      value: { messages: [], changed: false },
      provenance: "missing-defaulted",
    });
  }
  const values: MiniLilacPersistedSuperJsonValue[] = [];
  for (const raw of input.rawValues) {
    const value = decodeSuperJson(raw, { ...input, field: "ui_transcript" });
    const valueOutcome = persistenceCodecResultOutcome(value);
    if (!valueOutcome.ok) return Result.err(valueOutcome.error);
    const decoded = superJsonValueSchema.safeParse(valueOutcome.value);
    if (!decoded.success) {
      return Result.err(
        corrupt({
          field: "ui_transcript",
          version: versionOutcome.value.version,
          issueCode: "invalid-transcript-messages",
          recordId: input.recordId,
        }),
      );
    }
    values.push(decoded.data);
  }
  const migrated = migrateMiniLilacUiMessageValues({
    values,
    schemaVersion: versionOutcome.value.version,
    recordId: input.recordId,
  });
  const migratedOutcome = persistenceCodecResultOutcome(migrated);
  if (!migratedOutcome.ok) return Result.err(migratedOutcome.error);
  return Result.ok({
    value: migratedOutcome.value,
    provenance: versionOutcome.value.provenance,
  });
}

export function decodeMiniLilacMigrationUserUiMessage(input: {
  readonly raw: string;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<MiniLilacUserUIMessage>, PersistedDataError> {
  const version = decodeVersion(input.schemaVersion, "history_user_message", input.recordId);
  const versionOutcome = persistenceCodecResultOutcome(version);
  if (!versionOutcome.ok) return Result.err(versionOutcome.error);
  const value = decodeSuperJson(input.raw, { ...input, field: "history_user_message" });
  const valueOutcome = persistenceCodecResultOutcome(value);
  if (!valueOutcome.ok) return Result.err(valueOutcome.error);
  const migrated = migrateMiniLilacUiMessageValue({
    value: valueOutcome.value,
    schemaVersion: versionOutcome.value.version,
    recordId: input.recordId,
  });
  const migratedOutcome = persistenceCodecResultOutcome(migrated);
  if (!migratedOutcome.ok) return Result.err(migratedOutcome.error);
  const message = miniLilacUserUIMessageSchema.safeParse(migratedOutcome.value.message);
  if (!message.success) {
    return Result.err(
      corrupt({
        field: "history_user_message",
        version: versionOutcome.value.version,
        issueCode: "invalid-transcript-messages",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: message.data, provenance: versionOutcome.value.provenance });
}

export function decodeMiniLilacMigrationModelPrefix(input: {
  readonly raw: string;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<
  DecodedPersistedValue<MiniLilacPersistedModelMessageProjection[]>,
  PersistedDataError
> {
  const version = decodeVersion(input.schemaVersion, "model_transcript", input.recordId);
  const versionOutcome = persistenceCodecResultOutcome(version);
  if (!versionOutcome.ok) return Result.err(versionOutcome.error);
  const value = decodeSuperJson(input.raw, { ...input, field: "model_transcript" });
  const valueOutcome = persistenceCodecResultOutcome(value);
  if (!valueOutcome.ok) return Result.err(valueOutcome.error);
  const messages = miniLilacPersistedModelMessagesSchema.safeParse(valueOutcome.value);
  if (!messages.success) {
    return Result.err(
      corrupt({
        field: "model_transcript",
        version: versionOutcome.value.version,
        issueCode: "invalid-transcript-messages",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({
    value: messages.data,
    provenance: versionOutcome.value.provenance,
  });
}

export function decodeMiniLilacMigrationUiPrefix(input: {
  readonly raw: string;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<MigratedMiniLilacUiMessages>, PersistedDataError> {
  const version = decodeVersion(input.schemaVersion, "ui_transcript", input.recordId);
  const versionOutcome = persistenceCodecResultOutcome(version);
  if (!versionOutcome.ok) return Result.err(versionOutcome.error);
  const value = decodeSuperJson(input.raw, { ...input, field: "ui_transcript" });
  const valueOutcome = persistenceCodecResultOutcome(value);
  if (!valueOutcome.ok) return Result.err(valueOutcome.error);
  const values = z.array(superJsonValueSchema).safeParse(valueOutcome.value);
  if (!values.success) {
    return Result.err(
      corrupt({
        field: "ui_transcript",
        version: versionOutcome.value.version,
        issueCode: "invalid-transcript-messages",
        recordId: input.recordId,
      }),
    );
  }
  const migrated = migrateMiniLilacUiMessageValues({
    values: values.data,
    schemaVersion: versionOutcome.value.version,
    recordId: input.recordId,
  });
  const migratedOutcome = persistenceCodecResultOutcome(migrated);
  if (!migratedOutcome.ok) return Result.err(migratedOutcome.error);
  return Result.ok({
    value: migratedOutcome.value,
    provenance: versionOutcome.value.provenance,
  });
}

function decodeTranscript<T>(input: {
  readonly rawValues: readonly string[] | null;
  readonly schemaVersion: number;
  readonly recordId: string;
  readonly field: "model_transcript" | "ui_transcript";
  readonly schema: z.ZodType<T>;
}): ResultType<DecodedPersistedValue<T>, PersistedDataError> {
  const version = decodeVersion(input.schemaVersion, input.field, input.recordId);
  const versionOutcome = persistenceCodecResultOutcome(version);
  if (!versionOutcome.ok) return Result.err(versionOutcome.error);
  if (input.rawValues === null) {
    const empty = input.schema.safeParse([]);
    if (!empty.success) {
      return Result.err(
        corrupt({
          field: input.field,
          version: versionOutcome.value.version,
          issueCode: "invalid-transcript-messages",
          recordId: input.recordId,
        }),
      );
    }
    return Result.ok({ value: empty.data, provenance: "missing-defaulted" });
  }
  const values: unknown[] = [];
  for (const raw of input.rawValues) {
    const decoded = decodeSuperJson(raw, {
      field: input.field,
      schemaVersion: versionOutcome.value.version,
      recordId: input.recordId,
    });
    const decodedOutcome = persistenceCodecResultOutcome(decoded);
    if (!decodedOutcome.ok) return Result.err(decodedOutcome.error);
    values.push(decodedOutcome.value);
  }
  const transcript = input.schema.safeParse(values);
  if (!transcript.success) {
    return Result.err(
      corrupt({
        field: input.field,
        version: versionOutcome.value.version,
        issueCode: "invalid-transcript-messages",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({
    value: transcript.data,
    provenance: versionOutcome.value.provenance,
  });
}

export function decodeMiniLilacTranscriptChain(
  input: VersionedInput & {
    readonly headId: number | null;
    readonly lane: "model" | "ui";
    readonly rows: unknown;
  },
): ResultType<DecodedPersistedValue<string[]>, PersistedDataError> {
  const field = input.lane === "model" ? "model_transcript" : "ui_transcript";
  const version = decodeVersion(input.schemaVersion, field, input.recordId);
  const versionOutcome = persistenceCodecResultOutcome(version);
  if (!versionOutcome.ok) return Result.err(versionOutcome.error);
  const decodedRows = transcriptChainRowsSchema.safeParse(input.rows);
  if (!decodedRows.success) {
    return Result.err(
      corrupt({
        field,
        version: versionOutcome.value.version,
        issueCode: "invalid-row-field",
        recordId: input.recordId,
      }),
    );
  }
  if (input.headId === null && decodedRows.data.length === 0) {
    return Result.ok({ value: [], provenance: "missing-defaulted" });
  }
  let parentId: number | null = null;
  let parentHash = "root";
  const values: string[] = [];
  for (const [index, row] of decodedRows.data.entries()) {
    const hash = new Bun.CryptoHasher("sha256")
      .update(parentHash)
      .update("\0")
      .update(row.valueJson)
      .digest("hex");
    if (
      !Number.isSafeInteger(row.id) ||
      row.id <= 0 ||
      row.parentId !== parentId ||
      row.depth !== index + 1 ||
      row.hash !== hash
    ) {
      return Result.err(
        corrupt({
          field,
          version: versionOutcome.value.version,
          issueCode: "digest-mismatch",
          recordId: input.recordId,
        }),
      );
    }
    parentId = row.id;
    parentHash = row.hash;
    values.push(row.valueJson);
  }
  if (parentId !== input.headId) {
    return Result.err(
      corrupt({
        field,
        version: versionOutcome.value.version,
        issueCode: "digest-mismatch",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: values, provenance: versionOutcome.value.provenance });
}

export function decodeMiniLilacMigrationTranscriptRows(input: {
  readonly rows: unknown;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<MiniLilacMigrationTranscriptChainRow[]>, PersistedDataError> {
  const version = decodeVersion(input.schemaVersion, "model_transcript", input.recordId);
  const versionOutcome = persistenceCodecResultOutcome(version);
  if (!versionOutcome.ok) return Result.err(versionOutcome.error);
  const rows = migrationTranscriptChainRowsSchema.safeParse(input.rows);
  if (!rows.success) {
    return Result.err(
      corrupt({
        field: "model_transcript",
        version: versionOutcome.value.version,
        issueCode: "invalid-row-field",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: rows.data, provenance: versionOutcome.value.provenance });
}

export function decodeMiniLilacModelTranscript(
  input: MiniLilacTranscriptCodecInput,
): ResultType<
  DecodedPersistedValue<MiniLilacPersistedModelMessageProjection[]>,
  PersistedDataError
> {
  return decodeTranscript({
    ...input,
    field: "model_transcript",
    schema: miniLilacPersistedModelMessagesSchema,
  });
}

export function decodeMiniLilacUiTranscript(
  input: MiniLilacTranscriptCodecInput,
): ResultType<DecodedPersistedValue<MiniLilacPersistedUiMessageProjection[]>, PersistedDataError> {
  return decodeTranscript({
    ...input,
    field: "ui_transcript",
    schema: miniLilacPersistedUiMessagesSchema,
  });
}

export function decodeMiniLilacHistoryUserMessage(input: {
  readonly raw: string | null;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<
  DecodedPersistedValue<MiniLilacPersistedUserUiMessageProjection | null>,
  PersistedDataError
> {
  const version = decodeVersion(input.schemaVersion, "history_user_message", input.recordId);
  const versionOutcome = persistenceCodecResultOutcome(version);
  if (!versionOutcome.ok) return Result.err(versionOutcome.error);
  if (input.raw === null) return Result.ok({ value: null, provenance: "missing-defaulted" });
  const value = decodeSuperJson(input.raw, { ...input, field: "history_user_message" });
  const valueOutcome = persistenceCodecResultOutcome(value);
  if (!valueOutcome.ok) return Result.err(valueOutcome.error);
  const message = miniLilacPersistedUserUiMessageSchema.safeParse(valueOutcome.value);
  if (!message.success) {
    return Result.err(
      corrupt({
        field: "history_user_message",
        version: versionOutcome.value.version,
        issueCode: "invalid-row-field",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: message.data, provenance: versionOutcome.value.provenance });
}

export function decodeMiniLilacCommandRequest(
  input: MiniLilacCanonicalJsonCodecInput,
): ResultType<
  DecodedPersistedValue<Record<string, MiniLilacPersistedJsonValue> | null>,
  PersistedDataError
> {
  const version = decodeVersion(input.schemaVersion, "command_request", input.recordId);
  const versionOutcome = persistenceCodecResultOutcome(version);
  if (!versionOutcome.ok) return Result.err(versionOutcome.error);
  if (input.raw === null) return Result.ok({ value: null, provenance: "missing-defaulted" });
  const value = decodePlainJson(input.raw, { ...input, field: "command_request" });
  const valueOutcome = persistenceCodecResultOutcome(value);
  if (!valueOutcome.ok) return Result.err(valueOutcome.error);
  if (
    isRecord(valueOutcome.value) &&
    "json" in valueOutcome.value &&
    Object.keys(valueOutcome.value).every((key) => key === "json" || key === "meta")
  ) {
    return Result.err(
      corrupt({
        field: "command_request",
        version: versionOutcome.value.version,
        issueCode: "invalid-row-field",
        recordId: input.recordId,
      }),
    );
  }
  const request = commandRequestSchema.safeParse(valueOutcome.value);
  if (!request.success) {
    return Result.err(
      corrupt({
        field: "command_request",
        version: versionOutcome.value.version,
        issueCode: "invalid-row-field",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: request.data, provenance: versionOutcome.value.provenance });
}

export function decodeMiniLilacSteeringCommandRequest(
  input: MiniLilacCanonicalJsonCodecInput,
): ResultType<DecodedPersistedValue<DecodedMiniLilacSteeringCommandPayload>, PersistedDataError> {
  const request = decodeMiniLilacCommandRequest(input);
  const requestOutcome = persistenceCodecResultOutcome(request);
  if (!requestOutcome.ok) return Result.err(requestOutcome.error);
  const decoded = steeringCommandPayloadSchema.safeParse(requestOutcome.value.value);
  if (!decoded.success) {
    return Result.err(
      corrupt({
        field: "command_request",
        version: input.schemaVersion,
        issueCode: "invalid-row-field",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: decoded.data, provenance: requestOutcome.value.provenance });
}

export function decodeMiniLilacSuperJsonPayload(
  input: MiniLilacSuperJsonCodecInput,
): ResultType<DecodedPersistedValue<MiniLilacPersistedSuperJsonValue>, PersistedDataError> {
  const version = decodeVersion(input.schemaVersion, input.field, input.recordId);
  const versionOutcome = persistenceCodecResultOutcome(version);
  if (!versionOutcome.ok) return Result.err(versionOutcome.error);
  if (input.raw === null) return Result.ok({ value: null, provenance: "missing-defaulted" });
  const value = decodeSuperJson(input.raw, input);
  const valueOutcome = persistenceCodecResultOutcome(value);
  if (!valueOutcome.ok) return Result.err(valueOutcome.error);
  const decoded = superJsonValueSchema.safeParse(valueOutcome.value);
  if (!decoded.success) {
    return Result.err(
      corrupt({
        field: input.field,
        version: versionOutcome.value.version,
        issueCode: "invalid-row-field",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: decoded.data, provenance: versionOutcome.value.provenance });
}

export function decodeMiniMainClaudeBindingPromotion(
  input: MiniLilacSuperJsonCodecInput,
): ResultType<DecodedPersistedValue<DecodedMiniMainClaudeBindingPromotion>, PersistedDataError> {
  const payload = decodeMiniLilacSuperJsonPayload(input);
  const payloadOutcome = persistenceCodecResultOutcome(payload);
  if (!payloadOutcome.ok) return Result.err(payloadOutcome.error);
  const decoded = promoteMiniMainClaudeSessionBindingSchema.safeParse(payloadOutcome.value.value);
  if (!decoded.success) {
    return Result.err(
      corrupt({
        field: input.field,
        version: input.schemaVersion,
        issueCode: "invalid-row-field",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: decoded.data, provenance: payloadOutcome.value.provenance });
}

export function decodeMiniNamedClaudeBindingPromotion(
  input: MiniLilacSuperJsonCodecInput,
): ResultType<DecodedPersistedValue<DecodedMiniNamedClaudeBindingPromotion>, PersistedDataError> {
  const payload = decodeMiniLilacSuperJsonPayload(input);
  const payloadOutcome = persistenceCodecResultOutcome(payload);
  if (!payloadOutcome.ok) return Result.err(payloadOutcome.error);
  const decoded = promoteMiniNamedClaudeSessionBindingSchema.safeParse(payloadOutcome.value.value);
  if (!decoded.success) {
    return Result.err(
      corrupt({
        field: input.field,
        version: input.schemaVersion,
        issueCode: "invalid-row-field",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: decoded.data, provenance: payloadOutcome.value.provenance });
}

const modelMessage = SuperJSON.stringify({ role: "user", content: "current" });
const legacyModelMessage = SuperJSON.stringify({ role: "assistant", content: "legacy-v2" });
const uiMessage = SuperJSON.stringify({
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "current" }],
});
const legacyUiMessage = SuperJSON.stringify({
  id: "assistant-v2",
  role: "assistant",
  parts: [{ type: "text", text: "legacy-v2" }],
});

export const miniLilacModelTranscriptCodecCases = {
  current: {
    input: { rawValues: [modelMessage], schemaVersion: 8, recordId: "current" },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: { rawValues: [legacyModelMessage], schemaVersion: 2, recordId: "legacy-v2" },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { rawValues: null, schemaVersion: 8, recordId: "missing" },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: { rawValues: [modelMessage], schemaVersion: 9, recordId: "unsupported" },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { rawValues: ["{"], schemaVersion: 8, recordId: "malformed" },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      rawValues: [SuperJSON.stringify({ nope: true })],
      schemaVersion: 8,
      recordId: "corrupt",
    },
    outcome: "error",
  },
} as const;

export const miniLilacUiTranscriptCodecCases = {
  current: {
    input: { rawValues: [uiMessage], schemaVersion: 8, recordId: "current" },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: { rawValues: [legacyUiMessage], schemaVersion: 2, recordId: "legacy-v2" },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { rawValues: null, schemaVersion: 8, recordId: "missing" },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: { rawValues: [uiMessage], schemaVersion: 9, recordId: "unsupported" },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { rawValues: ["{"], schemaVersion: 8, recordId: "malformed" },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      rawValues: [SuperJSON.stringify({ role: "user" })],
      schemaVersion: 8,
      recordId: "corrupt",
    },
    outcome: "error",
  },
} as const;

export const miniLilacCommandRequestCodecCases = {
  current: {
    input: { raw: '{"message":"current"}', schemaVersion: 8, recordId: "current" },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: { raw: '{"message":"legacy"}', schemaVersion: 2, recordId: "legacy" },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { raw: null, schemaVersion: 8, recordId: "missing" },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: { raw: "{}", schemaVersion: 9, recordId: "unsupported" },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { raw: "{", schemaVersion: 8, recordId: "malformed" },
    outcome: "error",
  },
  "corrupt-fields": {
    input: { raw: "[]", schemaVersion: 8, recordId: "corrupt" },
    outcome: "error",
  },
} as const;
