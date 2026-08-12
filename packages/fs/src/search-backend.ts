import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, relative, sep } from "node:path";

import type { FileFinderApi } from "@ff-labs/fff-node";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { AsyncFzf } from "fzf";

import { captureFilesystemOperation, type FileSystemOperationFailed } from "./filesystem-operation";
import {
  ripgrep,
  type GrepMatch,
  type GrepOptions,
  type RipgrepError,
  type RipgrepResult,
} from "./ripgrep";

export const FS_BACKENDS = ["fff", "node-rg"] as const;
export type FsBackend = (typeof FS_BACKENDS)[number];
export type EffectiveSearchBackend = FsBackend | "node-fs";
export type EffectiveFuzzySearchBackend = "fff" | "fzf";

export type GlobSearchResult = {
  paths: string[];
  truncated: boolean;
  effectiveBackend: "fff";
};

export type FuzzyFileSearchResult = {
  results: {
    path: string;
    fileName: string;
    size: number;
    gitStatus: string;
    score?: number;
    matchType?: string;
  }[];
  totalMatched: number;
  totalFiles: number;
  truncated: boolean;
  effectiveBackend: EffectiveFuzzySearchBackend;
};

export type FffPrewarmResult = {
  basePath: string;
  ok: boolean;
  skipped?: "not-directory" | "deny-path" | "unavailable";
};

export type SearchBackend = {
  grep(options: GrepOptions): Promise<ResultType<RipgrepResult, SearchBackendError>>;
  glob(options: {
    cwd: string;
    patterns: readonly string[];
    maxEntries: number;
    denyPaths: readonly string[];
    dangerouslyAllow: boolean;
    cacheDir?: string;
  }): Promise<GlobSearchResult | null>;
};

export type SearchBackendError = SearchBackendUnavailable | RipgrepError;

export class SearchBackendUnavailable extends TaggedError("SearchBackendUnavailable")<{
  readonly backend: FsBackend;
  readonly message: string;
}> {}

async function captureFffOperation<T>(
  effect: () => Promise<T>,
): Promise<ResultType<T, SearchBackendUnavailable>> {
  try {
    return Result.ok(await effect());
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new SearchBackendUnavailable({
        backend: "fff",
        message: cause instanceof Error ? cause.message : "FFF search backend is unavailable",
      }),
    );
  }
}

function captureFffSyncOperation<T>(effect: () => T): ResultType<T, SearchBackendUnavailable> {
  try {
    return Result.ok(effect());
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new SearchBackendUnavailable({
        backend: "fff",
        message: cause instanceof Error ? cause.message : "FFF search backend is unavailable",
      }),
    );
  }
}

const nodeRgBackend: SearchBackend = {
  grep: ripgrep,
  async glob() {
    return null;
  },
};

type FffFinderEntry = {
  finder: FileFinderApi;
  ready: Promise<boolean>;
};

type FffStoragePaths = {
  frecencyDbPath?: string;
  historyDbPath?: string;
};

const MAX_FFF_FINDER_CACHE_ENTRIES = 8;
const MAX_FZF_FILES = 10_000;
const FZF_SCAN_BUDGET_MS = 10_000;
const fffFindersByBasePath = new Map<string, FffFinderEntry>();
const FFF_NODE_PACKAGE = ["@ff-labs", "fff-node"].join("/");

function fffFinderCacheKey(basePath: string, cacheDir?: string): string {
  return `${cacheDir ?? ""}\0${basePath}`;
}

function destroyFffFinder(entry: FffFinderEntry): void {
  captureFffSyncOperation(() => entry.finder.destroy());
}

function cacheFffFinder(cacheKey: string, entry: FffFinderEntry): void {
  fffFindersByBasePath.set(cacheKey, entry);

  while (fffFindersByBasePath.size > MAX_FFF_FINDER_CACHE_ENTRIES) {
    const oldest = fffFindersByBasePath.entries().next().value;
    if (!oldest) return;
    const [oldestCacheKey, oldestEntry] = oldest;
    fffFindersByBasePath.delete(oldestCacheKey);
    destroyFffFinder(oldestEntry);
  }
}

