import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { homedir } from "node:os";
import path from "node:path";
import { NoNativeCache } from "@stanley2058/lilac-client";
import { Panic, Result, TaggedError } from "better-result";
import { createTuiAuth, type TuiAuthSession, type TuiAuthError } from "./auth.ts";
import { DiskNativeCache } from "./cache.ts";
import { captureTuiException, rethrowTuiDefect } from "./fatal.ts";
import { createTuiSession, type TuiSession, type TuiRequestError } from "./session.ts";

export class TuiCliError extends TaggedError("TuiCliError")<{ message: string }> {}
export type TuiCliOptions =
  | { kind: "run"; url: string; cache: boolean; login: boolean; threadId?: string }
  | { kind: "help" | "version" };

export const TUI_HELP = `Usage: lilac-tui [options]

  --url URL       Native server URL (default http://127.0.0.1:8787)
  --thread ID     Open a conversation
  --no-cache      Disable local conversation replay cache
  --login         Sign in again, ignoring saved credentials
  --help, -h      Show this help
  --version, -v   Show version

The server selects local or Clerk authentication. Local login asks for a
username and hidden password. Clerk login opens your browser.
`;

export function parseTuiArgs(args: string[]): Result<TuiCliOptions, TuiCliError> {
  let url = "http://127.0.0.1:8787";
  let cache = true;
  let login = false;
  let threadId: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    switch (arg) {
      case "--help":
      case "-h":
        return Result.ok({ kind: "help" });
      case "--version":
      case "-v":
        return Result.ok({ kind: "version" });
      case "--no-cache":
        cache = false;
        break;
      case "--login":
        login = true;
        break;
      case "--url":
      case "--thread": {
        const value = args[++index];
        if (!value || value.startsWith("--"))
          return Result.err(new TuiCliError({ message: `${arg} requires a value.` }));
        if (arg === "--url") url = value;
        else threadId = value;
        break;
      }
      default:
        return Result.err(
          new TuiCliError({ message: "Unknown option. Run lilac-tui --help for usage." }),
        );
    }
  }
  const parsed = Result.try({
    try: () => new URL(url),
    catch: () => new TuiCliError({ message: "--url must be an HTTP or HTTPS server URL." }),
  });
  return parsed.andThen((value) => {
    if (
      !["http:", "https:"].includes(value.protocol) ||
      value.username ||
      value.password ||
      value.pathname !== "/" ||
      value.search ||
      value.hash
    )
      return Result.err(
        new TuiCliError({
          message:
            "--url must be an HTTP or HTTPS origin without credentials, a path, or query parameters.",
        }),
      );
    return Result.ok<TuiCliOptions>({ kind: "run", url: value.origin, cache, login, threadId });
  });
}

async function requestLocalCredentials(): Promise<{ username: string; password: string }> {
  let hidden = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!hidden) process.stdout.write(chunk);
      done();
    },
  });
  const reader = createInterface({ input: process.stdin, output, terminal: true });
  const canceled = new AbortController();
  reader.on("SIGINT", () => canceled.abort());
  const credentials = await Result.tryPromise({
    try: async () => {
      const username = await reader.question("Username: ", { signal: canceled.signal });
      process.stdout.write("Password: ");
      hidden = true;
      const password = await reader.question("", { signal: canceled.signal });
      return { username, password };
    },
    catch: () => new TuiCliError({ message: "Sign-in canceled." }),
  });
  reader.close();
  process.stdout.write("\n");
  return credentials.match({ ok: (value) => value, err: () => ({ username: "", password: "" }) });
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const result = await Result.tryPromise({
    try: async () => {
      const child = Bun.spawn([command, url], { stdout: "ignore", stderr: "ignore" });
      return await child.exited;
    },
    catch: () => -1,
  });
  const status = result.match({ ok: (value) => value, err: (value) => value });
  if (status !== 0) process.stdout.write(`Open this sign-in page in your browser:\n${url}\n`);
}

async function run(
  options: Extract<TuiCliOptions, { kind: "run" }>,
): Promise<Result<void, TuiCliError>> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    return Result.err(
      new TuiCliError({
        message: "lilac-tui requires an interactive terminal. Use --help for options.",
      }),
    );
  const credentialDirectory = path.join(
    process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
    "lilac",
    "tui",
  );
  const cacheDirectory = path.join(
    process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"),
    "lilac",
    "tui",
  );
  const authOptions = {
    baseUrl: options.url,
    credentialDirectory,
    requestLocalCredentials,
    openBrowser,
    forceLogin: options.login,
  };
  const authResult = await createTuiAuth(authOptions);
  const auth = authResult.match<{ value: TuiAuthSession } | { error: TuiAuthError }>({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in auth) return Result.err(new TuiCliError({ message: auth.error.message }));
  const cache = options.cache ? new DiskNativeCache(cacheDirectory) : new NoNativeCache();
  let activeAuth = auth.value;
  let sessionResult = await createTuiSession(options.url, activeAuth, cache);
  const needsLogin = sessionResult.match({
    ok: () => false,
    err: (error) => error.code === "unauthenticated",
  });
  if (needsLogin) {
    auth.value.dispose();
    const retry = await createTuiAuth({ ...authOptions, forceLogin: true });
    const next = retry.match<{ value: TuiAuthSession } | { error: TuiAuthError }>({
      ok: (value) => ({ value }),
      err: (error) => ({ error }),
    });
    if ("error" in next) return Result.err(new TuiCliError({ message: next.error.message }));
    activeAuth = next.value;
    sessionResult = await createTuiSession(options.url, activeAuth, cache);
  }
  const session = sessionResult.match<{ value: TuiSession } | { error: TuiRequestError }>({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in session) {
    activeAuth.dispose();
    return Result.err(new TuiCliError({ message: session.error.message }));
  }
  await runTuiWithCleanup(
    async () => {
      const { runTui } = await import("./app.tsx");
      await runTui(session.value, options.threadId);
    },
    () => session.value.dispose(),
  );
  return Result.ok();
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
  const options = parsed.options;
  if (options.kind !== "run") return 0;
  return (await run(options)).match({
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
