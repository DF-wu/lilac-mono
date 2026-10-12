import {
  createOpenAICompatibleImageProvider,
  env,
  getModelProviders,
  OPENAI_COMPATIBLE_IMAGE_PROVIDER_NAME,
  type CoreConfig,
  type ImageModelRoute,
  type ImageRouteProvider,
} from "@stanley2058/lilac-utils";
import type { ServerToolFailure } from "@stanley2058/lilac-plugin-runtime";
import { Result, type Result as ResultType } from "better-result";
import type { generateImage, ImageModel } from "ai";

import { generateFailure, isConfiguredProvider } from "../generate";
import {
  compatibleImageModelId,
  DEFAULT_IMAGE_MODEL_FALLBACK_ORDER,
  DEFAULT_IMAGE_PROVIDER_ORDER,
  IMAGE_MODEL_CATALOG,
  IMAGE_MODEL_IDS,
  type DefaultImageProvider,
  type ImageDimensions,
  type SupportedImageModelId,
} from "./catalog";

const OPENAI_COMPATIBLE_IMAGE_CONFIG_ERROR =
  "Image generation provider 'openai-compatible' requires OPENAI_COMPATIBLE_BASE_URL.";

const PROVIDER_CREDENTIALS: Readonly<Record<ImageRouteProvider, string>> = {
  openai: "OPENAI_API_KEY or OPENAI_BASE_URL",
  openrouter: "OPENROUTER_API_KEY or OPENROUTER_BASE_URL",
  xai: "XAI_API_KEY or XAI_BASE_URL",
  "openai-compatible": "OPENAI_COMPATIBLE_BASE_URL",
};

export type ImageConfig = CoreConfig["tools"]["generate"]["image"];
type ModelProviders = ReturnType<typeof getModelProviders>;

export type ImageRequestOptions = Pick<
  Parameters<typeof generateImage>[0],
  "size" | "aspectRatio" | "maxRetries" | "providerOptions"
>;

/** An alias the current config routes somewhere, resolved against the environment. */
export type ResolvedImageModel =
  | {
      readonly kind: "ready";
      readonly route: ImageModelRoute;
      readonly model: ImageModel;
    }
  | {
      readonly kind: "unavailable";
      readonly route: ImageModelRoute;
      /** Why the route cannot be used right now, phrased for the operator. */
      readonly reason: string;
    };

/** Aliases absent from the record are not routed by the current config and are not advertised. */
export type ResolvedImageModels = Partial<Record<SupportedImageModelId, ResolvedImageModel>>;

export type PickedImageModel = {
  readonly id: SupportedImageModelId;
  readonly route: ImageModelRoute;
  readonly model: ImageModel;
};

