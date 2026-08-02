import fs from "node:fs/promises";

import { BufferedFileSink } from "@stanley2058/lilac-coding-tools/buffered-file-sink";
import type { BundledRemoteRunnerRequest, RemoteFsRequest } from "@stanley2058/lilac-fs";
import {
  createLogger,
  formatTaggedErrorForLog,
  isPanic,
  opaqueErrorCause,
} from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { requireConfiguredSshHost } from "./ssh-config";

const DEFAULT_CONNECT_TIMEOUT_SECS = 10;
const DEFAULT_SSH_STDIN_MODE: SshBashStdinMode = "error";
const logger = createLogger({ module: "ssh-exec" });

export type SshBashStdinMode = "error" | "eof";

export type SshExecOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Maximum stdout/stderr characters to capture per stream.
   * If output exceeds this cap, it is truncated and `capped=true`.
   */
  maxOutputChars: number;
  overflowOutputPath?: string;
};

export type SshExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  capped: { stdout: boolean; stderr: boolean };
  overflowPaths: { stdout?: string; stderr?: string };
};

export class SshExecutionCancelledError extends TaggedError("SshExecutionCancelledError")<{
  readonly message: string;
}> {}

export class SshExecutionTimedOutError extends TaggedError("SshExecutionTimedOutError")<{
  readonly timeoutMs: number;
  readonly message: string;
}> {}

export class SshExecutionOutputCappedError extends TaggedError("SshExecutionOutputCappedError")<{
  readonly message: string;
}> {}

export class SshExecutionTransportError extends TaggedError("SshExecutionTransportError")<{
  readonly transportType: "hostkey" | "auth" | "connect" | "unknown";
  readonly message: string;
}> {}

export class SshSubprocessExitError extends TaggedError("SshSubprocessExitError")<{
  readonly exitCode: number;
  readonly stderr: string;
  readonly message: string;
}> {}

