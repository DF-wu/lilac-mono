import {
  buildSimpleHtmlContent,
  buildTextContent,
  checkPageSignal,
  getAbortReasonError,
  type PageAcquisitionInput,
  type PageContent,
  type PageContentResult,
} from "./page-content";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { adaptToolResultToHost } from "../../../tools/tool-result-adapters";

const MAX_FETCH_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
const MAX_FULL_DOM_PARSE_BYTES = 750 * 1024;
const SUPPORTED_TEXT_MEDIA_TYPES = new Set([
  "text/html",
  "text/plain",
  "text/markdown",
  "application/xhtml+xml",
]);

class DirectHttpPageFailure extends TaggedError("DirectHttpPageFailure")<{
  readonly message: string;
}> {}

function adaptDirectHttpPageResultToHost<TValue>(
  result: ResultType<TValue, DirectHttpPageFailure>,
): TValue {
  return result.match({
    ok: (value) => () => value,
    err: (error) => () => {
      throw new Error(error.message);
    },
  })();
}

function signalDirectHttpPageFailure(message: string): never {
  return adaptDirectHttpPageResultToHost(Result.err(new DirectHttpPageFailure({ message })));
}

export interface DirectHttpPageAcquisition {
  acquire(input: PageAcquisitionInput, opts?: { signal?: AbortSignal }): Promise<PageContentResult>;
}

function parseMediaType(contentType: string | null): string | null {
  if (!contentType) return null;
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  return mediaType && mediaType.length > 0 ? mediaType : null;
}

function isTextMediaType(mediaType: string | null): boolean {
  if (!mediaType) return false;
  return SUPPORTED_TEXT_MEDIA_TYPES.has(mediaType) || mediaType.startsWith("text/");
}

