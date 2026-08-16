import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_SERVER_URL, HELP_TEXT, parseCliOptions } from "./cli";

function options(input: Parameters<typeof parseCliOptions>[0]) {
  const result = parseCliOptions(input);
  if (result.status === "error") throw new Error("expected CLI options");
  return result.value;
}

describe("parseCliOptions bearer token", () => {
  it("uses only explicit or Mini Lilac-specific credentials", () => {
    const input = { argv: [], cwd: process.cwd() };

    expect(
      options({
        ...input,
        env: { MINI_LILAC_TOKEN: " mini-token ", TOKEN: "ambient-token" },
      }).token,
    ).toBe("mini-token");
    expect(options({ ...input, env: { TOKEN: "ambient-token" } }).token).toBeUndefined();
    expect(
      options({
        ...input,
        argv: ["--server", DEFAULT_SERVER_URL, "--token", " explicit-token "],
        env: { MINI_LILAC_TOKEN: "mini-token" },
      }).token,
    ).toBe("explicit-token");
  });

  it("returns an owned error when cwd canonicalization fails", () => {
    const result = parseCliOptions({
      argv: [],
      env: {},
      cwd: join(tmpdir(), `missing-mini-lilac-cwd-${crypto.randomUUID()}`),
    });

    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error._tag).toBe("CliArgumentsInvalid");
  });
});

describe("help text", () => {
  it("discovers undo, rollback, and redo", () => {
    expect(HELP_TEXT).toContain("/undo");
    expect(HELP_TEXT).toContain("/rollback");
    expect(HELP_TEXT).toContain("/redo");
  });
});
