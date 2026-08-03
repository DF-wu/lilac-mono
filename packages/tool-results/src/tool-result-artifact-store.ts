import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
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
  ToolResultArtifactMetadataAbsent,
  ToolResultArtifactMetadataCorrupt,
  ToolResultArtifactMetadataMalformed,
  ToolResultArtifactMetadataStorageKeyMismatch,
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

type ToolResultArtifactScope =
  | { scopeId: string; sessionId?: string }
  | { scopeId?: string; sessionId: string };

type ToolResultArtifactScopeLimit =
  | { maxBytesPerScope: number; maxBytesPerSession?: number }
  | { maxBytesPerScope?: number; maxBytesPerSession: number };

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

export class ToolResultArtifactTooLargeError extends Error {
  readonly maxArtifactBytes: number;

  constructor(maxArtifactBytes: number) {
    super(`Tool result artifact exceeds the hard limit of ${maxArtifactBytes} bytes`);
    this.name = "ToolResultArtifactTooLargeError";
    this.maxArtifactBytes = maxArtifactBytes;
  }
}

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

export type ToolResultArtifactWriteError =
  | ToolResultArtifactMetadataReadError
  | ToolResultArtifactContentMismatch
  | ToolResultArtifactInvalidInput
  | ToolResultArtifactTooLargeError;

