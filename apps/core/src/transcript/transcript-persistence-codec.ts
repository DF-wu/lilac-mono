import SuperJSON from "superjson";
import { createHash } from "node:crypto";
import {
  modelMessageSchema,
  type FilePart,
  type SystemModelMessage,
  type TextPart,
  type ToolApprovalRequest,
  type ToolModelMessage,
  type ToolResultPart,
  type UserModelMessage,
} from "ai";
import {
  hashCanonicalMessagesV1,
  historyProviderStateSchema,
  type HistoryProviderState,
} from "@stanley2058/lilac-agent";
import {
  coreLineageManifestV1Schema,
  computeCoreLineagePrefixDigestV1,
  decodeCorePrimaryLineageV1,
  type AdapterPlatform,
  type CoreLineageAtomV1,
  type CoreRequestAliasV1,
} from "@stanley2058/lilac-event-bus";
import {
  CorruptPersistedFields,
  MalformedSerialization,
  UnsupportedVersion,
  isRecord,
  normalizeReplayMessages,
  type DecodedPersistedValue,
  type PersistedDataError,
  type PersistedDataIssueCode,
  type PersistenceProvenance,
} from "@stanley2058/lilac-utils";
import { Panic, Result, type Result as ResultType } from "better-result";
import { z } from "zod";

import { adaptToolResultToHost } from "../tools/tool-result-adapters";

export const TRANSCRIPT_PERSISTENCE_SCHEMA_VERSION = 5 as const;
export const COMPACTION_CHECKPOINT_FORMAT_VERSION = 1 as const;
export const CORE_SURFACE_PROJECTION_FORMAT_VERSION = 1 as const;
export const CORE_TRANSCRIPT_DIGEST_VERSION = 1 as const;

const TRANSCRIPT_TABLE = "request_transcripts";
const PROJECTION_TABLE = "core_surface_projections";
const LINEAGE_TABLE = "core_primary_lineage_manifests";

const adapterPlatformSchema = z.enum([
  "discord",
  "github",
  "whatsapp",
  "slack",
  "telegram",
  "web",
  "unknown",
]);
const modelMessagesSchema = z.array(modelMessageSchema);
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const compactionCheckpointMetaSchema = z.strictObject({
  type: z.literal("compaction"),
  formatVersion: z.literal(COMPACTION_CHECKPOINT_FORMAT_VERSION),
});
const uuidSchema = z.uuid();
const positiveIntegerSchema = z.number().int().positive();
const nonNegativeFiniteSchema = z.number().finite().nonnegative();
const nullablePositiveIntegerSchema = positiveIntegerSchema.nullable();
const nullableNonNegativeIntegerSchema = nonNegativeIntegerSchema.nullable();
const nullableNonNegativeFiniteSchema = nonNegativeFiniteSchema.nullable();
const nullableUuidSchema = uuidSchema.nullable();
const coreClaudeAttemptStateSchema = z.enum([
  "active",
  "succeeded",
  "failed",
  "cancelled",
  "uncertain",
]);

export type CompactionCheckpointMeta = z.output<typeof compactionCheckpointMetaSchema>;

interface CoreProjectionSourceFactObject extends Record<string, CoreProjectionSourceFact> {}

export type CoreProjectionSourceFact =
  | null
  | boolean
  | number
  | string
  | CoreProjectionSourceFact[]
  | CoreProjectionSourceFactObject;

interface DecodedProviderObject extends Record<string, DecodedProviderValue | undefined> {}
type DecodedProviderValue =
  | null
  | boolean
  | number
  | string
  | DecodedProviderValue[]
  | DecodedProviderObject;
type DecodedProviderOptions = Record<string, DecodedProviderObject>;

type DecodedToolCallPart = {
  readonly type: "tool-call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: CoreProjectionSourceFact;
  readonly providerOptions?: DecodedProviderOptions;
  readonly providerExecuted?: boolean;
};
type DecodedCustomPart = {
  readonly type: "custom";
  readonly kind: `${string}.${string}`;
  readonly providerOptions?: DecodedProviderOptions;
};
type DecodedReasoningPart = {
  readonly type: "reasoning";
  readonly text: string;
  readonly providerOptions?: DecodedProviderOptions;
};
type DecodedReasoningFilePart = {
  readonly type: "reasoning-file";
  readonly data:
    | string
    | Uint8Array
    | ArrayBuffer
    | URL
    | { readonly type: "data"; readonly data: string | Uint8Array | ArrayBuffer }
    | { readonly type: "url"; readonly url: URL };
  readonly mediaType: string;
  readonly providerOptions?: DecodedProviderOptions;
};
type DecodedAssistantContentPart =
  | TextPart
  | DecodedCustomPart
  | FilePart
  | DecodedReasoningPart
  | DecodedReasoningFilePart
  | DecodedToolCallPart
  | ToolResultPart
  | ToolApprovalRequest;
type DecodedAssistantModelMessage = {
  readonly role: "assistant";
  readonly content: string | DecodedAssistantContentPart[];
  readonly providerOptions?: DecodedProviderOptions;
};
export type DecodedModelMessage =
  | SystemModelMessage
  | UserModelMessage
  | ToolModelMessage
  | DecodedAssistantModelMessage;

const coreProjectionSourceFactSchema: z.ZodType<CoreProjectionSourceFact> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(coreProjectionSourceFactSchema),
    z.record(z.string(), coreProjectionSourceFactSchema),
  ]),
);
const coreProjectionSourceFactsSchema = z.record(z.string(), coreProjectionSourceFactSchema);

export type PersistedTranscriptRow = {
  readonly request_id: string;
  readonly session_id: string;
  readonly request_client: string;
  readonly created_ts: number;
  readonly updated_ts: number;
  readonly model_label: string | null;
  readonly final_text: string | null;
  readonly messages_json: string;
  readonly context_meta_json: string | null;
  readonly provider_state_json: string | null;
  readonly stable_named_request_client: string | null;
  readonly transcript_digest: string | null;
};

export type DecodedTranscriptRow = {
  readonly requestId: string;
  readonly sessionId: string;
  readonly requestClient: AdapterPlatform;
  readonly createdTs: number;
  readonly updatedTs: number;
  readonly messages: DecodedModelMessage[];
  readonly finalText?: string;
  readonly modelLabel?: string;
  readonly contextMeta?: CompactionCheckpointMeta;
  readonly providerState: HistoryProviderState | null;
  readonly stableNamedRequestClient?: AdapterPlatform;
  readonly canonicalHashVersion: typeof CORE_TRANSCRIPT_DIGEST_VERSION;
  readonly transcriptDigest: string;
};

export type PersistedCoreSurfaceProjectionRow = {
  readonly request_client: string;
  readonly surface_id: string;
  readonly session_id: string;
  readonly message_id: string;
  readonly projection_format_version: number;
  readonly canonical_messages_json: string;
  readonly source_facts_json: string;
  readonly created_ts: number;
};

