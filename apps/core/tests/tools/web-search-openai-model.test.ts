import { describe, expect, it } from "bun:test";

import { resolveOpenAIWebSearchModel } from "../../src/tool-server/tools/web-search/openai-web-search-model";

const environment = {
  openai: { apiKey: "openai-key", baseUrl: "https://api.openai.com/v1" },
  openaiCompatible: { apiKey: "compat-key", baseUrl: "http://gateway.internal/v1" },
};

describe("resolveOpenAIWebSearchModel", () => {
  it("defaults to gpt-5-mini on the OpenAI endpoint", () => {
    const resolved = resolveOpenAIWebSearchModel({
      model: undefined,
      aliases: undefined,
      environment,
    }).unwrap();
    expect(resolved).toEqual({
      provider: "openai",
      modelId: "gpt-5-mini",
      spec: "openai/gpt-5-mini",
      apiKey: "openai-key",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("keeps a bare model id on the OpenAI endpoint", () => {
    const resolved = resolveOpenAIWebSearchModel({
      model: " gpt-5 ",
      aliases: { sol: { model: "openai/gpt-6.1-sol" } },
      environment,
    }).unwrap();
    expect(resolved).toMatchObject({ provider: "openai", modelId: "gpt-5", spec: "openai/gpt-5" });
    expect(resolved.alias).toBeUndefined();
  });

  it("resolves a models.def alias to the openai-compatible endpoint", () => {
    const resolved = resolveOpenAIWebSearchModel({
      model: "terra",
      aliases: { terra: { model: "openai-compatible/gpt-5.6-terra" } },
      environment,
    }).unwrap();
    expect(resolved).toEqual({
      provider: "openai-compatible",
      modelId: "gpt-5.6-terra",
      spec: "openai-compatible/gpt-5.6-terra",
      alias: "terra",
      apiKey: "compat-key",
      baseUrl: "http://gateway.internal/v1",
    });
  });

  it("resolves a models.def alias to the OpenAI endpoint", () => {
    const resolved = resolveOpenAIWebSearchModel({
      model: "sol",
      aliases: { sol: { model: "openai/gpt-6.1-sol" } },
      environment,
    }).unwrap();
    expect(resolved).toMatchObject({
      provider: "openai",
      modelId: "gpt-6.1-sol",
      alias: "sol",
      apiKey: "openai-key",
    });
  });

  it("accepts a provider/model spec directly and prefers an alias with the same name", () => {
    const direct = resolveOpenAIWebSearchModel({
      model: "openai-compatible/kimi-k3",
      aliases: undefined,
      environment,
    }).unwrap();
    expect(direct).toMatchObject({ provider: "openai-compatible", modelId: "kimi-k3" });

    const aliased = resolveOpenAIWebSearchModel({
      model: "gpt-5-mini",
      aliases: { "gpt-5-mini": { model: "openai-compatible/gpt-5-mini-eu" } },
      environment,
    }).unwrap();
    expect(aliased).toMatchObject({ provider: "openai-compatible", modelId: "gpt-5-mini-eu" });
  });

  it("rejects providers that cannot run the Responses web_search tool", () => {
    const result = resolveOpenAIWebSearchModel({
      model: "sonnet",
      aliases: { sonnet: { model: "anthropic/claude-sonnet-5" } },
      environment,
    });
    expect(result.isErr()).toBe(true);
    expect(result.isErr() && result.error.message).toMatch(
      /tools\.web\.openai\.model 'sonnet' resolves to provider 'anthropic'/u,
    );
  });

  it("rejects openrouter-style nested specs as a foreign provider", () => {
    const result = resolveOpenAIWebSearchModel({
      model: "openrouter/openai/gpt-4o",
      aliases: undefined,
      environment,
    });
    expect(result.isErr() && result.error.message).toMatch(/provider 'openrouter'/u);
  });

  it("rejects an openai-compatible model when the compatible base URL is missing", () => {
    const result = resolveOpenAIWebSearchModel({
      model: "openai-compatible/kimi-k3",
      aliases: undefined,
      environment: { openai: environment.openai },
    });
    expect(result.isErr() && result.error.message).toMatch(/OPENAI_COMPATIBLE_BASE_URL/u);
  });

  it("rejects an alias whose target is not provider/model", () => {
    const result = resolveOpenAIWebSearchModel({
      model: "broken",
      aliases: { broken: { model: "gpt-5" } },
      environment,
    });
    expect(result.isErr() && result.error.message).toMatch(/not in provider\/model format/u);
  });
});
