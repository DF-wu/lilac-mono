import { z } from "zod";

import {
  CorruptPersistedFields,
  UnsupportedVersion,
  type DecodedPersistedValue,
  type PersistedDataError,
  type PersistedDataIssueCode,
} from "@stanley2058/lilac-utils";
import { Result, type Result as ResultType } from "better-result";

import {
  decodeMiniMainClaudeBindingPromotion,
  decodeMiniNamedClaudeBindingPromotion,
  decodeMiniLilacHistoryUserMessage,
  decodeMiniLilacSuperJsonPayload,
  type DecodedMiniMainClaudeBindingPromotion,
  type DecodedMiniNamedClaudeBindingPromotion,
  type MiniLilacPersistedSuperJsonValue,
} from "./sqlite-persistence-codec";
import type { MiniLilacPersistedUserUiMessageProjection } from "./sqlite-transcript-projection";

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
const historyProviderFamilySchema = z.enum(["claude-code", "ai-sdk"]);
const historyTransitionKindSchema = z.enum(["user-message", "workspace-observation", "compaction"]);
const historyDeliverySchema = z.enum(["prompt", "steer"]);
const historyOperationActionSchema = z.enum(["undo", "redo"]);
const historyOperationPhaseSchema = z.enum(["prepared", "restoring", "verified"]);
const historyFilesystemModeSchema = z.enum(["restore", "skip"]);
const historySkipReasonSchema = z.enum([
  "git-unavailable",
  "non-git-workspace",
  "snapshot-unavailable",
  "platform-unsupported",
]);

const historyStoreMetadataRowSchema = z.strictObject({
  namespace_id: z.string().min(1),
  created_at: z.string(),
});
const workspaceRowSchema = z.strictObject({
  id: z.string().min(1),
  canonical_cwd: z.string().min(1),
  health_status: z.enum(["healthy", "corrupt"]),
  health_detail: z.string().nullable(),
  created_at: z.string(),
});
const workspaceSnapshotRowSchema = z
  .strictObject({
    id: z.string().min(1),
    workspace_id: z.string().min(1),
    root_tree_oid: z.string().min(1),
    git_ref: z.string().min(1),
    format_version: z.number().int().positive(),
    availability: z.enum(["available", "missing", "corrupt"]),
    availability_detail: z.string().nullable(),
    created_at: z.string(),
  })
  .refine(
    (row) =>
      row.availability === "available"
        ? row.availability_detail === null
        : row.availability_detail !== null && row.availability_detail.length > 0,
    { message: "Snapshot availability and detail are inconsistent" },
  );
const historyStateRowSchema = z
  .strictObject({
    id: z.string().min(1),
    session_id: z.string().min(1),
    workspace_id: z.string().min(1),
    model_head_id: z.number().int().positive().nullable(),
    model_lane: z.literal("model"),
    ui_head_id: z.number().int().positive().nullable(),
    ui_lane: z.literal("ui"),
    workspace_snapshot_id: z.string().min(1).nullable(),
    workspace_status: historyWorkspaceStatusSchema,
    workspace_unavailable_reason: historyWorkspaceUnavailableReasonSchema.nullable(),
    origin: historyStateOriginSchema,
    last_provider_family: historyProviderFamilySchema.nullable(),
    contains_cross_family_turns: z.number().int().min(0).max(1).nullable(),
    created_at: z.string(),
  })
  .refine(
    (row) => (row.last_provider_family === null) === (row.contains_cross_family_turns === null),
    { message: "Provider-state fields must both be present or absent" },
  )
  .refine(
    (row) => {
      switch (row.workspace_status) {
        case "captured":
          return row.workspace_snapshot_id !== null && row.workspace_unavailable_reason === null;
        case "unavailable":
          return row.workspace_snapshot_id === null && row.workspace_unavailable_reason !== null;
        case "capture-deferred":
          return row.workspace_snapshot_id === null && row.workspace_unavailable_reason === null;
      }
    },
    { message: "Workspace-state fields are inconsistent" },
  );
