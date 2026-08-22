import SuperJSON from "superjson";
import { createHash } from "node:crypto";
import {
  canonicalJsonStringify,
  historyProviderStateSchema,
  type HistoryProviderState,
} from "@stanley2058/lilac-agent";
import { blobRefV1Schema, type BlobRefV1 } from "@stanley2058/lilac-blob-storage";
import {
  coreLineageManifestV2Schema,
  computeCoreLineagePrefixDigestV2,
  decodeCorePrimaryLineageV2,
  storedFilePartV1Schema as eventStoredFilePartV1Schema,
  storedMessageV1Schema as eventStoredMessageV1Schema,
  storedMessagesV1Schema,
  type AdapterPlatform,
  type CoreLineageAtomV2,
  type CoreRequestAliasV2,
  type StoredFilePartV1 as EventStoredFilePartV1,
  type StoredMessageV1 as EventStoredMessageV1,
} from "@stanley2058/lilac-event-bus";
import {
  CorruptPersistedFields,
  MalformedSerialization,
  UnsupportedVersion,
  isRecord,
  type DecodedPersistedValue,
  type PersistedDataError,
  type PersistedDataIssueCode,
  type PersistenceProvenance,
} from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { adaptToolResultToHost } from "../tools/tool-result-adapters";

export const TRANSCRIPT_PERSISTENCE_SCHEMA_VERSION = 6 as const;
export const COMPACTION_CHECKPOINT_FORMAT_VERSION = 1 as const;
export const CORE_SURFACE_PROJECTION_FORMAT_VERSION = 1 as const;
export const CORE_TRANSCRIPT_DIGEST_VERSION = 2 as const;

const TRANSCRIPT_TABLE = "request_transcripts";
const PROJECTION_TABLE = "core_surface_projections";
const LINEAGE_TABLE = "core_primary_lineage_manifests";
const SURFACE_LINK_TABLE = "surface_message_to_request";

const adapterPlatformSchema = z.enum([
  "discord",
  "github",
  "whatsapp",
  "slack",
  "telegram",
  "web",
  "unknown",
]);
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

export const storedFilePartV1Schema = eventStoredFilePartV1Schema;
export type StoredFilePartV1 = EventStoredFilePartV1;
export type StoredMessageV1 = EventStoredMessageV1;
export type DecodedModelMessage = StoredMessageV1;

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
  readonly ownerId: string;
  readonly blob: BlobRefV1;
  readonly mediaType: string;
  readonly filename: string;
  readonly createdAt: number;
};

