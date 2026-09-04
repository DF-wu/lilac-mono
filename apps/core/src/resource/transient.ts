import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";

import { Panic, Result, type Result as ResultType } from "better-result";
import { errorCode } from "@stanley2058/lilac-utils";

import {
  adaptToolResultArtifactReadToUnavailablePolicy,
  coreToolResultArtifactIdFromUri,
  isCoreToolResultResourceUri,
  ToolResultArtifactContentMismatch,
  ToolResultArtifactDecryptAuthenticationFailed,
  ToolResultArtifactReadCancelled,
  ToolResultArtifactReadTooLarge,
  ToolResultArtifactUnavailable,
  type ToolResultArtifactError,
  type ToolResultArtifactRead,
  type ToolResultArtifactReadWindow,
  type ToolResultArtifactStart,
  type ToolResultArtifactStore,
} from "../artifacts/tool-result-artifact-store";
import { captureError } from "../shared/error-capture";
import { preserveToolPanic } from "../tools/tool-result-adapters";
import type { MaterializedResource } from "./contracts";
import {
  ResourceAlreadyExists,
  ResourceCacheUnavailable,
  ResourceCancelled,
  ResourceIntegrityFailure,
  ResourceInvalidUri,
  ResourceNotFound,
  ResourceTooLarge,
  ResourceWriteFailed,
  type ResourceAccessError,
} from "./errors";

export { isCoreToolResultResourceUri };

