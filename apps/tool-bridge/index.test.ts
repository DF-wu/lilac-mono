import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("standalone bridge passes lazy configuration to content.inspect", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "tool-bridge-config-"));
  const configPath = path.join(directory, "core-config.yaml");
  await writeFile(
    configPath,
    "configVersion: 2\ntools:\n  inspect:\n    model: google/gemini-2.5-flash\n",
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `
import { expect, mock } from "bun:test";
import { writeFile } from "node:fs/promises";
import * as core from "@stanley2058/lilac-core";
import { getCoreConfig, providers } from "@stanley2058/lilac-utils";

const selectedModels = [];
Object.assign(providers, {
  vercel: (model) => {
    selectedModels.push(model);
    throw new Error("stop before network request");
  },
});

mock.module("@stanley2058/lilac-core", () => ({
  ...core,
  createToolServer: ({ pluginManager }) => ({
    async init() {
      expect((await pluginManager.init()).isOk()).toBe(true);
    },
    async start() {
      const tool = pluginManager.getLevel2Tools().find((tool) => tool.id === "content.inspect");
      expect(tool).toBeDefined();
      await tool.call("content.inspect", { text: "inspect me" });
      expect(selectedModels).toEqual(["google/gemini-2.5-flash"]);

      await writeFile(
        ${JSON.stringify(configPath)},
        "configVersion: 2\\ntools:\\n  inspect:\\n    model: google/gemini-2.5-pro\\n",
      );
      await getCoreConfig({ forceReload: true });
      await tool.call("content.inspect", { text: "inspect updated configuration" });
      expect(selectedModels).toEqual(["google/gemini-2.5-flash", "google/gemini-2.5-pro"]);
      expect((await pluginManager.destroy()).isOk()).toBe(true);
      console.log("bridge configuration regression passed");
    },
  }),
}));

await import(${JSON.stringify(path.join(import.meta.dir, "index.ts"))});
`,
    ],
    {
      cwd: import.meta.dir,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        DATA_DIR: directory,
        LOG_LEVEL: "error",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const deadline = setTimeout(() => child.kill(), 45_000);
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit, stderr).toBe(0);
    expect(stdout).toContain("bridge configuration regression passed");
  } finally {
    clearTimeout(deadline);
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