const historyTransitionRowSchema = z
  .strictObject({
    id: z.string().min(1),
    session_id: z.string().min(1),
    from_state_id: z.string().min(1),
    to_state_id: z.string().min(1).nullable(),
    kind: historyTransitionKindSchema,
    delivery: historyDeliverySchema.nullable(),
    command_id: z.string().min(1).nullable(),
    user_message_json: z.string().nullable(),
    root_run_id: z.string().min(1).nullable(),
    replay_after_seq: z.number().int().nonnegative().nullable(),
    created_at: z.string(),
    completed_at: z.string().nullable(),
  })
  .refine(
    (row) =>
      row.kind === "user-message"
        ? row.delivery !== null &&
          row.user_message_json !== null &&
          row.root_run_id !== null &&
          row.replay_after_seq !== null
        : row.delivery === null &&
          row.command_id === null &&
          row.user_message_json === null &&
          row.root_run_id === null &&
          row.replay_after_seq === null,
    { message: "Transition payload fields are inconsistent" },
  )
  .refine((row) => (row.to_state_id === null) === (row.completed_at === null), {
    message: "Transition completion fields are inconsistent",
  })
  .refine((row) => row.to_state_id !== null || row.kind === "user-message", {
    message: "Only user-message transitions may remain open",
  });
const sessionHistoryRowSchema = z.strictObject({
  session_id: z.string().min(1),
  root_state_id: z.string().min(1),
  current_state_id: z.string().min(1),
  undo_floor_state_id: z.string().min(1),
  updated_at: z.string(),
});
const historyRedoRowSchema = z.strictObject({
  session_id: z.string().min(1),
  position: z.number().int().nonnegative(),
  target_state_id: z.string().min(1),
  user_transition_id: z.string().min(1),
  created_at: z.string(),
});
const historyOperationRowSchema = z
  .strictObject({
    id: z.string().min(1),
    session_id: z.string().min(1),
    workspace_id: z.string().min(1),
    command_id: z.string().min(1),
    kind: z.literal("navigate"),
    requested_action: historyOperationActionSchema,
    source_state_id: z.string().min(1),
    observed_source_state_id: z.string().min(1).nullable(),
    target_state_id: z.string().min(1),
    user_transition_id: z.string().min(1),
    filesystem_mode: historyFilesystemModeSchema,
    skip_reason: historySkipReasonSchema.nullable(),
    phase: historyOperationPhaseSchema,
    prepared_at: z.string(),
    updated_at: z.string(),
  })
  .refine(
    (row) =>
      row.filesystem_mode === "restore" ? row.skip_reason === null : row.skip_reason !== null,
    { message: "History operation filesystem fields are inconsistent" },
  );
const pendingRunFinalizationRowSchema = z
  .strictObject({
    run_id: z.string().min(1),
    session_id: z.string().min(1),
    workspace_id: z.string().min(1),
    open_transition_id: z.string().min(1),
    model_head_id: z.number().int().positive().nullable(),
    model_lane: z.literal("model"),
    ui_head_id: z.number().int().positive().nullable(),
    ui_lane: z.literal("ui"),
    run_status: z.enum(["completed", "cancelled", "error"]),
    session_status: z.enum(["idle", "error"]),
    error: z.string().nullable(),
    terminal_result_json: z.string().nullable(),
    input_tokens: z.number().int().nonnegative().nullable(),
    last_provider_family: historyProviderFamilySchema.nullable(),
    contains_cross_family_turns: z.number().int().min(0).max(1).nullable(),
    claude_binding_promotion_json: z.string().nullable(),
    named_claude_binding_promotion_json: z.string().nullable(),
    prepared_at: z.string(),
  })
  .refine(
    (row) => (row.last_provider_family === null) === (row.contains_cross_family_turns === null),
    { message: "Provider-state fields must both be present or absent" },
  )
  .refine(
    (row) =>
      row.claude_binding_promotion_json === null ||
      row.named_claude_binding_promotion_json === null,
    { message: "A finalization cannot promote both Claude binding kinds" },
  );
