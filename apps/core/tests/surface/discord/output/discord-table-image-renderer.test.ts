import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { Panic } from "better-result";
import type { MarkdownTableData } from "../../../../src/shared/markdown-table-renderer";
import {
  DiscordTableImageRenderer,
  renderDiscordTableImages,
} from "../../../../src/surface/discord/output/discord-table-image-renderer";

const cell = (text: string) => ({ runs: [{ text }] });

const executable =
  process.env.LILAC_CHROMIUM_PATH ??
  process.env.CHROMIUM_PATH ??
  Bun.which("chromium") ??
  Bun.which("chromium-browser") ??
  Bun.which("google-chrome") ??
  Bun.which("google-chrome-stable") ??
  chromium.executablePath();

// Headless Chrome rendering can exhaust GitHub-hosted runners; keep this suite for local checks.
const describeLocal = describe.skipIf(process.env.GITHUB_ACTIONS === "true");

describeLocal("table PNG rendering", () => {
  it("does not launch a browser for empty input", async () => {
    expect(await renderDiscordTableImages([])).toEqual([]);
  });

  it("returns a fallback for each table when the browser cannot launch", async () => {
    const moduleUrl = new URL(
      "../../../../src/surface/discord/output/discord-table-image-renderer.ts",
      import.meta.url,
    ).href;
    const source = `import { DiscordTableImageRenderer, renderDiscordTableImages } from ${JSON.stringify(moduleUrl)};
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

function fakeBrowser() {
  let connected = true;
  let pageClosed = false;
  let table: MarkdownTableData | undefined;
  const state = {
    launches: 0,
    pages: 0,
    screenshots: 0,
    closes: 0,
    beforeScreenshot: async () => {},
    pageFailure: null as Error | null,
    crash: () => {},
  };
  const page = {
    isClosed: () => pageClosed,
    on: (_event: string, callback: () => void) => {
      state.crash = callback;
    },
    evaluate: async (_draw: unknown, input: MarkdownTableData) => {
      table = input;
    },
    locator: () => ({
      screenshot: async () => {
        state.screenshots++;
        await state.beforeScreenshot();
        return new TextEncoder().encode(table?.rows[0]?.[0]?.runs[0]?.text ?? "");
      },
    }),
  };
  const browser = {
    isConnected: () => connected,
    on: () => {},
    newPage: async () => {
      state.pages++;
      if (state.pageFailure) throw state.pageFailure;
      return page;
    },
    close: async () => {
      state.closes++;
      connected = false;
      pageClosed = true;
    },
  };
  return {
    state,
    launch: async () => {
      state.launches++;
      return browser as unknown as Browser;
    },
  };
}

const singleTable = (text: string): MarkdownTableData => ({ rows: [[cell(text)]], align: [] });
const decode = (images: readonly (Uint8Array | null)[]) =>
  images.map((bytes) => bytes && new TextDecoder().decode(bytes));

describeLocal("owned table image browser", () => {
  it("stays stopped when disabled and warms exactly one page before accepting renders", async () => {
    const fake = fakeBrowser();
    const renderer = new DiscordTableImageRenderer(fake.launch);
    await renderer.setEnabled(false);
    expect(await renderer.render([singleTable("disabled")])).toEqual([null]);
    expect(fake.state.launches).toBe(0);
    await Promise.all([renderer.setEnabled(true), renderer.setEnabled(true)]);
    expect(fake.state.screenshots).toBe(1);
    expect(decode(await renderer.render([singleTable("first")]))).toEqual(["first"]);
    expect(decode(await renderer.render([singleTable("second")]))).toEqual(["second"]);
    expect(fake.state.launches).toBe(1);
    expect(fake.state.pages).toBe(1);
    expect(fake.state.closes).toBe(0);
    await renderer.close();
    await renderer.close();
    expect(fake.state.closes).toBe(1);
    expect(await renderer.render([singleTable("closed")])).toEqual([null]);
  });

  it("logs lifecycle and render timings with correlation but without table text", async () => {
    const fake = fakeBrowser();
    const renderer = new DiscordTableImageRenderer(fake.launch);
    const logs: { event: string; fields: Record<string, unknown> }[] = [];
    Object.assign(renderer, {
      logger: {
        debug: (event: string, fields: Record<string, unknown>) => logs.push({ event, fields }),
      },
    });
    await renderer.setEnabled(true);
    await renderer.render([singleTable("private-table-content")], {
      requestId: "request-1",
      channelId: "channel-1",
    });
    await renderer.close();
    expect(logs.map((log) => log.event)).toEqual([
      "table_image.configured",
      "table_image.browser.start",
      "table_image.browser.ready",
      "table_image.render.start",
      "table_image.render.table",
      "table_image.render.complete",
      "table_image.configured",
      "table_image.browser.close",
      "table_image.browser.closed",
    ]);
    const tableLog = logs.find((log) => log.event === "table_image.render.table")!;
    expect(tableLog.fields).toMatchObject({
      requestId: "request-1",
      channelId: "channel-1",
      renderId: 1,
      rows: 1,
      columns: 1,
      fallback: false,
      bytes: 21,
      layoutMs: expect.any(Number),
      screenshotMs: expect.any(Number),
    });
    expect(JSON.stringify(logs)).not.toContain("private-table-content");
  });

  it("serializes concurrent replies and drains accepted renders before closing the page", async () => {
    const fake = fakeBrowser();
    const renderer = new DiscordTableImageRenderer(fake.launch);
    await renderer.setEnabled(true);
    const capturing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fake.state.beforeScreenshot = async () => {
      capturing.resolve();
      await release.promise;
    };
    const first = renderer.render([singleTable("first")]);
    const second = renderer.render([singleTable("second")]);
    const closed = renderer.close();
    await capturing.promise;
    expect(fake.state.screenshots).toBe(2);
    expect(fake.state.closes).toBe(0);
    release.resolve();
    expect(decode(await first)).toEqual(["first"]);
    expect(decode(await second)).toEqual(["second"]);
    await closed;
    expect(fake.state.closes).toBe(1);
  });

  it("closes a failed warmup and returns the text fallback", async () => {
    const fake = fakeBrowser();
    fake.state.beforeScreenshot = async () => {
      throw new Error("screenshot unavailable");
    };
    const renderer = new DiscordTableImageRenderer(fake.launch);
    await renderer.setEnabled(true);
    expect(fake.state.closes).toBe(1);
    expect(await renderer.render([singleTable("fallback")])).toEqual([null]);
    await renderer.close();
  });

  it("closes the browser when page creation fails", async () => {
    const fake = fakeBrowser();
    fake.state.pageFailure = new Error("page unavailable");
    const renderer = new DiscordTableImageRenderer(fake.launch);
    await renderer.setEnabled(true);
    expect(fake.state.closes).toBe(1);
    expect(fake.state.screenshots).toBe(0);
    await renderer.close();
  });

  it("recreates a crashed page on the next render and can be enabled again after closing", async () => {
    const instances: ReturnType<typeof fakeBrowser>[] = [];
    const renderer = new DiscordTableImageRenderer(async () => {
      const fake = fakeBrowser();
      instances.push(fake);
      return fake.launch();
    });
    await renderer.setEnabled(true);
    instances[0]!.state.crash();
    expect(decode(await renderer.render([singleTable("after crash")]))).toEqual(["after crash"]);
    expect(instances).toHaveLength(2);
    expect(instances[0]!.state.closes).toBe(1);
    await renderer.close();
    await renderer.setEnabled(true);
    expect(instances).toHaveLength(3);
    expect(instances[2]!.state.screenshots).toBe(1);
    await renderer.close();
  });

  it("propagates a render Panic without blocking subsequent renders or shutdown", async () => {
    const fake = fakeBrowser();
    const renderer = new DiscordTableImageRenderer(fake.launch);
    await renderer.setEnabled(true);
    const panic = new Panic({ message: "render invariant failed" });
    fake.state.beforeScreenshot = async () => {
      throw panic;
    };
    await expect(renderer.render([singleTable("panic")])).rejects.toBeInstanceOf(Panic);
    fake.state.beforeScreenshot = async () => {};
    expect(decode(await renderer.render([singleTable("next")]))).toEqual(["next"]);
    await renderer.close();
    expect(fake.state.closes).toBe(1);
  });

  it.skipIf(!existsSync(executable))(
    "keeps the same real page across replies without mixing their content",
    async () => {
      let launches = 0;
      let browser: Browser | undefined;
      const renderer = new DiscordTableImageRenderer(async () => {
        launches++;
        browser = await chromium.launch({ headless: true, executablePath: executable });
        return browser;
      });
      try {
        await renderer.setEnabled(true);
        const firstPage = browser!.contexts()[0]!.pages()[0]!;
        const [short, tall] = await Promise.all([
          renderer.render([singleTable("short")]),
          renderer.render([{ rows: Array.from({ length: 10 }, () => [cell("tall")]), align: [] }]),
        ]);
        const height = (bytes: Uint8Array | null | undefined) =>
          new DataView(bytes!.buffer, bytes!.byteOffset, bytes!.byteLength).getUint32(20);
        expect(height(short[0])).toBe(80);
        expect(height(tall[0])).toBe(800);
        expect(launches).toBe(1);
        expect(browser!.contexts()[0]!.pages()).toEqual([firstPage]);
      } finally {
        await renderer.close();
      }
      expect(browser!.isConnected()).toBe(false);
    },
    30_000,
  );
});
