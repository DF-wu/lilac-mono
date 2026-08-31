import path from "node:path";
import { parseArgs } from "node:util";

import type { BlobCloseError, BlobStore } from "@stanley2058/lilac-blob-storage";
import { formatTaggedErrorForLog } from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import {
  commitLegacyGracefulRestartMigration,
  LegacyGracefulRestartMigrationFailed,
  preflightLegacyGracefulRestartMigration,
  type LegacyGracefulRestartMigrationPlan,
  type LegacyGracefulRestartMigrationReport,
} from "./legacy-graceful-restart-blob-migration";
import {
  createBlobMigrationTargetStore,
  loadBlobMigrationTargetConfig,
  preflightBlobMigrationTarget,
  type BlobMigrationTarget,
  type BlobMigrationTargetPreflight,
} from "./blob-migration-target";
import {
  commitLegacyTranscriptMigration,
  deleteStagedLegacyTranscriptUploads,
  LegacyTranscriptMigrationApplyFailed,
  LegacyTranscriptMigrationPreflightFailed,
  preflightLegacyTranscriptDb,
  stageLegacyTranscriptMigration,
  type LegacyTranscriptMigrationPlan,
  type LegacyTranscriptMigrationReport,
  type StagedLegacyTranscriptMigration,
} from "./legacy-transcript-blob-migration";
import {
  discardLegacyTransientState,
  inspectLegacyTransientState,
  LEGACY_ANTHROPIC_FALLBACK_CACHE_DIR,
  type LegacyTransientStateReport,
} from "./legacy-transient-blob-state";
import {
  commitStagedLegacyWorkflowBlobMigration,
  deleteStagedLegacyWorkflowUploads,
  discardStagedLegacyWorkflowBlobState,
  LegacyWorkflowBlobMigrationFailed,
  preflightLegacyWorkflowBlobMigration,
  stageLegacyWorkflowBlobMigration,
  type LegacyWorkflowBlobMigrationPreflight,
  type LegacyWorkflowBlobMigrationSummary,
  type StagedLegacyWorkflowBlobMigration,
} from "./legacy-workflow-blob-migration";
import { preserveToolPanic } from "../src/tools/tool-result-adapters";

const MAX_REPORT_BLOCKERS = 20;
const STORE_CLOSE_BUDGET_MS = 30_000;

export type BlobStorageMigrationOptions = {
  readonly configPath: string;
  readonly dataDir: string;
  readonly workflowDbPath: string;
  readonly dryRun: boolean;
};

export type BlobStorageMigrationDependencies = {
  readonly onPreflight?: (report: BlobStorageMigrationReport) => void;
  readonly createTargetStore?: typeof createBlobMigrationTargetStore;
};

export type BlobStorageMigrationBlocker = {
  readonly source:
    | "arguments"
    | "config"
    | "target"
    | "transcript"
    | "workflow"
    | "graceful-restart"
    | "transient";
  readonly reason: string;
};

export type BlobStorageMigrationReport = {
  readonly mode: "dry-run" | "apply";
  readonly targetAdapter: "local" | "s3" | "unknown";
  readonly targetState: "ready" | "absent" | "unknown";
  readonly durableSources: readonly {
    readonly kind: string;
    readonly recordCount: number;
    readonly blobCount: number;
    readonly byteTotal: number;
  }[];
  readonly durableBlobCount: number;
  readonly durableByteTotal: number;
  readonly requiredFreeLocalBytes: number | null;
  readonly availableLocalBytes: number | null;
  readonly discardedTransientState: readonly LegacyTransientStateReport[];
  readonly legacyGracefulRestartSnapshotsToDiscard: number;
  readonly discardedLegacyGracefulRestartSnapshots: number;
  readonly redisMigration: "not-attempted";
  readonly blockers: readonly BlobStorageMigrationBlocker[];
  readonly result: "preflight-complete" | "migration-complete" | "failed";
};

export class BlobStorageMigrationArgumentsInvalid extends TaggedError(
  "BlobStorageMigrationArgumentsInvalid",
)<{
  readonly message: string;
}> {}