export type ScopedTransientResourceAccess = {
  read(uri: string): Promise<ResultType<ToolResultArtifactRead, ToolResultArtifactError>>;
  readWindow(
    uri: string,
    options: {
      readonly start: ToolResultArtifactStart;
      readonly maxCharacters: number;
      readonly maxLines: number;
      readonly maxOutputBytes?: number;
    },
  ): Promise<ResultType<ToolResultArtifactReadWindow, ToolResultArtifactError>>;
  readContent(
    uri: string,
    options: {
      readonly maxBytes: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<ResultType<TransientResourceContent, ResourceAccessError>>;
  materialize(
    uri: string,
    options: {
      readonly targetDirectory: string;
      readonly maxBytes: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<ResultType<MaterializedResource, ResourceAccessError>>;
};

export type TransientResourceContent = {
  readonly filename: string;
  readonly mimeType: "text/plain";
  readonly data: Uint8Array;
};

type CapturedFileFailure = {
  readonly cause: Error | Panic;
};

function captureFileFailure(cause: unknown): CapturedFileFailure {
  return captureError(cause, "Transient resource file operation failed");
}

function capturedFailure(result: ResultType<unknown, CapturedFileFailure>): Error | Panic | null {
  return result.match<Error | Panic | null>({
    ok: () => null,
    err: ({ cause }) => cause,
  });
}

function settleFileFailure(cause: Error | Panic): Error {
  if (Panic.is(cause)) preserveToolPanic(cause);
  return cause;
}

function transientResourceOpenFailure(
  uri: string,
  destination: string,
  cause: Error | Panic,
): ResourceAccessError {
  const error = settleFileFailure(cause);
  if (errorCode(error) === "EEXIST") {
    return new ResourceAlreadyExists({
      uri,
      path: destination,
      message: "Resource destination already exists",
    });
  }
  return new ResourceWriteFailed({
    uri,
    path: destination,
    message: "Resource destination could not be created",
  });
}

function settleFileFailures(failures: readonly (Error | Panic | null)[]): void {
  for (const failure of failures) {
    if (failure === null) continue;
    settleFileFailure(failure);
  }
}

function artifactFailure(uri: string, error: ToolResultArtifactError): ResourceAccessError {
  if (error instanceof ToolResultArtifactReadTooLarge) {
    return new ResourceTooLarge({
      uri,
      limit: error.maxBytes,
      limitKind: "operation",
      reportedBytes: error.actualBytes,
      message: `Resource exceeds the ${error.maxBytes}-byte limit`,
    });
  }
  if (error instanceof ToolResultArtifactReadCancelled) {
    return new ResourceCancelled({
      uri,
      message: "Transient resource materialization was cancelled",
    });
  }
  if (error instanceof ToolResultArtifactUnavailable) {
    return error.reason === "invalid-uri"
      ? new ResourceInvalidUri({ uri, message: "Transient resource URI is invalid" })
      : new ResourceNotFound({ uri, message: "Transient resource is unavailable" });
  }
  if (
    error instanceof ToolResultArtifactContentMismatch ||
    error instanceof ToolResultArtifactDecryptAuthenticationFailed
  ) {
    return new ResourceIntegrityFailure({
      uri,
      reason: "tool_result_integrity_failed",
      message: "Transient resource content failed verification",
    });
  }
  return new ResourceCacheUnavailable({
    uri,
    retryable: true,
    message: "Transient resource storage is unavailable",
  });
}

async function settleArtifactReadFailure(
  store: ToolResultArtifactStore,
  uri: string,
  error: ToolResultArtifactError,
): Promise<ResourceAccessError> {
  await adaptToolResultArtifactReadToUnavailablePolicy(store, Result.err(error));
  return artifactFailure(uri, error);
}

function readDecision(
  result: ResultType<ToolResultArtifactRead, ToolResultArtifactError>,
):
  | { readonly kind: "read"; readonly read: ToolResultArtifactRead }
  | { readonly kind: "error"; readonly error: ToolResultArtifactError } {
  return result.match<
    | { readonly kind: "read"; readonly read: ToolResultArtifactRead }
    | { readonly kind: "error"; readonly error: ToolResultArtifactError }
  >({
    ok: (read) => ({ kind: "read" as const, read }),
    err: (error) => ({ kind: "error" as const, error }),
  });
}

async function cleanupOwnedFile(path: string): Promise<Error | null> {
  const removed = await Result.tryPromise({
    try: () => fs.rm(path, { force: true }),
    catch: captureFileFailure,
  });
  const failure = capturedFailure(removed);
  return failure === null ? null : settleFileFailure(failure);
}

async function transientResourceWriteFailure(input: {
  readonly uri: string;
  readonly destination: string;
  readonly writeFailure: Error | Panic | null;
  readonly closeFailure: Error | Panic | null;
  readonly cancelled: boolean;
}): Promise<ResourceAccessError> {
  settleFileFailures([input.writeFailure, input.closeFailure]);
  settleFileFailures([await cleanupOwnedFile(input.destination)]);
  if (input.cancelled) {
    return new ResourceCancelled({
      uri: input.uri,
      message: "Transient resource materialization was cancelled",
    });
  }
  return new ResourceWriteFailed({
    uri: input.uri,
    path: input.destination,
    message: "Resource destination could not be written",
  });
}

async function readTransientResourceContent(input: {
  readonly store: ToolResultArtifactStore;
  readonly scopeId: string;
  readonly uri: string;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}): Promise<ResultType<TransientResourceContent, ResourceAccessError>> {
  const artifactId = coreToolResultArtifactIdFromUri(input.uri);
  if (artifactId === null) {
    return Result.err(
      new ResourceInvalidUri({ uri: input.uri, message: "Transient resource URI is invalid" }),
    );
  }
  if (input.signal?.aborted) {
    return Result.err(
      new ResourceCancelled({
        uri: input.uri,
        message: "Transient resource read was cancelled",
      }),
    );
  }
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
    return Result.err(
      new ResourceTooLarge({
        uri: input.uri,
        limit: 0,
        limitKind: "operation",
        message: "Resource operation byte limit must be a positive safe integer",
      }),
    );
  }

  const read = readDecision(
    await input.store.read(input.uri, input.scopeId, {
      maxBytes: input.maxBytes,
      ...(input.signal ? { signal: input.signal } : {}),
    }),
  );
  if (read.kind === "error") {
    return Result.err(await settleArtifactReadFailure(input.store, input.uri, read.error));
  }
  if (read.read.bytes > input.maxBytes) {
    return Result.err(
      new ResourceTooLarge({
        uri: input.uri,
        limit: input.maxBytes,
        limitKind: "operation",
        reportedBytes: read.read.bytes,
        message: `Resource exceeds the ${input.maxBytes}-byte limit`,
      }),
    );
  }
  if (input.signal?.aborted) {
    return Result.err(
      new ResourceCancelled({
        uri: input.uri,
        message: "Transient resource read was cancelled",
      }),
    );
  }

  return Result.ok({
    filename: `tool-result-${artifactId.replaceAll("-", "").slice(0, 8)}.txt`,
    mimeType: "text/plain",
    data: Buffer.from(read.read.content, "utf8"),
  });
}

async function materializeTransientResource(input: {
  readonly store: ToolResultArtifactStore;
  readonly scopeId: string;
  readonly uri: string;
  readonly targetDirectory: string;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}): Promise<ResultType<MaterializedResource, ResourceAccessError>> {
  const content = await readTransientResourceContent(input);
  const contentDecision = content.match<
    | { readonly kind: "content"; readonly value: TransientResourceContent }
    | { readonly kind: "error"; readonly error: ResourceAccessError }
  >({
    ok: (value) => ({ kind: "content", value }),
    err: (error) => ({ kind: "error", error }),
  });
  if (contentDecision.kind === "error") return Result.err(contentDecision.error);

  const destination = join(input.targetDirectory, contentDecision.value.filename);
  const opened = await Result.tryPromise({
    try: () => fs.open(destination, "wx", 0o600),
    catch: captureFileFailure,
  });
  const openDecision = opened.match<
    | { readonly kind: "opened"; readonly handle: Awaited<ReturnType<typeof fs.open>> }
    | { readonly kind: "error"; readonly error: Error | Panic }
  >({
    ok: (handle) => ({ kind: "opened", handle }),
    err: ({ cause }) => ({ kind: "error", error: cause }),
  });
  if (openDecision.kind === "error") {
    return Result.err(transientResourceOpenFailure(input.uri, destination, openDecision.error));
  }

  const written = await Result.tryPromise({
    try: () =>
      openDecision.handle.writeFile(
        contentDecision.value.data,
        input.signal ? { signal: input.signal } : undefined,
      ),
    catch: captureFileFailure,
  });
  const writeFailure = capturedFailure(written);
  const closed = await Result.tryPromise({
    try: () => openDecision.handle.close(),
    catch: captureFileFailure,
  });
  const closeFailure = capturedFailure(closed);
  if (writeFailure !== null || closeFailure !== null || input.signal?.aborted) {
    return Result.err(
      await transientResourceWriteFailure({
        uri: input.uri,
        destination,
        writeFailure,
        closeFailure,
        cancelled: input.signal?.aborted ?? false,
      }),
    );
  }

  return Result.ok({
    uri: input.uri,
    path: destination,
    filename: contentDecision.value.filename,
    mimeType: contentDecision.value.mimeType,
    bytes: contentDecision.value.data.byteLength,
    sha256: createHash("sha256").update(contentDecision.value.data).digest("hex"),
  });
}

export function bindTransientResourceAccess(
  store: ToolResultArtifactStore,
  scopeId: string,
): ScopedTransientResourceAccess {
  return {
    read: (uri) => store.read(uri, scopeId),
    readWindow: (uri, options) => store.readWindow(uri, scopeId, options),
    readContent: (uri, options) =>
      readTransientResourceContent({ store, scopeId, uri, ...options }),
    materialize: (uri, options) =>
      materializeTransientResource({ store, scopeId, uri, ...options }),
  };
}