export type DecodedCoreNamedClaudeBindingRow = {
  readonly bindingProtocolVersion: 1;
  readonly providerId: string;
  readonly providerFamily: "claude-code";
  readonly requestClient: AdapterPlatform;
  readonly lilacSessionId: string;
  readonly terminalRequestId: string;
  readonly canonicalHashVersion: 2;
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
  readonly lineageVersion: 2;
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
  readonly sourceLineageVersion: 2 | null;
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
  readonly terminalLineageVersion: 2 | null;
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

export type PersistedSurfaceMessageLinkRow = {
  readonly request_id: string;
  readonly platform: string;
  readonly channel_id: string;
  readonly message_id: string;
};

export type DecodedSurfaceMessageLinkRow = {
  readonly requestId: string;
  readonly platform: AdapterPlatform;
  readonly channelId: string;
  readonly messageId: string;
};

export type PersistedRecentAgentWriteRow = {
  readonly request_id: string;
  readonly platform: string;
  readonly channel_id: string;
  readonly message_id: string;
  readonly updated_ts: number;
  readonly final_text: string | null;
};

export type DecodedRecentAgentWriteRow = {
  readonly requestId: string;
  readonly platform: AdapterPlatform;
  readonly channelId: string;
  readonly messageId: string;
  readonly updatedTs: number;
  readonly finalText: string | null;
};

export type PersistedDiscoveryRecordRow = {
  readonly request_id: string;
  readonly session_id: string;
  readonly request_client: string;
  readonly updated_ts: number;
  readonly final_text: string | null;
  readonly surface_platform: string | null;
  readonly surface_channel_id: string | null;
  readonly surface_message_id: string | null;
  readonly surface_created_ts: number | null;
};

export type DecodedDiscoveryRecordRow = {
  readonly requestId: string;
  readonly sessionId: string;
  readonly requestClient: AdapterPlatform;
  readonly updatedTs: number;
  readonly finalText: string | null;
  readonly surfaceRef: {
    readonly platform: AdapterPlatform;
    readonly channelId: string;
    readonly messageId: string;
  } | null;
};

type DecodedRequiredPersistedValue<T> = {
  readonly value: T;
  readonly provenance: "current" | "migrated";
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

export type CoreStoredLineageSegmentV2 = {
  readonly atoms: CoreLineageAtomV2[];
  readonly canonicalMessages: DecodedModelMessage[];
  readonly requestSource?: {
    readonly aliases: CoreRequestAliasV2[];
  };
  readonly canonicalStart: number;
  readonly canonicalEnd: number;
  readonly cumulativeAtomCount: number;
  readonly cumulativePrefixDigest: string;
};

export type CoreStoredLineageManifestV2 = {
  readonly state: "complete";
  readonly lineageVersion: 2;
  readonly currentCanonicalStart: number;
  readonly segments: CoreStoredLineageSegmentV2[];
};

type DecodedSchemaVersion = {
  readonly version: 1 | 2 | 3 | 4 | 5 | 6;
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
  owner_id: z.string().min(1),
  blob_ref_json: z.string(),
  media_type: z.string().min(1),
  filename: z.string().min(1),
  byte_length: nonNegativeIntegerSchema,
  created_ts: nonNegativeIntegerSchema,
});
const coreNamedClaudeBindingRowSchema = z.strictObject({
  request_client: adapterPlatformSchema,
  session_id: z.string().min(1),
  provider_id: z.string().min(1),
  binding_protocol_version: z.literal(1),
  provider_family: z.literal("claude-code"),
  terminal_request_id: z.string().min(1),
  canonical_hash_version: z.literal(2),
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
  lineage_version: z.literal(2),
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
  source_lineage_version: z.literal(2).nullable(),
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
  terminal_lineage_version: z.literal(2).nullable(),
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
const recentAgentWriteRowSchema = z.strictObject({
  request_id: z.string().min(1),
  platform: adapterPlatformSchema,
  channel_id: z.string().min(1),
  message_id: z.string().min(1),
  updated_ts: nonNegativeIntegerSchema,
  final_text: z.string().nullable(),
});
const surfaceMessageLinkRowSchema = z.strictObject({
  request_id: z.string().min(1),
  platform: adapterPlatformSchema,
  channel_id: z.string().min(1),
  message_id: z.string().min(1),
});
const discoveryRecordRowSchema = z.strictObject({
  request_id: z.string().min(1),
  session_id: z.string().min(1),
  request_client: adapterPlatformSchema,
  updated_ts: nonNegativeIntegerSchema,
  final_text: z.string().nullable(),
  surface_platform: adapterPlatformSchema.nullable(),
  surface_channel_id: z.string().min(1).nullable(),
  surface_message_id: z.string().min(1).nullable(),
  surface_created_ts: nonNegativeIntegerSchema.nullable(),
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
    case 6:
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
}): ResultType<unknown, MalformedSerialization | Panic> {
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
  const finish = decoded.match<() => ResultType<unknown, MalformedSerialization | Panic>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () => {
      if (Panic.is(error)) return Result.err(error);
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
    },
  });
  return finish();
}

type TranscriptPersistenceDecodeError = PersistedDataError | Panic;

function adaptTranscriptPersistenceDecodeResult<T>(
  result: ResultType<T, TranscriptPersistenceDecodeError>,
): ResultType<T, PersistedDataError> {
  const adapt = result.match<() => ResultType<T, PersistedDataError>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () => {
      if (Panic.is(error)) return adaptToolResultToHost(Result.err(error));
      return Result.err(error);
    },
  });
  return adapt();
}

export const storedMessageV1Schema = eventStoredMessageV1Schema;

const CORE_TRANSCRIPT_DIGEST_DOMAIN_V2 = "lilac:core-transcript:v2";

export class StoredMessageValidationError extends TaggedError("StoredMessageValidationError")<{
  readonly message: string;
}> {}

type StoredAssistantMessage = Extract<StoredMessageV1, { readonly role: "assistant" }>;
type StoredToolMessage = Extract<StoredMessageV1, { readonly role: "tool" }>;
type StoredAssistantPart = Exclude<StoredAssistantMessage["content"], string>[number];
type StoredToolPart = StoredToolMessage["content"][number];
type StoredToolResultPart = Extract<StoredAssistantPart | StoredToolPart, { type: "tool-result" }>;

function projectStoredBlobIdentity(part: StoredFilePartV1) {
  return {
    type: "blob" as const,
    sha256: part.blob.sha256,
    byteLength: part.blob.byteLength,
    mediaType: part.mediaType,
    ...(part.filename === undefined ? {} : { filename: part.filename }),
  };
}

function projectStoredToolResult(part: StoredToolResultPart) {
  if (part.output.type !== "content") return part;
  return {
    ...part,
    output: {
      ...part.output,
      value: part.output.value.map((value) =>
        value.type === "blob" ? projectStoredBlobIdentity(value) : value,
      ),
    },
  };
}

