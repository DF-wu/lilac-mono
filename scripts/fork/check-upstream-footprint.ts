import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import {
  compareFootprint,
  formatAllowlistEntries,
  parseFootprintAllowlist,
} from "./upstream-footprint";

const DEFAULT_UPSTREAM_REF = "upstream/main";
const ALLOWLIST_PATH = path.join("scripts", "fork", "upstream-footprint.txt");

function readArg(prefix: string): string | undefined {
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function git(workspaceRoot: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: workspaceRoot, encoding: "utf8" }).trim();
}

/** The script only needs git, so the repository root comes from git as well. */
function findRepositoryRoot(): string {
  return git(process.cwd(), ["rev-parse", "--show-toplevel"]);
}

function upstreamRefExists(workspaceRoot: string, ref: string): boolean {
  try {
    git(workspaceRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Upstream files the fork has changed: everything that exists at the merge
 * base with upstream and differs in the working tree (which equals HEAD in
 * CI). Files the fork added are fork-owned and never part of the footprint.
 */
function listModifiedUpstreamFiles(workspaceRoot: string, upstreamRef: string): string[] {
  const mergeBase = git(workspaceRoot, ["merge-base", upstreamRef, "HEAD"]);
  const output = git(workspaceRoot, [
    "diff",
    "--name-only",
    "--diff-filter=MDT",
    "--no-renames",
    mergeBase,
  ]);
  return output.length === 0 ? [] : output.split("\n");
}

async function main(): Promise<number> {
  const workspaceRoot = findRepositoryRoot();
  const upstreamRef =
    readArg("--upstream=") ?? process.env.LILAC_UPSTREAM_REF ?? DEFAULT_UPSTREAM_REF;
  const strict = hasFlag("--strict");

  if (!upstreamRefExists(workspaceRoot, upstreamRef)) {
    console.error(
      `Upstream ref '${upstreamRef}' is not available. Run 'git fetch upstream main' or pass --upstream=<ref>.`,
    );
    return 2;
  }

  const allowlistText = await fs.readFile(path.join(workspaceRoot, ALLOWLIST_PATH), "utf8");
  const allowlist = parseFootprintAllowlist(allowlistText);
  if (allowlist.problems.length > 0) {
    console.error(`${ALLOWLIST_PATH} has problems:`);
    for (const problem of allowlist.problems) console.error(`  - ${problem}`);
    return 2;
  }

  const comparison = compareFootprint({
    modifiedUpstreamFiles: listModifiedUpstreamFiles(workspaceRoot, upstreamRef),
    allowlist: allowlist.entries,
  });

  console.log(
    `Upstream footprint vs ${upstreamRef}: ${comparison.covered.length} allowed, ${comparison.unlisted.length} unlisted, ${comparison.stale.length} stale.`,
  );

  if (comparison.stale.length > 0) {
    console.log("");
    console.log("Stale entries (file no longer differs from upstream; remove them):");
    for (const entry of comparison.stale) console.log(`  - ${entry.path}`);
  }

  if (comparison.unlisted.length > 0) {
    console.log("");
    console.log(
      `Unlisted upstream files were modified. Prefer moving the change into a fork-owned module; otherwise add an entry to ${ALLOWLIST_PATH}:`,
    );
    console.log("");
    console.log(
      formatAllowlistEntries(comparison.unlisted, "<why the fork must change this file>"),
    );
    return 1;
  }

  if (strict && comparison.stale.length > 0) return 1;
  return 0;
}

process.exit(await main());
