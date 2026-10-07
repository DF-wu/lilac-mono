import { expect, it, spyOn } from "bun:test";
import { env } from "@stanley2058/lilac-utils";
import * as ai from "ai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGenerateImageCallable } from "../../src/tool-server/tools/generate-image/callable";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);

it("preserves the SDK aggregate metadata contract using calls without reading deprecated metadata", async () => {
  let callIndex = 0;
  const sdkResult = await ai.generateImage({
    prompt: "metadata fixture",
    n: 3,
    model: {
      specificationVersion: "v4",
      provider: "fixture",
      modelId: "fixture",
      maxImagesPerCall: 1,
      doGenerate: async () => {
        const index = callIndex++;
        const providerMetadata = {
          openai: { images: [{ index }, null, "opaque"], discarded: "call-only" },
          gateway: {
            images: [],
            cost: ["9007199254740993.01", "0.09", "1.000"][index]!,
            gatewayCost: "0.1",
            inferenceCost: "0.2",
            inputInferenceCost: "0.3",
            marketCost: "0.4",
            outputInferenceCost: "0.5",
            surchargeCost: "0.6",
            invalidCost: "not summed",
            route: `route-${index}`,
          },
        };
        Object.defineProperty(providerMetadata, "__proto__", {
          value: { images: [{ index }] },
          enumerable: true,
        });
        Object.defineProperty(providerMetadata.gateway, "__proto__", {
          value: { route: `special-${index}` },
          enumerable: true,
        });
        return {
          images: [PNG_BYTES],
          providerMetadata,
          warnings: [],
          response: { timestamp: new Date(0), modelId: "fixture", headers: {} },
        };
      },
    },
  });
  // The deprecated aggregate is only a reference oracle here; the callable
  // must recreate it from supported fields, including raw per-call image data.
  const expectedMetadata = structuredClone(Reflect.get(sdkResult, "providerMetadata"));
  Object.defineProperty(sdkResult, "providerMetadata", {
    get: () => {
      throw new Error("The callable read deprecated aggregate metadata");
    },
  });
  const generateImage = spyOn(ai, "generateImage").mockResolvedValue(sdkResult);
  const originalOpenai = { ...env.providers.openai };
  const outputDir = await mkdtemp(join(tmpdir(), "lilac-callable-metadata-"));
  Object.assign(env.providers.openai, { apiKey: "fixture-key", baseUrl: undefined });
  try {
    const result = await createGenerateImageCallable({}).run(
      {
        prompt: "metadata contract",
        model: "gpt-image-2",
        outputDir,
        inputImages: undefined,
      },
      undefined,
    );
    const output = result.unwrap();
    expect(output.providerMetadata).toEqual(expectedMetadata);
    expect<unknown>(output.providerMetadata.gateway).toEqual({
      cost: "9007199254740994.1",
      gatewayCost: "0.3",
      inferenceCost: "0.6",
      inputInferenceCost: "0.9",
      marketCost: "1.2",
      outputInferenceCost: "1.5",
      surchargeCost: "1.8",
      invalidCost: "not summed",
      route: "route-2",
      ["__proto__"]: { route: "special-2" },
    });
    expect(output.providerMetadata.openai).toEqual({
      images: [
        { index: 0 },
        null,
        "opaque",
        { index: 1 },
        null,
        "opaque",
        { index: 2 },
        null,
        "opaque",
      ],
    });
    expect(Object.hasOwn(output.providerMetadata, "__proto__")).toBe(true);
    expect(Object.hasOwn(output.providerMetadata.gateway!, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(output.providerMetadata.gateway)).toBe(Object.prototype);
    expect(await readFile(output.path)).toEqual(PNG_BYTES);
    expect(generateImage).toHaveBeenCalledTimes(1);
  } finally {
    generateImage.mockRestore();
    Object.assign(env.providers.openai, originalOpenai);
    await rm(outputDir, { recursive: true, force: true });
  }
});
