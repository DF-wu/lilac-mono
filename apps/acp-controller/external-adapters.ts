import { Panic, Result, type Result as ResultType } from "better-result";

import { ExternalOperationFailed, type ExternalOperation } from "./failures.ts";

const cleanupFailuresByPanic = new WeakMap<Panic, readonly (ExternalOperationFailed | Panic)[]>();

type ExternalFailureProjection = {
  readonly code?: string;
  readonly message: string;
};

export type CapturedAcpFailure =
  | { readonly kind: "panic"; readonly panic: Panic }
  | {
      readonly kind: "ordinary";
      readonly cause: Error;
      readonly projection: ExternalFailureProjection;
    };

type CapturedAcpCause = { readonly settle: () => CapturedAcpFailure };

export function signalAcpDefect(defect: Panic): never {
  throw defect;
}

export function recordAcpCleanupFailure(
  panic: Panic,
  cleanup: ExternalOperationFailed | Panic,
): void {
  cleanupFailuresByPanic.set(panic, [...(cleanupFailuresByPanic.get(panic) ?? []), cleanup]);
}

export function acpCleanupFailuresForPanic(
  panic: Panic,
): readonly (ExternalOperationFailed | Panic)[] {
  return cleanupFailuresByPanic.get(panic) ?? [];
}

export function captureAcpFailure(cause: unknown): CapturedAcpCause {
  return {
    settle: () => {
      const panic = Result.try({
        try: () => (Panic.is(cause) ? cause : null),
        catch: () => null,
      });
      const capturedPanic = panic.match({ ok: (value) => value, err: () => null });
      if (capturedPanic) return { kind: "panic", panic: capturedPanic };
      const projection = projectExternalFailure(cause);
      return {
        kind: "ordinary",
        cause: new Error(projection.message, { cause }),
        projection,
      };
    },
  };
}

export function projectExternalFailure(cause: unknown): ExternalFailureProjection {
  const errorProjection = Result.try({
    try: () => {
      if (!(cause instanceof Error)) return null;
      const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
      return {
        ...(code ? { code } : {}),
        message: cause.message,
      };
    },
    catch: () => null,
  });
  const projected = errorProjection.match({ ok: (value) => value, err: () => null });
  if (projected) return projected;
  switch (typeof cause) {
    case "string":
      return { message: cause };
    case "number":
    case "boolean":
    case "bigint":
      return { message: String(cause) };
    case "symbol":
      return { message: cause.description ?? "Opaque ACP external failure" };
    case "undefined":
    case "object":
    case "function":
      return { message: "Opaque ACP external failure" };
  }
}

export function replaceExternalFailureMessage(
  failure: ExternalOperationFailed,
  message: string,
): ExternalOperationFailed {
  return new ExternalOperationFailed({
    operation: failure.operation,
    cause: failure.cause,
    ...(failure.code ? { code: failure.code } : {}),
    message,
  });
}

export async function captureExternal<T>(
  operation: ExternalOperation,
  run: () => Promise<T>,
  message?: string,
): Promise<ResultType<T, ExternalOperationFailed>> {
  const captured = (
    await Result.tryPromise({
      try: run,
      catch: captureAcpFailure,
    })
  ).mapError(({ settle }) => settle());
  const outcome = captured.match<ResultType<T, ExternalOperationFailed> | (() => never)>({
    ok: (value) => Result.ok(value),
    err: (failure) =>
      failure.kind === "panic"
        ? () => signalAcpDefect(failure.panic)
        : Result.err(
            new ExternalOperationFailed({
              operation,
              cause: failure.cause,
              ...(failure.projection.code ? { code: failure.projection.code } : {}),
              message: message ?? failure.projection.message,
            }),
          ),
  });
  return typeof outcome === "function" ? outcome() : outcome;
}
