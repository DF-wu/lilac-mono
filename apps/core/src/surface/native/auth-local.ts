import { Result } from "better-result";
import { jwtVerify, SignJWT } from "jose";
import {
  authFailure,
  checkNativeRequestOrigin,
  nativeBearer,
  nativeCookie,
  nativeSessionCookie,
  sameNativePrincipal,
  type NativeAuthenticator,
  type NativeAuthContext,
  type NativeAuthError,
  type NativeLogin,
  type NativePrincipal,
} from "./auth";

export type NativeLocalAuthConfig = {
  ownerUserId: string;
  username: string;
  passwordHash: string;
  signingKey: Uint8Array;
  installationId: string;
  allowedOrigins: readonly string[];
  sessionLifetimeSeconds?: number;
};

export interface NativeLocalAuthenticator extends NativeAuthenticator {
  login(request: Request, clientKey: string): Promise<Result<NativeLogin, NativeAuthError>>;
}

type AttemptBucket = { count: number; resetAt: number };

export function createNativeLocalAuthenticator(
  config: NativeLocalAuthConfig,
  now: () => number = () => Math.floor(Date.now() / 1000),
): NativeLocalAuthenticator {
  const sessions = new Map<string, number>();
  const attempts = new Map<string, AttemptBucket>();
  const lifetime = Math.max(60, Math.min(config.sessionLifetimeSeconds ?? 43_200, 86_400));
  let passwordWork = 0;

  function checkSession(principal: NativePrincipal): Result<void, NativeAuthError> {
    if (
      principal.provider !== "local" ||
      principal.userId !== config.ownerUserId ||
      principal.providerUserId !== config.username ||
      sessions.get(principal.sessionId) !== principal.expiresAt ||
      principal.expiresAt <= now()
    ) {
      return Result.err(authFailure("unauthorized", "Session is no longer active"));
    }
    return Result.ok();
  }

  function prune(): void {
    const time = now();
    for (const [id, expiry] of sessions) if (expiry <= time) sessions.delete(id);
    for (const [id, bucket] of attempts) if (bucket.resetAt <= time) attempts.delete(id);
  }

  function rateLimit(clientKey: string): Result<void, NativeAuthError> {
    prune();
    if (passwordWork >= 4 || sessions.size >= 1024) {
      return Result.err(authFailure("rate_limited", "Login capacity exceeded"));
    }
    const bucket = attempts.get(clientKey);
    if (bucket && bucket.count >= 5)
      return Result.err(authFailure("rate_limited", "Too many login attempts"));
    if (!bucket && attempts.size >= 1024)
      return Result.err(authFailure("rate_limited", "Login capacity exceeded"));
    attempts.set(clientKey, {
      count: (bucket?.count ?? 0) + 1,
      resetAt: bucket?.resetAt ?? now() + 60,
    });
    return Result.ok();
  }

  function transport(request: Request): Result<void, NativeAuthError> {
    const url = new URL(request.url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !loopback)
      return Result.err(authFailure("forbidden", "Local authentication requires HTTPS"));
    if (config.signingKey.byteLength < 32 || !config.passwordHash.startsWith("$argon2id$")) {
      return Result.err(authFailure("unavailable", "Local authentication is not configured"));
    }
    return Result.ok();
  }

  async function verifyPassword(password: string): Promise<Result<boolean, NativeAuthError>> {
    passwordWork += 1;
    const verified = await Result.tryPromise({
      try: () => Bun.password.verify(password, config.passwordHash),
      catch: () => authFailure("unavailable", "Password verification is unavailable"),
    });
    passwordWork -= 1;
    return verified;
  }

  async function authenticate(
    request: Request,
    context: NativeAuthContext = {},
  ): Promise<Result<NativePrincipal, NativeAuthError>> {
    return Result.gen(async function* () {
      yield* transport(request);
      yield* checkNativeRequestOrigin(request, config.allowedOrigins, context);
      if (request.headers.has("authorization") && !nativeBearer(request)) {
        return Result.err(authFailure("unauthorized", "Session credential required"));
      }
      const token = nativeBearer(request) ?? nativeCookie(request, "lilac_native_session");
      if (!token) return Result.err(authFailure("unauthorized", "Authentication required"));
      const verified = yield* Result.await(
        Result.tryPromise({
          try: () =>
            jwtVerify(token, config.signingKey, {
              algorithms: ["HS256"],
              issuer: `lilac:${config.installationId}`,
              audience: config.installationId,
              subject: config.ownerUserId,
              currentDate: new Date(now() * 1000),
              requiredClaims: ["exp", "iat", "jti"],
            }),
          catch: () => authFailure("unauthorized", "Session credential is invalid or expired"),
        }),
      );
      const { exp, jti } = verified.payload;
      if (
        typeof exp !== "number" ||
        typeof jti !== "string" ||
        sessions.get(jti) !== exp ||
        exp <= now()
      ) {
        return Result.err(authFailure("unauthorized", "Session is no longer active"));
      }
      return Result.ok({
        userId: config.ownerUserId,
        providerUserId: config.username,
        provider: "local" as const,
        expiresAt: exp,
        sessionId: jti,
      });
    });
  }

  async function login(
    request: Request,
    clientKey: string,
  ): Promise<Result<NativeLogin, NativeAuthError>> {
    return Result.gen(async function* () {
      yield* transport(request);
      yield* checkNativeRequestOrigin(request, config.allowedOrigins, { mutation: true });
      yield* rateLimit(clientKey);
      if (request.method !== "POST")
        return Result.err(authFailure("forbidden", "Login requires POST"));
      const header = request.headers.get("authorization");
      if (!header?.startsWith("Basic ") || header.length > 8192)
        return Result.err(authFailure("unauthorized", "Basic credentials required"));
      const decoded = yield* Result.try({
        try: () =>
          new TextDecoder("utf-8", { fatal: true }).decode(
            Uint8Array.from(atob(header.slice(6)), (character) => character.charCodeAt(0)),
          ),
        catch: () => authFailure("unauthorized", "Invalid Basic credentials"),
      });
      const separator = decoded.indexOf(":");
      const username = decoded.slice(0, separator);
      const valid = yield* Result.await(verifyPassword(decoded.slice(separator + 1)));
      if (separator < 0 || username !== config.username || !valid)
        return Result.err(authFailure("unauthorized", "Invalid Basic credentials"));
      const issuedAt = now();
      const expiresAt = issuedAt + lifetime;
      const sessionId = crypto.randomUUID();
      const token = yield* Result.await(
        Result.tryPromise({
          try: () =>
            new SignJWT({})
              .setProtectedHeader({ alg: "HS256", typ: "JWT" })
              .setIssuer(`lilac:${config.installationId}`)
              .setAudience(config.installationId)
              .setSubject(config.ownerUserId)
              .setJti(sessionId)
              .setIssuedAt(issuedAt)
              .setExpirationTime(expiresAt)
              .sign(config.signingKey),
          catch: () => authFailure("unavailable", "Session signing is unavailable"),
        }),
      );
      sessions.set(sessionId, expiresAt);
      return Result.ok({
        principal: {
          userId: config.ownerUserId,
          providerUserId: config.username,
          provider: "local" as const,
          expiresAt,
          sessionId,
        },
        token,
        setCookie: nativeSessionCookie(token, new URL(request.url).protocol === "https:", lifetime),
      });
    });
  }

  async function reauthenticate(
    current: NativePrincipal,
    request: Request,
  ): Promise<Result<NativePrincipal, NativeAuthError>> {
    return (await authenticate(request, { socket: true })).andThen((fresh) =>
      sameNativePrincipal(current, fresh),
    );
  }

  async function logout(request: Request): Promise<Result<{ setCookie: string }, NativeAuthError>> {
    return Result.gen(async function* () {
      const principal = yield* Result.await(authenticate(request, { mutation: true }));
      sessions.delete(principal.sessionId);
      return Result.ok({
        setCookie: nativeSessionCookie("", new URL(request.url).protocol === "https:", 0),
      });
    });
  }

  return { authenticate, checkSession, login, reauthenticate, logout };
}
