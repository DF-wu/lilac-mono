import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import JSON from "superjson";
import type { ModelMessage } from "ai";
import {
  hashCanonicalMessagesV1,
  type HistoryProviderFamily,
  type HistoryProviderState,
} from "@stanley2058/lilac-agent";
import {
  computeCoreLineagePrefixDigestV1,
  decodeCorePrimaryLineageV1,
  type AdapterPlatform,
  type CoreLineageAtomV1,
  type CoreLineageManifestV1,
} from "@stanley2058/lilac-event-bus";
import {
  classifyBunSqliteError,
  createLogger,
  CorruptPersistedFields,
  normalizeReplayMessages,
  runBunSqliteTransaction,
  type DecodedPersistedValue,
  type PersistedDataError,
  type PersistedDataIssueCode,
} from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import type { MsgRef } from "../surface/types";
import { projectBuiltinSurfaceMessageRef } from "../surface/builtin-surface-protocols";
import { adaptToolResultToHost } from "../tools/tool-result-adapters";
import {
  decodeCoreLineageManifestRow as decodePersistedCoreLineageManifestRow,
  decodeCoreSurfaceProjectionRow as decodePersistedCoreSurfaceProjectionRow,
  decodeDiscoveryRecordRow as decodePersistedDiscoveryRecordRow,
  decodeRecentAgentWriteRow as decodePersistedRecentAgentWriteRow,
  decodeSurfaceMessageLinkRow as decodePersistedSurfaceMessageLinkRow,
  decodeTranscriptCompactionContext as decodePersistedTranscriptCompactionContext,
  decodeTranscriptMessages,
  decodeTranscriptProviderState as decodePersistedTranscriptProviderState,
  decodeTranscriptRow as decodePersistedTranscriptRow,
  TRANSCRIPT_PERSISTENCE_SCHEMA_VERSION,
  type CompactionCheckpointMeta as PersistedCompactionCheckpointMeta,
  type DecodedCoreLineageManifestV1,
  type DecodedCoreNamedClaudeAttemptRow,
  type DecodedCoreNamedClaudeBindingRow,
  type DecodedCoreOwnedBlobRow,
  type DecodedCorePrimaryClaudeAttemptRow,
  type DecodedCorePrimaryClaudeBindingRow,
  type DecodedCoreSurfaceProjectionRow,
  type DecodedDiscoveryRecordRow,
  type DecodedRecentAgentWriteRow,
  type DecodedSurfaceMessageLinkRow,
  type DecodedTranscriptBlobMetricsRow,
  type DecodedTranscriptCountRow,
  type DecodedTranscriptForeignKeyFailureRow,
  type DecodedTranscriptMigrationVersionRow,
  type DecodedTranscriptRow,
  type PersistedCoreLineageManifestRow,
  type PersistedCoreSurfaceProjectionRow,
  type PersistedDiscoveryRecordRow,
  type PersistedRecentAgentWriteRow,
  type PersistedSurfaceMessageLinkRow,
  type PersistedTranscriptRow,
  type TranscriptStorePersistedRowKind,
} from "./transcript-persistence-codec";

const logger = createLogger({ module: "transcript-store" });
const TRANSCRIPT_SCHEMA_VERSION = TRANSCRIPT_PERSISTENCE_SCHEMA_VERSION;
const CORE_NAMED_CLAUDE_ATTEMPT_RETENTION_LIMIT = 32;
const CORE_NAMED_CLAUDE_ACTIVE_ATTEMPT_LIMIT = 8;
const CORE_PRIMARY_CLAUDE_ATTEMPT_RETENTION_LIMIT = 32;
const CORE_PRIMARY_CLAUDE_ACTIVE_ATTEMPT_LIMIT = 8;
const MAX_DEFERRED_TRANSCRIPT_EVENTS = 128;

function decodeTranscriptCompactionContext(
  input: Parameters<typeof decodePersistedTranscriptCompactionContext>[0],
) {
  return decodePersistedTranscriptCompactionContext(input);
}

function decodeTranscriptProviderState(
  input: Parameters<typeof decodePersistedTranscriptProviderState>[0],
) {
  return decodePersistedTranscriptProviderState(input);
}

function decodeRecentAgentWriteRow(
  input: Parameters<typeof decodePersistedRecentAgentWriteRow>[0],
): ResultType<DecodedPersistedValue<DecodedRecentAgentWriteRow>, PersistedDataError> {
  return decodePersistedRecentAgentWriteRow(input);
}

function decodeSurfaceMessageLinkRow(
  input: Parameters<typeof decodePersistedSurfaceMessageLinkRow>[0],
): ResultType<DecodedPersistedValue<DecodedSurfaceMessageLinkRow>, PersistedDataError> {
  return decodePersistedSurfaceMessageLinkRow(input);
}

function decodeDiscoveryRecordRow(
  input: Parameters<typeof decodePersistedDiscoveryRecordRow>[0],
): ResultType<DecodedPersistedValue<DecodedDiscoveryRecordRow>, PersistedDataError> {
  return decodePersistedDiscoveryRecordRow(input);
}

type TranscriptStoreRowOutputMap = {
  readonly "migration-version": DecodedTranscriptMigrationVersionRow;
  readonly "foreign-key-failure": DecodedTranscriptForeignKeyFailureRow;
  readonly count: DecodedTranscriptCountRow;
  readonly "blob-metrics": DecodedTranscriptBlobMetricsRow;
  readonly "owned-blob": DecodedCoreOwnedBlobRow;
  readonly "named-binding": DecodedCoreNamedClaudeBindingRow;
  readonly "named-attempt": DecodedCoreNamedClaudeAttemptRow;
  readonly "primary-binding": DecodedCorePrimaryClaudeBindingRow;
  readonly "primary-attempt": DecodedCorePrimaryClaudeAttemptRow;
};

