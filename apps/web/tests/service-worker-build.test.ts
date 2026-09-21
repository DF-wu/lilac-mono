import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "vite";
import { serviceWorkerBuild } from "../service-worker-build";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
test("production build replaces placeholders and precaches only initial dependencies", async () => {
  directory = await mkdtemp(path.join(tmpdir(), "lilac-worker-build-"));
  await writeFile(
    path.join(directory, "index.html"),
    '<html><head></head><body><script type="module" src="/main.js"></script></body></html>',
  );
  await writeFile(
    path.join(directory, "main.js"),
    'document.body.addEventListener("click", () => import("./heavy.js"));',
  );
  await writeFile(
    path.join(directory, "heavy.js"),
    'document.body.textContent = "heavy renderer";',
  );
  const buildOnce = async () => {
    const output = await build({
      root: directory,
      configFile: false,
      logLevel: "silent",
      plugins: [serviceWorkerBuild()],
      build: { write: false },
    });
    if (Array.isArray(output) || !("output" in output)) throw new Error("Unexpected build output");
    const worker = output.output.find((file) => file.fileName === "sw.js");
    const html = output.output.find((file) => file.fileName === "index.html");
    if (worker?.type !== "asset" || html?.type !== "asset") throw new Error("Missing build output");
    return { worker: String(worker.source), html: String(html.source) };
  };
  const first = await buildOnce();
  expect(first.worker).not.toContain("__BUILD_ID__");
  expect(first.worker).not.toContain("__PRECACHE_PATHS__");
  const version = /const BUILD_ID = "([a-f0-9]{20})"/.exec(first.worker)?.[1];
  expect(version).toBeDefined();
  expect(first.html).toContain(`name="lilac-build" content="${version}"`);
  const precache = /const PRECACHE_PATHS = ([^;]+);/.exec(first.worker)?.[1] ?? "";
  expect(precache).toContain("/assets/index-");
  expect(precache).not.toContain("heavy-");
  expect(first.worker).toContain("/assets/heavy-");
  expect((await buildOnce()).worker).toBe(first.worker);
  await writeFile(
    path.join(directory, "heavy.js"),
    'document.body.textContent = "changed renderer";',
  );
  expect((await buildOnce()).worker).not.toBe(first.worker);
});
