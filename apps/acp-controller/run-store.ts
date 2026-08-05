import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Result, type Panic, type Result as ResultType } from "better-result";
import { z } from "zod";

import {
  captureAcpFailure,
  captureExternal,
  recordAcpCleanupFailure,
  signalAcpDefect,
  type CapturedAcpFailure,
} from "./external-adapters.ts";
import {
  ExternalOperationFailed,
  InvalidRunId,
  RunCancellationCorruptFields,
  RunCancellationMalformedSerialization,
  RunCancellationMarkerInvalidType,
  RunCancellationUnsupportedVersion,
  RunRecordCorruptFields,
  RunRecordMalformedSerialization,
  SessionIndexCorruptFields,
  SessionIndexLockTimedOut,
  SessionIndexMalformedSerialization,
  SessionIndexUnsupportedVersion,
  WorkAndCleanupFailed,
  type RunStoreError,
  type SessionIndexCodecError,
  type SessionStoreError,
} from "./failures.ts";
import {
  promptRunRecordSchema,
  sessionIndexEntrySchema,
  sessionIndexSchema,
  type PromptRunRecord,
  type SessionIndex,
  type SessionIndexEntry,
} from "./types.ts";

type PersistedRead<T> = {
  readonly provenance: "current" | "migrated" | "missing-defaulted";
  readonly value: T;
};

type PresentPersistedRead<T> = {
  readonly provenance: "current" | "migrated";
  readonly value: T;
};

export type SessionIndexRead = PersistedRead<SessionIndex>;

const persistedVersionSchema = z.object({ version: z.number() });
const runCancellationSchema = z.object({
  version: z.literal(1),
  runCreatedAt: z.number().int().nonnegative(),
  requestedAt: z.number().int().nonnegative(),
});
const legacyRunCancellationSchema = runCancellationSchema.extend({ version: z.literal(0) });
const legacyRunRecordSchema = promptRunRecordSchema
  .omit({ permissions: true })
  .extend({ permissions: z.never().optional() });
const legacySessionIndexSchema = z.object({
  version: z.literal(0),
  sessions: z.array(sessionIndexEntrySchema),
});

export type RunRecordCodecInput = {
  readonly runId: string;
  readonly content: string;
};

export type RunCancellation = z.output<typeof runCancellationSchema>;

export type RunCancellationCodecInput = {
  readonly runId: string;
  readonly content: string;
};

function stateBaseDir(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  const base =
    xdgStateHome && xdgStateHome.trim().length > 0
      ? xdgStateHome
      : path.join(os.homedir(), ".local", "state");
  return path.join(base, "lilac-acp-controller");
}

function runsDir(): string {
  return path.join(stateBaseDir(), "runs");
}

function sessionsDir(): string {
  return path.join(stateBaseDir(), "sessions");
}

function sessionIndexPath(): string {
  return path.join(sessionsDir(), "index.json");
}

function sessionIndexLockPath(): string {
  return path.join(sessionsDir(), "index.lock");
}

function runFilePath(runId: string): string {
  return path.join(runsDir(), `${runId}.json`);
}

function runCancellationPath(runId: string): string {
  return path.join(runsDir(), `${runId}.cancel.json`);
}

function validateRunId(runId: string): ResultType<string, InvalidRunId> {
  const trimmed = runId.trim();
  if (/^run_[a-f0-9-]+$/.test(trimmed)) return Result.ok(trimmed);
  return Result.err(new InvalidRunId({ runId, message: `Invalid run ID '${runId}'.` }));
}

function parseJson(content: string): ResultType<unknown, { readonly cause: Error }> {
  const parsed = Result.try({
    try: () => JSON.parse(content),
    catch: captureAcpFailure,
  });
  if (parsed.status === "ok") return Result.ok(parsed.value);
  if (parsed.error.kind === "panic") return signalAcpDefect(parsed.error.panic);
  return Result.err({ cause: parsed.error.cause });
}

