import { NoNativeCache } from "@stanley2058/lilac-client";
import { Panic, Result, TaggedError } from "better-result";
import { createTuiAuth, OPERATOR_URL } from "./auth.ts";
import { captureTuiException, rethrowTuiDefect } from "./fatal.ts";
import { createTuiSession, type TuiSession, type TuiRequestError } from "./session.ts";

export class TuiCliError extends TaggedError("TuiCliError")<{ message: string }> {}
export type TuiCliOptions = { kind: "run" | "help" | "version" };
export const TUI_HELP = `Usage: lilac-tui [--help | --version]

Run inside the Lilac container as root:
  docker compose exec --user root lilac lilac-tui

Each invocation opens one temporary conversation, deleted on exit.
Ctrl+C cancels work. Ctrl+Q exits. Agent-created files remain.
`;

export function parseTuiArgs(args: string[]): Result<TuiCliOptions, TuiCliError> {
  if (!args.length) return Result.ok({ kind: "run" });
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) return Result.ok({ kind: "help" });
  if (args.length === 1 && ["--version", "-v"].includes(args[0]!))
    return Result.ok({ kind: "version" });
  return Result.err(
    new TuiCliError({ message: "Unknown option. Run lilac-tui --help for usage." }),
  );
}

async function run(): Promise<Result<void, TuiCliError>> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    return Result.err(new TuiCliError({ message: "lilac-tui requires an interactive terminal." }));
  return Result.gen(async function* () {
    const auth = yield* (await createTuiAuth()).mapError(
      (error) => new TuiCliError({ message: error.message }),
    );
    const created = await createTuiSession(OPERATOR_URL, auth, new NoNativeCache());
    const selected = created.match<{ session: TuiSession } | { error: TuiRequestError }>({
      ok: (session) => ({ session }),
      err: (error) => ({ error }),
    });
    if ("error" in selected) {
      await auth.logout();
      auth.dispose();
      return Result.err(new TuiCliError({ message: selected.error.message }));
    }
    const session = selected.session;
    await runTuiWithCleanup(
      async () => {
        const { runTui } = await import("./app.tsx");
        await runTui(session, auth.threadId);
      },
      () => session.logout(),
    );
    return Result.ok();
  });
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const parsed = parseTuiArgs(args).match<{ options: TuiCliOptions } | { error: TuiCliError }>({
    ok: (options) => ({ options }),
    err: (error) => ({ error }),
  });
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error.message}\n`);
    return 1;
  }
  if (parsed.options.kind === "help") {
    process.stdout.write(TUI_HELP);
    return 0;
  }
  if (parsed.options.kind === "version") {
    process.stdout.write(`lilac-tui ${process.env.LILAC_TUI_VERSION || "development"}\n`);
    return 0;
  }
  return (await run()).match({
    ok: () => 0,
    err: (error) => {
      process.stderr.write(`${error.message}\n`);
      return 1;
    },
  });
}

export async function runTuiWithCleanup(
  operation: () => Promise<void>,
  cleanup: () => Promise<void>,
): Promise<void> {
  const attempted = await Result.tryPromise({ try: operation, catch: captureTuiException });
  const cleaned = await Result.tryPromise({ try: cleanup, catch: captureTuiException });
  const operationError = attempted.match({ ok: () => undefined, err: (error) => error });
  const cleanupError = cleaned.match({ ok: () => undefined, err: (error) => error });
  if (operationError && Panic.is(operationError)) rethrowTuiDefect(operationError);
  if (cleanupError && Panic.is(cleanupError)) rethrowTuiDefect(cleanupError);
  if (operationError) rethrowTuiDefect(operationError);
  if (cleanupError) rethrowTuiDefect(cleanupError);
}

export async function runTuiHost(
  operation: () => Promise<number>,
  report: (message: string) => void,
): Promise<number> {
  const attempted = await Result.tryPromise({ try: operation, catch: captureTuiException });
  const outcome = attempted.match({
    ok: (code) => ({ code, failed: false }),
    err: () => ({ code: 1, failed: true }),
  });
  if (outcome.failed)
    report(
      "Lilac terminal client stopped because of an internal error. Reconnect with lilac-tui. Error details were withheld to protect credentials.",
    );
  return outcome.code;
}

if (import.meta.main)
  process.exitCode = await runTuiHost(
    () => main(),
    (message) => process.stderr.write(`${message}\n`),
  );
