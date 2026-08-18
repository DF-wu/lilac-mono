import { describe, expect, it } from "bun:test";

import { architectureManifest, type ArchitectureManifest } from "../architecture/manifest.ts";

import {
  formatSyntaxDiagnostic,
  scanSyntaxFindings,
  type SyntaxFinding,
} from "./check-production-syntax.mts";

const FIXTURE_ROOT = new URL("./fixtures/production-syntax-gate/", import.meta.url).pathname;

function fixtureManifest(): ArchitectureManifest {
  const workspace = architectureManifest.workspaces[0];
  if (!workspace) throw new Error("fixture workspace template missing");
  return {
    ...architectureManifest,
    workspaces: [
      {
        ...workspace,
        name: "apps/example",
        packageName: "@example/app",
        root: "apps/example",
        exceptionAdapters: [],
        persistedStoreConsumers: [],
        sqliteTransactionConsumers: [],
        unknownFreeModules: [],
      },
    ],
  };
}

describe("repository syntax gate", () => {
  it("discovers fixture sources, preserves fixture directories, and excludes tests before parsing", async () => {
    const findings = await scanSyntaxFindings(fixtureManifest(), FIXTURE_ROOT);

    expect(
      findings.map(({ workspace, module, symbol, kind, rule }) => ({
        workspace,
        module,
        symbol,
        kind,
        rule,
      })),
    ).toEqual([
      {
        workspace: "apps/example",
        module: "src/finding",
        symbol: "fail",
        kind: "throw",
        rule: "lilac/no-exception-flow",
      },
      {
        workspace: "apps/example",
        module: "src/fixtures/nested-finding",
        symbol: "failInFixture",
        kind: "throw",
        rule: "lilac/no-exception-flow",
      },
    ]);
  });

  it("formats actionable diagnostics with the stable finding digest", () => {
    const finding = {
      workspace: "apps/example",
      module: "src/service",
      symbol: "captureFailure",
      kind: "try-statement",
      digest: "a".repeat(64),
      rule: "lilac/no-exception-flow",
      line: 12,
      column: 5,
      message: "Use object-form Result.try or Result.tryPromise",
    } satisfies SyntaxFinding;

    expect(formatSyntaxDiagnostic(finding)).toBe(
      `apps/example/src/service:12:5 error lilac/no-exception-flow [captureFailure/try-statement] Use object-form Result.try or Result.tryPromise [digest=${"a".repeat(64)}]`,
    );
  });
});
