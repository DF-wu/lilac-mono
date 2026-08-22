import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import path from "node:path";

import { materializeBlobRead, type BlobStore } from "@stanley2058/lilac-blob-storage";
import { classifyBunSqliteError, errorCode } from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import {
  decodeWorkflowValueArtifact,
  workflowValueArtifactFileByteLimit,
} from "../src/workflow/workflow-artifact-persistence-codec";
import { sha256 } from "../src/workflow/workflow-definition";
import {
  workflowArtifactIdSchema,
  workflowLimitsSchema,
  type WorkflowLimits,
} from "../src/workflow/workflow-domain";
import {
  applyWorkflowBlobStorageSchema26Migration,
  type StagedWorkflowArtifact,
  type WorkflowMigrationError,
} from "../src/workflow/workflow-migrations";
import { preserveToolPanic } from "../src/tools/tool-result-adapters";

const LEGACY_WORKFLOW_SCHEMA_VERSION = 25;
const CURRENT_WORKFLOW_SCHEMA_VERSION = 26;
const SOURCE_ARTIFACT_PREFIX = "workflow-source:";
const VALUE_ARTIFACT_PREFIX = "workflow-value:";

const LEGACY_WORKFLOW_MIGRATION_LEDGER = [
  "initial durable workflow schema",
  "durable waits and trigger invocation context",
  "durable live-parent completion delivery",
  "workflow authority and incremental hardening",
  "scheduled run admission tracking",
  "round 2 trigger and delivery durability",
  "round 4 request and adapter stream linearization",
  "round 5 terminal adoption and durable workflow actions",
  "round 6 recoverable streams and fenced projection",
  "round 7 blocking legacy receipt quarantine",
  "round 8 projection repair marker",
  "round 9 generational projection repair",
  "round 12 incremental projection discovery",
  "round 15 canonical manual reconciliation state",
  "backfill workflow dispatch origin principal",
  "bounded missing surface binding reconciliation",
  "durable isolated editing outputs",
  "maximum-envelope capability contract",
  "complete envelope retirement and shared editor leases",
  "profile-native trusted auto-run clean break",
  "minimal durable dispatch contract",
  "durable live-parent materialization retries",
  "unbounded workflow v4 contract",
  "durable orphaned live-parent delivery",
  "durable workflow progress permanent failure gate",
] as const;

type LegacyWorkflowSchemaObjectType = "index" | "table" | "trigger";

