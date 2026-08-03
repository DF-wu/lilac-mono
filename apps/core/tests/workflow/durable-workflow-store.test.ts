import { workflowStoreValue } from "./workflow-store-test-helpers";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { MalformedSerialization } from "@stanley2058/lilac-utils";
import { Panic, Result } from "better-result";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import {
  canonicalJsonSha256,
  WORKFLOW_RUNTIME_VERSION,
} from "../../src/workflow/workflow-definition";
import {
  normalizeWorkflowResourcePolicy,
  type WorkflowOperation,
  type WorkflowRevision,
  type WorkflowRun,
  type WorkflowTrigger,
} from "../../src/workflow/workflow-domain";
import {
  applyWorkflowSchemaMigrations,
  WorkflowMigrationInvalidTimestamp,
  WORKFLOW_MIGRATION_VERSIONS,
  WORKFLOW_SCHEMA_VERSION,
} from "../../src/workflow/workflow-migrations";
import { workflowResolvedModelRequestSchema } from "../../src/workflow/workflow-request-authority";
function dbPath(label: string): string {
  return join(tmpdir(), `lilac-workflow-${label}-${crypto.randomUUID()}.sqlite`);
}

class InvocationReadFailureStore extends DurableWorkflowStore {
  readFailure: MalformedSerialization | null = null;

