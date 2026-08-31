import { Panic, Result, type Result as ResultType } from "better-result";

export type CapturedOutcome<T, E = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function captureResultOutcome<T, E>(
  result: ResultType<T, E> | CapturedOutcome<T, E>,
): CapturedOutcome<T, E> {
  if ("ok" in result) return result;
  return result.match<CapturedOutcome<T, E>>({
    ok: (value) => ({ ok: true, value }),
    err: (error) => ({ ok: false, error }),
  });
}

export async function capturePromiseResult<T>(
  effect: () => Promise<T>,
): Promise<CapturedOutcome<T>> {
  const captured = await Result.tryPromise({
    try: effect,
    catch: (cause) => ({ restoreCause: () => cause }),
  });
  return captured.match<CapturedOutcome<T>>({
    ok: (value) => ({ ok: true, value }),
    err: ({ restoreCause }) => ({ ok: false, error: restoreCause() }),
  });
}

export type CapturedSettlement<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "panic"; readonly panic: Panic }
  | { readonly kind: "failure"; readonly restoreCause: () => unknown };

export async function settlePromiseResult<T>(
  effect: () => Promise<T>,
): Promise<CapturedSettlement<T>> {
  const captured = await Result.tryPromise({
    try: effect,
    catch: (cause) => ({ restoreCause: () => cause }),
  });
  return captured.match<CapturedSettlement<T>>({
    ok: (value) => ({ kind: "value", value }),
    err: ({ restoreCause }) => {
      const cause = restoreCause();
      return isPanic(cause) ? { kind: "panic", panic: cause } : { kind: "failure", restoreCause };
    },
  });
}

export function settleSyncResult<T>(effect: () => T): CapturedSettlement<T> {
  const captured = Result.try({
    try: () => ({ value: effect() }),
    catch: (cause: unknown) => ({ restoreCause: () => cause }),
  });
  return captured.match<CapturedSettlement<T>>({
    ok: ({ value }) => ({ kind: "value", value }),
    err: ({ restoreCause }) => {
      const cause = restoreCause();
      return isPanic(cause) ? { kind: "panic", panic: cause } : { kind: "failure", restoreCause };
    },
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function opaqueErrorMessage(error: unknown, fallback: string): string {
  return Result.try({ try: () => errorMessage(error), catch: () => undefined }).match({
    ok: (value) => value,
    err: () => fallback,
  });
}

export function opaqueErrorCause(error: unknown, fallback: string): unknown {
  return Result.try({
    try: () => (error instanceof Error ? error : error),
    catch: () => undefined,
  }).match({ ok: (value) => value, err: () => new Error(fallback) });
}

export function isPanic(value: unknown): value is Panic {
  return Result.try({ try: () => Panic.is(value), catch: () => undefined }).match({
    ok: (isValuePanic) => isValuePanic,
    err: () => false,
  });
}

export function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const code = error["code"];
  return typeof code === "string" ? code : undefined;
}
