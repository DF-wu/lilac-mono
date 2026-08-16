import { chmod, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  loadProviderRegistry,
  loadRuntimeConfig,
  ModelCatalog,
  modelCapabilityOverrides,
  MiniLilacSkillCatalog,
  MiniLilacSqliteStore,
  readMiniLilacHistoryRecoveryStatus,
  SessionService,
  type PendingStoredRunFinalization,
  type StoredHistoryOperation,
} from "@stanley2058/mini-lilac-runtime";
import {
  adaptToolResultArtifactStoreInitToHost,
  createToolResultArtifactStore,
} from "@stanley2058/lilac-tool-results";
import {
  clearCodexTokens,
  createCodexOAuthProvider,
  ModelCapability,
  readCodexTokens,
  startCodexOAuthLogin,
  writeCodexTokens,
  type CodexOAuthLoginWithResult,
  opaqueErrorMessage,
  errorCode,
} from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import authConfigTemplate from "../auth.example.json" with { type: "text" };
import runtimeConfigTemplate from "../config.example.yaml" with { type: "text" };
import providerConfigTemplate from "../providers.example.yaml" with { type: "text" };
import { createMiniLilacServer } from "./server";

const FLOCK_CONTENTION_EXIT_CODE = 200;
const FLOCK_READY_BYTE = 0x6c;
const SHUTDOWN_GRACE_MS = 10_000;
const SHUTDOWN_POLL_INTERVAL_MS = 25;

export type MiniLilacDatabaseLock = {
  readonly lockPath: string;
  releaseResult(): Promise<ResultType<void, MiniLilacServerCleanupFailure>>;
  release(): Promise<void>;
};

export class MiniLilacServerFailure extends TaggedError("MiniLilacServerFailure")<{
  readonly operation: string;
  readonly cause?: Error;
  readonly code?: string;
  readonly message: string;
}> {}

export class MiniLilacServerCleanupFailure extends TaggedError("MiniLilacServerCleanupFailure")<{
  readonly operation: string;
  readonly cause?: Error;
  readonly message: string;
}> {}

export class MiniLilacServerCleanupCombinedFailure extends TaggedError(
  "MiniLilacServerCleanupCombinedFailure",
)<{
  readonly failures: readonly MiniLilacServerCleanupFailure[];
  readonly message: string;
}> {}

export type MiniLilacCleanupFailure =
  | MiniLilacServerCleanupFailure
  | MiniLilacServerCleanupCombinedFailure;

export class MiniLilacServerOperationAndCleanupFailure extends TaggedError(
  "MiniLilacServerOperationAndCleanupFailure",
)<{
  readonly operationError: MiniLilacServerFailure;
  readonly cleanupError: MiniLilacCleanupFailure;
  readonly message: string;
}> {}

export type MiniLilacLifecycleFailure =
  | MiniLilacServerFailure
  | MiniLilacCleanupFailure
  | MiniLilacServerOperationAndCleanupFailure;

export class MiniLilacDatabaseLockError extends Error {
  constructor(
    message: string,
    readonly lockPath: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MiniLilacDatabaseLockError";
  }
}

function serverFailureWithMessage(
  operation: string,
  message: string,
  cause?: Error,
): MiniLilacServerFailure {
  return new MiniLilacServerFailure({ operation, cause, code: errorCode(cause), message });
}

function cleanupFailureWithMessage(
  operation: string,
  message: string,
  cause?: Error,
): MiniLilacServerCleanupFailure {
  return new MiniLilacServerCleanupFailure({ operation, cause, message });
}

async function captureServerOperation<T>(
  operation: string,
  effect: () => Promise<T>,
): Promise<ResultType<T, MiniLilacServerFailure>> {
  try {
    return Result.ok(await effect());
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new MiniLilacServerFailure({
        operation,
        ...(cause instanceof Error ? { cause, code: errorCode(cause) } : {}),
        message: opaqueErrorMessage(cause, `${operation} failed`),
      }),
    );
  }
}

async function captureServerCleanup(
  operation: string,
  effect: () => void | Promise<void>,
): Promise<ResultType<void, MiniLilacServerCleanupFailure>> {
  try {
    await effect();
    return Result.ok(undefined);
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new MiniLilacServerCleanupFailure({
        operation,
        ...(cause instanceof Error ? { cause } : {}),
        message: opaqueErrorMessage(cause, `${operation} cleanup failed`),
      }),
    );
  }
}

function adaptLifecycleResultToHost<T>(result: ResultType<T, MiniLilacLifecycleFailure>): T {
  let value!: T;
  let failure: MiniLilacLifecycleFailure | undefined;
  result.match({
    ok: (resultValue) => void (value = resultValue),
    err: (error) => void (failure = error),
  });
  if (failure !== undefined) throw failure;
  return value;
}

function combineCleanupFailures(
  first: MiniLilacCleanupFailure | undefined,
  second: MiniLilacServerCleanupFailure,
): MiniLilacCleanupFailure {
  if (first === undefined) return second;
  const failures =
    first._tag === "MiniLilacServerCleanupFailure" ? [first, second] : [...first.failures, second];
  return new MiniLilacServerCleanupCombinedFailure({
    failures,
    message: failures.map((failure) => failure.message).join("; cleanup also failed: "),
  });
}

function mergeCleanupFailures(
  first: MiniLilacCleanupFailure | undefined,
  second: MiniLilacCleanupFailure,
): MiniLilacCleanupFailure {
  if (second._tag === "MiniLilacServerCleanupFailure") {
    return combineCleanupFailures(first, second);
  }
  let combined = first;
  for (const failure of second.failures) {
    combined = combineCleanupFailures(combined, failure);
  }
  return combined ?? second;
}

function combineLifecycleFailureWithCleanup(
  failure: MiniLilacLifecycleFailure,
  cleanup: MiniLilacCleanupFailure,
): MiniLilacLifecycleFailure {
  switch (failure._tag) {
    case "MiniLilacServerFailure": {
      return new MiniLilacServerOperationAndCleanupFailure({
        operationError: failure,
        cleanupError: cleanup,
        message: `${failure.message}; cleanup also failed: ${cleanup.message}`,
      });
    }
    case "MiniLilacServerCleanupFailure":
    case "MiniLilacServerCleanupCombinedFailure":
      return mergeCleanupFailures(failure, cleanup);
    case "MiniLilacServerOperationAndCleanupFailure": {
      const cleanupError = mergeCleanupFailures(failure.cleanupError, cleanup);
      return new MiniLilacServerOperationAndCleanupFailure({
        operationError: failure.operationError,
        cleanupError,
        message: `${failure.operationError.message}; cleanup also failed: ${cleanupError.message}`,
      });
    }
  }
}

