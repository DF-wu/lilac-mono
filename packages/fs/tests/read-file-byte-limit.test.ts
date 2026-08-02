import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileSystem } from "../src";

describe("readFile UTF-8 byte limit", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "lilac-read-file-bytes-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("caps raw payload bytes at codepoint boundaries and continues without skips", async () => {
    await writeFile(path.join(root, "unicode.txt"), "A😀BéC");
    const fileSystem = new FileSystem(root);

    const first = await fileSystem.readFile({
      path: "unicode.txt",
      start: { type: "offset", offset: 0 },
      maxCharacters: 100,
      maxBytes: 5,
    });
    expect(first).toMatchObject({
      success: true,
      format: "raw",
      content: "A😀",
      nextStart: { type: "offset", offset: 2 },
      hasMoreLines: true,
      truncatedByChars: false,
    });

    if (!first.success || !first.nextStart) throw new Error("expected continuation");
    const second = await fileSystem.readFile({
      path: "unicode.txt",
      start: first.nextStart,
      maxCharacters: 100,
      maxBytes: 4,
    });
    expect(second).toMatchObject({
      success: true,
      content: "BéC",
      hasMoreLines: false,
    });
  });

  it.each(["numbered", "hashline"] as const)(
    "degrades %s output to raw when required for an exact byte-limited cursor",
    async (format) => {
      await writeFile(path.join(root, "formatted.txt"), "😀x\nnext");
      const result = await new FileSystem(root).readFile({
        path: "formatted.txt",
        format,
        maxCharacters: 100,
        maxBytes: 4,
      });

      expect(result).toMatchObject({
        success: true,
        format: "raw",
        content: "😀",
        nextStart: { type: "line", line: 1, column: 1 },
        hasMoreLines: true,
      });
      if (format === "hashline") {
        expect(result.success && result.degradedFromHashline).toBe(true);
      }
    },
  );

  it("rejects a byte limit too small for one Unicode character", async () => {
    await writeFile(path.join(root, "unicode.txt"), "😀x");

    const result = await new FileSystem(root).readFile({
      path: "unicode.txt",
      start: { type: "offset", offset: 0 },
      maxBytes: 3,
    });

    expect(result).toMatchObject({
      success: false,
      error: { message: "readFile maxBytes must be at least 4 to fit one Unicode character" },
    });
  });
});
