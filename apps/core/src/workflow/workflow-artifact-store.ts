import fs from "node:fs/promises";
import path from "node:path";

import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import { projectRuntimeError } from "../runtime/error-format";
import { adaptToolResultToHost, preserveToolPanic } from "../tools/tool-result-adapters";
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
  return adaptToolResultToHost(result);
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
  const finishCapture = captured.match<() => ResultType<T, WorkflowArtifactIoFailed>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () => {
      const cause = preserveToolPanic(error);
      const failure = projectFilesystemFailure(cause);
      return Result.err(
        new WorkflowArtifactIoFailed({
          artifactId: input.artifactId,
          operation: input.operation,
          code: failure.code,
          message: `Workflow value artifact I/O failed during ${input.operation}`,
        }),
      );
    },
  });
  return finishCapture();
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
    const createError = created.match({
      ok: () => null,
      err: (error) => error,
    });
    if (createError) return Result.err(createError);
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
  return inspected.match<
    Promise<
      ResultType<
        string,
        WorkflowArtifactAbsent | WorkflowArtifactUnsafePath | WorkflowArtifactIoFailed
      >
    >
  >({
    err: (error) => Promise.resolve(Result.err(error)),
    ok: async (stats) => {
      if (stats.isSymbolicLink()) {
        return Result.err(
          new WorkflowArtifactUnsafePath({
            artifactId: input.artifactId,
            location: "root",
            issue: "symlink",
            message: "Workflow value artifact root cannot be a symlink",
          }),
        );
      }
      if (!stats.isDirectory()) {
        return Result.err(
          new WorkflowArtifactUnsafePath({
            artifactId: input.artifactId,
            location: "root",
            issue: "not-directory",
            message: "Workflow value artifact root is not a directory",
          }),
        );
      }
      return captureIo({
        artifactId: input.artifactId,
        operation: "resolve-root",
        run: () => fs.realpath(root),
      });
    },
  });
}

async function removeTemporary(
  artifactId: string,
  temporaryPath: string,
): Promise<ResultType<void, WorkflowArtifactIoFailed>> {
  return (
    await captureIo({
      artifactId,
      operation: "remove-temporary",
      run: () => fs.rm(temporaryPath, { force: true }),
    })
  ).map(() => undefined);
}

function combineWriteAndCleanup(
  artifactId: string,
  primary: WorkflowArtifactIoFailed,
  cleanup: ResultType<void, WorkflowArtifactIoFailed>,
): ResultType<never, WorkflowArtifactIoFailed | WorkflowArtifactWriteAndCleanupFailed> {
  return cleanup.match<
    ResultType<never, WorkflowArtifactIoFailed | WorkflowArtifactWriteAndCleanupFailed>
  >({
    ok: () => Result.err(primary),
    err: (cleanupError) =>
      Result.err(
        new WorkflowArtifactWriteAndCleanupFailed({
          artifactId,
          primary,
          cleanup: cleanupError,
          message: "Workflow value artifact write and temporary-file cleanup both failed",
        }),
      ),
  });
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
  const rootResult = await artifactRoot({ dataDir: input.dataDir, artifactId, create: true });
  const publishAtRoot = rootResult.match<
    () => Promise<ResultType<boolean, WorkflowArtifactWriteError>>
  >({
    err: (error) => async () => Result.err(error),
    ok: (root) => async () => {
      const artifactPath = path.join(root, `${encoded.payloadHash}.json`);
      const existingResult = await lstatOrMissing({ artifactId, filePath: artifactPath });
      const continueWithExisting = existingResult.match<
        () => Promise<ResultType<boolean, WorkflowArtifactWriteError>>
      >({
        err: (error) => async () => Result.err(error),
        ok: (existing) => async () => {
          if (existing !== null) {
            return (
              await readWorkflowValueArtifact({
                dataDir: input.dataDir,
                artifactId,
                maxBytes: input.maxBytes,
              })
            ).map(() => false);
          }

          const temporaryPath = path.join(
            root,
            `.${encoded.payloadHash}.${crypto.randomUUID()}.tmp`,
          );
          const opened = await captureIo({
            artifactId,
            operation: "open-temporary",
            run: () => fs.open(temporaryPath, "wx", 0o600),
          });
          const continueWithHandle = opened.match<
            () => Promise<ResultType<boolean, WorkflowArtifactWriteError>>
          >({
            err: (error) => async () => Result.err(error),
            ok: (handle) => async () => {
              const written = await captureIo({
                artifactId,
                operation: "write-temporary",
                run: () => handle.writeFile(encoded.encoded, "utf8"),
              });
              let primaryError = written.match({
                ok: () => null,
                err: (error) => error,
              });
              if (!primaryError) {
                const synced = await captureIo({
                  artifactId,
                  operation: "sync-temporary",
                  run: () => handle.sync(),
                });
                primaryError = synced.match({
                  ok: () => null,
                  err: (error) => error,
                });
              }
              const closed = await captureIo({
                artifactId,
                operation: "close-temporary",
                run: () => handle.close(),
              });
              primaryError ??= closed.match({
                ok: () => null,
                err: (error) => error,
              });
              if (primaryError) {
                return combineWriteAndCleanup(
                  artifactId,
                  primaryError,
                  await removeTemporary(artifactId, temporaryPath),
                );
              }
              const renamed = await captureIo({
                artifactId,
                operation: "rename-temporary",
                run: () => fs.rename(temporaryPath, artifactPath),
              });
              const renameError = renamed.match({
                ok: () => null,
                err: (error) => error,
              });
              if (renameError) {
                return combineWriteAndCleanup(
                  artifactId,
                  renameError,
                  await removeTemporary(artifactId, temporaryPath),
                );
              }
              return Result.ok(true);
            },
          });
          return continueWithHandle();
        },
      });
      return continueWithExisting();
    },
  });
  const publication = await publishAtRoot();
  const publicationError = publication.match({
    err: (error) => error,
    ok: () => null,
  });
  if (publicationError) return Result.err(publicationError);
  const verify = publication.match({ ok: (value) => value, err: () => false });
  if (verify) {
    const verified = await readWorkflowValueArtifact({
      dataDir: input.dataDir,
      artifactId,
      maxBytes: input.maxBytes,
    });
    adaptToolResultToHost(
      verified.mapError(
        (cause) =>
          new Panic({
            message: "Atomic workflow value artifact publication could not be verified",
            cause,
          }),
      ),
    );
  }
  return Result.ok(artifactId);
}