const historyAccountingRowSchema = z.strictObject({
  state_count: z.number().int().nonnegative(),
  transition_count: z.number().int().nonnegative(),
  branch_tip_count: z.number().int().nonnegative(),
  snapshot_count: z.number().int().nonnegative(),
  redo_stack_count: z.number().int().nonnegative(),
  active_operation_count: z.number().int().nonnegative(),
  pending_finalization_count: z.number().int().nonnegative(),
});
const recoverableOpenRootRunRowSchema = z.strictObject({
  run_id: z.string().min(1),
  session_id: z.string().min(1),
  workspace_id: z.string().min(1),
  open_transition_id: z.string().min(1),
  input_tokens: z.number().int().nonnegative().nullable(),
});
const migrationRunRowSchema = z.strictObject({
  id: z.string().min(1),
  status: z.enum(["active", "completed", "cancelled", "error"]),
  parent_run_id: z.string().min(1).nullable(),
});

export type MiniLilacHistoryProviderStateProjection = {
  readonly lastFamily: z.output<typeof historyProviderFamilySchema>;
  readonly containsCrossFamilyTurns: boolean;
};
export type MiniLilacHistoryStoreMetadataProjection = {
  readonly namespaceId: string;
  readonly createdAt: string;
};
export type MiniLilacWorkspaceProjection = {
  readonly id: string;
  readonly canonicalCwd: string;
  readonly healthStatus: "healthy" | "corrupt";
  readonly healthDetail: string | null;
  readonly createdAt: string;
};
export type MiniLilacWorkspaceSnapshotProjection = {
  readonly id: string;
  readonly workspaceId: string;
  readonly rootTreeOid: string;
  readonly gitRef: string;
  readonly formatVersion: number;
  readonly availability: "available" | "missing" | "corrupt";
  readonly availabilityDetail: string | null;
  readonly createdAt: string;
};
export type MiniLilacHistoryStateProjection = {
  readonly id: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly modelHeadId: number | null;
  readonly uiHeadId: number | null;
  readonly workspaceSnapshotId: string | null;
  readonly workspaceStatus: z.output<typeof historyWorkspaceStatusSchema>;
  readonly workspaceUnavailableReason: z.output<
    typeof historyWorkspaceUnavailableReasonSchema
  > | null;
  readonly origin: z.output<typeof historyStateOriginSchema>;
  readonly providerState: MiniLilacHistoryProviderStateProjection | null;
  readonly createdAt: string;
};
export type MiniLilacHistoryTransitionProjection = {
  readonly id: string;
  readonly sessionId: string;
  readonly fromStateId: string;
  readonly toStateId: string | null;
  readonly kind: z.output<typeof historyTransitionKindSchema>;
  readonly delivery: z.output<typeof historyDeliverySchema> | null;
  readonly commandId: string | null;
  readonly userMessage: MiniLilacPersistedUserUiMessageProjection | null;
  readonly rootRunId: string | null;
  readonly replayAfterSeq: number | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
};
export type MiniLilacSessionHistoryProjection = {
  readonly sessionId: string;
  readonly rootStateId: string;
  readonly currentStateId: string;
  readonly undoFloorStateId: string;
  readonly updatedAt: string;
};
export type MiniLilacHistoryRedoProjection = {
  readonly sessionId: string;
  readonly position: number;
  readonly targetStateId: string;
  readonly userTransitionId: string;
  readonly createdAt: string;
};
export type MiniLilacHistoryOperationProjection = {
  readonly id: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly commandId: string;
  readonly kind: "navigate";
  readonly requestedAction: z.output<typeof historyOperationActionSchema>;
  readonly sourceStateId: string;
  readonly observedSourceStateId: string | null;
  readonly targetStateId: string;
  readonly userTransitionId: string;
  readonly filesystemMode: z.output<typeof historyFilesystemModeSchema>;
  readonly skipReason: z.output<typeof historySkipReasonSchema> | null;
  readonly phase: z.output<typeof historyOperationPhaseSchema>;
  readonly preparedAt: string;
  readonly updatedAt: string;
};
export type MiniLilacPendingRunFinalizationProjection = {
  readonly runId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly openTransitionId: string;
  readonly modelHeadId: number | null;
  readonly uiHeadId: number | null;
  readonly runStatus: "completed" | "cancelled" | "error";
  readonly sessionStatus: "idle" | "error";
  readonly error: string | null;
  readonly terminalResult: MiniLilacPersistedSuperJsonValue | undefined;
  readonly inputTokens: number | null;
  readonly providerState: MiniLilacHistoryProviderStateProjection | null;
  readonly claudeBindingPromotion: DecodedMiniMainClaudeBindingPromotion | null;
  readonly namedClaudeBindingPromotion: DecodedMiniNamedClaudeBindingPromotion | null;
  readonly preparedAt: string;
};
export type MiniLilacHistoryAccountingProjection = {
  readonly stateCount: number;
  readonly transitionCount: number;
  readonly branchTipCount: number;
  readonly snapshotCount: number;
  readonly redoStackCount: number;
  readonly activeOperationCount: number;
  readonly pendingFinalizationCount: number;
};
export type MiniLilacRecoverableOpenRootRunProjection = {
  readonly runId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly openTransitionId: string;
  readonly inputTokens: number | null;
};

