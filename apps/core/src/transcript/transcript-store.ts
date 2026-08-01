import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import JSON from "superjson";
import { modelMessageSchema, type ModelMessage } from "ai";
import { z } from "zod";
import {
  hashCanonicalMessagesV1,
  historyProviderFamilySchema,
  historyProviderStateSchema,
  type HistoryProviderFamily,
  type HistoryProviderState,
} from "@stanley2058/lilac-agent";
import {
  coreLineageManifestV1Schema,
  extendCoreLineagePrefixDigestV1,
  parseCorePrimaryLineageV1,
  type AdapterPlatform,
  type CoreLineageAtomV1,
  type CoreLineageManifestV1,
} from "@stanley2058/lilac-event-bus";
import { createLogger, normalizeReplayMessages } from "@stanley2058/lilac-utils";

import type { MsgRef } from "../surface/types";

const logger = createLogger({ module: "transcript-store" });
const TRANSCRIPT_SCHEMA_VERSION = 5;
const CORE_NAMED_CLAUDE_ATTEMPT_RETENTION_LIMIT = 32;
const CORE_NAMED_CLAUDE_ACTIVE_ATTEMPT_LIMIT = 8;
const CORE_PRIMARY_CLAUDE_ATTEMPT_RETENTION_LIMIT = 32;
const CORE_PRIMARY_CLAUDE_ACTIVE_ATTEMPT_LIMIT = 8;

export const CORE_SURFACE_PROJECTION_FORMAT_VERSION = 1 as const;
export const CORE_TRANSCRIPT_DIGEST_VERSION = 1 as const;

const adapterPlatformSchema = z.enum([
  "discord",
  "github",
  "whatsapp",
  "slack",
  "telegram",
  "web",
  "unknown",
]);
const coreNamedClaudeAttemptStateSchema = z.enum([
  "active",
  "succeeded",
  "failed",
  "cancelled",
  "uncertain",
]);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 digest");
const modelMessagesSchema = z.array(modelMessageSchema);
export type CoreProjectionSourceFact =
  | null
  | boolean
  | number
  | string
  | CoreProjectionSourceFact[]
  | { [key: string]: CoreProjectionSourceFact };
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
const coreOwnedBlobReferenceSchema = z.object({
  sha256: sha256HexSchema,
  mediaType: z.string().min(1),
  filename: z.string().min(1),
  byteLength: nonNegativeIntegerSchema,
});
const coreSurfaceProjectionKeySchema = z.strictObject({
  requestClient: adapterPlatformSchema,
  surfaceId: z.string().min(1),
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
  projectionFormatVersion: z.literal(CORE_SURFACE_PROJECTION_FORMAT_VERSION),
});
const admitCoreSurfaceProjectionSchema = coreSurfaceProjectionKeySchema.extend({
  canonicalMessages: modelMessagesSchema.min(1),
  sourceFacts: coreProjectionSourceFactsSchema,
  ownedBlobs: z.array(coreOwnedBlobReferenceSchema),
});
const coreNamedClaudeOwnerSchema = z.strictObject({
  providerId: z.string().min(1),
  requestClient: adapterPlatformSchema,
  lilacSessionId: z.string().min(1),
});
const reserveCoreNamedClaudeSessionAttemptSchema = coreNamedClaudeOwnerSchema.extend({
  executionScopeHashVersion: z.literal(1),
  executionScopeHash: z.string().min(1),
  requestId: z.string().min(1),
  attemptIndex: nonNegativeIntegerSchema,
  candidateSessionId: z.uuid(),
  sourceSessionId: z.uuid().nullable(),
  expectedBindingRevision: positiveIntegerSchema.nullable(),
});
const recordCoreNamedClaudeSessionAttemptOutcomeSchema = coreNamedClaudeOwnerSchema.extend({
  requestId: z.string().min(1),
  attemptIndex: nonNegativeIntegerSchema,
  state: z.enum(["failed", "cancelled", "uncertain"]),
});
const publishCoreNamedClaudeSuccessSchema = coreNamedClaudeOwnerSchema.extend({
  requestId: z.string().min(1),
  attemptIndex: nonNegativeIntegerSchema,
  terminalRequestId: z.string().min(1),
  terminalCanonicalHeadHash: z.string().min(1),
  terminalCanonicalMessageCount: nonNegativeIntegerSchema,
  providerState: historyProviderStateSchema.refine(
    (state) => state.lastFamily === "claude-code",
    "Core named Claude success must publish a Claude provider head",
  ),
  nativeCwd: z.string().min(1),
  nativeLastModified: z.number().finite().nonnegative(),
  nativeContextTokens: nonNegativeIntegerSchema,
  nativeContextMaxTokens: positiveIntegerSchema,
  lastModelSpecifier: z.string().min(1),
  lastReasoning: z.string().min(1),
});
const corePrimaryClaudeOwnerSchema = z.strictObject({
  providerId: z.string().min(1),
  requestClient: z.literal("discord"),
  lilacSessionId: z.string().min(1),
});
const reserveCorePrimaryClaudeSessionAttemptSchema = corePrimaryClaudeOwnerSchema.extend({
  executionScopeHashVersion: z.literal(1),
  executionScopeHash: z.string().min(1),
  requestId: z.string().min(1),
  attemptIndex: nonNegativeIntegerSchema,
  candidateSessionId: z.uuid(),
  sourceSessionId: z.uuid().nullable(),
  expectedBindingRevision: positiveIntegerSchema.nullable(),
});
const recordCorePrimaryClaudeSessionAttemptOutcomeSchema = corePrimaryClaudeOwnerSchema.extend({
  requestId: z.string().min(1),
  attemptIndex: nonNegativeIntegerSchema,
  state: z.enum(["failed", "cancelled", "uncertain"]),
});
const publishCorePrimaryClaudeSuccessSchema = corePrimaryClaudeOwnerSchema.extend({
  requestId: z.string().min(1),
  attemptIndex: nonNegativeIntegerSchema,
  terminalRequestId: z.string().min(1),
  terminalLineageVersion: z.literal(1),
  terminalAtomCount: positiveIntegerSchema,
  terminalPrefixDigest: sha256HexSchema,
  terminalCanonicalMessageCount: positiveIntegerSchema,
  providerState: historyProviderStateSchema.refine(
    (state) => state.lastFamily === "claude-code",
    "Core primary Claude success must publish a Claude provider head",
  ),
  nativeCwd: z.string().min(1),
  nativeLastModified: z.number().finite().nonnegative(),
  nativeContextTokens: nonNegativeIntegerSchema,
  nativeContextMaxTokens: positiveIntegerSchema,
  lastModelSpecifier: z.string().min(1),
  lastReasoning: z.string().min(1),
});

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

const compactionCheckpointMetaSchema = z.object({
  type: z.literal("compaction"),
  formatVersion: z.literal(COMPACTION_CHECKPOINT_FORMAT_VERSION),
});

export type CompactionCheckpointMeta = z.infer<typeof compactionCheckpointMetaSchema>;

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

export type CoreOwnedBlobReference = z.infer<typeof coreOwnedBlobReferenceSchema>;

export type CoreOwnedBlob = CoreOwnedBlobReference & {
  readonly bytes: Uint8Array;
  readonly createdAt: number;
};

