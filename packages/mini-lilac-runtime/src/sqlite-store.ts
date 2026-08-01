import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

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
  miniLilacCompactResultSchema,
  miniLilacCompactionEventSchema,
  miniLilacHistoryFilesystemResultSchema,
  miniLilacMessagesSchema,
  miniLilacOutputRollbackSchema,
  miniLilacProviderMetadataSchema,
  miniLilacRedoResultSchema,
  miniLilacReasoningSchema,
  miniLilacSessionSnapshotSchema,
  miniLilacSessionStatusSchema,
  miniLilacSteeringCommittedChunkSchema,
  miniLilacSteeringChunkSchema,
  miniLilacSubagentStatusSchema,
  miniLilacTodoChunkSchema,
  miniLilacTodoStateSchema,
  miniLilacTodosSchema,
  miniLilacTranscriptResetSchema,
  miniLilacUIMessageMetadataSchema,
  miniLilacUndoResultSchema,
  miniLilacUserUIMessageSchema,
} from "@stanley2058/mini-lilac-client";
import type { ModelMessage } from "ai";
import superjson from "superjson";
import { z } from "zod";

const sessionStatusSchema = miniLilacSessionStatusSchema;
const runStatusSchema = z.enum(["active", "completed", "cancelled", "error"]);
export const MINI_LILAC_DATABASE_SCHEMA_VERSION = 7;
export const MINI_MAIN_CLAUDE_ATTEMPT_RETENTION_LIMIT = 100;

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

const sessionRowSchema = z.object({
  id: z.string(),
  active_run_id: z.string().nullable(),
  workspace_id: z.string(),
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

const jsonRowSchema = z.object({ value_json: z.string() });
const todosRowSchema = z.object({
  revision: z.number().int().nonnegative(),
  todos_json: z.string(),
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
const historyWorkspaceOutcomeSchema = z.discriminatedUnion("workspaceStatus", [
  z.strictObject({
    workspaceSnapshotId: z.string().min(1),
    workspaceStatus: z.literal("captured"),
    workspaceUnavailableReason: z.null(),
  }),
  z.strictObject({
    workspaceSnapshotId: z.null(),
    workspaceStatus: z.literal("unavailable"),
    workspaceUnavailableReason: z.enum([
      "git-unavailable",
      "capture-failed",
      "non-git-workspace",
      "platform-unsupported",
    ]),
  }),
]);

const workspaceRowSchema = z.object({
  id: z.string(),
  canonical_cwd: z.string(),
  health_status: z.enum(["healthy", "corrupt"]),
  health_detail: z.string().nullable(),
  created_at: z.string(),
});
const historyStoreMetadataRowSchema = z.object({
  namespace_id: z.string().min(1),
  created_at: z.string(),
});
const workspaceSnapshotRowSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  root_tree_oid: z.string(),
  git_ref: z.string(),
  format_version: z.number().int().positive(),
  availability: z.enum(["available", "missing", "corrupt"]),
  availability_detail: z.string().nullable(),
  created_at: z.string(),
});
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
const historyStateRowSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  workspace_id: z.string(),
  model_head_id: z.number().int().positive().nullable(),
  ui_head_id: z.number().int().positive().nullable(),
  workspace_snapshot_id: z.string().nullable(),
  workspace_status: historyWorkspaceStatusSchema,
  workspace_unavailable_reason: historyWorkspaceUnavailableReasonSchema.nullable(),
  origin: historyStateOriginSchema,
  last_provider_family: historyProviderFamilySchema.nullable(),
  contains_cross_family_turns: z.number().int().min(0).max(1).nullable(),
  created_at: z.string(),
});
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
const miniMainClaudeStateLookupSchema = z.strictObject({
  sessionId: z.string().min(1),
  historyStateId: z.string().min(1),
  providerId: z.string().min(1),
});
const reserveMiniMainClaudeSessionAttemptSchema = z.strictObject({
  providerId: z.string().min(1),
  requestClient: z.string().min(1),
  lilacSessionId: z.string().min(1),
  sourceHistoryStateId: z.string().min(1),
  executionScopeHashVersion: z.literal(1),
  executionScopeHash: z.string().min(1),
  requestId: z.string().min(1),
  attemptIndex: z.number().int().nonnegative(),
  candidateSessionId: z.string().uuid(),
  sourceSessionId: z.string().uuid().nullable(),
  expectedBindingRevision: z.number().int().positive().nullable(),
});
const miniMainClaudeSessionAttemptKeySchema = z.strictObject({
  providerId: z.string().min(1),
  lilacSessionId: z.string().min(1),
  requestId: z.string().min(1),
  attemptIndex: z.number().int().nonnegative(),
});
const recordMiniMainClaudeSessionAttemptOutcomeSchema =
  miniMainClaudeSessionAttemptKeySchema.extend({
    state: miniMainClaudeAttemptStateSchema.exclude(["active"]),
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
const historyTransitionRowSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  from_state_id: z.string(),
  to_state_id: z.string().nullable(),
  kind: historyTransitionKindSchema,
  delivery: historyDeliverySchema.nullable(),
  command_id: z.string().nullable(),
  user_message_json: z.string().nullable(),
  root_run_id: z.string().nullable(),
  replay_after_seq: z.number().int().nonnegative().nullable(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});
const sessionHistoryRowSchema = z.object({
  session_id: z.string(),
  root_state_id: z.string(),
  current_state_id: z.string(),
  undo_floor_state_id: z.string(),
  updated_at: z.string(),
});
const historyRedoRowSchema = z.object({
  session_id: z.string(),
  position: z.number().int().nonnegative(),
  target_state_id: z.string(),
  user_transition_id: z.string(),
  created_at: z.string(),
});
const historyOperationRowSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  workspace_id: z.string(),
  command_id: z.string(),
  kind: z.literal("navigate"),
  requested_action: historyOperationActionSchema,
  source_state_id: z.string(),
  observed_source_state_id: z.string().nullable(),
  target_state_id: z.string(),
  user_transition_id: z.string(),
  filesystem_mode: historyFilesystemModeSchema,
  skip_reason: historySkipReasonSchema.nullable(),
  phase: historyOperationPhaseSchema,
  prepared_at: z.string(),
  updated_at: z.string(),
});
const pendingRunFinalizationRowSchema = z.object({
  run_id: z.string(),
  session_id: z.string(),
  workspace_id: z.string(),
  open_transition_id: z.string(),
  model_head_id: z.number().int().positive().nullable(),
  ui_head_id: z.number().int().positive().nullable(),
  run_status: z.enum(["completed", "cancelled", "error"]),
  session_status: z.enum(["idle", "error"]),
  error: z.string().nullable(),
  terminal_result_json: z.string().nullable(),
  input_tokens: z.number().int().nonnegative().nullable(),
  last_provider_family: historyProviderFamilySchema.nullable(),
  contains_cross_family_turns: z.number().int().min(0).max(1).nullable(),
  claude_binding_promotion_json: z.string().nullable(),
  prepared_at: z.string(),
});
const historyAccountingRowSchema = z.object({
  state_count: z.number().int().nonnegative(),
  transition_count: z.number().int().nonnegative(),
  branch_tip_count: z.number().int().nonnegative(),
  snapshot_count: z.number().int().nonnegative(),
  redo_stack_count: z.number().int().nonnegative(),
  active_operation_count: z.number().int().nonnegative(),
  pending_finalization_count: z.number().int().nonnegative(),
});
const historyRecoveryOperationRowSchema = historyOperationRowSchema.extend({
  canonical_cwd: z.string(),
});
const historyRecoveryPendingFinalizationRowSchema = pendingRunFinalizationRowSchema.extend({
  canonical_cwd: z.string(),
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
  parts: z.array(z.unknown()),
});

type MigratedUiMessages = {
  readonly messages: MiniLilacUIMessage[];
  readonly changed: boolean;
};

function parseMigratedUiMessage(value: unknown): {
  readonly message: MiniLilacUIMessage | null;
  readonly changed: boolean;
} {
  const envelope = migrationUiMessageEnvelopeSchema.parse(value);
  const parts: unknown[] = [];
  let changed = false;
  for (const part of envelope.parts) {
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
  if (!changed) {
    return { message: miniLilacMessagesSchema.element.parse(value), changed: false };
  }
  if (parts.length === 0) {
    if (envelope.role === "user") {
      throw new Error("Legacy user UI message contains only session snapshot parts");
    }
    return { message: null, changed: true };
  }
  return {
    message: miniLilacMessagesSchema.element.parse({ ...envelope, parts }),
    changed: true,
  };
}

function parseMigratedUiMessages(values: readonly unknown[]): MigratedUiMessages {
  const messages: MiniLilacUIMessage[] = [];
  let changed = false;
  for (const value of values) {
    const migrated = parseMigratedUiMessage(value);
    changed ||= migrated.changed;
    if (migrated.message !== null) messages.push(migrated.message);
  }
  return { messages, changed };
}

function parseMigratedUserUiMessage(value: unknown): MiniLilacUserUIMessage {
  const migrated = parseMigratedUiMessage(value);
  if (migrated.message === null) {
    throw new Error("Legacy user UI message cannot be empty after migration");
  }
  return miniLilacUserUIMessageSchema.parse(migrated.message);
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
const storedSteeringCommandPayloadSchema = z.object({
  message: miniLilacUserUIMessageSchema,
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  clientCommandId: z.string().optional(),
});

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
    kind: z.custom<`${string}.${string}`>(
      (value): value is `${string}.${string}` => typeof value === "string" && value.includes("."),
    ),
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

export function parseStoredUIMessageChunk(value: unknown): StoredUIMessageChunk {
  return standardChunkSchema.parse(value);
}

const modelMessagesSchema = z.custom<ModelMessage[]>(
  (value) =>
    Array.isArray(value) &&
    value.every(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        ["system", "user", "assistant", "tool"].includes(String(message.role)),
    ),
  "Invalid canonical model transcript",
);

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
};

export type CommitPendingStoredRunFinalization = StoredHistoryWorkspaceOutcome & {
  readonly runId: string;
  readonly destinationStateId: string;
  readonly providerState?: HistoryProviderState;
  readonly claudeBindingPromotion?: PromoteMiniMainClaudeSessionBinding;
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

function deserialize(value: string): unknown {
  return superjson.parse(value);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalJsonValue(nested)]),
    );
  }
  return value;
}

function canonicalCommandPayload(payload: unknown): { json: string; fingerprint: string } {
  const normalized: unknown = JSON.parse(JSON.stringify(payload));
  const json = JSON.stringify(canonicalJsonValue(z.json().parse(normalized)));
  const fingerprint = new Bun.CryptoHasher("sha256").update(json).digest("hex");
  return { json, fingerprint };
}

function canonicalValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
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
  return (
    prefix.length <= values.length &&
    prefix.every((value, index) => canonicalValuesEqual(value, values[index]))
  );
}

function parseHistoryWorkspaceOutcome(input: {
  readonly workspaceSnapshotId: unknown;
  readonly workspaceStatus: unknown;
  readonly workspaceUnavailableReason: unknown;
}): z.infer<typeof historyWorkspaceOutcomeSchema> {
  return historyWorkspaceOutcomeSchema.parse({
    workspaceSnapshotId: input.workspaceSnapshotId,
    workspaceStatus: input.workspaceStatus,
    workspaceUnavailableReason: input.workspaceUnavailableReason,
  });
}

type StoredSessionRowSnapshot = Omit<
  MiniLilacSessionSnapshot,
  "historyStateId" | "canUndo" | "canRedo"
>;

