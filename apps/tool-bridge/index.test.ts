import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("standalone bridge supplies current configuration through its runtime callback", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "tool-bridge-config-"));
  const configPath = path.join(directory, "core-config.yaml");
  await writeFile(configPath, "configVersion: 3\nworkflows:\n  maxActiveRuns: 2\n");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `
import { expect, mock } from "bun:test";
import { writeFile } from "node:fs/promises";
import * as core from "@stanley2058/lilac-core";
import { getCoreConfig } from "@stanley2058/lilac-utils";

const createPluginManager = core.createCoreToolPluginManager;
let loadConfig;
mock.module("@stanley2058/lilac-core", () => ({
  ...core,
  createCoreToolPluginManager: (params) => {
    loadConfig = params.runtime.getConfig;
    expect(loadConfig).toBeFunction();
    return createPluginManager(params);
  },
  createToolServer: ({ pluginManager }) => ({
    async init() {
      expect((await pluginManager.init()).isOk()).toBe(true);
    },
    async start() {
      expect((await loadConfig()).workflows.maxActiveRuns).toBe(2);
      await writeFile(
        ${JSON.stringify(configPath)},
        "configVersion: 3\\nworkflows:\\n  maxActiveRuns: 3\\n",
      );
      await getCoreConfig({ forceReload: true });
      expect((await loadConfig()).workflows.maxActiveRuns).toBe(3);
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