export type MiniLilacStructuralHistoryRecord =
  | { readonly kind: "store-metadata"; readonly value: MiniLilacHistoryStoreMetadataProjection }
  | { readonly kind: "workspace"; readonly value: MiniLilacWorkspaceProjection }
  | { readonly kind: "workspace-snapshot"; readonly value: MiniLilacWorkspaceSnapshotProjection }
  | { readonly kind: "state"; readonly value: MiniLilacHistoryStateProjection }
  | { readonly kind: "transition"; readonly value: MiniLilacHistoryTransitionProjection }
  | { readonly kind: "session-history"; readonly value: MiniLilacSessionHistoryProjection }
  | { readonly kind: "redo"; readonly value: MiniLilacHistoryRedoProjection }
  | { readonly kind: "operation"; readonly value: MiniLilacHistoryOperationProjection }
  | {
      readonly kind: "pending-finalization";
      readonly value: MiniLilacPendingRunFinalizationProjection;
    }
  | { readonly kind: "accounting"; readonly value: MiniLilacHistoryAccountingProjection }
  | {
      readonly kind: "recoverable-open-root-run";
      readonly value: MiniLilacRecoverableOpenRootRunProjection;
    };

export type MiniLilacStructuralHistoryRecordKind = MiniLilacStructuralHistoryRecord["kind"];
export type MiniLilacStructuralHistoryRowCodecInput = {
  readonly kind: MiniLilacStructuralHistoryRecordKind;
  readonly row: unknown;
  readonly schemaVersion: number;
  readonly recordId: string;
};
export type MiniLilacMigrationRunRowProjection = z.output<typeof migrationRunRowSchema>;

type DecodedVersion = {
  readonly version: 4 | 5 | 6 | 7 | 8;
  readonly provenance: "current" | "migrated";
};

function tableFor(kind: MiniLilacStructuralHistoryRecordKind): string {
  switch (kind) {
    case "store-metadata":
      return "history_store_metadata";
    case "workspace":
      return "workspaces";
    case "workspace-snapshot":
      return "workspace_snapshots";
    case "state":
      return "history_states";
    case "transition":
      return "history_transitions";
    case "session-history":
      return "session_history";
    case "redo":
      return "history_redo_stack";
    case "operation":
      return "history_operations";
    case "pending-finalization":
      return "pending_run_finalizations";
    case "accounting":
      return "history_accounting_query";
    case "recoverable-open-root-run":
      return "recoverable_open_root_runs_query";
  }
}

function context(input: {
  readonly kind: MiniLilacStructuralHistoryRecordKind;
  readonly version: number;
  readonly issueCode: PersistedDataIssueCode;
  readonly recordId: string;
}) {
  return {
    table: tableFor(input.kind),
    field: input.kind,
    version: input.version,
    issueCode: input.issueCode,
    recordId: input.recordId.slice(0, 128),
    message: `Persisted Mini Lilac ${input.kind} ${input.issueCode}`,
  };
}

function corrupt(input: Parameters<typeof context>[0]): CorruptPersistedFields {
  return new CorruptPersistedFields(context(input));
}

export function decodeMiniLilacMigrationRunRow(input: {
  readonly row: unknown;
  readonly recordId: string;
}): ResultType<MiniLilacMigrationRunRowProjection, CorruptPersistedFields> {
  const decoded = migrationRunRowSchema.safeParse(input.row);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new CorruptPersistedFields({
      table: "runs",
      field: "migration_run",
      version: 4,
      issueCode: "invalid-row-field",
      recordId: input.recordId.slice(0, 128),
      message: "Persisted Mini Lilac migration run has invalid fields",
    }),
  );
}

