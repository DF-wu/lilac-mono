import { describe, expect, it } from "bun:test";
import { Panic } from "better-result";
import { ZodError } from "zod";

import {
  WEBFETCH_MAX_RESPONSE_BYTES,
  createWebfetchTool,
  decodeWebfetchInput,
  executeWebfetch,
  executeWebfetchResult,
  webfetchInputSchema,
  webfetchOutputSchema,
} from "../src/webfetch";
import {
  MiniLilacStoreOperationRejected as ExportedMiniLilacStoreOperationRejected,
  WorkspaceHistoryCleanupFailed as ExportedWorkspaceHistoryCleanupFailed,
  WorkspaceHistoryOperationAndCleanupFailed as ExportedWorkspaceHistoryOperationAndCleanupFailed,
  createWorkspaceHistoryStore as exportedCreateWorkspaceHistoryStore,
  decodeStoredHistoryNavigationResult as exportedDecodeStoredHistoryNavigationResult,
  executeWebfetch as exportedExecuteWebfetch,
  executeWebfetchResult as exportedExecuteWebfetchResult,
} from "../src/index";
import {
  MiniLilacStoreOperationRejected,
  decodeStoredHistoryNavigationResult,
} from "../src/sqlite-store";
import {
  WorkspaceHistoryCleanupFailed,
  WorkspaceHistoryOperationAndCleanupFailed,
  createWorkspaceHistoryStore,
} from "../src/workspace-history-store";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }] as const;

function decodedInput(rawInput: unknown) {
  const decoded = decodeWebfetchInput(rawInput);
  expect(decoded.status).toBe("ok");
  if (decoded.status === "error") throw decoded.error;
  return decoded.value;
}

async function executeOk(
  rawInput: unknown,
  options: Parameters<typeof executeWebfetchResult>[1] = {},
  dependencies: Parameters<typeof executeWebfetchResult>[2] = {},
) {
  const result = await executeWebfetchResult(decodedInput(rawInput), options, dependencies);
  expect(result.status).toBe("ok");
  if (result.status === "error") throw result.error;
  return result.value;
}

async function executeError(
  rawInput: unknown,
  options: Parameters<typeof executeWebfetchResult>[1] = {},
  dependencies: Parameters<typeof executeWebfetchResult>[2] = {},
) {
  const result = await executeWebfetchResult(decodedInput(rawInput), options, dependencies);
  expect(result.status).toBe("error");
  if (result.status === "ok") throw new Error("expected webfetch failure");
  return result.error;
}

