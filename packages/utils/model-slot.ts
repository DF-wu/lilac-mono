import type { LanguageModel } from "ai";

import { providers, type Providers } from "./model-provider";
import { CODEX_BASE_INSTRUCTIONS } from "./codex-instructions";
import type {
  ConfiguredModelChainEntry,
  ConfiguredModelRef,
  CoreConfig,
  JSONObject,
  JSONValue,
  ModelReasoningEffort,
} from "./core-config";
import { createLogger } from "./logging";
import { parseModelSpecifier } from "./model-capability";
import {
  formatModelProviderOptionWarning,
  normalizeConfiguredModelProviderOptions,
  validateModelProviderOptions,
} from "./model-provider-option-validation";

const logger = createLogger({ module: "utils:model-slot" });
const warnedProviderOptions = new Set<string>();

export type ModelSlot = "main" | "fast";

export type ResolvedModelSlot = {
  slot: ModelSlot;
  /** If models.<slot>.model was an alias, this is set. */
  alias?: string;
  /** Canonical model spec in provider/model format. */
  spec: string;
  provider: string;
  modelId: string;
  /** Model instance created from the configured provider. */
  model: LanguageModel;
  /** AI SDK providerOptions; may include multiple provider namespaces. */
  providerOptions?: { [x: string]: JSONObject };
  /** Portable AI SDK reasoning effort. */
  reasoning?: ModelReasoningEffort;
  /** Optional Responses API commentary-phase behavior toggle for OpenAI/Codex providers. */
  responseCommentary?: boolean;
  /** Explicit opt-in for OpenAI server-side compaction. */
  openaiServerCompaction?: true;
  /** Opt-in Anthropic cache-control injection for system prompt + latest user message. */
  anthropicPromptCache?: boolean;
  /** Durable workflow candidates may retain the display policy from their dispatch. */
  reasoningDisplay?: CoreConfig["agent"]["reasoningDisplay"];
};

export type ResolvedModelRef = Omit<ResolvedModelSlot, "slot">;

export type ResolvedModelPlan = {
  head: ResolvedModelRef;
  fallbacks: readonly ResolvedModelRef[];
};

export type DurableJsonValue =
  | null
  | string
  | number
  | boolean
  | DurableJsonObject
  | DurableJsonArray;
export interface DurableJsonObject {
  [key: string]: DurableJsonValue;
}
export interface DurableJsonArray extends Array<DurableJsonValue> {}

type DurableResolvedModelRequestBase = {
  alias?: string;
  spec: string;
  provider: string;
  modelId: string;
  providerOptions?: Record<string, DurableJsonObject>;
  reasoning?: ModelReasoningEffort;
  responseCommentary?: boolean;
  openaiServerCompaction?: true;
  anthropicPromptCache?: boolean;
  reasoningDisplay: CoreConfig["agent"]["reasoningDisplay"];
};

export type DurableResolvedModelRequest = DurableResolvedModelRequestBase & {
  /** Optional for compatibility with policies persisted before model fallback support. */
  fallbacks?: DurableResolvedModelRequestBase[];
};

export function toDurableResolvedModelRequest(
  resolved: ResolvedModelRef,
  reasoningDisplay: CoreConfig["agent"]["reasoningDisplay"],
): DurableResolvedModelRequest {
  const compactJsonObject = (value: JSONObject): DurableJsonObject =>
    Object.fromEntries(
      Object.entries(value).flatMap(([key, child]) =>
        child === undefined ? [] : [[key, compactJsonValue(child)]],
      ),
    );
  const compactJsonValue = (value: JSONValue): DurableJsonValue => {
    if (Array.isArray(value)) return value.map(compactJsonValue);
    if (value !== null && typeof value === "object") return compactJsonObject(value);
    return value;
  };
  const providerOptions = resolved.providerOptions
    ? Object.fromEntries(
        Object.entries(resolved.providerOptions).map(([key, value]) => [
          key,
          compactJsonObject(value),
        ]),
      )
    : undefined;
  return {
    ...(resolved.alias ? { alias: resolved.alias } : {}),
    spec: resolved.spec,
    provider: resolved.provider,
    modelId: resolved.modelId,
    ...(providerOptions ? { providerOptions } : {}),
    ...(resolved.reasoning ? { reasoning: resolved.reasoning } : {}),
    ...(resolved.responseCommentary ? { responseCommentary: true } : {}),
    ...(resolved.openaiServerCompaction ? { openaiServerCompaction: true } : {}),
    ...(resolved.anthropicPromptCache ? { anthropicPromptCache: true } : {}),
    reasoningDisplay: resolved.reasoningDisplay ?? reasoningDisplay,
  };
}

