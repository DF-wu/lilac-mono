import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { readdir } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUN_BIN = process.execPath;

async function runDockerBuildDryRun(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn([BUN_BIN, "scripts/docker-build.ts", ...args, "--dry-run"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

describe("docker build wrapper", () => {
  it("passes build metadata as explicit build args for docker build", async () => {
    const result = await runDockerBuildDryRun(["build", "-t", "lilac:test", "."]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("LILAC_BUILD_COMMIT=");
    expect(result.stdout).toContain("docker build --build-arg LILAC_BUILD_VERSION=");
    expect(result.stdout).toContain("--build-arg LILAC_BUILD_COMMIT=");
    expect(result.stdout).toContain("--build-arg LILAC_BUILD_DIRTY=");
  });

  it("keeps compose builds on env-driven build args", async () => {
    const result = await runDockerBuildDryRun(["compose-build"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("LILAC_BUILD_COMMIT=");
    expect(result.stdout).toContain("docker compose build");
    expect(result.stdout).not.toContain("--build-arg LILAC_BUILD_COMMIT=");
  });
});

describe("telegram development cleanup", () => {
  it("covers every Telegram test scratch prefix", async () => {
    const script = await Bun.file(path.join(REPO_ROOT, "docker/telegram-dev-cleanup.sh")).text();
    const testDir = path.join(REPO_ROOT, "apps/core/tests/surface/telegram");
    const files = await readdir(testDir);
    const prefixes = new Set<string>();

    for (const file of files.filter((name) => name.endsWith(".test.ts"))) {
      const source = await Bun.file(path.join(testDir, file)).text();
      for (const match of source.matchAll(/mkdtemp\(path\.join\(tmpdir\(\), "([^"]+)"\)\)/gu)) {
        if (match[1]?.startsWith("lilac-telegram-")) prefixes.add(`/tmp/${match[1]}`);
      }
    }

    expect([...prefixes].sort()).toEqual([
      "/tmp/lilac-telegram-e2e-",
      "/tmp/lilac-telegram-it-",
      "/tmp/lilac-telegram-menu-",
      "/tmp/lilac-telegram-outbox-",
      "/tmp/lilac-telegram-poll-",
    ]);
    for (const prefix of prefixes) expect(script).toContain(`"${prefix}"`);
  });
});
