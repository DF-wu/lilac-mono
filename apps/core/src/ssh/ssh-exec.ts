import fs from "node:fs/promises";
import { normalizeRemoteCwd } from "./ssh-cwd";

import { BufferedFileSink } from "@stanley2058/lilac-coding-tools/buffered-file-sink";
import { createLogger, formatTaggedErrorForLog, isPanic } from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import {
  invalidateRemoteRunner,
  REMOTE_RUNNER_MISSING_MARKER,
  resolveRemoteRunner,
  type RemoteRunnerDeployFailure,
  type RemoteRunnerDeployment,
} from "./remote-runner-deploy";
import {
  buildSshArgs,
  buildSshChildEnv,
  captureSshOperation,
  captureSshPromise,
  killProcessGroupBestEffort,
  observeBestEffortProcessCleanup,
} from "./ssh-command";
import { requireConfiguredSshHost, requireConfiguredSshHostResult } from "./ssh-config";
import { captureRuntimeError, projectCapturedRuntimeError } from "../runtime/error-format";
import { adaptToolResultToHost, preserveToolPanic } from "../tools/tool-result-adapters";

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
  errors?: { stdoutRead?: string; stderrRead?: string; exitRead?: string };
};

export class SshStreamReadError extends TaggedError("SshStreamReadError")<{
  readonly detail?: string;
  readonly operation: "acquire_reader" | "read_chunk" | "read_body" | "report_activity";
  readonly cause: unknown;
  readonly message: string;
}> {}

