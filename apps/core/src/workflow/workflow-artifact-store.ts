import {
  materializeBlobRead,
  type BlobDeleteError,
  type BlobReadError,
  type BlobReadTerminalError,
  type BlobRefV1,
  type BlobStore,
  type BlobUploadStartError,
  type BlobWriteError,
} from "@stanley2058/lilac-blob-storage";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { adaptToolResultToHost } from "../tools/tool-result-adapters";
import {
  DurableWorkflowInvariantViolation,
  type DurableWorkflowReadError,
  type DurableWorkflowStore,
} from "./durable-workflow-store";
import {
  decodeWorkflowValueArtifact,
  encodeWorkflowArtifactReference,
  encodeWorkflowValueArtifact,
  workflowValueArtifactFileByteLimit,
  type WorkflowArtifactCodecError,
} from "./workflow-artifact-persistence-codec";
import { sha256 } from "./workflow-definition";
import type { JsonValue, WorkflowArtifactReference } from "./workflow-domain";

export const WORKFLOW_INLINE_VALUE_BYTES = 64 * 1024;
const WORKFLOW_VALUE_ARTIFACT_PREFIX = "workflow-value:";
const WORKFLOW_SOURCE_ARTIFACT_PREFIX = "workflow-source:";
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

type WorkflowArtifactIoOperation =
  | "lookup-artifact"
  | "register-artifact"
  | "start-upload"
  | "complete-upload"
  | "open-artifact"
  | "read-artifact"
  | "delete-artifact";

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
  return adaptToolResultToHost(result);
}

function artifactHash(
  artifactId: string,
  prefix: typeof WORKFLOW_VALUE_ARTIFACT_PREFIX | typeof WORKFLOW_SOURCE_ARTIFACT_PREFIX,
): ResultType<string, WorkflowArtifactInvalidId> {
  if (!artifactId.startsWith(prefix)) {
    return Result.err(
      new WorkflowArtifactInvalidId({ message: "Unsupported workflow artifact ID" }),
    );
  }
  const hash = artifactId.slice(prefix.length);
  return HASH_PATTERN.test(hash)
    ? Result.ok(hash)
    : Result.err(new WorkflowArtifactInvalidId({ message: "Invalid workflow artifact ID" }));
}

type BlobFailure =
  | BlobDeleteError
  | BlobReadError
  | BlobReadTerminalError
  | BlobUploadStartError
  | BlobWriteError
  | DurableWorkflowReadError
  | DurableWorkflowInvariantViolation;

function ioFailure(
  artifactId: string,
  operation: WorkflowArtifactIoOperation,
  error: BlobFailure,
): WorkflowArtifactIoFailed {
  return new WorkflowArtifactIoFailed({
    artifactId,
    operation,
    code: error._tag,
    message: `Workflow artifact ${operation} failed`,
  });
}

async function readArtifactBytes(input: {
  readonly blobStore: BlobStore;
  readonly reference: WorkflowArtifactReference;
  readonly maxBytes: number;
}): Promise<ResultType<Uint8Array, WorkflowArtifactReadError>> {
  if (input.reference.blobRef.byteLength > input.maxBytes) {
    return Result.err(
      new WorkflowArtifactFileTooLarge({
        artifactId: input.reference.artifactId,
        maxBytes: input.maxBytes,
        message: "Workflow artifact exceeds its bounded size",
      }),
    );
  }
  const opened = await input.blobStore.open(input.reference.blobRef);
  return opened
    .mapError((error) => ioFailure(input.reference.artifactId, "open-artifact", error))
    .andThenAsync(async function materialize(read) {
      return (await materializeBlobRead(read)).mapError((error) =>
        ioFailure(input.reference.artifactId, "read-artifact", error),
      );
    });
}

async function deleteUploadedAfterFailure(input: {
  readonly blobStore: BlobStore;
  readonly reference: WorkflowArtifactReference;
  readonly primary: WorkflowArtifactIoFailed;
}): Promise<ResultType<never, WorkflowArtifactWriteError>> {
  const deleted = await input.blobStore.delete(input.reference.blobRef);
  return deleted.match<ResultType<never, WorkflowArtifactWriteError>>({
    ok: () => Result.err(input.primary),
    err: (error) =>
      Result.err(
        new WorkflowArtifactWriteAndCleanupFailed({
          artifactId: input.reference.artifactId,
          primary: input.primary,
          cleanup: ioFailure(input.reference.artifactId, "delete-artifact", error),
          message: "Workflow artifact write and cleanup both failed",
        }),
      ),
  });
}

