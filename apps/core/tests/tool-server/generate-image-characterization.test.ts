import { afterEach, describe, expect, it } from "bun:test";
import { env } from "@stanley2058/lilac-utils";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildImageGenerationPrompt, Generate } from "../../src/tool-server/tools/generate";

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0xf0,
  0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
  0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const originalProviders = structuredClone(env.providers);
const temporaryPaths: string[] = [];
const servers: Bun.Server<unknown>[] = [];

function configureProviders(values: {
  readonly openai?: string;
  readonly openrouter?: string;
  readonly xai?: string;
}): void {
  Object.assign(env.providers.openai, {
    apiKey: values.openai ? "test-key" : undefined,
    baseUrl: values.openai,
  });
  Object.assign(env.providers.openrouter, {
    apiKey: values.openrouter ? "test-key" : undefined,
    baseUrl: values.openrouter,
  });
  Object.assign(env.providers.xai, {
    apiKey: values.xai ? "test-key" : undefined,
    baseUrl: values.xai,
  });
  Object.assign(env.providers.openaiCompatible, { apiKey: undefined, baseUrl: undefined });
}

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const path of temporaryPaths.splice(0)) await rm(path, { force: true, recursive: true });
  Object.assign(env.providers.openai, originalProviders.openai);
  Object.assign(env.providers.openrouter, originalProviders.openrouter);
  Object.assign(env.providers.xai, originalProviders.xai);
  Object.assign(env.providers.openaiCompatible, originalProviders.openaiCompatible);
});

describe("Generate image upstream characterization", () => {
  it("preserves the image alias list and descriptor order", async () => {
    // Given
    configureProviders({
      openai: "http://127.0.0.1",
      openrouter: "http://127.0.0.1",
      xai: "http://127.0.0.1",
    });

    // When
    const entries = await new Generate().list();

    // Then
    expect(entries.find((entry) => entry.callableId === "generate.image")?.description).toEndWith(
      "Available models: gpt-image-2, nanobanana-2, nanobanana-pro, gpt-5-image, grok-imagine-image-pro, grok-imagine-image, nanobanana-2-lite, nanobanana",
    );
  });

  it("preserves model-specific validators before any HTTP request", async () => {
    // Given
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        requestCount += 1;
        return Response.json({ data: [] });
      },
    });
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${server.port}/v1`;
    configureProviders({ openai: baseUrl, openrouter: baseUrl, xai: baseUrl });
    const generate = new Generate();

    // When / Then
    const unsupportedSize = await generate.call("generate.image", {
      prompt: "test",
      model: "gpt-5-image",
      size: "512x512",
    });
    expect(unsupportedSize.match({ ok: () => "", err: (error) => error.message })).toContain(
      "Unsupported size '512x512' for gpt-5-image",
    );
    const unsupportedRatio = await generate.call("generate.image", {
      prompt: "test",
      model: "nanobanana",
      aspectRatio: "1:8",
    });
    expect(unsupportedRatio.match({ ok: () => "", err: (error) => error.message })).toContain(
      "Unsupported aspectRatio '1:8' for nanobanana",
    );
    const unsupportedGrokSize = await generate.call("generate.image", {
      prompt: "test",
      model: "grok-imagine-image",
      size: "1024x1024",
    });
    expect(unsupportedGrokSize.match({ ok: () => "", err: (error) => error.message })).toContain(
      "grok-imagine-image does not support size",
    );
    const unsupportedImageCount = await generate.call("generate.image", {
      prompt: "test",
      model: "grok-imagine-image-pro",
      inputImages: ["first.png", "second.png"],
    });
    expect(unsupportedImageCount.match({ ok: () => "", err: (error) => error.message })).toContain(
      "grok-imagine-image-pro supports only one input image",
    );
    expect(requestCount).toBe(0);
  });

  it("preserves default provider fallback selection", async () => {
    // Given
    configureProviders({ openrouter: "http://127.0.0.1" });
    const outputDir = await mkdtemp(join(tmpdir(), "lilac-generate-fallback-"));
    temporaryPaths.push(outputDir);

    // When / Then
    // With only OpenRouter configured, the fallback order still resolves to
    // gpt-image-2, so its validator rejects a ratio it does not support.
    const unsupportedRatio = await new Generate().call("generate.image", {
      prompt: "test",
      aspectRatio: "1:8",
      inputImages: [join(outputDir, "missing.png")],
    });
    expect(unsupportedRatio.match({ ok: () => "", err: (error) => error.message })).toContain(
      "Unsupported aspectRatio '1:8' for gpt-image-2",
    );
    // A supported ratio gets past validation and fails on the missing input.
    const missingInput = await new Generate().call("generate.image", {
      prompt: "test",
      aspectRatio: "1:1",
      inputImages: [join(outputDir, "missing.png")],
    });
    expect(missingInput.match({ ok: () => "", err: (error) => error.message })).toContain(
      "missing.png",
    );
  });

  it("preserves generation result fields and unique PNG filename behavior", async () => {
    // Given
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({ data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }] }),
    });
    servers.push(server);
    configureProviders({ openai: `http://127.0.0.1:${server.port}/v1` });
    const outputDir = await mkdtemp(join(tmpdir(), "lilac-generate-result-"));
    temporaryPaths.push(outputDir);
    await writeFile(join(outputDir, "generated-image.png"), PNG_BYTES);

    // When
    const result = await new Generate().call("generate.image", {
      prompt: "a violet square",
      model: "gpt-5-image",
      outputDir,
    });

    // Then
    expect(result.unwrap()).toEqual({
      ok: true,
      path: join(outputDir, "generated-image (1).png"),
      bytes: PNG_BYTES.byteLength,
      mimeType: "image/png",
      model: "gpt-5-image",
      warnings: [],
    });
    expect(await readFile(join(outputDir, "generated-image (1).png"))).toEqual(
      Buffer.from(PNG_BYTES),
    );
  });

  it("preserves edit prompt image and mask conversion", async () => {
    // Given
    const directory = await mkdtemp(join(tmpdir(), "lilac-generate-edit-"));
    temporaryPaths.push(directory);
    await writeFile(join(directory, "source.png"), PNG_BYTES);
    await writeFile(join(directory, "mask.png"), PNG_BYTES);

    // When
    const prompt = await buildImageGenerationPrompt(directory, {
      prompt: "replace the background",
      inputImages: ["source.png"],
      maskImage: "mask.png",
    });

    // Then
    expect(prompt.unwrap()).toEqual({
      text: "replace the background",
      images: [Buffer.from(PNG_BYTES)],
      mask: Buffer.from(PNG_BYTES),
    });
  });
});
