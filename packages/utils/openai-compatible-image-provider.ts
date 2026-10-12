import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { withOpenAIImageEditFilenamesFetch } from "./openai-image-edit-fetch";

/**
 * Provider name of the image client. The AI SDK derives the `providerOptions`
 * key from it, so request-level options for this client are passed as
 * `providerOptions: { [OPENAI_COMPATIBLE_IMAGE_PROVIDER_NAME]: { ... } }`.
 */
export const OPENAI_COMPATIBLE_IMAGE_PROVIDER_NAME = "openaiCompatible";

export type OpenAICompatibleImageConnection = {
  readonly baseUrl: string;
  readonly apiKey?: string;
};

/**
 * Fork-owned image client for the OpenAI-compatible endpoint used by the
 * structured `generate.image` tool.
 *
 * `getModelProviders()` builds the shared `openai-compatible` chat provider
 * without the image-edit filename fix that the official OpenAI provider gets.
 * Bun serializes unnamed multipart blobs with `filename=""`, which
 * `/images/edits` endpoints reject, so image routing builds its own client
 * here instead of reusing the chat provider.
 */
export function createOpenAICompatibleImageProvider(connection: OpenAICompatibleImageConnection) {
  return createOpenAICompatible({
    name: OPENAI_COMPATIBLE_IMAGE_PROVIDER_NAME,
    baseURL: connection.baseUrl,
    apiKey: connection.apiKey,
    fetch: withOpenAIImageEditFilenamesFetch(globalThis.fetch),
  });
}
