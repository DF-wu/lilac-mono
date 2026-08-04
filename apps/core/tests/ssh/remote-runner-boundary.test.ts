import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Panic } from "better-result";
import { z } from "zod";

import {
  bundledRemoteRunnerErrorMessage,
  rethrowBundledRemoteRunnerPanic,
} from "../../src/ssh/remote-js/bundled-runner-failure";
import { opaqueErrorCause } from "../../src/ssh/remote-js/remote-runner-utils";

const runnerPath = path.resolve(import.meta.dir, "../../src/ssh/remote-js/remote-runner.cjs");
const errorEnvelopeSchema = z.object({ ok: z.literal(false), error: z.string() });

async function runBundledRunner(stdin: string, cwd?: string) {
  const process = Bun.spawn(["bun", runnerPath], {
    cwd,
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

describe("bundled remote runner stdin boundary", () => {
  it("rejects malformed JSON through the compatible wire envelope", async () => {
    const result = await runBundledRunner("{");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const envelope = errorEnvelopeSchema.parse(JSON.parse(result.stdout));
    expect(envelope.error).toContain("malformed JSON");
  });

  it("rejects unknown edit variants before filesystem execution", async () => {
    const result = await runBundledRunner(
      JSON.stringify({
        op: "fs.edit",
        denyPaths: [],
        input: { path: "a.ts", edits: [{ type: "future" }] },
      }),
    );

    const envelope = errorEnvelopeSchema.parse(JSON.parse(result.stdout));
    expect(envelope.error).toContain("invalid fs.edit payload");
  });

  it("preserves Panic at the bundled runner top level", () => {
    const panic = new Panic({ message: "bundled runner invariant" });

    expect(() => rethrowBundledRemoteRunnerPanic(panic)).toThrow(panic);
  });

  it("contains revoked proxy classification and formatting at the bundled runner top level", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    const projected = opaqueErrorCause(proxy, "Opaque bundled remote runner failure");
    const error = rethrowBundledRemoteRunnerPanic(projected);
    expect(bundledRemoteRunnerErrorMessage(error)).toBe("Opaque bundled remote runner failure");
  });

  it("denies byte reads through a symlink into a blocked directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lilac-bundled-read-deny-"));
    const deniedDir = path.join(root, "denied");
    const visibleDir = path.join(root, "visible");
    try {
      await mkdir(deniedDir);
      await mkdir(visibleDir);
      await writeFile(path.join(deniedDir, "secret.png"), "secret");
      await symlink(deniedDir, path.join(visibleDir, "alias"), "dir");

      const result = await runBundledRunner(
        JSON.stringify({
          op: "fs.read_bytes",
          denyPaths: [deniedDir],
          input: { path: "visible/alias/secret.png" },
        }),
        root,
      );
      const envelope = z
        .object({
          ok: z.literal(true),
          value: z.object({ ok: z.literal(false), error: z.string() }),
        })
        .parse(JSON.parse(result.stdout));

      expect(envelope.value.error).toContain("Access denied");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies apply_patch through symlinked and nonexistent target parents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lilac-bundled-patch-deny-"));
    const deniedDir = path.join(root, "denied");
    const visibleDir = path.join(root, "visible");
    try {
      await mkdir(deniedDir);
      await mkdir(visibleDir);
      await symlink(deniedDir, path.join(visibleDir, "alias"), "dir");
      const target = path.join(deniedDir, "missing", "created.txt");
      const patchText = [
        "*** Begin Patch",
        "*** Add File: visible/alias/missing/created.txt",
        "+blocked",
        "*** End Patch",
      ].join("\n");

      const result = await runBundledRunner(
        JSON.stringify({ op: "apply_patch", denyPaths: [deniedDir], input: { patchText } }),
        root,
      );
      const envelope = errorEnvelopeSchema.parse(JSON.parse(result.stdout));

      expect(envelope.error).toContain("Access denied");
      await expect(readFile(target, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies apply_patch descendants when the filesystem root is denied", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lilac-bundled-patch-root-deny-"));
    const target = path.join(root, "created.txt");
    try {
      const patchText = [
        "*** Begin Patch",
        "*** Add File: created.txt",
        "+blocked",
        "*** End Patch",
      ].join("\n");

      const result = await runBundledRunner(
        JSON.stringify({
          op: "apply_patch",
          denyPaths: [path.parse(root).root],
          input: { patchText },
        }),
        root,
      );
      const envelope = errorEnvelopeSchema.parse(JSON.parse(result.stdout));

      expect(envelope.error).toContain("Access denied");
      await expect(readFile(target, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
