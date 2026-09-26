import { getModelProviders } from "@stanley2058/lilac-utils";
import type { ServerToolFailure } from "@stanley2058/lilac-plugin-runtime";
import { Result, type Result as ResultType } from "better-result";
import type { ImageModel } from "ai";

import {
  generateFailure,
  isConfiguredProvider,
  isOneOf,
  resolveAvailableModels,
  type ModelDescriptor,
} from "../generate";
import type { ImageGenerateInput } from "./input";

export type SupportedImageModelId =
  /**
   * - Recommended default
   * - Aspect ratio: 1:1, 3:2, 2:3
   * - Generation sizes: arbitrary dimensions within the model limits
   * - Edit sizes: 1024x1024, 1536x1024, 1024x1536
   */
  | "gpt-image-2"
  /**
   * - Aspect ratio: 1:1, 3:2, 2:3
   * - Sizes: 1024x1024 (1:1); 1536x1024 (3:2 landscape); 1024x1536 (2:3 portrait)
   */
  | "gpt-5-image"
  /**
   * - Aspect ratio: 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16
   */
  | "nanobanana"
  /**
   * - Provider/slug: openrouter/google/gemini-3.1-flash-image-preview
   * - Aspect ratio: 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16, 1:4, 4:1, 1:8, 8:1
   * - Supported resolution tiers: 1K, 2K, 4K
   */
  | "nanobanana-2"
  /**
   * - Provider/slug: openrouter/google/gemini-3.1-flash-lite-image
   * - Aspect ratio: 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16, 1:4, 4:1, 1:8, 8:1
   * - Resolution: 1K
   */
  | "nanobanana-2-lite"
  /**
   * - Aspect ratio: 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16
   * - Supported resolution tiers: 1K, 2K, 4K
   */
  | "nanobanana-pro"
  /**
   * - Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2, 19.5:9,
   *   9:19.5, 20:9, 9:20
   */
  | "grok-imagine-image"
  /**
   * - Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2, 19.5:9,
   *   9:19.5, 20:9, 9:20
   */
  | "grok-imagine-image-pro";

const GPT_IMAGE_ALLOWED_ASPECT_RATIOS = ["1:1", "3:2", "2:3"] as const;
const GPT_IMAGE_STANDARD_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
const GPT_IMAGE_2_MIN_PIXELS = 655_360;
const GPT_IMAGE_2_MAX_PIXELS = 8_294_400;
const GPT_IMAGE_2_MAX_EDGE = 3840;
const GPT_IMAGE_2_MAX_ASPECT_RATIO = 3;

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

export type ImageModelDescriptor = ModelDescriptor<
  SupportedImageModelId,
  ImageModel,
  ImageGenerateInput
>;

function validateGptImageInput(
  input: ImageGenerateInput,
  modelId: "gpt-image-2" | "gpt-5-image",
): ResultType<void, ServerToolFailure> {
  if (input.aspectRatio && !isOneOf(GPT_IMAGE_ALLOWED_ASPECT_RATIOS, input.aspectRatio)) {
    return Result.err(
      generateFailure(
        "usage",
        `Unsupported aspectRatio '${input.aspectRatio}' for ${modelId}. Allowed: ${GPT_IMAGE_ALLOWED_ASPECT_RATIOS.join(", ")}.`,
      ),
    );
  }

  if (!input.size) return Result.ok(undefined);

  if (modelId === "gpt-5-image" || (input.inputImages?.length ?? 0) > 0) {
    if (isOneOf(GPT_IMAGE_STANDARD_SIZES, input.size)) return Result.ok(undefined);

    const context = modelId === "gpt-image-2" ? " image edits" : "";
    return Result.err(
      generateFailure(
        "usage",
        `Unsupported size '${input.size}' for ${modelId}${context}. Allowed: ${GPT_IMAGE_STANDARD_SIZES.join(" | ")}.`,
      ),
    );
  }

  const separatorIndex = input.size.indexOf("x");
  const width = Number(input.size.slice(0, separatorIndex));
  const height = Number(input.size.slice(separatorIndex + 1));
  const pixels = width * height;
  if (
    width % 16 !== 0 ||
    height % 16 !== 0 ||
    width > GPT_IMAGE_2_MAX_EDGE ||
    height > GPT_IMAGE_2_MAX_EDGE ||
    Math.max(width, height) / Math.min(width, height) > GPT_IMAGE_2_MAX_ASPECT_RATIO ||
    pixels < GPT_IMAGE_2_MIN_PIXELS ||
    pixels > GPT_IMAGE_2_MAX_PIXELS
  ) {
    return Result.err(
      generateFailure(
        "usage",
        `Unsupported size '${input.size}' for gpt-image-2. Both edges must be multiples of 16 and at most ${GPT_IMAGE_2_MAX_EDGE}px, the aspect ratio must not exceed 3:1, and total pixels must be ${GPT_IMAGE_2_MIN_PIXELS}-${GPT_IMAGE_2_MAX_PIXELS}.`,
      ),
    );
  }
  return Result.ok(undefined);
}

