import { afterEach, describe, expect, it } from "bun:test";
import { env, parseCoreConfig, type CoreConfig } from "@stanley2058/lilac-utils";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Generate } from "../../src/tool-server/tools/generate";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");
const CONFIG_ERROR =
  "Image generation provider 'openai-compatible' requires OPENAI_COMPATIBLE_BASE_URL.";
const ALIAS_CASES = [
  ["gpt-5-image", "gpt-image-1.5"],
  ["nanobanana", "google/gemini-2.5-flash-image"],
  ["nanobanana-2", "google/gemini-3.1-flash-image-preview"],
  ["nanobanana-pro", "google/gemini-3-pro-image-preview"],
  ["grok-imagine-image", "grok-imagine-image"],
  ["grok-imagine-image-pro", "grok-imagine-image-pro"],
] as const;

const originalProviders = structuredClone(env.providers);
const temporaryPaths: string[] = [];
const servers: Bun.Server<unknown>[] = [];

async function compatibleConfig(): Promise<Pick<CoreConfig, "tools">> {
  const config = await parseCoreConfig({
    configVersion: 2,
    tools: { generate: { image: { provider: "openai-compatible" } } },
  });
  return config;
}

function configureCompatible(baseUrl: string | undefined): void {
  Object.assign(env.providers.openaiCompatible, {
    apiKey: baseUrl ? "compatible-key" : undefined,
    baseUrl,
  });
}

function startServer(
  fetch: (request: Request) => Response | Promise<Response>,
): Bun.Server<unknown> {
  const server = Bun.serve({ port: 0, fetch });
  servers.push(server);
  return server;
}

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const path of temporaryPaths.splice(0)) await rm(path, { force: true, recursive: true });
  Object.assign(env.providers.openai, originalProviders.openai);
  Object.assign(env.providers.openrouter, originalProviders.openrouter);
  Object.assign(env.providers.xai, originalProviders.xai);
  Object.assign(env.providers.openaiCompatible, originalProviders.openaiCompatible);
});