const LEGACY_WORKFLOW_SCHEMA_25_OBJECT_CATALOG = [
  {
    type: "index",
    name: "idx_workflow_action_outbox_project",
    tableName: "workflow_action_outbox",
    sqlSha256: "7f185ef6673a1f558d540605bf4b59d8b09f5750c38e757dabba0d35796799d7",
  },
  {
    type: "index",
    name: "idx_workflow_action_outbox_publish",
    tableName: "workflow_action_outbox",
    sqlSha256: "c93373b3cf5ee5a45816a8ea830c12229595904348817d728d48603850bfa2fa",
  },
  {
    type: "index",
    name: "idx_workflow_adapter_event_suppressions_expiry",
    tableName: "workflow_adapter_event_suppressions",
    sqlSha256: "e17cc88d384fb7c5b54cc93b33234845e1794ee511d11f6520c84ed98e3e613a",
  },
  {
    type: "index",
    name: "idx_workflow_completion_deliveries_parent_state",
    tableName: "workflow_completion_deliveries",
    sqlSha256: "7bb98187acdf90388068f25f4d043becebebbea418772b1ac38707e232c3fe70",
  },
  {
    type: "index",
    name: "idx_workflow_operations_claim",
    tableName: "workflow_operations",
    sqlSha256: "6f43f344c61fa6e8d9524f0e613518d7d83f9ddfb190b310606d2de622045718",
  },
  {
    type: "index",
    name: "idx_workflow_operations_request",
    tableName: "workflow_operations",
    sqlSha256: "b8a1d39a8495cb934aebc0f8f9343c02c28d5ffb94849d8e420d7a115c31f936",
  },
  {
    type: "index",
    name: "idx_workflow_operations_run_state",
    tableName: "workflow_operations",
    sqlSha256: "2bced23e6c2f3f0d3fd38d70d9cb3d3ea3c6a04ebcdf0b76322c436a214b682d",
  },
  {
    type: "index",
    name: "idx_workflow_request_dispatches_active",
    tableName: "workflow_request_dispatches",
    sqlSha256: "b45f1ebbe479be2fbf2663ca9ced82e869dd7a6bab5acef5a41e04d1155623e9",
  },
  {
    type: "index",
    name: "idx_workflow_runs_origin_session",
    tableName: "workflow_runs",
    sqlSha256: "a801d2a9c1782f15878849f7b43c35a7df1eebf073bd68f00ab0020be036625a",
  },
  {
    type: "index",
    name: "idx_workflow_runs_revision_created",
    tableName: "workflow_runs",
    sqlSha256: "0af925ca6f14af83baf277d793b0498e696dae01d319c0ff2371a5ebbc965fb9",
  },
  {
    type: "index",
    name: "idx_workflow_runs_state_updated",
    tableName: "workflow_runs",
    sqlSha256: "c20b8003e9b90a9f2aaa4d5c6371418e4dbb9f0853cfb785d7e64d4937689f81",
  },
  {
    type: "index",
    name: "idx_workflow_surface_actions_run_active",
    tableName: "workflow_surface_actions",
    sqlSha256: "5f686db2fac478001b11a4b4b877dff47d6188e7f996af5e17a97042e26a9988",
  },
  {
    type: "index",
    name: "idx_workflow_surface_bindings_retry",
    tableName: "workflow_surface_bindings",
    sqlSha256: "4a1838e6b8e94c02e094c711602dc672386bc89357d26aa85decdfc818568eca",
  },
  {
    type: "index",
    name: "idx_workflow_trigger_runs_trigger_created",
    tableName: "workflow_trigger_runs",
    sqlSha256: "cf428cf4160ee2f456378d06a86f58a0dadf60a0eb0c13eab2d35e7e5d9a7843",
  },
  {
    type: "index",
    name: "idx_workflow_triggers_due",
    tableName: "workflow_triggers",
    sqlSha256: "69e36d11b76f494990980e47327f563dec5aa4b7dca0fe242cd5d929bfcb889d",
  },
  {
    type: "index",
    name: "idx_workflow_triggers_revision",
    tableName: "workflow_triggers",
    sqlSha256: "5e5fedf380a8691976fd72ab9c806cf07389c2f4f7f9b7803c6876a4f3126c41",
  },
  {
    type: "index",
    name: "idx_workflow_waits_due",
    tableName: "workflow_waits",
    sqlSha256: "8085cc030ee8ddf597fedca0140cbf2e012ccf48c9dbfbbadd4c309bf9050191",
  },
  {
    type: "index",
    name: "idx_workflow_waits_expiry_barrier",
    tableName: "workflow_waits",
    sqlSha256: "d911b1fa2231b31717be445f3f1e10bd1fcc4bab1e3a41a2e0070da260e5462f",
  },
  {
    type: "index",
    name: "idx_workflow_waits_match",
    tableName: "workflow_waits",
    sqlSha256: "7c345857775b3b3532cc082d7a1366febf9c7bf70914f23f95cb8b1dda685f47",
  },
  {
    type: "table",
    name: "workflow_action_outbox",
    tableName: "workflow_action_outbox",
    sqlSha256: "e76864ed0326ff7a158f254855b70869524a18eb7fc5ee582a813972e86783b2",
  },
  {
    type: "table",
    name: "workflow_adapter_event_suppressions",
    tableName: "workflow_adapter_event_suppressions",
    sqlSha256: "124cd363814e44cf1ff4fafab27bb4bfb50eb740219fcbd04c1bed6a16e17915",
  },
  {
    type: "table",
    name: "workflow_adapter_stream_watermarks",
    tableName: "workflow_adapter_stream_watermarks",
    sqlSha256: "a475f7171ef83d34339844230038038b584194dff2c3cc47c4b678bf14d98af6",
  },
  {
    type: "table",
    name: "workflow_completion_deliveries",
    tableName: "workflow_completion_deliveries",
    sqlSha256: "5143922bcdc82b12517a706220e95824c6fff4813ee6e14f301fdbc228d5f8bb",
  },
  {
    type: "table",
    name: "workflow_invocation_receipts",
    tableName: "workflow_invocation_receipts",
    sqlSha256: "0d18593355e7c5f696fbcb2fd5b52e6fabecdd09db8a83f1798c5eaf6b5edbab",
  },
  {
    type: "table",
    name: "workflow_legacy_audit_records",
    tableName: "workflow_legacy_audit_records",
    sqlSha256: "28417765e169278223dff8a02d797bca9987786620c8973d218419ff4a0d6e7a",
  },
  {
    type: "table",
    name: "workflow_operations",
    tableName: "workflow_operations",
    sqlSha256: "2eda98155b01cc76b3e67682ffbc06e3c772e870105f25a52ee1d31886a832d0",
  },
  {
    type: "table",
    name: "workflow_quarantine",
    tableName: "workflow_quarantine",
    sqlSha256: "2d58c4cf64d0dfcb949079d1deaf877ee9813b7178c53d2390780bf3b59f964c",
  },
  {
    type: "table",
    name: "workflow_request_dispatches",
    tableName: "workflow_request_dispatches",
    sqlSha256: "7c8db7a46f6f32677d5bc99cf8ecc0ab4e2bb33cc423bfa952d933182cc95a11",
  },
  {
    type: "table",
    name: "workflow_request_terminal_receipt_quarantine",
    tableName: "workflow_request_terminal_receipt_quarantine",
    sqlSha256: "fc452afe03b019463ad9e67fc81bc4196b73d7ae08b4e5a1bbd22cebf9e80f55",
  },
  {
    type: "table",
    name: "workflow_request_terminal_receipts",
    tableName: "workflow_request_terminal_receipts",
    sqlSha256: "d1e498f3e2d9011a6f5cd5ebb9ae1034213539e1d3267b7442db410eab48ec7b",
  },
  {
    type: "table",
    name: "workflow_revisions",
    tableName: "workflow_revisions",
    sqlSha256: "3ba9c4258efa51d54f8a2075cb2e13e6c0b9496fc639c5e6a051bfc34da3c27a",
  },
  {
    type: "table",
    name: "workflow_runs",
    tableName: "workflow_runs",
    sqlSha256: "06923b57aada8b6a2ee7ed15c51f1761d49c2ac4638926560afb7ce9be9a4f87",
  },
  {
    type: "table",
    name: "workflow_schema_migrations",
    tableName: "workflow_schema_migrations",
    sqlSha256: "be67dcf6384ec461c2d47f430132e72d31b77a0d3b62516d07f1d4d6f93f2279",
  },
  {
    type: "table",
    name: "workflow_surface_actions",
    tableName: "workflow_surface_actions",
    sqlSha256: "105e77acdef6ec1fa1cac7c6992a9b0bf561a65e6a8bb7585099f1d214019ea2",
  },
  {
    type: "table",
    name: "workflow_surface_bindings",
    tableName: "workflow_surface_bindings",
    sqlSha256: "ff5d8e10fb74c4fbc104c8cf9f28c915a615186cdf98fa7c01e9b521354350f3",
  },
  {
    type: "table",
    name: "workflow_trigger_invocation_receipts",
    tableName: "workflow_trigger_invocation_receipts",
    sqlSha256: "6b0e61f48bc771c29a13073dac267a00beade6c4ccd24292c7df456508e1b8ed",
  },
  {
    type: "table",
    name: "workflow_trigger_runs",
    tableName: "workflow_trigger_runs",
    sqlSha256: "eae6ffb5bfa357b328d638ed6dfd3568f3133e2ce3202c634cb99e2b6a54b780",
  },
  {
    type: "table",
    name: "workflow_triggers",
    tableName: "workflow_triggers",
    sqlSha256: "a0da3758c4e541f5f5d52a3bac809ce31463cd1c2e86c6b099d407358953559a",
  },
  {
    type: "table",
    name: "workflow_wait_resolver_checkpoints",
    tableName: "workflow_wait_resolver_checkpoints",
    sqlSha256: "812d2978f48b6214a6d98a142f26e669661f65e5475db07a80f797a14181f660",
  },
  {
    type: "table",
    name: "workflow_wait_resolver_lease",
    tableName: "workflow_wait_resolver_lease",
    sqlSha256: "45ec7d56033c3627cd37b7202628ed9bc74ce5fba907a5a5457eccfba22460aa",
  },
  {
    type: "table",
    name: "workflow_waits",
    tableName: "workflow_waits",
    sqlSha256: "4649cc2221efd0036522be1b3d2d886ea8edbb666721a41fe768ac2fe394131e",
  },
  {
    type: "trigger",
    name: "workflow_completion_delivery_after_run_insert",
    tableName: "workflow_runs",
    sqlSha256: "e84e8c03737eb071380285904665f09effee4bde8394d432dac39a65cbc88ff0",
  },
] as const satisfies readonly {
  readonly type: LegacyWorkflowSchemaObjectType;
  readonly name: string;
  readonly tableName: string;
  readonly sqlSha256: string;
}[];

