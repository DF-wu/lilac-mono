import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

async function runHelpInFreshProcess(params: {
  dataDir: string;
  baseUrl: string;
  apiKey: string;
}): Promise<{ status: number; body: { description?: string } }> {
  const helper = path.join(import.meta.dir, "create-plugin-manager.help-probe.ts");
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn("bun", [helper, `--data-dir=${params.dataDir}`], {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        DATA_DIR: params.dataDir,
        OPENAI_COMPATIBLE_BASE_URL: params.baseUrl,
        OPENAI_COMPATIBLE_API_KEY: params.apiKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`subprocess failed (${code}): ${stderr || stdout}`));
        return;
      }
      resolve(stdout.trim());
    });
  });

  return JSON.parse(raw) as { status: number; body: { description?: string } };
}

describe("tool-bridge plugin manager", () => {
  let tmpRoot: string | null = null;

  afterEach(async () => {
    if (!tmpRoot) return;
    await fs.rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  });

  it("surfaces generate.image config in help output", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-tool-bridge-"));
    const dataDir = path.join(tmpRoot, "data");
    await fs.mkdir(dataDir, { recursive: true });

    const result = await runHelpInFreshProcess({
      dataDir,
      baseUrl: "https://example.invalid/v1",
      apiKey: "test-key",
    });

    expect(result.status).toBe(200);
    expect(result.body.description).toContain("Default models: openai-compatible/gpt-image-2");
    expect(result.body.description).toContain("size=1024x1024");
    expect(result.body.description).toContain("high fidelity product shots");
  }, 60_000);
});
