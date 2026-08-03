import {
  CorruptPersistedFields,
  MalformedSerialization,
  UnsupportedVersion,
  type DecodedPersistedValue,
  type PersistedDataError,
  type PersistedDataIssueCode,
  type PersistenceProvenance,
} from "@stanley2058/lilac-utils";
import { Panic, Result, type Result as ResultType } from "better-result";
import { z } from "zod";

import {
  jsonValueSchema,
  workflowOperationSchema,
  workflowRevisionSchema,
  workflowRunSchema,
  workflowSurfaceActionSchema,
  workflowSurfaceBindingSchema,
  workflowTriggerSchema,
  workflowUsageSchema,
  workflowWaitSchema,
  type JsonValue,
  type WorkflowOperation,
  type WorkflowRevision,
  type WorkflowRun,
  type WorkflowSurfaceAction,
  type WorkflowSurfaceBinding,
  type WorkflowTrigger,
  type WorkflowWait,
} from "./workflow-domain";
import {
  workflowRequestPolicySchema,
  type WorkflowRequestPolicy,
} from "./workflow-request-authority";
import { WORKFLOW_SCHEMA_VERSION } from "./workflow-migrations";

const nullableStringSchema = z.string().nullable();
const nullableNumberSchema = z.number().nullable();

const revisionRowSchema = z.strictObject({
  revision_id: z.string(),
  canonical_project_id: z.string(),
  canonical_workspace_root: z.string(),
  scope: z.string(),
  normalized_path: z.string(),
  name: z.string(),
  snapshot_artifact_id: z.string(),
  source_sha256: z.string(),
  input_schema_sha256: z.string(),
  capability_sha256: z.string(),
  metadata_json: z.string(),
  input_schema_json: z.string(),
  capabilities_json: z.string(),
  limits_json: z.string(),
  runtime_version: z.string(),
  created_at: z.number(),
});

const runRowSchema = z.strictObject({
  run_id: z.string(),
  revision_id: z.string(),
  state: z.string(),
  input_schema_json: z.string(),
  args_json: z.string(),
  args_sha256: z.string(),
  origin_request_id: nullableStringSchema,
  origin_session_id: nullableStringSchema,
  origin_client: nullableStringSchema,
  origin_user_id: nullableStringSchema,
  origin_project_cwd: z.string(),
  completion_target_json: z.string(),
  progress_target_json: nullableStringSchema,
  terminal_detail: nullableStringSchema,
  result_json: nullableStringSchema,
  result_artifact_id: nullableStringSchema,
  claimed_by: nullableStringSchema,
  claimed_at: nullableNumberSchema,
  created_at: z.number(),
  started_at: nullableNumberSchema,
  updated_at: z.number(),
  terminal_at: nullableNumberSchema,
});

const operationRowSchema = z.strictObject({
  run_id: z.string(),
  operation_id: z.string(),
  call_site_id: z.string(),
  parent_operation_id: nullableStringSchema,
  phase: nullableStringSchema,
  label: nullableStringSchema,
  kind: z.string(),
  input_json: z.string(),
  input_sha256: z.string(),
  state: z.string(),
  attempt: z.number(),
  request_id: nullableStringSchema,
  output_json: nullableStringSchema,
  result_artifact_id: nullableStringSchema,
  error: nullableStringSchema,
  usage_json: nullableStringSchema,
  claimed_by: nullableStringSchema,
  claimed_at: nullableNumberSchema,
  created_at: z.number(),
  started_at: nullableNumberSchema,
  updated_at: z.number(),
  terminal_at: nullableNumberSchema,
});

const waitRowSchema = z.strictObject({
  run_id: z.string(),
  operation_id: z.string(),
  state: z.string(),
  match_kind: z.string(),
  match_json: z.string(),
  match_key: z.string(),
  due_at: nullableNumberSchema,
  deadline_at: nullableNumberSchema,
  resolver_cursor: nullableStringSchema,
  result_json: nullableStringSchema,
  resolved_by: nullableStringSchema,
  claimed_by: nullableStringSchema,
  claimed_at: nullableNumberSchema,
  created_at: z.number(),
  updated_at: z.number(),
  resolved_at: nullableNumberSchema,
  expiry_cutoff_cursor: nullableStringSchema,
  expiry_barrier_id: nullableStringSchema,
  expiry_barrier_cursor: nullableStringSchema,
  expiry_barrier_requested_at: nullableNumberSchema,
  expiry_barrier_processed_at: nullableNumberSchema,
});

const triggerRowSchema = z.strictObject({
  trigger_id: z.string(),
  revision_id: z.string(),
  state: z.string(),
  kind: z.string(),
  definition_json: z.string(),
  args_json: z.string(),
  args_sha256: z.string(),
  scheduling_policy_json: z.string(),
  origin_json: z.string(),
  completion_target_json: z.string(),
  progress_target_json: nullableStringSchema,
  next_fire_at: nullableNumberSchema,
  last_fire_at: nullableNumberSchema,
  last_run_id: nullableStringSchema,
  claimed_by: nullableStringSchema,
  claimed_at: nullableNumberSchema,
  created_at: z.number(),
  updated_at: z.number(),
});

const bindingRowSchema = z.strictObject({
  run_id: z.string(),
  target_json: z.string(),
  message_ref_json: nullableStringSchema,
  last_rendered_sha256: nullableStringSchema,
  last_error: nullableStringSchema,
  retry_count: z.number(),
  next_attempt_at: nullableNumberSchema,
  created_at: z.number(),
  updated_at: z.number(),
});

const actionRowSchema = z.strictObject({
  action_id: z.string(),
  token_sha256: z.string(),
  run_id: z.string(),
  kind: z.string(),
  expected_platform: z.string(),
  expected_user_id: z.string(),
  expected_message_ref_json: nullableStringSchema,
  expires_at: z.number(),
  consumed_at: nullableNumberSchema,
  consumed_by_platform: nullableStringSchema,
  consumed_by_user_id: nullableStringSchema,
  created_at: z.number(),
});