type PlannedRoute = ImageModelRoute & {
  /** Set when the operator named this route in `routes`. */
  readonly explicit: boolean;
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

/** The built-in route: the first configured provider in the catalog that serves the alias. */
function defaultRoute(modelId: SupportedImageModelId): PlannedRoute | undefined {
  const providerModelIds = IMAGE_MODEL_CATALOG[modelId].providerModelIds;
  for (const provider of DEFAULT_IMAGE_PROVIDER_ORDER) {
    const upstreamId = providerModelIds[provider];
    if (!upstreamId || !isConfiguredProvider(provider)) continue;
    return { provider, modelId: upstreamId, explicit: false };
  }
  return undefined;
}

function planRoute(modelId: SupportedImageModelId, config: ImageConfig): PlannedRoute | undefined {
  const explicit = config.routes[modelId];
  if (explicit) return { ...explicit, explicit: true };
  if (config.provider === "openai-compatible") {
    return {
      provider: "openai-compatible",
      modelId: compatibleImageModelId(modelId),
      explicit: false,
    };
  }
  return defaultRoute(modelId);
}

function compatibleConnection() {
  const baseUrl = env.providers.openaiCompatible.baseUrl?.trim();
  if (!baseUrl) return undefined;
  return { baseUrl, apiKey: env.providers.openaiCompatible.apiKey };
}

/**
 * An explicit route names itself and the missing variable. A bulk route reuses
 * the shared `bulkReason`; without one it falls back to the explicit wording.
 */
function unavailable(
  modelId: SupportedImageModelId,
  planned: PlannedRoute,
  bulkReason?: string,
): ResolvedImageModel {
  const routeReason = `Image route '${planned.provider}/${planned.modelId}' for '${modelId}' requires ${PROVIDER_CREDENTIALS[planned.provider]}.`;
  return {
    kind: "unavailable",
    route: { provider: planned.provider, modelId: planned.modelId },
    reason: planned.explicit ? routeReason : (bulkReason ?? routeReason),
  };
}

function ready(planned: PlannedRoute, model: ImageModel): ResolvedImageModel {
  return { kind: "ready", route: { provider: planned.provider, modelId: planned.modelId }, model };
}

type RouteClients = {
  readonly providers: () => ModelProviders;
  readonly compatible: () => ReturnType<typeof createOpenAICompatibleImageProvider> | undefined;
};

/** Builds each provider client at most once per resolution and only when a route needs it. */
function routeClients(): RouteClients {
  let providers: ModelProviders | undefined;
  let compatible: ReturnType<typeof createOpenAICompatibleImageProvider> | undefined;
  return {
    providers: () => (providers ??= getModelProviders()),
    compatible: () => {
      if (compatible) return compatible;
      const connection = compatibleConnection();
      if (!connection) return undefined;
      compatible = createOpenAICompatibleImageProvider(connection);
      return compatible;
    },
  };
}

function materializeRoute(
  modelId: SupportedImageModelId,
  planned: PlannedRoute,
  clients: RouteClients,
): ResolvedImageModel {
  if (planned.provider === "openai-compatible") {
    const client = clients.compatible();
    if (!client) return unavailable(modelId, planned, OPENAI_COMPATIBLE_IMAGE_CONFIG_ERROR);
    return ready(planned, client.imageModel(planned.modelId));
  }

  if (!isConfiguredProvider(planned.provider)) return unavailable(modelId, planned);
  const model = imageProviderFor(planned.provider, clients.providers())?.imageModel(
    planned.modelId,
  );
  if (!model) return unavailable(modelId, planned);
  return ready(planned, model);
}

/**
 * Resolves every alias the config routes (the allowlist, or all aliases)
 * against the live environment. Explicit routes and bulk OpenAI-compatible
 * routes stay in the result as `unavailable` when credentials are missing, so
 * the catalog still advertises them and a call reports the exact gap; default
 * routes without a configured provider are omitted.
 */
export function resolveImageModels(imageConfig: ImageConfig | undefined): ResolvedImageModels {
  const config = imageConfig ?? { provider: "default", routes: {} };
  const aliases = config.models ?? IMAGE_MODEL_IDS;
  const clients = routeClients();
  const resolved: ResolvedImageModels = {};
  for (const modelId of aliases) {
    const planned = planRoute(modelId, config);
    if (!planned) continue;
    resolved[modelId] = materializeRoute(modelId, planned, clients);
  }
  return resolved;
}

/** Advertised aliases in fallback order: every resolved alias, ready or not. */
export function advertisedImageModelIds(resolved: ResolvedImageModels): SupportedImageModelId[] {
  return DEFAULT_IMAGE_MODEL_FALLBACK_ORDER.filter((modelId) => resolved[modelId] !== undefined);
}

function readyImageModelIds(resolved: ResolvedImageModels): SupportedImageModelId[] {
  return DEFAULT_IMAGE_MODEL_FALLBACK_ORDER.filter(
    (modelId) => resolved[modelId]?.kind === "ready",
  );
}

function pickedFrom(
  modelId: SupportedImageModelId,
  entry: ResolvedImageModel,
): ResultType<PickedImageModel, ServerToolFailure> {
  if (entry.kind === "unavailable") return Result.err(generateFailure("usage", entry.reason));
  return Result.ok({ id: modelId, route: entry.route, model: entry.model });
}

function pickRequestedImageModel(
  resolved: ResolvedImageModels,
  requested: string,
): ResultType<PickedImageModel, ServerToolFailure> {
  const modelId = IMAGE_MODEL_IDS.find((id) => id === requested);
  const entry = modelId ? resolved[modelId] : undefined;
  if (!modelId || !entry) {
    return Result.err(
      generateFailure(
        "unavailable",
        `Requested model '${requested}' is not available for image generation (configured: ${readyImageModelIds(resolved).join(", ") || "none"}).`,
      ),
    );
  }
  return pickedFrom(modelId, entry);
}

/**
 * Picks the requested alias, or the first ready alias in fallback order. When
 * nothing is ready, the first unavailable route's reason is returned so the
 * operator sees the missing credential instead of a generic message.
 */
export function pickImageModel(
  resolved: ResolvedImageModels,
  requested: string | undefined,
): ResultType<PickedImageModel, ServerToolFailure> {
  if (requested) return pickRequestedImageModel(resolved, requested);

  const readyId = readyImageModelIds(resolved)[0];
  const readyEntry = readyId ? resolved[readyId] : undefined;
  if (readyId && readyEntry) return pickedFrom(readyId, readyEntry);

  const blockedId = advertisedImageModelIds(resolved)[0];
  const blockedEntry = blockedId ? resolved[blockedId] : undefined;
  if (blockedId && blockedEntry) return pickedFrom(blockedId, blockedEntry);

  return Result.err(
    generateFailure(
      "unavailable",
      "No image generation models are configured. Configure at least one provider for image generation.",
    ),
  );
}

/**
 * Request options for the picked route. The OpenAI-compatible image API has no
 * aspect-ratio parameter, so a validated ratio is forwarded as a colon-form
 * `size` for gateways that map it (new-api maps it to Gemini's aspectRatio)
 * instead of letting the SDK drop it with an `unsupported` warning; that route
 * also sends exactly one attempt. Other providers receive the dimensions as is.
 */
export function imageRequestOptions(
  provider: ImageRouteProvider,
  dimensions: ImageDimensions,
): ImageRequestOptions {
  if (provider !== "openai-compatible") {
    return { size: dimensions.size, aspectRatio: dimensions.aspectRatio };
  }
  return {
    size: dimensions.size,
    maxRetries: 0,
    providerOptions: dimensions.aspectRatio
      ? { [OPENAI_COMPATIBLE_IMAGE_PROVIDER_NAME]: { size: dimensions.aspectRatio } }
      : undefined,
  };
}