function projectStoredMessageIdentity(message: StoredMessageV1) {
  if (typeof message.content === "string") return message;
  return {
    ...message,
    content: message.content.map((part) => {
      if (part.type === "blob") return projectStoredBlobIdentity(part);
      if (part.type === "tool-result") return projectStoredToolResult(part);
      return part;
    }),
  };
}

export function hashCanonicalStoredMessagesV2(
  messages: readonly StoredMessageV1[],
): ResultType<
  { readonly version: 2; readonly hash: string; readonly serialized: string },
  StoredMessageValidationError
> {
  const normalized = normalizeStoredMessagesV1(messages);
  if (normalized === null) {
    return Result.err(
      new StoredMessageValidationError({
        message: "Stored messages contain invalid or non-JSON content",
      }),
    );
  }
  const projection = {
    version: CORE_TRANSCRIPT_DIGEST_VERSION,
    messages: normalized.map(projectStoredMessageIdentity),
  };
  const serialized = canonicalJsonStringify(projection);
  return Result.ok({
    version: CORE_TRANSCRIPT_DIGEST_VERSION,
    hash: createHash("sha256")
      .update(CORE_TRANSCRIPT_DIGEST_DOMAIN_V2)
      .update("\0")
      .update(serialized)
      .digest("hex"),
    serialized,
  });
}

export function decodeStoredBlobRefV1(value: unknown): BlobRefV1 | null {
  const decoded = blobRefV1Schema.safeParse(value);
  return decoded.success ? decoded.data : null;
}

