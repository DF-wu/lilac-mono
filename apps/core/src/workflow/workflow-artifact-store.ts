import fs from "node:fs/promises";
import path from "node:path";

import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import { projectRuntimeError } from "../runtime/error-format";
import { preserveToolPanic } from "../tools/tool-result-adapters";
import type { JsonValue } from "./workflow-domain";
import {
  decodeWorkflowValueArtifact,
  encodeWorkflowValueArtifact,
  workflowValueArtifactFileByteLimit,
  type WorkflowArtifactCodecError,
} from "./workflow-artifact-persistence-codec";

export const WORKFLOW_INLINE_VALUE_BYTES = 64 * 1024;
const WORKFLOW_ARTIFACT_PREFIX = "workflow-value:";
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

type WorkflowArtifactIoOperation =
  | "create-root"
  | "inspect-root"
  | "resolve-root"
  | "inspect-artifact"
  | "resolve-artifact"
  | "read-artifact"
  | "open-temporary"
  | "write-temporary"
  | "sync-temporary"
  | "close-temporary"
  | "rename-temporary"
  | "remove-temporary";

export class WorkflowArtifactInvalidId extends TaggedError("WorkflowArtifactInvalidId")<{
  readonly message: string;
}> {}

export class WorkflowArtifactAbsent extends TaggedError("WorkflowArtifactAbsent")<{
  readonly artifactId: string;
  readonly message: string;
}> {}

export class WorkflowArtifactUnsafePath extends TaggedError("WorkflowArtifactUnsafePath")<{
  readonly artifactId: string;
  readonly location: "root" | "artifact";
  readonly issue: "symlink" | "not-directory" | "not-file" | "escaped-root";
  readonly message: string;
}> {}

export class WorkflowArtifactIoFailed extends TaggedError("WorkflowArtifactIoFailed")<{
  readonly artifactId: string;
  readonly operation: WorkflowArtifactIoOperation;
  readonly code: string;
  readonly message: string;
}> {}

export class WorkflowArtifactFileTooLarge extends TaggedError("WorkflowArtifactFileTooLarge")<{
  readonly artifactId: string;
  readonly maxBytes: number;
  readonly message: string;
}> {}

export class WorkflowArtifactValueTooLarge extends TaggedError("WorkflowArtifactValueTooLarge")<{
  readonly artifactId: string;
  readonly maxBytes: number;
  readonly message: string;
}> {}

export class WorkflowArtifactWriteAndCleanupFailed extends TaggedError(
  "WorkflowArtifactWriteAndCleanupFailed",
)<{
  readonly artifactId: string;
  readonly primary: WorkflowArtifactIoFailed;
  readonly cleanup: WorkflowArtifactIoFailed;
  readonly message: string;
}> {}

export type WorkflowArtifactReadError =
  | WorkflowArtifactInvalidId
  | WorkflowArtifactAbsent
  | WorkflowArtifactUnsafePath
  | WorkflowArtifactIoFailed
  | WorkflowArtifactFileTooLarge
  | WorkflowArtifactCodecError;

export type WorkflowArtifactWriteError =
  | WorkflowArtifactInvalidId
  | WorkflowArtifactAbsent
  | WorkflowArtifactUnsafePath
  | WorkflowArtifactIoFailed
  | WorkflowArtifactFileTooLarge
  | WorkflowArtifactValueTooLarge
  | WorkflowArtifactWriteAndCleanupFailed
  | WorkflowArtifactCodecError;

export function adaptWorkflowArtifactResultToException<
  T,
  E extends WorkflowArtifactReadError | WorkflowArtifactWriteError,
>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

function artifactHash(artifactId: string): ResultType<string, WorkflowArtifactInvalidId> {
  if (!artifactId.startsWith(WORKFLOW_ARTIFACT_PREFIX)) {
    return Result.err(
      new WorkflowArtifactInvalidId({ message: "Unsupported workflow value artifact ID" }),
    );
  }
  const hash = artifactId.slice(WORKFLOW_ARTIFACT_PREFIX.length);
  if (!HASH_PATTERN.test(hash)) {
    return Result.err(
      new WorkflowArtifactInvalidId({ message: "Invalid workflow value artifact ID" }),
    );
  }
  return Result.ok(hash);
}

