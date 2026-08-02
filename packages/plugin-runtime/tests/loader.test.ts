import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
    return loadToolPluginModule({
      entrypointPath,
      cacheBustKey: String(cacheBustKey),
    });
  }

  it("returns the original complete plugin object with its mutable state and getters", async () => {
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
    const plugin = await loadToolPluginModule({
      entrypointPath,
      cacheBustKey: "identity",
    });

    expect(Object.is(plugin, fixture)).toBe(true);
    expect(plugin.meta).toEqual({ id: "complete", name: "Complete", version: "1.0.0" });
    expect(Reflect.get(plugin, "label")).toBe("Complete:0");
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
    expect(Reflect.get(plugin, "extra")).toBe(1);
    expect(Reflect.get(plugin, "label")).toBe("Mutated:1");
  });

  it("rejects malformed and partial plugin modules", async () => {
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
      await expect(loadModule(source)).rejects.toThrow(
        "Plugin entrypoint must default export a LilacToolPlugin",
      );
    }
  });

  it("rejects arrays masquerading as plugin objects or metadata", async () => {
    await expect(
      loadModule(`const plugin = [];
plugin.meta = { id: "array-plugin" };
plugin.create = () => ({});
export default plugin;`),
    ).rejects.toThrow("Plugin entrypoint must default export a LilacToolPlugin");

    await expect(
      loadModule(`const meta = [];
meta.id = "array-meta";
export default { meta, create() { return {}; } };`),
    ).rejects.toThrow("Plugin entrypoint must default export a LilacToolPlugin");
  });
});