function isHtmlMediaType(mediaType: string | null): boolean {
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

function contentLengthFromHeaders(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function acceptHeader(format: PageAcquisitionInput["format"]): string {
  switch (format) {
    case "text":
      return "text/plain, text/html;q=0.8, */*;q=0.1";
    case "html":
      return "text/html, */*;q=0.1";
    case "markdown":
    case undefined:
      return "text/markdown, text/html;q=0.8, */*;q=0.1";
  }
}

type BoundedResponseText =
  | { isError: false; text: string; bytesRead: number; truncated: boolean }
  | { isError: true; error: string };

function captureDirectHttpCleanupFailure(cause: unknown): Error | Panic {
  if (Panic.is(cause)) return cause;
  if (cause instanceof Error) return cause;
  return new Error("Direct HTTP response cleanup failed", { cause });
}

async function cancelResponseBody(
  body: ReadableStream<Uint8Array> | null,
  reason: Error,
): Promise<ResultType<void, Error | Panic>> {
  if (!body) return Result.ok(undefined);
  return (
    await Result.tryPromise({
      try: () => body.cancel(reason),
      catch: captureDirectHttpCleanupFailure,
    })
  ).map(() => undefined);
}

async function cancelResponseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: Error,
): Promise<ResultType<void, Error | Panic>> {
  return (
    await Result.tryPromise({
      try: () => reader.cancel(reason),
      catch: captureDirectHttpCleanupFailure,
    })
  ).map(() => undefined);
}

function releaseResponseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ResultType<void, Error | Panic> {
  return Result.try({
    try: () => reader.releaseLock(),
    catch: captureDirectHttpCleanupFailure,
  });
}

function directHttpCleanupFailure<T>(result: ResultType<T, Error | Panic>): Error | Panic | null {
  return result.match({ ok: () => null, err: (error) => error });
}

function signalDirectHttpCleanupFailure(error: Error | Panic): never {
  return adaptToolResultToHost(Result.err(error));
}

async function readResponseTextWithLimit(params: {
  res: Response;
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<BoundedResponseText> {
  checkPageSignal(params.signal);
  const contentLength = contentLengthFromHeaders(params.res.headers);
  if (contentLength !== null && contentLength > params.maxBytes) {
    const cancellation = await cancelResponseBody(
      params.res.body,
      new Error("response byte limit reached"),
    );
    const cancellationFailure = directHttpCleanupFailure(cancellation);
    if (cancellationFailure) signalDirectHttpCleanupFailure(cancellationFailure);
    signalDirectHttpPageFailure(
      `response too large (${contentLength} bytes > ${params.maxBytes} byte limit)`,
    );
  }

  if (!params.res.body) {
    const fallback = await params.res.text();
    const bytes = Buffer.byteLength(fallback, "utf8");
    return bytes > params.maxBytes
      ? {
          isError: false,
          text: fallback.slice(0, params.maxBytes),
          bytesRead: params.maxBytes,
          truncated: true,
        }
      : { isError: false, text: fallback, bytesRead: bytes, truncated: false };
  }

  const reader = params.res.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  let truncated = false;
  let cancelPending: Promise<ResultType<void, Error | Panic>> | undefined;
  let cancelReason: Error | undefined;
  const requestCancel = (reason: Error): Promise<ResultType<void, Error | Panic>> => {
    cancelReason ??= reason;
    cancelPending ??= cancelResponseReader(reader, cancelReason);
    return cancelPending;
  };
  const onAbort = () => {
    void requestCancel(getAbortReasonError(params.signal!));
  };
  params.signal?.addEventListener("abort", onAbort, { once: true });

  const read = await Result.tryPromise({
    try: async () => {
      while (true) {
        checkPageSignal(params.signal);
        const chunk = await reader.read();
        if (chunk.done) break;
        bytesRead += chunk.value.byteLength;
        if (bytesRead > params.maxBytes) {
          truncated = true;
          cancelReason = new Error("response byte limit reached");
          const allowedBytes = chunk.value.byteLength - (bytesRead - params.maxBytes);
          if (allowedBytes > 0) {
            text += decoder.decode(chunk.value.subarray(0, allowedBytes), { stream: true });
          }
          break;
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      return {
        isError: false,
        text,
        bytesRead: Math.min(bytesRead, params.maxBytes),
        truncated,
      } as const;
    },
    catch: captureDirectHttpCleanupFailure,
  });
  params.signal?.removeEventListener("abort", onAbort);

  if (cancelReason || directHttpCleanupFailure(read)) {
    await requestCancel(cancelReason ?? new Error("response read failed"));
  }
  const cancellationFailure = cancelPending ? directHttpCleanupFailure(await cancelPending) : null;
  const releaseFailure = directHttpCleanupFailure(releaseResponseReader(reader));
  if (cancellationFailure) signalDirectHttpCleanupFailure(cancellationFailure);
  if (releaseFailure) signalDirectHttpCleanupFailure(releaseFailure);

  const readFailure = directHttpCleanupFailure(read);
  if (readFailure) signalDirectHttpCleanupFailure(readFailure);
  return read.match<BoundedResponseText>({
    ok: (value) => value,
    err: () => ({ isError: true, error: "response read failed" }),
  });
}

export function createDirectHttpPageAcquisition(params: {
  pageContent: PageContent;
  fetch?: typeof fetch;
}): DirectHttpPageAcquisition {
  const fetchPage = params.fetch ?? fetch;
  return {
    async acquire({ url, format = "markdown", timeout = 10_000, preprocessor = "none" }, opts) {
      const requestSignal = opts?.signal;
      const timeoutSignal = AbortSignal.timeout(timeout);
      const signal = AbortSignal.any([timeoutSignal, ...(requestSignal ? [requestSignal] : [])]);
      const res = await fetchPage(url, {
        headers: { Accept: acceptHeader(format) },
        signal,
      });

      if (timeoutSignal.aborted && !requestSignal?.aborted) {
        return { isError: true, error: "timeout fetching page" };
      }
      checkPageSignal(requestSignal);

      if (!res.ok) {
        const errorBody = await readResponseTextWithLimit({
          res,
          maxBytes: MAX_ERROR_RESPONSE_BYTES,
          signal: requestSignal,
        });
        if (errorBody.isError) return errorBody;
        return {
          isError: true,
          error: errorBody.truncated
            ? `${errorBody.text}\n\n[truncated after ${errorBody.bytesRead} bytes]`
            : errorBody.text,
          status: res.status,
        };
      }

      const mediaType = parseMediaType(res.headers.get("content-type"));
      if (!isTextMediaType(mediaType)) {
        return {
          isError: true,
          error: `Unsupported content-type for text extraction: ${mediaType ?? "unknown"}`,
          contentType: mediaType,
          contentLength: contentLengthFromHeaders(res.headers),
        };
      }

      const body = await readResponseTextWithLimit({
        res,
        maxBytes: MAX_FETCH_RESPONSE_BYTES,
        signal: requestSignal,
      });
      if (body.isError) return body;

      if (mediaType === "text/markdown" || mediaType === "text/plain") {
        return {
          isError: false,
          content: buildTextContent({
            url,
            title: url,
            text: body.text,
            markdown: body.text,
            raw: body.text,
          }),
          sourceTruncated: body.truncated,
        };
      }

      checkPageSignal(requestSignal);
      let content;
      if (!isHtmlMediaType(mediaType)) {
        content = {
          url,
          title: url,
          markdown: body.text,
          text: body.text,
          raw: body.text,
        };
      } else if (body.bytesRead > MAX_FULL_DOM_PARSE_BYTES) {
        content = buildSimpleHtmlContent(body.text, url);
      } else {
        content = params.pageContent.parse(body.text, url, {
          preprocessor,
          signal: requestSignal,
        });
      }
      return {
        isError: false,
        content,
        sourceTruncated: body.truncated,
        rawHtml: isHtmlMediaType(mediaType) ? body.text : undefined,
      };
    },
  };
}
