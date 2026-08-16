/* from @stanley2058/tool-eval */
import {
  spawn,
  type ChildProcessByStdio,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import type { Readable } from "node:stream";

import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import type { EffectiveSearchBackend } from "./search-backend";

export type GrepMatch = {
  file: string;
  line: number;
  column: number;
  text: string;
  submatches?: {
    match: string;
    start: number;
    end: number;
  }[];
};

export type GrepOptions = {
  /**
   * Root directory for the search
   */
  cwd: string;
  /**
   * Explicit file or directory to search relative to cwd. Defaults to cwd itself.
   */
  searchPath?: string;
  /** Optional text to search through stdin instead of reading searchPath. */
  input?: string;
  /**
   * The pattern to search for (literal by default)
   */
  pattern: string;
  /**
   * File globs (e.g. ["src/\*\*\/*.ts"])
   */
  globs?: string[];
  /**
   * Extra ripgrep args
   */
  extraArgs?: string[];
  /**
   * If true, treat pattern as regex, otherwise literal
   */
  regex?: boolean;
  /**
   * Limit number of matches (guardrail)
   */
  maxMatches?: number;
  denyPaths?: readonly string[];
  dangerouslyAllow?: boolean;
  contextLines?: number;
  fffCacheDir?: string;
};

export type RipgrepResult = {
  matches: GrepMatch[];
  truncated: boolean;
  effectiveBackend: EffectiveSearchBackend;
};

export type GrepTextOptions = Omit<GrepOptions, "cwd" | "searchPath" | "globs" | "fffCacheDir"> & {
  content: string;
  reportedPath: string;
};

export class RipgrepLineMalformed extends TaggedError("RipgrepLineMalformed")<{
  readonly message: string;
}> {}

export class RipgrepExecutionFailed extends TaggedError("RipgrepExecutionFailed")<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly message: string;
}> {}

export type RipgrepError = RipgrepExecutionFailed | RipgrepLineMalformed;

const ripgrepSubmatchSchema = z.object({
  match: z.object({ text: z.string() }),
  start: z.number(),
  end: z.number(),
});

const ripgrepMatchEventSchema = z.object({
  type: z.literal("match"),
  data: z.object({
    path: z.object({ text: z.string().min(1) }),
    line_number: z.number(),
    lines: z
      .object({
        text: z.string(),
      })
      .optional(),
    submatches: z.array(ripgrepSubmatchSchema).optional().default([]),
  }),
});

const ripgrepNonMatchEventSchema = z.object({
  type: z.enum(["begin", "end", "context", "summary"]),
  data: z.unknown(),
});

export function decodeRipgrepMatchLine(
  line: string,
): ResultType<GrepMatch | null, RipgrepLineMalformed> {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(new RipgrepLineMalformed({ message: "ripgrep emitted malformed JSON" }));
  }
  const parsed = ripgrepMatchEventSchema.safeParse(event);
  if (!parsed.success) {
    const nonMatch = ripgrepNonMatchEventSchema.safeParse(event);
    if (nonMatch.success) return Result.ok(null);
    return Result.err(new RipgrepLineMalformed({ message: "ripgrep emitted a malformed event" }));
  }

  const data = parsed.data.data;
  const file = data.path.text;
  const lineValue = data.line_number;
  const text = data.lines?.text ?? "";
  const submatches = data.submatches.map((item) => ({
    match: item.match.text,
    start: item.start,
    end: item.end,
  }));

  return Result.ok({
    file,
    line: lineValue,
    column: (submatches[0]?.start ?? 0) + 1,
    text,
    ...(submatches.length > 0 ? { submatches } : {}),
  });
}

