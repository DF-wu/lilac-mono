import { isPanic } from "@stanley2058/lilac-utils";
import type { Panic } from "better-result";

import { safeMcpErrorText } from "../mcp/error-format";

const UNKNOWN_ERROR_TEXT = "Unknown error";

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
  if (isPanic(errorOrFallback)) return errorOrFallback;
  try {
    if (errorOrFallback instanceof Error) return errorOrFallback;
  } catch {
    return new Error(fallback);
  }
  return new Error(safeRuntimeErrorText(errorOrFallback, fallback));
}
