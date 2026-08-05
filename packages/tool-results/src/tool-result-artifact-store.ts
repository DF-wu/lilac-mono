import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  type DecipherGCM,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createLogger, errorCode } from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import {
  decodeToolResultArtifactMetadata,
  encodeToolResultArtifactMetadata,
  ToolResultArtifactMetadataUnsupportedVersion,
  type DecodedToolResultArtifactMetadata,
  type ToolResultArtifactMetadata,
  type ToolResultArtifactMetadataCodecError,
  type ToolResultArtifactMetadataIssueCode,
} from "./tool-result-artifact-metadata-codec";

export const TOOL_RESULT_URI_PREFIX = "tool-result://";
export const TOOL_RESULT_UNAVAILABLE_MESSAGE =
  "This transient tool result is no longer available because it expired or was evicted. Re-run the original tool call if the output is still needed.";
// Four-byte Unicode characters still fit within the configured 40 KiB raw preview budget.
export const TOOL_RESULT_MAX_PAGE_CHARACTERS = 10 * 1024;

export type ToolResultArtifactStart =
  | { type: "offset"; offset: number }
  | { type: "line"; line: number; column?: number };

type ArtifactMetadata = ToolResultArtifactMetadata;

type ToolResultArtifactScope = { scopeId: string } | { sessionId: string };

type ToolResultArtifactScopeLimit = { maxBytesPerScope: number } | { maxBytesPerSession: number };

export type CreateToolResultArtifactBaseParams = ToolResultArtifactScope &
  ToolResultArtifactScopeLimit & {
    requestId: string;
    toolCallId: string;
    toolName: string;
    ttlMs: number;
    maxArtifactBytes?: number;
  };

export type CreateToolResultArtifactParams = CreateToolResultArtifactBaseParams & {
  content: string;
};

export type CreateToolResultArtifactFileParams = CreateToolResultArtifactBaseParams & {
  sourcePath: string;
};

export type CreateToolResultArtifactStreamParams = CreateToolResultArtifactBaseParams & {
  source: Readable;
};

export type CreatedToolResultArtifact = {
  id: string;
  uri: string;
  bytes: number;
  scopeBytes: number;
  /** @deprecated Use scopeBytes. */
  sessionBytes: number;
  evicted: number;
  oversized: boolean;
};

export class ToolResultArtifactTooLargeError extends TaggedError(
  "ToolResultArtifactTooLargeError",
)<{
  readonly maxArtifactBytes: number;
  readonly message: string;
}> {}

export class ToolResultArtifactStorageFailure extends TaggedError(
  "ToolResultArtifactStorageFailure",
)<{
  readonly operation: ToolResultArtifactStorageOperation;
  readonly code: string;
  readonly message: string;
}> {}

export class ToolResultArtifactInvalidInput extends TaggedError("ToolResultArtifactInvalidInput")<{
  readonly message: string;
}> {}

export class ToolResultArtifactDecryptAuthenticationFailed extends TaggedError(
  "ToolResultArtifactDecryptAuthenticationFailed",
)<{
  readonly target: "metadata" | "content";
  readonly issueCode: "decrypt-auth-failed";
  readonly message: string;
}> {}

export class ToolResultArtifactContentMismatch extends TaggedError(
  "ToolResultArtifactContentMismatch",
)<{
  readonly issueCode: "content-mismatch";
  readonly message: string;
}> {}

export class ToolResultArtifactUnavailable extends TaggedError("ToolResultArtifactUnavailable")<{
  readonly reason: "invalid-uri" | "absent" | "scope-mismatch" | "expired-or-evicted";
  readonly message: string;
}> {}

export class ToolResultArtifactMaintenanceAndCleanupFailure extends TaggedError(
  "ToolResultArtifactMaintenanceAndCleanupFailure",
)<{
  readonly primaryError: ToolResultArtifactReadError;
  readonly cleanupError: ToolResultArtifactStorageFailure;
  readonly message: string;
}> {}

export class ToolResultArtifactReadAndCleanupFailure extends TaggedError(
  "ToolResultArtifactReadAndCleanupFailure",
)<{
  readonly primaryError: ToolResultArtifactReadOperationError;
  readonly cleanupError: ToolResultArtifactStorageFailure;
  readonly message: string;
}> {}

export class ToolResultArtifactWriteAndCleanupFailure extends TaggedError(
  "ToolResultArtifactWriteAndCleanupFailure",
)<{
  readonly primaryError: ToolResultArtifactWriteOperationError;
  readonly cleanupErrors: readonly ToolResultArtifactStorageFailure[];
  readonly message: string;
}> {}

type ToolResultArtifactStorageOperation =
  | "initialize"
  | "list-metadata"
  | "read-metadata"
  | "read-content"
  | "write-content"
  | "write-metadata"
  | "remove-artifact"
  | "maintenance";

export type ToolResultArtifactDiagnostic = {
  readonly operation: "read-metadata" | "read-content";
  readonly issueCode:
    | ToolResultArtifactMetadataIssueCode
    | "decrypt-auth-failed"
    | "content-mismatch";
  readonly version?: number;
};

export type ToolResultArtifactStoreOptions = {
  readonly onDiagnostic?: (diagnostic: ToolResultArtifactDiagnostic) => void;
};

export type ToolResultArtifactMetadataReadError =
  | ToolResultArtifactMetadataCodecError
  | ToolResultArtifactDecryptAuthenticationFailed
  | ToolResultArtifactStorageFailure;

