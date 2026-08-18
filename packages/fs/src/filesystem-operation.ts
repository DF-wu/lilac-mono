import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

const filesystemFailureSchema = z.object({ code: z.string() }).loose();

export type CapturedFilesystemOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

export async function capturePromiseResult<T>(
  effect: () => Promise<T>,
): Promise<CapturedFilesystemOutcome<T>> {
  const captured = await Result.tryPromise({
    try: effect,
    catch: (cause) => ({ restoreCause: () => cause }),
  });
  return captured.match<CapturedFilesystemOutcome<T>>({
    ok: (value) => ({ ok: true, value }),
    err: ({ restoreCause }) => ({ ok: false, error: restoreCause() }),
  });
}

export class FileSystemOperationFailed extends TaggedError("FileSystemOperationFailed")<{
  readonly operation: string;
  readonly code: string;
  readonly message: string;
}> {}

type FilesystemFailureProjection =
  | { readonly kind: "filesystem-failure"; readonly code: string; readonly message: string }
  | { readonly kind: "panic"; readonly panic: Panic }
  | { readonly kind: "unrecognized"; readonly restoreCause: () => unknown };

export function decodeFilesystemFailure(cause: unknown): FilesystemFailureProjection {
  if (Panic.is(cause)) return { kind: "panic", panic: cause };
  const decoded = filesystemFailureSchema.safeParse(cause);
  if (!decoded.success) return { kind: "unrecognized", restoreCause: () => cause };
  return {
    kind: "filesystem-failure",
    code: decoded.data.code,
    message:
      cause instanceof Error ? cause.message : `Filesystem operation failed (${decoded.data.code})`,
  };
}

export async function captureFilesystemOperation<T>(
  operation: string,
  effect: () => Promise<T>,
): Promise<ResultType<T, FileSystemOperationFailed>> {
  const captured = await Result.tryPromise({
    try: effect,
    catch: (cause) => ({ restoreCause: () => cause }),
  });
  const decoded = captured.match<
    | { readonly kind: "value"; readonly value: T }
    | { readonly kind: "failure"; readonly restoreCause: () => unknown }
  >({
    ok: (value) => ({ kind: "value", value }),
    err: ({ restoreCause }) => ({ kind: "failure", restoreCause }),
  });
  if (decoded.kind === "value") return Result.ok(decoded.value);
  const failure = decodeFilesystemFailure(decoded.restoreCause());
  if (failure.kind === "panic") throw failure.panic;
  if (failure.kind === "unrecognized") throw failure.restoreCause();
  return Result.err(
    new FileSystemOperationFailed({
      operation,
      code: failure.code,
      message: failure.message,
    }),
  );
}

export function captureFilesystemOperationSync<T>(
  operation: string,
  effect: () => T,
): ResultType<T, FileSystemOperationFailed> {
  const captured = Result.try({
    try: () => ({ value: effect() }),
    catch: (cause) => ({ restoreCause: () => cause }),
  });
  const outcome = captured.match<
    | { readonly kind: "value"; readonly value: T }
    | { readonly kind: "failure"; readonly restoreCause: () => unknown }
  >({
    ok: ({ value }) => ({ kind: "value", value }),
    err: ({ restoreCause }) => ({ kind: "failure", restoreCause }),
  });
  if (outcome.kind === "value") return Result.ok(outcome.value);
  const failure = decodeFilesystemFailure(outcome.restoreCause());
  if (failure.kind === "panic") throw failure.panic;
  if (failure.kind === "unrecognized") throw failure.restoreCause();
  return Result.err(
    new FileSystemOperationFailed({
      operation,
      code: failure.code,
      message: failure.message,
    }),
  );
}