export function databaseLockPath(databasePath: string): string {
  return `${path.resolve(databasePath)}.mini-lilac.lock`;
}

export async function acquireDatabaseLockResult(
  databasePath: string,
): Promise<ResultType<MiniLilacDatabaseLock, MiniLilacServerFailure>> {
  const resolvedDatabasePath = path.resolve(databasePath);
  const lockPath = databaseLockPath(resolvedDatabasePath);
  const started = await captureServerOperation("acquire database lock", async () => {
    await mkdir(path.dirname(resolvedDatabasePath), { recursive: true, mode: 0o700 });
    return Bun.spawn(
      [
        "flock",
        "--exclusive",
        "--nonblock",
        "--conflict-exit-code",
        String(FLOCK_CONTENTION_EXIT_CODE),
        "--no-fork",
        lockPath,
        "cat",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true },
    );
  });
  let holder!: Bun.Subprocess<"pipe", "pipe", "pipe">;
  let startFailure: MiniLilacServerFailure | undefined;
  started.match({
    ok: (startedHolder) => void (holder = startedHolder),
    err: (error) =>
      void (startFailure = serverFailureWithMessage(
        "acquire database lock",
        `Failed to start database lock holder for '${lockPath}'; ensure 'flock' is installed`,
        error,
      )),
  });
  if (startFailure !== undefined) return Result.err(startFailure);

  const reader = holder.stdout.getReader();
  const handshake = await captureServerOperation("database lock handshake", async () => {
    holder.stdin.write(new Uint8Array([FLOCK_READY_BYTE]));
    await holder.stdin.flush();
    return (await reader.read()).value?.[0];
  });
  reader.releaseLock();

  let handshakeValue: number | undefined;
  let handshakeFailure: MiniLilacServerFailure | undefined;
  handshake.match({
    ok: (value) => void (handshakeValue = value),
    err: (error) => void (handshakeFailure = error),
  });
  if (handshakeFailure !== undefined || handshakeValue !== FLOCK_READY_BYTE) {
    holder.stdin.end();
    const settled = await captureServerOperation("database lock holder exit", async () =>
      Promise.all([holder.exited, new Response(holder.stderr).text()]),
    );
    let settlement!: [number, string];
    let settlementFailure: MiniLilacServerFailure | undefined;
    settled.match({
      ok: (value) => void (settlement = value),
      err: (error) => void (settlementFailure = error),
    });
    if (settlementFailure !== undefined) return Result.err(settlementFailure);
    const [exitCode, stderr] = settlement;
    if (exitCode === FLOCK_CONTENTION_EXIT_CODE) {
      return Result.err(
        serverFailureWithMessage(
          "acquire database lock",
          `Mini Lilac is already using database '${resolvedDatabasePath}'`,
          handshakeFailure,
        ),
      );
    }
    const detail = stderr.trim();
    return Result.err(
      serverFailureWithMessage(
        "acquire database lock",
        `Failed to acquire database lock '${lockPath}' (flock exited with code ${exitCode})${
          detail ? `: ${detail}` : ""
        }`,
        handshakeFailure,
      ),
    );
  }

  let releasePromise: Promise<ResultType<void, MiniLilacServerCleanupFailure>> | undefined;
  const lock: MiniLilacDatabaseLock = {
    lockPath,
    releaseResult() {
      releasePromise ??= (async () => {
        holder.stdin.end();
        const exited = await captureServerOperation("release database lock", () => holder.exited);
        return exited.match({
          ok: (exitCode) =>
            exitCode === 0
              ? Result.ok(undefined)
              : Result.err(
                  cleanupFailureWithMessage(
                    "release database lock",
                    `Failed to release database lock '${lockPath}' (flock exited with code ${exitCode})`,
                  ),
                ),
          err: (error) =>
            Result.err(
              cleanupFailureWithMessage(
                "release database lock",
                `Failed to release database lock '${lockPath}'`,
                error,
              ),
            ),
        });
      })();
      return releasePromise;
    },
    async release() {
      adaptLifecycleResultToHost(await this.releaseResult());
    },
  };
  return Result.ok(lock);
}

export async function acquireDatabaseLock(databasePath: string): Promise<MiniLilacDatabaseLock> {
  const result = await acquireDatabaseLockResult(databasePath);
  let lock!: MiniLilacDatabaseLock;
  let failure: MiniLilacServerFailure | undefined;
  result.match({
    ok: (value) => void (lock = value),
    err: (error) => void (failure = error),
  });
  if (failure !== undefined) {
    throw new MiniLilacDatabaseLockError(failure.message, databaseLockPath(databasePath), {
      cause: failure,
    });
  }
  return lock;
}

