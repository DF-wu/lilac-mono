import { z } from "zod";

import { migrateWebExtractConfigValue, webExtractProviderSchema } from "./v1";

export const DEFAULT_OPENAI_WEB_SEARCH_MODEL_ID = "gpt-5-mini";
export const DEFAULT_OPENAI_WEB_SEARCH_MODEL_SPEC = `openai/${DEFAULT_OPENAI_WEB_SEARCH_MODEL_ID}`;
export const OPENAI_WEB_SEARCH_CONTEXT_SIZES = ["low", "medium", "high"] as const;
export const DEFAULT_OPENAI_WEB_SEARCH_CONTEXT_SIZE = "medium";

/** Fork-owned v2 search configuration. Keep the frozen v1 provider enum unchanged. */
const webExtractProviderSchemaV2 = z.enum([...webExtractProviderSchema.options, "openai"]);

export const webExtractConfigValueSchemaV2 = z.preprocess(
  migrateWebExtractConfigValue,
  z.object({
    providers: z
      .array(webExtractProviderSchemaV2)
      .min(1)
      .transform((providers) => [...new Set(providers)])
      .default(["tavily"])
      .describe(
        "Ordered search/extraction providers, deduplicated in order. Default: [tavily]. openai is search-only and skipped for extraction.",
      ),
  }),
);

export const openaiWebSearchSchema = z.object({
  /** Only openai and openai-compatible provider/model specs run hosted search; bare IDs use openai. */
  model: z
    .string()
    .trim()
    .min(1)
    .default(DEFAULT_OPENAI_WEB_SEARCH_MODEL_SPEC)
    .describe(
      `Hosted-search provider/model. Default: ${DEFAULT_OPENAI_WEB_SEARCH_MODEL_SPEC}. Supports openai and openai-compatible; legacy bare IDs use openai.`,
    ),
  searchContextSize: z
    .enum(OPENAI_WEB_SEARCH_CONTEXT_SIZES)
    .default(DEFAULT_OPENAI_WEB_SEARCH_CONTEXT_SIZE)
    .describe(
      `Hosted web search context size: low, medium, or high. Default: ${DEFAULT_OPENAI_WEB_SEARCH_CONTEXT_SIZE}.`,
    ),
});

export type OpenAIWebSearchConfig = z.output<typeof openaiWebSearchSchema>;
