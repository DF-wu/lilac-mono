import { describe, expect, it } from "bun:test";

import {
  formatSessionTitle,
  formatTokenUsage,
  resolveContextWindow,
  sessionPresentation,
} from "./presentation";

describe("presentation formatting", () => {
  it("derives rounded context usage and hides unavailable values", () => {
    expect(formatTokenUsage(12_500, 50_000)).toBe("12.5K (25%)");
    expect(formatTokenUsage(0, 128_000)).toBe("0 (0%)");
    expect(formatTokenUsage(null, 128_000)).toBeUndefined();
    expect(formatTokenUsage(12_500, null)).toBeUndefined();
  });

  it("names the compaction threshold only once usage approaches it", () => {
    const threshold = { compactionThreshold: 0.8 };
    expect(formatTokenUsage(32_000, 100_000, threshold)).toBe("32K (32%)");
    expect(formatTokenUsage(74_000, 100_000, threshold)).toBe("74K (74% · compacts at 80%)");
    // A post-compaction estimate is marked so the drop is not read as measured.
    expect(formatTokenUsage(9_200, 100_000, { estimated: true })).toBe("~9.2K (9%)");
  });

  it("falls back to catalog context limits for migrated resumed sessions", () => {
    expect(resolveContextWindow(null, 128_000)).toBe(128_000);
    expect(resolveContextWindow(64_000, 128_000)).toBe(64_000);
    expect(resolveContextWindow(null, undefined)).toBeNull();
  });

  it("limits source titles to one hundred characters", () => {
    const title = formatSessionTitle("x".repeat(101));
    expect(Array.from(title)).toHaveLength(100);
    expect(title.endsWith("...")).toBe(true);
  });

  it("normalizes absent snapshot presentation fields", () => {
    expect(sessionPresentation(undefined)).toEqual({
      title: "Mini Lilac",
      inputTokens: null,
      inputTokensEstimated: false,
      contextWindow: null,
      compactionThreshold: null,
    });
    expect(
      sessionPresentation({ title: "Fix streaming", inputTokens: 4_000, contextWindow: 16_000 }),
    ).toEqual({
      title: "Fix streaming",
      inputTokens: 4_000,
      inputTokensEstimated: false,
      contextWindow: 16_000,
      compactionThreshold: null,
    });
  });
});
