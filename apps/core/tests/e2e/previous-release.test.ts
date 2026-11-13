import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("release selection falls back to remote ancestors and rejects unrelated overrides", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lilac-release-selection-"));
  const checkout = path.join(root, "checkout");
  await mkdir(checkout);
  async function git(...args: string[]) {
    const child = Bun.spawn(["git", ...args], {
      cwd: checkout,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Catalina",
        GIT_AUTHOR_EMAIL: "df_catalina@dfder.tw",
        GIT_COMMITTER_NAME: "Catalina",
        GIT_COMMITTER_EMAIL: "df_catalina@dfder.tw",
      },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code) throw new Error(stderr);
    return stdout.trim();
  }
  try {
    await git("init");
    await writeFile(path.join(checkout, "source"), "old");
    await git("add", ".");
    await git("commit", "-m", "Old release");
    await git("tag", "build-old-1-1");
    await writeFile(path.join(checkout, "source"), "new");
    await git("add", ".");
    await git("commit", "-m", "Current release");
    await git("tag", "build-head-2-1");
    const unrelated = await git("commit-tree", "HEAD^{tree}", "-m", "Unrelated release");
    await git("tag", "build-unrelated-3-1", unrelated);
    await git("clone", "--bare", checkout, path.join(root, "origin"));
    await git("remote", "add", "origin", path.join(root, "origin"));
    await git("tag", "-d", "build-old-1-1");
    const module = path.join(checkout, "apps/core/tests/e2e/harness/previous-release.ts");
    await mkdir(path.dirname(module), { recursive: true });
    await copyFile(path.join(import.meta.dir, "harness/previous-release.ts"), module);
    async function select(override = "") {
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `const { previousTag } = await import(${JSON.stringify(module)}); console.log(await previousTag());`,
        ],
        {
          cwd: checkout,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, LILAC_E2E_PREVIOUS_TAG: override },
        },
      );
      return {
        code: await child.exited,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      };
    }
    const selected = await select();
    expect(selected.code, selected.stderr).toBe(0);
    expect(selected.stdout.trim()).toBe("build-old-1-1");
    const invalid = await select("build-unrelated-3-1");
    expect(invalid.code).not.toBe(0);
    expect(invalid.stderr).toContain("not a predecessor");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
