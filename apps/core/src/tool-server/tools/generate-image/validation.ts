import type { ServerToolFailure } from "@stanley2058/lilac-plugin-runtime";
import { Result, type Result as ResultType } from "better-result";

import { generateFailure } from "../generate";
import {
  GPT_IMAGE_2_MAX_ASPECT_RATIO,
  GPT_IMAGE_2_MAX_EDGE,
  GPT_IMAGE_2_MAX_PIXELS,
  GPT_IMAGE_2_MIN_PIXELS,
  GPT_IMAGE_STANDARD_SIZES,
  IMAGE_MODEL_CATALOG,
  type ImageModelCapabilities,
  type ImageSizeRule,
  type SupportedImageModelId,
} from "./catalog";
import type { ImageGenerateInput } from "./input";

/** The parsed tool input; capabilities constrain size, aspectRatio, inputImages, and maskImage. */
type ImageGenerationInputShape = ImageGenerateInput;

type Validation = ResultType<void, ServerToolFailure>;

const VALID: Validation = Result.ok(undefined);

function usage(message: string): Validation {
  return Result.err(generateFailure("usage", message));
}

function parseSize(size: string): { readonly width: number; readonly height: number } {
  const separatorIndex = size.indexOf("x");
  return {
    width: Number(size.slice(0, separatorIndex)),
    height: Number(size.slice(separatorIndex + 1)),
  };
}

function fitsGptImage2Generation(size: string): boolean {
  const { width, height } = parseSize(size);
  const pixels = width * height;
  return (
    width % 16 === 0 &&
    height % 16 === 0 &&
    width <= GPT_IMAGE_2_MAX_EDGE &&
    height <= GPT_IMAGE_2_MAX_EDGE &&
    Math.max(width, height) / Math.min(width, height) <= GPT_IMAGE_2_MAX_ASPECT_RATIO &&
    pixels >= GPT_IMAGE_2_MIN_PIXELS &&
    pixels <= GPT_IMAGE_2_MAX_PIXELS
  );
}

function validateFixedSize(
  modelId: SupportedImageModelId,
  size: string,
  allowed: readonly string[],
  context = "",
): Validation {
  if (allowed.includes(size)) return VALID;
  return usage(
    `Unsupported size '${size}' for ${modelId}${context}. Allowed: ${allowed.join(" | ")}.`,
  );
}

function validateSize(
  modelId: SupportedImageModelId,
  rule: ImageSizeRule,
  input: ImageGenerationInputShape,
): Validation {
  if (!input.size) return VALID;

  switch (rule.kind) {
    case "unrestricted":
      return VALID;
    case "unsupported":
      return usage(rule.reason ?? `${modelId} does not support size. Use aspectRatio instead.`);
    case "fixed":
      return validateFixedSize(modelId, input.size, rule.allowed);
    case "gpt-image-2":
      return validateGptImage2Size(input);
  }
}

function validateGptImage2Size(input: ImageGenerationInputShape): Validation {
  const size = input.size ?? "";
  if ((input.inputImages?.length ?? 0) > 0) {
    return validateFixedSize("gpt-image-2", size, GPT_IMAGE_STANDARD_SIZES, " image edits");
  }
  if (fitsGptImage2Generation(size)) return VALID;
  return usage(
    `Unsupported size '${size}' for gpt-image-2. Both edges must be multiples of 16 and at most ${GPT_IMAGE_2_MAX_EDGE}px, the aspect ratio must not exceed 3:1, and total pixels must be ${GPT_IMAGE_2_MIN_PIXELS}-${GPT_IMAGE_2_MAX_PIXELS}.`,
  );
}

function validateAspectRatio(
  modelId: SupportedImageModelId,
  capabilities: ImageModelCapabilities,
  aspectRatio: string | undefined,
): Validation {
  if (!aspectRatio || capabilities.aspectRatios.includes(aspectRatio)) return VALID;
  return usage(
    `Unsupported aspectRatio '${aspectRatio}' for ${modelId}. Allowed: ${capabilities.aspectRatios.join(", ")}.`,
  );
}

function validateEditInputs(
  modelId: SupportedImageModelId,
  capabilities: ImageModelCapabilities,
  input: ImageGenerationInputShape,
): Validation {
  if (input.maskImage && !capabilities.supportsMask) {
    return usage(`${modelId} does not support maskImage.`);
  }

  const maxInputImages = capabilities.maxInputImages;
  if (maxInputImages === undefined || (input.inputImages?.length ?? 0) <= maxInputImages) {
    return VALID;
  }
  const limit =
    maxInputImages === 1 ? "only one input image" : `at most ${maxInputImages} input images`;
  return usage(`${modelId} supports ${limit}.`);
}

/**
 * Checks the request against the alias's declared capabilities before any
 * provider request is sent. Failures are `usage` errors naming the alias.
 */
export function validateImageGenerationInputForModel(
  modelId: SupportedImageModelId,
  input: ImageGenerationInputShape,
): Validation {
  const capabilities = IMAGE_MODEL_CATALOG[modelId];
  return Result.gen(function* () {
    yield* validateAspectRatio(modelId, capabilities, input.aspectRatio);
    yield* validateSize(modelId, capabilities.size, input);
    yield* validateEditInputs(modelId, capabilities, input);
    return VALID;
  });
}
