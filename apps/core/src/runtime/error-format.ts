import { isPanic } from "@stanley2058/lilac-utils";
import { Panic, Result } from "better-result";

import { safeMcpErrorText } from "../mcp/error-format";

const UNKNOWN_ERROR_TEXT = "Unknown error";

export type RuntimeErrorCapture =
  | { readonly kind: "panic"; readonly panic: Panic }
  | { readonly kind: "error"; readonly error: Error }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "opaque" };

export function captureRuntimeError(cause: unknown): RuntimeErrorCapture {
  const inspected = Result.try({
    try: (): RuntimeErrorCapture => {
      if (isPanic(cause)) return { kind: "panic", panic: cause };
      if (typeof cause === "string") return { kind: "text", text: cause };
      if (cause instanceof Error) return { kind: "error", error: cause };
      return { kind: "opaque" };
    },
    catch: () => ({ kind: "opaque" }) as const,
  });
  return inspected.match({ ok: (captured) => captured, err: (captured) => captured });
}

export function projectCapturedRuntimeError(
  captured: RuntimeErrorCapture,
  fallback: string,
): Error | Panic {
  if (captured.kind === "panic") return captured.panic;
  if (captured.kind === "error") return captured.error;
  if (captured.kind === "text") return new Error(safeRuntimeErrorText(captured.text, fallback));
  return new Error(fallback);
}

export function safeRuntimeErrorText(error: unknown, fallback: string): string {
  const text = safeMcpErrorText(error);
  return text === UNKNOWN_ERROR_TEXT ? fallback : text;
}

export function projectRuntimeError(fallback: string): (error: unknown) => Error | Panic;
export function projectRuntimeError(error: unknown, fallback: string): Error | Panic;
export function projectRuntimeError(
  errorOrFallback: unknown,
  fallback?: string,
): Error | Panic | ((error: unknown) => Error | Panic) {
  if (fallback === undefined) {
    const projectedFallback =
      typeof errorOrFallback === "string" ? errorOrFallback : "Unknown external failure";
    return (error: unknown) => projectRuntimeError(error, projectedFallback);
  }
  const inspected = Result.try({
    try: (): Error | Panic | null => {
      if (isPanic(errorOrFallback)) return errorOrFallback;
      if (errorOrFallback instanceof Error) return errorOrFallback;
      return null;
    },
    catch: () => null,
  });
  const projected = inspected.match({ ok: (value) => value, err: () => null });
  if (projected) return projected;
  return new Error(safeRuntimeErrorText(errorOrFallback, fallback));
}
