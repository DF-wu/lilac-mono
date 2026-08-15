import {
  asSchema,
  parseJsonEventStream,
  uiMessageChunkSchema,
  type ChatTransport,
  type UIMessageChunk,
} from "ai";
import {
  Panic,
  Result,
  TaggedError,
  type AnyTaggedError,
  type Result as ResultType,
} from "better-result";
import { z } from "zod";

import {
  type MiniLilacCancelCompactionRequest,
  type MiniLilacCancelCompactionResult,
  type MiniLilacCancelRequest,
  type MiniLilacCancelResult,
  type MiniLilacChatRequestExtras,
  type MiniLilacCompactInput,
  type MiniLilacCompactionEvent,
  type MiniLilacCompactResult,
  type MiniLilacInterruptQueuedSteeringInput,
  type MiniLilacInterruptQueuedSteeringResult,
  type MiniLilacModelSummary,
  type MiniLilacProfileSummary,
  type MiniLilacRedoInput,
  type MiniLilacRedoResult,
  type MiniLilacSessionResume,
  type MiniLilacSessionSnapshot,
  type MiniLilacSkillSummary,
  type MiniLilacSteerRequest,
  type MiniLilacSteerResult,
  type MiniLilacStreamCursor,
  type MiniLilacTodoState,
  type MiniLilacUIMessage,
  type MiniLilacUnsupportedUIMessageChunk,
  type MiniLilacUndoInput,
  type MiniLilacUndoResult,
  type MiniLilacUpdateSessionBindingsInput,
  MINI_LILAC_UNSUPPORTED_UI_MESSAGE_CHUNK_TYPE,
  miniLilacCancelCompactionRequestSchema,
  miniLilacCancelCompactionResultSchema,
  miniLilacCancelRequestSchema,
  miniLilacCancelResultSchema,
  miniLilacChatRequestExtrasSchema,
  miniLilacCompactRequestSchema,
  miniLilacInterruptQueuedSteeringRequestSchema,
  miniLilacInterruptQueuedSteeringResultSchema,
  miniLilacMessagesSchema,
  miniLilacModelsSchema,
  miniLilacProfilesSchema,
  miniLilacRedoRequestSchema,
  miniLilacRedoResultSchema,
  miniLilacSessionResumeSchema,
  miniLilacSessionSnapshotSchema,
  miniLilacSessionsSchema,
  miniLilacSkillsSchema,
  miniLilacStreamCursorChunkSchema,
  miniLilacSteerRequestSchema,
  miniLilacSteerResultSchema,
  miniLilacTodoStateSchema,
  miniLilacUIMessageDataPartSchema,
  miniLilacUnsupportedUIMessageChunkSchema,
  miniLilacUndoRequestSchema,
  miniLilacUndoResultSchema,
  miniLilacUpdateSessionBindingsRequestSchema,
} from "./protocol";

export type MiniLilacBearerTokenResolver = () =>
  | string
  | null
  | undefined
  | PromiseLike<string | null | undefined>;

export type MiniLilacReconnectEndpoint =
  | string
  | ((input: { baseUrl: string; chatId: string }) => string);

export type MiniLilacTransportOptions = Omit<MiniLilacChatRequestExtras, "clientCommandId"> & {
  baseUrl?: string;
  bearerToken?: MiniLilacBearerTokenResolver;
  reconnectEndpoint?: MiniLilacReconnectEndpoint;
  headers?: Record<string, string> | Headers;
  credentials?: RequestCredentials;
  fetch?: typeof globalThis.fetch;
  createClientCommandId?: () => string;
};

export type MiniLilacRequestOptions = {
  signal?: AbortSignal;
};

export type MiniLilacSendMessagesOptions = Parameters<
  ChatTransport<MiniLilacUIMessage>["sendMessages"]
>[0];
export type MiniLilacReconnectOptions = Parameters<
  ChatTransport<MiniLilacUIMessage>["reconnectToStream"]
>[0];

export class MiniLilacBoundaryInvalid extends TaggedError("MiniLilacBoundaryInvalid")<{
  readonly boundary: string;
  readonly cause: z.ZodError;
  readonly issues: readonly string[];
  readonly message: string;
}> {}

export class MiniLilacExternalOperationFailed extends TaggedError(
  "MiniLilacExternalOperationFailed",
)<{
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class MiniLilacRequestCancelled extends TaggedError("MiniLilacRequestCancelled")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class MiniLilacHttpError extends TaggedError("MiniLilacHttpError")<{
  readonly operation: string;
  readonly status: number;
  readonly detail: string;
  readonly message: string;
}> {}

export class MiniLilacCompactionFailed extends TaggedError("MiniLilacCompactionFailed")<{
  readonly message: string;
}> {}

/** Returned by `compactResult()` when the compaction was deliberately stopped. */
export class MiniLilacCompactionCancelledError extends TaggedError(
  "MiniLilacCompactionCancelledError",
)<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "Context compaction was cancelled" });
  }
}

export class MiniLilacCompactionProtocolError extends TaggedError(
  "MiniLilacCompactionProtocolError",
)<{
  readonly message: string;
}> {}

export class MiniLilacStreamDecodeFailed extends TaggedError("MiniLilacStreamDecodeFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class MiniLilacStreamCleanupFailed extends TaggedError("MiniLilacStreamCleanupFailed")<{
  readonly cancelFailure: MiniLilacExternalOperationFailed | undefined;
  readonly releaseFailure: MiniLilacExternalOperationFailed | undefined;
  readonly message: string;
}> {}

type MiniLilacStreamPrimaryError =
  | MiniLilacStreamDecodeFailed
  | MiniLilacExternalOperationFailed
  | MiniLilacRequestCancelled;

export class MiniLilacStreamAndCleanupFailed extends TaggedError(
  "MiniLilacStreamAndCleanupFailed",
)<{
  readonly primary: MiniLilacStreamPrimaryError;
  readonly cleanup: MiniLilacStreamCleanupFailed;
  readonly message: string;
}> {}

type MiniLilacCompactionPrimaryError =
  | MiniLilacBoundaryInvalid
  | MiniLilacExternalOperationFailed
  | MiniLilacRequestCancelled
  | MiniLilacHttpError
  | MiniLilacCompactionFailed
  | MiniLilacCompactionCancelledError
  | MiniLilacCompactionProtocolError;

export class MiniLilacCompactionAndCleanupFailed extends TaggedError(
  "MiniLilacCompactionAndCleanupFailed",
)<{
  readonly primary: MiniLilacCompactionPrimaryError;
  readonly cleanup: MiniLilacStreamCleanupFailed;
  readonly message: string;
}> {}

export type MiniLilacRequestError =
  | MiniLilacBoundaryInvalid
  | MiniLilacExternalOperationFailed
  | MiniLilacRequestCancelled
  | MiniLilacHttpError;

export type MiniLilacCompactError =
  | MiniLilacCompactionPrimaryError
  | MiniLilacStreamCleanupFailed
  | MiniLilacCompactionAndCleanupFailed;

export type MiniLilacStreamError =
  | MiniLilacStreamPrimaryError
  | MiniLilacStreamCleanupFailed
  | MiniLilacStreamAndCleanupFailed;

export type MiniLilacResultStream = ReadableStream<
  ResultType<UIMessageChunk, MiniLilacStreamError>
>;

export type MiniLilacClientError = MiniLilacRequestError | MiniLilacCompactError;

function valueOrTaggedError<T, E extends AnyTaggedError>(result: ResultType<T, E>): T | E {
  return result.match<T | E>({
    ok: (value) => value,
    err: (error) => error,
  });
}

function isMiniLilacRequestError<T>(
  value: T | MiniLilacRequestError,
): value is MiniLilacRequestError {
  return (
    MiniLilacBoundaryInvalid.is(value) ||
    MiniLilacExternalOperationFailed.is(value) ||
    MiniLilacRequestCancelled.is(value) ||
    MiniLilacHttpError.is(value)
  );
}

export type MiniLilacCompactOptions = MiniLilacRequestOptions & {
  /** Receives every lifecycle event, including streamed summary text. */
  onEvent?: (event: MiniLilacCompactionEvent) => void;
  /** Receives session snapshots published while compaction runs. */
  onSession?: (snapshot: MiniLilacSessionSnapshot) => void;
};