export class SshStreamCleanupError extends TaggedError("SshStreamCleanupError")<{
  readonly operation: "release_reader" | "cancel_reader" | "close_stdin" | "write_stdin";
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

class SshExitWaitError extends TaggedError("SshExitWaitError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

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

type SshOverflowCleanupOutcome = {
  readonly result: ResultType<void, SshOverflowCleanupError>;
  readonly panic?: Panic;
};

function acquireStreamReader(
  stream: ReadableStream<Uint8Array>,
): ResultType<ReadableStreamDefaultReader<Uint8Array>, SshStreamReadError> {
  return captureSshOperation({
    run: () => stream.getReader(),
    fallback: "Opaque SSH stream reader acquisition failure",
    mapError: (cause) =>
      new SshStreamReadError({
        detail: `${cause.name}: ${cause.message}`,
        operation: "acquire_reader",
        cause,
        message: "Failed to acquire the SSH output stream reader",
      }),
  });
}

function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ResultType<SshStreamReadChunk, SshStreamReadError>> {
  return captureSshPromise({
    run: () => reader.read(),
    fallback: "Opaque SSH stream read failure",
    mapError: (cause) =>
      new SshStreamReadError({
        detail: `${cause.name}: ${cause.message}`,
        operation: "read_chunk",
        cause,
        message: "Failed to read SSH output",
      }),
  });
}

function releaseStreamReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ResultType<void, SshStreamCleanupError> {
  return captureSshOperation({
    run: () => reader.releaseLock(),
    fallback: "Opaque SSH stream reader release failure",
    mapError: (cause) =>
      new SshStreamCleanupError({
        operation: "release_reader",
        cause,
        message: "Failed to release the SSH output stream reader",
      }),
  });
}

function cancelStreamReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void captureSshPromise({
    run: () => reader.cancel(),
    fallback: "Opaque SSH stream reader cancellation failure",
    mapError: (cause) =>
      new SshStreamCleanupError({
        operation: "cancel_reader",
        cause,
        message: "Failed to cancel the SSH output stream reader",
      }),
  }).then((cancelled) =>
    cancelled.match({
      ok: () => undefined,
      err: (error) =>
        logger.debug("SSH stream reader cancellation failed", formatTaggedErrorForLog(error)),
    }),
  );
}

function reportStreamActivity(onActivity: () => void): ResultType<void, SshStreamReadError> {
  return captureSshOperation({
    run: onActivity,
    fallback: "Opaque SSH output activity callback failure",
    mapError: (cause) =>
      new SshStreamReadError({
        detail: `${cause.name}: ${cause.message}`,
        operation: "report_activity",
        cause,
        message: "SSH output activity callback failed",
      }),
  });
}

function readResponseBody(
  body: XMLHttpRequestBodyInit,
): Promise<ResultType<Buffer, SshStreamReadError>> {
  return captureSshPromise({
    run: async () => Buffer.from(await new Response(body).arrayBuffer()),
    fallback: "Opaque SSH output body read failure",
    mapError: (cause) =>
      new SshStreamReadError({
        detail: `${cause.name}: ${cause.message}`,
        operation: "read_body",
        cause,
        message: "Failed to read the SSH output body",
      }),
  });
}

function openOverflowSink(
  target: string,
): Promise<ResultType<BufferedFileSink, SshOverflowOperationError>> {
  return captureSshPromise({
    run: () => BufferedFileSink.open(target, { flags: "wx", mode: 0o600 }),
    fallback: "Opaque SSH overflow output open failure",
    mapError: (cause) =>
      new SshOverflowOperationError({
        operation: "open",
        cause,
        message: "Failed to open SSH overflow output",
      }),
  });
}

function writeOverflowSink(
  sink: BufferedFileSink,
  chunk: Uint8Array,
): Promise<ResultType<void, SshOverflowOperationError>> {
  return captureSshPromise({
    run: () => sink.write(chunk),
    fallback: "Opaque SSH overflow output write failure",
    mapError: (cause) =>
      new SshOverflowOperationError({
        operation: "write",
        cause,
        message: "Failed to write SSH overflow output",
      }),
  });
}

function closeOverflowSink(
  sink: BufferedFileSink,
): Promise<ResultType<void, SshOverflowOperationError>> {
  return captureSshPromise({
    run: () => sink.close(),
    fallback: "Opaque SSH overflow output close failure",
    mapError: (cause) =>
      new SshOverflowOperationError({
        operation: "close",
        cause,
        message: "Failed to close SSH overflow output",
      }),
  });
}

function abortOverflowSink(
  sink: BufferedFileSink,
): Promise<ResultType<void, SshOverflowOperationError>> {
  return captureSshPromise({
    run: () => sink.abort(),
    fallback: "Opaque SSH overflow output abort failure",
    mapError: (cause) =>
      new SshOverflowOperationError({
        operation: "abort",
        cause,
        message: "Failed to abort SSH overflow output",
      }),
  });
}

function removeOverflowFile(target: string): Promise<ResultType<void, SshOverflowOperationError>> {
  return captureSshPromise({
    run: () => fs.rm(target, { force: true }),
    fallback: "Opaque SSH overflow output removal failure",
    mapError: (cause) =>
      new SshOverflowOperationError({
        operation: "remove",
        cause,
        message: "Failed to remove incomplete SSH overflow output",
      }),
  });
}

async function settleOverflowOperation<T>(
  run: () => Promise<ResultType<T, SshOverflowOperationError>>,
): Promise<ResultType<ResultType<T, SshOverflowOperationError>, Panic>> {
  const settled = (await Result.tryPromise({ try: run, catch: captureRuntimeError })).mapError(
    (captured) => projectCapturedRuntimeError(captured, "Opaque SSH overflow Result rejection"),
  );
  return settled.mapError((error) =>
    isPanic(error)
      ? error
      : new Panic({ message: "SSH overflow Result API rejected with an ordinary error" }),
  );
}

async function cleanupOverflowCaptureOutcome(
  capture: OverflowCapture,
): Promise<SshOverflowCleanupOutcome> {
  const failures: SshOverflowOperationError[] = [];
  let deferredPanic: Panic | undefined;
  const sink = capture.sink;
  capture.sink = undefined;
  if (sink) {
    const aborted = await settleOverflowOperation(() => abortOverflowSink(sink));
    aborted.match({
      err: (panic) => {
        deferredPanic = panic;
      },
      ok: (result) =>
        result.match({
          ok: () => undefined,
          err: (error) => {
            failures.push(error);
          },
        }),
    });
  }
  if (capture.fileCreated) {
    const removed = await settleOverflowOperation(() => removeOverflowFile(capture.target));
    removed.match({
      err: (panic) => {
        deferredPanic ??= panic;
      },
      ok: (result) =>
        result.match({
          ok: () => undefined,
          err: (error) => {
            failures.push(error);
          },
        }),
    });
  }
  capture.fileCreated = false;
  capture.bufferedRawChunks.length = 0;
  return {
    result:
      failures.length === 0
        ? Result.ok()
        : Result.err(
            new SshOverflowCleanupError({
              failures,
              message: "Failed to clean up incomplete SSH overflow output",
            }),
          ),
    ...(deferredPanic ? { panic: deferredPanic } : {}),
  };
}

async function cleanupOverflowCapture(
  capture: OverflowCapture,
): Promise<ResultType<void, SshOverflowCleanupError>> {
  const outcome = await cleanupOverflowCaptureOutcome(capture);
  if (outcome.panic) preserveToolPanic(outcome.panic);
  return outcome.result;
}

async function propagateOverflowPanic(capture: OverflowCapture, panic: Panic): Promise<never> {
  await cleanupOverflowCaptureOutcome(capture);
  return preserveToolPanic(panic);
}

async function disableOverflowCapture(
  capture: OverflowCapture,
  failure: SshOverflowOperationError,
): Promise<void> {
  capture.disabled = true;
  logger.debug("SSH overflow retention unavailable", formatTaggedErrorForLog(failure));
  const cleanup = await cleanupOverflowCapture(capture);
  cleanup.match({
    ok: () => undefined,
    err: (error) => logger.debug("SSH overflow cleanup incomplete", formatTaggedErrorForLog(error)),
  });
}

/** Closes an open overflow sink and reports whether the overflow file is complete. */
async function closeOverflowCapture(capture: OverflowCapture): Promise<boolean> {
  const sink = capture.sink;
  if (!sink) return false;
  const closed = await settleOverflowOperation(() => closeOverflowSink(sink));
  if (closed.isErr()) return propagateOverflowPanic(capture, closed.error);
  const closeResult = closed.value;
  if (closeResult.isErr()) {
    await disableOverflowCapture(capture, closeResult.error);
    return false;
  }
  capture.sink = undefined;
  return true;
}

async function writeOverflowChunk(
  capture: OverflowCapture,
  chunk: Uint8Array,
): Promise<ResultType<void, SshOverflowOperationError>> {
  if (chunk.byteLength === 0 || capture.disabled) return Result.ok();
  if (!capture.sink) {
    const opened = await settleOverflowOperation(() => openOverflowSink(capture.target));
    if (opened.isErr()) return propagateOverflowPanic(capture, opened.error);
    const openResult = opened.value;
    if (openResult.isErr()) return Result.err(openResult.error);
    capture.sink = openResult.value;
    capture.fileCreated = true;
  }
  const sink = capture.sink;
  const written = await settleOverflowOperation(() => writeOverflowSink(sink, chunk));
  return written.match({
    err: (panic) => async () => propagateOverflowPanic(capture, panic),
    ok: (result) => async () => result,
  })();
}

async function activateOverflowCapture(
  capture: OverflowCapture,
): Promise<ResultType<void, SshOverflowOperationError>> {
  for (const chunk of capture.bufferedRawChunks) {
    const written = await writeOverflowChunk(capture, chunk);
    const failure = written.match({ ok: () => null, err: (error) => Result.err(error) });
    if (failure) return failure;
  }
  capture.bufferedRawChunks.length = 0;
  return Result.ok();
}

function combineStreamReadAndCleanup(
  primary: ResultType<StreamTextResult, SshStreamReadError>,
  cleanup: ResultType<void, SshStreamCleanupError>,
): ResultType<StreamTextResult, SshStreamTextError> {
  return primary.match<ResultType<StreamTextResult, SshStreamTextError>>({
    ok: (value) => cleanup.map(() => value),
    err: (primaryError) =>
      cleanup.match<ResultType<StreamTextResult, SshStreamTextError>>({
        ok: () => Result.err(primaryError),
        err: (cleanupError) =>
          Result.err(
            new SshStreamReadAndCleanupError({
              primary: primaryError,
              cleanup: cleanupError,
              message: `${primaryError.message}; cleanup also failed: ${cleanupError.message}`,
            }),
          ),
      }),
  });
}

async function readReadableStreamTextCapped(
  stream: ReadableStream<Uint8Array>,
  maxChars: number,
  options?: { overflowFilePath?: string; onActivity?: () => void; stopSignal?: AbortSignal },
): Promise<ResultType<StreamTextResult, SshStreamTextError>> {
  const acquired = acquireStreamReader(stream);
  if (acquired.isErr()) return Result.err(acquired.error);
  const reader = acquired.value;
  let releaseAttempted = false;
  // A cancelled reader resolves its pending read as done, so the captured prefix is returned.
  const stopReading = () => cancelStreamReader(reader);
  if (options?.stopSignal?.aborted) stopReading();
  options?.stopSignal?.addEventListener("abort", stopReading, { once: true });
  const overflowCapture: OverflowCapture | undefined = options?.overflowFilePath
    ? {
        target: options.overflowFilePath,
        bufferedRawChunks: [],
        fileCreated: false,
        disabled: false,
      }
    : undefined;

  const capture = (async () => {
    const decoder = new TextDecoder();
    let text = "";
    let totalChars = 0;
    let capped = false;
    let overflowFilePath: string | undefined;

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
      if (read.isErr()) {
        if (overflowCapture) {
          const cleanup = await cleanupOverflowCapture(overflowCapture);
          cleanup.match({
            ok: () => undefined,
            err: (error) =>
              logger.debug("SSH overflow cleanup incomplete", formatTaggedErrorForLog(error)),
          });
        }
        primary = Result.err(read.error);
        break;
      }
      const { done, value } = read.value;
      if (done) {
        const tail = decoder.decode();
        if (tail.length > 0) {
          const consumed = await consumeChunkText(tail);
          const failure = consumed.match({ ok: () => null, err: (error) => error });
          if (failure && overflowCapture) await disableOverflowCapture(overflowCapture, failure);
        }
        if (overflowCapture && (await closeOverflowCapture(overflowCapture))) {
          overflowFilePath = overflowCapture.target;
        }
        primary = Result.ok({ text, totalChars, capped, overflowFilePath });
        break;
      }
      if (!value || value.byteLength === 0) continue;

      if (options?.onActivity) {
        const activity = reportStreamActivity(options.onActivity);
        const activityFailure = activity.match({ ok: () => null, err: (error) => error });
        if (activityFailure) {
          if (overflowCapture) {
            const cleanup = await cleanupOverflowCapture(overflowCapture);
            cleanup.match({
              ok: () => undefined,
              err: (error) =>
                logger.debug("SSH overflow cleanup incomplete", formatTaggedErrorForLog(error)),
            });
          }
          primary = Result.err(activityFailure);
          break;
        }
      }
      if (capped && overflowCapture) {
        const written = await writeOverflowChunk(overflowCapture, value);
        const failure = written.match({ ok: () => null, err: (error) => error });
        if (failure) await disableOverflowCapture(overflowCapture, failure);
      } else if (overflowCapture) {
        overflowCapture.bufferedRawChunks.push(Buffer.from(value));
      }
      const consumed = await consumeChunkText(decoder.decode(value, { stream: true }));
      const failure = consumed.match({ ok: () => null, err: (error) => error });
      if (failure && overflowCapture) await disableOverflowCapture(overflowCapture, failure);
    }

    releaseAttempted = true;
    return {
      status: "return",
      value: combineStreamReadAndCleanup(primary, releaseStreamReader(reader)),
    } as const;
  })();
  const outcome = await Result.tryPromise({ try: () => capture, catch: captureRuntimeError });
  const cleanup = await Result.tryPromise({
    try: async () => {
      // Only an unfinished sink belongs to this exceptional-exit cleanup.
      if (overflowCapture?.sink) await cleanupOverflowCaptureOutcome(overflowCapture);
      options?.stopSignal?.removeEventListener("abort", stopReading);
      if (!releaseAttempted) {
        const released = releaseStreamReader(reader);
        released.match({
          ok: () => undefined,
          err: (error) =>
            logger.debug("SSH stream reader cleanup failed", formatTaggedErrorForLog(error)),
        });
      }
    },
    catch: captureRuntimeError,
  });
  if (outcome.isErr()) {
    return adaptToolResultToHost(
      Result.err(projectCapturedRuntimeError(outcome.error, "SSH output capture failed")),
    );
  }
  if (cleanup.isErr()) {
    return adaptToolResultToHost(
      Result.err(projectCapturedRuntimeError(cleanup.error, "SSH output cleanup failed")),
    );
  }
  return outcome.value.value;
}