export type ToolResultArtifactReadError =
  | ToolResultArtifactMetadataReadError
  | ToolResultArtifactContentMismatch
  | ToolResultArtifactUnavailable;

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
): Promise<ToolResultArtifactAvailability<T>> {
  if (result.status === "error" && !(result.error instanceof ToolResultArtifactInvalidInput)) {
    await store.maintain();
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
  const scopeId = params.scopeId ?? params.sessionId;
  if (!scopeId) throw new Error("Tool result artifact scopeId is required");
  return scopeId;
}

function maxBytesPerScope(params: ToolResultArtifactScopeLimit): number {
  const maxBytes = params.maxBytesPerScope ?? params.maxBytesPerSession;
  if (maxBytes === undefined) throw new Error("Tool result artifact maxBytesPerScope is required");
  return maxBytes;
}

function assertWithinHardLimit(bytes: number, maxArtifactBytes: number | undefined): void {
  if (
    maxArtifactBytes !== undefined &&
    (!Number.isFinite(maxArtifactBytes) || maxArtifactBytes < 0)
  ) {
    throw new RangeError(
      "Tool result artifact maxArtifactBytes must be a non-negative finite number",
    );
  }
  if (maxArtifactBytes !== undefined && bytes > maxArtifactBytes) {
    throw new ToolResultArtifactTooLargeError(maxArtifactBytes);
  }
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
    cause: Error,
  ): ToolResultArtifactStorageFailure {
    return new ToolResultArtifactStorageFailure({
      operation,
      code: errorCode(cause) ?? "UNKNOWN",
      message: `Tool result artifact ${operation} failed`,
    });
  }

  async function rethrowAfterCleanup(primary: Error, cleanup: () => Promise<void>): Promise<never> {
    try {
      await cleanup();
    } catch (cleanupCause) {
      if (Panic.is(primary)) throw primary;
      if (Panic.is(cleanupCause)) throw cleanupCause;
      throw new Panic({
        message: "Tool result artifact failure cleanup did not complete",
        cause: { primary, cleanupCause },
      });
    }
    throw primary;
  }

  async function captureOperation<T>(
    operation: ToolResultArtifactStorageOperation,
    effect: () => Promise<T>,
  ): Promise<ResultType<T, ToolResultArtifactError>> {
    try {
      return Result.ok(await effect());
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      if (
        cause instanceof ToolResultArtifactMetadataAbsent ||
        cause instanceof ToolResultArtifactMetadataUnsupportedVersion ||
        cause instanceof ToolResultArtifactMetadataMalformed ||
        cause instanceof ToolResultArtifactMetadataCorrupt ||
        cause instanceof ToolResultArtifactMetadataStorageKeyMismatch ||
        cause instanceof ToolResultArtifactDecryptAuthenticationFailed ||
        cause instanceof ToolResultArtifactContentMismatch ||
        cause instanceof ToolResultArtifactUnavailable ||
        cause instanceof ToolResultArtifactStorageFailure ||
        cause instanceof ToolResultArtifactTooLargeError ||
        cause instanceof ToolResultArtifactInvalidInput
      ) {
        return Result.err(cause);
      }
      if (cause instanceof RangeError) {
        return Result.err(new ToolResultArtifactInvalidInput({ message: cause.message }));
      }
      if (cause instanceof Error) return Result.err(storageFailure(operation, cause));
      throw cause;
    }
  }

  function contentPath(storageKey: string): string {
    return path.join(resolvedRoot, `${storageKey}.bin`);
  }

  function metadataPath(storageKey: string): string {
    return path.join(resolvedRoot, `${storageKey}.meta`);
  }

  function encrypt(value: string): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
  }

  function decrypt(value: Buffer): string {
    if (value.length < 28) throw new Error("Invalid encrypted artifact");
    const nonce = value.subarray(0, 12);
    const authTag = value.subarray(value.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString(
      "utf8",
    );
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
      if (cause instanceof Error) return Result.err(storageFailure("read-metadata", cause));
      throw cause;
    }

    let serialized: string;
    try {
      serialized = decrypt(encrypted);
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      const error = new ToolResultArtifactDecryptAuthenticationFailed({
        target: "metadata",
        issueCode: "decrypt-auth-failed",
        message: "Tool result artifact metadata authentication failed",
      });
      reportDiagnostic(error);
      return Result.err(error);
    }
    const decoded = decodeToolResultArtifactMetadata({
      serialized,
      expectedStorageKey: storageKey,
    });
    if (decoded.status === "error") reportDiagnostic(decoded.error);
    return decoded;
  }

  async function listMetadata(ignoredStorageKey?: string): Promise<ArtifactMetadata[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(resolvedRoot);
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      if (cause instanceof Error) throw storageFailure("list-metadata", cause);
      throw cause;
    }

    const metadata = await Promise.all(
      [
        ...new Set(
          entries.flatMap((entry) => {
            if (entry.endsWith(".meta")) return [entry.slice(0, -".meta".length)];
            if (entry.endsWith(".bin")) return [entry.slice(0, -".bin".length)];
            return [];
          }),
        ),
      ]
        .filter((storageKey) => storageKey !== ignoredStorageKey)
        .map(async (storageKey) => {
          const item = await readMetadata(storageKey);
          if (item.status === "error") throw item.error;
          return item.value.value;
        }),
    );
    return metadata;
  }

  async function removeArtifact(storageKey: string): Promise<void> {
    await Promise.all([
      fs.rm(contentPath(storageKey), { force: true }),
      fs.rm(metadataPath(storageKey), { force: true }),
    ]);
  }

  function maintenancePrimaryError(cause: Error): ToolResultArtifactReadError {
    if (
      cause instanceof ToolResultArtifactMetadataAbsent ||
      cause instanceof ToolResultArtifactMetadataUnsupportedVersion ||
      cause instanceof ToolResultArtifactMetadataMalformed ||
      cause instanceof ToolResultArtifactMetadataCorrupt ||
      cause instanceof ToolResultArtifactMetadataStorageKeyMismatch ||
      cause instanceof ToolResultArtifactDecryptAuthenticationFailed ||
      cause instanceof ToolResultArtifactContentMismatch ||
      cause instanceof ToolResultArtifactStorageFailure ||
      cause instanceof ToolResultArtifactUnavailable
    ) {
      return cause;
    }
    return storageFailure("maintenance", cause);
  }

  async function removeInvalidArtifact(
    storageKey: string,
    primaryError: ToolResultArtifactReadError,
  ): Promise<void> {
    try {
      await removeArtifact(storageKey);
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      if (!(cause instanceof Error)) throw cause;
      throw new ToolResultArtifactMaintenanceAndCleanupFailure({
        primaryError,
        cleanupError: storageFailure("remove-artifact", cause),
        message: "Tool result artifact invalidation cleanup failed",
      });
    }
  }

  async function maintainArtifacts(now: number): Promise<ToolResultArtifactMaintenanceResult> {
    let entries: string[];
    try {
      entries = await fs.readdir(resolvedRoot);
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      if (cause instanceof Error) throw storageFailure("maintenance", cause);
      throw cause;
    }
    const storageKeys = [
      ...new Set(
        entries.flatMap((entry) => {
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
        await removeInvalidArtifact(storageKey, decoded.error);
        removedInvalid += 1;
        continue;
      }
      const metadata = decoded.value.value;
      if (metadata.expiresAt <= now) {
        try {
          await removeArtifact(storageKey);
        } catch (cause) {
          if (Panic.is(cause)) throw cause;
          if (cause instanceof Error) throw storageFailure("remove-artifact", cause);
          throw cause;
        }
        removedExpired += 1;
        continue;
      }
      try {
        await readEncryptedContent(storageKey, metadata.bytes);
      } catch (cause) {
        if (Panic.is(cause)) throw cause;
        if (!(cause instanceof Error)) throw cause;
        await removeInvalidArtifact(storageKey, maintenancePrimaryError(cause));
        removedInvalid += 1;
      }
    }
    if (removedExpired > 0) logger.info("tool.artifact.expired", { count: removedExpired });
    if (removedInvalid > 0) logger.info("tool.artifact.invalid_removed", { count: removedInvalid });
    return { removedInvalid, removedExpired };
  }

  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function writeAtomic(filePath: string, content: Uint8Array): Promise<void> {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
      await fs.rename(temporaryPath, filePath);
      await fs.chmod(filePath, 0o600);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return rethrowAfterCleanup(error, () => fs.rm(temporaryPath, { force: true }));
    }
  }

  async function writeEncryptedStreamAtomic(
    filePath: string,
    source: Readable,
    maxArtifactBytes?: number,
  ): Promise<number> {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
    let bytes = 0;
    const countBytes = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (maxArtifactBytes !== undefined && bytes > maxArtifactBytes) {
          callback(new ToolResultArtifactTooLargeError(maxArtifactBytes));
          return;
        }
        callback(null, chunk);
      },
    });
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
      return bytes;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return rethrowAfterCleanup(error, () => fs.rm(temporaryPath, { force: true }));
    }
  }

  async function createArtifact(
    params: CreateToolResultArtifactBaseParams,
    writeContent: (filePath: string) => Promise<number>,
  ): Promise<CreatedToolResultArtifact> {
    return exclusive(async () => {
      assertWithinHardLimit(0, params.maxArtifactBytes);
      const now = Date.now();
      const scopeId = artifactScopeId(params);
      const scopeLimit = maxBytesPerScope(params);

      const id = randomUUID();
      const storageKey = randomUUID();
      let bytes: number;
      try {
        bytes = await writeContent(contentPath(storageKey));
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return rethrowAfterCleanup(error, () => removeArtifact(storageKey));
      }

      const scopeArtifacts = (await listMetadata(storageKey))
        .filter((item) => item.expiresAt > now && metadataScopeId(item) === scopeId)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      let scopeBytes = scopeArtifacts.reduce((sum, item) => sum + item.bytes, 0);
      let evicted = 0;

      if (bytes > scopeLimit) {
        for (const item of scopeArtifacts) {
          await removeArtifact(item.storageKey);
          scopeBytes -= item.bytes;
          evicted += 1;
        }
      } else {
        while (scopeArtifacts.length > 0 && scopeBytes + bytes > scopeLimit) {
          const item = scopeArtifacts.shift();
          if (!item) break;
          await removeArtifact(item.storageKey);
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

      try {
        await writeAtomic(
          metadataPath(storageKey),
          encrypt(encodeToolResultArtifactMetadata(metadata)),
        );
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return rethrowAfterCleanup(error, () => removeArtifact(storageKey));
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

      return {
        id,
        uri: `${TOOL_RESULT_URI_PREFIX}${id}`,
        bytes,
        scopeBytes: scopeBytes + bytes,
        sessionBytes: scopeBytes + bytes,
        evicted,
        oversized: bytes > scopeLimit,
      };
    });
  }

  async function readEncryptedWindow(
    storageKey: string,
    expectedBytes: number,
    start: ToolResultArtifactStart,
    maxCharacters: number,
    maxLines: number,
    maxOutputBytes: number,
  ): Promise<{
    content: string;
    startOffset: number;
    endOffset: number;
    totalCharacters: number;
    endLine: number;
    endColumn: number;
  }> {
    const filePath = contentPath(storageKey);
    const handle = await fs.open(filePath, "r");
    let size: number;
    let nonce: Buffer;
    let authTag: Buffer;
    try {
      size = (await handle.stat()).size;
      if (size < 28) {
        const error = new ToolResultArtifactContentMismatch({
          issueCode: "content-mismatch",
          message: "Tool result artifact content does not match its metadata",
        });
        reportDiagnostic(error);
        throw error;
      }
      nonce = Buffer.alloc(12);
      authTag = Buffer.alloc(16);
      await handle.read(nonce, 0, nonce.length, 0);
      await handle.read(authTag, 0, authTag.length, size - authTag.length);
    } finally {
      await handle.close();
    }

    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
    decipher.setAuthTag(authTag);
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
      throw error;
    }
    try {
      if (ciphertextBytes > 0) {
        const decrypted = createReadStream(filePath, { start: 12, end: size - 17 }).pipe(decipher);
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
          throw storageFailure("read-content", cause);
        }
      }
      const error = new ToolResultArtifactDecryptAuthenticationFailed({
        target: "content",
        issueCode: "decrypt-auth-failed",
        message: "Tool result artifact content authentication failed",
      });
      reportDiagnostic(error);
      throw error;
    }
    consume(decoder.end());
    const startOffset = selectedStartOffset ?? totalCharacters;
    return {
      content: selected.join(""),
      startOffset,
      endOffset: selectedEndOffset ?? totalCharacters,
      totalCharacters,
      endLine: selectedEndLine ?? line,
      endColumn: selectedEndColumn ?? column,
    };
  }

  async function readEncryptedContent(storageKey: string, expectedBytes: number): Promise<string> {
    let encrypted: Buffer;
    try {
      encrypted = await fs.readFile(contentPath(storageKey));
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      if (cause instanceof Error) throw storageFailure("read-content", cause);
      throw cause;
    }
    if (encrypted.byteLength - 28 !== expectedBytes) {
      const error = new ToolResultArtifactContentMismatch({
        issueCode: "content-mismatch",
        message: "Tool result artifact content does not match its metadata",
      });
      reportDiagnostic(error);
      throw error;
    }
    try {
      return decrypt(encrypted);
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      const error = new ToolResultArtifactDecryptAuthenticationFailed({
        target: "content",
        issueCode: "decrypt-auth-failed",
        message: "Tool result artifact content authentication failed",
      });
      reportDiagnostic(error);
      throw error;
    }
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
      return captureOperation("write-content", async () => {
        const { content, ...metadata } = params;
        return createArtifact(metadata, async (filePath) => {
          const bytes = Buffer.byteLength(content, "utf8");
          assertWithinHardLimit(bytes, params.maxArtifactBytes);
          await writeAtomic(filePath, encrypt(content));
          return bytes;
        });
      });
    },
    async createFromFile(params) {
      return captureOperation("write-content", async () => {
        const { sourcePath, ...metadata } = params;
        return createArtifact(metadata, async (filePath) => {
          const sourceBytes = (await fs.stat(sourcePath)).size;
          assertWithinHardLimit(sourceBytes, params.maxArtifactBytes);
          return writeEncryptedStreamAtomic(
            filePath,
            createReadStream(sourcePath),
            params.maxArtifactBytes,
          );
        });
      });
    },
    async createFromStream(params) {
      return captureOperation("write-content", async () => {
        const { source, ...metadata } = params;
        return createArtifact(metadata, (filePath) =>
          writeEncryptedStreamAtomic(filePath, source, params.maxArtifactBytes),
        );
      });
    },
    async read(uri, scopeId) {
      return captureOperation("read-content", () =>
        exclusive(async () => {
          const now = Date.now();
          const id = artifactIdFromUri(uri);
          if (!id) {
            throw new ToolResultArtifactUnavailable({
              reason: "invalid-uri",
              message: "Tool result artifact URI is invalid",
            });
          }
          const metadata = (await listMetadata()).find((item) => item.id === id);
          if (!metadata) {
            throw new ToolResultArtifactUnavailable({
              reason: "expired-or-evicted",
              message: "Tool result artifact is unavailable",
            });
          }
          if (metadata.expiresAt <= now) {
            throw new ToolResultArtifactUnavailable({
              reason: "expired-or-evicted",
              message: "Tool result artifact is unavailable",
            });
          }
          if (metadataScopeId(metadata) !== scopeId) {
            throw new ToolResultArtifactUnavailable({
              reason: "scope-mismatch",
              message: "Tool result artifact is unavailable to this scope",
            });
          }

          const content = await readEncryptedContent(metadata.storageKey, metadata.bytes);
          logger.info("tool.artifact.read", { bytes: metadata.bytes });
          return {
            content,
            id,
            bytes: metadata.bytes,
            createdAt: metadata.createdAt,
            expiresAt: metadata.expiresAt,
          };
        }),
      );
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
      return captureOperation("read-content", () =>
        exclusive(async () => {
          const now = Date.now();
          const id = artifactIdFromUri(uri);
          if (!id) {
            throw new ToolResultArtifactUnavailable({
              reason: "invalid-uri",
              message: "Tool result artifact URI is invalid",
            });
          }
          const metadata = (await listMetadata()).find((item) => item.id === id);
          if (!metadata) {
            throw new ToolResultArtifactUnavailable({
              reason: "expired-or-evicted",
              message: "Tool result artifact is unavailable",
            });
          }
          if (metadata.expiresAt <= now) {
            throw new ToolResultArtifactUnavailable({
              reason: "expired-or-evicted",
              message: "Tool result artifact is unavailable",
            });
          }
          if (metadataScopeId(metadata) !== scopeId) {
            throw new ToolResultArtifactUnavailable({
              reason: "scope-mismatch",
              message: "Tool result artifact is unavailable to this scope",
            });
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
          const hasMore = window.endOffset < window.totalCharacters;
          let nextStart: ToolResultArtifactStart | undefined;
          if (hasMore && start.type === "offset") {
            nextStart = { type: "offset", offset: window.endOffset };
          } else if (hasMore) {
            nextStart = { type: "line", line: window.endLine, column: window.endColumn };
          }
          logger.info("tool.artifact.read", { bytes: metadata.bytes });
          return {
            content: window.content,
            id,
            bytes: metadata.bytes,
            createdAt: metadata.createdAt,
            expiresAt: metadata.expiresAt,
            startOffset: window.startOffset,
            endOffset: window.endOffset,
            totalCharacters: window.totalCharacters,
            hasMore,
            ...(nextStart ? { nextStart } : {}),
          };
        }),
      );
    },
    async maintain(now = Date.now()) {
      try {
        return Result.ok(await exclusive(() => maintainArtifacts(now)));
      } catch (cause) {
        if (Panic.is(cause)) throw cause;
        if (
          cause instanceof ToolResultArtifactMaintenanceAndCleanupFailure ||
          cause instanceof ToolResultArtifactStorageFailure ||
          cause instanceof ToolResultArtifactMetadataAbsent ||
          cause instanceof ToolResultArtifactMetadataUnsupportedVersion ||
          cause instanceof ToolResultArtifactMetadataMalformed ||
          cause instanceof ToolResultArtifactMetadataCorrupt ||
          cause instanceof ToolResultArtifactMetadataStorageKeyMismatch ||
          cause instanceof ToolResultArtifactDecryptAuthenticationFailed ||
          cause instanceof ToolResultArtifactContentMismatch ||
          cause instanceof ToolResultArtifactUnavailable
        ) {
          return Result.err(cause);
        }
        if (cause instanceof Error) return Result.err(storageFailure("maintenance", cause));
        throw cause;
      }
    },
  };
}