export type ToolResultArtifactWriteOperationError =
  | ToolResultArtifactMetadataReadError
  | ToolResultArtifactContentMismatch
  | ToolResultArtifactInvalidInput
  | ToolResultArtifactTooLargeError;

export type ToolResultArtifactWriteError =
  | ToolResultArtifactWriteOperationError
  | ToolResultArtifactWriteAndCleanupFailure;

export type ToolResultArtifactReadOperationError =
  | ToolResultArtifactMetadataReadError
  | ToolResultArtifactContentMismatch
  | ToolResultArtifactUnavailable;

export type ToolResultArtifactReadError =
  | ToolResultArtifactReadOperationError
  | ToolResultArtifactReadAndCleanupFailure;

export type ToolResultArtifactError = ToolResultArtifactWriteError | ToolResultArtifactReadError;

export type ToolResultArtifactMaintenanceError =
  | ToolResultArtifactReadError
  | ToolResultArtifactStorageFailure
  | ToolResultArtifactMaintenanceAndCleanupFailure;

export type ToolResultArtifactMaintenanceResult = {
  readonly removedInvalid: number;
  readonly removedExpired: number;
};

export type ToolResultArtifactRead = {
  readonly content: string;
  readonly id: string;
  readonly bytes: number;
  readonly createdAt: number;
  readonly expiresAt: number;
};

export type ToolResultArtifactReadWindow = ToolResultArtifactRead & {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly totalCharacters: number;
  readonly hasMore: boolean;
  readonly nextStart?: ToolResultArtifactStart;
};

export type ToolResultArtifactAvailability<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false };

export type ToolResultArtifactReadMaintenancePolicy =
  | { readonly kind: "none" }
  | {
      readonly kind: "maintain-after-unavailable";
      readonly onMaintenanceError: "reject" | "unavailable";
    };

export type ToolResultArtifactStore = {
  readonly rootDir: string;
  init(): Promise<ResultType<void, ToolResultArtifactError>>;
  create(
    params: CreateToolResultArtifactParams,
  ): Promise<ResultType<CreatedToolResultArtifact, ToolResultArtifactError>>;
  createFromFile(
    params: CreateToolResultArtifactFileParams,
  ): Promise<ResultType<CreatedToolResultArtifact, ToolResultArtifactError>>;
  createFromStream(
    params: CreateToolResultArtifactStreamParams,
  ): Promise<ResultType<CreatedToolResultArtifact, ToolResultArtifactError>>;
  read(
    uri: string,
    scopeId: string,
  ): Promise<ResultType<ToolResultArtifactRead, ToolResultArtifactError>>;
  readWindow(
    uri: string,
    scopeId: string,
    options: {
      start: ToolResultArtifactStart;
      maxCharacters: number;
      maxLines: number;
      /** Maximum payload bytes. Must be at least 4 when set. */
      maxOutputBytes?: number;
    },
  ): Promise<ResultType<ToolResultArtifactReadWindow, ToolResultArtifactError>>;
  maintain(
    now?: number,
  ): Promise<ResultType<ToolResultArtifactMaintenanceResult, ToolResultArtifactMaintenanceError>>;
};

export function adaptToolResultArtifactReadToAvailability<T extends object>(
  result: ResultType<T, ToolResultArtifactError>,
): ToolResultArtifactAvailability<T> {
  if (result.status === "ok") return { ok: true, ...result.value };
  if (result.error instanceof ToolResultArtifactInvalidInput) {
    throw new RangeError(result.error.message);
  }
  return { ok: false };
}

export async function adaptToolResultArtifactReadToUnavailablePolicy<T extends object>(
  store: ToolResultArtifactStore,
  result: ResultType<T, ToolResultArtifactError>,
  policy: ToolResultArtifactReadMaintenancePolicy = {
    kind: "maintain-after-unavailable",
    onMaintenanceError: "unavailable",
  },
): Promise<ToolResultArtifactAvailability<T>> {
  if (
    result.status === "error" &&
    !(result.error instanceof ToolResultArtifactInvalidInput) &&
    policy.kind === "maintain-after-unavailable"
  ) {
    const maintained = await store.maintain();
    if (maintained.status === "error" && policy.onMaintenanceError === "reject") {
      throw maintained.error;
    }
  }
  return adaptToolResultArtifactReadToAvailability(result);
}

export function adaptToolResultArtifactStoreInitToHost(
  result: ResultType<void, ToolResultArtifactError>,
): void {
  if (result.status === "error") throw new Error(result.error.message);
}

function metadataScopeId(metadata: ArtifactMetadata): string {
  return metadata.scopeId;
}

function artifactScopeId(params: ToolResultArtifactScope): string {
  return "scopeId" in params ? params.scopeId : params.sessionId;
}

function maxBytesPerScope(params: ToolResultArtifactScopeLimit): number {
  return "maxBytesPerScope" in params ? params.maxBytesPerScope : params.maxBytesPerSession;
}

type CapturedToolResultEffect<T> =
  | { readonly kind: "completed"; readonly value: T }
  | { readonly kind: "panic"; readonly panic: Panic }
  | { readonly kind: "defect"; readonly error: Error };

function captureToolResultEffect<T>(effect: Promise<T>): Promise<CapturedToolResultEffect<T>> {
  return effect.then(
    (value) => ({ kind: "completed", value }),
    (cause) => {
      try {
        if (Panic.is(cause)) return { kind: "panic", panic: cause };
        if (cause instanceof Error) return { kind: "defect", error: cause };
      } catch {
        return { kind: "defect", error: new Error("Opaque tool-result operation defect") };
      }
      return { kind: "defect", error: new Error("Opaque tool-result operation defect") };
    },
  );
}