function decodeVersion(
  input: MiniLilacStructuralHistoryRowCodecInput,
): ResultType<DecodedVersion, UnsupportedVersion | CorruptPersistedFields> {
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 0) {
    return Result.err(
      corrupt({
        kind: input.kind,
        version: input.schemaVersion,
        issueCode: "invalid-row-version",
        recordId: input.recordId,
      }),
    );
  }
  switch (input.schemaVersion) {
    case 4:
    case 5:
    case 6:
    case 7:
      return Result.ok({ version: input.schemaVersion, provenance: "migrated" });
    case 8:
      return Result.ok({ version: input.schemaVersion, provenance: "current" });
    default:
      return Result.err(
        new UnsupportedVersion(
          context({
            kind: input.kind,
            version: input.schemaVersion,
            issueCode: "unsupported-version",
            recordId: input.recordId,
          }),
        ),
      );
  }
}

function invalidRow(input: MiniLilacStructuralHistoryRowCodecInput, version: number) {
  return Result.err(
    corrupt({
      kind: input.kind,
      version,
      issueCode: "invalid-row-field",
      recordId: input.recordId,
    }),
  );
}

function providerState(
  family: z.output<typeof historyProviderFamilySchema> | null,
  crossFamily: number | null,
): MiniLilacHistoryProviderStateProjection | null {
  return family === null || crossFamily === null
    ? null
    : { lastFamily: family, containsCrossFamilyTurns: crossFamily === 1 };
}

