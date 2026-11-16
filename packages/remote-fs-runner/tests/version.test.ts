import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("remote fs runner version", () => {
  it("reports the package version from the built CLI", async () => {
    const packageDir = import.meta.dir.replace(/\/tests$/u, "");
    const built = Bun.spawn(["bun", "run", "build.ts"], {
      cwd: packageDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [buildStderr, buildExitCode] = await Promise.all([
      new Response(built.stderr).text(),
      built.exited,
    ]);
    expect(buildExitCode, buildStderr).toBe(0);

    const versionProcess = Bun.spawn(["node", "dist/cli.js", "--version"], {
      cwd: packageDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(versionProcess.stdout).text(),
      new Response(versionProcess.stderr).text(),
      versionProcess.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("0.0.8");
  });
});

it("builds into an existing directory without deleting its source files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lilac-build-preserve-"));
  try {
    await writeFile(path.join(directory, "source.ts"), "source must survive");
    await writeFile(path.join(directory, "package.json"), '{"private":true}');
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "../build.ts"), "--outdir", directory],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
    expect(await readFile(path.join(directory, "source.ts"), "utf8")).toBe("source must survive");
    expect(await readFile(path.join(directory, "package.json"), "utf8")).toBe('{"private":true}');
    expect(await Bun.file(path.join(directory, "cli.js")).exists()).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
