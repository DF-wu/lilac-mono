import { describe, expect, it } from "bun:test";

import {
  compareFootprint,
  formatAllowlistEntries,
  parseFootprintAllowlist,
} from "../scripts/fork/upstream-footprint";

describe("parseFootprintAllowlist", () => {
  it("reads path/reason entries and skips comments and blank lines", () => {
    const parsed = parseFootprintAllowlist(
      [
        "# header comment",
        "",
        "apps/core/src/a.ts  # registers the fork module",
        "  # indented comment",
        "packages/utils/b.ts  # re-exports fork config  ",
      ].join("\n"),
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.entries).toEqual([
      { path: "apps/core/src/a.ts", reason: "registers the fork module" },
      { path: "packages/utils/b.ts", reason: "re-exports fork config" },
    ]);
  });

  it("reports entries without a reason, empty reasons, and duplicates", () => {
    const parsed = parseFootprintAllowlist(
      [
        "apps/core/src/a.ts",
        "apps/core/src/b.ts  #   ",
        "apps/core/src/c.ts  # first",
        "apps/core/src/c.ts  # second",
      ].join("\n"),
    );

    expect(parsed.entries).toEqual([{ path: "apps/core/src/c.ts", reason: "first" }]);
    expect(parsed.problems).toEqual([
      "line 1: missing '  # <reason>' after the path",
      "line 2: empty reason for apps/core/src/b.ts",
      "line 4: duplicate entry for apps/core/src/c.ts",
    ]);
  });
});

describe("compareFootprint", () => {
  it("splits modified files into covered, unlisted, and stale", () => {
    const comparison = compareFootprint({
      modifiedUpstreamFiles: ["z.ts", "a.ts", "m.ts"],
      allowlist: [
        { path: "m.ts", reason: "kept" },
        { path: "gone.ts", reason: "accepted upstream" },
        { path: "a.ts", reason: "kept" },
      ],
    });

    expect(comparison.covered).toEqual(["a.ts", "m.ts"]);
    expect(comparison.unlisted).toEqual(["z.ts"]);
    expect(comparison.stale).toEqual([{ path: "gone.ts", reason: "accepted upstream" }]);
  });

  it("round-trips formatted entries through the parser", () => {
    const text = formatAllowlistEntries(["b.ts", "a.ts"], "placeholder");
    const parsed = parseFootprintAllowlist(text);

    expect(parsed.problems).toEqual([]);
    expect(parsed.entries.map((entry) => entry.path)).toEqual(["b.ts", "a.ts"]);
    expect(parsed.entries.every((entry) => entry.reason === "placeholder")).toBe(true);
  });
});