async function readBodyTextCapped(
  body: XMLHttpRequestBodyInit,
  maxChars: number,
  overflowFilePath?: string,
): Promise<ResultType<StreamTextResult, SshStreamReadError>> {
  const read = await readResponseBody(body);
  if (read.isErr()) return Result.err(read.error);
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
    const writeFailure = written.match({ ok: () => null, err: (error) => error });
    if (writeFailure) {
      await disableOverflowCapture(capture, writeFailure);
    } else if (await closeOverflowCapture(capture)) {
      retainedOverflowPath = overflowFilePath;
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
  options?: { overflowFilePath?: string; onActivity?: () => void; stopSignal?: AbortSignal },
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

/**
 * Shell fallback for hosts the native runner does not support. Core keeps stdin open while the call
 * runs and closes it to cancel, so the command gets `/dev/null` as stdin in both stdin modes, as it
 * did when the script itself was stdin. The whole script is one brace group: bash reads all of it
 * before running anything, which leaves nothing on stdin for the watcher to consume.
 */
export function buildRemoteScript(params: { cmd: string; cwd?: string }) {
  const fields = [params.cwd ?? "", params.cmd];
  const payload = Buffer.from(
    JSON.stringify(fields.map((field) => Buffer.from(field).toString("base64"))),
  ).toString("base64");
  return `{
set -euo pipefail
IFS='"' read -r _ CWD64 _ CMD64 _ <<< "$(printf '%s' '${payload}' | base64 -d)"
CWD=$(printf '%s' "$CWD64" | base64 -d)
TMP_CMD=$(mktemp)
trap 'rm -f "$TMP_CMD"' EXIT
printf '%s' "$CMD64" | base64 -d >"$TMP_CMD"
if [ "$CWD" = "~" ]; then
  CWD="$HOME"
elif [[ "$CWD" == "~/"* ]]; then
  CWD="$HOME/\${CWD:2}"
fi
if [ -n "$CWD" ] && ! cd -- "$CWD"; then
  echo "Remote cwd does not exist or is not a directory" >&2
  exit 1
fi
set -m
bash --noprofile --norc "$TMP_CMD" </dev/null &
JOB=$!
{ cat >/dev/null; trap '' TERM; kill -TERM -- "-$JOB" 2>/dev/null; sleep 2; kill -KILL -- "-$JOB" 2>/dev/null; } &
WATCHER=$!
# bash 3.2, the macOS /bin/bash, reports the watcher's termination on stderr unless it is disowned.
disown "$WATCHER"
CODE=0
wait "$JOB" 2>/dev/null || CODE=$?
kill -- "-$WATCHER" 2>/dev/null || true
exit "$CODE"
}
`;
}

function waitForSshExit(exit: Promise<number>): Promise<ResultType<number, SshExitWaitError>> {
  return captureSshPromise({
    run: () => exit,
    fallback: "Opaque SSH subprocess exit wait failure",
    mapError: (cause) =>
      new SshExitWaitError({
        cause,
        message: "Failed while waiting for the SSH subprocess to exit",
      }),
  });
}

function projectStreamCapture(
  streamName: "stdout" | "stderr",
  captured: ResultType<StreamTextResult, SshStreamTextError>,
): StreamTextResult {
  return captured.match({
    ok: (value) => value,
    err: (error) => {
      logger.debug(`SSH ${streamName} capture failed`, formatTaggedErrorForLog(error));
      return { text: "", totalChars: 0, capped: false };
    },
  });
}

type SshExecBashParams = {
  host: string;
  cmd: string;
  cwd?: string;
  /** Accepted for parity with local bash. Remote commands always read an empty stdin. */
  stdinMode?: SshBashStdinMode;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputChars: number;
  overflowOutputPath?: string;
  onActivity?: () => void;
};

export type SshExecBashResult = SshExecResult & {
  transportError?: { type: "hostkey" | "auth" | "connect" | "unknown"; message: string };
};

/** Deployment has no wall-clock limit from a call without a timeout, so it gets this one. */
const UNBOUNDED_CALL_DEPLOY_WAIT_MS = 2 * 60 * 1000;

function emptyExecResult(
  startedAt: number,
  overrides: Partial<SshExecBashResult>,
): SshExecBashResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: -1,
    durationMs: Date.now() - startedAt,
    timedOut: false,
    aborted: false,
    capped: { stdout: false, stderr: false },
    overflowPaths: {},
    ...overrides,
  };
}