  override getRun(runId: string) {
    if (this.readFailure) return Result.err(this.readFailure);
    return super.getRun(runId);
  }
}
function revision(id = "revision-1"): WorkflowRevision {
  const resources = normalizeWorkflowResourcePolicy({
    agents: { maxConcurrent: 2, maxTotal: 8 },
    maxNestingDepth: 4,
    operationIdleTimeoutMs: 10000,
    waits: ["reply", "sleep"],
  });
  const limits = {
    maxSourceBytes: 10000,
    maxInputBytes: 10000,
    maxOperationOutputBytes: 10000,
    maxResultBytes: 10000,
  };
  return {
    revisionId: id,
    canonicalProjectId: "project-1",
    canonicalWorkspaceRoot: "/workspace",
    scope: "project",
    normalizedPath: "audit.js",
    name: "audit",
    snapshotArtifactId: `artifact-${id}`,
    sourceSha256: "a".repeat(64),
    inputSchemaSha256: "b".repeat(64),
    resourcePolicySha256: canonicalJsonSha256({ resources, limits }),
    metadata: { name: "audit", description: "Audit the project" },
    inputSchema: { type: "object", additionalProperties: false },
    resources,
    limits,
    runtimeVersion: WORKFLOW_RUNTIME_VERSION,
    createdAt: 10,
  };
}
function run(id = "run-1", revisionId = "revision-1"): WorkflowRun {
  return {
    runId: id,
    revisionId,
    state: "queued",
    inputSchemaSnapshot: { type: "object", additionalProperties: false },
    args: {},
    argsSha256: canonicalJsonSha256({}),
    origin: {
      requestId: "request-1",
      sessionId: "session-1",
      client: "discord",
      userId: "user-1",
      projectCwd: "/workspace",
    },
    completionTarget: { kind: "detached" },
    progressTarget: null,
    terminalDetail: null,
    result: null,
    resultArtifactId: null,
    claimedBy: null,
    claimedAt: null,
    createdAt: 10,
    startedAt: null,
    updatedAt: 10,
    terminalAt: null,
  };
}
function liveParentRun(id: string, parentRequestId: string): WorkflowRun {
  return {
    ...run(id),
    completionTarget: {
      kind: "live_parent",
      parentRequestId,
      parentSessionId: "session-1",
      parentRequestClient: "discord",
      parentToolCallId: `tool-${id}`,
      childRequestId: `child-${id}`,
      childSessionId: `child-session-${id}`,
      profile: "general",
      sessionName: `session-${id}`,
      depth: 1,
      reasoning: null,
      fallbackToSurface: true,
      fallbackProgressTarget: {
        platform: "discord",
        channelId: "session-1",
        replyToMessageId: null,
      },
      deferredDelivery: true,
    },
  };
}
function operation(runId: string, operationId: string): WorkflowOperation {
  const input = { prompt: "inspect", options: { profile: "general", cwd: "/workspace" } };
  return {
    runId,
    operationId,
    callSiteId: `call-${operationId}`,
    parentOperationId: null,
    phase: null,
    label: null,
    kind: "agent",
    input,
    inputSha256: canonicalJsonSha256(input),
    state: "queued",
    attempt: 0,
    requestId: null,
    output: null,
    resultArtifactId: null,
    error: null,
    usage: null,
    claimedBy: null,
    claimedAt: null,
    createdAt: 11,
    startedAt: null,
    updatedAt: 11,
    terminalAt: null,
  };
}
function downgradeSchemaToV21(db: Database): void {
  db.run("PRAGMA foreign_keys = OFF");
  db.run("ALTER TABLE workflow_request_dispatches RENAME TO workflow_request_dispatches_v23");
  db.run(`CREATE TABLE workflow_request_dispatches (
    request_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    owner_id TEXT,
    owner_heartbeat_at INTEGER,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    prompt_published_at INTEGER,
    dispatch_epoch TEXT NOT NULL,
    UNIQUE (run_id, operation_id)
  )`);
  db.run(`INSERT INTO workflow_request_dispatches (
    request_id, run_id, operation_id, session_id, platform, policy_json, expires_at,
    owner_id, owner_heartbeat_at, active, created_at, updated_at, prompt_published_at,
    dispatch_epoch
  ) SELECT request_id, run_id, operation_id, session_id, platform, policy_json,
    9007199254740991, owner_id, owner_heartbeat_at, active, created_at, updated_at,
    prompt_published_at, dispatch_epoch FROM workflow_request_dispatches_v23`);
  db.run("DROP TABLE workflow_request_dispatches_v23");
  db.run(`CREATE INDEX idx_workflow_request_dispatches_active
    ON workflow_request_dispatches(active, owner_heartbeat_at, expires_at)`);
  db.run("DROP TRIGGER workflow_completion_delivery_after_run_insert");
  db.run("ALTER TABLE workflow_completion_deliveries RENAME TO workflow_completion_deliveries_v22");
  db.run(`CREATE TABLE workflow_completion_deliveries (
    run_id TEXT PRIMARY KEY REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
    parent_request_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'fallback')),
    delivered_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.run(`INSERT INTO workflow_completion_deliveries (
    run_id, parent_request_id, state, delivered_at, created_at, updated_at
  ) SELECT run_id, parent_request_id, state, delivered_at, created_at, updated_at
    FROM workflow_completion_deliveries_v22`);
  db.run("DROP TABLE workflow_completion_deliveries_v22");
  db.run(`CREATE INDEX idx_workflow_completion_deliveries_parent_state
    ON workflow_completion_deliveries(parent_request_id, state, created_at, run_id)`);
  db.run(`CREATE TRIGGER workflow_completion_delivery_after_run_insert
    AFTER INSERT ON workflow_runs
    WHEN json_extract(NEW.completion_target_json, '$.kind') = 'live_parent'
    BEGIN
      INSERT INTO workflow_completion_deliveries (
        run_id, parent_request_id, state, delivered_at, created_at, updated_at
      ) VALUES (
        NEW.run_id,
        json_extract(NEW.completion_target_json, '$.parentRequestId'),
        'pending',
        NULL,
        NEW.created_at,
        NEW.created_at
      );
    END`);
  db.run("DELETE FROM workflow_schema_migrations WHERE version >= 22");
}
function downgradeSchemaToV20(db: Database): void {
  downgradeSchemaToV21(db);
  db.run("DELETE FROM workflow_schema_migrations WHERE version = 21");
  db.run(`CREATE TABLE workflow_approvals (
    approval_id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, state TEXT NOT NULL
  )`);
  db.run("ALTER TABLE workflow_runs ADD COLUMN approval_id TEXT");
  db.run("ALTER TABLE workflow_runs ADD COLUMN origin_safety_mode TEXT NOT NULL DEFAULT 'trusted'");
  db.run("CREATE INDEX idx_workflow_runs_approval_state ON workflow_runs(approval_id, state)");
  db.run("ALTER TABLE workflow_surface_actions ADD COLUMN approval_id TEXT");
  db.run("ALTER TABLE workflow_request_dispatches RENAME TO workflow_request_dispatches_v21");
  db.run(`CREATE TABLE workflow_request_dispatches (
    request_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    token_sha256 TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    canonical_cwd TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    owner_id TEXT,
    owner_heartbeat_at INTEGER,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    prompt_published_at INTEGER,
    dispatch_epoch TEXT,
    UNIQUE (run_id, operation_id)
  )`);
  db.run("DROP TABLE workflow_request_dispatches_v21");
  db.run(`CREATE TABLE workflow_worktree_outputs (
    run_id TEXT NOT NULL, operation_id TEXT NOT NULL, state TEXT NOT NULL,
    worktree_path TEXT NOT NULL, base_commit TEXT, artifact_id TEXT, patch_sha256 TEXT,
    bytes INTEGER, cleanup_error TEXT, prepared_at INTEGER NOT NULL, captured_at INTEGER,
    cleaned_at INTEGER, PRIMARY KEY (run_id, operation_id)
  )`);
  db.run(`UPDATE workflow_revisions SET
    capabilities_json = json_set(capabilities_json, '$.safety', json('{"originatingMode":"trusted","escalation":"none"}')),
    limits_json = json_set(limits_json, '$.maxRuntimeMemoryBytes', 268435456),
    runtime_version = 'lilac-workflow-js-v3'`);
}
describe("durable workflow store minimal dispatch schema", () => {
  it("keeps the reported schema version aligned with the latest migration", () => {
    const latestMigrationVersion = Math.max(...WORKFLOW_MIGRATION_VERSIONS);
    expect(WORKFLOW_SCHEMA_VERSION).toBe(latestMigrationVersion);
  });
  it("does not touch SQLite when the migration clock throws", () => {
    const db = new Database(":memory:");
    const defect = new Error("migration clock defect");
    let caught: unknown;
    try {
      applyWorkflowSchemaMigrations(db, () => {
        throw defect;
      });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBe(defect);
    expect(
      db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
    ).toEqual([]);
    db.close();
  });
  it("preserves migration clock Panic identity without touching SQLite", () => {
    const db = new Database(":memory:");
    const panic = new Panic({ message: "migration clock panic" });
    let caught: unknown;
    try {
      applyWorkflowSchemaMigrations(db, () => {
        throw panic;
      });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBe(panic);
    expect(
      db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
    ).toEqual([]);
    db.close();
  });
  it("returns an owned invalid-clock Result before touching SQLite", () => {
    const db = new Database(":memory:");
    const migrated = applyWorkflowSchemaMigrations(db, () => Number.NaN);
    expect(migrated.status).toBe("error");
    if (migrated.status === "error") {
      expect(migrated.error).toBeInstanceOf(WorkflowMigrationInvalidTimestamp);
    }
    expect(
      db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
    ).toEqual([]);
    db.close();
  });
  for (const historicalVersion of WORKFLOW_MIGRATION_VERSIONS) {
    it(`upgrades a valid v${historicalVersion} migration-prefix layout through v${WORKFLOW_SCHEMA_VERSION}`, () => {
      const db = new Database(":memory:");
      try {
        const historical = applyWorkflowSchemaMigrations(
          db,
          () => historicalVersion,
          historicalVersion,
        );
        expect(historical.status).toBe("ok");
        const prefix = db
          .query<
            {
              version: number;
            },
            []
          >("SELECT version FROM workflow_schema_migrations ORDER BY version")
          .all();
        expect(prefix.map(({ version }) => version)).toEqual(
          WORKFLOW_MIGRATION_VERSIONS.filter((version) => version <= historicalVersion),
        );
        const upgraded = applyWorkflowSchemaMigrations(db, () => WORKFLOW_SCHEMA_VERSION);
        expect(upgraded.status).toBe("ok");
        const complete = db
          .query<
            {
              version: number;
            },
            []
          >("SELECT version FROM workflow_schema_migrations ORDER BY version")
          .all();
        expect(complete.map(({ version }) => version)).toEqual([...WORKFLOW_MIGRATION_VERSIONS]);
      } finally {
        db.close();
      }
    });
  }
  it("rejects workflow databases migrated by an unknown future runtime", () => {
    const file = dbPath("future-schema");
    const db = new Database(file);
    const futureVersion = WORKFLOW_SCHEMA_VERSION + 1;
    try {
      applyWorkflowSchemaMigrations(db);
      db.run(
        "INSERT INTO workflow_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        [futureVersion, "future migration", 1],
      );
      const migrated = applyWorkflowSchemaMigrations(db);
      expect(migrated.status).toBe("error");
      if (migrated.status === "error") {
        expect(migrated.error).toMatchObject({
          _tag: "WorkflowMigrationUnsupportedVersion",
          version: futureVersion,
        });
      }
    } finally {
      db.close();
      rmSync(file, { force: true });
    }
  });
  it("fails a corrupt list row and emits only bounded redacted provenance", async () => {
    const file = dbPath("corrupt-list-row");
    const diagnostics: Array<{
      table: string;
      field: string;
      version: number;
      issueCode: string;
      recordId: string;
    }> = [];
    const store = new DurableWorkflowStore(file, {
      onPersistenceDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const corruptor = new Database(file);
    try {
      store.createInvocation({ revision: revision(), run: run() });
      corruptor.run("UPDATE workflow_runs SET args_json = ? WHERE run_id = ?", [
        '{"secret":"must-not-appear"',
        "run-1",
      ]);
      const listed = store.listRuns();
      expect(listed.status).toBe("error");
      if (listed.status === "error") expect(listed.error._tag).toBe("MalformedSerialization");
      await Promise.resolve();
      expect(diagnostics).toEqual([
        {
          table: "workflow_runs",
          field: "args_json",
          version: WORKFLOW_SCHEMA_VERSION,
          issueCode: "malformed-json",
          recordId: "run-1",
        },
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain("must-not-appear");
    } finally {
      corruptor.close();
      store.close();
      rmSync(file, { force: true });
    }
  });
  it("returns the original invocation read error through the SQLite transaction", () => {
    const file = dbPath("invocation-read-error");
    const store = new InvocationReadFailureStore(file);
    try {
      const input = {
        revision: revision(),
        run: run(),
        idempotency: { key: "same-invocation", fingerprintSha256: "fingerprint" },
      };
      expect(store.createInvocation(input).status).toBe("ok");
      const readFailure = new MalformedSerialization({
        table: "workflow_runs",
        field: "args_json",
        version: WORKFLOW_SCHEMA_VERSION,
        issueCode: "malformed-json",
        recordId: "run-1",
        message: "Workflow run args are malformed",
      });
      store.readFailure = readFailure;
      const replayed = store.createInvocation(input);
      expect(replayed.status).toBe("error");
      if (replayed.status === "error") expect(replayed.error).toBe(readFailure);
    } finally {
      store.close();
      rmSync(file, { force: true });
    }
  });
  it("bounds reconciliation to active runs and terminal runs missing bindings", () => {
    const file = dbPath("active-progress-targets");
    const store = new DurableWorkflowStore(file);
    const progressTarget = {
      platform: "discord" as const,
      channelId: "channel-1",
      replyToMessageId: null,
    };
    try {
      const rev = revision();
      store.createInvocation({
        revision: rev,
        run: { ...run("active-a"), progressTarget, updatedAt: 11 },
      });
      store.createRun({ ...run("active-b"), progressTarget, updatedAt: 12 });
      store.createRun({ ...run("terminal"), progressTarget, updatedAt: 9 });
      store.createRun({ ...run("without-target"), updatedAt: 8 });
      expect(
        store.transitionRun({
          runId: "terminal",
          from: "queued",
          to: "cancelled",
          now: 13,
        }),
      ).toBe(true);
      expect(
        workflowStoreValue(store.listRunsNeedingProjectionReconciliation(1)).map(
          (item) => item.runId,
        ),
      ).toEqual(["active-a"]);
      expect(
        workflowStoreValue(store.listRunsNeedingProjectionReconciliation()).map(
          (item) => item.runId,
        ),
      ).toEqual(["active-a", "active-b", "terminal"]);
    } finally {
      store.close();
      rmSync(file, { force: true });
    }
  });
  it("creates and claims queued invocations without approval or safety semantics", () => {
    const file = dbPath("minimal-dispatch");
    const store = new DurableWorkflowStore(file);
    try {
      const created = store.createInvocation({ revision: revision(), run: run() });
      expect(created).toMatchObject({
        status: "ok",
        value: { status: "accepted", run: { state: "queued" } },
      });
      expect(store.tryClaimRun({ runId: "run-1", claimerId: "worker-1", now: 20 })?.state).toBe(
        "running",
      );
      expect(store.listMigrations().at(-1)).toMatchObject({
        version: WORKFLOW_SCHEMA_VERSION,
        name: "durable orphaned live-parent delivery",
      });
    } finally {
      store.close();
    }
    const db = new Database(file);
    try {
      const tables = db
        .query<
          {
            name: string;
          },
          []
        >("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name);
      expect(tables).not.toContain("workflow_approvals");
      expect(tables).not.toContain("workflow_worktree_outputs");
      expect(tables).not.toContain("workflow_surface_projection_claims");
      expect(tables).not.toContain("workflow_surface_projection_orphans");
      expect(tables).not.toContain("workflow_missing_surface_bindings");
      expect(tables).not.toContain("workflow_projection_reconciliation_state");
      const runColumns = db
        .query<
          {
            name: string;
          },
          []
        >("PRAGMA table_info(workflow_runs)")
        .all()
        .map((row) => row.name);
      expect(runColumns).not.toContain("approval_id");
      expect(runColumns).not.toContain("origin_safety_mode");
      const dispatchColumns = db
        .query<
          {
            name: string;
          },
          []
        >("PRAGMA table_info(workflow_request_dispatches)")
        .all()
        .map((row) => row.name);
      expect(dispatchColumns).not.toContain("token_sha256");
      expect(dispatchColumns).not.toContain("canonical_cwd");
      expect(
        db
          .query<
            {
              name: string;
            },
            []
          >("PRAGMA table_info(workflow_surface_bindings)")
          .all()
          .map((row) => row.name),
      ).toEqual([
        "run_id",
        "target_json",
        "message_ref_json",
        "last_rendered_sha256",
        "last_error",
        "retry_count",
        "next_attempt_at",
        "created_at",
        "updated_at",
      ]);
      expect(
        db
          .query<
            {
              name: string;
            },
            []
          >("PRAGMA table_info(workflow_action_outbox)")
          .all()
          .map((row) => row.name),
      ).toEqual([
        "outbox_id",
        "action_id",
        "run_id",
        "event_type",
        "payload_json",
        "published_at",
        "projected_at",
        "attempt_count",
        "next_attempt_at",
        "last_error",
        "created_at",
        "updated_at",
      ]);
    } finally {
      db.close();
      rmSync(file, { force: true });
    }
  });
  it("atomically orphans unreachable live-parent runs while retaining reachable chains", () => {
    const file = dbPath("live-parent-orphans");
    const store = new DurableWorkflowStore(file);
    try {
      store.createRevision(revision());
      expect(store.createRun(liveParentRun("reachable", "root-parent"))).toBe(true);
      expect(store.createRun(liveParentRun("nested", "workflow-request"))).toBe(true);
      expect(store.createRun(liveParentRun("active-orphan", "missing-parent"))).toBe(true);
      expect(store.createRun(liveParentRun("terminal-orphan", "missing-parent"))).toBe(true);
      expect(
        store.tryClaimRun({ runId: "reachable", claimerId: "worker", now: 20 }),
      ).not.toBeNull();
      expect(
        store.createOperation(
          {
            ...operation("reachable", "agent-op"),
            state: "running",
            requestId: "workflow-request",
          },
          "worker",
        ),
      ).toBe(true);
      expect(
        store.transitionRun({
          runId: "terminal-orphan",
          from: "queued",
          to: "running",
          now: 21,
        }),
      ).toBe(true);
      expect(
        store.transitionRun({
          runId: "terminal-orphan",
          from: "running",
          to: "succeeded",
          now: 22,
          result: "completed without a parent",
        }),
      ).toBe(true);
      const orphaned = store.reconcileOrphanedLiveParentRuns({
        resolvableParentRequestIds: ["root-parent"],
        now: 30,
        detail: "parent request unavailable",
      });
      expect(orphaned.map((entry) => entry.run.runId)).toEqual([
        "active-orphan",
        "terminal-orphan",
      ]);
      expect(workflowStoreValue(store.getRun("reachable"))?.state).toBe("running");
      expect(workflowStoreValue(store.getRun("nested"))?.state).toBe("queued");
      expect(workflowStoreValue(store.getRun("active-orphan"))).toMatchObject({
        state: "cancelled",
        terminalDetail: "parent request unavailable",
      });
      expect(workflowStoreValue(store.getRun("terminal-orphan"))).toMatchObject({
        state: "succeeded",
        result: "completed without a parent",
      });
      expect(store.getLiveParentDeliveryState("reachable")).toBe("pending");
      expect(store.getLiveParentDeliveryState("nested")).toBe("pending");
      expect(store.getLiveParentDeliveryState("active-orphan")).toBe("orphaned");
      expect(store.getLiveParentDeliveryState("terminal-orphan")).toBe("orphaned");
      expect(
        store.reconcileOrphanedLiveParentRuns({
          resolvableParentRequestIds: ["root-parent"],
          now: 31,
          detail: "parent request unavailable",
        }),
      ).toEqual([]);
    } finally {
      store.close();
      rmSync(file, { force: true });
    }
  });
  it("retires previously committed live-parent surface fallbacks during migration", () => {
    const file = dbPath("retire-live-parent-fallback");
    const initial = new DurableWorkflowStore(file);
    initial.createRevision(revision());
    expect(initial.createRun(liveParentRun("legacy-fallback", "missing-parent"))).toBe(true);
    initial.close();
    const db = new Database(file);
    db.run(`UPDATE workflow_completion_deliveries SET state = 'fallback', delivered_at = 20
       WHERE run_id = 'legacy-fallback'`);
    db.run(`UPDATE workflow_runs SET progress_target_json = ? WHERE run_id = 'legacy-fallback'`, [
      JSON.stringify({ platform: "discord", channelId: "session-1", replyToMessageId: null }),
    ]);
    downgradeSchemaToV21(db);
    db.close();
    const migrated = new DurableWorkflowStore(file);
    try {
      expect(migrated.getLiveParentDeliveryState("legacy-fallback")).toBe("orphaned");
      expect(workflowStoreValue(migrated.getRun("legacy-fallback"))?.progressTarget).toBeNull();
    } finally {
      migrated.close();
      rmSync(file, { force: true });
    }
  });
  it("atomically enforces the global active-run cap and admits after terminalization", () => {
    const file = dbPath("active-run-cap");
    const store = new DurableWorkflowStore(file);
    const rejectedRevision = {
      ...revision("revision-rejected"),
      normalizedPath: "rejected.js",
    };
    try {
      expect(
        store.createInvocation({
          revision: revision("revision-active"),
          run: run("run-active", "revision-active"),
          maxActiveRuns: 1,
        }),
      ).toMatchObject({ status: "ok", value: { status: "accepted" } });
      expect(store.countActiveRuns()).toBe(1);
      expect(
        store.createInvocation({
          revision: rejectedRevision,
          run: run("run-rejected", "revision-rejected"),
          maxActiveRuns: 1,
        }),
      ).toMatchObject({
        status: "ok",
        value: { status: "rejected_capacity", activeRuns: 1, limit: 1 },
      });
      expect(workflowStoreValue(store.getRun("run-rejected"))).toBeNull();
      expect(workflowStoreValue(store.getRevision("revision-rejected"))).toBeNull();
      expect(
        store.transitionRun({
          runId: "run-active",
          from: "queued",
          to: "cancelled",
          now: 20,
        }),
      ).toBe(true);
      expect(store.countActiveRuns()).toBe(0);
      expect(
        store.createInvocation({
          revision: rejectedRevision,
          run: run("run-rejected", "revision-rejected"),
          maxActiveRuns: 1,
        }),
      ).toMatchObject({
        status: "ok",
        value: { status: "accepted", run: { runId: "run-rejected" } },
      });
    } finally {
      store.close();
      rmSync(file, { force: true });
    }
  });
  it("reuses an idempotent invocation at capacity and rejects a new key without rows", () => {
    const file = dbPath("active-run-cap-idempotency");
    const store = new DurableWorkflowStore(file);
    const fingerprintSha256 = "f".repeat(64);
    try {
      const first = store.createInvocation({
        revision: revision("revision-first"),
        run: run("run-first", "revision-first"),
        idempotency: { key: "existing-key", fingerprintSha256 },
        maxActiveRuns: 1,
      });
      expect(first).toMatchObject({
        status: "ok",
        value: { status: "accepted", run: { runId: "run-first" } },
      });
      expect(
        store.createInvocation({
          revision: revision("revision-replay"),
          run: run("run-replay", "revision-replay"),
          idempotency: { key: "existing-key", fingerprintSha256 },
          maxActiveRuns: 1,
        }),
      ).toMatchObject({
        status: "ok",
        value: { status: "accepted", run: { runId: "run-first" } },
      });
      expect(
        store.createInvocation({
          revision: revision("revision-new"),
          run: run("run-new", "revision-new"),
          idempotency: { key: "new-key", fingerprintSha256: "e".repeat(64) },
          maxActiveRuns: 1,
        }),
      ).toMatchObject({
        status: "ok",
        value: { status: "rejected_capacity", activeRuns: 1, limit: 1 },
      });
      expect(workflowStoreValue(store.getRun("run-replay"))).toBeNull();
      expect(workflowStoreValue(store.getRun("run-new"))).toBeNull();
      expect(workflowStoreValue(store.getRevision("revision-replay"))).toBeNull();
      expect(workflowStoreValue(store.getRevision("revision-new"))).toBeNull();
    } finally {
      store.close();
    }
    const db = new Database(file);
    try {
      expect(
        db
          .query<
            {
              count: number;
            },
            []
          >("SELECT COUNT(*) AS count FROM workflow_invocation_receipts")
          .get()?.count,
      ).toBe(1);
    } finally {
      db.close();
      rmSync(file, { force: true });
    }
  });
  it("migrates v20 through the current schema and archives incompatible execution history", () => {
    const file = dbPath("v20-minimal-contract");
    const store = new DurableWorkflowStore(file);
    const rev = revision();
    store.createInvocation({ revision: rev, run: run("active-run") });
    store.tryClaimRun({ runId: "active-run", claimerId: "old-worker", now: 20 });
    store.createOperation(operation("active-run", "active-operation"), "old-worker");
    store.createInvocation({ revision: rev, run: run("terminal-run") });
    store.tryClaimRun({ runId: "terminal-run", claimerId: "old-worker", now: 20 });
    store.createOperation(operation("terminal-run", "terminal-operation"), "old-worker");
    store.transitionOperation({
      runId: "terminal-run",
      operationId: "terminal-operation",
      from: "queued",
      to: "dispatched",
      runOwnerId: "old-worker",
      now: 21,
    });
    store.transitionOperation({
      runId: "terminal-run",
      operationId: "terminal-operation",
      from: "dispatched",
      to: "running",
      runOwnerId: "old-worker",
      now: 22,
    });
    store.transitionOperation({
      runId: "terminal-run",
      operationId: "terminal-operation",
      from: "running",
      to: "succeeded",
      runOwnerId: "old-worker",
      now: 23,
      output: "complete",
    });
    store.terminalizeRun({
      runId: "terminal-run",
      from: "running",
      to: "succeeded",
      ownerId: "old-worker",
      now: 24,
      detail: "complete",
      result: { ok: true },
      resultArtifactId: null,
    });
    store.createInvocation({ revision: rev, run: run("rejected-run") });
    const trigger: WorkflowTrigger = {
      triggerId: "active-trigger",
      revisionId: rev.revisionId,
      state: "active",
      definition: { kind: "timestamp", at: 100 },
      args: {},
      argsSha256: canonicalJsonSha256({}),
      schedulingPolicy: { skipMissed: true, overlap: "coalesce" },
      origin: run().origin,
      completionTarget: { kind: "detached" },
      progressTarget: null,
      nextFireAt: 100,
      lastFireAt: null,
      lastRunId: null,
      claimedBy: null,
      claimedAt: null,
      createdAt: 10,
      updatedAt: 10,
    };
    store.createTriggerInvocation({
      trigger,
      idempotency: { key: "active-trigger", fingerprintSha256: "c".repeat(64) },
    });
    store.close();
    const legacy = new Database(file);
    downgradeSchemaToV20(legacy);
    legacy.run(`UPDATE workflow_runs
       SET state = 'rejected', terminal_detail = 'approval rejected', terminal_at = 25
       WHERE run_id = 'rejected-run'`);
    legacy.run(`UPDATE workflow_operations SET state = 'running', request_id = 'active-request',
       claimed_by = 'old-worker', claimed_at = 20 WHERE run_id = 'active-run'`);
    legacy.run(
      `INSERT INTO workflow_request_dispatches (
         request_id, run_id, operation_id, token_sha256, session_id, platform,
         canonical_cwd, policy_json, expires_at, owner_id, owner_heartbeat_at,
         active, created_at, updated_at, prompt_published_at, dispatch_epoch
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1000, ?, 20, 1, 20, 20, 20, ?)`,
      [
        "active-request",
        "active-run",
        "active-operation",
        "0".repeat(64),
        "workflow:active",
        "unknown",
        "/workspace",
        JSON.stringify({
          profile: "general",
          model: null,
          reasoning: null,
          resolvedModelRequest: {
            spec: "profile-native:general",
            provider: "test",
            modelId: "general",
            reasoningDisplay: "simple",
          },
          canonicalCwd: "/workspace",
        }),
        "runner-old",
        "old-dispatch-epoch",
      ],
    );
    legacy.run(`INSERT INTO workflow_request_terminal_receipts (
         request_id, run_id, operation_id, dispatch_epoch, state, detail, created_at,
         output_json, result_artifact_id, usage_json
       ) VALUES ('terminal-request', 'terminal-run', 'terminal-operation', 'terminal-epoch',
          'resolved', 'complete', 24, '"complete"', NULL, NULL)`);
    legacy.run(
      `INSERT INTO workflow_request_dispatches (
         request_id, run_id, operation_id, token_sha256, session_id, platform,
         canonical_cwd, policy_json, expires_at, active, created_at, updated_at,
         prompt_published_at, dispatch_epoch
       ) VALUES ('legacy-terminal-dispatch', 'terminal-run', 'terminal-operation', ?,
         'workflow:terminal', 'unknown', '/workspace', '{not-json', 24, 0, 20, 24, 20,
         'legacy-terminal-epoch')`,
      ["1".repeat(64)],
    );
    legacy.close();
    const migrated = new DurableWorkflowStore(file);
    try {
      expect(workflowStoreValue(migrated.getRun("active-run"))).toBeNull();
      expect(
        workflowStoreValue(migrated.getOperation("active-run", "active-operation")),
      ).toBeNull();
      expect(workflowStoreValue(migrated.getTrigger("active-trigger"))).toBeNull();
      expect(workflowStoreValue(migrated.getRun("terminal-run"))).toBeNull();
      expect(workflowStoreValue(migrated.getRun("rejected-run"))).toBeNull();
      expect(
        workflowStoreValue(migrated.getWorkflowRequestTerminalReceipt("terminal-request")),
      ).toBeNull();
      expect(
        workflowStoreValue(migrated.getWorkflowRequestDispatchPolicy("active-request")),
      ).toBeNull();
      expect(
        workflowStoreValue(migrated.getWorkflowRequestDispatchPolicy("legacy-terminal-dispatch")),
      ).toBeNull();
    } finally {
      migrated.close();
    }
    const inspected = new Database(file);
    try {
      expect(
        inspected
          .query<
            {
              version: number;
            },
            []
          >("SELECT version FROM workflow_schema_migrations ORDER BY version DESC LIMIT 1")
          .get()?.version,
      ).toBe(WORKFLOW_SCHEMA_VERSION);
      const quarantine = inspected
        .query<
          {
            record_kind: string;
            record_id: string;
          },
          []
        >("SELECT record_kind, record_id FROM workflow_quarantine")
        .all();
      expect(quarantine).toEqual(
        expect.arrayContaining([
          { record_kind: "run", record_id: "active-run" },
          { record_kind: "operation", record_id: "active-run:active-operation" },
          { record_kind: "trigger", record_id: "active-trigger" },
        ]),
      );
      const audit = inspected
        .query<
          {
            record_kind: string;
            record_id: string;
          },
          []
        >("SELECT record_kind, record_id FROM workflow_legacy_audit_records")
        .all();
      expect(audit).toEqual(
        expect.arrayContaining([
          { record_kind: "revision", record_id: "revision-1" },
          { record_kind: "run", record_id: "active-run" },
          { record_kind: "run", record_id: "terminal-run" },
          { record_kind: "trigger", record_id: "active-trigger" },
          { record_kind: "terminal_receipt", record_id: "terminal-request" },
        ]),
      );
      expect(
        inspected
          .query<
            {
              active: number;
            },
            []
          >("SELECT active FROM workflow_request_dispatches WHERE request_id = 'active-request'")
          .get()?.active,
      ).toBeUndefined();
      expect(
        inspected
          .query<
            {
              name: string;
            },
            []
          >("PRAGMA table_info(workflow_request_dispatches)")
          .all()
          .map((column) => column.name),
      ).not.toContain("expires_at");
    } finally {
      inspected.close();
      rmSync(file, { force: true });
    }
  });
  it("ignores fallbacks but pins every head field across dispatch epochs", () => {
    const file = dbPath("resolved-model-pinning");
    const store = new DurableWorkflowStore(file);
    try {
      store.createInvocation({ revision: revision(), run: run() });
      store.tryClaimRun({ runId: "run-1", claimerId: "worker-1", now: 20 });
      store.createOperation(operation("run-1", "operation-1"), "worker-1");
      const policy = {
        runId: "run-1",
        operationId: "operation-1",
        dispatchEpoch: "a".repeat(32),
        profile: "general" as const,
        model: null,
        reasoning: null,
        resolvedModelRequest: {
          spec: "provider/model-a",
          provider: "provider",
          modelId: "model-a",
          reasoningDisplay: "simple" as const,
          fallbacks: [
            {
              spec: "provider/fallback-a",
              provider: "provider",
              modelId: "fallback-a",
              reasoningDisplay: "simple" as const,
            },
          ],
        },
        cwd: "/workspace",
        originSession: {
          requestId: "request-1",
          sessionId: "session-1",
          client: "discord" as const,
          userId: "user-1",
        },
      };
      expect(
        store.authorizeAgentDispatch({
          requestId: "agent-request",
          runId: "run-1",
          operationId: "operation-1",
          runOwnerId: "worker-1",
          sessionId: "workflow:run-1:operation-1",
          platform: "unknown",
          policy,
          now: 21,
          staleOwnerBefore: 21,
        }),
      ).toMatchObject({ state: "dispatched" });
      expect(
        JSON.stringify(workflowStoreValue(store.getWorkflowRequestDispatchPolicy("agent-request"))),
      ).toBe(JSON.stringify(policy));
      const refreshedFallbackPolicy = {
        ...policy,
        dispatchEpoch: "b".repeat(32),
        resolvedModelRequest: {
          ...policy.resolvedModelRequest,
          fallbacks: [
            {
              spec: "provider/fallback-b",
              provider: "provider",
              modelId: "fallback-b",
              reasoning: "high" as const,
              reasoningDisplay: "detailed" as const,
            },
          ],
        },
      };
      expect(
        store.authorizeAgentDispatch({
          requestId: "agent-request",
          runId: "run-1",
          operationId: "operation-1",
          runOwnerId: "worker-1",
          sessionId: "workflow:run-1:operation-1",
          platform: "unknown",
          policy: refreshedFallbackPolicy,
          now: 22,
          staleOwnerBefore: 22,
        }),
      ).toMatchObject({ state: "dispatched" });
      expect(
        JSON.stringify(workflowStoreValue(store.getWorkflowRequestDispatchPolicy("agent-request"))),
      ).toBe(JSON.stringify(refreshedFallbackPolicy));
      expect(
        store.authorizeAgentDispatch({
          requestId: "agent-request",
          runId: "run-1",
          operationId: "operation-1",
          runOwnerId: "worker-1",
          sessionId: "workflow:run-1:operation-1",
          platform: "unknown",
          policy: {
            ...refreshedFallbackPolicy,
            dispatchEpoch: "c".repeat(32),
            resolvedModelRequest: {
              ...refreshedFallbackPolicy.resolvedModelRequest,
              spec: "provider/model-b",
              modelId: "model-b",
            },
          },
          now: 23,
          staleOwnerBefore: 23,
        }),
      ).toBeNull();
      expect(
        JSON.stringify(workflowStoreValue(store.getWorkflowRequestDispatchPolicy("agent-request"))),
      ).toBe(JSON.stringify(refreshedFallbackPolicy));
    } finally {
      store.close();
      rmSync(file, { force: true });
    }
  });
  it("binds stable named continuation authority to the durable completion target", () => {
    const file = dbPath("stable-named-policy");
    const store = new DurableWorkflowStore(file);
    try {
      const childSessionId = "sub:parent-session:named:generated";
      const namedRun: WorkflowRun = {
        ...run(),
        completionTarget: {
          kind: "live_parent",
          parentRequestId: "parent-request",
          parentSessionId: "parent-session",
          parentRequestClient: "discord",
          parentToolCallId: "parent-tool",
          childRequestId: "child-request",
          childSessionId,
          profile: "general",
          sessionName: "generated",
          stableNamedContinuation: true,
          depth: 1,
          reasoning: null,
          fallbackToSurface: false,
          fallbackProgressTarget: null,
          deferredDelivery: true,
        },
      };
      store.createInvocation({ revision: revision(), run: namedRun });
      store.tryClaimRun({ runId: "run-1", claimerId: "worker-1", now: 20 });
      store.createOperation(operation("run-1", "operation-1"), "worker-1");
      const policy = {
        runId: "run-1",
        operationId: "operation-1",
        dispatchEpoch: "a".repeat(32),
        profile: "general" as const,
        model: null,
        reasoning: null,
        resolvedModelRequest: {
          spec: "provider/model-a",
          provider: "provider",
          modelId: "model-a",
          reasoningDisplay: "simple" as const,
        },
        cwd: "/workspace",
        originSession: {
          requestId: namedRun.origin.requestId,
          sessionId: namedRun.origin.sessionId,
          client: namedRun.origin.client,
          userId: namedRun.origin.userId,
        },
      };
      const authorize = (stableNamedContinuation?: {
        sessionId: string;
        requestClient: "discord" | "github";
      }) =>
        store.authorizeAgentDispatch({
          requestId: "agent-request",
          runId: "run-1",
          operationId: "operation-1",
          runOwnerId: "worker-1",
          sessionId: childSessionId,
          platform: "unknown",
          policy: { ...policy, stableNamedContinuation },
          now: 21,
          staleOwnerBefore: 21,
        });
      expect(authorize()).toBeNull();
      expect(
        authorize({
          sessionId: childSessionId,
          requestClient: "github",
        }),
      ).toBeNull();
      expect(
        authorize({
          sessionId: childSessionId,
          requestClient: "discord",
        }),
      ).toMatchObject({ state: "dispatched" });
    } finally {
      store.close();
      rmSync(file, { force: true });
    }
  });
  it("decodes legacy and flat fallback model requests but rejects recursive fallbacks", () => {
    const legacy = {
      spec: "provider/model-a",
      provider: "provider",
      modelId: "model-a",
      reasoningDisplay: "simple" as const,
    };
    expect(workflowResolvedModelRequestSchema.parse(legacy)).toEqual(legacy);
    expect(
      workflowResolvedModelRequestSchema.parse({
        ...legacy,
        fallbacks: [
          {
            ...legacy,
            reasoning: "high",
            reasoningDisplay: "detailed",
          },
        ],
      }),
    ).toEqual({
      ...legacy,
      fallbacks: [{ ...legacy, reasoning: "high", reasoningDisplay: "detailed" }],
    });
    expect(
      workflowResolvedModelRequestSchema.safeParse({
        ...legacy,
        fallbacks: [{ ...legacy, fallbacks: [] }],
      }).success,
    ).toBe(false);
    expect(
      workflowResolvedModelRequestSchema.safeParse({
        ...legacy,
        openaiServerCompaction: false,
      }).success,
    ).toBe(false);
    expect(
      workflowResolvedModelRequestSchema.safeParse({
        ...legacy,
        provider: "anthropic",
        spec: "anthropic/claude-test",
        modelId: "claude-test",
        openaiServerCompaction: true,
      }).success,
    ).toBe(false);
  });
});