export class BlobStorageMigrationFailed extends TaggedError("BlobStorageMigrationFailed")<{
  readonly phase: "preflight" | "apply" | "close";
  readonly source: BlobStorageMigrationBlocker["source"];
  readonly report: BlobStorageMigrationReport;
  readonly message: string;
}> {}

export class BlobStorageMigrationOperationAndCloseFailed extends TaggedError(
  "BlobStorageMigrationOperationAndCloseFailed",
)<{
  readonly operation: string;
  readonly close: string;
  readonly message: string;
}> {}

export class BlobStorageMigrationUnexpectedFailure extends TaggedError(
  "BlobStorageMigrationUnexpectedFailure",
)<{
  readonly message: string;
}> {}

export class BlobStorageMigrationOwnedCleanupFailed extends TaggedError(
  "BlobStorageMigrationOwnedCleanupFailed",
)<{
  readonly operation: string;
  readonly cleanup: string;
  readonly close?: string;
  readonly message: string;
}> {}

type PreflightState = {
  readonly target: BlobMigrationTarget;
  readonly targetPreflight: BlobMigrationTargetPreflight;
  readonly transcriptPlan: LegacyTranscriptMigrationPlan;
  readonly transcriptReport: LegacyTranscriptMigrationReport;
  readonly workflowReport: LegacyWorkflowBlobMigrationPreflight;
  readonly gracefulRestartPlan: LegacyGracefulRestartMigrationPlan;
  readonly gracefulRestartReport: LegacyGracefulRestartMigrationReport;
  readonly transientReports: readonly LegacyTransientStateReport[];
  readonly report: BlobStorageMigrationReport;
};

type Outcome<T, E> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "error"; readonly error: E };

function outcome<T, E>(result: ResultType<T, E>): Outcome<T, E> {
  return result.match<Outcome<T, E>>({
    ok: (value) => ({ kind: "ok", value }),
    err: (error) => ({ kind: "error", error }),
  });
}

function reason(error: Error): string {
  if (error instanceof LegacyTranscriptMigrationApplyFailed) {
    const identity = [error.recordKind, error.recordId].filter(Boolean).join(":");
    return `${error._tag} stage=${error.stage}${identity ? ` record=${identity}` : ""}: ${error.message}`.slice(
      0,
      500,
    );
  }
  if (error instanceof LegacyTranscriptMigrationPreflightFailed) {
    const blocker = error.report.blockers[0];
    const identity = blocker ? `${blocker.kind}:${blocker.recordId}:${blocker.field}` : "unknown";
    return `${error._tag} record=${identity}: ${error.message}`.slice(0, 500);
  }
  if (error instanceof LegacyWorkflowBlobMigrationFailed) {
    return `${error._tag} source=${error.source} code=${error.code}${error.artifactId ? ` artifact=${error.artifactId}` : ""}: ${error.message}`.slice(
      0,
      500,
    );
  }
  if (error instanceof LegacyGracefulRestartMigrationFailed) {
    return `${error._tag} stage=${error.stage} code=${error.code}: ${error.message}`.slice(0, 500);
  }
  if (error instanceof BlobStorageMigrationOperationAndCloseFailed) {
    return `${error._tag}: operation=${error.operation}; close=${error.close}`.slice(0, 500);
  }
  if (error instanceof BlobStorageMigrationOwnedCleanupFailed) {
    return `${error._tag}: operation=${error.operation}; cleanup=${error.cleanup}${error.close ? `; close=${error.close}` : ""}`.slice(
      0,
      500,
    );
  }
  return `${error.name}: ${error.message || "Blob storage migration failed"}`.slice(0, 500);
}

function emptyReport(mode: BlobStorageMigrationReport["mode"]): BlobStorageMigrationReport {
  return {
    mode,
    targetAdapter: "unknown",
    targetState: "unknown",
    durableSources: [],
    durableBlobCount: 0,
    durableByteTotal: 0,
    requiredFreeLocalBytes: null,
    availableLocalBytes: null,
    discardedTransientState: [],
    legacyGracefulRestartSnapshotsToDiscard: 0,
    discardedLegacyGracefulRestartSnapshots: 0,
    redisMigration: "not-attempted",
    blockers: [],
    result: "failed",
  };
}

