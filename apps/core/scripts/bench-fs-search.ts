import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

import { FileSystem, expandTilde, type FsBackend } from "@stanley2058/lilac-fs";
import { Result, TaggedError, type Result as ResultType } from "better-result";

type BackendSelection = FsBackend | "all";

type BenchmarkCase =
  | {
      kind: "glob";
      name: string;
      patterns: string[];
      maxEntries?: number;
    }
  | {
      kind: "grep";
      name: string;
      pattern: string;
      regex?: boolean;
      fileExtensions?: string[];
      maxResults?: number;
    };

type BenchmarkOptions = {
  root: string;
  runs: number;
  warmups: number;
  backend: BackendSelection;
};

export class BenchmarkArgumentError extends TaggedError("BenchmarkArgumentError")<{
  readonly message: string;
}> {}

export class BenchmarkSearchError extends TaggedError("BenchmarkSearchError")<{
  readonly operation: "glob" | "grep";
  readonly message: string;
}> {}

const CASES = [
  {
    kind: "glob",
    name: "glob-ts",
    patterns: ["**/*.ts", "!**/node_modules/**"],
    maxEntries: 500,
  },
  {
    kind: "glob",
    name: "glob-core-tests",
    patterns: ["tests/**/*.test.ts"],
    maxEntries: 500,
  },
  {
    kind: "grep",
    name: "grep-file-system",
    pattern: "FileSystem",
    fileExtensions: ["ts"],
    maxResults: 200,
  },
  {
    kind: "grep",
    name: "grep-config-regex",
    pattern: "tools\\.(web|editFile|fsBackend)",
    regex: true,
    fileExtensions: ["ts"],
    maxResults: 200,
  },
] satisfies readonly BenchmarkCase[];

function parsePositiveInt(
  raw: string | undefined,
  label: string,
): ResultType<number, BenchmarkArgumentError> {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return Result.err(
      new BenchmarkArgumentError({ message: `${label} must be a positive integer` }),
    );
  }
  return Result.ok(value);
}

function parseBackend(
  raw: string | undefined,
): ResultType<BackendSelection, BenchmarkArgumentError> {
  if (raw === undefined || raw === "all") return Result.ok("all");
  if (raw === "fff" || raw === "node-rg") return Result.ok(raw);
  return Result.err(
    new BenchmarkArgumentError({ message: "backend must be one of: all, fff, node-rg" }),
  );
}

export function parseBenchmarkArgs(
  argv: readonly string[],
): ResultType<BenchmarkOptions | "help", BenchmarkArgumentError> {
  let root = process.cwd();
  let runs = 20;
  let warmups = 3;
  let backend: BackendSelection = "all";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") {
      root = argv[++i] ?? "";
      continue;
    }
    if (arg === "--runs") {
      const parsed = parsePositiveInt(argv[++i], "runs");
      if (parsed.status === "error") return parsed;
      runs = parsed.value;
      continue;
    }
    if (arg === "--warmups") {
      const parsed = parsePositiveInt(argv[++i], "warmups");
      if (parsed.status === "error") return parsed;
      warmups = parsed.value;
      continue;
    }
    if (arg === "--backend") {
      const parsed = parseBackend(argv[++i]);
      if (parsed.status === "error") return parsed;
      backend = parsed.value;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return Result.ok("help");
    }
    return Result.err(new BenchmarkArgumentError({ message: `Unknown argument: ${arg}` }));
  }

  return Result.ok({
    root: resolve(expandTilde(root)),
    runs,
    warmups,
    backend,
  });
}

function selectedBackends(selection: BackendSelection): FsBackend[] {
  return selection === "all" ? ["node-rg", "fff"] : [selection];
}

function elapsedMs(startMs: number): number {
  return performance.now() - startMs;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function formatMs(value: number): string {
  return value.toFixed(2);
}

function countGlobResult(
  result: Awaited<ReturnType<FileSystem["glob"]>>,
): ResultType<number, BenchmarkSearchError> {
  if (result.error) {
    return Result.err(new BenchmarkSearchError({ operation: "glob", message: result.error }));
  }
  return Result.ok(result.mode === "default" ? result.paths.length : result.entries.length);
}

function countGrepResult(
  result: Awaited<ReturnType<FileSystem["grep"]>>,
): ResultType<number, BenchmarkSearchError> {
  if (result.error) {
    return Result.err(new BenchmarkSearchError({ operation: "grep", message: result.error }));
  }
  return Result.ok(result.results.length);
}

async function runCase(
  fsTool: FileSystem,
  benchmarkCase: BenchmarkCase,
): Promise<ResultType<number, BenchmarkSearchError>> {
  if (benchmarkCase.kind === "glob") {
    const result = await fsTool.glob({
      patterns: benchmarkCase.patterns,
      maxEntries: benchmarkCase.maxEntries,
    });
    return countGlobResult(result);
  }

  const result = await fsTool.grep({
    pattern: benchmarkCase.pattern,
    regex: benchmarkCase.regex,
    fileExtensions: benchmarkCase.fileExtensions,
    maxResults: benchmarkCase.maxResults,
  });
  return countGrepResult(result);
}

export async function runBenchmark(
  options: BenchmarkOptions,
): Promise<ResultType<void, BenchmarkSearchError>> {
  process.stdout.write(
    `fs-search benchmark root=${options.root} warmups=${options.warmups} runs=${options.runs}\n`,
  );

  for (const backend of selectedBackends(options.backend)) {
    const fsTool = new FileSystem(options.root, { fsBackend: backend });
    process.stdout.write(`\nbackend=${backend}\n`);

    for (const benchmarkCase of CASES) {
      let lastCount = 0;
      const warmupStart = performance.now();
      for (let i = 0; i < options.warmups; i++) {
        const count = await runCase(fsTool, benchmarkCase);
        if (count.status === "error") return count;
        lastCount = count.value;
      }
      const warmupMs = elapsedMs(warmupStart);

      const samples: number[] = [];
      for (let i = 0; i < options.runs; i++) {
        const start = performance.now();
        const count = await runCase(fsTool, benchmarkCase);
        if (count.status === "error") return count;
        lastCount = count.value;
        samples.push(elapsedMs(start));
      }

      process.stdout.write(
        [
          `case=${benchmarkCase.name}`,
          `kind=${benchmarkCase.kind}`,
          `count=${lastCount}`,
          `warmup_ms=${formatMs(warmupMs)}`,
          `median_ms=${formatMs(median(samples))}`,
          `mean_ms=${formatMs(mean(samples))}`,
          `min_ms=${formatMs(Math.min(...samples))}`,
          `max_ms=${formatMs(Math.max(...samples))}`,
        ].join(" ") + "\n",
      );
    }
  }
  return Result.ok(undefined);
}

const HELP_TEXT = [
  "Usage: bun scripts/bench-fs-search.ts [--root PATH] [--backend all|fff|node-rg] [--warmups N] [--runs N]",
  "",
  "Examples:",
  "  bun run bench:fs-search",
  "  bun run bench:fs-search -- --root ../.. --runs 50",
].join("\n");

if (import.meta.main) {
  const parsed = parseBenchmarkArgs(process.argv.slice(2));
  if (parsed.status === "error") {
    process.stderr.write(`${parsed.error.message}\n`);
    process.exitCode = 1;
  } else if (parsed.value === "help") {
    process.stdout.write(`${HELP_TEXT}\n`);
  } else {
    const benchmark = await runBenchmark(parsed.value);
    if (benchmark.status === "error") {
      process.stderr.write(`${benchmark.error.message}\n`);
      process.exitCode = 1;
    }
  }
}
