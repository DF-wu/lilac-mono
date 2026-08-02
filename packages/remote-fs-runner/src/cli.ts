import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  decodeRemoteFsDaemonRequestJson,
  decodeRemoteFsRequestJson,
  decodeRemoteRunnerResponseJson,
  FileSystem,
  remoteEditResponseSchema,
  remoteFuzzySearchResponseSchema,
  remoteGlobResponseSchema,
  remoteGrepResponseSchema,
  remoteHealthResponseSchema,
  remoteReadBytesResponseSchema,
  remoteReadTextResponseSchema,
  type RemoteEditResponse,
  type RemoteFsDaemonRequest,
  type RemoteFuzzySearchResponse,
  type RemoteGlobResponse,
  type RemoteGrepResponse,
  type RemoteHealthResponse,
  type RemoteReadBytesResponse,
  type RemoteReadTextResponse,
  type RemoteRunnerRequestDecodeError,
  type RemoteRunnerResponseDecodeError,
} from "@stanley2058/lilac-fs";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

declare const PACKAGE_VERSION: string;

const RUNNER_PACKAGE_VERSION = typeof PACKAGE_VERSION === "string" ? PACKAGE_VERSION : "dev";
const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const STARTUP_TIMEOUT_MS = 15_000;
const CONNECT_RETRY_MS = 100;
const SOCKET_RESPONSE_TIMEOUT_MS = 15_000;

type RemoteFsResponse =
  | RemoteReadTextResponse
  | RemoteReadBytesResponse
  | RemoteGlobResponse
  | RemoteGrepResponse
  | RemoteFuzzySearchResponse
  | RemoteEditResponse
  | RemoteHealthResponse;
type ResponseEnvelope = { ok: true; value: RemoteFsResponse } | { ok: false; error: string };
type ReadTextRequest = Extract<RemoteFsDaemonRequest, { op: "fs.read_text" }>;
type ReadBytesRequest = Extract<RemoteFsDaemonRequest, { op: "fs.read_bytes" }>;
type GlobRequest = Extract<RemoteFsDaemonRequest, { op: "fs.glob" }>;
type GrepRequest = Extract<RemoteFsDaemonRequest, { op: "fs.grep" }>;
type FuzzySearchRequest = Extract<RemoteFsDaemonRequest, { op: "fs.fuzzy_search" }>;
type EditRequest = Extract<RemoteFsDaemonRequest, { op: "fs.edit" }>;
type HealthRequest = Extract<RemoteFsDaemonRequest, { op: "health" }>;

