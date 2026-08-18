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
import { Panic, Result, type Result as ResultType } from "better-result";

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
    let $migratedResultValue13777!: import("better-result").InferOk<NonNullable<typeof migrated>>;
    let $migratedResultError13777!: import("better-result").InferErr<NonNullable<typeof migrated>>;
    const $migratedResultOk13777 = migrated.match({
      ok: (value) => {
        $migratedResultValue13777 = value;
        return true;
      },
      err: (error) => {
        $migratedResultError13777 = error;
        return false;
      },
    });
    if (($migratedResultOk13777 ? "ok" : "error") === "error")
      return Result.err($migratedResultError13777);
    changed ||= $migratedResultValue13777.changed;
    if ($migratedResultValue13777.message !== null)
      messages.push($migratedResultValue13777.message);
  }
  return Result.ok({ messages, changed });
}

export function decodeMiniLilacMigrationUiTranscript(
  input: MiniLilacTranscriptCodecInput,
): ResultType<DecodedPersistedValue<MigratedMiniLilacUiMessages>, PersistedDataError> {
  const version = decodeVersion(input.schemaVersion, "ui_transcript", input.recordId);
  let $versionResultValue14362!: import("better-result").InferOk<NonNullable<typeof version>>;
  let $versionResultError14362!: import("better-result").InferErr<NonNullable<typeof version>>;
  const $versionResultOk14362 = version.match({
    ok: (value) => {
      $versionResultValue14362 = value;
      return true;
    },
    err: (error) => {
      $versionResultError14362 = error;
      return false;
    },
  });
  if (($versionResultOk14362 ? "ok" : "error") === "error")
    return Result.err($versionResultError14362);
  if (input.rawValues === null) {
    return Result.ok({
      value: { messages: [], changed: false },
      provenance: "missing-defaulted",
    });
  }
  const values: MiniLilacPersistedSuperJsonValue[] = [];
  for (const raw of input.rawValues) {
    const value = decodeSuperJson(raw, { ...input, field: "ui_transcript" });
    let $valueResultValue14770!: import("better-result").InferOk<NonNullable<typeof value>>;
    let $valueResultError14770!: import("better-result").InferErr<NonNullable<typeof value>>;
    const $valueResultOk14770 = value.match({
      ok: (value) => {
        $valueResultValue14770 = value;
        return true;
      },
      err: (error) => {
        $valueResultError14770 = error;
        return false;
      },
    });
    if (($valueResultOk14770 ? "ok" : "error") === "error")
      return Result.err($valueResultError14770);
    const decoded = superJsonValueSchema.safeParse($valueResultValue14770);
    if (!decoded.success) {
      return Result.err(
        corrupt({
          field: "ui_transcript",
          version: $versionResultValue14362.version,
          issueCode: "invalid-transcript-messages",
          recordId: input.recordId,
        }),
      );
    }
    values.push(decoded.data);
  }
  const migrated = migrateMiniLilacUiMessageValues({
    values,
    schemaVersion: $versionResultValue14362.version,
    recordId: input.recordId,
  });
  let $migratedResultValue15274!: import("better-result").InferOk<NonNullable<typeof migrated>>;
  let $migratedResultError15274!: import("better-result").InferErr<NonNullable<typeof migrated>>;
  const $migratedResultOk15274 = migrated.match({
    ok: (value) => {
      $migratedResultValue15274 = value;
      return true;
    },
    err: (error) => {
      $migratedResultError15274 = error;
      return false;
    },
  });
  if (($migratedResultOk15274 ? "ok" : "error") === "error")
    return Result.err($migratedResultError15274);
  return Result.ok({
    value: $migratedResultValue15274,
    provenance: $versionResultValue14362.provenance,
  });
}

