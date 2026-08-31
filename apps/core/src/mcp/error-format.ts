import { redactErrorTextForLog } from "@stanley2058/lilac-utils";
import { Panic, Result } from "better-result";

const MAX_SAFE_ERROR_LENGTH = 1_000;

export function rethrowPanic(error: unknown): void {
  if (Panic.is(error)) throw error;
}

export function opaqueErrorMessage(error: unknown): string {
  return Result.try({
    try: () => {
      if (typeof error === "string") return error;
      if (error instanceof Error) return error.message;
      return "Unknown error";
    },
    catch: () => "Unknown error",
  }).match({ ok: (message) => message, err: () => "Unknown error" });
}

export function safeMcpErrorText(error: unknown, sensitiveValues: readonly string[] = []): string {
  let message = opaqueErrorMessage(error);

  for (const value of sensitiveValues) {
    if (value.length > 0) message = message.replaceAll(value, "<redacted>");
  }
  return redactErrorTextForLog(message, MAX_SAFE_ERROR_LENGTH);
}