export type MiniLilacShutdownOptions = {
  readonly stopListener: (force: boolean) => void | Promise<void>;
  /** Reject new runtime admissions and abort actor-owned work before listener drain waits on it. */
  readonly requestRuntimeShutdown?: () => void | Promise<void>;
  readonly listActiveRuns: () => readonly { readonly sessionId: string; readonly runId: string }[];
  readonly cancelRun: (run: {
    readonly sessionId: string;
    readonly runId: string;
  }) => Promise<void>;
  readonly closeRuntime: () => void | Promise<void>;
  readonly graceMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

type ShutdownEffectSettlement =
  | { readonly kind: "success" }
  | { readonly kind: "failure" }
  | { readonly kind: "panic"; readonly panic: Panic };

async function settleShutdownEffect(
  effect: () => void | Promise<void>,
  onSettled: (settlement: ShutdownEffectSettlement) => void = () => {},
): Promise<ShutdownEffectSettlement> {
  try {
    await effect();
    const settlement = { kind: "success" } as const;
    onSettled(settlement);
    return settlement;
  } catch (cause) {
    const settlement: ShutdownEffectSettlement = Panic.is(cause)
      ? { kind: "panic", panic: cause }
      : { kind: "failure" };
    onSettled(settlement);
    return settlement;
  }
}

type SettledLifecycleResult<T> =
  | { readonly kind: "result"; readonly result: ResultType<T, MiniLilacLifecycleFailure> }
  | { readonly kind: "panic"; readonly panic: Panic };

type SettledCleanupResult =
  | {
      readonly kind: "result";
      readonly result: ResultType<void, MiniLilacServerCleanupFailure>;
    }
  | { readonly kind: "panic"; readonly panic: Panic };

function rethrowPanic(panic: Panic): never {
  Panic.is(panic);
  throw panic;
}

async function settleLifecycleResult<T>(
  operation: string,
  effect: () => Promise<ResultType<T, MiniLilacLifecycleFailure>>,
): Promise<SettledLifecycleResult<T>> {
  try {
    return { kind: "result", result: await effect() };
  } catch (cause) {
    if (Panic.is(cause)) return { kind: "panic", panic: cause };
    return {
      kind: "result",
      result: Result.err(
        new MiniLilacServerFailure({
          operation,
          ...(cause instanceof Error ? { cause, code: errorCode(cause) } : {}),
          message: opaqueErrorMessage(cause, `${operation} failed`),
        }),
      ),
    };
  }
}

async function settleCleanupEffect(
  operation: string,
  effect: () => void | Promise<void>,
): Promise<SettledCleanupResult> {
  try {
    await effect();
    return { kind: "result", result: Result.ok(undefined) };
  } catch (cause) {
    if (Panic.is(cause)) return { kind: "panic", panic: cause };
    return {
      kind: "result",
      result: Result.err(
        new MiniLilacServerCleanupFailure({
          operation,
          ...(cause instanceof Error ? { cause } : {}),
          message: opaqueErrorMessage(cause, `${operation} cleanup failed`),
        }),
      ),
    };
  }
}

async function settleCleanupResult(
  operation: string,
  effect: () => Promise<ResultType<void, MiniLilacServerCleanupFailure>>,
): Promise<SettledCleanupResult> {
  try {
    return { kind: "result", result: await effect() };
  } catch (cause) {
    if (Panic.is(cause)) return { kind: "panic", panic: cause };
    return {
      kind: "result",
      result: Result.err(
        new MiniLilacServerCleanupFailure({
          operation,
          ...(cause instanceof Error ? { cause } : {}),
          message: opaqueErrorMessage(cause, `${operation} cleanup failed`),
        }),
      ),
    };
  }
}

export async function shutdownMiniLilacServerResult(
  options: MiniLilacShutdownOptions,
): Promise<ResultType<void, MiniLilacLifecycleFailure>> {
  const operation = await settleLifecycleResult("shutdown Mini Lilac server", async () => {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? Bun.sleep;
    const graceMs = options.graceMs ?? SHUTDOWN_GRACE_MS;
    const pollIntervalMs = options.pollIntervalMs ?? SHUTDOWN_POLL_INTERVAL_MS;
    const deadline = now() + graceMs;
    let listenerSettled = false;
    let listenerFailed = false;
    let shutdownPanic: Panic | undefined;
    const rememberPanic = (settlement: ShutdownEffectSettlement): void => {
      if (settlement.kind === "panic" && shutdownPanic === undefined) {
        shutdownPanic = settlement.panic;
      }
    };
    const gracefulStop = settleShutdownEffect(
      () => options.stopListener(false),
      (settlement) => {
        listenerSettled = true;
        listenerFailed = settlement.kind === "failure";
        rememberPanic(settlement);
      },
    );

    // Admit explicit run cancellations before the runtime shutdown request closes
    // admission. Actor shutdown also cancels them, but these requests preserve
    // the server's normal run lifecycle.
    let settledEffects = 0;
    const trackEffect = (effect: () => void | Promise<void>) =>
      settleShutdownEffect(effect, (settlement) => {
        settledEffects += 1;
        rememberPanic(settlement);
      });
    const effects = [
      ...options.listActiveRuns().map((run) => trackEffect(() => options.cancelRun(run))),
      trackEffect(async () => options.requestRuntimeShutdown?.()),
    ];
    const cancellations = Promise.all(effects);

    while (
      shutdownPanic === undefined &&
      (!listenerSettled ||
        settledEffects < effects.length ||
        options.listActiveRuns().length > 0) &&
      now() < deadline
    ) {
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
    }

    if (shutdownPanic !== undefined) throw shutdownPanic;

    const force =
      listenerFailed ||
      !listenerSettled ||
      settledEffects < effects.length ||
      options.listActiveRuns().length > 0;
    if (force) {
      await options.stopListener(true);
    } else {
      await Promise.all([gracefulStop, cancellations]);
    }
    return Result.ok(undefined);
  });
  const cleanup = await settleCleanupEffect("close Mini Lilac runtime", options.closeRuntime);

  if (operation.kind === "panic") rethrowPanic(operation.panic);
  if (cleanup.kind === "panic") rethrowPanic(cleanup.panic);
  return operation.result.match<ResultType<void, MiniLilacLifecycleFailure>>({
    ok: () => cleanup.result,
    err: (operationError) =>
      cleanup.result.match<ResultType<void, MiniLilacLifecycleFailure>>({
        ok: () => Result.err(operationError),
        err: (cleanupError) =>
          Result.err(combineLifecycleFailureWithCleanup(operationError, cleanupError)),
      }),
  });
}

export async function shutdownMiniLilacServer(options: MiniLilacShutdownOptions): Promise<void> {
  adaptLifecycleResultToHost(await shutdownMiniLilacServerResult(options));
}

export async function shutdownMiniLilacServerAndReleaseLockResult(
  options: MiniLilacShutdownOptions,
  databaseLock: MiniLilacDatabaseLock,
): Promise<ResultType<void, MiniLilacLifecycleFailure>> {
  const shutdown = await settleLifecycleResult("shutdown Mini Lilac server", () =>
    shutdownMiniLilacServerResult(options),
  );
  const lockCleanup = await settleCleanupResult("release database lock", () =>
    databaseLock.releaseResult(),
  );

  if (shutdown.kind === "panic") rethrowPanic(shutdown.panic);
  if (lockCleanup.kind === "panic") rethrowPanic(lockCleanup.panic);
  return shutdown.result.match<ResultType<void, MiniLilacLifecycleFailure>>({
    ok: () => lockCleanup.result,
    err: (shutdownError) =>
      lockCleanup.result.match<ResultType<void, MiniLilacLifecycleFailure>>({
        ok: () => Result.err(shutdownError),
        err: (cleanupError) =>
          Result.err(combineLifecycleFailureWithCleanup(shutdownError, cleanupError)),
      }),
  });
}

const serveOptionsSchema = z.object({
  command: z.literal("serve"),
  config: z.string().trim().min(1).optional(),
  database: z.string().trim().min(1).optional(),
});

const authOptionsSchema = z.object({
  command: z.literal("auth"),
  provider: z.literal("codex"),
  action: z.enum(["login", "status", "logout"]),
});

const initOptionsSchema = z.object({
  command: z.literal("init"),
  force: z.boolean(),
});

const historyRecoveryStatusOptionsSchema = z.object({
  command: z.literal("history-recovery"),
  action: z.literal("status"),
  workspace: z.string().trim().min(1).optional(),
  database: z.string().trim().min(1).optional(),
});

const historyRecoveryAbandonOptionsSchema = z.object({
  command: z.literal("history-recovery"),
  action: z.literal("abandon"),
  workspace: z.string().trim().min(1),
  acknowledgePartialWorktree: z.literal(true),
  database: z.string().trim().min(1).optional(),
});

const historyRecoveryOptionsSchema = z.discriminatedUnion("action", [
  historyRecoveryStatusOptionsSchema,
  historyRecoveryAbandonOptionsSchema,
]);

const helpOptionsSchema = z.object({ command: z.literal("help") });

export type MiniLilacServerCliOptions =
  | z.infer<typeof serveOptionsSchema>
  | z.infer<typeof authOptionsSchema>
  | z.infer<typeof initOptionsSchema>
  | z.infer<typeof historyRecoveryOptionsSchema>
  | z.infer<typeof helpOptionsSchema>;

export const MINI_LILAC_SERVER_HELP = `Usage:
  mini-lilac server [--config <file>] [--database <file>]
  mini-lilac server init [--force]
  mini-lilac server auth codex [--status | --logout]
  mini-lilac history-recovery status [--workspace <cwd>] [--database <path>]
  mini-lilac history-recovery abandon --workspace <cwd> --acknowledge-partial-worktree [--database <path>]

Commands:
  init                 Create missing server configuration files in the state directory
  auth codex           Sign in with OpenAI Codex OAuth and store Lilac-owned tokens
  auth codex --status  Show Codex OAuth status without printing tokens
  auth codex --logout  Clear stored Lilac Codex OAuth tokens
  history-recovery     Inspect or explicitly abandon blocked workspace history recovery

Providers of type 'claude-code' need no Lilac auth command and no auth.json
entry; authenticate with the official Claude CLI (claude auth login).

Options:
  --config <file>    Server config (default: $XDG_STATE_HOME/mini-lilac/config.yaml)
  --database <file>  SQLite database (default: $XDG_STATE_HOME/mini-lilac/mini-lilac.sqlite)
  --force            Replace existing files when running init
  --workspace <cwd>  Filter recovery status or select the exact workspace to abandon
  --help             Show this help`;

function decodeMiniLilacCliOptions<T>(
  schema: z.ZodType<T>,
  input: unknown,
): ResultType<T, MiniLilacServerFailure> {
  const decoded = schema.safeParse(input);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    serverFailureWithMessage("parse Mini Lilac CLI", z.prettifyError(decoded.error), decoded.error),
  );
}

