import { chmod, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  loadProviderRegistry,
  loadRuntimeConfig,
  ModelCatalog,
  MiniLilacSkillCatalog,
  MiniLilacSqliteStore,
  readMiniLilacHistoryRecoveryStatus,
  SessionService,
  type PendingStoredRunFinalization,
  type StoredHistoryOperation,
} from "@stanley2058/mini-lilac-runtime";
import { createToolResultArtifactStore } from "@stanley2058/lilac-tool-results";
import {
  clearCodexTokens,
  createCodexOAuthProvider,
  readCodexTokens,
  startCodexOAuthLogin,
  writeCodexTokens,
  type CodexOAuthLogin,
} from "@stanley2058/lilac-utils";
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
  release(): Promise<void>;
};

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

export function databaseLockPath(databasePath: string): string {
  return `${path.resolve(databasePath)}.mini-lilac.lock`;
}

export async function acquireDatabaseLock(databasePath: string): Promise<MiniLilacDatabaseLock> {
  const resolvedDatabasePath = path.resolve(databasePath);
  const lockPath = databaseLockPath(resolvedDatabasePath);
  await mkdir(path.dirname(resolvedDatabasePath), { recursive: true, mode: 0o700 });

  let holder;
  try {
    holder = Bun.spawn(
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
  } catch (error) {
    throw new MiniLilacDatabaseLockError(
      `Failed to start database lock holder for '${lockPath}'; ensure 'flock' is installed`,
      lockPath,
      { cause: error },
    );
  }

  const reader = holder.stdout.getReader();
  let readyByte: number | undefined;
  let handshakeError: unknown;
  try {
    holder.stdin.write(new Uint8Array([FLOCK_READY_BYTE]));
    await holder.stdin.flush();
    readyByte = (await reader.read()).value?.[0];
  } catch (error) {
    handshakeError = error;
  } finally {
    reader.releaseLock();
  }

  if (readyByte !== FLOCK_READY_BYTE) {
    holder.stdin.end();
    const [exitCode, stderr] = await Promise.all([
      holder.exited,
      new Response(holder.stderr).text(),
    ]);
    if (exitCode === FLOCK_CONTENTION_EXIT_CODE) {
      throw new MiniLilacDatabaseLockError(
        `Mini Lilac is already using database '${resolvedDatabasePath}'`,
        lockPath,
      );
    }
    const detail = stderr.trim();
    throw new MiniLilacDatabaseLockError(
      `Failed to acquire database lock '${lockPath}' (flock exited with code ${exitCode})${
        detail ? `: ${detail}` : ""
      }`,
      lockPath,
      handshakeError === undefined ? undefined : { cause: handshakeError },
    );
  }

  let releasePromise: Promise<void> | undefined;
  return {
    lockPath,
    release() {
      releasePromise ??= (async () => {
        holder.stdin.end();
        const exitCode = await holder.exited;
        if (exitCode !== 0) {
          throw new MiniLilacDatabaseLockError(
            `Failed to release database lock '${lockPath}' (flock exited with code ${exitCode})`,
            lockPath,
          );
        }
      })();
      return releasePromise;
    },
  };
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

export async function shutdownMiniLilacServer(options: MiniLilacShutdownOptions): Promise<void> {
  try {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? Bun.sleep;
    const graceMs = options.graceMs ?? SHUTDOWN_GRACE_MS;
    const pollIntervalMs = options.pollIntervalMs ?? SHUTDOWN_POLL_INTERVAL_MS;
    const deadline = now() + graceMs;
    let listenerSettled = false;
    let listenerFailed = false;
    let stopResult: void | Promise<void> = undefined;
    try {
      stopResult = options.stopListener(false);
    } catch {
      listenerSettled = true;
      listenerFailed = true;
    }
    const gracefulStop = Promise.resolve(stopResult).then(
      () => void (listenerSettled = true),
      () => {
        listenerSettled = true;
        listenerFailed = true;
      },
    );

    // Admit explicit run cancellations before the runtime shutdown request closes
    // admission. Actor shutdown also cancels them, but these requests preserve the
    // server's normal run lifecycle and must not throw out of cleanup synchronously.
    const runCancellationRequests = options.listActiveRuns().map((run) => {
      try {
        return options.cancelRun(run);
      } catch (error) {
        return Promise.reject(error);
      }
    });
    let runtimeShutdownRequest: void | Promise<void>;
    try {
      runtimeShutdownRequest = options.requestRuntimeShutdown?.();
    } catch (error) {
      runtimeShutdownRequest = Promise.reject(error);
    }
    let cancellationsSettled = false;
    const cancellations = Promise.allSettled([
      Promise.resolve(runtimeShutdownRequest),
      ...runCancellationRequests,
    ]).then(() => void (cancellationsSettled = true));

    while (
      (!listenerSettled || !cancellationsSettled || options.listActiveRuns().length > 0) &&
      now() < deadline
    ) {
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
    }

    const force =
      listenerFailed ||
      !listenerSettled ||
      !cancellationsSettled ||
      options.listActiveRuns().length > 0;
    if (force) {
      await options.stopListener(true);
    } else {
      await Promise.all([gracefulStop, cancellations]);
    }
  } finally {
    await options.closeRuntime();
  }
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

export function parseCliArgs(args: readonly string[]): MiniLilacServerCliOptions {
  if (args.includes("--help")) return helpOptionsSchema.parse({ command: "help" });
  if (args[0] === "auth") {
    const provider = args[1];
    const parsed = parseArgs({
      args: args.slice(2),
      options: {
        status: { type: "boolean", default: false },
        logout: { type: "boolean", default: false },
      },
      allowPositionals: false,
      strict: true,
    });
    if (parsed.values.status && parsed.values.logout) {
      throw new Error("Choose only one of --status or --logout");
    }
    return authOptionsSchema.parse({
      command: "auth",
      provider,
      action: parsed.values.status ? "status" : parsed.values.logout ? "logout" : "login",
    });
  }
  if (args[0] === "init") {
    const parsed = parseArgs({
      args: args.slice(1),
      options: { force: { type: "boolean", default: false } },
      allowPositionals: false,
      strict: true,
    });
    return initOptionsSchema.parse({ command: "init", force: parsed.values.force });
  }
  if (args[0] === "history-recovery") {
    const action = args[1];
    const parsed = parseArgs({
      args: args.slice(2),
      options: {
        workspace: { type: "string" },
        database: { type: "string" },
        "acknowledge-partial-worktree": { type: "boolean", default: false },
      },
      allowPositionals: false,
      strict: true,
    });
    if (action === "status" && parsed.values["acknowledge-partial-worktree"]) {
      throw new Error("--acknowledge-partial-worktree is valid only with abandon");
    }
    if (action === "abandon" && !parsed.values["acknowledge-partial-worktree"]) {
      throw new Error("history-recovery abandon requires --acknowledge-partial-worktree");
    }
    return historyRecoveryOptionsSchema.parse({
      command: "history-recovery",
      action,
      workspace: parsed.values.workspace,
      database: parsed.values.database,
      acknowledgePartialWorktree: parsed.values["acknowledge-partial-worktree"],
    });
  }

  const parsed = parseArgs({
    args: [...args],
    options: {
      config: { type: "string" },
      database: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });
  return serveOptionsSchema.parse({ command: "serve", ...parsed.values });
}

export type MiniLilacAuthDependencies = {
  startLogin: () => Promise<CodexOAuthLogin>;
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

async function canonicalWorkspace(workspace: string): Promise<string> {
  try {
    const canonical = await realpath(workspace);
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error(`Workspace '${workspace}' is not a directory`);
    }
    return canonical;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return path.resolve(workspace);
    }
    throw error;
  }
}

function recoveryWorkspace(
  store: MiniLilacSqliteStore,
  entry: StoredHistoryOperation | PendingStoredRunFinalization,
): string {
  return store.getWorkspaceForSession(entry.sessionId).canonicalCwd;
}

export async function runHistoryRecoveryCommand(
  cli: z.infer<typeof historyRecoveryOptionsSchema>,
  options: {
    readonly defaultDatabasePath: string;
    readonly log?: (message: string) => void;
  },
): Promise<MiniLilacHistoryRecoveryCommandResult> {
  const databasePath = path.resolve(cli.database ?? options.defaultDatabasePath);
  const log = options.log ?? console.log;
  const lock = await acquireDatabaseLock(databasePath);
  let store: MiniLilacSqliteStore | undefined;
  try {
    const workspace =
      cli.workspace === undefined ? undefined : await canonicalWorkspace(cli.workspace);
    const databaseExists = await stat(databasePath)
      .then((entry) => entry.isFile())
      .catch(() => false);
    if (!databaseExists) {
      if (cli.action === "abandon") {
        throw new Error(`No retained history navigation exists for workspace '${workspace}'`);
      }
      const report = { navigation: [], pendingFinalizations: [] };
      log(JSON.stringify(report, null, 2));
      return { action: "status", report };
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
      return { action: "status", report };
    }

    const openedStore = new MiniLilacSqliteStore(databasePath);
    store = openedStore;
    const navigation = openedStore.listHistoryOperations().filter((entry) => {
      return workspace === undefined || recoveryWorkspace(openedStore, entry) === workspace;
    });

    if (navigation.length === 0) {
      throw new Error(`No retained history navigation exists for workspace '${workspace}'`);
    }
    if (navigation.length !== 1) {
      throw new Error(
        `Workspace '${workspace}' has ${navigation.length} retained history navigation operations`,
      );
    }
    if (workspace === undefined) {
      throw new Error("history-recovery abandon requires an exact workspace");
    }
    const operation = navigation[0]!;
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
    return result;
  } finally {
    store?.close();
    await lock.release();
  }
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

export async function initializeMiniLilacState(
  paths: MiniLilacStatePaths = miniLilacStatePaths(),
  options: { readonly force?: boolean } = {},
): Promise<readonly MiniLilacInitFileResult[]> {
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  await mkdir(paths.workspaceHistoryDirectory, { recursive: true, mode: 0o700 });
  await chmod(paths.workspaceHistoryDirectory, 0o700);

  const files = [
    { path: paths.configFile, contents: runtimeConfigTemplate },
    { path: paths.providerConfigFile, contents: providerConfigTemplate },
    { path: paths.providerAuthFile, contents: authConfigTemplate },
  ];
  const results: MiniLilacInitFileResult[] = [];
  for (const file of files) {
    try {
      await writeFile(file.path, file.contents, {
        encoding: "utf8",
        mode: 0o600,
        flag: options.force ? "w" : "wx",
      });
      await chmod(file.path, 0o600);
      results.push({ path: file.path, status: "written" });
    } catch (error) {
      if (!options.force && error instanceof Error && "code" in error && error.code === "EEXIST") {
        results.push({ path: file.path, status: "skipped" });
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to initialize '${file.path}': ${message}`, { cause: error });
    }
  }
  return results;
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

export async function runAuthCommand(
  cli: z.infer<typeof authOptionsSchema>,
  dependencies: MiniLilacAuthDependencies = createMiniLilacAuthDependencies(),
): Promise<void> {
  const storagePath = dependencies.storagePath();
  if (cli.action === "status") {
    const tokens = await dependencies.readTokens();
    dependencies.log(tokens ? "Codex OAuth: configured" : "Codex OAuth: not configured");
    dependencies.log(`Storage: ${storagePath}`);
    if (tokens?.accountId) dependencies.log(`Account: ${tokens.accountId}`);
    if (tokens) dependencies.log(`Expires: ${new Date(tokens.expires).toISOString()}`);
    return;
  }
  if (cli.action === "logout") {
    await dependencies.clearTokens();
    dependencies.log(`Codex OAuth cleared from ${storagePath}`);
    return;
  }

  const login = await dependencies.startLogin();
  dependencies.log(`Open this URL to authorize Codex:\n${login.authorizeUrl}`);
  dependencies.log(`Tokens will be stored at ${login.storagePath}`);
  dependencies.log(`Waiting for callback on ${login.redirectUri} ...`);
  try {
    const result = await login.result;
    dependencies.log(
      result.accountId
        ? `Codex OAuth configured for account ${result.accountId}`
        : "Codex OAuth configured",
    );
  } finally {
    await login.close();
  }
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  authDependencies?: MiniLilacAuthDependencies,
  options: { readonly statePaths?: MiniLilacStatePaths } = {},
): Promise<void> {
  const cli = parseCliArgs(args);
  const statePaths = options.statePaths ?? miniLilacStatePaths();
  if (cli.command === "help") {
    console.log(MINI_LILAC_SERVER_HELP);
    return;
  }
  if (cli.command === "auth") {
    await runAuthCommand(cli, authDependencies ?? createMiniLilacAuthDependencies(statePaths));
    return;
  }
  if (cli.command === "init") {
    const results = await initializeMiniLilacState(statePaths, { force: cli.force });
    for (const result of results) {
      console.log(
        result.status === "written"
          ? `Wrote ${result.path}`
          : `Skipped ${result.path} (already exists)`,
      );
    }
    return;
  }
  if (cli.command === "history-recovery") {
    await runHistoryRecoveryCommand(cli, { defaultDatabasePath: statePaths.databaseFile });
    return;
  }
  const databasePath = path.resolve(cli.database ?? statePaths.databaseFile);
  const databaseLock = await acquireDatabaseLock(databasePath);
  let sessionService: SessionService | undefined;
  let stopListener: (() => Promise<void>) | undefined;

  try {
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
    await modelCatalog.get({ backgroundRefresh: true });
    const toolResultArtifacts = createToolResultArtifactStore(statePaths.toolResultsDirectory);
    await toolResultArtifacts.init();

    const runtime = new SessionService({
      config,
      databasePath,
      providers,
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
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        await shutdownMiniLilacServer({
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
        });
      } finally {
        await databaseLock.release();
      }
    };

    const handleSignal = () => {
      void shutdown().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Mini Lilac shutdown failed: ${message}`);
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
  } catch (error) {
    try {
      await stopListener?.();
    } finally {
      try {
        if (sessionService !== undefined) {
          try {
            await sessionService.shutdown({ graceMs: SHUTDOWN_GRACE_MS });
          } catch {
            sessionService.close();
          }
        }
      } finally {
        await databaseLock.release();
      }
    }
    throw error;
  }
}

if (import.meta.main) {
  await main();
}