export class RemoteFsSocketTransportError extends TaggedError("RemoteFsSocketTransportError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

class RemoteFsStdinReadError extends TaggedError("RemoteFsStdinReadError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class RemoteFsDaemonSpawnError extends TaggedError("RemoteFsDaemonSpawnError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class RemoteFsRuntimeSetupError extends TaggedError("RemoteFsRuntimeSetupError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class RemoteFsDaemonStartupError extends TaggedError("RemoteFsDaemonStartupError")<{
  readonly message: string;
}> {}

export class RemoteFsStartupLockCleanupError extends TaggedError(
  "RemoteFsStartupLockCleanupError",
)<{
  readonly lockPath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

type RemoteFsRequestOperationError =
  | RemoteFsStdinReadError
  | RemoteRunnerRequestDecodeError
  | RemoteFsRuntimeSetupError
  | RemoteFsSocketTransportError
  | RemoteRunnerResponseDecodeError
  | RemoteFsDaemonSpawnError
  | RemoteFsDaemonStartupError;

export class RemoteFsRequestCleanupCombinedError extends TaggedError(
  "RemoteFsRequestCleanupCombinedError",
)<{
  readonly operationError: RemoteFsRequestOperationError;
  readonly cleanupError: RemoteFsStartupLockCleanupError;
  readonly message: string;
}> {}

type RemoteFsRunRequestError =
  | RemoteFsRequestOperationError
  | RemoteFsStartupLockCleanupError
  | RemoteFsRequestCleanupCombinedError;

function getErrorCode(error: Error): string | undefined {
  if (!("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function preservePanic(error: unknown): void {
  let panic = false;
  try {
    panic = Panic.is(error);
  } catch {
    return;
  }
  if (panic) throw error;
}

function opaqueErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Opaque remote fs runner failure";
  }
}

function opaqueErrorCause(error: unknown): unknown {
  try {
    if (error instanceof Error) return error;
  } catch {
    return new Error("Opaque remote fs runner failure");
  }
  return error;
}

async function captureRuntimeOperation<T>(
  message: string,
  operation: () => Promise<T>,
): Promise<ResultType<T, RemoteFsRuntimeSetupError>> {
  try {
    return Result.ok(await operation());
  } catch (caught) {
    preservePanic(caught);
    const cause = opaqueErrorCause(caught);
    return Result.err(new RemoteFsRuntimeSetupError({ cause, message }));
  }
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function runtimeBaseDir(): string {
  const fromEnv = process.env.LILAC_REMOTE_FS_RUNNER_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv);

  const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(cacheHome, "lilac", "remote-fs-runner", RUNNER_PACKAGE_VERSION);
}

function socketPath(baseDir = runtimeBaseDir()): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\lilac-remote-fs-${RUNNER_PACKAGE_VERSION.replace(/[^a-zA-Z0-9]/g, "-")}`;
  }
  return path.join(baseDir, "daemon.sock");
}

function lockPath(baseDir = runtimeBaseDir()): string {
  return path.join(baseDir, "startup.lock");
}

function fffCacheDir(baseDir = runtimeBaseDir()): string {
  return path.join(baseDir, "fff-cache");
}

export async function ensureRuntimeDir(
  baseDir = runtimeBaseDir(),
): Promise<ResultType<void, RemoteFsRuntimeSetupError>> {
  return captureRuntimeOperation(
    `failed to prepare remote fs runtime directory: ${baseDir}`,
    async () => {
      await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") await fs.chmod(baseDir, 0o700);
    },
  );
}

async function readStdinText(): Promise<ResultType<string, RemoteFsStdinReadError>> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Result.ok(Buffer.concat(chunks).toString("utf8"));
  } catch (caught) {
    preservePanic(caught);
    const cause = opaqueErrorCause(caught);
    return Result.err(
      new RemoteFsStdinReadError({ cause, message: "failed to read remote fs CLI stdin" }),
    );
  }
}

function writeJson(value: ResponseEnvelope): void {
  process.stdout.write(JSON.stringify(value));
}

function writeLine(value: string): void {
  process.stdout.write(`${value}\n`);
}

function responseError(error: { readonly message: string }): ResponseEnvelope {
  return { ok: false, error: error.message };
}

function responseSuccess(value: RemoteFsResponse): ResponseEnvelope {
  return { ok: true, value };
}

type EditResult =
  | Awaited<ReturnType<FileSystem["editFile"]>>
  | Awaited<ReturnType<FileSystem["hashlineEditFile"]>>;

function normalizeEditOutput(result: EditResult): RemoteEditResponse {
  if (result.success) {
    return {
      success: true,
      resolvedPath: result.resolvedPath,
      oldHash: result.oldHash,
      newHash: result.newHash,
      changesMade: result.changesMade,
      replacementsMade: result.replacementsMade,
    };
  }

  return {
    success: false,
    resolvedPath: result.resolvedPath,
    currentHash: result.currentHash,
    error: result.error,
  };
}

export function handleRequest(envelope: ReadTextRequest): Promise<RemoteReadTextResponse>;
export function handleRequest(envelope: ReadBytesRequest): Promise<RemoteReadBytesResponse>;
export function handleRequest(envelope: GlobRequest): Promise<RemoteGlobResponse>;
export function handleRequest(envelope: GrepRequest): Promise<RemoteGrepResponse>;
export function handleRequest(envelope: FuzzySearchRequest): Promise<RemoteFuzzySearchResponse>;
export function handleRequest(envelope: EditRequest): Promise<RemoteEditResponse>;
export function handleRequest(envelope: HealthRequest): Promise<RemoteHealthResponse>;
export function handleRequest(envelope: RemoteFsDaemonRequest): Promise<RemoteFsResponse>;
export async function handleRequest(envelope: RemoteFsDaemonRequest): Promise<RemoteFsResponse> {
  const fsTool = new FileSystem(envelope.cwd, {
    denyPaths: envelope.denyPaths,
    fsBackend: "fff",
    fffCacheDir: fffCacheDir(),
  });

  switch (envelope.op) {
    case "fs.read_text":
      return await fsTool.readFile({
        path: envelope.input.path,
        start: envelope.input.start,
        maxLines: envelope.input.maxLines,
        maxCharacters: envelope.input.maxCharacters,
        maxBytes: envelope.input.maxBytes,
        format: envelope.input.format ?? "raw",
      });
    case "fs.read_bytes": {
      const result = await fsTool.readFileBytes({
        path: envelope.input.path,
        maxBytes: envelope.input.maxBytes,
      });
      if (!result.success) {
        return {
          ok: false,
          resolvedPath: result.resolvedPath,
          error: result.error.message,
        };
      }
      return {
        ok: true,
        resolvedPath: result.resolvedPath,
        fileHash: result.fileHash,
        bytesLength: result.bytesLength,
        base64: Buffer.from(result.bytes).toString("base64"),
      };
    }
    case "fs.glob":
      return await fsTool.glob({
        patterns: envelope.input.patterns,
        maxEntries: envelope.input.maxEntries,
        mode: envelope.input.mode ?? "default",
      });
    case "fs.grep":
      return await fsTool.grep({
        pattern: envelope.input.pattern,
        baseDir: envelope.input.baseDir,
        reportedFilePath: envelope.input.reportedFilePath,
        regex: envelope.input.regex,
        maxResults: envelope.input.maxResults,
        fileExtensions: envelope.input.fileExtensions?.map((ext) => ext.replace(/^\./, "")),
        includeContextLines: envelope.input.includeContextLines,
        mode: envelope.input.mode ?? "default",
      });
    case "fs.fuzzy_search":
      return await fsTool.fuzzySearchFiles({
        query: envelope.input.query,
        maxResults: envelope.input.maxResults,
      });
    case "fs.edit": {
      const expectedHash =
        envelope.input.expectedHash && envelope.input.expectedHash.length > 0
          ? envelope.input.expectedHash
          : undefined;
      if (envelope.input.mode === "hashline") {
        return normalizeEditOutput(
          await fsTool.hashlineEditFile({
            path: envelope.input.path,
            edits: envelope.input.edits,
            expectedHash,
          }),
        );
      }
      return normalizeEditOutput(
        await fsTool.editFile({
          path: envelope.input.path,
          edits: envelope.input.edits,
          expectedHash,
        }),
      );
    }
    case "health":
      return { pid: process.pid };
  }
}

function readSocketResponse(
  payload: RemoteFsDaemonRequest,
  timeoutMs: number,
): Promise<ResultType<string, RemoteFsSocketTransportError>> {
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath());
    let response = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settleError(new Error(`remote fs daemon socket response timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();

    const settle = (result: ResultType<string, RemoteFsSocketTransportError>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const settleError = (cause: Error) => {
      if (settled) return;
      client.destroy();
      settle(
        Result.err(
          new RemoteFsSocketTransportError({
            cause,
            message: "remote fs daemon socket transport failed",
          }),
        ),
      );
    };

    client.setEncoding("utf8");
    client.on("connect", () => {
      client.end(JSON.stringify(payload));
    });
    client.on("data", (chunk) => {
      response += chunk;
    });
    client.on("error", settleError);
    client.on("end", () => {
      if (settled) return;
      settle(Result.ok(response));
    });
  });
}

function decodeSocketResponse(
  request: RemoteFsDaemonRequest,
  text: string,
): ResultType<RemoteFsResponse, RemoteRunnerResponseDecodeError> {
  switch (request.op) {
    case "fs.read_text":
      return decodeRemoteRunnerResponseJson(request.op, text, remoteReadTextResponseSchema);
    case "fs.read_bytes":
      return decodeRemoteRunnerResponseJson(request.op, text, remoteReadBytesResponseSchema);
    case "fs.glob":
      return decodeRemoteRunnerResponseJson(request.op, text, remoteGlobResponseSchema);
    case "fs.grep":
      return decodeRemoteRunnerResponseJson(request.op, text, remoteGrepResponseSchema);
    case "fs.fuzzy_search":
      return decodeRemoteRunnerResponseJson(request.op, text, remoteFuzzySearchResponseSchema);
    case "fs.edit":
      return decodeRemoteRunnerResponseJson(request.op, text, remoteEditResponseSchema);
    case "health":
      return decodeRemoteRunnerResponseJson(request.op, text, remoteHealthResponseSchema);
  }
}

export async function connectOnce(
  payload: RemoteFsDaemonRequest,
  timeoutMs = SOCKET_RESPONSE_TIMEOUT_MS,
): Promise<
  ResultType<RemoteFsResponse, RemoteFsSocketTransportError | RemoteRunnerResponseDecodeError>
> {
  const response = await readSocketResponse(payload, timeoutMs);
  if (response.status === "error") return response;
  return decodeSocketResponse(payload, response.value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function spawnDaemon(
  executable = process.execPath,
  launchDaemon: () => ReturnType<typeof spawn> = () =>
    spawn(executable, [process.argv[1] ?? "", "daemon"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    }),
): Promise<ResultType<void, RemoteFsDaemonSpawnError>> {
  let child;
  try {
    child = launchDaemon();
  } catch (caught) {
    preservePanic(caught);
    const cause = opaqueErrorCause(caught);
    return Result.err(
      new RemoteFsDaemonSpawnError({
        cause,
        message: "failed to spawn remote fs daemon",
      }),
    );
  }

  return await new Promise((resolve) => {
    let settled = false;
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve(Result.ok(undefined));
    });
    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      resolve(
        Result.err(
          new RemoteFsDaemonSpawnError({
            cause,
            message: "failed to spawn remote fs daemon",
          }),
        ),
      );
    });
  });
}