function captureNodeCliParsing<T>(operation: () => T): ResultType<T, MiniLilacServerFailure> {
  try {
    return Result.ok(operation());
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new MiniLilacServerFailure({
        operation: "parse Mini Lilac CLI",
        ...(cause instanceof Error ? { cause, code: errorCode(cause) } : {}),
        message: opaqueErrorMessage(cause, "Invalid CLI arguments"),
      }),
    );
  }
}

export function parseCliArgsResult(
  args: readonly string[],
): ResultType<MiniLilacServerCliOptions, MiniLilacServerFailure> {
  if (args.includes("--help")) {
    return decodeMiniLilacCliOptions(helpOptionsSchema, { command: "help" });
  }
  if (args[0] === "auth") {
    const provider = args[1];
    const parsed = captureNodeCliParsing(() =>
      parseArgs({
        args: args.slice(2),
        options: {
          status: { type: "boolean", default: false },
          logout: { type: "boolean", default: false },
        },
        allowPositionals: false,
        strict: true,
      }),
    );
    return parsed.andThen(({ values }) => {
      if (values.status && values.logout) {
        return Result.err(
          serverFailureWithMessage(
            "parse Mini Lilac CLI",
            "Choose only one of --status or --logout",
          ),
        );
      }
      let action: "login" | "logout" | "status" = "login";
      if (values.status) action = "status";
      else if (values.logout) action = "logout";
      return decodeMiniLilacCliOptions(authOptionsSchema, {
        command: "auth",
        provider,
        action,
      });
    });
  }
  if (args[0] === "init") {
    const parsed = captureNodeCliParsing(() =>
      parseArgs({
        args: args.slice(1),
        options: { force: { type: "boolean", default: false } },
        allowPositionals: false,
        strict: true,
      }),
    );
    return parsed.andThen(({ values }) =>
      decodeMiniLilacCliOptions(initOptionsSchema, {
        command: "init",
        force: values.force,
      }),
    );
  }
  if (args[0] === "history-recovery") {
    const action = args[1];
    const parsed = captureNodeCliParsing(() =>
      parseArgs({
        args: args.slice(2),
        options: {
          workspace: { type: "string" },
          database: { type: "string" },
          "acknowledge-partial-worktree": { type: "boolean", default: false },
        },
        allowPositionals: false,
        strict: true,
      }),
    );
    return parsed.andThen(({ values }) => {
      if (action === "status" && values["acknowledge-partial-worktree"]) {
        return Result.err(
          serverFailureWithMessage(
            "parse Mini Lilac CLI",
            "--acknowledge-partial-worktree is valid only with abandon",
          ),
        );
      }
      if (action === "abandon" && !values["acknowledge-partial-worktree"]) {
        return Result.err(
          serverFailureWithMessage(
            "parse Mini Lilac CLI",
            "history-recovery abandon requires --acknowledge-partial-worktree",
          ),
        );
      }
      return decodeMiniLilacCliOptions(historyRecoveryOptionsSchema, {
        command: "history-recovery",
        action,
        workspace: values.workspace,
        database: values.database,
        acknowledgePartialWorktree: values["acknowledge-partial-worktree"],
      });
    });
  }

  const parsed = captureNodeCliParsing(() =>
    parseArgs({
      args: [...args],
      options: {
        config: { type: "string" },
        database: { type: "string" },
      },
      allowPositionals: false,
      strict: true,
    }),
  );
  return parsed.andThen(({ values }) =>
    decodeMiniLilacCliOptions(serveOptionsSchema, {
      command: "serve",
      ...values,
    }),
  );
}

export function parseCliArgs(args: readonly string[]): MiniLilacServerCliOptions {
  return adaptLifecycleResultToHost(parseCliArgsResult(args));
}

