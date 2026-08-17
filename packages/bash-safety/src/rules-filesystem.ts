import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import {
  GLOB_EXPANSION_MARKER,
  getBasename,
  hasDynamicExpansion,
  stripExpansionMarkers,
} from "./shell";
import { hasRecursiveFlag } from "./analyze/rm-flags";

const REASON_GIT_METADATA =
  "destructive changes to active .git metadata are blocked to prevent repository corruption.";
const REASON_DD_DEVICE = "dd output to a /dev device is blocked to prevent device destruction.";
const REASON_MKFS_DEVICE = "formatting a /dev device is blocked to prevent filesystem destruction.";
const REASON_SHRED = "shred permanently destroys targeted data and is blocked.";

const MKFS_COMMAND = /^(?:mkfs(?:\.[a-z0-9_-]+)?|mke2fs|mkdosfs|mkntfs)$/u;
const SHRED_OPTIONS_WITH_VALUE = new Set(["-n", "--iterations", "-s", "--size", "--random-source"]);
const COPY_OPTIONS_WITH_VALUE = new Set(["-S", "--suffix"]);
const INSTALL_OPTIONS_WITH_VALUE = new Set([
  "-g",
  "--group",
  "-m",
  "--mode",
  "-o",
  "--owner",
  "-S",
  "--suffix",
  "--strip-program",
]);
const LN_OPTIONS_WITH_VALUE = new Set(["-S", "--suffix"]);
const TRUNCATE_OPTIONS_WITH_VALUE = new Set(["-r", "--reference", "-s", "--size"]);

class GitMetadataReadFailed extends TaggedError("GitMetadataReadFailed")<{
  readonly markerPath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

function readGitMetadataFile(markerPath: string): ResultType<string, GitMetadataReadFailed> {
  return Result.try({
    try: () => readFileSync(markerPath, "utf8"),
    catch: (cause) => {
      if (Panic.is(cause)) throw cause;
      return new GitMetadataReadFailed({
        markerPath,
        cause,
        message: "Git metadata marker could not be read",
      });
    },
  });
}

export function analyzeDestructiveFilesystemCommand(
  tokens: readonly string[],
  cwd: string | null | undefined,
): string | null {
  const command = getBasename(stripExpansionMarkers(tokens[0] ?? "")).toLowerCase();

  const { mutationTargets, treeRemovalTargets } = extractGitMetadataMutationTargets(
    command,
    tokens,
  );
  if (
    mutationTargets.some((target) => isActiveGitMetadataPath(target, cwd, false)) ||
    treeRemovalTargets.some((target) => isActiveGitMetadataPath(target, cwd, true))
  ) {
    return REASON_GIT_METADATA;
  }

  if (command === "dd") {
    for (const token of tokens.slice(1)) {
      if (!token.startsWith("of=")) continue;
      if (isStaticDevicePath(token.slice(3), cwd)) return REASON_DD_DEVICE;
    }
  }

  if (MKFS_COMMAND.test(command)) {
    const targets = extractOperands(tokens);
    if (targets.some((target) => isStaticDevicePath(target, cwd))) {
      return REASON_MKFS_DEVICE;
    }
  }

  if (command === "shred") {
    const targets = extractShredTargets(tokens);
    if (targets.some(isStaticPath)) return REASON_SHRED;
  }

  return null;
}

function extractGitMetadataMutationTargets(
  command: string,
  tokens: readonly string[],
): { mutationTargets: string[]; treeRemovalTargets: string[] } {
  if (command === "rm") {
    const targets = extractOperands(tokens);
    return {
      mutationTargets: targets,
      treeRemovalTargets: hasRecursiveFlag(tokens) ? targets : [],
    };
  }
  if (command === "rmdir") return mutationTargets(extractOperands(tokens));
  if (command === "mv") {
    return {
      mutationTargets: extractMvPaths(tokens),
      treeRemovalTargets: extractMvSources(tokens),
    };
  }
  if (command === "cp") {
    return mutationTargets(extractCopyLikeDestinations(tokens, COPY_OPTIONS_WITH_VALUE));
  }
  if (command === "install") return mutationTargets(extractInstallDestinations(tokens));
  if (command === "ln") {
    return mutationTargets(extractCopyLikeDestinations(tokens, LN_OPTIONS_WITH_VALUE));
  }
  if (command === "truncate") {
    return mutationTargets(extractPositionals(tokens, TRUNCATE_OPTIONS_WITH_VALUE));
  }
  if (command === "tee") return mutationTargets(extractOperands(tokens));
  if (command === "dd") {
    return mutationTargets(
      tokens.slice(1).flatMap((token) => (token.startsWith("of=") ? [token.slice(3)] : [])),
    );
  }
  return mutationTargets([]);
}

function mutationTargets(targets: string[]): {
  mutationTargets: string[];
  treeRemovalTargets: string[];
} {
  return { mutationTargets: targets, treeRemovalTargets: [] };
}

export function analyzeGitMetadataOutputPath(
  target: string,
  cwd: string | null | undefined,
): string | null {
  return isActiveGitMetadataPath(target, cwd, false) ? REASON_GIT_METADATA : null;
}

function extractOperands(tokens: readonly string[]): string[] {
  const operands: string[] = [];
  let pastDoubleDash = false;
  for (const token of tokens.slice(1)) {
    if (token === "--") {
      pastDoubleDash = true;
    } else if (pastDoubleDash || !token.startsWith("-")) {
      operands.push(token);
    }
  }
  return operands;
}

function extractMvPaths(tokens: readonly string[]): string[] {
  const paths: string[] = [];
  let pastDoubleDash = false;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (token === "--") {
      pastDoubleDash = true;
      continue;
    }
    if (pastDoubleDash || !token.startsWith("-")) {
      paths.push(token);
      continue;
    }
    if (token === "-t" || token === "--target-directory") {
      const targetDirectory = tokens[i + 1];
      if (targetDirectory) paths.push(targetDirectory);
      i++;
      continue;
    }
    if (token.startsWith("--target-directory=")) {
      paths.push(token.slice("--target-directory=".length));
      continue;
    }
    const shortTargetDirectory = token.match(/^-[A-Za-z]*t(.+)$/u)?.[1];
    if (shortTargetDirectory) {
      paths.push(shortTargetDirectory);
      continue;
    }
    if (token === "-S" || token === "--suffix") i++;
  }
  return paths;
}