function localTargetOverlapsRetiredStorage(target: BlobMigrationTarget, dataDir: string): boolean {
  if (target.kind !== "local") return false;
  const targetRoot = path.resolve(target.root);
  const retiredRoots = [
    path.resolve(dataDir, "tool-results"),
    path.resolve(dataDir, "workflow-artifacts"),
    path.resolve(dataDir, "workflow-snapshots"),
    path.resolve(LEGACY_ANTHROPIC_FALLBACK_CACHE_DIR),
  ];
  return retiredRoots.some(
    (retiredRoot) =>
      targetRoot === retiredRoot ||
      targetRoot.startsWith(`${retiredRoot}${path.sep}`) ||
      retiredRoot.startsWith(`${targetRoot}${path.sep}`),
  );
}

function fail(input: {
  readonly phase: BlobStorageMigrationFailed["phase"];
  readonly source: BlobStorageMigrationBlocker["source"];
  readonly report: BlobStorageMigrationReport;
  readonly error: Error;
}): ResultType<never, BlobStorageMigrationFailed> {
  const message = reason(input.error);
  return Result.err(
    new BlobStorageMigrationFailed({
      phase: input.phase,
      source: input.source,
      report: {
        ...input.report,
        blockers: [...input.report.blockers, { source: input.source, reason: message }].slice(
          0,
          MAX_REPORT_BLOCKERS,
        ),
        result: "failed",
      },
      message,
    }),
  );
}

