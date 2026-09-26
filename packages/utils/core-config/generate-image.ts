import { z } from "zod";

/**
 * Fork-owned `tools.generate` configuration.
 *
 * The fork keeps the structured `generate.image` tool (prompt, model alias,
 * dimensions, reference images) and can route every alias through one
 * OpenAI-compatible endpoint. The upstream-owned `types.ts`, `v1.ts`, and
 * `v2.ts` only import from this module.
 */

/**
 * Canonical list of Lilac `generate.image` model aliases. A drift test in
 * apps/core pins this list to the generate tool's fallback order so the two
 * cannot diverge silently.
 */
export const IMAGE_GENERATION_MODEL_ALIASES = [
  "gpt-image-2",
  "gpt-5-image",
  "nanobanana",
  "nanobanana-2",
  "nanobanana-2-lite",
  "nanobanana-pro",
  "grok-imagine-image",
  "grok-imagine-image-pro",
] as const;

export type ImageGenerationModelAlias = (typeof IMAGE_GENERATION_MODEL_ALIASES)[number];

export type GenerateToolsConfig = {
  image: {
    provider: "default" | "openai-compatible";
    /** Only meaningful when provider is "openai-compatible". */
    openaiCompatible: {
      /** Optional allowlist of aliases the endpoint serves; omitted = all aliases. */
      models?: readonly ImageGenerationModelAlias[];
      /** Per-alias upstream model-ID overrides; unlisted aliases keep canonical IDs. */
      modelIds: Partial<Record<ImageGenerationModelAlias, string>>;
    };
  };
};

/**
 * Shared by the v2 schema defaults and the v1 fallback so both config
 * versions expose the same `tools.generate` shape. Returns a fresh object so
 * parsed configs never share nested state.
 */
export function defaultGenerateToolsConfig() {
  return {
    image: {
      provider: "default" as const,
      openaiCompatible: { modelIds: {} },
    },
  } satisfies GenerateToolsConfig;
}

const imageGenerationAliasSchema = z.enum(IMAGE_GENERATION_MODEL_ALIASES, {
  error: `Unknown generate.image alias. Valid aliases: ${IMAGE_GENERATION_MODEL_ALIASES.join(", ")}.`,
});

const generateImageOpenAICompatibleSchema = z
  .object({
    models: z.array(imageGenerationAliasSchema).min(1).optional(),
    modelIds: z
      .partialRecord(imageGenerationAliasSchema, z.string().trim().min(1), {
        error: (issue) =>
          issue.code === "invalid_key"
            ? `Unknown generate.image alias in modelIds. Valid aliases: ${IMAGE_GENERATION_MODEL_ALIASES.join(", ")}.`
            : undefined,
      })
      .default({}),
  })
  .default({ modelIds: {} });

/** v2 input schema for `tools.generate`. */
export const generateToolsSchema = z
  .object({
    image: z
      .object({
        provider: z.enum(["default", "openai-compatible"]).default("default"),
        openaiCompatible: generateImageOpenAICompatibleSchema,
      })
      .default(() => defaultGenerateToolsConfig().image),
  })
  .default(() => defaultGenerateToolsConfig());
