import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileSystem, type FsBackend } from "../src";

const backends = ["node-rg", "fff"] satisfies readonly FsBackend[];

describe("grep single-file targets", () => {
  let root: string;
  let targetPath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "lilac-fs-grep-file-"));
    targetPath = path.join(root, "nested", "target.ts");
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, "first\nneedle target\n");
    await writeFile(path.join(root, "nested", "sibling.ts"), "needle sibling\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const backend of backends) {
    it(`searches only the selected file with ${backend}`, async () => {
      const fsTool = new FileSystem(root, {
        fsBackend: backend,
        fffCacheDir: path.join(root, `.fff-cache-${backend}`),
      });

      const result = await fsTool.grep({
        pattern: "needle",
        baseDir: "nested/target.ts",
        fileExtensions: [".ts"],
        mode: "detailed",
      });

      expect(result.error).toBeUndefined();
      expect(result.mode).toBe("detailed");
      expect(result.effectiveBackend).toBe("node-rg");
      if (result.mode !== "detailed") throw new Error("expected detailed grep output");
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        file: "nested/target.ts",
        line: 2,
        column: 1,
        text: "needle target\n",
      });
    });
  }

  it("honors extension filters for a selected file", async () => {
    const fsTool = new FileSystem(root);
    const result = await fsTool.grep({
      pattern: "needle",
      baseDir: "nested/target.ts",
      fileExtensions: ["js"],
    });

    expect(result.results).toEqual([]);
  });

  it("returns canonical hashline resolution and the selected path", async () => {
    const fsTool = new FileSystem(root);
    const read = await fsTool.readFile({ path: "nested/target.ts" });
    if (!read.success) throw new Error("expected target read to succeed");

    const result = await fsTool.grep({
      pattern: "needle",
      baseDir: "nested/target.ts",
      mode: "hashline",
    });

    expect(result.mode).toBe("hashline");
    if (result.mode !== "hashline") throw new Error("expected hashline grep output");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      file: "nested/target.ts",
      resolvedPath: targetPath,
      fileHash: read.fileHash,
      line: 2,
    });
  });

  it("authorizes hashline editing through an allowed file symlink", async () => {
    const aliasPath = path.join(root, "target-alias.ts");
    await symlink(targetPath, aliasPath);
    const fsTool = new FileSystem(root);
    const grep = await fsTool.grep({
      pattern: "needle target",
      baseDir: "target-alias.ts",
      mode: "hashline",
    });
    if (grep.mode !== "hashline") throw new Error("expected hashline grep output");
    const position = grep.results[0]?.text.split("|")[0];
    if (!position) throw new Error("expected hashline anchor");

    const edit = await fsTool.hashlineEditFile({
      path: "target-alias.ts",
      edits: [{ op: "replace", pos: position, lines: ["replacement"] }],
    });

    expect(edit.success).toBe(true);
    expect(await Bun.file(targetPath).text()).toBe("first\nreplacement\n");
  });
});