function rootStorageKey(basePath: string): string {
  return createHash("sha256").update(basePath).digest("hex").slice(0, 16);
}

async function resolveFffStoragePaths(
  cacheDir: string | undefined,
  basePath: string,
): Promise<FffStoragePaths> {
  if (!cacheDir) return {};

  const rootDir = join(cacheDir, "roots", rootStorageKey(basePath));
  const frecencyDbPath = join(rootDir, "frecency");
  const historyDbPath = join(rootDir, "history");
  const frecencyCreated = await captureFilesystemOperation("create FFF frecency directory", () =>
    fs.mkdir(frecencyDbPath, { recursive: true }),
  );
  if (frecencyCreated.status === "error") return {};
  const historyCreated = await captureFilesystemOperation("create FFF history directory", () =>
    fs.mkdir(historyDbPath, { recursive: true }),
  );
  if (historyCreated.status === "error") return {};
  return { frecencyDbPath, historyDbPath };
}

function shouldFallbackForDenyPaths(params: {
  cwd: string;
  denyPaths: readonly string[];
  dangerouslyAllow: boolean;
}): boolean {
  if (params.dangerouslyAllow) return false;

  for (const denyPath of params.denyPaths) {
    const rel = relative(params.cwd, denyPath);
    if (rel.length === 0) return true;
    if (rel.startsWith("..") || rel.startsWith(sep)) continue;
    return true;
  }

  return false;
}

function isDeniedPath(path: string, denyPaths: readonly string[]): boolean {
  return denyPaths.some((denyPath) => path === denyPath || path.startsWith(`${denyPath}${sep}`));
}

function isSkippableTraversalError(error: FileSystemOperationFailed): boolean {
  return (
    error.code === "EACCES" ||
    error.code === "EPERM" ||
    error.code === "ENOENT" ||
    error.code === "ENOTDIR"
  );
}

async function getFffFinder(basePath: string, cacheDir?: string): Promise<FileFinderApi | null> {
  const cacheKey = fffFinderCacheKey(basePath, cacheDir);
  const cached = fffFindersByBasePath.get(cacheKey);
  if (cached) {
    fffFindersByBasePath.delete(cacheKey);
    fffFindersByBasePath.set(cacheKey, cached);
    await cached.ready;
    return cached.finder;
  }

  const loaded = await captureFffOperation(async () => {
    const fff = (await import(FFF_NODE_PACKAGE)) as typeof import("@ff-labs/fff-node");
    if (!fff.FileFinder.isAvailable()) return null;

    const storagePaths = await resolveFffStoragePaths(cacheDir, basePath);
    const created = fff.FileFinder.create({
      basePath,
      aiMode: true,
      ...storagePaths,
      // Keep cached indexes fresh after background edits. Eviction destroys
      // the finder, which also stops the native watcher for that base path.
      disableWatch: false,
    });
    if (!created.ok) return null;

    const finder = created.value;
    const ready = captureFffOperation(() => finder.waitForIndexReady(10_000)).then(
      (result) => result.status === "ok" && result.value.ok && result.value.value,
    );
    cacheFffFinder(cacheKey, { finder, ready });

    await ready;
    return finder;
  });
  return loaded.status === "ok" ? loaded.value : null;
}

async function isDirectory(path: string): Promise<boolean> {
  const stat = await captureFilesystemOperation("stat FFF search root", () => fs.stat(path));
  return stat.status === "ok" && stat.value.isDirectory();
}