export function toDurableResolvedModelPlan(
  plan: ResolvedModelPlan,
  reasoningDisplay: CoreConfig["agent"]["reasoningDisplay"],
): DurableResolvedModelRequest {
  return {
    ...toDurableResolvedModelRequest(plan.head, reasoningDisplay),
    fallbacks: plan.fallbacks.map((fallback) =>
      toDurableResolvedModelRequest(fallback, reasoningDisplay),
    ),
  };
}

export function fromDurableResolvedModelRequest(
  request: DurableResolvedModelRequest,
): ResolvedModelRef {
  const parsed = parseModelSpecifier(request.spec);
  if (parsed.provider !== request.provider || parsed.model !== request.modelId) {
    throw new Error("Durable model request does not match its canonical model spec");
  }
  if (
    request.openaiServerCompaction &&
    request.provider !== "openai" &&
    request.provider !== "codex"
  ) {
    throw new Error(
      "Durable OpenAI server compaction is supported only by openai and codex providers",
    );
  }
  const provider = providers[request.provider as Providers];
  if (typeof provider !== "function") {
    throw new Error(`Provider '${request.provider}' is not configured for durable dispatch`);
  }
  return {
    ...(request.alias ? { alias: request.alias } : {}),
    spec: request.spec,
    provider: request.provider,
    modelId: request.modelId,
    model: provider(request.modelId),
    ...(request.providerOptions ? { providerOptions: request.providerOptions } : {}),
    ...(request.reasoning ? { reasoning: request.reasoning } : {}),
    ...(request.responseCommentary ? { responseCommentary: true } : {}),
    ...(request.openaiServerCompaction ? { openaiServerCompaction: true } : {}),
    ...(request.anthropicPromptCache ? { anthropicPromptCache: true } : {}),
    reasoningDisplay: request.reasoningDisplay,
  };
}

export function fromDurableResolvedModelPlan(
  request: DurableResolvedModelRequest,
): ResolvedModelPlan {
  return {
    head: fromDurableResolvedModelRequest(request),
    fallbacks: (request.fallbacks ?? []).map(fromDurableResolvedModelRequest),
  };
}

function cloneJson(value: JSONValue): JSONValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, JSONValue | undefined>;
    const next: Record<string, JSONValue | undefined> = {};
    for (const [k, v] of Object.entries(source)) {
      next[k] = v === undefined ? undefined : cloneJson(v as JSONValue);
    }
    return next;
  }
  return value;
}

function deepMergeJson(base: JSONValue, override: JSONValue): JSONValue {
  // Arrays are replaced, not merged.
  if (Array.isArray(base) || Array.isArray(override)) {
    return cloneJson(override);
  }

  if (
    base !== null &&
    typeof base === "object" &&
    override !== null &&
    typeof override === "object"
  ) {
    const baseRecord = base as Record<string, JSONValue | undefined>;
    const overrideRecord = override as Record<string, JSONValue | undefined>;
    const out: Record<string, JSONValue | undefined> = {};

    const baseEntries = Object.entries(baseRecord);
    for (const [k, v] of baseEntries) {
      out[k] = v === undefined ? undefined : cloneJson(v as JSONValue);
    }

    for (const [k, vOverride] of Object.entries(overrideRecord)) {
      if (vOverride === undefined) continue;

      const vBase = baseRecord[k];
      if (vBase === undefined) {
        out[k] = cloneJson(vOverride as JSONValue);
        continue;
      }

      out[k] = deepMergeJson(vBase as JSONValue, vOverride as JSONValue);
    }

    return out;
  }

  return cloneJson(override);
}

function deepMergeObjects(base?: JSONObject, override?: JSONObject): JSONObject | undefined {
  if (!base && !override) return undefined;
  if (!base) return cloneJson(override ?? {}) as JSONObject;
  if (!override) return cloneJson(base) as JSONObject;
  return deepMergeJson(base, override) as JSONObject;
}

function withOpenAIParallelToolCallsDefault(
  provider: string,
  providerOptions?: { [x: string]: JSONObject },
): { [x: string]: JSONObject } | undefined {
  if (provider !== "openai" && provider !== "codex") return providerOptions;

  const openaiOptions = providerOptions?.openai;
  if (
    openaiOptions !== null &&
    openaiOptions !== undefined &&
    typeof openaiOptions === "object" &&
    "parallelToolCalls" in openaiOptions
  ) {
    return providerOptions;
  }

  const base = providerOptions ?? {};

  return {
    ...base,
    openai: {
      ...(openaiOptions !== null && typeof openaiOptions === "object"
        ? (openaiOptions as JSONObject)
        : {}),
      parallelToolCalls: true,
    },
  };
}

