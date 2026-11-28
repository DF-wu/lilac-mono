import { afterEach, describe, expect, it } from "bun:test";

import { resolveOpenAIWebSearchModel } from "../../src/tool-server/tools/web-search/openai-web-search-model";

const environment = {
  openai: { apiKey: "openai-key", baseUrl: "https://api.openai.com/v1" },
  openaiCompatible: { apiKey: "compat-key", baseUrl: "http://gateway.internal/v1" },
};

describe("resolveOpenAIWebSearchModel", () => {
  it("defaults to openai/gpt-5-mini on the OpenAI endpoint", () => {
    const resolved = resolveOpenAIWebSearchModel({ model: undefined, environment }).unwrap();
    expect(resolved).toEqual({
      provider: "openai",
      modelId: "gpt-5-mini",
      spec: "openai/gpt-5-mini",
      apiKey: "openai-key",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("keeps a bare model id on the OpenAI endpoint", () => {
    const resolved = resolveOpenAIWebSearchModel({ model: " gpt-5 ", environment }).unwrap();
    expect(resolved).toMatchObject({ provider: "openai", modelId: "gpt-5", spec: "openai/gpt-5" });
  });

  it("resolves an openai/ spec to the OpenAI endpoint", () => {
    const resolved = resolveOpenAIWebSearchModel({
      model: "openai/gpt-6.1-sol",
      environment,
    }).unwrap();
    expect(resolved).toEqual({
      provider: "openai",
      modelId: "gpt-6.1-sol",
      spec: "openai/gpt-6.1-sol",
      apiKey: "openai-key",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("resolves an openai-compatible/ spec to the compatible endpoint", () => {
    const resolved = resolveOpenAIWebSearchModel({
      model: "openai-compatible/gpt-5.6-terra",
      environment,
    }).unwrap();
    expect(resolved).toEqual({
      provider: "openai-compatible",
      modelId: "gpt-5.6-terra",
      spec: "openai-compatible/gpt-5.6-terra",
      apiKey: "compat-key",
      baseUrl: "http://gateway.internal/v1",
    });
  });

  it("rejects providers that cannot run the Responses web_search tool", () => {
    const result = resolveOpenAIWebSearchModel({
      model: "anthropic/claude-sonnet-5",
      environment,
    });
    expect(result.isErr()).toBe(true);
    expect(result.isErr() && result.error.message).toMatch(
      /tools\.web\.openai\.model 'anthropic\/claude-sonnet-5' resolves to provider 'anthropic'/u,
    );
  });

  it("rejects openrouter-style nested specs as a foreign provider", () => {
    const result = resolveOpenAIWebSearchModel({ model: "openrouter/openai/gpt-4o", environment });
    expect(result.isErr() && result.error.message).toMatch(/provider 'openrouter'/u);
  });

  it("rejects an openai-compatible model when the compatible base URL is missing", () => {
    const result = resolveOpenAIWebSearchModel({
      model: "openai-compatible/kimi-k3",
      environment: { openai: environment.openai },
    });
    expect(result.isErr() && result.error.message).toMatch(/OPENAI_COMPATIBLE_BASE_URL/u);
  });

  it("rejects an openai-compatible model when the compatible API key is missing", () => {
    const result = resolveOpenAIWebSearchModel({
      model: "openai-compatible/kimi-k3",
      environment: {
        openai: environment.openai,
        openaiCompatible: { baseUrl: "http://gateway.internal/v1" },
      },
    });
    expect(result.isErr() && result.error.message).toMatch(/OPENAI_COMPATIBLE_API_KEY/u);
  });

  it("rejects a spec with an empty provider or model", () => {
    for (const model of ["/gpt-5", "openai/", "openai/   "]) {
      const result = resolveOpenAIWebSearchModel({ model, environment });
      expect(result.isErr() && result.error.message).toMatch(/not in provider\/model format/u);
    }
  });
});

const originalNamedKey = process.env.LILAC_TEST_SEARCH_KEY;
afterEach(() => {
  if (originalNamedKey === undefined) delete process.env.LILAC_TEST_SEARCH_KEY;
  else process.env.LILAC_TEST_SEARCH_KEY = originalNamedKey;
});

it("selects an explicit named Responses endpoint before the legacy gateway", () => {
  process.env.LILAC_TEST_SEARCH_KEY = "named-key";
  const resolved = resolveOpenAIWebSearchModel({
    model: "openai-compatible/search/team/model",
    environment,
    openAICompatibleServers: {
      search: { baseUrl: "https://named.example.test/v1", apiKeyEnv: "LILAC_TEST_SEARCH_KEY" },
    },
  }).unwrap();
  expect(resolved).toEqual({
    provider: "openai-compatible",
    modelId: "team/model",
    spec: "openai-compatible/search/team/model",
    apiKey: "named-key",
    baseUrl: "https://named.example.test/v1",
  });
});

it("keeps unmatched slash-containing model ids on the legacy endpoint", () => {
  const resolved = resolveOpenAIWebSearchModel({
    model: "openai-compatible/team/model",
    environment,
    openAICompatibleServers: { search: { baseUrl: "https://named.example.test/v1" } },
  }).unwrap();
  expect(resolved).toMatchObject({
    modelId: "team/model",
    apiKey: "compat-key",
    baseUrl: environment.openaiCompatible.baseUrl,
  });
});

it("rejects named endpoints without credentials instead of falling back to another key", () => {
  delete process.env.LILAC_TEST_SEARCH_KEY;
  for (const apiKeyEnv of [undefined, "LILAC_TEST_SEARCH_KEY"]) {
    const result = resolveOpenAIWebSearchModel({
      model: "openai-compatible/search/model",
      environment,
      openAICompatibleServers: { search: { baseUrl: "https://named.example.test/v1", apiKeyEnv } },
    });
    expect(result.isErr()).toBe(true);
    expect(result.isErr() && result.error.message).toContain("credentials");
  }
});

it("rejects a named endpoint without its model", () => {
  const result = resolveOpenAIWebSearchModel({
    model: "openai-compatible/search/",
    environment,
    openAICompatibleServers: { search: { baseUrl: "https://named.example.test/v1" } },
  });
  expect(result.isErr()).toBe(true);
});