export type MiniLilacAuthDependencies = {
  startLogin: () => Promise<CodexOAuthLoginWithResult>;
  readTokens: typeof readCodexTokens;
  clearTokens: typeof clearCodexTokens;
  storagePath: () => string;
  log: (message: string) => void;
};

export type MiniLilacStatePaths = {
  readonly directory: string;
  readonly configFile: string;
  readonly providerConfigFile: string;
  readonly providerAuthFile: string;
  readonly databaseFile: string;
  readonly codexOAuthFile: string;
  readonly modelsDevCacheFile: string;
  readonly toolResultsDirectory: string;
  readonly workspaceHistoryDirectory: string;
};

export type MiniLilacHistoryRecoveryReport = {
  readonly navigation: readonly {
    readonly workspace: string;
    readonly session: string;
    readonly command: string;
    readonly source: string;
    readonly target: string;
    readonly phase: StoredHistoryOperation["phase"];
    readonly update: string;
  }[];
  readonly pendingFinalizations: readonly {
    readonly workspace: string;
    readonly session: string;
    readonly run: string;
    readonly transition: string;
    readonly status: PendingStoredRunFinalization["runStatus"];
    readonly prepared: string;
  }[];
};

export type MiniLilacHistoryRecoveryCommandResult =
  | { readonly action: "status"; readonly report: MiniLilacHistoryRecoveryReport }
  | {
      readonly action: "abandon";
      readonly workspace: string;
      readonly session: string;
      readonly command: string;
      readonly code: "history-recovery-abandoned";
    };

async function canonicalWorkspaceResult(
  workspace: string,
): Promise<ResultType<string, MiniLilacServerFailure>> {
  const canonical = await captureServerOperation("resolve recovery workspace", () =>
    realpath(workspace),
  );
  let canonicalPath!: string;
  let canonicalFailure: MiniLilacServerFailure | undefined;
  canonical.match({
    ok: (value) => void (canonicalPath = value),
    err: (error) => void (canonicalFailure = error),
  });
  if (canonicalFailure !== undefined) {
    const code = canonicalFailure.code;
    if (code === "ENOENT" || code === "ENOTDIR") return Result.ok(path.resolve(workspace));
    return Result.err(canonicalFailure);
  }
  const metadata = await captureServerOperation("inspect recovery workspace", () =>
    stat(canonicalPath),
  );
  let metadataValue!: Awaited<ReturnType<typeof stat>>;
  let metadataFailure: MiniLilacServerFailure | undefined;
  metadata.match({
    ok: (value) => void (metadataValue = value),
    err: (error) => void (metadataFailure = error),
  });
  if (metadataFailure !== undefined) return Result.err(metadataFailure);
  return metadataValue.isDirectory()
    ? Result.ok(canonicalPath)
    : Result.err(
        serverFailureWithMessage(
          "inspect recovery workspace",
          `Workspace '${workspace}' is not a directory`,
        ),
      );
}

function recoveryWorkspace(
  store: MiniLilacSqliteStore,
  entry: StoredHistoryOperation | PendingStoredRunFinalization,
): string {
  return store.getWorkspaceForSession(entry.sessionId).canonicalCwd;
}

async function runHistoryRecoveryOperation(
  cli: z.infer<typeof historyRecoveryOptionsSchema>,
  options: {
    readonly defaultDatabasePath: string;
    readonly log?: (message: string) => void;
  },
  storeOwner: { store?: MiniLilacSqliteStore },
): Promise<ResultType<MiniLilacHistoryRecoveryCommandResult, MiniLilacServerFailure>> {
  const databasePath = path.resolve(cli.database ?? options.defaultDatabasePath);
  const log = options.log ?? console.log;
  let workspace: string | undefined;
  if (cli.workspace !== undefined) {
    const canonical = await canonicalWorkspaceResult(cli.workspace);
    let canonicalFailure: MiniLilacServerFailure | undefined;
    canonical.match({
      ok: (value) => void (workspace = value),
      err: (error) => void (canonicalFailure = error),
    });
    if (canonicalFailure !== undefined) return Result.err(canonicalFailure);
  }
  const databaseMetadata = await captureServerOperation("inspect recovery database", () =>
    stat(databasePath),
  );
  const databaseExists = databaseMetadata.match({
    ok: (metadata) => metadata.isFile(),
    err: () => false,
  });
  if (!databaseExists) {
    if (cli.action === "abandon") {
      return Result.err(
        serverFailureWithMessage(
          "abandon history recovery",
          `No retained history navigation exists for workspace '${workspace}'`,
        ),
      );
    }
    const report = { navigation: [], pendingFinalizations: [] };
    log(JSON.stringify(report, null, 2));
    return Result.ok({ action: "status", report });
  }

  if (cli.action === "status") {
    const inspected = readMiniLilacHistoryRecoveryStatus(databasePath);
    const report: MiniLilacHistoryRecoveryReport = {
      navigation: inspected.navigation
        .filter((entry) => workspace === undefined || entry.canonicalCwd === workspace)
        .map(({ canonicalCwd, operation }) => ({
          workspace: canonicalCwd,
          session: operation.sessionId,
          command: operation.commandId,
          source: operation.sourceStateId,
          target: operation.targetStateId,
          phase: operation.phase,
          update: operation.updatedAt,
        })),
      pendingFinalizations: inspected.pendingFinalizations
        .filter((entry) => workspace === undefined || entry.canonicalCwd === workspace)
        .map(({ canonicalCwd, finalization }) => ({
          workspace: canonicalCwd,
          session: finalization.sessionId,
          run: finalization.runId,
          transition: finalization.openTransitionId,
          status: finalization.runStatus,
          prepared: finalization.preparedAt,
        })),
    };
    log(JSON.stringify(report, null, 2));
    return Result.ok({ action: "status", report });
  }

  const openedStore = new MiniLilacSqliteStore(databasePath);
  storeOwner.store = openedStore;
  const navigation = openedStore.listHistoryOperations().filter((entry) => {
    return workspace === undefined || recoveryWorkspace(openedStore, entry) === workspace;
  });

  if (navigation.length === 0) {
    return Result.err(
      serverFailureWithMessage(
        "abandon history recovery",
        `No retained history navigation exists for workspace '${workspace}'`,
      ),
    );
  }
  if (navigation.length !== 1) {
    return Result.err(
      serverFailureWithMessage(
        "abandon history recovery",
        `Workspace '${workspace}' has ${navigation.length} retained history navigation operations`,
      ),
    );
  }
  if (workspace === undefined) {
    return Result.err(
      serverFailureWithMessage(
        "abandon history recovery",
        "history-recovery abandon requires an exact workspace",
      ),
    );
  }
  const operation = navigation[0];
  if (operation === undefined) {
    return Result.err(
      serverFailureWithMessage(
        "abandon history recovery",
        "Retained history navigation disappeared during inspection",
      ),
    );
  }
  const abandoned = openedStore.abandonHistoryNavigation({
    operationId: operation.id,
    acknowledgePartialWorktree: true,
    message: `Operator abandoned history recovery for '${workspace}' after acknowledging a potentially partial worktree; no worktree synchronization is claimed`,
  });
  const result = {
    action: "abandon",
    workspace,
    session: operation.sessionId,
    command: abandoned.commandId,
    code: abandoned.code,
  } as const;
  log(JSON.stringify(result, null, 2));
  return Result.ok(result);
}

