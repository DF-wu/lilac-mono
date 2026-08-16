import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

export const WORKSPACE_HISTORY_FORMAT_VERSION = 1 as const;
export const WORKSPACE_HISTORY_INDEX_VERSION = 1 as const;
export const WORKSPACE_HISTORY_IMPLEMENTATION_VERSION = "mini-lilac-private-git-v1" as const;

const oidSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const safeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const pathComparisonSchema = z.enum(["case-sensitive", "case-insensitive"]);
const platformSchema = z.enum(["linux", "darwin"]);

const ownershipSchema = z.strictObject({
  formatVersion: z.literal(WORKSPACE_HISTORY_FORMAT_VERSION),
  namespaceId: z.string().min(1),
  databasePathHash: z.string().min(1),
  workspaceId: safeIdSchema,
  canonicalCwd: z.string().min(1),
});
const legacyOwnershipSchema = ownershipSchema.omit({ formatVersion: true });

const snapshotManifestSchema = z.strictObject({
  formatVersion: z.literal(WORKSPACE_HISTORY_FORMAT_VERSION),
  implementationVersion: z.literal(WORKSPACE_HISTORY_IMPLEMENTATION_VERSION),
  managedRoot: z.literal("."),
  emptyDirectories: z.literal("excluded"),
  platform: platformSchema,
  pathComparison: pathComparisonSchema,
});
const legacySnapshotManifestSchema = snapshotManifestSchema.omit({
  formatVersion: true,
  implementationVersion: true,
});

const cachedEntrySchema = z.strictObject({
  kind: z.enum(["regular", "symlink"]),
  mode: z.number().int(),
  oid: oidSchema,
  size: z.string(),
  mtimeNs: z.string(),
  ctimeNs: z.string(),
  dev: z.string(),
  ino: z.string(),
});

const captureCacheSchema = z.strictObject({
  implementationVersion: z.literal(WORKSPACE_HISTORY_IMPLEMENTATION_VERSION),
  indexVersion: z.literal(WORKSPACE_HISTORY_INDEX_VERSION),
  workspaceId: safeIdSchema,
  canonicalCwd: z.string().min(1),
  pathComparison: pathComparisonSchema,
  workspaceTreeOid: oidSchema,
  entries: z.record(z.string(), cachedEntrySchema),
});
const legacyCaptureCacheSchema = captureCacheSchema.omit({ implementationVersion: true });

const frozenTreeEntrySchema = z.strictObject({
  relativePath: z.string().min(1),
  mode: z.number().int(),
  oid: oidSchema,
});
const frozenSignatureSchema = z.strictObject({
  relativePath: z.string().min(1),
  signature: z.string(),
});
const restorePlanSchema = z.strictObject({
  formatVersion: z.literal(WORKSPACE_HISTORY_FORMAT_VERSION),
  implementationVersion: z.literal(WORKSPACE_HISTORY_IMPLEMENTATION_VERSION),
  operationId: safeIdSchema,
  workspaceId: safeIdSchema,
  canonicalCwd: z.string().min(1),
  sourceRootTreeOid: oidSchema,
  targetRootTreeOid: oidSchema,
  workspaceIdentity: z.string().min(1),
  pathComparison: pathComparisonSchema,
  platform: platformSchema,
  createdAtMs: z.number().int().nonnegative(),
  phase: z.enum(["prepared", "mutation-ready"]),
  privateStagingDirectory: z.string().min(1).optional(),
  managedEntries: z.array(frozenTreeEntrySchema),
  managedSignatures: z.array(frozenSignatureSchema),
  ignoredSignatures: z.array(frozenSignatureSchema),
  protectedSignatures: z.array(frozenSignatureSchema),
  boundaryRoots: z.array(z.string().min(1)),
  targetEntries: z.array(frozenTreeEntrySchema),
});
const legacyRestorePlanSchema = restorePlanSchema.omit({
  formatVersion: true,
  implementationVersion: true,
});

const snapshotRefCreatedSchema = z.strictObject({
  formatVersion: z.literal(WORKSPACE_HISTORY_FORMAT_VERSION),
  rootTreeOid: oidSchema,
  gitRef: z.string().min(1),
  createdAtMs: z.number().int().nonnegative(),
});
const legacySnapshotRefCreatedSchema = snapshotRefCreatedSchema.omit({ formatVersion: true });

