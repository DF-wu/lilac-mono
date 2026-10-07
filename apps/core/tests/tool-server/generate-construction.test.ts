import { describe, expect, it } from "bun:test";
import { parseCoreConfig } from "@stanley2058/lilac-utils";

import { createBuiltinGeneratePlugin } from "../../src/plugins/builtin/server-tools";
import { Generate } from "../../src/tool-server/tools/generate";

describe("Generate construction", () => {
  it("preserves direct construction and list behavior", async () => {
    // Given
    const generate = new Generate();

    // When
    const entries = await generate.list();

    // Then
    expect(generate.id).toBe("generate");
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.every((entry) => entry.callableId.startsWith("generate."))).toBe(true);
  });

  it("preserves built-in plugin construction and list behavior", async () => {
    // Given
    const plugin = createBuiltinGeneratePlugin();

    // When
    const created = await plugin.create({
      runtime: {},
      dataDir: "/tmp",
      pluginConfig: undefined,
      source: "builtin",
    });
    const generate = created.level2?.[0];

    // Then
    expect(plugin.meta.id).toBe("generate");
    expect(generate).toBeInstanceOf(Generate);
    expect(await generate?.list()).toEqual(await new Generate().list());
  });

  it("reads the built-in plugin config lazily through Generate", async () => {
    // Given
    const config = await parseCoreConfig({ configVersion: 2 });
    let observedProvider: string | undefined;
    const plugin = createBuiltinGeneratePlugin();
    const created = await plugin.create({
      runtime: {
        getConfig: async () => {
          observedProvider = config.tools.generate.image.provider;
          return config;
        },
      },
      dataDir: "/tmp",
      pluginConfig: undefined,
      source: "builtin",
    });
    const generate = created.level2?.[0];
    expect(observedProvider).toBeUndefined();

    // When
    await generate?.list();

    // Then
    expect(observedProvider).toBe("default");
  });

  it("propagates a rejected built-in plugin config getter from Generate", async () => {
    // Given
    const configError = new Error("invalid core config");
    const plugin = createBuiltinGeneratePlugin();
    const created = await plugin.create({
      runtime: {
        getConfig: async () => {
          throw configError;
        },
      },
      dataDir: "/tmp",
      pluginConfig: undefined,
      source: "builtin",
    });
    const generate = created.level2?.[0];

    // When / Then
    await expect(generate?.list()).rejects.toBe(configError);
  });
});