describe("Mini Lilac webfetch", () => {
  it("applies bounded defaults and rejects non-HTTP URLs and credentials", async () => {
    expect(webfetchInputSchema.parse({ url: "https://example.com" })).toEqual({
      url: "https://example.com",
      format: "markdown",
      timeoutMs: 30_000,
      maxCharacters: 50_000,
    });
    expect(() => webfetchInputSchema.parse({ url: "file:///etc/passwd" })).toThrow();
    expect(() => webfetchInputSchema.parse({ url: "ftp://example.com/file" })).toThrow();
    expect(() => webfetchInputSchema.parse({ url: "https://user:secret@example.com" })).toThrow(
      "credentials",
    );
    expect(() => webfetchInputSchema.parse({ url: "https://example.com", extra: true })).toThrow();
    expect(webfetchInputSchema.parse({ url: "  https://example.com/path  " }).url).toBe(
      "https://example.com/path",
    );
    expect(() =>
      webfetchInputSchema.parse({ url: `https://example.com/${"x".repeat(2_048)}` }),
    ).toThrow();
    expect(decodeWebfetchInput({ url: "file:///etc/passwd" })).toMatchObject({
      status: "error",
      error: { _tag: "WebfetchInputInvalid", message: "Invalid webfetch input" },
    });
    expect(await executeWebfetchResult({ url: "file:///etc/passwd" })).toMatchObject({
      status: "error",
      error: { _tag: "WebfetchInputInvalid", message: "Invalid webfetch input" },
    });
    await expect(executeWebfetch({ url: "file:///etc/passwd" })).rejects.toBeInstanceOf(ZodError);
  });

  it("blocks local, private, mapped, metadata, and mixed DNS destinations before fetching", async () => {
    let fetches = 0;
    const fetchImpl = async () => {
      fetches += 1;
      return new Response("unexpected");
    };

    for (const url of [
      "http://127.1/",
      "http://2130706433/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "https://metadata.google.internal/",
      "https://service.internal/",
    ]) {
      const error = await executeError({ url }, {}, { fetch: fetchImpl, lookup: publicLookup });
      expect(error.message).toMatch(/blocked/u);
    }

    const mixedDnsError = await executeError(
      { url: "https://public.example.com" },
      {},
      {
        fetch: fetchImpl,
        lookup: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.1", family: 4 },
        ],
      },
    );
    expect(mixedDnsError.message).toContain("blocked destination");
    expect(fetches).toBe(0);
  });

  it("refuses inherited proxies and retries validated addresses after connection failures", async () => {
    const proxyError = await executeError(
      { url: "https://public.example.com" },
      {},
      { environment: { HTTPS_PROXY: "http://proxy.example.com" } },
    );
    expect(proxyError.message).toContain("proxy routing bypasses destination pinning");

    const requested: string[] = [];
    const result = await executeOk(
      { url: "https://public.example.com", format: "text" },
      {},
      {
        lookup: async () => [
          { address: "2606:4700:4700::1111", family: 6 },
          { address: "93.184.216.34", family: 4 },
        ],
        fetch: async (url) => {
          requested.push(String(url));
          if (requested.length === 1) throw new Error("IPv6 unavailable");
          return new Response("fallback worked", {
            headers: { "content-type": "text/plain" },
          });
        },
      },
    );
    expect(requested).toEqual(["https://[2606:4700:4700::1111]/", "https://93.184.216.34/"]);
    expect(result.content).toBe("fallback worked");
  });

  it("preserves the throwing compatibility API success shape", async () => {
    expect(exportedExecuteWebfetch).toBe(executeWebfetch);
    expect(exportedExecuteWebfetchResult).toBe(executeWebfetchResult);
    const output = await executeWebfetch(
      { url: "https://public.example.com/compatibility", format: "text" },
      {},
      {
        lookup: publicLookup,
        fetch: async () =>
          new Response("compatibility output", { headers: { "content-type": "text/plain" } }),
      },
    );
    expect(output).toMatchObject({
      requestedUrl: "https://public.example.com/compatibility",
      content: "compatibility output",
      status: 200,
      format: "text",
    });
  });

  it("exports the completed runtime Result and cleanup surface", () => {
    expect(exportedDecodeStoredHistoryNavigationResult).toBe(decodeStoredHistoryNavigationResult);
    expect(ExportedMiniLilacStoreOperationRejected).toBe(MiniLilacStoreOperationRejected);
    expect(exportedCreateWorkspaceHistoryStore).toBe(createWorkspaceHistoryStore);
    expect(ExportedWorkspaceHistoryCleanupFailed).toBe(WorkspaceHistoryCleanupFailed);
    expect(ExportedWorkspaceHistoryOperationAndCleanupFailed).toBe(
      WorkspaceHistoryOperationAndCleanupFailed,
    );
  });

  it("converts bounded HTML to Markdown without active content", async () => {
    const result = await executeOk(
      {
        url: "https://public.example.com/article#section",
        maxCharacters: 100,
      },
      {},
      {
        lookup: publicLookup,
        fetch: async (url, init) => {
          expect(String(url)).toBe("https://93.184.216.34/article");
          expect(init?.redirect).toBe("manual");
          expect(new Headers(init?.headers).get("user-agent")).toBe("MiniLilac/1.0 webfetch");
          expect(new Headers(init?.headers).get("host")).toBe("public.example.com");
          expect(init?.tls?.serverName).toBe("public.example.com");
          return new Response(
            "<html><head><title> Example Article </title><script>ignore()</script></head><body><h1>Hello</h1><p>Useful <strong>evidence</strong>.</p></body></html>",
            { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
          );
        },
      },
    );

    expect(result.requestedUrl).toBe("https://public.example.com/article");
    expect(result.title).toBe("Example Article");
    expect(result.content).toContain("# Hello");
    expect(result.content).toContain("**evidence**");
    expect(result.content).not.toContain("ignore");
    expect(result.truncated).toBe(false);
  });

  it("stops HTML parsing at the structural depth limit", async () => {
    const html = `${"<div>".repeat(257)}content${"</div>".repeat(257)}`;
    const error = await executeError(
      { url: "https://public.example.com/deep" },
      {},
      {
        lookup: publicLookup,
        fetch: async () =>
          new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
      },
    );
    expect(error).toMatchObject({
      _tag: "WebfetchResponseRejected",
      message: "webfetch HTML exceeds parser limits",
    });
  });

  it("revalidates relative redirects and blocks HTTPS downgrades", async () => {
    const requested: string[] = [];
    const result = await executeOk(
      { url: "https://public.example.com/start", format: "text" },
      {},
      {
        lookup: publicLookup,
        fetch: async (url) => {
          requested.push(String(url));
          if (requested.length === 1) {
            return new Response(null, { status: 302, headers: { location: "/final" } });
          }
          return new Response("finished", {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        },
      },
    );
    expect(requested).toEqual(["https://93.184.216.34/start", "https://93.184.216.34/final"]);
    expect(result.url).toBe("https://public.example.com/final");
    expect(result.redirects).toBe(1);

    const downgradeError = await executeError(
      { url: "https://public.example.com/start" },
      {},
      {
        lookup: publicLookup,
        fetch: async () =>
          new Response(null, {
            status: 302,
            headers: { location: "http://public.example.com/final" },
          }),
      },
    );
    expect(downgradeError.message).toContain("HTTPS to HTTP");

    let privateRedirectFetches = 0;
    const privateRedirectError = await executeError(
      { url: "https://public.example.com/start" },
      {},
      {
        lookup: publicLookup,
        fetch: async () => {
          privateRedirectFetches += 1;
          return new Response(null, {
            status: 302,
            headers: { location: "https://127.0.0.1/private" },
          });
        },
      },
    );
    expect(privateRedirectError.message).toContain("blocked address");
    expect(privateRedirectFetches).toBe(1);
  });

  it("cancels a stalled response body when the caller aborts", async () => {
    const abortController = new AbortController();
    let bodyCancelled = false;
    let responseStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      responseStarted = resolve;
    });
    const bodyReadStarted = Promise.withResolvers<void>();
    const pending = executeWebfetchResult(
      decodedInput({ url: "https://public.example.com/stalled" }),
      { abortSignal: abortController.signal },
      {
        lookup: publicLookup,
        fetch: async () => {
          responseStarted?.();
          return new Response(
            new ReadableStream(
              {
                pull() {
                  bodyReadStarted.resolve();
                },
                cancel() {
                  bodyCancelled = true;
                },
              },
              { highWaterMark: 0 },
            ),
            { headers: { "content-type": "text/plain" } },
          );
        },
      },
    );
    await started;
    await bodyReadStarted.promise;
    abortController.abort(new Error("cancelled by test"));
    const result = await pending;
    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "WebfetchCancelled", message: "webfetch request was cancelled" },
    });
    expect(bodyCancelled).toBe(true);

    const legacyAbortController = new AbortController();
    const legacyReason = new DOMException("legacy cancellation", "AbortError");
    let legacyBodyCancelled = false;
    let legacyResponseStarted: (() => void) | undefined;
    const legacyStarted = new Promise<void>((resolve) => {
      legacyResponseStarted = resolve;
    });
    const legacyBodyReadStarted = Promise.withResolvers<void>();
    const legacyPending = executeWebfetch(
      { url: "https://public.example.com/legacy-stalled" },
      { abortSignal: legacyAbortController.signal },
      {
        lookup: publicLookup,
        fetch: async () => {
          legacyResponseStarted?.();
          return new Response(
            new ReadableStream(
              {
                pull() {
                  legacyBodyReadStarted.resolve();
                },
                cancel() {
                  legacyBodyCancelled = true;
                },
              },
              { highWaterMark: 0 },
            ),
            { headers: { "content-type": "text/plain" } },
          );
        },
      },
    );
    await legacyStarted;
    await legacyBodyReadStarted.promise;
    legacyAbortController.abort(legacyReason);
    await expect(legacyPending).rejects.toBe(legacyReason);
    expect(legacyBodyCancelled).toBe(true);
  });

  it("rejects unsupported content and oversized responses, and reports output truncation", async () => {
    const unsupportedError = await executeError(
      { url: "https://public.example.com/file" },
      {},
      {
        lookup: publicLookup,
        fetch: async () => new Response("pdf", { headers: { "content-type": "application/pdf" } }),
      },
    );
    expect(unsupportedError.message).toContain("does not support Content-Type");

    let oversizedCancelled = false;
    const oversizedError = await executeError(
      { url: "https://public.example.com/large" },
      {},
      {
        lookup: publicLookup,
        fetch: async () =>
          new Response(
            new ReadableStream({
              cancel() {
                oversizedCancelled = true;
              },
            }),
            {
              headers: {
                "content-type": "text/plain",
                "content-length": String(WEBFETCH_MAX_RESPONSE_BYTES + 1),
              },
            },
          ),
      },
    );
    expect(oversizedError.message).toContain("exceeds");
    expect(oversizedCancelled).toBe(true);

    const truncated = await executeOk(
      { url: "https://public.example.com/text", format: "text", maxCharacters: 4 },
      {},
      {
        lookup: publicLookup,
        fetch: async () => new Response("abcdefgh", { headers: { "content-type": "text/plain" } }),
      },
    );
    expect(truncated.content).toBe("abcd");
    expect(truncated.truncated).toBe(true);
  });

  it("preserves Panic and reports cleanup failures without exposing dependency payloads", async () => {
    const panic = new Panic({ message: "fetch invariant" });
    await expect(
      executeWebfetch(
        decodedInput({ url: "https://public.example.com" }),
        {},
        {
          lookup: publicLookup,
          fetch: async () => {
            throw panic;
          },
        },
      ),
    ).rejects.toBe(panic);

    const secret = "dependency-secret";
    const redacted = await executeError(
      { url: "https://public.example.com" },
      {},
      {
        lookup: async () => {
          throw new Error(secret);
        },
        fetch: async () => new Response("unexpected"),
      },
    );
    expect(redacted).toMatchObject({
      _tag: "WebfetchExternalOperationFailed",
      operation: "DNS lookup",
    });
    expect(JSON.stringify(redacted)).not.toContain(secret);
    const legacyLookupError = new TypeError(secret);
    await expect(
      executeWebfetch(
        { url: "https://public.example.com" },
        {},
        {
          lookup: async () => {
            throw legacyLookupError;
          },
          fetch: async () => new Response("unexpected"),
        },
      ),
    ).rejects.toBe(legacyLookupError);

    const legacyConnectError = new TypeError("connection refused");
    await expect(
      executeWebfetch(
        { url: "https://public.example.com" },
        {},
        {
          lookup: publicLookup,
          fetch: async () => {
            throw legacyConnectError;
          },
        },
      ),
    ).rejects.toMatchObject({
      message: "webfetch could not connect to 'public.example.com'",
      cause: legacyConnectError,
    });

    const cleanupError = await executeError(
      { url: "https://public.example.com/file" },
      {},
      {
        lookup: publicLookup,
        fetch: async () =>
          new Response(
            new ReadableStream({
              cancel() {
                throw new Error("cleanup-secret");
              },
            }),
            { headers: { "content-type": "application/pdf" } },
          ),
      },
    );
    expect(cleanupError).toMatchObject({
      _tag: "WebfetchOperationAndCleanupFailed",
      primary: { _tag: "WebfetchResponseRejected" },
      cleanup: { _tag: "WebfetchCleanupFailed", operations: ["cancel response body"] },
    });
    expect(JSON.stringify(cleanupError)).not.toContain("cleanup-secret");

    const legacyCleanupError = new TypeError("legacy cleanup failure");
    await expect(
      executeWebfetch(
        { url: "https://public.example.com/legacy-cleanup" },
        {},
        {
          lookup: publicLookup,
          fetch: async () =>
            new Response(
              new ReadableStream({
                cancel() {
                  throw legacyCleanupError;
                },
              }),
              { headers: { "content-type": "application/pdf" } },
            ),
        },
      ),
    ).rejects.toBe(legacyCleanupError);

    const cleanupPanic = new Panic({ message: "cleanup invariant" });
    await expect(
      executeWebfetch(
        decodedInput({ url: "https://public.example.com/panic-cleanup" }),
        {},
        {
          lookup: publicLookup,
          fetch: async () =>
            new Response(
              new ReadableStream({
                cancel() {
                  throw cleanupPanic;
                },
              }),
              { headers: { "content-type": "application/pdf" } },
            ),
        },
      ),
    ).rejects.toBe(cleanupPanic);
  });

  it("keeps the AI SDK tool compatibility adapter installed", () => {
    const tool = createWebfetchTool({
      lookup: publicLookup,
      fetch: async () => new Response("tool result", { headers: { "content-type": "text/plain" } }),
    }).webfetch;
    if (!tool || tool.type === "provider" || !tool.execute)
      throw new Error("missing webfetch tool");
    expect(tool.execute).toBeFunction();
    expect(tool.outputSchema).toBe(webfetchOutputSchema);
  });
});