export async function prewarmFffFinders(params: {
  basePaths: readonly string[];
  denyPaths: readonly string[];
  cacheDir?: string;
}): Promise<FffPrewarmResult[]> {
  const results: FffPrewarmResult[] = [];
  const seen = new Set<string>();
  const canonicalDenyPaths: string[] = [];
  for (const denyPath of params.denyPaths) {
    const canonical = await captureFilesystemOperation("resolve FFF deny path", () =>
      fs.realpath(denyPath),
    );
    canonicalDenyPaths.push(canonical.status === "ok" ? canonical.value : denyPath);
  }

  for (const basePath of params.basePaths) {
    if (seen.has(basePath)) continue;
    seen.add(basePath);
    const canonical = await captureFilesystemOperation("resolve FFF search root", () =>
      fs.realpath(basePath),
    );
    const canonicalBasePath = canonical.status === "ok" ? canonical.value : basePath;

    if (!(await isDirectory(canonicalBasePath))) {
      results.push({ basePath, ok: false, skipped: "not-directory" });
      continue;
    }

    if (
      shouldFallbackForDenyPaths({
        cwd: canonicalBasePath,
        denyPaths: canonicalDenyPaths,
        dangerouslyAllow: false,
      })
    ) {
      results.push({ basePath, ok: false, skipped: "deny-path" });
      continue;
    }

    const finder = await getFffFinder(canonicalBasePath, params.cacheDir);
    results.push(finder ? { basePath, ok: true } : { basePath, ok: false, skipped: "unavailable" });
  }

  return results;
}

export async function fuzzyFileSearch(params: {
  cwd: string;
  query: string;
  maxResults: number;
  denyPaths: readonly string[];
  dangerouslyAllow: boolean;
  cacheDir?: string;
}): Promise<FuzzyFileSearchResult | null> {
  if (
    shouldFallbackForDenyPaths({
      cwd: params.cwd,
      denyPaths: params.denyPaths,
      dangerouslyAllow: params.dangerouslyAllow,
    })
  ) {
    return null;
  }

  const finder = await getFffFinder(params.cwd, params.cacheDir);
  if (!finder) return null;

  const limit = Math.max(1, params.maxResults);
  const searched = captureFffSyncOperation(() =>
    finder.fileSearch(params.query, { pageSize: limit + 1 }),
  );
  if (searched.status === "error") return null;
  const result = searched.value;
  if (!result.ok) return null;

  const items = result.value.items.slice(0, limit);
  return {
    results: items.map((item, index) => {
      const score = result.value.scores[index];
      return {
        path: item.relativePath,
        fileName: item.fileName,
        size: item.size,
        gitStatus: item.gitStatus,
        score: score?.total,
        matchType: score?.matchType,
      };
    }),
    totalMatched: result.value.totalMatched,
    totalFiles: result.value.totalFiles,
    truncated: result.value.items.length > limit || result.value.totalMatched > limit,
    effectiveBackend: "fff",
  };
}