function deployFailureResult(
  startedAt: number,
  failure: RemoteRunnerDeployFailure,
): SshExecBashResult {
  switch (failure.kind) {
    case "aborted":
      return emptyExecResult(startedAt, { aborted: true });
    case "timed_out":
      return emptyExecResult(startedAt, { timedOut: true });
    case "command":
      return emptyExecResult(startedAt, {
        stderr: failure.error.message,
        errors: { exitRead: failure.error.message },
      });
    case "ssh": {
      const { outcome } = failure;
      return emptyExecResult(startedAt, {
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        aborted: outcome.aborted,
        transportError: outcome.exitCode === 255 ? inferTransportError(outcome.stderr) : undefined,
      });
    }
  }
}

export async function sshExecBash(params: SshExecBashParams): Promise<SshExecBashResult> {
  const startedAt = Date.now();
  if (params.cwd !== undefined) normalizeRemoteCwd(params.cwd);
  await requireConfiguredSshHost(params.host);

  if (params.signal?.aborted) return emptyExecResult(startedAt, { aborted: true });
  const outcome = await runWithRunner(params, startedAt, (deployment) =>
    remoteJobInvocation(params, deployment),
  );
  return outcome.kind === "completed" ? outcome.result : emptyExecResult(startedAt, {});
}