function validateNanobananaInput(
  input: ImageGenerateInput,
  modelId: "nanobanana" | "nanobanana-2" | "nanobanana-2-lite" | "nanobanana-pro",
): ResultType<void, ServerToolFailure> {
  const allowedAspectRatios =
    modelId === "nanobanana-2" || modelId === "nanobanana-2-lite"
      ? NANOBANANA_2_ALLOWED_ASPECT_RATIOS
      : NANOBANANA_ALLOWED_ASPECT_RATIOS;

  if (input.aspectRatio && !isOneOf(allowedAspectRatios, input.aspectRatio)) {
    return Result.err(
      generateFailure(
        "usage",
        `Unsupported aspectRatio '${input.aspectRatio}' for ${modelId}. Allowed: ${allowedAspectRatios.join(", ")}.`,
      ),
    );
  }

  if (modelId === "nanobanana-2-lite" && input.size) {
    return Result.err(
      generateFailure(
        "usage",
        "nanobanana-2-lite produces 1K output; use aspectRatio instead of size.",
      ),
    );
  }

  if (modelId === "nanobanana-2-lite" && input.maskImage) {
    return Result.err(generateFailure("usage", "nanobanana-2-lite does not support maskImage."));
  }
  return Result.ok(undefined);
}

function validateGrokImagineInput(
  input: ImageGenerateInput,
  modelId: "grok-imagine-image" | "grok-imagine-image-pro",
): ResultType<void, ServerToolFailure> {
  if (input.size) {
    return Result.err(
      generateFailure("usage", `${modelId} does not support size. Use aspectRatio instead.`),
    );
  }

  if (input.aspectRatio && !isOneOf(GROK_IMAGE_ALLOWED_ASPECT_RATIOS, input.aspectRatio)) {
    return Result.err(
      generateFailure(
        "usage",
        `Unsupported aspectRatio '${input.aspectRatio}' for ${modelId}. Allowed: ${GROK_IMAGE_ALLOWED_ASPECT_RATIOS.join(", ")}.`,
      ),
    );
  }

  if (input.maskImage) {
    return Result.err(generateFailure("usage", `${modelId} does not support maskImage.`));
  }

  if ((input.inputImages?.length ?? 0) > 1) {
    return Result.err(generateFailure("usage", `${modelId} supports only one input image.`));
  }
  return Result.ok(undefined);
}

export function validateImageGenerationInputForModel(
  modelId: SupportedImageModelId,
  input: ImageGenerateInput,
): ResultType<void, ServerToolFailure> {
  switch (modelId) {
    case "gpt-image-2":
    case "gpt-5-image":
      return validateGptImageInput(input, modelId);
    case "nanobanana":
    case "nanobanana-2":
    case "nanobanana-2-lite":
    case "nanobanana-pro":
      return validateNanobananaInput(input, modelId);
    case "grok-imagine-image":
    case "grok-imagine-image-pro":
      return validateGrokImagineInput(input, modelId);
  }
}

