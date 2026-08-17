import { parse, type ScriptNode } from "just-bash";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import { type AnalyzeOptions, type AnalyzeResult, MAX_RECURSION_DEPTH } from "../types";

import { analyzeScript } from "./ast-walker";
import { dangerousReasonInText } from "./dangerous-text";

class BashCommandParseFailed extends TaggedError("BashCommandParseFailed")<{
  readonly command: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

function parseBashCommand(command: string): ResultType<ScriptNode, BashCommandParseFailed> {
  return Result.try({
    try: () => parse(command),
    catch: (cause) => {
      if (Panic.is(cause)) throw cause;
      return new BashCommandParseFailed({
        command,
        cause,
        message: "Bash command could not be parsed",
      });
    },
  });
}

export function analyzeCommandInternal(
  command: string,
  depth: number,
  options: AnalyzeOptions,
): AnalyzeResult | null {
  return analyzeCommandAtCwd(command, depth, options, options.cwd);
}

function analyzeCommandAtCwd(
  command: string,
  depth: number,
  options: AnalyzeOptions,
  effectiveCwd: string | null | undefined,
): AnalyzeResult | null {
  if (depth >= MAX_RECURSION_DEPTH) {
    return null;
  }

  const parsed = parseBashCommand(command);
  return parsed.match({
    ok: (script) =>
      analyzeScript(
        script,
        {
          depth,
          options,
          originalCwd: options.cwd,
          analyzeNestedCommand: (nestedCommand, nestedDepth, nestedCwd) =>
            analyzeCommandAtCwd(nestedCommand, nestedDepth, options, nestedCwd),
        },
        { cwd: effectiveCwd },
      ),
    err: () => {
      const reason = dangerousReasonInText(command, options);
      return reason ? { reason, segment: command } : null;
    },
  });
}
