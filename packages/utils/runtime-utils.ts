import { Panic } from "better-result";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function opaqueErrorMessage(error: unknown, fallback: string): string {
  try {
    return errorMessage(error);
  } catch {
    return fallback;
  }
}

export function opaqueErrorCause(error: unknown, fallback: string): unknown {
  try {
    if (error instanceof Error) return error;
  } catch {
    return new Error(fallback);
  }
  return error;
}

export function isPanic(value: unknown): value is Panic {
  try {
    return Panic.is(value);
  } catch {
    return false;
  }
}

export function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const code = error["code"];
  return typeof code === "string" ? code : undefined;
}