async function tryConnectUntil(
  deadline: number,
  payload: RemoteFsDaemonRequest,
): Promise<
  ResultType<RemoteFsResponse, RemoteFsSocketTransportError | RemoteRunnerResponseDecodeError>
> {
  let latestError: RemoteFsSocketTransportError | RemoteRunnerResponseDecodeError =
    new RemoteFsSocketTransportError({
      cause: undefined,
      message: "remote fs daemon socket was unavailable",
    });
  while (Date.now() < deadline) {
    const response = await connectOnce(payload, Math.max(1, deadline - Date.now()));
    if (response.status === "ok") return response;
    if (!RemoteFsSocketTransportError.is(response.error)) return response;
    latestError = response.error;
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) await sleep(Math.min(CONNECT_RETRY_MS, remainingMs));
  }
  return Result.err(latestError);
}

export async function tryAcquireStartupLock(
  createLock: (target: string) => Promise<void> = async (target) => {
    await fs.mkdir(target);
  },
): Promise<ResultType<boolean, RemoteFsRuntimeSetupError>> {
  const target = lockPath();
  const created = await captureRuntimeOperation(
    `failed to create remote fs startup lock: ${target}`,
    () => createLock(target),
  );
  if (created.status === "ok") return Result.ok(true);
  if (!(created.error.cause instanceof Error) || getErrorCode(created.error.cause) !== "EEXIST") {
    return Result.err(created.error);
  }

  const statResult = await captureRuntimeOperation(
    `failed to inspect remote fs startup lock: ${target}`,
    () => fs.stat(target),
  );
  if (statResult.status === "error") {
    if (
      statResult.error.cause instanceof Error &&
      getErrorCode(statResult.error.cause) === "ENOENT"
    ) {
      return Result.ok(false);
    }
    return Result.err(statResult.error);
  }

  const lockAgeMs = Date.now() - statResult.value.mtimeMs;
  if (lockAgeMs <= STARTUP_TIMEOUT_MS) return Result.ok(false);

  const removed = await captureRuntimeOperation(
    `failed to remove stale remote fs startup lock: ${target}`,
    () => fs.rm(target, { recursive: true, force: true }),
  );
  if (removed.status === "error") return Result.err(removed.error);

  const recreated = await captureRuntimeOperation(
    `failed to recreate remote fs startup lock: ${target}`,
    () => createLock(target),
  );
  if (recreated.status === "ok") return Result.ok(true);
  if (recreated.error.cause instanceof Error && getErrorCode(recreated.error.cause) === "EEXIST") {
    return Result.ok(false);
  }
  return Result.err(recreated.error);
}

