import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { renderDiscordTableImages } from "../../../../src/surface/discord/output/discord-table-image-renderer";

const cell = (text: string) => ({ runs: [{ text }] });

const executable =
  process.env.LILAC_CHROMIUM_PATH ??
  process.env.CHROMIUM_PATH ??
  Bun.which("chromium") ??
  Bun.which("chromium-browser") ??
  Bun.which("google-chrome") ??
  Bun.which("google-chrome-stable") ??
  chromium.executablePath();

describe("table PNG rendering", () => {
  it("does not launch a browser for empty input", async () => {
    expect(await renderDiscordTableImages([])).toEqual([]);
  });

  it("returns a fallback for each table when the browser cannot launch", async () => {
    const moduleUrl = new URL(
      "../../../../src/surface/discord/output/discord-table-image-renderer.ts",
      import.meta.url,
    ).href;
    const source = `import { renderDiscordTableImages } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify(await renderDiscordTableImages([
        { rows: [[{runs:[{text:"Header"}]}]], align: [] },
        { rows: [[{runs:[{text:"Other"}]}]], align: [] }
      ])));`;
    const process = Bun.spawn([Bun.which("bun")!, "--eval", source], {
      env: { ...globalThis.process.env, LILAC_CHROMIUM_PATH: "/nonexistent/lilac-test-chromium" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await new Response(process.stdout).text()).toBe("[null,null]\n");
    expect(await process.exited).toBe(0);
  });

  it.skipIf(!existsSync(executable))(
    "renders measured columns at 2× without clipping wide words or tall tables",
    async () => {
      const [compact, wide, tall, proportional, code] = await renderDiscordTableImages([
        {
          rows: [
            [cell("Name"), cell("State")],
            [cell("Alpha"), cell("Ready")],
          ],
          align: ["left", "right"],
        },
        { rows: [[cell("Identifier")], [cell("W".repeat(120))]], align: [] },
        {
          rows: [[cell("Job")], ...Array.from({ length: 36 }, (_, i) => [cell(`Batch ${i + 1}`)])],
          align: [],
        },
        { rows: [[cell("i")], [cell("i".repeat(16))]], align: [] },
        { rows: [[cell("i")], [{ runs: [{ text: "i".repeat(16), code: true }] }]], align: [] },
      ]);
      const dimensions = (bytes: Uint8Array | null | undefined) => {
        expect(bytes).not.toBeNull();
        expect(bytes!.slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
        const view = new DataView(bytes!.buffer, bytes!.byteOffset, bytes!.byteLength);
        return { width: view.getUint32(16), height: view.getUint32(20) };
      };
      expect(dimensions(compact).height).toBe(160);
      expect(dimensions(compact).width).toBeLessThan(500);
      expect(dimensions(wide).height).toBe(160);
      expect(dimensions(wide).width).toBeGreaterThan(4000);
      expect(dimensions(tall).height).toBe(37 * 40 * 2);
      expect(dimensions(code).height).toBe(160);
      expect(dimensions(code).width).toBeGreaterThan(dimensions(proportional).width * 2);
    },
    // Chromium startup and five screenshots need headroom on shared CI runners.
    30_000,
  );
});