const restoreArtifactSchema = z.strictObject({
  path: z.string().min(1),
  dev: z.string().optional(),
  ino: z.string().optional(),
  kind: z.enum(["file", "directory"]),
  role: z.enum([
    "destination-regular",
    "destination-symlink",
    "replacement-root",
    "replacement-directory",
    "hard-link-probe",
    "capability-file",
    "capability-symlink",
    "capability-hard-link-probe",
  ]),
  expectedOid: oidSchema.optional(),
  expectedMode: z.number().int().optional(),
  expectedSourceDev: z.string().optional(),
  expectedSourceIno: z.string().optional(),
  parentDev: z.string(),
  parentIno: z.string(),
});
const restoreOwnershipSchema = z.strictObject({
  formatVersion: z.literal(WORKSPACE_HISTORY_FORMAT_VERSION),
  workspaceId: safeIdSchema,
  canonicalCwd: z.string().min(1),
  rootTreeOid: oidSchema,
  privateStagingDirectory: z.string().min(1).optional(),
  artifacts: z.array(restoreArtifactSchema),
});
const legacyRestoreOwnershipSchema = restoreOwnershipSchema.omit({ formatVersion: true });

const formatVersionProbeSchema = z.object({ formatVersion: z.number().int() }).passthrough();
const cacheVersionProbeSchema = z
  .object({ implementationVersion: z.string(), indexVersion: z.number().int() })
  .passthrough();

export type WorkspaceHistoryOwnership = z.output<typeof ownershipSchema>;
export type WorkspaceHistorySnapshotManifest = z.output<typeof snapshotManifestSchema>;
export type WorkspaceHistoryCachedEntry = z.output<typeof cachedEntrySchema>;
export type WorkspaceHistoryCaptureCache = z.output<typeof captureCacheSchema>;
export type WorkspaceHistoryRestorePlan = z.output<typeof restorePlanSchema>;
export type WorkspaceHistorySnapshotRefCreated = z.output<typeof snapshotRefCreatedSchema>;
export type WorkspaceHistoryRestoreArtifact = z.output<typeof restoreArtifactSchema>;
export type WorkspaceHistoryRestoreArtifactRole = WorkspaceHistoryRestoreArtifact["role"];
export type WorkspaceHistoryRestoreOwnership = z.output<typeof restoreOwnershipSchema>;

export type WorkspaceHistoryPersistenceRecordKind =
  | "ownership"
  | "snapshot-manifest"
  | "capture-cache"
  | "restore-plan"
  | "snapshot-ref-created"
  | "restore-ownership";

export type WorkspaceHistoryPersistenceIssueCode =
  | "record-absent"
  | "unsupported-version"
  | "malformed-serialization"
  | "corrupt-fields"
  | "identity-mismatch";

export type WorkspaceHistoryPersistenceVersionCategory =
  | "format"
  | "implementation"
  | "index"
  | "implementation-and-index";

type PersistenceErrorContext = {
  readonly recordKind: WorkspaceHistoryPersistenceRecordKind;
  readonly issueCode: WorkspaceHistoryPersistenceIssueCode;
  readonly message: string;
};

export class WorkspaceHistoryPersistenceUnsupportedVersion extends TaggedError(
  "WorkspaceHistoryPersistenceUnsupportedVersion",
)<
  PersistenceErrorContext & { readonly versionCategory: WorkspaceHistoryPersistenceVersionCategory }
> {}

export class WorkspaceHistoryPersistenceMalformed extends TaggedError(
  "WorkspaceHistoryPersistenceMalformed",
)<PersistenceErrorContext> {}

export class WorkspaceHistoryPersistenceCorrupt extends TaggedError(
  "WorkspaceHistoryPersistenceCorrupt",
)<PersistenceErrorContext> {}

export type WorkspaceHistoryPersistenceCodecError =
  | WorkspaceHistoryPersistenceUnsupportedVersion
  | WorkspaceHistoryPersistenceMalformed
  | WorkspaceHistoryPersistenceCorrupt;

export type WorkspaceHistoryPersistenceProvenance = "current" | "migrated" | "missing-defaulted";