export function decodeMiniLilacStructuralHistoryRow(
  input: MiniLilacStructuralHistoryRowCodecInput,
): ResultType<DecodedPersistedValue<MiniLilacStructuralHistoryRecord | null>, PersistedDataError> {
  const version = decodeVersion(input);
  if (version.status === "error") return Result.err(version.error);
  if (input.row === null || input.row === undefined) {
    return Result.ok({ value: null, provenance: "missing-defaulted" });
  }

  switch (input.kind) {
    case "store-metadata": {
      const row = historyStoreMetadataRowSchema.safeParse(input.row);
      if (!row.success) return invalidRow(input, version.value.version);
      return Result.ok({
        value: {
          kind: input.kind,
          value: { namespaceId: row.data.namespace_id, createdAt: row.data.created_at },
        },
        provenance: version.value.provenance,
      });
    }
    case "workspace": {
      const row = workspaceRowSchema.safeParse(input.row);
      if (!row.success) return invalidRow(input, version.value.version);
      return Result.ok({
        value: {
          kind: input.kind,
          value: {
            id: row.data.id,
            canonicalCwd: row.data.canonical_cwd,
            healthStatus: row.data.health_status,
            healthDetail: row.data.health_detail,
            createdAt: row.data.created_at,
          },
        },
        provenance: version.value.provenance,
      });
    }
    case "workspace-snapshot": {
      const row = workspaceSnapshotRowSchema.safeParse(input.row);
      if (!row.success) return invalidRow(input, version.value.version);
      return Result.ok({
        value: {
          kind: input.kind,
          value: {
            id: row.data.id,
            workspaceId: row.data.workspace_id,
            rootTreeOid: row.data.root_tree_oid,
            gitRef: row.data.git_ref,
            formatVersion: row.data.format_version,
            availability: row.data.availability,
            availabilityDetail: row.data.availability_detail,
            createdAt: row.data.created_at,
          },
        },
        provenance: version.value.provenance,
      });
    }
    case "state": {
      const row = historyStateRowSchema.safeParse(input.row);
      if (!row.success) return invalidRow(input, version.value.version);
      return Result.ok({
        value: {
          kind: input.kind,
          value: {
            id: row.data.id,
            sessionId: row.data.session_id,
            workspaceId: row.data.workspace_id,
            modelHeadId: row.data.model_head_id,
            uiHeadId: row.data.ui_head_id,
            workspaceSnapshotId: row.data.workspace_snapshot_id,
            workspaceStatus: row.data.workspace_status,
            workspaceUnavailableReason: row.data.workspace_unavailable_reason,
            origin: row.data.origin,
            providerState: providerState(
              row.data.last_provider_family,
              row.data.contains_cross_family_turns,
            ),
            createdAt: row.data.created_at,
          },
        },
        provenance: version.value.provenance,
      });
    }
    case "transition": {
      const row = historyTransitionRowSchema.safeParse(input.row);
      if (!row.success) return invalidRow(input, version.value.version);
      const message = decodeMiniLilacHistoryUserMessage({
        raw: row.data.user_message_json,
        schemaVersion: version.value.version,
        recordId: row.data.id,
      });
      if (message.status === "error") return Result.err(message.error);
      return Result.ok({
        value: {
          kind: input.kind,
          value: {
            id: row.data.id,
            sessionId: row.data.session_id,
            fromStateId: row.data.from_state_id,
            toStateId: row.data.to_state_id,
            kind: row.data.kind,
            delivery: row.data.delivery,
            commandId: row.data.command_id,
            userMessage: message.value.value,
            rootRunId: row.data.root_run_id,
            replayAfterSeq: row.data.replay_after_seq,
            createdAt: row.data.created_at,
            completedAt: row.data.completed_at,
          },
        },
        provenance: version.value.provenance,
      });
    }
    case "session-history": {
      const row = sessionHistoryRowSchema.safeParse(input.row);
      if (!row.success) return invalidRow(input, version.value.version);
      return Result.ok({
        value: {
          kind: input.kind,
          value: {
            sessionId: row.data.session_id,
            rootStateId: row.data.root_state_id,
            currentStateId: row.data.current_state_id,
            undoFloorStateId: row.data.undo_floor_state_id,
            updatedAt: row.data.updated_at,
          },
        },
        provenance: version.value.provenance,
      });
    }
    case "redo": {
      const row = historyRedoRowSchema.safeParse(input.row);
      if (!row.success) return invalidRow(input, version.value.version);
      return Result.ok({
        value: {
          kind: input.kind,
          value: {
            sessionId: row.data.session_id,
            position: row.data.position,
            targetStateId: row.data.target_state_id,
            userTransitionId: row.data.user_transition_id,
            createdAt: row.data.created_at,
          },
        },
        provenance: version.value.provenance,
      });
    }
    case "operation": {
      const row = historyOperationRowSchema.safeParse(input.row);
      if (!row.success) return invalidRow(input, version.value.version);
      return Result.ok({
        value: {
          kind: input.kind,
          value: {
            id: row.data.id,
            sessionId: row.data.session_id,
            workspaceId: row.data.workspace_id,
            commandId: row.data.command_id,
            kind: row.data.kind,
            requestedAction: row.data.requested_action,
            sourceStateId: row.data.source_state_id,
            observedSourceStateId: row.data.observed_source_state_id,
            targetStateId: row.data.target_state_id,
            userTransitionId: row.data.user_transition_id,
            filesystemMode: row.data.filesystem_mode,
            skipReason: row.data.skip_reason,
            phase: row.data.phase,
            preparedAt: row.data.prepared_at,
            updatedAt: row.data.updated_at,
          },
        },
        provenance: version.value.provenance,
      });
    }
    case "pending-finalization": {
      const row = pendingRunFinalizationRowSchema.safeParse(input.row);
      if (!row.success) return invalidRow(input, version.value.version);
      const terminalResult = decodeMiniLilacSuperJsonPayload({
        raw: row.data.terminal_result_json,
        schemaVersion: version.value.version,
        recordId: row.data.run_id,
        field: "pending_finalization",
      });
      if (terminalResult.status === "error") return Result.err(terminalResult.error);
      const mainPromotion =
        row.data.claude_binding_promotion_json === null
          ? Result.ok({ value: null, provenance: "missing-defaulted" as const })
          : decodeMiniMainClaudeBindingPromotion({
              raw: row.data.claude_binding_promotion_json,
              schemaVersion: version.value.version,
              recordId: row.data.run_id,
              field: "pending_finalization",
            });
      if (mainPromotion.status === "error") return Result.err(mainPromotion.error);
      const namedPromotion =
        row.data.named_claude_binding_promotion_json === null
          ? Result.ok({ value: null, provenance: "missing-defaulted" as const })
          : decodeMiniNamedClaudeBindingPromotion({
              raw: row.data.named_claude_binding_promotion_json,
              schemaVersion: version.value.version,
              recordId: row.data.run_id,
              field: "pending_finalization",
            });
      if (namedPromotion.status === "error") return Result.err(namedPromotion.error);
      const value: MiniLilacPendingRunFinalizationProjection = {
        runId: row.data.run_id,
        sessionId: row.data.session_id,
        workspaceId: row.data.workspace_id,
        openTransitionId: row.data.open_transition_id,
        modelHeadId: row.data.model_head_id,
        uiHeadId: row.data.ui_head_id,
        runStatus: row.data.run_status,
        sessionStatus: row.data.session_status,
        error: row.data.error,
        terminalResult: terminalResult.value.value ?? undefined,
        inputTokens: row.data.input_tokens,
        providerState: providerState(
          row.data.last_provider_family,
          row.data.contains_cross_family_turns,
        ),
        claudeBindingPromotion: mainPromotion.value.value,
        namedClaudeBindingPromotion: namedPromotion.value.value,
        preparedAt: row.data.prepared_at,
      };
      return Result.ok({
        value: { kind: input.kind, value },
        provenance: version.value.provenance,
      });
    }
    case "accounting": {
      const row = historyAccountingRowSchema.safeParse(input.row);
      if (!row.success) return invalidRow(input, version.value.version);
      return Result.ok({
        value: {
          kind: input.kind,
          value: {
            stateCount: row.data.state_count,
            transitionCount: row.data.transition_count,
            branchTipCount: row.data.branch_tip_count,
            snapshotCount: row.data.snapshot_count,
            redoStackCount: row.data.redo_stack_count,
            activeOperationCount: row.data.active_operation_count,
            pendingFinalizationCount: row.data.pending_finalization_count,
          },
        },
        provenance: version.value.provenance,
      });
    }
    case "recoverable-open-root-run": {
      const row = recoverableOpenRootRunRowSchema.safeParse(input.row);
      if (!row.success) return invalidRow(input, version.value.version);
      return Result.ok({
        value: {
          kind: input.kind,
          value: {
            runId: row.data.run_id,
            sessionId: row.data.session_id,
            workspaceId: row.data.workspace_id,
            openTransitionId: row.data.open_transition_id,
            inputTokens: row.data.input_tokens,
          },
        },
        provenance: version.value.provenance,
      });
    }
  }
}

