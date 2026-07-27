import { ZodError, type ZodType } from "zod";

export const CUSTOM_MEDIA_ERROR_CODES = [
  "INVALID_CONFIG",
  "MISSING_ENV",
  "INVALID_INPUT",
  "UNSUPPORTED_MODEL",
  "UNSUPPORTED_CAPABILITY",
  "UNSAFE_PATH",
  "INVALID_MEDIA",
  "MEDIA_TOO_LARGE",
  "PROVIDER_ERROR",
  "VIDEO_FAILED",
  "DOWNLOAD_TOO_LARGE",
  "TIMEOUT",
  "ABORTED",
  "IO_ERROR",
] as const;

export type CustomMediaErrorCode = (typeof CUSTOM_MEDIA_ERROR_CODES)[number];

export class CustomMediaError extends Error {
  override readonly name = "CustomMediaError";

  constructor(
    readonly code: CustomMediaErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
  }
}

export function parseWithSchema<T>(schema: ZodType<T>, input: unknown, label: string): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
    .join("; ");
  throw new CustomMediaError("INVALID_INPUT", `${label} is invalid: ${issues}`);
}

export function redactDiagnostic(value: unknown, secrets: readonly string[] = []): string {
  let message = value instanceof Error ? value.message : String(value);
  message = message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/gu, "[REDACTED]");
  for (const secret of secrets) {
    if (secret.length >= 4) message = message.split(secret).join("[REDACTED]");
  }
  return message.replace(/[\r\n\t]+/gu, " ").slice(0, 500);
}

export function asCustomMediaError(
  error: unknown,
  fallbackCode: CustomMediaErrorCode,
  fallbackMessage: string,
  secrets: readonly string[] = [],
): CustomMediaError {
  if (error instanceof CustomMediaError) return error;
  if (error instanceof ZodError) {
    return new CustomMediaError("INVALID_INPUT", `${fallbackMessage}: invalid structured data`);
  }
  return new CustomMediaError(
    fallbackCode,
    `${fallbackMessage}: ${redactDiagnostic(error, secrets)}`,
  );
}
