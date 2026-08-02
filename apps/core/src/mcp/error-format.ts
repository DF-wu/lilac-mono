import { Panic } from "better-result";

const MAX_SAFE_ERROR_LENGTH = 1_000;

export function rethrowPanic(error: unknown): void {
  if (Panic.is(error)) throw error;
}

export function opaqueErrorMessage(error: unknown): string {
  try {
    if (typeof error === "string") return error;
    if (error instanceof Error) return error.message;
    return "Unknown error";
  } catch {
    return "Unknown error";
  }
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username) url.username = "<redacted>";
    if (url.password) url.password = "<redacted>";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<redacted-url>";
  }
}

export function safeMcpErrorText(error: unknown, sensitiveValues: readonly string[] = []): string {
  let message = opaqueErrorMessage(error);

  for (const value of sensitiveValues) {
    if (value.length > 0) message = message.replaceAll(value, "<redacted>");
  }
  message = message.replace(/https?:\/\/[^\s"'<>]+/gi, redactUrl);
  message = message.replace(
    /(authorization\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^\s,;]+/gi,
    "$1<redacted>",
  );
  message = message.replace(/\b(bearer|basic)\s+[^\s,;]+/gi, "$1 <redacted>");
  message = message.replace(/([?&](?:code|state|token|key|secret)=)[^&\s]+/gi, "$1<redacted>");
  message = message.replace(
    /\b(token|secret|password|api[_-]?key|code|state)\s*[:=]\s*[^\s,;]+/gi,
    "$1=<redacted>",
  );
  return message.length <= MAX_SAFE_ERROR_LENGTH
    ? message
    : `${message.slice(0, MAX_SAFE_ERROR_LENGTH)}...`;
}
