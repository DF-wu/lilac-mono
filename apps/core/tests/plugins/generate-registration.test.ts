import { describe, expect, it } from "bun:test";
import type { LilacBus } from "@stanley2058/lilac-event-bus";
import { env, parseCoreConfig } from "@stanley2058/lilac-utils";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConversationThreadService } from "../../src/conversation/thread-service";
import type { DiscoveryService } from "../../src/discovery/discovery-service";
import { createCoreToolPluginManager } from "../../src/plugins";
import type { SurfaceAdapter } from "../../src/surface/adapter";

const MISSING_BASE_URL_ERROR =
  "Image generation provider 'openai-compatible' requires OPENAI_COMPATIBLE_BASE_URL.";

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
});