function extractMvSources(tokens: readonly string[]): string[] {
  const { positionals, targetDirectories } = extractWriterArguments(
    tokens,
    new Set(["-S", "--suffix"]),
  );
  return targetDirectories.length > 0 ? positionals : positionals.slice(0, -1);
}

function extractCopyLikeDestinations(
  tokens: readonly string[],
  optionsWithValue: ReadonlySet<string>,
): string[] {
  const { positionals, targetDirectories } = extractWriterArguments(tokens, optionsWithValue);
  if (targetDirectories.length > 0) return targetDirectories;
  const destination = positionals.length >= 2 ? positionals.at(-1) : undefined;
  return destination ? [destination] : [];
}

function extractInstallDestinations(tokens: readonly string[]): string[] {
  const { positionals, targetDirectories } = extractWriterArguments(
    tokens,
    INSTALL_OPTIONS_WITH_VALUE,
  );
  if (targetDirectories.length > 0) return targetDirectories;
  const directoryMode = tokens.some(
    (token) => token === "--directory" || (/^-[^-]*d/u.test(token) && token !== "--"),
  );
  if (directoryMode) return positionals;
  const destination = positionals.length >= 2 ? positionals.at(-1) : undefined;
  return destination ? [destination] : [];
}

function extractWriterArguments(
  tokens: readonly string[],
  optionsWithValue: ReadonlySet<string>,
): { positionals: string[]; targetDirectories: string[] } {
  const positionals: string[] = [];
  const targetDirectories: string[] = [];
  let pastDoubleDash = false;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (token === "--") {
      pastDoubleDash = true;
      continue;
    }
    if (pastDoubleDash || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (token === "-t" || token === "--target-directory") {
      const targetDirectory = tokens[i + 1];
      if (targetDirectory) targetDirectories.push(targetDirectory);
      i++;
      continue;
    }
    if (token.startsWith("--target-directory=")) {
      targetDirectories.push(token.slice("--target-directory=".length));
      continue;
    }
    const shortTargetDirectory = token.match(/^-[A-Za-z]*t(.+)$/u)?.[1];
    if (shortTargetDirectory) {
      targetDirectories.push(shortTargetDirectory);
      continue;
    }
    if (optionsWithValue.has(token)) i++;
  }
  return { positionals, targetDirectories };
}