export type SshRunnerCallOutcome =
  | { readonly kind: "completed"; readonly result: SshExecBashResult }
  | { readonly kind: "unsupported"; readonly reason: string }
  | { readonly kind: "rejected"; readonly message: string };

/**
 * Sends one request to the native runner and returns its raw output. Unlike `sshExecBash`, it
 * has no shell fallback: hosts without a runner report `unsupported`.
 */
export async function sshCallRunner(params: {
  readonly host: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly maxOutputChars: number;
}): Promise<SshRunnerCallOutcome> {
  const startedAt = Date.now();
  const configured = await requireConfiguredSshHostResult(params.host);
  const hostError = configured.match({ ok: () => null, err: (error) => error });
  if (hostError) return { kind: "rejected", message: hostError.message };
  if (params.signal?.aborted) {
    return { kind: "completed", result: emptyExecResult(startedAt, { aborted: true }) };
  }
  const requestLine = `${JSON.stringify(params.request)}\n`;
  return await runWithRunner(
    {
      host: params.host,
      cmd: "",
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      maxOutputChars: params.maxOutputChars,
    },
    startedAt,
    (deployment) =>
      deployment.kind === "runner"
        ? { remoteArgs: deployment.command, stdin: requestLine }
        : undefined,
  );
}

async function runWithRunner(
  params: SshExecBashParams,
  startedAt: number,
  invocationFor: (
    deployment: RemoteRunnerDeployment,
  ) => { readonly remoteArgs: readonly string[]; readonly stdin: string } | undefined,
): Promise<SshRunnerCallOutcome> {
  const deadline =
    params.timeoutMs === undefined
      ? startedAt + UNBOUNDED_CALL_DEPLOY_WAIT_MS
      : startedAt + params.timeoutMs;
  for (let attempt = 0; ; attempt++) {
    if (Date.now() >= deadline) {
      return { kind: "completed", result: emptyExecResult(startedAt, { timedOut: true }) };
    }
    const resolved = await resolveRemoteRunner({
      host: params.host,
      deadline,
      signal: params.signal,
    });
    if (resolved.isErr()) {
      return { kind: "completed", result: deployFailureResult(startedAt, resolved.error) };
    }
    const deployment = resolved.value;
    const invocation = invocationFor(deployment);
    if (!invocation) {
      return {
        kind: "unsupported",
        reason: deployment.kind === "unsupported" ? deployment.reason : "unsupported host",
      };
    }
    const token = crypto.randomUUID();
    const launch =
      deployment.kind === "runner"
        ? { ...invocation, remoteArgs: [...invocation.remoteArgs, token] }
        : invocation;
    const { result, wrapperExitCode } = await runRemoteJob(
      params,
      launch,
      startedAt,
      params.timeoutMs === undefined ? undefined : deadline,
    );
    if (
      attempt === 0 &&
      deployment.kind === "runner" &&
      runnerWentMissing(result, token, wrapperExitCode)
    ) {
      // The cached binary was removed after deployment, so the command never ran; redeploy once.
      invalidateRemoteRunner(params.host);
      continue;
    }
    return { kind: "completed", result };
  }
}

