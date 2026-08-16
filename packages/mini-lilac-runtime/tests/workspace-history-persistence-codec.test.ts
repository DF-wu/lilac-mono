import { describe, expect, it } from "bun:test";

import {
  decodeWorkspaceHistoryCaptureCache,
  decodeWorkspaceHistoryOwnership,
  decodeWorkspaceHistoryRestoreOwnership,
  decodeWorkspaceHistoryRestorePlan,
  decodeWorkspaceHistorySnapshotManifest,
  decodeWorkspaceHistorySnapshotRefCreated,
  WORKSPACE_HISTORY_IMPLEMENTATION_VERSION,
  WorkspaceHistoryPersistenceCorrupt,
  WorkspaceHistoryPersistenceMalformed,
  WorkspaceHistoryPersistenceUnsupportedVersion,
  workspaceHistoryCaptureCacheCodecCases,
  workspaceHistoryOwnershipCodecCases,
  workspaceHistoryRestoreOwnershipCodecCases,
  workspaceHistoryRestorePlanCodecCases,
  workspaceHistorySnapshotManifestCodecCases,
  workspaceHistorySnapshotRefCreatedCodecCases,
} from "../src/workspace-history-persistence-codec";

const oid = "0".repeat(40);
const workspaceId = "fixture-workspace";
const canonicalCwd = "/fixture/workspace";
const ownership = {
  formatVersion: 1,
  namespaceId: "fixture-namespace",
  databasePathHash: "fixture-database",
  workspaceId,
  canonicalCwd,
} as const;

type CodecFixture<Input> = {
  readonly input: Input;
  readonly outcome: "ok" | "error";
  readonly provenance?: "current" | "migrated" | "missing-defaulted";
  readonly errorTag?: string;
  readonly issueCode?: string;
};

type CodecResult =
  | { readonly status: "ok"; readonly value: { readonly provenance: string } }
  | {
      readonly status: "error";
      readonly error: { readonly _tag: string; readonly issueCode: string };
    };

function expectCodecCatalog<Input>(
  catalog: Readonly<Record<string, CodecFixture<Input>>>,
  decode: (input: Input) => CodecResult,
): void {
  for (const fixture of Object.values(catalog)) {
    const result = decode(fixture.input);
    expect(result.status).toBe(fixture.outcome);
    if (fixture.outcome === "ok") {
      expect(result).toMatchObject({
        status: "ok",
        value: { provenance: fixture.provenance },
      });
      continue;
    }
    if (fixture.errorTag !== undefined || fixture.issueCode !== undefined) {
      expect(result).toMatchObject({
        status: "error",
        error: { _tag: fixture.errorTag, issueCode: fixture.issueCode },
      });
    }
  }
}

