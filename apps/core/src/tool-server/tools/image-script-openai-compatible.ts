import { env } from "@stanley2058/lilac-utils";

/**
 * Fork: the OpenAI-compatible endpoint as an image script provider.
 *
 * Scripts read it as `providers.openaiCompatible`. Unlike upstream's built-in
 * providers it has no default endpoint, so it is configured only when
 * `OPENAI_COMPATIBLE_BASE_URL` is set; `OPENAI_COMPATIBLE_API_KEY` is optional.
 */
export const OPENAI_COMPATIBLE_IMAGE_PROVIDER = "openaiCompatible";

export function configuredOpenAICompatibleImageProvider():
  | { readonly baseURL: string; readonly apiKey?: string }
  | undefined {
  const baseURL = env.providers.openaiCompatible.baseUrl?.trim().replace(/\/+$/u, "");
  if (!baseURL) return undefined;
  const apiKey = env.providers.openaiCompatible.apiKey?.trim();
  return { baseURL, ...(apiKey ? { apiKey } : {}) };
}