export type DecodedCoreSurfaceProjectionRow = {
  readonly requestClient: AdapterPlatform;
  readonly surfaceId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly projectionFormatVersion: typeof CORE_SURFACE_PROJECTION_FORMAT_VERSION;
  readonly canonicalMessages: DecodedModelMessage[];
  readonly sourceFacts: Record<string, CoreProjectionSourceFact>;
  readonly createdAt: number;
};

export type DecodedCoreOwnedBlobRow = {
  readonly sha256: string;
  readonly mediaType: string;
  readonly filename: string;
  readonly byteLength: number;
  readonly bytes: Uint8Array;
  readonly createdAt: number;
};

export type DecodedCoreNamedClaudeBindingRow = {
  readonly bindingProtocolVersion: 1;
  readonly providerId: string;
  readonly providerFamily: "claude-code";
  readonly requestClient: AdapterPlatform;
  readonly lilacSessionId: string;
  readonly terminalRequestId: string;
  readonly canonicalHashVersion: 1;
  readonly canonicalHeadHash: string;
  readonly canonicalMessageCount: number;
  readonly executionScopeHashVersion: 1;
  readonly executionScopeHash: string;
  readonly claudeSessionId: string;
  readonly nativeCwd: string;
  readonly nativeLastModified: number;
  readonly nativeContextTokens: number;
  readonly nativeContextMaxTokens: number;
  readonly lastModelSpecifier: string;
  readonly lastReasoning: string;
  readonly revision: number;
  readonly updatedAt: number;
};

