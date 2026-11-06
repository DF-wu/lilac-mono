import { CustomMediaError, redactDiagnostic } from "./errors";

const MAX_ERROR_BODY_BYTES = 64 * 1024;

export function authorizationHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

export function providerURL(baseURL: string, suffix: string): string {
  return `${baseURL.replace(/\/$/u, "")}/${suffix.replace(/^\//u, "")}`;
}

export async function readBoundedText(response: Response, limit = MAX_ERROR_BODY_BYTES) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (total + item.value.byteLength > limit) {
        const remaining = Math.max(0, limit - total);
        if (remaining) chunks.push(item.value.subarray(0, remaining));
        total = limit;
        await reader.cancel();
        break;
      }
      chunks.push(item.value);
      total += item.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  ).toString("utf8");
}

function errorMessageFromBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.error?.message === "string") return parsed.error.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Fall through to the bounded plain-text body.
  }
  return body || "no response body";
}

export async function assertSuccessfulResponse(
  response: Response,
  operation: string,
  apiKey: string,
): Promise<void> {
  if (response.ok) return;
  const body = await readBoundedText(response);
  throw new CustomMediaError(
    "PROVIDER_ERROR",
    `${operation} failed with HTTP ${response.status}: ${redactDiagnostic(errorMessageFromBody(body), [apiKey])}`,
  );
}

export async function readProviderJson(response: Response, operation: string, apiKey: string) {
  await assertSuccessfulResponse(response, operation, apiKey);
  const body = await readBoundedText(response, 1024 * 1024);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new CustomMediaError(
      "PROVIDER_ERROR",
      `${operation} returned malformed JSON: ${redactDiagnostic(body, [apiKey])}`,
    );
  }
}