export async function readWorkflowValueArtifact(input: {
  dataDir: string;
  artifactId: string;
  maxBytes: number;
}): Promise<ResultType<JsonValue, WorkflowArtifactReadError>> {
  const continueWithHash = artifactHash(input.artifactId).match<
    () => Promise<ResultType<JsonValue, WorkflowArtifactReadError>>
  >({
    err: (error) => async () => Result.err(error),
    ok: (hash) => async () => {
      const rootResult = await artifactRoot({
        dataDir: input.dataDir,
        artifactId: input.artifactId,
        create: false,
      });
      const continueWithRoot = rootResult.match<
        () => Promise<ResultType<JsonValue, WorkflowArtifactReadError>>
      >({
        err: (error) => async () => Result.err(error),
        ok: (root) => async () => {
          const artifactPath = path.join(root, `${hash}.json`);
          const inspectedResult = await lstatOrMissing({
            artifactId: input.artifactId,
            filePath: artifactPath,
          });
          const continueWithInspection = inspectedResult.match<
            () => Promise<ResultType<JsonValue, WorkflowArtifactReadError>>
          >({
            err: (error) => async () => Result.err(error),
            ok: (inspected) => async () => {
              if (inspected === null) {
                return Result.err(
                  new WorkflowArtifactAbsent({
                    artifactId: input.artifactId,
                    message: "Workflow value artifact is absent",
                  }),
                );
              }
              if (inspected.isSymbolicLink()) {
                return Result.err(
                  new WorkflowArtifactUnsafePath({
                    artifactId: input.artifactId,
                    location: "artifact",
                    issue: "symlink",
                    message: "Workflow value artifact cannot be a symlink",
                  }),
                );
              }
              if (!inspected.isFile()) {
                return Result.err(
                  new WorkflowArtifactUnsafePath({
                    artifactId: input.artifactId,
                    location: "artifact",
                    issue: "not-file",
                    message: "Workflow value artifact is not a regular file",
                  }),
                );
              }
              if (inspected.size > workflowValueArtifactFileByteLimit(input.maxBytes)) {
                return Result.err(
                  new WorkflowArtifactFileTooLarge({
                    artifactId: input.artifactId,
                    maxBytes: input.maxBytes,
                    message: "Workflow value artifact file exceeds its bounded size",
                  }),
                );
              }
              const canonicalResult = await captureIo({
                artifactId: input.artifactId,
                operation: "resolve-artifact",
                run: () => fs.realpath(artifactPath),
              });
              const continueWithCanonical = canonicalResult.match<
                () => Promise<ResultType<JsonValue, WorkflowArtifactReadError>>
              >({
                err: (error) => async () => Result.err(error),
                ok: (canonical) => async () => {
                  if (path.dirname(canonical) !== root) {
                    return Result.err(
                      new WorkflowArtifactUnsafePath({
                        artifactId: input.artifactId,
                        location: "artifact",
                        issue: "escaped-root",
                        message: "Workflow value artifact escapes its canonical root",
                      }),
                    );
                  }
                  const sourceResult = await captureIo({
                    artifactId: input.artifactId,
                    operation: "read-artifact",
                    run: () => fs.readFile(canonical, "utf8"),
                  });
                  const continueWithSource = sourceResult.match<
                    () => Promise<ResultType<JsonValue, WorkflowArtifactReadError>>
                  >({
                    err: (error) => async () => Result.err(error),
                    ok: (source) => async () => {
                      if (
                        Buffer.byteLength(source, "utf8") >
                        workflowValueArtifactFileByteLimit(input.maxBytes)
                      ) {
                        return Result.err(
                          new WorkflowArtifactFileTooLarge({
                            artifactId: input.artifactId,
                            maxBytes: input.maxBytes,
                            message: "Workflow value artifact file exceeds its bounded size",
                          }),
                        );
                      }
                      return decodeWorkflowValueArtifact({
                        encoded: source,
                        expectedHash: hash,
                        maxValueBytes: input.maxBytes,
                        artifactId: input.artifactId,
                      }).map((decoded) => decoded.value);
                    },
                  });
                  return continueWithSource();
                },
              });
              return continueWithCanonical();
            },
          });
          return continueWithInspection();
        },
      });
      return continueWithRoot();
    },
  });
  return continueWithHash();
}