function runnerWentMissing(
  result: SshExecBashResult,
  token: string,
  wrapperExitCode: number | undefined,
): boolean {
  if (result.timedOut || result.aborted || wrapperExitCode !== 127) return false;
  return result.stderr.trim() === `${REMOTE_RUNNER_MISSING_MARKER}:${token}`;
}

function remoteJobInvocation(
  params: SshExecBashParams,
  deployment: RemoteRunnerDeployment,
): { readonly remoteArgs: readonly string[]; readonly stdin: string } {
  if (deployment.kind === "runner") {
    const request = { op: "exec", cwd: params.cwd ?? null, script: params.cmd };
    return { remoteArgs: deployment.command, stdin: `${JSON.stringify(request)}\n` };
  }
  return {
    remoteArgs: ["bash", "--noprofile", "--norc", "-s"],
    stdin: buildRemoteScript({ cmd: params.cmd, cwd: params.cwd }),
  };
}

async function closeJobStdin(
  child: ReturnType<typeof Bun.spawn> | null,
): Promise<ResultType<void, SshStreamCleanupError>> {
  const stdin = child?.stdin;
  if (!stdin || typeof stdin === "number") return Result.ok();
  return captureSshPromise({
    run: async () => {
      await stdin.end();
    },
    fallback: "Opaque SSH stdin close failure",
    mapError: (cause) =>
      new SshStreamCleanupError({
        operation: "close_stdin",
        cause,
        message: "Failed to close SSH stdin",
      }),
  });
}

