import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const buildId = "1234567890abcdef1234";
const script = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8")
  .replaceAll("__BUILD_ID__", buildId)
  .replace('"__ASSET_PATHS__"', JSON.stringify(["/assets/app-new.js"]))
  .replace('"__PRECACHE_PATHS__"', JSON.stringify(["/", "/assets/app-new.js"]));
function response(body: string, type = "text/javascript", status = 200, cacheControl = "public") {
  const value = new Response(body, {
    status,
    headers: { "content-type": type, "cache-control": cacheControl },
  });
  Object.defineProperty(value, "type", { value: "basic" });
  return value;
}
function fixture(options: { storageUnavailable?: boolean; shellBuild?: string } = {}) {
  const handlers = new Map<string, (event: object) => void>();
  const stores = new Map<string, Map<string, Response>>();
  const requests: string[] = [];
  const clients: { id: string; postMessage: (value: object) => void }[] = [];
  const cacheKey = (key: string | Request) =>
    new URL(typeof key === "string" ? key : key.url, "https://lilac.test").pathname;
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async (key: string) => stores.delete(key),
    open: async (key: string) => {
      if (options.storageUnavailable) throw new Error("Storage evicted");
      const entries = stores.get(key) ?? new Map<string, Response>();
      stores.set(key, entries);
      return {
        match: async (request: string | Request) => entries.get(cacheKey(request))?.clone(),
        put: async (request: string | Request, value: Response) => {
          entries.set(cacheKey(request), value);
        },
      };
    },
  };
  let networkResponse: Response | undefined;
  runInNewContext(script, {
    self: {
      location: { origin: "https://lilac.test" },
      addEventListener: (name: string, callback: (event: object) => void) =>
        handlers.set(name, callback),
      clients: { matchAll: async () => clients },
      skipWaiting: async () => {},
    },
    caches,
    Request,
    Response,
    URL,
    Promise,
    Set,
    Map,
    fetch: async (request: Request) => {
      const pathname = new URL(request.url).pathname;
      requests.push(pathname);
      if (networkResponse) return networkResponse;
      if (pathname === "/")
        return response(
          `<meta name="lilac-build" content="${options.shellBuild ?? buildId}" />`,
          "text/html",
        );
      return response("export const ready = true;");
    },
  });
  return {
    stores,
    requests,
    clients,
    setNetworkResponse: (value: Response) => {
      networkResponse = value;
    },
    dispatch: async (name: string, fields: object = {}) => {
      const pending: Promise<unknown>[] = [];
      let reply: Promise<Response> | undefined;
      handlers.get(name)!({
        ...fields,
        waitUntil: (work: Promise<unknown>) => pending.push(work),
        respondWith: (work: Promise<Response>) => {
          reply = work;
        },
      });
      const response = await reply;
      await Promise.all(pending);
      return response;
    },
  };
}
function request(pathname: string, mode = "cors", method = "GET") {
  return { url: `https://lilac.test${pathname}`, mode, method };
}

describe("app shell service worker", () => {
  test("precaches the hashed shell and serves repeat navigation without network", async () => {
    const f = fixture();
    await f.dispatch("install");
    expect(f.requests).toEqual(["/", "/assets/app-new.js"]);
    const page = await f.dispatch("fetch", { request: request("/?thread=abc", "navigate") });
    expect(await page?.text()).toContain(buildId);
    expect(f.requests).toHaveLength(2);
  });
  test("never intercepts private HTTP, Clerk or non-GET requests", async () => {
    const f = fixture();
    for (const path of [
      "/api/bootstrap",
      "/api/resources/secret",
      "/__clerk/v1/client",
      "/private-file",
    ])
      expect(await f.dispatch("fetch", { request: request(path, "navigate") })).toBeUndefined();
    expect(
      await f.dispatch("fetch", { request: request("/", "navigate", "POST") }),
    ).toBeUndefined();
    expect(f.requests).toEqual([]);
  });
  test("storage unavailability and eviction fall back to network", async () => {
    const unavailable = fixture({ storageUnavailable: true });
    await unavailable.dispatch("install");
    expect((await unavailable.dispatch("fetch", { request: request("/", "navigate") }))?.ok).toBe(
      true,
    );
    const evicted = fixture();
    await evicted.dispatch("install");
    evicted.stores.clear();
    expect((await evicted.dispatch("fetch", { request: request("/", "navigate") }))?.ok).toBe(true);
    expect(evicted.requests).toHaveLength(3);
  });
  test("does not cache error, private or mismatched-version shell responses", async () => {
    const f = fixture({ shellBuild: "00000000000000000000" });
    await f.dispatch("install");
    expect(f.stores.get(`lilac-shell-${buildId}`)?.has("/")).toBe(false);
    f.setNetworkResponse(response("secret", "text/javascript", 200, "private, no-store"));
    f.stores.clear();
    await f.dispatch("fetch", { request: request("/assets/app-new.js") });
    expect(f.stores.size).toBe(0);
    f.setNetworkResponse(response("unavailable", "text/javascript", 503));
    await f.dispatch("fetch", { request: request("/assets/app-new.js") });
    expect([...f.stores.values()].every((cache) => cache.size === 0)).toBe(true);
  });
  test("retains caches needed by old open tabs and removes only unused builds", async () => {
    const f = fixture();
    const old = "aaaaaaaaaaaaaaaaaaaa";
    const unused = "bbbbbbbbbbbbbbbbbbbb";
    f.stores.set(`lilac-shell-${unused}`, new Map());
    f.stores.set(`lilac-shell-${old}`, new Map([["/assets/app-old.js", response("old")]]));
    f.stores.set(`lilac-shell-${buildId}`, new Map());
    f.stores.set("lilac-shell-cccccccccccccccccccc", new Map());
    const first = { id: "old-tab", postMessage: () => {} };
    const second = { id: "new-tab", postMessage: () => {} };
    f.clients.push(first, second);
    await f.dispatch("message", { data: { type: "lilac-build", id: buildId }, source: second });
    expect(f.stores.has(`lilac-shell-${unused}`)).toBe(true);
    await f.dispatch("message", { data: { type: "lilac-build", id: old }, source: first });
    expect(f.stores.has(`lilac-shell-${unused}`)).toBe(false);
    expect(f.stores.has(`lilac-shell-${old}`)).toBe(true);
    expect(f.stores.has("lilac-shell-cccccccccccccccccccc")).toBe(true);
    expect(
      await (await f.dispatch("fetch", { request: request("/assets/app-old.js") }))?.text(),
    ).toBe("old");
    expect(f.requests).toEqual([]);
  });
});
