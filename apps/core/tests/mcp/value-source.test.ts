import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  resolveJsonPointer,
  resolveMcpValueSource,
  resolveMcpValueSourceMap,
  validateHttpHeaders,
} from "../../src/mcp";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "lilac-mcp-values-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("MCP value sources", () => {
  it("resolves inline, environment, whole-file, and JSON Pointer values", async () => {
    const baseDir = await createTemporaryDirectory();
    await writeFile(path.join(baseDir, "token.txt"), "file-token\n", "utf8");
    await writeFile(
      path.join(baseDir, "values.json"),
      JSON.stringify({ "a/b": { "c~d": ["zero", "selected"] } }),
      "utf8",
    );
    const context = { baseDir, env: { TOKEN: "environment-token" } };

    expect(await resolveMcpValueSource("inline", context)).toEqual({
      ok: true,
      value: "inline",
    });
    expect(await resolveMcpValueSource({ env: "TOKEN" }, context)).toEqual({
      ok: true,
      value: "environment-token",
    });
    expect(await resolveMcpValueSource({ file: "token.txt" }, context)).toEqual({
      ok: true,
      value: "file-token",
    });
    expect(
      await resolveMcpValueSource({ file: "values.json", pointer: "/a~1b/c~0d/1" }, context),
    ).toEqual({ ok: true, value: "selected" });
  });

  it("returns contextual failures without exposing other resolved values", async () => {
    const baseDir = await createTemporaryDirectory();
    const result = await resolveMcpValueSourceMap(
      { GOOD: "secret-good", BAD: { env: "MISSING" } },
      { baseDir, env: {} },
    );
    expect(result).toEqual({
      ok: false,
      error: "BAD: environment variable MISSING is not set",
    });
    expect(JSON.stringify(result)).not.toContain("secret-good");
  });

  it("rejects invalid pointers, non-string targets, and unsafe headers", async () => {
    expect(() => resolveJsonPointer({ value: "x" }, "/missing")).toThrow("does not exist");
    expect(() => resolveJsonPointer({ value: "x" }, "/bad~2escape")).toThrow("invalid escaping");

    const baseDir = await createTemporaryDirectory();
    await writeFile(path.join(baseDir, "values.json"), JSON.stringify({ count: 1 }), "utf8");
    expect(
      (
        await resolveMcpValueSource(
          { file: "values.json", pointer: "/count" },
          { baseDir, env: {} },
        )
      ).ok,
    ).toBe(false);

    expect(validateHttpHeaders({ "X-Valid": "value" })).toEqual({ ok: true });
    expect(validateHttpHeaders({ "Bad Header": "value" }).ok).toBe(false);
    expect(validateHttpHeaders({ "X-Unsafe": "first\r\nsecond" }).ok).toBe(false);
  });
});