type WorkflowArtifactSurface = "revision" | "run" | "operation" | "receipt";
type WorkflowArtifactKind = "source" | "value";

type LegacyWorkflowArtifactRow = {
  readonly surface: WorkflowArtifactSurface;
  readonly artifact_id: string;
  readonly source_sha256: string | null;
  readonly limits_json: string | null;
  readonly created_at: number;
};

type LegacyWorkflowArtifact = {
  readonly artifactId: string;
  readonly kind: WorkflowArtifactKind;
  readonly filePath: string;
  readonly expectedSha256: string;
  readonly byteLength: number;
  readonly maxBytes: number;
  readonly createdAt: number;
};

type InspectedLegacyDirectory = {
  readonly configuredPath: string;
  readonly canonicalPath: string;
  readonly entries: readonly string[];
};

type LegacyWorkflowInspection = {
  readonly report: LegacyWorkflowBlobMigrationPreflight;
  readonly artifacts: readonly LegacyWorkflowArtifact[];
  readonly directories: readonly InspectedLegacyDirectory[];
};

export type StagedLegacyWorkflowBlobMigration = {
  readonly report: LegacyWorkflowBlobMigrationPreflight;
  readonly artifacts: readonly StagedWorkflowArtifact[];
  readonly directories: readonly InspectedLegacyDirectory[];
};

export type LegacyWorkflowBlobMigrationPreflight = {
  readonly schemaVersion: 25;
  readonly revisionSnapshotReferences: number;
  readonly runResultReferences: number;
  readonly operationResultReferences: number;
  readonly terminalReceiptResultReferences: number;
  readonly distinctSourceArtifacts: number;
  readonly distinctValueArtifacts: number;
  readonly distinctArtifacts: number;
  readonly durableBytes: number;
  readonly discardedLegacyEntries: number;
};

export type LegacyWorkflowBlobMigrationSummary = LegacyWorkflowBlobMigrationPreflight & {
  readonly migratedSchemaVersion: 26;
  readonly uploadedArtifacts: number;
  readonly removedLegacyDirectories: number;
};

export type LegacyWorkflowBlobMigrationFailureSource =
  | "database"
  | "schema"
  | WorkflowArtifactSurface
  | "source-artifact"
  | "value-artifact"
  | "blob-store"
  | "cleanup";

export class LegacyWorkflowBlobMigrationFailed extends TaggedError(
  "LegacyWorkflowBlobMigrationFailed",
)<{
  readonly source: LegacyWorkflowBlobMigrationFailureSource;
  readonly code: string;
  readonly artifactId?: string;
  readonly message: string;
}> {}

export type LegacyWorkflowBlobMigrationError = LegacyWorkflowBlobMigrationFailed;

type CapturedFailure =
  | { readonly kind: "panic"; readonly panic: Panic }
  | {
      readonly kind: "migration";
      readonly error: LegacyWorkflowBlobMigrationFailed;
    }
  | { readonly kind: "external"; readonly code: string };
type CapturedFailureSettlement = () => CapturedFailure;

type ResultOutcome<T, E> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "err"; readonly error: E };

function failure(input: {
  source: LegacyWorkflowBlobMigrationFailureSource;
  code: string;
  artifactId?: string;
  message: string;
}): LegacyWorkflowBlobMigrationFailed {
  return new LegacyWorkflowBlobMigrationFailed({
    source: input.source,
    code: input.code.slice(0, 80),
    ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId.slice(0, 256) }),
    message: input.message,
  });
}

function resultOutcome<T, E>(result: ResultType<T, E>): ResultOutcome<T, E> {
  return result.match({
    ok: (value): ResultOutcome<T, E> => ({ kind: "ok", value }),
    err: (error): ResultOutcome<T, E> => ({ kind: "err", error }),
  });
}

function capturedFailure(cause: unknown): CapturedFailureSettlement {
  return () => {
    if (Panic.is(cause)) return { kind: "panic", panic: cause };
    if (cause instanceof LegacyWorkflowBlobMigrationFailed) {
      return { kind: "migration", error: cause };
    }
    const sqlite = cause instanceof Error ? classifyBunSqliteError(cause) : undefined;
    return {
      kind: "external",
      code: sqlite?.code ?? errorCode(cause) ?? "UNKNOWN",
    };
  };
}

function migrationFailureFromCaptured(input: {
  source: LegacyWorkflowBlobMigrationFailureSource;
  operation: string;
  captured: CapturedFailure;
}): LegacyWorkflowBlobMigrationFailed {
  if (input.captured.kind === "panic") preserveToolPanic(input.captured.panic);
  if (input.captured.kind === "migration") return input.captured.error;
  return failure({
    source: input.source,
    code: input.captured.code,
    message: `Legacy workflow blob migration failed during ${input.operation}`,
  });
}