const requestDispatchRowSchema = z.strictObject({
  request_id: z.string(),
  run_id: z.string(),
  operation_id: z.string(),
  dispatch_epoch: z.string(),
  session_id: z.string(),
  platform: z.string(),
  policy_json: z.string(),
  owner_id: nullableStringSchema,
  owner_heartbeat_at: nullableNumberSchema,
  active: z.number().int(),
  created_at: z.number(),
  updated_at: z.number(),
  prompt_published_at: nullableNumberSchema,
});

const requestTerminalReceiptRowSchema = z.strictObject({
  request_id: z.string(),
  run_id: z.string(),
  operation_id: z.string(),
  dispatch_epoch: z.string(),
  state: z.enum(["resolved", "failed", "cancelled"]),
  detail: nullableStringSchema,
  output_json: nullableStringSchema,
  result_artifact_id: nullableStringSchema,
  usage_json: nullableStringSchema,
  created_at: z.number(),
});

const actionOutboxRowSchema = z.strictObject({
  outbox_id: z.string(),
  action_id: z.string(),
  run_id: z.string(),
  event_type: z.string(),
  payload_json: z.string(),
  published_at: nullableNumberSchema,
  projected_at: nullableNumberSchema,
  attempt_count: z.number().int().nonnegative(),
  next_attempt_at: nullableNumberSchema,
  last_error: nullableStringSchema,
  created_at: z.number(),
  updated_at: z.number(),
});

const legacyAuditRowSchema = z.strictObject({
  record_kind: z.string(),
  record_id: z.string(),
  reason: z.string(),
  payload_json: z.string(),
  archived_at: z.number(),
});

export type WorkflowPersistenceDiagnostic = {
  readonly table: string;
  readonly field: string;
  readonly version: number;
  readonly issueCode: PersistedDataIssueCode;
  readonly recordId: string;
};

export type WorkflowPersistedSqliteValue = string | number | bigint | Uint8Array | null;
export type WorkflowPersistedRow = Readonly<Record<string, WorkflowPersistedSqliteValue>>;

export type DecodedWorkflowRequestDispatch = {
  readonly requestId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly dispatchEpoch: string;
  readonly sessionId: string;
  readonly platform: string;
  readonly policy: WorkflowRequestPolicy;
  readonly ownerId: string | null;
  readonly ownerHeartbeatAt: number | null;
  readonly active: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly promptPublishedAt: number | null;
};

export type DecodedWorkflowRequestTerminalReceipt = {
  readonly requestId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly dispatchEpoch: string;
  readonly state: "resolved" | "failed" | "cancelled";
  readonly detail: string | null;
  readonly output: WorkflowOperation["output"];
  readonly resultArtifactId: string | null;
  readonly usage: WorkflowOperation["usage"];
  readonly createdAt: number;
};

export type DecodedWorkflowActionOutboxEntry = {
  readonly outboxId: string;
  readonly actionId: string;
  readonly runId: string;
  readonly eventType: string;
  readonly payload: JsonValue;
  readonly publishedAt: number | null;
  readonly projectedAt: number | null;
  readonly attemptCount: number;
  readonly nextAttemptAt: number | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type DecodedWorkflowLegacyAuditRecord = {
  readonly recordKind: string;
  readonly recordId: string;
  readonly reason: string;
  readonly payload: JsonValue;
  readonly archivedAt: number;
};

type DecodedWorkflowSchemaVersion = {
  readonly version: number;
  readonly provenance: Exclude<PersistenceProvenance, "missing-defaulted">;
};

function diagnostic(input: {
  readonly table: string;
  readonly field: string;
  readonly version: number;
  readonly issueCode: PersistedDataIssueCode;
  readonly recordId: string;
}): WorkflowPersistenceDiagnostic & { readonly message: string } {
  return { ...input, message: `Persisted workflow ${input.issueCode}` };
}

function corrupt(input: {
  readonly table: string;
  readonly field: string;
  readonly version: number;
  readonly issueCode: PersistedDataIssueCode;
  readonly recordId: string;
}): CorruptPersistedFields {
  return new CorruptPersistedFields(diagnostic(input));
}

function recordIdFromRow(row: WorkflowPersistedRow, field: string): string {
  const value = row[field];
  return typeof value === "string" ? value.slice(0, 256) : "unknown-record";
}

function decodeSchemaVersion(
  schemaVersion: number,
  table: string,
  recordId: string,
): ResultType<DecodedWorkflowSchemaVersion, UnsupportedVersion | CorruptPersistedFields> {
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    return Result.err(
      corrupt({
        table,
        field: "schema_version",
        version: schemaVersion,
        issueCode: "invalid-row-version",
        recordId,
      }),
    );
  }
  if (schemaVersion > WORKFLOW_SCHEMA_VERSION) {
    return Result.err(
      new UnsupportedVersion(
        diagnostic({
          table,
          field: "schema_version",
          version: schemaVersion,
          issueCode: "unsupported-version",
          recordId,
        }),
      ),
    );
  }
  return Result.ok({
    version: schemaVersion,
    provenance: schemaVersion === WORKFLOW_SCHEMA_VERSION ? "current" : "migrated",
  });
}

function decodeJson(input: {
  readonly raw: string;
  readonly table: string;
  readonly field: string;
  readonly version: number;
  readonly recordId: string;
}): ResultType<unknown, MalformedSerialization> {
  try {
    const value: unknown = JSON.parse(input.raw);
    return Result.ok(value);
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new MalformedSerialization(
        diagnostic({
          table: input.table,
          field: input.field,
          version: input.version,
          issueCode: "malformed-json",
          recordId: input.recordId,
        }),
      ),
    );
  }
}

function decodeJsonField<T>(input: {
  readonly raw: string;
  readonly schema: z.ZodType<T>;
  readonly table: string;
  readonly field: string;
  readonly version: number;
  readonly recordId: string;
}): ResultType<T, MalformedSerialization | CorruptPersistedFields> {
  const parsed = decodeJson(input);
  if (parsed.status === "error") return Result.err(parsed.error);
  const decoded = input.schema.safeParse(parsed.value);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    corrupt({
      table: input.table,
      field: input.field,
      version: input.version,
      issueCode: "invalid-row-field",
      recordId: input.recordId,
    }),
  );
}