export async function runHistoryRecoveryCommandResult(
  cli: z.infer<typeof historyRecoveryOptionsSchema>,
  options: {
    readonly defaultDatabasePath: string;
    readonly log?: (message: string) => void;
  },
): Promise<ResultType<MiniLilacHistoryRecoveryCommandResult, MiniLilacLifecycleFailure>> {
  const databasePath = path.resolve(cli.database ?? options.defaultDatabasePath);
  const acquired = await acquireDatabaseLockResult(databasePath);
  let lock!: MiniLilacDatabaseLock;
  let acquireFailure: MiniLilacServerFailure | undefined;
  acquired.match({
    ok: (value) => void (lock = value),
    err: (error) => void (acquireFailure = error),
  });
  if (acquireFailure !== undefined) return Result.err(acquireFailure);
  const storeOwner: { store?: MiniLilacSqliteStore } = {};
  const captured = await captureServerOperation("run history recovery command", () =>
    runHistoryRecoveryOperation(cli, options, storeOwner),
  );
  const operation = captured.andThen((result) => result);

  let cleanupError: MiniLilacCleanupFailure | undefined;
  if (storeOwner.store !== undefined) {
    const storeCleanup = await captureServerCleanup("close history recovery store", () =>
      storeOwner.store?.close(),
    );
    storeCleanup.match({
      ok: () => {},
      err: (error) => void (cleanupError = error),
    });
  }
  const lockCleanup = await lock.releaseResult();
  lockCleanup.match({
    ok: () => {},
    err: (error) => void (cleanupError = combineCleanupFailures(cleanupError, error)),
  });

  return operation.match<
    ResultType<MiniLilacHistoryRecoveryCommandResult, MiniLilacLifecycleFailure>
  >({
    ok: (value) => (cleanupError === undefined ? Result.ok(value) : Result.err(cleanupError)),
    err: (operationError) =>
      cleanupError === undefined
        ? Result.err(operationError)
        : Result.err(
            new MiniLilacServerOperationAndCleanupFailure({
              operationError,
              cleanupError,
              message: `${operationError.message}; cleanup also failed: ${cleanupError.message}`,
            }),
          ),
  });
}

export async function runHistoryRecoveryCommand(
  cli: z.infer<typeof historyRecoveryOptionsSchema>,
  options: {
    readonly defaultDatabasePath: string;
    readonly log?: (message: string) => void;
  },
): Promise<MiniLilacHistoryRecoveryCommandResult> {
  return adaptLifecycleResultToHost(await runHistoryRecoveryCommandResult(cli, options));
}

export function miniLilacStatePaths(
  env: Readonly<Record<string, string | undefined>> = process.env,
): MiniLilacStatePaths {
  const stateHome = env.XDG_STATE_HOME?.trim() || path.join(homedir(), ".local", "state");
  const directory = path.join(stateHome, "mini-lilac");
  return {
    directory,
    configFile: path.join(directory, "config.yaml"),
    providerConfigFile: path.join(directory, "providers.yaml"),
    providerAuthFile: path.join(directory, "auth.json"),
    databaseFile: path.join(directory, "mini-lilac.sqlite"),
    codexOAuthFile: path.join(directory, "codex.json"),
    modelsDevCacheFile: path.join(directory, "models-dev.json"),
    toolResultsDirectory: path.join(directory, "tool-results"),
    workspaceHistoryDirectory: path.join(directory, "workspace-history"),
  };
}

export type MiniLilacInitFileResult = {
  readonly path: string;
  readonly status: "written" | "skipped";
};

export async function initializeMiniLilacStateResult(
  paths: MiniLilacStatePaths = miniLilacStatePaths(),
  options: { readonly force?: boolean } = {},
): Promise<ResultType<readonly MiniLilacInitFileResult[], MiniLilacServerFailure>> {
  const directories = await captureServerOperation(
    "initialize Mini Lilac directories",
    async () => {
      await mkdir(paths.directory, { recursive: true, mode: 0o700 });
      await chmod(paths.directory, 0o700);
      await mkdir(paths.workspaceHistoryDirectory, { recursive: true, mode: 0o700 });
      await chmod(paths.workspaceHistoryDirectory, 0o700);
    },
  );
  let directoryFailure: MiniLilacServerFailure | undefined;
  directories.match({
    ok: () => {},
    err: (error) => void (directoryFailure = error),
  });
  if (directoryFailure !== undefined) return Result.err(directoryFailure);

  const files = [
    { path: paths.configFile, contents: runtimeConfigTemplate },
    { path: paths.providerConfigFile, contents: providerConfigTemplate },
    { path: paths.providerAuthFile, contents: authConfigTemplate },
  ];
  const results: MiniLilacInitFileResult[] = [];
  for (const file of files) {
    const written = await captureServerOperation("initialize Mini Lilac file", async () => {
      await writeFile(file.path, file.contents, {
        encoding: "utf8",
        mode: 0o600,
        flag: options.force ? "w" : "wx",
      });
      await chmod(file.path, 0o600);
    });
    const decision = written.match<MiniLilacInitFileResult | MiniLilacServerFailure>({
      ok: () => ({ path: file.path, status: "written" }),
      err: (error) =>
        !options.force && error.code === "EEXIST"
          ? { path: file.path, status: "skipped" }
          : serverFailureWithMessage(
              "initialize Mini Lilac file",
              `Failed to initialize '${file.path}': ${error.message}`,
              error,
            ),
    });
    if (decision instanceof MiniLilacServerFailure) return Result.err(decision);
    results.push(decision);
  }
  return Result.ok(results);
}

export async function initializeMiniLilacState(
  paths: MiniLilacStatePaths = miniLilacStatePaths(),
  options: { readonly force?: boolean } = {},
): Promise<readonly MiniLilacInitFileResult[]> {
  return adaptLifecycleResultToHost(await initializeMiniLilacStateResult(paths, options));
}