export async function releaseStartupLock(
  removeLock: (target: string) => Promise<void> = async (target) => {
    await fs.rm(target, { recursive: true, force: true });
  },
): Promise<ResultType<void, RemoteFsStartupLockCleanupError>> {
  const target = lockPath();
  try {
    await removeLock(target);
    return Result.ok(undefined);
  } catch (caught) {
    preservePanic(caught);
    const cause = opaqueErrorCause(caught);
    return Result.err(
      new RemoteFsStartupLockCleanupError({
        lockPath: target,
        cause,
        message: `failed to release remote fs startup lock: ${target}`,
      }),
    );
  }
}

export function applyStartupLockCleanup(
  operation: ResultType<ResponseEnvelope, RemoteFsRequestOperationError>,
  cleanup: ResultType<void, RemoteFsStartupLockCleanupError>,
): ResultType<ResponseEnvelope, RemoteFsRunRequestError> {
  if (cleanup.status === "ok") return operation;
  if (operation.status === "ok") return Result.err(cleanup.error);
  return Result.err(
    new RemoteFsRequestCleanupCombinedError({
      operationError: operation.error,
      cleanupError: cleanup.error,
      message: `${operation.error.message}; additionally, ${cleanup.error.message}`,
    }),
  );
}

type StartupLockOperationOutcome =
  | {
      readonly kind: "result";
      readonly result: ResultType<ResponseEnvelope, RemoteFsRequestOperationError>;
    }
  | { readonly kind: "rejection"; readonly cause: unknown };