function buildProviderOptions(params: { provider: string; options?: JSONObject }): {
  providerOptions?: { [x: string]: JSONObject };
  responseCommentary?: boolean;
  openaiServerCompaction?: true;
  anthropicPromptCache?: boolean;
} {
  const options = params.options ?? {};

  const {
    anthropic_prompt_cache,
    codex_instructions,
    openai_server_compaction,
    response_commentary,
  } = options as JSONObject & {
    anthropic_prompt_cache?: JSONValue;
    codex_instructions?: JSONValue;
    openai_server_compaction?: JSONValue;
    response_commentary?: JSONValue;
  };
  const codexInstructions =
    typeof codex_instructions === "string" && codex_instructions.length > 0
      ? codex_instructions
      : undefined;

  const responseCommentary =
    response_commentary === true && (params.provider === "openai" || params.provider === "codex")
      ? true
      : undefined;

  let openaiServerCompaction: true | undefined;
  if (Object.hasOwn(options, "openai_server_compaction")) {
    if (openai_server_compaction !== true) {
      throw new Error("Model option 'openai_server_compaction' must be literal boolean true");
    }
    if (params.provider !== "openai" && params.provider !== "codex") {
      throw new Error(
        "Model option 'openai_server_compaction' is supported only by openai and codex providers",
      );
    }
    openaiServerCompaction = true;
  }

  const anthropicPromptCache = anthropic_prompt_cache === true ? true : undefined;

  const provider = params.provider;
  const providerOptions = normalizeConfiguredModelProviderOptions(provider, options);

  if (provider !== "codex") {
    // Non-codex: codex_instructions is ignored; also not forwarded.
    return {
      providerOptions: withOpenAIParallelToolCallsDefault(provider, providerOptions),
      responseCommentary,
      openaiServerCompaction,
      anthropicPromptCache,
    };
  }

  // Codex: ensure OpenAI namespace exists + has instructions.
  const openaiKey = "openai";
  const existing = providerOptions?.[openaiKey] ?? {};
  const existingInstructions =
    typeof existing.instructions === "string" && existing.instructions.length > 0
      ? existing.instructions
      : undefined;

  const resolvedInstructions = existingInstructions ?? codexInstructions ?? CODEX_BASE_INSTRUCTIONS;

  const nextOpenAI = {
    ...existing,
    instructions: resolvedInstructions,
    // Codex backend requires store=false (items are not persisted).
    store: false,
  } satisfies JSONObject;

  return {
    providerOptions: withOpenAIParallelToolCallsDefault(provider, {
      ...providerOptions,
      [openaiKey]: nextOpenAI,
    }),
    responseCommentary,
    openaiServerCompaction,
    anthropicPromptCache,
  };
}

function resolveModelSpecFromRaw(
  cfg: CoreConfig,
  raw: string,
  source: string,
): {
  spec: string;
  alias?: string;
  presetOptions?: JSONObject;
  presetReasoning?: ModelReasoningEffort;
} {
  if (raw.includes("/")) {
    return { spec: raw };
  }

  const alias = raw;
  const preset = cfg.models.def?.[alias];
  if (!preset) {
    const available = Object.keys(cfg.models.def ?? {}).slice(0, 10);
    const hint =
      available.length > 0
        ? ` Available aliases (sample): ${available.join(", ")}`
        : " No aliases are configured under models.def.";
    throw new Error(`Unknown model alias '${alias}' (${source}).${hint}`);
  }

  if (!preset.model.includes("/")) {
    throw new Error(
      `Invalid models.def.${alias}.model: expected provider/model format (got '${preset.model}')`,
    );
  }

  return {
    spec: preset.model,
    alias,
    presetOptions: preset.options,
    presetReasoning: preset.reasoning,
  };
}

function resolveSlotSpec(
  cfg: CoreConfig,
  slot: ModelSlot,
): {
  spec: string;
  alias?: string;
  presetOptions?: JSONObject;
  presetReasoning?: ModelReasoningEffort;
  slotOptions?: JSONObject;
  slotReasoning?: ModelReasoningEffort;
} {
  const slotCfg = cfg.models[slot];
  const base = resolveModelSpecFromRaw(cfg, slotCfg.model, `models.${slot}.model`);

  return {
    spec: base.spec,
    alias: base.alias,
    presetOptions: base.presetOptions,
    presetReasoning: base.presetReasoning,
    slotOptions: slotCfg.options,
    slotReasoning: slotCfg.reasoning,
  };
}