export type DecodedCoreNamedClaudeAttemptRow = {
  readonly product: "core-named";
  readonly providerId: string;
  readonly requestClient: AdapterPlatform;
  readonly lilacSessionId: string;
  readonly sourceTerminalRequestId: string | null;
  readonly sourceCanonicalHeadHash: string | null;
  readonly sourceCanonicalMessageCount: number | null;
  readonly executionScopeHashVersion: 1;
  readonly executionScopeHash: string;
  readonly requestId: string;
  readonly attemptIndex: number;
  readonly candidateSessionId: string;
  readonly sourceSessionId: string | null;
  readonly expectedBindingRevision: number | null;
  readonly state: z.output<typeof coreClaudeAttemptStateSchema>;
  readonly terminalRequestId: string | null;
  readonly terminalCanonicalHeadHash: string | null;
  readonly terminalCanonicalMessageCount: number | null;
  readonly nativeCwd: string | null;
  readonly nativeLastModified: number | null;
  readonly nativeContextTokens: number | null;
  readonly nativeContextMaxTokens: number | null;
  readonly lastModelSpecifier: string | null;
  readonly lastReasoning: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type DecodedCorePrimaryClaudeBindingRow = {
  readonly bindingProtocolVersion: 1;
  readonly providerId: string;
  readonly providerFamily: "claude-code";
  readonly requestClient: "discord";
  readonly lilacSessionId: string;
  readonly terminalRequestId: string;
  readonly lineageVersion: 1;
  readonly atomCount: number;
  readonly prefixDigest: string;
  readonly canonicalMessageCount: number;
  readonly executionScopeHashVersion: 1;
  readonly executionScopeHash: string;
  readonly claudeSessionId: string;
  readonly nativeCwd: string;
  readonly nativeLastModified: number;
  readonly nativeContextTokens: number;
  readonly nativeContextMaxTokens: number;
  readonly lastModelSpecifier: string;
  readonly lastReasoning: string;
  readonly revision: number;
  readonly updatedAt: number;
};

export type DecodedCorePrimaryClaudeAttemptRow = {
  readonly product: "core-primary";
  readonly providerId: string;
  readonly requestClient: "discord";
  readonly lilacSessionId: string;
  readonly sourceLineageVersion: 1 | null;
  readonly sourceAtomCount: number | null;
  readonly sourcePrefixDigest: string | null;
  readonly sourceCanonicalMessageCount: number | null;
  readonly executionScopeHashVersion: 1;
  readonly executionScopeHash: string;
  readonly requestId: string;
  readonly attemptIndex: number;
  readonly candidateSessionId: string;
  readonly sourceSessionId: string | null;
  readonly expectedBindingRevision: number | null;
  readonly state: z.output<typeof coreClaudeAttemptStateSchema>;
  readonly terminalRequestId: string | null;
  readonly terminalLineageVersion: 1 | null;
  readonly terminalAtomCount: number | null;
  readonly terminalPrefixDigest: string | null;
  readonly terminalCanonicalMessageCount: number | null;
  readonly nativeCwd: string | null;
  readonly nativeLastModified: number | null;
  readonly nativeContextTokens: number | null;
  readonly nativeContextMaxTokens: number | null;
  readonly lastModelSpecifier: string | null;
  readonly lastReasoning: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type DecodedTranscriptMigrationVersionRow = { readonly version: number };
export type DecodedTranscriptForeignKeyFailureRow = {
  readonly table: string;
  readonly rowid: number | null;
  readonly parent: string;
  readonly fkid: number;
};
export type DecodedTranscriptCountRow = { readonly count: number };
export type DecodedTranscriptBlobMetricsRow = {
  readonly ownedBytes: number;
  readonly unreferencedCount: number;
  readonly unreferencedBytes: number;
};

export type TranscriptStorePersistedRowKind =
  | "migration-version"
  | "foreign-key-failure"
  | "count"
  | "blob-metrics"
  | "owned-blob"
  | "named-binding"
  | "named-attempt"
  | "primary-binding"
  | "primary-attempt";

export type PersistedCoreLineageManifestRow = {
  readonly request_id: string;
  readonly lineage_version: number;
  readonly manifest_json: string;
};

type DecodedCoreLineageSegmentV1 = {
  readonly atoms: CoreLineageAtomV1[];
  readonly canonicalMessages: DecodedModelMessage[];
  readonly requestSource?: {
    readonly aliases: CoreRequestAliasV1[];
  };
  readonly canonicalStart: number;
  readonly canonicalEnd: number;
  readonly cumulativeAtomCount: number;
  readonly cumulativePrefixDigest: string;
};

export type DecodedCoreLineageManifestV1 = {
  readonly state: "complete";
  readonly lineageVersion: 1;
  readonly currentCanonicalStart: number;
  readonly segments: DecodedCoreLineageSegmentV1[];
};

type DecodedSchemaVersion = {
  readonly version: 1 | 2 | 3 | 4 | 5;
  readonly provenance: "current" | "migrated";
};

const transcriptMigrationVersionRowSchema = z.strictObject({
  version: nonNegativeIntegerSchema,
});
const transcriptForeignKeyFailureRowSchema = z.strictObject({
  table: z.string(),
  rowid: z.number().int().nullable(),
  parent: z.string(),
  fkid: z.number().int(),
});
const transcriptCountRowSchema = z.strictObject({ count: nonNegativeIntegerSchema });
const transcriptBlobMetricsRowSchema = z.strictObject({
  owned_bytes: nonNegativeIntegerSchema,
  unreferenced_count: nonNegativeIntegerSchema,
  unreferenced_bytes: nonNegativeIntegerSchema,
});
const coreOwnedBlobRowSchema = z.strictObject({
  sha256: sha256HexSchema,
  media_type: z.string().min(1),
  filename: z.string().min(1),
  byte_length: nonNegativeIntegerSchema,
  bytes: z.instanceof(Uint8Array),
  created_ts: nonNegativeIntegerSchema,
});
const coreNamedClaudeBindingRowSchema = z.strictObject({
  request_client: adapterPlatformSchema,
  session_id: z.string().min(1),
  provider_id: z.string().min(1),
  binding_protocol_version: z.literal(1),
  provider_family: z.literal("claude-code"),
  terminal_request_id: z.string().min(1),
  canonical_hash_version: z.literal(1),
  canonical_head_hash: sha256HexSchema,
  canonical_message_count: nonNegativeIntegerSchema,
  execution_scope_hash_version: z.literal(1),
  execution_scope_hash: z.string().min(1),
  claude_session_id: uuidSchema,
  native_cwd: z.string(),
  native_last_modified: nonNegativeFiniteSchema,
  native_context_tokens: nonNegativeIntegerSchema,
  native_context_max_tokens: positiveIntegerSchema,
  last_model_specifier: z.string(),
  last_reasoning: z.string(),
  revision: positiveIntegerSchema,
  updated_ts: nonNegativeIntegerSchema,
});
const coreNamedClaudeAttemptRowSchema = z.strictObject({
  product: z.literal("core-named"),
  request_client: adapterPlatformSchema,
  session_id: z.string().min(1),
  provider_id: z.string().min(1),
  source_terminal_request_id: z.string().min(1).nullable(),
  source_canonical_head_hash: sha256HexSchema.nullable(),
  source_canonical_message_count: nullableNonNegativeIntegerSchema,
  execution_scope_hash_version: z.literal(1),
  execution_scope_hash: z.string().min(1),
  request_id: z.string().min(1),
  attempt_index: nonNegativeIntegerSchema,
  candidate_session_id: uuidSchema,
  source_session_id: nullableUuidSchema,
  expected_binding_revision: nullablePositiveIntegerSchema,
  state: coreClaudeAttemptStateSchema,
  terminal_request_id: z.string().min(1).nullable(),
  terminal_canonical_head_hash: sha256HexSchema.nullable(),
  terminal_canonical_message_count: nullableNonNegativeIntegerSchema,
  native_cwd: z.string().nullable(),
  native_last_modified: nullableNonNegativeFiniteSchema,
  native_context_tokens: nullableNonNegativeIntegerSchema,
  native_context_max_tokens: nullablePositiveIntegerSchema,
  last_model_specifier: z.string().nullable(),
  last_reasoning: z.string().nullable(),
  created_ts: nonNegativeIntegerSchema,
  updated_ts: nonNegativeIntegerSchema,
});
const corePrimaryClaudeBindingRowSchema = z.strictObject({
  request_client: z.literal("discord"),
  session_id: z.string().min(1),
  provider_id: z.string().min(1),
  binding_protocol_version: z.literal(1),
  provider_family: z.literal("claude-code"),
  terminal_request_id: z.string().min(1),
  lineage_version: z.literal(1),
  atom_count: positiveIntegerSchema,
  prefix_digest: sha256HexSchema,
  canonical_message_count: positiveIntegerSchema,
  execution_scope_hash_version: z.literal(1),
  execution_scope_hash: z.string().min(1),
  claude_session_id: uuidSchema,
  native_cwd: z.string(),
  native_last_modified: nonNegativeFiniteSchema,
  native_context_tokens: nonNegativeIntegerSchema,
  native_context_max_tokens: positiveIntegerSchema,
  last_model_specifier: z.string(),
  last_reasoning: z.string(),
  revision: positiveIntegerSchema,
  updated_ts: nonNegativeIntegerSchema,
});
const corePrimaryClaudeAttemptRowSchema = z.strictObject({
  product: z.literal("core-primary"),
  request_client: z.literal("discord"),
  session_id: z.string().min(1),
  provider_id: z.string().min(1),
  source_lineage_version: z.literal(1).nullable(),
  source_atom_count: nullablePositiveIntegerSchema,
  source_prefix_digest: sha256HexSchema.nullable(),
  source_canonical_message_count: nullablePositiveIntegerSchema,
  execution_scope_hash_version: z.literal(1),
  execution_scope_hash: z.string().min(1),
  request_id: z.string().min(1),
  attempt_index: nonNegativeIntegerSchema,
  candidate_session_id: uuidSchema,
  source_session_id: nullableUuidSchema,
  expected_binding_revision: nullablePositiveIntegerSchema,
  state: coreClaudeAttemptStateSchema,
  terminal_request_id: z.string().min(1).nullable(),
  terminal_lineage_version: z.literal(1).nullable(),
  terminal_atom_count: nullablePositiveIntegerSchema,
  terminal_prefix_digest: sha256HexSchema.nullable(),
  terminal_canonical_message_count: nullablePositiveIntegerSchema,
  native_cwd: z.string().nullable(),
  native_last_modified: nullableNonNegativeFiniteSchema,
  native_context_tokens: nullableNonNegativeIntegerSchema,
  native_context_max_tokens: nullablePositiveIntegerSchema,
  last_model_specifier: z.string().nullable(),
  last_reasoning: z.string().nullable(),
  created_ts: nonNegativeIntegerSchema,
  updated_ts: nonNegativeIntegerSchema,
});

type DecodedTranscriptStoreRow =
  | DecodedTranscriptMigrationVersionRow
  | DecodedTranscriptForeignKeyFailureRow
  | DecodedTranscriptCountRow
  | DecodedTranscriptBlobMetricsRow
  | DecodedCoreOwnedBlobRow
  | DecodedCoreNamedClaudeBindingRow
  | DecodedCoreNamedClaudeAttemptRow
  | DecodedCorePrimaryClaudeBindingRow
  | DecodedCorePrimaryClaudeAttemptRow;

function context(input: {
  readonly table: string;
  readonly field: string;
  readonly version: number;
  readonly issueCode: PersistedDataIssueCode;
  readonly recordId: string;
}) {
  return {
    ...input,
    message: `Persisted transcript ${input.issueCode}`,
  };
}

function corrupt(input: {
  readonly table: string;
  readonly field: string;
  readonly version: number;
  readonly issueCode: PersistedDataIssueCode;
  readonly recordId: string;
}): CorruptPersistedFields {
  return new CorruptPersistedFields(context(input));
}

function decodeSchemaVersion(
  version: number,
  table: string,
  recordId: string,
): ResultType<DecodedSchemaVersion, UnsupportedVersion | CorruptPersistedFields> {
  if (!Number.isInteger(version) || version < 1) {
    return Result.err(
      corrupt({
        table,
        field: "schema_version",
        version,
        issueCode: "invalid-row-version",
        recordId,
      }),
    );
  }
  if (version > TRANSCRIPT_PERSISTENCE_SCHEMA_VERSION) {
    return Result.err(
      new UnsupportedVersion(
        context({
          table,
          field: "schema_version",
          version,
          issueCode: "unsupported-version",
          recordId,
        }),
      ),
    );
  }
  switch (version) {
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
      return Result.ok({
        version,
        provenance: version === TRANSCRIPT_PERSISTENCE_SCHEMA_VERSION ? "current" : "migrated",
      });
  }
  return Result.err(
    corrupt({
      table,
      field: "schema_version",
      version,
      issueCode: "invalid-row-version",
      recordId,
    }),
  );
}

function decodeSerialized(input: {
  readonly raw: string;
  readonly table: string;
  readonly field: string;
  readonly version: number;
  readonly recordId: string;
}): ResultType<unknown, MalformedSerialization> {
  const decoded = Result.try({
    try: () => {
      const json: unknown = globalThis.JSON.parse(input.raw);
      const isSuperJsonEnvelope =
        isRecord(json) &&
        "json" in json &&
        Object.keys(json).every((key) => key === "json" || key === "meta");
      return isSuperJsonEnvelope ? SuperJSON.parse<unknown>(input.raw) : json;
    },
    catch: (cause) => cause,
  });
  if (decoded.status === "ok") return Result.ok(decoded.value);
  if (Panic.is(decoded.error)) return adaptToolResultToHost(Result.err(decoded.error));
  return Result.err(
    new MalformedSerialization(
      context({
        table: input.table,
        field: input.field,
        version: input.version,
        issueCode: "malformed-json",
        recordId: input.recordId,
      }),
    ),
  );
}

function decodeNormalizedMessagesValue(
  value: unknown,
  input: {
    readonly table: string;
    readonly field: string;
    readonly version: number;
    readonly recordId: string;
  },
): ResultType<DecodedModelMessage[], CorruptPersistedFields> {
  const messages = modelMessagesSchema.safeParse(value);
  if (!messages.success) {
    return Result.err(corrupt({ ...input, issueCode: "invalid-transcript-messages" }));
  }
  const normalized = modelMessagesSchema.safeParse(normalizeReplayMessages(messages.data));
  if (!normalized.success) {
    return Result.err(corrupt({ ...input, issueCode: "invalid-transcript-messages" }));
  }
  const decodedMessages: DecodedModelMessage[] = [];
  for (const message of normalized.data) {
    if (message.role !== "assistant") {
      decodedMessages.push(message);
      continue;
    }
    if (typeof message.content === "string") {
      decodedMessages.push({
        role: "assistant",
        content: message.content,
        ...(message.providerOptions === undefined
          ? {}
          : { providerOptions: message.providerOptions }),
      });
      continue;
    }
    const content: DecodedAssistantContentPart[] = [];
    for (const part of message.content) {
      if (part.type !== "tool-call") {
        content.push(part);
        continue;
      }
      const toolInput = coreProjectionSourceFactSchema.safeParse(part.input);
      if (!toolInput.success) {
        return Result.err(corrupt({ ...input, issueCode: "invalid-transcript-messages" }));
      }
      content.push({ ...part, input: toolInput.data });
    }
    decodedMessages.push({ ...message, content });
  }
  return Result.ok(decodedMessages);
}

export function decodeTranscriptMessages(input: {
  readonly raw: string;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<DecodedModelMessage[]>, PersistedDataError> {
  const version = decodeSchemaVersion(input.schemaVersion, TRANSCRIPT_TABLE, input.recordId);
  if (version.status === "error") return Result.err(version.error);
  if (typeof input.raw !== "string") {
    return Result.err(
      corrupt({
        table: TRANSCRIPT_TABLE,
        field: "messages_json",
        version: version.value.version,
        issueCode: "missing-required-field",
        recordId: input.recordId,
      }),
    );
  }
  const serialized = decodeSerialized({
    raw: input.raw,
    table: TRANSCRIPT_TABLE,
    field: "messages_json",
    version: version.value.version,
    recordId: input.recordId,
  });
  if (serialized.status === "error") return Result.err(serialized.error);
  const messages = decodeNormalizedMessagesValue(serialized.value, {
    table: TRANSCRIPT_TABLE,
    field: "messages_json",
    version: version.value.version,
    recordId: input.recordId,
  });
  if (messages.status === "error") return Result.err(messages.error);
  return Result.ok({ value: messages.value, provenance: version.value.provenance });
}

export function decodeTranscriptCompactionContext(input: {
  readonly raw: string | null;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<CompactionCheckpointMeta | undefined>, PersistedDataError> {
  const version = decodeSchemaVersion(input.schemaVersion, TRANSCRIPT_TABLE, input.recordId);
  if (version.status === "error") return Result.err(version.error);
  if (input.raw === null) return Result.ok({ value: undefined, provenance: "missing-defaulted" });
  const serialized = decodeSerialized({
    raw: input.raw,
    table: TRANSCRIPT_TABLE,
    field: "context_meta_json",
    version: version.value.version,
    recordId: input.recordId,
  });
  if (serialized.status === "error") return Result.err(serialized.error);
  const decoded = compactionCheckpointMetaSchema.safeParse(serialized.value);
  if (!decoded.success) {
    return Result.err(
      corrupt({
        table: TRANSCRIPT_TABLE,
        field: "context_meta_json",
        version: version.value.version,
        issueCode: "invalid-compaction-context",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: decoded.data, provenance: version.value.provenance });
}

export function decodeTranscriptProviderState(input: {
  readonly raw: string | null;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<HistoryProviderState | null>, PersistedDataError> {
  const version = decodeSchemaVersion(input.schemaVersion, TRANSCRIPT_TABLE, input.recordId);
  if (version.status === "error") return Result.err(version.error);
  if (input.raw === null) return Result.ok({ value: null, provenance: "missing-defaulted" });
  const serialized = decodeSerialized({
    raw: input.raw,
    table: TRANSCRIPT_TABLE,
    field: "provider_state_json",
    version: version.value.version,
    recordId: input.recordId,
  });
  if (serialized.status === "error") return Result.err(serialized.error);
  const decoded = historyProviderStateSchema.safeParse(serialized.value);
  if (!decoded.success) {
    return Result.err(
      corrupt({
        table: TRANSCRIPT_TABLE,
        field: "provider_state_json",
        version: version.value.version,
        issueCode: "invalid-provider-state",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: decoded.data, provenance: version.value.provenance });
}

function aggregateProvenance(
  version: DecodedSchemaVersion,
  values: readonly DecodedPersistedValue<unknown>[],
): PersistenceProvenance {
  if (version.provenance === "migrated") return "migrated";
  return values.some((value) => value.provenance === "missing-defaulted")
    ? "missing-defaulted"
    : "current";
}

export function decodeTranscriptRow(input: {
  readonly storeKind: "migration-version";
  readonly row: unknown;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<DecodedTranscriptMigrationVersionRow>, PersistedDataError>;
export function decodeTranscriptRow(input: {
  readonly storeKind: "foreign-key-failure";
  readonly row: unknown;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<DecodedTranscriptForeignKeyFailureRow>, PersistedDataError>;
export function decodeTranscriptRow(input: {
  readonly storeKind: "count";
  readonly row: unknown;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<DecodedTranscriptCountRow>, PersistedDataError>;
export function decodeTranscriptRow(input: {
  readonly storeKind: "blob-metrics";
  readonly row: unknown;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<DecodedTranscriptBlobMetricsRow>, PersistedDataError>;
export function decodeTranscriptRow(input: {
  readonly storeKind: "owned-blob";
  readonly row: unknown;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<DecodedCoreOwnedBlobRow>, PersistedDataError>;
export function decodeTranscriptRow(input: {
  readonly storeKind: "named-binding";
  readonly row: unknown;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<DecodedCoreNamedClaudeBindingRow>, PersistedDataError>;
export function decodeTranscriptRow(input: {
  readonly storeKind: "named-attempt";
  readonly row: unknown;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<DecodedCoreNamedClaudeAttemptRow>, PersistedDataError>;
export function decodeTranscriptRow(input: {
  readonly storeKind: "primary-binding";
  readonly row: unknown;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<DecodedCorePrimaryClaudeBindingRow>, PersistedDataError>;
export function decodeTranscriptRow(input: {
  readonly storeKind: "primary-attempt";
  readonly row: unknown;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<DecodedCorePrimaryClaudeAttemptRow>, PersistedDataError>;
export function decodeTranscriptRow(input: {
  readonly row: PersistedTranscriptRow;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<DecodedTranscriptRow>, PersistedDataError>;
export function decodeTranscriptRow(
  input:
    | { readonly row: PersistedTranscriptRow; readonly schemaVersion: number }
    | {
        readonly storeKind: TranscriptStorePersistedRowKind;
        readonly row: unknown;
        readonly schemaVersion: number;
        readonly recordId: string;
      },
): ResultType<
  DecodedPersistedValue<DecodedTranscriptRow | DecodedTranscriptStoreRow>,
  PersistedDataError
> {
  if ("storeKind" in input) {
    const version = decodeSchemaVersion(input.schemaVersion, TRANSCRIPT_TABLE, input.recordId);
    if (version.status === "error") return Result.err(version.error);
    const invalidRow = () =>
      Result.err(
        corrupt({
          table: TRANSCRIPT_TABLE,
          field: input.storeKind,
          version: version.value.version,
          issueCode: "invalid-transcript-row",
          recordId: input.recordId,
        }),
      );
    switch (input.storeKind) {
      case "migration-version": {
        const decoded = transcriptMigrationVersionRowSchema.safeParse(input.row);
        return decoded.success
          ? Result.ok({ value: decoded.data, provenance: version.value.provenance })
          : invalidRow();
      }
      case "foreign-key-failure": {
        const decoded = transcriptForeignKeyFailureRowSchema.safeParse(input.row);
        return decoded.success
          ? Result.ok({ value: decoded.data, provenance: version.value.provenance })
          : invalidRow();
      }
      case "count": {
        const decoded = transcriptCountRowSchema.safeParse(input.row);
        return decoded.success
          ? Result.ok({ value: decoded.data, provenance: version.value.provenance })
          : invalidRow();
      }
      case "blob-metrics": {
        const decoded = transcriptBlobMetricsRowSchema.safeParse(input.row);
        return decoded.success
          ? Result.ok({
              value: {
                ownedBytes: decoded.data.owned_bytes,
                unreferencedCount: decoded.data.unreferenced_count,
                unreferencedBytes: decoded.data.unreferenced_bytes,
              },
              provenance: version.value.provenance,
            })
          : invalidRow();
      }
      case "owned-blob": {
        const decoded = coreOwnedBlobRowSchema.safeParse(input.row);
        if (!decoded.success) return invalidRow();
        if (decoded.data.bytes.byteLength !== decoded.data.byte_length) return invalidRow();
        const digest = createHash("sha256").update(decoded.data.bytes).digest("hex");
        if (digest !== decoded.data.sha256) return invalidRow();
        return Result.ok({
          value: {
            sha256: decoded.data.sha256,
            mediaType: decoded.data.media_type,
            filename: decoded.data.filename,
            byteLength: decoded.data.byte_length,
            bytes: new Uint8Array(decoded.data.bytes),
            createdAt: decoded.data.created_ts,
          },
          provenance: version.value.provenance,
        });
      }
      case "named-binding": {
        const decoded = coreNamedClaudeBindingRowSchema.safeParse(input.row);
        if (!decoded.success) return invalidRow();
        return Result.ok({
          value: {
            bindingProtocolVersion: decoded.data.binding_protocol_version,
            providerId: decoded.data.provider_id,
            providerFamily: decoded.data.provider_family,
            requestClient: decoded.data.request_client,
            lilacSessionId: decoded.data.session_id,
            terminalRequestId: decoded.data.terminal_request_id,
            canonicalHashVersion: decoded.data.canonical_hash_version,
            canonicalHeadHash: decoded.data.canonical_head_hash,
            canonicalMessageCount: decoded.data.canonical_message_count,
            executionScopeHashVersion: decoded.data.execution_scope_hash_version,
            executionScopeHash: decoded.data.execution_scope_hash,
            claudeSessionId: decoded.data.claude_session_id,
            nativeCwd: decoded.data.native_cwd,
            nativeLastModified: decoded.data.native_last_modified,
            nativeContextTokens: decoded.data.native_context_tokens,
            nativeContextMaxTokens: decoded.data.native_context_max_tokens,
            lastModelSpecifier: decoded.data.last_model_specifier,
            lastReasoning: decoded.data.last_reasoning,
            revision: decoded.data.revision,
            updatedAt: decoded.data.updated_ts,
          },
          provenance: version.value.provenance,
        });
      }
      case "named-attempt": {
        const decoded = coreNamedClaudeAttemptRowSchema.safeParse(input.row);
        if (!decoded.success) return invalidRow();
        return Result.ok({
          value: {
            product: decoded.data.product,
            providerId: decoded.data.provider_id,
            requestClient: decoded.data.request_client,
            lilacSessionId: decoded.data.session_id,
            sourceTerminalRequestId: decoded.data.source_terminal_request_id,
            sourceCanonicalHeadHash: decoded.data.source_canonical_head_hash,
            sourceCanonicalMessageCount: decoded.data.source_canonical_message_count,
            executionScopeHashVersion: decoded.data.execution_scope_hash_version,
            executionScopeHash: decoded.data.execution_scope_hash,
            requestId: decoded.data.request_id,
            attemptIndex: decoded.data.attempt_index,
            candidateSessionId: decoded.data.candidate_session_id,
            sourceSessionId: decoded.data.source_session_id,
            expectedBindingRevision: decoded.data.expected_binding_revision,
            state: decoded.data.state,
            terminalRequestId: decoded.data.terminal_request_id,
            terminalCanonicalHeadHash: decoded.data.terminal_canonical_head_hash,
            terminalCanonicalMessageCount: decoded.data.terminal_canonical_message_count,
            nativeCwd: decoded.data.native_cwd,
            nativeLastModified: decoded.data.native_last_modified,
            nativeContextTokens: decoded.data.native_context_tokens,
            nativeContextMaxTokens: decoded.data.native_context_max_tokens,
            lastModelSpecifier: decoded.data.last_model_specifier,
            lastReasoning: decoded.data.last_reasoning,
            createdAt: decoded.data.created_ts,
            updatedAt: decoded.data.updated_ts,
          },
          provenance: version.value.provenance,
        });
      }
      case "primary-binding": {
        const decoded = corePrimaryClaudeBindingRowSchema.safeParse(input.row);
        if (!decoded.success) return invalidRow();
        return Result.ok({
          value: {
            bindingProtocolVersion: decoded.data.binding_protocol_version,
            providerId: decoded.data.provider_id,
            providerFamily: decoded.data.provider_family,
            requestClient: decoded.data.request_client,
            lilacSessionId: decoded.data.session_id,
            terminalRequestId: decoded.data.terminal_request_id,
            lineageVersion: decoded.data.lineage_version,
            atomCount: decoded.data.atom_count,
            prefixDigest: decoded.data.prefix_digest,
            canonicalMessageCount: decoded.data.canonical_message_count,
            executionScopeHashVersion: decoded.data.execution_scope_hash_version,
            executionScopeHash: decoded.data.execution_scope_hash,
            claudeSessionId: decoded.data.claude_session_id,
            nativeCwd: decoded.data.native_cwd,
            nativeLastModified: decoded.data.native_last_modified,
            nativeContextTokens: decoded.data.native_context_tokens,
            nativeContextMaxTokens: decoded.data.native_context_max_tokens,
            lastModelSpecifier: decoded.data.last_model_specifier,
            lastReasoning: decoded.data.last_reasoning,
            revision: decoded.data.revision,
            updatedAt: decoded.data.updated_ts,
          },
          provenance: version.value.provenance,
        });
      }
      case "primary-attempt": {
        const decoded = corePrimaryClaudeAttemptRowSchema.safeParse(input.row);
        if (!decoded.success) return invalidRow();
        return Result.ok({
          value: {
            product: decoded.data.product,
            providerId: decoded.data.provider_id,
            requestClient: decoded.data.request_client,
            lilacSessionId: decoded.data.session_id,
            sourceLineageVersion: decoded.data.source_lineage_version,
            sourceAtomCount: decoded.data.source_atom_count,
            sourcePrefixDigest: decoded.data.source_prefix_digest,
            sourceCanonicalMessageCount: decoded.data.source_canonical_message_count,
            executionScopeHashVersion: decoded.data.execution_scope_hash_version,
            executionScopeHash: decoded.data.execution_scope_hash,
            requestId: decoded.data.request_id,
            attemptIndex: decoded.data.attempt_index,
            candidateSessionId: decoded.data.candidate_session_id,
            sourceSessionId: decoded.data.source_session_id,
            expectedBindingRevision: decoded.data.expected_binding_revision,
            state: decoded.data.state,
            terminalRequestId: decoded.data.terminal_request_id,
            terminalLineageVersion: decoded.data.terminal_lineage_version,
            terminalAtomCount: decoded.data.terminal_atom_count,
            terminalPrefixDigest: decoded.data.terminal_prefix_digest,
            terminalCanonicalMessageCount: decoded.data.terminal_canonical_message_count,
            nativeCwd: decoded.data.native_cwd,
            nativeLastModified: decoded.data.native_last_modified,
            nativeContextTokens: decoded.data.native_context_tokens,
            nativeContextMaxTokens: decoded.data.native_context_max_tokens,
            lastModelSpecifier: decoded.data.last_model_specifier,
            lastReasoning: decoded.data.last_reasoning,
            createdAt: decoded.data.created_ts,
            updatedAt: decoded.data.updated_ts,
          },
          provenance: version.value.provenance,
        });
      }
    }
  }
  const recordId =
    typeof input.row.request_id === "string" ? input.row.request_id : "unknown-record";
  const version = decodeSchemaVersion(input.schemaVersion, TRANSCRIPT_TABLE, recordId);
  if (version.status === "error") return Result.err(version.error);
  const rowSchema = z
    .object({
      request_id: z.string().min(1),
      session_id: z.string().min(1),
      request_client: adapterPlatformSchema,
      created_ts: nonNegativeIntegerSchema,
      updated_ts: nonNegativeIntegerSchema,
      model_label: z.string().nullable(),
      final_text: z.string().nullable(),
      messages_json: z.string(),
      context_meta_json: z.string().nullable(),
      provider_state_json: z.string().nullable(),
      stable_named_request_client: adapterPlatformSchema.nullable(),
      transcript_digest: z.string().nullable(),
    })
    .safeParse(input.row);
  if (!rowSchema.success) {
    return Result.err(
      corrupt({
        table: TRANSCRIPT_TABLE,
        field: "row",
        version: version.value.version,
        issueCode: "invalid-transcript-row",
        recordId,
      }),
    );
  }
  const messages = decodeTranscriptMessages({
    raw: rowSchema.data.messages_json,
    schemaVersion: version.value.version,
    recordId,
  });
  if (messages.status === "error") return Result.err(messages.error);
  const contextMeta = decodeTranscriptCompactionContext({
    raw: rowSchema.data.context_meta_json,
    schemaVersion: version.value.version,
    recordId,
  });
  if (contextMeta.status === "error") return Result.err(contextMeta.error);
  const providerState = decodeTranscriptProviderState({
    raw: rowSchema.data.provider_state_json,
    schemaVersion: version.value.version,
    recordId,
  });
  if (providerState.status === "error") return Result.err(providerState.error);
  const computedDigest = hashCanonicalMessagesV1(messages.value.value).hash;
  if (rowSchema.data.transcript_digest !== null) {
    const digest = sha256HexSchema.safeParse(rowSchema.data.transcript_digest);
    if (!digest.success || digest.data !== computedDigest) {
      return Result.err(
        corrupt({
          table: TRANSCRIPT_TABLE,
          field: "transcript_digest",
          version: version.value.version,
          issueCode: "digest-mismatch",
          recordId,
        }),
      );
    }
  }
  return Result.ok({
    value: {
      requestId: rowSchema.data.request_id,
      sessionId: rowSchema.data.session_id,
      requestClient: rowSchema.data.request_client,
      createdTs: rowSchema.data.created_ts,
      updatedTs: rowSchema.data.updated_ts,
      messages: messages.value.value,
      ...(rowSchema.data.final_text === null ? {} : { finalText: rowSchema.data.final_text }),
      ...(rowSchema.data.model_label === null ? {} : { modelLabel: rowSchema.data.model_label }),
      ...(contextMeta.value.value === undefined ? {} : { contextMeta: contextMeta.value.value }),
      providerState: providerState.value.value,
      ...(rowSchema.data.stable_named_request_client === null
        ? {}
        : { stableNamedRequestClient: rowSchema.data.stable_named_request_client }),
      canonicalHashVersion: CORE_TRANSCRIPT_DIGEST_VERSION,
      transcriptDigest: computedDigest,
    },
    provenance: aggregateProvenance(version.value, [
      messages.value,
      contextMeta.value,
      providerState.value,
    ]),
  });
}

export function decodeCoreSurfaceProjectionRow(input: {
  readonly row: PersistedCoreSurfaceProjectionRow;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<DecodedCoreSurfaceProjectionRow>, PersistedDataError>;
export function decodeCoreSurfaceProjectionRow(input: {
  readonly row: null;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<null>, PersistedDataError>;
export function decodeCoreSurfaceProjectionRow(input: {
  readonly row: PersistedCoreSurfaceProjectionRow | null;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<DecodedCoreSurfaceProjectionRow | null>, PersistedDataError> {
  if (input.row === null) return Result.ok({ value: null, provenance: "missing-defaulted" });
  const recordId = `${input.row.request_client}:${input.row.surface_id}:${input.row.session_id}:${input.row.message_id}`;
  const version = decodeSchemaVersion(input.schemaVersion, PROJECTION_TABLE, recordId);
  if (version.status === "error") return Result.err(version.error);
  const row = z
    .object({
      request_client: adapterPlatformSchema,
      surface_id: z.string().min(1),
      session_id: z.string().min(1),
      message_id: z.string().min(1),
      projection_format_version: z.literal(CORE_SURFACE_PROJECTION_FORMAT_VERSION),
      canonical_messages_json: z.string(),
      source_facts_json: z.string(),
      created_ts: nonNegativeIntegerSchema,
    })
    .safeParse(input.row);
  if (!row.success) {
    return Result.err(
      corrupt({
        table: PROJECTION_TABLE,
        field: "row",
        version: version.value.version,
        issueCode: "invalid-surface-projection",
        recordId,
      }),
    );
  }
  const canonicalSerialized = decodeSerialized({
    raw: row.data.canonical_messages_json,
    table: PROJECTION_TABLE,
    field: "canonical_messages_json",
    version: version.value.version,
    recordId,
  });
  if (canonicalSerialized.status === "error") return Result.err(canonicalSerialized.error);
  const canonicalMessages = decodeNormalizedMessagesValue(canonicalSerialized.value, {
    table: PROJECTION_TABLE,
    field: "canonical_messages_json",
    version: version.value.version,
    recordId,
  });
  if (canonicalMessages.status === "error") return Result.err(canonicalMessages.error);
  const factsSerialized = decodeSerialized({
    raw: row.data.source_facts_json,
    table: PROJECTION_TABLE,
    field: "source_facts_json",
    version: version.value.version,
    recordId,
  });
  if (factsSerialized.status === "error") return Result.err(factsSerialized.error);
  const sourceFacts = coreProjectionSourceFactsSchema.safeParse(factsSerialized.value);
  if (!sourceFacts.success) {
    return Result.err(
      corrupt({
        table: PROJECTION_TABLE,
        field: "source_facts_json",
        version: version.value.version,
        issueCode: "invalid-surface-projection",
        recordId,
      }),
    );
  }
  return Result.ok({
    value: {
      requestClient: row.data.request_client,
      surfaceId: row.data.surface_id,
      sessionId: row.data.session_id,
      messageId: row.data.message_id,
      projectionFormatVersion: row.data.projection_format_version,
      canonicalMessages: canonicalMessages.value,
      sourceFacts: sourceFacts.data,
      createdAt: row.data.created_ts,
    },
    provenance: version.value.provenance,
  });
}

export function decodeCoreLineageManifestRow(input: {
  readonly row: PersistedCoreLineageManifestRow;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<DecodedCoreLineageManifestV1>, PersistedDataError>;
export function decodeCoreLineageManifestRow(input: {
  readonly row: null;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<null>, PersistedDataError>;
export function decodeCoreLineageManifestRow(input: {
  readonly row: PersistedCoreLineageManifestRow | null;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<DecodedCoreLineageManifestV1 | null>, PersistedDataError> {
  if (input.row === null) return Result.ok({ value: null, provenance: "missing-defaulted" });
  const recordId =
    typeof input.row.request_id === "string" ? input.row.request_id : "unknown-record";
  const version = decodeSchemaVersion(input.schemaVersion, LINEAGE_TABLE, recordId);
  if (version.status === "error") return Result.err(version.error);
  if (input.row.lineage_version !== 1 || typeof input.row.manifest_json !== "string") {
    return Result.err(
      corrupt({
        table: LINEAGE_TABLE,
        field: "row",
        version: version.value.version,
        issueCode: "invalid-lineage-manifest",
        recordId,
      }),
    );
  }
  const serialized = decodeSerialized({
    raw: input.row.manifest_json,
    table: LINEAGE_TABLE,
    field: "manifest_json",
    version: version.value.version,
    recordId,
  });
  if (serialized.status === "error") return Result.err(serialized.error);
  const parsed = coreLineageManifestV1Schema.safeParse(serialized.value);
  if (!parsed.success) {
    return Result.err(
      corrupt({
        table: LINEAGE_TABLE,
        field: "manifest_json",
        version: version.value.version,
        issueCode: "invalid-lineage-manifest",
        recordId,
      }),
    );
  }
  const segments: DecodedCoreLineageSegmentV1[] = [];
  for (const segment of parsed.data.segments) {
    const canonicalMessages = decodeNormalizedMessagesValue(segment.canonicalMessages, {
      table: LINEAGE_TABLE,
      field: "manifest_json",
      version: version.value.version,
      recordId,
    });
    if (canonicalMessages.status === "error") return Result.err(canonicalMessages.error);
    segments.push({ ...segment, canonicalMessages: canonicalMessages.value });
  }
  const decodedManifest: DecodedCoreLineageManifestV1 = { ...parsed.data, segments };
  const canonicalMessages = decodedManifest.segments.flatMap(
    (segment) => segment.canonicalMessages,
  );
  const lineage = decodeCorePrimaryLineageV1(decodedManifest, canonicalMessages);
  if (lineage.status === "error" || lineage.value.state !== "complete") {
    return Result.err(
      corrupt({
        table: LINEAGE_TABLE,
        field: "manifest_json",
        version: version.value.version,
        issueCode: "invalid-lineage-manifest",
        recordId,
      }),
    );
  }
  return Result.ok({ value: decodedManifest, provenance: version.value.provenance });
}

const fixtureMessages = '[{"role":"assistant","content":"fixture"}]';
const fixtureDigest = hashCanonicalMessagesV1([{ role: "assistant", content: "fixture" }]).hash;
const fixtureTranscriptRow = {
  request_id: "fixture",
  session_id: "session",
  request_client: "discord",
  created_ts: 1,
  updated_ts: 2,
  model_label: null,
  final_text: null,
  messages_json: fixtureMessages,
  context_meta_json: null,
  provider_state_json: null,
  stable_named_request_client: null,
  transcript_digest: fixtureDigest,
} as const satisfies PersistedTranscriptRow;

export const transcriptCompactionContextCodecCases = {
  current: {
    input: {
      raw: '{"type":"compaction","formatVersion":1}',
      schemaVersion: 5,
      recordId: "current",
    },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: { raw: '{"type":"compaction","formatVersion":1}', schemaVersion: 1, recordId: "legacy" },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { raw: null, schemaVersion: 5, recordId: "missing" },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: { raw: null, schemaVersion: 6, recordId: "unsupported" },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { raw: "{", schemaVersion: 5, recordId: "malformed" },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      raw: '{"type":"compaction","formatVersion":2}',
      schemaVersion: 5,
      recordId: "corrupt",
    },
    outcome: "error",
  },
} as const;

export const transcriptProviderStateCodecCases = {
  current: {
    input: {
      raw: '{"lastFamily":"ai-sdk","containsCrossFamilyTurns":false}',
      schemaVersion: 5,
      recordId: "current",
    },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: {
      raw: '{"lastFamily":"ai-sdk","containsCrossFamilyTurns":false}',
      schemaVersion: 1,
      recordId: "legacy",
    },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { raw: null, schemaVersion: 5, recordId: "missing" },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: { raw: null, schemaVersion: 6, recordId: "unsupported" },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { raw: "{", schemaVersion: 5, recordId: "malformed" },
    outcome: "error",
  },
  "corrupt-fields": {
    input: { raw: '{"lastFamily":"future"}', schemaVersion: 5, recordId: "corrupt" },
    outcome: "error",
  },
} as const;

export const transcriptRowCodecCases = {
  current: {
    input: {
      row: {
        ...fixtureTranscriptRow,
        context_meta_json: '{"type":"compaction","formatVersion":1}',
        provider_state_json: '{"lastFamily":"ai-sdk","containsCrossFamilyTurns":false}',
      },
      schemaVersion: 5,
    },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: { row: { ...fixtureTranscriptRow, transcript_digest: null }, schemaVersion: 1 },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { row: fixtureTranscriptRow, schemaVersion: 5 },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: { row: fixtureTranscriptRow, schemaVersion: 6 },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { row: { ...fixtureTranscriptRow, messages_json: "{" }, schemaVersion: 5 },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      row: { ...fixtureTranscriptRow, transcript_digest: "00".repeat(32) },
      schemaVersion: 5,
    },
    outcome: "error",
  },
} as const;

const fixtureNamedBindingRow = {
  request_client: "discord",
  session_id: "session",
  provider_id: "claude-code",
  binding_protocol_version: 1,
  provider_family: "claude-code",
  terminal_request_id: "request",
  canonical_hash_version: 1,
  canonical_head_hash: "11".repeat(32),
  canonical_message_count: 1,
  execution_scope_hash_version: 1,
  execution_scope_hash: "scope",
  claude_session_id: "00000000-0000-4000-8000-000000000001",
  native_cwd: "/workspace",
  native_last_modified: 1,
  native_context_tokens: 1,
  native_context_max_tokens: 2,
  last_model_specifier: "claude",
  last_reasoning: "medium",
  revision: 1,
  updated_ts: 1,
} as const;

export const transcriptStoreRowFixtures = {
  current: {
    input: {
      storeKind: "named-binding",
      row: fixtureNamedBindingRow,
      schemaVersion: 5,
      recordId: "current-binding",
    },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: {
      storeKind: "named-binding",
      row: fixtureNamedBindingRow,
      schemaVersion: 4,
      recordId: "legacy-binding",
    },
    outcome: "ok",
    provenance: "migrated",
  },
  corrupt: {
    input: {
      storeKind: "named-binding",
      row: { ...fixtureNamedBindingRow, provider_family: "future-provider" },
      schemaVersion: 5,
      recordId: "corrupt-binding",
    },
    outcome: "error",
  },
} as const;

const fixtureProjectionRow = {
  request_client: "discord",
  surface_id: "discord:session",
  session_id: "session",
  message_id: "message",
  projection_format_version: 1,
  canonical_messages_json: fixtureMessages,
  source_facts_json: "{}",
  created_ts: 1,
} as const satisfies PersistedCoreSurfaceProjectionRow;

export const coreSurfaceProjectionRowCodecCases = {
  current: {
    input: { row: fixtureProjectionRow, schemaVersion: 5 },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: { row: fixtureProjectionRow, schemaVersion: 2 },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { row: null, schemaVersion: 5 },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: { row: fixtureProjectionRow, schemaVersion: 6 },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { row: { ...fixtureProjectionRow, source_facts_json: "{" }, schemaVersion: 5 },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      row: {
        ...fixtureProjectionRow,
        source_facts_json: '{"bad":null,"nested":{"bad":null}}',
        projection_format_version: 2,
      },
      schemaVersion: 5,
    },
    outcome: "error",
  },
} as const;

const fixtureLineageAtom = {
  kind: "synthetic",
  source: "fixture",
  messageDigest: fixtureDigest,
} as const;
const fixtureManifest = {
  state: "complete",
  lineageVersion: 1,
  currentCanonicalStart: 0,
  segments: [
    {
      atoms: [fixtureLineageAtom],
      canonicalMessages: [{ role: "assistant", content: "fixture" }],
      canonicalStart: 0,
      canonicalEnd: 1,
      cumulativeAtomCount: 1,
      cumulativePrefixDigest: computeCoreLineagePrefixDigestV1([fixtureLineageAtom]),
    },
  ],
} as const;
const fixtureLineageRow = {
  request_id: "fixture",
  lineage_version: 1,
  manifest_json: JSON.stringify(fixtureManifest),
} as const;

export const coreLineageManifestRowCodecCases = {
  current: {
    input: { row: fixtureLineageRow, schemaVersion: 5 },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: { row: fixtureLineageRow, schemaVersion: 2 },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { row: null, schemaVersion: 5 },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": { input: { row: fixtureLineageRow, schemaVersion: 6 }, outcome: "error" },
  "malformed-serialization": {
    input: { row: { ...fixtureLineageRow, manifest_json: "{" }, schemaVersion: 5 },
    outcome: "error",
  },
  "corrupt-fields": {
    input: { row: { ...fixtureLineageRow, manifest_json: "{}" }, schemaVersion: 5 },
    outcome: "error",
  },
} as const;