export function createMiniLilacAuthDependencies(
  paths: MiniLilacStatePaths = miniLilacStatePaths(),
): MiniLilacAuthDependencies {
  return {
    startLogin: () => startCodexOAuthLogin({ storagePath: paths.codexOAuthFile }),
    readTokens: () => readCodexTokens(paths.codexOAuthFile),
    clearTokens: () => clearCodexTokens(paths.codexOAuthFile),
    storagePath: () => paths.codexOAuthFile,
    log: console.log,
  };
}

export async function runAuthCommandResult(
  cli: z.infer<typeof authOptionsSchema>,
  dependencies: MiniLilacAuthDependencies = createMiniLilacAuthDependencies(),
): Promise<ResultType<void, MiniLilacLifecycleFailure>> {
  const storagePath = dependencies.storagePath();
  if (cli.action === "status") {
    return captureServerOperation("read Codex OAuth status", async () => {
      const tokens = await dependencies.readTokens();
      dependencies.log(tokens ? "Codex OAuth: configured" : "Codex OAuth: not configured");
      dependencies.log(`Storage: ${storagePath}`);
      if (tokens?.accountId) dependencies.log(`Account: ${tokens.accountId}`);
      if (tokens) dependencies.log(`Expires: ${new Date(tokens.expires).toISOString()}`);
    });
  }
  if (cli.action === "logout") {
    return captureServerOperation("clear Codex OAuth tokens", async () => {
      await dependencies.clearTokens();
      dependencies.log(`Codex OAuth cleared from ${storagePath}`);
    });
  }

  const started = await captureServerOperation("start Codex OAuth login", dependencies.startLogin);
  let login!: CodexOAuthLoginWithResult;
  let startFailure: MiniLilacServerFailure | undefined;
  started.match({
    ok: (value) => void (login = value),
    err: (error) => void (startFailure = error),
  });
  if (startFailure !== undefined) return Result.err(startFailure);
  const operation = await captureServerOperation("complete Codex OAuth login", async () => {
    dependencies.log(`Open this URL to authorize Codex:\n${login.authorizeUrl}`);
    dependencies.log(`Tokens will be stored at ${login.storagePath}`);
    dependencies.log(`Waiting for callback on ${login.redirectUri} ...`);
    const result = await login.result;
    dependencies.log(
      result.accountId
        ? `Codex OAuth configured for account ${result.accountId}`
        : "Codex OAuth configured",
    );
  });
  const cleanup = await captureServerCleanup("close Codex OAuth login", login.close);
  return operation.match<ResultType<void, MiniLilacLifecycleFailure>>({
    ok: () => cleanup,
    err: (operationError) =>
      cleanup.match<ResultType<void, MiniLilacLifecycleFailure>>({
        ok: () => Result.err(operationError),
        err: (cleanupError) =>
          Result.err(
            new MiniLilacServerOperationAndCleanupFailure({
              operationError,
              cleanupError,
              message: `${operationError.message}; cleanup also failed: ${cleanupError.message}`,
            }),
          ),
      }),
  });
}

export async function runAuthCommand(
  cli: z.infer<typeof authOptionsSchema>,
  dependencies: MiniLilacAuthDependencies = createMiniLilacAuthDependencies(),
): Promise<void> {
  adaptLifecycleResultToHost(await runAuthCommandResult(cli, dependencies));
}

export async function superviseMiniLilacSignalShutdown(
  shutdown: () => Promise<ResultType<void, MiniLilacLifecycleFailure>>,
  options: {
    readonly logError?: (message: string) => void;
    readonly markFailed?: () => void;
  } = {},
): Promise<void> {
  const settled = await settleLifecycleResult("supervise Mini Lilac signal shutdown", shutdown);
  const logError = options.logError ?? console.error;
  const markFailed = options.markFailed ?? (() => void (process.exitCode = 1));
  if (settled.kind === "panic") {
    logError(`Mini Lilac shutdown failed: ${settled.panic.message}`);
    markFailed();
    return;
  }
  let shutdownFailure: MiniLilacLifecycleFailure | undefined;
  settled.result.match({
    ok: () => {},
    err: (error) => void (shutdownFailure = error),
  });
  if (shutdownFailure !== undefined) {
    logError(`Mini Lilac shutdown failed: ${shutdownFailure.message}`);
    markFailed();
  }
}

