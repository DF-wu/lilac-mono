import { z } from "zod";

import { parseModelSpecifierResult } from "../model-capability";

/**
 * Fork-owned `tools.generate` configuration.
 *
 * The fork keeps the structured `generate.image` tool (prompt, model alias,
 * dimensions, reference images) and lets operators route aliases: a bulk
 * `provider` for every alias plus per-alias `<provider>/<model id>` routes.
 * The upstream-owned `types.ts`, `v1.ts`, and `v2.ts` only import from this
 * module.
 */

/**
 * Canonical list of Lilac `generate.image` model aliases. The alias catalog in
 * apps/core is typed against this list, and a drift test pins it to the
 * tool's fallback order so the two cannot diverge silently.
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

/** Providers a `tools.generate.image.routes` entry may name. */
export const IMAGE_ROUTE_PROVIDERS = ["openai", "openrouter", "xai", "openai-compatible"] as const;

export type ImageRouteProvider = (typeof IMAGE_ROUTE_PROVIDERS)[number];

/** One parsed `<provider>/<model id>` route. */
export type ImageModelRoute = {
  readonly provider: ImageRouteProvider;
  /** The model ID sent to the provider; may itself contain slashes (OpenRouter slugs). */
  readonly modelId: string;
};

export type GenerateToolsConfig = {
  image: {
    /**
     * Route for aliases without an entry in `routes`: `default` uses the
     * built-in provider preference, `openai-compatible` sends them to the
     * OpenAI-compatible endpoint with their catalog model IDs.
     */
    provider: "default" | "openai-compatible";
    /** Optional allowlist of aliases to advertise and serve; omitted = all aliases. */
    models?: readonly ImageGenerationModelAlias[];
    /** Per-alias routes; unlisted aliases follow `provider`. */
    routes: Partial<Record<ImageGenerationModelAlias, ImageModelRoute>>;
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
      routes: {},
    },
  } satisfies GenerateToolsConfig;
}

const ALIAS_LIST = IMAGE_GENERATION_MODEL_ALIASES.join(", ");

const imageGenerationAliasSchema = z.enum(IMAGE_GENERATION_MODEL_ALIASES, {
  error: `Unknown generate.image alias. Valid aliases: ${ALIAS_LIST}.`,
});

const IMAGE_ROUTE_FORMAT = `'<provider>/<model id>' with provider ${IMAGE_ROUTE_PROVIDERS.join(", ")}`;

function isImageRouteProvider(provider: string): provider is ImageRouteProvider {
  return (IMAGE_ROUTE_PROVIDERS as readonly string[]).includes(provider);
}

function parseImageRoute(spec: string): ImageModelRoute | undefined {
  return parseModelSpecifierResult(spec).match<ImageModelRoute | undefined>({
    ok: ({ provider, model }) => {
      const modelId = model.trim();
      return isImageRouteProvider(provider) && modelId ? { provider, modelId } : undefined;
    },
    err: () => undefined,
  });
}

const imageRouteSchema = z
  .string()
  .trim()
  .transform((spec, ctx): ImageModelRoute => {
    const route = parseImageRoute(spec);
    if (route) return route;
    ctx.addIssue({
      code: "custom",
      message: `Invalid generate.image route '${spec}'. Expected ${IMAGE_ROUTE_FORMAT}.`,
    });
    return z.NEVER;
  });

const LEGACY_OPENAI_COMPATIBLE_ERROR =
  "tools.generate.image.openaiCompatible was replaced. Move `openaiCompatible.models` to `tools.generate.image.models` and each `openaiCompatible.modelIds` entry to `tools.generate.image.routes` as `<alias>: openai-compatible/<model id>`.";

const imageToolsSchema = z
  .object({
    provider: z.enum(["default", "openai-compatible"]).default("default"),
    models: z.array(imageGenerationAliasSchema).min(1).optional(),
    routes: z
      .partialRecord(imageGenerationAliasSchema, imageRouteSchema, {
        error: (issue) =>
          issue.code === "invalid_key"
            ? `Unknown generate.image alias in routes. Valid aliases: ${ALIAS_LIST}.`
            : undefined,
      })
      .default({}),
    /** Rejected explicitly so the old shape fails loudly instead of being ignored as an unknown key. */
    openaiCompatible: z.undefined({ error: LEGACY_OPENAI_COMPATIBLE_ERROR }),
  })
  .transform((image): GenerateToolsConfig["image"] => ({
    provider: image.provider,
    ...(image.models ? { models: image.models } : {}),
    routes: image.routes,
  }));

/** v2 input schema for `tools.generate`. */
export const generateToolsSchema = z
  .object({
    image: imageToolsSchema.default(() => defaultGenerateToolsConfig().image),
  })
  .default(() => defaultGenerateToolsConfig());