type FilesystemFailureProjection = {
  readonly code: string;
  readonly missing: boolean;
};

function projectFilesystemFailure(cause: unknown): FilesystemFailureProjection {
  let code = "UNKNOWN";
  if (
    cause instanceof Error &&
    "code" in cause &&
    typeof cause.code === "string" &&
    cause.code.length <= 40
  ) {
    code = cause.code;
  }
  return { code, missing: code === "ENOENT" || code === "ENOTDIR" };
}

function rethrowWorkflowArtifactPanic(cause: unknown): void {
  if (Panic.is(cause)) throw cause;
}

async function captureIo<T>(input: {
  readonly artifactId: string;
  readonly operation: WorkflowArtifactIoOperation;
  readonly run: () => Promise<T>;
}): Promise<ResultType<T, WorkflowArtifactIoFailed>> {
  const captured = await Result.tryPromise({
    try: input.run,
    catch: projectRuntimeError(`Opaque workflow artifact ${input.operation} failure`),
  });
  if (captured.status === "ok") return Result.ok(captured.value);
  const cause = preserveToolPanic(captured.error);
  const failure = projectFilesystemFailure(cause);
  return Result.err(
    new WorkflowArtifactIoFailed({
      artifactId: input.artifactId,
      operation: input.operation,
      code: failure.code,
      message: `Workflow value artifact I/O failed during ${input.operation}`,
    }),
  );
}

async function lstatOrMissing(input: {
  readonly artifactId: string;
  readonly filePath: string;
}): Promise<ResultType<Awaited<ReturnType<typeof fs.lstat>> | null, WorkflowArtifactIoFailed>> {
  try {
    return Result.ok(await fs.lstat(input.filePath));
  } catch (cause) {
    rethrowWorkflowArtifactPanic(cause);
    const failure = projectFilesystemFailure(cause);
    if (failure.missing) return Result.ok(null);
    return Result.err(
      new WorkflowArtifactIoFailed({
        artifactId: input.artifactId,
        operation: "inspect-artifact",
        code: failure.code,
        message: "Workflow value artifact I/O failed during inspect-artifact",
      }),
    );
  }
}

async function artifactRoot(input: {
  readonly dataDir: string;
  readonly artifactId: string;
  readonly create: boolean;
}): Promise<
  ResultType<string, WorkflowArtifactAbsent | WorkflowArtifactUnsafePath | WorkflowArtifactIoFailed>
> {
  const root = path.resolve(input.dataDir, "workflow-artifacts");
  if (input.create) {
    const created = await captureIo({
      artifactId: input.artifactId,
      operation: "create-root",
      run: () => fs.mkdir(root, { recursive: true, mode: 0o700 }),
    });
    if (created.status === "error") return Result.err(created.error);
  }
  const inspected = await Result.tryPromise({
    try: () => fs.lstat(root),
    catch: (cause) => {
      rethrowWorkflowArtifactPanic(cause);
      const failure = projectFilesystemFailure(cause);
      if (!input.create && failure.missing) {
        return new WorkflowArtifactAbsent({
          artifactId: input.artifactId,
          message: "Workflow value artifact is absent",
        });
      }
      return new WorkflowArtifactIoFailed({
        artifactId: input.artifactId,
        operation: "inspect-root",
        code: failure.code,
        message: "Workflow value artifact I/O failed during inspect-root",
      });
    },
  });
  if (inspected.status === "error") return Result.err(inspected.error);
  if (inspected.value.isSymbolicLink()) {
    return Result.err(
      new WorkflowArtifactUnsafePath({
        artifactId: input.artifactId,
        location: "root",
        issue: "symlink",
        message: "Workflow value artifact root cannot be a symlink",
      }),
    );
  }
  if (!inspected.value.isDirectory()) {
    return Result.err(
      new WorkflowArtifactUnsafePath({
        artifactId: input.artifactId,
        location: "root",
        issue: "not-directory",
        message: "Workflow value artifact root is not a directory",
      }),
    );
  }
  const resolved = await captureIo({
    artifactId: input.artifactId,
    operation: "resolve-root",
    run: () => fs.realpath(root),
  });
  if (resolved.status === "error") return Result.err(resolved.error);
  return Result.ok(resolved.value);
}

