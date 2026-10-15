import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { asSchema } from "ai";

import {
  createEditFileInputSchema,
  createGrepInputSchema,
  createReadFileInputSchema,
  loadReadFileInstructions,
  createReadFileInstructionClaims,
} from "../src";
import { BufferedFileSink } from "../src/buffered-file-sink";

describe("coding tools", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "lilac-coding-tools-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("buffers persistent spool writes into configured blocks", async () => {
    const filePath = path.join(cwd, "buffered-sink.log");
    const sink = await BufferedFileSink.open(filePath, { flags: "wx", blockBytes: 8 });

    await sink.write("abc");
    expect((await stat(filePath)).size).toBe(0);
    await sink.write("defghijk");
    expect((await stat(filePath)).size).toBe(8);
    await sink.close();

    expect(await readFile(filePath, "utf8")).toBe("abcdefghijk");
  });

  it("exports hashline schema factories for stateful runtime adapters", async () => {
    const readSchema = createReadFileInputSchema({ hashlineEnabled: true });
    const grepSchema = createGrepInputSchema(true);
    const editSchema = createEditFileInputSchema(true);
    expect(readSchema.safeParse({ path: "a.ts", format: "hashline" }).success).toBe(true);
    expect(grepSchema.safeParse({ pattern: "needle", mode: "hashline" }).success).toBe(true);
    expect(grepSchema.safeParse({ pattern: "needle", path: "src" }).success).toBe(true);
    expect(grepSchema.safeParse({ pattern: "needle", cwd: "src" }).success).toBe(false);
    expect(grepSchema.safeParse({ pattern: "needle", includeContextLines: 1 }).success).toBe(false);
    expect(
      editSchema.safeParse({
        path: "a.ts",
        edits: [{ op: "replace", pos: "1#abcd", lines: ["next"] }],
      }).success,
    ).toBe(true);
    expect(editSchema.safeParse({ path: "a.ts", oldText: "a", newText: "b" }).success).toBe(false);

    const readJsonSchema = await asSchema(readSchema).jsonSchema;
    const serialized = JSON.stringify(readJsonSchema);
    expect(serialized).toContain('"hashline"');
    expect(serialized).toContain("runtime adapter has SSH configured");
  });

  it("loads nested instructions once per read context and recognizes prior tool output", async () => {
    const nestedDirectory = path.join(cwd, "src");
    await mkdir(nestedDirectory);
    const rootInstructions = path.join(cwd, "AGENTS.md");
    const nestedInstructions = path.join(nestedDirectory, "AGENTS.md");
    await writeFile(rootInstructions, "Root rules.");
    await writeFile(nestedInstructions, "Nested rules.");
    const params = {
      resolvedPath: path.join(nestedDirectory, "file.txt"),
      cwd,
      preloadedInstructionPaths: [rootInstructions],
      messages: [],
    };
    const first = await loadReadFileInstructions(params);
    expect(first?.loaded).toEqual([nestedInstructions]);
    expect(first?.text).toContain("<system-reminder>");
    expect(first?.text).toContain("Nested rules.");
    expect(first?.text).not.toContain("Root rules.");

    for (const output of [
      { type: "json", value: { loadedInstructions: first?.loaded, instructionsText: first?.text } },
      { type: "content", value: [{ type: "text", text: first?.text }] },
    ]) {
      expect(
        await loadReadFileInstructions({
          ...params,
          messages: [
            { role: "tool", content: [{ type: "tool-result", toolName: "read", output }] },
          ],
        }),
      ).toBeNull();
    }

    const claims = createReadFileInstructionClaims();
    const claimedInstructionPaths = claims.forMessages(params.messages);
    const concurrent = await Promise.all([
      loadReadFileInstructions({ ...params, claimedInstructionPaths }),
      loadReadFileInstructions({ ...params, claimedInstructionPaths }),
    ]);
    expect(concurrent.filter(Boolean)).toHaveLength(1);
    expect(
      await loadReadFileInstructions({
        ...params,
        claimedInstructionPaths: claims.forMessages([]),
      }),
    ).not.toBeNull();
    expect(
      await loadReadFileInstructions({ ...params, resolvedPath: nestedInstructions }),
    ).toBeNull();
  });

  it("does not load instruction symlinks outside the workspace or into denied paths", async () => {
    const nestedDirectory = path.join(cwd, "src");
    const protectedInstructions = path.join(cwd, "protected.md");
    await mkdir(nestedDirectory);
    await writeFile(protectedInstructions, "Protected rules.");
    await symlink(protectedInstructions, path.join(nestedDirectory, "AGENTS.md"));
    expect(
      await loadReadFileInstructions({
        resolvedPath: path.join(nestedDirectory, "file.txt"),
        cwd,
        denyPaths: [protectedInstructions],
        messages: [],
      }),
    ).toBeNull();
    expect(
      await loadReadFileInstructions({
        resolvedPath: path.join(nestedDirectory, "file.txt"),
        cwd: nestedDirectory,
        messages: [],
      }),
    ).toBeNull();
  });
});
