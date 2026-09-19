import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writePrivateFile } from "../src/private-file";
import { createTuiAuth, type TuiAuthOptions } from "../src/auth";
const directories: string[] = [];
const servers: Bun.Server<undefined>[] = [];
afterEach(async () => {
  mock.restore();
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function options(baseUrl: string): Promise<TuiAuthOptions> {
  const directory = await mkdtemp(join(tmpdir(), "lilac-tui-auth-"));
  directories.push(directory);
  return {
    baseUrl,
    credentialDirectory: directory,
    requestLocalCredentials: async () => ({ username: "owner", password: "fixture-password" }),
    openBrowser: async () => {},
  };
}
test("local login saves only session credential separately and logs out remotely", async () => {
  let loginCount = 0,
    logoutCount = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/info") return Response.json({ provider: "local" });
      if (path === "/api/auth/login") {
        loginCount++;
        expect(request.headers.get("authorization")).toBe(
          `Basic ${Buffer.from("owner:fixture-password").toString("base64")}`,
        );
        return Response.json({ token: "fixture-session", expiresAt: Date.now() / 1000 + 3600 });
      }
      logoutCount++;
      expect(request.headers.get("authorization")).toBe("Bearer fixture-session");
      return Response.json({ ok: true });
    },
  });
  servers.push(server);
  const config = await options(server.url.href);
  const session = (await createTuiAuth(config)).unwrap();
  expect(session.authorization()).toBe("Bearer fixture-session");
  const file = (await readdir(config.credentialDirectory))[0]!;
  const saved = await readFile(join(config.credentialDirectory, file), "utf8");
  expect(saved).not.toContain("fixture-password");
  expect((await stat(join(config.credentialDirectory, file))).mode & 0o777).toBe(0o600);
  expect((await createTuiAuth(config)).isOk()).toBe(true);
  expect(loginCount).toBe(1);
  expect((await session.logout()).isOk()).toBe(true);
  expect(logoutCount).toBe(1);
  expect(await readdir(config.credentialDirectory)).toEqual([]);
  expect(session.token).toBe("");
});
test("rejects insecure remote endpoint before sending credentials", async () => {
  const config = await options("http://remote.example.test");
  let prompted = false;
  config.requestLocalCredentials = async () => {
    prompted = true;
    return { username: "owner", password: "fixture" };
  };
  expect((await createTuiAuth(config)).isErr()).toBe(true);
  expect(prompted).toBe(false);
});
test("Clerk PKCE validates callback state, rotates refresh token and revokes on logout", async () => {
  const originalFetch = globalThis.fetch;
  let exchange = 0,
    refresh = 0;
  const revoked: string[] = [];
  let nativeLogoutCount = 0;
  let expectedRedirect = "",
    expectedChallenge = "";
  const issuer = "https://fixture.clerk.accounts.dev";
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith("http://127.0.0.1:")) return originalFetch(input, init);
        if (url.endsWith("/api/auth/info"))
          return Response.json({ provider: "clerk", issuer, oauthClientId: "fixture-client" });
        if (url.endsWith("/api/auth/logout")) {
          nativeLogoutCount++;
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-access-2");
          return Response.json({ ok: true });
        }
        if (url.includes("/.well-known/"))
          return Response.json({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            revocation_endpoint: `${issuer}/revoke`,
          });
        const body = new URLSearchParams(init?.body?.toString());
        if (url.endsWith("/revoke")) {
          revoked.push(body.get("token")!);
          if (body.get("token") !== "fixture-refresh-2")
            return Response.json({ error: "unsupported_token_type" }, { status: 400 });
          expect(body.get("token_type_hint")).toBe("refresh_token");
          return new Response(null, { status: 200 });
        }
        expect(url).toBe(`${issuer}/token`);
        expect(body.get("client_id")).toBe("fixture-client");
        expect(body.has("client_secret")).toBe(false);
        if (body.get("grant_type") === "authorization_code") {
          exchange++;
          expect(body.get("redirect_uri")).toBe(expectedRedirect);
          expect(body.get("code")).toBe("fixture-code");
          const hash = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(body.get("code_verifier")!),
          );
          expect(Buffer.from(hash).toString("base64url")).toBe(expectedChallenge);
          return Response.json({
            access_token: "fixture-access",
            token_type: "Bearer",
            expires_in: 1,
            refresh_token: "fixture-refresh",
          });
        }
        refresh++;
        expect(body.get("refresh_token")).toBe("fixture-refresh");
        return Response.json({
          access_token: "fixture-access-2",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "fixture-refresh-2",
        });
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  const config = await options("https://native.example.test");
  config.openBrowser = async (href) => {
    const url = new URL(href);
    expectedRedirect = url.searchParams.get("redirect_uri")!;
    expectedChallenge = url.searchParams.get("code_challenge")!;
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(new URL(expectedRedirect).hostname).toBe("127.0.0.1");
    const bad = await originalFetch(`${expectedRedirect}?state=wrong&code=fixture-code`);
    expect(bad.status).toBe(400);
    const good = await originalFetch(
      `${expectedRedirect}?state=${url.searchParams.get("state")}&code=fixture-code`,
    );
    expect(good.status).toBe(200);
  };
  const result = await createTuiAuth(config);
  const session = result.unwrap();
  expect(exchange).toBe(1);
  const refreshed = await Promise.all([session.refresh(), session.refresh()]);
  expect(refreshed.every((value) => value.isOk())).toBe(true);
  expect(refresh).toBe(1);
  expect(session.token).toBe("fixture-access-2");
  expect((await session.logout()).isOk()).toBe(true);
  expect(revoked).toEqual(["fixture-refresh-2"]);
  expect(nativeLogoutCount).toBe(1);
  expect(await readdir(config.credentialDirectory)).toEqual([]);
});
test("canceled Clerk login stops callback and never saves credentials", async () => {
  const originalFetch = globalThis.fetch;
  const issuer = "https://fixture.clerk.accounts.dev";
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/api/auth/info"))
          return Response.json({ provider: "clerk", issuer, oauthClientId: "fixture-client" });
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
        });
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  const config = await options("https://native.example.test");
  const abort = new AbortController();
  config.signal = abort.signal;
  config.openBrowser = async () => {
    abort.abort();
  };
  expect((await createTuiAuth(config)).isErr()).toBe(true);
  expect(await readdir(config.credentialDirectory)).toEqual([]);
});