export type DecodedWorkspaceHistoryValue<
  T,
  P extends WorkspaceHistoryPersistenceProvenance = WorkspaceHistoryPersistenceProvenance,
> = {
  readonly value: T;
  readonly provenance: P;
};

type SerializedRecordInput = { readonly serialized: string | null };

function malformed(
  recordKind: WorkspaceHistoryPersistenceRecordKind,
): WorkspaceHistoryPersistenceMalformed {
  return new WorkspaceHistoryPersistenceMalformed({
    recordKind,
    issueCode: "malformed-serialization",
    message: `Workspace history ${recordKind} is not valid JSON`,
  });
}

function corrupt(
  recordKind: WorkspaceHistoryPersistenceRecordKind,
  issueCode: "record-absent" | "corrupt-fields" | "identity-mismatch" = "corrupt-fields",
): WorkspaceHistoryPersistenceCorrupt {
  return new WorkspaceHistoryPersistenceCorrupt({
    recordKind,
    issueCode,
    message: `Workspace history ${recordKind} has corrupt fields`,
  });
}

function unsupported(
  recordKind: WorkspaceHistoryPersistenceRecordKind,
  versionCategory: WorkspaceHistoryPersistenceVersionCategory,
): WorkspaceHistoryPersistenceUnsupportedVersion {
  return new WorkspaceHistoryPersistenceUnsupportedVersion({
    recordKind,
    issueCode: "unsupported-version",
    versionCategory,
    message: `Workspace history ${recordKind} version is unsupported`,
  });
}

function parseJson(
  recordKind: WorkspaceHistoryPersistenceRecordKind,
  serialized: string,
): ResultType<unknown, WorkspaceHistoryPersistenceMalformed> {
  try {
    return Result.ok(JSON.parse(serialized));
  } catch {
    return Result.err(malformed(recordKind));
  }
}

function detectFormatVersion(
  recordKind: WorkspaceHistoryPersistenceRecordKind,
  value: unknown,
): ResultType<void, WorkspaceHistoryPersistenceUnsupportedVersion> {
  const versioned = formatVersionProbeSchema.safeParse(value);
  if (versioned.success && versioned.data.formatVersion !== WORKSPACE_HISTORY_FORMAT_VERSION) {
    return Result.err(unsupported(recordKind, "format"));
  }
  return Result.ok(undefined);
}

function ownershipMatches(
  actual: WorkspaceHistoryOwnership,
  expected: WorkspaceHistoryOwnership,
): boolean {
  return (
    actual.formatVersion === expected.formatVersion &&
    actual.namespaceId === expected.namespaceId &&
    actual.databasePathHash === expected.databasePathHash &&
    actual.workspaceId === expected.workspaceId &&
    actual.canonicalCwd === expected.canonicalCwd
  );
}

export type WorkspaceHistoryOwnershipCodecInput = SerializedRecordInput & {
  readonly expected: WorkspaceHistoryOwnership;
};

export function decodeWorkspaceHistoryOwnership(
  input: WorkspaceHistoryOwnershipCodecInput,
): ResultType<
  DecodedWorkspaceHistoryValue<WorkspaceHistoryOwnership, "current" | "migrated">,
  WorkspaceHistoryPersistenceCodecError
> {
  if (input.serialized === null) return Result.err(corrupt("ownership", "record-absent"));
  const json = parseJson("ownership", input.serialized);
  let value: unknown;
  let failure: WorkspaceHistoryPersistenceCodecError | undefined;
  json.match({
    ok: (decoded) => void (value = decoded),
    err: (error) => void (failure = error),
  });
  if (failure !== undefined) return Result.err(failure);
  detectFormatVersion("ownership", value).match({
    ok: () => {},
    err: (error) => void (failure = error),
  });
  if (failure !== undefined) return Result.err(failure);
  const parsed = ownershipSchema.safeParse(value);
  if (!parsed.success) {
    const legacy = legacyOwnershipSchema.safeParse(value);
    if (legacy.success) {
      const migrated = { formatVersion: WORKSPACE_HISTORY_FORMAT_VERSION, ...legacy.data };
      if (!ownershipMatches(migrated, input.expected)) {
        return Result.err(corrupt("ownership", "identity-mismatch"));
      }
      return Result.ok({ value: migrated, provenance: "migrated" });
    }
    return Result.err(corrupt("ownership"));
  }
  if (!ownershipMatches(parsed.data, input.expected)) {
    return Result.err(corrupt("ownership", "identity-mismatch"));
  }
  return Result.ok({ value: parsed.data, provenance: "current" });
}

