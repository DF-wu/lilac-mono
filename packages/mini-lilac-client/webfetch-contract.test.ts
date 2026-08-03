import { describe, expect, it } from "bun:test";

import {
  MINI_LILAC_WEBFETCH_MAX_URL_CHARACTERS,
  miniLilacWebfetchUrlSchema,
} from "./webfetch-contract";

describe("Mini Lilac webfetch URL contract", () => {
  it("normalizes valid HTTP URLs and rejects unsafe or oversized URLs", () => {
    expect(miniLilacWebfetchUrlSchema.parse("  https://example.test/path  ")).toBe(
      "https://example.test/path",
    );
    for (const url of [
      "ftp://example.test/file",
      "https://user:secret@example.test/path",
      `https://example.test/${"x".repeat(MINI_LILAC_WEBFETCH_MAX_URL_CHARACTERS)}`,
    ]) {
      expect(miniLilacWebfetchUrlSchema.safeParse(url).success).toBe(false);
    }
  });

  it("returns bounded credential-safe issues for malformed URL strings", () => {
    for (const value of [
      "not-a-url-secret-token",
      "https://[invalid-bracket-secret-token",
      "https://user:credential-secret@[invalid",
    ]) {
      let result: ReturnType<typeof miniLilacWebfetchUrlSchema.safeParse> | undefined;
      expect(() => {
        result = miniLilacWebfetchUrlSchema.safeParse(value);
      }).not.toThrow();
      expect(result?.success).toBe(false);
      if (result?.success !== false) throw new Error("expected malformed webfetch URL");
      const issues = JSON.stringify(result.error.issues);
      expect(issues).not.toContain(value);
      expect(issues).not.toContain("secret-token");
      expect(issues.length).toBeLessThan(1_024);
    }
  });
});
