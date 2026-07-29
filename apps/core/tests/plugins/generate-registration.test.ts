import { describe, expect, it } from "bun:test";
import type { LilacBus } from "@stanley2058/lilac-event-bus";
import { env, parseCoreConfig } from "@stanley2058/lilac-utils";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConversationThreadService } from "../../src/conversation/thread-service";
import type { DiscoveryService } from "../../src/discovery/discovery-service";
import { createCoreToolPluginManager } from "../../src/plugins";
import type { SurfaceAdapter } from "../../src/surface/adapter";

const MISSING_BASE_URL_ERROR =
  "Image generation provider 'openai-compatible' requires OPENAI_COMPATIBLE_BASE_URL.";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

describe("generate plugin registration", () => {
  it("preserves video registration when compatible image base URL is missing", async () => {
    // Given
    const originalXai = { ...env.providers.xai };
    const originalCompatible = { ...env.providers.openaiCompatible };
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        requestCount += 1;
        return Response.json({});
      },
    });
    const dataDir = await mkdtemp(join(tmpdir(), "lilac-generate-registration-"));
    Object.assign(env.providers.xai, {
      apiKey: "video-key",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
    });
    Object.assign(env.providers.openaiCompatible, { apiKey: undefined, baseUrl: undefined });
    const config = await parseCoreConfig({
      configVersion: 2,
      tools: { generate: { image: { provider: "openai-compatible" } } },
    });
    const manager = createCoreToolPluginManager({
      runtime: {
        bus: {} as LilacBus,
        adapter: {} as SurfaceAdapter,
        discovery: {} as DiscoveryService,
        conversationThreads: {} as ConversationThreadService,
        config,
      },
      dataDir,
    });

    try {
      // When
      await manager.init();
      const generate = manager.getLevel2Tools().find((tool) => tool.id === "generate");
      const entries = await generate?.list();

      // Then
      expect(entries?.map((entry) => entry.callableId)).toContain("generate.video");
      await expect(
        generate?.call("generate.image", { prompt: "must fail before HTTP" }),
      ).rejects.toThrow(MISSING_BASE_URL_ERROR);
      expect(requestCount).toBe(0);
    } finally {
      await manager.destroy();
      server.stop(true);
      await rm(dataDir, { force: true, recursive: true });
      Object.assign(env.providers.xai, originalXai);
      Object.assign(env.providers.openaiCompatible, originalCompatible);
    }
  });

  it("honors the on-disk provider when the runtime supplies neither config nor getConfig", async () => {
    // Given
    const originalOpenai = { ...env.providers.openai };
    const originalCompatible = { ...env.providers.openaiCompatible };
    let compatibleRequests = 0;
    let officialRequests = 0;
    const compatibleServer = Bun.serve({
      port: 0,
      fetch: () => {
        compatibleRequests += 1;
        return Response.json({ data: [{ b64_json: PNG_BASE64 }] });
      },
    });
    const officialServer = Bun.serve({
      port: 0,
      fetch: () => {
        officialRequests += 1;
        return Response.json({ data: [{ b64_json: PNG_BASE64 }] });
      },
    });
    Object.assign(env.providers.openaiCompatible, {
      apiKey: "compatible-key",
      baseUrl: `http://127.0.0.1:${compatibleServer.port}/v1`,
    });
    Object.assign(env.providers.openai, {
      apiKey: "official-key",
      baseUrl: `http://127.0.0.1:${officialServer.port}/v1`,
    });
    await writeFile(
      join(env.dataDir, "core-config.yaml"),
      "configVersion: 2\ntools:\n  generate:\n    image:\n      provider: openai-compatible\n",
    );
    const outputDir = await mkdtemp(join(tmpdir(), "lilac-generate-ondisk-"));
    const manager = createCoreToolPluginManager({
      runtime: {
        bus: {} as LilacBus,
        adapter: {} as SurfaceAdapter,
        discovery: {} as DiscoveryService,
        conversationThreads: {} as ConversationThreadService,
      },
      dataDir: env.dataDir,
    });

    try {
      // When
      await manager.init();
      const generate = manager.getLevel2Tools().find((tool) => tool.id === "generate");
      await generate?.call("generate.image", {
        prompt: "must reach the compatible endpoint",
        model: "gpt-image-2",
        outputDir,
      });

      // Then
      expect(compatibleRequests).toBe(1);
      expect(officialRequests).toBe(0);
    } finally {
      await manager.destroy();
      compatibleServer.stop(true);
      officialServer.stop(true);
      await rm(join(env.dataDir, "core-config.yaml"), { force: true });
      await rm(outputDir, { force: true, recursive: true });
      Object.assign(env.providers.openai, originalOpenai);
      Object.assign(env.providers.openaiCompatible, originalCompatible);
    }
  });
});