async function publishArtifact(input: {
  readonly blobStore: BlobStore;
  readonly workflowStore: DurableWorkflowStore;
  readonly artifactId: string;
  readonly bytes: Uint8Array;
  readonly createdAt: number;
  readonly verify: (
    reference: WorkflowArtifactReference,
  ) => Promise<ResultType<void, WorkflowArtifactReadError>>;
}): Promise<ResultType<WorkflowArtifactReference, WorkflowArtifactWriteError>> {
  const existing = input.workflowStore
    .getWorkflowArtifact(input.artifactId)
    .mapError((error) => ioFailure(input.artifactId, "lookup-artifact", error));
  const existingOutcome = existing.match<
    | { readonly kind: "existing"; readonly reference: WorkflowArtifactReference }
    | { readonly kind: "missing" }
    | { readonly kind: "error"; readonly error: WorkflowArtifactIoFailed }
  >({
    ok: (reference) => (reference === null ? { kind: "missing" } : { kind: "existing", reference }),
    err: (error) => ({ kind: "error", error }),
  });
  if (existingOutcome.kind === "error") return Result.err(existingOutcome.error);
  if (existingOutcome.kind === "existing") {
    return (await input.verify(existingOutcome.reference)).map(() => existingOutcome.reference);
  }

  const started = await input.blobStore.startUpload({
    source: input.bytes,
    retention: { kind: "durable" },
    expectedSha256: sha256(input.bytes),
    expectedByteLength: input.bytes.byteLength,
  });
  const uploadOutcome = started.match<
    | {
        readonly kind: "ok";
        readonly completion: Promise<ResultType<BlobRefV1, BlobWriteError>>;
      }
    | { readonly kind: "error"; readonly error: WorkflowArtifactIoFailed }
  >({
    ok: (value) => ({ kind: "ok", completion: value.completion }),
    err: (error) => ({ kind: "error", error: ioFailure(input.artifactId, "start-upload", error) }),
  });
  if (uploadOutcome.kind === "error") return Result.err(uploadOutcome.error);
  const completed = (await uploadOutcome.completion).mapError((error) =>
    ioFailure(input.artifactId, "complete-upload", error),
  );
  const completeOutcome = completed.match<
    | { readonly kind: "ok"; readonly reference: WorkflowArtifactReference }
    | { readonly kind: "error"; readonly error: WorkflowArtifactIoFailed }
  >({
    ok: (blobRef) => ({ kind: "ok", reference: { artifactId: input.artifactId, blobRef } }),
    err: (error) => ({ kind: "error", error }),
  });
  if (completeOutcome.kind === "error") return Result.err(completeOutcome.error);

  const registered = input.workflowStore
    .registerWorkflowArtifact(completeOutcome.reference, input.createdAt)
    .mapError((error) => ioFailure(input.artifactId, "register-artifact", error));
  const registerOutcome = registered.match<
    | { readonly kind: "ok"; readonly reference: WorkflowArtifactReference }
    | { readonly kind: "error"; readonly error: WorkflowArtifactIoFailed }
  >({
    ok: (reference) => ({ kind: "ok", reference }),
    err: (error) => ({ kind: "error", error }),
  });
  if (registerOutcome.kind === "error") {
    return deleteUploadedAfterFailure({
      blobStore: input.blobStore,
      reference: completeOutcome.reference,
      primary: registerOutcome.error,
    });
  }
  if (
    encodeWorkflowArtifactReference(registerOutcome.reference) !==
    encodeWorkflowArtifactReference(completeOutcome.reference)
  ) {
    const deleted = await input.blobStore.delete(completeOutcome.reference.blobRef);
    const cleanupError = deleted.match({ ok: () => null, err: (error) => error });
    if (cleanupError) {
      return Result.err(
        new WorkflowArtifactWriteAndCleanupFailed({
          artifactId: input.artifactId,
          primary: ioFailure(
            input.artifactId,
            "register-artifact",
            new DurableWorkflowInvariantViolation({
              message: "Concurrent workflow artifact registration reused the canonical object",
            }),
          ),
          cleanup: ioFailure(input.artifactId, "delete-artifact", cleanupError),
          message: "Workflow artifact deduplication cleanup failed",
        }),
      );
    }
  }
  return (await input.verify(registerOutcome.reference)).map(() => registerOutcome.reference);
}

export async function writeWorkflowValueArtifact(input: {
  readonly blobStore: BlobStore;
  readonly workflowStore: DurableWorkflowStore;
  readonly value: JsonValue;
  readonly maxBytes: number;
  readonly now?: () => number;
}): Promise<ResultType<WorkflowArtifactReference, WorkflowArtifactWriteError>> {
  const encoded = encodeWorkflowValueArtifact(input.value);
  const artifactId = `${WORKFLOW_VALUE_ARTIFACT_PREFIX}${encoded.payloadHash}`;
  if (encoded.payloadBytes > input.maxBytes) {
    return Result.err(
      new WorkflowArtifactValueTooLarge({
        artifactId,
        maxBytes: input.maxBytes,
        message: `Workflow value exceeds ${input.maxBytes} bytes`,
      }),
    );
  }
  const bytes = new TextEncoder().encode(encoded.encoded);
  return publishArtifact({
    blobStore: input.blobStore,
    workflowStore: input.workflowStore,
    artifactId,
    bytes,
    createdAt: (input.now ?? Date.now)(),
    verify: async (reference) =>
      (
        await readWorkflowValueArtifact({
          blobStore: input.blobStore,
          reference,
          maxBytes: input.maxBytes,
        })
      ).map(() => undefined),
  });
}