export async function fzfFileSearch(params: {
  cwd: string;
  query: string;
  maxResults: number;
  denyPaths: readonly string[];
  dangerouslyAllow: boolean;
}): Promise<FuzzyFileSearchResult | null> {
  const files: string[] = [];
  const pendingDirectories = [params.cwd];
  const scanDeadline = Date.now() + FZF_SCAN_BUDGET_MS;
  let scanTruncated = false;

  while (pendingDirectories.length > 0) {
    if (files.length >= MAX_FZF_FILES || Date.now() >= scanDeadline) {
      scanTruncated = true;
      break;
    }
    const directory = pendingDirectories.pop();
    if (!directory) break;
    if (!params.dangerouslyAllow && isDeniedPath(directory, params.denyPaths)) continue;

    const directoryStats = await captureFilesystemOperation("inspect fzf search directory", () =>
      fs.lstat(directory),
    );
    if (directoryStats.status === "error") {
      if (isSkippableTraversalError(directoryStats.error)) continue;
      return null;
    }
    if (!directoryStats.value.isDirectory()) continue;

    const opened = await captureFilesystemOperation("open fzf search directory", () =>
      fs.opendir(directory),
    );
    if (opened.status === "error") {
      if (isSkippableTraversalError(opened.error)) continue;
      return null;
    }

    const canonicalDirectory = await captureFilesystemOperation(
      "resolve opened fzf search directory",
      () => fs.realpath(directory),
    );
    if (
      canonicalDirectory.status === "error" ||
      canonicalDirectory.value !== directory ||
      (!params.dangerouslyAllow && isDeniedPath(canonicalDirectory.value, params.denyPaths))
    ) {
      await captureFilesystemOperation("close skipped fzf search directory", () =>
        opened.value.close(),
      );
      if (
        canonicalDirectory.status === "error" &&
        !isSkippableTraversalError(canonicalDirectory.error)
      ) {
        return null;
      }
      continue;
    }

    const childDirectories: string[] = [];
    const iterated = await captureFilesystemOperation("iterate fzf search directory", async () => {
      for await (const dirent of opened.value) {
        if (files.length >= MAX_FZF_FILES || Date.now() >= scanDeadline) {
          scanTruncated = true;
          break;
        }
        const absolutePath = join(directory, dirent.name);
        if (!params.dangerouslyAllow && isDeniedPath(absolutePath, params.denyPaths)) continue;
        if (dirent.isDirectory()) {
          childDirectories.push(absolutePath);
        } else if (dirent.isFile()) {
          files.push(relative(params.cwd, absolutePath).split(sep).join("/"));
        }
      }
    });
    if (iterated.status === "error") {
      if (isSkippableTraversalError(iterated.error)) continue;
      return null;
    }

    childDirectories.sort().reverse();
    pendingDirectories.push(...childDirectories);
  }

  const limit = Math.max(1, params.maxResults);
  files.sort();
  const matches = await new AsyncFzf(files).find(params.query);
  const results: FuzzyFileSearchResult["results"] = [];

  for (const match of matches) {
    if (results.length >= limit) break;
    const stats = await captureFilesystemOperation("inspect fzf search result", () =>
      fs.lstat(join(params.cwd, match.item)),
    );
    if (stats.status === "error") {
      if (isSkippableTraversalError(stats.error)) continue;
      return null;
    }
    if (!stats.value.isFile()) continue;

    results.push({
      path: match.item,
      fileName: basename(match.item),
      size: stats.value.size,
      gitStatus: "unknown",
      score: match.score,
      matchType: "fuzzy",
    });
  }

  return {
    results,
    totalMatched: matches.length,
    totalFiles: files.length,
    truncated: scanTruncated || matches.length > results.length,
    effectiveBackend: "fzf",
  };
}

function buildFffGrepQuery(pattern: string, globs: readonly string[] | undefined): string {
  const constraints = globs?.filter((glob) => glob.length > 0 && !glob.startsWith("!")) ?? [];
  if (constraints.length === 0) return pattern;
  return `${constraints.join(" ")} ${pattern}`;
}

function hasMultiplePositiveGlobConstraints(globs: readonly string[] | undefined): boolean {
  const constraints = globs?.filter((glob) => glob.length > 0 && !glob.startsWith("!")) ?? [];
  return constraints.length > 1;
}

function isFileLikeGlobPattern(pattern: string): boolean {
  const lastSegment = pattern.split(/[\\/]/u).pop() ?? pattern;
  return lastSegment.includes(".");
}

function targetsNodeModules(pattern: string): boolean {
  return pattern.split(/[\\/]/u).includes("node_modules");
}

function mapFffGrepMatch(item: {
  relativePath: string;
  lineNumber: number;
  col: number;
  lineContent: string;
  matchRanges: readonly (readonly [number, number])[];
}): GrepMatch {
  const submatches = item.matchRanges.map(([start, end]) => ({
    match: item.lineContent.slice(start, end),
    start,
    end,
  }));

  return {
    file: item.relativePath,
    line: item.lineNumber,
    column: item.col + 1,
    text: item.lineContent,
    ...(submatches.length > 0 ? { submatches } : {}),
  };
}