async function removeTemporary(
  artifactId: string,
  temporaryPath: string,
): Promise<ResultType<void, WorkflowArtifactIoFailed>> {
  const removed = await captureIo({
    artifactId,
    operation: "remove-temporary",
    run: () => fs.rm(temporaryPath, { force: true }),
  });
  if (removed.status === "error") return Result.err(removed.error);
  return Result.ok(undefined);
}

function combineWriteAndCleanup(
  artifactId: string,
  primary: WorkflowArtifactIoFailed,
  cleanup: ResultType<void, WorkflowArtifactIoFailed>,
): ResultType<never, WorkflowArtifactIoFailed | WorkflowArtifactWriteAndCleanupFailed> {
  if (cleanup.status === "ok") return Result.err(primary);
  return Result.err(
    new WorkflowArtifactWriteAndCleanupFailed({
      artifactId,
      primary,
      cleanup: cleanup.error,
      message: "Workflow value artifact write and temporary-file cleanup both failed",
    }),
  );
}

export async function writeWorkflowValueArtifact(input: {
  dataDir: string;
  value: JsonValue;
  maxBytes: number;
}): Promise<ResultType<string, WorkflowArtifactWriteError>> {
  const encoded = encodeWorkflowValueArtifact(input.value);
  const artifactId = `${WORKFLOW_ARTIFACT_PREFIX}${encoded.payloadHash}`;
  if (encoded.payloadBytes > input.maxBytes) {
    return Result.err(
      new WorkflowArtifactValueTooLarge({
        artifactId,
        maxBytes: input.maxBytes,
        message: `Workflow value exceeds ${input.maxBytes} bytes`,
      }),
    );
  }
  const root = await artifactRoot({ dataDir: input.dataDir, artifactId, create: true });
  if (root.status === "error") return Result.err(root.error);
  const artifactPath = path.join(root.value, `${encoded.payloadHash}.json`);
  const existing = await lstatOrMissing({ artifactId, filePath: artifactPath });
  if (existing.status === "error") return Result.err(existing.error);
  if (existing.value !== null) {
    const stored = await readWorkflowValueArtifact({
      dataDir: input.dataDir,
      artifactId,
      maxBytes: input.maxBytes,
    });
    if (stored.status === "error") return Result.err(stored.error);
    return Result.ok(artifactId);
  }

  const temporaryPath = path.join(root.value, `.${encoded.payloadHash}.${crypto.randomUUID()}.tmp`);
  const opened = await captureIo({
    artifactId,
    operation: "open-temporary",
    run: () => fs.open(temporaryPath, "wx", 0o600),
  });
  if (opened.status === "error") return Result.err(opened.error);
  const handle = opened.value;
  const written = await captureIo({
    artifactId,
    operation: "write-temporary",
    run: () => handle.writeFile(encoded.encoded, "utf8"),
  });
  const synced =
    written.status === "ok"
      ? await captureIo({
          artifactId,
          operation: "sync-temporary",
          run: () => handle.sync(),
        })
      : written;
  const closed = await captureIo({
    artifactId,
    operation: "close-temporary",
    run: () => handle.close(),
  });
  let primary = closed;
  if (written.status === "error") primary = written;
  else if (synced.status === "error") primary = synced;
  if (primary.status === "error") {
    return combineWriteAndCleanup(
      artifactId,
      primary.error,
      await removeTemporary(artifactId, temporaryPath),
    );
  }
  const renamed = await captureIo({
    artifactId,
    operation: "rename-temporary",
    run: () => fs.rename(temporaryPath, artifactPath),
  });
  if (renamed.status === "error") {
    return combineWriteAndCleanup(
      artifactId,
      renamed.error,
      await removeTemporary(artifactId, temporaryPath),
    );
  }

  const verified = await readWorkflowValueArtifact({
    dataDir: input.dataDir,
    artifactId,
    maxBytes: input.maxBytes,
  });
  if (verified.status === "error") {
    throw new Panic({
      message: "Atomic workflow value artifact publication could not be verified",
      cause: verified.error,
    });
  }
  return Result.ok(artifactId);
}

