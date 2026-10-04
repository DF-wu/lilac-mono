import {
  createOpenAICompatibleImageProvider,
  env,
  getModelProviders,
  OPENAI_COMPATIBLE_IMAGE_PROVIDER_NAME,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import type { generateImage, ImageModel } from "ai";

import { isConfiguredProvider } from "../generate";
import {
  compatibleImageModelId,
  DEFAULT_IMAGE_MODEL_FALLBACK_ORDER,
  DEFAULT_IMAGE_PROVIDER_ORDER,
  IMAGE_MODEL_CATALOG,
  orderImageModelIds,
  type DefaultImageProvider,
  type ImageDimensions,
  type SupportedImageModelId,
} from "./catalog";

const OPENAI_COMPATIBLE_IMAGE_CONFIG_ERROR =
  "Image generation provider 'openai-compatible' requires OPENAI_COMPATIBLE_BASE_URL.";

export type ImageConfig = CoreConfig["tools"]["generate"]["image"];
type ImageProvider = ImageConfig["provider"];
type CompatibleImageConfig = ImageConfig["openaiCompatible"];
type ModelProviders = ReturnType<typeof getModelProviders>;

export type AvailableImageModels = {
  readonly models: Partial<Record<SupportedImageModelId, ImageModel>>;
  /** Served aliases in fallback order. */
  readonly ids: readonly SupportedImageModelId[];
};

export type ImageRequestOptions = Pick<
  Parameters<typeof generateImage>[0],
  "size" | "aspectRatio" | "maxRetries" | "providerOptions"
>;

/**
 * Where `generate.image` sends requests. Resolved per call from the live config
 * and environment so operator changes apply without rebuilding the tool.
 */
export type ImageRoute = {
  readonly provider: ImageProvider;
  /** Fails a call before model selection; the catalog still advertises the route's aliases. */
  readonly configurationError?: string;
  /** Aliases the tool catalog advertises, in fallback order. */
  readonly catalogModelIds: () => readonly SupportedImageModelId[];
  /** Aliases the route can serve right now with the current credentials. */
  readonly resolveModels: () => AvailableImageModels;
  /** Shapes validated dimensions into request options for this route. */
  readonly requestOptions: (dimensions: ImageDimensions) => ImageRequestOptions;
};

function imageProviderFor(provider: DefaultImageProvider, providers: ModelProviders) {
  switch (provider) {
    case "openai":
      return providers.openai;
    case "openrouter":
      return providers.openrouter;
    case "xai":
      return providers.xai;
  }
}

/** Builds the alias's model from the first configured provider that serves it. */
function createDefaultImageModel(
  modelId: SupportedImageModelId,
  providers: ModelProviders,
): ImageModel | undefined {
  const providerModelIds = IMAGE_MODEL_CATALOG[modelId].providerModelIds;
  for (const provider of DEFAULT_IMAGE_PROVIDER_ORDER) {
    const upstreamId = providerModelIds[provider];
    if (!upstreamId || !isConfiguredProvider(provider)) continue;
    const model = imageProviderFor(provider, providers)?.imageModel(upstreamId);
    if (model) return model;
  }
  return undefined;
}

function resolveDefaultModels(): AvailableImageModels {
  const providers = getModelProviders();
  const models: Partial<Record<SupportedImageModelId, ImageModel>> = {};
  const ids: SupportedImageModelId[] = [];
  for (const modelId of DEFAULT_IMAGE_MODEL_FALLBACK_ORDER) {
    const model = createDefaultImageModel(modelId, providers);
    if (!model) continue;
    models[modelId] = model;
    ids.push(modelId);
  }
  return { models, ids };
}

const DEFAULT_IMAGE_ROUTE: ImageRoute = {
  provider: "default",
  catalogModelIds: () => resolveDefaultModels().ids,
  resolveModels: resolveDefaultModels,
  requestOptions: (dimensions) => ({ size: dimensions.size, aspectRatio: dimensions.aspectRatio }),
};

function compatibleConnection() {
  const baseUrl = env.providers.openaiCompatible.baseUrl?.trim();
  if (!baseUrl) return undefined;
  return { baseUrl, apiKey: env.providers.openaiCompatible.apiKey };
}

function resolveCompatibleModels(
  aliases: readonly SupportedImageModelId[],
  config: CompatibleImageConfig,
): AvailableImageModels {
  const connection = compatibleConnection();
  if (!connection) return { models: {}, ids: [] };

  const client = createOpenAICompatibleImageProvider(connection);
  const models: Partial<Record<SupportedImageModelId, ImageModel>> = {};
  for (const modelId of aliases) {
    models[modelId] = client.imageModel(
      config.modelIds[modelId] ?? compatibleImageModelId(modelId),
    );
  }
  return { models, ids: aliases };
}

/**
 * The OpenAI-compatible image API has no aspect-ratio parameter. A validated
 * ratio is forwarded as a colon-form `size` for gateways that map it (new-api
 * maps it to Gemini's aspectRatio) instead of letting the SDK drop it with an
 * `unsupported` warning. The route also sends exactly one attempt.
 */
function compatibleRequestOptions(dimensions: ImageDimensions): ImageRequestOptions {
  return {
    size: dimensions.size,
    maxRetries: 0,
    providerOptions: dimensions.aspectRatio
      ? { [OPENAI_COMPATIBLE_IMAGE_PROVIDER_NAME]: { size: dimensions.aspectRatio } }
      : undefined,
  };
}

function compatibleImageRoute(config: CompatibleImageConfig): ImageRoute {
  const aliases = config.models
    ? orderImageModelIds(config.models)
    : DEFAULT_IMAGE_MODEL_FALLBACK_ORDER;
  return {
    provider: "openai-compatible",
    configurationError: compatibleConnection() ? undefined : OPENAI_COMPATIBLE_IMAGE_CONFIG_ERROR,
    catalogModelIds: () => aliases,
    resolveModels: () => resolveCompatibleModels(aliases, config),
    requestOptions: compatibleRequestOptions,
  };
}

export function resolveImageRoute(imageConfig: ImageConfig | undefined): ImageRoute {
  if (imageConfig?.provider !== "openai-compatible") return DEFAULT_IMAGE_ROUTE;
  return compatibleImageRoute(imageConfig.openaiCompatible);
}