export function decodeRunRecord(
  input: RunRecordCodecInput,
): ResultType<
  PresentPersistedRead<PromptRunRecord>,
  RunRecordMalformedSerialization | RunRecordCorruptFields
> {
  const decoded = parseJson(input.content);
  if (decoded.status === "error") {
    return Result.err(
      new RunRecordMalformedSerialization({
        runId: input.runId,
        message:
          decoded.error.cause instanceof Error
            ? decoded.error.cause.message
            : `Run record '${input.runId}' contains malformed JSON.`,
      }),
    );
  }
  const parsed = promptRunRecordSchema.safeParse(decoded.value);
  if (parsed.success) return Result.ok({ provenance: "current", value: parsed.data });
  const legacy = legacyRunRecordSchema.safeParse(decoded.value);
  if (legacy.success) {
    return Result.ok({
      provenance: "migrated",
      value: {
        ...legacy.data,
        permissions: {
          permissionsApproved: 0,
          permissionsRejected: 0,
          permissionsCancelled: 0,
        },
      },
    });
  }
  return Result.err(
    new RunRecordCorruptFields({
      runId: input.runId,
      message: `Run record '${input.runId}' is malformed.`,
    }),
  );
}

export function decodeRunCancellation(
  input: RunCancellationCodecInput,
): ResultType<
  PresentPersistedRead<RunCancellation>,
  | RunCancellationMalformedSerialization
  | RunCancellationUnsupportedVersion
  | RunCancellationCorruptFields
> {
  const decoded = parseJson(input.content);
  if (decoded.status === "error") {
    return Result.err(
      new RunCancellationMalformedSerialization({
        runId: input.runId,
        message: `Run cancellation marker '${input.runId}' contains malformed JSON.`,
      }),
    );
  }
  const parsed = runCancellationSchema.safeParse(decoded.value);
  if (parsed.success) return Result.ok({ provenance: "current", value: parsed.data });
  const legacy = legacyRunCancellationSchema.safeParse(decoded.value);
  if (legacy.success) {
    return Result.ok({
      provenance: "migrated",
      value: { ...legacy.data, version: 1 },
    });
  }
  const version = persistedVersionSchema.safeParse(decoded.value);
  if (version.success && version.data.version !== 1) {
    return Result.err(
      new RunCancellationUnsupportedVersion({
        runId: input.runId,
        version: version.data.version,
        message: `Run cancellation marker '${input.runId}' has unsupported version ${version.data.version}.`,
      }),
    );
  }
  return Result.err(
    new RunCancellationCorruptFields({
      runId: input.runId,
      message: `Run cancellation marker '${input.runId}' contains corrupt fields.`,
    }),
  );
}

export function decodeSessionIndex(
  content: string | undefined,
): ResultType<SessionIndexRead, SessionIndexCodecError> {
  if (content === undefined) {
    return Result.ok({
      provenance: "missing-defaulted",
      value: { version: 1, sessions: [] },
    });
  }
  const decoded = parseJson(content);
  if (decoded.status === "error") {
    return Result.err(
      new SessionIndexMalformedSerialization({
        message:
          decoded.error.cause instanceof Error
            ? decoded.error.cause.message
            : "Session index contains malformed JSON.",
      }),
    );
  }
  const parsed = sessionIndexSchema.safeParse(decoded.value);
  if (parsed.success) return Result.ok({ provenance: "current", value: parsed.data });
  const legacy = legacySessionIndexSchema.safeParse(decoded.value);
  if (legacy.success) {
    return Result.ok({
      provenance: "migrated",
      value: { version: 1, sessions: legacy.data.sessions },
    });
  }
  const version = persistedVersionSchema.safeParse(decoded.value);
  if (version.success && version.data.version !== 1) {
    return Result.err(
      new SessionIndexUnsupportedVersion({
        version: version.data.version,
        message: `Session index version ${version.data.version} is unsupported.`,
      }),
    );
  }
  return Result.err(
    new SessionIndexCorruptFields({ message: "Session index contains corrupt fields." }),
  );
}

