import {
  env,
  getModelProviders,
  type CoreConfig,
  type ImageGenerationModelAlias,
} from "@stanley2058/lilac-utils";
import type { ImageModel } from "ai";

const OPENAI_COMPATIBLE_IMAGE_CONFIG_ERROR =
  "Image generation provider 'openai-compatible' requires OPENAI_COMPATIBLE_BASE_URL.";

const OPENAI_COMPATIBLE_IMAGE_MODEL_IDS = {
  "gpt-image-2": "gpt-image-2",
  "gpt-5-image": "gpt-image-1.5",
  nanobanana: "google/gemini-2.5-flash-image",
  "nanobanana-2": "google/gemini-3.1-flash-image-preview",
  "nanobanana-2-lite": "google/gemini-3.1-flash-lite-image",
  "nanobanana-pro": "google/gemini-3-pro-image-preview",
  "grok-imagine-image": "grok-imagine-image",
  "grok-imagine-image-pro": "grok-imagine-image-pro",
} as const satisfies Record<ImageGenerationModelAlias, string>;

type ImageConfig = CoreConfig["tools"]["generate"]["image"];
type ImageProvider = ImageConfig["provider"];

type ImageDescriptor<TId extends ImageGenerationModelAlias> = {
  readonly id: TId;
};

type AvailableImageModels<TId extends string, TDescriptor> = {
  readonly available: Partial<Record<TId, ImageModel>>;
  readonly byId: Map<TId, TDescriptor>;
  readonly ids: TId[];
};

type ImageDimensions = {
  readonly size?: `${number}x${number}`;
  readonly aspectRatio?: `${number}:${number}`;
};

function filterCompatibleDescriptors<
  TId extends ImageGenerationModelAlias,
  TDescriptor extends ImageDescriptor<TId>,
>(
  descriptors: readonly TDescriptor[],
  models: ImageConfig["openaiCompatible"]["models"],
): TDescriptor[] {
  if (!models) return [...descriptors];
  const allowed: ReadonlySet<string> = new Set(models);
  return descriptors.filter((descriptor) => allowed.has(descriptor.id));
}

function resolveCompatibleModels<
  TId extends ImageGenerationModelAlias,
  TDescriptor extends ImageDescriptor<TId>,
>(
  descriptors: readonly TDescriptor[],
  config: ImageConfig["openaiCompatible"],
  providers: ReturnType<typeof getModelProviders>,
): AvailableImageModels<TId, TDescriptor> {
  const compatibleProvider = providers["openai-compatible"];
  if (!env.providers.openaiCompatible.baseUrl?.trim() || !compatibleProvider) {
    return { available: {}, byId: new Map(), ids: [] };
  }

  const available: Partial<Record<TId, ImageModel>> = {};
  const byId = new Map<TId, TDescriptor>();
  const ids: TId[] = [];

  for (const descriptor of descriptors) {
    const modelId =
      config.modelIds[descriptor.id] ?? OPENAI_COMPATIBLE_IMAGE_MODEL_IDS[descriptor.id];
    available[descriptor.id] = compatibleProvider.imageModel(modelId);
    byId.set(descriptor.id, descriptor);
    ids.push(descriptor.id);
  }

  return { available, byId, ids };
}

function resolveGenerationOptions(provider: ImageProvider, dimensions: ImageDimensions) {
  if (provider !== "openai-compatible" || !dimensions.aspectRatio) {
    return {
      size: dimensions.size,
      aspectRatio: dimensions.aspectRatio,
      maxRetries: provider === "openai-compatible" ? 0 : undefined,
      providerOptions: undefined,
    };
  }

  // The OpenAI-compatible image API has no aspect-ratio parameter. Forward a
  // validated ratio as a colon-form `size` option for gateways that support it
  // instead of letting the SDK silently drop the requested ratio.
  return {
    size: dimensions.size,
    aspectRatio: undefined,
    maxRetries: 0,
    providerOptions: { openaiCompatible: { size: dimensions.aspectRatio } },
  };
}

export function resolveImageRouting<
  TId extends ImageGenerationModelAlias,
  TDescriptor extends ImageDescriptor<TId>,
>(input: {
  readonly imageConfig?: ImageConfig;
  readonly descriptors: readonly TDescriptor[];
  readonly resolveDefaultModels: () => AvailableImageModels<TId, TDescriptor>;
}) {
  const provider = input.imageConfig?.provider ?? "default";
  const compatibleConfig = input.imageConfig?.openaiCompatible ?? { modelIds: {} };
  const compatibleDescriptors = filterCompatibleDescriptors(
    input.descriptors,
    compatibleConfig.models,
  );
  const availableModels = () => {
    return provider === "openai-compatible"
      ? resolveCompatibleModels(compatibleDescriptors, compatibleConfig, getModelProviders())
      : input.resolveDefaultModels();
  };

  return {
    configurationError:
      provider === "openai-compatible" && !env.providers.openaiCompatible.baseUrl?.trim()
        ? OPENAI_COMPATIBLE_IMAGE_CONFIG_ERROR
        : undefined,
    catalogModelIds:
      provider === "openai-compatible"
        ? compatibleDescriptors.map((descriptor) => descriptor.id)
        : availableModels().ids,
    availableModels,
    generationOptions: (dimensions: ImageDimensions) =>
      resolveGenerationOptions(provider, dimensions),
  };
}