function resolveModel(params: {
  source: string;
  spec: string;
  alias?: string;
  options?: JSONObject;
  reasoning?: ModelReasoningEffort;
}): ResolvedModelRef {
  const parsed = parseModelSpecifier(params.spec);
  const provider = parsed.provider;
  const modelId = parsed.model;
  const { providerOptions, responseCommentary, openaiServerCompaction, anthropicPromptCache } =
    buildProviderOptions({
      provider,
      options: params.options,
    });

  const p = providers[provider as Providers];
  const hasProvider = Object.prototype.hasOwnProperty.call(providers, provider);
  if (!hasProvider) {
    throw new Error(
      `Unknown provider '${provider}' (${params.source}='${params.alias ?? params.spec}')`,
    );
  }
  if (typeof p !== "function") {
    throw new Error(
      `Provider '${provider}' is not configured (${params.source}='${params.alias ?? params.spec}')`,
    );
  }

  for (const warning of validateModelProviderOptions(providerOptions)) {
    const warningKey = `${params.source}:${warning.namespace}:${warning.option}`;
    if (warnedProviderOptions.has(warningKey)) continue;
    warnedProviderOptions.add(warningKey);

    logger.warn(formatModelProviderOptionWarning(warning, params.source));
  }

  return {
    alias: params.alias,
    spec: params.spec,
    provider,
    modelId,
    model: p(modelId),
    providerOptions,
    reasoning: params.reasoning,
    responseCommentary,
    openaiServerCompaction,
    anthropicPromptCache,
  };
}

export function resolveModelRef(
  cfg: CoreConfig,
  ref: ConfiguredModelRef,
  source: string,
): ResolvedModelRef {
  const base = resolveModelSpecFromRaw(cfg, ref.model, source);
  const mergedOptions = deepMergeObjects(base.presetOptions, ref.options);
  const reasoning = ref.reasoning ?? base.presetReasoning;
  return resolveModel({
    source,
    spec: base.spec,
    alias: base.alias,
    options: mergedOptions,
    reasoning,
  });
}

export function resolveModelChain(
  cfg: CoreConfig,
  entries: readonly ConfiguredModelChainEntry[],
  source: string,
  reasoningOverride?: ModelReasoningEffort,
): ResolvedModelRef[] {
  return entries.map((entry, index) => {
    const ref = typeof entry === "string" ? { model: entry } : entry;
    return resolveModelRef(
      cfg,
      reasoningOverride === undefined ? ref : { ...ref, reasoning: reasoningOverride },
      `${source}[${index}]`,
    );
  });
}

export function resolveModelPlan(
  cfg: CoreConfig,
  params: {
    head: ConfiguredModelRef;
    fallback?: readonly ConfiguredModelChainEntry[];
    headSource: string;
    fallbackSource: string;
    reasoningOverride?: ModelReasoningEffort;
  },
): ResolvedModelPlan {
  const aliasFallback = params.head.model.includes("/")
    ? undefined
    : cfg.models.def[params.head.model]?.fallback;
  const fallback = params.fallback ?? aliasFallback ?? [];
  const fallbackSource =
    params.fallback === undefined && aliasFallback !== undefined
      ? `models.def.${params.head.model}.fallback`
      : params.fallbackSource;
  const head = resolveModelRef(
    cfg,
    params.reasoningOverride === undefined
      ? params.head
      : { ...params.head, reasoning: params.reasoningOverride },
    params.headSource,
  );

  return {
    head,
    fallbacks: resolveModelChain(cfg, fallback, fallbackSource, params.reasoningOverride),
  };
}

export function withModelPlanReasoning(
  plan: ResolvedModelPlan,
  reasoning: ModelReasoningEffort,
): ResolvedModelPlan {
  return {
    head: { ...plan.head, reasoning },
    fallbacks: plan.fallbacks.map((fallback) => ({ ...fallback, reasoning })),
  };
}

export function resolveModelSlot(cfg: CoreConfig, slot: ModelSlot): ResolvedModelSlot {
  const { spec, alias, presetOptions, presetReasoning, slotOptions, slotReasoning } =
    resolveSlotSpec(cfg, slot);
  const mergedOptions = deepMergeObjects(presetOptions, slotOptions);
  const reasoning = slotReasoning ?? presetReasoning;
  const resolved = resolveModel({
    source: `models.${slot}.model`,
    spec,
    alias,
    options: mergedOptions,
    reasoning,
  });

  return {
    slot,
    ...resolved,
  };
}

export function resolveModelSlotPlan(
  cfg: CoreConfig,
  slot: ModelSlot,
  reasoningOverride?: ModelReasoningEffort,
): ResolvedModelPlan {
  const slotConfig = cfg.models[slot];
  return resolveModelPlan(cfg, {
    head: slotConfig,
    fallback: slotConfig.fallback,
    headSource: `models.${slot}.model`,
    fallbackSource: `models.${slot}.fallback`,
    reasoningOverride,
  });
}