function extractPositionals(
  tokens: readonly string[],
  optionsWithValue: ReadonlySet<string>,
): string[] {
  const positionals: string[] = [];
  let pastDoubleDash = false;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (token === "--") {
      pastDoubleDash = true;
      continue;
    }
    if (pastDoubleDash || !token.startsWith("-")) positionals.push(token);
    else if (optionsWithValue.has(token)) i++;
  }
  return positionals;
}

function extractShredTargets(tokens: readonly string[]): string[] {
  const targets: string[] = [];
  let pastDoubleDash = false;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (token === "--") {
      pastDoubleDash = true;
      continue;
    }
    if (pastDoubleDash || !token.startsWith("-")) {
      targets.push(token);
      continue;
    }
    if (SHRED_OPTIONS_WITH_VALUE.has(token)) {
      i++;
      continue;
    }
    if (
      token.startsWith("--iterations=") ||
      token.startsWith("--size=") ||
      token.startsWith("--random-source=") ||
      /^-[ns].+/u.test(token)
    ) {
      continue;
    }
  }
  return targets;
}

function isStaticDevicePath(target: string, cwd: string | null | undefined): boolean {
  if (!isStaticPath(target)) return false;
  const path = stripExpansionMarkers(target);
  let resolved: string | null = null;
  if (isAbsolute(path)) resolved = resolve(path);
  else if (cwd) resolved = resolve(cwd, path);
  return resolved === "/dev" || resolved?.startsWith("/dev/") === true;
}

function isActiveGitMetadataPath(
  target: string,
  cwd: string | null | undefined,
  includeMetadataDescendants: boolean,
): boolean {
  if (!cwd || !isStaticPath(target)) return false;
  const path = stripExpansionMarkers(target);
  if (!path || path === "-" || path.startsWith("-")) return false;
  const resolvedTarget = isAbsolute(path) ? resolve(path) : resolve(cwd, path);

  for (const metadataPath of activeGitMetadataPaths(cwd)) {
    if (pathContains(metadataPath, resolvedTarget)) return true;
    if (includeMetadataDescendants && pathContains(resolvedTarget, metadataPath)) return true;
  }
  return false;
}

function activeGitMetadataPaths(cwd: string): string[] {
  const paths: string[] = [];
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, ".git");
    if (existsSync(candidate)) {
      paths.push(candidate);
      const gitDir = readGitMetadataFile(candidate).match({
        ok: (content) => parseGitDirMarker(content, candidate),
        err: () => null,
      });
      if (gitDir) {
        paths.push(gitDir);
        const commonDir = readGitMetadataFile(join(gitDir, "commondir")).match({
          ok: (content) => parseCommonDir(content, gitDir),
          err: () => null,
        });
        if (commonDir) paths.push(commonDir);
      }
    }
    const parent = dirname(current);
    if (parent === current) return paths;
    current = parent;
  }
}

function parseGitDirMarker(content: string, markerPath: string): string | null {
  const gitDir = content.match(/^gitdir:\s*(.+?)\s*$/imu)?.[1];
  return gitDir ? resolve(dirname(markerPath), gitDir) : null;
}

function parseCommonDir(content: string, gitDir: string): string | null {
  const commonDir = content.trim();
  return commonDir ? resolve(gitDir, commonDir) : null;
}

function pathContains(parent: string, target: string): boolean {
  const pathFromParent = relative(parent, target);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
}

function isStaticPath(target: string): boolean {
  return !hasDynamicExpansion(target.replaceAll(GLOB_EXPANSION_MARKER, ""));
}