describe("Generate OpenAI-compatible image routing", () => {
  it.each(ALIAS_CASES)("routes %s to canonical model %s", async (alias, canonicalId) => {
    // Given
    let body: unknown;
    const server = startServer(async (request) => {
      body = await request.json();
      return Response.json({ data: [{ b64_json: PNG_BASE64 }] });
    });
    configureCompatible(`http://127.0.0.1:${server.port}/v1`);
    const outputDir = await mkdtemp(join(tmpdir(), "lilac-compatible-alias-"));
    temporaryPaths.push(outputDir);

    // When
    const result = await new Generate({ getConfig: compatibleConfig }).call("generate.image", {
      prompt: "canonical route",
      model: alias,
      outputDir,
    });

    // Then
    expect(body).toMatchObject({ model: canonicalId });
    expect(result).toMatchObject({ ok: true, model: alias, mimeType: "image/png" });
  });

  it("throws a stable configuration error before default fallback", async () => {
    // Given
    configureCompatible(undefined);
    Object.assign(env.providers.openai, { apiKey: "official-key", baseUrl: "http://127.0.0.1" });

    // When / Then
    await expect(
      new Generate({ getConfig: compatibleConfig }).call("generate.image", {
        prompt: "no request",
      }),
    ).rejects.toThrow(CONFIG_ERROR);
  });

  it("rejects invalid compatible input before HTTP", async () => {
    // Given
    let requestCount = 0;
    const server = startServer(() => {
      requestCount += 1;
      return Response.json({ data: [] });
    });
    configureCompatible(`http://127.0.0.1:${server.port}/v1`);
    const generate = new Generate({ getConfig: compatibleConfig });

    // When / Then
    await expect(
      generate.call("generate.image", {
        prompt: "invalid",
        model: "gpt-5-image",
        size: "512x512",
      }),
    ).rejects.toThrow("Unsupported size '512x512' for gpt-5-image");
    await expect(
      generate.call("generate.image", {
        prompt: "invalid",
        model: "grok-imagine-image",
        maskImage: "mask.png",
        inputImages: "source.png",
      }),
    ).rejects.toThrow("grok-imagine-image does not support maskImage");
    expect(requestCount).toBe(0);
  });

  it("uses the JSON generation path and preserves output PNG", async () => {
    // Given
    let capture:
      | { method: string; path: string; authorization: string | null; body: unknown }
      | undefined;
    const server = startServer(async (request) => {
      capture = {
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      };
      return Response.json({ data: [{ b64_json: PNG_BASE64 }] });
    });
    configureCompatible(`http://127.0.0.1:${server.port}/v1`);
    const outputDir = await mkdtemp(join(tmpdir(), "lilac-compatible-json-"));
    temporaryPaths.push(outputDir);

    // When
    const result = await new Generate({ getConfig: compatibleConfig }).call("generate.image", {
      prompt: "json prompt",
      model: "gpt-5-image",
      size: "1024x1024",
      outputDir,
    });

    // Then
    expect(capture).toEqual({
      method: "POST",
      path: "/v1/images/generations",
      authorization: "Bearer compatible-key",
      body: {
        model: "gpt-image-1.5",
        prompt: "json prompt",
        n: 1,
        size: "1024x1024",
        response_format: "b64_json",
      },
    });
    expect(await readFile(join(outputDir, "generated-image.png"))).toEqual(PNG_BYTES);
    expect(result).toMatchObject({ path: join(outputDir, "generated-image.png") });
  });

  it("uses the multipart edit path", async () => {
    // Given
    let capture: { method: string; path: string; fields: Record<string, string> } | undefined;
    const server = startServer(async (request) => {
      const fields: Record<string, string> = {};
      for (const [key, value] of await request.formData()) {
        fields[key] = typeof value === "string" ? value : `${value.type}:${value.size}`;
      }
      capture = { method: request.method, path: new URL(request.url).pathname, fields };
      return Response.json({ data: [{ b64_json: PNG_BASE64 }] });
    });
    configureCompatible(`http://127.0.0.1:${server.port}/v1`);
    const outputDir = await mkdtemp(join(tmpdir(), "lilac-compatible-edit-"));
    temporaryPaths.push(outputDir);
    await writeFile(join(outputDir, "source.png"), PNG_BYTES);
    await writeFile(join(outputDir, "mask.png"), PNG_BYTES);

    // When
    await new Generate({ getConfig: compatibleConfig }).call(
      "generate.image",
      {
        prompt: "edit prompt",
        model: "gpt-5-image",
        inputImages: "source.png",
        maskImage: "mask.png",
        outputDir,
      },
      { context: { cwd: outputDir } },
    );

    // Then
    expect(capture).toEqual({
      method: "POST",
      path: "/v1/images/edits",
      fields: {
        image: "image/png:70",
        mask: "image/png:70",
        model: "gpt-image-1.5",
        n: "1",
        prompt: "edit prompt",
      },
    });
  });

  it("propagates HTTP 500 after exactly one request without official fallback", async () => {
    // Given
    let requestCount = 0;
    const server = startServer(() => {
      requestCount += 1;
      return Response.json(
        { error: { message: "compatible failed", type: "server_error" } },
        { status: 500 },
      );
    });
    configureCompatible(`http://127.0.0.1:${server.port}/v1`);
    Object.assign(env.providers.openai, {
      apiKey: "official-key",
      baseUrl: "http://127.0.0.1:1/v1",
    });

    // When / Then
    await expect(
      new Generate({ getConfig: compatibleConfig }).call("generate.image", {
        prompt: "fail once",
        model: "gpt-5-image",
      }),
    ).rejects.toThrow("compatible failed");
    expect(requestCount).toBe(1);
  });

  it("rejects a malformed success response after one request without output", async () => {
    // Given
    let requestCount = 0;
    const server = startServer(() => {
      requestCount += 1;
      return Response.json({ data: [{}] });
    });
    configureCompatible(`http://127.0.0.1:${server.port}/v1`);
    const outputDir = await mkdtemp(join(tmpdir(), "lilac-compatible-malformed-"));
    temporaryPaths.push(outputDir);

    // When / Then
    await expect(
      new Generate({ getConfig: compatibleConfig }).call("generate.image", {
        prompt: "malformed once",
        model: "gpt-5-image",
        outputDir,
      }),
    ).rejects.toThrow();
    expect(requestCount).toBe(1);
    expect(await Array.fromAsync(new Bun.Glob("*").scan({ cwd: outputDir }))).toEqual([]);
  });
});