function decodeTranscriptRow(input: {
  readonly row: PersistedTranscriptRow;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<DecodedTranscriptRow>, PersistedDataError>;
function decodeTranscriptRow<TKind extends TranscriptStorePersistedRowKind>(input: {
  readonly storeKind: TKind;
  readonly row: object | null;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<TranscriptStoreRowOutputMap[TKind]>, PersistedDataError>;
function decodeTranscriptRow(
  input:
    | { readonly row: PersistedTranscriptRow; readonly schemaVersion: number }
    | {
        readonly storeKind: TranscriptStorePersistedRowKind;
        readonly row: object | null;
        readonly schemaVersion: number;
        readonly recordId: string;
      },
): ResultType<
  DecodedPersistedValue<
    DecodedTranscriptRow | TranscriptStoreRowOutputMap[TranscriptStorePersistedRowKind]
  >,
  PersistedDataError
> {
  return decodePersistedTranscriptRow(input as never);
}

function decodeCoreSurfaceProjectionRow(input: {
  readonly row: PersistedCoreSurfaceProjectionRow;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<DecodedCoreSurfaceProjectionRow>, PersistedDataError>;
function decodeCoreSurfaceProjectionRow(input: {
  readonly row: null;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<null>, PersistedDataError>;
function decodeCoreSurfaceProjectionRow(input: {
  readonly row: PersistedCoreSurfaceProjectionRow | null;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<DecodedCoreSurfaceProjectionRow | null>, PersistedDataError> {
  return input.row === null
    ? decodePersistedCoreSurfaceProjectionRow({ ...input, row: null })
    : decodePersistedCoreSurfaceProjectionRow({ ...input, row: input.row });
}

function decodeCoreLineageManifestRow(input: {
  readonly row: PersistedCoreLineageManifestRow;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<DecodedCoreLineageManifestV1>, PersistedDataError>;
function decodeCoreLineageManifestRow(input: {
  readonly row: null;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<null>, PersistedDataError>;
function decodeCoreLineageManifestRow(input: {
  readonly row: PersistedCoreLineageManifestRow | null;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<DecodedCoreLineageManifestV1 | null>, PersistedDataError> {
  return input.row === null
    ? decodePersistedCoreLineageManifestRow({ ...input, row: null })
    : decodePersistedCoreLineageManifestRow({ ...input, row: input.row });
}

export const CORE_SURFACE_PROJECTION_FORMAT_VERSION = 1 as const;
export const CORE_TRANSCRIPT_DIGEST_VERSION = 1 as const;
export type CoreProjectionSourceFact =
  | null
  | boolean
  | number
  | string
  | CoreProjectionSourceFact[]
  | { [key: string]: CoreProjectionSourceFact };

type TranscriptRow = {
  request_id: string;
  session_id: string;
  request_client: string;
  created_ts: number;
  updated_ts: number;
  model_label: string | null;
  final_text: string | null;
  messages_json: string;
  context_meta_json: string | null;
  provider_state_json: string | null;
  stable_named_request_client: string | null;
  transcript_digest: string | null;
};

type CoreOwnedBlobRow = {
  sha256: string;
  media_type: string;
  filename: string;
  byte_length: number;
  bytes: Uint8Array;
  created_ts: number;
};

type CoreSurfaceProjectionRow = {
  request_client: string;
  surface_id: string;
  session_id: string;
  message_id: string;
  projection_format_version: number;
  canonical_messages_json: string;
  source_facts_json: string;
  created_ts: number;
};

type CoreNamedClaudeBindingRow = {
  request_client: string;
  session_id: string;
  provider_id: string;
  binding_protocol_version: number;
  provider_family: string;
  terminal_request_id: string;
  canonical_hash_version: number;
  canonical_head_hash: string;
  canonical_message_count: number;
  execution_scope_hash_version: number;
  execution_scope_hash: string;
  claude_session_id: string;
  native_cwd: string;
  native_last_modified: number;
  native_context_tokens: number;
  native_context_max_tokens: number;
  last_model_specifier: string;
  last_reasoning: string;
  revision: number;
  updated_ts: number;
};

type CoreNamedClaudeAttemptRow = {
  product: string;
  request_client: string;
  session_id: string;
  provider_id: string;
  source_terminal_request_id: string | null;
  source_canonical_head_hash: string | null;
  source_canonical_message_count: number | null;
  execution_scope_hash_version: number;
  execution_scope_hash: string;
  request_id: string;
  attempt_index: number;
  candidate_session_id: string;
  source_session_id: string | null;
  expected_binding_revision: number | null;
  state: string;
  terminal_request_id: string | null;
  terminal_canonical_head_hash: string | null;
  terminal_canonical_message_count: number | null;
  native_cwd: string | null;
  native_last_modified: number | null;
  native_context_tokens: number | null;
  native_context_max_tokens: number | null;
  last_model_specifier: string | null;
  last_reasoning: string | null;
  created_ts: number;
  updated_ts: number;
};

type CorePrimaryClaudeBindingRow = {
  request_client: string;
  session_id: string;
  provider_id: string;
  binding_protocol_version: number;
  provider_family: string;
  terminal_request_id: string | null;
  lineage_version: number;
  atom_count: number;
  prefix_digest: string;
  canonical_message_count: number;
  execution_scope_hash_version: number;
  execution_scope_hash: string;
  claude_session_id: string;
  native_cwd: string;
  native_last_modified: number;
  native_context_tokens: number;
  native_context_max_tokens: number;
  last_model_specifier: string;
  last_reasoning: string;
  revision: number;
  updated_ts: number;
};

type CorePrimaryClaudeAttemptRow = {
  product: string;
  request_client: string;
  session_id: string;
  provider_id: string;
  source_lineage_version: number | null;
  source_atom_count: number | null;
  source_prefix_digest: string | null;
  source_canonical_message_count: number | null;
  execution_scope_hash_version: number;
  execution_scope_hash: string;
  request_id: string;
  attempt_index: number;
  candidate_session_id: string;
  source_session_id: string | null;
  expected_binding_revision: number | null;
  state: string;
  terminal_request_id: string | null;
  terminal_lineage_version: number | null;
  terminal_atom_count: number | null;
  terminal_prefix_digest: string | null;
  terminal_canonical_message_count: number | null;
  native_cwd: string | null;
  native_last_modified: number | null;
  native_context_tokens: number | null;
  native_context_max_tokens: number | null;
  last_model_specifier: string | null;
  last_reasoning: string | null;
  created_ts: number;
  updated_ts: number;
};

export const COMPACTION_CHECKPOINT_FORMAT_VERSION = 1 as const;

export type CompactionCheckpointMeta = PersistedCompactionCheckpointMeta;

export type TranscriptSnapshot = {
  requestId: string;
  sessionId: string;
  requestClient: AdapterPlatform;
  createdTs: number;
  updatedTs: number;
  messages: ModelMessage[];
  finalText?: string;
  modelLabel?: string;
  contextMeta?: CompactionCheckpointMeta;
  providerState?: HistoryProviderState | null;
  stableNamedRequestClient?: AdapterPlatform;
  canonicalHashVersion?: typeof CORE_TRANSCRIPT_DIGEST_VERSION;
  transcriptDigest?: string;
};

export type CoreOwnedBlobReference = {
  readonly sha256: string;
  readonly mediaType: string;
  readonly filename: string;
  readonly byteLength: number;
};

export type CoreOwnedBlob = CoreOwnedBlobReference & {
  readonly bytes: Uint8Array;
  readonly createdAt: number;
};

export type CoreSurfaceProjectionKey = {
  readonly requestClient: AdapterPlatform;
  readonly surfaceId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly projectionFormatVersion: typeof CORE_SURFACE_PROJECTION_FORMAT_VERSION;
};

export type CoreSurfaceProjection = CoreSurfaceProjectionKey & {
  readonly canonicalMessages: readonly ModelMessage[];
  readonly sourceFacts: Readonly<Record<string, CoreProjectionSourceFact>>;
  readonly ownedBlobs: readonly CoreOwnedBlobReference[];
  readonly createdAt: number;
};

export type AdmitCoreSurfaceProjection = CoreSurfaceProjectionKey & {
  readonly canonicalMessages: readonly ModelMessage[];
  readonly sourceFacts: Readonly<Record<string, CoreProjectionSourceFact>>;
  readonly ownedBlobs: readonly CoreOwnedBlobReference[];
};

export type CoreRequestAtomMetadata = {
  readonly requestId: string;
  readonly transcriptDigest: string;
  readonly providerFamily: HistoryProviderFamily;
  readonly containsCrossFamilyTurns: boolean;
};

export type CoreStoredSurfaceSegment = {
  readonly requestId: string;
  readonly segmentIndex: number;
  readonly messageIds: readonly string[];
  readonly canonicalMessages: readonly ModelMessage[];
};

export class CoreOwnedBlobIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreOwnedBlobIntegrityError";
  }
}

export type CoreNamedClaudeSessionBinding = {
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

export type CoreNamedClaudeSessionAttempt = {
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
  readonly state: "active" | "succeeded" | "failed" | "cancelled" | "uncertain";
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

export type CorePrimaryClaudeSessionBinding = {
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

export type CoreRetentionDiagnostics = {
  readonly namedBindingCount: number;
  readonly primaryBindingCount: number;
  readonly activeAttemptCount: number;
  readonly terminalAttemptCount: number;
  readonly unverifiablePrimaryBindingCount: number;
  readonly orphanSucceededAttemptCount: number;
  readonly orphanManifestCount: number;
  readonly unreferencedProjectionCount: number;
  readonly ownedBlobBytes: number;
  readonly unreferencedOwnedBlobCount: number;
  readonly unreferencedOwnedBlobBytes: number;
};

export type TranscriptStoreLifecycleDiagnostic = (
  level: "debug" | "info" | "warn",
  event: string,
  detail: Readonly<Record<string, unknown>>,
) => void;

export type TranscriptStorePersistenceDiagnostic = {
  readonly table: string;
  readonly field: string;
  readonly version: number;
  readonly issueCode: PersistedDataIssueCode;
  readonly recordId: string;
};

export class TranscriptStoreSqliteDriverFailure extends TaggedError(
  "TranscriptStoreSqliteDriverFailure",
)<{
  readonly operation: string;
  readonly code: string;
  readonly message: string;
}> {}

export type TranscriptStoreReadError = PersistedDataError | TranscriptStoreSqliteDriverFailure;

export class CoreClaudeBindingCorrupt extends TaggedError("CoreClaudeBindingCorrupt")<{
  readonly bindingKind: "named" | "primary";
  readonly providerId: string;
  readonly requestClient: AdapterPlatform;
  readonly lilacSessionId: string;
  readonly message: string;
}> {}

export type CoreClaudeBindingReadError =
  | CoreClaudeBindingCorrupt
  | TranscriptStoreSqliteDriverFailure;

export class TranscriptRetainedByLineage extends TaggedError("TranscriptRetainedByLineage")<{
  readonly requestId: string;
  readonly message: string;
}> {}

type TranscriptTransactionOperation =
  | "save-request-transcript"
  | "admit-core-surface-projection"
  | "save-core-primary-lineage-manifest"
  | "publish-core-named-claude-success"
  | "publish-core-primary-claude-success";

type TranscriptTransactionConflictReason =
  | "attempt-not-found"
  | "attempt-not-retained"
  | "attempt-terminal"
  | "lineage-immutable"
  | "lineage-invalid"
  | "projection-not-retained"
  | "publication-fence-lost"
  | "publication-verification-failed"
  | "terminal-request-mismatch"
  | "transcript-not-found";

export class TranscriptTransactionConflict extends TaggedError("TranscriptTransactionConflict")<{
  readonly operation: TranscriptTransactionOperation;
  readonly reason: TranscriptTransactionConflictReason;
  readonly message: string;
}> {}

class TranscriptTransactionPersistenceFailure extends TaggedError(
  "TranscriptTransactionPersistenceFailure",
)<{
  readonly error: PersistedDataError;
  readonly diagnostics: readonly [TranscriptStorePersistenceDiagnostic];
}> {}

type DeferredTranscriptEvent =
  | {
      readonly kind: "persistence-diagnostic";
      readonly diagnostic: TranscriptStorePersistenceDiagnostic;
    }
  | {
      readonly kind: "log";
      readonly event: string;
      readonly detail: Readonly<Record<string, unknown>>;
    };

type PreparedCorePrimaryLineageManifest = {
  readonly requestId: string;
  readonly manifest: CoreLineageManifestV1;
  readonly manifestJson: string;
  readonly createdAt: number;
  readonly requestClient: AdapterPlatform;
  readonly sessionId: string;
  readonly existingManifestJson: string | null;
};

type PreparedCorePrimaryLineageRead = {
  readonly manifest: CoreLineageManifestV1;
  readonly manifestJson: string;
};

type CoreSurfaceProjectionAdmissionOutcome =
  | { readonly kind: "existing" }
  | { readonly kind: "inserted"; readonly projection: CoreSurfaceProjection };

type ClaudePublicationOutcome<TAttempt> = {
  readonly attempt: TAttempt;
  readonly events: readonly DeferredTranscriptEvent[];
};

export type TranscriptStoreWriteError =
  | TranscriptStoreReadError
  | TranscriptRetainedByLineage
  | CoreOwnedBlobIntegrityError
  | TranscriptTransactionConflict;

export type CoreClaudeAttemptMutationError =
  | CoreClaudeBindingCorrupt
  | TranscriptTransactionConflict
  | TranscriptStoreSqliteDriverFailure;

function coreClaudeAttemptMutationErrorTag(error: CoreClaudeAttemptMutationError): string {
  switch (error._tag) {
    case "CoreClaudeBindingCorrupt":
    case "TranscriptTransactionConflict":
    case "TranscriptStoreSqliteDriverFailure":
      return error._tag;
  }
}

function transactionConflict(
  operation: TranscriptTransactionOperation,
  reason: TranscriptTransactionConflictReason,
  message: string,
): TranscriptTransactionConflict {
  return new TranscriptTransactionConflict({ operation, reason, message });
}

function toTranscriptPersistenceDiagnostic(
  error: PersistedDataError,
): TranscriptStorePersistenceDiagnostic {
  return {
    table: error.table,
    field: error.field,
    version: error.version,
    issueCode: error.issueCode,
    recordId: error.recordId.slice(0, 160),
  };
}

function deferTranscriptPersistenceFailure(
  error: PersistedDataError,
): TranscriptTransactionPersistenceFailure {
  return new TranscriptTransactionPersistenceFailure({
    error,
    diagnostics: [toTranscriptPersistenceDiagnostic(error)],
  });
}

function appendDeferredTranscriptEvent(
  events: DeferredTranscriptEvent[],
  event: DeferredTranscriptEvent,
): void {
  if (events.length < MAX_DEFERRED_TRANSCRIPT_EVENTS) events.push(event);
}

function classifyTranscriptSqliteDriverFailure(
  operation: string,
  cause: Error,
): TranscriptStoreSqliteDriverFailure | undefined {
  const sqliteError = classifyBunSqliteError(cause);
  if (sqliteError === undefined) return undefined;
  return new TranscriptStoreSqliteDriverFailure({
    operation,
    code: sqliteError.code,
    message: "Transcript SQLite operation failed",
  });
}

export type CorePrimaryClaudeSessionAttempt = {
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
  readonly state: "active" | "succeeded" | "failed" | "cancelled" | "uncertain";
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

export type ReserveCorePrimaryClaudeSessionAttempt = {
  readonly providerId: string;
  readonly requestClient: "discord";
  readonly lilacSessionId: string;
  readonly executionScopeHashVersion: 1;
  readonly executionScopeHash: string;
  readonly requestId: string;
  readonly attemptIndex: number;
  readonly candidateSessionId: string;
  readonly sourceSessionId: string | null;
  readonly expectedBindingRevision: number | null;
};

export type RecordCorePrimaryClaudeSessionAttemptOutcome = {
  readonly providerId: string;
  readonly requestClient: "discord";
  readonly lilacSessionId: string;
  readonly requestId: string;
  readonly attemptIndex: number;
  readonly state: "failed" | "cancelled" | "uncertain";
};

export type PublishCorePrimaryClaudeSuccess = {
  readonly providerId: string;
  readonly requestClient: "discord";
  readonly lilacSessionId: string;
  readonly requestId: string;
  readonly attemptIndex: number;
  readonly terminalRequestId: string;
  readonly terminalLineageVersion: 1;
  readonly terminalAtomCount: number;
  readonly terminalPrefixDigest: string;
  readonly terminalCanonicalMessageCount: number;
  readonly providerState: HistoryProviderState;
  readonly nativeCwd: string;
  readonly nativeLastModified: number;
  readonly nativeContextTokens: number;
  readonly nativeContextMaxTokens: number;
  readonly lastModelSpecifier: string;
  readonly lastReasoning: string;
};

export type CorePrimaryClaudeBindingHead = {
  readonly lineageVersion: 1;
  readonly atomCount: number;
  readonly prefixDigest: string;
  readonly canonicalMessageCount: number;
};

export function computeCorePrimaryClaudeTerminalHead(input: {
  readonly manifest: CoreLineageManifestV1;
  readonly requestId: string;
  readonly transcriptDigest: string;
  readonly responseMessageCount: number;
  readonly providerState: HistoryProviderState;
}): ResultType<CorePrimaryClaudeBindingHead, TranscriptTransactionConflict> {
  const lastSegment = input.manifest.segments[input.manifest.segments.length - 1];
  if (
    !lastSegment ||
    input.responseMessageCount <= 0 ||
    !input.requestId ||
    !/^[0-9a-f]{64}$/u.test(input.transcriptDigest)
  ) {
    return Result.err(
      transactionConflict(
        "publish-core-primary-claude-success",
        "lineage-invalid",
        "Core primary terminal head requires a valid complete manifest and response",
      ),
    );
  }
  const requestAtom: CoreLineageAtomV1 = {
    kind: "request",
    requestId: input.requestId,
    transcriptDigest: input.transcriptDigest,
    providerFamily: input.providerState.lastFamily,
    containsCrossFamilyTurns: input.providerState.containsCrossFamilyTurns,
  };
  const atomCount = lastSegment.cumulativeAtomCount + 1;
  return Result.ok({
    lineageVersion: 1,
    atomCount,
    prefixDigest: computeCoreLineagePrefixDigestV1([
      ...input.manifest.segments.flatMap((segment) => segment.atoms),
      requestAtom,
    ]),
    canonicalMessageCount: lastSegment.canonicalEnd + input.responseMessageCount,
  });
}

export type ReserveCoreNamedClaudeSessionAttempt = {
  readonly providerId: string;
  readonly requestClient: AdapterPlatform;
  readonly lilacSessionId: string;
  readonly executionScopeHashVersion: 1;
  readonly executionScopeHash: string;
  readonly requestId: string;
  readonly attemptIndex: number;
  readonly candidateSessionId: string;
  readonly sourceSessionId: string | null;
  readonly expectedBindingRevision: number | null;
};

export type RecordCoreNamedClaudeSessionAttemptOutcome = {
  readonly providerId: string;
  readonly requestClient: AdapterPlatform;
  readonly lilacSessionId: string;
  readonly requestId: string;
  readonly attemptIndex: number;
  readonly state: "failed" | "cancelled" | "uncertain";
};

export type PublishCoreNamedClaudeSuccess = {
  readonly providerId: string;
  readonly requestClient: AdapterPlatform;
  readonly lilacSessionId: string;
  readonly requestId: string;
  readonly attemptIndex: number;
  readonly terminalRequestId: string;
  readonly terminalCanonicalHeadHash: string;
  readonly terminalCanonicalMessageCount: number;
  readonly providerState: HistoryProviderState;
  readonly nativeCwd: string;
  readonly nativeLastModified: number;
  readonly nativeContextTokens: number;
  readonly nativeContextMaxTokens: number;
  readonly lastModelSpecifier: string;
  readonly lastReasoning: string;
};

export type UnlinkSurfaceMessageResult = {
  requestId?: string;
  checkpointDeleted: boolean;
};

export type RecentAgentWriteSnapshot = {
  requestId: string;
  sessionId: string;
  client: AdapterPlatform;
  messageId: string;
  updatedTs: number;
  finalText?: string;
};

export type TranscriptDiscoveryRecord = {
  requestId: string;
  sessionId: string;
  requestClient: AdapterPlatform;
  updatedTs: number;
  finalText?: string;
  surfaceRefs: MsgRef[];
};

export type TranscriptStore = {
  saveRequestTranscript(input: {
    requestId: string;
    sessionId: string;
    requestClient: AdapterPlatform;
    messages: readonly ModelMessage[];
    finalText?: string;
    modelLabel?: string;
    contextMeta?: CompactionCheckpointMeta;
    providerState?: HistoryProviderState;
    stableNamedRequestClient?: AdapterPlatform;
    corePrimaryLineage?: CoreLineageManifestV1;
  }): ResultType<void, TranscriptStoreWriteError>;

  putCoreOwnedBlob?(input: {
    bytes: Uint8Array;
    mediaType: string;
    filename: string;
  }): ResultType<CoreOwnedBlob, CoreOwnedBlobIntegrityError>;

  getCoreOwnedBlob?(input: {
    sha256: string;
  }): ResultType<CoreOwnedBlob, CoreOwnedBlobIntegrityError>;

  deleteCoreOwnedBlobIfUnreferenced?(input: { sha256: string }): boolean;

  admitCoreSurfaceProjection?(
    input: AdmitCoreSurfaceProjection,
  ): ResultType<
    CoreSurfaceProjection,
    TranscriptStoreReadError | CoreOwnedBlobIntegrityError | TranscriptTransactionConflict
  >;

  getCoreSurfaceProjection?(
    input: CoreSurfaceProjectionKey,
  ): ResultType<
    CoreSurfaceProjection | null,
    TranscriptStoreReadError | CoreOwnedBlobIntegrityError
  >;

  getLatestCoreSurfaceSegment?(
    input: CoreSurfaceProjectionKey,
  ): ResultType<CoreStoredSurfaceSegment | null, TranscriptStoreReadError>;

  saveCorePrimaryLineageManifest?(input: {
    requestId: string;
    manifest: CoreLineageManifestV1;
  }): ResultType<
    CoreLineageManifestV1,
    TranscriptStoreReadError | CoreOwnedBlobIntegrityError | TranscriptTransactionConflict
  >;

  getCorePrimaryLineageManifest?(input: {
    requestId: string;
  }): ResultType<CoreLineageManifestV1 | null, TranscriptStoreReadError>;

  getCoreRequestAtomMetadata?(input: {
    requestId: string;
  }): ResultType<CoreRequestAtomMetadata | null, TranscriptStoreReadError>;

  validateCorePrimaryLineageReferences?(input: {
    manifest: CoreLineageManifestV1;
    requestClient: AdapterPlatform;
    sessionId: string;
    surfaceId: string;
  }): ResultType<string | null, TranscriptStoreReadError | CoreOwnedBlobIntegrityError>;

  linkSurfaceMessagesToRequest(input: {
    requestId: string;
    created: readonly MsgRef[];
    last: MsgRef;
  }): void;

  getTranscriptBySurfaceMessage(input: {
    platform: AdapterPlatform;
    channelId: string;
    messageId: string;
  }): ResultType<TranscriptSnapshot | null, TranscriptStoreReadError>;

  unlinkSurfaceMessage?(input: {
    platform: AdapterPlatform;
    channelId: string;
    messageId: string;
  }): ResultType<UnlinkSurfaceMessageResult, TranscriptStoreReadError>;

  deleteUnlinkedCheckpointCandidate?(input: {
    requestId: string;
  }): ResultType<boolean, TranscriptStoreReadError>;

  getLatestTranscriptBySession?(input: {
    sessionId: string;
  }): ResultType<TranscriptSnapshot | null, TranscriptStoreReadError>;

  getRequestTranscript?(input: {
    requestId: string;
  }): ResultType<TranscriptSnapshot | null, TranscriptStoreReadError>;

  getLatestCompleteNamedTranscript?(input: {
    requestClient: AdapterPlatform;
    sessionId: string;
  }): ResultType<TranscriptSnapshot | null, TranscriptStoreReadError>;

  getCoreNamedClaudeSessionBinding?(input: {
    providerId: string;
    requestClient: AdapterPlatform;
    lilacSessionId: string;
  }): ResultType<CoreNamedClaudeSessionBinding | null, CoreClaudeBindingReadError>;

  getCoreNamedClaudeSessionAttempt?(input: {
    providerId: string;
    requestClient: AdapterPlatform;
    lilacSessionId: string;
    requestId: string;
    attemptIndex: number;
  }): CoreNamedClaudeSessionAttempt | null;

  reserveCoreNamedClaudeSessionAttempt?(
    input: ReserveCoreNamedClaudeSessionAttempt,
  ): ResultType<CoreNamedClaudeSessionAttempt, CoreClaudeAttemptMutationError>;

  recordCoreNamedClaudeSessionAttemptOutcome?(
    input: RecordCoreNamedClaudeSessionAttemptOutcome,
  ): ResultType<CoreNamedClaudeSessionAttempt, CoreClaudeAttemptMutationError>;

  publishCoreNamedClaudeSuccess?(
    input: PublishCoreNamedClaudeSuccess,
  ): ResultType<
    CoreNamedClaudeSessionAttempt,
    TranscriptStoreReadError | TranscriptTransactionConflict
  >;

  promoteCoreNamedClaudeSessionBinding?(input: {
    providerId: string;
    requestClient: AdapterPlatform;
    lilacSessionId: string;
    requestId: string;
    attemptIndex: number;
  }): ResultType<boolean, CoreClaudeAttemptMutationError>;

  getCorePrimaryClaudeSessionBinding?(input: {
    providerId: string;
    requestClient: "discord";
    lilacSessionId: string;
  }): ResultType<CorePrimaryClaudeSessionBinding | null, CoreClaudeBindingReadError>;

  getCorePrimaryClaudeSessionAttempt?(input: {
    providerId: string;
    requestClient: "discord";
    lilacSessionId: string;
    requestId: string;
    attemptIndex: number;
  }): CorePrimaryClaudeSessionAttempt | null;

  getCoreRetentionDiagnostics?(): ResultType<
    CoreRetentionDiagnostics,
    TranscriptTransactionConflict
  >;

  reserveCorePrimaryClaudeSessionAttempt?(
    input: ReserveCorePrimaryClaudeSessionAttempt,
  ): ResultType<CorePrimaryClaudeSessionAttempt, CoreClaudeAttemptMutationError>;

  recordCorePrimaryClaudeSessionAttemptOutcome?(
    input: RecordCorePrimaryClaudeSessionAttemptOutcome,
  ): ResultType<CorePrimaryClaudeSessionAttempt, CoreClaudeAttemptMutationError>;

  publishCorePrimaryClaudeSuccess?(
    input: PublishCorePrimaryClaudeSuccess,
  ): ResultType<
    CorePrimaryClaudeSessionAttempt,
    TranscriptStoreReadError | TranscriptTransactionConflict
  >;

  promoteCorePrimaryClaudeSessionBinding?(input: {
    providerId: string;
    requestClient: "discord";
    lilacSessionId: string;
    requestId: string;
    attemptIndex: number;
  }): ResultType<boolean, CoreClaudeAttemptMutationError>;

  listSurfaceMessagesForRequest?(input: { requestId: string }): MsgRef[];

  listRecentAgentWrites?(input?: {
    limit?: number;
    offset?: number;
    client?: AdapterPlatform;
  }): RecentAgentWriteSnapshot[];

  listDiscoveryRecords?(): TranscriptDiscoveryRecord[];

  selectSessionToolIds?(input: {
    requestClient: AdapterPlatform;
    sessionId: string;
    catalogIds: readonly string[];
  }): void;

  listSessionToolIds?(input: { requestClient: AdapterPlatform; sessionId: string }): string[];

  close(): void;
};

export class SqliteTranscriptStore implements TranscriptStore {
  private readonly db: Database;

  constructor(
    dbPath: string,
    private readonly onLifecycleDiagnostic?: TranscriptStoreLifecycleDiagnostic,
    private readonly onPersistenceDiagnostic: (
      diagnostic: TranscriptStorePersistenceDiagnostic,
    ) => void = (diagnostic) => {
      logger.warn("transcript persisted value decode failed", diagnostic);
    },
  ) {
    this.db = new Database(dbPath);
    this.migrate();
    this.recoverCoreNamedClaudeAttempts();
    this.recoverCorePrimaryClaudeAttempts();
  }

  close(): void {
    this.db.close();
  }

  private reportPersistenceError(error: PersistedDataError): void {
    this.onPersistenceDiagnostic(toTranscriptPersistenceDiagnostic(error));
  }

  private emitPersistenceDiagnosticsAfterTransaction(
    diagnostics: readonly TranscriptStorePersistenceDiagnostic[],
  ): void {
    for (const diagnostic of diagnostics) {
      const emitted = Result.try({
        try: () => this.onPersistenceDiagnostic(diagnostic),
        catch: (cause) => cause,
      });
      if (emitted.status === "error" && Panic.is(emitted.error)) {
        adaptToolResultToHost(Result.err(emitted.error));
      }
    }
  }

  private emitDeferredTranscriptEvents(events: readonly DeferredTranscriptEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
        case "persistence-diagnostic":
          this.emitPersistenceDiagnosticsAfterTransaction([event.diagnostic]);
          break;
        case "log":
          Result.try({
            try: () => logger.info(event.event, event.detail),
            catch: () => undefined,
          });
          break;
      }
    }
  }

  private finalizeTransactionPersistenceDiagnostics<T, TError>(
    result: ResultType<T, TranscriptTransactionPersistenceFailure | TError>,
  ): ResultType<T, PersistedDataError | TError> {
    if (result.status === "ok") return Result.ok(result.value);
    if (!TranscriptTransactionPersistenceFailure.is(result.error)) {
      return Result.err(result.error);
    }
    this.emitPersistenceDiagnosticsAfterTransaction(result.error.diagnostics);
    return Result.err(result.error.error);
  }

  private readFromSqlite<T>(
    operation: string,
    read: () => T,
  ): ResultType<T, TranscriptStoreSqliteDriverFailure> {
    try {
      return Result.ok(read());
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      if (!(cause instanceof Error)) throw cause;
      const failure = classifyTranscriptSqliteDriverFailure(operation, cause);
      if (failure) return Result.err(failure);
      throw cause;
    }
  }

  private migrate() {
    this.db.run("PRAGMA foreign_keys = ON");
    const migrate = this.db.transaction(() => {
      this.db.run(`
      CREATE TABLE IF NOT EXISTS request_transcripts (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request_client TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL,
        model_label TEXT,
        final_text TEXT,
        messages_json TEXT NOT NULL,
        context_meta_json TEXT,
        provider_state_json TEXT,
        stable_named_request_client TEXT,
        transcript_digest TEXT
      );
    `);

      this.db.run(`
        CREATE TABLE IF NOT EXISTS transcript_schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_ts INTEGER NOT NULL
        )
      `);
      const versionRow = decodeTranscriptRow({
        storeKind: "migration-version",
        row: this.db
          .query<DecodedTranscriptMigrationVersionRow, []>(
            "SELECT COALESCE(MAX(version), 0) AS version FROM transcript_schema_migrations",
          )
          .get(),
        schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
        recordId: "schema-version",
      });
      if (versionRow.status === "error") {
        this.reportPersistenceError(versionRow.error);
        throw new Panic({
          message: "Invalid transcript schema migration row",
          cause: versionRow.error,
        });
      }
      const version = versionRow.value.value.version;
      if (version > TRANSCRIPT_SCHEMA_VERSION) {
        throw new Error(`Unsupported transcript schema version ${version}`);
      }

      const transcriptColumns = this.db
        .query<{ name: string }, []>("PRAGMA table_info(request_transcripts)")
        .all();
      for (const column of [
        ["context_meta_json", "TEXT"],
        ["provider_state_json", "TEXT"],
        ["stable_named_request_client", "TEXT"],
        ["transcript_digest", "TEXT"],
      ] as const) {
        if (!transcriptColumns.some((entry) => entry.name === column[0])) {
          this.db.run(`ALTER TABLE request_transcripts ADD COLUMN ${column[0]} ${column[1]}`);
        }
      }

      this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_request_transcripts_session
      ON request_transcripts(session_id, updated_ts);
    `);

      this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_request_transcripts_client_session
      ON request_transcripts(request_client, session_id);
    `);

      this.db.run(`
      CREATE TABLE IF NOT EXISTS surface_message_to_request (
        platform TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        PRIMARY KEY (platform, channel_id, message_id)
      );
    `);

      this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_surface_message_to_request_request
      ON surface_message_to_request(request_id);
    `);

      this.db.run(`
      CREATE TABLE IF NOT EXISTS session_loaded_tools (
        request_client TEXT NOT NULL,
        session_id TEXT NOT NULL,
        catalog_id TEXT NOT NULL,
        selected_ts INTEGER NOT NULL,
        PRIMARY KEY (request_client, session_id, catalog_id)
      );
    `);

      this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_session_loaded_tools_session
      ON session_loaded_tools(request_client, session_id);
      `);

      this.db.run(`
        CREATE TABLE IF NOT EXISTS core_named_claude_bindings (
          request_client TEXT NOT NULL,
          session_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          binding_protocol_version INTEGER NOT NULL CHECK (binding_protocol_version = 1),
          provider_family TEXT NOT NULL CHECK (provider_family = 'claude-code'),
          terminal_request_id TEXT NOT NULL REFERENCES request_transcripts(request_id) ON DELETE CASCADE,
          canonical_hash_version INTEGER NOT NULL CHECK (canonical_hash_version = 1),
          canonical_head_hash TEXT NOT NULL,
          canonical_message_count INTEGER NOT NULL CHECK (canonical_message_count >= 0),
          execution_scope_hash_version INTEGER NOT NULL CHECK (execution_scope_hash_version = 1),
          execution_scope_hash TEXT NOT NULL,
          claude_session_id TEXT NOT NULL,
          native_cwd TEXT NOT NULL,
          native_last_modified REAL NOT NULL CHECK (native_last_modified >= 0),
          native_context_tokens INTEGER NOT NULL CHECK (native_context_tokens >= 0),
          native_context_max_tokens INTEGER NOT NULL CHECK (native_context_max_tokens > 0),
          last_model_specifier TEXT NOT NULL,
          last_reasoning TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          updated_ts INTEGER NOT NULL,
          PRIMARY KEY (request_client, session_id, provider_id)
        )
      `);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS core_named_claude_attempts (
          product TEXT NOT NULL CHECK (product = 'core-named'),
          request_client TEXT NOT NULL,
          session_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          source_terminal_request_id TEXT REFERENCES request_transcripts(request_id) ON DELETE SET NULL,
          source_canonical_head_hash TEXT,
          source_canonical_message_count INTEGER CHECK (source_canonical_message_count >= 0),
          execution_scope_hash_version INTEGER NOT NULL CHECK (execution_scope_hash_version = 1),
          execution_scope_hash TEXT NOT NULL,
          request_id TEXT NOT NULL,
          attempt_index INTEGER NOT NULL CHECK (attempt_index >= 0),
          candidate_session_id TEXT NOT NULL,
          source_session_id TEXT,
          expected_binding_revision INTEGER CHECK (expected_binding_revision > 0),
          state TEXT NOT NULL CHECK (state IN ('active', 'succeeded', 'failed', 'cancelled', 'uncertain')),
          terminal_request_id TEXT REFERENCES request_transcripts(request_id) ON DELETE CASCADE,
          terminal_canonical_head_hash TEXT,
          terminal_canonical_message_count INTEGER CHECK (terminal_canonical_message_count >= 0),
          native_cwd TEXT,
          native_last_modified REAL CHECK (native_last_modified >= 0),
          native_context_tokens INTEGER CHECK (native_context_tokens >= 0),
          native_context_max_tokens INTEGER CHECK (native_context_max_tokens > 0),
          last_model_specifier TEXT,
          last_reasoning TEXT,
          created_ts INTEGER NOT NULL,
          updated_ts INTEGER NOT NULL,
          PRIMARY KEY (request_client, session_id, provider_id, request_id, attempt_index)
        )
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_core_named_claude_attempts_owner
        ON core_named_claude_attempts(request_client, session_id, provider_id, updated_ts)
      `);

      if (version < 1) {
        this.db.run(
          "INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (?, ?)",
          [1, Date.now()],
        );
      }

      if (version < 2) {
        this.db.run(`
          CREATE TABLE core_owned_blobs (
            sha256 TEXT PRIMARY KEY
              CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
            media_type TEXT NOT NULL CHECK (length(media_type) > 0),
            filename TEXT NOT NULL CHECK (length(filename) > 0),
            byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
            bytes BLOB NOT NULL,
            created_ts INTEGER NOT NULL
          )
        `);
        this.db.run(`
          CREATE TABLE core_surface_projections (
            request_client TEXT NOT NULL,
            surface_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            projection_format_version INTEGER NOT NULL
              CHECK (projection_format_version = 1),
            canonical_messages_json TEXT NOT NULL,
            source_facts_json TEXT NOT NULL,
            created_ts INTEGER NOT NULL,
            PRIMARY KEY (
              request_client, surface_id, session_id, message_id, projection_format_version
            )
          )
        `);
        this.db.run(`
          CREATE TABLE core_surface_projection_blobs (
            request_client TEXT NOT NULL,
            surface_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            projection_format_version INTEGER NOT NULL,
            position INTEGER NOT NULL CHECK (position >= 0),
            blob_sha256 TEXT NOT NULL REFERENCES core_owned_blobs(sha256) ON DELETE RESTRICT,
            PRIMARY KEY (
              request_client, surface_id, session_id, message_id,
              projection_format_version, position
            ),
            FOREIGN KEY (
              request_client, surface_id, session_id, message_id, projection_format_version
            ) REFERENCES core_surface_projections (
              request_client, surface_id, session_id, message_id, projection_format_version
            ) ON DELETE CASCADE
          )
        `);
        this.db.run(`
          CREATE TABLE core_primary_lineage_manifests (
            request_id TEXT PRIMARY KEY
              REFERENCES request_transcripts(request_id) ON DELETE CASCADE,
            lineage_version INTEGER NOT NULL CHECK (lineage_version = 1),
            manifest_json TEXT NOT NULL,
            created_ts INTEGER NOT NULL
          )
        `);
        this.db.run(`
          CREATE TABLE core_lineage_projection_refs (
            request_id TEXT NOT NULL
              REFERENCES core_primary_lineage_manifests(request_id) ON DELETE CASCADE,
            segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
            atom_index INTEGER NOT NULL CHECK (atom_index >= 0),
            request_client TEXT NOT NULL,
            surface_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            projection_format_version INTEGER NOT NULL,
            PRIMARY KEY (request_id, segment_index, atom_index),
            FOREIGN KEY (
              request_client, surface_id, session_id, message_id, projection_format_version
            ) REFERENCES core_surface_projections (
              request_client, surface_id, session_id, message_id, projection_format_version
            ) ON DELETE RESTRICT
          )
        `);
        this.db.run(`
          CREATE TABLE core_lineage_request_refs (
            request_id TEXT NOT NULL
              REFERENCES core_primary_lineage_manifests(request_id) ON DELETE CASCADE,
            segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
            atom_index INTEGER NOT NULL CHECK (atom_index >= 0),
            reference_kind TEXT NOT NULL CHECK (reference_kind IN ('request', 'checkpoint')),
            referenced_request_id TEXT NOT NULL
              REFERENCES request_transcripts(request_id) ON DELETE RESTRICT,
            transcript_digest TEXT NOT NULL,
            PRIMARY KEY (request_id, segment_index, atom_index)
          )
        `);
        this.db.run(`
          CREATE INDEX idx_core_lineage_request_refs_referenced
          ON core_lineage_request_refs(referenced_request_id)
        `);

        const rows = this.db
          .query<{ request_id: string; messages_json: string }, []>(
            "SELECT request_id, messages_json FROM request_transcripts",
          )
          .all();
        for (const row of rows) {
          const decoded = decodeTranscriptMessages({
            raw: row.messages_json,
            schemaVersion: 1,
            recordId: row.request_id,
          });
          if (decoded.status === "error") {
            this.reportPersistenceError(decoded.error);
            throw new Panic({
              message: "Cannot migrate corrupt transcript messages to schema v2",
              cause: decoded.error,
            });
          }
          this.db.run("UPDATE request_transcripts SET transcript_digest = ? WHERE request_id = ?", [
            hashCanonicalMessagesV1(decoded.value.value).hash,
            row.request_id,
          ]);
        }
        this.db.run(
          "INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (?, ?)",
          [2, Date.now()],
        );
      }
      if (version < 3) {
        this.db.run(`
          CREATE TABLE core_lineage_request_alias_refs (
            request_id TEXT NOT NULL
              REFERENCES core_primary_lineage_manifests(request_id) ON DELETE CASCADE,
            segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
            alias_index INTEGER NOT NULL CHECK (alias_index >= 0),
            referenced_request_id TEXT NOT NULL
              REFERENCES request_transcripts(request_id) ON DELETE RESTRICT,
            request_client TEXT NOT NULL,
            surface_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            projection_format_version INTEGER NOT NULL,
            PRIMARY KEY (request_id, segment_index, alias_index),
            FOREIGN KEY (
              request_client, surface_id, session_id, message_id, projection_format_version
            ) REFERENCES core_surface_projections (
              request_client, surface_id, session_id, message_id, projection_format_version
            ) ON DELETE RESTRICT
          )
        `);
        this.db.run(`
          CREATE INDEX idx_core_lineage_request_alias_refs_projection
          ON core_lineage_request_alias_refs(
            request_client, surface_id, session_id, message_id, projection_format_version
          )
        `);
        this.db.run(
          "INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (?, ?)",
          [3, Date.now()],
        );
      }
      if (version < 4) {
        this.db.run(`
          CREATE TABLE core_primary_claude_bindings (
            request_client TEXT NOT NULL CHECK (request_client = 'discord'),
            session_id TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            binding_protocol_version INTEGER NOT NULL CHECK (binding_protocol_version = 1),
            provider_family TEXT NOT NULL CHECK (provider_family = 'claude-code'),
            lineage_version INTEGER NOT NULL CHECK (lineage_version = 1),
            atom_count INTEGER NOT NULL CHECK (atom_count > 0),
            prefix_digest TEXT NOT NULL,
            canonical_message_count INTEGER NOT NULL CHECK (canonical_message_count > 0),
            execution_scope_hash_version INTEGER NOT NULL CHECK (execution_scope_hash_version = 1),
            execution_scope_hash TEXT NOT NULL,
            claude_session_id TEXT NOT NULL,
            native_cwd TEXT NOT NULL,
            native_last_modified REAL NOT NULL CHECK (native_last_modified >= 0),
            native_context_tokens INTEGER NOT NULL CHECK (native_context_tokens >= 0),
            native_context_max_tokens INTEGER NOT NULL CHECK (native_context_max_tokens > 0),
            last_model_specifier TEXT NOT NULL,
            last_reasoning TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK (revision > 0),
            updated_ts INTEGER NOT NULL,
            PRIMARY KEY (request_client, session_id, provider_id)
          )
        `);
        this.db.run(`
          CREATE TABLE core_primary_claude_attempts (
            product TEXT NOT NULL CHECK (product = 'core-primary'),
            request_client TEXT NOT NULL CHECK (request_client = 'discord'),
            session_id TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            source_lineage_version INTEGER CHECK (source_lineage_version = 1),
            source_atom_count INTEGER CHECK (source_atom_count > 0),
            source_prefix_digest TEXT,
            source_canonical_message_count INTEGER CHECK (source_canonical_message_count > 0),
            execution_scope_hash_version INTEGER NOT NULL CHECK (execution_scope_hash_version = 1),
            execution_scope_hash TEXT NOT NULL,
            request_id TEXT NOT NULL,
            attempt_index INTEGER NOT NULL CHECK (attempt_index >= 0),
            candidate_session_id TEXT NOT NULL,
            source_session_id TEXT,
            expected_binding_revision INTEGER CHECK (expected_binding_revision > 0),
            state TEXT NOT NULL CHECK (state IN ('active', 'succeeded', 'failed', 'cancelled', 'uncertain')),
            terminal_request_id TEXT REFERENCES request_transcripts(request_id) ON DELETE CASCADE,
            terminal_lineage_version INTEGER CHECK (terminal_lineage_version = 1),
            terminal_atom_count INTEGER CHECK (terminal_atom_count > 0),
            terminal_prefix_digest TEXT,
            terminal_canonical_message_count INTEGER CHECK (terminal_canonical_message_count > 0),
            native_cwd TEXT,
            native_last_modified REAL CHECK (native_last_modified >= 0),
            native_context_tokens INTEGER CHECK (native_context_tokens >= 0),
            native_context_max_tokens INTEGER CHECK (native_context_max_tokens > 0),
            last_model_specifier TEXT,
            last_reasoning TEXT,
            created_ts INTEGER NOT NULL,
            updated_ts INTEGER NOT NULL,
            PRIMARY KEY (request_client, session_id, provider_id, request_id, attempt_index)
          )
        `);
        this.db.run(`
          CREATE INDEX idx_core_primary_claude_attempts_owner
          ON core_primary_claude_attempts(request_client, session_id, provider_id, updated_ts)
        `);
        this.db.run(
          "INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (?, ?)",
          [4, Date.now()],
        );
      }
      if (version < 5) {
        this.db.run(
          `ALTER TABLE core_primary_claude_bindings
           ADD COLUMN terminal_request_id TEXT
             REFERENCES request_transcripts(request_id) ON DELETE CASCADE`,
        );
        const bindings = this.db
          .query<CorePrimaryClaudeBindingRow, []>(
            "SELECT * FROM core_primary_claude_bindings ORDER BY rowid",
          )
          .all();
        for (const binding of bindings) {
          const terminalRequestId = this.findCorePrimaryTerminalRequestId(binding);
          if (terminalRequestId === null) continue;
          this.db.run(
            `UPDATE core_primary_claude_bindings SET terminal_request_id = ?
             WHERE request_client = ? AND session_id = ? AND provider_id = ?
               AND revision = ? AND terminal_request_id IS NULL`,
            [
              terminalRequestId,
              binding.request_client,
              binding.session_id,
              binding.provider_id,
              binding.revision,
            ],
          );
        }
        this.db.run("DELETE FROM core_primary_claude_bindings WHERE terminal_request_id IS NULL");
        this.db.run(
          "INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (?, ?)",
          [5, Date.now()],
        );
      }
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_core_lineage_projection_refs_projection
        ON core_lineage_projection_refs(
          request_client, surface_id, session_id, message_id, projection_format_version
        )
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_core_surface_projection_blobs_blob
        ON core_surface_projection_blobs(blob_sha256)
      `);
      const foreignKeyFailures = this.db
        .query<DecodedTranscriptForeignKeyFailureRow, []>("PRAGMA foreign_key_check")
        .all()
        .map((row, index) => {
          const decoded = decodeTranscriptRow({
            storeKind: "foreign-key-failure",
            row,
            schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
            recordId: `foreign-key:${index}`,
          });
          if (decoded.status === "error") {
            this.reportPersistenceError(decoded.error);
            throw new Panic({
              message: "Invalid transcript foreign-key check row",
              cause: decoded.error,
            });
          }
          return decoded.value.value;
        });
      if (foreignKeyFailures.length > 0) {
        if (foreignKeyFailures.some((failure) => failure.parent === "core_owned_blobs")) {
          throw new CoreOwnedBlobIntegrityError(
            "Transcript schema validation found a missing Core-owned blob",
          );
        }
        throw new Error("Transcript schema migration failed foreign-key validation");
      }
    });
    migrate.immediate();
  }

  selectSessionToolIds(input: {
    requestClient: AdapterPlatform;
    sessionId: string;
    catalogIds: readonly string[];
  }): void {
    if (input.catalogIds.length === 0) return;

    const selectedTs = Date.now();
    const select = this.db.transaction(() => {
      for (const catalogId of input.catalogIds) {
        this.db.run(
          `
          INSERT INTO session_loaded_tools (
            request_client, session_id, catalog_id, selected_ts
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(request_client, session_id, catalog_id) DO UPDATE SET
            selected_ts=excluded.selected_ts;
          `,
          [input.requestClient, input.sessionId, catalogId, selectedTs],
        );
      }
    });

    select();
  }

  listSessionToolIds(input: { requestClient: AdapterPlatform; sessionId: string }): string[] {
    const rows = this.db
      .query<{ catalog_id: string }, [AdapterPlatform, string]>(
        `
        SELECT catalog_id
        FROM session_loaded_tools
        WHERE request_client = ? AND session_id = ?
        ORDER BY catalog_id ASC
        `,
      )
      .all(input.requestClient, input.sessionId);

    return rows.map((row) => row.catalog_id);
  }

  saveRequestTranscript(input: {
    requestId: string;
    sessionId: string;
    requestClient: AdapterPlatform;
    messages: readonly ModelMessage[];
    finalText?: string;
    modelLabel?: string;
    contextMeta?: CompactionCheckpointMeta;
    providerState?: HistoryProviderState;
    stableNamedRequestClient?: AdapterPlatform;
    corePrimaryLineage?: CoreLineageManifestV1;
  }): ResultType<void, TranscriptStoreWriteError> {
    const now = Date.now();
    const normalizedMessages = parseNormalizedCanonicalMessages(input.messages);
    const transcriptDigest = hashCanonicalMessagesV1(normalizedMessages).hash;
    const providerState = input.providerState ?? null;
    const stableNamedRequestClient = input.stableNamedRequestClient ?? null;
    const decodedLineage = input.corePrimaryLineage
      ? this.decodeCompleteCorePrimaryLineage(input.corePrimaryLineage, "save-request-transcript")
      : Result.ok<CoreLineageManifestV1 | null>(null);
    if (decodedLineage.status === "error") return Result.err(decodedLineage.error);
    const lineage = decodedLineage.value;
    const preparedLineage = lineage
      ? this.finalizeTransactionPersistenceDiagnostics(
          this.prepareCorePrimaryLineageManifest({
            requestId: input.requestId,
            manifest: lineage,
            requestClient: input.requestClient,
            sessionId: input.sessionId,
            createdAt: now,
            operation: "save-request-transcript",
          }),
        )
      : Result.ok<PreparedCorePrimaryLineageManifest | null>(null);
    if (preparedLineage.status === "error") return Result.err(preparedLineage.error);

    // Persist the full transcript, but repair provider-shaped stringified assistant
    // tool inputs into canonical object form so resumed sessions remain executable.
    // Do not prune/compact tool outputs at persistence time; do that (if needed)
    // only in the model-facing view right before sending.
    const finalJson = JSON.stringify(normalizedMessages);
    const contextMetaJson = input.contextMeta ? JSON.stringify(input.contextMeta) : null;
    const providerStateJson = providerState ? JSON.stringify(providerState) : null;

    const save = runBunSqliteTransaction<
      readonly DeferredTranscriptEvent[],
      | TranscriptTransactionPersistenceFailure
      | TranscriptRetainedByLineage
      | CoreOwnedBlobIntegrityError
      | TranscriptStoreReadError
      | TranscriptTransactionConflict,
      TranscriptStoreSqliteDriverFailure
    >(
      this.db,
      () => {
        const existing = this.db
          .query<
            { transcript_digest: string | null; provider_state_json: string | null },
            [string]
          >(
            `SELECT transcript_digest, provider_state_json
           FROM request_transcripts WHERE request_id = ?`,
          )
          .get(input.requestId);
        if (existing) {
          const digestRetained = this.db
            .query(
              "SELECT 1 FROM core_lineage_request_refs WHERE referenced_request_id = ? LIMIT 1",
            )
            .get(input.requestId);
          const requestMetadataRetained = this.db
            .query(
              `SELECT 1 FROM core_lineage_request_refs
             WHERE referenced_request_id = ? AND reference_kind = 'request' LIMIT 1`,
            )
            .get(input.requestId);
          const existingProviderState = decodeTranscriptProviderState({
            raw: existing.provider_state_json,
            schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
            recordId: input.requestId,
          });
          if (existingProviderState.status === "error") {
            return Result.err(deferTranscriptPersistenceFailure(existingProviderState.error));
          }
          if (
            (digestRetained && existing.transcript_digest !== transcriptDigest) ||
            (requestMetadataRetained &&
              !isDeepStrictEqual(existingProviderState.value.value, providerState))
          ) {
            return Result.err(
              new TranscriptRetainedByLineage({
                requestId: input.requestId,
                message: "Request transcript is retained by a Core primary lineage manifest",
              }),
            );
          }
        }

        this.db.run(
          `
        INSERT INTO request_transcripts (
          request_id, session_id, request_client, created_ts, updated_ts, model_label, final_text,
          messages_json, context_meta_json, provider_state_json, stable_named_request_client,
          transcript_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id) DO UPDATE SET
          session_id=excluded.session_id,
          request_client=excluded.request_client,
          updated_ts=excluded.updated_ts,
          model_label=excluded.model_label,
          final_text=excluded.final_text,
          messages_json=excluded.messages_json,
          context_meta_json=excluded.context_meta_json,
          provider_state_json=excluded.provider_state_json,
          stable_named_request_client=excluded.stable_named_request_client,
          transcript_digest=excluded.transcript_digest;
        `,
          [
            input.requestId,
            input.sessionId,
            input.requestClient,
            now,
            now,
            input.modelLabel ?? null,
            input.finalText ?? null,
            finalJson,
            contextMetaJson,
            providerStateJson,
            stableNamedRequestClient,
            transcriptDigest,
          ],
        );
        if (preparedLineage.value) {
          const savedLineage = this.saveCorePrimaryLineageManifestInTransaction(
            preparedLineage.value,
            "save-request-transcript",
          );
          if (savedLineage.status === "error") return Result.err(savedLineage.error);
        }
        return Result.ok(this.pruneRetention(now));
      },
      (cause) => classifyTranscriptSqliteDriverFailure("save-request-transcript", cause),
    );
    const finalized = this.finalizeTransactionPersistenceDiagnostics(save);
    if (finalized.status === "error") return Result.err(finalized.error);
    this.emitDeferredTranscriptEvents(finalized.value);
    return Result.ok(undefined);
  }

  putCoreOwnedBlob(inputValue: {
    bytes: Uint8Array;
    mediaType: string;
    filename: string;
  }): ResultType<CoreOwnedBlob, CoreOwnedBlobIntegrityError> {
    const input = inputValue;
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const existing = this.readCoreOwnedBlob(sha256);
    if (existing.status === "error") return Result.err(existing.error);
    if (existing.value) return Result.ok(existing.value);

    const createdAt = Date.now();
    this.db.run(
      `INSERT OR IGNORE INTO core_owned_blobs (
         sha256, media_type, filename, byte_length, bytes, created_ts
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [sha256, input.mediaType, input.filename, input.bytes.byteLength, input.bytes, createdAt],
    );
    const stored = this.readCoreOwnedBlob(sha256);
    if (stored.status === "error") return Result.err(stored.error);
    return stored.value
      ? Result.ok(stored.value)
      : Result.err(new CoreOwnedBlobIntegrityError(`Owned blob '${sha256}' was not retained`));
  }

  getCoreOwnedBlob(inputValue: {
    sha256: string;
  }): ResultType<CoreOwnedBlob, CoreOwnedBlobIntegrityError> {
    const sha256 = inputValue.sha256;
    const blob = this.readCoreOwnedBlob(sha256);
    if (blob.status === "error") return Result.err(blob.error);
    return blob.value
      ? Result.ok(blob.value)
      : Result.err(new CoreOwnedBlobIntegrityError(`Owned blob '${sha256}' is missing`));
  }

  deleteCoreOwnedBlobIfUnreferenced(inputValue: { sha256: string }): boolean {
    const sha256 = inputValue.sha256;
    const result = this.db.run(
      `DELETE FROM core_owned_blobs
       WHERE sha256 = ?
         AND NOT EXISTS (
           SELECT 1 FROM core_surface_projection_blobs WHERE blob_sha256 = ?
         )`,
      [sha256, sha256],
    );
    const deleted = result.changes > 0;
    if (deleted) {
      logger.info("core_retention.orphans_pruned", {
        ownedBlobCount: 1,
        reason: "unreferenced-owned-blob",
      });
    }
    return deleted;
  }

  admitCoreSurfaceProjection(
    inputValue: AdmitCoreSurfaceProjection,
  ): ResultType<
    CoreSurfaceProjection,
    TranscriptStoreReadError | CoreOwnedBlobIntegrityError | TranscriptTransactionConflict
  > {
    const input = {
      ...inputValue,
      canonicalMessages: parseNormalizedCanonicalMessages(inputValue.canonicalMessages),
      ownedBlobs: inputValue.ownedBlobs.map((reference) => ({
        sha256: reference.sha256,
        mediaType: reference.mediaType,
        filename: reference.filename,
        byteLength: reference.byteLength,
      })),
    };
    const key: CoreSurfaceProjectionKey = {
      requestClient: input.requestClient,
      surfaceId: input.surfaceId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      projectionFormatVersion: input.projectionFormatVersion,
    };
    const existing = this.getCoreSurfaceProjection(key);
    if (existing.status === "error") return Result.err(existing.error);
    if (existing.value) return Result.ok(existing.value);
    for (const reference of input.ownedBlobs) {
      const blobRead = this.readCoreOwnedBlob(reference.sha256);
      if (blobRead.status === "error") return Result.err(blobRead.error);
      const blob = blobRead.value;
      if (!blob) {
        return Result.err(
          new CoreOwnedBlobIntegrityError(`Owned blob '${reference.sha256}' is missing`),
        );
      }
      if (!isDeepStrictEqual(toCoreOwnedBlobReference(blob), reference)) {
        return Result.err(
          new CoreOwnedBlobIntegrityError(
            `Owned blob reference '${reference.sha256}' does not match stored metadata`,
          ),
        );
      }
    }
    const createdAt = Date.now();
    const canonicalMessagesJson = JSON.stringify(input.canonicalMessages);
    const sourceFactsJson = JSON.stringify(input.sourceFacts);
    const insertedProjection: CoreSurfaceProjection = {
      ...key,
      canonicalMessages: input.canonicalMessages,
      sourceFacts: input.sourceFacts,
      ownedBlobs: input.ownedBlobs,
      createdAt,
    };
    const admission = runBunSqliteTransaction<
      CoreSurfaceProjectionAdmissionOutcome,
      TranscriptTransactionConflict,
      TranscriptStoreSqliteDriverFailure
    >(
      this.db,
      () => {
        const retained = this.db
          .query<{ request_client: string }, [AdapterPlatform, string, string, string, number]>(
            `SELECT request_client FROM core_surface_projections
             WHERE request_client = ? AND surface_id = ? AND session_id = ?
               AND message_id = ? AND projection_format_version = ?`,
          )
          .get(
            key.requestClient,
            key.surfaceId,
            key.sessionId,
            key.messageId,
            key.projectionFormatVersion,
          );
        if (retained) return Result.ok({ kind: "existing" });
        this.db.run(
          `INSERT INTO core_surface_projections (
           request_client, surface_id, session_id, message_id, projection_format_version,
           canonical_messages_json, source_facts_json, created_ts
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.requestClient,
            input.surfaceId,
            input.sessionId,
            input.messageId,
            input.projectionFormatVersion,
            canonicalMessagesJson,
            sourceFactsJson,
            createdAt,
          ],
        );
        for (const [position, reference] of input.ownedBlobs.entries()) {
          this.db.run(
            `INSERT INTO core_surface_projection_blobs (
             request_client, surface_id, session_id, message_id, projection_format_version,
             position, blob_sha256
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              input.requestClient,
              input.surfaceId,
              input.sessionId,
              input.messageId,
              input.projectionFormatVersion,
              position,
              reference.sha256,
            ],
          );
        }
        const stored = this.db
          .query<{ request_client: string }, [AdapterPlatform, string, string, string, number]>(
            `SELECT request_client FROM core_surface_projections
             WHERE request_client = ? AND surface_id = ? AND session_id = ?
               AND message_id = ? AND projection_format_version = ?`,
          )
          .get(
            key.requestClient,
            key.surfaceId,
            key.sessionId,
            key.messageId,
            key.projectionFormatVersion,
          );
        if (!stored) {
          return Result.err(
            transactionConflict(
              "admit-core-surface-projection",
              "projection-not-retained",
              "Core surface projection was not retained",
            ),
          );
        }
        return Result.ok({ kind: "inserted", projection: insertedProjection });
      },
      (cause) => classifyTranscriptSqliteDriverFailure("admit-core-surface-projection", cause),
    );
    const finalized = admission;
    if (finalized.status === "error") return Result.err(finalized.error);
    if (finalized.value.kind === "inserted") return Result.ok(finalized.value.projection);
    const raced = this.getCoreSurfaceProjection(key);
    if (raced.status === "error") return Result.err(raced.error);
    if (raced.value) return Result.ok(raced.value);
    return Result.err(
      transactionConflict(
        "admit-core-surface-projection",
        "projection-not-retained",
        "Core surface projection was not retained",
      ),
    );
  }

  getCoreSurfaceProjection(
    inputValue: CoreSurfaceProjectionKey,
  ): ResultType<
    CoreSurfaceProjection | null,
    TranscriptStoreReadError | CoreOwnedBlobIntegrityError
  > {
    const input = inputValue;
    const read = this.readFromSqlite("get-core-surface-projection", () => {
      const row = this.db
        .query<CoreSurfaceProjectionRow, [AdapterPlatform, string, string, string, number]>(
          `SELECT * FROM core_surface_projections
         WHERE request_client = ? AND surface_id = ? AND session_id = ?
           AND message_id = ? AND projection_format_version = ?`,
        )
        .get(
          input.requestClient,
          input.surfaceId,
          input.sessionId,
          input.messageId,
          input.projectionFormatVersion,
        );
      if (!row) return null;

      const references = this.db
        .query<CoreOwnedBlobRow, [AdapterPlatform, string, string, string, number]>(
          `SELECT b.* FROM core_surface_projection_blobs pb
         JOIN core_owned_blobs b ON b.sha256 = pb.blob_sha256
         WHERE pb.request_client = ? AND pb.surface_id = ? AND pb.session_id = ?
           AND pb.message_id = ? AND pb.projection_format_version = ?
         ORDER BY pb.position ASC`,
        )
        .all(
          input.requestClient,
          input.surfaceId,
          input.sessionId,
          input.messageId,
          input.projectionFormatVersion,
        );
      const count = this.db
        .query<{ count: number }, [AdapterPlatform, string, string, string, number]>(
          `SELECT COUNT(*) AS count FROM core_surface_projection_blobs
           WHERE request_client = ? AND surface_id = ? AND session_id = ?
             AND message_id = ? AND projection_format_version = ?`,
        )
        .get(
          input.requestClient,
          input.surfaceId,
          input.sessionId,
          input.messageId,
          input.projectionFormatVersion,
        );
      return { row, references, expectedReferenceCount: count?.count ?? 0 };
    });
    if (read.status === "error") return Result.err(read.error);
    if (read.value === null) return Result.ok(null);
    if (read.value.references.length !== read.value.expectedReferenceCount) {
      return Result.err(
        new CoreOwnedBlobIntegrityError("A Core surface projection references a missing blob"),
      );
    }
    const ownedBlobs: CoreOwnedBlobReference[] = [];
    for (const reference of read.value.references) {
      const decoded = decodeCoreOwnedBlobRow(reference);
      if (decoded.status === "error") return Result.err(decoded.error);
      ownedBlobs.push(toCoreOwnedBlobReference(decoded.value));
    }
    const decoded = decodeCoreSurfaceProjectionRow({
      row: read.value.row,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    });
    if (decoded.status === "error") {
      this.reportPersistenceError(decoded.error);
      return Result.err(decoded.error);
    }
    return Result.ok({ ...decoded.value.value, ownedBlobs });
  }

  getLatestCoreSurfaceSegment(
    inputValue: CoreSurfaceProjectionKey,
  ): ResultType<CoreStoredSurfaceSegment | null, TranscriptStoreReadError> {
    const input = inputValue;
    const read = this.readFromSqlite("get-latest-core-surface-segment", () =>
      this.db
        .query<
          PersistedCoreLineageManifestRow & { segment_index: number },
          [AdapterPlatform, string, string, string, number]
        >(
          `SELECT r.request_id, r.segment_index, m.lineage_version, m.manifest_json
         FROM core_lineage_projection_refs r
         JOIN core_primary_lineage_manifests m ON m.request_id = r.request_id
         WHERE r.request_client = ? AND r.surface_id = ? AND r.session_id = ?
           AND r.message_id = ? AND r.projection_format_version = ?
         ORDER BY m.created_ts DESC, r.request_id DESC
         LIMIT 1`,
        )
        .get(
          input.requestClient,
          input.surfaceId,
          input.sessionId,
          input.messageId,
          input.projectionFormatVersion,
        ),
    );
    if (read.status === "error") return Result.err(read.error);
    if (!read.value) return Result.ok(null);
    const decoded = decodeCoreLineageManifestRow({
      row: read.value,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    });
    if (decoded.status === "error") {
      this.reportPersistenceError(decoded.error);
      return Result.err(decoded.error);
    }
    const segment = decoded.value.value.segments[read.value.segment_index];
    if (!segment) {
      const error = new CorruptPersistedFields({
        table: "core_primary_lineage_manifests",
        field: "segment_index",
        version: TRANSCRIPT_SCHEMA_VERSION,
        issueCode: "invalid-lineage-manifest",
        recordId: read.value.request_id,
        message: "Persisted Core lineage segment is missing",
      });
      this.reportPersistenceError(error);
      return Result.err(error);
    }
    return Result.ok({
      requestId: read.value.request_id,
      segmentIndex: read.value.segment_index,
      messageIds: segment.atoms
        .filter((atom) => atom.kind === "surface")
        .map((atom) => atom.messageId),
      canonicalMessages: segment.canonicalMessages,
    });
  }

  private readRequestTranscriptForTransactionPreparation(
    requestId: string,
  ): ResultType<
    TranscriptSnapshot | null,
    TranscriptStoreSqliteDriverFailure | TranscriptTransactionPersistenceFailure
  > {
    const read = this.readFromSqlite("prepare-request-transcript-transaction", () =>
      this.db
        .query<TranscriptRow, [string]>(
          `SELECT request_id, session_id, request_client, created_ts, updated_ts, model_label,
                  final_text, messages_json, context_meta_json, provider_state_json,
                  stable_named_request_client, transcript_digest
           FROM request_transcripts WHERE request_id = ?`,
        )
        .get(requestId),
    );
    if (read.status === "error") return Result.err(read.error);
    if (!read.value) return Result.ok(null);
    const decoded = decodeTranscriptRow({
      row: read.value,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    });
    if (decoded.status === "error") {
      return Result.err(deferTranscriptPersistenceFailure(decoded.error));
    }
    return Result.ok(decoded.value.value);
  }

  private readCorePrimaryLineageForTransactionPreparation(
    requestId: string,
  ): ResultType<
    PreparedCorePrimaryLineageRead | null,
    TranscriptStoreSqliteDriverFailure | TranscriptTransactionPersistenceFailure
  > {
    const read = this.readFromSqlite("prepare-core-primary-lineage-transaction", () =>
      this.db
        .query<PersistedCoreLineageManifestRow, [string]>(
          "SELECT request_id, lineage_version, manifest_json FROM core_primary_lineage_manifests WHERE request_id = ?",
        )
        .get(requestId),
    );
    if (read.status === "error") return Result.err(read.error);
    if (!read.value) return Result.ok(null);
    const decoded = decodeCoreLineageManifestRow({
      row: read.value,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    });
    if (decoded.status === "error") {
      return Result.err(deferTranscriptPersistenceFailure(decoded.error));
    }
    return Result.ok({ manifest: decoded.value.value, manifestJson: read.value.manifest_json });
  }

  private prepareCorePrimaryLineageManifest(input: {
    readonly requestId: string;
    readonly manifest: CoreLineageManifestV1;
    readonly requestClient: AdapterPlatform;
    readonly sessionId: string;
    readonly createdAt: number;
    readonly operation: "save-request-transcript" | "save-core-primary-lineage-manifest";
  }): ResultType<
    PreparedCorePrimaryLineageManifest,
    | TranscriptStoreReadError
    | CoreOwnedBlobIntegrityError
    | TranscriptTransactionConflict
    | TranscriptTransactionPersistenceFailure
  > {
    const existing = this.readFromSqlite("prepare-core-primary-lineage-manifest", () =>
      this.db
        .query<PersistedCoreLineageManifestRow, [string]>(
          "SELECT request_id, lineage_version, manifest_json FROM core_primary_lineage_manifests WHERE request_id = ?",
        )
        .get(input.requestId),
    );
    if (existing.status === "error") return Result.err(existing.error);
    if (existing.value) {
      const decoded = decodeCoreLineageManifestRow({
        row: existing.value,
        schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      });
      if (decoded.status === "error") {
        return Result.err(deferTranscriptPersistenceFailure(decoded.error));
      }
      if (!isDeepStrictEqual(decoded.value.value, input.manifest)) {
        return Result.err(
          transactionConflict(
            input.operation,
            "lineage-immutable",
            `Core primary lineage manifest '${input.requestId}' is immutable`,
          ),
        );
      }
      return Result.ok({
        requestId: input.requestId,
        manifest: decoded.value.value,
        manifestJson: existing.value.manifest_json,
        createdAt: input.createdAt,
        requestClient: input.requestClient,
        sessionId: input.sessionId,
        existingManifestJson: existing.value.manifest_json,
      });
    }

    const invalidReason = this.validateCorePrimaryLineageReferences({
      manifest: input.manifest,
      requestClient: input.requestClient,
      sessionId: input.sessionId,
      surfaceId: `${input.requestClient}:${input.sessionId}`,
    });
    if (invalidReason.status === "error") return Result.err(invalidReason.error);
    if (invalidReason.value) {
      return Result.err(
        transactionConflict(
          input.operation,
          "lineage-invalid",
          `Core primary lineage manifest '${input.requestId}' is invalid: ${invalidReason.value}`,
        ),
      );
    }
    return Result.ok({
      requestId: input.requestId,
      manifest: input.manifest,
      manifestJson: JSON.stringify(input.manifest),
      createdAt: input.createdAt,
      requestClient: input.requestClient,
      sessionId: input.sessionId,
      existingManifestJson: null,
    });
  }

  saveCorePrimaryLineageManifest(input: {
    requestId: string;
    manifest: CoreLineageManifestV1;
  }): ResultType<
    CoreLineageManifestV1,
    TranscriptStoreReadError | CoreOwnedBlobIntegrityError | TranscriptTransactionConflict
  > {
    const requestId = input.requestId;
    const manifest = this.decodeCompleteCorePrimaryLineage(
      input.manifest,
      "save-core-primary-lineage-manifest",
    );
    if (manifest.status === "error") return Result.err(manifest.error);
    const owner = this.finalizeTransactionPersistenceDiagnostics(
      this.readRequestTranscriptForTransactionPreparation(requestId),
    );
    if (owner.status === "error") return Result.err(owner.error);
    if (!owner.value) {
      return Result.err(
        transactionConflict(
          "save-core-primary-lineage-manifest",
          "transcript-not-found",
          `Request transcript '${requestId}' was not found`,
        ),
      );
    }
    const prepared = this.finalizeTransactionPersistenceDiagnostics(
      this.prepareCorePrimaryLineageManifest({
        requestId,
        manifest: manifest.value,
        requestClient: owner.value.requestClient,
        sessionId: owner.value.sessionId,
        createdAt: Date.now(),
        operation: "save-core-primary-lineage-manifest",
      }),
    );
    if (prepared.status === "error") return Result.err(prepared.error);
    const save = runBunSqliteTransaction<
      CoreLineageManifestV1,
      TranscriptTransactionConflict,
      TranscriptStoreSqliteDriverFailure
    >(
      this.db,
      () =>
        this.saveCorePrimaryLineageManifestInTransaction(
          prepared.value,
          "save-core-primary-lineage-manifest",
        ),
      (cause) => classifyTranscriptSqliteDriverFailure("save-core-primary-lineage-manifest", cause),
    );
    return save;
  }

  getCorePrimaryLineageManifest(input: {
    requestId: string;
  }): ResultType<CoreLineageManifestV1 | null, TranscriptStoreReadError> {
    const requestId = input.requestId;
    const read = this.readFromSqlite("get-core-primary-lineage-manifest", () =>
      this.db
        .query<PersistedCoreLineageManifestRow, [string]>(
          "SELECT request_id, lineage_version, manifest_json FROM core_primary_lineage_manifests WHERE request_id = ?",
        )
        .get(requestId),
    );
    if (read.status === "error") return Result.err(read.error);
    if (!read.value) return Result.ok(null);
    const transcript = this.getRequestTranscript({ requestId });
    if (transcript.status === "error") return Result.err(transcript.error);
    if (!transcript.value) {
      const error = new CorruptPersistedFields({
        table: "core_primary_lineage_manifests",
        field: "request_id",
        version: TRANSCRIPT_SCHEMA_VERSION,
        issueCode: "invalid-lineage-manifest",
        recordId: requestId,
        message: `Core primary lineage transcript '${requestId}' is missing`,
      });
      this.reportPersistenceError(error);
      return Result.err(error);
    }
    const decoded = decodeCoreLineageManifestRow({
      row: read.value,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    });
    if (decoded.status === "error") {
      this.reportPersistenceError(decoded.error);
      return Result.err(decoded.error);
    }
    return Result.ok(decoded.value.value);
  }

  getCoreRequestAtomMetadata(input: {
    requestId: string;
  }): ResultType<CoreRequestAtomMetadata | null, TranscriptStoreReadError> {
    const transcript = this.getRequestTranscript(input);
    if (transcript.status === "error") return Result.err(transcript.error);
    if (!transcript.value?.providerState) return Result.ok(null);
    return Result.ok({
      requestId: transcript.value.requestId,
      transcriptDigest:
        transcript.value.transcriptDigest ??
        hashCanonicalMessagesV1(transcript.value.messages).hash,
      providerFamily: transcript.value.providerState.lastFamily,
      containsCrossFamilyTurns: transcript.value.providerState.containsCrossFamilyTurns,
    });
  }

  private saveCorePrimaryLineageManifestInTransaction(
    prepared: PreparedCorePrimaryLineageManifest,
    operation: "save-request-transcript" | "save-core-primary-lineage-manifest",
  ): ResultType<CoreLineageManifestV1, TranscriptTransactionConflict> {
    const owner = this.db
      .query<{ request_id: string }, [string, AdapterPlatform, string]>(
        `SELECT request_id FROM request_transcripts
         WHERE request_id = ? AND request_client = ? AND session_id = ?`,
      )
      .get(prepared.requestId, prepared.requestClient, prepared.sessionId);
    if (!owner) {
      return Result.err(
        transactionConflict(
          operation,
          "transcript-not-found",
          `Request transcript '${prepared.requestId}' was not found`,
        ),
      );
    }

    if (prepared.existingManifestJson !== null) {
      const existing = this.db
        .query<{ request_id: string }, [string, string]>(
          `SELECT request_id FROM core_primary_lineage_manifests
           WHERE request_id = ? AND lineage_version = 1 AND manifest_json = ?`,
        )
        .get(prepared.requestId, prepared.existingManifestJson);
      if (!existing) {
        return Result.err(
          transactionConflict(
            operation,
            "lineage-immutable",
            `Core primary lineage manifest '${prepared.requestId}' is immutable`,
          ),
        );
      }
      return Result.ok(prepared.manifest);
    }

    const racedManifest = this.db
      .query<{ lineage_version: number; manifest_json: string }, [string]>(
        `SELECT lineage_version, manifest_json FROM core_primary_lineage_manifests
         WHERE request_id = ?`,
      )
      .get(prepared.requestId);
    if (racedManifest) {
      if (
        racedManifest.lineage_version === 1 &&
        racedManifest.manifest_json === prepared.manifestJson
      ) {
        return Result.ok(prepared.manifest);
      }
      return Result.err(
        transactionConflict(
          operation,
          "lineage-immutable",
          `Core primary lineage manifest '${prepared.requestId}' is immutable`,
        ),
      );
    }
    this.db.run(
      `INSERT INTO core_primary_lineage_manifests (
         request_id, lineage_version, manifest_json, created_ts
       ) VALUES (?, 1, ?, ?)`,
      [prepared.requestId, prepared.manifestJson, prepared.createdAt],
    );
    for (const [segmentIndex, segment] of prepared.manifest.segments.entries()) {
      for (const [atomIndex, atom] of segment.atoms.entries()) {
        if (atom.kind === "surface") {
          this.db.run(
            `INSERT INTO core_lineage_projection_refs (
               request_id, segment_index, atom_index, request_client, surface_id,
               session_id, message_id, projection_format_version
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
            [
              prepared.requestId,
              segmentIndex,
              atomIndex,
              atom.requestClient,
              atom.surfaceId,
              atom.sessionId,
              atom.messageId,
            ],
          );
        } else if (atom.kind === "request" || atom.kind === "checkpoint") {
          this.db.run(
            `INSERT INTO core_lineage_request_refs (
               request_id, segment_index, atom_index, reference_kind,
               referenced_request_id, transcript_digest
             ) VALUES (?, ?, ?, ?, ?, ?)`,
            [
              prepared.requestId,
              segmentIndex,
              atomIndex,
              atom.kind,
              atom.requestId,
              atom.transcriptDigest,
            ],
          );
        }
      }
      const requestAtom = segment.atoms[0];
      if (requestAtom?.kind === "request") {
        for (const [aliasIndex, alias] of segment.requestSource?.aliases.entries() ?? []) {
          this.db.run(
            `INSERT INTO core_lineage_request_alias_refs (
               request_id, segment_index, alias_index, referenced_request_id,
               request_client, surface_id, session_id, message_id, projection_format_version
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [
              prepared.requestId,
              segmentIndex,
              aliasIndex,
              requestAtom.requestId,
              alias.requestClient,
              alias.surfaceId,
              alias.sessionId,
              alias.messageId,
            ],
          );
        }
      }
    }
    return Result.ok(prepared.manifest);
  }

  validateCorePrimaryLineageReferences(input: {
    manifest: CoreLineageManifestV1;
    requestClient: AdapterPlatform;
    sessionId: string;
    surfaceId: string;
  }): ResultType<string | null, TranscriptStoreReadError | CoreOwnedBlobIntegrityError> {
    const decodedManifest = decodeCorePrimaryLineageV1(
      input.manifest,
      input.manifest.segments.flatMap((segment) => segment.canonicalMessages),
    );
    if (decodedManifest.status === "error" || decodedManifest.value.state !== "complete") {
      return Result.ok("malformed-lineage");
    }
    const manifest = decodedManifest.value;
    for (const segment of manifest.segments) {
      for (const atom of segment.atoms) {
        if (atom.kind === "surface") {
          if (
            atom.requestClient !== input.requestClient ||
            atom.sessionId !== input.sessionId ||
            atom.surfaceId !== input.surfaceId
          ) {
            return Result.ok("stale-surface-lineage");
          }
          const projection = this.getCoreSurfaceProjection({
            requestClient: input.requestClient,
            surfaceId: atom.surfaceId,
            sessionId: atom.sessionId,
            messageId: atom.messageId,
            projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
          });
          if (projection.status === "error") return Result.err(projection.error);
          if (!projection.value) return Result.ok("stale-surface-lineage");
          continue;
        }
        if (atom.kind === "synthetic") {
          if (hashCanonicalMessagesV1(segment.canonicalMessages).hash !== atom.messageDigest) {
            return Result.ok("stale-synthetic-lineage");
          }
          continue;
        }

        const transcript = this.getRequestTranscript({ requestId: atom.requestId });
        if (transcript.status === "error") return Result.err(transcript.error);
        const transcriptDigest = transcript.value
          ? (transcript.value.transcriptDigest ??
            hashCanonicalMessagesV1(transcript.value.messages).hash)
          : null;
        if (
          !transcript.value ||
          transcript.value.requestClient !== input.requestClient ||
          transcript.value.sessionId !== input.sessionId ||
          transcriptDigest !== atom.transcriptDigest
        ) {
          return Result.ok("stale-request-lineage");
        }
        if (!isDeepStrictEqual(transcript.value.messages, segment.canonicalMessages)) {
          return Result.ok("transformed-request-lineage");
        }
        if (atom.kind === "request") {
          const providerFamily = transcript.value.providerState?.lastFamily;
          if (
            providerFamily === undefined ||
            providerFamily !== atom.providerFamily ||
            transcript.value.providerState?.containsCrossFamilyTurns !==
              atom.containsCrossFamilyTurns
          ) {
            return Result.ok("stale-request-provider-lineage");
          }
          for (const alias of segment.requestSource?.aliases ?? []) {
            if (
              alias.requestClient !== input.requestClient ||
              alias.sessionId !== input.sessionId ||
              alias.surfaceId !== input.surfaceId
            ) {
              return Result.ok("stale-request-alias-lineage");
            }
            const projection = this.getCoreSurfaceProjection({
              ...alias,
              requestClient: alias.requestClient,
              projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
            });
            if (projection.status === "error") return Result.err(projection.error);
            if (!projection.value) return Result.ok("stale-request-alias-lineage");
            const mapping = this.db
              .query<{ request_id: string }, [string, string, string]>(
                `SELECT request_id FROM surface_message_to_request
                 WHERE platform = ? AND channel_id = ? AND message_id = ?`,
              )
              .get(alias.requestClient, alias.sessionId, alias.messageId);
            if (mapping?.request_id !== atom.requestId) {
              return Result.ok("stale-request-alias-lineage");
            }
          }
        } else {
          if (transcript.value.contextMeta?.type !== "compaction") {
            return Result.ok("stale-checkpoint-lineage");
          }
          const linkedOutput = this.db
            .query(
              `SELECT 1 FROM surface_message_to_request
               WHERE request_id = ? AND platform = ? AND channel_id = ?
               LIMIT 1`,
            )
            .get(atom.requestId, input.requestClient, input.sessionId);
          if (!linkedOutput) return Result.ok("stale-checkpoint-lineage");
        }
      }
      const surfaceAtoms = segment.atoms.filter((atom) => atom.kind === "surface");
      if (surfaceAtoms.length > 0) {
        const surfaceMessageIds = surfaceAtoms.map((atom) => atom.messageId);
        const segmentDigest = hashCanonicalMessagesV1(segment.canonicalMessages).hash;
        for (const atom of surfaceAtoms) {
          const projection = this.getCoreSurfaceProjection({
            requestClient: input.requestClient,
            surfaceId: atom.surfaceId,
            sessionId: atom.sessionId,
            messageId: atom.messageId,
            projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
          });
          if (projection.status === "error") return Result.err(projection.error);
          if (
            !projection.value ||
            !isDeepStrictEqual(
              projection.value.sourceFacts["segmentMessageIds"],
              surfaceMessageIds,
            ) ||
            projection.value.sourceFacts["segmentDigest"] !== segmentDigest
          ) {
            return Result.ok("transformed-surface-lineage");
          }
        }
      }
    }
    return Result.ok(null);
  }

  private decodeCompleteCorePrimaryLineage(
    value: CoreLineageManifestV1,
    operation: TranscriptTransactionOperation,
  ): ResultType<CoreLineageManifestV1, TranscriptTransactionConflict> {
    const canonicalMessages = value.segments.flatMap((segment) => segment.canonicalMessages);
    const lineage = decodeCorePrimaryLineageV1(value, canonicalMessages);
    if (lineage.status === "error" || lineage.value.state !== "complete") {
      return Result.err(
        transactionConflict(
          operation,
          "lineage-invalid",
          "Only valid complete Core primary lineage manifests can be persisted",
        ),
      );
    }
    return Result.ok(lineage.value);
  }

  private readCoreOwnedBlob(
    sha256: string,
  ): ResultType<CoreOwnedBlob | null, CoreOwnedBlobIntegrityError> {
    const row = this.db
      .query<CoreOwnedBlobRow, [string]>("SELECT * FROM core_owned_blobs WHERE sha256 = ?")
      .get(sha256);
    if (!row) return Result.ok(null);
    return decodeCoreOwnedBlobRow(row);
  }

  unlinkSurfaceMessage(input: {
    platform: AdapterPlatform;
    channelId: string;
    messageId: string;
  }): ResultType<UnlinkSurfaceMessageResult, TranscriptStoreReadError> {
    const unlink = runBunSqliteTransaction<
      UnlinkSurfaceMessageResult,
      TranscriptTransactionPersistenceFailure,
      TranscriptStoreSqliteDriverFailure
    >(
      this.db,
      () => {
        const mapping = this.db
          .query<{ request_id: string }, [AdapterPlatform, string, string]>(
            "SELECT request_id FROM surface_message_to_request WHERE platform = ? AND channel_id = ? AND message_id = ?",
          )
          .get(input.platform, input.channelId, input.messageId);
        if (!mapping) return Result.ok({ checkpointDeleted: false });

        this.db.run(
          "DELETE FROM surface_message_to_request WHERE platform = ? AND channel_id = ? AND message_id = ?",
          [input.platform, input.channelId, input.messageId],
        );

        const remaining = this.db
          .query("SELECT 1 FROM surface_message_to_request WHERE request_id = ? LIMIT 1")
          .get(mapping.request_id);
        if (remaining)
          return Result.ok({ requestId: mapping.request_id, checkpointDeleted: false });

        const transcript = this.db
          .query<{ context_meta_json: string | null }, [string]>(
            "SELECT context_meta_json FROM request_transcripts WHERE request_id = ?",
          )
          .get(mapping.request_id);
        if (!transcript) {
          return Result.ok({ requestId: mapping.request_id, checkpointDeleted: false });
        }
        const contextMeta = decodeTranscriptCompactionContext({
          raw: transcript.context_meta_json,
          schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
          recordId: mapping.request_id,
        });
        if (contextMeta.status === "error") {
          return Result.err(deferTranscriptPersistenceFailure(contextMeta.error));
        }
        if (!contextMeta.value.value) {
          return Result.ok({ requestId: mapping.request_id, checkpointDeleted: false });
        }
        const retained = this.isRequestTranscriptRetainedByLineage(mapping.request_id);
        if (retained.status === "error") {
          return Result.err(deferTranscriptPersistenceFailure(retained.error));
        }
        if (retained.value) {
          return Result.ok({ requestId: mapping.request_id, checkpointDeleted: false });
        }

        this.db.run("DELETE FROM request_transcripts WHERE request_id = ?", [mapping.request_id]);
        return Result.ok({ requestId: mapping.request_id, checkpointDeleted: true });
      },
      (cause) => classifyTranscriptSqliteDriverFailure("unlink-surface-message", cause),
    );
    return this.finalizeTransactionPersistenceDiagnostics(unlink);
  }

  deleteUnlinkedCheckpointCandidate(input: {
    requestId: string;
  }): ResultType<boolean, TranscriptStoreReadError> {
    const deletion = runBunSqliteTransaction<
      boolean,
      TranscriptTransactionPersistenceFailure,
      TranscriptStoreSqliteDriverFailure
    >(
      this.db,
      () => {
        const linked = this.db
          .query("SELECT 1 FROM surface_message_to_request WHERE request_id = ? LIMIT 1")
          .get(input.requestId);
        if (linked) return Result.ok(false);

        const transcript = this.db
          .query<{ context_meta_json: string | null }, [string]>(
            "SELECT context_meta_json FROM request_transcripts WHERE request_id = ?",
          )
          .get(input.requestId);
        if (!transcript) return Result.ok(false);
        const contextMeta = decodeTranscriptCompactionContext({
          raw: transcript.context_meta_json,
          schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
          recordId: input.requestId,
        });
        if (contextMeta.status === "error") {
          return Result.err(deferTranscriptPersistenceFailure(contextMeta.error));
        }
        if (!contextMeta.value.value) return Result.ok(false);
        const retained = this.isRequestTranscriptRetainedByLineage(input.requestId);
        if (retained.status === "error") {
          return Result.err(deferTranscriptPersistenceFailure(retained.error));
        }
        if (retained.value) return Result.ok(false);

        this.db.run("DELETE FROM request_transcripts WHERE request_id = ?", [input.requestId]);
        return Result.ok(true);
      },
      (cause) =>
        classifyTranscriptSqliteDriverFailure("delete-unlinked-checkpoint-candidate", cause),
    );
    return this.finalizeTransactionPersistenceDiagnostics(deletion);
  }

  linkSurfaceMessagesToRequest(input: {
    requestId: string;
    created: readonly MsgRef[];
    last: MsgRef;
  }): void {
    const now = Date.now();
    const all = [...input.created];
    // Ensure last is included even if callers forgot.
    if (
      !all.some(
        (m) =>
          m.platform === input.last.platform &&
          m.channelId === input.last.channelId &&
          m.messageId === input.last.messageId,
      )
    ) {
      all.push(input.last);
    }

    for (const ref of all) {
      this.db.run(
        `
        INSERT INTO surface_message_to_request (
          platform, channel_id, message_id, request_id, created_ts
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(platform, channel_id, message_id) DO NOTHING;
        `,
        [ref.platform, ref.channelId, ref.messageId, input.requestId, now],
      );
    }
  }

  getTranscriptBySurfaceMessage(input: {
    platform: AdapterPlatform;
    channelId: string;
    messageId: string;
  }): ResultType<TranscriptSnapshot | null, TranscriptStoreReadError> {
    const read = this.readFromSqlite("get-transcript-by-surface-message", () => {
      const mapRow = this.db
        .query<{ request_id: string }, [AdapterPlatform, string, string]>(
          "SELECT request_id FROM surface_message_to_request WHERE platform = ? AND channel_id = ? AND message_id = ?",
        )
        .get(input.platform, input.channelId, input.messageId);

      if (!mapRow) return null;

      return this.db
        .query<TranscriptRow, [string]>(
          `
        SELECT request_id, session_id, request_client, created_ts, updated_ts, model_label, final_text,
               messages_json, context_meta_json, provider_state_json, stable_named_request_client,
               transcript_digest
        FROM request_transcripts
        WHERE request_id = ?
        `,
        )
        .get(mapRow.request_id);
    });
    if (read.status === "error") return Result.err(read.error);
    return this.rowToSnapshot(read.value);
  }

  getLatestTranscriptBySession(input: {
    sessionId: string;
  }): ResultType<TranscriptSnapshot | null, TranscriptStoreReadError> {
    const read = this.readFromSqlite("get-latest-transcript-by-session", () =>
      this.db
        .query<TranscriptRow, [string]>(
          `
        SELECT request_id, session_id, request_client, created_ts, updated_ts, model_label, final_text,
               messages_json, context_meta_json, provider_state_json, stable_named_request_client,
               transcript_digest
        FROM request_transcripts
        WHERE session_id = ?
        ORDER BY updated_ts DESC, created_ts DESC, rowid DESC
        LIMIT 1
        `,
        )
        .get(input.sessionId),
    );
    if (read.status === "error") return Result.err(read.error);
    return this.rowToSnapshot(read.value);
  }

  getRequestTranscript(input: {
    requestId: string;
  }): ResultType<TranscriptSnapshot | null, TranscriptStoreReadError> {
    const read = this.readFromSqlite("get-request-transcript", () =>
      this.db
        .query<TranscriptRow, [string]>(
          `SELECT request_id, session_id, request_client, created_ts, updated_ts, model_label,
                final_text, messages_json, context_meta_json, provider_state_json,
                 stable_named_request_client, transcript_digest
         FROM request_transcripts WHERE request_id = ?`,
        )
        .get(input.requestId),
    );
    if (read.status === "error") return Result.err(read.error);
    return this.rowToSnapshot(read.value);
  }

  getLatestCompleteNamedTranscript(input: {
    requestClient: AdapterPlatform;
    sessionId: string;
  }): ResultType<TranscriptSnapshot | null, TranscriptStoreReadError> {
    const ownerClient = input.requestClient;
    const read = this.readFromSqlite("get-latest-complete-named-transcript", () =>
      this.db
        .query<TranscriptRow, [string, AdapterPlatform]>(
          `SELECT request_id, session_id, request_client, created_ts, updated_ts, model_label,
                final_text, messages_json, context_meta_json, provider_state_json,
                 stable_named_request_client, transcript_digest
         FROM request_transcripts
         WHERE session_id = ? AND stable_named_request_client = ?
         ORDER BY updated_ts DESC, created_ts DESC, rowid DESC LIMIT 1`,
        )
        .get(input.sessionId, ownerClient),
    );
    if (read.status === "error") return Result.err(read.error);
    return this.rowToSnapshot(read.value);
  }

  getCoreNamedClaudeSessionBinding(inputValue: {
    providerId: string;
    requestClient: AdapterPlatform;
    lilacSessionId: string;
  }): ResultType<CoreNamedClaudeSessionBinding | null, CoreClaudeBindingReadError> {
    const input = inputValue;
    const read = this.readFromSqlite("get-core-named-claude-binding", () =>
      this.readCoreNamedClaudeSessionBinding(input),
    );
    return read.status === "ok" ? read.value : Result.err(read.error);
  }

  private readCoreNamedClaudeSessionBinding(input: {
    providerId: string;
    requestClient: AdapterPlatform;
    lilacSessionId: string;
  }): ResultType<CoreNamedClaudeSessionBinding | null, CoreClaudeBindingReadError> {
    const row = this.db
      .query<CoreNamedClaudeBindingRow, [AdapterPlatform, string, string]>(
        `SELECT * FROM core_named_claude_bindings
         WHERE request_client = ? AND session_id = ? AND provider_id = ?`,
      )
      .get(input.requestClient, input.lilacSessionId, input.providerId);
    if (!row) return Result.ok(null);
    const decoded = decodeCoreNamedClaudeBinding(row);
    if (decoded.status === "ok") {
      const binding = decoded.value;
      const verified = this.assertVerifiedCoreNamedTerminal({
        requestClient: binding.requestClient,
        lilacSessionId: binding.lilacSessionId,
        terminalRequestId: binding.terminalRequestId,
        canonicalHeadHash: binding.canonicalHeadHash,
        canonicalMessageCount: binding.canonicalMessageCount,
      });
      if (verified.status === "ok") return Result.ok(binding);
      if (TranscriptStoreSqliteDriverFailure.is(verified.error)) return Result.err(verified.error);
    }
    return Result.err(
      new CoreClaudeBindingCorrupt({
        bindingKind: "named",
        providerId: input.providerId,
        requestClient: input.requestClient,
        lilacSessionId: input.lilacSessionId,
        message: "Core named Claude binding is corrupt",
      }),
    );
  }

  getCoreNamedClaudeSessionAttempt(inputValue: {
    providerId: string;
    requestClient: AdapterPlatform;
    lilacSessionId: string;
    requestId: string;
    attemptIndex: number;
  }): CoreNamedClaudeSessionAttempt | null {
    const input = inputValue;
    const row = this.db
      .query<CoreNamedClaudeAttemptRow, [AdapterPlatform, string, string, string, number]>(
        `SELECT * FROM core_named_claude_attempts
         WHERE request_client = ? AND session_id = ? AND provider_id = ?
           AND request_id = ? AND attempt_index = ?`,
      )
      .get(
        input.requestClient,
        input.lilacSessionId,
        input.providerId,
        input.requestId,
        input.attemptIndex,
      );
    return row ? toCoreNamedClaudeAttempt(row) : null;
  }

  reserveCoreNamedClaudeSessionAttempt(
    inputValue: ReserveCoreNamedClaudeSessionAttempt,
  ): ResultType<CoreNamedClaudeSessionAttempt, CoreClaudeAttemptMutationError> {
    const input = inputValue;
    const reserve = runBunSqliteTransaction<
      CoreNamedClaudeSessionAttempt,
      CoreClaudeAttemptMutationError,
      TranscriptStoreSqliteDriverFailure
    >(
      this.db,
      () => {
        const bindingRead = this.readCoreNamedClaudeSessionBinding({
          providerId: input.providerId,
          requestClient: input.requestClient,
          lilacSessionId: input.lilacSessionId,
        });
        if (bindingRead.status === "error") return Result.err(bindingRead.error);
        const binding = bindingRead.value;
        if (input.expectedBindingRevision === null) {
          if (binding !== null) {
            return Result.err(
              transactionConflict(
                "publish-core-named-claude-success",
                "publication-fence-lost",
                "Core named Claude binding changed before reservation",
              ),
            );
          }
        } else if (
          binding === null ||
          binding.revision !== input.expectedBindingRevision ||
          (input.sourceSessionId !== null &&
            (binding.claudeSessionId !== input.sourceSessionId ||
              binding.executionScopeHashVersion !== input.executionScopeHashVersion ||
              binding.executionScopeHash !== input.executionScopeHash))
        ) {
          return Result.err(
            transactionConflict(
              "publish-core-named-claude-success",
              "publication-fence-lost",
              "Core named Claude binding changed before reservation",
            ),
          );
        }
        const activeCountRow = decodeTranscriptRow({
          storeKind: "count",
          row: this.db
            .query<DecodedTranscriptCountRow, [AdapterPlatform, string, string]>(
              `SELECT COUNT(*) AS count FROM core_named_claude_attempts
               WHERE request_client = ? AND session_id = ? AND provider_id = ? AND state = 'active'`,
            )
            .get(input.requestClient, input.lilacSessionId, input.providerId),
          schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
          recordId: `named-active:${input.requestClient}:${input.lilacSessionId}:${input.providerId}`,
        });
        if (activeCountRow.status === "error") {
          return Result.err(
            transactionConflict(
              "publish-core-named-claude-success",
              "publication-verification-failed",
              activeCountRow.error.message,
            ),
          );
        }
        const activeCount = activeCountRow.value.value.count;
        if (activeCount >= CORE_NAMED_CLAUDE_ACTIVE_ATTEMPT_LIMIT) {
          return Result.err(
            transactionConflict(
              "publish-core-named-claude-success",
              "attempt-not-retained",
              "Too many active Core named Claude attempts are retained",
            ),
          );
        }
        const now = Date.now();
        this.db.run(
          `INSERT INTO core_named_claude_attempts (
           product, request_client, session_id, provider_id, source_terminal_request_id,
           source_canonical_head_hash, source_canonical_message_count,
           execution_scope_hash_version, execution_scope_hash, request_id, attempt_index,
           candidate_session_id, source_session_id, expected_binding_revision, state,
           created_ts, updated_ts
         ) VALUES ('core-named', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          [
            input.requestClient,
            input.lilacSessionId,
            input.providerId,
            binding?.terminalRequestId ?? null,
            binding?.canonicalHeadHash ?? null,
            binding?.canonicalMessageCount ?? null,
            input.executionScopeHash,
            input.requestId,
            input.attemptIndex,
            input.candidateSessionId,
            input.sourceSessionId,
            input.expectedBindingRevision,
            now,
            now,
          ],
        );
        this.pruneCoreNamedClaudeAttempts(input);
        const attempt = this.getCoreNamedClaudeSessionAttempt({
          providerId: input.providerId,
          requestClient: input.requestClient,
          lilacSessionId: input.lilacSessionId,
          requestId: input.requestId,
          attemptIndex: input.attemptIndex,
        });
        if (!attempt) {
          return Result.err(
            transactionConflict(
              "publish-core-named-claude-success",
              "attempt-not-retained",
              "Reserved Core named Claude attempt was not retained",
            ),
          );
        }
        return Result.ok(attempt);
      },
      (cause) => classifyTranscriptSqliteDriverFailure("reserve-core-named-claude-attempt", cause),
    );
    return reserve;
  }

  recordCoreNamedClaudeSessionAttemptOutcome(
    inputValue: RecordCoreNamedClaudeSessionAttemptOutcome,
  ): ResultType<CoreNamedClaudeSessionAttempt, CoreClaudeAttemptMutationError> {
    const input = inputValue;
    const record = runBunSqliteTransaction<
      CoreNamedClaudeSessionAttempt,
      TranscriptTransactionConflict,
      TranscriptStoreSqliteDriverFailure
    >(
      this.db,
      () => {
        const attemptKey = {
          providerId: input.providerId,
          requestClient: input.requestClient,
          lilacSessionId: input.lilacSessionId,
          requestId: input.requestId,
          attemptIndex: input.attemptIndex,
        } as const;
        const current = this.getCoreNamedClaudeSessionAttempt(attemptKey);
        if (!current) {
          return Result.err(
            transactionConflict(
              "publish-core-named-claude-success",
              "attempt-not-found",
              `Core named Claude attempt '${input.requestId}' was not found`,
            ),
          );
        }
        if (current.state !== "active") {
          if (current.state === input.state) return Result.ok(current);
          return Result.err(
            transactionConflict(
              "publish-core-named-claude-success",
              "attempt-terminal",
              `Core named Claude attempt is already terminal as '${current.state}'`,
            ),
          );
        }
        const now = Date.now();
        const updated = this.db.run(
          `UPDATE core_named_claude_attempts SET state = ?, updated_ts = ?
         WHERE request_client = ? AND session_id = ? AND provider_id = ?
           AND request_id = ? AND attempt_index = ? AND state = 'active'`,
          [
            input.state,
            now,
            input.requestClient,
            input.lilacSessionId,
            input.providerId,
            input.requestId,
            input.attemptIndex,
          ],
        );
        if (updated.changes !== 1) {
          return Result.err(
            transactionConflict(
              "publish-core-named-claude-success",
              "publication-fence-lost",
              "Core named Claude attempt lost its active fence",
            ),
          );
        }
        this.pruneCoreNamedClaudeAttempts(input);
        const attempt = this.getCoreNamedClaudeSessionAttempt(attemptKey);
        if (!attempt) {
          return Result.err(
            transactionConflict(
              "publish-core-named-claude-success",
              "attempt-not-retained",
              "Updated Core named Claude attempt was not retained",
            ),
          );
        }
        return Result.ok(attempt);
      },
      (cause) => classifyTranscriptSqliteDriverFailure("record-core-named-claude-outcome", cause),
    );
    return record;
  }

  publishCoreNamedClaudeSuccess(
    inputValue: PublishCoreNamedClaudeSuccess,
  ): ResultType<
    CoreNamedClaudeSessionAttempt,
    TranscriptStoreReadError | TranscriptTransactionConflict
  > {
    const input = inputValue;
    const now = Date.now();
    const providerStateJson = JSON.stringify(input.providerState);
    const transcriptRead = this.finalizeTransactionPersistenceDiagnostics(
      this.readRequestTranscriptForTransactionPreparation(input.terminalRequestId),
    );
    if (transcriptRead.status === "error") return Result.err(transcriptRead.error);
    const transcript = transcriptRead.value;
    const transcriptHash = transcript ? hashCanonicalMessagesV1(transcript.messages).hash : null;
    const transcriptDigest = transcript?.transcriptDigest ?? transcriptHash;
    const isVerifiedRecoveryTranscript =
      transcript !== null &&
      transcript.sessionId === input.lilacSessionId &&
      transcript.stableNamedRequestClient === undefined &&
      transcript.providerState == null &&
      transcript.messages.length === input.terminalCanonicalMessageCount &&
      transcriptHash === input.terminalCanonicalHeadHash;
    const isVerifiedSucceededTranscript =
      transcript !== null &&
      transcript.sessionId === input.lilacSessionId &&
      transcript.stableNamedRequestClient === input.requestClient &&
      transcript.providerState?.lastFamily === "claude-code" &&
      transcript.messages.length === input.terminalCanonicalMessageCount &&
      transcriptHash === input.terminalCanonicalHeadHash;
    const publication = runBunSqliteTransaction<
      ClaudePublicationOutcome<CoreNamedClaudeSessionAttempt>,
      TranscriptTransactionConflict,
      TranscriptStoreSqliteDriverFailure
    >(
      this.db,
      () => {
        if (input.terminalRequestId !== input.requestId) {
          return Result.err(
            transactionConflict(
              "publish-core-named-claude-success",
              "terminal-request-mismatch",
              "Core named Claude terminal request does not match its attempt",
            ),
          );
        }
        const attemptKey = {
          providerId: input.providerId,
          requestClient: input.requestClient,
          lilacSessionId: input.lilacSessionId,
          requestId: input.requestId,
          attemptIndex: input.attemptIndex,
        } as const;
        const current = this.getCoreNamedClaudeSessionAttempt(attemptKey);
        if (!current) {
          return Result.err(
            transactionConflict(
              "publish-core-named-claude-success",
              "attempt-not-found",
              `Core named Claude attempt '${input.requestId}' was not found`,
            ),
          );
        }
        if (current.state === "succeeded") {
          if (!isVerifiedSucceededTranscript) {
            return Result.err(
              transactionConflict(
                "publish-core-named-claude-success",
                "publication-verification-failed",
                "Core named Claude terminal transcript failed canonical verification",
              ),
            );
          }
          return Result.ok({ attempt: current, events: [] });
        }
        if (current.state !== "active") {
          return Result.err(
            transactionConflict(
              "publish-core-named-claude-success",
              "attempt-terminal",
              `Core named Claude attempt is already terminal as '${current.state}'`,
            ),
          );
        }
        if (!isVerifiedRecoveryTranscript || !transcript) {
          return Result.err(
            transactionConflict(
              "publish-core-named-claude-success",
              "publication-verification-failed",
              "Core named Claude recovery transcript failed publication verification",
            ),
          );
        }

        const published = this.db.run(
          `UPDATE request_transcripts
         SET provider_state_json = ?, stable_named_request_client = ?, updated_ts = ?
         WHERE request_id = ? AND provider_state_json IS NULL
           AND stable_named_request_client IS NULL AND session_id = ? AND transcript_digest = ?`,
          [
            providerStateJson,
            input.requestClient,
            now,
            input.terminalRequestId,
            input.lilacSessionId,
            transcriptDigest,
          ],
        );
        if (published.changes !== 1) {
          return Result.err(
            transactionConflict(
              "publish-core-named-claude-success",
              "publication-fence-lost",
              "Core named Claude transcript publication lost its unmarked fence",
            ),
          );
        }
        const succeeded = this.db.run(
          `UPDATE core_named_claude_attempts SET
           state = 'succeeded', terminal_request_id = ?, terminal_canonical_head_hash = ?,
           terminal_canonical_message_count = ?, native_cwd = ?, native_last_modified = ?,
           native_context_tokens = ?, native_context_max_tokens = ?, last_model_specifier = ?,
           last_reasoning = ?, updated_ts = ?
         WHERE request_client = ? AND session_id = ? AND provider_id = ?
           AND request_id = ? AND attempt_index = ? AND state = 'active'`,
          [
            input.terminalRequestId,
            input.terminalCanonicalHeadHash,
            input.terminalCanonicalMessageCount,
            input.nativeCwd,
            input.nativeLastModified,
            input.nativeContextTokens,
            input.nativeContextMaxTokens,
            input.lastModelSpecifier,
            input.lastReasoning,
            now,
            input.requestClient,
            input.lilacSessionId,
            input.providerId,
            input.requestId,
            input.attemptIndex,
          ],
        );
        if (succeeded.changes !== 1) {
          return Result.err(
            transactionConflict(
              "publish-core-named-claude-success",
              "publication-fence-lost",
              "Core named Claude success publication lost its active attempt fence",
            ),
          );
        }
        const pruneEvent = this.pruneCoreNamedClaudeAttemptsInTransaction(input);
        const attempt = this.getCoreNamedClaudeSessionAttempt(attemptKey);
        if (!attempt) {
          return Result.err(
            transactionConflict(
              "publish-core-named-claude-success",
              "attempt-not-retained",
              "Published Core named Claude attempt was not retained",
            ),
          );
        }
        return Result.ok({ attempt, events: pruneEvent ? [pruneEvent] : [] });
      },
      (cause) => classifyTranscriptSqliteDriverFailure("publish-core-named-claude-success", cause),
    );
    const finalized = publication;
    if (finalized.status === "error") return Result.err(finalized.error);
    this.emitDeferredTranscriptEvents(finalized.value.events);
    return Result.ok(finalized.value.attempt);
  }

  promoteCoreNamedClaudeSessionBinding(inputValue: {
    providerId: string;
    requestClient: AdapterPlatform;
    lilacSessionId: string;
    requestId: string;
    attemptIndex: number;
  }): ResultType<boolean, CoreClaudeAttemptMutationError> {
    const input = inputValue;
    return runBunSqliteTransaction<
      boolean,
      CoreClaudeBindingReadError,
      TranscriptStoreSqliteDriverFailure
    >(
      this.db,
      () => this.promoteCoreNamedClaudeAttempt(input),
      (cause) => classifyTranscriptSqliteDriverFailure("promote-core-named-claude-binding", cause),
    );
  }

  getCorePrimaryClaudeSessionBinding(inputValue: {
    providerId: string;
    requestClient: "discord";
    lilacSessionId: string;
  }): ResultType<CorePrimaryClaudeSessionBinding | null, CoreClaudeBindingReadError> {
    const input = inputValue;
    const read = this.readFromSqlite("get-core-primary-claude-binding", () =>
      this.readCorePrimaryClaudeSessionBinding(input),
    );
    return read.status === "ok" ? read.value : Result.err(read.error);
  }

  private readCorePrimaryClaudeSessionBinding(input: {
    providerId: string;
    requestClient: "discord";
    lilacSessionId: string;
  }): ResultType<CorePrimaryClaudeSessionBinding | null, CoreClaudeBindingReadError> {
    const row = this.db
      .query<CorePrimaryClaudeBindingRow, ["discord", string, string]>(
        `SELECT * FROM core_primary_claude_bindings
         WHERE request_client = ? AND session_id = ? AND provider_id = ?`,
      )
      .get(input.requestClient, input.lilacSessionId, input.providerId);
    if (!row) return Result.ok(null);
    const binding = this.parseVerifiedCorePrimaryBinding(row);
    if (binding.status === "ok") return Result.ok(binding.value);
    if (TranscriptStoreSqliteDriverFailure.is(binding.error)) return Result.err(binding.error);
    return Result.err(
      new CoreClaudeBindingCorrupt({
        bindingKind: "primary",
        providerId: input.providerId,
        requestClient: input.requestClient,
        lilacSessionId: input.lilacSessionId,
        message: "Core primary Claude binding is corrupt or unverifiable",
      }),
    );
  }

  getCoreRetentionDiagnostics(): ResultType<
    CoreRetentionDiagnostics,
    TranscriptTransactionConflict
  > {
    const count = (sql: string): ResultType<number, TranscriptTransactionConflict> => {
      const decoded = decodeTranscriptRow({
        storeKind: "count",
        row: this.db.query<DecodedTranscriptCountRow, []>(sql).get(),
        schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
        recordId: "retention-count",
      });
      if (decoded.status === "error") {
        return Result.err(
          transactionConflict(
            "publish-core-primary-claude-success",
            "publication-verification-failed",
            decoded.error.message,
          ),
        );
      }
      return Result.ok(decoded.value.value.count);
    };
    const blobMetricsRow = decodeTranscriptRow({
      storeKind: "blob-metrics",
      row: this.db
        .query<DecodedTranscriptBlobMetricsRow, []>(
          `SELECT
               COALESCE(SUM(blob.byte_length), 0) AS owned_bytes,
               COALESCE(SUM(CASE WHEN NOT EXISTS (
                 SELECT 1 FROM core_surface_projection_blobs AS reference
                 WHERE reference.blob_sha256 = blob.sha256
               ) THEN 1 ELSE 0 END), 0) AS unreferenced_count,
               COALESCE(SUM(CASE WHEN NOT EXISTS (
                 SELECT 1 FROM core_surface_projection_blobs AS reference
                 WHERE reference.blob_sha256 = blob.sha256
               ) THEN blob.byte_length ELSE 0 END), 0) AS unreferenced_bytes
             FROM core_owned_blobs AS blob`,
        )
        .get(),
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      recordId: "retention-blob-metrics",
    });
    if (blobMetricsRow.status === "error") {
      return Result.err(
        transactionConflict(
          "publish-core-primary-claude-success",
          "publication-verification-failed",
          blobMetricsRow.error.message,
        ),
      );
    }
    const blobMetrics = blobMetricsRow.value.value;
    return Result.gen(function* () {
      const namedBindingCount = yield* count(
        "SELECT COUNT(*) AS count FROM core_named_claude_bindings",
      );
      const primaryBindingCount = yield* count(
        "SELECT COUNT(*) AS count FROM core_primary_claude_bindings",
      );
      const activeAttemptCount = yield* count(
        `SELECT
           (SELECT COUNT(*) FROM core_named_claude_attempts WHERE state = 'active') +
           (SELECT COUNT(*) FROM core_primary_claude_attempts WHERE state = 'active') AS count`,
      );
      const terminalAttemptCount = yield* count(
        `SELECT
           (SELECT COUNT(*) FROM core_named_claude_attempts WHERE state <> 'active') +
           (SELECT COUNT(*) FROM core_primary_claude_attempts WHERE state <> 'active') AS count`,
      );
      const unverifiablePrimaryBindingCount = yield* count(
        `SELECT COUNT(*) AS count FROM core_primary_claude_bindings AS binding
         LEFT JOIN request_transcripts AS transcript
           ON transcript.request_id = binding.terminal_request_id
         LEFT JOIN core_primary_lineage_manifests AS manifest
           ON manifest.request_id = binding.terminal_request_id
          WHERE binding.terminal_request_id IS NULL OR transcript.request_id IS NULL
            OR manifest.request_id IS NULL`,
      );
      const orphanSucceededAttemptCount = yield* count(
        `SELECT
           (SELECT COUNT(*) FROM core_named_claude_attempts AS attempt
            LEFT JOIN request_transcripts AS transcript
              ON transcript.request_id = attempt.terminal_request_id
            WHERE attempt.state = 'succeeded' AND transcript.request_id IS NULL) +
           (SELECT COUNT(*) FROM core_primary_claude_attempts AS attempt
             LEFT JOIN request_transcripts AS transcript
               ON transcript.request_id = attempt.terminal_request_id
             WHERE attempt.state = 'succeeded' AND transcript.request_id IS NULL) AS count`,
      );
      const orphanManifestCount = yield* count(
        `SELECT COUNT(*) AS count FROM core_primary_lineage_manifests AS manifest
         LEFT JOIN request_transcripts AS transcript ON transcript.request_id = manifest.request_id
         WHERE transcript.request_id IS NULL`,
      );
      const unreferencedProjectionCount = yield* count(
        `SELECT COUNT(*) AS count FROM core_surface_projections AS projection
         WHERE NOT EXISTS (
           SELECT 1 FROM core_lineage_projection_refs AS reference
           WHERE reference.request_client = projection.request_client
             AND reference.surface_id = projection.surface_id
             AND reference.session_id = projection.session_id
             AND reference.message_id = projection.message_id
             AND reference.projection_format_version = projection.projection_format_version
         ) AND NOT EXISTS (
           SELECT 1 FROM core_lineage_request_alias_refs AS alias
           WHERE alias.request_client = projection.request_client
             AND alias.surface_id = projection.surface_id
             AND alias.session_id = projection.session_id
              AND alias.message_id = projection.message_id
              AND alias.projection_format_version = projection.projection_format_version
          )`,
      );
      return Result.ok({
        namedBindingCount,
        primaryBindingCount,
        activeAttemptCount,
        terminalAttemptCount,
        unverifiablePrimaryBindingCount,
        orphanSucceededAttemptCount,
        orphanManifestCount,
        unreferencedProjectionCount,
        ownedBlobBytes: blobMetrics.ownedBytes,
        unreferencedOwnedBlobCount: blobMetrics.unreferencedCount,
        unreferencedOwnedBlobBytes: blobMetrics.unreferencedBytes,
      });
    });
  }

  getCorePrimaryClaudeSessionAttempt(inputValue: {
    providerId: string;
    requestClient: "discord";
    lilacSessionId: string;
    requestId: string;
    attemptIndex: number;
  }): CorePrimaryClaudeSessionAttempt | null {
    const input = inputValue;
    const row = this.db
      .query<CorePrimaryClaudeAttemptRow, ["discord", string, string, string, number]>(
        `SELECT * FROM core_primary_claude_attempts
         WHERE request_client = ? AND session_id = ? AND provider_id = ?
           AND request_id = ? AND attempt_index = ?`,
      )
      .get(
        input.requestClient,
        input.lilacSessionId,
        input.providerId,
        input.requestId,
        input.attemptIndex,
      );
    return row ? toCorePrimaryClaudeAttempt(row) : null;
  }

  reserveCorePrimaryClaudeSessionAttempt(
    inputValue: ReserveCorePrimaryClaudeSessionAttempt,
  ): ResultType<CorePrimaryClaudeSessionAttempt, CoreClaudeAttemptMutationError> {
    const input = inputValue;
    const reserve = runBunSqliteTransaction<
      CorePrimaryClaudeSessionAttempt,
      CoreClaudeAttemptMutationError,
      TranscriptStoreSqliteDriverFailure
    >(
      this.db,
      () => {
        const bindingRead = this.readCorePrimaryClaudeSessionBinding({
          providerId: input.providerId,
          requestClient: input.requestClient,
          lilacSessionId: input.lilacSessionId,
        });
        if (bindingRead.status === "error") return Result.err(bindingRead.error);
        const binding = bindingRead.value;
        if (input.expectedBindingRevision === null) {
          if (binding !== null) {
            return Result.err(
              transactionConflict(
                "publish-core-primary-claude-success",
                "publication-fence-lost",
                "Core primary Claude binding changed before reservation",
              ),
            );
          }
        } else if (
          binding === null ||
          binding.revision !== input.expectedBindingRevision ||
          (input.sourceSessionId !== null &&
            (binding.claudeSessionId !== input.sourceSessionId ||
              binding.executionScopeHashVersion !== input.executionScopeHashVersion ||
              binding.executionScopeHash !== input.executionScopeHash))
        ) {
          return Result.err(
            transactionConflict(
              "publish-core-primary-claude-success",
              "publication-fence-lost",
              "Core primary Claude binding changed before reservation",
            ),
          );
        }
        const activeCountRow = decodeTranscriptRow({
          storeKind: "count",
          row: this.db
            .query<DecodedTranscriptCountRow, ["discord", string, string]>(
              `SELECT COUNT(*) AS count FROM core_primary_claude_attempts
             WHERE request_client = ? AND session_id = ? AND provider_id = ? AND state = 'active'`,
            )
            .get(input.requestClient, input.lilacSessionId, input.providerId),
          schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
          recordId: `primary-active:${input.lilacSessionId}:${input.providerId}`,
        });
        if (activeCountRow.status === "error") {
          return Result.err(
            transactionConflict(
              "publish-core-primary-claude-success",
              "publication-verification-failed",
              activeCountRow.error.message,
            ),
          );
        }
        const activeCount = activeCountRow.value.value.count;
        if (activeCount >= CORE_PRIMARY_CLAUDE_ACTIVE_ATTEMPT_LIMIT) {
          return Result.err(
            transactionConflict(
              "publish-core-primary-claude-success",
              "attempt-not-retained",
              "Too many active Core primary Claude attempts are retained",
            ),
          );
        }
        const now = Date.now();
        this.db.run(
          `INSERT INTO core_primary_claude_attempts (
           product, request_client, session_id, provider_id, source_lineage_version,
           source_atom_count, source_prefix_digest, source_canonical_message_count,
           execution_scope_hash_version, execution_scope_hash, request_id, attempt_index,
           candidate_session_id, source_session_id, expected_binding_revision, state,
           created_ts, updated_ts
         ) VALUES ('core-primary', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          [
            input.requestClient,
            input.lilacSessionId,
            input.providerId,
            binding?.lineageVersion ?? null,
            binding?.atomCount ?? null,
            binding?.prefixDigest ?? null,
            binding?.canonicalMessageCount ?? null,
            input.executionScopeHash,
            input.requestId,
            input.attemptIndex,
            input.candidateSessionId,
            input.sourceSessionId,
            input.expectedBindingRevision,
            now,
            now,
          ],
        );
        this.pruneCorePrimaryClaudeAttempts(input);
        const attempt = this.getCorePrimaryClaudeSessionAttempt({
          providerId: input.providerId,
          requestClient: input.requestClient,
          lilacSessionId: input.lilacSessionId,
          requestId: input.requestId,
          attemptIndex: input.attemptIndex,
        });
        if (!attempt) {
          return Result.err(
            transactionConflict(
              "publish-core-primary-claude-success",
              "attempt-not-retained",
              "Reserved Core primary Claude attempt was not retained",
            ),
          );
        }
        return Result.ok(attempt);
      },
      (cause) =>
        classifyTranscriptSqliteDriverFailure("reserve-core-primary-claude-attempt", cause),
    );
    return reserve;
  }

  recordCorePrimaryClaudeSessionAttemptOutcome(
    inputValue: RecordCorePrimaryClaudeSessionAttemptOutcome,
  ): ResultType<CorePrimaryClaudeSessionAttempt, CoreClaudeAttemptMutationError> {
    const input = inputValue;
    const record = runBunSqliteTransaction<
      CorePrimaryClaudeSessionAttempt,
      TranscriptTransactionConflict,
      TranscriptStoreSqliteDriverFailure
    >(
      this.db,
      () => {
        const attemptKey = {
          providerId: input.providerId,
          requestClient: input.requestClient,
          lilacSessionId: input.lilacSessionId,
          requestId: input.requestId,
          attemptIndex: input.attemptIndex,
        } as const;
        const current = this.getCorePrimaryClaudeSessionAttempt(attemptKey);
        if (!current) {
          return Result.err(
            transactionConflict(
              "publish-core-primary-claude-success",
              "attempt-not-found",
              `Core primary Claude attempt '${input.requestId}' was not found`,
            ),
          );
        }
        if (current.state !== "active") {
          if (current.state === input.state) return Result.ok(current);
          return Result.err(
            transactionConflict(
              "publish-core-primary-claude-success",
              "attempt-terminal",
              `Core primary Claude attempt is already terminal as '${current.state}'`,
            ),
          );
        }
        const updated = this.db.run(
          `UPDATE core_primary_claude_attempts SET state = ?, updated_ts = ?
         WHERE request_client = ? AND session_id = ? AND provider_id = ?
           AND request_id = ? AND attempt_index = ? AND state = 'active'`,
          [
            input.state,
            Date.now(),
            input.requestClient,
            input.lilacSessionId,
            input.providerId,
            input.requestId,
            input.attemptIndex,
          ],
        );
        if (updated.changes !== 1) {
          return Result.err(
            transactionConflict(
              "publish-core-primary-claude-success",
              "publication-fence-lost",
              "Core primary Claude attempt lost its active fence",
            ),
          );
        }
        this.pruneCorePrimaryClaudeAttempts(input);
        const attempt = this.getCorePrimaryClaudeSessionAttempt(attemptKey);
        if (!attempt) {
          return Result.err(
            transactionConflict(
              "publish-core-primary-claude-success",
              "attempt-not-retained",
              "Updated Core primary Claude attempt was not retained",
            ),
          );
        }
        return Result.ok(attempt);
      },
      (cause) => classifyTranscriptSqliteDriverFailure("record-core-primary-claude-outcome", cause),
    );
    return record;
  }

  publishCorePrimaryClaudeSuccess(
    inputValue: PublishCorePrimaryClaudeSuccess,
  ): ResultType<
    CorePrimaryClaudeSessionAttempt,
    TranscriptStoreReadError | TranscriptTransactionConflict
  > {
    const input = inputValue;
    const now = Date.now();
    const providerStateJson = JSON.stringify(input.providerState);
    const transcriptRead = this.finalizeTransactionPersistenceDiagnostics(
      this.readRequestTranscriptForTransactionPreparation(input.terminalRequestId),
    );
    if (transcriptRead.status === "error") return Result.err(transcriptRead.error);
    const lineageRead = this.finalizeTransactionPersistenceDiagnostics(
      this.readCorePrimaryLineageForTransactionPreparation(input.terminalRequestId),
    );
    if (lineageRead.status === "error") return Result.err(lineageRead.error);
    const transcript = transcriptRead.value;
    const lineage = lineageRead.value;
    const transcriptDigest = transcript
      ? (transcript.transcriptDigest ?? hashCanonicalMessagesV1(transcript.messages).hash)
      : null;
    let recoveryHead: CorePrimaryClaudeBindingHead | null = null;
    if (transcript && lineage && transcriptDigest !== null && transcript.messages.length > 0) {
      const computed = computeCorePrimaryClaudeTerminalHead({
        manifest: lineage.manifest,
        requestId: transcript.requestId,
        transcriptDigest,
        responseMessageCount: transcript.messages.length,
        providerState: input.providerState,
      });
      if (computed.status === "error") return Result.err(computed.error);
      recoveryHead = computed.value;
    }
    let succeededHead: CorePrimaryClaudeBindingHead | null = null;
    if (
      transcript?.providerState &&
      lineage &&
      transcriptDigest !== null &&
      transcript.messages.length > 0
    ) {
      const computed = computeCorePrimaryClaudeTerminalHead({
        manifest: lineage.manifest,
        requestId: transcript.requestId,
        transcriptDigest,
        responseMessageCount: transcript.messages.length,
        providerState: transcript.providerState,
      });
      if (computed.status === "error") return Result.err(computed.error);
      succeededHead = computed.value;
    }
    const headMatchesInput = (head: CorePrimaryClaudeBindingHead | null) =>
      head !== null &&
      head.lineageVersion === input.terminalLineageVersion &&
      head.atomCount === input.terminalAtomCount &&
      head.prefixDigest === input.terminalPrefixDigest &&
      head.canonicalMessageCount === input.terminalCanonicalMessageCount;
    const isVerifiedRecoveryTerminal =
      transcript !== null &&
      lineage !== null &&
      transcript.requestClient === input.requestClient &&
      transcript.sessionId === input.lilacSessionId &&
      transcript.providerState == null &&
      transcript.stableNamedRequestClient === undefined &&
      transcript.contextMeta === undefined &&
      headMatchesInput(recoveryHead);
    const isVerifiedSucceededTerminal =
      transcript !== null &&
      lineage !== null &&
      transcript.requestClient === input.requestClient &&
      transcript.sessionId === input.lilacSessionId &&
      transcript.providerState?.lastFamily === "claude-code" &&
      transcript.contextMeta === undefined &&
      headMatchesInput(succeededHead);
    const publication = runBunSqliteTransaction<
      ClaudePublicationOutcome<CorePrimaryClaudeSessionAttempt>,
      TranscriptTransactionConflict,
      TranscriptStoreSqliteDriverFailure
    >(
      this.db,
      () => {
        if (input.terminalRequestId !== input.requestId) {
          return Result.err(
            transactionConflict(
              "publish-core-primary-claude-success",
              "terminal-request-mismatch",
              "Core primary Claude terminal request does not match its attempt",
            ),
          );
        }
        const attemptKey = {
          providerId: input.providerId,
          requestClient: input.requestClient,
          lilacSessionId: input.lilacSessionId,
          requestId: input.requestId,
          attemptIndex: input.attemptIndex,
        } as const;
        const current = this.getCorePrimaryClaudeSessionAttempt(attemptKey);
        if (!current) {
          return Result.err(
            transactionConflict(
              "publish-core-primary-claude-success",
              "attempt-not-found",
              `Core primary Claude attempt '${input.requestId}' was not found`,
            ),
          );
        }
        if (current.state === "succeeded") {
          if (!isVerifiedSucceededTerminal) {
            return Result.err(
              transactionConflict(
                "publish-core-primary-claude-success",
                "publication-verification-failed",
                "Core primary Claude terminal transcript failed canonical verification",
              ),
            );
          }
          return Result.ok({ attempt: current, events: [] });
        }
        if (current.state !== "active") {
          return Result.err(
            transactionConflict(
              "publish-core-primary-claude-success",
              "attempt-terminal",
              `Core primary Claude attempt is already terminal as '${current.state}'`,
            ),
          );
        }
        if (!isVerifiedRecoveryTerminal || !transcript || !lineage || transcriptDigest === null) {
          return Result.err(
            transactionConflict(
              "publish-core-primary-claude-success",
              "publication-verification-failed",
              "Core primary Claude recovery transcript failed publication verification",
            ),
          );
        }
        const published = this.db.run(
          `UPDATE request_transcripts SET provider_state_json = ?, updated_ts = ?
         WHERE request_id = ? AND provider_state_json IS NULL
           AND stable_named_request_client IS NULL AND request_client = ? AND session_id = ?
           AND transcript_digest = ? AND EXISTS (
             SELECT 1 FROM core_primary_lineage_manifests
             WHERE request_id = ? AND lineage_version = 1 AND manifest_json = ?
           )`,
          [
            providerStateJson,
            now,
            input.terminalRequestId,
            input.requestClient,
            input.lilacSessionId,
            transcriptDigest,
            input.terminalRequestId,
            lineage.manifestJson,
          ],
        );
        if (published.changes !== 1) {
          return Result.err(
            transactionConflict(
              "publish-core-primary-claude-success",
              "publication-fence-lost",
              "Core primary Claude transcript publication lost its unmarked fence",
            ),
          );
        }
        const succeeded = this.db.run(
          `UPDATE core_primary_claude_attempts SET
           state = 'succeeded', terminal_request_id = ?, terminal_lineage_version = 1,
           terminal_atom_count = ?, terminal_prefix_digest = ?,
           terminal_canonical_message_count = ?, native_cwd = ?, native_last_modified = ?,
           native_context_tokens = ?, native_context_max_tokens = ?, last_model_specifier = ?,
           last_reasoning = ?, updated_ts = ?
         WHERE request_client = ? AND session_id = ? AND provider_id = ?
           AND request_id = ? AND attempt_index = ? AND state = 'active'`,
          [
            input.terminalRequestId,
            input.terminalAtomCount,
            input.terminalPrefixDigest,
            input.terminalCanonicalMessageCount,
            input.nativeCwd,
            input.nativeLastModified,
            input.nativeContextTokens,
            input.nativeContextMaxTokens,
            input.lastModelSpecifier,
            input.lastReasoning,
            now,
            input.requestClient,
            input.lilacSessionId,
            input.providerId,
            input.requestId,
            input.attemptIndex,
          ],
        );
        if (succeeded.changes !== 1) {
          return Result.err(
            transactionConflict(
              "publish-core-primary-claude-success",
              "publication-fence-lost",
              "Core primary Claude success publication lost its active attempt fence",
            ),
          );
        }
        const pruneEvent = this.pruneCorePrimaryClaudeAttemptsInTransaction(input);
        const attempt = this.getCorePrimaryClaudeSessionAttempt(attemptKey);
        if (!attempt) {
          return Result.err(
            transactionConflict(
              "publish-core-primary-claude-success",
              "attempt-not-retained",
              "Published Core primary Claude attempt was not retained",
            ),
          );
        }
        return Result.ok({ attempt, events: pruneEvent ? [pruneEvent] : [] });
      },
      (cause) =>
        classifyTranscriptSqliteDriverFailure("publish-core-primary-claude-success", cause),
    );
    const finalized = publication;
    if (finalized.status === "error") return Result.err(finalized.error);
    this.emitDeferredTranscriptEvents(finalized.value.events);
    return Result.ok(finalized.value.attempt);
  }

  promoteCorePrimaryClaudeSessionBinding(inputValue: {
    providerId: string;
    requestClient: "discord";
    lilacSessionId: string;
    requestId: string;
    attemptIndex: number;
  }): ResultType<boolean, CoreClaudeAttemptMutationError> {
    const input = inputValue;
    return runBunSqliteTransaction<
      boolean,
      CoreClaudeBindingReadError,
      TranscriptStoreSqliteDriverFailure
    >(
      this.db,
      () => this.promoteCorePrimaryClaudeAttempt(input),
      (cause) =>
        classifyTranscriptSqliteDriverFailure("promote-core-primary-claude-binding", cause),
    );
  }

  listSurfaceMessagesForRequest(input: { requestId: string }): MsgRef[] {
    const rows = this.db
      .query<PersistedSurfaceMessageLinkRow, [string]>(
        `
        SELECT request_id, platform, channel_id, message_id
        FROM surface_message_to_request
        WHERE request_id = ?
        ORDER BY created_ts ASC, rowid ASC
        `,
      )
      .all(input.requestId);

    const refs: MsgRef[] = [];
    for (const row of rows) {
      const decoded = decodeSurfaceMessageLinkRow({
        row,
        schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
        recordId: typeof row.request_id === "string" ? row.request_id : "unknown-record",
      });
      if (decoded.status === "error") {
        this.reportPersistenceError(decoded.error);
        continue;
      }
      const ref = projectBuiltinSurfaceMessageRef(decoded.value.value);
      if (ref) refs.push(ref);
    }

    return refs;
  }

  listRecentAgentWrites(input?: {
    limit?: number;
    offset?: number;
    client?: AdapterPlatform;
  }): RecentAgentWriteSnapshot[] {
    const limit = Math.min(200, Math.max(1, Math.floor(input?.limit ?? 20)));
    const offset = Math.max(0, Math.floor(input?.offset ?? 0));
    const client = input?.client ?? null;

    const rows = this.db
      .query<PersistedRecentAgentWriteRow, [AdapterPlatform | null, number, number]>(
        `
        SELECT
          rt.request_id,
          sm.platform,
          sm.channel_id,
          sm.message_id,
          rt.updated_ts,
          rt.final_text
        FROM request_transcripts rt
        JOIN surface_message_to_request sm
          ON sm.request_id = rt.request_id
        WHERE sm.rowid = (
          SELECT sm2.rowid
          FROM surface_message_to_request sm2
          WHERE sm2.request_id = sm.request_id
            AND sm2.platform = sm.platform
            AND sm2.channel_id = sm.channel_id
          ORDER BY sm2.created_ts DESC, sm2.rowid DESC
          LIMIT 1
        )
          AND (?1 IS NULL OR sm.platform = ?1)
        ORDER BY rt.updated_ts DESC, rt.created_ts DESC, sm.created_ts DESC, sm.rowid DESC
        LIMIT ?2 OFFSET ?3
        `,
      )
      .all(client, limit, offset);

    const out: RecentAgentWriteSnapshot[] = [];
    for (const row of rows) {
      const decoded = decodeRecentAgentWriteRow({
        row,
        schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
        recordId: typeof row.request_id === "string" ? row.request_id : "unknown-record",
      });
      if (decoded.status === "error") {
        this.reportPersistenceError(decoded.error);
        continue;
      }
      const value = decoded.value.value;
      const ref = projectBuiltinSurfaceMessageRef({
        platform: value.platform,
        channelId: value.channelId,
        messageId: value.messageId,
      });
      if (!ref) continue;
      out.push({
        requestId: value.requestId,
        sessionId: ref.channelId,
        client: ref.platform,
        messageId: ref.messageId,
        updatedTs: value.updatedTs,
        finalText: value.finalText ?? undefined,
      });
    }

    return out;
  }

  listDiscoveryRecords(): TranscriptDiscoveryRecord[] {
    const rows = this.db
      .query<PersistedDiscoveryRecordRow, []>(
        `
        SELECT
          rt.request_id,
          rt.session_id,
          rt.request_client,
          rt.updated_ts,
          rt.final_text,
          sm.platform AS surface_platform,
          sm.channel_id AS surface_channel_id,
          sm.message_id AS surface_message_id,
          sm.created_ts AS surface_created_ts
        FROM request_transcripts rt
        LEFT JOIN surface_message_to_request sm
          ON sm.request_id = rt.request_id
        ORDER BY rt.updated_ts DESC, rt.created_ts DESC, sm.created_ts ASC, sm.rowid ASC
        `,
      )
      .all();

    const byRequestId = new Map<string, TranscriptDiscoveryRecord>();
    for (const row of rows) {
      const decoded = decodeDiscoveryRecordRow({
        row,
        schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
        recordId: typeof row.request_id === "string" ? row.request_id : "unknown-record",
      });
      if (decoded.status === "error") {
        this.reportPersistenceError(decoded.error);
        continue;
      }
      const value = decoded.value.value;
      let record = byRequestId.get(value.requestId);
      if (!record) {
        record = {
          requestId: value.requestId,
          sessionId: value.sessionId,
          requestClient: value.requestClient,
          updatedTs: value.updatedTs,
          finalText: value.finalText ?? undefined,
          surfaceRefs: [],
        };
        byRequestId.set(value.requestId, record);
      }

      if (!value.surfaceRef) continue;
      const ref = projectBuiltinSurfaceMessageRef(value.surfaceRef);
      if (ref) record.surfaceRefs.push(ref);
    }

    return [...byRequestId.values()];
  }

  private assertVerifiedCoreNamedTerminal(input: {
    requestClient: AdapterPlatform;
    lilacSessionId: string;
    terminalRequestId: string;
    canonicalHeadHash: string;
    canonicalMessageCount: number;
  }): ResultType<TranscriptSnapshot, TranscriptStoreReadError | TranscriptTransactionConflict> {
    const read = this.getRequestTranscript({ requestId: input.terminalRequestId });
    if (read.status === "error") return Result.err(read.error);
    const transcript = read.value;
    if (
      !transcript ||
      transcript.sessionId !== input.lilacSessionId ||
      transcript.stableNamedRequestClient !== input.requestClient ||
      transcript.providerState?.lastFamily !== "claude-code" ||
      transcript.messages.length !== input.canonicalMessageCount ||
      hashCanonicalMessagesV1(transcript.messages).hash !== input.canonicalHeadHash
    ) {
      return Result.err(
        transactionConflict(
          "publish-core-named-claude-success",
          "publication-verification-failed",
          "Core named Claude terminal transcript failed canonical verification",
        ),
      );
    }
    return Result.ok(transcript);
  }

  private promoteCoreNamedClaudeAttempt(input: {
    providerId: string;
    requestClient: AdapterPlatform;
    lilacSessionId: string;
    requestId: string;
    attemptIndex: number;
  }): ResultType<boolean, CoreClaudeBindingReadError> {
    const attempt = this.getCoreNamedClaudeSessionAttempt(input);
    if (
      !attempt ||
      attempt.state !== "succeeded" ||
      attempt.terminalRequestId === null ||
      attempt.terminalCanonicalHeadHash === null ||
      attempt.terminalCanonicalMessageCount === null ||
      attempt.nativeCwd === null ||
      attempt.nativeLastModified === null ||
      attempt.nativeContextTokens === null ||
      attempt.nativeContextMaxTokens === null ||
      attempt.lastModelSpecifier === null ||
      attempt.lastReasoning === null
    ) {
      return Result.ok(false);
    }
    const verified = this.assertVerifiedCoreNamedTerminal({
      requestClient: attempt.requestClient,
      lilacSessionId: attempt.lilacSessionId,
      terminalRequestId: attempt.terminalRequestId,
      canonicalHeadHash: attempt.terminalCanonicalHeadHash,
      canonicalMessageCount: attempt.terminalCanonicalMessageCount,
    });
    if (verified.status === "error") {
      this.failSucceededCoreNamedAttempt(attempt);
      return Result.ok(false);
    }

    const currentRead = this.readCoreNamedClaudeSessionBinding({
      providerId: input.providerId,
      requestClient: input.requestClient,
      lilacSessionId: input.lilacSessionId,
    });
    if (currentRead.status === "error") return Result.err(currentRead.error);
    const current = currentRead.value;
    if (
      current?.claudeSessionId === attempt.candidateSessionId &&
      current.terminalRequestId === attempt.terminalRequestId &&
      current.canonicalHeadHash === attempt.terminalCanonicalHeadHash &&
      current.canonicalMessageCount === attempt.terminalCanonicalMessageCount
    ) {
      return Result.ok(true);
    }
    const sourceMatches =
      attempt.expectedBindingRevision === null
        ? current === null
        : current !== null &&
          current.revision === attempt.expectedBindingRevision &&
          current.terminalRequestId === attempt.sourceTerminalRequestId &&
          current.canonicalHeadHash === attempt.sourceCanonicalHeadHash &&
          current.canonicalMessageCount === attempt.sourceCanonicalMessageCount;
    if (!sourceMatches) {
      this.failSucceededCoreNamedAttempt(attempt);
      return Result.ok(false);
    }

    const revision = (current?.revision ?? 0) + 1;
    this.db.run(
      `INSERT INTO core_named_claude_bindings (
         request_client, session_id, provider_id, binding_protocol_version, provider_family,
         terminal_request_id, canonical_hash_version, canonical_head_hash,
         canonical_message_count, execution_scope_hash_version, execution_scope_hash,
         claude_session_id, native_cwd, native_last_modified, native_context_tokens,
         native_context_max_tokens, last_model_specifier, last_reasoning, revision, updated_ts
       ) VALUES (?, ?, ?, 1, 'claude-code', ?, 1, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(request_client, session_id, provider_id) DO UPDATE SET
         terminal_request_id = excluded.terminal_request_id,
         canonical_head_hash = excluded.canonical_head_hash,
         canonical_message_count = excluded.canonical_message_count,
         execution_scope_hash = excluded.execution_scope_hash,
         claude_session_id = excluded.claude_session_id,
         native_cwd = excluded.native_cwd,
         native_last_modified = excluded.native_last_modified,
         native_context_tokens = excluded.native_context_tokens,
         native_context_max_tokens = excluded.native_context_max_tokens,
         last_model_specifier = excluded.last_model_specifier,
         last_reasoning = excluded.last_reasoning,
         revision = excluded.revision,
         updated_ts = excluded.updated_ts`,
      [
        attempt.requestClient,
        attempt.lilacSessionId,
        attempt.providerId,
        attempt.terminalRequestId,
        attempt.terminalCanonicalHeadHash,
        attempt.terminalCanonicalMessageCount,
        attempt.executionScopeHash,
        attempt.candidateSessionId,
        attempt.nativeCwd,
        attempt.nativeLastModified,
        attempt.nativeContextTokens,
        attempt.nativeContextMaxTokens,
        attempt.lastModelSpecifier,
        attempt.lastReasoning,
        revision,
        Date.now(),
      ],
    );
    return Result.ok(true);
  }

  private failSucceededCoreNamedAttempt(attempt: CoreNamedClaudeSessionAttempt): void {
    this.db.run(
      `UPDATE core_named_claude_attempts SET state = 'failed', updated_ts = ?
       WHERE request_client = ? AND session_id = ? AND provider_id = ?
         AND request_id = ? AND attempt_index = ? AND state = 'succeeded'`,
      [
        Date.now(),
        attempt.requestClient,
        attempt.lilacSessionId,
        attempt.providerId,
        attempt.requestId,
        attempt.attemptIndex,
      ],
    );
  }

  private emitLifecycleDiagnostic(
    level: "debug" | "info" | "warn",
    event: string,
    detail: Readonly<Record<string, unknown>>,
  ): void {
    if (level === "debug") logger.debug(event, detail);
    else if (level === "info") logger.info(event, detail);
    else logger.warn(event, detail);
    this.onLifecycleDiagnostic?.(level, event, detail);
  }

  private canRecoverCoreNamedPromotion(attempt: CoreNamedClaudeSessionAttempt): boolean {
    const current = this.db
      .query<CoreNamedClaudeBindingRow, [AdapterPlatform, string, string]>(
        `SELECT * FROM core_named_claude_bindings
         WHERE request_client = ? AND session_id = ? AND provider_id = ?`,
      )
      .get(attempt.requestClient, attempt.lilacSessionId, attempt.providerId);
    if (attempt.expectedBindingRevision === null) return current === null;
    return (
      current !== null &&
      current.revision === attempt.expectedBindingRevision &&
      current.terminal_request_id === attempt.sourceTerminalRequestId &&
      current.canonical_head_hash === attempt.sourceCanonicalHeadHash &&
      current.canonical_message_count === attempt.sourceCanonicalMessageCount &&
      (attempt.sourceSessionId === null || current.claude_session_id === attempt.sourceSessionId)
    );
  }

  private emitCoreNamedRecoveryPromotion(
    attempt: CoreNamedClaudeSessionAttempt,
    promoted: boolean,
  ): void {
    this.emitLifecycleDiagnostic(
      promoted ? "info" : "warn",
      "core_named_claude.promotion_recovered",
      {
        requestId: attempt.requestId,
        sessionId: attempt.lilacSessionId,
        requestClient: attempt.requestClient,
        providerId: attempt.providerId,
        mode: "cas",
        reason: promoted ? "binding-promoted" : "promotion-rejected",
        outcome: promoted ? "promoted" : "rejected",
        promoted,
        bindingRevision: attempt.expectedBindingRevision,
        model: attempt.lastModelSpecifier,
        reasoning: attempt.lastReasoning,
      },
    );
  }

  private recoverCoreNamedClaudeAttempts(): void {
    const interrupted = this.db
      .query<CoreNamedClaudeAttemptRow, []>(
        "SELECT * FROM core_named_claude_attempts WHERE state = 'active'",
      )
      .all();
    const recoverActive = this.db.transaction(() => {
      this.db.run(
        "UPDATE core_named_claude_attempts SET state = 'uncertain', updated_ts = ? WHERE state = 'active'",
        [Date.now()],
      );
    });
    recoverActive.immediate();
    for (const row of interrupted) {
      this.emitLifecycleDiagnostic("debug", "core_named_claude.attempt_recovered", {
        requestId: row.request_id,
        sessionId: row.session_id,
        requestClient: row.request_client,
        providerId: row.provider_id,
        mode: "recovery",
        outcome: "uncertain",
        reason: "runtime-restart",
        bindingHead: row.source_canonical_head_hash,
        bindingRevision: row.expected_binding_revision,
        model: row.last_model_specifier,
        reasoning: row.last_reasoning,
      });
    }

    const pending = this.db
      .query<CoreNamedClaudeAttemptRow, []>(
        `SELECT attempt.* FROM core_named_claude_attempts AS attempt
         WHERE attempt.state = 'succeeded' AND NOT EXISTS (
           SELECT 1 FROM core_named_claude_bindings AS binding
           WHERE binding.request_client = attempt.request_client
             AND binding.session_id = attempt.session_id
             AND binding.provider_id = attempt.provider_id
             AND binding.claude_session_id = attempt.candidate_session_id
             AND binding.terminal_request_id = attempt.terminal_request_id
             AND binding.canonical_head_hash = attempt.terminal_canonical_head_hash
             AND binding.canonical_message_count = attempt.terminal_canonical_message_count
         )`,
      )
      .all();
    for (const row of pending) {
      const attempt = toCoreNamedClaudeAttempt(row);
      if (!attempt) {
        this.emitLifecycleDiagnostic("warn", "core_named_claude.promotion_recovery_failed", {
          requestId: row.request_id,
          sessionId: row.session_id,
          requestClient: row.request_client,
          providerId: row.provider_id,
          mode: "decode",
          reason: "corrupt-attempt-row",
        });
        continue;
      }
      if (!this.canRecoverCoreNamedPromotion(attempt)) {
        this.failSucceededCoreNamedAttempt(attempt);
        this.emitCoreNamedRecoveryPromotion(attempt, false);
        continue;
      }
      const promotion = this.promoteCoreNamedClaudeSessionBinding({
        providerId: attempt.providerId,
        requestClient: attempt.requestClient,
        lilacSessionId: attempt.lilacSessionId,
        requestId: attempt.requestId,
        attemptIndex: attempt.attemptIndex,
      });
      if (promotion.status === "ok") {
        this.emitCoreNamedRecoveryPromotion(attempt, promotion.value);
      } else {
        this.emitLifecycleDiagnostic("warn", "core_named_claude.promotion_recovery_failed", {
          requestId: attempt.requestId,
          sessionId: attempt.lilacSessionId,
          requestClient: attempt.requestClient,
          providerId: attempt.providerId,
          mode: "cas",
          reason: "promotion-failed",
          bindingRevision: attempt.expectedBindingRevision,
          model: attempt.lastModelSpecifier,
          reasoning: attempt.lastReasoning,
          errorTag: coreClaudeAttemptMutationErrorTag(promotion.error),
        });
      }
    }
    const owners = this.db
      .query<{ request_client: string; session_id: string; provider_id: string }, []>(
        `SELECT DISTINCT request_client, session_id, provider_id
         FROM core_named_claude_attempts`,
      )
      .all();
    for (const owner of owners) {
      const requestClient = owner.request_client as AdapterPlatform;
      this.pruneCoreNamedClaudeAttempts({
        requestClient,
        lilacSessionId: owner.session_id,
        providerId: owner.provider_id,
      });
    }
  }

  private pruneCoreNamedClaudeAttempts(input: {
    requestClient: AdapterPlatform;
    lilacSessionId: string;
    providerId: string;
  }): void {
    const event = this.pruneCoreNamedClaudeAttemptsInTransaction(input);
    if (event) this.emitDeferredTranscriptEvents([event]);
  }

  private pruneCoreNamedClaudeAttemptsInTransaction(input: {
    requestClient: AdapterPlatform;
    lilacSessionId: string;
    providerId: string;
  }): DeferredTranscriptEvent | undefined {
    const pruned = this.db.run(
      `DELETE FROM core_named_claude_attempts
       WHERE rowid IN (
         SELECT rowid FROM core_named_claude_attempts
         WHERE request_client = ? AND session_id = ? AND provider_id = ? AND state <> 'active'
         ORDER BY updated_ts DESC, rowid DESC
         LIMIT -1 OFFSET ?
       )`,
      [
        input.requestClient,
        input.lilacSessionId,
        input.providerId,
        CORE_NAMED_CLAUDE_ATTEMPT_RETENTION_LIMIT,
      ],
    ).changes;
    if (pruned > 0) {
      return {
        kind: "log",
        event: "core_named_claude.orphan_metadata_pruned",
        detail: {
          requestClient: input.requestClient,
          sessionId: input.lilacSessionId,
          providerId: input.providerId,
          attemptCount: pruned,
          reason: "terminal-count-bound",
        },
      };
    }
    return undefined;
  }

  private assertVerifiedCorePrimaryTerminal(input: {
    requestClient: "discord";
    lilacSessionId: string;
    terminalRequestId: string;
    terminalLineageVersion: 1;
    terminalAtomCount: number;
    terminalPrefixDigest: string;
    terminalCanonicalMessageCount: number;
  }): ResultType<TranscriptSnapshot, TranscriptStoreReadError | TranscriptTransactionConflict> {
    const transcriptRead = this.getRequestTranscript({ requestId: input.terminalRequestId });
    if (transcriptRead.status === "error") return Result.err(transcriptRead.error);
    const manifestRead = this.getCorePrimaryLineageManifest({ requestId: input.terminalRequestId });
    if (manifestRead.status === "error") return Result.err(manifestRead.error);
    const transcript = transcriptRead.value;
    const manifest = manifestRead.value;
    if (
      !transcript ||
      !manifest ||
      transcript.requestClient !== input.requestClient ||
      transcript.sessionId !== input.lilacSessionId ||
      transcript.providerState?.lastFamily !== "claude-code" ||
      transcript.contextMeta !== undefined ||
      transcript.messages.length === 0
    ) {
      return Result.err(
        transactionConflict(
          "publish-core-primary-claude-success",
          "publication-verification-failed",
          "Core primary Claude terminal transcript failed canonical verification",
        ),
      );
    }
    const head = computeCorePrimaryClaudeTerminalHead({
      manifest,
      requestId: transcript.requestId,
      transcriptDigest:
        transcript.transcriptDigest ?? hashCanonicalMessagesV1(transcript.messages).hash,
      responseMessageCount: transcript.messages.length,
      providerState: transcript.providerState,
    });
    if (head.status === "error") return Result.err(head.error);
    if (
      head.value.lineageVersion !== input.terminalLineageVersion ||
      head.value.atomCount !== input.terminalAtomCount ||
      head.value.prefixDigest !== input.terminalPrefixDigest ||
      head.value.canonicalMessageCount !== input.terminalCanonicalMessageCount
    ) {
      return Result.err(
        transactionConflict(
          "publish-core-primary-claude-success",
          "publication-verification-failed",
          "Core primary Claude terminal lineage failed canonical verification",
        ),
      );
    }
    return Result.ok(transcript);
  }

  private findCorePrimaryTerminalRequestId(binding: CorePrimaryClaudeBindingRow): string | null {
    const decodedBindingResult = decodeCorePrimaryClaudeBinding({
      ...binding,
      terminal_request_id: binding.terminal_request_id ?? "legacy-terminal-candidate",
    });
    if (decodedBindingResult.status === "error") return null;
    const decodedBinding = decodedBindingResult.value;
    const candidates = new Set<string>();
    const attemptRows = this.db
      .query<
        { terminal_request_id: string },
        [string, string, string, string, number, number, string, number]
      >(
        `SELECT terminal_request_id FROM core_primary_claude_attempts
         WHERE request_client = ? AND session_id = ? AND provider_id = ?
           AND state = 'succeeded' AND terminal_request_id IS NOT NULL
           AND candidate_session_id = ? AND terminal_lineage_version = ?
           AND terminal_atom_count = ? AND terminal_prefix_digest = ?
           AND terminal_canonical_message_count = ?
         ORDER BY updated_ts DESC, rowid DESC`,
      )
      .all(
        binding.request_client,
        binding.session_id,
        binding.provider_id,
        binding.claude_session_id,
        binding.lineage_version,
        binding.atom_count,
        binding.prefix_digest,
        binding.canonical_message_count,
      );
    for (const row of attemptRows) candidates.add(row.terminal_request_id);

    const durableRows = this.db
      .query<{ request_id: string }, [string, string]>(
        `SELECT transcript.request_id
         FROM request_transcripts AS transcript
         JOIN core_primary_lineage_manifests AS manifest
           ON manifest.request_id = transcript.request_id
         WHERE transcript.request_client = ? AND transcript.session_id = ?
           AND transcript.provider_state_json IS NOT NULL
           AND transcript.context_meta_json IS NULL
         ORDER BY transcript.updated_ts DESC, transcript.created_ts DESC, transcript.rowid DESC`,
      )
      .all(binding.request_client, binding.session_id);
    for (const row of durableRows) candidates.add(row.request_id);

    for (const terminalRequestId of candidates) {
      const verified = this.assertVerifiedCorePrimaryTerminal({
        requestClient: decodedBinding.requestClient,
        lilacSessionId: decodedBinding.lilacSessionId,
        terminalRequestId,
        terminalLineageVersion: decodedBinding.lineageVersion,
        terminalAtomCount: decodedBinding.atomCount,
        terminalPrefixDigest: decodedBinding.prefixDigest,
        terminalCanonicalMessageCount: decodedBinding.canonicalMessageCount,
      });
      if (verified.status === "ok") return terminalRequestId;
    }
    return null;
  }

  private parseVerifiedCorePrimaryBinding(
    row: CorePrimaryClaudeBindingRow,
  ): ResultType<
    CorePrimaryClaudeSessionBinding,
    PersistedDataError | TranscriptStoreSqliteDriverFailure | TranscriptTransactionConflict
  > {
    const decoded = decodeCorePrimaryClaudeBinding(row);
    if (decoded.status === "error") return Result.err(decoded.error);
    const binding = decoded.value;
    const verified = this.assertVerifiedCorePrimaryTerminal({
      requestClient: binding.requestClient,
      lilacSessionId: binding.lilacSessionId,
      terminalRequestId: binding.terminalRequestId,
      terminalLineageVersion: binding.lineageVersion,
      terminalAtomCount: binding.atomCount,
      terminalPrefixDigest: binding.prefixDigest,
      terminalCanonicalMessageCount: binding.canonicalMessageCount,
    });
    return verified.status === "ok" ? Result.ok(binding) : Result.err(verified.error);
  }

  private promoteCorePrimaryClaudeAttempt(input: {
    providerId: string;
    requestClient: "discord";
    lilacSessionId: string;
    requestId: string;
    attemptIndex: number;
  }): ResultType<boolean, CoreClaudeBindingReadError> {
    const attempt = this.getCorePrimaryClaudeSessionAttempt(input);
    if (
      !attempt ||
      attempt.state !== "succeeded" ||
      attempt.terminalRequestId === null ||
      attempt.terminalLineageVersion === null ||
      attempt.terminalAtomCount === null ||
      attempt.terminalPrefixDigest === null ||
      attempt.terminalCanonicalMessageCount === null ||
      attempt.nativeCwd === null ||
      attempt.nativeLastModified === null ||
      attempt.nativeContextTokens === null ||
      attempt.nativeContextMaxTokens === null ||
      attempt.lastModelSpecifier === null ||
      attempt.lastReasoning === null
    ) {
      return Result.ok(false);
    }
    const verified = this.assertVerifiedCorePrimaryTerminal({
      requestClient: attempt.requestClient,
      lilacSessionId: attempt.lilacSessionId,
      terminalRequestId: attempt.terminalRequestId,
      terminalLineageVersion: attempt.terminalLineageVersion,
      terminalAtomCount: attempt.terminalAtomCount,
      terminalPrefixDigest: attempt.terminalPrefixDigest,
      terminalCanonicalMessageCount: attempt.terminalCanonicalMessageCount,
    });
    if (verified.status === "error") {
      this.failSucceededCorePrimaryAttempt(attempt);
      return Result.ok(false);
    }

    const currentRead = this.readCorePrimaryClaudeSessionBinding({
      providerId: input.providerId,
      requestClient: input.requestClient,
      lilacSessionId: input.lilacSessionId,
    });
    if (currentRead.status === "error") return Result.err(currentRead.error);
    const current = currentRead.value;
    if (
      current?.claudeSessionId === attempt.candidateSessionId &&
      current.lineageVersion === attempt.terminalLineageVersion &&
      current.atomCount === attempt.terminalAtomCount &&
      current.prefixDigest === attempt.terminalPrefixDigest &&
      current.canonicalMessageCount === attempt.terminalCanonicalMessageCount
    ) {
      return Result.ok(true);
    }
    const sourceMatches =
      attempt.expectedBindingRevision === null
        ? current === null
        : current !== null &&
          current.revision === attempt.expectedBindingRevision &&
          current.lineageVersion === attempt.sourceLineageVersion &&
          current.atomCount === attempt.sourceAtomCount &&
          current.prefixDigest === attempt.sourcePrefixDigest &&
          current.canonicalMessageCount === attempt.sourceCanonicalMessageCount;
    if (!sourceMatches) {
      this.failSucceededCorePrimaryAttempt(attempt);
      return Result.ok(false);
    }

    const revision = (current?.revision ?? 0) + 1;
    this.db.run(
      `INSERT INTO core_primary_claude_bindings (
         request_client, session_id, provider_id, binding_protocol_version, provider_family,
          terminal_request_id, lineage_version, atom_count, prefix_digest, canonical_message_count,
         execution_scope_hash_version, execution_scope_hash, claude_session_id, native_cwd,
         native_last_modified, native_context_tokens, native_context_max_tokens,
         last_model_specifier, last_reasoning, revision, updated_ts
       ) VALUES (?, ?, ?, 1, 'claude-code', ?, 1, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(request_client, session_id, provider_id) DO UPDATE SET
          terminal_request_id = excluded.terminal_request_id,
          atom_count = excluded.atom_count,
         prefix_digest = excluded.prefix_digest,
         canonical_message_count = excluded.canonical_message_count,
         execution_scope_hash = excluded.execution_scope_hash,
         claude_session_id = excluded.claude_session_id,
         native_cwd = excluded.native_cwd,
         native_last_modified = excluded.native_last_modified,
         native_context_tokens = excluded.native_context_tokens,
         native_context_max_tokens = excluded.native_context_max_tokens,
         last_model_specifier = excluded.last_model_specifier,
         last_reasoning = excluded.last_reasoning,
         revision = excluded.revision,
         updated_ts = excluded.updated_ts`,
      [
        attempt.requestClient,
        attempt.lilacSessionId,
        attempt.providerId,
        attempt.terminalRequestId,
        attempt.terminalAtomCount,
        attempt.terminalPrefixDigest,
        attempt.terminalCanonicalMessageCount,
        attempt.executionScopeHash,
        attempt.candidateSessionId,
        attempt.nativeCwd,
        attempt.nativeLastModified,
        attempt.nativeContextTokens,
        attempt.nativeContextMaxTokens,
        attempt.lastModelSpecifier,
        attempt.lastReasoning,
        revision,
        Date.now(),
      ],
    );
    return Result.ok(true);
  }

  private failSucceededCorePrimaryAttempt(attempt: CorePrimaryClaudeSessionAttempt): void {
    this.db.run(
      `UPDATE core_primary_claude_attempts SET state = 'failed', updated_ts = ?
       WHERE request_client = ? AND session_id = ? AND provider_id = ?
         AND request_id = ? AND attempt_index = ? AND state = 'succeeded'`,
      [
        Date.now(),
        attempt.requestClient,
        attempt.lilacSessionId,
        attempt.providerId,
        attempt.requestId,
        attempt.attemptIndex,
      ],
    );
  }

  private canRecoverCorePrimaryPromotion(attempt: CorePrimaryClaudeSessionAttempt): boolean {
    const current = this.db
      .query<CorePrimaryClaudeBindingRow, ["discord", string, string]>(
        `SELECT * FROM core_primary_claude_bindings
         WHERE request_client = ? AND session_id = ? AND provider_id = ?`,
      )
      .get(attempt.requestClient, attempt.lilacSessionId, attempt.providerId);
    if (attempt.expectedBindingRevision === null) return current === null;
    return (
      current !== null &&
      current.revision === attempt.expectedBindingRevision &&
      current.lineage_version === attempt.sourceLineageVersion &&
      current.atom_count === attempt.sourceAtomCount &&
      current.prefix_digest === attempt.sourcePrefixDigest &&
      current.canonical_message_count === attempt.sourceCanonicalMessageCount &&
      (attempt.sourceSessionId === null || current.claude_session_id === attempt.sourceSessionId)
    );
  }

  private emitCorePrimaryRecoveryPromotion(
    attempt: CorePrimaryClaudeSessionAttempt,
    promoted: boolean,
  ): void {
    this.emitLifecycleDiagnostic(
      promoted ? "info" : "warn",
      "core_primary_claude.promotion_recovered",
      {
        requestId: attempt.requestId,
        sessionId: attempt.lilacSessionId,
        requestClient: attempt.requestClient,
        providerId: attempt.providerId,
        mode: "cas",
        reason: promoted ? "binding-promoted" : "promotion-rejected",
        outcome: promoted ? "promoted" : "rejected",
        promoted,
        bindingRevision: attempt.expectedBindingRevision,
        model: attempt.lastModelSpecifier,
        reasoning: attempt.lastReasoning,
      },
    );
  }

  private recoverCorePrimaryClaudeAttempts(): void {
    const interrupted = this.db
      .query<CorePrimaryClaudeAttemptRow, []>(
        "SELECT * FROM core_primary_claude_attempts WHERE state = 'active'",
      )
      .all();
    const recoverActive = this.db.transaction(() => {
      this.db.run(
        "UPDATE core_primary_claude_attempts SET state = 'uncertain', updated_ts = ? WHERE state = 'active'",
        [Date.now()],
      );
    });
    recoverActive.immediate();
    for (const row of interrupted) {
      this.emitLifecycleDiagnostic("debug", "core_primary_claude.attempt_recovered", {
        requestId: row.request_id,
        sessionId: row.session_id,
        requestClient: row.request_client,
        providerId: row.provider_id,
        mode: "recovery",
        outcome: "uncertain",
        reason: "runtime-restart",
        bindingHead: row.source_prefix_digest,
        bindingRevision: row.expected_binding_revision,
        model: row.last_model_specifier,
        reasoning: row.last_reasoning,
      });
    }

    const pending = this.db
      .query<CorePrimaryClaudeAttemptRow, []>(
        `SELECT attempt.* FROM core_primary_claude_attempts AS attempt
         WHERE attempt.state = 'succeeded' AND NOT EXISTS (
           SELECT 1 FROM core_primary_claude_bindings AS binding
           WHERE binding.request_client = attempt.request_client
             AND binding.session_id = attempt.session_id
             AND binding.provider_id = attempt.provider_id
             AND binding.claude_session_id = attempt.candidate_session_id
             AND binding.terminal_request_id = attempt.terminal_request_id
             AND binding.lineage_version = attempt.terminal_lineage_version
             AND binding.atom_count = attempt.terminal_atom_count
             AND binding.prefix_digest = attempt.terminal_prefix_digest
             AND binding.canonical_message_count = attempt.terminal_canonical_message_count
         )`,
      )
      .all();
    for (const row of pending) {
      const attempt = toCorePrimaryClaudeAttempt(row);
      if (!attempt) {
        this.emitLifecycleDiagnostic("warn", "core_primary_claude.promotion_recovery_failed", {
          requestId: row.request_id,
          sessionId: row.session_id,
          requestClient: row.request_client,
          providerId: row.provider_id,
          mode: "decode",
          reason: "corrupt-attempt-row",
        });
        continue;
      }
      if (!this.canRecoverCorePrimaryPromotion(attempt)) {
        this.failSucceededCorePrimaryAttempt(attempt);
        this.emitCorePrimaryRecoveryPromotion(attempt, false);
        continue;
      }
      const promotion = this.promoteCorePrimaryClaudeSessionBinding({
        providerId: attempt.providerId,
        requestClient: attempt.requestClient,
        lilacSessionId: attempt.lilacSessionId,
        requestId: attempt.requestId,
        attemptIndex: attempt.attemptIndex,
      });
      if (promotion.status === "ok") {
        this.emitCorePrimaryRecoveryPromotion(attempt, promotion.value);
      } else {
        this.emitLifecycleDiagnostic("warn", "core_primary_claude.promotion_recovery_failed", {
          requestId: attempt.requestId,
          sessionId: attempt.lilacSessionId,
          requestClient: attempt.requestClient,
          providerId: attempt.providerId,
          mode: "cas",
          reason: "promotion-failed",
          bindingRevision: attempt.expectedBindingRevision,
          model: attempt.lastModelSpecifier,
          reasoning: attempt.lastReasoning,
          errorTag: coreClaudeAttemptMutationErrorTag(promotion.error),
        });
      }
    }
    const owners = this.db
      .query<{ request_client: string; session_id: string; provider_id: string }, []>(
        `SELECT DISTINCT request_client, session_id, provider_id
         FROM core_primary_claude_attempts`,
      )
      .all();
    for (const owner of owners) {
      if (owner.request_client !== "discord") continue;
      this.pruneCorePrimaryClaudeAttempts({
        requestClient: owner.request_client,
        lilacSessionId: owner.session_id,
        providerId: owner.provider_id,
      });
    }
  }

  private pruneCorePrimaryClaudeAttempts(input: {
    requestClient: "discord";
    lilacSessionId: string;
    providerId: string;
  }): void {
    const event = this.pruneCorePrimaryClaudeAttemptsInTransaction(input);
    if (event) this.emitDeferredTranscriptEvents([event]);
  }

  private pruneCorePrimaryClaudeAttemptsInTransaction(input: {
    requestClient: "discord";
    lilacSessionId: string;
    providerId: string;
  }): DeferredTranscriptEvent | undefined {
    const pruned = this.db.run(
      `DELETE FROM core_primary_claude_attempts
       WHERE rowid IN (
         SELECT rowid FROM core_primary_claude_attempts
         WHERE request_client = ? AND session_id = ? AND provider_id = ? AND state <> 'active'
         ORDER BY updated_ts DESC, rowid DESC
         LIMIT -1 OFFSET ?
       )`,
      [
        input.requestClient,
        input.lilacSessionId,
        input.providerId,
        CORE_PRIMARY_CLAUDE_ATTEMPT_RETENTION_LIMIT,
      ],
    ).changes;
    if (pruned > 0) {
      return {
        kind: "log",
        event: "core_primary_claude.orphan_metadata_pruned",
        detail: {
          requestClient: input.requestClient,
          sessionId: input.lilacSessionId,
          providerId: input.providerId,
          attemptCount: pruned,
          reason: "terminal-count-bound",
        },
      };
    }
    return undefined;
  }

  private rowToSnapshot(
    row: TranscriptRow | null,
  ): ResultType<TranscriptSnapshot | null, PersistedDataError> {
    if (!row) return Result.ok(null);
    const decoded = decodeTranscriptRow({
      row,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    });
    if (decoded.status === "error") {
      this.reportPersistenceError(decoded.error);
      return Result.err(decoded.error);
    }
    return Result.ok(decoded.value.value);
  }

  private pruneRetention(now: number): readonly DeferredTranscriptEvent[] {
    const TTL_MS = 30 * 24 * 60 * 60 * 1000;
    const MAX_REQUESTS = 10_000;
    const events: DeferredTranscriptEvent[] = [];

    const cutoff = now - TTL_MS;
    const checkpointCandidateCutoff = now - 24 * 60 * 60 * 1000;
    const candidates = this.db
      .query<{ request_id: string; context_meta_json: string }, [number]>(
        `
        SELECT request_id, context_meta_json
        FROM request_transcripts
        WHERE updated_ts < ?
          AND context_meta_json IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM surface_message_to_request sm
            WHERE sm.request_id = request_transcripts.request_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM core_lineage_request_refs lineage_ref
            WHERE lineage_ref.referenced_request_id = request_transcripts.request_id
          )
        `,
      )
      .all(checkpointCandidateCutoff);
    for (const candidate of candidates) {
      const contextMeta = decodeTranscriptCompactionContext({
        raw: candidate.context_meta_json,
        schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
        recordId: candidate.request_id,
      });
      if (contextMeta.status === "error") {
        appendDeferredTranscriptEvent(events, {
          kind: "persistence-diagnostic",
          diagnostic: toTranscriptPersistenceDiagnostic(contextMeta.error),
        });
        continue;
      }
      if (!contextMeta.value.value) continue;
      this.db.run("DELETE FROM request_transcripts WHERE request_id = ?", [candidate.request_id]);
      appendDeferredTranscriptEvent(events, {
        kind: "log",
        event: "compaction checkpoint deleted",
        detail: {
          requestId: candidate.request_id,
          reason: "unlinked_candidate_cleanup",
        },
      });
    }
    this.db.run(
      `DELETE FROM request_transcripts
       WHERE updated_ts < ?
         AND NOT EXISTS (
           SELECT 1 FROM core_lineage_request_refs lineage_ref
           WHERE lineage_ref.referenced_request_id = request_transcripts.request_id
         )`,
      [cutoff],
    );

    // Clamp max rows by deleting oldest.
    const countRow = this.db
      .query<{ c: number }, []>("SELECT COUNT(1) as c FROM request_transcripts")
      .get();
    const count = typeof countRow?.c === "number" ? countRow.c : 0;
    if (count > MAX_REQUESTS) {
      const toDelete = count - MAX_REQUESTS;
      const victims = this.db
        .query<{ request_id: string }, [number]>(
          `SELECT request_id FROM request_transcripts
           WHERE NOT EXISTS (
             SELECT 1 FROM core_lineage_request_refs lineage_ref
             WHERE lineage_ref.referenced_request_id = request_transcripts.request_id
           )
           ORDER BY updated_ts ASC LIMIT ?`,
        )
        .all(toDelete);

      for (const v of victims) {
        this.db.run("DELETE FROM request_transcripts WHERE request_id = ?", [v.request_id]);
        this.db.run("DELETE FROM surface_message_to_request WHERE request_id = ?", [v.request_id]);
      }
    }

    this.db.run(
      `
      DELETE FROM session_loaded_tools
      WHERE selected_ts < ?
        AND NOT EXISTS (
        SELECT 1
        FROM request_transcripts
        WHERE request_transcripts.request_client = session_loaded_tools.request_client
          AND request_transcripts.session_id = session_loaded_tools.session_id
      )
    `,
      [cutoff],
    );
    return events;
  }

  private isRequestTranscriptRetainedByLineage(
    requestId: string,
  ): ResultType<boolean, PersistedDataError> {
    const decoded = decodeTranscriptRow({
      storeKind: "count",
      row: this.db
        .query<DecodedTranscriptCountRow, [string]>(
          "SELECT COUNT(*) AS count FROM core_lineage_request_refs WHERE referenced_request_id = ?",
        )
        .get(requestId),
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      recordId: requestId,
    });
    return decoded.status === "ok"
      ? Result.ok(decoded.value.value.count > 0)
      : Result.err(decoded.error);
  }
}

function parseNormalizedCanonicalMessages(value: readonly ModelMessage[]): ModelMessage[] {
  return normalizeReplayMessages(value);
}

function decodeCoreOwnedBlobRow(
  row: CoreOwnedBlobRow,
): ResultType<CoreOwnedBlob, CoreOwnedBlobIntegrityError> {
  const decoded = decodeTranscriptRow({
    storeKind: "owned-blob",
    row,
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    recordId: row.sha256,
  });
  if (decoded.status === "error") {
    const digest = createHash("sha256").update(row.bytes).digest("hex");
    const reason = digest === row.sha256 ? "persisted validation" : "SHA-256 validation";
    return Result.err(
      new CoreOwnedBlobIntegrityError(`Owned blob '${row.sha256}' failed ${reason}`),
    );
  }
  return Result.ok(decoded.value.value);
}

function toCoreOwnedBlobReference(blob: CoreOwnedBlob): CoreOwnedBlobReference {
  return {
    sha256: blob.sha256,
    mediaType: blob.mediaType,
    filename: blob.filename,
    byteLength: blob.byteLength,
  };
}

function decodeCoreNamedClaudeBinding(
  row: CoreNamedClaudeBindingRow,
): ResultType<CoreNamedClaudeSessionBinding, PersistedDataError> {
  const decoded = decodeTranscriptRow({
    storeKind: "named-binding",
    row,
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    recordId: `${row.request_client}:${row.session_id}:${row.provider_id}`,
  });
  return decoded.status === "ok" ? Result.ok(decoded.value.value) : Result.err(decoded.error);
}

function toCoreNamedClaudeAttempt(
  row: CoreNamedClaudeAttemptRow,
): CoreNamedClaudeSessionAttempt | null {
  const decoded = decodeTranscriptRow({
    storeKind: "named-attempt",
    row,
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    recordId: `${row.request_client}:${row.session_id}:${row.request_id}:${row.attempt_index}`,
  });
  return decoded.status === "ok" ? decoded.value.value : null;
}

function decodeCorePrimaryClaudeBinding(
  row: CorePrimaryClaudeBindingRow,
): ResultType<CorePrimaryClaudeSessionBinding, PersistedDataError> {
  const decoded = decodeTranscriptRow({
    storeKind: "primary-binding",
    row,
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    recordId: `${row.request_client}:${row.session_id}:${row.provider_id}`,
  });
  return decoded.status === "ok" ? Result.ok(decoded.value.value) : Result.err(decoded.error);
}

function toCorePrimaryClaudeAttempt(
  row: CorePrimaryClaudeAttemptRow,
): CorePrimaryClaudeSessionAttempt | null {
  const decoded = decodeTranscriptRow({
    storeKind: "primary-attempt",
    row,
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    recordId: `${row.request_client}:${row.session_id}:${row.request_id}:${row.attempt_index}`,
  });
  return decoded.status === "ok" ? decoded.value.value : null;
}