async function captureStartupLockOperation(
  operation: () => Promise<ResultType<ResponseEnvelope, RemoteFsRequestOperationError>>,
): Promise<StartupLockOperationOutcome> {
  try {
    return { kind: "result", result: await operation() };
  } catch (cause) {
    return { kind: "rejection", cause };
  }
}

type CleanupFailureReporter = (failure: { readonly message: string }) => void;

function reportCleanupFailureWithoutMaskingOperation(
  report: CleanupFailureReporter,
  failure: { readonly message: string },
): void {
  try {
    report(failure);
  } catch {
    // The original operation defect retains precedence over secondary reporting failure.
  }
}

function reportStartupLockCleanupAfterOperationDefect(failure: { readonly message: string }): void {
  process.stderr.write(
    `remote fs startup-lock cleanup after operation defect: ${failure.message}\n`,
  );
}

async function superviseStartupLockCleanupAfterOperationDefect(
  cleanup: () => Promise<ResultType<void, RemoteFsStartupLockCleanupError>>,
  report: CleanupFailureReporter,
): Promise<void> {
  try {
    const cleanupResult = await cleanup();
    if (cleanupResult.status === "error") {
      reportCleanupFailureWithoutMaskingOperation(report, cleanupResult.error);
    }
  } catch (cause) {
    const failure =
      cause instanceof Error ? cause : new Error("unknown startup-lock cleanup defect");
    reportCleanupFailureWithoutMaskingOperation(report, failure);
  }
}

