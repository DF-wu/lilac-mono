import { TaggedError, type Result as ResultType } from "better-result";

import { captureTuiOperation, captureTuiOperationAsync } from "./failure-adapter";

export class TerminalStreamReadFailed extends TaggedError("TerminalStreamReadFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class TerminalStreamCleanupFailed extends TaggedError("TerminalStreamCleanupFailed")<{
  readonly operation: "cancel" | "release-lock";
  readonly cause: unknown;
  readonly message: string;
}> {}

/** Immediate adapter for the Web Streams reader rejection contract. */
export async function readTerminalStream<T>(
  reader: ReadableStreamDefaultReader<T>,
): Promise<
  ResultType<Awaited<ReturnType<ReadableStreamDefaultReader<T>["read"]>>, TerminalStreamReadFailed>
> {
  return captureTuiOperationAsync(
    () => reader.read(),
    (cause) =>
      new TerminalStreamReadFailed({
        cause,
        message: "Terminal stream read failed",
      }),
  );
}

/** Cancellation is best-effort during teardown but its failure remains explicit. */
export async function cancelTerminalStream<T>(
  stream: ReadableStream<T> | ReadableStreamDefaultReader<T>,
): Promise<ResultType<void, TerminalStreamCleanupFailed>> {
  return captureTuiOperationAsync(
    async () => {
      await stream.cancel();
    },
    (cause) =>
      new TerminalStreamCleanupFailed({
        operation: "cancel",
        cause,
        message: "Terminal stream cancellation failed",
      }),
  );
}

/** Release the reader lock at the exact framework boundary. */
export function releaseTerminalStreamLock<T>(
  reader: ReadableStreamDefaultReader<T>,
): ResultType<void, TerminalStreamCleanupFailed> {
  return captureTuiOperation(
    () => reader.releaseLock(),
    (cause) =>
      new TerminalStreamCleanupFailed({
        operation: "release-lock",
        cause,
        message: "Terminal stream lock release failed",
      }),
  );
}
