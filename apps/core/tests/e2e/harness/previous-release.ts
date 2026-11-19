/**
 * Extracts the newest release build older than HEAD so upgrade scenarios can run the code that
 * wrote existing data. Release builds are tagged `build-<sha>-<run id>-<attempt>`.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dir, "../../../../..");

async function git(args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout.trim();
}

function runId(tag: string): number {
  return Number(tag.split("-")[2] ?? 0);
}

async function localTags(): Promise<string[]> {
  const listed = await git(["tag", "--list", "build-*"]);
  return listed ? listed.split("\n") : [];
}

/** Selects an actual ancestor release, including when local tags contain only HEAD. */
export async function previousTag(): Promise<string> {
  if ((await git(["rev-parse", "--is-shallow-repository"])) === "true")
    await git(["fetch", "--unshallow", "--no-tags", "origin"]);
  const head = await git(["rev-parse", "HEAD"]);
  async function select(tags: string[]): Promise<string | undefined> {
    const local = new Set(await localTags());
    for (const tag of tags.toSorted((left, right) => runId(right) - runId(left))) {
      if (!local.has(tag))
        await git(["fetch", "--no-tags", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
      if ((await git(["rev-list", "-n1", tag])) === head) continue;
      const check = Bun.spawn(["git", "merge-base", "--is-ancestor", tag, "HEAD"], {
        cwd: REPO_ROOT,
        stdout: "ignore",
        stderr: "pipe",
      });
      const [code, error] = await Promise.all([check.exited, new Response(check.stderr).text()]);
      if (code === 0) return tag;
      if (code !== 1) throw new Error(`Could not verify release ancestry: ${error}`);
    }
    return undefined;
  }
  const pinned = process.env.LILAC_E2E_PREVIOUS_TAG;
  if (pinned) {
    const selected = await select([pinned]);
    if (!selected) throw new Error(`${pinned} is not a predecessor of HEAD`);
    return selected;
  }
  const local = await select(await localTags());
  if (local) return local;
  const remote = await git(["ls-remote", "--tags", "--refs", "origin", "build-*"]);
  const selected = await select(
    remote.split("\n").flatMap((line) => {
      const tag = line.split("refs/tags/")[1];
      return tag ? [tag] : [];
    }),
  );
  if (!selected) throw new Error("No predecessor release tag (build-*) is available");
  return selected;
}

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${command.join(" ")} failed:\n${stdout}\n${stderr}`);
}

export type PreviousRelease = { tag: string; root: string };

/** A ready checkout of the previous release, cached under node_modules/.cache by tag. */
export async function previousRelease(): Promise<PreviousRelease> {
  const tag = await previousTag();
  const root = path.join(REPO_ROOT, "node_modules/.cache/lilac-e2e-previous", tag);
  const marker = path.join(root, ".lilac-e2e-ready");
  if (existsSync(marker) && (await readFile(marker, "utf8")) === tag) return { tag, root };
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  // `git archive` needs no worktree registration and works in shallow clones.
  const archive = Bun.spawn(["git", "archive", "--format=tar", tag], {
    cwd: REPO_ROOT,
    stdout: "pipe",
  });
  const extract = Bun.spawn(["tar", "-x", "-C", root], { stdin: archive.stdout });
  if ((await archive.exited) !== 0 || (await extract.exited) !== 0)
    throw new Error(`Could not extract ${tag}`);
  await run([process.execPath, "install", "--frozen-lockfile"], root);
  await writeFile(marker, tag);
  return { tag, root };
}