function inspectLegacyDatabase(
  dbPath: string,
): ResultType<readonly LegacyWorkflowArtifactRow[], LegacyWorkflowBlobMigrationFailed> {
  const opened = Result.try<Database, CapturedFailureSettlement>({
    try: () => new Database(dbPath, { readonly: true, strict: true }),
    catch: capturedFailure,
  }).mapError((settle) => settle());
  const openedOutcome = resultOutcome(opened);
  if (openedOutcome.kind === "err") {
    return Result.err(
      migrationFailureFromCaptured({
        source: "database",
        operation: "open-read-only",
        captured: openedOutcome.error,
      }),
    );
  }
  const db = openedOutcome.value;
  const inspected = Result.try<readonly LegacyWorkflowArtifactRow[], CapturedFailureSettlement>({
    try: () => {
      const ledger = db
        .query<{ version: number; name: string }, []>(
          "SELECT version, name FROM workflow_schema_migrations ORDER BY version",
        )
        .all();
      if (ledger.length !== LEGACY_WORKFLOW_SCHEMA_VERSION) {
        throw failure({
          source: "schema",
          code: "unsupported-version",
          message: "Workflow blob migration requires exact schema 25",
        });
      }
      for (const [index, expectedName] of LEGACY_WORKFLOW_MIGRATION_LEDGER.entries()) {
        const row = ledger[index];
        if (row?.version !== index + 1 || row.name !== expectedName) {
          throw failure({
            source: "schema",
            code: "migration-ledger-mismatch",
            message: "Workflow schema 25 migration ledger does not match the supported contract",
          });
        }
      }
      const schema26ObjectNames = [
        "workflow_artifacts",
        "workflow_revision_artifact_reference_insert",
        "workflow_revision_artifact_reference_update",
        "workflow_run_artifact_reference_insert",
        "workflow_run_artifact_reference_update",
        "workflow_operation_artifact_reference_insert",
        "workflow_operation_artifact_reference_update",
        "workflow_receipt_artifact_reference_insert",
        "workflow_receipt_artifact_reference_update",
      ] as const;
      const existingSchema26Object = db
        .query<
          { name: string },
          [string, string, string, string, string, string, string, string, string]
        >(
          `SELECT name FROM sqlite_master
           WHERE name IN (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ORDER BY name LIMIT 1`,
        )
        .get(...schema26ObjectNames);
      if (existingSchema26Object !== null) {
        throw failure({
          source: "schema",
          code: "partial-schema-26",
          message: "Workflow schema 25 contains a schema-26 database object",
        });
      }
      const schemaObjects = db
        .query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
          `SELECT type, name, tbl_name, sql
           FROM sqlite_schema
           WHERE name NOT LIKE 'sqlite_%'
             AND type IN ('index', 'table', 'trigger', 'view')
           ORDER BY type, name`,
        )
        .all();
      if (schemaObjects.length !== LEGACY_WORKFLOW_SCHEMA_25_OBJECT_CATALOG.length) {
        throw failure({
          source: "schema",
          code: "schema-25-catalog-mismatch",
          message: "Workflow schema 25 object catalog does not match the supported contract",
        });
      }
      for (const [index, expected] of LEGACY_WORKFLOW_SCHEMA_25_OBJECT_CATALOG.entries()) {
        const actual = schemaObjects[index];
        if (
          actual?.type !== expected.type ||
          actual.name !== expected.name ||
          actual.tbl_name !== expected.tableName ||
          actual.sql === null ||
          sha256(actual.sql.replace(/\s+/g, " ").trim()) !== expected.sqlSha256
        ) {
          throw failure({
            source: "schema",
            code: "schema-25-catalog-mismatch",
            message: "Workflow schema 25 object catalog does not match the supported contract",
          });
        }
      }
      const foreignKeyFailure = db
        .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
        .get();
      if (foreignKeyFailure !== null) {
        throw failure({
          source: "schema",
          code: "foreign-key-check",
          message: "Workflow schema 25 contains a foreign-key violation",
        });
      }
      return db
        .query<LegacyWorkflowArtifactRow, []>(
          `SELECT 'revision' AS surface, snapshot_artifact_id AS artifact_id,
             source_sha256, limits_json, created_at
           FROM workflow_revisions
           UNION ALL
           SELECT 'run', run.result_artifact_id, NULL, revision.limits_json, run.created_at
           FROM workflow_runs run
           LEFT JOIN workflow_revisions revision ON revision.revision_id = run.revision_id
           WHERE run.result_artifact_id IS NOT NULL
           UNION ALL
           SELECT 'operation', operation.result_artifact_id, NULL,
             revision.limits_json, operation.created_at
           FROM workflow_operations operation
           LEFT JOIN workflow_runs run ON run.run_id = operation.run_id
           LEFT JOIN workflow_revisions revision ON revision.revision_id = run.revision_id
           WHERE operation.result_artifact_id IS NOT NULL
           UNION ALL
           SELECT 'receipt', receipt.result_artifact_id, NULL,
             revision.limits_json, receipt.created_at
           FROM workflow_request_terminal_receipts receipt
           LEFT JOIN workflow_runs run ON run.run_id = receipt.run_id
           LEFT JOIN workflow_revisions revision ON revision.revision_id = run.revision_id
           WHERE receipt.result_artifact_id IS NOT NULL`,
        )
        .all();
    },
    catch: capturedFailure,
  }).mapError((settle) => settle());
  const closed = Result.try<void, CapturedFailureSettlement>({
    try: () => db.close(),
    catch: capturedFailure,
  }).mapError((settle) => settle());
  const inspectedOutcome = resultOutcome(inspected);
  const closedOutcome = resultOutcome(closed);
  if (inspectedOutcome.kind === "err") {
    if (inspectedOutcome.error.kind === "panic") {
      preserveToolPanic(inspectedOutcome.error.panic);
    }
    if (closedOutcome.kind === "err") {
      if (closedOutcome.error.kind === "panic") preserveToolPanic(closedOutcome.error.panic);
      return Result.err(
        failure({
          source: "database",
          code: "inspect-and-close-failed",
          message: "Workflow schema inspection and database close both failed",
        }),
      );
    }
    return Result.err(
      migrationFailureFromCaptured({
        source: "database",
        operation: "inspect-schema-25",
        captured: inspectedOutcome.error,
      }),
    );
  }
  if (closedOutcome.kind === "err") {
    return Result.err(
      migrationFailureFromCaptured({
        source: "database",
        operation: "close-read-only",
        captured: closedOutcome.error,
      }),
    );
  }
  return Result.ok(inspectedOutcome.value);
}

