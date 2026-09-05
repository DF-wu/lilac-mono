import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { hashCanonicalMessagesV1, historyProviderStateSchema } from "@stanley2058/lilac-agent";
import type { BlobRefV1, BlobStore } from "@stanley2058/lilac-blob-storage";
import {
  buildCoreLineageManifestV2,
  type CoreLineageAtomV2,
  type CoreLineageManifestV2,
  type CoreLineageSegmentInputV2,
} from "@stanley2058/lilac-event-bus";
import { isRecord } from "@stanley2058/lilac-utils";
import { modelMessageSchema, type ModelMessage } from "ai";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import SuperJSON from "superjson";
import { z } from "zod";

import { uploadVerifiedDurableBlob } from "./blob-migration-target";
import {
  computeCorePrimaryClaudeTerminalHead,
  type CorePrimaryClaudeBindingHead,
} from "../src/transcript/transcript-store";
import {
  hashCanonicalStoredMessagesV2,
  storedMessageV1Schema,
  type StoredMessageV1,
} from "../src/transcript/transcript-persistence-codec";
import { captureError } from "../src/shared/error-capture";
import { preserveToolPanic } from "../src/tools/tool-result-adapters";

const LEGACY_TRANSCRIPT_SCHEMA_VERSION = 5 as const;
const LEGACY_LINEAGE_VERSION = 1 as const;
const MIGRATION_PLAN_VERSION = 1 as const;
const MAX_REPORT_BLOCKERS = 20;

const REQUIRED_SCHEMA5_TABLE_COLUMNS = {
  core_owned_blobs: ["sha256", "media_type", "filename", "byte_length", "bytes", "created_ts"],
  core_surface_projections: [
    "request_client",
    "surface_id",
    "session_id",
    "message_id",
    "projection_format_version",
    "canonical_messages_json",
    "source_facts_json",
    "created_ts",
  ],
  core_surface_projection_blobs: [
    "request_client",
    "surface_id",
    "session_id",
    "message_id",
    "projection_format_version",
    "position",
    "blob_sha256",
  ],
  core_primary_lineage_manifests: ["request_id", "lineage_version", "manifest_json", "created_ts"],
  core_lineage_projection_refs: [
    "request_id",
    "segment_index",
    "atom_index",
    "request_client",
    "surface_id",
    "session_id",
    "message_id",
    "projection_format_version",
  ],
  core_lineage_request_refs: [
    "request_id",
    "segment_index",
    "atom_index",
    "reference_kind",
    "referenced_request_id",
    "transcript_digest",
  ],
  core_lineage_request_alias_refs: [
    "request_id",
    "segment_index",
    "alias_index",
    "referenced_request_id",
    "request_client",
    "surface_id",
    "session_id",
    "message_id",
    "projection_format_version",
  ],
  core_named_claude_bindings: [
    "request_client",
    "session_id",
    "provider_id",
    "binding_protocol_version",
    "provider_family",
    "terminal_request_id",
    "canonical_hash_version",
    "canonical_head_hash",
    "canonical_message_count",
    "execution_scope_hash_version",
    "execution_scope_hash",
    "claude_session_id",
    "native_cwd",
    "native_last_modified",
    "native_context_tokens",
    "native_context_max_tokens",
    "last_model_specifier",
    "last_reasoning",
    "revision",
    "updated_ts",
  ],
  core_named_claude_attempts: [
    "product",
    "request_client",
    "session_id",
    "provider_id",
    "source_terminal_request_id",
    "source_canonical_head_hash",
    "source_canonical_message_count",
    "execution_scope_hash_version",
    "execution_scope_hash",
    "request_id",
    "attempt_index",
    "candidate_session_id",
    "source_session_id",
    "expected_binding_revision",
    "state",
    "terminal_request_id",
    "terminal_canonical_head_hash",
    "terminal_canonical_message_count",
    "native_cwd",
    "native_last_modified",
    "native_context_tokens",
    "native_context_max_tokens",
    "last_model_specifier",
    "last_reasoning",
    "created_ts",
    "updated_ts",
  ],
  core_primary_claude_bindings: [
    "request_client",
    "session_id",
    "provider_id",
    "binding_protocol_version",
    "provider_family",
    "lineage_version",
    "atom_count",
    "prefix_digest",
    "canonical_message_count",
    "execution_scope_hash_version",
    "execution_scope_hash",
    "claude_session_id",
    "native_cwd",
    "native_last_modified",
    "native_context_tokens",
    "native_context_max_tokens",
    "last_model_specifier",
    "last_reasoning",
    "revision",
    "updated_ts",
    "terminal_request_id",
  ],
  core_primary_claude_attempts: [
    "product",
    "request_client",
    "session_id",
    "provider_id",
    "source_lineage_version",
    "source_atom_count",
    "source_prefix_digest",
    "source_canonical_message_count",
    "execution_scope_hash_version",
    "execution_scope_hash",
    "request_id",
    "attempt_index",
    "candidate_session_id",
    "source_session_id",
    "expected_binding_revision",
    "state",
    "terminal_request_id",
    "terminal_lineage_version",
    "terminal_atom_count",
    "terminal_prefix_digest",
    "terminal_canonical_message_count",
    "native_cwd",
    "native_last_modified",
    "native_context_tokens",
    "native_context_max_tokens",
    "last_model_specifier",
    "last_reasoning",
    "created_ts",
    "updated_ts",
  ],
} as const;

const REQUIRED_SCHEMA5_INDEXES = [
  "idx_core_surface_projection_blobs_blob",
  "idx_core_lineage_projection_refs_projection",
  "idx_core_lineage_request_refs_referenced",
  "idx_core_lineage_request_alias_refs_projection",
  "idx_core_named_claude_attempts_owner",
  "idx_core_primary_claude_attempts_owner",
] as const;

// These digests describe SQLite's schema text after the deployed migrations ran in order. In
// particular, ALTER TABLE preserves historical text that differs from a freshly created final table.
const LEGACY_TRANSCRIPT_SCHEMA5_OBJECT_CATALOG = [
  {
    type: "index",
    name: "idx_core_lineage_projection_refs_projection",
    tableName: "core_lineage_projection_refs",
    sqlSha256: "ac75b359061bb6ae97d65ce870c68ca61ebb8e62069692a0f62fd94f07e0ae2f",
  },
  {
    type: "index",
    name: "idx_core_lineage_request_alias_refs_projection",
    tableName: "core_lineage_request_alias_refs",
    sqlSha256: "0b25c00dce7f9942e64ef4b3ff63899e1fe49dfdd2fde9cc7bd5c165ab9c4ed2",
  },
  {
    type: "index",
    name: "idx_core_lineage_request_refs_referenced",
    tableName: "core_lineage_request_refs",
    sqlSha256: "c4e484eb449f60cdd616a73ba8def38e03fd7709751afdf5a992e09a22e251c4",
  },
  {
    type: "index",
    name: "idx_core_named_claude_attempts_owner",
    tableName: "core_named_claude_attempts",
    sqlSha256: "8bd190f66e76256a9b162da120a36c09413c4ecee85fc96acac6c01e02a4754f",
  },
  {
    type: "index",
    name: "idx_core_primary_claude_attempts_owner",
    tableName: "core_primary_claude_attempts",
    sqlSha256: "cfac7bad2d3ec5e134744bcd5efc607b2132d549cc2ec9d3f14ed1b39f207790",
  },
  {
    type: "index",
    name: "idx_core_surface_projection_blobs_blob",
    tableName: "core_surface_projection_blobs",
    sqlSha256: "75f70cb3068b69742137ec780804d19bc7a8481e3165504a9ddedc8a01a00411",
  },
  {
    type: "index",
    name: "idx_request_transcripts_client_session",
    tableName: "request_transcripts",
    sqlSha256: "4783e8f02f7e642f1501781e01e033a190533281bfddeec28317af3f89653817",
  },
  {
    type: "index",
    name: "idx_request_transcripts_session",
    tableName: "request_transcripts",
    sqlSha256: "aab740ebce435ef43cdb39429b0df75a9568c976f03c378bf0a3c1bd0415f657",
  },
  {
    type: "index",
    name: "idx_session_loaded_tools_session",
    tableName: "session_loaded_tools",
    sqlSha256: "6814f266eb42ffe26df9e0aed35aedcf38b95de7de028bc38cd6facd51d658e8",
  },
  {
    type: "index",
    name: "idx_surface_message_to_request_request",
    tableName: "surface_message_to_request",
    sqlSha256: "09d7d5f09e024b6994e202ae5da0a7142fba4a1a546190dabf0a2f99f5e7b475",
  },
  {
    type: "table",
    name: "core_lineage_projection_refs",
    tableName: "core_lineage_projection_refs",
    sqlSha256: "81b983521050164301b01557e1b94627148664eea66688c96e55fda3a5e63b64",
  },
  {
    type: "table",
    name: "core_lineage_request_alias_refs",
    tableName: "core_lineage_request_alias_refs",
    sqlSha256: "db1ec323085ffa4420f457c91b6014fd53a6f6138b4ae8779016277bb7b4c635",
  },
  {
    type: "table",
    name: "core_lineage_request_refs",
    tableName: "core_lineage_request_refs",
    sqlSha256: "da7303512645625b1b89e423fcaa0fd26dd8022ea59e18c97725e41b10ad6c88",
  },
  {
    type: "table",
    name: "core_named_claude_attempts",
    tableName: "core_named_claude_attempts",
    sqlSha256: "61d8422d8930e58046514922ef64ca417d7664891eda6dddf7f3ce3f9765c233",
  },
  {
    type: "table",
    name: "core_named_claude_bindings",
    tableName: "core_named_claude_bindings",
    sqlSha256: "3682b7aadf9133f6ca8fd47f56f26fd3972c9a9c635de60f4584ed74317a1827",
  },
  {
    type: "table",
    name: "core_owned_blobs",
    tableName: "core_owned_blobs",
    sqlSha256: "03dfa8a79f7e3aae7aca363be358c01437abed5bf37bb7e407f07a72ce98a1a1",
  },
  {
    type: "table",
    name: "core_primary_claude_attempts",
    tableName: "core_primary_claude_attempts",
    sqlSha256: "cc7200042c020e5db583c4ea5d54342dc04149a692e7dd3b3065c3ebce77efee",
  },
  {
    type: "table",
    name: "core_primary_claude_bindings",
    tableName: "core_primary_claude_bindings",
    sqlSha256: "e0a803d455d153ee9d2c12a8b358413fe033b93a6ff38c14122adf93f2902df9",
  },
  {
    type: "table",
    name: "core_primary_lineage_manifests",
    tableName: "core_primary_lineage_manifests",
    sqlSha256: "f743c544c27330112ae71c71db4d2a5d485be8a297cfc9c147cb1ac9498dcf46",
  },
  {
    type: "table",
    name: "core_surface_projection_blobs",
    tableName: "core_surface_projection_blobs",
    sqlSha256: "f19e225b81c716b69d3b57dcdc97007c063781014a1a68ab43c0323cc5d974d4",
  },
  {
    type: "table",
    name: "core_surface_projections",
    tableName: "core_surface_projections",
    sqlSha256: "0cb33474df66022cf4b8538d25fb8326179eabc5fc866eaabe086c5f8f51a252",
  },
  {
    type: "table",
    name: "request_transcripts",
    tableName: "request_transcripts",
    sqlSha256: "9835c3beebc57b64028229cb03d244dd0098ceb0ced14e0b3c73be4fec8feb3d",
  },
  {
    type: "table",
    name: "session_loaded_tools",
    tableName: "session_loaded_tools",
    sqlSha256: "285e6b7f02e59bd85d48084cac43c24ecd40a5e33813c8b323f3e8dbc06c3d43",
  },
  {
    type: "table",
    name: "surface_message_to_request",
    tableName: "surface_message_to_request",
    sqlSha256: "2ef5eb095f4998ac1c7f35ede497ec80a57d5f71038f4ca2a79c5c48355f82b3",
  },
  {
    type: "table",
    name: "transcript_schema_migrations",
    tableName: "transcript_schema_migrations",
    sqlSha256: "b4b93673c4a2993c36c7be1b39aa5d1ca7d00bf91a6b5efeae41c916d3d7d1a1",
  },
] as const;

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const nonNegativeIntegerSchema = z.number().int().nonnegative().safe();
const adapterPlatformSchema = z.enum([
  "discord",
  "github",
  "whatsapp",
  "slack",
  "telegram",
  "web",
  "unknown",
]);
const compactionContextSchema = z.strictObject({
  type: z.literal("compaction"),
  formatVersion: z.literal(1),
});
const modelMessagesSchema = z.array(modelMessageSchema);

const legacyTranscriptRowSchema = z.strictObject({
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
  transcript_digest: sha256HexSchema,
});

const legacyOwnedBlobRowSchema = z.strictObject({
  sha256: sha256HexSchema,
  media_type: z.string().min(1),
  filename: z.string().min(1),
  byte_length: nonNegativeIntegerSchema,
  bytes: z.instanceof(Uint8Array),
  created_ts: nonNegativeIntegerSchema,
});

const legacyProjectionRowSchema = z.strictObject({
  request_client: adapterPlatformSchema,
  surface_id: z.string().min(1),
  session_id: z.string().min(1),
  message_id: z.string().min(1),
  projection_format_version: z.literal(1),
  canonical_messages_json: z.string(),
  source_facts_json: z.string(),
  created_ts: nonNegativeIntegerSchema,
});

const legacyLineageAtomSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("surface"),
    requestClient: z.string().min(1),
    surfaceId: z.string().min(1),
    sessionId: z.string().min(1),
    messageId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("request"),
    requestId: z.string().min(1),
    transcriptDigest: sha256HexSchema,
    providerFamily: z.enum(["claude-code", "ai-sdk"]),
    containsCrossFamilyTurns: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("checkpoint"),
    requestId: z.string().min(1),
    transcriptDigest: sha256HexSchema,
  }),
  z.strictObject({
    kind: z.literal("synthetic"),
    source: z.string().min(1),
    messageDigest: sha256HexSchema,
  }),
]);

const legacyLineageManifestSchema = z.strictObject({
  state: z.literal("complete"),
  lineageVersion: z.literal(LEGACY_LINEAGE_VERSION),
  currentCanonicalStart: nonNegativeIntegerSchema,
  segments: z
    .array(
      z.strictObject({
        atoms: z.array(legacyLineageAtomSchema).min(1),
        canonicalMessages: modelMessagesSchema.min(1),
        requestSource: z
          .strictObject({
            aliases: z
              .array(
                z.strictObject({
                  requestClient: z.string().min(1),
                  surfaceId: z.string().min(1),
                  sessionId: z.string().min(1),
                  messageId: z.string().min(1),
                }),
              )
              .min(1),
          })
          .optional(),
        canonicalStart: nonNegativeIntegerSchema,
        canonicalEnd: z.number().int().positive().safe(),
        cumulativeAtomCount: z.number().int().positive().safe(),
        cumulativePrefixDigest: sha256HexSchema,
      }),
    )
    .min(1),
});

const legacyLineageRowSchema = z.strictObject({
  request_id: z.string().min(1),
  lineage_version: z.literal(LEGACY_LINEAGE_VERSION),
  manifest_json: z.string(),
  created_ts: nonNegativeIntegerSchema,
});

const claudeAttemptStateSchema = z.enum([
  "active",
  "succeeded",
  "failed",
  "cancelled",
  "uncertain",
]);
const nullablePositiveIntegerSchema = z.number().int().positive().safe().nullable();
const nullableNonNegativeIntegerSchema = nonNegativeIntegerSchema.nullable();
const nullableNonNegativeFiniteSchema = z.number().finite().nonnegative().nullable();
const nullableUuidSchema = z.uuid().nullable();

