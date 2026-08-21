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
import {
  Panic,
  Result,
  TaggedError,
  type Err,
  type InferErr,
  type InferOk,
  type Ok,
  type Result as ResultType,
} from "better-result";
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
  const decodedOutcome = sqliteCaptureOutcome(decoded);
  if (!decodedOutcome.ok) return Result.err(decodedOutcome.error);
  return Result.ok({
    value: adaptPersistedModelMessagesToSdk(decodedOutcome.value.value),
    provenance: decodedOutcome.value.provenance,
  });
}

function decodeMiniLilacUiTranscript(
  input: Parameters<typeof decodePersistedMiniLilacUiTranscript>[0],
) {
  const decoded = decodePersistedMiniLilacUiTranscript(input);
  const decodedOutcome = sqliteCaptureOutcome(decoded);
  if (!decodedOutcome.ok) return Result.err(decodedOutcome.error);
  return Result.ok({
    value: adaptPersistedUiMessagesToSdk(decodedOutcome.value.value),
    provenance: decodedOutcome.value.provenance,
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

type OpaqueMiniLilacSqliteValue = {} | null | undefined;

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
  | { readonly kind: "hostile"; readonly cause: OpaqueMiniLilacSqliteValue };

type AnyMiniResult = Ok<unknown, unknown> | Err<unknown, unknown>;
type MiniResultOutcome<R extends AnyMiniResult> =
  | { readonly ok: true; readonly value: InferOk<R> }
  | { readonly ok: false; readonly error: InferErr<R> };

function sqliteCaptureOutcome<R extends AnyMiniResult>(result: R): MiniResultOutcome<R>;
function sqliteCaptureOutcome<T, E>(
  result: ResultType<T, E>,
): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E } {
  return result.match<
    { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E }
  >({ ok: (value) => ({ ok: true, value }), err: (error) => ({ ok: false, error }) });
}

function captureMiniLilacCleanup(
  cleanup: () => ResultType<void, MiniLilacSqliteDriverFailure>,
): MiniLilacCleanupOutcome {
  const attempted = sqliteCaptureOutcome(
    Result.try<ResultType<void, MiniLilacSqliteDriverFailure>, OpaqueMiniLilacSqliteValue>({
      try: cleanup,
      catch: (cause) => cause,
    }),
  );
  if (attempted.ok) {
    const result = attempted.value;
    return result.match<MiniLilacCleanupOutcome>({
      ok: () => ({ status: "ok" }),
      err: (error) => ({ status: "expected-error", error }),
    });
  }
  const cause = attempted.error;
  return {
    status: "defect",
    report: (reporter, operation) =>
      reportMiniLilacCleanupFailure(reporter, { operation, cleanupFailure: cause }),
    rethrow: () => storeResultToLegacy(Result.err(cause)),
  };
}

function reportMiniLilacCleanupFailure(
  reporter: (report: MiniLilacCleanupDefectReport) => void,
  report: MiniLilacCleanupDefectReport,
): void {
  const reported = sqliteCaptureOutcome(
    Result.try<void, OpaqueMiniLilacSqliteValue>({
      try: () => reporter(report),
      catch: (cause) => cause,
    }),
  );
  if (reported.ok) return;
  Result.try<void, OpaqueMiniLilacSqliteValue>({
    try: () =>
      logger.error("Mini Lilac cleanup defect reporter failed", { operation: report.operation }),
    catch: (cause) => cause,
  });
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
    const decodedOutcome = sqliteCaptureOutcome(decoded);
    if (!decodedOutcome.ok) return Result.err(decodedOutcome.error);
    if (decodedOutcome.value.value === null) {
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
    values.push(decodedOutcome.value.value);
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
  const decodedOutcome = sqliteCaptureOutcome(decoded);
  if (!decodedOutcome.ok) return Result.err(decodedOutcome.error);
  if (decodedOutcome.value.value !== null) return Result.ok(decodedOutcome.value.value);
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
  const serialized = sqliteCaptureOutcome(
    Result.try<string, OpaqueMiniLilacSqliteValue>({
      try: () => serialize(value),
      catch: (cause) => cause,
    }),
  );
  if (serialized.ok) return Result.ok(serialized.value);
  if (Panic.is(serialized.error)) throw serialized.error;
  return Result.err(
    new MiniLilacStoreOperationRejected({
      operation,
      message: "Store value is not serializable",
    }),
  );
}

function storeResultToLegacy<T, E>(result: ResultType<T, E>): T {
  const resultOutcome = sqliteCaptureOutcome(result);
  if (!resultOutcome.ok) throw resultOutcome.error;
  return resultOutcome.value;
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
  const serializedAttempt = sqliteCaptureOutcome(
    Result.try<string | undefined, OpaqueMiniLilacSqliteValue>({
      try: () => JSON.stringify(payload),
      catch: (cause) => cause,
    }),
  );
  if (!serializedAttempt.ok) {
    if (Panic.is(serializedAttempt.error)) throw serializedAttempt.error;
    return Result.err(
      new MiniLilacStoreOperationRejected({
        operation: "canonicalCommandPayload",
        message: "Command payload is not serializable JSON",
      }),
    );
  }
  const serialized = serializedAttempt.value;
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
  const payloadOutcome = sqliteCaptureOutcome(payload);
  if (!payloadOutcome.ok) return Result.err(payloadOutcome.error);
  return Result.ok({ kind: request.kind, runId: request.runId, ...payloadOutcome.value });
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
  const canonical = sqliteCaptureOutcome(
    Result.try<string, OpaqueMiniLilacSqliteValue>({
      try: () => realpathSync.native(resolved),
      catch: (cause) => cause,
    }),
  );
  return canonical.ok ? canonical.value : resolved;
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
  const decodedOutcome = sqliteCaptureOutcome(decoded);
  if (!decodedOutcome.ok) return Result.err(decodedOutcome.error);
  return Result.ok(projectSessionRowSnapshot(decodedOutcome.value));
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
  const decodedRowOutcome = sqliteCaptureOutcome(decodedRow);
  if (!decodedRowOutcome.ok) return Result.err(decodedRowOutcome.error);
  const row = decodedRowOutcome.value;
  const terminalResult = decodeMiniLilacSuperJsonPayload({
    raw: row.terminal_result_json,
    schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
    recordId: row.id,
    field: "terminal_result",
  });
  const terminalResultOutcome = sqliteCaptureOutcome(terminalResult);
  if (!terminalResultOutcome.ok) return Result.err(terminalResultOutcome.error);
  return Result.ok({
    id: row.id,
    sessionId: row.session_id,
    parentRunId: row.parent_run_id,
    profile: row.profile,
    depth: row.depth,
    status: row.status,
    error: row.error,
    terminalResult: terminalResultOutcome.value.value ?? undefined,
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
  const decodedOutcome = sqliteCaptureOutcome(decoded);
  if (!decodedOutcome.ok) return Result.err(decodedOutcome.error);
  const row = decodedOutcome.value;
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
  const decodedOutcome = sqliteCaptureOutcome(decoded);
  if (!decodedOutcome.ok) return Result.err(decodedOutcome.error);
  const row = decodedOutcome.value;
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
  const closed = sqliteCaptureOutcome(
    Result.try<void, OpaqueMiniLilacSqliteValue>({
      try: () => database.close(),
      catch: (cause) => cause,
    }),
  );
  if (closed.ok) return Result.ok(undefined);
  if (Panic.is(closed.error)) throw closed.error;
  if (!(closed.error instanceof Error)) throw closed.error;
  const failure = classifyMiniLilacSqliteDriverFailure("readHistoryRecovery.close", closed.error);
  if (failure !== undefined) return Result.err(failure);
  throw closed.error;
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
  const opened = sqliteCaptureOutcome(
    Result.try<Database, OpaqueMiniLilacSqliteValue>({
      try: () => new Database(resolvedFilename, { readonly: true, strict: true }),
      catch: (cause) => cause,
    }),
  );
  if (!opened.ok) {
    if (Panic.is(opened.error)) throw opened.error;
    if (!(opened.error instanceof Error)) throw opened.error;
    const failure = classifyMiniLilacSqliteDriverFailure("readHistoryRecovery.open", opened.error);
    if (failure !== undefined) return Result.err(failure);
    throw opened.error;
  }
  const database = opened.value;
  const diagnostics: MiniLilacPersistenceDiagnostic[] = [];
  let outcome:
    | ResultType<ReadonlyStoredHistoryRecoveryStatus, MiniLilacHistoryRecoveryReadError>
    | undefined;
  let readDefect: MiniLilacCaughtDefect | undefined;
  const readAttempt = sqliteCaptureOutcome(
    Result.try<void, OpaqueMiniLilacSqliteValue>({
      try: () => {
        const decodedVersion = decodeMiniLilacDatabaseVersion(
          database.query("PRAGMA user_version").get(),
        );
        const decodedVersionOutcome = sqliteCaptureOutcome(decodedVersion);
        if (!decodedVersionOutcome.ok) {
          diagnostics.push({
            table: decodedVersionOutcome.error.table,
            field: decodedVersionOutcome.error.field,
            version: decodedVersionOutcome.error.version,
            issueCode: decodedVersionOutcome.error.issueCode,
            recordId: decodedVersionOutcome.error.recordId,
            message: decodedVersionOutcome.error.message,
          });
          outcome = Result.err(decodedVersionOutcome.error);
        } else if (decodedVersionOutcome.value !== MINI_LILAC_DATABASE_SCHEMA_VERSION) {
          outcome = Result.err(
            new MiniLilacHistoryRecoveryVersionError(decodedVersionOutcome.value),
          );
        } else {
          const navigation: Array<{
            readonly canonicalCwd: string;
            readonly operation: StoredHistoryOperation;
          }> = [];
          const operations = decodeMiniLilacStructuralHistoryRows({
            kind: "operation",
            rows: database
              .query("SELECT * FROM history_operations ORDER BY prepared_at, rowid")
              .all(),
            schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
            recordId: "recovery-operation",
          });
          const operationsOutcome = sqliteCaptureOutcome(operations);
          if (!operationsOutcome.ok) {
            diagnostics.push({
              table: operationsOutcome.error.table,
              field: operationsOutcome.error.field,
              version: operationsOutcome.error.version,
              issueCode: operationsOutcome.error.issueCode,
              recordId: operationsOutcome.error.recordId,
              message: operationsOutcome.error.message,
            });
            outcome = Result.err(operationsOutcome.error);
          } else {
            for (const operation of operationsOutcome.value.value) {
              const workspace = decodeMiniLilacStructuralHistoryRow({
                kind: "workspace",
                row: database
                  .query("SELECT * FROM workspaces WHERE id = ?")
                  .get(operation.workspaceId),
                schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
                recordId: operation.workspaceId,
              });
              const workspaceOutcome = sqliteCaptureOutcome(workspace);
              if (!workspaceOutcome.ok) {
                diagnostics.push({
                  table: workspaceOutcome.error.table,
                  field: workspaceOutcome.error.field,
                  version: workspaceOutcome.error.version,
                  issueCode: workspaceOutcome.error.issueCode,
                  recordId: workspaceOutcome.error.recordId,
                  message: workspaceOutcome.error.message,
                });
                outcome = Result.err(workspaceOutcome.error);
                break;
              }
              if (workspaceOutcome.value.value?.kind !== "workspace") {
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
                canonicalCwd: workspaceOutcome.value.value.value.canonicalCwd,
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
            const finalizationsOutcome = sqliteCaptureOutcome(finalizations);
            if (!finalizationsOutcome.ok) {
              diagnostics.push({
                table: finalizationsOutcome.error.table,
                field: finalizationsOutcome.error.field,
                version: finalizationsOutcome.error.version,
                issueCode: finalizationsOutcome.error.issueCode,
                recordId: finalizationsOutcome.error.recordId,
                message: finalizationsOutcome.error.message,
              });
              outcome = Result.err(finalizationsOutcome.error);
            } else {
              for (const finalization of finalizationsOutcome.value.value) {
                const workspace = decodeMiniLilacStructuralHistoryRow({
                  kind: "workspace",
                  row: database
                    .query("SELECT * FROM workspaces WHERE id = ?")
                    .get(finalization.workspaceId),
                  schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
                  recordId: finalization.workspaceId,
                });
                const workspaceOutcome = sqliteCaptureOutcome(workspace);
                if (!workspaceOutcome.ok) {
                  diagnostics.push({
                    table: workspaceOutcome.error.table,
                    field: workspaceOutcome.error.field,
                    version: workspaceOutcome.error.version,
                    issueCode: workspaceOutcome.error.issueCode,
                    recordId: workspaceOutcome.error.recordId,
                    message: workspaceOutcome.error.message,
                  });
                  outcome = Result.err(workspaceOutcome.error);
                  break;
                }
                if (workspaceOutcome.value.value?.kind !== "workspace") {
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
                  canonicalCwd: workspaceOutcome.value.value.value.canonicalCwd,
                  finalization,
                });
              }
            }
            if (outcome === undefined) outcome = Result.ok({ navigation, pendingFinalizations });
          }
        }
      },
      catch: (cause) => cause,
    }),
  );
  if (!readAttempt.ok) {
    const cause = readAttempt.error;
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
    const initialized = sqliteCaptureOutcome(
      Result.try<void, OpaqueMiniLilacSqliteValue>({
        try: () => {
          this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
          this.secureDatabaseFiles();
          this.initializeSchema();
        },
        catch: (cause) => cause,
      }),
    );
    if (!initialized.ok) {
      const primary = initialized.error;
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
    const closed = sqliteCaptureOutcome(
      Result.try<void, OpaqueMiniLilacSqliteValue>({
        try: () => this.database.close(),
        catch: (cause) => cause,
      }),
    );
    if (closed.ok) return Result.ok(undefined);
    if (Panic.is(closed.error)) throw closed.error;
    if (!(closed.error instanceof Error)) throw closed.error;
    const failure = classifyMiniLilacSqliteDriverFailure(
      "closeAfterInitializationFailure",
      closed.error,
    );
    if (failure !== undefined) return Result.err(failure);
    throw closed.error;
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
    const initialized = sqliteCaptureOutcome(
      Result.try<ResultType<void, MiniLilacSchemaInitializationError>, OpaqueMiniLilacSqliteValue>({
        try: () => {
          const decodedVersion = decodeMiniLilacDatabaseVersion(
            this.database.query("PRAGMA user_version").get(),
          );
          const decodedVersionOutcome = sqliteCaptureOutcome(decodedVersion);
          if (!decodedVersionOutcome.ok) return Result.err(decodedVersionOutcome.error);
          const version = decodedVersionOutcome.value;
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
          const migrationAttempt = sqliteCaptureOutcome(
            Result.try<
              ResultType<
                void,
                MiniLilacSchemaMigrationFailure | MiniLilacSqliteDriverFailure | PersistedDataError
              >,
              OpaqueMiniLilacSqliteValue
            >({
              try: () =>
                runBunSqliteTransaction(
                  this.database,
                  () => {
                    if (version === 0) {
                      this.createSchemaV6();
                    } else {
                      if (version === 2) {
                        const migration = this.migrateSchemaV2ToV3();
                        const migrationError = migration.match({
                          ok: () => null,
                          err: (error) => error,
                        });
                        if (migrationError !== null) return Result.err(migrationError);
                      }
                      if (version === 2 || version === 3) this.migrateSchemaV3ToV4();
                      if (version === 2 || version === 3 || version === 4) {
                        const migration = this.migrateSchemaV4ToV5();
                        const migrationError = migration.match({
                          ok: () => null,
                          err: (error) => error,
                        });
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
                    this.database.exec(
                      `PRAGMA user_version = ${MINI_LILAC_DATABASE_SCHEMA_VERSION};`,
                    );
                    return Result.ok(undefined);
                  },
                  (cause) => classifyMiniLilacSqliteDriverFailure("initializeSchema", cause),
                ),
              catch: (cause) => cause,
            }),
          );
          if (migrationAttempt.ok) {
            migrated = migrationAttempt.value;
          } else {
            const cause = migrationAttempt.error;
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
        },
        catch: (cause) => cause,
      }),
    );
    if (initialized.ok) return initialized.value;
    const cause = initialized.error;
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

  private restoreSchemaMigrationPragmas(): ResultType<void, MiniLilacSqliteDriverFailure> {
    const restored = sqliteCaptureOutcome(
      Result.try<void, OpaqueMiniLilacSqliteValue>({
        try: () => this.database.exec("PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;"),
        catch: (cause) => cause,
      }),
    );
    if (restored.ok) return Result.ok(undefined);
    if (Panic.is(restored.error)) throw restored.error;
    if (!(restored.error instanceof Error)) throw restored.error;
    const failure = classifyMiniLilacSqliteDriverFailure(
      "initializeSchema.cleanup",
      restored.error,
    );
    if (failure !== undefined) return Result.err(failure);
    throw restored.error;
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
    const decodedSessionsOutcome = sqliteCaptureOutcome(decodedSessions);
    if (!decodedSessionsOutcome.ok) return Result.err(decodedSessionsOutcome.error);
    const sessions = decodedSessionsOutcome.value.value;
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
    const decodedWorkspaceMismatchCountOutcome = sqliteCaptureOutcome(
      decodedWorkspaceMismatchCount,
    );
    if (!decodedWorkspaceMismatchCountOutcome.ok) {
      if (decodedWorkspaceMismatchCountOutcome.error._tag === "MiniLilacHistoryRecordMissing") {
        return Result.err(
          new MiniLilacSchemaMigrationFailure({
            operation: "migrateSchemaV4ToV5",
            message: "Mini Lilac v4 migration workspace mismatch count was not returned",
          }),
        );
      }
      return Result.err(decodedWorkspaceMismatchCountOutcome.error);
    }
    const workspaceMismatchCount = decodedWorkspaceMismatchCountOutcome.value.count;
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
    const decodedRowsOutcome = sqliteCaptureOutcome(decodedRows);
    if (!decodedRowsOutcome.ok) return Result.err(decodedRowsOutcome.error);
    const rows = decodedRowsOutcome.value.value;
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
    const decodedSessionOutcome = sqliteCaptureOutcome(decodedSession);
    if (!decodedSessionOutcome.ok) {
      if (decodedSessionOutcome.error._tag === "MiniLilacHistoryRecordMissing") {
        return Result.err(
          new MiniLilacSchemaMigrationFailure({
            operation: "migrateSessionHistoryV4",
            message: `Mini Lilac v4 session '${sessionId}' disappeared during migration`,
          }),
        );
      }
      return Result.err(decodedSessionOutcome.error);
    }
    const session = decodedSessionOutcome.value;
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
    const decodedCurrentUiOutcome = sqliteCaptureOutcome(decodedCurrentUi);
    if (!decodedCurrentUiOutcome.ok) return Result.err(decodedCurrentUiOutcome.error);
    const migratedCurrentUi = decodedCurrentUiOutcome.value.value;
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
    const decodedCheckpointsOutcome = sqliteCaptureOutcome(decodedCheckpoints);
    if (!decodedCheckpointsOutcome.ok) return Result.err(decodedCheckpointsOutcome.error);
    const checkpoints = decodedCheckpointsOutcome.value.value;
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
    const decodedActiveRootRunsOutcome = sqliteCaptureOutcome(decodedActiveRootRuns);
    if (!decodedActiveRootRunsOutcome.ok) return Result.err(decodedActiveRootRunsOutcome.error);
    const activeRootRuns = decodedActiveRootRunsOutcome.value.value;
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
      const decodedRunOutcome = sqliteCaptureOutcome(decodedRun);
      if (!decodedRunOutcome.ok) return Result.err(decodedRunOutcome.error);
      if (decodedRunOutcome.value.parent_run_id !== null) {
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
      const decodedUiPrefixOutcome = sqliteCaptureOutcome(decodedUiPrefix);
      if (!decodedUiPrefixOutcome.ok) return Result.err(decodedUiPrefixOutcome.error);
      const migratedUiPrefix = decodedUiPrefixOutcome.value.value;
      const uiHeadId = migratedUiPrefix.changed
        ? this.internChain(sessionId, "ui", migratedUiPrefix.messages, false)
        : checkpoint.ui_head_id;
      const decodedMessage = decodeMiniLilacMigrationUserUiMessage({
        raw: checkpoint.user_message_json,
        schemaVersion: 4,
        recordId: `${sessionId}:${checkpoint.ui_position}:user`,
      });
      const decodedMessageOutcome = sqliteCaptureOutcome(decodedMessage);
      if (!decodedMessageOutcome.ok) return Result.err(decodedMessageOutcome.error);
      parsedCheckpoints.push({
        row: { ...checkpoint, ui_head_id: uiHeadId },
        run: decodedRunOutcome.value,
        message: decodedMessageOutcome.value.value,
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
    const decodedSessionIdsOutcome = sqliteCaptureOutcome(decodedSessionIds);
    if (!decodedSessionIdsOutcome.ok) return Result.err(decodedSessionIdsOutcome.error);
    const sessionIds = decodedSessionIdsOutcome.value.value;
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
      const decodedModelRowsOutcome = sqliteCaptureOutcome(decodedModelRows);
      if (!decodedModelRowsOutcome.ok) return Result.err(decodedModelRowsOutcome.error);
      const modelValues = decodedModelRowsOutcome.value.value.map((row) => row.value_json);
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
      const decodedUiRowsOutcome = sqliteCaptureOutcome(decodedUiRows);
      if (!decodedUiRowsOutcome.ok) return Result.err(decodedUiRowsOutcome.error);
      const uiValues = decodedUiRowsOutcome.value.value.map((row) => row.value_json);
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
      const decodedUiOutcome = sqliteCaptureOutcome(decodedUi);
      if (!decodedUiOutcome.ok) return Result.err(decodedUiOutcome.error);
      const migratedUi = decodedUiOutcome.value.value;
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
    const decodedLegacyCheckpointsOutcome = sqliteCaptureOutcome(decodedLegacyCheckpoints);
    if (!decodedLegacyCheckpointsOutcome.ok) {
      return Result.err(decodedLegacyCheckpointsOutcome.error);
    }
    const checkpoints = decodedLegacyCheckpointsOutcome.value.value;
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
      const decodedMessageOutcome = sqliteCaptureOutcome(decodedMessage);
      if (!decodedMessageOutcome.ok) return Result.err(decodedMessageOutcome.error);
      const decodedModelPrefix = decodeMiniLilacMigrationModelPrefix({
        raw: checkpoint.model_prefix_json,
        schemaVersion: 2,
        recordId: `${recordId}:model`,
      });
      const decodedModelPrefixOutcome = sqliteCaptureOutcome(decodedModelPrefix);
      if (!decodedModelPrefixOutcome.ok) return Result.err(decodedModelPrefixOutcome.error);
      const decodedUiPrefix = decodeMiniLilacMigrationUiPrefix({
        raw: checkpoint.ui_prefix_json,
        schemaVersion: 2,
        recordId: `${recordId}:ui`,
      });
      const decodedUiPrefixOutcome = sqliteCaptureOutcome(decodedUiPrefix);
      if (!decodedUiPrefixOutcome.ok) return Result.err(decodedUiPrefixOutcome.error);
      const message = decodedMessageOutcome.value.value;
      const modelPrefix = decodedModelPrefixOutcome.value.value;
      const uiPrefix = decodedUiPrefixOutcome.value.value.messages;
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
      const decodedWorkspaceOutcome = sqliteCaptureOutcome(decodedWorkspace);
      if (!decodedWorkspaceOutcome.ok) return Result.err(decodedWorkspaceOutcome.error);
      const workspace = decodedWorkspaceOutcome.value;
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
      const snapshotOutcome = sqliteCaptureOutcome(snapshot);
      if (!snapshotOutcome.ok) return Result.err(snapshotOutcome.error);
      const navigation = this.getHistoryNavigationResult(sessionId);
      const navigationOutcome = sqliteCaptureOutcome(navigation);
      if (!navigationOutcome.ok) return Result.err(navigationOutcome.error);
      return Result.ok({
        ...snapshotOutcome.value,
        historyStateId: navigationOutcome.value.currentStateId,
        canUndo: navigationOutcome.value.canUndo,
        canRedo: navigationOutcome.value.canRedo,
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
        const snapshotOutcome = sqliteCaptureOutcome(snapshot);
        if (!snapshotOutcome.ok) return Result.err(snapshotOutcome.error);
        if (updated.changes === 0 && snapshotOutcome.value.activeRunId !== runId) {
          return Result.err(
            new MiniLilacStoreOperationRejected({
              operation: "updateActiveRunInputTokens",
              message: `Run '${runId}' is not active for session '${sessionId}'`,
            }),
          );
        }
        return Result.ok(snapshotOutcome.value);
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
    const commandOutcome = sqliteCaptureOutcome(command);
    if (!commandOutcome.ok) return Result.err(commandOutcome.error);
    return this.runStoreTransactionResult("updateSessionBindings", () => {
      const previous = this.getCommandResultResult(sessionId, commandId, request);
      const decodedPrevious = previous.andThen(decodeStoredSessionSnapshot);
      const decodedPreviousOutcome = sqliteCaptureOutcome(decodedPrevious);
      if (!decodedPreviousOutcome.ok) return Result.err(decodedPreviousOutcome.error);
      if (decodedPreviousOutcome.value !== undefined)
        return Result.ok(decodedPreviousOutcome.value);
      const snapshot = this.getSessionResult(sessionId);
      const snapshotOutcome = sqliteCaptureOutcome(snapshot);
      if (!snapshotOutcome.ok) return Result.err(snapshotOutcome.error);
      const activeRunCount = decodeRequiredMiniLilacStoreRow({
        kind: "count",
        row: this.database
          .query("SELECT COUNT(*) AS count FROM runs WHERE session_id = ? AND status = 'active'")
          .get(sessionId),
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: `${sessionId}:active-run-count`,
      });
      const activeRunCountOutcome = sqliteCaptureOutcome(activeRunCount);
      if (!activeRunCountOutcome.ok) return Result.err(activeRunCountOutcome.error);
      if (
        !["idle", "error"].includes(snapshotOutcome.value.status) ||
        snapshotOutcome.value.activeRunId !== null ||
        activeRunCountOutcome.value.count > 0
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
      if (bindings.model === undefined && snapshotOutcome.value.inputTokensEstimated) {
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
          bindings.model ?? snapshotOutcome.value.model,
          bindings.profile ?? snapshotOutcome.value.profile,
          bindings.reasoning ?? snapshotOutcome.value.reasoning,
          bindings.model === undefined
            ? (snapshotOutcome.value.contextWindow ?? null)
            : (bindings.contextWindow ?? null),
          bindings.model === undefined ? (snapshotOutcome.value.inputTokens ?? null) : null,
          // Clearing the count must clear the flag with it: an estimate marker
          // left on a null count renders as an estimate of nothing.
          inputTokensEstimated,
          now,
          sessionId,
        );
      const result = this.getSessionResult(sessionId);
      const resultOutcome = sqliteCaptureOutcome(result);
      if (!resultOutcome.ok) return Result.err(resultOutcome.error);
      const serializedResult = serializeStoreValueResult(
        resultOutcome.value,
        "updateSessionBindings",
      );
      const serializedResultOutcome = sqliteCaptureOutcome(serializedResult);
      if (!serializedResultOutcome.ok) return Result.err(serializedResultOutcome.error);
      this.database
        .query(
          `INSERT INTO commands
            (session_id, command_id, kind, run_id, request_fingerprint, request_json, side_effect_started, result_json, created_at)
           VALUES (?, ?, ?, NULL, ?, ?, 1, ?, ?)`,
        )
        .run(
          sessionId,
          commandId,
          commandOutcome.value.kind,
          commandOutcome.value.fingerprint,
          commandOutcome.value.json,
          serializedResultOutcome.value,
          now,
        );
      return Result.ok(resultOutcome.value);
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
    const runOutcome = sqliteCaptureOutcome(run);
    if (!runOutcome.ok) return Result.err(runOutcome.error);
    if (runOutcome.value.parentRunId === null) {
      return Result.err(
        new MiniLilacStoreOperationRejected({
          operation: "finishRun",
          message:
            "Root runs must be terminalized through pending finalization so history closes atomically",
        }),
      );
    }
    const terminalResult = serializeOptionalTerminalResult(options, "finishRun");
    const terminalResultOutcome = sqliteCaptureOutcome(terminalResult);
    if (!terminalResultOutcome.ok) return Result.err(terminalResultOutcome.error);
    return this.runStoreTransactionResult("finishRun", () => {
      this.database
        .query(
          "UPDATE runs SET status = ?, error = ?, terminal_result_json = ?, finished_at = ? WHERE id = ?",
        )
        .run(
          status,
          options.error ?? null,
          terminalResultOutcome.value,
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
        const currentOutcome = sqliteCaptureOutcome(current);
        if (!currentOutcome.ok) return Result.err(currentOutcome.error);
        const currentJson = JSON.stringify(canonicalJsonValue(currentOutcome.value.todos));
        if (currentJson === todosJson) return Result.ok({ state: currentOutcome.value });
        if (currentOutcome.value.revision === Number.MAX_SAFE_INTEGER) {
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
          const unchangedOutcome = sqliteCaptureOutcome(unchanged);
          return !unchangedOutcome.ok
            ? Result.err(unchangedOutcome.error)
            : Result.ok({ state: unchangedOutcome.value });
        }

        const decodedState = decodeMiniLilacTodos({
          row: updatedValue,
          schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
          recordId: input.sessionId,
        });
        const decodedStateOutcome = sqliteCaptureOutcome(decodedState);
        if (!decodedStateOutcome.ok) return Result.err(decodedStateOutcome.error);
        const state = decodedStateOutcome.value.value;
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
    const attempted = sqliteCaptureOutcome(
      Result.try<
        ResultType<T, E | MiniLilacSqliteDriverFailure>,
        { readonly rethrow: () => never }
      >({
        try: () =>
          runBunSqliteTransaction(this.database, operation, (cause) =>
            classifyMiniLilacSqliteDriverFailure(operationName, cause),
          ),
        catch: (cause) => ({ rethrow: () => storeResultToLegacy(Result.err(cause)) }),
      }),
    );
    this.transactionDepth -= 1;
    if (this.transactionDepth === 0) this.flushPersistenceDiagnostics();
    if (!attempted.ok) return attempted.error.rethrow();
    return attempted.value;
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
    const decodedOutcome = sqliteCaptureOutcome(decoded);
    if (!decodedOutcome.ok) {
      this.queuePersistenceDiagnostic(decodedOutcome.error);
      return Result.err(decodedOutcome.error);
    }
    if (decodedOutcome.value.value === null) return Result.ok(null);
    // The codec preserves the input kind; this bridges that correlation, which
    // TypeScript cannot retain through the generic Extract-based predicate.
    return Result.ok(decodedOutcome.value.value.value as MiniLilacStructuralHistoryValueFor<K>);
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
    const decodedOutcome = sqliteCaptureOutcome(decoded);
    if (!decodedOutcome.ok) return Result.err(decodedOutcome.error);
    if (decodedOutcome.value !== null) return Result.ok(decodedOutcome.value);
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
    const decodedOutcome = sqliteCaptureOutcome(decoded);
    if (!decodedOutcome.ok) {
      this.queuePersistenceDiagnostic(decodedOutcome.error);
      return Result.err(decodedOutcome.error);
    }
    return Result.ok(decodedOutcome.value.value);
  }

  private runHistoryReadResult<T, E>(
    operationName: string,
    operation: () => ResultType<T, E>,
  ): ResultType<T, E | MiniLilacSqliteDriverFailure> {
    const attempted = sqliteCaptureOutcome(
      Result.try<ResultType<T, E>, OpaqueMiniLilacSqliteValue>({
        try: operation,
        catch: (cause) => cause,
      }),
    );
    if (this.transactionDepth === 0) this.flushPersistenceDiagnostics();
    if (attempted.ok) return attempted.value;
    if (Panic.is(attempted.error)) throw attempted.error;
    if (!(attempted.error instanceof Error)) throw attempted.error;
    const failure = classifyMiniLilacSqliteDriverFailure(operationName, attempted.error);
    if (failure !== undefined) return Result.err(failure);
    throw attempted.error;
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
    const workspacesOutcome = sqliteCaptureOutcome(workspaces);
    if (!workspacesOutcome.ok) return Result.err(workspacesOutcome.error);
    const groups: StoredWorkspaceSnapshotGroup[] = [];
    for (const workspace of workspacesOutcome.value) {
      const snapshots = this.listWorkspaceSnapshotsResult(workspace.id);
      const snapshotsOutcome = sqliteCaptureOutcome(snapshots);
      if (!snapshotsOutcome.ok) return Result.err(snapshotsOutcome.error);
      groups.push({ workspace, snapshots: snapshotsOutcome.value });
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
      const candidatesOutcome = sqliteCaptureOutcome(candidates);
      if (!candidatesOutcome.ok) return Result.err(candidatesOutcome.error);
      const selectedCandidates = candidatesOutcome.value.filter(
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
      const snapshotOutcome = sqliteCaptureOutcome(snapshot);
      if (!snapshotOutcome.ok) return Result.err(snapshotOutcome.error);
      return Result.ok(snapshotOutcome.value);
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
    const stateOutcome = sqliteCaptureOutcome(state);
    if (!stateOutcome.ok) return Result.err(stateOutcome.error);
    return this.runHistoryReadResult("getHistoryStateModelMessages", () => {
      const rawValues = this.readSerializedChainResult(
        stateOutcome.value.sessionId,
        "model",
        stateOutcome.value.modelHeadId,
      );
      const rawValuesOutcome = sqliteCaptureOutcome(rawValues);
      if (!rawValuesOutcome.ok) {
        this.queuePersistenceDiagnostic(rawValuesOutcome.error);
        return Result.err(rawValuesOutcome.error);
      }
      const decoded = decodeMiniLilacModelTranscript({
        rawValues: rawValuesOutcome.value,
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: stateOutcome.value.id,
      });
      const decodedOutcome = sqliteCaptureOutcome(decoded);
      if (!decodedOutcome.ok) {
        this.queuePersistenceDiagnostic(decodedOutcome.error);
        return Result.err(decodedOutcome.error);
      }
      return Result.ok(decodedOutcome.value.value);
    });
  }

  getHistoryStateUiMessages(stateId: string): MiniLilacUIMessage[] {
    return storeResultToLegacy(this.getHistoryStateUiMessagesResult(stateId));
  }

  getHistoryStateUiMessagesResult(
    stateId: string,
  ): ResultType<MiniLilacUIMessage[], MiniLilacPersistenceError> {
    const state = this.getHistoryStateResult(stateId);
    const stateOutcome = sqliteCaptureOutcome(state);
    if (!stateOutcome.ok) return Result.err(stateOutcome.error);
    return this.runHistoryReadResult("getHistoryStateUiMessages", () => {
      const rawValues = this.readSerializedChainResult(
        stateOutcome.value.sessionId,
        "ui",
        stateOutcome.value.uiHeadId,
      );
      const rawValuesOutcome = sqliteCaptureOutcome(rawValues);
      if (!rawValuesOutcome.ok) {
        this.queuePersistenceDiagnostic(rawValuesOutcome.error);
        return Result.err(rawValuesOutcome.error);
      }
      const decoded = decodeMiniLilacUiTranscript({
        rawValues: rawValuesOutcome.value,
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: stateOutcome.value.id,
      });
      const decodedOutcome = sqliteCaptureOutcome(decoded);
      if (!decodedOutcome.ok) {
        this.queuePersistenceDiagnostic(decodedOutcome.error);
        return Result.err(decodedOutcome.error);
      }
      return Result.ok(decodedOutcome.value.value);
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
      const decodedStateOutcome = sqliteCaptureOutcome(decodedState);
      if (!decodedStateOutcome.ok) return Result.err(decodedStateOutcome.error);
      const historyState = decodedStateOutcome.value;
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
        const decodedBindingOutcome = sqliteCaptureOutcome(decodedBinding);
        if (!decodedBindingOutcome.ok) return Result.err(decodedBindingOutcome.error);
        binding = decodedBindingOutcome.value;
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
      const sourceOutcome = sqliteCaptureOutcome(source);
      if (!sourceOutcome.ok) return Result.err(sourceOutcome.error);
      if (input.expectedBindingRevision !== null) {
        const binding = sourceOutcome.value.binding;
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
      const activeCountOutcome = sqliteCaptureOutcome(activeCount);
      if (!activeCountOutcome.ok) return Result.err(activeCountOutcome.error);
      if (activeCountOutcome.value.count >= MINI_MAIN_CLAUDE_ATTEMPT_RETENTION_LIMIT) {
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
      const attemptOutcome = sqliteCaptureOutcome(attempt);
      if (!attemptOutcome.ok) return Result.err(attemptOutcome.error);
      if (attemptOutcome.value === null) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "reserveMiniMainClaudeSessionAttempt",
            message: "Reserved Claude attempt was not retained",
          }),
        );
      }
      return Result.ok(attemptOutcome.value);
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
      const currentOutcome = sqliteCaptureOutcome(current);
      if (!currentOutcome.ok) return Result.err(currentOutcome.error);
      if (currentOutcome.value === null) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "recordMiniMainClaudeSessionAttemptOutcome",
            message: `Claude attempt '${input.requestId}' was not found`,
          }),
        );
      }
      if (currentOutcome.value.state !== "active") {
        if (currentOutcome.value.state === input.state) return Result.ok(currentOutcome.value);
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "recordMiniMainClaudeSessionAttemptOutcome",
            message: `Claude attempt '${input.requestId}' is already terminal as '${currentOutcome.value.state}'`,
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
      const attemptOutcome = sqliteCaptureOutcome(attempt);
      if (!attemptOutcome.ok) return Result.err(attemptOutcome.error);
      if (attemptOutcome.value === null) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "recordMiniMainClaudeSessionAttemptOutcome",
            message: "Updated Claude attempt exceeded retention immediately",
          }),
        );
      }
      return Result.ok(attemptOutcome.value);
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
      const bindingOutcome = sqliteCaptureOutcome(binding);
      return !bindingOutcome.ok
        ? Result.err(bindingOutcome.error)
        : Result.ok({ binding: bindingOutcome.value });
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
      const mainBindingCountOutcome = sqliteCaptureOutcome(mainBindingCount);
      if (!mainBindingCountOutcome.ok) return Result.err(mainBindingCountOutcome.error);
      const namedBindingCount = count(
        "SELECT COUNT(*) AS count FROM mini_named_claude_bindings",
        "named-binding-count",
      );
      const namedBindingCountOutcome = sqliteCaptureOutcome(namedBindingCount);
      if (!namedBindingCountOutcome.ok) return Result.err(namedBindingCountOutcome.error);
      const activeAttemptCount = count(
        `SELECT
           (SELECT COUNT(*) FROM mini_main_claude_attempts WHERE state = 'active') +
           (SELECT COUNT(*) FROM mini_named_claude_attempts WHERE state = 'active') AS count`,
        "active-attempt-count",
      );
      const activeAttemptCountOutcome = sqliteCaptureOutcome(activeAttemptCount);
      if (!activeAttemptCountOutcome.ok) return Result.err(activeAttemptCountOutcome.error);
      const terminalAttemptCount = count(
        `SELECT
           (SELECT COUNT(*) FROM mini_main_claude_attempts WHERE state <> 'active') +
           (SELECT COUNT(*) FROM mini_named_claude_attempts WHERE state <> 'active') AS count`,
        "terminal-attempt-count",
      );
      const terminalAttemptCountOutcome = sqliteCaptureOutcome(terminalAttemptCount);
      if (!terminalAttemptCountOutcome.ok) return Result.err(terminalAttemptCountOutcome.error);
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
      const orphanBindingCountOutcome = sqliteCaptureOutcome(orphanBindingCount);
      if (!orphanBindingCountOutcome.ok) return Result.err(orphanBindingCountOutcome.error);
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
      const orphanAttemptCountOutcome = sqliteCaptureOutcome(orphanAttemptCount);
      if (!orphanAttemptCountOutcome.ok) return Result.err(orphanAttemptCountOutcome.error);
      return Result.ok({
        mainBindingCount: mainBindingCountOutcome.value.count,
        namedBindingCount: namedBindingCountOutcome.value.count,
        activeAttemptCount: activeAttemptCountOutcome.value.count,
        terminalAttemptCount: terminalAttemptCountOutcome.value.count,
        orphanBindingCount: orphanBindingCountOutcome.value.count,
        orphanAttemptCount: orphanAttemptCountOutcome.value.count,
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
      const sourceOutcome = sqliteCaptureOutcome(source);
      if (!sourceOutcome.ok) return Result.err(sourceOutcome.error);
      if (sourceOutcome.value.sessionId !== input.lilacSessionId) {
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
      const namedStateOutcome = sqliteCaptureOutcome(namedState);
      if (!namedStateOutcome.ok) return Result.err(namedStateOutcome.error);
      const binding = namedStateOutcome.value.binding;
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
      const activeCountOutcome = sqliteCaptureOutcome(activeCount);
      if (!activeCountOutcome.ok) return Result.err(activeCountOutcome.error);
      if (activeCountOutcome.value.count >= MINI_NAMED_CLAUDE_ATTEMPT_RETENTION_LIMIT) {
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
      const attemptOutcome = sqliteCaptureOutcome(attempt);
      if (!attemptOutcome.ok) return Result.err(attemptOutcome.error);
      if (attemptOutcome.value === null) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "reserveMiniNamedClaudeSessionAttempt",
            message: "Reserved named Claude attempt was not retained",
          }),
        );
      }
      return Result.ok(attemptOutcome.value);
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
      const currentOutcome = sqliteCaptureOutcome(current);
      if (!currentOutcome.ok) return Result.err(currentOutcome.error);
      if (currentOutcome.value === null) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "recordMiniNamedClaudeSessionAttemptOutcome",
            message: `Named Claude attempt '${input.requestId}' was not found`,
          }),
        );
      }
      if (currentOutcome.value.state !== "active") {
        if (currentOutcome.value.state === input.state) return Result.ok(currentOutcome.value);
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "recordMiniNamedClaudeSessionAttemptOutcome",
            message: `Named Claude attempt '${input.requestId}' is already terminal as '${currentOutcome.value.state}'`,
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
      const attemptOutcome = sqliteCaptureOutcome(attempt);
      if (!attemptOutcome.ok) return Result.err(attemptOutcome.error);
      if (attemptOutcome.value === null) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "recordMiniNamedClaudeSessionAttemptOutcome",
            message: "Updated named Claude attempt exceeded retention immediately",
          }),
        );
      }
      return Result.ok(attemptOutcome.value);
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
    const historyOutcome = sqliteCaptureOutcome(history);
    if (!historyOutcome.ok) return Result.err(historyOutcome.error);
    const undo = this.findLatestUndoableUserTransitionResult(sessionId);
    const undoOutcome = sqliteCaptureOutcome(undo);
    if (!undoOutcome.ok) return Result.err(undoOutcome.error);
    const redo = this.peekHistoryRedoResult(sessionId);
    const redoOutcome = sqliteCaptureOutcome(redo);
    if (!redoOutcome.ok) return Result.err(redoOutcome.error);
    return Result.ok({
      currentStateId: historyOutcome.value.currentStateId,
      canUndo: undoOutcome.value !== null,
      canRedo: redoOutcome.value !== null,
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
      const historyOutcome = sqliteCaptureOutcome(history);
      if (!historyOutcome.ok) return Result.err(historyOutcome.error);
      const states = this.decodeStructuralHistoryRows({
        kind: "state",
        rows: this.database
          .query("SELECT * FROM history_states WHERE session_id = ? ORDER BY created_at, rowid")
          .all(sessionId),
        recordId: `${sessionId}:state`,
      });
      const statesOutcome = sqliteCaptureOutcome(states);
      if (!statesOutcome.ok) return Result.err(statesOutcome.error);
      const transitions = this.decodeStructuralHistoryRows({
        kind: "transition",
        rows: this.database
          .query(
            "SELECT * FROM history_transitions WHERE session_id = ? ORDER BY created_at, rowid",
          )
          .all(sessionId),
        recordId: `${sessionId}:transition`,
      });
      const transitionsOutcome = sqliteCaptureOutcome(transitions);
      if (!transitionsOutcome.ok) return Result.err(transitionsOutcome.error);
      const redoStack = this.decodeStructuralHistoryRows({
        kind: "redo",
        rows: this.database
          .query("SELECT * FROM history_redo_stack WHERE session_id = ? ORDER BY position")
          .all(sessionId),
        recordId: `${sessionId}:redo`,
      });
      const redoStackOutcome = sqliteCaptureOutcome(redoStack);
      if (!redoStackOutcome.ok) return Result.err(redoStackOutcome.error);
      return Result.ok({
        history: historyOutcome.value,
        states: statesOutcome.value,
        transitions: transitionsOutcome.value,
        redoStack: redoStackOutcome.value,
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
    const commandOutcome = sqliteCaptureOutcome(command);
    if (!commandOutcome.ok) return Result.err(commandOutcome.error);
    return this.runStoreTransactionResult("admitRootPromptHistory", () => {
      const quiescent = this.requireQuiescentHistorySessionResult(
        input.run.sessionId,
        input.expectedCurrentStateId,
      );
      const quiescenceError = quiescent.match({ ok: () => null, err: (error) => error });
      if (quiescenceError !== null) return Result.err(quiescenceError);
      const workspace = this.getWorkspaceForSessionResult(input.run.sessionId);
      const workspaceOutcome = sqliteCaptureOutcome(workspace);
      if (!workspaceOutcome.ok) return Result.err(workspaceOutcome.error);
      const available = this.assertWorkspaceHasNoHistoryJournalResult(workspaceOutcome.value.id);
      const availabilityError = available.match({ ok: () => null, err: (error) => error });
      if (availabilityError !== null) return Result.err(availabilityError);
      const current = this.getCurrentHistoryStateResult(input.run.sessionId);
      const currentOutcome = sqliteCaptureOutcome(current);
      if (!currentOutcome.ok) return Result.err(currentOutcome.error);
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
        currentOutcome.value,
      );
      const headsError = equalHeads.match({ ok: () => null, err: (error) => error });
      if (headsError !== null) return Result.err(headsError);
      if (
        currentOutcome.value.workspaceStatus === "capture-deferred" &&
        input.observation === undefined
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "admitRootPromptHistory",
            "A deferred history root requires an observed workspace boundary",
          ),
        );
      }
      let fromState = currentOutcome.value;
      if (input.observation !== undefined) {
        const observed = this.insertWorkspaceObservationResult(
          input.run.sessionId,
          currentOutcome.value,
          prefixHeads,
          input.observation,
        );
        const observedOutcome = sqliteCaptureOutcome(observed);
        if (!observedOutcome.ok) return Result.err(observedOutcome.error);
        fromState = observedOutcome.value;
        const moved = this.moveHistoryCursorResult(input.run.sessionId, fromState);
        const moveError = moved.match({ ok: () => null, err: (error) => error });
        if (moveError !== null) return Result.err(moveError);
      }
      const fullHeads = {
        modelHeadId: this.internChain(input.run.sessionId, "model", input.modelMessages),
        uiHeadId: this.internChain(input.run.sessionId, "ui", input.uiMessages),
      };
      const commandRow = this.getStoredCommandResult(input.run.sessionId, input.commandId);
      const commandRowOutcome = sqliteCaptureOutcome(commandRow);
      if (!commandRowOutcome.ok) return Result.err(commandRowOutcome.error);
      if (
        commandRowOutcome.value.kind !== "prompt" ||
        commandRowOutcome.value.run_id !== null ||
        commandRowOutcome.value.side_effect_started !== 0 ||
        commandRowOutcome.value.result_json !== null ||
        commandRowOutcome.value.request_fingerprint !== commandOutcome.value.fingerprint ||
        commandRowOutcome.value.request_json !== commandOutcome.value.json
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
      const snapshotOutcome = sqliteCaptureOutcome(snapshot);
      if (!snapshotOutcome.ok) return Result.err(snapshotOutcome.error);
      const transition = this.getHistoryTransitionResult(input.transitionId);
      const transitionOutcome = sqliteCaptureOutcome(transition);
      if (!transitionOutcome.ok) return Result.err(transitionOutcome.error);
      return Result.ok({
        snapshot: snapshotOutcome.value,
        fromState,
        transition: transitionOutcome.value,
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
    const validatedOutcome = sqliteCaptureOutcome(validated);
    if (!validatedOutcome.ok) return Result.err(validatedOutcome.error);
    const { firstUiPosition, firstModelPosition } = validatedOutcome.value;
    return this.runStoreTransactionResult("commitSteeringHistoryBoundary", () => {
      const session = this.getSessionResult(input.sessionId);
      const sessionOutcome = sqliteCaptureOutcome(session);
      if (!sessionOutcome.ok) return Result.err(sessionOutcome.error);
      const activeRun = this.getActiveRootRun(input.sessionId);
      if (
        sessionOutcome.value.status !== "streaming" ||
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
      const workspaceOutcome = sqliteCaptureOutcome(workspace);
      if (!workspaceOutcome.ok) return Result.err(workspaceOutcome.error);
      const available = this.assertWorkspaceHasNoHistoryJournalResult(workspaceOutcome.value.id);
      const availabilityError = available.match({ ok: () => null, err: (error) => error });
      if (availabilityError !== null) return Result.err(availabilityError);
      const previous = this.getHistoryTransitionResult(input.previousOpenTransitionId);
      const previousOutcome = sqliteCaptureOutcome(previous);
      if (!previousOutcome.ok) return Result.err(previousOutcome.error);
      const history = this.getSessionHistoryResult(input.sessionId);
      const historyOutcome = sqliteCaptureOutcome(history);
      if (!historyOutcome.ok) return Result.err(historyOutcome.error);
      if (
        previousOutcome.value.sessionId !== input.sessionId ||
        previousOutcome.value.toStateId !== null ||
        previousOutcome.value.rootRunId !== input.rootRunId ||
        historyOutcome.value.currentStateId !== previousOutcome.value.fromStateId
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
      const canonicalUiMessagesOutcome = sqliteCaptureOutcome(canonicalUiMessages);
      if (!canonicalUiMessagesOutcome.ok) return Result.err(canonicalUiMessagesOutcome.error);
      const baseUiMessages = input.uiMessages.slice(0, firstUiPosition);
      if (!isCanonicalPrefix(canonicalUiMessagesOutcome.value, baseUiMessages)) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitSteeringHistoryBoundary",
            "Steering UI boundary does not extend the canonical live transcript",
          ),
        );
      }
      const fromState = this.getHistoryStateResult(previousOutcome.value.fromStateId);
      const fromStateOutcome = sqliteCaptureOutcome(fromState);
      if (!fromStateOutcome.ok) return Result.err(fromStateOutcome.error);
      const providerState =
        input.providerState === undefined
          ? fromStateOutcome.value.providerState
          : input.providerState;
      if (input.providerState !== undefined) {
        const conservative = this.assertConservativeProviderTransitionResult(
          fromStateOutcome.value.id,
          input.providerState,
        );
        const transitionError = conservative.match({ ok: () => null, err: (error) => error });
        if (transitionError !== null) return Result.err(transitionError);
      }
      const rawFromUiMessages = this.readSerializedChainResult(
        input.sessionId,
        "ui",
        fromStateOutcome.value.uiHeadId,
      );
      const rawFromUiMessagesOutcome = sqliteCaptureOutcome(rawFromUiMessages);
      if (!rawFromUiMessagesOutcome.ok) return Result.err(rawFromUiMessagesOutcome.error);
      const decodedFromUiMessages = decodeMiniLilacUiTranscript({
        rawValues: rawFromUiMessagesOutcome.value,
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: fromStateOutcome.value.id,
      });
      const decodedFromUiMessagesOutcome = sqliteCaptureOutcome(decodedFromUiMessages);
      if (!decodedFromUiMessagesOutcome.ok) return Result.err(decodedFromUiMessagesOutcome.error);
      const fromUiMessages = decodedFromUiMessagesOutcome.value.value;
      if (
        previousOutcome.value.userMessage === null ||
        !canonicalValuesEqual(
          canonicalUiMessagesOutcome.value[fromUiMessages.length],
          previousOutcome.value.userMessage,
        ) ||
        !canonicalValuesEqual(
          baseUiMessages[fromUiMessages.length],
          previousOutcome.value.userMessage,
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
        workspaceId: workspaceOutcome.value.id,
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
      const boundaryOutcome = sqliteCaptureOutcome(boundary);
      if (!boundaryOutcome.ok) return Result.err(boundaryOutcome.error);
      let currentState = boundaryOutcome.value;
      for (const [index, entry] of input.entries.entries()) {
        const commandRow = this.getStoredCommandResult(input.sessionId, entry.commandId);
        const commandRowOutcome = sqliteCaptureOutcome(commandRow);
        if (!commandRowOutcome.ok) return Result.err(commandRowOutcome.error);
        if (
          commandRowOutcome.value.kind !== "steer" ||
          commandRowOutcome.value.run_id !== input.rootRunId ||
          commandRowOutcome.value.side_effect_started !== 1 ||
          commandRowOutcome.value.result_json === null
        ) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "commitSteeringHistoryBoundary",
              `Steering command '${entry.commandId}' is not admitted for this root run`,
            ),
          );
        }
        const decodedCommandPayload = decodeMiniLilacSteeringCommandRequest({
          raw: commandRowOutcome.value.request_json,
          schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
          recordId: entry.commandId,
        });
        const decodedCommandPayloadOutcome = sqliteCaptureOutcome(decodedCommandPayload);
        if (!decodedCommandPayloadOutcome.ok) {
          return Result.err(decodedCommandPayloadOutcome.error);
        }
        const commandPayload = decodedCommandPayloadOutcome.value.value;
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
              workspaceId: workspaceOutcome.value.id,
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
          const intermediateStateOutcome = sqliteCaptureOutcome(intermediateState);
          if (!intermediateStateOutcome.ok) return Result.err(intermediateStateOutcome.error);
          currentState = intermediateStateOutcome.value;
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
      const openTransitionOutcome = sqliteCaptureOutcome(openTransition);
      if (!openTransitionOutcome.ok) return Result.err(openTransitionOutcome.error);
      return Result.ok({
        currentState,
        openTransition: openTransitionOutcome.value,
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
    const commandOutcome = sqliteCaptureOutcome(command);
    if (!commandOutcome.ok) return Result.err(commandOutcome.error);
    return this.runStoreTransactionResult("commitHistoryCompaction", () => {
      const quiescent = this.requireQuiescentHistorySessionResult(
        input.sessionId,
        input.expectedCurrentStateId,
        ["idle", "error", "compacting"],
      );
      const quiescenceError = quiescent.match({ ok: () => null, err: (error) => error });
      if (quiescenceError !== null) return Result.err(quiescenceError);
      const workspace = this.getWorkspaceForSessionResult(input.sessionId);
      const workspaceOutcome = sqliteCaptureOutcome(workspace);
      if (!workspaceOutcome.ok) return Result.err(workspaceOutcome.error);
      const available = this.assertWorkspaceHasNoHistoryJournalResult(workspaceOutcome.value.id);
      const availabilityError = available.match({ ok: () => null, err: (error) => error });
      if (availabilityError !== null) return Result.err(availabilityError);
      const commandRow = this.getStoredCommandResult(input.sessionId, input.commandId);
      const commandRowOutcome = sqliteCaptureOutcome(commandRow);
      if (!commandRowOutcome.ok) return Result.err(commandRowOutcome.error);
      if (
        commandRowOutcome.value.kind !== input.request.kind ||
        commandRowOutcome.value.run_id !== null ||
        commandRowOutcome.value.side_effect_started !== 0 ||
        commandRowOutcome.value.result_json !== null ||
        commandRowOutcome.value.request_fingerprint !== commandOutcome.value.fingerprint ||
        commandRowOutcome.value.request_json !== commandOutcome.value.json
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
        const stateOutcome = sqliteCaptureOutcome(state);
        if (!stateOutcome.ok) return Result.err(stateOutcome.error);
        const snapshot = this.getSessionResult(input.sessionId);
        const snapshotOutcome = sqliteCaptureOutcome(snapshot);
        if (!snapshotOutcome.ok) return Result.err(snapshotOutcome.error);
        return Result.ok({
          state: stateOutcome.value,
          snapshot: snapshotOutcome.value,
        });
      }
      const current = this.getCurrentHistoryStateResult(input.sessionId);
      const currentOutcome = sqliteCaptureOutcome(current);
      if (!currentOutcome.ok) return Result.err(currentOutcome.error);
      let fromState = currentOutcome.value;
      if (input.observation !== undefined) {
        const observed = this.insertWorkspaceObservationResult(
          input.sessionId,
          fromState,
          { modelHeadId: fromState.modelHeadId, uiHeadId: fromState.uiHeadId },
          input.observation,
        );
        const observedOutcome = sqliteCaptureOutcome(observed);
        if (!observedOutcome.ok) return Result.err(observedOutcome.error);
        fromState = observedOutcome.value;
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
      const uiMessagesOutcome = sqliteCaptureOutcome(uiMessages);
      if (!uiMessagesOutcome.ok) return Result.err(uiMessagesOutcome.error);
      const heads = {
        modelHeadId: this.internChain(input.sessionId, "model", input.modelMessages),
        uiHeadId: this.internChain(input.sessionId, "ui", [
          ...uiMessagesOutcome.value,
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
          workspaceId: workspaceOutcome.value.id,
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
      const appendedOutcome = sqliteCaptureOutcome(appended);
      if (!appendedOutcome.ok) return Result.err(appendedOutcome.error);
      const floor = this.setHistoryUndoFloorResult(input.sessionId, appendedOutcome.value.state.id);
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
      const snapshotOutcome = sqliteCaptureOutcome(snapshot);
      if (!snapshotOutcome.ok) return Result.err(snapshotOutcome.error);
      return Result.ok({
        state: appendedOutcome.value.state,
        snapshot: snapshotOutcome.value,
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
        const historyOutcome = sqliteCaptureOutcome(history);
        if (!historyOutcome.ok) return Result.err(historyOutcome.error);
        if (
          !this.isStateInAncestry(
            input.state.sessionId,
            input.state.id,
            historyOutcome.value.undoFloorStateId,
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
      const stateOutcome = sqliteCaptureOutcome(state);
      if (!stateOutcome.ok) return Result.err(stateOutcome.error);
      const transition = this.getHistoryTransitionResult(input.transition.id);
      const transitionOutcome = sqliteCaptureOutcome(transition);
      if (!transitionOutcome.ok) return Result.err(transitionOutcome.error);
      return Result.ok({
        state: stateOutcome.value,
        transition: transitionOutcome.value,
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
      const transitionOutcome = sqliteCaptureOutcome(transition);
      if (!transitionOutcome.ok) return Result.err(transitionOutcome.error);
      if (
        transitionOutcome.value.toStateId !== null ||
        transitionOutcome.value.kind !== "user-message"
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "closeHistoryTransition",
            `History transition '${transitionId}' is not an open user transition`,
          ),
        );
      }
      if (
        destination.sessionId !== transitionOutcome.value.sessionId ||
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
        transitionOutcome.value.sessionId,
        transitionOutcome.value.fromStateId,
      );
      const connectionError = connected.match({ ok: () => null, err: (error) => error });
      if (connectionError !== null) return Result.err(connectionError);
      this.insertHistoryStateRow(destination);
      const validDestination = this.validateHistoryTransitionDestinationResult(
        transitionOutcome.value.sessionId,
        transitionOutcome.value.fromStateId,
        destination.id,
        transitionOutcome.value.kind,
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
          .run(transitionOutcome.value.sessionId);
      }
      if (options.select) {
        const history = this.getSessionHistoryResult(transitionOutcome.value.sessionId);
        const historyOutcome = sqliteCaptureOutcome(history);
        if (!historyOutcome.ok) return Result.err(historyOutcome.error);
        if (
          !this.isStateInAncestry(
            transitionOutcome.value.sessionId,
            destination.id,
            historyOutcome.value.undoFloorStateId,
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
          transitionOutcome.value.sessionId,
          destination.modelHeadId,
          destination.uiHeadId,
        );
        this.database
          .query(
            `UPDATE session_history SET current_state_id = ?, updated_at = ?
             WHERE session_id = ?`,
          )
          .run(destination.id, new Date().toISOString(), transitionOutcome.value.sessionId);
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
        const stateOutcome = sqliteCaptureOutcome(state);
        if (!stateOutcome.ok) return Result.err(stateOutcome.error);
        if (stateOutcome.value.sessionId !== sessionId) {
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
        const historyOutcome = sqliteCaptureOutcome(history);
        if (!historyOutcome.ok) return Result.err(historyOutcome.error);
        const currentStateId = historyOutcome.value.currentStateId;
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
        const targetOutcome = sqliteCaptureOutcome(target);
        if (!targetOutcome.ok) return Result.err(targetOutcome.error);
        const transition = this.getHistoryTransitionResult(userTransitionId);
        const transitionOutcome = sqliteCaptureOutcome(transition);
        if (!transitionOutcome.ok) return Result.err(transitionOutcome.error);
        if (
          targetOutcome.value.sessionId !== sessionId ||
          transitionOutcome.value.sessionId !== sessionId ||
          transitionOutcome.value.kind !== "user-message" ||
          transitionOutcome.value.toStateId === null ||
          !this.isStateInAncestry(sessionId, targetStateId, transitionOutcome.value.toStateId)
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
        const positionOutcome = sqliteCaptureOutcome(position);
        if (!positionOutcome.ok) return Result.err(positionOutcome.error);
        this.database
          .query(
            `INSERT INTO history_redo_stack
            (session_id, position, target_state_id, user_transition_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            sessionId,
            positionOutcome.value.position,
            targetStateId,
            userTransitionId,
            new Date().toISOString(),
          );
        const entry = this.peekHistoryRedoResult(sessionId);
        const entryOutcome = sqliteCaptureOutcome(entry);
        if (!entryOutcome.ok) return Result.err(entryOutcome.error);
        if (entryOutcome.value === null) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "pushHistoryRedo",
              `Redo entry for session '${sessionId}' was not created`,
            ),
          );
        }
        return Result.ok(entryOutcome.value);
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
      const entryOutcome = sqliteCaptureOutcome(entry);
      if (!entryOutcome.ok) return Result.err(entryOutcome.error);
      if (entryOutcome.value === null) return Result.ok(null);
      this.database
        .query("DELETE FROM history_redo_stack WHERE session_id = ? AND position = ?")
        .run(sessionId, entryOutcome.value.position);
      return Result.ok(entryOutcome.value);
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
    const decodedInputResultOutcome = sqliteCaptureOutcome(decodedInputResult);
    if (!decodedInputResultOutcome.ok) return Result.err(decodedInputResultOutcome.error);
    const result = this.validateHistoryNavigationResult(
      input.requestedAction,
      decodedInputResultOutcome.value,
      input.commandId,
      null,
    );
    const resultOutcome = sqliteCaptureOutcome(result);
    if (!resultOutcome.ok) return Result.err(resultOutcome.error);
    if (resultOutcome.value.status !== "empty") {
      return Result.err(
        rejectMiniLilacStoreOperation(
          "commitEmptyHistoryNavigation",
          "Empty history navigation must persist an empty result",
        ),
      );
    }
    const emptyResult = resultOutcome.value;
    const canonicalCommand = decodeCanonicalStoredCommandRequest(input.request);
    const canonicalCommandOutcome = sqliteCaptureOutcome(canonicalCommand);
    if (!canonicalCommandOutcome.ok) return Result.err(canonicalCommandOutcome.error);
    return this.runStoreTransactionResult("commitEmptyHistoryNavigation", () => {
      const command = this.getStoredCommandResult(input.sessionId, input.commandId);
      const commandOutcome = sqliteCaptureOutcome(command);
      if (!commandOutcome.ok) return Result.err(commandOutcome.error);
      if (
        commandOutcome.value.kind !== input.requestedAction ||
        commandOutcome.value.run_id !== null ||
        commandOutcome.value.request_fingerprint !== canonicalCommandOutcome.value.fingerprint ||
        commandOutcome.value.request_json !== canonicalCommandOutcome.value.json
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitEmptyHistoryNavigation",
            `Command '${input.commandId}' does not own this history navigation`,
          ),
        );
      }
      if (commandOutcome.value.result_json !== null) {
        const decodedResult = decodeMiniLilacSuperJsonPayload({
          raw: commandOutcome.value.result_json,
          schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
          recordId: input.commandId,
          field: "command_result",
        });
        const decodedResultOutcome = sqliteCaptureOutcome(decodedResult);
        if (!decodedResultOutcome.ok) return Result.err(decodedResultOutcome.error);
        const decodedReplay = decodeStoredHistoryNavigationResult(decodedResultOutcome.value.value);
        const decodedReplayOutcome = sqliteCaptureOutcome(decodedReplay);
        if (!decodedReplayOutcome.ok) return Result.err(decodedReplayOutcome.error);
        const replayed = this.validateHistoryNavigationResult(
          input.requestedAction,
          decodedReplayOutcome.value,
          input.commandId,
          null,
        );
        const replayedOutcome = sqliteCaptureOutcome(replayed);
        if (!replayedOutcome.ok) return Result.err(replayedOutcome.error);
        if (replayedOutcome.value.status !== "empty") {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "commitEmptyHistoryNavigation",
              `Command '${input.commandId}' already has a non-empty result`,
            ),
          );
        }
        const navigation = this.getHistoryNavigationResult(input.sessionId);
        const navigationOutcome = sqliteCaptureOutcome(navigation);
        if (!navigationOutcome.ok) return Result.err(navigationOutcome.error);
        return Result.ok({
          result: replayedOutcome.value,
          replayed: true,
          navigation: navigationOutcome.value,
        });
      }
      if (commandOutcome.value.side_effect_started !== 0) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitEmptyHistoryNavigation",
            `Command '${input.commandId}' has an incomplete history side effect`,
          ),
        );
      }
      const history = this.getSessionHistoryResult(input.sessionId);
      const historyOutcome = sqliteCaptureOutcome(history);
      if (!historyOutcome.ok) return Result.err(historyOutcome.error);
      const quiescent = this.requireQuiescentHistorySessionResult(
        input.sessionId,
        historyOutcome.value.currentStateId,
      );
      const quiescenceError = quiescent.match({ ok: () => null, err: (error) => error });
      if (quiescenceError !== null) return Result.err(quiescenceError);
      const workspace = this.getWorkspaceForSessionResult(input.sessionId);
      const workspaceOutcome = sqliteCaptureOutcome(workspace);
      if (!workspaceOutcome.ok) return Result.err(workspaceOutcome.error);
      const available = this.assertWorkspaceHasNoHistoryJournalResult(workspaceOutcome.value.id);
      const availabilityError = available.match({ ok: () => null, err: (error) => error });
      if (availabilityError !== null) return Result.err(availabilityError);
      const target =
        input.requestedAction === "undo"
          ? this.findLatestUndoableUserTransitionResult(input.sessionId)
          : this.peekHistoryRedoResult(input.sessionId);
      const targetOutcome = sqliteCaptureOutcome(target);
      if (!targetOutcome.ok) return Result.err(targetOutcome.error);
      const hasTarget = targetOutcome.value !== null;
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
      const navigationOutcome = sqliteCaptureOutcome(navigation);
      if (!navigationOutcome.ok) return Result.err(navigationOutcome.error);
      return Result.ok({
        result: emptyResult,
        replayed: false,
        navigation: navigationOutcome.value,
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
      const workspaceOutcome = sqliteCaptureOutcome(workspace);
      if (!workspaceOutcome.ok) return Result.err(workspaceOutcome.error);
      const available = this.assertWorkspaceHasNoHistoryJournalResult(workspaceOutcome.value.id);
      const availabilityError = available.match({ ok: () => null, err: (error) => error });
      if (availabilityError !== null) return Result.err(availabilityError);
      const command = this.getStoredCommandResult(input.sessionId, input.commandId);
      const commandOutcome = sqliteCaptureOutcome(command);
      if (!commandOutcome.ok) return Result.err(commandOutcome.error);
      if (
        commandOutcome.value.kind !== input.requestedAction ||
        commandOutcome.value.run_id !== null ||
        commandOutcome.value.result_json !== null ||
        commandOutcome.value.side_effect_started !== 0
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "reserveHistoryOperation",
            `Command '${input.commandId}' cannot reserve a history operation`,
          ),
        );
      }
      const source = this.getCurrentHistoryStateResult(input.sessionId);
      const sourceOutcome = sqliteCaptureOutcome(source);
      if (!sourceOutcome.ok) return Result.err(sourceOutcome.error);
      const transition = this.getHistoryTransitionResult(input.userTransitionId);
      const transitionOutcome = sqliteCaptureOutcome(transition);
      if (!transitionOutcome.ok) return Result.err(transitionOutcome.error);
      if (
        transitionOutcome.value.sessionId !== input.sessionId ||
        transitionOutcome.value.kind !== "user-message" ||
        transitionOutcome.value.toStateId === null
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
          sourceOutcome.value,
          {
            modelHeadId: sourceOutcome.value.modelHeadId,
            uiHeadId: sourceOutcome.value.uiHeadId,
          },
          input.observation,
        );
        const observedOutcome = sqliteCaptureOutcome(observed);
        if (!observedOutcome.ok) return Result.err(observedOutcome.error);
        observedState = observedOutcome.value;
      }
      if (
        input.requestedAction === "undo" &&
        transitionOutcome.value.fromStateId !== input.targetStateId
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
        const undoableOutcome = sqliteCaptureOutcome(undoable);
        if (!undoableOutcome.ok) return Result.err(undoableOutcome.error);
        if (undoableOutcome.value?.id !== input.userTransitionId) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "reserveHistoryOperation",
              "Undo history operation must use the latest transition above the undo floor",
            ),
          );
        }
      }
      const redo = this.peekHistoryRedoResult(input.sessionId);
      const redoOutcome = sqliteCaptureOutcome(redo);
      if (!redoOutcome.ok) return Result.err(redoOutcome.error);
      if (
        input.requestedAction === "redo" &&
        (redoOutcome.value?.targetStateId !== input.targetStateId ||
          redoOutcome.value.userTransitionId !== input.userTransitionId)
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
        transitionOutcome.value.toStateId !== null &&
        !this.isStateInAncestry(
          input.sessionId,
          input.targetStateId,
          transitionOutcome.value.toStateId,
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
          workspaceOutcome.value.id,
          input.commandId,
          input.requestedAction,
          sourceOutcome.value.id,
          observedState?.id ?? null,
          input.targetStateId,
          input.userTransitionId,
          input.filesystemMode,
          input.skipReason,
          now,
          now,
        );
      const operation = this.getHistoryOperationResult(input.id);
      const operationOutcome = sqliteCaptureOutcome(operation);
      if (!operationOutcome.ok) return Result.err(operationOutcome.error);
      if (operationOutcome.value === null) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "reserveHistoryOperation",
            `History operation '${input.id}' was not created`,
          ),
        );
      }
      return Result.ok({ operation: operationOutcome.value, observedState });
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
        const operationOutcome = sqliteCaptureOutcome(operation);
        if (!operationOutcome.ok) return Result.err(operationOutcome.error);
        if (operationOutcome.value === null) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "skipPreparedHistoryRestore",
              `History operation '${operationId}' was not found`,
            ),
          );
        }
        if (
          operationOutcome.value.filesystemMode !== "restore" ||
          operationOutcome.value.phase !== "prepared"
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
        const skippedOutcome = sqliteCaptureOutcome(skipped);
        if (!skippedOutcome.ok) return Result.err(skippedOutcome.error);
        if (skippedOutcome.value === null) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "skipPreparedHistoryRestore",
              `History operation '${operationId}' disappeared`,
            ),
          );
        }
        return Result.ok(skippedOutcome.value);
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
        const operationOutcome = sqliteCaptureOutcome(operation);
        if (!operationOutcome.ok) return Result.err(operationOutcome.error);
        if (operationOutcome.value === null) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "updateHistoryOperationPhase",
              `History operation '${operationId}' was not found`,
            ),
          );
        }
        const allowed =
          operationOutcome.value.phase === phase ||
          (operationOutcome.value.filesystemMode === "restore" &&
            ((operationOutcome.value.phase === "prepared" && phase === "restoring") ||
              (operationOutcome.value.phase === "restoring" && phase === "verified"))) ||
          (operationOutcome.value.filesystemMode === "skip" &&
            operationOutcome.value.phase === "prepared" &&
            phase === "verified");
        if (!allowed) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "updateHistoryOperationPhase",
              `History operation '${operationId}' cannot move from '${operationOutcome.value.phase}' to '${phase}'`,
            ),
          );
        }
        this.database
          .query("UPDATE history_operations SET phase = ?, updated_at = ? WHERE id = ?")
          .run(phase, new Date().toISOString(), operationId);
        const updated = this.getHistoryOperationResult(operationId);
        const updatedOutcome = sqliteCaptureOutcome(updated);
        if (!updatedOutcome.ok) return Result.err(updatedOutcome.error);
        if (updatedOutcome.value === null) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "updateHistoryOperationPhase",
              `History operation '${operationId}' was not found`,
            ),
          );
        }
        return Result.ok(updatedOutcome.value);
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
      const operationOutcome = sqliteCaptureOutcome(operation);
      if (!operationOutcome.ok) return Result.err(operationOutcome.error);
      if (operationOutcome.value === null) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitHistoryNavigation",
            `History operation '${input.operationId}' was not found`,
          ),
        );
      }
      if (
        (operationOutcome.value.filesystemMode === "restore" &&
          operationOutcome.value.phase !== "verified") ||
        (operationOutcome.value.filesystemMode === "skip" &&
          !["prepared", "verified"].includes(operationOutcome.value.phase))
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitHistoryNavigation",
            `History operation '${input.operationId}' is not ready to commit`,
          ),
        );
      }
      const available = this.assertWorkspaceHistoryAvailableForOwnerResult(
        operationOutcome.value.workspaceId,
        operationOutcome.value.sessionId,
        { kind: "history-operation", operationId: operationOutcome.value.id },
      );
      const availabilityError = available.match({ ok: () => null, err: (error) => error });
      if (availabilityError !== null) return Result.err(availabilityError);
      const quiescent = this.requireQuiescentHistorySessionResult(
        operationOutcome.value.sessionId,
        operationOutcome.value.sourceStateId,
      );
      const quiescenceError = quiescent.match({ ok: () => null, err: (error) => error });
      if (quiescenceError !== null) return Result.err(quiescenceError);
      const source = this.getHistoryStateResult(operationOutcome.value.sourceStateId);
      const sourceOutcome = sqliteCaptureOutcome(source);
      if (!sourceOutcome.ok) return Result.err(sourceOutcome.error);
      const target = this.getHistoryStateResult(operationOutcome.value.targetStateId);
      const targetOutcome = sqliteCaptureOutcome(target);
      if (!targetOutcome.ok) return Result.err(targetOutcome.error);
      const transition = this.getHistoryTransitionResult(operationOutcome.value.userTransitionId);
      const transitionOutcome = sqliteCaptureOutcome(transition);
      if (!transitionOutcome.ok) return Result.err(transitionOutcome.error);
      if (
        sourceOutcome.value.sessionId !== operationOutcome.value.sessionId ||
        targetOutcome.value.sessionId !== operationOutcome.value.sessionId ||
        transitionOutcome.value.sessionId !== operationOutcome.value.sessionId ||
        transitionOutcome.value.kind !== "user-message" ||
        transitionOutcome.value.toStateId === null
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitHistoryNavigation",
            `History operation '${input.operationId}' has incoherent ownership`,
          ),
        );
      }
      const decodedInputResult = decodeStoredHistoryNavigationResult(input.result);
      const decodedInputResultOutcome = sqliteCaptureOutcome(decodedInputResult);
      if (!decodedInputResultOutcome.ok) return Result.err(decodedInputResultOutcome.error);
      const result = this.validateHistoryNavigationResult(
        operationOutcome.value.requestedAction,
        decodedInputResultOutcome.value,
        operationOutcome.value.commandId,
        transitionOutcome.value.userMessage,
      );
      const resultOutcome = sqliteCaptureOutcome(result);
      if (!resultOutcome.ok) return Result.err(resultOutcome.error);
      const expectedStatus =
        operationOutcome.value.requestedAction === "undo" ? "undone" : "redone";
      if (resultOutcome.value.status === "empty" || resultOutcome.value.status !== expectedStatus) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitHistoryNavigation",
            `History operation '${input.operationId}' requires a '${expectedStatus}' result`,
          ),
        );
      }
      if (resultOutcome.value.historyStateId !== operationOutcome.value.targetStateId) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitHistoryNavigation",
            `History operation '${input.operationId}' result names the wrong state`,
          ),
        );
      }
      let expectedFilesystem: MiniLilacHistoryFilesystemResult;
      if (operationOutcome.value.filesystemMode === "restore") {
        expectedFilesystem = { status: "restored" };
      } else {
        if (operationOutcome.value.skipReason === null) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "commitHistoryNavigation",
              `History operation '${input.operationId}' has no filesystem skip reason`,
            ),
          );
        }
        expectedFilesystem = {
          status: "skipped",
          reason: operationOutcome.value.skipReason,
        };
      }
      if (!canonicalValuesEqual(resultOutcome.value.filesystem, expectedFilesystem)) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitHistoryNavigation",
            `History operation '${input.operationId}' result has the wrong filesystem outcome`,
          ),
        );
      }
      let redoTarget = sourceOutcome.value;
      if (operationOutcome.value.observedSourceStateId !== null) {
        const observed = this.getHistoryStateResult(operationOutcome.value.observedSourceStateId);
        const observedOutcome = sqliteCaptureOutcome(observed);
        if (!observedOutcome.ok) return Result.err(observedOutcome.error);
        const incoming = this.getIncomingHistoryTransitionResult(
          operationOutcome.value.sessionId,
          operationOutcome.value.observedSourceStateId,
        );
        const incomingOutcome = sqliteCaptureOutcome(incoming);
        if (!incomingOutcome.ok) return Result.err(incomingOutcome.error);
        if (
          observedOutcome.value.modelHeadId !== sourceOutcome.value.modelHeadId ||
          observedOutcome.value.uiHeadId !== sourceOutcome.value.uiHeadId ||
          incomingOutcome.value?.kind !== "workspace-observation" ||
          incomingOutcome.value.fromStateId !== sourceOutcome.value.id
        ) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "commitHistoryNavigation",
              `History operation '${input.operationId}' has an invalid observation`,
            ),
          );
        }
        redoTarget = observedOutcome.value;
      }
      if (operationOutcome.value.requestedAction === "undo") {
        const undoable = this.findLatestUndoableUserTransitionResult(
          operationOutcome.value.sessionId,
        );
        const undoableOutcome = sqliteCaptureOutcome(undoable);
        if (!undoableOutcome.ok) return Result.err(undoableOutcome.error);
        if (
          transitionOutcome.value.fromStateId !== targetOutcome.value.id ||
          undoableOutcome.value?.id !== transitionOutcome.value.id ||
          !this.isStateInAncestry(
            operationOutcome.value.sessionId,
            redoTarget.id,
            transitionOutcome.value.toStateId,
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
          operationOutcome.value.sessionId,
          redoTarget.id,
          transitionOutcome.value.id,
        );
        const pushError = pushed.match({ ok: () => null, err: (error) => error });
        if (pushError !== null) return Result.err(pushError);
      } else {
        const redo = this.peekHistoryRedoResult(operationOutcome.value.sessionId);
        const redoOutcome = sqliteCaptureOutcome(redo);
        if (!redoOutcome.ok) return Result.err(redoOutcome.error);
        if (
          redoOutcome.value?.targetStateId !== targetOutcome.value.id ||
          redoOutcome.value.userTransitionId !== transitionOutcome.value.id ||
          !this.isStateInAncestry(
            operationOutcome.value.sessionId,
            targetOutcome.value.id,
            transitionOutcome.value.toStateId,
          )
        ) {
          return Result.err(
            rejectMiniLilacStoreOperation(
              "commitHistoryNavigation",
              `History operation '${input.operationId}' no longer matches redo topology`,
            ),
          );
        }
        const popped = this.popHistoryRedoResult(operationOutcome.value.sessionId);
        const popError = popped.match({ ok: () => null, err: (error) => error });
        if (popError !== null) return Result.err(popError);
      }
      const moved = this.moveHistoryCursorResult(
        operationOutcome.value.sessionId,
        targetOutcome.value,
      );
      const moveError = moved.match({ ok: () => null, err: (error) => error });
      if (moveError !== null) return Result.err(moveError);
      const saved = this.saveHistoryCommandResultResult(
        operationOutcome.value,
        resultOutcome.value,
      );
      const saveError = saved.match({ ok: () => null, err: (error) => error });
      if (saveError !== null) return Result.err(saveError);
      const deleted = this.deleteHistoryOperationRowResult(operationOutcome.value.id);
      const deletionError = deleted.match({ ok: () => null, err: (error) => error });
      if (deletionError !== null) return Result.err(deletionError);
      const navigation = this.getHistoryNavigationResult(operationOutcome.value.sessionId);
      const navigationOutcome = sqliteCaptureOutcome(navigation);
      if (!navigationOutcome.ok) return Result.err(navigationOutcome.error);
      return Result.ok({
        operation: operationOutcome.value,
        currentState: targetOutcome.value,
        navigation: navigationOutcome.value,
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
      const operationOutcome = sqliteCaptureOutcome(operation);
      if (!operationOutcome.ok) return Result.err(operationOutcome.error);
      if (operationOutcome.value === null) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "abandonHistoryNavigation",
            `History operation '${input.operationId}' was not found`,
          ),
        );
      }
      const quiescent = this.requireQuiescentHistorySessionResult(
        operationOutcome.value.sessionId,
        operationOutcome.value.sourceStateId,
      );
      const quiescenceError = quiescent.match({ ok: () => null, err: (error) => error });
      if (quiescenceError !== null) return Result.err(quiescenceError);
      const source = this.getHistoryStateResult(operationOutcome.value.sourceStateId);
      const sourceOutcome = sqliteCaptureOutcome(source);
      if (!sourceOutcome.ok) return Result.err(sourceOutcome.error);
      if (operationOutcome.value.observedSourceStateId !== null) {
        const observed = this.getHistoryStateResult(operationOutcome.value.observedSourceStateId);
        const observedOutcome = sqliteCaptureOutcome(observed);
        if (!observedOutcome.ok) return Result.err(observedOutcome.error);
        const incoming = this.getIncomingHistoryTransitionResult(
          operationOutcome.value.sessionId,
          operationOutcome.value.observedSourceStateId,
        );
        const incomingOutcome = sqliteCaptureOutcome(incoming);
        if (!incomingOutcome.ok) return Result.err(incomingOutcome.error);
        if (
          observedOutcome.value.modelHeadId !== sourceOutcome.value.modelHeadId ||
          observedOutcome.value.uiHeadId !== sourceOutcome.value.uiHeadId ||
          incomingOutcome.value?.kind !== "workspace-observation" ||
          incomingOutcome.value.fromStateId !== sourceOutcome.value.id
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
        commandId: operationOutcome.value.commandId,
        message: input.message,
      };
      const saved = this.saveHistoryCommandResultResult(operationOutcome.value, error);
      const saveError = saved.match({ ok: () => null, err: (error) => error });
      if (saveError !== null) return Result.err(saveError);
      const deleted = this.deleteHistoryOperationRowResult(operationOutcome.value.id);
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
    const terminalResultOutcome = sqliteCaptureOutcome(terminalResult);
    if (!terminalResultOutcome.ok) return Result.err(terminalResultOutcome.error);
    const serializedPromotion =
      promotion === null
        ? Result.ok<string | null>(null)
        : serializeStoreValueResult(promotion, "reservePendingRunFinalization.promotion");
    const serializedPromotionOutcome = sqliteCaptureOutcome(serializedPromotion);
    if (!serializedPromotionOutcome.ok) return Result.err(serializedPromotionOutcome.error);
    const serializedNamedPromotion =
      namedPromotion === null
        ? Result.ok<string | null>(null)
        : serializeStoreValueResult(namedPromotion, "reservePendingRunFinalization.namedPromotion");
    const serializedNamedPromotionOutcome = sqliteCaptureOutcome(serializedNamedPromotion);
    if (!serializedNamedPromotionOutcome.ok) {
      return Result.err(serializedNamedPromotionOutcome.error);
    }
    return this.runStoreTransactionResult<
      PendingStoredRunFinalization,
      MiniLilacStoreOperationError
    >("reservePendingRunFinalization", () => {
      const workspace = this.getWorkspaceForSessionResult(input.sessionId);
      const workspaceOutcome = sqliteCaptureOutcome(workspace);
      if (!workspaceOutcome.ok) return Result.err(workspaceOutcome.error);
      if (
        this.database
          .query("SELECT 1 FROM history_operations WHERE workspace_id = ?")
          .get(workspaceOutcome.value.id)
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "reservePendingRunFinalization",
            `Workspace '${workspaceOutcome.value.id}' has a retained history operation`,
          ),
        );
      }
      if (
        this.database
          .query("SELECT 1 FROM pending_run_finalizations WHERE workspace_id = ?")
          .get(workspaceOutcome.value.id)
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "reservePendingRunFinalization",
            `Workspace '${workspaceOutcome.value.id}' already has a pending run finalization`,
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
      const activeRunOutcome = sqliteCaptureOutcome(activeRun);
      if (!activeRunOutcome.ok) return Result.err(activeRunOutcome.error);
      const session = this.getSessionResult(input.sessionId);
      const sessionOutcome = sqliteCaptureOutcome(session);
      if (!sessionOutcome.ok) return Result.err(sessionOutcome.error);
      const transition = this.getHistoryTransitionResult(input.openTransitionId);
      const transitionOutcome = sqliteCaptureOutcome(transition);
      if (!transitionOutcome.ok) return Result.err(transitionOutcome.error);
      const history = this.getSessionHistoryResult(input.sessionId);
      const historyOutcome = sqliteCaptureOutcome(history);
      if (!historyOutcome.ok) return Result.err(historyOutcome.error);
      if (
        !["streaming", "cancelling"].includes(sessionOutcome.value.status) ||
        activeRunOutcome.value?.id !== input.runId ||
        transitionOutcome.value.sessionId !== input.sessionId ||
        transitionOutcome.value.kind !== "user-message" ||
        transitionOutcome.value.toStateId !== null ||
        transitionOutcome.value.rootRunId !== input.runId ||
        historyOutcome.value.currentStateId !== transitionOutcome.value.fromStateId
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "reservePendingRunFinalization",
            `Pending finalization for run '${input.runId}' is not coherent`,
          ),
        );
      }
      const canonicalUiMessages = this.getUiMessagesResult(input.sessionId);
      const canonicalUiMessagesOutcome = sqliteCaptureOutcome(canonicalUiMessages);
      if (!canonicalUiMessagesOutcome.ok) return Result.err(canonicalUiMessagesOutcome.error);
      // Automatic in-run compaction can replace the complete model chain and
      // currently has no persisted rewrite provenance. UI continuity plus the
      // open transition identifies the turn.
      if (!isCanonicalPrefix(canonicalUiMessagesOutcome.value, input.uiMessages)) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "reservePendingRunFinalization",
            "Final UI transcript does not extend the canonical active transcript",
          ),
        );
      }
      const fromState = this.getHistoryStateResult(transitionOutcome.value.fromStateId);
      const fromStateOutcome = sqliteCaptureOutcome(fromState);
      if (!fromStateOutcome.ok) return Result.err(fromStateOutcome.error);
      const rawFromUiMessages = this.readSerializedChainResult(
        input.sessionId,
        "ui",
        fromStateOutcome.value.uiHeadId,
      );
      const rawFromUiMessagesOutcome = sqliteCaptureOutcome(rawFromUiMessages);
      if (!rawFromUiMessagesOutcome.ok) return Result.err(rawFromUiMessagesOutcome.error);
      const decodedFromUiMessages = decodeMiniLilacUiTranscript({
        rawValues: rawFromUiMessagesOutcome.value,
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: fromStateOutcome.value.id,
      });
      const decodedFromUiMessagesOutcome = sqliteCaptureOutcome(decodedFromUiMessages);
      if (!decodedFromUiMessagesOutcome.ok) return Result.err(decodedFromUiMessagesOutcome.error);
      const fromUiMessages = decodedFromUiMessagesOutcome.value.value;
      const admittedMessage = transitionOutcome.value.userMessage;
      if (
        admittedMessage === null ||
        !canonicalValuesEqual(
          canonicalUiMessagesOutcome.value[fromUiMessages.length],
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
          workspaceOutcome.value.id,
          input.openTransitionId,
          modelHeadId,
          uiHeadId,
          runStatus,
          sessionStatus,
          input.error,
          terminalResultOutcome.value,
          input.inputTokens,
          providerState?.lastFamily ?? null,
          storedProviderStateFlag(providerState),
          serializedPromotionOutcome.value,
          serializedNamedPromotionOutcome.value,
          now,
        );
      const pending = this.getPendingRunFinalizationResult(input.runId);
      const pendingOutcome = sqliteCaptureOutcome(pending);
      if (!pendingOutcome.ok) return Result.err(pendingOutcome.error);
      if (pendingOutcome.value === null) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "reservePendingRunFinalization",
            `Pending finalization for run '${input.runId}' was not created`,
          ),
        );
      }
      return Result.ok(pendingOutcome.value);
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
      const interruptedAttemptsOutcome = sqliteCaptureOutcome(interruptedAttempts);
      if (!interruptedAttemptsOutcome.ok) return Result.err(interruptedAttemptsOutcome.error);
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
      const ownersOutcome = sqliteCaptureOutcome(owners);
      if (!ownersOutcome.ok) return Result.err(ownersOutcome.error);
      for (const owner of ownersOutcome.value.value) {
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
      const namedOwnersOutcome = sqliteCaptureOutcome(namedOwners);
      if (!namedOwnersOutcome.ok) return Result.err(namedOwnersOutcome.error);
      for (const owner of namedOwnersOutcome.value.value) {
        this.pruneMiniNamedClaudeAttempts(owner.session_id, owner.provider_id);
      }
      const diagnostics = this.getMiniClaudeRetentionDiagnosticsResult();
      const diagnosticsOutcome = sqliteCaptureOutcome(diagnostics);
      if (!diagnosticsOutcome.ok) return Result.err(diagnosticsOutcome.error);
      return Result.ok({
        interruptedAttempts: interruptedAttemptsOutcome.value.value,
        diagnostics: diagnosticsOutcome.value,
      });
    });
    const recoveryOutcome = sqliteCaptureOutcome(recovery);
    if (!recoveryOutcome.ok) return Result.err(recoveryOutcome.error);
    for (const attempt of recoveryOutcome.value.interruptedAttempts) {
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
      recoveryOutcome.value.diagnostics.orphanBindingCount > 0 ||
      recoveryOutcome.value.diagnostics.orphanAttemptCount > 0
    ) {
      logger.warn("mini_claude.retention_orphans_detected", recoveryOutcome.value.diagnostics);
    } else {
      logger.debug("mini_claude.retention_diagnostics", recoveryOutcome.value.diagnostics);
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
      const pendingOutcome = sqliteCaptureOutcome(pending);
      if (!pendingOutcome.ok) return Result.err(pendingOutcome.error);
      if (pendingOutcome.value === null) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitPendingRunFinalization",
            `Pending finalization for run '${input.runId}' was not found`,
          ),
        );
      }
      if (
        requestedProviderState !== null &&
        pendingOutcome.value.providerState !== null &&
        !canonicalValuesEqual(requestedProviderState, pendingOutcome.value.providerState)
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
        pendingOutcome.value.claudeBindingPromotion !== null &&
        !canonicalValuesEqual(requestedPromotion, pendingOutcome.value.claudeBindingPromotion)
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
        pendingOutcome.value.namedClaudeBindingPromotion !== null &&
        !canonicalValuesEqual(
          requestedNamedPromotion,
          pendingOutcome.value.namedClaudeBindingPromotion,
        )
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitPendingRunFinalization",
            "Pending finalization named Claude promotion metadata changed before commit",
          ),
        );
      }
      const providerState = requestedProviderState ?? pendingOutcome.value.providerState;
      const promotion = requestedPromotion ?? pendingOutcome.value.claudeBindingPromotion;
      const namedPromotion =
        requestedNamedPromotion ?? pendingOutcome.value.namedClaudeBindingPromotion;
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
        pendingOutcome.value.workspaceId,
        pendingOutcome.value.sessionId,
        { kind: "pending-run-finalization", runId: pendingOutcome.value.runId },
      );
      const availabilityError = available.match({ ok: () => null, err: (error) => error });
      if (availabilityError !== null) return Result.err(availabilityError);
      const activeRun = this.getActiveRootRun(pendingOutcome.value.sessionId);
      const transition = this.getHistoryTransitionResult(pendingOutcome.value.openTransitionId);
      const transitionOutcome = sqliteCaptureOutcome(transition);
      if (!transitionOutcome.ok) return Result.err(transitionOutcome.error);
      const history = this.getSessionHistoryResult(pendingOutcome.value.sessionId);
      const historyOutcome = sqliteCaptureOutcome(history);
      if (!historyOutcome.ok) return Result.err(historyOutcome.error);
      if (
        activeRun?.id !== pendingOutcome.value.runId ||
        transitionOutcome.value.sessionId !== pendingOutcome.value.sessionId ||
        transitionOutcome.value.kind !== "user-message" ||
        transitionOutcome.value.toStateId !== null ||
        transitionOutcome.value.rootRunId !== pendingOutcome.value.runId ||
        historyOutcome.value.currentStateId !== transitionOutcome.value.fromStateId
      ) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitPendingRunFinalization",
            `Pending finalization for run '${pendingOutcome.value.runId}' is no longer coherent`,
          ),
        );
      }
      if (providerState !== null) {
        const conservative = this.assertConservativeProviderTransitionResult(
          transitionOutcome.value.fromStateId,
          providerState,
        );
        const transitionError = conservative.match({ ok: () => null, err: (error) => error });
        if (transitionError !== null) return Result.err(transitionError);
      }
      const destination: CreateStoredHistoryState = {
        id: input.destinationStateId,
        sessionId: pendingOutcome.value.sessionId,
        workspaceId: pendingOutcome.value.workspaceId,
        modelHeadId: pendingOutcome.value.modelHeadId,
        uiHeadId: pendingOutcome.value.uiHeadId,
        workspaceSnapshotId: input.workspaceSnapshotId,
        workspaceStatus: input.workspaceStatus,
        workspaceUnavailableReason: input.workspaceUnavailableReason,
        origin: "turn-boundary",
        providerState,
      };
      const closed = this.closeHistoryTransitionResult(
        pendingOutcome.value.openTransitionId,
        destination,
        {
          select: true,
        },
      );
      const closeError = closed.match({ ok: () => null, err: (error) => error });
      if (closeError !== null) return Result.err(closeError);
      const terminalResult = serializeOptionalTerminalResult(
        pendingOutcome.value,
        "commitPendingRunFinalization",
      );
      const terminalResultOutcome = sqliteCaptureOutcome(terminalResult);
      if (!terminalResultOutcome.ok) return Result.err(terminalResultOutcome.error);
      const now = new Date().toISOString();
      const finished = this.database
        .query(
          `UPDATE runs SET status = ?, error = ?, terminal_result_json = ?, finished_at = ?
           WHERE id = ? AND session_id = ? AND parent_run_id IS NULL AND status = 'active'`,
        )
        .run(
          pendingOutcome.value.runStatus,
          pendingOutcome.value.error,
          terminalResultOutcome.value,
          now,
          pendingOutcome.value.runId,
          pendingOutcome.value.sessionId,
        );
      if (finished.changes !== 1) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitPendingRunFinalization",
            `Run '${pendingOutcome.value.runId}' is not active`,
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
          pendingOutcome.value.sessionStatus,
          pendingOutcome.value.inputTokens,
          now,
          pendingOutcome.value.sessionId,
          pendingOutcome.value.runId,
        );
      if (updated.changes !== 1) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "commitPendingRunFinalization",
            `Run '${pendingOutcome.value.runId}' is not active for session '${pendingOutcome.value.sessionId}'`,
          ),
        );
      }
      let bindingPromotion: CommittedPendingStoredRunFinalization["bindingPromotion"] =
        "not-requested";
      if (promotion !== null) {
        const promoted = this.promoteMiniMainClaudeBinding(
          pendingOutcome.value,
          this.getRootPromptSourceStateId(pendingOutcome.value),
          destination.id,
          promotion,
        );
        bindingPromotion = promoted ? "promoted" : "cas-failed";
      } else if (namedPromotion !== null) {
        const promoted = this.promoteMiniNamedClaudeBinding(
          pendingOutcome.value,
          this.getRootPromptSourceStateId(pendingOutcome.value),
          destination.id,
          namedPromotion,
        );
        bindingPromotion = promoted ? "promoted" : "cas-failed";
      }
      const deleted = this.deletePendingRunFinalizationRowResult(pendingOutcome.value.runId);
      const deletionError = deleted.match({ ok: () => null, err: (error) => error });
      if (deletionError !== null) return Result.err(deletionError);
      const state = this.getHistoryStateResult(destination.id);
      const stateOutcome = sqliteCaptureOutcome(state);
      if (!stateOutcome.ok) return Result.err(stateOutcome.error);
      const snapshot = this.getSessionResult(pendingOutcome.value.sessionId);
      const snapshotOutcome = sqliteCaptureOutcome(snapshot);
      if (!snapshotOutcome.ok) return Result.err(snapshotOutcome.error);
      return Result.ok({
        pending: pendingOutcome.value,
        state: stateOutcome.value,
        snapshot: snapshotOutcome.value,
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
    const sourceOutcome = sqliteCaptureOutcome(source);
    if (!sourceOutcome.ok) return Result.err(sourceOutcome.error);
    const sourceMessageCount = this.getHistoryStateCanonicalMessageCount(sourceStateId);
    const requiresMixedHistory =
      sourceOutcome.value.providerState?.containsCrossFamilyTurns === true ||
      (sourceOutcome.value.providerState === null && sourceMessageCount > 0) ||
      (sourceOutcome.value.providerState !== null &&
        sourceOutcome.value.providerState.lastFamily !== destination.lastFamily);
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
    const sessionOutcome = sqliteCaptureOutcome(session);
    if (!sessionOutcome.ok) return Result.err(sessionOutcome.error);
    const activeRunCount = decodeRequiredMiniLilacStoreRow({
      kind: "count",
      row: this.database
        .query("SELECT COUNT(*) AS count FROM runs WHERE session_id = ? AND status = 'active'")
        .get(sessionId),
      schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
      recordId: `${sessionId}:active-run-count`,
    });
    const activeRunCountOutcome = sqliteCaptureOutcome(activeRunCount);
    if (!activeRunCountOutcome.ok) return Result.err(activeRunCountOutcome.error);
    if (
      !allowedStatuses.includes(sessionOutcome.value.status) ||
      sessionOutcome.value.activeRunId !== null ||
      activeRunCountOutcome.value.count !== 0
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
    const currentOutcome = sqliteCaptureOutcome(current);
    if (!currentOutcome.ok) return Result.err(currentOutcome.error);
    if (currentOutcome.value.id !== expectedCurrentStateId) {
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
      currentOutcome.value,
    );
    const headsError = equalHeads.match({ ok: () => null, err: (error) => error });
    if (headsError !== null) return Result.err(headsError);
    return Result.ok(sessionOutcome.value);
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
    const decodedWorkspaceOutcome = sqliteCaptureOutcome(decodedWorkspace);
    if (!decodedWorkspaceOutcome.ok) return Result.err(decodedWorkspaceOutcome.error);
    if (decodedWorkspaceOutcome.value.healthStatus !== "healthy") {
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
    const operationsOutcome = sqliteCaptureOutcome(operations);
    if (!operationsOutcome.ok) return Result.err(operationsOutcome.error);
    const ownsOperations =
      owner?.kind === "history-operation" &&
      operationsOutcome.value.value.length === 1 &&
      operationsOutcome.value.value[0]?.id === owner.operationId &&
      operationsOutcome.value.value[0].session_id === sessionId;
    if (operationsOutcome.value.value.length > 0 && !ownsOperations) {
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
    const finalizationsOutcome = sqliteCaptureOutcome(finalizations);
    if (!finalizationsOutcome.ok) return Result.err(finalizationsOutcome.error);
    const ownsFinalization =
      owner?.kind === "pending-run-finalization" &&
      finalizationsOutcome.value.value.length === 1 &&
      finalizationsOutcome.value.value[0]?.run_id === owner.runId &&
      finalizationsOutcome.value.value[0].session_id === sessionId;
    if (finalizationsOutcome.value.value.length > 0 && !ownsFinalization) {
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
    const fromOutcome = sqliteCaptureOutcome(from);
    if (!fromOutcome.ok) return Result.err(fromOutcome.error);
    if (fromOutcome.value.sessionId !== input.sessionId) {
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
      const historyOutcome = sqliteCaptureOutcome(history);
      if (!historyOutcome.ok) return Result.err(historyOutcome.error);
      if (historyOutcome.value.currentStateId !== input.fromStateId) {
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
      const rootRunOutcome = sqliteCaptureOutcome(rootRun);
      if (!rootRunOutcome.ok) return Result.err(rootRunOutcome.error);
      if (rootRunOutcome.value.parent_run_id !== null) {
        return Result.err(
          rejectMiniLilacStoreOperation(
            "insertHistoryTransitionRow",
            `History transition '${input.id}' must reference a root run`,
          ),
        );
      }
      const command = this.getStoredCommandResult(input.sessionId, input.commandId);
      const commandOutcome = sqliteCaptureOutcome(command);
      if (!commandOutcome.ok) return Result.err(commandOutcome.error);
      if (
        commandOutcome.value.kind !== input.delivery ||
        commandOutcome.value.run_id !== rootRunId ||
        commandOutcome.value.side_effect_started !== 1 ||
        commandOutcome.value.result_json === null
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
    const destinationOutcome = sqliteCaptureOutcome(destination);
    if (!destinationOutcome.ok) return Result.err(destinationOutcome.error);
    if (destinationOutcome.value.sessionId !== sessionId) {
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
    if (destinationOutcome.value.origin !== expectedOrigin[kind]) {
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
    const transcriptOutcome = sqliteCaptureOutcome(transcript);
    if (!transcriptOutcome.ok) return Result.err(transcriptOutcome.error);
    return Result.ok(transcriptOutcome.value.value);
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
      const rawValuesOutcome = sqliteCaptureOutcome(rawValues);
      if (!rawValuesOutcome.ok) {
        this.queuePersistenceDiagnostic(rawValuesOutcome.error);
        return Result.err(rawValuesOutcome.error);
      }
      const decoded = decodeMiniLilacModelTranscript({
        rawValues: rawValuesOutcome.value,
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: sessionId,
      });
      const decodedOutcome = sqliteCaptureOutcome(decoded);
      if (!decodedOutcome.ok) {
        this.queuePersistenceDiagnostic(decodedOutcome.error);
        return Result.err(decodedOutcome.error);
      }
      return Result.ok(decodedOutcome.value);
    });
  }

  getUiMessages(sessionId: string): MiniLilacUIMessage[] {
    return storeResultToLegacy(this.getUiMessagesResult(sessionId));
  }

  getUiMessagesResult(
    sessionId: string,
  ): ResultType<MiniLilacUIMessage[], MiniLilacPersistenceError> {
    const transcript = this.getUiTranscriptResult(sessionId);
    const transcriptOutcome = sqliteCaptureOutcome(transcript);
    if (!transcriptOutcome.ok) return Result.err(transcriptOutcome.error);
    return Result.ok(transcriptOutcome.value.value);
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
      const rawValuesOutcome = sqliteCaptureOutcome(rawValues);
      if (!rawValuesOutcome.ok) {
        this.queuePersistenceDiagnostic(rawValuesOutcome.error);
        return Result.err(rawValuesOutcome.error);
      }
      const decoded = decodeMiniLilacUiTranscript({
        rawValues: rawValuesOutcome.value,
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: sessionId,
      });
      const decodedOutcome = sqliteCaptureOutcome(decoded);
      if (!decodedOutcome.ok) {
        this.queuePersistenceDiagnostic(decodedOutcome.error);
        return Result.err(decodedOutcome.error);
      }
      return Result.ok(decodedOutcome.value);
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
      const decodedOutcome = sqliteCaptureOutcome(decoded);
      if (!decodedOutcome.ok) throw decodedOutcome.error;
      const messages = decodedOutcome.value.value;
      const message = messages[0];
      if (message === undefined) throw new Error("Decoded model transcript node was empty");
      return message;
    }
    const decoded = decodeMiniLilacUiTranscript({
      rawValues: [raw],
      schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
      recordId,
    });
    const decodedOutcome = sqliteCaptureOutcome(decoded);
    if (!decodedOutcome.ok) throw decodedOutcome.error;
    const messages = decodedOutcome.value.value;
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
    const decodedOutcome = sqliteCaptureOutcome(decoded);
    if (!decodedOutcome.ok) return Result.err(decodedOutcome.error);
    return Result.ok(headId === null ? null : decodedOutcome.value.value);
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
    const commandOutcome = sqliteCaptureOutcome(command);
    if (!commandOutcome.ok) return Result.err(commandOutcome.error);
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
      const decodedRowOutcome = sqliteCaptureOutcome(decodedRow);
      if (!decodedRowOutcome.ok) {
        if (decodedRowOutcome.error._tag !== "MiniLilacHistoryRecordMissing") {
          this.queuePersistenceDiagnostic(decodedRowOutcome.error);
        }
        return Result.err(decodedRowOutcome.error);
      }
      const row = decodedRowOutcome.value;
      if (row.kind !== commandOutcome.value.kind) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "getCommandResult",
            message: `Command '${commandId}' was already used for '${row.kind}'`,
          }),
        );
      }
      if (commandOutcome.value.runId !== null && row.run_id !== commandOutcome.value.runId) {
        return Result.err(
          new MiniLilacStoreOperationRejected({
            operation: "getCommandResult",
            message: `Command '${commandId}' was already used for a different run`,
          }),
        );
      }
      if (
        row.request_fingerprint !== commandOutcome.value.fingerprint ||
        row.request_json !== commandOutcome.value.json
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
      const decodedOutcome = sqliteCaptureOutcome(decoded);
      if (!decodedOutcome.ok) {
        this.queuePersistenceDiagnostic(decodedOutcome.error);
        return Result.err(decodedOutcome.error);
      }
      return Result.ok(decodedOutcome.value.value);
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
    const commandOutcome = sqliteCaptureOutcome(command);
    if (!commandOutcome.ok) return Result.err(commandOutcome.error);
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
          commandOutcome.value.kind,
          commandOutcome.value.runId,
          commandOutcome.value.fingerprint,
          commandOutcome.value.json,
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
    const commandOutcome = sqliteCaptureOutcome(command);
    if (!commandOutcome.ok) return Result.err(commandOutcome.error);
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
          commandOutcome.value.kind,
          commandOutcome.value.runId,
          commandOutcome.value.fingerprint,
          commandOutcome.value.json,
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
    const commandOutcome = sqliteCaptureOutcome(command);
    if (!commandOutcome.ok) return Result.err(commandOutcome.error);
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
          commandOutcome.value.kind,
          commandOutcome.value.runId,
          commandOutcome.value.fingerprint,
          commandOutcome.value.json,
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
    const commandOutcome = sqliteCaptureOutcome(command);
    if (!commandOutcome.ok) return Result.err(commandOutcome.error);
    const serializedResult = serializeStoreValueResult(result, "saveCommandResult");
    const serializedResultOutcome = sqliteCaptureOutcome(serializedResult);
    if (!serializedResultOutcome.ok) return Result.err(serializedResultOutcome.error);
    return this.runHistoryReadResult("saveCommandResult", () => {
      const saved = this.database
        .query(
          `UPDATE commands SET result_json = ?
           WHERE session_id = ? AND command_id = ? AND kind = ?
             AND run_id IS ? AND request_fingerprint = ? AND request_json = ?
             AND side_effect_started = 1 AND result_json IS NULL`,
        )
        .run(
          serializedResultOutcome.value,
          sessionId,
          commandId,
          commandOutcome.value.kind,
          commandOutcome.value.runId,
          commandOutcome.value.fingerprint,
          commandOutcome.value.json,
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
