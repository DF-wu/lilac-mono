import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

const filesystemFailureSchema = z.object({ code: z.string() }).loose();

export class FileSystemOperationFailed extends TaggedError("FileSystemOperationFailed")<{
  readonly operation: string;
  readonly code: string;
  readonly message: string;
}> {}

type FilesystemFailureProjection =
  | { readonly kind: "filesystem-failure"; readonly code: string; readonly message: string }
  | { readonly kind: "panic"; readonly panic: Panic }
  | { readonly kind: "unrecognized" };

export function decodeFilesystemFailure(cause: unknown): FilesystemFailureProjection {
  if (Panic.is(cause)) return { kind: "panic", panic: cause };
  const decoded = filesystemFailureSchema.safeParse(cause);
  if (!decoded.success) return { kind: "unrecognized" };
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
  try {
    return Result.ok(await effect());
  } catch (cause) {
    const decoded = decodeFilesystemFailure(cause);
    if (decoded.kind === "panic") throw decoded.panic;
    if (decoded.kind === "unrecognized") throw cause;
    return Result.err(
      new FileSystemOperationFailed({
        operation,
        code: decoded.code,
        message: decoded.message,
      }),
    );
  }
}

export function captureFilesystemOperationSync<T>(
  operation: string,
  effect: () => T,
): ResultType<T, FileSystemOperationFailed> {
  try {
    return Result.ok(effect());
  } catch (cause) {
    const decoded = decodeFilesystemFailure(cause);
    if (decoded.kind === "panic") throw decoded.panic;
    if (decoded.kind === "unrecognized") throw cause;
    return Result.err(
      new FileSystemOperationFailed({
        operation,
        code: decoded.code,
        message: decoded.message,
      }),
    );
  }
}
