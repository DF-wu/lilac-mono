import { describe, expect, it, spyOn } from "bun:test";
import fs, { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Panic } from "better-result";

import {
  applyHashlineEdits,
  canonicalizePathAsFarAsExists,
  captureFilesystemOperation,
  decodeRipgrepMatchLine,
  ripgrep,
} from "../src";

describe("filesystem operational Results", () => {
  it("maps classified filesystem failures to an owned Result error", async () => {
    const result = await captureFilesystemOperation("read fixture", async () => {
      return await Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
    });

    expect(result.status).toBe("error");
    if (result.status === "ok") return;
    expect(result.error).toMatchObject({
      _tag: "FileSystemOperationFailed",
      operation: "read fixture",
      code: "ENOENT",
      message: "missing",
    });
  });

  it("preserves Panic and unclassified defects", async () => {
    const panic = new Panic({ message: "fixture panic" });
    const defect = new Error("fixture defect");

    expect(
      captureFilesystemOperation("panic fixture", async () => await Promise.reject(panic)),
    ).rejects.toBe(panic);
    expect(
      captureFilesystemOperation("defect fixture", async () => await Promise.reject(defect)),
    ).rejects.toBe(defect);
  });

  it("fails closed on canonicalization permission errors and preserves Panic identity", async () => {
    for (const code of ["EACCES", "EPERM"] as const) {
      const realpath = spyOn(fs, "realpath").mockRejectedValueOnce(
        Object.assign(new Error(code), { code }),
      );
      try {
        const result = await canonicalizePathAsFarAsExists("/permission-fixture/child");
        expect(result).toMatchObject({
          status: "error",
          error: { _tag: "FileSystemOperationFailed", code },
        });
      } finally {
        realpath.mockRestore();
      }
    }

    const panic = new Panic({ message: "canonicalization invariant" });
    const realpath = spyOn(fs, "realpath").mockRejectedValueOnce(panic);
    try {
      await expect(canonicalizePathAsFarAsExists("/panic-fixture/child")).rejects.toBe(panic);
    } finally {
      realpath.mockRestore();
    }
  });

  it("returns hashline validation failures as values", () => {
    const result = applyHashlineEdits({
      content: "alpha\n",
      edits: [{ op: "replace", pos: "1#0000", lines: ["beta"] }],
    });

    expect(result.status).toBe("error");
    if (result.status === "ok") return;
    expect(result.error).toMatchObject({ _tag: "HashlineEditFailed", code: "STALE_ANCHOR" });
  });
});

describe("ripgrep output decoding", () => {
  it("decodes a complete match event and ignores non-match events", () => {
    const match = decodeRipgrepMatchLine(
      JSON.stringify({
        type: "match",
        data: {
          path: { text: "src/index.ts" },
          line_number: 2,
          lines: { text: "needle\n" },
          submatches: [{ match: { text: "needle" }, start: 0, end: 6 }],
        },
      }),
    );
    const nonMatch = decodeRipgrepMatchLine(JSON.stringify({ type: "summary", data: {} }));

    expect(match).toMatchObject({
      status: "ok",
      value: { file: "src/index.ts", line: 2, column: 1, text: "needle\n" },
    });
    expect(nonMatch).toMatchObject({ status: "ok", value: null });
  });

  it("owns malformed JSON as a decode error", () => {
    const result = decodeRipgrepMatchLine("{");

    expect(result.status).toBe("error");
    if (result.status === "ok") return;
    expect(result.error._tag).toBe("RipgrepLineMalformed");
  });

  it("returns a typed error when the ripgrep process emits a malformed line", async () => {
    const binDir = await mkdtemp(path.join(tmpdir(), "lilac-malformed-ripgrep-"));
    const executable = path.join(binDir, "rg");
    const originalPath = process.env.PATH;
    await writeFile(executable, "#!/bin/sh\nprintf 'not-json\\n'\n", "utf8");
    await chmod(executable, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const result = await ripgrep({ cwd: binDir, pattern: "fixture" });

      expect(result.status).toBe("error");
      if (result.status === "ok") return;
      expect(result.error._tag).toBe("RipgrepLineMalformed");
    } finally {
      process.env.PATH = originalPath;
      await rm(binDir, { recursive: true, force: true });
    }
  });
});
