import { Panic, Result } from "better-result";

export function isPanic(cause: unknown): cause is Panic {
  const inspected = Result.try({
    try: (): Panic | undefined => (Panic.is(cause) ? cause : undefined),
    catch: () => undefined,
  });
  return inspected.status === "ok" && inspected.value !== undefined;
}

export function opaqueErrorCause(fallback: string): (cause: unknown) => Error | Panic;
export function opaqueErrorCause(cause: unknown, fallback: string): Error | Panic;
export function opaqueErrorCause(
  causeOrFallback: unknown,
  fallback?: string,
): Error | Panic | ((cause: unknown) => Error | Panic) {
  if (fallback === undefined) {
    const projectedFallback =
      typeof causeOrFallback === "string" ? causeOrFallback : "Opaque remote runner failure";
    return (cause: unknown) => opaqueErrorCause(cause, projectedFallback);
  }
  if (isPanic(causeOrFallback)) return causeOrFallback;
  const projected = Result.try({
    try: () => (causeOrFallback instanceof Error ? causeOrFallback : new Error(fallback)),
    catch: () => new Error(fallback),
  });
  return projected.status === "ok" ? projected.value : projected.error;
}

export function opaqueErrorMessage(cause: unknown, fallback: string): string {
  const projected = opaqueErrorCause(cause, fallback);
  return isPanic(projected) ? fallback : projected.message;
}
