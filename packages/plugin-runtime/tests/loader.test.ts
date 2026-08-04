import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { loadToolPluginModule } from "../loader";

describe("loadToolPluginModule", () => {
  let tmpRoot: string | null = null;
  let cacheBustKey = 0;

  afterEach(async () => {
    if (!tmpRoot) return;
    await fs.rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  });

  async function loadModule(source: string) {
    tmpRoot ??= await fs.mkdtemp(path.join(os.tmpdir(), "lilac-plugin-loader-"));
    const entrypointPath = path.join(tmpRoot, "plugin.js");
    await fs.writeFile(entrypointPath, source, "utf8");
    cacheBustKey += 1;
    return loadToolPluginModule({ entrypointPath, cacheBustKey: String(cacheBustKey) });
  }

  it("returns the original module capability with state, getters, and receivers intact", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-plugin-loader-"));
    const fixturePath = path.join(tmpRoot, "fixture.js");
    const entrypointPath = path.join(tmpRoot, "plugin.js");
    await fs.writeFile(
      fixturePath,
      `export const fixture = {
  meta: { id: "complete", name: "Complete", version: "1.0.0" },
  extra: 0,
  get label() { return this.meta.name + ":" + this.extra; },
  create() {
    if (this !== fixture) throw new Error("wrong receiver");
    this.meta.name = "Mutated";
    this.extra += 1;
    return {};
  },
};
export default fixture;
`,
      "utf8",
    );
    await fs.writeFile(
      entrypointPath,
      'export { fixture as default } from "./fixture.js";\n',
      "utf8",
    );

    const fixtureModule = await import(pathToFileURL(fixturePath).toString());
    const fixture: unknown = fixtureModule.fixture;
    const loaded = await loadToolPluginModule({ entrypointPath, cacheBustKey: "identity" });
    expect(loaded.status).toBe("ok");
    if (loaded.status === "error") throw new Error(loaded.error.message);

    const plugin = loaded.value;
    expect(Object.is(plugin, fixture)).toBe(true);
    const initialExtension = z.object({ label: z.string(), extra: z.number() }).safeParse(plugin);
    expect(initialExtension.success).toBe(true);
    if (!initialExtension.success) throw new Error(initialExtension.error.message);
    expect(initialExtension.data.label).toBe("Complete:0");
    expect(typeof Object.getOwnPropertyDescriptor(plugin, "label")?.get).toBe("function");
    expect(
      await plugin.create({
        runtime: undefined,
        dataDir: "/tmp",
        pluginConfig: undefined,
        source: "external",
      }),
    ).toEqual({});
    expect(plugin.meta.name).toBe("Mutated");
    const updatedExtension = z.object({ extra: z.number() }).safeParse(plugin);
    expect(updatedExtension.success).toBe(true);
    if (!updatedExtension.success) throw new Error(updatedExtension.error.message);
    expect(updatedExtension.data.extra).toBe(1);
  });

  it("returns typed capability errors for malformed and partial dynamic modules", async () => {
    const invalidModules = [
      "export default null;",
      "export default {};",
      'export default { meta: { id: "partial" } };',
      "export default { meta: {}, create() { return {}; } };",
      'export default { meta: { id: "   " }, create() { return {}; } };',
      'export default { meta: { id: "bad-name", name: [] }, create() { return {}; } };',
      'export default { meta: { id: "bad-version", version: 1 }, create() { return {}; } };',
    ];

    for (const source of invalidModules) {
      const loaded = await loadModule(source);
      expect(loaded.status).toBe("error");
      if (loaded.status === "ok") throw new Error("expected malformed module to fail");
      expect(loaded.error._tag).toBe("ToolPluginCapabilityError");
      if (loaded.error._tag === "ToolPluginCapabilityError") {
        expect(loaded.error.capability).toBe("module");
      }
    }
  });

  it("rejects arrays masquerading as plugin objects or metadata", async () => {
    const arrayPlugin = await loadModule(`const plugin = [];
plugin.meta = { id: "array-plugin" };
plugin.create = () => ({});
export default plugin;`);
    expect(arrayPlugin.status).toBe("error");

    const arrayMeta = await loadModule(`const meta = [];
meta.id = "array-meta";
export default { meta, create() { return {}; } };`);
    expect(arrayMeta.status).toBe("error");
  });

  it("captures module evaluation rejection without leaking it", async () => {
    const loaded = await loadModule('throw new Error("evaluation boom");');
    expect(loaded.status).toBe("error");
    if (loaded.status === "ok") throw new Error("expected evaluation failure");
    expect(loaded.error._tag).toBe("ToolPluginModuleLoadError");
    expect(loaded.error.message).toContain("evaluation boom");
  });

  it("captures capability getter failures as validation Results", async () => {
    const loaded = await loadModule(`export default {
  get meta() { throw new Error("meta getter boom"); },
  create() { return {}; },
};`);
    expect(loaded.status).toBe("error");
    if (loaded.status === "ok") throw new Error("expected getter failure");
    expect(loaded.error._tag).toBe("ToolPluginCapabilityError");
    expect(loaded.error.message).toContain("Failed to inspect module capability");
  });
});
