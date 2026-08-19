import { describe, expect, it } from "bun:test";

import { parseCoreConfig } from "../core-config";
import { IMAGE_GENERATION_MODEL_ALIASES } from "../core-config/types";

const DEFAULT_IMAGE_CONFIG = {
  provider: "default",
  openaiCompatible: { modelIds: {} },
} as const;

describe("generate.image openai-compatible config", () => {
  it("provides the default openaiCompatible sub-object for v2", async () => {
    const parsed = await parseCoreConfig({ configVersion: 2 });
    expect(parsed.tools.generate.image).toEqual(DEFAULT_IMAGE_CONFIG);
  });

  it("defaults the sub-object when only the provider is set", async () => {
    const parsed = await parseCoreConfig({
      configVersion: 2,
      tools: { generate: { image: { provider: "openai-compatible" } } },
    });
    expect(parsed.tools.generate.image).toEqual({
      provider: "openai-compatible",
      openaiCompatible: { modelIds: {} },
    });
  });

  it("parses the models allowlist and trims modelIds overrides", async () => {
    const parsed = await parseCoreConfig({
      configVersion: 2,
      tools: {
        generate: {
          image: {
            provider: "openai-compatible",
            openaiCompatible: {
              models: ["nanobanana-2", "gpt-image-2"],
              modelIds: { "nanobanana-2": " gemini-3.1-flash-image-preview " },
            },
          },
        },
      },
    });
    expect(parsed.tools.generate.image.openaiCompatible).toEqual({
      models: ["nanobanana-2", "gpt-image-2"],
      modelIds: { "nanobanana-2": "gemini-3.1-flash-image-preview" },
    });
  });

  it("rejects unknown aliases in models with the valid alias list", async () => {
    await expect(
      parseCoreConfig({
        configVersion: 2,
        tools: {
          generate: {
            image: { openaiCompatible: { models: ["not-a-model"] } },
          },
        },
      }),
    ).rejects.toThrow(
      `Unknown generate.image alias. Valid aliases: ${IMAGE_GENERATION_MODEL_ALIASES.join(", ")}.`,
    );
  });

  it("rejects an empty models allowlist", async () => {
    await expect(
      parseCoreConfig({
        configVersion: 2,
        tools: { generate: { image: { openaiCompatible: { models: [] } } } },
      }),
    ).rejects.toThrow();
  });

  it("rejects unknown alias keys in modelIds with the valid alias list", async () => {
    await expect(
      parseCoreConfig({
        configVersion: 2,
        tools: {
          generate: {
            image: { openaiCompatible: { modelIds: { "not-a-model": "upstream-id" } } },
          },
        },
      }),
    ).rejects.toThrow(
      `Unknown generate.image alias in modelIds. Valid aliases: ${IMAGE_GENERATION_MODEL_ALIASES.join(", ")}.`,
    );
  });

  it("rejects empty modelIds override values", async () => {
    await expect(
      parseCoreConfig({
        configVersion: 2,
        tools: {
          generate: {
            image: { openaiCompatible: { modelIds: { "nanobanana-2": "   " } } },
          },
        },
      }),
    ).rejects.toThrow();
  });

  it("synthesizes the defaults for frozen v1 configs", async () => {
    const parsed = await parseCoreConfig({ configVersion: 1 });
    expect(parsed.tools.generate.image).toEqual(DEFAULT_IMAGE_CONFIG);
  });
});
