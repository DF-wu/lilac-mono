import {
  IMAGE_GENERATION_MODEL_ALIASES,
  type ImageGenerationModelAlias,
} from "@stanley2058/lilac-utils";

/**
 * Fork-owned alias catalog for the structured `generate.image` tool.
 *
 * One entry per Lilac alias declares the upstream model IDs per provider and
 * the request shape the model accepts. Validation, default provider routing,
 * OpenAI-compatible model IDs, and the input-schema help text all derive from
 * this table, so adding an alias means adding it to
 * `IMAGE_GENERATION_MODEL_ALIASES` in `packages/utils` (the config contract) and
 * one entry here; TypeScript rejects a catalog that misses an alias.
 */

export type SupportedImageModelId = ImageGenerationModelAlias;

/** Providers the default route can serve an alias from, in preference order. */
export const DEFAULT_IMAGE_PROVIDER_ORDER = ["openai", "openrouter", "xai"] as const;
export type DefaultImageProvider = (typeof DEFAULT_IMAGE_PROVIDER_ORDER)[number];

export type ImageSizeRule =
  /** The model rejects an explicit size; callers must use aspectRatio. */
  | { readonly kind: "unsupported"; readonly reason?: string }
  /** Any `WxH` value is forwarded unchanged. */
  | { readonly kind: "unrestricted" }
  /** Only the listed `WxH` values are accepted. */
  | { readonly kind: "fixed"; readonly allowed: readonly string[] }
  /** gpt-image-2: flexible dimensions for generation, fixed sizes for edits. */
  | { readonly kind: "gpt-image-2" };

export type ImageModelCapabilities = {
  /** Upstream model IDs per provider; the default route tries them in `DEFAULT_IMAGE_PROVIDER_ORDER`. */
  readonly providerModelIds: Readonly<Partial<Record<DefaultImageProvider, string>>>;
  /** Accepted `aspectRatio` values. */
  readonly aspectRatios: readonly string[];
  /**
   * When set, `aspectRatio` is converted to this `WxH` size before the request
   * instead of being forwarded; the model has no aspect-ratio parameter.
   */
  readonly aspectRatioSizes?: Readonly<Record<string, `${number}x${number}`>>;
  readonly size: ImageSizeRule;
  /** Maximum number of `inputImages`; unlimited when omitted. */
  readonly maxInputImages?: number;
  readonly supportsMask: boolean;
};

export const GPT_IMAGE_ALLOWED_ASPECT_RATIOS = ["1:1", "3:2", "2:3"] as const;
export const GPT_IMAGE_STANDARD_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
export const GPT_IMAGE_2_MIN_PIXELS = 655_360;
export const GPT_IMAGE_2_MAX_PIXELS = 8_294_400;
export const GPT_IMAGE_2_MAX_EDGE = 3840;
export const GPT_IMAGE_2_MAX_ASPECT_RATIO = 3;

const GPT_IMAGE_ASPECT_RATIO_SIZES = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
} as const satisfies Record<
  (typeof GPT_IMAGE_ALLOWED_ASPECT_RATIOS)[number],
  (typeof GPT_IMAGE_STANDARD_SIZES)[number]
>;

const NANOBANANA_ALLOWED_ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "3:2",
  "4:3",
  "5:4",
  "1:1",
  "4:5",
  "3:4",
  "2:3",
  "9:16",
] as const;

const NANOBANANA_2_ALLOWED_ASPECT_RATIOS = [
  ...NANOBANANA_ALLOWED_ASPECT_RATIOS,
  "1:4",
  "4:1",
  "1:8",
  "8:1",
] as const;

const GROK_IMAGE_ALLOWED_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
] as const;

const GPT_IMAGE_CAPABILITIES = {
  aspectRatios: GPT_IMAGE_ALLOWED_ASPECT_RATIOS,
  aspectRatioSizes: GPT_IMAGE_ASPECT_RATIO_SIZES,
  supportsMask: true,
} satisfies Partial<ImageModelCapabilities>;

const GROK_IMAGE_CAPABILITIES = {
  aspectRatios: GROK_IMAGE_ALLOWED_ASPECT_RATIOS,
  size: { kind: "unsupported" },
  maxInputImages: 1,
  supportsMask: false,
} satisfies Partial<ImageModelCapabilities>;

