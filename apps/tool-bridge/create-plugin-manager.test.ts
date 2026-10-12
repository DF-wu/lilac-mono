import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseCoreConfig } from "@stanley2058/lilac-utils";

import { createToolBridgePluginManager } from "./create-plugin-manager";

describe("tool-bridge plugin manager construction", () => {
  let tmpRoot: string | undefined;

  afterEach(async () => {
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  });

  it("preserves standalone bridge Generate construction and list behavior", async () => {
    // Given
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-tool-bridge-"));
    const manager = createToolBridgePluginManager({
      dataDir: path.join(tmpRoot, "data"),
    });

    // When
    await manager.init();
    const generate = manager.getLevel2Tools().find((tool) => tool.id === "generate");

    // Then
    expect(generate).toBeDefined();
    expect(Array.isArray(await generate?.list())).toBe(true);

    await manager.destroy();
  });

  it("reads the standalone bridge config lazily through Generate", async () => {
    // Given
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-tool-bridge-"));
    const config = await parseCoreConfig({
      configVersion: 2,
      tools: {
        generate: {
          image: {
            provider: "default",
          },
        },
      },
    });
    const observedProviders: string[] = [];
    const manager = createToolBridgePluginManager({
      dataDir: path.join(tmpRoot, "data"),
      getConfig: async () => {
        observedProviders.push(config.tools.generate.image.provider);
        return config;
      },
    });
    await manager.init();
    const generate = manager.getLevel2Tools().find((tool) => tool.id === "generate");
    const observationsAfterInit = observedProviders.length;

    // When
    await generate?.list();

    // Then
    expect(observedProviders.length).toBeGreaterThan(observationsAfterInit);
    expect(observedProviders.at(-1)).toBe("default");

    await manager.destroy();
  });

  it("propagates a rejected standalone bridge config getter from Generate", async () => {
    // Given
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-tool-bridge-"));
    const config = await parseCoreConfig({ configVersion: 2 });
    const configError = new Error("invalid bridge config");
    let rejected = false;
    const manager = createToolBridgePluginManager({
      dataDir: path.join(tmpRoot, "data"),
      getConfig: async () => {
        if (rejected) throw configError;
        return config;
      },
    });
    await manager.init();
    const generate = manager.getLevel2Tools().find((tool) => tool.id === "generate");
    rejected = true;

    // When / Then
    await expect(generate?.list()).rejects.toBe(configError);

    await manager.destroy();
  });
});