function decodeCoreOwnedBlobValue(input: {
  readonly row: z.output<typeof coreOwnedBlobRowSchema>;
  readonly version: DecodedSchemaVersion;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<DecodedCoreOwnedBlobRow>, PersistedDataError> {
  return adaptTranscriptPersistenceDecodeResult(
    Result.gen(function* () {
      const serialized = yield* decodeSerialized({
        raw: input.row.blob_ref_json,
        table: "core_owned_blobs",
        field: "blob_ref_json",
        version: input.version.version,
        recordId: input.recordId,
      });
      const blob = decodeStoredBlobRefV1(serialized);
      if (
        blob === null ||
        blob.objectId !== input.row.owner_id ||
        blob.byteLength !== input.row.byte_length
      ) {
        return Result.err(
          corrupt({
            table: "core_owned_blobs",
            field: "blob_ref_json",
            version: input.version.version,
            issueCode: "invalid-transcript-row",
            recordId: input.recordId,
          }),
        );
      }
      return Result.ok({
        value: {
          ownerId: input.row.owner_id,
          blob,
          mediaType: input.row.media_type,
          filename: input.row.filename,
          createdAt: input.row.created_ts,
        },
        provenance: input.version.provenance,
      });
    }),
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
  const messages = normalizeStoredMessagesV1(value);
  if (messages === null) {
    return Result.err(corrupt({ ...input, issueCode: "invalid-transcript-messages" }));
  }
  return Result.ok(messages);
}

/** Validate and normalize the current reference-bearing stored-message representation. */
export function normalizeStoredMessagesV1(value: unknown): StoredMessageV1[] | null {
  const decoded = storedMessagesV1Schema.safeParse(value);
  if (!decoded.success) return null;
  const normalized = Result.try<unknown, { readonly cause: unknown }>({
    try: () => globalThis.JSON.parse(globalThis.JSON.stringify(decoded.data)),
    catch: (cause) => ({ cause }),
  });
  if (normalized.isErr()) return null;
  const reparsed = storedMessagesV1Schema.safeParse(normalized.value);
  return reparsed.success ? reparsed.data : null;
}

export function decodeTranscriptMessages(input: {
  readonly raw: string;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<DecodedModelMessage[]>, PersistedDataError> {
  return adaptTranscriptPersistenceDecodeResult(
    Result.gen(function* () {
      const version = yield* decodeSchemaVersion(
        input.schemaVersion,
        TRANSCRIPT_TABLE,
        input.recordId,
      );
      if (typeof input.raw !== "string") {
        return Result.err(
          corrupt({
            table: TRANSCRIPT_TABLE,
            field: "messages_json",
            version: version.version,
            issueCode: "missing-required-field",
            recordId: input.recordId,
          }),
        );
      }
      const serialized = yield* decodeSerialized({
        raw: input.raw,
        table: TRANSCRIPT_TABLE,
        field: "messages_json",
        version: version.version,
        recordId: input.recordId,
      });
      const messages = yield* decodeNormalizedMessagesValue(serialized, {
        table: TRANSCRIPT_TABLE,
        field: "messages_json",
        version: version.version,
        recordId: input.recordId,
      });
      return Result.ok({ value: messages, provenance: version.provenance });
    }),
  );
}

export function decodeTranscriptCompactionContext(input: {
  readonly raw: string | null;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<CompactionCheckpointMeta | undefined>, PersistedDataError> {
  return adaptTranscriptPersistenceDecodeResult(
    Result.gen(function* () {
      const version = yield* decodeSchemaVersion(
        input.schemaVersion,
        TRANSCRIPT_TABLE,
        input.recordId,
      );
      if (input.raw === null)
        return Result.ok<DecodedPersistedValue<CompactionCheckpointMeta | undefined>>({
          value: undefined,
          provenance: "missing-defaulted",
        });
      const serialized = yield* decodeSerialized({
        raw: input.raw,
        table: TRANSCRIPT_TABLE,
        field: "context_meta_json",
        version: version.version,
        recordId: input.recordId,
      });
      const decoded = compactionCheckpointMetaSchema.safeParse(serialized);
      if (!decoded.success) {
        return Result.err(
          corrupt({
            table: TRANSCRIPT_TABLE,
            field: "context_meta_json",
            version: version.version,
            issueCode: "invalid-compaction-context",
            recordId: input.recordId,
          }),
        );
      }
      return Result.ok({ value: decoded.data, provenance: version.provenance });
    }),
  );
}

export function decodeTranscriptProviderState(input: {
  readonly raw: string | null;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<HistoryProviderState | null>, PersistedDataError> {
  return adaptTranscriptPersistenceDecodeResult(
    Result.gen(function* () {
      const version = yield* decodeSchemaVersion(
        input.schemaVersion,
        TRANSCRIPT_TABLE,
        input.recordId,
      );
      if (input.raw === null)
        return Result.ok<DecodedPersistedValue<HistoryProviderState | null>>({
          value: null,
          provenance: "missing-defaulted",
        });
      const serialized = yield* decodeSerialized({
        raw: input.raw,
        table: TRANSCRIPT_TABLE,
        field: "provider_state_json",
        version: version.version,
        recordId: input.recordId,
      });
      const decoded = historyProviderStateSchema.safeParse(serialized);
      if (!decoded.success) {
        return Result.err(
          corrupt({
            table: TRANSCRIPT_TABLE,
            field: "provider_state_json",
            version: version.version,
            issueCode: "invalid-provider-state",
            recordId: input.recordId,
          }),
        );
      }
      return Result.ok({ value: decoded.data, provenance: version.provenance });
    }),
  );
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

export function decodeSurfaceMessageLinkRow(input: {
  readonly row: unknown;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedRequiredPersistedValue<DecodedSurfaceMessageLinkRow>, PersistedDataError> {
  return Result.gen(function* () {
    const version = yield* decodeSchemaVersion(
      input.schemaVersion,
      SURFACE_LINK_TABLE,
      input.recordId,
    );
    const decoded = surfaceMessageLinkRowSchema.safeParse(input.row);
    if (!decoded.success) {
      return Result.err(
        corrupt({
          table: SURFACE_LINK_TABLE,
          field: "surface-message-link-row",
          version: version.version,
          issueCode: "invalid-transcript-row",
          recordId: input.recordId,
        }),
      );
    }
    return Result.ok({
      value: {
        requestId: decoded.data.request_id,
        platform: decoded.data.platform,
        channelId: decoded.data.channel_id,
        messageId: decoded.data.message_id,
      },
      provenance: version.provenance,
    });
  });
}

export function decodeRecentAgentWriteRow(input: {
  readonly row: unknown;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedRequiredPersistedValue<DecodedRecentAgentWriteRow>, PersistedDataError> {
  return Result.gen(function* () {
    const version = yield* decodeSchemaVersion(
      input.schemaVersion,
      SURFACE_LINK_TABLE,
      input.recordId,
    );
    const decoded = recentAgentWriteRowSchema.safeParse(input.row);
    if (!decoded.success) {
      return Result.err(
        corrupt({
          table: SURFACE_LINK_TABLE,
          field: "recent-agent-write-row",
          version: version.version,
          issueCode: "invalid-transcript-row",
          recordId: input.recordId,
        }),
      );
    }
    return Result.ok({
      value: {
        requestId: decoded.data.request_id,
        platform: decoded.data.platform,
        channelId: decoded.data.channel_id,
        messageId: decoded.data.message_id,
        updatedTs: decoded.data.updated_ts,
        finalText: decoded.data.final_text,
      },
      provenance: version.provenance,
    });
  });
}

export function decodeDiscoveryRecordRow(input: {
  readonly row: unknown;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedRequiredPersistedValue<DecodedDiscoveryRecordRow>, PersistedDataError> {
  return Result.gen(function* () {
    const version = yield* decodeSchemaVersion(
      input.schemaVersion,
      TRANSCRIPT_TABLE,
      input.recordId,
    );
    const decoded = discoveryRecordRowSchema.safeParse(input.row);
    if (!decoded.success) {
      return Result.err(
        corrupt({
          table: TRANSCRIPT_TABLE,
          field: "discovery-record-row",
          version: version.version,
          issueCode: "invalid-transcript-row",
          recordId: input.recordId,
        }),
      );
    }
    const linkedValues = [
      decoded.data.surface_platform,
      decoded.data.surface_channel_id,
      decoded.data.surface_message_id,
      decoded.data.surface_created_ts,
    ];
    const hasLinkedValue = linkedValues.some((value) => value !== null);
    if (hasLinkedValue && linkedValues.some((value) => value === null)) {
      return Result.err(
        corrupt({
          table: TRANSCRIPT_TABLE,
          field: "discovery-record-row",
          version: version.version,
          issueCode: "invalid-transcript-row",
          recordId: input.recordId,
        }),
      );
    }
    return Result.ok({
      value: {
        requestId: decoded.data.request_id,
        sessionId: decoded.data.session_id,
        requestClient: decoded.data.request_client,
        updatedTs: decoded.data.updated_ts,
        finalText: decoded.data.final_text,
        surfaceRef:
          decoded.data.surface_platform === null ||
          decoded.data.surface_channel_id === null ||
          decoded.data.surface_message_id === null
            ? null
            : {
                platform: decoded.data.surface_platform,
                channelId: decoded.data.surface_channel_id,
                messageId: decoded.data.surface_message_id,
              },
      },
      provenance: version.provenance,
    });
  });
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
    const decodeStoreRow = decodeSchemaVersion(
      input.schemaVersion,
      TRANSCRIPT_TABLE,
      input.recordId,
    ).match<() => ResultType<DecodedPersistedValue<DecodedTranscriptStoreRow>, PersistedDataError>>(
      {
        err: (error) => () => Result.err(error),
        ok: (version) => () => {
          const invalidRow = () =>
            Result.err(
              corrupt({
                table: TRANSCRIPT_TABLE,
                field: input.storeKind,
                version: version.version,
                issueCode: "invalid-transcript-row",
                recordId: input.recordId,
              }),
            );
          switch (input.storeKind) {
            case "migration-version": {
              const decoded = transcriptMigrationVersionRowSchema.safeParse(input.row);
              return decoded.success
                ? Result.ok({ value: decoded.data, provenance: version.provenance })
                : invalidRow();
            }
            case "foreign-key-failure": {
              const decoded = transcriptForeignKeyFailureRowSchema.safeParse(input.row);
              return decoded.success
                ? Result.ok({ value: decoded.data, provenance: version.provenance })
                : invalidRow();
            }
            case "count": {
              const decoded = transcriptCountRowSchema.safeParse(input.row);
              return decoded.success
                ? Result.ok({ value: decoded.data, provenance: version.provenance })
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
                    provenance: version.provenance,
                  })
                : invalidRow();
            }
            case "owned-blob": {
              const decoded = coreOwnedBlobRowSchema.safeParse(input.row);
              if (!decoded.success) return invalidRow();
              return decodeCoreOwnedBlobValue({
                row: decoded.data,
                version,
                recordId: input.recordId,
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
                provenance: version.provenance,
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
                provenance: version.provenance,
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
                provenance: version.provenance,
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
                provenance: version.provenance,
              });
            }
          }
        },
      },
    );
    return decodeStoreRow();
  }
  const recordId =
    typeof input.row.request_id === "string" ? input.row.request_id : "unknown-record";
  const decodeRow = decodeSchemaVersion(input.schemaVersion, TRANSCRIPT_TABLE, recordId).match<
    () => ResultType<DecodedPersistedValue<DecodedTranscriptRow>, PersistedDataError>
  >({
    err: (error) => () => Result.err(error),
    ok: (version) => () => {
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
            version: version.version,
            issueCode: "invalid-transcript-row",
            recordId,
          }),
        );
      }
      const continueWithMessages = decodeTranscriptMessages({
        raw: rowSchema.data.messages_json,
        schemaVersion: version.version,
        recordId,
      }).match<() => ResultType<DecodedPersistedValue<DecodedTranscriptRow>, PersistedDataError>>({
        err: (error) => () => Result.err(error),
        ok: (messages) => () => {
          const continueWithContextMeta = decodeTranscriptCompactionContext({
            raw: rowSchema.data.context_meta_json,
            schemaVersion: version.version,
            recordId,
          }).match<
            () => ResultType<DecodedPersistedValue<DecodedTranscriptRow>, PersistedDataError>
          >({
            err: (error) => () => Result.err(error),
            ok: (contextMeta) => () => {
              const continueWithProviderState = decodeTranscriptProviderState({
                raw: rowSchema.data.provider_state_json,
                schemaVersion: version.version,
                recordId,
              }).match<
                () => ResultType<DecodedPersistedValue<DecodedTranscriptRow>, PersistedDataError>
              >({
                err: (error) => () => Result.err(error),
                ok: (providerState) => () => {
                  return hashCanonicalStoredMessagesV2(messages.value)
                    .andThen((computed) => {
                      if (rowSchema.data.transcript_digest !== null) {
                        const digest = sha256HexSchema.safeParse(rowSchema.data.transcript_digest);
                        if (!digest.success || digest.data !== computed.hash) {
                          return Result.err(
                            corrupt({
                              table: TRANSCRIPT_TABLE,
                              field: "transcript_digest",
                              version: version.version,
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
                          messages: messages.value,
                          ...(rowSchema.data.final_text === null
                            ? {}
                            : { finalText: rowSchema.data.final_text }),
                          ...(rowSchema.data.model_label === null
                            ? {}
                            : { modelLabel: rowSchema.data.model_label }),
                          ...(contextMeta.value === undefined
                            ? {}
                            : { contextMeta: contextMeta.value }),
                          providerState: providerState.value,
                          ...(rowSchema.data.stable_named_request_client === null
                            ? {}
                            : {
                                stableNamedRequestClient:
                                  rowSchema.data.stable_named_request_client,
                              }),
                          canonicalHashVersion: CORE_TRANSCRIPT_DIGEST_VERSION,
                          transcriptDigest: computed.hash,
                        },
                        provenance: aggregateProvenance(version, [
                          messages,
                          contextMeta,
                          providerState,
                        ]),
                      });
                    })
                    .mapError(() =>
                      corrupt({
                        table: TRANSCRIPT_TABLE,
                        field: "messages_json",
                        version: version.version,
                        issueCode: "invalid-transcript-row",
                        recordId,
                      }),
                    );
                },
              });
              return continueWithProviderState();
            },
          });
          return continueWithContextMeta();
        },
      });
      return continueWithMessages();
    },
  });
  return decodeRow();
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
  return adaptTranscriptPersistenceDecodeResult(
    Result.gen(function* () {
      if (input.row === null)
        return Result.ok<DecodedPersistedValue<DecodedCoreSurfaceProjectionRow | null>>({
          value: null,
          provenance: "missing-defaulted",
        });
      const recordId = `${input.row.request_client}:${input.row.surface_id}:${input.row.session_id}:${input.row.message_id}`;
      const version = yield* decodeSchemaVersion(input.schemaVersion, PROJECTION_TABLE, recordId);
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
            version: version.version,
            issueCode: "invalid-surface-projection",
            recordId,
          }),
        );
      }
      const canonicalSerialized = yield* decodeSerialized({
        raw: row.data.canonical_messages_json,
        table: PROJECTION_TABLE,
        field: "canonical_messages_json",
        version: version.version,
        recordId,
      });
      const canonicalMessages = yield* decodeNormalizedMessagesValue(canonicalSerialized, {
        table: PROJECTION_TABLE,
        field: "canonical_messages_json",
        version: version.version,
        recordId,
      });
      const factsSerialized = yield* decodeSerialized({
        raw: row.data.source_facts_json,
        table: PROJECTION_TABLE,
        field: "source_facts_json",
        version: version.version,
        recordId,
      });
      const sourceFacts = coreProjectionSourceFactsSchema.safeParse(factsSerialized);
      if (!sourceFacts.success) {
        return Result.err(
          corrupt({
            table: PROJECTION_TABLE,
            field: "source_facts_json",
            version: version.version,
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
          canonicalMessages,
          sourceFacts: sourceFacts.data,
          createdAt: row.data.created_ts,
        },
        provenance: version.provenance,
      });
    }),
  );
}

export function decodeCoreLineageManifestRow(input: {
  readonly row: PersistedCoreLineageManifestRow;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<CoreStoredLineageManifestV2>, PersistedDataError>;
export function decodeCoreLineageManifestRow(input: {
  readonly row: null;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<null>, PersistedDataError>;
export function decodeCoreLineageManifestRow(input: {
  readonly row: PersistedCoreLineageManifestRow | null;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<CoreStoredLineageManifestV2 | null>, PersistedDataError> {
  return adaptTranscriptPersistenceDecodeResult(
    Result.gen(function* () {
      if (input.row === null)
        return Result.ok<DecodedPersistedValue<CoreStoredLineageManifestV2 | null>>({
          value: null,
          provenance: "missing-defaulted",
        });
      const recordId =
        typeof input.row.request_id === "string" ? input.row.request_id : "unknown-record";
      const version = yield* decodeSchemaVersion(input.schemaVersion, LINEAGE_TABLE, recordId);
      if (input.row.lineage_version !== 2 || typeof input.row.manifest_json !== "string") {
        return Result.err(
          corrupt({
            table: LINEAGE_TABLE,
            field: "row",
            version: version.version,
            issueCode: "invalid-lineage-manifest",
            recordId,
          }),
        );
      }
      const serialized = yield* decodeSerialized({
        raw: input.row.manifest_json,
        table: LINEAGE_TABLE,
        field: "manifest_json",
        version: version.version,
        recordId,
      });
      const parsed = coreLineageManifestV2Schema.safeParse(serialized);
      if (!parsed.success) {
        return Result.err(
          corrupt({
            table: LINEAGE_TABLE,
            field: "manifest_json",
            version: version.version,
            issueCode: "invalid-lineage-manifest",
            recordId,
          }),
        );
      }
      const segments: CoreStoredLineageSegmentV2[] = [];
      for (const segment of parsed.data.segments) {
        const canonicalMessages = yield* decodeNormalizedMessagesValue(segment.canonicalMessages, {
          table: LINEAGE_TABLE,
          field: "manifest_json",
          version: version.version,
          recordId,
        });
        segments.push({ ...segment, canonicalMessages });
      }
      const decodedManifest: CoreStoredLineageManifestV2 = { ...parsed.data, segments };
      const canonicalMessages = decodedManifest.segments.flatMap(
        (segment) => segment.canonicalMessages,
      );
      const lineage = yield* decodeCorePrimaryLineageV2(
        decodedManifest,
        canonicalMessages,
      ).mapError(() =>
        corrupt({
          table: LINEAGE_TABLE,
          field: "manifest_json",
          version: version.version,
          issueCode: "invalid-lineage-manifest",
          recordId,
        }),
      );
      if (lineage.state !== "complete") {
        return Result.err(
          corrupt({
            table: LINEAGE_TABLE,
            field: "manifest_json",
            version: version.version,
            issueCode: "invalid-lineage-manifest",
            recordId,
          }),
        );
      }
      return Result.ok({ value: decodedManifest, provenance: version.provenance });
    }),
  );
}

const fixtureMessages = '[{"role":"assistant","content":"fixture"}]';
const fixtureDigest = "93c6db2d3011fde9a57ceeace848a7457cd75442c516f82a7d966f60553b9614";
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

const fixtureRecentAgentWriteRow = {
  request_id: "fixture",
  platform: "discord",
  channel_id: "session",
  message_id: "message",
  updated_ts: 2,
  final_text: "fixture",
} as const satisfies PersistedRecentAgentWriteRow;

const fixtureSurfaceMessageLinkRow = {
  request_id: "fixture",
  platform: "discord",
  channel_id: "session",
  message_id: "message",
} as const satisfies PersistedSurfaceMessageLinkRow;

export const surfaceMessageLinkRowCodecCases = {
  current: {
    input: { row: fixtureSurfaceMessageLinkRow, schemaVersion: 6, recordId: "current" },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: { row: fixtureSurfaceMessageLinkRow, schemaVersion: 1, recordId: "legacy" },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { row: null, schemaVersion: 6, recordId: "missing" },
    outcome: "error",
  },
  "unsupported-version": {
    input: { row: fixtureSurfaceMessageLinkRow, schemaVersion: 7, recordId: "unsupported" },
    outcome: "error",
  },
  "malformed-serialization": {
    input: {
      row: { ...fixtureSurfaceMessageLinkRow, request_id: 1 },
      schemaVersion: 6,
      recordId: "malformed",
    },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      row: { ...fixtureSurfaceMessageLinkRow, platform: "future" },
      schemaVersion: 6,
      recordId: "corrupt",
    },
    outcome: "error",
  },
} as const;

export const recentAgentWriteRowCodecCases = {
  current: {
    input: { row: fixtureRecentAgentWriteRow, schemaVersion: 6, recordId: "current" },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: { row: fixtureRecentAgentWriteRow, schemaVersion: 1, recordId: "legacy" },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { row: null, schemaVersion: 6, recordId: "missing" },
    outcome: "error",
  },
  "unsupported-version": {
    input: { row: fixtureRecentAgentWriteRow, schemaVersion: 7, recordId: "unsupported" },
    outcome: "error",
  },
  "malformed-serialization": {
    input: {
      row: { ...fixtureRecentAgentWriteRow, updated_ts: "{" },
      schemaVersion: 6,
      recordId: "malformed",
    },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      row: { ...fixtureRecentAgentWriteRow, platform: "future" },
      schemaVersion: 6,
      recordId: "corrupt",
    },
    outcome: "error",
  },
} as const;

const fixtureDiscoveryRecordRow = {
  request_id: "fixture",
  session_id: "session",
  request_client: "slack",
  updated_ts: 2,
  final_text: "fixture",
  surface_platform: "github",
  surface_channel_id: "owner/repo#1",
  surface_message_id: "1",
  surface_created_ts: 1,
} as const satisfies PersistedDiscoveryRecordRow;

export const discoveryRecordRowCodecCases = {
  current: {
    input: { row: fixtureDiscoveryRecordRow, schemaVersion: 6, recordId: "current" },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: { row: fixtureDiscoveryRecordRow, schemaVersion: 1, recordId: "legacy" },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { row: null, schemaVersion: 6, recordId: "missing" },
    outcome: "error",
  },
  "unsupported-version": {
    input: { row: fixtureDiscoveryRecordRow, schemaVersion: 7, recordId: "unsupported" },
    outcome: "error",
  },
  "malformed-serialization": {
    input: {
      row: { ...fixtureDiscoveryRecordRow, updated_ts: "{" },
      schemaVersion: 6,
      recordId: "malformed",
    },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      row: { ...fixtureDiscoveryRecordRow, surface_message_id: null },
      schemaVersion: 6,
      recordId: "corrupt",
    },
    outcome: "error",
  },
} as const;

export const transcriptCompactionContextCodecCases = {
  current: {
    input: {
      raw: '{"type":"compaction","formatVersion":1}',
      schemaVersion: 6,
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
    input: { raw: null, schemaVersion: 6, recordId: "missing" },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: { raw: null, schemaVersion: 7, recordId: "unsupported" },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { raw: "{", schemaVersion: 6, recordId: "malformed" },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      raw: '{"type":"compaction","formatVersion":2}',
      schemaVersion: 6,
      recordId: "corrupt",
    },
    outcome: "error",
  },
} as const;

export const transcriptProviderStateCodecCases = {
  current: {
    input: {
      raw: '{"lastFamily":"ai-sdk","containsCrossFamilyTurns":false}',
      schemaVersion: 6,
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
    input: { raw: null, schemaVersion: 6, recordId: "missing" },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: { raw: null, schemaVersion: 7, recordId: "unsupported" },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { raw: "{", schemaVersion: 6, recordId: "malformed" },
    outcome: "error",
  },
  "corrupt-fields": {
    input: { raw: '{"lastFamily":"future"}', schemaVersion: 6, recordId: "corrupt" },
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
      schemaVersion: 6,
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
    input: { row: fixtureTranscriptRow, schemaVersion: 6 },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: { row: fixtureTranscriptRow, schemaVersion: 7 },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { row: { ...fixtureTranscriptRow, messages_json: "{" }, schemaVersion: 6 },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      row: { ...fixtureTranscriptRow, transcript_digest: "00".repeat(32) },
      schemaVersion: 6,
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
  canonical_hash_version: 2,
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
      schemaVersion: 6,
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
      schemaVersion: 6,
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
    input: { row: fixtureProjectionRow, schemaVersion: 6 },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: { row: fixtureProjectionRow, schemaVersion: 2 },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { row: null, schemaVersion: 6 },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: { row: fixtureProjectionRow, schemaVersion: 7 },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { row: { ...fixtureProjectionRow, source_facts_json: "{" }, schemaVersion: 6 },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      row: {
        ...fixtureProjectionRow,
        source_facts_json: '{"bad":null,"nested":{"bad":null}}',
        projection_format_version: 2,
      },
      schemaVersion: 6,
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
  lineageVersion: 2,
  currentCanonicalStart: 0,
  segments: [
    {
      atoms: [fixtureLineageAtom],
      canonicalMessages: [{ role: "assistant", content: "fixture" }],
      canonicalStart: 0,
      canonicalEnd: 1,
      cumulativeAtomCount: 1,
      cumulativePrefixDigest: computeCoreLineagePrefixDigestV2([fixtureLineageAtom]),
    },
  ],
} as const;
const fixtureLineageRow = {
  request_id: "fixture",
  lineage_version: 2,
  manifest_json: JSON.stringify(fixtureManifest),
} as const;

export const coreLineageManifestRowCodecCases = {
  current: {
    input: { row: fixtureLineageRow, schemaVersion: 6 },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: { row: fixtureLineageRow, schemaVersion: 2 },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { row: null, schemaVersion: 6 },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": { input: { row: fixtureLineageRow, schemaVersion: 7 }, outcome: "error" },
  "malformed-serialization": {
    input: { row: { ...fixtureLineageRow, manifest_json: "{" }, schemaVersion: 6 },
    outcome: "error",
  },
  "corrupt-fields": {
    input: { row: { ...fixtureLineageRow, manifest_json: "{}" }, schemaVersion: 6 },
    outcome: "error",
  },
} as const;