const fixtureStateRow = {
  id: "state-1",
  session_id: "session-1",
  workspace_id: "workspace-1",
  model_head_id: null,
  model_lane: "model",
  ui_head_id: null,
  ui_lane: "ui",
  workspace_snapshot_id: null,
  workspace_status: "capture-deferred",
  workspace_unavailable_reason: null,
  origin: "root",
  last_provider_family: null,
  contains_cross_family_turns: null,
  created_at: "2026-08-03T00:00:00.000Z",
} as const;

export const miniLilacStructuralHistoryRowCodecCases = {
  current: {
    input: { kind: "state", row: fixtureStateRow, schemaVersion: 8, recordId: "current" },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: { kind: "state", row: fixtureStateRow, schemaVersion: 4, recordId: "legacy" },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { kind: "state", row: null, schemaVersion: 8, recordId: "missing" },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: { kind: "state", row: fixtureStateRow, schemaVersion: 9, recordId: "unsupported" },
    outcome: "error",
  },
  "malformed-serialization": {
    input: {
      kind: "transition",
      row: {
        id: "transition-1",
        session_id: "session-1",
        from_state_id: "state-1",
        to_state_id: null,
        kind: "user-message",
        delivery: "prompt",
        command_id: "command-1",
        user_message_json: "{",
        root_run_id: "run-1",
        replay_after_seq: 0,
        created_at: "2026-08-03T00:00:00.000Z",
        completed_at: null,
      },
      schemaVersion: 8,
      recordId: "malformed",
    },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      kind: "state",
      row: { ...fixtureStateRow, workspace_status: "captured" },
      schemaVersion: 8,
      recordId: "corrupt",
    },
    outcome: "error",
  },
} as const;