export const IMAGE_MODEL_CATALOG: Readonly<Record<SupportedImageModelId, ImageModelCapabilities>> =
  {
    /** Recommended default; arbitrary generation sizes within the model limits. */
    "gpt-image-2": {
      ...GPT_IMAGE_CAPABILITIES,
      providerModelIds: { openai: "gpt-image-2", openrouter: "openai/gpt-image-2" },
      size: { kind: "gpt-image-2" },
    },
    "gpt-5-image": {
      ...GPT_IMAGE_CAPABILITIES,
      providerModelIds: { openai: "gpt-image-1.5", openrouter: "openai/gpt-5-image" },
      size: { kind: "fixed", allowed: GPT_IMAGE_STANDARD_SIZES },
    },
    nanobanana: {
      providerModelIds: { openrouter: "google/gemini-2.5-flash-image" },
      aspectRatios: NANOBANANA_ALLOWED_ASPECT_RATIOS,
      size: { kind: "unrestricted" },
      supportsMask: true,
    },
    /** Resolution tiers 1K, 2K, 4K. */
    "nanobanana-2": {
      providerModelIds: { openrouter: "google/gemini-3.1-flash-image-preview" },
      aspectRatios: NANOBANANA_2_ALLOWED_ASPECT_RATIOS,
      size: { kind: "unrestricted" },
      supportsMask: true,
    },
    /** 1K output only. */
    "nanobanana-2-lite": {
      providerModelIds: { openrouter: "google/gemini-3.1-flash-lite-image" },
      aspectRatios: NANOBANANA_2_ALLOWED_ASPECT_RATIOS,
      size: {
        kind: "unsupported",
        reason: "nanobanana-2-lite produces 1K output; use aspectRatio instead of size.",
      },
      supportsMask: false,
    },
    /** Resolution tiers 1K, 2K, 4K. */
    "nanobanana-pro": {
      providerModelIds: { openrouter: "google/gemini-3-pro-image-preview" },
      aspectRatios: NANOBANANA_ALLOWED_ASPECT_RATIOS,
      size: { kind: "unrestricted" },
      supportsMask: true,
    },
    "grok-imagine-image": {
      ...GROK_IMAGE_CAPABILITIES,
      providerModelIds: { xai: "grok-imagine-image" },
    },
    "grok-imagine-image-pro": {
      ...GROK_IMAGE_CAPABILITIES,
      providerModelIds: { xai: "grok-imagine-image-pro" },
    },
  };

/**
 * Fallback order when the caller does not pick an alias. A drift test pins this
 * list to `IMAGE_GENERATION_MODEL_ALIASES` so neither can gain or lose an alias
 * silently.
 */
export const DEFAULT_IMAGE_MODEL_FALLBACK_ORDER: readonly SupportedImageModelId[] = [
  "gpt-image-2",
  "nanobanana-2",
  "nanobanana-pro",
  "gpt-5-image",
  "grok-imagine-image-pro",
  "grok-imagine-image",
  "nanobanana-2-lite",
  "nanobanana",
];

/** All aliases in the config contract's declaration order. */
export const IMAGE_MODEL_IDS: readonly SupportedImageModelId[] = IMAGE_GENERATION_MODEL_ALIASES;

export function imageModelCapabilities(modelId: SupportedImageModelId): ImageModelCapabilities {
  return IMAGE_MODEL_CATALOG[modelId];
}

/**
 * The model ID sent to an OpenAI-compatible endpoint when the operator has not
 * overridden it: the alias's first upstream provider ID in
 * `DEFAULT_IMAGE_PROVIDER_ORDER`. Every alias declares at least one provider ID,
 * so the fallback branch is unreachable in practice.
 */
export function compatibleImageModelId(modelId: SupportedImageModelId): string {
  const providerModelIds = IMAGE_MODEL_CATALOG[modelId].providerModelIds;
  for (const provider of DEFAULT_IMAGE_PROVIDER_ORDER) {
    const upstreamId = providerModelIds[provider];
    if (upstreamId) return upstreamId;
  }
  return modelId;
}

export function orderImageModelIds(ids: readonly SupportedImageModelId[]): SupportedImageModelId[] {
  const available = new Set(ids);
  return DEFAULT_IMAGE_MODEL_FALLBACK_ORDER.filter((id) => available.has(id));
}

export function gptAspectRatioToSize(
  aspectRatio: (typeof GPT_IMAGE_ALLOWED_ASPECT_RATIOS)[number],
): (typeof GPT_IMAGE_STANDARD_SIZES)[number] {
  return GPT_IMAGE_ASPECT_RATIO_SIZES[aspectRatio];
}

export type ImageDimensions = {
  readonly size?: `${number}x${number}`;
  readonly aspectRatio?: `${number}:${number}`;
};

/**
 * Maps validated `size`/`aspectRatio` input onto the request dimensions for the
 * alias. Aliases with `aspectRatioSizes` receive a `WxH` size instead of a
 * ratio; the others forward the ratio unchanged.
 */
export function resolveImageDimensions(
  modelId: SupportedImageModelId,
  input: { readonly size?: string; readonly aspectRatio?: string },
): ImageDimensions {
  if (input.size) return { size: input.size as `${number}x${number}` };
  if (!input.aspectRatio) return {};

  const convertedSize = IMAGE_MODEL_CATALOG[modelId].aspectRatioSizes?.[input.aspectRatio];
  if (convertedSize) return { size: convertedSize };
  return { aspectRatio: input.aspectRatio as `${number}:${number}` };
}
