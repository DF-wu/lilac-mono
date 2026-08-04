import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";

import { MINI_LILAC_REASONING_LEVELS } from "@stanley2058/mini-lilac-client";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { captureTuiOperation } from "./failure-adapter";

export const DEFAULT_SERVER_URL = "http://127.0.0.1:8090/api/mini-lilac";

/** Environment variable consulted for the bearer token. */
export const TOKEN_ENV_VARS = ["MINI_LILAC_TOKEN"] as const;

export interface CliOptions {
  readonly server: string;
  readonly token: string | undefined;
  readonly model: string | undefined;
  readonly profile: string | undefined;
  readonly session: string | undefined;
  readonly reasoning: (typeof MINI_LILAC_REASONING_LEVELS)[number] | undefined;
  /** Always the canonical realpath of the current working directory. */
  readonly cwd: string;
  readonly help: boolean;
}

export interface ParseCliInput {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
}

export class CliArgumentsInvalid extends TaggedError("CliArgumentsInvalid")<{
  readonly cause?: unknown;
  readonly message: string;
}> {}

export class CanonicalCwdFailed extends TaggedError("CanonicalCwdFailed")<{
  readonly cwd: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

interface ParsedCliValues {
  readonly server?: string;
  readonly token?: string;
  readonly model?: string;
  readonly profile?: string;
  readonly session?: string;
  readonly reasoning?: string;
  readonly help: boolean;
}

export function canonicalCwd(value: string): ResultType<string, CanonicalCwdFailed> {
  return captureTuiOperation(
    () => realpathSync(resolve(value)),
    (cause) =>
      new CanonicalCwdFailed({
        cwd: value,
        cause,
        message: `Could not resolve cwd '${value}'`,
      }),
  );
}

function firstNonEmpty(
  env: Readonly<Record<string, string | undefined>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function optional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseCliOptions(input: ParseCliInput): ResultType<CliOptions, CliArgumentsInvalid> {
  const parsed = captureTuiOperation(
    () =>
      parseArgs({
        args: [...input.argv],
        allowPositionals: false,
        options: {
          server: { type: "string" },
          token: { type: "string" },
          model: { type: "string" },
          profile: { type: "string" },
          session: { type: "string" },
          reasoning: { type: "string" },
          help: { type: "boolean", short: "h", default: false },
        },
      }),
    (cause) =>
      new CliArgumentsInvalid({
        cause,
        message: "Invalid command-line arguments",
      }),
  );
  if (parsed.status === "error") return Result.err(parsed.error);
  const values: ParsedCliValues = parsed.value.values;

  const reasoningInput = optional(values.reasoning);
  const reasoning =
    reasoningInput === undefined
      ? undefined
      : MINI_LILAC_REASONING_LEVELS.find((candidate) => candidate === reasoningInput);
  if (reasoningInput !== undefined && reasoning === undefined) {
    return Result.err(
      new CliArgumentsInvalid({
        message: `Invalid reasoning level '${reasoningInput}'; expected ${MINI_LILAC_REASONING_LEVELS.join(", ")}`,
      }),
    );
  }

  const cwd = canonicalCwd(input.cwd);
  if (cwd.status === "error") {
    return Result.err(new CliArgumentsInvalid({ cause: cwd.error, message: cwd.error.message }));
  }
  return Result.ok({
    server: optional(values.server) ?? DEFAULT_SERVER_URL,
    token: optional(values.token) ?? firstNonEmpty(input.env, TOKEN_ENV_VARS),
    model: optional(values.model),
    profile: optional(values.profile),
    session: optional(values.session),
    reasoning,
    // Resolve symlinks as well as relative segments so resumed-session checks
    // and transport binding use one canonical workspace identity.
    cwd: cwd.value,
    help: values.help === true,
  });
}

export const HELP_TEXT = `mini-lilac — OpenTUI client for mini-lilac

Usage:
  mini-lilac [options]
  mini-lilac tui [options]

Options:
  --server <url>      Mini-lilac API base URL (default: ${DEFAULT_SERVER_URL})
  --token <token>     Bearer token (or set MINI_LILAC_TOKEN)
  --model <id>        Model id in provider/model form (e.g. anthropic/claude-sonnet-4-20250514)
  --profile <id>      Agent profile id
  --session <id>      Resume an existing session id
  --reasoning <level> One of: ${MINI_LILAC_REASONING_LEVELS.join(", ")}
  -h, --help          Show this help

Keys:
  Enter       idle: send prompt | active: queue steer (empty + queued: interrupt)
  Ctrl-J      insert a newline
  Shift-Enter insert a newline when supported by the terminal
  /           open the command palette from an empty prompt
  Tab         cycle top-level agent profiles
  Esc         interrupt active work; never exit
  Ctrl-C      first clears the draft; second exits

Commands:
  /new        start a new session with the current settings
  /todo       view all session todos
  /undo       remove the latest user message and following transcript
  /rollback   alias for /undo
  /redo       restore the latest undone turn
  /model      choose a configured model
  /reasoning  choose reasoning effort
`;
