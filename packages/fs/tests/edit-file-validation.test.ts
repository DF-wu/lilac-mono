import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileSystem } from "../src";

describe("editFile input validation", () => {
  let root: string;
  let filePath: string;
  let fileSystem: FileSystem;
  let expectedHash: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "lilac-fs-edit-validation-"));
    filePath = path.join(root, "target.txt");
    await writeFile(filePath, "original\n");
    fileSystem = new FileSystem(root);
    const read = await fileSystem.readFile({ path: filePath });
    if (!read.success) throw new Error("expected fixture read to succeed");
    expectedHash = read.fileHash;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function applyMalformedEdit(edit: unknown) {
    return fileSystem.editFile({
      path: filePath,
      expectedHash,
      // @ts-expect-error Exercises the runtime contract used by untyped and wire callers.
      edits: [edit],
    });
  }

  it("accepts every valid edit variant after decoding", async () => {
    await writeFile(filePath, "alpha\nbeta\ngamma\n");
    const read = await fileSystem.readFile({ path: filePath });
    if (!read.success) throw new Error("expected fixture read to succeed");

    const result = await fileSystem.editFile({
      path: filePath,
      expectedHash: read.fileHash,
      edits: [
        {
          type: "replace_range",
          range: { startLine: 2, endLine: 2 },
          newText: "BETA",
          expectedOldText: "beta",
        },
        { type: "insert_at", line: 2, newText: "inserted" },
        {
          type: "delete_range",
          range: { startLine: 4, endLine: 4 },
          expectedOldText: "gamma",
        },
        {
          type: "replace_snippet",
          target: "inserted",
          matching: "exact",
          newText: "INSERTED",
          occurrence: "all",
          expectedMatches: 1,
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(await Bun.file(filePath).text()).toBe("alpha\nINSERTED\nBETA\n");
  });

  it("preserves the compatibility error for unknown edit variants", async () => {
    const malformedEdit = { type: "move", destination: "other.txt" };

    const result = await applyMalformedEdit(malformedEdit);

    expect(result).toMatchObject({
      success: false,
      error: { code: "INVALID_EDIT", message: "Unknown edit type: move" },
      errors: [
        {
          code: "INVALID_EDIT",
          message: "Unknown edit type: move",
          editIndex: 0,
          edit: malformedEdit,
        },
      ],
    });
    expect(await Bun.file(filePath).text()).toBe("original\n");
  });

  it("rejects malformed known variants before closed-union dispatch", async () => {
    const malformedEdit = { type: "insert_at", line: 1 };

    const result = await applyMalformedEdit(malformedEdit);

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "INVALID_EDIT",
        message: "Invalid edit payload for type: insert_at",
      },
      errors: [
        {
          code: "INVALID_EDIT",
          message: "Invalid edit payload for type: insert_at",
          editIndex: 0,
          edit: malformedEdit,
        },
      ],
    });
    expect(await Bun.file(filePath).text()).toBe("original\n");
  });
});