export async function readWorkflowValueArtifact(input: {
  dataDir: string;
  artifactId: string;
  maxBytes: number;
}): Promise<ResultType<JsonValue, WorkflowArtifactReadError>> {
  const hash = artifactHash(input.artifactId);
  if (hash.status === "error") return Result.err(hash.error);
  const root = await artifactRoot({
    dataDir: input.dataDir,
    artifactId: input.artifactId,
    create: false,
  });
  if (root.status === "error") return Result.err(root.error);
  const artifactPath = path.join(root.value, `${hash.value}.json`);
  const inspected = await lstatOrMissing({
    artifactId: input.artifactId,
    filePath: artifactPath,
  });
  if (inspected.status === "error") return Result.err(inspected.error);
  if (inspected.value === null) {
    return Result.err(
      new WorkflowArtifactAbsent({
        artifactId: input.artifactId,
        message: "Workflow value artifact is absent",
      }),
    );
  }
  if (inspected.value.isSymbolicLink()) {
    return Result.err(
      new WorkflowArtifactUnsafePath({
        artifactId: input.artifactId,
        location: "artifact",
        issue: "symlink",
        message: "Workflow value artifact cannot be a symlink",
      }),
    );
  }
  if (!inspected.value.isFile()) {
    return Result.err(
      new WorkflowArtifactUnsafePath({
        artifactId: input.artifactId,
        location: "artifact",
        issue: "not-file",
        message: "Workflow value artifact is not a regular file",
      }),
    );
  }
  if (inspected.value.size > workflowValueArtifactFileByteLimit(input.maxBytes)) {
    return Result.err(
      new WorkflowArtifactFileTooLarge({
        artifactId: input.artifactId,
        maxBytes: input.maxBytes,
        message: "Workflow value artifact file exceeds its bounded size",
      }),
    );
  }
  const canonical = await captureIo({
    artifactId: input.artifactId,
    operation: "resolve-artifact",
    run: () => fs.realpath(artifactPath),
  });
  if (canonical.status === "error") return Result.err(canonical.error);
  if (path.dirname(canonical.value) !== root.value) {
    return Result.err(
      new WorkflowArtifactUnsafePath({
        artifactId: input.artifactId,
        location: "artifact",
        issue: "escaped-root",
        message: "Workflow value artifact escapes its canonical root",
      }),
    );
  }
  const source = await captureIo({
    artifactId: input.artifactId,
    operation: "read-artifact",
    run: () => fs.readFile(canonical.value, "utf8"),
  });
  if (source.status === "error") return Result.err(source.error);
  if (
    Buffer.byteLength(source.value, "utf8") > workflowValueArtifactFileByteLimit(input.maxBytes)
  ) {
    return Result.err(
      new WorkflowArtifactFileTooLarge({
        artifactId: input.artifactId,
        maxBytes: input.maxBytes,
        message: "Workflow value artifact file exceeds its bounded size",
      }),
    );
  }
  const decoded = decodeWorkflowValueArtifact({
    encoded: source.value,
    expectedHash: hash.value,
    maxValueBytes: input.maxBytes,
    artifactId: input.artifactId,
  });
  if (decoded.status === "error") return Result.err(decoded.error);
  return Result.ok(decoded.value.value);
}
