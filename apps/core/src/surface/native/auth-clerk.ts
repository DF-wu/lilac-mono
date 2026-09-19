import { Result } from "better-result";
import { decodeJwt } from "jose";
import { z } from "zod";
import {
  authFailure,
  checkNativeRequestOrigin,
  sameNativePrincipal,
  type NativeAuthenticator,
  type NativeAuthContext,
  type NativeAuthError,
  type NativePrincipal,
} from "./auth";

export type NativeClerkAuthConfig = {
  secretKey: string;
  publishableKey: string;
  jwtKey?: string;
  issuer: string;
  oauthClientId?: string;
  allowedOrigins: readonly string[];
  resolveUser: (providerUserId: string) => Promise<Result<{ userId: string }, NativeAuthError>>;
};

export type NativeProviderUser = { providerUserId: string; displayName: string };

export interface NativeClerkAuthenticator extends NativeAuthenticator {
  lookupUsers(query: string): Promise<Result<NativeProviderUser[], NativeAuthError>>;
  lookupUser(providerUserId: string): Promise<Result<NativeProviderUser, NativeAuthError>>;
}

const tokenClaims = z.object({
  exp: z.number().int().positive(),
  iss: z.string(),
  sub: z.string().min(1),
  azp: z.string().optional(),
});

export function decodeNativeClerkClaims(
  token: string,
): Result<z.infer<typeof tokenClaims>, NativeAuthError> {
  return Result.gen(function* () {
    const decoded = yield* Result.try({
      try: () => decodeJwt(token),
      catch: () => authFailure("unauthorized", "JWT access token required"),
    });
    const parsed = tokenClaims.safeParse(decoded);
    if (!parsed.success)
      return Result.err(authFailure("unauthorized", "Token claims are incomplete"));
    return Result.ok(parsed.data);
  });
}