export class SshExecutionAdapterError extends TaggedError("SshExecutionAdapterError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class SshRequestSerializationError extends TaggedError("SshRequestSerializationError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class SshStreamReadError extends TaggedError("SshStreamReadError")<{
  readonly operation: "acquire_reader" | "read_chunk" | "read_body" | "report_activity";
  readonly cause: unknown;
  readonly message: string;
}> {}

export class SshStreamCleanupError extends TaggedError("SshStreamCleanupError")<{
  readonly operation: "release_reader";
  readonly cause: unknown;
  readonly message: string;
}> {}

export class SshStreamReadAndCleanupError extends TaggedError("SshStreamReadAndCleanupError")<{
  readonly primary: SshStreamReadError;
  readonly cleanup: SshStreamCleanupError;
  readonly message: string;
}> {}

class SshOverflowOperationError extends TaggedError("SshOverflowOperationError")<{
  readonly operation: "open" | "write" | "close" | "abort" | "remove";
  readonly cause: unknown;
  readonly message: string;
}> {}

class SshOverflowCleanupError extends TaggedError("SshOverflowCleanupError")<{
  readonly failures: readonly SshOverflowOperationError[];
  readonly message: string;
}> {}

class SshProcessSignalError extends TaggedError("SshProcessSignalError")<{
  readonly target: "group" | "process";
  readonly pid: number;
  readonly signal: "SIGTERM" | "SIGKILL";
  readonly cause: unknown;
  readonly message: string;
}> {}

class SshProcessCleanupError extends TaggedError("SshProcessCleanupError")<{
  readonly failures: readonly SshProcessSignalError[];
  readonly message: string;
}> {}

class SshExitWaitError extends TaggedError("SshExitWaitError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export type SshJsonExecutionError =
  | SshExecutionCancelledError
  | SshExecutionTimedOutError
  | SshExecutionOutputCappedError
  | SshExecutionTransportError
  | SshSubprocessExitError
  | SshExecutionAdapterError
  | SshRequestSerializationError;

export type StreamTextResult = {
  text: string;
  totalChars: number;
  capped: boolean;
  overflowFilePath?: string;
};

export type SshStreamTextError =
  | SshStreamReadError
  | SshStreamCleanupError
  | SshStreamReadAndCleanupError;

export type SshStreamTextSource =
  | ReadableStream<Uint8Array>
  | XMLHttpRequestBodyInit
  | number
  | null
  | undefined;

type OverflowCapture = {
  readonly target: string;
  readonly bufferedRawChunks: Buffer[];
  sink?: BufferedFileSink;
  fileCreated: boolean;
  disabled: boolean;
};

type SshStreamReadChunk = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

function rethrowSshPanic(cause: unknown): unknown {
  if (isPanic(cause)) throw cause;
  return opaqueErrorCause(cause, "Opaque SSH adapter failure");
}

export function serializeRemoteRunnerRequestJson(
  request: BundledRemoteRunnerRequest | RemoteFsRequest,
): ResultType<string, SshRequestSerializationError> {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(request);
  } catch (caught) {
    const cause = rethrowSshPanic(caught);
    return Result.err(
      new SshRequestSerializationError({
        cause,
        message: "Remote runner request could not be serialized as JSON",
      }),
    );
  }
  if (serialized !== undefined) return Result.ok(serialized);
  return Result.err(
    new SshRequestSerializationError({
      cause: new TypeError("JSON.stringify returned undefined for a remote runner request"),
      message: "Remote runner request could not be serialized as JSON",
    }),
  );
}

function acquireStreamReader(
  stream: ReadableStream<Uint8Array>,
): ResultType<ReadableStreamDefaultReader<Uint8Array>, SshStreamReadError> {
  return Result.try({
    try: () => stream.getReader(),
    catch: (caught) => {
      const cause = rethrowSshPanic(caught);
      return new SshStreamReadError({
        operation: "acquire_reader",
        cause,
        message: "Failed to acquire the SSH output stream reader",
      });
    },
  });
}

function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ResultType<SshStreamReadChunk, SshStreamReadError>> {
  return Result.tryPromise({
    try: () => reader.read(),
    catch: (caught) => {
      const cause = rethrowSshPanic(caught);
      return new SshStreamReadError({
        operation: "read_chunk",
        cause,
        message: "Failed to read SSH output",
      });
    },
  });
}

function releaseStreamReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ResultType<void, SshStreamCleanupError> {
  return Result.try({
    try: () => reader.releaseLock(),
    catch: (caught) => {
      const cause = rethrowSshPanic(caught);
      return new SshStreamCleanupError({
        operation: "release_reader",
        cause,
        message: "Failed to release the SSH output stream reader",
      });
    },
  });
}

function reportStreamActivity(onActivity: () => void): ResultType<void, SshStreamReadError> {
  return Result.try({
    try: onActivity,
    catch: (caught) => {
      const cause = rethrowSshPanic(caught);
      return new SshStreamReadError({
        operation: "report_activity",
        cause,
        message: "SSH output activity callback failed",
      });
    },
  });
}

function readResponseBody(
  body: XMLHttpRequestBodyInit,
): Promise<ResultType<Buffer, SshStreamReadError>> {
  return Result.tryPromise({
    try: async () => Buffer.from(await new Response(body).arrayBuffer()),
    catch: (caught) => {
      const cause = rethrowSshPanic(caught);
      return new SshStreamReadError({
        operation: "read_body",
        cause,
        message: "Failed to read the SSH output body",
      });
    },
  });
}

function openOverflowSink(
  target: string,
): Promise<ResultType<BufferedFileSink, SshOverflowOperationError>> {
  return Result.tryPromise({
    try: () => BufferedFileSink.open(target, { flags: "wx", mode: 0o600 }),
    catch: (caught) => {
      const cause = rethrowSshPanic(caught);
      return new SshOverflowOperationError({
        operation: "open",
        cause,
        message: "Failed to open SSH overflow output",
      });
    },
  });
}

function writeOverflowSink(
  sink: BufferedFileSink,
  chunk: Uint8Array,
): Promise<ResultType<void, SshOverflowOperationError>> {
  return Result.tryPromise({
    try: () => sink.write(chunk),
    catch: (caught) => {
      const cause = rethrowSshPanic(caught);
      return new SshOverflowOperationError({
        operation: "write",
        cause,
        message: "Failed to write SSH overflow output",
      });
    },
  });
}

function closeOverflowSink(
  sink: BufferedFileSink,
): Promise<ResultType<void, SshOverflowOperationError>> {
  return Result.tryPromise({
    try: () => sink.close(),
    catch: (caught) => {
      const cause = rethrowSshPanic(caught);
      return new SshOverflowOperationError({
        operation: "close",
        cause,
        message: "Failed to close SSH overflow output",
      });
    },
  });
}

function abortOverflowSink(
  sink: BufferedFileSink,
): Promise<ResultType<void, SshOverflowOperationError>> {
  return Result.tryPromise({
    try: () => sink.abort(),
    catch: (caught) => {
      const cause = rethrowSshPanic(caught);
      return new SshOverflowOperationError({
        operation: "abort",
        cause,
        message: "Failed to abort SSH overflow output",
      });
    },
  });
}

function removeOverflowFile(target: string): Promise<ResultType<void, SshOverflowOperationError>> {
  return Result.tryPromise({
    try: () => fs.rm(target, { force: true }),
    catch: (caught) => {
      const cause = rethrowSshPanic(caught);
      return new SshOverflowOperationError({
        operation: "remove",
        cause,
        message: "Failed to remove incomplete SSH overflow output",
      });
    },
  });
}

async function cleanupOverflowCapture(
  capture: OverflowCapture,
): Promise<ResultType<void, SshOverflowCleanupError>> {
  const failures: SshOverflowOperationError[] = [];
  const sink = capture.sink;
  capture.sink = undefined;
  if (sink) {
    const aborted = await abortOverflowSink(sink);
    if (aborted.status === "error") failures.push(aborted.error);
  }
  if (capture.fileCreated) {
    const removed = await removeOverflowFile(capture.target);
    if (removed.status === "error") failures.push(removed.error);
  }
  capture.fileCreated = false;
  capture.bufferedRawChunks.length = 0;
  if (failures.length === 0) return Result.ok();
  return Result.err(
    new SshOverflowCleanupError({
      failures,
      message: "Failed to clean up incomplete SSH overflow output",
    }),
  );
}

async function disableOverflowCapture(
  capture: OverflowCapture,
  failure: SshOverflowOperationError,
): Promise<void> {
  capture.disabled = true;
  logger.debug("SSH overflow retention unavailable", formatTaggedErrorForLog(failure));
  const cleanup = await cleanupOverflowCapture(capture);
  if (cleanup.status === "error") {
    logger.debug("SSH overflow cleanup incomplete", formatTaggedErrorForLog(cleanup.error));
  }
}

async function writeOverflowChunk(
  capture: OverflowCapture,
  chunk: Uint8Array,
): Promise<ResultType<void, SshOverflowOperationError>> {
  if (chunk.byteLength === 0 || capture.disabled) return Result.ok();
  if (!capture.sink) {
    const opened = await openOverflowSink(capture.target);
    if (opened.status === "error") return Result.err(opened.error);
    capture.sink = opened.value;
    capture.fileCreated = true;
  }
  return writeOverflowSink(capture.sink, chunk);
}

async function activateOverflowCapture(
  capture: OverflowCapture,
): Promise<ResultType<void, SshOverflowOperationError>> {
  for (const chunk of capture.bufferedRawChunks) {
    const written = await writeOverflowChunk(capture, chunk);
    if (written.status === "error") return Result.err(written.error);
  }
  capture.bufferedRawChunks.length = 0;
  return Result.ok();
}

function combineStreamReadAndCleanup(
  primary: ResultType<StreamTextResult, SshStreamReadError>,
  cleanup: ResultType<void, SshStreamCleanupError>,
): ResultType<StreamTextResult, SshStreamTextError> {
  if (primary.status === "ok") {
    if (cleanup.status === "error") return Result.err(cleanup.error);
    return primary;
  }
  if (cleanup.status === "ok") return primary;
  return Result.err(
    new SshStreamReadAndCleanupError({
      primary: primary.error,
      cleanup: cleanup.error,
      message: `${primary.error.message}; cleanup also failed: ${cleanup.error.message}`,
    }),
  );
}

async function readReadableStreamTextCapped(
  stream: ReadableStream<Uint8Array>,
  maxChars: number,
  options?: { overflowFilePath?: string; onActivity?: () => void },
): Promise<ResultType<StreamTextResult, SshStreamTextError>> {
  const acquired = acquireStreamReader(stream);
  if (acquired.status === "error") return Result.err(acquired.error);
  const reader = acquired.value;
  let releaseAttempted = false;

  try {
    const decoder = new TextDecoder();
    let text = "";
    let totalChars = 0;
    let capped = false;
    let overflowFilePath: string | undefined;
    const overflowCapture: OverflowCapture | undefined = options?.overflowFilePath
      ? {
          target: options.overflowFilePath,
          bufferedRawChunks: [],
          fileCreated: false,
          disabled: false,
        }
      : undefined;

    const consumeChunkText = async (
      chunkText: string,
    ): Promise<ResultType<void, SshOverflowOperationError>> => {
      if (chunkText.length === 0) return Result.ok();
      totalChars += chunkText.length;
      if (capped) return Result.ok();

      const previousText = text;
      const nextLen = previousText.length + chunkText.length;
      if (nextLen <= maxChars) {
        text = previousText + chunkText;
        return Result.ok();
      }

      capped = true;
      const remaining = Math.max(0, maxChars - previousText.length);
      text = previousText + chunkText.slice(0, remaining);
      if (!overflowCapture) return Result.ok();
      return activateOverflowCapture(overflowCapture);
    };

    let primary: ResultType<StreamTextResult, SshStreamReadError>;
    while (true) {
      const read = await readStreamChunk(reader);
      if (read.status === "error") {
        if (overflowCapture) {
          const cleanup = await cleanupOverflowCapture(overflowCapture);
          if (cleanup.status === "error") {
            logger.debug("SSH overflow cleanup incomplete", formatTaggedErrorForLog(cleanup.error));
          }
        }
        primary = Result.err(read.error);
        break;
      }
      const { done, value } = read.value;
      if (done) {
        const tail = decoder.decode();
        if (tail.length > 0) {
          const consumed = await consumeChunkText(tail);
          if (consumed.status === "error" && overflowCapture) {
            await disableOverflowCapture(overflowCapture, consumed.error);
          }
        }
        if (overflowCapture?.sink) {
          const closed = await closeOverflowSink(overflowCapture.sink);
          if (closed.status === "error") {
            await disableOverflowCapture(overflowCapture, closed.error);
          } else {
            overflowCapture.sink = undefined;
            overflowFilePath = overflowCapture.target;
          }
        }
        primary = Result.ok({ text, totalChars, capped, overflowFilePath });
        break;
      }
      if (!value || value.byteLength === 0) continue;

      if (options?.onActivity) {
        const activity = reportStreamActivity(options.onActivity);
        if (activity.status === "error") {
          if (overflowCapture) {
            const cleanup = await cleanupOverflowCapture(overflowCapture);
            if (cleanup.status === "error") {
              logger.debug(
                "SSH overflow cleanup incomplete",
                formatTaggedErrorForLog(cleanup.error),
              );
            }
          }
          primary = Result.err(activity.error);
          break;
        }
      }
      if (capped && overflowCapture) {
        const written = await writeOverflowChunk(overflowCapture, value);
        if (written.status === "error") {
          await disableOverflowCapture(overflowCapture, written.error);
        }
      } else if (overflowCapture) {
        overflowCapture.bufferedRawChunks.push(Buffer.from(value));
      }
      const consumed = await consumeChunkText(decoder.decode(value, { stream: true }));
      if (consumed.status === "error" && overflowCapture) {
        await disableOverflowCapture(overflowCapture, consumed.error);
      }
    }

    releaseAttempted = true;
    return combineStreamReadAndCleanup(primary, releaseStreamReader(reader));
  } finally {
    if (!releaseAttempted) {
      const released = releaseStreamReader(reader);
      if (released.status === "error") {
        logger.debug("SSH stream reader cleanup failed", formatTaggedErrorForLog(released.error));
      }
    }
  }
}

async function readBodyTextCapped(
  body: XMLHttpRequestBodyInit,
  maxChars: number,
  overflowFilePath?: string,
): Promise<ResultType<StreamTextResult, SshStreamReadError>> {
  const read = await readResponseBody(body);
  if (read.status === "error") return Result.err(read.error);
  const fullBytes = read.value;
  const full = new TextDecoder().decode(fullBytes);
  const capped = full.length > maxChars;
  let retainedOverflowPath: string | undefined;
  if (capped && overflowFilePath) {
    const capture: OverflowCapture = {
      target: overflowFilePath,
      bufferedRawChunks: [],
      fileCreated: false,
      disabled: false,
    };
    const written = await writeOverflowChunk(capture, fullBytes);
    if (written.status === "error") {
      await disableOverflowCapture(capture, written.error);
    } else if (capture.sink) {
      const closed = await closeOverflowSink(capture.sink);
      if (closed.status === "error") {
        await disableOverflowCapture(capture, closed.error);
      } else {
        capture.sink = undefined;
        retainedOverflowPath = overflowFilePath;
      }
    }
  }

  return Result.ok({
    text: full.length > maxChars ? full.slice(0, maxChars) : full,
    totalChars: full.length,
    capped,
    overflowFilePath: retainedOverflowPath,
  });
}

export async function readStreamTextCapped(
  stream: SshStreamTextSource,
  maxChars: number,
  options?: { overflowFilePath?: string; onActivity?: () => void },
): Promise<ResultType<StreamTextResult, SshStreamTextError>> {
  if (stream === null || stream === undefined || typeof stream === "number") {
    return Result.ok({ text: "", totalChars: 0, capped: false });
  }
  if (stream instanceof ReadableStream) {
    return readReadableStreamTextCapped(stream, maxChars, options);
  }
  return readBodyTextCapped(stream, maxChars, options?.overflowFilePath);
}

function inferTransportError(
  stderr: string,
): { type: "hostkey" | "auth" | "connect" | "unknown"; message: string } | undefined {
  const s = stderr.toLowerCase();
  if (s.includes("host key verification failed")) {
    return { type: "hostkey", message: "Host key verification failed" };
  }
  if (s.includes("permission denied")) {
    return { type: "auth", message: "Permission denied" };
  }
  if (
    s.includes("connection refused") ||
    s.includes("timed out") ||
    s.includes("could not resolve hostname")
  ) {
    return { type: "connect", message: "Failed to connect" };
  }
  return undefined;
}

function buildRemoteScript(params: { cmd: string; cwd?: string; stdinMode?: SshBashStdinMode }) {
  const stdinMode = params.stdinMode ?? DEFAULT_SSH_STDIN_MODE;
  const cwd = params.cwd ?? "";
  const runCommandSnippet =
    stdinMode === "error"
      ? 'bash --noprofile --norc "$TMP_CMD" </dev/null'
      : 'bash --noprofile --norc "$TMP_CMD"';
  return `#!/usr/bin/env bash
set -euo pipefail

CWD=$(cat <<'__LILAC_CWD__'
${cwd}
__LILAC_CWD__
)

TMP_CMD=""
cleanup() {
  if [ -n "$TMP_CMD" ]; then
    rm -f "$TMP_CMD" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if command -v mktemp >/dev/null 2>&1; then
  TMP_CMD=$(mktemp -t lilac-ssh-cmd.XXXXXX)
else
  TMP_CMD="/tmp/lilac-ssh-cmd.$$"
fi

cat >"$TMP_CMD" <<'__LILAC_CMD__'
${params.cmd}
__LILAC_CMD__

if [ -n "$CWD" ]; then
  if [ "$CWD" = "~" ]; then
    CWD="$HOME"
  elif [[ "$CWD" == "~/"* ]]; then
    CWD="$HOME/\${CWD:2}"
  fi
  cd "$CWD"
fi

# Run under a clean bash to avoid remote environment surprises (rc/profile).
${runCommandSnippet}

exit 0
`;
}

function buildSshChildEnv(): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
  };

  delete childEnv.FORCE_COLOR;
  childEnv.NO_COLOR = "1";

  return childEnv;
}