export async function ripgrep(
  options: GrepOptions,
): Promise<ResultType<RipgrepResult, RipgrepError>> {
  const {
    cwd,
    searchPath = options.input === undefined ? "." : "-",
    input,
    pattern,
    globs = [],
    extraArgs = [],
    regex = false,
    maxMatches = 200,
  } = options;
  const limit = Math.max(1, maxMatches);

  let child: ChildProcessByStdio<null, Readable, Readable> | ChildProcessWithoutNullStreams;
  try {
    const args = [...argsForRipgrep({ extraArgs, globs, limit, pattern, regex }), searchPath];
    child =
      input === undefined
        ? spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
        : spawn("rg", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new RipgrepExecutionFailed({
        code: null,
        signal: null,
        message: cause instanceof Error ? cause.message : "Failed to start ripgrep",
      }),
    );
  }

  return await new Promise<ResultType<RipgrepResult, RipgrepError>>((resolve) => {
    const matches: GrepMatch[] = [];
    let stderrBuf = "";
    let stdoutRemainder = "";
    let reachedLimit = false;
    let outputFailed = false;
    let stdinFailure: RipgrepExecutionFailed | undefined;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (value: ResultType<RipgrepResult, RipgrepError>) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const stopAtLimit = () => {
      if (reachedLimit) return;
      reachedLimit = true;

      child.kill("SIGTERM");

      forceKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 300);

      // Stop parsing buffered output once we know we have N+1.
      child.stdout.destroy();
    };

    if (input !== undefined && child.stdin) {
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EPIPE" || reachedLimit || outputFailed) return;
        outputFailed = true;
        stdinFailure = new RipgrepExecutionFailed({
          code: null,
          signal: null,
          message: error.message,
        });
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 300);
      });
      child.stdin.end(input);
    }

    const processLine = (line: string) => {
      if (reachedLimit || outputFailed) return;
      if (line.length === 0) return;
      if (matches.length > limit) {
        stopAtLimit();
        return;
      }

      const parsed = decodeRipgrepMatchLine(line);
      const handle = parsed.match<() => void>({
        err: (error) => () => {
          outputFailed = true;
          child.kill("SIGTERM");
          child.stdout.destroy();
          settle(Result.err(error));
        },
        ok: (match) => () => {
          if (match === null) return;
          matches.push(match);
          if (matches.length > limit) stopAtLimit();
        },
      });
      handle();
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (reachedLimit || outputFailed) return;

      stdoutRemainder += chunk;
      while (!reachedLimit && !outputFailed) {
        const newlineIndex = stdoutRemainder.indexOf("\n");
        if (newlineIndex === -1) break;
        const line = stdoutRemainder.slice(0, newlineIndex);
        stdoutRemainder = stdoutRemainder.slice(newlineIndex + 1);
        processLine(line);
      }

      if (reachedLimit || outputFailed) {
        stdoutRemainder = "";
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      stderrBuf += c;
    });

    child.on("error", (err) => {
      if (reachedLimit || outputFailed) return;
      settle(
        Result.err(
          new RipgrepExecutionFailed({
            code: null,
            signal: null,
            message: err.message,
          }),
        ),
      );
    });

    child.on("close", (code, signal) => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
      }

      if (outputFailed) {
        if (stdinFailure) settle(Result.err(stdinFailure));
        return;
      }

      if (!reachedLimit && stdoutRemainder.length > 0) {
        processLine(stdoutRemainder);
        stdoutRemainder = "";
      }

      const exitedNormally = code === 0 || code === 1;
      const exitedAtLimit = reachedLimit && (signal === "SIGTERM" || signal === "SIGKILL");

      if (exitedNormally || exitedAtLimit) {
        const truncated = matches.length > limit;
        settle(
          Result.ok({
            matches: truncated ? matches.slice(0, limit) : matches,
            truncated,
            effectiveBackend: "node-rg",
          }),
        );
        return;
      }

      settle(
        Result.err(
          new RipgrepExecutionFailed({
            code,
            signal,
            message: `rg exited with code ${code}: ${stderrBuf}`,
          }),
        ),
      );
    });
  });
}

export async function grepText(
  options: GrepTextOptions,
): Promise<ResultType<RipgrepResult, RipgrepError>> {
  const { content, reportedPath, ...grepOptions } = options;
  const result = await ripgrep({
    ...grepOptions,
    cwd: process.cwd(),
    input: content,
  });
  return result.map((value) => ({
    ...value,
    matches: value.matches.map((match) => ({ ...match, file: reportedPath })),
  }));
}

function argsForRipgrep(options: {
  readonly extraArgs: readonly string[];
  readonly globs: readonly string[];
  readonly limit: number;
  readonly pattern: string;
  readonly regex: boolean;
}): string[] {
  const args = ["--json", "--color", "never", ...options.extraArgs];
  args.push("--max-count", String(options.limit + 1));
  if (!options.regex) args.push("--fixed-strings");
  for (const glob of options.globs) args.push("--glob", glob);
  args.push("--", options.pattern);
  return args;
}
