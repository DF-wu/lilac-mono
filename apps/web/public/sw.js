const BUILD_ID = "__BUILD_ID__";
const SHELL_CACHE = `lilac-shell-${BUILD_ID}`;
const ASSET_PATHS = new Set("__ASSET_PATHS__");
const PRECACHE_PATHS = "__PRECACHE_PATHS__";
const clientBuilds = new Map();

async function bestEffort(operation) {
  const [result] = await Promise.allSettled([operation()]);
  return result.status === "fulfilled" ? result.value : undefined;
}

function cacheable(response, pathname) {
  if (!response.ok || response.type !== "basic" || response.redirected) return false;
  if (/(?:private|no-store)/i.test(response.headers.get("cache-control") ?? "")) return false;
  const type = response.headers.get("content-type") ?? "";
  if (pathname === "/") return type.includes("text/html");
  return !type.includes("text/html") && ASSET_PATHS.has(pathname);
}

async function storeResponse(pathname, response) {
  if (!cacheable(response, pathname)) return;
  if (
    pathname === "/" &&
    !(await response.clone().text()).includes(`name="lilac-build" content="${BUILD_ID}"`)
  )
    return;
  await bestEffort(async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.put(pathname, response.clone());
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    Promise.allSettled(
      PRECACHE_PATHS.map(async (pathname) => {
        const response = await fetch(
          new Request(new URL(pathname, self.location.origin), {
            cache: pathname === "/" ? "no-cache" : "force-cache",
          }),
        );
        await storeResponse(pathname, response);
      }),
    ),
  );
});

async function requestBuildReports() {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) client.postMessage({ type: "lilac-build-request" });
}

self.addEventListener("activate", (event) => {
  event.waitUntil(requestBuildReports());
});

async function cleanupUnusedBuilds() {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (clients.some((client) => !clientBuilds.has(client.id))) return;
  const retained = new Set([
    SHELL_CACHE,
    ...clients.map((client) => `lilac-shell-${clientBuilds.get(client.id)}`),
  ]);
  await bestEffort(async () => {
    const keys = await caches.keys();
    // A waiting worker can cache its build before any window reports that version.
    for (const key of keys.filter((name) => name.startsWith("lilac-shell-")).slice(-2))
      retained.add(key);
    await Promise.all(
      keys
        .filter((key) => key.startsWith("lilac-shell-") && !retained.has(key))
        .map((key) => caches.delete(key)),
    );
  });
}

self.addEventListener("message", (event) => {
  if (event.data === "activate-update") {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (
    event.data?.type !== "lilac-build" ||
    !/^[a-f0-9]{20}$/.test(event.data.id) ||
    !event.source?.id
  )
    return;
  clientBuilds.set(event.source.id, event.data.id);
  event.source.postMessage({ type: "lilac-build-version", id: BUILD_ID });
  event.waitUntil(cleanupUnusedBuilds());
});

async function cachedResponse(pathname, shell) {
  return bestEffort(async () => {
    if (shell) return (await caches.open(SHELL_CACHE)).match("/");
    const keys = await caches.keys();
    for (const key of keys.filter((name) => name.startsWith("lilac-shell-"))) {
      const response = await (await caches.open(key)).match(pathname);
      if (response) return response;
    }
    return undefined;
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  const appRoute =
    url.pathname === "/" ||
    /^\/threads\/[^/]+\/?$/.test(url.pathname) ||
    /^\/design-system\/?$/.test(url.pathname);
  const shell = request.mode === "navigate" && appRoute;
  const asset = url.pathname.startsWith("/assets/");
  if (!shell && !asset) return;
  event.respondWith(
    (async () => {
      const pathname = shell ? "/" : url.pathname;
      const cached = await cachedResponse(pathname, shell);
      if (cached) return cached;
      const response = await fetch(
        shell ? new Request(new URL("/", self.location.origin), { cache: "no-cache" }) : request,
      );
      event.waitUntil(storeResponse(pathname, response));
      return response;
    })(),
  );
});