function decodeLimits(
  row: LegacyWorkflowArtifactRow,
): ResultType<WorkflowLimits, LegacyWorkflowBlobMigrationFailed> {
  if (row.limits_json === null) {
    return Result.err(
      failure({
        source: row.surface,
        code: "missing-revision-limits",
        artifactId: row.artifact_id,
        message: "A workflow artifact owner has no retained revision limits",
      }),
    );
  }
  const parsed = Result.try<unknown, "malformed">({
    try: () => JSON.parse(row.limits_json!),
    catch: () => "malformed",
  });
  if (parsed.isErr()) {
    return Result.err(
      failure({
        source: row.surface,
        code: "malformed-limits",
        artifactId: row.artifact_id,
        message: "A workflow artifact owner has malformed revision limits",
      }),
    );
  }
  const decoded = workflowLimitsSchema.safeParse(parsed.value);
  if (!decoded.success) {
    return Result.err(
      failure({
        source: row.surface,
        code: "invalid-limits",
        artifactId: row.artifact_id,
        message: "A workflow artifact owner has invalid revision limits",
      }),
    );
  }
  return Result.ok(decoded.data);
}

async function inspectLegacyDirectory(input: {
  dataDir: string;
  name: "workflow-snapshots" | "workflow-artifacts";
}): Promise<ResultType<InspectedLegacyDirectory | null, LegacyWorkflowBlobMigrationFailed>> {
  const configuredPath = path.resolve(input.dataDir, input.name);
  const inspected = await Result.tryPromise<
    InspectedLegacyDirectory | null,
    CapturedFailureSettlement
  >({
    try: async () => {
      const stats = await fs.lstat(configuredPath);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw failure({
          source: input.name === "workflow-snapshots" ? "source-artifact" : "value-artifact",
          code: stats.isSymbolicLink() ? "unsafe-symlink" : "not-directory",
          message: "Legacy workflow artifact root is unsafe",
        });
      }
      return {
        configuredPath,
        canonicalPath: await fs.realpath(configuredPath),
        entries: await fs.readdir(configuredPath),
      };
    },
    catch: capturedFailure,
  });
  const inspectedOutcome = resultOutcome(inspected.mapError((settle) => settle()));
  if (inspectedOutcome.kind === "err") {
    if (inspectedOutcome.error.kind === "external" && inspectedOutcome.error.code === "ENOENT") {
      return Result.ok(null);
    }
    return Result.err(
      migrationFailureFromCaptured({
        source: input.name === "workflow-snapshots" ? "source-artifact" : "value-artifact",
        operation: "inspect-legacy-root",
        captured: inspectedOutcome.error,
      }),
    );
  }
  return Result.ok(inspectedOutcome.value);
}

async function readLegacyArtifact(input: {
  artifactId: string;
  kind: WorkflowArtifactKind;
  root: InspectedLegacyDirectory | null;
  maxFileBytes: number;
}): Promise<ResultType<Uint8Array, LegacyWorkflowBlobMigrationFailed>> {
  const source = input.kind === "source" ? "source-artifact" : "value-artifact";
  if (input.root === null) {
    return Result.err(
      failure({
        source,
        code: "missing-root",
        artifactId: input.artifactId,
        message: "A referenced legacy workflow artifact root is absent",
      }),
    );
  }
  const root = input.root;
  const hash = input.artifactId.slice(input.artifactId.indexOf(":") + 1);
  const filePath = path.join(
    root.canonicalPath,
    `${hash}.${input.kind === "source" ? "js" : "json"}`,
  );
  const read = await Result.tryPromise<Uint8Array, CapturedFailureSettlement>({
    try: async () => {
      const stats = await fs.lstat(filePath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw failure({
          source,
          code: stats.isSymbolicLink() ? "unsafe-symlink" : "not-file",
          artifactId: input.artifactId,
          message: "A referenced legacy workflow artifact is unsafe",
        });
      }
      if (stats.size > input.maxFileBytes) {
        throw failure({
          source,
          code: "file-too-large",
          artifactId: input.artifactId,
          message: "A referenced legacy workflow artifact exceeds its owner limit",
        });
      }
      const canonicalPath = await fs.realpath(filePath);
      if (path.dirname(canonicalPath) !== root.canonicalPath) {
        throw failure({
          source,
          code: "escaped-root",
          artifactId: input.artifactId,
          message: "A referenced legacy workflow artifact escapes its root",
        });
      }
      const bytes = await fs.readFile(canonicalPath);
      if (bytes.byteLength > input.maxFileBytes) {
        throw failure({
          source,
          code: "file-too-large",
          artifactId: input.artifactId,
          message: "A referenced legacy workflow artifact exceeds its owner limit",
        });
      }
      return bytes;
    },
    catch: capturedFailure,
  });
  const readOutcome = resultOutcome(read.mapError((settle) => settle()));
  if (readOutcome.kind === "err") {
    return Result.err(
      migrationFailureFromCaptured({
        source,
        operation: "read-legacy-artifact",
        captured: readOutcome.error,
      }),
    );
  }
  return Result.ok(readOutcome.value);
}

function safeAddBytes(
  current: number,
  addition: number,
  artifactId: string,
): ResultType<number, LegacyWorkflowBlobMigrationFailed> {
  const total = current + addition;
  if (Number.isSafeInteger(total)) return Result.ok(total);
  return Result.err(
    failure({
      source: "schema",
      code: "byte-total-overflow",
      artifactId,
      message: "Workflow artifact byte total exceeds the safe integer range",
    }),
  );
}

function isWorkflowArtifactId(value: string): boolean {
  return workflowArtifactIdSchema.safeParse(value).success;
}

