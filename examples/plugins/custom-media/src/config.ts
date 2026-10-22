import { z } from "zod";
import type { ResolvedCredentials } from "./contracts";
import { CustomMediaError, redactDiagnostic } from "./errors";

const envVariableNameSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/u, "must be an uppercase environment variable name");

export const customMediaConfigSchema = z
  .object({
    baseUrlEnv: envVariableNameSchema.default("OPENAI_COMPATIBLE_BASE_URL"),
    apiKeyEnv: envVariableNameSchema.default("OPENAI_COMPATIBLE_API_KEY"),
  })
  .strict()
  .default({
    baseUrlEnv: "OPENAI_COMPATIBLE_BASE_URL",
    apiKeyEnv: "OPENAI_COMPATIBLE_API_KEY",
  });

export type CustomMediaConfig = z.infer<typeof customMediaConfigSchema>;

export function normalizeOpenAICompatibleBaseURL(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CustomMediaError("INVALID_CONFIG", "The configured base URL is not a valid URL.");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new CustomMediaError("INVALID_CONFIG", "The configured base URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CustomMediaError(
      "INVALID_CONFIG",
      "The configured base URL must not contain credentials, query parameters, or a fragment.",
    );
  }

  let path = url.pathname.replace(/\/+$/u, "");
  if (!path.endsWith("/v1")) path = `${path}/v1`;
  url.pathname = path.replace(/^$/u, "/v1");
  return url.toString().replace(/\/$/u, "");
}

export function resolveCredentials(config: CustomMediaConfig): ResolvedCredentials {
  const rawBaseURL = process.env[config.baseUrlEnv]?.trim();
  const apiKey = process.env[config.apiKeyEnv]?.trim();
  if (!rawBaseURL) {
    throw new CustomMediaError(
      "MISSING_ENV",
      `Required base URL environment variable '${config.baseUrlEnv}' is not set.`,
    );
  }
  if (!apiKey) {
    throw new CustomMediaError(
      "MISSING_ENV",
      `Required API key environment variable '${config.apiKeyEnv}' is not set.`,
    );
  }

  try {
    return { baseURL: normalizeOpenAICompatibleBaseURL(rawBaseURL), apiKey };
  } catch (error) {
    if (error instanceof CustomMediaError) throw error;
    throw new CustomMediaError(
      "INVALID_CONFIG",
      `Could not resolve provider configuration: ${redactDiagnostic(error, [apiKey])}`,
    );
  }
}
