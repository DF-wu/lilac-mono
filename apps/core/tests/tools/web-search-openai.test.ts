import { afterEach, describe, expect, it } from "bun:test";

import {
  OpenAIWebSearchProvider,
  TavilyWebSearchProvider,
  resolveWebSearchProvider,
  webSearchInputSchema,
} from "../../src/tool-server/tools/web-search";
import {
  buildOpenAIWebSearchInstructions,
  collectOpenAIWebSearchResults,
  decodeOpenAIWebSearchResponse,
  normalizeCitedUrl,
  stripCitationMarkers,
} from "../../src/tool-server/tools/web-search/openai-web-search-provider";

const servers: Array<{ stop(force?: boolean): void }> = [];

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.stop(true);
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type CapturedRequest = { headers: Headers; body: unknown; pathname: string };

function startResponsesServer(
  respond: (request: CapturedRequest) => Response | Promise<Response>,
): { url: string; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const captured = {
        headers: req.headers,
        body: (await req.json()) as unknown,
        pathname: new URL(req.url).pathname,
      };
      requests.push(captured);
      return respond(captured);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/v1`, requests };
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

const firstParagraph =
  "Bun 1.3 shipped in September. ([bun.sh](https://bun.sh/blog/bun-v1.3?utm_source=openai))";
const secondParagraph =
  "It adds a new bundler mode. ([github.com](https://github.com/oven-sh/bun/releases), [bun.sh](https://bun.sh/blog/bun-v1.3?utm_source=openai))";
const answerText = `${firstParagraph}\n\n${secondParagraph}`;
const firstMarkerStart = firstParagraph.indexOf("([");
const secondMarkerStart = answerText.lastIndexOf("([");

function completedResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_1",
    status: "completed",
    output: [
      {
        type: "web_search_call",
        id: "ws_1",
        status: "completed",
        action: {
          type: "search",
          query: "bun 1.3 release",
          sources: [
            { type: "url", url: "https://bun.sh/blog/bun-v1.3" },
            { type: "url", url: "https://example.com/uncited" },
          ],
        },
      },
      { type: "reasoning", id: "rs_1", summary: [] },
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: answerText,
            annotations: [
              {
                type: "url_citation",
                url: "https://bun.sh/blog/bun-v1.3?utm_source=openai",
                title: "Bun v1.3",
                start_index: firstMarkerStart,
                end_index: firstParagraph.length,
              },
              {
                type: "url_citation",
                url: "https://github.com/oven-sh/bun/releases",
                title: "Releases",
                start_index: secondMarkerStart,
                end_index: answerText.length,
              },
              {
                type: "url_citation",
                url: "https://bun.sh/blog/bun-v1.3?utm_source=openai",
                title: "Bun v1.3 (duplicate)",
                start_index: secondMarkerStart,
                end_index: answerText.length,
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("web-search (openai)", () => {
  it("is configured only when an API key is present", () => {
    expect(new OpenAIWebSearchProvider({}).isConfigured()).toBe(false);
    expect(new OpenAIWebSearchProvider({ apiKey: "" }).isConfigured()).toBe(false);
    expect(new OpenAIWebSearchProvider({ apiKey: "sk-test" }).isConfigured()).toBe(true);
  });

  it("resolveWebSearchProvider reports the OpenAI key when it is the only requested provider", () => {
    const resolved = resolveWebSearchProvider({
      requested: "openai",
      providers: [new OpenAIWebSearchProvider({}), new TavilyWebSearchProvider({})],
    });

    expect(resolved.providers).toEqual([]);
    expect(resolved.error).toBe(
      "web.search is unavailable: OPENAI_API_KEY is not configured (set env var OPENAI_API_KEY).",
    );
  });

  it("sends a forced web_search Responses request and maps citations before uncited sources", async () => {
    const server = startResponsesServer(() => json(completedResponse()));
    const provider = new OpenAIWebSearchProvider({
      apiKey: "sk-test",
      baseUrl: `${server.url}/`,
      model: "gpt-5-mini",
      searchContextSize: "high",
    });

    const results = await provider.search(
      webSearchInputSchema.parse({ query: "bun 1.3 release", topic: "news", timeRange: "week" }),
    );

    expect(server.requests).toHaveLength(1);
    const request = server.requests[0]!;
    expect(request.pathname).toBe("/v1/responses");
    expect(request.headers.get("authorization")).toBe("Bearer sk-test");
    expect(request.headers.get("content-type")).toBe("application/json");
    if (!isRecord(request.body)) throw new Error("expected JSON body");
    expect(request.body).toMatchObject({
      model: "gpt-5-mini",
      tools: [{ type: "web_search", search_context_size: "high" }],
      tool_choice: "required",
      include: ["web_search_call.action.sources"],
      store: false,
    });
    expect(request.body.input).toBe(
      [
        "Search the web for the query below and answer it briefly.",
        "Cite every source you rely on, and use up to 8 distinct sources.",
        "Prefer recent news coverage.",
        "Only rely on sources published within the last week.",
        "",
        "Query: bun 1.3 release",
      ].join("\n"),
    );

    expect(results).toEqual([
      {
        url: "https://bun.sh/blog/bun-v1.3",
        title: "Bun v1.3",
        content:
          "OpenAI-generated summary (may combine cited sources): Bun 1.3 shipped in September.",
        score: null,
      },
      {
        url: "https://github.com/oven-sh/bun/releases",
        title: "Releases",
        content:
          "OpenAI-generated summary (may combine cited sources): It adds a new bundler mode.",
        score: null,
      },
      {
        url: "https://example.com/uncited",
        title: "https://example.com/uncited",
        content: "",
        score: null,
      },
    ]);
  });

  it("labels a paragraph citing multiple URLs as generated synthesis for each result", async () => {
    const text =
      "Source A reports a release; source B reports the rollout. ([a](https://a.example), [b](https://b.example))";
    const markerStart = text.indexOf("([a]");
    const server = startResponsesServer(() =>
      json({
        status: "completed",
        output: [
          { type: "web_search_call", status: "completed", action: { sources: [] } },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text,
                annotations: [
                  {
                    type: "url_citation",
                    url: "https://a.example",
                    start_index: markerStart,
                    end_index: text.length,
                  },
                  {
                    type: "url_citation",
                    url: "https://b.example",
                    start_index: markerStart,
                    end_index: text.length,
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const provider = new OpenAIWebSearchProvider({ apiKey: "sk-test", baseUrl: server.url });

    const results = await provider.search(webSearchInputSchema.parse({ query: "release" }));
    expect(results.map((result) => result.url)).toEqual(["https://a.example", "https://b.example"]);
    expect(results.map((result) => result.content)).toEqual([
      "OpenAI-generated summary (may combine cited sources): Source A reports a release; source B reports the rollout.",
      "OpenAI-generated summary (may combine cited sources): Source A reports a release; source B reports the rollout.",
    ]);
  });

  it("caps results at maxResults and falls back to the default model and context size", async () => {
    const server = startResponsesServer(() => json(completedResponse()));
    const provider = new OpenAIWebSearchProvider({ apiKey: "sk-test", baseUrl: server.url });

    const results = await provider.search(
      webSearchInputSchema.parse({ query: "bun", maxResults: 1 }),
    );

    expect(results.map((result) => result.url)).toEqual(["https://bun.sh/blog/bun-v1.3"]);
    const body = server.requests[0]?.body;
    if (!isRecord(body)) throw new Error("expected JSON body");
    expect(body.model).toBe("gpt-5-mini");
    expect(body.tools).toEqual([{ type: "web_search", search_context_size: "medium" }]);
  });

  it("returns an empty list when the model neither cited nor retrieved sources", async () => {
    const server = startResponsesServer(() =>
      json({
        status: "completed",
        output: [
          { type: "web_search_call", status: "completed", action: { sources: [] } },
          {
            type: "message",
            content: [{ type: "output_text", text: "No idea.", annotations: [] }],
          },
        ],
      }),
    );
    const provider = new OpenAIWebSearchProvider({ apiKey: "sk-test", baseUrl: server.url });

    expect(await provider.search(webSearchInputSchema.parse({ query: "x" }))).toEqual([]);
  });

  it("surfaces API error envelopes with the HTTP status", async () => {
    const server = startResponsesServer(() =>
      json(
        { error: { message: "Rate limit reached for gpt-5-mini", type: "requests", code: null } },
        { status: 429, statusText: "Too Many Requests" },
      ),
    );
    const provider = new OpenAIWebSearchProvider({ apiKey: "sk-test", baseUrl: server.url });

    await expect(provider.search(webSearchInputSchema.parse({ query: "x" }))).rejects.toThrow(
      "OpenAI web search failed (429): Rate limit reached for gpt-5-mini",
    );
  });

  it("rejects failed, incomplete, and malformed responses", async () => {
    const payloads: unknown[] = [
      { status: "failed", error: { message: "server_error: boom", code: "server_error" } },
      { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] },
      { output: "not-an-array" },
      {},
      { status: "queued", output: [{ type: "web_search_call", action: { sources: [] } }] },
      { status: "completed", output: [{ type: "reasoning", summary: [] }] },
      { status: "completed", output: [] },
    ];
    const server = startResponsesServer(() => json(payloads.shift()));
    const provider = new OpenAIWebSearchProvider({ apiKey: "sk-test", baseUrl: server.url });
    const input = webSearchInputSchema.parse({ query: "x" });

    await expect(provider.search(input)).rejects.toThrow(
      "OpenAI web search failed (200): server_error: boom",
    );
    await expect(provider.search(input)).rejects.toThrow(
      "OpenAI web search failed (200): response incomplete (max_output_tokens).",
    );
    await expect(provider.search(input)).rejects.toThrow(
      "OpenAI web search failed (200): invalid response contract.",
    );
    for (let i = 0; i < 4; i++) {
      await expect(provider.search(input)).rejects.toThrow(
        "OpenAI web search failed (200): invalid response contract.",
      );
    }
  });

  it("rejects when no API key is configured", async () => {
    const provider = new OpenAIWebSearchProvider({});
    await expect(provider.search(webSearchInputSchema.parse({ query: "x" }))).rejects.toThrow(
      "OPENAI_API_KEY is not configured.",
    );
  });

  it("aborts an in-flight request", async () => {
    const server = startResponsesServer(
      () => new Promise<Response>(() => undefined) /* never resolves */,
    );
    const provider = new OpenAIWebSearchProvider({ apiKey: "sk-test", baseUrl: server.url });
    const controller = new AbortController();
    const pending = provider.search(webSearchInputSchema.parse({ query: "x" }), {
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("describes explicit date bounds and finance topics in the instructions", () => {
    const text = buildOpenAIWebSearchInstructions(
      webSearchInputSchema.parse({
        query: "nvidia earnings",
        topic: "finance",
        startDate: "2026-01-01",
        endDate: "2026-03-31",
        maxResults: 3,
      }),
    );
    expect(text).toContain("use up to 3 distinct sources.");
    expect(text).toContain("Prefer financial and market sources.");
    expect(text).toContain("Only rely on sources published between 2026-01-01 and 2026-03-31.");
  });

  it("strips citation markers and the utm_source=openai tag", () => {
    expect(
      stripCitationMarkers(
        "Bun 1.4.2 is out.  ([bun.sh](https://bun.sh/?utm_source=openai)) More text ([a](https://a.example), [b](https://b.example)).",
      ),
    ).toBe("Bun 1.4.2 is out. More text.");
    expect(normalizeCitedUrl("https://bun.sh/blog/x?utm_source=openai")).toBe(
      "https://bun.sh/blog/x",
    );
    expect(normalizeCitedUrl("https://bun.sh/blog/x?a=1&utm_source=openai&b=2")).toBe(
      "https://bun.sh/blog/x?a=1&b=2",
    );
    expect(normalizeCitedUrl("https://bun.sh/blog/x?utm_source=other")).toBe(
      "https://bun.sh/blog/x?utm_source=other",
    );
    expect(normalizeCitedUrl("not a url")).toBe("not a url");
  });

  it("ignores unknown annotation and output item types when collecting results", () => {
    const decoded = decodeOpenAIWebSearchResponse({
      status: "completed",
      output: [
        { type: "file_search_call", id: "fs" },
        { type: "web_search_call", action: { sources: [] } },
        {
          type: "message",
          content: [
            { type: "refusal", refusal: "no" },
            {
              type: "output_text",
              text: "abc",
              annotations: [
                { type: "file_citation", file_id: "f" },
                { type: "url_citation", url: "https://a.example", start_index: 5, end_index: 2 },
              ],
            },
          ],
        },
      ],
    });
    const payload = decoded.match({
      ok: (value) => {
        if (value.kind !== "completed") throw new Error("expected completed response");
        return value.payload;
      },
      err: (error) => {
        throw new Error(error.message);
      },
    });

    expect(collectOpenAIWebSearchResults(payload, 8)).toEqual([
      { url: "https://a.example", title: "https://a.example", content: "", score: null },
    ]);
  });
});
