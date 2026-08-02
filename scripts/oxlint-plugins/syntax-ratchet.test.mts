import { describe, expect, it } from "bun:test";

import {
  evaluateSyntaxRatchet,
  type SyntaxBaseline,
  type SyntaxBaselineEntry,
  type SyntaxFinding,
} from "./check-syntax-ratchet.mts";

function entry(overrides: Partial<SyntaxBaselineEntry> = {}): SyntaxBaselineEntry {
  return {
    workspace: "apps/example",
    module: "src/first",
    symbol: "run",
    kind: "throw",
    digest: "a".repeat(64),
    reason: "Reviewed existing exception flow",
    ...overrides,
  };
}

function finding(overrides: Partial<SyntaxFinding> = {}): SyntaxFinding {
  return {
    ...entry(),
    rule: "lilac/no-exception-flow",
    line: 1,
    column: 1,
    message: "Return a typed Result error",
    ...overrides,
  };
}

describe("repository syntax ratchet", () => {
  it("matches as a repository-wide multiset and cannot hide a multi-file digest collision", () => {
    const first = entry();
    const baseline: SyntaxBaseline = {
      "apps/example": { "lilac/no-exception-flow": [first] },
    };
    const evaluation = evaluateSyntaxRatchet(
      [finding(), finding({ module: "src/second" })],
      baseline,
      new Set(),
    );

    expect(evaluation.matched).toBe(1);
    expect(evaluation.diagnostics).toHaveLength(1);
    expect(evaluation.diagnostics[0]).toMatchObject({
      severity: "error",
      entry: { module: "src/second" },
    });
  });

  it("requires one reviewed baseline entry per identical occurrence", () => {
    const baseline: SyntaxBaseline = {
      "apps/example": { "lilac/no-exception-flow": [entry()] },
    };
    const evaluation = evaluateSyntaxRatchet([finding(), finding()], baseline, new Set());

    expect(evaluation.matched).toBe(1);
    expect(evaluation.diagnostics.filter((item) => item.severity === "error")).toHaveLength(1);
  });

  it("warns for stale entries without failing the package", () => {
    const baseline: SyntaxBaseline = {
      "apps/example": { "lilac/no-exception-flow": [entry()] },
    };
    const evaluation = evaluateSyntaxRatchet([], baseline, new Set());

    expect(evaluation.diagnostics).toEqual([
      expect.objectContaining({ severity: "warning", message: expect.stringContaining("Stale") }),
    ]);
  });

  it("keeps package and rule partitions independent", () => {
    const baseline: SyntaxBaseline = {
      "apps/example": {
        "lilac/no-inline-async-result-callback": [entry({ kind: "inline-async-result-callback" })],
      },
    };
    const evaluation = evaluateSyntaxRatchet([finding()], baseline, new Set());

    expect(evaluation.diagnostics.map((item) => item.severity).sort()).toEqual([
      "error",
      "warning",
    ]);
  });

  it("enforces a zero baseline for migrated packages", () => {
    const baseline: SyntaxBaseline = {
      "apps/example": { "lilac/no-exception-flow": [entry()] },
    };
    const evaluation = evaluateSyntaxRatchet([finding()], baseline, new Set(["apps/example"]));

    expect(evaluation.matched).toBe(0);
    expect(evaluation.diagnostics).toHaveLength(2);
    expect(evaluation.diagnostics.every((item) => item.severity === "error")).toBe(true);
    expect(evaluation.diagnostics[0]?.message).toContain("baselines at zero");
  });

  it("enforces a zero baseline for migrated modules", () => {
    const baseline: SyntaxBaseline = {
      "apps/example": { "lilac/no-exception-flow": [entry()] },
    };
    const evaluation = evaluateSyntaxRatchet(
      [finding()],
      baseline,
      new Set(),
      new Map([["apps/example", ["src/first"]]]),
    );

    expect(evaluation.matched).toBe(0);
    expect(evaluation.diagnostics).toHaveLength(2);
    expect(evaluation.diagnostics.every((item) => item.severity === "error")).toBe(true);
    expect(evaluation.diagnostics[0]?.message).toContain("modules");
  });
});
