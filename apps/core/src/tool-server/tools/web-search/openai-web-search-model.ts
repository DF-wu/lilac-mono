import { Result, TaggedError, type Result as ResultType } from "better-result";

import { DEFAULT_OPENAI_WEB_SEARCH_MODEL } from "./openai-web-search-provider";

/**
 * Resolves `tools.web.openai.model` to the endpoint that runs the hosted
 * `web_search` call. The value is a `provider/model` spec; a bare model id
 * (the original form, kept for existing configs) means `openai/<id>`. Only
 * `openai` and `openai-compatible` models can drive the OpenAI Responses
 * `web_search` tool, so the provider selects between the `OPENAI_*` and
 * `OPENAI_COMPATIBLE_*` credentials.
 */

export type OpenAIWebSearchEndpoint = {
  readonly apiKey?: string;
  readonly baseUrl?: string;
};

export type OpenAIWebSearchModelEnvironment = {
  readonly openai: OpenAIWebSearchEndpoint;
  readonly openaiCompatible?: OpenAIWebSearchEndpoint;
};

export type ResolvedOpenAIWebSearchModel = {
  readonly provider: "openai" | "openai-compatible";
  readonly modelId: string;
  /** Canonical `provider/model` spec. */
  readonly spec: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
};

export class OpenAIWebSearchModelInvalid extends TaggedError("OpenAIWebSearchModelInvalid")<{
  readonly model: string;
  readonly message: string;
}> {}

const SUPPORTED_PROVIDERS = ["openai", "openai-compatible"] as const;

function isSupportedProvider(
  provider: string,
): provider is ResolvedOpenAIWebSearchModel["provider"] {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(provider);
}

function invalid(model: string, message: string): ResultType<never, OpenAIWebSearchModelInvalid> {
  return Result.err(
    new OpenAIWebSearchModelInvalid({
      model,
      message: `tools.web.openai.model '${model}' ${message}`,
    }),
  );
}

function resolveSpec(raw: string): string {
  return raw.includes("/") ? raw : `openai/${raw}`;
}

export function resolveOpenAIWebSearchModel(input: {
  readonly model: string | undefined;
  readonly environment: OpenAIWebSearchModelEnvironment;
}): ResultType<ResolvedOpenAIWebSearchModel, OpenAIWebSearchModelInvalid> {
  const raw = input.model?.trim() || `openai/${DEFAULT_OPENAI_WEB_SEARCH_MODEL}`;
  const spec = resolveSpec(raw);
  const separator = spec.indexOf("/");
  const provider = separator === -1 ? "" : spec.slice(0, separator);
  const modelId = separator === -1 ? "" : spec.slice(separator + 1).trim();
  if (!provider || !modelId) {
    return invalid(raw, "is not in provider/model format.");
  }
  if (!isSupportedProvider(provider)) {
    return invalid(
      raw,
      `resolves to provider '${provider}', which cannot run the OpenAI Responses web_search tool; use an openai or openai-compatible model.`,
    );
  }
  if (provider === "openai") {
    return Result.ok({
      provider,
      modelId,
      spec,
      apiKey: input.environment.openai.apiKey,
      baseUrl: input.environment.openai.baseUrl,
    });
  }
  const compatible = input.environment.openaiCompatible;
  if (!compatible?.baseUrl?.trim()) {
    return invalid(
      raw,
      "resolves to an openai-compatible model, but OPENAI_COMPATIBLE_BASE_URL is not configured.",
    );
  }
  if (!compatible.apiKey) {
    return invalid(
      raw,
      "resolves to an openai-compatible model, but OPENAI_COMPATIBLE_API_KEY is not configured.",
    );
  }
  return Result.ok({
    provider,
    modelId,
    spec,
    apiKey: compatible.apiKey,
    baseUrl: compatible.baseUrl,
  });
}
