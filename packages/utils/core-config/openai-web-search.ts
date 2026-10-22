import { z } from "zod";

import { migrateWebExtractConfigValue, webExtractProviderSchema } from "./v1";

/** Fork-owned v2 search configuration. Keep the frozen v1 provider enum unchanged. */
const webExtractProviderSchemaV2 = z.enum([...webExtractProviderSchema.options, "openai"]);

export const webExtractConfigValueSchemaV2 = z.preprocess(
  migrateWebExtractConfigValue,
  z.object({
    providers: z
      .array(webExtractProviderSchemaV2)
      .min(1)
      .transform((providers) => [...new Set(providers)])
      .default(["tavily"]),
  }),
);

export const openaiWebSearchSchema = z.object({
  /** Only openai and openai-compatible provider/model specs run hosted search; bare IDs use openai. */
  model: z.string().trim().min(1).default("openai/gpt-5-mini"),
  searchContextSize: z.enum(["low", "medium", "high"]).default("medium"),
});

export type OpenAIWebSearchConfig = z.output<typeof openaiWebSearchSchema>;