export async function inspectLegacyWorkflowBlobMigration(input: {
  dbPath: string;
  dataDir: string;
}): Promise<ResultType<LegacyWorkflowInspection, LegacyWorkflowBlobMigrationFailed>> {
  return Result.gen(async function* () {
    const rows = yield* inspectLegacyDatabase(input.dbPath);
    const sourceRoot = yield* Result.await(
      inspectLegacyDirectory({
        dataDir: input.dataDir,
        name: "workflow-snapshots",
      }),
    );
    const valueRoot = yield* Result.await(
      inspectLegacyDirectory({
        dataDir: input.dataDir,
        name: "workflow-artifacts",
      }),
    );

    const references: Record<WorkflowArtifactSurface, number> = {
      revision: 0,
      run: 0,
      operation: 0,
      receipt: 0,
    };
    const drafts = new Map<
      string,
      {
        kind: WorkflowArtifactKind;
        maxBytes: number;
        createdAt: number;
        sourceSha256: string | null;
      }
    >();
    for (const row of rows) {
      references[row.surface] += 1;
      if (!isWorkflowArtifactId(row.artifact_id)) {
        return Result.err(
          failure({
            source: row.surface,
            code: "invalid-artifact-id",
            artifactId: row.artifact_id,
            message: "A workflow artifact owner has an invalid artifact identity",
          }),
        );
      }
      if (!Number.isSafeInteger(row.created_at) || row.created_at < 0) {
        return Result.err(
          failure({
            source: row.surface,
            code: "invalid-created-at",
            artifactId: row.artifact_id,
            message: "A workflow artifact owner has an invalid creation timestamp",
          }),
        );
      }
      const limits = yield* decodeLimits(row);
      const kind: WorkflowArtifactKind = row.surface === "revision" ? "source" : "value";
      const expectedPrefix = kind === "source" ? SOURCE_ARTIFACT_PREFIX : VALUE_ARTIFACT_PREFIX;
      if (!row.artifact_id.startsWith(expectedPrefix)) {
        return Result.err(
          failure({
            source: row.surface,
            code: "artifact-kind-mismatch",
            artifactId: row.artifact_id,
            message: "A workflow artifact identity does not match its owner",
          }),
        );
      }
      if (
        kind === "source" &&
        (row.source_sha256 === null ||
          row.artifact_id !== `${SOURCE_ARTIFACT_PREFIX}${row.source_sha256}`)
      ) {
        return Result.err(
          failure({
            source: row.surface,
            code: "source-identity-mismatch",
            artifactId: row.artifact_id,
            message: "A workflow snapshot identity does not match its revision source hash",
          }),
        );
      }
      let ownerLimit = limits.maxOperationOutputBytes;
      if (kind === "source") ownerLimit = limits.maxSourceBytes;
      else if (row.surface === "run") ownerLimit = limits.maxResultBytes;
      const existing = drafts.get(row.artifact_id);
      if (existing && existing.kind !== kind) {
        return Result.err(
          failure({
            source: row.surface,
            code: "artifact-kind-conflict",
            artifactId: row.artifact_id,
            message: "A workflow artifact identity is shared across incompatible kinds",
          }),
        );
      }
      drafts.set(row.artifact_id, {
        kind,
        maxBytes: Math.min(existing?.maxBytes ?? ownerLimit, ownerLimit),
        createdAt: Math.min(existing?.createdAt ?? row.created_at, row.created_at),
        sourceSha256: existing?.sourceSha256 ?? row.source_sha256,
      });
    }

    const artifacts: LegacyWorkflowArtifact[] = [];
    let durableBytes = 0;
    for (const [artifactId, draft] of drafts) {
      const maxFileBytes =
        draft.kind === "source"
          ? draft.maxBytes
          : workflowValueArtifactFileByteLimit(draft.maxBytes);
      const bytes = yield* Result.await(
        readLegacyArtifact({
          artifactId,
          kind: draft.kind,
          root: draft.kind === "source" ? sourceRoot : valueRoot,
          maxFileBytes,
        }),
      );
      if (draft.kind === "source") {
        if (sha256(bytes) !== draft.sourceSha256) {
          return Result.err(
            failure({
              source: "source-artifact",
              code: "hash-mismatch",
              artifactId,
              message: "A legacy workflow snapshot does not match its content identity",
            }),
          );
        }
      } else {
        const expectedHash = artifactId.slice(VALUE_ARTIFACT_PREFIX.length);
        const decoded = decodeWorkflowValueArtifact({
          encoded: Buffer.from(bytes).toString("utf8"),
          expectedHash,
          maxValueBytes: draft.maxBytes,
          artifactId,
        });
        const decodeError = decoded.match({
          ok: () => null,
          err: (error) => error,
        });
        if (decodeError) {
          return Result.err(
            failure({
              source: "value-artifact",
              code: decodeError._tag,
              artifactId,
              message: "A legacy workflow value artifact is not readable under its owner contract",
            }),
          );
        }
      }
      durableBytes = yield* safeAddBytes(durableBytes, bytes.byteLength, artifactId);
      const hash = artifactId.slice(artifactId.indexOf(":") + 1);
      const root = draft.kind === "source" ? sourceRoot : valueRoot;
      if (root === null) {
        return Result.err(
          failure({
            source: draft.kind === "source" ? "source-artifact" : "value-artifact",
            code: "missing-root",
            artifactId,
            message: "A referenced legacy workflow artifact root is absent",
          }),
        );
      }
      artifacts.push({
        artifactId,
        kind: draft.kind,
        filePath: path.join(
          root.canonicalPath,
          `${hash}.${draft.kind === "source" ? "js" : "json"}`,
        ),
        expectedSha256: sha256(bytes),
        byteLength: bytes.byteLength,
        maxBytes: maxFileBytes,
        createdAt: draft.createdAt,
      });
    }

    const sourceFiles = new Set(
      artifacts
        .filter(({ kind }) => kind === "source")
        .map(({ artifactId }) => `${artifactId.slice(SOURCE_ARTIFACT_PREFIX.length)}.js`),
    );
    const valueFiles = new Set(
      artifacts
        .filter(({ kind }) => kind === "value")
        .map(({ artifactId }) => `${artifactId.slice(VALUE_ARTIFACT_PREFIX.length)}.json`),
    );
    const discardedLegacyEntries =
      (sourceRoot?.entries.filter((entry) => !sourceFiles.has(entry)).length ?? 0) +
      (valueRoot?.entries.filter((entry) => !valueFiles.has(entry)).length ?? 0);
    const inspectedDirectories = [sourceRoot, valueRoot].filter(
      (directory): directory is InspectedLegacyDirectory => directory !== null,
    );
    return Result.ok({
      report: {
        schemaVersion: LEGACY_WORKFLOW_SCHEMA_VERSION as 25,
        revisionSnapshotReferences: references.revision,
        runResultReferences: references.run,
        operationResultReferences: references.operation,
        terminalReceiptResultReferences: references.receipt,
        distinctSourceArtifacts: sourceFiles.size,
        distinctValueArtifacts: valueFiles.size,
        distinctArtifacts: artifacts.length,
        durableBytes,
        discardedLegacyEntries,
      },
      artifacts,
      directories: inspectedDirectories,
    });
  });
}