export type WorkspaceHistorySnapshotManifestCodecInput = SerializedRecordInput;

export function decodeWorkspaceHistorySnapshotManifest(
  input: WorkspaceHistorySnapshotManifestCodecInput,
): ResultType<
  DecodedWorkspaceHistoryValue<WorkspaceHistorySnapshotManifest, "current" | "migrated">,
  WorkspaceHistoryPersistenceCodecError
> {
  if (input.serialized === null) return Result.err(corrupt("snapshot-manifest", "record-absent"));
  const json = parseJson("snapshot-manifest", input.serialized);
  let value: unknown;
  let failure: WorkspaceHistoryPersistenceCodecError | undefined;
  json.match({
    ok: (decoded) => void (value = decoded),
    err: (error) => void (failure = error),
  });
  if (failure !== undefined) return Result.err(failure);
  detectFormatVersion("snapshot-manifest", value).match({
    ok: () => {},
    err: (error) => void (failure = error),
  });
  if (failure !== undefined) return Result.err(failure);
  const parsed = snapshotManifestSchema.safeParse(value);
  if (!parsed.success) {
    const legacy = legacySnapshotManifestSchema.safeParse(value);
    if (legacy.success) {
      return Result.ok({
        value: {
          formatVersion: WORKSPACE_HISTORY_FORMAT_VERSION,
          implementationVersion: WORKSPACE_HISTORY_IMPLEMENTATION_VERSION,
          ...legacy.data,
        },
        provenance: "migrated",
      });
    }
    return Result.err(corrupt("snapshot-manifest"));
  }
  return Result.ok({ value: parsed.data, provenance: "current" });
}

export type WorkspaceHistoryCaptureCacheCodecInput = SerializedRecordInput & {
  readonly workspaceId: string;
  readonly canonicalCwd: string;
  readonly pathComparison: "case-sensitive" | "case-insensitive";
};

export function decodeWorkspaceHistoryCaptureCache(
  input: WorkspaceHistoryCaptureCacheCodecInput,
): ResultType<
  DecodedWorkspaceHistoryValue<WorkspaceHistoryCaptureCache | undefined>,
  WorkspaceHistoryPersistenceCodecError
> {
  if (input.serialized === null) {
    return Result.ok({ value: undefined, provenance: "missing-defaulted" });
  }
  const json = parseJson("capture-cache", input.serialized);
  let value: unknown;
  let failure: WorkspaceHistoryPersistenceCodecError | undefined;
  json.match({
    ok: (decoded) => void (value = decoded),
    err: (error) => void (failure = error),
  });
  if (failure !== undefined) return Result.err(failure);
  const versioned = cacheVersionProbeSchema.safeParse(value);
  if (
    versioned.success &&
    (versioned.data.indexVersion !== WORKSPACE_HISTORY_INDEX_VERSION ||
      versioned.data.implementationVersion !== WORKSPACE_HISTORY_IMPLEMENTATION_VERSION)
  ) {
    const implementationMismatch =
      versioned.data.implementationVersion !== WORKSPACE_HISTORY_IMPLEMENTATION_VERSION;
    const indexMismatch = versioned.data.indexVersion !== WORKSPACE_HISTORY_INDEX_VERSION;
    let versionCategory: WorkspaceHistoryPersistenceVersionCategory;
    if (implementationMismatch && indexMismatch) versionCategory = "implementation-and-index";
    else if (implementationMismatch) versionCategory = "implementation";
    else versionCategory = "index";
    return Result.err(unsupported("capture-cache", versionCategory));
  }
  const parsed = captureCacheSchema.safeParse(value);
  if (!parsed.success) {
    const legacy = legacyCaptureCacheSchema.safeParse(value);
    if (!legacy.success) return Result.err(corrupt("capture-cache"));
    if (
      legacy.data.workspaceId !== input.workspaceId ||
      legacy.data.canonicalCwd !== input.canonicalCwd ||
      legacy.data.pathComparison !== input.pathComparison
    ) {
      return Result.err(corrupt("capture-cache", "identity-mismatch"));
    }
    return Result.ok({
      value: {
        implementationVersion: WORKSPACE_HISTORY_IMPLEMENTATION_VERSION,
        ...legacy.data,
      },
      provenance: "migrated",
    });
  }
  if (
    parsed.data.workspaceId !== input.workspaceId ||
    parsed.data.canonicalCwd !== input.canonicalCwd ||
    parsed.data.pathComparison !== input.pathComparison
  ) {
    return Result.err(corrupt("capture-cache", "identity-mismatch"));
  }
  return Result.ok({ value: parsed.data, provenance: "current" });
}