export function decodeMiniLilacMigrationUserUiMessage(input: {
  readonly raw: string;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<MiniLilacUserUIMessage>, PersistedDataError> {
  const version = decodeVersion(input.schemaVersion, "history_user_message", input.recordId);
  let $versionResultValue15809!: import("better-result").InferOk<NonNullable<typeof version>>;
  let $versionResultError15809!: import("better-result").InferErr<NonNullable<typeof version>>;
  const $versionResultOk15809 = version.match({
    ok: (value) => {
      $versionResultValue15809 = value;
      return true;
    },
    err: (error) => {
      $versionResultError15809 = error;
      return false;
    },
  });
  if (($versionResultOk15809 ? "ok" : "error") === "error")
    return Result.err($versionResultError15809);
  const value = decodeSuperJson(input.raw, { ...input, field: "history_user_message" });
  let $valueResultValue15971!: import("better-result").InferOk<NonNullable<typeof value>>;
  let $valueResultError15971!: import("better-result").InferErr<NonNullable<typeof value>>;
  const $valueResultOk15971 = value.match({
    ok: (value) => {
      $valueResultValue15971 = value;
      return true;
    },
    err: (error) => {
      $valueResultError15971 = error;
      return false;
    },
  });
  if (($valueResultOk15971 ? "ok" : "error") === "error") return Result.err($valueResultError15971);
  const migrated = migrateMiniLilacUiMessageValue({
    value: $valueResultValue15971,
    schemaVersion: $versionResultValue15809.version,
    recordId: input.recordId,
  });
  let $migratedResultValue16124!: import("better-result").InferOk<NonNullable<typeof migrated>>;
  let $migratedResultError16124!: import("better-result").InferErr<NonNullable<typeof migrated>>;
  const $migratedResultOk16124 = migrated.match({
    ok: (value) => {
      $migratedResultValue16124 = value;
      return true;
    },
    err: (error) => {
      $migratedResultError16124 = error;
      return false;
    },
  });
  if (($migratedResultOk16124 ? "ok" : "error") === "error")
    return Result.err($migratedResultError16124);
  const message = miniLilacUserUIMessageSchema.safeParse($migratedResultValue16124.message);
  if (!message.success) {
    return Result.err(
      corrupt({
        field: "history_user_message",
        version: $versionResultValue15809.version,
        issueCode: "invalid-transcript-messages",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: message.data, provenance: $versionResultValue15809.provenance });
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
  let $versionResultValue17023!: import("better-result").InferOk<NonNullable<typeof version>>;
  let $versionResultError17023!: import("better-result").InferErr<NonNullable<typeof version>>;
  const $versionResultOk17023 = version.match({
    ok: (value) => {
      $versionResultValue17023 = value;
      return true;
    },
    err: (error) => {
      $versionResultError17023 = error;
      return false;
    },
  });
  if (($versionResultOk17023 ? "ok" : "error") === "error")
    return Result.err($versionResultError17023);
  const value = decodeSuperJson(input.raw, { ...input, field: "model_transcript" });
  let $valueResultValue17181!: import("better-result").InferOk<NonNullable<typeof value>>;
  let $valueResultError17181!: import("better-result").InferErr<NonNullable<typeof value>>;
  const $valueResultOk17181 = value.match({
    ok: (value) => {
      $valueResultValue17181 = value;
      return true;
    },
    err: (error) => {
      $valueResultError17181 = error;
      return false;
    },
  });
  if (($valueResultOk17181 ? "ok" : "error") === "error") return Result.err($valueResultError17181);
  const messages = miniLilacPersistedModelMessagesSchema.safeParse($valueResultValue17181);
  if (!messages.success) {
    return Result.err(
      corrupt({
        field: "model_transcript",
        version: $versionResultValue17023.version,
        issueCode: "invalid-transcript-messages",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: messages.data, provenance: $versionResultValue17023.provenance });
}

export function decodeMiniLilacMigrationUiPrefix(input: {
  readonly raw: string;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<MigratedMiniLilacUiMessages>, PersistedDataError> {
  const version = decodeVersion(input.schemaVersion, "ui_transcript", input.recordId);
  let $versionResultValue17978!: import("better-result").InferOk<NonNullable<typeof version>>;
  let $versionResultError17978!: import("better-result").InferErr<NonNullable<typeof version>>;
  const $versionResultOk17978 = version.match({
    ok: (value) => {
      $versionResultValue17978 = value;
      return true;
    },
    err: (error) => {
      $versionResultError17978 = error;
      return false;
    },
  });
  if (($versionResultOk17978 ? "ok" : "error") === "error")
    return Result.err($versionResultError17978);
  const value = decodeSuperJson(input.raw, { ...input, field: "ui_transcript" });
  let $valueResultValue18133!: import("better-result").InferOk<NonNullable<typeof value>>;
  let $valueResultError18133!: import("better-result").InferErr<NonNullable<typeof value>>;
  const $valueResultOk18133 = value.match({
    ok: (value) => {
      $valueResultValue18133 = value;
      return true;
    },
    err: (error) => {
      $valueResultError18133 = error;
      return false;
    },
  });
  if (($valueResultOk18133 ? "ok" : "error") === "error") return Result.err($valueResultError18133);
  const values = z.array(superJsonValueSchema).safeParse($valueResultValue18133);
  if (!values.success) {
    return Result.err(
      corrupt({
        field: "ui_transcript",
        version: $versionResultValue17978.version,
        issueCode: "invalid-transcript-messages",
        recordId: input.recordId,
      }),
    );
  }
  const migrated = migrateMiniLilacUiMessageValues({
    values: values.data,
    schemaVersion: $versionResultValue17978.version,
    recordId: input.recordId,
  });
  let $migratedResultValue18591!: import("better-result").InferOk<NonNullable<typeof migrated>>;
  let $migratedResultError18591!: import("better-result").InferErr<NonNullable<typeof migrated>>;
  const $migratedResultOk18591 = migrated.match({
    ok: (value) => {
      $migratedResultValue18591 = value;
      return true;
    },
    err: (error) => {
      $migratedResultError18591 = error;
      return false;
    },
  });
  if (($migratedResultOk18591 ? "ok" : "error") === "error")
    return Result.err($migratedResultError18591);
  return Result.ok({
    value: $migratedResultValue18591,
    provenance: $versionResultValue17978.provenance,
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
  let $versionResultValue19206!: import("better-result").InferOk<NonNullable<typeof version>>;
  let $versionResultError19206!: import("better-result").InferErr<NonNullable<typeof version>>;
  const $versionResultOk19206 = version.match({
    ok: (value) => {
      $versionResultValue19206 = value;
      return true;
    },
    err: (error) => {
      $versionResultError19206 = error;
      return false;
    },
  });
  if (($versionResultOk19206 ? "ok" : "error") === "error")
    return Result.err($versionResultError19206);
  if (input.rawValues === null) {
    const empty = input.schema.safeParse([]);
    if (!empty.success) {
      return Result.err(
        corrupt({
          field: input.field,
          version: $versionResultValue19206.version,
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
      schemaVersion: $versionResultValue19206.version,
      recordId: input.recordId,
    });
    let $decodedResultValue19848!: import("better-result").InferOk<NonNullable<typeof decoded>>;
    let $decodedResultError19848!: import("better-result").InferErr<NonNullable<typeof decoded>>;
    const $decodedResultOk19848 = decoded.match({
      ok: (value) => {
        $decodedResultValue19848 = value;
        return true;
      },
      err: (error) => {
        $decodedResultError19848 = error;
        return false;
      },
    });
    if (($decodedResultOk19848 ? "ok" : "error") === "error")
      return Result.err($decodedResultError19848);
    values.push($decodedResultValue19848);
  }
  const transcript = input.schema.safeParse(values);
  if (!transcript.success) {
    return Result.err(
      corrupt({
        field: input.field,
        version: $versionResultValue19206.version,
        issueCode: "invalid-transcript-messages",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: transcript.data, provenance: $versionResultValue19206.provenance });
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
  let $versionResultValue20816!: import("better-result").InferOk<NonNullable<typeof version>>;
  let $versionResultError20816!: import("better-result").InferErr<NonNullable<typeof version>>;
  const $versionResultOk20816 = version.match({
    ok: (value) => {
      $versionResultValue20816 = value;
      return true;
    },
    err: (error) => {
      $versionResultError20816 = error;
      return false;
    },
  });
  if (($versionResultOk20816 ? "ok" : "error") === "error")
    return Result.err($versionResultError20816);
  const decodedRows = transcriptChainRowsSchema.safeParse(input.rows);
  if (!decodedRows.success) {
    return Result.err(
      corrupt({
        field,
        version: $versionResultValue20816.version,
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
          version: $versionResultValue20816.version,
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
        version: $versionResultValue20816.version,
        issueCode: "digest-mismatch",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: values, provenance: $versionResultValue20816.provenance });
}

export function decodeMiniLilacMigrationTranscriptRows(input: {
  readonly rows: unknown;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<MiniLilacMigrationTranscriptChainRow[]>, PersistedDataError> {
  const version = decodeVersion(input.schemaVersion, "model_transcript", input.recordId);
  let $versionResultValue22704!: import("better-result").InferOk<NonNullable<typeof version>>;
  let $versionResultError22704!: import("better-result").InferErr<NonNullable<typeof version>>;
  const $versionResultOk22704 = version.match({
    ok: (value) => {
      $versionResultValue22704 = value;
      return true;
    },
    err: (error) => {
      $versionResultError22704 = error;
      return false;
    },
  });
  if (($versionResultOk22704 ? "ok" : "error") === "error")
    return Result.err($versionResultError22704);
  const rows = migrationTranscriptChainRowsSchema.safeParse(input.rows);
  if (!rows.success) {
    return Result.err(
      corrupt({
        field: "model_transcript",
        version: $versionResultValue22704.version,
        issueCode: "invalid-row-field",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: rows.data, provenance: $versionResultValue22704.provenance });
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
  let $versionResultValue24161!: import("better-result").InferOk<NonNullable<typeof version>>;
  let $versionResultError24161!: import("better-result").InferErr<NonNullable<typeof version>>;
  const $versionResultOk24161 = version.match({
    ok: (value) => {
      $versionResultValue24161 = value;
      return true;
    },
    err: (error) => {
      $versionResultError24161 = error;
      return false;
    },
  });
  if (($versionResultOk24161 ? "ok" : "error") === "error")
    return Result.err($versionResultError24161);
  if (input.raw === null) return Result.ok({ value: null, provenance: "missing-defaulted" });
  const value = decodeSuperJson(input.raw, { ...input, field: "history_user_message" });
  let $valueResultValue24417!: import("better-result").InferOk<NonNullable<typeof value>>;
  let $valueResultError24417!: import("better-result").InferErr<NonNullable<typeof value>>;
  const $valueResultOk24417 = value.match({
    ok: (value) => {
      $valueResultValue24417 = value;
      return true;
    },
    err: (error) => {
      $valueResultError24417 = error;
      return false;
    },
  });
  if (($valueResultOk24417 ? "ok" : "error") === "error") return Result.err($valueResultError24417);
  const message = miniLilacPersistedUserUiMessageSchema.safeParse($valueResultValue24417);
  if (!message.success) {
    return Result.err(
      corrupt({
        field: "history_user_message",
        version: $versionResultValue24161.version,
        issueCode: "invalid-row-field",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: message.data, provenance: $versionResultValue24161.provenance });
}

export function decodeMiniLilacCommandRequest(
  input: MiniLilacCanonicalJsonCodecInput,
): ResultType<
  DecodedPersistedValue<Record<string, MiniLilacPersistedJsonValue> | null>,
  PersistedDataError
> {
  const version = decodeVersion(input.schemaVersion, "command_request", input.recordId);
  let $versionResultValue25182!: import("better-result").InferOk<NonNullable<typeof version>>;
  let $versionResultError25182!: import("better-result").InferErr<NonNullable<typeof version>>;
  const $versionResultOk25182 = version.match({
    ok: (value) => {
      $versionResultValue25182 = value;
      return true;
    },
    err: (error) => {
      $versionResultError25182 = error;
      return false;
    },
  });
  if (($versionResultOk25182 ? "ok" : "error") === "error")
    return Result.err($versionResultError25182);
  if (input.raw === null) return Result.ok({ value: null, provenance: "missing-defaulted" });
  const value = decodePlainJson(input.raw, { ...input, field: "command_request" });
  let $valueResultValue25433!: import("better-result").InferOk<NonNullable<typeof value>>;
  let $valueResultError25433!: import("better-result").InferErr<NonNullable<typeof value>>;
  const $valueResultOk25433 = value.match({
    ok: (value) => {
      $valueResultValue25433 = value;
      return true;
    },
    err: (error) => {
      $valueResultError25433 = error;
      return false;
    },
  });
  if (($valueResultOk25433 ? "ok" : "error") === "error") return Result.err($valueResultError25433);
  if (
    isRecord($valueResultValue25433) &&
    "json" in $valueResultValue25433 &&
    Object.keys($valueResultValue25433).every((key) => key === "json" || key === "meta")
  ) {
    return Result.err(
      corrupt({
        field: "command_request",
        version: $versionResultValue25182.version,
        issueCode: "invalid-row-field",
        recordId: input.recordId,
      }),
    );
  }
  const request = commandRequestSchema.safeParse($valueResultValue25433);
  if (!request.success) {
    return Result.err(
      corrupt({
        field: "command_request",
        version: $versionResultValue25182.version,
        issueCode: "invalid-row-field",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: request.data, provenance: $versionResultValue25182.provenance });
}

export function decodeMiniLilacSteeringCommandRequest(
  input: MiniLilacCanonicalJsonCodecInput,
): ResultType<DecodedPersistedValue<DecodedMiniLilacSteeringCommandPayload>, PersistedDataError> {
  const request = decodeMiniLilacCommandRequest(input);
  let $requestResultValue26518!: import("better-result").InferOk<NonNullable<typeof request>>;
  let $requestResultError26518!: import("better-result").InferErr<NonNullable<typeof request>>;
  const $requestResultOk26518 = request.match({
    ok: (value) => {
      $requestResultValue26518 = value;
      return true;
    },
    err: (error) => {
      $requestResultError26518 = error;
      return false;
    },
  });
  if (($requestResultOk26518 ? "ok" : "error") === "error")
    return Result.err($requestResultError26518);
  const decoded = steeringCommandPayloadSchema.safeParse($requestResultValue26518.value);
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
  return Result.ok({ value: decoded.data, provenance: $requestResultValue26518.provenance });
}

export function decodeMiniLilacSuperJsonPayload(
  input: MiniLilacSuperJsonCodecInput,
): ResultType<DecodedPersistedValue<MiniLilacPersistedSuperJsonValue>, PersistedDataError> {
  const version = decodeVersion(input.schemaVersion, input.field, input.recordId);
  let $versionResultValue27220!: import("better-result").InferOk<NonNullable<typeof version>>;
  let $versionResultError27220!: import("better-result").InferErr<NonNullable<typeof version>>;
  const $versionResultOk27220 = version.match({
    ok: (value) => {
      $versionResultValue27220 = value;
      return true;
    },
    err: (error) => {
      $versionResultError27220 = error;
      return false;
    },
  });
  if (($versionResultOk27220 ? "ok" : "error") === "error")
    return Result.err($versionResultError27220);
  if (input.raw === null) return Result.ok({ value: null, provenance: "missing-defaulted" });
  const value = decodeSuperJson(input.raw, input);
  let $valueResultValue27465!: import("better-result").InferOk<NonNullable<typeof value>>;
  let $valueResultError27465!: import("better-result").InferErr<NonNullable<typeof value>>;
  const $valueResultOk27465 = value.match({
    ok: (value) => {
      $valueResultValue27465 = value;
      return true;
    },
    err: (error) => {
      $valueResultError27465 = error;
      return false;
    },
  });
  if (($valueResultOk27465 ? "ok" : "error") === "error") return Result.err($valueResultError27465);
  const decoded = superJsonValueSchema.safeParse($valueResultValue27465);
  if (!decoded.success) {
    return Result.err(
      corrupt({
        field: input.field,
        version: $versionResultValue27220.version,
        issueCode: "invalid-row-field",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: decoded.data, provenance: $versionResultValue27220.provenance });
}

export function decodeMiniMainClaudeBindingPromotion(
  input: MiniLilacSuperJsonCodecInput,
): ResultType<DecodedPersistedValue<DecodedMiniMainClaudeBindingPromotion>, PersistedDataError> {
  const payload = decodeMiniLilacSuperJsonPayload(input);
  let $payloadResultValue28148!: import("better-result").InferOk<NonNullable<typeof payload>>;
  let $payloadResultError28148!: import("better-result").InferErr<NonNullable<typeof payload>>;
  const $payloadResultOk28148 = payload.match({
    ok: (value) => {
      $payloadResultValue28148 = value;
      return true;
    },
    err: (error) => {
      $payloadResultError28148 = error;
      return false;
    },
  });
  if (($payloadResultOk28148 ? "ok" : "error") === "error")
    return Result.err($payloadResultError28148);
  const decoded = promoteMiniMainClaudeSessionBindingSchema.safeParse(
    $payloadResultValue28148.value,
  );
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
  return Result.ok({ value: decoded.data, provenance: $payloadResultValue28148.provenance });
}

export function decodeMiniNamedClaudeBindingPromotion(
  input: MiniLilacSuperJsonCodecInput,
): ResultType<DecodedPersistedValue<DecodedMiniNamedClaudeBindingPromotion>, PersistedDataError> {
  const payload = decodeMiniLilacSuperJsonPayload(input);
  let $payloadResultValue28871!: import("better-result").InferOk<NonNullable<typeof payload>>;
  let $payloadResultError28871!: import("better-result").InferErr<NonNullable<typeof payload>>;
  const $payloadResultOk28871 = payload.match({
    ok: (value) => {
      $payloadResultValue28871 = value;
      return true;
    },
    err: (error) => {
      $payloadResultError28871 = error;
      return false;
    },
  });
  if (($payloadResultOk28871 ? "ok" : "error") === "error")
    return Result.err($payloadResultError28871);
  const decoded = promoteMiniNamedClaudeSessionBindingSchema.safeParse(
    $payloadResultValue28871.value,
  );
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
  return Result.ok({ value: decoded.data, provenance: $payloadResultValue28871.provenance });
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