test("logout clears credentials and revokes Clerk refresh even when native server is unavailable", async () => {
  const config = await options("https://native.example.test");
  const issuer = "https://fixture.clerk.accounts.dev";
  const path = join(
    config.credentialDirectory,
    `${createHash("sha256").update(config.baseUrl).digest("hex")}-v1.json`,
  );
  await writePrivateFile(
    path,
    JSON.stringify({
      version: 1,
      baseUrl: config.baseUrl,
      provider: "clerk",
      issuer,
      clientId: "fixture-client",
      token: "fixture-access",
      refreshToken: "fixture-refresh",
      expiresAt: Date.now() / 1000 + 3600,
    }),
  );
  const originalFetch = globalThis.fetch;
  let revoked = false;
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/api/auth/info"))
          return Response.json({ provider: "clerk", issuer, oauthClientId: "fixture-client" });
        if (url.endsWith("/api/auth/logout")) return new Response(null, { status: 503 });
        if (url.includes("/.well-known/"))
          return Response.json({ issuer, revocation_endpoint: `${issuer}/revoke` });
        revoked = true;
        return new Response(null, { status: 200 });
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  const session = (await createTuiAuth(config)).unwrap();
  expect((await session.logout()).isErr()).toBe(true);
  expect(revoked).toBe(true);
  expect(await readdir(config.credentialDirectory)).toEqual([]);
});