export type WorkspaceHistoryRestorePlanCodecInput = SerializedRecordInput & {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly canonicalCwd: string;
  readonly pathComparison: "case-sensitive" | "case-insensitive";
  readonly platform: "linux" | "darwin";
};

export function decodeWorkspaceHistoryRestorePlan(
  input: WorkspaceHistoryRestorePlanCodecInput,
): ResultType<
  DecodedWorkspaceHistoryValue<WorkspaceHistoryRestorePlan>,
  WorkspaceHistoryPersistenceCodecError
> {
  if (input.serialized === null) return Result.err(corrupt("restore-plan", "record-absent"));
  const json = parseJson("restore-plan", input.serialized);
  let value: unknown;
  let failure: WorkspaceHistoryPersistenceCodecError | undefined;
  json.match({
    ok: (decoded) => void (value = decoded),
    err: (error) => void (failure = error),
  });
  if (failure !== undefined) return Result.err(failure);
  detectFormatVersion("restore-plan", value).match({
    ok: () => {},
    err: (error) => void (failure = error),
  });
  if (failure !== undefined) return Result.err(failure);
  const parsed = restorePlanSchema.safeParse(value);
  if (!parsed.success) {
    const legacy = legacyRestorePlanSchema.safeParse(value);
    if (!legacy.success) return Result.err(corrupt("restore-plan"));
    const migrated = {
      formatVersion: WORKSPACE_HISTORY_FORMAT_VERSION,
      implementationVersion: WORKSPACE_HISTORY_IMPLEMENTATION_VERSION,
      ...legacy.data,
    };
    if (
      migrated.operationId !== input.operationId ||
      migrated.workspaceId !== input.workspaceId ||
      migrated.canonicalCwd !== input.canonicalCwd ||
      migrated.pathComparison !== input.pathComparison ||
      migrated.platform !== input.platform
    ) {
      return Result.err(corrupt("restore-plan", "identity-mismatch"));
    }
    return Result.ok({ value: migrated, provenance: "migrated" });
  }
  if (
    parsed.data.operationId !== input.operationId ||
    parsed.data.workspaceId !== input.workspaceId ||
    parsed.data.canonicalCwd !== input.canonicalCwd ||
    parsed.data.pathComparison !== input.pathComparison ||
    parsed.data.platform !== input.platform
  ) {
    return Result.err(corrupt("restore-plan", "identity-mismatch"));
  }
  const provenance =
    parsed.data.privateStagingDirectory === undefined ? "missing-defaulted" : "current";
  return Result.ok({ value: parsed.data, provenance });
}

export type WorkspaceHistorySnapshotRefCreatedCodecInput = SerializedRecordInput & {
  readonly rootTreeOid: string;
  readonly gitRef: string;
};

export function decodeWorkspaceHistorySnapshotRefCreated(
  input: WorkspaceHistorySnapshotRefCreatedCodecInput,
): ResultType<
  DecodedWorkspaceHistoryValue<WorkspaceHistorySnapshotRefCreated | undefined>,
  WorkspaceHistoryPersistenceCodecError