export function parseBlobStorageMigrationArgs(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ResultType<BlobStorageMigrationOptions, BlobStorageMigrationArgumentsInvalid> {
  const parsed = Result.try({
    try: () =>
      parseArgs({
        args: [...argv],
        allowPositionals: false,
        strict: true,
        options: {
          config: { type: "string" },
          "data-dir": { type: "string" },
          "dry-run": { type: "boolean", default: false },
        },
      }),
    catch: () =>
      new BlobStorageMigrationArgumentsInvalid({
        message:
          "Usage: bun run migrate:blob-storage -- --config <core-config.yaml> --data-dir <data-dir> [--dry-run]",
      }),
  });
  return parsed.andThen(({ values }) => {
    if (!values.config || !values["data-dir"]) {
      return Result.err(
        new BlobStorageMigrationArgumentsInvalid({
          message:
            "Usage: bun run migrate:blob-storage -- --config <core-config.yaml> --data-dir <data-dir> [--dry-run]",
        }),
      );
    }
    const dataDir = path.resolve(values["data-dir"]);
    return Result.ok({
      configPath: path.resolve(values.config),
      dataDir,
      workflowDbPath: path.resolve(environment.SQLITE_URL || path.join(dataDir, "data.sqlite3")),
      dryRun: values["dry-run"],
    });
  });
}

function buildReport(input: {
  readonly dryRun: boolean;
  readonly target: BlobMigrationTarget;
  readonly targetPreflight: BlobMigrationTargetPreflight;
  readonly transcript: LegacyTranscriptMigrationReport;
  readonly workflow: LegacyWorkflowBlobMigrationPreflight;
  readonly gracefulRestart: LegacyGracefulRestartMigrationReport;
  readonly transient: readonly LegacyTransientStateReport[];
  readonly result: BlobStorageMigrationReport["result"];
}): BlobStorageMigrationReport {
  const workflowReferenceCount =
    input.workflow.revisionSnapshotReferences +
    input.workflow.runResultReferences +
    input.workflow.operationResultReferences +
    input.workflow.terminalReceiptResultReferences;
  const durableSources = [
    ...input.transcript.sources.map((source) => ({
      kind: `transcript:${source.kind}`,
      recordCount: source.recordCount,
      blobCount: source.blobCount,
      byteTotal: source.byteLength,
    })),
    {
      kind: "workflow:artifacts",
      recordCount: workflowReferenceCount,
      blobCount: input.workflow.distinctArtifacts,
      byteTotal: input.workflow.durableBytes,
    },
    {
      kind: "graceful-restart:snapshot",
      recordCount: input.gracefulRestart.snapshotCount,
      blobCount: 0,
      byteTotal: 0,
    },
  ];
  const durableBlobCount = durableSources.reduce((sum, source) => sum + source.blobCount, 0);
  const durableByteTotal = durableSources.reduce((sum, source) => sum + source.byteTotal, 0);
  return {
    mode: input.dryRun ? "dry-run" : "apply",
    targetAdapter: input.target.kind,
    targetState: input.targetPreflight.status,
    durableSources,
    durableBlobCount,
    durableByteTotal,
    requiredFreeLocalBytes: input.target.kind === "local" ? durableByteTotal : null,
    availableLocalBytes: input.targetPreflight.availableLocalBytes ?? null,
    discardedTransientState: input.transient,
    legacyGracefulRestartSnapshotsToDiscard:
      input.gracefulRestart.classification === "legacy-discard"
        ? input.gracefulRestart.snapshotCount
        : 0,
    discardedLegacyGracefulRestartSnapshots:
      input.result === "migration-complete" ? input.gracefulRestart.discardedSnapshotCount : 0,
    redisMigration: "not-attempted",
    blockers: [],
    result: input.result,
  };
}

async function preflight(
  options: BlobStorageMigrationOptions,
): Promise<ResultType<PreflightState, BlobStorageMigrationFailed>> {
  const mode = options.dryRun ? "dry-run" : "apply";
  const loaded = outcome(
    await loadBlobMigrationTargetConfig({
      configPath: options.configPath,
      dataDir: options.dataDir,
    }),
  );
  if (loaded.kind === "error") {
    return fail({
      phase: "preflight",
      source: "config",
      report: emptyReport(mode),
      error: loaded.error,
    });
  }
  if (localTargetOverlapsRetiredStorage(loaded.value.target, options.dataDir)) {
    return fail({
      phase: "preflight",
      source: "target",
      report: { ...emptyReport(mode), targetAdapter: loaded.value.target.kind },
      error: new Error("The local blob target overlaps storage that this migration retires"),
    });
  }
  const targetPreflight = outcome(await preflightBlobMigrationTarget(loaded.value.target));
  if (targetPreflight.kind === "error") {
    return fail({
      phase: "preflight",
      source: "target",
      report: { ...emptyReport(mode), targetAdapter: loaded.value.target.kind },
      error: targetPreflight.error,
    });
  }

  const transcriptPath = path.join(options.dataDir, "agent-transcripts.db");
  const workflowPath = options.workflowDbPath;
  const gracefulRestartPath = path.join(options.dataDir, "graceful-restart.db");
  const transcript = outcome(preflightLegacyTranscriptDb(transcriptPath));
  if (transcript.kind === "error") {
    return fail({
      phase: "preflight",
      source: "transcript",
      report: {
        ...emptyReport(mode),
        targetAdapter: loaded.value.target.kind,
        targetState: targetPreflight.value.status,
      },
      error: transcript.error,
    });
  }
  const workflow = outcome(
    await preflightLegacyWorkflowBlobMigration({
      dbPath: workflowPath,
      dataDir: options.dataDir,
    }),
  );
  if (workflow.kind === "error") {
    return fail({
      phase: "preflight",
      source: "workflow",
      report: {
        ...emptyReport(mode),
        targetAdapter: loaded.value.target.kind,
        targetState: targetPreflight.value.status,
        durableSources: transcript.value.report.sources.map((source) => ({
          kind: `transcript:${source.kind}`,
          recordCount: source.recordCount,
          blobCount: source.blobCount,
          byteTotal: source.byteLength,
        })),
      },
      error: workflow.error,
    });
  }
  const gracefulRestart = outcome(preflightLegacyGracefulRestartMigration(gracefulRestartPath));
  if (gracefulRestart.kind === "error") {
    return fail({
      phase: "preflight",
      source: "graceful-restart",
      report: {
        ...emptyReport(mode),
        targetAdapter: loaded.value.target.kind,
        targetState: targetPreflight.value.status,
      },
      error: gracefulRestart.error,
    });
  }
  const transient = outcome(await inspectLegacyTransientState({ dataDir: options.dataDir }));
  if (transient.kind === "error") {
    return fail({
      phase: "preflight",
      source: "transient",
      report: emptyReport(mode),
      error: transient.error,
    });
  }
  const report = buildReport({
    dryRun: options.dryRun,
    target: loaded.value.target,
    targetPreflight: targetPreflight.value,
    transcript: transcript.value.report,
    workflow: workflow.value,
    gracefulRestart: gracefulRestart.value.report,
    transient: transient.value,
    result: "preflight-complete",
  });
  if (
    report.requiredFreeLocalBytes !== null &&
    report.availableLocalBytes !== null &&
    report.requiredFreeLocalBytes > report.availableLocalBytes
  ) {
    return fail({
      phase: "preflight",
      source: "target",
      report,
      error: new Error("The configured local blob target does not have enough available space"),
    });
  }
  return Result.ok({
    target: loaded.value.target,
    targetPreflight: targetPreflight.value,
    transcriptPlan: transcript.value.plan,
    transcriptReport: transcript.value.report,
    workflowReport: workflow.value,
    gracefulRestartPlan: gracefulRestart.value.plan,
    gracefulRestartReport: gracefulRestart.value.report,
    transientReports: transient.value,
    report,
  });
}

type CapturedOperationFailure = { readonly cause: unknown };
type OwnedOperationError = Error | Panic;

function classifyCapturedOperationFailure(cause: unknown): OwnedOperationError {
  if (Panic.is(cause)) return cause;
  if (cause instanceof Error) return cause;
  return new BlobStorageMigrationUnexpectedFailure({
    message: "Blob storage migration operation rejected with a non-Error value",
  });
}

async function captureOperation<T, E extends Error>(
  operation: () => Promise<ResultType<T, E>>,
): Promise<Outcome<T, E | OwnedOperationError>> {
  const captured = await Result.tryPromise<ResultType<T, E>, CapturedOperationFailure>({
    try: operation,
    catch: (cause) => ({ cause }),
  });
  if (captured.isErr()) {
    return { kind: "error", error: classifyCapturedOperationFailure(captured.error.cause) };
  }
  return outcome(captured.value);
}

function preservePanic(error: OwnedOperationError): Error {
  if (Panic.is(error)) preserveToolPanic(error);
  return error;
}

async function closeStore(
  store: BlobStore,
): Promise<ResultType<void, BlobCloseError | OwnedOperationError>> {
  const closed = await captureOperation(() =>
    store.close({ deadlineAtMs: Date.now() + STORE_CLOSE_BUDGET_MS }),
  );
  if (closed.kind === "error") return Result.err(closed.error);
  return Result.ok(undefined);
}

async function preserveOperationAndCloseFailure(
  store: BlobStore,
  operationError: OwnedOperationError,
): Promise<Error> {
  const closed = outcome(await closeStore(store));
  if (closed.kind === "ok") return preservePanic(operationError);
  if (Panic.is(operationError)) preserveToolPanic(operationError);
  if (Panic.is(closed.error)) preserveToolPanic(closed.error);
  return new BlobStorageMigrationOperationAndCloseFailed({
    operation: reason(operationError),
    close: reason(closed.error),
    message: "Blob storage migration operation and store close both failed",
  });
}

async function settleOwnedMigrationFailure(input: {
  readonly store: BlobStore;
  readonly operationError: OwnedOperationError;
  readonly transcript?: StagedLegacyTranscriptMigration;
  readonly workflow?: StagedLegacyWorkflowBlobMigration;
  readonly closeError?: BlobCloseError | OwnedOperationError;
}): Promise<Error> {
  const cleanupErrors: OwnedOperationError[] = [];
  const stagedWorkflow = input.workflow;
  if (stagedWorkflow !== undefined) {
    const cleaned = await captureOperation(() =>
      deleteStagedLegacyWorkflowUploads({ staged: stagedWorkflow, blobStore: input.store }),
    );
    if (cleaned.kind === "error") cleanupErrors.push(cleaned.error);
  }
  const stagedTranscript = input.transcript;
  if (stagedTranscript !== undefined) {
    const cleaned = await captureOperation(() =>
      deleteStagedLegacyTranscriptUploads({ stage: stagedTranscript, store: input.store }),
    );
    if (cleaned.kind === "error") cleanupErrors.push(cleaned.error);
  }
  const close =
    input.closeError === undefined
      ? outcome(await closeStore(input.store))
      : ({ kind: "error", error: input.closeError } as const);
  if (Panic.is(input.operationError)) preserveToolPanic(input.operationError);
  for (const cleanupError of cleanupErrors) {
    if (Panic.is(cleanupError)) preserveToolPanic(cleanupError);
  }
  if (close.kind === "error" && Panic.is(close.error)) preserveToolPanic(close.error);
  if (cleanupErrors.length > 0) {
    return new BlobStorageMigrationOwnedCleanupFailed({
      operation: reason(input.operationError),
      cleanup: cleanupErrors.map(reason).join("; ").slice(0, 500),
      ...(close.kind === "error" ? { close: reason(close.error) } : {}),
      message: "Blob storage migration operation and staged-object cleanup both failed",
    });
  }
  if (input.closeError !== undefined) return input.operationError;
  if (close.kind === "error") {
    return new BlobStorageMigrationOperationAndCloseFailed({
      operation: reason(input.operationError),
      close: reason(close.error),
      message: "Blob storage migration operation and store close both failed",
    });
  }
  return input.operationError;
}

async function applyMigration(
  options: BlobStorageMigrationOptions,
  state: PreflightState,
  dependencies: BlobStorageMigrationDependencies,
): Promise<ResultType<BlobStorageMigrationReport, BlobStorageMigrationFailed>> {
  const createTargetStore = dependencies.createTargetStore ?? createBlobMigrationTargetStore;
  const created = outcome(await createTargetStore(state.target));
  if (created.kind === "error") {
    return fail({ phase: "apply", source: "target", report: state.report, error: created.error });
  }
  const store = created.value;
  const transcript = await captureOperation(() =>
    stageLegacyTranscriptMigration({
      dbPath: path.join(options.dataDir, "agent-transcripts.db"),
      store,
      plan: state.transcriptPlan,
    }),
  );
  if (transcript.kind === "error") {
    return fail({
      phase: "apply",
      source: "transcript",
      report: state.report,
      error: await preserveOperationAndCloseFailure(store, transcript.error),
    });
  }
  const workflow = await captureOperation(() =>
    stageLegacyWorkflowBlobMigration({
      dbPath: options.workflowDbPath,
      dataDir: options.dataDir,
      blobStore: store,
    }),
  );
  if (workflow.kind === "error") {
    return fail({
      phase: "apply",
      source: "workflow",
      report: state.report,
      error: await settleOwnedMigrationFailure({
        store,
        operationError: workflow.error,
        transcript: transcript.value,
      }),
    });
  }
  const workflowCleanup = await captureOperation(() =>
    discardStagedLegacyWorkflowBlobState(workflow.value),
  );
  if (workflowCleanup.kind === "error") {
    return fail({
      phase: "apply",
      source: "workflow",
      report: state.report,
      error: await settleOwnedMigrationFailure({
        store,
        operationError: workflowCleanup.error,
        transcript: transcript.value,
        workflow: workflow.value,
      }),
    });
  }
  const discarded = await captureOperation(() =>
    discardLegacyTransientState({ dataDir: options.dataDir }),
  );
  if (discarded.kind === "error") {
    return fail({
      phase: "apply",
      source: "transient",
      report: state.report,
      error: await settleOwnedMigrationFailure({
        store,
        operationError: discarded.error,
        transcript: transcript.value,
        workflow: workflow.value,
      }),
    });
  }
  const closed = outcome(await closeStore(store));
  if (closed.kind === "error") {
    return fail({
      phase: "close",
      source: "target",
      report: state.report,
      error: await settleOwnedMigrationFailure({
        store,
        operationError: closed.error,
        transcript: transcript.value,
        workflow: workflow.value,
        closeError: closed.error,
      }),
    });
  }
  const transcriptCommit = outcome(
    commitLegacyTranscriptMigration({
      dbPath: path.join(options.dataDir, "agent-transcripts.db"),
      stage: transcript.value,
    }),
  );
  if (transcriptCommit.kind === "error") {
    return fail({
      phase: "apply",
      source: "transcript",
      report: state.report,
      error: transcriptCommit.error,
    });
  }
  const workflowCommit = outcome(
    commitStagedLegacyWorkflowBlobMigration({
      dbPath: options.workflowDbPath,
      staged: workflow.value,
      removedLegacyDirectories: workflowCleanup.value,
    }),
  );
  if (workflowCommit.kind === "error") {
    return fail({
      phase: "apply",
      source: "workflow",
      report: state.report,
      error: workflowCommit.error,
    });
  }
  const gracefulRestartCommit = outcome(
    commitLegacyGracefulRestartMigration({
      dbPath: path.join(options.dataDir, "graceful-restart.db"),
      plan: state.gracefulRestartPlan,
    }),
  );
  if (gracefulRestartCommit.kind === "error") {
    return fail({
      phase: "apply",
      source: "graceful-restart",
      report: state.report,
      error: gracefulRestartCommit.error,
    });
  }
  return Result.ok(
    buildReport({
      dryRun: false,
      target: state.target,
      targetPreflight: state.targetPreflight,
      transcript: transcriptCommit.value,
      workflow: workflowCommit.value satisfies LegacyWorkflowBlobMigrationSummary,
      gracefulRestart: {
        ...state.gracefulRestartReport,
        discardedSnapshotCount: gracefulRestartCommit.value.discardedSnapshotCount,
      },
      transient: state.transientReports,
      result: "migration-complete",
    }),
  );
}

export async function runBlobStorageMigration(
  options: BlobStorageMigrationOptions,
  dependencies: BlobStorageMigrationDependencies = {},
): Promise<ResultType<BlobStorageMigrationReport, BlobStorageMigrationFailed>> {
  const inspected = outcome(await preflight(options));
  if (inspected.kind === "error") return Result.err(inspected.error);
  dependencies.onPreflight?.(inspected.value.report);
  if (options.dryRun) return Result.ok(inspected.value.report);
  return applyMigration(options, inspected.value, dependencies);
}

export function formatBlobStorageMigrationFailureForLog(error: BlobStorageMigrationFailed): {
  readonly report: BlobStorageMigrationReport;
  readonly summary: string;
} {
  return {
    report: error.report,
    summary: `Blob storage migration failed during ${error.phase} (${error.source}): ${error.message}`,
  };
}

async function main(): Promise<void> {
  const parsed = outcome(parseBlobStorageMigrationArgs(process.argv.slice(2)));
  if (parsed.kind === "error") {
    console.error(parsed.error.message);
    process.exitCode = 1;
    return;
  }
  const migrated = await runBlobStorageMigration(parsed.value, {
    onPreflight: parsed.value.dryRun
      ? undefined
      : (report) => console.log(JSON.stringify(report, null, 2)),
  });
  const finish = migrated.match<() => void>({
    ok: (report) => () => console.log(JSON.stringify(report, null, 2)),
    err: (error) => () => {
      const formatted = formatBlobStorageMigrationFailureForLog(error);
      console.log(
        JSON.stringify({ ...formatted.report, failure: formatTaggedErrorForLog(error) }, null, 2),
      );
      console.error(
        error.phase === "preflight"
          ? formatted.summary
          : `${formatted.summary}. Restore the operator backup before rerunning.`,
      );
      process.exitCode = 1;
    },
  });
  finish();
}

if (import.meta.main) await main();