function validateHardLimit(
  bytes: number,
  maxArtifactBytes: number | undefined,
): ResultType<void, ToolResultArtifactInvalidInput | ToolResultArtifactTooLargeError> {
  if (
    maxArtifactBytes !== undefined &&
    (!Number.isFinite(maxArtifactBytes) || maxArtifactBytes < 0)
  ) {
    return Result.err(
      new ToolResultArtifactInvalidInput({
        message: "Tool result artifact maxArtifactBytes must be a non-negative finite number",
      }),
    );
  }
  if (maxArtifactBytes !== undefined && bytes > maxArtifactBytes) {
    return Result.err(
      new ToolResultArtifactTooLargeError({
        maxArtifactBytes,
        message: `Tool result artifact exceeds the hard limit of ${maxArtifactBytes} bytes`,
      }),
    );
  }
  return Result.ok(undefined);
}

function artifactIdFromUri(uri: string): string | null {
  if (!uri.startsWith(TOOL_RESULT_URI_PREFIX)) return null;
  const id = uri.slice(TOOL_RESULT_URI_PREFIX.length);
  return /^[0-9a-f-]{36}$/u.test(id) ? id : null;
}

export function createToolResultArtifactStore(
  rootDir: string,
  options: ToolResultArtifactStoreOptions = {},
): ToolResultArtifactStore {
  const resolvedRoot = path.resolve(rootDir);
  const logger = createLogger({ module: "tool-result-artifacts" });
  const encryptionKey = randomBytes(32);
  let operationQueue = Promise.resolve();

  function reportDiagnostic(
    error:
      | ToolResultArtifactMetadataCodecError
      | ToolResultArtifactDecryptAuthenticationFailed
      | ToolResultArtifactContentMismatch,
  ): void {
    let diagnostic: ToolResultArtifactDiagnostic;
    if (error instanceof ToolResultArtifactMetadataUnsupportedVersion) {
      diagnostic = {
        operation: "read-metadata",
        issueCode: error.issueCode,
        version: error.version,
      };
    } else if (error instanceof ToolResultArtifactDecryptAuthenticationFailed) {
      diagnostic = {
        operation: error.target === "metadata" ? "read-metadata" : "read-content",
        issueCode: error.issueCode,
      };
    } else if (error instanceof ToolResultArtifactContentMismatch) {
      diagnostic = { operation: "read-content", issueCode: error.issueCode };
    } else {
      diagnostic = { operation: "read-metadata", issueCode: error.issueCode };
    }
    if (options.onDiagnostic) options.onDiagnostic(diagnostic);
    else logger.warn("tool.artifact.persistence_invalid", diagnostic);
  }

  function storageFailure(
    operation: ToolResultArtifactStorageOperation,
    cause: Error | undefined,
  ): ToolResultArtifactStorageFailure {
    return new ToolResultArtifactStorageFailure({
      operation,
      code: cause === undefined ? "UNKNOWN" : (errorCode(cause) ?? "UNKNOWN"),
      message: `Tool result artifact ${operation} failed`,
    });
  }

  function combineWriteAndCleanupFailure(
    primary: ToolResultArtifactWriteError,
    cleanupError: ToolResultArtifactStorageFailure,
  ): ToolResultArtifactWriteAndCleanupFailure {
    if (primary instanceof ToolResultArtifactWriteAndCleanupFailure) {
      return new ToolResultArtifactWriteAndCleanupFailure({
        primaryError: primary.primaryError,
        cleanupErrors: [...primary.cleanupErrors, cleanupError],
        message: "Tool result artifact write and cleanup failed",
      });
    }
    return new ToolResultArtifactWriteAndCleanupFailure({
      primaryError: primary,
      cleanupErrors: [cleanupError],
      message: "Tool result artifact write and cleanup failed",
    });
  }

  async function captureOperation<T>(
    operation: ToolResultArtifactStorageOperation,
    effect: () => Promise<T>,
  ): Promise<ResultType<T, ToolResultArtifactStorageFailure>> {
    try {
      return Result.ok(await effect());
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      return Result.err(storageFailure(operation, cause instanceof Error ? cause : undefined));
    }
  }

  function applyWriteCleanup(
    primary: ToolResultArtifactWriteError,
    cleanup: ResultType<void, ToolResultArtifactStorageFailure>,
  ): ResultType<never, ToolResultArtifactWriteError> {
    return cleanup.status === "error"
      ? Result.err(combineWriteAndCleanupFailure(primary, cleanup.error))
      : Result.err(primary);
  }

  function applyReadCleanup<T>(
    primary: ResultType<T, ToolResultArtifactReadOperationError>,
    cleanup: ResultType<void, ToolResultArtifactStorageFailure>,
  ): ResultType<T, ToolResultArtifactReadError> {
    if (primary.status === "ok") {
      return cleanup.status === "error" ? Result.err(cleanup.error) : Result.ok(primary.value);
    }
    if (cleanup.status === "ok") return Result.err(primary.error);
    return Result.err(
      new ToolResultArtifactReadAndCleanupFailure({
        primaryError: primary.error,
        cleanupError: cleanup.error,
        message: "Tool result artifact read and cleanup failed",
      }),
    );
  }

  function contentPath(storageKey: string): string {
    return path.join(resolvedRoot, `${storageKey}.bin`);
  }

  function metadataPath(storageKey: string): string {
    return path.join(resolvedRoot, `${storageKey}.meta`);
  }

  function encrypt(
    value: string,
    operation: ToolResultArtifactStorageOperation,
  ): ResultType<Buffer, ToolResultArtifactStorageFailure> {
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Result.ok(Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]));
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      return Result.err(storageFailure(operation, cause instanceof Error ? cause : undefined));
    }
  }

  function decrypt(
    value: Buffer,
    target: "metadata" | "content",
  ): ResultType<string, ToolResultArtifactDecryptAuthenticationFailed> {
    if (value.length < 28) {
      return Result.err(
        new ToolResultArtifactDecryptAuthenticationFailed({
          target,
          issueCode: "decrypt-auth-failed",
          message: `Tool result artifact ${target} authentication failed`,
        }),
      );
    }
    try {
      const nonce = value.subarray(0, 12);
      const authTag = value.subarray(value.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
      decipher.setAuthTag(authTag);
      return Result.ok(
        Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString(
          "utf8",
        ),
      );
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      return Result.err(
        new ToolResultArtifactDecryptAuthenticationFailed({
          target,
          issueCode: "decrypt-auth-failed",
          message: `Tool result artifact ${target} authentication failed`,
        }),
      );
    }
  }

  async function readMetadata(
    storageKey: string,
  ): Promise<ResultType<DecodedToolResultArtifactMetadata, ToolResultArtifactMetadataReadError>> {
    let encrypted: Buffer;
    try {
      encrypted = await fs.readFile(metadataPath(storageKey));
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      if (cause instanceof Error && errorCode(cause) === "ENOENT") {
        const absent = decodeToolResultArtifactMetadata({
          serialized: null,
          expectedStorageKey: storageKey,
        });
        if (absent.status === "error") reportDiagnostic(absent.error);
        return absent;
      }
      return Result.err(
        storageFailure("read-metadata", cause instanceof Error ? cause : undefined),
      );
    }

    const decrypted = decrypt(encrypted, "metadata");
    if (decrypted.status === "error") {
      reportDiagnostic(decrypted.error);
      return Result.err(decrypted.error);
    }
    const decoded = decodeToolResultArtifactMetadata({
      serialized: decrypted.value,
      expectedStorageKey: storageKey,
    });
    if (decoded.status === "error") reportDiagnostic(decoded.error);
    return decoded;
  }

  async function listMetadata(
    ignoredStorageKey?: string,
  ): Promise<ResultType<ArtifactMetadata[], ToolResultArtifactMetadataReadError>> {
    const entries = await captureOperation("list-metadata", () => fs.readdir(resolvedRoot));
    if (entries.status === "error") return Result.err(entries.error);
    const storageKeys = [
      ...new Set(
        entries.value.flatMap((entry) => {
          if (entry.endsWith(".meta")) return [entry.slice(0, -".meta".length)];
          if (entry.endsWith(".bin")) return [entry.slice(0, -".bin".length)];
          return [];
        }),
      ),
    ].filter((storageKey) => storageKey !== ignoredStorageKey);
    const metadata: ArtifactMetadata[] = [];
    for (const storageKey of storageKeys) {
      const item = await readMetadata(storageKey);
      if (item.status === "error") return Result.err(item.error);
      metadata.push(item.value.value);
    }
    return Result.ok(metadata);
  }

  function removeArtifact(
    storageKey: string,
  ): Promise<ResultType<void, ToolResultArtifactStorageFailure>> {
    return captureOperation("remove-artifact", async () => {
      await Promise.all([
        fs.rm(contentPath(storageKey), { force: true }),
        fs.rm(metadataPath(storageKey), { force: true }),
      ]);
    });
  }

  async function removeInvalidArtifact(
    storageKey: string,
    primaryError: ToolResultArtifactReadError,
  ): Promise<ResultType<void, ToolResultArtifactMaintenanceAndCleanupFailure>> {
    const removed = await removeArtifact(storageKey);
    if (removed.status === "error") {
      return Result.err(
        new ToolResultArtifactMaintenanceAndCleanupFailure({
          primaryError,
          cleanupError: removed.error,
          message: "Tool result artifact invalidation cleanup failed",
        }),
      );
    }
    return Result.ok(undefined);
  }

  async function maintainArtifacts(
    now: number,
  ): Promise<ResultType<ToolResultArtifactMaintenanceResult, ToolResultArtifactMaintenanceError>> {
    const entries = await captureOperation("maintenance", () => fs.readdir(resolvedRoot));
    if (entries.status === "error") return Result.err(entries.error);
    const storageKeys = [
      ...new Set(
        entries.value.flatMap((entry) => {
          if (entry.endsWith(".meta")) return [entry.slice(0, -".meta".length)];
          if (entry.endsWith(".bin")) return [entry.slice(0, -".bin".length)];
          return [];
        }),
      ),
    ];
    let removedInvalid = 0;
    let removedExpired = 0;
    for (const storageKey of storageKeys) {
      const decoded = await readMetadata(storageKey);
      if (decoded.status === "error") {
        const removed = await removeInvalidArtifact(storageKey, decoded.error);
        if (removed.status === "error") return Result.err(removed.error);
        removedInvalid += 1;
        continue;
      }
      const metadata = decoded.value.value;
      if (metadata.expiresAt <= now) {
        const removed = await removeArtifact(storageKey);
        if (removed.status === "error") return Result.err(removed.error);
        removedExpired += 1;
        continue;
      }
      const content = await readEncryptedContent(storageKey, metadata.bytes);
      if (content.status === "error") {
        const removed = await removeInvalidArtifact(storageKey, content.error);
        if (removed.status === "error") return Result.err(removed.error);
        removedInvalid += 1;
      }
    }
    if (removedExpired > 0) logger.info("tool.artifact.expired", { count: removedExpired });
    if (removedInvalid > 0) logger.info("tool.artifact.invalid_removed", { count: removedInvalid });
    return Result.ok({ removedInvalid, removedExpired });
  }

  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = operationQueue;
    let release = () => {};
    operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return (async () => {
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    })();
  }

  async function writeAtomic(
    operation: "write-content" | "write-metadata",
    filePath: string,
    content: Uint8Array,
  ): Promise<ResultType<void, ToolResultArtifactWriteError>> {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    const written = await captureOperation(operation, async () => {
      await fs.writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
      await fs.rename(temporaryPath, filePath);
      await fs.chmod(filePath, 0o600);
    });
    if (written.status === "ok") return Result.ok(undefined);
    const cleanup = await captureOperation("remove-artifact", () =>
      fs.rm(temporaryPath, { force: true }),
    );
    return applyWriteCleanup(written.error, cleanup);
  }

  async function writeEncryptedStreamAtomic(
    filePath: string,
    source: Readable,
    maxArtifactBytes?: number,
  ): Promise<ResultType<number, ToolResultArtifactWriteError>> {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
    let bytes = 0;
    const countBytes = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (maxArtifactBytes !== undefined && bytes > maxArtifactBytes) {
          callback(
            new ToolResultArtifactTooLargeError({
              maxArtifactBytes,
              message: `Tool result artifact exceeds the hard limit of ${maxArtifactBytes} bytes`,
            }),
          );
          return;
        }
        callback(null, chunk);
      },
    });
    let written: ResultType<number, ToolResultArtifactWriteOperationError>;
    try {
      await fs.writeFile(temporaryPath, nonce, { mode: 0o600, flag: "wx" });
      await pipeline(
        source,
        countBytes,
        cipher,
        createWriteStream(temporaryPath, { flags: "a", mode: 0o600 }),
      );
      await fs.appendFile(temporaryPath, cipher.getAuthTag());
      await fs.rename(temporaryPath, filePath);
      await fs.chmod(filePath, 0o600);
      written = Result.ok(bytes);
    } catch (cause) {
      if (Panic.is(cause)) {
        await Result.tryPromise({
          try: () => fs.rm(temporaryPath, { force: true }),
          catch: () => undefined,
        });
        throw cause;
      }
      written = Result.err(
        cause instanceof ToolResultArtifactTooLargeError
          ? cause
          : storageFailure("write-content", cause instanceof Error ? cause : undefined),
      );
    }
    if (written.status === "ok") return Result.ok(written.value);
    const cleanup = await captureOperation("remove-artifact", () =>
      fs.rm(temporaryPath, { force: true }),
    );
    return applyWriteCleanup(written.error, cleanup);
  }

  async function createArtifact(
    params: CreateToolResultArtifactBaseParams,
    writeContent: (filePath: string) => Promise<ResultType<number, ToolResultArtifactWriteError>>,
  ): Promise<ResultType<CreatedToolResultArtifact, ToolResultArtifactWriteError>> {
    return exclusive(async () => {
      const now = Date.now();
      const scopeId = artifactScopeId(params);
      const scopeLimit = maxBytesPerScope(params);

      const id = randomUUID();
      const storageKey = randomUUID();
      const writtenContent = await writeContent(contentPath(storageKey));
      if (writtenContent.status === "error") {
        const cleanup = await removeArtifact(storageKey);
        return applyWriteCleanup(writtenContent.error, cleanup);
      }
      const bytes = writtenContent.value;

      const listed = await listMetadata(storageKey);
      if (listed.status === "error") {
        const cleanup = await removeArtifact(storageKey);
        return applyWriteCleanup(listed.error, cleanup);
      }
      const scopeArtifacts = listed.value
        .filter((item) => item.expiresAt > now && metadataScopeId(item) === scopeId)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      let scopeBytes = scopeArtifacts.reduce((sum, item) => sum + item.bytes, 0);
      let evicted = 0;

      if (bytes > scopeLimit) {
        for (const item of scopeArtifacts) {
          const removed = await removeArtifact(item.storageKey);
          if (removed.status === "error") return Result.err(removed.error);
          scopeBytes -= item.bytes;
          evicted += 1;
        }
      } else {
        while (scopeArtifacts.length > 0 && scopeBytes + bytes > scopeLimit) {
          const item = scopeArtifacts.shift();
          if (!item) break;
          const removed = await removeArtifact(item.storageKey);
          if (removed.status === "error") return Result.err(removed.error);
          scopeBytes -= item.bytes;
          evicted += 1;
        }
      }

      const metadata: ArtifactMetadata = {
        id,
        storageKey,
        scopeId,
        requestId: params.requestId,
        toolCallId: params.toolCallId,
        toolName: params.toolName,
        createdAt: now,
        expiresAt: now + params.ttlMs,
        bytes,
      };

      const encryptedMetadata = encrypt(
        encodeToolResultArtifactMetadata(metadata),
        "write-metadata",
      );
      if (encryptedMetadata.status === "error") {
        const cleanup = await removeArtifact(storageKey);
        return applyWriteCleanup(encryptedMetadata.error, cleanup);
      }
      const writtenMetadata = await writeAtomic(
        "write-metadata",
        metadataPath(storageKey),
        encryptedMetadata.value,
      );
      if (writtenMetadata.status === "error") {
        const cleanup = await removeArtifact(storageKey);
        return applyWriteCleanup(writtenMetadata.error, cleanup);
      }

      logger.info("tool.artifact.created", {
        toolName: params.toolName,
        bytes,
        scopeBytes: scopeBytes + bytes,
        evicted,
        oversized: bytes > scopeLimit,
      });
      if (evicted > 0) logger.info("tool.artifact.evicted", { count: evicted });
      if (bytes > scopeLimit) {
        logger.info("tool.artifact.oversized_single", { bytes });
      }

      return Result.ok({
        id,
        uri: `${TOOL_RESULT_URI_PREFIX}${id}`,
        bytes,
        scopeBytes: scopeBytes + bytes,
        sessionBytes: scopeBytes + bytes,
        evicted,
        oversized: bytes > scopeLimit,
      });
    });
  }

  async function readEncryptedWindow(
    storageKey: string,
    expectedBytes: number,
    start: ToolResultArtifactStart,
    maxCharacters: number,
    maxLines: number,
    maxOutputBytes: number,
  ): Promise<
    ResultType<
      {
        content: string;
        startOffset: number;
        endOffset: number;
        totalCharacters: number;
        endLine: number;
        endColumn: number;
      },
      ToolResultArtifactReadError
    >
  > {
    const filePath = contentPath(storageKey);
    const opened = await captureOperation("read-content", () => fs.open(filePath, "r"));
    if (opened.status === "error") return Result.err(opened.error);
    const handle = opened.value;
    const headerOutcome = await captureToolResultEffect(
      captureOperation("read-content", async () => {
        const size = (await handle.stat()).size;
        const nonce = Buffer.alloc(12);
        const authTag = Buffer.alloc(16);
        if (size < 28) return { size, nonce, authTag };
        await handle.read(nonce, 0, nonce.length, 0);
        await handle.read(authTag, 0, authTag.length, size - authTag.length);
        return { size, nonce, authTag };
      }),
    );
    const closeOutcome = await captureToolResultEffect(
      captureOperation("read-content", () => handle.close()),
    );
    if (headerOutcome.kind === "panic") throw headerOutcome.panic;
    if (headerOutcome.kind === "defect") throw headerOutcome.error;
    if (closeOutcome.kind === "panic") throw closeOutcome.panic;
    if (closeOutcome.kind === "defect") throw closeOutcome.error;
    const header = applyReadCleanup(headerOutcome.value, closeOutcome.value);
    if (header.status === "error") return Result.err(header.error);
    const { size, nonce, authTag } = header.value;
    if (size < 28) {
      const error = new ToolResultArtifactContentMismatch({
        issueCode: "content-mismatch",
        message: "Tool result artifact content does not match its metadata",
      });
      reportDiagnostic(error);
      return Result.err(error);
    }

    let decipher: DecipherGCM;
    try {
      decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
      decipher.setAuthTag(authTag);
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      return Result.err(
        new ToolResultArtifactDecryptAuthenticationFailed({
          target: "content",
          issueCode: "decrypt-auth-failed",
          message: "Tool result artifact content authentication failed",
        }),
      );
    }
    const decoder = new StringDecoder("utf8");
    let totalCharacters = 0;
    let line = 1;
    let column = 0;
    let selectedStartOffset: number | undefined;
    let selectedEndOffset: number | undefined;
    let selectedEndLine: number | undefined;
    let selectedEndColumn: number | undefined;
    let selectedLines = 1;
    let selectedBytes = 0;
    const selected: string[] = [];
    const consume = (text: string) => {
      for (const character of text) {
        if (selectedStartOffset === undefined) {
          const reachedStart =
            start.type === "offset"
              ? totalCharacters >= start.offset
              : line === start.line && (column >= (start.column ?? 0) || character === "\n");
          if (reachedStart) selectedStartOffset = totalCharacters;
        }
        let selectionEnds = false;
        if (selectedStartOffset !== undefined && selectedEndOffset === undefined) {
          const characterBytes = Buffer.byteLength(character, "utf8");
          if (selectedBytes + characterBytes > maxOutputBytes) {
            selectedEndOffset = totalCharacters;
            selectedEndLine = line;
            selectedEndColumn = column;
          } else if (character === "\n" && selectedLines >= maxLines) {
            if (start.type === "offset") selected.push(character);
            if (start.type === "offset") selectedBytes += characterBytes;
            selectionEnds = true;
          } else {
            selected.push(character);
            selectedBytes += characterBytes;
            if (selected.length >= maxCharacters) {
              selectionEnds = true;
            } else if (character === "\n") {
              selectedLines += 1;
            }
          }
        }
        totalCharacters += 1;
        if (character === "\n") {
          line += 1;
          column = 0;
        } else {
          column += 1;
        }
        if (selectionEnds) {
          selectedEndOffset = totalCharacters;
          selectedEndLine = line;
          selectedEndColumn = column;
        }
      }
    };

    const ciphertextBytes = size - 28;
    if (ciphertextBytes !== expectedBytes) {
      const error = new ToolResultArtifactContentMismatch({
        issueCode: "content-mismatch",
        message: "Tool result artifact content does not match its metadata",
      });
      reportDiagnostic(error);
      return Result.err(error);
    }
    const ciphertextHandle = await captureOperation("read-content", () => fs.open(filePath, "r"));
    if (ciphertextHandle.status === "error") return Result.err(ciphertextHandle.error);
    const decryptionOutcome = await captureToolResultEffect(
      (async (): Promise<ResultType<void, ToolResultArtifactReadOperationError>> => {
        let decryptionError:
          | ToolResultArtifactStorageFailure
          | ToolResultArtifactDecryptAuthenticationFailed
          | undefined;
        try {
          if (ciphertextBytes > 0) {
            const decrypted = createReadStream(filePath, {
              fd: ciphertextHandle.value.fd,
              autoClose: false,
              start: 12,
              end: size - 17,
            }).pipe(decipher);
            for await (const chunk of decrypted) {
              consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            }
          } else {
            decipher.final();
          }
        } catch (cause) {
          if (Panic.is(cause)) throw cause;
          if (cause instanceof Error) {
            const code = errorCode(cause);
            if (code !== undefined && !code.startsWith("ERR_CRYPTO")) {
              decryptionError = storageFailure("read-content", cause);
            }
          }
          decryptionError ??= new ToolResultArtifactDecryptAuthenticationFailed({
            target: "content",
            issueCode: "decrypt-auth-failed",
            message: "Tool result artifact content authentication failed",
          });
        }
        if (decryptionError !== undefined) {
          if (decryptionError instanceof ToolResultArtifactDecryptAuthenticationFailed) {
            reportDiagnostic(decryptionError);
          }
          return Result.err(decryptionError);
        }
        return Result.ok(undefined);
      })(),
    );
    const ciphertextCloseOutcome = await captureToolResultEffect(
      captureOperation("read-content", () => ciphertextHandle.value.close()),
    );
    if (decryptionOutcome.kind === "panic") throw decryptionOutcome.panic;
    if (decryptionOutcome.kind === "defect") throw decryptionOutcome.error;
    if (ciphertextCloseOutcome.kind === "panic") throw ciphertextCloseOutcome.panic;
    if (ciphertextCloseOutcome.kind === "defect") throw ciphertextCloseOutcome.error;
    const decryption = applyReadCleanup(decryptionOutcome.value, ciphertextCloseOutcome.value);
    if (decryption.status === "error") return Result.err(decryption.error);
    consume(decoder.end());
    const startOffset = selectedStartOffset ?? totalCharacters;
    return Result.ok({
      content: selected.join(""),
      startOffset,
      endOffset: selectedEndOffset ?? totalCharacters,
      totalCharacters,
      endLine: selectedEndLine ?? line,
      endColumn: selectedEndColumn ?? column,
    });
  }

  async function readEncryptedContent(
    storageKey: string,
    expectedBytes: number,
  ): Promise<ResultType<string, ToolResultArtifactReadError>> {
    const encrypted = await captureOperation("read-content", () =>
      fs.readFile(contentPath(storageKey)),
    );
    if (encrypted.status === "error") return Result.err(encrypted.error);
    if (encrypted.value.byteLength - 28 !== expectedBytes) {
      const error = new ToolResultArtifactContentMismatch({
        issueCode: "content-mismatch",
        message: "Tool result artifact content does not match its metadata",
      });
      reportDiagnostic(error);
      return Result.err(error);
    }
    const decrypted = decrypt(encrypted.value, "content");
    if (decrypted.status === "error") reportDiagnostic(decrypted.error);
    return decrypted;
  }

  return {
    rootDir: resolvedRoot,
    async init() {
      return captureOperation("initialize", async () => {
        await fs.mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
        const entries = await fs.readdir(resolvedRoot);
        await Promise.all(
          entries
            .filter(
              (entry) =>
                entry.endsWith(".bin") ||
                entry.endsWith(".meta") ||
                entry.endsWith(".tmp") ||
                entry.endsWith(".txt") ||
                entry.endsWith(".json"),
            )
            .map(async (entry) => {
              const entryPath = path.join(resolvedRoot, entry);
              const entryStat = await fs.lstat(entryPath);
              if (entryStat.isFile() || entryStat.isSymbolicLink()) {
                await fs.rm(entryPath, { force: true });
              }
            }),
        );
      });
    },
    async create(params) {
      const bytes = Buffer.byteLength(params.content, "utf8");
      const hardLimit = validateHardLimit(bytes, params.maxArtifactBytes);
      if (hardLimit.status === "error") return Result.err(hardLimit.error);
      const encrypted = encrypt(params.content, "write-content");
      if (encrypted.status === "error") return Result.err(encrypted.error);
      const { content: _content, ...metadata } = params;
      return createArtifact(metadata, async (filePath) => {
        const written = await writeAtomic("write-content", filePath, encrypted.value);
        return written.status === "error" ? Result.err(written.error) : Result.ok(bytes);
      });
    },
    async createFromFile(params) {
      const configuredLimit = validateHardLimit(0, params.maxArtifactBytes);
      if (configuredLimit.status === "error") return Result.err(configuredLimit.error);
      const sourceStat = await captureOperation("write-content", () => fs.stat(params.sourcePath));
      if (sourceStat.status === "error") return Result.err(sourceStat.error);
      const hardLimit = validateHardLimit(sourceStat.value.size, params.maxArtifactBytes);
      if (hardLimit.status === "error") return Result.err(hardLimit.error);
      const { sourcePath, ...metadata } = params;
      return createArtifact(metadata, async (filePath) => {
        return writeEncryptedStreamAtomic(
          filePath,
          createReadStream(sourcePath),
          params.maxArtifactBytes,
        );
      });
    },
    async createFromStream(params) {
      const hardLimit = validateHardLimit(0, params.maxArtifactBytes);
      if (hardLimit.status === "error") return Result.err(hardLimit.error);
      const { source, ...metadata } = params;
      return createArtifact(metadata, (filePath) =>
        writeEncryptedStreamAtomic(filePath, source, params.maxArtifactBytes),
      );
    },
    async read(uri, scopeId) {
      return exclusive(async () => {
        const now = Date.now();
        const id = artifactIdFromUri(uri);
        if (!id) {
          return Result.err(
            new ToolResultArtifactUnavailable({
              reason: "invalid-uri",
              message: "Tool result artifact URI is invalid",
            }),
          );
        }
        const listed = await listMetadata();
        if (listed.status === "error") return Result.err(listed.error);
        const metadata = listed.value.find((item) => item.id === id);
        if (!metadata) {
          return Result.err(
            new ToolResultArtifactUnavailable({
              reason: "expired-or-evicted",
              message: "Tool result artifact is unavailable",
            }),
          );
        }
        if (metadata.expiresAt <= now) {
          return Result.err(
            new ToolResultArtifactUnavailable({
              reason: "expired-or-evicted",
              message: "Tool result artifact is unavailable",
            }),
          );
        }
        if (metadataScopeId(metadata) !== scopeId) {
          return Result.err(
            new ToolResultArtifactUnavailable({
              reason: "scope-mismatch",
              message: "Tool result artifact is unavailable to this scope",
            }),
          );
        }

        const content = await readEncryptedContent(metadata.storageKey, metadata.bytes);
        if (content.status === "error") return Result.err(content.error);
        logger.info("tool.artifact.read", { bytes: metadata.bytes });
        return Result.ok({
          content: content.value,
          id,
          bytes: metadata.bytes,
          createdAt: metadata.createdAt,
          expiresAt: metadata.expiresAt,
        });
      });
    },
    async readWindow(uri, scopeId, options) {
      if (
        options.maxOutputBytes !== undefined &&
        Number.isFinite(options.maxOutputBytes) &&
        Math.floor(options.maxOutputBytes) < 4
      ) {
        return Result.err(
          new ToolResultArtifactInvalidInput({
            message:
              "Tool result artifact maxOutputBytes must be at least 4 to fit one Unicode character",
          }),
        );
      }
      return exclusive(async () => {
        const now = Date.now();
        const id = artifactIdFromUri(uri);
        if (!id) {
          return Result.err(
            new ToolResultArtifactUnavailable({
              reason: "invalid-uri",
              message: "Tool result artifact URI is invalid",
            }),
          );
        }
        const listed = await listMetadata();
        if (listed.status === "error") return Result.err(listed.error);
        const metadata = listed.value.find((item) => item.id === id);
        if (!metadata) {
          return Result.err(
            new ToolResultArtifactUnavailable({
              reason: "expired-or-evicted",
              message: "Tool result artifact is unavailable",
            }),
          );
        }
        if (metadata.expiresAt <= now) {
          return Result.err(
            new ToolResultArtifactUnavailable({
              reason: "expired-or-evicted",
              message: "Tool result artifact is unavailable",
            }),
          );
        }
        if (metadataScopeId(metadata) !== scopeId) {
          return Result.err(
            new ToolResultArtifactUnavailable({
              reason: "scope-mismatch",
              message: "Tool result artifact is unavailable to this scope",
            }),
          );
        }

        const start: ToolResultArtifactStart =
          options.start.type === "offset"
            ? {
                type: "offset",
                offset: Number.isFinite(options.start.offset)
                  ? Math.max(0, Math.floor(options.start.offset))
                  : 0,
              }
            : {
                type: "line",
                line: Number.isFinite(options.start.line)
                  ? Math.max(1, Math.floor(options.start.line))
                  : 1,
                column:
                  options.start.column !== undefined && Number.isFinite(options.start.column)
                    ? Math.max(0, Math.floor(options.start.column))
                    : 0,
              };
        const requestedCharacters = Number.isFinite(options.maxCharacters)
          ? Math.floor(options.maxCharacters)
          : TOOL_RESULT_MAX_PAGE_CHARACTERS;
        const maxCharacters = Math.min(
          TOOL_RESULT_MAX_PAGE_CHARACTERS,
          Math.max(1, requestedCharacters),
        );
        const maxLines = Number.isFinite(options.maxLines)
          ? Math.max(1, Math.floor(options.maxLines))
          : 1;
        const maxOutputBytes =
          options.maxOutputBytes !== undefined && Number.isFinite(options.maxOutputBytes)
            ? Math.max(1, Math.floor(options.maxOutputBytes))
            : Number.POSITIVE_INFINITY;
        const window = await readEncryptedWindow(
          metadata.storageKey,
          metadata.bytes,
          start,
          maxCharacters,
          maxLines,
          maxOutputBytes,
        );
        if (window.status === "error") return Result.err(window.error);
        const hasMore = window.value.endOffset < window.value.totalCharacters;
        let nextStart: ToolResultArtifactStart | undefined;
        if (hasMore && start.type === "offset") {
          nextStart = { type: "offset", offset: window.value.endOffset };
        } else if (hasMore) {
          nextStart = {
            type: "line",
            line: window.value.endLine,
            column: window.value.endColumn,
          };
        }
        logger.info("tool.artifact.read", { bytes: metadata.bytes });
        return Result.ok({
          content: window.value.content,
          id,
          bytes: metadata.bytes,
          createdAt: metadata.createdAt,
          expiresAt: metadata.expiresAt,
          startOffset: window.value.startOffset,
          endOffset: window.value.endOffset,
          totalCharacters: window.value.totalCharacters,
          hasMore,
          ...(nextStart ? { nextStart } : {}),
        });
      });
    },
    async maintain(now = Date.now()) {
      return exclusive(() => maintainArtifacts(now));
    },
  };
}
