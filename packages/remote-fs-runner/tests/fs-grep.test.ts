import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { handleRequest } from "../src/cli";

describe("remote fs runner grep", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "lilac-remote-fs-grep-"));
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "target.ts"), "needle target\n");
    await writeFile(path.join(root, "nested", "sibling.ts"), "needle sibling\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("uses the logical file baseDir while launched from its parent", async () => {
    const output = await handleRequest({
      op: "fs.grep",
      input: {
        pattern: "needle",
        baseDir: "target.ts",
        reportedFilePath: "nested/target.ts",
        mode: "hashline",
      },
      denyPaths: [],
      cwd: path.join(root, "nested"),
    });

    expect(output.mode).toBe("hashline");
    expect(output.effectiveBackend).toBe("node-rg");
    if (output.mode !== "hashline") throw new Error("expected hashline grep output");
    expect(output.results).toHaveLength(1);
    expect(output.results[0]).toMatchObject({
      file: "nested/target.ts",
      resolvedPath: path.join(root, "nested", "target.ts"),
      line: 1,
    });
  });
});
