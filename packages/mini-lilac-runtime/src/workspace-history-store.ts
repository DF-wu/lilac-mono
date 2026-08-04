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
  if (called.status === "error") return called;
  if (called.value === 0) return Result.ok(undefined);
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
    if (result.status === "error") {
      if (result.error.kind === "panic") return { status: "panic", cause: result.error.cause };
      return { status: "failed", failure: result.error };
    }
    return { status: "ok", value: result.value };
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
  if (decoded.status === "ok") return decoded;
  return failOwned({
    code: "malformed-git-output",
    operation,
    message: `Git returned non-UTF-8 output while ${operation}`,
    cause: failureCause(decoded.error),
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
  if (text.status === "error") return text;
  if (!text.value.endsWith("\n")) {
    return failOwned({
      code: "malformed-git-output",
      operation,
      message: "Git returned non-terminated object accounting output",
    });
  }
  const values = new Map<string, string>();
  for (const line of text.value.slice(0, -1).split("\n")) {
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
  if (text.status === "error") return text;
  const oid = text.value.trim();
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
  if (text.status === "error") return text;
  const values = text.value.split("\0");
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
  if (stats.status === "ok") return stats;
  if (hostErrorCode(stats.error) === "ENOENT") return Result.ok(undefined);
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
  if (validated.status === "error") return Result.err(validated.error);
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
    if (validated.status === "error") throw validated.error;

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
    if (version.status === "error") {
      if (version.error.kind !== "git-unavailable") return Result.err(version.error);
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
      gitVersion: version.value,
      pathComparison: this.pathComparison,
    });
  }

  async capability(): Promise<WorkspaceHistoryCapability> {
    const capability = await this.capabilityInternal();
    if (capability.status === "error") throwFailure(capability.error);
    return capability.value;
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
        if (lease.status === "error") return await Promise.reject(failureCause(lease.error));
        const captured = await this.captureLocked();
        if (captured.status === "error") {
          if (captured.error.kind === "panic") {
            return await Promise.reject(captured.error.cause);
          }
          return Result.err(labelFailure(captured.error, "capture workspace"));
        }
        lastCapture = captured.value;
        return Result.ok(captured.value);
      };
      const lockedStore: LockedWorkspaceHistoryStore = {
        captureResult,
        invalidateCaptureCacheResult: async () => {
          const lease = leaseState();
          if (lease.status === "error") return await Promise.reject(failureCause(lease.error));
          const invalidated = await this.invalidateCaptureCache();
          if (invalidated.status === "error") {
            if (invalidated.error.kind === "panic") {
              return await Promise.reject(invalidated.error.cause);
            }
            return Result.err(labelStoreError(invalidated.error, "invalidate capture cache"));
          }
          return Result.ok(undefined);
        },
        capture: async () => {
          const captured = await captureResult();
          if (captured.status === "error") return await Promise.reject(captured.error);
          return captured.value;
        },
        prepareRestore: async (rootTreeOid, expectedCurrent, operationId) => {
          const lease = leaseState();
          if (lease.status === "error") return await Promise.reject(failureCause(lease.error));
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
          if (prepared.status === "error") {
            return await Promise.reject(failureCause(prepared.error));
          }
          return prepared.value;
        },
        resumePreparedRestore: async (input) => {
          const lease = leaseState();
          if (lease.status === "error") return await Promise.reject(failureCause(lease.error));
          const prepared = await this.resumePreparedRestoreLocked(input, leaseState, preparedPlans);
          if (prepared.status === "error") {
            return await Promise.reject(failureCause(prepared.error));
          }
          return prepared.value;
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
    if (locked.status === "error") return Result.err(locked.error);
    return locked.value;
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
      if (attempted.status === "ok") {
        if (attempted.value.status === "skipped") {
          this.emitCaptureMetric(startedAt, observation, "skipped");
        } else {
          this.emitCaptureMetric(startedAt, observation, "captured");
        }
        return Result.ok(attempted.value);
      }
      if (attempted.error.kind === "git-unavailable") {
        this.emitCaptureMetric(startedAt, observation, "skipped");
        return Result.ok<WorkspaceHistoryCaptureResult>({
          status: "skipped",
          reason: "git-unavailable",
        });
      }
      this.emitCaptureMetric(startedAt, observation, "failed");
      if (attempted.error.kind === "panic") return Result.err(attempted.error);
      if (attempted.error.kind === "persistence") return Result.err(attempted.error);
      return failWith(labelStoreError(attempted.error, "capture workspace"));
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
    if (result.status === "ok") return Result.ok(result.value);
    if (result.error.kind === "panic") return await Promise.reject(result.error.cause);
    return Result.err(labelStoreError(result.error, operation));
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
    if (deleted.status === "error") throwFailure(deleted.error);
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
    if (cleaned.status === "error") throwFailure(cleaned.error);
    return cleaned.value;
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
      if (attempted.status === "ok") return Result.ok(attempted.value);
      if (attempted.error.kind === "panic") return attempted;
      this.emitVerifyMetric(startedAt, counters.managedPathCount, 0n, "failed");
      const failure = labelStoreError(attempted.error, "verify workspace snapshot");
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
    if (verified.status === "error") throwFailure(verified.error);
    return verified.value;
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
      if (attempted.status === "ok") return Result.ok(attempted.value);
      if (attempted.error.kind === "git-unavailable") {
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
      if (attempted.error.kind === "panic") return attempted;
      this.emitRestoreMetric(
        metricStartedAt,
        counters.candidatePathCount,
        counters.managedPathCount,
        counters.materializedBytes,
        false,
        "failed",
      );
      const failure = labelStoreError(attempted.error, "prepare workspace restore");
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
    verify: () => Promise<WorkspaceHistoryResult<unknown>>,
  ): PreparedWorkspaceRestore {
    const requireActive = (): void => {
      const lease = leaseState();
      if (lease.status === "error") throwFailure(lease.error);
    };
    return {
      rootTreeOid,
      operationId,
      apply: async () => {
        requireActive();
        const applied = await this.applyPreparedRestore(data);
        if (applied.status === "error") throwFailure(applied.error);
        preparedPlans.delete(data);
        return applied.value;
      },
      verify: async () => {
        requireActive();
        const verified = await verify();
        if (verified.status === "error") throwFailure(verified.error);
        return { status: "verified" };
      },
      dispose: async () => {
        requireActive();
        preparedPlans.delete(data);
        const disposed = await this.disposePreparedRestore(data);
        if (disposed.status === "error") throwFailure(disposed.error);
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
      if (attempted.status === "ok") return Result.ok(attempted.value);
      if (attempted.error.kind === "git-unavailable") {
        this.emitRestoreMetric(metricStartedAt, 0, 0, counters.materializedBytes, false, "skipped");
        return Result.ok<WorkspaceHistoryPrepareRestoreResult>({
          status: "skipped",
          reason: "git-unavailable",
        });
      }
      if (attempted.error.kind === "panic") return attempted;
      this.emitRestoreMetric(metricStartedAt, 0, 0, counters.materializedBytes, false, "failed");
      const failure = labelStoreError(attempted.error, "resume prepared workspace restore");
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
      if (existence.status === "error" && existence.error.kind === "git-unavailable") {
        return failOwned({
          code: "git-unavailable",
          operation: "check private object",
          message: "Git became unavailable while checking private object",
          cause: existence.error.signal,
        });
      }
      return existence;
    }, this);
  }

  async objectExists(oid: string, type: "blob" | "tree" | "object" = "object"): Promise<boolean> {
    const exists = await this.objectExistsInternal(oid, type);
    if (exists.status === "error") throwFailure(exists.error);
    return exists.value;
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
    if (reconciled.status === "error") throwFailure(reconciled.error);
    return reconciled.value;
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
      if (reconciled.status === "error" && reconciled.error.kind === "git-unavailable") {
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
    if (reconciled.status === "error") throwFailure(reconciled.error);
    return reconciled.value;
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
      if (cleaned.status === "error" && cleaned.error.kind === "git-unavailable") {
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
    if (cleaned.status === "error") throwFailure(cleaned.error);
    return cleaned.value;
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
      if (accounted.status === "error" && accounted.error.kind === "git-unavailable") {
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
    if (accounted.status === "error") throwFailure(accounted.error);
    return accounted.value;
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
      if (maintained.status === "ok") return Result.ok(maintained.value);
      if (maintained.error.kind === "git-unavailable") {
        const unavailable = {
          status: "unavailable" as const,
          reason: "git-unavailable" as const,
        };
        this.emitMaintenanceMetric(startedAt, unavailable);
        return Result.ok<WorkspaceHistoryMaintenanceResult>(unavailable);
      }
      if (maintained.error.kind === "panic") return maintained;
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
      return failWith(labelStoreError(maintained.error, "maintain private Git store"));
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
    if (maintained.status === "error") throwFailure(maintained.error);
    return maintained.value;
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
    if (cleaned.status === "error") throwFailure(cleaned.error);
    return cleaned.value;
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
      if (workspaceStats.status === "error") {
        return failOwned({
          code: "workspace-invalid",
          operation: "validate workspace",
          message: `Cannot access workspace: ${opaqueErrorMessage(failureCause(workspaceStats.error), "Workspace access failed")}`,
          cause: failureCause(workspaceStats.error),
        });
      }
      if (!workspaceStats.value.isDirectory()) {
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
    let serialized: string | null;
    if (read.status === "ok") {
      serialized = read.value;
    } else if (hostErrorCode(read.error) === "ENOENT") {
      serialized = null;
    } else {
      return read;
    }
    const decoded = decodeWorkspaceHistoryCaptureCache({
      serialized,
      workspaceId: this.workspaceId,
      canonicalCwd: this.cwd,
      pathComparison: this.pathComparison,
    });
    if (decoded.status === "ok") return Result.ok(decoded.value);
    return Result.err({ kind: "persistence", error: decoded.error });
  }

  private async invalidateCaptureCache(): Promise<WorkspaceHistoryResult<void>> {
    const removed = await attemptHost(() => rm(this.captureCachePath, { force: true }));
    if (removed.status === "error") {
      return Result.err(labelWorkspaceFailure(removed.error, "invalidate capture cache"));
    }
    const synced = await this.fsyncDirectory(this.storeDirectory);
    if (synced.status === "error") {
      return Result.err(labelWorkspaceFailure(synced.error, "invalidate capture cache"));
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
        if (directoryCreated.status === "error") return directoryCreated;
        operationDirectoryOwned = true;
        const permissionsSet = await attemptHost(() => chmod(operationDirectory, 0o700));
        if (permissionsSet.status === "error") return permissionsSet;

        const apiOpened = attemptHostSync(openPosixFileApi);
        if (apiOpened.status === "error") return apiOpened;
        fileApi = apiOpened.value;
        const targetDirectoryOpened = await attemptHost(() =>
          open(
            targetDirectory,
            fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
          ),
        );
        if (targetDirectoryOpened.status === "error") return targetDirectoryOpened;
        targetDirectoryHandle = targetDirectoryOpened.value;
        const operationDirectoryOpened = await attemptHost(() =>
          open(
            operationDirectory,
            fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
          ),
        );
        if (operationDirectoryOpened.status === "error") return operationDirectoryOpened;
        operationDirectoryHandle = operationDirectoryOpened.value;
        const directoryStats = await attemptHost(() =>
          operationDirectoryOpened.value.stat({ bigint: true }),
        );
        if (directoryStats.status === "error") return directoryStats;
        const currentUid = process.getuid?.();
        if (
          !directoryStats.value.isDirectory() ||
          (directoryStats.value.mode & 0o777n) !== 0o700n ||
          (currentUid !== undefined && directoryStats.value.uid !== BigInt(currentUid))
        ) {
          return failOwned({
            code: "ownership-mismatch",
            operation,
            message: "Atomic-write operation directory is not exclusively owned",
          });
        }
        operationDirectoryIdentity = {
          path: operationDirectory,
          dev: directoryStats.value.dev,
          ino: directoryStats.value.ino,
        };
        const sourceOpened = await attemptHost(() =>
          open(
            sourcePath,
            fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
            0o600,
          ),
        );
        if (sourceOpened.status === "error") return sourceOpened;
        sourceHandle = sourceOpened.value;
        sourceEntryOwned = true;
        const beforeStat = await attemptHost(
          async () => await this.beforePrivateFileStat?.(operation, sourcePath),
        );
        if (beforeStat.status === "error") return beforeStat;
        const stats = await attemptHost(() => sourceOpened.value.stat({ bigint: true }));
        if (stats.status === "error") return stats;
        sourceIdentity = { path: sourcePath, dev: stats.value.dev, ino: stats.value.ino };
        const written = await attemptHost(async () => {
          await sourceOpened.value.writeFile(contents);
          await sourceOpened.value.sync();
        });
        if (written.status === "error") return written;
        const beforeClose = await attemptHost(
          async () => await this.beforePrivateFileClose?.(operation, sourcePath),
        );
        if (beforeClose.status === "error") return beforeClose;
        const sourceOwned = await this.assertTemporaryIdentity(sourceIdentity, operation);
        if (sourceOwned.status === "error") return sourceOwned;
        const directoryOwned = await this.assertTemporaryIdentity(
          operationDirectoryIdentity,
          operation,
        );
        if (directoryOwned.status === "error") return directoryOwned;
        const beforePublish = await attemptHost(
          async () => await this.beforePrivateFilePublish?.(operation, sourcePath, targetPath),
        );
        if (beforePublish.status === "error") return beforePublish;

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
          if (linked.status === "error") {
            const currentStats = await attemptHost(() => sourceHandle!.stat({ bigint: true }));
            if (currentStats.status === "error") return currentStats;
            if (
              currentStats.value.dev === sourceIdentity.dev &&
              currentStats.value.ino === sourceIdentity.ino &&
              currentStats.value.nlink !== 1n
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
          if (linkedStats.status === "error") return linkedStats;
          if (
            linkedStats.value.dev !== sourceIdentity.dev ||
            linkedStats.value.ino !== sourceIdentity.ino ||
            linkedStats.value.nlink !== 2n
          ) {
            sourceEntryOwned = false;
            return failOwned({
              code: "ownership-mismatch",
              operation,
              message: "Atomic-write source was replaced after final validation",
            });
          }
          const sourceNameOwned = await this.assertTemporaryIdentity(sourceIdentity, operation);
          if (sourceNameOwned.status === "error") {
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
          if (renamed.status === "error") return renamed;
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
          if (renamed.status === "error") return renamed;
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
        if (afterPublish.status === "error") return afterPublish;
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
          if (captured.status === "error") return captured;
          sourceIdentity = {
            path: sourcePath,
            dev: captured.value.dev,
            ino: captured.value.ino,
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
          if (removed.status === "ok") publishEntryOwned = false;
          return removed;
        },
        async () => {
          if (!sourceEntryOwned || !sourceIdentity || !fileApi || !operationDirectoryHandle) {
            return Result.ok(undefined);
          }
          const owned = await this.assertTemporaryIdentity(sourceIdentity, operation);
          if (owned.status === "error") {
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
          if (removed.status === "ok") sourceEntryOwned = false;
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
          if (owned.status === "error") operationDirectoryOwned = false;
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
          if (hooked.status === "error") return hooked;
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
          if (removed.status === "ok") operationDirectoryOwned = false;
          if (removed.status === "ok") return removed;
          if (removed.error.kind === "panic") return removed;
          return failOwned({
            code: "ownership-mismatch",
            operation,
            message: "Atomic-write operation directory contains an unowned replacement",
            cause: failureCause(removed.error),
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
    if (current.status === "error") return current;
    if (
      !current.value ||
      current.value.dev !== identity.dev ||
      current.value.ino !== identity.ino
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
    if (opened.status === "error") return opened;
    const operation = "hash regular file";
    const primary = await superviseOutcome<string>(async () => {
      const hashed = await this.runPrivateGit(args, {
        operation,
        input: opened.value.fd,
      });
      if (hashed.status === "error") return hashed;
      return parseOid(hashed.value.stdout, operation);
    });
    const cleanup = await runWorkspaceHistoryCleanup(operation, [
      async () => await attemptHost(async () => await opened.value.close()),
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
          if (result.status === "ok") {
            const records = yield* splitNul(result.value.stdout, "validate retained capture index");
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
            const failure = result.error;
            const error = failure.kind === "owned" ? failure.error : undefined;
            const isCorruptIndex =
              error?.code === "git-command-failed" &&
              /(?:index file corrupt|index file smaller|bad index)/i.test(
                `${error.message}\n${error.detail ?? ""}`,
              );
            if (!isCorruptIndex) return result;
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
        if (existing.status === "error") return existing;
        if (existing.value) return Result.ok(existing.value);
      }
      const hooked = await attemptHost(
        async () => await this.beforeSnapshotRefMetadataWrite?.(rootTreeOid),
      );
      if (hooked.status === "error") return hooked;
      const created = await attemptHost(() =>
        mkdir(this.snapshotRefCreationDirectory, { recursive: true, mode: 0o700 }),
      );
      if (created.status === "error") return created;
      const safe = await this.assertNoSymlinkComponents(this.snapshotRefCreationDirectory, false);
      if (safe.status === "error") return safe;
      const storeSynced = await this.fsyncDirectory(this.storeDirectory);
      if (storeSynced.status === "error") return storeSynced;
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
      if (written.status === "error") return written;
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
      if (owned.status === "error") return owned;
      const primary = await superviseOutcome<GitResult>(async () => {
        const before = await attemptHost(async () => await this.beforePrivateGit?.(args));
        if (before.status === "error") return before;
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
      if (decoded.status === "error") return failWith(decoded.error);
      const manifest = decoded.value;
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
    if (opened.status === "error") return opened;
    const primary = await superviseOutcome(async () => {
      const synced = await attemptHost(async () => await opened.value.sync());
      if (synced.status === "error") return synced;
      return Result.ok(undefined);
    });
    const cleanup = await runWorkspaceHistoryCleanup(operation, [
      async () => await attemptHost(async () => await opened.value.close()),
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
      if (manifest.status === "error") return failWith(manifest.error);
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
        if (current.status === "error") return current;
        const extraManagedPath = [...current.value.managed.keys()].find(
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
        if (before.status === "error") return before;
        if (!before.value) {
          return failWith(this.verificationError(`Target path is missing: ${relativePath}`));
        }
        let oid: WorkspaceHistoryResult<string>;
        if (before.value.kind === "symlink") {
          const target = await attemptHost(() => readlink(absolutePath, { encoding: "buffer" }));
          if (target.status === "error") return target;
          oid = await this.hashBytes(target.value, false);
        } else if (before.value.kind === "regular") {
          oid = await this.hashFile(absolutePath, false);
        } else {
          return failWith(
            this.verificationError(`Target path has the wrong type: ${relativePath}`),
          );
        }
        if (oid.status === "error") return oid;
        const after = await this.readLiveEntry(relativePath, absolutePath);
        if (after.status === "error") return after;
        if (!after.value || !sameScannedFingerprint(before.value, after.value)) {
          return failWith(
            this.verificationError(`Target path changed during verification: ${relativePath}`),
          );
        }
        if (after.value.mode !== expected.mode || oid.value !== expected.oid) {
          return failWith(
            this.verificationError(`Target path does not match snapshot: ${relativePath}`),
          );
        }
        verifiedEntries.push({ relativePath, mode: after.value.mode, oid: oid.value });
        verifiedTargetEntries.set(relativePath, after.value);
      }

      const verifyIndex = path.join(this.storeDirectory, "verify.index");
      const primary = await superviseOutcome<Map<string, ScannedEntry>>(async () => {
        const workspaceTreeOid = await this.writeTree(verifiedEntries, verifyIndex);
        if (workspaceTreeOid.status === "error") return Result.err(workspaceTreeOid.error);
        if (workspaceTreeOid.value !== snapshot.workspaceTreeOid) {
          return failWith(
            this.verificationError("Fresh workspace tree does not match target snapshot"),
          );
        }
        const manifestOid = await this.hashBytes(snapshot.manifestBytes, false);
        if (manifestOid.status === "error") return Result.err(manifestOid.error);
        if (manifestOid.value !== snapshot.manifestBlobOid) {
          return failWith(this.verificationError("Snapshot manifest changed during restore"));
        }
        const wrapperOid = await this.writeWrapperTree(workspaceTreeOid.value, manifestOid.value);
        if (wrapperOid.status === "error") return Result.err(wrapperOid.error);
        if (wrapperOid.value !== snapshot.rootTreeOid) {
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
        if (stats.status === "error") return stats;
        if (!stats.value) return Result.ok(undefined);
        if (stats.value.isDirectory() && !stats.value.isSymbolicLink()) {
          signatures.set(
            relativePath,
            `directory:${stats.value.mode}:${stats.value.dev}:${stats.value.ino}`,
          );
          const children = await attemptHost(() => readdir(absolutePath));
          if (children.status === "error") return children;
          for (const child of children.value) {
            const scanned = await scan(path.join(absolutePath, child));
            if (scanned.status === "error") return scanned;
          }
          return Result.ok(undefined);
        }
        const entry = await this.readLiveEntry(relativePath, absolutePath);
        if (entry.status === "error") return entry;
        if (entry.value) {
          const signature = await this.entrySignature(entry.value);
          if (signature.status === "error") return signature;
          signatures.set(relativePath, signature.value);
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
      if (rootSafe.status === "error") return rootSafe;
      const rootCreated = await attemptHost(() =>
        mkdir(temporaryRoot, { recursive: true, mode: 0o700 }),
      );
      if (rootCreated.status === "error") return rootCreated;
      const createdRootSafe = await this.assertNoSymlinkComponents(temporaryRoot, false);
      if (createdRootSafe.status === "error") return createdRootSafe;
      const stagingDirectory = path.join(temporaryRoot, `restore-${randomUUID()}`);
      const stagingCreated = await attemptHost(() => mkdir(stagingDirectory, { mode: 0o700 }));
      if (stagingCreated.status === "error") return stagingCreated;
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
          if (opened.status === "error") return Result.err(opened.error);
          const staged = await superviseOutcome<void>(async () => {
            const copied = await this.runPrivateGitToHandle(
              ["cat-file", "blob", entry.oid],
              opened.value.fd,
              { operation: "stage snapshot blob" },
            );
            if (copied.status === "error") return copied;
            return await attemptHost(async () => await opened.value.sync());
          });
          const closed = await runWorkspaceHistoryCleanup(operation, [
            async () => await attemptHost(async () => await opened.value.close()),
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
          if (oid.status === "error") return Result.err(oid.error);
          if (oid.value !== entry.oid) {
            return failOwned({
              code: "snapshot-invalid",
              operation: "stage snapshot blob",
              message: `Staged blob does not match target object at ${entry.relativePath}`,
            });
          }
          if (entry.mode === POSIX_SYMLINK_MODE) {
            const payload = await attemptHost(() => readFile(stagingPath));
            if (payload.status === "error") return Result.err(payload.error);
            if (payload.value.includes(0)) {
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
      if (safe.status === "error") return safe;
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
    if (hooked.status === "error")
      return Result.err(labelWorkspaceFailure(hooked.error, operation));
    if (prepared.state === "disposed") return Result.ok(undefined);
    prepared.state = prepared.state === "applied" ? "applied" : "disposed";
    const destinationCleaned = await this.cleanupDestinationArtifacts(
      prepared.ownedTemps,
      prepared.ownedDirectories,
      prepared.workspaceIdentity,
    );
    if (destinationCleaned.status === "error") {
      return Result.err(labelWorkspaceFailure(destinationCleaned.error, operation));
    }
    const staleCleaned = await this.cleanupStaleRestoreArtifactsLocked();
    if (staleCleaned.status === "error") {
      return Result.err(labelWorkspaceFailure(staleCleaned.error, operation));
    }
    const stagingRemoved = await attemptHost(() =>
      rm(prepared.stagingDirectory, { recursive: true, force: true }),
    );
    if (stagingRemoved.status === "error") {
      return Result.err(labelWorkspaceFailure(stagingRemoved.error, operation));
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
      if (removedParent.status === "error") {
        const code = hostErrorCode(removedParent.error);
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
    if (directoryStats.status === "error") return directoryStats;
    if (!directoryStats.value) return Result.ok(false);
    if (!directoryStats.value.isDirectory() || directoryStats.value.isSymbolicLink()) {
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
    if (children.status === "error") return children;
    for (const child of children.value) {
      const metadataMatch = /^([0-9a-f]{40}|[0-9a-f]{64})\.json$/.exec(child.name);
      if (metadataMatch?.[1] && child.isFile() && !child.isSymbolicLink()) {
        const rootTreeOid = metadataMatch[1];
        const gitRef = this.snapshotRef(rootTreeOid);
        if (refs.get(gitRef) === rootTreeOid) continue;
        const metadata = await this.readSnapshotRefCreationMetadata(rootTreeOid, gitRef);
        if (metadata.status === "error") return metadata;
        if (metadata.value && metadata.value.createdAtMs >= cutoff) continue;
        const removedFile = await attemptHost(() =>
          rm(path.join(this.snapshotRefCreationDirectory, child.name)),
        );
        if (removedFile.status === "error") return removedFile;
        removed = true;
        continue;
      }
      if (!/^\.[0-9a-f]+\.[0-9a-f-]{36}\.tmp$/.test(child.name)) continue;
      const temporaryPath = path.join(this.snapshotRefCreationDirectory, child.name);
      const stats = await lstatIfExists(temporaryPath);
      if (stats.status === "error") return stats;
      if (!stats.value || stats.value.mtimeMs >= cutoff) continue;
      const removedTemporary = await attemptHost(() => rm(temporaryPath, { recursive: true }));
      if (removedTemporary.status === "error") return removedTemporary;
      removed = true;
    }
    return Result.ok(removed);
  }

  private async directoryHasEntries(directory: string): Promise<WorkspaceHistoryResult<boolean>> {
    const stats = await lstatIfExists(directory);
    if (stats.status === "error") return stats;
    if (!stats.value) return Result.ok(false);
    if (!stats.value.isDirectory() || stats.value.isSymbolicLink()) return Result.ok(true);
    const children = await attemptHost(() => readdir(directory));
    if (children.status === "error") return children;
    return Result.ok(children.value.length > 0);
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
      if (stats.status === "error") return stats;
      if (!stats.value) {
        if (allowMissingTail) return Result.ok(undefined);
        return failOwned({
          code: "workspace-invalid",
          operation: "validate path traversal",
          message: `Required path component does not exist: ${current}`,
        });
      }
      if (stats.value.isSymbolicLink()) {
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
      if (decoded.status === "error") return failWith(decoded.error);
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
    if (ownedRestoreArtifacts.status === "error") return ownedRestoreArtifacts;
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
      if (
        relativeDirectory &&
        children.status === "ok" &&
        children.value.some((entry) => this.isGitMetadataName(entry.name))
      ) {
        boundaryRoots.add(relativeDirectory);
        return Result.ok(undefined);
      }
      if (children.status === "error") return children;
      for (const child of children.value.sort((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        if (this.isGitMetadataName(child.name)) continue;
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${toPosixPath(child.name)}`
          : toPosixPath(child.name);
        const absolutePath = path.join(absoluteDirectory, child.name);
        if (
          [...ownedRestoreArtifacts.value].some(
            (artifactPath) =>
              this.comparisonPath(artifactPath) === this.comparisonPath(absolutePath),
          )
        ) {
          continue;
        }
        if (this.isProtectedAbsolutePath(absolutePath)) continue;
        const stats = await attemptHost(() => lstat(absolutePath, { bigint: true }));
        if (stats.status === "error") return stats;
        if (stats.value.isDirectory()) {
          directories.add(relativePath);
          if (managedPaths && !traversedDirectories.has(relativePath)) continue;
          const scanned = await scanDirectory(absolutePath, relativePath);
          if (scanned.status === "error") return scanned;
          continue;
        }
        let kind: ScannedEntry["kind"];
        if (stats.value.isSymbolicLink()) {
          kind = "symlink";
        } else if (stats.value.isFile()) {
          kind = "regular";
        } else {
          kind = "special";
        }
        let mode: number;
        if (kind === "symlink") {
          mode = POSIX_SYMLINK_MODE;
        } else if (kind === "special") {
          mode = 0;
        } else if ((stats.value.mode & 0o111n) !== 0n) {
          mode = POSIX_EXECUTABLE_MODE;
        } else {
          mode = POSIX_FILE_MODE;
        }
        entries.set(relativePath, {
          relativePath,
          absolutePath,
          kind,
          mode,
          size: stats.value.size.toString(),
          mtimeNs: stats.value.mtimeNs.toString(),
          ctimeNs: stats.value.ctimeNs.toString(),
          dev: stats.value.dev.toString(),
          ino: stats.value.ino.toString(),
        });
      }
      return Result.ok(undefined);
    };

    const scanned = await scanDirectory(this.cwd, "");
    if (scanned.status === "error") return scanned;
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
    if (result.status === "error") return result;
    const workspacePrefix = scope === "." ? "" : `${scope}/`;
    const paths = new Set<string>();
    const records = splitNul(result.value.stdout, "classify source repository paths");
    if (records.status === "error") return records;
    for (const repositoryPath of records.value) {
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
      if (safe.status === "error") return safe;
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
    if (result.status === "error") return result;
    if (result.value.exitCode === 0) {
      const decoded = bytesToText(result.value.stdout, "resolve source excludes file");
      if (decoded.status === "error") return decoded;
      const configured = decoded.value.trim();
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
    if (stats.status === "error") return stats;
    return Result.ok(stats.value?.isFile() ? defaultGlobalExclude : undefined);
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
    if (result.status === "error") return result;
    if (result.value.exitCode === 1) return Result.ok(new Set());
    const ignored = new Set<string>();
    const records = splitNul(result.value.stdout, "classify ignored paths");
    if (records.status === "error") return records;
    for (const outputPath of records.value) {
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
    if (records.status === "error") return records;
    for (const record of records.value) {
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
      if (safe.status === "error") return safe;
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
      if (matches.status === "error") return matches;
      if (!matches.value) changed.set(relativePath, entry);
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
    if (sizes.status === "error") return sizes;
    const privateStagingBytes = [...snapshot.entries.values()].reduce(
      (total, entry) => total + (sizes.value.get(entry.oid) ?? 0n),
      0n,
    );
    const parents = new Map<string, { representativePath: string; requiredBytes: bigint }>();
    for (const [relativePath, entry] of changed) {
      const unavailableRoot = await this.firstUnavailableTargetDirectory(relativePath);
      if (unavailableRoot.status === "error") return unavailableRoot;
      const parentRelative = unavailableRoot.value
        ? path.posix.dirname(unavailableRoot.value)
        : path.posix.dirname(relativePath);
      const parent = parentRelative === "." ? this.cwd : fromPosixPath(this.cwd, parentRelative);
      const previous = parents.get(parent);
      parents.set(parent, {
        representativePath: previous?.representativePath ?? relativePath,
        requiredBytes: (previous?.requiredBytes ?? 0n) + (sizes.value.get(entry.oid) ?? 0n),
      });
    }
    const materializedBytes =
      privateStagingBytes +
      [...parents.values()].reduce((total, requirement) => total + requirement.requiredBytes, 0n);
    const observed = await attemptHost(
      async () => await observeMaterializedBytes?.(materializedBytes),
    );
    if (observed.status === "error") return observed;

    const capacities = new Map<string, FilesystemCapacity>();
    const addCapacity = async (
      targetPath: string,
      requiredBytes: bigint,
    ): Promise<WorkspaceHistoryResult<void>> => {
      const filesystem = await attemptHost(() => this.statfs(targetPath));
      if (filesystem.status === "error") return filesystem;
      const availableBytes = filesystem.value.bavail * filesystem.value.bsize;
      const previous = capacities.get(filesystem.value.filesystemId);
      capacities.set(filesystem.value.filesystemId, {
        availableBytes:
          previous && previous.availableBytes < availableBytes
            ? previous.availableBytes
            : availableBytes,
        requiredBytes: (previous?.requiredBytes ?? 0n) + requiredBytes,
      });
      return Result.ok(undefined);
    };
    const privateCapacity = await addCapacity(this.storeDirectory, privateStagingBytes);
    if (privateCapacity.status === "error") return privateCapacity;
    for (const [parent, requirement] of parents) {
      const parentStats = await attemptHost(() => lstat(parent));
      if (parentStats.status === "error") return parentStats;
      if (!parentStats.value.isDirectory() || parentStats.value.isSymbolicLink()) {
        return failWith(
          this.restoreConflict("Destination capability parent is not a real directory"),
        );
      }
      const accessible = await attemptHost(() =>
        access(parent, fsConstants.W_OK | fsConstants.X_OK),
      );
      if (accessible.status === "error") return accessible;
      const capacity = await addCapacity(parent, requirement.requiredBytes);
      if (capacity.status === "error") return capacity;
    }
    if (
      [...capacities.values()].some((capacity) => capacity.availableBytes < capacity.requiredBytes)
    ) {
      return failWith(this.restoreConflict("Restore filesystem has insufficient available space"));
    }

    const createdManifest = await this.createRestoreOwnershipManifest(snapshot.rootTreeOid, "");
    if (createdManifest.status === "error") return createdManifest;
    const { manifestPath, manifest } = createdManifest.value;
    manifest.privateStagingDirectory = undefined;
    const written = await this.writeRestoreOwnershipManifest(manifestPath, manifest);
    if (written.status === "error") return written;
    const primary = await superviseOutcome<bigint>(async () => {
      for (const [parent, requirement] of parents) {
        const probed = await this.runEmptyDestinationCapabilityProbe(
          parent,
          requirement.representativePath,
          manifestPath,
          manifest,
        );
        if (probed.status === "error") return probed;
      }
      return Result.ok(materializedBytes);
    });
    const cleanup = await runWorkspaceHistoryCleanup("preflight destination capabilities", [
      async () => {
        const cleaned = await this.cleanupStaleRestoreArtifactsLocked();
        if (cleaned.status === "error") return Result.err(cleaned.error);
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
    if (result.status === "error") return result;
    const decoded = bytesToText(result.value.stdout, "measure target snapshot objects");
    if (decoded.status === "error") return decoded;
    const lines = decoded.value.trimEnd().split("\n");
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
    if (emptyOid.status === "error") return emptyOid;
    const parent = await this.parentIdentity(destinationDirectory);
    if (parent.status === "error") return parent;
    const regularPath = path.join(destinationDirectory, this.restoreTemporaryName());
    const regularIntent = await this.addRestoreArtifactIntent(manifestPath, manifest, {
      path: regularPath,
      kind: "file",
      role: "capability-file",
      expectedOid: emptyOid.value,
      expectedMode: POSIX_FILE_MODE,
      ...parent.value,
    });
    if (regularIntent.status === "error") return regularIntent;
    const regularHandle = await attemptHost(() =>
      open(
        regularPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      ),
    );
    if (regularHandle.status === "error") return regularHandle;
    const regularPrimary = await superviseOutcome<BigIntStats>(async () => {
      const stats = await attemptHost(() => regularHandle.value.stat({ bigint: true }));
      if (stats.status === "error") return stats;
      const synced = await attemptHost(async () => await regularHandle.value.sync());
      if (synced.status === "error") return Result.err(synced.error);
      return Result.ok(stats.value);
    });
    const regularCleanup = await runWorkspaceHistoryCleanup("probe destination capabilities", [
      async () => await attemptHost(async () => await regularHandle.value.close()),
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
      regularIntent.value,
      regularIdentity,
    );
    if (completedRegular.status === "error") return completedRegular;

    const symlinkBytes = Buffer.from("mini-lilac-capability");
    const symlinkOid = await this.hashBytes(symlinkBytes, false);
    if (symlinkOid.status === "error") return symlinkOid;
    const symlinkPath = path.join(destinationDirectory, this.restoreTemporaryName());
    const symlinkIntent = await this.addRestoreArtifactIntent(manifestPath, manifest, {
      path: symlinkPath,
      kind: "file",
      role: "capability-symlink",
      expectedOid: symlinkOid.value,
      expectedMode: POSIX_SYMLINK_MODE,
      ...parent.value,
    });
    if (symlinkIntent.status === "error") return symlinkIntent;
    const linked = await attemptHost(() => symlink(symlinkBytes, symlinkPath));
    if (linked.status === "error") return linked;
    const symlinkStats = await attemptHost(() => lstat(symlinkPath, { bigint: true }));
    if (symlinkStats.status === "error") return symlinkStats;
    const completedSymlink = await this.completeRestoreArtifactIdentity(
      manifestPath,
      manifest,
      symlinkIntent.value,
      {
        path: symlinkPath,
        dev: symlinkStats.value.dev,
        ino: symlinkStats.value.ino,
      },
    );
    if (completedSymlink.status === "error") return completedSymlink;

    const beforeLink = await attemptHost(
      async () => await this.beforeHardLinkValidation?.(relativePath, destinationDirectory),
    );
    if (beforeLink.status === "error") return beforeLink;
    const linkPath = path.join(destinationDirectory, this.restoreTemporaryName());
    const linkIntent = await this.addRestoreArtifactIntent(manifestPath, manifest, {
      path: linkPath,
      kind: "file",
      role: "capability-hard-link-probe",
      expectedOid: emptyOid.value,
      expectedMode: POSIX_FILE_MODE,
      expectedSourceDev: regularIdentity.dev.toString(),
      expectedSourceIno: regularIdentity.ino.toString(),
      ...parent.value,
    });
    if (linkIntent.status === "error") return linkIntent;
    const hardLinked = await attemptHost(() => link(regularPath, linkPath));
    if (hardLinked.status === "error") return hardLinked;
    const linkStats = await attemptHost(() => lstat(linkPath, { bigint: true }));
    if (linkStats.status === "error") return linkStats;
    const completedLink = await this.completeRestoreArtifactIdentity(
      manifestPath,
      manifest,
      linkIntent.value,
      {
        path: linkPath,
        dev: linkStats.value.dev,
        ino: linkStats.value.ino,
      },
    );
    if (completedLink.status === "error") return completedLink;
    return await this.fsyncDirectory(destinationDirectory);
  }

  private async liveEntryMatches(entry: TreeEntry): Promise<WorkspaceHistoryResult<boolean>> {
    const absolutePath = fromPosixPath(this.cwd, entry.relativePath);
    for (const ancestor of pathAncestors(entry.relativePath)) {
      const ancestorStats = await lstatIfExists(fromPosixPath(this.cwd, ancestor));
      if (ancestorStats.status === "error") return ancestorStats;
      if (!ancestorStats.value || !ancestorStats.value.isDirectory()) return Result.ok(false);
    }
    const stats = await lstatIfExists(absolutePath);
    if (stats.status === "error") return stats;
    if (!stats.value) return Result.ok(false);
    if (entry.mode === POSIX_SYMLINK_MODE) {
      if (!stats.value.isSymbolicLink()) return Result.ok(false);
      const target = await attemptHost(() => readlink(absolutePath, { encoding: "buffer" }));
      if (target.status === "error") return target;
      const oid = await this.hashBytes(target.value, false);
      if (oid.status === "error") return oid;
      return Result.ok(oid.value === entry.oid);
    }
    if (!stats.value.isFile()) return Result.ok(false);
    const actualMode = (stats.value.mode & 0o111) !== 0 ? POSIX_EXECUTABLE_MODE : POSIX_FILE_MODE;
    if (actualMode !== entry.mode) return Result.ok(false);
    const oid = await this.hashFile(absolutePath, false);
    if (oid.status === "error") return oid;
    return Result.ok(oid.value === entry.oid);
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
    if (createdManifest.status === "error") return createdManifest;
    const { manifestPath, manifest } = createdManifest.value;
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
        if (unavailableRoot.status === "error") return unavailableRoot;
        if (!unavailableRoot.value || replacementRoots.has(unavailableRoot.value)) continue;
        const parentRelative = path.posix.dirname(unavailableRoot.value);
        const parentDirectory =
          parentRelative === "." ? this.cwd : fromPosixPath(this.cwd, parentRelative);
        const safe = await this.assertSafeMutationAncestors(
          unavailableRoot.value,
          workspaceIdentity,
        );
        if (safe.status === "error") return safe;
        const identity = await this.createExclusiveTemporaryDirectory(
          parentDirectory,
          manifestPath,
          manifest,
          "replacement-root",
        );
        if (identity.status === "error") return identity;
        const temporaryPath = identity.value.path;
        ownedDirectories.set(temporaryPath, identity.value);
        replacementRoots.set(unavailableRoot.value, {
          relativePath: unavailableRoot.value,
          temporaryPath,
          identity: identity.value,
          published: false,
        });
        const synced = await this.fsyncDirectory(parentDirectory);
        if (synced.status === "error") return synced;
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
        if (identity.status === "error") return identity;
        ownedDirectories.set(directory, identity.value);
        const synced = await this.fsyncDirectory(path.dirname(directory));
        if (synced.status === "error") return synced;
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
        if (beforeStage.status === "error") return beforeStage;
        const parentStats = await attemptHost(() => lstat(destinationDirectory));
        if (parentStats.status === "error") return parentStats;
        if (!parentStats.value.isDirectory() || parentStats.value.isSymbolicLink()) {
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
        if (temporary.status === "error") return temporary;
        ownedTemps.set(temporary.value.path, temporary.value);
        destinationEntries.set(relativePath, {
          ...staged,
          temporaryPath: temporary.value.path,
          replacementRoot: replacementRoot?.relativePath,
        });
        const validated = await this.validateHardLinkPrimitive(
          staged,
          destinationDirectory,
          temporary.value,
          manifestPath,
          manifest,
        );
        if (validated.status === "error") return validated;
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
        if (cleaned.status === "error") return Result.err(cleaned.error);
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
      if (stats.status === "error") return stats;
      if (!stats.value || !stats.value.isDirectory()) return Result.ok(ancestor);
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
      if (parent.status === "error") return parent;
      const intent = await this.addRestoreArtifactIntent(manifestPath, manifest, {
        path: candidate,
        kind: "directory",
        role,
        ...parent.value,
      });
      if (intent.status === "error") return intent;
      const created = await attemptHost(() => mkdir(candidate, { mode: 0o700 }));
      if (created.status === "error") {
        const removed = await this.removeRestoreArtifactRecord(manifestPath, manifest, candidate);
        if (removed.status === "error") return removed;
        if (hostErrorCode(created.error) === "EEXIST") continue;
        return created;
      }
      const hooked = await attemptHost(
        async () => await this.afterArtifactCreateBeforeIdentity?.(role, candidate),
      );
      if (hooked.status === "error") return hooked;
      const stats = await attemptHost(() => lstat(candidate, { bigint: true }));
      if (stats.status === "error") return stats;
      const owned = { path: candidate, dev: stats.value.dev, ino: stats.value.ino };
      const completed = await this.completeRestoreArtifactIdentity(
        manifestPath,
        manifest,
        intent.value,
        owned,
      );
      if (completed.status === "error") return completed;
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
    if (parent.status === "error") return parent;
    const intent = await this.addRestoreArtifactIntent(manifestPath, manifest, {
      path: directory,
      kind: "directory",
      role,
      ...parent.value,
    });
    if (intent.status === "error") return intent;
    const created = await attemptHost(() => mkdir(directory, { mode: 0o700 }));
    if (created.status === "error") {
      const removed = await this.removeRestoreArtifactRecord(manifestPath, manifest, directory);
      if (removed.status === "error") return removed;
      return created;
    }
    const hooked = await attemptHost(
      async () => await this.afterArtifactCreateBeforeIdentity?.(role, directory),
    );
    if (hooked.status === "error") return hooked;
    const stats = await attemptHost(() => lstat(directory, { bigint: true }));
    if (stats.status === "error") return stats;
    const owned = { path: directory, dev: stats.value.dev, ino: stats.value.ino };
    const completed = await this.completeRestoreArtifactIdentity(
      manifestPath,
      manifest,
      intent.value,
      owned,
    );
    if (completed.status === "error") return completed;
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
      if (parent.status === "error") return parent;
      const intent = await this.addRestoreArtifactIntent(manifestPath, manifest, {
        path: candidate,
        kind: "file",
        role,
        expectedOid: entry.oid,
        expectedMode: entry.mode,
        ...parent.value,
      });
      if (intent.status === "error") return intent;
      let owned: OwnedTemporaryPath | undefined;
      let created = false;
      const primary = await superviseOutcome<OwnedTemporaryPath>(async () => {
        if (entry.mode === POSIX_SYMLINK_MODE) {
          const payload = await attemptHost(() => readFile(entry.stagingPath));
          if (payload.status === "error") return payload;
          const linked = await attemptHost(() => symlink(payload.value, candidate));
          if (linked.status === "error") return linked;
        } else {
          const copied = await attemptHost(() =>
            copyFile(entry.stagingPath, candidate, fsConstants.COPYFILE_EXCL),
          );
          if (copied.status === "error") return copied;
        }
        created = true;
        const hooked = await attemptHost(
          async () => await this.afterArtifactCreateBeforeIdentity?.(role, candidate),
        );
        if (hooked.status === "error") return hooked;
        const stats = await attemptHost(() => lstat(candidate, { bigint: true }));
        if (stats.status === "error") return stats;
        owned = { path: candidate, dev: stats.value.dev, ino: stats.value.ino };
        const completed = await this.completeRestoreArtifactIdentity(
          manifestPath,
          manifest,
          intent.value,
          owned,
        );
        if (completed.status === "error") return completed;
        if (entry.mode !== POSIX_SYMLINK_MODE) {
          const modeSet = await attemptHost(() =>
            chmod(candidate, entry.mode === POSIX_EXECUTABLE_MODE ? 0o755 : 0o644),
          );
          if (modeSet.status === "error") return modeSet;
          const handle = await attemptHost(() =>
            open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW),
          );
          if (handle.status === "error") return handle;
          const synced = await superviseOutcome<void>(
            async () => await attemptHost(async () => await handle.value.sync()),
          );
          const closed = await runWorkspaceHistoryCleanup("create destination sibling", [
            async () => await attemptHost(async () => await handle.value.close()),
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
        if (directorySynced.status === "error") return directorySynced;
        return Result.ok(owned);
      });
      if (primary.status === "ok") return Result.ok(primary.value);
      const cleanup = await runWorkspaceHistoryCleanup("create destination sibling", [
        async () => {
          if (!owned) return Result.ok(undefined);
          const current = await lstatIfExists(owned.path, true);
          if (current.status === "error") return current;
          if (current.value && current.value.dev === owned.dev && current.value.ino === owned.ino) {
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
    if (before.status === "error") return before;
    const created = await attemptHost(() =>
      mkdir(this.restoreOwnershipDirectory, { recursive: true, mode: 0o700 }),
    );
    if (created.status === "error") return created;
    const after = await this.assertNoSymlinkComponents(this.restoreOwnershipDirectory, false);
    if (after.status === "error") return after;
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
    if (written.status === "error") return written;
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
    if (serialized.status === "error") return serialized;
    const decoded = this.decodeRestoreOwnership(serialized.value, operation);
    if (decoded.status === "error") return failWith(decoded.error);
    return Result.ok(decoded.value);
  }

  private async parentIdentity(
    parentDirectory: string,
  ): Promise<WorkspaceHistoryResult<{ parentDev: string; parentIno: string }>> {
    const stats = await attemptHost(() => lstat(parentDirectory, { bigint: true }));
    if (stats.status === "error") return stats;
    if (!stats.value.isDirectory() || stats.value.isSymbolicLink()) {
      return failWith(this.restoreConflict("Restore artifact parent is not a real directory"));
    }
    return Result.ok({
      parentDev: stats.value.dev.toString(),
      parentIno: stats.value.ino.toString(),
    });
  }

  private async addRestoreArtifactIntent(
    manifestPath: string,
    manifest: RestoreOwnershipManifest,
    artifact: RestoreArtifactRecord,
  ): Promise<WorkspaceHistoryResult<RestoreArtifactRecord>> {
    manifest.artifacts.push(artifact);
    const written = await this.writeRestoreOwnershipManifest(manifestPath, manifest);
    if (written.status === "error") return written;
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
    if (parent.status === "error") return parent;
    const intent = await this.addRestoreArtifactIntent(manifestPath, manifest, {
      path: testPath,
      kind: "file",
      role: "hard-link-probe",
      expectedOid: entry.oid,
      expectedMode: entry.mode,
      expectedSourceDev: source.dev.toString(),
      expectedSourceIno: source.ino.toString(),
      ...parent.value,
    });
    if (intent.status === "error") return intent;
    let testIdentity: OwnedTemporaryPath | undefined;
    let created = false;
    const primary = await superviseOutcome<void>(async () => {
      const before = await attemptHost(
        async () => await this.beforeHardLinkValidation?.(relativePath, destinationDirectory),
      );
      if (before.status === "error") return before;
      const linked = await attemptHost(() => link(source.path, testPath));
      if (linked.status === "error") return linked;
      created = true;
      const after = await attemptHost(
        async () => await this.afterArtifactCreateBeforeIdentity?.("hard-link-probe", testPath),
      );
      if (after.status === "error") return after;
      const stats = await attemptHost(() => lstat(testPath, { bigint: true }));
      if (stats.status === "error") return stats;
      testIdentity = { path: testPath, dev: stats.value.dev, ino: stats.value.ino };
      const completed = await this.completeRestoreArtifactIdentity(
        manifestPath,
        manifest,
        intent.value,
        testIdentity,
      );
      if (completed.status === "error") return completed;
      const beforeRemovalSynced = await this.fsyncDirectory(destinationDirectory);
      if (beforeRemovalSynced.status === "error") return beforeRemovalSynced;
      const owned = await this.assertOwnedTemporary(testIdentity);
      if (owned.status === "error") return owned;
      const removed = await attemptHost(() => rm(testPath));
      if (removed.status === "error") return removed;
      const afterRemovalSynced = await this.fsyncDirectory(destinationDirectory);
      if (afterRemovalSynced.status === "error") return afterRemovalSynced;
      const recordRemoved = await this.removeRestoreArtifactRecord(
        manifestPath,
        manifest,
        testPath,
      );
      if (recordRemoved.status === "error") return recordRemoved;
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
        if (current.status === "error") return current;
        if (
          current.value &&
          current.value.dev === identity.dev &&
          current.value.ino === identity.ino
        ) {
          const removed = await attemptHost(() => rm(identity.path));
          if (removed.status === "error") return removed;
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
      if (sourceRepository.status === "error") return sourceRepository;
      if (!sourceRepository.value) {
        return failWith(this.restoreConflict("Workspace is no longer inside a Git worktree"));
      }
      const staleCleaned = await this.cleanupStaleRestoreArtifactsLocked();
      if (staleCleaned.status === "error") return staleCleaned;
      const fresh = await this.assertPreparedRestoreFresh(prepared);
      if (fresh.status === "error") return fresh;
      if (!prepared.recovery) {
        const signatures = await this.captureProtectedSignatures();
        if (signatures.status === "error") return signatures;
        prepared.protectedSignatures = signatures.value;
        if (prepared.operationId) {
          const manifest = await this.readRestorePlanManifest(prepared.operationId);
          if (manifest.status === "error") return manifest;
          const written = await this.writeRestorePlanManifest({
            ...manifest.value,
            phase: "mutation-ready",
            protectedSignatures: this.signatureRecords(prepared.protectedSignatures),
          });
          if (written.status === "error") return written;
        }
      }
      const current = prepared.current;
      const snapshot = prepared.snapshot;
      const changedTargets = new Set<string>();
      for (const [relativePath, target] of snapshot.entries) {
        const matches = await this.liveEntryMatches(target);
        if (matches.status === "error") return matches;
        if (!matches.value) changedTargets.add(relativePath);
      }
      const destinationStaging = await this.stageDestinationEntries(
        prepared.stagedEntries,
        changedTargets,
        prepared.workspaceIdentity,
        prepared.snapshot.rootTreeOid,
        prepared.stagingDirectory,
      );
      if (destinationStaging.status === "error") return destinationStaging;
      Object.assign(prepared, destinationStaging.value);
      const stillFresh = await this.assertPreparedRestoreFresh(prepared);
      if (stillFresh.status === "error") return stillFresh;
      const stagingValid = await this.validateDestinationStaging(prepared);
      if (stagingValid.status === "error") return stagingValid;
      const afterStaging = await attemptHost(async () => await this.afterDestinationStaging?.());
      if (afterStaging.status === "error") return afterStaging;

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
        if (before.status === "error") return before;
        const safe = await this.assertSafeMutationAncestors(
          relativePath,
          prepared.workspaceIdentity,
        );
        if (safe.status === "error") return safe;
        const absolutePath = fromPosixPath(this.cwd, relativePath);
        const existing = await lstatIfExists(absolutePath);
        if (existing.status === "error") return existing;
        if (
          existing.value?.isDirectory() &&
          [...snapshot.entries.keys()].some((candidate) => candidate.startsWith(`${relativePath}/`))
        ) {
          continue;
        }
        if (existing.value) {
          const signatureValid = await this.assertLiveSignature(
            relativePath,
            prepared.liveSignatures.get(relativePath),
          );
          if (signatureValid.status === "error") return signatureValid;
          const removed = await attemptHost(() => rm(absolutePath));
          if (removed.status === "error") return removed;
          mutated = true;
          const afterDeletion = await attemptHost(
            async () => await this.afterLiveDeletion?.(relativePath),
          );
          if (afterDeletion.status === "error") return afterDeletion;
        }
      }

      for (const replacementRoot of [...prepared.replacementRoots.values()].sort(
        (left, right) => left.relativePath.split("/").length - right.relativePath.split("/").length,
      )) {
        const published = await this.publishReplacementRoot(replacementRoot, prepared);
        if (published.status === "error") return published;
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
        if (before.status === "error") return before;
        const safe = await this.assertSafeMutationAncestors(
          relativePath,
          prepared.workspaceIdentity,
        );
        if (safe.status === "error") return safe;
        const absolutePath = fromPosixPath(this.cwd, relativePath);
        const stats = await lstatIfExists(absolutePath);
        if (stats.status === "error") return stats;
        if (stats.value && !stats.value.isDirectory()) {
          return failWith(
            this.restoreConflict(`Target directory path changed before apply: ${relativePath}`),
          );
        }
        if (!stats.value) {
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
        if (existing.status === "error") return existing;
        if (existing.value?.isDirectory()) {
          const before = await this.beforeLiveMutation(relativePath);
          if (before.status === "error") return before;
          const safe = await this.assertSafeMutationAncestors(
            relativePath,
            prepared.workspaceIdentity,
          );
          if (safe.status === "error") return safe;
          const removed = await attemptHost(() => rmdir(absolutePath));
          if (removed.status === "error") return removed;
          mutated = true;
        } else if (existing.value) {
          return failWith(
            this.restoreConflict(`Target path changed before materialization: ${relativePath}`),
          );
        }
        mutated = true;
        const published = await this.publishDestinationSibling(staged, prepared);
        if (published.status === "error") return published;
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
        if (before.status === "error") return before;
        const safe = await this.assertSafeMutationAncestors(
          relativePath,
          prepared.workspaceIdentity,
        );
        if (safe.status === "error") return safe;
        const absolutePath = fromPosixPath(this.cwd, relativePath);
        const stats = await lstatIfExists(absolutePath);
        if (stats.status === "error") return stats;
        if (!stats.value) continue;
        if (!stats.value.isDirectory()) {
          return failWith(
            this.restoreConflict(`Managed directory path changed before cleanup: ${relativePath}`),
          );
        }
        const removed = await attemptHost(() => rmdir(absolutePath));
        if (removed.status === "error" && hostErrorCode(removed.error) !== "ENOTEMPTY") {
          return removed;
        }
      }

      const beforeVerification = await attemptHost(
        async () => await this.beforeFinalVerification?.(),
      );
      if (beforeVerification.status === "error") return beforeVerification;
      const verifiedTargetEntries = await this.verifyFrozenRestoredSnapshot(prepared);
      if (verifiedTargetEntries.status === "error") return verifiedTargetEntries;
      const protectedVerified = await this.verifyProtectedSignatures(prepared.protectedSignatures);
      if (protectedVerified.status === "error") return protectedVerified;
      const cachePrimary = await superviseOutcome<void>(async () => {
        const afterVerification = await attemptHost(
          async () => await this.afterFinalVerificationBeforeCacheReconciliation?.(),
        );
        if (afterVerification.status === "error") return afterVerification;
        return await this.reconcileCaptureStateAfterRestore(snapshot, verifiedTargetEntries.value);
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
      if (disposed.status === "error") return disposed;
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
        if (cleaned.status === "error") return Result.err(cleaned.error);
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
    if (before.status === "error") return before;
    const safe = await this.assertSafeMutationAncestors(
      root.relativePath,
      prepared.workspaceIdentity,
    );
    if (safe.status === "error") return safe;
    const owned = await this.assertOwnedTemporary(root.identity);
    if (owned.status === "error") return owned;
    const targetPath = fromPosixPath(this.cwd, root.relativePath);
    const existing = await lstatIfExists(targetPath);
    if (existing.status === "error") return existing;
    if (existing.value) {
      return failWith(
        this.restoreConflict(`Replacement directory target appeared: ${root.relativePath}`),
      );
    }
    const aliases = await this.writeReplacementMoveAliases(
      root.temporaryPath,
      targetPath,
      prepared,
    );
    if (aliases.status === "error") return aliases;
    const moved = await attemptHost(() => rename(root.temporaryPath, targetPath));
    if (moved.status === "error") return moved;
    const synced = await this.fsyncDirectory(path.dirname(targetPath));
    if (synced.status === "error") return synced;
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
    if (manifestSynced.status === "error") return manifestSynced;
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
      if (owned.status === "error") return owned;
      const temporaryStats = await attemptHost(() => lstat(entry.temporaryPath));
      if (temporaryStats.status === "error") return temporaryStats;
      let temporaryMode: number;
      if (temporaryStats.value.isSymbolicLink()) {
        temporaryMode = POSIX_SYMLINK_MODE;
      } else if (temporaryStats.value.isFile() && (temporaryStats.value.mode & 0o111) !== 0) {
        temporaryMode = POSIX_EXECUTABLE_MODE;
      } else if (temporaryStats.value.isFile()) {
        temporaryMode = POSIX_FILE_MODE;
      } else {
        temporaryMode = 0;
      }
      if (temporaryMode !== entry.mode) {
        return failWith(this.restoreConflict(`Destination sibling mode changed: ${relativePath}`));
      }
      const parent = path.dirname(entry.temporaryPath);
      const parentStats = await attemptHost(() => lstat(parent));
      if (parentStats.status === "error") return parentStats;
      if (!parentStats.value.isDirectory() || parentStats.value.isSymbolicLink()) {
        return failWith(
          this.restoreConflict(`Destination staging parent changed: ${relativePath}`),
        );
      }
      const accessible = await attemptHost(() =>
        access(parent, fsConstants.W_OK | fsConstants.X_OK),
      );
      if (accessible.status === "error") return accessible;
      let oid: WorkspaceHistoryResult<string>;
      if (entry.mode === POSIX_SYMLINK_MODE) {
        const target = await attemptHost(() =>
          readlink(entry.temporaryPath, { encoding: "buffer" }),
        );
        if (target.status === "error") return target;
        oid = await this.hashBytes(target.value, false);
      } else {
        oid = await this.hashFile(entry.temporaryPath, false);
      }
      if (oid.status === "error") return oid;
      if (oid.value !== entry.oid) {
        return failWith(
          this.restoreConflict(`Destination sibling changed after preparation: ${relativePath}`),
        );
      }
    }
    for (const root of prepared.replacementRoots.values()) {
      if (!root.published) {
        const owned = await this.assertOwnedTemporary(root.identity);
        if (owned.status === "error") return owned;
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
    if (before.status === "error") return before;
    const safe = await this.assertSafeMutationAncestors(
      entry.relativePath,
      prepared.workspaceIdentity,
    );
    if (safe.status === "error") return safe;
    const existing = await lstatIfExists(absolutePath);
    if (existing.status === "error") return existing;
    if (existing.value) {
      return failWith(
        this.restoreConflict(`Target appeared before publication: ${entry.relativePath}`),
      );
    }
    const owned = await this.assertOwnedTemporary(temporary);
    if (owned.status === "error") return owned;
    const linked = await attemptHost(() => link(temporary.path, absolutePath));
    if (linked.status === "error") {
      if (hostErrorCode(linked.error) === "EEXIST") {
        return failWith(
          this.restoreConflict(`Target appeared before publication: ${entry.relativePath}`),
        );
      }
      return linked;
    }
    const synced = await this.fsyncDirectory(path.dirname(absolutePath));
    if (synced.status === "error") return synced;
    const stillOwned = await this.assertOwnedTemporary(temporary);
    if (stillOwned.status === "error") return stillOwned;
    const removed = await attemptHost(() => rm(temporary.path));
    if (removed.status === "error") return removed;
    prepared.ownedTemps.delete(temporary.path);
    const manifestSynced = await this.syncPreparedOwnershipManifest(prepared);
    if (manifestSynced.status === "error") return manifestSynced;
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
      if (retained.status === "error") return retained;
    }
    for (const artifact of prepared.ownedDirectories.values()) {
      const retained = retainIdentity(artifact, "directory");
      if (retained.status === "error") return retained;
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
    if (stats.status === "error") return stats;
    if (!stats.value || stats.value.dev !== temporary.dev || stats.value.ino !== temporary.ino) {
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
      if (safe.status === "error") return safe;
      const stats = await lstatIfExists(temporary.path, true);
      if (stats.status === "error") return stats;
      if (stats.value && stats.value.dev === temporary.dev && stats.value.ino === temporary.ino) {
        const removed = await attemptHost(() => rm(temporary.path));
        if (removed.status === "error") return removed;
      }
    }
    ownedTemps.clear();
    for (const directory of [...ownedDirectories.values()].sort(
      (left, right) => right.path.split(path.sep).length - left.path.split(path.sep).length,
    )) {
      const relativePath = toPosixPath(path.relative(this.cwd, directory.path));
      const safe = await this.assertSafeMutationAncestors(relativePath, workspaceIdentity);
      if (safe.status === "error") return safe;
      const stats = await lstatIfExists(directory.path, true);
      if (stats.status === "error") return stats;
      if (!stats.value || stats.value.dev !== directory.dev || stats.value.ino !== directory.ino) {
        continue;
      }
      const removed = await attemptHost(() => rmdir(directory.path));
      if (removed.status === "error" && hostErrorCode(removed.error) !== "ENOTEMPTY")
        return removed;
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
    if (directoryStats.status === "error") return directoryStats;
    if (!directoryStats.value) return Result.ok({ removed, preserved });
    if (!directoryStats.value.isDirectory() || directoryStats.value.isSymbolicLink()) {
      return failOwned({
        code: "ownership-mismatch",
        operation: "clean stale restore staging",
        message: "Restore ownership manifest path is not a real directory",
      });
    }
    const workspaceIdentity = await this.workspaceIdentity();
    if (workspaceIdentity.status === "error") return workspaceIdentity;
    const manifestEntries = await attemptHost(() =>
      readdir(this.restoreOwnershipDirectory, { withFileTypes: true }),
    );
    if (manifestEntries.status === "error") return manifestEntries;
    for (const manifestEntry of manifestEntries.value) {
      if (!manifestEntry.isFile() || !manifestEntry.name.endsWith(".json")) continue;
      const manifestPath = path.join(this.restoreOwnershipDirectory, manifestEntry.name);
      const manifest = await this.readRestoreOwnershipManifest(
        manifestPath,
        "clean stale restore staging",
      );
      if (manifest.status === "error") return manifest;
      const artifacts = manifest.value.artifacts;
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
        const safe = await this.assertSafeMutationAncestors(relativePath, workspaceIdentity.value);
        if (safe.status === "error") return safe;
        const stats = await lstatIfExists(artifact.path, true);
        if (stats.status === "error") return stats;
        if (!stats.value) {
          resolved.add(artifact);
          continue;
        }
        const identityMatches =
          artifact.dev !== undefined &&
          artifact.ino !== undefined &&
          stats.value.dev === BigInt(artifact.dev) &&
          stats.value.ino === BigInt(artifact.ino);
        const intentMatches = await this.intentArtifactMatches(artifact, stats.value);
        if (intentMatches.status === "error") return intentMatches;
        if (!identityMatches && !intentMatches.value) {
          preserved.push(artifact.path);
          continue;
        }
        const artifactRemoved = await attemptHost(() => rm(artifact.path));
        if (artifactRemoved.status === "error") return artifactRemoved;
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
        const safe = await this.assertSafeMutationAncestors(relativePath, workspaceIdentity.value);
        if (safe.status === "error") return safe;
        const stats = await lstatIfExists(artifact.path, true);
        if (stats.status === "error") return stats;
        if (!stats.value) {
          resolved.add(artifact);
          continue;
        }
        const identityMatches =
          artifact.dev !== undefined &&
          artifact.ino !== undefined &&
          stats.value.dev === BigInt(artifact.dev) &&
          stats.value.ino === BigInt(artifact.ino);
        const intentMatches = await this.intentArtifactMatches(artifact, stats.value);
        if (intentMatches.status === "error") return intentMatches;
        if (!identityMatches && !intentMatches.value) {
          preserved.push(artifact.path);
          continue;
        }
        const directoryRemoved = await attemptHost(() => rmdir(artifact.path));
        if (directoryRemoved.status === "ok") {
          removed.push(artifact.path);
          resolved.add(artifact);
        } else if (hostErrorCode(directoryRemoved.error) === "ENOTEMPTY") {
          preserved.push(artifact.path);
        } else {
          return directoryRemoved;
        }
      }
      manifest.value.artifacts = manifest.value.artifacts.filter(
        (artifact) => !resolved.has(artifact),
      );
      if (manifest.value.privateStagingDirectory) {
        const privateTemporaryRoot = path.join(this.storeDirectory, "temp");
        if (
          this.isWithinOrEqual(privateTemporaryRoot, manifest.value.privateStagingDirectory) &&
          path.basename(manifest.value.privateStagingDirectory).startsWith("restore-")
        ) {
          const stagingRemoved = await attemptHost(() =>
            rm(manifest.value.privateStagingDirectory!, { recursive: true, force: true }),
          );
          if (stagingRemoved.status === "error") return stagingRemoved;
          manifest.value.privateStagingDirectory = undefined;
        } else {
          preserved.push(manifest.value.privateStagingDirectory);
        }
      }
      if (
        manifest.value.artifacts.length === 0 &&
        manifest.value.privateStagingDirectory === undefined
      ) {
        const manifestRemoved = await attemptHost(() => rm(manifestPath));
        if (manifestRemoved.status === "error") return manifestRemoved;
      } else {
        const written = await this.writeRestoreOwnershipManifest(manifestPath, manifest.value);
        if (written.status === "error") return written;
      }
    }
    const synced = await this.fsyncDirectory(this.restoreOwnershipDirectory);
    if (synced.status === "error") return synced;
    return Result.ok({ removed, preserved });
  }

  private async validatedOwnedRestoreArtifactPaths(): Promise<WorkspaceHistoryResult<Set<string>>> {
    const owned = new Set<string>();
    const directoryStats = await lstatIfExists(this.restoreOwnershipDirectory);
    if (directoryStats.status === "error") return directoryStats;
    if (!directoryStats.value) return Result.ok(owned);
    if (!directoryStats.value.isDirectory() || directoryStats.value.isSymbolicLink()) {
      return failOwned({
        code: "ownership-mismatch",
        operation: "classify restore staging",
        message: "Restore ownership manifest path is not a real directory",
      });
    }
    const entries = await attemptHost(() =>
      readdir(this.restoreOwnershipDirectory, { withFileTypes: true }),
    );
    if (entries.status === "error") return entries;
    for (const entry of entries.value) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const manifestPath = path.join(this.restoreOwnershipDirectory, entry.name);
      const manifest = await this.readRestoreOwnershipManifest(
        manifestPath,
        "classify restore staging",
      );
      if (manifest.status === "error") return manifest;
      for (const artifact of manifest.value.artifacts) {
        if (
          artifact.dev === undefined ||
          artifact.ino === undefined ||
          !this.isWithinOrEqual(this.cwd, artifact.path)
        ) {
          continue;
        }
        const stats = await lstatIfExists(artifact.path, true);
        if (stats.status === "error") return stats;
        if (
          stats.value &&
          stats.value.dev === BigInt(artifact.dev) &&
          stats.value.ino === BigInt(artifact.ino)
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
    if (parentStats.status === "error") return parentStats;
    if (
      !parentStats.value ||
      !parentStats.value.isDirectory() ||
      parentStats.value.isSymbolicLink() ||
      parentStats.value.dev !== BigInt(artifact.parentDev) ||
      parentStats.value.ino !== BigInt(artifact.parentIno)
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
      if (target.status === "error") return target;
      oid = await this.hashBytes(target.value, false);
    } else if (stats.isFile()) {
      mode = (stats.mode & 0o111n) !== 0n ? POSIX_EXECUTABLE_MODE : POSIX_FILE_MODE;
      oid = await this.hashFile(artifact.path, false);
    } else {
      return Result.ok(false);
    }
    if (oid.status === "error") return oid;
    return Result.ok(mode === artifact.expectedMode && oid.value === artifact.expectedOid);
  }

  private async assertPreparedRestoreFresh(
    prepared: PreparedRestoreData,
  ): Promise<WorkspaceHistoryResult<void>> {
    const workspaceIdentity = await this.workspaceIdentity();
    if (workspaceIdentity.status === "error") return workspaceIdentity;
    if (workspaceIdentity.value !== prepared.workspaceIdentity) {
      return failWith(
        this.restoreConflict("Workspace root identity changed after restore preparation"),
      );
    }
    if (prepared.recovery) {
      const protectedSignatures = await this.captureProtectedSignatures();
      if (protectedSignatures.status === "error") return protectedSignatures;
      if (!mapsEqual(prepared.protectedSignatures, protectedSignatures.value)) {
        return failWith(this.restoreConflict("Protected paths changed after restore preparation"));
      }
      return await this.assertFrozenRecoveryState(prepared);
    }
    const current = await this.classifyWorkspace();
    if (current.status === "error") return current;
    const stripped = await this.stripPreparedArtifacts(current.value, prepared);
    if (stripped.status === "error") return stripped;
    const signatures = await this.captureLiveSignatures(current.value);
    if (signatures.status === "error") return signatures;
    if (
      !mapsEqual(signatures.value, prepared.liveSignatures) ||
      !setsEqual(new Set(current.value.managed.keys()), new Set(prepared.current.managed.keys())) ||
      !setsEqual(current.value.ignored, prepared.current.ignored) ||
      !setsEqual(current.value.boundaryRoots, prepared.current.boundaryRoots)
    ) {
      return failWith(
        this.restoreConflict("Workspace changed after restore preparation; prepare again"),
      );
    }
    return await this.preflightRestore(current.value, prepared.snapshot.entries);
  }

  private async assertFrozenRecoveryState(
    prepared: PreparedRestoreData,
  ): Promise<WorkspaceHistoryResult<void>> {
    const preserved = await this.verifyFrozenSignatures(
      prepared.preservation,
      "Ignored path changed after preparation",
    );
    if (preserved.status === "error") return preserved;
    const targetPaths = [...prepared.snapshot.entries.keys()];
    for (const relativePath of prepared.current.managed.keys()) {
      const absolutePath = fromPosixPath(this.cwd, relativePath);
      const stats = await lstatIfExists(absolutePath);
      if (stats.status === "error") return stats;
      const target = prepared.snapshot.entries.get(relativePath);
      if (target) {
        const matches = await this.liveEntryMatches(target);
        if (matches.status === "error") return matches;
        if (matches.value) continue;
      }
      const expectedSignature = prepared.liveSignatures.get(relativePath);
      const live = await this.readLiveEntry(relativePath, absolutePath);
      if (live.status === "error") return live;
      let signatureMatches = false;
      if (live.value && expectedSignature) {
        const signature = await this.entrySignature(live.value);
        if (signature.status === "error") return signature;
        signatureMatches = signature.value === expectedSignature;
      }
      if (live.value && expectedSignature && signatureMatches) {
        continue;
      }
      if (
        stats.value?.isDirectory() &&
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
      if (!stats.value && mayBeRemoved) continue;
      return failWith(
        this.restoreConflict(`Managed path has invalid partial restore state: ${relativePath}`),
      );
    }
    for (const [relativePath, target] of prepared.snapshot.entries) {
      const matches = await this.liveEntryMatches(target);
      if (matches.status === "error") return matches;
      if (matches.value) continue;
      const stats = await lstatIfExists(fromPosixPath(this.cwd, relativePath));
      if (stats.status === "error") return stats;
      const sourceSignature = prepared.liveSignatures.get(relativePath);
      const live = stats.value
        ? await this.readLiveEntry(relativePath, fromPosixPath(this.cwd, relativePath))
        : Result.ok<ScannedEntry | undefined, WorkspaceHistoryFailure>(undefined);
      if (live.status === "error") return live;
      if (live.value && sourceSignature) {
        const signature = await this.entrySignature(live.value);
        if (signature.status === "error") return signature;
        if (signature.value === sourceSignature) continue;
      }
      if (
        stats.value?.isDirectory() &&
        [...prepared.current.managed.keys()].some((candidate) =>
          candidate.startsWith(`${relativePath}/`),
        )
      ) {
        continue;
      }
      if (!stats.value) continue;
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
      if (entry.status === "error") return entry;
      if (!entry.value) return failWith(this.restoreConflict(`${message}: ${relativePath}`));
      const actual = await this.entrySignature(entry.value);
      if (actual.status === "error") return actual;
      if (actual.value !== signature) {
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
      if (owned.status === "error") return owned;
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
    if (entry.status === "error") return entry;
    if (!entry.value || expected === undefined) {
      return failWith(
        this.restoreConflict(`Managed path changed before mutation: ${relativePath}`),
      );
    }
    const signature = await this.entrySignature(entry.value);
    if (signature.status === "error") return signature;
    if (signature.value !== expected) {
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
    if (workspaceIdentity.status === "error") return workspaceIdentity;
    if (workspaceIdentity.value !== expectedWorkspaceIdentity) {
      return failWith(this.restoreConflict("Workspace root changed before mutation"));
    }
    for (const ancestor of pathAncestors(relativePath)) {
      const stats = await lstatIfExists(fromPosixPath(this.cwd, ancestor));
      if (stats.status === "error") return stats;
      if (!stats.value) {
        return failWith(
          this.restoreConflict(`Required mutation ancestor disappeared: ${ancestor}`),
        );
      }
      if (!stats.value.isDirectory() || stats.value.isSymbolicLink()) {
        return failWith(this.restoreConflict(`Refusing to traverse changed ancestor ${ancestor}`));
      }
    }
    return Result.ok(undefined);
  }

  private async verifyProtectedSignatures(
    expected: ReadonlyMap<string, string>,
  ): Promise<WorkspaceHistoryResult<void>> {
    const actual = await this.captureProtectedSignatures();
    if (actual.status === "error") return actual;
    if (!mapsEqual(expected, actual.value)) {
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
    if (directoryStats.status === "error") return directoryStats;
    if (!directoryStats.value) return Result.ok(undefined);
    if (!directoryStats.value.isDirectory() || directoryStats.value.isSymbolicLink()) {
      return failOwned({
        code: "ownership-mismatch",
        operation: "read snapshot-ref metadata",
        message: "Snapshot-ref metadata path is not an owned directory",
      });
    }
    const metadataPath = this.snapshotRefCreationPath(rootTreeOid);
    const stats = await lstatIfExists(metadataPath);
    if (stats.status === "error") return stats;
    if (!stats.value) return Result.ok(undefined);
    if (!stats.value.isFile() || stats.value.isSymbolicLink()) {
      return failOwned({
        code: "ownership-mismatch",
        operation: "read snapshot-ref metadata",
        message: "Snapshot-ref metadata is not a regular file",
      });
    }
    const serialized = await attemptHost(() => readFile(metadataPath, "utf8"));
    if (serialized.status === "error") return serialized;
    const decoded = this.decodeSnapshotRefCreationMetadata(serialized.value, rootTreeOid, gitRef);
    if (decoded.status === "error") return failWith(decoded.error);
    return Result.ok(decoded.value);
  }

  private async validateSnapshotGraphs(
    rootTreeOids: readonly string[],
  ): Promise<WorkspaceHistoryResult<Map<string, SnapshotGraphValidation>>> {
    const results = new Map<string, SnapshotGraphValidation>();
    const rootTypes = await this.objectTypesUnlocked(rootTreeOids);
    if (rootTypes.status === "error") return rootTypes;
    const enumerated = new Map<string, EnumeratedSnapshotGraph>();
    const descendantOids = new Set<string>();

    for (const rootTreeOid of rootTreeOids) {
      const rootType = rootTypes.value.get(rootTreeOid);
      if (!rootType) {
        results.set(rootTreeOid, { status: "missing" });
        continue;
      }
      if (rootType !== "tree") {
        results.set(rootTreeOid, { status: "corrupt" });
        continue;
      }
      const graph = await this.enumerateSnapshotGraph(rootTreeOid);
      if (graph.status === "error") return graph;
      enumerated.set(rootTreeOid, graph.value);
      for (const entry of graph.value.entries) descendantOids.add(entry.oid);
    }

    const descendantTypes = await this.objectTypesUnlocked(descendantOids);
    if (descendantTypes.status === "error") return descendantTypes;
    for (const [rootTreeOid, graph] of enumerated) {
      let corrupt = graph.corrupt;
      let missing = false;
      const missingTreeOids = new Set<string>();
      for (const entry of graph.entries) {
        const actualType = descendantTypes.value.get(entry.oid);
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
      if (snapshot.status === "error") {
        if (snapshot.error.kind === "owned" && snapshot.error.error.code === "snapshot-invalid") {
          results.set(rootTreeOid, { status: "corrupt" });
          continue;
        }
        return snapshot;
      }
      const validated = this.validateTargetPathSet(snapshot.value.entries);
      if (validated.status === "error") {
        if (validated.error.kind === "owned" && validated.error.error.code === "snapshot-invalid") {
          results.set(rootTreeOid, { status: "corrupt" });
          continue;
        }
        return validated;
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
    if (result.status === "error") return result;
    const entries: EnumeratedSnapshotGraph["entries"] = [];
    let corrupt = false;
    const records = splitNul(result.value.stdout, "validate snapshot graph");
    if (records.status === "error") return records;
    for (const record of records.value) {
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
    return Result.ok({ entries, result: result.value, corrupt });
  }

  private async objectTypeUnlocked(
    oid: string,
  ): Promise<WorkspaceHistoryResult<"blob" | "tree" | "commit" | "tag" | undefined>> {
    const types = await this.objectTypesUnlocked([oid]);
    if (types.status === "error") return types;
    return Result.ok(types.value.get(oid));
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
    if (result.status === "error") return result;
    const output = bytesToText(result.value.stdout, "check private object");
    if (output.status === "error") return output;
    if (!output.value.endsWith("\n")) {
      return failOwned({
        code: "malformed-git-output",
        operation: "check private object",
        message: "Git returned non-terminated object-existence output",
        detail: output.value.slice(0, 200),
      });
    }
    const lines = output.value.slice(0, -1).split("\n");
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
    if (validated.status === "error") return validated;
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
    if (completed.status === "error") return completed;
    const [stdoutBuffer, stderr, exitCode] = completed.value;
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
    if (owned.status === "error") return owned;
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
    if (completed.status === "error") return completed;
    const [stderr, exitCode] = completed.value;
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
    if (decoded.status === "error") {
      return Result.err(
        this.persistenceStoreError(decoded.error, "ownership-mismatch", "verify store ownership"),
      );
    }
    return Result.ok(decoded.value.value);
  }

  private decodeSnapshotManifest(
    serialized: string,
  ): ResultType<WorkspaceHistorySnapshotManifest, WorkspaceHistoryStoreError> {
    const decoded = decodeWorkspaceHistorySnapshotManifest({ serialized });
    if (decoded.status === "error") {
      return Result.err(
        this.persistenceStoreError(decoded.error, "snapshot-invalid", "read snapshot manifest"),
      );
    }
    return Result.ok(decoded.value.value);
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
    if (decoded.status === "error") {
      return Result.err(
        this.persistenceStoreError(decoded.error, "snapshot-invalid", "read durable restore plan"),
      );
    }
    return Result.ok(decoded.value.value);
  }

  private decodeSnapshotRefCreationMetadata(
    serialized: string,
    rootTreeOid: string,
    gitRef: string,
  ): ResultType<WorkspaceHistorySnapshotRefCreated | undefined, WorkspaceHistoryStoreError> {
    const decoded = decodeWorkspaceHistorySnapshotRefCreated({ serialized, rootTreeOid, gitRef });
    if (decoded.status === "error") {
      return Result.err(
        this.persistenceStoreError(decoded.error, "snapshot-invalid", "read snapshot-ref metadata"),
      );
    }
    return Result.ok(decoded.value.value);
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
    if (decoded.status === "error") {
      return Result.err(this.persistenceStoreError(decoded.error, "ownership-mismatch", operation));
    }
    return Result.ok(decoded.value.value);
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
