import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { createNativeLocalAuthenticator } from "./auth-local";
import { createNativeClerkAuthenticator } from "./auth-clerk";
import { authFailure, checkNativeRequestOrigin, sameNativePrincipal } from "./auth";

const origin = "https://lilac.example";
const issuer = "https://fixture.clerk.accounts.dev";

function request(token: string, extra: Record<string, string> = {}): Request {
  return new Request(`${origin}/native`, {
    headers: { authorization: `Bearer ${token}`, ...extra },
  });
}

describe("native local authentication", () => {
  async function setup(passwordValue = "fixture-password", usernameValue = "operator") {
    let clock = 1000;
    const auth = createNativeLocalAuthenticator(
      {
        ownerUserId: "owner",
        username: usernameValue,
        passwordHash: await Bun.password.hash(passwordValue, {
          algorithm: "argon2id",
          memoryCost: 4096,
          timeCost: 1,
        }),
        signingKey: crypto.getRandomValues(new Uint8Array(32)),
        installationId: "fixture",
        allowedOrigins: [origin],
        sessionLifetimeSeconds: 60,
      },
      () => clock,
    );
    const login = (password = passwordValue, key = "client") =>
      auth.login(
        new Request(`${origin}/login`, {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from(`${usernameValue}:${password}`, "utf8").toString("base64")}`,
            origin,
          },
        }),
        key,
      );
    return {
      auth,
      login,
      advance: () => {
        clock += 61;
      },
    };
  }

  test("fixed owner login supports HTTP, socket and resources, then revokes on logout", async () => {
    const { auth, login } = await setup();
    const result = (await login()).unwrap();
    expect(result.setCookie).toContain("HttpOnly; SameSite=Strict");
    expect(result.setCookie).toContain("Secure");
    expect((await auth.authenticate(request(result.token))).unwrap().userId).toBe("owner");
    const cookie = new Request(`${origin}/resource`, {
      headers: { cookie: result.setCookie.split(";")[0]! },
    });
    expect((await auth.authenticate(cookie)).isOk()).toBe(true);
    expect(
      (await auth.authenticate(cookie, { socket: true })).match({
        ok: () => "unexpected success",
        err: (error) => error.code,
      }),
    ).toBe("forbidden");
    expect((await auth.authenticate(request(result.token), { socket: true })).isOk()).toBe(true);
    expect((await auth.reauthenticate(result.principal, request(result.token))).isOk()).toBe(true);
    expect((await auth.logout(request(result.token))).isOk()).toBe(true);
    expect(auth.checkSession(result.principal).isErr()).toBe(true);
    expect(
      (await auth.authenticate(request(result.token))).match({
        ok: () => "unexpected success",
        err: (error) => error.code,
      }),
    ).toBe("unauthorized");
  });

  test("Basic login decodes UTF-8 credentials and rejects invalid UTF-8", async () => {
    const { auth, login } = await setup("密碼-☕", "使用者");
    expect((await login()).unwrap().principal.providerUserId).toBe("使用者");
    const invalid = new Request(`${origin}/login`, {
      method: "POST",
      headers: { authorization: `Basic ${btoa("\xff:password")}`, origin },
    });
    expect((await auth.login(invalid, "invalid-client")).isErr()).toBe(true);
  });

  test("rejects expiry, wrong credential, foreign origin, cross-provider tokens and identity swaps", async () => {
    const { auth, login, advance } = await setup();
    expect(
      (await login("wrong")).match({ ok: () => "unexpected success", err: (error) => error.code }),
    ).toBe("unauthorized");
    const result = (await login()).unwrap();
    expect(
      (await auth.authenticate(request(result.token, { origin: "https://evil.example" }))).match({
        ok: () => "unexpected success",
        err: (error) => error.code,
      }),
    ).toBe("forbidden");
    expect(
      (await auth.authenticate(request("not-a-session"))).match({
        ok: () => "unexpected success",
        err: (error) => error.code,
      }),
    ).toBe("unauthorized");
    expect(
      (
        await auth.reauthenticate({ ...result.principal, userId: "other" }, request(result.token))
      ).match({ ok: () => "unexpected success", err: (error) => error.code }),
    ).toBe("forbidden");
    expect(
      sameNativePrincipal(result.principal, { ...result.principal, provider: "clerk" }).match({
        ok: () => "unexpected success",
        err: (error) => error.code,
      }),
    ).toBe("forbidden");
    advance();
    expect(
      (await auth.authenticate(request(result.token))).match({
        ok: () => "unexpected success",
        err: (error) => error.code,
      }),
    ).toBe("unauthorized");
  });

  test("bounds failed login attempts before expensive password verification", async () => {
    const { login } = await setup();
    for (let i = 0; i < 5; i++)
      expect(
        (await login("wrong")).match({
          ok: () => "unexpected success",
          err: (error) => error.code,
        }),
      ).toBe("unauthorized");
    expect(
      (await login()).match({ ok: () => "unexpected success", err: (error) => error.code }),
    ).toBe("rate_limited");
  });

  test("cookie mutations require an allowed origin even when GET reads work", () => {
    const cookie = new Request(`${origin}/native`, {
      headers: { cookie: "lilac_native_session=x" },
    });
    expect(checkNativeRequestOrigin(cookie, [origin]).isOk()).toBe(true);
    expect(
      checkNativeRequestOrigin(cookie, [origin], { mutation: true }).match({
        ok: () => "unexpected success",
        err: (error) => error.code,
      }),
    ).toBe("forbidden");
    expect(
      checkNativeRequestOrigin(
        new Request(`${origin}/native`, { headers: { cookie: "x=y", origin } }),
        [origin],
        { socket: true },
      ).isOk(),
    ).toBe(true);
  });
});

describe("native Clerk authentication with real SDK and signed fixtures", () => {
  async function setup(oauthClientId: string | null = "client_fixture") {
    const keys = await generateKeyPair("RS256", { extractable: true });
    const auth = (
      await createNativeClerkAuthenticator({
        secretKey: "sk_test_fixture",
        publishableKey: `pk_test_${btoa("fixture.clerk.accounts.dev$")}`,
        jwtKey: await exportSPKI(keys.publicKey),
        issuer,
        oauthClientId: oauthClientId ?? undefined,
        allowedOrigins: [origin],
        resolveUser: async (id) =>
          id === "user_fixture"
            ? Result.ok({ userId: "owner" })
            : Result.err(authFailure("forbidden", "User is not registered")),
      })
    ).unwrap();
    const sign = (claims: Record<string, string | number> = {}, oauth = false) =>
      new SignJWT({ sid: "sess_fixture", azp: origin, ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "fixture", typ: oauth ? "at+jwt" : "JWT" })
        .setIssuer(typeof claims.iss === "string" ? claims.iss : issuer)
        .setSubject(typeof claims.sub === "string" ? claims.sub : "user_fixture")
        .setIssuedAt()
        .setNotBefore(Math.floor(Date.now() / 1000) - 1)
        .setExpirationTime(typeof claims.exp === "number" ? claims.exp : "1m")
        .sign(keys.privateKey);
    return { auth, sign };
  }

  test("accepts verified browser session and configured public OAuth user token", async () => {
    const { auth, sign } = await setup();
    expect((await auth.authenticate(request(await sign()))).unwrap().userId).toBe("owner");
    const oauth = await sign({ client_id: "client_fixture", jti: "oat_fixture" }, true);
    const identity = (await auth.authenticate(request(oauth))).unwrap();
    expect(identity.sessionId).toBe("oat_fixture");
    expect(identity.providerUserId).toBe("user_fixture");
    expect((await auth.logout(request(oauth))).isOk()).toBe(true);
    expect(
      (await auth.authenticate(request(oauth))).match({
        ok: () => "unexpected success",
        err: (error) => error.code,
      }),
    ).toBe("unauthorized");
  });

  test("without an OAuth client, browser sessions work and OAuth user tokens are rejected", async () => {
    const { auth, sign } = await setup(null);
    expect((await auth.authenticate(request(await sign()))).unwrap().userId).toBe("owner");
    const oauth = await sign({ client_id: "client_fixture", jti: "oat_fixture" }, true);
    expect((await auth.authenticate(request(oauth))).isErr()).toBe(true);
  });

  test("rejects bad issuer/client/user/origin and expired or forged signatures", async () => {
    const { auth, sign } = await setup();
    for (const token of [
      await sign({ iss: "https://wrong.example" }),
      await sign({ exp: 1 }),
      await sign({ sub: "user_unknown" }),
      await sign({ client_id: "wrong", jti: "oat_fixture" }, true),
      "malformed",
    ]) {
      expect((await auth.authenticate(request(token))).isErr()).toBe(true);
    }
    const token = await sign();
    expect(
      (await auth.authenticate(request(token, { origin: "https://wrong.example" }))).match({
        ok: () => "unexpected success",
        err: (error) => error.code,
      }),
    ).toBe("forbidden");
    expect((await auth.authenticate(request(`${token.slice(0, -10)}aaaaaaaaaa`))).isErr()).toBe(
      true,
    );
  });

  test("preserves Clerk handshake instead of declaring logout", async () => {
    const { auth, sign } = await setup();
    const token = await sign({ exp: 1 });
    const response = await auth.authenticate(
      new Request(`${origin}/`, {
        headers: {
          cookie: `__session=${token}; __client_uat=1`,
          accept: "text/html",
          "sec-fetch-dest": "document",
        },
      }),
    );
    expect(response.match({ ok: () => "unexpected success", err: (error) => error.code })).toBe(
      "handshake",
    );
  });
});
