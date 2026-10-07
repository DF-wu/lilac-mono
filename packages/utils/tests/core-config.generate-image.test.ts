import { describe, expect, it } from "bun:test";

import { parseCoreConfig } from "../core-config";
import { IMAGE_GENERATION_MODEL_ALIASES } from "../core-config/generate-image";

const DEFAULT_IMAGE_CONFIG = { provider: "default", routes: {} } as const;
const ALIAS_LIST = IMAGE_GENERATION_MODEL_ALIASES.join(", ");

function imageConfig(image: Record<string, unknown>) {
  return parseCoreConfig({ configVersion: 2, tools: { generate: { image } } });
}

describe("generate.image routing config", () => {
  it("provides the default image config for v2", async () => {
    const parsed = await parseCoreConfig({ configVersion: 2 });
    expect(parsed.tools.generate.image).toEqual(DEFAULT_IMAGE_CONFIG);
  });

  it("defaults routes when only the provider is set", async () => {
    const parsed = await imageConfig({ provider: "openai-compatible" });
    expect(parsed.tools.generate.image).toEqual({ provider: "openai-compatible", routes: {} });
  });

  it("parses the models allowlist and provider/model routes", async () => {
    const parsed = await imageConfig({
      provider: "openai-compatible",
      models: ["nanobanana-2", "gpt-image-2"],
      routes: {
        "nanobanana-2": " openai-compatible/gemini-3.1-flash-image-preview ",
        "gpt-image-2": "openrouter/openai/gpt-image-2",
        "grok-imagine-image": "xai/grok-imagine-image",
        "gpt-5-image": "openai/gpt-image-1.5",
      },
    });
    expect(parsed.tools.generate.image).toEqual({
      provider: "openai-compatible",
      models: ["nanobanana-2", "gpt-image-2"],
      routes: {
        "nanobanana-2": {
          provider: "openai-compatible",
          modelId: "gemini-3.1-flash-image-preview",
        },
        "gpt-image-2": { provider: "openrouter", modelId: "openai/gpt-image-2" },
        "grok-imagine-image": { provider: "xai", modelId: "grok-imagine-image" },
        "gpt-5-image": { provider: "openai", modelId: "gpt-image-1.5" },
      },
    });
  });

  it("rejects unknown aliases in models with the valid alias list", async () => {
    await expect(imageConfig({ models: ["not-a-model"] })).rejects.toThrow(
      `Unknown generate.image alias. Valid aliases: ${ALIAS_LIST}.`,
    );
  });

  it("rejects an empty models allowlist", async () => {
    await expect(imageConfig({ models: [] })).rejects.toThrow();
  });

  it("rejects unknown alias keys in routes with the valid alias list", async () => {
    await expect(imageConfig({ routes: { "not-a-model": "openai/x" } })).rejects.toThrow(
      `Unknown generate.image alias in routes. Valid aliases: ${ALIAS_LIST}.`,
    );
  });

  it.each([
    ["a bare model id", "gpt-image-2"],
    ["an empty model id", "openai/"],
    ["a blank model id", "openai-compatible/   "],
    ["an empty provider", "/gpt-image-2"],
    ["an unsupported provider", "anthropic/claude-image"],
  ])("rejects %s as a route", async (_label, route) => {
    await expect(imageConfig({ routes: { "gpt-image-2": route } })).rejects.toThrow(
      /Invalid generate\.image route .*Expected '<provider>\/<model id>' with provider openai, openrouter, xai, openai-compatible\./,
    );
  });

  it("rejects the replaced openaiCompatible block with a migration hint", async () => {
    await expect(
      imageConfig({
        provider: "openai-compatible",
        openaiCompatible: { modelIds: { "nanobanana-2": "gemini-3.1-flash-image-preview" } },
      }),
    ).rejects.toThrow(
      "tools.generate.image.openaiCompatible was replaced. Move `openaiCompatible.models` to `tools.generate.image.models` and each `openaiCompatible.modelIds` entry to `tools.generate.image.routes` as `<alias>: openai-compatible/<model id>`.",
    );
  });

  it("synthesizes the defaults for frozen v1 configs", async () => {
    const parsed = await parseCoreConfig({ configVersion: 1 });
    expect(parsed.tools.generate.image).toEqual(DEFAULT_IMAGE_CONFIG);
  });
});
