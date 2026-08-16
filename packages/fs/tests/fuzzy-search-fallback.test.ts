import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileSystem } from "../src";

describe("fzf fuzzy search fallback", () => {
  let root: string;
  let deniedDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "lilac-fzf-fallback-"));
    deniedDir = path.join(root, "denied");
    await mkdir(path.join(root, "src"));
    await mkdir(deniedDir);
    await writeFile(path.join(root, "src", "allowed-target.ts"), "allowed\n");
    await writeFile(path.join(root, "src", "unrelated.ts"), "unrelated\n");
    await writeFile(path.join(deniedDir, "denied-target.ts"), "denied\n");
    await symlink(path.join(root, "src", "allowed-target.ts"), path.join(root, "target-alias.ts"));
    await symlink(deniedDir, path.join(root, "denied-alias"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("prunes denied descendants and omits symlinks during on-demand search", async () => {
    const result = await new FileSystem(root, {
      denyPaths: [deniedDir],
      fsBackend: "fff",
      fuzzySearchFallback: "fzf",
    }).fuzzySearchFiles({ query: "target", maxResults: 10 });

    expect(result.error).toBeUndefined();
    expect(result.effectiveBackend).toBe("fzf");
    expect(result.totalFiles).toBe(2);
    expect(result.totalMatched).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.results).toEqual([
      {
        path: "src/allowed-target.ts",
        fileName: "allowed-target.ts",
        size: 8,
        gitStatus: "unknown",
        score: expect.any(Number),
        matchType: "fuzzy",
      },
    ]);
  });

  it("reports truncation from the complete fallback match set", async () => {
    await writeFile(path.join(root, "src", "second-target.ts"), "second\n");
    const result = await new FileSystem(root, {
      denyPaths: [deniedDir],
      fsBackend: "fff",
      fuzzySearchFallback: "fzf",
    }).fuzzySearchFiles({ query: "target", maxResults: 1 });

    expect(result.error).toBeUndefined();
    expect(result.results).toHaveLength(1);
    expect(result.totalMatched).toBe(2);
    expect(result.truncated).toBe(true);
  });
});
