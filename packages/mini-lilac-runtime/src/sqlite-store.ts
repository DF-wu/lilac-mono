import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import { hashCanonicalMessagesV1 } from "@stanley2058/lilac-agent";
import {
  CorruptPersistedFields,
  createLogger,
  MalformedSerialization,
  runBunSqliteTransaction,
  UnsupportedVersion,
  type DecodedPersistedValue,
  type PersistedDataError,
} from "@stanley2058/lilac-utils";
import type {
  MiniLilacTodo,
  MiniLilacTodoState,
  MiniLilacReasoning,
  MiniLilacCompactResult,
  MiniLilacCompactionEvent,
  MiniLilacHistoryFilesystemResult,
  MiniLilacRedoResult,
  MiniLilacSessionSnapshot,
  MiniLilacUIMessage,
  MiniLilacUndoResult,
  MiniLilacUpdateSessionBindingsRequest,
  MiniLilacUserUIMessage,
} from "@stanley2058/mini-lilac-client";
import {
  miniLilacControlResultSchema,
  miniLilacCompactionEventSchema,
  miniLilacOutputRollbackSchema,
  miniLilacProviderMetadataSchema,
  miniLilacRedoResultSchema,
  miniLilacSessionSnapshotSchema,
  miniLilacSessionStatusSchema,
  miniLilacSteeringCommittedChunkSchema,
  miniLilacSteeringChunkSchema,
  miniLilacSubagentStatusSchema,
  miniLilacTodoChunkSchema,
  miniLilacTranscriptResetSchema,
  miniLilacUIMessageMetadataSchema,
  miniLilacUndoResultSchema,
} from "@stanley2058/mini-lilac-client";
import type { ModelMessage } from "ai";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import superjson from "superjson";
import { z } from "zod";

import {
  decodeMiniLilacMigrationRunRow,
  decodeMiniLilacStructuralHistoryRow,
  decodeMiniLilacStructuralHistoryRows,
  type MiniLilacMigrationRunRowProjection,
  type MiniLilacStructuralHistoryRecordKind,
  type MiniLilacStructuralHistoryValueFor,
} from "./sqlite-history-persistence-codec";
import {
  decodeMiniLilacDatabaseVersion,
  decodeMiniLilacMigrationModelPrefix,
  decodeMiniLilacMigrationTranscriptRows,
  decodeMiniLilacMigrationUiPrefix,
  decodeMiniLilacMigrationUiTranscript,
  decodeMiniLilacMigrationUserUiMessage,
  decodeMiniLilacModelTranscript as decodePersistedMiniLilacModelTranscript,
  decodeMiniLilacSteeringCommandRequest,
  decodeMiniLilacSuperJsonPayload,
  decodeMiniLilacTranscriptChain,
  decodeMiniLilacUiTranscript as decodePersistedMiniLilacUiTranscript,
} from "./sqlite-persistence-codec";
import {
  MiniLilacHistoryRecordMissing,
  MiniLilacSchemaMigrationFailure,
  MiniLilacSchemaInitializationCombinedFailure,
  MiniLilacSqliteDriverFailure,
  classifyMiniLilacSqliteDriverFailure,
} from "./sqlite-persistence-errors";
import {
  decodeMiniLilacTodos as decodePersistedMiniLilacTodos,
  readMiniLilacTodos,
} from "./sqlite-todo-persistence-codec";
import {
  adaptPersistedModelMessagesToSdk,
  adaptPersistedUiMessagesToSdk,
} from "./sqlite-transcript-representation-adapter";

export { MiniLilacSqliteDriverFailure } from "./sqlite-persistence-errors";

const sessionStatusSchema = miniLilacSessionStatusSchema;
const runStatusSchema = z.enum(["active", "completed", "cancelled", "error"]);
const reasoningSchema = z.enum([
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
export const MINI_LILAC_DATABASE_SCHEMA_VERSION = 8;
export const MINI_MAIN_CLAUDE_ATTEMPT_RETENTION_LIMIT = 100;
export const MINI_NAMED_CLAUDE_ATTEMPT_RETENTION_LIMIT = 100;
const logger = createLogger({ module: "mini-lilac-runtime:sqlite-store" });

function decodeMiniLilacModelTranscript(
  input: Parameters<typeof decodePersistedMiniLilacModelTranscript>[0],
) {
  const decoded = decodePersistedMiniLilacModelTranscript(input);
  let $decodedResultValue3588!: import("better-result").InferOk<NonNullable<typeof decoded>>;
  let $decodedResultError3588!: import("better-result").InferErr<NonNullable<typeof decoded>>;
  const $decodedResultOk3588 = Result.match<
    import("better-result").InferOk<NonNullable<typeof decoded>>,
    import("better-result").InferErr<NonNullable<typeof decoded>>,
    boolean
  >(decoded, {
    ok: (value) => {
      $decodedResultValue3588 = value;
      return true;
    },
    err: (error) => {
      $decodedResultError3588 = error;
      return false;
    },
  });
  if (($decodedResultOk3588 ? "ok" : "error") === "error")
    return Result.err($decodedResultError3588);
  return Result.ok({
    value: adaptPersistedModelMessagesToSdk($decodedResultValue3588.value),
    provenance: $decodedResultValue3588.provenance,
  });
}

function decodeMiniLilacUiTranscript(
  input: Parameters<typeof decodePersistedMiniLilacUiTranscript>[0],
) {
  const decoded = decodePersistedMiniLilacUiTranscript(input);
  let $decodedResultValue3971!: import("better-result").InferOk<NonNullable<typeof decoded>>;
  let $decodedResultError3971!: import("better-result").InferErr<NonNullable<typeof decoded>>;
  const $decodedResultOk3971 = Result.match<
    import("better-result").InferOk<NonNullable<typeof decoded>>,
    import("better-result").InferErr<NonNullable<typeof decoded>>,
    boolean
  >(decoded, {
    ok: (value) => {
      $decodedResultValue3971 = value;
      return true;
    },
    err: (error) => {
      $decodedResultError3971 = error;
      return false;
    },
  });
  if (($decodedResultOk3971 ? "ok" : "error") === "error")
    return Result.err($decodedResultError3971);
  return Result.ok({
    value: adaptPersistedUiMessagesToSdk($decodedResultValue3971.value),
    provenance: $decodedResultValue3971.provenance,
  });
}

function decodeMiniLilacTodos(input: Parameters<typeof decodePersistedMiniLilacTodos>[0]) {
  return decodePersistedMiniLilacTodos(input);
}

export class MiniLilacDatabaseVersionError extends Error {
  constructor(
    readonly actualVersion: number,
    readonly expectedVersion = MINI_LILAC_DATABASE_SCHEMA_VERSION,
  ) {
    super(
      `Unsupported mini-lilac database version ${actualVersion}; create a fresh database for schema version ${expectedVersion}`,
    );
    this.name = "MiniLilacDatabaseVersionError";
  }
}

export type MiniLilacPersistenceError =
  | PersistedDataError
  | MiniLilacSqliteDriverFailure
  | MiniLilacHistoryRecordMissing;
export class MiniLilacStoreOperationRejected extends TaggedError(
  "MiniLilacStoreOperationRejected",
)<{
  readonly operation: string;
  readonly message: string;
}> {}
export type MiniLilacStoreOperationError =
  | MiniLilacPersistenceError
  | MiniLilacStoreOperationRejected;

function rejectMiniLilacStoreOperation(
  operation: string,
  message: string,
): MiniLilacStoreOperationRejected {
  return new MiniLilacStoreOperationRejected({ operation, message });
}
export type MiniLilacPersistenceDiagnostic = {
  readonly table: string;
  readonly field: string;
  readonly version: number;
  readonly issueCode: string;
  readonly recordId: string;
  readonly message: string;
};
export type MiniLilacCleanupDefectReport = {
  readonly operation:
    | "initializeSchema.restorePragmas"
    | "constructor.closeAfterInitializationFailure"
    | "readHistoryRecovery.close";
  readonly cleanupFailure: unknown;
};
export type MiniLilacSqliteStoreOptions = {
  readonly onPersistenceDiagnostic?: (diagnostic: MiniLilacPersistenceDiagnostic) => void;
  readonly onCleanupDefect?: (report: MiniLilacCleanupDefectReport) => void;
};
type MiniLilacSchemaInitializationError =
  | MiniLilacDatabaseVersionError
  | MiniLilacPersistenceError
  | MiniLilacSchemaMigrationFailure
  | MiniLilacSchemaInitializationCombinedFailure;

type MiniLilacCleanupOutcome =
  | { readonly status: "ok" }
  | { readonly status: "expected-error"; readonly error: MiniLilacSqliteDriverFailure }
  | {
      readonly status: "defect";
      readonly report: (
        reporter: (report: MiniLilacCleanupDefectReport) => void,
        operation: MiniLilacCleanupDefectReport["operation"],
      ) => void;
      readonly rethrow: () => never;
    };
type MiniLilacCaughtDefect =
  | { readonly kind: "panic"; readonly cause: Panic }
  | { readonly kind: "error"; readonly cause: Error }
  | { readonly kind: "hostile"; readonly cause: unknown };

function captureMiniLilacCleanup(
  cleanup: () => ResultType<void, MiniLilacSqliteDriverFailure>,
): MiniLilacCleanupOutcome {
  try {
    const result = cleanup();
    return result.match<MiniLilacCleanupOutcome>({
      ok: () => ({ status: "ok" }),
      err: (error) => ({ status: "expected-error", error }),
    });
  } catch (cause) {
    return {
      status: "defect",
      report: (reporter, operation) =>
        reportMiniLilacCleanupFailure(reporter, { operation, cleanupFailure: cause }),
      rethrow: () => {
        throw cause;
      },
    };
  }
}

function reportMiniLilacCleanupFailure(
  reporter: (report: MiniLilacCleanupDefectReport) => void,
  report: MiniLilacCleanupDefectReport,
): void {
  try {
    reporter(report);
  } catch {
    try {
      logger.error("Mini Lilac cleanup defect reporter failed", { operation: report.operation });
    } catch {
      // A reporter failure must never replace the defect whose cleanup it was reporting.
    }
  }
}

function throwPrimaryAfterCleanup(
  primary: MiniLilacCaughtDefect,
  operation: MiniLilacCleanupDefectReport["operation"],
  cleanup: MiniLilacCleanupOutcome,
  reporter: (report: MiniLilacCleanupDefectReport) => void,
): never {
  switch (cleanup.status) {
    case "ok":
      break;
    case "expected-error":
      reportMiniLilacCleanupFailure(reporter, { operation, cleanupFailure: cleanup.error });
      break;
    case "defect":
      cleanup.report(reporter, operation);
      break;
  }
  throw primary.cause;
}

function defaultMiniLilacCleanupDefectReporter(report: MiniLilacCleanupDefectReport): void {
  logger.error("Mini Lilac cleanup failed while preserving a prior defect", {
    operation: report.operation,
  });
}

function isExpectedSchemaInitializationFailure(cause: Error): boolean {
  if (Panic.is(cause)) return false;
  if (
    cause instanceof MiniLilacDatabaseVersionError ||
    cause instanceof CorruptPersistedFields ||
    cause instanceof MalformedSerialization ||
    cause instanceof UnsupportedVersion ||
    cause instanceof MiniLilacSchemaMigrationFailure ||
    cause instanceof MiniLilacSqliteDriverFailure ||
    cause instanceof MiniLilacSchemaInitializationCombinedFailure
  ) {
    return true;
  }
  return classifyMiniLilacSqliteDriverFailure("constructor.initializeSchema", cause) !== undefined;
}

const sessionRowSchema = z.object({
  id: z.string(),
  active_run_id: z.string().nullable(),
  workspace_id: z.string(),
  cwd: z.string(),
  model: z.string(),
  profile: z.string(),
  reasoning: reasoningSchema,
  title: z.string(),
  input_tokens: z.number().int().nonnegative().nullable(),
  input_tokens_estimated: z.number().int().min(0).max(1),
  context_window: z.number().int().positive().nullable(),
  status: sessionStatusSchema,
  queued_steering_count: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});

const runRowSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  parent_run_id: z.string().nullable(),
  profile: z.string(),
  depth: z.number().int().nonnegative(),
  status: runStatusSchema,
  error: z.string().nullable(),
  terminal_result_json: z.string().nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
});

const transcriptNodeRowSchema = z.object({
  id: z.number().int().positive(),
  parent_id: z.number().int().positive().nullable(),
  depth: z.number().int().positive(),
  value_json: z.string(),
  hash: z.string(),
});
const transcriptHeadRowSchema = z.object({
  model_head_id: z.number().int().positive().nullable(),
  ui_head_id: z.number().int().positive().nullable(),
});
const legacyPositionedJsonRowSchema = z.object({
  session_id: z.string(),
  position: z.number().int().nonnegative(),
  value_json: z.string(),
});
const legacyCheckpointRowSchema = z.object({
  session_id: z.string(),
  ui_position: z.number().int().nonnegative(),
  user_message_json: z.string(),
  model_prefix_json: z.string(),
  ui_prefix_json: z.string(),
  root_run_id: z.string(),
  replay_after_seq: z.number().int().nonnegative(),
});
const commandRowSchema = z.object({
  kind: z.string(),
  run_id: z.string().nullable(),
  request_fingerprint: z.string(),
  request_json: z.string(),
  side_effect_started: z.number().int().min(0).max(1),
  result_json: z.string().nullable(),
});

const historyWorkspaceStatusSchema = z.enum(["captured", "unavailable", "capture-deferred"]);
const historyWorkspaceUnavailableReasonSchema = z.enum([
  "git-unavailable",
  "capture-failed",
  "legacy-migration",
  "non-git-workspace",
  "platform-unsupported",
]);
const historyStateOriginSchema = z.enum([
  "root",
  "turn-boundary",
  "workspace-observation",
  "compaction",
  "migration",
]);
const historyTransitionKindSchema = z.enum(["user-message", "workspace-observation", "compaction"]);
const historyDeliverySchema = z.enum(["prompt", "steer"]);
const historyOperationActionSchema = z.enum(["undo", "redo"]);
const historyOperationPhaseSchema = z.enum(["prepared", "restoring", "verified"]);
const historyFilesystemModeSchema = z.enum(["restore", "skip"]);
export const historyProviderFamilySchema = z.enum(["claude-code", "ai-sdk"]);
export const historyProviderStateSchema = z.strictObject({
  lastFamily: historyProviderFamilySchema,
  containsCrossFamilyTurns: z.boolean(),
});
const miniMainClaudeAttemptStateSchema = z.enum([
  "active",
  "succeeded",
  "failed",
  "cancelled",
  "uncertain",
]);
const historySkipReasonSchema = z.enum([
  "git-unavailable",
  "non-git-workspace",
  "snapshot-unavailable",
  "platform-unsupported",
]);
const workspaceHistoryOwnerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("history-operation"), operationId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("pending-run-finalization"), runId: z.string().min(1) }),
]);
const workspaceSnapshotAvailabilityUpdateSchema = z.discriminatedUnion("availability", [
  z.strictObject({
    snapshotId: z.string().min(1),
    availability: z.literal("available"),
    detail: z.null(),
  }),
  z.strictObject({
    snapshotId: z.string().min(1),
    availability: z.enum(["missing", "corrupt"]),
    detail: z.string().min(1),
  }),
]);
const miniMainClaudeBindingRowSchema = z.object({
  session_id: z.string().min(1),
  history_state_id: z.string().min(1),
  provider_id: z.string().min(1),
  binding_protocol_version: z.literal(1),
  provider_family: z.literal("claude-code"),
  request_client: z.string().min(1),
  canonical_message_count: z.number().int().nonnegative(),
  execution_scope_hash_version: z.literal(1),
  execution_scope_hash: z.string().min(1),
  claude_session_id: z.string().uuid(),
  native_cwd: z.string().min(1),
  native_last_modified: z.number().nonnegative(),
  native_context_tokens: z.number().int().nonnegative(),
  native_context_max_tokens: z.number().int().positive(),
  last_model_specifier: z.string().min(1),
  last_reasoning: z.string().min(1),
  revision: z.number().int().positive(),
  updated_at: z.string(),
});
const miniMainClaudeAttemptRowSchema = z.object({
  id: z.number().int().positive(),
  product: z.literal("mini"),
  session_id: z.string().min(1),
  source_history_state_id: z.string().min(1),
  source_canonical_message_count: z.number().int().nonnegative(),
  provider_id: z.string().min(1),
  request_client: z.string().min(1),
  execution_scope_hash_version: z.literal(1),
  execution_scope_hash: z.string().min(1),
  request_id: z.string().min(1),
  attempt_index: z.number().int().nonnegative(),
  candidate_session_id: z.string().uuid(),
  source_session_id: z.string().uuid().nullable(),
  expected_binding_revision: z.number().int().positive().nullable(),
  state: miniMainClaudeAttemptStateSchema,
  created_at: z.string(),
  updated_at: z.string(),
});
const migrationSessionRowSchema = z.object({
  id: z.string(),
  active_run_id: z.string().nullable(),
  cwd: z.string(),
  model: z.string(),
  profile: z.string(),
  reasoning: z.string(),
  title: z.string(),
  input_tokens: z.number().int().nonnegative().nullable(),
  input_tokens_estimated: z.number().int().min(0).max(1),
  context_window: z.number().int().positive().nullable(),
  status: sessionStatusSchema,
  queued_steering_count: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});
const migrationCheckpointRowSchema = z.object({
  session_id: z.string(),
  ui_position: z.number().int().nonnegative(),
  user_message_json: z.string(),
  model_head_id: z.number().int().positive().nullable(),
  ui_head_id: z.number().int().positive().nullable(),
  root_run_id: z.string(),
  replay_after_seq: z.number().int().nonnegative(),
});
const migrationRunRowSchema = z.object({
  id: z.string(),
  status: runStatusSchema,
  parent_run_id: z.string().nullable(),
});
const migrationHistorySessionRowSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  active_run_id: z.string().nullable(),
  status: sessionStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
});
const idRowSchema = z.object({ id: z.string() });
const countRowSchema = z.object({ count: z.number().int().nonnegative() });
const positionRowSchema = z.object({ position: z.number().int().nonnegative() });
const depthRowSchema = z.object({ depth: z.number().int().positive() });
const rootPromptSourceRowSchema = z.object({ from_state_id: z.string().min(1) });
const historyOperationOwnerRowSchema = z.object({ id: z.string(), session_id: z.string() });
const pendingFinalizationOwnerRowSchema = z.object({
  run_id: z.string(),
  session_id: z.string(),
});
const claudeAttemptOwnerRowSchema = z.object({
  session_id: z.string(),
  provider_id: z.string(),
});
const rootRunParentRowSchema = z.object({ parent_run_id: z.null() });
const interruptedClaudeAttemptRowSchema = z.object({
  product: z.enum(["main", "named"]),
  request_id: z.string(),
  session_id: z.string(),
  provider_id: z.string(),
  request_client: z.string(),
  source_history_state_id: z.string(),
  expected_binding_revision: z.number().int().positive().nullable(),
  model: z.string(),
  reasoning: z.string(),
});

const miniLilacStoreRowCodecRegistry = {
  session: {
    schema: sessionRowSchema,
    versions: [8],
    table: "sessions",
  },
  run: {
    schema: runRowSchema,
    versions: [8],
    table: "runs",
  },
  "transcript-node": {
    schema: transcriptNodeRowSchema,
    versions: [3, 4, 5, 6, 7, 8],
    table: "transcript_nodes",
  },
  "transcript-node-id": {
    schema: transcriptNodeRowSchema.pick({ id: true }),
    versions: [3, 4, 5, 6, 7, 8],
    table: "transcript_nodes",
  },
  "transcript-head": {
    schema: transcriptHeadRowSchema,
    versions: [3, 4, 5, 6, 7, 8],
    table: "session_transcript_heads",
  },
  "legacy-positioned-json": {
    schema: legacyPositionedJsonRowSchema,
    versions: [2],
    table: "model_transcript",
  },
  "legacy-checkpoint": {
    schema: legacyCheckpointRowSchema,
    versions: [2],
    table: "user_checkpoints",
  },
  command: {
    schema: commandRowSchema,
    versions: [5, 6, 7, 8],
    table: "commands",
  },
  "claude-binding": {
    schema: miniMainClaudeBindingRowSchema,
    versions: [7, 8],
    table: "mini_main_claude_bindings",
  },
  "claude-attempt": {
    schema: miniMainClaudeAttemptRowSchema,
    versions: [7, 8],
    table: "mini_main_claude_attempts",
  },
  "migration-session": {
    schema: migrationSessionRowSchema,
    versions: [4],
    table: "sessions",
  },
  "migration-history-session": {
    schema: migrationHistorySessionRowSchema,
    versions: [4],
    table: "sessions",
  },
  "migration-checkpoint": {
    schema: migrationCheckpointRowSchema,
    versions: [4],
    table: "user_checkpoints",
  },
  "migration-run": {
    schema: migrationRunRowSchema,
    versions: [4],
    table: "runs",
  },
  id: {
    schema: idRowSchema,
    versions: [2, 3, 4, 5, 6, 7, 8],
    table: "sqlite-query",
  },
  count: {
    schema: countRowSchema,
    versions: [4, 5, 6, 7, 8],
    table: "sqlite-query",
  },
  position: {
    schema: positionRowSchema,
    versions: [5, 6, 7, 8],
    table: "history_redo_stack",
  },
  depth: {
    schema: depthRowSchema,
    versions: [5, 6, 7, 8],
    table: "transcript_nodes",
  },
  "root-prompt-source": {
    schema: rootPromptSourceRowSchema,
    versions: [5, 6, 7, 8],
    table: "history_transitions",
  },
  "history-operation-owner": {
    schema: historyOperationOwnerRowSchema,
    versions: [5, 6, 7, 8],
    table: "history_operations",
  },
  "pending-finalization-owner": {
    schema: pendingFinalizationOwnerRowSchema,
    versions: [5, 6, 7, 8],
    table: "pending_run_finalizations",
  },
  "claude-attempt-owner": {
    schema: claudeAttemptOwnerRowSchema,
    versions: [7, 8],
    table: "mini_claude_attempts",
  },
  "root-run-parent": {
    schema: rootRunParentRowSchema,
    versions: [5, 6, 7, 8],
    table: "runs",
  },
  "interrupted-claude-attempt": {
    schema: interruptedClaudeAttemptRowSchema,
    versions: [7, 8],
    table: "mini_claude_attempts",
  },
} as const;

type MiniLilacStoreRowKind = keyof typeof miniLilacStoreRowCodecRegistry;
type MiniLilacStoreRowValueByKind = {
  [K in MiniLilacStoreRowKind]: z.output<(typeof miniLilacStoreRowCodecRegistry)[K]["schema"]>;
};

export function decodeMiniLilacStoreRow<K extends MiniLilacStoreRowKind>(input: {
  readonly kind: K;
  readonly row: unknown;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<MiniLilacStoreRowValueByKind[K] | null>, PersistedDataError> {
  const codec = miniLilacStoreRowCodecRegistry[input.kind];
  if (!codec.versions.some((version) => version === input.schemaVersion)) {
    return Result.err(
      new UnsupportedVersion({
        table: codec.table,
        field: "row",
        version: input.schemaVersion,
        issueCode: "unsupported-version",
        recordId: input.recordId,
        message: `Unsupported Mini Lilac ${input.kind} row version`,
      }),
    );
  }
  if (input.row === null || input.row === undefined) {
    return Result.ok({ value: null, provenance: "missing-defaulted" });
  }
  const decoded = codec.schema.safeParse(input.row);
  if (!decoded.success) {
    return Result.err(
      new CorruptPersistedFields({
        table: codec.table,
        field: "row",
        version: input.schemaVersion,
        issueCode: "invalid-row-field",
        recordId: input.recordId,
        message: `Stored Mini Lilac ${input.kind} row is invalid`,
      }),
    );
  }
  // The registry key selects this schema; TypeScript cannot retain that
  // correlation through indexed access to the heterogeneous schema map.
  const value = decoded.data as MiniLilacStoreRowValueByKind[K];
  return Result.ok({
    value,
    provenance: input.schemaVersion === MINI_LILAC_DATABASE_SCHEMA_VERSION ? "current" : "migrated",
  });
}

export function decodeMiniLilacStoreRows<K extends MiniLilacStoreRowKind>(input: {
  readonly kind: K;
  readonly rows: readonly unknown[];
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<
  DecodedPersistedValue<readonly MiniLilacStoreRowValueByKind[K][]>,
  PersistedDataError
> {
  const values: MiniLilacStoreRowValueByKind[K][] = [];
  for (const [index, row] of input.rows.entries()) {
    const decoded = decodeMiniLilacStoreRow({
      kind: input.kind,
      row,
      schemaVersion: input.schemaVersion,
      recordId: `${input.recordId}:${index}`,
    });
    let $decodedResultValue22079!: import("better-result").InferOk<NonNullable<typeof decoded>>;
    let $decodedResultError22079!: import("better-result").InferErr<NonNullable<typeof decoded>>;
    const $decodedResultOk22079 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decoded>>,
      import("better-result").InferErr<NonNullable<typeof decoded>>,
      boolean
    >(decoded, {
      ok: (value) => {
        $decodedResultValue22079 = value;
        return true;
      },
      err: (error) => {
        $decodedResultError22079 = error;
        return false;
      },
    });
    if (($decodedResultOk22079 ? "ok" : "error") === "error")
      return Result.err($decodedResultError22079);
    if ($decodedResultValue22079.value === null) {
      return Result.err(
        new CorruptPersistedFields({
          table: miniLilacStoreRowCodecRegistry[input.kind].table,
          field: "row",
          version: input.schemaVersion,
          issueCode: "missing-required-field",
          recordId: `${input.recordId}:${index}`,
          message: `Mini Lilac ${input.kind} row is missing`,
        }),
      );
    }
    values.push($decodedResultValue22079.value);
  }
  return Result.ok({
    value: values,
    provenance: input.schemaVersion === MINI_LILAC_DATABASE_SCHEMA_VERSION ? "current" : "migrated",
  });
}

function decodeRequiredMiniLilacStoreRow<K extends MiniLilacStoreRowKind>(input: {
  readonly kind: K;
  readonly row: unknown;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<
  MiniLilacStoreRowValueByKind[K],
  PersistedDataError | MiniLilacHistoryRecordMissing
> {
  const decoded = decodeMiniLilacStoreRow(input);
  let $decodedResultValue23234!: import("better-result").InferOk<NonNullable<typeof decoded>>;
  let $decodedResultError23234!: import("better-result").InferErr<NonNullable<typeof decoded>>;
  const $decodedResultOk23234 = Result.match<
    import("better-result").InferOk<NonNullable<typeof decoded>>,
    import("better-result").InferErr<NonNullable<typeof decoded>>,
    boolean
  >(decoded, {
    ok: (value) => {
      $decodedResultValue23234 = value;
      return true;
    },
    err: (error) => {
      $decodedResultError23234 = error;
      return false;
    },
  });
  if (($decodedResultOk23234 ? "ok" : "error") === "error")
    return Result.err($decodedResultError23234);
  if ($decodedResultValue23234.value !== null) return Result.ok($decodedResultValue23234.value);
  return Result.err(
    new MiniLilacHistoryRecordMissing({
      recordKind: input.kind,
      recordId: input.recordId.slice(0, 128),
      message: `Mini Lilac ${input.kind} record was not found`,
    }),
  );
}

export const storedHistoryCommandErrorSchema = z.strictObject({
  type: z.literal("history-command-error"),
  code: z.literal("history-recovery-abandoned"),
  commandId: z.string().min(1),
  message: z.string().min(1),
});
export const storedUndoHistoryResultSchema = miniLilacUndoResultSchema;
export const storedRedoHistoryResultSchema = miniLilacRedoResultSchema;
export const storedHistoryNavigationResultSchema = z.union([
  storedUndoHistoryResultSchema,
  storedRedoHistoryResultSchema,
]);

export function decodeStoredHistoryNavigationResult(
  value: unknown,
): ResultType<StoredHistoryNavigationResult, MiniLilacStoreOperationRejected> {
  const decoded = storedHistoryNavigationResultSchema.safeParse(value);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new MiniLilacStoreOperationRejected({
      operation: "decodeStoredHistoryNavigationResult",
      message: "Stored history navigation result is invalid",
    }),
  );
}
const providerMetadataFields = {
  providerMetadata: miniLilacProviderMetadataSchema.optional(),
};

const standardChunkSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("start"),
    messageId: z.string().optional(),
    messageMetadata: miniLilacUIMessageMetadataSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("finish"),
    finishReason: z
      .enum(["stop", "length", "content-filter", "tool-calls", "error", "other"])
      .optional(),
    messageMetadata: miniLilacUIMessageMetadataSchema.optional(),
  }),
  z.strictObject({ type: z.literal("start-step") }),
  z.strictObject({ type: z.literal("finish-step") }),
  z.strictObject({ type: z.literal("text-start"), id: z.string(), ...providerMetadataFields }),
  z.strictObject({
    type: z.literal("text-delta"),
    id: z.string(),
    delta: z.string(),
    ...providerMetadataFields,
  }),
  z.strictObject({ type: z.literal("text-end"), id: z.string(), ...providerMetadataFields }),
  z.strictObject({
    type: z.literal("reasoning-start"),
    id: z.string(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("reasoning-delta"),
    id: z.string(),
    delta: z.string(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("reasoning-end"),
    id: z.string(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("custom"),
    kind: z.templateLiteral([z.string(), ".", z.string()]),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("source-url"),
    sourceId: z.string(),
    url: z.string(),
    title: z.string().optional(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("source-document"),
    sourceId: z.string(),
    mediaType: z.string(),
    title: z.string(),
    filename: z.string().optional(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("file"),
    mediaType: z.string(),
    url: z.string(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("reasoning-file"),
    mediaType: z.string(),
    url: z.string(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("tool-input-start"),
    toolCallId: z.string(),
    toolName: z.string(),
    providerExecuted: z.boolean().optional(),
    toolMetadata: z.record(z.string(), z.json()).optional(),
    dynamic: z.boolean().optional(),
    title: z.string().optional(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("tool-input-delta"),
    toolCallId: z.string(),
    inputTextDelta: z.string(),
  }),
  z.strictObject({
    type: z.literal("tool-input-available"),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    dynamic: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("tool-input-error"),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    errorText: z.string(),
    dynamic: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("tool-output-available"),
    toolCallId: z.string(),
    output: z.unknown(),
    dynamic: z.boolean().optional(),
    preliminary: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("tool-output-error"),
    toolCallId: z.string(),
    errorText: z.string(),
    dynamic: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal("tool-output-denied"), toolCallId: z.string() }),
  z.strictObject({ type: z.literal("abort"), reason: z.string().optional() }),
  z.strictObject({ type: z.literal("error"), errorText: z.string() }),
  z.strictObject({
    type: z.literal("data-session"),
    id: z.string().optional(),
    data: miniLilacSessionSnapshotSchema,
  }),
  z.strictObject({
    type: z.literal("data-control"),
    id: z.string().optional(),
    data: miniLilacControlResultSchema,
  }),
  z.strictObject({
    type: z.literal("data-transcriptReset"),
    id: z.string().optional(),
    data: miniLilacTranscriptResetSchema,
  }),
  z.strictObject({
    type: z.literal("data-outputRollback"),
    id: z.string().optional(),
    data: miniLilacOutputRollbackSchema,
  }),
  z.strictObject({
    type: z.literal("data-subagentStatus"),
    id: z.string().optional(),
    data: miniLilacSubagentStatusSchema,
  }),
  z.strictObject({
    type: z.literal("data-compaction"),
    id: z.string().optional(),
    data: miniLilacCompactionEventSchema,
  }),
  miniLilacTodoChunkSchema,
  miniLilacSteeringChunkSchema,
  miniLilacSteeringCommittedChunkSchema,
]);

export type StoredUIMessageChunk = z.infer<typeof standardChunkSchema>;
export type StoredRunChunk = { seq: number; chunk: StoredUIMessageChunk };

export function decodeStoredUIMessageChunk(
  value: unknown,
): ResultType<StoredUIMessageChunk, MiniLilacStoreOperationRejected> {
  const decoded = standardChunkSchema.safeParse(value);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new MiniLilacStoreOperationRejected({
      operation: "decodeStoredUIMessageChunk",
      message: "Stored UI message chunk is invalid",
    }),
  );
}

function decodeStoredSessionSnapshot(
  value: unknown,
): ResultType<MiniLilacSessionSnapshot | undefined, PersistedDataError> {
  if (value === undefined) return Result.ok(undefined);
  const decoded = miniLilacSessionSnapshotSchema.safeParse(value);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new CorruptPersistedFields({
      table: "commands",
      field: "command_result",
      version: MINI_LILAC_DATABASE_SCHEMA_VERSION,
      issueCode: "invalid-row-field",
      recordId: "session-snapshot-command",
      message: "Stored session snapshot command result is invalid",
    }),
  );
}

export function parseStoredUIMessageChunk(value: unknown): StoredUIMessageChunk {
  return storeResultToLegacy(decodeStoredUIMessageChunk(value));
}

export type MiniLilacRunStatus = z.infer<typeof runStatusSchema>;

export type StoredRun = {
  id: string;
  sessionId: string;
  parentRunId: string | null;
  profile: string;
  depth: number;
  status: MiniLilacRunStatus;
  error: string | null;
  terminalResult: unknown;
  startedAt: string;
  finishedAt: string | null;
};

export type CreateStoredSession = {
  id: string;
  cwd: string;
  model: string;
  profile: string;
  reasoning: MiniLilacReasoning;
  contextWindow?: number;
};

export type CreateStoredRun = {
  id: string;
  sessionId: string;
  parentRunId?: string;
  profile: string;
  depth: number;
};

export type StoredCommandRequest = {
  kind: string;
  runId: string | null;
  payload: unknown;
};

export type StoredSessionBindingUpdate = Pick<
  MiniLilacUpdateSessionBindingsRequest,
  "model" | "profile" | "reasoning"
> & { readonly contextWindow?: number | null };

export type StoredSessionResume = {
  snapshot: MiniLilacSessionSnapshot;
  messages: MiniLilacUIMessage[];
  replayCursor: { runId: string; afterSeq: number } | null;
};

export type ReplaceTodosForRun = {
  sessionId: string;
  runId: string;
  todos: readonly MiniLilacTodo[];
};

export type ReplaceTodosForRunResult = {
  state: MiniLilacTodoState;
};

export type StoredWorkspace = {
  readonly id: string;
  readonly canonicalCwd: string;
  readonly healthStatus: "healthy" | "corrupt";
  readonly healthDetail: string | null;
  readonly createdAt: string;
};

export type WorkspaceHistoryAvailabilityOwner = z.infer<typeof workspaceHistoryOwnerSchema>;

export type StoredHistoryStoreMetadata = {
  readonly namespaceId: string;
  readonly createdAt: string;
};

export type StoredWorkspaceSnapshot = {
  readonly id: string;
  readonly workspaceId: string;
  readonly rootTreeOid: string;
  readonly gitRef: string;
  readonly formatVersion: number;
  readonly availability: "available" | "missing" | "corrupt";
  readonly availabilityDetail: string | null;
  readonly createdAt: string;
};

export type StoredWorkspaceSnapshotGroup = {
  readonly workspace: StoredWorkspace;
  readonly snapshots: readonly StoredWorkspaceSnapshot[];
};

export type SetStoredWorkspaceSnapshotAvailability = {
  readonly workspaceId: string;
  readonly updates: readonly z.infer<typeof workspaceSnapshotAvailabilityUpdateSchema>[];
};

export type DeleteUnreferencedStoredWorkspaceSnapshots = {
  readonly workspaceId: string;
  readonly snapshotIds?: readonly string[];
};

export type HistoryProviderFamily = z.infer<typeof historyProviderFamilySchema>;
export type HistoryProviderState = z.infer<typeof historyProviderStateSchema>;

export type StoredHistoryState = {
  readonly id: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly modelHeadId: number | null;
  readonly uiHeadId: number | null;
  readonly workspaceSnapshotId: string | null;
  readonly workspaceStatus: z.infer<typeof historyWorkspaceStatusSchema>;
  readonly workspaceUnavailableReason: z.infer<
    typeof historyWorkspaceUnavailableReasonSchema
  > | null;
  readonly origin: z.infer<typeof historyStateOriginSchema>;
  readonly providerState: HistoryProviderState | null;
  readonly createdAt: string;
};

type CreateStoredHistoryState = Omit<StoredHistoryState, "createdAt" | "providerState"> & {
  readonly createdAt?: string;
  readonly providerState?: HistoryProviderState | null;
};

export type StoredHistoryTransition = {
  readonly id: string;
  readonly sessionId: string;
  readonly fromStateId: string;
  readonly toStateId: string | null;
  readonly kind: z.infer<typeof historyTransitionKindSchema>;
  readonly delivery: z.infer<typeof historyDeliverySchema> | null;
  readonly commandId: string | null;
  readonly userMessage: MiniLilacUserUIMessage | null;
  readonly rootRunId: string | null;
  readonly replayAfterSeq: number | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
};

type CreateStoredHistoryTransition = {
  readonly id: string;
  readonly sessionId: string;
  readonly fromStateId: string;
  readonly toStateId?: string;
  readonly createdAt?: string;
  readonly completedAt?: string;
} & (
  | {
      readonly kind: "user-message";
      readonly delivery: z.infer<typeof historyDeliverySchema>;
      readonly commandId: string;
      readonly userMessage: MiniLilacUserUIMessage;
      readonly rootRunId: string;
      readonly replayAfterSeq: number;
    }
  | {
      readonly kind: "workspace-observation" | "compaction";
    }
);

export type StoredHistoryWorkspaceOutcome =
  | {
      readonly workspaceSnapshotId: string;
      readonly workspaceStatus: "captured";
      readonly workspaceUnavailableReason: null;
    }
  | {
      readonly workspaceSnapshotId: null;
      readonly workspaceStatus: "unavailable";
      readonly workspaceUnavailableReason:
        | "git-unavailable"
        | "capture-failed"
        | "non-git-workspace"
        | "platform-unsupported";
    };

export type StoredHistoryObservationInput = StoredHistoryWorkspaceOutcome & {
  readonly stateId: string;
  readonly transitionId: string;
};

export type InternedStoredTranscriptHeads = {
  readonly modelHeadId: number | null;
  readonly uiHeadId: number | null;
};

export type AdmitStoredRootPromptHistory = {
  readonly run: CreateStoredRun;
  readonly commandId: string;
  readonly commandPayload: unknown;
  readonly transitionId: string;
  readonly expectedCurrentStateId: string;
  readonly modelMessages: readonly ModelMessage[];
  readonly uiMessages: readonly MiniLilacUIMessage[];
  readonly observation?: StoredHistoryObservationInput;
  readonly title?: string;
};

export type AdmittedStoredRootPromptHistory = {
  readonly snapshot: MiniLilacSessionSnapshot;
  readonly fromState: StoredHistoryState;
  readonly transition: StoredHistoryTransition;
};

export type StoredSteeringBoundaryEntry = {
  readonly commandId: string;
  readonly transitionId: string;
  readonly message: MiniLilacUserUIMessage;
  readonly modelMessage: ModelMessage;
  readonly replayAfterSeq: number;
  readonly intermediateStateId?: string;
};

export type CommitStoredSteeringBoundary = {
  readonly sessionId: string;
  readonly rootRunId: string;
  readonly previousOpenTransitionId: string;
  readonly boundaryStateId: string;
  readonly workspace: StoredHistoryWorkspaceOutcome;
  readonly mergedModelMessages: readonly ModelMessage[];
  readonly uiMessages: readonly MiniLilacUIMessage[];
  readonly entries: readonly StoredSteeringBoundaryEntry[];
  readonly providerState?: HistoryProviderState;
};

export type CommittedStoredSteeringBoundary = {
  readonly currentState: StoredHistoryState;
  readonly openTransition: StoredHistoryTransition;
};

export type StoredSessionHistory = {
  readonly sessionId: string;
  readonly rootStateId: string;
  readonly currentStateId: string;
  readonly undoFloorStateId: string;
  readonly updatedAt: string;
};

export type StoredHistoryNavigation = {
  readonly currentStateId: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
};

export type StoredHistoryRedoEntry = {
  readonly sessionId: string;
  readonly position: number;
  readonly targetStateId: string;
  readonly userTransitionId: string;
  readonly createdAt: string;
};

export type StoredHistoryTopology = {
  readonly history: StoredSessionHistory;
  readonly states: readonly StoredHistoryState[];
  readonly transitions: readonly StoredHistoryTransition[];
  readonly redoStack: readonly StoredHistoryRedoEntry[];
};

export type StoredHistoryAccounting = {
  readonly stateCount: number;
  readonly transitionCount: number;
  readonly branchTipCount: number;
  readonly snapshotCount: number;
  readonly redoStackCount: number;
  readonly activeOperationCount: number;
  readonly pendingFinalizationCount: number;
};

export type StoredHistoryOperation = {
  readonly id: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly commandId: string;
  readonly kind: "navigate";
  readonly requestedAction: z.infer<typeof historyOperationActionSchema>;
  readonly sourceStateId: string;
  readonly observedSourceStateId: string | null;
  readonly targetStateId: string;
  readonly userTransitionId: string;
  readonly filesystemMode: z.infer<typeof historyFilesystemModeSchema>;
  readonly skipReason: z.infer<typeof historySkipReasonSchema> | null;
  readonly phase: z.infer<typeof historyOperationPhaseSchema>;
  readonly preparedAt: string;
  readonly updatedAt: string;
};

export type ReserveStoredHistoryOperation = {
  readonly id: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly requestedAction: z.infer<typeof historyOperationActionSchema>;
  readonly expectedSourceStateId: string;
  readonly targetStateId: string;
  readonly userTransitionId: string;
  readonly filesystemMode: z.infer<typeof historyFilesystemModeSchema>;
  readonly skipReason: z.infer<typeof historySkipReasonSchema> | null;
  readonly observation?: StoredHistoryObservationInput;
};

export type ReservedStoredHistoryOperation = {
  readonly operation: StoredHistoryOperation;
  readonly observedState: StoredHistoryState | null;
};

export type StoredUndoHistoryResult = MiniLilacUndoResult;
export type StoredRedoHistoryResult = MiniLilacRedoResult;
export type StoredHistoryNavigationResult = z.infer<typeof storedHistoryNavigationResultSchema>;

export type CommitStoredHistoryNavigation = {
  readonly operationId: string;
  readonly result: StoredHistoryNavigationResult;
};

export type CommittedStoredHistoryNavigation = {
  readonly operation: StoredHistoryOperation;
  readonly currentState: StoredHistoryState;
  readonly navigation: StoredHistoryNavigation;
};

export type CommitEmptyStoredHistoryNavigation = {
  readonly sessionId: string;
  readonly commandId: string;
  readonly requestedAction: z.infer<typeof historyOperationActionSchema>;
  readonly request: StoredCommandRequest;
  readonly result: StoredUndoHistoryResult | StoredRedoHistoryResult;
};

export type CommittedEmptyStoredHistoryNavigation = {
  readonly result: Extract<StoredHistoryNavigationResult, { status: "empty" }>;
  readonly replayed: boolean;
  readonly navigation: StoredHistoryNavigation;
};

export type StoredHistoryCommandError = {
  readonly type: "history-command-error";
  readonly code: "history-recovery-abandoned";
  readonly commandId: string;
  readonly message: string;
};

export type AcknowledgeStoredHistoryNavigationAbandonment = {
  readonly operationId: string;
  readonly acknowledgePartialWorktree: true;
  readonly message: string;
};

export type PendingStoredRunFinalization = {
  readonly runId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly openTransitionId: string;
  readonly modelHeadId: number | null;
  readonly uiHeadId: number | null;
  readonly runStatus: "completed" | "cancelled" | "error";
  readonly sessionStatus: "idle" | "error";
  readonly error: string | null;
  readonly terminalResult: unknown;
  readonly inputTokens: number | null;
  readonly providerState: HistoryProviderState | null;
  readonly claudeBindingPromotion: PromoteMiniMainClaudeSessionBinding | null;
  readonly namedClaudeBindingPromotion: PromoteMiniNamedClaudeSessionBinding | null;
  readonly preparedAt: string;
};

export type RecoverableStoredOpenRootRun = {
  readonly runId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly openTransitionId: string;
  readonly inputTokens: number | null;
};

export type ReservePendingStoredRunFinalization = {
  readonly runId: string;
  readonly sessionId: string;
  readonly openTransitionId: string;
  readonly modelMessages: readonly ModelMessage[];
  readonly uiMessages: readonly MiniLilacUIMessage[];
  readonly runStatus: "completed" | "cancelled" | "error";
  readonly sessionStatus: "idle" | "error";
  readonly error: string | null;
  readonly terminalResult: unknown;
  readonly inputTokens: number | null;
  readonly providerState?: HistoryProviderState;
  readonly claudeBindingPromotion?: PromoteMiniMainClaudeSessionBinding;
  readonly namedClaudeBindingPromotion?: PromoteMiniNamedClaudeSessionBinding;
};

export type CommitPendingStoredRunFinalization = StoredHistoryWorkspaceOutcome & {
  readonly runId: string;
  readonly destinationStateId: string;
  readonly providerState?: HistoryProviderState;
  readonly claudeBindingPromotion?: PromoteMiniMainClaudeSessionBinding;
  readonly namedClaudeBindingPromotion?: PromoteMiniNamedClaudeSessionBinding;
};

export type CommittedPendingStoredRunFinalization = {
  readonly pending: PendingStoredRunFinalization;
  readonly state: StoredHistoryState;
  readonly snapshot: MiniLilacSessionSnapshot;
  readonly bindingPromotion: "not-requested" | "promoted" | "cas-failed";
};

export type MiniMainClaudeSessionBinding = {
  readonly bindingProtocolVersion: 1;
  readonly providerId: string;
  readonly providerFamily: "claude-code";
  readonly requestClient: string;
  readonly lilacSessionId: string;
  readonly historyStateId: string;
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
  readonly updatedAt: string;
};

export type MiniMainClaudeSessionAttempt = {
  readonly product: "mini";
  readonly providerId: string;
  readonly requestClient: string;
  readonly lilacSessionId: string;
  readonly sourceHistoryStateId: string;
  readonly sourceCanonicalMessageCount: number;
  readonly executionScopeHashVersion: 1;
  readonly executionScopeHash: string;
  readonly requestId: string;
  readonly attemptIndex: number;
  readonly candidateSessionId: string;
  readonly sourceSessionId: string | null;
  readonly expectedBindingRevision: number | null;
  readonly state: z.infer<typeof miniMainClaudeAttemptStateSchema>;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type MiniMainClaudeState = {
  readonly historyState: StoredHistoryState;
  readonly providerState: HistoryProviderState | null;
  readonly binding: MiniMainClaudeSessionBinding | null;
};

export type ReserveMiniMainClaudeSessionAttempt = {
  readonly providerId: string;
  readonly requestClient: string;
  readonly lilacSessionId: string;
  readonly sourceHistoryStateId: string;
  readonly executionScopeHashVersion: 1;
  readonly executionScopeHash: string;
  readonly requestId: string;
  readonly attemptIndex: number;
  readonly candidateSessionId: string;
  readonly sourceSessionId: string | null;
  readonly expectedBindingRevision: number | null;
};

export type RecordMiniMainClaudeSessionAttemptOutcome = {
  readonly providerId: string;
  readonly lilacSessionId: string;
  readonly requestId: string;
  readonly attemptIndex: number;
  readonly state: Exclude<z.infer<typeof miniMainClaudeAttemptStateSchema>, "active">;
};

export type PromoteMiniMainClaudeSessionBinding = {
  readonly providerId: string;
  readonly requestId: string;
  readonly attemptIndex: number;
  readonly nativeCwd: string;
  readonly nativeLastModified: number;
  readonly nativeContextTokens: number;
  readonly nativeContextMaxTokens: number;
  readonly lastModelSpecifier: string;
  readonly lastReasoning: string;
};

export type MiniNamedClaudeSessionBinding = MiniMainClaudeSessionBinding;

export type MiniNamedClaudeSessionAttempt = MiniMainClaudeSessionAttempt;

export type MiniClaudeRetentionDiagnostics = {
  readonly mainBindingCount: number;
  readonly namedBindingCount: number;
  readonly activeAttemptCount: number;
  readonly terminalAttemptCount: number;
  readonly orphanBindingCount: number;
  readonly orphanAttemptCount: number;
};

export type MiniNamedClaudeState = {
  readonly binding: MiniNamedClaudeSessionBinding | null;
};

export type ReserveMiniNamedClaudeSessionAttempt = Omit<
  ReserveMiniMainClaudeSessionAttempt,
  "sourceSessionId" | "expectedBindingRevision"
> & {
  readonly sourceSessionId: string | null;
  readonly expectedBindingRevision: number | null;
};

export type RecordMiniNamedClaudeSessionAttemptOutcome = RecordMiniMainClaudeSessionAttemptOutcome;

export type PromoteMiniNamedClaudeSessionBinding = PromoteMiniMainClaudeSessionBinding & {
  readonly canonicalMessageCount: number;
  readonly canonicalHeadHash: string;
};

export type CommitStoredHistoryCompaction = StoredHistoryWorkspaceOutcome & {
  readonly sessionId: string;
  readonly commandId: string;
  readonly request: StoredCommandRequest;
  readonly expectedCurrentStateId: string;
  readonly stateId: string;
  readonly transitionId: string;
  readonly modelMessages: readonly ModelMessage[];
  readonly compactionEvent: MiniLilacCompactionEvent;
  readonly result: MiniLilacCompactResult;
  readonly providerState?: HistoryProviderState;
  readonly observation?: StoredHistoryObservationInput;
};

export type CommittedStoredHistoryCompaction = {
  readonly state: StoredHistoryState;
  readonly snapshot: MiniLilacSessionSnapshot;
};

function serialize(value: unknown): string {
  return superjson.stringify(value);
}

function serializeStoreValueResult(
  value: unknown,
  operation: string,
): ResultType<string, MiniLilacStoreOperationRejected> {
  try {
    return Result.ok(serialize(value));
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new MiniLilacStoreOperationRejected({
        operation,
        message: "Store value is not serializable",
      }),
    );
  }
}

function storeResultToLegacy<T, E>(result: ResultType<T, E>): T {
  let $resultResultValue48249!: import("better-result").InferOk<NonNullable<typeof result>>;
  let $resultResultError48249!: import("better-result").InferErr<NonNullable<typeof result>>;
  const $resultResultOk48249 = Result.match<
    import("better-result").InferOk<NonNullable<typeof result>>,
    import("better-result").InferErr<NonNullable<typeof result>>,
    boolean
  >(result, {
    ok: (value) => {
      $resultResultValue48249 = value;
      return true;
    },
    err: (error) => {
      $resultResultError48249 = error;
      return false;
    },
  });
  if (($resultResultOk48249 ? "ok" : "error") === "error") throw $resultResultError48249;
  return $resultResultValue48249;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => {
          if (left < right) return -1;
          if (left > right) return 1;
          return 0;
        })
        .map(([key, nested]) => [key, canonicalJsonValue(nested)]),
    );
  }
  return value;
}

function storedProviderStateFlag(providerState: HistoryProviderState | null): number | null {
  if (providerState === null) return null;
  if (providerState.containsCrossFamilyTurns) return 1;
  return 0;
}

function canonicalCommandPayloadResult(
  payload: unknown,
): ResultType<
  { readonly json: string; readonly fingerprint: string },
  MiniLilacStoreOperationRejected
> {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(payload);
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new MiniLilacStoreOperationRejected({
        operation: "canonicalCommandPayload",
        message: "Command payload is not serializable JSON",
      }),
    );
  }
  if (serialized === undefined) {
    return Result.err(
      new MiniLilacStoreOperationRejected({
        operation: "canonicalCommandPayload",
        message: "Command payload is not serializable JSON",
      }),
    );
  }
  const parsedJson: unknown = JSON.parse(serialized);
  const jsonValue = z.json().safeParse(parsedJson);
  if (!jsonValue.success) {
    return Result.err(
      new MiniLilacStoreOperationRejected({
        operation: "canonicalCommandPayload",
        message: "Command payload is not valid JSON",
      }),
    );
  }
  const json = JSON.stringify(canonicalJsonValue(jsonValue.data));
  const fingerprint = new Bun.CryptoHasher("sha256").update(json).digest("hex");
  return Result.ok({ json, fingerprint });
}

function decodeCanonicalStoredCommandRequest(request: StoredCommandRequest): ResultType<
  {
    readonly kind: string;
    readonly runId: string | null;
    readonly json: string;
    readonly fingerprint: string;
  },
  MiniLilacStoreOperationRejected
> {
  const payload = canonicalCommandPayloadResult(request.payload);
  let $payloadResultValue50568!: import("better-result").InferOk<NonNullable<typeof payload>>;
  let $payloadResultError50568!: import("better-result").InferErr<NonNullable<typeof payload>>;
  const $payloadResultOk50568 = Result.match<
    import("better-result").InferOk<NonNullable<typeof payload>>,
    import("better-result").InferErr<NonNullable<typeof payload>>,
    boolean
  >(payload, {
    ok: (value) => {
      $payloadResultValue50568 = value;
      return true;
    },
    err: (error) => {
      $payloadResultError50568 = error;
      return false;
    },
  });
  if (($payloadResultOk50568 ? "ok" : "error") === "error")
    return Result.err($payloadResultError50568);
  return Result.ok({ kind: request.kind, runId: request.runId, ...$payloadResultValue50568 });
}

function decodeCanonicalRootPromptCommand(
  input: AdmitStoredRootPromptHistory,
): ResultType<
  { readonly json: string; readonly fingerprint: string },
  MiniLilacStoreOperationRejected
> {
  return canonicalCommandPayloadResult(input.commandPayload);
}

function serializeOptionalTerminalResult(
  input: { readonly terminalResult?: unknown },
  operation: string,
): ResultType<string | null, MiniLilacStoreOperationRejected> {
  if (input.terminalResult === undefined) return Result.ok(null);
  return serializeStoreValueResult(input.terminalResult, operation);
}

function canonicalValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
}

function validateSteeringHistoryBoundaryInput(
  input: CommitStoredSteeringBoundary,
): ResultType<
  { readonly firstUiPosition: number; readonly firstModelPosition: number },
  MiniLilacStoreOperationRejected
> {
  if (input.entries.length === 0) {
    return Result.err(
      rejectMiniLilacStoreOperation(
        "commitSteeringHistoryBoundary",
        "A steering boundary requires at least one entry",
      ),
    );
  }
  for (const [index, entry] of input.entries.entries()) {
    if (entry.modelMessage.role !== "user") {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "commitSteeringHistoryBoundary",
          "Every steering entry requires one canonical model user message",
        ),
      );
    }
    if (!Number.isInteger(entry.replayAfterSeq) || entry.replayAfterSeq < 0) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "commitSteeringHistoryBoundary",
          "Every steering entry requires a non-negative replay sequence",
        ),
      );
    }
    if (index < input.entries.length - 1 !== (entry.intermediateStateId !== undefined)) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "commitSteeringHistoryBoundary",
          "Every non-final steering entry requires exactly one intermediate state ID",
        ),
      );
    }
  }
  const firstUiPosition = input.uiMessages.length - input.entries.length;
  if (firstUiPosition < 0) {
    return Result.err(
      rejectMiniLilacStoreOperation(
        "commitSteeringHistoryBoundary",
        "Steering UI messages do not contain every entry",
      ),
    );
  }
  const firstModelPosition = input.mergedModelMessages.length - input.entries.length;
  if (firstModelPosition < 0) {
    return Result.err(
      rejectMiniLilacStoreOperation(
        "commitSteeringHistoryBoundary",
        "Steering model messages do not contain every entry",
      ),
    );
  }
  for (const [index, entry] of input.entries.entries()) {
    if (!canonicalValuesEqual(input.uiMessages[firstUiPosition + index], entry.message)) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "commitSteeringHistoryBoundary",
          "Steering entries must be the exact final canonical UI suffix",
        ),
      );
    }
    if (
      !canonicalValuesEqual(
        input.mergedModelMessages[firstModelPosition + index],
        entry.modelMessage,
      )
    ) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "commitSteeringHistoryBoundary",
          "Steering entries must be the exact final canonical model suffix",
        ),
      );
    }
  }
  return Result.ok({ firstUiPosition, firstModelPosition });
}

function canonicalizeStoredCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    return realpathSync.native(resolved);
  } catch {
    // A migrated session may outlive its workspace. Its already-canonical
    // absolute path remains the stable identity until the directory returns.
    return resolved;
  }
}

function isCanonicalPrefix(prefix: readonly unknown[], values: readonly unknown[]): boolean {
  if (prefix.length > values.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (!canonicalValuesEqual(prefix[index], values[index])) return false;
  }
  return true;
}

type StoredSessionRowSnapshot = Omit<
  MiniLilacSessionSnapshot,
  "historyStateId" | "canUndo" | "canRedo"
>;

function projectSessionRowSnapshot(
  row: MiniLilacStoreRowValueByKind["session"],
): StoredSessionRowSnapshot {
  return {
    id: row.id,
    activeRunId: row.active_run_id,
    status: row.status,
    cwd: row.cwd,
    model: row.model,
    profile: row.profile,
    reasoning: row.reasoning,
    title: row.title,
    inputTokens: row.input_tokens,
    inputTokensEstimated: row.input_tokens_estimated === 1,
    contextWindow: row.context_window,
    queuedSteeringCount: row.queued_steering_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function decodeSessionRowSnapshot(
  rowValue: unknown,
  recordId: string,
): ResultType<StoredSessionRowSnapshot, PersistedDataError | MiniLilacHistoryRecordMissing> {
  const decoded = decodeRequiredMiniLilacStoreRow({
    kind: "session",
    row: rowValue,
    schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
    recordId,
  });
  let $decodedResultValue55735!: import("better-result").InferOk<NonNullable<typeof decoded>>;
  let $decodedResultError55735!: import("better-result").InferErr<NonNullable<typeof decoded>>;
  const $decodedResultOk55735 = Result.match<
    import("better-result").InferOk<NonNullable<typeof decoded>>,
    import("better-result").InferErr<NonNullable<typeof decoded>>,
    boolean
  >(decoded, {
    ok: (value) => {
      $decodedResultValue55735 = value;
      return true;
    },
    err: (error) => {
      $decodedResultError55735 = error;
      return false;
    },
  });
  if (($decodedResultOk55735 ? "ok" : "error") === "error")
    return Result.err($decodedResultError55735);
  return Result.ok(projectSessionRowSnapshot($decodedResultValue55735));
}

function decodeRunRow(
  rowValue: unknown,
  recordId: string,
): ResultType<StoredRun, PersistedDataError | MiniLilacHistoryRecordMissing> {
  const decodedRow = decodeRequiredMiniLilacStoreRow({
    kind: "run",
    row: rowValue,
    schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
    recordId,
  });
  let $decodedRowResultValue56178!: import("better-result").InferOk<NonNullable<typeof decodedRow>>;
  let $decodedRowResultError56178!: import("better-result").InferErr<
    NonNullable<typeof decodedRow>
  >;
  const $decodedRowResultOk56178 = Result.match<
    import("better-result").InferOk<NonNullable<typeof decodedRow>>,
    import("better-result").InferErr<NonNullable<typeof decodedRow>>,
    boolean
  >(decodedRow, {
    ok: (value) => {
      $decodedRowResultValue56178 = value;
      return true;
    },
    err: (error) => {
      $decodedRowResultError56178 = error;
      return false;
    },
  });
  if (($decodedRowResultOk56178 ? "ok" : "error") === "error")
    return Result.err($decodedRowResultError56178);
  const row = $decodedRowResultValue56178;
  const terminalResult = decodeMiniLilacSuperJsonPayload({
    raw: row.terminal_result_json,
    schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
    recordId: row.id,
    field: "terminal_result",
  });
  let $terminalResultResultValue56450!: import("better-result").InferOk<
    NonNullable<typeof terminalResult>
  >;
  let $terminalResultResultError56450!: import("better-result").InferErr<
    NonNullable<typeof terminalResult>
  >;
  const $terminalResultResultOk56450 = Result.match<
    import("better-result").InferOk<NonNullable<typeof terminalResult>>,
    import("better-result").InferErr<NonNullable<typeof terminalResult>>,
    boolean
  >(terminalResult, {
    ok: (value) => {
      $terminalResultResultValue56450 = value;
      return true;
    },
    err: (error) => {
      $terminalResultResultError56450 = error;
      return false;
    },
  });
  if (($terminalResultResultOk56450 ? "ok" : "error") === "error")
    return Result.err($terminalResultResultError56450);
  return Result.ok({
    id: row.id,
    sessionId: row.session_id,
    parentRunId: row.parent_run_id,
    profile: row.profile,
    depth: row.depth,
    status: row.status,
    error: row.error,
    terminalResult: $terminalResultResultValue56450.value ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  });
}

function decodeMiniMainClaudeBindingRow(
  rowValue: unknown,
  recordId: string,
): ResultType<MiniMainClaudeSessionBinding, PersistedDataError | MiniLilacHistoryRecordMissing> {
  const decoded = decodeRequiredMiniLilacStoreRow({
    kind: "claude-binding",
    row: rowValue,
    schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
    recordId,
  });
  let $decodedResultValue57251!: import("better-result").InferOk<NonNullable<typeof decoded>>;
  let $decodedResultError57251!: import("better-result").InferErr<NonNullable<typeof decoded>>;
  const $decodedResultOk57251 = Result.match<
    import("better-result").InferOk<NonNullable<typeof decoded>>,
    import("better-result").InferErr<NonNullable<typeof decoded>>,
    boolean
  >(decoded, {
    ok: (value) => {
      $decodedResultValue57251 = value;
      return true;
    },
    err: (error) => {
      $decodedResultError57251 = error;
      return false;
    },
  });
  if (($decodedResultOk57251 ? "ok" : "error") === "error")
    return Result.err($decodedResultError57251);
  const row = $decodedResultValue57251;
  return Result.ok({
    bindingProtocolVersion: row.binding_protocol_version,
    providerId: row.provider_id,
    providerFamily: row.provider_family,
    requestClient: row.request_client,
    lilacSessionId: row.session_id,
    historyStateId: row.history_state_id,
    canonicalMessageCount: row.canonical_message_count,
    executionScopeHashVersion: row.execution_scope_hash_version,
    executionScopeHash: row.execution_scope_hash,
    claudeSessionId: row.claude_session_id,
    nativeCwd: row.native_cwd,
    nativeLastModified: row.native_last_modified,
    nativeContextTokens: row.native_context_tokens,
    nativeContextMaxTokens: row.native_context_max_tokens,
    lastModelSpecifier: row.last_model_specifier,
    lastReasoning: row.last_reasoning,
    revision: row.revision,
    updatedAt: row.updated_at,
  });
}

function decodeMiniMainClaudeAttemptRow(
  rowValue: unknown,
  recordId: string,
): ResultType<MiniMainClaudeSessionAttempt, PersistedDataError | MiniLilacHistoryRecordMissing> {
  const decoded = decodeRequiredMiniLilacStoreRow({
    kind: "claude-attempt",
    row: rowValue,
    schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
    recordId,
  });
  let $decodedResultValue58536!: import("better-result").InferOk<NonNullable<typeof decoded>>;
  let $decodedResultError58536!: import("better-result").InferErr<NonNullable<typeof decoded>>;
  const $decodedResultOk58536 = Result.match<
    import("better-result").InferOk<NonNullable<typeof decoded>>,
    import("better-result").InferErr<NonNullable<typeof decoded>>,
    boolean
  >(decoded, {
    ok: (value) => {
      $decodedResultValue58536 = value;
      return true;
    },
    err: (error) => {
      $decodedResultError58536 = error;
      return false;
    },
  });
  if (($decodedResultOk58536 ? "ok" : "error") === "error")
    return Result.err($decodedResultError58536);
  const row = $decodedResultValue58536;
  return Result.ok({
    product: row.product,
    providerId: row.provider_id,
    requestClient: row.request_client,
    lilacSessionId: row.session_id,
    sourceHistoryStateId: row.source_history_state_id,
    sourceCanonicalMessageCount: row.source_canonical_message_count,
    executionScopeHashVersion: row.execution_scope_hash_version,
    executionScopeHash: row.execution_scope_hash,
    requestId: row.request_id,
    attemptIndex: row.attempt_index,
    candidateSessionId: row.candidate_session_id,
    sourceSessionId: row.source_session_id,
    expectedBindingRevision: row.expected_binding_revision,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export type ReadonlyStoredHistoryRecoveryStatus = {
  readonly navigation: readonly {
    readonly canonicalCwd: string;
    readonly operation: StoredHistoryOperation;
  }[];
  readonly pendingFinalizations: readonly {
    readonly canonicalCwd: string;
    readonly finalization: PendingStoredRunFinalization;
  }[];
};

export class MiniLilacHistoryRecoveryVersionError extends Error {
  constructor(
    readonly actualVersion: number,
    readonly expectedVersion = MINI_LILAC_DATABASE_SCHEMA_VERSION,
  ) {
    super(
      `History recovery status requires mini-lilac database schema version ${expectedVersion}, but the database is version ${actualVersion}; start the Mini Lilac server with this database to migrate it before retrying status`,
    );
    this.name = "MiniLilacHistoryRecoveryVersionError";
  }
}

export class MiniLilacHistoryRecoveryPathFailure extends TaggedError(
  "MiniLilacHistoryRecoveryPathFailure",
)<{
  readonly filename: string;
  readonly message: string;
}> {}

export type MiniLilacHistoryRecoveryReadError =
  | PersistedDataError
  | MiniLilacSqliteDriverFailure
  | MiniLilacHistoryRecoveryVersionError
  | MiniLilacHistoryRecoveryPathFailure
  | MiniLilacHistoryRecordMissing;

export function readMiniLilacHistoryRecoveryStatus(
  filename: string,
): ReadonlyStoredHistoryRecoveryStatus {
  return storeResultToLegacy(readMiniLilacHistoryRecoveryStatusResult(filename));
}

function closeMiniLilacHistoryRecoveryDatabase(
  database: Database,
): ResultType<void, MiniLilacSqliteDriverFailure> {
  try {
    database.close();
    return Result.ok(undefined);
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    if (!(cause instanceof Error)) throw cause;
    const failure = classifyMiniLilacSqliteDriverFailure("readHistoryRecovery.close", cause);
    if (failure !== undefined) return Result.err(failure);
    throw cause;
  }
}

export function readMiniLilacHistoryRecoveryStatusResult(
  filename: string,
  options: MiniLilacSqliteStoreOptions = {},
): ResultType<ReadonlyStoredHistoryRecoveryStatus, MiniLilacHistoryRecoveryReadError> {
  const resolvedFilename = path.resolve(filename);
  if (existsSync(resolvedFilename) && lstatSync(resolvedFilename).isSymbolicLink()) {
    return Result.err(
      new MiniLilacHistoryRecoveryPathFailure({
        filename: resolvedFilename,
        message: `Mini Lilac database path '${resolvedFilename}' must not be a symbolic link`,
      }),
    );
  }
  let database: Database;
  try {
    database = new Database(resolvedFilename, { readonly: true, strict: true });
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    if (!(cause instanceof Error)) throw cause;
    const failure = classifyMiniLilacSqliteDriverFailure("readHistoryRecovery.open", cause);
    if (failure !== undefined) return Result.err(failure);
    throw cause;
  }
  const diagnostics: MiniLilacPersistenceDiagnostic[] = [];
  let outcome:
    | ResultType<ReadonlyStoredHistoryRecoveryStatus, MiniLilacHistoryRecoveryReadError>
    | undefined;
  let readDefect: MiniLilacCaughtDefect | undefined;
  try {
    const decodedVersion = decodeMiniLilacDatabaseVersion(
      database.query("PRAGMA user_version").get(),
    );
    let $decodedVersionResultValue62612!: import("better-result").InferOk<
      NonNullable<typeof decodedVersion>
    >;
    let $decodedVersionResultError62612!: import("better-result").InferErr<
      NonNullable<typeof decodedVersion>
    >;
    const $decodedVersionResultOk62612 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decodedVersion>>,
      import("better-result").InferErr<NonNullable<typeof decodedVersion>>,
      boolean
    >(decodedVersion, {
      ok: (value) => {
        $decodedVersionResultValue62612 = value;
        return true;
      },
      err: (error) => {
        $decodedVersionResultError62612 = error;
        return false;
      },
    });
    if (($decodedVersionResultOk62612 ? "ok" : "error") === "error") {
      diagnostics.push({
        table: $decodedVersionResultError62612.table,
        field: $decodedVersionResultError62612.field,
        version: $decodedVersionResultError62612.version,
        issueCode: $decodedVersionResultError62612.issueCode,
        recordId: $decodedVersionResultError62612.recordId,
        message: $decodedVersionResultError62612.message,
      });
      outcome = Result.err($decodedVersionResultError62612);
    } else if ($decodedVersionResultValue62612 !== MINI_LILAC_DATABASE_SCHEMA_VERSION) {
      outcome = Result.err(
        new MiniLilacHistoryRecoveryVersionError($decodedVersionResultValue62612),
      );
    } else {
      const navigation: Array<{
        readonly canonicalCwd: string;
        readonly operation: StoredHistoryOperation;
      }> = [];
      const operations = decodeMiniLilacStructuralHistoryRows({
        kind: "operation",
        rows: database.query("SELECT * FROM history_operations ORDER BY prepared_at, rowid").all(),
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: "recovery-operation",
      });
      let $operationsResultValue63462!: import("better-result").InferOk<
        NonNullable<typeof operations>
      >;
      let $operationsResultError63462!: import("better-result").InferErr<
        NonNullable<typeof operations>
      >;
      const $operationsResultOk63462 = Result.match<
        import("better-result").InferOk<NonNullable<typeof operations>>,
        import("better-result").InferErr<NonNullable<typeof operations>>,
        boolean
      >(operations, {
        ok: (value) => {
          $operationsResultValue63462 = value;
          return true;
        },
        err: (error) => {
          $operationsResultError63462 = error;
          return false;
        },
      });
      if (($operationsResultOk63462 ? "ok" : "error") === "error") {
        diagnostics.push({
          table: $operationsResultError63462.table,
          field: $operationsResultError63462.field,
          version: $operationsResultError63462.version,
          issueCode: $operationsResultError63462.issueCode,
          recordId: $operationsResultError63462.recordId,
          message: $operationsResultError63462.message,
        });
        outcome = Result.err($operationsResultError63462);
      } else {
        for (const operation of $operationsResultValue63462.value) {
          const workspace = decodeMiniLilacStructuralHistoryRow({
            kind: "workspace",
            row: database.query("SELECT * FROM workspaces WHERE id = ?").get(operation.workspaceId),
            schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
            recordId: operation.workspaceId,
          });
          let $workspaceResultValue64237!: import("better-result").InferOk<
            NonNullable<typeof workspace>
          >;
          let $workspaceResultError64237!: import("better-result").InferErr<
            NonNullable<typeof workspace>
          >;
          const $workspaceResultOk64237 = Result.match<
            import("better-result").InferOk<NonNullable<typeof workspace>>,
            import("better-result").InferErr<NonNullable<typeof workspace>>,
            boolean
          >(workspace, {
            ok: (value) => {
              $workspaceResultValue64237 = value;
              return true;
            },
            err: (error) => {
              $workspaceResultError64237 = error;
              return false;
            },
          });
          if (($workspaceResultOk64237 ? "ok" : "error") === "error") {
            diagnostics.push({
              table: $workspaceResultError64237.table,
              field: $workspaceResultError64237.field,
              version: $workspaceResultError64237.version,
              issueCode: $workspaceResultError64237.issueCode,
              recordId: $workspaceResultError64237.recordId,
              message: $workspaceResultError64237.message,
            });
            outcome = Result.err($workspaceResultError64237);
            break;
          }
          if ($workspaceResultValue64237.value?.kind !== "workspace") {
            outcome = Result.err(
              new MiniLilacHistoryRecordMissing({
                recordKind: "workspace",
                recordId: operation.workspaceId,
                message: "Mini Lilac recovery workspace was not found",
              }),
            );
            break;
          }
          navigation.push({
            canonicalCwd: $workspaceResultValue64237.value.value.canonicalCwd,
            operation,
          });
        }
      }

      if (outcome === undefined) {
        const pendingFinalizations: Array<{
          readonly canonicalCwd: string;
          readonly finalization: PendingStoredRunFinalization;
        }> = [];
        const finalizations = decodeMiniLilacStructuralHistoryRows({
          kind: "pending-finalization",
          rows: database
            .query("SELECT * FROM pending_run_finalizations ORDER BY prepared_at, rowid")
            .all(),
          schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
          recordId: "recovery-finalization",
        });
        let $finalizationsResultValue65739!: import("better-result").InferOk<
          NonNullable<typeof finalizations>
        >;
        let $finalizationsResultError65739!: import("better-result").InferErr<
          NonNullable<typeof finalizations>
        >;
        const $finalizationsResultOk65739 = Result.match<
          import("better-result").InferOk<NonNullable<typeof finalizations>>,
          import("better-result").InferErr<NonNullable<typeof finalizations>>,
          boolean
        >(finalizations, {
          ok: (value) => {
            $finalizationsResultValue65739 = value;
            return true;
          },
          err: (error) => {
            $finalizationsResultError65739 = error;
            return false;
          },
        });
        if (($finalizationsResultOk65739 ? "ok" : "error") === "error") {
          diagnostics.push({
            table: $finalizationsResultError65739.table,
            field: $finalizationsResultError65739.field,
            version: $finalizationsResultError65739.version,
            issueCode: $finalizationsResultError65739.issueCode,
            recordId: $finalizationsResultError65739.recordId,
            message: $finalizationsResultError65739.message,
          });
          outcome = Result.err($finalizationsResultError65739);
        } else {
          for (const finalization of $finalizationsResultValue65739.value) {
            const workspace = decodeMiniLilacStructuralHistoryRow({
              kind: "workspace",
              row: database
                .query("SELECT * FROM workspaces WHERE id = ?")
                .get(finalization.workspaceId),
              schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
              recordId: finalization.workspaceId,
            });
            let $workspaceResultValue66630!: import("better-result").InferOk<
              NonNullable<typeof workspace>
            >;
            let $workspaceResultError66630!: import("better-result").InferErr<
              NonNullable<typeof workspace>
            >;
            const $workspaceResultOk66630 = Result.match<
              import("better-result").InferOk<NonNullable<typeof workspace>>,
              import("better-result").InferErr<NonNullable<typeof workspace>>,
              boolean
            >(workspace, {
              ok: (value) => {
                $workspaceResultValue66630 = value;
                return true;
              },
              err: (error) => {
                $workspaceResultError66630 = error;
                return false;
              },
            });
            if (($workspaceResultOk66630 ? "ok" : "error") === "error") {
              diagnostics.push({
                table: $workspaceResultError66630.table,
                field: $workspaceResultError66630.field,
                version: $workspaceResultError66630.version,
                issueCode: $workspaceResultError66630.issueCode,
                recordId: $workspaceResultError66630.recordId,
                message: $workspaceResultError66630.message,
              });
              outcome = Result.err($workspaceResultError66630);
              break;
            }
            if ($workspaceResultValue66630.value?.kind !== "workspace") {
              outcome = Result.err(
                new MiniLilacHistoryRecordMissing({
                  recordKind: "workspace",
                  recordId: finalization.workspaceId,
                  message: "Mini Lilac recovery workspace was not found",
                }),
              );
              break;
            }
            pendingFinalizations.push({
              canonicalCwd: $workspaceResultValue66630.value.value.canonicalCwd,
              finalization,
            });
          }
        }
        if (outcome === undefined) outcome = Result.ok({ navigation, pendingFinalizations });
      }
    }
  } catch (cause) {
    if (Panic.is(cause)) {
      readDefect = { kind: "panic", cause };
    } else if (cause instanceof Error) {
      const failure = classifyMiniLilacSqliteDriverFailure("readHistoryRecovery", cause);
      if (failure === undefined) readDefect = { kind: "error", cause };
      else outcome = Result.err(failure);
    } else {
      readDefect = { kind: "hostile", cause };
    }
  }
  const closed = captureMiniLilacCleanup(() => closeMiniLilacHistoryRecoveryDatabase(database));
  if (readDefect !== undefined) {
    throwPrimaryAfterCleanup(
      readDefect,
      "readHistoryRecovery.close",
      closed,
      options.onCleanupDefect ?? defaultMiniLilacCleanupDefectReporter,
    );
  }
  for (const diagnostic of diagnostics) {
    (
      options.onPersistenceDiagnostic ??
      ((value) => logger.warn("Mini Lilac persisted data is invalid", value))
    )(diagnostic);
  }
  if (closed.status === "expected-error") return Result.err(closed.error);
  if (closed.status === "defect") closed.rethrow();
  if (outcome === undefined) {
    throw new Panic({
      message: "Mini Lilac history recovery read completed without an outcome",
      cause: resolvedFilename,
    });
  }
  return outcome;
}

export class MiniLilacSqliteStore {
  readonly database: Database;
  readonly filename: string;
  private closeBlockers = 0;
  private closed = false;
  private transactionDepth = 0;
  private readonly pendingPersistenceDiagnostics: MiniLilacPersistenceDiagnostic[] = [];
  private readonly onPersistenceDiagnostic: (diagnostic: MiniLilacPersistenceDiagnostic) => void;
  private readonly onCleanupDefect: (report: MiniLilacCleanupDefectReport) => void;

  constructor(filename: string, options: MiniLilacSqliteStoreOptions = {}) {
    this.onPersistenceDiagnostic =
      options.onPersistenceDiagnostic ??
      ((diagnostic) => logger.warn("Mini Lilac persisted data is invalid", diagnostic));
    this.onCleanupDefect = options.onCleanupDefect ?? defaultMiniLilacCleanupDefectReporter;
    this.filename = filename === ":memory:" ? filename : path.resolve(filename);
    if (this.filename !== ":memory:" && existsSync(this.filename)) {
      if (lstatSync(this.filename).isSymbolicLink()) {
        throw new Error(`Mini Lilac database path '${this.filename}' must not be a symbolic link`);
      }
    }
    this.database = new Database(this.filename, { create: true, strict: true });
    try {
      this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      this.secureDatabaseFiles();
      this.initializeSchema();
    } catch (primary) {
      let primaryFailure: MiniLilacCaughtDefect;
      if (Panic.is(primary)) {
        primaryFailure = { kind: "panic", cause: primary };
      } else if (primary instanceof Error) {
        primaryFailure = { kind: "error", cause: primary };
      } else {
        primaryFailure = { kind: "hostile", cause: primary };
      }
      const cleanup = captureMiniLilacCleanup(() => this.closeAfterInitializationFailure());
      if (
        primaryFailure.kind !== "error" ||
        !isExpectedSchemaInitializationFailure(primaryFailure.cause)
      ) {
        throwPrimaryAfterCleanup(
          primaryFailure,
          "constructor.closeAfterInitializationFailure",
          cleanup,
          this.onCleanupDefect,
        );
      }
      if (cleanup.status === "expected-error") {
        throw new MiniLilacSchemaInitializationCombinedFailure({
          operation: "closeAfterInitializationFailure",
          primary: primaryFailure.cause,
          cleanup: cleanup.error,
          message: "Mini Lilac schema initialization and database cleanup both failed",
        });
      }
      if (cleanup.status === "defect") cleanup.rethrow();
      throw primaryFailure.cause;
    }
  }

  private closeAfterInitializationFailure(): ResultType<void, MiniLilacSqliteDriverFailure> {
    try {
      this.database.close();
      return Result.ok(undefined);
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      if (!(cause instanceof Error)) throw cause;
      const failure = classifyMiniLilacSqliteDriverFailure(
        "closeAfterInitializationFailure",
        cause,
      );
      if (failure !== undefined) return Result.err(failure);
      throw cause;
    }
  }

  private secureDatabaseFiles(): void {
    if (this.filename === ":memory:" || process.platform === "win32") return;
    for (const file of [
      this.filename,
      `${this.filename}-journal`,
      `${this.filename}-shm`,
      `${this.filename}-wal`,
    ]) {
      if (existsSync(file)) chmodSync(file, 0o600);
    }
  }

  private initializeSchema(): void {
    storeResultToLegacy(this.initializeSchemaResult());
  }

  private initializeSchemaResult(): ResultType<void, MiniLilacSchemaInitializationError> {
    try {
      const decodedVersion = decodeMiniLilacDatabaseVersion(
        this.database.query("PRAGMA user_version").get(),
      );
      let $decodedVersionResultValue72988!: import("better-result").InferOk<
        NonNullable<typeof decodedVersion>
      >;
      let $decodedVersionResultError72988!: import("better-result").InferErr<
        NonNullable<typeof decodedVersion>
      >;
      const $decodedVersionResultOk72988 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decodedVersion>>,
        import("better-result").InferErr<NonNullable<typeof decodedVersion>>,
        boolean
      >(decodedVersion, {
        ok: (value) => {
          $decodedVersionResultValue72988 = value;
          return true;
        },
        err: (error) => {
          $decodedVersionResultError72988 = error;
          return false;
        },
      });
      if (($decodedVersionResultOk72988 ? "ok" : "error") === "error")
        return Result.err($decodedVersionResultError72988);
      const version = $decodedVersionResultValue72988;
      if (version === MINI_LILAC_DATABASE_SCHEMA_VERSION) return Result.ok(undefined);
      if (
        version !== 0 &&
        version !== 2 &&
        version !== 3 &&
        version !== 4 &&
        version !== 5 &&
        version !== 6 &&
        version !== 7
      ) {
        return Result.err(new MiniLilacDatabaseVersionError(version));
      }

      // Session and run composite ownership require SQLite's documented table
      // rebuild. These pragmas cannot be changed from inside the transaction.
      this.database.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON;");
      let migrated: ResultType<
        void,
        MiniLilacSchemaMigrationFailure | MiniLilacSqliteDriverFailure | PersistedDataError
      >;
      let migrationDefect: MiniLilacCaughtDefect | undefined;
      try {
        migrated = runBunSqliteTransaction(
          this.database,
          () => {
            if (version === 0) {
              this.createSchemaV6();
            } else {
              if (version === 2) {
                const migration = this.migrateSchemaV2ToV3();
                const migrationError = migration.match({ ok: () => null, err: (error) => error });
                if (migrationError !== null) return Result.err(migrationError);
              }
              if (version === 2 || version === 3) this.migrateSchemaV3ToV4();
              if (version === 2 || version === 3 || version === 4) {
                const migration = this.migrateSchemaV4ToV5();
                const migrationError = migration.match({ ok: () => null, err: (error) => error });
                if (migrationError !== null) return Result.err(migrationError);
              }
              if (version === 5) this.migrateSchemaV5ToV6();
            }
            if (version <= 6) this.migrateSchemaV6ToV7();
            this.migrateSchemaV7ToV8();
            const violations = this.database.query("PRAGMA foreign_key_check").all();
            if (violations.length > 0) {
              return Result.err(
                new MiniLilacSchemaMigrationFailure({
                  operation: "initializeSchema",
                  message: `Mini Lilac schema migration left ${violations.length} foreign key violation(s)`,
                }),
              );
            }
            this.database.exec(`PRAGMA user_version = ${MINI_LILAC_DATABASE_SCHEMA_VERSION};`);
            return Result.ok(undefined);
          },
          (cause) => classifyMiniLilacSqliteDriverFailure("initializeSchema", cause),
        );
      } catch (cause) {
        if (cause instanceof z.ZodError) {
          migrated = Result.err(
            new MiniLilacSchemaMigrationFailure({
              operation: "initializeSchema",
              message: "Mini Lilac schema migration encountered corrupt structural fields",
            }),
          );
        } else if (
          cause instanceof MiniLilacSchemaMigrationFailure ||
          cause instanceof MiniLilacSqliteDriverFailure ||
          cause instanceof CorruptPersistedFields ||
          cause instanceof MalformedSerialization ||
          cause instanceof UnsupportedVersion
        ) {
          migrated = Result.err(cause);
        } else {
          if (Panic.is(cause)) {
            migrationDefect = { kind: "panic", cause };
          } else if (cause instanceof Error) {
            migrationDefect = { kind: "error", cause };
          } else {
            migrationDefect = { kind: "hostile", cause };
          }
          migrated = Result.ok(undefined);
        }
      }
      const migrationError = migrated.match({ ok: () => null, err: (error) => error });
      const cleanup = captureMiniLilacCleanup(() => this.restoreSchemaMigrationPragmas());
      if (migrationDefect !== undefined) {
        throwPrimaryAfterCleanup(
          migrationDefect,
          "initializeSchema.restorePragmas",
          cleanup,
          this.onCleanupDefect,
        );
      }
      if (cleanup.status === "expected-error") {
        if (migrationError !== null) {
          return Result.err(
            new MiniLilacSchemaInitializationCombinedFailure({
              operation: "initializeSchema",
              primary: migrationError,
              cleanup: cleanup.error,
              message: "Mini Lilac schema migration and cleanup both failed",
            }),
          );
        }
        return Result.err(cleanup.error);
      }
      if (cleanup.status === "defect") cleanup.rethrow();
      if (migrationError !== null) return Result.err(migrationError);
      const violations = this.database.query("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        return Result.err(
          new MiniLilacSchemaMigrationFailure({
            operation: "initializeSchema",
            message: `Mini Lilac migrated schema has ${violations.length} foreign key violation(s)`,
          }),
        );
      }
      return Result.ok(undefined);
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      if (
        cause instanceof MiniLilacDatabaseVersionError ||
        cause instanceof CorruptPersistedFields ||
        cause instanceof MalformedSerialization ||
        cause instanceof UnsupportedVersion ||
        cause instanceof MiniLilacSchemaMigrationFailure ||
        cause instanceof MiniLilacSqliteDriverFailure ||
        cause instanceof MiniLilacSchemaInitializationCombinedFailure
      ) {
        return Result.err(cause);
      }
      if (cause instanceof z.ZodError) {
        return Result.err(
          new MiniLilacSchemaMigrationFailure({
            operation: "initializeSchema",
            message: "Mini Lilac schema migration encountered corrupt structural fields",
          }),
        );
      }
      if (!(cause instanceof Error)) throw cause;
      const driverFailure = classifyMiniLilacSqliteDriverFailure("initializeSchema", cause);
      if (driverFailure !== undefined) return Result.err(driverFailure);
      throw cause;
    }
  }

  private restoreSchemaMigrationPragmas(): ResultType<void, MiniLilacSqliteDriverFailure> {
    try {
      this.database.exec("PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;");
      return Result.ok(undefined);
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      if (!(cause instanceof Error)) throw cause;
      const failure = classifyMiniLilacSqliteDriverFailure("initializeSchema.cleanup", cause);
      if (failure !== undefined) return Result.err(failure);
      throw cause;
    }
  }

  private createSchemaV6(): void {
    this.database.exec(`
        CREATE TABLE history_store_metadata (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          namespace_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          canonical_cwd TEXT NOT NULL UNIQUE,
          health_status TEXT NOT NULL DEFAULT 'healthy'
            CHECK(health_status IN ('healthy', 'corrupt')),
          health_detail TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          active_run_id TEXT,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          cwd TEXT NOT NULL,
          model TEXT NOT NULL,
          profile TEXT NOT NULL,
          reasoning TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT 'Mini Lilac',
          input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
          input_tokens_estimated INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens_estimated IN (0, 1)),
          context_window INTEGER CHECK(context_window IS NULL OR context_window > 0),
          status TEXT NOT NULL CHECK(status IN ('idle', 'streaming', 'compacting', 'cancelling', 'error')),
          queued_steering_count INTEGER NOT NULL DEFAULT 0 CHECK(queued_steering_count >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(id, workspace_id)
        );
        CREATE INDEX sessions_workspace ON sessions(workspace_id);
        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          parent_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
          profile TEXT NOT NULL,
          depth INTEGER NOT NULL CHECK(depth >= 0),
          status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'cancelled', 'error')),
          error TEXT,
          terminal_result_json TEXT,
          undone_at TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          UNIQUE(id, session_id)
        );
        CREATE UNIQUE INDEX one_active_root_run_per_session
          ON runs(session_id) WHERE status = 'active' AND parent_run_id IS NULL;
        CREATE TABLE commands (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          command_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          run_id TEXT,
          request_fingerprint TEXT NOT NULL,
          request_json TEXT NOT NULL,
          side_effect_started INTEGER NOT NULL CHECK(side_effect_started IN (0, 1)),
          result_json TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY(session_id, command_id)
        );
        CREATE TABLE transcript_nodes (
          id INTEGER PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          lane TEXT NOT NULL CHECK(lane IN ('model', 'ui')),
          parent_id INTEGER,
          depth INTEGER NOT NULL CHECK(depth > 0),
          value_json TEXT NOT NULL,
          hash TEXT NOT NULL,
          UNIQUE(session_id, lane, hash),
          UNIQUE(id, session_id, lane),
          FOREIGN KEY(parent_id, session_id, lane)
            REFERENCES transcript_nodes(id, session_id, lane)
        );
        CREATE INDEX transcript_nodes_parent ON transcript_nodes(parent_id);
        CREATE TABLE session_transcript_heads (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          model_head_id INTEGER,
          model_lane TEXT NOT NULL DEFAULT 'model' CHECK(model_lane = 'model'),
          ui_head_id INTEGER,
          ui_lane TEXT NOT NULL DEFAULT 'ui' CHECK(ui_lane = 'ui'),
          FOREIGN KEY(model_head_id, session_id, model_lane)
            REFERENCES transcript_nodes(id, session_id, lane),
          FOREIGN KEY(ui_head_id, session_id, ui_lane)
            REFERENCES transcript_nodes(id, session_id, lane)
        );
        CREATE TABLE session_todos (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL CHECK(revision >= 0 AND revision <= 9007199254740991),
          todos_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    this.createHistorySchemaTables();
    this.database
      .query(
        "INSERT INTO history_store_metadata (singleton, namespace_id, created_at) VALUES (1, ?, ?)",
      )
      .run(randomUUID(), new Date().toISOString());
  }

  private createHistorySchemaTables(): void {
    this.database.exec(`
      CREATE TABLE workspace_snapshots (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        root_tree_oid TEXT NOT NULL,
        git_ref TEXT NOT NULL,
        format_version INTEGER NOT NULL,
        availability TEXT NOT NULL DEFAULT 'available'
          CHECK(availability IN ('available', 'missing', 'corrupt')),
        availability_detail TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(id, workspace_id),
        UNIQUE(workspace_id, root_tree_oid, format_version),
        UNIQUE(workspace_id, git_ref)
      );
      CREATE TABLE history_states (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        model_head_id INTEGER,
        model_lane TEXT NOT NULL DEFAULT 'model' CHECK(model_lane = 'model'),
        ui_head_id INTEGER,
        ui_lane TEXT NOT NULL DEFAULT 'ui' CHECK(ui_lane = 'ui'),
        workspace_snapshot_id TEXT,
        workspace_status TEXT NOT NULL CHECK(
          workspace_status IN ('captured', 'unavailable', 'capture-deferred')
        ),
        workspace_unavailable_reason TEXT CHECK(
          workspace_unavailable_reason IN (
            'git-unavailable', 'capture-failed', 'legacy-migration', 'non-git-workspace',
            'platform-unsupported'
          )
        ),
        origin TEXT NOT NULL CHECK(
          origin IN ('root', 'turn-boundary', 'workspace-observation', 'compaction', 'migration')
        ),
        created_at TEXT NOT NULL,
        UNIQUE(id, session_id),
        UNIQUE(id, workspace_id),
        FOREIGN KEY(session_id, workspace_id)
          REFERENCES sessions(id, workspace_id) ON DELETE CASCADE,
        FOREIGN KEY(workspace_snapshot_id, workspace_id)
          REFERENCES workspace_snapshots(id, workspace_id),
        FOREIGN KEY(model_head_id, session_id, model_lane)
          REFERENCES transcript_nodes(id, session_id, lane),
        FOREIGN KEY(ui_head_id, session_id, ui_lane)
          REFERENCES transcript_nodes(id, session_id, lane),
        CHECK(
          (workspace_status = 'captured' AND workspace_snapshot_id IS NOT NULL
            AND workspace_unavailable_reason IS NULL) OR
          (workspace_status = 'unavailable' AND workspace_snapshot_id IS NULL
            AND workspace_unavailable_reason IS NOT NULL) OR
          (workspace_status = 'capture-deferred' AND workspace_snapshot_id IS NULL
            AND workspace_unavailable_reason IS NULL)
        )
      );
      CREATE TABLE history_transitions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        from_state_id TEXT NOT NULL,
        to_state_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('user-message', 'workspace-observation', 'compaction')),
        delivery TEXT CHECK(delivery IN ('prompt', 'steer')),
        command_id TEXT,
        user_message_json TEXT,
        root_run_id TEXT,
        replay_after_seq INTEGER CHECK(replay_after_seq IS NULL OR replay_after_seq >= 0),
        created_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(id, session_id),
        UNIQUE(to_state_id),
        FOREIGN KEY(from_state_id, session_id) REFERENCES history_states(id, session_id),
        FOREIGN KEY(to_state_id, session_id) REFERENCES history_states(id, session_id),
        FOREIGN KEY(session_id, command_id) REFERENCES commands(session_id, command_id),
        FOREIGN KEY(root_run_id, session_id) REFERENCES runs(id, session_id),
        CHECK(
          (kind = 'user-message' AND delivery IS NOT NULL AND user_message_json IS NOT NULL
            AND root_run_id IS NOT NULL AND replay_after_seq IS NOT NULL) OR
          (kind != 'user-message' AND delivery IS NULL AND command_id IS NULL
            AND user_message_json IS NULL AND root_run_id IS NULL AND replay_after_seq IS NULL)
        ),
        CHECK(
          (to_state_id IS NULL AND completed_at IS NULL) OR
          (to_state_id IS NOT NULL AND completed_at IS NOT NULL)
        ),
        CHECK(to_state_id IS NOT NULL OR kind = 'user-message')
      );
      CREATE UNIQUE INDEX one_open_user_transition_per_session
        ON history_transitions(session_id) WHERE to_state_id IS NULL;
      CREATE TABLE session_history (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        root_state_id TEXT NOT NULL,
        current_state_id TEXT NOT NULL,
        undo_floor_state_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(root_state_id, session_id) REFERENCES history_states(id, session_id),
        FOREIGN KEY(current_state_id, session_id) REFERENCES history_states(id, session_id),
        FOREIGN KEY(undo_floor_state_id, session_id) REFERENCES history_states(id, session_id)
      );
      CREATE TABLE history_redo_stack (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position >= 0),
        target_state_id TEXT NOT NULL,
        user_transition_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(session_id, position),
        FOREIGN KEY(target_state_id, session_id) REFERENCES history_states(id, session_id),
        FOREIGN KEY(user_transition_id, session_id) REFERENCES history_transitions(id, session_id)
      );
      CREATE TABLE history_operations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind = 'navigate'),
        requested_action TEXT NOT NULL CHECK(requested_action IN ('undo', 'redo')),
        source_state_id TEXT NOT NULL,
        observed_source_state_id TEXT,
        target_state_id TEXT NOT NULL,
        user_transition_id TEXT NOT NULL,
        filesystem_mode TEXT NOT NULL CHECK(filesystem_mode IN ('restore', 'skip')),
        skip_reason TEXT CHECK(
          skip_reason IN (
            'git-unavailable', 'non-git-workspace', 'snapshot-unavailable', 'platform-unsupported'
          )
        ),
        phase TEXT NOT NULL CHECK(phase IN ('prepared', 'restoring', 'verified')),
        prepared_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id),
        FOREIGN KEY(session_id, workspace_id) REFERENCES sessions(id, workspace_id),
        FOREIGN KEY(session_id, command_id) REFERENCES commands(session_id, command_id),
        FOREIGN KEY(source_state_id, session_id) REFERENCES history_states(id, session_id),
        FOREIGN KEY(observed_source_state_id, session_id) REFERENCES history_states(id, session_id),
        FOREIGN KEY(target_state_id, session_id) REFERENCES history_states(id, session_id),
        FOREIGN KEY(user_transition_id, session_id) REFERENCES history_transitions(id, session_id),
        CHECK(
          (filesystem_mode = 'restore' AND skip_reason IS NULL) OR
          (filesystem_mode = 'skip' AND skip_reason IS NOT NULL)
        )
      );
      CREATE TABLE pending_run_finalizations (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        open_transition_id TEXT NOT NULL,
        model_head_id INTEGER,
        model_lane TEXT NOT NULL DEFAULT 'model' CHECK(model_lane = 'model'),
        ui_head_id INTEGER,
        ui_lane TEXT NOT NULL DEFAULT 'ui' CHECK(ui_lane = 'ui'),
        run_status TEXT NOT NULL CHECK(run_status IN ('completed', 'cancelled', 'error')),
        session_status TEXT NOT NULL CHECK(session_status IN ('idle', 'error')),
        error TEXT,
        terminal_result_json TEXT,
        input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
        prepared_at TEXT NOT NULL,
        UNIQUE(workspace_id),
        UNIQUE(open_transition_id),
        FOREIGN KEY(session_id, workspace_id) REFERENCES sessions(id, workspace_id),
        FOREIGN KEY(run_id, session_id) REFERENCES runs(id, session_id),
        FOREIGN KEY(open_transition_id, session_id)
          REFERENCES history_transitions(id, session_id),
        FOREIGN KEY(model_head_id, session_id, model_lane)
          REFERENCES transcript_nodes(id, session_id, lane),
        FOREIGN KEY(ui_head_id, session_id, ui_lane)
          REFERENCES transcript_nodes(id, session_id, lane)
      );
      CREATE INDEX history_states_session ON history_states(session_id);
      CREATE INDEX history_states_workspace_snapshot ON history_states(workspace_snapshot_id);
      CREATE INDEX history_transitions_from_state
        ON history_transitions(session_id, from_state_id);
      CREATE INDEX history_transitions_root_run
        ON history_transitions(session_id, root_run_id);
    `);
  }

  private migrateSchemaV5ToV6(): void {
    this.database.exec(`
      CREATE TABLE history_states_v6 (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        model_head_id INTEGER,
        model_lane TEXT NOT NULL DEFAULT 'model' CHECK(model_lane = 'model'),
        ui_head_id INTEGER,
        ui_lane TEXT NOT NULL DEFAULT 'ui' CHECK(ui_lane = 'ui'),
        workspace_snapshot_id TEXT,
        workspace_status TEXT NOT NULL CHECK(
          workspace_status IN ('captured', 'unavailable', 'capture-deferred')
        ),
        workspace_unavailable_reason TEXT CHECK(
          workspace_unavailable_reason IN (
            'git-unavailable', 'capture-failed', 'legacy-migration', 'non-git-workspace',
            'platform-unsupported'
          )
        ),
        origin TEXT NOT NULL CHECK(
          origin IN ('root', 'turn-boundary', 'workspace-observation', 'compaction', 'migration')
        ),
        created_at TEXT NOT NULL,
        UNIQUE(id, session_id),
        UNIQUE(id, workspace_id),
        FOREIGN KEY(session_id, workspace_id)
          REFERENCES sessions(id, workspace_id) ON DELETE CASCADE,
        FOREIGN KEY(workspace_snapshot_id, workspace_id)
          REFERENCES workspace_snapshots(id, workspace_id),
        FOREIGN KEY(model_head_id, session_id, model_lane)
          REFERENCES transcript_nodes(id, session_id, lane),
        FOREIGN KEY(ui_head_id, session_id, ui_lane)
          REFERENCES transcript_nodes(id, session_id, lane),
        CHECK(
          (workspace_status = 'captured' AND workspace_snapshot_id IS NOT NULL
            AND workspace_unavailable_reason IS NULL) OR
          (workspace_status = 'unavailable' AND workspace_snapshot_id IS NULL
            AND workspace_unavailable_reason IS NOT NULL) OR
          (workspace_status = 'capture-deferred' AND workspace_snapshot_id IS NULL
            AND workspace_unavailable_reason IS NULL)
        )
      );
      INSERT INTO history_states_v6 (
        rowid, id, session_id, workspace_id, model_head_id, model_lane, ui_head_id, ui_lane,
        workspace_snapshot_id, workspace_status, workspace_unavailable_reason, origin, created_at
      )
      SELECT
        rowid, id, session_id, workspace_id, model_head_id, model_lane, ui_head_id, ui_lane,
        workspace_snapshot_id, workspace_status, workspace_unavailable_reason, origin, created_at
      FROM history_states;
      DROP TABLE history_states;
      ALTER TABLE history_states_v6 RENAME TO history_states;
      CREATE INDEX history_states_session ON history_states(session_id);
      CREATE INDEX history_states_workspace_snapshot ON history_states(workspace_snapshot_id);

      CREATE TABLE history_operations_v6 (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind = 'navigate'),
        requested_action TEXT NOT NULL CHECK(requested_action IN ('undo', 'redo')),
        source_state_id TEXT NOT NULL,
        observed_source_state_id TEXT,
        target_state_id TEXT NOT NULL,
        user_transition_id TEXT NOT NULL,
        filesystem_mode TEXT NOT NULL CHECK(filesystem_mode IN ('restore', 'skip')),
        skip_reason TEXT CHECK(
          skip_reason IN (
            'git-unavailable', 'non-git-workspace', 'snapshot-unavailable', 'platform-unsupported'
          )
        ),
        phase TEXT NOT NULL CHECK(phase IN ('prepared', 'restoring', 'verified')),
        prepared_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id),
        FOREIGN KEY(session_id, workspace_id) REFERENCES sessions(id, workspace_id),
        FOREIGN KEY(session_id, command_id) REFERENCES commands(session_id, command_id),
        FOREIGN KEY(source_state_id, session_id) REFERENCES history_states(id, session_id),
        FOREIGN KEY(observed_source_state_id, session_id) REFERENCES history_states(id, session_id),
        FOREIGN KEY(target_state_id, session_id) REFERENCES history_states(id, session_id),
        FOREIGN KEY(user_transition_id, session_id)
          REFERENCES history_transitions(id, session_id),
        CHECK(
          (filesystem_mode = 'restore' AND skip_reason IS NULL) OR
          (filesystem_mode = 'skip' AND skip_reason IS NOT NULL)
        )
      );
      INSERT INTO history_operations_v6 (
        rowid, id, session_id, workspace_id, command_id, kind, requested_action, source_state_id,
        observed_source_state_id, target_state_id, user_transition_id, filesystem_mode, skip_reason,
        phase, prepared_at, updated_at
      )
      SELECT
        rowid, id, session_id, workspace_id, command_id, kind, requested_action, source_state_id,
        observed_source_state_id, target_state_id, user_transition_id, filesystem_mode, skip_reason,
        phase, prepared_at, updated_at
      FROM history_operations;
      DROP TABLE history_operations;
      ALTER TABLE history_operations_v6 RENAME TO history_operations;
    `);
  }

  private migrateSchemaV6ToV7(): void {
    this.database.exec(`
      ALTER TABLE history_states ADD COLUMN last_provider_family TEXT
        CHECK(last_provider_family IN ('claude-code', 'ai-sdk'));
      ALTER TABLE history_states ADD COLUMN contains_cross_family_turns INTEGER
        CHECK(
          (last_provider_family IS NULL AND contains_cross_family_turns IS NULL) OR
          (last_provider_family IS NOT NULL AND contains_cross_family_turns IN (0, 1))
        );

      ALTER TABLE pending_run_finalizations ADD COLUMN last_provider_family TEXT
        CHECK(last_provider_family IN ('claude-code', 'ai-sdk'));
      ALTER TABLE pending_run_finalizations ADD COLUMN contains_cross_family_turns INTEGER
        CHECK(
          (last_provider_family IS NULL AND contains_cross_family_turns IS NULL) OR
          (last_provider_family IS NOT NULL AND contains_cross_family_turns IN (0, 1))
        );
      ALTER TABLE pending_run_finalizations ADD COLUMN claude_binding_promotion_json TEXT;

      CREATE TABLE mini_main_claude_bindings (
        session_id TEXT NOT NULL,
        history_state_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        binding_protocol_version INTEGER NOT NULL CHECK(binding_protocol_version = 1),
        provider_family TEXT NOT NULL CHECK(provider_family = 'claude-code'),
        request_client TEXT NOT NULL,
        canonical_message_count INTEGER NOT NULL CHECK(canonical_message_count >= 0),
        execution_scope_hash_version INTEGER NOT NULL CHECK(execution_scope_hash_version = 1),
        execution_scope_hash TEXT NOT NULL,
        claude_session_id TEXT NOT NULL,
        native_cwd TEXT NOT NULL,
        native_last_modified REAL NOT NULL CHECK(native_last_modified >= 0),
        native_context_tokens INTEGER NOT NULL CHECK(native_context_tokens >= 0),
        native_context_max_tokens INTEGER NOT NULL CHECK(native_context_max_tokens > 0),
        last_model_specifier TEXT NOT NULL,
        last_reasoning TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0 AND revision <= 9007199254740991),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(session_id, history_state_id, provider_id),
        UNIQUE(claude_session_id),
        FOREIGN KEY(history_state_id, session_id)
          REFERENCES history_states(id, session_id) ON DELETE CASCADE
      );
      CREATE INDEX mini_main_claude_bindings_state
        ON mini_main_claude_bindings(history_state_id, session_id);

      CREATE TABLE mini_main_claude_attempts (
        id INTEGER PRIMARY KEY,
        product TEXT NOT NULL DEFAULT 'mini' CHECK(product = 'mini'),
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_history_state_id TEXT NOT NULL,
        source_canonical_message_count INTEGER NOT NULL
          CHECK(source_canonical_message_count >= 0),
        provider_id TEXT NOT NULL,
        request_client TEXT NOT NULL,
        execution_scope_hash_version INTEGER NOT NULL CHECK(execution_scope_hash_version = 1),
        execution_scope_hash TEXT NOT NULL,
        request_id TEXT NOT NULL,
        attempt_index INTEGER NOT NULL CHECK(attempt_index >= 0),
        candidate_session_id TEXT NOT NULL UNIQUE,
        source_session_id TEXT,
        expected_binding_revision INTEGER
          CHECK(expected_binding_revision IS NULL OR expected_binding_revision > 0),
        state TEXT NOT NULL
          CHECK(state IN ('active', 'succeeded', 'failed', 'cancelled', 'uncertain')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(session_id, provider_id, request_id, attempt_index),
        FOREIGN KEY(source_history_state_id, session_id)
          REFERENCES history_states(id, session_id) ON DELETE CASCADE,
        CHECK(
          (source_session_id IS NULL AND expected_binding_revision IS NULL) OR
          (source_session_id IS NOT NULL AND expected_binding_revision IS NOT NULL)
        )
      );
      CREATE INDEX mini_main_claude_attempts_owner
        ON mini_main_claude_attempts(session_id, provider_id, updated_at);
    `);
  }

  private migrateSchemaV7ToV8(): void {
    this.database.exec(`
      ALTER TABLE pending_run_finalizations
        ADD COLUMN named_claude_binding_promotion_json TEXT;

      CREATE TABLE mini_named_claude_bindings (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        history_state_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        binding_protocol_version INTEGER NOT NULL CHECK(binding_protocol_version = 1),
        provider_family TEXT NOT NULL CHECK(provider_family = 'claude-code'),
        request_client TEXT NOT NULL,
        canonical_message_count INTEGER NOT NULL CHECK(canonical_message_count >= 0),
        execution_scope_hash_version INTEGER NOT NULL CHECK(execution_scope_hash_version = 1),
        execution_scope_hash TEXT NOT NULL,
        claude_session_id TEXT NOT NULL UNIQUE,
        native_cwd TEXT NOT NULL,
        native_last_modified REAL NOT NULL CHECK(native_last_modified >= 0),
        native_context_tokens INTEGER NOT NULL CHECK(native_context_tokens >= 0),
        native_context_max_tokens INTEGER NOT NULL CHECK(native_context_max_tokens > 0),
        last_model_specifier TEXT NOT NULL,
        last_reasoning TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0 AND revision <= 9007199254740991),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(session_id, provider_id),
        FOREIGN KEY(history_state_id, session_id)
          REFERENCES history_states(id, session_id) ON DELETE CASCADE
      );
      CREATE INDEX mini_named_claude_bindings_state
        ON mini_named_claude_bindings(history_state_id, session_id);

      CREATE TABLE mini_named_claude_attempts (
        id INTEGER PRIMARY KEY,
        product TEXT NOT NULL DEFAULT 'mini' CHECK(product = 'mini'),
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_history_state_id TEXT NOT NULL,
        source_canonical_message_count INTEGER NOT NULL
          CHECK(source_canonical_message_count >= 0),
        provider_id TEXT NOT NULL,
        request_client TEXT NOT NULL,
        execution_scope_hash_version INTEGER NOT NULL CHECK(execution_scope_hash_version = 1),
        execution_scope_hash TEXT NOT NULL,
        request_id TEXT NOT NULL,
        attempt_index INTEGER NOT NULL CHECK(attempt_index >= 0),
        candidate_session_id TEXT NOT NULL UNIQUE,
        source_session_id TEXT,
        expected_binding_revision INTEGER
          CHECK(expected_binding_revision IS NULL OR expected_binding_revision > 0),
        state TEXT NOT NULL
          CHECK(state IN ('active', 'succeeded', 'failed', 'cancelled', 'uncertain')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(session_id, provider_id, request_id, attempt_index),
        FOREIGN KEY(source_history_state_id, session_id)
          REFERENCES history_states(id, session_id) ON DELETE CASCADE,
        CHECK(source_session_id IS NULL OR expected_binding_revision IS NOT NULL)
      );
      CREATE INDEX mini_named_claude_attempts_owner
        ON mini_named_claude_attempts(session_id, provider_id, updated_at);
    `);
  }

  private migrateSchemaV4ToV5(): ResultType<
    void,
    MiniLilacSchemaMigrationFailure | PersistedDataError
  > {
    const existingViolations = this.database.query("PRAGMA foreign_key_check").all();
    if (existingViolations.length > 0) {
      return Result.err(
        new MiniLilacSchemaMigrationFailure({
          operation: "migrateSchemaV4ToV5",
          message: `Mini Lilac v4 database has ${existingViolations.length} structural foreign key violation(s)`,
        }),
      );
    }
    const rehashed = this.rehashTranscriptNodesForMigration();
    const rehashError = rehashed.match({ ok: () => null, err: (error) => error });
    if (rehashError !== null) return Result.err(rehashError);
    const decodedSessions = decodeMiniLilacStoreRows({
      kind: "migration-session",
      rows: this.database.query("SELECT * FROM sessions ORDER BY rowid").all(),
      schemaVersion: 4,
      recordId: "v4-sessions",
    });
    let $decodedSessionsResultValue105674!: import("better-result").InferOk<
      NonNullable<typeof decodedSessions>
    >;
    let $decodedSessionsResultError105674!: import("better-result").InferErr<
      NonNullable<typeof decodedSessions>
    >;
    const $decodedSessionsResultOk105674 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decodedSessions>>,
      import("better-result").InferErr<NonNullable<typeof decodedSessions>>,
      boolean
    >(decodedSessions, {
      ok: (value) => {
        $decodedSessionsResultValue105674 = value;
        return true;
      },
      err: (error) => {
        $decodedSessionsResultError105674 = error;
        return false;
      },
    });
    if (($decodedSessionsResultOk105674 ? "ok" : "error") === "error")
      return Result.err($decodedSessionsResultError105674);
    const sessions = $decodedSessionsResultValue105674.value;
    const now = new Date().toISOString();
    this.database.exec(`
      CREATE TABLE history_store_metadata (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        namespace_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        canonical_cwd TEXT NOT NULL UNIQUE,
        health_status TEXT NOT NULL DEFAULT 'healthy'
          CHECK(health_status IN ('healthy', 'corrupt')),
        health_detail TEXT,
        created_at TEXT NOT NULL
      );
    `);
    this.database
      .query(
        "INSERT INTO history_store_metadata (singleton, namespace_id, created_at) VALUES (1, ?, ?)",
      )
      .run(randomUUID(), now);

    const workspaceIds = new Map<string, string>();
    const insertWorkspace = this.database.query(
      `INSERT INTO workspaces (id, canonical_cwd, created_at) VALUES (?, ?, ?)`,
    );
    for (const session of sessions) {
      const canonicalCwd = canonicalizeStoredCwd(session.cwd);
      if (!workspaceIds.has(canonicalCwd)) {
        const workspaceId = randomUUID();
        workspaceIds.set(canonicalCwd, workspaceId);
        insertWorkspace.run(workspaceId, canonicalCwd, session.created_at);
      }
    }

    this.database.exec(`
      CREATE TABLE sessions_v5 (
        id TEXT PRIMARY KEY,
        active_run_id TEXT,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        cwd TEXT NOT NULL,
        model TEXT NOT NULL,
        profile TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'Mini Lilac',
        input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
        input_tokens_estimated INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens_estimated IN (0, 1)),
        context_window INTEGER CHECK(context_window IS NULL OR context_window > 0),
        status TEXT NOT NULL CHECK(status IN ('idle', 'streaming', 'compacting', 'cancelling', 'error')),
        queued_steering_count INTEGER NOT NULL DEFAULT 0 CHECK(queued_steering_count >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(id, workspace_id)
      );
    `);
    const insertSession = this.database.query(
      `INSERT INTO sessions_v5
        (id, active_run_id, workspace_id, cwd, model, profile, reasoning, title, input_tokens,
         input_tokens_estimated, context_window, status, queued_steering_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const session of sessions) {
      const canonicalCwd = canonicalizeStoredCwd(session.cwd);
      const workspaceId = workspaceIds.get(canonicalCwd);
      if (workspaceId === undefined) {
        return Result.err(
          new MiniLilacSchemaMigrationFailure({
            operation: "migrateSchemaV4ToV5",
            message: `Workspace for '${canonicalCwd}' was not created`,
          }),
        );
      }
      insertSession.run(
        session.id,
        session.active_run_id,
        workspaceId,
        canonicalCwd,
        session.model,
        session.profile,
        session.reasoning,
        session.title,
        session.input_tokens,
        session.input_tokens_estimated,
        session.context_window,
        session.status,
        session.queued_steering_count,
        session.created_at,
        session.updated_at,
      );
    }
    this.database.exec(`
      DROP TABLE sessions;
      ALTER TABLE sessions_v5 RENAME TO sessions;
      CREATE INDEX sessions_workspace ON sessions(workspace_id);

      CREATE TABLE runs_v5 (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        parent_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        profile TEXT NOT NULL,
        depth INTEGER NOT NULL CHECK(depth >= 0),
        status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'cancelled', 'error')),
        error TEXT,
        terminal_result_json TEXT,
        undone_at TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE(id, session_id)
      );
      INSERT INTO runs_v5
        (id, session_id, parent_run_id, profile, depth, status, error, terminal_result_json,
         undone_at, started_at, finished_at)
      SELECT id, session_id, parent_run_id, profile, depth, status, error, terminal_result_json,
             undone_at, started_at, finished_at
      FROM runs;
      DROP TABLE runs;
      ALTER TABLE runs_v5 RENAME TO runs;
      CREATE UNIQUE INDEX one_active_root_run_per_session
        ON runs(session_id) WHERE status = 'active' AND parent_run_id IS NULL;
    `);
    const decodedWorkspaceMismatchCount = decodeRequiredMiniLilacStoreRow({
      kind: "count",
      row: this.database
        .query(
          `SELECT COUNT(*) AS count FROM sessions
             JOIN workspaces ON workspaces.id = sessions.workspace_id
             WHERE sessions.cwd <> workspaces.canonical_cwd`,
        )
        .get(),
      schemaVersion: 4,
      recordId: "v4-workspace-mismatch-count",
    });
    let $decodedWorkspaceMismatchCountResultValue110684!: import("better-result").InferOk<
      NonNullable<typeof decodedWorkspaceMismatchCount>
    >;
    let $decodedWorkspaceMismatchCountResultError110684!: import("better-result").InferErr<
      NonNullable<typeof decodedWorkspaceMismatchCount>
    >;
    const $decodedWorkspaceMismatchCountResultOk110684 = Result.match(
      decodedWorkspaceMismatchCount,
      {
        ok: (value) => {
          $decodedWorkspaceMismatchCountResultValue110684 = value;
          return true;
        },
        err: (error) => {
          $decodedWorkspaceMismatchCountResultError110684 = error;
          return false;
        },
      },
    );
    if (($decodedWorkspaceMismatchCountResultOk110684 ? "ok" : "error") === "error") {
      if (
        $decodedWorkspaceMismatchCountResultError110684._tag === "MiniLilacHistoryRecordMissing"
      ) {
        return Result.err(
          new MiniLilacSchemaMigrationFailure({
            operation: "migrateSchemaV4ToV5",
            message: "Mini Lilac v4 migration workspace mismatch count was not returned",
          }),
        );
      }
      return Result.err($decodedWorkspaceMismatchCountResultError110684);
    }
    const workspaceMismatchCount = $decodedWorkspaceMismatchCountResultValue110684.count;
    if (workspaceMismatchCount > 0) {
      return Result.err(
        new MiniLilacSchemaMigrationFailure({
          operation: "migrateSchemaV4ToV5",
          message: `Mini Lilac v4 migration produced ${workspaceMismatchCount} workspace mismatch(es)`,
        }),
      );
    }
    this.createHistorySchemaTables();
    for (const session of sessions) {
      const migrated = this.migrateSessionHistoryV4(session.id);
      const migrationError = migrated.match({ ok: () => null, err: (error) => error });
      if (migrationError !== null) return Result.err(migrationError);
    }
    this.database.exec("DROP TABLE user_checkpoints;");
    return Result.ok(undefined);
  }

  private rehashTranscriptNodesForMigration(): ResultType<
    void,
    PersistedDataError | MiniLilacSchemaMigrationFailure
  > {
    const decodedRows = decodeMiniLilacMigrationTranscriptRows({
      schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
      recordId: "v4-transcript-migration",
      rows: this.database
        .query(
          `SELECT id, session_id AS sessionId, lane, parent_id AS parentId, depth,
                  value_json AS valueJson, hash
           FROM transcript_nodes ORDER BY session_id, lane, depth, id`,
        )
        .all(),
    });
    let $decodedRowsResultValue112380!: import("better-result").InferOk<
      NonNullable<typeof decodedRows>
    >;
    let $decodedRowsResultError112380!: import("better-result").InferErr<
      NonNullable<typeof decodedRows>
    >;
    const $decodedRowsResultOk112380 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decodedRows>>,
      import("better-result").InferErr<NonNullable<typeof decodedRows>>,
      boolean
    >(decodedRows, {
      ok: (value) => {
        $decodedRowsResultValue112380 = value;
        return true;
      },
      err: (error) => {
        $decodedRowsResultError112380 = error;
        return false;
      },
    });
    if (($decodedRowsResultOk112380 ? "ok" : "error") === "error")
      return Result.err($decodedRowsResultError112380);
    const rows = $decodedRowsResultValue112380.value;
    const migrationNonce = randomUUID();
    const updateHash = this.database.query("UPDATE transcript_nodes SET hash = ? WHERE id = ?");
    for (const row of rows) updateHash.run(`${migrationNonce}:${row.id}`, row.id);

    const migrated = new Map<
      number,
      {
        readonly sessionId: string;
        readonly lane: "model" | "ui";
        readonly depth: number;
        readonly hash: string;
      }
    >();
    for (const row of rows) {
      const parent = row.parentId === null ? null : migrated.get(row.parentId);
      if (
        (row.parentId !== null && parent === undefined) ||
        (parent !== null &&
          parent !== undefined &&
          (parent.sessionId !== row.sessionId ||
            parent.lane !== row.lane ||
            row.depth !== parent.depth + 1)) ||
        (parent === null && row.depth !== 1)
      ) {
        return Result.err(
          new MiniLilacSchemaMigrationFailure({
            operation: "rehashTranscriptNodesForMigration",
            message: `Mini Lilac legacy transcript '${row.sessionId}' lane '${row.lane}' has an invalid parent`,
          }),
        );
      }
      const hash = new Bun.CryptoHasher("sha256")
        .update(parent?.hash ?? "root")
        .update("\0")
        .update(row.valueJson)
        .digest("hex");
      updateHash.run(hash, row.id);
      migrated.set(row.id, {
        sessionId: row.sessionId,
        lane: row.lane,
        depth: row.depth,
        hash,
      });
    }
    return Result.ok(undefined);
  }

  private migrateSessionHistoryV4(
    sessionId: string,
  ): ResultType<void, MiniLilacSchemaMigrationFailure | PersistedDataError> {
    const decodedSession = decodeRequiredMiniLilacStoreRow({
      kind: "migration-history-session",
      row: this.database
        .query(
          `SELECT id, workspace_id, active_run_id, status, created_at, updated_at
             FROM sessions WHERE id = ?`,
        )
        .get(sessionId),
      schemaVersion: 4,
      recordId: sessionId,
    });
    let $decodedSessionResultValue114608!: import("better-result").InferOk<
      NonNullable<typeof decodedSession>
    >;
    let $decodedSessionResultError114608!: import("better-result").InferErr<
      NonNullable<typeof decodedSession>
    >;
    const $decodedSessionResultOk114608 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decodedSession>>,
      import("better-result").InferErr<NonNullable<typeof decodedSession>>,
      boolean
    >(decodedSession, {
      ok: (value) => {
        $decodedSessionResultValue114608 = value;
        return true;
      },
      err: (error) => {
        $decodedSessionResultError114608 = error;
        return false;
      },
    });
    if (($decodedSessionResultOk114608 ? "ok" : "error") === "error") {
      if ($decodedSessionResultError114608._tag === "MiniLilacHistoryRecordMissing") {
        return Result.err(
          new MiniLilacSchemaMigrationFailure({
            operation: "migrateSessionHistoryV4",
            message: `Mini Lilac v4 session '${sessionId}' disappeared during migration`,
          }),
        );
      }
      return Result.err($decodedSessionResultError114608);
    }
    const session = $decodedSessionResultValue114608;
    let currentHeads = this.getTranscriptHeads(sessionId);
    const currentModel = decodeMiniLilacModelTranscript({
      rawValues: this.readSerializedChain(sessionId, "model", currentHeads.model_head_id),
      schemaVersion: 4,
      recordId: sessionId,
    });
    const currentModelError = Result.match(currentModel, {
      ok: () => null,
      err: (error) => error,
    });
    if (currentModelError !== null) return Result.err(currentModelError);
    const decodedCurrentUi = decodeMiniLilacMigrationUiTranscript({
      rawValues: this.readSerializedChain(sessionId, "ui", currentHeads.ui_head_id),
      schemaVersion: 4,
      recordId: sessionId,
    });
    let $decodedCurrentUiResultValue115779!: import("better-result").InferOk<
      NonNullable<typeof decodedCurrentUi>
    >;
    let $decodedCurrentUiResultError115779!: import("better-result").InferErr<
      NonNullable<typeof decodedCurrentUi>
    >;
    const $decodedCurrentUiResultOk115779 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decodedCurrentUi>>,
      import("better-result").InferErr<NonNullable<typeof decodedCurrentUi>>,
      boolean
    >(decodedCurrentUi, {
      ok: (value) => {
        $decodedCurrentUiResultValue115779 = value;
        return true;
      },
      err: (error) => {
        $decodedCurrentUiResultError115779 = error;
        return false;
      },
    });
    if (($decodedCurrentUiResultOk115779 ? "ok" : "error") === "error")
      return Result.err($decodedCurrentUiResultError115779);
    const migratedCurrentUi = $decodedCurrentUiResultValue115779.value;
    const currentUi = migratedCurrentUi.messages;
    if (migratedCurrentUi.changed) {
      const uiHeadId = this.internChain(sessionId, "ui", currentUi, false);
      this.setTranscriptHeads(sessionId, currentHeads.model_head_id, uiHeadId);
      currentHeads = { ...currentHeads, ui_head_id: uiHeadId };
    }
    const decodedCheckpoints = decodeMiniLilacStoreRows({
      kind: "migration-checkpoint",
      rows: this.database
        .query(
          `SELECT session_id, ui_position, user_message_json, model_head_id, ui_head_id,
                    root_run_id, replay_after_seq
             FROM user_checkpoints WHERE session_id = ? ORDER BY ui_position`,
        )
        .all(sessionId),
      schemaVersion: 4,
      recordId: `${sessionId}:checkpoints`,
    });
    let $decodedCheckpointsResultValue116452!: import("better-result").InferOk<
      NonNullable<typeof decodedCheckpoints>
    >;
    let $decodedCheckpointsResultError116452!: import("better-result").InferErr<
      NonNullable<typeof decodedCheckpoints>
    >;
    const $decodedCheckpointsResultOk116452 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decodedCheckpoints>>,
      import("better-result").InferErr<NonNullable<typeof decodedCheckpoints>>,
      boolean
    >(decodedCheckpoints, {
      ok: (value) => {
        $decodedCheckpointsResultValue116452 = value;
        return true;
      },
      err: (error) => {
        $decodedCheckpointsResultError116452 = error;
        return false;
      },
    });
    if (($decodedCheckpointsResultOk116452 ? "ok" : "error") === "error")
      return Result.err($decodedCheckpointsResultError116452);
    const checkpoints = $decodedCheckpointsResultValue116452.value;
    const decodedActiveRootRuns = decodeMiniLilacStoreRows({
      kind: "migration-run",
      rows: this.database
        .query(
          `SELECT id, status, parent_run_id FROM runs
             WHERE session_id = ? AND parent_run_id IS NULL AND status = 'active'`,
        )
        .all(sessionId),
      schemaVersion: 4,
      recordId: `${sessionId}:active-root-runs`,
    });
    let $decodedActiveRootRunsResultValue117065!: import("better-result").InferOk<
      NonNullable<typeof decodedActiveRootRuns>
    >;
    let $decodedActiveRootRunsResultError117065!: import("better-result").InferErr<
      NonNullable<typeof decodedActiveRootRuns>
    >;
    const $decodedActiveRootRunsResultOk117065 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decodedActiveRootRuns>>,
      import("better-result").InferErr<NonNullable<typeof decodedActiveRootRuns>>,
      boolean
    >(decodedActiveRootRuns, {
      ok: (value) => {
        $decodedActiveRootRunsResultValue117065 = value;
        return true;
      },
      err: (error) => {
        $decodedActiveRootRunsResultError117065 = error;
        return false;
      },
    });
    if (($decodedActiveRootRunsResultOk117065 ? "ok" : "error") === "error")
      return Result.err($decodedActiveRootRunsResultError117065);
    const activeRootRuns = $decodedActiveRootRunsResultValue117065.value;
    const hasActiveLifecycle = session.active_run_id !== null;
    if (
      (hasActiveLifecycle &&
        (activeRootRuns.length !== 1 ||
          activeRootRuns[0]?.id !== session.active_run_id ||
          !["streaming", "cancelling"].includes(session.status))) ||
      (!hasActiveLifecycle && activeRootRuns.length > 0) ||
      (!hasActiveLifecycle && ["streaming", "cancelling"].includes(session.status))
    ) {
      return Result.err(
        new MiniLilacSchemaMigrationFailure({
          operation: "migrateSessionHistoryV4",
          message: `Session '${sessionId}' has an invalid active root run during v4 migration`,
        }),
      );
    }

    const parsedCheckpoints: Array<{
      readonly row: z.output<typeof migrationCheckpointRowSchema>;
      readonly run: MiniLilacMigrationRunRowProjection;
      readonly message: MiniLilacUserUIMessage;
      readonly uiPrefix: MiniLilacUIMessage[];
    }> = [];
    for (const checkpoint of checkpoints) {
      const decodedRun = decodeMiniLilacMigrationRunRow({
        row: this.database
          .query("SELECT id, status, parent_run_id FROM runs WHERE id = ? AND session_id = ?")
          .get(checkpoint.root_run_id, sessionId),
        recordId: checkpoint.root_run_id,
      });
      let $decodedRunResultValue118591!: import("better-result").InferOk<
        NonNullable<typeof decodedRun>
      >;
      let $decodedRunResultError118591!: import("better-result").InferErr<
        NonNullable<typeof decodedRun>
      >;
      const $decodedRunResultOk118591 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decodedRun>>,
        import("better-result").InferErr<NonNullable<typeof decodedRun>>,
        boolean
      >(decodedRun, {
        ok: (value) => {
          $decodedRunResultValue118591 = value;
          return true;
        },
        err: (error) => {
          $decodedRunResultError118591 = error;
          return false;
        },
      });
      if (($decodedRunResultOk118591 ? "ok" : "error") === "error")
        return Result.err($decodedRunResultError118591);
      if ($decodedRunResultValue118591.parent_run_id !== null) {
        return Result.err(
          new MiniLilacSchemaMigrationFailure({
            operation: "migrateSessionHistoryV4",
            message: `Checkpoint ${checkpoint.ui_position} for session '${sessionId}' references a child run`,
          }),
        );
      }
      const modelPrefix = decodeMiniLilacModelTranscript({
        rawValues: this.readSerializedChain(sessionId, "model", checkpoint.model_head_id),
        schemaVersion: 4,
        recordId: `${sessionId}:${checkpoint.ui_position}:model`,
      });
      const modelPrefixError = Result.match(modelPrefix, {
        ok: () => null,
        err: (error) => error,
      });
      if (modelPrefixError !== null) return Result.err(modelPrefixError);
      const decodedUiPrefix = decodeMiniLilacMigrationUiTranscript({
        rawValues: this.readSerializedChain(sessionId, "ui", checkpoint.ui_head_id),
        schemaVersion: 4,
        recordId: `${sessionId}:${checkpoint.ui_position}:ui`,
      });
      let $decodedUiPrefixResultValue119606!: import("better-result").InferOk<
        NonNullable<typeof decodedUiPrefix>
      >;
      let $decodedUiPrefixResultError119606!: import("better-result").InferErr<
        NonNullable<typeof decodedUiPrefix>
      >;
      const $decodedUiPrefixResultOk119606 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decodedUiPrefix>>,
        import("better-result").InferErr<NonNullable<typeof decodedUiPrefix>>,
        boolean
      >(decodedUiPrefix, {
        ok: (value) => {
          $decodedUiPrefixResultValue119606 = value;
          return true;
        },
        err: (error) => {
          $decodedUiPrefixResultError119606 = error;
          return false;
        },
      });
      if (($decodedUiPrefixResultOk119606 ? "ok" : "error") === "error")
        return Result.err($decodedUiPrefixResultError119606);
      const migratedUiPrefix = $decodedUiPrefixResultValue119606.value;
      const uiHeadId = migratedUiPrefix.changed
        ? this.internChain(sessionId, "ui", migratedUiPrefix.messages, false)
        : checkpoint.ui_head_id;
      const decodedMessage = decodeMiniLilacMigrationUserUiMessage({
        raw: checkpoint.user_message_json,
        schemaVersion: 4,
        recordId: `${sessionId}:${checkpoint.ui_position}:user`,
      });
      let $decodedMessageResultValue120166!: import("better-result").InferOk<
        NonNullable<typeof decodedMessage>
      >;
      let $decodedMessageResultError120166!: import("better-result").InferErr<
        NonNullable<typeof decodedMessage>
      >;
      const $decodedMessageResultOk120166 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decodedMessage>>,
        import("better-result").InferErr<NonNullable<typeof decodedMessage>>,
        boolean
      >(decodedMessage, {
        ok: (value) => {
          $decodedMessageResultValue120166 = value;
          return true;
        },
        err: (error) => {
          $decodedMessageResultError120166 = error;
          return false;
        },
      });
      if (($decodedMessageResultOk120166 ? "ok" : "error") === "error")
        return Result.err($decodedMessageResultError120166);
      parsedCheckpoints.push({
        row: { ...checkpoint, ui_head_id: uiHeadId },
        run: $decodedRunResultValue118591,
        message: $decodedMessageResultValue120166.value,
        uiPrefix: migratedUiPrefix.messages,
      });
    }
    if (hasActiveLifecycle) {
      const activeCheckpointIndex = parsedCheckpoints.findIndex(
        (checkpoint) => checkpoint.run.id === session.active_run_id,
      );
      const activeCheckpointSuffix = parsedCheckpoints.slice(activeCheckpointIndex);
      if (
        activeCheckpointIndex < 0 ||
        activeCheckpointSuffix.some(
          (checkpoint) =>
            checkpoint.run.id !== session.active_run_id || checkpoint.run.status !== "active",
        ) ||
        parsedCheckpoints
          .slice(0, activeCheckpointIndex)
          .some((checkpoint) => checkpoint.run.status === "active")
      ) {
        return Result.err(
          new MiniLilacSchemaMigrationFailure({
            operation: "migrateSessionHistoryV4",
            message: `Session '${sessionId}' cannot recover its active run from v4 checkpoints`,
          }),
        );
      }
    }

    let orderingIsLinear = true;
    const closedRunIds = new Set<string>();
    let previousRunId: string | null = null;
    for (const [index, checkpoint] of parsedCheckpoints.entries()) {
      if (previousRunId !== null && checkpoint.run.id !== previousRunId) {
        closedRunIds.add(previousRunId);
      }
      if (closedRunIds.has(checkpoint.run.id)) orderingIsLinear = false;
      previousRunId = checkpoint.run.id;
      const next = parsedCheckpoints[index + 1];
      const targetUi = next?.uiPrefix ?? currentUi;
      // V4 did not persist automatic-compaction provenance. Model chains may
      // therefore be replaced between user boundaries; strict UI continuity
      // and the admitted user message are the migration ordering authority.
      if (
        !isCanonicalPrefix(checkpoint.uiPrefix, targetUi) ||
        !canonicalValuesEqual(targetUi[checkpoint.uiPrefix.length], checkpoint.message)
      ) {
        orderingIsLinear = false;
      }
    }

    if (!orderingIsLinear) {
      if (hasActiveLifecycle || !["idle", "error", "compacting"].includes(session.status)) {
        return Result.err(
          new MiniLilacSchemaMigrationFailure({
            operation: "migrateSessionHistoryV4",
            message: `Session '${sessionId}' has unusual checkpoint ordering while its run is active`,
          }),
        );
      }
      console.warn(
        `Mini Lilac v4 history for session '${sessionId}' had unusual checkpoint ordering; ` +
          "preserved its readable transcript as a single migration state with undo disabled",
      );
      this.insertMigratedSingleState(session, currentHeads);
      return Result.ok(undefined);
    }

    if (parsedCheckpoints.length === 0) {
      if (hasActiveLifecycle) {
        return Result.err(
          new MiniLilacSchemaMigrationFailure({
            operation: "migrateSessionHistoryV4",
            message: `Session '${sessionId}' has an active run without a v4 checkpoint`,
          }),
        );
      }
      this.insertMigratedSingleState(session, currentHeads);
      return Result.ok(undefined);
    }

    const stateIds = parsedCheckpoints.map(() => randomUUID());
    for (const [index, checkpoint] of parsedCheckpoints.entries()) {
      const stateId = stateIds[index];
      if (stateId === undefined) {
        return Result.err(
          new MiniLilacSchemaMigrationFailure({
            operation: "migrateSessionHistoryV4",
            message: `Session '${sessionId}' history migration lost checkpoint state ${index}`,
          }),
        );
      }
      this.insertHistoryStateRow({
        id: stateId,
        sessionId,
        workspaceId: session.workspace_id,
        modelHeadId: checkpoint.row.model_head_id,
        uiHeadId: checkpoint.row.ui_head_id,
        workspaceSnapshotId: null,
        workspaceStatus: "unavailable",
        workspaceUnavailableReason: "legacy-migration",
        origin: index === 0 ? "migration" : "turn-boundary",
        createdAt: session.created_at,
      });
    }
    const finalIsOpen = hasActiveLifecycle;
    let finalStateId: string | null = null;
    if (!finalIsOpen) {
      finalStateId = randomUUID();
      this.insertHistoryStateRow({
        id: finalStateId,
        sessionId,
        workspaceId: session.workspace_id,
        modelHeadId: currentHeads.model_head_id,
        uiHeadId: currentHeads.ui_head_id,
        workspaceSnapshotId: null,
        workspaceStatus: "unavailable",
        workspaceUnavailableReason: "legacy-migration",
        origin: "turn-boundary",
        createdAt: session.updated_at,
      });
    }
    const seenRuns = new Set<string>();
    const insertTransition = this.database.query(
      `INSERT INTO history_transitions
        (id, session_id, from_state_id, to_state_id, kind, delivery, command_id,
         user_message_json, root_run_id, replay_after_seq, created_at, completed_at)
       VALUES (?, ?, ?, ?, 'user-message', ?, NULL, ?, ?, ?, ?, ?)`,
    );
    for (const [index, checkpoint] of parsedCheckpoints.entries()) {
      const delivery = seenRuns.has(checkpoint.run.id) ? "steer" : "prompt";
      seenRuns.add(checkpoint.run.id);
      const isLast = index === parsedCheckpoints.length - 1;
      const fromStateId = stateIds[index];
      const toStateId = isLast ? finalStateId : stateIds[index + 1];
      if (fromStateId === undefined || toStateId === undefined) {
        return Result.err(
          new MiniLilacSchemaMigrationFailure({
            operation: "migrateSessionHistoryV4",
            message: `Session '${sessionId}' history migration produced an incomplete edge`,
          }),
        );
      }
      insertTransition.run(
        randomUUID(),
        sessionId,
        fromStateId,
        toStateId,
        delivery,
        serialize(checkpoint.message),
        checkpoint.run.id,
        checkpoint.row.replay_after_seq,
        session.created_at,
        toStateId === null ? null : session.updated_at,
      );
    }
    const rootStateId = stateIds[0];
    const currentStateId = finalIsOpen ? stateIds.at(-1) : finalStateId;
    if (rootStateId === undefined || currentStateId === undefined || currentStateId === null) {
      return Result.err(
        new MiniLilacSchemaMigrationFailure({
          operation: "migrateSessionHistoryV4",
          message: `Session '${sessionId}' history migration did not produce a cursor`,
        }),
      );
    }
    this.database
      .query(
        `INSERT INTO session_history
          (session_id, root_state_id, current_state_id, undo_floor_state_id, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, rootStateId, currentStateId, rootStateId, session.updated_at);
    this.assertStateConnectedToRoot(sessionId, currentStateId);
    return Result.ok(undefined);
  }

  private insertMigratedSingleState(
    session: {
      readonly id: string;
      readonly workspace_id: string;
      readonly updated_at: string;
    },
    heads: z.infer<typeof transcriptHeadRowSchema>,
  ): void {
    const stateId = randomUUID();
    this.insertHistoryStateRow({
      id: stateId,
      sessionId: session.id,
      workspaceId: session.workspace_id,
      modelHeadId: heads.model_head_id,
      uiHeadId: heads.ui_head_id,
      workspaceSnapshotId: null,
      workspaceStatus: "unavailable",
      workspaceUnavailableReason: "legacy-migration",
      origin: "migration",
      createdAt: session.updated_at,
    });
    this.database
      .query(
        `INSERT INTO session_history
          (session_id, root_state_id, current_state_id, undo_floor_state_id, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(session.id, stateId, stateId, stateId, session.updated_at);
  }

  /**
   * Widen the session status CHECK for `compacting` and record whether
   * `input_tokens` is a post-compaction estimate.
   *
   * SQLite cannot alter a CHECK constraint in place, so the table is rebuilt.
   */
  private migrateSchemaV3ToV4(): void {
    this.database.exec(`
      CREATE TABLE sessions_v4 (
        id TEXT PRIMARY KEY,
        active_run_id TEXT,
        cwd TEXT NOT NULL,
        model TEXT NOT NULL,
        profile TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'Mini Lilac',
        input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
        input_tokens_estimated INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens_estimated IN (0, 1)),
        context_window INTEGER CHECK(context_window IS NULL OR context_window > 0),
        status TEXT NOT NULL CHECK(status IN ('idle', 'streaming', 'compacting', 'cancelling', 'error')),
        queued_steering_count INTEGER NOT NULL DEFAULT 0 CHECK(queued_steering_count >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO sessions_v4
        (id, active_run_id, cwd, model, profile, reasoning, title, input_tokens,
         input_tokens_estimated, context_window, status, queued_steering_count, created_at, updated_at)
      SELECT id, active_run_id, cwd, model, profile, reasoning, title, input_tokens,
             0, context_window, status, queued_steering_count, created_at, updated_at
      FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_v4 RENAME TO sessions;
    `);
  }

  private migrateSchemaV2ToV3(): ResultType<void, PersistedDataError> {
    this.database.exec(`
      CREATE TABLE transcript_nodes (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        lane TEXT NOT NULL CHECK(lane IN ('model', 'ui')),
        parent_id INTEGER,
        depth INTEGER NOT NULL CHECK(depth > 0),
        value_json TEXT NOT NULL,
        hash TEXT NOT NULL,
        UNIQUE(session_id, lane, hash),
        UNIQUE(id, session_id, lane),
        FOREIGN KEY(parent_id, session_id, lane)
          REFERENCES transcript_nodes(id, session_id, lane)
      );
      CREATE INDEX transcript_nodes_parent ON transcript_nodes(parent_id);
      CREATE TABLE session_transcript_heads (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        model_head_id INTEGER,
        model_lane TEXT NOT NULL DEFAULT 'model' CHECK(model_lane = 'model'),
        ui_head_id INTEGER,
        ui_lane TEXT NOT NULL DEFAULT 'ui' CHECK(ui_lane = 'ui'),
        FOREIGN KEY(model_head_id, session_id, model_lane)
          REFERENCES transcript_nodes(id, session_id, lane),
        FOREIGN KEY(ui_head_id, session_id, ui_lane)
          REFERENCES transcript_nodes(id, session_id, lane)
      );
      CREATE TABLE user_checkpoints_v3 (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        ui_position INTEGER NOT NULL,
        user_message_json TEXT NOT NULL,
        model_head_id INTEGER,
        model_lane TEXT NOT NULL DEFAULT 'model' CHECK(model_lane = 'model'),
        ui_head_id INTEGER,
        ui_lane TEXT NOT NULL DEFAULT 'ui' CHECK(ui_lane = 'ui'),
        root_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        replay_after_seq INTEGER NOT NULL CHECK(replay_after_seq >= 0),
        PRIMARY KEY(session_id, ui_position),
        FOREIGN KEY(model_head_id, session_id, model_lane)
          REFERENCES transcript_nodes(id, session_id, lane),
        FOREIGN KEY(ui_head_id, session_id, ui_lane)
          REFERENCES transcript_nodes(id, session_id, lane)
      );
    `);

    const decodedSessionIds = decodeMiniLilacStoreRows({
      kind: "id",
      rows: this.database.query("SELECT id FROM sessions ORDER BY rowid").all(),
      schemaVersion: 2,
      recordId: "v2-sessions",
    });
    let $decodedSessionIdsResultValue132013!: import("better-result").InferOk<
      NonNullable<typeof decodedSessionIds>
    >;
    let $decodedSessionIdsResultError132013!: import("better-result").InferErr<
      NonNullable<typeof decodedSessionIds>
    >;
    const $decodedSessionIdsResultOk132013 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decodedSessionIds>>,
      import("better-result").InferErr<NonNullable<typeof decodedSessionIds>>,
      boolean
    >(decodedSessionIds, {
      ok: (value) => {
        $decodedSessionIdsResultValue132013 = value;
        return true;
      },
      err: (error) => {
        $decodedSessionIdsResultError132013 = error;
        return false;
      },
    });
    if (($decodedSessionIdsResultOk132013 ? "ok" : "error") === "error")
      return Result.err($decodedSessionIdsResultError132013);
    const sessionIds = $decodedSessionIdsResultValue132013.value;
    for (const { id: sessionId } of sessionIds) {
      const decodedModelRows = decodeMiniLilacStoreRows({
        kind: "legacy-positioned-json",
        rows: this.database
          .query(
            "SELECT session_id, position, value_json FROM model_transcript WHERE session_id = ? ORDER BY position",
          )
          .all(sessionId),
        schemaVersion: 2,
        recordId: `${sessionId}:model-transcript`,
      });
      let $decodedModelRowsResultValue132428!: import("better-result").InferOk<
        NonNullable<typeof decodedModelRows>
      >;
      let $decodedModelRowsResultError132428!: import("better-result").InferErr<
        NonNullable<typeof decodedModelRows>
      >;
      const $decodedModelRowsResultOk132428 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decodedModelRows>>,
        import("better-result").InferErr<NonNullable<typeof decodedModelRows>>,
        boolean
      >(decodedModelRows, {
        ok: (value) => {
          $decodedModelRowsResultValue132428 = value;
          return true;
        },
        err: (error) => {
          $decodedModelRowsResultError132428 = error;
          return false;
        },
      });
      if (($decodedModelRowsResultOk132428 ? "ok" : "error") === "error")
        return Result.err($decodedModelRowsResultError132428);
      const modelValues = $decodedModelRowsResultValue132428.value.map((row) => row.value_json);
      const decodedUiRows = decodeMiniLilacStoreRows({
        kind: "legacy-positioned-json",
        rows: this.database
          .query(
            "SELECT session_id, position, value_json FROM ui_messages WHERE session_id = ? ORDER BY position",
          )
          .all(sessionId),
        schemaVersion: 2,
        recordId: `${sessionId}:ui-transcript`,
      });
      let $decodedUiRowsResultValue132989!: import("better-result").InferOk<
        NonNullable<typeof decodedUiRows>
      >;
      let $decodedUiRowsResultError132989!: import("better-result").InferErr<
        NonNullable<typeof decodedUiRows>
      >;
      const $decodedUiRowsResultOk132989 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decodedUiRows>>,
        import("better-result").InferErr<NonNullable<typeof decodedUiRows>>,
        boolean
      >(decodedUiRows, {
        ok: (value) => {
          $decodedUiRowsResultValue132989 = value;
          return true;
        },
        err: (error) => {
          $decodedUiRowsResultError132989 = error;
          return false;
        },
      });
      if (($decodedUiRowsResultOk132989 ? "ok" : "error") === "error")
        return Result.err($decodedUiRowsResultError132989);
      const uiValues = $decodedUiRowsResultValue132989.value.map((row) => row.value_json);
      const modelTranscript = decodeMiniLilacModelTranscript({
        rawValues: modelValues,
        schemaVersion: 2,
        recordId: sessionId,
      });
      const modelTranscriptError = Result.match(modelTranscript, {
        ok: () => null,
        err: (error) => error,
      });
      if (modelTranscriptError !== null) return Result.err(modelTranscriptError);
      const decodedUi = decodeMiniLilacMigrationUiTranscript({
        rawValues: uiValues,
        schemaVersion: 2,
        recordId: sessionId,
      });
      let $decodedUiResultValue133775!: import("better-result").InferOk<
        NonNullable<typeof decodedUi>
      >;
      let $decodedUiResultError133775!: import("better-result").InferErr<
        NonNullable<typeof decodedUi>
      >;
      const $decodedUiResultOk133775 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decodedUi>>,
        import("better-result").InferErr<NonNullable<typeof decodedUi>>,
        boolean
      >(decodedUi, {
        ok: (value) => {
          $decodedUiResultValue133775 = value;
          return true;
        },
        err: (error) => {
          $decodedUiResultError133775 = error;
          return false;
        },
      });
      if (($decodedUiResultOk133775 ? "ok" : "error") === "error")
        return Result.err($decodedUiResultError133775);
      const migratedUi = $decodedUiResultValue133775.value;
      const modelHeadId = this.internSerializedChain(sessionId, "model", modelValues);
      const uiHeadId = migratedUi.changed
        ? this.internChain(sessionId, "ui", migratedUi.messages)
        : this.internSerializedChain(sessionId, "ui", uiValues);
      this.setTranscriptHeads(sessionId, modelHeadId, uiHeadId);
    }

    const decodedLegacyCheckpoints = decodeMiniLilacStoreRows({
      kind: "legacy-checkpoint",
      rows: this.database
        .query(
          `SELECT session_id, ui_position, user_message_json, model_prefix_json,
                ui_prefix_json, root_run_id, replay_after_seq
         FROM user_checkpoints ORDER BY session_id, ui_position`,
        )
        .all(),
      schemaVersion: 2,
      recordId: "v2-checkpoints",
    });
    let $decodedLegacyCheckpointsResultValue134385!: import("better-result").InferOk<
      NonNullable<typeof decodedLegacyCheckpoints>
    >;
    let $decodedLegacyCheckpointsResultError134385!: import("better-result").InferErr<
      NonNullable<typeof decodedLegacyCheckpoints>
    >;
    const $decodedLegacyCheckpointsResultOk134385 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decodedLegacyCheckpoints>>,
      import("better-result").InferErr<NonNullable<typeof decodedLegacyCheckpoints>>,
      boolean
    >(decodedLegacyCheckpoints, {
      ok: (value) => {
        $decodedLegacyCheckpointsResultValue134385 = value;
        return true;
      },
      err: (error) => {
        $decodedLegacyCheckpointsResultError134385 = error;
        return false;
      },
    });
    if (($decodedLegacyCheckpointsResultOk134385 ? "ok" : "error") === "error") {
      return Result.err($decodedLegacyCheckpointsResultError134385);
    }
    const checkpoints = $decodedLegacyCheckpointsResultValue134385.value;
    const insertCheckpoint = this.database.query(
      `INSERT INTO user_checkpoints_v3
        (session_id, ui_position, user_message_json, model_head_id, ui_head_id, root_run_id, replay_after_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const checkpoint of checkpoints) {
      const recordId = `${checkpoint.session_id}:${checkpoint.ui_position}`;
      const decodedMessage = decodeMiniLilacMigrationUserUiMessage({
        raw: checkpoint.user_message_json,
        schemaVersion: 2,
        recordId: `${recordId}:user`,
      });
      let $decodedMessageResultValue135373!: import("better-result").InferOk<
        NonNullable<typeof decodedMessage>
      >;
      let $decodedMessageResultError135373!: import("better-result").InferErr<
        NonNullable<typeof decodedMessage>
      >;
      const $decodedMessageResultOk135373 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decodedMessage>>,
        import("better-result").InferErr<NonNullable<typeof decodedMessage>>,
        boolean
      >(decodedMessage, {
        ok: (value) => {
          $decodedMessageResultValue135373 = value;
          return true;
        },
        err: (error) => {
          $decodedMessageResultError135373 = error;
          return false;
        },
      });
      if (($decodedMessageResultOk135373 ? "ok" : "error") === "error")
        return Result.err($decodedMessageResultError135373);
      const decodedModelPrefix = decodeMiniLilacMigrationModelPrefix({
        raw: checkpoint.model_prefix_json,
        schemaVersion: 2,
        recordId: `${recordId}:model`,
      });
      let $decodedModelPrefixResultValue135645!: import("better-result").InferOk<
        NonNullable<typeof decodedModelPrefix>
      >;
      let $decodedModelPrefixResultError135645!: import("better-result").InferErr<
        NonNullable<typeof decodedModelPrefix>
      >;
      const $decodedModelPrefixResultOk135645 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decodedModelPrefix>>,
        import("better-result").InferErr<NonNullable<typeof decodedModelPrefix>>,
        boolean
      >(decodedModelPrefix, {
        ok: (value) => {
          $decodedModelPrefixResultValue135645 = value;
          return true;
        },
        err: (error) => {
          $decodedModelPrefixResultError135645 = error;
          return false;
        },
      });
      if (($decodedModelPrefixResultOk135645 ? "ok" : "error") === "error")
        return Result.err($decodedModelPrefixResultError135645);
      const decodedUiPrefix = decodeMiniLilacMigrationUiPrefix({
        raw: checkpoint.ui_prefix_json,
        schemaVersion: 2,
        recordId: `${recordId}:ui`,
      });
      let $decodedUiPrefixResultValue135928!: import("better-result").InferOk<
        NonNullable<typeof decodedUiPrefix>
      >;
      let $decodedUiPrefixResultError135928!: import("better-result").InferErr<
        NonNullable<typeof decodedUiPrefix>
      >;
      const $decodedUiPrefixResultOk135928 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decodedUiPrefix>>,
        import("better-result").InferErr<NonNullable<typeof decodedUiPrefix>>,
        boolean
      >(decodedUiPrefix, {
        ok: (value) => {
          $decodedUiPrefixResultValue135928 = value;
          return true;
        },
        err: (error) => {
          $decodedUiPrefixResultError135928 = error;
          return false;
        },
      });
      if (($decodedUiPrefixResultOk135928 ? "ok" : "error") === "error")
        return Result.err($decodedUiPrefixResultError135928);
      const message = $decodedMessageResultValue135373.value;
      const modelPrefix = $decodedModelPrefixResultValue135645.value;
      const uiPrefix = $decodedUiPrefixResultValue135928.value.messages;
      const modelHeadId = this.internChain(checkpoint.session_id, "model", modelPrefix);
      const uiHeadId = this.internChain(checkpoint.session_id, "ui", uiPrefix);
      insertCheckpoint.run(
        checkpoint.session_id,
        checkpoint.ui_position,
        serialize(message),
        modelHeadId,
        uiHeadId,
        checkpoint.root_run_id,
        checkpoint.replay_after_seq,
      );
    }

    this.database.exec(`
      DROP TABLE run_chunks;
      DROP TABLE user_checkpoints;
      DROP TABLE model_transcript;
      DROP TABLE ui_messages;
      ALTER TABLE user_checkpoints_v3 RENAME TO user_checkpoints;
    `);
    return Result.ok(undefined);
  }

  close(): void {
    if (this.closed) return;
    if (this.closeBlockers > 0) {
      throw new Error(
        `Cannot close Mini Lilac database while ${this.closeBlockers} runtime task(s) are active`,
      );
    }
    this.database.close();
    this.closed = true;
  }

  acquireCloseBlocker(): () => void {
    if (this.closed) throw new Error("Mini Lilac database is closed");
    this.closeBlockers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.closeBlockers = Math.max(0, this.closeBlockers - 1);
    };
  }

  createSession(input: CreateStoredSession): MiniLilacSessionSnapshot {
    return storeResultToLegacy(this.createSessionResult(input));
  }

  createSessionResult(
    input: CreateStoredSession,
  ): ResultType<MiniLilacSessionSnapshot, MiniLilacStoreOperationError> {
    const now = new Date().toISOString();
    const canonicalCwd = canonicalizeStoredCwd(input.cwd);
    const created = this.runStoreTransactionResult("createSession", () => {
      this.database
        .query(
          `INSERT INTO workspaces (id, canonical_cwd, created_at)
           VALUES (?, ?, ?) ON CONFLICT(canonical_cwd) DO NOTHING`,
        )
        .run(randomUUID(), canonicalCwd, now);
      const decodedWorkspace = this.decodeRequiredStructuralHistoryRow({
        kind: "workspace",
        row: this.database
          .query("SELECT * FROM workspaces WHERE canonical_cwd = ?")
          .get(canonicalCwd),
        recordId: input.id,
      });
      let $decodedWorkspaceResultValue138299!: import("better-result").InferOk<
        NonNullable<typeof decodedWorkspace>
      >;
      let $decodedWorkspaceResultError138299!: import("better-result").InferErr<
        NonNullable<typeof decodedWorkspace>
      >;
      const $decodedWorkspaceResultOk138299 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decodedWorkspace>>,
        import("better-result").InferErr<NonNullable<typeof decodedWorkspace>>,
        boolean
      >(decodedWorkspace, {
        ok: (value) => {
          $decodedWorkspaceResultValue138299 = value;
          return true;
        },
        err: (error) => {
          $decodedWorkspaceResultError138299 = error;
          return false;
        },
      });
      if (($decodedWorkspaceResultOk138299 ? "ok" : "error") === "error")
        return Result.err($decodedWorkspaceResultError138299);
      const workspace = $decodedWorkspaceResultValue138299;
      this.database
        .query(
          `INSERT INTO sessions
            (id, workspace_id, cwd, model, profile, reasoning, title, input_tokens, context_window,
             status, queued_steering_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'Mini Lilac', NULL, ?, 'idle', 0, ?, ?)`,
        )
        .run(
          input.id,
          workspace.id,
          canonicalCwd,
          input.model,
          input.profile,
          input.reasoning,
          input.contextWindow ?? null,
          now,
          now,
        );
      const rootStateId = randomUUID();
      this.insertHistoryStateRow({
        id: rootStateId,
        sessionId: input.id,
        workspaceId: workspace.id,
        modelHeadId: null,
        uiHeadId: null,
        workspaceSnapshotId: null,
        workspaceStatus: "capture-deferred",
        workspaceUnavailableReason: null,
        origin: "root",
        createdAt: now,
      });
      this.database
        .query(
          `INSERT INTO session_history
            (session_id, root_state_id, current_state_id, undo_floor_state_id, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.id, rootStateId, rootStateId, rootStateId, now);
      return Result.ok(undefined);
    });
    const creationError = created.match({ ok: () => null, err: (error) => error });
    if (creationError !== null) return Result.err(creationError);
    return this.getSessionResult(input.id);
  }

  getSession(sessionId: string): MiniLilacSessionSnapshot {
    return storeResultToLegacy(this.getSessionResult(sessionId));
  }

  getSessionResult(
    sessionId: string,
  ): ResultType<MiniLilacSessionSnapshot, MiniLilacPersistenceError> {
    return this.runHistoryReadResult("getSession", () => {
      const row = this.database.query("SELECT * FROM sessions WHERE id = ?").get(sessionId);
      const snapshot = decodeSessionRowSnapshot(row, sessionId);
      let $snapshotResultValue140497!: import("better-result").InferOk<
        NonNullable<typeof snapshot>
      >;
      let $snapshotResultError140497!: import("better-result").InferErr<
        NonNullable<typeof snapshot>
      >;
      const $snapshotResultOk140497 = Result.match<
        import("better-result").InferOk<NonNullable<typeof snapshot>>,
        import("better-result").InferErr<NonNullable<typeof snapshot>>,
        boolean
      >(snapshot, {
        ok: (value) => {
          $snapshotResultValue140497 = value;
          return true;
        },
        err: (error) => {
          $snapshotResultError140497 = error;
          return false;
        },
      });
      if (($snapshotResultOk140497 ? "ok" : "error") === "error")
        return Result.err($snapshotResultError140497);
      const navigation = this.getHistoryNavigationResult(sessionId);
      let $navigationResultValue140636!: import("better-result").InferOk<
        NonNullable<typeof navigation>
      >;
      let $navigationResultError140636!: import("better-result").InferErr<
        NonNullable<typeof navigation>
      >;
      const $navigationResultOk140636 = Result.match<
        import("better-result").InferOk<NonNullable<typeof navigation>>,
        import("better-result").InferErr<NonNullable<typeof navigation>>,
        boolean
      >(navigation, {
        ok: (value) => {
          $navigationResultValue140636 = value;
          return true;
        },
        err: (error) => {
          $navigationResultError140636 = error;
          return false;
        },
      });
      if (($navigationResultOk140636 ? "ok" : "error") === "error")
        return Result.err($navigationResultError140636);
      return Result.ok({
        ...$snapshotResultValue140497,
        historyStateId: $navigationResultValue140636.currentStateId,
        canUndo: $navigationResultValue140636.canUndo,
        canRedo: $navigationResultValue140636.canRedo,
      });
    });
  }

  listSessions(): MiniLilacSessionSnapshot[] {
    const decoded = storeResultToLegacy(
      decodeMiniLilacStoreRows({
        kind: "session",
        rows: this.database.query("SELECT * FROM sessions ORDER BY created_at").all(),
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: "sessions",
      }),
    );
    return decoded.value.map((row) => {
      const snapshot = projectSessionRowSnapshot(row);
      const navigation = this.getHistoryNavigation(snapshot.id);
      return {
        ...snapshot,
        historyStateId: navigation.currentStateId,
        canUndo: navigation.canUndo,
        canRedo: navigation.canRedo,
      };
    });
  }

  updateSessionState(
    sessionId: string,
    status: MiniLilacSessionSnapshot["status"],
    queuedSteeringCount: number,
    activeRunId: string | null = this.getSession(sessionId).activeRunId,
  ): MiniLilacSessionSnapshot {
    this.database
      .query(
        "UPDATE sessions SET status = ?, active_run_id = ?, queued_steering_count = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, activeRunId, queuedSteeringCount, new Date().toISOString(), sessionId);
    return this.getSession(sessionId);
  }

  updateActiveRunInputTokens(
    sessionId: string,
    runId: string,
    inputTokens: number,
  ): MiniLilacSessionSnapshot {
    return storeResultToLegacy(
      this.updateActiveRunInputTokensResult(sessionId, runId, inputTokens),
    );
  }

  updateActiveRunInputTokensResult(
    sessionId: string,
    runId: string,
    inputTokens: number,
  ): ResultType<MiniLilacSessionSnapshot, MiniLilacStoreOperationError> {
    return this.runStoreTransactionResult<MiniLilacSessionSnapshot, MiniLilacStoreOperationError>(
      "updateActiveRunInputTokens",
      () => {
        const updated = this.database
          .query(
            // Reported usage supersedes any post-compaction estimate. The estimate
            // flag has to clear even when the reported count happens to equal the
            // estimate, so a matching count is not treated as "nothing changed".
            `UPDATE sessions SET input_tokens = ?, input_tokens_estimated = 0, updated_at = ?
           WHERE id = ? AND active_run_id = ?
             AND (input_tokens IS NOT ? OR input_tokens_estimated = 1)`,
          )
          .run(inputTokens, new Date().toISOString(), sessionId, runId, inputTokens);
        const snapshot = this.getSessionResult(sessionId);
        let $snapshotResultValue143399!: import("better-result").InferOk<
          NonNullable<typeof snapshot>
        >;
        let $snapshotResultError143399!: import("better-result").InferErr<
          NonNullable<typeof snapshot>
        >;
        const $snapshotResultOk143399 = Result.match<
          import("better-result").InferOk<NonNullable<typeof snapshot>>,
          import("better-result").InferErr<NonNullable<typeof snapshot>>,
          boolean
        >(snapshot, {
          ok: (value) => {
            $snapshotResultValue143399 = value;
            return true;
          },
          err: (error) => {
            $snapshotResultError143399 = error;
            return false;
          },
        });
        if (($snapshotResultOk143399 ? "ok" : "error") === "error")
          return Result.err($snapshotResultError143399);
        if (updated.changes === 0 && $snapshotResultValue143399.activeRunId !== runId) {
          return Result.err(
            new MiniLilacStoreOperationRejected({
              operation: "updateActiveRunInputTokens",
              message: `Run '${runId}' is not active for session '${sessionId}'`,
            }),
          );
        }
        return Result.ok($snapshotResultValue143399);
      },
    );
  }

  updateSessionTitle(
    sessionId: string,
    expectedTitle: string,
    title: string,
  ): MiniLilacSessionSnapshot {
    this.database
      .query("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND title = ?")
      .run(title, new Date().toISOString(), sessionId, expectedTitle);
    return this.getSession(sessionId);
  }

  updateSessionBindings(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
    bindings: StoredSessionBindingUpdate,
  ): MiniLilacSessionSnapshot {
    return storeResultToLegacy(
      this.updateSessionBindingsResult(sessionId, commandId, request, bindings),
    );
  }

  updateSessionBindingsResult(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
    bindings: StoredSessionBindingUpdate,
  ): ResultType<MiniLilacSessionSnapshot, MiniLilacStoreOperationError> {
    const command = decodeCanonicalStoredCommandRequest(request);
    let $commandResultValue144803!: import("better-result").InferOk<NonNullable<typeof command>>;
    let $commandResultError144803!: import("better-result").InferErr<NonNullable<typeof command>>;
    const $commandResultOk144803 = Result.match<
      import("better-result").InferOk<NonNullable<typeof command>>,
      import("better-result").InferErr<NonNullable<typeof command>>,
      boolean
    >(command, {
      ok: (value) => {
        $commandResultValue144803 = value;
        return true;
      },
      err: (error) => {
        $commandResultError144803 = error;
        return false;
      },
    });
    if (($commandResultOk144803 ? "ok" : "error") === "error")
      return Result.err($commandResultError144803);
    return this.runStoreTransactionResult("updateSessionBindings", () => {
      const previous = this.getCommandResultResult(sessionId, commandId, request);
      const decodedPrevious = previous.andThen(decodeStoredSessionSnapshot);
      let $decodedPreviousResultValue145099!: import("better-result").InferOk<
        NonNullable<typeof decodedPrevious>
      >;
      let $decodedPreviousResultError145099!: import("better-result").InferErr<
        NonNullable<typeof decodedPrevious>
      >;
      const $decodedPreviousResultOk145099 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decodedPrevious>>,
        import("better-result").InferErr<NonNullable<typeof decodedPrevious>>,
        boolean
      >(decodedPrevious, {
        ok: (value) => {
          $decodedPreviousResultValue145099 = value;
          return true;
        },
        err: (error) => {
          $decodedPreviousResultError145099 = error;
          return false;
        },
      });
      if (($decodedPreviousResultOk145099 ? "ok" : "error") === "error")
        return Result.err($decodedPreviousResultError145099);
      if ($decodedPreviousResultValue145099 !== undefined)
        return Result.ok($decodedPreviousResultValue145099);
      const snapshot = this.getSessionResult(sessionId);
      let $snapshotResultValue145352!: import("better-result").InferOk<
        NonNullable<typeof snapshot>
      >;
      let $snapshotResultError145352!: import("better-result").InferErr<
        NonNullable<typeof snapshot>
      >;
      const $snapshotResultOk145352 = Result.match<
        import("better-result").InferOk<NonNullable<typeof snapshot>>,
        import("better-result").InferErr<NonNullable<typeof snapshot>>,
        boolean
      >(snapshot, {
        ok: (value) => {
          $snapshotResultValue145352 = value;
          return true;
        },
        err: (error) => {
          $snapshotResultError145352 = error;
          return false;
        },
      });
      if (($snapshotResultOk145352 ? "ok" : "error") === "error")
        return Result.err($snapshotResultError145352);
      const activeRunCount = decodeRequiredMiniLilacStoreRow({
        kind: "count",
        row: this.database
          .query("SELECT COUNT(*) AS count FROM runs WHERE session_id = ? AND status = 'active'")
          .get(sessionId),
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: `${sessionId}:active-run-count`,
      });
      let $activeRunCountResultValue145483!: import("better-result").InferOk<
        NonNullable<typeof activeRunCount>
      >;
      let $activeRunCountResultError145483!: import("better-result").InferErr<
        NonNullable<typeof activeRunCount>
      >;
      const $activeRunCountResultOk145483 = Result.match<
        import("better-result").InferOk<NonNullable<typeof activeRunCount>>,
        import("better-result").InferErr<NonNullable<typeof activeRunCount>>,
        boolean
      >(activeRunCount, {
        ok: (value) => {
          $activeRunCountResultValue145483 = value;
          return true;
        },
        err: (error) => {
          $activeRunCountResultError145483 = error;
          return false;
        },
      });
      if (($activeRunCountResultOk145483 ? "ok" : "error") === "error")
        return Result.err($activeRunCountResultError145483);
      if (
        !["idle", "error"].includes($snapshotResultValue145352.status) ||
        $snapshotResultValue145352.activeRunId !== null ||
        $activeRunCountResultValue145483.count > 0
      ) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "updateSessionBindings",
            message: `Session '${sessionId}' must be quiescent to update bindings`,
          }),
        );
      }

      const now = new Date().toISOString();
      let inputTokensEstimated = 0;
      if (bindings.model === undefined && $snapshotResultValue145352.inputTokensEstimated) {
        inputTokensEstimated = 1;
      }
      this.database
        .query(
          `UPDATE sessions
           SET model = ?, profile = ?, reasoning = ?,
               context_window = ?, input_tokens = ?, input_tokens_estimated = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          bindings.model ?? $snapshotResultValue145352.model,
          bindings.profile ?? $snapshotResultValue145352.profile,
          bindings.reasoning ?? $snapshotResultValue145352.reasoning,
          bindings.model === undefined
            ? ($snapshotResultValue145352.contextWindow ?? null)
            : (bindings.contextWindow ?? null),
          bindings.model === undefined ? ($snapshotResultValue145352.inputTokens ?? null) : null,
          // Clearing the count must clear the flag with it: an estimate marker
          // left on a null count renders as an estimate of nothing.
          inputTokensEstimated,
          now,
          sessionId,
        );
      const result = this.getSessionResult(sessionId);
      let $resultResultValue147419!: import("better-result").InferOk<NonNullable<typeof result>>;
      let $resultResultError147419!: import("better-result").InferErr<NonNullable<typeof result>>;
      const $resultResultOk147419 = Result.match<
        import("better-result").InferOk<NonNullable<typeof result>>,
        import("better-result").InferErr<NonNullable<typeof result>>,
        boolean
      >(result, {
        ok: (value) => {
          $resultResultValue147419 = value;
          return true;
        },
        err: (error) => {
          $resultResultError147419 = error;
          return false;
        },
      });
      if (($resultResultOk147419 ? "ok" : "error") === "error")
        return Result.err($resultResultError147419);
      const serializedResult = serializeStoreValueResult(
        $resultResultValue147419,
        "updateSessionBindings",
      );
      let $serializedResultResultValue147544!: import("better-result").InferOk<
        NonNullable<typeof serializedResult>
      >;
      let $serializedResultResultError147544!: import("better-result").InferErr<
        NonNullable<typeof serializedResult>
      >;
      const $serializedResultResultOk147544 = Result.match<
        import("better-result").InferOk<NonNullable<typeof serializedResult>>,
        import("better-result").InferErr<NonNullable<typeof serializedResult>>,
        boolean
      >(serializedResult, {
        ok: (value) => {
          $serializedResultResultValue147544 = value;
          return true;
        },
        err: (error) => {
          $serializedResultResultError147544 = error;
          return false;
        },
      });
      if (($serializedResultResultOk147544 ? "ok" : "error") === "error")
        return Result.err($serializedResultResultError147544);
      this.database
        .query(
          `INSERT INTO commands
            (session_id, command_id, kind, run_id, request_fingerprint, request_json, side_effect_started, result_json, created_at)
           VALUES (?, ?, ?, NULL, ?, ?, 1, ?, ?)`,
        )
        .run(
          sessionId,
          commandId,
          $commandResultValue144803.kind,
          $commandResultValue144803.fingerprint,
          $commandResultValue144803.json,
          $serializedResultResultValue147544,
          now,
        );
      return Result.ok($resultResultValue147419);
    });
  }

  createRun(input: CreateStoredRun): StoredRun {
    return storeResultToLegacy(this.createRunResult(input));
  }

  createRunResult(input: CreateStoredRun): ResultType<StoredRun, MiniLilacStoreOperationError> {
    if (input.parentRunId === undefined) {
      return Result.err(
        new MiniLilacStoreOperationRejected({
          operation: "createRun",
          message:
            "Root runs must be created through admitRootPromptHistory so their open transition is atomic",
        }),
      );
    }
    const now = new Date().toISOString();
    return this.runStoreTransactionResult("createRun", () => {
      this.database
        .query(
          `INSERT INTO runs
            (id, session_id, parent_run_id, profile, depth, status, started_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(input.id, input.sessionId, input.parentRunId ?? null, input.profile, input.depth, now);
      return this.getRunResult(input.id);
    });
  }

  getRun(runId: string): StoredRun {
    return storeResultToLegacy(this.getRunResult(runId));
  }

  getRunResult(runId: string): ResultType<StoredRun, MiniLilacPersistenceError> {
    return this.runHistoryReadResult("getRun", () => {
      const row = this.database.query("SELECT * FROM runs WHERE id = ?").get(runId);
      return decodeRunRow(row, runId);
    });
  }

  getActiveRootRun(sessionId: string): StoredRun | null {
    const row = this.database
      .query(
        `SELECT runs.* FROM sessions
         JOIN runs ON runs.id = sessions.active_run_id AND runs.session_id = sessions.id
         WHERE sessions.id = ? AND runs.parent_run_id IS NULL AND runs.status = 'active'`,
      )
      .get(sessionId);
    return row ? storeResultToLegacy(decodeRunRow(row, `${sessionId}:active-root`)) : null;
  }

  getLatestSelectedRootRun(sessionId: string): StoredRun | null {
    const row = this.database
      .query(
        `WITH RECURSIVE ancestry(state_id, distance) AS (
           SELECT current_state_id, 0 FROM session_history WHERE session_id = ?
           UNION ALL
           SELECT transition.from_state_id, ancestry.distance + 1
           FROM ancestry
           JOIN history_transitions AS transition
             ON transition.session_id = ? AND transition.to_state_id = ancestry.state_id
         )
         SELECT runs.*
         FROM ancestry
         JOIN history_transitions AS transition
           ON transition.session_id = ? AND transition.to_state_id = ancestry.state_id
              AND transition.kind = 'user-message'
         JOIN runs ON runs.id = transition.root_run_id AND runs.session_id = ?
         WHERE runs.parent_run_id IS NULL
         ORDER BY ancestry.distance
         LIMIT 1`,
      )
      .get(sessionId, sessionId, sessionId, sessionId);
    return row ? storeResultToLegacy(decodeRunRow(row, `${sessionId}:selected-root`)) : null;
  }

  finishRun(
    runId: string,
    status: Exclude<MiniLilacRunStatus, "active">,
    options: { error?: string; terminalResult?: unknown } = {},
  ): void {
    storeResultToLegacy(this.finishRunResult(runId, status, options));
  }

  finishRunResult(
    runId: string,
    status: Exclude<MiniLilacRunStatus, "active">,
    options: { error?: string; terminalResult?: unknown } = {},
  ): ResultType<void, MiniLilacStoreOperationError> {
    const run = this.getRunResult(runId);
    let $runResultValue151575!: import("better-result").InferOk<NonNullable<typeof run>>;
    let $runResultError151575!: import("better-result").InferErr<NonNullable<typeof run>>;
    const $runResultOk151575 = Result.match<
      import("better-result").InferOk<NonNullable<typeof run>>,
      import("better-result").InferErr<NonNullable<typeof run>>,
      boolean
    >(run, {
      ok: (value) => {
        $runResultValue151575 = value;
        return true;
      },
      err: (error) => {
        $runResultError151575 = error;
        return false;
      },
    });
    if (($runResultOk151575 ? "ok" : "error") === "error") return Result.err($runResultError151575);
    if ($runResultValue151575.parentRunId === null) {
      return Result.err(
        new MiniLilacStoreOperationRejected({
          operation: "finishRun",
          message:
            "Root runs must be terminalized through pending finalization so history closes atomically",
        }),
      );
    }
    const terminalResult = serializeOptionalTerminalResult(options, "finishRun");
    let $terminalResultResultValue151976!: import("better-result").InferOk<
      NonNullable<typeof terminalResult>
    >;
    let $terminalResultResultError151976!: import("better-result").InferErr<
      NonNullable<typeof terminalResult>
    >;
    const $terminalResultResultOk151976 = Result.match<
      import("better-result").InferOk<NonNullable<typeof terminalResult>>,
      import("better-result").InferErr<NonNullable<typeof terminalResult>>,
      boolean
    >(terminalResult, {
      ok: (value) => {
        $terminalResultResultValue151976 = value;
        return true;
      },
      err: (error) => {
        $terminalResultResultError151976 = error;
        return false;
      },
    });
    if (($terminalResultResultOk151976 ? "ok" : "error") === "error")
      return Result.err($terminalResultResultError151976);
    return this.runStoreTransactionResult("finishRun", () => {
      this.database
        .query(
          "UPDATE runs SET status = ?, error = ?, terminal_result_json = ?, finished_at = ? WHERE id = ?",
        )
        .run(
          status,
          options.error ?? null,
          $terminalResultResultValue151976,
          new Date().toISOString(),
          runId,
        );
      return Result.ok(undefined);
    });
  }

  getTodos(sessionId: string): MiniLilacTodoState {
    return storeResultToLegacy(this.getTodosResult(sessionId));
  }

  getTodosResult(sessionId: string): ResultType<MiniLilacTodoState, MiniLilacPersistenceError> {
    return readMiniLilacTodos(this.database, sessionId);
  }

  replaceTodosForRun(input: ReplaceTodosForRun): ReplaceTodosForRunResult {
    return storeResultToLegacy(this.replaceTodosForRunResult(input));
  }

  replaceTodosForRunResult(
    input: ReplaceTodosForRun,
  ): ResultType<ReplaceTodosForRunResult, MiniLilacStoreOperationError> {
    if (input.todos.length > 50 || input.todos.some((todo) => todo.content.length > 500)) {
      return Result.err(
        new MiniLilacStoreOperationRejected({
          operation: "replaceTodosForRun",
          message: "Todo list exceeds its persisted size limits",
        }),
      );
    }
    if (input.todos.filter((todo) => todo.status === "in_progress").length > 1) {
      return Result.err(
        new MiniLilacStoreOperationRejected({
          operation: "replaceTodosForRun",
          message: "Todo list may contain at most one in-progress todo",
        }),
      );
    }
    const todosJson = JSON.stringify(canonicalJsonValue(input.todos));

    return this.runStoreTransactionResult<ReplaceTodosForRunResult, MiniLilacStoreOperationError>(
      "replaceTodosForRun",
      () => {
        const activeRun = this.database
          .query(
            `SELECT 1
           FROM sessions
           JOIN runs ON runs.id = ? AND runs.session_id = sessions.id
           WHERE sessions.id = ? AND sessions.active_run_id = runs.id
             AND runs.parent_run_id IS NULL AND runs.status = 'active'`,
          )
          .get(input.runId, input.sessionId);
        if (!activeRun) {
          return Result.err(
            new MiniLilacStoreOperationRejected({
              operation: "replaceTodosForRun",
              message: `Run '${input.runId}' is not active for session '${input.sessionId}'`,
            }),
          );
        }

        const current = this.getTodosResult(input.sessionId);
        let $currentResultValue154544!: import("better-result").InferOk<
          NonNullable<typeof current>
        >;
        let $currentResultError154544!: import("better-result").InferErr<
          NonNullable<typeof current>
        >;
        const $currentResultOk154544 = Result.match<
          import("better-result").InferOk<NonNullable<typeof current>>,
          import("better-result").InferErr<NonNullable<typeof current>>,
          boolean
        >(current, {
          ok: (value) => {
            $currentResultValue154544 = value;
            return true;
          },
          err: (error) => {
            $currentResultError154544 = error;
            return false;
          },
        });
        if (($currentResultOk154544 ? "ok" : "error") === "error")
          return Result.err($currentResultError154544);
        const currentJson = JSON.stringify(canonicalJsonValue($currentResultValue154544.todos));
        if (currentJson === todosJson) return Result.ok({ state: $currentResultValue154544 });
        if ($currentResultValue154544.revision === Number.MAX_SAFE_INTEGER) {
          return Result.err(
            new MiniLilacStoreOperationRejected({
              operation: "replaceTodosForRun",
              message: `Session '${input.sessionId}' todo revision is exhausted`,
            }),
          );
        }

        const now = new Date().toISOString();
        const updatedValue = this.database
          .query(
            `INSERT INTO session_todos (session_id, revision, todos_json, updated_at)
           VALUES (?, 1, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             revision = session_todos.revision + 1,
             todos_json = excluded.todos_json,
             updated_at = excluded.updated_at
           WHERE session_todos.todos_json <> excluded.todos_json
           RETURNING revision, todos_json`,
          )
          .get(input.sessionId, todosJson, now);
        if (!updatedValue) {
          const unchanged = this.getTodosResult(input.sessionId);
          let $unchangedResultValue155781!: import("better-result").InferOk<
            NonNullable<typeof unchanged>
          >;
          let $unchangedResultError155781!: import("better-result").InferErr<
            NonNullable<typeof unchanged>
          >;
          const $unchangedResultOk155781 = Result.match<
            import("better-result").InferOk<NonNullable<typeof unchanged>>,
            import("better-result").InferErr<NonNullable<typeof unchanged>>,
            boolean
          >(unchanged, {
            ok: (value) => {
              $unchangedResultValue155781 = value;
              return true;
            },
            err: (error) => {
              $unchangedResultError155781 = error;
              return false;
            },
          });
          return ($unchangedResultOk155781 ? "ok" : "error") === "error"
            ? Result.err($unchangedResultError155781)
            : Result.ok({ state: $unchangedResultValue155781 });
        }

        const decodedState = decodeMiniLilacTodos({
          row: updatedValue,
          schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
          recordId: input.sessionId,
        });
        let $decodedStateResultValue155997!: import("better-result").InferOk<
          NonNullable<typeof decodedState>
        >;
        let $decodedStateResultError155997!: import("better-result").InferErr<
          NonNullable<typeof decodedState>
        >;
        const $decodedStateResultOk155997 = Result.match<
          import("better-result").InferOk<NonNullable<typeof decodedState>>,
          import("better-result").InferErr<NonNullable<typeof decodedState>>,
          boolean
        >(decodedState, {
          ok: (value) => {
            $decodedStateResultValue155997 = value;
            return true;
          },
          err: (error) => {
            $decodedStateResultError155997 = error;
            return false;
          },
        });
        if (($decodedStateResultOk155997 ? "ok" : "error") === "error")
          return Result.err($decodedStateResultError155997);
        const state = $decodedStateResultValue155997.value;
        this.database
          .query("UPDATE sessions SET updated_at = ? WHERE id = ?")
          .run(now, input.sessionId);
        return Result.ok({ state });
      },
    );
  }

  private runStoreTransaction<T>(operationName: string, operation: () => T): T {
    return storeResultToLegacy(
      this.runStoreTransactionResult(operationName, () => Result.ok(operation())),
    );
  }

  private runStoreTransactionResult<T, E>(
    operationName: string,
    operation: () => ResultType<T, E>,
  ): ResultType<T, E | MiniLilacSqliteDriverFailure> {
    this.transactionDepth += 1;
    try {
      return runBunSqliteTransaction(this.database, operation, (cause) =>
        classifyMiniLilacSqliteDriverFailure(operationName, cause),
      );
    } finally {
      this.transactionDepth -= 1;
      if (this.transactionDepth === 0) this.flushPersistenceDiagnostics();
    }
  }

  private decodeStructuralHistoryRow<K extends MiniLilacStructuralHistoryRecordKind>(input: {
    readonly kind: K;
    readonly row: unknown;
    readonly recordId: string;
  }): ResultType<MiniLilacStructuralHistoryValueFor<K> | null, PersistedDataError> {
    const decoded = decodeMiniLilacStructuralHistoryRow({
      ...input,
      schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
    });
    let $decodedResultValue157462!: import("better-result").InferOk<NonNullable<typeof decoded>>;
    let $decodedResultError157462!: import("better-result").InferErr<NonNullable<typeof decoded>>;
    const $decodedResultOk157462 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decoded>>,
      import("better-result").InferErr<NonNullable<typeof decoded>>,
      boolean
    >(decoded, {
      ok: (value) => {
        $decodedResultValue157462 = value;
        return true;
      },
      err: (error) => {
        $decodedResultError157462 = error;
        return false;
      },
    });
    if (($decodedResultOk157462 ? "ok" : "error") === "error") {
      this.queuePersistenceDiagnostic($decodedResultError157462);
      return Result.err($decodedResultError157462);
    }
    if ($decodedResultValue157462.value === null) return Result.ok(null);
    // The codec preserves the input kind; this bridges that correlation, which
    // TypeScript cannot retain through the generic Extract-based predicate.
    return Result.ok(
      $decodedResultValue157462.value.value as MiniLilacStructuralHistoryValueFor<K>,
    );
  }

  private decodeRequiredStructuralHistoryRow<
    K extends MiniLilacStructuralHistoryRecordKind,
  >(input: {
    readonly kind: K;
    readonly row: unknown;
    readonly recordId: string;
  }): ResultType<
    MiniLilacStructuralHistoryValueFor<K>,
    PersistedDataError | MiniLilacHistoryRecordMissing
  > {
    const decoded = this.decodeStructuralHistoryRow(input);
    let $decodedResultValue158366!: import("better-result").InferOk<NonNullable<typeof decoded>>;
    let $decodedResultError158366!: import("better-result").InferErr<NonNullable<typeof decoded>>;
    const $decodedResultOk158366 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decoded>>,
      import("better-result").InferErr<NonNullable<typeof decoded>>,
      boolean
    >(decoded, {
      ok: (value) => {
        $decodedResultValue158366 = value;
        return true;
      },
      err: (error) => {
        $decodedResultError158366 = error;
        return false;
      },
    });
    if (($decodedResultOk158366 ? "ok" : "error") === "error")
      return Result.err($decodedResultError158366);
    if ($decodedResultValue158366 !== null) return Result.ok($decodedResultValue158366);
    return Result.err(
      new MiniLilacHistoryRecordMissing({
        recordKind: input.kind,
        recordId: input.recordId.slice(0, 128),
        message: `Mini Lilac ${input.kind} record was not found`,
      }),
    );
  }

  private decodeStructuralHistoryRows<K extends MiniLilacStructuralHistoryRecordKind>(input: {
    readonly kind: K;
    readonly rows: readonly unknown[];
    readonly recordId: string;
  }): ResultType<readonly MiniLilacStructuralHistoryValueFor<K>[], PersistedDataError> {
    const decoded = decodeMiniLilacStructuralHistoryRows({
      ...input,
      schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
    });
    let $decodedResultValue159070!: import("better-result").InferOk<NonNullable<typeof decoded>>;
    let $decodedResultError159070!: import("better-result").InferErr<NonNullable<typeof decoded>>;
    const $decodedResultOk159070 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decoded>>,
      import("better-result").InferErr<NonNullable<typeof decoded>>,
      boolean
    >(decoded, {
      ok: (value) => {
        $decodedResultValue159070 = value;
        return true;
      },
      err: (error) => {
        $decodedResultError159070 = error;
        return false;
      },
    });
    if (($decodedResultOk159070 ? "ok" : "error") === "error") {
      this.queuePersistenceDiagnostic($decodedResultError159070);
      return Result.err($decodedResultError159070);
    }
    return Result.ok($decodedResultValue159070.value);
  }

  private runHistoryReadResult<T, E>(
    operationName: string,
    operation: () => ResultType<T, E>,
  ): ResultType<T, E | MiniLilacSqliteDriverFailure> {
    try {
      return operation();
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      if (!(cause instanceof Error)) throw cause;
      const failure = classifyMiniLilacSqliteDriverFailure(operationName, cause);
      if (failure !== undefined) return Result.err(failure);
      throw cause;
    } finally {
      if (this.transactionDepth === 0) this.flushPersistenceDiagnostics();
    }
  }

  private flushPersistenceDiagnostics(): void {
    for (const diagnostic of this.pendingPersistenceDiagnostics.splice(0)) {
      this.onPersistenceDiagnostic(diagnostic);
    }
  }

  private queuePersistenceDiagnostic(error: PersistedDataError): void {
    this.pendingPersistenceDiagnostics.push({
      table: error.table,
      field: error.field,
      version: error.version,
      issueCode: error.issueCode,
      recordId: error.recordId,
      message: error.message,
    });
  }

  getHistoryStoreMetadata(): StoredHistoryStoreMetadata {
    return storeResultToLegacy(this.getHistoryStoreMetadataResult());
  }

  getHistoryStoreMetadataResult(): ResultType<
    StoredHistoryStoreMetadata,
    MiniLilacPersistenceError
  > {
    return this.runHistoryReadResult("getHistoryStoreMetadata", () =>
      this.decodeRequiredStructuralHistoryRow({
        kind: "store-metadata",
        row: this.database
          .query("SELECT namespace_id, created_at FROM history_store_metadata WHERE singleton = 1")
          .get(),
        recordId: "singleton",
      }),
    );
  }

  getWorkspaceForSession(sessionId: string): StoredWorkspace {
    return storeResultToLegacy(this.getWorkspaceForSessionResult(sessionId));
  }

  getWorkspaceForSessionResult(
    sessionId: string,
  ): ResultType<StoredWorkspace, MiniLilacPersistenceError> {
    return this.runHistoryReadResult("getWorkspaceForSession", () =>
      this.decodeRequiredStructuralHistoryRow({
        kind: "workspace",
        row: this.database
          .query(
            `SELECT workspaces.* FROM sessions
             JOIN workspaces ON workspaces.id = sessions.workspace_id
             WHERE sessions.id = ?`,
          )
          .get(sessionId),
        recordId: sessionId,
      }),
    );
  }

  listWorkspaces(): readonly StoredWorkspace[] {
    return storeResultToLegacy(this.listWorkspacesResult());
  }

  listWorkspacesResult(): ResultType<readonly StoredWorkspace[], MiniLilacPersistenceError> {
    return this.runHistoryReadResult("listWorkspaces", () => {
      return this.decodeStructuralHistoryRows({
        kind: "workspace",
        rows: this.database.query("SELECT * FROM workspaces ORDER BY created_at, rowid").all(),
        recordId: "workspace",
      });
    });
  }

  listWorkspaceSnapshots(workspaceId: string): readonly StoredWorkspaceSnapshot[] {
    return storeResultToLegacy(this.listWorkspaceSnapshotsResult(workspaceId));
  }

  listWorkspaceSnapshotsResult(
    workspaceId: string,
  ): ResultType<readonly StoredWorkspaceSnapshot[], MiniLilacPersistenceError> {
    return this.runHistoryReadResult("listWorkspaceSnapshots", () => {
      return this.decodeStructuralHistoryRows({
        kind: "workspace-snapshot",
        rows: this.database
          .query(
            `SELECT * FROM workspace_snapshots
           WHERE workspace_id = ? ORDER BY created_at, rowid`,
          )
          .all(workspaceId),
        recordId: workspaceId,
      });
    });
  }

  listWorkspaceSnapshotGroups(): readonly StoredWorkspaceSnapshotGroup[] {
    return storeResultToLegacy(this.listWorkspaceSnapshotGroupsResult());
  }

  listWorkspaceSnapshotGroupsResult(): ResultType<
    readonly StoredWorkspaceSnapshotGroup[],
    MiniLilacPersistenceError
  > {
    const workspaces = this.listWorkspacesResult();
    let $workspacesResultValue163248!: import("better-result").InferOk<
      NonNullable<typeof workspaces>
    >;
    let $workspacesResultError163248!: import("better-result").InferErr<
      NonNullable<typeof workspaces>
    >;
    const $workspacesResultOk163248 = Result.match<
      import("better-result").InferOk<NonNullable<typeof workspaces>>,
      import("better-result").InferErr<NonNullable<typeof workspaces>>,
      boolean
    >(workspaces, {
      ok: (value) => {
        $workspacesResultValue163248 = value;
        return true;
      },
      err: (error) => {
        $workspacesResultError163248 = error;
        return false;
      },
    });
    if (($workspacesResultOk163248 ? "ok" : "error") === "error")
      return Result.err($workspacesResultError163248);
    const groups: StoredWorkspaceSnapshotGroup[] = [];
    for (const workspace of $workspacesResultValue163248) {
      const snapshots = this.listWorkspaceSnapshotsResult(workspace.id);
      let $snapshotsResultValue163481!: import("better-result").InferOk<
        NonNullable<typeof snapshots>
      >;
      let $snapshotsResultError163481!: import("better-result").InferErr<
        NonNullable<typeof snapshots>
      >;
      const $snapshotsResultOk163481 = Result.match<
        import("better-result").InferOk<NonNullable<typeof snapshots>>,
        import("better-result").InferErr<NonNullable<typeof snapshots>>,
        boolean
      >(snapshots, {
        ok: (value) => {
          $snapshotsResultValue163481 = value;
          return true;
        },
        err: (error) => {
          $snapshotsResultError163481 = error;
          return false;
        },
      });
      if (($snapshotsResultOk163481 ? "ok" : "error") === "error")
        return Result.err($snapshotsResultError163481);
      groups.push({ workspace, snapshots: $snapshotsResultValue163481 });
    }
    return Result.ok(groups);
  }

  setWorkspaceSnapshotAvailability(input: SetStoredWorkspaceSnapshotAvailability): void {
    storeResultToLegacy(this.setWorkspaceSnapshotAvailabilityResult(input));
  }

  setWorkspaceSnapshotAvailabilityResult(
    input: SetStoredWorkspaceSnapshotAvailability,
  ): ResultType<void, MiniLilacStoreOperationError> {
    if (input.workspaceId.length === 0) {
      return Result.err(
        new MiniLilacStoreOperationRejected({
          operation: "setWorkspaceSnapshotAvailability",
          message: "Workspace ID must not be empty",
        }),
      );
    }
    if (
      input.updates.some(
        (update) =>
          update.snapshotId.length === 0 ||
          (update.availability !== "available" && update.detail.length === 0),
      )
    ) {
      return Result.err(
        new MiniLilacStoreOperationRejected({
          operation: "setWorkspaceSnapshotAvailability",
          message: "Workspace snapshot availability update is invalid",
        }),
      );
    }
    const updates = input.updates;
    if (new Set(updates.map((update) => update.snapshotId)).size !== updates.length) {
      return Result.err(
        new MiniLilacStoreOperationRejected({
          operation: "setWorkspaceSnapshotAvailability",
          message: "Workspace snapshot availability updates contain duplicate snapshot IDs",
        }),
      );
    }
    return this.runStoreTransactionResult("setWorkspaceSnapshotAvailability", () => {
      const workspace = this.database
        .query("SELECT 1 FROM workspaces WHERE id = ?")
        .get(input.workspaceId);
      if (!workspace) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "setWorkspaceSnapshotAvailability",
            message: `Workspace '${input.workspaceId}' was not found`,
          }),
        );
      }
      for (const update of updates) {
        const changed = this.database
          .query(
            `UPDATE workspace_snapshots
             SET availability = ?, availability_detail = ?
             WHERE id = ? AND workspace_id = ?`,
          )
          .run(update.availability, update.detail, update.snapshotId, input.workspaceId);
        if (changed.changes !== 1) {
          return Result.err(
            new MiniLilacStoreOperationRejected({
              operation: "setWorkspaceSnapshotAvailability",
              message: `Workspace snapshot '${update.snapshotId}' was not found in workspace '${input.workspaceId}'`,
            }),
          );
        }
      }
      return Result.ok(undefined);
    });
  }

  deleteUnreferencedWorkspaceSnapshots(
    input: DeleteUnreferencedStoredWorkspaceSnapshots,
  ): readonly StoredWorkspaceSnapshot[] {
    return storeResultToLegacy(this.deleteUnreferencedWorkspaceSnapshotsResult(input));
  }

  deleteUnreferencedWorkspaceSnapshotsResult(
    input: DeleteUnreferencedStoredWorkspaceSnapshots,
  ): ResultType<readonly StoredWorkspaceSnapshot[], MiniLilacStoreOperationError> {
    if (input.workspaceId.length === 0) {
      return Result.err(
        new MiniLilacStoreOperationRejected({
          operation: "deleteUnreferencedWorkspaceSnapshots",
          message: "Workspace ID must not be empty",
        }),
      );
    }
    if (input.snapshotIds?.some((snapshotId) => snapshotId.length === 0)) {
      return Result.err(
        new MiniLilacStoreOperationRejected({
          operation: "deleteUnreferencedWorkspaceSnapshots",
          message: "Workspace snapshot deletion contains an invalid snapshot ID",
        }),
      );
    }
    const snapshotIds = input.snapshotIds;
    if (snapshotIds && new Set(snapshotIds).size !== snapshotIds.length) {
      return Result.err(
        new MiniLilacStoreOperationRejected({
          operation: "deleteUnreferencedWorkspaceSnapshots",
          message: "Unreferenced workspace snapshot deletion contains duplicate snapshot IDs",
        }),
      );
    }
    return this.runStoreTransactionResult<
      readonly StoredWorkspaceSnapshot[],
      MiniLilacStoreOperationRejected | MiniLilacPersistenceError
    >("deleteUnreferencedWorkspaceSnapshots", () => {
      const workspace = this.database
        .query("SELECT 1 FROM workspaces WHERE id = ?")
        .get(input.workspaceId);
      if (!workspace) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "deleteUnreferencedWorkspaceSnapshots",
            message: `Workspace '${input.workspaceId}' was not found`,
          }),
        );
      }
      const candidates = this.listWorkspaceSnapshotsResult(input.workspaceId);
      let $candidatesResultValue168258!: import("better-result").InferOk<
        NonNullable<typeof candidates>
      >;
      let $candidatesResultError168258!: import("better-result").InferErr<
        NonNullable<typeof candidates>
      >;
      const $candidatesResultOk168258 = Result.match<
        import("better-result").InferOk<NonNullable<typeof candidates>>,
        import("better-result").InferErr<NonNullable<typeof candidates>>,
        boolean
      >(candidates, {
        ok: (value) => {
          $candidatesResultValue168258 = value;
          return true;
        },
        err: (error) => {
          $candidatesResultError168258 = error;
          return false;
        },
      });
      if (($candidatesResultOk168258 ? "ok" : "error") === "error")
        return Result.err($candidatesResultError168258);
      const selectedCandidates = $candidatesResultValue168258.filter(
        (snapshot) => snapshotIds === undefined || snapshotIds.includes(snapshot.id),
      );
      const deleted: StoredWorkspaceSnapshot[] = [];
      for (const snapshot of selectedCandidates) {
        const result = this.database
          .query(
            `DELETE FROM workspace_snapshots
             WHERE id = ? AND workspace_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM history_states
                 WHERE workspace_snapshot_id = workspace_snapshots.id
                   AND workspace_id = workspace_snapshots.workspace_id
               )`,
          )
          .run(snapshot.id, input.workspaceId);
        if (result.changes === 1) deleted.push(snapshot);
      }
      return Result.ok(deleted);
    });
  }

  assertWorkspaceHistoryAvailable(
    sessionId: string,
    ownerValue?: WorkspaceHistoryAvailabilityOwner,
  ): void {
    const workspace = this.getWorkspaceForSession(sessionId);
    this.assertWorkspaceHistoryAvailableForOwner(workspace.id, sessionId, ownerValue);
  }

  createOrReuseWorkspaceSnapshot(input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly rootTreeOid: string;
    readonly gitRef: string;
    readonly formatVersion: number;
    readonly createdAt?: string;
  }): StoredWorkspaceSnapshot {
    return storeResultToLegacy(this.createOrReuseWorkspaceSnapshotResult(input));
  }

  createOrReuseWorkspaceSnapshotResult(input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly rootTreeOid: string;
    readonly gitRef: string;
    readonly formatVersion: number;
    readonly createdAt?: string;
  }): ResultType<StoredWorkspaceSnapshot, MiniLilacStoreOperationError> {
    if (
      input.id.length === 0 ||
      input.workspaceId.length === 0 ||
      input.rootTreeOid.length === 0 ||
      input.gitRef.length === 0 ||
      !Number.isInteger(input.formatVersion) ||
      input.formatVersion <= 0
    ) {
      return Result.err(
        new MiniLilacStoreOperationRejected({
          operation: "createOrReuseWorkspaceSnapshot",
          message: "Workspace snapshot input is invalid",
        }),
      );
    }
    return this.runStoreTransactionResult("createOrReuseWorkspaceSnapshot", () => {
      this.database
        .query(
          `INSERT INTO workspace_snapshots
            (id, workspace_id, root_tree_oid, git_ref, format_version, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id, root_tree_oid, format_version) DO NOTHING`,
        )
        .run(
          input.id,
          input.workspaceId,
          input.rootTreeOid,
          input.gitRef,
          input.formatVersion,
          input.createdAt ?? new Date().toISOString(),
        );
      this.database
        .query(
          `UPDATE workspace_snapshots
           SET git_ref = ?, availability = 'available', availability_detail = NULL
           WHERE workspace_id = ? AND root_tree_oid = ? AND format_version = ?
             AND (availability <> 'available' OR availability_detail IS NOT NULL)`,
        )
        .run(input.gitRef, input.workspaceId, input.rootTreeOid, input.formatVersion);
      const row = this.database
        .query(
          `SELECT * FROM workspace_snapshots
           WHERE workspace_id = ? AND root_tree_oid = ? AND format_version = ?`,
        )
        .get(input.workspaceId, input.rootTreeOid, input.formatVersion);
      const snapshot = this.decodeRequiredStructuralHistoryRow({
        kind: "workspace-snapshot",
        row,
        recordId: input.id,
      });
      let $snapshotResultValue171884!: import("better-result").InferOk<
        NonNullable<typeof snapshot>
      >;
      let $snapshotResultError171884!: import("better-result").InferErr<
        NonNullable<typeof snapshot>
      >;
      const $snapshotResultOk171884 = Result.match<
        import("better-result").InferOk<NonNullable<typeof snapshot>>,
        import("better-result").InferErr<NonNullable<typeof snapshot>>,
        boolean
      >(snapshot, {
        ok: (value) => {
          $snapshotResultValue171884 = value;
          return true;
        },
        err: (error) => {
          $snapshotResultError171884 = error;
          return false;
        },
      });
      if (($snapshotResultOk171884 ? "ok" : "error") === "error")
        return Result.err($snapshotResultError171884);
      return Result.ok($snapshotResultValue171884);
    });
  }

  getWorkspaceSnapshot(snapshotId: string): StoredWorkspaceSnapshot | null {
    return storeResultToLegacy(this.getWorkspaceSnapshotResult(snapshotId));
  }

  getWorkspaceSnapshotResult(
    snapshotId: string,
  ): ResultType<StoredWorkspaceSnapshot | null, MiniLilacPersistenceError> {
    return this.runHistoryReadResult("getWorkspaceSnapshot", () =>
      this.decodeStructuralHistoryRow({
        kind: "workspace-snapshot",
        row: this.database.query("SELECT * FROM workspace_snapshots WHERE id = ?").get(snapshotId),
        recordId: snapshotId,
      }),
    );
  }

  getHistoryState(stateId: string): StoredHistoryState {
    return storeResultToLegacy(this.getHistoryStateResult(stateId));
  }

  getHistoryStateResult(
    stateId: string,
  ): ResultType<StoredHistoryState, MiniLilacPersistenceError> {
    return this.runHistoryReadResult("getHistoryState", () =>
      this.decodeRequiredStructuralHistoryRow({
        kind: "state",
        row: this.database.query("SELECT * FROM history_states WHERE id = ?").get(stateId),
        recordId: stateId,
      }),
    );
  }

  getHistoryStateModelMessages(stateId: string): ModelMessage[] {
    return storeResultToLegacy(this.getHistoryStateModelMessagesResult(stateId));
  }

  getHistoryStateModelMessagesResult(
    stateId: string,
  ): ResultType<ModelMessage[], MiniLilacPersistenceError> {
    const state = this.getHistoryStateResult(stateId);
    let $stateResultValue173535!: import("better-result").InferOk<NonNullable<typeof state>>;
    let $stateResultError173535!: import("better-result").InferErr<NonNullable<typeof state>>;
    const $stateResultOk173535 = Result.match<
      import("better-result").InferOk<NonNullable<typeof state>>,
      import("better-result").InferErr<NonNullable<typeof state>>,
      boolean
    >(state, {
      ok: (value) => {
        $stateResultValue173535 = value;
        return true;
      },
      err: (error) => {
        $stateResultError173535 = error;
        return false;
      },
    });
    if (($stateResultOk173535 ? "ok" : "error") === "error")
      return Result.err($stateResultError173535);
    return this.runHistoryReadResult("getHistoryStateModelMessages", () => {
      const rawValues = this.readSerializedChainResult(
        $stateResultValue173535.sessionId,
        "model",
        $stateResultValue173535.modelHeadId,
      );
      let $rawValuesResultValue173735!: import("better-result").InferOk<
        NonNullable<typeof rawValues>
      >;
      let $rawValuesResultError173735!: import("better-result").InferErr<
        NonNullable<typeof rawValues>
      >;
      const $rawValuesResultOk173735 = Result.match<
        import("better-result").InferOk<NonNullable<typeof rawValues>>,
        import("better-result").InferErr<NonNullable<typeof rawValues>>,
        boolean
      >(rawValues, {
        ok: (value) => {
          $rawValuesResultValue173735 = value;
          return true;
        },
        err: (error) => {
          $rawValuesResultError173735 = error;
          return false;
        },
      });
      if (($rawValuesResultOk173735 ? "ok" : "error") === "error") {
        this.queuePersistenceDiagnostic($rawValuesResultError173735);
        return Result.err($rawValuesResultError173735);
      }
      const decoded = decodeMiniLilacModelTranscript({
        rawValues: $rawValuesResultValue173735,
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: $stateResultValue173535.id,
      });
      let $decodedResultValue174033!: import("better-result").InferOk<NonNullable<typeof decoded>>;
      let $decodedResultError174033!: import("better-result").InferErr<NonNullable<typeof decoded>>;
      const $decodedResultOk174033 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decoded>>,
        import("better-result").InferErr<NonNullable<typeof decoded>>,
        boolean
      >(decoded, {
        ok: (value) => {
          $decodedResultValue174033 = value;
          return true;
        },
        err: (error) => {
          $decodedResultError174033 = error;
          return false;
        },
      });
      if (($decodedResultOk174033 ? "ok" : "error") === "error") {
        this.queuePersistenceDiagnostic($decodedResultError174033);
        return Result.err($decodedResultError174033);
      }
      return Result.ok($decodedResultValue174033.value);
    });
  }

  getHistoryStateUiMessages(stateId: string): MiniLilacUIMessage[] {
    return storeResultToLegacy(this.getHistoryStateUiMessagesResult(stateId));
  }

  getHistoryStateUiMessagesResult(
    stateId: string,
  ): ResultType<MiniLilacUIMessage[], MiniLilacPersistenceError> {
    const state = this.getHistoryStateResult(stateId);
    let $stateResultValue174705!: import("better-result").InferOk<NonNullable<typeof state>>;
    let $stateResultError174705!: import("better-result").InferErr<NonNullable<typeof state>>;
    const $stateResultOk174705 = Result.match<
      import("better-result").InferOk<NonNullable<typeof state>>,
      import("better-result").InferErr<NonNullable<typeof state>>,
      boolean
    >(state, {
      ok: (value) => {
        $stateResultValue174705 = value;
        return true;
      },
      err: (error) => {
        $stateResultError174705 = error;
        return false;
      },
    });
    if (($stateResultOk174705 ? "ok" : "error") === "error")
      return Result.err($stateResultError174705);
    return this.runHistoryReadResult("getHistoryStateUiMessages", () => {
      const rawValues = this.readSerializedChainResult(
        $stateResultValue174705.sessionId,
        "ui",
        $stateResultValue174705.uiHeadId,
      );
      let $rawValuesResultValue174902!: import("better-result").InferOk<
        NonNullable<typeof rawValues>
      >;
      let $rawValuesResultError174902!: import("better-result").InferErr<
        NonNullable<typeof rawValues>
      >;
      const $rawValuesResultOk174902 = Result.match<
        import("better-result").InferOk<NonNullable<typeof rawValues>>,
        import("better-result").InferErr<NonNullable<typeof rawValues>>,
        boolean
      >(rawValues, {
        ok: (value) => {
          $rawValuesResultValue174902 = value;
          return true;
        },
        err: (error) => {
          $rawValuesResultError174902 = error;
          return false;
        },
      });
      if (($rawValuesResultOk174902 ? "ok" : "error") === "error") {
        this.queuePersistenceDiagnostic($rawValuesResultError174902);
        return Result.err($rawValuesResultError174902);
      }
      const decoded = decodeMiniLilacUiTranscript({
        rawValues: $rawValuesResultValue174902,
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: $stateResultValue174705.id,
      });
      let $decodedResultValue175194!: import("better-result").InferOk<NonNullable<typeof decoded>>;
      let $decodedResultError175194!: import("better-result").InferErr<NonNullable<typeof decoded>>;
      const $decodedResultOk175194 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decoded>>,
        import("better-result").InferErr<NonNullable<typeof decoded>>,
        boolean
      >(decoded, {
        ok: (value) => {
          $decodedResultValue175194 = value;
          return true;
        },
        err: (error) => {
          $decodedResultError175194 = error;
          return false;
        },
      });
      if (($decodedResultOk175194 ? "ok" : "error") === "error") {
        this.queuePersistenceDiagnostic($decodedResultError175194);
        return Result.err($decodedResultError175194);
      }
      return Result.ok($decodedResultValue175194.value);
    });
  }

  getCurrentHistoryState(sessionId: string): StoredHistoryState {
    return storeResultToLegacy(this.getCurrentHistoryStateResult(sessionId));
  }

  getCurrentHistoryStateResult(
    sessionId: string,
  ): ResultType<StoredHistoryState, MiniLilacPersistenceError> {
    return this.runHistoryReadResult("getCurrentHistoryState", () =>
      this.decodeRequiredStructuralHistoryRow({
        kind: "state",
        row: this.database
          .query(
            `SELECT state.* FROM session_history AS history
             JOIN history_states AS state
               ON state.id = history.current_state_id AND state.session_id = history.session_id
             WHERE history.session_id = ?`,
          )
          .get(sessionId),
        recordId: sessionId,
      }),
    );
  }

  getMiniMainClaudeState(inputValue: {
    readonly sessionId: string;
    readonly historyStateId: string;
    readonly providerId: string;
  }): MiniMainClaudeState {
    return storeResultToLegacy(this.getMiniMainClaudeStateResult(inputValue));
  }

  getMiniMainClaudeStateResult(inputValue: {
    readonly sessionId: string;
    readonly historyStateId: string;
    readonly providerId: string;
  }): ResultType<MiniMainClaudeState, MiniLilacStoreOperationError> {
    const input = inputValue;
    return this.runStoreTransactionResult("getMiniMainClaudeState", () => {
      const row = this.database
        .query("SELECT * FROM history_states WHERE id = ? AND session_id = ?")
        .get(input.historyStateId, input.sessionId);
      if (!row) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "getMiniMainClaudeState",
            message: `History state '${input.historyStateId}' does not belong to session '${input.sessionId}'`,
          }),
        );
      }
      const decodedState = this.decodeRequiredStructuralHistoryRow({
        kind: "state",
        row,
        recordId: input.historyStateId,
      });
      let $decodedStateResultValue177402!: import("better-result").InferOk<
        NonNullable<typeof decodedState>
      >;
      let $decodedStateResultError177402!: import("better-result").InferErr<
        NonNullable<typeof decodedState>
      >;
      const $decodedStateResultOk177402 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decodedState>>,
        import("better-result").InferErr<NonNullable<typeof decodedState>>,
        boolean
      >(decodedState, {
        ok: (value) => {
          $decodedStateResultValue177402 = value;
          return true;
        },
        err: (error) => {
          $decodedStateResultError177402 = error;
          return false;
        },
      });
      if (($decodedStateResultOk177402 ? "ok" : "error") === "error")
        return Result.err($decodedStateResultError177402);
      const historyState = $decodedStateResultValue177402;
      const bindingRow = this.database
        .query(
          `SELECT * FROM mini_main_claude_bindings
           WHERE session_id = ? AND history_state_id = ? AND provider_id = ?`,
        )
        .get(input.sessionId, input.historyStateId, input.providerId);
      let binding: MiniMainClaudeSessionBinding | null = null;
      if (bindingRow) {
        const decodedBinding = decodeMiniMainClaudeBindingRow(
          bindingRow,
          `${input.sessionId}:${input.providerId}`,
        );
        let $decodedBindingResultValue178041!: import("better-result").InferOk<
          NonNullable<typeof decodedBinding>
        >;
        let $decodedBindingResultError178041!: import("better-result").InferErr<
          NonNullable<typeof decodedBinding>
        >;
        const $decodedBindingResultOk178041 = Result.match<
          import("better-result").InferOk<NonNullable<typeof decodedBinding>>,
          import("better-result").InferErr<NonNullable<typeof decodedBinding>>,
          boolean
        >(decodedBinding, {
          ok: (value) => {
            $decodedBindingResultValue178041 = value;
            return true;
          },
          err: (error) => {
            $decodedBindingResultError178041 = error;
            return false;
          },
        });
        if (($decodedBindingResultOk178041 ? "ok" : "error") === "error")
          return Result.err($decodedBindingResultError178041);
        binding = $decodedBindingResultValue178041;
      }
      return Result.ok({
        historyState,
        providerState: historyState.providerState,
        binding,
      });
    });
  }

  getMiniMainClaudeSessionAttempt(inputValue: {
    readonly providerId: string;
    readonly lilacSessionId: string;
    readonly requestId: string;
    readonly attemptIndex: number;
  }): MiniMainClaudeSessionAttempt | null {
    return storeResultToLegacy(this.getMiniMainClaudeSessionAttemptResult(inputValue));
  }

  getMiniMainClaudeSessionAttemptResult(inputValue: {
    readonly providerId: string;
    readonly lilacSessionId: string;
    readonly requestId: string;
    readonly attemptIndex: number;
  }): ResultType<MiniMainClaudeSessionAttempt | null, MiniLilacPersistenceError> {
    const input = inputValue;
    return this.runHistoryReadResult("getMiniMainClaudeSessionAttempt", () => {
      const row = this.database
        .query(
          `SELECT * FROM mini_main_claude_attempts
           WHERE session_id = ? AND provider_id = ? AND request_id = ? AND attempt_index = ?`,
        )
        .get(input.lilacSessionId, input.providerId, input.requestId, input.attemptIndex);
      return row
        ? decodeMiniMainClaudeAttemptRow(
            row,
            `${input.lilacSessionId}:${input.providerId}:${input.requestId}:${input.attemptIndex}`,
          )
        : Result.ok(null);
    });
  }

  reserveMiniMainClaudeSessionAttempt(
    inputValue: ReserveMiniMainClaudeSessionAttempt,
  ): MiniMainClaudeSessionAttempt {
    return storeResultToLegacy(this.reserveMiniMainClaudeSessionAttemptResult(inputValue));
  }

  reserveMiniMainClaudeSessionAttemptResult(
    inputValue: ReserveMiniMainClaudeSessionAttempt,
  ): ResultType<MiniMainClaudeSessionAttempt, MiniLilacStoreOperationError> {
    const input = inputValue;
    if ((input.sourceSessionId === null) !== (input.expectedBindingRevision === null)) {
      return Result.err(
        new MiniLilacStoreOperationRejected({
          operation: "reserveMiniMainClaudeSessionAttempt",
          message: "A Claude fork attempt requires both source session and binding revision",
        }),
      );
    }
    return this.runStoreTransactionResult("reserveMiniMainClaudeSessionAttempt", () => {
      const source = this.getMiniMainClaudeStateResult({
        sessionId: input.lilacSessionId,
        historyStateId: input.sourceHistoryStateId,
        providerId: input.providerId,
      });
      let $sourceResultValue180551!: import("better-result").InferOk<NonNullable<typeof source>>;
      let $sourceResultError180551!: import("better-result").InferErr<NonNullable<typeof source>>;
      const $sourceResultOk180551 = Result.match<
        import("better-result").InferOk<NonNullable<typeof source>>,
        import("better-result").InferErr<NonNullable<typeof source>>,
        boolean
      >(source, {
        ok: (value) => {
          $sourceResultValue180551 = value;
          return true;
        },
        err: (error) => {
          $sourceResultError180551 = error;
          return false;
        },
      });
      if (($sourceResultOk180551 ? "ok" : "error") === "error")
        return Result.err($sourceResultError180551);
      if (input.expectedBindingRevision !== null) {
        const binding = $sourceResultValue180551.binding;
        if (
          binding === null ||
          binding.revision !== input.expectedBindingRevision ||
          binding.claudeSessionId !== input.sourceSessionId ||
          binding.requestClient !== input.requestClient ||
          binding.executionScopeHashVersion !== input.executionScopeHashVersion ||
          binding.executionScopeHash !== input.executionScopeHash
        ) {
          return Result.err(
            new MiniLilacStoreOperationRejected({
              operation: "reserveMiniMainClaudeSessionAttempt",
              message: "Claude attempt source binding changed before reservation",
            }),
          );
        }
      }
      const activeCount = decodeRequiredMiniLilacStoreRow({
        kind: "count",
        row: this.database
          .query(
            `SELECT COUNT(*) AS count FROM mini_main_claude_attempts
               WHERE session_id = ? AND provider_id = ? AND state = 'active'`,
          )
          .get(input.lilacSessionId, input.providerId),
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: `${input.lilacSessionId}:${input.providerId}:active-main-attempt-count`,
      });
      let $activeCountResultValue181580!: import("better-result").InferOk<
        NonNullable<typeof activeCount>
      >;
      let $activeCountResultError181580!: import("better-result").InferErr<
        NonNullable<typeof activeCount>
      >;
      const $activeCountResultOk181580 = Result.match<
        import("better-result").InferOk<NonNullable<typeof activeCount>>,
        import("better-result").InferErr<NonNullable<typeof activeCount>>,
        boolean
      >(activeCount, {
        ok: (value) => {
          $activeCountResultValue181580 = value;
          return true;
        },
        err: (error) => {
          $activeCountResultError181580 = error;
          return false;
        },
      });
      if (($activeCountResultOk181580 ? "ok" : "error") === "error")
        return Result.err($activeCountResultError181580);
      if ($activeCountResultValue181580.count >= MINI_MAIN_CLAUDE_ATTEMPT_RETENTION_LIMIT) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "reserveMiniMainClaudeSessionAttempt",
            message: "Too many active Mini main Claude attempts are retained",
          }),
        );
      }
      const now = new Date().toISOString();
      this.database
        .query(
          `INSERT INTO mini_main_claude_attempts
            (product, session_id, source_history_state_id, source_canonical_message_count,
             provider_id, request_client, execution_scope_hash_version, execution_scope_hash,
             request_id, attempt_index, candidate_session_id, source_session_id,
             expected_binding_revision, state, created_at, updated_at)
           VALUES ('mini', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          input.lilacSessionId,
          input.sourceHistoryStateId,
          this.getHistoryStateCanonicalMessageCount(input.sourceHistoryStateId),
          input.providerId,
          input.requestClient,
          input.executionScopeHashVersion,
          input.executionScopeHash,
          input.requestId,
          input.attemptIndex,
          input.candidateSessionId,
          input.sourceSessionId,
          input.expectedBindingRevision,
          now,
          now,
        );
      this.pruneMiniMainClaudeAttempts(input.lilacSessionId, input.providerId);
      const attempt = this.getMiniMainClaudeSessionAttemptResult({
        providerId: input.providerId,
        lilacSessionId: input.lilacSessionId,
        requestId: input.requestId,
        attemptIndex: input.attemptIndex,
      });
      let $attemptResultValue183642!: import("better-result").InferOk<NonNullable<typeof attempt>>;
      let $attemptResultError183642!: import("better-result").InferErr<NonNullable<typeof attempt>>;
      const $attemptResultOk183642 = Result.match<
        import("better-result").InferOk<NonNullable<typeof attempt>>,
        import("better-result").InferErr<NonNullable<typeof attempt>>,
        boolean
      >(attempt, {
        ok: (value) => {
          $attemptResultValue183642 = value;
          return true;
        },
        err: (error) => {
          $attemptResultError183642 = error;
          return false;
        },
      });
      if (($attemptResultOk183642 ? "ok" : "error") === "error")
        return Result.err($attemptResultError183642);
      if ($attemptResultValue183642 === null) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "reserveMiniMainClaudeSessionAttempt",
            message: "Reserved Claude attempt was not retained",
          }),
        );
      }
      return Result.ok($attemptResultValue183642);
    });
  }

  recordMiniMainClaudeSessionAttemptOutcome(
    inputValue: RecordMiniMainClaudeSessionAttemptOutcome,
  ): MiniMainClaudeSessionAttempt {
    return storeResultToLegacy(this.recordMiniMainClaudeSessionAttemptOutcomeResult(inputValue));
  }

  recordMiniMainClaudeSessionAttemptOutcomeResult(
    inputValue: RecordMiniMainClaudeSessionAttemptOutcome,
  ): ResultType<MiniMainClaudeSessionAttempt, MiniLilacStoreOperationError> {
    const input = inputValue;
    return this.runStoreTransactionResult<
      MiniMainClaudeSessionAttempt,
      MiniLilacStoreOperationError
    >("recordMiniMainClaudeSessionAttemptOutcome", () => {
      const attemptKey = {
        providerId: input.providerId,
        lilacSessionId: input.lilacSessionId,
        requestId: input.requestId,
        attemptIndex: input.attemptIndex,
      };
      const current = this.getMiniMainClaudeSessionAttemptResult(attemptKey);
      let $currentResultValue185108!: import("better-result").InferOk<NonNullable<typeof current>>;
      let $currentResultError185108!: import("better-result").InferErr<NonNullable<typeof current>>;
      const $currentResultOk185108 = Result.match<
        import("better-result").InferOk<NonNullable<typeof current>>,
        import("better-result").InferErr<NonNullable<typeof current>>,
        boolean
      >(current, {
        ok: (value) => {
          $currentResultValue185108 = value;
          return true;
        },
        err: (error) => {
          $currentResultError185108 = error;
          return false;
        },
      });
      if (($currentResultOk185108 ? "ok" : "error") === "error")
        return Result.err($currentResultError185108);
      if ($currentResultValue185108 === null) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "recordMiniMainClaudeSessionAttemptOutcome",
            message: `Claude attempt '${input.requestId}' was not found`,
          }),
        );
      }
      if ($currentResultValue185108.state !== "active") {
        if ($currentResultValue185108.state === input.state)
          return Result.ok($currentResultValue185108);
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "recordMiniMainClaudeSessionAttemptOutcome",
            message: `Claude attempt '${input.requestId}' is already terminal as '${$currentResultValue185108.state}'`,
          }),
        );
      }
      const updated = this.database
        .query(
          `UPDATE mini_main_claude_attempts SET state = ?, updated_at = ?
           WHERE session_id = ? AND provider_id = ? AND request_id = ? AND attempt_index = ?
             AND state = 'active'`,
        )
        .run(
          input.state,
          new Date().toISOString(),
          input.lilacSessionId,
          input.providerId,
          input.requestId,
          input.attemptIndex,
        );
      if (updated.changes !== 1) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "recordMiniMainClaudeSessionAttemptOutcome",
            message: "Claude attempt outcome lost its active fence",
          }),
        );
      }
      this.pruneMiniMainClaudeAttempts(input.lilacSessionId, input.providerId);
      const attempt = this.getMiniMainClaudeSessionAttemptResult(attemptKey);
      let $attemptResultValue186782!: import("better-result").InferOk<NonNullable<typeof attempt>>;
      let $attemptResultError186782!: import("better-result").InferErr<NonNullable<typeof attempt>>;
      const $attemptResultOk186782 = Result.match<
        import("better-result").InferOk<NonNullable<typeof attempt>>,
        import("better-result").InferErr<NonNullable<typeof attempt>>,
        boolean
      >(attempt, {
        ok: (value) => {
          $attemptResultValue186782 = value;
          return true;
        },
        err: (error) => {
          $attemptResultError186782 = error;
          return false;
        },
      });
      if (($attemptResultOk186782 ? "ok" : "error") === "error")
        return Result.err($attemptResultError186782);
      if ($attemptResultValue186782 === null) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "recordMiniMainClaudeSessionAttemptOutcome",
            message: "Updated Claude attempt exceeded retention immediately",
          }),
        );
      }
      return Result.ok($attemptResultValue186782);
    });
  }

  getMiniNamedClaudeState(inputValue: {
    readonly sessionId: string;
    readonly providerId: string;
  }): MiniNamedClaudeState {
    return storeResultToLegacy(this.getMiniNamedClaudeStateResult(inputValue));
  }

  getMiniNamedClaudeStateResult(inputValue: {
    readonly sessionId: string;
    readonly providerId: string;
  }): ResultType<MiniNamedClaudeState, MiniLilacStoreOperationError> {
    const input = inputValue;
    return this.runHistoryReadResult("getMiniNamedClaudeState", () => {
      const session = this.database
        .query("SELECT 1 FROM sessions WHERE id = ?")
        .get(input.sessionId);
      if (!session) {
        return Result.err(
          new MiniLilacHistoryRecordMissing({
            recordKind: "session",
            recordId: input.sessionId,
            message: `Session '${input.sessionId}' was not found`,
          }),
        );
      }
      const row = this.database
        .query(
          `SELECT * FROM mini_named_claude_bindings
           WHERE session_id = ? AND provider_id = ?`,
        )
        .get(input.sessionId, input.providerId);
      if (!row) return Result.ok({ binding: null });
      const binding = decodeMiniMainClaudeBindingRow(row, `${input.sessionId}:${input.providerId}`);
      let $bindingResultValue188433!: import("better-result").InferOk<NonNullable<typeof binding>>;
      let $bindingResultError188433!: import("better-result").InferErr<NonNullable<typeof binding>>;
      const $bindingResultOk188433 = Result.match<
        import("better-result").InferOk<NonNullable<typeof binding>>,
        import("better-result").InferErr<NonNullable<typeof binding>>,
        boolean
      >(binding, {
        ok: (value) => {
          $bindingResultValue188433 = value;
          return true;
        },
        err: (error) => {
          $bindingResultError188433 = error;
          return false;
        },
      });
      return ($bindingResultOk188433 ? "ok" : "error") === "error"
        ? Result.err($bindingResultError188433)
        : Result.ok({ binding: $bindingResultValue188433 });
    });
  }

  getMiniNamedClaudeSessionAttempt(inputValue: {
    readonly providerId: string;
    readonly lilacSessionId: string;
    readonly requestId: string;
    readonly attemptIndex: number;
  }): MiniNamedClaudeSessionAttempt | null {
    return storeResultToLegacy(this.getMiniNamedClaudeSessionAttemptResult(inputValue));
  }

  getMiniNamedClaudeSessionAttemptResult(inputValue: {
    readonly providerId: string;
    readonly lilacSessionId: string;
    readonly requestId: string;
    readonly attemptIndex: number;
  }): ResultType<MiniNamedClaudeSessionAttempt | null, MiniLilacPersistenceError> {
    const input = inputValue;
    return this.runHistoryReadResult("getMiniNamedClaudeSessionAttempt", () => {
      const row = this.database
        .query(
          `SELECT * FROM mini_named_claude_attempts
           WHERE session_id = ? AND provider_id = ? AND request_id = ? AND attempt_index = ?`,
        )
        .get(input.lilacSessionId, input.providerId, input.requestId, input.attemptIndex);
      return row
        ? decodeMiniMainClaudeAttemptRow(
            row,
            `${input.lilacSessionId}:${input.providerId}:${input.requestId}:${input.attemptIndex}`,
          )
        : Result.ok(null);
    });
  }

  getMiniClaudeRetentionDiagnostics(): MiniClaudeRetentionDiagnostics {
    return storeResultToLegacy(this.getMiniClaudeRetentionDiagnosticsResult());
  }

  getMiniClaudeRetentionDiagnosticsResult(): ResultType<
    MiniClaudeRetentionDiagnostics,
    MiniLilacPersistenceError
  > {
    return this.runHistoryReadResult("getMiniClaudeRetentionDiagnostics", () => {
      const count = (sql: string, recordId: string) =>
        decodeRequiredMiniLilacStoreRow({
          kind: "count",
          row: this.database.query(sql).get(),
          schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
          recordId,
        });
      const mainBindingCount = count(
        "SELECT COUNT(*) AS count FROM mini_main_claude_bindings",
        "main-binding-count",
      );
      let $mainBindingCountResultValue190538!: import("better-result").InferOk<
        NonNullable<typeof mainBindingCount>
      >;
      let $mainBindingCountResultError190538!: import("better-result").InferErr<
        NonNullable<typeof mainBindingCount>
      >;
      const $mainBindingCountResultOk190538 = Result.match<
        import("better-result").InferOk<NonNullable<typeof mainBindingCount>>,
        import("better-result").InferErr<NonNullable<typeof mainBindingCount>>,
        boolean
      >(mainBindingCount, {
        ok: (value) => {
          $mainBindingCountResultValue190538 = value;
          return true;
        },
        err: (error) => {
          $mainBindingCountResultError190538 = error;
          return false;
        },
      });
      if (($mainBindingCountResultOk190538 ? "ok" : "error") === "error")
        return Result.err($mainBindingCountResultError190538);
      const namedBindingCount = count(
        "SELECT COUNT(*) AS count FROM mini_named_claude_bindings",
        "named-binding-count",
      );
      let $namedBindingCountResultValue190772!: import("better-result").InferOk<
        NonNullable<typeof namedBindingCount>
      >;
      let $namedBindingCountResultError190772!: import("better-result").InferErr<
        NonNullable<typeof namedBindingCount>
      >;
      const $namedBindingCountResultOk190772 = Result.match<
        import("better-result").InferOk<NonNullable<typeof namedBindingCount>>,
        import("better-result").InferErr<NonNullable<typeof namedBindingCount>>,
        boolean
      >(namedBindingCount, {
        ok: (value) => {
          $namedBindingCountResultValue190772 = value;
          return true;
        },
        err: (error) => {
          $namedBindingCountResultError190772 = error;
          return false;
        },
      });
      if (($namedBindingCountResultOk190772 ? "ok" : "error") === "error")
        return Result.err($namedBindingCountResultError190772);
      const activeAttemptCount = count(
        `SELECT
           (SELECT COUNT(*) FROM mini_main_claude_attempts WHERE state = 'active') +
           (SELECT COUNT(*) FROM mini_named_claude_attempts WHERE state = 'active') AS count`,
        "active-attempt-count",
      );
      let $activeAttemptCountResultValue191011!: import("better-result").InferOk<
        NonNullable<typeof activeAttemptCount>
      >;
      let $activeAttemptCountResultError191011!: import("better-result").InferErr<
        NonNullable<typeof activeAttemptCount>
      >;
      const $activeAttemptCountResultOk191011 = Result.match<
        import("better-result").InferOk<NonNullable<typeof activeAttemptCount>>,
        import("better-result").InferErr<NonNullable<typeof activeAttemptCount>>,
        boolean
      >(activeAttemptCount, {
        ok: (value) => {
          $activeAttemptCountResultValue191011 = value;
          return true;
        },
        err: (error) => {
          $activeAttemptCountResultError191011 = error;
          return false;
        },
      });
      if (($activeAttemptCountResultOk191011 ? "ok" : "error") === "error")
        return Result.err($activeAttemptCountResultError191011);
      const terminalAttemptCount = count(
        `SELECT
           (SELECT COUNT(*) FROM mini_main_claude_attempts WHERE state <> 'active') +
           (SELECT COUNT(*) FROM mini_named_claude_attempts WHERE state <> 'active') AS count`,
        "terminal-attempt-count",
      );
      let $terminalAttemptCountResultValue191382!: import("better-result").InferOk<
        NonNullable<typeof terminalAttemptCount>
      >;
      let $terminalAttemptCountResultError191382!: import("better-result").InferErr<
        NonNullable<typeof terminalAttemptCount>
      >;
      const $terminalAttemptCountResultOk191382 = Result.match<
        import("better-result").InferOk<NonNullable<typeof terminalAttemptCount>>,
        import("better-result").InferErr<NonNullable<typeof terminalAttemptCount>>,
        boolean
      >(terminalAttemptCount, {
        ok: (value) => {
          $terminalAttemptCountResultValue191382 = value;
          return true;
        },
        err: (error) => {
          $terminalAttemptCountResultError191382 = error;
          return false;
        },
      });
      if (($terminalAttemptCountResultOk191382 ? "ok" : "error") === "error")
        return Result.err($terminalAttemptCountResultError191382);
      const orphanBindingCount = count(
        `SELECT
           (SELECT COUNT(*) FROM mini_main_claude_bindings AS binding
            LEFT JOIN history_states AS state
              ON state.id = binding.history_state_id AND state.session_id = binding.session_id
            WHERE state.id IS NULL) +
           (SELECT COUNT(*) FROM mini_named_claude_bindings AS binding
             LEFT JOIN history_states AS state
               ON state.id = binding.history_state_id AND state.session_id = binding.session_id
             WHERE state.id IS NULL) AS count`,
        "orphan-binding-count",
      );
      let $orphanBindingCountResultValue191763!: import("better-result").InferOk<
        NonNullable<typeof orphanBindingCount>
      >;
      let $orphanBindingCountResultError191763!: import("better-result").InferErr<
        NonNullable<typeof orphanBindingCount>
      >;
      const $orphanBindingCountResultOk191763 = Result.match<
        import("better-result").InferOk<NonNullable<typeof orphanBindingCount>>,
        import("better-result").InferErr<NonNullable<typeof orphanBindingCount>>,
        boolean
      >(orphanBindingCount, {
        ok: (value) => {
          $orphanBindingCountResultValue191763 = value;
          return true;
        },
        err: (error) => {
          $orphanBindingCountResultError191763 = error;
          return false;
        },
      });
      if (($orphanBindingCountResultOk191763 ? "ok" : "error") === "error")
        return Result.err($orphanBindingCountResultError191763);
      const orphanAttemptCount = count(
        `SELECT
           (SELECT COUNT(*) FROM mini_main_claude_attempts AS attempt
            LEFT JOIN history_states AS state
              ON state.id = attempt.source_history_state_id AND state.session_id = attempt.session_id
            WHERE state.id IS NULL) +
           (SELECT COUNT(*) FROM mini_named_claude_attempts AS attempt
             LEFT JOIN history_states AS state
               ON state.id = attempt.source_history_state_id AND state.session_id = attempt.session_id
             WHERE state.id IS NULL) AS count`,
        "orphan-attempt-count",
      );
      let $orphanAttemptCountResultValue192465!: import("better-result").InferOk<
        NonNullable<typeof orphanAttemptCount>
      >;
      let $orphanAttemptCountResultError192465!: import("better-result").InferErr<
        NonNullable<typeof orphanAttemptCount>
      >;
      const $orphanAttemptCountResultOk192465 = Result.match<
        import("better-result").InferOk<NonNullable<typeof orphanAttemptCount>>,
        import("better-result").InferErr<NonNullable<typeof orphanAttemptCount>>,
        boolean
      >(orphanAttemptCount, {
        ok: (value) => {
          $orphanAttemptCountResultValue192465 = value;
          return true;
        },
        err: (error) => {
          $orphanAttemptCountResultError192465 = error;
          return false;
        },
      });
      if (($orphanAttemptCountResultOk192465 ? "ok" : "error") === "error")
        return Result.err($orphanAttemptCountResultError192465);
      return Result.ok({
        mainBindingCount: $mainBindingCountResultValue190538.count,
        namedBindingCount: $namedBindingCountResultValue190772.count,
        activeAttemptCount: $activeAttemptCountResultValue191011.count,
        terminalAttemptCount: $terminalAttemptCountResultValue191382.count,
        orphanBindingCount: $orphanBindingCountResultValue191763.count,
        orphanAttemptCount: $orphanAttemptCountResultValue192465.count,
      });
    });
  }

  reserveMiniNamedClaudeSessionAttempt(
    inputValue: ReserveMiniNamedClaudeSessionAttempt,
  ): MiniNamedClaudeSessionAttempt {
    return storeResultToLegacy(this.reserveMiniNamedClaudeSessionAttemptResult(inputValue));
  }

  reserveMiniNamedClaudeSessionAttemptResult(
    inputValue: ReserveMiniNamedClaudeSessionAttempt,
  ): ResultType<MiniNamedClaudeSessionAttempt, MiniLilacStoreOperationError> {
    const input = inputValue;
    return this.runStoreTransactionResult("reserveMiniNamedClaudeSessionAttempt", () => {
      const source = this.getHistoryStateResult(input.sourceHistoryStateId);
      let $sourceResultValue194115!: import("better-result").InferOk<NonNullable<typeof source>>;
      let $sourceResultError194115!: import("better-result").InferErr<NonNullable<typeof source>>;
      const $sourceResultOk194115 = Result.match<
        import("better-result").InferOk<NonNullable<typeof source>>,
        import("better-result").InferErr<NonNullable<typeof source>>,
        boolean
      >(source, {
        ok: (value) => {
          $sourceResultValue194115 = value;
          return true;
        },
        err: (error) => {
          $sourceResultError194115 = error;
          return false;
        },
      });
      if (($sourceResultOk194115 ? "ok" : "error") === "error")
        return Result.err($sourceResultError194115);
      if ($sourceResultValue194115.sessionId !== input.lilacSessionId) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "reserveMiniNamedClaudeSessionAttempt",
            message: `History state '${input.sourceHistoryStateId}' does not belong to session '${input.lilacSessionId}'`,
          }),
        );
      }
      const namedState = this.getMiniNamedClaudeStateResult({
        sessionId: input.lilacSessionId,
        providerId: input.providerId,
      });
      let $namedStateResultValue194617!: import("better-result").InferOk<
        NonNullable<typeof namedState>
      >;
      let $namedStateResultError194617!: import("better-result").InferErr<
        NonNullable<typeof namedState>
      >;
      const $namedStateResultOk194617 = Result.match<
        import("better-result").InferOk<NonNullable<typeof namedState>>,
        import("better-result").InferErr<NonNullable<typeof namedState>>,
        boolean
      >(namedState, {
        ok: (value) => {
          $namedStateResultValue194617 = value;
          return true;
        },
        err: (error) => {
          $namedStateResultError194617 = error;
          return false;
        },
      });
      if (($namedStateResultOk194617 ? "ok" : "error") === "error")
        return Result.err($namedStateResultError194617);
      const binding = $namedStateResultValue194617.binding;
      if (input.expectedBindingRevision === null) {
        if (binding !== null) {
          return Result.err(
            new MiniLilacStoreOperationRejected({
              operation: "reserveMiniNamedClaudeSessionAttempt",
              message: "Named Claude attempt source binding changed before reservation",
            }),
          );
        }
      } else if (
        binding === null ||
        binding.revision !== input.expectedBindingRevision ||
        binding.requestClient !== input.requestClient ||
        (input.sourceSessionId !== null &&
          (binding.claudeSessionId !== input.sourceSessionId ||
            binding.historyStateId !== input.sourceHistoryStateId ||
            binding.executionScopeHashVersion !== input.executionScopeHashVersion ||
            binding.executionScopeHash !== input.executionScopeHash))
      ) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "reserveMiniNamedClaudeSessionAttempt",
            message: "Named Claude attempt source binding changed before reservation",
          }),
        );
      }
      const activeCount = decodeRequiredMiniLilacStoreRow({
        kind: "count",
        row: this.database
          .query(
            `SELECT COUNT(*) AS count FROM mini_named_claude_attempts
               WHERE session_id = ? AND provider_id = ? AND state = 'active'`,
          )
          .get(input.lilacSessionId, input.providerId),
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: `${input.lilacSessionId}:${input.providerId}:active-named-attempt-count`,
      });
      let $activeCountResultValue196014!: import("better-result").InferOk<
        NonNullable<typeof activeCount>
      >;
      let $activeCountResultError196014!: import("better-result").InferErr<
        NonNullable<typeof activeCount>
      >;
      const $activeCountResultOk196014 = Result.match<
        import("better-result").InferOk<NonNullable<typeof activeCount>>,
        import("better-result").InferErr<NonNullable<typeof activeCount>>,
        boolean
      >(activeCount, {
        ok: (value) => {
          $activeCountResultValue196014 = value;
          return true;
        },
        err: (error) => {
          $activeCountResultError196014 = error;
          return false;
        },
      });
      if (($activeCountResultOk196014 ? "ok" : "error") === "error")
        return Result.err($activeCountResultError196014);
      if ($activeCountResultValue196014.count >= MINI_NAMED_CLAUDE_ATTEMPT_RETENTION_LIMIT) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "reserveMiniNamedClaudeSessionAttempt",
            message: "Too many active Mini named Claude attempts are retained",
          }),
        );
      }
      const now = new Date().toISOString();
      this.database
        .query(
          `INSERT INTO mini_named_claude_attempts
            (product, session_id, source_history_state_id, source_canonical_message_count,
             provider_id, request_client, execution_scope_hash_version, execution_scope_hash,
             request_id, attempt_index, candidate_session_id, source_session_id,
             expected_binding_revision, state, created_at, updated_at)
           VALUES ('mini', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          input.lilacSessionId,
          input.sourceHistoryStateId,
          this.getHistoryStateCanonicalMessageCount(input.sourceHistoryStateId),
          input.providerId,
          input.requestClient,
          input.executionScopeHashVersion,
          input.executionScopeHash,
          input.requestId,
          input.attemptIndex,
          input.candidateSessionId,
          input.sourceSessionId,
          input.expectedBindingRevision,
          now,
          now,
        );
      this.pruneMiniNamedClaudeAttempts(input.lilacSessionId, input.providerId);
      const attempt = this.getMiniNamedClaudeSessionAttemptResult({
        providerId: input.providerId,
        lilacSessionId: input.lilacSessionId,
        requestId: input.requestId,
        attemptIndex: input.attemptIndex,
      });
      let $attemptResultValue198083!: import("better-result").InferOk<NonNullable<typeof attempt>>;
      let $attemptResultError198083!: import("better-result").InferErr<NonNullable<typeof attempt>>;
      const $attemptResultOk198083 = Result.match<
        import("better-result").InferOk<NonNullable<typeof attempt>>,
        import("better-result").InferErr<NonNullable<typeof attempt>>,
        boolean
      >(attempt, {
        ok: (value) => {
          $attemptResultValue198083 = value;
          return true;
        },
        err: (error) => {
          $attemptResultError198083 = error;
          return false;
        },
      });
      if (($attemptResultOk198083 ? "ok" : "error") === "error")
        return Result.err($attemptResultError198083);
      if ($attemptResultValue198083 === null) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "reserveMiniNamedClaudeSessionAttempt",
            message: "Reserved named Claude attempt was not retained",
          }),
        );
      }
      return Result.ok($attemptResultValue198083);
    });
  }

  recordMiniNamedClaudeSessionAttemptOutcome(
    inputValue: RecordMiniNamedClaudeSessionAttemptOutcome,
  ): MiniNamedClaudeSessionAttempt {
    return storeResultToLegacy(this.recordMiniNamedClaudeSessionAttemptOutcomeResult(inputValue));
  }

  recordMiniNamedClaudeSessionAttemptOutcomeResult(
    inputValue: RecordMiniNamedClaudeSessionAttemptOutcome,
  ): ResultType<MiniNamedClaudeSessionAttempt, MiniLilacStoreOperationError> {
    const input = inputValue;
    return this.runStoreTransactionResult<
      MiniNamedClaudeSessionAttempt,
      MiniLilacStoreOperationError
    >("recordMiniNamedClaudeSessionAttemptOutcome", () => {
      const attemptKey = {
        providerId: input.providerId,
        lilacSessionId: input.lilacSessionId,
        requestId: input.requestId,
        attemptIndex: input.attemptIndex,
      };
      const current = this.getMiniNamedClaudeSessionAttemptResult(attemptKey);
      let $currentResultValue199566!: import("better-result").InferOk<NonNullable<typeof current>>;
      let $currentResultError199566!: import("better-result").InferErr<NonNullable<typeof current>>;
      const $currentResultOk199566 = Result.match<
        import("better-result").InferOk<NonNullable<typeof current>>,
        import("better-result").InferErr<NonNullable<typeof current>>,
        boolean
      >(current, {
        ok: (value) => {
          $currentResultValue199566 = value;
          return true;
        },
        err: (error) => {
          $currentResultError199566 = error;
          return false;
        },
      });
      if (($currentResultOk199566 ? "ok" : "error") === "error")
        return Result.err($currentResultError199566);
      if ($currentResultValue199566 === null) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "recordMiniNamedClaudeSessionAttemptOutcome",
            message: `Named Claude attempt '${input.requestId}' was not found`,
          }),
        );
      }
      if ($currentResultValue199566.state !== "active") {
        if ($currentResultValue199566.state === input.state)
          return Result.ok($currentResultValue199566);
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "recordMiniNamedClaudeSessionAttemptOutcome",
            message: `Named Claude attempt '${input.requestId}' is already terminal as '${$currentResultValue199566.state}'`,
          }),
        );
      }
      const updated = this.database
        .query(
          `UPDATE mini_named_claude_attempts SET state = ?, updated_at = ?
           WHERE session_id = ? AND provider_id = ? AND request_id = ? AND attempt_index = ?
             AND state = 'active'`,
        )
        .run(
          input.state,
          new Date().toISOString(),
          input.lilacSessionId,
          input.providerId,
          input.requestId,
          input.attemptIndex,
        );
      if (updated.changes !== 1) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "recordMiniNamedClaudeSessionAttemptOutcome",
            message: "Named Claude attempt outcome lost its active fence",
          }),
        );
      }
      this.pruneMiniNamedClaudeAttempts(input.lilacSessionId, input.providerId);
      const attempt = this.getMiniNamedClaudeSessionAttemptResult(attemptKey);
      let $attemptResultValue201264!: import("better-result").InferOk<NonNullable<typeof attempt>>;
      let $attemptResultError201264!: import("better-result").InferErr<NonNullable<typeof attempt>>;
      const $attemptResultOk201264 = Result.match<
        import("better-result").InferOk<NonNullable<typeof attempt>>,
        import("better-result").InferErr<NonNullable<typeof attempt>>,
        boolean
      >(attempt, {
        ok: (value) => {
          $attemptResultValue201264 = value;
          return true;
        },
        err: (error) => {
          $attemptResultError201264 = error;
          return false;
        },
      });
      if (($attemptResultOk201264 ? "ok" : "error") === "error")
        return Result.err($attemptResultError201264);
      if ($attemptResultValue201264 === null) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "recordMiniNamedClaudeSessionAttemptOutcome",
            message: "Updated named Claude attempt exceeded retention immediately",
          }),
        );
      }
      return Result.ok($attemptResultValue201264);
    });
  }

  getSessionHistory(sessionId: string): StoredSessionHistory {
    return storeResultToLegacy(this.getSessionHistoryResult(sessionId));
  }

  getSessionHistoryResult(
    sessionId: string,
  ): ResultType<StoredSessionHistory, MiniLilacPersistenceError> {
    return this.runHistoryReadResult("getSessionHistory", () =>
      this.decodeRequiredStructuralHistoryRow({
        kind: "session-history",
        row: this.database
          .query("SELECT * FROM session_history WHERE session_id = ?")
          .get(sessionId),
        recordId: sessionId,
      }),
    );
  }

  getHistoryNavigation(sessionId: string): StoredHistoryNavigation {
    return storeResultToLegacy(this.getHistoryNavigationResult(sessionId));
  }

  getHistoryNavigationResult(
    sessionId: string,
  ): ResultType<StoredHistoryNavigation, MiniLilacPersistenceError> {
    const history = this.getSessionHistoryResult(sessionId);
    let $historyResultValue202614!: import("better-result").InferOk<NonNullable<typeof history>>;
    let $historyResultError202614!: import("better-result").InferErr<NonNullable<typeof history>>;
    const $historyResultOk202614 = Result.match<
      import("better-result").InferOk<NonNullable<typeof history>>,
      import("better-result").InferErr<NonNullable<typeof history>>,
      boolean
    >(history, {
      ok: (value) => {
        $historyResultValue202614 = value;
        return true;
      },
      err: (error) => {
        $historyResultError202614 = error;
        return false;
      },
    });
    if (($historyResultOk202614 ? "ok" : "error") === "error")
      return Result.err($historyResultError202614);
    const undo = this.findLatestUndoableUserTransitionResult(sessionId);
    let $undoResultValue202745!: import("better-result").InferOk<NonNullable<typeof undo>>;
    let $undoResultError202745!: import("better-result").InferErr<NonNullable<typeof undo>>;
    const $undoResultOk202745 = Result.match<
      import("better-result").InferOk<NonNullable<typeof undo>>,
      import("better-result").InferErr<NonNullable<typeof undo>>,
      boolean
    >(undo, {
      ok: (value) => {
        $undoResultValue202745 = value;
        return true;
      },
      err: (error) => {
        $undoResultError202745 = error;
        return false;
      },
    });
    if (($undoResultOk202745 ? "ok" : "error") === "error")
      return Result.err($undoResultError202745);
    const redo = this.peekHistoryRedoResult(sessionId);
    let $redoResultValue202882!: import("better-result").InferOk<NonNullable<typeof redo>>;
    let $redoResultError202882!: import("better-result").InferErr<NonNullable<typeof redo>>;
    const $redoResultOk202882 = Result.match<
      import("better-result").InferOk<NonNullable<typeof redo>>,
      import("better-result").InferErr<NonNullable<typeof redo>>,
      boolean
    >(redo, {
      ok: (value) => {
        $redoResultValue202882 = value;
        return true;
      },
      err: (error) => {
        $redoResultError202882 = error;
        return false;
      },
    });
    if (($redoResultOk202882 ? "ok" : "error") === "error")
      return Result.err($redoResultError202882);
    return Result.ok({
      currentStateId: $historyResultValue202614.currentStateId,
      canUndo: $undoResultValue202745 !== null,
      canRedo: $redoResultValue202882 !== null,
    });
  }

  findLatestUndoableUserTransition(sessionId: string): StoredHistoryTransition | null {
    return storeResultToLegacy(this.findLatestUndoableUserTransitionResult(sessionId));
  }

  findLatestUndoableUserTransitionResult(
    sessionId: string,
  ): ResultType<StoredHistoryTransition | null, MiniLilacPersistenceError> {
    return this.runHistoryReadResult("findLatestUndoableUserTransition", () =>
      this.decodeStructuralHistoryRow({
        kind: "transition",
        row: this.database
          .query(
            `WITH RECURSIVE ancestry(state_id, distance, floor_state_id) AS (
           SELECT current_state_id, 0, undo_floor_state_id
           FROM session_history WHERE session_id = ?
           UNION ALL
           SELECT transition.from_state_id, ancestry.distance + 1, ancestry.floor_state_id
           FROM ancestry
           JOIN history_transitions AS transition
             ON transition.session_id = ? AND transition.to_state_id = ancestry.state_id
           WHERE ancestry.state_id <> ancestry.floor_state_id
         )
         SELECT transition.*
         FROM ancestry
         JOIN history_transitions AS transition
           ON transition.session_id = ? AND transition.to_state_id = ancestry.state_id
         WHERE ancestry.state_id <> ancestry.floor_state_id
           AND transition.kind = 'user-message'
         ORDER BY ancestry.distance
         LIMIT 1`,
          )
          .get(sessionId, sessionId, sessionId),
        recordId: sessionId,
      }),
    );
  }

  peekHistoryRedo(sessionId: string): StoredHistoryRedoEntry | null {
    return storeResultToLegacy(this.peekHistoryRedoResult(sessionId));
  }

  peekHistoryRedoResult(
    sessionId: string,
  ): ResultType<StoredHistoryRedoEntry | null, MiniLilacPersistenceError> {
    return this.runHistoryReadResult("peekHistoryRedo", () =>
      this.decodeStructuralHistoryRow({
        kind: "redo",
        row: this.database
          .query(
            `SELECT * FROM history_redo_stack
             WHERE session_id = ? ORDER BY position DESC LIMIT 1`,
          )
          .get(sessionId),
        recordId: sessionId,
      }),
    );
  }

  listHistoryTopology(sessionId: string): StoredHistoryTopology {
    return storeResultToLegacy(this.listHistoryTopologyResult(sessionId));
  }

  listHistoryTopologyResult(
    sessionId: string,
  ): ResultType<StoredHistoryTopology, MiniLilacPersistenceError> {
    return this.runHistoryReadResult("listHistoryTopology", () => {
      const history = this.getSessionHistoryResult(sessionId);
      let $historyResultValue205656!: import("better-result").InferOk<NonNullable<typeof history>>;
      let $historyResultError205656!: import("better-result").InferErr<NonNullable<typeof history>>;
      const $historyResultOk205656 = Result.match<
        import("better-result").InferOk<NonNullable<typeof history>>,
        import("better-result").InferErr<NonNullable<typeof history>>,
        boolean
      >(history, {
        ok: (value) => {
          $historyResultValue205656 = value;
          return true;
        },
        err: (error) => {
          $historyResultError205656 = error;
          return false;
        },
      });
      if (($historyResultOk205656 ? "ok" : "error") === "error")
        return Result.err($historyResultError205656);
      const states = this.decodeStructuralHistoryRows({
        kind: "state",
        rows: this.database
          .query("SELECT * FROM history_states WHERE session_id = ? ORDER BY created_at, rowid")
          .all(sessionId),
        recordId: `${sessionId}:state`,
      });
      let $statesResultValue205791!: import("better-result").InferOk<NonNullable<typeof states>>;
      let $statesResultError205791!: import("better-result").InferErr<NonNullable<typeof states>>;
      const $statesResultOk205791 = Result.match<
        import("better-result").InferOk<NonNullable<typeof states>>,
        import("better-result").InferErr<NonNullable<typeof states>>,
        boolean
      >(states, {
        ok: (value) => {
          $statesResultValue205791 = value;
          return true;
        },
        err: (error) => {
          $statesResultError205791 = error;
          return false;
        },
      });
      if (($statesResultOk205791 ? "ok" : "error") === "error")
        return Result.err($statesResultError205791);
      const transitions = this.decodeStructuralHistoryRows({
        kind: "transition",
        rows: this.database
          .query(
            "SELECT * FROM history_transitions WHERE session_id = ? ORDER BY created_at, rowid",
          )
          .all(sessionId),
        recordId: `${sessionId}:transition`,
      });
      let $transitionsResultValue206142!: import("better-result").InferOk<
        NonNullable<typeof transitions>
      >;
      let $transitionsResultError206142!: import("better-result").InferErr<
        NonNullable<typeof transitions>
      >;
      const $transitionsResultOk206142 = Result.match<
        import("better-result").InferOk<NonNullable<typeof transitions>>,
        import("better-result").InferErr<NonNullable<typeof transitions>>,
        boolean
      >(transitions, {
        ok: (value) => {
          $transitionsResultValue206142 = value;
          return true;
        },
        err: (error) => {
          $transitionsResultError206142 = error;
          return false;
        },
      });
      if (($transitionsResultOk206142 ? "ok" : "error") === "error")
        return Result.err($transitionsResultError206142);
      const redoStack = this.decodeStructuralHistoryRows({
        kind: "redo",
        rows: this.database
          .query("SELECT * FROM history_redo_stack WHERE session_id = ? ORDER BY position")
          .all(sessionId),
        recordId: `${sessionId}:redo`,
      });
      let $redoStackResultValue206548!: import("better-result").InferOk<
        NonNullable<typeof redoStack>
      >;
      let $redoStackResultError206548!: import("better-result").InferErr<
        NonNullable<typeof redoStack>
      >;
      const $redoStackResultOk206548 = Result.match<
        import("better-result").InferOk<NonNullable<typeof redoStack>>,
        import("better-result").InferErr<NonNullable<typeof redoStack>>,
        boolean
      >(redoStack, {
        ok: (value) => {
          $redoStackResultValue206548 = value;
          return true;
        },
        err: (error) => {
          $redoStackResultError206548 = error;
          return false;
        },
      });
      if (($redoStackResultOk206548 ? "ok" : "error") === "error")
        return Result.err($redoStackResultError206548);
      return Result.ok({
        history: $historyResultValue205656,
        states: $statesResultValue205791,
        transitions: $transitionsResultValue206142,
        redoStack: $redoStackResultValue206548,
      });
    });
  }

  getHistoryAccounting(workspaceId?: string): StoredHistoryAccounting {
    return storeResultToLegacy(this.getHistoryAccountingResult(workspaceId));
  }

  getHistoryAccountingResult(
    workspaceId?: string,
  ): ResultType<StoredHistoryAccounting, MiniLilacPersistenceError> {
    const filter = workspaceId ?? null;
    if (
      filter !== null &&
      !this.database.query("SELECT 1 FROM workspaces WHERE id = ?").get(filter)
    ) {
      return Result.err(
        new MiniLilacHistoryRecordMissing({
          recordKind: "workspace",
          recordId: filter,
          message: `Workspace '${filter}' was not found`,
        }),
      );
    }
    return this.runHistoryReadResult("getHistoryAccounting", () =>
      this.decodeRequiredStructuralHistoryRow({
        kind: "accounting",
        row: this.database
          .query(
            `WITH workspace_filter(workspace_id) AS (VALUES (?))
           SELECT
             (SELECT COUNT(*) FROM history_states AS state, workspace_filter AS filter
              WHERE filter.workspace_id IS NULL OR state.workspace_id = filter.workspace_id)
               AS state_count,
             (SELECT COUNT(*)
              FROM history_transitions AS transition
              JOIN sessions AS session ON session.id = transition.session_id,
                   workspace_filter AS filter
              WHERE filter.workspace_id IS NULL OR session.workspace_id = filter.workspace_id)
               AS transition_count,
             (SELECT COUNT(*) FROM history_states AS state, workspace_filter AS filter
              WHERE (filter.workspace_id IS NULL OR state.workspace_id = filter.workspace_id)
                AND NOT EXISTS (
                  SELECT 1 FROM history_transitions AS transition
                  WHERE transition.session_id = state.session_id
                    AND transition.from_state_id = state.id
                    AND transition.to_state_id IS NOT NULL
                )) AS branch_tip_count,
             (SELECT COUNT(*) FROM workspace_snapshots AS snapshot, workspace_filter AS filter
              WHERE filter.workspace_id IS NULL OR snapshot.workspace_id = filter.workspace_id)
               AS snapshot_count,
             (SELECT COUNT(*)
              FROM history_redo_stack AS redo
              JOIN sessions AS session ON session.id = redo.session_id,
                   workspace_filter AS filter
              WHERE filter.workspace_id IS NULL OR session.workspace_id = filter.workspace_id)
               AS redo_stack_count,
             (SELECT COUNT(*) FROM history_operations AS operation, workspace_filter AS filter
              WHERE filter.workspace_id IS NULL OR operation.workspace_id = filter.workspace_id)
               AS active_operation_count,
             (SELECT COUNT(*)
              FROM pending_run_finalizations AS finalization, workspace_filter AS filter
              WHERE filter.workspace_id IS NULL
                OR finalization.workspace_id = filter.workspace_id)
               AS pending_finalization_count`,
          )
          .get(filter),
        recordId: filter ?? "all",
      }),
    );
  }

  internHistoryTranscriptHeads(
    sessionId: string,
    modelMessages: readonly ModelMessage[],
    uiMessages: readonly MiniLilacUIMessage[],
  ): InternedStoredTranscriptHeads {
    this.getSession(sessionId);
    return this.runStoreTransaction("internHistoryTranscriptHeads", () => ({
      modelHeadId: this.internChain(sessionId, "model", modelMessages),
      uiHeadId: this.internChain(sessionId, "ui", uiMessages),
    }));
  }

  admitRootPromptHistory(input: AdmitStoredRootPromptHistory): AdmittedStoredRootPromptHistory {
    return storeResultToLegacy(this.admitRootPromptHistoryResult(input));
  }

  admitRootPromptHistoryResult(
    input: AdmitStoredRootPromptHistory,
  ): ResultType<AdmittedStoredRootPromptHistory, MiniLilacStoreOperationError> {
    if (input.run.parentRunId !== undefined) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "admitRootPromptHistory",
          "Root prompt history admission requires a root run",
        ),
      );
    }
    const lastUiMessage = input.uiMessages.at(-1);
    if (lastUiMessage?.role !== "user") {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "admitRootPromptHistory",
          "Root prompt history admission requires a final UI user message",
        ),
      );
    }
    const userMessage: MiniLilacUserUIMessage = { ...lastUiMessage, role: "user" };
    if (input.modelMessages.at(-1)?.role !== "user") {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "admitRootPromptHistory",
          "Root prompt history admission requires a final model user message",
        ),
      );
    }
    const command = decodeCanonicalRootPromptCommand(input);
    let $commandResultValue211874!: import("better-result").InferOk<NonNullable<typeof command>>;
    let $commandResultError211874!: import("better-result").InferErr<NonNullable<typeof command>>;
    const $commandResultOk211874 = Result.match<
      import("better-result").InferOk<NonNullable<typeof command>>,
      import("better-result").InferErr<NonNullable<typeof command>>,
      boolean
    >(command, {
      ok: (value) => {
        $commandResultValue211874 = value;
        return true;
      },
      err: (error) => {
        $commandResultError211874 = error;
        return false;
      },
    });
    if (($commandResultOk211874 ? "ok" : "error") === "error")
      return Result.err($commandResultError211874);
    return this.runStoreTransactionResult("admitRootPromptHistory", () => {
      const quiescent = this.requireQuiescentHistorySessionResult(
        input.run.sessionId,
        input.expectedCurrentStateId,
      );
      const quiescenceError = quiescent.match({ ok: () => null, err: (error) => error });
      if (quiescenceError !== null) return Result.err(quiescenceError);
      const workspace = this.getWorkspaceForSessionResult(input.run.sessionId);
      let $workspaceResultValue212302!: import("better-result").InferOk<
        NonNullable<typeof workspace>
      >;
      let $workspaceResultError212302!: import("better-result").InferErr<
        NonNullable<typeof workspace>
      >;
      const $workspaceResultOk212302 = Result.match<
        import("better-result").InferOk<NonNullable<typeof workspace>>,
        import("better-result").InferErr<NonNullable<typeof workspace>>,
        boolean
      >(workspace, {
        ok: (value) => {
          $workspaceResultValue212302 = value;
          return true;
        },
        err: (error) => {
          $workspaceResultError212302 = error;
          return false;
        },
      });
      if (($workspaceResultOk212302 ? "ok" : "error") === "error")
        return Result.err($workspaceResultError212302);
      const available = this.assertWorkspaceHasNoHistoryJournalResult(
        $workspaceResultValue212302.id,
      );
      const availabilityError = available.match({ ok: () => null, err: (error) => error });
      if (availabilityError !== null) return Result.err(availabilityError);
      const current = this.getCurrentHistoryStateResult(input.run.sessionId);
      let $currentResultValue212625!: import("better-result").InferOk<NonNullable<typeof current>>;
      let $currentResultError212625!: import("better-result").InferErr<NonNullable<typeof current>>;
      const $currentResultOk212625 = Result.match<
        import("better-result").InferOk<NonNullable<typeof current>>,
        import("better-result").InferErr<NonNullable<typeof current>>,
        boolean
      >(current, {
        ok: (value) => {
          $currentResultValue212625 = value;
          return true;
        },
        err: (error) => {
          $currentResultError212625 = error;
          return false;
        },
      });
      if (($currentResultOk212625 ? "ok" : "error") === "error")
        return Result.err($currentResultError212625);
      const prefixHeads = {
        modelHeadId: this.internChain(
          input.run.sessionId,
          "model",
          input.modelMessages.slice(0, -1),
        ),
        uiHeadId: this.internChain(input.run.sessionId, "ui", input.uiMessages.slice(0, -1)),
      };
      const equalHeads = this.assertHeadsEqualStateResult(
        input.run.sessionId,
        prefixHeads,
        $currentResultValue212625,
      );
      const headsError = equalHeads.match({ ok: () => null, err: (error) => error });
      if (headsError !== null) return Result.err(headsError);
      if (
        $currentResultValue212625.workspaceStatus === "capture-deferred" &&
        input.observation === undefined
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "admitRootPromptHistory",
            "A deferred history root requires an observed workspace boundary",
          ),
        );
      }
      let fromState = $currentResultValue212625;
      if (input.observation !== undefined) {
        const observed = this.insertWorkspaceObservationResult(
          input.run.sessionId,
          $currentResultValue212625,
          prefixHeads,
          input.observation,
        );
        let $observedResultValue213671!: import("better-result").InferOk<
          NonNullable<typeof observed>
        >;
        let $observedResultError213671!: import("better-result").InferErr<
          NonNullable<typeof observed>
        >;
        const $observedResultOk213671 = Result.match<
          import("better-result").InferOk<NonNullable<typeof observed>>,
          import("better-result").InferErr<NonNullable<typeof observed>>,
          boolean
        >(observed, {
          ok: (value) => {
            $observedResultValue213671 = value;
            return true;
          },
          err: (error) => {
            $observedResultError213671 = error;
            return false;
          },
        });
        if (($observedResultOk213671 ? "ok" : "error") === "error")
          return Result.err($observedResultError213671);
        fromState = $observedResultValue213671;
        const moved = this.moveHistoryCursorResult(input.run.sessionId, fromState);
        const moveError = moved.match({ ok: () => null, err: (error) => error });
        if (moveError !== null) return Result.err(moveError);
      }
      const fullHeads = {
        modelHeadId: this.internChain(input.run.sessionId, "model", input.modelMessages),
        uiHeadId: this.internChain(input.run.sessionId, "ui", input.uiMessages),
      };
      const commandRow = this.getStoredCommandResult(input.run.sessionId, input.commandId);
      let $commandRowResultValue214332!: import("better-result").InferOk<
        NonNullable<typeof commandRow>
      >;
      let $commandRowResultError214332!: import("better-result").InferErr<
        NonNullable<typeof commandRow>
      >;
      const $commandRowResultOk214332 = Result.match<
        import("better-result").InferOk<NonNullable<typeof commandRow>>,
        import("better-result").InferErr<NonNullable<typeof commandRow>>,
        boolean
      >(commandRow, {
        ok: (value) => {
          $commandRowResultValue214332 = value;
          return true;
        },
        err: (error) => {
          $commandRowResultError214332 = error;
          return false;
        },
      });
      if (($commandRowResultOk214332 ? "ok" : "error") === "error")
        return Result.err($commandRowResultError214332);
      if (
        $commandRowResultValue214332.kind !== "prompt" ||
        $commandRowResultValue214332.run_id !== null ||
        $commandRowResultValue214332.side_effect_started !== 0 ||
        $commandRowResultValue214332.result_json !== null ||
        $commandRowResultValue214332.request_fingerprint !==
          $commandResultValue211874.fingerprint ||
        $commandRowResultValue214332.request_json !== $commandResultValue211874.json
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "admitRootPromptHistory",
            `Prompt command '${input.commandId}' is not an admissible reservation`,
          ),
        );
      }
      const now = new Date().toISOString();
      this.database
        .query(
          `INSERT INTO runs
            (id, session_id, parent_run_id, profile, depth, status, started_at)
           VALUES (?, ?, NULL, ?, ?, 'active', ?)`,
        )
        .run(input.run.id, input.run.sessionId, input.run.profile, input.run.depth, now);
      const assigned = this.database
        .query(
          `UPDATE commands SET run_id = ?, side_effect_started = 1, result_json = ?
           WHERE session_id = ? AND command_id = ? AND kind = 'prompt'
             AND run_id IS NULL AND side_effect_started = 0 AND result_json IS NULL`,
        )
        .run(
          input.run.id,
          serialize({ runId: input.run.id }),
          input.run.sessionId,
          input.commandId,
        );
      if (assigned.changes !== 1) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "admitRootPromptHistory",
            `Prompt command '${input.commandId}' could not be assigned atomically`,
          ),
        );
      }
      const insertedTransition = this.insertHistoryTransitionRowResult({
        id: input.transitionId,
        sessionId: input.run.sessionId,
        fromStateId: fromState.id,
        kind: "user-message",
        delivery: "prompt",
        commandId: input.commandId,
        userMessage,
        rootRunId: input.run.id,
        replayAfterSeq: 0,
        createdAt: now,
      });
      const transitionError = insertedTransition.match({
        ok: () => null,
        err: (error) => error,
      });
      if (transitionError !== null) return Result.err(transitionError);
      this.setTranscriptHeads(input.run.sessionId, fullHeads.modelHeadId, fullHeads.uiHeadId);
      this.clearHistoryRedo(input.run.sessionId);
      const updated = this.database
        .query(
          `UPDATE sessions SET status = 'streaming', active_run_id = ?,
             queued_steering_count = 0, title = COALESCE(?, title), updated_at = ?
           WHERE id = ? AND active_run_id IS NULL AND status IN ('idle', 'error')`,
        )
        .run(input.run.id, input.title ?? null, now, input.run.sessionId);
      if (updated.changes !== 1) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "admitRootPromptHistory",
            `Session '${input.run.sessionId}' could not admit root run '${input.run.id}'`,
          ),
        );
      }
      const snapshot = this.getSessionResult(input.run.sessionId);
      let $snapshotResultValue217400!: import("better-result").InferOk<
        NonNullable<typeof snapshot>
      >;
      let $snapshotResultError217400!: import("better-result").InferErr<
        NonNullable<typeof snapshot>
      >;
      const $snapshotResultOk217400 = Result.match<
        import("better-result").InferOk<NonNullable<typeof snapshot>>,
        import("better-result").InferErr<NonNullable<typeof snapshot>>,
        boolean
      >(snapshot, {
        ok: (value) => {
          $snapshotResultValue217400 = value;
          return true;
        },
        err: (error) => {
          $snapshotResultError217400 = error;
          return false;
        },
      });
      if (($snapshotResultOk217400 ? "ok" : "error") === "error")
        return Result.err($snapshotResultError217400);
      const transition = this.getHistoryTransitionResult(input.transitionId);
      let $transitionResultValue217541!: import("better-result").InferOk<
        NonNullable<typeof transition>
      >;
      let $transitionResultError217541!: import("better-result").InferErr<
        NonNullable<typeof transition>
      >;
      const $transitionResultOk217541 = Result.match<
        import("better-result").InferOk<NonNullable<typeof transition>>,
        import("better-result").InferErr<NonNullable<typeof transition>>,
        boolean
      >(transition, {
        ok: (value) => {
          $transitionResultValue217541 = value;
          return true;
        },
        err: (error) => {
          $transitionResultError217541 = error;
          return false;
        },
      });
      if (($transitionResultOk217541 ? "ok" : "error") === "error")
        return Result.err($transitionResultError217541);
      return Result.ok({
        snapshot: $snapshotResultValue217400,
        fromState,
        transition: $transitionResultValue217541,
      });
    });
  }

  commitSteeringHistoryBoundary(
    input: CommitStoredSteeringBoundary,
  ): CommittedStoredSteeringBoundary {
    return storeResultToLegacy(this.commitSteeringHistoryBoundaryResult(input));
  }

  commitSteeringHistoryBoundaryResult(
    input: CommitStoredSteeringBoundary,
  ): ResultType<CommittedStoredSteeringBoundary, MiniLilacStoreOperationError> {
    const validated = validateSteeringHistoryBoundaryInput(input);
    let $validatedResultValue218194!: import("better-result").InferOk<
      NonNullable<typeof validated>
    >;
    let $validatedResultError218194!: import("better-result").InferErr<
      NonNullable<typeof validated>
    >;
    const $validatedResultOk218194 = Result.match<
      import("better-result").InferOk<NonNullable<typeof validated>>,
      import("better-result").InferErr<NonNullable<typeof validated>>,
      boolean
    >(validated, {
      ok: (value) => {
        $validatedResultValue218194 = value;
        return true;
      },
      err: (error) => {
        $validatedResultError218194 = error;
        return false;
      },
    });
    if (($validatedResultOk218194 ? "ok" : "error") === "error")
      return Result.err($validatedResultError218194);
    const { firstUiPosition, firstModelPosition } = $validatedResultValue218194;
    return this.runStoreTransactionResult("commitSteeringHistoryBoundary", () => {
      const session = this.getSessionResult(input.sessionId);
      let $sessionResultValue218489!: import("better-result").InferOk<NonNullable<typeof session>>;
      let $sessionResultError218489!: import("better-result").InferErr<NonNullable<typeof session>>;
      const $sessionResultOk218489 = Result.match<
        import("better-result").InferOk<NonNullable<typeof session>>,
        import("better-result").InferErr<NonNullable<typeof session>>,
        boolean
      >(session, {
        ok: (value) => {
          $sessionResultValue218489 = value;
          return true;
        },
        err: (error) => {
          $sessionResultError218489 = error;
          return false;
        },
      });
      if (($sessionResultOk218489 ? "ok" : "error") === "error")
        return Result.err($sessionResultError218489);
      const activeRun = this.getActiveRootRun(input.sessionId);
      if (
        $sessionResultValue218489.status !== "streaming" ||
        activeRun?.id !== input.rootRunId ||
        activeRun.parentRunId !== null
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitSteeringHistoryBoundary",
            `Run '${input.rootRunId}' is not the active root run`,
          ),
        );
      }
      const workspace = this.getWorkspaceForSessionResult(input.sessionId);
      let $workspaceResultValue219052!: import("better-result").InferOk<
        NonNullable<typeof workspace>
      >;
      let $workspaceResultError219052!: import("better-result").InferErr<
        NonNullable<typeof workspace>
      >;
      const $workspaceResultOk219052 = Result.match<
        import("better-result").InferOk<NonNullable<typeof workspace>>,
        import("better-result").InferErr<NonNullable<typeof workspace>>,
        boolean
      >(workspace, {
        ok: (value) => {
          $workspaceResultValue219052 = value;
          return true;
        },
        err: (error) => {
          $workspaceResultError219052 = error;
          return false;
        },
      });
      if (($workspaceResultOk219052 ? "ok" : "error") === "error")
        return Result.err($workspaceResultError219052);
      const available = this.assertWorkspaceHasNoHistoryJournalResult(
        $workspaceResultValue219052.id,
      );
      const availabilityError = available.match({ ok: () => null, err: (error) => error });
      if (availabilityError !== null) return Result.err(availabilityError);
      const previous = this.getHistoryTransitionResult(input.previousOpenTransitionId);
      let $previousResultValue219371!: import("better-result").InferOk<
        NonNullable<typeof previous>
      >;
      let $previousResultError219371!: import("better-result").InferErr<
        NonNullable<typeof previous>
      >;
      const $previousResultOk219371 = Result.match<
        import("better-result").InferOk<NonNullable<typeof previous>>,
        import("better-result").InferErr<NonNullable<typeof previous>>,
        boolean
      >(previous, {
        ok: (value) => {
          $previousResultValue219371 = value;
          return true;
        },
        err: (error) => {
          $previousResultError219371 = error;
          return false;
        },
      });
      if (($previousResultOk219371 ? "ok" : "error") === "error")
        return Result.err($previousResultError219371);
      const history = this.getSessionHistoryResult(input.sessionId);
      let $historyResultValue219533!: import("better-result").InferOk<NonNullable<typeof history>>;
      let $historyResultError219533!: import("better-result").InferErr<NonNullable<typeof history>>;
      const $historyResultOk219533 = Result.match<
        import("better-result").InferOk<NonNullable<typeof history>>,
        import("better-result").InferErr<NonNullable<typeof history>>,
        boolean
      >(history, {
        ok: (value) => {
          $historyResultValue219533 = value;
          return true;
        },
        err: (error) => {
          $historyResultError219533 = error;
          return false;
        },
      });
      if (($historyResultOk219533 ? "ok" : "error") === "error")
        return Result.err($historyResultError219533);
      if (
        $previousResultValue219371.sessionId !== input.sessionId ||
        $previousResultValue219371.toStateId !== null ||
        $previousResultValue219371.rootRunId !== input.rootRunId ||
        $historyResultValue219533.currentStateId !== $previousResultValue219371.fromStateId
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitSteeringHistoryBoundary",
            `Transition '${input.previousOpenTransitionId}' is not the active boundary`,
          ),
        );
      }
      const baseHeads = {
        modelHeadId: this.internChain(
          input.sessionId,
          "model",
          input.mergedModelMessages.slice(0, firstModelPosition),
        ),
        uiHeadId: this.internChain(
          input.sessionId,
          "ui",
          input.uiMessages.slice(0, firstUiPosition),
        ),
      };
      const canonicalUiMessages = this.getUiMessagesResult(input.sessionId);
      let $canonicalUiMessagesResultValue220495!: import("better-result").InferOk<
        NonNullable<typeof canonicalUiMessages>
      >;
      let $canonicalUiMessagesResultError220495!: import("better-result").InferErr<
        NonNullable<typeof canonicalUiMessages>
      >;
      const $canonicalUiMessagesResultOk220495 = Result.match<
        import("better-result").InferOk<NonNullable<typeof canonicalUiMessages>>,
        import("better-result").InferErr<NonNullable<typeof canonicalUiMessages>>,
        boolean
      >(canonicalUiMessages, {
        ok: (value) => {
          $canonicalUiMessagesResultValue220495 = value;
          return true;
        },
        err: (error) => {
          $canonicalUiMessagesResultError220495 = error;
          return false;
        },
      });
      if (($canonicalUiMessagesResultOk220495 ? "ok" : "error") === "error")
        return Result.err($canonicalUiMessagesResultError220495);
      const baseUiMessages = input.uiMessages.slice(0, firstUiPosition);
      if (!isCanonicalPrefix($canonicalUiMessagesResultValue220495, baseUiMessages)) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitSteeringHistoryBoundary",
            "Steering UI boundary does not extend the canonical live transcript",
          ),
        );
      }
      const fromState = this.getHistoryStateResult($previousResultValue219371.fromStateId);
      let $fromStateResultValue221043!: import("better-result").InferOk<
        NonNullable<typeof fromState>
      >;
      let $fromStateResultError221043!: import("better-result").InferErr<
        NonNullable<typeof fromState>
      >;
      const $fromStateResultOk221043 = Result.match<
        import("better-result").InferOk<NonNullable<typeof fromState>>,
        import("better-result").InferErr<NonNullable<typeof fromState>>,
        boolean
      >(fromState, {
        ok: (value) => {
          $fromStateResultValue221043 = value;
          return true;
        },
        err: (error) => {
          $fromStateResultError221043 = error;
          return false;
        },
      });
      if (($fromStateResultOk221043 ? "ok" : "error") === "error")
        return Result.err($fromStateResultError221043);
      const providerState =
        input.providerState === undefined
          ? $fromStateResultValue221043.providerState
          : input.providerState;
      if (input.providerState !== undefined) {
        const conservative = this.assertConservativeProviderTransitionResult(
          $fromStateResultValue221043.id,
          input.providerState,
        );
        const transitionError = conservative.match({ ok: () => null, err: (error) => error });
        if (transitionError !== null) return Result.err(transitionError);
      }
      const rawFromUiMessages = this.readSerializedChainResult(
        input.sessionId,
        "ui",
        $fromStateResultValue221043.uiHeadId,
      );
      let $rawFromUiMessagesResultValue221613!: import("better-result").InferOk<
        NonNullable<typeof rawFromUiMessages>
      >;
      let $rawFromUiMessagesResultError221613!: import("better-result").InferErr<
        NonNullable<typeof rawFromUiMessages>
      >;
      const $rawFromUiMessagesResultOk221613 = Result.match<
        import("better-result").InferOk<NonNullable<typeof rawFromUiMessages>>,
        import("better-result").InferErr<NonNullable<typeof rawFromUiMessages>>,
        boolean
      >(rawFromUiMessages, {
        ok: (value) => {
          $rawFromUiMessagesResultValue221613 = value;
          return true;
        },
        err: (error) => {
          $rawFromUiMessagesResultError221613 = error;
          return false;
        },
      });
      if (($rawFromUiMessagesResultOk221613 ? "ok" : "error") === "error")
        return Result.err($rawFromUiMessagesResultError221613);
      const decodedFromUiMessages = decodeMiniLilacUiTranscript({
        rawValues: $rawFromUiMessagesResultValue221613,
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: $fromStateResultValue221043.id,
      });
      let $decodedFromUiMessagesResultValue221851!: import("better-result").InferOk<
        NonNullable<typeof decodedFromUiMessages>
      >;
      let $decodedFromUiMessagesResultError221851!: import("better-result").InferErr<
        NonNullable<typeof decodedFromUiMessages>
      >;
      const $decodedFromUiMessagesResultOk221851 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decodedFromUiMessages>>,
        import("better-result").InferErr<NonNullable<typeof decodedFromUiMessages>>,
        boolean
      >(decodedFromUiMessages, {
        ok: (value) => {
          $decodedFromUiMessagesResultValue221851 = value;
          return true;
        },
        err: (error) => {
          $decodedFromUiMessagesResultError221851 = error;
          return false;
        },
      });
      if (($decodedFromUiMessagesResultOk221851 ? "ok" : "error") === "error")
        return Result.err($decodedFromUiMessagesResultError221851);
      const fromUiMessages = $decodedFromUiMessagesResultValue221851.value;
      if (
        $previousResultValue219371.userMessage === null ||
        !canonicalValuesEqual(
          $canonicalUiMessagesResultValue220495[fromUiMessages.length],
          $previousResultValue219371.userMessage,
        ) ||
        !canonicalValuesEqual(
          baseUiMessages[fromUiMessages.length],
          $previousResultValue219371.userMessage,
        )
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitSteeringHistoryBoundary",
            "Steering boundary does not retain the active user message",
          ),
        );
      }
      const boundaryState: CreateStoredHistoryState = {
        id: input.boundaryStateId,
        sessionId: input.sessionId,
        workspaceId: $workspaceResultValue219052.id,
        modelHeadId: baseHeads.modelHeadId,
        uiHeadId: baseHeads.uiHeadId,
        ...input.workspace,
        origin: "turn-boundary",
        providerState,
      };
      const closedBoundary = this.closeHistoryTransitionResult(
        input.previousOpenTransitionId,
        boundaryState,
        { select: true },
      );
      const boundaryError = closedBoundary.match({ ok: () => null, err: (error) => error });
      if (boundaryError !== null) return Result.err(boundaryError);
      const boundary = this.getHistoryStateResult(input.boundaryStateId);
      let $boundaryResultValue223348!: import("better-result").InferOk<
        NonNullable<typeof boundary>
      >;
      let $boundaryResultError223348!: import("better-result").InferErr<
        NonNullable<typeof boundary>
      >;
      const $boundaryResultOk223348 = Result.match<
        import("better-result").InferOk<NonNullable<typeof boundary>>,
        import("better-result").InferErr<NonNullable<typeof boundary>>,
        boolean
      >(boundary, {
        ok: (value) => {
          $boundaryResultValue223348 = value;
          return true;
        },
        err: (error) => {
          $boundaryResultError223348 = error;
          return false;
        },
      });
      if (($boundaryResultOk223348 ? "ok" : "error") === "error")
        return Result.err($boundaryResultError223348);
      let currentState = $boundaryResultValue223348;
      for (const [index, entry] of input.entries.entries()) {
        const commandRow = this.getStoredCommandResult(input.sessionId, entry.commandId);
        let $commandRowResultValue223601!: import("better-result").InferOk<
          NonNullable<typeof commandRow>
        >;
        let $commandRowResultError223601!: import("better-result").InferErr<
          NonNullable<typeof commandRow>
        >;
        const $commandRowResultOk223601 = Result.match<
          import("better-result").InferOk<NonNullable<typeof commandRow>>,
          import("better-result").InferErr<NonNullable<typeof commandRow>>,
          boolean
        >(commandRow, {
          ok: (value) => {
            $commandRowResultValue223601 = value;
            return true;
          },
          err: (error) => {
            $commandRowResultError223601 = error;
            return false;
          },
        });
        if (($commandRowResultOk223601 ? "ok" : "error") === "error")
          return Result.err($commandRowResultError223601);
        if (
          $commandRowResultValue223601.kind !== "steer" ||
          $commandRowResultValue223601.run_id !== input.rootRunId ||
          $commandRowResultValue223601.side_effect_started !== 1 ||
          $commandRowResultValue223601.result_json === null
        ) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "commitSteeringHistoryBoundary",
              `Steering command '${entry.commandId}' is not admitted for this root run`,
            ),
          );
        }
        const decodedCommandPayload = decodeMiniLilacSteeringCommandRequest({
          raw: $commandRowResultValue223601.request_json,
          schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
          recordId: entry.commandId,
        });
        let $decodedCommandPayloadResultValue224250!: import("better-result").InferOk<
          NonNullable<typeof decodedCommandPayload>
        >;
        let $decodedCommandPayloadResultError224250!: import("better-result").InferErr<
          NonNullable<typeof decodedCommandPayload>
        >;
        const $decodedCommandPayloadResultOk224250 = Result.match<
          import("better-result").InferOk<NonNullable<typeof decodedCommandPayload>>,
          import("better-result").InferErr<NonNullable<typeof decodedCommandPayload>>,
          boolean
        >(decodedCommandPayload, {
          ok: (value) => {
            $decodedCommandPayloadResultValue224250 = value;
            return true;
          },
          err: (error) => {
            $decodedCommandPayloadResultError224250 = error;
            return false;
          },
        });
        if (($decodedCommandPayloadResultOk224250 ? "ok" : "error") === "error") {
          return Result.err($decodedCommandPayloadResultError224250);
        }
        const commandPayload = $decodedCommandPayloadResultValue224250.value;
        if (
          !canonicalValuesEqual(commandPayload.message, entry.message) ||
          (commandPayload.sessionId !== undefined &&
            commandPayload.sessionId !== input.sessionId) ||
          (commandPayload.runId !== undefined && commandPayload.runId !== input.rootRunId) ||
          (commandPayload.clientCommandId !== undefined &&
            commandPayload.clientCommandId !== entry.commandId)
        ) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "commitSteeringHistoryBoundary",
              `Steering command '${entry.commandId}' request does not match its boundary entry`,
            ),
          );
        }
        const insertedTransition = this.insertHistoryTransitionRowResult({
          id: entry.transitionId,
          sessionId: input.sessionId,
          fromStateId: currentState.id,
          kind: "user-message",
          delivery: "steer",
          commandId: entry.commandId,
          userMessage: entry.message,
          rootRunId: input.rootRunId,
          replayAfterSeq: entry.replayAfterSeq,
        });
        const transitionError = insertedTransition.match({
          ok: () => null,
          err: (error) => error,
        });
        if (transitionError !== null) return Result.err(transitionError);
        if (entry.intermediateStateId !== undefined) {
          const nextModelHeadId = this.internChain(
            input.sessionId,
            "model",
            input.mergedModelMessages.slice(0, firstModelPosition + index + 1),
          );
          const nextUiHeadId = this.internChain(
            input.sessionId,
            "ui",
            input.uiMessages.slice(0, firstUiPosition + index + 1),
          );
          const closed = this.closeHistoryTransitionResult(
            entry.transitionId,
            {
              id: entry.intermediateStateId,
              sessionId: input.sessionId,
              workspaceId: $workspaceResultValue219052.id,
              modelHeadId: nextModelHeadId,
              uiHeadId: nextUiHeadId,
              ...input.workspace,
              origin: "turn-boundary",
              providerState,
            },
            { select: true },
          );
          const closeError = closed.match({ ok: () => null, err: (error) => error });
          if (closeError !== null) return Result.err(closeError);
          const intermediateState = this.getHistoryStateResult(entry.intermediateStateId);
          let $intermediateStateResultValue226861!: import("better-result").InferOk<
            NonNullable<typeof intermediateState>
          >;
          let $intermediateStateResultError226861!: import("better-result").InferErr<
            NonNullable<typeof intermediateState>
          >;
          const $intermediateStateResultOk226861 = Result.match<
            import("better-result").InferOk<NonNullable<typeof intermediateState>>,
            import("better-result").InferErr<NonNullable<typeof intermediateState>>,
            boolean
          >(intermediateState, {
            ok: (value) => {
              $intermediateStateResultValue226861 = value;
              return true;
            },
            err: (error) => {
              $intermediateStateResultError226861 = error;
              return false;
            },
          });
          if (($intermediateStateResultOk226861 ? "ok" : "error") === "error")
            return Result.err($intermediateStateResultError226861);
          currentState = $intermediateStateResultValue226861;
        }
      }
      const finalEntry = input.entries.at(-1);
      if (finalEntry === undefined) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitSteeringHistoryBoundary",
            "Steering boundary lost its final entry",
          ),
        );
      }
      const fullHeads = {
        modelHeadId: this.internChain(input.sessionId, "model", input.mergedModelMessages),
        uiHeadId: this.internChain(input.sessionId, "ui", input.uiMessages),
      };
      this.setTranscriptHeads(input.sessionId, fullHeads.modelHeadId, fullHeads.uiHeadId);
      this.clearHistoryRedo(input.sessionId);
      const updated = this.database
        .query(
          `UPDATE sessions
           SET queued_steering_count = queued_steering_count - ?, updated_at = ?
           WHERE id = ? AND queued_steering_count >= ?`,
        )
        .run(input.entries.length, new Date().toISOString(), input.sessionId, input.entries.length);
      if (updated.changes !== 1) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitSteeringHistoryBoundary",
            "Steering boundary consumed more entries than the session has queued",
          ),
        );
      }
      const openTransition = this.getHistoryTransitionResult(finalEntry.transitionId);
      let $openTransitionResultValue228328!: import("better-result").InferOk<
        NonNullable<typeof openTransition>
      >;
      let $openTransitionResultError228328!: import("better-result").InferErr<
        NonNullable<typeof openTransition>
      >;
      const $openTransitionResultOk228328 = Result.match<
        import("better-result").InferOk<NonNullable<typeof openTransition>>,
        import("better-result").InferErr<NonNullable<typeof openTransition>>,
        boolean
      >(openTransition, {
        ok: (value) => {
          $openTransitionResultValue228328 = value;
          return true;
        },
        err: (error) => {
          $openTransitionResultError228328 = error;
          return false;
        },
      });
      if (($openTransitionResultOk228328 ? "ok" : "error") === "error")
        return Result.err($openTransitionResultError228328);
      return Result.ok({
        currentState,
        openTransition: $openTransitionResultValue228328,
      });
    });
  }

  commitHistoryCompaction(input: CommitStoredHistoryCompaction): CommittedStoredHistoryCompaction {
    return storeResultToLegacy(this.commitHistoryCompactionResult(input));
  }

  commitHistoryCompactionResult(
    input: CommitStoredHistoryCompaction,
  ): ResultType<CommittedStoredHistoryCompaction, MiniLilacStoreOperationError> {
    if (Object.prototype.hasOwnProperty.call(input, "uiMessages")) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "commitHistoryCompaction",
          "Manual history compaction does not accept a replacement UI transcript",
        ),
      );
    }
    const result = input.result;
    const compactionEvent = input.compactionEvent;
    if (result.clientCommandId !== input.commandId) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "commitHistoryCompaction",
          `Compaction result does not belong to command '${input.commandId}'`,
        ),
      );
    }
    if (
      compactionEvent.source !== "manual" ||
      compactionEvent.reason !== "manual" ||
      compactionEvent.phase !== "completed" ||
      compactionEvent.outcome !== result.status ||
      compactionEvent.messageCountBefore !== result.messageCountBefore ||
      compactionEvent.messageCountAfter !== result.messageCountAfter ||
      compactionEvent.estimatedInputTokensBefore !== result.estimatedInputTokensBefore ||
      compactionEvent.estimatedInputTokensAfter !== result.estimatedInputTokensAfter ||
      compactionEvent.error !== undefined
    ) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "commitHistoryCompaction",
          "Manual compaction event does not match its compact result",
        ),
      );
    }
    if (input.request.kind !== "compact" || input.request.runId !== null) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "commitHistoryCompaction",
          "History compaction requires a session-scoped compact command",
        ),
      );
    }
    const command = decodeCanonicalStoredCommandRequest(input.request);
    let $commandResultValue230621!: import("better-result").InferOk<NonNullable<typeof command>>;
    let $commandResultError230621!: import("better-result").InferErr<NonNullable<typeof command>>;
    const $commandResultOk230621 = Result.match<
      import("better-result").InferOk<NonNullable<typeof command>>,
      import("better-result").InferErr<NonNullable<typeof command>>,
      boolean
    >(command, {
      ok: (value) => {
        $commandResultValue230621 = value;
        return true;
      },
      err: (error) => {
        $commandResultError230621 = error;
        return false;
      },
    });
    if (($commandResultOk230621 ? "ok" : "error") === "error")
      return Result.err($commandResultError230621);
    return this.runStoreTransactionResult("commitHistoryCompaction", () => {
      const quiescent = this.requireQuiescentHistorySessionResult(
        input.sessionId,
        input.expectedCurrentStateId,
        ["idle", "error", "compacting"],
      );
      const quiescenceError = quiescent.match({ ok: () => null, err: (error) => error });
      if (quiescenceError !== null) return Result.err(quiescenceError);
      const workspace = this.getWorkspaceForSessionResult(input.sessionId);
      let $workspaceResultValue231098!: import("better-result").InferOk<
        NonNullable<typeof workspace>
      >;
      let $workspaceResultError231098!: import("better-result").InferErr<
        NonNullable<typeof workspace>
      >;
      const $workspaceResultOk231098 = Result.match<
        import("better-result").InferOk<NonNullable<typeof workspace>>,
        import("better-result").InferErr<NonNullable<typeof workspace>>,
        boolean
      >(workspace, {
        ok: (value) => {
          $workspaceResultValue231098 = value;
          return true;
        },
        err: (error) => {
          $workspaceResultError231098 = error;
          return false;
        },
      });
      if (($workspaceResultOk231098 ? "ok" : "error") === "error")
        return Result.err($workspaceResultError231098);
      const available = this.assertWorkspaceHasNoHistoryJournalResult(
        $workspaceResultValue231098.id,
      );
      const availabilityError = available.match({ ok: () => null, err: (error) => error });
      if (availabilityError !== null) return Result.err(availabilityError);
      const commandRow = this.getStoredCommandResult(input.sessionId, input.commandId);
      let $commandRowResultValue231417!: import("better-result").InferOk<
        NonNullable<typeof commandRow>
      >;
      let $commandRowResultError231417!: import("better-result").InferErr<
        NonNullable<typeof commandRow>
      >;
      const $commandRowResultOk231417 = Result.match<
        import("better-result").InferOk<NonNullable<typeof commandRow>>,
        import("better-result").InferErr<NonNullable<typeof commandRow>>,
        boolean
      >(commandRow, {
        ok: (value) => {
          $commandRowResultValue231417 = value;
          return true;
        },
        err: (error) => {
          $commandRowResultError231417 = error;
          return false;
        },
      });
      if (($commandRowResultOk231417 ? "ok" : "error") === "error")
        return Result.err($commandRowResultError231417);
      if (
        $commandRowResultValue231417.kind !== input.request.kind ||
        $commandRowResultValue231417.run_id !== null ||
        $commandRowResultValue231417.side_effect_started !== 0 ||
        $commandRowResultValue231417.result_json !== null ||
        $commandRowResultValue231417.request_fingerprint !==
          $commandResultValue230621.fingerprint ||
        $commandRowResultValue231417.request_json !== $commandResultValue230621.json
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitHistoryCompaction",
            `Compaction command '${input.commandId}' is not an admissible reservation`,
          ),
        );
      }
      const now = new Date().toISOString();
      if (result.status !== "compacted") {
        const saved = this.database
          .query(
            `UPDATE commands SET side_effect_started = 1, result_json = ?
             WHERE session_id = ? AND command_id = ? AND side_effect_started = 0
               AND result_json IS NULL`,
          )
          .run(serialize(result), input.sessionId, input.commandId);
        if (saved.changes !== 1) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "commitHistoryCompaction",
              `Compaction command '${input.commandId}' could not be saved atomically`,
            ),
          );
        }
        this.database
          .query(
            `UPDATE sessions SET status = 'idle', active_run_id = NULL,
               queued_steering_count = 0, updated_at = ? WHERE id = ?`,
          )
          .run(now, input.sessionId);
        const state = this.getCurrentHistoryStateResult(input.sessionId);
        let $stateResultValue233100!: import("better-result").InferOk<NonNullable<typeof state>>;
        let $stateResultError233100!: import("better-result").InferErr<NonNullable<typeof state>>;
        const $stateResultOk233100 = Result.match<
          import("better-result").InferOk<NonNullable<typeof state>>,
          import("better-result").InferErr<NonNullable<typeof state>>,
          boolean
        >(state, {
          ok: (value) => {
            $stateResultValue233100 = value;
            return true;
          },
          err: (error) => {
            $stateResultError233100 = error;
            return false;
          },
        });
        if (($stateResultOk233100 ? "ok" : "error") === "error")
          return Result.err($stateResultError233100);
        const snapshot = this.getSessionResult(input.sessionId);
        let $snapshotResultValue233244!: import("better-result").InferOk<
          NonNullable<typeof snapshot>
        >;
        let $snapshotResultError233244!: import("better-result").InferErr<
          NonNullable<typeof snapshot>
        >;
        const $snapshotResultOk233244 = Result.match<
          import("better-result").InferOk<NonNullable<typeof snapshot>>,
          import("better-result").InferErr<NonNullable<typeof snapshot>>,
          boolean
        >(snapshot, {
          ok: (value) => {
            $snapshotResultValue233244 = value;
            return true;
          },
          err: (error) => {
            $snapshotResultError233244 = error;
            return false;
          },
        });
        if (($snapshotResultOk233244 ? "ok" : "error") === "error")
          return Result.err($snapshotResultError233244);
        return Result.ok({ state: $stateResultValue233100, snapshot: $snapshotResultValue233244 });
      }
      const current = this.getCurrentHistoryStateResult(input.sessionId);
      let $currentResultValue233467!: import("better-result").InferOk<NonNullable<typeof current>>;
      let $currentResultError233467!: import("better-result").InferErr<NonNullable<typeof current>>;
      const $currentResultOk233467 = Result.match<
        import("better-result").InferOk<NonNullable<typeof current>>,
        import("better-result").InferErr<NonNullable<typeof current>>,
        boolean
      >(current, {
        ok: (value) => {
          $currentResultValue233467 = value;
          return true;
        },
        err: (error) => {
          $currentResultError233467 = error;
          return false;
        },
      });
      if (($currentResultOk233467 ? "ok" : "error") === "error")
        return Result.err($currentResultError233467);
      let fromState = $currentResultValue233467;
      if (input.observation !== undefined) {
        const observed = this.insertWorkspaceObservationResult(
          input.sessionId,
          fromState,
          { modelHeadId: fromState.modelHeadId, uiHeadId: fromState.uiHeadId },
          input.observation,
        );
        let $observedResultValue233697!: import("better-result").InferOk<
          NonNullable<typeof observed>
        >;
        let $observedResultError233697!: import("better-result").InferErr<
          NonNullable<typeof observed>
        >;
        const $observedResultOk233697 = Result.match<
          import("better-result").InferOk<NonNullable<typeof observed>>,
          import("better-result").InferErr<NonNullable<typeof observed>>,
          boolean
        >(observed, {
          ok: (value) => {
            $observedResultValue233697 = value;
            return true;
          },
          err: (error) => {
            $observedResultError233697 = error;
            return false;
          },
        });
        if (($observedResultOk233697 ? "ok" : "error") === "error")
          return Result.err($observedResultError233697);
        fromState = $observedResultValue233697;
        const moved = this.moveHistoryCursorResult(input.sessionId, fromState);
        const moveError = moved.match({ ok: () => null, err: (error) => error });
        if (moveError !== null) return Result.err(moveError);
      }
      if (input.providerState !== undefined) {
        const conservative = this.assertConservativeProviderTransitionResult(
          fromState.id,
          input.providerState,
        );
        const transitionError = conservative.match({ ok: () => null, err: (error) => error });
        if (transitionError !== null) return Result.err(transitionError);
      }
      const uiMessages = this.getUiMessagesResult(input.sessionId);
      let $uiMessagesResultValue234480!: import("better-result").InferOk<
        NonNullable<typeof uiMessages>
      >;
      let $uiMessagesResultError234480!: import("better-result").InferErr<
        NonNullable<typeof uiMessages>
      >;
      const $uiMessagesResultOk234480 = Result.match<
        import("better-result").InferOk<NonNullable<typeof uiMessages>>,
        import("better-result").InferErr<NonNullable<typeof uiMessages>>,
        boolean
      >(uiMessages, {
        ok: (value) => {
          $uiMessagesResultValue234480 = value;
          return true;
        },
        err: (error) => {
          $uiMessagesResultError234480 = error;
          return false;
        },
      });
      if (($uiMessagesResultOk234480 ? "ok" : "error") === "error")
        return Result.err($uiMessagesResultError234480);
      const heads = {
        modelHeadId: this.internChain(input.sessionId, "model", input.modelMessages),
        uiHeadId: this.internChain(input.sessionId, "ui", [
          ...$uiMessagesResultValue234480,
          {
            id: `compaction:${input.commandId}`,
            role: "assistant",
            parts: [
              {
                type: "data-compaction",
                id: input.commandId,
                data: compactionEvent,
              },
            ],
          },
        ]),
      };
      const appended = this.appendHistoryTransitionResult({
        state: {
          id: input.stateId,
          sessionId: input.sessionId,
          workspaceId: $workspaceResultValue231098.id,
          modelHeadId: heads.modelHeadId,
          uiHeadId: heads.uiHeadId,
          workspaceSnapshotId: input.workspaceSnapshotId,
          workspaceStatus: input.workspaceStatus,
          workspaceUnavailableReason: input.workspaceUnavailableReason,
          origin: "compaction",
          providerState: input.providerState,
        },
        transition: {
          id: input.transitionId,
          sessionId: input.sessionId,
          fromStateId: fromState.id,
          kind: "compaction",
        },
        select: true,
        clearRedo: true,
      });
      let $appendedResultValue235137!: import("better-result").InferOk<
        NonNullable<typeof appended>
      >;
      let $appendedResultError235137!: import("better-result").InferErr<
        NonNullable<typeof appended>
      >;
      const $appendedResultOk235137 = Result.match<
        import("better-result").InferOk<NonNullable<typeof appended>>,
        import("better-result").InferErr<NonNullable<typeof appended>>,
        boolean
      >(appended, {
        ok: (value) => {
          $appendedResultValue235137 = value;
          return true;
        },
        err: (error) => {
          $appendedResultError235137 = error;
          return false;
        },
      });
      if (($appendedResultOk235137 ? "ok" : "error") === "error")
        return Result.err($appendedResultError235137);
      const floor = this.setHistoryUndoFloorResult(
        input.sessionId,
        $appendedResultValue235137.state.id,
      );
      const floorError = floor.match({ ok: () => null, err: (error) => error });
      if (floorError !== null) return Result.err(floorError);
      const saved = this.database
        .query(
          `UPDATE commands SET side_effect_started = 1, result_json = ?
           WHERE session_id = ? AND command_id = ? AND side_effect_started = 0
             AND result_json IS NULL`,
        )
        .run(serialize(result), input.sessionId, input.commandId);
      if (saved.changes !== 1) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitHistoryCompaction",
            `Compaction command '${input.commandId}' could not be saved atomically`,
          ),
        );
      }
      this.database
        .query(
          `UPDATE sessions SET status = 'idle', active_run_id = NULL,
             queued_steering_count = 0, input_tokens = ?, input_tokens_estimated = ?,
             updated_at = ? WHERE id = ?`,
        )
        .run(
          result.estimatedInputTokensAfter ?? null,
          result.estimatedInputTokensAfter === undefined ? 0 : 1,
          now,
          input.sessionId,
        );
      const snapshot = this.getSessionResult(input.sessionId);
      let $snapshotResultValue237140!: import("better-result").InferOk<
        NonNullable<typeof snapshot>
      >;
      let $snapshotResultError237140!: import("better-result").InferErr<
        NonNullable<typeof snapshot>
      >;
      const $snapshotResultOk237140 = Result.match<
        import("better-result").InferOk<NonNullable<typeof snapshot>>,
        import("better-result").InferErr<NonNullable<typeof snapshot>>,
        boolean
      >(snapshot, {
        ok: (value) => {
          $snapshotResultValue237140 = value;
          return true;
        },
        err: (error) => {
          $snapshotResultError237140 = error;
          return false;
        },
      });
      if (($snapshotResultOk237140 ? "ok" : "error") === "error")
        return Result.err($snapshotResultError237140);
      return Result.ok({
        state: $appendedResultValue235137.state,
        snapshot: $snapshotResultValue237140,
      });
    });
  }

  private appendHistoryTransition(input: {
    readonly state: CreateStoredHistoryState;
    readonly transition:
      | Omit<Extract<CreateStoredHistoryTransition, { kind: "user-message" }>, "toStateId">
      | Omit<
          Extract<CreateStoredHistoryTransition, { kind: "workspace-observation" | "compaction" }>,
          "toStateId"
        >;
    readonly select?: boolean;
    readonly clearRedo?: boolean;
  }): { readonly state: StoredHistoryState; readonly transition: StoredHistoryTransition } {
    return storeResultToLegacy(this.appendHistoryTransitionResult(input));
  }

  private appendHistoryTransitionResult(input: {
    readonly state: CreateStoredHistoryState;
    readonly transition:
      | Omit<Extract<CreateStoredHistoryTransition, { kind: "user-message" }>, "toStateId">
      | Omit<
          Extract<CreateStoredHistoryTransition, { kind: "workspace-observation" | "compaction" }>,
          "toStateId"
        >;
    readonly select?: boolean;
    readonly clearRedo?: boolean;
  }): ResultType<
    { readonly state: StoredHistoryState; readonly transition: StoredHistoryTransition },
    MiniLilacStoreOperationError
  > {
    return this.runStoreTransactionResult<
      { readonly state: StoredHistoryState; readonly transition: StoredHistoryTransition },
      MiniLilacStoreOperationError
    >("appendHistoryTransition", () => {
      if (input.state.sessionId !== input.transition.sessionId) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "appendHistoryTransition",
            `History transition '${input.transition.id}' crosses sessions`,
          ),
        );
      }
      this.insertHistoryStateRow(input.state);
      this.insertHistoryTransitionRow({ ...input.transition, toStateId: input.state.id });
      if (input.clearRedo) {
        this.database
          .query("DELETE FROM history_redo_stack WHERE session_id = ?")
          .run(input.state.sessionId);
      }
      if (input.select) {
        const history = this.getSessionHistoryResult(input.state.sessionId);
        let $historyResultValue239363!: import("better-result").InferOk<
          NonNullable<typeof history>
        >;
        let $historyResultError239363!: import("better-result").InferErr<
          NonNullable<typeof history>
        >;
        const $historyResultOk239363 = Result.match<
          import("better-result").InferOk<NonNullable<typeof history>>,
          import("better-result").InferErr<NonNullable<typeof history>>,
          boolean
        >(history, {
          ok: (value) => {
            $historyResultValue239363 = value;
            return true;
          },
          err: (error) => {
            $historyResultError239363 = error;
            return false;
          },
        });
        if (($historyResultOk239363 ? "ok" : "error") === "error")
          return Result.err($historyResultError239363);
        if (
          !this.isStateInAncestry(
            input.state.sessionId,
            input.state.id,
            $historyResultValue239363.undoFloorStateId,
          )
        ) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "appendHistoryTransition",
              `History state '${input.state.id}' is below the current undo floor`,
            ),
          );
        }
        this.setTranscriptHeads(
          input.state.sessionId,
          input.state.modelHeadId,
          input.state.uiHeadId,
        );
        const updated = this.database
          .query(
            `UPDATE session_history SET current_state_id = ?, updated_at = ?
             WHERE session_id = ?`,
          )
          .run(input.state.id, new Date().toISOString(), input.state.sessionId);
        if (updated.changes !== 1) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "appendHistoryTransition",
              `Session '${input.state.sessionId}' has no history cursor`,
            ),
          );
        }
      }
      const state = this.getHistoryStateResult(input.state.id);
      let $stateResultValue240601!: import("better-result").InferOk<NonNullable<typeof state>>;
      let $stateResultError240601!: import("better-result").InferErr<NonNullable<typeof state>>;
      const $stateResultOk240601 = Result.match<
        import("better-result").InferOk<NonNullable<typeof state>>,
        import("better-result").InferErr<NonNullable<typeof state>>,
        boolean
      >(state, {
        ok: (value) => {
          $stateResultValue240601 = value;
          return true;
        },
        err: (error) => {
          $stateResultError240601 = error;
          return false;
        },
      });
      if (($stateResultOk240601 ? "ok" : "error") === "error")
        return Result.err($stateResultError240601);
      const transition = this.getHistoryTransitionResult(input.transition.id);
      let $transitionResultValue240733!: import("better-result").InferOk<
        NonNullable<typeof transition>
      >;
      let $transitionResultError240733!: import("better-result").InferErr<
        NonNullable<typeof transition>
      >;
      const $transitionResultOk240733 = Result.match<
        import("better-result").InferOk<NonNullable<typeof transition>>,
        import("better-result").InferErr<NonNullable<typeof transition>>,
        boolean
      >(transition, {
        ok: (value) => {
          $transitionResultValue240733 = value;
          return true;
        },
        err: (error) => {
          $transitionResultError240733 = error;
          return false;
        },
      });
      if (($transitionResultOk240733 ? "ok" : "error") === "error")
        return Result.err($transitionResultError240733);
      return Result.ok({
        state: $stateResultValue240601,
        transition: $transitionResultValue240733,
      });
    });
  }

  private closeHistoryTransition(
    transitionId: string,
    destination: CreateStoredHistoryState,
    options: { readonly select?: boolean; readonly clearRedo?: boolean } = {},
  ): StoredHistoryTransition {
    return storeResultToLegacy(
      this.closeHistoryTransitionResult(transitionId, destination, options),
    );
  }

  private closeHistoryTransitionResult(
    transitionId: string,
    destination: CreateStoredHistoryState,
    options: { readonly select?: boolean; readonly clearRedo?: boolean } = {},
  ): ResultType<StoredHistoryTransition, MiniLilacStoreOperationError> {
    return this.runStoreTransactionResult("closeHistoryTransition", () => {
      const transition = this.getHistoryTransitionResult(transitionId);
      let $transitionResultValue241652!: import("better-result").InferOk<
        NonNullable<typeof transition>
      >;
      let $transitionResultError241652!: import("better-result").InferErr<
        NonNullable<typeof transition>
      >;
      const $transitionResultOk241652 = Result.match<
        import("better-result").InferOk<NonNullable<typeof transition>>,
        import("better-result").InferErr<NonNullable<typeof transition>>,
        boolean
      >(transition, {
        ok: (value) => {
          $transitionResultValue241652 = value;
          return true;
        },
        err: (error) => {
          $transitionResultError241652 = error;
          return false;
        },
      });
      if (($transitionResultOk241652 ? "ok" : "error") === "error")
        return Result.err($transitionResultError241652);
      if (
        $transitionResultValue241652.toStateId !== null ||
        $transitionResultValue241652.kind !== "user-message"
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "closeHistoryTransition",
            `History transition '${transitionId}' is not an open user transition`,
          ),
        );
      }
      if (
        destination.sessionId !== $transitionResultValue241652.sessionId ||
        destination.origin !== "turn-boundary"
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "closeHistoryTransition",
            `History transition '${transitionId}' has an invalid destination state`,
          ),
        );
      }
      const connected = this.assertStateConnectedToRootResult(
        $transitionResultValue241652.sessionId,
        $transitionResultValue241652.fromStateId,
      );
      const connectionError = connected.match({ ok: () => null, err: (error) => error });
      if (connectionError !== null) return Result.err(connectionError);
      this.insertHistoryStateRow(destination);
      const validDestination = this.validateHistoryTransitionDestinationResult(
        $transitionResultValue241652.sessionId,
        $transitionResultValue241652.fromStateId,
        destination.id,
        $transitionResultValue241652.kind,
      );
      const destinationError = validDestination.match({ ok: () => null, err: (error) => error });
      if (destinationError !== null) return Result.err(destinationError);
      const completedAt = new Date().toISOString();
      const updated = this.database
        .query(
          `UPDATE history_transitions SET to_state_id = ?, completed_at = ?
           WHERE id = ? AND to_state_id IS NULL AND completed_at IS NULL`,
        )
        .run(destination.id, completedAt, transitionId);
      if (updated.changes !== 1) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "closeHistoryTransition",
            `History transition '${transitionId}' could not be closed`,
          ),
        );
      }
      if (options.clearRedo) {
        this.database
          .query("DELETE FROM history_redo_stack WHERE session_id = ?")
          .run($transitionResultValue241652.sessionId);
      }
      if (options.select) {
        const history = this.getSessionHistoryResult($transitionResultValue241652.sessionId);
        let $historyResultValue243822!: import("better-result").InferOk<
          NonNullable<typeof history>
        >;
        let $historyResultError243822!: import("better-result").InferErr<
          NonNullable<typeof history>
        >;
        const $historyResultOk243822 = Result.match<
          import("better-result").InferOk<NonNullable<typeof history>>,
          import("better-result").InferErr<NonNullable<typeof history>>,
          boolean
        >(history, {
          ok: (value) => {
            $historyResultValue243822 = value;
            return true;
          },
          err: (error) => {
            $historyResultError243822 = error;
            return false;
          },
        });
        if (($historyResultOk243822 ? "ok" : "error") === "error")
          return Result.err($historyResultError243822);
        if (
          !this.isStateInAncestry(
            $transitionResultValue241652.sessionId,
            destination.id,
            $historyResultValue243822.undoFloorStateId,
          )
        ) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "closeHistoryTransition",
              `History state '${destination.id}' is below the current undo floor`,
            ),
          );
        }
        this.setTranscriptHeads(
          $transitionResultValue241652.sessionId,
          destination.modelHeadId,
          destination.uiHeadId,
        );
        this.database
          .query(
            `UPDATE session_history SET current_state_id = ?, updated_at = ?
             WHERE session_id = ?`,
          )
          .run(destination.id, new Date().toISOString(), $transitionResultValue241652.sessionId);
      }
      return this.getHistoryTransitionResult(transitionId);
    });
  }

  private setHistoryUndoFloor(sessionId: string, stateId: string): void {
    storeResultToLegacy(this.setHistoryUndoFloorResult(sessionId, stateId));
  }

  private setHistoryUndoFloorResult(
    sessionId: string,
    stateId: string,
  ): ResultType<void, MiniLilacStoreOperationError> {
    return this.runStoreTransactionResult<void, MiniLilacStoreOperationError>(
      "setHistoryUndoFloor",
      () => {
        const state = this.getHistoryStateResult(stateId);
        let $stateResultValue245289!: import("better-result").InferOk<NonNullable<typeof state>>;
        let $stateResultError245289!: import("better-result").InferErr<NonNullable<typeof state>>;
        const $stateResultOk245289 = Result.match<
          import("better-result").InferOk<NonNullable<typeof state>>,
          import("better-result").InferErr<NonNullable<typeof state>>,
          boolean
        >(state, {
          ok: (value) => {
            $stateResultValue245289 = value;
            return true;
          },
          err: (error) => {
            $stateResultError245289 = error;
            return false;
          },
        });
        if (($stateResultOk245289 ? "ok" : "error") === "error")
          return Result.err($stateResultError245289);
        if ($stateResultValue245289.sessionId !== sessionId) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "setHistoryUndoFloor",
              `History state '${stateId}' does not belong to session '${sessionId}'`,
            ),
          );
        }
        const connected = this.assertStateConnectedToRootResult(sessionId, stateId);
        const connectionError = connected.match({ ok: () => null, err: (error) => error });
        if (connectionError !== null) return Result.err(connectionError);
        const history = this.getSessionHistoryResult(sessionId);
        let $historyResultValue245865!: import("better-result").InferOk<
          NonNullable<typeof history>
        >;
        let $historyResultError245865!: import("better-result").InferErr<
          NonNullable<typeof history>
        >;
        const $historyResultOk245865 = Result.match<
          import("better-result").InferOk<NonNullable<typeof history>>,
          import("better-result").InferErr<NonNullable<typeof history>>,
          boolean
        >(history, {
          ok: (value) => {
            $historyResultValue245865 = value;
            return true;
          },
          err: (error) => {
            $historyResultError245865 = error;
            return false;
          },
        });
        if (($historyResultOk245865 ? "ok" : "error") === "error")
          return Result.err($historyResultError245865);
        const currentStateId = $historyResultValue245865.currentStateId;
        if (!this.isStateInAncestry(sessionId, currentStateId, stateId)) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "setHistoryUndoFloor",
              `History state '${stateId}' is not an ancestor of the current state`,
            ),
          );
        }
        const updated = this.database
          .query(
            `UPDATE session_history SET undo_floor_state_id = ?, updated_at = ?
           WHERE session_id = ?`,
          )
          .run(stateId, new Date().toISOString(), sessionId);
        if (updated.changes !== 1) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "setHistoryUndoFloor",
              `Session '${sessionId}' has no history cursor`,
            ),
          );
        }
        return Result.ok(undefined);
      },
    );
  }

  private pushHistoryRedo(
    sessionId: string,
    targetStateId: string,
    userTransitionId: string,
  ): StoredHistoryRedoEntry {
    return storeResultToLegacy(
      this.pushHistoryRedoResult(sessionId, targetStateId, userTransitionId),
    );
  }

  private pushHistoryRedoResult(
    sessionId: string,
    targetStateId: string,
    userTransitionId: string,
  ): ResultType<StoredHistoryRedoEntry, MiniLilacStoreOperationError> {
    return this.runStoreTransactionResult<StoredHistoryRedoEntry, MiniLilacStoreOperationError>(
      "pushHistoryRedo",
      () => {
        const target = this.getHistoryStateResult(targetStateId);
        let $targetResultValue247499!: import("better-result").InferOk<NonNullable<typeof target>>;
        let $targetResultError247499!: import("better-result").InferErr<NonNullable<typeof target>>;
        const $targetResultOk247499 = Result.match<
          import("better-result").InferOk<NonNullable<typeof target>>,
          import("better-result").InferErr<NonNullable<typeof target>>,
          boolean
        >(target, {
          ok: (value) => {
            $targetResultValue247499 = value;
            return true;
          },
          err: (error) => {
            $targetResultError247499 = error;
            return false;
          },
        });
        if (($targetResultOk247499 ? "ok" : "error") === "error")
          return Result.err($targetResultError247499);
        const transition = this.getHistoryTransitionResult(userTransitionId);
        let $transitionResultValue247637!: import("better-result").InferOk<
          NonNullable<typeof transition>
        >;
        let $transitionResultError247637!: import("better-result").InferErr<
          NonNullable<typeof transition>
        >;
        const $transitionResultOk247637 = Result.match<
          import("better-result").InferOk<NonNullable<typeof transition>>,
          import("better-result").InferErr<NonNullable<typeof transition>>,
          boolean
        >(transition, {
          ok: (value) => {
            $transitionResultValue247637 = value;
            return true;
          },
          err: (error) => {
            $transitionResultError247637 = error;
            return false;
          },
        });
        if (($transitionResultOk247637 ? "ok" : "error") === "error")
          return Result.err($transitionResultError247637);
        if (
          $targetResultValue247499.sessionId !== sessionId ||
          $transitionResultValue247637.sessionId !== sessionId ||
          $transitionResultValue247637.kind !== "user-message" ||
          $transitionResultValue247637.toStateId === null ||
          !this.isStateInAncestry(sessionId, targetStateId, $transitionResultValue247637.toStateId)
        ) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "pushHistoryRedo",
              `Invalid redo entry for session '${sessionId}'`,
            ),
          );
        }
        const connected = this.assertStateConnectedToRootResult(sessionId, targetStateId);
        const connectionError = connected.match({ ok: () => null, err: (error) => error });
        if (connectionError !== null) return Result.err(connectionError);
        const position = decodeRequiredMiniLilacStoreRow({
          kind: "position",
          row: this.database
            .query(
              `SELECT COALESCE(MAX(position), -1) + 1 AS position
                 FROM history_redo_stack WHERE session_id = ?`,
            )
            .get(sessionId),
          schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
          recordId: `${sessionId}:next-redo-position`,
        });
        let $positionResultValue248490!: import("better-result").InferOk<
          NonNullable<typeof position>
        >;
        let $positionResultError248490!: import("better-result").InferErr<
          NonNullable<typeof position>
        >;
        const $positionResultOk248490 = Result.match<
          import("better-result").InferOk<NonNullable<typeof position>>,
          import("better-result").InferErr<NonNullable<typeof position>>,
          boolean
        >(position, {
          ok: (value) => {
            $positionResultValue248490 = value;
            return true;
          },
          err: (error) => {
            $positionResultError248490 = error;
            return false;
          },
        });
        if (($positionResultOk248490 ? "ok" : "error") === "error")
          return Result.err($positionResultError248490);
        this.database
          .query(
            `INSERT INTO history_redo_stack
            (session_id, position, target_state_id, user_transition_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            sessionId,
            $positionResultValue248490.position,
            targetStateId,
            userTransitionId,
            new Date().toISOString(),
          );
        const entry = this.peekHistoryRedoResult(sessionId);
        let $entryResultValue249403!: import("better-result").InferOk<NonNullable<typeof entry>>;
        let $entryResultError249403!: import("better-result").InferErr<NonNullable<typeof entry>>;
        const $entryResultOk249403 = Result.match<
          import("better-result").InferOk<NonNullable<typeof entry>>,
          import("better-result").InferErr<NonNullable<typeof entry>>,
          boolean
        >(entry, {
          ok: (value) => {
            $entryResultValue249403 = value;
            return true;
          },
          err: (error) => {
            $entryResultError249403 = error;
            return false;
          },
        });
        if (($entryResultOk249403 ? "ok" : "error") === "error")
          return Result.err($entryResultError249403);
        if ($entryResultValue249403 === null) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "pushHistoryRedo",
              `Redo entry for session '${sessionId}' was not created`,
            ),
          );
        }
        return Result.ok($entryResultValue249403);
      },
    );
  }

  private popHistoryRedo(sessionId: string): StoredHistoryRedoEntry | null {
    return storeResultToLegacy(this.popHistoryRedoResult(sessionId));
  }

  private popHistoryRedoResult(
    sessionId: string,
  ): ResultType<StoredHistoryRedoEntry | null, MiniLilacStoreOperationError> {
    return this.runStoreTransactionResult<
      StoredHistoryRedoEntry | null,
      MiniLilacStoreOperationError
    >("popHistoryRedo", () => {
      const entry = this.peekHistoryRedoResult(sessionId);
      let $entryResultValue250275!: import("better-result").InferOk<NonNullable<typeof entry>>;
      let $entryResultError250275!: import("better-result").InferErr<NonNullable<typeof entry>>;
      const $entryResultOk250275 = Result.match<
        import("better-result").InferOk<NonNullable<typeof entry>>,
        import("better-result").InferErr<NonNullable<typeof entry>>,
        boolean
      >(entry, {
        ok: (value) => {
          $entryResultValue250275 = value;
          return true;
        },
        err: (error) => {
          $entryResultError250275 = error;
          return false;
        },
      });
      if (($entryResultOk250275 ? "ok" : "error") === "error")
        return Result.err($entryResultError250275);
      if ($entryResultValue250275 === null) return Result.ok(null);
      this.database
        .query("DELETE FROM history_redo_stack WHERE session_id = ? AND position = ?")
        .run(sessionId, $entryResultValue250275.position);
      return Result.ok($entryResultValue250275);
    });
  }

  private clearHistoryRedo(sessionId: string): void {
    this.database.query("DELETE FROM history_redo_stack WHERE session_id = ?").run(sessionId);
  }

  commitEmptyHistoryNavigation(
    input: CommitEmptyStoredHistoryNavigation,
  ): CommittedEmptyStoredHistoryNavigation {
    return storeResultToLegacy(this.commitEmptyHistoryNavigationResult(input));
  }

  commitEmptyHistoryNavigationResult(
    input: CommitEmptyStoredHistoryNavigation,
  ): ResultType<CommittedEmptyStoredHistoryNavigation, MiniLilacStoreOperationError> {
    if (input.request.kind !== input.requestedAction || input.request.runId !== null) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "commitEmptyHistoryNavigation",
          "Empty history navigation requires a matching session-scoped command",
        ),
      );
    }
    if (input.result.status !== "empty") {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "commitEmptyHistoryNavigation",
          "Empty history navigation must persist an empty result",
        ),
      );
    }
    const decodedInputResult = decodeStoredHistoryNavigationResult(input.result);
    let $decodedInputResultResultValue251738!: import("better-result").InferOk<
      NonNullable<typeof decodedInputResult>
    >;
    let $decodedInputResultResultError251738!: import("better-result").InferErr<
      NonNullable<typeof decodedInputResult>
    >;
    const $decodedInputResultResultOk251738 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decodedInputResult>>,
      import("better-result").InferErr<NonNullable<typeof decodedInputResult>>,
      boolean
    >(decodedInputResult, {
      ok: (value) => {
        $decodedInputResultResultValue251738 = value;
        return true;
      },
      err: (error) => {
        $decodedInputResultResultError251738 = error;
        return false;
      },
    });
    if (($decodedInputResultResultOk251738 ? "ok" : "error") === "error")
      return Result.err($decodedInputResultResultError251738);
    const result = this.validateHistoryNavigationResult(
      input.requestedAction,
      $decodedInputResultResultValue251738,
      input.commandId,
      null,
    );
    let $resultResultValue251912!: import("better-result").InferOk<NonNullable<typeof result>>;
    let $resultResultError251912!: import("better-result").InferErr<NonNullable<typeof result>>;
    const $resultResultOk251912 = Result.match<
      import("better-result").InferOk<NonNullable<typeof result>>,
      import("better-result").InferErr<NonNullable<typeof result>>,
      boolean
    >(result, {
      ok: (value) => {
        $resultResultValue251912 = value;
        return true;
      },
      err: (error) => {
        $resultResultError251912 = error;
        return false;
      },
    });
    if (($resultResultOk251912 ? "ok" : "error") === "error")
      return Result.err($resultResultError251912);
    if ($resultResultValue251912.status !== "empty") {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "commitEmptyHistoryNavigation",
          "Empty history navigation must persist an empty result",
        ),
      );
    }
    const emptyResult = $resultResultValue251912;
    const canonicalCommand = decodeCanonicalStoredCommandRequest(input.request);
    let $canonicalCommandResultValue252420!: import("better-result").InferOk<
      NonNullable<typeof canonicalCommand>
    >;
    let $canonicalCommandResultError252420!: import("better-result").InferErr<
      NonNullable<typeof canonicalCommand>
    >;
    const $canonicalCommandResultOk252420 = Result.match<
      import("better-result").InferOk<NonNullable<typeof canonicalCommand>>,
      import("better-result").InferErr<NonNullable<typeof canonicalCommand>>,
      boolean
    >(canonicalCommand, {
      ok: (value) => {
        $canonicalCommandResultValue252420 = value;
        return true;
      },
      err: (error) => {
        $canonicalCommandResultError252420 = error;
        return false;
      },
    });
    if (($canonicalCommandResultOk252420 ? "ok" : "error") === "error")
      return Result.err($canonicalCommandResultError252420);
    return this.runStoreTransactionResult("commitEmptyHistoryNavigation", () => {
      const command = this.getStoredCommandResult(input.sessionId, input.commandId);
      let $commandResultValue252673!: import("better-result").InferOk<NonNullable<typeof command>>;
      let $commandResultError252673!: import("better-result").InferErr<NonNullable<typeof command>>;
      const $commandResultOk252673 = Result.match<
        import("better-result").InferOk<NonNullable<typeof command>>,
        import("better-result").InferErr<NonNullable<typeof command>>,
        boolean
      >(command, {
        ok: (value) => {
          $commandResultValue252673 = value;
          return true;
        },
        err: (error) => {
          $commandResultError252673 = error;
          return false;
        },
      });
      if (($commandResultOk252673 ? "ok" : "error") === "error")
        return Result.err($commandResultError252673);
      if (
        $commandResultValue252673.kind !== input.requestedAction ||
        $commandResultValue252673.run_id !== null ||
        $commandResultValue252673.request_fingerprint !==
          $canonicalCommandResultValue252420.fingerprint ||
        $commandResultValue252673.request_json !== $canonicalCommandResultValue252420.json
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitEmptyHistoryNavigation",
            `Command '${input.commandId}' does not own this history navigation`,
          ),
        );
      }
      if ($commandResultValue252673.result_json !== null) {
        const decodedResult = decodeMiniLilacSuperJsonPayload({
          raw: $commandResultValue252673.result_json,
          schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
          recordId: input.commandId,
          field: "command_result",
        });
        let $decodedResultResultValue253374!: import("better-result").InferOk<
          NonNullable<typeof decodedResult>
        >;
        let $decodedResultResultError253374!: import("better-result").InferErr<
          NonNullable<typeof decodedResult>
        >;
        const $decodedResultResultOk253374 = Result.match<
          import("better-result").InferOk<NonNullable<typeof decodedResult>>,
          import("better-result").InferErr<NonNullable<typeof decodedResult>>,
          boolean
        >(decodedResult, {
          ok: (value) => {
            $decodedResultResultValue253374 = value;
            return true;
          },
          err: (error) => {
            $decodedResultResultError253374 = error;
            return false;
          },
        });
        if (($decodedResultResultOk253374 ? "ok" : "error") === "error")
          return Result.err($decodedResultResultError253374);
        const decodedReplay = decodeStoredHistoryNavigationResult(
          $decodedResultResultValue253374.value,
        );
        let $decodedReplayResultValue253711!: import("better-result").InferOk<
          NonNullable<typeof decodedReplay>
        >;
        let $decodedReplayResultError253711!: import("better-result").InferErr<
          NonNullable<typeof decodedReplay>
        >;
        const $decodedReplayResultOk253711 = Result.match<
          import("better-result").InferOk<NonNullable<typeof decodedReplay>>,
          import("better-result").InferErr<NonNullable<typeof decodedReplay>>,
          boolean
        >(decodedReplay, {
          ok: (value) => {
            $decodedReplayResultValue253711 = value;
            return true;
          },
          err: (error) => {
            $decodedReplayResultError253711 = error;
            return false;
          },
        });
        if (($decodedReplayResultOk253711 ? "ok" : "error") === "error")
          return Result.err($decodedReplayResultError253711);
        const replayed = this.validateHistoryNavigationResult(
          input.requestedAction,
          $decodedReplayResultValue253711,
          input.commandId,
          null,
        );
        let $replayedResultValue253891!: import("better-result").InferOk<
          NonNullable<typeof replayed>
        >;
        let $replayedResultError253891!: import("better-result").InferErr<
          NonNullable<typeof replayed>
        >;
        const $replayedResultOk253891 = Result.match<
          import("better-result").InferOk<NonNullable<typeof replayed>>,
          import("better-result").InferErr<NonNullable<typeof replayed>>,
          boolean
        >(replayed, {
          ok: (value) => {
            $replayedResultValue253891 = value;
            return true;
          },
          err: (error) => {
            $replayedResultError253891 = error;
            return false;
          },
        });
        if (($replayedResultOk253891 ? "ok" : "error") === "error")
          return Result.err($replayedResultError253891);
        if ($replayedResultValue253891.status !== "empty") {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "commitEmptyHistoryNavigation",
              `Command '${input.commandId}' already has a non-empty result`,
            ),
          );
        }
        const navigation = this.getHistoryNavigationResult(input.sessionId);
        let $navigationResultValue254430!: import("better-result").InferOk<
          NonNullable<typeof navigation>
        >;
        let $navigationResultError254430!: import("better-result").InferErr<
          NonNullable<typeof navigation>
        >;
        const $navigationResultOk254430 = Result.match<
          import("better-result").InferOk<NonNullable<typeof navigation>>,
          import("better-result").InferErr<NonNullable<typeof navigation>>,
          boolean
        >(navigation, {
          ok: (value) => {
            $navigationResultValue254430 = value;
            return true;
          },
          err: (error) => {
            $navigationResultError254430 = error;
            return false;
          },
        });
        if (($navigationResultOk254430 ? "ok" : "error") === "error")
          return Result.err($navigationResultError254430);
        return Result.ok({
          result: $replayedResultValue253891,
          replayed: true,
          navigation: $navigationResultValue254430,
        });
      }
      if ($commandResultValue252673.side_effect_started !== 0) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitEmptyHistoryNavigation",
            `Command '${input.commandId}' has an incomplete history side effect`,
          ),
        );
      }
      const history = this.getSessionHistoryResult(input.sessionId);
      let $historyResultValue255011!: import("better-result").InferOk<NonNullable<typeof history>>;
      let $historyResultError255011!: import("better-result").InferErr<NonNullable<typeof history>>;
      const $historyResultOk255011 = Result.match<
        import("better-result").InferOk<NonNullable<typeof history>>,
        import("better-result").InferErr<NonNullable<typeof history>>,
        boolean
      >(history, {
        ok: (value) => {
          $historyResultValue255011 = value;
          return true;
        },
        err: (error) => {
          $historyResultError255011 = error;
          return false;
        },
      });
      if (($historyResultOk255011 ? "ok" : "error") === "error")
        return Result.err($historyResultError255011);
      const quiescent = this.requireQuiescentHistorySessionResult(
        input.sessionId,
        $historyResultValue255011.currentStateId,
      );
      const quiescenceError = quiescent.match({ ok: () => null, err: (error) => error });
      if (quiescenceError !== null) return Result.err(quiescenceError);
      const workspace = this.getWorkspaceForSessionResult(input.sessionId);
      let $workspaceResultValue255367!: import("better-result").InferOk<
        NonNullable<typeof workspace>
      >;
      let $workspaceResultError255367!: import("better-result").InferErr<
        NonNullable<typeof workspace>
      >;
      const $workspaceResultOk255367 = Result.match<
        import("better-result").InferOk<NonNullable<typeof workspace>>,
        import("better-result").InferErr<NonNullable<typeof workspace>>,
        boolean
      >(workspace, {
        ok: (value) => {
          $workspaceResultValue255367 = value;
          return true;
        },
        err: (error) => {
          $workspaceResultError255367 = error;
          return false;
        },
      });
      if (($workspaceResultOk255367 ? "ok" : "error") === "error")
        return Result.err($workspaceResultError255367);
      const available = this.assertWorkspaceHasNoHistoryJournalResult(
        $workspaceResultValue255367.id,
      );
      const availabilityError = available.match({ ok: () => null, err: (error) => error });
      if (availabilityError !== null) return Result.err(availabilityError);
      const target =
        input.requestedAction === "undo"
          ? this.findLatestUndoableUserTransitionResult(input.sessionId)
          : this.peekHistoryRedoResult(input.sessionId);
      let $targetResultValue255686!: import("better-result").InferOk<NonNullable<typeof target>>;
      let $targetResultError255686!: import("better-result").InferErr<NonNullable<typeof target>>;
      const $targetResultOk255686 = Result.match<
        import("better-result").InferOk<NonNullable<typeof target>>,
        import("better-result").InferErr<NonNullable<typeof target>>,
        boolean
      >(target, {
        ok: (value) => {
          $targetResultValue255686 = value;
          return true;
        },
        err: (error) => {
          $targetResultError255686 = error;
          return false;
        },
      });
      if (($targetResultOk255686 ? "ok" : "error") === "error")
        return Result.err($targetResultError255686);
      const hasTarget = $targetResultValue255686 !== null;
      if (hasTarget) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitEmptyHistoryNavigation",
            `History ${input.requestedAction} is no longer empty`,
          ),
        );
      }
      const saved = this.database
        .query(
          `UPDATE commands SET side_effect_started = 1, result_json = ?
           WHERE session_id = ? AND command_id = ? AND kind = ? AND run_id IS NULL
             AND side_effect_started = 0 AND result_json IS NULL`,
        )
        .run(serialize(emptyResult), input.sessionId, input.commandId, input.requestedAction);
      if (saved.changes !== 1) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitEmptyHistoryNavigation",
            `Command '${input.commandId}' empty result could not be saved atomically`,
          ),
        );
      }
      const navigation = this.getHistoryNavigationResult(input.sessionId);
      let $navigationResultValue256870!: import("better-result").InferOk<
        NonNullable<typeof navigation>
      >;
      let $navigationResultError256870!: import("better-result").InferErr<
        NonNullable<typeof navigation>
      >;
      const $navigationResultOk256870 = Result.match<
        import("better-result").InferOk<NonNullable<typeof navigation>>,
        import("better-result").InferErr<NonNullable<typeof navigation>>,
        boolean
      >(navigation, {
        ok: (value) => {
          $navigationResultValue256870 = value;
          return true;
        },
        err: (error) => {
          $navigationResultError256870 = error;
          return false;
        },
      });
      if (($navigationResultOk256870 ? "ok" : "error") === "error")
        return Result.err($navigationResultError256870);
      return Result.ok({
        result: emptyResult,
        replayed: false,
        navigation: $navigationResultValue256870,
      });
    });
  }

  reserveHistoryOperation(input: ReserveStoredHistoryOperation): ReservedStoredHistoryOperation {
    return storeResultToLegacy(this.reserveHistoryOperationResult(input));
  }

  reserveHistoryOperationResult(
    input: ReserveStoredHistoryOperation,
  ): ResultType<ReservedStoredHistoryOperation, MiniLilacStoreOperationError> {
    if (input.filesystemMode === "restore" && input.skipReason !== null) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "reserveHistoryOperation",
          "Restore-mode history operations cannot have a skip reason",
        ),
      );
    }
    return this.runStoreTransactionResult("reserveHistoryOperation", () => {
      const quiescent = this.requireQuiescentHistorySessionResult(
        input.sessionId,
        input.expectedSourceStateId,
      );
      const quiescenceError = quiescent.match({ ok: () => null, err: (error) => error });
      if (quiescenceError !== null) return Result.err(quiescenceError);
      const workspace = this.getWorkspaceForSessionResult(input.sessionId);
      let $workspaceResultValue258060!: import("better-result").InferOk<
        NonNullable<typeof workspace>
      >;
      let $workspaceResultError258060!: import("better-result").InferErr<
        NonNullable<typeof workspace>
      >;
      const $workspaceResultOk258060 = Result.match<
        import("better-result").InferOk<NonNullable<typeof workspace>>,
        import("better-result").InferErr<NonNullable<typeof workspace>>,
        boolean
      >(workspace, {
        ok: (value) => {
          $workspaceResultValue258060 = value;
          return true;
        },
        err: (error) => {
          $workspaceResultError258060 = error;
          return false;
        },
      });
      if (($workspaceResultOk258060 ? "ok" : "error") === "error")
        return Result.err($workspaceResultError258060);
      const available = this.assertWorkspaceHasNoHistoryJournalResult(
        $workspaceResultValue258060.id,
      );
      const availabilityError = available.match({ ok: () => null, err: (error) => error });
      if (availabilityError !== null) return Result.err(availabilityError);
      const command = this.getStoredCommandResult(input.sessionId, input.commandId);
      let $commandResultValue258379!: import("better-result").InferOk<NonNullable<typeof command>>;
      let $commandResultError258379!: import("better-result").InferErr<NonNullable<typeof command>>;
      const $commandResultOk258379 = Result.match<
        import("better-result").InferOk<NonNullable<typeof command>>,
        import("better-result").InferErr<NonNullable<typeof command>>,
        boolean
      >(command, {
        ok: (value) => {
          $commandResultValue258379 = value;
          return true;
        },
        err: (error) => {
          $commandResultError258379 = error;
          return false;
        },
      });
      if (($commandResultOk258379 ? "ok" : "error") === "error")
        return Result.err($commandResultError258379);
      if (
        $commandResultValue258379.kind !== input.requestedAction ||
        $commandResultValue258379.run_id !== null ||
        $commandResultValue258379.result_json !== null ||
        $commandResultValue258379.side_effect_started !== 0
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "reserveHistoryOperation",
            `Command '${input.commandId}' cannot reserve a history operation`,
          ),
        );
      }
      const source = this.getCurrentHistoryStateResult(input.sessionId);
      let $sourceResultValue258966!: import("better-result").InferOk<NonNullable<typeof source>>;
      let $sourceResultError258966!: import("better-result").InferErr<NonNullable<typeof source>>;
      const $sourceResultOk258966 = Result.match<
        import("better-result").InferOk<NonNullable<typeof source>>,
        import("better-result").InferErr<NonNullable<typeof source>>,
        boolean
      >(source, {
        ok: (value) => {
          $sourceResultValue258966 = value;
          return true;
        },
        err: (error) => {
          $sourceResultError258966 = error;
          return false;
        },
      });
      if (($sourceResultOk258966 ? "ok" : "error") === "error")
        return Result.err($sourceResultError258966);
      const transition = this.getHistoryTransitionResult(input.userTransitionId);
      let $transitionResultValue259109!: import("better-result").InferOk<
        NonNullable<typeof transition>
      >;
      let $transitionResultError259109!: import("better-result").InferErr<
        NonNullable<typeof transition>
      >;
      const $transitionResultOk259109 = Result.match<
        import("better-result").InferOk<NonNullable<typeof transition>>,
        import("better-result").InferErr<NonNullable<typeof transition>>,
        boolean
      >(transition, {
        ok: (value) => {
          $transitionResultValue259109 = value;
          return true;
        },
        err: (error) => {
          $transitionResultError259109 = error;
          return false;
        },
      });
      if (($transitionResultOk259109 ? "ok" : "error") === "error")
        return Result.err($transitionResultError259109);
      if (
        $transitionResultValue259109.sessionId !== input.sessionId ||
        $transitionResultValue259109.kind !== "user-message" ||
        $transitionResultValue259109.toStateId === null
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "reserveHistoryOperation",
            `History operation transition '${input.userTransitionId}' is not completed`,
          ),
        );
      }
      const connected = this.assertStateConnectedToRootResult(input.sessionId, input.targetStateId);
      const connectionError = connected.match({ ok: () => null, err: (error) => error });
      if (connectionError !== null) return Result.err(connectionError);
      let observedState: StoredHistoryState | null = null;
      if (input.observation !== undefined) {
        const observed = this.insertWorkspaceObservationResult(
          input.sessionId,
          $sourceResultValue258966,
          {
            modelHeadId: $sourceResultValue258966.modelHeadId,
            uiHeadId: $sourceResultValue258966.uiHeadId,
          },
          input.observation,
        );
        let $observedResultValue259955!: import("better-result").InferOk<
          NonNullable<typeof observed>
        >;
        let $observedResultError259955!: import("better-result").InferErr<
          NonNullable<typeof observed>
        >;
        const $observedResultOk259955 = Result.match<
          import("better-result").InferOk<NonNullable<typeof observed>>,
          import("better-result").InferErr<NonNullable<typeof observed>>,
          boolean
        >(observed, {
          ok: (value) => {
            $observedResultValue259955 = value;
            return true;
          },
          err: (error) => {
            $observedResultError259955 = error;
            return false;
          },
        });
        if (($observedResultOk259955 ? "ok" : "error") === "error")
          return Result.err($observedResultError259955);
        observedState = $observedResultValue259955;
      }
      if (
        input.requestedAction === "undo" &&
        $transitionResultValue259109.fromStateId !== input.targetStateId
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "reserveHistoryOperation",
            "Undo history operation target must be its user transition source",
          ),
        );
      }
      if (input.requestedAction === "undo") {
        const undoable = this.findLatestUndoableUserTransitionResult(input.sessionId);
        let $undoableResultValue260711!: import("better-result").InferOk<
          NonNullable<typeof undoable>
        >;
        let $undoableResultError260711!: import("better-result").InferErr<
          NonNullable<typeof undoable>
        >;
        const $undoableResultOk260711 = Result.match<
          import("better-result").InferOk<NonNullable<typeof undoable>>,
          import("better-result").InferErr<NonNullable<typeof undoable>>,
          boolean
        >(undoable, {
          ok: (value) => {
            $undoableResultValue260711 = value;
            return true;
          },
          err: (error) => {
            $undoableResultError260711 = error;
            return false;
          },
        });
        if (($undoableResultOk260711 ? "ok" : "error") === "error")
          return Result.err($undoableResultError260711);
        if ($undoableResultValue260711?.id !== input.userTransitionId) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "reserveHistoryOperation",
              "Undo history operation must use the latest transition above the undo floor",
            ),
          );
        }
      }
      const redo = this.peekHistoryRedoResult(input.sessionId);
      let $redoResultValue261184!: import("better-result").InferOk<NonNullable<typeof redo>>;
      let $redoResultError261184!: import("better-result").InferErr<NonNullable<typeof redo>>;
      const $redoResultOk261184 = Result.match<
        import("better-result").InferOk<NonNullable<typeof redo>>,
        import("better-result").InferErr<NonNullable<typeof redo>>,
        boolean
      >(redo, {
        ok: (value) => {
          $redoResultValue261184 = value;
          return true;
        },
        err: (error) => {
          $redoResultError261184 = error;
          return false;
        },
      });
      if (($redoResultOk261184 ? "ok" : "error") === "error")
        return Result.err($redoResultError261184);
      if (
        input.requestedAction === "redo" &&
        ($redoResultValue261184?.targetStateId !== input.targetStateId ||
          $redoResultValue261184.userTransitionId !== input.userTransitionId)
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "reserveHistoryOperation",
            "Redo history operation target must match the top redo entry",
          ),
        );
      }
      if (
        input.requestedAction === "redo" &&
        $transitionResultValue259109.toStateId !== null &&
        !this.isStateInAncestry(
          input.sessionId,
          input.targetStateId,
          $transitionResultValue259109.toStateId,
        )
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "reserveHistoryOperation",
            "Redo target must descend from its user transition destination",
          ),
        );
      }
      const now = new Date().toISOString();
      const marked = this.database
        .query(
          `UPDATE commands SET side_effect_started = 1
           WHERE session_id = ? AND command_id = ? AND side_effect_started = 0
             AND result_json IS NULL`,
        )
        .run(input.sessionId, input.commandId);
      if (marked.changes !== 1) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "reserveHistoryOperation",
            `Command '${input.commandId}' could not begin its history operation`,
          ),
        );
      }
      this.database
        .query(
          `INSERT INTO history_operations
            (id, session_id, workspace_id, command_id, kind, requested_action, source_state_id,
             observed_source_state_id, target_state_id, user_transition_id, filesystem_mode,
             skip_reason, phase, prepared_at, updated_at)
           VALUES (?, ?, ?, ?, 'navigate', ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
        )
        .run(
          input.id,
          input.sessionId,
          $workspaceResultValue258060.id,
          input.commandId,
          input.requestedAction,
          $sourceResultValue258966.id,
          observedState?.id ?? null,
          input.targetStateId,
          input.userTransitionId,
          input.filesystemMode,
          input.skipReason,
          now,
          now,
        );
      const operation = this.getHistoryOperationResult(input.id);
      let $operationResultValue263528!: import("better-result").InferOk<
        NonNullable<typeof operation>
      >;
      let $operationResultError263528!: import("better-result").InferErr<
        NonNullable<typeof operation>
      >;
      const $operationResultOk263528 = Result.match<
        import("better-result").InferOk<NonNullable<typeof operation>>,
        import("better-result").InferErr<NonNullable<typeof operation>>,
        boolean
      >(operation, {
        ok: (value) => {
          $operationResultValue263528 = value;
          return true;
        },
        err: (error) => {
          $operationResultError263528 = error;
          return false;
        },
      });
      if (($operationResultOk263528 ? "ok" : "error") === "error")
        return Result.err($operationResultError263528);
      if ($operationResultValue263528 === null) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "reserveHistoryOperation",
            `History operation '${input.id}' was not created`,
          ),
        );
      }
      return Result.ok({ operation: $operationResultValue263528, observedState });
    });
  }

  getHistoryOperation(operationId: string): StoredHistoryOperation | null {
    return storeResultToLegacy(this.getHistoryOperationResult(operationId));
  }

  getHistoryOperationResult(
    operationId: string,
  ): ResultType<StoredHistoryOperation | null, MiniLilacPersistenceError> {
    return this.runHistoryReadResult("getHistoryOperation", () =>
      this.decodeStructuralHistoryRow({
        kind: "operation",
        row: this.database.query("SELECT * FROM history_operations WHERE id = ?").get(operationId),
        recordId: operationId,
      }),
    );
  }

  listHistoryOperations(): readonly StoredHistoryOperation[] {
    return storeResultToLegacy(this.listHistoryOperationsResult());
  }

  listHistoryOperationsResult(): ResultType<
    readonly StoredHistoryOperation[],
    MiniLilacPersistenceError
  > {
    return this.runHistoryReadResult("listHistoryOperations", () => {
      return this.decodeStructuralHistoryRows({
        kind: "operation",
        rows: this.database
          .query("SELECT * FROM history_operations ORDER BY prepared_at, rowid")
          .all(),
        recordId: "operation",
      });
    });
  }

  skipPreparedHistoryRestore(
    operationId: string,
    reasonValue: z.infer<typeof historySkipReasonSchema>,
  ): StoredHistoryOperation {
    return storeResultToLegacy(this.skipPreparedHistoryRestoreResult(operationId, reasonValue));
  }

  skipPreparedHistoryRestoreResult(
    operationId: string,
    reasonValue: z.infer<typeof historySkipReasonSchema>,
  ): ResultType<StoredHistoryOperation, MiniLilacStoreOperationError> {
    return this.runStoreTransactionResult<StoredHistoryOperation, MiniLilacStoreOperationError>(
      "skipPreparedHistoryRestore",
      () => {
        const operation = this.getHistoryOperationResult(operationId);
        let $operationResultValue265735!: import("better-result").InferOk<
          NonNullable<typeof operation>
        >;
        let $operationResultError265735!: import("better-result").InferErr<
          NonNullable<typeof operation>
        >;
        const $operationResultOk265735 = Result.match<
          import("better-result").InferOk<NonNullable<typeof operation>>,
          import("better-result").InferErr<NonNullable<typeof operation>>,
          boolean
        >(operation, {
          ok: (value) => {
            $operationResultValue265735 = value;
            return true;
          },
          err: (error) => {
            $operationResultError265735 = error;
            return false;
          },
        });
        if (($operationResultOk265735 ? "ok" : "error") === "error")
          return Result.err($operationResultError265735);
        if ($operationResultValue265735 === null) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "skipPreparedHistoryRestore",
              `History operation '${operationId}' was not found`,
            ),
          );
        }
        if (
          $operationResultValue265735.filesystemMode !== "restore" ||
          $operationResultValue265735.phase !== "prepared"
        ) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "skipPreparedHistoryRestore",
              `History operation '${operationId}' cannot skip its prepared restore`,
            ),
          );
        }
        const updated = this.database
          .query(
            `UPDATE history_operations
           SET filesystem_mode = 'skip', skip_reason = ?, updated_at = ?
           WHERE id = ? AND filesystem_mode = 'restore' AND phase = 'prepared'`,
          )
          .run(reasonValue, new Date().toISOString(), operationId);
        if (updated.changes !== 1) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "skipPreparedHistoryRestore",
              `History operation '${operationId}' could not skip its prepared restore`,
            ),
          );
        }
        const skipped = this.getHistoryOperationResult(operationId);
        let $skippedResultValue267091!: import("better-result").InferOk<
          NonNullable<typeof skipped>
        >;
        let $skippedResultError267091!: import("better-result").InferErr<
          NonNullable<typeof skipped>
        >;
        const $skippedResultOk267091 = Result.match<
          import("better-result").InferOk<NonNullable<typeof skipped>>,
          import("better-result").InferErr<NonNullable<typeof skipped>>,
          boolean
        >(skipped, {
          ok: (value) => {
            $skippedResultValue267091 = value;
            return true;
          },
          err: (error) => {
            $skippedResultError267091 = error;
            return false;
          },
        });
        if (($skippedResultOk267091 ? "ok" : "error") === "error")
          return Result.err($skippedResultError267091);
        if ($skippedResultValue267091 === null) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "skipPreparedHistoryRestore",
              `History operation '${operationId}' disappeared`,
            ),
          );
        }
        return Result.ok($skippedResultValue267091);
      },
    );
  }

  updateHistoryOperationPhase(
    operationId: string,
    phaseValue: z.infer<typeof historyOperationPhaseSchema>,
  ): StoredHistoryOperation {
    return storeResultToLegacy(this.updateHistoryOperationPhaseResult(operationId, phaseValue));
  }

  updateHistoryOperationPhaseResult(
    operationId: string,
    phaseValue: z.infer<typeof historyOperationPhaseSchema>,
  ): ResultType<StoredHistoryOperation, MiniLilacStoreOperationError> {
    const phase = phaseValue;
    return this.runStoreTransactionResult<StoredHistoryOperation, MiniLilacStoreOperationError>(
      "updateHistoryOperationPhase",
      () => {
        const operation = this.getHistoryOperationResult(operationId);
        let $operationResultValue268174!: import("better-result").InferOk<
          NonNullable<typeof operation>
        >;
        let $operationResultError268174!: import("better-result").InferErr<
          NonNullable<typeof operation>
        >;
        const $operationResultOk268174 = Result.match<
          import("better-result").InferOk<NonNullable<typeof operation>>,
          import("better-result").InferErr<NonNullable<typeof operation>>,
          boolean
        >(operation, {
          ok: (value) => {
            $operationResultValue268174 = value;
            return true;
          },
          err: (error) => {
            $operationResultError268174 = error;
            return false;
          },
        });
        if (($operationResultOk268174 ? "ok" : "error") === "error")
          return Result.err($operationResultError268174);
        if ($operationResultValue268174 === null) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "updateHistoryOperationPhase",
              `History operation '${operationId}' was not found`,
            ),
          );
        }
        const allowed =
          $operationResultValue268174.phase === phase ||
          ($operationResultValue268174.filesystemMode === "restore" &&
            (($operationResultValue268174.phase === "prepared" && phase === "restoring") ||
              ($operationResultValue268174.phase === "restoring" && phase === "verified"))) ||
          ($operationResultValue268174.filesystemMode === "skip" &&
            $operationResultValue268174.phase === "prepared" &&
            phase === "verified");
        if (!allowed) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "updateHistoryOperationPhase",
              `History operation '${operationId}' cannot move from '${$operationResultValue268174.phase}' to '${phase}'`,
            ),
          );
        }
        this.database
          .query("UPDATE history_operations SET phase = ?, updated_at = ? WHERE id = ?")
          .run(phase, new Date().toISOString(), operationId);
        const updated = this.getHistoryOperationResult(operationId);
        let $updatedResultValue269480!: import("better-result").InferOk<
          NonNullable<typeof updated>
        >;
        let $updatedResultError269480!: import("better-result").InferErr<
          NonNullable<typeof updated>
        >;
        const $updatedResultOk269480 = Result.match<
          import("better-result").InferOk<NonNullable<typeof updated>>,
          import("better-result").InferErr<NonNullable<typeof updated>>,
          boolean
        >(updated, {
          ok: (value) => {
            $updatedResultValue269480 = value;
            return true;
          },
          err: (error) => {
            $updatedResultError269480 = error;
            return false;
          },
        });
        if (($updatedResultOk269480 ? "ok" : "error") === "error")
          return Result.err($updatedResultError269480);
        if ($updatedResultValue269480 === null) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "updateHistoryOperationPhase",
              `History operation '${operationId}' was not found`,
            ),
          );
        }
        return Result.ok($updatedResultValue269480);
      },
    );
  }

  commitHistoryNavigation(input: CommitStoredHistoryNavigation): CommittedStoredHistoryNavigation {
    return storeResultToLegacy(this.commitHistoryNavigationResult(input));
  }

  commitHistoryNavigationResult(
    input: CommitStoredHistoryNavigation,
  ): ResultType<CommittedStoredHistoryNavigation, MiniLilacStoreOperationError> {
    return this.runStoreTransactionResult("commitHistoryNavigation", () => {
      const operation = this.getHistoryOperationResult(input.operationId);
      let $operationResultValue270356!: import("better-result").InferOk<
        NonNullable<typeof operation>
      >;
      let $operationResultError270356!: import("better-result").InferErr<
        NonNullable<typeof operation>
      >;
      const $operationResultOk270356 = Result.match<
        import("better-result").InferOk<NonNullable<typeof operation>>,
        import("better-result").InferErr<NonNullable<typeof operation>>,
        boolean
      >(operation, {
        ok: (value) => {
          $operationResultValue270356 = value;
          return true;
        },
        err: (error) => {
          $operationResultError270356 = error;
          return false;
        },
      });
      if (($operationResultOk270356 ? "ok" : "error") === "error")
        return Result.err($operationResultError270356);
      if ($operationResultValue270356 === null) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitHistoryNavigation",
            `History operation '${input.operationId}' was not found`,
          ),
        );
      }
      if (
        ($operationResultValue270356.filesystemMode === "restore" &&
          $operationResultValue270356.phase !== "verified") ||
        ($operationResultValue270356.filesystemMode === "skip" &&
          !["prepared", "verified"].includes($operationResultValue270356.phase))
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitHistoryNavigation",
            `History operation '${input.operationId}' is not ready to commit`,
          ),
        );
      }
      const available = this.assertWorkspaceHistoryAvailableForOwnerResult(
        $operationResultValue270356.workspaceId,
        $operationResultValue270356.sessionId,
        { kind: "history-operation", operationId: $operationResultValue270356.id },
      );
      const availabilityError = available.match({ ok: () => null, err: (error) => error });
      if (availabilityError !== null) return Result.err(availabilityError);
      const quiescent = this.requireQuiescentHistorySessionResult(
        $operationResultValue270356.sessionId,
        $operationResultValue270356.sourceStateId,
      );
      const quiescenceError = quiescent.match({ ok: () => null, err: (error) => error });
      if (quiescenceError !== null) return Result.err(quiescenceError);
      const source = this.getHistoryStateResult($operationResultValue270356.sourceStateId);
      let $sourceResultValue271745!: import("better-result").InferOk<NonNullable<typeof source>>;
      let $sourceResultError271745!: import("better-result").InferErr<NonNullable<typeof source>>;
      const $sourceResultOk271745 = Result.match<
        import("better-result").InferOk<NonNullable<typeof source>>,
        import("better-result").InferErr<NonNullable<typeof source>>,
        boolean
      >(source, {
        ok: (value) => {
          $sourceResultValue271745 = value;
          return true;
        },
        err: (error) => {
          $sourceResultError271745 = error;
          return false;
        },
      });
      if (($sourceResultOk271745 ? "ok" : "error") === "error")
        return Result.err($sourceResultError271745);
      const target = this.getHistoryStateResult($operationResultValue270356.targetStateId);
      let $targetResultValue271895!: import("better-result").InferOk<NonNullable<typeof target>>;
      let $targetResultError271895!: import("better-result").InferErr<NonNullable<typeof target>>;
      const $targetResultOk271895 = Result.match<
        import("better-result").InferOk<NonNullable<typeof target>>,
        import("better-result").InferErr<NonNullable<typeof target>>,
        boolean
      >(target, {
        ok: (value) => {
          $targetResultValue271895 = value;
          return true;
        },
        err: (error) => {
          $targetResultError271895 = error;
          return false;
        },
      });
      if (($targetResultOk271895 ? "ok" : "error") === "error")
        return Result.err($targetResultError271895);
      const transition = this.getHistoryTransitionResult(
        $operationResultValue270356.userTransitionId,
      );
      let $transitionResultValue272045!: import("better-result").InferOk<
        NonNullable<typeof transition>
      >;
      let $transitionResultError272045!: import("better-result").InferErr<
        NonNullable<typeof transition>
      >;
      const $transitionResultOk272045 = Result.match<
        import("better-result").InferOk<NonNullable<typeof transition>>,
        import("better-result").InferErr<NonNullable<typeof transition>>,
        boolean
      >(transition, {
        ok: (value) => {
          $transitionResultValue272045 = value;
          return true;
        },
        err: (error) => {
          $transitionResultError272045 = error;
          return false;
        },
      });
      if (($transitionResultOk272045 ? "ok" : "error") === "error")
        return Result.err($transitionResultError272045);
      if (
        $sourceResultValue271745.sessionId !== $operationResultValue270356.sessionId ||
        $targetResultValue271895.sessionId !== $operationResultValue270356.sessionId ||
        $transitionResultValue272045.sessionId !== $operationResultValue270356.sessionId ||
        $transitionResultValue272045.kind !== "user-message" ||
        $transitionResultValue272045.toStateId === null
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitHistoryNavigation",
            `History operation '${input.operationId}' has incoherent ownership`,
          ),
        );
      }
      const decodedInputResult = decodeStoredHistoryNavigationResult(input.result);
      let $decodedInputResultResultValue272748!: import("better-result").InferOk<
        NonNullable<typeof decodedInputResult>
      >;
      let $decodedInputResultResultError272748!: import("better-result").InferErr<
        NonNullable<typeof decodedInputResult>
      >;
      const $decodedInputResultResultOk272748 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decodedInputResult>>,
        import("better-result").InferErr<NonNullable<typeof decodedInputResult>>,
        boolean
      >(decodedInputResult, {
        ok: (value) => {
          $decodedInputResultResultValue272748 = value;
          return true;
        },
        err: (error) => {
          $decodedInputResultResultError272748 = error;
          return false;
        },
      });
      if (($decodedInputResultResultOk272748 ? "ok" : "error") === "error")
        return Result.err($decodedInputResultResultError272748);
      const result = this.validateHistoryNavigationResult(
        $operationResultValue270356.requestedAction,
        $decodedInputResultResultValue272748,
        $operationResultValue270356.commandId,
        $transitionResultValue272045.userMessage,
      );
      let $resultResultValue272926!: import("better-result").InferOk<NonNullable<typeof result>>;
      let $resultResultError272926!: import("better-result").InferErr<NonNullable<typeof result>>;
      const $resultResultOk272926 = Result.match<
        import("better-result").InferOk<NonNullable<typeof result>>,
        import("better-result").InferErr<NonNullable<typeof result>>,
        boolean
      >(result, {
        ok: (value) => {
          $resultResultValue272926 = value;
          return true;
        },
        err: (error) => {
          $resultResultError272926 = error;
          return false;
        },
      });
      if (($resultResultOk272926 ? "ok" : "error") === "error")
        return Result.err($resultResultError272926);
      const expectedStatus =
        $operationResultValue270356.requestedAction === "undo" ? "undone" : "redone";
      if (
        $resultResultValue272926.status === "empty" ||
        $resultResultValue272926.status !== expectedStatus
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitHistoryNavigation",
            `History operation '${input.operationId}' requires a '${expectedStatus}' result`,
          ),
        );
      }
      if ($resultResultValue272926.historyStateId !== $operationResultValue270356.targetStateId) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitHistoryNavigation",
            `History operation '${input.operationId}' result names the wrong state`,
          ),
        );
      }
      let expectedFilesystem: MiniLilacHistoryFilesystemResult;
      if ($operationResultValue270356.filesystemMode === "restore") {
        expectedFilesystem = { status: "restored" };
      } else {
        if ($operationResultValue270356.skipReason === null) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "commitHistoryNavigation",
              `History operation '${input.operationId}' has no filesystem skip reason`,
            ),
          );
        }
        expectedFilesystem = {
          status: "skipped",
          reason: $operationResultValue270356.skipReason,
        };
      }
      if (!canonicalValuesEqual($resultResultValue272926.filesystem, expectedFilesystem)) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitHistoryNavigation",
            `History operation '${input.operationId}' result has the wrong filesystem outcome`,
          ),
        );
      }
      let redoTarget = $sourceResultValue271745;
      if ($operationResultValue270356.observedSourceStateId !== null) {
        const observed = this.getHistoryStateResult(
          $operationResultValue270356.observedSourceStateId,
        );
        let $observedResultValue274945!: import("better-result").InferOk<
          NonNullable<typeof observed>
        >;
        let $observedResultError274945!: import("better-result").InferErr<
          NonNullable<typeof observed>
        >;
        const $observedResultOk274945 = Result.match<
          import("better-result").InferOk<NonNullable<typeof observed>>,
          import("better-result").InferErr<NonNullable<typeof observed>>,
          boolean
        >(observed, {
          ok: (value) => {
            $observedResultValue274945 = value;
            return true;
          },
          err: (error) => {
            $observedResultError274945 = error;
            return false;
          },
        });
        if (($observedResultOk274945 ? "ok" : "error") === "error")
          return Result.err($observedResultError274945);
        const incoming = this.getIncomingHistoryTransitionResult(
          $operationResultValue270356.sessionId,
          $operationResultValue270356.observedSourceStateId,
        );
        let $incomingResultValue275113!: import("better-result").InferOk<
          NonNullable<typeof incoming>
        >;
        let $incomingResultError275113!: import("better-result").InferErr<
          NonNullable<typeof incoming>
        >;
        const $incomingResultOk275113 = Result.match<
          import("better-result").InferOk<NonNullable<typeof incoming>>,
          import("better-result").InferErr<NonNullable<typeof incoming>>,
          boolean
        >(incoming, {
          ok: (value) => {
            $incomingResultValue275113 = value;
            return true;
          },
          err: (error) => {
            $incomingResultError275113 = error;
            return false;
          },
        });
        if (($incomingResultOk275113 ? "ok" : "error") === "error")
          return Result.err($incomingResultError275113);
        if (
          $observedResultValue274945.modelHeadId !== $sourceResultValue271745.modelHeadId ||
          $observedResultValue274945.uiHeadId !== $sourceResultValue271745.uiHeadId ||
          $incomingResultValue275113?.kind !== "workspace-observation" ||
          $incomingResultValue275113.fromStateId !== $sourceResultValue271745.id
        ) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "commitHistoryNavigation",
              `History operation '${input.operationId}' has an invalid observation`,
            ),
          );
        }
        redoTarget = $observedResultValue274945;
      }
      if ($operationResultValue270356.requestedAction === "undo") {
        const undoable = this.findLatestUndoableUserTransitionResult(
          $operationResultValue270356.sessionId,
        );
        let $undoableResultValue275965!: import("better-result").InferOk<
          NonNullable<typeof undoable>
        >;
        let $undoableResultError275965!: import("better-result").InferErr<
          NonNullable<typeof undoable>
        >;
        const $undoableResultOk275965 = Result.match<
          import("better-result").InferOk<NonNullable<typeof undoable>>,
          import("better-result").InferErr<NonNullable<typeof undoable>>,
          boolean
        >(undoable, {
          ok: (value) => {
            $undoableResultValue275965 = value;
            return true;
          },
          err: (error) => {
            $undoableResultError275965 = error;
            return false;
          },
        });
        if (($undoableResultOk275965 ? "ok" : "error") === "error")
          return Result.err($undoableResultError275965);
        if (
          $transitionResultValue272045.fromStateId !== $targetResultValue271895.id ||
          $undoableResultValue275965?.id !== $transitionResultValue272045.id ||
          !this.isStateInAncestry(
            $operationResultValue270356.sessionId,
            redoTarget.id,
            $transitionResultValue272045.toStateId,
          )
        ) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "commitHistoryNavigation",
              `History operation '${input.operationId}' no longer matches undo topology`,
            ),
          );
        }
        const pushed = this.pushHistoryRedoResult(
          $operationResultValue270356.sessionId,
          redoTarget.id,
          $transitionResultValue272045.id,
        );
        const pushError = pushed.match({ ok: () => null, err: (error) => error });
        if (pushError !== null) return Result.err(pushError);
      } else {
        const redo = this.peekHistoryRedoResult($operationResultValue270356.sessionId);
        let $redoResultValue276917!: import("better-result").InferOk<NonNullable<typeof redo>>;
        let $redoResultError276917!: import("better-result").InferErr<NonNullable<typeof redo>>;
        const $redoResultOk276917 = Result.match<
          import("better-result").InferOk<NonNullable<typeof redo>>,
          import("better-result").InferErr<NonNullable<typeof redo>>,
          boolean
        >(redo, {
          ok: (value) => {
            $redoResultValue276917 = value;
            return true;
          },
          err: (error) => {
            $redoResultError276917 = error;
            return false;
          },
        });
        if (($redoResultOk276917 ? "ok" : "error") === "error")
          return Result.err($redoResultError276917);
        if (
          $redoResultValue276917?.targetStateId !== $targetResultValue271895.id ||
          $redoResultValue276917.userTransitionId !== $transitionResultValue272045.id ||
          !this.isStateInAncestry(
            $operationResultValue270356.sessionId,
            $targetResultValue271895.id,
            $transitionResultValue272045.toStateId,
          )
        ) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "commitHistoryNavigation",
              `History operation '${input.operationId}' no longer matches redo topology`,
            ),
          );
        }
        const popped = this.popHistoryRedoResult($operationResultValue270356.sessionId);
        const popError = popped.match({ ok: () => null, err: (error) => error });
        if (popError !== null) return Result.err(popError);
      }
      const moved = this.moveHistoryCursorResult(
        $operationResultValue270356.sessionId,
        $targetResultValue271895,
      );
      const moveError = moved.match({ ok: () => null, err: (error) => error });
      if (moveError !== null) return Result.err(moveError);
      const saved = this.saveHistoryCommandResultResult(
        $operationResultValue270356,
        $resultResultValue272926,
      );
      const saveError = saved.match({ ok: () => null, err: (error) => error });
      if (saveError !== null) return Result.err(saveError);
      const deleted = this.deleteHistoryOperationRowResult($operationResultValue270356.id);
      const deletionError = deleted.match({ ok: () => null, err: (error) => error });
      if (deletionError !== null) return Result.err(deletionError);
      const navigation = this.getHistoryNavigationResult($operationResultValue270356.sessionId);
      let $navigationResultValue278228!: import("better-result").InferOk<
        NonNullable<typeof navigation>
      >;
      let $navigationResultError278228!: import("better-result").InferErr<
        NonNullable<typeof navigation>
      >;
      const $navigationResultOk278228 = Result.match<
        import("better-result").InferOk<NonNullable<typeof navigation>>,
        import("better-result").InferErr<NonNullable<typeof navigation>>,
        boolean
      >(navigation, {
        ok: (value) => {
          $navigationResultValue278228 = value;
          return true;
        },
        err: (error) => {
          $navigationResultError278228 = error;
          return false;
        },
      });
      if (($navigationResultOk278228 ? "ok" : "error") === "error")
        return Result.err($navigationResultError278228);
      return Result.ok({
        operation: $operationResultValue270356,
        currentState: $targetResultValue271895,
        navigation: $navigationResultValue278228,
      });
    });
  }

  abandonHistoryNavigation(
    input: AcknowledgeStoredHistoryNavigationAbandonment,
  ): StoredHistoryCommandError {
    return storeResultToLegacy(this.abandonHistoryNavigationResult(input));
  }

  abandonHistoryNavigationResult(
    input: AcknowledgeStoredHistoryNavigationAbandonment,
  ): ResultType<StoredHistoryCommandError, MiniLilacStoreOperationError> {
    return this.runStoreTransactionResult("abandonHistoryNavigation", () => {
      const operation = this.getHistoryOperationResult(input.operationId);
      let $operationResultValue278994!: import("better-result").InferOk<
        NonNullable<typeof operation>
      >;
      let $operationResultError278994!: import("better-result").InferErr<
        NonNullable<typeof operation>
      >;
      const $operationResultOk278994 = Result.match<
        import("better-result").InferOk<NonNullable<typeof operation>>,
        import("better-result").InferErr<NonNullable<typeof operation>>,
        boolean
      >(operation, {
        ok: (value) => {
          $operationResultValue278994 = value;
          return true;
        },
        err: (error) => {
          $operationResultError278994 = error;
          return false;
        },
      });
      if (($operationResultOk278994 ? "ok" : "error") === "error")
        return Result.err($operationResultError278994);
      if ($operationResultValue278994 === null) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "abandonHistoryNavigation",
            `History operation '${input.operationId}' was not found`,
          ),
        );
      }
      const quiescent = this.requireQuiescentHistorySessionResult(
        $operationResultValue278994.sessionId,
        $operationResultValue278994.sourceStateId,
      );
      const quiescenceError = quiescent.match({ ok: () => null, err: (error) => error });
      if (quiescenceError !== null) return Result.err(quiescenceError);
      const source = this.getHistoryStateResult($operationResultValue278994.sourceStateId);
      let $sourceResultValue279619!: import("better-result").InferOk<NonNullable<typeof source>>;
      let $sourceResultError279619!: import("better-result").InferErr<NonNullable<typeof source>>;
      const $sourceResultOk279619 = Result.match<
        import("better-result").InferOk<NonNullable<typeof source>>,
        import("better-result").InferErr<NonNullable<typeof source>>,
        boolean
      >(source, {
        ok: (value) => {
          $sourceResultValue279619 = value;
          return true;
        },
        err: (error) => {
          $sourceResultError279619 = error;
          return false;
        },
      });
      if (($sourceResultOk279619 ? "ok" : "error") === "error")
        return Result.err($sourceResultError279619);
      if ($operationResultValue278994.observedSourceStateId !== null) {
        const observed = this.getHistoryStateResult(
          $operationResultValue278994.observedSourceStateId,
        );
        let $observedResultValue279831!: import("better-result").InferOk<
          NonNullable<typeof observed>
        >;
        let $observedResultError279831!: import("better-result").InferErr<
          NonNullable<typeof observed>
        >;
        const $observedResultOk279831 = Result.match<
          import("better-result").InferOk<NonNullable<typeof observed>>,
          import("better-result").InferErr<NonNullable<typeof observed>>,
          boolean
        >(observed, {
          ok: (value) => {
            $observedResultValue279831 = value;
            return true;
          },
          err: (error) => {
            $observedResultError279831 = error;
            return false;
          },
        });
        if (($observedResultOk279831 ? "ok" : "error") === "error")
          return Result.err($observedResultError279831);
        const incoming = this.getIncomingHistoryTransitionResult(
          $operationResultValue278994.sessionId,
          $operationResultValue278994.observedSourceStateId,
        );
        let $incomingResultValue279999!: import("better-result").InferOk<
          NonNullable<typeof incoming>
        >;
        let $incomingResultError279999!: import("better-result").InferErr<
          NonNullable<typeof incoming>
        >;
        const $incomingResultOk279999 = Result.match<
          import("better-result").InferOk<NonNullable<typeof incoming>>,
          import("better-result").InferErr<NonNullable<typeof incoming>>,
          boolean
        >(incoming, {
          ok: (value) => {
            $incomingResultValue279999 = value;
            return true;
          },
          err: (error) => {
            $incomingResultError279999 = error;
            return false;
          },
        });
        if (($incomingResultOk279999 ? "ok" : "error") === "error")
          return Result.err($incomingResultError279999);
        if (
          $observedResultValue279831.modelHeadId !== $sourceResultValue279619.modelHeadId ||
          $observedResultValue279831.uiHeadId !== $sourceResultValue279619.uiHeadId ||
          $incomingResultValue279999?.kind !== "workspace-observation" ||
          $incomingResultValue279999.fromStateId !== $sourceResultValue279619.id
        ) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "abandonHistoryNavigation",
              `History operation '${input.operationId}' has an invalid observation`,
            ),
          );
        }
      }
      const error: StoredHistoryCommandError = {
        type: "history-command-error",
        code: "history-recovery-abandoned",
        commandId: $operationResultValue278994.commandId,
        message: input.message,
      };
      const saved = this.saveHistoryCommandResultResult($operationResultValue278994, error);
      const saveError = saved.match({ ok: () => null, err: (error) => error });
      if (saveError !== null) return Result.err(saveError);
      const deleted = this.deleteHistoryOperationRowResult($operationResultValue278994.id);
      const deletionError = deleted.match({ ok: () => null, err: (error) => error });
      if (deletionError !== null) return Result.err(deletionError);
      return Result.ok(error);
    });
  }

  reservePendingRunFinalization(
    input: ReservePendingStoredRunFinalization,
  ): PendingStoredRunFinalization {
    return storeResultToLegacy(this.reservePendingRunFinalizationResult(input));
  }

  reservePendingRunFinalizationResult(
    input: ReservePendingStoredRunFinalization,
  ): ResultType<PendingStoredRunFinalization, MiniLilacStoreOperationError> {
    const runStatus = input.runStatus;
    const sessionStatus = input.sessionStatus;
    const providerState = input.providerState ?? null;
    const promotion = input.claudeBindingPromotion ?? null;
    const namedPromotion = input.namedClaudeBindingPromotion ?? null;
    if (promotion !== null && namedPromotion !== null) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "reservePendingRunFinalization",
          "A run cannot promote both main and named Claude bindings",
        ),
      );
    }
    if (
      (promotion !== null || namedPromotion !== null) &&
      providerState?.lastFamily !== "claude-code"
    ) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "reservePendingRunFinalization",
          "A Claude binding promotion requires Claude provider-state metadata",
        ),
      );
    }
    if (
      input.inputTokens !== null &&
      (!Number.isInteger(input.inputTokens) || input.inputTokens < 0)
    ) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "reservePendingRunFinalization",
          "Pending run input tokens must be a non-negative integer",
        ),
      );
    }
    const terminalResult = serializeOptionalTerminalResult(input, "reservePendingRunFinalization");
    let $terminalResultResultValue282880!: import("better-result").InferOk<
      NonNullable<typeof terminalResult>
    >;
    let $terminalResultResultError282880!: import("better-result").InferErr<
      NonNullable<typeof terminalResult>
    >;
    const $terminalResultResultOk282880 = Result.match<
      import("better-result").InferOk<NonNullable<typeof terminalResult>>,
      import("better-result").InferErr<NonNullable<typeof terminalResult>>,
      boolean
    >(terminalResult, {
      ok: (value) => {
        $terminalResultResultValue282880 = value;
        return true;
      },
      err: (error) => {
        $terminalResultResultError282880 = error;
        return false;
      },
    });
    if (($terminalResultResultOk282880 ? "ok" : "error") === "error")
      return Result.err($terminalResultResultError282880);
    const serializedPromotion =
      promotion === null
        ? Result.ok<string | null>(null)
        : serializeStoreValueResult(promotion, "reservePendingRunFinalization.promotion");
    let $serializedPromotionResultValue283064!: import("better-result").InferOk<
      NonNullable<typeof serializedPromotion>
    >;
    let $serializedPromotionResultError283064!: import("better-result").InferErr<
      NonNullable<typeof serializedPromotion>
    >;
    const $serializedPromotionResultOk283064 = Result.match<
      import("better-result").InferOk<NonNullable<typeof serializedPromotion>>,
      import("better-result").InferErr<NonNullable<typeof serializedPromotion>>,
      boolean
    >(serializedPromotion, {
      ok: (value) => {
        $serializedPromotionResultValue283064 = value;
        return true;
      },
      err: (error) => {
        $serializedPromotionResultError283064 = error;
        return false;
      },
    });
    if (($serializedPromotionResultOk283064 ? "ok" : "error") === "error")
      return Result.err($serializedPromotionResultError283064);
    const serializedNamedPromotion =
      namedPromotion === null
        ? Result.ok<string | null>(null)
        : serializeStoreValueResult(namedPromotion, "reservePendingRunFinalization.namedPromotion");
    let $serializedNamedPromotionResultValue283347!: import("better-result").InferOk<
      NonNullable<typeof serializedNamedPromotion>
    >;
    let $serializedNamedPromotionResultError283347!: import("better-result").InferErr<
      NonNullable<typeof serializedNamedPromotion>
    >;
    const $serializedNamedPromotionResultOk283347 = Result.match<
      import("better-result").InferOk<NonNullable<typeof serializedNamedPromotion>>,
      import("better-result").InferErr<NonNullable<typeof serializedNamedPromotion>>,
      boolean
    >(serializedNamedPromotion, {
      ok: (value) => {
        $serializedNamedPromotionResultValue283347 = value;
        return true;
      },
      err: (error) => {
        $serializedNamedPromotionResultError283347 = error;
        return false;
      },
    });
    if (($serializedNamedPromotionResultOk283347 ? "ok" : "error") === "error") {
      return Result.err($serializedNamedPromotionResultError283347);
    }
    return this.runStoreTransactionResult<
      PendingStoredRunFinalization,
      MiniLilacStoreOperationError
    >("reservePendingRunFinalization", () => {
      const workspace = this.getWorkspaceForSessionResult(input.sessionId);
      let $workspaceResultValue283837!: import("better-result").InferOk<
        NonNullable<typeof workspace>
      >;
      let $workspaceResultError283837!: import("better-result").InferErr<
        NonNullable<typeof workspace>
      >;
      const $workspaceResultOk283837 = Result.match<
        import("better-result").InferOk<NonNullable<typeof workspace>>,
        import("better-result").InferErr<NonNullable<typeof workspace>>,
        boolean
      >(workspace, {
        ok: (value) => {
          $workspaceResultValue283837 = value;
          return true;
        },
        err: (error) => {
          $workspaceResultError283837 = error;
          return false;
        },
      });
      if (($workspaceResultOk283837 ? "ok" : "error") === "error")
        return Result.err($workspaceResultError283837);
      if (
        this.database
          .query("SELECT 1 FROM history_operations WHERE workspace_id = ?")
          .get($workspaceResultValue283837.id)
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "reservePendingRunFinalization",
            `Workspace '${$workspaceResultValue283837.id}' has a retained history operation`,
          ),
        );
      }
      if (
        this.database
          .query("SELECT 1 FROM pending_run_finalizations WHERE workspace_id = ?")
          .get($workspaceResultValue283837.id)
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "reservePendingRunFinalization",
            `Workspace '${$workspaceResultValue283837.id}' already has a pending run finalization`,
          ),
        );
      }
      const activeRunRow = this.database
        .query(
          `SELECT runs.* FROM sessions
           JOIN runs ON runs.id = sessions.active_run_id AND runs.session_id = sessions.id
           WHERE sessions.id = ? AND runs.parent_run_id IS NULL AND runs.status = 'active'`,
        )
        .get(input.sessionId);
      const activeRun = activeRunRow
        ? decodeRunRow(activeRunRow, `${input.sessionId}:active-root`)
        : Result.ok(null);
      let $activeRunResultValue285085!: import("better-result").InferOk<
        NonNullable<typeof activeRun>
      >;
      let $activeRunResultError285085!: import("better-result").InferErr<
        NonNullable<typeof activeRun>
      >;
      const $activeRunResultOk285085 = Result.match<
        import("better-result").InferOk<NonNullable<typeof activeRun>>,
        import("better-result").InferErr<NonNullable<typeof activeRun>>,
        boolean
      >(activeRun, {
        ok: (value) => {
          $activeRunResultValue285085 = value;
          return true;
        },
        err: (error) => {
          $activeRunResultError285085 = error;
          return false;
        },
      });
      if (($activeRunResultOk285085 ? "ok" : "error") === "error")
        return Result.err($activeRunResultError285085);
      const session = this.getSessionResult(input.sessionId);
      let $sessionResultValue285296!: import("better-result").InferOk<NonNullable<typeof session>>;
      let $sessionResultError285296!: import("better-result").InferErr<NonNullable<typeof session>>;
      const $sessionResultOk285296 = Result.match<
        import("better-result").InferOk<NonNullable<typeof session>>,
        import("better-result").InferErr<NonNullable<typeof session>>,
        boolean
      >(session, {
        ok: (value) => {
          $sessionResultValue285296 = value;
          return true;
        },
        err: (error) => {
          $sessionResultError285296 = error;
          return false;
        },
      });
      if (($sessionResultOk285296 ? "ok" : "error") === "error")
        return Result.err($sessionResultError285296);
      const transition = this.getHistoryTransitionResult(input.openTransitionId);
      let $transitionResultValue285430!: import("better-result").InferOk<
        NonNullable<typeof transition>
      >;
      let $transitionResultError285430!: import("better-result").InferErr<
        NonNullable<typeof transition>
      >;
      const $transitionResultOk285430 = Result.match<
        import("better-result").InferOk<NonNullable<typeof transition>>,
        import("better-result").InferErr<NonNullable<typeof transition>>,
        boolean
      >(transition, {
        ok: (value) => {
          $transitionResultValue285430 = value;
          return true;
        },
        err: (error) => {
          $transitionResultError285430 = error;
          return false;
        },
      });
      if (($transitionResultOk285430 ? "ok" : "error") === "error")
        return Result.err($transitionResultError285430);
      const history = this.getSessionHistoryResult(input.sessionId);
      let $historyResultValue285590!: import("better-result").InferOk<NonNullable<typeof history>>;
      let $historyResultError285590!: import("better-result").InferErr<NonNullable<typeof history>>;
      const $historyResultOk285590 = Result.match<
        import("better-result").InferOk<NonNullable<typeof history>>,
        import("better-result").InferErr<NonNullable<typeof history>>,
        boolean
      >(history, {
        ok: (value) => {
          $historyResultValue285590 = value;
          return true;
        },
        err: (error) => {
          $historyResultError285590 = error;
          return false;
        },
      });
      if (($historyResultOk285590 ? "ok" : "error") === "error")
        return Result.err($historyResultError285590);
      if (
        !["streaming", "cancelling"].includes($sessionResultValue285296.status) ||
        $activeRunResultValue285085?.id !== input.runId ||
        $transitionResultValue285430.sessionId !== input.sessionId ||
        $transitionResultValue285430.kind !== "user-message" ||
        $transitionResultValue285430.toStateId !== null ||
        $transitionResultValue285430.rootRunId !== input.runId ||
        $historyResultValue285590.currentStateId !== $transitionResultValue285430.fromStateId
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "reservePendingRunFinalization",
            `Pending finalization for run '${input.runId}' is not coherent`,
          ),
        );
      }
      const canonicalUiMessages = this.getUiMessagesResult(input.sessionId);
      let $canonicalUiMessagesResultValue286373!: import("better-result").InferOk<
        NonNullable<typeof canonicalUiMessages>
      >;
      let $canonicalUiMessagesResultError286373!: import("better-result").InferErr<
        NonNullable<typeof canonicalUiMessages>
      >;
      const $canonicalUiMessagesResultOk286373 = Result.match<
        import("better-result").InferOk<NonNullable<typeof canonicalUiMessages>>,
        import("better-result").InferErr<NonNullable<typeof canonicalUiMessages>>,
        boolean
      >(canonicalUiMessages, {
        ok: (value) => {
          $canonicalUiMessagesResultValue286373 = value;
          return true;
        },
        err: (error) => {
          $canonicalUiMessagesResultError286373 = error;
          return false;
        },
      });
      if (($canonicalUiMessagesResultOk286373 ? "ok" : "error") === "error")
        return Result.err($canonicalUiMessagesResultError286373);
      // Automatic in-run compaction can replace the complete model chain and
      // currently has no persisted rewrite provenance. UI continuity plus the
      // open transition identifies the turn.
      if (!isCanonicalPrefix($canonicalUiMessagesResultValue286373, input.uiMessages)) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "reservePendingRunFinalization",
            "Final UI transcript does not extend the canonical active transcript",
          ),
        );
      }
      const fromState = this.getHistoryStateResult($transitionResultValue285430.fromStateId);
      let $fromStateResultValue287054!: import("better-result").InferOk<
        NonNullable<typeof fromState>
      >;
      let $fromStateResultError287054!: import("better-result").InferErr<
        NonNullable<typeof fromState>
      >;
      const $fromStateResultOk287054 = Result.match<
        import("better-result").InferOk<NonNullable<typeof fromState>>,
        import("better-result").InferErr<NonNullable<typeof fromState>>,
        boolean
      >(fromState, {
        ok: (value) => {
          $fromStateResultValue287054 = value;
          return true;
        },
        err: (error) => {
          $fromStateResultError287054 = error;
          return false;
        },
      });
      if (($fromStateResultOk287054 ? "ok" : "error") === "error")
        return Result.err($fromStateResultError287054);
      const rawFromUiMessages = this.readSerializedChainResult(
        input.sessionId,
        "ui",
        $fromStateResultValue287054.uiHeadId,
      );
      let $rawFromUiMessagesResultValue287212!: import("better-result").InferOk<
        NonNullable<typeof rawFromUiMessages>
      >;
      let $rawFromUiMessagesResultError287212!: import("better-result").InferErr<
        NonNullable<typeof rawFromUiMessages>
      >;
      const $rawFromUiMessagesResultOk287212 = Result.match<
        import("better-result").InferOk<NonNullable<typeof rawFromUiMessages>>,
        import("better-result").InferErr<NonNullable<typeof rawFromUiMessages>>,
        boolean
      >(rawFromUiMessages, {
        ok: (value) => {
          $rawFromUiMessagesResultValue287212 = value;
          return true;
        },
        err: (error) => {
          $rawFromUiMessagesResultError287212 = error;
          return false;
        },
      });
      if (($rawFromUiMessagesResultOk287212 ? "ok" : "error") === "error")
        return Result.err($rawFromUiMessagesResultError287212);
      const decodedFromUiMessages = decodeMiniLilacUiTranscript({
        rawValues: $rawFromUiMessagesResultValue287212,
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: $fromStateResultValue287054.id,
      });
      let $decodedFromUiMessagesResultValue287450!: import("better-result").InferOk<
        NonNullable<typeof decodedFromUiMessages>
      >;
      let $decodedFromUiMessagesResultError287450!: import("better-result").InferErr<
        NonNullable<typeof decodedFromUiMessages>
      >;
      const $decodedFromUiMessagesResultOk287450 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decodedFromUiMessages>>,
        import("better-result").InferErr<NonNullable<typeof decodedFromUiMessages>>,
        boolean
      >(decodedFromUiMessages, {
        ok: (value) => {
          $decodedFromUiMessagesResultValue287450 = value;
          return true;
        },
        err: (error) => {
          $decodedFromUiMessagesResultError287450 = error;
          return false;
        },
      });
      if (($decodedFromUiMessagesResultOk287450 ? "ok" : "error") === "error")
        return Result.err($decodedFromUiMessagesResultError287450);
      const fromUiMessages = $decodedFromUiMessagesResultValue287450.value;
      const admittedMessage = $transitionResultValue285430.userMessage;
      if (
        admittedMessage === null ||
        !canonicalValuesEqual(
          $canonicalUiMessagesResultValue286373[fromUiMessages.length],
          admittedMessage,
        ) ||
        !canonicalValuesEqual(input.uiMessages[fromUiMessages.length], admittedMessage)
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "reservePendingRunFinalization",
            "Final UI transcript does not retain the admitted open user message",
          ),
        );
      }
      const modelHeadId = this.internChain(input.sessionId, "model", input.modelMessages);
      const uiHeadId = this.internChain(input.sessionId, "ui", input.uiMessages);
      const now = new Date().toISOString();
      this.database
        .query(
          `INSERT INTO pending_run_finalizations
            (run_id, session_id, workspace_id, open_transition_id, model_head_id, ui_head_id,
             run_status, session_status, error, terminal_result_json, input_tokens,
             last_provider_family, contains_cross_family_turns, claude_binding_promotion_json,
             named_claude_binding_promotion_json, prepared_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          input.sessionId,
          $workspaceResultValue283837.id,
          input.openTransitionId,
          modelHeadId,
          uiHeadId,
          runStatus,
          sessionStatus,
          input.error,
          $terminalResultResultValue282880,
          input.inputTokens,
          providerState?.lastFamily ?? null,
          storedProviderStateFlag(providerState),
          $serializedPromotionResultValue283064,
          $serializedNamedPromotionResultValue283347,
          now,
        );
      const pending = this.getPendingRunFinalizationResult(input.runId);
      let $pendingResultValue289582!: import("better-result").InferOk<NonNullable<typeof pending>>;
      let $pendingResultError289582!: import("better-result").InferErr<NonNullable<typeof pending>>;
      const $pendingResultOk289582 = Result.match<
        import("better-result").InferOk<NonNullable<typeof pending>>,
        import("better-result").InferErr<NonNullable<typeof pending>>,
        boolean
      >(pending, {
        ok: (value) => {
          $pendingResultValue289582 = value;
          return true;
        },
        err: (error) => {
          $pendingResultError289582 = error;
          return false;
        },
      });
      if (($pendingResultOk289582 ? "ok" : "error") === "error")
        return Result.err($pendingResultError289582);
      if ($pendingResultValue289582 === null) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "reservePendingRunFinalization",
            `Pending finalization for run '${input.runId}' was not created`,
          ),
        );
      }
      return Result.ok($pendingResultValue289582);
    });
  }

  getPendingRunFinalization(runId: string): PendingStoredRunFinalization | null {
    return storeResultToLegacy(this.getPendingRunFinalizationResult(runId));
  }

  getPendingRunFinalizationResult(
    runId: string,
  ): ResultType<PendingStoredRunFinalization | null, MiniLilacPersistenceError> {
    return this.runHistoryReadResult("getPendingRunFinalization", () =>
      this.decodeStructuralHistoryRow({
        kind: "pending-finalization",
        row: this.database
          .query("SELECT * FROM pending_run_finalizations WHERE run_id = ?")
          .get(runId),
        recordId: runId,
      }),
    );
  }

  listPendingRunFinalizations(): readonly PendingStoredRunFinalization[] {
    return storeResultToLegacy(this.listPendingRunFinalizationsResult());
  }

  listPendingRunFinalizationsResult(): ResultType<
    readonly PendingStoredRunFinalization[],
    MiniLilacPersistenceError
  > {
    return this.runHistoryReadResult("listPendingRunFinalizations", () => {
      return this.decodeStructuralHistoryRows({
        kind: "pending-finalization",
        rows: this.database
          .query("SELECT * FROM pending_run_finalizations ORDER BY prepared_at, rowid")
          .all(),
        recordId: "pending-finalization",
      });
    });
  }

  listRecoverableOpenRootRuns(): readonly RecoverableStoredOpenRootRun[] {
    return storeResultToLegacy(this.listRecoverableOpenRootRunsResult());
  }

  listRecoverableOpenRootRunsResult(): ResultType<
    readonly RecoverableStoredOpenRootRun[],
    MiniLilacPersistenceError
  > {
    return this.runHistoryReadResult("listRecoverableOpenRootRuns", () => {
      const rows = this.database
        .query(
          `SELECT runs.id AS run_id, sessions.id AS session_id,
                    sessions.workspace_id, transition.id AS open_transition_id,
                    sessions.input_tokens
             FROM history_transitions AS transition
             JOIN runs ON runs.id = transition.root_run_id
               AND runs.session_id = transition.session_id
             JOIN sessions ON sessions.id = runs.session_id
               AND sessions.active_run_id = runs.id
             LEFT JOIN pending_run_finalizations AS pending ON pending.run_id = runs.id
             WHERE transition.kind = 'user-message' AND transition.to_state_id IS NULL
               AND runs.parent_run_id IS NULL AND runs.status = 'active'
               AND sessions.status IN ('streaming', 'cancelling')
               AND pending.run_id IS NULL
             ORDER BY runs.started_at, runs.rowid`,
        )
        .all();
      return this.decodeStructuralHistoryRows({
        kind: "recoverable-open-root-run",
        rows,
        recordId: "recoverable",
      });
    });
  }

  recoverInterruptedRuntimeState(): void {
    storeResultToLegacy(this.recoverInterruptedRuntimeStateResult());
  }

  recoverInterruptedRuntimeStateResult(): ResultType<void, MiniLilacStoreOperationError> {
    const now = new Date().toISOString();
    const recovery = this.runStoreTransactionResult("recoverInterruptedRuntimeState", () => {
      const interruptedAttempts = decodeMiniLilacStoreRows({
        kind: "interrupted-claude-attempt",
        rows: this.database
          .query(
            `SELECT 'main' AS product, attempt.request_id, attempt.session_id,
                      attempt.provider_id, attempt.request_client,
                      attempt.source_history_state_id, attempt.expected_binding_revision,
                      session.model, session.reasoning
               FROM mini_main_claude_attempts AS attempt
               JOIN sessions AS session ON session.id = attempt.session_id
               WHERE attempt.state = 'active'
               UNION ALL
               SELECT 'named' AS product, attempt.request_id, attempt.session_id,
                      attempt.provider_id, attempt.request_client,
                      attempt.source_history_state_id, attempt.expected_binding_revision,
                      session.model, session.reasoning
               FROM mini_named_claude_attempts AS attempt
               JOIN sessions AS session ON session.id = attempt.session_id
               WHERE attempt.state = 'active'`,
          )
          .all(),
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: "interrupted-claude-attempts",
      });
      let $interruptedAttemptsResultValue293127!: import("better-result").InferOk<
        NonNullable<typeof interruptedAttempts>
      >;
      let $interruptedAttemptsResultError293127!: import("better-result").InferErr<
        NonNullable<typeof interruptedAttempts>
      >;
      const $interruptedAttemptsResultOk293127 = Result.match<
        import("better-result").InferOk<NonNullable<typeof interruptedAttempts>>,
        import("better-result").InferErr<NonNullable<typeof interruptedAttempts>>,
        boolean
      >(interruptedAttempts, {
        ok: (value) => {
          $interruptedAttemptsResultValue293127 = value;
          return true;
        },
        err: (error) => {
          $interruptedAttemptsResultError293127 = error;
          return false;
        },
      });
      if (($interruptedAttemptsResultOk293127 ? "ok" : "error") === "error")
        return Result.err($interruptedAttemptsResultError293127);
      this.database
        .query(
          `UPDATE mini_main_claude_attempts SET state = 'uncertain', updated_at = ?
           WHERE state = 'active'`,
        )
        .run(now);
      this.database
        .query(
          `UPDATE mini_named_claude_attempts SET state = 'uncertain', updated_at = ?
           WHERE state = 'active'`,
        )
        .run(now);
      this.database
        .query(
          `UPDATE runs SET status = 'error', error = ?, finished_at = ?
           WHERE status = 'active' AND NOT EXISTS (
             SELECT 1 FROM history_transitions AS transition
             WHERE transition.root_run_id = runs.id AND transition.session_id = runs.session_id
               AND transition.to_state_id IS NULL
           )`,
        )
        .run("Runtime process stopped while run was active", now);
      this.database
        .query(
          `UPDATE sessions SET status = 'error', active_run_id = NULL,
             queued_steering_count = 0, updated_at = ?
           WHERE status IN ('streaming', 'cancelling') AND NOT EXISTS (
             SELECT 1 FROM runs
             JOIN history_transitions AS transition
               ON transition.root_run_id = runs.id AND transition.session_id = runs.session_id
             WHERE runs.id = sessions.active_run_id AND runs.session_id = sessions.id
               AND runs.status = 'active' AND transition.to_state_id IS NULL
           )`,
        )
        .run(now);
      this.database
        .query("UPDATE sessions SET status = 'idle', updated_at = ? WHERE status = 'compacting'")
        .run(now);
      this.database
        .query("DELETE FROM commands WHERE result_json IS NULL AND side_effect_started = 0")
        .run();
      const owners = decodeMiniLilacStoreRows({
        kind: "claude-attempt-owner",
        rows: this.database
          .query(
            `SELECT DISTINCT session_id, provider_id FROM mini_main_claude_attempts
                 ORDER BY session_id, provider_id`,
          )
          .all(),
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: "main-claude-attempt-owners",
      });
      let $ownersResultValue296207!: import("better-result").InferOk<NonNullable<typeof owners>>;
      let $ownersResultError296207!: import("better-result").InferErr<NonNullable<typeof owners>>;
      const $ownersResultOk296207 = Result.match<
        import("better-result").InferOk<NonNullable<typeof owners>>,
        import("better-result").InferErr<NonNullable<typeof owners>>,
        boolean
      >(owners, {
        ok: (value) => {
          $ownersResultValue296207 = value;
          return true;
        },
        err: (error) => {
          $ownersResultError296207 = error;
          return false;
        },
      });
      if (($ownersResultOk296207 ? "ok" : "error") === "error")
        return Result.err($ownersResultError296207);
      for (const owner of $ownersResultValue296207.value) {
        this.pruneMiniMainClaudeAttempts(owner.session_id, owner.provider_id);
      }
      const namedOwners = decodeMiniLilacStoreRows({
        kind: "claude-attempt-owner",
        rows: this.database
          .query(
            `SELECT DISTINCT session_id, provider_id FROM mini_named_claude_attempts
                 ORDER BY session_id, provider_id`,
          )
          .all(),
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: "named-claude-attempt-owners",
      });
      let $namedOwnersResultValue296827!: import("better-result").InferOk<
        NonNullable<typeof namedOwners>
      >;
      let $namedOwnersResultError296827!: import("better-result").InferErr<
        NonNullable<typeof namedOwners>
      >;
      const $namedOwnersResultOk296827 = Result.match<
        import("better-result").InferOk<NonNullable<typeof namedOwners>>,
        import("better-result").InferErr<NonNullable<typeof namedOwners>>,
        boolean
      >(namedOwners, {
        ok: (value) => {
          $namedOwnersResultValue296827 = value;
          return true;
        },
        err: (error) => {
          $namedOwnersResultError296827 = error;
          return false;
        },
      });
      if (($namedOwnersResultOk296827 ? "ok" : "error") === "error")
        return Result.err($namedOwnersResultError296827);
      for (const owner of $namedOwnersResultValue296827.value) {
        this.pruneMiniNamedClaudeAttempts(owner.session_id, owner.provider_id);
      }
      const diagnostics = this.getMiniClaudeRetentionDiagnosticsResult();
      let $diagnosticsResultValue297470!: import("better-result").InferOk<
        NonNullable<typeof diagnostics>
      >;
      let $diagnosticsResultError297470!: import("better-result").InferErr<
        NonNullable<typeof diagnostics>
      >;
      const $diagnosticsResultOk297470 = Result.match<
        import("better-result").InferOk<NonNullable<typeof diagnostics>>,
        import("better-result").InferErr<NonNullable<typeof diagnostics>>,
        boolean
      >(diagnostics, {
        ok: (value) => {
          $diagnosticsResultValue297470 = value;
          return true;
        },
        err: (error) => {
          $diagnosticsResultError297470 = error;
          return false;
        },
      });
      if (($diagnosticsResultOk297470 ? "ok" : "error") === "error")
        return Result.err($diagnosticsResultError297470);
      return Result.ok({
        interruptedAttempts: $interruptedAttemptsResultValue293127.value,
        diagnostics: $diagnosticsResultValue297470,
      });
    });
    let $recoveryResultValue293031!: import("better-result").InferOk<NonNullable<typeof recovery>>;
    let $recoveryResultError293031!: import("better-result").InferErr<NonNullable<typeof recovery>>;
    const $recoveryResultOk293031 = Result.match<
      import("better-result").InferOk<NonNullable<typeof recovery>>,
      import("better-result").InferErr<NonNullable<typeof recovery>>,
      boolean
    >(recovery, {
      ok: (value) => {
        $recoveryResultValue293031 = value;
        return true;
      },
      err: (error) => {
        $recoveryResultError293031 = error;
        return false;
      },
    });
    if (($recoveryResultOk293031 ? "ok" : "error") === "error")
      return Result.err($recoveryResultError293031);
    for (const attempt of $recoveryResultValue293031.interruptedAttempts) {
      logger.debug("mini_claude.attempt_recovered", {
        requestId: attempt.request_id,
        sessionId: attempt.session_id,
        providerId: attempt.provider_id,
        requestClient: attempt.request_client,
        owner: attempt.product,
        mode: "recovery",
        outcome: "uncertain",
        reason: "runtime-restart",
        bindingHead: attempt.source_history_state_id,
        bindingRevision: attempt.expected_binding_revision,
        model: attempt.model,
        reasoning: attempt.reasoning,
      });
    }
    if (
      $recoveryResultValue293031.diagnostics.orphanBindingCount > 0 ||
      $recoveryResultValue293031.diagnostics.orphanAttemptCount > 0
    ) {
      logger.warn("mini_claude.retention_orphans_detected", $recoveryResultValue293031.diagnostics);
    } else {
      logger.debug("mini_claude.retention_diagnostics", $recoveryResultValue293031.diagnostics);
    }
    return Result.ok(undefined);
  }

  commitPendingRunFinalization(
    input: CommitPendingStoredRunFinalization,
  ): CommittedPendingStoredRunFinalization {
    return storeResultToLegacy(this.commitPendingRunFinalizationResult(input));
  }

  commitPendingRunFinalizationResult(
    input: CommitPendingStoredRunFinalization,
  ): ResultType<CommittedPendingStoredRunFinalization, MiniLilacStoreOperationError> {
    const requestedProviderState = input.providerState ?? null;
    const requestedPromotion = input.claudeBindingPromotion ?? null;
    const requestedNamedPromotion = input.namedClaudeBindingPromotion ?? null;
    return this.runStoreTransactionResult("commitPendingRunFinalization", () => {
      const pending = this.getPendingRunFinalizationResult(input.runId);
      let $pendingResultValue299484!: import("better-result").InferOk<NonNullable<typeof pending>>;
      let $pendingResultError299484!: import("better-result").InferErr<NonNullable<typeof pending>>;
      const $pendingResultOk299484 = Result.match<
        import("better-result").InferOk<NonNullable<typeof pending>>,
        import("better-result").InferErr<NonNullable<typeof pending>>,
        boolean
      >(pending, {
        ok: (value) => {
          $pendingResultValue299484 = value;
          return true;
        },
        err: (error) => {
          $pendingResultError299484 = error;
          return false;
        },
      });
      if (($pendingResultOk299484 ? "ok" : "error") === "error")
        return Result.err($pendingResultError299484);
      if ($pendingResultValue299484 === null) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitPendingRunFinalization",
            `Pending finalization for run '${input.runId}' was not found`,
          ),
        );
      }
      if (
        requestedProviderState !== null &&
        $pendingResultValue299484.providerState !== null &&
        !canonicalValuesEqual(requestedProviderState, $pendingResultValue299484.providerState)
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitPendingRunFinalization",
            "Pending finalization provider-state metadata changed before commit",
          ),
        );
      }
      if (
        requestedPromotion !== null &&
        $pendingResultValue299484.claudeBindingPromotion !== null &&
        !canonicalValuesEqual(requestedPromotion, $pendingResultValue299484.claudeBindingPromotion)
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitPendingRunFinalization",
            "Pending finalization Claude promotion metadata changed before commit",
          ),
        );
      }
      if (
        requestedNamedPromotion !== null &&
        $pendingResultValue299484.namedClaudeBindingPromotion !== null &&
        !canonicalValuesEqual(
          requestedNamedPromotion,
          $pendingResultValue299484.namedClaudeBindingPromotion,
        )
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitPendingRunFinalization",
            "Pending finalization named Claude promotion metadata changed before commit",
          ),
        );
      }
      const providerState = requestedProviderState ?? $pendingResultValue299484.providerState;
      const promotion = requestedPromotion ?? $pendingResultValue299484.claudeBindingPromotion;
      const namedPromotion =
        requestedNamedPromotion ?? $pendingResultValue299484.namedClaudeBindingPromotion;
      if (promotion !== null && namedPromotion !== null) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitPendingRunFinalization",
            "A run cannot promote both main and named Claude bindings",
          ),
        );
      }
      if (
        (promotion !== null || namedPromotion !== null) &&
        providerState?.lastFamily !== "claude-code"
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitPendingRunFinalization",
            "A Claude binding promotion requires Claude provider-state metadata",
          ),
        );
      }
      const available = this.assertWorkspaceHistoryAvailableForOwnerResult(
        $pendingResultValue299484.workspaceId,
        $pendingResultValue299484.sessionId,
        { kind: "pending-run-finalization", runId: $pendingResultValue299484.runId },
      );
      const availabilityError = available.match({ ok: () => null, err: (error) => error });
      if (availabilityError !== null) return Result.err(availabilityError);
      const activeRun = this.getActiveRootRun($pendingResultValue299484.sessionId);
      const transition = this.getHistoryTransitionResult(
        $pendingResultValue299484.openTransitionId,
      );
      let $transitionResultValue302471!: import("better-result").InferOk<
        NonNullable<typeof transition>
      >;
      let $transitionResultError302471!: import("better-result").InferErr<
        NonNullable<typeof transition>
      >;
      const $transitionResultOk302471 = Result.match<
        import("better-result").InferOk<NonNullable<typeof transition>>,
        import("better-result").InferErr<NonNullable<typeof transition>>,
        boolean
      >(transition, {
        ok: (value) => {
          $transitionResultValue302471 = value;
          return true;
        },
        err: (error) => {
          $transitionResultError302471 = error;
          return false;
        },
      });
      if (($transitionResultOk302471 ? "ok" : "error") === "error")
        return Result.err($transitionResultError302471);
      const history = this.getSessionHistoryResult($pendingResultValue299484.sessionId);
      let $historyResultValue302639!: import("better-result").InferOk<NonNullable<typeof history>>;
      let $historyResultError302639!: import("better-result").InferErr<NonNullable<typeof history>>;
      const $historyResultOk302639 = Result.match<
        import("better-result").InferOk<NonNullable<typeof history>>,
        import("better-result").InferErr<NonNullable<typeof history>>,
        boolean
      >(history, {
        ok: (value) => {
          $historyResultValue302639 = value;
          return true;
        },
        err: (error) => {
          $historyResultError302639 = error;
          return false;
        },
      });
      if (($historyResultOk302639 ? "ok" : "error") === "error")
        return Result.err($historyResultError302639);
      if (
        activeRun?.id !== $pendingResultValue299484.runId ||
        $transitionResultValue302471.sessionId !== $pendingResultValue299484.sessionId ||
        $transitionResultValue302471.kind !== "user-message" ||
        $transitionResultValue302471.toStateId !== null ||
        $transitionResultValue302471.rootRunId !== $pendingResultValue299484.runId ||
        $historyResultValue302639.currentStateId !== $transitionResultValue302471.fromStateId
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitPendingRunFinalization",
            `Pending finalization for run '${$pendingResultValue299484.runId}' is no longer coherent`,
          ),
        );
      }
      if (providerState !== null) {
        const conservative = this.assertConservativeProviderTransitionResult(
          $transitionResultValue302471.fromStateId,
          providerState,
        );
        const transitionError = conservative.match({ ok: () => null, err: (error) => error });
        if (transitionError !== null) return Result.err(transitionError);
      }
      const destination: CreateStoredHistoryState = {
        id: input.destinationStateId,
        sessionId: $pendingResultValue299484.sessionId,
        workspaceId: $pendingResultValue299484.workspaceId,
        modelHeadId: $pendingResultValue299484.modelHeadId,
        uiHeadId: $pendingResultValue299484.uiHeadId,
        workspaceSnapshotId: input.workspaceSnapshotId,
        workspaceStatus: input.workspaceStatus,
        workspaceUnavailableReason: input.workspaceUnavailableReason,
        origin: "turn-boundary",
        providerState,
      };
      const closed = this.closeHistoryTransitionResult(
        $pendingResultValue299484.openTransitionId,
        destination,
        {
          select: true,
        },
      );
      const closeError = closed.match({ ok: () => null, err: (error) => error });
      if (closeError !== null) return Result.err(closeError);
      const terminalResult = serializeOptionalTerminalResult(
        $pendingResultValue299484,
        "commitPendingRunFinalization",
      );
      let $terminalResultResultValue304426!: import("better-result").InferOk<
        NonNullable<typeof terminalResult>
      >;
      let $terminalResultResultError304426!: import("better-result").InferErr<
        NonNullable<typeof terminalResult>
      >;
      const $terminalResultResultOk304426 = Result.match<
        import("better-result").InferOk<NonNullable<typeof terminalResult>>,
        import("better-result").InferErr<NonNullable<typeof terminalResult>>,
        boolean
      >(terminalResult, {
        ok: (value) => {
          $terminalResultResultValue304426 = value;
          return true;
        },
        err: (error) => {
          $terminalResultResultError304426 = error;
          return false;
        },
      });
      if (($terminalResultResultOk304426 ? "ok" : "error") === "error")
        return Result.err($terminalResultResultError304426);
      const now = new Date().toISOString();
      const finished = this.database
        .query(
          `UPDATE runs SET status = ?, error = ?, terminal_result_json = ?, finished_at = ?
           WHERE id = ? AND session_id = ? AND parent_run_id IS NULL AND status = 'active'`,
        )
        .run(
          $pendingResultValue299484.runStatus,
          $pendingResultValue299484.error,
          $terminalResultResultValue304426,
          now,
          $pendingResultValue299484.runId,
          $pendingResultValue299484.sessionId,
        );
      if (finished.changes !== 1) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitPendingRunFinalization",
            `Run '${$pendingResultValue299484.runId}' is not active`,
          ),
        );
      }
      const updated = this.database
        .query(
          `UPDATE sessions SET status = ?, active_run_id = NULL, queued_steering_count = 0,
             input_tokens = ?, updated_at = ?
           WHERE id = ? AND active_run_id = ? AND status IN ('streaming', 'cancelling')`,
        )
        .run(
          $pendingResultValue299484.sessionStatus,
          $pendingResultValue299484.inputTokens,
          now,
          $pendingResultValue299484.sessionId,
          $pendingResultValue299484.runId,
        );
      if (updated.changes !== 1) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitPendingRunFinalization",
            `Run '${$pendingResultValue299484.runId}' is not active for session '${$pendingResultValue299484.sessionId}'`,
          ),
        );
      }
      let bindingPromotion: CommittedPendingStoredRunFinalization["bindingPromotion"] =
        "not-requested";
      if (promotion !== null) {
        const promoted = this.promoteMiniMainClaudeBinding(
          $pendingResultValue299484,
          this.getRootPromptSourceStateId($pendingResultValue299484),
          destination.id,
          promotion,
        );
        bindingPromotion = promoted ? "promoted" : "cas-failed";
      } else if (namedPromotion !== null) {
        const promoted = this.promoteMiniNamedClaudeBinding(
          $pendingResultValue299484,
          this.getRootPromptSourceStateId($pendingResultValue299484),
          destination.id,
          namedPromotion,
        );
        bindingPromotion = promoted ? "promoted" : "cas-failed";
      }
      const deleted = this.deletePendingRunFinalizationRowResult($pendingResultValue299484.runId);
      const deletionError = deleted.match({ ok: () => null, err: (error) => error });
      if (deletionError !== null) return Result.err(deletionError);
      const state = this.getHistoryStateResult(destination.id);
      let $stateResultValue307024!: import("better-result").InferOk<NonNullable<typeof state>>;
      let $stateResultError307024!: import("better-result").InferErr<NonNullable<typeof state>>;
      const $stateResultOk307024 = Result.match<
        import("better-result").InferOk<NonNullable<typeof state>>,
        import("better-result").InferErr<NonNullable<typeof state>>,
        boolean
      >(state, {
        ok: (value) => {
          $stateResultValue307024 = value;
          return true;
        },
        err: (error) => {
          $stateResultError307024 = error;
          return false;
        },
      });
      if (($stateResultOk307024 ? "ok" : "error") === "error")
        return Result.err($stateResultError307024);
      const snapshot = this.getSessionResult($pendingResultValue299484.sessionId);
      let $snapshotResultValue307156!: import("better-result").InferOk<
        NonNullable<typeof snapshot>
      >;
      let $snapshotResultError307156!: import("better-result").InferErr<
        NonNullable<typeof snapshot>
      >;
      const $snapshotResultOk307156 = Result.match<
        import("better-result").InferOk<NonNullable<typeof snapshot>>,
        import("better-result").InferErr<NonNullable<typeof snapshot>>,
        boolean
      >(snapshot, {
        ok: (value) => {
          $snapshotResultValue307156 = value;
          return true;
        },
        err: (error) => {
          $snapshotResultError307156 = error;
          return false;
        },
      });
      if (($snapshotResultOk307156 ? "ok" : "error") === "error")
        return Result.err($snapshotResultError307156);
      return Result.ok({
        pending: $pendingResultValue299484,
        state: $stateResultValue307024,
        snapshot: $snapshotResultValue307156,
        bindingPromotion,
      });
    });
  }

  private getHistoryStateCanonicalMessageCount(stateId: string): number {
    const state = this.getHistoryState(stateId);
    if (state.modelHeadId === null) return 0;
    return storeResultToLegacy(
      decodeRequiredMiniLilacStoreRow({
        kind: "depth",
        row: this.database
          .query(
            `SELECT depth FROM transcript_nodes
             WHERE id = ? AND session_id = ? AND lane = 'model'`,
          )
          .get(state.modelHeadId, state.sessionId),
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: stateId,
      }),
    ).depth;
  }

  private assertConservativeProviderTransition(
    sourceStateId: string,
    destination: HistoryProviderState,
  ): void {
    storeResultToLegacy(
      this.assertConservativeProviderTransitionResult(sourceStateId, destination),
    );
  }

  private assertConservativeProviderTransitionResult(
    sourceStateId: string,
    destination: HistoryProviderState,
  ): ResultType<void, MiniLilacStoreOperationError> {
    const source = this.getHistoryStateResult(sourceStateId);
    let $sourceResultValue308488!: import("better-result").InferOk<NonNullable<typeof source>>;
    let $sourceResultError308488!: import("better-result").InferErr<NonNullable<typeof source>>;
    const $sourceResultOk308488 = Result.match<
      import("better-result").InferOk<NonNullable<typeof source>>,
      import("better-result").InferErr<NonNullable<typeof source>>,
      boolean
    >(source, {
      ok: (value) => {
        $sourceResultValue308488 = value;
        return true;
      },
      err: (error) => {
        $sourceResultError308488 = error;
        return false;
      },
    });
    if (($sourceResultOk308488 ? "ok" : "error") === "error")
      return Result.err($sourceResultError308488);
    const sourceMessageCount = this.getHistoryStateCanonicalMessageCount(sourceStateId);
    const requiresMixedHistory =
      $sourceResultValue308488.providerState?.containsCrossFamilyTurns === true ||
      ($sourceResultValue308488.providerState === null && sourceMessageCount > 0) ||
      ($sourceResultValue308488.providerState !== null &&
        $sourceResultValue308488.providerState.lastFamily !== destination.lastFamily);
    if (requiresMixedHistory && !destination.containsCrossFamilyTurns) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "assertConservativeProviderTransition",
          `History state '${sourceStateId}' requires conservative cross-family metadata`,
        ),
      );
    }
    return Result.ok(undefined);
  }

  private promoteMiniMainClaudeBinding(
    pending: PendingStoredRunFinalization,
    sourceHistoryStateId: string,
    destinationHistoryStateId: string,
    promotion: PromoteMiniMainClaudeSessionBinding,
  ): boolean {
    if (pending.runStatus !== "completed") return false;
    const attempt = this.getMiniMainClaudeSessionAttempt({
      providerId: promotion.providerId,
      lilacSessionId: pending.sessionId,
      requestId: promotion.requestId,
      attemptIndex: promotion.attemptIndex,
    });
    if (
      attempt === null ||
      attempt.state !== "succeeded" ||
      attempt.requestId !== pending.runId ||
      attempt.sourceHistoryStateId !== sourceHistoryStateId ||
      attempt.sourceCanonicalMessageCount !==
        this.getHistoryStateCanonicalMessageCount(sourceHistoryStateId)
    ) {
      return false;
    }
    if (attempt.expectedBindingRevision !== null) {
      const sourceBinding = this.getMiniMainClaudeState({
        sessionId: pending.sessionId,
        historyStateId: sourceHistoryStateId,
        providerId: promotion.providerId,
      }).binding;
      if (
        sourceBinding === null ||
        sourceBinding.revision !== attempt.expectedBindingRevision ||
        sourceBinding.claudeSessionId !== attempt.sourceSessionId ||
        sourceBinding.requestClient !== attempt.requestClient ||
        sourceBinding.executionScopeHashVersion !== attempt.executionScopeHashVersion ||
        sourceBinding.executionScopeHash !== attempt.executionScopeHash
      ) {
        return false;
      }
    }
    const revision = (attempt.expectedBindingRevision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) return false;
    const inserted = this.database
      .query(
        `INSERT INTO mini_main_claude_bindings
          (session_id, history_state_id, provider_id, binding_protocol_version, provider_family,
           request_client, canonical_message_count, execution_scope_hash_version,
           execution_scope_hash, claude_session_id, native_cwd, native_last_modified,
           native_context_tokens, native_context_max_tokens, last_model_specifier, last_reasoning,
           revision, updated_at)
         VALUES (?, ?, ?, 1, 'claude-code', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, history_state_id, provider_id) DO NOTHING`,
      )
      .run(
        pending.sessionId,
        destinationHistoryStateId,
        promotion.providerId,
        attempt.requestClient,
        this.getHistoryStateCanonicalMessageCount(destinationHistoryStateId),
        attempt.executionScopeHashVersion,
        attempt.executionScopeHash,
        attempt.candidateSessionId,
        promotion.nativeCwd,
        promotion.nativeLastModified,
        promotion.nativeContextTokens,
        promotion.nativeContextMaxTokens,
        promotion.lastModelSpecifier,
        promotion.lastReasoning,
        revision,
        new Date().toISOString(),
      );
    return inserted.changes === 1;
  }

  private promoteMiniNamedClaudeBinding(
    pending: PendingStoredRunFinalization,
    sourceHistoryStateId: string,
    destinationHistoryStateId: string,
    promotion: PromoteMiniNamedClaudeSessionBinding,
  ): boolean {
    if (
      pending.runStatus !== "completed" ||
      !(
        pending.sessionId.startsWith("sub:") &&
        pending.sessionId.lastIndexOf(":named:") > "sub:".length
      ) ||
      this.getRun(pending.runId).depth === 0
    ) {
      return false;
    }
    const attempt = this.getMiniNamedClaudeSessionAttempt({
      providerId: promotion.providerId,
      lilacSessionId: pending.sessionId,
      requestId: promotion.requestId,
      attemptIndex: promotion.attemptIndex,
    });
    if (
      attempt === null ||
      attempt.state !== "succeeded" ||
      attempt.requestId !== pending.runId ||
      attempt.sourceHistoryStateId !== sourceHistoryStateId ||
      attempt.sourceCanonicalMessageCount !==
        this.getHistoryStateCanonicalMessageCount(sourceHistoryStateId)
    ) {
      return false;
    }
    const destinationMessages = this.getHistoryStateModelMessages(destinationHistoryStateId);
    if (
      destinationMessages.length !== promotion.canonicalMessageCount ||
      hashCanonicalMessagesV1(destinationMessages).hash !== promotion.canonicalHeadHash
    ) {
      return false;
    }
    const current = this.getMiniNamedClaudeState({
      sessionId: pending.sessionId,
      providerId: promotion.providerId,
    }).binding;
    if (
      (attempt.expectedBindingRevision === null && current !== null) ||
      (attempt.expectedBindingRevision !== null &&
        (current === null || current.revision !== attempt.expectedBindingRevision))
    ) {
      return false;
    }
    if (
      attempt.sourceSessionId !== null &&
      (current === null ||
        current.historyStateId !== sourceHistoryStateId ||
        current.claudeSessionId !== attempt.sourceSessionId ||
        current.requestClient !== attempt.requestClient ||
        current.executionScopeHashVersion !== attempt.executionScopeHashVersion ||
        current.executionScopeHash !== attempt.executionScopeHash)
    ) {
      return false;
    }
    const revision = (attempt.expectedBindingRevision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) return false;
    const values = [
      destinationHistoryStateId,
      attempt.requestClient,
      promotion.canonicalMessageCount,
      attempt.executionScopeHashVersion,
      attempt.executionScopeHash,
      attempt.candidateSessionId,
      promotion.nativeCwd,
      promotion.nativeLastModified,
      promotion.nativeContextTokens,
      promotion.nativeContextMaxTokens,
      promotion.lastModelSpecifier,
      promotion.lastReasoning,
      revision,
      new Date().toISOString(),
    ] as const;
    if (current === null) {
      return (
        this.database
          .query(
            `INSERT INTO mini_named_claude_bindings
              (session_id, history_state_id, provider_id, binding_protocol_version, provider_family,
               request_client, canonical_message_count, execution_scope_hash_version,
               execution_scope_hash, claude_session_id, native_cwd, native_last_modified,
               native_context_tokens, native_context_max_tokens, last_model_specifier,
               last_reasoning, revision, updated_at)
             VALUES (?, ?, ?, 1, 'claude-code', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id, provider_id) DO NOTHING`,
          )
          .run(
            pending.sessionId,
            destinationHistoryStateId,
            promotion.providerId,
            ...values.slice(1),
          ).changes === 1
      );
    }
    return (
      this.database
        .query(
          `UPDATE mini_named_claude_bindings
           SET history_state_id = ?, request_client = ?, canonical_message_count = ?,
               execution_scope_hash_version = ?, execution_scope_hash = ?, claude_session_id = ?,
               native_cwd = ?, native_last_modified = ?, native_context_tokens = ?,
               native_context_max_tokens = ?, last_model_specifier = ?, last_reasoning = ?,
               revision = ?, updated_at = ?
           WHERE session_id = ? AND provider_id = ? AND revision = ?`,
        )
        .run(...values, pending.sessionId, promotion.providerId, attempt.expectedBindingRevision)
        .changes === 1
    );
  }

  private getRootPromptSourceStateId(pending: PendingStoredRunFinalization): string {
    const row = storeResultToLegacy(
      decodeRequiredMiniLilacStoreRow({
        kind: "root-prompt-source",
        row: this.database
          .query(
            `SELECT from_state_id FROM history_transitions
             WHERE session_id = ? AND root_run_id = ? AND kind = 'user-message'
               AND delivery = 'prompt'
             ORDER BY created_at, rowid
             LIMIT 1`,
          )
          .get(pending.sessionId, pending.runId),
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: pending.runId,
      }),
    );
    return row.from_state_id;
  }

  private pruneMiniMainClaudeAttempts(sessionId: string, providerId: string): void {
    const pruned = this.database
      .query(
        `DELETE FROM mini_main_claude_attempts
         WHERE session_id = ? AND provider_id = ? AND state <> 'active' AND id NOT IN (
           SELECT id FROM mini_main_claude_attempts
           WHERE session_id = ? AND provider_id = ? AND state <> 'active'
           ORDER BY updated_at DESC, id DESC
           LIMIT ?
         )`,
      )
      .run(
        sessionId,
        providerId,
        sessionId,
        providerId,
        MINI_MAIN_CLAUDE_ATTEMPT_RETENTION_LIMIT,
      ).changes;
    if (pruned > 0) {
      logger.info("mini_claude.orphan_metadata_pruned", {
        sessionId,
        providerId,
        owner: "main",
        attemptCount: pruned,
        reason: "terminal-count-bound",
      });
    }
  }

  private pruneMiniNamedClaudeAttempts(sessionId: string, providerId: string): void {
    const pruned = this.database
      .query(
        `DELETE FROM mini_named_claude_attempts
         WHERE session_id = ? AND provider_id = ? AND state <> 'active' AND id NOT IN (
           SELECT id FROM mini_named_claude_attempts
           WHERE session_id = ? AND provider_id = ? AND state <> 'active'
           ORDER BY updated_at DESC, id DESC
           LIMIT ?
         )`,
      )
      .run(
        sessionId,
        providerId,
        sessionId,
        providerId,
        MINI_NAMED_CLAUDE_ATTEMPT_RETENTION_LIMIT,
      ).changes;
    if (pruned > 0) {
      logger.info("mini_claude.orphan_metadata_pruned", {
        sessionId,
        providerId,
        owner: "named",
        attemptCount: pruned,
        reason: "terminal-count-bound",
      });
    }
  }

  private requireQuiescentHistorySession(
    sessionId: string,
    expectedCurrentStateId: string,
    allowedStatuses: readonly MiniLilacSessionSnapshot["status"][] = ["idle", "error"],
  ): MiniLilacSessionSnapshot {
    return storeResultToLegacy(
      this.requireQuiescentHistorySessionResult(sessionId, expectedCurrentStateId, allowedStatuses),
    );
  }

  private requireQuiescentHistorySessionResult(
    sessionId: string,
    expectedCurrentStateId: string,
    allowedStatuses: readonly MiniLilacSessionSnapshot["status"][] = ["idle", "error"],
  ): ResultType<MiniLilacSessionSnapshot, MiniLilacStoreOperationError> {
    const session = this.getSessionResult(sessionId);
    let $sessionResultValue319824!: import("better-result").InferOk<NonNullable<typeof session>>;
    let $sessionResultError319824!: import("better-result").InferErr<NonNullable<typeof session>>;
    const $sessionResultOk319824 = Result.match<
      import("better-result").InferOk<NonNullable<typeof session>>,
      import("better-result").InferErr<NonNullable<typeof session>>,
      boolean
    >(session, {
      ok: (value) => {
        $sessionResultValue319824 = value;
        return true;
      },
      err: (error) => {
        $sessionResultError319824 = error;
        return false;
      },
    });
    if (($sessionResultOk319824 ? "ok" : "error") === "error")
      return Result.err($sessionResultError319824);
    const activeRunCount = decodeRequiredMiniLilacStoreRow({
      kind: "count",
      row: this.database
        .query("SELECT COUNT(*) AS count FROM runs WHERE session_id = ? AND status = 'active'")
        .get(sessionId),
      schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
      recordId: `${sessionId}:active-run-count`,
    });
    let $activeRunCountResultValue319948!: import("better-result").InferOk<
      NonNullable<typeof activeRunCount>
    >;
    let $activeRunCountResultError319948!: import("better-result").InferErr<
      NonNullable<typeof activeRunCount>
    >;
    const $activeRunCountResultOk319948 = Result.match<
      import("better-result").InferOk<NonNullable<typeof activeRunCount>>,
      import("better-result").InferErr<NonNullable<typeof activeRunCount>>,
      boolean
    >(activeRunCount, {
      ok: (value) => {
        $activeRunCountResultValue319948 = value;
        return true;
      },
      err: (error) => {
        $activeRunCountResultError319948 = error;
        return false;
      },
    });
    if (($activeRunCountResultOk319948 ? "ok" : "error") === "error")
      return Result.err($activeRunCountResultError319948);
    if (
      !allowedStatuses.includes($sessionResultValue319824.status) ||
      $sessionResultValue319824.activeRunId !== null ||
      $activeRunCountResultValue319948.count !== 0
    ) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "requireQuiescentHistorySession",
          `Session '${sessionId}' must be quiescent for history navigation`,
        ),
      );
    }
    if (
      this.database
        .query("SELECT 1 FROM history_transitions WHERE session_id = ? AND to_state_id IS NULL")
        .get(sessionId)
    ) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "requireQuiescentHistorySession",
          `Session '${sessionId}' has an open history transition`,
        ),
      );
    }
    const current = this.getCurrentHistoryStateResult(sessionId);
    let $currentResultValue321101!: import("better-result").InferOk<NonNullable<typeof current>>;
    let $currentResultError321101!: import("better-result").InferErr<NonNullable<typeof current>>;
    const $currentResultOk321101 = Result.match<
      import("better-result").InferOk<NonNullable<typeof current>>,
      import("better-result").InferErr<NonNullable<typeof current>>,
      boolean
    >(current, {
      ok: (value) => {
        $currentResultValue321101 = value;
        return true;
      },
      err: (error) => {
        $currentResultError321101 = error;
        return false;
      },
    });
    if (($currentResultOk321101 ? "ok" : "error") === "error")
      return Result.err($currentResultError321101);
    if ($currentResultValue321101.id !== expectedCurrentStateId) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "requireQuiescentHistorySession",
          `Session '${sessionId}' history cursor changed before commit`,
        ),
      );
    }
    const heads = this.getTranscriptHeads(sessionId);
    const equalHeads = this.assertHeadsEqualStateResult(
      sessionId,
      {
        modelHeadId: heads.model_head_id,
        uiHeadId: heads.ui_head_id,
      },
      $currentResultValue321101,
    );
    const headsError = equalHeads.match({ ok: () => null, err: (error) => error });
    if (headsError !== null) return Result.err(headsError);
    return Result.ok($sessionResultValue319824);
  }

  private assertWorkspaceHasNoHistoryJournal(workspaceId: string): void {
    storeResultToLegacy(this.assertWorkspaceHasNoHistoryJournalResult(workspaceId));
  }

  private assertWorkspaceHasNoHistoryJournalResult(
    workspaceId: string,
  ): ResultType<void, MiniLilacStoreOperationError> {
    return this.assertWorkspaceHistoryAvailableForOwnerResult(workspaceId, null, undefined);
  }

  private assertWorkspaceHistoryAvailableForOwner(
    workspaceId: string,
    sessionId: string | null,
    owner: WorkspaceHistoryAvailabilityOwner | undefined,
  ): void {
    storeResultToLegacy(
      this.assertWorkspaceHistoryAvailableForOwnerResult(workspaceId, sessionId, owner),
    );
  }

  private assertWorkspaceHistoryAvailableForOwnerResult(
    workspaceId: string,
    sessionId: string | null,
    owner: WorkspaceHistoryAvailabilityOwner | undefined,
  ): ResultType<void, MiniLilacStoreOperationError> {
    const decodedWorkspace = this.decodeRequiredStructuralHistoryRow({
      kind: "workspace",
      row: this.database.query("SELECT * FROM workspaces WHERE id = ?").get(workspaceId),
      recordId: workspaceId,
    });
    let $decodedWorkspaceResultValue322787!: import("better-result").InferOk<
      NonNullable<typeof decodedWorkspace>
    >;
    let $decodedWorkspaceResultError322787!: import("better-result").InferErr<
      NonNullable<typeof decodedWorkspace>
    >;
    const $decodedWorkspaceResultOk322787 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decodedWorkspace>>,
      import("better-result").InferErr<NonNullable<typeof decodedWorkspace>>,
      boolean
    >(decodedWorkspace, {
      ok: (value) => {
        $decodedWorkspaceResultValue322787 = value;
        return true;
      },
      err: (error) => {
        $decodedWorkspaceResultError322787 = error;
        return false;
      },
    });
    if (($decodedWorkspaceResultOk322787 ? "ok" : "error") === "error")
      return Result.err($decodedWorkspaceResultError322787);
    if ($decodedWorkspaceResultValue322787.healthStatus !== "healthy") {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "assertWorkspaceHistoryAvailableForOwner",
          `Workspace '${workspaceId}' history store is corrupt`,
        ),
      );
    }
    const operations = decodeMiniLilacStoreRows({
      kind: "history-operation-owner",
      rows: this.database
        .query("SELECT id, session_id FROM history_operations WHERE workspace_id = ?")
        .all(workspaceId),
      schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
      recordId: `${workspaceId}:history-operation-owners`,
    });
    let $operationsResultValue323367!: import("better-result").InferOk<
      NonNullable<typeof operations>
    >;
    let $operationsResultError323367!: import("better-result").InferErr<
      NonNullable<typeof operations>
    >;
    const $operationsResultOk323367 = Result.match<
      import("better-result").InferOk<NonNullable<typeof operations>>,
      import("better-result").InferErr<NonNullable<typeof operations>>,
      boolean
    >(operations, {
      ok: (value) => {
        $operationsResultValue323367 = value;
        return true;
      },
      err: (error) => {
        $operationsResultError323367 = error;
        return false;
      },
    });
    if (($operationsResultOk323367 ? "ok" : "error") === "error")
      return Result.err($operationsResultError323367);
    const ownsOperations =
      owner?.kind === "history-operation" &&
      $operationsResultValue323367.value.length === 1 &&
      $operationsResultValue323367.value[0]?.id === owner.operationId &&
      $operationsResultValue323367.value[0].session_id === sessionId;
    if ($operationsResultValue323367.value.length > 0 && !ownsOperations) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "assertWorkspaceHistoryAvailableForOwner",
          `Workspace '${workspaceId}' has a retained history operation`,
        ),
      );
    }
    const finalizations = decodeMiniLilacStoreRows({
      kind: "pending-finalization-owner",
      rows: this.database
        .query("SELECT run_id, session_id FROM pending_run_finalizations WHERE workspace_id = ?")
        .all(workspaceId),
      schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
      recordId: `${workspaceId}:pending-finalization-owners`,
    });
    let $finalizationsResultValue324312!: import("better-result").InferOk<
      NonNullable<typeof finalizations>
    >;
    let $finalizationsResultError324312!: import("better-result").InferErr<
      NonNullable<typeof finalizations>
    >;
    const $finalizationsResultOk324312 = Result.match<
      import("better-result").InferOk<NonNullable<typeof finalizations>>,
      import("better-result").InferErr<NonNullable<typeof finalizations>>,
      boolean
    >(finalizations, {
      ok: (value) => {
        $finalizationsResultValue324312 = value;
        return true;
      },
      err: (error) => {
        $finalizationsResultError324312 = error;
        return false;
      },
    });
    if (($finalizationsResultOk324312 ? "ok" : "error") === "error")
      return Result.err($finalizationsResultError324312);
    const ownsFinalization =
      owner?.kind === "pending-run-finalization" &&
      $finalizationsResultValue324312.value.length === 1 &&
      $finalizationsResultValue324312.value[0]?.run_id === owner.runId &&
      $finalizationsResultValue324312.value[0].session_id === sessionId;
    if ($finalizationsResultValue324312.value.length > 0 && !ownsFinalization) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "assertWorkspaceHistoryAvailableForOwner",
          `Workspace '${workspaceId}' has a pending run finalization`,
        ),
      );
    }
    return Result.ok(undefined);
  }

  private assertHeadsEqualState(
    sessionId: string,
    heads: InternedStoredTranscriptHeads,
    state: StoredHistoryState,
  ): void {
    storeResultToLegacy(this.assertHeadsEqualStateResult(sessionId, heads, state));
  }

  private assertHeadsEqualStateResult(
    sessionId: string,
    heads: InternedStoredTranscriptHeads,
    state: StoredHistoryState,
  ): ResultType<void, MiniLilacStoreOperationRejected> {
    if (
      state.sessionId !== sessionId ||
      heads.modelHeadId !== state.modelHeadId ||
      heads.uiHeadId !== state.uiHeadId
    ) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "assertHeadsEqualState",
          `Session '${sessionId}' canonical transcript does not match its history cursor ` +
            `(model ${heads.modelHeadId}/${state.modelHeadId}, ui ${heads.uiHeadId}/${state.uiHeadId})`,
        ),
      );
    }
    return Result.ok(undefined);
  }

  private insertWorkspaceObservation(
    sessionId: string,
    source: StoredHistoryState,
    heads: InternedStoredTranscriptHeads,
    observation: StoredHistoryObservationInput,
  ): StoredHistoryState {
    return storeResultToLegacy(
      this.insertWorkspaceObservationResult(sessionId, source, heads, observation),
    );
  }

  private insertWorkspaceObservationResult(
    sessionId: string,
    source: StoredHistoryState,
    heads: InternedStoredTranscriptHeads,
    observation: StoredHistoryObservationInput,
  ): ResultType<StoredHistoryState, MiniLilacStoreOperationError> {
    const equalHeads = this.assertHeadsEqualStateResult(sessionId, heads, source);
    const headsError = equalHeads.match({ ok: () => null, err: (error) => error });
    if (headsError !== null) return Result.err(headsError);
    return this.appendHistoryTransitionResult({
      state: {
        id: observation.stateId,
        sessionId,
        workspaceId: source.workspaceId,
        modelHeadId: heads.modelHeadId,
        uiHeadId: heads.uiHeadId,
        workspaceSnapshotId: observation.workspaceSnapshotId,
        workspaceStatus: observation.workspaceStatus,
        workspaceUnavailableReason: observation.workspaceUnavailableReason,
        origin: "workspace-observation",
        providerState: source.providerState,
      },
      transition: {
        id: observation.transitionId,
        sessionId,
        fromStateId: source.id,
        kind: "workspace-observation",
      },
    }).map((appended) => appended.state);
  }

  private moveHistoryCursor(sessionId: string, state: StoredHistoryState): void {
    storeResultToLegacy(this.moveHistoryCursorResult(sessionId, state));
  }

  private moveHistoryCursorResult(
    sessionId: string,
    state: StoredHistoryState,
  ): ResultType<void, MiniLilacStoreOperationError> {
    const connected = this.assertStateConnectedToRootResult(sessionId, state.id);
    const connectionError = connected.match({ ok: () => null, err: (error) => error });
    if (connectionError !== null) return Result.err(connectionError);
    this.setTranscriptHeads(sessionId, state.modelHeadId, state.uiHeadId);
    const updated = this.database
      .query("UPDATE session_history SET current_state_id = ?, updated_at = ? WHERE session_id = ?")
      .run(state.id, new Date().toISOString(), sessionId);
    if (updated.changes !== 1) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "moveHistoryCursor",
          `Session '${sessionId}' has no history cursor`,
        ),
      );
    }
    return Result.ok(undefined);
  }

  private getStoredCommand(sessionId: string, commandId: string): z.infer<typeof commandRowSchema> {
    return storeResultToLegacy(this.getStoredCommandResult(sessionId, commandId));
  }

  private getStoredCommandResult(
    sessionId: string,
    commandId: string,
  ): ResultType<z.infer<typeof commandRowSchema>, MiniLilacPersistenceError> {
    const value = this.database
      .query(
        `SELECT kind, run_id, request_fingerprint, request_json, side_effect_started, result_json
         FROM commands WHERE session_id = ? AND command_id = ?`,
      )
      .get(sessionId, commandId);
    return decodeRequiredMiniLilacStoreRow({
      kind: "command",
      row: value,
      schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
      recordId: commandId,
    });
  }

  private getIncomingHistoryTransition(
    sessionId: string,
    stateId: string,
  ): StoredHistoryTransition | null {
    return storeResultToLegacy(this.getIncomingHistoryTransitionResult(sessionId, stateId));
  }

  private getIncomingHistoryTransitionResult(
    sessionId: string,
    stateId: string,
  ): ResultType<StoredHistoryTransition | null, MiniLilacPersistenceError> {
    const row = this.database
      .query("SELECT * FROM history_transitions WHERE session_id = ? AND to_state_id = ?")
      .get(sessionId, stateId);
    const decoded = this.decodeStructuralHistoryRow({
      kind: "transition",
      row,
      recordId: stateId,
    });
    return decoded;
  }

  private parseHistoryNavigationResult(
    action: z.infer<typeof historyOperationActionSchema>,
    result: StoredHistoryNavigationResult,
    commandId: string,
    expectedMessage: MiniLilacUserUIMessage | null,
  ): StoredHistoryNavigationResult {
    return storeResultToLegacy(
      this.validateHistoryNavigationResult(action, result, commandId, expectedMessage),
    );
  }

  private validateHistoryNavigationResult(
    action: z.infer<typeof historyOperationActionSchema>,
    result: StoredHistoryNavigationResult,
    commandId: string,
    expectedMessage: MiniLilacUserUIMessage | null,
  ): ResultType<StoredHistoryNavigationResult, MiniLilacStoreOperationError> {
    const status = result.status;
    if ((action === "undo" && status === "redone") || (action === "redo" && status === "undone")) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "parseHistoryNavigationResult",
          `History ${action} requires a '${action === "undo" ? "undone" : "redone"}' or empty result`,
        ),
      );
    }
    if (result.clientCommandId !== commandId) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "parseHistoryNavigationResult",
          `History result command ID does not match command '${commandId}'`,
        ),
      );
    }
    if (
      result.status !== "empty" &&
      (expectedMessage === null || !canonicalValuesEqual(result.message, expectedMessage))
    ) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "parseHistoryNavigationResult",
          `History ${action} result does not contain its exact user message`,
        ),
      );
    }
    return Result.ok(result);
  }

  private saveHistoryCommandResult(
    operation: StoredHistoryOperation,
    result: StoredHistoryNavigationResult | StoredHistoryCommandError,
  ): void {
    storeResultToLegacy(this.saveHistoryCommandResultResult(operation, result));
  }

  private saveHistoryCommandResultResult(
    operation: StoredHistoryOperation,
    result: StoredHistoryNavigationResult | StoredHistoryCommandError,
  ): ResultType<void, MiniLilacStoreOperationRejected> {
    const saved = this.database
      .query(
        `UPDATE commands SET result_json = ?
         WHERE session_id = ? AND command_id = ? AND kind = ? AND run_id IS NULL
           AND side_effect_started = 1 AND result_json IS NULL`,
      )
      .run(serialize(result), operation.sessionId, operation.commandId, operation.requestedAction);
    if (saved.changes !== 1) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "saveHistoryCommandResult",
          `Command '${operation.commandId}' result could not be saved atomically`,
        ),
      );
    }
    return Result.ok(undefined);
  }

  private deleteHistoryOperationRow(operationId: string): void {
    storeResultToLegacy(this.deleteHistoryOperationRowResult(operationId));
  }

  private deleteHistoryOperationRowResult(
    operationId: string,
  ): ResultType<void, MiniLilacStoreOperationRejected> {
    const deleted = this.database
      .query("DELETE FROM history_operations WHERE id = ?")
      .run(operationId);
    if (deleted.changes !== 1) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "deleteHistoryOperationRow",
          `History operation '${operationId}' was not deleted`,
        ),
      );
    }
    return Result.ok(undefined);
  }

  private deletePendingRunFinalizationRow(runId: string): void {
    storeResultToLegacy(this.deletePendingRunFinalizationRowResult(runId));
  }

  private deletePendingRunFinalizationRowResult(
    runId: string,
  ): ResultType<void, MiniLilacStoreOperationRejected> {
    const deleted = this.database
      .query("DELETE FROM pending_run_finalizations WHERE run_id = ?")
      .run(runId);
    if (deleted.changes !== 1) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "deletePendingRunFinalizationRow",
          `Pending finalization for run '${runId}' was not deleted`,
        ),
      );
    }
    return Result.ok(undefined);
  }

  getHistoryTransition(transitionId: string): StoredHistoryTransition {
    return storeResultToLegacy(this.getHistoryTransitionResult(transitionId));
  }

  getHistoryTransitionResult(
    transitionId: string,
  ): ResultType<StoredHistoryTransition, MiniLilacPersistenceError> {
    return this.runHistoryReadResult("getHistoryTransition", () =>
      this.decodeRequiredStructuralHistoryRow({
        kind: "transition",
        row: this.database
          .query("SELECT * FROM history_transitions WHERE id = ?")
          .get(transitionId),
        recordId: transitionId,
      }),
    );
  }

  private insertHistoryStateRow(input: CreateStoredHistoryState): void {
    const providerState = input.providerState ?? null;
    const hasProviderMetadataColumns = this.database
      .query(
        "SELECT 1 FROM pragma_table_info('history_states') WHERE name = 'last_provider_family'",
      )
      .get();
    if (!hasProviderMetadataColumns) {
      this.database
        .query(
          `INSERT INTO history_states
            (id, session_id, workspace_id, model_head_id, ui_head_id, workspace_snapshot_id,
             workspace_status, workspace_unavailable_reason, origin, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.sessionId,
          input.workspaceId,
          input.modelHeadId,
          input.uiHeadId,
          input.workspaceSnapshotId,
          input.workspaceStatus,
          input.workspaceUnavailableReason,
          input.origin,
          input.createdAt ?? new Date().toISOString(),
        );
      return;
    }
    this.database
      .query(
        `INSERT INTO history_states
          (id, session_id, workspace_id, model_head_id, ui_head_id, workspace_snapshot_id,
           workspace_status, workspace_unavailable_reason, origin, last_provider_family,
           contains_cross_family_turns, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sessionId,
        input.workspaceId,
        input.modelHeadId,
        input.uiHeadId,
        input.workspaceSnapshotId,
        input.workspaceStatus,
        input.workspaceUnavailableReason,
        input.origin,
        providerState?.lastFamily ?? null,
        storedProviderStateFlag(providerState),
        input.createdAt ?? new Date().toISOString(),
      );
  }

  private insertHistoryTransitionRow(input: CreateStoredHistoryTransition): void {
    storeResultToLegacy(this.insertHistoryTransitionRowResult(input));
  }

  private insertHistoryTransitionRowResult(
    input: CreateStoredHistoryTransition,
  ): ResultType<void, MiniLilacStoreOperationError> {
    const from = this.getHistoryStateResult(input.fromStateId);
    let $fromResultValue337007!: import("better-result").InferOk<NonNullable<typeof from>>;
    let $fromResultError337007!: import("better-result").InferErr<NonNullable<typeof from>>;
    const $fromResultOk337007 = Result.match<
      import("better-result").InferOk<NonNullable<typeof from>>,
      import("better-result").InferErr<NonNullable<typeof from>>,
      boolean
    >(from, {
      ok: (value) => {
        $fromResultValue337007 = value;
        return true;
      },
      err: (error) => {
        $fromResultError337007 = error;
        return false;
      },
    });
    if (($fromResultOk337007 ? "ok" : "error") === "error")
      return Result.err($fromResultError337007);
    if ($fromResultValue337007.sessionId !== input.sessionId) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "insertHistoryTransitionRow",
          `History transition '${input.id}' crosses sessions`,
        ),
      );
    }
    const connected = this.assertStateConnectedToRootResult(input.sessionId, input.fromStateId);
    const connectionError = connected.match({ ok: () => null, err: (error) => error });
    if (connectionError !== null) return Result.err(connectionError);
    if (
      this.database
        .query("SELECT 1 FROM history_transitions WHERE session_id = ? AND to_state_id IS NULL")
        .get(input.sessionId)
    ) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "insertHistoryTransitionRow",
          `Session '${input.sessionId}' already has an open history transition`,
        ),
      );
    }
    const toStateId = input.toStateId ?? null;
    if (toStateId === null) {
      const history = this.getSessionHistoryResult(input.sessionId);
      let $historyResultValue338005!: import("better-result").InferOk<NonNullable<typeof history>>;
      let $historyResultError338005!: import("better-result").InferErr<NonNullable<typeof history>>;
      const $historyResultOk338005 = Result.match<
        import("better-result").InferOk<NonNullable<typeof history>>,
        import("better-result").InferErr<NonNullable<typeof history>>,
        boolean
      >(history, {
        ok: (value) => {
          $historyResultValue338005 = value;
          return true;
        },
        err: (error) => {
          $historyResultError338005 = error;
          return false;
        },
      });
      if (($historyResultOk338005 ? "ok" : "error") === "error")
        return Result.err($historyResultError338005);
      if ($historyResultValue338005.currentStateId !== input.fromStateId) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "insertHistoryTransitionRow",
            `Open history transition '${input.id}' must start at the current state`,
          ),
        );
      }
    }
    if (toStateId !== null) {
      const validDestination = this.validateHistoryTransitionDestinationResult(
        input.sessionId,
        input.fromStateId,
        toStateId,
        input.kind,
      );
      const destinationError = validDestination.match({ ok: () => null, err: (error) => error });
      if (destinationError !== null) return Result.err(destinationError);
    }
    if (input.kind === "user-message") {
      const rootRunId = input.rootRunId;
      const rootRun = decodeRequiredMiniLilacStoreRow({
        kind: "root-run-parent",
        row: this.database
          .query("SELECT parent_run_id FROM runs WHERE id = ? AND session_id = ?")
          .get(rootRunId, input.sessionId),
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: rootRunId,
      });
      let $rootRunResultValue338831!: import("better-result").InferOk<NonNullable<typeof rootRun>>;
      let $rootRunResultError338831!: import("better-result").InferErr<NonNullable<typeof rootRun>>;
      const $rootRunResultOk338831 = Result.match<
        import("better-result").InferOk<NonNullable<typeof rootRun>>,
        import("better-result").InferErr<NonNullable<typeof rootRun>>,
        boolean
      >(rootRun, {
        ok: (value) => {
          $rootRunResultValue338831 = value;
          return true;
        },
        err: (error) => {
          $rootRunResultError338831 = error;
          return false;
        },
      });
      if (($rootRunResultOk338831 ? "ok" : "error") === "error")
        return Result.err($rootRunResultError338831);
      if ($rootRunResultValue338831.parent_run_id !== null) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "insertHistoryTransitionRow",
            `History transition '${input.id}' must reference a root run`,
          ),
        );
      }
      const command = this.getStoredCommandResult(input.sessionId, input.commandId);
      let $commandResultValue339510!: import("better-result").InferOk<NonNullable<typeof command>>;
      let $commandResultError339510!: import("better-result").InferErr<NonNullable<typeof command>>;
      const $commandResultOk339510 = Result.match<
        import("better-result").InferOk<NonNullable<typeof command>>,
        import("better-result").InferErr<NonNullable<typeof command>>,
        boolean
      >(command, {
        ok: (value) => {
          $commandResultValue339510 = value;
          return true;
        },
        err: (error) => {
          $commandResultError339510 = error;
          return false;
        },
      });
      if (($commandResultOk339510 ? "ok" : "error") === "error")
        return Result.err($commandResultError339510);
      if (
        $commandResultValue339510.kind !== input.delivery ||
        $commandResultValue339510.run_id !== rootRunId ||
        $commandResultValue339510.side_effect_started !== 1 ||
        $commandResultValue339510.result_json === null
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "insertHistoryTransitionRow",
            `${input.delivery === "prompt" ? "Prompt" : "Steering"} command '${input.commandId}' is not bound to root run '${rootRunId}'`,
          ),
        );
      }
    }
    const completedAt = toStateId === null ? null : (input.completedAt ?? new Date().toISOString());
    const delivery = input.kind === "user-message" ? input.delivery : null;
    const commandId = input.kind === "user-message" ? input.commandId : null;
    const userMessageJson = input.kind === "user-message" ? serialize(input.userMessage) : null;
    const rootRunId = input.kind === "user-message" ? input.rootRunId : null;
    const replayAfterSeq = input.kind === "user-message" ? input.replayAfterSeq : null;
    this.database
      .query(
        `INSERT INTO history_transitions
          (id, session_id, from_state_id, to_state_id, kind, delivery, command_id,
           user_message_json, root_run_id, replay_after_seq, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sessionId,
        input.fromStateId,
        toStateId,
        input.kind,
        delivery,
        commandId,
        userMessageJson,
        rootRunId,
        replayAfterSeq,
        input.createdAt ?? new Date().toISOString(),
        completedAt,
      );
    return Result.ok(undefined);
  }

  private validateHistoryTransitionDestination(
    sessionId: string,
    fromStateId: string,
    toStateId: string,
    kind: z.infer<typeof historyTransitionKindSchema>,
  ): void {
    storeResultToLegacy(
      this.validateHistoryTransitionDestinationResult(sessionId, fromStateId, toStateId, kind),
    );
  }

  private validateHistoryTransitionDestinationResult(
    sessionId: string,
    fromStateId: string,
    toStateId: string,
    kind: z.infer<typeof historyTransitionKindSchema>,
  ): ResultType<void, MiniLilacStoreOperationError> {
    const destination = this.getHistoryStateResult(toStateId);
    let $destinationResultValue341886!: import("better-result").InferOk<
      NonNullable<typeof destination>
    >;
    let $destinationResultError341886!: import("better-result").InferErr<
      NonNullable<typeof destination>
    >;
    const $destinationResultOk341886 = Result.match<
      import("better-result").InferOk<NonNullable<typeof destination>>,
      import("better-result").InferErr<NonNullable<typeof destination>>,
      boolean
    >(destination, {
      ok: (value) => {
        $destinationResultValue341886 = value;
        return true;
      },
      err: (error) => {
        $destinationResultError341886 = error;
        return false;
      },
    });
    if (($destinationResultOk341886 ? "ok" : "error") === "error")
      return Result.err($destinationResultError341886);
    if ($destinationResultValue341886.sessionId !== sessionId) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "validateHistoryTransitionDestination",
          `History transition from '${fromStateId}' crosses sessions`,
        ),
      );
    }
    const expectedOrigin = {
      "user-message": "turn-boundary",
      "workspace-observation": "workspace-observation",
      compaction: "compaction",
    } as const;
    if ($destinationResultValue341886.origin !== expectedOrigin[kind]) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "validateHistoryTransitionDestination",
          `History transition kind '${kind}' requires destination origin '${expectedOrigin[kind]}'`,
        ),
      );
    }
    if (
      this.database.query("SELECT 1 FROM history_transitions WHERE to_state_id = ?").get(toStateId)
    ) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "validateHistoryTransitionDestination",
          `History state '${toStateId}' already has an incoming transition`,
        ),
      );
    }
    const cycle = this.database
      .query(
        `WITH RECURSIVE ancestry(state_id) AS (
           SELECT ?
           UNION ALL
           SELECT transition.from_state_id
           FROM ancestry
           JOIN history_transitions AS transition
             ON transition.session_id = ? AND transition.to_state_id = ancestry.state_id
         )
         SELECT 1 FROM ancestry WHERE state_id = ? LIMIT 1`,
      )
      .get(fromStateId, sessionId, toStateId);
    if (cycle) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "validateHistoryTransitionDestination",
          `History transition to '${toStateId}' would create a cycle`,
        ),
      );
    }
    return Result.ok(undefined);
  }

  private assertStateConnectedToRoot(sessionId: string, stateId: string): void {
    storeResultToLegacy(this.assertStateConnectedToRootResult(sessionId, stateId));
  }

  private assertStateConnectedToRootResult(
    sessionId: string,
    stateId: string,
  ): ResultType<void, MiniLilacStoreOperationRejected> {
    const row = this.database
      .query(
        `WITH RECURSIVE ancestry(state_id) AS (
           SELECT ?
           UNION ALL
           SELECT transition.from_state_id
           FROM ancestry
           JOIN history_transitions AS transition
             ON transition.session_id = ? AND transition.to_state_id = ancestry.state_id
         )
         SELECT 1
         FROM ancestry
         JOIN session_history AS history
           ON history.session_id = ? AND history.root_state_id = ancestry.state_id
         LIMIT 1`,
      )
      .get(stateId, sessionId, sessionId);
    if (!row) {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "assertStateConnectedToRoot",
          `History state '${stateId}' is not connected to session '${sessionId}' root`,
        ),
      );
    }
    return Result.ok(undefined);
  }

  private isStateInAncestry(sessionId: string, startStateId: string, stateId: string): boolean {
    const row = this.database
      .query(
        `WITH RECURSIVE ancestry(state_id) AS (
             SELECT ?
             UNION ALL
             SELECT transition.from_state_id
             FROM ancestry
             JOIN history_transitions AS transition
               ON transition.session_id = ? AND transition.to_state_id = ancestry.state_id
           )
         SELECT 1 FROM ancestry WHERE state_id = ? LIMIT 1`,
      )
      .get(startStateId, sessionId, stateId);
    return row !== null;
  }

  getModelMessages(sessionId: string): ModelMessage[] {
    return storeResultToLegacy(this.getModelMessagesResult(sessionId));
  }

  getModelMessagesResult(sessionId: string): ResultType<ModelMessage[], MiniLilacPersistenceError> {
    const transcript = this.getModelTranscriptResult(sessionId);
    let $transcriptResultValue345848!: import("better-result").InferOk<
      NonNullable<typeof transcript>
    >;
    let $transcriptResultError345848!: import("better-result").InferErr<
      NonNullable<typeof transcript>
    >;
    const $transcriptResultOk345848 = Result.match<
      import("better-result").InferOk<NonNullable<typeof transcript>>,
      import("better-result").InferErr<NonNullable<typeof transcript>>,
      boolean
    >(transcript, {
      ok: (value) => {
        $transcriptResultValue345848 = value;
        return true;
      },
      err: (error) => {
        $transcriptResultError345848 = error;
        return false;
      },
    });
    if (($transcriptResultOk345848 ? "ok" : "error") === "error")
      return Result.err($transcriptResultError345848);
    return Result.ok($transcriptResultValue345848.value);
  }

  getModelTranscriptResult(
    sessionId: string,
  ): ResultType<DecodedPersistedValue<ModelMessage[]>, MiniLilacPersistenceError> {
    return this.runHistoryReadResult("getModelMessages", () => {
      const rawValues = this.readSerializedChainResult(
        sessionId,
        "model",
        this.getTranscriptHeads(sessionId).model_head_id,
      );
      let $rawValuesResultValue346242!: import("better-result").InferOk<
        NonNullable<typeof rawValues>
      >;
      let $rawValuesResultError346242!: import("better-result").InferErr<
        NonNullable<typeof rawValues>
      >;
      const $rawValuesResultOk346242 = Result.match<
        import("better-result").InferOk<NonNullable<typeof rawValues>>,
        import("better-result").InferErr<NonNullable<typeof rawValues>>,
        boolean
      >(rawValues, {
        ok: (value) => {
          $rawValuesResultValue346242 = value;
          return true;
        },
        err: (error) => {
          $rawValuesResultError346242 = error;
          return false;
        },
      });
      if (($rawValuesResultOk346242 ? "ok" : "error") === "error") {
        this.queuePersistenceDiagnostic($rawValuesResultError346242);
        return Result.err($rawValuesResultError346242);
      }
      const decoded = decodeMiniLilacModelTranscript({
        rawValues: $rawValuesResultValue346242,
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: sessionId,
      });
      let $decodedResultValue346553!: import("better-result").InferOk<NonNullable<typeof decoded>>;
      let $decodedResultError346553!: import("better-result").InferErr<NonNullable<typeof decoded>>;
      const $decodedResultOk346553 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decoded>>,
        import("better-result").InferErr<NonNullable<typeof decoded>>,
        boolean
      >(decoded, {
        ok: (value) => {
          $decodedResultValue346553 = value;
          return true;
        },
        err: (error) => {
          $decodedResultError346553 = error;
          return false;
        },
      });
      if (($decodedResultOk346553 ? "ok" : "error") === "error") {
        this.queuePersistenceDiagnostic($decodedResultError346553);
        return Result.err($decodedResultError346553);
      }
      return Result.ok($decodedResultValue346553);
    });
  }

  getUiMessages(sessionId: string): MiniLilacUIMessage[] {
    return storeResultToLegacy(this.getUiMessagesResult(sessionId));
  }

  getUiMessagesResult(
    sessionId: string,
  ): ResultType<MiniLilacUIMessage[], MiniLilacPersistenceError> {
    const transcript = this.getUiTranscriptResult(sessionId);
    let $transcriptResultValue347184!: import("better-result").InferOk<
      NonNullable<typeof transcript>
    >;
    let $transcriptResultError347184!: import("better-result").InferErr<
      NonNullable<typeof transcript>
    >;
    const $transcriptResultOk347184 = Result.match<
      import("better-result").InferOk<NonNullable<typeof transcript>>,
      import("better-result").InferErr<NonNullable<typeof transcript>>,
      boolean
    >(transcript, {
      ok: (value) => {
        $transcriptResultValue347184 = value;
        return true;
      },
      err: (error) => {
        $transcriptResultError347184 = error;
        return false;
      },
    });
    if (($transcriptResultOk347184 ? "ok" : "error") === "error")
      return Result.err($transcriptResultError347184);
    return Result.ok($transcriptResultValue347184.value);
  }

  getUiTranscriptResult(
    sessionId: string,
  ): ResultType<DecodedPersistedValue<MiniLilacUIMessage[]>, MiniLilacPersistenceError> {
    return this.runHistoryReadResult("getUiMessages", () => {
      const rawValues = this.readSerializedChainResult(
        sessionId,
        "ui",
        this.getTranscriptHeads(sessionId).ui_head_id,
      );
      let $rawValuesResultValue347575!: import("better-result").InferOk<
        NonNullable<typeof rawValues>
      >;
      let $rawValuesResultError347575!: import("better-result").InferErr<
        NonNullable<typeof rawValues>
      >;
      const $rawValuesResultOk347575 = Result.match<
        import("better-result").InferOk<NonNullable<typeof rawValues>>,
        import("better-result").InferErr<NonNullable<typeof rawValues>>,
        boolean
      >(rawValues, {
        ok: (value) => {
          $rawValuesResultValue347575 = value;
          return true;
        },
        err: (error) => {
          $rawValuesResultError347575 = error;
          return false;
        },
      });
      if (($rawValuesResultOk347575 ? "ok" : "error") === "error") {
        this.queuePersistenceDiagnostic($rawValuesResultError347575);
        return Result.err($rawValuesResultError347575);
      }
      const decoded = decodeMiniLilacUiTranscript({
        rawValues: $rawValuesResultValue347575,
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: sessionId,
      });
      let $decodedResultValue347880!: import("better-result").InferOk<NonNullable<typeof decoded>>;
      let $decodedResultError347880!: import("better-result").InferErr<NonNullable<typeof decoded>>;
      const $decodedResultOk347880 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decoded>>,
        import("better-result").InferErr<NonNullable<typeof decoded>>,
        boolean
      >(decoded, {
        ok: (value) => {
          $decodedResultValue347880 = value;
          return true;
        },
        err: (error) => {
          $decodedResultError347880 = error;
          return false;
        },
      });
      if (($decodedResultOk347880 ? "ok" : "error") === "error") {
        this.queuePersistenceDiagnostic($decodedResultError347880);
        return Result.err($decodedResultError347880);
      }
      return Result.ok($decodedResultValue347880);
    });
  }

  getSessionResume(sessionId: string): StoredSessionResume {
    return {
      snapshot: this.getSession(sessionId),
      messages: this.getUiMessages(sessionId),
      replayCursor: null,
    };
  }

  private internChain(
    sessionId: string,
    lane: "model" | "ui",
    values: readonly unknown[],
    compareEquivalent = true,
  ): number | null {
    return this.internSerializedChain(sessionId, lane, values.map(serialize), compareEquivalent);
  }

  private internSerializedChain(
    sessionId: string,
    lane: "model" | "ui",
    values: readonly string[],
    compareEquivalent = true,
  ): number | null {
    let parentId: number | null = null;
    let parentDepth = 0;
    let parentHash = "root";
    for (const valueJson of values) {
      const equivalent: z.infer<typeof transcriptNodeRowSchema> | undefined = compareEquivalent
        ? storeResultToLegacy(
            decodeMiniLilacStoreRows({
              kind: "transcript-node",
              rows: this.database
                .query(
                  `SELECT id, parent_id, depth, value_json, hash FROM transcript_nodes
                   WHERE session_id = ? AND lane = ? AND parent_id IS ?`,
                )
                .all(sessionId, lane, parentId),
              schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
              recordId: `${sessionId}:${lane}:children`,
            }),
          ).value.find((value) => {
            const stored = this.decodeTranscriptNodeValue(
              lane,
              value.value_json,
              `${sessionId}:${value.id}`,
            );
            const candidate = this.decodeTranscriptNodeValue(
              lane,
              valueJson,
              `${sessionId}:candidate`,
            );
            return canonicalValuesEqual(stored, candidate);
          })
        : undefined;
      if (equivalent !== undefined) {
        parentId = equivalent.id;
        parentDepth = equivalent.depth;
        parentHash = equivalent.hash;
        continue;
      }
      const hash: string = new Bun.CryptoHasher("sha256")
        .update(parentHash)
        .update("\0")
        .update(valueJson)
        .digest("hex");
      const existingValue = this.database
        .query(
          `SELECT id, parent_id, depth, value_json, hash FROM transcript_nodes
           WHERE session_id = ? AND lane = ? AND hash = ?`,
        )
        .get(sessionId, lane, hash);
      if (existingValue) {
        const existing = storeResultToLegacy(
          decodeRequiredMiniLilacStoreRow({
            kind: "transcript-node",
            row: existingValue,
            schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
            recordId: `${sessionId}:${lane}:${hash}`,
          }),
        );
        if (
          existing.parent_id !== parentId ||
          existing.depth !== parentDepth + 1 ||
          existing.value_json !== valueJson
        ) {
          throw new Error(`Transcript hash collision for session '${sessionId}' lane '${lane}'`);
        }
        parentId = existing.id;
        parentDepth = existing.depth;
        parentHash = existing.hash;
        continue;
      }
      const inserted: MiniLilacStoreRowValueByKind["transcript-node-id"] = storeResultToLegacy(
        decodeRequiredMiniLilacStoreRow({
          kind: "transcript-node-id",
          row: this.database
            .query(
              `INSERT INTO transcript_nodes
                (session_id, lane, parent_id, depth, value_json, hash)
               VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
            )
            .get(sessionId, lane, parentId, parentDepth + 1, valueJson, hash),
          schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
          recordId: `${sessionId}:${lane}:${hash}`,
        }),
      );
      parentId = inserted.id;
      parentDepth += 1;
      parentHash = hash;
    }
    return parentId;
  }

  private decodeTranscriptNodeValue(
    lane: "model" | "ui",
    raw: string,
    recordId: string,
  ): ModelMessage | MiniLilacUIMessage {
    if (lane === "model") {
      const decoded = decodeMiniLilacModelTranscript({
        rawValues: [raw],
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId,
      });
      let $decodedResultValue352324!: import("better-result").InferOk<NonNullable<typeof decoded>>;
      let $decodedResultError352324!: import("better-result").InferErr<NonNullable<typeof decoded>>;
      const $decodedResultOk352324 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decoded>>,
        import("better-result").InferErr<NonNullable<typeof decoded>>,
        boolean
      >(decoded, {
        ok: (value) => {
          $decodedResultValue352324 = value;
          return true;
        },
        err: (error) => {
          $decodedResultError352324 = error;
          return false;
        },
      });
      if (($decodedResultOk352324 ? "ok" : "error") === "error") throw $decodedResultError352324;
      const messages = $decodedResultValue352324.value;
      const message = messages[0];
      if (message === undefined) throw new Error("Decoded model transcript node was empty");
      return message;
    }
    const decoded = decodeMiniLilacUiTranscript({
      rawValues: [raw],
      schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
      recordId,
    });
    let $decodedResultValue352749!: import("better-result").InferOk<NonNullable<typeof decoded>>;
    let $decodedResultError352749!: import("better-result").InferErr<NonNullable<typeof decoded>>;
    const $decodedResultOk352749 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decoded>>,
      import("better-result").InferErr<NonNullable<typeof decoded>>,
      boolean
    >(decoded, {
      ok: (value) => {
        $decodedResultValue352749 = value;
        return true;
      },
      err: (error) => {
        $decodedResultError352749 = error;
        return false;
      },
    });
    if (($decodedResultOk352749 ? "ok" : "error") === "error") throw $decodedResultError352749;
    const messages = $decodedResultValue352749.value;
    const message = messages[0];
    if (message === undefined) throw new Error("Decoded UI transcript node was empty");
    return message;
  }

  private getTranscriptHeads(sessionId: string): z.infer<typeof transcriptHeadRowSchema> {
    const value = this.database
      .query("SELECT model_head_id, ui_head_id FROM session_transcript_heads WHERE session_id = ?")
      .get(sessionId);
    const decoded = decodeMiniLilacStoreRow({
      kind: "transcript-head",
      row: value,
      schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
      recordId: sessionId,
    });
    const heads = storeResultToLegacy(decoded).value;
    return heads ?? { model_head_id: null, ui_head_id: null };
  }

  private setTranscriptHeads(
    sessionId: string,
    modelHeadId: number | null,
    uiHeadId: number | null,
  ): void {
    this.database
      .query(
        `INSERT INTO session_transcript_heads (session_id, model_head_id, ui_head_id)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           model_head_id = excluded.model_head_id,
           ui_head_id = excluded.ui_head_id`,
      )
      .run(sessionId, modelHeadId, uiHeadId);
  }

  private readSerializedChain(
    sessionId: string,
    lane: "model" | "ui",
    headId: number | null,
  ): string[] | null {
    return storeResultToLegacy(this.readSerializedChainResult(sessionId, lane, headId));
  }

  private readSerializedChainResult(
    sessionId: string,
    lane: "model" | "ui",
    headId: number | null,
  ): ResultType<string[] | null, PersistedDataError> {
    const rows =
      headId === null
        ? []
        : this.database
            .query(
              `WITH RECURSIVE chain(id, parent_id, depth, value_json, hash) AS (
                 SELECT id, parent_id, depth, value_json, hash FROM transcript_nodes
                 WHERE id = ? AND session_id = ? AND lane = ?
                 UNION ALL
                 SELECT parent.id, parent.parent_id, parent.depth, parent.value_json, parent.hash
                 FROM transcript_nodes AS parent
                 JOIN chain AS child ON child.parent_id = parent.id
                 WHERE parent.session_id = ? AND parent.lane = ?
               )
               SELECT id, parent_id AS parentId, depth, value_json AS valueJson, hash
               FROM chain ORDER BY depth`,
            )
            .all(headId, sessionId, lane, sessionId, lane);
    const decoded = decodeMiniLilacTranscriptChain({
      headId,
      lane,
      rows,
      schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
      recordId: sessionId,
    });
    let $decodedResultValue355420!: import("better-result").InferOk<NonNullable<typeof decoded>>;
    let $decodedResultError355420!: import("better-result").InferErr<NonNullable<typeof decoded>>;
    const $decodedResultOk355420 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decoded>>,
      import("better-result").InferErr<NonNullable<typeof decoded>>,
      boolean
    >(decoded, {
      ok: (value) => {
        $decodedResultValue355420 = value;
        return true;
      },
      err: (error) => {
        $decodedResultError355420 = error;
        return false;
      },
    });
    if (($decodedResultOk355420 ? "ok" : "error") === "error")
      return Result.err($decodedResultError355420);
    return Result.ok(headId === null ? null : $decodedResultValue355420.value);
  }

  getCommandResult(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
  ): unknown | undefined {
    return storeResultToLegacy(this.getCommandResultResult(sessionId, commandId, request));
  }

  getCommandResultResult(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
  ): ResultType<unknown | undefined, MiniLilacStoreOperationError> {
    const command = decodeCanonicalStoredCommandRequest(request);
    let $commandResultValue356147!: import("better-result").InferOk<NonNullable<typeof command>>;
    let $commandResultError356147!: import("better-result").InferErr<NonNullable<typeof command>>;
    const $commandResultOk356147 = Result.match<
      import("better-result").InferOk<NonNullable<typeof command>>,
      import("better-result").InferErr<NonNullable<typeof command>>,
      boolean
    >(command, {
      ok: (value) => {
        $commandResultValue356147 = value;
        return true;
      },
      err: (error) => {
        $commandResultError356147 = error;
        return false;
      },
    });
    if (($commandResultOk356147 ? "ok" : "error") === "error")
      return Result.err($commandResultError356147);
    return this.runHistoryReadResult("getCommandResult", () => {
      const value = this.database
        .query(
          `SELECT kind, run_id, request_fingerprint, request_json, side_effect_started, result_json
           FROM commands WHERE session_id = ? AND command_id = ?`,
        )
        .get(sessionId, commandId);
      if (!value) return Result.ok(undefined);
      const decodedRow = decodeRequiredMiniLilacStoreRow({
        kind: "command",
        row: value,
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: commandId,
      });
      let $decodedRowResultValue356660!: import("better-result").InferOk<
        NonNullable<typeof decodedRow>
      >;
      let $decodedRowResultError356660!: import("better-result").InferErr<
        NonNullable<typeof decodedRow>
      >;
      const $decodedRowResultOk356660 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decodedRow>>,
        import("better-result").InferErr<NonNullable<typeof decodedRow>>,
        boolean
      >(decodedRow, {
        ok: (value) => {
          $decodedRowResultValue356660 = value;
          return true;
        },
        err: (error) => {
          $decodedRowResultError356660 = error;
          return false;
        },
      });
      if (($decodedRowResultOk356660 ? "ok" : "error") === "error") {
        if ($decodedRowResultError356660._tag !== "MiniLilacHistoryRecordMissing") {
          this.queuePersistenceDiagnostic($decodedRowResultError356660);
        }
        return Result.err($decodedRowResultError356660);
      }
      const row = $decodedRowResultValue356660;
      if (row.kind !== $commandResultValue356147.kind) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "getCommandResult",
            message: `Command '${commandId}' was already used for '${row.kind}'`,
          }),
        );
      }
      if (
        $commandResultValue356147.runId !== null &&
        row.run_id !== $commandResultValue356147.runId
      ) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "getCommandResult",
            message: `Command '${commandId}' was already used for a different run`,
          }),
        );
      }
      if (
        row.request_fingerprint !== $commandResultValue356147.fingerprint ||
        row.request_json !== $commandResultValue356147.json
      ) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "getCommandResult",
            message: `Command '${commandId}' was already used with a different payload`,
          }),
        );
      }
      if (row.result_json === null) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "getCommandResult",
            message: `Command '${commandId}' is pending`,
          }),
        );
      }
      const decoded = decodeMiniLilacSuperJsonPayload({
        raw: row.result_json,
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: commandId,
        field: "command_result",
      });
      let $decodedResultValue358352!: import("better-result").InferOk<NonNullable<typeof decoded>>;
      let $decodedResultError358352!: import("better-result").InferErr<NonNullable<typeof decoded>>;
      const $decodedResultOk358352 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decoded>>,
        import("better-result").InferErr<NonNullable<typeof decoded>>,
        boolean
      >(decoded, {
        ok: (value) => {
          $decodedResultValue358352 = value;
          return true;
        },
        err: (error) => {
          $decodedResultError358352 = error;
          return false;
        },
      });
      if (($decodedResultOk358352 ? "ok" : "error") === "error") {
        this.queuePersistenceDiagnostic($decodedResultError358352);
        return Result.err($decodedResultError358352);
      }
      return Result.ok($decodedResultValue358352.value);
    });
  }

  reserveCommand(sessionId: string, commandId: string, request: StoredCommandRequest): void {
    storeResultToLegacy(this.reserveCommandResult(sessionId, commandId, request));
  }

  reserveCommandResult(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
  ): ResultType<void, MiniLilacStoreOperationRejected | MiniLilacSqliteDriverFailure> {
    const command = decodeCanonicalStoredCommandRequest(request);
    let $commandResultValue359146!: import("better-result").InferOk<NonNullable<typeof command>>;
    let $commandResultError359146!: import("better-result").InferErr<NonNullable<typeof command>>;
    const $commandResultOk359146 = Result.match<
      import("better-result").InferOk<NonNullable<typeof command>>,
      import("better-result").InferErr<NonNullable<typeof command>>,
      boolean
    >(command, {
      ok: (value) => {
        $commandResultValue359146 = value;
        return true;
      },
      err: (error) => {
        $commandResultError359146 = error;
        return false;
      },
    });
    if (($commandResultOk359146 ? "ok" : "error") === "error")
      return Result.err($commandResultError359146);
    return this.runHistoryReadResult("reserveCommand", () => {
      this.database
        .query(
          `INSERT INTO commands
            (session_id, command_id, kind, run_id, request_fingerprint, request_json, side_effect_started, result_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
        )
        .run(
          sessionId,
          commandId,
          $commandResultValue359146.kind,
          $commandResultValue359146.runId,
          $commandResultValue359146.fingerprint,
          $commandResultValue359146.json,
          new Date().toISOString(),
        );
      return Result.ok(undefined);
    });
  }

  releaseCommand(sessionId: string, commandId: string, request: StoredCommandRequest): void {
    storeResultToLegacy(this.releaseCommandResult(sessionId, commandId, request));
  }

  releaseCommandResult(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
  ): ResultType<void, MiniLilacStoreOperationRejected | MiniLilacSqliteDriverFailure> {
    const command = decodeCanonicalStoredCommandRequest(request);
    let $commandResultValue360260!: import("better-result").InferOk<NonNullable<typeof command>>;
    let $commandResultError360260!: import("better-result").InferErr<NonNullable<typeof command>>;
    const $commandResultOk360260 = Result.match<
      import("better-result").InferOk<NonNullable<typeof command>>,
      import("better-result").InferErr<NonNullable<typeof command>>,
      boolean
    >(command, {
      ok: (value) => {
        $commandResultValue360260 = value;
        return true;
      },
      err: (error) => {
        $commandResultError360260 = error;
        return false;
      },
    });
    if (($commandResultOk360260 ? "ok" : "error") === "error")
      return Result.err($commandResultError360260);
    return this.runHistoryReadResult("releaseCommand", () => {
      this.database
        .query(
          `DELETE FROM commands
           WHERE session_id = ? AND command_id = ? AND kind = ?
             AND run_id IS ? AND request_fingerprint = ? AND request_json = ?
             AND side_effect_started = 0 AND result_json IS NULL`,
        )
        .run(
          sessionId,
          commandId,
          $commandResultValue360260.kind,
          $commandResultValue360260.runId,
          $commandResultValue360260.fingerprint,
          $commandResultValue360260.json,
        );
      return Result.ok(undefined);
    });
  }

  markCommandSideEffectStarted(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
  ): void {
    storeResultToLegacy(this.markCommandSideEffectStartedResult(sessionId, commandId, request));
  }

  markCommandSideEffectStartedResult(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
  ): ResultType<void, MiniLilacStoreOperationRejected | MiniLilacSqliteDriverFailure> {
    const command = decodeCanonicalStoredCommandRequest(request);
    let $commandResultValue361423!: import("better-result").InferOk<NonNullable<typeof command>>;
    let $commandResultError361423!: import("better-result").InferErr<NonNullable<typeof command>>;
    const $commandResultOk361423 = Result.match<
      import("better-result").InferOk<NonNullable<typeof command>>,
      import("better-result").InferErr<NonNullable<typeof command>>,
      boolean
    >(command, {
      ok: (value) => {
        $commandResultValue361423 = value;
        return true;
      },
      err: (error) => {
        $commandResultError361423 = error;
        return false;
      },
    });
    if (($commandResultOk361423 ? "ok" : "error") === "error")
      return Result.err($commandResultError361423);
    return this.runHistoryReadResult("markCommandSideEffectStarted", () => {
      const marked = this.database
        .query(
          `UPDATE commands SET side_effect_started = 1
           WHERE session_id = ? AND command_id = ? AND kind = ?
             AND run_id IS ? AND request_fingerprint = ? AND request_json = ?
             AND side_effect_started = 0 AND result_json IS NULL`,
        )
        .run(
          sessionId,
          commandId,
          $commandResultValue361423.kind,
          $commandResultValue361423.runId,
          $commandResultValue361423.fingerprint,
          $commandResultValue361423.json,
        );
      if (marked.changes === 1) return Result.ok(undefined);
      return Result.err(
        new MiniLilacStoreOperationRejected({
          operation: "markCommandSideEffectStarted",
          message: `Command '${commandId}' could not begin its side effect`,
        }),
      );
    });
  }

  saveCommandResult(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
    result: unknown,
  ): void {
    storeResultToLegacy(this.saveCommandResultResult(sessionId, commandId, request, result));
  }

  saveCommandResultResult(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
    result: unknown,
  ): ResultType<void, MiniLilacStoreOperationRejected | MiniLilacSqliteDriverFailure> {
    const command = decodeCanonicalStoredCommandRequest(request);
    let $commandResultValue362903!: import("better-result").InferOk<NonNullable<typeof command>>;
    let $commandResultError362903!: import("better-result").InferErr<NonNullable<typeof command>>;
    const $commandResultOk362903 = Result.match<
      import("better-result").InferOk<NonNullable<typeof command>>,
      import("better-result").InferErr<NonNullable<typeof command>>,
      boolean
    >(command, {
      ok: (value) => {
        $commandResultValue362903 = value;
        return true;
      },
      err: (error) => {
        $commandResultError362903 = error;
        return false;
      },
    });
    if (($commandResultOk362903 ? "ok" : "error") === "error")
      return Result.err($commandResultError362903);
    const serializedResult = serializeStoreValueResult(result, "saveCommandResult");
    let $serializedResultResultValue363039!: import("better-result").InferOk<
      NonNullable<typeof serializedResult>
    >;
    let $serializedResultResultError363039!: import("better-result").InferErr<
      NonNullable<typeof serializedResult>
    >;
    const $serializedResultResultOk363039 = Result.match<
      import("better-result").InferOk<NonNullable<typeof serializedResult>>,
      import("better-result").InferErr<NonNullable<typeof serializedResult>>,
      boolean
    >(serializedResult, {
      ok: (value) => {
        $serializedResultResultValue363039 = value;
        return true;
      },
      err: (error) => {
        $serializedResultResultError363039 = error;
        return false;
      },
    });
    if (($serializedResultResultOk363039 ? "ok" : "error") === "error")
      return Result.err($serializedResultResultError363039);
    return this.runHistoryReadResult("saveCommandResult", () => {
      const saved = this.database
        .query(
          `UPDATE commands SET result_json = ?
           WHERE session_id = ? AND command_id = ? AND kind = ?
             AND run_id IS ? AND request_fingerprint = ? AND request_json = ?
             AND side_effect_started = 1 AND result_json IS NULL`,
        )
        .run(
          $serializedResultResultValue363039,
          sessionId,
          commandId,
          $commandResultValue362903.kind,
          $commandResultValue362903.runId,
          $commandResultValue362903.fingerprint,
          $commandResultValue362903.json,
        );
      if (saved.changes === 1) return Result.ok(undefined);
      return Result.err(
        new MiniLilacStoreOperationRejected({
          operation: "saveCommandResult",
          message: `Command '${commandId}' result could not be saved`,
        }),
      );
    });
  }
}
