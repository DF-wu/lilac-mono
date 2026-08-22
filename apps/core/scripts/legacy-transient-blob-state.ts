import fs from "node:fs/promises";
import path from "node:path";

import { Result, TaggedError, type Result as ResultType } from "better-result";

export const LEGACY_ANTHROPIC_FALLBACK_CACHE_DIR = "/tmp/lilac-anthropic-fallback-media";

export type LegacyTransientStateReport = {
  readonly kind: "tool-result-artifacts" | "anthropic-fallback-media";
  readonly recordCount: number;
  readonly byteTotal: number;
};

export class LegacyTransientStateFailure extends TaggedError("LegacyTransientStateFailure")<{
  readonly source: "tool-result-artifacts" | "anthropic-fallback-media";
  readonly operation: "inspect" | "discard";
  readonly code: string;
  readonly message: string;
}> {}

type TransientRoot = {
  readonly kind: LegacyTransientStateReport["kind"];
  readonly path: string;
};

function transientFailure(
  root: TransientRoot,
  operation: LegacyTransientStateFailure["operation"],
  code: string,
): LegacyTransientStateFailure {
  return new LegacyTransientStateFailure({
    source: root.kind,
    operation,
    code,
    message: `Legacy ${root.kind} state ${operation} failed`,
  });
}

function roots(input: {
  readonly dataDir: string;
  readonly anthropicFallbackCacheDir?: string;
}): readonly TransientRoot[] {
  return [
    {
      kind: "tool-result-artifacts",
      path: path.resolve(input.dataDir, "tool-results"),
    },
    {
      kind: "anthropic-fallback-media",
      path: path.resolve(input.anthropicFallbackCacheDir ?? LEGACY_ANTHROPIC_FALLBACK_CACHE_DIR),
    },
  ];
}

async function inspectRoot(
  root: TransientRoot,
): Promise<ResultType<LegacyTransientStateReport, LegacyTransientStateFailure>> {
  const inspected = await Result.tryPromise({
    try: () => fs.lstat(root.path),
    catch: (cause) => {
      if (cause instanceof Error && "code" in cause && typeof cause.code === "string") {
        return { code: cause.code };
      }
      return { code: "UNKNOWN" };
    },
  });
  if (inspected.isErr()) {
    if (inspected.error.code === "ENOENT") {
      return Result.ok({ kind: root.kind, recordCount: 0, byteTotal: 0 });
    }
    return Result.err(transientFailure(root, "inspect", inspected.error.code));
  }
  const rootStats = inspected.value;
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    return Result.err(transientFailure(root, "inspect", "UNSAFE_ROOT"));
  }
  const inspectedTree = await Result.tryPromise({
    try: async () => {
      const pending = [root.path];
      let recordCount = 0;
      let byteTotal = 0;
      while (pending.length > 0) {
        const directory = pending.pop();
        if (directory === undefined) continue;
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          const entryPath = path.join(directory, entry.name);
          const stats = await fs.lstat(entryPath);
          if (stats.isSymbolicLink()) {
            return Result.err(transientFailure(root, "inspect", "SYMBOLIC_LINK"));
          }
          if (stats.isDirectory()) {
            pending.push(entryPath);
            continue;
          }
          if (!stats.isFile()) {
            return Result.err(transientFailure(root, "inspect", "UNSUPPORTED_ENTRY"));
          }
          recordCount += 1;
          byteTotal += stats.size;
          if (!Number.isSafeInteger(byteTotal)) {
            return Result.err(transientFailure(root, "inspect", "BYTE_TOTAL_OVERFLOW"));
          }
        }
      }
      return Result.ok({ kind: root.kind, recordCount, byteTotal });
    },
    catch: (cause) => {
      if (cause instanceof Error && "code" in cause && typeof cause.code === "string") {
        return { code: cause.code };
      }
      return { code: "UNKNOWN" };
    },
  });
  return inspectedTree
    .mapError((failure) => transientFailure(root, "inspect", failure.code))
    .andThen((result) => result);
}

export async function inspectLegacyTransientState(input: {
  readonly dataDir: string;
  readonly anthropicFallbackCacheDir?: string;
}): Promise<ResultType<readonly LegacyTransientStateReport[], LegacyTransientStateFailure>> {
  return Result.gen(async function* () {
    const reports: LegacyTransientStateReport[] = [];
    for (const root of roots(input)) {
      reports.push(yield* Result.await(inspectRoot(root)));
    }
    return Result.ok(reports);
  });
}

export async function discardLegacyTransientState(input: {
  readonly dataDir: string;
  readonly anthropicFallbackCacheDir?: string;
}): Promise<ResultType<void, LegacyTransientStateFailure>> {
  return Result.gen(async function* () {
    for (const root of roots(input)) {
      const removed = await Result.tryPromise({
        try: () => fs.rm(root.path, { recursive: true, force: true }),
        catch: () =>
          new LegacyTransientStateFailure({
            source: root.kind,
            operation: "discard",
            code: "UNKNOWN",
            message: `Legacy ${root.kind} state discard failed`,
          }),
      });
      yield* removed;
    }
    return Result.ok(undefined);
  });
}
