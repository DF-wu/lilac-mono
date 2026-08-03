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

import { errorCode as nodeErrorCode } from "@stanley2058/lilac-utils";
import { Panic, Result, type Result as ResultType } from "better-result";

import {
  decodeWorkspaceHistoryCaptureCache,
  decodeWorkspaceHistoryOwnership,
  decodeWorkspaceHistoryRestoreOwnership,
  decodeWorkspaceHistoryRestorePlan,
  decodeWorkspaceHistorySnapshotManifest,
  decodeWorkspaceHistorySnapshotRefCreated,
  encodeWorkspaceHistoryRecord,
  WorkspaceHistoryPersistenceCorrupt,
  WorkspaceHistoryPersistenceMalformed,
  WorkspaceHistoryPersistenceUnsupportedVersion,
  WORKSPACE_HISTORY_FORMAT_VERSION,
  WORKSPACE_HISTORY_IMPLEMENTATION_VERSION,
  type WorkspaceHistoryCachedEntry,
  type WorkspaceHistoryCaptureCache,
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

export class WorkspaceHistoryStoreError extends Error {
  readonly code: WorkspaceHistoryErrorCode;
  readonly operation: string;
  readonly detail?: string;
  readonly exitCode?: number;

  constructor(params: {
    code: WorkspaceHistoryErrorCode;
    operation: string;
    message: string;
    detail?: string;
    exitCode?: number;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = "WorkspaceHistoryStoreError";
    this.code = params.code;
    this.operation = params.operation;
    this.detail = params.detail;
    this.exitCode = params.exitCode;
  }
}

export type WorkspaceHistoryCaptureError =
  | WorkspaceHistoryStoreError
  | WorkspaceHistoryPersistenceCodecError;

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

class GitUnavailableSignal extends Error {}

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

function isMissingExecutable(error: unknown): boolean {
  return nodeErrorCode(error) === "ENOENT";
}

function bytesToText(bytes: Uint8Array, operation: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new WorkspaceHistoryStoreError({
      code: "malformed-git-output",
      operation,
      message: `Git returned non-UTF-8 output while ${operation}`,
      cause: error,
    });
  }
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

function parseObjectAccounting(bytes: Uint8Array): WorkspaceHistoryObjectAccounting {
  const operation = "account private Git objects";
  const text = bytesToText(bytes, operation);
  if (!text.endsWith("\n")) {
    throw new WorkspaceHistoryStoreError({
      code: "malformed-git-output",
      operation,
      message: "Git returned non-terminated object accounting output",
    });
  }
  const requiredKeys = [
    "count",
    "size",
    "in-pack",
    "packs",
    "size-pack",
    "prune-packable",
    "garbage",
    "size-garbage",
  ] as const;
  const values = new Map<string, string>();
  for (const line of text.slice(0, -1).split("\n")) {
    const match = /^([a-z-]+): ([0-9]+)$/.exec(line);
    if (!match?.[1] || match[2] === undefined || values.has(match[1])) {
      throw new WorkspaceHistoryStoreError({
        code: "malformed-git-output",
        operation,
        message: "Git returned malformed object accounting output",
        detail: line.slice(0, 200),
      });
    }
    values.set(match[1], match[2]);
  }
  if (values.size !== requiredKeys.length || requiredKeys.some((key) => !values.has(key))) {
    throw new WorkspaceHistoryStoreError({
      code: "malformed-git-output",
      operation,
      message: "Git returned incomplete object accounting output",
    });
  }
  const count = (key: (typeof requiredKeys)[number]): number => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`Missing accounting key ${key}`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new WorkspaceHistoryStoreError({
        code: "malformed-git-output",
        operation,
        message: "Git returned object accounting outside the safe integer range",
        detail: key,
      });
    }
    return parsed;
  };
  const kibibytes = (key: "size" | "size-pack" | "size-garbage"): bigint => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`Missing accounting key ${key}`);
    return BigInt(value) * 1024n;
  };
  return {
    looseObjectCount: count("count"),
    looseObjectBytes: kibibytes("size"),
    inPackObjectCount: count("in-pack"),
    packCount: count("packs"),
    packBytes: kibibytes("size-pack"),
    prunePackableObjectCount: count("prune-packable"),
    garbageObjectCount: count("garbage"),
    garbageBytes: kibibytes("size-garbage"),
  };
}

function parseOid(bytes: Uint8Array, operation: string): string {
  const oid = bytesToText(bytes, operation).trim();
  if (!OID_PATTERN.test(oid)) {
    throw new WorkspaceHistoryStoreError({
      code: "malformed-git-output",
      operation,
      message: `Git returned an invalid object ID while ${operation}`,
      detail: oid.slice(0, 200),
    });
  }
  return oid;
}

