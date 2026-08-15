import { afterEach, describe, expect, it, jest } from "bun:test";
import { env } from "@stanley2058/lilac-utils";

import { Web } from "../../src/tool-server/tools/web";
import { FirecrawlPermitPool } from "../../src/tool-server/tools/web-search/firecrawl-permit-pool";

const servers: Array<{ stop(force?: boolean): void }> = [];
const originalFirecrawlApiKey = env.tools.web.firecrawl.apiKey;
const originalFirecrawlApiBaseUrl = env.tools.web.firecrawl.apiBaseUrl;

afterEach(() => {
  jest.useRealTimers();
  while (servers.length > 0) {
    servers.pop()?.stop(true);
  }

  const mutableFirecrawlEnv = env.tools.web.firecrawl as {
    apiKey?: string;
    apiBaseUrl?: string;
  };
  mutableFirecrawlEnv.apiKey = originalFirecrawlApiKey;
  mutableFirecrawlEnv.apiBaseUrl = originalFirecrawlApiBaseUrl;
});

function deferred<T = void>() {
  return Promise.withResolvers<T>();
}

function startServer(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: handler,
  });
  servers.push(server);
  return server;
}

function stubWeb(tool: Web, stub: Record<string, unknown>): void {
  Object.assign(tool as unknown as Record<string, unknown>, stub);
}

function callExtractPageContent(
  tool: Web,
  input: Record<string, unknown>,
  opts?: { signal?: AbortSignal },
): Promise<unknown> {
  const privateApi = tool as unknown as {
    extractPageContent: (
      input: Record<string, unknown>,
      opts?: { signal?: AbortSignal },
    ) => Promise<unknown>;
  };

  return privateApi.extractPageContent(input, opts);
}

function callExtractPageContentWithProvider(
  tool: Web,
  providerId: string,
  input: Record<string, unknown>,
  opts?: { signal?: AbortSignal },
): Promise<unknown> {
  const privateApi = tool as unknown as {
    extractPageContentWithProvider: (
      providerId: string,
      input: Record<string, unknown>,
      opts?: { signal?: AbortSignal },
    ) => Promise<unknown>;
  };

  return privateApi.extractPageContentWithProvider(providerId, input, opts);
}

