import { homedir } from "node:os";
import path from "node:path";

import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

const HELP_TEXT = `mini-lilac - local coding-agent clients and server

Usage:
  mini-lilac [tui-options]
  mini-lilac tui [tui-options]
  mini-lilac server [server-options]
  mini-lilac history-recovery status [--workspace <cwd>] [--database <path>]
  mini-lilac history-recovery abandon --workspace <cwd> --acknowledge-partial-worktree [--database <path>]

Commands:
  tui      Start the terminal client (default)
  server   Start or administer the Mini Lilac server
  history-recovery  Inspect or abandon blocked workspace history recovery

Run 'mini-lilac tui --help' or 'mini-lilac server --help' for command options.
`;

export type MiniLilacCommandRunners = {
  readonly tui: (args: readonly string[]) => Promise<number>;
  readonly server: (args: readonly string[]) => Promise<void>;
};

class MiniLilacCommandFailed extends TaggedError("MiniLilacCommandFailed")<{
  readonly command: "cli" | "server" | "tui";
  readonly cause: unknown;
  readonly message: string;
}> {}

function ensureServerDataDir(
  env: Record<string, string | undefined>,
  homeDirectory = homedir(),
): void {
  if (env.DATA_DIR?.trim()) return;
  const stateHome = env.XDG_STATE_HOME?.trim() || path.join(homeDirectory, ".local", "state");
  env.DATA_DIR = path.join(stateHome, "mini-lilac");
}

const defaultRunners: MiniLilacCommandRunners = {
  async tui(args) {
    const { main } = await import("../../mini-lilac-tui/src/main");
    return main(args);
  },
  async server(args) {
    ensureServerDataDir(process.env);
    const { main } = await import("../../mini-lilac-server/src/main");
    await main(args);
  },
};

async function captureCommand<T>(
  command: "cli" | "server" | "tui",
  operation: () => Promise<T>,
): Promise<ResultType<T, MiniLilacCommandFailed>> {
  try {
    return Result.ok(await operation());
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    const message = cause instanceof Error ? cause.message : "Mini Lilac command failed";
    return Result.err(new MiniLilacCommandFailed({ command, cause, message }));
  }
}

export async function runMiniLilac(
  args: readonly string[],
  runners: MiniLilacCommandRunners = defaultRunners,
  writeOutput: (text: string) => void = (text) => process.stdout.write(text),
): Promise<ResultType<number, MiniLilacCommandFailed>> {
  const [command, ...commandArgs] = args;

  if (command === "--help" || command === "-h" || command === "help") {
    const output = await captureCommand("cli", async () => writeOutput(HELP_TEXT));
    return output.status === "ok" ? Result.ok(0) : Result.err(output.error);
  }
  if (command === "server") {
    const server = await captureCommand("server", () => runners.server(commandArgs));
    return server.status === "ok" ? Result.ok(0) : Result.err(server.error);
  }
  if (command === "history-recovery") {
    const server = await captureCommand("server", () => runners.server([command, ...commandArgs]));
    return server.status === "ok" ? Result.ok(0) : Result.err(server.error);
  }
  if (command === "tui") return captureCommand("tui", () => runners.tui(commandArgs));
  return captureCommand("tui", () => runners.tui(args));
}

export async function runMiniLilacMain(
  args: readonly string[],
  runners: MiniLilacCommandRunners = defaultRunners,
  writeOutput: (text: string) => void = (text) => process.stdout.write(text),
  writeError: (text: string) => void = (text) => process.stderr.write(text),
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): Promise<void> {
  const result = await runMiniLilac(args, runners, writeOutput);
  if (result.status === "error") {
    writeError(`${result.error.message}\n`);
    setExitCode(1);
    return;
  }
  setExitCode(result.value);
}

if (import.meta.main) await runMiniLilacMain(process.argv.slice(2));