export async function readWorkflowValueArtifact(input: {
  readonly blobStore: BlobStore;
  readonly reference: WorkflowArtifactReference;
  readonly maxBytes: number;
}): Promise<ResultType<JsonValue, WorkflowArtifactReadError>> {
  const expectedHash = artifactHash(input.reference.artifactId, WORKFLOW_VALUE_ARTIFACT_PREFIX);
  return expectedHash.andThenAsync(async function readValue(hash) {
    const bytes = await readArtifactBytes({
      blobStore: input.blobStore,
      reference: input.reference,
      maxBytes: workflowValueArtifactFileByteLimit(input.maxBytes),
    });
    return bytes.andThen((content) =>
      decodeWorkflowValueArtifact({
        encoded: new TextDecoder().decode(content),
        expectedHash: hash,
        maxValueBytes: input.maxBytes,
        artifactId: input.reference.artifactId,
      }).map((decoded) => decoded.value),
    );
  });
}

export async function writeWorkflowSourceArtifact(input: {
  readonly blobStore: BlobStore;
  readonly workflowStore: DurableWorkflowStore;
  readonly source: string;
  readonly sourceSha256: string;
  readonly maxBytes: number;
  readonly now?: () => number;
}): Promise<ResultType<WorkflowArtifactReference, WorkflowArtifactWriteError>> {
  const artifactId = `${WORKFLOW_SOURCE_ARTIFACT_PREFIX}${input.sourceSha256}`;
  if (sha256(input.source) !== input.sourceSha256) {
    return Result.err(new WorkflowArtifactInvalidId({ message: "Workflow source hash mismatch" }));
  }
  const bytes = new TextEncoder().encode(input.source);
  if (bytes.byteLength > input.maxBytes) {
    return Result.err(
      new WorkflowArtifactValueTooLarge({
        artifactId,
        maxBytes: input.maxBytes,
        message: `Workflow source exceeds ${input.maxBytes} bytes`,
      }),
    );
  }
  return publishArtifact({
    blobStore: input.blobStore,
    workflowStore: input.workflowStore,
    artifactId,
    bytes,
    createdAt: (input.now ?? Date.now)(),
    verify: async (reference) =>
      (
        await readWorkflowSourceArtifact({
          blobStore: input.blobStore,
          reference,
          maxBytes: input.maxBytes,
        })
      ).map(() => undefined),
  });
}

export async function readWorkflowSourceArtifact(input: {
  readonly blobStore: BlobStore;
  readonly reference: WorkflowArtifactReference;
  readonly maxBytes: number;
}): Promise<ResultType<string, WorkflowArtifactReadError>> {
  const expectedHash = artifactHash(input.reference.artifactId, WORKFLOW_SOURCE_ARTIFACT_PREFIX);
  return expectedHash.andThenAsync(async function readSource(hash) {
    const bytes = await readArtifactBytes(input);
    return bytes.andThen((content) => {
      const source = new TextDecoder().decode(content);
      return sha256(source) === hash
        ? Result.ok(source)
        : Result.err(
            new WorkflowArtifactIoFailed({
              artifactId: input.reference.artifactId,
              operation: "read-artifact",
              code: "WORKFLOW_HASH_MISMATCH",
              message: "Workflow source artifact hash does not match its identity",
            }),
          );
    });
  });
}

export async function deleteWorkflowArtifactIfUnreferenced(input: {
  readonly blobStore: BlobStore;
  readonly workflowStore: DurableWorkflowStore;
  readonly artifactId: string;
}): Promise<ResultType<"deleted" | "retained" | "absent", WorkflowArtifactIoFailed>> {
  const released = input.workflowStore
    .releaseWorkflowArtifactIfUnreferenced(input.artifactId)
    .mapError((error) => ioFailure(input.artifactId, "lookup-artifact", error));
  const releaseOutcome = released.match<
    | { readonly kind: "released"; readonly reference: WorkflowArtifactReference }
    | { readonly kind: "retained" }
    | { readonly kind: "error"; readonly error: WorkflowArtifactIoFailed }
  >({
    ok: (reference) =>
      reference === null ? { kind: "retained" } : { kind: "released", reference },
    err: (error) => ({ kind: "error", error }),
  });
  if (releaseOutcome.kind === "error") return Result.err(releaseOutcome.error);
  if (releaseOutcome.kind === "retained") return Result.ok("retained");
  return (await input.blobStore.delete(releaseOutcome.reference.blobRef))
    .map((status) => (status === "absent" ? "absent" : "deleted"))
    .mapError((error) => ioFailure(input.artifactId, "delete-artifact", error));
}