> {
  // Snapshot refs shipped before age metadata. Absence intentionally keeps such refs rooted.
  if (input.serialized === null) {
    return Result.ok({ value: undefined, provenance: "missing-defaulted" });
  }
  const json = parseJson("snapshot-ref-created", input.serialized);
  let value: unknown;
  let failure: WorkspaceHistoryPersistenceCodecError | undefined;
  json.match({
    ok: (decoded) => void (value = decoded),
    err: (error) => void (failure = error),
  });
  if (failure !== undefined) return Result.err(failure);
  detectFormatVersion("snapshot-ref-created", value).match({
    ok: () => {},
    err: (error) => void (failure = error),
  });
  if (failure !== undefined) return Result.err(failure);
  const parsed = snapshotRefCreatedSchema.safeParse(value);
  if (!parsed.success) {
    const legacy = legacySnapshotRefCreatedSchema.safeParse(value);
    if (!legacy.success) return Result.err(corrupt("snapshot-ref-created"));
    if (legacy.data.rootTreeOid !== input.rootTreeOid || legacy.data.gitRef !== input.gitRef) {
      return Result.err(corrupt("snapshot-ref-created", "identity-mismatch"));
    }
    return Result.ok({
      value: { formatVersion: WORKSPACE_HISTORY_FORMAT_VERSION, ...legacy.data },
      provenance: "migrated",
    });
  }
  if (parsed.data.rootTreeOid !== input.rootTreeOid || parsed.data.gitRef !== input.gitRef) {
    return Result.err(corrupt("snapshot-ref-created", "identity-mismatch"));
  }
  return Result.ok({ value: parsed.data, provenance: "current" });
}

export type WorkspaceHistoryRestoreOwnershipCodecInput = SerializedRecordInput & {
  readonly workspaceId: string;
  readonly canonicalCwd: string;
};

export function decodeWorkspaceHistoryRestoreOwnership(
  input: WorkspaceHistoryRestoreOwnershipCodecInput,
): ResultType<
  DecodedWorkspaceHistoryValue<WorkspaceHistoryRestoreOwnership>,
  WorkspaceHistoryPersistenceCodecError
> {
  if (input.serialized === null) {
    return Result.err(corrupt("restore-ownership", "record-absent"));
  }
  const json = parseJson("restore-ownership", input.serialized);
  let value: unknown;
  let failure: WorkspaceHistoryPersistenceCodecError | undefined;
  json.match({
    ok: (decoded) => void (value = decoded),
    err: (error) => void (failure = error),
  });
  if (failure !== undefined) return Result.err(failure);
  detectFormatVersion("restore-ownership", value).match({
    ok: () => {},
    err: (error) => void (failure = error),
  });
  if (failure !== undefined) return Result.err(failure);
  const parsed = restoreOwnershipSchema.safeParse(value);
  if (!parsed.success) {
    const legacy = legacyRestoreOwnershipSchema.safeParse(value);
    if (!legacy.success) return Result.err(corrupt("restore-ownership"));
    if (
      legacy.data.workspaceId !== input.workspaceId ||
      legacy.data.canonicalCwd !== input.canonicalCwd
    ) {
      return Result.err(corrupt("restore-ownership", "identity-mismatch"));
    }
    return Result.ok({
      value: { formatVersion: WORKSPACE_HISTORY_FORMAT_VERSION, ...legacy.data },
      provenance: "migrated",
    });
  }
  if (
    parsed.data.workspaceId !== input.workspaceId ||
    parsed.data.canonicalCwd !== input.canonicalCwd
  ) {
    return Result.err(corrupt("restore-ownership", "identity-mismatch"));
  }
  const hasIncompleteIdentity = parsed.data.artifacts.some(
    (artifact) => artifact.dev === undefined || artifact.ino === undefined,
  );
  const provenance =
    parsed.data.privateStagingDirectory === undefined || hasIncompleteIdentity
      ? "missing-defaulted"
      : "current";
  return Result.ok({ value: parsed.data, provenance });
}

export function encodeWorkspaceHistoryRecord(value: object): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

