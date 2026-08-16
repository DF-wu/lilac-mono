import {
  access,
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  statfs,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { BigIntStats, Stats } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { dlopen, FFIType, ptr } from "bun:ffi";

import { errorCode as nodeErrorCode, opaqueErrorMessage } from "@stanley2058/lilac-utils";
import { Panic, Result, type Result as ResultType } from "better-result";

import {
  decodeWorkspaceHistoryCaptureCache,
  decodeWorkspaceHistoryOwnership,
  decodeWorkspaceHistoryRestoreOwnership,
  decodeWorkspaceHistoryRestorePlan,
  decodeWorkspaceHistorySnapshotManifest,
  decodeWorkspaceHistorySnapshotRefCreated,
  encodeWorkspaceHistoryRecord,
  WORKSPACE_HISTORY_FORMAT_VERSION,
  WORKSPACE_HISTORY_IMPLEMENTATION_VERSION,
  type WorkspaceHistoryCachedEntry,
  type WorkspaceHistoryCaptureCache,
  type DecodedWorkspaceHistoryValue,
  type WorkspaceHistoryOwnership,
  type WorkspaceHistoryPersistenceCodecError,
  type WorkspaceHistoryPersistenceIssueCode,
  type WorkspaceHistoryPersistenceRecordKind,
  type WorkspaceHistoryPersistenceVersionCategory,
  type WorkspaceHistoryRestoreArtifact,
  type WorkspaceHistoryRestoreArtifactRole,
  type WorkspaceHistoryRestoreOwnership,
  type WorkspaceHistoryRestorePlan,
  type WorkspaceHistorySnapshotManifest,
  type WorkspaceHistorySnapshotRefCreated,
} from "./workspace-history-persistence-codec";

const FORMAT_VERSION = WORKSPACE_HISTORY_FORMAT_VERSION;
const IMPLEMENTATION_VERSION = WORKSPACE_HISTORY_IMPLEMENTATION_VERSION;
const POSIX_FILE_MODE = 0o100644;
const POSIX_EXECUTABLE_MODE = 0o100755;
const POSIX_SYMLINK_MODE = 0o120000;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SNAPSHOT_REF_PREFIX = "refs/mini-lilac/snapshots/";
const RESTORE_TEMP_PATTERN =
  /^\.mini-lilac-restore-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AT_EMPTY_PATH = 0x1000;
const AT_REMOVEDIR = process.platform === "darwin" ? 0x80 : 0x200;

const POSIX_FILE_API_SYMBOLS = {
  linkat: {
    args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.i32],
    returns: FFIType.i32,
  },
  renameat: {
    args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring],
    returns: FFIType.i32,
  },
  unlinkat: {
    args: [FFIType.i32, FFIType.cstring, FFIType.i32],
    returns: FFIType.i32,
  },
} as const;

function openPosixFileApi() {
  const libraryPath = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
  return dlopen(libraryPath, POSIX_FILE_API_SYMBOLS);
}

type PosixFileApi = ReturnType<typeof openPosixFileApi>;

function posixCString(value: string): Buffer {
  return Buffer.from(`${value}\0`);
}

export type WorkspaceHistoryCapability =
  | {
      status: "available";
      gitVersion: string;
      pathComparison: WorkspaceHistoryPathComparison;
    }
  | { status: "unavailable"; reason: "git-unavailable" | "platform-unsupported" };

export type WorkspaceHistoryCaptureResult =
  | {
      status: "captured";
      workspaceId: string;
      rootTreeOid: string;
      workspaceTreeOid: string;
      manifestBlobOid: string;
      gitRef: string;
      formatVersion: number;
      managedPathCount: number;
    }
  | {
      status: "skipped";
      reason: "git-unavailable" | "non-git-workspace" | "platform-unsupported";
    };

export type WorkspaceHistoryRestoreResult =
  | { status: "restored" }
  | {
      status: "skipped";
      reason: "git-unavailable" | "non-git-workspace" | "platform-unsupported";
    };

export type WorkspaceHistoryVerifyResult =
  | { status: "verified" }
  | {
      status: "skipped";
      reason: "git-unavailable" | "non-git-workspace" | "platform-unsupported";
    };

interface WorkspaceHistoryOperationMetricBase {
  workspaceId: string;
  durationMs: number;
  candidatePathCount: number;
  managedPathCount: number;
  payloadBytes: bigint;
}

export type WorkspaceHistoryMetric =
  | (WorkspaceHistoryOperationMetricBase & {
      type: "capture";
      outcome: "captured" | "skipped" | "failed";
      changed: boolean;
    })
  | (WorkspaceHistoryOperationMetricBase & {
      type: "restore";
      outcome: "restored" | "skipped" | "failed";
      changed: boolean;
    })
  | (WorkspaceHistoryOperationMetricBase & {
      type: "verify";
      outcome: "verified" | "skipped" | "failed";
    })
  | (WorkspaceHistoryOperationMetricBase & {
      type: "maintenance";
      outcome: "maintained" | "missing" | "removed" | "skipped" | "failed";
      removedOrphanRefCount: number;
      preservedOrphanRefCount: number;
    })
  | (WorkspaceHistoryOperationMetricBase & {
      type: "capability-unavailable";
      reason: "git-unavailable" | "platform-unsupported";
    })
  | (WorkspaceHistoryOperationMetricBase & {
      type: "verification-failure";
      operation: "restore" | "verify";
      errorCode: WorkspaceHistoryErrorCode;
    });

export interface WorkspaceHistoryObjectAccounting {
  readonly looseObjectCount: number;
  readonly looseObjectBytes: bigint;
  readonly inPackObjectCount: number;
  readonly packCount: number;
  readonly packBytes: bigint;
  readonly prunePackableObjectCount: number;
  readonly garbageObjectCount: number;
  readonly garbageBytes: bigint;
}

export type WorkspaceHistoryObjectAccountingResult =
  | { status: "accounted"; accounting: WorkspaceHistoryObjectAccounting }
  | { status: "missing"; accounting: WorkspaceHistoryObjectAccounting }
  | { status: "unavailable"; reason: "git-unavailable" | "platform-unsupported" };

export interface WorkspaceHistoryMaintenanceOptions {
  loadExpectedRootTreeOids: () => Promise<readonly string[]> | readonly string[];
  orphanGracePeriodMs: number;
  removeStoreIfUnused?: {
    canRemoveStore: () => Promise<boolean> | boolean;
  };
}

export type WorkspaceHistoryStoreRemovalRefusalReason =
  | "expected-snapshots"
  | "snapshot-refs"
  | "restore-plans"
  | "artifact-manifests"
  | "durable-work";

export type WorkspaceHistoryMaintenanceResult =
  | {
      status: "maintained";
      storeDisposition: "retained" | "removed";
      removalRefusalReason?: WorkspaceHistoryStoreRemovalRefusalReason;
      expected: WorkspaceHistoryExpectedRefResult[];
      removedOrphanRefs: string[];
      preservedOrphanRefs: string[];
      accounting: WorkspaceHistoryObjectAccounting;
    }
  | {
      status: "missing";
      storeDisposition: "missing";
      expected: WorkspaceHistoryExpectedRefResult[];
      removedOrphanRefs: string[];
      preservedOrphanRefs: string[];
      accounting: WorkspaceHistoryObjectAccounting;
    }
  | { status: "unavailable"; reason: "git-unavailable" | "platform-unsupported" };

export interface WorkspaceHistoryStoreOptions {
  cwd: string;
  historyRoot: string;
  workspaceId: string;
  namespaceId: string;
  databasePathHash: string;
  protectedPaths?: readonly string[];
  gitExecutable?: string;
  platform?: NodeJS.Platform;
  /** Destination collision policy. No Unicode normalization guarantee is implied. */
  pathComparison?: WorkspaceHistoryPathComparison;
  onMetric?: (metric: WorkspaceHistoryMetric) => Promise<void> | void;
  testHooks?: {
    beforeMutation?: (relativePath: string) => Promise<void> | void;
    beforeDestinationStage?: (
      relativePath: string,
      destinationDirectory: string,
    ) => Promise<void> | void;
    beforeHardLinkValidation?: (
      relativePath: string,
      destinationDirectory: string,
    ) => Promise<void> | void;
    afterDestinationStaging?: () => Promise<void> | void;
    afterArtifactCreateBeforeIdentity?: (
      role: RestoreArtifactRole,
      artifactPath: string,
    ) => Promise<void> | void;
    afterLiveDeletion?: (relativePath: string) => Promise<void> | void;
    afterPublication?: (relativePath: string) => Promise<void> | void;
    beforeFinalVerification?: () => Promise<void> | void;
    afterFinalVerificationBeforeCacheReconciliation?: () => Promise<void> | void;
    afterBoundSourceCapture?: () => Promise<void> | void;
    onCaptureRegularFilePayload?: (relativePath: string, bytes: bigint) => void;
    beforeSnapshotRefMetadataWrite?: (rootTreeOid: string) => Promise<void> | void;
    beforePrivateFilePublish?: (
      operation: string,
      temporaryPath: string,
      targetPath: string,
    ) => Promise<void> | void;
    afterPrivateFilePublishBeforeDirectorySync?: (
      operation: string,
      targetDirectory: string,
      targetPath: string,
    ) => Promise<void> | void;
    beforePrivateFileStat?: (operation: string, temporaryPath: string) => Promise<void> | void;
    beforePrivateFileClose?: (operation: string, temporaryPath: string) => Promise<void> | void;
    beforePrivateFileCleanup?: (operation: string, temporaryPath: string) => Promise<void> | void;
    beforePreparedRestoreDispose?: () => Promise<void> | void;
    afterSnapshotRefMetadataWriteBeforeRef?: (rootTreeOid: string) => Promise<void> | void;
    afterSnapshotRefPublication?: (rootTreeOid: string) => Promise<void> | void;
    beforePrivateGit?: (args: readonly string[]) => Promise<void> | void;
    afterPrivateGit?: (args: readonly string[]) => Promise<void> | void;
    statfs?: (
      targetPath: string,
    ) => Promise<{ bavail: bigint; bsize: bigint; filesystemId: string }>;
    now?: () => number;
  };
}

export interface WorkspaceHistoryPersistenceDiagnostic {
  readonly operation: "invalidate-capture-cache";
  readonly recordKind: WorkspaceHistoryPersistenceRecordKind;
  readonly issueCode: WorkspaceHistoryPersistenceIssueCode;
  readonly versionCategory?: WorkspaceHistoryPersistenceVersionCategory;
}

export type WorkspaceHistoryPathComparison = "case-sensitive" | "case-insensitive";

export type WorkspaceHistoryPrepareRestoreResult =
  | { status: "prepared"; plan: PreparedWorkspaceRestore }
  | {
      status: "skipped";
      reason: "git-unavailable" | "non-git-workspace" | "platform-unsupported";
    };

export interface PreparedWorkspaceRestore {
  readonly rootTreeOid: string;
  readonly operationId?: string;
  apply(): Promise<{ status: "restored" }>;
  verify(): Promise<{ status: "verified" }>;
  dispose(): Promise<void>;
}

export type WorkspaceHistoryExpectedCurrent =
  | { status: "captured"; rootTreeOid: string }
  | {
      status: "unavailable";
      reason:
        | "git-unavailable"
        | "non-git-workspace"
        | "platform-unsupported"
        | "capture-failed"
        | "snapshot-unavailable";
    };

export interface LockedWorkspaceHistoryStore {
  capture(): Promise<WorkspaceHistoryCaptureResult>;
  captureResult(): Promise<ResultType<WorkspaceHistoryCaptureResult, WorkspaceHistoryCaptureError>>;
  invalidateCaptureCacheResult(): Promise<ResultType<void, WorkspaceHistoryStoreError>>;
  prepareRestore(
    rootTreeOid: string,
    expectedCurrent?: WorkspaceHistoryExpectedCurrent,
    operationId?: string,
  ): Promise<WorkspaceHistoryPrepareRestoreResult>;
  resumePreparedRestore?(
    input: WorkspaceHistoryResumeRestoreInput,
  ): Promise<WorkspaceHistoryPrepareRestoreResult>;
}

export interface WorkspaceHistoryResumeRestoreInput {
  operationId: string;
  targetRootTreeOid: string;
  sourceRootTreeOid: string;
}

export interface WorkspaceHistoryRestorePlanCleanupResult {
  removedOperationIds: string[];
  preservedOperationIds: string[];
}

export interface WorkspaceHistoryExpectedRefResult {
  rootTreeOid: string;
  gitRef: string;
  status: "present" | "repaired" | "missing" | "corrupt";
}

export type WorkspaceHistoryRefReconciliation =
  | {
      status: "reconciled";
      expected: WorkspaceHistoryExpectedRefResult[];
      orphanRefs: string[];
    }
  | { status: "unavailable"; reason: "git-unavailable" | "platform-unsupported" };

export interface WorkspaceHistoryCleanupResult {
  removed: string[];
  preserved: string[];
}

export type WorkspaceHistoryOrphanCleanupResult =
  | {
      status: "cleaned";
      expected: WorkspaceHistoryExpectedRefResult[];
      removedOrphanRefs: string[];
      preservedOrphanRefs: string[];
    }
  | { status: "unavailable"; reason: "git-unavailable" | "platform-unsupported" };

export type RestoreArtifactRole = WorkspaceHistoryRestoreArtifactRole;

export type WorkspaceHistoryErrorCode =
  | "filesystem-error"
  | "git-unavailable"
  | "git-command-failed"
  | "malformed-git-output"
  | "ownership-mismatch"
  | "snapshot-invalid"
  | "restore-conflict"
  | "platform-unsupported"
  | "workspace-invalid";

interface WorkspaceHistoryStoreErrorParams {
  code: WorkspaceHistoryErrorCode;
  operation: string;
  message: string;
  detail?: string;
  exitCode?: number;
  cause?: unknown;
}

export class WorkspaceHistoryStoreError extends Error {
  readonly code: WorkspaceHistoryErrorCode;
  readonly operation: string;
  readonly detail?: string;
  readonly exitCode?: number;

  constructor(params: WorkspaceHistoryStoreErrorParams) {
    super(params.message, { cause: params.cause });
    this.name = "WorkspaceHistoryStoreError";
    this.code = params.code;
    this.operation = params.operation;
    this.detail = params.detail;
    this.exitCode = params.exitCode;
  }
}

export class WorkspaceHistoryCleanupFailed extends WorkspaceHistoryStoreError {
  readonly failures: readonly WorkspaceHistoryStoreError[];

  constructor(operation: string, failures: readonly WorkspaceHistoryStoreError[]) {
    super({
      code: "filesystem-error",
      operation,
      message: `Workspace history cleanup failed while ${operation}`,
    });
    this.name = "WorkspaceHistoryCleanupFailed";
    this.failures = failures;
  }
}

export class WorkspaceHistoryOperationAndCleanupFailed extends WorkspaceHistoryStoreError {
  readonly primary: WorkspaceHistoryStoreError;
  readonly cleanup: WorkspaceHistoryCleanupFailed;

  constructor(
    operation: string,
    primary: WorkspaceHistoryStoreError,
    cleanup: WorkspaceHistoryCleanupFailed,
  ) {
    super({
      code: primary.code,
      operation,
      message: `Workspace history operation and cleanup both failed while ${operation}`,
    });
    this.name = "WorkspaceHistoryOperationAndCleanupFailed";
    this.primary = primary;
    this.cleanup = cleanup;
  }
}

export type WorkspaceHistoryCaptureError =
  | WorkspaceHistoryStoreError
  | WorkspaceHistoryPersistenceCodecError;

/**
 * Carrier for the "Git executable disappeared" host signal. It is never thrown as control flow; it
 * is only held inside a `git-unavailable` failure so that the exact `cause` chain of the legacy
 * public API is preserved when the signal reaches a labelling boundary.
 */
class GitUnavailableSignal extends Error {}

/**
 * Closed internal failure projection for every workspace-history operation.
 *
 * - `owned` already carries this module's vocabulary and is never relabelled.
 * - `persistence` carries a versioned codec failure that outer boundaries may surface verbatim.
 * - `host` is an unlabelled filesystem, subprocess, or host-callback exception. The enclosing
 *   operation boundary attaches its own operation label, reproducing the single relabelling point
 *   the legacy exception flow had.
 * - `git-unavailable` is the typed replacement for the former thrown `GitUnavailableSignal`.
 */
type WorkspaceHistoryFailure =
  | { readonly kind: "owned"; readonly error: WorkspaceHistoryStoreError }
  | { readonly kind: "persistence"; readonly error: WorkspaceHistoryPersistenceCodecError }
  | { readonly kind: "host"; readonly cause: Error }
  | { readonly kind: "callback"; readonly cause: Error }
  | { readonly kind: "panic"; readonly cause: Panic }
  | { readonly kind: "git-unavailable"; readonly signal: GitUnavailableSignal };

type WorkspaceHistoryResult<T> = ResultType<T, WorkspaceHistoryFailure>;
type WorkspaceHistoryOperationalFailure = Exclude<WorkspaceHistoryFailure, { kind: "panic" }>;

interface WorkspaceHistoryDefectRejection {
  reject<T>(): Promise<T>;
}

/**
 * Supervised outcome of a region that may still receive a host defect (a `Panic` or a thrown
 * non-`Error` value). Only cleanup-combining regions observe these states; everywhere else a defect
 * propagates untouched.
 */
type SupervisedOutcome<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "failed"; readonly failure: WorkspaceHistoryOperationalFailure }
  | { readonly status: "panic"; readonly cause: Panic }
  | { readonly status: "defect"; readonly rejection: WorkspaceHistoryDefectRejection };

type CleanupOutcome =
  | { readonly status: "ok" }
  | { readonly status: "failed"; readonly error: WorkspaceHistoryCleanupFailed }
  | { readonly status: "panic"; readonly cause: Panic }
  | { readonly status: "defect"; readonly rejection: WorkspaceHistoryDefectRejection };

function ownedFailure(params: WorkspaceHistoryStoreErrorParams): WorkspaceHistoryFailure {
  return { kind: "owned", error: new WorkspaceHistoryStoreError(params) };
}

function failOwned(params: WorkspaceHistoryStoreErrorParams): WorkspaceHistoryResult<never> {
  return Result.err(ownedFailure(params));
}

function failWith(error: WorkspaceHistoryStoreError): WorkspaceHistoryResult<never> {
  return Result.err({ kind: "owned", error });
}

/** Node error code of a host failure, used by the few callers with an exact `errno` policy. */
function hostErrorCode(failure: WorkspaceHistoryFailure): string | undefined {
  return failure.kind === "host" ? nodeErrorCode(failure.cause) : undefined;
}

/**
 * Value carried by a failure when it must cross a legacy public edge that historically rethrew the
 * original exception object rather than an owned error.
 */
function failureCause(failure: WorkspaceHistoryFailure): Error {
  switch (failure.kind) {
    case "owned":
    case "persistence":
      return failure.error;
    case "host":
    case "callback":
      return failure.cause;
    case "panic":
      return failure.cause;
    case "git-unavailable":
      return failure.signal;
  }
}

/** Attaches `operation` to an unlabelled host or Git-unavailable failure. */
function labelFailure(
  failure: WorkspaceHistoryOperationalFailure,
  operation: string,
): WorkspaceHistoryCaptureError {
  switch (failure.kind) {
    case "owned":
    case "persistence":
      return failure.error;
    case "host":
      return hostStoreError(failure.cause, operation);
    case "callback":
      return hostStoreError(failure.cause, operation);
    case "git-unavailable":
      return hostStoreError(failure.signal, operation);
  }
}

/** Narrows {@link labelFailure} to the store vocabulary used by every public `Result` edge. */
function labelStoreError(
  failure: WorkspaceHistoryOperationalFailure,
  operation: string,
): WorkspaceHistoryStoreError {
  const labelled = labelFailure(failure, operation);
  if (labelled instanceof WorkspaceHistoryStoreError) return labelled;
  return hostStoreError(labelled, operation);
}

function labelWorkspaceFailure(
  failure: WorkspaceHistoryFailure,
  operation: string,
): WorkspaceHistoryFailure {
  if (failure.kind === "panic") return failure;
  return { kind: "owned", error: labelStoreError(failure, operation) };
}

function hostStoreError(cause: Error, operation: string): WorkspaceHistoryStoreError {
  return new WorkspaceHistoryStoreError({
    code: "filesystem-error",
    operation,
    message: `Filesystem operation failed while ${operation}: ${opaqueErrorMessage(cause, "Filesystem operation failed")}`,
    cause,
  });
}

/**
 * The module's only immediate host adapter. It wraps exactly one filesystem, subprocess, or
 * host-callback call, preserves `Panic` identity, keeps already-owned errors intact, and rethrows
 * any non-`Error` defect unchanged.
 */
async function attemptHost<T>(effect: () => Promise<T>): Promise<WorkspaceHistoryResult<T>> {
  try {
    return Result.ok(await effect());
  } catch (cause) {
    if (Panic.is(cause)) return Result.err({ kind: "panic", cause });
    if (cause instanceof WorkspaceHistoryStoreError)
      return Result.err({ kind: "owned", error: cause });
    if (cause instanceof GitUnavailableSignal) {
      return Result.err({ kind: "git-unavailable", signal: cause });
    }
    if (cause instanceof Error) return Result.err({ kind: "host", cause });
    throw cause;
  }
}

/** Synchronous counterpart of {@link attemptHost} for the two synchronous host calls. */
function attemptHostSync<T>(effect: () => T): WorkspaceHistoryResult<T> {
  try {
    return Result.ok(effect());
  } catch (cause) {
    if (Panic.is(cause)) return Result.err({ kind: "panic", cause });
    if (cause instanceof WorkspaceHistoryStoreError)
      return Result.err({ kind: "owned", error: cause });
    if (cause instanceof GitUnavailableSignal) {
      return Result.err({ kind: "git-unavailable", signal: cause });
    }
    if (cause instanceof Error) return Result.err({ kind: "host", cause });
    throw cause;
  }
}

function callPosixFileApi(operation: string, effect: () => number): WorkspaceHistoryResult<void> {
  const called = attemptHostSync(effect);
  let $calledResultValue21217!: import("better-result").InferOk<NonNullable<typeof called>>;
  let $calledResultError21217!: import("better-result").InferErr<NonNullable<typeof called>>;
  const $calledResultOk21217 = Result.match<
    import("better-result").InferOk<NonNullable<typeof called>>,
    import("better-result").InferErr<NonNullable<typeof called>>,
    boolean
  >(called, {
    ok: (value) => {
      $calledResultValue21217 = value;
      return true;
    },
    err: (error) => {
      $calledResultError21217 = error;
      return false;
    },
  });
  if (($calledResultOk21217 ? "ok" : "error") === "error")
    return Result.err($calledResultError21217);
  if ($calledResultValue21217 === 0) return Result.ok(undefined);
  return failOwned({
    code: "filesystem-error",
    operation,
    message: `Descriptor-bound filesystem operation failed while ${operation}`,
  });
}

function linkOpenFile(
  api: PosixFileApi,
  sourceFd: number,
  destinationDirectoryFd: number,
  destinationName: string,
  operation: string,
): WorkspaceHistoryResult<void> {
  const emptyPath = posixCString("");
  const destination = posixCString(destinationName);
  return callPosixFileApi(operation, () =>
    api.symbols.linkat(
      sourceFd,
      ptr(emptyPath),
      destinationDirectoryFd,
      ptr(destination),
      AT_EMPTY_PATH,
    ),
  );
}

function renameAt(
  api: PosixFileApi,
  sourceDirectoryFd: number,
  sourceName: string,
  destinationDirectoryFd: number,
  destinationName: string,
  operation: string,
): WorkspaceHistoryResult<void> {
  const source = posixCString(sourceName);
  const destination = posixCString(destinationName);
  return callPosixFileApi(operation, () =>
    api.symbols.renameat(sourceDirectoryFd, ptr(source), destinationDirectoryFd, ptr(destination)),
  );
}

function unlinkAt(
  api: PosixFileApi,
  directoryFd: number,
  name: string,
  removeDirectory: boolean,
  operation: string,
): WorkspaceHistoryResult<void> {
  const entry = posixCString(name);
  return callPosixFileApi(operation, () =>
    api.symbols.unlinkat(directoryFd, ptr(entry), removeDirectory ? AT_REMOVEDIR : 0),
  );
}

/**
 * The module's only defect supervisor. It is used exclusively by the two regions that must finish
 * their cleanup before a `Panic` or defect leaves the module, so that cleanup still runs and the
 * first defect keeps its exact identity.
 */
async function superviseOutcome<T>(
  effect: () => Promise<WorkspaceHistoryResult<T>>,
  errorKind: "host" | "callback" = "host",
): Promise<SupervisedOutcome<T>> {
  try {
    const result = await effect();
    let $resultResultValue23196!: import("better-result").InferOk<NonNullable<typeof result>>;
    let $resultResultError23196!: import("better-result").InferErr<NonNullable<typeof result>>;
    const $resultResultOk23196 = Result.match<
      import("better-result").InferOk<NonNullable<typeof result>>,
      import("better-result").InferErr<NonNullable<typeof result>>,
      boolean
    >(result, {
      ok: (value) => {
        $resultResultValue23196 = value;
        return true;
      },
      err: (error) => {
        $resultResultError23196 = error;
        return false;
      },
    });
    if (($resultResultOk23196 ? "ok" : "error") === "error") {
      if ($resultResultError23196.kind === "panic")
        return { status: "panic", cause: $resultResultError23196.cause };
      return { status: "failed", failure: $resultResultError23196 };
    }
    return { status: "ok", value: $resultResultValue23196 };
  } catch (cause) {
    if (Panic.is(cause)) return { status: "panic", cause };
    if (cause instanceof WorkspaceHistoryStoreError) {
      return { status: "failed", failure: { kind: "owned", error: cause } };
    }
    if (cause instanceof Error) {
      return { status: "failed", failure: { kind: errorKind, cause } };
    }
    return {
      status: "defect",
      rejection: { reject: <R>() => Promise.reject<R>(cause) },
    };
  }
}

function cleanupFailure(
  operation: string,
  failures: readonly WorkspaceHistoryOperationalFailure[],
): WorkspaceHistoryCleanupFailed {
  return new WorkspaceHistoryCleanupFailed(
    operation,
    failures.map((failure) => labelStoreError(failure, operation)),
  );
}

/**
 * Runs every cleanup even after one of them fails, then reports the first `Panic`, the first
 * defect, and finally the combined owned cleanup failure — the exact precedence the legacy cleanup
 * runner had.
 */
async function runWorkspaceHistoryCleanup(
  operation: string,
  cleanups: readonly (() => Promise<WorkspaceHistoryResult<void>>)[],
): Promise<CleanupOutcome> {
  const failures: WorkspaceHistoryOperationalFailure[] = [];
  let panic: { readonly cause: Panic } | undefined;
  let defect: { readonly rejection: WorkspaceHistoryDefectRejection } | undefined;
  for (const cleanup of cleanups) {
    const outcome = await superviseOutcome(cleanup);
    switch (outcome.status) {
      case "ok":
        break;
      case "failed":
        failures.push(outcome.failure);
        break;
      case "panic":
        panic ??= { cause: outcome.cause };
        break;
      case "defect":
        defect ??= { rejection: outcome.rejection };
        break;
    }
  }
  if (panic) return { status: "panic", cause: panic.cause };
  if (defect) return { status: "defect", rejection: defect.rejection };
  if (failures.length > 0) return { status: "failed", error: cleanupFailure(operation, failures) };
  return { status: "ok" };
}

/**
 * Resolution of a primary outcome against its cleanup outcome. `defect` is the only state the
 * caller must rethrow; every other state is an ordinary value.
 */
type ResolvedOutcome<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "failed"; readonly failure: WorkspaceHistoryOperationalFailure }
  | { readonly status: "panic"; readonly cause: Panic }
  | { readonly status: "defect"; readonly rejection: WorkspaceHistoryDefectRejection };

/**
 * Cleanup `Err` wins after successful work; a domain-owned combined error preserves both failures
 * when work and cleanup fail; the first `Panic` always wins over every ordinary failure.
 */
function resolveOutcomeWithCleanup<T>(
  primary: SupervisedOutcome<T>,
  cleanup: CleanupOutcome,
  operation: string,
): ResolvedOutcome<T> {
  if (cleanup.status === "ok") {
    switch (primary.status) {
      case "ok":
        return { status: "ok", value: primary.value };
      case "failed":
        return { status: "failed", failure: primary.failure };
      case "panic":
        return { status: "panic", cause: primary.cause };
      case "defect":
        return { status: "defect", rejection: primary.rejection };
    }
  }
  if (primary.status === "panic") return { status: "panic", cause: primary.cause };
  if (cleanup.status === "panic") return { status: "panic", cause: cleanup.cause };
  if (primary.status === "defect") return { status: "defect", rejection: primary.rejection };
  if (cleanup.status === "defect") return { status: "defect", rejection: cleanup.rejection };
  const cleanupError = cleanup.error;
  if (primary.status === "failed") {
    return {
      status: "failed",
      failure: {
        kind: "owned",
        error: new WorkspaceHistoryOperationAndCleanupFailed(
          operation,
          labelStoreError(primary.failure, operation),
          cleanupError,
        ),
      },
    };
  }
  return { status: "failed", failure: { kind: "owned", error: cleanupError } };
}

interface ScannedEntry {
  relativePath: string;
  absolutePath: string;
  kind: "regular" | "symlink" | "special";
  mode: number;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  dev: string;
  ino: string;
}

interface ScanResult {
  entries: Map<string, ScannedEntry>;
  directories: Set<string>;
  boundaryRoots: Set<string>;
}

interface ClassifiedWorkspace extends ScanResult {
  managed: Map<string, ScannedEntry>;
  ignored: Set<string>;
  ignoredDirectories: Set<string>;
}

interface TreeEntry {
  relativePath: string;
  mode: number;
  oid: string;
}

interface ParsedSnapshot {
  rootTreeOid: string;
  workspaceTreeOid: string;
  manifestBlobOid: string;
  manifestBytes: Uint8Array;
  entries: Map<string, TreeEntry>;
}

type SnapshotGraphValidation = { status: "valid" } | { status: "missing" } | { status: "corrupt" };

interface EnumeratedSnapshotGraph {
  entries: { oid: string; expectedType: "blob" | "tree" }[];
  result: GitResult;
  corrupt: boolean;
}

interface StagedTreeEntry extends TreeEntry {
  stagingPath: string;
}

interface PreparedRestoreData {
  snapshot: ParsedSnapshot;
  current: ClassifiedWorkspace;
  liveSignatures: Map<string, string>;
  preservation: Map<string, string>;
  protectedSignatures: Map<string, string>;
  stagingDirectory: string;
  stagedEntries: Map<string, StagedTreeEntry>;
  destinationEntries: Map<string, DestinationStagedEntry>;
  replacementRoots: Map<string, ReplacementDirectoryRoot>;
  ownedDirectories: Map<string, OwnedTemporaryPath>;
  ownedTemps: Map<string, OwnedTemporaryPath>;
  ownershipManifestPath?: string;
  ownershipManifest?: RestoreOwnershipManifest;
  workspaceIdentity: string;
  operationId?: string;
  recovery: boolean;
  metricStartedAt: number;
  candidatePathCount: number;
  managedPathCount: number;
  materializedBytes: bigint;
  state: "prepared" | "applying" | "applied" | "disposed";
}

type RestorePlanManifest = WorkspaceHistoryRestorePlan;

interface OwnedTemporaryPath {
  path: string;
  dev: bigint;
  ino: bigint;
}

interface DestinationStagedEntry extends StagedTreeEntry {
  temporaryPath: string;
  replacementRoot?: string;
}

interface ReplacementDirectoryRoot {
  relativePath: string;
  temporaryPath: string;
  identity: OwnedTemporaryPath;
  published: boolean;
}

type RestoreOwnershipManifest = WorkspaceHistoryRestoreOwnership;
type RestoreArtifactRecord = WorkspaceHistoryRestoreArtifact;

interface GitResult {
  stdout: Uint8Array;
  stderr: string;
  exitCode: number;
}

interface CaptureMetricObservation {
  candidatePathCount: number;
  managedPathCount: number;
  payloadBytes: bigint;
  changed: boolean;
}

interface FilesystemCapacity {
  availableBytes: bigint;
  requiredBytes: bigint;
}

type GitInput = Blob | Uint8Array | number;

const operationQueues = new Map<string, Promise<void>>();
const heldStoreLocks = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();

async function withStoreLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const heldLocks = heldStoreLocks.getStore();
  if (heldLocks?.get(key)?.active) return await operation();
  const previous = operationQueues.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  operationQueues.set(key, current);
  await previous;
  const lease = { active: true };
  const nextHeldLocks = new Map(heldLocks ?? []);
  nextHeldLocks.set(key, lease);
  try {
    return await heldStoreLocks.run(nextHeldLocks, operation);
  } finally {
    lease.active = false;
    release?.();
    if (operationQueues.get(key) === current) operationQueues.delete(key);
  }
}

function bytesToText(bytes: Uint8Array, operation: string): WorkspaceHistoryResult<string> {
  const decoded = attemptHostSync(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  let $decodedResultValue31218!: import("better-result").InferOk<NonNullable<typeof decoded>>;
  let $decodedResultError31218!: import("better-result").InferErr<NonNullable<typeof decoded>>;
  const $decodedResultOk31218 = Result.match<
    import("better-result").InferOk<NonNullable<typeof decoded>>,
    import("better-result").InferErr<NonNullable<typeof decoded>>,
    boolean
  >(decoded, {
    ok: (value) => {
      $decodedResultValue31218 = value;
      return true;
    },
    err: (error) => {
      $decodedResultError31218 = error;
      return false;
    },
  });
  if (($decodedResultOk31218 ? "ok" : "error") === "ok") return Result.ok($decodedResultValue31218);
  return failOwned({
    code: "malformed-git-output",
    operation,
    message: `Git returned non-UTF-8 output while ${operation}`,
    cause: failureCause($decodedResultError31218),
  });
}

const EMPTY_OBJECT_ACCOUNTING: WorkspaceHistoryObjectAccounting = Object.freeze({
  looseObjectCount: 0,
  looseObjectBytes: 0n,
  inPackObjectCount: 0,
  packCount: 0,
  packBytes: 0n,
  prunePackableObjectCount: 0,
  garbageObjectCount: 0,
  garbageBytes: 0n,
});

const OBJECT_ACCOUNTING_KEYS = [
  "count",
  "size",
  "in-pack",
  "packs",
  "size-pack",
  "prune-packable",
  "garbage",
  "size-garbage",
] as const;

type ObjectAccountingKey = (typeof OBJECT_ACCOUNTING_KEYS)[number];

function parseObjectAccounting(
  bytes: Uint8Array,
): WorkspaceHistoryResult<WorkspaceHistoryObjectAccounting> {
  const operation = "account private Git objects";
  const text = bytesToText(bytes, operation);
  let $textResultValue32206!: import("better-result").InferOk<NonNullable<typeof text>>;
  let $textResultError32206!: import("better-result").InferErr<NonNullable<typeof text>>;
  const $textResultOk32206 = Result.match<
    import("better-result").InferOk<NonNullable<typeof text>>,
    import("better-result").InferErr<NonNullable<typeof text>>,
    boolean
  >(text, {
    ok: (value) => {
      $textResultValue32206 = value;
      return true;
    },
    err: (error) => {
      $textResultError32206 = error;
      return false;
    },
  });
  if (($textResultOk32206 ? "ok" : "error") === "error") return Result.err($textResultError32206);
  if (!$textResultValue32206.endsWith("\n")) {
    return failOwned({
      code: "malformed-git-output",
      operation,
      message: "Git returned non-terminated object accounting output",
    });
  }
  const values = new Map<string, string>();
  for (const line of $textResultValue32206.slice(0, -1).split("\n")) {
    const match = /^([a-z-]+): ([0-9]+)$/.exec(line);
    if (!match?.[1] || match[2] === undefined || values.has(match[1])) {
      return failOwned({
        code: "malformed-git-output",
        operation,
        message: "Git returned malformed object accounting output",
        detail: line.slice(0, 200),
      });
    }
    values.set(match[1], match[2]);
  }
  if (values.size !== OBJECT_ACCOUNTING_KEYS.length) {
    return failOwned({
      code: "malformed-git-output",
      operation,
      message: "Git returned incomplete object accounting output",
    });
  }
  const countText = values.get("count");
  const sizeText = values.get("size");
  const inPackText = values.get("in-pack");
  const packsText = values.get("packs");
  const sizePackText = values.get("size-pack");
  const prunePackableText = values.get("prune-packable");
  const garbageText = values.get("garbage");
  const sizeGarbageText = values.get("size-garbage");
  if (
    countText === undefined ||
    sizeText === undefined ||
    inPackText === undefined ||
    packsText === undefined ||
    sizePackText === undefined ||
    prunePackableText === undefined ||
    garbageText === undefined ||
    sizeGarbageText === undefined
  ) {
    return failOwned({
      code: "malformed-git-output",
      operation,
      message: "Git returned incomplete object accounting output",
    });
  }
  const raw = {
    count: countText,
    size: sizeText,
    "in-pack": inPackText,
    packs: packsText,
    "size-pack": sizePackText,
    "prune-packable": prunePackableText,
    garbage: garbageText,
    "size-garbage": sizeGarbageText,
  } satisfies Record<ObjectAccountingKey, string>;
  const counts = {
    count: Number(raw.count),
    "in-pack": Number(raw["in-pack"]),
    packs: Number(raw.packs),
    "prune-packable": Number(raw["prune-packable"]),
    garbage: Number(raw.garbage),
  } as const;
  for (const [key, count] of Object.entries(counts)) {
    if (!Number.isSafeInteger(count)) {
      return failOwned({
        code: "malformed-git-output",
        operation,
        message: "Git returned object accounting outside the safe integer range",
        detail: key,
      });
    }
  }
  return Result.ok({
    looseObjectCount: counts.count,
    looseObjectBytes: BigInt(raw.size) * 1024n,
    inPackObjectCount: counts["in-pack"],
    packCount: counts.packs,
    packBytes: BigInt(raw["size-pack"]) * 1024n,
    prunePackableObjectCount: counts["prune-packable"],
    garbageObjectCount: counts.garbage,
    garbageBytes: BigInt(raw["size-garbage"]) * 1024n,
  });
}

function parseOid(bytes: Uint8Array, operation: string): WorkspaceHistoryResult<string> {
  const text = bytesToText(bytes, operation);
  let $textResultValue35263!: import("better-result").InferOk<NonNullable<typeof text>>;
  let $textResultError35263!: import("better-result").InferErr<NonNullable<typeof text>>;
  const $textResultOk35263 = Result.match<
    import("better-result").InferOk<NonNullable<typeof text>>,
    import("better-result").InferErr<NonNullable<typeof text>>,
    boolean
  >(text, {
    ok: (value) => {
      $textResultValue35263 = value;
      return true;
    },
    err: (error) => {
      $textResultError35263 = error;
      return false;
    },
  });
  if (($textResultOk35263 ? "ok" : "error") === "error") return Result.err($textResultError35263);
  const oid = $textResultValue35263.trim();
  if (!OID_PATTERN.test(oid)) {
    return failOwned({
      code: "malformed-git-output",
      operation,
      message: `Git returned an invalid object ID while ${operation}`,
      detail: oid.slice(0, 200),
    });
  }
  return Result.ok(oid);
}

function splitNul(bytes: Uint8Array, operation: string): WorkspaceHistoryResult<string[]> {
  if (bytes.length === 0) return Result.ok([]);
  const text = bytesToText(bytes, operation);
  let $textResultValue35778!: import("better-result").InferOk<NonNullable<typeof text>>;
  let $textResultError35778!: import("better-result").InferErr<NonNullable<typeof text>>;
  const $textResultOk35778 = Result.match<
    import("better-result").InferOk<NonNullable<typeof text>>,
    import("better-result").InferErr<NonNullable<typeof text>>,
    boolean
  >(text, {
    ok: (value) => {
      $textResultValue35778 = value;
      return true;
    },
    err: (error) => {
      $textResultError35778 = error;
      return false;
    },
  });
  if (($textResultOk35778 ? "ok" : "error") === "error") return Result.err($textResultError35778);
  const values = $textResultValue35778.split("\0");
  if (values.at(-1) !== "") {
    return failOwned({
      code: "malformed-git-output",
      operation,
      message: `Git returned non-NUL-terminated output while ${operation}`,
    });
  }
  values.pop();
  return Result.ok(values);
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function fromPosixPath(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

function isWithinOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function pathAncestors(relativePath: string): string[] {
  const parts = relativePath.split("/");
  const ancestors: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    ancestors.push(parts.slice(0, index).join("/"));
  }
  return ancestors;
}

function checkSafeRelativePath(
  relativePath: string,
  operation: string,
): WorkspaceHistoryResult<void> {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.startsWith("/") ||
    relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return failOwned({
      code: "snapshot-invalid",
      operation,
      message: `Snapshot contains an unsafe path: ${JSON.stringify(relativePath)}`,
    });
  }
  return Result.ok(undefined);
}

function sameStat(entry: ScannedEntry, cached: WorkspaceHistoryCachedEntry): boolean {
  // Warm reuse is conservative for ordinary edits: identity, size, mode, mtime, and ctime must all
  // match. Filesystems or adversarial writes that preserve every observed stat remain a residual risk.
  return (
    entry.kind === cached.kind &&
    entry.mode === cached.mode &&
    entry.size === cached.size &&
    entry.mtimeNs === cached.mtimeNs &&
    entry.ctimeNs === cached.ctimeNs &&
    entry.dev === cached.dev &&
    entry.ino === cached.ino
  );
}

function sameScannedFingerprint(left: ScannedEntry, right: ScannedEntry): boolean {
  return (
    left.kind === right.kind &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function canonicalJson(value: object): Uint8Array {
  return encodeWorkspaceHistoryRecord(value);
}

function mapsEqual(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function treeEntryArraysEqual(left: readonly TreeEntry[], right: readonly TreeEntry[]): boolean {
  if (left.length !== right.length) return false;
  const rightByPath = new Map(right.map((entry) => [entry.relativePath, entry]));
  return left.every((entry) => {
    const other = rightByPath.get(entry.relativePath);
    return other?.mode === entry.mode && other.oid === entry.oid;
  });
}

async function lstatIfExists(
  targetPath: string,
  bigint: true,
): Promise<WorkspaceHistoryResult<BigIntStats | undefined>>;
async function lstatIfExists(
  targetPath: string,
  bigint?: false,
): Promise<WorkspaceHistoryResult<Stats | undefined>>;
async function lstatIfExists(
  targetPath: string,
  bigint = false,
): Promise<WorkspaceHistoryResult<BigIntStats | Stats | undefined>> {
  const stats = await attemptHost<BigIntStats | Stats>(() =>
    bigint ? lstat(targetPath, { bigint: true }) : lstat(targetPath),
  );
  let $statsResultValue39571!: import("better-result").InferOk<NonNullable<typeof stats>>;
  let $statsResultError39571!: import("better-result").InferErr<NonNullable<typeof stats>>;
  const $statsResultOk39571 = Result.match<
    import("better-result").InferOk<NonNullable<typeof stats>>,
    import("better-result").InferErr<NonNullable<typeof stats>>,
    boolean
  >(stats, {
    ok: (value) => {
      $statsResultValue39571 = value;
      return true;
    },
    err: (error) => {
      $statsResultError39571 = error;
      return false;
    },
  });
  if (($statsResultOk39571 ? "ok" : "error") === "ok") return Result.ok($statsResultValue39571);
  if (hostErrorCode($statsResultError39571) === "ENOENT") return Result.ok(undefined);
  return stats;
}

function isMissingExecutable(error: unknown): boolean {
  return nodeErrorCode(error) === "ENOENT";
}

function validateWorkspaceHistoryStoreOptions(
  options: WorkspaceHistoryStoreOptions,
): ResultType<void, WorkspaceHistoryStoreError> {
  if (!SAFE_ID_PATTERN.test(options.workspaceId)) {
    return Result.err(
      new WorkspaceHistoryStoreError({
        code: "workspace-invalid",
        operation: "construct store",
        message: "workspaceId must be an opaque 1-128 character ASCII identifier",
      }),
    );
  }
  if (options.namespaceId.length === 0 || options.databasePathHash.length === 0) {
    return Result.err(
      new WorkspaceHistoryStoreError({
        code: "workspace-invalid",
        operation: "construct store",
        message: "namespaceId and databasePathHash must be non-empty",
      }),
    );
  }
  return Result.ok(undefined);
}

export function createWorkspaceHistoryStore(
  options: WorkspaceHistoryStoreOptions,
): ResultType<WorkspaceHistoryStore, WorkspaceHistoryStoreError> {
  const validated = validateWorkspaceHistoryStoreOptions(options);
  let $validatedResultError40874!: import("better-result").InferErr<NonNullable<typeof validated>>;
  const $validatedResultOk40874 = Result.match<
    import("better-result").InferOk<NonNullable<typeof validated>>,
    import("better-result").InferErr<NonNullable<typeof validated>>,
    boolean
  >(validated, {
    ok: () => true,
    err: (error) => {
      $validatedResultError40874 = error;
      return false;
    },
  });
  if (($validatedResultOk40874 ? "ok" : "error") === "error")
    return Result.err($validatedResultError40874);
  return Result.ok(new WorkspaceHistoryStore(options));
}

/**
 * Throwing public API edge. Every internal path composes Results; only the exported throwing methods
 * call this, and they rethrow exactly the value the pre-migration implementation raised.
 */
function throwFailure(failure: WorkspaceHistoryFailure): never {
  throw failureCause(failure);
}

export class WorkspaceHistoryStore {
  readonly cwd: string;
  readonly historyRoot: string;
  readonly workspaceId: string;
  readonly storeDirectory: string;

  private readonly namespaceId: string;
  private readonly databasePathHash: string;
  private readonly protectedPaths: readonly string[];
  private readonly signatureProtectedPaths: readonly string[];
  private readonly gitExecutable: string;
  private readonly platform: NodeJS.Platform;
  private readonly pathComparison: WorkspaceHistoryPathComparison;
  private readonly beforeMutation?: (relativePath: string) => Promise<void> | void;
  private readonly beforeDestinationStage?: (
    relativePath: string,
    destinationDirectory: string,
  ) => Promise<void> | void;
  private readonly beforeHardLinkValidation?: (
    relativePath: string,
    destinationDirectory: string,
  ) => Promise<void> | void;
  private readonly afterDestinationStaging?: () => Promise<void> | void;
  private readonly afterArtifactCreateBeforeIdentity?: (
    role: RestoreArtifactRole,
    artifactPath: string,
  ) => Promise<void> | void;
  private readonly afterLiveDeletion?: (relativePath: string) => Promise<void> | void;
  private readonly afterPublication?: (relativePath: string) => Promise<void> | void;
  private readonly beforeFinalVerification?: () => Promise<void> | void;
  private readonly afterFinalVerificationBeforeCacheReconciliation?: () => Promise<void> | void;
  private readonly afterBoundSourceCapture?: () => Promise<void> | void;
  private readonly onCaptureRegularFilePayload?: (relativePath: string, bytes: bigint) => void;
  private readonly beforeSnapshotRefMetadataWrite?: (rootTreeOid: string) => Promise<void> | void;
  private readonly beforePrivateFilePublish?: (
    operation: string,
    temporaryPath: string,
    targetPath: string,
  ) => Promise<void> | void;
  private readonly afterPrivateFilePublishBeforeDirectorySync?: (
    operation: string,
    targetDirectory: string,
    targetPath: string,
  ) => Promise<void> | void;
  private readonly beforePrivateFileStat?: (
    operation: string,
    temporaryPath: string,
  ) => Promise<void> | void;
  private readonly beforePrivateFileClose?: (
    operation: string,
    temporaryPath: string,
  ) => Promise<void> | void;
  private readonly beforePrivateFileCleanup?: (
    operation: string,
    temporaryPath: string,
  ) => Promise<void> | void;
  private readonly beforePreparedRestoreDispose?: () => Promise<void> | void;
  private readonly afterSnapshotRefMetadataWriteBeforeRef?: (
    rootTreeOid: string,
  ) => Promise<void> | void;
  private readonly afterSnapshotRefPublication?: (rootTreeOid: string) => Promise<void> | void;
  private readonly beforePrivateGit?: (args: readonly string[]) => Promise<void> | void;
  private readonly afterPrivateGit?: (args: readonly string[]) => Promise<void> | void;
  private readonly statfs: (
    targetPath: string,
  ) => Promise<{ bavail: bigint; bsize: bigint; filesystemId: string }>;
  private readonly onMetric?: (metric: WorkspaceHistoryMetric) => Promise<void> | void;
  private readonly now: () => number;
  private metricQueue: Promise<void> = Promise.resolve();
  private positiveProbe?: { version: string; expiresAt: number };
  private sourceExcludesFile?: string;

  constructor(options: WorkspaceHistoryStoreOptions) {
    const validated = validateWorkspaceHistoryStoreOptions(options);
    let $validatedResultError44710!: import("better-result").InferErr<
      NonNullable<typeof validated>
    >;
    const $validatedResultOk44710 = Result.match<
      import("better-result").InferOk<NonNullable<typeof validated>>,
      import("better-result").InferErr<NonNullable<typeof validated>>,
      boolean
    >(validated, {
      ok: () => true,
      err: (error) => {
        $validatedResultError44710 = error;
        return false;
      },
    });
    if (($validatedResultOk44710 ? "ok" : "error") === "error") throw $validatedResultError44710;

    this.cwd = path.resolve(options.cwd);
    this.historyRoot = path.resolve(options.historyRoot);
    this.workspaceId = options.workspaceId;
    this.namespaceId = options.namespaceId;
    this.databasePathHash = options.databasePathHash;
    this.storeDirectory = path.join(this.historyRoot, this.workspaceId, "objects.git");
    this.gitExecutable = options.gitExecutable ?? "git";
    this.platform = options.platform ?? process.platform;
    this.pathComparison =
      options.pathComparison ??
      (this.platform === "darwin" ? "case-insensitive" : "case-sensitive");
    this.protectedPaths = [
      this.historyRoot,
      ...(options.protectedPaths ?? []).map((value) => path.resolve(value)),
    ];
    this.signatureProtectedPaths = (options.protectedPaths ?? [])
      .map((value) => path.resolve(value))
      .filter(
        (protectedPath) =>
          !this.isWithinOrEqual(protectedPath, this.historyRoot) &&
          !this.isWithinOrEqual(this.historyRoot, protectedPath),
      );
    this.beforeMutation = options.testHooks?.beforeMutation;
    this.beforeDestinationStage = options.testHooks?.beforeDestinationStage;
    this.beforeHardLinkValidation = options.testHooks?.beforeHardLinkValidation;
    this.afterDestinationStaging = options.testHooks?.afterDestinationStaging;
    this.afterArtifactCreateBeforeIdentity = options.testHooks?.afterArtifactCreateBeforeIdentity;
    this.afterLiveDeletion = options.testHooks?.afterLiveDeletion;
    this.afterPublication = options.testHooks?.afterPublication;
    this.beforeFinalVerification = options.testHooks?.beforeFinalVerification;
    this.afterFinalVerificationBeforeCacheReconciliation =
      options.testHooks?.afterFinalVerificationBeforeCacheReconciliation;
    this.afterBoundSourceCapture = options.testHooks?.afterBoundSourceCapture;
    this.onCaptureRegularFilePayload = options.testHooks?.onCaptureRegularFilePayload;
    this.beforeSnapshotRefMetadataWrite = options.testHooks?.beforeSnapshotRefMetadataWrite;
    this.beforePrivateFilePublish = options.testHooks?.beforePrivateFilePublish;
    this.afterPrivateFilePublishBeforeDirectorySync =
      options.testHooks?.afterPrivateFilePublishBeforeDirectorySync;
    this.beforePrivateFileStat = options.testHooks?.beforePrivateFileStat;
    this.beforePrivateFileClose = options.testHooks?.beforePrivateFileClose;
    this.beforePrivateFileCleanup = options.testHooks?.beforePrivateFileCleanup;
    this.beforePreparedRestoreDispose = options.testHooks?.beforePreparedRestoreDispose;
    this.afterSnapshotRefMetadataWriteBeforeRef =
      options.testHooks?.afterSnapshotRefMetadataWriteBeforeRef;
    this.afterSnapshotRefPublication = options.testHooks?.afterSnapshotRefPublication;
    this.beforePrivateGit = options.testHooks?.beforePrivateGit;
    this.afterPrivateGit = options.testHooks?.afterPrivateGit;
    this.statfs =
      options.testHooks?.statfs ??
      (async (targetPath) => {
        const [filesystem, stats] = await Promise.all([
          statfs(targetPath, { bigint: true }),
          lstat(targetPath, { bigint: true }),
        ]);
        return {
          bavail: filesystem.bavail,
          bsize: filesystem.bsize,
          filesystemId: stats.dev.toString(),
        };
      });
    this.onMetric = options.onMetric;
    this.now = options.testHooks?.now ?? Date.now;
  }

  private async capabilityInternal(): Promise<WorkspaceHistoryResult<WorkspaceHistoryCapability>> {
    const startedAt = performance.now();
    if (this.platform !== "linux" && this.platform !== "darwin") {
      this.emitMetric({
        type: "capability-unavailable",
        workspaceId: this.workspaceId,
        reason: "platform-unsupported",
        durationMs: performance.now() - startedAt,
        candidatePathCount: 0,
        managedPathCount: 0,
        payloadBytes: 0n,
      });
      return Result.ok({ status: "unavailable", reason: "platform-unsupported" });
    }
    const version = await this.probeGit();
    let $versionResultValue48790!: import("better-result").InferOk<NonNullable<typeof version>>;
    let $versionResultError48790!: import("better-result").InferErr<NonNullable<typeof version>>;
    const $versionResultOk48790 = Result.match<
      import("better-result").InferOk<NonNullable<typeof version>>,
      import("better-result").InferErr<NonNullable<typeof version>>,
      boolean
    >(version, {
      ok: (value) => {
        $versionResultValue48790 = value;
        return true;
      },
      err: (error) => {
        $versionResultError48790 = error;
        return false;
      },
    });
    if (($versionResultOk48790 ? "ok" : "error") === "error") {
      if ($versionResultError48790.kind !== "git-unavailable")
        return Result.err($versionResultError48790);
      this.emitMetric({
        type: "capability-unavailable",
        workspaceId: this.workspaceId,
        reason: "git-unavailable",
        durationMs: performance.now() - startedAt,
        candidatePathCount: 0,
        managedPathCount: 0,
        payloadBytes: 0n,
      });
      return Result.ok({ status: "unavailable", reason: "git-unavailable" });
    }
    return Result.ok({
      status: "available",
      gitVersion: $versionResultValue48790,
      pathComparison: this.pathComparison,
    });
  }

  async capability(): Promise<WorkspaceHistoryCapability> {
    const capability = await this.capabilityInternal();
    let $capabilityResultValue49525!: import("better-result").InferOk<
      NonNullable<typeof capability>
    >;
    let $capabilityResultError49525!: import("better-result").InferErr<
      NonNullable<typeof capability>
    >;
    const $capabilityResultOk49525 = Result.match<
      import("better-result").InferOk<NonNullable<typeof capability>>,
      import("better-result").InferErr<NonNullable<typeof capability>>,
      boolean
    >(capability, {
      ok: (value) => {
        $capabilityResultValue49525 = value;
        return true;
      },
      err: (error) => {
        $capabilityResultError49525 = error;
        return false;
      },
    });
    if (($capabilityResultOk49525 ? "ok" : "error") === "error")
      throwFailure($capabilityResultError49525);
    return $capabilityResultValue49525;
  }

  async capabilityResult(): Promise<
    ResultType<WorkspaceHistoryCapability, WorkspaceHistoryStoreError>
  > {
    if (this.capability !== WorkspaceHistoryStore.prototype.capability) {
      return await this.callThrowingOverride(
        async () => await this.capability(),
        "probe workspace history capability",
      );
    }
    const capability = await this.capabilityInternal();
    return await this.publicWorkspaceResult(capability, "probe workspace history capability");
  }

  private withWorkspaceLockOutcome<T>(
    callback: (lockedStore: LockedWorkspaceHistoryStore) => Promise<T>,
  ): Promise<ResolvedOutcome<T>> {
    return withStoreLock(this.storeDirectory, async () => {
      let active = true;
      let lastCapture: WorkspaceHistoryCaptureResult | undefined;
      const preparedPlans = new Set<PreparedRestoreData>();
      const leaseState = (): WorkspaceHistoryResult<void> => {
        if (active) return Result.ok(undefined);
        return failOwned({
          code: "workspace-invalid",
          operation: "use workspace history lock",
          message: "Workspace history lock lease is no longer active",
        });
      };
      const captureResult = async (): Promise<
        ResultType<WorkspaceHistoryCaptureResult, WorkspaceHistoryCaptureError>
      > => {
        const lease = leaseState();
        let $leaseResultError51002!: import("better-result").InferErr<NonNullable<typeof lease>>;
        const $leaseResultOk51002 = Result.match<
          import("better-result").InferOk<NonNullable<typeof lease>>,
          import("better-result").InferErr<NonNullable<typeof lease>>,
          boolean
        >(lease, {
          ok: () => true,
          err: (error) => {
            $leaseResultError51002 = error;
            return false;
          },
        });
        if (($leaseResultOk51002 ? "ok" : "error") === "error")
          return await Promise.reject(failureCause($leaseResultError51002));
        const captured = await this.captureLocked();
        let $capturedResultValue51132!: import("better-result").InferOk<
          NonNullable<typeof captured>
        >;
        let $capturedResultError51132!: import("better-result").InferErr<
          NonNullable<typeof captured>
        >;
        const $capturedResultOk51132 = Result.match<
          import("better-result").InferOk<NonNullable<typeof captured>>,
          import("better-result").InferErr<NonNullable<typeof captured>>,
          boolean
        >(captured, {
          ok: (value) => {
            $capturedResultValue51132 = value;
            return true;
          },
          err: (error) => {
            $capturedResultError51132 = error;
            return false;
          },
        });
        if (($capturedResultOk51132 ? "ok" : "error") === "error") {
          if ($capturedResultError51132.kind === "panic") {
            return await Promise.reject($capturedResultError51132.cause);
          }
          return Result.err(labelFailure($capturedResultError51132, "capture workspace"));
        }
        lastCapture = $capturedResultValue51132;
        return Result.ok($capturedResultValue51132);
      };
      const lockedStore: LockedWorkspaceHistoryStore = {
        captureResult,
        invalidateCaptureCacheResult: async () => {
          const lease = leaseState();
          let $leaseResultError51665!: import("better-result").InferErr<NonNullable<typeof lease>>;
          const $leaseResultOk51665 = Result.match<
            import("better-result").InferOk<NonNullable<typeof lease>>,
            import("better-result").InferErr<NonNullable<typeof lease>>,
            boolean
          >(lease, {
            ok: () => true,
            err: (error) => {
              $leaseResultError51665 = error;
              return false;
            },
          });
          if (($leaseResultOk51665 ? "ok" : "error") === "error")
            return await Promise.reject(failureCause($leaseResultError51665));
          const invalidated = await this.invalidateCaptureCache();
          let $invalidatedResultError51799!: import("better-result").InferErr<
            NonNullable<typeof invalidated>
          >;
          const $invalidatedResultOk51799 = Result.match<
            import("better-result").InferOk<NonNullable<typeof invalidated>>,
            import("better-result").InferErr<NonNullable<typeof invalidated>>,
            boolean
          >(invalidated, {
            ok: () => true,
            err: (error) => {
              $invalidatedResultError51799 = error;
              return false;
            },
          });
          if (($invalidatedResultOk51799 ? "ok" : "error") === "error") {
            if ($invalidatedResultError51799.kind === "panic") {
              return await Promise.reject($invalidatedResultError51799.cause);
            }
            return Result.err(
              labelStoreError($invalidatedResultError51799, "invalidate capture cache"),
            );
          }
          return Result.ok(undefined);
        },
        capture: async () => {
          const captured = await captureResult();
          let $capturedResultValue52238!: import("better-result").InferOk<
            NonNullable<typeof captured>
          >;
          let $capturedResultError52238!: import("better-result").InferErr<
            NonNullable<typeof captured>
          >;
          const $capturedResultOk52238 = Result.match<
            import("better-result").InferOk<NonNullable<typeof captured>>,
            import("better-result").InferErr<NonNullable<typeof captured>>,
            boolean
          >(captured, {
            ok: (value) => {
              $capturedResultValue52238 = value;
              return true;
            },
            err: (error) => {
              $capturedResultError52238 = error;
              return false;
            },
          });
          if (($capturedResultOk52238 ? "ok" : "error") === "error")
            return await Promise.reject($capturedResultError52238);
          return $capturedResultValue52238;
        },
        prepareRestore: async (rootTreeOid, expectedCurrent, operationId) => {
          const lease = leaseState();
          let $leaseResultError52499!: import("better-result").InferErr<NonNullable<typeof lease>>;
          const $leaseResultOk52499 = Result.match<
            import("better-result").InferOk<NonNullable<typeof lease>>,
            import("better-result").InferErr<NonNullable<typeof lease>>,
            boolean
          >(lease, {
            ok: () => true,
            err: (error) => {
              $leaseResultError52499 = error;
              return false;
            },
          });
          if (($leaseResultOk52499 ? "ok" : "error") === "error")
            return await Promise.reject(failureCause($leaseResultError52499));
          let boundCurrent = expectedCurrent;
          if (boundCurrent === undefined && lastCapture?.status === "captured") {
            boundCurrent = { status: "captured", rootTreeOid: lastCapture.rootTreeOid };
          } else if (boundCurrent === undefined && lastCapture?.status === "skipped") {
            boundCurrent = { status: "unavailable", reason: lastCapture.reason };
          }
          const prepared = await this.prepareRestoreLocked(
            rootTreeOid,
            boundCurrent,
            leaseState,
            preparedPlans,
            operationId,
          );
          let $preparedResultValue53032!: import("better-result").InferOk<
            NonNullable<typeof prepared>
          >;
          let $preparedResultError53032!: import("better-result").InferErr<
            NonNullable<typeof prepared>
          >;
          const $preparedResultOk53032 = Result.match<
            import("better-result").InferOk<NonNullable<typeof prepared>>,
            import("better-result").InferErr<NonNullable<typeof prepared>>,
            boolean
          >(prepared, {
            ok: (value) => {
              $preparedResultValue53032 = value;
              return true;
            },
            err: (error) => {
              $preparedResultError53032 = error;
              return false;
            },
          });
          if (($preparedResultOk53032 ? "ok" : "error") === "error") {
            return await Promise.reject(failureCause($preparedResultError53032));
          }
          return $preparedResultValue53032;
        },
        resumePreparedRestore: async (input) => {
          const lease = leaseState();
          let $leaseResultError53454!: import("better-result").InferErr<NonNullable<typeof lease>>;
          const $leaseResultOk53454 = Result.match<
            import("better-result").InferOk<NonNullable<typeof lease>>,
            import("better-result").InferErr<NonNullable<typeof lease>>,
            boolean
          >(lease, {
            ok: () => true,
            err: (error) => {
              $leaseResultError53454 = error;
              return false;
            },
          });
          if (($leaseResultOk53454 ? "ok" : "error") === "error")
            return await Promise.reject(failureCause($leaseResultError53454));
          const prepared = await this.resumePreparedRestoreLocked(input, leaseState, preparedPlans);
          let $preparedResultValue53588!: import("better-result").InferOk<
            NonNullable<typeof prepared>
          >;
          let $preparedResultError53588!: import("better-result").InferErr<
            NonNullable<typeof prepared>
          >;
          const $preparedResultOk53588 = Result.match<
            import("better-result").InferOk<NonNullable<typeof prepared>>,
            import("better-result").InferErr<NonNullable<typeof prepared>>,
            boolean
          >(prepared, {
            ok: (value) => {
              $preparedResultValue53588 = value;
              return true;
            },
            err: (error) => {
              $preparedResultError53588 = error;
              return false;
            },
          });
          if (($preparedResultOk53588 ? "ok" : "error") === "error") {
            return await Promise.reject(failureCause($preparedResultError53588));
          }
          return $preparedResultValue53588;
        },
      };
      const primary = await superviseOutcome<T>(
        async () => Result.ok(await callback(lockedStore)),
        "callback",
      );
      active = false;
      const cleanup = await runWorkspaceHistoryCleanup(
        "dispose prepared workspace restores",
        [...preparedPlans].map((plan) => async () => await this.disposePreparedRestore(plan)),
      );
      return resolveOutcomeWithCleanup(primary, cleanup, "run workspace history lock callback");
    });
  }

  async withWorkspaceLock<T>(
    callback: (lockedStore: LockedWorkspaceHistoryStore) => Promise<T>,
  ): Promise<T> {
    const outcome = await this.withWorkspaceLockOutcome(callback);
    switch (outcome.status) {
      case "ok":
        return outcome.value;
      case "failed":
        if (outcome.failure.kind === "callback") {
          return await Promise.reject(outcome.failure.cause);
        }
        return await Promise.reject(
          labelFailure(outcome.failure, "run workspace history lock callback"),
        );
      case "panic":
        return await Promise.reject(outcome.cause);
      case "defect":
        return await outcome.rejection.reject<T>();
    }
  }

  async withWorkspaceLockResult<T>(
    callback: (lockedStore: LockedWorkspaceHistoryStore) => Promise<T>,
  ): Promise<ResultType<T, WorkspaceHistoryStoreError>> {
    if (this.withWorkspaceLock !== WorkspaceHistoryStore.prototype.withWorkspaceLock) {
      return await this.callThrowingOverride(
        async () => await this.withWorkspaceLock(callback),
        "run workspace history lock callback",
      );
    }
    const outcome = await this.withWorkspaceLockOutcome(callback);
    switch (outcome.status) {
      case "ok":
        return Result.ok(outcome.value);
      case "failed":
        return Result.err(labelStoreError(outcome.failure, "run workspace history lock callback"));
      case "panic":
        return await Promise.reject(outcome.cause);
      case "defect":
        return await outcome.rejection.reject<ResultType<T, WorkspaceHistoryStoreError>>();
    }
  }

  async capture(): Promise<WorkspaceHistoryCaptureResult> {
    return await this.withWorkspaceLock(async (lockedStore) => await lockedStore.capture());
  }

  async captureResult(): Promise<
    ResultType<WorkspaceHistoryCaptureResult, WorkspaceHistoryCaptureError>
  > {
    if (this.capture !== WorkspaceHistoryStore.prototype.capture) {
      return await this.callThrowingOverride(async () => await this.capture(), "capture workspace");
    }
    const locked = await this.withWorkspaceLockResult(
      async (lockedStore) => await lockedStore.captureResult(),
    );
    let $lockedResultValue56376!: import("better-result").InferOk<NonNullable<typeof locked>>;
    let $lockedResultError56376!: import("better-result").InferErr<NonNullable<typeof locked>>;
    const $lockedResultOk56376 = Result.match<
      import("better-result").InferOk<NonNullable<typeof locked>>,
      import("better-result").InferErr<NonNullable<typeof locked>>,
      boolean
    >(locked, {
      ok: (value) => {
        $lockedResultValue56376 = value;
        return true;
      },
      err: (error) => {
        $lockedResultError56376 = error;
        return false;
      },
    });
    if (($lockedResultOk56376 ? "ok" : "error") === "error")
      return Result.err($lockedResultError56376);
    return $lockedResultValue56376;
  }

  private captureLocked(): Promise<WorkspaceHistoryResult<WorkspaceHistoryCaptureResult>> {
    const startedAt = performance.now();
    const observation: CaptureMetricObservation = {
      candidatePathCount: 0,
      managedPathCount: 0,
      payloadBytes: 0n,
      changed: false,
    };
    return (async () => {
      const attempted = await this.captureLockedAttempt(observation);
      let $attemptedResultValue56922!: import("better-result").InferOk<
        NonNullable<typeof attempted>
      >;
      let $attemptedResultError56922!: import("better-result").InferErr<
        NonNullable<typeof attempted>
      >;
      const $attemptedResultOk56922 = Result.match<
        import("better-result").InferOk<NonNullable<typeof attempted>>,
        import("better-result").InferErr<NonNullable<typeof attempted>>,
        boolean
      >(attempted, {
        ok: (value) => {
          $attemptedResultValue56922 = value;
          return true;
        },
        err: (error) => {
          $attemptedResultError56922 = error;
          return false;
        },
      });
      if (($attemptedResultOk56922 ? "ok" : "error") === "ok") {
        if ($attemptedResultValue56922.status === "skipped") {
          this.emitCaptureMetric(startedAt, observation, "skipped");
        } else {
          this.emitCaptureMetric(startedAt, observation, "captured");
        }
        return Result.ok($attemptedResultValue56922);
      }
      if ($attemptedResultError56922.kind === "git-unavailable") {
        this.emitCaptureMetric(startedAt, observation, "skipped");
        return Result.ok<WorkspaceHistoryCaptureResult>({
          status: "skipped",
          reason: "git-unavailable",
        });
      }
      this.emitCaptureMetric(startedAt, observation, "failed");
      if ($attemptedResultError56922.kind === "panic")
        return Result.err($attemptedResultError56922);
      if ($attemptedResultError56922.kind === "persistence")
        return Result.err($attemptedResultError56922);
      return failWith(labelStoreError($attemptedResultError56922, "capture workspace"));
    })();
  }

  private captureLockedAttempt(
    observation: CaptureMetricObservation,
  ): Promise<WorkspaceHistoryResult<WorkspaceHistoryCaptureResult>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const capability = yield* Result.await(this.capabilityInternal());
      if (capability.status === "unavailable") {
        return Result.ok<WorkspaceHistoryCaptureResult>({
          status: "skipped",
          reason: capability.reason,
        });
      }
      const sourceRepository = yield* Result.await(this.discoverSourceRepository());
      if (!sourceRepository) {
        return Result.ok<WorkspaceHistoryCaptureResult>({
          status: "skipped",
          reason: "non-git-workspace",
        });
      }
      yield* Result.await(this.ensureStore());
      const classified = yield* Result.await(
        this.classifyWorkspaceForCapture(sourceRepository.root),
      );
      observation.candidatePathCount = classified.entries.size + classified.directories.size;
      observation.managedPathCount = classified.managed.size;
      const captured = yield* Result.await(
        this.captureClassifiedWorkspace(classified, observation),
      );
      return Result.ok<WorkspaceHistoryCaptureResult>(captured);
    }, this);
  }

  private captureClassifiedWorkspace(
    classified: ClassifiedWorkspace,
    metric?: CaptureMetricObservation,
  ): Promise<
    WorkspaceHistoryResult<Extract<WorkspaceHistoryCaptureResult, { status: "captured" }>>
  > {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const cacheRead = yield* Result.await(this.readCaptureCache());
      const cache = cacheRead.value;
      const cachedOids = new Set<string>();
      for (const [relativePath, entry] of classified.managed) {
        if (entry.kind === "special") {
          return failOwned({
            code: "workspace-invalid",
            operation: "capture workspace",
            message: `Unsupported managed special file: ${relativePath}`,
          });
        }
        const cached = cache?.entries[relativePath];
        if (cached && sameStat(entry, cached)) cachedOids.add(cached.oid);
      }
      const existingCachedOids = yield* Result.await(this.existingObjects(cachedOids, "blob"));
      const treeEntries: TreeEntry[] = [];
      const nextCacheEntries: Record<string, WorkspaceHistoryCachedEntry> = {};

      for (const relativePath of [...classified.managed.keys()].sort()) {
        const entry = classified.managed.get(relativePath);
        if (!entry) continue;
        if (entry.kind === "special") {
          return failOwned({
            code: "workspace-invalid",
            operation: "capture workspace",
            message: `Unsupported managed special file: ${relativePath}`,
          });
        }
        const cached = cache?.entries[relativePath];
        let oid: string;
        if (cached && sameStat(entry, cached) && existingCachedOids.has(cached.oid)) {
          oid = cached.oid;
        } else if (entry.kind === "symlink") {
          const target = yield* Result.await(
            attemptHost(() => readlink(entry.absolutePath, { encoding: "buffer" })),
          );
          if (metric) metric.payloadBytes += BigInt(target.byteLength);
          oid = yield* Result.await(this.hashBytes(target, true));
        } else {
          this.onCaptureRegularFilePayload?.(relativePath, BigInt(entry.size));
          if (metric) metric.payloadBytes += BigInt(entry.size);
          oid = yield* Result.await(this.hashFile(entry.absolutePath, true));
        }
        treeEntries.push({ relativePath, mode: entry.mode, oid });
        nextCacheEntries[relativePath] = {
          kind: entry.kind,
          mode: entry.mode,
          oid,
          size: entry.size,
          mtimeNs: entry.mtimeNs,
          ctimeNs: entry.ctimeNs,
          dev: entry.dev,
          ino: entry.ino,
        };
      }

      yield* this.validateTargetPathSet(
        new Map(treeEntries.map((entry) => [entry.relativePath, entry])),
      );

      const workspaceTreeOid = yield* Result.await(this.writeCaptureTree(treeEntries, cache));
      const manifestBytes = canonicalJson({
        formatVersion: FORMAT_VERSION,
        implementationVersion: IMPLEMENTATION_VERSION,
        managedRoot: ".",
        emptyDirectories: "excluded",
        platform: this.platform,
        pathComparison: this.pathComparison,
      });
      const manifestBlobOid = yield* Result.await(this.hashBytes(manifestBytes, true));
      const rootTreeOid = yield* Result.await(
        this.writeWrapperTree(workspaceTreeOid, manifestBlobOid),
      );
      yield* Result.await(this.requireObject(rootTreeOid, "tree", "verify captured wrapper tree"));
      const gitRef = this.snapshotRef(rootTreeOid);
      const refs = yield* Result.await(this.listSnapshotRefsUnlocked());
      const existingRefTarget = refs.get(gitRef);
      if (metric) metric.changed = existingRefTarget !== rootTreeOid;
      if (existingRefTarget === rootTreeOid) {
        yield* Result.await(this.ensureSnapshotRefCreationMetadata(rootTreeOid, gitRef, true));
      } else {
        yield* Result.await(this.ensureSnapshotRefCreationMetadata(rootTreeOid, gitRef, false));
        yield* Result.await(
          attemptHost(async () => await this.afterSnapshotRefMetadataWriteBeforeRef?.(rootTreeOid)),
        );
        yield* Result.await(
          this.runPrivateGit(["update-ref", gitRef, rootTreeOid], {
            operation: "root captured snapshot",
          }),
        );
        yield* Result.await(
          attemptHost(async () => await this.afterSnapshotRefPublication?.(rootTreeOid)),
        );
      }
      yield* Result.await(
        this.writeCaptureCache({
          implementationVersion: IMPLEMENTATION_VERSION,
          indexVersion: 1,
          workspaceId: this.workspaceId,
          canonicalCwd: this.cwd,
          pathComparison: this.pathComparison,
          workspaceTreeOid,
          entries: nextCacheEntries,
        }),
      );
      return Result.ok({
        status: "captured" as const,
        workspaceId: this.workspaceId,
        rootTreeOid,
        workspaceTreeOid,
        manifestBlobOid,
        gitRef,
        formatVersion: FORMAT_VERSION,
        managedPathCount: treeEntries.length,
      });
    }, this);
  }

  private reconcileCaptureStateAfterRestore(
    snapshot: ParsedSnapshot,
    verifiedTargetEntries: ReadonlyMap<string, ScannedEntry>,
  ): Promise<WorkspaceHistoryResult<void>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const classified = yield* Result.await(this.classifyWorkspace());
      const cacheRead = yield* Result.await(this.readCaptureCache());
      const cache = cacheRead.value;
      const treeEntries: TreeEntry[] = [];
      const nextCacheEntries: Record<string, WorkspaceHistoryCachedEntry> = {};
      for (const relativePath of [...classified.managed.keys()].sort()) {
        const classifiedEntry = classified.managed.get(relativePath);
        if (!classifiedEntry) continue;
        const before = yield* Result.await(
          this.readLiveEntry(relativePath, classifiedEntry.absolutePath),
        );
        if (!before || !sameScannedFingerprint(classifiedEntry, before)) {
          return failWith(
            this.restoreConflict(
              `Managed path changed before post-restore cache reconciliation: ${relativePath}`,
            ),
          );
        }
        if (before.kind === "special") {
          return failOwned({
            code: "workspace-invalid",
            operation: "reconcile post-restore capture state",
            message: `Unsupported managed special file: ${relativePath}`,
          });
        }
        const target = snapshot.entries.get(relativePath);
        const verifiedTarget = target ? verifiedTargetEntries.get(relativePath) : undefined;
        if (target && (!verifiedTarget || !sameScannedFingerprint(verifiedTarget, before))) {
          return failWith(
            this.restoreConflict(`Target path changed after final verification: ${relativePath}`),
          );
        }
        let oid: string;
        if (before.kind === "symlink") {
          const linkTarget = yield* Result.await(
            attemptHost(() => readlink(before.absolutePath, { encoding: "buffer" })),
          );
          oid = yield* Result.await(this.hashBytes(linkTarget, target === undefined));
        } else {
          if (!target) {
            this.onCaptureRegularFilePayload?.(relativePath, BigInt(before.size));
          }
          oid = yield* Result.await(this.hashFile(before.absolutePath, target === undefined));
        }
        const after = yield* Result.await(this.readLiveEntry(relativePath, before.absolutePath));
        if (!after || !sameScannedFingerprint(before, after)) {
          return failWith(
            this.restoreConflict(
              `Managed path changed during post-restore cache reconciliation: ${relativePath}`,
            ),
          );
        }
        if (after.kind === "special") {
          return failWith(
            this.restoreConflict(
              `Managed path became a special file during cache reconciliation: ${relativePath}`,
            ),
          );
        }
        if (target && (after.mode !== target.mode || oid !== target.oid)) {
          return failWith(
            this.verificationError(
              `Target path changed before post-restore cache reconciliation: ${relativePath}`,
            ),
          );
        }
        treeEntries.push({ relativePath, mode: after.mode, oid });
        nextCacheEntries[relativePath] = {
          kind: after.kind,
          mode: after.mode,
          oid,
          size: after.size,
          mtimeNs: after.mtimeNs,
          ctimeNs: after.ctimeNs,
          dev: after.dev,
          ino: after.ino,
        };
      }
      yield* this.validateTargetPathSet(
        new Map(treeEntries.map((entry) => [entry.relativePath, entry])),
      );
      const workspaceTreeOid = yield* Result.await(this.writeCaptureTree(treeEntries, cache));
      yield* Result.await(
        this.writeCaptureCache({
          implementationVersion: IMPLEMENTATION_VERSION,
          indexVersion: 1,
          workspaceId: this.workspaceId,
          canonicalCwd: this.cwd,
          pathComparison: this.pathComparison,
          workspaceTreeOid,
          entries: nextCacheEntries,
        }),
      );
      return Result.ok(undefined);
    }, this);
  }

  async restore(
    rootTreeOid: string,
    expectedCurrent?: WorkspaceHistoryExpectedCurrent,
  ): Promise<WorkspaceHistoryRestoreResult> {
    return await this.withWorkspaceLock(async (lockedStore) => {
      const prepared = await lockedStore.prepareRestore(rootTreeOid, expectedCurrent);
      if (prepared.status === "skipped") return prepared;
      return await prepared.plan.apply();
    });
  }

  async restoreResult(
    rootTreeOid: string,
    expectedCurrent?: WorkspaceHistoryExpectedCurrent,
  ): Promise<ResultType<WorkspaceHistoryRestoreResult, WorkspaceHistoryStoreError>> {
    if (this.restore !== WorkspaceHistoryStore.prototype.restore) {
      return await this.callThrowingOverride(
        async () => await this.restore(rootTreeOid, expectedCurrent),
        "restore workspace",
      );
    }
    const outcome = await this.withWorkspaceLockOutcome(async (lockedStore) => {
      const prepared = await lockedStore.prepareRestore(rootTreeOid, expectedCurrent);
      if (prepared.status === "skipped") return prepared;
      return await prepared.plan.apply();
    });
    return this.publicResult<WorkspaceHistoryRestoreResult>(outcome, "restore workspace");
  }

  async resumeRestore(
    input: WorkspaceHistoryResumeRestoreInput,
  ): Promise<WorkspaceHistoryRestoreResult> {
    return await this.withWorkspaceLock(
      async (lockedStore) => await this.resumeLocked(lockedStore, input),
    );
  }

  async resumeRestoreResult(
    input: WorkspaceHistoryResumeRestoreInput,
  ): Promise<ResultType<WorkspaceHistoryRestoreResult, WorkspaceHistoryStoreError>> {
    if (this.resumeRestore !== WorkspaceHistoryStore.prototype.resumeRestore) {
      return await this.callThrowingOverride(
        async () => await this.resumeRestore(input),
        "resume prepared workspace restore",
      );
    }
    const outcome = await this.withWorkspaceLockOutcome(
      async (lockedStore) => await this.resumeLocked(lockedStore, input),
    );
    return this.publicResult<WorkspaceHistoryRestoreResult>(
      outcome,
      "resume prepared workspace restore",
    );
  }

  private async resumeLocked(
    lockedStore: LockedWorkspaceHistoryStore,
    input: WorkspaceHistoryResumeRestoreInput,
  ): Promise<WorkspaceHistoryRestoreResult> {
    if (!lockedStore.resumePreparedRestore) {
      return await Promise.reject(
        new WorkspaceHistoryStoreError({
          code: "workspace-invalid",
          operation: "resume prepared workspace restore",
          message: "Locked workspace store does not support durable restore resumption",
        }),
      );
    }
    const prepared = await lockedStore.resumePreparedRestore(input);
    if (prepared.status === "skipped") return prepared;
    return await prepared.plan.apply();
  }

  /** Projects a supervised lock outcome onto a public `Result` edge. */
  private async publicResult<T>(
    outcome: ResolvedOutcome<T>,
    operation: string,
  ): Promise<ResultType<T, WorkspaceHistoryStoreError>> {
    switch (outcome.status) {
      case "ok":
        return Result.ok(outcome.value);
      case "failed":
        return Result.err(labelStoreError(outcome.failure, operation));
      case "panic":
        return await Promise.reject(outcome.cause);
      case "defect":
        return await outcome.rejection.reject<ResultType<T, WorkspaceHistoryStoreError>>();
    }
  }

  private async publicWorkspaceResult<T>(
    result: WorkspaceHistoryResult<T>,
    operation: string,
  ): Promise<ResultType<T, WorkspaceHistoryStoreError>> {
    let $resultResultValue71833!: import("better-result").InferOk<NonNullable<typeof result>>;
    let $resultResultError71833!: import("better-result").InferErr<NonNullable<typeof result>>;
    const $resultResultOk71833 = Result.match<
      import("better-result").InferOk<NonNullable<typeof result>>,
      import("better-result").InferErr<NonNullable<typeof result>>,
      boolean
    >(result, {
      ok: (value) => {
        $resultResultValue71833 = value;
        return true;
      },
      err: (error) => {
        $resultResultError71833 = error;
        return false;
      },
    });
    if (($resultResultOk71833 ? "ok" : "error") === "ok") return Result.ok($resultResultValue71833);
    if ($resultResultError71833.kind === "panic")
      return await Promise.reject($resultResultError71833.cause);
    return Result.err(labelStoreError($resultResultError71833, operation));
  }

  private async callThrowingOverride<T>(
    effect: () => Promise<T>,
    operation: string,
  ): Promise<ResultType<T, WorkspaceHistoryStoreError>> {
    const attempted = await attemptHost(effect);
    return await this.publicWorkspaceResult(attempted, operation);
  }

  private deleteRestorePlanInternal(operationId: string): Promise<WorkspaceHistoryResult<void>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      yield* this.checkOperationId(operationId, "delete restore plan");
      return await withStoreLock(this.storeDirectory, () =>
        Result.gen(async function* (this: WorkspaceHistoryStore) {
          const owned = yield* Result.await(this.verifyExistingStoreOwnership());
          if (!owned) return Result.ok(undefined);
          const planStats = yield* Result.await(lstatIfExists(this.restorePlanPath(operationId)));
          if (planStats) {
            const manifest = yield* Result.await(this.readRestorePlanManifest(operationId));
            yield* Result.await(this.cleanupRestorePlanStaging(manifest));
          }
          yield* Result.await(
            attemptHost(() => rm(this.restorePlanPath(operationId), { force: true })),
          );
          yield* Result.await(this.fsyncDirectory(this.restorePlanDirectory));
          return Result.ok(undefined);
        }, this),
      );
    }, this);
  }

  async deleteRestorePlan(operationId: string): Promise<void> {
    const deleted = await this.deleteRestorePlanInternal(operationId);
    let $deletedResultError73619!: import("better-result").InferErr<NonNullable<typeof deleted>>;
    const $deletedResultOk73619 = Result.match<
      import("better-result").InferOk<NonNullable<typeof deleted>>,
      import("better-result").InferErr<NonNullable<typeof deleted>>,
      boolean
    >(deleted, {
      ok: () => true,
      err: (error) => {
        $deletedResultError73619 = error;
        return false;
      },
    });
    if (($deletedResultOk73619 ? "ok" : "error") === "error")
      throwFailure($deletedResultError73619);
  }

  async deleteRestorePlanResult(
    operationId: string,
  ): Promise<ResultType<void, WorkspaceHistoryStoreError>> {
    if (this.deleteRestorePlan !== WorkspaceHistoryStore.prototype.deleteRestorePlan) {
      return await this.callThrowingOverride(
        async () => await this.deleteRestorePlan(operationId),
        "delete restore plan",
      );
    }
    const deleted = await this.deleteRestorePlanInternal(operationId);
    return await this.publicWorkspaceResult(deleted, "delete restore plan");
  }

  private cleanupRestorePlansInternal(
    activeOperationIds: readonly string[],
    gracePeriodMs: number,
  ): Promise<WorkspaceHistoryResult<WorkspaceHistoryRestorePlanCleanupResult>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      if (!Number.isFinite(gracePeriodMs) || gracePeriodMs < 0) {
        return failOwned({
          code: "workspace-invalid",
          operation: "clean restore plans",
          message: "Restore-plan cleanup grace period must be a non-negative finite number",
        });
      }
      const active = new Set<string>();
      for (const operationId of activeOperationIds) {
        yield* this.checkOperationId(operationId, "clean restore plans");
        active.add(operationId);
      }
      return await withStoreLock(this.storeDirectory, () =>
        Result.gen(async function* (this: WorkspaceHistoryStore) {
          const owned = yield* Result.await(this.verifyExistingStoreOwnership());
          if (!owned) {
            return Result.ok<WorkspaceHistoryRestorePlanCleanupResult>({
              removedOperationIds: [],
              preservedOperationIds: [],
            });
          }
          const directoryStats = yield* Result.await(lstatIfExists(this.restorePlanDirectory));
          if (!directoryStats || !directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
            return Result.ok<WorkspaceHistoryRestorePlanCleanupResult>({
              removedOperationIds: [],
              preservedOperationIds: [],
            });
          }
          const removedOperationIds: string[] = [];
          const preservedOperationIds: string[] = [];
          const cutoff = this.now() - gracePeriodMs;
          const children = yield* Result.await(
            attemptHost(() => readdir(this.restorePlanDirectory, { withFileTypes: true })),
          );
          for (const child of children) {
            const match = /^([A-Za-z0-9_-]{1,128})\.json$/.exec(child.name);
            if (!match?.[1] || !child.isFile() || child.isSymbolicLink()) continue;
            const operationId = match[1];
            const manifest = yield* Result.await(this.readRestorePlanManifest(operationId));
            if (active.has(operationId) || manifest.createdAtMs >= cutoff) {
              preservedOperationIds.push(operationId);
              continue;
            }
            yield* Result.await(this.cleanupRestorePlanStaging(manifest));
            yield* Result.await(attemptHost(() => rm(this.restorePlanPath(operationId))));
            removedOperationIds.push(operationId);
          }
          if (removedOperationIds.length > 0) {
            yield* Result.await(this.fsyncDirectory(this.restorePlanDirectory));
          }
          return Result.ok<WorkspaceHistoryRestorePlanCleanupResult>({
            removedOperationIds: removedOperationIds.sort(),
            preservedOperationIds: preservedOperationIds.sort(),
          });
        }, this),
      );
    }, this);
  }

  async cleanupRestorePlans(
    activeOperationIds: readonly string[],
    gracePeriodMs: number,
  ): Promise<WorkspaceHistoryRestorePlanCleanupResult> {
    const cleaned = await this.cleanupRestorePlansInternal(activeOperationIds, gracePeriodMs);
    let $cleanedResultValue77426!: import("better-result").InferOk<NonNullable<typeof cleaned>>;
    let $cleanedResultError77426!: import("better-result").InferErr<NonNullable<typeof cleaned>>;
    const $cleanedResultOk77426 = Result.match<
      import("better-result").InferOk<NonNullable<typeof cleaned>>,
      import("better-result").InferErr<NonNullable<typeof cleaned>>,
      boolean
    >(cleaned, {
      ok: (value) => {
        $cleanedResultValue77426 = value;
        return true;
      },
      err: (error) => {
        $cleanedResultError77426 = error;
        return false;
      },
    });
    if (($cleanedResultOk77426 ? "ok" : "error") === "error")
      throwFailure($cleanedResultError77426);
    return $cleanedResultValue77426;
  }

  async cleanupRestorePlansResult(
    activeOperationIds: readonly string[],
    gracePeriodMs: number,
  ): Promise<ResultType<WorkspaceHistoryRestorePlanCleanupResult, WorkspaceHistoryStoreError>> {
    if (this.cleanupRestorePlans !== WorkspaceHistoryStore.prototype.cleanupRestorePlans) {
      return await this.callThrowingOverride(
        async () => await this.cleanupRestorePlans(activeOperationIds, gracePeriodMs),
        "clean restore plans",
      );
    }
    const cleaned = await this.cleanupRestorePlansInternal(activeOperationIds, gracePeriodMs);
    return await this.publicWorkspaceResult(cleaned, "clean restore plans");
  }

  private verifySnapshotInternal(
    rootTreeOid: string,
  ): Promise<WorkspaceHistoryResult<WorkspaceHistoryVerifyResult>> {
    const startedAt = performance.now();
    const counters = { managedPathCount: 0 };
    return (async () => {
      const attempted = await this.verifySnapshotAttempt(rootTreeOid, startedAt, counters);
      let $attemptedResultValue78510!: import("better-result").InferOk<
        NonNullable<typeof attempted>
      >;
      let $attemptedResultError78510!: import("better-result").InferErr<
        NonNullable<typeof attempted>
      >;
      const $attemptedResultOk78510 = Result.match<
        import("better-result").InferOk<NonNullable<typeof attempted>>,
        import("better-result").InferErr<NonNullable<typeof attempted>>,
        boolean
      >(attempted, {
        ok: (value) => {
          $attemptedResultValue78510 = value;
          return true;
        },
        err: (error) => {
          $attemptedResultError78510 = error;
          return false;
        },
      });
      if (($attemptedResultOk78510 ? "ok" : "error") === "ok")
        return Result.ok($attemptedResultValue78510);
      if ($attemptedResultError78510.kind === "panic") return attempted;
      this.emitVerifyMetric(startedAt, counters.managedPathCount, 0n, "failed");
      const failure = labelStoreError($attemptedResultError78510, "verify workspace snapshot");
      this.emitVerificationFailure(startedAt, "verify", counters.managedPathCount, failure);
      return failWith(failure);
    })();
  }

  private verifySnapshotAttempt(
    rootTreeOid: string,
    startedAt: number,
    counters: { managedPathCount: number },
  ): Promise<WorkspaceHistoryResult<WorkspaceHistoryVerifyResult>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const capability = yield* Result.await(this.capabilityInternal());
      if (capability.status === "unavailable") {
        this.emitVerifyMetric(startedAt, 0, 0n, "skipped");
        return Result.ok<WorkspaceHistoryVerifyResult>({
          status: "skipped",
          reason: capability.reason,
        });
      }
      const sourceRepository = yield* Result.await(this.discoverSourceRepository());
      if (!sourceRepository) {
        this.emitVerifyMetric(startedAt, 0, 0n, "skipped");
        return Result.ok<WorkspaceHistoryVerifyResult>({
          status: "skipped",
          reason: "non-git-workspace",
        });
      }
      if (!OID_PATTERN.test(rootTreeOid)) {
        return failOwned({
          code: "snapshot-invalid",
          operation: "verify workspace snapshot",
          message: "Snapshot root is not a valid Git object ID",
        });
      }
      return await withStoreLock(this.storeDirectory, () =>
        Result.gen(async function* (this: WorkspaceHistoryStore) {
          yield* Result.await(this.ensureStore());
          const snapshot = yield* Result.await(this.readSnapshot(rootTreeOid));
          counters.managedPathCount = snapshot.entries.size;
          const verified = yield* Result.await(this.verifyTargetSnapshot(snapshot));
          const payloadBytes = [...verified.values()].reduce(
            (total, entry) => total + BigInt(entry.size),
            0n,
          );
          this.emitVerifyMetric(startedAt, counters.managedPathCount, payloadBytes, "verified");
          return Result.ok<WorkspaceHistoryVerifyResult>({ status: "verified" });
        }, this),
      );
    }, this);
  }

  async verifySnapshot(rootTreeOid: string): Promise<WorkspaceHistoryVerifyResult> {
    const verified = await this.verifySnapshotInternal(rootTreeOid);
    let $verifiedResultValue81055!: import("better-result").InferOk<NonNullable<typeof verified>>;
    let $verifiedResultError81055!: import("better-result").InferErr<NonNullable<typeof verified>>;
    const $verifiedResultOk81055 = Result.match<
      import("better-result").InferOk<NonNullable<typeof verified>>,
      import("better-result").InferErr<NonNullable<typeof verified>>,
      boolean
    >(verified, {
      ok: (value) => {
        $verifiedResultValue81055 = value;
        return true;
      },
      err: (error) => {
        $verifiedResultError81055 = error;
        return false;
      },
    });
    if (($verifiedResultOk81055 ? "ok" : "error") === "error")
      throwFailure($verifiedResultError81055);
    return $verifiedResultValue81055;
  }

  async verifySnapshotResult(
    rootTreeOid: string,
  ): Promise<ResultType<WorkspaceHistoryVerifyResult, WorkspaceHistoryStoreError>> {
    if (this.verifySnapshot !== WorkspaceHistoryStore.prototype.verifySnapshot) {
      return await this.callThrowingOverride(
        async () => await this.verifySnapshot(rootTreeOid),
        "verify workspace snapshot",
      );
    }
    const verified = await this.verifySnapshotInternal(rootTreeOid);
    return await this.publicWorkspaceResult(verified, "verify workspace snapshot");
  }

  private prepareRestoreLocked(
    rootTreeOid: string,
    expectedCurrent: WorkspaceHistoryExpectedCurrent | undefined,
    leaseState: () => WorkspaceHistoryResult<void>,
    preparedPlans: Set<PreparedRestoreData>,
    operationId: string | undefined,
  ): Promise<WorkspaceHistoryResult<WorkspaceHistoryPrepareRestoreResult>> {
    const metricStartedAt = performance.now();
    const counters = { candidatePathCount: 0, managedPathCount: 0, materializedBytes: 0n };
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      if (
        expectedCurrent?.status === "unavailable" &&
        (expectedCurrent.reason === "git-unavailable" ||
          expectedCurrent.reason === "non-git-workspace" ||
          expectedCurrent.reason === "platform-unsupported")
      ) {
        this.emitRestoreMetric(metricStartedAt, 0, 0, 0n, false, "skipped");
        return Result.ok<WorkspaceHistoryPrepareRestoreResult>({
          status: "skipped",
          reason: expectedCurrent.reason,
        });
      }
      const capability = yield* Result.await(this.capabilityInternal());
      if (capability.status === "unavailable") {
        this.emitRestoreMetric(metricStartedAt, 0, 0, 0n, false, "skipped");
        return Result.ok<WorkspaceHistoryPrepareRestoreResult>({
          status: "skipped",
          reason: capability.reason,
        });
      }
      const sourceRepository = yield* Result.await(this.discoverSourceRepository());
      if (!sourceRepository) {
        this.emitRestoreMetric(metricStartedAt, 0, 0, 0n, false, "skipped");
        return Result.ok<WorkspaceHistoryPrepareRestoreResult>({
          status: "skipped",
          reason: "non-git-workspace",
        });
      }
      if (!OID_PATTERN.test(rootTreeOid)) {
        return failOwned({
          code: "snapshot-invalid",
          operation: "prepare workspace restore",
          message: "Snapshot root is not a valid Git object ID",
        });
      }
      if (operationId !== undefined) {
        yield* this.checkOperationId(operationId, "prepare workspace restore");
      }

      const attempted = await this.prepareRestoreAttempt(
        rootTreeOid,
        expectedCurrent,
        leaseState,
        preparedPlans,
        operationId,
        metricStartedAt,
        counters,
      );
      let $attemptedResultValue83857!: import("better-result").InferOk<
        NonNullable<typeof attempted>
      >;
      let $attemptedResultError83857!: import("better-result").InferErr<
        NonNullable<typeof attempted>
      >;
      const $attemptedResultOk83857 = Result.match<
        import("better-result").InferOk<NonNullable<typeof attempted>>,
        import("better-result").InferErr<NonNullable<typeof attempted>>,
        boolean
      >(attempted, {
        ok: (value) => {
          $attemptedResultValue83857 = value;
          return true;
        },
        err: (error) => {
          $attemptedResultError83857 = error;
          return false;
        },
      });
      if (($attemptedResultOk83857 ? "ok" : "error") === "ok")
        return Result.ok($attemptedResultValue83857);
      if ($attemptedResultError83857.kind === "git-unavailable") {
        this.emitRestoreMetric(
          metricStartedAt,
          counters.candidatePathCount,
          counters.managedPathCount,
          counters.materializedBytes,
          false,
          "skipped",
        );
        return Result.ok<WorkspaceHistoryPrepareRestoreResult>({
          status: "skipped",
          reason: "git-unavailable",
        });
      }
      if ($attemptedResultError83857.kind === "panic") return attempted;
      this.emitRestoreMetric(
        metricStartedAt,
        counters.candidatePathCount,
        counters.managedPathCount,
        counters.materializedBytes,
        false,
        "failed",
      );
      const failure = labelStoreError($attemptedResultError83857, "prepare workspace restore");
      this.emitVerificationFailure(metricStartedAt, "restore", counters.managedPathCount, failure);
      return failWith(failure);
    }, this);
  }

  private prepareRestoreAttempt(
    rootTreeOid: string,
    expectedCurrent: WorkspaceHistoryExpectedCurrent | undefined,
    leaseState: () => WorkspaceHistoryResult<void>,
    preparedPlans: Set<PreparedRestoreData>,
    operationId: string | undefined,
    metricStartedAt: number,
    counters: { candidatePathCount: number; managedPathCount: number; materializedBytes: bigint },
  ): Promise<WorkspaceHistoryResult<WorkspaceHistoryPrepareRestoreResult>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      yield* Result.await(this.ensureStore());
      if (expectedCurrent?.status === "unavailable") {
        return failWith(
          this.restoreConflict(
            `Cannot bind restore preflight to unavailable current workspace: ${expectedCurrent.reason}`,
          ),
        );
      }
      const current = yield* Result.await(this.classifyWorkspace());
      counters.candidatePathCount = current.entries.size + current.directories.size;
      const capturedCurrent = yield* Result.await(this.captureClassifiedWorkspace(current));
      if (
        expectedCurrent?.status === "captured" &&
        capturedCurrent.rootTreeOid !== expectedCurrent.rootTreeOid
      ) {
        return failWith(
          this.restoreConflict(
            `Workspace changed since source capture: expected ${expectedCurrent.rootTreeOid}, captured ${capturedCurrent.rootTreeOid}`,
          ),
        );
      }
      yield* Result.await(attemptHost(async () => await this.afterBoundSourceCapture?.()));
      const snapshot = yield* Result.await(this.readSnapshot(rootTreeOid));
      counters.managedPathCount = snapshot.entries.size;
      yield* this.validateTargetPathSet(snapshot.entries);
      const targetBlobOids = new Set([...snapshot.entries.values()].map((entry) => entry.oid));
      const existingTargetBlobs = yield* Result.await(this.existingObjects(targetBlobOids, "blob"));
      if (existingTargetBlobs.size !== targetBlobOids.size) {
        return failOwned({
          code: "snapshot-invalid",
          operation: "preflight workspace restore",
          message: "Snapshot references one or more missing blob objects",
        });
      }
      const preservation = yield* Result.await(this.captureUnmanagedSignatures(current));
      const protectedSignatures = yield* Result.await(this.captureProtectedSignatures());
      yield* Result.await(this.preflightRestore(current, snapshot.entries));
      counters.materializedBytes = yield* Result.await(
        this.preflightDestinationCapabilities(snapshot, (bytes) => {
          counters.materializedBytes = bytes;
        }),
      );
      const liveSignatures = yield* Result.await(this.captureLiveSignatures(current));
      const workspaceIdentity = yield* Result.await(this.workspaceIdentity());
      const finalCurrent = yield* Result.await(this.classifyWorkspace());
      const finalCapture = yield* Result.await(this.captureClassifiedWorkspace(finalCurrent));
      const finalSignatures = yield* Result.await(this.captureLiveSignatures(finalCurrent));
      if (
        finalCapture.rootTreeOid !== capturedCurrent.rootTreeOid ||
        !mapsEqual(finalSignatures, liveSignatures) ||
        !setsEqual(new Set(finalCurrent.managed.keys()), new Set(current.managed.keys())) ||
        !setsEqual(finalCurrent.ignored, current.ignored) ||
        !setsEqual(finalCurrent.boundaryRoots, current.boundaryRoots)
      ) {
        return failWith(
          this.restoreConflict("Workspace changed while restore preparation was running"),
        );
      }
      const { stagingDirectory, stagedEntries } = yield* Result.await(this.stageSnapshot(snapshot));
      if (operationId) {
        const sourceSnapshot = yield* Result.await(this.readSnapshot(capturedCurrent.rootTreeOid));
        const managedSignatures = new Map<string, string>();
        for (const relativePath of current.managed.keys()) {
          const signature = liveSignatures.get(relativePath);
          if (!signature) {
            return failWith(
              this.restoreConflict(
                `Managed signature disappeared before plan freeze: ${relativePath}`,
              ),
            );
          }
          managedSignatures.set(relativePath, signature);
        }
        if (!setsEqual(new Set(sourceSnapshot.entries.keys()), new Set(managedSignatures.keys()))) {
          return failWith(
            this.restoreConflict("Captured source entries do not match frozen managed membership"),
          );
        }
        yield* Result.await(
          this.writeRestorePlanManifest({
            formatVersion: FORMAT_VERSION,
            implementationVersion: IMPLEMENTATION_VERSION,
            operationId,
            workspaceId: this.workspaceId,
            canonicalCwd: this.cwd,
            sourceRootTreeOid: capturedCurrent.rootTreeOid,
            targetRootTreeOid: rootTreeOid,
            workspaceIdentity,
            pathComparison: this.pathComparison,
            platform: this.platform === "darwin" ? "darwin" : "linux",
            createdAtMs: this.now(),
            phase: "prepared",
            privateStagingDirectory: stagingDirectory,
            managedEntries: [...sourceSnapshot.entries.values()].sort((left, right) =>
              left.relativePath.localeCompare(right.relativePath),
            ),
            managedSignatures: this.signatureRecords(managedSignatures),
            ignoredSignatures: this.signatureRecords(preservation),
            protectedSignatures: this.signatureRecords(protectedSignatures),
            boundaryRoots: [...current.boundaryRoots].sort(),
            targetEntries: [...snapshot.entries.values()].sort((left, right) =>
              left.relativePath.localeCompare(right.relativePath),
            ),
          }),
        );
      }
      const data: PreparedRestoreData = {
        snapshot,
        current,
        liveSignatures,
        preservation,
        protectedSignatures,
        stagingDirectory,
        stagedEntries,
        destinationEntries: new Map(),
        replacementRoots: new Map(),
        ownedDirectories: new Map(),
        ownedTemps: new Map(),
        workspaceIdentity,
        operationId,
        recovery: false,
        metricStartedAt,
        candidatePathCount: counters.candidatePathCount,
        managedPathCount: counters.managedPathCount,
        materializedBytes: counters.materializedBytes,
        state: "prepared",
      };
      preparedPlans.add(data);
      return Result.ok<WorkspaceHistoryPrepareRestoreResult>({
        status: "prepared",
        plan: this.preparedPlan(rootTreeOid, operationId, data, leaseState, preparedPlans, () =>
          this.verifyTargetSnapshot(data.snapshot),
        ),
      });
    }, this);
  }

  /**
   * Builds the legacy throwing plan facade over a Result-native prepared restore. Every branch here
   * is an outer API edge: the internal operations it calls already returned typed Results.
   */
  private preparedPlan(
    rootTreeOid: string,
    operationId: string | undefined,
    data: PreparedRestoreData,
    leaseState: () => WorkspaceHistoryResult<void>,
    preparedPlans: Set<PreparedRestoreData>,
    verify: () => Promise<WorkspaceHistoryResult<Map<string, ScannedEntry>>>,
  ): PreparedWorkspaceRestore {
    const requireActive = (): void => {
      const lease = leaseState();
      let $leaseResultError92410!: import("better-result").InferErr<NonNullable<typeof lease>>;
      const $leaseResultOk92410 = Result.match<
        import("better-result").InferOk<NonNullable<typeof lease>>,
        import("better-result").InferErr<NonNullable<typeof lease>>,
        boolean
      >(lease, {
        ok: () => true,
        err: (error) => {
          $leaseResultError92410 = error;
          return false;
        },
      });
      if (($leaseResultOk92410 ? "ok" : "error") === "error") throwFailure($leaseResultError92410);
    };
    return {
      rootTreeOid,
      operationId,
      apply: async () => {
        requireActive();
        const applied = await this.applyPreparedRestore(data);
        let $appliedResultValue92619!: import("better-result").InferOk<NonNullable<typeof applied>>;
        let $appliedResultError92619!: import("better-result").InferErr<
          NonNullable<typeof applied>
        >;
        const $appliedResultOk92619 = Result.match<
          import("better-result").InferOk<NonNullable<typeof applied>>,
          import("better-result").InferErr<NonNullable<typeof applied>>,
          boolean
        >(applied, {
          ok: (value) => {
            $appliedResultValue92619 = value;
            return true;
          },
          err: (error) => {
            $appliedResultError92619 = error;
            return false;
          },
        });
        if (($appliedResultOk92619 ? "ok" : "error") === "error")
          throwFailure($appliedResultError92619);
        preparedPlans.delete(data);
        return $appliedResultValue92619;
      },
      verify: async () => {
        requireActive();
        const verified = await verify();
        let $verifiedResultError92879!: import("better-result").InferErr<
          NonNullable<typeof verified>
        >;
        const $verifiedResultOk92879 = Result.match<
          import("better-result").InferOk<NonNullable<typeof verified>>,
          import("better-result").InferErr<NonNullable<typeof verified>>,
          boolean
        >(verified, {
          ok: () => true,
          err: (error) => {
            $verifiedResultError92879 = error;
            return false;
          },
        });
        if (($verifiedResultOk92879 ? "ok" : "error") === "error")
          throwFailure($verifiedResultError92879);
        return { status: "verified" };
      },
      dispose: async () => {
        requireActive();
        preparedPlans.delete(data);
        const disposed = await this.disposePreparedRestore(data);
        let $disposedResultError93129!: import("better-result").InferErr<
          NonNullable<typeof disposed>
        >;
        const $disposedResultOk93129 = Result.match<
          import("better-result").InferOk<NonNullable<typeof disposed>>,
          import("better-result").InferErr<NonNullable<typeof disposed>>,
          boolean
        >(disposed, {
          ok: () => true,
          err: (error) => {
            $disposedResultError93129 = error;
            return false;
          },
        });
        if (($disposedResultOk93129 ? "ok" : "error") === "error")
          throwFailure($disposedResultError93129);
      },
    };
  }

  private resumePreparedRestoreLocked(
    input: WorkspaceHistoryResumeRestoreInput,
    leaseState: () => WorkspaceHistoryResult<void>,
    preparedPlans: Set<PreparedRestoreData>,
  ): Promise<WorkspaceHistoryResult<WorkspaceHistoryPrepareRestoreResult>> {
    const metricStartedAt = performance.now();
    const counters = { materializedBytes: 0n };
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      yield* this.checkOperationId(input.operationId, "resume prepared workspace restore");
      if (
        !OID_PATTERN.test(input.targetRootTreeOid) ||
        !OID_PATTERN.test(input.sourceRootTreeOid)
      ) {
        return failOwned({
          code: "snapshot-invalid",
          operation: "resume prepared workspace restore",
          message: "Expected source and target roots must be valid Git object IDs",
        });
      }
      const capability = yield* Result.await(this.capabilityInternal());
      if (capability.status === "unavailable") {
        this.emitRestoreMetric(metricStartedAt, 0, 0, 0n, false, "skipped");
        return Result.ok<WorkspaceHistoryPrepareRestoreResult>({
          status: "skipped",
          reason: capability.reason,
        });
      }
      const sourceRepository = yield* Result.await(this.discoverSourceRepository());
      if (!sourceRepository) {
        this.emitRestoreMetric(metricStartedAt, 0, 0, 0n, false, "skipped");
        return Result.ok<WorkspaceHistoryPrepareRestoreResult>({
          status: "skipped",
          reason: "non-git-workspace",
        });
      }
      const attempted = await this.resumePreparedRestoreAttempt(
        input,
        leaseState,
        preparedPlans,
        metricStartedAt,
        counters,
      );
      let $attemptedResultValue94849!: import("better-result").InferOk<
        NonNullable<typeof attempted>
      >;
      let $attemptedResultError94849!: import("better-result").InferErr<
        NonNullable<typeof attempted>
      >;
      const $attemptedResultOk94849 = Result.match<
        import("better-result").InferOk<NonNullable<typeof attempted>>,
        import("better-result").InferErr<NonNullable<typeof attempted>>,
        boolean
      >(attempted, {
        ok: (value) => {
          $attemptedResultValue94849 = value;
          return true;
        },
        err: (error) => {
          $attemptedResultError94849 = error;
          return false;
        },
      });
      if (($attemptedResultOk94849 ? "ok" : "error") === "ok")
        return Result.ok($attemptedResultValue94849);
      if ($attemptedResultError94849.kind === "git-unavailable") {
        this.emitRestoreMetric(metricStartedAt, 0, 0, counters.materializedBytes, false, "skipped");
        return Result.ok<WorkspaceHistoryPrepareRestoreResult>({
          status: "skipped",
          reason: "git-unavailable",
        });
      }
      if ($attemptedResultError94849.kind === "panic") return attempted;
      this.emitRestoreMetric(metricStartedAt, 0, 0, counters.materializedBytes, false, "failed");
      const failure = labelStoreError(
        $attemptedResultError94849,
        "resume prepared workspace restore",
      );
      this.emitVerificationFailure(metricStartedAt, "restore", 0, failure);
      return failWith(failure);
    }, this);
  }

  private resumePreparedRestoreAttempt(
    input: WorkspaceHistoryResumeRestoreInput,
    leaseState: () => WorkspaceHistoryResult<void>,
    preparedPlans: Set<PreparedRestoreData>,
    metricStartedAt: number,
    counters: { materializedBytes: bigint },
  ): Promise<WorkspaceHistoryResult<WorkspaceHistoryPrepareRestoreResult>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      yield* Result.await(this.ensureStore());
      let manifest = yield* Result.await(this.readRestorePlanManifest(input.operationId));
      if (
        manifest.sourceRootTreeOid !== input.sourceRootTreeOid ||
        manifest.targetRootTreeOid !== input.targetRootTreeOid
      ) {
        return failWith(
          this.restoreConflict("Durable restore plan does not match expected source and target"),
        );
      }
      const identity = yield* Result.await(this.workspaceIdentity());
      if (identity !== manifest.workspaceIdentity) {
        return failWith(
          this.restoreConflict("Workspace root identity changed since restore preparation"),
        );
      }
      const source = yield* Result.await(this.readSnapshot(input.sourceRootTreeOid));
      const snapshot = yield* Result.await(this.readSnapshot(input.targetRootTreeOid));
      if (
        !treeEntryArraysEqual([...source.entries.values()], manifest.managedEntries) ||
        !treeEntryArraysEqual([...snapshot.entries.values()], manifest.targetEntries)
      ) {
        return failOwned({
          code: "snapshot-invalid",
          operation: "resume prepared workspace restore",
          message: "Durable restore plan entries no longer match private snapshot objects",
        });
      }
      if (manifest.phase === "prepared") {
        yield* Result.await(this.assertFrozenSourceIntact(manifest));
      }
      counters.materializedBytes = yield* Result.await(
        this.preflightDestinationCapabilities(snapshot, (bytes) => {
          counters.materializedBytes = bytes;
        }),
      );
      if (manifest.phase === "prepared") {
        const refreshed = yield* Result.await(this.captureProtectedSignatures());
        manifest = {
          ...manifest,
          phase: "mutation-ready",
          protectedSignatures: this.signatureRecords(refreshed),
        };
        yield* Result.await(this.writeRestorePlanManifest(manifest));
      }
      const managedSignatures = yield* this.signatureMap(manifest.managedSignatures);
      const managed = new Map<string, ScannedEntry>();
      for (const entry of manifest.managedEntries) {
        managed.set(entry.relativePath, this.frozenScannedEntry(entry));
      }
      if (!setsEqual(new Set(managed.keys()), new Set(managedSignatures.keys()))) {
        return failOwned({
          code: "snapshot-invalid",
          operation: "resume prepared workspace restore",
          message: "Durable restore plan has inconsistent managed membership",
        });
      }
      const ignoredSignatures = yield* this.signatureMap(manifest.ignoredSignatures);
      const protectedSignatures = yield* this.signatureMap(manifest.protectedSignatures);
      const current: ClassifiedWorkspace = {
        entries: new Map(managed),
        managed,
        directories: new Set(),
        ignored: new Set(manifest.ignoredSignatures.map((entry) => entry.relativePath)),
        ignoredDirectories: new Set(),
        boundaryRoots: new Set(manifest.boundaryRoots),
      };
      yield* Result.await(this.cleanupRestorePlanStaging(manifest));
      const { stagingDirectory, stagedEntries } = yield* Result.await(this.stageSnapshot(snapshot));
      if (manifest.privateStagingDirectory !== stagingDirectory) {
        yield* Result.await(
          this.writeRestorePlanManifest({ ...manifest, privateStagingDirectory: stagingDirectory }),
        );
      }
      const data: PreparedRestoreData = {
        snapshot,
        current,
        liveSignatures: new Map([...managedSignatures, ...ignoredSignatures]),
        preservation: ignoredSignatures,
        protectedSignatures,
        stagingDirectory,
        stagedEntries,
        destinationEntries: new Map(),
        replacementRoots: new Map(),
        ownedDirectories: new Map(),
        ownedTemps: new Map(),
        workspaceIdentity: manifest.workspaceIdentity,
        operationId: manifest.operationId,
        recovery: true,
        metricStartedAt,
        candidatePathCount: current.entries.size + current.directories.size,
        managedPathCount: snapshot.entries.size,
        materializedBytes: counters.materializedBytes,
        state: "prepared",
      };
      preparedPlans.add(data);
      return Result.ok<WorkspaceHistoryPrepareRestoreResult>({
        status: "prepared",
        plan: this.preparedPlan(
          snapshot.rootTreeOid,
          manifest.operationId,
          data,
          leaseState,
          preparedPlans,
          () => this.verifyFrozenRestoredSnapshot(data),
        ),
      });
    }, this);
  }

  private objectExistsInternal(
    oid: string,
    type: "blob" | "tree" | "object",
  ): Promise<WorkspaceHistoryResult<boolean>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      if (!OID_PATTERN.test(oid)) return Result.ok(false);
      const capability = yield* Result.await(this.capabilityInternal());
      if (capability.status === "unavailable") {
        return failOwned({
          code: capability.reason,
          operation: "check private object",
          message: `Cannot check private object: ${capability.reason}`,
        });
      }
      const existence = await withStoreLock(this.storeDirectory, () =>
        Result.gen(async function* (this: WorkspaceHistoryStore) {
          yield* Result.await(this.ensureStore());
          const exists = yield* Result.await(this.objectExistsUnlocked(oid, type));
          return Result.ok(exists);
        }, this),
      );
      let $existenceResultError101362!: import("better-result").InferErr<
        NonNullable<typeof existence>
      >;
      const $existenceResultOk101362 = Result.match<
        import("better-result").InferOk<NonNullable<typeof existence>>,
        import("better-result").InferErr<NonNullable<typeof existence>>,
        boolean
      >(existence, {
        ok: () => true,
        err: (error) => {
          $existenceResultError101362 = error;
          return false;
        },
      });
      if (
        ($existenceResultOk101362 ? "ok" : "error") === "error" &&
        $existenceResultError101362.kind === "git-unavailable"
      ) {
        return failOwned({
          code: "git-unavailable",
          operation: "check private object",
          message: "Git became unavailable while checking private object",
          cause: $existenceResultError101362.signal,
        });
      }
      return existence;
    }, this);
  }

  async objectExists(oid: string, type: "blob" | "tree" | "object" = "object"): Promise<boolean> {
    const exists = await this.objectExistsInternal(oid, type);
    let $existsResultValue102169!: import("better-result").InferOk<NonNullable<typeof exists>>;
    let $existsResultError102169!: import("better-result").InferErr<NonNullable<typeof exists>>;
    const $existsResultOk102169 = Result.match<
      import("better-result").InferOk<NonNullable<typeof exists>>,
      import("better-result").InferErr<NonNullable<typeof exists>>,
      boolean
    >(exists, {
      ok: (value) => {
        $existsResultValue102169 = value;
        return true;
      },
      err: (error) => {
        $existsResultError102169 = error;
        return false;
      },
    });
    if (($existsResultOk102169 ? "ok" : "error") === "error")
      throwFailure($existsResultError102169);
    return $existsResultValue102169;
  }

  async objectExistsResult(
    oid: string,
    type: "blob" | "tree" | "object" = "object",
  ): Promise<ResultType<boolean, WorkspaceHistoryStoreError>> {
    if (this.objectExists !== WorkspaceHistoryStore.prototype.objectExists) {
      return await this.callThrowingOverride(
        async () => await this.objectExists(oid, type),
        "check private object",
      );
    }
    const exists = await this.objectExistsInternal(oid, type);
    return await this.publicWorkspaceResult(exists, "check private object");
  }

  private reconcileSnapshotRefInternal(
    rootTreeOid: string,
  ): Promise<
    WorkspaceHistoryResult<
      "present" | "repaired" | "missing" | "corrupt" | "git-unavailable" | "platform-unsupported"
    >
  > {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      if (!OID_PATTERN.test(rootTreeOid)) return Result.ok("missing" as const);
      const reconciliation = yield* Result.await(
        this.reconcileExpectedSnapshotRefsInternal([rootTreeOid]),
      );
      if (reconciliation.status === "unavailable") return Result.ok(reconciliation.reason);
      return Result.ok(reconciliation.expected[0]?.status ?? "missing");
    }, this);
  }

  async reconcileSnapshotRef(
    rootTreeOid: string,
  ): Promise<
    "present" | "repaired" | "missing" | "corrupt" | "git-unavailable" | "platform-unsupported"
  > {
    const reconciled = await this.reconcileSnapshotRefInternal(rootTreeOid);
    let $reconciledResultValue103703!: import("better-result").InferOk<
      NonNullable<typeof reconciled>
    >;
    let $reconciledResultError103703!: import("better-result").InferErr<
      NonNullable<typeof reconciled>
    >;
    const $reconciledResultOk103703 = Result.match<
      import("better-result").InferOk<NonNullable<typeof reconciled>>,
      import("better-result").InferErr<NonNullable<typeof reconciled>>,
      boolean
    >(reconciled, {
      ok: (value) => {
        $reconciledResultValue103703 = value;
        return true;
      },
      err: (error) => {
        $reconciledResultError103703 = error;
        return false;
      },
    });
    if (($reconciledResultOk103703 ? "ok" : "error") === "error")
      throwFailure($reconciledResultError103703);
    return $reconciledResultValue103703;
  }

  async reconcileSnapshotRefResult(
    rootTreeOid: string,
  ): Promise<
    ResultType<
      "present" | "repaired" | "missing" | "corrupt" | "git-unavailable" | "platform-unsupported",
      WorkspaceHistoryStoreError
    >
  > {
    if (this.reconcileSnapshotRef !== WorkspaceHistoryStore.prototype.reconcileSnapshotRef) {
      return await this.callThrowingOverride(
        async () => await this.reconcileSnapshotRef(rootTreeOid),
        "reconcile snapshot ref",
      );
    }
    const reconciled = await this.reconcileSnapshotRefInternal(rootTreeOid);
    return await this.publicWorkspaceResult(reconciled, "reconcile snapshot ref");
  }

  private reconcileExpectedSnapshotRefsInternal(
    expectedRootTreeOids: readonly string[],
  ): Promise<WorkspaceHistoryResult<WorkspaceHistoryRefReconciliation>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const uniqueExpected = yield* this.checkExpectedRootTreeOids(expectedRootTreeOids);
      const reconciled = await withStoreLock(this.storeDirectory, () =>
        Result.gen(async function* (this: WorkspaceHistoryStore) {
          const owned = yield* Result.await(this.verifyExistingStoreOwnership());
          if (!owned) {
            return Result.ok<WorkspaceHistoryRefReconciliation>(
              this.missingReconciliation(uniqueExpected),
            );
          }
          const capability = yield* Result.await(this.capabilityInternal());
          if (capability.status === "unavailable") {
            return Result.ok<WorkspaceHistoryRefReconciliation>(capability);
          }
          const result = yield* Result.await(
            this.reconcileExpectedSnapshotRefsUnlocked(uniqueExpected),
          );
          return Result.ok<WorkspaceHistoryRefReconciliation>(result);
        }, this),
      );
      let $reconciledResultError104870!: import("better-result").InferErr<
        NonNullable<typeof reconciled>
      >;
      const $reconciledResultOk104870 = Result.match<
        import("better-result").InferOk<NonNullable<typeof reconciled>>,
        import("better-result").InferErr<NonNullable<typeof reconciled>>,
        boolean
      >(reconciled, {
        ok: () => true,
        err: (error) => {
          $reconciledResultError104870 = error;
          return false;
        },
      });
      if (
        ($reconciledResultOk104870 ? "ok" : "error") === "error" &&
        $reconciledResultError104870.kind === "git-unavailable"
      ) {
        return Result.ok<WorkspaceHistoryRefReconciliation>({
          status: "unavailable",
          reason: "git-unavailable",
        });
      }
      return reconciled;
    }, this);
  }

  async reconcileExpectedSnapshotRefs(
    expectedRootTreeOids: readonly string[],
  ): Promise<WorkspaceHistoryRefReconciliation> {
    const reconciled = await this.reconcileExpectedSnapshotRefsInternal(expectedRootTreeOids);
    let $reconciledResultValue106131!: import("better-result").InferOk<
      NonNullable<typeof reconciled>
    >;
    let $reconciledResultError106131!: import("better-result").InferErr<
      NonNullable<typeof reconciled>
    >;
    const $reconciledResultOk106131 = Result.match<
      import("better-result").InferOk<NonNullable<typeof reconciled>>,
      import("better-result").InferErr<NonNullable<typeof reconciled>>,
      boolean
    >(reconciled, {
      ok: (value) => {
        $reconciledResultValue106131 = value;
        return true;
      },
      err: (error) => {
        $reconciledResultError106131 = error;
        return false;
      },
    });
    if (($reconciledResultOk106131 ? "ok" : "error") === "error")
      throwFailure($reconciledResultError106131);
    return $reconciledResultValue106131;
  }

  async reconcileExpectedSnapshotRefsResult(
    expectedRootTreeOids: readonly string[],
  ): Promise<ResultType<WorkspaceHistoryRefReconciliation, WorkspaceHistoryStoreError>> {
    if (
      this.reconcileExpectedSnapshotRefs !==
      WorkspaceHistoryStore.prototype.reconcileExpectedSnapshotRefs
    ) {
      return await this.callThrowingOverride(
        async () => await this.reconcileExpectedSnapshotRefs(expectedRootTreeOids),
        "reconcile expected snapshot refs",
      );
    }
    const reconciled = await this.reconcileExpectedSnapshotRefsInternal(expectedRootTreeOids);
    return await this.publicWorkspaceResult(reconciled, "reconcile expected snapshot refs");
  }

  private cleanupOrphanSnapshotRefsInternal(
    expectedRootTreeOids: readonly string[],
    gracePeriodMs: number,
  ): Promise<WorkspaceHistoryResult<WorkspaceHistoryOrphanCleanupResult>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      if (!Number.isFinite(gracePeriodMs) || gracePeriodMs < 0) {
        return failOwned({
          code: "workspace-invalid",
          operation: "clean orphan snapshot refs",
          message: "Snapshot-ref cleanup grace period must be a non-negative finite number",
        });
      }
      const uniqueExpected = yield* this.checkExpectedRootTreeOids(expectedRootTreeOids);
      const cleaned = await withStoreLock(this.storeDirectory, () =>
        Result.gen(async function* (this: WorkspaceHistoryStore) {
          const owned = yield* Result.await(this.verifyExistingStoreOwnership());
          if (!owned) {
            return Result.ok<WorkspaceHistoryOrphanCleanupResult>({
              status: "cleaned",
              expected: [...uniqueExpected].map((rootTreeOid) => ({
                rootTreeOid,
                gitRef: this.snapshotRef(rootTreeOid),
                status: "missing" as const,
              })),
              removedOrphanRefs: [],
              preservedOrphanRefs: [],
            });
          }
          const capability = yield* Result.await(this.capabilityInternal());
          if (capability.status === "unavailable") {
            return Result.ok<WorkspaceHistoryOrphanCleanupResult>(capability);
          }
          const result = yield* Result.await(
            this.cleanupOrphanSnapshotRefsUnlocked(uniqueExpected, gracePeriodMs),
          );
          return Result.ok<WorkspaceHistoryOrphanCleanupResult>(result);
        }, this),
      );
      let $cleanedResultError107672!: import("better-result").InferErr<NonNullable<typeof cleaned>>;
      const $cleanedResultOk107672 = Result.match<
        import("better-result").InferOk<NonNullable<typeof cleaned>>,
        import("better-result").InferErr<NonNullable<typeof cleaned>>,
        boolean
      >(cleaned, {
        ok: () => true,
        err: (error) => {
          $cleanedResultError107672 = error;
          return false;
        },
      });
      if (
        ($cleanedResultOk107672 ? "ok" : "error") === "error" &&
        $cleanedResultError107672.kind === "git-unavailable"
      ) {
        return Result.ok<WorkspaceHistoryOrphanCleanupResult>({
          status: "unavailable",
          reason: "git-unavailable",
        });
      }
      return cleaned;
    }, this);
  }

  async cleanupOrphanSnapshotRefs(
    expectedRootTreeOids: readonly string[],
    gracePeriodMs: number,
  ): Promise<WorkspaceHistoryOrphanCleanupResult> {
    const cleaned = await this.cleanupOrphanSnapshotRefsInternal(
      expectedRootTreeOids,
      gracePeriodMs,
    );
    let $cleanedResultValue109233!: import("better-result").InferOk<NonNullable<typeof cleaned>>;
    let $cleanedResultError109233!: import("better-result").InferErr<NonNullable<typeof cleaned>>;
    const $cleanedResultOk109233 = Result.match<
      import("better-result").InferOk<NonNullable<typeof cleaned>>,
      import("better-result").InferErr<NonNullable<typeof cleaned>>,
      boolean
    >(cleaned, {
      ok: (value) => {
        $cleanedResultValue109233 = value;
        return true;
      },
      err: (error) => {
        $cleanedResultError109233 = error;
        return false;
      },
    });
    if (($cleanedResultOk109233 ? "ok" : "error") === "error")
      throwFailure($cleanedResultError109233);
    return $cleanedResultValue109233;
  }

  async cleanupOrphanSnapshotRefsResult(
    expectedRootTreeOids: readonly string[],
    gracePeriodMs: number,
  ): Promise<ResultType<WorkspaceHistoryOrphanCleanupResult, WorkspaceHistoryStoreError>> {
    if (
      this.cleanupOrphanSnapshotRefs !== WorkspaceHistoryStore.prototype.cleanupOrphanSnapshotRefs
    ) {
      return await this.callThrowingOverride(
        async () => await this.cleanupOrphanSnapshotRefs(expectedRootTreeOids, gracePeriodMs),
        "clean orphan snapshot refs",
      );
    }
    const cleaned = await this.cleanupOrphanSnapshotRefsInternal(
      expectedRootTreeOids,
      gracePeriodMs,
    );
    return await this.publicWorkspaceResult(cleaned, "clean orphan snapshot refs");
  }

  private getObjectAccountingInternal(): Promise<
    WorkspaceHistoryResult<WorkspaceHistoryObjectAccountingResult>
  > {
    return (async () => {
      const accounted = await withStoreLock(this.storeDirectory, () =>
        Result.gen(async function* (this: WorkspaceHistoryStore) {
          const owned = yield* Result.await(this.verifyExistingStoreOwnership());
          if (!owned) {
            return Result.ok<WorkspaceHistoryObjectAccountingResult>({
              status: "missing",
              accounting: EMPTY_OBJECT_ACCOUNTING,
            });
          }
          const capability = yield* Result.await(this.capabilityInternal());
          if (capability.status === "unavailable") {
            return Result.ok<WorkspaceHistoryObjectAccountingResult>(capability);
          }
          yield* Result.await(this.verifyNoAlternates());
          const accounting = yield* Result.await(this.getObjectAccountingUnlocked());
          return Result.ok<WorkspaceHistoryObjectAccountingResult>({
            status: "accounted",
            accounting,
          });
        }, this),
      );
      let $accountedResultError110328!: import("better-result").InferErr<
        NonNullable<typeof accounted>
      >;
      const $accountedResultOk110328 = Result.match<
        import("better-result").InferOk<NonNullable<typeof accounted>>,
        import("better-result").InferErr<NonNullable<typeof accounted>>,
        boolean
      >(accounted, {
        ok: () => true,
        err: (error) => {
          $accountedResultError110328 = error;
          return false;
        },
      });
      if (
        ($accountedResultOk110328 ? "ok" : "error") === "error" &&
        $accountedResultError110328.kind === "git-unavailable"
      ) {
        return Result.ok<WorkspaceHistoryObjectAccountingResult>({
          status: "unavailable",
          reason: "git-unavailable",
        });
      }
      return accounted;
    })();
  }

  async getObjectAccounting(): Promise<WorkspaceHistoryObjectAccountingResult> {
    const accounted = await this.getObjectAccountingInternal();
    let $accountedResultValue111653!: import("better-result").InferOk<
      NonNullable<typeof accounted>
    >;
    let $accountedResultError111653!: import("better-result").InferErr<
      NonNullable<typeof accounted>
    >;
    const $accountedResultOk111653 = Result.match<
      import("better-result").InferOk<NonNullable<typeof accounted>>,
      import("better-result").InferErr<NonNullable<typeof accounted>>,
      boolean
    >(accounted, {
      ok: (value) => {
        $accountedResultValue111653 = value;
        return true;
      },
      err: (error) => {
        $accountedResultError111653 = error;
        return false;
      },
    });
    if (($accountedResultOk111653 ? "ok" : "error") === "error")
      throwFailure($accountedResultError111653);
    return $accountedResultValue111653;
  }

  async getObjectAccountingResult(): Promise<
    ResultType<WorkspaceHistoryObjectAccountingResult, WorkspaceHistoryStoreError>
  > {
    if (this.getObjectAccounting !== WorkspaceHistoryStore.prototype.getObjectAccounting) {
      return await this.callThrowingOverride(
        async () => await this.getObjectAccounting(),
        "account private Git objects",
      );
    }
    const accounted = await this.getObjectAccountingInternal();
    return await this.publicWorkspaceResult(accounted, "account private Git objects");
  }

  private runMaintenanceInternal(
    options: WorkspaceHistoryMaintenanceOptions,
  ): Promise<WorkspaceHistoryResult<WorkspaceHistoryMaintenanceResult>> {
    const startedAt = performance.now();
    const counters = {
      expectedCount: 0,
      removedOrphanRefs: [] as string[],
      preservedOrphanRefs: [] as string[],
    };
    return (async () => {
      if (!Number.isFinite(options.orphanGracePeriodMs) || options.orphanGracePeriodMs < 0) {
        return failOwned({
          code: "workspace-invalid",
          operation: "maintain private Git store",
          message: "Maintenance orphan grace period must be a non-negative finite number",
        });
      }
      const maintained = await withStoreLock(this.storeDirectory, () =>
        this.runMaintenanceLocked(options, startedAt, counters),
      );
      let $maintainedResultValue113040!: import("better-result").InferOk<
        NonNullable<typeof maintained>
      >;
      let $maintainedResultError113040!: import("better-result").InferErr<
        NonNullable<typeof maintained>
      >;
      const $maintainedResultOk113040 = Result.match<
        import("better-result").InferOk<NonNullable<typeof maintained>>,
        import("better-result").InferErr<NonNullable<typeof maintained>>,
        boolean
      >(maintained, {
        ok: (value) => {
          $maintainedResultValue113040 = value;
          return true;
        },
        err: (error) => {
          $maintainedResultError113040 = error;
          return false;
        },
      });
      if (($maintainedResultOk113040 ? "ok" : "error") === "ok")
        return Result.ok($maintainedResultValue113040);
      if ($maintainedResultError113040.kind === "git-unavailable") {
        const unavailable = {
          status: "unavailable" as const,
          reason: "git-unavailable" as const,
        };
        this.emitMaintenanceMetric(startedAt, unavailable);
        return Result.ok<WorkspaceHistoryMaintenanceResult>(unavailable);
      }
      if ($maintainedResultError113040.kind === "panic") return maintained;
      this.emitMetric({
        type: "maintenance",
        workspaceId: this.workspaceId,
        outcome: "failed",
        durationMs: performance.now() - startedAt,
        candidatePathCount: 0,
        managedPathCount: counters.expectedCount,
        payloadBytes: 0n,
        removedOrphanRefCount: counters.removedOrphanRefs.length,
        preservedOrphanRefCount: counters.preservedOrphanRefs.length,
      });
      return failWith(labelStoreError($maintainedResultError113040, "maintain private Git store"));
    })();
  }

  private runMaintenanceLocked(
    options: WorkspaceHistoryMaintenanceOptions,
    startedAt: number,
    counters: {
      expectedCount: number;
      removedOrphanRefs: string[];
      preservedOrphanRefs: string[];
    },
  ): Promise<WorkspaceHistoryResult<WorkspaceHistoryMaintenanceResult>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const owned = yield* Result.await(this.verifyExistingStoreOwnership());
      if (!owned) {
        const loaded = yield* Result.await(
          attemptHost(async () => await options.loadExpectedRootTreeOids()),
        );
        const uniqueExpected = yield* this.checkExpectedRootTreeOids(loaded);
        counters.expectedCount = uniqueExpected.size;
        const result: WorkspaceHistoryMaintenanceResult = {
          status: "missing",
          storeDisposition: "missing",
          expected: this.missingReconciliation(uniqueExpected).expected,
          removedOrphanRefs: counters.removedOrphanRefs,
          preservedOrphanRefs: counters.preservedOrphanRefs,
          accounting: EMPTY_OBJECT_ACCOUNTING,
        };
        this.emitMaintenanceMetric(startedAt, result);
        return Result.ok(result);
      }
      const capability = yield* Result.await(this.capabilityInternal());
      if (capability.status === "unavailable") {
        this.emitMaintenanceMetric(startedAt, capability);
        return Result.ok<WorkspaceHistoryMaintenanceResult>(capability);
      }
      yield* Result.await(this.verifyNoAlternates());
      const loaded = yield* Result.await(
        attemptHost(async () => await options.loadExpectedRootTreeOids()),
      );
      const uniqueExpected = yield* this.checkExpectedRootTreeOids(loaded);
      counters.expectedCount = uniqueExpected.size;
      const cleanup = yield* Result.await(
        this.cleanupOrphanSnapshotRefsUnlocked(uniqueExpected, options.orphanGracePeriodMs),
      );
      counters.removedOrphanRefs = cleanup.removedOrphanRefs;
      counters.preservedOrphanRefs = cleanup.preservedOrphanRefs;
      const pruneAgeSeconds = Math.ceil(options.orphanGracePeriodMs / 1_000);
      const allExpectedProtected = cleanup.expected.every(
        (expected) => expected.status === "present" || expected.status === "repaired",
      );
      let pruneExpire: string;
      if (!allExpectedProtected) {
        pruneExpire = "never";
      } else if (pruneAgeSeconds === 0) {
        pruneExpire = "now";
      } else {
        pruneExpire = `${pruneAgeSeconds}.seconds.ago`;
      }
      yield* Result.await(
        this.runPrivateGit(["-c", `gc.pruneExpire=${pruneExpire}`, "gc", "--auto", "--no-detach"], {
          operation: "maintain private Git objects",
        }),
      );
      const accounting = yield* Result.await(this.getObjectAccountingUnlocked());
      let storeDisposition: "retained" | "removed" = "retained";
      let removalRefusalReason: WorkspaceHistoryStoreRemovalRefusalReason | undefined;
      if (options.removeStoreIfUnused) {
        removalRefusalReason = yield* Result.await(
          this.storeRemovalRefusalReason(
            uniqueExpected,
            options.removeStoreIfUnused.canRemoveStore,
          ),
        );
        if (!removalRefusalReason) {
          yield* Result.await(this.removeOwnedStore());
          storeDisposition = "removed";
        }
      }
      const result: WorkspaceHistoryMaintenanceResult = {
        status: "maintained",
        storeDisposition,
        ...(removalRefusalReason ? { removalRefusalReason } : {}),
        expected: cleanup.expected,
        removedOrphanRefs: counters.removedOrphanRefs,
        preservedOrphanRefs: counters.preservedOrphanRefs,
        accounting,
      };
      this.emitMaintenanceMetric(startedAt, result);
      return Result.ok(result);
    }, this);
  }

  async runMaintenance(
    options: WorkspaceHistoryMaintenanceOptions,
  ): Promise<WorkspaceHistoryMaintenanceResult> {
    const maintained = await this.runMaintenanceInternal(options);
    let $maintainedResultValue118124!: import("better-result").InferOk<
      NonNullable<typeof maintained>
    >;
    let $maintainedResultError118124!: import("better-result").InferErr<
      NonNullable<typeof maintained>
    >;
    const $maintainedResultOk118124 = Result.match<
      import("better-result").InferOk<NonNullable<typeof maintained>>,
      import("better-result").InferErr<NonNullable<typeof maintained>>,
      boolean
    >(maintained, {
      ok: (value) => {
        $maintainedResultValue118124 = value;
        return true;
      },
      err: (error) => {
        $maintainedResultError118124 = error;
        return false;
      },
    });
    if (($maintainedResultOk118124 ? "ok" : "error") === "error")
      throwFailure($maintainedResultError118124);
    return $maintainedResultValue118124;
  }

  async runMaintenanceResult(
    options: WorkspaceHistoryMaintenanceOptions,
  ): Promise<ResultType<WorkspaceHistoryMaintenanceResult, WorkspaceHistoryStoreError>> {
    // Existing embedders subclassed the original throwing method before the Result API existed.
    // Keep that concrete compatibility edge while the base implementation remains Result-native.
    if (this.runMaintenance !== WorkspaceHistoryStore.prototype.runMaintenance) {
      const maintainedOverride = await attemptHost(async () => await this.runMaintenance(options));
      return await this.publicWorkspaceResult(maintainedOverride, "maintain private Git store");
    }
    const maintained = await this.runMaintenanceInternal(options);
    return await this.publicWorkspaceResult(maintained, "maintain private Git store");
  }

  private cleanupStaleRestoreArtifactsInternal(): Promise<
    WorkspaceHistoryResult<WorkspaceHistoryCleanupResult>
  > {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const capability = yield* Result.await(this.capabilityInternal());
      if (capability.status === "unavailable") return Result.ok({ removed: [], preserved: [] });
      return await withStoreLock(this.storeDirectory, () =>
        Result.gen(async function* (this: WorkspaceHistoryStore) {
          yield* Result.await(this.ensureStore());
          const cleaned = yield* Result.await(this.cleanupStaleRestoreArtifactsLocked());
          return Result.ok(cleaned);
        }, this),
      );
    }, this);
  }

  async cleanupStaleRestoreArtifacts(): Promise<WorkspaceHistoryCleanupResult> {
    const cleaned = await this.cleanupStaleRestoreArtifactsInternal();
    let $cleanedResultValue119899!: import("better-result").InferOk<NonNullable<typeof cleaned>>;
    let $cleanedResultError119899!: import("better-result").InferErr<NonNullable<typeof cleaned>>;
    const $cleanedResultOk119899 = Result.match<
      import("better-result").InferOk<NonNullable<typeof cleaned>>,
      import("better-result").InferErr<NonNullable<typeof cleaned>>,
      boolean
    >(cleaned, {
      ok: (value) => {
        $cleanedResultValue119899 = value;
        return true;
      },
      err: (error) => {
        $cleanedResultError119899 = error;
        return false;
      },
    });
    if (($cleanedResultOk119899 ? "ok" : "error") === "error")
      throwFailure($cleanedResultError119899);
    return $cleanedResultValue119899;
  }

  async cleanupStaleRestoreArtifactsResult(): Promise<
    ResultType<WorkspaceHistoryCleanupResult, WorkspaceHistoryStoreError>
  > {
    if (
      this.cleanupStaleRestoreArtifacts !==
      WorkspaceHistoryStore.prototype.cleanupStaleRestoreArtifacts
    ) {
      return await this.callThrowingOverride(
        async () => await this.cleanupStaleRestoreArtifacts(),
        "clean stale restore staging",
      );
    }
    const cleaned = await this.cleanupStaleRestoreArtifactsInternal();
    return await this.publicWorkspaceResult(cleaned, "clean stale restore staging");
  }
  private probeGit(): Promise<WorkspaceHistoryResult<string>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      if (this.positiveProbe && this.positiveProbe.expiresAt > Date.now()) {
        return Result.ok(this.positiveProbe.version);
      }
      const result = yield* Result.await(this.runGit(["--version"], { operation: "probe Git" }));
      const version = (yield* bytesToText(result.stdout, "probe Git")).trim();
      if (!/^git version \S+/.test(version)) {
        return failOwned({
          code: "malformed-git-output",
          operation: "probe Git",
          message: "Git returned a malformed version response",
          detail: version.slice(0, 200),
        });
      }
      this.positiveProbe = { version, expiresAt: Date.now() + 5_000 };
      return Result.ok(version);
    }, this);
  }

  private ensureStore(): Promise<WorkspaceHistoryResult<void>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      yield* Result.await(this.assertNoSymlinkComponents(this.cwd, false));
      const workspaceStats = await attemptHost(() => lstat(this.cwd));
      let $workspaceStatsResultValue121711!: import("better-result").InferOk<
        NonNullable<typeof workspaceStats>
      >;
      let $workspaceStatsResultError121711!: import("better-result").InferErr<
        NonNullable<typeof workspaceStats>
      >;
      const $workspaceStatsResultOk121711 = Result.match<
        import("better-result").InferOk<NonNullable<typeof workspaceStats>>,
        import("better-result").InferErr<NonNullable<typeof workspaceStats>>,
        boolean
      >(workspaceStats, {
        ok: (value) => {
          $workspaceStatsResultValue121711 = value;
          return true;
        },
        err: (error) => {
          $workspaceStatsResultError121711 = error;
          return false;
        },
      });
      if (($workspaceStatsResultOk121711 ? "ok" : "error") === "error") {
        return failOwned({
          code: "workspace-invalid",
          operation: "validate workspace",
          message: `Cannot access workspace: ${opaqueErrorMessage(failureCause($workspaceStatsResultError121711), "Workspace access failed")}`,
          cause: failureCause($workspaceStatsResultError121711),
        });
      }
      if (!$workspaceStatsResultValue121711.isDirectory()) {
        return failOwned({
          code: "workspace-invalid",
          operation: "validate workspace",
          message: "Workspace path is not a directory",
        });
      }
      const canonicalCwd = yield* Result.await(attemptHost(() => realpath(this.cwd)));
      if (canonicalCwd !== this.cwd) {
        return failOwned({
          code: "workspace-invalid",
          operation: "validate workspace",
          message: "Workspace path must be canonical",
          detail: canonicalCwd,
        });
      }

      yield* Result.await(this.assertNoSymlinkComponents(this.historyRoot, true));
      yield* Result.await(
        attemptHost(() => mkdir(this.historyRoot, { recursive: true, mode: 0o700 })),
      );
      yield* Result.await(this.assertNoSymlinkComponents(this.historyRoot, false));
      const canonicalHistoryRoot = yield* Result.await(
        attemptHost(() => realpath(this.historyRoot)),
      );
      if (canonicalHistoryRoot !== this.historyRoot) {
        return failOwned({
          code: "workspace-invalid",
          operation: "validate history root",
          message: "History root path must be canonical and contain no symlink components",
          detail: canonicalHistoryRoot,
        });
      }
      yield* Result.await(attemptHost(() => chmod(this.historyRoot, 0o700)));
      const workspaceStoreRoot = path.dirname(this.storeDirectory);
      yield* Result.await(this.assertNoSymlinkComponents(workspaceStoreRoot, true));
      yield* Result.await(
        attemptHost(() => mkdir(workspaceStoreRoot, { recursive: true, mode: 0o700 })),
      );
      yield* Result.await(this.assertNoSymlinkComponents(workspaceStoreRoot, false));
      yield* Result.await(attemptHost(() => chmod(workspaceStoreRoot, 0o700)));

      const markerStats = yield* Result.await(lstatIfExists(this.markerPath));
      if (markerStats && (!markerStats.isFile() || markerStats.isSymbolicLink())) {
        return failOwned({
          code: "ownership-mismatch",
          operation: "verify store ownership",
          message: "Private Git store ownership marker is not a regular file",
        });
      }
      if (markerStats) {
        yield* Result.await(this.verifyOwnershipMarker());
      } else {
        const existingStore = yield* Result.await(lstatIfExists(this.storeDirectory));
        if (existingStore) {
          return failOwned({
            code: "ownership-mismatch",
            operation: "verify store ownership",
            message: "Refusing to reuse a private Git store without an ownership marker",
          });
        }
        yield* Result.await(
          attemptHost(() => mkdir(this.storeDirectory, { recursive: true, mode: 0o700 })),
        );
        yield* Result.await(
          attemptHost(() =>
            writeFile(this.markerPath, canonicalJson(this.expectedMarker()), {
              mode: 0o600,
              flag: "wx",
            }),
          ),
        );
      }

      yield* Result.await(attemptHost(() => chmod(this.storeDirectory, 0o700)));
      yield* Result.await(
        attemptHost(() => mkdir(this.emptyHooksPath, { recursive: true, mode: 0o700 })),
      );
      yield* Result.await(
        attemptHost(() =>
          mkdir(this.snapshotRefCreationDirectory, { recursive: true, mode: 0o700 }),
        ),
      );
      yield* Result.await(
        attemptHost(() => mkdir(this.restorePlanDirectory, { recursive: true, mode: 0o700 })),
      );
      yield* Result.await(
        this.writePrivateControlFile(path.join(this.storeDirectory, "empty-config"), ""),
      );
      yield* Result.await(this.writePrivateControlFile(this.emptyAttributesPath, ""));
      yield* Result.await(this.writePrivateControlFile(this.emptyExcludesPath, ""));

      const bareMarker = yield* Result.await(lstatIfExists(path.join(this.storeDirectory, "HEAD")));
      if (!bareMarker) {
        yield* Result.await(
          this.runGit(["init", "--bare", "--quiet", this.storeDirectory], {
            operation: "initialize private Git store",
          }),
        );
      }
      yield* Result.await(
        this.writePrivateControlFile(path.join(this.storeDirectory, "info", "exclude"), ""),
      );
      yield* Result.await(this.verifyOwnershipMarker());
      return Result.ok(undefined);
    }, this);
  }

  private discoverSourceRepository(): Promise<
    WorkspaceHistoryResult<{ root: string } | undefined>
  > {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const result = yield* Result.await(
        this.runSourceGit(this.cwd, ["rev-parse", "--show-toplevel"], {
          operation: "discover source repository",
          acceptedExitCodes: [0, 128],
        }),
      );
      if (result.exitCode !== 0) {
        if (/not a git repository|must be run in a work tree/u.test(result.stderr)) {
          return Result.ok(undefined);
        }
        return failOwned({
          code: "git-command-failed",
          operation: "discover source repository",
          message: `Git failed while discovering the source repository (exit ${result.exitCode})`,
          detail: result.stderr.trim().slice(0, 4_000),
          exitCode: result.exitCode,
        });
      }
      const root = yield* bytesToText(result.stdout, "discover source repository");
      const trimmedRoot = root.trim();
      if (!path.isAbsolute(trimmedRoot)) {
        return failOwned({
          code: "malformed-git-output",
          operation: "discover source repository",
          message: "Git returned a non-absolute repository root",
        });
      }
      const canonicalRoot = yield* Result.await(attemptHost(() => realpath(trimmedRoot)));
      return Result.ok({ root: canonicalRoot });
    }, this);
  }

  private classifyWorkspace(): Promise<WorkspaceHistoryResult<ClassifiedWorkspace>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const sourceRepository = yield* Result.await(this.discoverSourceRepository());
      if (!sourceRepository) {
        return failOwned({
          code: "workspace-invalid",
          operation: "classify workspace",
          message: "Workspace is not inside a Git worktree",
        });
      }
      const scan = yield* Result.await(this.scanWorkspace());
      this.sourceExcludesFile = yield* Result.await(
        this.resolveEffectiveExcludesFile(sourceRepository.root),
      );
      const managedPaths = yield* Result.await(this.listSourceManagedPaths(sourceRepository.root));
      const ignored = yield* Result.await(this.checkIgnoredPaths(scan, sourceRepository.root));
      const managed = new Map<string, ScannedEntry>();
      for (const relativePath of managedPaths) {
        const entry = scan.entries.get(relativePath);
        if (entry) managed.set(relativePath, entry);
      }
      for (const relativePath of managed.keys()) ignored.delete(relativePath);
      const ignoredDirectories = new Set(
        [...scan.directories].filter((relativePath) => ignored.has(relativePath)),
      );
      return Result.ok({ ...scan, managed, ignored, ignoredDirectories });
    }, this);
  }

  private classifyWorkspaceForCapture(
    repositoryRoot: string,
  ): Promise<WorkspaceHistoryResult<ClassifiedWorkspace>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      this.sourceExcludesFile = yield* Result.await(
        this.resolveEffectiveExcludesFile(repositoryRoot),
      );
      const managedPaths = yield* Result.await(this.listSourceManagedPaths(repositoryRoot));
      const scan = yield* Result.await(this.scanWorkspace(managedPaths));
      const ignored = yield* Result.await(this.checkIgnoredPaths(scan, repositoryRoot));
      const managed = new Map<string, ScannedEntry>();
      for (const relativePath of managedPaths) {
        const entry = scan.entries.get(relativePath);
        if (entry) managed.set(relativePath, entry);
      }
      for (const relativePath of managed.keys()) ignored.delete(relativePath);
      const ignoredDirectories = new Set(
        [...scan.directories].filter((relativePath) => ignored.has(relativePath)),
      );
      return Result.ok({ ...scan, managed, ignored, ignoredDirectories });
    }, this);
  }

  private async readCaptureCache(): Promise<
    WorkspaceHistoryResult<DecodedWorkspaceHistoryValue<WorkspaceHistoryCaptureCache | undefined>>
  > {
    const read = await attemptHost(() => readFile(this.captureCachePath, "utf8"));
    let $readResultValue130558!: import("better-result").InferOk<NonNullable<typeof read>>;
    let $readResultError130558!: import("better-result").InferErr<NonNullable<typeof read>>;
    const $readResultOk130558 = Result.match<
      import("better-result").InferOk<NonNullable<typeof read>>,
      import("better-result").InferErr<NonNullable<typeof read>>,
      boolean
    >(read, {
      ok: (value) => {
        $readResultValue130558 = value;
        return true;
      },
      err: (error) => {
        $readResultError130558 = error;
        return false;
      },
    });
    let serialized: string | null;
    if (($readResultOk130558 ? "ok" : "error") === "ok") {
      serialized = $readResultValue130558;
    } else if (hostErrorCode($readResultError130558) === "ENOENT") {
      serialized = null;
    } else {
      return Result.err($readResultError130558);
    }
    const decoded = decodeWorkspaceHistoryCaptureCache({
      serialized,
      workspaceId: this.workspaceId,
      canonicalCwd: this.cwd,
      pathComparison: this.pathComparison,
    });
    let $decodedResultValue130859!: import("better-result").InferOk<NonNullable<typeof decoded>>;
    let $decodedResultError130859!: import("better-result").InferErr<NonNullable<typeof decoded>>;
    const $decodedResultOk130859 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decoded>>,
      import("better-result").InferErr<NonNullable<typeof decoded>>,
      boolean
    >(decoded, {
      ok: (value) => {
        $decodedResultValue130859 = value;
        return true;
      },
      err: (error) => {
        $decodedResultError130859 = error;
        return false;
      },
    });
    if (($decodedResultOk130859 ? "ok" : "error") === "ok")
      return Result.ok($decodedResultValue130859);
    return Result.err({ kind: "persistence", error: $decodedResultError130859 });
  }

  private async invalidateCaptureCache(): Promise<WorkspaceHistoryResult<void>> {
    const removed = await attemptHost(() => rm(this.captureCachePath, { force: true }));
    let $removedResultError131275!: import("better-result").InferErr<NonNullable<typeof removed>>;
    const $removedResultOk131275 = Result.match<
      import("better-result").InferOk<NonNullable<typeof removed>>,
      import("better-result").InferErr<NonNullable<typeof removed>>,
      boolean
    >(removed, {
      ok: () => true,
      err: (error) => {
        $removedResultError131275 = error;
        return false;
      },
    });
    if (($removedResultOk131275 ? "ok" : "error") === "error") {
      return Result.err(
        labelWorkspaceFailure($removedResultError131275, "invalidate capture cache"),
      );
    }
    const synced = await this.fsyncDirectory(this.storeDirectory);
    let $syncedResultError131499!: import("better-result").InferErr<NonNullable<typeof synced>>;
    const $syncedResultOk131499 = Result.match<
      import("better-result").InferOk<NonNullable<typeof synced>>,
      import("better-result").InferErr<NonNullable<typeof synced>>,
      boolean
    >(synced, {
      ok: () => true,
      err: (error) => {
        $syncedResultError131499 = error;
        return false;
      },
    });
    if (($syncedResultOk131499 ? "ok" : "error") === "error") {
      return Result.err(
        labelWorkspaceFailure($syncedResultError131499, "invalidate capture cache"),
      );
    }
    return synced;
  }

  private writeCaptureCache(
    cache: WorkspaceHistoryCaptureCache,
  ): Promise<WorkspaceHistoryResult<void>> {
    return (async () => {
      try {
        return await this.writeAtomicPrivateFile(
          this.captureCachePath,
          canonicalJson(cache),
          "write capture cache",
          () => `${this.captureCachePath}.${randomUUID()}.tmp`,
        );
      } catch (cause) {
        if (Panic.is(cause)) throw cause;
        throw cause;
      }
    })();
  }

  private async writeAtomicPrivateFile(
    targetPath: string,
    contents: string | Uint8Array,
    operation: string,
    temporaryPathFactory: () => string = () =>
      path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${randomUUID()}.tmp`),
  ): Promise<WorkspaceHistoryResult<void>> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const targetDirectory = path.dirname(targetPath);
      const targetName = path.basename(targetPath);
      const operationDirectory = `${temporaryPathFactory()}.${randomUUID()}.private`;
      if (path.dirname(operationDirectory) !== targetDirectory) {
        return failOwned({
          code: "workspace-invalid",
          operation,
          message: "Atomic-write operation directory must be beside its destination",
        });
      }
      const operationDirectoryName = path.basename(operationDirectory);
      const sourceName = "source";
      const publishName = `publish-${randomUUID()}`;
      const sourcePath = path.join(operationDirectory, sourceName);
      let targetDirectoryHandle: Awaited<ReturnType<typeof open>> | undefined;
      let operationDirectoryHandle: Awaited<ReturnType<typeof open>> | undefined;
      let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
      let fileApi: PosixFileApi | undefined;
      let operationDirectoryIdentity: OwnedTemporaryPath | undefined;
      let sourceIdentity: OwnedTemporaryPath | undefined;
      let operationDirectoryOwned = false;
      let sourceEntryOwned = false;
      let publishEntryOwned = false;
      const primary = await superviseOutcome<void>(async () => {
        const directoryCreated = await attemptHost(() =>
          mkdir(operationDirectory, { mode: 0o700 }),
        );
        let $directoryCreatedResultError133843!: import("better-result").InferErr<
          NonNullable<typeof directoryCreated>
        >;
        const $directoryCreatedResultOk133843 = Result.match<
          import("better-result").InferOk<NonNullable<typeof directoryCreated>>,
          import("better-result").InferErr<NonNullable<typeof directoryCreated>>,
          boolean
        >(directoryCreated, {
          ok: () => true,
          err: (error) => {
            $directoryCreatedResultError133843 = error;
            return false;
          },
        });
        if (($directoryCreatedResultOk133843 ? "ok" : "error") === "error")
          return Result.err($directoryCreatedResultError133843);
        operationDirectoryOwned = true;
        const permissionsSet = await attemptHost(() => chmod(operationDirectory, 0o700));
        let $permissionsSetResultError134079!: import("better-result").InferErr<
          NonNullable<typeof permissionsSet>
        >;
        const $permissionsSetResultOk134079 = Result.match<
          import("better-result").InferOk<NonNullable<typeof permissionsSet>>,
          import("better-result").InferErr<NonNullable<typeof permissionsSet>>,
          boolean
        >(permissionsSet, {
          ok: () => true,
          err: (error) => {
            $permissionsSetResultError134079 = error;
            return false;
          },
        });
        if (($permissionsSetResultOk134079 ? "ok" : "error") === "error")
          return Result.err($permissionsSetResultError134079);

        const apiOpened = attemptHostSync(openPosixFileApi);
        let $apiOpenedResultValue134240!: import("better-result").InferOk<
          NonNullable<typeof apiOpened>
        >;
        let $apiOpenedResultError134240!: import("better-result").InferErr<
          NonNullable<typeof apiOpened>
        >;
        const $apiOpenedResultOk134240 = Result.match<
          import("better-result").InferOk<NonNullable<typeof apiOpened>>,
          import("better-result").InferErr<NonNullable<typeof apiOpened>>,
          boolean
        >(apiOpened, {
          ok: (value) => {
            $apiOpenedResultValue134240 = value;
            return true;
          },
          err: (error) => {
            $apiOpenedResultError134240 = error;
            return false;
          },
        });
        if (($apiOpenedResultOk134240 ? "ok" : "error") === "error")
          return Result.err($apiOpenedResultError134240);
        fileApi = $apiOpenedResultValue134240;
        const targetDirectoryOpened = await attemptHost(() =>
          open(
            targetDirectory,
            fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
          ),
        );
        let $targetDirectoryOpenedResultValue134396!: import("better-result").InferOk<
          NonNullable<typeof targetDirectoryOpened>
        >;
        let $targetDirectoryOpenedResultError134396!: import("better-result").InferErr<
          NonNullable<typeof targetDirectoryOpened>
        >;
        const $targetDirectoryOpenedResultOk134396 = Result.match<
          import("better-result").InferOk<NonNullable<typeof targetDirectoryOpened>>,
          import("better-result").InferErr<NonNullable<typeof targetDirectoryOpened>>,
          boolean
        >(targetDirectoryOpened, {
          ok: (value) => {
            $targetDirectoryOpenedResultValue134396 = value;
            return true;
          },
          err: (error) => {
            $targetDirectoryOpenedResultError134396 = error;
            return false;
          },
        });
        if (($targetDirectoryOpenedResultOk134396 ? "ok" : "error") === "error")
          return Result.err($targetDirectoryOpenedResultError134396);
        targetDirectoryHandle = $targetDirectoryOpenedResultValue134396;
        const operationDirectoryOpened = await attemptHost(() =>
          open(
            operationDirectory,
            fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
          ),
        );
        let $operationDirectoryOpenedResultValue134757!: import("better-result").InferOk<
          NonNullable<typeof operationDirectoryOpened>
        >;
        let $operationDirectoryOpenedResultError134757!: import("better-result").InferErr<
          NonNullable<typeof operationDirectoryOpened>
        >;
        const $operationDirectoryOpenedResultOk134757 = Result.match<
          import("better-result").InferOk<NonNullable<typeof operationDirectoryOpened>>,
          import("better-result").InferErr<NonNullable<typeof operationDirectoryOpened>>,
          boolean
        >(operationDirectoryOpened, {
          ok: (value) => {
            $operationDirectoryOpenedResultValue134757 = value;
            return true;
          },
          err: (error) => {
            $operationDirectoryOpenedResultError134757 = error;
            return false;
          },
        });
        if (($operationDirectoryOpenedResultOk134757 ? "ok" : "error") === "error")
          return Result.err($operationDirectoryOpenedResultError134757);
        operationDirectoryHandle = $operationDirectoryOpenedResultValue134757;
        const directoryStats = await attemptHost(() =>
          $operationDirectoryOpenedResultValue134757.stat({ bigint: true }),
        );
        let $directoryStatsResultValue135136!: import("better-result").InferOk<
          NonNullable<typeof directoryStats>
        >;
        let $directoryStatsResultError135136!: import("better-result").InferErr<
          NonNullable<typeof directoryStats>
        >;
        const $directoryStatsResultOk135136 = Result.match<
          import("better-result").InferOk<NonNullable<typeof directoryStats>>,
          import("better-result").InferErr<NonNullable<typeof directoryStats>>,
          boolean
        >(directoryStats, {
          ok: (value) => {
            $directoryStatsResultValue135136 = value;
            return true;
          },
          err: (error) => {
            $directoryStatsResultError135136 = error;
            return false;
          },
        });
        if (($directoryStatsResultOk135136 ? "ok" : "error") === "error")
          return Result.err($directoryStatsResultError135136);
        const currentUid = process.getuid?.();
        if (
          !$directoryStatsResultValue135136.isDirectory() ||
          ($directoryStatsResultValue135136.mode & 0o777n) !== 0o700n ||
          (currentUid !== undefined && $directoryStatsResultValue135136.uid !== BigInt(currentUid))
        ) {
          return failOwned({
            code: "ownership-mismatch",
            operation,
            message: "Atomic-write operation directory is not exclusively owned",
          });
        }
        operationDirectoryIdentity = {
          path: operationDirectory,
          dev: $directoryStatsResultValue135136.dev,
          ino: $directoryStatsResultValue135136.ino,
        };
        const sourceOpened = await attemptHost(() =>
          open(
            sourcePath,
            fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
            0o600,
          ),
        );
        let $sourceOpenedResultValue135973!: import("better-result").InferOk<
          NonNullable<typeof sourceOpened>
        >;
        let $sourceOpenedResultError135973!: import("better-result").InferErr<
          NonNullable<typeof sourceOpened>
        >;
        const $sourceOpenedResultOk135973 = Result.match<
          import("better-result").InferOk<NonNullable<typeof sourceOpened>>,
          import("better-result").InferErr<NonNullable<typeof sourceOpened>>,
          boolean
        >(sourceOpened, {
          ok: (value) => {
            $sourceOpenedResultValue135973 = value;
            return true;
          },
          err: (error) => {
            $sourceOpenedResultError135973 = error;
            return false;
          },
        });
        if (($sourceOpenedResultOk135973 ? "ok" : "error") === "error")
          return Result.err($sourceOpenedResultError135973);
        sourceHandle = $sourceOpenedResultValue135973;
        sourceEntryOwned = true;
        const beforeStat = await attemptHost(
          async () => await this.beforePrivateFileStat?.(operation, sourcePath),
        );
        let $beforeStatResultError136351!: import("better-result").InferErr<
          NonNullable<typeof beforeStat>
        >;
        const $beforeStatResultOk136351 = Result.match<
          import("better-result").InferOk<NonNullable<typeof beforeStat>>,
          import("better-result").InferErr<NonNullable<typeof beforeStat>>,
          boolean
        >(beforeStat, {
          ok: () => true,
          err: (error) => {
            $beforeStatResultError136351 = error;
            return false;
          },
        });
        if (($beforeStatResultOk136351 ? "ok" : "error") === "error")
          return Result.err($beforeStatResultError136351);
        const stats = await attemptHost(() =>
          $sourceOpenedResultValue135973.stat({ bigint: true }),
        );
        let $statsResultValue136551!: import("better-result").InferOk<NonNullable<typeof stats>>;
        let $statsResultError136551!: import("better-result").InferErr<NonNullable<typeof stats>>;
        const $statsResultOk136551 = Result.match<
          import("better-result").InferOk<NonNullable<typeof stats>>,
          import("better-result").InferErr<NonNullable<typeof stats>>,
          boolean
        >(stats, {
          ok: (value) => {
            $statsResultValue136551 = value;
            return true;
          },
          err: (error) => {
            $statsResultError136551 = error;
            return false;
          },
        });
        if (($statsResultOk136551 ? "ok" : "error") === "error")
          return Result.err($statsResultError136551);
        sourceIdentity = {
          path: sourcePath,
          dev: $statsResultValue136551.dev,
          ino: $statsResultValue136551.ino,
        };
        const written = await attemptHost(async () => {
          await $sourceOpenedResultValue135973.writeFile(contents);
          await $sourceOpenedResultValue135973.sync();
        });
        let $writtenResultError136784!: import("better-result").InferErr<
          NonNullable<typeof written>
        >;
        const $writtenResultOk136784 = Result.match<
          import("better-result").InferOk<NonNullable<typeof written>>,
          import("better-result").InferErr<NonNullable<typeof written>>,
          boolean
        >(written, {
          ok: () => true,
          err: (error) => {
            $writtenResultError136784 = error;
            return false;
          },
        });
        if (($writtenResultOk136784 ? "ok" : "error") === "error")
          return Result.err($writtenResultError136784);
        const beforeClose = await attemptHost(
          async () => await this.beforePrivateFileClose?.(operation, sourcePath),
        );
        let $beforeCloseResultError137007!: import("better-result").InferErr<
          NonNullable<typeof beforeClose>
        >;
        const $beforeCloseResultOk137007 = Result.match<
          import("better-result").InferOk<NonNullable<typeof beforeClose>>,
          import("better-result").InferErr<NonNullable<typeof beforeClose>>,
          boolean
        >(beforeClose, {
          ok: () => true,
          err: (error) => {
            $beforeCloseResultError137007 = error;
            return false;
          },
        });
        if (($beforeCloseResultOk137007 ? "ok" : "error") === "error")
          return Result.err($beforeCloseResultError137007);
        const sourceOwned = await this.assertTemporaryIdentity(sourceIdentity, operation);
        let $sourceOwnedResultError137211!: import("better-result").InferErr<
          NonNullable<typeof sourceOwned>
        >;
        const $sourceOwnedResultOk137211 = Result.match<
          import("better-result").InferOk<NonNullable<typeof sourceOwned>>,
          import("better-result").InferErr<NonNullable<typeof sourceOwned>>,
          boolean
        >(sourceOwned, {
          ok: () => true,
          err: (error) => {
            $sourceOwnedResultError137211 = error;
            return false;
          },
        });
        if (($sourceOwnedResultOk137211 ? "ok" : "error") === "error")
          return Result.err($sourceOwnedResultError137211);
        const directoryOwned = await this.assertTemporaryIdentity(
          operationDirectoryIdentity,
          operation,
        );
        let $directoryOwnedResultError137366!: import("better-result").InferErr<
          NonNullable<typeof directoryOwned>
        >;
        const $directoryOwnedResultOk137366 = Result.match<
          import("better-result").InferOk<NonNullable<typeof directoryOwned>>,
          import("better-result").InferErr<NonNullable<typeof directoryOwned>>,
          boolean
        >(directoryOwned, {
          ok: () => true,
          err: (error) => {
            $directoryOwnedResultError137366 = error;
            return false;
          },
        });
        if (($directoryOwnedResultOk137366 ? "ok" : "error") === "error")
          return Result.err($directoryOwnedResultError137366);
        const beforePublish = await attemptHost(
          async () => await this.beforePrivateFilePublish?.(operation, sourcePath, targetPath),
        );
        let $beforePublishResultError137573!: import("better-result").InferErr<
          NonNullable<typeof beforePublish>
        >;
        const $beforePublishResultOk137573 = Result.match<
          import("better-result").InferOk<NonNullable<typeof beforePublish>>,
          import("better-result").InferErr<NonNullable<typeof beforePublish>>,
          boolean
        >(beforePublish, {
          ok: () => true,
          err: (error) => {
            $beforePublishResultError137573 = error;
            return false;
          },
        });
        if (($beforePublishResultOk137573 ? "ok" : "error") === "error")
          return Result.err($beforePublishResultError137573);

        if (!sourceHandle || !operationDirectoryHandle || !targetDirectoryHandle || !fileApi) {
          return failOwned({
            code: "ownership-mismatch",
            operation,
            message: "Atomic-write descriptor ownership is unavailable",
          });
        }
        if (process.platform === "linux") {
          const linked = linkOpenFile(
            fileApi,
            sourceHandle.fd,
            operationDirectoryHandle.fd,
            publishName,
            operation,
          );
          const $linkedResultOk138129 = Result.match<
            import("better-result").InferOk<NonNullable<typeof linked>>,
            import("better-result").InferErr<NonNullable<typeof linked>>,
            boolean
          >(linked, {
            ok: () => true,
            err: () => false,
          });
          if (($linkedResultOk138129 ? "ok" : "error") === "error") {
            const currentStats = await attemptHost(() => sourceHandle!.stat({ bigint: true }));
            let $currentStatsResultValue138365!: import("better-result").InferOk<
              NonNullable<typeof currentStats>
            >;
            let $currentStatsResultError138365!: import("better-result").InferErr<
              NonNullable<typeof currentStats>
            >;
            const $currentStatsResultOk138365 = Result.match<
              import("better-result").InferOk<NonNullable<typeof currentStats>>,
              import("better-result").InferErr<NonNullable<typeof currentStats>>,
              boolean
            >(currentStats, {
              ok: (value) => {
                $currentStatsResultValue138365 = value;
                return true;
              },
              err: (error) => {
                $currentStatsResultError138365 = error;
                return false;
              },
            });
            if (($currentStatsResultOk138365 ? "ok" : "error") === "error")
              return Result.err($currentStatsResultError138365);
            if (
              $currentStatsResultValue138365.dev === sourceIdentity.dev &&
              $currentStatsResultValue138365.ino === sourceIdentity.ino &&
              $currentStatsResultValue138365.nlink !== 1n
            ) {
              sourceEntryOwned = false;
              return failOwned({
                code: "ownership-mismatch",
                operation,
                message: "Atomic-write source was replaced after final validation",
              });
            }
            return linked;
          }
          publishEntryOwned = true;
          const linkedStats = await attemptHost(() => sourceHandle!.stat({ bigint: true }));
          let $linkedStatsResultValue139069!: import("better-result").InferOk<
            NonNullable<typeof linkedStats>
          >;
          let $linkedStatsResultError139069!: import("better-result").InferErr<
            NonNullable<typeof linkedStats>
          >;
          const $linkedStatsResultOk139069 = Result.match<
            import("better-result").InferOk<NonNullable<typeof linkedStats>>,
            import("better-result").InferErr<NonNullable<typeof linkedStats>>,
            boolean
          >(linkedStats, {
            ok: (value) => {
              $linkedStatsResultValue139069 = value;
              return true;
            },
            err: (error) => {
              $linkedStatsResultError139069 = error;
              return false;
            },
          });
          if (($linkedStatsResultOk139069 ? "ok" : "error") === "error")
            return Result.err($linkedStatsResultError139069);
          if (
            $linkedStatsResultValue139069.dev !== sourceIdentity.dev ||
            $linkedStatsResultValue139069.ino !== sourceIdentity.ino ||
            $linkedStatsResultValue139069.nlink !== 2n
          ) {
            sourceEntryOwned = false;
            return failOwned({
              code: "ownership-mismatch",
              operation,
              message: "Atomic-write source was replaced after final validation",
            });
          }
          const sourceNameOwned = await this.assertTemporaryIdentity(sourceIdentity, operation);
          const $sourceNameOwnedResultOk139666 = Result.match<
            import("better-result").InferOk<NonNullable<typeof sourceNameOwned>>,
            import("better-result").InferErr<NonNullable<typeof sourceNameOwned>>,
            boolean
          >(sourceNameOwned, {
            ok: () => true,
            err: () => false,
          });
          if (($sourceNameOwnedResultOk139666 ? "ok" : "error") === "error") {
            sourceEntryOwned = false;
            return sourceNameOwned;
          }
          const renamed = renameAt(
            fileApi,
            operationDirectoryHandle.fd,
            publishName,
            targetDirectoryHandle.fd,
            targetName,
            operation,
          );
          let $renamedResultError139901!: import("better-result").InferErr<
            NonNullable<typeof renamed>
          >;
          const $renamedResultOk139901 = Result.match<
            import("better-result").InferOk<NonNullable<typeof renamed>>,
            import("better-result").InferErr<NonNullable<typeof renamed>>,
            boolean
          >(renamed, {
            ok: () => true,
            err: (error) => {
              $renamedResultError139901 = error;
              return false;
            },
          });
          if (($renamedResultOk139901 ? "ok" : "error") === "error")
            return Result.err($renamedResultError139901);
          publishEntryOwned = false;
        } else {
          // Bun exposes no AT_EMPTY_PATH equivalent on Darwin. The fallback keeps the source name
          // unexposed inside an exclusive 0700 directory and uses descriptor-relative renameat.
          // A configured publication seam could mutate that private name, so fail closed there.
          if (this.beforePrivateFilePublish) {
            return failOwned({
              code: "platform-unsupported",
              operation,
              message: "Descriptor-bound publication seam is supported only on Linux",
            });
          }
          const renamed = renameAt(
            fileApi,
            operationDirectoryHandle.fd,
            sourceName,
            targetDirectoryHandle.fd,
            targetName,
            operation,
          );
          let $renamedResultError140789!: import("better-result").InferErr<
            NonNullable<typeof renamed>
          >;
          const $renamedResultOk140789 = Result.match<
            import("better-result").InferOk<NonNullable<typeof renamed>>,
            import("better-result").InferErr<NonNullable<typeof renamed>>,
            boolean
          >(renamed, {
            ok: () => true,
            err: (error) => {
              $renamedResultError140789 = error;
              return false;
            },
          });
          if (($renamedResultOk140789 ? "ok" : "error") === "error")
            return Result.err($renamedResultError140789);
          sourceEntryOwned = false;
        }
        const afterPublish = await attemptHost(
          async () =>
            await this.afterPrivateFilePublishBeforeDirectorySync?.(
              operation,
              targetDirectory,
              targetPath,
            ),
        );
        let $afterPublishResultError141111!: import("better-result").InferErr<
          NonNullable<typeof afterPublish>
        >;
        const $afterPublishResultOk141111 = Result.match<
          import("better-result").InferOk<NonNullable<typeof afterPublish>>,
          import("better-result").InferErr<NonNullable<typeof afterPublish>>,
          boolean
        >(afterPublish, {
          ok: () => true,
          err: (error) => {
            $afterPublishResultError141111 = error;
            return false;
          },
        });
        if (($afterPublishResultOk141111 ? "ok" : "error") === "error")
          return Result.err($afterPublishResultError141111);
        const directoryToSync = targetDirectoryHandle;
        if (!directoryToSync) {
          return failOwned({
            code: "ownership-mismatch",
            operation,
            message: "Atomic-write target directory descriptor is unavailable",
          });
        }
        return await attemptHost(async () => await directoryToSync.sync());
      });

      const cleanup = await runWorkspaceHistoryCleanup(operation, [
        async () => {
          if (!sourceEntryOwned || sourceIdentity || !sourceHandle) return Result.ok(undefined);
          const captured = await attemptHost(() => sourceHandle!.stat({ bigint: true }));
          let $capturedResultValue141983!: import("better-result").InferOk<
            NonNullable<typeof captured>
          >;
          let $capturedResultError141983!: import("better-result").InferErr<
            NonNullable<typeof captured>
          >;
          const $capturedResultOk141983 = Result.match<
            import("better-result").InferOk<NonNullable<typeof captured>>,
            import("better-result").InferErr<NonNullable<typeof captured>>,
            boolean
          >(captured, {
            ok: (value) => {
              $capturedResultValue141983 = value;
              return true;
            },
            err: (error) => {
              $capturedResultError141983 = error;
              return false;
            },
          });
          if (($capturedResultOk141983 ? "ok" : "error") === "error")
            return Result.err($capturedResultError141983);
          sourceIdentity = {
            path: sourcePath,
            dev: $capturedResultValue141983.dev,
            ino: $capturedResultValue141983.ino,
          };
          return Result.ok(undefined);
        },
        async () => {
          if (!publishEntryOwned || !fileApi || !operationDirectoryHandle) {
            return Result.ok(undefined);
          }
          const removed = unlinkAt(
            fileApi,
            operationDirectoryHandle.fd,
            publishName,
            false,
            operation,
          );
          const $removedResultOk142481 = Result.match<
            import("better-result").InferOk<NonNullable<typeof removed>>,
            import("better-result").InferErr<NonNullable<typeof removed>>,
            boolean
          >(removed, {
            ok: () => true,
            err: () => false,
          });
          if (($removedResultOk142481 ? "ok" : "error") === "ok") publishEntryOwned = false;
          return removed;
        },
        async () => {
          if (!sourceEntryOwned || !sourceIdentity || !fileApi || !operationDirectoryHandle) {
            return Result.ok(undefined);
          }
          const owned = await this.assertTemporaryIdentity(sourceIdentity, operation);
          const $ownedResultOk142932 = Result.match<
            import("better-result").InferOk<NonNullable<typeof owned>>,
            import("better-result").InferErr<NonNullable<typeof owned>>,
            boolean
          >(owned, {
            ok: () => true,
            err: () => false,
          });
          if (($ownedResultOk142932 ? "ok" : "error") === "error") {
            sourceEntryOwned = false;
            return owned;
          }
          const removed = unlinkAt(
            fileApi,
            operationDirectoryHandle.fd,
            sourceName,
            false,
            operation,
          );
          const $removedResultOk143137 = Result.match<
            import("better-result").InferOk<NonNullable<typeof removed>>,
            import("better-result").InferErr<NonNullable<typeof removed>>,
            boolean
          >(removed, {
            ok: () => true,
            err: () => false,
          });
          if (($removedResultOk143137 ? "ok" : "error") === "ok") sourceEntryOwned = false;
          return removed;
        },
        async () => {
          if (!sourceHandle) return Result.ok(undefined);
          const currentHandle = sourceHandle;
          sourceHandle = undefined;
          return await attemptHost(async () => await currentHandle.close());
        },
        async () => {
          if (!operationDirectoryOwned || !operationDirectoryIdentity) return Result.ok(undefined);
          const owned = await this.assertTemporaryIdentity(operationDirectoryIdentity, operation);
          const $ownedResultOk143788 = Result.match<
            import("better-result").InferOk<NonNullable<typeof owned>>,
            import("better-result").InferErr<NonNullable<typeof owned>>,
            boolean
          >(owned, {
            ok: () => true,
            err: () => false,
          });
          if (($ownedResultOk143788 ? "ok" : "error") === "error") operationDirectoryOwned = false;
          return owned;
        },
        async () => {
          if (primary.status === "ok") return Result.ok(undefined);
          if (!this.beforePrivateFileCleanup) return Result.ok(undefined);
          // POSIX cannot remove an open directory by inode. Revoke pathname authority before the
          // seam because it may install a replacement and then throw.
          operationDirectoryOwned = false;
          const hooked = await attemptHost(
            async () => await this.beforePrivateFileCleanup?.(operation, sourcePath),
          );
          let $hookedResultError144372!: import("better-result").InferErr<
            NonNullable<typeof hooked>
          >;
          const $hookedResultOk144372 = Result.match<
            import("better-result").InferOk<NonNullable<typeof hooked>>,
            import("better-result").InferErr<NonNullable<typeof hooked>>,
            boolean
          >(hooked, {
            ok: () => true,
            err: (error) => {
              $hookedResultError144372 = error;
              return false;
            },
          });
          if (($hookedResultOk144372 ? "ok" : "error") === "error")
            return Result.err($hookedResultError144372);
          return failOwned({
            code: "ownership-mismatch",
            operation,
            message: "Refusing path-based operation-directory removal after cleanup seam",
          });
        },
        async () => {
          if (!operationDirectoryOwned) return Result.ok(undefined);
          let removed: WorkspaceHistoryResult<void>;
          if (fileApi && targetDirectoryHandle) {
            removed = unlinkAt(
              fileApi,
              targetDirectoryHandle.fd,
              operationDirectoryName,
              true,
              operation,
            );
          } else {
            removed = await attemptHost(() => rmdir(operationDirectory));
          }
          let $removedResultValue144868!: import("better-result").InferOk<
            NonNullable<typeof removed>
          >;
          let $removedResultError144868!: import("better-result").InferErr<
            NonNullable<typeof removed>
          >;
          const $removedResultOk144868 = Result.match<
            import("better-result").InferOk<NonNullable<typeof removed>>,
            import("better-result").InferErr<NonNullable<typeof removed>>,
            boolean
          >(removed, {
            ok: (value) => {
              $removedResultValue144868 = value;
              return true;
            },
            err: (error) => {
              $removedResultError144868 = error;
              return false;
            },
          });
          if (($removedResultOk144868 ? "ok" : "error") === "ok") operationDirectoryOwned = false;
          if (($removedResultOk144868 ? "ok" : "error") === "ok")
            return Result.ok($removedResultValue144868);
          if ($removedResultError144868.kind === "panic") return removed;
          return failOwned({
            code: "ownership-mismatch",
            operation,
            message: "Atomic-write operation directory contains an unowned replacement",
            cause: failureCause($removedResultError144868),
          });
        },
        async () => {
          if (!operationDirectoryHandle) return Result.ok(undefined);
          const currentHandle = operationDirectoryHandle;
          operationDirectoryHandle = undefined;
          return await attemptHost(async () => await currentHandle.close());
        },
        async () => {
          if (!targetDirectoryHandle) return Result.ok(undefined);
          const currentHandle = targetDirectoryHandle;
          targetDirectoryHandle = undefined;
          return await attemptHost(async () => await currentHandle.close());
        },
        async () => {
          if (!fileApi) return Result.ok(undefined);
          const currentApi = fileApi;
          fileApi = undefined;
          return attemptHostSync(() => currentApi.close());
        },
      ]);
      if (
        primary.status === "failed" &&
        hostErrorCode(primary.failure) === "EEXIST" &&
        cleanup.status === "ok"
      ) {
        continue;
      }
      const resolved = resolveOutcomeWithCleanup<void>(primary, cleanup, operation);
      switch (resolved.status) {
        case "ok":
          return Result.ok(undefined);
        case "failed":
          return Result.err(labelWorkspaceFailure(resolved.failure, operation));
        case "panic":
          return Result.err({ kind: "panic", cause: resolved.cause });
        case "defect":
          return await resolved.rejection.reject<WorkspaceHistoryResult<void>>();
      }
    }
    return failOwned({
      code: "filesystem-error",
      operation,
      message: "Unable to allocate an exclusive atomic-write temporary file",
    });
  }

  private async assertTemporaryIdentity(
    identity: OwnedTemporaryPath,
    operation: string,
  ): Promise<WorkspaceHistoryResult<void>> {
    const current = await lstatIfExists(identity.path, true);
    let $currentResultValue147467!: import("better-result").InferOk<NonNullable<typeof current>>;
    let $currentResultError147467!: import("better-result").InferErr<NonNullable<typeof current>>;
    const $currentResultOk147467 = Result.match<
      import("better-result").InferOk<NonNullable<typeof current>>,
      import("better-result").InferErr<NonNullable<typeof current>>,
      boolean
    >(current, {
      ok: (value) => {
        $currentResultValue147467 = value;
        return true;
      },
      err: (error) => {
        $currentResultError147467 = error;
        return false;
      },
    });
    if (($currentResultOk147467 ? "ok" : "error") === "error")
      return Result.err($currentResultError147467);
    if (
      !$currentResultValue147467 ||
      $currentResultValue147467.dev !== identity.dev ||
      $currentResultValue147467.ino !== identity.ino
    ) {
      return failOwned({
        code: "ownership-mismatch",
        operation,
        message: "Atomic-write owned path was replaced",
      });
    }
    return Result.ok(undefined);
  }

  private existingObjects(
    oids: ReadonlySet<string>,
    type: "blob" | "tree",
  ): Promise<WorkspaceHistoryResult<Set<string>>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      if (oids.size === 0) return Result.ok(new Set<string>());
      const ordered = [...oids].sort();
      const result = yield* Result.await(
        this.runPrivateGit(["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
          operation: "validate cached objects",
          input: new TextEncoder().encode(`${ordered.join("\n")}\n`),
        }),
      );
      const output = yield* bytesToText(result.stdout, "validate cached objects");
      const lines = output.trimEnd().split("\n");
      if (lines.length !== ordered.length) {
        return failOwned({
          code: "malformed-git-output",
          operation: "validate cached objects",
          message: "Git returned an unexpected cached-object result count",
        });
      }
      const existing = new Set<string>();
      for (const [index, expected] of ordered.entries()) {
        const line = lines[index];
        if (!line) continue;
        if (line === `${expected} ${type}`) existing.add(expected);
        else if (line !== `${expected} missing`) {
          return failOwned({
            code: "malformed-git-output",
            operation: "validate cached objects",
            message: "Git returned malformed cached-object output",
            detail: line.slice(0, 200),
          });
        }
      }
      return Result.ok(existing);
    }, this);
  }

  private async hashFile(
    absolutePath: string,
    write: boolean,
  ): Promise<WorkspaceHistoryResult<string>> {
    const args = ["hash-object"];
    if (write) args.push("-w");
    args.push("--no-filters", "--stdin");
    const opened = await attemptHost(() =>
      open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW),
    );
    let $openedResultValue149692!: import("better-result").InferOk<NonNullable<typeof opened>>;
    let $openedResultError149692!: import("better-result").InferErr<NonNullable<typeof opened>>;
    const $openedResultOk149692 = Result.match<
      import("better-result").InferOk<NonNullable<typeof opened>>,
      import("better-result").InferErr<NonNullable<typeof opened>>,
      boolean
    >(opened, {
      ok: (value) => {
        $openedResultValue149692 = value;
        return true;
      },
      err: (error) => {
        $openedResultError149692 = error;
        return false;
      },
    });
    if (($openedResultOk149692 ? "ok" : "error") === "error")
      return Result.err($openedResultError149692);
    const operation = "hash regular file";
    const primary = await superviseOutcome<string>(async () => {
      const hashed = await this.runPrivateGit(args, {
        operation,
        input: $openedResultValue149692.fd,
      });
      let $hashedResultValue149975!: import("better-result").InferOk<NonNullable<typeof hashed>>;
      let $hashedResultError149975!: import("better-result").InferErr<NonNullable<typeof hashed>>;
      const $hashedResultOk149975 = Result.match<
        import("better-result").InferOk<NonNullable<typeof hashed>>,
        import("better-result").InferErr<NonNullable<typeof hashed>>,
        boolean
      >(hashed, {
        ok: (value) => {
          $hashedResultValue149975 = value;
          return true;
        },
        err: (error) => {
          $hashedResultError149975 = error;
          return false;
        },
      });
      if (($hashedResultOk149975 ? "ok" : "error") === "error")
        return Result.err($hashedResultError149975);
      return parseOid($hashedResultValue149975.stdout, operation);
    });
    const cleanup = await runWorkspaceHistoryCleanup(operation, [
      async () => await attemptHost(async () => await $openedResultValue149692.close()),
    ]);
    const resolved = resolveOutcomeWithCleanup<string>(primary, cleanup, operation);
    switch (resolved.status) {
      case "ok":
        return Result.ok(resolved.value);
      case "failed":
        return Result.err(resolved.failure);
      case "panic":
        return Result.err({ kind: "panic", cause: resolved.cause });
      case "defect":
        return await resolved.rejection.reject<WorkspaceHistoryResult<string>>();
    }
  }

  private hashBytes(bytes: Uint8Array, write: boolean): Promise<WorkspaceHistoryResult<string>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const args = ["hash-object"];
      if (write) args.push("-w");
      args.push("--no-filters", "--stdin");
      const result = yield* Result.await(
        this.runPrivateGit(args, { operation: "hash workspace bytes", input: bytes }),
      );
      return parseOid(result.stdout, "hash workspace bytes");
    }, this);
  }

  private writeCaptureTree(
    entries: readonly TreeEntry[],
    cache: WorkspaceHistoryCaptureCache | undefined,
  ): Promise<WorkspaceHistoryResult<string>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      let retainedIndex = false;
      if (cache) {
        const indexStats = yield* Result.await(lstatIfExists(this.captureIndexPath));
        if (indexStats?.isFile() && !indexStats.isSymbolicLink()) {
          const result = await this.runPrivateGit(["ls-files", "--stage", "-z"], {
            operation: "validate retained capture index",
            indexPath: this.captureIndexPath,
          });
          let $resultResultValue151744!: import("better-result").InferOk<
            NonNullable<typeof result>
          >;
          let $resultResultError151744!: import("better-result").InferErr<
            NonNullable<typeof result>
          >;
          const $resultResultOk151744 = Result.match<
            import("better-result").InferOk<NonNullable<typeof result>>,
            import("better-result").InferErr<NonNullable<typeof result>>,
            boolean
          >(result, {
            ok: (value) => {
              $resultResultValue151744 = value;
              return true;
            },
            err: (error) => {
              $resultResultError151744 = error;
              return false;
            },
          });
          if (($resultResultOk151744 ? "ok" : "error") === "ok") {
            const records = yield* splitNul(
              $resultResultValue151744.stdout,
              "validate retained capture index",
            );
            const indexed = new Map<string, { mode: number; oid: string }>();
            for (const record of records) {
              const match = /^(\d+) ([0-9a-f]+) 0\t([\s\S]+)$/.exec(record);
              if (!match?.[1] || !match[2] || !match[3] || !OID_PATTERN.test(match[2])) {
                return failOwned({
                  code: "snapshot-invalid",
                  operation: "validate retained capture index",
                  message: "Retained capture index has malformed entries",
                });
              }
              indexed.set(match[3], { mode: Number.parseInt(match[1], 8), oid: match[2] });
            }
            retainedIndex =
              indexed.size === Object.keys(cache.entries).length &&
              Object.entries(cache.entries).every(([relativePath, cached]) => {
                const indexedEntry = indexed.get(relativePath);
                return indexedEntry?.mode === cached.mode && indexedEntry.oid === cached.oid;
              });
          } else {
            const failure = $resultResultError151744;
            const error = failure.kind === "owned" ? failure.error : undefined;
            const isCorruptIndex =
              error?.code === "git-command-failed" &&
              /(?:index file corrupt|index file smaller|bad index)/i.test(
                `${error.message}\n${error.detail ?? ""}`,
              );
            if (!isCorruptIndex) return Result.err($resultResultError151744);
          }
        }
      }
      if (!retainedIndex || !cache) {
        return await this.writeTree(entries, this.captureIndexPath);
      }

      const next = new Map(entries.map((entry) => [entry.relativePath, entry]));
      const records: string[] = [];
      for (const relativePath of Object.keys(cache.entries)) {
        if (!next.has(relativePath)) records.push(`0 ${"0".repeat(40)}\t${relativePath}\0`);
      }
      for (const entry of entries) {
        const cached = cache.entries[entry.relativePath];
        if (cached?.mode === entry.mode && cached.oid === entry.oid) continue;
        records.push(`${entry.mode.toString(8)} ${entry.oid}\t${entry.relativePath}\0`);
      }
      if (records.length === 0) {
        const exists = yield* Result.await(
          this.objectExistsUnlocked(cache.workspaceTreeOid, "tree"),
        );
        if (exists) return Result.ok(cache.workspaceTreeOid);
      }
      if (records.length > 0) {
        yield* Result.await(
          this.runPrivateGit(["update-index", "-z", "--index-info"], {
            operation: "reconcile retained capture index",
            indexPath: this.captureIndexPath,
            input: new TextEncoder().encode(records.join("")),
          }),
        );
      }
      const result = yield* Result.await(
        this.runPrivateGit(["write-tree"], {
          operation: "write retained capture index",
          indexPath: this.captureIndexPath,
        }),
      );
      return parseOid(result.stdout, "write retained capture index");
    }, this);
  }

  private writeWrapperTree(
    workspaceTreeOid: string,
    manifestBlobOid: string,
  ): Promise<WorkspaceHistoryResult<string>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const input = new TextEncoder().encode(
        `100644 blob ${manifestBlobOid}\tmanifest.json\0` +
          `040000 tree ${workspaceTreeOid}\tworkspace\0`,
      );
      const result = yield* Result.await(
        this.runPrivateGit(["mktree", "-z"], { operation: "write snapshot wrapper tree", input }),
      );
      return parseOid(result.stdout, "write snapshot wrapper tree");
    }, this);
  }

  private validateTargetPathSet(
    entries: ReadonlyMap<string, TreeEntry>,
  ): WorkspaceHistoryResult<void> {
    const seen = new Map<string, string>();
    const entryPaths = new Set(entries.keys());
    for (const relativePath of entries.keys()) {
      for (const ancestor of pathAncestors(relativePath)) {
        if (entryPaths.has(ancestor)) {
          return failOwned({
            code: "snapshot-invalid",
            operation: "validate snapshot paths",
            message: `Snapshot path ${relativePath} has file ancestor ${ancestor}`,
          });
        }
      }
      for (const candidate of [...pathAncestors(relativePath), relativePath]) {
        const comparisonKey =
          this.pathComparison === "case-insensitive" ? candidate.toLowerCase() : candidate;
        const previous = seen.get(comparisonKey);
        if (previous && previous !== candidate) {
          return failOwned({
            code: "snapshot-invalid",
            operation: "validate snapshot paths",
            message: `Snapshot paths collide under ${this.pathComparison} comparison: ${previous} and ${candidate}`,
          });
        }
        seen.set(comparisonKey, candidate);
      }
    }
    return Result.ok(undefined);
  }

  private requireObject(
    oid: string,
    type: "blob" | "tree",
    operation: string,
  ): Promise<WorkspaceHistoryResult<void>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const exists = yield* Result.await(this.objectExistsUnlocked(oid, type));
      if (!exists) {
        return failOwned({
          code: "snapshot-invalid",
          operation,
          message: `Private Git ${type} object is missing: ${oid}`,
        });
      }
      return Result.ok(undefined);
    }, this);
  }

  private listSnapshotRefsUnlocked(): Promise<WorkspaceHistoryResult<Map<string, string>>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const result = yield* Result.await(
        this.runPrivateGit(
          ["for-each-ref", "--format=%(refname) %(objectname)", SNAPSHOT_REF_PREFIX],
          { operation: "enumerate snapshot refs" },
        ),
      );
      const text = yield* bytesToText(result.stdout, "enumerate snapshot refs");
      const refs = new Map<string, string>();
      for (const line of text.split("\n")) {
        if (line === "") continue;
        const match = /^(refs\/mini-lilac\/snapshots\/[^ ]+) ([0-9a-f]+)$/.exec(line);
        if (!match?.[1] || !match[2] || !OID_PATTERN.test(match[2])) {
          return failOwned({
            code: "malformed-git-output",
            operation: "enumerate snapshot refs",
            message: "Git returned malformed snapshot-ref output",
            detail: line.slice(0, 200),
          });
        }
        refs.set(match[1], match[2]);
      }
      return Result.ok(refs);
    }, this);
  }

  private ensureSnapshotRefCreationMetadata(
    rootTreeOid: string,
    gitRef: string,
    preserveExistingAge: boolean,
  ): Promise<WorkspaceHistoryResult<WorkspaceHistorySnapshotRefCreated>> {
    const operation = "write snapshot-ref metadata";
    return (async (): Promise<WorkspaceHistoryResult<WorkspaceHistorySnapshotRefCreated>> => {
      if (preserveExistingAge) {
        const existing = await this.readSnapshotRefCreationMetadata(rootTreeOid, gitRef);
        let $existingResultValue158943!: import("better-result").InferOk<
          NonNullable<typeof existing>
        >;
        let $existingResultError158943!: import("better-result").InferErr<
          NonNullable<typeof existing>
        >;
        const $existingResultOk158943 = Result.match<
          import("better-result").InferOk<NonNullable<typeof existing>>,
          import("better-result").InferErr<NonNullable<typeof existing>>,
          boolean
        >(existing, {
          ok: (value) => {
            $existingResultValue158943 = value;
            return true;
          },
          err: (error) => {
            $existingResultError158943 = error;
            return false;
          },
        });
        if (($existingResultOk158943 ? "ok" : "error") === "error")
          return Result.err($existingResultError158943);
        if ($existingResultValue158943) return Result.ok($existingResultValue158943);
      }
      const hooked = await attemptHost(
        async () => await this.beforeSnapshotRefMetadataWrite?.(rootTreeOid),
      );
      let $hookedResultError159159!: import("better-result").InferErr<NonNullable<typeof hooked>>;
      const $hookedResultOk159159 = Result.match<
        import("better-result").InferOk<NonNullable<typeof hooked>>,
        import("better-result").InferErr<NonNullable<typeof hooked>>,
        boolean
      >(hooked, {
        ok: () => true,
        err: (error) => {
          $hookedResultError159159 = error;
          return false;
        },
      });
      if (($hookedResultOk159159 ? "ok" : "error") === "error")
        return Result.err($hookedResultError159159);
      const created = await attemptHost(() =>
        mkdir(this.snapshotRefCreationDirectory, { recursive: true, mode: 0o700 }),
      );
      let $createdResultError159338!: import("better-result").InferErr<NonNullable<typeof created>>;
      const $createdResultOk159338 = Result.match<
        import("better-result").InferOk<NonNullable<typeof created>>,
        import("better-result").InferErr<NonNullable<typeof created>>,
        boolean
      >(created, {
        ok: () => true,
        err: (error) => {
          $createdResultError159338 = error;
          return false;
        },
      });
      if (($createdResultOk159338 ? "ok" : "error") === "error")
        return Result.err($createdResultError159338);
      const safe = await this.assertNoSymlinkComponents(this.snapshotRefCreationDirectory, false);
      let $safeResultError159531!: import("better-result").InferErr<NonNullable<typeof safe>>;
      const $safeResultOk159531 = Result.match<
        import("better-result").InferOk<NonNullable<typeof safe>>,
        import("better-result").InferErr<NonNullable<typeof safe>>,
        boolean
      >(safe, {
        ok: () => true,
        err: (error) => {
          $safeResultError159531 = error;
          return false;
        },
      });
      if (($safeResultOk159531 ? "ok" : "error") === "error")
        return Result.err($safeResultError159531);
      const storeSynced = await this.fsyncDirectory(this.storeDirectory);
      let $storeSyncedResultError159678!: import("better-result").InferErr<
        NonNullable<typeof storeSynced>
      >;
      const $storeSyncedResultOk159678 = Result.match<
        import("better-result").InferOk<NonNullable<typeof storeSynced>>,
        import("better-result").InferErr<NonNullable<typeof storeSynced>>,
        boolean
      >(storeSynced, {
        ok: () => true,
        err: (error) => {
          $storeSyncedResultError159678 = error;
          return false;
        },
      });
      if (($storeSyncedResultOk159678 ? "ok" : "error") === "error")
        return Result.err($storeSyncedResultError159678);
      const metadataPath = this.snapshotRefCreationPath(rootTreeOid);
      const temporaryPath = path.join(
        this.snapshotRefCreationDirectory,
        `.${rootTreeOid}.${randomUUID()}.tmp`,
      );
      const metadata: WorkspaceHistorySnapshotRefCreated = {
        formatVersion: FORMAT_VERSION,
        rootTreeOid,
        gitRef,
        createdAtMs: this.now(),
      };
      const written = await this.writeAtomicPrivateFile(
        metadataPath,
        canonicalJson(metadata),
        operation,
        () => temporaryPath,
      );
      let $writtenResultError160201!: import("better-result").InferErr<NonNullable<typeof written>>;
      const $writtenResultOk160201 = Result.match<
        import("better-result").InferOk<NonNullable<typeof written>>,
        import("better-result").InferErr<NonNullable<typeof written>>,
        boolean
      >(written, {
        ok: () => true,
        err: (error) => {
          $writtenResultError160201 = error;
          return false;
        },
      });
      if (($writtenResultOk160201 ? "ok" : "error") === "error")
        return Result.err($writtenResultError160201);
      return Result.ok(metadata);
    })();
  }

  private runPrivateGit(
    args: readonly string[],
    options: {
      operation: string;
      acceptedExitCodes?: readonly number[];
      input?: GitInput;
      indexPath?: string;
    },
  ): Promise<WorkspaceHistoryResult<GitResult>> {
    return (async (): Promise<WorkspaceHistoryResult<GitResult>> => {
      const owned = await this.verifyOwnershipMarker();
      let $ownedResultError160789!: import("better-result").InferErr<NonNullable<typeof owned>>;
      const $ownedResultOk160789 = Result.match<
        import("better-result").InferOk<NonNullable<typeof owned>>,
        import("better-result").InferErr<NonNullable<typeof owned>>,
        boolean
      >(owned, {
        ok: () => true,
        err: (error) => {
          $ownedResultError160789 = error;
          return false;
        },
      });
      if (($ownedResultOk160789 ? "ok" : "error") === "error")
        return Result.err($ownedResultError160789);
      const primary = await superviseOutcome<GitResult>(async () => {
        const before = await attemptHost(async () => await this.beforePrivateGit?.(args));
        let $beforeResultError160967!: import("better-result").InferErr<NonNullable<typeof before>>;
        const $beforeResultOk160967 = Result.match<
          import("better-result").InferOk<NonNullable<typeof before>>,
          import("better-result").InferErr<NonNullable<typeof before>>,
          boolean
        >(before, {
          ok: () => true,
          err: (error) => {
            $beforeResultError160967 = error;
            return false;
          },
        });
        if (($beforeResultOk160967 ? "ok" : "error") === "error")
          return Result.err($beforeResultError160967);
        return await this.runGit(
          [
            `--git-dir=${this.storeDirectory}`,
            `--work-tree=${this.cwd}`,
            ...this.privateConfigArgs(),
            ...args,
          ],
          {
            ...options,
            env: options.indexPath ? { GIT_INDEX_FILE: options.indexPath } : undefined,
          },
        );
      });
      const cleanup = await runWorkspaceHistoryCleanup(options.operation, [
        async () => await attemptHost(async () => await this.afterPrivateGit?.(args)),
      ]);
      const resolved = resolveOutcomeWithCleanup<GitResult>(primary, cleanup, options.operation);
      switch (resolved.status) {
        case "ok":
          return Result.ok(resolved.value);
        case "failed":
          return Result.err(resolved.failure);
        case "panic":
          return Result.err({ kind: "panic", cause: resolved.cause });
        case "defect":
          return await resolved.rejection.reject<WorkspaceHistoryResult<GitResult>>();
      }
    })();
  }

  private readLiveEntry(
    relativePath: string,
    absolutePath: string,
  ): Promise<WorkspaceHistoryResult<ScannedEntry | undefined>> {
    return Result.gen(async function* () {
      const stats = yield* Result.await(lstatIfExists(absolutePath, true));
      if (!stats) return Result.ok(undefined);
      let kind: ScannedEntry["kind"];
      if (stats.isSymbolicLink()) kind = "symlink";
      else if (stats.isFile()) kind = "regular";
      else kind = "special";
      let mode: number;
      if (kind === "symlink") mode = POSIX_SYMLINK_MODE;
      else if (kind === "special") mode = 0;
      else if ((stats.mode & 0o111n) !== 0n) mode = POSIX_EXECUTABLE_MODE;
      else mode = POSIX_FILE_MODE;
      return Result.ok({
        relativePath,
        absolutePath,
        kind,
        mode,
        size: stats.size.toString(),
        mtimeNs: stats.mtimeNs.toString(),
        ctimeNs: stats.ctimeNs.toString(),
        dev: stats.dev.toString(),
        ino: stats.ino.toString(),
      });
    });
  }

  private checkOperationId(operationId: string, operation: string): WorkspaceHistoryResult<void> {
    if (SAFE_ID_PATTERN.test(operationId)) return Result.ok(undefined);
    return failOwned({
      code: "workspace-invalid",
      operation,
      message: "operationId must be an opaque 1-128 character ASCII identifier",
    });
  }

  private verifyExistingStoreOwnership(): Promise<WorkspaceHistoryResult<boolean>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const storeStats = yield* Result.await(lstatIfExists(this.storeDirectory));
      if (!storeStats) return Result.ok(false);
      if (!storeStats.isDirectory() || storeStats.isSymbolicLink()) {
        return failOwned({
          code: "ownership-mismatch",
          operation: "verify store ownership",
          message: "Private Git store is not an owned directory",
        });
      }
      yield* Result.await(this.verifyOwnershipMarker());
      return Result.ok(true);
    }, this);
  }

  private readRestorePlanManifest(
    operationId: string,
  ): Promise<WorkspaceHistoryResult<RestorePlanManifest>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      yield* this.checkOperationId(operationId, "read durable restore plan");
      const planPath = this.restorePlanPath(operationId);
      const stats = yield* Result.await(lstatIfExists(planPath));
      if (!stats || !stats.isFile() || stats.isSymbolicLink()) {
        return failOwned({
          code: "snapshot-invalid",
          operation: "read durable restore plan",
          message: `Durable restore plan does not exist: ${operationId}`,
        });
      }
      if (this.platform !== "linux" && this.platform !== "darwin") {
        return failOwned({
          code: "platform-unsupported",
          operation: "read durable restore plan",
          message: "Workspace history is supported only on Linux and macOS",
        });
      }
      const serialized = yield* Result.await(attemptHost(() => readFile(planPath, "utf8")));
      const decoded = this.decodeRestorePlan(serialized, operationId, this.platform);
      let $decodedResultValue165201!: import("better-result").InferOk<NonNullable<typeof decoded>>;
      let $decodedResultError165201!: import("better-result").InferErr<NonNullable<typeof decoded>>;
      const $decodedResultOk165201 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decoded>>,
        import("better-result").InferErr<NonNullable<typeof decoded>>,
        boolean
      >(decoded, {
        ok: (value) => {
          $decodedResultValue165201 = value;
          return true;
        },
        err: (error) => {
          $decodedResultError165201 = error;
          return false;
        },
      });
      if (($decodedResultOk165201 ? "ok" : "error") === "error")
        return failWith($decodedResultError165201);
      const manifest = $decodedResultValue165201;
      for (const entry of [...manifest.managedEntries, ...manifest.targetEntries]) {
        yield* checkSafeRelativePath(entry.relativePath, "read durable restore plan");
      }
      yield* this.signatureMap(manifest.managedSignatures);
      yield* this.signatureMap(manifest.ignoredSignatures);
      yield* this.signatureMap(manifest.protectedSignatures);
      return Result.ok(manifest);
    }, this);
  }

  private cleanupRestorePlanStaging(
    manifest: RestorePlanManifest,
  ): Promise<WorkspaceHistoryResult<void>> {
    const stagingDirectory = manifest.privateStagingDirectory;
    if (!stagingDirectory) return Promise.resolve(Result.ok(undefined));
    const temporaryRoot = path.join(this.storeDirectory, "temp");
    if (
      !this.isWithinOrEqual(temporaryRoot, stagingDirectory) ||
      !/^restore-[0-9a-f-]{36}$/.test(path.basename(stagingDirectory))
    ) {
      return Promise.resolve(Result.ok(undefined));
    }
    return attemptHost(() => rm(stagingDirectory, { recursive: true, force: true }));
  }

  private async fsyncDirectory(directory: string): Promise<WorkspaceHistoryResult<void>> {
    const operation = "sync directory";
    const opened = await attemptHost(() =>
      open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY),
    );
    let $openedResultValue166559!: import("better-result").InferOk<NonNullable<typeof opened>>;
    let $openedResultError166559!: import("better-result").InferErr<NonNullable<typeof opened>>;
    const $openedResultOk166559 = Result.match<
      import("better-result").InferOk<NonNullable<typeof opened>>,
      import("better-result").InferErr<NonNullable<typeof opened>>,
      boolean
    >(opened, {
      ok: (value) => {
        $openedResultValue166559 = value;
        return true;
      },
      err: (error) => {
        $openedResultError166559 = error;
        return false;
      },
    });
    if (($openedResultOk166559 ? "ok" : "error") === "error")
      return Result.err($openedResultError166559);
    const primary = await superviseOutcome(async () => {
      const synced = await attemptHost(async () => await $openedResultValue166559.sync());
      let $syncedResultError166789!: import("better-result").InferErr<NonNullable<typeof synced>>;
      const $syncedResultOk166789 = Result.match<
        import("better-result").InferOk<NonNullable<typeof synced>>,
        import("better-result").InferErr<NonNullable<typeof synced>>,
        boolean
      >(synced, {
        ok: () => true,
        err: (error) => {
          $syncedResultError166789 = error;
          return false;
        },
      });
      if (($syncedResultOk166789 ? "ok" : "error") === "error")
        return Result.err($syncedResultError166789);
      return Result.ok(undefined);
    });
    const cleanup = await runWorkspaceHistoryCleanup(operation, [
      async () => await attemptHost(async () => await $openedResultValue166559.close()),
    ]);
    const resolved = resolveOutcomeWithCleanup<void>(primary, cleanup, operation);
    switch (resolved.status) {
      case "ok":
        return Result.ok(undefined);
      case "failed":
        return Result.err(resolved.failure);
      case "panic":
        return Result.err({ kind: "panic", cause: resolved.cause });
      case "defect":
        return await resolved.rejection.reject<WorkspaceHistoryResult<void>>();
    }
  }

  private readSnapshot(
    rootTreeOid: string,
    rootAlreadyValidated = false,
  ): Promise<WorkspaceHistoryResult<ParsedSnapshot>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      if (!rootAlreadyValidated) {
        yield* Result.await(this.requireObject(rootTreeOid, "tree", "resolve snapshot wrapper"));
      }
      const wrapperResult = yield* Result.await(
        this.runPrivateGit(["ls-tree", "-z", rootTreeOid], {
          operation: "read snapshot wrapper",
        }),
      );
      const wrapperEntries = yield* this.parseLsTree(wrapperResult.stdout, "read snapshot wrapper");
      const manifestEntry = wrapperEntries.get("manifest.json");
      const workspaceEntry = wrapperEntries.get("workspace");
      if (
        wrapperEntries.size !== 2 ||
        !manifestEntry ||
        manifestEntry.mode !== POSIX_FILE_MODE ||
        !workspaceEntry ||
        workspaceEntry.mode !== 0o040000
      ) {
        return failOwned({
          code: "snapshot-invalid",
          operation: "read snapshot wrapper",
          message: "Snapshot wrapper does not contain exactly manifest.json and workspace/",
        });
      }
      const manifestResult = yield* Result.await(
        this.runPrivateGit(["cat-file", "blob", manifestEntry.oid], {
          operation: "read snapshot manifest",
        }),
      );
      const manifestText = yield* bytesToText(manifestResult.stdout, "read snapshot manifest");
      const manifest = this.decodeSnapshotManifest(manifestText);
      let $manifestResultError169011!: import("better-result").InferErr<
        NonNullable<typeof manifest>
      >;
      const $manifestResultOk169011 = Result.match<
        import("better-result").InferOk<NonNullable<typeof manifest>>,
        import("better-result").InferErr<NonNullable<typeof manifest>>,
        boolean
      >(manifest, {
        ok: () => true,
        err: (error) => {
          $manifestResultError169011 = error;
          return false;
        },
      });
      if (($manifestResultOk169011 ? "ok" : "error") === "error")
        return failWith($manifestResultError169011);
      const workspaceResult = yield* Result.await(
        this.runPrivateGit(["ls-tree", "-rz", workspaceEntry.oid], {
          operation: "read snapshot workspace tree",
        }),
      );
      const entries = yield* this.parseLsTree(
        workspaceResult.stdout,
        "read snapshot workspace tree",
      );
      for (const entry of entries.values()) {
        if (
          entry.mode !== POSIX_FILE_MODE &&
          entry.mode !== POSIX_EXECUTABLE_MODE &&
          entry.mode !== POSIX_SYMLINK_MODE
        ) {
          return failOwned({
            code: "snapshot-invalid",
            operation: "read snapshot workspace tree",
            message: `Snapshot has an unsupported entry mode at ${entry.relativePath}`,
          });
        }
        if (entry.relativePath.split("/").some((part) => this.isGitMetadataName(part))) {
          return failOwned({
            code: "snapshot-invalid",
            operation: "read snapshot workspace tree",
            message: "Snapshot attempts to contain Git metadata",
          });
        }
      }
      return Result.ok({
        rootTreeOid,
        workspaceTreeOid: workspaceEntry.oid,
        manifestBlobOid: manifestEntry.oid,
        manifestBytes: manifestResult.stdout,
        entries,
      });
    }, this);
  }

  private verifyTargetSnapshot(
    snapshot: ParsedSnapshot,
    classifyManagedExtras = true,
  ): Promise<WorkspaceHistoryResult<Map<string, ScannedEntry>>> {
    const operation = "verify restored workspace";
    return (async (): Promise<WorkspaceHistoryResult<Map<string, ScannedEntry>>> => {
      if (classifyManagedExtras) {
        const current = await this.classifyWorkspace();
        let $currentResultValue170788!: import("better-result").InferOk<
          NonNullable<typeof current>
        >;
        let $currentResultError170788!: import("better-result").InferErr<
          NonNullable<typeof current>
        >;
        const $currentResultOk170788 = Result.match<
          import("better-result").InferOk<NonNullable<typeof current>>,
          import("better-result").InferErr<NonNullable<typeof current>>,
          boolean
        >(current, {
          ok: (value) => {
            $currentResultValue170788 = value;
            return true;
          },
          err: (error) => {
            $currentResultError170788 = error;
            return false;
          },
        });
        if (($currentResultOk170788 ? "ok" : "error") === "error")
          return Result.err($currentResultError170788);
        const extraManagedPath = [...$currentResultValue170788.managed.keys()].find(
          (relativePath) => !snapshot.entries.has(relativePath),
        );
        if (extraManagedPath) {
          return failWith(
            this.verificationError(
              `Managed path is absent from target snapshot: ${extraManagedPath}`,
            ),
          );
        }
      }
      const verifiedEntries: TreeEntry[] = [];
      const verifiedTargetEntries = new Map<string, ScannedEntry>();
      for (const [relativePath, expected] of snapshot.entries) {
        const absolutePath = fromPosixPath(this.cwd, relativePath);
        const before = await this.readLiveEntry(relativePath, absolutePath);
        let $beforeResultValue171521!: import("better-result").InferOk<NonNullable<typeof before>>;
        let $beforeResultError171521!: import("better-result").InferErr<NonNullable<typeof before>>;
        const $beforeResultOk171521 = Result.match<
          import("better-result").InferOk<NonNullable<typeof before>>,
          import("better-result").InferErr<NonNullable<typeof before>>,
          boolean
        >(before, {
          ok: (value) => {
            $beforeResultValue171521 = value;
            return true;
          },
          err: (error) => {
            $beforeResultError171521 = error;
            return false;
          },
        });
        if (($beforeResultOk171521 ? "ok" : "error") === "error")
          return Result.err($beforeResultError171521);
        if (!$beforeResultValue171521) {
          return failWith(this.verificationError(`Target path is missing: ${relativePath}`));
        }
        let oid: WorkspaceHistoryResult<string>;
        if ($beforeResultValue171521.kind === "symlink") {
          const target = await attemptHost(() => readlink(absolutePath, { encoding: "buffer" }));
          let $targetResultValue171883!: import("better-result").InferOk<
            NonNullable<typeof target>
          >;
          let $targetResultError171883!: import("better-result").InferErr<
            NonNullable<typeof target>
          >;
          const $targetResultOk171883 = Result.match<
            import("better-result").InferOk<NonNullable<typeof target>>,
            import("better-result").InferErr<NonNullable<typeof target>>,
            boolean
          >(target, {
            ok: (value) => {
              $targetResultValue171883 = value;
              return true;
            },
            err: (error) => {
              $targetResultError171883 = error;
              return false;
            },
          });
          if (($targetResultOk171883 ? "ok" : "error") === "error")
            return Result.err($targetResultError171883);
          oid = await this.hashBytes($targetResultValue171883, false);
        } else if ($beforeResultValue171521.kind === "regular") {
          oid = await this.hashFile(absolutePath, false);
        } else {
          return failWith(
            this.verificationError(`Target path has the wrong type: ${relativePath}`),
          );
        }
        let $oidResultValue171783!: import("better-result").InferOk<NonNullable<typeof oid>>;
        let $oidResultError171783!: import("better-result").InferErr<NonNullable<typeof oid>>;
        const $oidResultOk171783 = Result.match<
          import("better-result").InferOk<NonNullable<typeof oid>>,
          import("better-result").InferErr<NonNullable<typeof oid>>,
          boolean
        >(oid, {
          ok: (value) => {
            $oidResultValue171783 = value;
            return true;
          },
          err: (error) => {
            $oidResultError171783 = error;
            return false;
          },
        });
        if (($oidResultOk171783 ? "ok" : "error") === "error")
          return Result.err($oidResultError171783);
        const after = await this.readLiveEntry(relativePath, absolutePath);
        let $afterResultValue172408!: import("better-result").InferOk<NonNullable<typeof after>>;
        let $afterResultError172408!: import("better-result").InferErr<NonNullable<typeof after>>;
        const $afterResultOk172408 = Result.match<
          import("better-result").InferOk<NonNullable<typeof after>>,
          import("better-result").InferErr<NonNullable<typeof after>>,
          boolean
        >(after, {
          ok: (value) => {
            $afterResultValue172408 = value;
            return true;
          },
          err: (error) => {
            $afterResultError172408 = error;
            return false;
          },
        });
        if (($afterResultOk172408 ? "ok" : "error") === "error")
          return Result.err($afterResultError172408);
        if (
          !$afterResultValue172408 ||
          !sameScannedFingerprint($beforeResultValue171521, $afterResultValue172408)
        ) {
          return failWith(
            this.verificationError(`Target path changed during verification: ${relativePath}`),
          );
        }
        if (
          $afterResultValue172408.mode !== expected.mode ||
          $oidResultValue171783 !== expected.oid
        ) {
          return failWith(
            this.verificationError(`Target path does not match snapshot: ${relativePath}`),
          );
        }
        verifiedEntries.push({
          relativePath,
          mode: $afterResultValue172408.mode,
          oid: $oidResultValue171783,
        });
        verifiedTargetEntries.set(relativePath, $afterResultValue172408);
      }

      const verifyIndex = path.join(this.storeDirectory, "verify.index");
      const primary = await superviseOutcome<Map<string, ScannedEntry>>(async () => {
        const workspaceTreeOid = await this.writeTree(verifiedEntries, verifyIndex);
        let $workspaceTreeOidResultValue173305!: import("better-result").InferOk<
          NonNullable<typeof workspaceTreeOid>
        >;
        let $workspaceTreeOidResultError173305!: import("better-result").InferErr<
          NonNullable<typeof workspaceTreeOid>
        >;
        const $workspaceTreeOidResultOk173305 = Result.match<
          import("better-result").InferOk<NonNullable<typeof workspaceTreeOid>>,
          import("better-result").InferErr<NonNullable<typeof workspaceTreeOid>>,
          boolean
        >(workspaceTreeOid, {
          ok: (value) => {
            $workspaceTreeOidResultValue173305 = value;
            return true;
          },
          err: (error) => {
            $workspaceTreeOidResultError173305 = error;
            return false;
          },
        });
        if (($workspaceTreeOidResultOk173305 ? "ok" : "error") === "error")
          return Result.err($workspaceTreeOidResultError173305);
        if ($workspaceTreeOidResultValue173305 !== snapshot.workspaceTreeOid) {
          return failWith(
            this.verificationError("Fresh workspace tree does not match target snapshot"),
          );
        }
        const manifestOid = await this.hashBytes(snapshot.manifestBytes, false);
        let $manifestOidResultValue173691!: import("better-result").InferOk<
          NonNullable<typeof manifestOid>
        >;
        let $manifestOidResultError173691!: import("better-result").InferErr<
          NonNullable<typeof manifestOid>
        >;
        const $manifestOidResultOk173691 = Result.match<
          import("better-result").InferOk<NonNullable<typeof manifestOid>>,
          import("better-result").InferErr<NonNullable<typeof manifestOid>>,
          boolean
        >(manifestOid, {
          ok: (value) => {
            $manifestOidResultValue173691 = value;
            return true;
          },
          err: (error) => {
            $manifestOidResultError173691 = error;
            return false;
          },
        });
        if (($manifestOidResultOk173691 ? "ok" : "error") === "error")
          return Result.err($manifestOidResultError173691);
        if ($manifestOidResultValue173691 !== snapshot.manifestBlobOid) {
          return failWith(this.verificationError("Snapshot manifest changed during restore"));
        }
        const wrapperOid = await this.writeWrapperTree(
          $workspaceTreeOidResultValue173305,
          $manifestOidResultValue173691,
        );
        let $wrapperOidResultValue174021!: import("better-result").InferOk<
          NonNullable<typeof wrapperOid>
        >;
        let $wrapperOidResultError174021!: import("better-result").InferErr<
          NonNullable<typeof wrapperOid>
        >;
        const $wrapperOidResultOk174021 = Result.match<
          import("better-result").InferOk<NonNullable<typeof wrapperOid>>,
          import("better-result").InferErr<NonNullable<typeof wrapperOid>>,
          boolean
        >(wrapperOid, {
          ok: (value) => {
            $wrapperOidResultValue174021 = value;
            return true;
          },
          err: (error) => {
            $wrapperOidResultError174021 = error;
            return false;
          },
        });
        if (($wrapperOidResultOk174021 ? "ok" : "error") === "error")
          return Result.err($wrapperOidResultError174021);
        if ($wrapperOidResultValue174021 !== snapshot.rootTreeOid) {
          return failWith(
            this.verificationError("Fresh wrapper tree does not match target snapshot"),
          );
        }
        return Result.ok(verifiedTargetEntries);
      });
      const cleanup = await runWorkspaceHistoryCleanup(operation, [
        async () => await attemptHost(() => rm(verifyIndex, { force: true })),
      ]);
      const resolved = resolveOutcomeWithCleanup<Map<string, ScannedEntry>>(
        primary,
        cleanup,
        operation,
      );
      switch (resolved.status) {
        case "ok":
          return Result.ok(resolved.value);
        case "failed":
          return Result.err(resolved.failure);
        case "panic":
          return Result.err({ kind: "panic", cause: resolved.cause });
        case "defect":
          return await resolved.rejection.reject<
            WorkspaceHistoryResult<Map<string, ScannedEntry>>
          >();
      }
    })();
  }

  private captureUnmanagedSignatures(
    current: ClassifiedWorkspace,
  ): Promise<WorkspaceHistoryResult<Map<string, string>>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const signatures = new Map<string, string>();
      for (const [relativePath, entry] of current.entries) {
        if (current.managed.has(relativePath)) continue;
        signatures.set(relativePath, yield* Result.await(this.entrySignature(entry)));
      }
      return Result.ok(signatures);
    }, this);
  }

  private captureProtectedSignatures(): Promise<WorkspaceHistoryResult<Map<string, string>>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const signatures = new Map<string, string>();
      const scan = async (absolutePath: string): Promise<WorkspaceHistoryResult<void>> => {
        if (!this.isWithinOrEqual(this.cwd, absolutePath)) return Result.ok(undefined);
        const relativePath = toPosixPath(path.relative(this.cwd, absolutePath));
        const stats = await lstatIfExists(absolutePath, true);
        let $statsResultValue176183!: import("better-result").InferOk<NonNullable<typeof stats>>;
        let $statsResultError176183!: import("better-result").InferErr<NonNullable<typeof stats>>;
        const $statsResultOk176183 = Result.match<
          import("better-result").InferOk<NonNullable<typeof stats>>,
          import("better-result").InferErr<NonNullable<typeof stats>>,
          boolean
        >(stats, {
          ok: (value) => {
            $statsResultValue176183 = value;
            return true;
          },
          err: (error) => {
            $statsResultError176183 = error;
            return false;
          },
        });
        if (($statsResultOk176183 ? "ok" : "error") === "error")
          return Result.err($statsResultError176183);
        if (!$statsResultValue176183) return Result.ok(undefined);
        if ($statsResultValue176183.isDirectory() && !$statsResultValue176183.isSymbolicLink()) {
          signatures.set(
            relativePath,
            `directory:${$statsResultValue176183.mode}:${$statsResultValue176183.dev}:${$statsResultValue176183.ino}`,
          );
          const children = await attemptHost(() => readdir(absolutePath));
          let $childrenResultValue176577!: import("better-result").InferOk<
            NonNullable<typeof children>
          >;
          let $childrenResultError176577!: import("better-result").InferErr<
            NonNullable<typeof children>
          >;
          const $childrenResultOk176577 = Result.match<
            import("better-result").InferOk<NonNullable<typeof children>>,
            import("better-result").InferErr<NonNullable<typeof children>>,
            boolean
          >(children, {
            ok: (value) => {
              $childrenResultValue176577 = value;
              return true;
            },
            err: (error) => {
              $childrenResultError176577 = error;
              return false;
            },
          });
          if (($childrenResultOk176577 ? "ok" : "error") === "error")
            return Result.err($childrenResultError176577);
          for (const child of $childrenResultValue176577) {
            const scanned = await scan(path.join(absolutePath, child));
            let $scannedResultError176762!: import("better-result").InferErr<
              NonNullable<typeof scanned>
            >;
            const $scannedResultOk176762 = Result.match<
              import("better-result").InferOk<NonNullable<typeof scanned>>,
              import("better-result").InferErr<NonNullable<typeof scanned>>,
              boolean
            >(scanned, {
              ok: () => true,
              err: (error) => {
                $scannedResultError176762 = error;
                return false;
              },
            });
            if (($scannedResultOk176762 ? "ok" : "error") === "error")
              return Result.err($scannedResultError176762);
          }
          return Result.ok(undefined);
        }
        const entry = await this.readLiveEntry(relativePath, absolutePath);
        let $entryResultValue176951!: import("better-result").InferOk<NonNullable<typeof entry>>;
        let $entryResultError176951!: import("better-result").InferErr<NonNullable<typeof entry>>;
        const $entryResultOk176951 = Result.match<
          import("better-result").InferOk<NonNullable<typeof entry>>,
          import("better-result").InferErr<NonNullable<typeof entry>>,
          boolean
        >(entry, {
          ok: (value) => {
            $entryResultValue176951 = value;
            return true;
          },
          err: (error) => {
            $entryResultError176951 = error;
            return false;
          },
        });
        if (($entryResultOk176951 ? "ok" : "error") === "error")
          return Result.err($entryResultError176951);
        if ($entryResultValue176951) {
          const signature = await this.entrySignature($entryResultValue176951);
          let $signatureResultValue177108!: import("better-result").InferOk<
            NonNullable<typeof signature>
          >;
          let $signatureResultError177108!: import("better-result").InferErr<
            NonNullable<typeof signature>
          >;
          const $signatureResultOk177108 = Result.match<
            import("better-result").InferOk<NonNullable<typeof signature>>,
            import("better-result").InferErr<NonNullable<typeof signature>>,
            boolean
          >(signature, {
            ok: (value) => {
              $signatureResultValue177108 = value;
              return true;
            },
            err: (error) => {
              $signatureResultError177108 = error;
              return false;
            },
          });
          if (($signatureResultOk177108 ? "ok" : "error") === "error")
            return Result.err($signatureResultError177108);
          signatures.set(relativePath, $signatureResultValue177108);
        }
        return Result.ok(undefined);
      };
      for (const protectedPath of this.signatureProtectedPaths) {
        yield* Result.await(scan(protectedPath));
      }
      return Result.ok(signatures);
    }, this);
  }

  private preflightRestore(
    current: ClassifiedWorkspace,
    target: ReadonlyMap<string, TreeEntry>,
  ): Promise<WorkspaceHistoryResult<void>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const managedDirectories = new Set<string>();
      for (const relativePath of current.managed.keys()) {
        for (const ancestor of pathAncestors(relativePath)) managedDirectories.add(ancestor);
      }
      if (this.pathComparison === "case-insensitive") {
        const livePaths = new Map<string, string>();
        for (const livePath of [...current.entries.keys(), ...current.directories]) {
          const key = livePath.toLowerCase();
          const previous = livePaths.get(key);
          if (previous && previous !== livePath) {
            return failWith(
              this.restoreConflict(
                `Live paths collide under case-insensitive comparison: ${previous} and ${livePath}`,
              ),
            );
          }
          livePaths.set(key, livePath);
        }
        for (const relativePath of target.keys()) {
          for (const candidate of [...pathAncestors(relativePath), relativePath]) {
            const livePath = livePaths.get(candidate.toLowerCase());
            if (livePath && livePath !== candidate) {
              return failWith(
                this.restoreConflict(
                  `Target path ${candidate} collides with live path ${livePath}`,
                ),
              );
            }
          }
        }
      }

      for (const [relativePath, targetEntry] of target) {
        const absolutePath = fromPosixPath(this.cwd, relativePath);
        if (!this.isWithinOrEqual(this.cwd, absolutePath)) {
          return failWith(
            this.restoreConflict(`Target path escapes the workspace: ${relativePath}`),
          );
        }
        if (this.overlapsProtectedPath(absolutePath)) {
          const matches = yield* Result.await(this.liveEntryMatches(targetEntry));
          if (this.isProtectedAbsolutePath(absolutePath) && matches) continue;
          return failWith(
            this.restoreConflict(`Target path overlaps a protected path: ${relativePath}`),
          );
        }
        for (const boundary of current.boundaryRoots) {
          const comparedPath = this.comparisonPath(relativePath);
          const comparedBoundary = this.comparisonPath(boundary);
          if (
            comparedPath === comparedBoundary ||
            comparedPath.startsWith(`${comparedBoundary}/`) ||
            comparedBoundary.startsWith(`${comparedPath}/`)
          ) {
            return failWith(
              this.restoreConflict(`Target path overlaps nested Git repository ${boundary}`),
            );
          }
        }
        let blockedByManagedAncestor = false;
        for (const ancestor of pathAncestors(relativePath)) {
          const ancestorStats = yield* Result.await(
            lstatIfExists(fromPosixPath(this.cwd, ancestor)),
          );
          if (ancestorStats && !ancestorStats.isDirectory()) {
            if (!current.managed.has(ancestor)) {
              return failWith(
                this.restoreConflict(`Target traversal would replace unmanaged path ${ancestor}`),
              );
            }
            blockedByManagedAncestor = true;
            break;
          }
          if (current.ignoredDirectories.has(ancestor) && !managedDirectories.has(ancestor)) {
            return failWith(
              this.restoreConflict(`Target traversal would enter ignored directory ${ancestor}`),
            );
          }
        }
        const liveStats = blockedByManagedAncestor
          ? undefined
          : yield* Result.await(lstatIfExists(absolutePath));
        if (liveStats && !current.managed.has(relativePath)) {
          if (liveStats.isDirectory()) {
            if (current.ignoredDirectories.has(relativePath)) {
              return failWith(
                this.restoreConflict(
                  `Target type change would remove ignored directory ${relativePath}`,
                ),
              );
            }
            const prefix = `${relativePath}/`;
            const unmanagedDescendant = [...current.entries.keys()].find(
              (candidate) => candidate.startsWith(prefix) && !current.managed.has(candidate),
            );
            if (unmanagedDescendant) {
              return failWith(
                this.restoreConflict(
                  `Target type change would remove unmanaged path ${unmanagedDescendant}`,
                ),
              );
            }
          } else if (!(yield* Result.await(this.liveEntryMatches(targetEntry)))) {
            return failWith(
              this.restoreConflict(
                `Target would replace ignored or unmanaged path ${relativePath}`,
              ),
            );
          }
        }
      }
      return Result.ok(undefined);
    }, this);
  }

  private captureLiveSignatures(
    current: ClassifiedWorkspace,
  ): Promise<WorkspaceHistoryResult<Map<string, string>>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const signatures = new Map<string, string>();
      for (const [relativePath, entry] of current.entries) {
        signatures.set(relativePath, yield* Result.await(this.entrySignature(entry)));
      }
      return Result.ok(signatures);
    }, this);
  }

  private workspaceIdentity(): Promise<WorkspaceHistoryResult<string>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const stats = yield* Result.await(attemptHost(() => lstat(this.cwd, { bigint: true })));
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        return failWith(this.restoreConflict("Workspace root is no longer a real directory"));
      }
      return Result.ok(`${stats.dev}:${stats.ino}`);
    }, this);
  }

  private stageSnapshot(snapshot: ParsedSnapshot): Promise<
    WorkspaceHistoryResult<{
      stagingDirectory: string;
      stagedEntries: Map<string, StagedTreeEntry>;
    }>
  > {
    const operation = "stage snapshot";
    return (async (): Promise<
      WorkspaceHistoryResult<{
        stagingDirectory: string;
        stagedEntries: Map<string, StagedTreeEntry>;
      }>
    > => {
      const temporaryRoot = path.join(this.storeDirectory, "temp");
      const rootSafe = await this.assertNoSymlinkComponents(temporaryRoot, true);
      let $rootSafeResultError183858!: import("better-result").InferErr<
        NonNullable<typeof rootSafe>
      >;
      const $rootSafeResultOk183858 = Result.match<
        import("better-result").InferOk<NonNullable<typeof rootSafe>>,
        import("better-result").InferErr<NonNullable<typeof rootSafe>>,
        boolean
      >(rootSafe, {
        ok: () => true,
        err: (error) => {
          $rootSafeResultError183858 = error;
          return false;
        },
      });
      if (($rootSafeResultOk183858 ? "ok" : "error") === "error")
        return Result.err($rootSafeResultError183858);
      const rootCreated = await attemptHost(() =>
        mkdir(temporaryRoot, { recursive: true, mode: 0o700 }),
      );
      let $rootCreatedResultError183996!: import("better-result").InferErr<
        NonNullable<typeof rootCreated>
      >;
      const $rootCreatedResultOk183996 = Result.match<
        import("better-result").InferOk<NonNullable<typeof rootCreated>>,
        import("better-result").InferErr<NonNullable<typeof rootCreated>>,
        boolean
      >(rootCreated, {
        ok: () => true,
        err: (error) => {
          $rootCreatedResultError183996 = error;
          return false;
        },
      });
      if (($rootCreatedResultOk183996 ? "ok" : "error") === "error")
        return Result.err($rootCreatedResultError183996);
      const createdRootSafe = await this.assertNoSymlinkComponents(temporaryRoot, false);
      let $createdRootSafeResultError184181!: import("better-result").InferErr<
        NonNullable<typeof createdRootSafe>
      >;
      const $createdRootSafeResultOk184181 = Result.match<
        import("better-result").InferOk<NonNullable<typeof createdRootSafe>>,
        import("better-result").InferErr<NonNullable<typeof createdRootSafe>>,
        boolean
      >(createdRootSafe, {
        ok: () => true,
        err: (error) => {
          $createdRootSafeResultError184181 = error;
          return false;
        },
      });
      if (($createdRootSafeResultOk184181 ? "ok" : "error") === "error")
        return Result.err($createdRootSafeResultError184181);
      const stagingDirectory = path.join(temporaryRoot, `restore-${randomUUID()}`);
      const stagingCreated = await attemptHost(() => mkdir(stagingDirectory, { mode: 0o700 }));
      let $stagingCreatedResultError184425!: import("better-result").InferErr<
        NonNullable<typeof stagingCreated>
      >;
      const $stagingCreatedResultOk184425 = Result.match<
        import("better-result").InferOk<NonNullable<typeof stagingCreated>>,
        import("better-result").InferErr<NonNullable<typeof stagingCreated>>,
        boolean
      >(stagingCreated, {
        ok: () => true,
        err: (error) => {
          $stagingCreatedResultError184425 = error;
          return false;
        },
      });
      if (($stagingCreatedResultOk184425 ? "ok" : "error") === "error")
        return Result.err($stagingCreatedResultError184425);
      const stagedEntries = new Map<string, StagedTreeEntry>();
      const primary = await superviseOutcome<{
        stagingDirectory: string;
        stagedEntries: Map<string, StagedTreeEntry>;
      }>(async () => {
        let position = 0;
        for (const entry of [...snapshot.entries.values()].sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath),
        )) {
          const stagingPath = path.join(stagingDirectory, `entry-${position}`);
          position += 1;
          const opened = await attemptHost(() =>
            open(
              stagingPath,
              fsConstants.O_CREAT |
                fsConstants.O_EXCL |
                fsConstants.O_WRONLY |
                fsConstants.O_NOFOLLOW,
              0o600,
            ),
          );
          let $openedResultValue185102!: import("better-result").InferOk<
            NonNullable<typeof opened>
          >;
          let $openedResultError185102!: import("better-result").InferErr<
            NonNullable<typeof opened>
          >;
          const $openedResultOk185102 = Result.match<
            import("better-result").InferOk<NonNullable<typeof opened>>,
            import("better-result").InferErr<NonNullable<typeof opened>>,
            boolean
          >(opened, {
            ok: (value) => {
              $openedResultValue185102 = value;
              return true;
            },
            err: (error) => {
              $openedResultError185102 = error;
              return false;
            },
          });
          if (($openedResultOk185102 ? "ok" : "error") === "error")
            return Result.err($openedResultError185102);
          const staged = await superviseOutcome<void>(async () => {
            const copied = await this.runPrivateGitToHandle(
              ["cat-file", "blob", entry.oid],
              $openedResultValue185102.fd,
              { operation: "stage snapshot blob" },
            );
            let $copiedResultError185541!: import("better-result").InferErr<
              NonNullable<typeof copied>
            >;
            const $copiedResultOk185541 = Result.match<
              import("better-result").InferOk<NonNullable<typeof copied>>,
              import("better-result").InferErr<NonNullable<typeof copied>>,
              boolean
            >(copied, {
              ok: () => true,
              err: (error) => {
                $copiedResultError185541 = error;
                return false;
              },
            });
            if (($copiedResultOk185541 ? "ok" : "error") === "error")
              return Result.err($copiedResultError185541);
            return await attemptHost(async () => await $openedResultValue185102.sync());
          });
          const closed = await runWorkspaceHistoryCleanup(operation, [
            async () => await attemptHost(async () => await $openedResultValue185102.close()),
          ]);
          const stagedAndClosed = resolveOutcomeWithCleanup<void>(staged, closed, operation);
          switch (stagedAndClosed.status) {
            case "ok":
              break;
            case "failed":
              return Result.err(stagedAndClosed.failure);
            case "panic":
              return Result.err({ kind: "panic", cause: stagedAndClosed.cause });
            case "defect":
              return await stagedAndClosed.rejection.reject<WorkspaceHistoryResult<never>>();
          }
          const oid = await this.hashFile(stagingPath, false);
          let $oidResultValue186570!: import("better-result").InferOk<NonNullable<typeof oid>>;
          let $oidResultError186570!: import("better-result").InferErr<NonNullable<typeof oid>>;
          const $oidResultOk186570 = Result.match<
            import("better-result").InferOk<NonNullable<typeof oid>>,
            import("better-result").InferErr<NonNullable<typeof oid>>,
            boolean
          >(oid, {
            ok: (value) => {
              $oidResultValue186570 = value;
              return true;
            },
            err: (error) => {
              $oidResultError186570 = error;
              return false;
            },
          });
          if (($oidResultOk186570 ? "ok" : "error") === "error")
            return Result.err($oidResultError186570);
          if ($oidResultValue186570 !== entry.oid) {
            return failOwned({
              code: "snapshot-invalid",
              operation: "stage snapshot blob",
              message: `Staged blob does not match target object at ${entry.relativePath}`,
            });
          }
          if (entry.mode === POSIX_SYMLINK_MODE) {
            const payload = await attemptHost(() => readFile(stagingPath));
            let $payloadResultValue187034!: import("better-result").InferOk<
              NonNullable<typeof payload>
            >;
            let $payloadResultError187034!: import("better-result").InferErr<
              NonNullable<typeof payload>
            >;
            const $payloadResultOk187034 = Result.match<
              import("better-result").InferOk<NonNullable<typeof payload>>,
              import("better-result").InferErr<NonNullable<typeof payload>>,
              boolean
            >(payload, {
              ok: (value) => {
                $payloadResultValue187034 = value;
                return true;
              },
              err: (error) => {
                $payloadResultError187034 = error;
                return false;
              },
            });
            if (($payloadResultOk187034 ? "ok" : "error") === "error")
              return Result.err($payloadResultError187034);
            if ($payloadResultValue187034.includes(0)) {
              return failOwned({
                code: "snapshot-invalid",
                operation: "stage symlink target",
                message: `Snapshot symlink target contains NUL at ${entry.relativePath}`,
              });
            }
          }
          stagedEntries.set(entry.relativePath, { ...entry, stagingPath });
        }
        return Result.ok({ stagingDirectory, stagedEntries });
      });
      if (primary.status === "ok") return Result.ok(primary.value);
      const cleanup = await runWorkspaceHistoryCleanup(operation, [
        async () => await attemptHost(() => rm(stagingDirectory, { recursive: true, force: true })),
      ]);
      const resolved = resolveOutcomeWithCleanup<{
        stagingDirectory: string;
        stagedEntries: Map<string, StagedTreeEntry>;
      }>(primary, cleanup, operation);
      switch (resolved.status) {
        case "ok":
          return Result.ok(resolved.value);
        case "failed":
          return Result.err(resolved.failure);
        case "panic":
          return Result.err({ kind: "panic", cause: resolved.cause });
        case "defect":
          return await resolved.rejection.reject<
            WorkspaceHistoryResult<{
              stagingDirectory: string;
              stagedEntries: Map<string, StagedTreeEntry>;
            }>
          >();
      }
    })();
  }

  private writeRestorePlanManifest(
    manifest: RestorePlanManifest,
  ): Promise<WorkspaceHistoryResult<void>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const existingStats = yield* Result.await(
        lstatIfExists(this.restorePlanPath(manifest.operationId)),
      );
      const existing = existingStats
        ? yield* Result.await(this.readRestorePlanManifest(manifest.operationId))
        : undefined;
      if (
        existing &&
        (existing.sourceRootTreeOid !== manifest.sourceRootTreeOid ||
          existing.targetRootTreeOid !== manifest.targetRootTreeOid)
      ) {
        return failWith(
          this.restoreConflict("operationId is already bound to a different restore plan"),
        );
      }
      yield* Result.await(
        attemptHost(() => mkdir(this.restorePlanDirectory, { recursive: true, mode: 0o700 })),
      );
      yield* Result.await(this.assertNoSymlinkComponents(this.restorePlanDirectory, false));
      const temporaryPath = path.join(
        this.restorePlanDirectory,
        `.${manifest.operationId}.${randomUUID()}.tmp`,
      );
      return await this.writeAtomicPrivateFile(
        this.restorePlanPath(manifest.operationId),
        canonicalJson(manifest),
        "write durable restore plan",
        () => temporaryPath,
      );
    }, this);
  }

  private signatureMap(
    records: readonly RestorePlanManifest["ignoredSignatures"][number][],
  ): WorkspaceHistoryResult<Map<string, string>> {
    const signatures = new Map<string, string>();
    for (const record of records) {
      const safe = checkSafeRelativePath(record.relativePath, "read durable restore plan");
      let $safeResultError190184!: import("better-result").InferErr<NonNullable<typeof safe>>;
      const $safeResultOk190184 = Result.match<
        import("better-result").InferOk<NonNullable<typeof safe>>,
        import("better-result").InferErr<NonNullable<typeof safe>>,
        boolean
      >(safe, {
        ok: () => true,
        err: (error) => {
          $safeResultError190184 = error;
          return false;
        },
      });
      if (($safeResultOk190184 ? "ok" : "error") === "error")
        return Result.err($safeResultError190184);
      if (signatures.has(record.relativePath)) {
        return failOwned({
          code: "snapshot-invalid",
          operation: "read durable restore plan",
          message: `Durable restore plan repeats path ${record.relativePath}`,
        });
      }
      signatures.set(record.relativePath, record.signature);
    }
    return Result.ok(signatures);
  }

  private assertFrozenSourceIntact(
    manifest: RestorePlanManifest,
  ): Promise<WorkspaceHistoryResult<void>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const managedSignatures = yield* this.signatureMap(manifest.managedSignatures);
      yield* Result.await(
        this.verifyFrozenSignatures(
          managedSignatures,
          "Managed source changed before recovery activation",
        ),
      );
      const ignoredSignatures = yield* this.signatureMap(manifest.ignoredSignatures);
      yield* Result.await(
        this.verifyFrozenSignatures(
          ignoredSignatures,
          "Ignored source changed before recovery activation",
        ),
      );
      const managedPaths = new Set(manifest.managedEntries.map((entry) => entry.relativePath));
      for (const target of manifest.targetEntries) {
        if (managedPaths.has(target.relativePath) || ignoredSignatures.has(target.relativePath)) {
          continue;
        }
        const stats = yield* Result.await(
          lstatIfExists(fromPosixPath(this.cwd, target.relativePath)),
        );
        if (stats) {
          return failWith(
            this.restoreConflict(
              `Target progress exists before protected baseline activation: ${target.relativePath}`,
            ),
          );
        }
      }
      return Result.ok(undefined);
    }, this);
  }

  private verifyFrozenRestoredSnapshot(
    prepared: PreparedRestoreData,
  ): Promise<WorkspaceHistoryResult<Map<string, ScannedEntry>>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const verifiedTargetEntries = yield* Result.await(
        this.verifyTargetSnapshot(prepared.snapshot, false),
      );
      for (const relativePath of prepared.current.managed.keys()) {
        if (prepared.snapshot.entries.has(relativePath)) continue;
        if (
          pathAncestors(relativePath).some((ancestor) => prepared.snapshot.entries.has(ancestor))
        ) {
          continue;
        }
        const stats = yield* Result.await(lstatIfExists(fromPosixPath(this.cwd, relativePath)));
        const isTargetDirectory = [...prepared.snapshot.entries.keys()].some((candidate) =>
          candidate.startsWith(`${relativePath}/`),
        );
        if (stats && !(isTargetDirectory && stats.isDirectory())) {
          return failWith(
            this.verificationError(`Removed managed path still exists: ${relativePath}`),
          );
        }
      }
      yield* Result.await(
        this.verifyFrozenSignatures(prepared.preservation, "Ignored path changed during restore"),
      );
      yield* Result.await(this.verifyProtectedSignatures(prepared.protectedSignatures));
      return Result.ok(verifiedTargetEntries);
    }, this);
  }

  private async disposePreparedRestore(
    prepared: PreparedRestoreData,
  ): Promise<WorkspaceHistoryResult<void>> {
    const operation = "dispose prepared workspace restore";
    const hooked = await attemptHost(async () => await this.beforePreparedRestoreDispose?.());
    let $hookedResultError193649!: import("better-result").InferErr<NonNullable<typeof hooked>>;
    const $hookedResultOk193649 = Result.match<
      import("better-result").InferOk<NonNullable<typeof hooked>>,
      import("better-result").InferErr<NonNullable<typeof hooked>>,
      boolean
    >(hooked, {
      ok: () => true,
      err: (error) => {
        $hookedResultError193649 = error;
        return false;
      },
    });
    if (($hookedResultOk193649 ? "ok" : "error") === "error")
      return Result.err(labelWorkspaceFailure($hookedResultError193649, operation));
    if (prepared.state === "disposed") return Result.ok(undefined);
    prepared.state = prepared.state === "applied" ? "applied" : "disposed";
    const destinationCleaned = await this.cleanupDestinationArtifacts(
      prepared.ownedTemps,
      prepared.ownedDirectories,
      prepared.workspaceIdentity,
    );
    let $destinationCleanedResultError193996!: import("better-result").InferErr<
      NonNullable<typeof destinationCleaned>
    >;
    const $destinationCleanedResultOk193996 = Result.match<
      import("better-result").InferOk<NonNullable<typeof destinationCleaned>>,
      import("better-result").InferErr<NonNullable<typeof destinationCleaned>>,
      boolean
    >(destinationCleaned, {
      ok: () => true,
      err: (error) => {
        $destinationCleanedResultError193996 = error;
        return false;
      },
    });
    if (($destinationCleanedResultOk193996 ? "ok" : "error") === "error") {
      return Result.err(labelWorkspaceFailure($destinationCleanedResultError193996, operation));
    }
    const staleCleaned = await this.cleanupStaleRestoreArtifactsLocked();
    let $staleCleanedResultError194308!: import("better-result").InferErr<
      NonNullable<typeof staleCleaned>
    >;
    const $staleCleanedResultOk194308 = Result.match<
      import("better-result").InferOk<NonNullable<typeof staleCleaned>>,
      import("better-result").InferErr<NonNullable<typeof staleCleaned>>,
      boolean
    >(staleCleaned, {
      ok: () => true,
      err: (error) => {
        $staleCleanedResultError194308 = error;
        return false;
      },
    });
    if (($staleCleanedResultOk194308 ? "ok" : "error") === "error") {
      return Result.err(labelWorkspaceFailure($staleCleanedResultError194308, operation));
    }
    const stagingRemoved = await attemptHost(() =>
      rm(prepared.stagingDirectory, { recursive: true, force: true }),
    );
    let $stagingRemovedResultError194510!: import("better-result").InferErr<
      NonNullable<typeof stagingRemoved>
    >;
    const $stagingRemovedResultOk194510 = Result.match<
      import("better-result").InferOk<NonNullable<typeof stagingRemoved>>,
      import("better-result").InferErr<NonNullable<typeof stagingRemoved>>,
      boolean
    >(stagingRemoved, {
      ok: () => true,
      err: (error) => {
        $stagingRemovedResultError194510 = error;
        return false;
      },
    });
    if (($stagingRemovedResultOk194510 ? "ok" : "error") === "error") {
      return Result.err(labelWorkspaceFailure($stagingRemovedResultError194510, operation));
    }
    return Result.ok(undefined);
  }

  private objectExistsUnlocked(
    oid: string,
    type: "blob" | "tree" | "object",
  ): Promise<WorkspaceHistoryResult<boolean>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const actualType = yield* Result.await(this.objectTypeUnlocked(oid));
      return Result.ok(actualType !== undefined && (type === "object" || actualType === type));
    }, this);
  }

  private checkExpectedRootTreeOids(
    expectedRootTreeOids: readonly string[],
  ): WorkspaceHistoryResult<Set<string>> {
    const uniqueExpected = new Set<string>();
    for (const rootTreeOid of expectedRootTreeOids) {
      if (!OID_PATTERN.test(rootTreeOid)) {
        return failOwned({
          code: "snapshot-invalid",
          operation: "reconcile expected snapshot refs",
          message: `Expected snapshot has an invalid object ID: ${rootTreeOid}`,
        });
      }
      uniqueExpected.add(rootTreeOid);
    }
    return Result.ok(uniqueExpected);
  }

  private reconcileExpectedSnapshotRefsUnlocked(
    uniqueExpected: ReadonlySet<string>,
  ): Promise<
    WorkspaceHistoryResult<Extract<WorkspaceHistoryRefReconciliation, { status: "reconciled" }>>
  > {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const refs = yield* Result.await(this.listSnapshotRefsUnlocked());
      const graphResults = yield* Result.await(this.validateSnapshotGraphs([...uniqueExpected]));
      const expected: WorkspaceHistoryExpectedRefResult[] = [];
      for (const rootTreeOid of uniqueExpected) {
        const gitRef = this.snapshotRef(rootTreeOid);
        const graph = graphResults.get(rootTreeOid);
        if (!graph) {
          return failOwned({
            code: "filesystem-error",
            operation: "reconcile expected snapshot refs",
            message: `Snapshot graph validation omitted expected root: ${rootTreeOid}`,
          });
        }
        if (graph.status !== "valid") {
          expected.push({ rootTreeOid, gitRef, status: graph.status });
          continue;
        }
        if (refs.get(gitRef) === rootTreeOid) {
          yield* Result.await(this.ensureSnapshotRefCreationMetadata(rootTreeOid, gitRef, true));
          expected.push({ rootTreeOid, gitRef, status: "present" });
          continue;
        }
        yield* Result.await(this.ensureSnapshotRefCreationMetadata(rootTreeOid, gitRef, false));
        yield* Result.await(
          attemptHost(async () => await this.afterSnapshotRefMetadataWriteBeforeRef?.(rootTreeOid)),
        );
        yield* Result.await(
          this.runPrivateGit(["update-ref", gitRef, rootTreeOid], {
            operation: "repair expected snapshot ref",
          }),
        );
        yield* Result.await(
          attemptHost(async () => await this.afterSnapshotRefPublication?.(rootTreeOid)),
        );
        expected.push({ rootTreeOid, gitRef, status: "repaired" });
      }
      const expectedRefs = new Set([...uniqueExpected].map((oid) => this.snapshotRef(oid)));
      return Result.ok({
        status: "reconciled" as const,
        expected,
        orphanRefs: [...refs.keys()].filter((gitRef) => !expectedRefs.has(gitRef)).sort(),
      });
    }, this);
  }

  private cleanupOrphanSnapshotRefsUnlocked(
    uniqueExpected: ReadonlySet<string>,
    gracePeriodMs: number,
  ): Promise<
    WorkspaceHistoryResult<Extract<WorkspaceHistoryOrphanCleanupResult, { status: "cleaned" }>>
  > {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const reconciliation = yield* Result.await(
        this.reconcileExpectedSnapshotRefsUnlocked(uniqueExpected),
      );
      const refs = yield* Result.await(this.listSnapshotRefsUnlocked());
      const expectedRefs = new Set([...uniqueExpected].map((oid) => this.snapshotRef(oid)));
      const removedOrphanRefs: string[] = [];
      const preservedOrphanRefs: string[] = [];
      let metadataRemoved = false;
      const cutoff = this.now() - gracePeriodMs;
      for (const gitRef of [...refs.keys()].filter((ref) => !expectedRefs.has(ref)).sort()) {
        const rootTreeOid = refs.get(gitRef);
        if (!rootTreeOid) continue;
        const metadata = yield* Result.await(
          this.readSnapshotRefCreationMetadata(rootTreeOid, gitRef),
        );
        if (!metadata || metadata.createdAtMs >= cutoff) {
          preservedOrphanRefs.push(gitRef);
          continue;
        }
        yield* Result.await(
          this.runPrivateGit(["update-ref", "-d", gitRef, rootTreeOid], {
            operation: "delete orphan snapshot ref",
          }),
        );
        yield* Result.await(
          attemptHost(() => rm(this.snapshotRefCreationPath(rootTreeOid), { force: true })),
        );
        refs.delete(gitRef);
        metadataRemoved = true;
        removedOrphanRefs.push(gitRef);
      }
      const cleanedMetadata = yield* Result.await(
        this.cleanupUnreferencedSnapshotMetadata(refs, cutoff),
      );
      if (cleanedMetadata) metadataRemoved = true;
      if (metadataRemoved)
        yield* Result.await(this.fsyncDirectory(this.snapshotRefCreationDirectory));
      return Result.ok({
        status: "cleaned" as const,
        expected: reconciliation.expected,
        removedOrphanRefs,
        preservedOrphanRefs,
      });
    }, this);
  }

  private verifyNoAlternates(): Promise<WorkspaceHistoryResult<void>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const alternatesPath = path.join(this.storeDirectory, "objects", "info", "alternates");
      const stats = yield* Result.await(lstatIfExists(alternatesPath));
      if (stats) {
        return failOwned({
          code: "ownership-mismatch",
          operation: "verify private Git isolation",
          message: "Private Git store must not use object alternates",
        });
      }
      return Result.ok(undefined);
    }, this);
  }

  private getObjectAccountingUnlocked(): Promise<
    WorkspaceHistoryResult<WorkspaceHistoryObjectAccounting>
  > {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      const result = yield* Result.await(
        this.runPrivateGit(["count-objects", "-v"], {
          operation: "account private Git objects",
        }),
      );
      return parseObjectAccounting(result.stdout);
    }, this);
  }

  private storeRemovalRefusalReason(
    uniqueExpected: ReadonlySet<string>,
    canRemoveStore: () => Promise<boolean> | boolean,
  ): Promise<WorkspaceHistoryResult<WorkspaceHistoryStoreRemovalRefusalReason | undefined>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      if (uniqueExpected.size > 0) return Result.ok("expected-snapshots" as const);
      const refs = yield* Result.await(this.listSnapshotRefsUnlocked());
      if (refs.size > 0) return Result.ok("snapshot-refs" as const);
      if (yield* Result.await(this.directoryHasEntries(this.restorePlanDirectory))) {
        return Result.ok("restore-plans" as const);
      }
      if (yield* Result.await(this.directoryHasEntries(this.restoreOwnershipDirectory))) {
        return Result.ok("artifact-manifests" as const);
      }
      const removable = yield* Result.await(attemptHost(async () => await canRemoveStore()));
      return Result.ok(removable ? undefined : ("durable-work" as const));
    }, this);
  }

  private removeOwnedStore(): Promise<WorkspaceHistoryResult<void>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      yield* Result.await(this.verifyOwnershipMarker());
      const workspaceStoreRoot = path.dirname(this.storeDirectory);
      yield* Result.await(attemptHost(() => rm(this.storeDirectory, { recursive: true })));
      const removedParent = await attemptHost(() => rmdir(workspaceStoreRoot));
      let $removedParentResultError202506!: import("better-result").InferErr<
        NonNullable<typeof removedParent>
      >;
      const $removedParentResultOk202506 = Result.match<
        import("better-result").InferOk<NonNullable<typeof removedParent>>,
        import("better-result").InferErr<NonNullable<typeof removedParent>>,
        boolean
      >(removedParent, {
        ok: () => true,
        err: (error) => {
          $removedParentResultError202506 = error;
          return false;
        },
      });
      if (($removedParentResultOk202506 ? "ok" : "error") === "error") {
        const code = hostErrorCode($removedParentResultError202506);
        if (code !== "ENOTEMPTY" && code !== "ENOENT") return removedParent;
      }
      return Result.ok(undefined);
    }, this);
  }

  private async cleanupUnreferencedSnapshotMetadata(
    refs: ReadonlyMap<string, string>,
    cutoff: number,
  ): Promise<WorkspaceHistoryResult<boolean>> {
    const directoryStats = await lstatIfExists(this.snapshotRefCreationDirectory);
    let $directoryStatsResultValue202986!: import("better-result").InferOk<
      NonNullable<typeof directoryStats>
    >;
    let $directoryStatsResultError202986!: import("better-result").InferErr<
      NonNullable<typeof directoryStats>
    >;
    const $directoryStatsResultOk202986 = Result.match<
      import("better-result").InferOk<NonNullable<typeof directoryStats>>,
      import("better-result").InferErr<NonNullable<typeof directoryStats>>,
      boolean
    >(directoryStats, {
      ok: (value) => {
        $directoryStatsResultValue202986 = value;
        return true;
      },
      err: (error) => {
        $directoryStatsResultError202986 = error;
        return false;
      },
    });
    if (($directoryStatsResultOk202986 ? "ok" : "error") === "error")
      return Result.err($directoryStatsResultError202986);
    if (!$directoryStatsResultValue202986) return Result.ok(false);
    if (
      !$directoryStatsResultValue202986.isDirectory() ||
      $directoryStatsResultValue202986.isSymbolicLink()
    ) {
      return failOwned({
        code: "ownership-mismatch",
        operation: "clean snapshot-ref metadata",
        message: "Snapshot-ref metadata path is not an owned directory",
      });
    }
    let removed = false;
    const children = await attemptHost(() =>
      readdir(this.snapshotRefCreationDirectory, { withFileTypes: true }),
    );
    let $childrenResultValue203504!: import("better-result").InferOk<NonNullable<typeof children>>;
    let $childrenResultError203504!: import("better-result").InferErr<NonNullable<typeof children>>;
    const $childrenResultOk203504 = Result.match<
      import("better-result").InferOk<NonNullable<typeof children>>,
      import("better-result").InferErr<NonNullable<typeof children>>,
      boolean
    >(children, {
      ok: (value) => {
        $childrenResultValue203504 = value;
        return true;
      },
      err: (error) => {
        $childrenResultError203504 = error;
        return false;
      },
    });
    if (($childrenResultOk203504 ? "ok" : "error") === "error")
      return Result.err($childrenResultError203504);
    for (const child of $childrenResultValue203504) {
      const metadataMatch = /^([0-9a-f]{40}|[0-9a-f]{64})\.json$/.exec(child.name);
      if (metadataMatch?.[1] && child.isFile() && !child.isSymbolicLink()) {
        const rootTreeOid = metadataMatch[1];
        const gitRef = this.snapshotRef(rootTreeOid);
        if (refs.get(gitRef) === rootTreeOid) continue;
        const metadata = await this.readSnapshotRefCreationMetadata(rootTreeOid, gitRef);
        let $metadataResultValue204048!: import("better-result").InferOk<
          NonNullable<typeof metadata>
        >;
        let $metadataResultError204048!: import("better-result").InferErr<
          NonNullable<typeof metadata>
        >;
        const $metadataResultOk204048 = Result.match<
          import("better-result").InferOk<NonNullable<typeof metadata>>,
          import("better-result").InferErr<NonNullable<typeof metadata>>,
          boolean
        >(metadata, {
          ok: (value) => {
            $metadataResultValue204048 = value;
            return true;
          },
          err: (error) => {
            $metadataResultError204048 = error;
            return false;
          },
        });
        if (($metadataResultOk204048 ? "ok" : "error") === "error")
          return Result.err($metadataResultError204048);
        if ($metadataResultValue204048 && $metadataResultValue204048.createdAtMs >= cutoff)
          continue;
        const removedFile = await attemptHost(() =>
          rm(path.join(this.snapshotRefCreationDirectory, child.name)),
        );
        let $removedFileResultError204274!: import("better-result").InferErr<
          NonNullable<typeof removedFile>
        >;
        const $removedFileResultOk204274 = Result.match<
          import("better-result").InferOk<NonNullable<typeof removedFile>>,
          import("better-result").InferErr<NonNullable<typeof removedFile>>,
          boolean
        >(removedFile, {
          ok: () => true,
          err: (error) => {
            $removedFileResultError204274 = error;
            return false;
          },
        });
        if (($removedFileResultOk204274 ? "ok" : "error") === "error")
          return Result.err($removedFileResultError204274);
        removed = true;
        continue;
      }
      if (!/^\.[0-9a-f]+\.[0-9a-f-]{36}\.tmp$/.test(child.name)) continue;
      const temporaryPath = path.join(this.snapshotRefCreationDirectory, child.name);
      const stats = await lstatIfExists(temporaryPath);
      let $statsResultValue204682!: import("better-result").InferOk<NonNullable<typeof stats>>;
      let $statsResultError204682!: import("better-result").InferErr<NonNullable<typeof stats>>;
      const $statsResultOk204682 = Result.match<
        import("better-result").InferOk<NonNullable<typeof stats>>,
        import("better-result").InferErr<NonNullable<typeof stats>>,
        boolean
      >(stats, {
        ok: (value) => {
          $statsResultValue204682 = value;
          return true;
        },
        err: (error) => {
          $statsResultError204682 = error;
          return false;
        },
      });
      if (($statsResultOk204682 ? "ok" : "error") === "error")
        return Result.err($statsResultError204682);
      if (!$statsResultValue204682 || $statsResultValue204682.mtimeMs >= cutoff) continue;
      const removedTemporary = await attemptHost(() => rm(temporaryPath, { recursive: true }));
      let $removedTemporaryResultError204855!: import("better-result").InferErr<
        NonNullable<typeof removedTemporary>
      >;
      const $removedTemporaryResultOk204855 = Result.match<
        import("better-result").InferOk<NonNullable<typeof removedTemporary>>,
        import("better-result").InferErr<NonNullable<typeof removedTemporary>>,
        boolean
      >(removedTemporary, {
        ok: () => true,
        err: (error) => {
          $removedTemporaryResultError204855 = error;
          return false;
        },
      });
      if (($removedTemporaryResultOk204855 ? "ok" : "error") === "error")
        return Result.err($removedTemporaryResultError204855);
      removed = true;
    }
    return Result.ok(removed);
  }

  private async directoryHasEntries(directory: string): Promise<WorkspaceHistoryResult<boolean>> {
    const stats = await lstatIfExists(directory);
    let $statsResultValue205184!: import("better-result").InferOk<NonNullable<typeof stats>>;
    let $statsResultError205184!: import("better-result").InferErr<NonNullable<typeof stats>>;
    const $statsResultOk205184 = Result.match<
      import("better-result").InferOk<NonNullable<typeof stats>>,
      import("better-result").InferErr<NonNullable<typeof stats>>,
      boolean
    >(stats, {
      ok: (value) => {
        $statsResultValue205184 = value;
        return true;
      },
      err: (error) => {
        $statsResultError205184 = error;
        return false;
      },
    });
    if (($statsResultOk205184 ? "ok" : "error") === "error")
      return Result.err($statsResultError205184);
    if (!$statsResultValue205184) return Result.ok(false);
    if (!$statsResultValue205184.isDirectory() || $statsResultValue205184.isSymbolicLink())
      return Result.ok(true);
    const children = await attemptHost(() => readdir(directory));
    let $childrenResultValue205421!: import("better-result").InferOk<NonNullable<typeof children>>;
    let $childrenResultError205421!: import("better-result").InferErr<NonNullable<typeof children>>;
    const $childrenResultOk205421 = Result.match<
      import("better-result").InferOk<NonNullable<typeof children>>,
      import("better-result").InferErr<NonNullable<typeof children>>,
      boolean
    >(children, {
      ok: (value) => {
        $childrenResultValue205421 = value;
        return true;
      },
      err: (error) => {
        $childrenResultError205421 = error;
        return false;
      },
    });
    if (($childrenResultOk205421 ? "ok" : "error") === "error")
      return Result.err($childrenResultError205421);
    return Result.ok($childrenResultValue205421.length > 0);
  }

  private missingReconciliation(
    expectedRootTreeOids: ReadonlySet<string>,
  ): Extract<WorkspaceHistoryRefReconciliation, { status: "reconciled" }> {
    return {
      status: "reconciled",
      expected: [...expectedRootTreeOids].map((rootTreeOid) => ({
        rootTreeOid,
        gitRef: this.snapshotRef(rootTreeOid),
        status: "missing",
      })),
      orphanRefs: [],
    };
  }

  private restorePlanPath(operationId: string): string {
    return path.join(this.restorePlanDirectory, `${operationId}.json`);
  }

  private signatureRecords(
    signatures: ReadonlyMap<string, string>,
  ): RestorePlanManifest["ignoredSignatures"] {
    return [...signatures]
      .map(([relativePath, signature]) => ({ relativePath, signature }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  private frozenScannedEntry(entry: TreeEntry): ScannedEntry {
    return {
      relativePath: entry.relativePath,
      absolutePath: fromPosixPath(this.cwd, entry.relativePath),
      kind: entry.mode === POSIX_SYMLINK_MODE ? "symlink" : "regular",
      mode: entry.mode,
      size: "0",
      mtimeNs: "0",
      ctimeNs: "0",
      dev: "0",
      ino: "0",
    };
  }

  private get markerPath(): string {
    return path.join(this.storeDirectory, "ownership.json");
  }

  private get captureCachePath(): string {
    return path.join(this.storeDirectory, "capture-cache.json");
  }

  private get captureIndexPath(): string {
    return path.join(this.storeDirectory, "capture.index");
  }

  private get restoreOwnershipDirectory(): string {
    return path.join(this.storeDirectory, "temp", "live-staging");
  }

  private get snapshotRefCreationDirectory(): string {
    return path.join(this.storeDirectory, "snapshot-ref-created");
  }

  private get restorePlanDirectory(): string {
    return path.join(this.storeDirectory, "restore-plans");
  }

  private get emptyHooksPath(): string {
    return path.join(this.storeDirectory, "empty-hooks");
  }

  private get emptyAttributesPath(): string {
    return path.join(this.storeDirectory, "empty-attributes");
  }

  private get emptyExcludesPath(): string {
    return path.join(this.storeDirectory, "empty-excludes");
  }

  private expectedMarker(): WorkspaceHistoryOwnership {
    return {
      formatVersion: FORMAT_VERSION,
      namespaceId: this.namespaceId,
      databasePathHash: this.databasePathHash,
      workspaceId: this.workspaceId,
      canonicalCwd: this.cwd,
    };
  }

  private async writePrivateControlFile(
    targetPath: string,
    contents: string,
  ): Promise<WorkspaceHistoryResult<void>> {
    return await this.writeAtomicPrivateFile(targetPath, contents, "write private control file");
  }

  private async assertNoSymlinkComponents(
    absolutePath: string,
    allowMissingTail: boolean,
  ): Promise<WorkspaceHistoryResult<void>> {
    const parsed = path.parse(absolutePath);
    const components = path.relative(parsed.root, absolutePath).split(path.sep).filter(Boolean);
    let current = parsed.root;
    for (const component of components) {
      current = path.join(current, component);
      const stats = await lstatIfExists(current);
      let $statsResultValue208746!: import("better-result").InferOk<NonNullable<typeof stats>>;
      let $statsResultError208746!: import("better-result").InferErr<NonNullable<typeof stats>>;
      const $statsResultOk208746 = Result.match<
        import("better-result").InferOk<NonNullable<typeof stats>>,
        import("better-result").InferErr<NonNullable<typeof stats>>,
        boolean
      >(stats, {
        ok: (value) => {
          $statsResultValue208746 = value;
          return true;
        },
        err: (error) => {
          $statsResultError208746 = error;
          return false;
        },
      });
      if (($statsResultOk208746 ? "ok" : "error") === "error")
        return Result.err($statsResultError208746);
      if (!$statsResultValue208746) {
        if (allowMissingTail) return Result.ok(undefined);
        return failOwned({
          code: "workspace-invalid",
          operation: "validate path traversal",
          message: `Required path component does not exist: ${current}`,
        });
      }
      if ($statsResultValue208746.isSymbolicLink()) {
        return failOwned({
          code: "workspace-invalid",
          operation: "validate path traversal",
          message: `Refusing symlinked path component: ${current}`,
        });
      }
    }
    return Result.ok(undefined);
  }

  private verifyOwnershipMarker(): Promise<WorkspaceHistoryResult<void>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      yield* Result.await(this.assertNoSymlinkComponents(this.storeDirectory, false));
      const markerStats = yield* Result.await(attemptHost(() => lstat(this.markerPath)));
      if (!markerStats.isFile() || markerStats.isSymbolicLink()) {
        return failOwned({
          code: "ownership-mismatch",
          operation: "verify store ownership",
          message: "Private Git store ownership marker is not a regular file",
        });
      }
      const serialized = yield* Result.await(attemptHost(() => readFile(this.markerPath, "utf8")));
      const decoded = this.decodeOwnership(serialized);
      let $decodedResultError210122!: import("better-result").InferErr<NonNullable<typeof decoded>>;
      const $decodedResultOk210122 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decoded>>,
        import("better-result").InferErr<NonNullable<typeof decoded>>,
        boolean
      >(decoded, {
        ok: () => true,
        err: (error) => {
          $decodedResultError210122 = error;
          return false;
        },
      });
      if (($decodedResultOk210122 ? "ok" : "error") === "error")
        return failWith($decodedResultError210122);
      return Result.ok(undefined);
    }, this);
  }

  private async scanWorkspace(
    managedPaths?: ReadonlySet<string>,
  ): Promise<WorkspaceHistoryResult<ScanResult>> {
    const entries = new Map<string, ScannedEntry>();
    const directories = new Set<string>();
    const boundaryRoots = new Set<string>();
    const ownedRestoreArtifacts = await this.validatedOwnedRestoreArtifactPaths();
    let $ownedRestoreArtifactsResultValue210563!: import("better-result").InferOk<
      NonNullable<typeof ownedRestoreArtifacts>
    >;
    let $ownedRestoreArtifactsResultError210563!: import("better-result").InferErr<
      NonNullable<typeof ownedRestoreArtifacts>
    >;
    const $ownedRestoreArtifactsResultOk210563 = Result.match<
      import("better-result").InferOk<NonNullable<typeof ownedRestoreArtifacts>>,
      import("better-result").InferErr<NonNullable<typeof ownedRestoreArtifacts>>,
      boolean
    >(ownedRestoreArtifacts, {
      ok: (value) => {
        $ownedRestoreArtifactsResultValue210563 = value;
        return true;
      },
      err: (error) => {
        $ownedRestoreArtifactsResultError210563 = error;
        return false;
      },
    });
    if (($ownedRestoreArtifactsResultOk210563 ? "ok" : "error") === "error")
      return Result.err($ownedRestoreArtifactsResultError210563);
    const traversedDirectories = new Set<string>();
    if (managedPaths) {
      for (const relativePath of managedPaths) {
        traversedDirectories.add(relativePath);
        for (const ancestor of pathAncestors(relativePath)) traversedDirectories.add(ancestor);
      }
    }

    const scanDirectory = async (
      absoluteDirectory: string,
      relativeDirectory: string,
    ): Promise<WorkspaceHistoryResult<void>> => {
      const children = await attemptHost(() => readdir(absoluteDirectory, { withFileTypes: true }));
      let $childrenResultValue211162!: import("better-result").InferOk<
        NonNullable<typeof children>
      >;
      let $childrenResultError211162!: import("better-result").InferErr<
        NonNullable<typeof children>
      >;
      const $childrenResultOk211162 = Result.match<
        import("better-result").InferOk<NonNullable<typeof children>>,
        import("better-result").InferErr<NonNullable<typeof children>>,
        boolean
      >(children, {
        ok: (value) => {
          $childrenResultValue211162 = value;
          return true;
        },
        err: (error) => {
          $childrenResultError211162 = error;
          return false;
        },
      });
      if (
        relativeDirectory &&
        ($childrenResultOk211162 ? "ok" : "error") === "ok" &&
        $childrenResultValue211162.some((entry) => this.isGitMetadataName(entry.name))
      ) {
        boundaryRoots.add(relativeDirectory);
        return Result.ok(undefined);
      }
      if (($childrenResultOk211162 ? "ok" : "error") === "error")
        return Result.err($childrenResultError211162);
      for (const child of $childrenResultValue211162.sort((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        if (this.isGitMetadataName(child.name)) continue;
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${toPosixPath(child.name)}`
          : toPosixPath(child.name);
        const absolutePath = path.join(absoluteDirectory, child.name);
        if (
          [...$ownedRestoreArtifactsResultValue210563].some(
            (artifactPath) =>
              this.comparisonPath(artifactPath) === this.comparisonPath(absolutePath),
          )
        ) {
          continue;
        }
        if (this.isProtectedAbsolutePath(absolutePath)) continue;
        const stats = await attemptHost(() => lstat(absolutePath, { bigint: true }));
        let $statsResultValue212266!: import("better-result").InferOk<NonNullable<typeof stats>>;
        let $statsResultError212266!: import("better-result").InferErr<NonNullable<typeof stats>>;
        const $statsResultOk212266 = Result.match<
          import("better-result").InferOk<NonNullable<typeof stats>>,
          import("better-result").InferErr<NonNullable<typeof stats>>,
          boolean
        >(stats, {
          ok: (value) => {
            $statsResultValue212266 = value;
            return true;
          },
          err: (error) => {
            $statsResultError212266 = error;
            return false;
          },
        });
        if (($statsResultOk212266 ? "ok" : "error") === "error")
          return Result.err($statsResultError212266);
        if ($statsResultValue212266.isDirectory()) {
          directories.add(relativePath);
          if (managedPaths && !traversedDirectories.has(relativePath)) continue;
          const scanned = await scanDirectory(absolutePath, relativePath);
          let $scannedResultError212569!: import("better-result").InferErr<
            NonNullable<typeof scanned>
          >;
          const $scannedResultOk212569 = Result.match<
            import("better-result").InferOk<NonNullable<typeof scanned>>,
            import("better-result").InferErr<NonNullable<typeof scanned>>,
            boolean
          >(scanned, {
            ok: () => true,
            err: (error) => {
              $scannedResultError212569 = error;
              return false;
            },
          });
          if (($scannedResultOk212569 ? "ok" : "error") === "error")
            return Result.err($scannedResultError212569);
          continue;
        }
        let kind: ScannedEntry["kind"];
        if ($statsResultValue212266.isSymbolicLink()) {
          kind = "symlink";
        } else if ($statsResultValue212266.isFile()) {
          kind = "regular";
        } else {
          kind = "special";
        }
        let mode: number;
        if (kind === "symlink") {
          mode = POSIX_SYMLINK_MODE;
        } else if (kind === "special") {
          mode = 0;
        } else if (($statsResultValue212266.mode & 0o111n) !== 0n) {
          mode = POSIX_EXECUTABLE_MODE;
        } else {
          mode = POSIX_FILE_MODE;
        }
        entries.set(relativePath, {
          relativePath,
          absolutePath,
          kind,
          mode,
          size: $statsResultValue212266.size.toString(),
          mtimeNs: $statsResultValue212266.mtimeNs.toString(),
          ctimeNs: $statsResultValue212266.ctimeNs.toString(),
          dev: $statsResultValue212266.dev.toString(),
          ino: $statsResultValue212266.ino.toString(),
        });
      }
      return Result.ok(undefined);
    };

    const scanned = await scanDirectory(this.cwd, "");
    let $scannedResultError213692!: import("better-result").InferErr<NonNullable<typeof scanned>>;
    const $scannedResultOk213692 = Result.match<
      import("better-result").InferOk<NonNullable<typeof scanned>>,
      import("better-result").InferErr<NonNullable<typeof scanned>>,
      boolean
    >(scanned, {
      ok: () => true,
      err: (error) => {
        $scannedResultError213692 = error;
        return false;
      },
    });
    if (($scannedResultOk213692 ? "ok" : "error") === "error")
      return Result.err($scannedResultError213692);
    return Result.ok({ entries, directories, boundaryRoots });
  }

  private async listSourceManagedPaths(
    repositoryRoot: string,
  ): Promise<WorkspaceHistoryResult<Set<string>>> {
    const scope = toPosixPath(path.relative(repositoryRoot, this.cwd)) || ".";
    const result = await this.runSourceGit(
      repositoryRoot,
      ["ls-files", "-z", "--full-name", "--cached", "--others", "--exclude-standard", "--", scope],
      { operation: "classify source repository paths" },
    );
    let $resultResultValue214066!: import("better-result").InferOk<NonNullable<typeof result>>;
    let $resultResultError214066!: import("better-result").InferErr<NonNullable<typeof result>>;
    const $resultResultOk214066 = Result.match<
      import("better-result").InferOk<NonNullable<typeof result>>,
      import("better-result").InferErr<NonNullable<typeof result>>,
      boolean
    >(result, {
      ok: (value) => {
        $resultResultValue214066 = value;
        return true;
      },
      err: (error) => {
        $resultResultError214066 = error;
        return false;
      },
    });
    if (($resultResultOk214066 ? "ok" : "error") === "error")
      return Result.err($resultResultError214066);
    const workspacePrefix = scope === "." ? "" : `${scope}/`;
    const paths = new Set<string>();
    const records = splitNul($resultResultValue214066.stdout, "classify source repository paths");
    let $recordsResultValue214445!: import("better-result").InferOk<NonNullable<typeof records>>;
    let $recordsResultError214445!: import("better-result").InferErr<NonNullable<typeof records>>;
    const $recordsResultOk214445 = Result.match<
      import("better-result").InferOk<NonNullable<typeof records>>,
      import("better-result").InferErr<NonNullable<typeof records>>,
      boolean
    >(records, {
      ok: (value) => {
        $recordsResultValue214445 = value;
        return true;
      },
      err: (error) => {
        $recordsResultError214445 = error;
        return false;
      },
    });
    if (($recordsResultOk214445 ? "ok" : "error") === "error")
      return Result.err($recordsResultError214445);
    for (const repositoryPath of $recordsResultValue214445) {
      const normalizedRepositoryPath = repositoryPath.endsWith("/")
        ? repositoryPath.slice(0, -1)
        : repositoryPath;
      const relativePath = workspacePrefix
        ? normalizedRepositoryPath.slice(workspacePrefix.length)
        : normalizedRepositoryPath;
      if (workspacePrefix && !repositoryPath.startsWith(workspacePrefix)) {
        return failOwned({
          code: "malformed-git-output",
          operation: "classify source repository paths",
          message: "Git returned a path outside the workspace scope",
        });
      }
      const safe = checkSafeRelativePath(relativePath, "classify source repository paths");
      let $safeResultError215202!: import("better-result").InferErr<NonNullable<typeof safe>>;
      const $safeResultOk215202 = Result.match<
        import("better-result").InferOk<NonNullable<typeof safe>>,
        import("better-result").InferErr<NonNullable<typeof safe>>,
        boolean
      >(safe, {
        ok: () => true,
        err: (error) => {
          $safeResultError215202 = error;
          return false;
        },
      });
      if (($safeResultOk215202 ? "ok" : "error") === "error")
        return Result.err($safeResultError215202);
      paths.add(relativePath);
    }
    return Result.ok(paths);
  }

  private async resolveEffectiveExcludesFile(
    repositoryRoot: string,
  ): Promise<WorkspaceHistoryResult<string | undefined>> {
    const result = await this.runSourceGit(
      repositoryRoot,
      ["config", "--path", "--get", "core.excludesFile"],
      {
        operation: "resolve source excludes file",
        acceptedExitCodes: [0, 1],
        includeExcludes: false,
        env: {
          GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        },
      },
    );
    let $resultResultValue215544!: import("better-result").InferOk<NonNullable<typeof result>>;
    let $resultResultError215544!: import("better-result").InferErr<NonNullable<typeof result>>;
    const $resultResultOk215544 = Result.match<
      import("better-result").InferOk<NonNullable<typeof result>>,
      import("better-result").InferErr<NonNullable<typeof result>>,
      boolean
    >(result, {
      ok: (value) => {
        $resultResultValue215544 = value;
        return true;
      },
      err: (error) => {
        $resultResultError215544 = error;
        return false;
      },
    });
    if (($resultResultOk215544 ? "ok" : "error") === "error")
      return Result.err($resultResultError215544);
    if ($resultResultValue215544.exitCode === 0) {
      const decoded = bytesToText($resultResultValue215544.stdout, "resolve source excludes file");
      let $decodedResultValue216043!: import("better-result").InferOk<NonNullable<typeof decoded>>;
      let $decodedResultError216043!: import("better-result").InferErr<NonNullable<typeof decoded>>;
      const $decodedResultOk216043 = Result.match<
        import("better-result").InferOk<NonNullable<typeof decoded>>,
        import("better-result").InferErr<NonNullable<typeof decoded>>,
        boolean
      >(decoded, {
        ok: (value) => {
          $decodedResultValue216043 = value;
          return true;
        },
        err: (error) => {
          $decodedResultError216043 = error;
          return false;
        },
      });
      if (($decodedResultOk216043 ? "ok" : "error") === "error")
        return Result.err($decodedResultError216043);
      const configured = $decodedResultValue216043.trim();
      if (configured.length === 0 || configured.includes("\n")) {
        return failOwned({
          code: "malformed-git-output",
          operation: "resolve source excludes file",
          message: "Git returned a malformed excludes-file path",
        });
      }
      return Result.ok(path.resolve(configured));
    }

    const home = process.env.HOME;
    let defaultGlobalExclude: string | undefined;
    if (process.env.XDG_CONFIG_HOME) {
      defaultGlobalExclude = path.join(process.env.XDG_CONFIG_HOME, "git", "ignore");
    } else if (home) {
      defaultGlobalExclude = path.join(home, ".config", "git", "ignore");
    }
    if (!defaultGlobalExclude) return Result.ok(undefined);
    const stats = await lstatIfExists(defaultGlobalExclude);
    let $statsResultValue216932!: import("better-result").InferOk<NonNullable<typeof stats>>;
    let $statsResultError216932!: import("better-result").InferErr<NonNullable<typeof stats>>;
    const $statsResultOk216932 = Result.match<
      import("better-result").InferOk<NonNullable<typeof stats>>,
      import("better-result").InferErr<NonNullable<typeof stats>>,
      boolean
    >(stats, {
      ok: (value) => {
        $statsResultValue216932 = value;
        return true;
      },
      err: (error) => {
        $statsResultError216932 = error;
        return false;
      },
    });
    if (($statsResultOk216932 ? "ok" : "error") === "error")
      return Result.err($statsResultError216932);
    return Result.ok($statsResultValue216932?.isFile() ? defaultGlobalExclude : undefined);
  }

  private async checkIgnoredPaths(
    scan: ScanResult,
    repositoryRoot: string,
  ): Promise<WorkspaceHistoryResult<Set<string>>> {
    const candidates = [...scan.entries.keys(), ...scan.directories].sort();
    if (candidates.length === 0) return Result.ok(new Set());
    const scope = toPosixPath(path.relative(repositoryRoot, this.cwd));
    const requestPaths = candidates.map((relativePath) =>
      scope ? `${scope}/${relativePath}` : relativePath,
    );
    const input = new TextEncoder().encode(`${requestPaths.join("\0")}\0`);
    const result = await this.runSourceGit(
      repositoryRoot,
      ["check-ignore", "--no-index", "-z", "--stdin"],
      { operation: "classify ignored source paths", acceptedExitCodes: [0, 1], input },
    );
    let $resultResultValue217672!: import("better-result").InferOk<NonNullable<typeof result>>;
    let $resultResultError217672!: import("better-result").InferErr<NonNullable<typeof result>>;
    const $resultResultOk217672 = Result.match<
      import("better-result").InferOk<NonNullable<typeof result>>,
      import("better-result").InferErr<NonNullable<typeof result>>,
      boolean
    >(result, {
      ok: (value) => {
        $resultResultValue217672 = value;
        return true;
      },
      err: (error) => {
        $resultResultError217672 = error;
        return false;
      },
    });
    if (($resultResultOk217672 ? "ok" : "error") === "error")
      return Result.err($resultResultError217672);
    if ($resultResultValue217672.exitCode === 1) return Result.ok(new Set());
    const ignored = new Set<string>();
    const records = splitNul($resultResultValue217672.stdout, "classify ignored paths");
    let $recordsResultValue218043!: import("better-result").InferOk<NonNullable<typeof records>>;
    let $recordsResultError218043!: import("better-result").InferErr<NonNullable<typeof records>>;
    const $recordsResultOk218043 = Result.match<
      import("better-result").InferOk<NonNullable<typeof records>>,
      import("better-result").InferErr<NonNullable<typeof records>>,
      boolean
    >(records, {
      ok: (value) => {
        $recordsResultValue218043 = value;
        return true;
      },
      err: (error) => {
        $recordsResultError218043 = error;
        return false;
      },
    });
    if (($recordsResultOk218043 ? "ok" : "error") === "error")
      return Result.err($recordsResultError218043);
    for (const outputPath of $recordsResultValue218043) {
      const relativePath = scope ? outputPath.slice(`${scope}/`.length) : outputPath;
      if (!candidates.includes(relativePath)) {
        return failOwned({
          code: "malformed-git-output",
          operation: "classify ignored paths",
          message: "Git returned an unexpected ignored path",
          detail: outputPath,
        });
      }
      ignored.add(relativePath);
    }
    return Result.ok(ignored);
  }

  private writeTree(
    entries: readonly TreeEntry[],
    indexPath: string,
  ): Promise<WorkspaceHistoryResult<string>> {
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      yield* Result.await(attemptHost(() => rm(indexPath, { force: true })));
      yield* Result.await(
        this.runPrivateGit(["read-tree", "--empty"], {
          operation: "initialize private index",
          indexPath,
        }),
      );
      if (entries.length > 0) {
        const records = entries
          .map((entry) => `${entry.mode.toString(8)} ${entry.oid}\t${entry.relativePath}\0`)
          .join("");
        yield* Result.await(
          this.runPrivateGit(["update-index", "-z", "--index-info"], {
            operation: "populate private index",
            indexPath,
            input: new TextEncoder().encode(records),
          }),
        );
      }
      const result = yield* Result.await(
        this.runPrivateGit(["write-tree"], {
          operation: "write workspace tree",
          indexPath,
        }),
      );
      return parseOid(result.stdout, "write workspace tree");
    }, this);
  }

  private parseLsTree(
    bytes: Uint8Array,
    operation: string,
  ): WorkspaceHistoryResult<Map<string, TreeEntry>> {
    const entries = new Map<string, TreeEntry>();
    const records = splitNul(bytes, operation);
    let $recordsResultValue219965!: import("better-result").InferOk<NonNullable<typeof records>>;
    let $recordsResultError219965!: import("better-result").InferErr<NonNullable<typeof records>>;
    const $recordsResultOk219965 = Result.match<
      import("better-result").InferOk<NonNullable<typeof records>>,
      import("better-result").InferErr<NonNullable<typeof records>>,
      boolean
    >(records, {
      ok: (value) => {
        $recordsResultValue219965 = value;
        return true;
      },
      err: (error) => {
        $recordsResultError219965 = error;
        return false;
      },
    });
    if (($recordsResultOk219965 ? "ok" : "error") === "error")
      return Result.err($recordsResultError219965);
    for (const record of $recordsResultValue219965) {
      const match = /^(\d+) (?:blob|tree) ([0-9a-f]+)\t(.+)$/.exec(record);
      if (!match?.[1] || !match[2] || !match[3] || !OID_PATTERN.test(match[2])) {
        return failOwned({
          code: "malformed-git-output",
          operation,
          message: "Git returned malformed ls-tree output",
        });
      }
      const relativePath = match[3];
      const safe = checkSafeRelativePath(relativePath, operation);
      let $safeResultError220472!: import("better-result").InferErr<NonNullable<typeof safe>>;
      const $safeResultOk220472 = Result.match<
        import("better-result").InferOk<NonNullable<typeof safe>>,
        import("better-result").InferErr<NonNullable<typeof safe>>,
        boolean
      >(safe, {
        ok: () => true,
        err: (error) => {
          $safeResultError220472 = error;
          return false;
        },
      });
      if (($safeResultOk220472 ? "ok" : "error") === "error")
        return Result.err($safeResultError220472);
      if (entries.has(relativePath)) {
        return failOwned({
          code: "snapshot-invalid",
          operation,
          message: `Snapshot repeats path ${relativePath}`,
        });
      }
      entries.set(relativePath, {
        relativePath,
        mode: Number.parseInt(match[1], 8),
        oid: match[2],
      });
    }
    return Result.ok(entries);
  }

  private async preflightDestinationCapabilities(
    snapshot: ParsedSnapshot,
    observeMaterializedBytes?: (bytes: bigint) => void,
  ): Promise<WorkspaceHistoryResult<bigint>> {
    const changed = new Map<string, TreeEntry>();
    for (const [relativePath, entry] of snapshot.entries) {
      const matches = await this.liveEntryMatches(entry);
      let $matchesResultValue221258!: import("better-result").InferOk<NonNullable<typeof matches>>;
      let $matchesResultError221258!: import("better-result").InferErr<NonNullable<typeof matches>>;
      const $matchesResultOk221258 = Result.match<
        import("better-result").InferOk<NonNullable<typeof matches>>,
        import("better-result").InferErr<NonNullable<typeof matches>>,
        boolean
      >(matches, {
        ok: (value) => {
          $matchesResultValue221258 = value;
          return true;
        },
        err: (error) => {
          $matchesResultError221258 = error;
          return false;
        },
      });
      if (($matchesResultOk221258 ? "ok" : "error") === "error")
        return Result.err($matchesResultError221258);
      if (!$matchesResultValue221258) changed.set(relativePath, entry);
      for (const part of relativePath.split("/")) {
        if (Buffer.byteLength(part) > 255) {
          return failWith(
            this.restoreConflict("Target path component exceeds the phase-one name limit"),
          );
        }
      }
    }
    const sizes = await this.objectSizes(
      new Set([...snapshot.entries.values()].map((entry) => entry.oid)),
    );
    let $sizesResultValue221681!: import("better-result").InferOk<NonNullable<typeof sizes>>;
    let $sizesResultError221681!: import("better-result").InferErr<NonNullable<typeof sizes>>;
    const $sizesResultOk221681 = Result.match<
      import("better-result").InferOk<NonNullable<typeof sizes>>,
      import("better-result").InferErr<NonNullable<typeof sizes>>,
      boolean
    >(sizes, {
      ok: (value) => {
        $sizesResultValue221681 = value;
        return true;
      },
      err: (error) => {
        $sizesResultError221681 = error;
        return false;
      },
    });
    if (($sizesResultOk221681 ? "ok" : "error") === "error")
      return Result.err($sizesResultError221681);
    const privateStagingBytes = [...snapshot.entries.values()].reduce(
      (total, entry) => total + ($sizesResultValue221681.get(entry.oid) ?? 0n),
      0n,
    );
    const parents = new Map<string, { representativePath: string; requiredBytes: bigint }>();
    for (const [relativePath, entry] of changed) {
      const unavailableRoot = await this.firstUnavailableTargetDirectory(relativePath);
      let $unavailableRootResultValue222154!: import("better-result").InferOk<
        NonNullable<typeof unavailableRoot>
      >;
      let $unavailableRootResultError222154!: import("better-result").InferErr<
        NonNullable<typeof unavailableRoot>
      >;
      const $unavailableRootResultOk222154 = Result.match<
        import("better-result").InferOk<NonNullable<typeof unavailableRoot>>,
        import("better-result").InferErr<NonNullable<typeof unavailableRoot>>,
        boolean
      >(unavailableRoot, {
        ok: (value) => {
          $unavailableRootResultValue222154 = value;
          return true;
        },
        err: (error) => {
          $unavailableRootResultError222154 = error;
          return false;
        },
      });
      if (($unavailableRootResultOk222154 ? "ok" : "error") === "error")
        return Result.err($unavailableRootResultError222154);
      const parentRelative = $unavailableRootResultValue222154
        ? path.posix.dirname($unavailableRootResultValue222154)
        : path.posix.dirname(relativePath);
      const parent = parentRelative === "." ? this.cwd : fromPosixPath(this.cwd, parentRelative);
      const previous = parents.get(parent);
      parents.set(parent, {
        representativePath: previous?.representativePath ?? relativePath,
        requiredBytes:
          (previous?.requiredBytes ?? 0n) + ($sizesResultValue221681.get(entry.oid) ?? 0n),
      });
    }
    const materializedBytes =
      privateStagingBytes +
      [...parents.values()].reduce((total, requirement) => total + requirement.requiredBytes, 0n);
    const observed = await attemptHost(
      async () => await observeMaterializedBytes?.(materializedBytes),
    );
    let $observedResultError222967!: import("better-result").InferErr<NonNullable<typeof observed>>;
    const $observedResultOk222967 = Result.match<
      import("better-result").InferOk<NonNullable<typeof observed>>,
      import("better-result").InferErr<NonNullable<typeof observed>>,
      boolean
    >(observed, {
      ok: () => true,
      err: (error) => {
        $observedResultError222967 = error;
        return false;
      },
    });
    if (($observedResultOk222967 ? "ok" : "error") === "error")
      return Result.err($observedResultError222967);

    const capacities = new Map<string, FilesystemCapacity>();
    const addCapacity = async (
      targetPath: string,
      requiredBytes: bigint,
    ): Promise<WorkspaceHistoryResult<void>> => {
      const filesystem = await attemptHost(() => this.statfs(targetPath));
      let $filesystemResultValue223341!: import("better-result").InferOk<
        NonNullable<typeof filesystem>
      >;
      let $filesystemResultError223341!: import("better-result").InferErr<
        NonNullable<typeof filesystem>
      >;
      const $filesystemResultOk223341 = Result.match<
        import("better-result").InferOk<NonNullable<typeof filesystem>>,
        import("better-result").InferErr<NonNullable<typeof filesystem>>,
        boolean
      >(filesystem, {
        ok: (value) => {
          $filesystemResultValue223341 = value;
          return true;
        },
        err: (error) => {
          $filesystemResultError223341 = error;
          return false;
        },
      });
      if (($filesystemResultOk223341 ? "ok" : "error") === "error")
        return Result.err($filesystemResultError223341);
      const availableBytes =
        $filesystemResultValue223341.bavail * $filesystemResultValue223341.bsize;
      const previous = capacities.get($filesystemResultValue223341.filesystemId);
      capacities.set($filesystemResultValue223341.filesystemId, {
        availableBytes:
          previous && previous.availableBytes < availableBytes
            ? previous.availableBytes
            : availableBytes,
        requiredBytes: (previous?.requiredBytes ?? 0n) + requiredBytes,
      });
      return Result.ok(undefined);
    };
    const privateCapacity = await addCapacity(this.storeDirectory, privateStagingBytes);
    let $privateCapacityResultError223956!: import("better-result").InferErr<
      NonNullable<typeof privateCapacity>
    >;
    const $privateCapacityResultOk223956 = Result.match<
      import("better-result").InferOk<NonNullable<typeof privateCapacity>>,
      import("better-result").InferErr<NonNullable<typeof privateCapacity>>,
      boolean
    >(privateCapacity, {
      ok: () => true,
      err: (error) => {
        $privateCapacityResultError223956 = error;
        return false;
      },
    });
    if (($privateCapacityResultOk223956 ? "ok" : "error") === "error")
      return Result.err($privateCapacityResultError223956);
    for (const [parent, requirement] of parents) {
      const parentStats = await attemptHost(() => lstat(parent));
      let $parentStatsResultValue224166!: import("better-result").InferOk<
        NonNullable<typeof parentStats>
      >;
      let $parentStatsResultError224166!: import("better-result").InferErr<
        NonNullable<typeof parentStats>
      >;
      const $parentStatsResultOk224166 = Result.match<
        import("better-result").InferOk<NonNullable<typeof parentStats>>,
        import("better-result").InferErr<NonNullable<typeof parentStats>>,
        boolean
      >(parentStats, {
        ok: (value) => {
          $parentStatsResultValue224166 = value;
          return true;
        },
        err: (error) => {
          $parentStatsResultError224166 = error;
          return false;
        },
      });
      if (($parentStatsResultOk224166 ? "ok" : "error") === "error")
        return Result.err($parentStatsResultError224166);
      if (
        !$parentStatsResultValue224166.isDirectory() ||
        $parentStatsResultValue224166.isSymbolicLink()
      ) {
        return failWith(
          this.restoreConflict("Destination capability parent is not a real directory"),
        );
      }
      const accessible = await attemptHost(() =>
        access(parent, fsConstants.W_OK | fsConstants.X_OK),
      );
      let $accessibleResultError224511!: import("better-result").InferErr<
        NonNullable<typeof accessible>
      >;
      const $accessibleResultOk224511 = Result.match<
        import("better-result").InferOk<NonNullable<typeof accessible>>,
        import("better-result").InferErr<NonNullable<typeof accessible>>,
        boolean
      >(accessible, {
        ok: () => true,
        err: (error) => {
          $accessibleResultError224511 = error;
          return false;
        },
      });
      if (($accessibleResultOk224511 ? "ok" : "error") === "error")
        return Result.err($accessibleResultError224511);
      const capacity = await addCapacity(parent, requirement.requiredBytes);
      let $capacityResultError224690!: import("better-result").InferErr<
        NonNullable<typeof capacity>
      >;
      const $capacityResultOk224690 = Result.match<
        import("better-result").InferOk<NonNullable<typeof capacity>>,
        import("better-result").InferErr<NonNullable<typeof capacity>>,
        boolean
      >(capacity, {
        ok: () => true,
        err: (error) => {
          $capacityResultError224690 = error;
          return false;
        },
      });
      if (($capacityResultOk224690 ? "ok" : "error") === "error")
        return Result.err($capacityResultError224690);
    }
    if (
      [...capacities.values()].some((capacity) => capacity.availableBytes < capacity.requiredBytes)
    ) {
      return failWith(this.restoreConflict("Restore filesystem has insufficient available space"));
    }

    const createdManifest = await this.createRestoreOwnershipManifest(snapshot.rootTreeOid, "");
    let $createdManifestResultValue225051!: import("better-result").InferOk<
      NonNullable<typeof createdManifest>
    >;
    let $createdManifestResultError225051!: import("better-result").InferErr<
      NonNullable<typeof createdManifest>
    >;
    const $createdManifestResultOk225051 = Result.match<
      import("better-result").InferOk<NonNullable<typeof createdManifest>>,
      import("better-result").InferErr<NonNullable<typeof createdManifest>>,
      boolean
    >(createdManifest, {
      ok: (value) => {
        $createdManifestResultValue225051 = value;
        return true;
      },
      err: (error) => {
        $createdManifestResultError225051 = error;
        return false;
      },
    });
    if (($createdManifestResultOk225051 ? "ok" : "error") === "error")
      return Result.err($createdManifestResultError225051);
    const { manifestPath, manifest } = $createdManifestResultValue225051;
    manifest.privateStagingDirectory = undefined;
    const written = await this.writeRestoreOwnershipManifest(manifestPath, manifest);
    let $writtenResultError225328!: import("better-result").InferErr<NonNullable<typeof written>>;
    const $writtenResultOk225328 = Result.match<
      import("better-result").InferOk<NonNullable<typeof written>>,
      import("better-result").InferErr<NonNullable<typeof written>>,
      boolean
    >(written, {
      ok: () => true,
      err: (error) => {
        $writtenResultError225328 = error;
        return false;
      },
    });
    if (($writtenResultOk225328 ? "ok" : "error") === "error")
      return Result.err($writtenResultError225328);
    const primary = await superviseOutcome<bigint>(async () => {
      for (const [parent, requirement] of parents) {
        const probed = await this.runEmptyDestinationCapabilityProbe(
          parent,
          requirement.representativePath,
          manifestPath,
          manifest,
        );
        let $probedResultError225588!: import("better-result").InferErr<NonNullable<typeof probed>>;
        const $probedResultOk225588 = Result.match<
          import("better-result").InferOk<NonNullable<typeof probed>>,
          import("better-result").InferErr<NonNullable<typeof probed>>,
          boolean
        >(probed, {
          ok: () => true,
          err: (error) => {
            $probedResultError225588 = error;
            return false;
          },
        });
        if (($probedResultOk225588 ? "ok" : "error") === "error")
          return Result.err($probedResultError225588);
      }
      return Result.ok(materializedBytes);
    });
    const cleanup = await runWorkspaceHistoryCleanup("preflight destination capabilities", [
      async () => {
        const cleaned = await this.cleanupStaleRestoreArtifactsLocked();
        let $cleanedResultError225999!: import("better-result").InferErr<
          NonNullable<typeof cleaned>
        >;
        const $cleanedResultOk225999 = Result.match<
          import("better-result").InferOk<NonNullable<typeof cleaned>>,
          import("better-result").InferErr<NonNullable<typeof cleaned>>,
          boolean
        >(cleaned, {
          ok: () => true,
          err: (error) => {
            $cleanedResultError225999 = error;
            return false;
          },
        });
        if (($cleanedResultOk225999 ? "ok" : "error") === "error")
          return Result.err($cleanedResultError225999);
        return Result.ok(undefined);
      },
    ]);
    const resolved = resolveOutcomeWithCleanup(
      primary,
      cleanup,
      "preflight destination capabilities",
    );
    switch (resolved.status) {
      case "ok":
        return Result.ok(resolved.value);
      case "failed":
        return Result.err(resolved.failure);
      case "panic":
        return Result.err({ kind: "panic", cause: resolved.cause });
      case "defect":
        return await resolved.rejection.reject<WorkspaceHistoryResult<bigint>>();
    }
  }

  private async objectSizes(
    oids: ReadonlySet<string>,
  ): Promise<WorkspaceHistoryResult<Map<string, bigint>>> {
    if (oids.size === 0) return Result.ok(new Map());
    const ordered = [...oids].sort();
    const result = await this.runPrivateGit(
      ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      {
        operation: "measure target snapshot objects",
        input: new TextEncoder().encode(`${ordered.join("\n")}\n`),
      },
    );
    let $resultResultValue226896!: import("better-result").InferOk<NonNullable<typeof result>>;
    let $resultResultError226896!: import("better-result").InferErr<NonNullable<typeof result>>;
    const $resultResultOk226896 = Result.match<
      import("better-result").InferOk<NonNullable<typeof result>>,
      import("better-result").InferErr<NonNullable<typeof result>>,
      boolean
    >(result, {
      ok: (value) => {
        $resultResultValue226896 = value;
        return true;
      },
      err: (error) => {
        $resultResultError226896 = error;
        return false;
      },
    });
    if (($resultResultOk226896 ? "ok" : "error") === "error")
      return Result.err($resultResultError226896);
    const decoded = bytesToText($resultResultValue226896.stdout, "measure target snapshot objects");
    let $decodedResultValue227216!: import("better-result").InferOk<NonNullable<typeof decoded>>;
    let $decodedResultError227216!: import("better-result").InferErr<NonNullable<typeof decoded>>;
    const $decodedResultOk227216 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decoded>>,
      import("better-result").InferErr<NonNullable<typeof decoded>>,
      boolean
    >(decoded, {
      ok: (value) => {
        $decodedResultValue227216 = value;
        return true;
      },
      err: (error) => {
        $decodedResultError227216 = error;
        return false;
      },
    });
    if (($decodedResultOk227216 ? "ok" : "error") === "error")
      return Result.err($decodedResultError227216);
    const lines = $decodedResultValue227216.trimEnd().split("\n");
    if (lines.length !== ordered.length) {
      return failOwned({
        code: "malformed-git-output",
        operation: "measure target snapshot objects",
        message: "Git returned an unexpected object-size result count",
      });
    }
    const sizes = new Map<string, bigint>();
    for (const line of lines) {
      const match = /^([0-9a-f]+) blob ([0-9]+)$/.exec(line);
      if (!match?.[1] || !match[2] || !OID_PATTERN.test(match[1])) {
        return failOwned({
          code: "snapshot-invalid",
          operation: "measure target snapshot objects",
          message: "Target snapshot references a missing or malformed blob",
          detail: line.slice(0, 200),
        });
      }
      sizes.set(match[1], BigInt(match[2]));
    }
    return Result.ok(sizes);
  }

  private async runEmptyDestinationCapabilityProbe(
    destinationDirectory: string,
    relativePath: string,
    manifestPath: string,
    manifest: RestoreOwnershipManifest,
  ): Promise<WorkspaceHistoryResult<void>> {
    const emptyOid = await this.hashBytes(new Uint8Array(), false);
    let $emptyOidResultValue228430!: import("better-result").InferOk<NonNullable<typeof emptyOid>>;
    let $emptyOidResultError228430!: import("better-result").InferErr<NonNullable<typeof emptyOid>>;
    const $emptyOidResultOk228430 = Result.match<
      import("better-result").InferOk<NonNullable<typeof emptyOid>>,
      import("better-result").InferErr<NonNullable<typeof emptyOid>>,
      boolean
    >(emptyOid, {
      ok: (value) => {
        $emptyOidResultValue228430 = value;
        return true;
      },
      err: (error) => {
        $emptyOidResultError228430 = error;
        return false;
      },
    });
    if (($emptyOidResultOk228430 ? "ok" : "error") === "error")
      return Result.err($emptyOidResultError228430);
    const parent = await this.parentIdentity(destinationDirectory);
    let $parentResultValue228552!: import("better-result").InferOk<NonNullable<typeof parent>>;
    let $parentResultError228552!: import("better-result").InferErr<NonNullable<typeof parent>>;
    const $parentResultOk228552 = Result.match<
      import("better-result").InferOk<NonNullable<typeof parent>>,
      import("better-result").InferErr<NonNullable<typeof parent>>,
      boolean
    >(parent, {
      ok: (value) => {
        $parentResultValue228552 = value;
        return true;
      },
      err: (error) => {
        $parentResultError228552 = error;
        return false;
      },
    });
    if (($parentResultOk228552 ? "ok" : "error") === "error")
      return Result.err($parentResultError228552);
    const regularPath = path.join(destinationDirectory, this.restoreTemporaryName());
    const regularIntent = await this.addRestoreArtifactIntent(manifestPath, manifest, {
      path: regularPath,
      kind: "file",
      role: "capability-file",
      expectedOid: $emptyOidResultValue228430,
      expectedMode: POSIX_FILE_MODE,
      ...$parentResultValue228552,
    });
    let $regularIntentResultValue228756!: import("better-result").InferOk<
      NonNullable<typeof regularIntent>
    >;
    let $regularIntentResultError228756!: import("better-result").InferErr<
      NonNullable<typeof regularIntent>
    >;
    const $regularIntentResultOk228756 = Result.match<
      import("better-result").InferOk<NonNullable<typeof regularIntent>>,
      import("better-result").InferErr<NonNullable<typeof regularIntent>>,
      boolean
    >(regularIntent, {
      ok: (value) => {
        $regularIntentResultValue228756 = value;
        return true;
      },
      err: (error) => {
        $regularIntentResultError228756 = error;
        return false;
      },
    });
    if (($regularIntentResultOk228756 ? "ok" : "error") === "error")
      return Result.err($regularIntentResultError228756);
    const regularHandle = await attemptHost(() =>
      open(
        regularPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      ),
    );
    let $regularHandleResultValue229087!: import("better-result").InferOk<
      NonNullable<typeof regularHandle>
    >;
    let $regularHandleResultError229087!: import("better-result").InferErr<
      NonNullable<typeof regularHandle>
    >;
    const $regularHandleResultOk229087 = Result.match<
      import("better-result").InferOk<NonNullable<typeof regularHandle>>,
      import("better-result").InferErr<NonNullable<typeof regularHandle>>,
      boolean
    >(regularHandle, {
      ok: (value) => {
        $regularHandleResultValue229087 = value;
        return true;
      },
      err: (error) => {
        $regularHandleResultError229087 = error;
        return false;
      },
    });
    if (($regularHandleResultOk229087 ? "ok" : "error") === "error")
      return Result.err($regularHandleResultError229087);
    const regularPrimary = await superviseOutcome<BigIntStats>(async () => {
      const stats = await attemptHost(() => $regularHandleResultValue229087.stat({ bigint: true }));
      let $statsResultValue229442!: import("better-result").InferOk<NonNullable<typeof stats>>;
      let $statsResultError229442!: import("better-result").InferErr<NonNullable<typeof stats>>;
      const $statsResultOk229442 = Result.match<
        import("better-result").InferOk<NonNullable<typeof stats>>,
        import("better-result").InferErr<NonNullable<typeof stats>>,
        boolean
      >(stats, {
        ok: (value) => {
          $statsResultValue229442 = value;
          return true;
        },
        err: (error) => {
          $statsResultError229442 = error;
          return false;
        },
      });
      if (($statsResultOk229442 ? "ok" : "error") === "error")
        return Result.err($statsResultError229442);
      const synced = await attemptHost(async () => await $regularHandleResultValue229087.sync());
      let $syncedResultError229581!: import("better-result").InferErr<NonNullable<typeof synced>>;
      const $syncedResultOk229581 = Result.match<
        import("better-result").InferOk<NonNullable<typeof synced>>,
        import("better-result").InferErr<NonNullable<typeof synced>>,
        boolean
      >(synced, {
        ok: () => true,
        err: (error) => {
          $syncedResultError229581 = error;
          return false;
        },
      });
      if (($syncedResultOk229581 ? "ok" : "error") === "error")
        return Result.err($syncedResultError229581);
      return Result.ok($statsResultValue229442);
    });
    const regularCleanup = await runWorkspaceHistoryCleanup("probe destination capabilities", [
      async () => await attemptHost(async () => await $regularHandleResultValue229087.close()),
    ]);
    const regularResolved = resolveOutcomeWithCleanup<BigIntStats>(
      regularPrimary,
      regularCleanup,
      "probe destination capabilities",
    );
    let regularStats: BigIntStats;
    switch (regularResolved.status) {
      case "ok":
        regularStats = regularResolved.value;
        break;
      case "failed":
        return Result.err(regularResolved.failure);
      case "panic":
        return Result.err({ kind: "panic", cause: regularResolved.cause });
      case "defect":
        return await regularResolved.rejection.reject<WorkspaceHistoryResult<void>>();
    }
    const regularIdentity = { path: regularPath, dev: regularStats.dev, ino: regularStats.ino };
    const completedRegular = await this.completeRestoreArtifactIdentity(
      manifestPath,
      manifest,
      $regularIntentResultValue228756,
      regularIdentity,
    );
    let $completedRegularResultError230658!: import("better-result").InferErr<
      NonNullable<typeof completedRegular>
    >;
    const $completedRegularResultOk230658 = Result.match<
      import("better-result").InferOk<NonNullable<typeof completedRegular>>,
      import("better-result").InferErr<NonNullable<typeof completedRegular>>,
      boolean
    >(completedRegular, {
      ok: () => true,
      err: (error) => {
        $completedRegularResultError230658 = error;
        return false;
      },
    });
    if (($completedRegularResultOk230658 ? "ok" : "error") === "error")
      return Result.err($completedRegularResultError230658);

    const symlinkBytes = Buffer.from("mini-lilac-capability");
    const symlinkOid = await this.hashBytes(symlinkBytes, false);
    let $symlinkOidResultValue230958!: import("better-result").InferOk<
      NonNullable<typeof symlinkOid>
    >;
    let $symlinkOidResultError230958!: import("better-result").InferErr<
      NonNullable<typeof symlinkOid>
    >;
    const $symlinkOidResultOk230958 = Result.match<
      import("better-result").InferOk<NonNullable<typeof symlinkOid>>,
      import("better-result").InferErr<NonNullable<typeof symlinkOid>>,
      boolean
    >(symlinkOid, {
      ok: (value) => {
        $symlinkOidResultValue230958 = value;
        return true;
      },
      err: (error) => {
        $symlinkOidResultError230958 = error;
        return false;
      },
    });
    if (($symlinkOidResultOk230958 ? "ok" : "error") === "error")
      return Result.err($symlinkOidResultError230958);
    const symlinkPath = path.join(destinationDirectory, this.restoreTemporaryName());
    const symlinkIntent = await this.addRestoreArtifactIntent(manifestPath, manifest, {
      path: symlinkPath,
      kind: "file",
      role: "capability-symlink",
      expectedOid: $symlinkOidResultValue230958,
      expectedMode: POSIX_SYMLINK_MODE,
      ...$parentResultValue228552,
    });
    let $symlinkIntentResultValue231168!: import("better-result").InferOk<
      NonNullable<typeof symlinkIntent>
    >;
    let $symlinkIntentResultError231168!: import("better-result").InferErr<
      NonNullable<typeof symlinkIntent>
    >;
    const $symlinkIntentResultOk231168 = Result.match<
      import("better-result").InferOk<NonNullable<typeof symlinkIntent>>,
      import("better-result").InferErr<NonNullable<typeof symlinkIntent>>,
      boolean
    >(symlinkIntent, {
      ok: (value) => {
        $symlinkIntentResultValue231168 = value;
        return true;
      },
      err: (error) => {
        $symlinkIntentResultError231168 = error;
        return false;
      },
    });
    if (($symlinkIntentResultOk231168 ? "ok" : "error") === "error")
      return Result.err($symlinkIntentResultError231168);
    const linked = await attemptHost(() => symlink(symlinkBytes, symlinkPath));
    let $linkedResultError231507!: import("better-result").InferErr<NonNullable<typeof linked>>;
    const $linkedResultOk231507 = Result.match<
      import("better-result").InferOk<NonNullable<typeof linked>>,
      import("better-result").InferErr<NonNullable<typeof linked>>,
      boolean
    >(linked, {
      ok: () => true,
      err: (error) => {
        $linkedResultError231507 = error;
        return false;
      },
    });
    if (($linkedResultOk231507 ? "ok" : "error") === "error")
      return Result.err($linkedResultError231507);
    const symlinkStats = await attemptHost(() => lstat(symlinkPath, { bigint: true }));
    let $symlinkStatsResultValue231637!: import("better-result").InferOk<
      NonNullable<typeof symlinkStats>
    >;
    let $symlinkStatsResultError231637!: import("better-result").InferErr<
      NonNullable<typeof symlinkStats>
    >;
    const $symlinkStatsResultOk231637 = Result.match<
      import("better-result").InferOk<NonNullable<typeof symlinkStats>>,
      import("better-result").InferErr<NonNullable<typeof symlinkStats>>,
      boolean
    >(symlinkStats, {
      ok: (value) => {
        $symlinkStatsResultValue231637 = value;
        return true;
      },
      err: (error) => {
        $symlinkStatsResultError231637 = error;
        return false;
      },
    });
    if (($symlinkStatsResultOk231637 ? "ok" : "error") === "error")
      return Result.err($symlinkStatsResultError231637);
    const completedSymlink = await this.completeRestoreArtifactIdentity(
      manifestPath,
      manifest,
      $symlinkIntentResultValue231168,
      {
        path: symlinkPath,
        dev: $symlinkStatsResultValue231637.dev,
        ino: $symlinkStatsResultValue231637.ino,
      },
    );
    let $completedSymlinkResultError231787!: import("better-result").InferErr<
      NonNullable<typeof completedSymlink>
    >;
    const $completedSymlinkResultOk231787 = Result.match<
      import("better-result").InferOk<NonNullable<typeof completedSymlink>>,
      import("better-result").InferErr<NonNullable<typeof completedSymlink>>,
      boolean
    >(completedSymlink, {
      ok: () => true,
      err: (error) => {
        $completedSymlinkResultError231787 = error;
        return false;
      },
    });
    if (($completedSymlinkResultOk231787 ? "ok" : "error") === "error")
      return Result.err($completedSymlinkResultError231787);

    const beforeLink = await attemptHost(
      async () => await this.beforeHardLinkValidation?.(relativePath, destinationDirectory),
    );
    let $beforeLinkResultError232119!: import("better-result").InferErr<
      NonNullable<typeof beforeLink>
    >;
    const $beforeLinkResultOk232119 = Result.match<
      import("better-result").InferOk<NonNullable<typeof beforeLink>>,
      import("better-result").InferErr<NonNullable<typeof beforeLink>>,
      boolean
    >(beforeLink, {
      ok: () => true,
      err: (error) => {
        $beforeLinkResultError232119 = error;
        return false;
      },
    });
    if (($beforeLinkResultOk232119 ? "ok" : "error") === "error")
      return Result.err($beforeLinkResultError232119);
    const linkPath = path.join(destinationDirectory, this.restoreTemporaryName());
    const linkIntent = await this.addRestoreArtifactIntent(manifestPath, manifest, {
      path: linkPath,
      kind: "file",
      role: "capability-hard-link-probe",
      expectedOid: $emptyOidResultValue228430,
      expectedMode: POSIX_FILE_MODE,
      expectedSourceDev: regularIdentity.dev.toString(),
      expectedSourceIno: regularIdentity.ino.toString(),
      ...$parentResultValue228552,
    });
    let $linkIntentResultValue232402!: import("better-result").InferOk<
      NonNullable<typeof linkIntent>
    >;
    let $linkIntentResultError232402!: import("better-result").InferErr<
      NonNullable<typeof linkIntent>
    >;
    const $linkIntentResultOk232402 = Result.match<
      import("better-result").InferOk<NonNullable<typeof linkIntent>>,
      import("better-result").InferErr<NonNullable<typeof linkIntent>>,
      boolean
    >(linkIntent, {
      ok: (value) => {
        $linkIntentResultValue232402 = value;
        return true;
      },
      err: (error) => {
        $linkIntentResultError232402 = error;
        return false;
      },
    });
    if (($linkIntentResultOk232402 ? "ok" : "error") === "error")
      return Result.err($linkIntentResultError232402);
    const hardLinked = await attemptHost(() => link(regularPath, linkPath));
    let $hardLinkedResultError232846!: import("better-result").InferErr<
      NonNullable<typeof hardLinked>
    >;
    const $hardLinkedResultOk232846 = Result.match<
      import("better-result").InferOk<NonNullable<typeof hardLinked>>,
      import("better-result").InferErr<NonNullable<typeof hardLinked>>,
      boolean
    >(hardLinked, {
      ok: () => true,
      err: (error) => {
        $hardLinkedResultError232846 = error;
        return false;
      },
    });
    if (($hardLinkedResultOk232846 ? "ok" : "error") === "error")
      return Result.err($hardLinkedResultError232846);
    const linkStats = await attemptHost(() => lstat(linkPath, { bigint: true }));
    let $linkStatsResultValue232981!: import("better-result").InferOk<
      NonNullable<typeof linkStats>
    >;
    let $linkStatsResultError232981!: import("better-result").InferErr<
      NonNullable<typeof linkStats>
    >;
    const $linkStatsResultOk232981 = Result.match<
      import("better-result").InferOk<NonNullable<typeof linkStats>>,
      import("better-result").InferErr<NonNullable<typeof linkStats>>,
      boolean
    >(linkStats, {
      ok: (value) => {
        $linkStatsResultValue232981 = value;
        return true;
      },
      err: (error) => {
        $linkStatsResultError232981 = error;
        return false;
      },
    });
    if (($linkStatsResultOk232981 ? "ok" : "error") === "error")
      return Result.err($linkStatsResultError232981);
    const completedLink = await this.completeRestoreArtifactIdentity(
      manifestPath,
      manifest,
      $linkIntentResultValue232402,
      {
        path: linkPath,
        dev: $linkStatsResultValue232981.dev,
        ino: $linkStatsResultValue232981.ino,
      },
    );
    let $completedLinkResultError233119!: import("better-result").InferErr<
      NonNullable<typeof completedLink>
    >;
    const $completedLinkResultOk233119 = Result.match<
      import("better-result").InferOk<NonNullable<typeof completedLink>>,
      import("better-result").InferErr<NonNullable<typeof completedLink>>,
      boolean
    >(completedLink, {
      ok: () => true,
      err: (error) => {
        $completedLinkResultError233119 = error;
        return false;
      },
    });
    if (($completedLinkResultOk233119 ? "ok" : "error") === "error")
      return Result.err($completedLinkResultError233119);
    return await this.fsyncDirectory(destinationDirectory);
  }

  private async liveEntryMatches(entry: TreeEntry): Promise<WorkspaceHistoryResult<boolean>> {
    const absolutePath = fromPosixPath(this.cwd, entry.relativePath);
    for (const ancestor of pathAncestors(entry.relativePath)) {
      const ancestorStats = await lstatIfExists(fromPosixPath(this.cwd, ancestor));
      let $ancestorStatsResultValue233725!: import("better-result").InferOk<
        NonNullable<typeof ancestorStats>
      >;
      let $ancestorStatsResultError233725!: import("better-result").InferErr<
        NonNullable<typeof ancestorStats>
      >;
      const $ancestorStatsResultOk233725 = Result.match<
        import("better-result").InferOk<NonNullable<typeof ancestorStats>>,
        import("better-result").InferErr<NonNullable<typeof ancestorStats>>,
        boolean
      >(ancestorStats, {
        ok: (value) => {
          $ancestorStatsResultValue233725 = value;
          return true;
        },
        err: (error) => {
          $ancestorStatsResultError233725 = error;
          return false;
        },
      });
      if (($ancestorStatsResultOk233725 ? "ok" : "error") === "error")
        return Result.err($ancestorStatsResultError233725);
      if (!$ancestorStatsResultValue233725 || !$ancestorStatsResultValue233725.isDirectory())
        return Result.ok(false);
    }
    const stats = await lstatIfExists(absolutePath);
    let $statsResultValue233974!: import("better-result").InferOk<NonNullable<typeof stats>>;
    let $statsResultError233974!: import("better-result").InferErr<NonNullable<typeof stats>>;
    const $statsResultOk233974 = Result.match<
      import("better-result").InferOk<NonNullable<typeof stats>>,
      import("better-result").InferErr<NonNullable<typeof stats>>,
      boolean
    >(stats, {
      ok: (value) => {
        $statsResultValue233974 = value;
        return true;
      },
      err: (error) => {
        $statsResultError233974 = error;
        return false;
      },
    });
    if (($statsResultOk233974 ? "ok" : "error") === "error")
      return Result.err($statsResultError233974);
    if (!$statsResultValue233974) return Result.ok(false);
    if (entry.mode === POSIX_SYMLINK_MODE) {
      if (!$statsResultValue233974.isSymbolicLink()) return Result.ok(false);
      const target = await attemptHost(() => readlink(absolutePath, { encoding: "buffer" }));
      let $targetResultValue234235!: import("better-result").InferOk<NonNullable<typeof target>>;
      let $targetResultError234235!: import("better-result").InferErr<NonNullable<typeof target>>;
      const $targetResultOk234235 = Result.match<
        import("better-result").InferOk<NonNullable<typeof target>>,
        import("better-result").InferErr<NonNullable<typeof target>>,
        boolean
      >(target, {
        ok: (value) => {
          $targetResultValue234235 = value;
          return true;
        },
        err: (error) => {
          $targetResultError234235 = error;
          return false;
        },
      });
      if (($targetResultOk234235 ? "ok" : "error") === "error")
        return Result.err($targetResultError234235);
      const oid = await this.hashBytes($targetResultValue234235, false);
      let $oidResultValue234381!: import("better-result").InferOk<NonNullable<typeof oid>>;
      let $oidResultError234381!: import("better-result").InferErr<NonNullable<typeof oid>>;
      const $oidResultOk234381 = Result.match<
        import("better-result").InferOk<NonNullable<typeof oid>>,
        import("better-result").InferErr<NonNullable<typeof oid>>,
        boolean
      >(oid, {
        ok: (value) => {
          $oidResultValue234381 = value;
          return true;
        },
        err: (error) => {
          $oidResultError234381 = error;
          return false;
        },
      });
      if (($oidResultOk234381 ? "ok" : "error") === "error")
        return Result.err($oidResultError234381);
      return Result.ok($oidResultValue234381 === entry.oid);
    }
    if (!$statsResultValue233974.isFile()) return Result.ok(false);
    const actualMode =
      ($statsResultValue233974.mode & 0o111) !== 0 ? POSIX_EXECUTABLE_MODE : POSIX_FILE_MODE;
    if (actualMode !== entry.mode) return Result.ok(false);
    const oid = await this.hashFile(absolutePath, false);
    let $oidResultValue234756!: import("better-result").InferOk<NonNullable<typeof oid>>;
    let $oidResultError234756!: import("better-result").InferErr<NonNullable<typeof oid>>;
    const $oidResultOk234756 = Result.match<
      import("better-result").InferOk<NonNullable<typeof oid>>,
      import("better-result").InferErr<NonNullable<typeof oid>>,
      boolean
    >(oid, {
      ok: (value) => {
        $oidResultValue234756 = value;
        return true;
      },
      err: (error) => {
        $oidResultError234756 = error;
        return false;
      },
    });
    if (($oidResultOk234756 ? "ok" : "error") === "error") return Result.err($oidResultError234756);
    return Result.ok($oidResultValue234756 === entry.oid);
  }

  private async stageDestinationEntries(
    stagedEntries: ReadonlyMap<string, StagedTreeEntry>,
    changedTargets: ReadonlySet<string>,
    workspaceIdentity: string,
    rootTreeOid: string,
    privateStagingDirectory: string,
  ): Promise<
    WorkspaceHistoryResult<{
      destinationEntries: Map<string, DestinationStagedEntry>;
      replacementRoots: Map<string, ReplacementDirectoryRoot>;
      ownedDirectories: Map<string, OwnedTemporaryPath>;
      ownedTemps: Map<string, OwnedTemporaryPath>;
      ownershipManifestPath: string;
      ownershipManifest: RestoreOwnershipManifest;
    }>
  > {
    const destinationEntries = new Map<string, DestinationStagedEntry>();
    const replacementRoots = new Map<string, ReplacementDirectoryRoot>();
    const ownedDirectories = new Map<string, OwnedTemporaryPath>();
    const ownedTemps = new Map<string, OwnedTemporaryPath>();
    const createdManifest = await this.createRestoreOwnershipManifest(
      rootTreeOid,
      privateStagingDirectory,
    );
    let $createdManifestResultValue235798!: import("better-result").InferOk<
      NonNullable<typeof createdManifest>
    >;
    let $createdManifestResultError235798!: import("better-result").InferErr<
      NonNullable<typeof createdManifest>
    >;
    const $createdManifestResultOk235798 = Result.match<
      import("better-result").InferOk<NonNullable<typeof createdManifest>>,
      import("better-result").InferErr<NonNullable<typeof createdManifest>>,
      boolean
    >(createdManifest, {
      ok: (value) => {
        $createdManifestResultValue235798 = value;
        return true;
      },
      err: (error) => {
        $createdManifestResultError235798 = error;
        return false;
      },
    });
    if (($createdManifestResultOk235798 ? "ok" : "error") === "error")
      return Result.err($createdManifestResultError235798);
    const { manifestPath, manifest } = $createdManifestResultValue235798;
    const primary = await superviseOutcome<{
      destinationEntries: Map<string, DestinationStagedEntry>;
      replacementRoots: Map<string, ReplacementDirectoryRoot>;
      ownedDirectories: Map<string, OwnedTemporaryPath>;
      ownedTemps: Map<string, OwnedTemporaryPath>;
      ownershipManifestPath: string;
      ownershipManifest: RestoreOwnershipManifest;
    }>(async () => {
      for (const relativePath of changedTargets) {
        const unavailableRoot = await this.firstUnavailableTargetDirectory(relativePath);
        let $unavailableRootResultValue236499!: import("better-result").InferOk<
          NonNullable<typeof unavailableRoot>
        >;
        let $unavailableRootResultError236499!: import("better-result").InferErr<
          NonNullable<typeof unavailableRoot>
        >;
        const $unavailableRootResultOk236499 = Result.match<
          import("better-result").InferOk<NonNullable<typeof unavailableRoot>>,
          import("better-result").InferErr<NonNullable<typeof unavailableRoot>>,
          boolean
        >(unavailableRoot, {
          ok: (value) => {
            $unavailableRootResultValue236499 = value;
            return true;
          },
          err: (error) => {
            $unavailableRootResultError236499 = error;
            return false;
          },
        });
        if (($unavailableRootResultOk236499 ? "ok" : "error") === "error")
          return Result.err($unavailableRootResultError236499);
        if (
          !$unavailableRootResultValue236499 ||
          replacementRoots.has($unavailableRootResultValue236499)
        )
          continue;
        const parentRelative = path.posix.dirname($unavailableRootResultValue236499);
        const parentDirectory =
          parentRelative === "." ? this.cwd : fromPosixPath(this.cwd, parentRelative);
        const safe = await this.assertSafeMutationAncestors(
          $unavailableRootResultValue236499,
          workspaceIdentity,
        );
        let $safeResultError236947!: import("better-result").InferErr<NonNullable<typeof safe>>;
        const $safeResultOk236947 = Result.match<
          import("better-result").InferOk<NonNullable<typeof safe>>,
          import("better-result").InferErr<NonNullable<typeof safe>>,
          boolean
        >(safe, {
          ok: () => true,
          err: (error) => {
            $safeResultError236947 = error;
            return false;
          },
        });
        if (($safeResultOk236947 ? "ok" : "error") === "error")
          return Result.err($safeResultError236947);
        const identity = await this.createExclusiveTemporaryDirectory(
          parentDirectory,
          manifestPath,
          manifest,
          "replacement-root",
        );
        let $identityResultValue237131!: import("better-result").InferOk<
          NonNullable<typeof identity>
        >;
        let $identityResultError237131!: import("better-result").InferErr<
          NonNullable<typeof identity>
        >;
        const $identityResultOk237131 = Result.match<
          import("better-result").InferOk<NonNullable<typeof identity>>,
          import("better-result").InferErr<NonNullable<typeof identity>>,
          boolean
        >(identity, {
          ok: (value) => {
            $identityResultValue237131 = value;
            return true;
          },
          err: (error) => {
            $identityResultError237131 = error;
            return false;
          },
        });
        if (($identityResultOk237131 ? "ok" : "error") === "error")
          return Result.err($identityResultError237131);
        const temporaryPath = $identityResultValue237131.path;
        ownedDirectories.set(temporaryPath, $identityResultValue237131);
        replacementRoots.set($unavailableRootResultValue236499, {
          relativePath: $unavailableRootResultValue236499,
          temporaryPath,
          identity: $identityResultValue237131,
          published: false,
        });
        const synced = await this.fsyncDirectory(parentDirectory);
        let $syncedResultError237686!: import("better-result").InferErr<NonNullable<typeof synced>>;
        const $syncedResultOk237686 = Result.match<
          import("better-result").InferOk<NonNullable<typeof synced>>,
          import("better-result").InferErr<NonNullable<typeof synced>>,
          boolean
        >(synced, {
          ok: () => true,
          err: (error) => {
            $syncedResultError237686 = error;
            return false;
          },
        });
        if (($syncedResultOk237686 ? "ok" : "error") === "error")
          return Result.err($syncedResultError237686);
      }

      const requiredDirectories = new Set<string>();
      for (const relativePath of changedTargets) {
        const replacementRoot = this.findReplacementRoot(relativePath, replacementRoots);
        if (!replacementRoot) continue;
        const parentRelative = path.posix.dirname(relativePath);
        const suffix = path.posix.relative(replacementRoot.relativePath, parentRelative);
        if (suffix === "") continue;
        const parts = suffix.split("/");
        for (let index = 1; index <= parts.length; index += 1) {
          requiredDirectories.add(
            path.join(replacementRoot.temporaryPath, ...parts.slice(0, index)),
          );
        }
      }
      for (const directory of [...requiredDirectories].sort(
        (left, right) => left.split(path.sep).length - right.split(path.sep).length,
      )) {
        const identity = await this.createIntendedDirectory(
          directory,
          manifestPath,
          manifest,
          "replacement-directory",
        );
        let $identityResultValue238651!: import("better-result").InferOk<
          NonNullable<typeof identity>
        >;
        let $identityResultError238651!: import("better-result").InferErr<
          NonNullable<typeof identity>
        >;
        const $identityResultOk238651 = Result.match<
          import("better-result").InferOk<NonNullable<typeof identity>>,
          import("better-result").InferErr<NonNullable<typeof identity>>,
          boolean
        >(identity, {
          ok: (value) => {
            $identityResultValue238651 = value;
            return true;
          },
          err: (error) => {
            $identityResultError238651 = error;
            return false;
          },
        });
        if (($identityResultOk238651 ? "ok" : "error") === "error")
          return Result.err($identityResultError238651);
        ownedDirectories.set(directory, $identityResultValue238651);
        const synced = await this.fsyncDirectory(path.dirname(directory));
        let $syncedResultError238938!: import("better-result").InferErr<NonNullable<typeof synced>>;
        const $syncedResultOk238938 = Result.match<
          import("better-result").InferOk<NonNullable<typeof synced>>,
          import("better-result").InferErr<NonNullable<typeof synced>>,
          boolean
        >(synced, {
          ok: () => true,
          err: (error) => {
            $syncedResultError238938 = error;
            return false;
          },
        });
        if (($syncedResultOk238938 ? "ok" : "error") === "error")
          return Result.err($syncedResultError238938);
      }

      for (const relativePath of [...changedTargets].sort()) {
        const staged = stagedEntries.get(relativePath);
        if (!staged) {
          return failWith(this.verificationError(`Target blob was not staged: ${relativePath}`));
        }
        const replacementRoot = this.findReplacementRoot(relativePath, replacementRoots);
        const targetParent = path.posix.dirname(relativePath);
        let destinationDirectory: string;
        if (replacementRoot) {
          destinationDirectory = path.join(
            replacementRoot.temporaryPath,
            ...path.posix
              .relative(replacementRoot.relativePath, targetParent)
              .split("/")
              .filter(Boolean),
          );
        } else if (targetParent === ".") {
          destinationDirectory = this.cwd;
        } else {
          destinationDirectory = fromPosixPath(this.cwd, targetParent);
        }
        const beforeStage = await attemptHost(
          async () => await this.beforeDestinationStage?.(relativePath, destinationDirectory),
        );
        let $beforeStageResultError239989!: import("better-result").InferErr<
          NonNullable<typeof beforeStage>
        >;
        const $beforeStageResultOk239989 = Result.match<
          import("better-result").InferOk<NonNullable<typeof beforeStage>>,
          import("better-result").InferErr<NonNullable<typeof beforeStage>>,
          boolean
        >(beforeStage, {
          ok: () => true,
          err: (error) => {
            $beforeStageResultError239989 = error;
            return false;
          },
        });
        if (($beforeStageResultOk239989 ? "ok" : "error") === "error")
          return Result.err($beforeStageResultError239989);
        const parentStats = await attemptHost(() => lstat(destinationDirectory));
        let $parentStatsResultValue240206!: import("better-result").InferOk<
          NonNullable<typeof parentStats>
        >;
        let $parentStatsResultError240206!: import("better-result").InferErr<
          NonNullable<typeof parentStats>
        >;
        const $parentStatsResultOk240206 = Result.match<
          import("better-result").InferOk<NonNullable<typeof parentStats>>,
          import("better-result").InferErr<NonNullable<typeof parentStats>>,
          boolean
        >(parentStats, {
          ok: (value) => {
            $parentStatsResultValue240206 = value;
            return true;
          },
          err: (error) => {
            $parentStatsResultError240206 = error;
            return false;
          },
        });
        if (($parentStatsResultOk240206 ? "ok" : "error") === "error")
          return Result.err($parentStatsResultError240206);
        if (
          !$parentStatsResultValue240206.isDirectory() ||
          $parentStatsResultValue240206.isSymbolicLink()
        ) {
          return failWith(
            this.restoreConflict(
              `Destination staging parent is not a real directory: ${targetParent}`,
            ),
          );
        }
        const temporary = await this.createDestinationSibling(
          staged,
          destinationDirectory,
          manifestPath,
          manifest,
        );
        let $temporaryResultValue240622!: import("better-result").InferOk<
          NonNullable<typeof temporary>
        >;
        let $temporaryResultError240622!: import("better-result").InferErr<
          NonNullable<typeof temporary>
        >;
        const $temporaryResultOk240622 = Result.match<
          import("better-result").InferOk<NonNullable<typeof temporary>>,
          import("better-result").InferErr<NonNullable<typeof temporary>>,
          boolean
        >(temporary, {
          ok: (value) => {
            $temporaryResultValue240622 = value;
            return true;
          },
          err: (error) => {
            $temporaryResultError240622 = error;
            return false;
          },
        });
        if (($temporaryResultOk240622 ? "ok" : "error") === "error")
          return Result.err($temporaryResultError240622);
        ownedTemps.set($temporaryResultValue240622.path, $temporaryResultValue240622);
        destinationEntries.set(relativePath, {
          ...staged,
          temporaryPath: $temporaryResultValue240622.path,
          replacementRoot: replacementRoot?.relativePath,
        });
        const validated = await this.validateHardLinkPrimitive(
          staged,
          destinationDirectory,
          $temporaryResultValue240622,
          manifestPath,
          manifest,
        );
        let $validatedResultError241098!: import("better-result").InferErr<
          NonNullable<typeof validated>
        >;
        const $validatedResultOk241098 = Result.match<
          import("better-result").InferOk<NonNullable<typeof validated>>,
          import("better-result").InferErr<NonNullable<typeof validated>>,
          boolean
        >(validated, {
          ok: () => true,
          err: (error) => {
            $validatedResultError241098 = error;
            return false;
          },
        });
        if (($validatedResultOk241098 ? "ok" : "error") === "error")
          return Result.err($validatedResultError241098);
      }
      return Result.ok({
        destinationEntries,
        replacementRoots,
        ownedDirectories,
        ownedTemps,
        ownershipManifestPath: manifestPath,
        ownershipManifest: manifest,
      });
    });
    if (primary.status === "ok") return Result.ok(primary.value);
    const cleanup = await runWorkspaceHistoryCleanup("stage destination entries", [
      async () =>
        await this.cleanupDestinationArtifacts(ownedTemps, ownedDirectories, workspaceIdentity),
      async () => {
        const cleaned = await this.cleanupStaleRestoreArtifactsLocked();
        let $cleanedResultError241872!: import("better-result").InferErr<
          NonNullable<typeof cleaned>
        >;
        const $cleanedResultOk241872 = Result.match<
          import("better-result").InferOk<NonNullable<typeof cleaned>>,
          import("better-result").InferErr<NonNullable<typeof cleaned>>,
          boolean
        >(cleaned, {
          ok: () => true,
          err: (error) => {
            $cleanedResultError241872 = error;
            return false;
          },
        });
        if (($cleanedResultOk241872 ? "ok" : "error") === "error")
          return Result.err($cleanedResultError241872);
        return Result.ok(undefined);
      },
    ]);
    const resolved = resolveOutcomeWithCleanup<{
      destinationEntries: Map<string, DestinationStagedEntry>;
      replacementRoots: Map<string, ReplacementDirectoryRoot>;
      ownedDirectories: Map<string, OwnedTemporaryPath>;
      ownedTemps: Map<string, OwnedTemporaryPath>;
      ownershipManifestPath: string;
      ownershipManifest: RestoreOwnershipManifest;
    }>(primary, cleanup, "stage destination entries");
    switch (resolved.status) {
      case "ok":
        return Result.ok(resolved.value);
      case "failed":
        return Result.err(resolved.failure);
      case "panic":
        return Result.err({ kind: "panic", cause: resolved.cause });
      case "defect":
        return await resolved.rejection.reject<WorkspaceHistoryResult<never>>();
    }
  }

  private async firstUnavailableTargetDirectory(
    relativePath: string,
  ): Promise<WorkspaceHistoryResult<string | undefined>> {
    for (const ancestor of pathAncestors(relativePath)) {
      const stats = await lstatIfExists(fromPosixPath(this.cwd, ancestor));
      let $statsResultValue243047!: import("better-result").InferOk<NonNullable<typeof stats>>;
      let $statsResultError243047!: import("better-result").InferErr<NonNullable<typeof stats>>;
      const $statsResultOk243047 = Result.match<
        import("better-result").InferOk<NonNullable<typeof stats>>,
        import("better-result").InferErr<NonNullable<typeof stats>>,
        boolean
      >(stats, {
        ok: (value) => {
          $statsResultValue243047 = value;
          return true;
        },
        err: (error) => {
          $statsResultError243047 = error;
          return false;
        },
      });
      if (($statsResultOk243047 ? "ok" : "error") === "error")
        return Result.err($statsResultError243047);
      if (!$statsResultValue243047 || !$statsResultValue243047.isDirectory())
        return Result.ok(ancestor);
    }
    return Result.ok(undefined);
  }

  private findReplacementRoot(
    relativePath: string,
    replacementRoots: ReadonlyMap<string, ReplacementDirectoryRoot>,
  ): ReplacementDirectoryRoot | undefined {
    return [...replacementRoots.values()].find(
      (root) =>
        relativePath === root.relativePath || relativePath.startsWith(`${root.relativePath}/`),
    );
  }

  private async createExclusiveTemporaryDirectory(
    parentDirectory: string,
    manifestPath: string,
    manifest: RestoreOwnershipManifest,
    role: "replacement-root",
  ): Promise<WorkspaceHistoryResult<OwnedTemporaryPath>> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = path.join(parentDirectory, this.restoreTemporaryName());
      const parent = await this.parentIdentity(parentDirectory);
      let $parentResultValue244013!: import("better-result").InferOk<NonNullable<typeof parent>>;
      let $parentResultError244013!: import("better-result").InferErr<NonNullable<typeof parent>>;
      const $parentResultOk244013 = Result.match<
        import("better-result").InferOk<NonNullable<typeof parent>>,
        import("better-result").InferErr<NonNullable<typeof parent>>,
        boolean
      >(parent, {
        ok: (value) => {
          $parentResultValue244013 = value;
          return true;
        },
        err: (error) => {
          $parentResultError244013 = error;
          return false;
        },
      });
      if (($parentResultOk244013 ? "ok" : "error") === "error")
        return Result.err($parentResultError244013);
      const intent = await this.addRestoreArtifactIntent(manifestPath, manifest, {
        path: candidate,
        kind: "directory",
        role,
        ...$parentResultValue244013,
      });
      let $intentResultValue244130!: import("better-result").InferOk<NonNullable<typeof intent>>;
      let $intentResultError244130!: import("better-result").InferErr<NonNullable<typeof intent>>;
      const $intentResultOk244130 = Result.match<
        import("better-result").InferOk<NonNullable<typeof intent>>,
        import("better-result").InferErr<NonNullable<typeof intent>>,
        boolean
      >(intent, {
        ok: (value) => {
          $intentResultValue244130 = value;
          return true;
        },
        err: (error) => {
          $intentResultError244130 = error;
          return false;
        },
      });
      if (($intentResultOk244130 ? "ok" : "error") === "error")
        return Result.err($intentResultError244130);
      const created = await attemptHost(() => mkdir(candidate, { mode: 0o700 }));
      let $createdResultError244366!: import("better-result").InferErr<NonNullable<typeof created>>;
      const $createdResultOk244366 = Result.match<
        import("better-result").InferOk<NonNullable<typeof created>>,
        import("better-result").InferErr<NonNullable<typeof created>>,
        boolean
      >(created, {
        ok: () => true,
        err: (error) => {
          $createdResultError244366 = error;
          return false;
        },
      });
      if (($createdResultOk244366 ? "ok" : "error") === "error") {
        const removed = await this.removeRestoreArtifactRecord(manifestPath, manifest, candidate);
        let $removedResultError244490!: import("better-result").InferErr<
          NonNullable<typeof removed>
        >;
        const $removedResultOk244490 = Result.match<
          import("better-result").InferOk<NonNullable<typeof removed>>,
          import("better-result").InferErr<NonNullable<typeof removed>>,
          boolean
        >(removed, {
          ok: () => true,
          err: (error) => {
            $removedResultError244490 = error;
            return false;
          },
        });
        if (($removedResultOk244490 ? "ok" : "error") === "error")
          return Result.err($removedResultError244490);
        if (hostErrorCode($createdResultError244366) === "EEXIST") continue;
        return Result.err($createdResultError244366);
      }
      const hooked = await attemptHost(
        async () => await this.afterArtifactCreateBeforeIdentity?.(role, candidate),
      );
      let $hookedResultError244740!: import("better-result").InferErr<NonNullable<typeof hooked>>;
      const $hookedResultOk244740 = Result.match<
        import("better-result").InferOk<NonNullable<typeof hooked>>,
        import("better-result").InferErr<NonNullable<typeof hooked>>,
        boolean
      >(hooked, {
        ok: () => true,
        err: (error) => {
          $hookedResultError244740 = error;
          return false;
        },
      });
      if (($hookedResultOk244740 ? "ok" : "error") === "error")
        return Result.err($hookedResultError244740);
      const stats = await attemptHost(() => lstat(candidate, { bigint: true }));
      let $statsResultValue244926!: import("better-result").InferOk<NonNullable<typeof stats>>;
      let $statsResultError244926!: import("better-result").InferErr<NonNullable<typeof stats>>;
      const $statsResultOk244926 = Result.match<
        import("better-result").InferOk<NonNullable<typeof stats>>,
        import("better-result").InferErr<NonNullable<typeof stats>>,
        boolean
      >(stats, {
        ok: (value) => {
          $statsResultValue244926 = value;
          return true;
        },
        err: (error) => {
          $statsResultError244926 = error;
          return false;
        },
      });
      if (($statsResultOk244926 ? "ok" : "error") === "error")
        return Result.err($statsResultError244926);
      const owned = {
        path: candidate,
        dev: $statsResultValue244926.dev,
        ino: $statsResultValue244926.ino,
      };
      const completed = await this.completeRestoreArtifactIdentity(
        manifestPath,
        manifest,
        $intentResultValue244130,
        owned,
      );
      let $completedResultError245142!: import("better-result").InferErr<
        NonNullable<typeof completed>
      >;
      const $completedResultOk245142 = Result.match<
        import("better-result").InferOk<NonNullable<typeof completed>>,
        import("better-result").InferErr<NonNullable<typeof completed>>,
        boolean
      >(completed, {
        ok: () => true,
        err: (error) => {
          $completedResultError245142 = error;
          return false;
        },
      });
      if (($completedResultOk245142 ? "ok" : "error") === "error")
        return Result.err($completedResultError245142);
      return Result.ok(owned);
    }
    return failOwned({
      code: "filesystem-error",
      operation: "create destination staging directory",
      message: "Unable to allocate an exclusive destination staging directory",
    });
  }

  private async createIntendedDirectory(
    directory: string,
    manifestPath: string,
    manifest: RestoreOwnershipManifest,
    role: "replacement-directory",
  ): Promise<WorkspaceHistoryResult<OwnedTemporaryPath>> {
    const parent = await this.parentIdentity(path.dirname(directory));
    let $parentResultValue245818!: import("better-result").InferOk<NonNullable<typeof parent>>;
    let $parentResultError245818!: import("better-result").InferErr<NonNullable<typeof parent>>;
    const $parentResultOk245818 = Result.match<
      import("better-result").InferOk<NonNullable<typeof parent>>,
      import("better-result").InferErr<NonNullable<typeof parent>>,
      boolean
    >(parent, {
      ok: (value) => {
        $parentResultValue245818 = value;
        return true;
      },
      err: (error) => {
        $parentResultError245818 = error;
        return false;
      },
    });
    if (($parentResultOk245818 ? "ok" : "error") === "error")
      return Result.err($parentResultError245818);
    const intent = await this.addRestoreArtifactIntent(manifestPath, manifest, {
      path: directory,
      kind: "directory",
      role,
      ...$parentResultValue245818,
    });
    let $intentResultValue245939!: import("better-result").InferOk<NonNullable<typeof intent>>;
    let $intentResultError245939!: import("better-result").InferErr<NonNullable<typeof intent>>;
    const $intentResultOk245939 = Result.match<
      import("better-result").InferOk<NonNullable<typeof intent>>,
      import("better-result").InferErr<NonNullable<typeof intent>>,
      boolean
    >(intent, {
      ok: (value) => {
        $intentResultValue245939 = value;
        return true;
      },
      err: (error) => {
        $intentResultError245939 = error;
        return false;
      },
    });
    if (($intentResultOk245939 ? "ok" : "error") === "error")
      return Result.err($intentResultError245939);
    const created = await attemptHost(() => mkdir(directory, { mode: 0o700 }));
    let $createdResultError246161!: import("better-result").InferErr<NonNullable<typeof created>>;
    const $createdResultOk246161 = Result.match<
      import("better-result").InferOk<NonNullable<typeof created>>,
      import("better-result").InferErr<NonNullable<typeof created>>,
      boolean
    >(created, {
      ok: () => true,
      err: (error) => {
        $createdResultError246161 = error;
        return false;
      },
    });
    if (($createdResultOk246161 ? "ok" : "error") === "error") {
      const removed = await this.removeRestoreArtifactRecord(manifestPath, manifest, directory);
      let $removedResultError246281!: import("better-result").InferErr<NonNullable<typeof removed>>;
      const $removedResultOk246281 = Result.match<
        import("better-result").InferOk<NonNullable<typeof removed>>,
        import("better-result").InferErr<NonNullable<typeof removed>>,
        boolean
      >(removed, {
        ok: () => true,
        err: (error) => {
          $removedResultError246281 = error;
          return false;
        },
      });
      if (($removedResultOk246281 ? "ok" : "error") === "error")
        return Result.err($removedResultError246281);
      return Result.err($createdResultError246161);
    }
    const hooked = await attemptHost(
      async () => await this.afterArtifactCreateBeforeIdentity?.(role, directory),
    );
    let $hookedResultError246458!: import("better-result").InferErr<NonNullable<typeof hooked>>;
    const $hookedResultOk246458 = Result.match<
      import("better-result").InferOk<NonNullable<typeof hooked>>,
      import("better-result").InferErr<NonNullable<typeof hooked>>,
      boolean
    >(hooked, {
      ok: () => true,
      err: (error) => {
        $hookedResultError246458 = error;
        return false;
      },
    });
    if (($hookedResultOk246458 ? "ok" : "error") === "error")
      return Result.err($hookedResultError246458);
    const stats = await attemptHost(() => lstat(directory, { bigint: true }));
    let $statsResultValue246636!: import("better-result").InferOk<NonNullable<typeof stats>>;
    let $statsResultError246636!: import("better-result").InferErr<NonNullable<typeof stats>>;
    const $statsResultOk246636 = Result.match<
      import("better-result").InferOk<NonNullable<typeof stats>>,
      import("better-result").InferErr<NonNullable<typeof stats>>,
      boolean
    >(stats, {
      ok: (value) => {
        $statsResultValue246636 = value;
        return true;
      },
      err: (error) => {
        $statsResultError246636 = error;
        return false;
      },
    });
    if (($statsResultOk246636 ? "ok" : "error") === "error")
      return Result.err($statsResultError246636);
    const owned = {
      path: directory,
      dev: $statsResultValue246636.dev,
      ino: $statsResultValue246636.ino,
    };
    const completed = await this.completeRestoreArtifactIdentity(
      manifestPath,
      manifest,
      $intentResultValue245939,
      owned,
    );
    let $completedResultError246846!: import("better-result").InferErr<
      NonNullable<typeof completed>
    >;
    const $completedResultOk246846 = Result.match<
      import("better-result").InferOk<NonNullable<typeof completed>>,
      import("better-result").InferErr<NonNullable<typeof completed>>,
      boolean
    >(completed, {
      ok: () => true,
      err: (error) => {
        $completedResultError246846 = error;
        return false;
      },
    });
    if (($completedResultOk246846 ? "ok" : "error") === "error")
      return Result.err($completedResultError246846);
    return Result.ok(owned);
  }

  private async createDestinationSibling(
    entry: StagedTreeEntry,
    destinationDirectory: string,
    manifestPath: string,
    manifest: RestoreOwnershipManifest,
  ): Promise<WorkspaceHistoryResult<OwnedTemporaryPath>> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = path.join(destinationDirectory, this.restoreTemporaryName());
      const role =
        entry.mode === POSIX_SYMLINK_MODE ? "destination-symlink" : "destination-regular";
      const parent = await this.parentIdentity(destinationDirectory);
      let $parentResultValue247561!: import("better-result").InferOk<NonNullable<typeof parent>>;
      let $parentResultError247561!: import("better-result").InferErr<NonNullable<typeof parent>>;
      const $parentResultOk247561 = Result.match<
        import("better-result").InferOk<NonNullable<typeof parent>>,
        import("better-result").InferErr<NonNullable<typeof parent>>,
        boolean
      >(parent, {
        ok: (value) => {
          $parentResultValue247561 = value;
          return true;
        },
        err: (error) => {
          $parentResultError247561 = error;
          return false;
        },
      });
      if (($parentResultOk247561 ? "ok" : "error") === "error")
        return Result.err($parentResultError247561);
      const intent = await this.addRestoreArtifactIntent(manifestPath, manifest, {
        path: candidate,
        kind: "file",
        role,
        expectedOid: entry.oid,
        expectedMode: entry.mode,
        ...$parentResultValue247561,
      });
      let $intentResultValue247683!: import("better-result").InferOk<NonNullable<typeof intent>>;
      let $intentResultError247683!: import("better-result").InferErr<NonNullable<typeof intent>>;
      const $intentResultOk247683 = Result.match<
        import("better-result").InferOk<NonNullable<typeof intent>>,
        import("better-result").InferErr<NonNullable<typeof intent>>,
        boolean
      >(intent, {
        ok: (value) => {
          $intentResultValue247683 = value;
          return true;
        },
        err: (error) => {
          $intentResultError247683 = error;
          return false;
        },
      });
      if (($intentResultOk247683 ? "ok" : "error") === "error")
        return Result.err($intentResultError247683);
      let owned: OwnedTemporaryPath | undefined;
      let created = false;
      const primary = await superviseOutcome<OwnedTemporaryPath>(async () => {
        if (entry.mode === POSIX_SYMLINK_MODE) {
          const payload = await attemptHost(() => readFile(entry.stagingPath));
          let $payloadResultValue248188!: import("better-result").InferOk<
            NonNullable<typeof payload>
          >;
          let $payloadResultError248188!: import("better-result").InferErr<
            NonNullable<typeof payload>
          >;
          const $payloadResultOk248188 = Result.match<
            import("better-result").InferOk<NonNullable<typeof payload>>,
            import("better-result").InferErr<NonNullable<typeof payload>>,
            boolean
          >(payload, {
            ok: (value) => {
              $payloadResultValue248188 = value;
              return true;
            },
            err: (error) => {
              $payloadResultError248188 = error;
              return false;
            },
          });
          if (($payloadResultOk248188 ? "ok" : "error") === "error")
            return Result.err($payloadResultError248188);
          const linked = await attemptHost(() => symlink($payloadResultValue248188, candidate));
          let $linkedResultError248326!: import("better-result").InferErr<
            NonNullable<typeof linked>
          >;
          const $linkedResultOk248326 = Result.match<
            import("better-result").InferOk<NonNullable<typeof linked>>,
            import("better-result").InferErr<NonNullable<typeof linked>>,
            boolean
          >(linked, {
            ok: () => true,
            err: (error) => {
              $linkedResultError248326 = error;
              return false;
            },
          });
          if (($linkedResultOk248326 ? "ok" : "error") === "error")
            return Result.err($linkedResultError248326);
        } else {
          const copied = await attemptHost(() =>
            copyFile(entry.stagingPath, candidate, fsConstants.COPYFILE_EXCL),
          );
          let $copiedResultError248484!: import("better-result").InferErr<
            NonNullable<typeof copied>
          >;
          const $copiedResultOk248484 = Result.match<
            import("better-result").InferOk<NonNullable<typeof copied>>,
            import("better-result").InferErr<NonNullable<typeof copied>>,
            boolean
          >(copied, {
            ok: () => true,
            err: (error) => {
              $copiedResultError248484 = error;
              return false;
            },
          });
          if (($copiedResultOk248484 ? "ok" : "error") === "error")
            return Result.err($copiedResultError248484);
        }
        created = true;
        const hooked = await attemptHost(
          async () => await this.afterArtifactCreateBeforeIdentity?.(role, candidate),
        );
        let $hookedResultError248713!: import("better-result").InferErr<NonNullable<typeof hooked>>;
        const $hookedResultOk248713 = Result.match<
          import("better-result").InferOk<NonNullable<typeof hooked>>,
          import("better-result").InferErr<NonNullable<typeof hooked>>,
          boolean
        >(hooked, {
          ok: () => true,
          err: (error) => {
            $hookedResultError248713 = error;
            return false;
          },
        });
        if (($hookedResultOk248713 ? "ok" : "error") === "error")
          return Result.err($hookedResultError248713);
        const stats = await attemptHost(() => lstat(candidate, { bigint: true }));
        let $statsResultValue248907!: import("better-result").InferOk<NonNullable<typeof stats>>;
        let $statsResultError248907!: import("better-result").InferErr<NonNullable<typeof stats>>;
        const $statsResultOk248907 = Result.match<
          import("better-result").InferOk<NonNullable<typeof stats>>,
          import("better-result").InferErr<NonNullable<typeof stats>>,
          boolean
        >(stats, {
          ok: (value) => {
            $statsResultValue248907 = value;
            return true;
          },
          err: (error) => {
            $statsResultError248907 = error;
            return false;
          },
        });
        if (($statsResultOk248907 ? "ok" : "error") === "error")
          return Result.err($statsResultError248907);
        owned = {
          path: candidate,
          dev: $statsResultValue248907.dev,
          ino: $statsResultValue248907.ino,
        };
        const completed = await this.completeRestoreArtifactIdentity(
          manifestPath,
          manifest,
          $intentResultValue247683,
          owned,
        );
        let $completedResultError249123!: import("better-result").InferErr<
          NonNullable<typeof completed>
        >;
        const $completedResultOk249123 = Result.match<
          import("better-result").InferOk<NonNullable<typeof completed>>,
          import("better-result").InferErr<NonNullable<typeof completed>>,
          boolean
        >(completed, {
          ok: () => true,
          err: (error) => {
            $completedResultError249123 = error;
            return false;
          },
        });
        if (($completedResultOk249123 ? "ok" : "error") === "error")
          return Result.err($completedResultError249123);
        if (entry.mode !== POSIX_SYMLINK_MODE) {
          const modeSet = await attemptHost(() =>
            chmod(candidate, entry.mode === POSIX_EXECUTABLE_MODE ? 0o755 : 0o644),
          );
          let $modeSetResultError249400!: import("better-result").InferErr<
            NonNullable<typeof modeSet>
          >;
          const $modeSetResultOk249400 = Result.match<
            import("better-result").InferOk<NonNullable<typeof modeSet>>,
            import("better-result").InferErr<NonNullable<typeof modeSet>>,
            boolean
          >(modeSet, {
            ok: () => true,
            err: (error) => {
              $modeSetResultError249400 = error;
              return false;
            },
          });
          if (($modeSetResultOk249400 ? "ok" : "error") === "error")
            return Result.err($modeSetResultError249400);
          const handle = await attemptHost(() =>
            open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW),
          );
          let $handleResultValue249605!: import("better-result").InferOk<
            NonNullable<typeof handle>
          >;
          let $handleResultError249605!: import("better-result").InferErr<
            NonNullable<typeof handle>
          >;
          const $handleResultOk249605 = Result.match<
            import("better-result").InferOk<NonNullable<typeof handle>>,
            import("better-result").InferErr<NonNullable<typeof handle>>,
            boolean
          >(handle, {
            ok: (value) => {
              $handleResultValue249605 = value;
              return true;
            },
            err: (error) => {
              $handleResultError249605 = error;
              return false;
            },
          });
          if (($handleResultOk249605 ? "ok" : "error") === "error")
            return Result.err($handleResultError249605);
          const synced = await superviseOutcome<void>(
            async () => await attemptHost(async () => await $handleResultValue249605.sync()),
          );
          const closed = await runWorkspaceHistoryCleanup("create destination sibling", [
            async () => await attemptHost(async () => await $handleResultValue249605.close()),
          ]);
          const syncedAndClosed = resolveOutcomeWithCleanup<void>(
            synced,
            closed,
            "create destination sibling",
          );
          switch (syncedAndClosed.status) {
            case "ok":
              break;
            case "failed":
              return Result.err(syncedAndClosed.failure);
            case "panic":
              return Result.err({ kind: "panic", cause: syncedAndClosed.cause });
            case "defect":
              return await syncedAndClosed.rejection.reject<WorkspaceHistoryResult<never>>();
          }
        }
        // Node cannot open a symlink inode for fsync without following it. Fsyncing the containing
        // directory durably records the exclusively-created symlink entry and its target payload.
        const directorySynced = await this.fsyncDirectory(destinationDirectory);
        let $directorySyncedResultError250919!: import("better-result").InferErr<
          NonNullable<typeof directorySynced>
        >;
        const $directorySyncedResultOk250919 = Result.match<
          import("better-result").InferOk<NonNullable<typeof directorySynced>>,
          import("better-result").InferErr<NonNullable<typeof directorySynced>>,
          boolean
        >(directorySynced, {
          ok: () => true,
          err: (error) => {
            $directorySyncedResultError250919 = error;
            return false;
          },
        });
        if (($directorySyncedResultOk250919 ? "ok" : "error") === "error")
          return Result.err($directorySyncedResultError250919);
        return Result.ok(owned);
      });
      if (primary.status === "ok") return Result.ok(primary.value);
      const cleanup = await runWorkspaceHistoryCleanup("create destination sibling", [
        async () => {
          if (!owned) return Result.ok(undefined);
          const current = await lstatIfExists(owned.path, true);
          let $currentResultValue251345!: import("better-result").InferOk<
            NonNullable<typeof current>
          >;
          let $currentResultError251345!: import("better-result").InferErr<
            NonNullable<typeof current>
          >;
          const $currentResultOk251345 = Result.match<
            import("better-result").InferOk<NonNullable<typeof current>>,
            import("better-result").InferErr<NonNullable<typeof current>>,
            boolean
          >(current, {
            ok: (value) => {
              $currentResultValue251345 = value;
              return true;
            },
            err: (error) => {
              $currentResultError251345 = error;
              return false;
            },
          });
          if (($currentResultOk251345 ? "ok" : "error") === "error")
            return Result.err($currentResultError251345);
          if (
            $currentResultValue251345 &&
            $currentResultValue251345.dev === owned.dev &&
            $currentResultValue251345.ino === owned.ino
          ) {
            return await attemptHost(() => rm(owned!.path));
          }
          return Result.ok(undefined);
        },
        async () => {
          if (created) return Result.ok(undefined);
          return await this.removeRestoreArtifactRecord(manifestPath, manifest, candidate);
        },
      ]);
      if (
        primary.status === "failed" &&
        hostErrorCode(primary.failure) === "EEXIST" &&
        cleanup.status === "ok"
      ) {
        continue;
      }
      const resolved = resolveOutcomeWithCleanup<OwnedTemporaryPath>(
        primary,
        cleanup,
        "create destination sibling",
      );
      switch (resolved.status) {
        case "ok":
          return Result.ok(resolved.value);
        case "failed":
          return Result.err(resolved.failure);
        case "panic":
          return Result.err({ kind: "panic", cause: resolved.cause });
        case "defect":
          return await resolved.rejection.reject<WorkspaceHistoryResult<OwnedTemporaryPath>>();
      }
    }
    return failOwned({
      code: "filesystem-error",
      operation: "create destination sibling",
      message: `Unable to allocate an exclusive destination sibling for ${entry.relativePath}`,
    });
  }

  private restoreTemporaryName(): string {
    return `.mini-lilac-restore-${randomUUID()}`;
  }

  private async createRestoreOwnershipManifest(
    rootTreeOid: string,
    privateStagingDirectory: string,
  ): Promise<WorkspaceHistoryResult<{ manifestPath: string; manifest: RestoreOwnershipManifest }>> {
    const before = await this.assertNoSymlinkComponents(this.restoreOwnershipDirectory, true);
    let $beforeResultError253109!: import("better-result").InferErr<NonNullable<typeof before>>;
    const $beforeResultOk253109 = Result.match<
      import("better-result").InferOk<NonNullable<typeof before>>,
      import("better-result").InferErr<NonNullable<typeof before>>,
      boolean
    >(before, {
      ok: () => true,
      err: (error) => {
        $beforeResultError253109 = error;
        return false;
      },
    });
    if (($beforeResultOk253109 ? "ok" : "error") === "error")
      return Result.err($beforeResultError253109);
    const created = await attemptHost(() =>
      mkdir(this.restoreOwnershipDirectory, { recursive: true, mode: 0o700 }),
    );
    let $createdResultError253254!: import("better-result").InferErr<NonNullable<typeof created>>;
    const $createdResultOk253254 = Result.match<
      import("better-result").InferOk<NonNullable<typeof created>>,
      import("better-result").InferErr<NonNullable<typeof created>>,
      boolean
    >(created, {
      ok: () => true,
      err: (error) => {
        $createdResultError253254 = error;
        return false;
      },
    });
    if (($createdResultOk253254 ? "ok" : "error") === "error")
      return Result.err($createdResultError253254);
    const after = await this.assertNoSymlinkComponents(this.restoreOwnershipDirectory, false);
    let $afterResultError253436!: import("better-result").InferErr<NonNullable<typeof after>>;
    const $afterResultOk253436 = Result.match<
      import("better-result").InferOk<NonNullable<typeof after>>,
      import("better-result").InferErr<NonNullable<typeof after>>,
      boolean
    >(after, {
      ok: () => true,
      err: (error) => {
        $afterResultError253436 = error;
        return false;
      },
    });
    if (($afterResultOk253436 ? "ok" : "error") === "error")
      return Result.err($afterResultError253436);
    const manifestPath = path.join(this.restoreOwnershipDirectory, `${randomUUID()}.json`);
    const manifest: RestoreOwnershipManifest = {
      formatVersion: FORMAT_VERSION,
      workspaceId: this.workspaceId,
      canonicalCwd: this.cwd,
      rootTreeOid,
      ...(privateStagingDirectory ? { privateStagingDirectory } : {}),
      artifacts: [],
    };
    const written = await this.writeRestoreOwnershipManifest(manifestPath, manifest);
    let $writtenResultError253942!: import("better-result").InferErr<NonNullable<typeof written>>;
    const $writtenResultOk253942 = Result.match<
      import("better-result").InferOk<NonNullable<typeof written>>,
      import("better-result").InferErr<NonNullable<typeof written>>,
      boolean
    >(written, {
      ok: () => true,
      err: (error) => {
        $writtenResultError253942 = error;
        return false;
      },
    });
    if (($writtenResultOk253942 ? "ok" : "error") === "error")
      return Result.err($writtenResultError253942);
    return Result.ok({ manifestPath, manifest });
  }

  private async writeRestoreOwnershipManifest(
    manifestPath: string,
    manifest: RestoreOwnershipManifest,
  ): Promise<WorkspaceHistoryResult<void>> {
    const temporaryPath = path.join(path.dirname(manifestPath), `${randomUUID()}.tmp`);
    return await this.writeAtomicPrivateFile(
      manifestPath,
      canonicalJson(manifest),
      "write restore ownership manifest",
      () => temporaryPath,
    );
  }

  private async readRestoreOwnershipManifest(
    manifestPath: string,
    operation: string,
  ): Promise<WorkspaceHistoryResult<RestoreOwnershipManifest>> {
    const serialized = await attemptHost(() => readFile(manifestPath, "utf8"));
    let $serializedResultValue254719!: import("better-result").InferOk<
      NonNullable<typeof serialized>
    >;
    let $serializedResultError254719!: import("better-result").InferErr<
      NonNullable<typeof serialized>
    >;
    const $serializedResultOk254719 = Result.match<
      import("better-result").InferOk<NonNullable<typeof serialized>>,
      import("better-result").InferErr<NonNullable<typeof serialized>>,
      boolean
    >(serialized, {
      ok: (value) => {
        $serializedResultValue254719 = value;
        return true;
      },
      err: (error) => {
        $serializedResultError254719 = error;
        return false;
      },
    });
    if (($serializedResultOk254719 ? "ok" : "error") === "error")
      return Result.err($serializedResultError254719);
    const decoded = this.decodeRestoreOwnership($serializedResultValue254719, operation);
    let $decodedResultValue254857!: import("better-result").InferOk<NonNullable<typeof decoded>>;
    let $decodedResultError254857!: import("better-result").InferErr<NonNullable<typeof decoded>>;
    const $decodedResultOk254857 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decoded>>,
      import("better-result").InferErr<NonNullable<typeof decoded>>,
      boolean
    >(decoded, {
      ok: (value) => {
        $decodedResultValue254857 = value;
        return true;
      },
      err: (error) => {
        $decodedResultError254857 = error;
        return false;
      },
    });
    if (($decodedResultOk254857 ? "ok" : "error") === "error")
      return failWith($decodedResultError254857);
    return Result.ok($decodedResultValue254857);
  }

  private async parentIdentity(
    parentDirectory: string,
  ): Promise<WorkspaceHistoryResult<{ parentDev: string; parentIno: string }>> {
    const stats = await attemptHost(() => lstat(parentDirectory, { bigint: true }));
    let $statsResultValue255187!: import("better-result").InferOk<NonNullable<typeof stats>>;
    let $statsResultError255187!: import("better-result").InferErr<NonNullable<typeof stats>>;
    const $statsResultOk255187 = Result.match<
      import("better-result").InferOk<NonNullable<typeof stats>>,
      import("better-result").InferErr<NonNullable<typeof stats>>,
      boolean
    >(stats, {
      ok: (value) => {
        $statsResultValue255187 = value;
        return true;
      },
      err: (error) => {
        $statsResultError255187 = error;
        return false;
      },
    });
    if (($statsResultOk255187 ? "ok" : "error") === "error")
      return Result.err($statsResultError255187);
    if (!$statsResultValue255187.isDirectory() || $statsResultValue255187.isSymbolicLink()) {
      return failWith(this.restoreConflict("Restore artifact parent is not a real directory"));
    }
    return Result.ok({
      parentDev: $statsResultValue255187.dev.toString(),
      parentIno: $statsResultValue255187.ino.toString(),
    });
  }

  private async addRestoreArtifactIntent(
    manifestPath: string,
    manifest: RestoreOwnershipManifest,
    artifact: RestoreArtifactRecord,
  ): Promise<WorkspaceHistoryResult<RestoreArtifactRecord>> {
    manifest.artifacts.push(artifact);
    const written = await this.writeRestoreOwnershipManifest(manifestPath, manifest);
    let $writtenResultError255864!: import("better-result").InferErr<NonNullable<typeof written>>;
    const $writtenResultOk255864 = Result.match<
      import("better-result").InferOk<NonNullable<typeof written>>,
      import("better-result").InferErr<NonNullable<typeof written>>,
      boolean
    >(written, {
      ok: () => true,
      err: (error) => {
        $writtenResultError255864 = error;
        return false;
      },
    });
    if (($writtenResultOk255864 ? "ok" : "error") === "error")
      return Result.err($writtenResultError255864);
    return Result.ok(artifact);
  }

  private async completeRestoreArtifactIdentity(
    manifestPath: string,
    manifest: RestoreOwnershipManifest,
    artifact: RestoreArtifactRecord,
    identity: OwnedTemporaryPath,
  ): Promise<WorkspaceHistoryResult<void>> {
    artifact.dev = identity.dev.toString();
    artifact.ino = identity.ino.toString();
    return await this.writeRestoreOwnershipManifest(manifestPath, manifest);
  }

  private async removeRestoreArtifactRecord(
    manifestPath: string,
    manifest: RestoreOwnershipManifest,
    artifactPath: string,
  ): Promise<WorkspaceHistoryResult<void>> {
    const index = manifest.artifacts.findIndex((artifact) => artifact.path === artifactPath);
    if (index >= 0) manifest.artifacts.splice(index, 1);
    return await this.writeRestoreOwnershipManifest(manifestPath, manifest);
  }

  private async validateHardLinkPrimitive(
    entry: StagedTreeEntry,
    destinationDirectory: string,
    source: OwnedTemporaryPath,
    manifestPath: string,
    manifest: RestoreOwnershipManifest,
  ): Promise<WorkspaceHistoryResult<void>> {
    const relativePath = entry.relativePath;
    const testPath = path.join(destinationDirectory, this.restoreTemporaryName());
    const parent = await this.parentIdentity(destinationDirectory);
    let $parentResultValue257231!: import("better-result").InferOk<NonNullable<typeof parent>>;
    let $parentResultError257231!: import("better-result").InferErr<NonNullable<typeof parent>>;
    const $parentResultOk257231 = Result.match<
      import("better-result").InferOk<NonNullable<typeof parent>>,
      import("better-result").InferErr<NonNullable<typeof parent>>,
      boolean
    >(parent, {
      ok: (value) => {
        $parentResultValue257231 = value;
        return true;
      },
      err: (error) => {
        $parentResultError257231 = error;
        return false;
      },
    });
    if (($parentResultOk257231 ? "ok" : "error") === "error")
      return Result.err($parentResultError257231);
    const intent = await this.addRestoreArtifactIntent(manifestPath, manifest, {
      path: testPath,
      kind: "file",
      role: "hard-link-probe",
      expectedOid: entry.oid,
      expectedMode: entry.mode,
      expectedSourceDev: source.dev.toString(),
      expectedSourceIno: source.ino.toString(),
      ...$parentResultValue257231,
    });
    let $intentResultValue257349!: import("better-result").InferOk<NonNullable<typeof intent>>;
    let $intentResultError257349!: import("better-result").InferErr<NonNullable<typeof intent>>;
    const $intentResultOk257349 = Result.match<
      import("better-result").InferOk<NonNullable<typeof intent>>,
      import("better-result").InferErr<NonNullable<typeof intent>>,
      boolean
    >(intent, {
      ok: (value) => {
        $intentResultValue257349 = value;
        return true;
      },
      err: (error) => {
        $intentResultError257349 = error;
        return false;
      },
    });
    if (($intentResultOk257349 ? "ok" : "error") === "error")
      return Result.err($intentResultError257349);
    let testIdentity: OwnedTemporaryPath | undefined;
    let created = false;
    const primary = await superviseOutcome<void>(async () => {
      const before = await attemptHost(
        async () => await this.beforeHardLinkValidation?.(relativePath, destinationDirectory),
      );
      let $beforeResultError257886!: import("better-result").InferErr<NonNullable<typeof before>>;
      const $beforeResultOk257886 = Result.match<
        import("better-result").InferOk<NonNullable<typeof before>>,
        import("better-result").InferErr<NonNullable<typeof before>>,
        boolean
      >(before, {
        ok: () => true,
        err: (error) => {
          $beforeResultError257886 = error;
          return false;
        },
      });
      if (($beforeResultOk257886 ? "ok" : "error") === "error")
        return Result.err($beforeResultError257886);
      const linked = await attemptHost(() => link(source.path, testPath));
      let $linkedResultError258082!: import("better-result").InferErr<NonNullable<typeof linked>>;
      const $linkedResultOk258082 = Result.match<
        import("better-result").InferOk<NonNullable<typeof linked>>,
        import("better-result").InferErr<NonNullable<typeof linked>>,
        boolean
      >(linked, {
        ok: () => true,
        err: (error) => {
          $linkedResultError258082 = error;
          return false;
        },
      });
      if (($linkedResultOk258082 ? "ok" : "error") === "error")
        return Result.err($linkedResultError258082);
      created = true;
      const after = await attemptHost(
        async () => await this.afterArtifactCreateBeforeIdentity?.("hard-link-probe", testPath),
      );
      let $afterResultError258231!: import("better-result").InferErr<NonNullable<typeof after>>;
      const $afterResultOk258231 = Result.match<
        import("better-result").InferOk<NonNullable<typeof after>>,
        import("better-result").InferErr<NonNullable<typeof after>>,
        boolean
      >(after, {
        ok: () => true,
        err: (error) => {
          $afterResultError258231 = error;
          return false;
        },
      });
      if (($afterResultOk258231 ? "ok" : "error") === "error")
        return Result.err($afterResultError258231);
      const stats = await attemptHost(() => lstat(testPath, { bigint: true }));
      let $statsResultValue258426!: import("better-result").InferOk<NonNullable<typeof stats>>;
      let $statsResultError258426!: import("better-result").InferErr<NonNullable<typeof stats>>;
      const $statsResultOk258426 = Result.match<
        import("better-result").InferOk<NonNullable<typeof stats>>,
        import("better-result").InferErr<NonNullable<typeof stats>>,
        boolean
      >(stats, {
        ok: (value) => {
          $statsResultValue258426 = value;
          return true;
        },
        err: (error) => {
          $statsResultError258426 = error;
          return false;
        },
      });
      if (($statsResultOk258426 ? "ok" : "error") === "error")
        return Result.err($statsResultError258426);
      testIdentity = {
        path: testPath,
        dev: $statsResultValue258426.dev,
        ino: $statsResultValue258426.ino,
      };
      const completed = await this.completeRestoreArtifactIdentity(
        manifestPath,
        manifest,
        $intentResultValue257349,
        testIdentity,
      );
      let $completedResultError258641!: import("better-result").InferErr<
        NonNullable<typeof completed>
      >;
      const $completedResultOk258641 = Result.match<
        import("better-result").InferOk<NonNullable<typeof completed>>,
        import("better-result").InferErr<NonNullable<typeof completed>>,
        boolean
      >(completed, {
        ok: () => true,
        err: (error) => {
          $completedResultError258641 = error;
          return false;
        },
      });
      if (($completedResultOk258641 ? "ok" : "error") === "error")
        return Result.err($completedResultError258641);
      const beforeRemovalSynced = await this.fsyncDirectory(destinationDirectory);
      let $beforeRemovalSyncedResultError258860!: import("better-result").InferErr<
        NonNullable<typeof beforeRemovalSynced>
      >;
      const $beforeRemovalSyncedResultOk258860 = Result.match<
        import("better-result").InferOk<NonNullable<typeof beforeRemovalSynced>>,
        import("better-result").InferErr<NonNullable<typeof beforeRemovalSynced>>,
        boolean
      >(beforeRemovalSynced, {
        ok: () => true,
        err: (error) => {
          $beforeRemovalSyncedResultError258860 = error;
          return false;
        },
      });
      if (($beforeRemovalSyncedResultOk258860 ? "ok" : "error") === "error")
        return Result.err($beforeRemovalSyncedResultError258860);
      const owned = await this.assertOwnedTemporary(testIdentity);
      let $ownedResultError259021!: import("better-result").InferErr<NonNullable<typeof owned>>;
      const $ownedResultOk259021 = Result.match<
        import("better-result").InferOk<NonNullable<typeof owned>>,
        import("better-result").InferErr<NonNullable<typeof owned>>,
        boolean
      >(owned, {
        ok: () => true,
        err: (error) => {
          $ownedResultError259021 = error;
          return false;
        },
      });
      if (($ownedResultOk259021 ? "ok" : "error") === "error")
        return Result.err($ownedResultError259021);
      const removed = await attemptHost(() => rm(testPath));
      let $removedResultError259138!: import("better-result").InferErr<NonNullable<typeof removed>>;
      const $removedResultOk259138 = Result.match<
        import("better-result").InferOk<NonNullable<typeof removed>>,
        import("better-result").InferErr<NonNullable<typeof removed>>,
        boolean
      >(removed, {
        ok: () => true,
        err: (error) => {
          $removedResultError259138 = error;
          return false;
        },
      });
      if (($removedResultOk259138 ? "ok" : "error") === "error")
        return Result.err($removedResultError259138);
      const afterRemovalSynced = await this.fsyncDirectory(destinationDirectory);
      let $afterRemovalSyncedResultError259253!: import("better-result").InferErr<
        NonNullable<typeof afterRemovalSynced>
      >;
      const $afterRemovalSyncedResultOk259253 = Result.match<
        import("better-result").InferOk<NonNullable<typeof afterRemovalSynced>>,
        import("better-result").InferErr<NonNullable<typeof afterRemovalSynced>>,
        boolean
      >(afterRemovalSynced, {
        ok: () => true,
        err: (error) => {
          $afterRemovalSyncedResultError259253 = error;
          return false;
        },
      });
      if (($afterRemovalSyncedResultOk259253 ? "ok" : "error") === "error")
        return Result.err($afterRemovalSyncedResultError259253);
      const recordRemoved = await this.removeRestoreArtifactRecord(
        manifestPath,
        manifest,
        testPath,
      );
      let $recordRemovedResultError259411!: import("better-result").InferErr<
        NonNullable<typeof recordRemoved>
      >;
      const $recordRemovedResultOk259411 = Result.match<
        import("better-result").InferOk<NonNullable<typeof recordRemoved>>,
        import("better-result").InferErr<NonNullable<typeof recordRemoved>>,
        boolean
      >(recordRemoved, {
        ok: () => true,
        err: (error) => {
          $recordRemovedResultError259411 = error;
          return false;
        },
      });
      if (($recordRemovedResultOk259411 ? "ok" : "error") === "error")
        return Result.err($recordRemovedResultError259411);
      testIdentity = undefined;
      return Result.ok(undefined);
    });
    const cleanup = await runWorkspaceHistoryCleanup("validate hard-link primitive", [
      async () => {
        if (created) return Result.ok(undefined);
        return await this.removeRestoreArtifactRecord(manifestPath, manifest, testPath);
      },
      async () => {
        if (!testIdentity) return Result.ok(undefined);
        const identity = testIdentity;
        const current = await lstatIfExists(identity.path, true);
        let $currentResultValue260059!: import("better-result").InferOk<
          NonNullable<typeof current>
        >;
        let $currentResultError260059!: import("better-result").InferErr<
          NonNullable<typeof current>
        >;
        const $currentResultOk260059 = Result.match<
          import("better-result").InferOk<NonNullable<typeof current>>,
          import("better-result").InferErr<NonNullable<typeof current>>,
          boolean
        >(current, {
          ok: (value) => {
            $currentResultValue260059 = value;
            return true;
          },
          err: (error) => {
            $currentResultError260059 = error;
            return false;
          },
        });
        if (($currentResultOk260059 ? "ok" : "error") === "error")
          return Result.err($currentResultError260059);
        if (
          $currentResultValue260059 &&
          $currentResultValue260059.dev === identity.dev &&
          $currentResultValue260059.ino === identity.ino
        ) {
          const removed = await attemptHost(() => rm(identity.path));
          let $removedResultError260328!: import("better-result").InferErr<
            NonNullable<typeof removed>
          >;
          const $removedResultOk260328 = Result.match<
            import("better-result").InferOk<NonNullable<typeof removed>>,
            import("better-result").InferErr<NonNullable<typeof removed>>,
            boolean
          >(removed, {
            ok: () => true,
            err: (error) => {
              $removedResultError260328 = error;
              return false;
            },
          });
          if (($removedResultOk260328 ? "ok" : "error") === "error")
            return Result.err($removedResultError260328);
        }
        return await this.removeRestoreArtifactRecord(manifestPath, manifest, identity.path);
      },
    ]);
    const resolved = resolveOutcomeWithCleanup<void>(
      primary,
      cleanup,
      "validate hard-link primitive",
    );
    switch (resolved.status) {
      case "ok":
        return Result.ok(undefined);
      case "failed":
        return Result.err(resolved.failure);
      case "panic":
        return Result.err({ kind: "panic", cause: resolved.cause });
      case "defect":
        return await resolved.rejection.reject<WorkspaceHistoryResult<void>>();
    }
  }

  private async applyPreparedRestore(
    prepared: PreparedRestoreData,
  ): Promise<WorkspaceHistoryResult<{ status: "restored" }>> {
    const operation = "apply prepared workspace restore";
    if (prepared.state !== "prepared") {
      return failOwned({
        code: "workspace-invalid",
        operation,
        message: `Prepared restore is already ${prepared.state}`,
      });
    }
    prepared.state = "applying";
    let mutated = false;
    let changed = false;
    let primary = await superviseOutcome<{ status: "restored" }>(async () => {
      const sourceRepository = await this.discoverSourceRepository();
      let $sourceRepositoryResultValue261612!: import("better-result").InferOk<
        NonNullable<typeof sourceRepository>
      >;
      let $sourceRepositoryResultError261612!: import("better-result").InferErr<
        NonNullable<typeof sourceRepository>
      >;
      const $sourceRepositoryResultOk261612 = Result.match<
        import("better-result").InferOk<NonNullable<typeof sourceRepository>>,
        import("better-result").InferErr<NonNullable<typeof sourceRepository>>,
        boolean
      >(sourceRepository, {
        ok: (value) => {
          $sourceRepositoryResultValue261612 = value;
          return true;
        },
        err: (error) => {
          $sourceRepositoryResultError261612 = error;
          return false;
        },
      });
      if (($sourceRepositoryResultOk261612 ? "ok" : "error") === "error")
        return Result.err($sourceRepositoryResultError261612);
      if (!$sourceRepositoryResultValue261612) {
        return failWith(this.restoreConflict("Workspace is no longer inside a Git worktree"));
      }
      const staleCleaned = await this.cleanupStaleRestoreArtifactsLocked();
      let $staleCleanedResultError261894!: import("better-result").InferErr<
        NonNullable<typeof staleCleaned>
      >;
      const $staleCleanedResultOk261894 = Result.match<
        import("better-result").InferOk<NonNullable<typeof staleCleaned>>,
        import("better-result").InferErr<NonNullable<typeof staleCleaned>>,
        boolean
      >(staleCleaned, {
        ok: () => true,
        err: (error) => {
          $staleCleanedResultError261894 = error;
          return false;
        },
      });
      if (($staleCleanedResultOk261894 ? "ok" : "error") === "error")
        return Result.err($staleCleanedResultError261894);
      const fresh = await this.assertPreparedRestoreFresh(prepared);
      let $freshResultError262034!: import("better-result").InferErr<NonNullable<typeof fresh>>;
      const $freshResultOk262034 = Result.match<
        import("better-result").InferOk<NonNullable<typeof fresh>>,
        import("better-result").InferErr<NonNullable<typeof fresh>>,
        boolean
      >(fresh, {
        ok: () => true,
        err: (error) => {
          $freshResultError262034 = error;
          return false;
        },
      });
      if (($freshResultOk262034 ? "ok" : "error") === "error")
        return Result.err($freshResultError262034);
      if (!prepared.recovery) {
        const signatures = await this.captureProtectedSignatures();
        let $signaturesResultValue262187!: import("better-result").InferOk<
          NonNullable<typeof signatures>
        >;
        let $signaturesResultError262187!: import("better-result").InferErr<
          NonNullable<typeof signatures>
        >;
        const $signaturesResultOk262187 = Result.match<
          import("better-result").InferOk<NonNullable<typeof signatures>>,
          import("better-result").InferErr<NonNullable<typeof signatures>>,
          boolean
        >(signatures, {
          ok: (value) => {
            $signaturesResultValue262187 = value;
            return true;
          },
          err: (error) => {
            $signaturesResultError262187 = error;
            return false;
          },
        });
        if (($signaturesResultOk262187 ? "ok" : "error") === "error")
          return Result.err($signaturesResultError262187);
        prepared.protectedSignatures = $signaturesResultValue262187;
        if (prepared.operationId) {
          const manifest = await this.readRestorePlanManifest(prepared.operationId);
          let $manifestResultValue262412!: import("better-result").InferOk<
            NonNullable<typeof manifest>
          >;
          let $manifestResultError262412!: import("better-result").InferErr<
            NonNullable<typeof manifest>
          >;
          const $manifestResultOk262412 = Result.match<
            import("better-result").InferOk<NonNullable<typeof manifest>>,
            import("better-result").InferErr<NonNullable<typeof manifest>>,
            boolean
          >(manifest, {
            ok: (value) => {
              $manifestResultValue262412 = value;
              return true;
            },
            err: (error) => {
              $manifestResultError262412 = error;
              return false;
            },
          });
          if (($manifestResultOk262412 ? "ok" : "error") === "error")
            return Result.err($manifestResultError262412);
          const written = await this.writeRestorePlanManifest({
            ...$manifestResultValue262412,
            phase: "mutation-ready",
            protectedSignatures: this.signatureRecords(prepared.protectedSignatures),
          });
          let $writtenResultError262557!: import("better-result").InferErr<
            NonNullable<typeof written>
          >;
          const $writtenResultOk262557 = Result.match<
            import("better-result").InferOk<NonNullable<typeof written>>,
            import("better-result").InferErr<NonNullable<typeof written>>,
            boolean
          >(written, {
            ok: () => true,
            err: (error) => {
              $writtenResultError262557 = error;
              return false;
            },
          });
          if (($writtenResultOk262557 ? "ok" : "error") === "error")
            return Result.err($writtenResultError262557);
        }
      }
      const current = prepared.current;
      const snapshot = prepared.snapshot;
      const changedTargets = new Set<string>();
      for (const [relativePath, target] of snapshot.entries) {
        const matches = await this.liveEntryMatches(target);
        let $matchesResultValue263056!: import("better-result").InferOk<
          NonNullable<typeof matches>
        >;
        let $matchesResultError263056!: import("better-result").InferErr<
          NonNullable<typeof matches>
        >;
        const $matchesResultOk263056 = Result.match<
          import("better-result").InferOk<NonNullable<typeof matches>>,
          import("better-result").InferErr<NonNullable<typeof matches>>,
          boolean
        >(matches, {
          ok: (value) => {
            $matchesResultValue263056 = value;
            return true;
          },
          err: (error) => {
            $matchesResultError263056 = error;
            return false;
          },
        });
        if (($matchesResultOk263056 ? "ok" : "error") === "error")
          return Result.err($matchesResultError263056);
        if (!$matchesResultValue263056) changedTargets.add(relativePath);
      }
      const destinationStaging = await this.stageDestinationEntries(
        prepared.stagedEntries,
        changedTargets,
        prepared.workspaceIdentity,
        prepared.snapshot.rootTreeOid,
        prepared.stagingDirectory,
      );
      let $destinationStagingResultValue263241!: import("better-result").InferOk<
        NonNullable<typeof destinationStaging>
      >;
      let $destinationStagingResultError263241!: import("better-result").InferErr<
        NonNullable<typeof destinationStaging>
      >;
      const $destinationStagingResultOk263241 = Result.match<
        import("better-result").InferOk<NonNullable<typeof destinationStaging>>,
        import("better-result").InferErr<NonNullable<typeof destinationStaging>>,
        boolean
      >(destinationStaging, {
        ok: (value) => {
          $destinationStagingResultValue263241 = value;
          return true;
        },
        err: (error) => {
          $destinationStagingResultError263241 = error;
          return false;
        },
      });
      if (($destinationStagingResultOk263241 ? "ok" : "error") === "error")
        return Result.err($destinationStagingResultError263241);
      Object.assign(prepared, $destinationStagingResultValue263241);
      const stillFresh = await this.assertPreparedRestoreFresh(prepared);
      let $stillFreshResultError263618!: import("better-result").InferErr<
        NonNullable<typeof stillFresh>
      >;
      const $stillFreshResultOk263618 = Result.match<
        import("better-result").InferOk<NonNullable<typeof stillFresh>>,
        import("better-result").InferErr<NonNullable<typeof stillFresh>>,
        boolean
      >(stillFresh, {
        ok: () => true,
        err: (error) => {
          $stillFreshResultError263618 = error;
          return false;
        },
      });
      if (($stillFreshResultOk263618 ? "ok" : "error") === "error")
        return Result.err($stillFreshResultError263618);
      const stagingValid = await this.validateDestinationStaging(prepared);
      let $stagingValidResultError263752!: import("better-result").InferErr<
        NonNullable<typeof stagingValid>
      >;
      const $stagingValidResultOk263752 = Result.match<
        import("better-result").InferOk<NonNullable<typeof stagingValid>>,
        import("better-result").InferErr<NonNullable<typeof stagingValid>>,
        boolean
      >(stagingValid, {
        ok: () => true,
        err: (error) => {
          $stagingValidResultError263752 = error;
          return false;
        },
      });
      if (($stagingValidResultOk263752 ? "ok" : "error") === "error")
        return Result.err($stagingValidResultError263752);
      const afterStaging = await attemptHost(async () => await this.afterDestinationStaging?.());
      let $afterStagingResultError263892!: import("better-result").InferErr<
        NonNullable<typeof afterStaging>
      >;
      const $afterStagingResultOk263892 = Result.match<
        import("better-result").InferOk<NonNullable<typeof afterStaging>>,
        import("better-result").InferErr<NonNullable<typeof afterStaging>>,
        boolean
      >(afterStaging, {
        ok: () => true,
        err: (error) => {
          $afterStagingResultError263892 = error;
          return false;
        },
      });
      if (($afterStagingResultOk263892 ? "ok" : "error") === "error")
        return Result.err($afterStagingResultError263892);

      const removals = [...current.managed.keys()].filter((relativePath) => {
        const target = snapshot.entries.get(relativePath);
        return !target || changedTargets.has(relativePath);
      });
      changed = changedTargets.size > 0 || removals.length > 0;
      removals.sort(
        (left, right) =>
          right.split("/").length - left.split("/").length || right.localeCompare(left),
      );
      for (const relativePath of removals) {
        const before = await this.beforeLiveMutation(relativePath);
        let $beforeResultError264517!: import("better-result").InferErr<NonNullable<typeof before>>;
        const $beforeResultOk264517 = Result.match<
          import("better-result").InferOk<NonNullable<typeof before>>,
          import("better-result").InferErr<NonNullable<typeof before>>,
          boolean
        >(before, {
          ok: () => true,
          err: (error) => {
            $beforeResultError264517 = error;
            return false;
          },
        });
        if (($beforeResultOk264517 ? "ok" : "error") === "error")
          return Result.err($beforeResultError264517);
        const safe = await this.assertSafeMutationAncestors(
          relativePath,
          prepared.workspaceIdentity,
        );
        let $safeResultError264639!: import("better-result").InferErr<NonNullable<typeof safe>>;
        const $safeResultOk264639 = Result.match<
          import("better-result").InferOk<NonNullable<typeof safe>>,
          import("better-result").InferErr<NonNullable<typeof safe>>,
          boolean
        >(safe, {
          ok: () => true,
          err: (error) => {
            $safeResultError264639 = error;
            return false;
          },
        });
        if (($safeResultOk264639 ? "ok" : "error") === "error")
          return Result.err($safeResultError264639);
        const absolutePath = fromPosixPath(this.cwd, relativePath);
        const existing = await lstatIfExists(absolutePath);
        let $existingResultValue264891!: import("better-result").InferOk<
          NonNullable<typeof existing>
        >;
        let $existingResultError264891!: import("better-result").InferErr<
          NonNullable<typeof existing>
        >;
        const $existingResultOk264891 = Result.match<
          import("better-result").InferOk<NonNullable<typeof existing>>,
          import("better-result").InferErr<NonNullable<typeof existing>>,
          boolean
        >(existing, {
          ok: (value) => {
            $existingResultValue264891 = value;
            return true;
          },
          err: (error) => {
            $existingResultError264891 = error;
            return false;
          },
        });
        if (($existingResultOk264891 ? "ok" : "error") === "error")
          return Result.err($existingResultError264891);
        if (
          $existingResultValue264891?.isDirectory() &&
          [...snapshot.entries.keys()].some((candidate) => candidate.startsWith(`${relativePath}/`))
        ) {
          continue;
        }
        if ($existingResultValue264891) {
          const signatureValid = await this.assertLiveSignature(
            relativePath,
            prepared.liveSignatures.get(relativePath),
          );
          let $signatureValidResultError265240!: import("better-result").InferErr<
            NonNullable<typeof signatureValid>
          >;
          const $signatureValidResultOk265240 = Result.match<
            import("better-result").InferOk<NonNullable<typeof signatureValid>>,
            import("better-result").InferErr<NonNullable<typeof signatureValid>>,
            boolean
          >(signatureValid, {
            ok: () => true,
            err: (error) => {
              $signatureValidResultError265240 = error;
              return false;
            },
          });
          if (($signatureValidResultOk265240 ? "ok" : "error") === "error")
            return Result.err($signatureValidResultError265240);
          const removed = await attemptHost(() => rm(absolutePath));
          let $removedResultError265471!: import("better-result").InferErr<
            NonNullable<typeof removed>
          >;
          const $removedResultOk265471 = Result.match<
            import("better-result").InferOk<NonNullable<typeof removed>>,
            import("better-result").InferErr<NonNullable<typeof removed>>,
            boolean
          >(removed, {
            ok: () => true,
            err: (error) => {
              $removedResultError265471 = error;
              return false;
            },
          });
          if (($removedResultOk265471 ? "ok" : "error") === "error")
            return Result.err($removedResultError265471);
          mutated = true;
          const afterDeletion = await attemptHost(
            async () => await this.afterLiveDeletion?.(relativePath),
          );
          let $afterDeletionResultError265624!: import("better-result").InferErr<
            NonNullable<typeof afterDeletion>
          >;
          const $afterDeletionResultOk265624 = Result.match<
            import("better-result").InferOk<NonNullable<typeof afterDeletion>>,
            import("better-result").InferErr<NonNullable<typeof afterDeletion>>,
            boolean
          >(afterDeletion, {
            ok: () => true,
            err: (error) => {
              $afterDeletionResultError265624 = error;
              return false;
            },
          });
          if (($afterDeletionResultOk265624 ? "ok" : "error") === "error")
            return Result.err($afterDeletionResultError265624);
        }
      }

      for (const replacementRoot of [...prepared.replacementRoots.values()].sort(
        (left, right) => left.relativePath.split("/").length - right.relativePath.split("/").length,
      )) {
        const published = await this.publishReplacementRoot(replacementRoot, prepared);
        let $publishedResultError266039!: import("better-result").InferErr<
          NonNullable<typeof published>
        >;
        const $publishedResultOk266039 = Result.match<
          import("better-result").InferOk<NonNullable<typeof published>>,
          import("better-result").InferErr<NonNullable<typeof published>>,
          boolean
        >(published, {
          ok: () => true,
          err: (error) => {
            $publishedResultError266039 = error;
            return false;
          },
        });
        if (($publishedResultOk266039 ? "ok" : "error") === "error")
          return Result.err($publishedResultError266039);
        mutated = true;
      }

      const targetDirectories = new Set<string>();
      for (const relativePath of snapshot.entries.keys()) {
        for (const ancestor of pathAncestors(relativePath)) targetDirectories.add(ancestor);
      }
      for (const relativePath of [...targetDirectories].sort(
        (left, right) =>
          left.split("/").length - right.split("/").length || left.localeCompare(right),
      )) {
        const before = await this.beforeLiveMutation(relativePath);
        let $beforeResultError266619!: import("better-result").InferErr<NonNullable<typeof before>>;
        const $beforeResultOk266619 = Result.match<
          import("better-result").InferOk<NonNullable<typeof before>>,
          import("better-result").InferErr<NonNullable<typeof before>>,
          boolean
        >(before, {
          ok: () => true,
          err: (error) => {
            $beforeResultError266619 = error;
            return false;
          },
        });
        if (($beforeResultOk266619 ? "ok" : "error") === "error")
          return Result.err($beforeResultError266619);
        const safe = await this.assertSafeMutationAncestors(
          relativePath,
          prepared.workspaceIdentity,
        );
        let $safeResultError266741!: import("better-result").InferErr<NonNullable<typeof safe>>;
        const $safeResultOk266741 = Result.match<
          import("better-result").InferOk<NonNullable<typeof safe>>,
          import("better-result").InferErr<NonNullable<typeof safe>>,
          boolean
        >(safe, {
          ok: () => true,
          err: (error) => {
            $safeResultError266741 = error;
            return false;
          },
        });
        if (($safeResultOk266741 ? "ok" : "error") === "error")
          return Result.err($safeResultError266741);
        const absolutePath = fromPosixPath(this.cwd, relativePath);
        const stats = await lstatIfExists(absolutePath);
        let $statsResultValue266993!: import("better-result").InferOk<NonNullable<typeof stats>>;
        let $statsResultError266993!: import("better-result").InferErr<NonNullable<typeof stats>>;
        const $statsResultOk266993 = Result.match<
          import("better-result").InferOk<NonNullable<typeof stats>>,
          import("better-result").InferErr<NonNullable<typeof stats>>,
          boolean
        >(stats, {
          ok: (value) => {
            $statsResultValue266993 = value;
            return true;
          },
          err: (error) => {
            $statsResultError266993 = error;
            return false;
          },
        });
        if (($statsResultOk266993 ? "ok" : "error") === "error")
          return Result.err($statsResultError266993);
        if ($statsResultValue266993 && !$statsResultValue266993.isDirectory()) {
          return failWith(
            this.restoreConflict(`Target directory path changed before apply: ${relativePath}`),
          );
        }
        if (!$statsResultValue266993) {
          return failWith(
            this.restoreConflict(
              `Pre-staged target directory disappeared before apply: ${relativePath}`,
            ),
          );
        }
      }

      for (const relativePath of [...changedTargets].sort()) {
        const staged = prepared.destinationEntries.get(relativePath);
        if (!staged) {
          return failWith(this.verificationError(`Target blob was not staged: ${relativePath}`));
        }
        const absolutePath = fromPosixPath(this.cwd, relativePath);
        const existing = await lstatIfExists(absolutePath);
        let $existingResultValue267861!: import("better-result").InferOk<
          NonNullable<typeof existing>
        >;
        let $existingResultError267861!: import("better-result").InferErr<
          NonNullable<typeof existing>
        >;
        const $existingResultOk267861 = Result.match<
          import("better-result").InferOk<NonNullable<typeof existing>>,
          import("better-result").InferErr<NonNullable<typeof existing>>,
          boolean
        >(existing, {
          ok: (value) => {
            $existingResultValue267861 = value;
            return true;
          },
          err: (error) => {
            $existingResultError267861 = error;
            return false;
          },
        });
        if (($existingResultOk267861 ? "ok" : "error") === "error")
          return Result.err($existingResultError267861);
        if ($existingResultValue267861?.isDirectory()) {
          const before = await this.beforeLiveMutation(relativePath);
          let $beforeResultError268026!: import("better-result").InferErr<
            NonNullable<typeof before>
          >;
          const $beforeResultOk268026 = Result.match<
            import("better-result").InferOk<NonNullable<typeof before>>,
            import("better-result").InferErr<NonNullable<typeof before>>,
            boolean
          >(before, {
            ok: () => true,
            err: (error) => {
              $beforeResultError268026 = error;
              return false;
            },
          });
          if (($beforeResultOk268026 ? "ok" : "error") === "error")
            return Result.err($beforeResultError268026);
          const safe = await this.assertSafeMutationAncestors(
            relativePath,
            prepared.workspaceIdentity,
          );
          let $safeResultError268152!: import("better-result").InferErr<NonNullable<typeof safe>>;
          const $safeResultOk268152 = Result.match<
            import("better-result").InferOk<NonNullable<typeof safe>>,
            import("better-result").InferErr<NonNullable<typeof safe>>,
            boolean
          >(safe, {
            ok: () => true,
            err: (error) => {
              $safeResultError268152 = error;
              return false;
            },
          });
          if (($safeResultOk268152 ? "ok" : "error") === "error")
            return Result.err($safeResultError268152);
          const removed = await attemptHost(() => rmdir(absolutePath));
          let $removedResultError268346!: import("better-result").InferErr<
            NonNullable<typeof removed>
          >;
          const $removedResultOk268346 = Result.match<
            import("better-result").InferOk<NonNullable<typeof removed>>,
            import("better-result").InferErr<NonNullable<typeof removed>>,
            boolean
          >(removed, {
            ok: () => true,
            err: (error) => {
              $removedResultError268346 = error;
              return false;
            },
          });
          if (($removedResultOk268346 ? "ok" : "error") === "error")
            return Result.err($removedResultError268346);
          mutated = true;
        } else if ($existingResultValue267861) {
          return failWith(
            this.restoreConflict(`Target path changed before materialization: ${relativePath}`),
          );
        }
        mutated = true;
        const published = await this.publishDestinationSibling(staged, prepared);
        let $publishedResultError268708!: import("better-result").InferErr<
          NonNullable<typeof published>
        >;
        const $publishedResultOk268708 = Result.match<
          import("better-result").InferOk<NonNullable<typeof published>>,
          import("better-result").InferErr<NonNullable<typeof published>>,
          boolean
        >(published, {
          ok: () => true,
          err: (error) => {
            $publishedResultError268708 = error;
            return false;
          },
        });
        if (($publishedResultOk268708 ? "ok" : "error") === "error")
          return Result.err($publishedResultError268708);
      }

      const removableDirectories = new Set<string>();
      for (const relativePath of current.managed.keys()) {
        for (const ancestor of pathAncestors(relativePath)) removableDirectories.add(ancestor);
      }
      for (const relativePath of [...removableDirectories].sort(
        (left, right) =>
          right.split("/").length - left.split("/").length || right.localeCompare(left),
      )) {
        if (targetDirectories.has(relativePath) || snapshot.entries.has(relativePath)) continue;
        const before = await this.beforeLiveMutation(relativePath);
        let $beforeResultError269363!: import("better-result").InferErr<NonNullable<typeof before>>;
        const $beforeResultOk269363 = Result.match<
          import("better-result").InferOk<NonNullable<typeof before>>,
          import("better-result").InferErr<NonNullable<typeof before>>,
          boolean
        >(before, {
          ok: () => true,
          err: (error) => {
            $beforeResultError269363 = error;
            return false;
          },
        });
        if (($beforeResultOk269363 ? "ok" : "error") === "error")
          return Result.err($beforeResultError269363);
        const safe = await this.assertSafeMutationAncestors(
          relativePath,
          prepared.workspaceIdentity,
        );
        let $safeResultError269485!: import("better-result").InferErr<NonNullable<typeof safe>>;
        const $safeResultOk269485 = Result.match<
          import("better-result").InferOk<NonNullable<typeof safe>>,
          import("better-result").InferErr<NonNullable<typeof safe>>,
          boolean
        >(safe, {
          ok: () => true,
          err: (error) => {
            $safeResultError269485 = error;
            return false;
          },
        });
        if (($safeResultOk269485 ? "ok" : "error") === "error")
          return Result.err($safeResultError269485);
        const absolutePath = fromPosixPath(this.cwd, relativePath);
        const stats = await lstatIfExists(absolutePath);
        let $statsResultValue269737!: import("better-result").InferOk<NonNullable<typeof stats>>;
        let $statsResultError269737!: import("better-result").InferErr<NonNullable<typeof stats>>;
        const $statsResultOk269737 = Result.match<
          import("better-result").InferOk<NonNullable<typeof stats>>,
          import("better-result").InferErr<NonNullable<typeof stats>>,
          boolean
        >(stats, {
          ok: (value) => {
            $statsResultValue269737 = value;
            return true;
          },
          err: (error) => {
            $statsResultError269737 = error;
            return false;
          },
        });
        if (($statsResultOk269737 ? "ok" : "error") === "error")
          return Result.err($statsResultError269737);
        if (!$statsResultValue269737) continue;
        if (!$statsResultValue269737.isDirectory()) {
          return failWith(
            this.restoreConflict(`Managed directory path changed before cleanup: ${relativePath}`),
          );
        }
        const removed = await attemptHost(() => rmdir(absolutePath));
        let $removedResultError270074!: import("better-result").InferErr<
          NonNullable<typeof removed>
        >;
        const $removedResultOk270074 = Result.match<
          import("better-result").InferOk<NonNullable<typeof removed>>,
          import("better-result").InferErr<NonNullable<typeof removed>>,
          boolean
        >(removed, {
          ok: () => true,
          err: (error) => {
            $removedResultError270074 = error;
            return false;
          },
        });
        if (
          ($removedResultOk270074 ? "ok" : "error") === "error" &&
          hostErrorCode($removedResultError270074) !== "ENOTEMPTY"
        ) {
          return Result.err($removedResultError270074);
        }
      }

      const beforeVerification = await attemptHost(
        async () => await this.beforeFinalVerification?.(),
      );
      let $beforeVerificationResultError270277!: import("better-result").InferErr<
        NonNullable<typeof beforeVerification>
      >;
      const $beforeVerificationResultOk270277 = Result.match<
        import("better-result").InferOk<NonNullable<typeof beforeVerification>>,
        import("better-result").InferErr<NonNullable<typeof beforeVerification>>,
        boolean
      >(beforeVerification, {
        ok: () => true,
        err: (error) => {
          $beforeVerificationResultError270277 = error;
          return false;
        },
      });
      if (($beforeVerificationResultOk270277 ? "ok" : "error") === "error")
        return Result.err($beforeVerificationResultError270277);
      const verifiedTargetEntries = await this.verifyFrozenRestoredSnapshot(prepared);
      let $verifiedTargetEntriesResultValue270474!: import("better-result").InferOk<
        NonNullable<typeof verifiedTargetEntries>
      >;
      let $verifiedTargetEntriesResultError270474!: import("better-result").InferErr<
        NonNullable<typeof verifiedTargetEntries>
      >;
      const $verifiedTargetEntriesResultOk270474 = Result.match<
        import("better-result").InferOk<NonNullable<typeof verifiedTargetEntries>>,
        import("better-result").InferErr<NonNullable<typeof verifiedTargetEntries>>,
        boolean
      >(verifiedTargetEntries, {
        ok: (value) => {
          $verifiedTargetEntriesResultValue270474 = value;
          return true;
        },
        err: (error) => {
          $verifiedTargetEntriesResultError270474 = error;
          return false;
        },
      });
      if (($verifiedTargetEntriesResultOk270474 ? "ok" : "error") === "error")
        return Result.err($verifiedTargetEntriesResultError270474);
      const protectedVerified = await this.verifyProtectedSignatures(prepared.protectedSignatures);
      let $protectedVerifiedResultError270643!: import("better-result").InferErr<
        NonNullable<typeof protectedVerified>
      >;
      const $protectedVerifiedResultOk270643 = Result.match<
        import("better-result").InferOk<NonNullable<typeof protectedVerified>>,
        import("better-result").InferErr<NonNullable<typeof protectedVerified>>,
        boolean
      >(protectedVerified, {
        ok: () => true,
        err: (error) => {
          $protectedVerifiedResultError270643 = error;
          return false;
        },
      });
      if (($protectedVerifiedResultOk270643 ? "ok" : "error") === "error")
        return Result.err($protectedVerifiedResultError270643);
      const cachePrimary = await superviseOutcome<void>(async () => {
        const afterVerification = await attemptHost(
          async () => await this.afterFinalVerificationBeforeCacheReconciliation?.(),
        );
        let $afterVerificationResultError270889!: import("better-result").InferErr<
          NonNullable<typeof afterVerification>
        >;
        const $afterVerificationResultOk270889 = Result.match<
          import("better-result").InferOk<NonNullable<typeof afterVerification>>,
          import("better-result").InferErr<NonNullable<typeof afterVerification>>,
          boolean
        >(afterVerification, {
          ok: () => true,
          err: (error) => {
            $afterVerificationResultError270889 = error;
            return false;
          },
        });
        if (($afterVerificationResultOk270889 ? "ok" : "error") === "error")
          return Result.err($afterVerificationResultError270889);
        return await this.reconcileCaptureStateAfterRestore(
          snapshot,
          $verifiedTargetEntriesResultValue270474,
        );
      });
      if (cachePrimary.status !== "ok") {
        const cacheCleanup = await runWorkspaceHistoryCleanup(
          "reconcile capture state after restore",
          [
            async () => await attemptHost(() => rm(this.captureCachePath, { force: true })),
            async () => await attemptHost(() => rm(this.captureIndexPath, { force: true })),
          ],
        );
        const cacheResolved = resolveOutcomeWithCleanup<void>(
          cachePrimary,
          cacheCleanup,
          "reconcile capture state after restore",
        );
        switch (cacheResolved.status) {
          case "ok":
            break;
          case "failed":
            return Result.err(cacheResolved.failure);
          case "panic":
            return Result.err({ kind: "panic", cause: cacheResolved.cause });
          case "defect":
            return await cacheResolved.rejection.reject<WorkspaceHistoryResult<never>>();
        }
      }
      prepared.state = "applied";
      const disposed = await this.disposePreparedRestore(prepared);
      let $disposedResultError272202!: import("better-result").InferErr<
        NonNullable<typeof disposed>
      >;
      const $disposedResultOk272202 = Result.match<
        import("better-result").InferOk<NonNullable<typeof disposed>>,
        import("better-result").InferErr<NonNullable<typeof disposed>>,
        boolean
      >(disposed, {
        ok: () => true,
        err: (error) => {
          $disposedResultError272202 = error;
          return false;
        },
      });
      if (($disposedResultOk272202 ? "ok" : "error") === "error")
        return Result.err($disposedResultError272202);
      this.emitRestoreMetric(
        prepared.metricStartedAt,
        prepared.candidatePathCount,
        prepared.managedPathCount,
        prepared.materializedBytes,
        changed,
        "restored",
      );
      return Result.ok({ status: "restored" as const });
    });
    if (primary.status === "ok") return Result.ok(primary.value);
    if (primary.status === "failed" && primary.failure.kind === "git-unavailable") {
      primary = {
        status: "failed",
        failure: {
          kind: "owned",
          error: new WorkspaceHistoryStoreError({
            code: "git-command-failed",
            operation,
            message: mutated
              ? "Git became unavailable after workspace restoration began"
              : "Git became unavailable after workspace restoration was prepared",
            cause: primary.failure.signal,
          }),
        },
      };
    }
    prepared.state = "disposed";
    const cleanup = await runWorkspaceHistoryCleanup(operation, [
      async () =>
        await this.cleanupDestinationArtifacts(
          prepared.ownedTemps,
          prepared.ownedDirectories,
          prepared.workspaceIdentity,
        ),
      async () => {
        const cleaned = await this.cleanupStaleRestoreArtifactsLocked();
        let $cleanedResultError273535!: import("better-result").InferErr<
          NonNullable<typeof cleaned>
        >;
        const $cleanedResultOk273535 = Result.match<
          import("better-result").InferOk<NonNullable<typeof cleaned>>,
          import("better-result").InferErr<NonNullable<typeof cleaned>>,
          boolean
        >(cleaned, {
          ok: () => true,
          err: (error) => {
            $cleanedResultError273535 = error;
            return false;
          },
        });
        if (($cleanedResultOk273535 ? "ok" : "error") === "error")
          return Result.err($cleanedResultError273535);
        return Result.ok(undefined);
      },
      async () =>
        await attemptHost(() => rm(prepared.stagingDirectory, { recursive: true, force: true })),
    ]);
    const resolved = resolveOutcomeWithCleanup<{ status: "restored" }>(primary, cleanup, operation);
    this.emitRestoreMetric(
      prepared.metricStartedAt,
      prepared.candidatePathCount,
      prepared.managedPathCount,
      prepared.materializedBytes,
      changed,
      "failed",
    );
    switch (resolved.status) {
      case "ok":
        return Result.ok(resolved.value);
      case "failed": {
        const error = labelStoreError(resolved.failure, operation);
        this.emitVerificationFailure(
          prepared.metricStartedAt,
          "restore",
          prepared.managedPathCount,
          error,
        );
        return failWith(error);
      }
      case "panic":
        return Result.err({ kind: "panic", cause: resolved.cause });
      case "defect":
        return await resolved.rejection.reject<WorkspaceHistoryResult<{ status: "restored" }>>();
    }
  }

  private async publishReplacementRoot(
    root: ReplacementDirectoryRoot,
    prepared: PreparedRestoreData,
  ): Promise<WorkspaceHistoryResult<void>> {
    const before = await this.beforeLiveMutation(root.relativePath);
    let $beforeResultError274905!: import("better-result").InferErr<NonNullable<typeof before>>;
    const $beforeResultOk274905 = Result.match<
      import("better-result").InferOk<NonNullable<typeof before>>,
      import("better-result").InferErr<NonNullable<typeof before>>,
      boolean
    >(before, {
      ok: () => true,
      err: (error) => {
        $beforeResultError274905 = error;
        return false;
      },
    });
    if (($beforeResultOk274905 ? "ok" : "error") === "error")
      return Result.err($beforeResultError274905);
    const safe = await this.assertSafeMutationAncestors(
      root.relativePath,
      prepared.workspaceIdentity,
    );
    let $safeResultError275024!: import("better-result").InferErr<NonNullable<typeof safe>>;
    const $safeResultOk275024 = Result.match<
      import("better-result").InferOk<NonNullable<typeof safe>>,
      import("better-result").InferErr<NonNullable<typeof safe>>,
      boolean
    >(safe, {
      ok: () => true,
      err: (error) => {
        $safeResultError275024 = error;
        return false;
      },
    });
    if (($safeResultOk275024 ? "ok" : "error") === "error")
      return Result.err($safeResultError275024);
    const owned = await this.assertOwnedTemporary(root.identity);
    let $ownedResultError275193!: import("better-result").InferErr<NonNullable<typeof owned>>;
    const $ownedResultOk275193 = Result.match<
      import("better-result").InferOk<NonNullable<typeof owned>>,
      import("better-result").InferErr<NonNullable<typeof owned>>,
      boolean
    >(owned, {
      ok: () => true,
      err: (error) => {
        $ownedResultError275193 = error;
        return false;
      },
    });
    if (($ownedResultOk275193 ? "ok" : "error") === "error")
      return Result.err($ownedResultError275193);
    const targetPath = fromPosixPath(this.cwd, root.relativePath);
    const existing = await lstatIfExists(targetPath);
    let $existingResultValue275374!: import("better-result").InferOk<NonNullable<typeof existing>>;
    let $existingResultError275374!: import("better-result").InferErr<NonNullable<typeof existing>>;
    const $existingResultOk275374 = Result.match<
      import("better-result").InferOk<NonNullable<typeof existing>>,
      import("better-result").InferErr<NonNullable<typeof existing>>,
      boolean
    >(existing, {
      ok: (value) => {
        $existingResultValue275374 = value;
        return true;
      },
      err: (error) => {
        $existingResultError275374 = error;
        return false;
      },
    });
    if (($existingResultOk275374 ? "ok" : "error") === "error")
      return Result.err($existingResultError275374);
    if ($existingResultValue275374) {
      return failWith(
        this.restoreConflict(`Replacement directory target appeared: ${root.relativePath}`),
      );
    }
    const aliases = await this.writeReplacementMoveAliases(
      root.temporaryPath,
      targetPath,
      prepared,
    );
    let $aliasesResultError275639!: import("better-result").InferErr<NonNullable<typeof aliases>>;
    const $aliasesResultOk275639 = Result.match<
      import("better-result").InferOk<NonNullable<typeof aliases>>,
      import("better-result").InferErr<NonNullable<typeof aliases>>,
      boolean
    >(aliases, {
      ok: () => true,
      err: (error) => {
        $aliasesResultError275639 = error;
        return false;
      },
    });
    if (($aliasesResultOk275639 ? "ok" : "error") === "error")
      return Result.err($aliasesResultError275639);
    const moved = await attemptHost(() => rename(root.temporaryPath, targetPath));
    let $movedResultError275818!: import("better-result").InferErr<NonNullable<typeof moved>>;
    const $movedResultOk275818 = Result.match<
      import("better-result").InferOk<NonNullable<typeof moved>>,
      import("better-result").InferErr<NonNullable<typeof moved>>,
      boolean
    >(moved, {
      ok: () => true,
      err: (error) => {
        $movedResultError275818 = error;
        return false;
      },
    });
    if (($movedResultOk275818 ? "ok" : "error") === "error")
      return Result.err($movedResultError275818);
    const synced = await this.fsyncDirectory(path.dirname(targetPath));
    let $syncedResultError275949!: import("better-result").InferErr<NonNullable<typeof synced>>;
    const $syncedResultOk275949 = Result.match<
      import("better-result").InferOk<NonNullable<typeof synced>>,
      import("better-result").InferErr<NonNullable<typeof synced>>,
      boolean
    >(synced, {
      ok: () => true,
      err: (error) => {
        $syncedResultError275949 = error;
        return false;
      },
    });
    if (($syncedResultOk275949 ? "ok" : "error") === "error")
      return Result.err($syncedResultError275949);
    root.published = true;

    const movedTemps: [string, OwnedTemporaryPath][] = [];
    for (const [temporaryPath, identity] of prepared.ownedTemps) {
      if (!this.isWithinOrEqual(root.temporaryPath, temporaryPath)) continue;
      const movedPath = path.join(targetPath, path.relative(root.temporaryPath, temporaryPath));
      prepared.ownedTemps.delete(temporaryPath);
      movedTemps.push([movedPath, { ...identity, path: movedPath }]);
    }
    for (const [movedPath, identity] of movedTemps) prepared.ownedTemps.set(movedPath, identity);
    for (const entry of prepared.destinationEntries.values()) {
      if (!this.isWithinOrEqual(root.temporaryPath, entry.temporaryPath)) continue;
      entry.temporaryPath = path.join(
        targetPath,
        path.relative(root.temporaryPath, entry.temporaryPath),
      );
    }
    for (const directoryPath of prepared.ownedDirectories.keys()) {
      if (this.isWithinOrEqual(root.temporaryPath, directoryPath)) {
        prepared.ownedDirectories.delete(directoryPath);
      }
    }
    const manifestSynced = await this.syncPreparedOwnershipManifest(prepared);
    let $manifestSyncedResultError277117!: import("better-result").InferErr<
      NonNullable<typeof manifestSynced>
    >;
    const $manifestSyncedResultOk277117 = Result.match<
      import("better-result").InferOk<NonNullable<typeof manifestSynced>>,
      import("better-result").InferErr<NonNullable<typeof manifestSynced>>,
      boolean
    >(manifestSynced, {
      ok: () => true,
      err: (error) => {
        $manifestSyncedResultError277117 = error;
        return false;
      },
    });
    if (($manifestSyncedResultOk277117 ? "ok" : "error") === "error")
      return Result.err($manifestSyncedResultError277117);
    return await attemptHost(async () => await this.afterPublication?.(root.relativePath));
  }

  private async writeReplacementMoveAliases(
    sourceRoot: string,
    targetRoot: string,
    prepared: PreparedRestoreData,
  ): Promise<WorkspaceHistoryResult<void>> {
    if (!prepared.ownershipManifest || !prepared.ownershipManifestPath) {
      return Result.ok(undefined);
    }
    const aliases = prepared.ownershipManifest.artifacts
      .filter((artifact) => this.isWithinOrEqual(sourceRoot, artifact.path))
      .map((artifact) => ({
        ...artifact,
        path: path.join(targetRoot, path.relative(sourceRoot, artifact.path)),
      }));
    prepared.ownershipManifest.artifacts.push(...aliases);
    return await this.writeRestoreOwnershipManifest(
      prepared.ownershipManifestPath,
      prepared.ownershipManifest,
    );
  }

  private async validateDestinationStaging(
    prepared: PreparedRestoreData,
  ): Promise<WorkspaceHistoryResult<void>> {
    for (const [relativePath, entry] of prepared.destinationEntries) {
      const temporary = prepared.ownedTemps.get(entry.temporaryPath);
      if (!temporary) {
        return failWith(
          this.restoreConflict(`Destination sibling ownership is missing: ${relativePath}`),
        );
      }
      const owned = await this.assertOwnedTemporary(temporary);
      let $ownedResultError278544!: import("better-result").InferErr<NonNullable<typeof owned>>;
      const $ownedResultOk278544 = Result.match<
        import("better-result").InferOk<NonNullable<typeof owned>>,
        import("better-result").InferErr<NonNullable<typeof owned>>,
        boolean
      >(owned, {
        ok: () => true,
        err: (error) => {
          $ownedResultError278544 = error;
          return false;
        },
      });
      if (($ownedResultOk278544 ? "ok" : "error") === "error")
        return Result.err($ownedResultError278544);
      const temporaryStats = await attemptHost(() => lstat(entry.temporaryPath));
      let $temporaryStatsResultValue278658!: import("better-result").InferOk<
        NonNullable<typeof temporaryStats>
      >;
      let $temporaryStatsResultError278658!: import("better-result").InferErr<
        NonNullable<typeof temporaryStats>
      >;
      const $temporaryStatsResultOk278658 = Result.match<
        import("better-result").InferOk<NonNullable<typeof temporaryStats>>,
        import("better-result").InferErr<NonNullable<typeof temporaryStats>>,
        boolean
      >(temporaryStats, {
        ok: (value) => {
          $temporaryStatsResultValue278658 = value;
          return true;
        },
        err: (error) => {
          $temporaryStatsResultError278658 = error;
          return false;
        },
      });
      if (($temporaryStatsResultOk278658 ? "ok" : "error") === "error")
        return Result.err($temporaryStatsResultError278658);
      let temporaryMode: number;
      if ($temporaryStatsResultValue278658.isSymbolicLink()) {
        temporaryMode = POSIX_SYMLINK_MODE;
      } else if (
        $temporaryStatsResultValue278658.isFile() &&
        ($temporaryStatsResultValue278658.mode & 0o111) !== 0
      ) {
        temporaryMode = POSIX_EXECUTABLE_MODE;
      } else if ($temporaryStatsResultValue278658.isFile()) {
        temporaryMode = POSIX_FILE_MODE;
      } else {
        temporaryMode = 0;
      }
      if (temporaryMode !== entry.mode) {
        return failWith(this.restoreConflict(`Destination sibling mode changed: ${relativePath}`));
      }
      const parent = path.dirname(entry.temporaryPath);
      const parentStats = await attemptHost(() => lstat(parent));
      let $parentStatsResultValue279425!: import("better-result").InferOk<
        NonNullable<typeof parentStats>
      >;
      let $parentStatsResultError279425!: import("better-result").InferErr<
        NonNullable<typeof parentStats>
      >;
      const $parentStatsResultOk279425 = Result.match<
        import("better-result").InferOk<NonNullable<typeof parentStats>>,
        import("better-result").InferErr<NonNullable<typeof parentStats>>,
        boolean
      >(parentStats, {
        ok: (value) => {
          $parentStatsResultValue279425 = value;
          return true;
        },
        err: (error) => {
          $parentStatsResultError279425 = error;
          return false;
        },
      });
      if (($parentStatsResultOk279425 ? "ok" : "error") === "error")
        return Result.err($parentStatsResultError279425);
      if (
        !$parentStatsResultValue279425.isDirectory() ||
        $parentStatsResultValue279425.isSymbolicLink()
      ) {
        return failWith(
          this.restoreConflict(`Destination staging parent changed: ${relativePath}`),
        );
      }
      const accessible = await attemptHost(() =>
        access(parent, fsConstants.W_OK | fsConstants.X_OK),
      );
      let $accessibleResultError279768!: import("better-result").InferErr<
        NonNullable<typeof accessible>
      >;
      const $accessibleResultOk279768 = Result.match<
        import("better-result").InferOk<NonNullable<typeof accessible>>,
        import("better-result").InferErr<NonNullable<typeof accessible>>,
        boolean
      >(accessible, {
        ok: () => true,
        err: (error) => {
          $accessibleResultError279768 = error;
          return false;
        },
      });
      if (($accessibleResultOk279768 ? "ok" : "error") === "error")
        return Result.err($accessibleResultError279768);
      let oid: WorkspaceHistoryResult<string>;
      if (entry.mode === POSIX_SYMLINK_MODE) {
        const target = await attemptHost(() =>
          readlink(entry.temporaryPath, { encoding: "buffer" }),
        );
        let $targetResultValue280043!: import("better-result").InferOk<NonNullable<typeof target>>;
        let $targetResultError280043!: import("better-result").InferErr<NonNullable<typeof target>>;
        const $targetResultOk280043 = Result.match<
          import("better-result").InferOk<NonNullable<typeof target>>,
          import("better-result").InferErr<NonNullable<typeof target>>,
          boolean
        >(target, {
          ok: (value) => {
            $targetResultValue280043 = value;
            return true;
          },
          err: (error) => {
            $targetResultError280043 = error;
            return false;
          },
        });
        if (($targetResultOk280043 ? "ok" : "error") === "error")
          return Result.err($targetResultError280043);
        oid = await this.hashBytes($targetResultValue280043, false);
      } else {
        oid = await this.hashFile(entry.temporaryPath, false);
      }
      let $oidResultValue279945!: import("better-result").InferOk<NonNullable<typeof oid>>;
      let $oidResultError279945!: import("better-result").InferErr<NonNullable<typeof oid>>;
      const $oidResultOk279945 = Result.match<
        import("better-result").InferOk<NonNullable<typeof oid>>,
        import("better-result").InferErr<NonNullable<typeof oid>>,
        boolean
      >(oid, {
        ok: (value) => {
          $oidResultValue279945 = value;
          return true;
        },
        err: (error) => {
          $oidResultError279945 = error;
          return false;
        },
      });
      if (($oidResultOk279945 ? "ok" : "error") === "error")
        return Result.err($oidResultError279945);
      if ($oidResultValue279945 !== entry.oid) {
        return failWith(
          this.restoreConflict(`Destination sibling changed after preparation: ${relativePath}`),
        );
      }
    }
    for (const root of prepared.replacementRoots.values()) {
      if (!root.published) {
        const owned = await this.assertOwnedTemporary(root.identity);
        let $ownedResultError280684!: import("better-result").InferErr<NonNullable<typeof owned>>;
        const $ownedResultOk280684 = Result.match<
          import("better-result").InferOk<NonNullable<typeof owned>>,
          import("better-result").InferErr<NonNullable<typeof owned>>,
          boolean
        >(owned, {
          ok: () => true,
          err: (error) => {
            $ownedResultError280684 = error;
            return false;
          },
        });
        if (($ownedResultOk280684 ? "ok" : "error") === "error")
          return Result.err($ownedResultError280684);
      }
    }
    return Result.ok(undefined);
  }

  private async publishDestinationSibling(
    entry: DestinationStagedEntry,
    prepared: PreparedRestoreData,
  ): Promise<WorkspaceHistoryResult<void>> {
    const temporary = prepared.ownedTemps.get(entry.temporaryPath);
    if (!temporary) {
      return failWith(this.verificationError("Destination sibling ownership is missing"));
    }
    const absolutePath = fromPosixPath(this.cwd, entry.relativePath);
    const before = await this.beforeLiveMutation(entry.relativePath);
    let $beforeResultError281269!: import("better-result").InferErr<NonNullable<typeof before>>;
    const $beforeResultOk281269 = Result.match<
      import("better-result").InferOk<NonNullable<typeof before>>,
      import("better-result").InferErr<NonNullable<typeof before>>,
      boolean
    >(before, {
      ok: () => true,
      err: (error) => {
        $beforeResultError281269 = error;
        return false;
      },
    });
    if (($beforeResultOk281269 ? "ok" : "error") === "error")
      return Result.err($beforeResultError281269);
    const safe = await this.assertSafeMutationAncestors(
      entry.relativePath,
      prepared.workspaceIdentity,
    );
    let $safeResultError281389!: import("better-result").InferErr<NonNullable<typeof safe>>;
    const $safeResultOk281389 = Result.match<
      import("better-result").InferOk<NonNullable<typeof safe>>,
      import("better-result").InferErr<NonNullable<typeof safe>>,
      boolean
    >(safe, {
      ok: () => true,
      err: (error) => {
        $safeResultError281389 = error;
        return false;
      },
    });
    if (($safeResultOk281389 ? "ok" : "error") === "error")
      return Result.err($safeResultError281389);
    const existing = await lstatIfExists(absolutePath);
    let $existingResultValue281559!: import("better-result").InferOk<NonNullable<typeof existing>>;
    let $existingResultError281559!: import("better-result").InferErr<NonNullable<typeof existing>>;
    const $existingResultOk281559 = Result.match<
      import("better-result").InferOk<NonNullable<typeof existing>>,
      import("better-result").InferErr<NonNullable<typeof existing>>,
      boolean
    >(existing, {
      ok: (value) => {
        $existingResultValue281559 = value;
        return true;
      },
      err: (error) => {
        $existingResultError281559 = error;
        return false;
      },
    });
    if (($existingResultOk281559 ? "ok" : "error") === "error")
      return Result.err($existingResultError281559);
    if ($existingResultValue281559) {
      return failWith(
        this.restoreConflict(`Target appeared before publication: ${entry.relativePath}`),
      );
    }
    const owned = await this.assertOwnedTemporary(temporary);
    let $ownedResultError281824!: import("better-result").InferErr<NonNullable<typeof owned>>;
    const $ownedResultOk281824 = Result.match<
      import("better-result").InferOk<NonNullable<typeof owned>>,
      import("better-result").InferErr<NonNullable<typeof owned>>,
      boolean
    >(owned, {
      ok: () => true,
      err: (error) => {
        $ownedResultError281824 = error;
        return false;
      },
    });
    if (($ownedResultOk281824 ? "ok" : "error") === "error")
      return Result.err($ownedResultError281824);
    const linked = await attemptHost(() => link(temporary.path, absolutePath));
    let $linkedResultError281934!: import("better-result").InferErr<NonNullable<typeof linked>>;
    const $linkedResultOk281934 = Result.match<
      import("better-result").InferOk<NonNullable<typeof linked>>,
      import("better-result").InferErr<NonNullable<typeof linked>>,
      boolean
    >(linked, {
      ok: () => true,
      err: (error) => {
        $linkedResultError281934 = error;
        return false;
      },
    });
    if (($linkedResultOk281934 ? "ok" : "error") === "error") {
      if (hostErrorCode($linkedResultError281934) === "EEXIST") {
        return failWith(
          this.restoreConflict(`Target appeared before publication: ${entry.relativePath}`),
        );
      }
      return linked;
    }
    const synced = await this.fsyncDirectory(path.dirname(absolutePath));
    let $syncedResultError282269!: import("better-result").InferErr<NonNullable<typeof synced>>;
    const $syncedResultOk282269 = Result.match<
      import("better-result").InferOk<NonNullable<typeof synced>>,
      import("better-result").InferErr<NonNullable<typeof synced>>,
      boolean
    >(synced, {
      ok: () => true,
      err: (error) => {
        $syncedResultError282269 = error;
        return false;
      },
    });
    if (($syncedResultOk282269 ? "ok" : "error") === "error")
      return Result.err($syncedResultError282269);
    const stillOwned = await this.assertOwnedTemporary(temporary);
    let $stillOwnedResultError282393!: import("better-result").InferErr<
      NonNullable<typeof stillOwned>
    >;
    const $stillOwnedResultOk282393 = Result.match<
      import("better-result").InferOk<NonNullable<typeof stillOwned>>,
      import("better-result").InferErr<NonNullable<typeof stillOwned>>,
      boolean
    >(stillOwned, {
      ok: () => true,
      err: (error) => {
        $stillOwnedResultError282393 = error;
        return false;
      },
    });
    if (($stillOwnedResultOk282393 ? "ok" : "error") === "error")
      return Result.err($stillOwnedResultError282393);
    const removed = await attemptHost(() => rm(temporary.path));
    let $removedResultError282518!: import("better-result").InferErr<NonNullable<typeof removed>>;
    const $removedResultOk282518 = Result.match<
      import("better-result").InferOk<NonNullable<typeof removed>>,
      import("better-result").InferErr<NonNullable<typeof removed>>,
      boolean
    >(removed, {
      ok: () => true,
      err: (error) => {
        $removedResultError282518 = error;
        return false;
      },
    });
    if (($removedResultOk282518 ? "ok" : "error") === "error")
      return Result.err($removedResultError282518);
    prepared.ownedTemps.delete(temporary.path);
    const manifestSynced = await this.syncPreparedOwnershipManifest(prepared);
    let $manifestSyncedResultError282683!: import("better-result").InferErr<
      NonNullable<typeof manifestSynced>
    >;
    const $manifestSyncedResultOk282683 = Result.match<
      import("better-result").InferOk<NonNullable<typeof manifestSynced>>,
      import("better-result").InferErr<NonNullable<typeof manifestSynced>>,
      boolean
    >(manifestSynced, {
      ok: () => true,
      err: (error) => {
        $manifestSyncedResultError282683 = error;
        return false;
      },
    });
    if (($manifestSyncedResultOk282683 ? "ok" : "error") === "error")
      return Result.err($manifestSyncedResultError282683);
    return await attemptHost(async () => await this.afterPublication?.(entry.relativePath));
  }

  private async syncPreparedOwnershipManifest(
    prepared: PreparedRestoreData,
  ): Promise<WorkspaceHistoryResult<void>> {
    if (!prepared.ownershipManifest || !prepared.ownershipManifestPath) {
      return Result.ok(undefined);
    }
    const previous = prepared.ownershipManifest.artifacts;
    const records: RestoreArtifactRecord[] = [];
    const retainIdentity = (
      artifact: OwnedTemporaryPath,
      kind: "file" | "directory",
    ): WorkspaceHistoryResult<void> => {
      const dev = artifact.dev.toString();
      const ino = artifact.ino.toString();
      const record = previous.find(
        (candidate) =>
          candidate.kind === kind &&
          candidate.role !== "hard-link-probe" &&
          candidate.dev === dev &&
          candidate.ino === ino,
      );
      if (!record) {
        return failWith(this.restoreConflict("Restore ownership record disappeared during apply"));
      }
      records.push({ ...record, path: artifact.path });
      return Result.ok(undefined);
    };
    for (const artifact of prepared.ownedTemps.values()) {
      const retained = retainIdentity(artifact, "file");
      let $retainedResultError284013!: import("better-result").InferErr<
        NonNullable<typeof retained>
      >;
      const $retainedResultOk284013 = Result.match<
        import("better-result").InferOk<NonNullable<typeof retained>>,
        import("better-result").InferErr<NonNullable<typeof retained>>,
        boolean
      >(retained, {
        ok: () => true,
        err: (error) => {
          $retainedResultError284013 = error;
          return false;
        },
      });
      if (($retainedResultOk284013 ? "ok" : "error") === "error")
        return Result.err($retainedResultError284013);
    }
    for (const artifact of prepared.ownedDirectories.values()) {
      const retained = retainIdentity(artifact, "directory");
      let $retainedResultError284197!: import("better-result").InferErr<
        NonNullable<typeof retained>
      >;
      const $retainedResultOk284197 = Result.match<
        import("better-result").InferOk<NonNullable<typeof retained>>,
        import("better-result").InferErr<NonNullable<typeof retained>>,
        boolean
      >(retained, {
        ok: () => true,
        err: (error) => {
          $retainedResultError284197 = error;
          return false;
        },
      });
      if (($retainedResultOk284197 ? "ok" : "error") === "error")
        return Result.err($retainedResultError284197);
    }
    prepared.ownershipManifest.artifacts = records;
    return await this.writeRestoreOwnershipManifest(
      prepared.ownershipManifestPath,
      prepared.ownershipManifest,
    );
  }

  private async assertOwnedTemporary(
    temporary: OwnedTemporaryPath,
  ): Promise<WorkspaceHistoryResult<void>> {
    const stats = await lstatIfExists(temporary.path, true);
    let $statsResultValue284626!: import("better-result").InferOk<NonNullable<typeof stats>>;
    let $statsResultError284626!: import("better-result").InferErr<NonNullable<typeof stats>>;
    const $statsResultOk284626 = Result.match<
      import("better-result").InferOk<NonNullable<typeof stats>>,
      import("better-result").InferErr<NonNullable<typeof stats>>,
      boolean
    >(stats, {
      ok: (value) => {
        $statsResultValue284626 = value;
        return true;
      },
      err: (error) => {
        $statsResultError284626 = error;
        return false;
      },
    });
    if (($statsResultOk284626 ? "ok" : "error") === "error")
      return Result.err($statsResultError284626);
    if (
      !$statsResultValue284626 ||
      $statsResultValue284626.dev !== temporary.dev ||
      $statsResultValue284626.ino !== temporary.ino
    ) {
      return failWith(
        this.restoreConflict("Operation-owned temporary path was replaced before rename"),
      );
    }
    return Result.ok(undefined);
  }

  private async cleanupDestinationArtifacts(
    ownedTemps: Map<string, OwnedTemporaryPath>,
    ownedDirectories: Map<string, OwnedTemporaryPath>,
    workspaceIdentity: string,
  ): Promise<WorkspaceHistoryResult<void>> {
    for (const temporary of ownedTemps.values()) {
      const relativePath = toPosixPath(path.relative(this.cwd, temporary.path));
      const safe = await this.assertSafeMutationAncestors(relativePath, workspaceIdentity);
      let $safeResultError285359!: import("better-result").InferErr<NonNullable<typeof safe>>;
      const $safeResultOk285359 = Result.match<
        import("better-result").InferOk<NonNullable<typeof safe>>,
        import("better-result").InferErr<NonNullable<typeof safe>>,
        boolean
      >(safe, {
        ok: () => true,
        err: (error) => {
          $safeResultError285359 = error;
          return false;
        },
      });
      if (($safeResultOk285359 ? "ok" : "error") === "error")
        return Result.err($safeResultError285359);
      const stats = await lstatIfExists(temporary.path, true);
      let $statsResultValue285499!: import("better-result").InferOk<NonNullable<typeof stats>>;
      let $statsResultError285499!: import("better-result").InferErr<NonNullable<typeof stats>>;
      const $statsResultOk285499 = Result.match<
        import("better-result").InferOk<NonNullable<typeof stats>>,
        import("better-result").InferErr<NonNullable<typeof stats>>,
        boolean
      >(stats, {
        ok: (value) => {
          $statsResultValue285499 = value;
          return true;
        },
        err: (error) => {
          $statsResultError285499 = error;
          return false;
        },
      });
      if (($statsResultOk285499 ? "ok" : "error") === "error")
        return Result.err($statsResultError285499);
      if (
        $statsResultValue285499 &&
        $statsResultValue285499.dev === temporary.dev &&
        $statsResultValue285499.ino === temporary.ino
      ) {
        const removed = await attemptHost(() => rm(temporary.path));
        let $removedResultError285713!: import("better-result").InferErr<
          NonNullable<typeof removed>
        >;
        const $removedResultOk285713 = Result.match<
          import("better-result").InferOk<NonNullable<typeof removed>>,
          import("better-result").InferErr<NonNullable<typeof removed>>,
          boolean
        >(removed, {
          ok: () => true,
          err: (error) => {
            $removedResultError285713 = error;
            return false;
          },
        });
        if (($removedResultOk285713 ? "ok" : "error") === "error")
          return Result.err($removedResultError285713);
      }
    }
    ownedTemps.clear();
    for (const directory of [...ownedDirectories.values()].sort(
      (left, right) => right.path.split(path.sep).length - left.path.split(path.sep).length,
    )) {
      const relativePath = toPosixPath(path.relative(this.cwd, directory.path));
      const safe = await this.assertSafeMutationAncestors(relativePath, workspaceIdentity);
      let $safeResultError286122!: import("better-result").InferErr<NonNullable<typeof safe>>;
      const $safeResultOk286122 = Result.match<
        import("better-result").InferOk<NonNullable<typeof safe>>,
        import("better-result").InferErr<NonNullable<typeof safe>>,
        boolean
      >(safe, {
        ok: () => true,
        err: (error) => {
          $safeResultError286122 = error;
          return false;
        },
      });
      if (($safeResultOk286122 ? "ok" : "error") === "error")
        return Result.err($safeResultError286122);
      const stats = await lstatIfExists(directory.path, true);
      let $statsResultValue286262!: import("better-result").InferOk<NonNullable<typeof stats>>;
      let $statsResultError286262!: import("better-result").InferErr<NonNullable<typeof stats>>;
      const $statsResultOk286262 = Result.match<
        import("better-result").InferOk<NonNullable<typeof stats>>,
        import("better-result").InferErr<NonNullable<typeof stats>>,
        boolean
      >(stats, {
        ok: (value) => {
          $statsResultValue286262 = value;
          return true;
        },
        err: (error) => {
          $statsResultError286262 = error;
          return false;
        },
      });
      if (($statsResultOk286262 ? "ok" : "error") === "error")
        return Result.err($statsResultError286262);
      if (
        !$statsResultValue286262 ||
        $statsResultValue286262.dev !== directory.dev ||
        $statsResultValue286262.ino !== directory.ino
      ) {
        continue;
      }
      const removed = await attemptHost(() => rmdir(directory.path));
      let $removedResultError286501!: import("better-result").InferErr<NonNullable<typeof removed>>;
      const $removedResultOk286501 = Result.match<
        import("better-result").InferOk<NonNullable<typeof removed>>,
        import("better-result").InferErr<NonNullable<typeof removed>>,
        boolean
      >(removed, {
        ok: () => true,
        err: (error) => {
          $removedResultError286501 = error;
          return false;
        },
      });
      if (
        ($removedResultOk286501 ? "ok" : "error") === "error" &&
        hostErrorCode($removedResultError286501) !== "ENOTEMPTY"
      )
        return Result.err($removedResultError286501);
    }
    ownedDirectories.clear();
    return Result.ok(undefined);
  }

  private async cleanupStaleRestoreArtifactsLocked(): Promise<
    WorkspaceHistoryResult<WorkspaceHistoryCleanupResult>
  > {
    const removed: string[] = [];
    const preserved: string[] = [];
    const directoryStats = await lstatIfExists(this.restoreOwnershipDirectory);
    let $directoryStatsResultValue286950!: import("better-result").InferOk<
      NonNullable<typeof directoryStats>
    >;
    let $directoryStatsResultError286950!: import("better-result").InferErr<
      NonNullable<typeof directoryStats>
    >;
    const $directoryStatsResultOk286950 = Result.match<
      import("better-result").InferOk<NonNullable<typeof directoryStats>>,
      import("better-result").InferErr<NonNullable<typeof directoryStats>>,
      boolean
    >(directoryStats, {
      ok: (value) => {
        $directoryStatsResultValue286950 = value;
        return true;
      },
      err: (error) => {
        $directoryStatsResultError286950 = error;
        return false;
      },
    });
    if (($directoryStatsResultOk286950 ? "ok" : "error") === "error")
      return Result.err($directoryStatsResultError286950);
    if (!$directoryStatsResultValue286950) return Result.ok({ removed, preserved });
    if (
      !$directoryStatsResultValue286950.isDirectory() ||
      $directoryStatsResultValue286950.isSymbolicLink()
    ) {
      return failOwned({
        code: "ownership-mismatch",
        operation: "clean stale restore staging",
        message: "Restore ownership manifest path is not a real directory",
      });
    }
    const workspaceIdentity = await this.workspaceIdentity();
    let $workspaceIdentityResultValue287460!: import("better-result").InferOk<
      NonNullable<typeof workspaceIdentity>
    >;
    let $workspaceIdentityResultError287460!: import("better-result").InferErr<
      NonNullable<typeof workspaceIdentity>
    >;
    const $workspaceIdentityResultOk287460 = Result.match<
      import("better-result").InferOk<NonNullable<typeof workspaceIdentity>>,
      import("better-result").InferErr<NonNullable<typeof workspaceIdentity>>,
      boolean
    >(workspaceIdentity, {
      ok: (value) => {
        $workspaceIdentityResultValue287460 = value;
        return true;
      },
      err: (error) => {
        $workspaceIdentityResultError287460 = error;
        return false;
      },
    });
    if (($workspaceIdentityResultOk287460 ? "ok" : "error") === "error")
      return Result.err($workspaceIdentityResultError287460);
    const manifestEntries = await attemptHost(() =>
      readdir(this.restoreOwnershipDirectory, { withFileTypes: true }),
    );
    let $manifestEntriesResultValue287594!: import("better-result").InferOk<
      NonNullable<typeof manifestEntries>
    >;
    let $manifestEntriesResultError287594!: import("better-result").InferErr<
      NonNullable<typeof manifestEntries>
    >;
    const $manifestEntriesResultOk287594 = Result.match<
      import("better-result").InferOk<NonNullable<typeof manifestEntries>>,
      import("better-result").InferErr<NonNullable<typeof manifestEntries>>,
      boolean
    >(manifestEntries, {
      ok: (value) => {
        $manifestEntriesResultValue287594 = value;
        return true;
      },
      err: (error) => {
        $manifestEntriesResultError287594 = error;
        return false;
      },
    });
    if (($manifestEntriesResultOk287594 ? "ok" : "error") === "error")
      return Result.err($manifestEntriesResultError287594);
    for (const manifestEntry of $manifestEntriesResultValue287594) {
      if (!manifestEntry.isFile() || !manifestEntry.name.endsWith(".json")) continue;
      const manifestPath = path.join(this.restoreOwnershipDirectory, manifestEntry.name);
      const manifest = await this.readRestoreOwnershipManifest(
        manifestPath,
        "clean stale restore staging",
      );
      let $manifestResultValue288028!: import("better-result").InferOk<
        NonNullable<typeof manifest>
      >;
      let $manifestResultError288028!: import("better-result").InferErr<
        NonNullable<typeof manifest>
      >;
      const $manifestResultOk288028 = Result.match<
        import("better-result").InferOk<NonNullable<typeof manifest>>,
        import("better-result").InferErr<NonNullable<typeof manifest>>,
        boolean
      >(manifest, {
        ok: (value) => {
          $manifestResultValue288028 = value;
          return true;
        },
        err: (error) => {
          $manifestResultError288028 = error;
          return false;
        },
      });
      if (($manifestResultOk288028 ? "ok" : "error") === "error")
        return Result.err($manifestResultError288028);
      const artifacts = $manifestResultValue288028.artifacts;
      const resolved = new Set<RestoreArtifactRecord>();
      const recognizableRoots = artifacts
        .filter(
          (artifact) =>
            artifact.kind === "directory" && this.isRestoreTempName(path.basename(artifact.path)),
        )
        .map((artifact) => artifact.path);
      const isRecognizable = (artifactPath: string): boolean =>
        this.isRestoreTempName(path.basename(artifactPath)) ||
        recognizableRoots.some((root) => this.isWithinOrEqual(root, artifactPath));
      for (const artifact of artifacts
        .filter((candidate) => candidate.kind === "file")
        .sort((left, right) => right.path.length - left.path.length)) {
        if (!this.isWithinOrEqual(this.cwd, artifact.path) || !isRecognizable(artifact.path)) {
          preserved.push(artifact.path);
          continue;
        }
        const relativePath = toPosixPath(path.relative(this.cwd, artifact.path));
        const safe = await this.assertSafeMutationAncestors(
          relativePath,
          $workspaceIdentityResultValue287460,
        );
        let $safeResultError289191!: import("better-result").InferErr<NonNullable<typeof safe>>;
        const $safeResultOk289191 = Result.match<
          import("better-result").InferOk<NonNullable<typeof safe>>,
          import("better-result").InferErr<NonNullable<typeof safe>>,
          boolean
        >(safe, {
          ok: () => true,
          err: (error) => {
            $safeResultError289191 = error;
            return false;
          },
        });
        if (($safeResultOk289191 ? "ok" : "error") === "error")
          return Result.err($safeResultError289191);
        const stats = await lstatIfExists(artifact.path, true);
        let $statsResultValue289341!: import("better-result").InferOk<NonNullable<typeof stats>>;
        let $statsResultError289341!: import("better-result").InferErr<NonNullable<typeof stats>>;
        const $statsResultOk289341 = Result.match<
          import("better-result").InferOk<NonNullable<typeof stats>>,
          import("better-result").InferErr<NonNullable<typeof stats>>,
          boolean
        >(stats, {
          ok: (value) => {
            $statsResultValue289341 = value;
            return true;
          },
          err: (error) => {
            $statsResultError289341 = error;
            return false;
          },
        });
        if (($statsResultOk289341 ? "ok" : "error") === "error")
          return Result.err($statsResultError289341);
        if (!$statsResultValue289341) {
          resolved.add(artifact);
          continue;
        }
        const identityMatches =
          artifact.dev !== undefined &&
          artifact.ino !== undefined &&
          $statsResultValue289341.dev === BigInt(artifact.dev) &&
          $statsResultValue289341.ino === BigInt(artifact.ino);
        const intentMatches = await this.intentArtifactMatches(artifact, $statsResultValue289341);
        let $intentMatchesResultValue289767!: import("better-result").InferOk<
          NonNullable<typeof intentMatches>
        >;
        let $intentMatchesResultError289767!: import("better-result").InferErr<
          NonNullable<typeof intentMatches>
        >;
        const $intentMatchesResultOk289767 = Result.match<
          import("better-result").InferOk<NonNullable<typeof intentMatches>>,
          import("better-result").InferErr<NonNullable<typeof intentMatches>>,
          boolean
        >(intentMatches, {
          ok: (value) => {
            $intentMatchesResultValue289767 = value;
            return true;
          },
          err: (error) => {
            $intentMatchesResultError289767 = error;
            return false;
          },
        });
        if (($intentMatchesResultOk289767 ? "ok" : "error") === "error")
          return Result.err($intentMatchesResultError289767);
        if (!identityMatches && !$intentMatchesResultValue289767) {
          preserved.push(artifact.path);
          continue;
        }
        const artifactRemoved = await attemptHost(() => rm(artifact.path));
        let $artifactRemovedResultError290049!: import("better-result").InferErr<
          NonNullable<typeof artifactRemoved>
        >;
        const $artifactRemovedResultOk290049 = Result.match<
          import("better-result").InferOk<NonNullable<typeof artifactRemoved>>,
          import("better-result").InferErr<NonNullable<typeof artifactRemoved>>,
          boolean
        >(artifactRemoved, {
          ok: () => true,
          err: (error) => {
            $artifactRemovedResultError290049 = error;
            return false;
          },
        });
        if (($artifactRemovedResultOk290049 ? "ok" : "error") === "error")
          return Result.err($artifactRemovedResultError290049);
        removed.push(artifact.path);
        resolved.add(artifact);
      }
      for (const artifact of artifacts
        .filter((candidate) => candidate.kind === "directory")
        .sort(
          (left, right) => right.path.split(path.sep).length - left.path.split(path.sep).length,
        )) {
        if (!this.isWithinOrEqual(this.cwd, artifact.path) || !isRecognizable(artifact.path)) {
          preserved.push(artifact.path);
          continue;
        }
        const relativePath = toPosixPath(path.relative(this.cwd, artifact.path));
        const safe = await this.assertSafeMutationAncestors(
          relativePath,
          $workspaceIdentityResultValue287460,
        );
        let $safeResultError290750!: import("better-result").InferErr<NonNullable<typeof safe>>;
        const $safeResultOk290750 = Result.match<
          import("better-result").InferOk<NonNullable<typeof safe>>,
          import("better-result").InferErr<NonNullable<typeof safe>>,
          boolean
        >(safe, {
          ok: () => true,
          err: (error) => {
            $safeResultError290750 = error;
            return false;
          },
        });
        if (($safeResultOk290750 ? "ok" : "error") === "error")
          return Result.err($safeResultError290750);
        const stats = await lstatIfExists(artifact.path, true);
        let $statsResultValue290900!: import("better-result").InferOk<NonNullable<typeof stats>>;
        let $statsResultError290900!: import("better-result").InferErr<NonNullable<typeof stats>>;
        const $statsResultOk290900 = Result.match<
          import("better-result").InferOk<NonNullable<typeof stats>>,
          import("better-result").InferErr<NonNullable<typeof stats>>,
          boolean
        >(stats, {
          ok: (value) => {
            $statsResultValue290900 = value;
            return true;
          },
          err: (error) => {
            $statsResultError290900 = error;
            return false;
          },
        });
        if (($statsResultOk290900 ? "ok" : "error") === "error")
          return Result.err($statsResultError290900);
        if (!$statsResultValue290900) {
          resolved.add(artifact);
          continue;
        }
        const identityMatches =
          artifact.dev !== undefined &&
          artifact.ino !== undefined &&
          $statsResultValue290900.dev === BigInt(artifact.dev) &&
          $statsResultValue290900.ino === BigInt(artifact.ino);
        const intentMatches = await this.intentArtifactMatches(artifact, $statsResultValue290900);
        let $intentMatchesResultValue291326!: import("better-result").InferOk<
          NonNullable<typeof intentMatches>
        >;
        let $intentMatchesResultError291326!: import("better-result").InferErr<
          NonNullable<typeof intentMatches>
        >;
        const $intentMatchesResultOk291326 = Result.match<
          import("better-result").InferOk<NonNullable<typeof intentMatches>>,
          import("better-result").InferErr<NonNullable<typeof intentMatches>>,
          boolean
        >(intentMatches, {
          ok: (value) => {
            $intentMatchesResultValue291326 = value;
            return true;
          },
          err: (error) => {
            $intentMatchesResultError291326 = error;
            return false;
          },
        });
        if (($intentMatchesResultOk291326 ? "ok" : "error") === "error")
          return Result.err($intentMatchesResultError291326);
        if (!identityMatches && !$intentMatchesResultValue291326) {
          preserved.push(artifact.path);
          continue;
        }
        const directoryRemoved = await attemptHost(() => rmdir(artifact.path));
        let $directoryRemovedResultError291608!: import("better-result").InferErr<
          NonNullable<typeof directoryRemoved>
        >;
        const $directoryRemovedResultOk291608 = Result.match<
          import("better-result").InferOk<NonNullable<typeof directoryRemoved>>,
          import("better-result").InferErr<NonNullable<typeof directoryRemoved>>,
          boolean
        >(directoryRemoved, {
          ok: () => true,
          err: (error) => {
            $directoryRemovedResultError291608 = error;
            return false;
          },
        });
        if (($directoryRemovedResultOk291608 ? "ok" : "error") === "ok") {
          removed.push(artifact.path);
          resolved.add(artifact);
        } else if (hostErrorCode($directoryRemovedResultError291608) === "ENOTEMPTY") {
          preserved.push(artifact.path);
        } else {
          return Result.err($directoryRemovedResultError291608);
        }
      }
      $manifestResultValue288028.artifacts = $manifestResultValue288028.artifacts.filter(
        (artifact) => !resolved.has(artifact),
      );
      if ($manifestResultValue288028.privateStagingDirectory) {
        const privateTemporaryRoot = path.join(this.storeDirectory, "temp");
        if (
          this.isWithinOrEqual(
            privateTemporaryRoot,
            $manifestResultValue288028.privateStagingDirectory,
          ) &&
          path.basename($manifestResultValue288028.privateStagingDirectory).startsWith("restore-")
        ) {
          const stagingRemoved = await attemptHost(() =>
            rm($manifestResultValue288028.privateStagingDirectory!, {
              recursive: true,
              force: true,
            }),
          );
          let $stagingRemovedResultError292457!: import("better-result").InferErr<
            NonNullable<typeof stagingRemoved>
          >;
          const $stagingRemovedResultOk292457 = Result.match<
            import("better-result").InferOk<NonNullable<typeof stagingRemoved>>,
            import("better-result").InferErr<NonNullable<typeof stagingRemoved>>,
            boolean
          >(stagingRemoved, {
            ok: () => true,
            err: (error) => {
              $stagingRemovedResultError292457 = error;
              return false;
            },
          });
          if (($stagingRemovedResultOk292457 ? "ok" : "error") === "error")
            return Result.err($stagingRemovedResultError292457);
          $manifestResultValue288028.privateStagingDirectory = undefined;
        } else {
          preserved.push($manifestResultValue288028.privateStagingDirectory);
        }
      }
      if (
        $manifestResultValue288028.artifacts.length === 0 &&
        $manifestResultValue288028.privateStagingDirectory === undefined
      ) {
        const manifestRemoved = await attemptHost(() => rm(manifestPath));
        let $manifestRemovedResultError292982!: import("better-result").InferErr<
          NonNullable<typeof manifestRemoved>
        >;
        const $manifestRemovedResultOk292982 = Result.match<
          import("better-result").InferOk<NonNullable<typeof manifestRemoved>>,
          import("better-result").InferErr<NonNullable<typeof manifestRemoved>>,
          boolean
        >(manifestRemoved, {
          ok: () => true,
          err: (error) => {
            $manifestRemovedResultError292982 = error;
            return false;
          },
        });
        if (($manifestRemovedResultOk292982 ? "ok" : "error") === "error")
          return Result.err($manifestRemovedResultError292982);
      } else {
        const written = await this.writeRestoreOwnershipManifest(
          manifestPath,
          $manifestResultValue288028,
        );
        let $writtenResultError293144!: import("better-result").InferErr<
          NonNullable<typeof written>
        >;
        const $writtenResultOk293144 = Result.match<
          import("better-result").InferOk<NonNullable<typeof written>>,
          import("better-result").InferErr<NonNullable<typeof written>>,
          boolean
        >(written, {
          ok: () => true,
          err: (error) => {
            $writtenResultError293144 = error;
            return false;
          },
        });
        if (($writtenResultOk293144 ? "ok" : "error") === "error")
          return Result.err($writtenResultError293144);
      }
    }
    const synced = await this.fsyncDirectory(this.restoreOwnershipDirectory);
    let $syncedResultError293306!: import("better-result").InferErr<NonNullable<typeof synced>>;
    const $syncedResultOk293306 = Result.match<
      import("better-result").InferOk<NonNullable<typeof synced>>,
      import("better-result").InferErr<NonNullable<typeof synced>>,
      boolean
    >(synced, {
      ok: () => true,
      err: (error) => {
        $syncedResultError293306 = error;
        return false;
      },
    });
    if (($syncedResultOk293306 ? "ok" : "error") === "error")
      return Result.err($syncedResultError293306);
    return Result.ok({ removed, preserved });
  }

  private async validatedOwnedRestoreArtifactPaths(): Promise<WorkspaceHistoryResult<Set<string>>> {
    const owned = new Set<string>();
    const directoryStats = await lstatIfExists(this.restoreOwnershipDirectory);
    let $directoryStatsResultValue293623!: import("better-result").InferOk<
      NonNullable<typeof directoryStats>
    >;
    let $directoryStatsResultError293623!: import("better-result").InferErr<
      NonNullable<typeof directoryStats>
    >;
    const $directoryStatsResultOk293623 = Result.match<
      import("better-result").InferOk<NonNullable<typeof directoryStats>>,
      import("better-result").InferErr<NonNullable<typeof directoryStats>>,
      boolean
    >(directoryStats, {
      ok: (value) => {
        $directoryStatsResultValue293623 = value;
        return true;
      },
      err: (error) => {
        $directoryStatsResultError293623 = error;
        return false;
      },
    });
    if (($directoryStatsResultOk293623 ? "ok" : "error") === "error")
      return Result.err($directoryStatsResultError293623);
    if (!$directoryStatsResultValue293623) return Result.ok(owned);
    if (
      !$directoryStatsResultValue293623.isDirectory() ||
      $directoryStatsResultValue293623.isSymbolicLink()
    ) {
      return failOwned({
        code: "ownership-mismatch",
        operation: "classify restore staging",
        message: "Restore ownership manifest path is not a real directory",
      });
    }
    const entries = await attemptHost(() =>
      readdir(this.restoreOwnershipDirectory, { withFileTypes: true }),
    );
    let $entriesResultValue294113!: import("better-result").InferOk<NonNullable<typeof entries>>;
    let $entriesResultError294113!: import("better-result").InferErr<NonNullable<typeof entries>>;
    const $entriesResultOk294113 = Result.match<
      import("better-result").InferOk<NonNullable<typeof entries>>,
      import("better-result").InferErr<NonNullable<typeof entries>>,
      boolean
    >(entries, {
      ok: (value) => {
        $entriesResultValue294113 = value;
        return true;
      },
      err: (error) => {
        $entriesResultError294113 = error;
        return false;
      },
    });
    if (($entriesResultOk294113 ? "ok" : "error") === "error")
      return Result.err($entriesResultError294113);
    for (const entry of $entriesResultValue294113) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const manifestPath = path.join(this.restoreOwnershipDirectory, entry.name);
      const manifest = await this.readRestoreOwnershipManifest(
        manifestPath,
        "classify restore staging",
      );
      let $manifestResultValue294483!: import("better-result").InferOk<
        NonNullable<typeof manifest>
      >;
      let $manifestResultError294483!: import("better-result").InferErr<
        NonNullable<typeof manifest>
      >;
      const $manifestResultOk294483 = Result.match<
        import("better-result").InferOk<NonNullable<typeof manifest>>,
        import("better-result").InferErr<NonNullable<typeof manifest>>,
        boolean
      >(manifest, {
        ok: (value) => {
          $manifestResultValue294483 = value;
          return true;
        },
        err: (error) => {
          $manifestResultError294483 = error;
          return false;
        },
      });
      if (($manifestResultOk294483 ? "ok" : "error") === "error")
        return Result.err($manifestResultError294483);
      for (const artifact of $manifestResultValue294483.artifacts) {
        if (
          artifact.dev === undefined ||
          artifact.ino === undefined ||
          !this.isWithinOrEqual(this.cwd, artifact.path)
        ) {
          continue;
        }
        const stats = await lstatIfExists(artifact.path, true);
        let $statsResultValue294921!: import("better-result").InferOk<NonNullable<typeof stats>>;
        let $statsResultError294921!: import("better-result").InferErr<NonNullable<typeof stats>>;
        const $statsResultOk294921 = Result.match<
          import("better-result").InferOk<NonNullable<typeof stats>>,
          import("better-result").InferErr<NonNullable<typeof stats>>,
          boolean
        >(stats, {
          ok: (value) => {
            $statsResultValue294921 = value;
            return true;
          },
          err: (error) => {
            $statsResultError294921 = error;
            return false;
          },
        });
        if (($statsResultOk294921 ? "ok" : "error") === "error")
          return Result.err($statsResultError294921);
        if (
          $statsResultValue294921 &&
          $statsResultValue294921.dev === BigInt(artifact.dev) &&
          $statsResultValue294921.ino === BigInt(artifact.ino)
        ) {
          owned.add(artifact.path);
        }
      }
    }
    return Result.ok(owned);
  }

  private async intentArtifactMatches(
    artifact: RestoreArtifactRecord,
    stats: BigIntStats,
  ): Promise<WorkspaceHistoryResult<boolean>> {
    const parentStats = await lstatIfExists(path.dirname(artifact.path), true);
    let $parentStatsResultValue295430!: import("better-result").InferOk<
      NonNullable<typeof parentStats>
    >;
    let $parentStatsResultError295430!: import("better-result").InferErr<
      NonNullable<typeof parentStats>
    >;
    const $parentStatsResultOk295430 = Result.match<
      import("better-result").InferOk<NonNullable<typeof parentStats>>,
      import("better-result").InferErr<NonNullable<typeof parentStats>>,
      boolean
    >(parentStats, {
      ok: (value) => {
        $parentStatsResultValue295430 = value;
        return true;
      },
      err: (error) => {
        $parentStatsResultError295430 = error;
        return false;
      },
    });
    if (($parentStatsResultOk295430 ? "ok" : "error") === "error")
      return Result.err($parentStatsResultError295430);
    if (
      !$parentStatsResultValue295430 ||
      !$parentStatsResultValue295430.isDirectory() ||
      $parentStatsResultValue295430.isSymbolicLink() ||
      $parentStatsResultValue295430.dev !== BigInt(artifact.parentDev) ||
      $parentStatsResultValue295430.ino !== BigInt(artifact.parentIno)
    ) {
      return Result.ok(false);
    }
    if (artifact.kind === "directory") {
      return Result.ok(stats.isDirectory() && !stats.isSymbolicLink());
    }
    if (artifact.role === "hard-link-probe" || artifact.role === "capability-hard-link-probe") {
      return Result.ok(
        artifact.expectedSourceDev !== undefined &&
          artifact.expectedSourceIno !== undefined &&
          stats.dev === BigInt(artifact.expectedSourceDev) &&
          stats.ino === BigInt(artifact.expectedSourceIno),
      );
    }
    if (artifact.expectedOid === undefined || artifact.expectedMode === undefined) {
      return Result.ok(false);
    }
    let mode: number;
    let oid: WorkspaceHistoryResult<string>;
    if (stats.isSymbolicLink()) {
      mode = POSIX_SYMLINK_MODE;
      const target = await attemptHost(() => readlink(artifact.path, { encoding: "buffer" }));
      let $targetResultValue296600!: import("better-result").InferOk<NonNullable<typeof target>>;
      let $targetResultError296600!: import("better-result").InferErr<NonNullable<typeof target>>;
      const $targetResultOk296600 = Result.match<
        import("better-result").InferOk<NonNullable<typeof target>>,
        import("better-result").InferErr<NonNullable<typeof target>>,
        boolean
      >(target, {
        ok: (value) => {
          $targetResultValue296600 = value;
          return true;
        },
        err: (error) => {
          $targetResultError296600 = error;
          return false;
        },
      });
      if (($targetResultOk296600 ? "ok" : "error") === "error")
        return Result.err($targetResultError296600);
      oid = await this.hashBytes($targetResultValue296600, false);
    } else if (stats.isFile()) {
      mode = (stats.mode & 0o111n) !== 0n ? POSIX_EXECUTABLE_MODE : POSIX_FILE_MODE;
      oid = await this.hashFile(artifact.path, false);
    } else {
      return Result.ok(false);
    }
    let $oidResultValue296484!: import("better-result").InferOk<NonNullable<typeof oid>>;
    let $oidResultError296484!: import("better-result").InferErr<NonNullable<typeof oid>>;
    const $oidResultOk296484 = Result.match<
      import("better-result").InferOk<NonNullable<typeof oid>>,
      import("better-result").InferErr<NonNullable<typeof oid>>,
      boolean
    >(oid, {
      ok: (value) => {
        $oidResultValue296484 = value;
        return true;
      },
      err: (error) => {
        $oidResultError296484 = error;
        return false;
      },
    });
    if (($oidResultOk296484 ? "ok" : "error") === "error") return Result.err($oidResultError296484);
    return Result.ok(
      mode === artifact.expectedMode && $oidResultValue296484 === artifact.expectedOid,
    );
  }

  private async assertPreparedRestoreFresh(
    prepared: PreparedRestoreData,
  ): Promise<WorkspaceHistoryResult<void>> {
    const workspaceIdentity = await this.workspaceIdentity();
    let $workspaceIdentityResultValue297288!: import("better-result").InferOk<
      NonNullable<typeof workspaceIdentity>
    >;
    let $workspaceIdentityResultError297288!: import("better-result").InferErr<
      NonNullable<typeof workspaceIdentity>
    >;
    const $workspaceIdentityResultOk297288 = Result.match<
      import("better-result").InferOk<NonNullable<typeof workspaceIdentity>>,
      import("better-result").InferErr<NonNullable<typeof workspaceIdentity>>,
      boolean
    >(workspaceIdentity, {
      ok: (value) => {
        $workspaceIdentityResultValue297288 = value;
        return true;
      },
      err: (error) => {
        $workspaceIdentityResultError297288 = error;
        return false;
      },
    });
    if (($workspaceIdentityResultOk297288 ? "ok" : "error") === "error")
      return Result.err($workspaceIdentityResultError297288);
    if ($workspaceIdentityResultValue297288 !== prepared.workspaceIdentity) {
      return failWith(
        this.restoreConflict("Workspace root identity changed after restore preparation"),
      );
    }
    if (prepared.recovery) {
      const protectedSignatures = await this.captureProtectedSignatures();
      let $protectedSignaturesResultValue297648!: import("better-result").InferOk<
        NonNullable<typeof protectedSignatures>
      >;
      let $protectedSignaturesResultError297648!: import("better-result").InferErr<
        NonNullable<typeof protectedSignatures>
      >;
      const $protectedSignaturesResultOk297648 = Result.match<
        import("better-result").InferOk<NonNullable<typeof protectedSignatures>>,
        import("better-result").InferErr<NonNullable<typeof protectedSignatures>>,
        boolean
      >(protectedSignatures, {
        ok: (value) => {
          $protectedSignaturesResultValue297648 = value;
          return true;
        },
        err: (error) => {
          $protectedSignaturesResultError297648 = error;
          return false;
        },
      });
      if (($protectedSignaturesResultOk297648 ? "ok" : "error") === "error")
        return Result.err($protectedSignaturesResultError297648);
      if (!mapsEqual(prepared.protectedSignatures, $protectedSignaturesResultValue297648)) {
        return failWith(this.restoreConflict("Protected paths changed after restore preparation"));
      }
      return await this.assertFrozenRecoveryState(prepared);
    }
    const current = await this.classifyWorkspace();
    let $currentResultValue298055!: import("better-result").InferOk<NonNullable<typeof current>>;
    let $currentResultError298055!: import("better-result").InferErr<NonNullable<typeof current>>;
    const $currentResultOk298055 = Result.match<
      import("better-result").InferOk<NonNullable<typeof current>>,
      import("better-result").InferErr<NonNullable<typeof current>>,
      boolean
    >(current, {
      ok: (value) => {
        $currentResultValue298055 = value;
        return true;
      },
      err: (error) => {
        $currentResultError298055 = error;
        return false;
      },
    });
    if (($currentResultOk298055 ? "ok" : "error") === "error")
      return Result.err($currentResultError298055);
    const stripped = await this.stripPreparedArtifacts($currentResultValue298055, prepared);
    let $strippedResultError298159!: import("better-result").InferErr<NonNullable<typeof stripped>>;
    const $strippedResultOk298159 = Result.match<
      import("better-result").InferOk<NonNullable<typeof stripped>>,
      import("better-result").InferErr<NonNullable<typeof stripped>>,
      boolean
    >(stripped, {
      ok: () => true,
      err: (error) => {
        $strippedResultError298159 = error;
        return false;
      },
    });
    if (($strippedResultOk298159 ? "ok" : "error") === "error")
      return Result.err($strippedResultError298159);
    const signatures = await this.captureLiveSignatures($currentResultValue298055);
    let $signaturesResultValue298294!: import("better-result").InferOk<
      NonNullable<typeof signatures>
    >;
    let $signaturesResultError298294!: import("better-result").InferErr<
      NonNullable<typeof signatures>
    >;
    const $signaturesResultOk298294 = Result.match<
      import("better-result").InferOk<NonNullable<typeof signatures>>,
      import("better-result").InferErr<NonNullable<typeof signatures>>,
      boolean
    >(signatures, {
      ok: (value) => {
        $signaturesResultValue298294 = value;
        return true;
      },
      err: (error) => {
        $signaturesResultError298294 = error;
        return false;
      },
    });
    if (($signaturesResultOk298294 ? "ok" : "error") === "error")
      return Result.err($signaturesResultError298294);
    if (
      !mapsEqual($signaturesResultValue298294, prepared.liveSignatures) ||
      !setsEqual(
        new Set($currentResultValue298055.managed.keys()),
        new Set(prepared.current.managed.keys()),
      ) ||
      !setsEqual($currentResultValue298055.ignored, prepared.current.ignored) ||
      !setsEqual($currentResultValue298055.boundaryRoots, prepared.current.boundaryRoots)
    ) {
      return failWith(
        this.restoreConflict("Workspace changed after restore preparation; prepare again"),
      );
    }
    return await this.preflightRestore($currentResultValue298055, prepared.snapshot.entries);
  }

  private async assertFrozenRecoveryState(
    prepared: PreparedRestoreData,
  ): Promise<WorkspaceHistoryResult<void>> {
    const preserved = await this.verifyFrozenSignatures(
      prepared.preservation,
      "Ignored path changed after preparation",
    );
    let $preservedResultError299092!: import("better-result").InferErr<
      NonNullable<typeof preserved>
    >;
    const $preservedResultOk299092 = Result.match<
      import("better-result").InferOk<NonNullable<typeof preserved>>,
      import("better-result").InferErr<NonNullable<typeof preserved>>,
      boolean
    >(preserved, {
      ok: () => true,
      err: (error) => {
        $preservedResultError299092 = error;
        return false;
      },
    });
    if (($preservedResultOk299092 ? "ok" : "error") === "error")
      return Result.err($preservedResultError299092);
    const targetPaths = [...prepared.snapshot.entries.keys()];
    for (const relativePath of prepared.current.managed.keys()) {
      const absolutePath = fromPosixPath(this.cwd, relativePath);
      const stats = await lstatIfExists(absolutePath);
      let $statsResultValue299486!: import("better-result").InferOk<NonNullable<typeof stats>>;
      let $statsResultError299486!: import("better-result").InferErr<NonNullable<typeof stats>>;
      const $statsResultOk299486 = Result.match<
        import("better-result").InferOk<NonNullable<typeof stats>>,
        import("better-result").InferErr<NonNullable<typeof stats>>,
        boolean
      >(stats, {
        ok: (value) => {
          $statsResultValue299486 = value;
          return true;
        },
        err: (error) => {
          $statsResultError299486 = error;
          return false;
        },
      });
      if (($statsResultOk299486 ? "ok" : "error") === "error")
        return Result.err($statsResultError299486);
      const target = prepared.snapshot.entries.get(relativePath);
      if (target) {
        const matches = await this.liveEntryMatches(target);
        let $matchesResultValue299679!: import("better-result").InferOk<
          NonNullable<typeof matches>
        >;
        let $matchesResultError299679!: import("better-result").InferErr<
          NonNullable<typeof matches>
        >;
        const $matchesResultOk299679 = Result.match<
          import("better-result").InferOk<NonNullable<typeof matches>>,
          import("better-result").InferErr<NonNullable<typeof matches>>,
          boolean
        >(matches, {
          ok: (value) => {
            $matchesResultValue299679 = value;
            return true;
          },
          err: (error) => {
            $matchesResultError299679 = error;
            return false;
          },
        });
        if (($matchesResultOk299679 ? "ok" : "error") === "error")
          return Result.err($matchesResultError299679);
        if ($matchesResultValue299679) continue;
      }
      const expectedSignature = prepared.liveSignatures.get(relativePath);
      const live = await this.readLiveEntry(relativePath, absolutePath);
      let $liveResultValue299914!: import("better-result").InferOk<NonNullable<typeof live>>;
      let $liveResultError299914!: import("better-result").InferErr<NonNullable<typeof live>>;
      const $liveResultOk299914 = Result.match<
        import("better-result").InferOk<NonNullable<typeof live>>,
        import("better-result").InferErr<NonNullable<typeof live>>,
        boolean
      >(live, {
        ok: (value) => {
          $liveResultValue299914 = value;
          return true;
        },
        err: (error) => {
          $liveResultError299914 = error;
          return false;
        },
      });
      if (($liveResultOk299914 ? "ok" : "error") === "error")
        return Result.err($liveResultError299914);
      let signatureMatches = false;
      if ($liveResultValue299914 && expectedSignature) {
        const signature = await this.entrySignature($liveResultValue299914);
        let $signatureResultValue300118!: import("better-result").InferOk<
          NonNullable<typeof signature>
        >;
        let $signatureResultError300118!: import("better-result").InferErr<
          NonNullable<typeof signature>
        >;
        const $signatureResultOk300118 = Result.match<
          import("better-result").InferOk<NonNullable<typeof signature>>,
          import("better-result").InferErr<NonNullable<typeof signature>>,
          boolean
        >(signature, {
          ok: (value) => {
            $signatureResultValue300118 = value;
            return true;
          },
          err: (error) => {
            $signatureResultError300118 = error;
            return false;
          },
        });
        if (($signatureResultOk300118 ? "ok" : "error") === "error")
          return Result.err($signatureResultError300118);
        signatureMatches = $signatureResultValue300118 === expectedSignature;
      }
      if ($liveResultValue299914 && expectedSignature && signatureMatches) {
        continue;
      }
      if (
        $statsResultValue299486?.isDirectory() &&
        targetPaths.some((candidate) => candidate.startsWith(`${relativePath}/`))
      ) {
        continue;
      }
      const mayBeRemoved =
        !target ||
        (expectedSignature !== undefined &&
          expectedSignature !==
            `${target.mode === POSIX_SYMLINK_MODE ? "symlink" : "regular"}:${target.mode}:${target.oid}`) ||
        targetPaths.some((candidate) => candidate.startsWith(`${relativePath}/`)) ||
        pathAncestors(relativePath).some((ancestor) => prepared.snapshot.entries.has(ancestor));
      if (!$statsResultValue299486 && mayBeRemoved) continue;
      return failWith(
        this.restoreConflict(`Managed path has invalid partial restore state: ${relativePath}`),
      );
    }
    for (const [relativePath, target] of prepared.snapshot.entries) {
      const matches = await this.liveEntryMatches(target);
      let $matchesResultValue301241!: import("better-result").InferOk<NonNullable<typeof matches>>;
      let $matchesResultError301241!: import("better-result").InferErr<NonNullable<typeof matches>>;
      const $matchesResultOk301241 = Result.match<
        import("better-result").InferOk<NonNullable<typeof matches>>,
        import("better-result").InferErr<NonNullable<typeof matches>>,
        boolean
      >(matches, {
        ok: (value) => {
          $matchesResultValue301241 = value;
          return true;
        },
        err: (error) => {
          $matchesResultError301241 = error;
          return false;
        },
      });
      if (($matchesResultOk301241 ? "ok" : "error") === "error")
        return Result.err($matchesResultError301241);
      if ($matchesResultValue301241) continue;
      const stats = await lstatIfExists(fromPosixPath(this.cwd, relativePath));
      let $statsResultValue301389!: import("better-result").InferOk<NonNullable<typeof stats>>;
      let $statsResultError301389!: import("better-result").InferErr<NonNullable<typeof stats>>;
      const $statsResultOk301389 = Result.match<
        import("better-result").InferOk<NonNullable<typeof stats>>,
        import("better-result").InferErr<NonNullable<typeof stats>>,
        boolean
      >(stats, {
        ok: (value) => {
          $statsResultValue301389 = value;
          return true;
        },
        err: (error) => {
          $statsResultError301389 = error;
          return false;
        },
      });
      if (($statsResultOk301389 ? "ok" : "error") === "error")
        return Result.err($statsResultError301389);
      const sourceSignature = prepared.liveSignatures.get(relativePath);
      const live = $statsResultValue301389
        ? await this.readLiveEntry(relativePath, fromPosixPath(this.cwd, relativePath))
        : Result.ok<ScannedEntry | undefined, WorkspaceHistoryFailure>(undefined);
      let $liveResultValue301592!: import("better-result").InferOk<NonNullable<typeof live>>;
      let $liveResultError301592!: import("better-result").InferErr<NonNullable<typeof live>>;
      const $liveResultOk301592 = Result.match<
        import("better-result").InferOk<NonNullable<typeof live>>,
        import("better-result").InferErr<NonNullable<typeof live>>,
        boolean
      >(live, {
        ok: (value) => {
          $liveResultValue301592 = value;
          return true;
        },
        err: (error) => {
          $liveResultError301592 = error;
          return false;
        },
      });
      if (($liveResultOk301592 ? "ok" : "error") === "error")
        return Result.err($liveResultError301592);
      if ($liveResultValue301592 && sourceSignature) {
        const signature = await this.entrySignature($liveResultValue301592);
        let $signatureResultValue301887!: import("better-result").InferOk<
          NonNullable<typeof signature>
        >;
        let $signatureResultError301887!: import("better-result").InferErr<
          NonNullable<typeof signature>
        >;
        const $signatureResultOk301887 = Result.match<
          import("better-result").InferOk<NonNullable<typeof signature>>,
          import("better-result").InferErr<NonNullable<typeof signature>>,
          boolean
        >(signature, {
          ok: (value) => {
            $signatureResultValue301887 = value;
            return true;
          },
          err: (error) => {
            $signatureResultError301887 = error;
            return false;
          },
        });
        if (($signatureResultOk301887 ? "ok" : "error") === "error")
          return Result.err($signatureResultError301887);
        if ($signatureResultValue301887 === sourceSignature) continue;
      }
      if (
        $statsResultValue301389?.isDirectory() &&
        [...prepared.current.managed.keys()].some((candidate) =>
          candidate.startsWith(`${relativePath}/`),
        )
      ) {
        continue;
      }
      if (!$statsResultValue301389) continue;
      return failWith(
        this.restoreConflict(`Target path has invalid partial restore state: ${relativePath}`),
      );
    }
    return Result.ok(undefined);
  }

  private async verifyFrozenSignatures(
    expected: ReadonlyMap<string, string>,
    message: string,
  ): Promise<WorkspaceHistoryResult<void>> {
    for (const [relativePath, signature] of expected) {
      const entry = await this.readLiveEntry(relativePath, fromPosixPath(this.cwd, relativePath));
      let $entryResultValue302700!: import("better-result").InferOk<NonNullable<typeof entry>>;
      let $entryResultError302700!: import("better-result").InferErr<NonNullable<typeof entry>>;
      const $entryResultOk302700 = Result.match<
        import("better-result").InferOk<NonNullable<typeof entry>>,
        import("better-result").InferErr<NonNullable<typeof entry>>,
        boolean
      >(entry, {
        ok: (value) => {
          $entryResultValue302700 = value;
          return true;
        },
        err: (error) => {
          $entryResultError302700 = error;
          return false;
        },
      });
      if (($entryResultOk302700 ? "ok" : "error") === "error")
        return Result.err($entryResultError302700);
      if (!$entryResultValue302700)
        return failWith(this.restoreConflict(`${message}: ${relativePath}`));
      const actual = await this.entrySignature($entryResultValue302700);
      let $actualResultValue302943!: import("better-result").InferOk<NonNullable<typeof actual>>;
      let $actualResultError302943!: import("better-result").InferErr<NonNullable<typeof actual>>;
      const $actualResultOk302943 = Result.match<
        import("better-result").InferOk<NonNullable<typeof actual>>,
        import("better-result").InferErr<NonNullable<typeof actual>>,
        boolean
      >(actual, {
        ok: (value) => {
          $actualResultValue302943 = value;
          return true;
        },
        err: (error) => {
          $actualResultError302943 = error;
          return false;
        },
      });
      if (($actualResultOk302943 ? "ok" : "error") === "error")
        return Result.err($actualResultError302943);
      if ($actualResultValue302943 !== signature) {
        return failWith(this.restoreConflict(`${message}: ${relativePath}`));
      }
    }
    return Result.ok(undefined);
  }

  private async stripPreparedArtifacts(
    current: ClassifiedWorkspace,
    prepared: PreparedRestoreData,
  ): Promise<WorkspaceHistoryResult<void>> {
    for (const temporary of prepared.ownedTemps.values()) {
      const owned = await this.assertOwnedTemporary(temporary);
      let $ownedResultError303440!: import("better-result").InferErr<NonNullable<typeof owned>>;
      const $ownedResultOk303440 = Result.match<
        import("better-result").InferOk<NonNullable<typeof owned>>,
        import("better-result").InferErr<NonNullable<typeof owned>>,
        boolean
      >(owned, {
        ok: () => true,
        err: (error) => {
          $ownedResultError303440 = error;
          return false;
        },
      });
      if (($ownedResultOk303440 ? "ok" : "error") === "error")
        return Result.err($ownedResultError303440);
    }
    const ownedTempPaths = new Set(prepared.ownedTemps.keys());
    const replacementPaths = [...prepared.replacementRoots.values()]
      .filter((root) => !root.published)
      .map((root) => root.temporaryPath);
    const isArtifact = (relativePath: string): boolean => {
      const absolutePath = fromPosixPath(this.cwd, relativePath);
      return (
        ownedTempPaths.has(absolutePath) ||
        replacementPaths.some((rootPath) => this.isWithinOrEqual(rootPath, absolutePath))
      );
    };
    for (const relativePath of current.entries.keys()) {
      if (!isArtifact(relativePath)) continue;
      const absolutePath = fromPosixPath(this.cwd, relativePath);
      if (!ownedTempPaths.has(absolutePath)) {
        return failWith(
          this.restoreConflict("Unknown content appeared inside destination staging"),
        );
      }
      current.entries.delete(relativePath);
      current.managed.delete(relativePath);
      current.ignored.delete(relativePath);
    }
    for (const relativePath of current.directories) {
      if (!isArtifact(relativePath)) continue;
      const absolutePath = fromPosixPath(this.cwd, relativePath);
      if (!prepared.ownedDirectories.has(absolutePath)) {
        return failWith(
          this.restoreConflict("Unknown directory appeared inside destination staging"),
        );
      }
      current.directories.delete(relativePath);
      current.ignored.delete(relativePath);
      current.ignoredDirectories.delete(relativePath);
      current.boundaryRoots.delete(relativePath);
    }
    return Result.ok(undefined);
  }

  private entrySignature(entry: ScannedEntry): Promise<WorkspaceHistoryResult<string>> {
    if (entry.kind === "special") {
      return Promise.resolve(
        Result.ok(
          `special:${entry.mode}:${entry.size}:${entry.mtimeNs}:${entry.ctimeNs}:${entry.dev}:${entry.ino}`,
        ),
      );
    }
    return Result.gen(async function* (this: WorkspaceHistoryStore) {
      let oid: string;
      if (entry.kind === "symlink") {
        const target = yield* Result.await(
          attemptHost(() => readlink(entry.absolutePath, { encoding: "buffer" })),
        );
        oid = yield* Result.await(this.hashBytes(target, false));
      } else {
        oid = yield* Result.await(this.hashFile(entry.absolutePath, false));
      }
      return Result.ok(`${entry.kind}:${entry.mode}:${oid}`);
    }, this);
  }

  private async assertLiveSignature(
    relativePath: string,
    expected: string | undefined,
  ): Promise<WorkspaceHistoryResult<void>> {
    const absolutePath = fromPosixPath(this.cwd, relativePath);
    const entry = await this.readLiveEntry(relativePath, absolutePath);
    let $entryResultValue306181!: import("better-result").InferOk<NonNullable<typeof entry>>;
    let $entryResultError306181!: import("better-result").InferErr<NonNullable<typeof entry>>;
    const $entryResultOk306181 = Result.match<
      import("better-result").InferOk<NonNullable<typeof entry>>,
      import("better-result").InferErr<NonNullable<typeof entry>>,
      boolean
    >(entry, {
      ok: (value) => {
        $entryResultValue306181 = value;
        return true;
      },
      err: (error) => {
        $entryResultError306181 = error;
        return false;
      },
    });
    if (($entryResultOk306181 ? "ok" : "error") === "error")
      return Result.err($entryResultError306181);
    if (!$entryResultValue306181 || expected === undefined) {
      return failWith(
        this.restoreConflict(`Managed path changed before mutation: ${relativePath}`),
      );
    }
    const signature = await this.entrySignature($entryResultValue306181);
    let $signatureResultValue306476!: import("better-result").InferOk<
      NonNullable<typeof signature>
    >;
    let $signatureResultError306476!: import("better-result").InferErr<
      NonNullable<typeof signature>
    >;
    const $signatureResultOk306476 = Result.match<
      import("better-result").InferOk<NonNullable<typeof signature>>,
      import("better-result").InferErr<NonNullable<typeof signature>>,
      boolean
    >(signature, {
      ok: (value) => {
        $signatureResultValue306476 = value;
        return true;
      },
      err: (error) => {
        $signatureResultError306476 = error;
        return false;
      },
    });
    if (($signatureResultOk306476 ? "ok" : "error") === "error")
      return Result.err($signatureResultError306476);
    if ($signatureResultValue306476 !== expected) {
      return failWith(
        this.restoreConflict(`Managed path changed before mutation: ${relativePath}`),
      );
    }
    return Result.ok(undefined);
  }

  private async beforeLiveMutation(relativePath: string): Promise<WorkspaceHistoryResult<void>> {
    return await attemptHost(async () => await this.beforeMutation?.(relativePath));
  }

  private async assertSafeMutationAncestors(
    relativePath: string,
    expectedWorkspaceIdentity: string,
  ): Promise<WorkspaceHistoryResult<void>> {
    // Node exposes no openat-style directory handles. Rechecking immediately before each operation
    // narrows traversal races but cannot eliminate a same-user swap between this check and the syscall.
    const workspaceIdentity = await this.workspaceIdentity();
    let $workspaceIdentityResultValue307345!: import("better-result").InferOk<
      NonNullable<typeof workspaceIdentity>
    >;
    let $workspaceIdentityResultError307345!: import("better-result").InferErr<
      NonNullable<typeof workspaceIdentity>
    >;
    const $workspaceIdentityResultOk307345 = Result.match<
      import("better-result").InferOk<NonNullable<typeof workspaceIdentity>>,
      import("better-result").InferErr<NonNullable<typeof workspaceIdentity>>,
      boolean
    >(workspaceIdentity, {
      ok: (value) => {
        $workspaceIdentityResultValue307345 = value;
        return true;
      },
      err: (error) => {
        $workspaceIdentityResultError307345 = error;
        return false;
      },
    });
    if (($workspaceIdentityResultOk307345 ? "ok" : "error") === "error")
      return Result.err($workspaceIdentityResultError307345);
    if ($workspaceIdentityResultValue307345 !== expectedWorkspaceIdentity) {
      return failWith(this.restoreConflict("Workspace root changed before mutation"));
    }
    for (const ancestor of pathAncestors(relativePath)) {
      const stats = await lstatIfExists(fromPosixPath(this.cwd, ancestor));
      let $statsResultValue307697!: import("better-result").InferOk<NonNullable<typeof stats>>;
      let $statsResultError307697!: import("better-result").InferErr<NonNullable<typeof stats>>;
      const $statsResultOk307697 = Result.match<
        import("better-result").InferOk<NonNullable<typeof stats>>,
        import("better-result").InferErr<NonNullable<typeof stats>>,
        boolean
      >(stats, {
        ok: (value) => {
          $statsResultValue307697 = value;
          return true;
        },
        err: (error) => {
          $statsResultError307697 = error;
          return false;
        },
      });
      if (($statsResultOk307697 ? "ok" : "error") === "error")
        return Result.err($statsResultError307697);
      if (!$statsResultValue307697) {
        return failWith(
          this.restoreConflict(`Required mutation ancestor disappeared: ${ancestor}`),
        );
      }
      if (!$statsResultValue307697.isDirectory() || $statsResultValue307697.isSymbolicLink()) {
        return failWith(this.restoreConflict(`Refusing to traverse changed ancestor ${ancestor}`));
      }
    }
    return Result.ok(undefined);
  }

  private async verifyProtectedSignatures(
    expected: ReadonlyMap<string, string>,
  ): Promise<WorkspaceHistoryResult<void>> {
    const actual = await this.captureProtectedSignatures();
    let $actualResultValue308333!: import("better-result").InferOk<NonNullable<typeof actual>>;
    let $actualResultError308333!: import("better-result").InferErr<NonNullable<typeof actual>>;
    const $actualResultOk308333 = Result.match<
      import("better-result").InferOk<NonNullable<typeof actual>>,
      import("better-result").InferErr<NonNullable<typeof actual>>,
      boolean
    >(actual, {
      ok: (value) => {
        $actualResultValue308333 = value;
        return true;
      },
      err: (error) => {
        $actualResultError308333 = error;
        return false;
      },
    });
    if (($actualResultOk308333 ? "ok" : "error") === "error")
      return Result.err($actualResultError308333);
    if (!mapsEqual(expected, $actualResultValue308333)) {
      return failWith(this.verificationError("Protected paths changed during restore"));
    }
    return Result.ok(undefined);
  }

  private verificationError(message: string): WorkspaceHistoryStoreError {
    return new WorkspaceHistoryStoreError({
      code: "filesystem-error",
      operation: "verify restored workspace",
      message,
    });
  }

  private restoreConflict(message: string): WorkspaceHistoryStoreError {
    return new WorkspaceHistoryStoreError({
      code: "restore-conflict",
      operation: "preflight workspace restore",
      message,
    });
  }

  private isProtectedAbsolutePath(absolutePath: string): boolean {
    return this.protectedPaths.some((protectedPath) =>
      this.isWithinOrEqual(protectedPath, absolutePath),
    );
  }

  private overlapsProtectedPath(absolutePath: string): boolean {
    return this.protectedPaths.some(
      (protectedPath) =>
        this.isWithinOrEqual(protectedPath, absolutePath) ||
        this.isWithinOrEqual(absolutePath, protectedPath),
    );
  }

  private comparisonPath(value: string): string {
    return this.pathComparison === "case-insensitive" ? value.toLowerCase() : value;
  }

  private isWithinOrEqual(parent: string, candidate: string): boolean {
    return isWithinOrEqual(this.comparisonPath(parent), this.comparisonPath(candidate));
  }

  private isGitMetadataName(name: string): boolean {
    return this.comparisonPath(name) === ".git";
  }

  private isRestoreTempName(name: string): boolean {
    return RESTORE_TEMP_PATTERN.test(this.comparisonPath(name));
  }

  private snapshotRef(rootTreeOid: string): string {
    return `refs/mini-lilac/snapshots/${rootTreeOid}`;
  }

  private snapshotRefCreationPath(rootTreeOid: string): string {
    return path.join(this.snapshotRefCreationDirectory, `${rootTreeOid}.json`);
  }

  private async readSnapshotRefCreationMetadata(
    rootTreeOid: string,
    gitRef: string,
  ): Promise<WorkspaceHistoryResult<WorkspaceHistorySnapshotRefCreated | undefined>> {
    if (gitRef !== this.snapshotRef(rootTreeOid)) return Result.ok(undefined);
    const directoryStats = await lstatIfExists(this.snapshotRefCreationDirectory);
    let $directoryStatsResultValue310581!: import("better-result").InferOk<
      NonNullable<typeof directoryStats>
    >;
    let $directoryStatsResultError310581!: import("better-result").InferErr<
      NonNullable<typeof directoryStats>
    >;
    const $directoryStatsResultOk310581 = Result.match<
      import("better-result").InferOk<NonNullable<typeof directoryStats>>,
      import("better-result").InferErr<NonNullable<typeof directoryStats>>,
      boolean
    >(directoryStats, {
      ok: (value) => {
        $directoryStatsResultValue310581 = value;
        return true;
      },
      err: (error) => {
        $directoryStatsResultError310581 = error;
        return false;
      },
    });
    if (($directoryStatsResultOk310581 ? "ok" : "error") === "error")
      return Result.err($directoryStatsResultError310581);
    if (!$directoryStatsResultValue310581) return Result.ok(undefined);
    if (
      !$directoryStatsResultValue310581.isDirectory() ||
      $directoryStatsResultValue310581.isSymbolicLink()
    ) {
      return failOwned({
        code: "ownership-mismatch",
        operation: "read snapshot-ref metadata",
        message: "Snapshot-ref metadata path is not an owned directory",
      });
    }
    const metadataPath = this.snapshotRefCreationPath(rootTreeOid);
    const stats = await lstatIfExists(metadataPath);
    let $statsResultValue311145!: import("better-result").InferOk<NonNullable<typeof stats>>;
    let $statsResultError311145!: import("better-result").InferErr<NonNullable<typeof stats>>;
    const $statsResultOk311145 = Result.match<
      import("better-result").InferOk<NonNullable<typeof stats>>,
      import("better-result").InferErr<NonNullable<typeof stats>>,
      boolean
    >(stats, {
      ok: (value) => {
        $statsResultValue311145 = value;
        return true;
      },
      err: (error) => {
        $statsResultError311145 = error;
        return false;
      },
    });
    if (($statsResultOk311145 ? "ok" : "error") === "error")
      return Result.err($statsResultError311145);
    if (!$statsResultValue311145) return Result.ok(undefined);
    if (!$statsResultValue311145.isFile() || $statsResultValue311145.isSymbolicLink()) {
      return failOwned({
        code: "ownership-mismatch",
        operation: "read snapshot-ref metadata",
        message: "Snapshot-ref metadata is not a regular file",
      });
    }
    const serialized = await attemptHost(() => readFile(metadataPath, "utf8"));
    let $serializedResultValue311552!: import("better-result").InferOk<
      NonNullable<typeof serialized>
    >;
    let $serializedResultError311552!: import("better-result").InferErr<
      NonNullable<typeof serialized>
    >;
    const $serializedResultOk311552 = Result.match<
      import("better-result").InferOk<NonNullable<typeof serialized>>,
      import("better-result").InferErr<NonNullable<typeof serialized>>,
      boolean
    >(serialized, {
      ok: (value) => {
        $serializedResultValue311552 = value;
        return true;
      },
      err: (error) => {
        $serializedResultError311552 = error;
        return false;
      },
    });
    if (($serializedResultOk311552 ? "ok" : "error") === "error")
      return Result.err($serializedResultError311552);
    const decoded = this.decodeSnapshotRefCreationMetadata(
      $serializedResultValue311552,
      rootTreeOid,
      gitRef,
    );
    let $decodedResultValue311690!: import("better-result").InferOk<NonNullable<typeof decoded>>;
    let $decodedResultError311690!: import("better-result").InferErr<NonNullable<typeof decoded>>;
    const $decodedResultOk311690 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decoded>>,
      import("better-result").InferErr<NonNullable<typeof decoded>>,
      boolean
    >(decoded, {
      ok: (value) => {
        $decodedResultValue311690 = value;
        return true;
      },
      err: (error) => {
        $decodedResultError311690 = error;
        return false;
      },
    });
    if (($decodedResultOk311690 ? "ok" : "error") === "error")
      return failWith($decodedResultError311690);
    return Result.ok($decodedResultValue311690);
  }

  private async validateSnapshotGraphs(
    rootTreeOids: readonly string[],
  ): Promise<WorkspaceHistoryResult<Map<string, SnapshotGraphValidation>>> {
    const results = new Map<string, SnapshotGraphValidation>();
    const rootTypes = await this.objectTypesUnlocked(rootTreeOids);
    let $rootTypesResultValue312117!: import("better-result").InferOk<
      NonNullable<typeof rootTypes>
    >;
    let $rootTypesResultError312117!: import("better-result").InferErr<
      NonNullable<typeof rootTypes>
    >;
    const $rootTypesResultOk312117 = Result.match<
      import("better-result").InferOk<NonNullable<typeof rootTypes>>,
      import("better-result").InferErr<NonNullable<typeof rootTypes>>,
      boolean
    >(rootTypes, {
      ok: (value) => {
        $rootTypesResultValue312117 = value;
        return true;
      },
      err: (error) => {
        $rootTypesResultError312117 = error;
        return false;
      },
    });
    if (($rootTypesResultOk312117 ? "ok" : "error") === "error")
      return Result.err($rootTypesResultError312117);
    const enumerated = new Map<string, EnumeratedSnapshotGraph>();
    const descendantOids = new Set<string>();

    for (const rootTreeOid of rootTreeOids) {
      const rootType = $rootTypesResultValue312117.get(rootTreeOid);
      if (!rootType) {
        results.set(rootTreeOid, { status: "missing" });
        continue;
      }
      if (rootType !== "tree") {
        results.set(rootTreeOid, { status: "corrupt" });
        continue;
      }
      const graph = await this.enumerateSnapshotGraph(rootTreeOid);
      let $graphResultValue312682!: import("better-result").InferOk<NonNullable<typeof graph>>;
      let $graphResultError312682!: import("better-result").InferErr<NonNullable<typeof graph>>;
      const $graphResultOk312682 = Result.match<
        import("better-result").InferOk<NonNullable<typeof graph>>,
        import("better-result").InferErr<NonNullable<typeof graph>>,
        boolean
      >(graph, {
        ok: (value) => {
          $graphResultValue312682 = value;
          return true;
        },
        err: (error) => {
          $graphResultError312682 = error;
          return false;
        },
      });
      if (($graphResultOk312682 ? "ok" : "error") === "error")
        return Result.err($graphResultError312682);
      enumerated.set(rootTreeOid, $graphResultValue312682);
      for (const entry of $graphResultValue312682.entries) descendantOids.add(entry.oid);
    }

    const descendantTypes = await this.objectTypesUnlocked(descendantOids);
    let $descendantTypesResultValue312931!: import("better-result").InferOk<
      NonNullable<typeof descendantTypes>
    >;
    let $descendantTypesResultError312931!: import("better-result").InferErr<
      NonNullable<typeof descendantTypes>
    >;
    const $descendantTypesResultOk312931 = Result.match<
      import("better-result").InferOk<NonNullable<typeof descendantTypes>>,
      import("better-result").InferErr<NonNullable<typeof descendantTypes>>,
      boolean
    >(descendantTypes, {
      ok: (value) => {
        $descendantTypesResultValue312931 = value;
        return true;
      },
      err: (error) => {
        $descendantTypesResultError312931 = error;
        return false;
      },
    });
    if (($descendantTypesResultOk312931 ? "ok" : "error") === "error")
      return Result.err($descendantTypesResultError312931);
    for (const [rootTreeOid, graph] of enumerated) {
      let corrupt = graph.corrupt;
      let missing = false;
      const missingTreeOids = new Set<string>();
      for (const entry of graph.entries) {
        const actualType = $descendantTypesResultValue312931.get(entry.oid);
        if (!actualType) {
          missing = true;
          if (entry.expectedType === "tree") missingTreeOids.add(entry.oid);
        } else if (actualType !== entry.expectedType) {
          corrupt = true;
        }
      }
      if (graph.result.exitCode !== 0) {
        const diagnostics = graph.result.stderr.trim().split("\n");
        const onlyMissingTreeDiagnostics =
          missingTreeOids.size > 0 &&
          diagnostics.length > 0 &&
          diagnostics.every((line) => {
            const match = /^error: Could not read ([0-9a-f]+)$/.exec(line);
            return Boolean(match?.[1] && missingTreeOids.has(match[1]));
          });
        if (!onlyMissingTreeDiagnostics) {
          return failOwned({
            code: "git-command-failed",
            operation: "validate snapshot graph",
            message: `Git failed while validating snapshot graph (exit ${graph.result.exitCode})`,
            detail: graph.result.stderr.trim().slice(0, 4_000),
            exitCode: graph.result.exitCode,
          });
        }
      }
      if (corrupt) {
        results.set(rootTreeOid, { status: "corrupt" });
        continue;
      }
      if (missing) {
        results.set(rootTreeOid, { status: "missing" });
        continue;
      }
      const snapshot = await this.readSnapshot(rootTreeOid, true);
      let $snapshotResultValue314618!: import("better-result").InferOk<
        NonNullable<typeof snapshot>
      >;
      let $snapshotResultError314618!: import("better-result").InferErr<
        NonNullable<typeof snapshot>
      >;
      const $snapshotResultOk314618 = Result.match<
        import("better-result").InferOk<NonNullable<typeof snapshot>>,
        import("better-result").InferErr<NonNullable<typeof snapshot>>,
        boolean
      >(snapshot, {
        ok: (value) => {
          $snapshotResultValue314618 = value;
          return true;
        },
        err: (error) => {
          $snapshotResultError314618 = error;
          return false;
        },
      });
      if (($snapshotResultOk314618 ? "ok" : "error") === "error") {
        if (
          $snapshotResultError314618.kind === "owned" &&
          $snapshotResultError314618.error.code === "snapshot-invalid"
        ) {
          results.set(rootTreeOid, { status: "corrupt" });
          continue;
        }
        return Result.err($snapshotResultError314618);
      }
      const validated = this.validateTargetPathSet($snapshotResultValue314618.entries);
      let $validatedResultError314947!: import("better-result").InferErr<
        NonNullable<typeof validated>
      >;
      const $validatedResultOk314947 = Result.match<
        import("better-result").InferOk<NonNullable<typeof validated>>,
        import("better-result").InferErr<NonNullable<typeof validated>>,
        boolean
      >(validated, {
        ok: () => true,
        err: (error) => {
          $validatedResultError314947 = error;
          return false;
        },
      });
      if (($validatedResultOk314947 ? "ok" : "error") === "error") {
        if (
          $validatedResultError314947.kind === "owned" &&
          $validatedResultError314947.error.code === "snapshot-invalid"
        ) {
          results.set(rootTreeOid, { status: "corrupt" });
          continue;
        }
        return Result.err($validatedResultError314947);
      }
      results.set(rootTreeOid, { status: "valid" });
    }
    return Result.ok(results);
  }

  private async enumerateSnapshotGraph(
    rootTreeOid: string,
  ): Promise<WorkspaceHistoryResult<EnumeratedSnapshotGraph>> {
    const result = await this.runPrivateGit(["ls-tree", "-r", "-t", "-z", rootTreeOid], {
      operation: "validate snapshot graph",
      acceptedExitCodes: [0, 1],
    });
    let $resultResultValue315511!: import("better-result").InferOk<NonNullable<typeof result>>;
    let $resultResultError315511!: import("better-result").InferErr<NonNullable<typeof result>>;
    const $resultResultOk315511 = Result.match<
      import("better-result").InferOk<NonNullable<typeof result>>,
      import("better-result").InferErr<NonNullable<typeof result>>,
      boolean
    >(result, {
      ok: (value) => {
        $resultResultValue315511 = value;
        return true;
      },
      err: (error) => {
        $resultResultError315511 = error;
        return false;
      },
    });
    if (($resultResultOk315511 ? "ok" : "error") === "error")
      return Result.err($resultResultError315511);
    const entries: EnumeratedSnapshotGraph["entries"] = [];
    let corrupt = false;
    const records = splitNul($resultResultValue315511.stdout, "validate snapshot graph");
    let $recordsResultValue315821!: import("better-result").InferOk<NonNullable<typeof records>>;
    let $recordsResultError315821!: import("better-result").InferErr<NonNullable<typeof records>>;
    const $recordsResultOk315821 = Result.match<
      import("better-result").InferOk<NonNullable<typeof records>>,
      import("better-result").InferErr<NonNullable<typeof records>>,
      boolean
    >(records, {
      ok: (value) => {
        $recordsResultValue315821 = value;
        return true;
      },
      err: (error) => {
        $recordsResultError315821 = error;
        return false;
      },
    });
    if (($recordsResultOk315821 ? "ok" : "error") === "error")
      return Result.err($recordsResultError315821);
    for (const record of $recordsResultValue315821) {
      const match = /^(\d+) (blob|tree|commit|tag) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
      if (!match?.[1] || !match[2] || !match[3] || !OID_PATTERN.test(match[3])) {
        return failOwned({
          code: "malformed-git-output",
          operation: "validate snapshot graph",
          message: "Git returned malformed tree output during snapshot reconciliation",
          detail: record.slice(0, 200),
        });
      }
      const mode = Number.parseInt(match[1], 8);
      let expectedType: "blob" | "tree" | undefined;
      if (mode === 0o040000) {
        expectedType = "tree";
      } else if (
        mode === POSIX_FILE_MODE ||
        mode === POSIX_EXECUTABLE_MODE ||
        mode === POSIX_SYMLINK_MODE
      ) {
        expectedType = "blob";
      }
      if (!expectedType) {
        corrupt = true;
        continue;
      }
      if (match[2] !== expectedType) corrupt = true;
      entries.push({ oid: match[3], expectedType });
    }
    return Result.ok({ entries, result: $resultResultValue315511, corrupt });
  }

  private async objectTypeUnlocked(
    oid: string,
  ): Promise<WorkspaceHistoryResult<"blob" | "tree" | "commit" | "tag" | undefined>> {
    const types = await this.objectTypesUnlocked([oid]);
    let $typesResultValue317173!: import("better-result").InferOk<NonNullable<typeof types>>;
    let $typesResultError317173!: import("better-result").InferErr<NonNullable<typeof types>>;
    const $typesResultOk317173 = Result.match<
      import("better-result").InferOk<NonNullable<typeof types>>,
      import("better-result").InferErr<NonNullable<typeof types>>,
      boolean
    >(types, {
      ok: (value) => {
        $typesResultValue317173 = value;
        return true;
      },
      err: (error) => {
        $typesResultError317173 = error;
        return false;
      },
    });
    if (($typesResultOk317173 ? "ok" : "error") === "error")
      return Result.err($typesResultError317173);
    return Result.ok($typesResultValue317173.get(oid));
  }

  private async objectTypesUnlocked(
    oids: Iterable<string>,
  ): Promise<WorkspaceHistoryResult<Map<string, "blob" | "tree" | "commit" | "tag" | undefined>>> {
    const uniqueOids = [...new Set(oids)];
    const types = new Map<string, "blob" | "tree" | "commit" | "tag" | undefined>();
    if (uniqueOids.length === 0) return Result.ok(types);
    const result = await this.runPrivateGit(
      ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
      {
        operation: "check private object",
        input: new TextEncoder().encode(`${uniqueOids.join("\n")}\n`),
      },
    );
    let $resultResultValue317678!: import("better-result").InferOk<NonNullable<typeof result>>;
    let $resultResultError317678!: import("better-result").InferErr<NonNullable<typeof result>>;
    const $resultResultOk317678 = Result.match<
      import("better-result").InferOk<NonNullable<typeof result>>,
      import("better-result").InferErr<NonNullable<typeof result>>,
      boolean
    >(result, {
      ok: (value) => {
        $resultResultValue317678 = value;
        return true;
      },
      err: (error) => {
        $resultResultError317678 = error;
        return false;
      },
    });
    if (($resultResultOk317678 ? "ok" : "error") === "error")
      return Result.err($resultResultError317678);
    const output = bytesToText($resultResultValue317678.stdout, "check private object");
    let $outputResultValue317976!: import("better-result").InferOk<NonNullable<typeof output>>;
    let $outputResultError317976!: import("better-result").InferErr<NonNullable<typeof output>>;
    const $outputResultOk317976 = Result.match<
      import("better-result").InferOk<NonNullable<typeof output>>,
      import("better-result").InferErr<NonNullable<typeof output>>,
      boolean
    >(output, {
      ok: (value) => {
        $outputResultValue317976 = value;
        return true;
      },
      err: (error) => {
        $outputResultError317976 = error;
        return false;
      },
    });
    if (($outputResultOk317976 ? "ok" : "error") === "error")
      return Result.err($outputResultError317976);
    if (!$outputResultValue317976.endsWith("\n")) {
      return failOwned({
        code: "malformed-git-output",
        operation: "check private object",
        message: "Git returned non-terminated object-existence output",
        detail: $outputResultValue317976.slice(0, 200),
      });
    }
    const lines = $outputResultValue317976.slice(0, -1).split("\n");
    if (lines.length !== uniqueOids.length) {
      return failOwned({
        code: "malformed-git-output",
        operation: "check private object",
        message: "Git returned the wrong number of object-existence records",
      });
    }
    for (const [index, oid] of uniqueOids.entries()) {
      const line = lines[index];
      if (line === `${oid} missing`) {
        types.set(oid, undefined);
        continue;
      }
      const match = /^([0-9a-f]+) (blob|tree|commit|tag)$/.exec(line ?? "");
      if (!match?.[1] || !match[2] || match[1] !== oid) {
        return failOwned({
          code: "malformed-git-output",
          operation: "check private object",
          message: "Git returned malformed object-existence output",
          detail: (line ?? "").slice(0, 200),
        });
      }
      const objectType = match[2];
      if (
        objectType !== "blob" &&
        objectType !== "tree" &&
        objectType !== "commit" &&
        objectType !== "tag"
      ) {
        return failOwned({
          code: "malformed-git-output",
          operation: "check private object",
          message: "Git returned an unsupported object type",
        });
      }
      types.set(oid, objectType);
    }
    return Result.ok(types);
  }

  private privateConfigArgs(): string[] {
    return [
      "-c",
      `core.hooksPath=${this.emptyHooksPath}`,
      "-c",
      "maintenance.auto=false",
      "-c",
      "gc.autoDetach=false",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.ignoreStat=false",
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.safecrlf=false",
      "-c",
      `core.attributesFile=${this.emptyAttributesPath}`,
      "-c",
      `core.excludesFile=${this.emptyExcludesPath}`,
      "-c",
      "diff.external=",
      "-c",
      "credential.helper=",
    ];
  }

  private sourceConfigArgs(includeExcludes = true): string[] {
    const args = [
      "-c",
      "maintenance.auto=false",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.ignoreStat=false",
      "-c",
      "diff.external=",
      "-c",
      "credential.helper=",
    ];
    if (includeExcludes && this.sourceExcludesFile) {
      args.push("-c", `core.excludesFile=${this.sourceExcludesFile}`);
    }
    return args;
  }

  private async runSourceGit(
    cwd: string,
    args: readonly string[],
    options: {
      operation: string;
      acceptedExitCodes?: readonly number[];
      input?: GitInput;
      includeExcludes?: boolean;
      env?: Readonly<Record<string, string | undefined>>;
    },
  ): Promise<WorkspaceHistoryResult<GitResult>> {
    const validated = await this.validateSourceGitDirectory(cwd, options.operation);
    let $validatedResultError321076!: import("better-result").InferErr<
      NonNullable<typeof validated>
    >;
    const $validatedResultOk321076 = Result.match<
      import("better-result").InferOk<NonNullable<typeof validated>>,
      import("better-result").InferErr<NonNullable<typeof validated>>,
      boolean
    >(validated, {
      ok: () => true,
      err: (error) => {
        $validatedResultError321076 = error;
        return false;
      },
    });
    if (($validatedResultOk321076 ? "ok" : "error") === "error")
      return Result.err($validatedResultError321076);
    return await this.runGit(
      ["-C", cwd, ...this.sourceConfigArgs(options.includeExcludes ?? true), ...args],
      options,
    );
  }

  private async validateSourceGitDirectory(
    directory: string,
    operation: string,
  ): Promise<WorkspaceHistoryResult<void>> {
    let stats: Stats;
    try {
      stats = await lstat(directory);
    } catch (cause) {
      if (Panic.is(cause)) return Result.err({ kind: "panic", cause });
      if (!(cause instanceof Error)) return await Promise.reject(cause);
      return failOwned({
        code: "workspace-invalid",
        operation,
        message: `Cannot access source Git directory: ${directory}`,
        cause,
      });
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return failOwned({
        code: "workspace-invalid",
        operation,
        message: `Source Git path is not a directory: ${directory}`,
      });
    }
    return Result.ok(undefined);
  }

  private async runGit(
    args: readonly string[],
    options: {
      operation: string;
      acceptedExitCodes?: readonly number[];
      input?: GitInput;
      env?: Readonly<Record<string, string | undefined>>;
    },
  ): Promise<WorkspaceHistoryResult<GitResult>> {
    const accepted = options.acceptedExitCodes ?? [0];
    let processHandle: Bun.Subprocess<"ignore" | GitInput, "pipe", "pipe">;
    try {
      processHandle = Bun.spawn([this.gitExecutable, ...args], {
        cwd: path.parse(this.cwd).root,
        env: this.gitEnvironment(options.env),
        stdin: options.input ?? "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (cause) {
      if (Panic.is(cause)) return Result.err({ kind: "panic", cause });
      if (!(cause instanceof Error)) return await Promise.reject(cause);
      if (nodeErrorCode(cause) === "ENOENT") {
        return Result.err({ kind: "git-unavailable", signal: new GitUnavailableSignal() });
      }
      return failOwned({
        code: "git-command-failed",
        operation: options.operation,
        message: `Unable to spawn Git while ${options.operation}: ${opaqueErrorMessage(cause, "Git spawn failed")}`,
        cause,
      });
    }
    const completed = await attemptHost(() =>
      Promise.all([
        new Response(processHandle.stdout).arrayBuffer(),
        new Response(processHandle.stderr).text(),
        processHandle.exited,
      ]),
    );
    let $completedResultValue323403!: import("better-result").InferOk<
      NonNullable<typeof completed>
    >;
    let $completedResultError323403!: import("better-result").InferErr<
      NonNullable<typeof completed>
    >;
    const $completedResultOk323403 = Result.match<
      import("better-result").InferOk<NonNullable<typeof completed>>,
      import("better-result").InferErr<NonNullable<typeof completed>>,
      boolean
    >(completed, {
      ok: (value) => {
        $completedResultValue323403 = value;
        return true;
      },
      err: (error) => {
        $completedResultError323403 = error;
        return false;
      },
    });
    if (($completedResultOk323403 ? "ok" : "error") === "error")
      return Result.err($completedResultError323403);
    const [stdoutBuffer, stderr, exitCode] = $completedResultValue323403;
    if (!accepted.includes(exitCode)) {
      return failOwned({
        code: "git-command-failed",
        operation: options.operation,
        message: `Git failed while ${options.operation} (exit ${exitCode})`,
        detail: stderr.trim().slice(0, 4_000),
        exitCode,
      });
    }
    return Result.ok({ stdout: new Uint8Array(stdoutBuffer), stderr, exitCode });
  }

  private async runPrivateGitToHandle(
    args: readonly string[],
    destinationFd: number,
    options: { operation: string },
  ): Promise<WorkspaceHistoryResult<void>> {
    const owned = await this.verifyOwnershipMarker();
    let $ownedResultError324303!: import("better-result").InferErr<NonNullable<typeof owned>>;
    const $ownedResultOk324303 = Result.match<
      import("better-result").InferOk<NonNullable<typeof owned>>,
      import("better-result").InferErr<NonNullable<typeof owned>>,
      boolean
    >(owned, {
      ok: () => true,
      err: (error) => {
        $ownedResultError324303 = error;
        return false;
      },
    });
    if (($ownedResultOk324303 ? "ok" : "error") === "error")
      return Result.err($ownedResultError324303);
    let processHandle: Bun.Subprocess<"ignore", number, "pipe">;
    try {
      processHandle = Bun.spawn(
        [
          this.gitExecutable,
          `--git-dir=${this.storeDirectory}`,
          `--work-tree=${this.cwd}`,
          ...this.privateConfigArgs(),
          ...args,
        ],
        {
          cwd: path.parse(this.cwd).root,
          env: this.gitEnvironment(),
          stdin: "ignore",
          stdout: destinationFd,
          stderr: "pipe",
        },
      );
    } catch (cause) {
      if (Panic.is(cause)) return Result.err({ kind: "panic", cause });
      if (!(cause instanceof Error)) return await Promise.reject(cause);
      if (isMissingExecutable(cause)) {
        return Result.err({ kind: "git-unavailable", signal: new GitUnavailableSignal() });
      }
      return failOwned({
        code: "git-command-failed",
        operation: options.operation,
        message: `Unable to spawn Git while ${options.operation}: ${opaqueErrorMessage(cause, "Git spawn failed")}`,
        cause,
      });
    }
    const completed = await attemptHost(() =>
      Promise.all([new Response(processHandle.stderr).text(), processHandle.exited]),
    );
    let $completedResultValue325455!: import("better-result").InferOk<
      NonNullable<typeof completed>
    >;
    let $completedResultError325455!: import("better-result").InferErr<
      NonNullable<typeof completed>
    >;
    const $completedResultOk325455 = Result.match<
      import("better-result").InferOk<NonNullable<typeof completed>>,
      import("better-result").InferErr<NonNullable<typeof completed>>,
      boolean
    >(completed, {
      ok: (value) => {
        $completedResultValue325455 = value;
        return true;
      },
      err: (error) => {
        $completedResultError325455 = error;
        return false;
      },
    });
    if (($completedResultOk325455 ? "ok" : "error") === "error")
      return Result.err($completedResultError325455);
    const [stderr, exitCode] = $completedResultValue325455;
    if (exitCode !== 0) {
      return failOwned({
        code: "git-command-failed",
        operation: options.operation,
        message: `Git failed while ${options.operation} (exit ${exitCode})`,
        detail: stderr.trim().slice(0, 4_000),
        exitCode,
      });
    }
    return Result.ok(undefined);
  }

  private gitEnvironment(
    extra?: Readonly<Record<string, string | undefined>>,
  ): Record<string, string | undefined> {
    const environment: Record<string, string | undefined> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? this.historyRoot,
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(this.storeDirectory, "empty-config"),
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_EXTERNAL_DIFF: "",
      GIT_NO_REPLACE_OBJECTS: "1",
      NO_COLOR: "1",
    };
    if (process.env.TMPDIR) environment.TMPDIR = process.env.TMPDIR;
    if (extra) Object.assign(environment, extra);
    return environment;
  }

  private emitCaptureMetric(
    startedAt: number,
    observation: CaptureMetricObservation,
    outcome: Extract<WorkspaceHistoryMetric, { type: "capture" }>["outcome"],
  ): void {
    this.emitMetric({
      type: "capture",
      workspaceId: this.workspaceId,
      outcome,
      changed: observation.changed,
      durationMs: performance.now() - startedAt,
      candidatePathCount: observation.candidatePathCount,
      managedPathCount: observation.managedPathCount,
      payloadBytes: observation.payloadBytes,
    });
  }

  private emitRestoreMetric(
    startedAt: number,
    candidatePathCount: number,
    managedPathCount: number,
    payloadBytes: bigint,
    changed: boolean,
    outcome: Extract<WorkspaceHistoryMetric, { type: "restore" }>["outcome"],
  ): void {
    this.emitMetric({
      type: "restore",
      workspaceId: this.workspaceId,
      outcome,
      changed,
      durationMs: performance.now() - startedAt,
      candidatePathCount,
      managedPathCount,
      payloadBytes,
    });
  }

  private emitVerifyMetric(
    startedAt: number,
    managedPathCount: number,
    payloadBytes: bigint,
    outcome: Extract<WorkspaceHistoryMetric, { type: "verify" }>["outcome"],
  ): void {
    this.emitMetric({
      type: "verify",
      workspaceId: this.workspaceId,
      outcome,
      durationMs: performance.now() - startedAt,
      candidatePathCount: managedPathCount,
      managedPathCount,
      payloadBytes,
    });
  }

  private emitMaintenanceMetric(
    startedAt: number,
    result: WorkspaceHistoryMaintenanceResult,
  ): void {
    let outcome: Extract<WorkspaceHistoryMetric, { type: "maintenance" }>["outcome"];
    if (result.status === "unavailable") {
      outcome = "skipped";
    } else if (result.status === "missing") {
      outcome = "missing";
    } else if (result.storeDisposition === "removed") {
      outcome = "removed";
    } else {
      outcome = "maintained";
    }
    this.emitMetric({
      type: "maintenance",
      workspaceId: this.workspaceId,
      outcome,
      durationMs: performance.now() - startedAt,
      candidatePathCount: 0,
      managedPathCount: result.status === "unavailable" ? 0 : result.expected.length,
      payloadBytes: 0n,
      removedOrphanRefCount: result.status === "unavailable" ? 0 : result.removedOrphanRefs.length,
      preservedOrphanRefCount:
        result.status === "unavailable" ? 0 : result.preservedOrphanRefs.length,
    });
  }

  private emitVerificationFailure(
    startedAt: number,
    operation: "restore" | "verify",
    managedPathCount: number,
    error: WorkspaceHistoryStoreError,
  ): void {
    if (error.operation !== "verify restored workspace") {
      return;
    }
    this.emitMetric({
      type: "verification-failure",
      workspaceId: this.workspaceId,
      operation,
      errorCode: error.code,
      durationMs: performance.now() - startedAt,
      candidatePathCount: managedPathCount,
      managedPathCount,
      payloadBytes: 0n,
    });
  }

  private emitMetric(metric: WorkspaceHistoryMetric): void {
    if (!this.onMetric) return;
    const waitForActiveOperation = operationQueues.get(this.storeDirectory) ?? Promise.resolve();
    heldStoreLocks.run(new Map(), () => {
      this.metricQueue = this.metricQueue
        .then(async () => {
          await waitForActiveOperation;
          await new Promise<void>((resolve) => queueMicrotask(resolve));
          await this.onMetric?.(metric);
        })
        .catch(() => {
          // Metrics are observational and must never affect workspace operations.
        });
    });
  }

  private decodeOwnership(
    serialized: string,
  ): ResultType<WorkspaceHistoryOwnership, WorkspaceHistoryStoreError> {
    const decoded = decodeWorkspaceHistoryOwnership({
      serialized,
      expected: this.expectedMarker(),
    });
    let $decodedResultValue330543!: import("better-result").InferOk<NonNullable<typeof decoded>>;
    let $decodedResultError330543!: import("better-result").InferErr<NonNullable<typeof decoded>>;
    const $decodedResultOk330543 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decoded>>,
      import("better-result").InferErr<NonNullable<typeof decoded>>,
      boolean
    >(decoded, {
      ok: (value) => {
        $decodedResultValue330543 = value;
        return true;
      },
      err: (error) => {
        $decodedResultError330543 = error;
        return false;
      },
    });
    if (($decodedResultOk330543 ? "ok" : "error") === "error") {
      return Result.err(
        this.persistenceStoreError(
          $decodedResultError330543,
          "ownership-mismatch",
          "verify store ownership",
        ),
      );
    }
    return Result.ok($decodedResultValue330543.value);
  }

  private decodeSnapshotManifest(
    serialized: string,
  ): ResultType<WorkspaceHistorySnapshotManifest, WorkspaceHistoryStoreError> {
    const decoded = decodeWorkspaceHistorySnapshotManifest({ serialized });
    let $decodedResultValue331025!: import("better-result").InferOk<NonNullable<typeof decoded>>;
    let $decodedResultError331025!: import("better-result").InferErr<NonNullable<typeof decoded>>;
    const $decodedResultOk331025 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decoded>>,
      import("better-result").InferErr<NonNullable<typeof decoded>>,
      boolean
    >(decoded, {
      ok: (value) => {
        $decodedResultValue331025 = value;
        return true;
      },
      err: (error) => {
        $decodedResultError331025 = error;
        return false;
      },
    });
    if (($decodedResultOk331025 ? "ok" : "error") === "error") {
      return Result.err(
        this.persistenceStoreError(
          $decodedResultError331025,
          "snapshot-invalid",
          "read snapshot manifest",
        ),
      );
    }
    return Result.ok($decodedResultValue331025.value);
  }

  private decodeRestorePlan(
    serialized: string,
    operationId: string,
    platform: "linux" | "darwin",
  ): ResultType<WorkspaceHistoryRestorePlan, WorkspaceHistoryStoreError> {
    const decoded = decodeWorkspaceHistoryRestorePlan({
      serialized,
      operationId,
      workspaceId: this.workspaceId,
      canonicalCwd: this.cwd,
      pathComparison: this.pathComparison,
      platform,
    });
    let $decodedResultValue331511!: import("better-result").InferOk<NonNullable<typeof decoded>>;
    let $decodedResultError331511!: import("better-result").InferErr<NonNullable<typeof decoded>>;
    const $decodedResultOk331511 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decoded>>,
      import("better-result").InferErr<NonNullable<typeof decoded>>,
      boolean
    >(decoded, {
      ok: (value) => {
        $decodedResultValue331511 = value;
        return true;
      },
      err: (error) => {
        $decodedResultError331511 = error;
        return false;
      },
    });
    if (($decodedResultOk331511 ? "ok" : "error") === "error") {
      return Result.err(
        this.persistenceStoreError(
          $decodedResultError331511,
          "snapshot-invalid",
          "read durable restore plan",
        ),
      );
    }
    return Result.ok($decodedResultValue331511.value);
  }

  private decodeSnapshotRefCreationMetadata(
    serialized: string,
    rootTreeOid: string,
    gitRef: string,
  ): ResultType<WorkspaceHistorySnapshotRefCreated | undefined, WorkspaceHistoryStoreError> {
    const decoded = decodeWorkspaceHistorySnapshotRefCreated({ serialized, rootTreeOid, gitRef });
    let $decodedResultValue332172!: import("better-result").InferOk<NonNullable<typeof decoded>>;
    let $decodedResultError332172!: import("better-result").InferErr<NonNullable<typeof decoded>>;
    const $decodedResultOk332172 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decoded>>,
      import("better-result").InferErr<NonNullable<typeof decoded>>,
      boolean
    >(decoded, {
      ok: (value) => {
        $decodedResultValue332172 = value;
        return true;
      },
      err: (error) => {
        $decodedResultError332172 = error;
        return false;
      },
    });
    if (($decodedResultOk332172 ? "ok" : "error") === "error") {
      return Result.err(
        this.persistenceStoreError(
          $decodedResultError332172,
          "snapshot-invalid",
          "read snapshot-ref metadata",
        ),
      );
    }
    return Result.ok($decodedResultValue332172.value);
  }

  private decodeRestoreOwnership(
    serialized: string,
    operation: string,
  ): ResultType<WorkspaceHistoryRestoreOwnership, WorkspaceHistoryStoreError> {
    const decoded = decodeWorkspaceHistoryRestoreOwnership({
      serialized,
      workspaceId: this.workspaceId,
      canonicalCwd: this.cwd,
    });
    let $decodedResultValue332659!: import("better-result").InferOk<NonNullable<typeof decoded>>;
    let $decodedResultError332659!: import("better-result").InferErr<NonNullable<typeof decoded>>;
    const $decodedResultOk332659 = Result.match<
      import("better-result").InferOk<NonNullable<typeof decoded>>,
      import("better-result").InferErr<NonNullable<typeof decoded>>,
      boolean
    >(decoded, {
      ok: (value) => {
        $decodedResultValue332659 = value;
        return true;
      },
      err: (error) => {
        $decodedResultError332659 = error;
        return false;
      },
    });
    if (($decodedResultOk332659 ? "ok" : "error") === "error") {
      return Result.err(
        this.persistenceStoreError($decodedResultError332659, "ownership-mismatch", operation),
      );
    }
    return Result.ok($decodedResultValue332659.value);
  }

  private persistenceStoreError(
    error: WorkspaceHistoryPersistenceCodecError,
    code: WorkspaceHistoryErrorCode,
    operation: string,
  ): WorkspaceHistoryStoreError {
    return new WorkspaceHistoryStoreError({
      code,
      operation,
      message: `Workspace history ${error.recordKind} is invalid: ${error.issueCode}`,
    });
  }

  private withContext(error: Error, operation: string): WorkspaceHistoryStoreError {
    return new WorkspaceHistoryStoreError({
      code: "filesystem-error",
      operation,
      message: `Filesystem operation failed while ${operation}: ${opaqueErrorMessage(error, "Filesystem operation failed")}`,
      cause: error,
    });
  }
}

export const workspaceHistorySnapshotFormatVersion = FORMAT_VERSION;
