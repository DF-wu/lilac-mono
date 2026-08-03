import { describe, expect, it } from "bun:test";
import SuperJSON from "superjson";

import { CorruptPersistedFields, MalformedSerialization } from "@stanley2058/lilac-utils";

import {
  decodeMiniLilacMigrationRunRow,
  decodeMiniLilacStructuralHistoryRow,
  miniLilacStructuralHistoryRowCodecCases,
  type MiniLilacStructuralHistoryRecordKind,
} from "../src/sqlite-history-persistence-codec";

const createdAt = "2026-08-03T00:00:00.000Z";
const rows = {
  "store-metadata": { namespace_id: "namespace-1", created_at: createdAt },
  workspace: {
    id: "workspace-1",
    canonical_cwd: "/workspace",
    health_status: "healthy",
    health_detail: null,
    created_at: createdAt,
  },
  "workspace-snapshot": {
    id: "snapshot-1",
    workspace_id: "workspace-1",
    root_tree_oid: "a".repeat(40),
    git_ref: "refs/lilac/snapshot-1",
    format_version: 1,
    availability: "available",
    availability_detail: null,
    created_at: createdAt,
  },
  state: {
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
    last_provider_family: "ai-sdk",
    contains_cross_family_turns: 0,
    created_at: createdAt,
  },
  transition: {
    id: "transition-1",
    session_id: "session-1",
    from_state_id: "state-1",
    to_state_id: null,
    kind: "user-message",
    delivery: "prompt",
    command_id: "command-1",
    user_message_json: SuperJSON.stringify({
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    }),
    root_run_id: "run-1",
    replay_after_seq: 0,
    created_at: createdAt,
    completed_at: null,
  },
  "session-history": {
    session_id: "session-1",
    root_state_id: "state-1",
    current_state_id: "state-1",
    undo_floor_state_id: "state-1",
    updated_at: createdAt,
  },
  redo: {
    session_id: "session-1",
    position: 0,
    target_state_id: "state-1",
    user_transition_id: "transition-1",
    created_at: createdAt,
  },
  operation: {
    id: "operation-1",
    session_id: "session-1",
    workspace_id: "workspace-1",
    command_id: "command-1",
    kind: "navigate",
    requested_action: "undo",
    source_state_id: "state-1",
    observed_source_state_id: null,
    target_state_id: "state-2",
    user_transition_id: "transition-1",
    filesystem_mode: "restore",
    skip_reason: null,
    phase: "prepared",
    prepared_at: createdAt,
    updated_at: createdAt,
  },
  "pending-finalization": {
    run_id: "run-1",
    session_id: "session-1",
    workspace_id: "workspace-1",
    open_transition_id: "transition-1",
    model_head_id: null,
    model_lane: "model",
    ui_head_id: null,
    ui_lane: "ui",
    run_status: "completed",
    session_status: "idle",
    error: null,
    terminal_result_json: SuperJSON.stringify({ finished: true, absent: undefined }),
    input_tokens: 12,
    last_provider_family: "ai-sdk",
    contains_cross_family_turns: 0,
    claude_binding_promotion_json: null,
    named_claude_binding_promotion_json: null,
    prepared_at: createdAt,
  },
  accounting: {
    state_count: 1,
    transition_count: 1,
    branch_tip_count: 1,
    snapshot_count: 0,
    redo_stack_count: 0,
    active_operation_count: 0,
    pending_finalization_count: 0,
  },
  "recoverable-open-root-run": {
    run_id: "run-1",
    session_id: "session-1",
    workspace_id: "workspace-1",
    open_transition_id: "transition-1",
    input_tokens: 12,
  },
} as const satisfies Record<MiniLilacStructuralHistoryRecordKind, object>;

describe("Mini Lilac structural history persistence codec", () => {
  it("decodes every current structural history row without inline store parsing", () => {
    for (const kind of Object.keys(rows) as MiniLilacStructuralHistoryRecordKind[]) {
      const decoded = decodeMiniLilacStructuralHistoryRow({
        kind,
        row: rows[kind],
        schemaVersion: 8,
        recordId: kind,
      });
      expect(decoded.status).toBe("ok");
      if (decoded.status === "ok") {
        expect(decoded.value.provenance).toBe("current");
        expect(decoded.value.value?.kind).toBe(kind);
      }
    }
  });

  it("executes the complete compatibility fixture catalog", () => {
    for (const fixture of Object.values(miniLilacStructuralHistoryRowCodecCases)) {
      const decoded = decodeMiniLilacStructuralHistoryRow(fixture.input);
      expect(decoded.status).toBe(fixture.outcome);
      if (decoded.status === "ok" && "provenance" in fixture) {
        expect(decoded.value.provenance).toBe(fixture.provenance);
      }
    }
  });

  it("rejects inconsistent cross-field structures with redacted errors", () => {
    const decoded = decodeMiniLilacStructuralHistoryRow({
      kind: "operation",
      row: { ...rows.operation, filesystem_mode: "skip", skip_reason: null },
      schemaVersion: 8,
      recordId: "operation-secret-id",
    });
    expect(decoded.status).toBe("error");
    if (decoded.status === "error") {
      expect(decoded.error).toBeInstanceOf(CorruptPersistedFields);
      expect(decoded.error.message).not.toContain("/workspace");
    }
  });

  it("distinguishes malformed nested serialization from corrupt row fields", () => {
    const malformed = decodeMiniLilacStructuralHistoryRow(
      miniLilacStructuralHistoryRowCodecCases["malformed-serialization"].input,
    );
    expect(malformed.status).toBe("error");
    if (malformed.status === "error") {
      expect(malformed.error).toBeInstanceOf(MalformedSerialization);
    }
  });

  it("decodes migration run lookups through an exact Result boundary", () => {
    const decoded = decodeMiniLilacMigrationRunRow({
      row: { id: "run-1", status: "active", parent_run_id: null },
      recordId: "run-1",
    });
    expect(decoded.status).toBe("ok");
    if (decoded.status === "ok") {
      expect(decoded.value).toEqual({ id: "run-1", status: "active", parent_run_id: null });
    }

    const corrupt = decodeMiniLilacMigrationRunRow({
      row: { id: "run-1", status: "future", parent_run_id: null },
      recordId: "run-1",
    });
    expect(corrupt.status).toBe("error");
    if (corrupt.status === "error") {
      expect(corrupt.error).toBeInstanceOf(CorruptPersistedFields);
    }
  });
});
