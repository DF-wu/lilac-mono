// Fork-owned structured `generate.image`. Upstream replaced this contract with a
// script runner; keeping the implementation here leaves `../generate.ts` a
// thin registration hook so upstream merges stay mechanical.
export {
  createGenerateImageCallable,
  generateImageWithModel,
  type GenerateImageCallableDefinition,
  type GenerateImageConfigSource,
  type GenerateImageResult,
} from "./callable";
export {
  imageGenerateInputSchema,
  type ImageGenerateInput,
  type ImageGenerationPrompt,
} from "./input";
export {
  DEFAULT_IMAGE_MODEL_FALLBACK_ORDER,
  IMAGE_MODEL_DESCRIPTORS,
  getAvailableImageModels,
  gptAspectRatioToSize,
  orderImageModelIds,
  resolveImageDimensions,
  validateImageGenerationInputForModel,
  type ImageModelDescriptor,
  type SupportedImageModelId,
} from "./models";
export { buildImageGenerationPrompt, resolveImageEditInputs } from "./prompt";
export { resolveImageRouting } from "./routing";