function signalSshProcess(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  target: "group" | "process",
): ResultType<void, SshProcessSignalError> {
  const signalPid = target === "group" ? -pid : pid;
  const signaled = Result.try({
    try: () => process.kill(signalPid, signal),
    catch: (caught) => {
      const cause = rethrowSshPanic(caught);
      return new SshProcessSignalError({
        target,
        pid,
        signal,
        cause,
        message: `Failed to signal SSH ${target}`,
      });
    },
  });
  if (signaled.status === "error") return Result.err(signaled.error);
  return Result.ok();
}

function killProcessGroupBestEffort(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
): ResultType<void, SshProcessCleanupError> {
  const failures: SshProcessSignalError[] = [];
  const group = signalSshProcess(pid, signal, "group");
  if (group.status === "error") failures.push(group.error);
  const processResult = signalSshProcess(pid, signal, "process");
  if (processResult.status === "error") failures.push(processResult.error);
  if (failures.length === 0) return Result.ok();
  return Result.err(
    new SshProcessCleanupError({
      failures,
      message: `Failed to fully signal SSH process group with ${signal}`,
    }),
  );
}

function observeBestEffortProcessCleanup(cleanup: ResultType<void, SshProcessCleanupError>): void {
  if (cleanup.status === "error") {
    logger.debug("SSH process-group cleanup incomplete", formatTaggedErrorForLog(cleanup.error));
  }
}

