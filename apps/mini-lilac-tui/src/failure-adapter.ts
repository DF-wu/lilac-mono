import { Panic, Result, type Result as ResultType } from "better-result";

export type CapturedTuiFailure =
  | { readonly kind: "panic"; readonly panic: Panic }
  | { readonly kind: "ordinary"; readonly cause: Error };

export function captureTuiFailure(cause: unknown): CapturedTuiFailure {
  if (Panic.is(cause)) return { kind: "panic", panic: cause };
  return {
    kind: "ordinary",
    cause:
      cause instanceof Error
        ? cause
        : new Error("Opaque Mini Lilac TUI external failure", { cause }),
  };
}

/** Signal a retained terminal defect after its owner has completed cleanup. */
export function signalTuiDefect(defect: Error): never {
  throw defect;
}

export function captureTuiOperation<T, E>(
  operation: () => Awaited<T>,
  mapError: (cause: Error) => E,
): ResultType<T, E> {
  const captured = Result.try<T, CapturedTuiFailure>({
    try: operation,
    catch: captureTuiFailure,
  });
  const finish = captured.match<() => ResultType<T, E>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () =>
      error.kind === "panic" ? signalTuiDefect(error.panic) : Result.err(mapError(error.cause)),
  });
  return finish();
}

export async function captureTuiOperationAsync<T, E>(
  operation: () => Promise<T>,
  mapError: (cause: Error) => E,
): Promise<ResultType<T, E>> {
  const captured = await Result.tryPromise({ try: operation, catch: captureTuiFailure });
  const finish = captured.match<() => ResultType<T, E>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () =>
      error.kind === "panic" ? signalTuiDefect(error.panic) : Result.err(mapError(error.cause)),
  });
  return finish();
}