function toSnapshot(rowValue: unknown): StoredSessionRowSnapshot {
  const row = sessionRowSchema.parse(rowValue);
  return {
    id: row.id,
    activeRunId: row.active_run_id,
    status: row.status,
    cwd: row.cwd,
    model: row.model,
    profile: row.profile,
    reasoning: z
      .enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"])
      .parse(row.reasoning),
    title: row.title,
    inputTokens: row.input_tokens,
    inputTokensEstimated: row.input_tokens_estimated === 1,
    contextWindow: row.context_window,
    queuedSteeringCount: row.queued_steering_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRun(rowValue: unknown): StoredRun {
  const row = runRowSchema.parse(rowValue);
  return {
    id: row.id,
    sessionId: row.session_id,
    parentRunId: row.parent_run_id,
    profile: row.profile,
    depth: row.depth,
    status: row.status,
    error: row.error,
    terminalResult: row.terminal_result_json ? deserialize(row.terminal_result_json) : undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function toWorkspace(rowValue: unknown): StoredWorkspace {
  const row = workspaceRowSchema.parse(rowValue);
  return {
    id: row.id,
    canonicalCwd: row.canonical_cwd,
    healthStatus: row.health_status,
    healthDetail: row.health_detail,
    createdAt: row.created_at,
  };
}

function toWorkspaceSnapshot(rowValue: unknown): StoredWorkspaceSnapshot {
  const row = workspaceSnapshotRowSchema.parse(rowValue);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    rootTreeOid: row.root_tree_oid,
    gitRef: row.git_ref,
    formatVersion: row.format_version,
    availability: row.availability,
    availabilityDetail: row.availability_detail,
    createdAt: row.created_at,
  };
}

function toHistoryState(rowValue: unknown): StoredHistoryState {
  const row = historyStateRowSchema.parse(rowValue);
  if ((row.last_provider_family === null) !== (row.contains_cross_family_turns === null)) {
    throw new Error(`History state '${row.id}' has incomplete provider metadata`);
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    modelHeadId: row.model_head_id,
    uiHeadId: row.ui_head_id,
    workspaceSnapshotId: row.workspace_snapshot_id,
    workspaceStatus: row.workspace_status,
    workspaceUnavailableReason: row.workspace_unavailable_reason,
    origin: row.origin,
    providerState:
      row.last_provider_family === null || row.contains_cross_family_turns === null
        ? null
        : historyProviderStateSchema.parse({
            lastFamily: row.last_provider_family,
            containsCrossFamilyTurns: row.contains_cross_family_turns === 1,
          }),
    createdAt: row.created_at,
  };
}

function toMiniMainClaudeBinding(rowValue: unknown): MiniMainClaudeSessionBinding {
  const row = miniMainClaudeBindingRowSchema.parse(rowValue);
  return {
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
  };
}

function toMiniMainClaudeAttempt(rowValue: unknown): MiniMainClaudeSessionAttempt {
  const row = miniMainClaudeAttemptRowSchema.parse(rowValue);
  return {
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
  };
}

function toHistoryTransition(rowValue: unknown): StoredHistoryTransition {
  const row = historyTransitionRowSchema.parse(rowValue);
  return {
    id: row.id,
    sessionId: row.session_id,
    fromStateId: row.from_state_id,
    toStateId: row.to_state_id,
    kind: row.kind,
    delivery: row.delivery,
    commandId: row.command_id,
    userMessage:
      row.user_message_json === null
        ? null
        : miniLilacUserUIMessageSchema.parse(deserialize(row.user_message_json)),
    rootRunId: row.root_run_id,
    replayAfterSeq: row.replay_after_seq,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function toSessionHistory(rowValue: unknown): StoredSessionHistory {
  const row = sessionHistoryRowSchema.parse(rowValue);
  return {
    sessionId: row.session_id,
    rootStateId: row.root_state_id,
    currentStateId: row.current_state_id,
    undoFloorStateId: row.undo_floor_state_id,
    updatedAt: row.updated_at,
  };
}

function toHistoryRedoEntry(rowValue: unknown): StoredHistoryRedoEntry {
  const row = historyRedoRowSchema.parse(rowValue);
  return {
    sessionId: row.session_id,
    position: row.position,
    targetStateId: row.target_state_id,
    userTransitionId: row.user_transition_id,
    createdAt: row.created_at,
  };
}

function toHistoryOperation(rowValue: unknown): StoredHistoryOperation {
  const row = historyOperationRowSchema.parse(rowValue);
  return {
    id: row.id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    commandId: row.command_id,
    kind: row.kind,
    requestedAction: row.requested_action,
    sourceStateId: row.source_state_id,
    observedSourceStateId: row.observed_source_state_id,
    targetStateId: row.target_state_id,
    userTransitionId: row.user_transition_id,
    filesystemMode: row.filesystem_mode,
    skipReason: row.skip_reason,
    phase: row.phase,
    preparedAt: row.prepared_at,
    updatedAt: row.updated_at,
  };
}

function toPendingRunFinalization(rowValue: unknown): PendingStoredRunFinalization {
  const row = pendingRunFinalizationRowSchema.parse(rowValue);
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    openTransitionId: row.open_transition_id,
    modelHeadId: row.model_head_id,
    uiHeadId: row.ui_head_id,
    runStatus: row.run_status,
    sessionStatus: row.session_status,
    error: row.error,
    terminalResult:
      row.terminal_result_json === null ? undefined : deserialize(row.terminal_result_json),
    inputTokens: row.input_tokens,
    providerState:
      row.last_provider_family === null || row.contains_cross_family_turns === null
        ? null
        : historyProviderStateSchema.parse({
            lastFamily: row.last_provider_family,
            containsCrossFamilyTurns: row.contains_cross_family_turns === 1,
          }),
    claudeBindingPromotion:
      row.claude_binding_promotion_json === null
        ? null
        : promoteMiniMainClaudeSessionBindingSchema.parse(
            deserialize(row.claude_binding_promotion_json),
          ),
    preparedAt: row.prepared_at,
  };
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

export function readMiniLilacHistoryRecoveryStatus(
  filename: string,
): ReadonlyStoredHistoryRecoveryStatus {
  const resolvedFilename = path.resolve(filename);
  if (existsSync(resolvedFilename) && lstatSync(resolvedFilename).isSymbolicLink()) {
    throw new Error(`Mini Lilac database path '${resolvedFilename}' must not be a symbolic link`);
  }
  const database = new Database(resolvedFilename, { readonly: true, strict: true });
  try {
    const version = z
      .object({ user_version: z.number().int() })
      .parse(database.query("PRAGMA user_version").get()).user_version;
    if (version !== MINI_LILAC_DATABASE_SCHEMA_VERSION) {
      throw new MiniLilacHistoryRecoveryVersionError(version);
    }
    const navigation = z
      .array(historyRecoveryOperationRowSchema)
      .parse(
        database
          .query(
            `SELECT history_operations.*, workspaces.canonical_cwd
             FROM history_operations
             JOIN workspaces ON workspaces.id = history_operations.workspace_id
             ORDER BY history_operations.prepared_at, history_operations.rowid`,
          )
          .all(),
      )
      .map((row) => ({
        canonicalCwd: row.canonical_cwd,
        operation: toHistoryOperation(row),
      }));
    const pendingFinalizations = z
      .array(historyRecoveryPendingFinalizationRowSchema)
      .parse(
        database
          .query(
            `SELECT pending_run_finalizations.*, workspaces.canonical_cwd
             FROM pending_run_finalizations
             JOIN workspaces ON workspaces.id = pending_run_finalizations.workspace_id
             ORDER BY pending_run_finalizations.prepared_at, pending_run_finalizations.rowid`,
          )
          .all(),
      )
      .map((row) => ({
        canonicalCwd: row.canonical_cwd,
        finalization: toPendingRunFinalization(row),
      }));
    return { navigation, pendingFinalizations };
  } finally {
    database.close();
  }
}

export class MiniLilacSqliteStore {
  readonly database: Database;
  readonly filename: string;
  private closeBlockers = 0;
  private closed = false;

  constructor(filename: string) {
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
    } catch (error) {
      this.database.close();
      throw error;
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
    const version = z
      .object({ user_version: z.number().int() })
      .parse(this.database.query("PRAGMA user_version").get()).user_version;
    if (version === MINI_LILAC_DATABASE_SCHEMA_VERSION) return;
    if (
      version !== 0 &&
      version !== 2 &&
      version !== 3 &&
      version !== 4 &&
      version !== 5 &&
      version !== 6
    ) {
      throw new MiniLilacDatabaseVersionError(version);
    }

    // Session and run composite ownership require SQLite's documented table
    // rebuild. These pragmas cannot be changed from inside the transaction.
    this.database.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON;");
    try {
      this.database.transaction(() => {
        if (version === 0) {
          this.createSchemaV6();
        } else {
          if (version === 2) this.migrateSchemaV2ToV3();
          if (version === 2 || version === 3) this.migrateSchemaV3ToV4();
          if (version === 2 || version === 3 || version === 4) this.migrateSchemaV4ToV5();
          if (version === 5) this.migrateSchemaV5ToV6();
        }
        this.migrateSchemaV6ToV7();
        const violations = this.database.query("PRAGMA foreign_key_check").all();
        if (violations.length > 0) {
          throw new Error(
            `Mini Lilac schema migration to v${MINI_LILAC_DATABASE_SCHEMA_VERSION} left ${violations.length} foreign key violation(s)`,
          );
        }
        this.database.exec(`PRAGMA user_version = ${MINI_LILAC_DATABASE_SCHEMA_VERSION};`);
      })();
    } finally {
      this.database.exec("PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;");
    }
    const violations = this.database.query("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `Mini Lilac schema migration to v${MINI_LILAC_DATABASE_SCHEMA_VERSION} left ${violations.length} foreign key violation(s)`,
      );
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

  private migrateSchemaV4ToV5(): void {
    const existingViolations = this.database.query("PRAGMA foreign_key_check").all();
    if (existingViolations.length > 0) {
      throw new Error(
        `Mini Lilac v4 database has ${existingViolations.length} structural foreign key violation(s)`,
      );
    }
    const sessions = z
      .array(migrationSessionRowSchema)
      .parse(this.database.query("SELECT * FROM sessions ORDER BY rowid").all());
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
      if (workspaceId === undefined)
        throw new Error(`Workspace for '${canonicalCwd}' was not created`);
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
    const workspaceMismatchCount = z.object({ count: z.number().int().nonnegative() }).parse(
      this.database
        .query(
          `SELECT COUNT(*) AS count FROM sessions
             JOIN workspaces ON workspaces.id = sessions.workspace_id
             WHERE sessions.cwd <> workspaces.canonical_cwd`,
        )
        .get(),
    ).count;
    if (workspaceMismatchCount > 0) {
      throw new Error(
        `Mini Lilac v4 migration produced ${workspaceMismatchCount} workspace mismatch(es)`,
      );
    }
    this.createHistorySchemaTables();
    for (const session of sessions) this.migrateSessionHistoryV4(session.id);
    this.database.exec("DROP TABLE user_checkpoints;");
  }

  private migrateSessionHistoryV4(sessionId: string): void {
    const session = z
      .object({
        id: z.string(),
        workspace_id: z.string(),
        active_run_id: z.string().nullable(),
        status: sessionStatusSchema,
        created_at: z.string(),
        updated_at: z.string(),
      })
      .parse(
        this.database
          .query(
            `SELECT id, workspace_id, active_run_id, status, created_at, updated_at
             FROM sessions WHERE id = ?`,
          )
          .get(sessionId),
      );
    let currentHeads = this.getTranscriptHeads(sessionId);
    modelMessagesSchema.parse(
      this.readSerializedChain(sessionId, "model", currentHeads.model_head_id).map(deserialize),
    );
    const migratedCurrentUi = parseMigratedUiMessages(
      this.readSerializedChain(sessionId, "ui", currentHeads.ui_head_id).map(deserialize),
    );
    const currentUi = migratedCurrentUi.messages;
    if (migratedCurrentUi.changed) {
      const uiHeadId = this.internChain(sessionId, "ui", currentUi);
      this.setTranscriptHeads(sessionId, currentHeads.model_head_id, uiHeadId);
      currentHeads = { ...currentHeads, ui_head_id: uiHeadId };
    }
    const checkpoints = z.array(migrationCheckpointRowSchema).parse(
      this.database
        .query(
          `SELECT session_id, ui_position, user_message_json, model_head_id, ui_head_id,
                    root_run_id, replay_after_seq
             FROM user_checkpoints WHERE session_id = ? ORDER BY ui_position`,
        )
        .all(sessionId),
    );
    const activeRootRuns = z.array(migrationRunRowSchema).parse(
      this.database
        .query(
          `SELECT id, status, parent_run_id FROM runs
             WHERE session_id = ? AND parent_run_id IS NULL AND status = 'active'`,
        )
        .all(sessionId),
    );
    const hasActiveLifecycle = session.active_run_id !== null;
    if (
      (hasActiveLifecycle &&
        (activeRootRuns.length !== 1 ||
          activeRootRuns[0]?.id !== session.active_run_id ||
          !["streaming", "cancelling"].includes(session.status))) ||
      (!hasActiveLifecycle && activeRootRuns.length > 0) ||
      (!hasActiveLifecycle && ["streaming", "cancelling"].includes(session.status))
    ) {
      throw new Error(`Session '${sessionId}' has an invalid active root run during v4 migration`);
    }

    const parsedCheckpoints = checkpoints.map((checkpoint) => {
      const run = migrationRunRowSchema.parse(
        this.database
          .query("SELECT id, status, parent_run_id FROM runs WHERE id = ? AND session_id = ?")
          .get(checkpoint.root_run_id, sessionId),
      );
      if (run.parent_run_id !== null) {
        throw new Error(
          `Checkpoint ${checkpoint.ui_position} for session '${sessionId}' references a child run`,
        );
      }
      modelMessagesSchema.parse(
        this.readSerializedChain(sessionId, "model", checkpoint.model_head_id).map(deserialize),
      );
      const migratedUiPrefix = parseMigratedUiMessages(
        this.readSerializedChain(sessionId, "ui", checkpoint.ui_head_id).map(deserialize),
      );
      const uiHeadId = migratedUiPrefix.changed
        ? this.internChain(sessionId, "ui", migratedUiPrefix.messages)
        : checkpoint.ui_head_id;
      return {
        row: { ...checkpoint, ui_head_id: uiHeadId },
        run,
        message: parseMigratedUserUiMessage(deserialize(checkpoint.user_message_json)),
        uiPrefix: migratedUiPrefix.messages,
      };
    });
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
        throw new Error(`Session '${sessionId}' cannot recover its active run from v4 checkpoints`);
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
        throw new Error(
          `Session '${sessionId}' has unusual checkpoint ordering while its run is active`,
        );
      }
      console.warn(
        `Mini Lilac v4 history for session '${sessionId}' had unusual checkpoint ordering; ` +
          "preserved its readable transcript as a single migration state with undo disabled",
      );
      this.insertMigratedSingleState(session, currentHeads);
      return;
    }

    if (parsedCheckpoints.length === 0) {
      if (hasActiveLifecycle) {
        throw new Error(`Session '${sessionId}' has an active run without a v4 checkpoint`);
      }
      this.insertMigratedSingleState(session, currentHeads);
      return;
    }

    const stateIds = parsedCheckpoints.map(() => randomUUID());
    for (const [index, checkpoint] of parsedCheckpoints.entries()) {
      const stateId = stateIds[index];
      if (stateId === undefined) {
        throw new Error(`Session '${sessionId}' history migration lost checkpoint state ${index}`);
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
        throw new Error(`Session '${sessionId}' history migration produced an incomplete edge`);
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
      throw new Error(`Session '${sessionId}' history migration did not produce a cursor`);
    }
    this.database
      .query(
        `INSERT INTO session_history
          (session_id, root_state_id, current_state_id, undo_floor_state_id, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, rootStateId, currentStateId, rootStateId, session.updated_at);
    this.assertStateConnectedToRoot(sessionId, currentStateId);
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

  private migrateSchemaV2ToV3(): void {
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

    const sessionIds = z
      .array(z.object({ id: z.string() }))
      .parse(this.database.query("SELECT id FROM sessions ORDER BY rowid").all());
    for (const { id: sessionId } of sessionIds) {
      const modelValues = this.database
        .query(
          "SELECT session_id, position, value_json FROM model_transcript WHERE session_id = ? ORDER BY position",
        )
        .all(sessionId)
        .map((value) => legacyPositionedJsonRowSchema.parse(value).value_json);
      const uiValues = this.database
        .query(
          "SELECT session_id, position, value_json FROM ui_messages WHERE session_id = ? ORDER BY position",
        )
        .all(sessionId)
        .map((value) => legacyPositionedJsonRowSchema.parse(value).value_json);
      modelMessagesSchema.parse(modelValues.map(deserialize));
      const migratedUi = parseMigratedUiMessages(uiValues.map(deserialize));
      const modelHeadId = this.internSerializedChain(sessionId, "model", modelValues);
      const uiHeadId = migratedUi.changed
        ? this.internChain(sessionId, "ui", migratedUi.messages)
        : this.internSerializedChain(sessionId, "ui", uiValues);
      this.setTranscriptHeads(sessionId, modelHeadId, uiHeadId);
    }

    const checkpoints = this.database
      .query(
        `SELECT session_id, ui_position, user_message_json, model_prefix_json,
                ui_prefix_json, root_run_id, replay_after_seq
         FROM user_checkpoints ORDER BY session_id, ui_position`,
      )
      .all()
      .map((value) => legacyCheckpointRowSchema.parse(value));
    const insertCheckpoint = this.database.query(
      `INSERT INTO user_checkpoints_v3
        (session_id, ui_position, user_message_json, model_head_id, ui_head_id, root_run_id, replay_after_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const checkpoint of checkpoints) {
      const message = parseMigratedUserUiMessage(deserialize(checkpoint.user_message_json));
      const modelPrefix = modelMessagesSchema.parse(deserialize(checkpoint.model_prefix_json));
      const uiPrefix = parseMigratedUiMessages(
        z.array(z.unknown()).parse(deserialize(checkpoint.ui_prefix_json)),
      ).messages;
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
    const now = new Date().toISOString();
    const canonicalCwd = canonicalizeStoredCwd(input.cwd);
    this.database.transaction(() => {
      this.database
        .query(
          `INSERT INTO workspaces (id, canonical_cwd, created_at)
           VALUES (?, ?, ?) ON CONFLICT(canonical_cwd) DO NOTHING`,
        )
        .run(randomUUID(), canonicalCwd, now);
      const workspace = workspaceRowSchema.parse(
        this.database.query("SELECT * FROM workspaces WHERE canonical_cwd = ?").get(canonicalCwd),
      );
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
    })();
    return this.getSession(input.id);
  }

  getSession(sessionId: string): MiniLilacSessionSnapshot {
    const row = this.database.query("SELECT * FROM sessions WHERE id = ?").get(sessionId);
    if (!row) throw new Error(`Session '${sessionId}' was not found`);
    const snapshot = toSnapshot(row);
    const navigation = this.getHistoryNavigation(sessionId);
    return {
      ...snapshot,
      historyStateId: navigation.currentStateId,
      canUndo: navigation.canUndo,
      canRedo: navigation.canRedo,
    };
  }

  listSessions(): MiniLilacSessionSnapshot[] {
    return this.database
      .query("SELECT * FROM sessions ORDER BY created_at")
      .all()
      .map((row) => {
        const snapshot = toSnapshot(row);
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
    z.number().int().nonnegative().parse(inputTokens);
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
    const snapshot = this.getSession(sessionId);
    if (updated.changes === 0 && snapshot.activeRunId !== runId) {
      throw new Error(`Run '${runId}' is not active for session '${sessionId}'`);
    }
    return snapshot;
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
    const command = canonicalCommandPayload(request.payload);
    return this.database.transaction(() => {
      const previous = this.getCommandResult(sessionId, commandId, request);
      if (previous !== undefined) return miniLilacSessionSnapshotSchema.parse(previous);
      const snapshot = this.getSession(sessionId);
      const activeRunCount = z
        .object({ count: z.number().int().nonnegative() })
        .parse(
          this.database
            .query("SELECT COUNT(*) AS count FROM runs WHERE session_id = ? AND status = 'active'")
            .get(sessionId),
        ).count;
      if (
        !["idle", "error"].includes(snapshot.status) ||
        snapshot.activeRunId !== null ||
        activeRunCount > 0
      ) {
        throw new Error(`Session '${sessionId}' must be quiescent to update bindings`);
      }

      const now = new Date().toISOString();
      this.database
        .query(
          `UPDATE sessions
           SET model = ?, profile = ?, reasoning = ?,
               context_window = ?, input_tokens = ?, input_tokens_estimated = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          bindings.model ?? snapshot.model,
          bindings.profile ?? snapshot.profile,
          bindings.reasoning ?? snapshot.reasoning,
          bindings.model === undefined
            ? (snapshot.contextWindow ?? null)
            : (bindings.contextWindow ?? null),
          bindings.model === undefined ? (snapshot.inputTokens ?? null) : null,
          // Clearing the count must clear the flag with it: an estimate marker
          // left on a null count renders as an estimate of nothing.
          bindings.model === undefined ? (snapshot.inputTokensEstimated ? 1 : 0) : 0,
          now,
          sessionId,
        );
      const result = this.getSession(sessionId);
      this.database
        .query(
          `INSERT INTO commands
            (session_id, command_id, kind, run_id, request_fingerprint, request_json, side_effect_started, result_json, created_at)
           VALUES (?, ?, ?, NULL, ?, ?, 1, ?, ?)`,
        )
        .run(
          sessionId,
          commandId,
          request.kind,
          command.fingerprint,
          command.json,
          serialize(result),
          now,
        );
      return result;
    })();
  }

  createRun(input: CreateStoredRun): StoredRun {
    if (input.parentRunId === undefined) {
      throw new Error(
        "Root runs must be created through admitRootPromptHistory so their open transition is atomic",
      );
    }
    const now = new Date().toISOString();
    this.database
      .query(
        `INSERT INTO runs
          (id, session_id, parent_run_id, profile, depth, status, started_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(input.id, input.sessionId, input.parentRunId ?? null, input.profile, input.depth, now);
    return this.getRun(input.id);
  }

  getRun(runId: string): StoredRun {
    const row = this.database.query("SELECT * FROM runs WHERE id = ?").get(runId);
    if (!row) throw new Error(`Run '${runId}' was not found`);
    return toRun(row);
  }

  getActiveRootRun(sessionId: string): StoredRun | null {
    const row = this.database
      .query(
        `SELECT runs.* FROM sessions
         JOIN runs ON runs.id = sessions.active_run_id AND runs.session_id = sessions.id
         WHERE sessions.id = ? AND runs.parent_run_id IS NULL AND runs.status = 'active'`,
      )
      .get(sessionId);
    return row ? toRun(row) : null;
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
    return row ? toRun(row) : null;
  }

  finishRun(
    runId: string,
    status: Exclude<MiniLilacRunStatus, "active">,
    options: { error?: string; terminalResult?: unknown } = {},
  ): void {
    const run = this.getRun(runId);
    if (run.parentRunId === null) {
      throw new Error(
        "Root runs must be terminalized through pending finalization so history closes atomically",
      );
    }
    this.database
      .query(
        "UPDATE runs SET status = ?, error = ?, terminal_result_json = ?, finished_at = ? WHERE id = ?",
      )
      .run(
        status,
        options.error ?? null,
        options.terminalResult === undefined ? null : serialize(options.terminalResult),
        new Date().toISOString(),
        runId,
      );
  }

  getTodos(sessionId: string): MiniLilacTodoState {
    const session = this.database.query("SELECT 1 FROM sessions WHERE id = ?").get(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' was not found`);
    const value = this.database
      .query("SELECT revision, todos_json FROM session_todos WHERE session_id = ?")
      .get(sessionId);
    if (!value) return miniLilacTodoStateSchema.parse({ revision: 0, todos: [] });
    const row = todosRowSchema.parse(value);
    return miniLilacTodoStateSchema.parse({
      revision: row.revision,
      todos: JSON.parse(row.todos_json),
    });
  }

  replaceTodosForRun(input: ReplaceTodosForRun): ReplaceTodosForRunResult {
    const todos = miniLilacTodosSchema.parse(input.todos);
    const todosJson = JSON.stringify(canonicalJsonValue(todos));

    return this.database.transaction(() => {
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
        throw new Error(`Run '${input.runId}' is not active for session '${input.sessionId}'`);
      }

      const current = this.getTodos(input.sessionId);
      const currentJson = JSON.stringify(canonicalJsonValue(current.todos));
      if (currentJson === todosJson) return { state: current };
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new Error(`Session '${input.sessionId}' todo revision is exhausted`);
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
      if (!updatedValue) return { state: this.getTodos(input.sessionId) };

      const updated = todosRowSchema.parse(updatedValue);
      const state = miniLilacTodoStateSchema.parse({
        revision: updated.revision,
        todos: JSON.parse(updated.todos_json),
      });
      this.database
        .query("UPDATE sessions SET updated_at = ? WHERE id = ?")
        .run(now, input.sessionId);
      return { state };
    })();
  }

  private runImmediateTransaction<T>(operation: () => T): T {
    return this.database.transaction(operation).immediate();
  }

  getHistoryStoreMetadata(): StoredHistoryStoreMetadata {
    const row = historyStoreMetadataRowSchema.parse(
      this.database
        .query("SELECT namespace_id, created_at FROM history_store_metadata WHERE singleton = 1")
        .get(),
    );
    return { namespaceId: row.namespace_id, createdAt: row.created_at };
  }

  getWorkspaceForSession(sessionId: string): StoredWorkspace {
    const row = this.database
      .query(
        `SELECT workspaces.* FROM sessions
         JOIN workspaces ON workspaces.id = sessions.workspace_id
         WHERE sessions.id = ?`,
      )
      .get(sessionId);
    if (!row) throw new Error(`Session '${sessionId}' was not found`);
    return toWorkspace(row);
  }

  listWorkspaces(): readonly StoredWorkspace[] {
    return this.database
      .query("SELECT * FROM workspaces ORDER BY created_at, rowid")
      .all()
      .map(toWorkspace);
  }

  listWorkspaceSnapshots(workspaceId: string): readonly StoredWorkspaceSnapshot[] {
    z.string().min(1).parse(workspaceId);
    return this.database
      .query(
        `SELECT * FROM workspace_snapshots
         WHERE workspace_id = ? ORDER BY created_at, rowid`,
      )
      .all(workspaceId)
      .map(toWorkspaceSnapshot);
  }

  listWorkspaceSnapshotGroups(): readonly StoredWorkspaceSnapshotGroup[] {
    return this.listWorkspaces().map((workspace) => ({
      workspace,
      snapshots: this.listWorkspaceSnapshots(workspace.id),
    }));
  }

  setWorkspaceSnapshotAvailability(input: SetStoredWorkspaceSnapshotAvailability): void {
    z.string().min(1).parse(input.workspaceId);
    const updates = z.array(workspaceSnapshotAvailabilityUpdateSchema).parse(input.updates);
    if (new Set(updates.map((update) => update.snapshotId)).size !== updates.length) {
      throw new Error("Workspace snapshot availability updates contain duplicate snapshot IDs");
    }
    this.runImmediateTransaction(() => {
      const workspace = this.database
        .query("SELECT 1 FROM workspaces WHERE id = ?")
        .get(input.workspaceId);
      if (!workspace) throw new Error(`Workspace '${input.workspaceId}' was not found`);
      for (const update of updates) {
        const changed = this.database
          .query(
            `UPDATE workspace_snapshots
             SET availability = ?, availability_detail = ?
             WHERE id = ? AND workspace_id = ?`,
          )
          .run(update.availability, update.detail, update.snapshotId, input.workspaceId);
        if (changed.changes !== 1) {
          throw new Error(
            `Workspace snapshot '${update.snapshotId}' was not found in workspace '${input.workspaceId}'`,
          );
        }
      }
    });
  }

  deleteUnreferencedWorkspaceSnapshots(
    input: DeleteUnreferencedStoredWorkspaceSnapshots,
  ): readonly StoredWorkspaceSnapshot[] {
    z.string().min(1).parse(input.workspaceId);
    const snapshotIds = input.snapshotIds
      ? z.array(z.string().min(1)).parse(input.snapshotIds)
      : undefined;
    if (snapshotIds && new Set(snapshotIds).size !== snapshotIds.length) {
      throw new Error("Unreferenced workspace snapshot deletion contains duplicate snapshot IDs");
    }
    return this.runImmediateTransaction(() => {
      const workspace = this.database
        .query("SELECT 1 FROM workspaces WHERE id = ?")
        .get(input.workspaceId);
      if (!workspace) throw new Error(`Workspace '${input.workspaceId}' was not found`);
      const candidates = this.listWorkspaceSnapshots(input.workspaceId).filter(
        (snapshot) => snapshotIds === undefined || snapshotIds.includes(snapshot.id),
      );
      const deleted: StoredWorkspaceSnapshot[] = [];
      for (const snapshot of candidates) {
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
      return deleted;
    });
  }

  assertWorkspaceHistoryAvailable(
    sessionId: string,
    ownerValue?: WorkspaceHistoryAvailabilityOwner,
  ): void {
    const owner =
      ownerValue === undefined ? undefined : workspaceHistoryOwnerSchema.parse(ownerValue);
    const workspace = this.getWorkspaceForSession(sessionId);
    this.assertWorkspaceHistoryAvailableForOwner(workspace.id, sessionId, owner);
  }

  createOrReuseWorkspaceSnapshot(input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly rootTreeOid: string;
    readonly gitRef: string;
    readonly formatVersion: number;
    readonly createdAt?: string;
  }): StoredWorkspaceSnapshot {
    z.string().min(1).parse(input.id);
    z.string().min(1).parse(input.workspaceId);
    z.string().min(1).parse(input.rootTreeOid);
    z.string().min(1).parse(input.gitRef);
    z.number().int().positive().parse(input.formatVersion);
    return this.database.transaction(() => {
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
      return toWorkspaceSnapshot(row);
    })();
  }

  getWorkspaceSnapshot(snapshotId: string): StoredWorkspaceSnapshot | null {
    z.string().min(1).parse(snapshotId);
    const row = this.database
      .query("SELECT * FROM workspace_snapshots WHERE id = ?")
      .get(snapshotId);
    return row ? toWorkspaceSnapshot(row) : null;
  }

  getHistoryState(stateId: string): StoredHistoryState {
    const row = this.database.query("SELECT * FROM history_states WHERE id = ?").get(stateId);
    if (!row) throw new Error(`History state '${stateId}' was not found`);
    return toHistoryState(row);
  }

  getHistoryStateModelMessages(stateId: string): ModelMessage[] {
    const state = this.getHistoryState(stateId);
    return modelMessagesSchema.parse(
      this.readSerializedChain(state.sessionId, "model", state.modelHeadId).map(deserialize),
    );
  }

  getHistoryStateUiMessages(stateId: string): MiniLilacUIMessage[] {
    const state = this.getHistoryState(stateId);
    return miniLilacMessagesSchema.parse(
      this.readSerializedChain(state.sessionId, "ui", state.uiHeadId).map(deserialize),
    );
  }

  getCurrentHistoryState(sessionId: string): StoredHistoryState {
    const row = this.database
      .query(
        `SELECT state.* FROM session_history AS history
         JOIN history_states AS state
           ON state.id = history.current_state_id AND state.session_id = history.session_id
         WHERE history.session_id = ?`,
      )
      .get(sessionId);
    if (!row) throw new Error(`Session '${sessionId}' has no history cursor`);
    return toHistoryState(row);
  }

  getMiniMainClaudeState(inputValue: {
    readonly sessionId: string;
    readonly historyStateId: string;
    readonly providerId: string;
  }): MiniMainClaudeState {
    const input = miniMainClaudeStateLookupSchema.parse(inputValue);
    return this.database.transaction(() => {
      const row = this.database
        .query("SELECT * FROM history_states WHERE id = ? AND session_id = ?")
        .get(input.historyStateId, input.sessionId);
      if (!row) {
        throw new Error(
          `History state '${input.historyStateId}' does not belong to session '${input.sessionId}'`,
        );
      }
      const historyState = toHistoryState(row);
      const bindingRow = this.database
        .query(
          `SELECT * FROM mini_main_claude_bindings
           WHERE session_id = ? AND history_state_id = ? AND provider_id = ?`,
        )
        .get(input.sessionId, input.historyStateId, input.providerId);
      return {
        historyState,
        providerState: historyState.providerState,
        binding: bindingRow ? toMiniMainClaudeBinding(bindingRow) : null,
      };
    })();
  }

  getMiniMainClaudeSessionAttempt(inputValue: {
    readonly providerId: string;
    readonly lilacSessionId: string;
    readonly requestId: string;
    readonly attemptIndex: number;
  }): MiniMainClaudeSessionAttempt | null {
    const input = miniMainClaudeSessionAttemptKeySchema.parse(inputValue);
    const row = this.database
      .query(
        `SELECT * FROM mini_main_claude_attempts
         WHERE session_id = ? AND provider_id = ? AND request_id = ? AND attempt_index = ?`,
      )
      .get(input.lilacSessionId, input.providerId, input.requestId, input.attemptIndex);
    return row ? toMiniMainClaudeAttempt(row) : null;
  }

  reserveMiniMainClaudeSessionAttempt(
    inputValue: ReserveMiniMainClaudeSessionAttempt,
  ): MiniMainClaudeSessionAttempt {
    const input = reserveMiniMainClaudeSessionAttemptSchema.parse(inputValue);
    if ((input.sourceSessionId === null) !== (input.expectedBindingRevision === null)) {
      throw new Error("A Claude fork attempt requires both source session and binding revision");
    }
    return this.runImmediateTransaction(() => {
      const source = this.getMiniMainClaudeState({
        sessionId: input.lilacSessionId,
        historyStateId: input.sourceHistoryStateId,
        providerId: input.providerId,
      });
      if (input.expectedBindingRevision !== null) {
        const binding = source.binding;
        if (
          binding === null ||
          binding.revision !== input.expectedBindingRevision ||
          binding.claudeSessionId !== input.sourceSessionId ||
          binding.requestClient !== input.requestClient ||
          binding.executionScopeHashVersion !== input.executionScopeHashVersion ||
          binding.executionScopeHash !== input.executionScopeHash
        ) {
          throw new Error("Claude attempt source binding changed before reservation");
        }
      }
      const activeCount = z.object({ count: z.number().int().nonnegative() }).parse(
        this.database
          .query(
            `SELECT COUNT(*) AS count FROM mini_main_claude_attempts
             WHERE session_id = ? AND provider_id = ? AND state = 'active'`,
          )
          .get(input.lilacSessionId, input.providerId),
      ).count;
      if (activeCount >= MINI_MAIN_CLAUDE_ATTEMPT_RETENTION_LIMIT) {
        throw new Error("Too many active Mini main Claude attempts are retained");
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
      const attempt = this.getMiniMainClaudeSessionAttempt({
        providerId: input.providerId,
        lilacSessionId: input.lilacSessionId,
        requestId: input.requestId,
        attemptIndex: input.attemptIndex,
      });
      if (attempt === null) throw new Error("Reserved Claude attempt was not retained");
      return attempt;
    });
  }

  recordMiniMainClaudeSessionAttemptOutcome(
    inputValue: RecordMiniMainClaudeSessionAttemptOutcome,
  ): MiniMainClaudeSessionAttempt {
    const input = recordMiniMainClaudeSessionAttemptOutcomeSchema.parse(inputValue);
    return this.runImmediateTransaction(() => {
      const attemptKey = {
        providerId: input.providerId,
        lilacSessionId: input.lilacSessionId,
        requestId: input.requestId,
        attemptIndex: input.attemptIndex,
      };
      const current = this.getMiniMainClaudeSessionAttempt(attemptKey);
      if (current === null) throw new Error(`Claude attempt '${input.requestId}' was not found`);
      if (current.state !== "active") {
        if (current.state === input.state) return current;
        throw new Error(
          `Claude attempt '${input.requestId}' is already terminal as '${current.state}'`,
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
      if (updated.changes !== 1) throw new Error("Claude attempt outcome lost its active fence");
      this.pruneMiniMainClaudeAttempts(input.lilacSessionId, input.providerId);
      const attempt = this.getMiniMainClaudeSessionAttempt(attemptKey);
      if (attempt === null)
        throw new Error("Updated Claude attempt exceeded retention immediately");
      return attempt;
    });
  }

  getSessionHistory(sessionId: string): StoredSessionHistory {
    const row = this.database
      .query("SELECT * FROM session_history WHERE session_id = ?")
      .get(sessionId);
    if (!row) throw new Error(`Session '${sessionId}' has no history cursor`);
    return toSessionHistory(row);
  }

  getHistoryNavigation(sessionId: string): StoredHistoryNavigation {
    const history = this.getSessionHistory(sessionId);
    return {
      currentStateId: history.currentStateId,
      canUndo: this.findLatestUndoableUserTransition(sessionId) !== null,
      canRedo: this.peekHistoryRedo(sessionId) !== null,
    };
  }

  findLatestUndoableUserTransition(sessionId: string): StoredHistoryTransition | null {
    const row = this.database
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
      .get(sessionId, sessionId, sessionId);
    return row ? toHistoryTransition(row) : null;
  }

  peekHistoryRedo(sessionId: string): StoredHistoryRedoEntry | null {
    const row = this.database
      .query(
        `SELECT * FROM history_redo_stack
         WHERE session_id = ? ORDER BY position DESC LIMIT 1`,
      )
      .get(sessionId);
    return row ? toHistoryRedoEntry(row) : null;
  }

  listHistoryTopology(sessionId: string): StoredHistoryTopology {
    return {
      history: this.getSessionHistory(sessionId),
      states: this.database
        .query("SELECT * FROM history_states WHERE session_id = ? ORDER BY created_at, rowid")
        .all(sessionId)
        .map(toHistoryState),
      transitions: this.database
        .query("SELECT * FROM history_transitions WHERE session_id = ? ORDER BY created_at, rowid")
        .all(sessionId)
        .map(toHistoryTransition),
      redoStack: this.database
        .query("SELECT * FROM history_redo_stack WHERE session_id = ? ORDER BY position")
        .all(sessionId)
        .map(toHistoryRedoEntry),
    };
  }

  getHistoryAccounting(workspaceId?: string): StoredHistoryAccounting {
    const filter = workspaceId === undefined ? null : z.string().min(1).parse(workspaceId);
    if (
      filter !== null &&
      !this.database.query("SELECT 1 FROM workspaces WHERE id = ?").get(filter)
    ) {
      throw new Error(`Workspace '${filter}' was not found`);
    }
    const row = historyAccountingRowSchema.parse(
      this.database
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
    );
    return {
      stateCount: row.state_count,
      transitionCount: row.transition_count,
      branchTipCount: row.branch_tip_count,
      snapshotCount: row.snapshot_count,
      redoStackCount: row.redo_stack_count,
      activeOperationCount: row.active_operation_count,
      pendingFinalizationCount: row.pending_finalization_count,
    };
  }

  internHistoryTranscriptHeads(
    sessionId: string,
    modelMessages: readonly ModelMessage[],
    uiMessages: readonly MiniLilacUIMessage[],
  ): InternedStoredTranscriptHeads {
    modelMessagesSchema.parse(modelMessages);
    miniLilacMessagesSchema.parse(uiMessages);
    this.getSession(sessionId);
    return this.database.transaction(() => ({
      modelHeadId: this.internChain(sessionId, "model", modelMessages),
      uiHeadId: this.internChain(sessionId, "ui", uiMessages),
    }))();
  }

  admitRootPromptHistory(input: AdmitStoredRootPromptHistory): AdmittedStoredRootPromptHistory {
    if (input.run.parentRunId !== undefined) {
      throw new Error("Root prompt history admission requires a root run");
    }
    modelMessagesSchema.parse(input.modelMessages);
    miniLilacMessagesSchema.parse(input.uiMessages);
    if (input.observation !== undefined) parseHistoryWorkspaceOutcome(input.observation);
    const userMessage = miniLilacUserUIMessageSchema.parse(input.uiMessages.at(-1));
    if (input.modelMessages.at(-1)?.role !== "user") {
      throw new Error("Root prompt history admission requires a final model user message");
    }
    const command = canonicalCommandPayload(input.commandPayload);
    return this.runImmediateTransaction(() => {
      this.requireQuiescentHistorySession(input.run.sessionId, input.expectedCurrentStateId);
      const workspace = this.getWorkspaceForSession(input.run.sessionId);
      this.assertWorkspaceHasNoHistoryJournal(workspace.id);
      const current = this.getCurrentHistoryState(input.run.sessionId);
      const prefixHeads = {
        modelHeadId: this.internChain(
          input.run.sessionId,
          "model",
          input.modelMessages.slice(0, -1),
        ),
        uiHeadId: this.internChain(input.run.sessionId, "ui", input.uiMessages.slice(0, -1)),
      };
      this.assertHeadsEqualState(input.run.sessionId, prefixHeads, current);
      if (current.workspaceStatus === "capture-deferred" && input.observation === undefined) {
        throw new Error("A deferred history root requires an observed workspace boundary");
      }
      let fromState = current;
      if (input.observation !== undefined) {
        fromState = this.insertWorkspaceObservation(
          input.run.sessionId,
          current,
          prefixHeads,
          input.observation,
        );
        this.moveHistoryCursor(input.run.sessionId, fromState);
      }
      const fullHeads = {
        modelHeadId: this.internChain(input.run.sessionId, "model", input.modelMessages),
        uiHeadId: this.internChain(input.run.sessionId, "ui", input.uiMessages),
      };
      const commandRow = this.getStoredCommand(input.run.sessionId, input.commandId);
      if (
        commandRow.kind !== "prompt" ||
        commandRow.run_id !== null ||
        commandRow.side_effect_started !== 0 ||
        commandRow.result_json !== null ||
        commandRow.request_fingerprint !== command.fingerprint ||
        commandRow.request_json !== command.json
      ) {
        throw new Error(`Prompt command '${input.commandId}' is not an admissible reservation`);
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
        throw new Error(`Prompt command '${input.commandId}' could not be assigned atomically`);
      }
      this.insertHistoryTransitionRow({
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
        throw new Error(
          `Session '${input.run.sessionId}' could not admit root run '${input.run.id}'`,
        );
      }
      return {
        snapshot: this.getSession(input.run.sessionId),
        fromState,
        transition: this.getHistoryTransition(input.transitionId),
      };
    });
  }

  commitSteeringHistoryBoundary(
    input: CommitStoredSteeringBoundary,
  ): CommittedStoredSteeringBoundary {
    if (input.entries.length === 0)
      throw new Error("A steering boundary requires at least one entry");
    parseHistoryWorkspaceOutcome(input.workspace);
    modelMessagesSchema.parse(input.mergedModelMessages);
    miniLilacMessagesSchema.parse(input.uiMessages);
    input.entries.forEach((entry, index) => {
      miniLilacUserUIMessageSchema.parse(entry.message);
      modelMessagesSchema.parse([entry.modelMessage]);
      if (entry.modelMessage.role !== "user") {
        throw new Error("Every steering entry requires one canonical model user message");
      }
      z.number().int().nonnegative().parse(entry.replayAfterSeq);
      if (index < input.entries.length - 1 !== (entry.intermediateStateId !== undefined)) {
        throw new Error(
          "Every non-final steering entry requires exactly one intermediate state ID",
        );
      }
    });
    const firstUiPosition = input.uiMessages.length - input.entries.length;
    if (firstUiPosition < 0) throw new Error("Steering UI messages do not contain every entry");
    const firstModelPosition = input.mergedModelMessages.length - input.entries.length;
    if (firstModelPosition < 0) {
      throw new Error("Steering model messages do not contain every entry");
    }
    input.entries.forEach((entry, index) => {
      if (!canonicalValuesEqual(input.uiMessages[firstUiPosition + index], entry.message)) {
        throw new Error("Steering entries must be the exact final canonical UI suffix");
      }
      if (
        !canonicalValuesEqual(
          input.mergedModelMessages[firstModelPosition + index],
          entry.modelMessage,
        )
      ) {
        throw new Error("Steering entries must be the exact final canonical model suffix");
      }
    });
    return this.runImmediateTransaction(() => {
      const session = this.getSession(input.sessionId);
      const activeRun = this.getActiveRootRun(input.sessionId);
      if (
        session.status !== "streaming" ||
        activeRun?.id !== input.rootRunId ||
        activeRun.parentRunId !== null
      ) {
        throw new Error(`Run '${input.rootRunId}' is not the active root run`);
      }
      const workspace = this.getWorkspaceForSession(input.sessionId);
      this.assertWorkspaceHasNoHistoryJournal(workspace.id);
      const previous = this.getHistoryTransition(input.previousOpenTransitionId);
      if (
        previous.sessionId !== input.sessionId ||
        previous.toStateId !== null ||
        previous.rootRunId !== input.rootRunId ||
        this.getSessionHistory(input.sessionId).currentStateId !== previous.fromStateId
      ) {
        throw new Error(
          `Transition '${input.previousOpenTransitionId}' is not the active boundary`,
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
      const canonicalUiMessages = this.getUiMessages(input.sessionId);
      const baseUiMessages = input.uiMessages.slice(0, firstUiPosition);
      if (!isCanonicalPrefix(canonicalUiMessages, baseUiMessages)) {
        throw new Error("Steering UI boundary does not extend the canonical live transcript");
      }
      const fromState = this.getHistoryState(previous.fromStateId);
      const providerState =
        input.providerState === undefined
          ? fromState.providerState
          : historyProviderStateSchema.parse(input.providerState);
      if (input.providerState !== undefined) {
        this.assertConservativeProviderTransition(
          fromState.id,
          historyProviderStateSchema.parse(input.providerState),
        );
      }
      const fromUiMessages = miniLilacMessagesSchema.parse(
        this.readSerializedChain(input.sessionId, "ui", fromState.uiHeadId).map(deserialize),
      );
      if (
        previous.userMessage === null ||
        !canonicalValuesEqual(canonicalUiMessages[fromUiMessages.length], previous.userMessage) ||
        !canonicalValuesEqual(baseUiMessages[fromUiMessages.length], previous.userMessage)
      ) {
        throw new Error("Steering boundary does not retain the active user message");
      }
      const boundaryState: CreateStoredHistoryState = {
        id: input.boundaryStateId,
        sessionId: input.sessionId,
        workspaceId: workspace.id,
        modelHeadId: baseHeads.modelHeadId,
        uiHeadId: baseHeads.uiHeadId,
        ...input.workspace,
        origin: "turn-boundary",
        providerState,
      };
      this.closeHistoryTransition(input.previousOpenTransitionId, boundaryState, { select: true });
      let currentState = this.getHistoryState(input.boundaryStateId);
      for (const [index, entry] of input.entries.entries()) {
        const commandRow = this.getStoredCommand(input.sessionId, entry.commandId);
        if (
          commandRow.kind !== "steer" ||
          commandRow.run_id !== input.rootRunId ||
          commandRow.side_effect_started !== 1 ||
          commandRow.result_json === null
        ) {
          throw new Error(
            `Steering command '${entry.commandId}' is not admitted for this root run`,
          );
        }
        const commandPayload = storedSteeringCommandPayloadSchema.parse(
          z.json().parse(JSON.parse(commandRow.request_json)),
        );
        if (
          !canonicalValuesEqual(commandPayload.message, entry.message) ||
          (commandPayload.sessionId !== undefined &&
            commandPayload.sessionId !== input.sessionId) ||
          (commandPayload.runId !== undefined && commandPayload.runId !== input.rootRunId) ||
          (commandPayload.clientCommandId !== undefined &&
            commandPayload.clientCommandId !== entry.commandId)
        ) {
          throw new Error(
            `Steering command '${entry.commandId}' request does not match its boundary entry`,
          );
        }
        this.insertHistoryTransitionRow({
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
          this.closeHistoryTransition(
            entry.transitionId,
            {
              id: entry.intermediateStateId,
              sessionId: input.sessionId,
              workspaceId: workspace.id,
              modelHeadId: nextModelHeadId,
              uiHeadId: nextUiHeadId,
              ...input.workspace,
              origin: "turn-boundary",
              providerState,
            },
            { select: true },
          );
          currentState = this.getHistoryState(entry.intermediateStateId);
        }
      }
      const finalEntry = input.entries.at(-1);
      if (finalEntry === undefined) throw new Error("Steering boundary lost its final entry");
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
        throw new Error("Steering boundary consumed more entries than the session has queued");
      }
      return {
        currentState,
        openTransition: this.getHistoryTransition(finalEntry.transitionId),
      };
    });
  }

  commitHistoryCompaction(input: CommitStoredHistoryCompaction): CommittedStoredHistoryCompaction {
    modelMessagesSchema.parse(input.modelMessages);
    if (Object.prototype.hasOwnProperty.call(input, "uiMessages")) {
      throw new Error("Manual history compaction does not accept a replacement UI transcript");
    }
    const result = miniLilacCompactResultSchema.parse(input.result);
    const compactionEvent = miniLilacCompactionEventSchema.parse(input.compactionEvent);
    if (result.clientCommandId !== input.commandId) {
      throw new Error(`Compaction result does not belong to command '${input.commandId}'`);
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
      throw new Error("Manual compaction event does not match its compact result");
    }
    parseHistoryWorkspaceOutcome(input);
    if (input.observation !== undefined) parseHistoryWorkspaceOutcome(input.observation);
    if (input.request.kind !== "compact" || input.request.runId !== null) {
      throw new Error("History compaction requires a session-scoped compact command");
    }
    const command = canonicalCommandPayload(input.request.payload);
    return this.runImmediateTransaction(() => {
      this.requireQuiescentHistorySession(input.sessionId, input.expectedCurrentStateId, [
        "idle",
        "error",
        "compacting",
      ]);
      const workspace = this.getWorkspaceForSession(input.sessionId);
      this.assertWorkspaceHasNoHistoryJournal(workspace.id);
      const commandRow = this.getStoredCommand(input.sessionId, input.commandId);
      if (
        commandRow.kind !== input.request.kind ||
        commandRow.run_id !== null ||
        commandRow.side_effect_started !== 0 ||
        commandRow.result_json !== null ||
        commandRow.request_fingerprint !== command.fingerprint ||
        commandRow.request_json !== command.json
      ) {
        throw new Error(`Compaction command '${input.commandId}' is not an admissible reservation`);
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
          throw new Error(`Compaction command '${input.commandId}' could not be saved atomically`);
        }
        this.database
          .query(
            `UPDATE sessions SET status = 'idle', active_run_id = NULL,
               queued_steering_count = 0, updated_at = ? WHERE id = ?`,
          )
          .run(now, input.sessionId);
        return {
          state: this.getCurrentHistoryState(input.sessionId),
          snapshot: this.getSession(input.sessionId),
        };
      }
      let fromState = this.getCurrentHistoryState(input.sessionId);
      if (input.observation !== undefined) {
        fromState = this.insertWorkspaceObservation(
          input.sessionId,
          fromState,
          { modelHeadId: fromState.modelHeadId, uiHeadId: fromState.uiHeadId },
          input.observation,
        );
        this.moveHistoryCursor(input.sessionId, fromState);
      }
      if (input.providerState !== undefined) {
        this.assertConservativeProviderTransition(
          fromState.id,
          historyProviderStateSchema.parse(input.providerState),
        );
      }
      const heads = {
        modelHeadId: this.internChain(input.sessionId, "model", input.modelMessages),
        uiHeadId: this.internChain(input.sessionId, "ui", [
          ...this.getUiMessages(input.sessionId),
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
      const appended = this.appendHistoryTransition({
        state: {
          id: input.stateId,
          sessionId: input.sessionId,
          workspaceId: workspace.id,
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
      this.setHistoryUndoFloor(input.sessionId, appended.state.id);
      const saved = this.database
        .query(
          `UPDATE commands SET side_effect_started = 1, result_json = ?
           WHERE session_id = ? AND command_id = ? AND side_effect_started = 0
             AND result_json IS NULL`,
        )
        .run(serialize(result), input.sessionId, input.commandId);
      if (saved.changes !== 1) {
        throw new Error(`Compaction command '${input.commandId}' could not be saved atomically`);
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
      return { state: appended.state, snapshot: this.getSession(input.sessionId) };
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
    return this.database.transaction(() => {
      if (input.state.sessionId !== input.transition.sessionId) {
        throw new Error(`History transition '${input.transition.id}' crosses sessions`);
      }
      this.insertHistoryStateRow(input.state);
      this.insertHistoryTransitionRow({ ...input.transition, toStateId: input.state.id });
      if (input.clearRedo) {
        this.database
          .query("DELETE FROM history_redo_stack WHERE session_id = ?")
          .run(input.state.sessionId);
      }
      if (input.select) {
        const history = this.getSessionHistory(input.state.sessionId);
        if (
          !this.isStateInAncestry(input.state.sessionId, input.state.id, history.undoFloorStateId)
        ) {
          throw new Error(`History state '${input.state.id}' is below the current undo floor`);
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
          throw new Error(`Session '${input.state.sessionId}' has no history cursor`);
        }
      }
      return {
        state: this.getHistoryState(input.state.id),
        transition: this.getHistoryTransition(input.transition.id),
      };
    })();
  }

  private closeHistoryTransition(
    transitionId: string,
    destination: CreateStoredHistoryState,
    options: { readonly select?: boolean; readonly clearRedo?: boolean } = {},
  ): StoredHistoryTransition {
    return this.database.transaction(() => {
      const transition = this.getHistoryTransition(transitionId);
      if (transition.toStateId !== null || transition.kind !== "user-message") {
        throw new Error(`History transition '${transitionId}' is not an open user transition`);
      }
      if (
        destination.sessionId !== transition.sessionId ||
        destination.origin !== "turn-boundary"
      ) {
        throw new Error(`History transition '${transitionId}' has an invalid destination state`);
      }
      this.assertStateConnectedToRoot(transition.sessionId, transition.fromStateId);
      this.insertHistoryStateRow(destination);
      this.validateHistoryTransitionDestination(
        transition.sessionId,
        transition.fromStateId,
        destination.id,
        transition.kind,
      );
      const completedAt = new Date().toISOString();
      const updated = this.database
        .query(
          `UPDATE history_transitions SET to_state_id = ?, completed_at = ?
           WHERE id = ? AND to_state_id IS NULL AND completed_at IS NULL`,
        )
        .run(destination.id, completedAt, transitionId);
      if (updated.changes !== 1) {
        throw new Error(`History transition '${transitionId}' could not be closed`);
      }
      if (options.clearRedo) {
        this.database
          .query("DELETE FROM history_redo_stack WHERE session_id = ?")
          .run(transition.sessionId);
      }
      if (options.select) {
        const history = this.getSessionHistory(transition.sessionId);
        if (
          !this.isStateInAncestry(transition.sessionId, destination.id, history.undoFloorStateId)
        ) {
          throw new Error(`History state '${destination.id}' is below the current undo floor`);
        }
        this.setTranscriptHeads(
          transition.sessionId,
          destination.modelHeadId,
          destination.uiHeadId,
        );
        this.database
          .query(
            `UPDATE session_history SET current_state_id = ?, updated_at = ?
             WHERE session_id = ?`,
          )
          .run(destination.id, new Date().toISOString(), transition.sessionId);
      }
      return this.getHistoryTransition(transitionId);
    })();
  }

  private setHistoryUndoFloor(sessionId: string, stateId: string): void {
    this.database.transaction(() => {
      const state = this.getHistoryState(stateId);
      if (state.sessionId !== sessionId) {
        throw new Error(`History state '${stateId}' does not belong to session '${sessionId}'`);
      }
      this.assertStateConnectedToRoot(sessionId, stateId);
      const currentStateId = this.getSessionHistory(sessionId).currentStateId;
      if (!this.isStateInAncestry(sessionId, currentStateId, stateId)) {
        throw new Error(`History state '${stateId}' is not an ancestor of the current state`);
      }
      const updated = this.database
        .query(
          `UPDATE session_history SET undo_floor_state_id = ?, updated_at = ?
           WHERE session_id = ?`,
        )
        .run(stateId, new Date().toISOString(), sessionId);
      if (updated.changes !== 1) throw new Error(`Session '${sessionId}' has no history cursor`);
    })();
  }

  private pushHistoryRedo(
    sessionId: string,
    targetStateId: string,
    userTransitionId: string,
  ): StoredHistoryRedoEntry {
    return this.database.transaction(() => {
      const target = this.getHistoryState(targetStateId);
      const transition = this.getHistoryTransition(userTransitionId);
      if (
        target.sessionId !== sessionId ||
        transition.sessionId !== sessionId ||
        transition.kind !== "user-message" ||
        transition.toStateId === null ||
        !this.isStateInAncestry(sessionId, targetStateId, transition.toStateId)
      ) {
        throw new Error(`Invalid redo entry for session '${sessionId}'`);
      }
      this.assertStateConnectedToRoot(sessionId, targetStateId);
      const position = z.object({ position: z.number().int().nonnegative() }).parse(
        this.database
          .query(
            `SELECT COALESCE(MAX(position), -1) + 1 AS position
               FROM history_redo_stack WHERE session_id = ?`,
          )
          .get(sessionId),
      ).position;
      this.database
        .query(
          `INSERT INTO history_redo_stack
            (session_id, position, target_state_id, user_transition_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(sessionId, position, targetStateId, userTransitionId, new Date().toISOString());
      const entry = this.peekHistoryRedo(sessionId);
      if (entry === null) throw new Error(`Redo entry for session '${sessionId}' was not created`);
      return entry;
    })();
  }

  private popHistoryRedo(sessionId: string): StoredHistoryRedoEntry | null {
    return this.database.transaction(() => {
      const entry = this.peekHistoryRedo(sessionId);
      if (entry === null) return null;
      this.database
        .query("DELETE FROM history_redo_stack WHERE session_id = ? AND position = ?")
        .run(sessionId, entry.position);
      return entry;
    })();
  }

  private clearHistoryRedo(sessionId: string): void {
    this.database.query("DELETE FROM history_redo_stack WHERE session_id = ?").run(sessionId);
  }

  commitEmptyHistoryNavigation(
    input: CommitEmptyStoredHistoryNavigation,
  ): CommittedEmptyStoredHistoryNavigation {
    if (input.request.kind !== input.requestedAction || input.request.runId !== null) {
      throw new Error("Empty history navigation requires a matching session-scoped command");
    }
    if (
      z.object({ status: z.enum(["undone", "redone", "empty"]) }).parse(input.result).status !==
      "empty"
    ) {
      throw new Error("Empty history navigation must persist an empty result");
    }
    const result = this.parseHistoryNavigationResult(
      input.requestedAction,
      input.result,
      input.commandId,
      null,
    );
    if (result.status !== "empty") {
      throw new Error("Empty history navigation must persist an empty result");
    }
    const canonicalCommand = canonicalCommandPayload(input.request.payload);
    return this.runImmediateTransaction(() => {
      const command = this.getStoredCommand(input.sessionId, input.commandId);
      if (
        command.kind !== input.requestedAction ||
        command.run_id !== null ||
        command.request_fingerprint !== canonicalCommand.fingerprint ||
        command.request_json !== canonicalCommand.json
      ) {
        throw new Error(`Command '${input.commandId}' does not own this history navigation`);
      }
      if (command.result_json !== null) {
        const replayed = this.parseHistoryNavigationResult(
          input.requestedAction,
          deserialize(command.result_json),
          input.commandId,
          null,
        );
        if (replayed.status !== "empty") {
          throw new Error(`Command '${input.commandId}' already has a non-empty result`);
        }
        return {
          result: replayed,
          replayed: true,
          navigation: this.getHistoryNavigation(input.sessionId),
        };
      }
      if (command.side_effect_started !== 0) {
        throw new Error(`Command '${input.commandId}' has an incomplete history side effect`);
      }
      const history = this.getSessionHistory(input.sessionId);
      this.requireQuiescentHistorySession(input.sessionId, history.currentStateId);
      const workspace = this.getWorkspaceForSession(input.sessionId);
      this.assertWorkspaceHasNoHistoryJournal(workspace.id);
      const hasTarget =
        input.requestedAction === "undo"
          ? this.findLatestUndoableUserTransition(input.sessionId) !== null
          : this.peekHistoryRedo(input.sessionId) !== null;
      if (hasTarget) {
        throw new Error(`History ${input.requestedAction} is no longer empty`);
      }
      const saved = this.database
        .query(
          `UPDATE commands SET side_effect_started = 1, result_json = ?
           WHERE session_id = ? AND command_id = ? AND kind = ? AND run_id IS NULL
             AND side_effect_started = 0 AND result_json IS NULL`,
        )
        .run(serialize(result), input.sessionId, input.commandId, input.requestedAction);
      if (saved.changes !== 1) {
        throw new Error(`Command '${input.commandId}' empty result could not be saved atomically`);
      }
      return {
        result,
        replayed: false,
        navigation: this.getHistoryNavigation(input.sessionId),
      };
    });
  }

  reserveHistoryOperation(input: ReserveStoredHistoryOperation): ReservedStoredHistoryOperation {
    historyOperationActionSchema.parse(input.requestedAction);
    historyFilesystemModeSchema.parse(input.filesystemMode);
    if (input.filesystemMode === "restore" && input.skipReason !== null) {
      throw new Error("Restore-mode history operations cannot have a skip reason");
    }
    if (input.filesystemMode === "skip") historySkipReasonSchema.parse(input.skipReason);
    if (input.observation !== undefined) parseHistoryWorkspaceOutcome(input.observation);
    return this.runImmediateTransaction(() => {
      this.requireQuiescentHistorySession(input.sessionId, input.expectedSourceStateId);
      const workspace = this.getWorkspaceForSession(input.sessionId);
      this.assertWorkspaceHasNoHistoryJournal(workspace.id);
      const command = this.getStoredCommand(input.sessionId, input.commandId);
      if (
        command.kind !== input.requestedAction ||
        command.run_id !== null ||
        command.result_json !== null ||
        command.side_effect_started !== 0
      ) {
        throw new Error(`Command '${input.commandId}' cannot reserve a history operation`);
      }
      const source = this.getCurrentHistoryState(input.sessionId);
      const transition = this.getHistoryTransition(input.userTransitionId);
      if (
        transition.sessionId !== input.sessionId ||
        transition.kind !== "user-message" ||
        transition.toStateId === null
      ) {
        throw new Error(
          `History operation transition '${input.userTransitionId}' is not completed`,
        );
      }
      this.assertStateConnectedToRoot(input.sessionId, input.targetStateId);
      let observedState: StoredHistoryState | null = null;
      if (input.observation !== undefined) {
        observedState = this.insertWorkspaceObservation(
          input.sessionId,
          source,
          { modelHeadId: source.modelHeadId, uiHeadId: source.uiHeadId },
          input.observation,
        );
      }
      if (input.requestedAction === "undo" && transition.fromStateId !== input.targetStateId) {
        throw new Error("Undo history operation target must be its user transition source");
      }
      if (
        input.requestedAction === "undo" &&
        this.findLatestUndoableUserTransition(input.sessionId)?.id !== input.userTransitionId
      ) {
        throw new Error(
          "Undo history operation must use the latest transition above the undo floor",
        );
      }
      const redo = this.peekHistoryRedo(input.sessionId);
      if (
        input.requestedAction === "redo" &&
        (redo?.targetStateId !== input.targetStateId ||
          redo.userTransitionId !== input.userTransitionId)
      ) {
        throw new Error("Redo history operation target must match the top redo entry");
      }
      if (
        input.requestedAction === "redo" &&
        transition.toStateId !== null &&
        !this.isStateInAncestry(input.sessionId, input.targetStateId, transition.toStateId)
      ) {
        throw new Error("Redo target must descend from its user transition destination");
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
        throw new Error(`Command '${input.commandId}' could not begin its history operation`);
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
          workspace.id,
          input.commandId,
          input.requestedAction,
          source.id,
          observedState?.id ?? null,
          input.targetStateId,
          input.userTransitionId,
          input.filesystemMode,
          input.skipReason,
          now,
          now,
        );
      const operation = this.getHistoryOperation(input.id);
      if (operation === null) throw new Error(`History operation '${input.id}' was not created`);
      return { operation, observedState };
    });
  }

  getHistoryOperation(operationId: string): StoredHistoryOperation | null {
    const row = this.database
      .query("SELECT * FROM history_operations WHERE id = ?")
      .get(operationId);
    return row ? toHistoryOperation(row) : null;
  }

  listHistoryOperations(): readonly StoredHistoryOperation[] {
    return this.database
      .query("SELECT * FROM history_operations ORDER BY prepared_at, rowid")
      .all()
      .map(toHistoryOperation);
  }

  skipPreparedHistoryRestore(
    operationId: string,
    reasonValue: z.infer<typeof historySkipReasonSchema>,
  ): StoredHistoryOperation {
    const reason = historySkipReasonSchema.parse(reasonValue);
    return this.runImmediateTransaction(() => {
      const operation = this.getHistoryOperation(operationId);
      if (operation === null) throw new Error(`History operation '${operationId}' was not found`);
      if (operation.filesystemMode !== "restore" || operation.phase !== "prepared") {
        throw new Error(`History operation '${operationId}' cannot skip its prepared restore`);
      }
      const updated = this.database
        .query(
          `UPDATE history_operations
           SET filesystem_mode = 'skip', skip_reason = ?, updated_at = ?
           WHERE id = ? AND filesystem_mode = 'restore' AND phase = 'prepared'`,
        )
        .run(reason, new Date().toISOString(), operationId);
      if (updated.changes !== 1) {
        throw new Error(`History operation '${operationId}' could not skip its prepared restore`);
      }
      const skipped = this.getHistoryOperation(operationId);
      if (skipped === null) throw new Error(`History operation '${operationId}' disappeared`);
      return skipped;
    });
  }

  updateHistoryOperationPhase(
    operationId: string,
    phaseValue: z.infer<typeof historyOperationPhaseSchema>,
  ): StoredHistoryOperation {
    const phase = historyOperationPhaseSchema.parse(phaseValue);
    return this.runImmediateTransaction(() => {
      const operation = this.getHistoryOperation(operationId);
      if (operation === null) throw new Error(`History operation '${operationId}' was not found`);
      const allowed =
        operation.phase === phase ||
        (operation.filesystemMode === "restore" &&
          ((operation.phase === "prepared" && phase === "restoring") ||
            (operation.phase === "restoring" && phase === "verified"))) ||
        (operation.filesystemMode === "skip" &&
          operation.phase === "prepared" &&
          phase === "verified");
      if (!allowed) {
        throw new Error(
          `History operation '${operationId}' cannot move from '${operation.phase}' to '${phase}'`,
        );
      }
      this.database
        .query("UPDATE history_operations SET phase = ?, updated_at = ? WHERE id = ?")
        .run(phase, new Date().toISOString(), operationId);
      const updated = this.getHistoryOperation(operationId);
      if (updated === null) throw new Error(`History operation '${operationId}' was not found`);
      return updated;
    });
  }

  commitHistoryNavigation(input: CommitStoredHistoryNavigation): CommittedStoredHistoryNavigation {
    return this.runImmediateTransaction(() => {
      const operation = this.getHistoryOperation(input.operationId);
      if (operation === null)
        throw new Error(`History operation '${input.operationId}' was not found`);
      if (
        (operation.filesystemMode === "restore" && operation.phase !== "verified") ||
        (operation.filesystemMode === "skip" && !["prepared", "verified"].includes(operation.phase))
      ) {
        throw new Error(`History operation '${input.operationId}' is not ready to commit`);
      }
      this.assertWorkspaceHistoryAvailableForOwner(operation.workspaceId, operation.sessionId, {
        kind: "history-operation",
        operationId: operation.id,
      });
      this.requireQuiescentHistorySession(operation.sessionId, operation.sourceStateId);
      const source = this.getHistoryState(operation.sourceStateId);
      const target = this.getHistoryState(operation.targetStateId);
      const transition = this.getHistoryTransition(operation.userTransitionId);
      if (
        source.sessionId !== operation.sessionId ||
        target.sessionId !== operation.sessionId ||
        transition.sessionId !== operation.sessionId ||
        transition.kind !== "user-message" ||
        transition.toStateId === null
      ) {
        throw new Error(`History operation '${input.operationId}' has incoherent ownership`);
      }
      const result = this.parseHistoryNavigationResult(
        operation.requestedAction,
        input.result,
        operation.commandId,
        transition.userMessage,
      );
      const expectedStatus = operation.requestedAction === "undo" ? "undone" : "redone";
      if (result.status === "empty" || result.status !== expectedStatus) {
        throw new Error(
          `History operation '${input.operationId}' requires a '${expectedStatus}' result`,
        );
      }
      if (result.historyStateId !== operation.targetStateId) {
        throw new Error(`History operation '${input.operationId}' result names the wrong state`);
      }
      let expectedFilesystem: MiniLilacHistoryFilesystemResult;
      if (operation.filesystemMode === "restore") {
        expectedFilesystem = miniLilacHistoryFilesystemResultSchema.parse({ status: "restored" });
      } else {
        if (operation.skipReason === null) {
          throw new Error(`History operation '${input.operationId}' has no filesystem skip reason`);
        }
        expectedFilesystem = miniLilacHistoryFilesystemResultSchema.parse({
          status: "skipped",
          reason: operation.skipReason,
        });
      }
      if (!canonicalValuesEqual(result.filesystem, expectedFilesystem)) {
        throw new Error(
          `History operation '${input.operationId}' result has the wrong filesystem outcome`,
        );
      }
      let redoTarget = source;
      if (operation.observedSourceStateId !== null) {
        const observed = this.getHistoryState(operation.observedSourceStateId);
        const incoming = this.getIncomingHistoryTransition(
          operation.sessionId,
          operation.observedSourceStateId,
        );
        if (
          observed.modelHeadId !== source.modelHeadId ||
          observed.uiHeadId !== source.uiHeadId ||
          incoming?.kind !== "workspace-observation" ||
          incoming.fromStateId !== source.id
        ) {
          throw new Error(`History operation '${input.operationId}' has an invalid observation`);
        }
        redoTarget = observed;
      }
      if (operation.requestedAction === "undo") {
        if (
          transition.fromStateId !== target.id ||
          this.findLatestUndoableUserTransition(operation.sessionId)?.id !== transition.id ||
          !this.isStateInAncestry(operation.sessionId, redoTarget.id, transition.toStateId)
        ) {
          throw new Error(
            `History operation '${input.operationId}' no longer matches undo topology`,
          );
        }
        this.pushHistoryRedo(operation.sessionId, redoTarget.id, transition.id);
      } else {
        const redo = this.peekHistoryRedo(operation.sessionId);
        if (
          redo?.targetStateId !== target.id ||
          redo.userTransitionId !== transition.id ||
          !this.isStateInAncestry(operation.sessionId, target.id, transition.toStateId)
        ) {
          throw new Error(
            `History operation '${input.operationId}' no longer matches redo topology`,
          );
        }
        this.popHistoryRedo(operation.sessionId);
      }
      this.moveHistoryCursor(operation.sessionId, target);
      this.saveHistoryCommandResult(operation, result);
      this.deleteHistoryOperationRow(operation.id);
      return {
        operation,
        currentState: target,
        navigation: this.getHistoryNavigation(operation.sessionId),
      };
    });
  }

  abandonHistoryNavigation(
    input: AcknowledgeStoredHistoryNavigationAbandonment,
  ): StoredHistoryCommandError {
    z.literal(true).parse(input.acknowledgePartialWorktree);
    const parsedMessage = z.string().min(1).parse(input.message);
    return this.runImmediateTransaction(() => {
      const operation = this.getHistoryOperation(input.operationId);
      if (operation === null) {
        throw new Error(`History operation '${input.operationId}' was not found`);
      }
      this.requireQuiescentHistorySession(operation.sessionId, operation.sourceStateId);
      const source = this.getHistoryState(operation.sourceStateId);
      if (operation.observedSourceStateId !== null) {
        const observed = this.getHistoryState(operation.observedSourceStateId);
        const incoming = this.getIncomingHistoryTransition(
          operation.sessionId,
          operation.observedSourceStateId,
        );
        if (
          observed.modelHeadId !== source.modelHeadId ||
          observed.uiHeadId !== source.uiHeadId ||
          incoming?.kind !== "workspace-observation" ||
          incoming.fromStateId !== source.id
        ) {
          throw new Error(`History operation '${input.operationId}' has an invalid observation`);
        }
      }
      const error = storedHistoryCommandErrorSchema.parse({
        type: "history-command-error",
        code: "history-recovery-abandoned",
        commandId: operation.commandId,
        message: parsedMessage,
      });
      this.saveHistoryCommandResult(operation, error);
      this.deleteHistoryOperationRow(operation.id);
      return error;
    });
  }

  reservePendingRunFinalization(
    input: ReservePendingStoredRunFinalization,
  ): PendingStoredRunFinalization {
    modelMessagesSchema.parse(input.modelMessages);
    miniLilacMessagesSchema.parse(input.uiMessages);
    const runStatus = z.enum(["completed", "cancelled", "error"]).parse(input.runStatus);
    const sessionStatus = z.enum(["idle", "error"]).parse(input.sessionStatus);
    const providerState =
      input.providerState === undefined
        ? null
        : historyProviderStateSchema.parse(input.providerState);
    const promotion =
      input.claudeBindingPromotion === undefined
        ? null
        : promoteMiniMainClaudeSessionBindingSchema.parse(input.claudeBindingPromotion);
    if (promotion !== null && providerState?.lastFamily !== "claude-code") {
      throw new Error("A Claude binding promotion requires Claude provider-state metadata");
    }
    if (input.inputTokens !== null) z.number().int().nonnegative().parse(input.inputTokens);
    return this.runImmediateTransaction(() => {
      const workspace = this.getWorkspaceForSession(input.sessionId);
      if (
        this.database
          .query("SELECT 1 FROM history_operations WHERE workspace_id = ?")
          .get(workspace.id)
      ) {
        throw new Error(`Workspace '${workspace.id}' has a retained history operation`);
      }
      if (
        this.database
          .query("SELECT 1 FROM pending_run_finalizations WHERE workspace_id = ?")
          .get(workspace.id)
      ) {
        throw new Error(`Workspace '${workspace.id}' already has a pending run finalization`);
      }
      const activeRun = this.getActiveRootRun(input.sessionId);
      const session = this.getSession(input.sessionId);
      const transition = this.getHistoryTransition(input.openTransitionId);
      if (
        !["streaming", "cancelling"].includes(session.status) ||
        activeRun?.id !== input.runId ||
        transition.sessionId !== input.sessionId ||
        transition.kind !== "user-message" ||
        transition.toStateId !== null ||
        transition.rootRunId !== input.runId ||
        this.getSessionHistory(input.sessionId).currentStateId !== transition.fromStateId
      ) {
        throw new Error(`Pending finalization for run '${input.runId}' is not coherent`);
      }
      const canonicalModelMessages = this.getModelMessages(input.sessionId);
      const canonicalUiMessages = this.getUiMessages(input.sessionId);
      // Automatic in-run compaction can replace the complete model chain and
      // currently has no persisted rewrite provenance. Both chains are schema
      // validated; UI continuity plus the open transition identifies the turn.
      modelMessagesSchema.parse(canonicalModelMessages);
      if (!isCanonicalPrefix(canonicalUiMessages, input.uiMessages)) {
        throw new Error("Final UI transcript does not extend the canonical active transcript");
      }
      const fromState = this.getHistoryState(transition.fromStateId);
      const fromUiMessages = miniLilacMessagesSchema.parse(
        this.readSerializedChain(input.sessionId, "ui", fromState.uiHeadId).map(deserialize),
      );
      const admittedMessage = transition.userMessage;
      if (
        admittedMessage === null ||
        !canonicalValuesEqual(canonicalUiMessages[fromUiMessages.length], admittedMessage) ||
        !canonicalValuesEqual(input.uiMessages[fromUiMessages.length], admittedMessage)
      ) {
        throw new Error("Final UI transcript does not retain the admitted open user message");
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
             prepared_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          input.sessionId,
          workspace.id,
          input.openTransitionId,
          modelHeadId,
          uiHeadId,
          runStatus,
          sessionStatus,
          input.error,
          input.terminalResult === undefined ? null : serialize(input.terminalResult),
          input.inputTokens,
          providerState?.lastFamily ?? null,
          providerState === null ? null : providerState.containsCrossFamilyTurns ? 1 : 0,
          promotion === null ? null : serialize(promotion),
          now,
        );
      const pending = this.getPendingRunFinalization(input.runId);
      if (pending === null)
        throw new Error(`Pending finalization for run '${input.runId}' was not created`);
      return pending;
    });
  }

  getPendingRunFinalization(runId: string): PendingStoredRunFinalization | null {
    const row = this.database
      .query("SELECT * FROM pending_run_finalizations WHERE run_id = ?")
      .get(runId);
    return row ? toPendingRunFinalization(row) : null;
  }

  listPendingRunFinalizations(): readonly PendingStoredRunFinalization[] {
    return this.database
      .query("SELECT * FROM pending_run_finalizations ORDER BY prepared_at, rowid")
      .all()
      .map(toPendingRunFinalization);
  }

  listRecoverableOpenRootRuns(): readonly RecoverableStoredOpenRootRun[] {
    return z
      .array(
        z.object({
          run_id: z.string(),
          session_id: z.string(),
          workspace_id: z.string(),
          open_transition_id: z.string(),
          input_tokens: z.number().int().nonnegative().nullable(),
        }),
      )
      .parse(
        this.database
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
          .all(),
      )
      .map((row) => ({
        runId: row.run_id,
        sessionId: row.session_id,
        workspaceId: row.workspace_id,
        openTransitionId: row.open_transition_id,
        inputTokens: row.input_tokens,
      }));
  }

  recoverInterruptedRuntimeState(): void {
    const now = new Date().toISOString();
    this.runImmediateTransaction(() => {
      this.database
        .query(
          `UPDATE mini_main_claude_attempts SET state = 'uncertain', updated_at = ?
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
      const owners = z.array(z.object({ session_id: z.string(), provider_id: z.string() })).parse(
        this.database
          .query(
            `SELECT DISTINCT session_id, provider_id FROM mini_main_claude_attempts
               ORDER BY session_id, provider_id`,
          )
          .all(),
      );
      for (const owner of owners) {
        this.pruneMiniMainClaudeAttempts(owner.session_id, owner.provider_id);
      }
    });
  }

  commitPendingRunFinalization(
    input: CommitPendingStoredRunFinalization,
  ): CommittedPendingStoredRunFinalization {
    parseHistoryWorkspaceOutcome(input);
    const requestedProviderState =
      input.providerState === undefined
        ? null
        : historyProviderStateSchema.parse(input.providerState);
    const requestedPromotion =
      input.claudeBindingPromotion === undefined
        ? null
        : promoteMiniMainClaudeSessionBindingSchema.parse(input.claudeBindingPromotion);
    return this.runImmediateTransaction(() => {
      const pending = this.getPendingRunFinalization(input.runId);
      if (pending === null)
        throw new Error(`Pending finalization for run '${input.runId}' was not found`);
      if (
        requestedProviderState !== null &&
        pending.providerState !== null &&
        !canonicalValuesEqual(requestedProviderState, pending.providerState)
      ) {
        throw new Error("Pending finalization provider-state metadata changed before commit");
      }
      if (
        requestedPromotion !== null &&
        pending.claudeBindingPromotion !== null &&
        !canonicalValuesEqual(requestedPromotion, pending.claudeBindingPromotion)
      ) {
        throw new Error("Pending finalization Claude promotion metadata changed before commit");
      }
      const providerState = requestedProviderState ?? pending.providerState;
      const promotion = requestedPromotion ?? pending.claudeBindingPromotion;
      if (promotion !== null && providerState?.lastFamily !== "claude-code") {
        throw new Error("A Claude binding promotion requires Claude provider-state metadata");
      }
      this.assertWorkspaceHistoryAvailableForOwner(pending.workspaceId, pending.sessionId, {
        kind: "pending-run-finalization",
        runId: pending.runId,
      });
      const activeRun = this.getActiveRootRun(pending.sessionId);
      const transition = this.getHistoryTransition(pending.openTransitionId);
      const history = this.getSessionHistory(pending.sessionId);
      if (
        activeRun?.id !== pending.runId ||
        transition.sessionId !== pending.sessionId ||
        transition.kind !== "user-message" ||
        transition.toStateId !== null ||
        transition.rootRunId !== pending.runId ||
        history.currentStateId !== transition.fromStateId
      ) {
        throw new Error(`Pending finalization for run '${pending.runId}' is no longer coherent`);
      }
      if (providerState !== null) {
        this.assertConservativeProviderTransition(transition.fromStateId, providerState);
      }
      const destination: CreateStoredHistoryState = {
        id: input.destinationStateId,
        sessionId: pending.sessionId,
        workspaceId: pending.workspaceId,
        modelHeadId: pending.modelHeadId,
        uiHeadId: pending.uiHeadId,
        workspaceSnapshotId: input.workspaceSnapshotId,
        workspaceStatus: input.workspaceStatus,
        workspaceUnavailableReason: input.workspaceUnavailableReason,
        origin: "turn-boundary",
        providerState,
      };
      this.closeHistoryTransition(pending.openTransitionId, destination, { select: true });
      const now = new Date().toISOString();
      const finished = this.database
        .query(
          `UPDATE runs SET status = ?, error = ?, terminal_result_json = ?, finished_at = ?
           WHERE id = ? AND session_id = ? AND parent_run_id IS NULL AND status = 'active'`,
        )
        .run(
          pending.runStatus,
          pending.error,
          pending.terminalResult === undefined ? null : serialize(pending.terminalResult),
          now,
          pending.runId,
          pending.sessionId,
        );
      if (finished.changes !== 1) throw new Error(`Run '${pending.runId}' is not active`);
      const updated = this.database
        .query(
          `UPDATE sessions SET status = ?, active_run_id = NULL, queued_steering_count = 0,
             input_tokens = ?, updated_at = ?
           WHERE id = ? AND active_run_id = ? AND status IN ('streaming', 'cancelling')`,
        )
        .run(pending.sessionStatus, pending.inputTokens, now, pending.sessionId, pending.runId);
      if (updated.changes !== 1) {
        throw new Error(`Run '${pending.runId}' is not active for session '${pending.sessionId}'`);
      }
      const bindingPromotion =
        promotion === null
          ? "not-requested"
          : this.promoteMiniMainClaudeBinding(
                pending,
                this.getRootPromptSourceStateId(pending),
                destination.id,
                promotion,
              )
            ? "promoted"
            : "cas-failed";
      this.deletePendingRunFinalizationRow(pending.runId);
      return {
        pending,
        state: this.getHistoryState(destination.id),
        snapshot: this.getSession(pending.sessionId),
        bindingPromotion,
      };
    });
  }

  private getHistoryStateCanonicalMessageCount(stateId: string): number {
    const state = this.getHistoryState(stateId);
    if (state.modelHeadId === null) return 0;
    return z.object({ depth: z.number().int().positive() }).parse(
      this.database
        .query(
          `SELECT depth FROM transcript_nodes
           WHERE id = ? AND session_id = ? AND lane = 'model'`,
        )
        .get(state.modelHeadId, state.sessionId),
    ).depth;
  }

  private assertConservativeProviderTransition(
    sourceStateId: string,
    destination: HistoryProviderState,
  ): void {
    const source = this.getHistoryState(sourceStateId);
    const sourceMessageCount = this.getHistoryStateCanonicalMessageCount(sourceStateId);
    const requiresMixedHistory =
      source.providerState?.containsCrossFamilyTurns === true ||
      (source.providerState === null && sourceMessageCount > 0) ||
      (source.providerState !== null && source.providerState.lastFamily !== destination.lastFamily);
    if (requiresMixedHistory && !destination.containsCrossFamilyTurns) {
      throw new Error(
        `History state '${sourceStateId}' requires conservative cross-family metadata`,
      );
    }
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

  private getRootPromptSourceStateId(pending: PendingStoredRunFinalization): string {
    const row = z.object({ from_state_id: z.string().min(1) }).parse(
      this.database
        .query(
          `SELECT from_state_id FROM history_transitions
           WHERE session_id = ? AND root_run_id = ? AND kind = 'user-message'
             AND delivery = 'prompt'
           ORDER BY created_at, rowid
           LIMIT 1`,
        )
        .get(pending.sessionId, pending.runId),
    );
    return row.from_state_id;
  }

  private pruneMiniMainClaudeAttempts(sessionId: string, providerId: string): void {
    this.database
      .query(
        `DELETE FROM mini_main_claude_attempts
         WHERE session_id = ? AND provider_id = ? AND state <> 'active' AND id NOT IN (
           SELECT id FROM mini_main_claude_attempts
           WHERE session_id = ? AND provider_id = ?
           ORDER BY CASE WHEN state = 'active' THEN 0 ELSE 1 END, updated_at DESC, id DESC
           LIMIT ?
         )`,
      )
      .run(sessionId, providerId, sessionId, providerId, MINI_MAIN_CLAUDE_ATTEMPT_RETENTION_LIMIT);
  }

  private requireQuiescentHistorySession(
    sessionId: string,
    expectedCurrentStateId: string,
    allowedStatuses: readonly MiniLilacSessionSnapshot["status"][] = ["idle", "error"],
  ): MiniLilacSessionSnapshot {
    const session = this.getSession(sessionId);
    const activeRunCount = z
      .object({ count: z.number().int().nonnegative() })
      .parse(
        this.database
          .query("SELECT COUNT(*) AS count FROM runs WHERE session_id = ? AND status = 'active'")
          .get(sessionId),
      ).count;
    if (
      !allowedStatuses.includes(session.status) ||
      session.activeRunId !== null ||
      activeRunCount !== 0
    ) {
      throw new Error(`Session '${sessionId}' must be quiescent for history navigation`);
    }
    if (
      this.database
        .query("SELECT 1 FROM history_transitions WHERE session_id = ? AND to_state_id IS NULL")
        .get(sessionId)
    ) {
      throw new Error(`Session '${sessionId}' has an open history transition`);
    }
    const current = this.getCurrentHistoryState(sessionId);
    if (current.id !== expectedCurrentStateId) {
      throw new Error(`Session '${sessionId}' history cursor changed before commit`);
    }
    const heads = this.getTranscriptHeads(sessionId);
    this.assertHeadsEqualState(
      sessionId,
      {
        modelHeadId: heads.model_head_id,
        uiHeadId: heads.ui_head_id,
      },
      current,
    );
    return session;
  }

  private assertWorkspaceHasNoHistoryJournal(workspaceId: string): void {
    this.assertWorkspaceHistoryAvailableForOwner(workspaceId, null, undefined);
  }

  private assertWorkspaceHistoryAvailableForOwner(
    workspaceId: string,
    sessionId: string | null,
    owner: WorkspaceHistoryAvailabilityOwner | undefined,
  ): void {
    const workspace = workspaceRowSchema.parse(
      this.database.query("SELECT * FROM workspaces WHERE id = ?").get(workspaceId),
    );
    if (workspace.health_status !== "healthy") {
      throw new Error(`Workspace '${workspaceId}' history store is corrupt`);
    }
    const operations = z
      .array(z.object({ id: z.string(), session_id: z.string() }))
      .parse(
        this.database
          .query("SELECT id, session_id FROM history_operations WHERE workspace_id = ?")
          .all(workspaceId),
      );
    const ownsOperations =
      owner?.kind === "history-operation" &&
      operations.length === 1 &&
      operations[0]?.id === owner.operationId &&
      operations[0].session_id === sessionId;
    if (operations.length > 0 && !ownsOperations) {
      throw new Error(`Workspace '${workspaceId}' has a retained history operation`);
    }
    const finalizations = z
      .array(z.object({ run_id: z.string(), session_id: z.string() }))
      .parse(
        this.database
          .query("SELECT run_id, session_id FROM pending_run_finalizations WHERE workspace_id = ?")
          .all(workspaceId),
      );
    const ownsFinalization =
      owner?.kind === "pending-run-finalization" &&
      finalizations.length === 1 &&
      finalizations[0]?.run_id === owner.runId &&
      finalizations[0].session_id === sessionId;
    if (finalizations.length > 0 && !ownsFinalization) {
      throw new Error(`Workspace '${workspaceId}' has a pending run finalization`);
    }
  }

  private assertHeadsEqualState(
    sessionId: string,
    heads: InternedStoredTranscriptHeads,
    state: StoredHistoryState,
  ): void {
    if (
      state.sessionId !== sessionId ||
      heads.modelHeadId !== state.modelHeadId ||
      heads.uiHeadId !== state.uiHeadId
    ) {
      throw new Error(
        `Session '${sessionId}' canonical transcript does not match its history cursor ` +
          `(model ${heads.modelHeadId}/${state.modelHeadId}, ui ${heads.uiHeadId}/${state.uiHeadId})`,
      );
    }
  }

  private insertWorkspaceObservation(
    sessionId: string,
    source: StoredHistoryState,
    heads: InternedStoredTranscriptHeads,
    observation: StoredHistoryObservationInput,
  ): StoredHistoryState {
    this.assertHeadsEqualState(sessionId, heads, source);
    return this.appendHistoryTransition({
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
    }).state;
  }

  private moveHistoryCursor(sessionId: string, state: StoredHistoryState): void {
    this.assertStateConnectedToRoot(sessionId, state.id);
    this.setTranscriptHeads(sessionId, state.modelHeadId, state.uiHeadId);
    const updated = this.database
      .query("UPDATE session_history SET current_state_id = ?, updated_at = ? WHERE session_id = ?")
      .run(state.id, new Date().toISOString(), sessionId);
    if (updated.changes !== 1) throw new Error(`Session '${sessionId}' has no history cursor`);
  }

  private getStoredCommand(sessionId: string, commandId: string): z.infer<typeof commandRowSchema> {
    const value = this.database
      .query(
        `SELECT kind, run_id, request_fingerprint, request_json, side_effect_started, result_json
         FROM commands WHERE session_id = ? AND command_id = ?`,
      )
      .get(sessionId, commandId);
    if (!value) throw new Error(`Command '${commandId}' was not reserved`);
    return commandRowSchema.parse(value);
  }

  private getIncomingHistoryTransition(
    sessionId: string,
    stateId: string,
  ): StoredHistoryTransition | null {
    const row = this.database
      .query("SELECT * FROM history_transitions WHERE session_id = ? AND to_state_id = ?")
      .get(sessionId, stateId);
    return row ? toHistoryTransition(row) : null;
  }

  private parseHistoryNavigationResult(
    action: z.infer<typeof historyOperationActionSchema>,
    value: unknown,
    commandId: string,
    expectedMessage: MiniLilacUserUIMessage | null,
  ): StoredHistoryNavigationResult {
    const status = z.object({ status: z.enum(["undone", "redone", "empty"]) }).parse(value).status;
    if ((action === "undo" && status === "redone") || (action === "redo" && status === "undone")) {
      throw new Error(
        `History ${action} requires a '${action === "undo" ? "undone" : "redone"}' or empty result`,
      );
    }
    const result =
      action === "undo"
        ? storedUndoHistoryResultSchema.parse(value)
        : storedRedoHistoryResultSchema.parse(value);
    if (result.clientCommandId !== commandId) {
      throw new Error(`History result command ID does not match command '${commandId}'`);
    }
    if (
      result.status !== "empty" &&
      (expectedMessage === null || !canonicalValuesEqual(result.message, expectedMessage))
    ) {
      throw new Error(`History ${action} result does not contain its exact user message`);
    }
    return result;
  }

  private saveHistoryCommandResult(
    operation: StoredHistoryOperation,
    result: StoredHistoryNavigationResult | StoredHistoryCommandError,
  ): void {
    const saved = this.database
      .query(
        `UPDATE commands SET result_json = ?
         WHERE session_id = ? AND command_id = ? AND kind = ? AND run_id IS NULL
           AND side_effect_started = 1 AND result_json IS NULL`,
      )
      .run(serialize(result), operation.sessionId, operation.commandId, operation.requestedAction);
    if (saved.changes !== 1) {
      throw new Error(`Command '${operation.commandId}' result could not be saved atomically`);
    }
  }

  private deleteHistoryOperationRow(operationId: string): void {
    const deleted = this.database
      .query("DELETE FROM history_operations WHERE id = ?")
      .run(operationId);
    if (deleted.changes !== 1)
      throw new Error(`History operation '${operationId}' was not deleted`);
  }

  private deletePendingRunFinalizationRow(runId: string): void {
    const deleted = this.database
      .query("DELETE FROM pending_run_finalizations WHERE run_id = ?")
      .run(runId);
    if (deleted.changes !== 1) {
      throw new Error(`Pending finalization for run '${runId}' was not deleted`);
    }
  }

  getHistoryTransition(transitionId: string): StoredHistoryTransition {
    const row = this.database
      .query("SELECT * FROM history_transitions WHERE id = ?")
      .get(transitionId);
    if (!row) throw new Error(`History transition '${transitionId}' was not found`);
    return toHistoryTransition(row);
  }

  private insertHistoryStateRow(input: CreateStoredHistoryState): void {
    historyWorkspaceStatusSchema.parse(input.workspaceStatus);
    historyStateOriginSchema.parse(input.origin);
    if (input.workspaceUnavailableReason !== null) {
      historyWorkspaceUnavailableReasonSchema.parse(input.workspaceUnavailableReason);
    }
    if (input.modelHeadId !== null) z.number().int().positive().parse(input.modelHeadId);
    if (input.uiHeadId !== null) z.number().int().positive().parse(input.uiHeadId);
    const providerState =
      input.providerState === undefined || input.providerState === null
        ? null
        : historyProviderStateSchema.parse(input.providerState);
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
        providerState === null ? null : providerState.containsCrossFamilyTurns ? 1 : 0,
        input.createdAt ?? new Date().toISOString(),
      );
  }

  private insertHistoryTransitionRow(input: CreateStoredHistoryTransition): void {
    historyTransitionKindSchema.parse(input.kind);
    const from = this.getHistoryState(input.fromStateId);
    if (from.sessionId !== input.sessionId) {
      throw new Error(`History transition '${input.id}' crosses sessions`);
    }
    this.assertStateConnectedToRoot(input.sessionId, input.fromStateId);
    if (
      this.database
        .query("SELECT 1 FROM history_transitions WHERE session_id = ? AND to_state_id IS NULL")
        .get(input.sessionId)
    ) {
      throw new Error(`Session '${input.sessionId}' already has an open history transition`);
    }
    const toStateId = input.toStateId ?? null;
    if (
      toStateId === null &&
      this.getSessionHistory(input.sessionId).currentStateId !== input.fromStateId
    ) {
      throw new Error(`Open history transition '${input.id}' must start at the current state`);
    }
    if (toStateId !== null) {
      this.validateHistoryTransitionDestination(
        input.sessionId,
        input.fromStateId,
        toStateId,
        input.kind,
      );
    }
    if (input.kind === "user-message") {
      const rootRunId = z.string().min(1).parse(input.rootRunId);
      historyDeliverySchema.parse(input.delivery);
      miniLilacUserUIMessageSchema.parse(input.userMessage);
      z.number().int().nonnegative().parse(input.replayAfterSeq);
      const rootRun = z
        .object({ parent_run_id: z.string().nullable() })
        .parse(
          this.database
            .query("SELECT parent_run_id FROM runs WHERE id = ? AND session_id = ?")
            .get(rootRunId, input.sessionId),
        );
      if (rootRun.parent_run_id !== null) {
        throw new Error(`History transition '${input.id}' must reference a root run`);
      }
      const command = this.getStoredCommand(input.sessionId, input.commandId);
      if (
        command.kind !== input.delivery ||
        command.run_id !== rootRunId ||
        command.side_effect_started !== 1 ||
        command.result_json === null
      ) {
        throw new Error(
          `${input.delivery === "prompt" ? "Prompt" : "Steering"} command '${input.commandId}' is not bound to root run '${rootRunId}'`,
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
  }

  private validateHistoryTransitionDestination(
    sessionId: string,
    fromStateId: string,
    toStateId: string,
    kind: z.infer<typeof historyTransitionKindSchema>,
  ): void {
    const destination = this.getHistoryState(toStateId);
    if (destination.sessionId !== sessionId) {
      throw new Error(`History transition from '${fromStateId}' crosses sessions`);
    }
    const expectedOrigin = {
      "user-message": "turn-boundary",
      "workspace-observation": "workspace-observation",
      compaction: "compaction",
    } as const;
    if (destination.origin !== expectedOrigin[kind]) {
      throw new Error(
        `History transition kind '${kind}' requires destination origin '${expectedOrigin[kind]}'`,
      );
    }
    if (
      this.database.query("SELECT 1 FROM history_transitions WHERE to_state_id = ?").get(toStateId)
    ) {
      throw new Error(`History state '${toStateId}' already has an incoming transition`);
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
    if (cycle) throw new Error(`History transition to '${toStateId}' would create a cycle`);
  }

  private assertStateConnectedToRoot(sessionId: string, stateId: string): void {
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
      throw new Error(`History state '${stateId}' is not connected to session '${sessionId}' root`);
    }
  }

  private isStateInAncestry(sessionId: string, startStateId: string, stateId: string): boolean {
    return Boolean(
      this.database
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
        .get(startStateId, sessionId, stateId),
    );
  }

  getModelMessages(sessionId: string): ModelMessage[] {
    const values = this.readSerializedChain(
      sessionId,
      "model",
      this.getTranscriptHeads(sessionId).model_head_id,
    ).map(deserialize);
    return modelMessagesSchema.parse(values);
  }

  getUiMessages(sessionId: string): MiniLilacUIMessage[] {
    const values = this.readSerializedChain(
      sessionId,
      "ui",
      this.getTranscriptHeads(sessionId).ui_head_id,
    ).map(deserialize);
    return miniLilacMessagesSchema.parse(values);
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
  ): number | null {
    return this.internSerializedChain(sessionId, lane, values.map(serialize));
  }

  private internSerializedChain(
    sessionId: string,
    lane: "model" | "ui",
    values: readonly string[],
  ): number | null {
    let parentId: number | null = null;
    let parentDepth = 0;
    let parentHash = "root";
    for (const valueJson of values) {
      const equivalent: z.infer<typeof transcriptNodeRowSchema> | undefined = this.database
        .query(
          `SELECT id, parent_id, depth, value_json, hash FROM transcript_nodes
           WHERE session_id = ? AND lane = ? AND parent_id IS ?`,
        )
        .all(sessionId, lane, parentId)
        .map((value) => transcriptNodeRowSchema.parse(value))
        .find((value) =>
          canonicalValuesEqual(deserialize(value.value_json), deserialize(valueJson)),
        );
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
        const existing = transcriptNodeRowSchema.parse(existingValue);
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
      const inserted = transcriptNodeRowSchema.pick({ id: true }).parse(
        this.database
          .query(
            `INSERT INTO transcript_nodes
              (session_id, lane, parent_id, depth, value_json, hash)
             VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
          )
          .get(sessionId, lane, parentId, parentDepth + 1, valueJson, hash),
      );
      parentId = inserted.id;
      parentDepth += 1;
      parentHash = hash;
    }
    return parentId;
  }

  private getTranscriptHeads(sessionId: string): z.infer<typeof transcriptHeadRowSchema> {
    const value = this.database
      .query("SELECT model_head_id, ui_head_id FROM session_transcript_heads WHERE session_id = ?")
      .get(sessionId);
    return value ? transcriptHeadRowSchema.parse(value) : { model_head_id: null, ui_head_id: null };
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
  ): string[] {
    if (headId === null) return [];
    return this.database
      .query(
        `WITH RECURSIVE chain(id, parent_id, depth, value_json) AS (
           SELECT id, parent_id, depth, value_json FROM transcript_nodes
           WHERE id = ? AND session_id = ? AND lane = ?
           UNION ALL
           SELECT parent.id, parent.parent_id, parent.depth, parent.value_json
           FROM transcript_nodes AS parent
           JOIN chain AS child ON child.parent_id = parent.id
           WHERE parent.session_id = ? AND parent.lane = ?
         )
         SELECT value_json FROM chain ORDER BY depth`,
      )
      .all(headId, sessionId, lane, sessionId, lane)
      .map((value) => jsonRowSchema.parse(value).value_json);
  }

  getCommandResult(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
  ): unknown | undefined {
    const command = canonicalCommandPayload(request.payload);
    const value = this.database
      .query(
        `SELECT kind, run_id, request_fingerprint, request_json, side_effect_started, result_json
         FROM commands WHERE session_id = ? AND command_id = ?`,
      )
      .get(sessionId, commandId);
    if (!value) return undefined;
    const row = commandRowSchema.parse(value);
    if (row.kind !== request.kind) {
      throw new Error(`Command '${commandId}' was already used for '${row.kind}'`);
    }
    if (request.runId !== null && row.run_id !== request.runId) {
      throw new Error(`Command '${commandId}' was already used for a different run`);
    }
    if (row.request_fingerprint !== command.fingerprint || row.request_json !== command.json) {
      throw new Error(`Command '${commandId}' was already used with a different payload`);
    }
    if (row.result_json === null) throw new Error(`Command '${commandId}' is pending`);
    return deserialize(row.result_json);
  }

  reserveCommand(sessionId: string, commandId: string, request: StoredCommandRequest): void {
    const command = canonicalCommandPayload(request.payload);
    this.database
      .query(
        `INSERT INTO commands
          (session_id, command_id, kind, run_id, request_fingerprint, request_json, side_effect_started, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
      )
      .run(
        sessionId,
        commandId,
        request.kind,
        request.runId,
        command.fingerprint,
        command.json,
        new Date().toISOString(),
      );
  }

  releaseCommand(sessionId: string, commandId: string, request: StoredCommandRequest): void {
    const command = canonicalCommandPayload(request.payload);
    this.database
      .query(
        `DELETE FROM commands
         WHERE session_id = ? AND command_id = ? AND kind = ?
           AND run_id IS ? AND request_fingerprint = ? AND request_json = ?
           AND side_effect_started = 0 AND result_json IS NULL`,
      )
      .run(sessionId, commandId, request.kind, request.runId, command.fingerprint, command.json);
  }

  markCommandSideEffectStarted(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
  ): void {
    const command = canonicalCommandPayload(request.payload);
    const marked = this.database
      .query(
        `UPDATE commands SET side_effect_started = 1
         WHERE session_id = ? AND command_id = ? AND kind = ?
           AND run_id IS ? AND request_fingerprint = ? AND request_json = ?
           AND side_effect_started = 0 AND result_json IS NULL`,
      )
      .run(sessionId, commandId, request.kind, request.runId, command.fingerprint, command.json);
    if (marked.changes !== 1) {
      throw new Error(`Command '${commandId}' could not begin its side effect`);
    }
  }

  saveCommandResult(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
    result: unknown,
  ): void {
    const command = canonicalCommandPayload(request.payload);
    const saved = this.database
      .query(
        `UPDATE commands SET result_json = ?
         WHERE session_id = ? AND command_id = ? AND kind = ?
           AND run_id IS ? AND request_fingerprint = ? AND request_json = ?
           AND side_effect_started = 1 AND result_json IS NULL`,
      )
      .run(
        serialize(result),
        sessionId,
        commandId,
        request.kind,
        request.runId,
        command.fingerprint,
        command.json,
      );
    if (saved.changes !== 1) throw new Error(`Command '${commandId}' result could not be saved`);
  }
}