const fixtureOid = "0".repeat(40);
const fixtureOwnership = {
  formatVersion: 1,
  namespaceId: "fixture-namespace",
  databasePathHash: "fixture-database",
  workspaceId: "fixture-workspace",
  canonicalCwd: "/fixture/workspace",
} as const satisfies WorkspaceHistoryOwnership;
const fixtureCache = {
  implementationVersion: WORKSPACE_HISTORY_IMPLEMENTATION_VERSION,
  indexVersion: 1,
  workspaceId: fixtureOwnership.workspaceId,
  canonicalCwd: fixtureOwnership.canonicalCwd,
  pathComparison: "case-sensitive",
  workspaceTreeOid: fixtureOid,
  entries: {},
} as const satisfies WorkspaceHistoryCaptureCache;
const fixturePlan = {
  formatVersion: 1,
  implementationVersion: WORKSPACE_HISTORY_IMPLEMENTATION_VERSION,
  operationId: "fixture-operation",
  workspaceId: fixtureOwnership.workspaceId,
  canonicalCwd: fixtureOwnership.canonicalCwd,
  sourceRootTreeOid: fixtureOid,
  targetRootTreeOid: fixtureOid,
  workspaceIdentity: "fixture-identity",
  pathComparison: "case-sensitive",
  platform: "linux",
  createdAtMs: 1,
  phase: "prepared",
  privateStagingDirectory: "/fixture/staging",
  managedEntries: [],
  managedSignatures: [],
  ignoredSignatures: [],
  protectedSignatures: [],
  boundaryRoots: [],
  targetEntries: [],
} as const satisfies WorkspaceHistoryRestorePlan;
const fixtureSnapshotRef = {
  formatVersion: 1,
  rootTreeOid: fixtureOid,
  gitRef: `refs/mini-lilac/snapshots/${fixtureOid}`,
  createdAtMs: 1,
} as const satisfies WorkspaceHistorySnapshotRefCreated;
const fixtureRestoreOwnership = {
  formatVersion: 1,
  workspaceId: fixtureOwnership.workspaceId,
  canonicalCwd: fixtureOwnership.canonicalCwd,
  rootTreeOid: fixtureOid,
  privateStagingDirectory: "/fixture/staging",
  artifacts: [],
} as const satisfies WorkspaceHistoryRestoreOwnership;

const fixtureSnapshotManifest = {
  formatVersion: 1,
  implementationVersion: WORKSPACE_HISTORY_IMPLEMENTATION_VERSION,
  managedRoot: ".",
  emptyDirectories: "excluded",
  platform: "linux",
  pathComparison: "case-sensitive",
} as const satisfies WorkspaceHistorySnapshotManifest;

export const workspaceHistoryOwnershipCodecCases = {
  current: {
    input: { serialized: `${JSON.stringify(fixtureOwnership)}\n`, expected: fixtureOwnership },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: {
      serialized: JSON.stringify({ ...fixtureOwnership, formatVersion: undefined }),
      expected: fixtureOwnership,
    },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { serialized: null, expected: fixtureOwnership },
    outcome: "error",
    errorTag: "WorkspaceHistoryPersistenceCorrupt",
    issueCode: "record-absent",
  },
  "unsupported-version": {
    input: {
      serialized: JSON.stringify({ ...fixtureOwnership, formatVersion: 2 }),
      expected: fixtureOwnership,
    },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { serialized: "{", expected: fixtureOwnership },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      serialized: JSON.stringify({ ...fixtureOwnership, workspaceId: 1 }),
      expected: fixtureOwnership,
    },
    outcome: "error",
  },
} as const;

export const workspaceHistorySnapshotManifestCodecCases = {
  current: {
    input: { serialized: `${JSON.stringify(fixtureSnapshotManifest)}\n` },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: {
      serialized: JSON.stringify({
        ...fixtureSnapshotManifest,
        formatVersion: undefined,
        implementationVersion: undefined,
      }),
    },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { serialized: null },
    outcome: "error",
    errorTag: "WorkspaceHistoryPersistenceCorrupt",
    issueCode: "record-absent",
  },
  "unsupported-version": {
    input: { serialized: JSON.stringify({ ...fixtureSnapshotManifest, formatVersion: 2 }) },
    outcome: "error",
  },
  "malformed-serialization": { input: { serialized: "{" }, outcome: "error" },
  "corrupt-fields": {
    input: { serialized: JSON.stringify({ ...fixtureSnapshotManifest, managedRoot: ".." }) },
    outcome: "error",
  },
} as const;

