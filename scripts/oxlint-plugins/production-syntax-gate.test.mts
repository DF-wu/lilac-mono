import { describe, expect, it } from "bun:test";

import {
  formatSyntaxDiagnostic,
  scanSyntaxFindings,
  type SyntaxFinding,
} from "./check-production-syntax.mts";
import { FINAL_PACKAGE_WIDE_SYNTAX_RULES } from "./syntax-policy.mts";

const REPOSITORY_SCAN_TIMEOUT_MS = 120_000;

describe("repository syntax gate", () => {
  it("declares every permanent package-wide syntax rule", () => {
    expect(FINAL_PACKAGE_WIDE_SYNTAX_RULES).toEqual([
      "no-nested-ternary",
      "lilac/no-local-is-record",
      "lilac/no-exception-flow",
      "lilac/no-inline-async-result-callback",
      "lilac/no-presentation-decoder-import",
      "lilac/no-store-inline-decoding",
      "lilac/no-direct-sqlite-transaction",
    ]);
  });

  it(
    "has no suppressible production findings",
    async () => {
      expect(await scanSyntaxFindings()).toEqual([]);
    },
    REPOSITORY_SCAN_TIMEOUT_MS,
  );

  it("formats actionable diagnostics with the stable finding digest", () => {
    const finding = {
      workspace: "apps/example",
      module: "src/service",
      symbol: "captureFailure",
      kind: "catch-clause",
      digest: "a".repeat(64),
      rule: "lilac/no-exception-flow",
      line: 12,
      column: 5,
      message: "Capture the external exception in an exactly registered adapter",
    } satisfies SyntaxFinding;

    expect(formatSyntaxDiagnostic(finding)).toBe(
      `apps/example/src/service:12:5 error lilac/no-exception-flow [captureFailure/catch-clause] Capture the external exception in an exactly registered adapter [digest=${"a".repeat(64)}]`,
    );
  });
});
