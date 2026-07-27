import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { env } from "@stanley2058/lilac-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fsTool } from "../../src/tools/fs/fs";

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

async function resolveExecuteResult<T>(value: T | PromiseLike<T> | AsyncIterable<T>): Promise<T> {
  if (!isAsyncIterable(value)) return await value;

  let last: T | undefined;
  for await (const chunk of value) last = chunk;
  if (last === undefined) throw new Error("AsyncIterable tool execute produced no values");
  return last;
}

function toolOptions(toolCallId: string) {
  return { toolCallId, messages: [], context: {} };
}

describe("Core filesystem MCP credential guards", () => {
  let dataDir: string;
  let credentialPath: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-mcp-fs-guard-"));
    credentialPath = path.join(dataDir, "secret", "mcp-oauth", "docs.json");
    await fs.mkdir(path.dirname(credentialPath), { recursive: true });
    await fs.writeFile(credentialPath, '{"accessToken":"credential-value"}\n', "utf8");
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("includes the configured DATA_DIR secret tree in read_file's default denylist", async () => {
    const tools = fsTool(dataDir);
    const defaultCredentialPath = path.join(
      env.dataDir,
      "secret",
      "mcp-oauth",
      "does-not-need-to-exist.json",
    );
    const output = await resolveExecuteResult(
      tools.read_file.execute!({ path: defaultCredentialPath }, toolOptions("default-read")),
    );

    expect(output).toMatchObject({ success: false, error: { code: "PERMISSION" } });
  });

  it("denies read, glob, grep, and edit access to MCP credential paths normally", async () => {
    const tools = fsTool(dataDir, {
      includeEditFile: true,
      denyPaths: [path.join(dataDir, "secret")],
    });
    if (!("edit_file" in tools)) throw new Error("expected edit_file tool");
    const relativeCredentialPath = path.relative(dataDir, credentialPath);

    const read = await resolveExecuteResult(
      tools.read_file.execute!({ path: relativeCredentialPath }, toolOptions("read")),
    );
    expect(read).toMatchObject({ success: false, error: { code: "PERMISSION" } });

    const glob = await resolveExecuteResult(
      tools.glob.execute!({ patterns: ["secret/mcp-oauth/**/*.json"] }, toolOptions("glob")),
    );
    expect(glob).toMatchObject({ mode: "default", paths: [] });

    const grep = await resolveExecuteResult(
      tools.grep.execute!({ pattern: "credential-value" }, toolOptions("grep")),
    );
    expect(grep).toMatchObject({ mode: "default", results: [] });

    const edit = await resolveExecuteResult(
      tools.edit_file.execute!(
        {
          path: relativeCredentialPath,
          oldText: "credential-value",
          newText: "changed",
        },
        toolOptions("edit"),
      ),
    );
    expect(edit).toMatchObject({ success: false, error: { code: "PERMISSION" } });
    expect(await fs.readFile(credentialPath, "utf8")).toContain("credential-value");
  });
});