const legacyNamedClaudeBindingRowSchema = z.strictObject({
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
  claude_session_id: z.uuid(),
  native_cwd: z.string(),
  native_last_modified: z.number().finite().nonnegative(),
  native_context_tokens: nonNegativeIntegerSchema,
  native_context_max_tokens: z.number().int().positive().safe(),
  last_model_specifier: z.string(),
  last_reasoning: z.string(),
  revision: z.number().int().positive().safe(),
  updated_ts: nonNegativeIntegerSchema,
});

const legacyNamedClaudeAttemptRowSchema = z.strictObject({
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
  candidate_session_id: z.uuid(),
  source_session_id: nullableUuidSchema,
  expected_binding_revision: nullablePositiveIntegerSchema,
  state: claudeAttemptStateSchema,
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

const legacyPrimaryClaudeBindingRowSchema = z.strictObject({
  request_client: z.literal("discord"),
  session_id: z.string().min(1),
  provider_id: z.string().min(1),
  binding_protocol_version: z.literal(1),
  provider_family: z.literal("claude-code"),
  lineage_version: z.literal(1),
  atom_count: z.number().int().positive().safe(),
  prefix_digest: sha256HexSchema,
  canonical_message_count: z.number().int().positive().safe(),
  execution_scope_hash_version: z.literal(1),
  execution_scope_hash: z.string().min(1),
  claude_session_id: z.uuid(),
  native_cwd: z.string(),
  native_last_modified: z.number().finite().nonnegative(),
  native_context_tokens: nonNegativeIntegerSchema,
  native_context_max_tokens: z.number().int().positive().safe(),
  last_model_specifier: z.string(),
  last_reasoning: z.string(),
  revision: z.number().int().positive().safe(),
  updated_ts: nonNegativeIntegerSchema,
  terminal_request_id: z.string().min(1).nullable(),
});

const legacyPrimaryClaudeAttemptRowSchema = z.strictObject({
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
  candidate_session_id: z.uuid(),
  source_session_id: nullableUuidSchema,
  expected_binding_revision: nullablePositiveIntegerSchema,
  state: claudeAttemptStateSchema,
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

const foreignKeyFailureSchema = z.strictObject({
  table: z.string(),
  rowid: z.number().int().nullable(),
  parent: z.string(),
  fkid: z.number().int(),
});

type LegacyProjectionRow = z.output<typeof legacyProjectionRowSchema>;
type LegacyLineageManifest = z.output<typeof legacyLineageManifestSchema>;
type LegacyNamedClaudeBindingRow = z.output<typeof legacyNamedClaudeBindingRowSchema>;
type LegacyNamedClaudeAttemptRow = z.output<typeof legacyNamedClaudeAttemptRowSchema>;
type LegacyPrimaryClaudeBindingRow = z.output<typeof legacyPrimaryClaudeBindingRowSchema>;
type LegacyPrimaryClaudeAttemptRow = z.output<typeof legacyPrimaryClaudeAttemptRowSchema>;

export type LegacyTranscriptRecordKind =
  | "schema"
  | "foreign-key"
  | "owned-blob"
  | "request-transcript"
  | "surface-projection"
  | "lineage-manifest"
  | "named-claude-binding"
  | "named-claude-attempt"
  | "primary-claude-binding"
  | "primary-claude-attempt";

export type LegacyTranscriptMigrationBlocker = {
  readonly kind: LegacyTranscriptRecordKind;
  readonly recordId: string;
  readonly field: string;
  readonly reason: string;
};

export type LegacyTranscriptMigrationSourceSummary = {
  readonly kind: "owned-blob" | "request-transcript" | "surface-projection" | "lineage-manifest";
  readonly recordCount: number;
  readonly blobCount: number;
  readonly byteLength: number;
};

export type LegacyTranscriptMigrationReport = {
  readonly schemaVersion: typeof LEGACY_TRANSCRIPT_SCHEMA_VERSION;
  readonly sources: readonly LegacyTranscriptMigrationSourceSummary[];
  readonly totalBlobCount: number;
  readonly totalByteLength: number;
  readonly blockerCount: number;
  readonly blockers: readonly LegacyTranscriptMigrationBlocker[];
};

export type LegacyTranscriptOwnedBlobIdentity = {
  readonly sha256: string;
  readonly byteLength: number;
  readonly metadataHash: string;
};

export type LegacyTranscriptJsonRecordIdentity = {
  readonly recordId: string;
  readonly serializedHash: string;
  readonly blobCount: number;
  readonly byteLength: number;
};

export type LegacyTranscriptMigrationPlan = {
  readonly version: typeof MIGRATION_PLAN_VERSION;
  readonly schemaVersion: typeof LEGACY_TRANSCRIPT_SCHEMA_VERSION;
  readonly databaseIdentity: string;
  readonly ownedBlobs: readonly LegacyTranscriptOwnedBlobIdentity[];
  readonly requestTranscripts: readonly LegacyTranscriptJsonRecordIdentity[];
  readonly surfaceProjections: readonly LegacyTranscriptJsonRecordIdentity[];
  readonly lineageManifests: readonly LegacyTranscriptJsonRecordIdentity[];
  readonly namedClaudeBindings: readonly LegacyTranscriptJsonRecordIdentity[];
  readonly namedClaudeAttempts: readonly LegacyTranscriptJsonRecordIdentity[];
  readonly primaryClaudeBindings: readonly LegacyTranscriptJsonRecordIdentity[];
  readonly primaryClaudeAttempts: readonly LegacyTranscriptJsonRecordIdentity[];
};

export type LegacyTranscriptPreflight = {
  readonly report: LegacyTranscriptMigrationReport;
  readonly plan: LegacyTranscriptMigrationPlan;
};

export class LegacyTranscriptMigrationPreflightFailed extends TaggedError(
  "LegacyTranscriptMigrationPreflightFailed",
)<{
  readonly report: LegacyTranscriptMigrationReport;
  readonly message: string;
}> {}

export class LegacyTranscriptMigrationApplyFailed extends TaggedError(
  "LegacyTranscriptMigrationApplyFailed",
)<{
  readonly stage: "plan-validation" | "upload" | "rewrite";
  readonly recordKind?: LegacyTranscriptRecordKind;
  readonly recordId?: string;
  readonly message: string;
}> {}

type InlineBlobIdentity = {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly filename?: string;
};

type InspectedMessages = {
  readonly messages: ModelMessage[];
  readonly blobs: readonly InlineBlobIdentity[];
};

type LegacyTranscriptFact = {
  readonly requestId: string;
  readonly requestClient: z.output<typeof adapterPlatformSchema>;
  readonly sessionId: string;
  readonly stableNamedRequestClient: z.output<typeof adapterPlatformSchema> | null;
  readonly providerState: z.output<typeof historyProviderStateSchema> | null;
  readonly hasContextMeta: boolean;
  readonly legacyDigest: string;
  readonly messageCount: number;
};

type InspectedTranscriptRow = LegacyTranscriptJsonRecordIdentity & {
  readonly fact: LegacyTranscriptFact;
};

type InspectedLineageRow = LegacyTranscriptJsonRecordIdentity & {
  readonly manifest: LegacyLineageManifest;
};

type LegacyPrimaryHead = {
  readonly lineageVersion: 1;
  readonly atomCount: number;
  readonly prefixDigest: string;
  readonly canonicalMessageCount: number;
};

type LegacyPrimaryCandidate = {
  readonly requestId: string;
  readonly transcript: LegacyTranscriptFact;
  readonly oldHead: LegacyPrimaryHead;
};

type LegacyTranscriptDecodeFailure = {
  readonly _tag: "LegacyTranscriptDecodeFailure";
  readonly blocker: LegacyTranscriptMigrationBlocker;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

type MigrationIdentityValue =
  | null
  | boolean
  | number
  | string
  | readonly MigrationIdentityValue[]
  | { readonly [key: string]: MigrationIdentityValue };

function canonicalIdentityHash(value: MigrationIdentityValue): string {
  return sha256(globalThis.JSON.stringify(value));
}

function fail(input: LegacyTranscriptMigrationBlocker): LegacyTranscriptDecodeFailure {
  return { _tag: "LegacyTranscriptDecodeFailure", blocker: input };
}

function isDecodeFailure(value: unknown): value is LegacyTranscriptDecodeFailure {
  return isRecord(value) && value["_tag"] === "LegacyTranscriptDecodeFailure";
}

function isDecodeSuccess<T>(value: T | LegacyTranscriptDecodeFailure): value is T {
  return !isDecodeFailure(value);
}

function decodeSerialized(input: {
  readonly raw: string;
  readonly kind: LegacyTranscriptRecordKind;
  readonly recordId: string;
  readonly field: string;
}): unknown | LegacyTranscriptDecodeFailure {
  const parsed: unknown = globalThis.JSON.parse(input.raw);
  if (
    isRecord(parsed) &&
    "json" in parsed &&
    Object.keys(parsed).every((key) => key === "json" || key === "meta")
  ) {
    return SuperJSON.parse<unknown>(input.raw);
  }
  return parsed;
}

function strictBase64Bytes(input: {
  readonly value: string;
  readonly kind: LegacyTranscriptRecordKind;
  readonly recordId: string;
  readonly path: string;
}): Uint8Array | LegacyTranscriptDecodeFailure {
  const normalized = input.value.replace(/=+$/u, "");
  if (input.value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(input.value)) {
    return fail({
      kind: input.kind,
      recordId: input.recordId,
      field: input.path,
      reason: "Inline binary content is not valid base64",
    });
  }
  const bytes = new Uint8Array(Buffer.from(input.value, "base64"));
  if (Buffer.from(bytes).toString("base64").replace(/=+$/u, "") !== normalized) {
    return fail({
      kind: input.kind,
      recordId: input.recordId,
      field: input.path,
      reason: "Inline binary content is not canonical base64",
    });
  }
  return bytes;
}

function dataUrlBytes(input: {
  readonly value: string;
  readonly kind: LegacyTranscriptRecordKind;
  readonly recordId: string;
  readonly path: string;
}):
  | { readonly bytes: Uint8Array; readonly mediaType?: string }
  | null
  | LegacyTranscriptDecodeFailure {
  const match = /^data:([^,]*),(.*)$/isu.exec(input.value);
  if (!match) return null;
  const metadata = match[1] ?? "";
  const payload = match[2] ?? "";
  const segments = metadata.split(";");
  const mediaType = segments[0]?.trim() || undefined;
  if (segments.some((segment) => segment.toLowerCase() === "base64")) {
    const bytes = strictBase64Bytes({ ...input, value: payload });
    if (isDecodeFailure(bytes)) return bytes;
    return {
      bytes,
      ...(mediaType === undefined ? {} : { mediaType }),
    };
  }
  const decoded = decodeURIComponent(payload.replace(/\+/gu, "%2B"));
  return {
    bytes: new TextEncoder().encode(decoded),
    ...(mediaType === undefined ? {} : { mediaType }),
  };
}

function inspectBinaryData(input: {
  readonly value: unknown;
  readonly kind: LegacyTranscriptRecordKind;
  readonly recordId: string;
  readonly path: string;
  readonly mediaType: string;
  readonly filename?: string;
}): InlineBlobIdentity | null | LegacyTranscriptDecodeFailure {
  let bytes: Uint8Array | undefined;
  let mediaType = input.mediaType;
  const value = input.value;
  if (typeof value === "string") {
    const dataUrl = dataUrlBytes({ ...input, value });
    if (isDecodeFailure(dataUrl)) return dataUrl;
    if (/^https?:\/\//iu.test(value)) {
      return fail({
        kind: input.kind,
        recordId: input.recordId,
        field: input.path,
        reason: "A legacy external file URL has no schema-6 stored-message representation",
      });
    }
    const decodedBytes = dataUrl?.bytes ?? strictBase64Bytes({ ...input, value });
    if (isDecodeFailure(decodedBytes)) return decodedBytes;
    bytes = decodedBytes;
    mediaType = dataUrl?.mediaType ?? mediaType;
  }
  if (value instanceof URL) {
    if (value.protocol === "http:" || value.protocol === "https:") {
      return fail({
        kind: input.kind,
        recordId: input.recordId,
        field: input.path,
        reason: "A legacy external file URL has no schema-6 stored-message representation",
      });
    }
    const dataUrl = dataUrlBytes({ ...input, value: value.href });
    if (isDecodeFailure(dataUrl)) return dataUrl;
    if (!dataUrl) {
      return fail({
        kind: input.kind,
        recordId: input.recordId,
        field: input.path,
        reason: `Unsupported persisted file URL protocol '${value.protocol}'`,
      });
    }
    bytes = dataUrl.bytes;
    mediaType = dataUrl.mediaType ?? mediaType;
  }
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (isRecord(value) && value["type"] === "data") {
    return inspectBinaryData({ ...input, value: value["data"] });
  }
  if (isRecord(value) && value["type"] === "url") {
    return inspectBinaryData({ ...input, value: value["url"] });
  }
  if (isRecord(value) && (value["type"] === "reference" || value["type"] === "text")) {
    return fail({
      kind: input.kind,
      recordId: input.recordId,
      field: input.path,
      reason: "A legacy provider file reference has no schema-6 stored-message representation",
    });
  }
  if (
    isRecord(value) &&
    ("providerReference" in value || "fileId" in value || "reference" in value)
  ) {
    return fail({
      kind: input.kind,
      recordId: input.recordId,
      field: input.path,
      reason: "A legacy provider file reference has no schema-6 stored-message representation",
    });
  }
  if (bytes === undefined) {
    return fail({
      kind: input.kind,
      recordId: input.recordId,
      field: input.path,
      reason: "Persisted file content has an unsupported schema-5 representation",
    });
  }
  return {
    path: input.path,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    mediaType,
    ...(input.filename === undefined ? {} : { filename: input.filename }),
  };
}

function inspectToolResult(input: {
  readonly output: unknown;
  readonly kind: LegacyTranscriptRecordKind;
  readonly recordId: string;
  readonly path: string;
  readonly blobs: InlineBlobIdentity[];
}): void | LegacyTranscriptDecodeFailure {
  if (!isRecord(input.output) || input.output["type"] !== "content") return;
  const value = input.output["value"];
  if (!Array.isArray(value)) return;
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || typeof item["type"] !== "string") continue;
    const path = `${input.path}.value[${index}]`;
    let candidate: InlineBlobIdentity | null | LegacyTranscriptDecodeFailure = null;
    switch (true) {
      case item["type"] === "file":
        candidate = inspectBinaryData({
          value: item["data"],
          kind: input.kind,
          recordId: input.recordId,
          path: `${path}.data`,
          mediaType:
            typeof item["mediaType"] === "string" ? item["mediaType"] : "application/octet-stream",
          ...(typeof item["filename"] === "string" ? { filename: item["filename"] } : {}),
        });
        break;
      case item["type"] === "file-data" || item["type"] === "image-data":
        candidate = inspectBinaryData({
          value: item["data"],
          kind: input.kind,
          recordId: input.recordId,
          path: `${path}.data`,
          mediaType:
            typeof item["mediaType"] === "string" ? item["mediaType"] : "application/octet-stream",
          ...(typeof item["filename"] === "string" ? { filename: item["filename"] } : {}),
        });
        break;
      case item["type"] === "file-url" || item["type"] === "image-url":
        candidate = inspectBinaryData({
          value: item["url"],
          kind: input.kind,
          recordId: input.recordId,
          path: `${path}.url`,
          mediaType:
            typeof item["mediaType"] === "string" ? item["mediaType"] : "application/octet-stream",
          ...(typeof item["filename"] === "string" ? { filename: item["filename"] } : {}),
        });
        break;
      case item["type"] === "blob":
        return fail({
          kind: input.kind,
          recordId: input.recordId,
          field: path,
          reason: "Schema-5 state contains a partially migrated blob reference",
        });
    }
    if (isDecodeFailure(candidate)) return candidate;
    if (candidate) input.blobs.push(candidate);
  }
}

function inspectLegacyMessages(input: {
  readonly value: unknown;
  readonly kind: "request-transcript" | "surface-projection" | "lineage-manifest";
  readonly recordId: string;
  readonly field: string;
}): InspectedMessages | LegacyTranscriptDecodeFailure {
  const decoded = modelMessagesSchema.safeParse(input.value);
  if (!decoded.success) {
    return fail({
      kind: input.kind,
      recordId: input.recordId,
      field: input.field,
      reason: "Persisted schema-5 messages are invalid",
    });
  }
  const blobs: InlineBlobIdentity[] = [];
  for (const [messageIndex, message] of decoded.data.entries()) {
    if (!Array.isArray(message.content)) continue;
    for (const [partIndex, part] of message.content.entries()) {
      const path = `${input.field}[${messageIndex}].content[${partIndex}]`;
      let candidate: InlineBlobIdentity | null | LegacyTranscriptDecodeFailure = null;
      if (part.type === "file" || part.type === "reasoning-file") {
        candidate = inspectBinaryData({
          value: part.data,
          kind: input.kind,
          recordId: input.recordId,
          path: `${path}.data`,
          mediaType: part.mediaType,
          ...(part.type === "file" && part.filename !== undefined
            ? { filename: part.filename }
            : {}),
        });
      } else if (part.type === "image") {
        candidate = inspectBinaryData({
          value: part.image,
          kind: input.kind,
          recordId: input.recordId,
          path: `${path}.image`,
          mediaType: part.mediaType ?? "image",
        });
      } else if (part.type === "tool-result") {
        const toolResult = inspectToolResult({
          output: part.output,
          kind: input.kind,
          recordId: input.recordId,
          path: `${path}.output`,
          blobs,
        });
        if (isDecodeFailure(toolResult)) return toolResult;
      }
      if (isDecodeFailure(candidate)) return candidate;
      if (candidate) blobs.push(candidate);
    }
  }
  return { messages: decoded.data, blobs };
}

function sourceSummary(
  kind: LegacyTranscriptMigrationSourceSummary["kind"],
  records: readonly LegacyTranscriptJsonRecordIdentity[],
): LegacyTranscriptMigrationSourceSummary {
  return {
    kind,
    recordCount: records.length,
    blobCount: records.reduce((sum, record) => sum + record.blobCount, 0),
    byteLength: records.reduce((sum, record) => sum + record.byteLength, 0),
  };
}

function inspectTranscriptRow(
  rowValue: unknown,
): InspectedTranscriptRow | LegacyTranscriptDecodeFailure {
  const decodedRow = legacyTranscriptRowSchema.safeParse(rowValue);
  if (!decodedRow.success) {
    return fail({
      kind: "request-transcript",
      recordId: "unknown",
      field: "row",
      reason: "Persisted schema-5 transcript row is invalid",
    });
  }
  const row = decodedRow.data;
  const serialized = decodeSerialized({
    raw: row.messages_json,
    kind: "request-transcript",
    recordId: row.request_id,
    field: "messages_json",
  });
  if (isDecodeFailure(serialized)) return serialized;
  const inspected = inspectLegacyMessages({
    value: serialized,
    kind: "request-transcript",
    recordId: row.request_id,
    field: "messages_json",
  });
  if (isDecodeFailure(inspected)) return inspected;
  if (hashCanonicalMessagesV1(inspected.messages).hash !== row.transcript_digest) {
    return fail({
      kind: "request-transcript",
      recordId: row.request_id,
      field: "transcript_digest",
      reason: "Persisted schema-5 transcript digest does not match its messages",
    });
  }
  const contextMeta =
    row.context_meta_json === null
      ? null
      : compactionContextSchema.safeParse(
          decodeSerialized({
            raw: row.context_meta_json,
            kind: "request-transcript",
            recordId: row.request_id,
            field: "context_meta_json",
          }),
        );
  if (contextMeta !== null && !contextMeta.success)
    return fail({
      kind: "request-transcript",
      recordId: row.request_id,
      field: "context_meta_json",
      reason: "Persisted schema-5 transcript compaction metadata is invalid",
    });
  const providerState =
    row.provider_state_json === null
      ? null
      : historyProviderStateSchema.safeParse(
          decodeSerialized({
            raw: row.provider_state_json,
            kind: "request-transcript",
            recordId: row.request_id,
            field: "provider_state_json",
          }),
        );
  if (providerState !== null && !providerState.success)
    return fail({
      kind: "request-transcript",
      recordId: row.request_id,
      field: "provider_state_json",
      reason: "Persisted schema-5 transcript provider state is invalid",
    });
  return {
    recordId: row.request_id,
    serializedHash: sha256(JSON.stringify(row)),
    blobCount: inspected.blobs.length,
    byteLength: inspected.blobs.reduce((sum, blob) => sum + blob.byteLength, 0),
    fact: {
      requestId: row.request_id,
      requestClient: row.request_client,
      sessionId: row.session_id,
      stableNamedRequestClient: row.stable_named_request_client,
      providerState: providerState?.data ?? null,
      hasContextMeta: contextMeta !== null,
      legacyDigest: row.transcript_digest,
      messageCount: inspected.messages.length,
    },
  };
}

function projectionRecordId(row: LegacyProjectionRow): string {
  return [
    row.request_client,
    row.surface_id,
    row.session_id,
    row.message_id,
    row.projection_format_version,
  ].join(":");
}

function findDataUrl(value: unknown, path = "source_facts_json"): string | null {
  if (typeof value === "string") return /^data:/iu.test(value) ? path : null;
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = findDataUrl(entry, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, entry] of Object.entries(value)) {
    const found = findDataUrl(entry, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function inspectProjectionRow(
  rowValue: unknown,
): LegacyTranscriptJsonRecordIdentity | LegacyTranscriptDecodeFailure {
  const decodedRow = legacyProjectionRowSchema.safeParse(rowValue);
  if (!decodedRow.success) {
    return fail({
      kind: "surface-projection",
      recordId: "unknown",
      field: "row",
      reason: "Persisted schema-5 projection row is invalid",
    });
  }
  const row = decodedRow.data;
  const recordId = projectionRecordId(row);
  const messages = decodeSerialized({
    raw: row.canonical_messages_json,
    kind: "surface-projection",
    recordId,
    field: "canonical_messages_json",
  });
  if (isDecodeFailure(messages)) return messages;
  const inspected = inspectLegacyMessages({
    value: messages,
    kind: "surface-projection",
    recordId,
    field: "canonical_messages_json",
  });
  if (isDecodeFailure(inspected)) return inspected;
  const sourceFacts = decodeSerialized({
    raw: row.source_facts_json,
    kind: "surface-projection",
    recordId,
    field: "source_facts_json",
  });
  if (isDecodeFailure(sourceFacts)) return sourceFacts;
  const sourceFactsDecoded = z.record(z.string(), z.json()).safeParse(sourceFacts);
  if (!sourceFactsDecoded.success) {
    return fail({
      kind: "surface-projection",
      recordId,
      field: "source_facts_json",
      reason: "Persisted schema-5 projection source facts are invalid",
    });
  }
  const dataUrlPath = findDataUrl(sourceFactsDecoded.data);
  if (dataUrlPath) {
    return fail({
      kind: "surface-projection",
      recordId,
      field: dataUrlPath,
      reason: "Projection source facts contain an unsupported data URL",
    });
  }
  return {
    recordId,
    serializedHash: canonicalIdentityHash({
      canonicalMessages: sha256(row.canonical_messages_json),
      sourceFacts: sha256(row.source_facts_json),
    }),
    blobCount: inspected.blobs.length,
    byteLength: inspected.blobs.reduce((sum, blob) => sum + blob.byteLength, 0),
  };
}

function canonicalizeJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeJson((value as Record<string, unknown>)[key])]),
  );
}

function legacyLineagePrefixDigest(
  atoms: readonly z.output<typeof legacyLineageAtomSchema>[],
): string {
  const domain = "lilac:core-primary-lineage:v1";
  let digest = sha256(domain);
  for (const [index, atom] of atoms.entries()) {
    const encodedIndex = Buffer.alloc(8);
    encodedIndex.writeBigUInt64BE(BigInt(index + 1));
    digest = createHash("sha256")
      .update(domain, "utf8")
      .update(encodedIndex)
      .update(Buffer.from(digest, "hex"))
      .update(globalThis.JSON.stringify(canonicalizeJson(atom)), "utf8")
      .digest("hex");
  }
  return digest;
}

function validateLegacyManifest(input: {
  readonly manifest: LegacyLineageManifest;
  readonly recordId: string;
}): void | LegacyTranscriptDecodeFailure {
  let canonicalEnd = 0;
  const atoms: z.output<typeof legacyLineageAtomSchema>[] = [];
  for (const segment of input.manifest.segments) {
    if (segment.canonicalStart !== canonicalEnd) {
      return fail({
        kind: "lineage-manifest",
        recordId: input.recordId,
        field: "manifest_json",
        reason: "Schema-5 lineage canonical ranges are not contiguous",
      });
    }
    canonicalEnd += segment.canonicalMessages.length;
    atoms.push(...segment.atoms);
    if (
      segment.canonicalEnd !== canonicalEnd ||
      segment.cumulativeAtomCount !== atoms.length ||
      segment.cumulativePrefixDigest !== legacyLineagePrefixDigest(atoms)
    ) {
      return fail({
        kind: "lineage-manifest",
        recordId: input.recordId,
        field: "manifest_json",
        reason: "Schema-5 lineage derived fields do not match its content",
      });
    }
  }
  if (
    !input.manifest.segments.some(
      (segment) => segment.canonicalStart === input.manifest.currentCanonicalStart,
    )
  ) {
    return fail({
      kind: "lineage-manifest",
      recordId: input.recordId,
      field: "manifest_json",
      reason: "Schema-5 lineage current canonical start is not a segment boundary",
    });
  }
}

function inspectLineageRow(rowValue: unknown): InspectedLineageRow | LegacyTranscriptDecodeFailure {
  const decodedRow = legacyLineageRowSchema.safeParse(rowValue);
  if (!decodedRow.success) {
    return fail({
      kind: "lineage-manifest",
      recordId: "unknown",
      field: "row",
      reason: "Persisted schema-5 lineage row is invalid",
    });
  }
  const row = decodedRow.data;
  const serialized = decodeSerialized({
    raw: row.manifest_json,
    kind: "lineage-manifest",
    recordId: row.request_id,
    field: "manifest_json",
  });
  if (isDecodeFailure(serialized)) return serialized;
  const decodedManifest = legacyLineageManifestSchema.safeParse(serialized);
  if (!decodedManifest.success) {
    return fail({
      kind: "lineage-manifest",
      recordId: row.request_id,
      field: "manifest_json",
      reason: "Persisted schema-5 lineage manifest is invalid",
    });
  }
  const manifest = decodedManifest.data;
  const validation = validateLegacyManifest({ manifest, recordId: row.request_id });
  if (isDecodeFailure(validation)) return validation;
  let blobCount = 0;
  let byteLength = 0;
  for (const [segmentIndex, segment] of manifest.segments.entries()) {
    const inspected = inspectLegacyMessages({
      value: segment.canonicalMessages,
      kind: "lineage-manifest",
      recordId: row.request_id,
      field: `manifest_json.segments[${segmentIndex}].canonicalMessages`,
    });
    if (isDecodeFailure(inspected)) return inspected;
    blobCount += inspected.blobs.length;
    byteLength += inspected.blobs.reduce((sum, blob) => sum + blob.byteLength, 0);
  }
  return {
    recordId: row.request_id,
    serializedHash: sha256(row.manifest_json),
    blobCount,
    byteLength,
    manifest,
  };
}

function legacyPrimaryHead(
  manifest: LegacyLineageManifest,
  transcript: LegacyTranscriptFact,
): LegacyPrimaryHead | null {
  const lastSegment = manifest.segments[manifest.segments.length - 1];
  if (
    !lastSegment ||
    transcript.messageCount <= 0 ||
    transcript.providerState === null ||
    transcript.hasContextMeta
  )
    return null;
  const atoms = [
    ...manifest.segments.flatMap((segment) => segment.atoms),
    {
      kind: "request" as const,
      requestId: transcript.requestId,
      transcriptDigest: transcript.legacyDigest,
      providerFamily: transcript.providerState.lastFamily,
      containsCrossFamilyTurns: transcript.providerState.containsCrossFamilyTurns,
    },
  ];
  return {
    lineageVersion: 1,
    atomCount: lastSegment.cumulativeAtomCount + 1,
    prefixDigest: legacyLineagePrefixDigest(atoms),
    canonicalMessageCount: lastSegment.canonicalEnd + transcript.messageCount,
  };
}

function primaryHeadKey(head: LegacyPrimaryHead | CorePrimaryClaudeBindingHead): string {
  return `${head.atomCount}:${head.prefixDigest}:${head.canonicalMessageCount}`;
}

function continuationIdentity(recordId: string, row: object): LegacyTranscriptJsonRecordIdentity {
  return {
    recordId,
    serializedHash: sha256(JSON.stringify(row)),
    blobCount: 0,
    byteLength: 0,
  };
}

function continuationFailure(input: {
  readonly kind:
    | "named-claude-binding"
    | "named-claude-attempt"
    | "primary-claude-binding"
    | "primary-claude-attempt";
  readonly recordId: string;
  readonly field: string;
  readonly reason: string;
}): LegacyTranscriptDecodeFailure {
  return fail(input);
}

function namedTerminalMatches(input: {
  readonly transcript: LegacyTranscriptFact;
  readonly requestClient: z.output<typeof adapterPlatformSchema>;
  readonly sessionId: string;
  readonly hash: string;
  readonly messageCount: number;
}): boolean {
  // requestClient records the transport that produced the transcript. Named continuation ownership is
  // the separately published stableNamedRequestClient marker and may intentionally cross transports.
  return (
    input.transcript.sessionId === input.sessionId &&
    input.transcript.stableNamedRequestClient === input.requestClient &&
    input.transcript.providerState?.lastFamily === "claude-code" &&
    input.transcript.legacyDigest === input.hash &&
    input.transcript.messageCount === input.messageCount
  );
}

function resolvePrimaryCandidate<TCandidate extends LegacyPrimaryCandidate>(input: {
  readonly requestId: string | null;
  readonly head: LegacyPrimaryHead;
  readonly requestClient: "discord";
  readonly sessionId: string;
  readonly candidates: readonly TCandidate[];
}): TCandidate | null {
  const matches = input.candidates.filter(
    (candidate) =>
      (input.requestId === null || candidate.requestId === input.requestId) &&
      candidate.transcript.requestClient === input.requestClient &&
      candidate.transcript.sessionId === input.sessionId &&
      candidate.transcript.providerState?.lastFamily === "claude-code" &&
      primaryHeadKey(candidate.oldHead) === primaryHeadKey(input.head),
  );
  return matches.length === 1 ? matches[0]! : null;
}

function validateNamedContinuationReference(input: {
  readonly kind: "named-claude-binding" | "named-claude-attempt";
  readonly recordId: string;
  readonly field: "source" | "terminal";
  readonly requestClient: z.output<typeof adapterPlatformSchema>;
  readonly sessionId: string;
  readonly requestId: string | null;
  readonly hash: string | null;
  readonly messageCount: number | null;
  readonly transcripts: ReadonlyMap<string, LegacyTranscriptFact>;
}): LegacyTranscriptDecodeFailure | null {
  if (input.requestId === null && input.hash === null && input.messageCount === null) return null;
  if (input.requestId === null || input.hash === null || input.messageCount === null) {
    return continuationFailure({
      kind: input.kind,
      recordId: input.recordId,
      field: input.field,
      reason: "Schema-5 named continuation transcript identity is incomplete",
    });
  }
  const transcript = input.transcripts.get(input.requestId);
  if (
    transcript === undefined ||
    !namedTerminalMatches({
      transcript,
      requestClient: input.requestClient,
      sessionId: input.sessionId,
      hash: input.hash,
      messageCount: input.messageCount,
    })
  ) {
    return continuationFailure({
      kind: input.kind,
      recordId: input.recordId,
      field: input.field,
      reason: "Schema-5 named continuation transcript identity is corrupt or unverifiable",
    });
  }
  return null;
}

function optionalLegacyPrimaryHead(input: {
  readonly lineageVersion: 1 | null;
  readonly atomCount: number | null;
  readonly prefixDigest: string | null;
  readonly canonicalMessageCount: number | null;
}): LegacyPrimaryHead | null | LegacyTranscriptDecodeFailure {
  if (
    input.lineageVersion === null &&
    input.atomCount === null &&
    input.prefixDigest === null &&
    input.canonicalMessageCount === null
  )
    return null;
  if (
    input.lineageVersion === null ||
    input.atomCount === null ||
    input.prefixDigest === null ||
    input.canonicalMessageCount === null
  )
    return continuationFailure({
      kind: "primary-claude-attempt",
      recordId: "unknown",
      field: "lineage-head",
      reason: "Schema-5 primary continuation lineage identity is incomplete",
    });
  return {
    lineageVersion: input.lineageVersion,
    atomCount: input.atomCount,
    prefixDigest: input.prefixDigest,
    canonicalMessageCount: input.canonicalMessageCount,
  };
}

function boundedReport(input: {
  readonly sources: readonly LegacyTranscriptMigrationSourceSummary[];
  readonly blockers: readonly LegacyTranscriptMigrationBlocker[];
}): LegacyTranscriptMigrationReport {
  return {
    schemaVersion: LEGACY_TRANSCRIPT_SCHEMA_VERSION,
    sources: input.sources,
    totalBlobCount: input.sources.reduce((sum, source) => sum + source.blobCount, 0),
    totalByteLength: input.sources.reduce((sum, source) => sum + source.byteLength, 0),
    blockerCount: input.blockers.length,
    blockers: input.blockers.slice(0, MAX_REPORT_BLOCKERS),
  };
}

function preflightUnsafe(
  dbPath: string,
): LegacyTranscriptPreflight | LegacyTranscriptDecodeFailure {
  using database = new Database(dbPath, { readonly: true, strict: true });
  const versions = database
    .query<{ version: number }, []>(
      "SELECT version FROM transcript_schema_migrations ORDER BY version ASC",
    )
    .all()
    .map((row) => row.version);
  if (
    versions.length !== LEGACY_TRANSCRIPT_SCHEMA_VERSION ||
    versions.some((version, index) => version !== index + 1)
  ) {
    return fail({
      kind: "schema",
      recordId: "transcript_schema_migrations",
      field: "version",
      reason: "Expected the exact Core transcript schema-5 migration sequence",
    });
  }
  for (const [table, expectedColumns] of Object.entries(REQUIRED_SCHEMA5_TABLE_COLUMNS)) {
    const columns = database
      .query<{ name: string }, []>(`PRAGMA table_info("${table}")`)
      .all()
      .map(({ name }) => name);
    if (
      columns.length !== expectedColumns.length ||
      columns.some((column, index) => column !== expectedColumns[index])
    ) {
      return fail({
        kind: "schema",
        recordId: table,
        field: "columns",
        reason: `Expected the exact schema-5 layout for '${table}'`,
      });
    }
  }
  const schemaObjects = database
    .query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' AND type IN ('index', 'table', 'trigger', 'view')
       ORDER BY type, name`,
    )
    .all();
  const expectedSchemaObjects = new Map(
    LEGACY_TRANSCRIPT_SCHEMA5_OBJECT_CATALOG.map((entry) => [`${entry.type}:${entry.name}`, entry]),
  );
  const actualSchemaObjects = new Map(
    schemaObjects.map((entry) => [`${entry.type}:${entry.name}`, entry]),
  );
  for (const [key, expected] of expectedSchemaObjects) {
    const actual = actualSchemaObjects.get(key);
    if (
      actual === undefined ||
      actual.tbl_name !== expected.tableName ||
      actual.sql === null ||
      sha256(actual.sql.replace(/\s+/gu, " ").trim()) !== expected.sqlSha256
    ) {
      return fail({
        kind: "schema",
        recordId: expected.name,
        field: "sqlite_schema",
        reason: `Expected the exact schema-5 definition for '${expected.name}'`,
      });
    }
  }
  for (const [key, actual] of actualSchemaObjects) {
    if (!expectedSchemaObjects.has(key)) {
      return fail({
        kind: "schema",
        recordId: actual.name,
        field: "sqlite_schema",
        reason: `Unexpected schema-5 database object '${actual.name}'`,
      });
    }
  }
  for (const index of REQUIRED_SCHEMA5_INDEXES) {
    if (
      database
        .query<{ name: string }, [string]>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        )
        .get(index) === null
    ) {
      return fail({
        kind: "schema",
        recordId: index,
        field: "index",
        reason: `Expected the schema-5 index '${index}'`,
      });
    }
  }
  const foreignKeyFailures = database.query<unknown, []>("PRAGMA foreign_key_check").all();
  const decodedForeignKeyFailure = foreignKeyFailures[0]
    ? foreignKeyFailureSchema.safeParse(foreignKeyFailures[0])
    : null;
  if (decodedForeignKeyFailure && !decodedForeignKeyFailure.success) {
    return fail({
      kind: "foreign-key",
      recordId: "unknown",
      field: "PRAGMA foreign_key_check",
      reason: "Schema-5 foreign-key check returned an invalid row",
    });
  }
  if (decodedForeignKeyFailure?.success) {
    const first = decodedForeignKeyFailure.data;
    return fail({
      kind: "foreign-key",
      recordId: `${first.table}:${first.rowid ?? "unknown"}`,
      field: `fkid:${first.fkid}`,
      reason: `Schema-5 foreign key to '${first.parent}' is invalid`,
    });
  }

  const ownedRows = database
    .query<unknown, []>("SELECT * FROM core_owned_blobs ORDER BY sha256 ASC")
    .all();
  const inspectedOwnedBlobs = ownedRows.map((rowValue) => {
    const decodedRow = legacyOwnedBlobRowSchema.safeParse(rowValue);
    if (!decodedRow.success) {
      return fail({
        kind: "owned-blob",
        recordId: "unknown",
        field: "row",
        reason: "Persisted schema-5 owned BLOB row is invalid",
      });
    }
    const row = decodedRow.data;
    if (row.bytes.byteLength !== row.byte_length || sha256(row.bytes) !== row.sha256) {
      return fail({
        kind: "owned-blob",
        recordId: row.sha256,
        field: "bytes",
        reason: "Schema-5 owned BLOB fails byte-length or SHA-256 validation",
      });
    }
    return {
      sha256: row.sha256,
      byteLength: row.byte_length,
      metadataHash: canonicalIdentityHash({
        mediaType: row.media_type,
        filename: row.filename,
        createdAt: row.created_ts,
      }),
    };
  });
  const ownedFailure = inspectedOwnedBlobs.find(isDecodeFailure);
  if (ownedFailure) return ownedFailure;
  const ownedBlobs = inspectedOwnedBlobs.filter(isDecodeSuccess);

  const inspectedRequestTranscripts = database
    .query<unknown, []>("SELECT * FROM request_transcripts ORDER BY request_id ASC")
    .all()
    .map(inspectTranscriptRow);
  const transcriptFailure = inspectedRequestTranscripts.find(isDecodeFailure);
  if (transcriptFailure) return transcriptFailure;
  const requestTranscripts = inspectedRequestTranscripts.filter(isDecodeSuccess);
  const inspectedSurfaceProjections = database
    .query<unknown, []>(
      `SELECT * FROM core_surface_projections
       ORDER BY request_client, surface_id, session_id, message_id, projection_format_version`,
    )
    .all()
    .map(inspectProjectionRow);
  const projectionFailure = inspectedSurfaceProjections.find(isDecodeFailure);
  if (projectionFailure) return projectionFailure;
  const surfaceProjections = inspectedSurfaceProjections.filter(isDecodeSuccess);
  const inspectedLineageManifests = database
    .query<unknown, []>("SELECT * FROM core_primary_lineage_manifests ORDER BY request_id ASC")
    .all()
    .map(inspectLineageRow);
  const lineageFailure = inspectedLineageManifests.find(isDecodeFailure);
  if (lineageFailure) return lineageFailure;
  const lineageManifests = inspectedLineageManifests.filter(isDecodeSuccess);

  const transcriptByRequestId = new Map(
    requestTranscripts.map((transcript) => [transcript.fact.requestId, transcript.fact]),
  );
  const lineageByRequestId = new Map(
    lineageManifests.map((lineage) => [lineage.recordId, lineage.manifest]),
  );
  const primaryCandidates: LegacyPrimaryCandidate[] = [];
  for (const [requestId, manifest] of lineageByRequestId) {
    const transcript = transcriptByRequestId.get(requestId);
    if (transcript === undefined) continue;
    const oldHead = legacyPrimaryHead(manifest, transcript);
    if (oldHead !== null) primaryCandidates.push({ requestId, transcript, oldHead });
  }

  const namedClaudeBindings: LegacyTranscriptJsonRecordIdentity[] = [];
  for (const raw of database
    .query<unknown, []>(
      "SELECT * FROM core_named_claude_bindings ORDER BY request_client, session_id, provider_id",
    )
    .all()) {
    const decoded = legacyNamedClaudeBindingRowSchema.safeParse(raw);
    if (!decoded.success)
      return continuationFailure({
        kind: "named-claude-binding",
        recordId: "unknown",
        field: "row",
        reason: "Persisted schema-5 named Claude binding is invalid",
      });
    const row = decoded.data;
    const recordId = `${row.request_client}:${row.session_id}:${row.provider_id}`;
    const invalid = validateNamedContinuationReference({
      kind: "named-claude-binding",
      recordId,
      field: "terminal",
      requestClient: row.request_client,
      sessionId: row.session_id,
      requestId: row.terminal_request_id,
      hash: row.canonical_head_hash,
      messageCount: row.canonical_message_count,
      transcripts: transcriptByRequestId,
    });
    if (invalid !== null) return invalid;
    namedClaudeBindings.push(continuationIdentity(recordId, row));
  }

  const namedClaudeAttempts: LegacyTranscriptJsonRecordIdentity[] = [];
  for (const raw of database
    .query<unknown, []>(
      `SELECT * FROM core_named_claude_attempts
       ORDER BY request_client, session_id, provider_id, request_id, attempt_index`,
    )
    .all()) {
    const decoded = legacyNamedClaudeAttemptRowSchema.safeParse(raw);
    if (!decoded.success)
      return continuationFailure({
        kind: "named-claude-attempt",
        recordId: "unknown",
        field: "row",
        reason: "Persisted schema-5 named Claude attempt is invalid",
      });
    const row = decoded.data;
    const recordId = `${row.request_client}:${row.session_id}:${row.provider_id}:${row.request_id}:${row.attempt_index}`;
    const invalidSource = validateNamedContinuationReference({
      kind: "named-claude-attempt",
      recordId,
      field: "source",
      requestClient: row.request_client,
      sessionId: row.session_id,
      requestId: row.source_terminal_request_id,
      hash: row.source_canonical_head_hash,
      messageCount: row.source_canonical_message_count,
      transcripts: transcriptByRequestId,
    });
    if (invalidSource !== null) return invalidSource;
    const invalidTerminal = validateNamedContinuationReference({
      kind: "named-claude-attempt",
      recordId,
      field: "terminal",
      requestClient: row.request_client,
      sessionId: row.session_id,
      requestId: row.terminal_request_id,
      hash: row.terminal_canonical_head_hash,
      messageCount: row.terminal_canonical_message_count,
      transcripts: transcriptByRequestId,
    });
    if (invalidTerminal !== null) return invalidTerminal;
    namedClaudeAttempts.push(continuationIdentity(recordId, row));
  }

  const primaryClaudeBindings: LegacyTranscriptJsonRecordIdentity[] = [];
  for (const raw of database
    .query<unknown, []>(
      "SELECT * FROM core_primary_claude_bindings ORDER BY request_client, session_id, provider_id",
    )
    .all()) {
    const decoded = legacyPrimaryClaudeBindingRowSchema.safeParse(raw);
    if (!decoded.success)
      return continuationFailure({
        kind: "primary-claude-binding",
        recordId: "unknown",
        field: "row",
        reason: "Persisted schema-5 primary Claude binding is invalid",
      });
    const row = decoded.data;
    const recordId = `${row.request_client}:${row.session_id}:${row.provider_id}`;
    const candidate = resolvePrimaryCandidate({
      requestId: row.terminal_request_id,
      head: {
        lineageVersion: row.lineage_version,
        atomCount: row.atom_count,
        prefixDigest: row.prefix_digest,
        canonicalMessageCount: row.canonical_message_count,
      },
      requestClient: row.request_client,
      sessionId: row.session_id,
      candidates: primaryCandidates,
    });
    if (candidate === null)
      return continuationFailure({
        kind: "primary-claude-binding",
        recordId,
        field: "lineage-head",
        reason: "Schema-5 primary Claude binding lineage is corrupt, ambiguous, or unmappable",
      });
    primaryClaudeBindings.push(continuationIdentity(recordId, row));
  }

  const primaryClaudeAttempts: LegacyTranscriptJsonRecordIdentity[] = [];
  for (const raw of database
    .query<unknown, []>(
      `SELECT * FROM core_primary_claude_attempts
       ORDER BY request_client, session_id, provider_id, request_id, attempt_index`,
    )
    .all()) {
    const decoded = legacyPrimaryClaudeAttemptRowSchema.safeParse(raw);
    if (!decoded.success)
      return continuationFailure({
        kind: "primary-claude-attempt",
        recordId: "unknown",
        field: "row",
        reason: "Persisted schema-5 primary Claude attempt is invalid",
      });
    const row = decoded.data;
    const recordId = `${row.request_client}:${row.session_id}:${row.provider_id}:${row.request_id}:${row.attempt_index}`;
    const sourceHead = optionalLegacyPrimaryHead({
      lineageVersion: row.source_lineage_version,
      atomCount: row.source_atom_count,
      prefixDigest: row.source_prefix_digest,
      canonicalMessageCount: row.source_canonical_message_count,
    });
    if (isDecodeFailure(sourceHead))
      return continuationFailure({
        kind: "primary-claude-attempt",
        recordId,
        field: "source",
        reason: sourceHead.blocker.reason,
      });
    if (
      sourceHead !== null &&
      resolvePrimaryCandidate({
        requestId: null,
        head: sourceHead,
        requestClient: row.request_client,
        sessionId: row.session_id,
        candidates: primaryCandidates,
      }) === null
    )
      return continuationFailure({
        kind: "primary-claude-attempt",
        recordId,
        field: "source",
        reason:
          "Schema-5 primary Claude attempt source lineage is corrupt, ambiguous, or unmappable",
      });
    const terminalHead = optionalLegacyPrimaryHead({
      lineageVersion: row.terminal_lineage_version,
      atomCount: row.terminal_atom_count,
      prefixDigest: row.terminal_prefix_digest,
      canonicalMessageCount: row.terminal_canonical_message_count,
    });
    if (
      isDecodeFailure(terminalHead) ||
      (terminalHead === null) !== (row.terminal_request_id === null)
    )
      return continuationFailure({
        kind: "primary-claude-attempt",
        recordId,
        field: "terminal",
        reason: "Schema-5 primary Claude attempt terminal lineage identity is incomplete",
      });
    if (
      terminalHead !== null &&
      resolvePrimaryCandidate({
        requestId: row.terminal_request_id,
        head: terminalHead,
        requestClient: row.request_client,
        sessionId: row.session_id,
        candidates: primaryCandidates,
      }) === null
    )
      return continuationFailure({
        kind: "primary-claude-attempt",
        recordId,
        field: "terminal",
        reason: "Schema-5 primary Claude attempt terminal lineage is corrupt or unmappable",
      });
    primaryClaudeAttempts.push(continuationIdentity(recordId, row));
  }

  const sources = [
    {
      kind: "owned-blob" as const,
      recordCount: ownedBlobs.length,
      blobCount: ownedBlobs.length,
      byteLength: ownedBlobs.reduce((sum, blob) => sum + blob.byteLength, 0),
    },
    sourceSummary("request-transcript", requestTranscripts),
    sourceSummary("surface-projection", surfaceProjections),
    sourceSummary("lineage-manifest", lineageManifests),
  ];
  const report = boundedReport({ sources, blockers: [] });
  const planWithoutIdentity = {
    version: MIGRATION_PLAN_VERSION,
    schemaVersion: LEGACY_TRANSCRIPT_SCHEMA_VERSION,
    ownedBlobs,
    requestTranscripts: requestTranscripts.map(({ fact: _, ...identity }) => identity),
    surfaceProjections,
    lineageManifests: lineageManifests.map(({ manifest: _, ...identity }) => identity),
    namedClaudeBindings,
    namedClaudeAttempts,
    primaryClaudeBindings,
    primaryClaudeAttempts,
  } as const;
  return {
    report,
    plan: {
      ...planWithoutIdentity,
      databaseIdentity: canonicalIdentityHash(planWithoutIdentity),
    },
  };
}

function genericBlocker(reason: string): LegacyTranscriptMigrationBlocker {
  return { kind: "schema", recordId: "agent-transcripts.db", field: "database", reason };
}

export function preflightLegacyTranscriptDb(
  dbPath: string,
): ResultType<LegacyTranscriptPreflight, LegacyTranscriptMigrationPreflightFailed> {
  const captured = Result.try({
    try: () => preflightUnsafe(dbPath),
    catch: (cause) => ({ cause }),
  });
  if (captured.isErr()) {
    if (Panic.is(captured.error.cause)) preserveToolPanic(captured.error.cause);
    const blocker = genericBlocker("Unable to decode the schema-5 Core transcript database");
    return Result.err(
      new LegacyTranscriptMigrationPreflightFailed({
        report: boundedReport({ sources: [], blockers: [blocker] }),
        message: blocker.reason,
      }),
    );
  }
  if (isDecodeFailure(captured.value)) {
    const blocker = captured.value.blocker;
    return Result.err(
      new LegacyTranscriptMigrationPreflightFailed({
        report: boundedReport({ sources: [], blockers: [blocker] }),
        message: blocker.reason,
      }),
    );
  }
  return Result.ok(captured.value);
}

type MigratedOwnedBlob = {
  readonly legacySha256?: string;
  readonly blob: BlobRefV1;
  readonly mediaType: string;
  readonly filename: string;
  readonly createdAt: number;
};

type MigratedTranscript = {
  readonly requestId: string;
  readonly messagesJson: string;
  readonly transcriptDigest: string;
};

type MigratedProjection = {
  readonly recordId: string;
  readonly requestClient: string;
  readonly surfaceId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly projectionFormatVersion: number;
  readonly canonicalMessagesJson: string;
  readonly sourceFactsJson: string;
};

type MigratedLineage = {
  readonly requestId: string;
  readonly manifestJson: string;
};

type MigratedNamedClaudeBinding = Omit<
  LegacyNamedClaudeBindingRow,
  "canonical_hash_version" | "canonical_head_hash"
> & {
  readonly canonical_hash_version: 2;
  readonly canonical_head_hash: string;
};

type MigratedNamedClaudeAttempt = LegacyNamedClaudeAttemptRow;

type MigratedPrimaryClaudeBinding = Omit<
  LegacyPrimaryClaudeBindingRow,
  | "terminal_request_id"
  | "lineage_version"
  | "atom_count"
  | "prefix_digest"
  | "canonical_message_count"
> & {
  readonly terminal_request_id: string;
  readonly lineage_version: 2;
  readonly atom_count: number;
  readonly prefix_digest: string;
  readonly canonical_message_count: number;
};

type MigratedPrimaryClaudeAttempt = Omit<
  LegacyPrimaryClaudeAttemptRow,
  | "source_lineage_version"
  | "source_atom_count"
  | "source_prefix_digest"
  | "source_canonical_message_count"
  | "terminal_lineage_version"
  | "terminal_atom_count"
  | "terminal_prefix_digest"
  | "terminal_canonical_message_count"
> & {
  readonly source_lineage_version: 2 | null;
  readonly source_atom_count: number | null;
  readonly source_prefix_digest: string | null;
  readonly source_canonical_message_count: number | null;
  readonly terminal_lineage_version: 2 | null;
  readonly terminal_atom_count: number | null;
  readonly terminal_prefix_digest: string | null;
  readonly terminal_canonical_message_count: number | null;
};

type MigratedPrimaryCandidate = LegacyPrimaryCandidate & {
  readonly newHead: CorePrimaryClaudeBindingHead;
};

export type TranscriptBlobStorageSchema6MigrationArtifacts = {
  readonly ownedBlobs: readonly MigratedOwnedBlob[];
  readonly requestTranscripts: readonly MigratedTranscript[];
  readonly surfaceProjections: readonly MigratedProjection[];
  readonly lineageManifests: readonly MigratedLineage[];
  readonly namedClaudeBindings: readonly MigratedNamedClaudeBinding[];
  readonly namedClaudeAttempts: readonly MigratedNamedClaudeAttempt[];
  readonly primaryClaudeBindings: readonly MigratedPrimaryClaudeBinding[];
  readonly primaryClaudeAttempts: readonly MigratedPrimaryClaudeAttempt[];
};

const stagedTranscriptArtifacts = Symbol("staged-transcript-artifacts");

export type StagedLegacyTranscriptMigration = {
  readonly report: LegacyTranscriptMigrationReport;
  readonly [stagedTranscriptArtifacts]: TranscriptBlobStorageSchema6MigrationArtifacts;
};

type CapturedSqliteOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "failure"; readonly cause: Error };

function captureSqliteOperation(operation: () => void): CapturedSqliteOutcome {
  return Result.try<void, { readonly cause: Error }>({
    try: operation,
    catch: captureError,
  }).match<CapturedSqliteOutcome>({
    ok: () => ({ kind: "ok" }),
    err: ({ cause }) => ({ kind: "failure", cause }),
  });
}

function applyFailure(input: {
  readonly stage: "plan-validation" | "upload" | "rewrite";
  readonly message: string;
  readonly recordKind?: LegacyTranscriptRecordKind;
  readonly recordId?: string;
}): LegacyTranscriptMigrationApplyFailed {
  return new LegacyTranscriptMigrationApplyFailed(input);
}

function decodeBinaryPayload(input: {
  readonly value: unknown;
  readonly kind: LegacyTranscriptRecordKind;
  readonly recordId: string;
  readonly path: string;
  readonly mediaType: string;
}): ResultType<
  { readonly bytes: Uint8Array; readonly mediaType: string },
  LegacyTranscriptMigrationApplyFailed
> {
  const value = input.value;
  let bytes: Uint8Array | LegacyTranscriptDecodeFailure | undefined;
  let mediaType = input.mediaType;
  if (typeof value === "string") {
    if (/^https?:\/\//iu.test(value)) {
      return Result.err(
        applyFailure({
          stage: "plan-validation",
          recordKind: input.kind,
          recordId: input.recordId,
          message: "A legacy external file URL has no schema-6 stored-message representation",
        }),
      );
    }
    const dataUrl = dataUrlBytes({ ...input, value });
    if (isDecodeFailure(dataUrl)) {
      return Result.err(
        applyFailure({
          stage: "plan-validation",
          recordKind: input.kind,
          recordId: input.recordId,
          message: dataUrl.blocker.reason,
        }),
      );
    }
    bytes = dataUrl?.bytes ?? strictBase64Bytes({ ...input, value });
    mediaType = dataUrl?.mediaType ?? mediaType;
  }
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof URL) {
    return decodeBinaryPayload({ ...input, value: value.href });
  }
  if (isRecord(value) && value["type"] === "data") {
    return decodeBinaryPayload({ ...input, value: value["data"] });
  }
  if (isRecord(value) && value["type"] === "url") {
    return decodeBinaryPayload({ ...input, value: value["url"] });
  }
  if (bytes === undefined) {
    return Result.err(
      applyFailure({
        stage: "plan-validation",
        recordKind: input.kind,
        recordId: input.recordId,
        message: "A persisted legacy file has no schema-6 stored-message representation",
      }),
    );
  }
  if (isDecodeFailure(bytes)) {
    return Result.err(
      applyFailure({
        stage: "plan-validation",
        recordKind: input.kind,
        recordId: input.recordId,
        message: bytes.blocker.reason,
      }),
    );
  }
  return Result.ok({ bytes, mediaType });
}

async function migrateBinaryPart(input: {
  readonly store: BlobStore;
  readonly ownedBlobs: MigratedOwnedBlob[];
  readonly createdAt: number;
  readonly value: unknown;
  readonly kind: LegacyTranscriptRecordKind;
  readonly recordId: string;
  readonly path: string;
  readonly mediaType: string;
  readonly filename?: string;
}): Promise<ResultType<unknown, LegacyTranscriptMigrationApplyFailed>> {
  return await Result.gen(async function* () {
    const decoded = yield* decodeBinaryPayload(input);
    const blob = yield* Result.await(
      uploadVerifiedDurableBlob(input.store, {
        bytes: decoded.bytes,
        expectedSha256: sha256(decoded.bytes),
      }).then((result) =>
        result.mapError(() =>
          applyFailure({
            stage: "upload",
            recordKind: input.kind,
            recordId: input.recordId,
            message: "A legacy transcript blob failed destination upload or verification",
          }),
        ),
      ),
    );
    input.ownedBlobs.push({
      blob,
      mediaType: decoded.mediaType,
      filename: input.filename ?? `migrated-${blob.objectId}`,
      createdAt: input.createdAt,
    });
    return Result.ok({
      type: "blob",
      blob,
      mediaType: decoded.mediaType,
      ...(input.filename === undefined ? {} : { filename: input.filename }),
    });
  });
}

async function migrateToolOutput(input: {
  readonly output: unknown;
  readonly store: BlobStore;
  readonly ownedBlobs: MigratedOwnedBlob[];
  readonly createdAt: number;
  readonly kind: LegacyTranscriptRecordKind;
  readonly recordId: string;
  readonly path: string;
}): Promise<ResultType<unknown, LegacyTranscriptMigrationApplyFailed>> {
  if (!isRecord(input.output) || input.output["type"] !== "content") {
    return Result.ok(input.output);
  }
  const output = input.output;
  const value = output["value"];
  if (!Array.isArray(value)) return Result.ok(input.output);
  return Result.gen(async function* () {
    const migrated: unknown[] = [];
    for (const [index, item] of value.entries()) {
      if (!isRecord(item) || typeof item["type"] !== "string") {
        migrated.push(item);
        continue;
      }
      const dataField =
        item["type"] === "file-url" || item["type"] === "image-url" ? "url" : "data";
      if (
        item["type"] === "file" ||
        item["type"] === "file-data" ||
        item["type"] === "image-data" ||
        item["type"] === "file-url" ||
        item["type"] === "image-url"
      ) {
        migrated.push(
          yield* Result.await(
            migrateBinaryPart({
              store: input.store,
              ownedBlobs: input.ownedBlobs,
              createdAt: input.createdAt,
              value: item[dataField],
              kind: input.kind,
              recordId: input.recordId,
              path: `${input.path}.value[${index}].${dataField}`,
              mediaType:
                typeof item["mediaType"] === "string"
                  ? item["mediaType"]
                  : "application/octet-stream",
              ...(typeof item["filename"] === "string" ? { filename: item["filename"] } : {}),
            }),
          ),
        );
      } else {
        migrated.push(item);
      }
    }
    return Result.ok({ ...output, value: migrated });
  });
}

function migratedMessageDigest(
  messages: readonly StoredMessageV1[],
  recordKind: LegacyTranscriptRecordKind,
  recordId: string,
): ResultType<string, LegacyTranscriptMigrationApplyFailed> {
  return hashCanonicalStoredMessagesV2(messages)
    .map(({ hash }) => hash)
    .mapError(() =>
      applyFailure({
        stage: "plan-validation",
        recordKind,
        recordId,
        message: "Migrated messages failed current canonical digest validation",
      }),
    );
}

async function migrateMessages(input: {
  readonly value: unknown;
  readonly store: BlobStore;
  readonly ownedBlobs: MigratedOwnedBlob[];
  readonly createdAt: number;
  readonly kind: "request-transcript" | "surface-projection" | "lineage-manifest";
  readonly recordId: string;
  readonly field: string;
}): Promise<ResultType<StoredMessageV1[], LegacyTranscriptMigrationApplyFailed>> {
  const legacy = modelMessagesSchema.safeParse(input.value);
  if (!legacy.success) {
    return Result.err(
      applyFailure({
        stage: "plan-validation",
        recordKind: input.kind,
        recordId: input.recordId,
        message: "Persisted schema-5 messages changed after preflight",
      }),
    );
  }
  return Result.gen(async function* () {
    const messages: unknown[] = [];
    for (const [messageIndex, message] of legacy.data.entries()) {
      if (!Array.isArray(message.content)) {
        messages.push(message);
        continue;
      }
      const content: unknown[] = [];
      for (const [partIndex, part] of message.content.entries()) {
        const path = `${input.field}[${messageIndex}].content[${partIndex}]`;
        if (part.type === "file" || part.type === "reasoning-file") {
          content.push(
            yield* Result.await(
              migrateBinaryPart({
                store: input.store,
                ownedBlobs: input.ownedBlobs,
                createdAt: input.createdAt,
                value: part.data,
                kind: input.kind,
                recordId: input.recordId,
                path: `${path}.data`,
                mediaType: part.mediaType,
                ...(part.type === "file" && part.filename !== undefined
                  ? { filename: part.filename }
                  : {}),
              }),
            ),
          );
        } else if (part.type === "image") {
          content.push(
            yield* Result.await(
              migrateBinaryPart({
                store: input.store,
                ownedBlobs: input.ownedBlobs,
                createdAt: input.createdAt,
                value: part.image,
                kind: input.kind,
                recordId: input.recordId,
                path: `${path}.image`,
                mediaType: part.mediaType ?? "application/octet-stream",
              }),
            ),
          );
        } else if (part.type === "tool-result") {
          const output = yield* Result.await(
            migrateToolOutput({
              output: part.output,
              store: input.store,
              ownedBlobs: input.ownedBlobs,
              createdAt: input.createdAt,
              kind: input.kind,
              recordId: input.recordId,
              path: `${path}.output`,
            }),
          );
          content.push({ ...part, output });
        } else {
          content.push(part);
        }
      }
      messages.push({ ...message, content });
    }
    const stored = z.array(storedMessageV1Schema).safeParse(messages);
    return stored.success
      ? Result.ok(stored.data)
      : Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: input.kind,
            recordId: input.recordId,
            message: "A legacy message cannot be represented by the schema-6 stored-message codec",
          }),
        );
  });
}

type ProjectionSourceFactsValue = {
  readonly [key: string]: MigrationIdentityValue;
};

function replaceSegmentDigest(
  value: ProjectionSourceFactsValue,
  digest: string,
): ProjectionSourceFactsValue {
  return "segmentDigest" in value ? { ...value, segmentDigest: digest } : value;
}

function serializeProjectionSourceFacts(value: ProjectionSourceFactsValue, digest: string): string {
  return JSON.stringify(replaceSegmentDigest(value, digest));
}

function mergeMigratedProjectionMessages(messages: readonly StoredMessageV1[]): StoredMessageV1[] {
  if (messages.length <= 1) return [...messages];
  const role = messages[0]?.role;
  if (role === "assistant" && messages.every((message) => message.role === "assistant")) {
    const content = messages
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n\n"),
      )
      .filter(Boolean)
      .join("\n\n");
    return [{ role: "assistant", content }];
  }
  if (role !== "user" || !messages.every((message) => message.role === "user")) {
    return [...messages];
  }
  const multipart = messages.some((message) => typeof message.content !== "string");
  if (!multipart) {
    return [
      {
        role: "user",
        content: messages
          .map((message) => (typeof message.content === "string" ? message.content : ""))
          .join("\n\n"),
      },
    ];
  }
  const parts: Exclude<Extract<StoredMessageV1, { role: "user" }>["content"], string> = [];
  for (const [index, message] of messages.entries()) {
    if (index > 0) parts.push({ type: "text", text: "\n\n" });
    if (typeof message.content === "string") parts.push({ type: "text", text: message.content });
    else parts.push(...message.content);
  }
  return [{ role: "user", content: parts }];
}

function projectionLookupKey(
  projection: Pick<MigratedProjection, "requestClient" | "surfaceId" | "sessionId" | "messageId">,
): string {
  return [
    projection.requestClient,
    projection.surfaceId,
    projection.sessionId,
    projection.messageId,
  ].join("\0");
}

function rewriteProjectionDigests(
  projections: readonly MigratedProjection[],
): ResultType<MigratedProjection[], LegacyTranscriptMigrationApplyFailed> {
  return Result.gen(function* () {
    const byKey = new Map(
      projections.map((projection) => [projectionLookupKey(projection), projection]),
    );
    const rewritten: MigratedProjection[] = [];
    for (const projection of projections) {
      const sourceFacts = Result.try<unknown, { readonly cause: unknown }>({
        try: () => JSON.parse(projection.sourceFactsJson),
        catch: (cause) => ({ cause }),
      });
      if (sourceFacts.isErr()) {
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "surface-projection",
            recordId: projection.recordId,
            message: "Migrated projection source facts failed current JSON validation",
          }),
        );
      }
      const decodedSourceFacts = z.record(z.string(), z.json()).safeParse(sourceFacts.value);
      if (!decodedSourceFacts.success) {
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "surface-projection",
            recordId: projection.recordId,
            message: "Migrated projection source facts failed current JSON validation",
          }),
        );
      }
      const sourceFactsValue = decodedSourceFacts.data;
      const claimedIds = sourceFactsValue["segmentMessageIds"];
      const segmentMessageIds =
        Array.isArray(claimedIds) && claimedIds.every((entry) => typeof entry === "string")
          ? claimedIds
          : [projection.messageId];
      const segmentMessages: StoredMessageV1[] = [];
      for (const messageId of segmentMessageIds) {
        const source = byKey.get(
          projectionLookupKey({
            requestClient: projection.requestClient,
            surfaceId: projection.surfaceId,
            sessionId: projection.sessionId,
            messageId,
          }),
        );
        if (!source) {
          return Result.err(
            applyFailure({
              stage: "plan-validation",
              recordKind: "surface-projection",
              recordId: projection.recordId,
              message: "Projection segment facts reference a missing schema-5 projection",
            }),
          );
        }
        const decoded = z
          .array(storedMessageV1Schema)
          .safeParse(JSON.parse(source.canonicalMessagesJson));
        if (!decoded.success) {
          return Result.err(
            applyFailure({
              stage: "plan-validation",
              recordKind: "surface-projection",
              recordId: projection.recordId,
              message: "Migrated projection messages failed current validation",
            }),
          );
        }
        segmentMessages.push(...decoded.data);
      }
      const digest = yield* migratedMessageDigest(
        mergeMigratedProjectionMessages(segmentMessages),
        "surface-projection",
        projection.recordId,
      );
      rewritten.push({
        ...projection,
        sourceFactsJson: serializeProjectionSourceFacts(sourceFactsValue, digest),
      });
    }
    return Result.ok(rewritten);
  });
}

async function cleanupUploadedBlobs(
  store: BlobStore,
  ownedBlobs: readonly MigratedOwnedBlob[],
): Promise<ResultType<void, LegacyTranscriptMigrationApplyFailed>> {
  const objectIds = new Set<string>();
  for (const owned of ownedBlobs) {
    if (objectIds.has(owned.blob.objectId)) continue;
    objectIds.add(owned.blob.objectId);
    const deleted = await store.delete(owned.blob);
    const failed = deleted.match({ ok: () => false, err: () => true });
    if (failed) {
      return Result.err(
        applyFailure({
          stage: "upload",
          recordKind: "owned-blob",
          recordId: owned.blob.objectId,
          message: "Failed to clean up a staged transcript blob after migration failure",
        }),
      );
    }
  }
  return Result.ok(undefined);
}

async function stageMigrationArtifacts(input: {
  readonly dbPath: string;
  readonly store: BlobStore;
}): Promise<
  ResultType<TranscriptBlobStorageSchema6MigrationArtifacts, LegacyTranscriptMigrationApplyFailed>
> {
  using database = new Database(input.dbPath, { readonly: true, strict: true });
  const ownedBlobs: MigratedOwnedBlob[] = [];
  const staged = await Result.gen(async function* () {
    for (const raw of database
      .query<unknown, []>("SELECT * FROM core_owned_blobs ORDER BY sha256")
      .all()) {
      const decoded = legacyOwnedBlobRowSchema.safeParse(raw);
      if (!decoded.success) {
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "owned-blob",
            message: "An owned BLOB changed after preflight",
          }),
        );
      }
      const row = decoded.data;
      const blob = yield* Result.await(
        uploadVerifiedDurableBlob(input.store, {
          bytes: row.bytes,
          expectedSha256: row.sha256,
        }).then((result) =>
          result.mapError(() =>
            applyFailure({
              stage: "upload",
              recordKind: "owned-blob",
              recordId: row.sha256,
              message: "A legacy owned BLOB failed destination upload or verification",
            }),
          ),
        ),
      );
      ownedBlobs.push({
        legacySha256: row.sha256,
        blob,
        mediaType: row.media_type,
        filename: row.filename,
        createdAt: row.created_ts,
      });
    }

    const requestTranscripts: MigratedTranscript[] = [];
    const digestByRequestId = new Map<string, string>();
    const legacyTranscriptByRequestId = new Map<string, LegacyTranscriptFact>();
    for (const raw of database
      .query<unknown, []>("SELECT * FROM request_transcripts ORDER BY request_id")
      .all()) {
      const decoded = legacyTranscriptRowSchema.safeParse(raw);
      if (!decoded.success)
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "request-transcript",
            message: "A transcript changed after preflight",
          }),
        );
      const row = decoded.data;
      const serialized = decodeSerialized({
        raw: row.messages_json,
        kind: "request-transcript",
        recordId: row.request_id,
        field: "messages_json",
      });
      if (isDecodeFailure(serialized))
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "request-transcript",
            recordId: row.request_id,
            message: serialized.blocker.reason,
          }),
        );
      const messages = yield* Result.await(
        migrateMessages({
          value: serialized,
          store: input.store,
          ownedBlobs,
          createdAt: row.created_ts,
          kind: "request-transcript",
          recordId: row.request_id,
          field: "messages_json",
        }),
      );
      const digest = yield* migratedMessageDigest(messages, "request-transcript", row.request_id);
      digestByRequestId.set(row.request_id, digest);
      const providerStateValue =
        row.provider_state_json === null
          ? null
          : decodeSerialized({
              raw: row.provider_state_json,
              kind: "request-transcript",
              recordId: row.request_id,
              field: "provider_state_json",
            });
      const providerState =
        providerStateValue === null
          ? null
          : historyProviderStateSchema.safeParse(providerStateValue);
      if (providerState !== null && !providerState.success)
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "request-transcript",
            recordId: row.request_id,
            message: "A transcript provider state changed after preflight",
          }),
        );
      legacyTranscriptByRequestId.set(row.request_id, {
        requestId: row.request_id,
        requestClient: row.request_client,
        sessionId: row.session_id,
        stableNamedRequestClient: row.stable_named_request_client,
        providerState: providerState?.data ?? null,
        hasContextMeta: row.context_meta_json !== null,
        legacyDigest: row.transcript_digest,
        messageCount: messages.length,
      });
      requestTranscripts.push({
        requestId: row.request_id,
        messagesJson: JSON.stringify(messages),
        transcriptDigest: digest,
      });
    }

    const surfaceProjections: MigratedProjection[] = [];
    for (const raw of database
      .query<unknown, []>(
        "SELECT * FROM core_surface_projections ORDER BY request_client, surface_id, session_id, message_id",
      )
      .all()) {
      const decoded = legacyProjectionRowSchema.safeParse(raw);
      if (!decoded.success)
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "surface-projection",
            message: "A projection changed after preflight",
          }),
        );
      const row = decoded.data;
      const recordId = projectionRecordId(row);
      const serialized = decodeSerialized({
        raw: row.canonical_messages_json,
        kind: "surface-projection",
        recordId,
        field: "canonical_messages_json",
      });
      if (isDecodeFailure(serialized))
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "surface-projection",
            recordId,
            message: serialized.blocker.reason,
          }),
        );
      const messages = yield* Result.await(
        migrateMessages({
          value: serialized,
          store: input.store,
          ownedBlobs,
          createdAt: row.created_ts,
          kind: "surface-projection",
          recordId,
          field: "canonical_messages_json",
        }),
      );
      const sourceFacts = decodeSerialized({
        raw: row.source_facts_json,
        kind: "surface-projection",
        recordId,
        field: "source_facts_json",
      });
      if (isDecodeFailure(sourceFacts))
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "surface-projection",
            recordId,
            message: sourceFacts.blocker.reason,
          }),
        );
      surfaceProjections.push({
        recordId,
        requestClient: row.request_client,
        surfaceId: row.surface_id,
        sessionId: row.session_id,
        messageId: row.message_id,
        projectionFormatVersion: row.projection_format_version,
        canonicalMessagesJson: JSON.stringify(messages),
        sourceFactsJson: JSON.stringify(sourceFacts),
      });
    }
    const rewrittenProjections = yield* rewriteProjectionDigests(surfaceProjections);

    const lineageManifests: MigratedLineage[] = [];
    const primaryCandidates: MigratedPrimaryCandidate[] = [];
    for (const raw of database
      .query<unknown, []>("SELECT * FROM core_primary_lineage_manifests ORDER BY request_id")
      .all()) {
      const decoded = legacyLineageRowSchema.safeParse(raw);
      if (!decoded.success)
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "lineage-manifest",
            message: "A lineage manifest changed after preflight",
          }),
        );
      const row = decoded.data;
      const serialized = decodeSerialized({
        raw: row.manifest_json,
        kind: "lineage-manifest",
        recordId: row.request_id,
        field: "manifest_json",
      });
      if (isDecodeFailure(serialized))
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "lineage-manifest",
            recordId: row.request_id,
            message: serialized.blocker.reason,
          }),
        );
      const legacyManifest = legacyLineageManifestSchema.safeParse(serialized);
      if (!legacyManifest.success)
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "lineage-manifest",
            recordId: row.request_id,
            message: "A lineage manifest changed after preflight",
          }),
        );
      const segments: CoreLineageSegmentInputV2[] = [];
      let currentSegmentIndex = 0;
      for (const [segmentIndex, segment] of legacyManifest.data.segments.entries()) {
        if (segment.canonicalStart === legacyManifest.data.currentCanonicalStart)
          currentSegmentIndex = segmentIndex;
        const messages = yield* Result.await(
          migrateMessages({
            value: segment.canonicalMessages,
            store: input.store,
            ownedBlobs,
            createdAt: row.created_ts,
            kind: "lineage-manifest",
            recordId: row.request_id,
            field: `manifest_json.segments[${segmentIndex}].canonicalMessages`,
          }),
        );
        const atoms: CoreLineageAtomV2[] = [];
        for (const atom of segment.atoms) {
          if (atom.kind === "request" || atom.kind === "checkpoint") {
            const digest = digestByRequestId.get(atom.requestId);
            if (!digest)
              return Result.err(
                applyFailure({
                  stage: "plan-validation",
                  recordKind: "lineage-manifest",
                  recordId: row.request_id,
                  message: "A lineage atom references a missing transcript",
                }),
              );
            atoms.push({ ...atom, transcriptDigest: digest });
          } else if (atom.kind === "synthetic") {
            const messageDigest = yield* migratedMessageDigest(
              messages,
              "lineage-manifest",
              row.request_id,
            );
            atoms.push({ ...atom, messageDigest });
          } else atoms.push(atom);
        }
        segments.push({
          atoms,
          canonicalMessages: messages,
          ...(segment.requestSource ? { requestSource: segment.requestSource } : {}),
        });
      }
      const built = buildCoreLineageManifestV2(segments, { currentSegmentIndex });
      const manifest = built.match<CoreLineageManifestV2 | null>({
        ok: (value) => value,
        err: () => null,
      });
      if (!manifest)
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "lineage-manifest",
            recordId: row.request_id,
            message: "The lineage manifest cannot be rebuilt as schema 6",
          }),
        );
      const transcript = legacyTranscriptByRequestId.get(row.request_id);
      const newTranscriptDigest = digestByRequestId.get(row.request_id);
      if (transcript !== undefined && newTranscriptDigest !== undefined) {
        const oldHead = legacyPrimaryHead(legacyManifest.data, transcript);
        if (oldHead !== null && transcript.providerState !== null) {
          const newHead = yield* computeCorePrimaryClaudeTerminalHead({
            manifest,
            requestId: row.request_id,
            transcriptDigest: newTranscriptDigest,
            responseMessageCount: transcript.messageCount,
            providerState: transcript.providerState,
          }).mapError(() =>
            applyFailure({
              stage: "plan-validation",
              recordKind: "lineage-manifest",
              recordId: row.request_id,
              message: "A primary Claude lineage head cannot be rebuilt as schema 6",
            }),
          );
          primaryCandidates.push({ requestId: row.request_id, transcript, oldHead, newHead });
        }
      }
      lineageManifests.push({ requestId: row.request_id, manifestJson: JSON.stringify(manifest) });
    }

    const namedClaudeBindings: MigratedNamedClaudeBinding[] = [];
    for (const raw of database
      .query<unknown, []>(
        "SELECT * FROM core_named_claude_bindings ORDER BY request_client, session_id, provider_id",
      )
      .all()) {
      const decoded = legacyNamedClaudeBindingRowSchema.safeParse(raw);
      if (!decoded.success)
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "named-claude-binding",
            message: "A named Claude binding changed after preflight",
          }),
        );
      const row = decoded.data;
      const digest = digestByRequestId.get(row.terminal_request_id);
      const transcript = legacyTranscriptByRequestId.get(row.terminal_request_id);
      if (digest === undefined || transcript === undefined)
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "named-claude-binding",
            recordId: `${row.request_client}:${row.session_id}:${row.provider_id}`,
            message: "A named Claude binding terminal transcript is unavailable",
          }),
        );
      namedClaudeBindings.push({
        ...row,
        canonical_hash_version: 2,
        canonical_head_hash: digest,
        canonical_message_count: transcript.messageCount,
      });
    }

    const namedClaudeAttempts: MigratedNamedClaudeAttempt[] = [];
    for (const raw of database
      .query<unknown, []>(
        `SELECT * FROM core_named_claude_attempts
         ORDER BY request_client, session_id, provider_id, request_id, attempt_index`,
      )
      .all()) {
      const decoded = legacyNamedClaudeAttemptRowSchema.safeParse(raw);
      if (!decoded.success)
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "named-claude-attempt",
            message: "A named Claude attempt changed after preflight",
          }),
        );
      const row = decoded.data;
      const sourceDigest =
        row.source_terminal_request_id === null
          ? null
          : (digestByRequestId.get(row.source_terminal_request_id) ?? null);
      const terminalDigest =
        row.terminal_request_id === null
          ? null
          : (digestByRequestId.get(row.terminal_request_id) ?? null);
      if (
        (row.source_terminal_request_id !== null && sourceDigest === null) ||
        (row.terminal_request_id !== null && terminalDigest === null)
      )
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "named-claude-attempt",
            recordId: `${row.request_client}:${row.session_id}:${row.provider_id}:${row.request_id}:${row.attempt_index}`,
            message: "A named Claude attempt transcript is unavailable",
          }),
        );
      namedClaudeAttempts.push({
        ...row,
        source_canonical_head_hash: sourceDigest,
        terminal_canonical_head_hash: terminalDigest,
      });
    }

    const primaryClaudeBindings: MigratedPrimaryClaudeBinding[] = [];
    for (const raw of database
      .query<unknown, []>(
        "SELECT * FROM core_primary_claude_bindings ORDER BY request_client, session_id, provider_id",
      )
      .all()) {
      const decoded = legacyPrimaryClaudeBindingRowSchema.safeParse(raw);
      if (!decoded.success)
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "primary-claude-binding",
            message: "A primary Claude binding changed after preflight",
          }),
        );
      const row = decoded.data;
      const candidate = resolvePrimaryCandidate({
        requestId: row.terminal_request_id,
        head: {
          lineageVersion: row.lineage_version,
          atomCount: row.atom_count,
          prefixDigest: row.prefix_digest,
          canonicalMessageCount: row.canonical_message_count,
        },
        requestClient: row.request_client,
        sessionId: row.session_id,
        candidates: primaryCandidates,
      });
      if (candidate === null)
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "primary-claude-binding",
            recordId: `${row.request_client}:${row.session_id}:${row.provider_id}`,
            message: "A primary Claude binding lineage became ambiguous or unavailable",
          }),
        );
      primaryClaudeBindings.push({
        ...row,
        terminal_request_id: candidate.requestId,
        lineage_version: 2,
        atom_count: candidate.newHead.atomCount,
        prefix_digest: candidate.newHead.prefixDigest,
        canonical_message_count: candidate.newHead.canonicalMessageCount,
      });
    }

    const primaryClaudeAttempts: MigratedPrimaryClaudeAttempt[] = [];
    for (const raw of database
      .query<unknown, []>(
        `SELECT * FROM core_primary_claude_attempts
         ORDER BY request_client, session_id, provider_id, request_id, attempt_index`,
      )
      .all()) {
      const decoded = legacyPrimaryClaudeAttemptRowSchema.safeParse(raw);
      if (!decoded.success)
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "primary-claude-attempt",
            message: "A primary Claude attempt changed after preflight",
          }),
        );
      const row = decoded.data;
      const sourceHead = optionalLegacyPrimaryHead({
        lineageVersion: row.source_lineage_version,
        atomCount: row.source_atom_count,
        prefixDigest: row.source_prefix_digest,
        canonicalMessageCount: row.source_canonical_message_count,
      });
      const terminalHead = optionalLegacyPrimaryHead({
        lineageVersion: row.terminal_lineage_version,
        atomCount: row.terminal_atom_count,
        prefixDigest: row.terminal_prefix_digest,
        canonicalMessageCount: row.terminal_canonical_message_count,
      });
      if (isDecodeFailure(sourceHead) || isDecodeFailure(terminalHead))
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "primary-claude-attempt",
            recordId: `${row.request_client}:${row.session_id}:${row.provider_id}:${row.request_id}:${row.attempt_index}`,
            message: "A primary Claude attempt lineage identity changed after preflight",
          }),
        );
      const sourceCandidate =
        sourceHead === null
          ? null
          : resolvePrimaryCandidate({
              requestId: null,
              head: sourceHead,
              requestClient: row.request_client,
              sessionId: row.session_id,
              candidates: primaryCandidates,
            });
      const terminalCandidate =
        terminalHead === null
          ? null
          : resolvePrimaryCandidate({
              requestId: row.terminal_request_id,
              head: terminalHead,
              requestClient: row.request_client,
              sessionId: row.session_id,
              candidates: primaryCandidates,
            });
      if (
        (sourceHead !== null && sourceCandidate === null) ||
        (terminalHead !== null && terminalCandidate === null)
      )
        return Result.err(
          applyFailure({
            stage: "plan-validation",
            recordKind: "primary-claude-attempt",
            recordId: `${row.request_client}:${row.session_id}:${row.provider_id}:${row.request_id}:${row.attempt_index}`,
            message: "A primary Claude attempt lineage became ambiguous or unavailable",
          }),
        );
      primaryClaudeAttempts.push({
        ...row,
        source_lineage_version: sourceCandidate === null ? null : 2,
        source_atom_count: sourceCandidate?.newHead.atomCount ?? null,
        source_prefix_digest: sourceCandidate?.newHead.prefixDigest ?? null,
        source_canonical_message_count: sourceCandidate?.newHead.canonicalMessageCount ?? null,
        terminal_lineage_version: terminalCandidate === null ? null : 2,
        terminal_atom_count: terminalCandidate?.newHead.atomCount ?? null,
        terminal_prefix_digest: terminalCandidate?.newHead.prefixDigest ?? null,
        terminal_canonical_message_count: terminalCandidate?.newHead.canonicalMessageCount ?? null,
      });
    }
    return Result.ok({
      ownedBlobs,
      requestTranscripts,
      surfaceProjections: rewrittenProjections,
      lineageManifests,
      namedClaudeBindings,
      namedClaudeAttempts,
      primaryClaudeBindings,
      primaryClaudeAttempts,
    });
  });
  const stagedOutcome = staged.match<
    | {
        readonly kind: "staged";
        readonly value: TranscriptBlobStorageSchema6MigrationArtifacts;
      }
    | { readonly kind: "failure"; readonly error: LegacyTranscriptMigrationApplyFailed }
  >({
    ok: (value) => ({ kind: "staged", value }),
    err: (error) => ({ kind: "failure", error }),
  });
  if (stagedOutcome.kind === "failure") {
    const cleaned = await cleanupUploadedBlobs(input.store, ownedBlobs);
    return cleaned.match({
      ok: () => Result.err(stagedOutcome.error),
      err: (error) => Result.err(error),
    });
  }
  return Result.ok(stagedOutcome.value);
}

export function applyTranscriptBlobStorageSchema6Migration(
  database: Database,
  artifacts: TranscriptBlobStorageSchema6MigrationArtifacts,
  now: () => number = Date.now,
): ResultType<void, LegacyTranscriptMigrationApplyFailed> {
  const applied = captureSqliteOperation(() => {
    database.run("PRAGMA foreign_keys = OFF");
    database.run("PRAGMA legacy_alter_table = ON");
    database.run("BEGIN IMMEDIATE");
    database.run(
      "ALTER TABLE core_surface_projection_blobs RENAME TO legacy_core_surface_projection_blobs",
    );
    database.run("ALTER TABLE core_owned_blobs RENAME TO legacy_core_owned_blobs");
    database.run(
      "ALTER TABLE core_primary_lineage_manifests RENAME TO legacy_core_primary_lineage_manifests",
    );
    const nativeTables = [
      "core_named_claude_bindings",
      "core_named_claude_attempts",
      "core_primary_claude_bindings",
      "core_primary_claude_attempts",
    ] as const;
    const existingNativeTables = nativeTables.filter(
      (table) =>
        database
          .query<{ name: string }, [string]>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(table) !== null,
    );
    for (const table of existingNativeTables) {
      database.run(`ALTER TABLE ${table} RENAME TO legacy_${table}`);
    }
    database.run(`
        CREATE TABLE core_owned_blobs (owner_id TEXT PRIMARY KEY CHECK (length(owner_id) > 0), blob_ref_json TEXT NOT NULL, media_type TEXT NOT NULL CHECK (length(media_type) > 0), filename TEXT NOT NULL CHECK (length(filename) > 0), byte_length INTEGER NOT NULL CHECK (byte_length >= 0), created_ts INTEGER NOT NULL);
        CREATE TABLE core_surface_projection_blobs (request_client TEXT NOT NULL, surface_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, projection_format_version INTEGER NOT NULL, position INTEGER NOT NULL CHECK (position >= 0), blob_owner_id TEXT NOT NULL REFERENCES core_owned_blobs(owner_id) ON DELETE RESTRICT, PRIMARY KEY (request_client, surface_id, session_id, message_id, projection_format_version, position), FOREIGN KEY (request_client, surface_id, session_id, message_id, projection_format_version) REFERENCES core_surface_projections (request_client, surface_id, session_id, message_id, projection_format_version) ON DELETE CASCADE);
        CREATE TABLE core_primary_lineage_manifests (request_id TEXT PRIMARY KEY REFERENCES request_transcripts(request_id) ON DELETE CASCADE, lineage_version INTEGER NOT NULL CHECK (lineage_version = 2), manifest_json TEXT NOT NULL, created_ts INTEGER NOT NULL);
        CREATE TABLE core_named_claude_bindings (request_client TEXT NOT NULL, session_id TEXT NOT NULL, provider_id TEXT NOT NULL, binding_protocol_version INTEGER NOT NULL CHECK (binding_protocol_version = 1), provider_family TEXT NOT NULL CHECK (provider_family = 'claude-code'), terminal_request_id TEXT NOT NULL REFERENCES request_transcripts(request_id) ON DELETE CASCADE, canonical_hash_version INTEGER NOT NULL CHECK (canonical_hash_version = 2), canonical_head_hash TEXT NOT NULL, canonical_message_count INTEGER NOT NULL CHECK (canonical_message_count >= 0), execution_scope_hash_version INTEGER NOT NULL CHECK (execution_scope_hash_version = 1), execution_scope_hash TEXT NOT NULL, claude_session_id TEXT NOT NULL, native_cwd TEXT NOT NULL, native_last_modified REAL NOT NULL CHECK (native_last_modified >= 0), native_context_tokens INTEGER NOT NULL CHECK (native_context_tokens >= 0), native_context_max_tokens INTEGER NOT NULL CHECK (native_context_max_tokens > 0), last_model_specifier TEXT NOT NULL, last_reasoning TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0), updated_ts INTEGER NOT NULL, PRIMARY KEY (request_client, session_id, provider_id));
        CREATE TABLE core_named_claude_attempts (product TEXT NOT NULL CHECK (product = 'core-named'), request_client TEXT NOT NULL, session_id TEXT NOT NULL, provider_id TEXT NOT NULL, source_terminal_request_id TEXT REFERENCES request_transcripts(request_id) ON DELETE SET NULL, source_canonical_head_hash TEXT, source_canonical_message_count INTEGER CHECK (source_canonical_message_count >= 0), execution_scope_hash_version INTEGER NOT NULL CHECK (execution_scope_hash_version = 1), execution_scope_hash TEXT NOT NULL, request_id TEXT NOT NULL, attempt_index INTEGER NOT NULL CHECK (attempt_index >= 0), candidate_session_id TEXT NOT NULL, source_session_id TEXT, expected_binding_revision INTEGER CHECK (expected_binding_revision > 0), state TEXT NOT NULL CHECK (state IN ('active', 'succeeded', 'failed', 'cancelled', 'uncertain')), terminal_request_id TEXT REFERENCES request_transcripts(request_id) ON DELETE CASCADE, terminal_canonical_head_hash TEXT, terminal_canonical_message_count INTEGER CHECK (terminal_canonical_message_count >= 0), native_cwd TEXT, native_last_modified REAL CHECK (native_last_modified >= 0), native_context_tokens INTEGER CHECK (native_context_tokens >= 0), native_context_max_tokens INTEGER CHECK (native_context_max_tokens > 0), last_model_specifier TEXT, last_reasoning TEXT, created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL, PRIMARY KEY (request_client, session_id, provider_id, request_id, attempt_index));
        CREATE TABLE core_primary_claude_bindings (request_client TEXT NOT NULL CHECK (request_client = 'discord'), session_id TEXT NOT NULL, provider_id TEXT NOT NULL, binding_protocol_version INTEGER NOT NULL CHECK (binding_protocol_version = 1), provider_family TEXT NOT NULL CHECK (provider_family = 'claude-code'), lineage_version INTEGER NOT NULL CHECK (lineage_version = 2), atom_count INTEGER NOT NULL CHECK (atom_count > 0), prefix_digest TEXT NOT NULL, canonical_message_count INTEGER NOT NULL CHECK (canonical_message_count > 0), execution_scope_hash_version INTEGER NOT NULL CHECK (execution_scope_hash_version = 1), execution_scope_hash TEXT NOT NULL, claude_session_id TEXT NOT NULL, native_cwd TEXT NOT NULL, native_last_modified REAL NOT NULL CHECK (native_last_modified >= 0), native_context_tokens INTEGER NOT NULL CHECK (native_context_tokens >= 0), native_context_max_tokens INTEGER NOT NULL CHECK (native_context_max_tokens > 0), last_model_specifier TEXT NOT NULL, last_reasoning TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0), updated_ts INTEGER NOT NULL, terminal_request_id TEXT REFERENCES request_transcripts(request_id) ON DELETE CASCADE, PRIMARY KEY (request_client, session_id, provider_id));
        CREATE TABLE core_primary_claude_attempts (product TEXT NOT NULL CHECK (product = 'core-primary'), request_client TEXT NOT NULL CHECK (request_client = 'discord'), session_id TEXT NOT NULL, provider_id TEXT NOT NULL, source_lineage_version INTEGER CHECK (source_lineage_version = 2), source_atom_count INTEGER CHECK (source_atom_count > 0), source_prefix_digest TEXT, source_canonical_message_count INTEGER CHECK (source_canonical_message_count > 0), execution_scope_hash_version INTEGER NOT NULL CHECK (execution_scope_hash_version = 1), execution_scope_hash TEXT NOT NULL, request_id TEXT NOT NULL, attempt_index INTEGER NOT NULL CHECK (attempt_index >= 0), candidate_session_id TEXT NOT NULL, source_session_id TEXT, expected_binding_revision INTEGER CHECK (expected_binding_revision > 0), state TEXT NOT NULL CHECK (state IN ('active', 'succeeded', 'failed', 'cancelled', 'uncertain')), terminal_request_id TEXT REFERENCES request_transcripts(request_id) ON DELETE CASCADE, terminal_lineage_version INTEGER CHECK (terminal_lineage_version = 2), terminal_atom_count INTEGER CHECK (terminal_atom_count > 0), terminal_prefix_digest TEXT, terminal_canonical_message_count INTEGER CHECK (terminal_canonical_message_count > 0), native_cwd TEXT, native_last_modified REAL CHECK (native_last_modified >= 0), native_context_tokens INTEGER CHECK (native_context_tokens >= 0), native_context_max_tokens INTEGER CHECK (native_context_max_tokens > 0), last_model_specifier TEXT, last_reasoning TEXT, created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL, PRIMARY KEY (request_client, session_id, provider_id, request_id, attempt_index));
      `);
    const ownerBySha = new Map<string, string>();
    for (const blob of artifacts.ownedBlobs) {
      if (blob.legacySha256 !== undefined) {
        ownerBySha.set(blob.legacySha256, blob.blob.objectId);
      }
      database.run("INSERT INTO core_owned_blobs VALUES (?, ?, ?, ?, ?, ?)", [
        blob.blob.objectId,
        JSON.stringify(blob.blob),
        blob.mediaType,
        blob.filename,
        blob.blob.byteLength,
        blob.createdAt,
      ]);
    }
    for (const row of artifacts.requestTranscripts)
      database.run(
        "UPDATE request_transcripts SET messages_json = ?, transcript_digest = ? WHERE request_id = ?",
        [row.messagesJson, row.transcriptDigest, row.requestId],
      );
    for (const row of artifacts.surfaceProjections) {
      database.run(
        "UPDATE core_surface_projections SET canonical_messages_json = ?, source_facts_json = ? WHERE request_client = ? AND surface_id = ? AND session_id = ? AND message_id = ? AND projection_format_version = ?",
        [
          row.canonicalMessagesJson,
          row.sourceFactsJson,
          row.requestClient,
          row.surfaceId,
          row.sessionId,
          row.messageId,
          row.projectionFormatVersion,
        ],
      );
    }
    for (const row of database
      .query<
        {
          request_client: string;
          surface_id: string;
          session_id: string;
          message_id: string;
          projection_format_version: number;
          position: number;
          blob_sha256: string;
        },
        []
      >("SELECT * FROM legacy_core_surface_projection_blobs")
      .all()) {
      const ownerId = ownerBySha.get(row.blob_sha256) ?? "missing-schema-5-owned-blob";
      database.run("INSERT INTO core_surface_projection_blobs VALUES (?, ?, ?, ?, ?, ?, ?)", [
        row.request_client,
        row.surface_id,
        row.session_id,
        row.message_id,
        row.projection_format_version,
        row.position,
        ownerId,
      ]);
    }
    for (const row of artifacts.lineageManifests) {
      const created = database
        .query<{ created_ts: number }, [string]>(
          "SELECT created_ts FROM legacy_core_primary_lineage_manifests WHERE request_id = ?",
        )
        .get(row.requestId);
      database.run("INSERT INTO core_primary_lineage_manifests VALUES (?, 2, ?, ?)", [
        row.requestId,
        row.manifestJson,
        created?.created_ts ?? now(),
      ]);
    }
    for (const row of artifacts.namedClaudeBindings) {
      database.run(
        `INSERT INTO core_named_claude_bindings VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.request_client,
          row.session_id,
          row.provider_id,
          row.binding_protocol_version,
          row.provider_family,
          row.terminal_request_id,
          row.canonical_hash_version,
          row.canonical_head_hash,
          row.canonical_message_count,
          row.execution_scope_hash_version,
          row.execution_scope_hash,
          row.claude_session_id,
          row.native_cwd,
          row.native_last_modified,
          row.native_context_tokens,
          row.native_context_max_tokens,
          row.last_model_specifier,
          row.last_reasoning,
          row.revision,
          row.updated_ts,
        ],
      );
    }
    for (const row of artifacts.namedClaudeAttempts) {
      database.run(
        `INSERT INTO core_named_claude_attempts VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.product,
          row.request_client,
          row.session_id,
          row.provider_id,
          row.source_terminal_request_id,
          row.source_canonical_head_hash,
          row.source_canonical_message_count,
          row.execution_scope_hash_version,
          row.execution_scope_hash,
          row.request_id,
          row.attempt_index,
          row.candidate_session_id,
          row.source_session_id,
          row.expected_binding_revision,
          row.state,
          row.terminal_request_id,
          row.terminal_canonical_head_hash,
          row.terminal_canonical_message_count,
          row.native_cwd,
          row.native_last_modified,
          row.native_context_tokens,
          row.native_context_max_tokens,
          row.last_model_specifier,
          row.last_reasoning,
          row.created_ts,
          row.updated_ts,
        ],
      );
    }
    for (const row of artifacts.primaryClaudeBindings) {
      database.run(
        `INSERT INTO core_primary_claude_bindings VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.request_client,
          row.session_id,
          row.provider_id,
          row.binding_protocol_version,
          row.provider_family,
          row.lineage_version,
          row.atom_count,
          row.prefix_digest,
          row.canonical_message_count,
          row.execution_scope_hash_version,
          row.execution_scope_hash,
          row.claude_session_id,
          row.native_cwd,
          row.native_last_modified,
          row.native_context_tokens,
          row.native_context_max_tokens,
          row.last_model_specifier,
          row.last_reasoning,
          row.revision,
          row.updated_ts,
          row.terminal_request_id,
        ],
      );
    }
    for (const row of artifacts.primaryClaudeAttempts) {
      database.run(
        `INSERT INTO core_primary_claude_attempts VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.product,
          row.request_client,
          row.session_id,
          row.provider_id,
          row.source_lineage_version,
          row.source_atom_count,
          row.source_prefix_digest,
          row.source_canonical_message_count,
          row.execution_scope_hash_version,
          row.execution_scope_hash,
          row.request_id,
          row.attempt_index,
          row.candidate_session_id,
          row.source_session_id,
          row.expected_binding_revision,
          row.state,
          row.terminal_request_id,
          row.terminal_lineage_version,
          row.terminal_atom_count,
          row.terminal_prefix_digest,
          row.terminal_canonical_message_count,
          row.native_cwd,
          row.native_last_modified,
          row.native_context_tokens,
          row.native_context_max_tokens,
          row.last_model_specifier,
          row.last_reasoning,
          row.created_ts,
          row.updated_ts,
        ],
      );
    }
    database.run(
      "UPDATE core_lineage_request_refs SET transcript_digest = (SELECT transcript_digest FROM request_transcripts WHERE request_id = referenced_request_id)",
    );
    database.run(
      "DROP TABLE legacy_core_surface_projection_blobs; DROP TABLE legacy_core_owned_blobs; DROP TABLE legacy_core_primary_lineage_manifests;",
    );
    for (const table of existingNativeTables) database.run(`DROP TABLE legacy_${table}`);
    database.run(
      "CREATE INDEX idx_core_surface_projection_blobs_blob ON core_surface_projection_blobs(blob_owner_id)",
    );
    database.run(
      "CREATE INDEX idx_core_named_claude_attempts_owner ON core_named_claude_attempts(request_client, session_id, provider_id, updated_ts)",
    );
    database.run(
      "CREATE INDEX idx_core_primary_claude_attempts_owner ON core_primary_claude_attempts(request_client, session_id, provider_id, updated_ts)",
    );
    database.run("INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (6, ?)", [
      now(),
    ]);
    const failures = database.query<unknown, []>("PRAGMA foreign_key_check").all();
    if (failures.length > 0) database.run("SELECT no_such_schema6_foreign_key_failure()");
    database.run("COMMIT");
  });
  const successfulRollback: CapturedSqliteOutcome = { kind: "ok" };
  const rollback =
    applied.kind === "failure"
      ? captureSqliteOperation(() => database.run("ROLLBACK"))
      : successfulRollback;
  const restoredForeignKeys = captureSqliteOperation(() =>
    database.run("PRAGMA foreign_keys = ON"),
  );
  const restoredLegacyAlter = captureSqliteOperation(() =>
    database.run("PRAGMA legacy_alter_table = OFF"),
  );
  if (applied.kind === "failure") {
    if (Panic.is(applied.cause)) preserveToolPanic(applied.cause);
    if (rollback.kind === "failure" && Panic.is(rollback.cause)) preserveToolPanic(rollback.cause);
    if (restoredForeignKeys.kind === "failure" && Panic.is(restoredForeignKeys.cause))
      preserveToolPanic(restoredForeignKeys.cause);
    if (restoredLegacyAlter.kind === "failure" && Panic.is(restoredLegacyAlter.cause))
      preserveToolPanic(restoredLegacyAlter.cause);
    const detail = `: ${applied.cause.message}`;
    const cleanupFailed =
      rollback.kind === "failure" ||
      restoredForeignKeys.kind === "failure" ||
      restoredLegacyAlter.kind === "failure";
    return Result.err(
      applyFailure({
        stage: "rewrite",
        message: `Failed to transactionally rewrite the Core transcript database as schema 6${detail}${cleanupFailed ? "; transaction cleanup also failed" : ""}`,
      }),
    );
  }
  if (restoredForeignKeys.kind === "failure" || restoredLegacyAlter.kind === "failure") {
    let cause: Error | undefined;
    if (restoredForeignKeys.kind === "failure") cause = restoredForeignKeys.cause;
    else if (restoredLegacyAlter.kind === "failure") cause = restoredLegacyAlter.cause;
    if (Panic.is(cause)) preserveToolPanic(cause);
    return Result.err(
      applyFailure({
        stage: "rewrite",
        message: "Schema-6 rewrite committed but SQLite connection cleanup failed",
      }),
    );
  }
  return Result.ok(undefined);
}

export async function stageLegacyTranscriptMigration(input: {
  readonly dbPath: string;
  readonly store: BlobStore;
  readonly plan: LegacyTranscriptMigrationPlan;
}): Promise<ResultType<StagedLegacyTranscriptMigration, LegacyTranscriptMigrationApplyFailed>> {
  const current = preflightLegacyTranscriptDb(input.dbPath).match<LegacyTranscriptPreflight | null>(
    { ok: (value) => value, err: () => null },
  );
  if (!current || current.plan.databaseIdentity !== input.plan.databaseIdentity) {
    return Result.err(
      applyFailure({
        stage: "plan-validation",
        message: "The schema-5 transcript database changed after preflight",
      }),
    );
  }
  const artifacts = await stageMigrationArtifacts({ dbPath: input.dbPath, store: input.store });
  const artifactOutcome = artifacts.match<
    | { readonly kind: "staged"; readonly value: TranscriptBlobStorageSchema6MigrationArtifacts }
    | { readonly kind: "failure"; readonly error: LegacyTranscriptMigrationApplyFailed }
  >({
    ok: (value) => ({ kind: "staged", value }),
    err: (error) => ({ kind: "failure", error }),
  });
  if (artifactOutcome.kind === "failure") return Result.err(artifactOutcome.error);
  return Result.ok({
    report: current.report,
    [stagedTranscriptArtifacts]: artifactOutcome.value,
  });
}

export function deleteStagedLegacyTranscriptUploads(input: {
  readonly stage: StagedLegacyTranscriptMigration;
  readonly store: BlobStore;
}): Promise<ResultType<void, LegacyTranscriptMigrationApplyFailed>> {
  return cleanupUploadedBlobs(input.store, input.stage[stagedTranscriptArtifacts].ownedBlobs);
}

export function commitLegacyTranscriptMigration(input: {
  readonly dbPath: string;
  readonly stage: StagedLegacyTranscriptMigration;
}): ResultType<LegacyTranscriptMigrationReport, LegacyTranscriptMigrationApplyFailed> {
  const opened = Result.try<Database, { readonly cause: Error }>({
    try: () => new Database(input.dbPath, { strict: true }),
    catch: captureError,
  }).match<
    | { readonly kind: "opened"; readonly database: Database }
    | { readonly kind: "failure"; readonly cause: Error }
  >({
    ok: (database) => ({ kind: "opened", database }),
    err: ({ cause }) => ({ kind: "failure", cause }),
  });
  if (opened.kind === "failure") {
    if (Panic.is(opened.cause)) preserveToolPanic(opened.cause);
    return Result.err(
      applyFailure({
        stage: "rewrite",
        message: "Could not open the Core transcript database for rewrite",
      }),
    );
  }
  const database = opened.database;
  const applied = applyTranscriptBlobStorageSchema6Migration(
    database,
    input.stage[stagedTranscriptArtifacts],
  );
  const closed = captureSqliteOperation(() => database.close(false));
  if (closed.kind === "failure" && Panic.is(closed.cause)) preserveToolPanic(closed.cause);
  const appliedOutcome = applied.match<
    | { readonly kind: "applied" }
    | { readonly kind: "failure"; readonly error: LegacyTranscriptMigrationApplyFailed }
  >({
    ok: () => ({ kind: "applied" }),
    err: (error) => ({ kind: "failure", error }),
  });
  if (appliedOutcome.kind === "failure") {
    return closed.kind === "failure"
      ? Result.err(
          applyFailure({
            stage: "rewrite",
            message: `${appliedOutcome.error.message}; database close also failed`,
          }),
        )
      : Result.err(appliedOutcome.error);
  }
  if (closed.kind === "failure")
    return Result.err(
      applyFailure({
        stage: "rewrite",
        message: "The migrated Core transcript database could not be closed cleanly",
      }),
    );
  return Result.ok(input.stage.report);
}

export async function applyLegacyTranscriptMigration(input: {
  readonly dbPath: string;
  readonly store: BlobStore;
  readonly plan: LegacyTranscriptMigrationPlan;
}): Promise<ResultType<LegacyTranscriptMigrationReport, LegacyTranscriptMigrationApplyFailed>> {
  const staged = await stageLegacyTranscriptMigration(input);
  const stagedOutcome = staged.match<
    | { readonly kind: "staged"; readonly value: StagedLegacyTranscriptMigration }
    | { readonly kind: "failed"; readonly error: LegacyTranscriptMigrationApplyFailed }
  >({
    ok: (value) => ({ kind: "staged", value }),
    err: (error) => ({ kind: "failed", error }),
  });
  if (stagedOutcome.kind === "failed") return Result.err(stagedOutcome.error);
  const committed = commitLegacyTranscriptMigration({
    dbPath: input.dbPath,
    stage: stagedOutcome.value,
  });
  const outcome = committed.match<
    | { readonly kind: "committed"; readonly report: LegacyTranscriptMigrationReport }
    | { readonly kind: "failed"; readonly error: LegacyTranscriptMigrationApplyFailed }
  >({
    ok: (report) => ({ kind: "committed", report }),
    err: (error) => ({ kind: "failed", error }),
  });
  if (outcome.kind === "committed") return Result.ok(outcome.report);
  const cleaned = await deleteStagedLegacyTranscriptUploads({
    stage: stagedOutcome.value,
    store: input.store,
  });
  return cleaned.match({
    ok: () => Result.err(outcome.error),
    err: (cleanupError) =>
      Result.err(
        applyFailure({
          stage: outcome.error.stage,
          message: `${outcome.error.message}; ${cleanupError.message}`,
        }),
      ),
  });
}