export async function createNativeClerkAuthenticator(
  config: NativeClerkAuthConfig,
): Promise<Result<NativeClerkAuthenticator, NativeAuthError>> {
  return Result.gen(async function* () {
    const sdk = yield* Result.await(
      Result.tryPromise({
        try: () => import("@clerk/backend"),
        catch: () => authFailure("unavailable", "Authentication provider is unavailable"),
      }),
    );
    const client = yield* Result.try({
      try: () =>
        sdk.createClerkClient({
          secretKey: config.secretKey,
          publishableKey: config.publishableKey,
          jwtKey: config.jwtKey,
        }),
      catch: () => authFailure("unavailable", "Authentication provider is not configured"),
    });
    const revoked = new Map<string, number>();

    async function lookupUsers(
      query: string,
    ): Promise<Result<NativeProviderUser[], NativeAuthError>> {
      if (query.length > 256)
        return Result.err(authFailure("forbidden", "User search is too long"));
      const users = await Result.tryPromise({
        try: () => client.users.getUserList({ query, limit: 25, orderBy: "+first_name" }),
        catch: () => authFailure("unavailable", "Provider user directory is unavailable"),
      });
      return users.map(({ data }) =>
        data.map((user) => ({
          providerUserId: user.id,
          displayName:
            [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || user.id,
        })),
      );
    }

    async function lookupUser(
      providerUserId: string,
    ): Promise<Result<NativeProviderUser, NativeAuthError>> {
      const user = await Result.tryPromise({
        try: () => client.users.getUser(providerUserId),
        catch: () => authFailure("unavailable", "Provider user is unavailable"),
      });
      return user.map((value) => ({
        providerUserId: value.id,
        displayName:
          [value.firstName, value.lastName].filter(Boolean).join(" ") || value.username || value.id,
      }));
    }

    function checkSession(principal: NativePrincipal): Result<void, NativeAuthError> {
      if (
        principal.provider !== "clerk" ||
        principal.expiresAt <= Math.floor(Date.now() / 1000) ||
        revoked.has(principal.sessionId)
      ) {
        return Result.err(authFailure("unauthorized", "Session is no longer active"));
      }
      return Result.ok();
    }

    async function authenticate(
      request: Request,
      context: NativeAuthContext = {},
    ): Promise<Result<NativePrincipal, NativeAuthError>> {
      return Result.gen(async function* () {
        yield* checkNativeRequestOrigin(request, config.allowedOrigins, context);
        const state = yield* Result.await(
          Result.tryPromise({
            try: () =>
              client.authenticateRequest(request, {
                acceptsToken: config.oauthClientId
                  ? ["session_token", "oauth_token"]
                  : ["session_token"],
                jwtKey: config.jwtKey,
                clockSkewInMs: 0,
              }),
            catch: () => authFailure("unavailable", "Authentication provider is unavailable"),
          }),
        );
        if (state.status === "handshake")
          return Result.err(authFailure("handshake", "Refresh the provider session"));
        if (state.status !== "signed-in") {
          if (state.reason === "session-token-expired") {
            return Result.err(authFailure("expired", "Refresh the provider session"));
          }
          const unavailable = [
            "unexpected-error",
            "jwk-remote-failed-to-load",
            "jwk-failed-to-resolve",
            "jwk-local-missing",
            "jwk-remote-invalid",
          ].includes(state.reason);
          const code = unavailable ? "unavailable" : "unauthorized";
          return Result.err(authFailure(code, "Provider authentication did not succeed"));
        }
        const identity = state.toAuth();
        if (!identity.isAuthenticated)
          return Result.err(authFailure("unauthorized", "Provider session is not active"));
        const claims = yield* decodeNativeClerkClaims(state.token);
        const now = Math.floor(Date.now() / 1000);
        if (claims.iss !== config.issuer || claims.exp <= now || claims.sub !== identity.userId) {
          return Result.err(authFailure("unauthorized", "Token identity or expiry is invalid"));
        }
        if (
          identity.tokenType === "session_token" &&
          (!claims.azp || !config.allowedOrigins.includes(claims.azp))
        ) {
          return Result.err(authFailure("forbidden", "Session authorized party is not allowed"));
        }
        if (
          identity.tokenType === "oauth_token" &&
          (!config.oauthClientId || identity.clientId !== config.oauthClientId)
        ) {
          return Result.err(authFailure("forbidden", "OAuth client is not allowed"));
        }
        const sessionId = identity.tokenType === "session_token" ? identity.sessionId : identity.id;
        if (
          !sessionId ||
          (identity.tokenType === "session_token" && !sessionId.startsWith("sess_"))
        ) {
          return Result.err(
            authFailure("unauthorized", "Session or access-token identity required"),
          );
        }
        for (const [id, expiry] of revoked) if (expiry <= now) revoked.delete(id);
        if (revoked.has(sessionId))
          return Result.err(authFailure("unauthorized", "Session has been logged out"));
        const user = yield* Result.await(config.resolveUser(identity.userId));
        return Result.ok({
          userId: user.userId,
          providerUserId: identity.userId,
          provider: "clerk" as const,
          expiresAt: claims.exp,
          sessionId,
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

    async function logout(
      request: Request,
    ): Promise<Result<{ setCookie: string }, NativeAuthError>> {
      return Result.gen(async function* () {
        const principal = yield* Result.await(authenticate(request, { mutation: true }));
        revoked.set(principal.sessionId, principal.expiresAt);
        if (principal.sessionId.startsWith("sess_")) {
          yield* Result.await(
            Result.tryPromise({
              try: () => client.sessions.revokeSession(principal.sessionId),
              catch: () => authFailure("unavailable", "Provider session revocation is unavailable"),
            }),
          );
        }
        return Result.ok({
          setCookie: "__session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
        });
      });
    }

    return Result.ok({
      authenticate,
      checkSession,
      reauthenticate,
      logout,
      lookupUsers,
      lookupUser,
    });
  });
}