export async function preflightLegacyWorkflowBlobMigration(input: {
  readonly dbPath: string;
  readonly dataDir: string;
}): Promise<ResultType<LegacyWorkflowBlobMigrationPreflight, LegacyWorkflowBlobMigrationError>> {
  return (await inspectLegacyWorkflowBlobMigration(input)).map(({ report }) => report);
}

function blobErrorCode(error: Error): string {
  return error.name;
}

async function stageWorkflowArtifact(
  artifact: LegacyWorkflowArtifact,
  blobStore: BlobStore,
): Promise<ResultType<StagedWorkflowArtifact, LegacyWorkflowBlobMigrationFailed>> {
  return Result.gen(async function* () {
    const bytes = yield* Result.await(
      readLegacyArtifact({
        artifactId: artifact.artifactId,
        kind: artifact.kind,
        root: {
          configuredPath: path.dirname(artifact.filePath),
          canonicalPath: path.dirname(artifact.filePath),
          entries: [],
        },
        maxFileBytes: artifact.maxBytes,
      }),
    );
    if (bytes.byteLength !== artifact.byteLength || sha256(bytes) !== artifact.expectedSha256) {
      return Result.err(
        failure({
          source: artifact.kind === "source" ? "source-artifact" : "value-artifact",
          code: "changed-after-preflight",
          artifactId: artifact.artifactId,
          message: "A legacy workflow artifact changed after preflight",
        }),
      );
    }
    const upload = yield* Result.await(
      blobStore
        .startUpload({
          source: bytes,
          retention: { kind: "durable" },
          expectedSha256: artifact.expectedSha256,
          expectedByteLength: artifact.byteLength,
        })
        .then((result) =>
          result.mapError((error) =>
            failure({
              source: "blob-store",
              code: blobErrorCode(error),
              artifactId: artifact.artifactId,
              message: "Could not start a durable workflow artifact upload",
            }),
          ),
        ),
    );
    const blobRef = yield* Result.await(
      upload.completion.then((result) =>
        result.mapError((error) =>
          failure({
            source: "blob-store",
            code: blobErrorCode(error),
            artifactId: artifact.artifactId,
            message: "Could not upload a durable workflow artifact",
          }),
        ),
      ),
    );
    const read = yield* Result.await(
      blobStore.open(blobRef).then((result) =>
        result.mapError((error) =>
          failure({
            source: "blob-store",
            code: blobErrorCode(error),
            artifactId: artifact.artifactId,
            message: "Could not open a migrated workflow blob for verification",
          }),
        ),
      ),
    );
    const verifiedBytes = yield* Result.await(
      materializeBlobRead(read).then((result) =>
        result.mapError((error) =>
          failure({
            source: "blob-store",
            code: blobErrorCode(error),
            artifactId: artifact.artifactId,
            message: "A migrated workflow blob failed destination verification",
          }),
        ),
      ),
    );
    if (
      verifiedBytes.byteLength !== artifact.byteLength ||
      sha256(verifiedBytes) !== artifact.expectedSha256
    ) {
      return Result.err(
        failure({
          source: "blob-store",
          code: "destination-content-mismatch",
          artifactId: artifact.artifactId,
          message: "A migrated workflow blob does not match its legacy source",
        }),
      );
    }
    return Result.ok({
      reference: { artifactId: artifact.artifactId, blobRef },
      createdAt: artifact.createdAt,
    });
  });
}

function applySchema26(input: {
  dbPath: string;
  artifacts: readonly StagedWorkflowArtifact[];
  now?: () => number;
}): ResultType<void, LegacyWorkflowBlobMigrationFailed> {
  const opened = Result.try<Database, CapturedFailureSettlement>({
    try: () => new Database(input.dbPath, { strict: true }),
    catch: capturedFailure,
  }).mapError((settle) => settle());
  const openedOutcome = resultOutcome(opened);
  if (openedOutcome.kind === "err") {
    return Result.err(
      migrationFailureFromCaptured({
        source: "database",
        operation: "open-for-schema-26",
        captured: openedOutcome.error,
      }),
    );
  }
  const db = openedOutcome.value;
  const applied = Result.try<ResultType<void, WorkflowMigrationError>, CapturedFailureSettlement>({
    try: () => applyWorkflowBlobStorageSchema26Migration(db, input.artifacts, input.now),
    catch: capturedFailure,
  }).mapError((settle) => settle());
  const closed = Result.try<void, CapturedFailureSettlement>({
    try: () => db.close(),
    catch: capturedFailure,
  }).mapError((settle) => settle());
  const appliedOutcome = resultOutcome(applied);
  const closedOutcome = resultOutcome(closed);
  if (appliedOutcome.kind === "err") {
    if (appliedOutcome.error.kind === "panic") preserveToolPanic(appliedOutcome.error.panic);
    if (closedOutcome.kind === "err") {
      if (closedOutcome.error.kind === "panic") preserveToolPanic(closedOutcome.error.panic);
      return Result.err(
        failure({
          source: "database",
          code: "apply-and-close-failed",
          message: "Workflow schema application and database close both failed",
        }),
      );
    }
    return Result.err(
      migrationFailureFromCaptured({
        source: "database",
        operation: "apply-schema-26",
        captured: appliedOutcome.error,
      }),
    );
  }
  const migrationOutcome = resultOutcome(appliedOutcome.value);
  if (migrationOutcome.kind === "err") {
    return Result.err(
      failure({
        source: "schema",
        code: blobErrorCode(migrationOutcome.error),
        message: migrationOutcome.error.message,
      }),
    );
  }
  if (closedOutcome.kind === "err") {
    return Result.err(
      migrationFailureFromCaptured({
        source: "database",
        operation: "close-schema-26",
        captured: closedOutcome.error,
      }),
    );
  }
  return Result.ok(undefined);
}