describe("web tool fetch", () => {
  it("propagates abort signals through fetch mode", async () => {
    const server = startServer(async () => {
      // test-wait-justification: keeps the real local HTTP response pending so abort propagation wins the race
      await Bun.sleep(200);
      return new Response("hello", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      });
    });
    const tool = new Web();
    const controller = new AbortController();

    const promise = tool.call(
      "fetch",
      {
        url: `http://127.0.0.1:${server.port}/slow`,
        mode: "fetch",
      },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);

    await expect(promise).resolves.toMatchObject({
      isError: true,
      error: expect.stringMatching(/abort/i),
    });
  });

  it("rejects unsupported binary content types", async () => {
    const server = startServer(() => {
      return new Response("%PDF-1.7", {
        headers: {
          "content-type": "application/pdf",
        },
      });
    });
    const tool = new Web();

    await expect(
      tool.call("fetch", {
        url: `http://127.0.0.1:${server.port}/binary`,
        mode: "fetch",
      }),
    ).resolves.toMatchObject({
      isError: true,
      contentType: "application/pdf",
    });
  });

  it("rejects oversized responses before buffering them", async () => {
    const oversized = "x".repeat(5 * 1024 * 1024 + 10);
    const server = startServer(() => {
      return new Response(oversized, {
        headers: {
          "content-type": "text/plain",
        },
      });
    });
    const tool = new Web();

    await expect(
      tool.call("fetch", {
        url: `http://127.0.0.1:${server.port}/oversized`,
        mode: "fetch",
      }),
    ).resolves.toMatchObject({
      isError: true,
      error: expect.stringContaining("response too large"),
    });
  });

  it("falls back to simple extraction for large html pages", async () => {
    const repeatedScript = "<script>" + "x".repeat(800_000) + "</script>";
    const html = [
      "<!doctype html>",
      "<html><head><title>Large Page</title></head><body>",
      repeatedScript,
      "<main><h1>Important content</h1><p>Readable fallback text.</p></main>",
      "</body></html>",
    ].join("");
    const server = startServer(() => {
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      });
    });
    const tool = new Web();

    await expect(
      tool.call("fetch", {
        url: `http://127.0.0.1:${server.port}/large`,
        mode: "fetch",
        format: "text",
      }),
    ).resolves.toMatchObject({
      isError: false,
      title: "Large Page",
      content: expect.stringContaining("Important content"),
    });
  });

  it("auto returns direct markdown from fetch without extra fallbacks", async () => {
    const tool = new Web();
    stubWeb(tool, {
      refreshWebConfig: async () => {},
      webFetchDefaultMode: "auto",
      fetchPageContent: async () => ({
        isError: false,
        content: {
          url: "https://example.com",
          title: "Example",
          markdown: "# Hello",
          text: "# Hello",
          raw: "# Hello",
        },
        sourceTruncated: false,
      }),
      renderPageContent: async () => {
        throw new Error("browser fallback should not run");
      },
      extractPageContent: async () => {
        throw new Error("extract fallback should not run");
      },
    });

    await expect(
      tool.call("fetch", {
        url: "https://example.com",
        mode: "auto",
      }),
    ).resolves.toMatchObject({
      isError: false,
      title: "Example",
      content: "# Hello",
    });
  });

  it("auto escalates from weak fetched html to browser rendering", async () => {
    const tool = new Web();
    stubWeb(tool, {
      refreshWebConfig: async () => {},
      webFetchDefaultMode: "auto",
      fetchPageContent: async () => ({
        isError: false,
        content: {
          url: "https://example.com",
          title: "Example",
          markdown: "Loading...",
          text: "Loading...",
          raw: '<div id="__next">Loading...</div>',
        },
        rawHtml:
          '<html><body><div id="__next">Loading...</div><script>webpack</script></body></html>',
        sourceTruncated: false,
      }),
      renderPageContent: async () => ({
        isError: false,
        content: {
          url: "https://example.com",
          title: "Rendered Example",
          markdown:
            "Rendered article with useful details and enough substance to keep. It has several sentences and useful context for an agent.\n\nA second paragraph adds even more concrete information so the auto flow treats the rendered page as strong content.",
          text: "Rendered article with useful details and enough substance to keep. It has several sentences and useful context for an agent. A second paragraph adds even more concrete information so the auto flow treats the rendered page as strong content.",
          raw: "<article><p>Rendered article with useful details and enough substance to keep. It has several sentences and useful context for an agent.</p><p>A second paragraph adds even more concrete information so the auto flow treats the rendered page as strong content.</p></article>",
        },
        rawHtml:
          "<html><body><article><p>Rendered article with useful details and enough substance to keep. It has several sentences and useful context for an agent.</p><p>A second paragraph adds even more concrete information so the auto flow treats the rendered page as strong content.</p></article></body></html>",
      }),
      extractPageContent: async () => {
        throw new Error("extract fallback should not run");
      },
    });

    await expect(
      tool.call("fetch", {
        url: "https://example.com",
        mode: "auto",
        format: "text",
      }),
    ).resolves.toMatchObject({
      isError: false,
      title: "Rendered Example",
      content: expect.stringContaining("Rendered article"),
    });
  });

  it("auto escalates to extract after weak browser rendering", async () => {
    const tool = new Web();
    stubWeb(tool, {
      refreshWebConfig: async () => {},
      webFetchDefaultMode: "auto",
      fetchPageContent: async () => ({
        isError: false,
        content: {
          url: "https://example.com",
          title: "Example",
          markdown: "Loading...",
          text: "Loading...",
          raw: '<div id="__next">Loading...</div>',
        },
        rawHtml: '<html><body><div id="__next">Loading...</div></body></html>',
      }),
      renderPageContent: async () => ({
        isError: false,
        content: {
          url: "https://example.com",
          title: "Rendered Example",
          markdown: "Sign in",
          text: "Sign in",
          raw: "<main>Sign in</main>",
        },
        rawHtml: "<html><body><main>Sign in</main></body></html>",
      }),
      extractPageContent: async () => ({
        isError: false,
        content: {
          url: "https://example.com",
          title: "Extracted Example",
          markdown: "Useful extracted content from the provider.",
          text: "Useful extracted content from the provider.",
          raw: "Useful extracted content from the provider.",
        },
      }),
    });

    await expect(
      tool.call("fetch", {
        url: "https://example.com",
        mode: "auto",
      }),
    ).resolves.toMatchObject({
      isError: false,
      title: "Extracted Example",
      content: "Useful extracted content from the provider.",
    });
  });

  it("auto prefers parsed browser content when extract is unavailable", async () => {
    const tool = new Web();

    stubWeb(tool, {
      refreshWebConfig: async () => {},
      webFetchDefaultMode: "auto",
      fetchPageContent: async () => ({
        isError: false,
        content: {
          url: "https://example.com",
          title: "Example",
          markdown: "Loading...",
          text: "Loading...",
          raw: '<div id="__next">Loading...</div>',
        },
        rawHtml: '<html><body><div id="__next">Loading...</div></body></html>',
      }),
      renderPageContent: async () => ({
        isError: false,
        content: {
          url: "https://example.com",
          title: "Rendered Example",
          markdown:
            "![icon](data:image/svg+xml;base64,abc)\n\nPlay the kana quiz and review your progress.",
          text: "Play the kana quiz and review your progress.",
          raw: '<main><img src="data:image/svg+xml;base64,abc"><p>Play the kana quiz and review your progress.</p></main>',
        },
        rawHtml:
          '<html><body><main><img src="data:image/svg+xml;base64,abc"><p>Play the kana quiz and review your progress.</p></main></body></html>',
      }),
      extractPageContent: async () => ({
        isError: true,
        error: "web.extract is unavailable: no provider configured.",
      }),
    });

    await expect(
      tool.call("fetch", {
        url: "https://example.com",
        mode: "auto",
      }),
    ).resolves.toMatchObject({
      isError: false,
      title: "Rendered Example",
      content: expect.stringContaining("Play the kana quiz"),
    });
  });

  it("uses configured fetch mode when mode is omitted", async () => {
    const tool = new Web();
    stubWeb(tool, {
      refreshWebConfig: async function (this: Record<string, unknown>) {
        this.webFetchDefaultMode = "extract";
      },
      getPageExtract: async () => ({
        isError: false,
        title: "Configured Extract",
        content: "Configured extract content",
        length: 24,
        rearTruncated: false,
        sourceTruncated: false,
      }),
      getPageAuto: async () => {
        throw new Error("auto mode should not run");
      },
      getPageFetch: async () => {
        throw new Error("fetch mode should not run");
      },
      getPageBrowser: async () => {
        throw new Error("browser mode should not run");
      },
    });

    await expect(
      tool.call("fetch", {
        url: "https://example.com",
      }),
    ).resolves.toMatchObject({
      isError: false,
      title: "Configured Extract",
      content: "Configured extract content",
    });
  });

  it("uses configured provider-only mode when mode is omitted", async () => {
    const tool = new Web();
    stubWeb(tool, {
      refreshWebConfig: async function (this: Record<string, unknown>) {
        this.webFetchDefaultMode = "provider-only";
      },
      getPageProviderOnly: async () => ({
        isError: false,
        title: "Configured Provider",
        content: "Configured provider content",
        length: 25,
        rearTruncated: false,
        sourceTruncated: false,
      }),
      getPageAuto: async () => {
        throw new Error("auto mode should not run");
      },
      getPageFetch: async () => {
        throw new Error("fetch mode should not run");
      },
      getPageBrowser: async () => {
        throw new Error("browser mode should not run");
      },
      getPageExtract: async () => {
        throw new Error("extract mode should not run");
      },
    });

    await expect(
      tool.call("fetch", {
        url: "https://example.com",
      }),
    ).resolves.toMatchObject({
      isError: false,
      title: "Configured Provider",
      content: "Configured provider content",
    });
  });

  it("provider-only returns provider errors without browser fallback", async () => {
    const tool = new Web();
    stubWeb(tool, {
      refreshWebConfig: async () => {},
      extractPageContent: async () => ({
        isError: true,
        error: "provider unavailable",
      }),
      getPageBrowser: async () => {
        throw new Error("browser fallback should not run");
      },
    });

    await expect(
      tool.call("fetch", {
        url: "https://example.com",
        mode: "provider-only",
      }),
    ).resolves.toMatchObject({
      isError: true,
      error: "provider unavailable",
    });
  });

  it("extract html can fall through unsupported providers to Firecrawl", async () => {
    const tool = new Web();
    const calls: string[] = [];

    stubWeb(tool, {
      refreshWebConfig: async () => {},
      webSearchProviders: [
        { id: "tavily", isConfigured: () => true, search: async () => [] },
        { id: "firecrawl", isConfigured: () => true, search: async () => [] },
      ],
      extractPageContentWithProvider: async (providerId: string) => {
        calls.push(providerId);
        if (providerId === "tavily") {
          return {
            isError: true,
            error: "Tavily extract does not support format=html.",
          };
        }

        return {
          isError: false,
          content: {
            url: "https://example.com",
            title: "Firecrawl HTML",
            markdown: "Firecrawl HTML",
            text: "Firecrawl HTML",
            raw: "<main>Firecrawl HTML</main>",
          },
        };
      },
      getPageBrowser: async () => {
        throw new Error("browser fallback should not run");
      },
    });

    await expect(
      tool.call("fetch", {
        url: "https://example.com",
        mode: "extract",
        format: "html",
      }),
    ).resolves.toMatchObject({
      isError: false,
      title: "Firecrawl HTML",
      content: "<main>Firecrawl HTML</main>",
    });
    expect(calls).toEqual(["tavily", "firecrawl"]);
  });

  it("maps Firecrawl scrape payloads for html extraction", async () => {
    const server = startServer(async (req) => {
      expect(req.method).toBe("POST");
      expect(req.headers.get("authorization")).toBe("Bearer firecrawl-test-key");

      const body = (await req.json()) as Record<string, unknown>;
      expect(body.url).toBe("https://example.com/article");
      expect(body.formats).toEqual(["html"]);
      expect(body.timeout).toBe(10000);

      return new Response(
        JSON.stringify({
          success: true,
          data: {
            html: "<html><body><main>Rendered Firecrawl article</main></body></html>",
            metadata: {
              title: "Firecrawl Article",
              sourceURL: "https://example.com/final-article",
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });

    const mutableFirecrawlEnv = env.tools.web.firecrawl as {
      apiKey?: string;
      apiBaseUrl?: string;
    };
    mutableFirecrawlEnv.apiKey = "firecrawl-test-key";
    mutableFirecrawlEnv.apiBaseUrl = `http://127.0.0.1:${server.port}`;

    const tool = new Web();

    await expect(
      callExtractPageContentWithProvider(tool, "firecrawl", {
        url: "https://example.com/article",
        format: "html",
      }),
    ).resolves.toMatchObject({
      isError: false,
      content: {
        url: "https://example.com/final-article",
        title: "Firecrawl Article",
        raw: "<html><body><main>Rendered Firecrawl article</main></body></html>",
      },
    });
  });

  it("maps Firecrawl markdown to plain text for text extraction", async () => {
    const server = startServer(async () => {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            markdown: "# Firecrawl Article\n\n[Useful link](https://example.com)\n\n- Bullet point",
            metadata: {
              title: "Firecrawl Text Article",
              sourceURL: "https://example.com/text-article",
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });

    const mutableFirecrawlEnv = env.tools.web.firecrawl as {
      apiKey?: string;
      apiBaseUrl?: string;
    };
    mutableFirecrawlEnv.apiKey = "firecrawl-test-key";
    mutableFirecrawlEnv.apiBaseUrl = `http://127.0.0.1:${server.port}`;

    const tool = new Web();

    await expect(
      callExtractPageContentWithProvider(tool, "firecrawl", {
        url: "https://example.com/article",
        format: "text",
      }),
    ).resolves.toMatchObject({
      isError: false,
      content: {
        url: "https://example.com/text-article",
        title: "Firecrawl Text Article",
        text: "Firecrawl Article Useful link Bullet point",
        markdown: "# Firecrawl Article\n\n[Useful link](https://example.com)\n\n- Bullet point",
      },
    });
  });

  it("preserves sourceTruncated for Exa extract when content is capped by budget", async () => {
    const tool = new Web();
    const extractedText = "x".repeat(50_000);

    stubWeb(tool, {
      refreshWebConfig: async () => {},
      webSearchProviders: [{ id: "exa", isConfigured: () => true, search: async () => [] }],
      getExaClient: () => ({
        getContents: async () => ({
          results: [
            {
              url: "https://example.com",
              title: "Example",
              text: extractedText,
            },
          ],
        }),
      }),
    });

    await expect(
      tool.call("fetch", {
        url: "https://example.com",
        mode: "extract",
        maxCharacters: 60_000,
      }),
    ).resolves.toMatchObject({
      isError: false,
      title: "Example",
      length: 50_000,
      sourceTruncated: true,
    });
  });

  it("applies timeout to Exa extract mode", async () => {
    const tool = new Web();

    stubWeb(tool, {
      refreshWebConfig: async () => {},
      webSearchProviders: [{ id: "exa", isConfigured: () => true, search: async () => [] }],
      getExaClient: () => ({
        getContents: async () => {
          // test-wait-justification: keeps the fake Exa request pending beyond the configured extract timeout
          await Bun.sleep(50);
          return {
            results: [
              {
                url: "https://example.com",
                title: "Example",
                text: "slow",
              },
            ],
          };
        },
      }),
    });

    await expect(
      callExtractPageContent(tool, {
        url: "https://example.com",
        timeout: 10,
      }),
    ).resolves.toMatchObject({
      isError: true,
      error: expect.stringMatching(/abort|timeout|timed out/i),
    });
  });

  it("falls back to the next search provider on retriable errors", async () => {
    const tool = new Web();
    const calls: string[] = [];

    stubWeb(tool, {
      refreshWebConfig: async () => {},
      webSearchProviders: [
        {
          id: "tavily",
          isConfigured: () => true,
          search: async () => {
            calls.push("tavily");
            throw new Error("credits exhausted for current billing period");
          },
        },
        {
          id: "exa",
          isConfigured: () => true,
          search: async () => {
            calls.push("exa");
            return [
              {
                url: "https://example.com",
                title: "Example",
                content: "Recovered from fallback provider.",
                score: null,
              },
            ];
          },
        },
      ],
    });

    await expect(tool.call("search", { query: "fallback test" })).resolves.toEqual([
      {
        url: "https://example.com",
        title: "Example",
        content: "Recovered from fallback provider.",
        score: null,
      },
    ]);
    expect(calls).toEqual(["tavily", "exa"]);
  });

  it("does not fall back on non-retriable search errors", async () => {
    const tool = new Web();
    const calls: string[] = [];

    stubWeb(tool, {
      refreshWebConfig: async () => {},
      webSearchProviders: [
        {
          id: "tavily",
          isConfigured: () => true,
          search: async () => {
            calls.push("tavily");
            throw new Error("401 unauthorized");
          },
        },
        {
          id: "exa",
          isConfigured: () => true,
          search: async () => {
            calls.push("exa");
            return [];
          },
        },
      ],
    });

    await expect(tool.call("search", { query: "no retry" })).resolves.toMatchObject({
      isError: true,
      error: "401 unauthorized",
    });
    expect(calls).toEqual(["tavily"]);
  });

  it("falls back to the next extract provider on retriable errors", async () => {
    const tool = new Web();
    const calls: string[] = [];

    stubWeb(tool, {
      refreshWebConfig: async () => {},
      webSearchProviders: [
        { id: "tavily", isConfigured: () => true, search: async () => [] },
        { id: "exa", isConfigured: () => true, search: async () => [] },
      ],
      getTavilyClient: () => ({
        extract: async () => {
          calls.push("tavily");
          throw new Error("credits exhausted for current billing period");
        },
      }),
      getExaClient: () => ({
        getContents: async () => {
          calls.push("exa");
          return {
            results: [
              {
                url: "https://example.com",
                title: "Example",
                text: "Recovered from fallback provider.",
              },
            ],
          };
        },
      }),
      getPageBrowser: async () => {
        throw new Error("browser fallback should not run");
      },
    });

    await expect(
      tool.call("fetch", {
        url: "https://example.com",
        mode: "extract",
      }),
    ).resolves.toMatchObject({
      isError: false,
      title: "Example",
      content: "Recovered from fallback provider.",
    });
    expect(calls).toEqual(["tavily", "exa"]);
  });

  it("falls back to the next extract provider on timeout errors", async () => {
    const tool = new Web();
    const calls: string[] = [];

    stubWeb(tool, {
      refreshWebConfig: async () => {},
      webSearchProviders: [
        { id: "exa", isConfigured: () => true, search: async () => [] },
        { id: "tavily", isConfigured: () => true, search: async () => [] },
      ],
      getExaClient: () => ({
        getContents: async () => {
          calls.push("exa");
          // test-wait-justification: makes the first extract provider exceed its timeout so fallback is exercised
          await Bun.sleep(50);
          return { results: [] };
        },
      }),
      getTavilyClient: () => ({
        extract: async () => {
          calls.push("tavily");
          return {
            results: [
              {
                url: "https://example.com",
                title: "Example",
                rawContent: "Recovered after timeout fallback.",
              },
            ],
          };
        },
      }),
      getPageBrowser: async () => {
        throw new Error("browser fallback should not run");
      },
    });

    await expect(
      tool.call("fetch", {
        url: "https://example.com",
        mode: "extract",
        timeout: 10,
      }),
    ).resolves.toMatchObject({
      isError: false,
      title: "Example",
      content: "Recovered after timeout fallback.",
    });
    expect(calls).toEqual(["exa", "tavily"]);
  });

  it("queues Firecrawl search calls and falls back when the queue TTL expires", async () => {
    jest.useFakeTimers({ now: 0 });
    const tool = new Web();
    const pool = new FirecrawlPermitPool("search");
    pool.configure({ maxConcurrency: 2, queueTtlMs: 3_000 });
    const twoStarted = deferred();
    const releaseActive = deferred();
    const thirdAcquireStarted = deferred();
    let firecrawlCalls = 0;
    let exaCalls = 0;
    let acquisitions = 0;
    const acquire = pool.acquire.bind(pool);
    pool.acquire = (signal) => {
      acquisitions += 1;
      if (acquisitions === 3) thirdAcquireStarted.resolve();
      return acquire(signal);
    };

    stubWeb(tool, {
      refreshWebConfig: async () => {},
      firecrawlSearchPermits: pool,
      webSearchProviders: [
        {
          id: "firecrawl",
          isConfigured: () => true,
          search: async () => {
            firecrawlCalls += 1;
            if (firecrawlCalls === 2) twoStarted.resolve();
            await releaseActive.promise;
            return [];
          },
        },
        {
          id: "exa",
          isConfigured: () => true,
          search: async () => {
            exaCalls += 1;
            return [
              {
                url: "https://example.com/fallback",
                title: "Fallback",
                content: "Search fallback",
                score: null,
              },
            ];
          },
        },
      ],
    });

    const first = tool.call("search", { query: "first" });
    const second = tool.call("search", { query: "second" });
    await twoStarted.promise;

    const third = tool.call("search", { query: "third" });
    await thirdAcquireStarted.promise;
    jest.advanceTimersByTime(3_000);

    await expect(third).resolves.toEqual([
      {
        url: "https://example.com/fallback",
        title: "Fallback",
        content: "Search fallback",
        score: null,
      },
    ]);
    expect(firecrawlCalls).toBe(2);
    expect(exaCalls).toBe(1);

    releaseActive.resolve();
    await Promise.all([first, second]);
  });

  it("shares Firecrawl permit pools across Web instances", () => {
    const first = new Web() as unknown as Record<string, unknown>;
    const second = new Web() as unknown as Record<string, unknown>;

    expect(first.firecrawlFetchPermits).toBe(second.firecrawlFetchPermits);
    expect(first.firecrawlSearchPermits).toBe(second.firecrawlSearchPermits);
  });

  it("preserves the active Firecrawl policy when config refresh fails", async () => {
    const tool = new Web();
    const fetchPool = new FirecrawlPermitPool("fetch");
    const searchPool = new FirecrawlPermitPool("search");
    fetchPool.configure({ maxConcurrency: 1, queueTtlMs: 3_000 });
    searchPool.configure({ maxConcurrency: 1, queueTtlMs: 3_000 });
    const active = (await fetchPool.acquire()).match({
      ok: (permit) => permit,
      err: (error) => {
        throw new Error(error.message);
      },
    });
    let queuedAdmitted = false;
    const queued = fetchPool.acquire().then((result) =>
      result.match({
        ok: (permit) => {
          queuedAdmitted = true;
          return permit;
        },
        err: (error) => {
          throw new Error(error.message);
        },
      }),
    );

    stubWeb(tool, {
      firecrawlFetchPermits: fetchPool,
      firecrawlSearchPermits: searchPool,
      loadWebToolConfigFromCoreConfig: async () => {
        throw new Error("config unavailable");
      },
    });
    const refresh = tool as unknown as { refreshWebConfig(): Promise<void> };
    await refresh.refreshWebConfig();
    await Promise.resolve();
    expect(queuedAdmitted).toBe(false);

    active.release();
    const admitted = await queued;
    admitted.release();
  });

  it("does not call Firecrawl or a fallback provider for an aborted search waiter", async () => {
    const tool = new Web();
    const pool = new FirecrawlPermitPool("search");
    pool.configure({ maxConcurrency: 1, queueTtlMs: 3_000 });
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const secondAcquireStarted = deferred();
    let firecrawlCalls = 0;
    let exaCalls = 0;
    let acquisitions = 0;
    const acquire = pool.acquire.bind(pool);
    pool.acquire = (signal) => {
      acquisitions += 1;
      if (acquisitions === 2) secondAcquireStarted.resolve();
      return acquire(signal);
    };

    stubWeb(tool, {
      refreshWebConfig: async () => {},
      firecrawlSearchPermits: pool,
      webSearchProviders: [
        {
          id: "firecrawl",
          isConfigured: () => true,
          search: async () => {
            firecrawlCalls += 1;
            firstStarted.resolve();
            await releaseFirst.promise;
            return [];
          },
        },
        {
          id: "exa",
          isConfigured: () => true,
          search: async () => {
            exaCalls += 1;
            return [];
          },
        },
      ],
    });

    const first = tool.call("search", { query: "first" });
    await firstStarted.promise;

    const controller = new AbortController();
    const second = tool.call("search", { query: "second" }, { signal: controller.signal });
    await secondAcquireStarted.promise;
    controller.abort();

    await expect(second).resolves.toMatchObject({
      isError: true,
      error: expect.stringMatching(/aborted/i),
    });
    expect(firecrawlCalls).toBe(1);
    expect(exaCalls).toBe(0);

    releaseFirst.resolve();
    await first;
  });

  it("does not enter browser fallback for an aborted Firecrawl fetch waiter", async () => {
    const mutableFirecrawlEnv = env.tools.web.firecrawl as {
      apiKey?: string;
      apiBaseUrl?: string;
    };
    mutableFirecrawlEnv.apiKey = "firecrawl-test-key";

    const tool = new Web();
    const pool = new FirecrawlPermitPool("fetch");
    pool.configure({ maxConcurrency: 1, queueTtlMs: 3_000 });
    const active = (await pool.acquire()).match({
      ok: (permit) => permit,
      err: (error) => {
        throw new Error(error.message);
      },
    });
    const queuedAcquireStarted = deferred();
    let acquisitions = 1;
    const acquire = pool.acquire.bind(pool);
    pool.acquire = (signal) => {
      acquisitions += 1;
      if (acquisitions === 2) queuedAcquireStarted.resolve();
      return acquire(signal);
    };
    let browserCalls = 0;

    stubWeb(tool, {
      refreshWebConfig: async () => {},
      firecrawlFetchPermits: pool,
      webSearchProviders: [{ id: "firecrawl", isConfigured: () => true, search: async () => [] }],
      getPageBrowser: async () => {
        browserCalls += 1;
        return { isError: true, error: "browser fallback ran" };
      },
    });

    const controller = new AbortController();
    const request = tool.call(
      "fetch",
      {
        url: "https://example.com/queued",
        mode: "extract",
      },
      { signal: controller.signal },
    );
    await queuedAcquireStarted.promise;
    controller.abort();

    await expect(request).resolves.toMatchObject({
      isError: true,
      error: expect.stringMatching(/aborted/i),
    });
    expect(browserCalls).toBe(0);

    active.release();
  });

  it("queues Firecrawl fetch calls and falls back when the queue TTL expires", async () => {
    jest.useFakeTimers({ now: 0 });
    const requestsStarted = deferred();
    const releaseRequests = deferred();
    let firecrawlRequests = 0;
    const server = startServer(async () => {
      firecrawlRequests += 1;
      if (firecrawlRequests === 2) requestsStarted.resolve();
      await releaseRequests.promise;
      return Response.json({
        success: true,
        data: {
          markdown: "Firecrawl content",
          metadata: { sourceURL: "https://example.com/firecrawl" },
        },
      });
    });

    const mutableFirecrawlEnv = env.tools.web.firecrawl as {
      apiKey?: string;
      apiBaseUrl?: string;
    };
    mutableFirecrawlEnv.apiKey = "firecrawl-test-key";
    mutableFirecrawlEnv.apiBaseUrl = `http://127.0.0.1:${server.port}`;

    const tool = new Web();
    const pool = new FirecrawlPermitPool("fetch");
    pool.configure({ maxConcurrency: 2, queueTtlMs: 3_000 });
    const thirdAcquireStarted = deferred();
    let acquisitions = 0;
    const acquire = pool.acquire.bind(pool);
    pool.acquire = (signal) => {
      acquisitions += 1;
      if (acquisitions === 3) thirdAcquireStarted.resolve();
      return acquire(signal);
    };

    stubWeb(tool, {
      refreshWebConfig: async () => {},
      firecrawlFetchPermits: pool,
      webSearchProviders: [
        { id: "firecrawl", isConfigured: () => true, search: async () => [] },
        { id: "tavily", isConfigured: () => true, search: async () => [] },
      ],
      getTavilyClient: () => ({
        extract: async () => ({
          results: [
            {
              url: "https://example.com/fallback",
              title: "Fallback",
              rawContent: "Fetch fallback",
            },
          ],
        }),
      }),
    });

    const first = tool.call("fetch", {
      url: "https://example.com/first",
      mode: "provider-only",
    });
    const second = tool.call("fetch", {
      url: "https://example.com/second",
      mode: "provider-only",
    });
    await requestsStarted.promise;

    const third = tool.call("fetch", {
      url: "https://example.com/third",
      mode: "provider-only",
    });
    await thirdAcquireStarted.promise;
    jest.advanceTimersByTime(3_000);

    await expect(third).resolves.toMatchObject({
      isError: false,
      title: "Fallback",
      content: "Fetch fallback",
    });
    expect(firecrawlRequests).toBe(2);

    releaseRequests.resolve();
    await Promise.all([first, second]);
  });
});