const sessionIdSchema = z.string().trim().min(1);
const futureChunkEnvelopeSchema = z.object({
  type: z.string().min(1).max(128),
});
const installedUIMessageChunkSchema = asSchema(uiMessageChunkSchema);
const unsupportedChunkDiscriminantSchema = z.object({
  type: z.literal(MINI_LILAC_UNSUPPORTED_UI_MESSAGE_CHUNK_TYPE),
});
const dataChunkDiscriminantSchema = z.object({
  type: z.string().startsWith("data-"),
});
const rawDataChunkEnvelopeSchema = z.looseObject({
  type: z.string().startsWith("data-"),
  data: z.json(),
});
const compactionChunkDiscriminantSchema = z.object({ type: z.literal("data-compaction") });
const INSTALLED_NON_DATA_CHUNK_TYPES = new Set<string>([
  "text-start",
  "text-delta",
  "text-end",
  "error",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-available",
  "tool-input-error",
  "tool-approval-request",
  "tool-approval-response",
  "tool-output-available",
  "tool-output-error",
  "tool-output-denied",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "custom",
  "source-url",
  "source-document",
  "file",
  "reasoning-file",
  "start-step",
  "finish-step",
  "start",
  "finish",
  "abort",
  "message-metadata",
]);

function boundedIssues(error: z.ZodError): readonly string[] {
  return error.issues.slice(0, 20).map((issue) => {
    const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
    return `${path}: ${issue.message}`.slice(0, 256);
  });
}

/** Decodes values at Mini Lilac's HTTP and stream boundaries without throwing. */
export function decodeMiniLilacBoundary<T>(
  value: unknown,
  schema: z.ZodType<T>,
  boundary: string,
): ResultType<T, MiniLilacBoundaryInvalid> {
  const decoded = schema.safeParse(value);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new MiniLilacBoundaryInvalid({
      boundary,
      cause: decoded.error,
      issues: boundedIssues(decoded.error),
      message: `Invalid Mini Lilac ${boundary}`,
    }),
  );
}

type MiniLilacCapture<T, E> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "error"; readonly error: E }
  | { readonly kind: "panic"; readonly panic: Panic };

function cancellationCapture<T>(
  operation: string,
  signal: AbortSignal | undefined,
): MiniLilacCapture<T, MiniLilacRequestCancelled> | undefined {
  if (signal === undefined || !signal.aborted) return undefined;
  const reason: unknown = signal.reason;
  if (Panic.is(reason)) return { kind: "panic", panic: reason };
  return {
    kind: "error",
    error: new MiniLilacRequestCancelled({
      operation,
      cause: reason,
      message: `${operation} was cancelled`,
    }),
  };
}

