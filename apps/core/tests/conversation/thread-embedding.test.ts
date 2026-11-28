import { describe, expect, it } from "bun:test";

import { createConversationThreadEmbeddingAdapterResolver } from "../../src/conversation/thread-embedding";

describe("separate query embeddings", () => {
  it("routes queries separately while retaining document identity and refreshing config", async () => {
    const { env, getModelProviders, providers, parseCoreConfigV2ToUniversal } =
      await import("@stanley2058/lilac-utils");
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json();
        requests.push(body.model);
        return Response.json({
          data: [{ index: 0, embedding: [1, 0] }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      },
    });
    const original = providers["openai-compatible"];
    const originalConfig = env.providers.openaiCompatible;
    try {
      Object.assign(env.providers, {
        openaiCompatible: { baseUrl: `${server.url}v1`, apiKey: undefined },
      });
      providers["openai-compatible"] = getModelProviders()["openai-compatible"];
      const cfg = parseCoreConfigV2ToUniversal({
        configVersion: 2,
        conversation: {
          thread: {
            embedding: {
              enabled: true,
              model: "openai-compatible/voyage-4-nano-document",
              queryModel: "openai-compatible/voyage-4-nano-query",
            },
          },
        },
      });
      const resolve = createConversationThreadEmbeddingAdapterResolver(async () => cfg);
      const adapter = (await resolve())!;
      expect(adapter.modelId).toBe("openai-compatible/voyage-4-nano-document");
      expect(await resolve()).toBe(adapter);
      const usage: string[] = [];
      await adapter.embed({
        text: "find this",
        facet: "query",
        onUsage: (event) => usage.push(event.modelId),
      });
      await adapter.embed({
        text: "saved summary",
        facet: "brief",
        onUsage: (event) => usage.push(event.modelId),
      });
      expect(requests).toEqual(["voyage-4-nano-query", "voyage-4-nano-document"]);
      expect(usage).toEqual(requests);
      delete cfg.conversation.thread.embedding.queryModel;
      const fallback = (await resolve())!;
      expect(fallback).not.toBe(adapter);
      expect(fallback.modelId).toBe(adapter.modelId);
      await fallback.embed({ text: "find again", facet: "query" });
      expect(requests.at(-1)).toBe("voyage-4-nano-document");
      cfg.conversation.thread.embedding.queryModel = "missing-alias";
      expect(await resolve()).toBeNull();
    } finally {
      Object.assign(env.providers, { openaiCompatible: originalConfig });
      providers["openai-compatible"] = original;
      await server.stop(true);
    }
  });
});

it("keeps named document/query endpoints and their embedding methods through config replacement", async () => {
  const { parseCoreConfigV3ToUniversal } = await import("@stanley2058/lilac-utils");
  const requests: { path: string; model: string; authorization: string | null }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      requests.push({
        path: new URL(request.url).pathname,
        model: body.model,
        authorization: request.headers.get("authorization"),
      });
      return Response.json({
        data: [{ index: 0, embedding: [1, 0] }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    },
  });
  const originalKey = process.env.LILAC_TEST_NAMED_EMBED_KEY;
  process.env.LILAC_TEST_NAMED_EMBED_KEY = "document-test-key";
  const config = (path: string) =>
    parseCoreConfigV3ToUniversal({
      configVersion: 3,
      models: {
        providers: {
          openaiCompatible: {
            documents: {
              baseUrl: `${server.url}${path}/v1`,
              apiKeyEnv: "LILAC_TEST_NAMED_EMBED_KEY",
            },
            queries: { baseUrl: `${server.url}queries/v1` },
          },
        },
      },
      conversation: {
        thread: {
          embedding: {
            enabled: true,
            model: "openai-compatible/documents/team/embed",
            queryModel: "openai-compatible/queries/query-embed",
          },
        },
      },
    });
  let cfg = config("documents");
  try {
    const resolve = createConversationThreadEmbeddingAdapterResolver(async () => cfg);
    const first = (await resolve())!;
    expect(await resolve()).toBe(first);
    expect(first.modelId).toBe("openai-compatible/documents/team/embed");
    expect(await first.embed({ text: "doc", facet: "brief" })).toEqual(new Float32Array([1, 0]));
    await first.embed({ text: "query", facet: "query" });
    cfg = config("replacement");
    const second = (await resolve())!;
    expect(second).not.toBe(first);
    await second.embed({ text: "new doc", facet: "brief" });
    expect(requests).toEqual([
      {
        path: "/documents/v1/embeddings",
        model: "team/embed",
        authorization: "Bearer document-test-key",
      },
      { path: "/queries/v1/embeddings", model: "query-embed", authorization: null },
      {
        path: "/replacement/v1/embeddings",
        model: "team/embed",
        authorization: "Bearer document-test-key",
      },
    ]);
  } finally {
    if (originalKey === undefined) delete process.env.LILAC_TEST_NAMED_EMBED_KEY;
    else process.env.LILAC_TEST_NAMED_EMBED_KEY = originalKey;
    server.stop(true);
  }
});