async function writeJobRequest(
  child: ReturnType<typeof Bun.spawn>,
  text: string,
): Promise<ResultType<void, SshStreamCleanupError>> {
  const stdin = child.stdin;
  if (!stdin || typeof stdin === "number") {
    return Result.err(
      new SshStreamCleanupError({
        operation: "write_stdin",
        cause: undefined,
        message: "SSH stdin is not a pipe",
      }),
    );
  }
  return captureSshPromise({
    run: async () => {
      await stdin.write(text);
      await stdin.flush();
    },
    fallback: "Opaque SSH stdin write failure",
    mapError: (cause) =>
      new SshStreamCleanupError({
        operation: "write_stdin",
        cause,
        message: "Failed to send the remote command",
      }),
  });
}

async function runRemoteJob(
  params: SshExecBashParams,
  invocation: { readonly remoteArgs: readonly string[]; readonly stdin: string },
  startedAt: number,
  deadline: number | undefined,
): Promise<{ readonly result: SshExecBashResult; readonly wrapperExitCode?: number }> {
  let termination: "timeout" | "aborted" | "failed" | undefined;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let stdinFailure: SshStreamCleanupError | undefined;
  let stdinClose: ReturnType<typeof startStdinClose> | undefined;
  let wrapperExitCode: number | undefined;

  function startStdinClose() {
    return Result.tryPromise({ try: () => closeJobStdin(child), catch: captureRuntimeError });
  }

  const closeStdin = () => {
    if (!child) return undefined;
    stdinClose ??= startStdinClose();
    return stdinClose;
  };

  // Closing stdin asks the remote side to stop the job; the runner waits two seconds before SIGKILL.
  // Local escalation also covers helpers that survive after the SSH leader has exited.
  const LOCAL_TERM_DELAY_MS = 5000;
  const HARD_KILL_DELAY_MS = 2000;
  // An OpenSSH ControlMaster holds the client's stdio descriptors in its own session, so they can
  // stay open until the remote command ends even after the terminated client has exited.
  const OUTPUT_DRAIN_AFTER_TERMINATION_MS = 2000;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const schedule = (delayMs: number, run: () => void) => {
    const timer = setTimeout(run, delayMs);
    timer.unref?.();
    timers.push(timer);
  };
  // Cancellation owns this detached process group after its leader and capture have finished.
  // Keep escalation outside the execution timers, without keeping Core alive for the grace period.
  const scheduleGroupCleanup = (delayMs: number, run: () => void) => {
    const timer = setTimeout(run, delayMs);
    timer.unref?.();
  };
  let childExited = false;
  let groupHardKilled = false;
  let outputDrainScheduled = false;
  const outputStop = new AbortController();
  const scheduleOutputStop = () => {
    if (!termination || !childExited || outputDrainScheduled) return;
    outputDrainScheduled = true;
    schedule(OUTPUT_DRAIN_AFTER_TERMINATION_MS, () => {
      logger.debug("SSH output stayed open after the terminated client exited; stopping capture", {
        termination,
      });
      outputStop.abort();
    });
  };
  const signalLocalClient = (signal: "SIGTERM" | "SIGKILL") => {
    const pid = child?.pid;
    if (typeof pid !== "number" || pid <= 0 || groupHardKilled) return;
    if (signal === "SIGKILL") groupHardKilled = true;
    observeBestEffortProcessCleanup(killProcessGroupBestEffort(pid, signal));
  };

  const terminate = (reason: "timeout" | "aborted" | "failed") => {
    if (termination) return;
    termination = reason;
    closeStdin();
    scheduleGroupCleanup(LOCAL_TERM_DELAY_MS, () => {
      signalLocalClient("SIGTERM");
      scheduleGroupCleanup(HARD_KILL_DELAY_MS, () => signalLocalClient("SIGKILL"));
    });
    scheduleOutputStop();
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
  const checkDeadline = () => {
    if (deadline !== undefined && Date.now() >= deadline) terminate("timeout");
  };
  if (deadline !== undefined)
    schedule(Math.max(0, deadline - Date.now()), () => terminate("timeout"));
  const stopWatchingExecution = () => {
    abortListener?.();
    abortListener = null;
    if (termination) return;
    for (const timer of timers) clearTimeout(timer);
  };

  const outcome = await Result.tryPromise({
    try: async () => {
      checkDeadline();
      if (termination) {
        return {
          status: "return",
          value: emptyExecResult(startedAt, {
            aborted: termination === "aborted",
            timedOut: termination === "timeout",
          }),
        } as const;
      }
      const sshArgs = await buildSshArgs(params.host, invocation.remoteArgs);
      checkDeadline();
      if (termination) {
        return {
          status: "return",
          value: emptyExecResult(startedAt, {
            aborted: termination === "aborted",
            timedOut: termination === "timeout",
          }),
        } as const;
      }

      child = Bun.spawn(["ssh", ...sshArgs], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "pipe",
        detached: true,
        env: buildSshChildEnv(),
      });
      checkDeadline();
      if (termination) closeStdin();
      const requestWrite = termination
        ? Promise.resolve()
        : writeJobRequest(child, invocation.stdin).then((written) => {
            if (written.isErr()) {
              stdinFailure = written.error;
              terminate("failed");
            }
          });

      const [stdoutCapture, stderrCapture, exitResult] = await Promise.all([
        readStreamTextCapped(child.stdout, params.maxOutputChars, {
          overflowFilePath: params.overflowOutputPath
            ? `${params.overflowOutputPath}.stdout.part`
            : undefined,
          onActivity: params.onActivity,
          stopSignal: outputStop.signal,
        }),
        readStreamTextCapped(child.stderr, params.maxOutputChars, {
          overflowFilePath: params.overflowOutputPath
            ? `${params.overflowOutputPath}.stderr.part`
            : undefined,
          onActivity: params.onActivity,
          stopSignal: outputStop.signal,
        }),
        waitForSshExit(child.exited).then((exit) => {
          childExited = true;
          scheduleOutputStop();
          return exit;
        }),
        requestWrite,
      ]);
      stopWatchingExecution();
      const closed = await closeStdin();
      if (closed) {
        const closeResult = adaptToolResultToHost(
          closed.mapError((captured) =>
            projectCapturedRuntimeError(captured, "Opaque SSH stdin close failure"),
          ),
        );
        if (closeResult.isErr()) stdinFailure ??= closeResult.error;
      }

      const stdoutResult = projectStreamCapture("stdout", stdoutCapture);
      const stderrResult = projectStreamCapture("stderr", stderrCapture);
      const stdout = stdoutResult.text;
      const stderr = stderrResult.text;
      const exit = exitResult.match<{ readonly code: number; readonly readFailure?: string }>({
        ok: (code) => ({ code }),
        err: (error) => {
          logger.debug("SSH subprocess exit wait failed", formatTaggedErrorForLog(error));
          return { code: -1, readFailure: "exit status read failed" };
        },
      });
      const exitCode = stdinFailure ? -1 : exit.code;
      wrapperExitCode = exit.code;

      const transportError = exitCode === 255 ? inferTransportError(stderr) : undefined;

      return {
        status: "return",
        value: {
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
          errors: {
            stdoutRead: stdoutCapture.match({
              ok: () => undefined,
              err: (error) =>
                error._tag === "SshStreamReadError"
                  ? (error.detail ?? error.message)
                  : error.message,
            }),
            stderrRead: stderrCapture.match({
              ok: () => undefined,
              err: (error) =>
                error._tag === "SshStreamReadError"
                  ? (error.detail ?? error.message)
                  : error.message,
            }),
            exitRead: stdinFailure?.message ?? exit.readFailure,
          },
        },
      } as const;
    },
    catch: captureRuntimeError,
  });
  if (outcome.isErr()) {
    // Keep the original defect while EOF cancellation and bounded local escalation finish.
    await Result.tryPromise({
      try: async () => {
        terminate("failed");
        outputStop.abort();
        if (!child) return;
        await Promise.race([
          Promise.allSettled([child.exited, closeStdin()]),
          new Promise<void>((resolve) =>
            schedule(LOCAL_TERM_DELAY_MS + HARD_KILL_DELAY_MS, () => {
              signalLocalClient("SIGKILL");
              resolve();
            }),
          ),
        ]);
      },
      catch: captureRuntimeError,
    });
    stopWatchingExecution();
    for (const timer of timers) clearTimeout(timer);
    return adaptToolResultToHost(
      Result.err(projectCapturedRuntimeError(outcome.error, "SSH job failed")),
    );
  }
  stopWatchingExecution();
  for (const timer of timers) clearTimeout(timer);
  return { result: outcome.value.value, wrapperExitCode };
}
