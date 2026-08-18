import { Panic, Result, type Result as ResultType } from "better-result";

export type CapturedTuiFailure =
  | { readonly kind: "panic"; readonly panic: Panic }
  | { readonly kind: "ordinary"; readonly cause: Error };

export function captureTuiFailure<Cause>(cause: Cause): CapturedTuiFailure {
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
export function signalTuiDefect<Defect>(defect: Defect): never {
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
  const settlement = captured.match<
    | { readonly kind: "success"; readonly value: T }
    | { readonly kind: "failure"; failure: CapturedTuiFailure }
  >({
    ok: (value) => ({ kind: "success", value }),
    err: (failure) => ({ kind: "failure", failure }),
  });
  if (settlement.kind === "success") return Result.ok(settlement.value);
  if (settlement.failure.kind === "panic") return signalTuiDefect(settlement.failure.panic);
  return Result.err(mapError(settlement.failure.cause));
}

export async function captureTuiOperationAsync<T, E>(
  operation: () => Promise<T>,
  mapError: (cause: Error) => E,
): Promise<ResultType<T, E>> {
  const captured = await Result.tryPromise({ try: operation, catch: captureTuiFailure });
  const settlement = captured.match<
    | { readonly kind: "success"; readonly value: T }
    | { readonly kind: "failure"; failure: CapturedTuiFailure }
  >({
    ok: (value) => ({ kind: "success", value }),
    err: (failure) => ({ kind: "failure", failure }),
  });
  if (settlement.kind === "success") return Result.ok(settlement.value);
  if (settlement.failure.kind === "panic") return signalTuiDefect(settlement.failure.panic);
  return Result.err(mapError(settlement.failure.cause));
}