test("logout during refresh revokes the newly rotated credential without saving it", async () => {
  const config = await options("https://native.example.test");
  const issuer = "https://fixture.clerk.accounts.dev";
  const path = join(
    config.credentialDirectory,
    `${createHash("sha256").update(config.baseUrl).digest("hex")}-v1.json`,
  );
  const now = Date.now();
  await writePrivateFile(
    path,
    JSON.stringify({
      version: 1,
      baseUrl: config.baseUrl,
      provider: "clerk",
      issuer,
      clientId: "fixture-client",
      token: "fixture-access",
      refreshToken: "fixture-refresh",
      expiresAt: now / 1000 + 3600,
    }),
  );
  const originalFetch = globalThis.fetch;
  const refreshEntered = Promise.withResolvers<void>();
  const tokenResponse = Promise.withResolvers<Response>();
  const revoked: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/auth/info"))
          return Response.json({ provider: "clerk", issuer, oauthClientId: "fixture-client" });
        if (url.includes("/.well-known/"))
          return Response.json({
            issuer,
            token_endpoint: `${issuer}/token`,
            revocation_endpoint: `${issuer}/revoke`,
          });
        if (url.endsWith("/token")) {
          refreshEntered.resolve();
          return tokenResponse.promise;
        }
        if (url.endsWith("/api/auth/logout")) {
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer rotated-access");
          expect(await readdir(config.credentialDirectory)).toEqual([]);
          return Response.json({ ok: true });
        }
        revoked.push(new URLSearchParams(init?.body?.toString()).get("token")!);
        return new Response(null, { status: 200 });
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  const session = (await createTuiAuth(config)).unwrap();
  spyOn(Date, "now").mockReturnValue(now + 3590000);
  const refreshing = session.refresh();
  await refreshEntered.promise;
  const logout = session.logout();
  tokenResponse.resolve(
    Response.json({
      access_token: "rotated-access",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "rotated-refresh",
    }),
  );
  expect((await refreshing).isErr()).toBe(true);
  expect((await logout).isOk()).toBe(true);
  expect(revoked).toEqual(["rotated-refresh"]);
  expect(session.token).toBe("");
  expect(await readdir(config.credentialDirectory)).toEqual([]);
});

test("native logout timeout does not cancel the independent provider revocation", async () => {
  const config = await options("https://native.example.test");
  const issuer = "https://fixture.clerk.accounts.dev";
  const path = join(
    config.credentialDirectory,
    `${createHash("sha256").update(config.baseUrl).digest("hex")}-v1.json`,
  );
  await writePrivateFile(
    path,
    JSON.stringify({
      version: 1,
      baseUrl: config.baseUrl,
      provider: "clerk",
      issuer,
      clientId: "fixture-client",
      token: "fixture-access",
      refreshToken: "fixture-refresh",
      expiresAt: Date.now() / 1000 + 3600,
    }),
  );
  const originalFetch = globalThis.fetch;
  let deadlines = 0,
    revoked = false;
  spyOn(AbortSignal, "timeout").mockImplementation(() =>
    ++deadlines === 1 ? AbortSignal.abort() : new AbortController().signal,
  );
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/auth/info"))
          return Response.json({ provider: "clerk", issuer, oauthClientId: "fixture-client" });
        if (url.endsWith("/api/auth/logout")) {
          expect(init?.signal?.aborted).toBe(true);
          return Promise.reject(new DOMException("Aborted", "AbortError"));
        }
        expect(init?.signal?.aborted).toBe(false);
        if (url.includes("/.well-known/"))
          return Response.json({ issuer, revocation_endpoint: `${issuer}/revoke` });
        revoked = true;
        return new Response(null, { status: 200 });
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  const session = (await createTuiAuth(config)).unwrap();
  expect((await session.logout()).isErr()).toBe(true);
  expect(revoked).toBe(true);
  expect(deadlines).toBe(2);
});
