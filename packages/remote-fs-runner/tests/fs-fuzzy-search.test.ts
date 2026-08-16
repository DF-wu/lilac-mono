import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { handleRequest } from "../src/cli";

describe("remote fs runner fuzzy search", () => {
  let root: string;
  let deniedDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "lilac-remote-fuzzy-"));
    deniedDir = path.join(root, "denied");
    await mkdir(deniedDir);
    await writeFile(path.join(root, "allowed-target.ts"), "allowed\n");
    await writeFile(path.join(deniedDir, "denied-target.ts"), "denied\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("uses fzf when deny paths make the FFF index unsafe", async () => {
    const output = await handleRequest({
      op: "fs.fuzzy_search",
      input: { query: "target", maxResults: 10 },
      denyPaths: [deniedDir],
      cwd: root,
    });

    expect(output.error).toBeUndefined();
    expect(output.effectiveBackend).toBe("fzf");
    expect(output.results.map((entry) => entry.path)).toEqual(["allowed-target.ts"]);
  });
});