function waitForSshExit(exit: Promise<number>): Promise<ResultType<number, SshExitWaitError>> {
  return Result.tryPromise({
    try: () => exit,
    catch: (caught) => {
      const cause = rethrowSshPanic(caught);
      return new SshExitWaitError({
        cause,
        message: "Failed while waiting for the SSH subprocess to exit",
      });
    },
  });
}

function projectStreamCapture(
  streamName: "stdout" | "stderr",
  captured: ResultType<StreamTextResult, SshStreamTextError>,
): StreamTextResult {
  if (captured.status === "ok") return captured.value;
  logger.debug(`SSH ${streamName} capture failed`, formatTaggedErrorForLog(captured.error));
  return { text: "", totalChars: 0, capped: false };
}

export async function sshExecBash(params: {
  host: string;
  cmd: string;
  cwd?: string;
  stdinMode?: SshBashStdinMode;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputChars: number;
  overflowOutputPath?: string;
  onActivity?: () => void;
}): Promise<
  SshExecResult & {
    transportError?: { type: "hostkey" | "auth" | "connect" | "unknown"; message: string };
  }
> {
  await requireConfiguredSshHost(params.host);

  if (params.signal?.aborted) {
    return {
      stdout: "",
      stderr: "",
      exitCode: -1,
      durationMs: 0,
      timedOut: false,
      aborted: true,
      capped: { stdout: false, stderr: false },
      overflowPaths: {},
    };
  }

  const controller = new AbortController();
  let termination: "timeout" | "aborted" | undefined;

  let child: ReturnType<typeof Bun.spawn> | null = null;

  const HARD_KILL_DELAY_MS = 2000;
  let hardKillTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleHardKill = () => {
    if (hardKillTimer) return;
    hardKillTimer = setTimeout(() => {
      const pid = child?.pid;
      if (typeof pid === "number" && pid > 0) {
        observeBestEffortProcessCleanup(killProcessGroupBestEffort(pid, "SIGKILL"));
      }
    }, HARD_KILL_DELAY_MS);
    hardKillTimer.unref?.();
  };

  const terminate = (reason: "timeout" | "aborted") => {
    if (termination) return;
    termination = reason;
    controller.abort();
    const pid = child?.pid;
    if (pid) {
      observeBestEffortProcessCleanup(killProcessGroupBestEffort(pid, "SIGTERM"));
      scheduleHardKill();
    }
  };

  let abortListener: (() => void) | null = null;
  if (params.signal) {
    const onAbort = () => terminate("aborted");
    if (params.signal.aborted) {
      onAbort();
    } else {
      params.signal.addEventListener("abort", onAbort, { once: true });
      abortListener = () => params.signal?.removeEventListener("abort", onAbort);
    }
  }

  const timeout =
    params.timeoutMs === undefined
      ? undefined
      : setTimeout(() => terminate("timeout"), params.timeoutMs);
  const stopWatchingExecution = () => {
    if (timeout) clearTimeout(timeout);
    abortListener?.();
    abortListener = null;
    if (hardKillTimer && !termination) {
      clearTimeout(hardKillTimer);
      hardKillTimer = null;
    }
  };

  const startedAt = Date.now();
  try {
    const sshArgs = [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      `ConnectTimeout=${DEFAULT_CONNECT_TIMEOUT_SECS}`,
      "-o",
      "LogLevel=ERROR",
      params.host,
      "bash",
      "--noprofile",
      "--norc",
      "-s",
    ];

    const script = buildRemoteScript({
      cmd: params.cmd,
      cwd: params.cwd,
      stdinMode: params.stdinMode,
    });

    child = Bun.spawn(["ssh", ...sshArgs], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: new Blob([script]),
      signal: controller.signal,
      killSignal: "SIGTERM",
      detached: true,
      env: buildSshChildEnv(),
    });

    const [stdoutCapture, stderrCapture, exitResult] = await Promise.all([
      readStreamTextCapped(child.stdout, params.maxOutputChars, {
        overflowFilePath: params.overflowOutputPath
          ? `${params.overflowOutputPath}.stdout.part`
          : undefined,
        onActivity: params.onActivity,
      }),
      readStreamTextCapped(child.stderr, params.maxOutputChars, {
        overflowFilePath: params.overflowOutputPath
          ? `${params.overflowOutputPath}.stderr.part`
          : undefined,
        onActivity: params.onActivity,
      }),
      waitForSshExit(child.exited),
    ]);
    stopWatchingExecution();

    const stdoutResult = projectStreamCapture("stdout", stdoutCapture);
    const stderrResult = projectStreamCapture("stderr", stderrCapture);
    if (exitResult.status === "error") {
      logger.debug("SSH subprocess exit wait failed", formatTaggedErrorForLog(exitResult.error));
    }
    const stdout = stdoutResult.text;
    const stderr = stderrResult.text;
    const exitCode = exitResult.status === "ok" ? exitResult.value : -1;

    const transportError = exitCode === 255 ? inferTransportError(stderr) : undefined;

    return {
      stdout,
      stderr,
      exitCode,
      durationMs: Date.now() - startedAt,
      timedOut: termination === "timeout",
      aborted: termination === "aborted",
      capped: {
        stdout: stdoutResult.capped,
        stderr: stderrResult.capped,
      },
      overflowPaths: {
        stdout: stdoutResult.overflowFilePath,
        stderr: stderrResult.overflowFilePath,
      },
      transportError,
    };
  } finally {
    stopWatchingExecution();
  }
}