export async function runWithStartupLockCleanup(
  operation: () => Promise<ResultType<ResponseEnvelope, RemoteFsRequestOperationError>>,
  cleanup: () => Promise<ResultType<void, RemoteFsStartupLockCleanupError>> = releaseStartupLock,
  report: CleanupFailureReporter = reportStartupLockCleanupAfterOperationDefect,
): Promise<ResultType<ResponseEnvelope, RemoteFsRunRequestError>> {
  const outcome = await captureStartupLockOperation(operation);
  let cleanupResult: ResultType<void, RemoteFsStartupLockCleanupError> = Result.ok(undefined);

  try {
    if (outcome.kind === "rejection") throw outcome.cause;
  } finally {
    if (outcome.kind === "rejection") {
      await superviseStartupLockCleanupAfterOperationDefect(cleanup, report);
    } else {
      cleanupResult = await cleanup();
    }
  }

  return applyStartupLockCleanup(outcome.result, cleanupResult);
}

async function waitForDaemon(
  payload: RemoteFsDaemonRequest,
): Promise<
  ResultType<
    ResponseEnvelope,
    RemoteFsSocketTransportError | RemoteRunnerResponseDecodeError | RemoteFsDaemonStartupError
  >
> {
  const response = await tryConnectUntil(Date.now() + STARTUP_TIMEOUT_MS, payload);
  if (response.status === "ok") return Result.ok(responseSuccess(response.value));
  if (!RemoteFsSocketTransportError.is(response.error)) return Result.err(response.error);
  return Result.err(new RemoteFsDaemonStartupError({ message: "remote fs daemon did not start" }));
}

export async function runRequest(): Promise<ResultType<ResponseEnvelope, RemoteFsRunRequestError>> {
  const stdin = await readStdinText();
  if (stdin.status === "error") return Result.err(stdin.error);
  const request = decodeRemoteFsRequestJson(stdin.value);
  if (request.status === "error") return Result.err(request.error);
  const payload: RemoteFsDaemonRequest = { ...request.value, cwd: process.cwd() };
  const runtimeDir = await ensureRuntimeDir();
  if (runtimeDir.status === "error") return Result.err(runtimeDir.error);

  const direct = await tryConnectUntil(Date.now() + CONNECT_RETRY_MS, payload);
  if (direct.status === "ok") return Result.ok(responseSuccess(direct.value));
  if (!RemoteFsSocketTransportError.is(direct.error)) return Result.err(direct.error);

  const lockResult = await tryAcquireStartupLock();
  if (lockResult.status === "error") return Result.err(lockResult.error);
  const acquiredLock = lockResult.value;

  const operation = async (): Promise<
    ResultType<ResponseEnvelope, RemoteFsRequestOperationError>
  > => {
    if (!acquiredLock) return await waitForDaemon(payload);
    const spawned = await spawnDaemon();
    if (spawned.status === "error") return Result.err(spawned.error);
    return await waitForDaemon(payload);
  };

  if (!acquiredLock) return await operation();
  return await runWithStartupLockCleanup(operation);
}

export async function executeDaemonRequest(
  request: RemoteFsDaemonRequest,
  execute: (request: RemoteFsDaemonRequest) => Promise<RemoteFsResponse> = handleRequest,
): Promise<ResultType<RemoteFsResponse, RemoteFsSocketTransportError>> {
  try {
    return Result.ok(await execute(request));
  } catch (caught) {
    preservePanic(caught);
    const cause = opaqueErrorCause(caught);
    return Result.err(
      new RemoteFsSocketTransportError({
        cause,
        message: `remote fs daemon failed to execute ${request.op}`,
      }),
    );
  }
}