const fixtureCacheInput = {
  workspaceId: fixtureOwnership.workspaceId,
  canonicalCwd: fixtureOwnership.canonicalCwd,
  pathComparison: "case-sensitive" as const,
};
export const workspaceHistoryCaptureCacheCodecCases = {
  current: {
    input: { ...fixtureCacheInput, serialized: JSON.stringify(fixtureCache) },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: {
      ...fixtureCacheInput,
      serialized: JSON.stringify({ ...fixtureCache, implementationVersion: undefined }),
    },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { ...fixtureCacheInput, serialized: null },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: {
      ...fixtureCacheInput,
      serialized: JSON.stringify({ ...fixtureCache, indexVersion: 2 }),
    },
    outcome: "error",
  },
  "malformed-serialization": { input: { ...fixtureCacheInput, serialized: "{" }, outcome: "error" },
  "corrupt-fields": {
    input: { ...fixtureCacheInput, serialized: JSON.stringify({ ...fixtureCache, entries: [] }) },
    outcome: "error",
  },
} as const;

const fixturePlanInput = {
  operationId: fixturePlan.operationId,
  workspaceId: fixturePlan.workspaceId,
  canonicalCwd: fixturePlan.canonicalCwd,
  pathComparison: fixturePlan.pathComparison,
  platform: fixturePlan.platform,
};
export const workspaceHistoryRestorePlanCodecCases = {
  current: {
    input: { ...fixturePlanInput, serialized: JSON.stringify(fixturePlan) },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: {
      ...fixturePlanInput,
      serialized: JSON.stringify({
        ...fixturePlan,
        formatVersion: undefined,
        implementationVersion: undefined,
      }),
    },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: {
      ...fixturePlanInput,
      serialized: JSON.stringify({ ...fixturePlan, privateStagingDirectory: undefined }),
    },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: {
      ...fixturePlanInput,
      serialized: JSON.stringify({ ...fixturePlan, formatVersion: 2 }),
    },
    outcome: "error",
  },
  "malformed-serialization": { input: { ...fixturePlanInput, serialized: "{" }, outcome: "error" },
  "corrupt-fields": {
    input: {
      ...fixturePlanInput,
      serialized: JSON.stringify({ ...fixturePlan, phase: "unknown" }),
    },
    outcome: "error",
  },
} as const;

const fixtureSnapshotRefInput = {
  rootTreeOid: fixtureSnapshotRef.rootTreeOid,
  gitRef: fixtureSnapshotRef.gitRef,
};
export const workspaceHistorySnapshotRefCreatedCodecCases = {
  current: {
    input: { ...fixtureSnapshotRefInput, serialized: JSON.stringify(fixtureSnapshotRef) },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: {
      ...fixtureSnapshotRefInput,
      serialized: JSON.stringify({ ...fixtureSnapshotRef, formatVersion: undefined }),
    },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { ...fixtureSnapshotRefInput, serialized: null },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: {
      ...fixtureSnapshotRefInput,
      serialized: JSON.stringify({ ...fixtureSnapshotRef, formatVersion: 2 }),
    },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { ...fixtureSnapshotRefInput, serialized: "{" },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      ...fixtureSnapshotRefInput,
      serialized: JSON.stringify({ ...fixtureSnapshotRef, createdAtMs: -1 }),
    },
    outcome: "error",
  },
} as const;

const fixtureRestoreOwnershipInput = {
  workspaceId: fixtureRestoreOwnership.workspaceId,
  canonicalCwd: fixtureRestoreOwnership.canonicalCwd,
};
export const workspaceHistoryRestoreOwnershipCodecCases = {
  current: {
    input: { ...fixtureRestoreOwnershipInput, serialized: JSON.stringify(fixtureRestoreOwnership) },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: {
      ...fixtureRestoreOwnershipInput,
      serialized: JSON.stringify({ ...fixtureRestoreOwnership, formatVersion: undefined }),
    },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: {
      ...fixtureRestoreOwnershipInput,
      serialized: JSON.stringify({
        ...fixtureRestoreOwnership,
        privateStagingDirectory: undefined,
      }),
    },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: {
      ...fixtureRestoreOwnershipInput,
      serialized: JSON.stringify({ ...fixtureRestoreOwnership, formatVersion: 2 }),
    },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { ...fixtureRestoreOwnershipInput, serialized: "{" },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      ...fixtureRestoreOwnershipInput,
      serialized: JSON.stringify({ ...fixtureRestoreOwnership, artifacts: "invalid" }),
    },
    outcome: "error",
  },
} as const;