function decodeNullableJsonField<T>(input: {
  readonly raw: string | null;
  readonly schema: z.ZodType<T>;
  readonly table: string;
  readonly field: string;
  readonly version: number;
  readonly recordId: string;
}): ResultType<T | null, MalformedSerialization | CorruptPersistedFields> {
  if (input.raw === null) return Result.ok(null);
  return decodeJsonField({ ...input, raw: input.raw });
}

function invalidRow(table: string, version: number, recordId: string): CorruptPersistedFields {
  return corrupt({
    table,
    field: "row",
    version,
    issueCode: "invalid-row-field",
    recordId,
  });
}

function provenance<T>(value: T, version: DecodedWorkflowSchemaVersion): DecodedPersistedValue<T> {
  return { value, provenance: version.provenance };
}

function decodeWorkflowRevisionRow(input: {
  readonly row: WorkflowPersistedRow;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<WorkflowRevision>, PersistedDataError> {
  const table = "workflow_revisions";
  const recordId = recordIdFromRow(input.row, "revision_id");
  const version = decodeSchemaVersion(input.schemaVersion, table, recordId);
  if (version.status === "error") return Result.err(version.error);
  const row = revisionRowSchema.safeParse(input.row);
  if (!row.success) return Result.err(invalidRow(table, version.value.version, recordId));
  const fields = [
    ["metadata_json", row.data.metadata_json],
    ["input_schema_json", row.data.input_schema_json],
    ["capabilities_json", row.data.capabilities_json],
    ["limits_json", row.data.limits_json],
  ] as const;
  const decoded: JsonValue[] = [];
  for (const [field, raw] of fields) {
    const value = decodeJsonField({
      raw,
      schema: jsonValueSchema,
      table,
      field,
      version: version.value.version,
      recordId,
    });
    if (value.status === "error") return Result.err(value.error);
    decoded.push(value.value);
  }
  const value = workflowRevisionSchema.safeParse({
    revisionId: row.data.revision_id,
    canonicalProjectId: row.data.canonical_project_id,
    canonicalWorkspaceRoot: row.data.canonical_workspace_root,
    scope: row.data.scope,
    normalizedPath: row.data.normalized_path,
    name: row.data.name,
    snapshotArtifactId: row.data.snapshot_artifact_id,
    sourceSha256: row.data.source_sha256,
    inputSchemaSha256: row.data.input_schema_sha256,
    resourcePolicySha256: row.data.capability_sha256,
    metadata: decoded[0],
    inputSchema: decoded[1],
    resources: decoded[2],
    limits: decoded[3],
    runtimeVersion: row.data.runtime_version,
    createdAt: row.data.created_at,
  });
  if (!value.success) return Result.err(invalidRow(table, version.value.version, recordId));
  return Result.ok(provenance(value.data, version.value));
}

function decodeWorkflowRunRow(input: {
  readonly row: WorkflowPersistedRow;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<WorkflowRun>, PersistedDataError> {
  const table = "workflow_runs";
  const recordId = recordIdFromRow(input.row, "run_id");
  const version = decodeSchemaVersion(input.schemaVersion, table, recordId);
  if (version.status === "error") return Result.err(version.error);
  const row = runRowSchema.safeParse(input.row);
  if (!row.success) return Result.err(invalidRow(table, version.value.version, recordId));
  const required = [
    ["input_schema_json", row.data.input_schema_json],
    ["args_json", row.data.args_json],
    ["completion_target_json", row.data.completion_target_json],
  ] as const;
  const decoded: JsonValue[] = [];
  for (const [field, raw] of required) {
    const value = decodeJsonField({
      raw,
      schema: jsonValueSchema,
      table,
      field,
      version: version.value.version,
      recordId,
    });
    if (value.status === "error") return Result.err(value.error);
    decoded.push(value.value);
  }
  const progressTarget = decodeNullableJsonField({
    raw: row.data.progress_target_json,
    schema: jsonValueSchema,
    table,
    field: "progress_target_json",
    version: version.value.version,
    recordId,
  });
  if (progressTarget.status === "error") return Result.err(progressTarget.error);
  const result = decodeNullableJsonField({
    raw: row.data.result_json,
    schema: jsonValueSchema,
    table,
    field: "result_json",
    version: version.value.version,
    recordId,
  });
  if (result.status === "error") return Result.err(result.error);
  const value = workflowRunSchema.safeParse({
    runId: row.data.run_id,
    revisionId: row.data.revision_id,
    state: row.data.state,
    inputSchemaSnapshot: decoded[0],
    args: decoded[1],
    argsSha256: row.data.args_sha256,
    origin: {
      requestId: row.data.origin_request_id,
      sessionId: row.data.origin_session_id,
      client: row.data.origin_client,
      userId: row.data.origin_user_id,
      projectCwd: row.data.origin_project_cwd,
    },
    completionTarget: decoded[2],
    progressTarget: progressTarget.value,
    terminalDetail: row.data.terminal_detail,
    result: result.value,
    resultArtifactId: row.data.result_artifact_id,
    claimedBy: row.data.claimed_by,
    claimedAt: row.data.claimed_at,
    createdAt: row.data.created_at,
    startedAt: row.data.started_at,
    updatedAt: row.data.updated_at,
    terminalAt: row.data.terminal_at,
  });
  if (!value.success) return Result.err(invalidRow(table, version.value.version, recordId));
  return Result.ok(provenance(value.data, version.value));
}

function decodeWorkflowOperationRow(input: {
  readonly row: WorkflowPersistedRow;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<WorkflowOperation>, PersistedDataError> {
  const table = "workflow_operations";
  const rowId = recordIdFromRow(input.row, "operation_id");
  const runId = recordIdFromRow(input.row, "run_id");
  const recordId = runId === "unknown-record" ? rowId : `${runId}:${rowId}`.slice(0, 256);
  const version = decodeSchemaVersion(input.schemaVersion, table, recordId);
  if (version.status === "error") return Result.err(version.error);
  const row = operationRowSchema.safeParse(input.row);
  if (!row.success) return Result.err(invalidRow(table, version.value.version, recordId));
  const operationInput = decodeJsonField({
    raw: row.data.input_json,
    schema: jsonValueSchema,
    table,
    field: "input_json",
    version: version.value.version,
    recordId,
  });
  if (operationInput.status === "error") return Result.err(operationInput.error);
  const output = decodeNullableJsonField({
    raw: row.data.output_json,
    schema: jsonValueSchema,
    table,
    field: "output_json",
    version: version.value.version,
    recordId,
  });
  if (output.status === "error") return Result.err(output.error);
  const usage = decodeNullableJsonField({
    raw: row.data.usage_json,
    schema: workflowUsageSchema,
    table,
    field: "usage_json",
    version: version.value.version,
    recordId,
  });
  if (usage.status === "error") return Result.err(usage.error);
  const value = workflowOperationSchema.safeParse({
    runId: row.data.run_id,
    operationId: row.data.operation_id,
    callSiteId: row.data.call_site_id,
    parentOperationId: row.data.parent_operation_id,
    phase: row.data.phase,
    label: row.data.label,
    kind: row.data.kind,
    input: operationInput.value,
    inputSha256: row.data.input_sha256,
    state: row.data.state,
    attempt: row.data.attempt,
    requestId: row.data.request_id,
    output: output.value,
    resultArtifactId: row.data.result_artifact_id,
    error: row.data.error,
    usage: usage.value,
    claimedBy: row.data.claimed_by,
    claimedAt: row.data.claimed_at,
    createdAt: row.data.created_at,
    startedAt: row.data.started_at,
    updatedAt: row.data.updated_at,
    terminalAt: row.data.terminal_at,
  });
  if (!value.success) return Result.err(invalidRow(table, version.value.version, recordId));
  return Result.ok(provenance(value.data, version.value));
}

function decodeWorkflowWaitRow(input: {
  readonly row: WorkflowPersistedRow;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<WorkflowWait>, PersistedDataError> {
  const table = "workflow_waits";
  const recordId =
    `${recordIdFromRow(input.row, "run_id")}:${recordIdFromRow(input.row, "operation_id")}`.slice(
      0,
      256,
    );
  const version = decodeSchemaVersion(input.schemaVersion, table, recordId);
  if (version.status === "error") return Result.err(version.error);
  const row = waitRowSchema.safeParse(input.row);
  if (!row.success) return Result.err(invalidRow(table, version.value.version, recordId));
  const match = decodeJsonField({
    raw: row.data.match_json,
    schema: jsonValueSchema,
    table,
    field: "match_json",
    version: version.value.version,
    recordId,
  });
  if (match.status === "error") return Result.err(match.error);
  const result = decodeNullableJsonField({
    raw: row.data.result_json,
    schema: jsonValueSchema,
    table,
    field: "result_json",
    version: version.value.version,
    recordId,
  });
  if (result.status === "error") return Result.err(result.error);
  const value = workflowWaitSchema.safeParse({
    runId: row.data.run_id,
    operationId: row.data.operation_id,
    state: row.data.state,
    match: match.value,
    matchKey: row.data.match_key,
    dueAt: row.data.due_at,
    deadlineAt: row.data.deadline_at,
    resolverCursor: row.data.resolver_cursor,
    result: result.value,
    resolvedBy: row.data.resolved_by,
    claimedBy: row.data.claimed_by,
    claimedAt: row.data.claimed_at,
    createdAt: row.data.created_at,
    updatedAt: row.data.updated_at,
    resolvedAt: row.data.resolved_at,
  });
  if (!value.success) return Result.err(invalidRow(table, version.value.version, recordId));
  if (row.data.match_kind !== value.data.match.kind) {
    return Result.err(invalidRow(table, version.value.version, recordId));
  }
  return Result.ok(provenance(value.data, version.value));
}

function decodeWorkflowTriggerRow(input: {
  readonly row: WorkflowPersistedRow;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<WorkflowTrigger>, PersistedDataError> {
  const table = "workflow_triggers";
  const recordId = recordIdFromRow(input.row, "trigger_id");
  const version = decodeSchemaVersion(input.schemaVersion, table, recordId);
  if (version.status === "error") return Result.err(version.error);
  const row = triggerRowSchema.safeParse(input.row);
  if (!row.success) return Result.err(invalidRow(table, version.value.version, recordId));
  const required = [
    ["definition_json", row.data.definition_json],
    ["args_json", row.data.args_json],
    ["scheduling_policy_json", row.data.scheduling_policy_json],
    ["origin_json", row.data.origin_json],
    ["completion_target_json", row.data.completion_target_json],
  ] as const;
  const decoded: JsonValue[] = [];
  for (const [field, raw] of required) {
    const value = decodeJsonField({
      raw,
      schema: jsonValueSchema,
      table,
      field,
      version: version.value.version,
      recordId,
    });
    if (value.status === "error") return Result.err(value.error);
    decoded.push(value.value);
  }
  const progressTarget = decodeNullableJsonField({
    raw: row.data.progress_target_json,
    schema: jsonValueSchema,
    table,
    field: "progress_target_json",
    version: version.value.version,
    recordId,
  });
  if (progressTarget.status === "error") return Result.err(progressTarget.error);
  const value = workflowTriggerSchema.safeParse({
    triggerId: row.data.trigger_id,
    revisionId: row.data.revision_id,
    state: row.data.state,
    definition: decoded[0],
    args: decoded[1],
    argsSha256: row.data.args_sha256,
    schedulingPolicy: decoded[2],
    origin: decoded[3],
    completionTarget: decoded[4],
    progressTarget: progressTarget.value,
    nextFireAt: row.data.next_fire_at,
    lastFireAt: row.data.last_fire_at,
    lastRunId: row.data.last_run_id,
    claimedBy: row.data.claimed_by,
    claimedAt: row.data.claimed_at,
    createdAt: row.data.created_at,
    updatedAt: row.data.updated_at,
  });
  if (!value.success) return Result.err(invalidRow(table, version.value.version, recordId));
  if (row.data.kind !== value.data.definition.kind) {
    return Result.err(invalidRow(table, version.value.version, recordId));
  }
  return Result.ok(provenance(value.data, version.value));
}

function decodeWorkflowSurfaceBindingRow(input: {
  readonly row: WorkflowPersistedRow;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<WorkflowSurfaceBinding>, PersistedDataError> {
  const table = "workflow_surface_bindings";
  const recordId = recordIdFromRow(input.row, "run_id");
  const version = decodeSchemaVersion(input.schemaVersion, table, recordId);
  if (version.status === "error") return Result.err(version.error);
  const row = bindingRowSchema.safeParse(input.row);
  if (!row.success) return Result.err(invalidRow(table, version.value.version, recordId));
  const target = decodeJsonField({
    raw: row.data.target_json,
    schema: jsonValueSchema,
    table,
    field: "target_json",
    version: version.value.version,
    recordId,
  });
  if (target.status === "error") return Result.err(target.error);
  const messageRef = decodeNullableJsonField({
    raw: row.data.message_ref_json,
    schema: jsonValueSchema,
    table,
    field: "message_ref_json",
    version: version.value.version,
    recordId,
  });
  if (messageRef.status === "error") return Result.err(messageRef.error);
  const value = workflowSurfaceBindingSchema.safeParse({
    runId: row.data.run_id,
    target: target.value,
    messageRef: messageRef.value,
    lastRenderedSha256: row.data.last_rendered_sha256,
    lastError: row.data.last_error,
    retryCount: row.data.retry_count,
    nextAttemptAt: row.data.next_attempt_at,
    createdAt: row.data.created_at,
    updatedAt: row.data.updated_at,
  });
  if (!value.success) return Result.err(invalidRow(table, version.value.version, recordId));
  return Result.ok(provenance(value.data, version.value));
}

function decodeWorkflowSurfaceActionRow(input: {
  readonly row: WorkflowPersistedRow;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<WorkflowSurfaceAction>, PersistedDataError> {
  const table = "workflow_surface_actions";
  const recordId = recordIdFromRow(input.row, "action_id");
  const version = decodeSchemaVersion(input.schemaVersion, table, recordId);
  if (version.status === "error") return Result.err(version.error);
  const row = actionRowSchema.safeParse(input.row);
  if (!row.success) return Result.err(invalidRow(table, version.value.version, recordId));
  const messageRef = decodeNullableJsonField({
    raw: row.data.expected_message_ref_json,
    schema: jsonValueSchema,
    table,
    field: "expected_message_ref_json",
    version: version.value.version,
    recordId,
  });
  if (messageRef.status === "error") return Result.err(messageRef.error);
  const value = workflowSurfaceActionSchema.safeParse({
    actionId: row.data.action_id,
    tokenSha256: row.data.token_sha256,
    runId: row.data.run_id,
    kind: row.data.kind,
    expectedPlatform: row.data.expected_platform,
    expectedUserId: row.data.expected_user_id,
    expectedMessageRef: messageRef.value,
    expiresAt: row.data.expires_at,
    consumedAt: row.data.consumed_at,
    consumedByPlatform: row.data.consumed_by_platform,
    consumedByUserId: row.data.consumed_by_user_id,
    createdAt: row.data.created_at,
  });
  if (!value.success) return Result.err(invalidRow(table, version.value.version, recordId));
  return Result.ok({
    value: value.data,
    provenance:
      row.data.expected_message_ref_json === null ? "missing-defaulted" : version.value.provenance,
  });
}

function decodeWorkflowRequestDispatchRow(input: {
  readonly row: WorkflowPersistedRow;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<DecodedWorkflowRequestDispatch>, PersistedDataError> {
  const table = "workflow_request_dispatches";
  const recordId = recordIdFromRow(input.row, "request_id");
  const version = decodeSchemaVersion(input.schemaVersion, table, recordId);
  if (version.status === "error") return Result.err(version.error);
  const row = requestDispatchRowSchema.safeParse(input.row);
  if (!row.success || (row.success && row.data.active !== 0 && row.data.active !== 1)) {
    return Result.err(invalidRow(table, version.value.version, recordId));
  }
  const policy = decodeJsonField({
    raw: row.data.policy_json,
    schema: workflowRequestPolicySchema,
    table,
    field: "policy_json",
    version: version.value.version,
    recordId,
  });
  if (policy.status === "error") return Result.err(policy.error);
  return Result.ok(
    provenance(
      {
        requestId: row.data.request_id,
        runId: row.data.run_id,
        operationId: row.data.operation_id,
        dispatchEpoch: row.data.dispatch_epoch,
        sessionId: row.data.session_id,
        platform: row.data.platform,
        policy: policy.value,
        ownerId: row.data.owner_id,
        ownerHeartbeatAt: row.data.owner_heartbeat_at,
        active: row.data.active === 1,
        createdAt: row.data.created_at,
        updatedAt: row.data.updated_at,
        promptPublishedAt: row.data.prompt_published_at,
      },
      version.value,
    ),
  );
}

function decodeWorkflowRequestTerminalReceiptRow(input: {
  readonly row: WorkflowPersistedRow;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<DecodedWorkflowRequestTerminalReceipt>, PersistedDataError> {
  const table = "workflow_request_terminal_receipts";
  const recordId = recordIdFromRow(input.row, "request_id");
  const version = decodeSchemaVersion(input.schemaVersion, table, recordId);
  if (version.status === "error") return Result.err(version.error);
  const row = requestTerminalReceiptRowSchema.safeParse(input.row);
  if (!row.success) return Result.err(invalidRow(table, version.value.version, recordId));
  const output = decodeNullableJsonField({
    raw: row.data.output_json,
    schema: jsonValueSchema,
    table,
    field: "output_json",
    version: version.value.version,
    recordId,
  });
  if (output.status === "error") return Result.err(output.error);
  const usage = decodeNullableJsonField({
    raw: row.data.usage_json,
    schema: workflowUsageSchema,
    table,
    field: "usage_json",
    version: version.value.version,
    recordId,
  });
  if (usage.status === "error") return Result.err(usage.error);
  if (
    row.data.state === "resolved" &&
    output.value === null &&
    row.data.result_artifact_id === null
  ) {
    return Result.err(invalidRow(table, version.value.version, recordId));
  }
  return Result.ok(
    provenance(
      {
        requestId: row.data.request_id,
        runId: row.data.run_id,
        operationId: row.data.operation_id,
        dispatchEpoch: row.data.dispatch_epoch,
        state: row.data.state,
        detail: row.data.detail,
        output: output.value,
        resultArtifactId: row.data.result_artifact_id,
        usage: usage.value,
        createdAt: row.data.created_at,
      },
      version.value,
    ),
  );
}

function decodeWorkflowActionOutboxRow(input: {
  readonly row: WorkflowPersistedRow;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<DecodedWorkflowActionOutboxEntry>, PersistedDataError> {
  const table = "workflow_action_outbox";
  const recordId = recordIdFromRow(input.row, "outbox_id");
  const version = decodeSchemaVersion(input.schemaVersion, table, recordId);
  if (version.status === "error") return Result.err(version.error);
  const row = actionOutboxRowSchema.safeParse(input.row);
  if (!row.success) return Result.err(invalidRow(table, version.value.version, recordId));
  const payload = decodeJsonField({
    raw: row.data.payload_json,
    schema: jsonValueSchema,
    table,
    field: "payload_json",
    version: version.value.version,
    recordId,
  });
  if (payload.status === "error") return Result.err(payload.error);
  return Result.ok(
    provenance(
      {
        outboxId: row.data.outbox_id,
        actionId: row.data.action_id,
        runId: row.data.run_id,
        eventType: row.data.event_type,
        payload: payload.value,
        publishedAt: row.data.published_at,
        projectedAt: row.data.projected_at,
        attemptCount: row.data.attempt_count,
        nextAttemptAt: row.data.next_attempt_at,
        lastError: row.data.last_error,
        createdAt: row.data.created_at,
        updatedAt: row.data.updated_at,
      },
      version.value,
    ),
  );
}

function decodeWorkflowLegacyAuditRow(input: {
  readonly row: WorkflowPersistedRow;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<DecodedWorkflowLegacyAuditRecord>, PersistedDataError> {
  const table = "workflow_legacy_audit_records";
  const recordId = recordIdFromRow(input.row, "record_id");
  const version = decodeSchemaVersion(input.schemaVersion, table, recordId);
  if (version.status === "error") return Result.err(version.error);
  const row = legacyAuditRowSchema.safeParse(input.row);
  if (!row.success) return Result.err(invalidRow(table, version.value.version, recordId));
  const payload = decodeJsonField({
    raw: row.data.payload_json,
    schema: jsonValueSchema,
    table,
    field: "payload_json",
    version: version.value.version,
    recordId,
  });
  if (payload.status === "error") return Result.err(payload.error);
  return Result.ok(
    provenance(
      {
        recordKind: row.data.record_kind,
        recordId: row.data.record_id,
        reason: row.data.reason,
        payload: payload.value,
        archivedAt: row.data.archived_at,
      },
      version.value,
    ),
  );
}

type WorkflowPersistenceRowInput<TKind extends string> = {
  readonly kind: TKind;
  readonly row: WorkflowPersistedRow;
  readonly schemaVersion: number;
};

export function decodeWorkflowPersistenceRow(
  input: WorkflowPersistenceRowInput<"revision">,
): ResultType<DecodedPersistedValue<WorkflowRevision>, PersistedDataError>;
export function decodeWorkflowPersistenceRow(
  input: WorkflowPersistenceRowInput<"run">,
): ResultType<DecodedPersistedValue<WorkflowRun>, PersistedDataError>;
export function decodeWorkflowPersistenceRow(
  input: WorkflowPersistenceRowInput<"operation">,
): ResultType<DecodedPersistedValue<WorkflowOperation>, PersistedDataError>;
export function decodeWorkflowPersistenceRow(
  input: WorkflowPersistenceRowInput<"wait">,
): ResultType<DecodedPersistedValue<WorkflowWait>, PersistedDataError>;
export function decodeWorkflowPersistenceRow(
  input: WorkflowPersistenceRowInput<"trigger">,
): ResultType<DecodedPersistedValue<WorkflowTrigger>, PersistedDataError>;
export function decodeWorkflowPersistenceRow(
  input: WorkflowPersistenceRowInput<"binding">,
): ResultType<DecodedPersistedValue<WorkflowSurfaceBinding>, PersistedDataError>;
export function decodeWorkflowPersistenceRow(
  input: WorkflowPersistenceRowInput<"action">,
): ResultType<DecodedPersistedValue<WorkflowSurfaceAction>, PersistedDataError>;
export function decodeWorkflowPersistenceRow(
  input: WorkflowPersistenceRowInput<"dispatch">,
): ResultType<DecodedPersistedValue<DecodedWorkflowRequestDispatch>, PersistedDataError>;
export function decodeWorkflowPersistenceRow(
  input: WorkflowPersistenceRowInput<"receipt">,
): ResultType<DecodedPersistedValue<DecodedWorkflowRequestTerminalReceipt>, PersistedDataError>;
export function decodeWorkflowPersistenceRow(
  input: WorkflowPersistenceRowInput<"outbox">,
): ResultType<DecodedPersistedValue<DecodedWorkflowActionOutboxEntry>, PersistedDataError>;
export function decodeWorkflowPersistenceRow(
  input: WorkflowPersistenceRowInput<"legacy-audit">,
): ResultType<DecodedPersistedValue<DecodedWorkflowLegacyAuditRecord>, PersistedDataError>;
export function decodeWorkflowPersistenceRow(
  input: WorkflowPersistenceRowInput<
    | "revision"
    | "run"
    | "operation"
    | "wait"
    | "trigger"
    | "binding"
    | "action"
    | "dispatch"
    | "receipt"
    | "outbox"
    | "legacy-audit"
  >,
): ResultType<
  DecodedPersistedValue<
    | WorkflowRevision
    | WorkflowRun
    | WorkflowOperation
    | WorkflowWait
    | WorkflowTrigger
    | WorkflowSurfaceBinding
    | WorkflowSurfaceAction
    | DecodedWorkflowRequestDispatch
    | DecodedWorkflowRequestTerminalReceipt
    | DecodedWorkflowActionOutboxEntry
    | DecodedWorkflowLegacyAuditRecord
  >,
  PersistedDataError
> {
  switch (input.kind) {
    case "revision":
      return decodeWorkflowRevisionRow(input);
    case "run":
      return decodeWorkflowRunRow(input);
    case "operation":
      return decodeWorkflowOperationRow(input);
    case "wait":
      return decodeWorkflowWaitRow(input);
    case "trigger":
      return decodeWorkflowTriggerRow(input);
    case "binding":
      return decodeWorkflowSurfaceBindingRow(input);
    case "action":
      return decodeWorkflowSurfaceActionRow(input);
    case "dispatch":
      return decodeWorkflowRequestDispatchRow(input);
    case "receipt":
      return decodeWorkflowRequestTerminalReceiptRow(input);
    case "outbox":
      return decodeWorkflowActionOutboxRow(input);
    case "legacy-audit":
      return decodeWorkflowLegacyAuditRow(input);
  }
}

const fixtureRunRow = {
  run_id: "fixture-run",
  revision_id: "fixture-revision",
  state: "queued",
  input_schema_json: '{"type":"object"}',
  args_json: "{}",
  args_sha256: "a".repeat(64),
  origin_request_id: null,
  origin_session_id: null,
  origin_client: null,
  origin_user_id: null,
  origin_project_cwd: "/fixture",
  completion_target_json: '{"kind":"detached"}',
  progress_target_json: null,
  terminal_detail: null,
  result_json: null,
  result_artifact_id: null,
  claimed_by: null,
  claimed_at: null,
  created_at: 1,
  started_at: null,
  updated_at: 1,
  terminal_at: null,
};

const fixtureActionRow = {
  action_id: "fixture-action",
  token_sha256: "b".repeat(64),
  run_id: "fixture-run",
  kind: "pause",
  expected_platform: "discord",
  expected_user_id: "fixture-user",
  expected_message_ref_json: null,
  expires_at: 10,
  consumed_at: null,
  consumed_by_platform: null,
  consumed_by_user_id: null,
  created_at: 1,
};

const fixtureRevisionRow = {
  revision_id: "fixture-revision",
  canonical_project_id: "fixture-project",
  canonical_workspace_root: "/fixture",
  scope: "project",
  normalized_path: "fixture.ts",
  name: "fixture",
  snapshot_artifact_id: "fixture-artifact",
  source_sha256: "a".repeat(64),
  input_schema_sha256: "b".repeat(64),
  capability_sha256: "c".repeat(64),
  metadata_json: '{"name":"fixture","description":"Fixture workflow"}',
  input_schema_json: "{}",
  capabilities_json:
    '{"agents":{"maxConcurrent":1,"maxTotal":1},"maxNestingDepth":1,"operationIdleTimeoutMs":1000,"waits":[]}',
  limits_json:
    '{"maxSourceBytes":1,"maxInputBytes":1,"maxOperationOutputBytes":1,"maxResultBytes":1}',
  runtime_version: "lilac-workflow-js-v4",
  created_at: 1,
};

const fixtureOperationRow = {
  run_id: "fixture-run",
  operation_id: "fixture-operation",
  call_site_id: "fixture-call-site",
  parent_operation_id: null,
  phase: null,
  label: null,
  kind: "agent",
  input_json: "{}",
  input_sha256: "d".repeat(64),
  state: "queued",
  attempt: 0,
  request_id: null,
  output_json: null,
  result_artifact_id: null,
  error: null,
  usage_json: null,
  claimed_by: null,
  claimed_at: null,
  created_at: 1,
  started_at: null,
  updated_at: 1,
  terminal_at: null,
};

const fixtureWaitRow = {
  run_id: "fixture-run",
  operation_id: "fixture-operation",
  state: "pending",
  match_kind: "sleep",
  match_json: '{"kind":"sleep"}',
  match_key: "sleep:1",
  due_at: 1,
  deadline_at: null,
  resolver_cursor: null,
  result_json: null,
  resolved_by: null,
  claimed_by: null,
  claimed_at: null,
  created_at: 1,
  updated_at: 1,
  resolved_at: null,
  expiry_cutoff_cursor: null,
  expiry_barrier_id: null,
  expiry_barrier_cursor: null,
  expiry_barrier_requested_at: null,
  expiry_barrier_processed_at: null,
};

const fixtureTriggerRow = {
  trigger_id: "fixture-trigger",
  revision_id: "fixture-revision",
  state: "active",
  kind: "immediate",
  definition_json: '{"kind":"immediate"}',
  args_json: "{}",
  args_sha256: "e".repeat(64),
  scheduling_policy_json: '{"skipMissed":true,"overlap":"coalesce"}',
  origin_json:
    '{"requestId":null,"sessionId":null,"client":null,"userId":null,"projectCwd":"/fixture"}',
  completion_target_json: '{"kind":"detached"}',
  progress_target_json: null,
  next_fire_at: 1,
  last_fire_at: null,
  last_run_id: null,
  claimed_by: null,
  claimed_at: null,
  created_at: 1,
  updated_at: 1,
};

const fixtureBindingRow = {
  run_id: "fixture-run",
  target_json: '{"platform":"discord","channelId":"fixture-channel","replyToMessageId":null}',
  message_ref_json: null,
  last_rendered_sha256: null,
  last_error: null,
  retry_count: 0,
  next_attempt_at: null,
  created_at: 1,
  updated_at: 1,
};

const fixturePolicyJson = JSON.stringify({
  runId: "fixture-run",
  operationId: "fixture-operation",
  dispatchEpoch: "f".repeat(32),
  profile: "general",
  model: null,
  reasoning: null,
  resolvedModelRequest: {
    spec: "fixture/model",
    provider: "fixture",
    modelId: "model",
    reasoningDisplay: "simple",
  },
  cwd: "/fixture",
  originSession: { requestId: null, sessionId: null, client: null, userId: null },
});

const fixtureDispatchRow = {
  request_id: "fixture-request",
  run_id: "fixture-run",
  operation_id: "fixture-operation",
  dispatch_epoch: "f".repeat(32),
  session_id: "fixture-session",
  platform: "unknown",
  policy_json: fixturePolicyJson,
  owner_id: null,
  owner_heartbeat_at: null,
  active: 1,
  created_at: 1,
  updated_at: 1,
  prompt_published_at: null,
};

const fixtureReceiptRow = {
  request_id: "fixture-request",
  run_id: "fixture-run",
  operation_id: "fixture-operation",
  dispatch_epoch: "f".repeat(32),
  state: "resolved",
  detail: null,
  output_json: '"fixture-output"',
  result_artifact_id: null,
  usage_json: null,
  created_at: 1,
};

const fixtureOutboxRow = {
  outbox_id: "fixture-outbox",
  action_id: "fixture-action",
  run_id: "fixture-run",
  event_type: "evt.workflow.progress.requested",
  payload_json: "{}",
  published_at: null,
  projected_at: null,
  attempt_count: 0,
  next_attempt_at: null,
  last_error: null,
  created_at: 1,
  updated_at: 1,
};

const fixtureLegacyAuditRow = {
  record_kind: "run",
  record_id: "fixture-run",
  reason: "fixture-reason",
  payload_json: "{}",
  archived_at: 1,
};

type WorkflowFixtureKind =
  | "revision"
  | "run"
  | "operation"
  | "wait"
  | "trigger"
  | "binding"
  | "action"
  | "dispatch"
  | "receipt"
  | "outbox"
  | "legacy-audit";

function familyFixtureInputs<TKind extends WorkflowFixtureKind>(
  kind: TKind,
  row: WorkflowPersistedRow,
  jsonField: string,
  requiredField: string,
  missingOutcome: "missing-defaulted" | "missing-rejected" = "missing-rejected",
  missingRow: WorkflowPersistedRow = { ...row, [requiredField]: null },
) {
  return {
    current: {
      input: { kind, row, schemaVersion: WORKFLOW_SCHEMA_VERSION },
    },
    legacy: {
      input: { kind, row, schemaVersion: WORKFLOW_SCHEMA_VERSION - 1 },
    },
    [missingOutcome]: {
      input: { kind, row: missingRow, schemaVersion: WORKFLOW_SCHEMA_VERSION },
    },
    "unsupported-version": {
      input: { kind, row, schemaVersion: WORKFLOW_SCHEMA_VERSION + 1 },
    },
    "malformed-serialization": {
      input: { kind, row: { ...row, [jsonField]: "{" }, schemaVersion: WORKFLOW_SCHEMA_VERSION },
    },
    "corrupt-fields": {
      input: { kind, row: { ...row, unexpected_field: 1 }, schemaVersion: WORKFLOW_SCHEMA_VERSION },
    },
  } as const;
}

export const workflowPersistenceRowFamilyFixtures = {
  revision: familyFixtureInputs("revision", fixtureRevisionRow, "metadata_json", "revision_id"),
  run: familyFixtureInputs("run", fixtureRunRow, "args_json", "run_id"),
  operation: familyFixtureInputs("operation", fixtureOperationRow, "input_json", "operation_id"),
  wait: familyFixtureInputs("wait", fixtureWaitRow, "match_json", "operation_id"),
  trigger: familyFixtureInputs("trigger", fixtureTriggerRow, "definition_json", "trigger_id"),
  binding: familyFixtureInputs("binding", fixtureBindingRow, "target_json", "run_id"),
  action: familyFixtureInputs(
    "action",
    {
      ...fixtureActionRow,
      expected_message_ref_json:
        '{"platform":"discord","channelId":"fixture-channel","messageId":"fixture-message"}',
    },
    "expected_message_ref_json",
    "action_id",
    "missing-defaulted",
    fixtureActionRow,
  ),
  dispatch: familyFixtureInputs("dispatch", fixtureDispatchRow, "policy_json", "request_id"),
  receipt: familyFixtureInputs("receipt", fixtureReceiptRow, "output_json", "request_id"),
  outbox: familyFixtureInputs("outbox", fixtureOutboxRow, "payload_json", "outbox_id"),
  "legacy-audit": familyFixtureInputs(
    "legacy-audit",
    fixtureLegacyAuditRow,
    "payload_json",
    "record_id",
  ),
} as const;

export const workflowPersistenceRowCodecCases = {
  current: {
    input: { kind: "run", row: fixtureRunRow, schemaVersion: WORKFLOW_SCHEMA_VERSION },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: { kind: "run", row: fixtureRunRow, schemaVersion: WORKFLOW_SCHEMA_VERSION - 1 },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { kind: "action", row: fixtureActionRow, schemaVersion: WORKFLOW_SCHEMA_VERSION },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: { kind: "run", row: fixtureRunRow, schemaVersion: WORKFLOW_SCHEMA_VERSION + 1 },
    outcome: "error",
  },
  "malformed-serialization": {
    input: {
      kind: "run",
      row: { ...fixtureRunRow, args_json: "{" },
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
    },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      kind: "run",
      row: { ...fixtureRunRow, state: "invalid" },
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
    },
    outcome: "error",
  },
} as const;