async function runServeCommand(
  cli: z.infer<typeof serveOptionsSchema>,
  statePaths: MiniLilacStatePaths,
): Promise<ResultType<void, MiniLilacLifecycleFailure>> {
  const databasePath = path.resolve(cli.database ?? statePaths.databaseFile);
  const acquired = await acquireDatabaseLockResult(databasePath);
  let databaseLock!: MiniLilacDatabaseLock;
  let acquireFailure: MiniLilacServerFailure | undefined;
  acquired.match({
    ok: (lock) => void (databaseLock = lock),
    err: (error) => void (acquireFailure = error),
  });
  if (acquireFailure !== undefined) return Result.err(acquireFailure);
  let sessionService: SessionService | undefined;
  let stopListener: (() => Promise<void>) | undefined;

  const startup = await captureServerOperation("start Mini Lilac server", async () => {
    await mkdir(statePaths.directory, { recursive: true, mode: 0o700 });
    await mkdir(statePaths.workspaceHistoryDirectory, { recursive: true, mode: 0o700 });
    await chmod(statePaths.workspaceHistoryDirectory, 0o700);
    const config = await loadRuntimeConfig(cli.config ?? statePaths.configFile);
    const providers = await loadProviderRegistry(config, {
      readCodexTokens: () => readCodexTokens(statePaths.codexOAuthFile),
      createCodexOAuthProvider: () =>
        createCodexOAuthProvider({
          readTokens: () => readCodexTokens(statePaths.codexOAuthFile),
          writeTokens: (tokens) => writeCodexTokens(tokens, statePaths.codexOAuthFile),
        }),
    });
    const modelCatalog = new ModelCatalog(providers.config, providers.auth, {
      cacheFilePath: statePaths.modelsDevCacheFile,
      codexOAuthProviderIds: providers.supersededProviderIds,
      onWarning: (warning) => console.warn(`Model catalog warning: ${warning.message}`),
    });
    const initialModelCatalog = await modelCatalog.get();
    const toolResultArtifacts = createToolResultArtifactStore(statePaths.toolResultsDirectory);
    adaptToolResultArtifactStoreInitToHost(await toolResultArtifacts.init());

    const runtime = new SessionService({
      config,
      databasePath,
      providers,
      modelCapability: new ModelCapability({
        overrides: modelCapabilityOverrides(initialModelCatalog),
      }),
      modelLimitsResolver: async (specifier) => {
        const model = (await modelCatalog.get()).models.find(
          (entry) => entry.ref.value === specifier,
        );
        return model?.limits && model.limits.context > 0 ? model.limits : undefined;
      },
      skillCatalog: new MiniLilacSkillCatalog({
        dataDir: statePaths.directory,
        onWarning: (warning) =>
          console.warn(`Skill warning (${warning.location}): ${warning.message}`),
      }),
      protectedToolPaths: [
        statePaths.codexOAuthFile,
        statePaths.toolResultsDirectory,
        statePaths.workspaceHistoryDirectory,
      ],
      workspaceHistoryDirectory: statePaths.workspaceHistoryDirectory,
      toolResultArtifacts,
    });
    sessionService = runtime;
    await runtime.initialize();
    const authToken = config.server.authTokenEnv
      ? process.env[config.server.authTokenEnv]
      : undefined;
    const app = createMiniLilacServer({ config, sessionService: runtime, modelCatalog, authToken });

    app.listen({ hostname: config.server.host, port: config.server.port });
    stopListener = () => app.stop(true).then(() => undefined);
    console.log(`Mini Lilac listening on http://${config.server.host}:${config.server.port}`);

    const listActiveRuns = () =>
      runtime.store
        .listSessions()
        .filter(
          (session): session is typeof session & { activeRunId: string } =>
            (session.status === "streaming" || session.status === "cancelling") &&
            session.activeRunId !== null,
        )
        .map((session) => ({ sessionId: session.id, runId: session.activeRunId }));
    let shuttingDown = false;
    const shutdownResult = async (): Promise<ResultType<void, MiniLilacLifecycleFailure>> => {
      if (shuttingDown) return Result.ok(undefined);
      shuttingDown = true;
      return shutdownMiniLilacServerAndReleaseLockResult(
        {
          stopListener: (force) => app.stop(force).then(() => undefined),
          requestRuntimeShutdown: () => runtime.requestShutdown(),
          listActiveRuns,
          cancelRun: (run) =>
            runtime
              .cancel({
                ...run,
                clientCommandId: `shutdown-${crypto.randomUUID()}`,
              })
              .then(() => undefined),
          closeRuntime: () => runtime.shutdown({ graceMs: SHUTDOWN_GRACE_MS }),
        },
        databaseLock,
      );
    };

    const handleSignal = () => {
      void superviseMiniLilacSignalShutdown(shutdownResult);
    };
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
  });

  let startupFailure: MiniLilacServerFailure | undefined;
  startup.match({
    ok: () => {},
    err: (error) => void (startupFailure = error),
  });
  if (startupFailure === undefined) return Result.ok(undefined);

  let cleanupError: MiniLilacCleanupFailure | undefined;
  let cleanupPanic: Panic | undefined;
  const collectCleanup = (settled: SettledCleanupResult): void => {
    if (settled.kind === "panic") {
      cleanupPanic ??= settled.panic;
      return;
    }
    settled.result.match({
      ok: () => {},
      err: (error) => void (cleanupError = combineCleanupFailures(cleanupError, error)),
    });
  };
  if (stopListener !== undefined) {
    collectCleanup(await settleCleanupEffect("stop Mini Lilac listener", stopListener));
  }
  if (sessionService !== undefined) {
    const runtime = sessionService;
    const runtimeCleanup = await settleCleanupEffect("shutdown Mini Lilac runtime", () =>
      runtime.shutdown({ graceMs: SHUTDOWN_GRACE_MS }),
    );
    collectCleanup(runtimeCleanup);
    const closeRuntime =
      runtimeCleanup.kind === "panic" ||
      runtimeCleanup.result.match({ ok: () => false, err: () => true });
    if (closeRuntime) {
      collectCleanup(await settleCleanupEffect("close Mini Lilac runtime", () => runtime.close()));
    }
  }
  collectCleanup(
    await settleCleanupResult("release database lock", () => databaseLock.releaseResult()),
  );
  if (cleanupPanic !== undefined) rethrowPanic(cleanupPanic);
  if (cleanupError === undefined) return Result.err(startupFailure);
  return Result.err(combineLifecycleFailureWithCleanup(startupFailure, cleanupError));
}

export async function mainResult(
  args: readonly string[] = process.argv.slice(2),
  authDependencies?: MiniLilacAuthDependencies,
  options: { readonly statePaths?: MiniLilacStatePaths } = {},
): Promise<ResultType<void, MiniLilacLifecycleFailure>> {
  const parsed = parseCliArgsResult(args);
  let cli!: MiniLilacServerCliOptions;
  let parseFailure: MiniLilacServerFailure | undefined;
  parsed.match({
    ok: (value) => void (cli = value),
    err: (error) => void (parseFailure = error),
  });
  if (parseFailure !== undefined) return Result.err(parseFailure);
  const statePaths = options.statePaths ?? miniLilacStatePaths();
  if (cli.command === "help") {
    console.log(MINI_LILAC_SERVER_HELP);
    return Result.ok(undefined);
  }
  if (cli.command === "auth") {
    return runAuthCommandResult(
      cli,
      authDependencies ?? createMiniLilacAuthDependencies(statePaths),
    );
  }
  if (cli.command === "init") {
    const initialized = await initializeMiniLilacStateResult(statePaths, { force: cli.force });
    let initResults: readonly MiniLilacInitFileResult[] = [];
    let initFailure: MiniLilacServerFailure | undefined;
    initialized.match({
      ok: (results) => void (initResults = results),
      err: (error) => void (initFailure = error),
    });
    if (initFailure !== undefined) return Result.err(initFailure);
    for (const result of initResults) {
      console.log(
        result.status === "written"
          ? `Wrote ${result.path}`
          : `Skipped ${result.path} (already exists)`,
      );
    }
    return Result.ok(undefined);
  }
  if (cli.command === "history-recovery") {
    const recovered = await runHistoryRecoveryCommandResult(cli, {
      defaultDatabasePath: statePaths.databaseFile,
    });
    return recovered.map(() => undefined);
  }
  return runServeCommand(cli, statePaths);
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  authDependencies?: MiniLilacAuthDependencies,
  options: { readonly statePaths?: MiniLilacStatePaths } = {},
): Promise<void> {
  adaptLifecycleResultToHost(await mainResult(args, authDependencies, options));
}

if (import.meta.main) {
  await main();
}