function createServer(idleMs: number): net.Server {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = 0;

  const scheduleIdleExit = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (inFlight > 0) return;
    idleTimer = setTimeout(() => process.exit(0), idleMs);
  };

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    inFlight += 1;
    if (idleTimer) clearTimeout(idleTimer);

    let requestText = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      requestText += chunk;
    });
    socket.on("error", () => {
      // The client may give up during daemon startup races. The next request will retry.
    });
    socket.on("end", () => {
      void (async () => {
        const request = decodeRemoteFsDaemonRequestJson(requestText);
        if (request.status === "error") {
          socket.end(JSON.stringify(responseError(request.error)));
          inFlight -= 1;
          scheduleIdleExit();
          return;
        }

        const handled = await executeDaemonRequest(request.value);
        if (handled.status === "ok") {
          socket.end(JSON.stringify(responseSuccess(handled.value)));
        } else {
          socket.end(JSON.stringify(responseError(handled.error)));
        }
        inFlight -= 1;
        scheduleIdleExit();
      })();
    });
  });

  server.on("close", () => {
    if (idleTimer) clearTimeout(idleTimer);
  });

  scheduleIdleExit();
  return server;
}

async function runDaemon(): Promise<ResultType<void, RemoteFsRuntimeSetupError>> {
  const runtimeDir = await ensureRuntimeDir();
  if (runtimeDir.status === "error") return Result.err(runtimeDir.error);
  const sock = socketPath();
  if (process.platform !== "win32" && fsSync.existsSync(sock)) {
    const unlinked = await captureRuntimeOperation(
      `failed to remove stale remote fs socket: ${sock}`,
      () => fs.unlink(sock),
    );
    if (unlinked.status === "error") return Result.err(unlinked.error);
  }

  const idleMs = numberOrUndefined(process.env.LILAC_REMOTE_FS_IDLE_MS) ?? DEFAULT_IDLE_MS;
  const server = createServer(idleMs);

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  return await new Promise((resolve) => {
    let settled = false;
    server.once("error", (cause) => {
      if (settled) return;
      settled = true;
      resolve(
        Result.err(
          new RemoteFsRuntimeSetupError({
            cause,
            message: `failed to listen on remote fs socket: ${sock}`,
          }),
        ),
      );
    });
    server.listen(sock, () => {
      void (async () => {
        if (settled) return;
        if (process.platform !== "win32") {
          const secured = await captureRuntimeOperation(
            `failed to secure remote fs socket: ${sock}`,
            () => fs.chmod(sock, 0o600),
          );
          if (secured.status === "error") {
            settled = true;
            server.close();
            resolve(Result.err(secured.error));
            return;
          }
        }
        settled = true;
        resolve(Result.ok(undefined));
      })();
    });
  });
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "request";
  if (command === "--version" || command === "-v" || command === "version") {
    writeLine(RUNNER_PACKAGE_VERSION);
    return;
  }
  if (command === "daemon") {
    const daemon = await runDaemon();
    if (daemon.status === "error") {
      writeJson(responseError(daemon.error));
      process.exitCode = 1;
    }
    return;
  }
  if (command === "request") {
    const request = await runRequest();
    writeJson(request.status === "ok" ? request.value : responseError(request.error));
    return;
  }
  if (command === "health") {
    const runtimeDir = await ensureRuntimeDir();
    if (runtimeDir.status === "error") {
      writeJson(responseError(runtimeDir.error));
      return;
    }
    const response = await connectOnce({
      op: "health",
      input: {},
      denyPaths: [],
      cwd: process.cwd(),
    });
    writeJson(
      response.status === "ok"
        ? ({ ok: true, value: response.value } satisfies ResponseEnvelope)
        : responseError(response.error),
    );
    return;
  }

  writeJson({ ok: false, error: `Unknown command: ${command}` } satisfies ResponseEnvelope);
}

export function reportMainFailure(error: unknown): void {
  preservePanic(error);
  writeJson({ ok: false, error: opaqueErrorMessage(error) } satisfies ResponseEnvelope);
  process.exitCode = 1;
}

function startMain(): void {
  void main().catch(reportMainFailure);
}

if (import.meta.main) startMain();
