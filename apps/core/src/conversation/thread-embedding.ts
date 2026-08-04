import { embed, type EmbeddingModel } from "ai";
import {
  createLogger,
  formatTaggedErrorForLog,
  providers,
  type ResolvedModelRef,
  resolveModelRefResult,
  type ModelResolutionFailed,
  type CoreConfig,
  type JSONObject,
} from "@stanley2058/lilac-utils";
import { Result, type Result as ResultType } from "better-result";

const logger = createLogger({
  module: "conversation-thread",
});

export type ConversationThreadEmbeddingFacet =
  | "combined"
  | "aboutnessDomains"
  | "aboutnessSituations"
  | "aboutnessComplaintTargets"
  | "aboutnessEntities"
  | "userWouldAskForThisAs"
  | "brief"
  | "retrievalHints"
  | "topics"
  | "title";

export type ConversationThreadFacetInput = {
  facet: ConversationThreadEmbeddingFacet;
  text: string;
};

export type ConversationThreadEmbeddingUsageEvent = {
  modelSpec: string;
  provider: string;
  modelId: string;
  facet?: ConversationThreadEmbeddingFacet | "query";
  inputChars: number;
  tokens: number;
  warnings: number;
};

export type ConversationThreadEmbeddingAdapter = {
  modelId: string;
  dimensions?: number;
  embed(input: {
    text: string;
    facet?: ConversationThreadEmbeddingFacet | "query";
    onUsage?: (event: ConversationThreadEmbeddingUsageEvent) => void;
  }): Promise<Float32Array>;
};

export type ConversationThreadEmbeddingAdapterResolver =
  () => Promise<ConversationThreadEmbeddingAdapter | null>;

type EmbeddingProvider = NonNullable<(typeof providers)[string]> & {
  embeddingModel(modelId: string): EmbeddingModel;
};

function getProvider(providerId: string): EmbeddingProvider | null {
  return providers[providerId] ?? null;
}

function resolveConversationThreadEmbeddingModel(
  cfg: CoreConfig,
): ResultType<ResolvedModelRef | null, ModelResolutionFailed> {
  const embeddingConfig = cfg.conversation.thread.embedding;
  if (!embeddingConfig.enabled) return Result.ok(null);

  return resolveModelRefResult(
    cfg,
    { model: embeddingConfig.model },
    "conversation.thread.embedding.model",
  );
}

function embeddingAdapterCacheKey(resolved: ResolvedModelRef | null): string {
  if (!resolved) return "disabled";
  return JSON.stringify({
    provider: resolved.provider,
    modelId: resolved.modelId,
    spec: resolved.spec,
    providerOptions: resolved.providerOptions ?? null,
  });
}

function createConversationThreadEmbeddingAdapterFromResolved(
  resolved: ResolvedModelRef | null,
): ConversationThreadEmbeddingAdapter | null {
  if (!resolved) return null;

  const provider = getProvider(resolved.provider);
  if (!provider) return null;

  const model = provider.embeddingModel(resolved.modelId);
  const providerOptions = resolved.providerOptions as Record<string, JSONObject> | undefined;

  return {
    modelId: resolved.spec,
    async embed(input) {
      const result = await embed({
        model,
        value: input.text,
        providerOptions,
      });
      input.onUsage?.({
        modelSpec: resolved.spec,
        provider: resolved.provider,
        modelId: resolved.modelId,
        facet: input.facet,
        inputChars: input.text.length,
        tokens: result.usage.tokens,
        warnings: result.warnings.length,
      });
      return Float32Array.from(result.embedding);
    },
  };
}

export function createConversationThreadEmbeddingAdapter(
  cfg: CoreConfig,
): ResultType<ConversationThreadEmbeddingAdapter | null, ModelResolutionFailed> {
  const resolved = resolveConversationThreadEmbeddingModel(cfg);
  if (resolved.status === "error") return Result.err(resolved.error);
  return Result.ok(createConversationThreadEmbeddingAdapterFromResolved(resolved.value));
}

export function createConversationThreadEmbeddingAdapterResolver(
  getConfig: () => Promise<CoreConfig>,
): ConversationThreadEmbeddingAdapterResolver {
  let cached: {
    key: string;
    adapter: ConversationThreadEmbeddingAdapter | null;
  } | null = null;
  let pending: Promise<ConversationThreadEmbeddingAdapter | null> | null = null;

  const resolve = async (): Promise<ConversationThreadEmbeddingAdapter | null> => {
    const config = await getConfig();
    const resolved = resolveConversationThreadEmbeddingModel(config);
    if (resolved.status === "error") {
      switch (resolved.error._tag) {
        case "ModelResolutionFailed":
          logger.warn(
            "conversation thread embeddings disabled",
            formatTaggedErrorForLog(resolved.error),
          );
          return null;
      }
    }
    const key = embeddingAdapterCacheKey(resolved.value);
    if (cached?.key === key) return cached.adapter;

    const adapter = createConversationThreadEmbeddingAdapterFromResolved(resolved.value);
    cached = { key, adapter };
    return adapter;
  };

  return async () => {
    if (pending) return pending;
    pending = resolve().finally(() => {
      pending = null;
    });
    return pending;
  };
}
