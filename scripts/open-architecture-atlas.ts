import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";

const PORT = 4173;
const PROBE_URL = `http://127.0.0.1:${PORT}/`;
const BROWSER_URL = `http://localhost:${PORT}/`;
const REPO_ROOT = path.resolve(import.meta.dir, "..");
const ATLAS_DIR = path.join(REPO_ROOT, "apps", "architecture-atlas");
const PROBE_TIMEOUT_MS = 750;
const START_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

type PortState = "available" | "atlas" | "occupied";

async function probePort(): Promise<PortState> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(PROBE_URL, { signal: controller.signal });
    const body = await response.text();
    return body.includes("<title>Lilac System Atlas</title>") ? "atlas" : "occupied";
  } catch {
    return "available";
  } finally {
    clearTimeout(timeout);
  }
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const result = spawnSync(command, args, { stdio: "ignore" });

  if (result.error || result.status !== 0) {
    console.warn(`Could not open a browser automatically. Open ${url} manually.`);
  }
}

function startDevServer(): ChildProcess {
  return spawn(
    "bun",
    ["--cwd", ATLAS_DIR, "run", "dev", "--", "--port", String(PORT), "--strictPort"],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForAtlas(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const state = await probePort();
    if (state === "atlas") return;
    if (state === "occupied") {
      throw new Error(`Port ${PORT} is occupied by another service.`);
    }
    if (child.exitCode !== null) break;
    await wait(POLL_INTERVAL_MS);
  }

  throw new Error(`Atlas did not become ready on ${BROWSER_URL}`);
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const currentState = await probePort();

  if (currentState === "atlas") {
    console.log(`Atlas is already running at ${BROWSER_URL}`);
    openBrowser(BROWSER_URL);
    return;
  }

  if (currentState === "occupied") {
    throw new Error(`Port ${PORT} is occupied by another service.`);
  }

  const child = startDevServer();
  try {
    await waitForAtlas(child);
  } catch (error) {
    child.kill();
    throw error;
  }

  console.log(`Atlas is running at ${BROWSER_URL}`);
  openBrowser(BROWSER_URL);
  process.exitCode = await waitForExit(child);
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Unable to open Lilac System Atlas: ${message}`);
  process.exitCode = 1;
});