export async function sshExecScriptJson<T, TDecodeError>(params: {
  host: string;
  cwd: string;
  js: string;
  input: BundledRemoteRunnerRequest;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputChars: number;
  onActivity?: () => void;
  decodeResponse: (text: string) => ResultType<T, TDecodeError>;
}): Promise<ResultType<T, SshJsonExecutionError | TDecodeError>> {
  if (params.signal?.aborted) {
    return Result.err(new SshExecutionCancelledError({ message: "aborted" }));
  }
  const serializedInput = serializeRemoteRunnerRequestJson(params.input);
  if (serializedInput.status === "error") return Result.err(serializedInput.error);
  const inputJson = serializedInput.value;

  const script = `#!/usr/bin/env bash
set -euo pipefail

REMOTE_CWD=$(cat <<'__LILAC_REMOTE_CWD__'
${params.cwd}
__LILAC_REMOTE_CWD__
)

if [ -n "$REMOTE_CWD" ]; then
  if [ "$REMOTE_CWD" = "~" ]; then
    REMOTE_CWD="$HOME"
  elif [[ "$REMOTE_CWD" == "~/"* ]]; then
    REMOTE_CWD="$HOME/\${REMOTE_CWD:2}"
  fi

  if [ ! -d "$REMOTE_CWD" ]; then
    echo '{"ok":false,"error":"Remote cwd does not exist or is not a directory"}'
    exit 0
  fi

  if ! cd "$REMOTE_CWD"; then
    echo '{"ok":false,"error":"Remote cwd is not accessible"}'
    exit 0
  fi
fi

TMP_JS=""
cleanup() {
  if [ -n "$TMP_JS" ]; then
    rm -f "$TMP_JS" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if command -v mktemp >/dev/null 2>&1; then
  TMP_JS=$(mktemp -t lilac-remote-tool.XXXXXX)
else
  TMP_JS="/tmp/lilac-remote-tool.$$"
fi

cat >"$TMP_JS" <<'__LILAC_JS__'
${params.js}
__LILAC_JS__

if command -v bun >/dev/null 2>&1; then
  cat <<'__LILAC_INPUT__' | bun "$TMP_JS"
${inputJson}
__LILAC_INPUT__
  exit 0
fi

if command -v node >/dev/null 2>&1; then
  cat <<'__LILAC_INPUT__' | node "$TMP_JS"
${inputJson}
__LILAC_INPUT__
  exit 0
fi

echo '{"ok":false,"error":"Remote host has neither bun nor node in PATH"}'
exit 0
`;

  const executed = await Result.tryPromise({
    try: () =>
      sshExecBash({
        host: params.host,
        cmd: script,
        cwd: undefined,
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        maxOutputChars: params.maxOutputChars,
        onActivity: params.onActivity,
      }),
    catch: (caught) => {
      const cause = rethrowSshPanic(caught);
      return new SshExecutionAdapterError({ cause, message: "SSH execution adapter failed" });
    },
  });
  if (executed.status === "error") return Result.err(executed.error);
  const res = executed.value;

  if (res.aborted) {
    return Result.err(new SshExecutionCancelledError({ message: "aborted" }));
  }
  if (res.timedOut) {
    return Result.err(
      new SshExecutionTimedOutError({
        timeoutMs: params.timeoutMs,
        message: `timeout:${params.timeoutMs}`,
      }),
    );
  }
  if (res.capped.stdout || res.capped.stderr) {
    return Result.err(
      new SshExecutionOutputCappedError({
        message: "remote output capped (response too large)",
      }),
    );
  }
  if (res.transportError) {
    return Result.err(
      new SshExecutionTransportError({
        transportType: res.transportError.type,
        message: res.transportError.message,
      }),
    );
  }
  if (res.exitCode !== 0) {
    const detail = res.stderr.trim().length > 0 ? `: ${res.stderr.trim()}` : "";
    return Result.err(
      new SshSubprocessExitError({
        exitCode: res.exitCode,
        stderr: res.stderr,
        message: `remote script exited with code ${res.exitCode}${detail}`,
      }),
    );
  }

  const decoded = params.decodeResponse(res.stdout.trim());
  if (decoded.status === "error") {
    return Result.err(decoded.error);
  }
  return Result.ok(decoded.value);
}
