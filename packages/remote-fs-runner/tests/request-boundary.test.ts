import { describe, expect, it } from "bun:test";
import { z } from "zod";

const errorEnvelopeSchema = z.object({ ok: z.literal(false), error: z.string() });

async function runCliRequest(stdin: string) {
  const process = Bun.spawn(["bun", "src/cli.ts", "request"], {
    cwd: import.meta.dir.replace(/\/tests$/u, ""),
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("remote fs CLI stdin boundary", () => {
  it("returns the existing wire error envelope for malformed JSON", async () => {
    const result = await runCliRequest("{");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const envelope = errorEnvelopeSchema.parse(JSON.parse(result.stdout));
    expect(envelope.error).toContain("malformed JSON");
  });

  it("rejects a malformed operation payload before opening the daemon socket", async () => {
    const result = await runCliRequest(
      JSON.stringify({ op: "fs.glob", input: { patterns: [42] }, denyPaths: [] }),
    );

    expect(result.exitCode).toBe(0);
    const envelope = errorEnvelopeSchema.parse(JSON.parse(result.stdout));
    expect(envelope.error).toContain("invalid fs.glob payload");
  });
});