export const IMAGE_MODEL_DESCRIPTORS: readonly ImageModelDescriptor[] = [
  {
    id: "gpt-image-2",
    createModel: (providers) => {
      if (isConfiguredProvider("openai")) {
        const model = providers.openai?.image("gpt-image-2");
        if (model) return model;
      }

      if (isConfiguredProvider("openrouter")) {
        return providers.openrouter?.imageModel("openai/gpt-image-2");
      }

      return undefined;
    },
    validateInput: (input) => validateImageGenerationInputForModel("gpt-image-2", input),
  },
  {
    id: "gpt-5-image",
    createModel: (providers) => {
      if (isConfiguredProvider("openai")) {
        const model = providers.openai?.image("gpt-image-1.5");
        if (model) return model;
      }

      if (isConfiguredProvider("openrouter")) {
        return providers.openrouter?.imageModel("openai/gpt-5-image");
      }

      return undefined;
    },
    validateInput: (input) => validateImageGenerationInputForModel("gpt-5-image", input),
  },
  {
    id: "nanobanana",
    createModel: (providers) => {
      if (isConfiguredProvider("openrouter")) {
        return providers.openrouter?.imageModel("google/gemini-2.5-flash-image");
      }
      return undefined;
    },
    validateInput: (input) => validateImageGenerationInputForModel("nanobanana", input),
  },
  {
    id: "nanobanana-2",
    createModel: (providers) => {
      if (isConfiguredProvider("openrouter")) {
        return providers.openrouter?.imageModel("google/gemini-3.1-flash-image-preview");
      }
      return undefined;
    },
    validateInput: (input) => validateImageGenerationInputForModel("nanobanana-2", input),
  },
  {
    id: "nanobanana-2-lite",
    createModel: (providers) => {
      if (isConfiguredProvider("openrouter")) {
        return providers.openrouter?.imageModel("google/gemini-3.1-flash-lite-image");
      }
      return undefined;
    },
    validateInput: (input) => validateImageGenerationInputForModel("nanobanana-2-lite", input),
  },
  {
    id: "nanobanana-pro",
    createModel: (providers) => {
      if (isConfiguredProvider("openrouter")) {
        return providers.openrouter?.imageModel("google/gemini-3-pro-image-preview");
      }
      return undefined;
    },
    validateInput: (input) => validateImageGenerationInputForModel("nanobanana-pro", input),
  },
  {
    id: "grok-imagine-image",
    createModel: (providers) => {
      if (!isConfiguredProvider("xai")) {
        return undefined;
      }
      return providers.xai?.image("grok-imagine-image");
    },
    validateInput: (input) => validateImageGenerationInputForModel("grok-imagine-image", input),
  },
  {
    id: "grok-imagine-image-pro",
    createModel: (providers) => {
      if (!isConfiguredProvider("xai")) {
        return undefined;
      }
      return providers.xai?.image("grok-imagine-image-pro");
    },
    validateInput: (input) => validateImageGenerationInputForModel("grok-imagine-image-pro", input),
  },
];

export function getAvailableImageModels() {
  const providers = getModelProviders();
  return resolveAvailableModels(IMAGE_MODEL_DESCRIPTORS, providers);
}

export function gptAspectRatioToSize(
  aspectRatio: (typeof GPT_IMAGE_ALLOWED_ASPECT_RATIOS)[number],
): (typeof GPT_IMAGE_STANDARD_SIZES)[number] {
  switch (aspectRatio) {
    case "1:1":
      return "1024x1024";
    case "3:2":
      return "1536x1024";
    case "2:3":
      return "1024x1536";
  }
}

export function orderImageModelIds(ids: readonly SupportedImageModelId[]): SupportedImageModelId[] {
  const available = new Set(ids);
  return DEFAULT_IMAGE_MODEL_FALLBACK_ORDER.filter((id) => available.has(id));
}

export function resolveImageDimensions(
  modelId: SupportedImageModelId,
  input: Pick<ImageGenerateInput, "size" | "aspectRatio">,
): {
  size?: `${number}x${number}`;
  aspectRatio?: `${number}:${number}`;
} {
  if (input.size) {
    return { size: input.size as `${number}x${number}` };
  }

  if (!input.aspectRatio) return {};

  if (modelId === "gpt-image-2" || modelId === "gpt-5-image") {
    return {
      size: gptAspectRatioToSize(
        input.aspectRatio as (typeof GPT_IMAGE_ALLOWED_ASPECT_RATIOS)[number],
      ),
    };
  }

  return { aspectRatio: input.aspectRatio as `${number}:${number}` };
}