describe("workspace history persistence codecs", () => {
  it("distinguishes valid absent cache and legacy absent ref metadata", () => {
    const cache = decodeWorkspaceHistoryCaptureCache({
      serialized: null,
      workspaceId,
      canonicalCwd,
      pathComparison: "case-sensitive",
    });
    const metadata = decodeWorkspaceHistorySnapshotRefCreated({
      serialized: null,
      rootTreeOid: oid,
      gitRef: `refs/mini-lilac/snapshots/${oid}`,
    });

    expect(cache).toMatchObject({ status: "ok", value: { provenance: "missing-defaulted" } });
    expect(metadata).toMatchObject({
      status: "ok",
      value: { provenance: "missing-defaulted" },
    });
  });

  it("treats newline-less current records as current and unversioned shipped records as migrated", () => {
    const ownershipMissingNewline = decodeWorkspaceHistoryOwnership({
      serialized: JSON.stringify(ownership),
      expected: ownership,
    });
    const manifest = {
      formatVersion: 1,
      implementationVersion: WORKSPACE_HISTORY_IMPLEMENTATION_VERSION,
      managedRoot: ".",
      emptyDirectories: "excluded",
      platform: "linux",
      pathComparison: "case-sensitive",
    } as const;
    const manifestMissingNewline = decodeWorkspaceHistorySnapshotManifest({
      serialized: JSON.stringify(manifest),
    });

    expect(ownershipMissingNewline).toMatchObject({
      status: "ok",
      value: { provenance: "current" },
    });
    expect(manifestMissingNewline).toMatchObject({
      status: "ok",
      value: { provenance: "current" },
    });
    expect(
      decodeWorkspaceHistoryOwnership(workspaceHistoryOwnershipCodecCases.legacy.input),
    ).toMatchObject({ status: "ok", value: { provenance: "migrated" } });
    expect(
      decodeWorkspaceHistorySnapshotManifest(
        workspaceHistorySnapshotManifestCodecCases.legacy.input,
      ),
    ).toMatchObject({ status: "ok", value: { provenance: "migrated" } });
    expect(
      decodeWorkspaceHistoryOwnership(
        workspaceHistoryOwnershipCodecCases["missing-defaulted"].input,
      ),
    ).toMatchObject({ status: "error", error: { issueCode: "record-absent" } });
    expect(
      decodeWorkspaceHistorySnapshotManifest(
        workspaceHistorySnapshotManifestCodecCases["missing-defaulted"].input,
      ),
    ).toMatchObject({ status: "error", error: { issueCode: "record-absent" } });
  });

  it("executes every fixture catalog against its declared provenance and error outcome", () => {
    expectCodecCatalog(workspaceHistoryOwnershipCodecCases, decodeWorkspaceHistoryOwnership);
    expectCodecCatalog(
      workspaceHistorySnapshotManifestCodecCases,
      decodeWorkspaceHistorySnapshotManifest,
    );
    expectCodecCatalog(workspaceHistoryCaptureCacheCodecCases, decodeWorkspaceHistoryCaptureCache);
    expectCodecCatalog(workspaceHistoryRestorePlanCodecCases, decodeWorkspaceHistoryRestorePlan);
    expectCodecCatalog(
      workspaceHistorySnapshotRefCreatedCodecCases,
      decodeWorkspaceHistorySnapshotRefCreated,
    );
    expectCodecCatalog(
      workspaceHistoryRestoreOwnershipCodecCases,
      decodeWorkspaceHistoryRestoreOwnership,
    );
  });

  it("returns distinct malformed, unsupported, corrupt, and identity errors", () => {
    const malformed = decodeWorkspaceHistoryCaptureCache({
      serialized: "{secret-content",
      workspaceId,
      canonicalCwd,
      pathComparison: "case-sensitive",
    });
    const unsupported = decodeWorkspaceHistoryCaptureCache({
      serialized: JSON.stringify({
        implementationVersion: WORKSPACE_HISTORY_IMPLEMENTATION_VERSION,
        indexVersion: 2,
      }),
      workspaceId,
      canonicalCwd,
      pathComparison: "case-sensitive",
    });
    const corrupt = decodeWorkspaceHistoryCaptureCache({
      serialized: JSON.stringify({
        implementationVersion: WORKSPACE_HISTORY_IMPLEMENTATION_VERSION,
        indexVersion: 1,
        workspaceId,
      }),
      workspaceId,
      canonicalCwd,
      pathComparison: "case-sensitive",
    });
    const mismatch = decodeWorkspaceHistoryOwnership({
      serialized: JSON.stringify(ownership),
      expected: { ...ownership, databasePathHash: "other-database" },
    });

    expect(malformed.status === "error" && malformed.error).toBeInstanceOf(
      WorkspaceHistoryPersistenceMalformed,
    );
    expect(unsupported.status === "error" && unsupported.error).toBeInstanceOf(
      WorkspaceHistoryPersistenceUnsupportedVersion,
    );
    expect(corrupt.status === "error" && corrupt.error).toBeInstanceOf(
      WorkspaceHistoryPersistenceCorrupt,
    );
    expect(mismatch).toMatchObject({
      status: "error",
      error: { issueCode: "identity-mismatch" },
    });
  });

  it("keeps diagnostics bounded and content-redacted", () => {
    const result = decodeWorkspaceHistoryCaptureCache({
      serialized: '{"token":"super-secret"',
      workspaceId,
      canonicalCwd,
      pathComparison: "case-sensitive",
    });
    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected malformed cache");
    expect(
      JSON.stringify({
        recordKind: result.error.recordKind,
        issueCode: result.error.issueCode,
      }),
    ).not.toContain("super-secret");
  });
});