function captureMiniLilacPromiseOutcome<T>(
  operation: string,
  effect: () => Promise<T>,
): Promise<MiniLilacCapture<T, MiniLilacExternalOperationFailed>>;
function captureMiniLilacPromiseOutcome<T>(
  operation: string,
  effect: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<MiniLilacCapture<T, MiniLilacExternalOperationFailed | MiniLilacRequestCancelled>>;
async function captureMiniLilacPromiseOutcome<T>(
  operation: string,
  effect: () => Promise<T>,
  signal?: AbortSignal,
): Promise<MiniLilacCapture<T, MiniLilacExternalOperationFailed | MiniLilacRequestCancelled>> {
  const cancellation = cancellationCapture<T>(operation, signal);
  if (cancellation !== undefined) return cancellation;
  try {
    return { kind: "ok", value: await effect() };
  } catch (cause) {
    if (Panic.is(cause)) return { kind: "panic", panic: cause };
    if (signal?.aborted && signal.reason === cause) {
      return {
        kind: "error",
        error: new MiniLilacRequestCancelled({
          operation,
          cause,
          message: `${operation} was cancelled`,
        }),
      };
    }
    return {
      kind: "error",
      error: new MiniLilacExternalOperationFailed({
        operation,
        cause,
        message: `${operation} failed`,
      }),
    };
  }
}

function captureMiniLilacSyncOutcome<T>(
  operation: string,
  effect: () => T,
): MiniLilacCapture<T, MiniLilacExternalOperationFailed> {
  try {
    return { kind: "ok", value: effect() };
  } catch (cause) {
    if (Panic.is(cause)) return { kind: "panic", panic: cause };
    return {
      kind: "error",
      error: new MiniLilacExternalOperationFailed({
        operation,
        cause,
        message: `${operation} failed`,
      }),
    };
  }
}

function throwMiniLilacPanic(panic: Panic): never {
  throw panic;
}

async function captureMiniLilacPromise<T>(
  operation: string,
  effect: () => Promise<T>,
  signal?: AbortSignal,
): Promise<ResultType<T, MiniLilacExternalOperationFailed | MiniLilacRequestCancelled>> {
  const captured = await captureMiniLilacPromiseOutcome(operation, effect, signal);
  switch (captured.kind) {
    case "ok":
      return Result.ok(captured.value);
    case "error":
      return Result.err(captured.error);
    case "panic":
      return throwMiniLilacPanic(captured.panic);
  }
}

function captureMiniLilacSync<T>(
  operation: string,
  effect: () => T,
): ResultType<T, MiniLilacExternalOperationFailed> {
  const captured = captureMiniLilacSyncOutcome(operation, effect);
  switch (captured.kind) {
    case "ok":
      return Result.ok(captured.value);
    case "error":
      return Result.err(captured.error);
    case "panic":
      return throwMiniLilacPanic(captured.panic);
  }
}

function resultToMiniLilacCompatibilityFailure(
  error: MiniLilacClientError | MiniLilacStreamError,
): never {
  switch (error._tag) {
    case "MiniLilacBoundaryInvalid":
      throw error.cause;
    case "MiniLilacExternalOperationFailed":
    case "MiniLilacRequestCancelled":
    case "MiniLilacStreamDecodeFailed":
      throw error.cause;
    case "MiniLilacHttpError":
    case "MiniLilacCompactionFailed":
    case "MiniLilacCompactionCancelledError":
    case "MiniLilacCompactionProtocolError":
    case "MiniLilacStreamCleanupFailed":
    case "MiniLilacCompactionAndCleanupFailed":
    case "MiniLilacStreamAndCleanupFailed":
      throw error;
  }
}

/** Converts a typed client Result to the package's legacy throwing API contract. */
function resultToMiniLilacClientValue<T>(result: ResultType<T, MiniLilacClientError>): T {
  const resolve = result.match<() => T>({
    ok: (value) => () => value,
    err: (error) => () => resultToMiniLilacCompatibilityFailure(error),
  });
  return resolve();
}

async function validateUnsupportedSentinelResult(
  sentinel: MiniLilacUnsupportedUIMessageChunk,
): Promise<ResultType<UIMessageChunk, MiniLilacStreamDecodeFailed>> {
  const validate = installedUIMessageChunkSchema.validate;
  if (validate === undefined) {
    return Result.err(
      new MiniLilacStreamDecodeFailed({
        cause: new Error("UI message chunk validation is unavailable"),
        message: "Mini Lilac event stream contained an invalid chunk",
      }),
    );
  }
  const captured = await captureMiniLilacPromiseOutcome(
    "Validate Mini Lilac unsupported stream chunk",
    async () => validate(sentinel),
  );
  if (captured.kind === "panic") return throwMiniLilacPanic(captured.panic);
  if (captured.kind === "error") {
    return Result.err(
      new MiniLilacStreamDecodeFailed({
        cause: captured.error,
        message: "Mini Lilac event stream contained an invalid chunk",
      }),
    );
  }
  if (captured.value.success) return Result.ok(captured.value.value);
  return Result.err(
    new MiniLilacStreamDecodeFailed({
      cause: captured.value.error,
      message: "Mini Lilac event stream contained an invalid chunk",
    }),
  );
}

async function normalizeStreamChunkResult(
  value: unknown,
): Promise<ResultType<UIMessageChunk, MiniLilacStreamDecodeFailed>> {
  if (unsupportedChunkDiscriminantSchema.safeParse(value).success) {
    const sentinel = miniLilacUnsupportedUIMessageChunkSchema.safeParse(value);
    if (!sentinel.success) {
      return Result.err(
        new MiniLilacStreamDecodeFailed({
          cause: sentinel.error,
          message: "Mini Lilac event stream contained an invalid chunk",
        }),
      );
    }
    return validateUnsupportedSentinelResult(sentinel.data);
  }

  if (dataChunkDiscriminantSchema.safeParse(value).success) {
    const dataEnvelope = rawDataChunkEnvelopeSchema.safeParse(value);
    if (!dataEnvelope.success) {
      return Result.err(
        new MiniLilacStreamDecodeFailed({
          cause: dataEnvelope.error,
          message: "Mini Lilac event stream contained an invalid chunk",
        }),
      );
    }
  }

  const validate = installedUIMessageChunkSchema.validate;
  if (validate === undefined) {
    return Result.err(
      new MiniLilacStreamDecodeFailed({
        cause: new Error("UI message chunk validation is unavailable"),
        message: "Mini Lilac event stream contained an invalid chunk",
      }),
    );
  }
  const captured = await captureMiniLilacPromiseOutcome(
    "Validate Mini Lilac stream chunk",
    async () => validate(value),
  );
  if (captured.kind === "panic") return throwMiniLilacPanic(captured.panic);
  if (captured.kind === "error") {
    return Result.err(
      new MiniLilacStreamDecodeFailed({
        cause: captured.error,
        message: "Mini Lilac event stream contained an invalid chunk",
      }),
    );
  }
  if (captured.value.success) return Result.ok(captured.value.value);

  const envelope = futureChunkEnvelopeSchema.safeParse(value);
  if (
    envelope.success &&
    !envelope.data.type.startsWith("data-") &&
    !INSTALLED_NON_DATA_CHUNK_TYPES.has(envelope.data.type)
  ) {
    const sentinel = miniLilacUnsupportedUIMessageChunkSchema.safeParse({
      type: MINI_LILAC_UNSUPPORTED_UI_MESSAGE_CHUNK_TYPE,
      data: { chunkType: envelope.data.type },
      transient: true,
    });
    if (!sentinel.success) {
      return Result.err(
        new MiniLilacStreamDecodeFailed({
          cause: sentinel.error,
          message: "Mini Lilac event stream contained an invalid chunk",
        }),
      );
    }
    return validateUnsupportedSentinelResult(sentinel.data);
  }

  return Result.err(
    new MiniLilacStreamDecodeFailed({
      cause: captured.value.error,
      message: "Mini Lilac event stream contained an invalid chunk",
    }),
  );
}

type MiniLilacParsedStream = {
  readonly stream: ReadableStream<UIMessageChunk>;
  readonly cleanupSource: (
    cancelEffect?: () => Promise<void>,
  ) => Promise<ResultType<void, MiniLilacExternalOperationFailed>>;
};

function parseMiniLilacStream(
  stream: ReadableStream<Uint8Array<ArrayBufferLike>>,
): MiniLilacParsedStream {
  const sourceReader = stream.getReader();
  let sourceReleased = false;
  let sourceFinished = false;
  let sourceCleanup: Promise<ResultType<void, MiniLilacExternalOperationFailed>> | undefined;
  const releaseSource = () => {
    if (sourceReleased) return;
    sourceReleased = true;
    sourceReader.releaseLock();
  };
  const cleanupSource = (
    cancelEffect: () => Promise<void> = () => sourceReader.cancel(),
  ): Promise<ResultType<void, MiniLilacExternalOperationFailed>> => {
    if (sourceCleanup !== undefined) return sourceCleanup;
    const cleanup = (async () => {
      if (sourceFinished) return Result.ok(undefined);
      const cancelled = await captureMiniLilacPromiseOutcome(
        "Cancel Mini Lilac response body",
        cancelEffect,
      );
      sourceFinished = true;
      const released = captureMiniLilacSyncOutcome(
        "Release Mini Lilac response body reader",
        releaseSource,
      );
      if (released.kind === "panic") return throwMiniLilacPanic(released.panic);
      if (cancelled.kind === "panic") return throwMiniLilacPanic(cancelled.panic);
      if (released.kind === "error") return Result.err(released.error);
      if (cancelled.kind === "error") return Result.err(cancelled.error);
      return Result.ok(undefined);
    })();
    sourceCleanup = cleanup;
    return cleanup;
  };
  const proxy = new ReadableStream<Uint8Array<ArrayBufferLike>>({
    async pull(controller) {
      try {
        const read = await sourceReader.read();
        if (read.done) {
          sourceFinished = true;
          releaseSource();
          controller.close();
          return;
        }
        controller.enqueue(read.value);
      } catch (cause) {
        sourceFinished = true;
        releaseSource();
        controller.error(cause);
      }
    },
    async cancel(reason) {
      const cleanup = await cleanupSource(() => sourceReader.cancel(reason));
      const finish = cleanup.match<() => void>({
        ok: () => () => undefined,
        err: (error) => () => resultToMiniLilacCompatibilityFailure(error),
      });
      return finish();
    },
  });
  const parsed = parseJsonEventStream({ stream: proxy, schema: z.json() }).pipeThrough(
    new TransformStream({
      async transform(result, controller) {
        if (!result.success) {
          controller.error(
            new MiniLilacStreamDecodeFailed({
              cause: result.error,
              message: "Mini Lilac event stream contained malformed JSON",
            }),
          );
          return;
        }
        const normalized = await normalizeStreamChunkResult(result.value);
        const resolved = normalized.match<
          { readonly value: UIMessageChunk } | { readonly error: MiniLilacStreamError }
        >({
          ok: (value) => ({ value }),
          err: (error) => ({ error }),
        });
        if ("error" in resolved) controller.error(resolved.error);
        else controller.enqueue(resolved.value);
      },
    }),
  );
  return { stream: parsed, cleanupSource };
}

async function cleanupMiniLilacStreamReader(
  reader: ReadableStreamDefaultReader<UIMessageChunk>,
  cancelEffect: (() => Promise<void>) | undefined,
  primaryPanic: Panic | undefined,
  cleanupSource?: MiniLilacParsedStream["cleanupSource"],
): Promise<ResultType<void, MiniLilacStreamCleanupFailed>> {
  let cancelFailure: MiniLilacExternalOperationFailed | undefined;
  let cancelPanic: Panic | undefined;
  if (cancelEffect !== undefined) {
    const cancelled = await captureMiniLilacPromiseOutcome(
      "Cancel Mini Lilac stream reader",
      cancelEffect,
    );
    if (cancelled.kind === "panic") cancelPanic = cancelled.panic;
    else if (cancelled.kind === "error") cancelFailure = cancelled.error;
  }

  if (cleanupSource !== undefined) {
    const cleaned = await captureMiniLilacPromiseOutcome(
      "Clean up Mini Lilac response body",
      cleanupSource,
    );
    if (cleaned.kind === "panic") {
      cancelPanic ??= cleaned.panic;
    } else if (cleaned.kind === "error") {
      cancelFailure = cleaned.error;
    } else {
      cleaned.value.match({
        ok: () => undefined,
        err: (error) => {
          cancelFailure = error;
        },
      });
    }
  }

  let releaseFailure: MiniLilacExternalOperationFailed | undefined;
  let releasePanic: Panic | undefined;
  const released = captureMiniLilacSyncOutcome("Release Mini Lilac stream reader", () =>
    reader.releaseLock(),
  );
  if (released.kind === "panic") releasePanic = released.panic;
  else if (released.kind === "error") releaseFailure = released.error;

  if (primaryPanic !== undefined) return throwMiniLilacPanic(primaryPanic);
  if (cancelPanic !== undefined) return throwMiniLilacPanic(cancelPanic);
  if (releasePanic !== undefined) return throwMiniLilacPanic(releasePanic);
  if (cancelFailure === undefined && releaseFailure === undefined) return Result.ok(undefined);
  return Result.err(
    new MiniLilacStreamCleanupFailed({
      cancelFailure,
      releaseFailure,
      message: "Mini Lilac stream cleanup failed",
    }),
  );
}

async function captureMiniLilacStreamRead(
  reader: ReadableStreamDefaultReader<UIMessageChunk>,
  signal: AbortSignal | undefined,
): Promise<
  MiniLilacCapture<
    Awaited<ReturnType<ReadableStreamDefaultReader<UIMessageChunk>["read"]>>,
    MiniLilacStreamDecodeFailed | MiniLilacExternalOperationFailed | MiniLilacRequestCancelled
  >
> {
  const operation = "Read Mini Lilac event stream";
  const cancellation = cancellationCapture<
    Awaited<ReturnType<ReadableStreamDefaultReader<UIMessageChunk>["read"]>>
  >(operation, signal);
  if (cancellation !== undefined) return cancellation;
  try {
    return { kind: "ok", value: await reader.read() };
  } catch (cause) {
    if (Panic.is(cause)) return { kind: "panic", panic: cause };
    if (cause instanceof MiniLilacStreamDecodeFailed) return { kind: "error", error: cause };
    if (signal?.aborted && signal.reason === cause) {
      return {
        kind: "error",
        error: new MiniLilacRequestCancelled({
          operation,
          cause,
          message: `${operation} was cancelled`,
        }),
      };
    }
    return {
      kind: "error",
      error: new MiniLilacExternalOperationFailed({
        operation,
        cause,
        message: `${operation} failed`,
      }),
    };
  }
}

function combineStreamAndCleanupFailure(
  primary: MiniLilacStreamPrimaryError,
  cleanup: ResultType<void, MiniLilacStreamCleanupFailed>,
): MiniLilacStreamError {
  return cleanup.match<MiniLilacStreamError>({
    ok: () => primary,
    err: (error) =>
      new MiniLilacStreamAndCleanupFailed({
        primary,
        cleanup: error,
        message: "Mini Lilac stream and cleanup both failed",
      }),
  });
}

function resultStreamFromMiniLilacStream(
  parsed: MiniLilacParsedStream,
  signal?: AbortSignal,
): MiniLilacResultStream {
  const reader = parsed.stream.getReader();
  let terminal = false;

  return new ReadableStream({
    async pull(controller) {
      if (terminal) return;
      const read = await captureMiniLilacStreamRead(reader, signal);
      if (read.kind === "panic") {
        terminal = true;
        await cleanupMiniLilacStreamReader(
          reader,
          () => reader.cancel(),
          read.panic,
          parsed.cleanupSource,
        );
        return;
      }

      if (read.kind === "error") {
        terminal = true;
        const cleanup = await cleanupMiniLilacStreamReader(
          reader,
          undefined,
          undefined,
          parsed.cleanupSource,
        );
        controller.enqueue(Result.err(combineStreamAndCleanupFailure(read.error, cleanup)));
        controller.close();
        return;
      }
      if (read.value.done) {
        terminal = true;
        const cleanup = await cleanupMiniLilacStreamReader(
          reader,
          undefined,
          undefined,
          parsed.cleanupSource,
        );
        cleanup.match({
          ok: () => undefined,
          err: (error) => controller.enqueue(Result.err(error)),
        });
        controller.close();
        return;
      }
      controller.enqueue(Result.ok(read.value.value));
    },
    async cancel(reason) {
      if (terminal) return;
      terminal = true;
      const cleanup = await cleanupMiniLilacStreamReader(
        reader,
        () => reader.cancel(reason),
        undefined,
        parsed.cleanupSource,
      );
      const finish = cleanup.match<() => void>({
        ok: () => () => undefined,
        err: (error) => () => resultToMiniLilacCompatibilityFailure(error),
      });
      return finish();
    },
  });
}

function resultStreamToLegacyStream(stream: MiniLilacResultStream): ReadableStream<UIMessageChunk> {
  const reader = stream.getReader();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };

  return new ReadableStream({
    async pull(controller) {
      const read = await reader.read();
      if (read.done) {
        release();
        controller.close();
        return;
      }
      const apply = read.value.match<() => void>({
        ok: (value) => () => controller.enqueue(value),
        err: (error) => () => {
          release();
          return resultToMiniLilacCompatibilityFailure(error);
        },
      });
      apply();
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function joinUrl(baseUrl: string, endpoint: string): string {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(endpoint)) return endpoint;
  const path = endpoint.replace(/^\/+/, "");
  return baseUrl.length === 0 ? `/${path}` : `${baseUrl}/${path}`;
}

function defaultClientCommandId(): string {
  return globalThis.crypto.randomUUID();
}

function setQueryParameter(url: string, name: string, value: string): string {
  const hashIndex = url.indexOf("#");
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
  const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf("?");
  const path = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : withoutHash.slice(queryIndex + 1);
  const params = new URLSearchParams(query);
  params.set(name, value);
  return `${path}?${params.toString()}${hash}`;
}

function httpError(operation: string, response: Response, detail: string): MiniLilacHttpError {
  return new MiniLilacHttpError({
    operation,
    status: response.status,
    detail,
    message:
      detail.length > 0
        ? `MiniLilac request failed (${response.status}): ${detail}`
        : `MiniLilac request failed (${response.status})`,
  });
}

export class MiniLilacTransport implements ChatTransport<MiniLilacUIMessage> {
  private readonly baseUrl: string;
  private readonly bearerToken: MiniLilacBearerTokenResolver | undefined;
  private readonly credentials: RequestCredentials | undefined;
  private readonly fetch: typeof globalThis.fetch;
  private readonly headers: Record<string, string> | Headers | undefined;
  private readonly createClientCommandId: () => string;
  private readonly reconnectEndpoint: MiniLilacReconnectEndpoint | undefined;
  private chatExtras: Omit<MiniLilacChatRequestExtras, "clientCommandId">;
  private bindingUpdateChain: Promise<void> = Promise.resolve();
  private readonly lastStreamCursor = new Map<string, MiniLilacStreamCursor>();
  private readonly streamGenerations = new Map<string, number>();

  constructor(options: MiniLilacTransportOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "/api/mini-lilac");
    this.bearerToken = options.bearerToken;
    this.credentials = options.credentials;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.headers = options.headers;
    this.reconnectEndpoint = options.reconnectEndpoint;
    this.createClientCommandId = options.createClientCommandId ?? defaultClientCommandId;

    this.chatExtras = resultToMiniLilacClientValue(
      decodeMiniLilacBoundary(
        {
          cwd: options.cwd,
          model: options.model,
          profile: options.profile,
          reasoning: options.reasoning,
        },
        miniLilacChatRequestExtrasSchema,
        "transport options",
      ),
    );
  }

  async sendMessages(
    options: MiniLilacSendMessagesOptions,
  ): Promise<ReadableStream<UIMessageChunk>> {
    const result = await this.sendMessagesResult(options);
    return resultStreamToLegacyStream(resultToMiniLilacClientValue(result));
  }

  async sendMessagesResult(
    options: MiniLilacSendMessagesOptions,
  ): Promise<ResultType<MiniLilacResultStream, MiniLilacRequestError>> {
    const generation = (this.streamGenerations.get(options.chatId) ?? 0) + 1;
    this.streamGenerations.set(options.chatId, generation);
    const requestExtras = decodeMiniLilacBoundary(
      { ...this.chatExtras, ...options.body },
      miniLilacChatRequestExtrasSchema,
      "chat request extras",
    );
    const requestExtrasOutcome = requestExtras.match<
      | { readonly value: z.output<typeof miniLilacChatRequestExtrasSchema> }
      | { readonly error: MiniLilacBoundaryInvalid }
    >({
      ok: (value) => ({ value }),
      err: (error) => ({ error }),
    });
    if ("error" in requestExtrasOutcome) return Result.err(requestExtrasOutcome.error);
    const requestExtrasValue = requestExtrasOutcome.value;

    const headers = await this.createHeadersResult(true, options.headers);
    const headersValue = valueOrTaggedError(headers);
    if (isMiniLilacRequestError(headersValue)) return Result.err(headersValue);
    const commandId = captureMiniLilacSync("Create Mini Lilac command ID", () =>
      requestExtrasValue.clientCommandId === undefined
        ? this.createClientCommandId()
        : requestExtrasValue.clientCommandId,
    );
    const commandIdValue = valueOrTaggedError(commandId);
    if (MiniLilacExternalOperationFailed.is(commandIdValue)) return Result.err(commandIdValue);
    const decodedCommandId = decodeMiniLilacBoundary(
      commandIdValue,
      sessionIdSchema,
      "chat command ID",
    );
    const decodedCommandIdValue = valueOrTaggedError(decodedCommandId);
    if (MiniLilacBoundaryInvalid.is(decodedCommandIdValue))
      return Result.err(decodedCommandIdValue);
    const body = requestExtras.andThen((serializedExtras) =>
      decodedCommandId.andThen((serializedCommandId) =>
        captureMiniLilacSync("Serialize Mini Lilac chat request", () =>
          JSON.stringify({
            ...serializedExtras,
            id: options.chatId,
            messages: options.messages,
            trigger: options.trigger,
            messageId: options.messageId,
            clientCommandId: serializedCommandId,
          }),
        ),
      ),
    );
    const bodyValue = valueOrTaggedError(body);
    if (isMiniLilacRequestError(bodyValue)) return Result.err(bodyValue);

    const response = await captureMiniLilacPromise(
      "Send Mini Lilac chat request",
      () =>
        this.fetch(joinUrl(this.baseUrl, "chat"), {
          method: "POST",
          body: bodyValue,
          credentials: this.credentials,
          headers: headersValue,
          signal: options.abortSignal,
        }),
      options.abortSignal,
    );
    const responseValue = valueOrTaggedError(response);
    if (isMiniLilacRequestError(responseValue)) return Result.err(responseValue);
    const stream = await this.responseStreamResult(responseValue, "Send Mini Lilac chat request");
    const streamValue = valueOrTaggedError(stream);
    if (isMiniLilacRequestError(streamValue)) return Result.err(streamValue);
    this.lastStreamCursor.delete(options.chatId);
    return Result.ok(
      this.trackResultStream(
        options.chatId,
        generation,
        resultStreamFromMiniLilacStream(streamValue, options.abortSignal),
      ),
    );
  }

  async reconnectToStream(
    options: MiniLilacReconnectOptions,
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const result = resultToMiniLilacClientValue(await this.reconnectToStreamResult(options));
    return result === null ? null : resultStreamToLegacyStream(result);
  }

  async reconnectToStreamResult(
    options: MiniLilacReconnectOptions,
  ): Promise<ResultType<MiniLilacResultStream | null, MiniLilacRequestError>> {
    const endpointResult = this.resolveReconnectEndpointResult(
      this.reconnectEndpoint,
      options.chatId,
    );
    const endpointValue = valueOrTaggedError(endpointResult);
    if (isMiniLilacRequestError(endpointValue)) return Result.err(endpointValue);
    let endpoint = endpointValue;
    const cursor = this.getLastStreamCursor(options.chatId);
    if (cursor !== undefined) {
      endpoint = setQueryParameter(endpoint, "runId", cursor.runId);
      endpoint = setQueryParameter(endpoint, "after", String(cursor.seq));
    }
    const headers = await this.createHeadersResult(false, options.headers);
    const headersValue = valueOrTaggedError(headers);
    if (isMiniLilacRequestError(headersValue)) return Result.err(headersValue);
    const response = await captureMiniLilacPromise("Reconnect Mini Lilac stream", () =>
      this.fetch(endpoint, {
        method: "GET",
        credentials: this.credentials,
        headers: headersValue,
      }),
    );
    const responseValue = valueOrTaggedError(response);
    if (isMiniLilacRequestError(responseValue)) return Result.err(responseValue);
    if (responseValue.status === 204) return Result.ok(null);
    const stream = await this.responseStreamResult(responseValue, "Reconnect Mini Lilac stream");
    const streamValue = valueOrTaggedError(stream);
    if (isMiniLilacRequestError(streamValue)) return Result.err(streamValue);
    return Result.ok(
      this.trackResultStream(
        options.chatId,
        this.streamGenerations.get(options.chatId) ?? 0,
        resultStreamFromMiniLilacStream(streamValue),
      ),
    );
  }

  getLastStreamCursor(chatId: string): MiniLilacStreamCursor | undefined {
    return this.lastStreamCursor.get(chatId);
  }

  async getSession(
    sessionId: string,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacSessionSnapshot> {
    return resultToMiniLilacClientValue(await this.getSessionResult(sessionId, options));
  }

  getSessionResult(
    sessionId: string,
    options: MiniLilacRequestOptions = {},
  ): Promise<ResultType<MiniLilacSessionSnapshot, MiniLilacRequestError>> {
    return this.requestSessionJsonResult(sessionId, "", miniLilacSessionSnapshotSchema, options);
  }

  async getSessionResume(
    sessionId: string,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacSessionResume> {
    return resultToMiniLilacClientValue(await this.getSessionResumeResult(sessionId, options));
  }

  getSessionResumeResult(
    sessionId: string,
    options: MiniLilacRequestOptions = {},
  ): Promise<ResultType<MiniLilacSessionResume, MiniLilacRequestError>> {
    return this.requestSessionJsonResult(
      sessionId,
      "/resume",
      miniLilacSessionResumeSchema,
      options,
    );
  }

  setReconnectCursor(
    chatId: string,
    cursor: { readonly runId: string; readonly afterSeq: number } | null,
  ): void {
    if (cursor === null) {
      this.lastStreamCursor.delete(chatId);
      return;
    }
    this.lastStreamCursor.set(chatId, { runId: cursor.runId, seq: cursor.afterSeq });
  }

  async listSessions(
    cwd: string,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacSessionSnapshot[]> {
    return resultToMiniLilacClientValue(await this.listSessionsResult(cwd, options));
  }

  listSessionsResult(
    cwd: string,
    options: MiniLilacRequestOptions = {},
  ): Promise<ResultType<MiniLilacSessionSnapshot[], MiniLilacRequestError>> {
    const normalizedCwd = decodeMiniLilacBoundary(cwd, sessionIdSchema, "sessions cwd");
    const normalizedCwdValue = valueOrTaggedError(normalizedCwd);
    if (MiniLilacBoundaryInvalid.is(normalizedCwdValue)) {
      return Promise.resolve(Result.err(normalizedCwdValue));
    }
    return this.requestJsonResult(
      `sessions?cwd=${encodeURIComponent(normalizedCwdValue)}`,
      miniLilacSessionsSchema,
      { signal: options.signal },
      "List Mini Lilac sessions",
    );
  }

  async getMessages(
    sessionId: string,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacUIMessage[]> {
    return resultToMiniLilacClientValue(await this.getMessagesResult(sessionId, options));
  }

  getMessagesResult(
    sessionId: string,
    options: MiniLilacRequestOptions = {},
  ): Promise<ResultType<MiniLilacUIMessage[], MiniLilacRequestError>> {
    return this.requestSessionJsonResult(sessionId, "/messages", miniLilacMessagesSchema, options);
  }

  async streamSession(
    sessionId: string,
    options: MiniLilacRequestOptions = {},
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const result = resultToMiniLilacClientValue(await this.streamSessionResult(sessionId, options));
    return result === null ? null : resultStreamToLegacyStream(result);
  }

  async streamSessionResult(
    sessionId: string,
    options: MiniLilacRequestOptions = {},
  ): Promise<ResultType<MiniLilacResultStream | null, MiniLilacRequestError>> {
    const id = decodeMiniLilacBoundary(sessionId, sessionIdSchema, "session ID");
    const idValue = valueOrTaggedError(id);
    if (MiniLilacBoundaryInvalid.is(idValue)) return Result.err(idValue);
    const headers = await this.createHeadersResult(false);
    const headersValue = valueOrTaggedError(headers);
    if (isMiniLilacRequestError(headersValue)) return Result.err(headersValue);
    const operation = "Stream Mini Lilac session";
    const response = await captureMiniLilacPromise(
      operation,
      () =>
        this.fetch(joinUrl(this.baseUrl, `chat/${encodeURIComponent(idValue)}/stream`), {
          credentials: this.credentials,
          headers: headersValue,
          signal: options.signal,
        }),
      options.signal,
    );
    const responseValue = valueOrTaggedError(response);
    if (isMiniLilacRequestError(responseValue)) return Result.err(responseValue);
    if (responseValue.status === 204) return Result.ok(null);
    const stream = await this.responseStreamResult(responseValue, operation);
    const streamValue = valueOrTaggedError(stream);
    if (isMiniLilacRequestError(streamValue)) return Result.err(streamValue);
    return Result.ok(resultStreamFromMiniLilacStream(streamValue, options.signal));
  }

  async getTodos(
    sessionId: string,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacTodoState> {
    return resultToMiniLilacClientValue(await this.getTodosResult(sessionId, options));
  }

  getTodosResult(
    sessionId: string,
    options: MiniLilacRequestOptions = {},
  ): Promise<ResultType<MiniLilacTodoState, MiniLilacRequestError>> {
    return this.requestSessionJsonResult(sessionId, "/todos", miniLilacTodoStateSchema, options);
  }

  async listModels(options: MiniLilacRequestOptions = {}): Promise<MiniLilacModelSummary[]> {
    return resultToMiniLilacClientValue(await this.listModelsResult(options));
  }

  listModelsResult(
    options: MiniLilacRequestOptions = {},
  ): Promise<ResultType<MiniLilacModelSummary[], MiniLilacRequestError>> {
    return this.requestJsonResult(
      "models",
      miniLilacModelsSchema,
      { signal: options.signal },
      "List Mini Lilac models",
    );
  }

  async listProfiles(options: MiniLilacRequestOptions = {}): Promise<MiniLilacProfileSummary[]> {
    return resultToMiniLilacClientValue(await this.listProfilesResult(options));
  }

  listProfilesResult(
    options: MiniLilacRequestOptions = {},
  ): Promise<ResultType<MiniLilacProfileSummary[], MiniLilacRequestError>> {
    return this.requestJsonResult(
      "profiles",
      miniLilacProfilesSchema,
      { signal: options.signal },
      "List Mini Lilac profiles",
    );
  }

  async listSkills(
    cwd: string,
    profile?: string,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacSkillSummary[]> {
    return resultToMiniLilacClientValue(await this.listSkillsResult(cwd, profile, options));
  }

  listSkillsResult(
    cwd: string,
    profile?: string,
    options: MiniLilacRequestOptions = {},
  ): Promise<ResultType<MiniLilacSkillSummary[], MiniLilacRequestError>> {
    const normalizedCwd = decodeMiniLilacBoundary(cwd, sessionIdSchema, "skills cwd");
    const normalizedCwdValue = valueOrTaggedError(normalizedCwd);
    if (MiniLilacBoundaryInvalid.is(normalizedCwdValue)) {
      return Promise.resolve(Result.err(normalizedCwdValue));
    }
    let normalizedProfile: ResultType<string | undefined, MiniLilacBoundaryInvalid> =
      Result.ok(undefined);
    if (profile !== undefined) {
      normalizedProfile = decodeMiniLilacBoundary(profile, sessionIdSchema, "skills profile");
    }
    const normalizedProfileValue = valueOrTaggedError(normalizedProfile);
    if (MiniLilacBoundaryInvalid.is(normalizedProfileValue)) {
      return Promise.resolve(Result.err(normalizedProfileValue));
    }
    const params = new URLSearchParams({ cwd: normalizedCwdValue });
    if (normalizedProfileValue !== undefined) params.set("profile", normalizedProfileValue);
    return this.requestJsonResult(
      `skills?${params.toString()}`,
      miniLilacSkillsSchema,
      { signal: options.signal },
      "List Mini Lilac skills",
    );
  }

  setSessionBindings(bindings: {
    readonly model?: string;
    readonly profile?: string;
    readonly reasoning?: MiniLilacChatRequestExtras["reasoning"];
  }): void {
    this.chatExtras = resultToMiniLilacClientValue(
      decodeMiniLilacBoundary(
        { ...this.chatExtras, ...bindings },
        miniLilacChatRequestExtrasSchema,
        "session bindings",
      ),
    );
  }

  async updateSessionBindings(
    request: MiniLilacUpdateSessionBindingsInput,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacSessionSnapshot> {
    return resultToMiniLilacClientValue(await this.updateSessionBindingsResult(request, options));
  }

  updateSessionBindingsResult(
    request: MiniLilacUpdateSessionBindingsInput,
    options: MiniLilacRequestOptions = {},
  ): Promise<ResultType<MiniLilacSessionSnapshot, MiniLilacRequestError>> {
    const operation = this.bindingUpdateChain.then(() =>
      this.performSessionBindingUpdateResult(request, options),
    );
    this.bindingUpdateChain = operation.then(() => undefined);
    return operation;
  }

  async steer(
    request: MiniLilacSteerRequest,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacSteerResult> {
    return resultToMiniLilacClientValue(await this.steerResult(request, options));
  }

  steerResult(
    request: MiniLilacSteerRequest,
    options: MiniLilacRequestOptions = {},
  ): Promise<ResultType<MiniLilacSteerResult, MiniLilacRequestError>> {
    return this.postGeneratedControlResult(
      request,
      miniLilacSteerRequestSchema,
      "steer",
      miniLilacSteerResultSchema,
      options,
    );
  }

  async interruptQueuedSteering(
    request: MiniLilacInterruptQueuedSteeringInput,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacInterruptQueuedSteeringResult> {
    return resultToMiniLilacClientValue(await this.interruptQueuedSteeringResult(request, options));
  }

  interruptQueuedSteeringResult(
    request: MiniLilacInterruptQueuedSteeringInput,
    options: MiniLilacRequestOptions = {},
  ): Promise<ResultType<MiniLilacInterruptQueuedSteeringResult, MiniLilacRequestError>> {
    return this.postGeneratedControlResult(
      request,
      miniLilacInterruptQueuedSteeringRequestSchema,
      "interrupt-queued-steering",
      miniLilacInterruptQueuedSteeringResultSchema,
      options,
    );
  }

  async cancel(
    request: MiniLilacCancelRequest,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacCancelResult> {
    return resultToMiniLilacClientValue(await this.cancelResult(request, options));
  }

  cancelResult(
    request: MiniLilacCancelRequest,
    options: MiniLilacRequestOptions = {},
  ): Promise<ResultType<MiniLilacCancelResult, MiniLilacRequestError>> {
    return this.postGeneratedControlResult(
      request,
      miniLilacCancelRequestSchema,
      "cancel",
      miniLilacCancelResultSchema,
      options,
    );
  }

  async undo(
    request: MiniLilacUndoInput,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacUndoResult> {
    return resultToMiniLilacClientValue(await this.undoResult(request, options));
  }

  undoResult(
    request: MiniLilacUndoInput,
    options: MiniLilacRequestOptions = {},
  ): Promise<ResultType<MiniLilacUndoResult, MiniLilacRequestError>> {
    return this.postGeneratedControlResult(
      request,
      miniLilacUndoRequestSchema,
      "undo",
      miniLilacUndoResultSchema,
      options,
    );
  }

  async redo(
    request: MiniLilacRedoInput,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacRedoResult> {
    return resultToMiniLilacClientValue(await this.redoResult(request, options));
  }

  redoResult(
    request: MiniLilacRedoInput,
    options: MiniLilacRequestOptions = {},
  ): Promise<ResultType<MiniLilacRedoResult, MiniLilacRequestError>> {
    return this.postGeneratedControlResult(
      request,
      miniLilacRedoRequestSchema,
      "redo",
      miniLilacRedoResultSchema,
      options,
    );
  }

  /** Stop a running compaction. Detaching the stream does not; this does. */
  async cancelCompaction(
    request: MiniLilacCancelCompactionRequest,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacCancelCompactionResult> {
    return resultToMiniLilacClientValue(await this.cancelCompactionResult(request, options));
  }

  cancelCompactionResult(
    request: MiniLilacCancelCompactionRequest,
    options: MiniLilacRequestOptions = {},
  ): Promise<ResultType<MiniLilacCancelCompactionResult, MiniLilacRequestError>> {
    const payload = decodeMiniLilacBoundary(
      request,
      miniLilacCancelCompactionRequestSchema,
      "cancel compaction request",
    );
    const payloadValue = valueOrTaggedError(payload);
    if (MiniLilacBoundaryInvalid.is(payloadValue)) {
      return Promise.resolve(Result.err(payloadValue));
    }
    return this.postControlResult(
      payloadValue.sessionId,
      "compact/cancel",
      payloadValue,
      miniLilacCancelCompactionResultSchema,
      options,
    );
  }

  /**
   * Run a manual compaction, reporting lifecycle events as they arrive.
   *
   * Aborting `options.signal` only detaches this client. Compaction keeps
   * running and still commits server-side; stopping it is `cancelCompaction`.
   */
  async compact(
    request: MiniLilacCompactInput,
    options: MiniLilacCompactOptions = {},
  ): Promise<MiniLilacCompactResult> {
    return resultToMiniLilacClientValue(await this.compactResult(request, options));
  }

  async compactResult(
    request: MiniLilacCompactInput,
    options: MiniLilacCompactOptions = {},
  ): Promise<ResultType<MiniLilacCompactResult, MiniLilacCompactError>> {
    const commandId = captureMiniLilacSync("Create Mini Lilac compact command ID", () =>
      request.clientCommandId === undefined
        ? this.createClientCommandId()
        : request.clientCommandId,
    );
    const commandIdValue = valueOrTaggedError(commandId);
    if (MiniLilacExternalOperationFailed.is(commandIdValue)) return Result.err(commandIdValue);
    const payload = decodeMiniLilacBoundary(
      { ...request, clientCommandId: commandIdValue },
      miniLilacCompactRequestSchema,
      "compact request",
    );
    const payloadValue = valueOrTaggedError(payload);
    if (MiniLilacBoundaryInvalid.is(payloadValue)) return Result.err(payloadValue);
    const stream = await this.postStreamResult(
      `sessions/${encodeURIComponent(payloadValue.sessionId)}/compact`,
      payloadValue,
      options.signal,
    );
    const streamValue = valueOrTaggedError(stream);
    if (isMiniLilacRequestError(streamValue)) return Result.err(streamValue);

    const reader = streamValue.stream.getReader();
    const attempt = await captureMiniLilacPromiseOutcome(
      "Read Mini Lilac compaction result",
      () => this.readCompactionResult(reader, payloadValue.clientCommandId, options),
      options.signal,
    );
    if (attempt.kind === "panic") {
      await cleanupMiniLilacStreamReader(
        reader,
        () => reader.cancel(),
        attempt.panic,
        streamValue.cleanupSource,
      );
      return throwMiniLilacPanic(attempt.panic);
    }
    const primary: ResultType<MiniLilacCompactResult, MiniLilacCompactionPrimaryError> =
      attempt.kind === "error" ? Result.err(attempt.error) : attempt.value;
    const cleanup = await cleanupMiniLilacStreamReader(
      reader,
      () => reader.cancel(),
      undefined,
      streamValue.cleanupSource,
    );
    return cleanup.match<ResultType<MiniLilacCompactResult, MiniLilacCompactError>>({
      ok: () => primary,
      err: (cleanupError) =>
        primary.match<ResultType<MiniLilacCompactResult, MiniLilacCompactError>>({
          ok: () => Result.err(cleanupError),
          err: (primaryError) =>
            Result.err(
              new MiniLilacCompactionAndCleanupFailed({
                primary: primaryError,
                cleanup: cleanupError,
                message: "Context compaction and stream cleanup both failed",
              }),
            ),
        }),
    });
  }

  private async readCompactionResult(
    reader: ReadableStreamDefaultReader<UIMessageChunk>,
    clientCommandId: string,
    options: MiniLilacCompactOptions,
  ): Promise<ResultType<MiniLilacCompactResult, MiniLilacCompactionPrimaryError>> {
    for (;;) {
      const read = await captureMiniLilacPromise(
        "Read Mini Lilac compaction stream",
        () => reader.read(),
        options.signal,
      );
      const readValue = valueOrTaggedError(read);
      if (isMiniLilacRequestError(readValue)) return Result.err(readValue);
      if (readValue.done) {
        return Result.err(
          new MiniLilacCompactionProtocolError({
            message: "Context compaction ended without a result",
          }),
        );
      }
      const part = decodeMiniLilacBoundary(
        readValue.value,
        miniLilacUIMessageDataPartSchema,
        "compaction stream data part",
      );
      const partValue = valueOrTaggedError(part);
      if (MiniLilacBoundaryInvalid.is(partValue)) {
        const compactionDiscriminant = decodeMiniLilacBoundary(
          readValue.value,
          compactionChunkDiscriminantSchema,
          "compaction stream discriminant",
        );
        const isCompaction = compactionDiscriminant.match<boolean>({
          ok: () => true,
          err: () => false,
        });
        if (isCompaction) {
          return Result.err(
            new MiniLilacCompactionProtocolError({
              message: "Invalid compaction lifecycle event",
            }),
          );
        }
        continue;
      }
      if (partValue.type === "data-session") {
        const snapshot = partValue.data;
        if (options.onSession !== undefined) {
          const called = captureMiniLilacSync("Handle Mini Lilac session event", () =>
            options.onSession?.(snapshot),
          );
          const calledValue = valueOrTaggedError(called);
          if (MiniLilacExternalOperationFailed.is(calledValue)) return Result.err(calledValue);
        }
        continue;
      }
      if (partValue.type !== "data-compaction") continue;
      const event = partValue.data;
      if (options.onEvent !== undefined) {
        const called = captureMiniLilacSync("Handle Mini Lilac compaction event", () =>
          options.onEvent?.(event),
        );
        const calledValue = valueOrTaggedError(called);
        if (MiniLilacExternalOperationFailed.is(calledValue)) return Result.err(calledValue);
      }
      switch (event.phase) {
        case "started":
        case "progress":
          continue;
        case "failed":
          return Result.err(
            new MiniLilacCompactionFailed({
              message: event.error ?? "Context compaction failed",
            }),
          );
        case "cancelled":
          return Result.err(new MiniLilacCompactionCancelledError());
        case "completed": {
          if (event.outcome === undefined || event.messageCountAfter === undefined) {
            return Result.err(
              new MiniLilacCompactionProtocolError({
                message: "Context compaction completed without a terminal result",
              }),
            );
          }
          const beforeTokens =
            event.estimatedInputTokensBefore === undefined
              ? {}
              : { estimatedInputTokensBefore: event.estimatedInputTokensBefore };
          const afterTokens =
            event.estimatedInputTokensAfter === undefined
              ? {}
              : { estimatedInputTokensAfter: event.estimatedInputTokensAfter };
          return Result.ok({
            status: event.outcome,
            clientCommandId,
            messageCountBefore: event.messageCountBefore,
            messageCountAfter: event.messageCountAfter,
            ...beforeTokens,
            ...afterTokens,
          });
        }
      }
    }
  }

  private async postStreamResult(
    endpoint: string,
    bodyValue: object,
    signal: AbortSignal | undefined,
  ): Promise<ResultType<MiniLilacParsedStream, MiniLilacRequestError>> {
    const headers = await this.createHeadersResult(true);
    const headersValue = valueOrTaggedError(headers);
    if (isMiniLilacRequestError(headersValue)) return Result.err(headersValue);
    const body = captureMiniLilacSync("Serialize Mini Lilac stream request", () =>
      JSON.stringify(bodyValue),
    );
    const serializedBody = valueOrTaggedError(body);
    if (MiniLilacExternalOperationFailed.is(serializedBody)) return Result.err(serializedBody);
    const operation = "Start Mini Lilac stream request";
    const response = await captureMiniLilacPromise(
      operation,
      () =>
        this.fetch(joinUrl(this.baseUrl, endpoint), {
          method: "POST",
          body: serializedBody,
          credentials: this.credentials,
          headers: headersValue,
          signal,
        }),
      signal,
    );
    const responseValue = valueOrTaggedError(response);
    if (isMiniLilacRequestError(responseValue)) return Result.err(responseValue);
    return this.responseStreamResult(responseValue, operation);
  }

  private async performSessionBindingUpdateResult(
    request: MiniLilacUpdateSessionBindingsInput,
    options: MiniLilacRequestOptions,
  ): Promise<ResultType<MiniLilacSessionSnapshot, MiniLilacRequestError>> {
    const commandId = captureMiniLilacSync("Create Mini Lilac binding command ID", () =>
      request.clientCommandId === undefined
        ? this.createClientCommandId()
        : request.clientCommandId,
    );
    const commandIdValue = valueOrTaggedError(commandId);
    if (MiniLilacExternalOperationFailed.is(commandIdValue)) return Result.err(commandIdValue);
    const payload = decodeMiniLilacBoundary(
      { ...request, clientCommandId: commandIdValue },
      miniLilacUpdateSessionBindingsRequestSchema,
      "session binding update",
    );
    const payloadValue = valueOrTaggedError(payload);
    if (MiniLilacBoundaryInvalid.is(payloadValue)) return Result.err(payloadValue);
    const snapshot = await this.postControlResult(
      payloadValue.sessionId,
      "bindings",
      payloadValue,
      miniLilacSessionSnapshotSchema,
      options,
    );
    const snapshotValue = valueOrTaggedError(snapshot);
    if (isMiniLilacRequestError(snapshotValue)) return Result.err(snapshotValue);
    this.setSessionBindings({
      model: snapshotValue.model ?? undefined,
      profile: snapshotValue.profile ?? undefined,
      reasoning: snapshotValue.reasoning ?? undefined,
    });
    return Result.ok(snapshotValue);
  }

  private resolveReconnectEndpointResult(
    endpoint: MiniLilacReconnectEndpoint | undefined,
    chatId: string,
  ): ResultType<string, MiniLilacBoundaryInvalid | MiniLilacExternalOperationFailed> {
    if (typeof endpoint === "function") {
      const resolved = captureMiniLilacSync("Resolve Mini Lilac reconnect endpoint", () =>
        endpoint({ baseUrl: this.baseUrl, chatId }),
      );
      const resolvedValue = valueOrTaggedError(resolved);
      if (MiniLilacExternalOperationFailed.is(resolvedValue)) return Result.err(resolvedValue);
      return decodeMiniLilacBoundary(resolvedValue, z.string().min(1), "reconnect endpoint");
    }
    if (endpoint !== undefined) {
      if (endpoint.startsWith("/") || /^[a-z][a-z\d+.-]*:\/\//i.test(endpoint)) {
        return Result.ok(endpoint);
      }
      return Result.ok(joinUrl(this.baseUrl, endpoint));
    }
    return Result.ok(joinUrl(this.baseUrl, `chat/${encodeURIComponent(chatId)}/stream`));
  }

  private trackResultStream(
    chatId: string,
    generation: number,
    stream: MiniLilacResultStream,
  ): MiniLilacResultStream {
    let pendingCursor: MiniLilacStreamCursor | undefined;

    return stream.pipeThrough(
      new TransformStream<
        ResultType<UIMessageChunk, MiniLilacStreamError>,
        ResultType<UIMessageChunk, MiniLilacStreamError>
      >({
        transform: (result, controller) => {
          const chunk = result.match<UIMessageChunk | undefined>({
            ok: (value) => value,
            err: () => undefined,
          });
          if (chunk === undefined) {
            pendingCursor = undefined;
            controller.enqueue(result);
            return;
          }
          const cursor = decodeMiniLilacBoundary(
            chunk,
            miniLilacStreamCursorChunkSchema,
            "stream cursor",
          );
          const isCurrentGeneration = (this.streamGenerations.get(chatId) ?? 0) === generation;
          const cursorValue = cursor.match<MiniLilacStreamCursor | null>({
            ok: (value) => value.data,
            err: () => null,
          });

          if (!isCurrentGeneration) {
            pendingCursor = undefined;
          } else if (cursorValue !== null) {
            pendingCursor = cursorValue;
          }

          controller.enqueue(result);

          if (isCurrentGeneration && cursorValue === null && pendingCursor !== undefined) {
            this.lastStreamCursor.set(chatId, pendingCursor);
            pendingCursor = undefined;
          }
        },
      }),
    );
  }

  private async createHeadersResult(
    json: boolean,
    requestHeaders?: Record<string, string> | Headers,
  ): Promise<ResultType<Headers, MiniLilacRequestError>> {
    const token = await captureMiniLilacPromise("Resolve Mini Lilac bearer token", () =>
      Promise.resolve(this.bearerToken?.()),
    );
    const tokenValue = valueOrTaggedError(token);
    if (isMiniLilacRequestError(tokenValue)) return Result.err(tokenValue);
    const decodedToken = decodeMiniLilacBoundary(
      tokenValue,
      z.string().nullable().optional(),
      "bearer token",
    );
    const decodedTokenValue = valueOrTaggedError(decodedToken);
    if (MiniLilacBoundaryInvalid.is(decodedTokenValue)) return Result.err(decodedTokenValue);
    return captureMiniLilacSync("Create Mini Lilac request headers", () => {
      const headers = new Headers(this.headers);
      if (decodedTokenValue !== null && decodedTokenValue !== undefined) {
        headers.set("Authorization", `Bearer ${decodedTokenValue}`);
      }
      if (json) headers.set("Content-Type", "application/json");
      new Headers(requestHeaders).forEach((value, name) => headers.set(name, value));
      return headers;
    });
  }

  private async responseStreamResult(
    response: Response,
    operation: string,
  ): Promise<ResultType<MiniLilacParsedStream, MiniLilacRequestError>> {
    if (!response.ok || response.body === null) {
      let detail = "The response body is empty.";
      if (response.body !== null || !response.ok) {
        const text = await captureMiniLilacPromise(`${operation} error response`, () =>
          response.text(),
        );
        const textValue = valueOrTaggedError(text);
        if (isMiniLilacRequestError(textValue)) return Result.err(textValue);
        detail = textValue;
      }
      if (
        operation === "Send Mini Lilac chat request" ||
        operation === "Reconnect Mini Lilac stream"
      ) {
        return Result.err(
          new MiniLilacHttpError({
            operation,
            status: response.status,
            detail,
            message: detail || "Failed to fetch the chat response.",
          }),
        );
      }
      return Result.err(httpError(operation, response, response.ok ? "" : detail));
    }
    const body = response.body;
    const stream = captureMiniLilacSync("Decode Mini Lilac event stream", () =>
      parseMiniLilacStream(body),
    );
    const streamValue = valueOrTaggedError(stream);
    if (MiniLilacExternalOperationFailed.is(streamValue)) return Result.err(streamValue);
    return Result.ok(streamValue);
  }

  private postGeneratedControlResult<
    Input extends { readonly sessionId: string; readonly clientCommandId?: string },
    Payload extends { readonly sessionId: string },
    Output,
  >(
    request: Input,
    requestSchema: z.ZodType<Payload>,
    action: string,
    responseSchema: z.ZodType<Output>,
    options: MiniLilacRequestOptions,
  ): Promise<ResultType<Output, MiniLilacRequestError>> {
    const commandId = captureMiniLilacSync(`Create Mini Lilac ${action} command ID`, () =>
      request.clientCommandId === undefined
        ? this.createClientCommandId()
        : request.clientCommandId,
    );
    const commandIdValue = valueOrTaggedError(commandId);
    if (MiniLilacExternalOperationFailed.is(commandIdValue)) {
      return Promise.resolve(Result.err(commandIdValue));
    }
    const payload = decodeMiniLilacBoundary(
      { ...request, clientCommandId: commandIdValue },
      requestSchema,
      `${action} request`,
    );
    const payloadValue = valueOrTaggedError(payload);
    if (MiniLilacBoundaryInvalid.is(payloadValue)) {
      return Promise.resolve(Result.err(payloadValue));
    }
    return this.postControlResult(
      payloadValue.sessionId,
      action,
      payloadValue,
      responseSchema,
      options,
    );
  }

  private postControlResult<T>(
    sessionId: string,
    action: string,
    bodyValue: object,
    schema: z.ZodType<T>,
    options: MiniLilacRequestOptions,
  ): Promise<ResultType<T, MiniLilacRequestError>> {
    const body = captureMiniLilacSync(`Serialize Mini Lilac ${action} request`, () =>
      JSON.stringify(bodyValue),
    );
    const serializedBody = valueOrTaggedError(body);
    if (MiniLilacExternalOperationFailed.is(serializedBody)) {
      return Promise.resolve(Result.err(serializedBody));
    }
    return this.requestJsonResult(
      `sessions/${encodeURIComponent(sessionId)}/${action}`,
      schema,
      { method: "POST", body: serializedBody, signal: options.signal },
      `Perform Mini Lilac ${action}`,
    );
  }

  private requestSessionJsonResult<T>(
    sessionId: string,
    suffix: string,
    schema: z.ZodType<T>,
    options: MiniLilacRequestOptions,
  ): Promise<ResultType<T, MiniLilacRequestError>> {
    const id = decodeMiniLilacBoundary(sessionId, sessionIdSchema, "session ID");
    const idValue = valueOrTaggedError(id);
    if (MiniLilacBoundaryInvalid.is(idValue)) return Promise.resolve(Result.err(idValue));
    return this.requestJsonResult(
      `sessions/${encodeURIComponent(idValue)}${suffix}`,
      schema,
      { signal: options.signal },
      "Read Mini Lilac session",
    );
  }

  private async requestJsonResult<T>(
    endpoint: string,
    schema: z.ZodType<T>,
    init: RequestInit,
    operation: string,
  ): Promise<ResultType<T, MiniLilacRequestError>> {
    const headers = await this.createHeadersResult(init.body !== undefined);
    const headersValue = valueOrTaggedError(headers);
    if (isMiniLilacRequestError(headersValue)) return Result.err(headersValue);
    const response = await captureMiniLilacPromise(
      operation,
      () =>
        this.fetch(joinUrl(this.baseUrl, endpoint), {
          ...init,
          credentials: this.credentials,
          headers: headersValue,
        }),
      init.signal ?? undefined,
    );
    const responseValue = valueOrTaggedError(response);
    if (isMiniLilacRequestError(responseValue)) return Result.err(responseValue);

    if (!responseValue.ok) {
      const detail = await captureMiniLilacPromise(`${operation} error response`, () =>
        responseValue.text(),
      );
      const detailValue = valueOrTaggedError(detail);
      if (isMiniLilacRequestError(detailValue)) return Result.err(detailValue);
      return Result.err(httpError(operation, responseValue, detailValue));
    }

    const decoded = await captureMiniLilacPromise(`${operation} JSON response`, async () => {
      const value: unknown = await responseValue.json();
      return decodeMiniLilacBoundary(value, schema, `${operation} response`);
    });
    const decodedValue = valueOrTaggedError(decoded);
    if (isMiniLilacRequestError(decodedValue)) return Result.err(decodedValue);
    return decodedValue;
  }
}
