// Fork-owned structured `generate.image`. Upstream replaced this contract with a
// script runner; keeping the implementation here leaves `../generate.ts` a
// thin registration hook so upstream merges stay mechanical.
//
// Module map:
// - catalog.ts: one capability entry per alias (provider model IDs, ratios,
//   size rule, edit support) plus the fallback order and dimension mapping.
// - validation.ts: checks a request against the catalog before any HTTP call.
// - input.ts: the zod input schema; its help text is derived from the catalog.
// - routing.ts: resolves the default provider route or the OpenAI-compatible
//   route from the live config and environment.
// - prompt.ts: reads input images and masks into the AI SDK prompt shape.
// - callable.ts: the Level 2 callable that ties the pieces together.
export {
  createGenerateImageCallable,
  type GenerateImageCallableDefinition,
  type GenerateImageConfigSource,
  type GenerateImageResult,
} from "./callable";
export {
  compatibleImageModelId,
  DEFAULT_IMAGE_MODEL_FALLBACK_ORDER,
  DEFAULT_IMAGE_PROVIDER_ORDER,
  gptAspectRatioToSize,
  IMAGE_MODEL_CATALOG,
  IMAGE_MODEL_IDS,
  imageModelCapabilities,
  orderImageModelIds,
  resolveImageDimensions,
  type ImageModelCapabilities,
  type ImageSizeRule,
  type SupportedImageModelId,
} from "./catalog";
export {
  imageGenerateInputSchema,
  type ImageGenerateInput,
  type ImageGenerationPrompt,
} from "./input";
export { buildImageGenerationPrompt, resolveImageEditInputs } from "./prompt";
export { resolveImageRoute, type ImageRoute } from "./routing";
export { validateImageGenerationInputForModel } from "./validation";
