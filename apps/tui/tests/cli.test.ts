import { expect, test } from "bun:test";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../../..");

async function invoke(args: string[], version = "development") {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    env: { ...process.env, LILAC_TUI_VERSION: version },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("direct CLI help never enters authentication or terminal setup", async () => {
  const result = await invoke(["apps/tui/src/main.ts", "--help"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toStartWith("Usage: lilac-tui");
  expect(result.stdout).not.toContain("Username:");
  expect(result.stderr).toBe("");
});

test("root dev:tui forwards help arguments to the CLI", async () => {
  const result = await invoke(["run", "dev:tui", "--", "--help"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toStartWith("Usage: lilac-tui");
  expect(result.stdout).not.toContain("Username:");
});

test("CLI version reports the build version without initializing OpenTUI", async () => {
  const result = await invoke(["apps/tui/src/main.ts", "--version"], "fixture-release");
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("lilac-tui fixture-release\n");
  expect(result.stderr).toBe("");
});