async function atomicWriteFile(
  filePath: string,
  content: string,
  operation: "write-run" | "write-session-index",
): Promise<ResultType<void, ExternalOperationFailed>> {
  const dirPath = path.dirname(filePath);
  const tempPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  const written = await captureExternal(operation, () => fs.writeFile(tempPath, content, "utf8"));
  if (written.status === "error") return Result.err(written.error);
  return captureExternal(operation, () => fs.rename(tempPath, filePath));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireSessionIndexLock(): Promise<
  ResultType<void, ExternalOperationFailed | SessionIndexLockTimedOut>
> {
  const directory = await captureExternal("acquire-session-lock", () =>
    fs.mkdir(sessionsDir(), { recursive: true }),
  );
  if (directory.status === "error") return Result.err(directory.error);
  const lockPath = sessionIndexLockPath();
  const deadline = Date.now() + 5_000;

  while (true) {
    const acquired = await captureExternal("acquire-session-lock", () => fs.mkdir(lockPath));
    if (acquired.status === "ok") return Result.ok(undefined);
    if (acquired.error.code !== "EEXIST") return Result.err(acquired.error);
    if (Date.now() >= deadline) {
      return Result.err(
        new SessionIndexLockTimedOut({
          message: "Timed out waiting for the session index lock.",
        }),
      );
    }
    await sleep(25);
  }
}

async function withSessionIndexLock<T>(
  work: () => Promise<
    ResultType<T, ExternalOperationFailed | SessionIndexCodecError | SessionIndexLockTimedOut>
  >,
): Promise<ResultType<T, SessionStoreError>> {
  const acquired = await acquireSessionIndexLock();
  if (acquired.status === "error") return Result.err(acquired.error);

  const attempted = await Result.tryPromise({
    try: work,
    catch: captureAcpFailure,
  });
  const cleanupAttempted = await Result.tryPromise({
    try: () =>
      captureExternal("remove-session-lock", () =>
        fs.rm(sessionIndexLockPath(), { recursive: true, force: true }),
      ),
    catch: captureAcpFailure,
  });

  function ordinaryCaptureToExternal(
    operation: "remove-session-lock" | "session-index-work",
    captured: Extract<CapturedAcpFailure, { readonly kind: "ordinary" }>,
  ): ExternalOperationFailed {
    return new ExternalOperationFailed({
      operation,
      cause: captured.cause,
      ...(captured.projection.code ? { code: captured.projection.code } : {}),
      message: captured.projection.message,
    });
  }

  if (attempted.status === "error" && attempted.error.kind === "panic") {
    if (cleanupAttempted.status === "ok") {
      if (cleanupAttempted.value.status === "error") {
        recordAcpCleanupFailure(attempted.error.panic, cleanupAttempted.value.error);
      }
    } else {
      const cleanupFailure =
        cleanupAttempted.error.kind === "panic"
          ? cleanupAttempted.error.panic
          : ordinaryCaptureToExternal("remove-session-lock", cleanupAttempted.error);
      recordAcpCleanupFailure(attempted.error.panic, cleanupFailure);
    }
    return signalAcpDefect(attempted.error.panic);
  }

  let result: ResultType<
    T,
    ExternalOperationFailed | SessionIndexCodecError | SessionIndexLockTimedOut
  >;
  if (attempted.status === "ok") {
    result = attempted.value;
  } else {
    switch (attempted.error.kind) {
      case "panic":
        return signalAcpDefect(attempted.error.panic);
      case "ordinary":
        result = Result.err(ordinaryCaptureToExternal("session-index-work", attempted.error));
        break;
    }
  }

  let cleanup: ResultType<void, ExternalOperationFailed>;
  if (cleanupAttempted.status === "ok") {
    cleanup = cleanupAttempted.value;
  } else {
    switch (cleanupAttempted.error.kind) {
      case "panic":
        return signalAcpDefect(cleanupAttempted.error.panic);
      case "ordinary":
        cleanup = Result.err(
          ordinaryCaptureToExternal("remove-session-lock", cleanupAttempted.error),
        );
        break;
    }
  }
  if (cleanup.status === "ok") return result;
  if (result.status === "ok") return Result.err(cleanup.error);
  return Result.err(
    new WorkAndCleanupFailed({
      primary: result.error,
      cleanup: cleanup.error,
      message: `${result.error.message} Session index lock cleanup also failed.`,
    }),
  );
}

export async function saveRunRecord(
  run: PromptRunRecord,
): Promise<ResultType<void, ExternalOperationFailed>> {
  const directory = await captureExternal("write-run", () =>
    fs.mkdir(runsDir(), { recursive: true }),
  );
  if (directory.status === "error") return Result.err(directory.error);
  return atomicWriteFile(runFilePath(run.id), `${JSON.stringify(run)}\n`, "write-run");
}

export async function loadRunCancellation(
  run: Pick<PromptRunRecord, "id" | "createdAt">,
): Promise<ResultType<number | undefined, RunStoreError>> {
  const markerPath = runCancellationPath(run.id);
  const marker = await captureExternal("read-run", () => fs.lstat(markerPath));
  if (marker.status === "error") {
    return marker.error.code === "ENOENT" ? Result.ok(undefined) : Result.err(marker.error);
  }
  if (marker.value.isSymbolicLink() || !marker.value.isFile()) {
    return Result.err(
      new RunCancellationMarkerInvalidType({
        runId: run.id,
        message: `Run cancellation marker '${run.id}' must be a regular file.`,
      }),
    );
  }
  const content = await captureExternal("read-run", () => fs.readFile(markerPath, "utf8"));
  if (content.status === "error") return Result.err(content.error);
  const decoded = decodeRunCancellation({ runId: run.id, content: content.value });
  if (decoded.status === "error") return Result.err(decoded.error);
  if (
    decoded.value.value.runCreatedAt !== run.createdAt ||
    decoded.value.value.requestedAt < run.createdAt
  ) {
    return Result.ok(undefined);
  }
  return Result.ok(decoded.value.value.requestedAt);
}

function applyRunCancellation(
  run: PromptRunRecord,
  requestedAt: number | undefined,
): PromptRunRecord {
  if (requestedAt === undefined) return run;
  const cancelRequestedAt = Math.min(run.cancelRequestedAt ?? requestedAt, requestedAt);
  if (isTerminalRunStatus(run.status) && run.updatedAt <= cancelRequestedAt) {
    return { ...run, cancelRequestedAt };
  }
  if (!isTerminalRunStatus(run.status)) return { ...run, cancelRequestedAt };
  if (run.status === "cancelled") return { ...run, cancelRequestedAt };
  return {
    ...run,
    status: "cancelled",
    cancelRequestedAt,
    error: run.error ?? "Prompt cancelled.",
  };
}

function isTerminalRunStatus(status: PromptRunRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export async function saveWorkerRunRecord(
  run: PromptRunRecord,
): Promise<ResultType<PromptRunRecord, RunStoreError>> {
  const cancellationBefore = await loadRunCancellation(run);
  if (cancellationBefore.status === "error") return Result.err(cancellationBefore.error);
  let next = applyRunCancellation(run, cancellationBefore.value);
  const saved = await saveRunRecord(next);
  if (saved.status === "error") return Result.err(saved.error);

  const cancellationAfter = await loadRunCancellation(run);
  if (cancellationAfter.status === "error") return Result.err(cancellationAfter.error);
  const merged = applyRunCancellation(next, cancellationAfter.value);
  if (merged !== next) {
    const cancellationSaved = await saveRunRecord(merged);
    if (cancellationSaved.status === "error") return Result.err(cancellationSaved.error);
    next = merged;
  }
  return Result.ok(next);
}

export type RunCancellationRequestOutcome =
  | { readonly kind: "requested"; readonly run: PromptRunRecord }
  | { readonly kind: "already-terminal"; readonly run: PromptRunRecord };

export async function commitRunCancellationRequest(
  run: PromptRunRecord,
): Promise<
  ResultType<Extract<RunCancellationRequestOutcome, { readonly kind: "requested" }>, RunStoreError>
> {
  const directory = await captureExternal("write-run", () =>
    fs.mkdir(runsDir(), { recursive: true }),
  );
  if (directory.status === "error") return Result.err(directory.error);
  const requestedAt = run.cancelRequestedAt ?? Math.max(Date.now(), run.createdAt);
  const marked = await atomicWriteFile(
    runCancellationPath(run.id),
    `${JSON.stringify({
      version: 1,
      runCreatedAt: run.createdAt,
      requestedAt,
    } satisfies RunCancellation)}\n`,
    "write-run",
  );
  if (marked.status === "error") return Result.err(marked.error);
  const current = await loadRunRecord(run.id);
  if (current.status === "error") return Result.err(current.error);
  return Result.ok({ kind: "requested", run: current.value });
}

export async function requestRunCancellation(
  runId: string,
): Promise<ResultType<RunCancellationRequestOutcome, RunStoreError>> {
  const safeRunId = validateRunId(runId);
  if (safeRunId.status === "error") return Result.err(safeRunId.error);
  const loaded = await loadRunRecord(safeRunId.value);
  if (loaded.status === "error") return Result.err(loaded.error);
  if (isTerminalRunStatus(loaded.value.status)) {
    return Result.ok({ kind: "already-terminal", run: loaded.value });
  }
  return commitRunCancellationRequest(loaded.value);
}

export type RunCancellationObservation = {
  readonly result: Promise<ResultType<"requested" | "stopped", RunStoreError>>;
  readonly close: () => Promise<ResultType<void, ExternalOperationFailed>>;
};

export async function observeRunCancellation(
  run: Pick<PromptRunRecord, "id" | "createdAt">,
  inspect: (
    candidate: Pick<PromptRunRecord, "id" | "createdAt">,
  ) => Promise<ResultType<number | undefined, RunStoreError>> = loadRunCancellation,
): Promise<ResultType<RunCancellationObservation, ExternalOperationFailed>> {
  const watched = await captureExternal("watch-run-cancellation", async () => watch(runsDir()));
  if (watched.status === "error") return Result.err(watched.error);
  const watcher = watched.value;
  let accepting = true;
  let settled = false;
  let resolveResult: (result: ResultType<"requested" | "stopped", RunStoreError>) => void = () =>
    undefined;
  let rejectResult: (cause: Panic) => void = () => undefined;
  const result = new Promise<ResultType<"requested" | "stopped", RunStoreError>>(
    (resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    },
  );
  let stopFallbackCheck: () => void = () => undefined;
  const settle = (resolution: ResultType<"requested" | "stopped", RunStoreError>) => {
    if (settled) return;
    settled = true;
    stopFallbackCheck();
    resolveResult(resolution);
  };
  const settlePanic = (panic: Extract<CapturedAcpFailure, { readonly kind: "panic" }>) => {
    if (settled) return;
    settled = true;
    stopFallbackCheck();
    rejectResult(panic.panic);
  };
  let pendingCheck = Promise.resolve();
  const scheduleCheck = () => {
    if (!accepting || settled) return;
    pendingCheck = pendingCheck.then(async () => {
      if (settled) return;
      const inspected = await Result.tryPromise({
        try: () => inspect(run),
        catch: captureAcpFailure,
      });
      if (inspected.status === "error") {
        switch (inspected.error.kind) {
          case "panic":
            settlePanic(inspected.error);
            return;
          case "ordinary":
            settle(
              Result.err(
                new ExternalOperationFailed({
                  operation: "watch-run-cancellation",
                  cause: inspected.error.cause,
                  ...(inspected.error.projection.code
                    ? { code: inspected.error.projection.code }
                    : {}),
                  message: inspected.error.projection.message,
                }),
              ),
            );
            return;
        }
      }
      if (inspected.value.status === "error") {
        settle(Result.err(inspected.value.error));
      } else if (inspected.value.value !== undefined) {
        settle(Result.ok("requested"));
      }
    });
  };
  watcher.on("change", scheduleCheck);
  watcher.on("error", (cause: Error) => {
    settle(
      Result.err(
        new ExternalOperationFailed({
          operation: "watch-run-cancellation",
          cause,
          message: cause.message,
        }),
      ),
    );
  });
  scheduleCheck();
  const fallbackCheck = setInterval(scheduleCheck, 100);
  fallbackCheck.unref();
  stopFallbackCheck = () => clearInterval(fallbackCheck);
  if (settled) stopFallbackCheck();

  let closeResult: Promise<ResultType<void, ExternalOperationFailed>> | undefined;
  const close = () => {
    if (closeResult) return closeResult;
    closeResult = (async () => {
      accepting = false;
      stopFallbackCheck();
      const closed = await captureExternal("close-run-cancellation-watch", async () =>
        watcher.close(),
      );
      await pendingCheck;
      if (!settled) settle(Result.ok("stopped"));
      return closed.status === "error" ? Result.err(closed.error) : Result.ok(undefined);
    })();
    return closeResult;
  };

  return Result.ok({
    result,
    close,
  });
}

export async function loadRunRecord(
  runId: string,
): Promise<ResultType<PromptRunRecord, RunStoreError>> {
  const safeRunId = validateRunId(runId);
  if (safeRunId.status === "error") return Result.err(safeRunId.error);
  const content = await captureExternal("read-run", () =>
    fs.readFile(runFilePath(safeRunId.value), "utf8"),
  );
  if (content.status === "error") return Result.err(content.error);
  const decoded = decodeRunRecord({ runId: safeRunId.value, content: content.value });
  if (decoded.status === "error") return Result.err(decoded.error);
  const cancellation = await loadRunCancellation(decoded.value.value);
  if (cancellation.status === "error") return Result.err(cancellation.error);
  return Result.ok(applyRunCancellation(decoded.value.value, cancellation.value));
}

async function saveSessionIndex(
  entries: readonly SessionIndexEntry[],
): Promise<ResultType<void, ExternalOperationFailed>> {
  const directory = await captureExternal("write-session-index", () =>
    fs.mkdir(sessionsDir(), { recursive: true }),
  );
  if (directory.status === "error") return Result.err(directory.error);
  const payload: SessionIndex = { version: 1, sessions: [...entries] };
  return atomicWriteFile(sessionIndexPath(), `${JSON.stringify(payload)}\n`, "write-session-index");
}

export async function loadSessionIndex(): Promise<
  ResultType<SessionIndexRead, ExternalOperationFailed | SessionIndexCodecError>
> {
  const content = await captureExternal("read-session-index", () =>
    fs.readFile(sessionIndexPath(), "utf8"),
  );
  if (content.status === "error") {
    if (content.error.code === "ENOENT") {
      return Result.ok({
        provenance: "missing-defaulted",
        value: { version: 1, sessions: [] },
      });
    }
    return Result.err(content.error);
  }
  const decoded = decodeSessionIndex(content.value);
  return decoded.status === "ok" ? Result.ok(decoded.value) : Result.err(decoded.error);
}

const fixtureRunId = "run_11111111-1111-4111-8111-111111111111";
const fixtureRunRecord: PromptRunRecord = {
  id: fixtureRunId,
  status: "submitted",
  createdAt: 1,
  updatedAt: 1,
  directory: "/repo",
  harnessId: "opencode",
  targetKind: "new",
  promptText: "fixture",
  textPreview: "fixture",
  permissions: {
    permissionsApproved: 0,
    permissionsRejected: 0,
    permissionsCancelled: 0,
  },
};

export const runRecordCodecCases = {
  current: {
    input: { runId: fixtureRunId, content: JSON.stringify(fixtureRunRecord) },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: {
      runId: fixtureRunId,
      content: JSON.stringify({ ...fixtureRunRecord, permissions: undefined }),
    },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { runId: fixtureRunId, content: "" },
    outcome: "error",
  },
  "unsupported-version": {
    input: { runId: fixtureRunId, content: '{"version":2}' },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { runId: fixtureRunId, content: "{" },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      runId: fixtureRunId,
      content: JSON.stringify({ ...fixtureRunRecord, permissions: {} }),
    },
    outcome: "error",
  },
} as const;

export const runCancellationCodecCases = {
  current: {
    input: {
      runId: fixtureRunId,
      content: JSON.stringify({ version: 1, runCreatedAt: 1, requestedAt: 2 }),
    },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: {
      runId: fixtureRunId,
      content: JSON.stringify({ version: 0, runCreatedAt: 1, requestedAt: 2 }),
    },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { runId: fixtureRunId, content: "" },
    outcome: "error",
  },
  "unsupported-version": {
    input: { runId: fixtureRunId, content: '{"version":2}' },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { runId: fixtureRunId, content: "{" },
    outcome: "error",
  },
  "corrupt-fields": {
    input: { runId: fixtureRunId, content: '{"version":1,"runCreatedAt":"bad"}' },
    outcome: "error",
  },
} as const;

export const sessionIndexCodecCases = {
  current: {
    input: '{"version":1,"sessions":[]}',
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: '{"version":0,"sessions":[]}',
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: undefined,
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: '{"version":2,"sessions":[]}',
    outcome: "error",
  },
  "malformed-serialization": {
    input: "{",
    outcome: "error",
  },
  "corrupt-fields": {
    input: '{"version":1,"sessions":"invalid"}',
    outcome: "error",
  },
} as const;

export async function upsertSessionIndexEntries(
  entries: readonly SessionIndexEntry[],
): Promise<ResultType<SessionIndex, SessionStoreError>> {
  return withSessionIndexLock(async () => {
    const loaded = await loadSessionIndex();
    if (loaded.status === "error") return Result.err(loaded.error);
    const merged = new Map(loaded.value.value.sessions.map((entry) => [entry.sessionRef, entry]));
    for (const entry of entries) {
      const previous = merged.get(entry.sessionRef);
      merged.set(entry.sessionRef, {
        ...previous,
        ...entry,
        localTitle: entry.localTitle ?? previous?.localTitle,
      });
    }
    const next: SessionIndex = { version: 1, sessions: [...merged.values()] };
    const saved = await saveSessionIndex(next.sessions);
    return saved.status === "ok" ? Result.ok(next) : Result.err(saved.error);
  });
}

export async function setLocalSessionTitle(
  sessionRef: string,
  localTitle: string,
): Promise<ResultType<SessionIndex, SessionStoreError>> {
  return withSessionIndexLock(async () => {
    const loaded = await loadSessionIndex();
    if (loaded.status === "error") return Result.err(loaded.error);
    const nextSessions = loaded.value.value.sessions.map((entry) =>
      entry.sessionRef === sessionRef ? { ...entry, localTitle, title: localTitle } : entry,
    );
    const next: SessionIndex = { version: 1, sessions: nextSessions };
    const saved = await saveSessionIndex(next.sessions);
    return saved.status === "ok" ? Result.ok(next) : Result.err(saved.error);
  });
}