const fffBackend: SearchBackend = {
  async grep(options) {
    // FFF indexes directories; explicit single-file searches must not broaden to siblings.
    if (options.searchPath !== undefined) {
      return await nodeRgBackend.grep(options);
    }

    if (
      shouldFallbackForDenyPaths({
        cwd: options.cwd,
        denyPaths: options.denyPaths ?? [],
        dangerouslyAllow: options.dangerouslyAllow ?? false,
      })
    ) {
      return await nodeRgBackend.grep(options);
    }

    if (hasMultiplePositiveGlobConstraints(options.globs)) {
      return await nodeRgBackend.grep(options);
    }

    const finder = await getFffFinder(options.cwd, options.fffCacheDir);
    if (!finder) return await nodeRgBackend.grep(options);

    const limit = Math.max(1, options.maxMatches ?? 200);
    const captured = captureFffSyncOperation(() =>
      finder.grep(buildFffGrepQuery(options.pattern, options.globs), {
        mode: options.regex ? "regex" : "plain",
        smartCase: false,
        pageSize: limit + 1,
        beforeContext: options.contextLines ?? 0,
        afterContext: options.contextLines ?? 0,
      }),
    );
    if (captured.status === "error") return await nodeRgBackend.grep(options);
    const result = captured.value;

    if (!result.ok) return await nodeRgBackend.grep(options);
    if (options.regex && result.value.regexFallbackError) return await nodeRgBackend.grep(options);

    const matches = result.value.items.map(mapFffGrepMatch);
    const truncated = matches.length > limit;
    return Result.ok({
      matches: truncated ? matches.slice(0, limit) : matches,
      truncated,
      effectiveBackend: "fff",
    });
  },

  async glob(options) {
    if (
      shouldFallbackForDenyPaths({
        cwd: options.cwd,
        denyPaths: options.denyPaths,
        dangerouslyAllow: options.dangerouslyAllow,
      })
    ) {
      return null;
    }

    const includes = options.patterns.filter(
      (pattern) => pattern.length > 0 && !pattern.startsWith("!"),
    );
    const excludes = options.patterns
      .filter((pattern) => pattern.startsWith("!"))
      .map((pattern) => pattern.slice(1))
      .filter((pattern) => pattern.length > 0);

    if (includes.length === 0) return { paths: [], truncated: false, effectiveBackend: "fff" };
    if (excludes.length > 0) return null;
    if (!includes.every(isFileLikeGlobPattern)) return null;
    if (includes.some(targetsNodeModules)) return null;

    const finder = await getFffFinder(options.cwd, options.cacheDir);
    if (!finder) return null;

    const paths: string[] = [];
    const seen = new Set<string>();
    let truncated = false;

    for (const pattern of includes) {
      const captured = captureFffSyncOperation(() =>
        finder.glob(pattern, { pageSize: options.maxEntries + 1 }),
      );
      if (captured.status === "error") return null;
      const result = captured.value;
      if (!result.ok) return null;

      for (const item of result.value.items) {
        const relPath = item.relativePath;
        if (seen.has(relPath)) continue;

        const abs = join(options.cwd, relPath);
        const stat = await captureFilesystemOperation("stat FFF glob match", () => fs.stat(abs));
        if (stat.status === "error" || !stat.value.isFile()) continue;

        seen.add(relPath);
        if (paths.length >= options.maxEntries) {
          truncated = true;
          break;
        }
        paths.push(relPath);
      }

      if (truncated) break;
    }

    return { paths, truncated, effectiveBackend: "fff" };
  },
};

export function getSearchBackend(backend: FsBackend): SearchBackend {
  return backend === "fff" ? fffBackend : nodeRgBackend;
}
