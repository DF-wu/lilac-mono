import { Panic, Result, type Result as ResultType } from "better-result";

/** Content-blind pass-through value accepted from an external runtime. */
export type OpaqueAgentValue = {} | null | undefined;

function captureAgentFailure(cause: unknown): OpaqueAgentValue {
  return cause;
}

export function captureAgentOperation<T>(
  operation: () => Awaited<T>,
): ResultType<T, OpaqueAgentValue> {
  return Result.try<T, OpaqueAgentValue>({ try: operation, catch: captureAgentFailure });
}

export function captureAgentPromise<T>(
  operation: () => Promise<T>,
): Promise<ResultType<T, OpaqueAgentValue>> {
  return Result.tryPromise<T, OpaqueAgentValue>({ try: operation, catch: captureAgentFailure });
}

/** Preserve an unrecoverable defect without exempting the surrounding adapter's ordinary failures. */
export function rethrowAgentPanic(cause: Panic): never;
export function rethrowAgentPanic(cause: OpaqueAgentValue): void;
export function rethrowAgentPanic(cause: OpaqueAgentValue): void {
  if (Panic.is(cause)) throw cause;
}

export function isAgentPanic(cause: unknown): cause is Panic {
  return Panic.is(cause);
}