export type CoreSurfaceProjectionKey = z.infer<typeof coreSurfaceProjectionKeySchema>;

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
  readonly state: z.infer<typeof coreNamedClaudeAttemptStateSchema>;
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
  readonly state: z.infer<typeof coreNamedClaudeAttemptStateSchema>;
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
}): CorePrimaryClaudeBindingHead {
  const manifest = coreLineageManifestV1Schema.parse(input.manifest);
  const lastSegment = manifest.segments[manifest.segments.length - 1];
  if (!lastSegment) throw new Error("Core primary terminal head requires a complete manifest");
  const responseMessageCount = positiveIntegerSchema.parse(input.responseMessageCount);
  const requestAtom: CoreLineageAtomV1 = {
    kind: "request",
    requestId: z.string().min(1).parse(input.requestId),
    transcriptDigest: sha256HexSchema.parse(input.transcriptDigest),
    providerFamily: input.providerState.lastFamily,
    containsCrossFamilyTurns: input.providerState.containsCrossFamilyTurns,
  };
  const atomCount = lastSegment.cumulativeAtomCount + 1;
  return {
    lineageVersion: 1,
    atomCount,
    prefixDigest: extendCoreLineagePrefixDigestV1(
      lastSegment.cumulativePrefixDigest,
      atomCount,
      requestAtom,
    ),
    canonicalMessageCount: lastSegment.canonicalEnd + responseMessageCount,
  };
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
  }): void;

  putCoreOwnedBlob?(input: {
    bytes: Uint8Array;
    mediaType: string;
    filename: string;
  }): CoreOwnedBlob;

  getCoreOwnedBlob?(input: { sha256: string }): CoreOwnedBlob;

  deleteCoreOwnedBlobIfUnreferenced?(input: { sha256: string }): boolean;

  admitCoreSurfaceProjection?(input: AdmitCoreSurfaceProjection): CoreSurfaceProjection;

  getCoreSurfaceProjection?(input: CoreSurfaceProjectionKey): CoreSurfaceProjection | null;

  getLatestCoreSurfaceSegment?(input: CoreSurfaceProjectionKey): CoreStoredSurfaceSegment | null;

  saveCorePrimaryLineageManifest?(input: {
    requestId: string;
    manifest: CoreLineageManifestV1;
  }): CoreLineageManifestV1;

  getCorePrimaryLineageManifest?(input: { requestId: string }): CoreLineageManifestV1 | null;

  getCoreRequestAtomMetadata?(input: { requestId: string }): CoreRequestAtomMetadata | null;

  validateCorePrimaryLineageReferences?(input: {
    manifest: CoreLineageManifestV1;
    requestClient: AdapterPlatform;
    sessionId: string;
    surfaceId: string;
  }): string | null;

  linkSurfaceMessagesToRequest(input: {
    requestId: string;
    created: readonly MsgRef[];
    last: MsgRef;
  }): void;

  getTranscriptBySurfaceMessage(input: {
    platform: AdapterPlatform;
    channelId: string;
    messageId: string;
  }): TranscriptSnapshot | null;

  unlinkSurfaceMessage?(input: {
    platform: AdapterPlatform;
    channelId: string;
    messageId: string;
  }): UnlinkSurfaceMessageResult;

  deleteUnlinkedCheckpointCandidate?(input: { requestId: string }): boolean;

  getLatestTranscriptBySession?(input: { sessionId: string }): TranscriptSnapshot | null;

  getRequestTranscript?(input: { requestId: string }): TranscriptSnapshot | null;

  getLatestCompleteNamedTranscript?(input: {
    requestClient: AdapterPlatform;
    sessionId: string;
  }): TranscriptSnapshot | null;

  getCoreNamedClaudeSessionBinding?(input: {
    providerId: string;
    requestClient: AdapterPlatform;
    lilacSessionId: string;
  }): CoreNamedClaudeSessionBinding | null;

  getCoreNamedClaudeSessionAttempt?(input: {
    providerId: string;
    requestClient: AdapterPlatform;
    lilacSessionId: string;
    requestId: string;
    attemptIndex: number;
  }): CoreNamedClaudeSessionAttempt | null;

  reserveCoreNamedClaudeSessionAttempt?(
    input: ReserveCoreNamedClaudeSessionAttempt,
  ): CoreNamedClaudeSessionAttempt;

  recordCoreNamedClaudeSessionAttemptOutcome?(
    input: RecordCoreNamedClaudeSessionAttemptOutcome,
  ): CoreNamedClaudeSessionAttempt;

  publishCoreNamedClaudeSuccess?(
    input: PublishCoreNamedClaudeSuccess,
  ): CoreNamedClaudeSessionAttempt;

  promoteCoreNamedClaudeSessionBinding?(input: {
    providerId: string;
    requestClient: AdapterPlatform;
    lilacSessionId: string;
    requestId: string;
    attemptIndex: number;
  }): boolean;

  getCorePrimaryClaudeSessionBinding?(input: {
    providerId: string;
    requestClient: "discord";
    lilacSessionId: string;
  }): CorePrimaryClaudeSessionBinding | null;

  getCorePrimaryClaudeSessionAttempt?(input: {
    providerId: string;
    requestClient: "discord";
    lilacSessionId: string;
    requestId: string;
    attemptIndex: number;
  }): CorePrimaryClaudeSessionAttempt | null;

  getCoreRetentionDiagnostics?(): CoreRetentionDiagnostics;

  reserveCorePrimaryClaudeSessionAttempt?(
    input: ReserveCorePrimaryClaudeSessionAttempt,
  ): CorePrimaryClaudeSessionAttempt;

  recordCorePrimaryClaudeSessionAttemptOutcome?(
    input: RecordCorePrimaryClaudeSessionAttemptOutcome,
  ): CorePrimaryClaudeSessionAttempt;

  publishCorePrimaryClaudeSuccess?(
    input: PublishCorePrimaryClaudeSuccess,
  ): CorePrimaryClaudeSessionAttempt;

  promoteCorePrimaryClaudeSessionBinding?(input: {
    providerId: string;
    requestClient: "discord";
    lilacSessionId: string;
    requestId: string;
    attemptIndex: number;
  }): boolean;

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
  ) {
    this.db = new Database(dbPath);
    this.migrate();
    this.recoverCoreNamedClaudeAttempts();
    this.recoverCorePrimaryClaudeAttempts();
  }

  close(): void {
    this.db.close();
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
      const version = z
        .object({ version: z.number().int().nonnegative() })
        .parse(
          this.db
            .query("SELECT COALESCE(MAX(version), 0) AS version FROM transcript_schema_migrations")
            .get(),
        ).version;
      if (version > TRANSCRIPT_SCHEMA_VERSION) {
        throw new Error(`Unsupported transcript schema version ${version}`);
      }

      const transcriptColumns = this.db
        .query("PRAGMA table_info(request_transcripts)")
        .all() as Array<{ name: string }>;
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
          .query("SELECT request_id, messages_json FROM request_transcripts")
          .all() as Array<{ request_id: string; messages_json: string }>;
        for (const row of rows) {
          let messages: ModelMessage[];
          try {
            messages = parseNormalizedCanonicalMessages(JSON.parse(row.messages_json));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(
              `Cannot migrate transcript '${row.request_id}' to schema v2: ${message}`,
            );
          }
          this.db.run("UPDATE request_transcripts SET transcript_digest = ? WHERE request_id = ?", [
            hashCanonicalMessagesV1(messages).hash,
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
          .query("SELECT * FROM core_primary_claude_bindings ORDER BY rowid")
          .all() as CorePrimaryClaudeBindingRow[];
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
      const foreignKeyFailures = z
        .array(
          z.object({
            table: z.string(),
            rowid: z.number().int().nullable(),
            parent: z.string(),
            fkid: z.number().int(),
          }),
        )
        .parse(this.db.query("PRAGMA foreign_key_check").all());
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
      .query(
        `
        SELECT catalog_id
        FROM session_loaded_tools
        WHERE request_client = ? AND session_id = ?
        ORDER BY catalog_id ASC
        `,
      )
      .all(input.requestClient, input.sessionId) as Array<{ catalog_id: string }>;

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
  }): void {
    const now = Date.now();
    const normalizedMessages = parseNormalizedCanonicalMessages(input.messages);
    const transcriptDigest = hashCanonicalMessagesV1(normalizedMessages).hash;
    const providerState = input.providerState
      ? historyProviderStateSchema.parse(input.providerState)
      : null;
    const stableNamedRequestClient = input.stableNamedRequestClient
      ? adapterPlatformSchema.parse(input.stableNamedRequestClient)
      : null;
    const lineage = input.corePrimaryLineage
      ? this.parseCompleteCorePrimaryLineage(input.corePrimaryLineage)
      : null;

    // Persist the full transcript, but repair provider-shaped stringified assistant
    // tool inputs into canonical object form so resumed sessions remain executable.
    // Do not prune/compact tool outputs at persistence time; do that (if needed)
    // only in the model-facing view right before sending.
    const finalJson = JSON.stringify(normalizedMessages);

    const save = this.db.transaction(() => {
      const existing = this.db
        .query(
          `SELECT transcript_digest, provider_state_json
           FROM request_transcripts WHERE request_id = ?`,
        )
        .get(input.requestId) as {
        transcript_digest: string | null;
        provider_state_json: string | null;
      } | null;
      if (existing) {
        const digestRetained = this.db
          .query("SELECT 1 FROM core_lineage_request_refs WHERE referenced_request_id = ? LIMIT 1")
          .get(input.requestId);
        const requestMetadataRetained = this.db
          .query(
            `SELECT 1 FROM core_lineage_request_refs
             WHERE referenced_request_id = ? AND reference_kind = 'request' LIMIT 1`,
          )
          .get(input.requestId);
        const existingProviderState = parseHistoryProviderState(existing.provider_state_json);
        if (
          (digestRetained && existing.transcript_digest !== transcriptDigest) ||
          (requestMetadataRetained && !isDeepStrictEqual(existingProviderState, providerState))
        ) {
          throw new Error(
            `Request transcript '${input.requestId}' is retained by a Core primary lineage manifest`,
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
          input.contextMeta ? JSON.stringify(input.contextMeta) : null,
          providerState ? JSON.stringify(providerState) : null,
          stableNamedRequestClient,
          transcriptDigest,
        ],
      );
      if (lineage) this.saveCorePrimaryLineageManifestInTransaction(input.requestId, lineage);
    });
    save.immediate();

    this.pruneRetention();
  }

  putCoreOwnedBlob(inputValue: {
    bytes: Uint8Array;
    mediaType: string;
    filename: string;
  }): CoreOwnedBlob {
    const input = z
      .strictObject({
        bytes: z.instanceof(Uint8Array),
        mediaType: z.string().min(1),
        filename: z.string().min(1),
      })
      .parse(inputValue);
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const existing = this.getCoreOwnedBlobOrNull(sha256);
    if (existing) return existing;

    const createdAt = Date.now();
    this.db.run(
      `INSERT OR IGNORE INTO core_owned_blobs (
         sha256, media_type, filename, byte_length, bytes, created_ts
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [sha256, input.mediaType, input.filename, input.bytes.byteLength, input.bytes, createdAt],
    );
    const stored = this.getCoreOwnedBlobOrNull(sha256);
    if (!stored) throw new CoreOwnedBlobIntegrityError(`Owned blob '${sha256}' was not retained`);
    return stored;
  }

  getCoreOwnedBlob(inputValue: { sha256: string }): CoreOwnedBlob {
    const sha256 = sha256HexSchema.parse(inputValue.sha256);
    const blob = this.getCoreOwnedBlobOrNull(sha256);
    if (!blob) throw new CoreOwnedBlobIntegrityError(`Owned blob '${sha256}' is missing`);
    return blob;
  }

  deleteCoreOwnedBlobIfUnreferenced(inputValue: { sha256: string }): boolean {
    const sha256 = sha256HexSchema.parse(inputValue.sha256);
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

  admitCoreSurfaceProjection(inputValue: AdmitCoreSurfaceProjection): CoreSurfaceProjection {
    const parsed = admitCoreSurfaceProjectionSchema.parse(inputValue);
    const input = {
      ...parsed,
      canonicalMessages: parseNormalizedCanonicalMessages(parsed.canonicalMessages),
    };
    const key: CoreSurfaceProjectionKey = {
      requestClient: input.requestClient,
      surfaceId: input.surfaceId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      projectionFormatVersion: input.projectionFormatVersion,
    };
    const admit = this.db.transaction(() => {
      const existing = this.getCoreSurfaceProjection(key);
      if (existing) return existing;

      for (const reference of input.ownedBlobs) {
        const blob = this.getCoreOwnedBlob({ sha256: reference.sha256 });
        if (!isDeepStrictEqual(toCoreOwnedBlobReference(blob), reference)) {
          throw new CoreOwnedBlobIntegrityError(
            `Owned blob reference '${reference.sha256}' does not match stored metadata`,
          );
        }
      }
      const createdAt = Date.now();
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
          JSON.stringify(input.canonicalMessages),
          JSON.stringify(input.sourceFacts),
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
      const stored = this.getCoreSurfaceProjection(key);
      if (!stored) throw new Error("Core surface projection was not retained");
      return stored;
    });
    return admit.immediate();
  }

  getCoreSurfaceProjection(inputValue: CoreSurfaceProjectionKey): CoreSurfaceProjection | null {
    const input = coreSurfaceProjectionKeySchema.parse(inputValue);
    const row = this.db
      .query(
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
      ) as CoreSurfaceProjectionRow | null;
    if (!row) return null;

    const references = this.db
      .query(
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
      ) as CoreOwnedBlobRow[];
    const expectedReferenceCount = z.object({ count: nonNegativeIntegerSchema }).parse(
      this.db
        .query(
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
        ),
    ).count;
    if (references.length !== expectedReferenceCount) {
      throw new CoreOwnedBlobIntegrityError("A Core surface projection references a missing blob");
    }
    const ownedBlobs = references.map((reference) =>
      toCoreOwnedBlobReference(validateCoreOwnedBlobRow(reference)),
    );
    return {
      requestClient: adapterPlatformSchema.parse(row.request_client),
      surfaceId: row.surface_id,
      sessionId: row.session_id,
      messageId: row.message_id,
      projectionFormatVersion: z.literal(1).parse(row.projection_format_version),
      canonicalMessages: modelMessagesSchema.parse(
        parseSerializedUnknown(row.canonical_messages_json, "Core surface canonical messages"),
      ),
      sourceFacts: coreProjectionSourceFactsSchema.parse(
        parseSerializedUnknown(row.source_facts_json, "Core surface source facts"),
      ),
      ownedBlobs,
      createdAt: nonNegativeIntegerSchema.parse(row.created_ts),
    };
  }

  getLatestCoreSurfaceSegment(
    inputValue: CoreSurfaceProjectionKey,
  ): CoreStoredSurfaceSegment | null {
    const input = coreSurfaceProjectionKeySchema.parse(inputValue);
    const row = this.db
      .query(
        `SELECT r.request_id, r.segment_index, m.manifest_json
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
      ) as { request_id: string; segment_index: number; manifest_json: string } | null;
    if (!row) return null;

    const manifest = this.parseCompleteCorePrimaryLineage(
      parseSerializedUnknown(row.manifest_json, "Core primary lineage manifest"),
    );
    const segment = manifest.segments[row.segment_index];
    if (!segment) throw new Error(`Stored Core lineage segment ${row.segment_index} is missing`);
    return {
      requestId: row.request_id,
      segmentIndex: row.segment_index,
      messageIds: segment.atoms
        .filter((atom) => atom.kind === "surface")
        .map((atom) => atom.messageId),
      canonicalMessages: segment.canonicalMessages,
    };
  }

  saveCorePrimaryLineageManifest(input: {
    requestId: string;
    manifest: CoreLineageManifestV1;
  }): CoreLineageManifestV1 {
    const requestId = z.string().min(1).parse(input.requestId);
    const save = this.db.transaction(() => {
      const transcript = this.getRequestTranscript({ requestId });
      if (!transcript) throw new Error(`Request transcript '${requestId}' was not found`);
      const manifest = this.parseCompleteCorePrimaryLineage(input.manifest);
      return this.saveCorePrimaryLineageManifestInTransaction(requestId, manifest);
    });
    return save.immediate();
  }

  getCorePrimaryLineageManifest(input: { requestId: string }): CoreLineageManifestV1 | null {
    const requestId = z.string().min(1).parse(input.requestId);
    const row = this.db
      .query("SELECT manifest_json FROM core_primary_lineage_manifests WHERE request_id = ?")
      .get(requestId) as { manifest_json: string } | null;
    if (!row) return null;
    if (!this.getRequestTranscript({ requestId })) {
      throw new Error(`Core primary lineage transcript '${requestId}' is missing`);
    }
    return this.parseCompleteCorePrimaryLineage(
      parseSerializedUnknown(row.manifest_json, "Core primary lineage manifest"),
    );
  }

  getCoreRequestAtomMetadata(input: { requestId: string }): CoreRequestAtomMetadata | null {
    const transcript = this.getRequestTranscript(input);
    if (!transcript?.providerState) return null;
    return {
      requestId: transcript.requestId,
      transcriptDigest:
        transcript.transcriptDigest ?? hashCanonicalMessagesV1(transcript.messages).hash,
      providerFamily: transcript.providerState.lastFamily,
      containsCrossFamilyTurns: transcript.providerState.containsCrossFamilyTurns,
    };
  }

  private saveCorePrimaryLineageManifestInTransaction(
    requestId: string,
    manifest: CoreLineageManifestV1,
  ): CoreLineageManifestV1 {
    const existing = this.db
      .query("SELECT manifest_json FROM core_primary_lineage_manifests WHERE request_id = ?")
      .get(requestId) as { manifest_json: string } | null;
    if (existing) {
      const stored = coreLineageManifestV1Schema.parse(
        parseSerializedUnknown(existing.manifest_json, "Core primary lineage manifest"),
      );
      if (!isDeepStrictEqual(stored, manifest)) {
        throw new Error(`Core primary lineage manifest '${requestId}' is immutable`);
      }
      return stored;
    }

    const owner = this.getRequestTranscript({ requestId });
    if (!owner) throw new Error(`Request transcript '${requestId}' was not found`);
    const invalidReason = this.validateCorePrimaryLineageReferences({
      manifest,
      requestClient: owner.requestClient,
      sessionId: owner.sessionId,
      surfaceId: `${owner.requestClient}:${owner.sessionId}`,
    });
    if (invalidReason) {
      throw new Error(`Core primary lineage manifest '${requestId}' is invalid: ${invalidReason}`);
    }
    this.db.run(
      `INSERT INTO core_primary_lineage_manifests (
         request_id, lineage_version, manifest_json, created_ts
       ) VALUES (?, 1, ?, ?)`,
      [requestId, JSON.stringify(manifest), Date.now()],
    );
    for (const [segmentIndex, segment] of manifest.segments.entries()) {
      for (const [atomIndex, atom] of segment.atoms.entries()) {
        if (atom.kind === "surface") {
          this.db.run(
            `INSERT INTO core_lineage_projection_refs (
               request_id, segment_index, atom_index, request_client, surface_id,
               session_id, message_id, projection_format_version
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
            [
              requestId,
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
            [requestId, segmentIndex, atomIndex, atom.kind, atom.requestId, atom.transcriptDigest],
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
              requestId,
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
    return manifest;
  }

  validateCorePrimaryLineageReferences(input: {
    manifest: CoreLineageManifestV1;
    requestClient: AdapterPlatform;
    sessionId: string;
    surfaceId: string;
  }): string | null {
    const manifest = this.parseCompleteCorePrimaryLineage(input.manifest);
    for (const segment of manifest.segments) {
      for (const atom of segment.atoms) {
        if (atom.kind === "surface") {
          if (
            atom.requestClient !== input.requestClient ||
            atom.sessionId !== input.sessionId ||
            atom.surfaceId !== input.surfaceId
          ) {
            return "stale-surface-lineage";
          }
          const projection = this.getCoreSurfaceProjection({
            requestClient: adapterPlatformSchema.parse(atom.requestClient),
            surfaceId: atom.surfaceId,
            sessionId: atom.sessionId,
            messageId: atom.messageId,
            projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
          });
          if (!projection) return "stale-surface-lineage";
          continue;
        }
        if (atom.kind === "synthetic") {
          if (hashCanonicalMessagesV1(segment.canonicalMessages).hash !== atom.messageDigest) {
            return "stale-synthetic-lineage";
          }
          continue;
        }

        const transcript = this.getRequestTranscript({ requestId: atom.requestId });
        const transcriptDigest = transcript
          ? (transcript.transcriptDigest ?? hashCanonicalMessagesV1(transcript.messages).hash)
          : null;
        if (
          !transcript ||
          transcript.requestClient !== input.requestClient ||
          transcript.sessionId !== input.sessionId ||
          transcriptDigest !== atom.transcriptDigest
        ) {
          return "stale-request-lineage";
        }
        if (!isDeepStrictEqual(transcript.messages, segment.canonicalMessages)) {
          return "transformed-request-lineage";
        }
        if (atom.kind === "request") {
          const providerFamily = historyProviderFamilySchema.safeParse(
            transcript.providerState?.lastFamily,
          );
          if (
            !providerFamily.success ||
            providerFamily.data !== atom.providerFamily ||
            transcript.providerState?.containsCrossFamilyTurns !== atom.containsCrossFamilyTurns
          ) {
            return "stale-request-provider-lineage";
          }
          for (const alias of segment.requestSource?.aliases ?? []) {
            if (
              alias.requestClient !== input.requestClient ||
              alias.sessionId !== input.sessionId ||
              alias.surfaceId !== input.surfaceId
            ) {
              return "stale-request-alias-lineage";
            }
            const projection = this.getCoreSurfaceProjection({
              ...alias,
              requestClient: adapterPlatformSchema.parse(alias.requestClient),
              projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
            });
            if (!projection) return "stale-request-alias-lineage";
            const mapping = this.db
              .query(
                `SELECT request_id FROM surface_message_to_request
                 WHERE platform = ? AND channel_id = ? AND message_id = ?`,
              )
              .get(alias.requestClient, alias.sessionId, alias.messageId) as {
              request_id: string;
            } | null;
            if (mapping?.request_id !== atom.requestId) {
              return "stale-request-alias-lineage";
            }
          }
        } else {
          if (transcript.contextMeta?.type !== "compaction") {
            return "stale-checkpoint-lineage";
          }
          const linkedOutput = this.db
            .query(
              `SELECT 1 FROM surface_message_to_request
               WHERE request_id = ? AND platform = ? AND channel_id = ?
               LIMIT 1`,
            )
            .get(atom.requestId, input.requestClient, input.sessionId);
          if (!linkedOutput) return "stale-checkpoint-lineage";
        }
      }
      const surfaceAtoms = segment.atoms.filter((atom) => atom.kind === "surface");
      if (surfaceAtoms.length > 0) {
        const surfaceMessageIds = surfaceAtoms.map((atom) => atom.messageId);
        const segmentDigest = hashCanonicalMessagesV1(segment.canonicalMessages).hash;
        for (const atom of surfaceAtoms) {
          const projection = this.getCoreSurfaceProjection({
            requestClient: adapterPlatformSchema.parse(atom.requestClient),
            surfaceId: atom.surfaceId,
            sessionId: atom.sessionId,
            messageId: atom.messageId,
            projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
          });
          if (
            !projection ||
            !isDeepStrictEqual(projection.sourceFacts["segmentMessageIds"], surfaceMessageIds) ||
            projection.sourceFacts["segmentDigest"] !== segmentDigest
          ) {
            return "transformed-surface-lineage";
          }
        }
      }
    }
    return null;
  }

  private parseCompleteCorePrimaryLineage(value: unknown): CoreLineageManifestV1 {
    const parsed = coreLineageManifestV1Schema.parse(value);
    const canonicalMessages = parsed.segments.flatMap((segment) => segment.canonicalMessages);
    const lineage = parseCorePrimaryLineageV1(parsed, canonicalMessages);
    if (lineage.state !== "complete") {
      throw new Error("Only complete Core primary lineage manifests can be persisted");
    }
    return lineage;
  }

  private getCoreOwnedBlobOrNull(sha256: string): CoreOwnedBlob | null {
    const row = this.db
      .query("SELECT * FROM core_owned_blobs WHERE sha256 = ?")
      .get(sha256) as CoreOwnedBlobRow | null;
    return row ? validateCoreOwnedBlobRow(row) : null;
  }

  unlinkSurfaceMessage(input: {
    platform: AdapterPlatform;
    channelId: string;
    messageId: string;
  }): UnlinkSurfaceMessageResult {
    const unlink = this.db.transaction((): UnlinkSurfaceMessageResult => {
      const mapping = this.db
        .query(
          "SELECT request_id FROM surface_message_to_request WHERE platform = ? AND channel_id = ? AND message_id = ?",
        )
        .get(input.platform, input.channelId, input.messageId) as { request_id: string } | null;
      if (!mapping) return { checkpointDeleted: false };

      this.db.run(
        "DELETE FROM surface_message_to_request WHERE platform = ? AND channel_id = ? AND message_id = ?",
        [input.platform, input.channelId, input.messageId],
      );

      const remaining = this.db
        .query("SELECT 1 FROM surface_message_to_request WHERE request_id = ? LIMIT 1")
        .get(mapping.request_id);
      if (remaining) return { requestId: mapping.request_id, checkpointDeleted: false };

      const transcript = this.db
        .query("SELECT context_meta_json FROM request_transcripts WHERE request_id = ?")
        .get(mapping.request_id) as { context_meta_json: string | null } | null;
      if (!isCompactionContextMetaJson(transcript?.context_meta_json)) {
        return { requestId: mapping.request_id, checkpointDeleted: false };
      }
      if (this.isRequestTranscriptRetainedByLineage(mapping.request_id)) {
        return { requestId: mapping.request_id, checkpointDeleted: false };
      }

      this.db.run("DELETE FROM request_transcripts WHERE request_id = ?", [mapping.request_id]);
      return { requestId: mapping.request_id, checkpointDeleted: true };
    });

    return unlink();
  }

  deleteUnlinkedCheckpointCandidate(input: { requestId: string }): boolean {
    const remove = this.db.transaction(() => {
      const linked = this.db
        .query("SELECT 1 FROM surface_message_to_request WHERE request_id = ? LIMIT 1")
        .get(input.requestId);
      if (linked) return false;

      const transcript = this.db
        .query("SELECT context_meta_json FROM request_transcripts WHERE request_id = ?")
        .get(input.requestId) as { context_meta_json: string | null } | null;
      if (!isCompactionContextMetaJson(transcript?.context_meta_json)) return false;
      if (this.isRequestTranscriptRetainedByLineage(input.requestId)) return false;

      this.db.run("DELETE FROM request_transcripts WHERE request_id = ?", [input.requestId]);
      return true;
    });

    return remove();
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
  }): TranscriptSnapshot | null {
    const mapRow = this.db
      .query(
        "SELECT request_id FROM surface_message_to_request WHERE platform = ? AND channel_id = ? AND message_id = ?",
      )
      .get(input.platform, input.channelId, input.messageId) as {
      request_id: string;
    } | null;

    if (!mapRow) return null;

    const row = this.db
      .query(
        `
        SELECT request_id, session_id, request_client, created_ts, updated_ts, model_label, final_text,
               messages_json, context_meta_json, provider_state_json, stable_named_request_client,
               transcript_digest
        FROM request_transcripts
        WHERE request_id = ?
        `,
      )
      .get(mapRow.request_id) as TranscriptRow | null;

    return this.rowToSnapshot(row);
  }

  getLatestTranscriptBySession(input: { sessionId: string }): TranscriptSnapshot | null {
    const row = this.db
      .query(
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
      .get(input.sessionId) as TranscriptRow | null;

    return this.rowToSnapshot(row);
  }

  getRequestTranscript(input: { requestId: string }): TranscriptSnapshot | null {
    const row = this.db
      .query(
        `SELECT request_id, session_id, request_client, created_ts, updated_ts, model_label,
                final_text, messages_json, context_meta_json, provider_state_json,
                 stable_named_request_client, transcript_digest
         FROM request_transcripts WHERE request_id = ?`,
      )
      .get(input.requestId) as TranscriptRow | null;
    return this.rowToSnapshot(row);
  }

  getLatestCompleteNamedTranscript(input: {
    requestClient: AdapterPlatform;
    sessionId: string;
  }): TranscriptSnapshot | null {
    const ownerClient = adapterPlatformSchema.parse(input.requestClient);
    const marked = this.db
      .query(
        `SELECT request_id, session_id, request_client, created_ts, updated_ts, model_label,
                final_text, messages_json, context_meta_json, provider_state_json,
                 stable_named_request_client, transcript_digest
         FROM request_transcripts
         WHERE session_id = ? AND stable_named_request_client = ?
         ORDER BY updated_ts DESC, created_ts DESC, rowid DESC LIMIT 1`,
      )
      .get(input.sessionId, ownerClient) as TranscriptRow | null;
    return this.rowToSnapshot(marked);
  }

  getCoreNamedClaudeSessionBinding(inputValue: {
    providerId: string;
    requestClient: AdapterPlatform;
    lilacSessionId: string;
  }): CoreNamedClaudeSessionBinding | null {
    const input = coreNamedClaudeOwnerSchema.parse(inputValue);
    const row = this.db
      .query(
        `SELECT * FROM core_named_claude_bindings
         WHERE request_client = ? AND session_id = ? AND provider_id = ?`,
      )
      .get(
        input.requestClient,
        input.lilacSessionId,
        input.providerId,
      ) as CoreNamedClaudeBindingRow | null;
    return row ? toCoreNamedClaudeBinding(row) : null;
  }

  getCoreNamedClaudeSessionAttempt(inputValue: {
    providerId: string;
    requestClient: AdapterPlatform;
    lilacSessionId: string;
    requestId: string;
    attemptIndex: number;
  }): CoreNamedClaudeSessionAttempt | null {
    const input = coreNamedClaudeOwnerSchema
      .extend({ requestId: z.string().min(1), attemptIndex: nonNegativeIntegerSchema })
      .parse(inputValue);
    const row = this.db
      .query(
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
      ) as CoreNamedClaudeAttemptRow | null;
    return row ? toCoreNamedClaudeAttempt(row) : null;
  }

  reserveCoreNamedClaudeSessionAttempt(
    inputValue: ReserveCoreNamedClaudeSessionAttempt,
  ): CoreNamedClaudeSessionAttempt {
    const input = reserveCoreNamedClaudeSessionAttemptSchema.parse(inputValue);
    const reserve = this.db.transaction(() => {
      const binding = this.getCoreNamedClaudeSessionBinding({
        providerId: input.providerId,
        requestClient: input.requestClient,
        lilacSessionId: input.lilacSessionId,
      });
      if (input.expectedBindingRevision === null) {
        if (binding !== null)
          throw new Error("Core named Claude binding changed before reservation");
      } else if (
        binding === null ||
        binding.revision !== input.expectedBindingRevision ||
        (input.sourceSessionId !== null &&
          (binding.claudeSessionId !== input.sourceSessionId ||
            binding.executionScopeHashVersion !== input.executionScopeHashVersion ||
            binding.executionScopeHash !== input.executionScopeHash))
      ) {
        throw new Error("Core named Claude binding changed before reservation");
      }
      const activeCount = z.object({ count: nonNegativeIntegerSchema }).parse(
        this.db
          .query(
            `SELECT COUNT(*) AS count FROM core_named_claude_attempts
               WHERE request_client = ? AND session_id = ? AND provider_id = ? AND state = 'active'`,
          )
          .get(input.requestClient, input.lilacSessionId, input.providerId),
      ).count;
      if (activeCount >= CORE_NAMED_CLAUDE_ACTIVE_ATTEMPT_LIMIT) {
        throw new Error("Too many active Core named Claude attempts are retained");
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
      if (!attempt) throw new Error("Reserved Core named Claude attempt was not retained");
      return attempt;
    });
    return reserve.immediate();
  }

  recordCoreNamedClaudeSessionAttemptOutcome(
    inputValue: RecordCoreNamedClaudeSessionAttemptOutcome,
  ): CoreNamedClaudeSessionAttempt {
    const input = recordCoreNamedClaudeSessionAttemptOutcomeSchema.parse(inputValue);
    const record = this.db.transaction(() => {
      const attemptKey = {
        providerId: input.providerId,
        requestClient: input.requestClient,
        lilacSessionId: input.lilacSessionId,
        requestId: input.requestId,
        attemptIndex: input.attemptIndex,
      } as const;
      const current = this.getCoreNamedClaudeSessionAttempt(attemptKey);
      if (!current) throw new Error(`Core named Claude attempt '${input.requestId}' was not found`);
      if (current.state !== "active") {
        if (current.state === input.state) return current;
        throw new Error(`Core named Claude attempt is already terminal as '${current.state}'`);
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
      if (updated.changes !== 1) throw new Error("Core named Claude attempt lost its active fence");
      this.pruneCoreNamedClaudeAttempts(input);
      const attempt = this.getCoreNamedClaudeSessionAttempt(attemptKey);
      if (!attempt) throw new Error("Updated Core named Claude attempt was not retained");
      return attempt;
    });
    return record.immediate();
  }

  publishCoreNamedClaudeSuccess(
    inputValue: PublishCoreNamedClaudeSuccess,
  ): CoreNamedClaudeSessionAttempt {
    const input = publishCoreNamedClaudeSuccessSchema.parse(inputValue);
    const publish = this.db.transaction(() => {
      if (input.terminalRequestId !== input.requestId) {
        throw new Error("Core named Claude terminal request does not match its attempt");
      }
      const attemptKey = {
        providerId: input.providerId,
        requestClient: input.requestClient,
        lilacSessionId: input.lilacSessionId,
        requestId: input.requestId,
        attemptIndex: input.attemptIndex,
      } as const;
      const current = this.getCoreNamedClaudeSessionAttempt(attemptKey);
      if (!current) throw new Error(`Core named Claude attempt '${input.requestId}' was not found`);
      if (current.state === "succeeded") {
        this.assertVerifiedCoreNamedTerminal({
          requestClient: input.requestClient,
          lilacSessionId: input.lilacSessionId,
          terminalRequestId: input.terminalRequestId,
          canonicalHeadHash: input.terminalCanonicalHeadHash,
          canonicalMessageCount: input.terminalCanonicalMessageCount,
        });
        return current;
      }
      if (current.state !== "active") {
        throw new Error(`Core named Claude attempt is already terminal as '${current.state}'`);
      }
      const transcript = this.getRequestTranscript({ requestId: input.terminalRequestId });
      if (
        !transcript ||
        transcript.sessionId !== input.lilacSessionId ||
        transcript.stableNamedRequestClient !== undefined ||
        transcript.providerState != null ||
        transcript.messages.length !== input.terminalCanonicalMessageCount ||
        hashCanonicalMessagesV1(transcript.messages).hash !== input.terminalCanonicalHeadHash
      ) {
        throw new Error("Core named Claude recovery transcript failed publication verification");
      }

      const now = Date.now();
      const published = this.db.run(
        `UPDATE request_transcripts
         SET provider_state_json = ?, stable_named_request_client = ?, updated_ts = ?
         WHERE request_id = ? AND provider_state_json IS NULL
           AND stable_named_request_client IS NULL`,
        [JSON.stringify(input.providerState), input.requestClient, now, input.terminalRequestId],
      );
      if (published.changes !== 1) {
        throw new Error("Core named Claude transcript publication lost its unmarked fence");
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
        throw new Error("Core named Claude success publication lost its active attempt fence");
      }
      this.assertVerifiedCoreNamedTerminal({
        requestClient: input.requestClient,
        lilacSessionId: input.lilacSessionId,
        terminalRequestId: input.terminalRequestId,
        canonicalHeadHash: input.terminalCanonicalHeadHash,
        canonicalMessageCount: input.terminalCanonicalMessageCount,
      });
      this.pruneCoreNamedClaudeAttempts(input);
      const attempt = this.getCoreNamedClaudeSessionAttempt(attemptKey);
      if (!attempt) throw new Error("Published Core named Claude attempt was not retained");
      return attempt;
    });
    return publish.immediate();
  }

  promoteCoreNamedClaudeSessionBinding(inputValue: {
    providerId: string;
    requestClient: AdapterPlatform;
    lilacSessionId: string;
    requestId: string;
    attemptIndex: number;
  }): boolean {
    const input = coreNamedClaudeOwnerSchema
      .extend({ requestId: z.string().min(1), attemptIndex: nonNegativeIntegerSchema })
      .parse(inputValue);
    const promote = this.db.transaction(() => this.promoteCoreNamedClaudeAttempt(input));
    return promote.immediate();
  }

  getCorePrimaryClaudeSessionBinding(inputValue: {
    providerId: string;
    requestClient: "discord";
    lilacSessionId: string;
  }): CorePrimaryClaudeSessionBinding | null {
    const input = corePrimaryClaudeOwnerSchema.parse(inputValue);
    const read = () =>
      this.db
        .query(
          `SELECT * FROM core_primary_claude_bindings
           WHERE request_client = ? AND session_id = ? AND provider_id = ?`,
        )
        .get(
          input.requestClient,
          input.lilacSessionId,
          input.providerId,
        ) as CorePrimaryClaudeBindingRow | null;
    const row = read();
    if (!row) return null;
    const binding = this.parseVerifiedCorePrimaryBinding(row);
    if (binding) return binding;

    const retired = this.db.run(
      `DELETE FROM core_primary_claude_bindings
       WHERE request_client = ? AND session_id = ? AND provider_id = ?
         AND revision = ? AND terminal_request_id IS ? AND claude_session_id = ?
         AND atom_count = ? AND prefix_digest = ? AND canonical_message_count = ?`,
      [
        input.requestClient,
        input.lilacSessionId,
        input.providerId,
        row.revision,
        row.terminal_request_id,
        row.claude_session_id,
        row.atom_count,
        row.prefix_digest,
        row.canonical_message_count,
      ],
    );
    logger.warn("core_primary_claude.binding_retired", {
      requestClient: input.requestClient,
      sessionId: input.lilacSessionId,
      providerId: input.providerId,
      reason: "terminal-head-unverifiable",
      bindingHead: row.prefix_digest,
      bindingRevision: row.revision,
      model: row.last_model_specifier,
      reasoning: row.last_reasoning,
      retired: retired.changes === 1,
    });
    if (retired.changes === 1) return null;
    const replacement = read();
    return replacement ? this.parseVerifiedCorePrimaryBinding(replacement) : null;
  }

  getCoreRetentionDiagnostics(): CoreRetentionDiagnostics {
    const count = (sql: string) =>
      z.object({ count: nonNegativeIntegerSchema }).parse(this.db.query(sql).get()).count;
    const blobMetrics = z
      .object({
        owned_bytes: nonNegativeIntegerSchema,
        unreferenced_count: nonNegativeIntegerSchema,
        unreferenced_bytes: nonNegativeIntegerSchema,
      })
      .parse(
        this.db
          .query(
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
      );
    return {
      namedBindingCount: count("SELECT COUNT(*) AS count FROM core_named_claude_bindings"),
      primaryBindingCount: count("SELECT COUNT(*) AS count FROM core_primary_claude_bindings"),
      activeAttemptCount: count(
        `SELECT
           (SELECT COUNT(*) FROM core_named_claude_attempts WHERE state = 'active') +
           (SELECT COUNT(*) FROM core_primary_claude_attempts WHERE state = 'active') AS count`,
      ),
      terminalAttemptCount: count(
        `SELECT
           (SELECT COUNT(*) FROM core_named_claude_attempts WHERE state <> 'active') +
           (SELECT COUNT(*) FROM core_primary_claude_attempts WHERE state <> 'active') AS count`,
      ),
      unverifiablePrimaryBindingCount: count(
        `SELECT COUNT(*) AS count FROM core_primary_claude_bindings AS binding
         LEFT JOIN request_transcripts AS transcript
           ON transcript.request_id = binding.terminal_request_id
         LEFT JOIN core_primary_lineage_manifests AS manifest
           ON manifest.request_id = binding.terminal_request_id
         WHERE binding.terminal_request_id IS NULL OR transcript.request_id IS NULL
           OR manifest.request_id IS NULL`,
      ),
      orphanSucceededAttemptCount: count(
        `SELECT
           (SELECT COUNT(*) FROM core_named_claude_attempts AS attempt
            LEFT JOIN request_transcripts AS transcript
              ON transcript.request_id = attempt.terminal_request_id
            WHERE attempt.state = 'succeeded' AND transcript.request_id IS NULL) +
           (SELECT COUNT(*) FROM core_primary_claude_attempts AS attempt
            LEFT JOIN request_transcripts AS transcript
              ON transcript.request_id = attempt.terminal_request_id
            WHERE attempt.state = 'succeeded' AND transcript.request_id IS NULL) AS count`,
      ),
      orphanManifestCount: count(
        `SELECT COUNT(*) AS count FROM core_primary_lineage_manifests AS manifest
         LEFT JOIN request_transcripts AS transcript ON transcript.request_id = manifest.request_id
         WHERE transcript.request_id IS NULL`,
      ),
      unreferencedProjectionCount: count(
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
      ),
      ownedBlobBytes: blobMetrics.owned_bytes,
      unreferencedOwnedBlobCount: blobMetrics.unreferenced_count,
      unreferencedOwnedBlobBytes: blobMetrics.unreferenced_bytes,
    };
  }

  getCorePrimaryClaudeSessionAttempt(inputValue: {
    providerId: string;
    requestClient: "discord";
    lilacSessionId: string;
    requestId: string;
    attemptIndex: number;
  }): CorePrimaryClaudeSessionAttempt | null {
    const input = corePrimaryClaudeOwnerSchema
      .extend({ requestId: z.string().min(1), attemptIndex: nonNegativeIntegerSchema })
      .parse(inputValue);
    const row = this.db
      .query(
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
      ) as CorePrimaryClaudeAttemptRow | null;
    return row ? toCorePrimaryClaudeAttempt(row) : null;
  }

  reserveCorePrimaryClaudeSessionAttempt(
    inputValue: ReserveCorePrimaryClaudeSessionAttempt,
  ): CorePrimaryClaudeSessionAttempt {
    const input = reserveCorePrimaryClaudeSessionAttemptSchema.parse(inputValue);
    const reserve = this.db.transaction(() => {
      const binding = this.getCorePrimaryClaudeSessionBinding({
        providerId: input.providerId,
        requestClient: input.requestClient,
        lilacSessionId: input.lilacSessionId,
      });
      if (input.expectedBindingRevision === null) {
        if (binding !== null) {
          throw new Error("Core primary Claude binding changed before reservation");
        }
      } else if (
        binding === null ||
        binding.revision !== input.expectedBindingRevision ||
        (input.sourceSessionId !== null &&
          (binding.claudeSessionId !== input.sourceSessionId ||
            binding.executionScopeHashVersion !== input.executionScopeHashVersion ||
            binding.executionScopeHash !== input.executionScopeHash))
      ) {
        throw new Error("Core primary Claude binding changed before reservation");
      }
      const activeCount = z.object({ count: nonNegativeIntegerSchema }).parse(
        this.db
          .query(
            `SELECT COUNT(*) AS count FROM core_primary_claude_attempts
             WHERE request_client = ? AND session_id = ? AND provider_id = ? AND state = 'active'`,
          )
          .get(input.requestClient, input.lilacSessionId, input.providerId),
      ).count;
      if (activeCount >= CORE_PRIMARY_CLAUDE_ACTIVE_ATTEMPT_LIMIT) {
        throw new Error("Too many active Core primary Claude attempts are retained");
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
      if (!attempt) throw new Error("Reserved Core primary Claude attempt was not retained");
      return attempt;
    });
    return reserve.immediate();
  }

  recordCorePrimaryClaudeSessionAttemptOutcome(
    inputValue: RecordCorePrimaryClaudeSessionAttemptOutcome,
  ): CorePrimaryClaudeSessionAttempt {
    const input = recordCorePrimaryClaudeSessionAttemptOutcomeSchema.parse(inputValue);
    const record = this.db.transaction(() => {
      const attemptKey = {
        providerId: input.providerId,
        requestClient: input.requestClient,
        lilacSessionId: input.lilacSessionId,
        requestId: input.requestId,
        attemptIndex: input.attemptIndex,
      } as const;
      const current = this.getCorePrimaryClaudeSessionAttempt(attemptKey);
      if (!current)
        throw new Error(`Core primary Claude attempt '${input.requestId}' was not found`);
      if (current.state !== "active") {
        if (current.state === input.state) return current;
        throw new Error(`Core primary Claude attempt is already terminal as '${current.state}'`);
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
      if (updated.changes !== 1)
        throw new Error("Core primary Claude attempt lost its active fence");
      this.pruneCorePrimaryClaudeAttempts(input);
      const attempt = this.getCorePrimaryClaudeSessionAttempt(attemptKey);
      if (!attempt) throw new Error("Updated Core primary Claude attempt was not retained");
      return attempt;
    });
    return record.immediate();
  }

  publishCorePrimaryClaudeSuccess(
    inputValue: PublishCorePrimaryClaudeSuccess,
  ): CorePrimaryClaudeSessionAttempt {
    const input = publishCorePrimaryClaudeSuccessSchema.parse(inputValue);
    const publish = this.db.transaction(() => {
      if (input.terminalRequestId !== input.requestId) {
        throw new Error("Core primary Claude terminal request does not match its attempt");
      }
      const attemptKey = {
        providerId: input.providerId,
        requestClient: input.requestClient,
        lilacSessionId: input.lilacSessionId,
        requestId: input.requestId,
        attemptIndex: input.attemptIndex,
      } as const;
      const current = this.getCorePrimaryClaudeSessionAttempt(attemptKey);
      if (!current)
        throw new Error(`Core primary Claude attempt '${input.requestId}' was not found`);
      if (current.state === "succeeded") {
        this.assertVerifiedCorePrimaryTerminal(input);
        return current;
      }
      if (current.state !== "active") {
        throw new Error(`Core primary Claude attempt is already terminal as '${current.state}'`);
      }
      const transcript = this.getRequestTranscript({ requestId: input.terminalRequestId });
      if (
        !transcript ||
        transcript.requestClient !== input.requestClient ||
        transcript.sessionId !== input.lilacSessionId ||
        transcript.providerState != null ||
        transcript.stableNamedRequestClient !== undefined ||
        transcript.contextMeta !== undefined ||
        transcript.messages.length === 0
      ) {
        throw new Error("Core primary Claude recovery transcript failed publication verification");
      }
      const manifest = this.getCorePrimaryLineageManifest({ requestId: input.terminalRequestId });
      if (!manifest) {
        throw new Error("Core primary Claude recovery manifest failed publication verification");
      }
      const terminalHead = computeCorePrimaryClaudeTerminalHead({
        manifest,
        requestId: transcript.requestId,
        transcriptDigest:
          transcript.transcriptDigest ?? hashCanonicalMessagesV1(transcript.messages).hash,
        responseMessageCount: transcript.messages.length,
        providerState: input.providerState,
      });
      if (
        terminalHead.lineageVersion !== input.terminalLineageVersion ||
        terminalHead.atomCount !== input.terminalAtomCount ||
        terminalHead.prefixDigest !== input.terminalPrefixDigest ||
        terminalHead.canonicalMessageCount !== input.terminalCanonicalMessageCount
      ) {
        throw new Error("Core primary Claude terminal lineage failed publication verification");
      }
      const now = Date.now();
      const published = this.db.run(
        `UPDATE request_transcripts SET provider_state_json = ?, updated_ts = ?
         WHERE request_id = ? AND provider_state_json IS NULL
           AND stable_named_request_client IS NULL`,
        [JSON.stringify(input.providerState), now, input.terminalRequestId],
      );
      if (published.changes !== 1) {
        throw new Error("Core primary Claude transcript publication lost its unmarked fence");
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
        throw new Error("Core primary Claude success publication lost its active attempt fence");
      }
      this.assertVerifiedCorePrimaryTerminal(input);
      this.pruneCorePrimaryClaudeAttempts(input);
      const attempt = this.getCorePrimaryClaudeSessionAttempt(attemptKey);
      if (!attempt) throw new Error("Published Core primary Claude attempt was not retained");
      return attempt;
    });
    return publish.immediate();
  }

  promoteCorePrimaryClaudeSessionBinding(inputValue: {
    providerId: string;
    requestClient: "discord";
    lilacSessionId: string;
    requestId: string;
    attemptIndex: number;
  }): boolean {
    const input = corePrimaryClaudeOwnerSchema
      .extend({ requestId: z.string().min(1), attemptIndex: nonNegativeIntegerSchema })
      .parse(inputValue);
    const promote = this.db.transaction(() => this.promoteCorePrimaryClaudeAttempt(input));
    return promote.immediate();
  }

  listSurfaceMessagesForRequest(input: { requestId: string }): MsgRef[] {
    const rows = this.db
      .query(
        `
        SELECT platform, channel_id, message_id
        FROM surface_message_to_request
        WHERE request_id = ?
        ORDER BY created_ts ASC, rowid ASC
        `,
      )
      .all(input.requestId) as Array<{
      platform: string;
      channel_id: string;
      message_id: string;
    }>;

    const refs: MsgRef[] = [];
    for (const row of rows) {
      if (row.platform !== "discord" && row.platform !== "github") continue;
      refs.push({
        platform: row.platform,
        channelId: row.channel_id,
        messageId: row.message_id,
      });
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
      .query(
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
      .all(client, limit, offset) as Array<{
      request_id: string;
      platform: string;
      channel_id: string;
      message_id: string;
      updated_ts: number;
      final_text: string | null;
    }>;

    const out: RecentAgentWriteSnapshot[] = [];
    for (const row of rows) {
      if (row.platform !== "discord" && row.platform !== "github") continue;
      out.push({
        requestId: row.request_id,
        sessionId: row.channel_id,
        client: row.platform,
        messageId: row.message_id,
        updatedTs: row.updated_ts,
        finalText: row.final_text ?? undefined,
      });
    }

    return out;
  }

  listDiscoveryRecords(): TranscriptDiscoveryRecord[] {
    const rows = this.db
      .query(
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
      .all() as Array<{
      request_id: string;
      session_id: string;
      request_client: string;
      updated_ts: number;
      final_text: string | null;
      surface_platform: string | null;
      surface_channel_id: string | null;
      surface_message_id: string | null;
    }>;

    const byRequestId = new Map<string, TranscriptDiscoveryRecord>();
    for (const row of rows) {
      let record = byRequestId.get(row.request_id);
      if (!record) {
        record = {
          requestId: row.request_id,
          sessionId: row.session_id,
          requestClient: row.request_client as AdapterPlatform,
          updatedTs: row.updated_ts,
          finalText: row.final_text ?? undefined,
          surfaceRefs: [],
        };
        byRequestId.set(row.request_id, record);
      }

      if (
        row.surface_platform !== null &&
        row.surface_channel_id !== null &&
        row.surface_message_id !== null &&
        (row.surface_platform === "discord" || row.surface_platform === "github")
      ) {
        record.surfaceRefs.push({
          platform: row.surface_platform,
          channelId: row.surface_channel_id,
          messageId: row.surface_message_id,
        });
      }
    }

    return [...byRequestId.values()];
  }

  private assertVerifiedCoreNamedTerminal(input: {
    requestClient: AdapterPlatform;
    lilacSessionId: string;
    terminalRequestId: string;
    canonicalHeadHash: string;
    canonicalMessageCount: number;
  }): TranscriptSnapshot {
    const transcript = this.getRequestTranscript({ requestId: input.terminalRequestId });
    if (
      !transcript ||
      transcript.sessionId !== input.lilacSessionId ||
      transcript.stableNamedRequestClient !== input.requestClient ||
      transcript.providerState?.lastFamily !== "claude-code" ||
      transcript.messages.length !== input.canonicalMessageCount ||
      hashCanonicalMessagesV1(transcript.messages).hash !== input.canonicalHeadHash
    ) {
      throw new Error("Core named Claude terminal transcript failed canonical verification");
    }
    return transcript;
  }

  private promoteCoreNamedClaudeAttempt(input: {
    providerId: string;
    requestClient: AdapterPlatform;
    lilacSessionId: string;
    requestId: string;
    attemptIndex: number;
  }): boolean {
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
      return false;
    }
    try {
      this.assertVerifiedCoreNamedTerminal({
        requestClient: attempt.requestClient,
        lilacSessionId: attempt.lilacSessionId,
        terminalRequestId: attempt.terminalRequestId,
        canonicalHeadHash: attempt.terminalCanonicalHeadHash,
        canonicalMessageCount: attempt.terminalCanonicalMessageCount,
      });
    } catch {
      this.failSucceededCoreNamedAttempt(attempt);
      return false;
    }

    const current = this.getCoreNamedClaudeSessionBinding({
      providerId: input.providerId,
      requestClient: input.requestClient,
      lilacSessionId: input.lilacSessionId,
    });
    if (
      current?.claudeSessionId === attempt.candidateSessionId &&
      current.terminalRequestId === attempt.terminalRequestId &&
      current.canonicalHeadHash === attempt.terminalCanonicalHeadHash &&
      current.canonicalMessageCount === attempt.terminalCanonicalMessageCount
    ) {
      return true;
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
      return false;
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
    return true;
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
      .query(
        `SELECT * FROM core_named_claude_bindings
         WHERE request_client = ? AND session_id = ? AND provider_id = ?`,
      )
      .get(
        attempt.requestClient,
        attempt.lilacSessionId,
        attempt.providerId,
      ) as CoreNamedClaudeBindingRow | null;
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
      .query("SELECT * FROM core_named_claude_attempts WHERE state = 'active'")
      .all() as CoreNamedClaudeAttemptRow[];
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
      .query(
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
      .all() as CoreNamedClaudeAttemptRow[];
    for (const row of pending) {
      const attempt = toCoreNamedClaudeAttempt(row);
      if (!this.canRecoverCoreNamedPromotion(attempt)) {
        this.failSucceededCoreNamedAttempt(attempt);
        this.emitCoreNamedRecoveryPromotion(attempt, false);
        continue;
      }
      try {
        const promoted = this.promoteCoreNamedClaudeSessionBinding({
          providerId: attempt.providerId,
          requestClient: attempt.requestClient,
          lilacSessionId: attempt.lilacSessionId,
          requestId: attempt.requestId,
          attemptIndex: attempt.attemptIndex,
        });
        this.emitCoreNamedRecoveryPromotion(attempt, promoted);
      } catch (error) {
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
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const owners = this.db
      .query(
        `SELECT DISTINCT request_client, session_id, provider_id
         FROM core_named_claude_attempts`,
      )
      .all() as Array<{ request_client: string; session_id: string; provider_id: string }>;
    for (const owner of owners) {
      this.pruneCoreNamedClaudeAttempts({
        requestClient: adapterPlatformSchema.parse(owner.request_client),
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
      logger.info("core_named_claude.orphan_metadata_pruned", {
        requestClient: input.requestClient,
        sessionId: input.lilacSessionId,
        providerId: input.providerId,
        attemptCount: pruned,
        reason: "terminal-count-bound",
      });
    }
  }

  private assertVerifiedCorePrimaryTerminal(input: {
    requestClient: "discord";
    lilacSessionId: string;
    terminalRequestId: string;
    terminalLineageVersion: 1;
    terminalAtomCount: number;
    terminalPrefixDigest: string;
    terminalCanonicalMessageCount: number;
  }): TranscriptSnapshot {
    const transcript = this.getRequestTranscript({ requestId: input.terminalRequestId });
    const manifest = this.getCorePrimaryLineageManifest({ requestId: input.terminalRequestId });
    if (
      !transcript ||
      !manifest ||
      transcript.requestClient !== input.requestClient ||
      transcript.sessionId !== input.lilacSessionId ||
      transcript.providerState?.lastFamily !== "claude-code" ||
      transcript.contextMeta !== undefined ||
      transcript.messages.length === 0
    ) {
      throw new Error("Core primary Claude terminal transcript failed canonical verification");
    }
    const head = computeCorePrimaryClaudeTerminalHead({
      manifest,
      requestId: transcript.requestId,
      transcriptDigest:
        transcript.transcriptDigest ?? hashCanonicalMessagesV1(transcript.messages).hash,
      responseMessageCount: transcript.messages.length,
      providerState: transcript.providerState,
    });
    if (
      head.lineageVersion !== input.terminalLineageVersion ||
      head.atomCount !== input.terminalAtomCount ||
      head.prefixDigest !== input.terminalPrefixDigest ||
      head.canonicalMessageCount !== input.terminalCanonicalMessageCount
    ) {
      throw new Error("Core primary Claude terminal lineage failed canonical verification");
    }
    return transcript;
  }

  private findCorePrimaryTerminalRequestId(binding: CorePrimaryClaudeBindingRow): string | null {
    const candidates = new Set<string>();
    const attemptRows = this.db
      .query(
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
      ) as Array<{ terminal_request_id: string }>;
    for (const row of attemptRows) candidates.add(row.terminal_request_id);

    const durableRows = this.db
      .query(
        `SELECT transcript.request_id
         FROM request_transcripts AS transcript
         JOIN core_primary_lineage_manifests AS manifest
           ON manifest.request_id = transcript.request_id
         WHERE transcript.request_client = ? AND transcript.session_id = ?
           AND transcript.provider_state_json IS NOT NULL
           AND transcript.context_meta_json IS NULL
         ORDER BY transcript.updated_ts DESC, transcript.created_ts DESC, transcript.rowid DESC`,
      )
      .all(binding.request_client, binding.session_id) as Array<{ request_id: string }>;
    for (const row of durableRows) candidates.add(row.request_id);

    for (const terminalRequestId of candidates) {
      try {
        this.assertVerifiedCorePrimaryTerminal({
          requestClient: z.literal("discord").parse(binding.request_client),
          lilacSessionId: binding.session_id,
          terminalRequestId,
          terminalLineageVersion: z.literal(1).parse(binding.lineage_version),
          terminalAtomCount: positiveIntegerSchema.parse(binding.atom_count),
          terminalPrefixDigest: sha256HexSchema.parse(binding.prefix_digest),
          terminalCanonicalMessageCount: positiveIntegerSchema.parse(
            binding.canonical_message_count,
          ),
        });
        return terminalRequestId;
      } catch {
        // A v4 candidate is accepted only when its durable transcript and lineage recompute exactly.
      }
    }
    return null;
  }

  private parseVerifiedCorePrimaryBinding(
    row: CorePrimaryClaudeBindingRow,
  ): CorePrimaryClaudeSessionBinding | null {
    if (row.terminal_request_id === null) return null;
    try {
      const binding = toCorePrimaryClaudeBinding(row);
      this.assertVerifiedCorePrimaryTerminal({
        requestClient: binding.requestClient,
        lilacSessionId: binding.lilacSessionId,
        terminalRequestId: binding.terminalRequestId,
        terminalLineageVersion: binding.lineageVersion,
        terminalAtomCount: binding.atomCount,
        terminalPrefixDigest: binding.prefixDigest,
        terminalCanonicalMessageCount: binding.canonicalMessageCount,
      });
      return binding;
    } catch {
      return null;
    }
  }

  private promoteCorePrimaryClaudeAttempt(input: {
    providerId: string;
    requestClient: "discord";
    lilacSessionId: string;
    requestId: string;
    attemptIndex: number;
  }): boolean {
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
      return false;
    }
    try {
      this.assertVerifiedCorePrimaryTerminal({
        requestClient: attempt.requestClient,
        lilacSessionId: attempt.lilacSessionId,
        terminalRequestId: attempt.terminalRequestId,
        terminalLineageVersion: attempt.terminalLineageVersion,
        terminalAtomCount: attempt.terminalAtomCount,
        terminalPrefixDigest: attempt.terminalPrefixDigest,
        terminalCanonicalMessageCount: attempt.terminalCanonicalMessageCount,
      });
    } catch {
      this.failSucceededCorePrimaryAttempt(attempt);
      return false;
    }

    const current = this.getCorePrimaryClaudeSessionBinding({
      providerId: input.providerId,
      requestClient: input.requestClient,
      lilacSessionId: input.lilacSessionId,
    });
    if (
      current?.claudeSessionId === attempt.candidateSessionId &&
      current.lineageVersion === attempt.terminalLineageVersion &&
      current.atomCount === attempt.terminalAtomCount &&
      current.prefixDigest === attempt.terminalPrefixDigest &&
      current.canonicalMessageCount === attempt.terminalCanonicalMessageCount
    ) {
      return true;
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
      return false;
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
    return true;
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
      .query(
        `SELECT * FROM core_primary_claude_bindings
         WHERE request_client = ? AND session_id = ? AND provider_id = ?`,
      )
      .get(
        attempt.requestClient,
        attempt.lilacSessionId,
        attempt.providerId,
      ) as CorePrimaryClaudeBindingRow | null;
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
      .query("SELECT * FROM core_primary_claude_attempts WHERE state = 'active'")
      .all() as CorePrimaryClaudeAttemptRow[];
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
      .query(
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
      .all() as CorePrimaryClaudeAttemptRow[];
    for (const row of pending) {
      const attempt = toCorePrimaryClaudeAttempt(row);
      if (!this.canRecoverCorePrimaryPromotion(attempt)) {
        this.failSucceededCorePrimaryAttempt(attempt);
        this.emitCorePrimaryRecoveryPromotion(attempt, false);
        continue;
      }
      try {
        const promoted = this.promoteCorePrimaryClaudeSessionBinding({
          providerId: attempt.providerId,
          requestClient: attempt.requestClient,
          lilacSessionId: attempt.lilacSessionId,
          requestId: attempt.requestId,
          attemptIndex: attempt.attemptIndex,
        });
        this.emitCorePrimaryRecoveryPromotion(attempt, promoted);
      } catch (error) {
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
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const owners = this.db
      .query(
        `SELECT DISTINCT request_client, session_id, provider_id
         FROM core_primary_claude_attempts`,
      )
      .all() as Array<{ request_client: string; session_id: string; provider_id: string }>;
    for (const owner of owners) {
      this.pruneCorePrimaryClaudeAttempts({
        requestClient: z.literal("discord").parse(owner.request_client),
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
      logger.info("core_primary_claude.orphan_metadata_pruned", {
        requestClient: input.requestClient,
        sessionId: input.lilacSessionId,
        providerId: input.providerId,
        attemptCount: pruned,
        reason: "terminal-count-bound",
      });
    }
  }

  private rowToSnapshot(row: TranscriptRow | null): TranscriptSnapshot | null {
    if (!row) return null;

    let messages: ModelMessage[];
    try {
      messages = parseNormalizedCanonicalMessages(JSON.parse(row.messages_json));
    } catch {
      return null;
    }
    const computedDigest = hashCanonicalMessagesV1(messages).hash;
    const transcriptDigest = sha256HexSchema.safeParse(row.transcript_digest);
    if (transcriptDigest.success && transcriptDigest.data !== computedDigest) {
      throw new Error(`Request transcript '${row.request_id}' failed digest validation`);
    }

    const contextMeta = parseCompactionContextMeta(row.context_meta_json);
    const providerState = parseHistoryProviderState(row.provider_state_json);
    const requestClient = adapterPlatformSchema.safeParse(row.request_client);
    if (!requestClient.success) return null;
    const stableNamedRequestClient = adapterPlatformSchema.safeParse(
      row.stable_named_request_client,
    );

    return {
      requestId: row.request_id,
      sessionId: row.session_id,
      requestClient: requestClient.data,
      createdTs: row.created_ts,
      updatedTs: row.updated_ts,
      messages,
      modelLabel: row.model_label ?? undefined,
      finalText: row.final_text ?? undefined,
      contextMeta,
      providerState,
      canonicalHashVersion: CORE_TRANSCRIPT_DIGEST_VERSION,
      transcriptDigest: computedDigest,
      ...(stableNamedRequestClient.success
        ? { stableNamedRequestClient: stableNamedRequestClient.data }
        : {}),
    };
  }

  private pruneRetention() {
    const TTL_MS = 30 * 24 * 60 * 60 * 1000;
    const MAX_REQUESTS = 10_000;

    const cutoff = Date.now() - TTL_MS;
    const checkpointCandidateCutoff = Date.now() - 24 * 60 * 60 * 1000;
    const candidates = this.db
      .query(
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
      .all(checkpointCandidateCutoff) as Array<{
      request_id: string;
      context_meta_json: string;
    }>;
    for (const candidate of candidates) {
      if (!isCompactionContextMetaJson(candidate.context_meta_json)) continue;
      this.db.run("DELETE FROM request_transcripts WHERE request_id = ?", [candidate.request_id]);
      logger.info("compaction checkpoint deleted", {
        requestId: candidate.request_id,
        reason: "unlinked_candidate_cleanup",
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
    const countRow = this.db.query("SELECT COUNT(1) as c FROM request_transcripts").get() as {
      c: number;
    };
    const count = typeof countRow?.c === "number" ? countRow.c : 0;
    if (count > MAX_REQUESTS) {
      const toDelete = count - MAX_REQUESTS;
      const victims = this.db
        .query(
          `SELECT request_id FROM request_transcripts
           WHERE NOT EXISTS (
             SELECT 1 FROM core_lineage_request_refs lineage_ref
             WHERE lineage_ref.referenced_request_id = request_transcripts.request_id
           )
           ORDER BY updated_ts ASC LIMIT ?`,
        )
        .all(toDelete) as Array<{ request_id: string }>;

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
  }

  private isRequestTranscriptRetainedByLineage(requestId: string): boolean {
    return Boolean(
      this.db
        .query("SELECT 1 FROM core_lineage_request_refs WHERE referenced_request_id = ? LIMIT 1")
        .get(requestId),
    );
  }
}

function parseSerializedUnknown(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid serialized data: ${message}`);
  }
}

function parseNormalizedCanonicalMessages(value: unknown): ModelMessage[] {
  const messages = modelMessagesSchema.parse(value);
  return modelMessagesSchema.parse(normalizeReplayMessages(messages));
}

function validateCoreOwnedBlobRow(row: CoreOwnedBlobRow): CoreOwnedBlob {
  const reference = coreOwnedBlobReferenceSchema.parse({
    sha256: row.sha256,
    mediaType: row.media_type,
    filename: row.filename,
    byteLength: row.byte_length,
  });
  const bytes = z.instanceof(Uint8Array).parse(row.bytes);
  if (bytes.byteLength !== reference.byteLength) {
    throw new CoreOwnedBlobIntegrityError(
      `Owned blob '${reference.sha256}' has an invalid byte length`,
    );
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== reference.sha256) {
    throw new CoreOwnedBlobIntegrityError(
      `Owned blob '${reference.sha256}' failed SHA-256 validation`,
    );
  }
  return {
    ...reference,
    bytes: new Uint8Array(bytes),
    createdAt: nonNegativeIntegerSchema.parse(row.created_ts),
  };
}

function toCoreOwnedBlobReference(blob: CoreOwnedBlob): CoreOwnedBlobReference {
  return {
    sha256: blob.sha256,
    mediaType: blob.mediaType,
    filename: blob.filename,
    byteLength: blob.byteLength,
  };
}

function parseCompactionContextMeta(
  raw: string | null | undefined,
): CompactionCheckpointMeta | undefined {
  if (!raw) return undefined;
  try {
    const parsed = compactionCheckpointMetaSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function parseHistoryProviderState(raw: string | null | undefined): HistoryProviderState | null {
  if (!raw) return null;
  try {
    const parsed = historyProviderStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function toCoreNamedClaudeBinding(row: CoreNamedClaudeBindingRow): CoreNamedClaudeSessionBinding {
  return {
    bindingProtocolVersion: z.literal(1).parse(row.binding_protocol_version),
    providerId: row.provider_id,
    providerFamily: z.literal("claude-code").parse(row.provider_family),
    requestClient: adapterPlatformSchema.parse(row.request_client),
    lilacSessionId: row.session_id,
    terminalRequestId: row.terminal_request_id,
    canonicalHashVersion: z.literal(1).parse(row.canonical_hash_version),
    canonicalHeadHash: row.canonical_head_hash,
    canonicalMessageCount: nonNegativeIntegerSchema.parse(row.canonical_message_count),
    executionScopeHashVersion: z.literal(1).parse(row.execution_scope_hash_version),
    executionScopeHash: row.execution_scope_hash,
    claudeSessionId: z.uuid().parse(row.claude_session_id),
    nativeCwd: row.native_cwd,
    nativeLastModified: z.number().finite().nonnegative().parse(row.native_last_modified),
    nativeContextTokens: nonNegativeIntegerSchema.parse(row.native_context_tokens),
    nativeContextMaxTokens: positiveIntegerSchema.parse(row.native_context_max_tokens),
    lastModelSpecifier: row.last_model_specifier,
    lastReasoning: row.last_reasoning,
    revision: positiveIntegerSchema.parse(row.revision),
    updatedAt: nonNegativeIntegerSchema.parse(row.updated_ts),
  };
}

function toCoreNamedClaudeAttempt(row: CoreNamedClaudeAttemptRow): CoreNamedClaudeSessionAttempt {
  return {
    product: z.literal("core-named").parse(row.product),
    providerId: row.provider_id,
    requestClient: adapterPlatformSchema.parse(row.request_client),
    lilacSessionId: row.session_id,
    sourceTerminalRequestId: row.source_terminal_request_id,
    sourceCanonicalHeadHash: row.source_canonical_head_hash,
    sourceCanonicalMessageCount:
      row.source_canonical_message_count === null
        ? null
        : nonNegativeIntegerSchema.parse(row.source_canonical_message_count),
    executionScopeHashVersion: z.literal(1).parse(row.execution_scope_hash_version),
    executionScopeHash: row.execution_scope_hash,
    requestId: row.request_id,
    attemptIndex: nonNegativeIntegerSchema.parse(row.attempt_index),
    candidateSessionId: z.uuid().parse(row.candidate_session_id),
    sourceSessionId: row.source_session_id === null ? null : z.uuid().parse(row.source_session_id),
    expectedBindingRevision:
      row.expected_binding_revision === null
        ? null
        : positiveIntegerSchema.parse(row.expected_binding_revision),
    state: coreNamedClaudeAttemptStateSchema.parse(row.state),
    terminalRequestId: row.terminal_request_id,
    terminalCanonicalHeadHash: row.terminal_canonical_head_hash,
    terminalCanonicalMessageCount:
      row.terminal_canonical_message_count === null
        ? null
        : nonNegativeIntegerSchema.parse(row.terminal_canonical_message_count),
    nativeCwd: row.native_cwd,
    nativeLastModified:
      row.native_last_modified === null
        ? null
        : z.number().finite().nonnegative().parse(row.native_last_modified),
    nativeContextTokens:
      row.native_context_tokens === null
        ? null
        : nonNegativeIntegerSchema.parse(row.native_context_tokens),
    nativeContextMaxTokens:
      row.native_context_max_tokens === null
        ? null
        : positiveIntegerSchema.parse(row.native_context_max_tokens),
    lastModelSpecifier: row.last_model_specifier,
    lastReasoning: row.last_reasoning,
    createdAt: nonNegativeIntegerSchema.parse(row.created_ts),
    updatedAt: nonNegativeIntegerSchema.parse(row.updated_ts),
  };
}

function toCorePrimaryClaudeBinding(
  row: CorePrimaryClaudeBindingRow,
): CorePrimaryClaudeSessionBinding {
  return {
    bindingProtocolVersion: z.literal(1).parse(row.binding_protocol_version),
    providerId: row.provider_id,
    providerFamily: z.literal("claude-code").parse(row.provider_family),
    requestClient: z.literal("discord").parse(row.request_client),
    lilacSessionId: row.session_id,
    terminalRequestId: z.string().min(1).parse(row.terminal_request_id),
    lineageVersion: z.literal(1).parse(row.lineage_version),
    atomCount: positiveIntegerSchema.parse(row.atom_count),
    prefixDigest: sha256HexSchema.parse(row.prefix_digest),
    canonicalMessageCount: positiveIntegerSchema.parse(row.canonical_message_count),
    executionScopeHashVersion: z.literal(1).parse(row.execution_scope_hash_version),
    executionScopeHash: row.execution_scope_hash,
    claudeSessionId: z.uuid().parse(row.claude_session_id),
    nativeCwd: row.native_cwd,
    nativeLastModified: z.number().finite().nonnegative().parse(row.native_last_modified),
    nativeContextTokens: nonNegativeIntegerSchema.parse(row.native_context_tokens),
    nativeContextMaxTokens: positiveIntegerSchema.parse(row.native_context_max_tokens),
    lastModelSpecifier: row.last_model_specifier,
    lastReasoning: row.last_reasoning,
    revision: positiveIntegerSchema.parse(row.revision),
    updatedAt: nonNegativeIntegerSchema.parse(row.updated_ts),
  };
}

function toCorePrimaryClaudeAttempt(
  row: CorePrimaryClaudeAttemptRow,
): CorePrimaryClaudeSessionAttempt {
  return {
    product: z.literal("core-primary").parse(row.product),
    providerId: row.provider_id,
    requestClient: z.literal("discord").parse(row.request_client),
    lilacSessionId: row.session_id,
    sourceLineageVersion:
      row.source_lineage_version === null ? null : z.literal(1).parse(row.source_lineage_version),
    sourceAtomCount:
      row.source_atom_count === null ? null : positiveIntegerSchema.parse(row.source_atom_count),
    sourcePrefixDigest:
      row.source_prefix_digest === null ? null : sha256HexSchema.parse(row.source_prefix_digest),
    sourceCanonicalMessageCount:
      row.source_canonical_message_count === null
        ? null
        : positiveIntegerSchema.parse(row.source_canonical_message_count),
    executionScopeHashVersion: z.literal(1).parse(row.execution_scope_hash_version),
    executionScopeHash: row.execution_scope_hash,
    requestId: row.request_id,
    attemptIndex: nonNegativeIntegerSchema.parse(row.attempt_index),
    candidateSessionId: z.uuid().parse(row.candidate_session_id),
    sourceSessionId: row.source_session_id === null ? null : z.uuid().parse(row.source_session_id),
    expectedBindingRevision:
      row.expected_binding_revision === null
        ? null
        : positiveIntegerSchema.parse(row.expected_binding_revision),
    state: coreNamedClaudeAttemptStateSchema.parse(row.state),
    terminalRequestId: row.terminal_request_id,
    terminalLineageVersion:
      row.terminal_lineage_version === null
        ? null
        : z.literal(1).parse(row.terminal_lineage_version),
    terminalAtomCount:
      row.terminal_atom_count === null
        ? null
        : positiveIntegerSchema.parse(row.terminal_atom_count),
    terminalPrefixDigest:
      row.terminal_prefix_digest === null
        ? null
        : sha256HexSchema.parse(row.terminal_prefix_digest),
    terminalCanonicalMessageCount:
      row.terminal_canonical_message_count === null
        ? null
        : positiveIntegerSchema.parse(row.terminal_canonical_message_count),
    nativeCwd: row.native_cwd,
    nativeLastModified:
      row.native_last_modified === null
        ? null
        : z.number().finite().nonnegative().parse(row.native_last_modified),
    nativeContextTokens:
      row.native_context_tokens === null
        ? null
        : nonNegativeIntegerSchema.parse(row.native_context_tokens),
    nativeContextMaxTokens:
      row.native_context_max_tokens === null
        ? null
        : positiveIntegerSchema.parse(row.native_context_max_tokens),
    lastModelSpecifier: row.last_model_specifier,
    lastReasoning: row.last_reasoning,
    createdAt: nonNegativeIntegerSchema.parse(row.created_ts),
    updatedAt: nonNegativeIntegerSchema.parse(row.updated_ts),
  };
}

function isCompactionContextMetaJson(raw: string | null | undefined): boolean {
  return parseCompactionContextMeta(raw) !== undefined;
}