function splitNul(bytes: Uint8Array, operation: string): string[] {
  if (bytes.length === 0) return [];
  const text = bytesToText(bytes, operation);
  const values = text.split("\0");
  if (values.at(-1) !== "") {
    throw new WorkspaceHistoryStoreError({
      code: "malformed-git-output",
      operation,
      message: `Git returned non-NUL-terminated output while ${operation}`,
    });
  }
  values.pop();
  return values;
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

function assertSafeRelativePath(relativePath: string, operation: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.startsWith("/") ||
    relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new WorkspaceHistoryStoreError({
      code: "snapshot-invalid",
      operation,
      message: `Snapshot contains an unsafe path: ${JSON.stringify(relativePath)}`,
    });
  }
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type WorkspaceHistoryCaughtFailure =
  | { readonly kind: "panic"; readonly cause: Panic }
  | { readonly kind: "error"; readonly cause: Error }
  | { readonly kind: "hostile"; readonly cause: unknown };

async function preserveWorkspaceHistoryFailureDuringCleanup(
  primary: WorkspaceHistoryCaughtFailure,
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await cleanup();
  } catch (cleanupFailure) {
    if (primary.kind === "panic") throw primary.cause;
    if (Panic.is(cleanupFailure)) throw cleanupFailure;
    throw new AggregateError(
      [primary.cause, cleanupFailure],
      "Workspace history operation and cleanup both failed",
    );
  }
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

async function lstatIfExists(targetPath: string, bigint: true): Promise<BigIntStats | undefined>;
async function lstatIfExists(targetPath: string, bigint?: false): Promise<Stats | undefined>;
async function lstatIfExists(
  targetPath: string,
  bigint = false,
): Promise<BigIntStats | Stats | undefined> {
  try {
    return bigint ? await lstat(targetPath, { bigint: true }) : await lstat(targetPath);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
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
    if (!SAFE_ID_PATTERN.test(options.workspaceId)) {
      throw new WorkspaceHistoryStoreError({
        code: "workspace-invalid",
        operation: "construct store",
        message: "workspaceId must be an opaque 1-128 character ASCII identifier",
      });
    }
    if (options.namespaceId.length === 0 || options.databasePathHash.length === 0) {
      throw new WorkspaceHistoryStoreError({
        code: "workspace-invalid",
        operation: "construct store",
        message: "namespaceId and databasePathHash must be non-empty",
      });
    }

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

  async capability(): Promise<WorkspaceHistoryCapability> {
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
      return { status: "unavailable", reason: "platform-unsupported" };
    }
    try {
      const version = await this.probeGit();
      return { status: "available", gitVersion: version, pathComparison: this.pathComparison };
    } catch (error) {
      if (error instanceof GitUnavailableSignal) {
        this.emitMetric({
          type: "capability-unavailable",
          workspaceId: this.workspaceId,
          reason: "git-unavailable",
          durationMs: performance.now() - startedAt,
          candidatePathCount: 0,
          managedPathCount: 0,
          payloadBytes: 0n,
        });
        return { status: "unavailable", reason: "git-unavailable" };
      }
      throw error;
    }
  }

  capabilityResult(): Promise<ResultType<WorkspaceHistoryCapability, WorkspaceHistoryStoreError>> {
    return this.capturePublicResult("probe workspace history capability", () => this.capability());
  }

  async withWorkspaceLock<T>(
    callback: (lockedStore: LockedWorkspaceHistoryStore) => Promise<T>,
  ): Promise<T> {
    return await withStoreLock(this.storeDirectory, async () => {
      let active = true;
      let lastCapture: WorkspaceHistoryCaptureResult | undefined;
      const preparedPlans = new Set<PreparedRestoreData>();
      const assertActive = (): void => {
        if (!active) {
          throw new WorkspaceHistoryStoreError({
            code: "workspace-invalid",
            operation: "use workspace history lock",
            message: "Workspace history lock lease is no longer active",
          });
        }
      };
      const captureResult = async (): Promise<
        ResultType<WorkspaceHistoryCaptureResult, WorkspaceHistoryCaptureError>
      > => {
        assertActive();
        const captured = await this.captureLockedResult();
        if (captured.status === "ok") lastCapture = captured.value;
        return captured;
      };
      const lockedStore: LockedWorkspaceHistoryStore = {
        captureResult,
        invalidateCaptureCacheResult: async () => {
          assertActive();
          return await this.invalidateCaptureCacheResult();
        },
        capture: async () => {
          const captured = await captureResult();
          if (captured.status === "error") throw captured.error;
          return captured.value;
        },
        prepareRestore: async (rootTreeOid, expectedCurrent, operationId) => {
          assertActive();
          let boundCurrent = expectedCurrent;
          if (boundCurrent === undefined && lastCapture?.status === "captured") {
            boundCurrent = { status: "captured", rootTreeOid: lastCapture.rootTreeOid };
          } else if (boundCurrent === undefined && lastCapture?.status === "skipped") {
            boundCurrent = { status: "unavailable", reason: lastCapture.reason };
          }
          return await this.prepareRestoreLocked(
            rootTreeOid,
            boundCurrent,
            assertActive,
            preparedPlans,
            operationId,
          );
        },
        resumePreparedRestore: async (input) => {
          assertActive();
          return await this.resumePreparedRestoreLocked(input, assertActive, preparedPlans);
        },
      };
      let callbackOutcome:
        | { status: "ok"; value: T }
        | { status: "error"; failure: WorkspaceHistoryCaughtFailure };
      try {
        callbackOutcome = { status: "ok", value: await callback(lockedStore) };
      } catch (cause) {
        if (Panic.is(cause)) {
          callbackOutcome = { status: "error", failure: { kind: "panic", cause } };
        } else if (cause instanceof Error) {
          callbackOutcome = { status: "error", failure: { kind: "error", cause } };
        } else {
          callbackOutcome = { status: "error", failure: { kind: "hostile", cause } };
        }
      }
      active = false;
      const cleanupFailures: WorkspaceHistoryCaughtFailure[] = [];
      for (const plan of preparedPlans) {
        try {
          await this.disposePreparedRestore(plan);
        } catch (cause) {
          if (Panic.is(cause)) {
            cleanupFailures.push({ kind: "panic", cause });
          } else if (cause instanceof Error) {
            cleanupFailures.push({ kind: "error", cause });
          } else {
            cleanupFailures.push({ kind: "hostile", cause });
          }
        }
      }
      if (cleanupFailures.length > 0) {
        if (callbackOutcome.status === "error" && callbackOutcome.failure.kind === "panic") {
          throw callbackOutcome.failure.cause;
        }
        const cleanupPanic = cleanupFailures.find((failure) => failure.kind === "panic");
        if (cleanupPanic !== undefined) throw cleanupPanic.cause;
        const cleanupFailure =
          cleanupFailures.length === 1
            ? cleanupFailures[0]!.cause
            : new AggregateError(
                cleanupFailures.map((failure) => failure.cause),
                "Multiple workspace restore cleanups failed",
              );
        if (callbackOutcome.status === "error") {
          throw new AggregateError(
            [callbackOutcome.failure.cause, cleanupFailure],
            "Workspace history operation and cleanup both failed",
          );
        }
        throw cleanupFailure;
      }
      if (callbackOutcome.status === "error") throw callbackOutcome.failure.cause;
      return callbackOutcome.value;
    });
  }

  async capture(): Promise<WorkspaceHistoryCaptureResult> {
    return await this.withWorkspaceLock(async (lockedStore) => await lockedStore.capture());
  }

  captureResult(): Promise<
    ResultType<WorkspaceHistoryCaptureResult, WorkspaceHistoryCaptureError>
  > {
    return this.withWorkspaceLock(async (lockedStore) => await lockedStore.captureResult());
  }

  private async captureLockedResult(): Promise<
    ResultType<WorkspaceHistoryCaptureResult, WorkspaceHistoryCaptureError>
  > {
    try {
      return Result.ok(await this.captureLocked());
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      if (
        cause instanceof WorkspaceHistoryPersistenceUnsupportedVersion ||
        cause instanceof WorkspaceHistoryPersistenceMalformed ||
        cause instanceof WorkspaceHistoryPersistenceCorrupt ||
        cause instanceof WorkspaceHistoryStoreError
      ) {
        return Result.err(cause);
      }
      if (cause instanceof Error) {
        return Result.err(this.withContext(cause, "capture workspace"));
      }
      throw cause;
    }
  }

  private async captureLocked(): Promise<WorkspaceHistoryCaptureResult> {
    const startedAt = performance.now();
    const observation: CaptureMetricObservation = {
      candidatePathCount: 0,
      managedPathCount: 0,
      payloadBytes: 0n,
      changed: false,
    };
    try {
      const capability = await this.capability();
      if (capability.status === "unavailable") {
        this.emitCaptureMetric(startedAt, observation, "skipped");
        return { status: "skipped", reason: capability.reason };
      }
      const sourceRepository = await this.discoverSourceRepository();
      if (!sourceRepository) {
        this.emitCaptureMetric(startedAt, observation, "skipped");
        return { status: "skipped", reason: "non-git-workspace" };
      }
      await this.ensureStore();
      const classified = await this.classifyWorkspaceForCapture(sourceRepository.root);
      observation.candidatePathCount = classified.entries.size + classified.directories.size;
      observation.managedPathCount = classified.managed.size;
      const result = await this.captureClassifiedWorkspace(classified, observation);
      this.emitCaptureMetric(startedAt, observation, "captured");
      return result;
    } catch (error) {
      if (error instanceof GitUnavailableSignal) {
        this.emitCaptureMetric(startedAt, observation, "skipped");
        return { status: "skipped", reason: "git-unavailable" };
      }
      this.emitCaptureMetric(startedAt, observation, "failed");
      if (
        error instanceof WorkspaceHistoryPersistenceUnsupportedVersion ||
        error instanceof WorkspaceHistoryPersistenceMalformed ||
        error instanceof WorkspaceHistoryPersistenceCorrupt
      ) {
        throw error;
      }
      throw this.withContext(error, "capture workspace");
    }
  }

  private async captureClassifiedWorkspace(
    classified: ClassifiedWorkspace,
    metric?: CaptureMetricObservation,
  ): Promise<Extract<WorkspaceHistoryCaptureResult, { status: "captured" }>> {
    const cacheRead = await this.readCaptureCache();
    if (cacheRead.status === "error") throw cacheRead.error;
    const cache = cacheRead.value;
    const cachedOids = new Set<string>();
    for (const [relativePath, entry] of classified.managed) {
      if (entry.kind === "special") {
        throw new WorkspaceHistoryStoreError({
          code: "workspace-invalid",
          operation: "capture workspace",
          message: `Unsupported managed special file: ${relativePath}`,
        });
      }
      const cached = cache?.entries[relativePath];
      if (cached && sameStat(entry, cached)) cachedOids.add(cached.oid);
    }
    const existingCachedOids = await this.existingObjects(cachedOids, "blob");
    const treeEntries: TreeEntry[] = [];
    const nextCacheEntries: Record<string, WorkspaceHistoryCachedEntry> = {};

    for (const relativePath of [...classified.managed.keys()].sort()) {
      const entry = classified.managed.get(relativePath);
      if (!entry) continue;
      if (entry.kind === "special") {
        throw new WorkspaceHistoryStoreError({
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
        const target = await readlink(entry.absolutePath, { encoding: "buffer" });
        if (metric) metric.payloadBytes += BigInt(target.byteLength);
        oid = await this.hashBytes(target, true);
      } else {
        this.onCaptureRegularFilePayload?.(relativePath, BigInt(entry.size));
        if (metric) metric.payloadBytes += BigInt(entry.size);
        oid = await this.hashFile(entry.absolutePath, true);
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

    this.validateTargetPathSet(new Map(treeEntries.map((entry) => [entry.relativePath, entry])));

    const workspaceTreeOid = await this.writeCaptureTree(treeEntries, cache);
    const manifestBytes = canonicalJson({
      formatVersion: FORMAT_VERSION,
      implementationVersion: IMPLEMENTATION_VERSION,
      managedRoot: ".",
      emptyDirectories: "excluded",
      platform: this.platform,
      pathComparison: this.pathComparison,
    });
    const manifestBlobOid = await this.hashBytes(manifestBytes, true);
    const rootTreeOid = await this.writeWrapperTree(workspaceTreeOid, manifestBlobOid);
    await this.requireObject(rootTreeOid, "tree", "verify captured wrapper tree");
    const gitRef = this.snapshotRef(rootTreeOid);
    const existingRefTarget = (await this.listSnapshotRefsUnlocked()).get(gitRef);
    if (metric) metric.changed = existingRefTarget !== rootTreeOid;
    if (existingRefTarget === rootTreeOid) {
      await this.ensureSnapshotRefCreationMetadata(rootTreeOid, gitRef, true);
    } else {
      await this.ensureSnapshotRefCreationMetadata(rootTreeOid, gitRef, false);
      await this.afterSnapshotRefMetadataWriteBeforeRef?.(rootTreeOid);
      await this.runPrivateGit(["update-ref", gitRef, rootTreeOid], {
        operation: "root captured snapshot",
      });
      await this.afterSnapshotRefPublication?.(rootTreeOid);
    }
    await this.writeCaptureCache({
      implementationVersion: IMPLEMENTATION_VERSION,
      indexVersion: 1,
      workspaceId: this.workspaceId,
      canonicalCwd: this.cwd,
      pathComparison: this.pathComparison,
      workspaceTreeOid,
      entries: nextCacheEntries,
    });
    return {
      status: "captured",
      workspaceId: this.workspaceId,
      rootTreeOid,
      workspaceTreeOid,
      manifestBlobOid,
      gitRef,
      formatVersion: FORMAT_VERSION,
      managedPathCount: treeEntries.length,
    };
  }

  private async reconcileCaptureStateAfterRestore(
    snapshot: ParsedSnapshot,
    verifiedTargetEntries: ReadonlyMap<string, ScannedEntry>,
  ): Promise<void> {
    const classified = await this.classifyWorkspace();
    const cacheRead = await this.readCaptureCache();
    if (cacheRead.status === "error") throw cacheRead.error;
    const cache = cacheRead.value;
    const treeEntries: TreeEntry[] = [];
    const nextCacheEntries: Record<string, WorkspaceHistoryCachedEntry> = {};
    for (const relativePath of [...classified.managed.keys()].sort()) {
      const classifiedEntry = classified.managed.get(relativePath);
      if (!classifiedEntry) continue;
      const before = await this.readLiveEntry(relativePath, classifiedEntry.absolutePath);
      if (!before || !sameScannedFingerprint(classifiedEntry, before)) {
        throw this.restoreConflict(
          `Managed path changed before post-restore cache reconciliation: ${relativePath}`,
        );
      }
      if (before.kind === "special") {
        throw new WorkspaceHistoryStoreError({
          code: "workspace-invalid",
          operation: "reconcile post-restore capture state",
          message: `Unsupported managed special file: ${relativePath}`,
        });
      }
      const target = snapshot.entries.get(relativePath);
      const verifiedTarget = target ? verifiedTargetEntries.get(relativePath) : undefined;
      if (target && (!verifiedTarget || !sameScannedFingerprint(verifiedTarget, before))) {
        throw this.restoreConflict(`Target path changed after final verification: ${relativePath}`);
      }
      let oid: string;
      if (before.kind === "symlink") {
        oid = await this.hashBytes(
          await readlink(before.absolutePath, { encoding: "buffer" }),
          target === undefined,
        );
      } else {
        if (!target) {
          this.onCaptureRegularFilePayload?.(relativePath, BigInt(before.size));
        }
        oid = await this.hashFile(before.absolutePath, target === undefined);
      }
      const after = await this.readLiveEntry(relativePath, before.absolutePath);
      if (!after || !sameScannedFingerprint(before, after)) {
        throw this.restoreConflict(
          `Managed path changed during post-restore cache reconciliation: ${relativePath}`,
        );
      }
      if (after.kind === "special") {
        throw this.restoreConflict(
          `Managed path became a special file during cache reconciliation: ${relativePath}`,
        );
      }
      if (target && (after.mode !== target.mode || oid !== target.oid)) {
        throw this.verificationError(
          `Target path changed before post-restore cache reconciliation: ${relativePath}`,
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
    this.validateTargetPathSet(new Map(treeEntries.map((entry) => [entry.relativePath, entry])));
    const workspaceTreeOid = await this.writeCaptureTree(treeEntries, cache);
    await this.writeCaptureCache({
      implementationVersion: IMPLEMENTATION_VERSION,
      indexVersion: 1,
      workspaceId: this.workspaceId,
      canonicalCwd: this.cwd,
      pathComparison: this.pathComparison,
      workspaceTreeOid,
      entries: nextCacheEntries,
    });
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

  restoreResult(
    rootTreeOid: string,
    expectedCurrent?: WorkspaceHistoryExpectedCurrent,
  ): Promise<ResultType<WorkspaceHistoryRestoreResult, WorkspaceHistoryStoreError>> {
    return this.capturePublicResult("restore workspace", () =>
      this.restore(rootTreeOid, expectedCurrent),
    );
  }

  async resumeRestore(
    input: WorkspaceHistoryResumeRestoreInput,
  ): Promise<WorkspaceHistoryRestoreResult> {
    return await this.withWorkspaceLock(async (lockedStore) => {
      if (!lockedStore.resumePreparedRestore) {
        throw new WorkspaceHistoryStoreError({
          code: "workspace-invalid",
          operation: "resume prepared workspace restore",
          message: "Locked workspace store does not support durable restore resumption",
        });
      }
      const prepared = await lockedStore.resumePreparedRestore(input);
      if (prepared.status === "skipped") return prepared;
      return await prepared.plan.apply();
    });
  }

  resumeRestoreResult(
    input: WorkspaceHistoryResumeRestoreInput,
  ): Promise<ResultType<WorkspaceHistoryRestoreResult, WorkspaceHistoryStoreError>> {
    return this.capturePublicResult("resume prepared workspace restore", () =>
      this.resumeRestore(input),
    );
  }

  async deleteRestorePlan(operationId: string): Promise<void> {
    this.validateOperationId(operationId, "delete restore plan");
    await withStoreLock(this.storeDirectory, async () => {
      if (!(await this.verifyExistingStoreOwnership())) return;
      const planStats = await lstatIfExists(this.restorePlanPath(operationId));
      const manifest = planStats ? await this.readRestorePlanManifest(operationId) : undefined;
      if (manifest) await this.cleanupRestorePlanStaging(manifest);
      await rm(this.restorePlanPath(operationId), { force: true });
      await this.fsyncDirectory(this.restorePlanDirectory);
    });
  }

  deleteRestorePlanResult(
    operationId: string,
  ): Promise<ResultType<void, WorkspaceHistoryStoreError>> {
    return this.capturePublicResult("delete restore plan", () =>
      this.deleteRestorePlan(operationId),
    );
  }

  async cleanupRestorePlans(
    activeOperationIds: readonly string[],
    gracePeriodMs: number,
  ): Promise<WorkspaceHistoryRestorePlanCleanupResult> {
    if (!Number.isFinite(gracePeriodMs) || gracePeriodMs < 0) {
      throw new WorkspaceHistoryStoreError({
        code: "workspace-invalid",
        operation: "clean restore plans",
        message: "Restore-plan cleanup grace period must be a non-negative finite number",
      });
    }
    const active = new Set(
      activeOperationIds.map((operationId) => {
        this.validateOperationId(operationId, "clean restore plans");
        return operationId;
      }),
    );
    return await withStoreLock(this.storeDirectory, async () => {
      if (!(await this.verifyExistingStoreOwnership())) {
        return { removedOperationIds: [], preservedOperationIds: [] };
      }
      const directoryStats = await lstatIfExists(this.restorePlanDirectory);
      if (!directoryStats || !directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
        return { removedOperationIds: [], preservedOperationIds: [] };
      }
      const removedOperationIds: string[] = [];
      const preservedOperationIds: string[] = [];
      const cutoff = this.now() - gracePeriodMs;
      for (const child of await readdir(this.restorePlanDirectory, { withFileTypes: true })) {
        const match = /^([A-Za-z0-9_-]{1,128})\.json$/.exec(child.name);
        if (!match?.[1] || !child.isFile() || child.isSymbolicLink()) continue;
        const operationId = match[1];
        const manifest = await this.readRestorePlanManifest(operationId);
        if (active.has(operationId) || manifest.createdAtMs >= cutoff) {
          preservedOperationIds.push(operationId);
          continue;
        }
        await this.cleanupRestorePlanStaging(manifest);
        await rm(this.restorePlanPath(operationId));
        removedOperationIds.push(operationId);
      }
      if (removedOperationIds.length > 0) await this.fsyncDirectory(this.restorePlanDirectory);
      return {
        removedOperationIds: removedOperationIds.sort(),
        preservedOperationIds: preservedOperationIds.sort(),
      };
    });
  }

  cleanupRestorePlansResult(
    activeOperationIds: readonly string[],
    gracePeriodMs: number,
  ): Promise<ResultType<WorkspaceHistoryRestorePlanCleanupResult, WorkspaceHistoryStoreError>> {
    return this.capturePublicResult("clean restore plans", () =>
      this.cleanupRestorePlans(activeOperationIds, gracePeriodMs),
    );
  }

  async verifySnapshot(rootTreeOid: string): Promise<WorkspaceHistoryVerifyResult> {
    const startedAt = performance.now();
    let managedPathCount = 0;
    try {
      const capability = await this.capability();
      if (capability.status === "unavailable") {
        this.emitVerifyMetric(startedAt, 0, 0n, "skipped");
        return { status: "skipped", reason: capability.reason };
      }
      if (!(await this.discoverSourceRepository())) {
        this.emitVerifyMetric(startedAt, 0, 0n, "skipped");
        return { status: "skipped", reason: "non-git-workspace" };
      }
      if (!OID_PATTERN.test(rootTreeOid)) {
        throw new WorkspaceHistoryStoreError({
          code: "snapshot-invalid",
          operation: "verify workspace snapshot",
          message: "Snapshot root is not a valid Git object ID",
        });
      }
      return await withStoreLock(this.storeDirectory, async () => {
        await this.ensureStore();
        const snapshot = await this.readSnapshot(rootTreeOid);
        managedPathCount = snapshot.entries.size;
        const verified = await this.verifyTargetSnapshot(snapshot);
        const payloadBytes = [...verified.values()].reduce(
          (total, entry) => total + BigInt(entry.size),
          0n,
        );
        this.emitVerifyMetric(startedAt, managedPathCount, payloadBytes, "verified");
        return { status: "verified" };
      });
    } catch (error) {
      this.emitVerifyMetric(startedAt, managedPathCount, 0n, "failed");
      this.emitVerificationFailure(startedAt, "verify", managedPathCount, error);
      throw error;
    }
  }

  verifySnapshotResult(
    rootTreeOid: string,
  ): Promise<ResultType<WorkspaceHistoryVerifyResult, WorkspaceHistoryStoreError>> {
    return this.capturePublicResult("verify workspace snapshot", () =>
      this.verifySnapshot(rootTreeOid),
    );
  }

  private async prepareRestoreLocked(
    rootTreeOid: string,
    expectedCurrent: WorkspaceHistoryExpectedCurrent | undefined,
    assertActive: () => void,
    preparedPlans: Set<PreparedRestoreData>,
    operationId: string | undefined,
  ): Promise<WorkspaceHistoryPrepareRestoreResult> {
    const metricStartedAt = performance.now();
    let candidatePathCount = 0;
    let managedPathCount = 0;
    let materializedBytes = 0n;
    if (
      expectedCurrent?.status === "unavailable" &&
      (expectedCurrent.reason === "git-unavailable" ||
        expectedCurrent.reason === "non-git-workspace" ||
        expectedCurrent.reason === "platform-unsupported")
    ) {
      this.emitRestoreMetric(metricStartedAt, 0, 0, 0n, false, "skipped");
      return { status: "skipped", reason: expectedCurrent.reason };
    }
    const capability = await this.capability();
    if (capability.status === "unavailable") {
      this.emitRestoreMetric(metricStartedAt, 0, 0, 0n, false, "skipped");
      return { status: "skipped", reason: capability.reason };
    }
    if (!(await this.discoverSourceRepository())) {
      this.emitRestoreMetric(metricStartedAt, 0, 0, 0n, false, "skipped");
      return { status: "skipped", reason: "non-git-workspace" };
    }
    if (!OID_PATTERN.test(rootTreeOid)) {
      throw new WorkspaceHistoryStoreError({
        code: "snapshot-invalid",
        operation: "prepare workspace restore",
        message: "Snapshot root is not a valid Git object ID",
      });
    }
    if (operationId !== undefined) {
      this.validateOperationId(operationId, "prepare workspace restore");
    }

    try {
      await this.ensureStore();
      if (expectedCurrent?.status === "unavailable") {
        throw this.restoreConflict(
          `Cannot bind restore preflight to unavailable current workspace: ${expectedCurrent.reason}`,
        );
      }
      const current = await this.classifyWorkspace();
      candidatePathCount = current.entries.size + current.directories.size;
      const capturedCurrent = await this.captureClassifiedWorkspace(current);
      if (expectedCurrent?.status === "captured") {
        if (capturedCurrent.rootTreeOid !== expectedCurrent.rootTreeOid) {
          throw this.restoreConflict(
            `Workspace changed since source capture: expected ${expectedCurrent.rootTreeOid}, captured ${capturedCurrent.rootTreeOid}`,
          );
        }
      }
      await this.afterBoundSourceCapture?.();
      const snapshot = await this.readSnapshot(rootTreeOid);
      managedPathCount = snapshot.entries.size;
      this.validateTargetPathSet(snapshot.entries);
      const targetBlobOids = new Set([...snapshot.entries.values()].map((entry) => entry.oid));
      const existingTargetBlobs = await this.existingObjects(targetBlobOids, "blob");
      if (existingTargetBlobs.size !== targetBlobOids.size) {
        throw new WorkspaceHistoryStoreError({
          code: "snapshot-invalid",
          operation: "preflight workspace restore",
          message: "Snapshot references one or more missing blob objects",
        });
      }
      const preservation = await this.captureUnmanagedSignatures(current);
      const protectedSignatures = await this.captureProtectedSignatures();
      await this.preflightRestore(current, snapshot.entries);
      materializedBytes = await this.preflightDestinationCapabilities(snapshot, (bytes) => {
        materializedBytes = bytes;
      });
      const liveSignatures = await this.captureLiveSignatures(current);
      const workspaceIdentity = await this.workspaceIdentity();
      const finalCurrent = await this.classifyWorkspace();
      const finalCapture = await this.captureClassifiedWorkspace(finalCurrent);
      const finalSignatures = await this.captureLiveSignatures(finalCurrent);
      if (
        finalCapture.rootTreeOid !== capturedCurrent.rootTreeOid ||
        !mapsEqual(finalSignatures, liveSignatures) ||
        !setsEqual(new Set(finalCurrent.managed.keys()), new Set(current.managed.keys())) ||
        !setsEqual(finalCurrent.ignored, current.ignored) ||
        !setsEqual(finalCurrent.boundaryRoots, current.boundaryRoots)
      ) {
        throw this.restoreConflict("Workspace changed while restore preparation was running");
      }
      const { stagingDirectory, stagedEntries } = await this.stageSnapshot(snapshot);
      if (operationId) {
        const sourceSnapshot = await this.readSnapshot(capturedCurrent.rootTreeOid);
        const managedSignatures = new Map<string, string>();
        for (const relativePath of current.managed.keys()) {
          const signature = liveSignatures.get(relativePath);
          if (!signature) {
            throw this.restoreConflict(
              `Managed signature disappeared before plan freeze: ${relativePath}`,
            );
          }
          managedSignatures.set(relativePath, signature);
        }
        if (!setsEqual(new Set(sourceSnapshot.entries.keys()), new Set(managedSignatures.keys()))) {
          throw this.restoreConflict(
            "Captured source entries do not match frozen managed membership",
          );
        }
        await this.writeRestorePlanManifest({
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
        });
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
        candidatePathCount,
        managedPathCount,
        materializedBytes,
        state: "prepared",
      };
      preparedPlans.add(data);
      const plan: PreparedWorkspaceRestore = {
        rootTreeOid,
        operationId,
        apply: async () => {
          assertActive();
          const result = await this.applyPreparedRestore(data);
          preparedPlans.delete(data);
          return result;
        },
        verify: async () => {
          assertActive();
          await this.verifyTargetSnapshot(snapshot);
          return { status: "verified" };
        },
        dispose: async () => {
          assertActive();
          preparedPlans.delete(data);
          await this.disposePreparedRestore(data);
        },
      };
      return { status: "prepared", plan };
    } catch (error) {
      if (error instanceof GitUnavailableSignal) {
        this.emitRestoreMetric(
          metricStartedAt,
          candidatePathCount,
          managedPathCount,
          materializedBytes,
          false,
          "skipped",
        );
        return { status: "skipped", reason: "git-unavailable" };
      }
      this.emitRestoreMetric(
        metricStartedAt,
        candidatePathCount,
        managedPathCount,
        materializedBytes,
        false,
        "failed",
      );
      this.emitVerificationFailure(metricStartedAt, "restore", managedPathCount, error);
      throw this.withContext(error, "prepare workspace restore");
    }
  }

  private async resumePreparedRestoreLocked(
    input: WorkspaceHistoryResumeRestoreInput,
    assertActive: () => void,
    preparedPlans: Set<PreparedRestoreData>,
  ): Promise<WorkspaceHistoryPrepareRestoreResult> {
    const metricStartedAt = performance.now();
    let materializedBytes = 0n;
    this.validateOperationId(input.operationId, "resume prepared workspace restore");
    if (!OID_PATTERN.test(input.targetRootTreeOid) || !OID_PATTERN.test(input.sourceRootTreeOid)) {
      throw new WorkspaceHistoryStoreError({
        code: "snapshot-invalid",
        operation: "resume prepared workspace restore",
        message: "Expected source and target roots must be valid Git object IDs",
      });
    }
    const capability = await this.capability();
    if (capability.status === "unavailable") {
      this.emitRestoreMetric(metricStartedAt, 0, 0, 0n, false, "skipped");
      return { status: "skipped", reason: capability.reason };
    }
    if (!(await this.discoverSourceRepository())) {
      this.emitRestoreMetric(metricStartedAt, 0, 0, 0n, false, "skipped");
      return { status: "skipped", reason: "non-git-workspace" };
    }
    try {
      await this.ensureStore();
      let manifest = await this.readRestorePlanManifest(input.operationId);
      if (
        manifest.sourceRootTreeOid !== input.sourceRootTreeOid ||
        manifest.targetRootTreeOid !== input.targetRootTreeOid
      ) {
        throw this.restoreConflict(
          "Durable restore plan does not match expected source and target",
        );
      }
      if ((await this.workspaceIdentity()) !== manifest.workspaceIdentity) {
        throw this.restoreConflict("Workspace root identity changed since restore preparation");
      }
      const [source, snapshot] = await Promise.all([
        this.readSnapshot(input.sourceRootTreeOid),
        this.readSnapshot(input.targetRootTreeOid),
      ]);
      if (
        !treeEntryArraysEqual([...source.entries.values()], manifest.managedEntries) ||
        !treeEntryArraysEqual([...snapshot.entries.values()], manifest.targetEntries)
      ) {
        throw new WorkspaceHistoryStoreError({
          code: "snapshot-invalid",
          operation: "resume prepared workspace restore",
          message: "Durable restore plan entries no longer match private snapshot objects",
        });
      }
      if (manifest.phase === "prepared") {
        await this.assertFrozenSourceIntact(manifest);
      }
      materializedBytes = await this.preflightDestinationCapabilities(snapshot, (bytes) => {
        materializedBytes = bytes;
      });
      if (manifest.phase === "prepared") {
        manifest = {
          ...manifest,
          phase: "mutation-ready",
          protectedSignatures: this.signatureRecords(await this.captureProtectedSignatures()),
        };
        await this.writeRestorePlanManifest(manifest);
      }
      const managedSignatures = this.signatureMap(manifest.managedSignatures);
      const managed = new Map<string, ScannedEntry>();
      for (const entry of manifest.managedEntries) {
        managed.set(entry.relativePath, this.frozenScannedEntry(entry));
      }
      if (!setsEqual(new Set(managed.keys()), new Set(managedSignatures.keys()))) {
        throw new WorkspaceHistoryStoreError({
          code: "snapshot-invalid",
          operation: "resume prepared workspace restore",
          message: "Durable restore plan has inconsistent managed membership",
        });
      }
      const current: ClassifiedWorkspace = {
        entries: new Map(managed),
        managed,
        directories: new Set(),
        ignored: new Set(manifest.ignoredSignatures.map((entry) => entry.relativePath)),
        ignoredDirectories: new Set(),
        boundaryRoots: new Set(manifest.boundaryRoots),
      };
      await this.cleanupRestorePlanStaging(manifest);
      const { stagingDirectory, stagedEntries } = await this.stageSnapshot(snapshot);
      if (manifest.privateStagingDirectory !== stagingDirectory) {
        await this.writeRestorePlanManifest({
          ...manifest,
          privateStagingDirectory: stagingDirectory,
        });
      }
      const data: PreparedRestoreData = {
        snapshot,
        current,
        liveSignatures: new Map([
          ...managedSignatures,
          ...this.signatureMap(manifest.ignoredSignatures),
        ]),
        preservation: this.signatureMap(manifest.ignoredSignatures),
        protectedSignatures: this.signatureMap(manifest.protectedSignatures),
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
        materializedBytes,
        state: "prepared",
      };
      preparedPlans.add(data);
      const plan: PreparedWorkspaceRestore = {
        rootTreeOid: snapshot.rootTreeOid,
        operationId: manifest.operationId,
        apply: async () => {
          assertActive();
          const result = await this.applyPreparedRestore(data);
          preparedPlans.delete(data);
          return result;
        },
        verify: async () => {
          assertActive();
          await this.verifyFrozenRestoredSnapshot(data);
          return { status: "verified" };
        },
        dispose: async () => {
          assertActive();
          preparedPlans.delete(data);
          await this.disposePreparedRestore(data);
        },
      };
      return { status: "prepared", plan };
    } catch (error) {
      if (error instanceof GitUnavailableSignal) {
        this.emitRestoreMetric(metricStartedAt, 0, 0, materializedBytes, false, "skipped");
        return { status: "skipped", reason: "git-unavailable" };
      }
      this.emitRestoreMetric(metricStartedAt, 0, 0, materializedBytes, false, "failed");
      this.emitVerificationFailure(metricStartedAt, "restore", 0, error);
      throw this.withContext(error, "resume prepared workspace restore");
    }
  }

  async objectExists(oid: string, type: "blob" | "tree" | "object" = "object"): Promise<boolean> {
    if (!OID_PATTERN.test(oid)) return false;
    const capability = await this.capability();
    if (capability.status === "unavailable") {
      throw new WorkspaceHistoryStoreError({
        code: capability.reason,
        operation: "check private object",
        message: `Cannot check private object: ${capability.reason}`,
      });
    }
    try {
      return await withStoreLock(this.storeDirectory, async () => {
        await this.ensureStore();
        return await this.objectExistsUnlocked(oid, type);
      });
    } catch (error) {
      if (error instanceof GitUnavailableSignal) {
        throw new WorkspaceHistoryStoreError({
          code: "git-unavailable",
          operation: "check private object",
          message: "Git became unavailable while checking private object",
          cause: error,
        });
      }
      throw error;
    }
  }

  objectExistsResult(
    oid: string,
    type: "blob" | "tree" | "object" = "object",
  ): Promise<ResultType<boolean, WorkspaceHistoryStoreError>> {
    return this.capturePublicResult("check private object", () => this.objectExists(oid, type));
  }

  async reconcileSnapshotRef(
    rootTreeOid: string,
  ): Promise<
    "present" | "repaired" | "missing" | "corrupt" | "git-unavailable" | "platform-unsupported"
  > {
    if (!OID_PATTERN.test(rootTreeOid)) return "missing";
    const reconciliation = await this.reconcileExpectedSnapshotRefs([rootTreeOid]);
    if (reconciliation.status === "unavailable") return reconciliation.reason;
    return reconciliation.expected[0]?.status ?? "missing";
  }

  reconcileSnapshotRefResult(
    rootTreeOid: string,
  ): Promise<
    ResultType<
      "present" | "repaired" | "missing" | "corrupt" | "git-unavailable" | "platform-unsupported",
      WorkspaceHistoryStoreError
    >
  > {
    return this.capturePublicResult("reconcile snapshot ref", () =>
      this.reconcileSnapshotRef(rootTreeOid),
    );
  }

  async reconcileExpectedSnapshotRefs(
    expectedRootTreeOids: readonly string[],
  ): Promise<WorkspaceHistoryRefReconciliation> {
    const uniqueExpected = this.validateExpectedRootTreeOids(expectedRootTreeOids);
    try {
      return await withStoreLock(this.storeDirectory, async () => {
        if (!(await this.verifyExistingStoreOwnership())) {
          return this.missingReconciliation(uniqueExpected);
        }
        const capability = await this.capability();
        if (capability.status === "unavailable") return capability;
        return await this.reconcileExpectedSnapshotRefsUnlocked(uniqueExpected);
      });
    } catch (error) {
      if (error instanceof GitUnavailableSignal) {
        return { status: "unavailable", reason: "git-unavailable" };
      }
      throw error;
    }
  }

  reconcileExpectedSnapshotRefsResult(
    expectedRootTreeOids: readonly string[],
  ): Promise<ResultType<WorkspaceHistoryRefReconciliation, WorkspaceHistoryStoreError>> {
    return this.capturePublicResult("reconcile expected snapshot refs", () =>
      this.reconcileExpectedSnapshotRefs(expectedRootTreeOids),
    );
  }

  async cleanupOrphanSnapshotRefs(
    expectedRootTreeOids: readonly string[],
    gracePeriodMs: number,
  ): Promise<WorkspaceHistoryOrphanCleanupResult> {
    if (!Number.isFinite(gracePeriodMs) || gracePeriodMs < 0) {
      throw new WorkspaceHistoryStoreError({
        code: "workspace-invalid",
        operation: "clean orphan snapshot refs",
        message: "Snapshot-ref cleanup grace period must be a non-negative finite number",
      });
    }
    const uniqueExpected = this.validateExpectedRootTreeOids(expectedRootTreeOids);
    try {
      return await withStoreLock(this.storeDirectory, async () => {
        if (!(await this.verifyExistingStoreOwnership())) {
          return {
            status: "cleaned" as const,
            expected: [...uniqueExpected].map((rootTreeOid) => ({
              rootTreeOid,
              gitRef: this.snapshotRef(rootTreeOid),
              status: "missing" as const,
            })),
            removedOrphanRefs: [],
            preservedOrphanRefs: [],
          };
        }
        const capability = await this.capability();
        if (capability.status === "unavailable") return capability;
        return await this.cleanupOrphanSnapshotRefsUnlocked(uniqueExpected, gracePeriodMs);
      });
    } catch (error) {
      if (error instanceof GitUnavailableSignal) {
        return { status: "unavailable", reason: "git-unavailable" };
      }
      throw error;
    }
  }

  cleanupOrphanSnapshotRefsResult(
    expectedRootTreeOids: readonly string[],
    gracePeriodMs: number,
  ): Promise<ResultType<WorkspaceHistoryOrphanCleanupResult, WorkspaceHistoryStoreError>> {
    return this.capturePublicResult("clean orphan snapshot refs", () =>
      this.cleanupOrphanSnapshotRefs(expectedRootTreeOids, gracePeriodMs),
    );
  }

  async getObjectAccounting(): Promise<WorkspaceHistoryObjectAccountingResult> {
    try {
      return await withStoreLock(this.storeDirectory, async () => {
        if (!(await this.verifyExistingStoreOwnership())) {
          return { status: "missing", accounting: EMPTY_OBJECT_ACCOUNTING };
        }
        const capability = await this.capability();
        if (capability.status === "unavailable") return capability;
        await this.verifyNoAlternates();
        return { status: "accounted", accounting: await this.getObjectAccountingUnlocked() };
      });
    } catch (error) {
      if (error instanceof GitUnavailableSignal) {
        return { status: "unavailable", reason: "git-unavailable" };
      }
      throw error;
    }
  }

  getObjectAccountingResult(): Promise<
    ResultType<WorkspaceHistoryObjectAccountingResult, WorkspaceHistoryStoreError>
  > {
    return this.capturePublicResult("account private Git objects", () =>
      this.getObjectAccounting(),
    );
  }

  async runMaintenance(
    options: WorkspaceHistoryMaintenanceOptions,
  ): Promise<WorkspaceHistoryMaintenanceResult> {
    if (!Number.isFinite(options.orphanGracePeriodMs) || options.orphanGracePeriodMs < 0) {
      throw new WorkspaceHistoryStoreError({
        code: "workspace-invalid",
        operation: "maintain private Git store",
        message: "Maintenance orphan grace period must be a non-negative finite number",
      });
    }
    const startedAt = performance.now();
    let uniqueExpected = new Set<string>();
    let removedOrphanRefs: string[] = [];
    let preservedOrphanRefs: string[] = [];
    try {
      return await withStoreLock(this.storeDirectory, async () => {
        if (!(await this.verifyExistingStoreOwnership())) {
          uniqueExpected = this.validateExpectedRootTreeOids(
            await options.loadExpectedRootTreeOids(),
          );
          const result: WorkspaceHistoryMaintenanceResult = {
            status: "missing",
            storeDisposition: "missing",
            expected: this.missingReconciliation(uniqueExpected).expected,
            removedOrphanRefs,
            preservedOrphanRefs,
            accounting: EMPTY_OBJECT_ACCOUNTING,
          };
          this.emitMaintenanceMetric(startedAt, result);
          return result;
        }
        const capability = await this.capability();
        if (capability.status === "unavailable") {
          this.emitMaintenanceMetric(startedAt, capability);
          return capability;
        }
        await this.verifyNoAlternates();
        uniqueExpected = this.validateExpectedRootTreeOids(
          await options.loadExpectedRootTreeOids(),
        );
        const cleanup = await this.cleanupOrphanSnapshotRefsUnlocked(
          uniqueExpected,
          options.orphanGracePeriodMs,
        );
        removedOrphanRefs = cleanup.removedOrphanRefs;
        preservedOrphanRefs = cleanup.preservedOrphanRefs;
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
        await this.runPrivateGit(
          ["-c", `gc.pruneExpire=${pruneExpire}`, "gc", "--auto", "--no-detach"],
          { operation: "maintain private Git objects" },
        );
        const accounting = await this.getObjectAccountingUnlocked();
        let storeDisposition: "retained" | "removed" = "retained";
        let removalRefusalReason: WorkspaceHistoryStoreRemovalRefusalReason | undefined;
        if (options.removeStoreIfUnused) {
          removalRefusalReason = await this.storeRemovalRefusalReason(
            uniqueExpected,
            options.removeStoreIfUnused.canRemoveStore,
          );
          if (!removalRefusalReason) {
            await this.removeOwnedStore();
            storeDisposition = "removed";
          }
        }
        const result: WorkspaceHistoryMaintenanceResult = {
          status: "maintained",
          storeDisposition,
          ...(removalRefusalReason ? { removalRefusalReason } : {}),
          expected: cleanup.expected,
          removedOrphanRefs,
          preservedOrphanRefs,
          accounting,
        };
        this.emitMaintenanceMetric(startedAt, result);
        return result;
      });
    } catch (error) {
      if (error instanceof GitUnavailableSignal) {
        const unavailable = { status: "unavailable" as const, reason: "git-unavailable" as const };
        this.emitMaintenanceMetric(startedAt, unavailable);
        return unavailable;
      }
      this.emitMetric({
        type: "maintenance",
        workspaceId: this.workspaceId,
        outcome: "failed",
        durationMs: performance.now() - startedAt,
        candidatePathCount: 0,
        managedPathCount: uniqueExpected.size,
        payloadBytes: 0n,
        removedOrphanRefCount: removedOrphanRefs.length,
        preservedOrphanRefCount: preservedOrphanRefs.length,
      });
      throw this.withContext(error, "maintain private Git store");
    }
  }

  runMaintenanceResult(
    options: WorkspaceHistoryMaintenanceOptions,
  ): Promise<ResultType<WorkspaceHistoryMaintenanceResult, WorkspaceHistoryStoreError>> {
    return this.capturePublicResult("maintain private Git store", () =>
      this.runMaintenance(options),
    );
  }

  async cleanupStaleRestoreArtifacts(): Promise<WorkspaceHistoryCleanupResult> {
    const capability = await this.capability();
    if (capability.status === "unavailable") return { removed: [], preserved: [] };
    return await withStoreLock(this.storeDirectory, async () => {
      await this.ensureStore();
      return await this.cleanupStaleRestoreArtifactsLocked();
    });
  }

  cleanupStaleRestoreArtifactsResult(): Promise<
    ResultType<WorkspaceHistoryCleanupResult, WorkspaceHistoryStoreError>
  > {
    return this.capturePublicResult("clean stale restore staging", () =>
      this.cleanupStaleRestoreArtifacts(),
    );
  }

  private validateExpectedRootTreeOids(expectedRootTreeOids: readonly string[]): Set<string> {
    const uniqueExpected = new Set<string>();
    for (const rootTreeOid of expectedRootTreeOids) {
      if (!OID_PATTERN.test(rootTreeOid)) {
        throw new WorkspaceHistoryStoreError({
          code: "snapshot-invalid",
          operation: "reconcile expected snapshot refs",
          message: `Expected snapshot has an invalid object ID: ${rootTreeOid}`,
        });
      }
      uniqueExpected.add(rootTreeOid);
    }
    return uniqueExpected;
  }

  private async cleanupOrphanSnapshotRefsUnlocked(
    uniqueExpected: ReadonlySet<string>,
    gracePeriodMs: number,
  ): Promise<Extract<WorkspaceHistoryOrphanCleanupResult, { status: "cleaned" }>> {
    const reconciliation = await this.reconcileExpectedSnapshotRefsUnlocked(uniqueExpected);
    const refs = await this.listSnapshotRefsUnlocked();
    const expectedRefs = new Set([...uniqueExpected].map((oid) => this.snapshotRef(oid)));
    const removedOrphanRefs: string[] = [];
    const preservedOrphanRefs: string[] = [];
    let metadataRemoved = false;
    const cutoff = this.now() - gracePeriodMs;
    for (const gitRef of [...refs.keys()].filter((ref) => !expectedRefs.has(ref)).sort()) {
      const rootTreeOid = refs.get(gitRef);
      if (!rootTreeOid) continue;
      const metadata = await this.readSnapshotRefCreationMetadata(rootTreeOid, gitRef);
      // Legacy refs without trustworthy age remain rooted until an expected-use path repairs them.
      if (!metadata || metadata.createdAtMs >= cutoff) {
        preservedOrphanRefs.push(gitRef);
        continue;
      }
      await this.runPrivateGit(["update-ref", "-d", gitRef, rootTreeOid], {
        operation: "delete orphan snapshot ref",
      });
      await rm(this.snapshotRefCreationPath(rootTreeOid), { force: true });
      refs.delete(gitRef);
      metadataRemoved = true;
      removedOrphanRefs.push(gitRef);
    }
    if (await this.cleanupUnreferencedSnapshotMetadata(refs, cutoff)) metadataRemoved = true;
    if (metadataRemoved) await this.fsyncDirectory(this.snapshotRefCreationDirectory);
    return {
      status: "cleaned",
      expected: reconciliation.expected,
      removedOrphanRefs,
      preservedOrphanRefs,
    };
  }

  private async cleanupUnreferencedSnapshotMetadata(
    refs: ReadonlyMap<string, string>,
    cutoff: number,
  ): Promise<boolean> {
    const directoryStats = await lstatIfExists(this.snapshotRefCreationDirectory);
    if (!directoryStats) return false;
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new WorkspaceHistoryStoreError({
        code: "ownership-mismatch",
        operation: "clean snapshot-ref metadata",
        message: "Snapshot-ref metadata path is not an owned directory",
      });
    }
    let removed = false;
    for (const child of await readdir(this.snapshotRefCreationDirectory, { withFileTypes: true })) {
      const metadataMatch = /^([0-9a-f]{40}|[0-9a-f]{64})\.json$/.exec(child.name);
      if (metadataMatch?.[1] && child.isFile() && !child.isSymbolicLink()) {
        const rootTreeOid = metadataMatch[1];
        const gitRef = this.snapshotRef(rootTreeOid);
        if (refs.get(gitRef) === rootTreeOid) continue;
        const metadata = await this.readSnapshotRefCreationMetadata(rootTreeOid, gitRef);
        if (metadata && metadata.createdAtMs >= cutoff) continue;
        await rm(path.join(this.snapshotRefCreationDirectory, child.name));
        removed = true;
        continue;
      }
      if (!/^\.[0-9a-f]+\.[0-9a-f-]{36}\.tmp$/.test(child.name)) continue;
      const temporaryPath = path.join(this.snapshotRefCreationDirectory, child.name);
      const stats = await lstatIfExists(temporaryPath);
      if (!stats || stats.mtimeMs >= cutoff) continue;
      await rm(temporaryPath, { recursive: true });
      removed = true;
    }
    return removed;
  }

  private async getObjectAccountingUnlocked(): Promise<WorkspaceHistoryObjectAccounting> {
    const result = await this.runPrivateGit(["count-objects", "-v"], {
      operation: "account private Git objects",
    });
    return parseObjectAccounting(result.stdout);
  }

  private async storeRemovalRefusalReason(
    uniqueExpected: ReadonlySet<string>,
    canRemoveStore: () => Promise<boolean> | boolean,
  ): Promise<WorkspaceHistoryStoreRemovalRefusalReason | undefined> {
    if (uniqueExpected.size > 0) return "expected-snapshots";
    if ((await this.listSnapshotRefsUnlocked()).size > 0) return "snapshot-refs";
    if (await this.directoryHasEntries(this.restorePlanDirectory)) return "restore-plans";
    if (await this.directoryHasEntries(this.restoreOwnershipDirectory)) {
      return "artifact-manifests";
    }
    if (!(await canRemoveStore())) return "durable-work";
    return undefined;
  }

  private async removeOwnedStore(): Promise<void> {
    await this.verifyOwnershipMarker();
    const workspaceStoreRoot = path.dirname(this.storeDirectory);
    await rm(this.storeDirectory, { recursive: true });
    await rmdir(workspaceStoreRoot).catch((error: unknown) => {
      const code = nodeErrorCode(error);
      if (code !== "ENOTEMPTY" && code !== "ENOENT") {
        throw error;
      }
    });
  }

  private async verifyNoAlternates(): Promise<void> {
    const alternatesPath = path.join(this.storeDirectory, "objects", "info", "alternates");
    if (await lstatIfExists(alternatesPath)) {
      throw new WorkspaceHistoryStoreError({
        code: "ownership-mismatch",
        operation: "verify private Git isolation",
        message: "Private Git store must not use object alternates",
      });
    }
  }

  private async directoryHasEntries(directory: string): Promise<boolean> {
    const stats = await lstatIfExists(directory);
    if (!stats) return false;
    if (!stats.isDirectory() || stats.isSymbolicLink()) return true;
    return (await readdir(directory)).length > 0;
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

  private async reconcileExpectedSnapshotRefsUnlocked(
    uniqueExpected: ReadonlySet<string>,
  ): Promise<Extract<WorkspaceHistoryRefReconciliation, { status: "reconciled" }>> {
    const refs = await this.listSnapshotRefsUnlocked();
    const graphResults = await this.validateSnapshotGraphs([...uniqueExpected]);
    const expected: WorkspaceHistoryExpectedRefResult[] = [];
    for (const rootTreeOid of uniqueExpected) {
      const gitRef = this.snapshotRef(rootTreeOid);
      const graph = graphResults.get(rootTreeOid);
      if (!graph) {
        throw new WorkspaceHistoryStoreError({
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
        await this.ensureSnapshotRefCreationMetadata(rootTreeOid, gitRef, true);
        expected.push({ rootTreeOid, gitRef, status: "present" });
        continue;
      }
      await this.ensureSnapshotRefCreationMetadata(rootTreeOid, gitRef, false);
      await this.afterSnapshotRefMetadataWriteBeforeRef?.(rootTreeOid);
      await this.runPrivateGit(["update-ref", gitRef, rootTreeOid], {
        operation: "repair expected snapshot ref",
      });
      await this.afterSnapshotRefPublication?.(rootTreeOid);
      expected.push({ rootTreeOid, gitRef, status: "repaired" });
    }
    const expectedRefs = new Set([...uniqueExpected].map((oid) => this.snapshotRef(oid)));
    return {
      status: "reconciled",
      expected,
      orphanRefs: [...refs.keys()].filter((gitRef) => !expectedRefs.has(gitRef)).sort(),
    };
  }

  private async verifyExistingStoreOwnership(): Promise<boolean> {
    const storeStats = await lstatIfExists(this.storeDirectory);
    if (!storeStats) return false;
    if (!storeStats.isDirectory() || storeStats.isSymbolicLink()) {
      throw new WorkspaceHistoryStoreError({
        code: "ownership-mismatch",
        operation: "verify store ownership",
        message: "Private Git store is not an owned directory",
      });
    }
    await this.verifyOwnershipMarker();
    return true;
  }

  private validateOperationId(operationId: string, operation: string): void {
    if (!SAFE_ID_PATTERN.test(operationId)) {
      throw new WorkspaceHistoryStoreError({
        code: "workspace-invalid",
        operation,
        message: "operationId must be an opaque 1-128 character ASCII identifier",
      });
    }
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

  private signatureMap(
    records: readonly RestorePlanManifest["ignoredSignatures"][number][],
  ): Map<string, string> {
    const signatures = new Map<string, string>();
    for (const record of records) {
      assertSafeRelativePath(record.relativePath, "read durable restore plan");
      if (signatures.has(record.relativePath)) {
        throw new WorkspaceHistoryStoreError({
          code: "snapshot-invalid",
          operation: "read durable restore plan",
          message: `Durable restore plan repeats path ${record.relativePath}`,
        });
      }
      signatures.set(record.relativePath, record.signature);
    }
    return signatures;
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

  private async writeRestorePlanManifest(manifest: RestorePlanManifest): Promise<void> {
    const parsed = manifest;
    const existingStats = await lstatIfExists(this.restorePlanPath(parsed.operationId));
    const existing = existingStats
      ? await this.readRestorePlanManifest(parsed.operationId)
      : undefined;
    if (
      existing &&
      (existing.sourceRootTreeOid !== parsed.sourceRootTreeOid ||
        existing.targetRootTreeOid !== parsed.targetRootTreeOid)
    ) {
      throw this.restoreConflict("operationId is already bound to a different restore plan");
    }
    await mkdir(this.restorePlanDirectory, { recursive: true, mode: 0o700 });
    await this.assertNoSymlinkComponents(this.restorePlanDirectory, false);
    const temporaryPath = path.join(
      this.restorePlanDirectory,
      `.${parsed.operationId}.${randomUUID()}.tmp`,
    );
    const handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(canonicalJson(parsed));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.restorePlanPath(parsed.operationId));
    await this.fsyncDirectory(this.restorePlanDirectory);
  }

  private async cleanupRestorePlanStaging(manifest: RestorePlanManifest): Promise<void> {
    const stagingDirectory = manifest.privateStagingDirectory;
    if (!stagingDirectory) return;
    const temporaryRoot = path.join(this.storeDirectory, "temp");
    if (
      !this.isWithinOrEqual(temporaryRoot, stagingDirectory) ||
      !/^restore-[0-9a-f-]{36}$/.test(path.basename(stagingDirectory))
    ) {
      return;
    }
    await rm(stagingDirectory, { recursive: true, force: true });
  }

  private async readRestorePlanManifest(operationId: string): Promise<RestorePlanManifest> {
    this.validateOperationId(operationId, "read durable restore plan");
    const planPath = this.restorePlanPath(operationId);
    const stats = await lstatIfExists(planPath);
    if (!stats || !stats.isFile() || stats.isSymbolicLink()) {
      throw new WorkspaceHistoryStoreError({
        code: "snapshot-invalid",
        operation: "read durable restore plan",
        message: `Durable restore plan does not exist: ${operationId}`,
      });
    }
    const platform = this.supportedPlatform("read durable restore plan");
    const decoded = this.decodeRestorePlan(await readFile(planPath, "utf8"), operationId, platform);
    if (decoded.status === "error") {
      throw decoded.error;
    }
    const manifest = decoded.value;
    for (const entry of [...manifest.managedEntries, ...manifest.targetEntries]) {
      assertSafeRelativePath(entry.relativePath, "read durable restore plan");
    }
    this.signatureMap(manifest.managedSignatures);
    this.signatureMap(manifest.ignoredSignatures);
    this.signatureMap(manifest.protectedSignatures);
    return manifest;
  }

  private async listSnapshotRefsUnlocked(): Promise<Map<string, string>> {
    const result = await this.runPrivateGit(
      ["for-each-ref", "--format=%(refname) %(objectname)", SNAPSHOT_REF_PREFIX],
      { operation: "enumerate snapshot refs" },
    );
    const refs = new Map<string, string>();
    const text = bytesToText(result.stdout, "enumerate snapshot refs");
    for (const line of text.split("\n")) {
      if (line === "") continue;
      const match = /^(refs\/mini-lilac\/snapshots\/[^ ]+) ([0-9a-f]+)$/.exec(line);
      if (!match?.[1] || !match[2] || !OID_PATTERN.test(match[2])) {
        throw new WorkspaceHistoryStoreError({
          code: "malformed-git-output",
          operation: "enumerate snapshot refs",
          message: "Git returned malformed snapshot-ref output",
          detail: line.slice(0, 200),
        });
      }
      refs.set(match[1], match[2]);
    }
    return refs;
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

  private async probeGit(): Promise<string> {
    if (this.positiveProbe && this.positiveProbe.expiresAt > Date.now()) {
      return this.positiveProbe.version;
    }
    const result = await this.runGit(["--version"], { operation: "probe Git" });
    const version = bytesToText(result.stdout, "probe Git").trim();
    if (!/^git version \S+/.test(version)) {
      throw new WorkspaceHistoryStoreError({
        code: "malformed-git-output",
        operation: "probe Git",
        message: "Git returned a malformed version response",
        detail: version.slice(0, 200),
      });
    }
    this.positiveProbe = { version, expiresAt: Date.now() + 5_000 };
    return version;
  }

  private async ensureStore(): Promise<void> {
    await this.assertNoSymlinkComponents(this.cwd, false);
    const workspaceStats = await lstat(this.cwd).catch((error: unknown) => {
      throw new WorkspaceHistoryStoreError({
        code: "workspace-invalid",
        operation: "validate workspace",
        message: `Cannot access workspace: ${describeError(error)}`,
        cause: error,
      });
    });
    if (!workspaceStats.isDirectory()) {
      throw new WorkspaceHistoryStoreError({
        code: "workspace-invalid",
        operation: "validate workspace",
        message: "Workspace path is not a directory",
      });
    }
    const canonicalCwd = await realpath(this.cwd);
    if (canonicalCwd !== this.cwd) {
      throw new WorkspaceHistoryStoreError({
        code: "workspace-invalid",
        operation: "validate workspace",
        message: "Workspace path must be canonical",
        detail: canonicalCwd,
      });
    }

    await this.assertNoSymlinkComponents(this.historyRoot, true);
    await mkdir(this.historyRoot, { recursive: true, mode: 0o700 });
    await this.assertNoSymlinkComponents(this.historyRoot, false);
    const canonicalHistoryRoot = await realpath(this.historyRoot);
    if (canonicalHistoryRoot !== this.historyRoot) {
      throw new WorkspaceHistoryStoreError({
        code: "workspace-invalid",
        operation: "validate history root",
        message: "History root path must be canonical and contain no symlink components",
        detail: canonicalHistoryRoot,
      });
    }
    await chmod(this.historyRoot, 0o700);
    const workspaceStoreRoot = path.dirname(this.storeDirectory);
    await this.assertNoSymlinkComponents(workspaceStoreRoot, true);
    await mkdir(workspaceStoreRoot, { recursive: true, mode: 0o700 });
    await this.assertNoSymlinkComponents(workspaceStoreRoot, false);
    await chmod(workspaceStoreRoot, 0o700);

    const markerStats = await lstatIfExists(this.markerPath);
    if (markerStats && (!markerStats.isFile() || markerStats.isSymbolicLink())) {
      throw new WorkspaceHistoryStoreError({
        code: "ownership-mismatch",
        operation: "verify store ownership",
        message: "Private Git store ownership marker is not a regular file",
      });
    }
    if (markerStats) {
      await this.verifyOwnershipMarker();
    } else {
      const existingStore = await lstatIfExists(this.storeDirectory);
      if (existingStore) {
        throw new WorkspaceHistoryStoreError({
          code: "ownership-mismatch",
          operation: "verify store ownership",
          message: "Refusing to reuse a private Git store without an ownership marker",
        });
      }
      await mkdir(this.storeDirectory, { recursive: true, mode: 0o700 });
      await writeFile(this.markerPath, canonicalJson(this.expectedMarker()), {
        mode: 0o600,
        flag: "wx",
      });
    }

    await chmod(this.storeDirectory, 0o700);
    await mkdir(this.emptyHooksPath, { recursive: true, mode: 0o700 });
    await mkdir(this.snapshotRefCreationDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.restorePlanDirectory, { recursive: true, mode: 0o700 });
    await Promise.all([
      this.writePrivateControlFile(path.join(this.storeDirectory, "empty-config"), ""),
      this.writePrivateControlFile(this.emptyAttributesPath, ""),
      this.writePrivateControlFile(this.emptyExcludesPath, ""),
    ]);

    const bareMarker = await lstatIfExists(path.join(this.storeDirectory, "HEAD"));
    if (!bareMarker) {
      await this.runGit(["init", "--bare", "--quiet", this.storeDirectory], {
        operation: "initialize private Git store",
      });
    }
    await this.writePrivateControlFile(path.join(this.storeDirectory, "info", "exclude"), "");
    await this.verifyOwnershipMarker();
  }

  private async writePrivateControlFile(targetPath: string, contents: string): Promise<void> {
    const handle = await open(
      targetPath,
      fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(contents);
    } finally {
      await handle.close();
    }
  }

  private async assertNoSymlinkComponents(
    absolutePath: string,
    allowMissingTail: boolean,
  ): Promise<void> {
    const parsed = path.parse(absolutePath);
    const components = path.relative(parsed.root, absolutePath).split(path.sep).filter(Boolean);
    let current = parsed.root;
    for (const component of components) {
      current = path.join(current, component);
      const stats = await lstatIfExists(current);
      if (!stats) {
        if (allowMissingTail) return;
        throw new WorkspaceHistoryStoreError({
          code: "workspace-invalid",
          operation: "validate path traversal",
          message: `Required path component does not exist: ${current}`,
        });
      }
      if (stats.isSymbolicLink()) {
        throw new WorkspaceHistoryStoreError({
          code: "workspace-invalid",
          operation: "validate path traversal",
          message: `Refusing symlinked path component: ${current}`,
        });
      }
    }
  }

  private async verifyOwnershipMarker(): Promise<void> {
    await this.assertNoSymlinkComponents(this.storeDirectory, false);
    const markerStats = await lstat(this.markerPath);
    if (!markerStats.isFile() || markerStats.isSymbolicLink()) {
      throw new WorkspaceHistoryStoreError({
        code: "ownership-mismatch",
        operation: "verify store ownership",
        message: "Private Git store ownership marker is not a regular file",
      });
    }
    const decoded = this.decodeOwnership(await readFile(this.markerPath, "utf8"));
    if (decoded.status === "error") {
      throw decoded.error;
    }
  }

  private async scanWorkspace(managedPaths?: ReadonlySet<string>): Promise<ScanResult> {
    const entries = new Map<string, ScannedEntry>();
    const directories = new Set<string>();
    const boundaryRoots = new Set<string>();
    const ownedRestoreArtifacts = await this.validatedOwnedRestoreArtifactPaths();
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
    ): Promise<void> => {
      const children = await readdir(absoluteDirectory, { withFileTypes: true });
      if (relativeDirectory && children.some((entry) => this.isGitMetadataName(entry.name))) {
        boundaryRoots.add(relativeDirectory);
        return;
      }
      for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
        if (this.isGitMetadataName(child.name)) continue;
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${toPosixPath(child.name)}`
          : toPosixPath(child.name);
        const absolutePath = path.join(absoluteDirectory, child.name);
        if (
          [...ownedRestoreArtifacts].some(
            (artifactPath) =>
              this.comparisonPath(artifactPath) === this.comparisonPath(absolutePath),
          )
        ) {
          continue;
        }
        if (this.isProtectedAbsolutePath(absolutePath)) continue;
        const stats = await lstat(absolutePath, { bigint: true });
        if (stats.isDirectory()) {
          directories.add(relativePath);
          if (managedPaths && !traversedDirectories.has(relativePath)) continue;
          await scanDirectory(absolutePath, relativePath);
          continue;
        }
        let kind: ScannedEntry["kind"];
        if (stats.isSymbolicLink()) {
          kind = "symlink";
        } else if (stats.isFile()) {
          kind = "regular";
        } else {
          kind = "special";
        }
        let mode: number;
        if (kind === "symlink") {
          mode = POSIX_SYMLINK_MODE;
        } else if (kind === "special") {
          mode = 0;
        } else if ((stats.mode & 0o111n) !== 0n) {
          mode = POSIX_EXECUTABLE_MODE;
        } else {
          mode = POSIX_FILE_MODE;
        }
        entries.set(relativePath, {
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
      }
    };

    await scanDirectory(this.cwd, "");
    return { entries, directories, boundaryRoots };
  }

  private async classifyWorkspace(): Promise<ClassifiedWorkspace> {
    const sourceRepository = await this.discoverSourceRepository();
    if (!sourceRepository) {
      throw new WorkspaceHistoryStoreError({
        code: "workspace-invalid",
        operation: "classify workspace",
        message: "Workspace is not inside a Git worktree",
      });
    }
    const scan = await this.scanWorkspace();
    this.sourceExcludesFile = await this.resolveEffectiveExcludesFile(sourceRepository.root);
    const managedPaths = await this.listSourceManagedPaths(sourceRepository.root);
    const ignored = await this.checkIgnoredPaths(scan, sourceRepository.root);
    const managed = new Map<string, ScannedEntry>();
    for (const relativePath of managedPaths) {
      const entry = scan.entries.get(relativePath);
      if (entry) managed.set(relativePath, entry);
    }
    for (const relativePath of managed.keys()) ignored.delete(relativePath);
    const ignoredDirectories = new Set(
      [...scan.directories].filter((relativePath) => ignored.has(relativePath)),
    );
    return { ...scan, managed, ignored, ignoredDirectories };
  }

  private async classifyWorkspaceForCapture(repositoryRoot: string): Promise<ClassifiedWorkspace> {
    this.sourceExcludesFile = await this.resolveEffectiveExcludesFile(repositoryRoot);
    const managedPaths = await this.listSourceManagedPaths(repositoryRoot);
    const scan = await this.scanWorkspace(managedPaths);
    const ignored = await this.checkIgnoredPaths(scan, repositoryRoot);
    const managed = new Map<string, ScannedEntry>();
    for (const relativePath of managedPaths) {
      const entry = scan.entries.get(relativePath);
      if (entry) managed.set(relativePath, entry);
    }
    for (const relativePath of managed.keys()) ignored.delete(relativePath);
    const ignoredDirectories = new Set(
      [...scan.directories].filter((relativePath) => ignored.has(relativePath)),
    );
    return { ...scan, managed, ignored, ignoredDirectories };
  }

  private async discoverSourceRepository(): Promise<{ root: string } | undefined> {
    const result = await this.runSourceGit(this.cwd, ["rev-parse", "--show-toplevel"], {
      operation: "discover source repository",
      acceptedExitCodes: [0, 128],
    });
    if (result.exitCode !== 0) {
      if (/not a git repository|must be run in a work tree/u.test(result.stderr)) return undefined;
      throw new WorkspaceHistoryStoreError({
        code: "git-command-failed",
        operation: "discover source repository",
        message: `Git failed while discovering the source repository (exit ${result.exitCode})`,
        detail: result.stderr.trim().slice(0, 4_000),
        exitCode: result.exitCode,
      });
    }
    const root = bytesToText(result.stdout, "discover source repository").trim();
    if (!path.isAbsolute(root)) {
      throw new WorkspaceHistoryStoreError({
        code: "malformed-git-output",
        operation: "discover source repository",
        message: "Git returned a non-absolute repository root",
      });
    }
    return { root: await realpath(root) };
  }

  private async listSourceManagedPaths(repositoryRoot: string): Promise<Set<string>> {
    const scope = toPosixPath(path.relative(repositoryRoot, this.cwd)) || ".";
    const result = await this.runSourceGit(
      repositoryRoot,
      ["ls-files", "-z", "--full-name", "--cached", "--others", "--exclude-standard", "--", scope],
      { operation: "classify source repository paths" },
    );
    const workspacePrefix = scope === "." ? "" : `${scope}/`;
    const paths = new Set<string>();
    for (const repositoryPath of splitNul(result.stdout, "classify source repository paths")) {
      const normalizedRepositoryPath = repositoryPath.endsWith("/")
        ? repositoryPath.slice(0, -1)
        : repositoryPath;
      const relativePath = workspacePrefix
        ? normalizedRepositoryPath.slice(workspacePrefix.length)
        : normalizedRepositoryPath;
      if (workspacePrefix && !repositoryPath.startsWith(workspacePrefix)) {
        throw new WorkspaceHistoryStoreError({
          code: "malformed-git-output",
          operation: "classify source repository paths",
          message: "Git returned a path outside the workspace scope",
        });
      }
      assertSafeRelativePath(relativePath, "classify source repository paths");
      paths.add(relativePath);
    }
    return paths;
  }

  private async resolveEffectiveExcludesFile(repositoryRoot: string): Promise<string | undefined> {
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
    if (result.exitCode === 0) {
      const configured = bytesToText(result.stdout, "resolve source excludes file").trim();
      if (configured.length === 0 || configured.includes("\n")) {
        throw new WorkspaceHistoryStoreError({
          code: "malformed-git-output",
          operation: "resolve source excludes file",
          message: "Git returned a malformed excludes-file path",
        });
      }
      return path.resolve(configured);
    }

    const home = process.env.HOME;
    let defaultGlobalExclude: string | undefined;
    if (process.env.XDG_CONFIG_HOME) {
      defaultGlobalExclude = path.join(process.env.XDG_CONFIG_HOME, "git", "ignore");
    } else if (home) {
      defaultGlobalExclude = path.join(home, ".config", "git", "ignore");
    }
    if (!defaultGlobalExclude) return undefined;
    return (await lstatIfExists(defaultGlobalExclude))?.isFile() ? defaultGlobalExclude : undefined;
  }

  private async checkIgnoredPaths(scan: ScanResult, repositoryRoot: string): Promise<Set<string>> {
    const candidates = [...scan.entries.keys(), ...scan.directories].sort();
    if (candidates.length === 0) return new Set();
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
    if (result.exitCode === 1) return new Set();
    const ignored = new Set<string>();
    for (const outputPath of splitNul(result.stdout, "classify ignored paths")) {
      const relativePath = scope ? outputPath.slice(`${scope}/`.length) : outputPath;
      if (!candidates.includes(relativePath)) {
        throw new WorkspaceHistoryStoreError({
          code: "malformed-git-output",
          operation: "classify ignored paths",
          message: "Git returned an unexpected ignored path",
          detail: outputPath,
        });
      }
      ignored.add(relativePath);
    }
    return ignored;
  }

  private async readCaptureCache(): Promise<
    ResultType<WorkspaceHistoryCaptureCache | undefined, WorkspaceHistoryCaptureError>
  > {
    let serialized: string | null;
    try {
      serialized = await readFile(this.captureCachePath, "utf8");
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") {
        serialized = null;
      } else {
        if (Panic.is(error)) throw error;
        if (error instanceof Error) {
          return Result.err(this.withContext(error, "read capture cache"));
        }
        throw error;
      }
    }
    const decoded = decodeWorkspaceHistoryCaptureCache({
      serialized,
      workspaceId: this.workspaceId,
      canonicalCwd: this.cwd,
      pathComparison: this.pathComparison,
    });
    if (decoded.status === "error") return Result.err(decoded.error);
    return Result.ok(decoded.value.value);
  }

  private async invalidateCaptureCacheResult(): Promise<
    ResultType<void, WorkspaceHistoryStoreError>
  > {
    try {
      await rm(this.captureCachePath, { force: true });
      await this.fsyncDirectory(this.storeDirectory);
      return Result.ok(undefined);
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      if (cause instanceof WorkspaceHistoryStoreError) return Result.err(cause);
      if (cause instanceof Error) {
        return Result.err(this.withContext(cause, "invalidate capture cache"));
      }
      throw cause;
    }
  }

  private async writeCaptureCache(cache: WorkspaceHistoryCaptureCache): Promise<void> {
    const bytes = canonicalJson(cache);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const temporaryPath = `${this.captureCachePath}.${randomUUID()}.tmp`;
      let owned: OwnedTemporaryPath | undefined;
      try {
        const handle = await open(
          temporaryPath,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
          0o600,
        );
        const stats = await handle.stat({ bigint: true });
        owned = { path: temporaryPath, dev: stats.dev, ino: stats.ino };
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await this.assertOwnedTemporary(owned);
        await rename(temporaryPath, this.captureCachePath);
        return;
      } catch (error) {
        const code = nodeErrorCode(error);
        let primary: WorkspaceHistoryCaughtFailure;
        if (Panic.is(error)) {
          primary = { kind: "panic", cause: error };
        } else if (error instanceof Error) {
          primary = { kind: "error", cause: error };
        } else {
          primary = { kind: "hostile", cause: error };
        }
        await preserveWorkspaceHistoryFailureDuringCleanup(primary, async () => {
          if (owned) {
            const current = await lstatIfExists(owned.path, true);
            if (current && current.dev === owned.dev && current.ino === owned.ino) {
              await rm(owned.path);
            }
          }
        });
        if (code === "EEXIST") continue;
        throw error;
      }
    }
    throw new WorkspaceHistoryStoreError({
      code: "filesystem-error",
      operation: "write capture cache",
      message: "Unable to allocate an exclusive capture-cache temporary file",
    });
  }

  private async existingObjects(
    oids: ReadonlySet<string>,
    type: "blob" | "tree",
  ): Promise<Set<string>> {
    if (oids.size === 0) return new Set();
    const ordered = [...oids].sort();
    const input = new TextEncoder().encode(`${ordered.join("\n")}\n`);
    const result = await this.runPrivateGit(
      ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
      {
        operation: "validate cached objects",
        input,
      },
    );
    const lines = bytesToText(result.stdout, "validate cached objects").trimEnd().split("\n");
    if (lines.length !== ordered.length) {
      throw new WorkspaceHistoryStoreError({
        code: "malformed-git-output",
        operation: "validate cached objects",
        message: "Git returned an unexpected cached-object result count",
      });
    }
    const existing = new Set<string>();
    for (let index = 0; index < ordered.length; index += 1) {
      const expected = ordered[index];
      const line = lines[index];
      if (!expected || !line) continue;
      if (line === `${expected} ${type}`) existing.add(expected);
      else if (line !== `${expected} missing`) {
        throw new WorkspaceHistoryStoreError({
          code: "malformed-git-output",
          operation: "validate cached objects",
          message: "Git returned malformed cached-object output",
          detail: line.slice(0, 200),
        });
      }
    }
    return existing;
  }

  private async hashFile(absolutePath: string, write: boolean): Promise<string> {
    const args = ["hash-object"];
    if (write) args.push("-w");
    args.push("--no-filters", "--stdin");
    const handle = await open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const result = await this.runPrivateGit(args, {
        operation: "hash regular file",
        input: handle.fd,
      });
      return parseOid(result.stdout, "hash regular file");
    } finally {
      await handle.close();
    }
  }

  private async hashBytes(bytes: Uint8Array, write: boolean): Promise<string> {
    const args = ["hash-object"];
    if (write) args.push("-w");
    args.push("--no-filters", "--stdin");
    const result = await this.runPrivateGit(args, {
      operation: "hash workspace bytes",
      input: bytes,
    });
    return parseOid(result.stdout, "hash workspace bytes");
  }

  private async writeCaptureTree(
    entries: readonly TreeEntry[],
    cache: WorkspaceHistoryCaptureCache | undefined,
  ): Promise<string> {
    let retainedIndex = false;
    if (cache) {
      const indexStats = await lstatIfExists(this.captureIndexPath);
      if (indexStats?.isFile() && !indexStats.isSymbolicLink()) {
        try {
          const result = await this.runPrivateGit(["ls-files", "--stage", "-z"], {
            operation: "validate retained capture index",
            indexPath: this.captureIndexPath,
          });
          const indexed = new Map<string, { mode: number; oid: string }>();
          for (const record of splitNul(result.stdout, "validate retained capture index")) {
            const match = /^(\d+) ([0-9a-f]+) 0\t([\s\S]+)$/.exec(record);
            if (!match?.[1] || !match[2] || !match[3] || !OID_PATTERN.test(match[2])) {
              throw new WorkspaceHistoryStoreError({
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
        } catch (error) {
          if (
            !(
              error instanceof WorkspaceHistoryStoreError &&
              error.code === "git-command-failed" &&
              /(?:index file corrupt|index file smaller|bad index)/i.test(
                `${error.message}\n${error.detail ?? ""}`,
              )
            )
          ) {
            throw error;
          }
        }
      }
    }
    if (!retainedIndex || !cache) return await this.writeTree(entries, this.captureIndexPath);

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
    if (records.length === 0 && (await this.objectExistsUnlocked(cache.workspaceTreeOid, "tree"))) {
      return cache.workspaceTreeOid;
    }
    if (records.length > 0) {
      await this.runPrivateGit(["update-index", "-z", "--index-info"], {
        operation: "reconcile retained capture index",
        indexPath: this.captureIndexPath,
        input: new TextEncoder().encode(records.join("")),
      });
    }
    const result = await this.runPrivateGit(["write-tree"], {
      operation: "write retained capture index",
      indexPath: this.captureIndexPath,
    });
    return parseOid(result.stdout, "write retained capture index");
  }

  private async writeTree(entries: readonly TreeEntry[], indexPath: string): Promise<string> {
    await rm(indexPath, { force: true });
    await this.runPrivateGit(["read-tree", "--empty"], {
      operation: "initialize private index",
      indexPath,
    });
    if (entries.length > 0) {
      const records = entries
        .map((entry) => `${entry.mode.toString(8)} ${entry.oid}\t${entry.relativePath}\0`)
        .join("");
      await this.runPrivateGit(["update-index", "-z", "--index-info"], {
        operation: "populate private index",
        indexPath,
        input: new TextEncoder().encode(records),
      });
    }
    const result = await this.runPrivateGit(["write-tree"], {
      operation: "write workspace tree",
      indexPath,
    });
    return parseOid(result.stdout, "write workspace tree");
  }

  private async writeWrapperTree(
    workspaceTreeOid: string,
    manifestBlobOid: string,
  ): Promise<string> {
    const input = new TextEncoder().encode(
      `100644 blob ${manifestBlobOid}\tmanifest.json\0` +
        `040000 tree ${workspaceTreeOid}\tworkspace\0`,
    );
    const result = await this.runPrivateGit(["mktree", "-z"], {
      operation: "write snapshot wrapper tree",
      input,
    });
    return parseOid(result.stdout, "write snapshot wrapper tree");
  }

  private async readSnapshot(
    rootTreeOid: string,
    rootAlreadyValidated = false,
  ): Promise<ParsedSnapshot> {
    if (!rootAlreadyValidated) {
      await this.requireObject(rootTreeOid, "tree", "resolve snapshot wrapper");
    }
    const wrapperResult = await this.runPrivateGit(["ls-tree", "-z", rootTreeOid], {
      operation: "read snapshot wrapper",
    });
    const wrapperEntries = this.parseLsTree(wrapperResult.stdout, "read snapshot wrapper");
    const manifestEntry = wrapperEntries.get("manifest.json");
    const workspaceEntry = wrapperEntries.get("workspace");
    if (
      wrapperEntries.size !== 2 ||
      !manifestEntry ||
      manifestEntry.mode !== POSIX_FILE_MODE ||
      !workspaceEntry ||
      workspaceEntry.mode !== 0o040000
    ) {
      throw new WorkspaceHistoryStoreError({
        code: "snapshot-invalid",
        operation: "read snapshot wrapper",
        message: "Snapshot wrapper does not contain exactly manifest.json and workspace/",
      });
    }
    const manifestResult = await this.runPrivateGit(["cat-file", "blob", manifestEntry.oid], {
      operation: "read snapshot manifest",
    });
    const manifest = this.decodeSnapshotManifest(
      bytesToText(manifestResult.stdout, "read snapshot manifest"),
    );
    if (manifest.status === "error") {
      throw manifest.error;
    }
    const workspaceResult = await this.runPrivateGit(["ls-tree", "-rz", workspaceEntry.oid], {
      operation: "read snapshot workspace tree",
    });
    const entries = this.parseLsTree(workspaceResult.stdout, "read snapshot workspace tree");
    for (const entry of entries.values()) {
      if (
        entry.mode !== POSIX_FILE_MODE &&
        entry.mode !== POSIX_EXECUTABLE_MODE &&
        entry.mode !== POSIX_SYMLINK_MODE
      ) {
        throw new WorkspaceHistoryStoreError({
          code: "snapshot-invalid",
          operation: "read snapshot workspace tree",
          message: `Snapshot has an unsupported entry mode at ${entry.relativePath}`,
        });
      }
      if (entry.relativePath.split("/").some((part) => this.isGitMetadataName(part))) {
        throw new WorkspaceHistoryStoreError({
          code: "snapshot-invalid",
          operation: "read snapshot workspace tree",
          message: "Snapshot attempts to contain Git metadata",
        });
      }
    }
    return {
      rootTreeOid,
      workspaceTreeOid: workspaceEntry.oid,
      manifestBlobOid: manifestEntry.oid,
      manifestBytes: manifestResult.stdout,
      entries,
    };
  }

  private parseLsTree(bytes: Uint8Array, operation: string): Map<string, TreeEntry> {
    const entries = new Map<string, TreeEntry>();
    for (const record of splitNul(bytes, operation)) {
      const match = /^(\d+) (?:blob|tree) ([0-9a-f]+)\t(.+)$/.exec(record);
      if (!match?.[1] || !match[2] || !match[3] || !OID_PATTERN.test(match[2])) {
        throw new WorkspaceHistoryStoreError({
          code: "malformed-git-output",
          operation,
          message: "Git returned malformed ls-tree output",
        });
      }
      const relativePath = match[3];
      assertSafeRelativePath(relativePath, operation);
      if (entries.has(relativePath)) {
        throw new WorkspaceHistoryStoreError({
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
    return entries;
  }

  private async preflightRestore(
    current: ClassifiedWorkspace,
    target: ReadonlyMap<string, TreeEntry>,
  ): Promise<void> {
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
          throw this.restoreConflict(
            `Live paths collide under case-insensitive comparison: ${previous} and ${livePath}`,
          );
        }
        livePaths.set(key, livePath);
      }
      for (const relativePath of target.keys()) {
        for (const candidate of [...pathAncestors(relativePath), relativePath]) {
          const livePath = livePaths.get(candidate.toLowerCase());
          if (livePath && livePath !== candidate) {
            throw this.restoreConflict(
              `Target path ${candidate} collides with live path ${livePath}`,
            );
          }
        }
      }
    }

    for (const [relativePath, targetEntry] of target) {
      const absolutePath = fromPosixPath(this.cwd, relativePath);
      if (!this.isWithinOrEqual(this.cwd, absolutePath)) {
        throw this.restoreConflict(`Target path escapes the workspace: ${relativePath}`);
      }
      if (this.overlapsProtectedPath(absolutePath)) {
        if (
          this.isProtectedAbsolutePath(absolutePath) &&
          (await this.liveEntryMatches(targetEntry))
        ) {
          continue;
        }
        throw this.restoreConflict(`Target path overlaps a protected path: ${relativePath}`);
      }
      for (const boundary of current.boundaryRoots) {
        const comparedPath = this.comparisonPath(relativePath);
        const comparedBoundary = this.comparisonPath(boundary);
        if (
          comparedPath === comparedBoundary ||
          comparedPath.startsWith(`${comparedBoundary}/`) ||
          comparedBoundary.startsWith(`${comparedPath}/`)
        ) {
          throw this.restoreConflict(`Target path overlaps nested Git repository ${boundary}`);
        }
      }
      let blockedByManagedAncestor = false;
      for (const ancestor of pathAncestors(relativePath)) {
        const ancestorStats = await lstatIfExists(fromPosixPath(this.cwd, ancestor));
        if (ancestorStats && !ancestorStats.isDirectory()) {
          if (!current.managed.has(ancestor)) {
            throw this.restoreConflict(`Target traversal would replace unmanaged path ${ancestor}`);
          }
          blockedByManagedAncestor = true;
          break;
        }
        if (current.ignoredDirectories.has(ancestor) && !managedDirectories.has(ancestor)) {
          throw this.restoreConflict(`Target traversal would enter ignored directory ${ancestor}`);
        }
      }
      const liveStats = blockedByManagedAncestor ? undefined : await lstatIfExists(absolutePath);
      if (liveStats && !current.managed.has(relativePath)) {
        if (liveStats.isDirectory()) {
          if (current.ignoredDirectories.has(relativePath)) {
            throw this.restoreConflict(
              `Target type change would remove ignored directory ${relativePath}`,
            );
          }
          const prefix = `${relativePath}/`;
          const unmanagedDescendant = [...current.entries.keys()].find(
            (candidate) => candidate.startsWith(prefix) && !current.managed.has(candidate),
          );
          if (unmanagedDescendant) {
            throw this.restoreConflict(
              `Target type change would remove unmanaged path ${unmanagedDescendant}`,
            );
          }
        } else if (!(await this.liveEntryMatches(targetEntry))) {
          throw this.restoreConflict(
            `Target would replace ignored or unmanaged path ${relativePath}`,
          );
        }
      }
    }
  }

  private async preflightDestinationCapabilities(
    snapshot: ParsedSnapshot,
    observeMaterializedBytes?: (bytes: bigint) => void,
  ): Promise<bigint> {
    const changed = new Map<string, TreeEntry>();
    for (const [relativePath, entry] of snapshot.entries) {
      if (!(await this.liveEntryMatches(entry))) changed.set(relativePath, entry);
      for (const part of relativePath.split("/")) {
        if (Buffer.byteLength(part) > 255) {
          throw this.restoreConflict(`Target path component exceeds the phase-one name limit`);
        }
      }
    }
    const sizes = await this.objectSizes(
      new Set([...snapshot.entries.values()].map((entry) => entry.oid)),
    );
    const privateStagingBytes = [...snapshot.entries.values()].reduce(
      (total, entry) => total + (sizes.get(entry.oid) ?? 0n),
      0n,
    );
    const parents = new Map<string, { representativePath: string; requiredBytes: bigint }>();
    for (const [relativePath, entry] of changed) {
      const unavailableRoot = await this.firstUnavailableTargetDirectory(relativePath);
      const parentRelative = unavailableRoot
        ? path.posix.dirname(unavailableRoot)
        : path.posix.dirname(relativePath);
      const parent = parentRelative === "." ? this.cwd : fromPosixPath(this.cwd, parentRelative);
      const previous = parents.get(parent);
      parents.set(parent, {
        representativePath: previous?.representativePath ?? relativePath,
        requiredBytes: (previous?.requiredBytes ?? 0n) + (sizes.get(entry.oid) ?? 0n),
      });
    }
    const materializedBytes =
      privateStagingBytes +
      [...parents.values()].reduce((total, requirement) => total + requirement.requiredBytes, 0n);
    observeMaterializedBytes?.(materializedBytes);

    const capacities = new Map<string, FilesystemCapacity>();
    const addCapacity = async (targetPath: string, requiredBytes: bigint): Promise<void> => {
      const filesystem = await this.statfs(targetPath);
      const availableBytes = filesystem.bavail * filesystem.bsize;
      const previous = capacities.get(filesystem.filesystemId);
      capacities.set(filesystem.filesystemId, {
        availableBytes:
          previous && previous.availableBytes < availableBytes
            ? previous.availableBytes
            : availableBytes,
        requiredBytes: (previous?.requiredBytes ?? 0n) + requiredBytes,
      });
    };
    await addCapacity(this.storeDirectory, privateStagingBytes);
    for (const [parent, requirement] of parents) {
      const parentStats = await lstat(parent);
      if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
        throw this.restoreConflict(`Destination capability parent is not a real directory`);
      }
      await access(parent, fsConstants.W_OK | fsConstants.X_OK);
      await addCapacity(parent, requirement.requiredBytes);
    }
    if (
      [...capacities.values()].some((capacity) => capacity.availableBytes < capacity.requiredBytes)
    ) {
      throw this.restoreConflict(`Restore filesystem has insufficient available space`);
    }

    const { manifestPath, manifest } = await this.createRestoreOwnershipManifest(
      snapshot.rootTreeOid,
      "",
    );
    manifest.privateStagingDirectory = undefined;
    await this.writeRestoreOwnershipManifest(manifestPath, manifest);
    try {
      for (const [parent, requirement] of parents) {
        await this.runEmptyDestinationCapabilityProbe(
          parent,
          requirement.representativePath,
          manifestPath,
          manifest,
        );
      }
    } finally {
      await this.cleanupStaleRestoreArtifactsLocked();
    }
    return materializedBytes;
  }

  private async objectSizes(oids: ReadonlySet<string>): Promise<Map<string, bigint>> {
    if (oids.size === 0) return new Map();
    const ordered = [...oids].sort();
    const result = await this.runPrivateGit(
      ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      {
        operation: "measure target snapshot objects",
        input: new TextEncoder().encode(`${ordered.join("\n")}\n`),
      },
    );
    const lines = bytesToText(result.stdout, "measure target snapshot objects")
      .trimEnd()
      .split("\n");
    if (lines.length !== ordered.length) {
      throw new WorkspaceHistoryStoreError({
        code: "malformed-git-output",
        operation: "measure target snapshot objects",
        message: "Git returned an unexpected object-size result count",
      });
    }
    const sizes = new Map<string, bigint>();
    for (const line of lines) {
      const match = /^([0-9a-f]+) blob ([0-9]+)$/.exec(line);
      if (!match?.[1] || !match[2] || !OID_PATTERN.test(match[1])) {
        throw new WorkspaceHistoryStoreError({
          code: "snapshot-invalid",
          operation: "measure target snapshot objects",
          message: "Target snapshot references a missing or malformed blob",
          detail: line.slice(0, 200),
        });
      }
      sizes.set(match[1], BigInt(match[2]));
    }
    return sizes;
  }

  private async runEmptyDestinationCapabilityProbe(
    destinationDirectory: string,
    relativePath: string,
    manifestPath: string,
    manifest: RestoreOwnershipManifest,
  ): Promise<void> {
    const emptyOid = await this.hashBytes(new Uint8Array(), false);
    const parent = await this.parentIdentity(destinationDirectory);
    const regularPath = path.join(destinationDirectory, this.restoreTemporaryName());
    const regularIntent = await this.addRestoreArtifactIntent(manifestPath, manifest, {
      path: regularPath,
      kind: "file",
      role: "capability-file",
      expectedOid: emptyOid,
      expectedMode: POSIX_FILE_MODE,
      ...parent,
    });
    const regularHandle = await open(
      regularPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const regularStats = await regularHandle.stat({ bigint: true });
    await regularHandle.sync();
    await regularHandle.close();
    const regularIdentity = { path: regularPath, dev: regularStats.dev, ino: regularStats.ino };
    await this.completeRestoreArtifactIdentity(
      manifestPath,
      manifest,
      regularIntent,
      regularIdentity,
    );

    const symlinkBytes = Buffer.from("mini-lilac-capability");
    const symlinkOid = await this.hashBytes(symlinkBytes, false);
    const symlinkPath = path.join(destinationDirectory, this.restoreTemporaryName());
    const symlinkIntent = await this.addRestoreArtifactIntent(manifestPath, manifest, {
      path: symlinkPath,
      kind: "file",
      role: "capability-symlink",
      expectedOid: symlinkOid,
      expectedMode: POSIX_SYMLINK_MODE,
      ...parent,
    });
    await symlink(symlinkBytes, symlinkPath);
    const symlinkStats = await lstat(symlinkPath, { bigint: true });
    await this.completeRestoreArtifactIdentity(manifestPath, manifest, symlinkIntent, {
      path: symlinkPath,
      dev: symlinkStats.dev,
      ino: symlinkStats.ino,
    });

    await this.beforeHardLinkValidation?.(relativePath, destinationDirectory);
    const linkPath = path.join(destinationDirectory, this.restoreTemporaryName());
    const linkIntent = await this.addRestoreArtifactIntent(manifestPath, manifest, {
      path: linkPath,
      kind: "file",
      role: "capability-hard-link-probe",
      expectedOid: emptyOid,
      expectedMode: POSIX_FILE_MODE,
      expectedSourceDev: regularIdentity.dev.toString(),
      expectedSourceIno: regularIdentity.ino.toString(),
      ...parent,
    });
    await link(regularPath, linkPath);
    const linkStats = await lstat(linkPath, { bigint: true });
    await this.completeRestoreArtifactIdentity(manifestPath, manifest, linkIntent, {
      path: linkPath,
      dev: linkStats.dev,
      ino: linkStats.ino,
    });
    await this.fsyncDirectory(destinationDirectory);
  }

  private async liveEntryMatches(entry: TreeEntry): Promise<boolean> {
    const absolutePath = fromPosixPath(this.cwd, entry.relativePath);
    for (const ancestor of pathAncestors(entry.relativePath)) {
      const ancestorStats = await lstatIfExists(fromPosixPath(this.cwd, ancestor));
      if (!ancestorStats || !ancestorStats.isDirectory()) return false;
    }
    const stats = await lstatIfExists(absolutePath);
    if (!stats) return false;
    if (entry.mode === POSIX_SYMLINK_MODE) {
      if (!stats.isSymbolicLink()) return false;
      const target = await readlink(absolutePath, { encoding: "buffer" });
      return (await this.hashBytes(target, false)) === entry.oid;
    }
    if (!stats.isFile()) return false;
    const actualMode = (stats.mode & 0o111) !== 0 ? POSIX_EXECUTABLE_MODE : POSIX_FILE_MODE;
    if (actualMode !== entry.mode) return false;
    return (await this.hashFile(absolutePath, false)) === entry.oid;
  }

  private validateTargetPathSet(target: ReadonlyMap<string, TreeEntry>): void {
    const seen = new Map<string, string>();
    const entryPaths = new Set(target.keys());
    for (const relativePath of target.keys()) {
      for (const ancestor of pathAncestors(relativePath)) {
        if (entryPaths.has(ancestor)) {
          throw new WorkspaceHistoryStoreError({
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
          throw new WorkspaceHistoryStoreError({
            code: "snapshot-invalid",
            operation: "validate snapshot paths",
            message: `Snapshot paths collide under ${this.pathComparison} comparison: ${previous} and ${candidate}`,
          });
        }
        seen.set(comparisonKey, candidate);
      }
    }
  }

  private async stageSnapshot(
    snapshot: ParsedSnapshot,
  ): Promise<{ stagingDirectory: string; stagedEntries: Map<string, StagedTreeEntry> }> {
    const temporaryRoot = path.join(this.storeDirectory, "temp");
    await this.assertNoSymlinkComponents(temporaryRoot, true);
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    await this.assertNoSymlinkComponents(temporaryRoot, false);
    const stagingDirectory = path.join(temporaryRoot, `restore-${randomUUID()}`);
    await mkdir(stagingDirectory, { mode: 0o700 });
    const stagedEntries = new Map<string, StagedTreeEntry>();
    try {
      let position = 0;
      for (const entry of [...snapshot.entries.values()].sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath),
      )) {
        const stagingPath = path.join(stagingDirectory, `entry-${position}`);
        position += 1;
        const handle = await open(
          stagingPath,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
          0o600,
        );
        try {
          await this.runPrivateGitToHandle(["cat-file", "blob", entry.oid], handle.fd, {
            operation: "stage snapshot blob",
          });
          await handle.sync();
        } finally {
          await handle.close();
        }
        if ((await this.hashFile(stagingPath, false)) !== entry.oid) {
          throw new WorkspaceHistoryStoreError({
            code: "snapshot-invalid",
            operation: "stage snapshot blob",
            message: `Staged blob does not match target object at ${entry.relativePath}`,
          });
        }
        if (entry.mode === POSIX_SYMLINK_MODE) {
          const payload = await readFile(stagingPath);
          if (payload.includes(0)) {
            throw new WorkspaceHistoryStoreError({
              code: "snapshot-invalid",
              operation: "stage symlink target",
              message: `Snapshot symlink target contains NUL at ${entry.relativePath}`,
            });
          }
        }
        stagedEntries.set(entry.relativePath, { ...entry, stagingPath });
      }
      return { stagingDirectory, stagedEntries };
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  private async stageDestinationEntries(
    stagedEntries: ReadonlyMap<string, StagedTreeEntry>,
    changedTargets: ReadonlySet<string>,
    workspaceIdentity: string,
    rootTreeOid: string,
    privateStagingDirectory: string,
  ): Promise<{
    destinationEntries: Map<string, DestinationStagedEntry>;
    replacementRoots: Map<string, ReplacementDirectoryRoot>;
    ownedDirectories: Map<string, OwnedTemporaryPath>;
    ownedTemps: Map<string, OwnedTemporaryPath>;
    ownershipManifestPath: string;
    ownershipManifest: RestoreOwnershipManifest;
  }> {
    const destinationEntries = new Map<string, DestinationStagedEntry>();
    const replacementRoots = new Map<string, ReplacementDirectoryRoot>();
    const ownedDirectories = new Map<string, OwnedTemporaryPath>();
    const ownedTemps = new Map<string, OwnedTemporaryPath>();
    const { manifestPath, manifest } = await this.createRestoreOwnershipManifest(
      rootTreeOid,
      privateStagingDirectory,
    );
    try {
      for (const relativePath of changedTargets) {
        const unavailableRoot = await this.firstUnavailableTargetDirectory(relativePath);
        if (!unavailableRoot || replacementRoots.has(unavailableRoot)) continue;
        const parentRelative = path.posix.dirname(unavailableRoot);
        const parentDirectory =
          parentRelative === "." ? this.cwd : fromPosixPath(this.cwd, parentRelative);
        await this.assertSafeMutationAncestors(unavailableRoot, workspaceIdentity);
        const identity = await this.createExclusiveTemporaryDirectory(
          parentDirectory,
          manifestPath,
          manifest,
          "replacement-root",
        );
        const temporaryPath = identity.path;
        ownedDirectories.set(temporaryPath, identity);
        replacementRoots.set(unavailableRoot, {
          relativePath: unavailableRoot,
          temporaryPath,
          identity,
          published: false,
        });
        await this.fsyncDirectory(parentDirectory);
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
        ownedDirectories.set(directory, identity);
        await this.fsyncDirectory(path.dirname(directory));
      }

      for (const relativePath of [...changedTargets].sort()) {
        const staged = stagedEntries.get(relativePath);
        if (!staged) throw this.verificationError(`Target blob was not staged: ${relativePath}`);
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
        await this.beforeDestinationStage?.(relativePath, destinationDirectory);
        const parentStats = await lstat(destinationDirectory);
        if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
          throw this.restoreConflict(
            `Destination staging parent is not a real directory: ${targetParent}`,
          );
        }
        const temporary = await this.createDestinationSibling(
          staged,
          destinationDirectory,
          manifestPath,
          manifest,
        );
        ownedTemps.set(temporary.path, temporary);
        destinationEntries.set(relativePath, {
          ...staged,
          temporaryPath: temporary.path,
          replacementRoot: replacementRoot?.relativePath,
        });
        await this.validateHardLinkPrimitive(
          staged,
          destinationDirectory,
          temporary,
          manifestPath,
          manifest,
        );
      }
      return {
        destinationEntries,
        replacementRoots,
        ownedDirectories,
        ownedTemps,
        ownershipManifestPath: manifestPath,
        ownershipManifest: manifest,
      };
    } catch (error) {
      await this.cleanupDestinationArtifacts(ownedTemps, ownedDirectories, workspaceIdentity);
      await this.cleanupStaleRestoreArtifactsLocked();
      throw error;
    }
  }

  private async firstUnavailableTargetDirectory(relativePath: string): Promise<string | undefined> {
    for (const ancestor of pathAncestors(relativePath)) {
      const stats = await lstatIfExists(fromPosixPath(this.cwd, ancestor));
      if (!stats || !stats.isDirectory()) return ancestor;
    }
    return undefined;
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
  ): Promise<OwnedTemporaryPath> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = path.join(parentDirectory, this.restoreTemporaryName());
      const intent = await this.addRestoreArtifactIntent(manifestPath, manifest, {
        path: candidate,
        kind: "directory",
        role,
        ...(await this.parentIdentity(parentDirectory)),
      });
      let created = false;
      try {
        await mkdir(candidate, { mode: 0o700 });
        created = true;
        await this.afterArtifactCreateBeforeIdentity?.(role, candidate);
        const stats = await lstat(candidate, { bigint: true });
        const owned = { path: candidate, dev: stats.dev, ino: stats.ino };
        await this.completeRestoreArtifactIdentity(manifestPath, manifest, intent, owned);
        return owned;
      } catch (error) {
        const code = nodeErrorCode(error);
        if (!created) await this.removeRestoreArtifactRecord(manifestPath, manifest, candidate);
        if (code === "EEXIST") continue;
        throw error;
      }
    }
    throw new WorkspaceHistoryStoreError({
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
  ): Promise<OwnedTemporaryPath> {
    const intent = await this.addRestoreArtifactIntent(manifestPath, manifest, {
      path: directory,
      kind: "directory",
      role,
      ...(await this.parentIdentity(path.dirname(directory))),
    });
    let created = false;
    try {
      await mkdir(directory, { mode: 0o700 });
      created = true;
      await this.afterArtifactCreateBeforeIdentity?.(role, directory);
      const stats = await lstat(directory, { bigint: true });
      const owned = { path: directory, dev: stats.dev, ino: stats.ino };
      await this.completeRestoreArtifactIdentity(manifestPath, manifest, intent, owned);
      return owned;
    } catch (error) {
      if (!created) await this.removeRestoreArtifactRecord(manifestPath, manifest, directory);
      throw error;
    }
  }

  private async createDestinationSibling(
    entry: StagedTreeEntry,
    destinationDirectory: string,
    manifestPath: string,
    manifest: RestoreOwnershipManifest,
  ): Promise<OwnedTemporaryPath> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = path.join(destinationDirectory, this.restoreTemporaryName());
      const role =
        entry.mode === POSIX_SYMLINK_MODE ? "destination-symlink" : "destination-regular";
      const intent = await this.addRestoreArtifactIntent(manifestPath, manifest, {
        path: candidate,
        kind: "file",
        role,
        expectedOid: entry.oid,
        expectedMode: entry.mode,
        ...(await this.parentIdentity(destinationDirectory)),
      });
      let owned: OwnedTemporaryPath | undefined;
      let created = false;
      try {
        if (entry.mode === POSIX_SYMLINK_MODE) {
          await symlink(await readFile(entry.stagingPath), candidate);
        } else {
          await copyFile(entry.stagingPath, candidate, fsConstants.COPYFILE_EXCL);
        }
        created = true;
        await this.afterArtifactCreateBeforeIdentity?.(role, candidate);
        const stats = await lstat(candidate, { bigint: true });
        owned = { path: candidate, dev: stats.dev, ino: stats.ino };
        await this.completeRestoreArtifactIdentity(manifestPath, manifest, intent, owned);
        if (entry.mode !== POSIX_SYMLINK_MODE) {
          await chmod(candidate, entry.mode === POSIX_EXECUTABLE_MODE ? 0o755 : 0o644);
          const handle = await open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
        // Node cannot open a symlink inode for fsync without following it. Fsyncing the containing
        // directory durably records the exclusively-created symlink entry and its target payload.
        await this.fsyncDirectory(destinationDirectory);
        return owned;
      } catch (error) {
        const code = nodeErrorCode(error);
        if (owned) {
          const current = await lstatIfExists(owned.path, true);
          if (current && current.dev === owned.dev && current.ino === owned.ino) {
            await rm(owned.path);
          }
        }
        if (!created) await this.removeRestoreArtifactRecord(manifestPath, manifest, candidate);
        if (code === "EEXIST") continue;
        throw error;
      }
    }
    throw new WorkspaceHistoryStoreError({
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
  ): Promise<{ manifestPath: string; manifest: RestoreOwnershipManifest }> {
    await this.assertNoSymlinkComponents(this.restoreOwnershipDirectory, true);
    await mkdir(this.restoreOwnershipDirectory, { recursive: true, mode: 0o700 });
    await this.assertNoSymlinkComponents(this.restoreOwnershipDirectory, false);
    const manifestPath = path.join(this.restoreOwnershipDirectory, `${randomUUID()}.json`);
    const manifest: RestoreOwnershipManifest = {
      formatVersion: FORMAT_VERSION,
      workspaceId: this.workspaceId,
      canonicalCwd: this.cwd,
      rootTreeOid,
      ...(privateStagingDirectory ? { privateStagingDirectory } : {}),
      artifacts: [],
    };
    await this.writeRestoreOwnershipManifest(manifestPath, manifest);
    return { manifestPath, manifest };
  }

  private async writeRestoreOwnershipManifest(
    manifestPath: string,
    manifest: RestoreOwnershipManifest,
  ): Promise<void> {
    const temporaryPath = path.join(path.dirname(manifestPath), `${randomUUID()}.tmp`);
    const handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(canonicalJson(manifest));
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directoryHandle = await open(path.dirname(manifestPath), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    await rename(temporaryPath, manifestPath);
    await this.fsyncDirectory(path.dirname(manifestPath));
  }

  private async readRestoreOwnershipManifest(
    manifestPath: string,
    operation: string,
  ): Promise<RestoreOwnershipManifest> {
    const decoded = this.decodeRestoreOwnership(await readFile(manifestPath, "utf8"), operation);
    if (decoded.status === "error") {
      throw decoded.error;
    }
    return decoded.value;
  }

  private async parentIdentity(
    parentDirectory: string,
  ): Promise<{ parentDev: string; parentIno: string }> {
    const stats = await lstat(parentDirectory, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw this.restoreConflict("Restore artifact parent is not a real directory");
    }
    return { parentDev: stats.dev.toString(), parentIno: stats.ino.toString() };
  }

  private async addRestoreArtifactIntent(
    manifestPath: string,
    manifest: RestoreOwnershipManifest,
    artifact: RestoreArtifactRecord,
  ): Promise<RestoreArtifactRecord> {
    manifest.artifacts.push(artifact);
    await this.writeRestoreOwnershipManifest(manifestPath, manifest);
    return artifact;
  }

  private async completeRestoreArtifactIdentity(
    manifestPath: string,
    manifest: RestoreOwnershipManifest,
    artifact: RestoreArtifactRecord,
    identity: OwnedTemporaryPath,
  ): Promise<void> {
    artifact.dev = identity.dev.toString();
    artifact.ino = identity.ino.toString();
    await this.writeRestoreOwnershipManifest(manifestPath, manifest);
  }

  private async removeRestoreArtifactRecord(
    manifestPath: string,
    manifest: RestoreOwnershipManifest,
    artifactPath: string,
  ): Promise<void> {
    const index = manifest.artifacts.findIndex((artifact) => artifact.path === artifactPath);
    if (index >= 0) manifest.artifacts.splice(index, 1);
    await this.writeRestoreOwnershipManifest(manifestPath, manifest);
  }

  private async validateHardLinkPrimitive(
    entry: StagedTreeEntry,
    destinationDirectory: string,
    source: OwnedTemporaryPath,
    manifestPath: string,
    manifest: RestoreOwnershipManifest,
  ): Promise<void> {
    const relativePath = entry.relativePath;
    const testPath = path.join(destinationDirectory, this.restoreTemporaryName());
    const intent = await this.addRestoreArtifactIntent(manifestPath, manifest, {
      path: testPath,
      kind: "file",
      role: "hard-link-probe",
      expectedOid: entry.oid,
      expectedMode: entry.mode,
      expectedSourceDev: source.dev.toString(),
      expectedSourceIno: source.ino.toString(),
      ...(await this.parentIdentity(destinationDirectory)),
    });
    let testIdentity: OwnedTemporaryPath | undefined;
    let created = false;
    try {
      await this.beforeHardLinkValidation?.(relativePath, destinationDirectory);
      await link(source.path, testPath);
      created = true;
      await this.afterArtifactCreateBeforeIdentity?.("hard-link-probe", testPath);
      const stats = await lstat(testPath, { bigint: true });
      testIdentity = { path: testPath, dev: stats.dev, ino: stats.ino };
      await this.completeRestoreArtifactIdentity(manifestPath, manifest, intent, testIdentity);
      await this.fsyncDirectory(destinationDirectory);
      await this.assertOwnedTemporary(testIdentity);
      await rm(testPath);
      await this.fsyncDirectory(destinationDirectory);
      await this.removeRestoreArtifactRecord(manifestPath, manifest, testPath);
      testIdentity = undefined;
    } finally {
      if (!created) await this.removeRestoreArtifactRecord(manifestPath, manifest, testPath);
      if (testIdentity) {
        const current = await lstatIfExists(testIdentity.path, true);
        if (current && current.dev === testIdentity.dev && current.ino === testIdentity.ino) {
          await rm(testIdentity.path);
        }
        await this.removeRestoreArtifactRecord(manifestPath, manifest, testIdentity.path);
      }
    }
  }

  private async fsyncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async applyPreparedRestore(
    prepared: PreparedRestoreData,
  ): Promise<{ status: "restored" }> {
    if (prepared.state !== "prepared") {
      throw new WorkspaceHistoryStoreError({
        code: "workspace-invalid",
        operation: "apply prepared workspace restore",
        message: `Prepared restore is already ${prepared.state}`,
      });
    }
    prepared.state = "applying";
    let mutated = false;
    let changed = false;
    try {
      if (!(await this.discoverSourceRepository())) {
        throw this.restoreConflict("Workspace is no longer inside a Git worktree");
      }
      await this.cleanupStaleRestoreArtifactsLocked();
      await this.assertPreparedRestoreFresh(prepared);
      if (!prepared.recovery) {
        prepared.protectedSignatures = await this.captureProtectedSignatures();
        if (prepared.operationId) {
          const manifest = await this.readRestorePlanManifest(prepared.operationId);
          await this.writeRestorePlanManifest({
            ...manifest,
            phase: "mutation-ready",
            protectedSignatures: this.signatureRecords(prepared.protectedSignatures),
          });
        }
      }
      const current = prepared.current;
      const snapshot = prepared.snapshot;
      const changedTargets = new Set<string>();
      for (const [relativePath, target] of snapshot.entries) {
        if (!(await this.liveEntryMatches(target))) changedTargets.add(relativePath);
      }
      const destinationStaging = await this.stageDestinationEntries(
        prepared.stagedEntries,
        changedTargets,
        prepared.workspaceIdentity,
        prepared.snapshot.rootTreeOid,
        prepared.stagingDirectory,
      );
      Object.assign(prepared, destinationStaging);
      await this.assertPreparedRestoreFresh(prepared);
      await this.validateDestinationStaging(prepared);
      await this.afterDestinationStaging?.();

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
        await this.beforeLiveMutation(relativePath);
        await this.assertSafeMutationAncestors(relativePath, prepared.workspaceIdentity);
        const absolutePath = fromPosixPath(this.cwd, relativePath);
        const existing = await lstatIfExists(absolutePath);
        if (
          existing?.isDirectory() &&
          [...snapshot.entries.keys()].some((candidate) => candidate.startsWith(`${relativePath}/`))
        ) {
          continue;
        }
        if (existing) {
          await this.assertLiveSignature(relativePath, prepared.liveSignatures.get(relativePath));
          await rm(absolutePath);
          mutated = true;
          await this.afterLiveDeletion?.(relativePath);
        }
      }

      for (const replacementRoot of [...prepared.replacementRoots.values()].sort(
        (left, right) => left.relativePath.split("/").length - right.relativePath.split("/").length,
      )) {
        await this.publishReplacementRoot(replacementRoot, prepared);
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
        await this.beforeLiveMutation(relativePath);
        await this.assertSafeMutationAncestors(relativePath, prepared.workspaceIdentity);
        const absolutePath = fromPosixPath(this.cwd, relativePath);
        const stats = await lstatIfExists(absolutePath);
        if (stats && !stats.isDirectory()) {
          throw this.restoreConflict(`Target directory path changed before apply: ${relativePath}`);
        }
        if (!stats) {
          throw this.restoreConflict(
            `Pre-staged target directory disappeared before apply: ${relativePath}`,
          );
        }
      }

      for (const relativePath of [...changedTargets].sort()) {
        const staged = prepared.destinationEntries.get(relativePath);
        if (!staged) throw this.verificationError(`Target blob was not staged: ${relativePath}`);
        const absolutePath = fromPosixPath(this.cwd, relativePath);
        const existing = await lstatIfExists(absolutePath);
        if (existing?.isDirectory()) {
          await this.beforeLiveMutation(relativePath);
          await this.assertSafeMutationAncestors(relativePath, prepared.workspaceIdentity);
          await rmdir(absolutePath);
          mutated = true;
        } else if (existing) {
          throw this.restoreConflict(`Target path changed before materialization: ${relativePath}`);
        }
        mutated = true;
        await this.publishDestinationSibling(staged, prepared);
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
        await this.beforeLiveMutation(relativePath);
        await this.assertSafeMutationAncestors(relativePath, prepared.workspaceIdentity);
        const absolutePath = fromPosixPath(this.cwd, relativePath);
        const stats = await lstatIfExists(absolutePath);
        if (!stats) continue;
        if (!stats.isDirectory()) {
          throw this.restoreConflict(
            `Managed directory path changed before cleanup: ${relativePath}`,
          );
        }
        await rmdir(absolutePath).catch((error: unknown) => {
          if (nodeErrorCode(error) !== "ENOTEMPTY") throw error;
        });
      }

      await this.beforeFinalVerification?.();
      const verifiedTargetEntries = await this.verifyFrozenRestoredSnapshot(prepared);
      await this.verifyProtectedSignatures(prepared.protectedSignatures);
      try {
        await this.afterFinalVerificationBeforeCacheReconciliation?.();
        await this.reconcileCaptureStateAfterRestore(snapshot, verifiedTargetEntries);
      } catch (error) {
        await Promise.all([
          rm(this.captureCachePath, { force: true }),
          rm(this.captureIndexPath, { force: true }),
        ]);
        throw error;
      }
      prepared.state = "applied";
      await this.disposePreparedRestore(prepared);
      this.emitRestoreMetric(
        prepared.metricStartedAt,
        prepared.candidatePathCount,
        prepared.managedPathCount,
        prepared.materializedBytes,
        changed,
        "restored",
      );
      return { status: "restored" };
    } catch (error) {
      prepared.state = "disposed";
      await this.cleanupDestinationArtifacts(
        prepared.ownedTemps,
        prepared.ownedDirectories,
        prepared.workspaceIdentity,
      );
      await this.cleanupStaleRestoreArtifactsLocked();
      await rm(prepared.stagingDirectory, { recursive: true, force: true });
      if (error instanceof GitUnavailableSignal) {
        this.emitRestoreMetric(
          prepared.metricStartedAt,
          prepared.candidatePathCount,
          prepared.managedPathCount,
          prepared.materializedBytes,
          changed,
          "failed",
        );
        throw new WorkspaceHistoryStoreError({
          code: "git-command-failed",
          operation: "apply prepared workspace restore",
          message: mutated
            ? "Git became unavailable after workspace restoration began"
            : "Git became unavailable after workspace restoration was prepared",
          cause: error,
        });
      }
      this.emitRestoreMetric(
        prepared.metricStartedAt,
        prepared.candidatePathCount,
        prepared.managedPathCount,
        prepared.materializedBytes,
        changed,
        "failed",
      );
      this.emitVerificationFailure(
        prepared.metricStartedAt,
        "restore",
        prepared.managedPathCount,
        error,
      );
      throw this.withContext(error, "apply prepared workspace restore");
    }
  }

  private async publishReplacementRoot(
    root: ReplacementDirectoryRoot,
    prepared: PreparedRestoreData,
  ): Promise<void> {
    await this.beforeLiveMutation(root.relativePath);
    await this.assertSafeMutationAncestors(root.relativePath, prepared.workspaceIdentity);
    await this.assertOwnedTemporary(root.identity);
    const targetPath = fromPosixPath(this.cwd, root.relativePath);
    if (await lstatIfExists(targetPath)) {
      throw this.restoreConflict(`Replacement directory target appeared: ${root.relativePath}`);
    }
    await this.writeReplacementMoveAliases(root.temporaryPath, targetPath, prepared);
    await rename(root.temporaryPath, targetPath);
    await this.fsyncDirectory(path.dirname(targetPath));
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
    await this.syncPreparedOwnershipManifest(prepared);
    await this.afterPublication?.(root.relativePath);
  }

  private async writeReplacementMoveAliases(
    sourceRoot: string,
    targetRoot: string,
    prepared: PreparedRestoreData,
  ): Promise<void> {
    if (!prepared.ownershipManifest || !prepared.ownershipManifestPath) return;
    const aliases = prepared.ownershipManifest.artifacts
      .filter((artifact) => this.isWithinOrEqual(sourceRoot, artifact.path))
      .map((artifact) => ({
        ...artifact,
        path: path.join(targetRoot, path.relative(sourceRoot, artifact.path)),
      }));
    prepared.ownershipManifest.artifacts.push(...aliases);
    await this.writeRestoreOwnershipManifest(
      prepared.ownershipManifestPath,
      prepared.ownershipManifest,
    );
  }

  private async validateDestinationStaging(prepared: PreparedRestoreData): Promise<void> {
    for (const [relativePath, entry] of prepared.destinationEntries) {
      const temporary = prepared.ownedTemps.get(entry.temporaryPath);
      if (!temporary) {
        throw this.restoreConflict(`Destination sibling ownership is missing: ${relativePath}`);
      }
      await this.assertOwnedTemporary(temporary);
      const temporaryStats = await lstat(entry.temporaryPath);
      let temporaryMode: number;
      if (temporaryStats.isSymbolicLink()) {
        temporaryMode = POSIX_SYMLINK_MODE;
      } else if (temporaryStats.isFile() && (temporaryStats.mode & 0o111) !== 0) {
        temporaryMode = POSIX_EXECUTABLE_MODE;
      } else if (temporaryStats.isFile()) {
        temporaryMode = POSIX_FILE_MODE;
      } else {
        temporaryMode = 0;
      }
      if (temporaryMode !== entry.mode) {
        throw this.restoreConflict(`Destination sibling mode changed: ${relativePath}`);
      }
      const parent = path.dirname(entry.temporaryPath);
      const parentStats = await lstat(parent);
      if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
        throw this.restoreConflict(`Destination staging parent changed: ${relativePath}`);
      }
      await access(parent, fsConstants.W_OK | fsConstants.X_OK);
      const oid =
        entry.mode === POSIX_SYMLINK_MODE
          ? await this.hashBytes(await readlink(entry.temporaryPath, { encoding: "buffer" }), false)
          : await this.hashFile(entry.temporaryPath, false);
      if (oid !== entry.oid) {
        throw this.restoreConflict(
          `Destination sibling changed after preparation: ${relativePath}`,
        );
      }
    }
    for (const root of prepared.replacementRoots.values()) {
      if (!root.published) await this.assertOwnedTemporary(root.identity);
    }
  }

  private async publishDestinationSibling(
    entry: DestinationStagedEntry,
    prepared: PreparedRestoreData,
  ): Promise<void> {
    const temporary = prepared.ownedTemps.get(entry.temporaryPath);
    if (!temporary) throw this.verificationError(`Destination sibling ownership is missing`);
    const absolutePath = fromPosixPath(this.cwd, entry.relativePath);
    await this.beforeLiveMutation(entry.relativePath);
    await this.assertSafeMutationAncestors(entry.relativePath, prepared.workspaceIdentity);
    if (await lstatIfExists(absolutePath)) {
      throw this.restoreConflict(`Target appeared before publication: ${entry.relativePath}`);
    }
    await this.assertOwnedTemporary(temporary);
    try {
      await link(temporary.path, absolutePath);
    } catch (error) {
      if (nodeErrorCode(error) === "EEXIST") {
        throw this.restoreConflict(`Target appeared before publication: ${entry.relativePath}`);
      }
      throw error;
    }
    await this.fsyncDirectory(path.dirname(absolutePath));
    await this.assertOwnedTemporary(temporary);
    await rm(temporary.path);
    prepared.ownedTemps.delete(temporary.path);
    await this.syncPreparedOwnershipManifest(prepared);
    await this.afterPublication?.(entry.relativePath);
  }

  private async syncPreparedOwnershipManifest(prepared: PreparedRestoreData): Promise<void> {
    if (!prepared.ownershipManifest || !prepared.ownershipManifestPath) return;
    const previous = prepared.ownershipManifest.artifacts;
    const retainIdentity = (
      artifact: OwnedTemporaryPath,
      kind: "file" | "directory",
    ): RestoreArtifactRecord => {
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
        throw this.restoreConflict("Restore ownership record disappeared during apply");
      }
      return { ...record, path: artifact.path };
    };
    prepared.ownershipManifest.artifacts = [
      ...Array.from(prepared.ownedTemps.values(), (artifact) => retainIdentity(artifact, "file")),
      ...Array.from(prepared.ownedDirectories.values(), (artifact) =>
        retainIdentity(artifact, "directory"),
      ),
    ];
    await this.writeRestoreOwnershipManifest(
      prepared.ownershipManifestPath,
      prepared.ownershipManifest,
    );
  }

  private async assertOwnedTemporary(temporary: OwnedTemporaryPath): Promise<void> {
    const stats = await lstatIfExists(temporary.path, true);
    if (!stats || stats.dev !== temporary.dev || stats.ino !== temporary.ino) {
      throw this.restoreConflict("Operation-owned temporary path was replaced before rename");
    }
  }

  private async cleanupDestinationArtifacts(
    ownedTemps: Map<string, OwnedTemporaryPath>,
    ownedDirectories: Map<string, OwnedTemporaryPath>,
    workspaceIdentity: string,
  ): Promise<void> {
    for (const temporary of ownedTemps.values()) {
      const relativePath = toPosixPath(path.relative(this.cwd, temporary.path));
      await this.assertSafeMutationAncestors(relativePath, workspaceIdentity);
      const stats = await lstatIfExists(temporary.path, true);
      if (stats && stats.dev === temporary.dev && stats.ino === temporary.ino) {
        await rm(temporary.path);
      }
    }
    ownedTemps.clear();
    for (const directory of [...ownedDirectories.values()].sort(
      (left, right) => right.path.split(path.sep).length - left.path.split(path.sep).length,
    )) {
      const relativePath = toPosixPath(path.relative(this.cwd, directory.path));
      await this.assertSafeMutationAncestors(relativePath, workspaceIdentity);
      const stats = await lstatIfExists(directory.path, true);
      if (!stats || stats.dev !== directory.dev || stats.ino !== directory.ino) continue;
      await rmdir(directory.path).catch((error: unknown) => {
        if (nodeErrorCode(error) !== "ENOTEMPTY") throw error;
      });
    }
    ownedDirectories.clear();
  }

  private async disposePreparedRestore(prepared: PreparedRestoreData): Promise<void> {
    if (prepared.state === "disposed") return;
    prepared.state = prepared.state === "applied" ? "applied" : "disposed";
    await this.cleanupDestinationArtifacts(
      prepared.ownedTemps,
      prepared.ownedDirectories,
      prepared.workspaceIdentity,
    );
    await this.cleanupStaleRestoreArtifactsLocked();
    await rm(prepared.stagingDirectory, { recursive: true, force: true });
  }

  private async cleanupStaleRestoreArtifactsLocked(): Promise<WorkspaceHistoryCleanupResult> {
    const removed: string[] = [];
    const preserved: string[] = [];
    const directoryStats = await lstatIfExists(this.restoreOwnershipDirectory);
    if (!directoryStats) return { removed, preserved };
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new WorkspaceHistoryStoreError({
        code: "ownership-mismatch",
        operation: "clean stale restore staging",
        message: "Restore ownership manifest path is not a real directory",
      });
    }
    const workspaceIdentity = await this.workspaceIdentity();
    const manifestEntries = await readdir(this.restoreOwnershipDirectory, { withFileTypes: true });
    for (const manifestEntry of manifestEntries) {
      if (!manifestEntry.isFile() || !manifestEntry.name.endsWith(".json")) continue;
      const manifestPath = path.join(this.restoreOwnershipDirectory, manifestEntry.name);
      const manifest = await this.readRestoreOwnershipManifest(
        manifestPath,
        "clean stale restore staging",
      );
      const artifacts = manifest.artifacts;
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
        await this.assertSafeMutationAncestors(relativePath, workspaceIdentity);
        const stats = await lstatIfExists(artifact.path, true);
        if (!stats) {
          resolved.add(artifact);
          continue;
        }
        const identityMatches =
          artifact.dev !== undefined &&
          artifact.ino !== undefined &&
          stats.dev === BigInt(artifact.dev) &&
          stats.ino === BigInt(artifact.ino);
        if (!identityMatches && !(await this.intentArtifactMatches(artifact, stats))) {
          preserved.push(artifact.path);
          continue;
        }
        await rm(artifact.path);
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
        await this.assertSafeMutationAncestors(relativePath, workspaceIdentity);
        const stats = await lstatIfExists(artifact.path, true);
        if (!stats) {
          resolved.add(artifact);
          continue;
        }
        const identityMatches =
          artifact.dev !== undefined &&
          artifact.ino !== undefined &&
          stats.dev === BigInt(artifact.dev) &&
          stats.ino === BigInt(artifact.ino);
        if (!identityMatches && !(await this.intentArtifactMatches(artifact, stats))) {
          preserved.push(artifact.path);
          continue;
        }
        try {
          await rmdir(artifact.path);
          removed.push(artifact.path);
          resolved.add(artifact);
        } catch (error) {
          if (nodeErrorCode(error) !== "ENOTEMPTY") throw error;
          preserved.push(artifact.path);
        }
      }
      manifest.artifacts = manifest.artifacts.filter((artifact) => !resolved.has(artifact));
      if (manifest.privateStagingDirectory) {
        const privateTemporaryRoot = path.join(this.storeDirectory, "temp");
        if (
          this.isWithinOrEqual(privateTemporaryRoot, manifest.privateStagingDirectory) &&
          path.basename(manifest.privateStagingDirectory).startsWith("restore-")
        ) {
          await rm(manifest.privateStagingDirectory, { recursive: true, force: true });
          manifest.privateStagingDirectory = undefined;
        } else {
          preserved.push(manifest.privateStagingDirectory);
        }
      }
      if (manifest.artifacts.length === 0 && manifest.privateStagingDirectory === undefined) {
        await rm(manifestPath);
      } else {
        await this.writeRestoreOwnershipManifest(manifestPath, manifest);
      }
    }
    await this.fsyncDirectory(this.restoreOwnershipDirectory);
    return { removed, preserved };
  }

  private async validatedOwnedRestoreArtifactPaths(): Promise<Set<string>> {
    const owned = new Set<string>();
    const directoryStats = await lstatIfExists(this.restoreOwnershipDirectory);
    if (!directoryStats) return owned;
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new WorkspaceHistoryStoreError({
        code: "ownership-mismatch",
        operation: "classify restore staging",
        message: "Restore ownership manifest path is not a real directory",
      });
    }
    for (const entry of await readdir(this.restoreOwnershipDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const manifestPath = path.join(this.restoreOwnershipDirectory, entry.name);
      const manifest = await this.readRestoreOwnershipManifest(
        manifestPath,
        "classify restore staging",
      );
      for (const artifact of manifest.artifacts) {
        if (
          artifact.dev === undefined ||
          artifact.ino === undefined ||
          !this.isWithinOrEqual(this.cwd, artifact.path)
        ) {
          continue;
        }
        const stats = await lstatIfExists(artifact.path, true);
        if (stats && stats.dev === BigInt(artifact.dev) && stats.ino === BigInt(artifact.ino)) {
          owned.add(artifact.path);
        }
      }
    }
    return owned;
  }

  private async intentArtifactMatches(
    artifact: RestoreArtifactRecord,
    stats: BigIntStats,
  ): Promise<boolean> {
    const parentStats = await lstatIfExists(path.dirname(artifact.path), true);
    if (
      !parentStats ||
      !parentStats.isDirectory() ||
      parentStats.isSymbolicLink() ||
      parentStats.dev !== BigInt(artifact.parentDev) ||
      parentStats.ino !== BigInt(artifact.parentIno)
    ) {
      return false;
    }
    if (artifact.kind === "directory") {
      return stats.isDirectory() && !stats.isSymbolicLink();
    }
    if (artifact.role === "hard-link-probe" || artifact.role === "capability-hard-link-probe") {
      return (
        artifact.expectedSourceDev !== undefined &&
        artifact.expectedSourceIno !== undefined &&
        stats.dev === BigInt(artifact.expectedSourceDev) &&
        stats.ino === BigInt(artifact.expectedSourceIno)
      );
    }
    if (artifact.expectedOid === undefined || artifact.expectedMode === undefined) return false;
    let mode: number;
    let oid: string;
    if (stats.isSymbolicLink()) {
      mode = POSIX_SYMLINK_MODE;
      oid = await this.hashBytes(await readlink(artifact.path, { encoding: "buffer" }), false);
    } else if (stats.isFile()) {
      mode = (stats.mode & 0o111n) !== 0n ? POSIX_EXECUTABLE_MODE : POSIX_FILE_MODE;
      oid = await this.hashFile(artifact.path, false);
    } else {
      return false;
    }
    return mode === artifact.expectedMode && oid === artifact.expectedOid;
  }

  private async assertPreparedRestoreFresh(prepared: PreparedRestoreData): Promise<void> {
    if ((await this.workspaceIdentity()) !== prepared.workspaceIdentity) {
      throw this.restoreConflict("Workspace root identity changed after restore preparation");
    }
    if (prepared.recovery) {
      const protectedSignatures = await this.captureProtectedSignatures();
      if (!mapsEqual(prepared.protectedSignatures, protectedSignatures)) {
        throw this.restoreConflict("Protected paths changed after restore preparation");
      }
      await this.assertFrozenRecoveryState(prepared);
      return;
    }
    const current = await this.classifyWorkspace();
    await this.stripPreparedArtifacts(current, prepared);
    const signatures = await this.captureLiveSignatures(current);
    if (
      !mapsEqual(signatures, prepared.liveSignatures) ||
      !setsEqual(new Set(current.managed.keys()), new Set(prepared.current.managed.keys())) ||
      !setsEqual(current.ignored, prepared.current.ignored) ||
      !setsEqual(current.boundaryRoots, prepared.current.boundaryRoots)
    ) {
      throw this.restoreConflict("Workspace changed after restore preparation; prepare again");
    }
    await this.preflightRestore(current, prepared.snapshot.entries);
  }

  private async assertFrozenRecoveryState(prepared: PreparedRestoreData): Promise<void> {
    await this.verifyFrozenSignatures(
      prepared.preservation,
      "Ignored path changed after preparation",
    );
    const targetPaths = [...prepared.snapshot.entries.keys()];
    for (const relativePath of prepared.current.managed.keys()) {
      const absolutePath = fromPosixPath(this.cwd, relativePath);
      const stats = await lstatIfExists(absolutePath);
      const target = prepared.snapshot.entries.get(relativePath);
      if (target && (await this.liveEntryMatches(target))) continue;
      const expectedSignature = prepared.liveSignatures.get(relativePath);
      const live = await this.readLiveEntry(relativePath, absolutePath);
      if (live && expectedSignature && (await this.entrySignature(live)) === expectedSignature) {
        continue;
      }
      if (
        stats?.isDirectory() &&
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
      if (!stats && mayBeRemoved) continue;
      throw this.restoreConflict(`Managed path has invalid partial restore state: ${relativePath}`);
    }
    for (const [relativePath, target] of prepared.snapshot.entries) {
      if (await this.liveEntryMatches(target)) continue;
      const stats = await lstatIfExists(fromPosixPath(this.cwd, relativePath));
      const sourceSignature = prepared.liveSignatures.get(relativePath);
      const live = stats
        ? await this.readLiveEntry(relativePath, fromPosixPath(this.cwd, relativePath))
        : undefined;
      if (live && sourceSignature && (await this.entrySignature(live)) === sourceSignature)
        continue;
      if (
        stats?.isDirectory() &&
        [...prepared.current.managed.keys()].some((candidate) =>
          candidate.startsWith(`${relativePath}/`),
        )
      ) {
        continue;
      }
      if (!stats) continue;
      throw this.restoreConflict(`Target path has invalid partial restore state: ${relativePath}`);
    }
  }

  private async assertFrozenSourceIntact(manifest: RestorePlanManifest): Promise<void> {
    const managedSignatures = this.signatureMap(manifest.managedSignatures);
    await this.verifyFrozenSignatures(
      managedSignatures,
      "Managed source changed before recovery activation",
    );
    const ignoredSignatures = this.signatureMap(manifest.ignoredSignatures);
    await this.verifyFrozenSignatures(
      ignoredSignatures,
      "Ignored source changed before recovery activation",
    );
    const managedPaths = new Set(manifest.managedEntries.map((entry) => entry.relativePath));
    for (const target of manifest.targetEntries) {
      if (managedPaths.has(target.relativePath) || ignoredSignatures.has(target.relativePath)) {
        continue;
      }
      if (await lstatIfExists(fromPosixPath(this.cwd, target.relativePath))) {
        throw this.restoreConflict(
          `Target progress exists before protected baseline activation: ${target.relativePath}`,
        );
      }
    }
  }

  private async verifyFrozenSignatures(
    expected: ReadonlyMap<string, string>,
    message: string,
  ): Promise<void> {
    for (const [relativePath, signature] of expected) {
      const entry = await this.readLiveEntry(relativePath, fromPosixPath(this.cwd, relativePath));
      if (!entry || (await this.entrySignature(entry)) !== signature) {
        throw this.restoreConflict(`${message}: ${relativePath}`);
      }
    }
  }

  private async stripPreparedArtifacts(
    current: ClassifiedWorkspace,
    prepared: PreparedRestoreData,
  ): Promise<void> {
    for (const temporary of prepared.ownedTemps.values()) {
      await this.assertOwnedTemporary(temporary);
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
        throw this.restoreConflict("Unknown content appeared inside destination staging");
      }
      current.entries.delete(relativePath);
      current.managed.delete(relativePath);
      current.ignored.delete(relativePath);
    }
    for (const relativePath of current.directories) {
      if (!isArtifact(relativePath)) continue;
      const absolutePath = fromPosixPath(this.cwd, relativePath);
      if (!prepared.ownedDirectories.has(absolutePath)) {
        throw this.restoreConflict("Unknown directory appeared inside destination staging");
      }
      current.directories.delete(relativePath);
      current.ignored.delete(relativePath);
      current.ignoredDirectories.delete(relativePath);
      current.boundaryRoots.delete(relativePath);
    }
  }

  private async captureLiveSignatures(current: ClassifiedWorkspace): Promise<Map<string, string>> {
    const signatures = new Map<string, string>();
    for (const [relativePath, entry] of current.entries) {
      signatures.set(relativePath, await this.entrySignature(entry));
    }
    return signatures;
  }

  private async entrySignature(entry: ScannedEntry): Promise<string> {
    if (entry.kind === "special") {
      return `special:${entry.mode}:${entry.size}:${entry.mtimeNs}:${entry.ctimeNs}:${entry.dev}:${entry.ino}`;
    }
    const oid =
      entry.kind === "symlink"
        ? await this.hashBytes(await readlink(entry.absolutePath, { encoding: "buffer" }), false)
        : await this.hashFile(entry.absolutePath, false);
    return `${entry.kind}:${entry.mode}:${oid}`;
  }

  private async assertLiveSignature(
    relativePath: string,
    expected: string | undefined,
  ): Promise<void> {
    const absolutePath = fromPosixPath(this.cwd, relativePath);
    const entry = await this.readLiveEntry(relativePath, absolutePath);
    if (!entry || expected === undefined) {
      throw this.restoreConflict(`Managed path changed before mutation: ${relativePath}`);
    }
    if ((await this.entrySignature(entry)) !== expected) {
      throw this.restoreConflict(`Managed path changed before mutation: ${relativePath}`);
    }
  }

  private async readLiveEntry(
    relativePath: string,
    absolutePath: string,
  ): Promise<ScannedEntry | undefined> {
    const stats = await lstatIfExists(absolutePath, true);
    if (!stats) return undefined;
    let kind: ScannedEntry["kind"];
    if (stats.isSymbolicLink()) {
      kind = "symlink";
    } else if (stats.isFile()) {
      kind = "regular";
    } else {
      kind = "special";
    }
    let mode: number;
    if (kind === "symlink") {
      mode = POSIX_SYMLINK_MODE;
    } else if (kind === "special") {
      mode = 0;
    } else if ((stats.mode & 0o111n) !== 0n) {
      mode = POSIX_EXECUTABLE_MODE;
    } else {
      mode = POSIX_FILE_MODE;
    }
    return {
      relativePath,
      absolutePath,
      kind,
      mode,
      size: stats.size.toString(),
      mtimeNs: stats.mtimeNs.toString(),
      ctimeNs: stats.ctimeNs.toString(),
      dev: stats.dev.toString(),
      ino: stats.ino.toString(),
    };
  }

  private async beforeLiveMutation(relativePath: string): Promise<void> {
    await this.beforeMutation?.(relativePath);
  }

  private async workspaceIdentity(): Promise<string> {
    const stats = await lstat(this.cwd, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw this.restoreConflict("Workspace root is no longer a real directory");
    }
    return `${stats.dev}:${stats.ino}`;
  }

  private async assertSafeMutationAncestors(
    relativePath: string,
    expectedWorkspaceIdentity: string,
  ): Promise<void> {
    // Node exposes no openat-style directory handles. Rechecking immediately before each operation
    // narrows traversal races but cannot eliminate a same-user swap between this check and the syscall.
    if ((await this.workspaceIdentity()) !== expectedWorkspaceIdentity) {
      throw this.restoreConflict("Workspace root changed before mutation");
    }
    for (const ancestor of pathAncestors(relativePath)) {
      const stats = await lstatIfExists(fromPosixPath(this.cwd, ancestor));
      if (!stats) {
        throw this.restoreConflict(`Required mutation ancestor disappeared: ${ancestor}`);
      }
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw this.restoreConflict(`Refusing to traverse changed ancestor ${ancestor}`);
      }
    }
  }

  private async captureUnmanagedSignatures(
    current: ClassifiedWorkspace,
  ): Promise<Map<string, string>> {
    const signatures = new Map<string, string>();
    for (const [relativePath, entry] of current.entries) {
      if (current.managed.has(relativePath)) continue;
      signatures.set(relativePath, await this.entrySignature(entry));
    }
    return signatures;
  }

  private async captureProtectedSignatures(): Promise<Map<string, string>> {
    const signatures = new Map<string, string>();
    const scan = async (absolutePath: string): Promise<void> => {
      if (!this.isWithinOrEqual(this.cwd, absolutePath)) return;
      const relativePath = toPosixPath(path.relative(this.cwd, absolutePath));
      const stats = await lstatIfExists(absolutePath, true);
      if (!stats) return;
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        signatures.set(relativePath, `directory:${stats.mode}:${stats.dev}:${stats.ino}`);
        for (const child of await readdir(absolutePath)) {
          await scan(path.join(absolutePath, child));
        }
        return;
      }
      const entry = await this.readLiveEntry(relativePath, absolutePath);
      if (entry) signatures.set(relativePath, await this.entrySignature(entry));
    };
    for (const protectedPath of this.signatureProtectedPaths) await scan(protectedPath);
    return signatures;
  }

  private async verifyProtectedSignatures(expected: ReadonlyMap<string, string>): Promise<void> {
    const actual = await this.captureProtectedSignatures();
    if (!mapsEqual(expected, actual)) {
      throw this.verificationError("Protected paths changed during restore");
    }
  }

  private async verifyFrozenRestoredSnapshot(
    prepared: PreparedRestoreData,
  ): Promise<Map<string, ScannedEntry>> {
    const verifiedTargetEntries = await this.verifyTargetSnapshot(prepared.snapshot, false);
    for (const relativePath of prepared.current.managed.keys()) {
      if (prepared.snapshot.entries.has(relativePath)) continue;
      if (pathAncestors(relativePath).some((ancestor) => prepared.snapshot.entries.has(ancestor))) {
        continue;
      }
      const stats = await lstatIfExists(fromPosixPath(this.cwd, relativePath));
      const isTargetDirectory = [...prepared.snapshot.entries.keys()].some((candidate) =>
        candidate.startsWith(`${relativePath}/`),
      );
      if (stats && !(isTargetDirectory && stats.isDirectory())) {
        throw this.verificationError(`Removed managed path still exists: ${relativePath}`);
      }
    }
    await this.verifyFrozenSignatures(prepared.preservation, "Ignored path changed during restore");
    await this.verifyProtectedSignatures(prepared.protectedSignatures);
    return verifiedTargetEntries;
  }

  private async verifyTargetSnapshot(
    snapshot: ParsedSnapshot,
    classifyManagedExtras = true,
  ): Promise<Map<string, ScannedEntry>> {
    if (classifyManagedExtras) {
      const current = await this.classifyWorkspace();
      const extraManagedPath = [...current.managed.keys()].find(
        (relativePath) => !snapshot.entries.has(relativePath),
      );
      if (extraManagedPath) {
        throw this.verificationError(
          `Managed path is absent from target snapshot: ${extraManagedPath}`,
        );
      }
    }
    const verifiedEntries: TreeEntry[] = [];
    const verifiedTargetEntries = new Map<string, ScannedEntry>();
    for (const [relativePath, expected] of snapshot.entries) {
      const absolutePath = fromPosixPath(this.cwd, relativePath);
      const before = await this.readLiveEntry(relativePath, absolutePath);
      if (!before) throw this.verificationError(`Target path is missing: ${relativePath}`);
      let oid: string;
      if (before.kind === "symlink") {
        oid = await this.hashBytes(await readlink(absolutePath, { encoding: "buffer" }), false);
      } else if (before.kind === "regular") {
        oid = await this.hashFile(absolutePath, false);
      } else {
        throw this.verificationError(`Target path has the wrong type: ${relativePath}`);
      }
      const after = await this.readLiveEntry(relativePath, absolutePath);
      if (!after || !sameScannedFingerprint(before, after)) {
        throw this.verificationError(`Target path changed during verification: ${relativePath}`);
      }
      if (after.mode !== expected.mode || oid !== expected.oid) {
        throw this.verificationError(`Target path does not match snapshot: ${relativePath}`);
      }
      verifiedEntries.push({ relativePath, mode: after.mode, oid });
      verifiedTargetEntries.set(relativePath, after);
    }

    const verifyIndex = path.join(this.storeDirectory, "verify.index");
    try {
      const workspaceTreeOid = await this.writeTree(verifiedEntries, verifyIndex);
      if (workspaceTreeOid !== snapshot.workspaceTreeOid) {
        throw this.verificationError("Fresh workspace tree does not match target snapshot");
      }
      const manifestOid = await this.hashBytes(snapshot.manifestBytes, false);
      if (manifestOid !== snapshot.manifestBlobOid) {
        throw this.verificationError("Snapshot manifest changed during restore");
      }
      const wrapperOid = await this.writeWrapperTree(workspaceTreeOid, manifestOid);
      if (wrapperOid !== snapshot.rootTreeOid) {
        throw this.verificationError("Fresh wrapper tree does not match target snapshot");
      }
    } finally {
      await rm(verifyIndex, { force: true });
    }
    return verifiedTargetEntries;
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

  private async ensureSnapshotRefCreationMetadata(
    rootTreeOid: string,
    gitRef: string,
    preserveExistingAge: boolean,
  ): Promise<WorkspaceHistorySnapshotRefCreated> {
    if (preserveExistingAge) {
      const existing = await this.readSnapshotRefCreationMetadata(rootTreeOid, gitRef);
      if (existing) return existing;
    }
    await this.beforeSnapshotRefMetadataWrite?.(rootTreeOid);
    await mkdir(this.snapshotRefCreationDirectory, { recursive: true, mode: 0o700 });
    await this.assertNoSymlinkComponents(this.snapshotRefCreationDirectory, false);
    await this.fsyncDirectory(this.storeDirectory);
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
    try {
      const handle = await open(
        temporaryPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(canonicalJson(metadata));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, metadataPath);
      await this.fsyncDirectory(this.snapshotRefCreationDirectory);
      return metadata;
    } catch (error) {
      let primary: WorkspaceHistoryCaughtFailure;
      if (Panic.is(error)) {
        primary = { kind: "panic", cause: error };
      } else if (error instanceof Error) {
        primary = { kind: "error", cause: error };
      } else {
        primary = { kind: "hostile", cause: error };
      }
      await preserveWorkspaceHistoryFailureDuringCleanup(primary, async () => {
        await rm(temporaryPath, { force: true });
      });
      throw error;
    }
  }

  private async readSnapshotRefCreationMetadata(
    rootTreeOid: string,
    gitRef: string,
  ): Promise<WorkspaceHistorySnapshotRefCreated | undefined> {
    if (gitRef !== this.snapshotRef(rootTreeOid)) return undefined;
    const directoryStats = await lstatIfExists(this.snapshotRefCreationDirectory);
    if (!directoryStats) return undefined;
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new WorkspaceHistoryStoreError({
        code: "ownership-mismatch",
        operation: "read snapshot-ref metadata",
        message: "Snapshot-ref metadata path is not an owned directory",
      });
    }
    const metadataPath = this.snapshotRefCreationPath(rootTreeOid);
    const stats = await lstatIfExists(metadataPath);
    if (!stats) return undefined;
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new WorkspaceHistoryStoreError({
        code: "ownership-mismatch",
        operation: "read snapshot-ref metadata",
        message: "Snapshot-ref metadata is not a regular file",
      });
    }
    const decoded = this.decodeSnapshotRefCreationMetadata(
      await readFile(metadataPath, "utf8"),
      rootTreeOid,
      gitRef,
    );
    if (decoded.status === "error") {
      throw decoded.error;
    }
    return decoded.value;
  }

  private async validateSnapshotGraphs(
    rootTreeOids: readonly string[],
  ): Promise<Map<string, SnapshotGraphValidation>> {
    const results = new Map<string, SnapshotGraphValidation>();
    const rootTypes = await this.objectTypesUnlocked(rootTreeOids);
    const enumerated = new Map<string, EnumeratedSnapshotGraph>();
    const descendantOids = new Set<string>();

    for (const rootTreeOid of rootTreeOids) {
      const rootType = rootTypes.get(rootTreeOid);
      if (!rootType) {
        results.set(rootTreeOid, { status: "missing" });
        continue;
      }
      if (rootType !== "tree") {
        results.set(rootTreeOid, { status: "corrupt" });
        continue;
      }
      const graph = await this.enumerateSnapshotGraph(rootTreeOid);
      enumerated.set(rootTreeOid, graph);
      for (const entry of graph.entries) descendantOids.add(entry.oid);
    }

    const descendantTypes = await this.objectTypesUnlocked(descendantOids);
    for (const [rootTreeOid, graph] of enumerated) {
      let corrupt = graph.corrupt;
      let missing = false;
      const missingTreeOids = new Set<string>();
      for (const entry of graph.entries) {
        const actualType = descendantTypes.get(entry.oid);
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
          throw new WorkspaceHistoryStoreError({
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
      try {
        const snapshot = await this.readSnapshot(rootTreeOid, true);
        this.validateTargetPathSet(snapshot.entries);
        results.set(rootTreeOid, { status: "valid" });
      } catch (error) {
        if (error instanceof WorkspaceHistoryStoreError && error.code === "snapshot-invalid") {
          results.set(rootTreeOid, { status: "corrupt" });
          continue;
        }
        throw error;
      }
    }
    return results;
  }

  private async enumerateSnapshotGraph(rootTreeOid: string): Promise<EnumeratedSnapshotGraph> {
    const result = await this.runPrivateGit(["ls-tree", "-r", "-t", "-z", rootTreeOid], {
      operation: "validate snapshot graph",
      acceptedExitCodes: [0, 1],
    });
    const entries: EnumeratedSnapshotGraph["entries"] = [];
    let corrupt = false;
    for (const record of splitNul(result.stdout, "validate snapshot graph")) {
      const match = /^(\d+) (blob|tree|commit|tag) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
      if (!match?.[1] || !match[2] || !match[3] || !OID_PATTERN.test(match[3])) {
        throw new WorkspaceHistoryStoreError({
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
    return { entries, result, corrupt };
  }

  private async requireObject(
    oid: string,
    type: "blob" | "tree",
    operation: string,
  ): Promise<void> {
    if (!(await this.objectExistsUnlocked(oid, type))) {
      throw new WorkspaceHistoryStoreError({
        code: "snapshot-invalid",
        operation,
        message: `Private Git ${type} object is missing: ${oid}`,
      });
    }
  }

  private async objectExistsUnlocked(
    oid: string,
    type: "blob" | "tree" | "object",
  ): Promise<boolean> {
    const actualType = await this.objectTypeUnlocked(oid);
    return actualType !== undefined && (type === "object" || actualType === type);
  }

  private async objectTypeUnlocked(
    oid: string,
  ): Promise<"blob" | "tree" | "commit" | "tag" | undefined> {
    return (await this.objectTypesUnlocked([oid])).get(oid);
  }

  private async objectTypesUnlocked(
    oids: Iterable<string>,
  ): Promise<Map<string, "blob" | "tree" | "commit" | "tag" | undefined>> {
    const uniqueOids = [...new Set(oids)];
    const types = new Map<string, "blob" | "tree" | "commit" | "tag" | undefined>();
    if (uniqueOids.length === 0) return types;
    const result = await this.runPrivateGit(
      ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
      {
        operation: "check private object",
        input: new TextEncoder().encode(`${uniqueOids.join("\n")}\n`),
      },
    );
    const output = bytesToText(result.stdout, "check private object");
    if (!output.endsWith("\n")) {
      throw new WorkspaceHistoryStoreError({
        code: "malformed-git-output",
        operation: "check private object",
        message: "Git returned non-terminated object-existence output",
        detail: output.slice(0, 200),
      });
    }
    const lines = output.slice(0, -1).split("\n");
    if (lines.length !== uniqueOids.length) {
      throw new WorkspaceHistoryStoreError({
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
        throw new WorkspaceHistoryStoreError({
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
        throw new WorkspaceHistoryStoreError({
          code: "malformed-git-output",
          operation: "check private object",
          message: "Git returned an unsupported object type",
        });
      }
      types.set(oid, objectType);
    }
    return types;
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

  private async runPrivateGit(
    args: readonly string[],
    options: {
      operation: string;
      acceptedExitCodes?: readonly number[];
      input?: GitInput;
      indexPath?: string;
    },
  ): Promise<GitResult> {
    await this.verifyOwnershipMarker();
    await this.beforePrivateGit?.(args);
    try {
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
    } finally {
      await this.afterPrivateGit?.(args);
    }
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
  ): Promise<GitResult> {
    await this.validateSourceGitDirectory(cwd, options.operation);
    return await this.runGit(
      ["-C", cwd, ...this.sourceConfigArgs(options.includeExcludes ?? true), ...args],
      options,
    );
  }

  private async validateSourceGitDirectory(directory: string, operation: string): Promise<void> {
    let stats: Stats;
    try {
      stats = await lstat(directory);
    } catch (error) {
      throw new WorkspaceHistoryStoreError({
        code: "workspace-invalid",
        operation,
        message: `Cannot access source Git directory: ${directory}`,
        cause: error,
      });
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new WorkspaceHistoryStoreError({
        code: "workspace-invalid",
        operation,
        message: `Source Git path is not a directory: ${directory}`,
      });
    }
  }

  private async runGit(
    args: readonly string[],
    options: {
      operation: string;
      acceptedExitCodes?: readonly number[];
      input?: GitInput;
      env?: Readonly<Record<string, string | undefined>>;
    },
  ): Promise<GitResult> {
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
    } catch (error) {
      if (isMissingExecutable(error)) throw new GitUnavailableSignal();
      throw new WorkspaceHistoryStoreError({
        code: "git-command-failed",
        operation: options.operation,
        message: `Unable to spawn Git while ${options.operation}: ${describeError(error)}`,
        cause: error,
      });
    }
    const [stdoutBuffer, stderr, exitCode] = await Promise.all([
      new Response(processHandle.stdout).arrayBuffer(),
      new Response(processHandle.stderr).text(),
      processHandle.exited,
    ]);
    if (!accepted.includes(exitCode)) {
      throw new WorkspaceHistoryStoreError({
        code: "git-command-failed",
        operation: options.operation,
        message: `Git failed while ${options.operation} (exit ${exitCode})`,
        detail: stderr.trim().slice(0, 4_000),
        exitCode,
      });
    }
    return { stdout: new Uint8Array(stdoutBuffer), stderr, exitCode };
  }

  private async runPrivateGitToHandle(
    args: readonly string[],
    destinationFd: number,
    options: { operation: string },
  ): Promise<void> {
    await this.verifyOwnershipMarker();
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
    } catch (error) {
      if (isMissingExecutable(error)) throw new GitUnavailableSignal();
      throw new WorkspaceHistoryStoreError({
        code: "git-command-failed",
        operation: options.operation,
        message: `Unable to spawn Git while ${options.operation}: ${describeError(error)}`,
        cause: error,
      });
    }
    const stderrPromise = new Response(processHandle.stderr).text();
    const [stderr, exitCode] = await Promise.all([stderrPromise, processHandle.exited]);
    if (exitCode !== 0) {
      throw new WorkspaceHistoryStoreError({
        code: "git-command-failed",
        operation: options.operation,
        message: `Git failed while ${options.operation} (exit ${exitCode})`,
        detail: stderr.trim().slice(0, 4_000),
        exitCode,
      });
    }
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
    error: unknown,
  ): void {
    if (
      !(error instanceof WorkspaceHistoryStoreError) ||
      error.operation !== "verify restored workspace"
    ) {
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

  private supportedPlatform(operation: string): "linux" | "darwin" {
    if (this.platform === "linux" || this.platform === "darwin") return this.platform;
    throw new WorkspaceHistoryStoreError({
      code: "platform-unsupported",
      operation,
      message: "Workspace history is supported only on Linux and macOS",
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

  private async capturePublicResult<T>(
    operation: string,
    effect: () => Promise<T>,
  ): Promise<ResultType<T, WorkspaceHistoryStoreError>> {
    try {
      return Result.ok(await effect());
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      if (cause instanceof WorkspaceHistoryStoreError) return Result.err(cause);
      if (cause instanceof Error) return Result.err(this.withContext(cause, operation));
      throw cause;
    }
  }

  private withContext(error: unknown, operation: string): WorkspaceHistoryStoreError {
    if (error instanceof WorkspaceHistoryStoreError) return error;
    return new WorkspaceHistoryStoreError({
      code: "filesystem-error",
      operation,
      message: `Filesystem operation failed while ${operation}: ${describeError(error)}`,
      cause: error,
    });
  }
}

export const workspaceHistorySnapshotFormatVersion = FORMAT_VERSION;