async function removeLegacyDirectory(
  directory: InspectedLegacyDirectory,
): Promise<ResultType<void, LegacyWorkflowBlobMigrationFailed>> {
  const removed = await Result.tryPromise<void, CapturedFailureSettlement>({
    try: async () => {
      const stats = await fs.lstat(directory.configuredPath);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw failure({
          source: "cleanup",
          code: "legacy-root-changed",
          message: "A legacy workflow artifact root changed before cleanup",
        });
      }
      if ((await fs.realpath(directory.configuredPath)) !== directory.canonicalPath) {
        throw failure({
          source: "cleanup",
          code: "legacy-root-changed",
          message: "A legacy workflow artifact root changed before cleanup",
        });
      }
      await fs.rm(directory.configuredPath, { recursive: true });
    },
    catch: capturedFailure,
  });
  const removedOutcome = resultOutcome(removed.mapError((settle) => settle()));
  if (removedOutcome.kind === "err") {
    return Result.err(
      migrationFailureFromCaptured({
        source: "cleanup",
        operation: "remove-legacy-workflow-root",
        captured: removedOutcome.error,
      }),
    );
  }
  return Result.ok(undefined);
}

export async function stageLegacyWorkflowBlobMigration(input: {
  readonly dbPath: string;
  readonly dataDir: string;
  readonly blobStore: BlobStore;
}): Promise<ResultType<StagedLegacyWorkflowBlobMigration, LegacyWorkflowBlobMigrationError>> {
  return Result.gen(async function* () {
    const inspected = yield* Result.await(inspectLegacyWorkflowBlobMigration(input));
    const staged: StagedWorkflowArtifact[] = [];
    for (const artifact of inspected.artifacts) {
      const uploadedOutcome = resultOutcome(await stageWorkflowArtifact(artifact, input.blobStore));
      if (uploadedOutcome.kind === "err") {
        const cleanedOutcome = resultOutcome(
          await deleteStagedLegacyWorkflowUploads({
            staged: {
              report: inspected.report,
              artifacts: staged,
              directories: [],
            },
            blobStore: input.blobStore,
          }),
        );
        if (cleanedOutcome.kind === "err") {
          return Result.err(
            failure({
              source: "blob-store",
              code: "upload-and-cleanup-failed",
              artifactId: artifact.artifactId,
              message: "Workflow artifact upload and staged-object cleanup both failed",
            }),
          );
        }
        return Result.err(uploadedOutcome.error);
      }
      staged.push(uploadedOutcome.value);
    }
    return Result.ok({
      report: inspected.report,
      artifacts: staged,
      directories: inspected.directories,
    });
  });
}

export async function deleteStagedLegacyWorkflowUploads(input: {
  readonly staged: StagedLegacyWorkflowBlobMigration;
  readonly blobStore: BlobStore;
}): Promise<ResultType<void, LegacyWorkflowBlobMigrationError>> {
  for (const artifact of input.staged.artifacts) {
    const deleted = await Result.tryPromise({
      try: () => input.blobStore.delete(artifact.reference.blobRef),
      catch: capturedFailure,
    });
    const deletedOutcome = resultOutcome(deleted.mapError((settle) => settle()));
    if (deletedOutcome.kind === "err") {
      return Result.err(
        migrationFailureFromCaptured({
          source: "blob-store",
          operation: "delete-staged-workflow-object",
          captured: deletedOutcome.error,
        }),
      );
    }
    const deletionOutcome = resultOutcome(deletedOutcome.value);
    if (deletionOutcome.kind === "err") {
      return Result.err(
        failure({
          source: "blob-store",
          code: blobErrorCode(deletionOutcome.error),
          artifactId: artifact.reference.artifactId,
          message: "A staged workflow object could not be deleted after migration failure",
        }),
      );
    }
  }
  return Result.ok(undefined);
}

export async function discardStagedLegacyWorkflowBlobState(
  staged: StagedLegacyWorkflowBlobMigration,
): Promise<ResultType<number, LegacyWorkflowBlobMigrationError>> {
  return Result.gen(async function* () {
    let removedLegacyDirectories = 0;
    for (const directory of staged.directories) {
      yield* Result.await(removeLegacyDirectory(directory));
      removedLegacyDirectories += 1;
    }
    return Result.ok(removedLegacyDirectories);
  });
}

export function commitStagedLegacyWorkflowBlobMigration(input: {
  readonly dbPath: string;
  readonly staged: StagedLegacyWorkflowBlobMigration;
  readonly removedLegacyDirectories: number;
  readonly now?: () => number;
}): ResultType<LegacyWorkflowBlobMigrationSummary, LegacyWorkflowBlobMigrationError> {
  return Result.gen(function* () {
    yield* applySchema26({
      dbPath: input.dbPath,
      artifacts: input.staged.artifacts,
      now: input.now,
    });
    return Result.ok({
      ...input.staged.report,
      migratedSchemaVersion: CURRENT_WORKFLOW_SCHEMA_VERSION as 26,
      uploadedArtifacts: input.staged.artifacts.length,
      removedLegacyDirectories: input.removedLegacyDirectories,
    });
  });
}

export async function applyLegacyWorkflowBlobMigration(input: {
  readonly dbPath: string;
  readonly dataDir: string;
  readonly blobStore: BlobStore;
  readonly now?: () => number;
}): Promise<ResultType<LegacyWorkflowBlobMigrationSummary, LegacyWorkflowBlobMigrationError>> {
  return Result.gen(async function* () {
    const staged = yield* Result.await(stageLegacyWorkflowBlobMigration(input));
    const removedLegacyDirectories = yield* Result.await(
      discardStagedLegacyWorkflowBlobState(staged),
    );
    return commitStagedLegacyWorkflowBlobMigration({
      dbPath: input.dbPath,
      staged,
      removedLegacyDirectories,
      now: input.now,
    });
  });
}
