import { createHash } from "node:crypto";
import { join } from "node:path";
import { Result, TaggedError } from "better-result";
import * as oauth from "oauth4webapi";
import { z } from "zod";
import { decodeTuiCredential, type TuiCredential } from "./persistence-codec";
import {
  readPrivateFile,
  removePrivateFile,
  writePrivateFile,
  type TuiFileError,
} from "./private-file";

export class TuiAuthError extends TaggedError("TuiAuthError")<{
  code: "login" | "network" | "configuration" | "storage" | "canceled";
  message: string;
}> {}
export type TuiAuthOptions = {
  baseUrl: string;
  credentialDirectory: string;
  requestLocalCredentials: () => Promise<{ username: string; password: string }>;
  openBrowser: (url: string) => Promise<void>;
  signal?: AbortSignal;
  forceLogin?: boolean;
};
export interface TuiAuthSession {
  readonly provider: "local" | "clerk";
  readonly token: string;
  readonly expiresAt: number;
  authorization(): string;
  dispose(): void;
  refresh(): Promise<Result<void, TuiAuthError>>;
  logout(): Promise<Result<void, TuiAuthError>>;
}
const authInfoSchema = z.object({
  provider: z.enum(["local", "clerk"]),
  issuer: z.url().optional(),
  oauthClientId: z.string().optional(),
});
const localTokenSchema = z.strictObject({
  token: z.string().min(1),
  expiresAt: z.number().positive(),
});
function failure(code: TuiAuthError["code"], message: string): TuiAuthError {
  return new TuiAuthError({ code, message });
}
export function decodeTuiAuthInfo(
  value: unknown,
): Result<z.infer<typeof authInfoSchema>, TuiAuthError> {
  const parsed = authInfoSchema.safeParse(value);
  if (!parsed.success)
    return Result.err(
      failure("configuration", "Server authentication is incompatible. Update Lilac."),
    );
  return Result.ok(parsed.data);
}
export function decodeTuiLocalToken(
  value: unknown,
): Result<z.infer<typeof localTokenSchema>, TuiAuthError> {
  const parsed = localTokenSchema.safeParse(value);
  if (!parsed.success) return Result.err(failure("network", "Invalid login response"));
  return Result.ok(parsed.data);
}
function credentialPath(options: TuiAuthOptions): string {
  return join(
    options.credentialDirectory,
    `${createHash("sha256").update(options.baseUrl).digest("hex")}-v1.json`,
  );
}
async function savedCredential(
  options: TuiAuthOptions,
): Promise<Result<TuiCredential | undefined, TuiFileError>> {
  if (options.forceLogin) return Result.ok(undefined);
  const loaded = await readPrivateFile(credentialPath(options), 65536);
  return loaded.map((text) => {
    if (!text) return undefined;
    return decodeTuiCredential({ version: 1, data: text }).match({
      ok: (decoded) => decoded.value,
      err: () => undefined,
    });
  });
}
async function persist(
  options: TuiAuthOptions,
  credential: TuiCredential,
): Promise<Result<void, TuiAuthError>> {
  return (await writePrivateFile(credentialPath(options), JSON.stringify(credential))).mapError(
    () => failure("storage", "Cannot save login credentials"),
  );
}
async function localLogin(options: TuiAuthOptions): Promise<Result<TuiCredential, TuiAuthError>> {
  return Result.gen(async function* () {
    const credentials = yield* Result.await(
      Result.tryPromise({
        try: options.requestLocalCredentials,
        catch: () => failure("canceled", "Login canceled"),
      }),
    );
    const response = yield* Result.await(
      Result.tryPromise({
        try: () =>
          fetch(new URL("/api/auth/login", options.baseUrl), {
            method: "POST",
            headers: {
              Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`,
            },
            signal: options.signal,
          }),
        catch: () => failure("network", "Cannot reach native login"),
      }),
    );
    if (!response.ok)
      return Result.err(
        failure(
          "login",
          response.status === 429 ? "Too many login attempts. Try again shortly." : "Login failed",
        ),
      );
    const data = yield* Result.await(
      Result.tryPromise({
        try: (): Promise<unknown> => response.json(),
        catch: () => failure("network", "Invalid login response"),
      }),
    );
    const parsed = yield* decodeTuiLocalToken(data);
    return Result.ok({
      version: 1 as const,
      baseUrl: options.baseUrl,
      provider: "local" as const,
      ...parsed,
    });
  });
}
async function discover(
  issuer: string,
  signal?: AbortSignal,
): Promise<Result<oauth.AuthorizationServer, TuiAuthError>> {
  return Result.tryPromise({
    try: async () => {
      const url = new URL(issuer);
      const response = await oauth.discoveryRequest(url, { signal });
      return oauth.processDiscoveryResponse(url, response);
    },
    catch: () => failure("network", "Cannot discover Clerk OAuth endpoints"),
  });
}
function tokenCredential(
  options: TuiAuthOptions,
  issuer: string,
  clientId: string,
  response: oauth.TokenEndpointResponse,
  oldRefresh?: string,
): Result<TuiCredential, TuiAuthError> {
  if (
    !response.expires_in ||
    response.expires_in <= 0 ||
    response.token_type.toLowerCase() !== "bearer"
  )
    return Result.err(
      failure("configuration", "Clerk must return an expiring bearer access token"),
    );
  return Result.ok({
    version: 1,
    baseUrl: options.baseUrl,
    provider: "clerk",
    issuer,
    clientId,
    token: response.access_token,
    expiresAt: Math.floor(Date.now() / 1000) + response.expires_in,
    refreshToken: response.refresh_token ?? oldRefresh,
  });
}
export async function clerkLogin(
  options: TuiAuthOptions,
  issuer: string,
  clientId: string,
): Promise<Result<TuiCredential, TuiAuthError>> {
  return Result.gen(async function* () {
    const server = yield* Result.await(discover(issuer, options.signal));
    if (!server.authorization_endpoint)
      return Result.err(failure("configuration", "Clerk OAuth authorization is unavailable"));
    const client = { client_id: clientId };
    const verifier = oauth.generateRandomCodeVerifier();
    const state = oauth.generateRandomState();
    const challenge = yield* Result.await(
      Result.tryPromise({
        try: () => oauth.calculatePKCECodeChallenge(verifier),
        catch: () => failure("configuration", "PKCE is unavailable"),
      }),
    );
    const callback = Promise.withResolvers<URL | undefined>();
    const listener = yield* Result.try({
      try: () =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request) {
            const url = new URL(request.url);
            if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
            if (url.searchParams.get("state") !== state)
              return new Response("Invalid login state", { status: 400 });
            callback.resolve(url);
            return new Response("You can return to Lilac.", {
              headers: { "content-type": "text/plain", "cache-control": "no-store" },
            });
          },
        }),
      catch: () =>
        failure(
          "configuration",
          "Cannot open loopback callback. Run locally or forward the callback port.",
        ),
    });
    const redirectUri = `http://127.0.0.1:${listener.port}/callback`;
    const url = new URL(server.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: "openid profile offline_access",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    const timer = setTimeout(() => callback.resolve(undefined), 180000);
    const abort = () => callback.resolve(undefined);
    options.signal?.addEventListener("abort", abort, { once: true });
    const opened = await Result.tryPromise({
      try: () => options.openBrowser(url.href),
      catch: () => failure("configuration", "Cannot open browser for login"),
    });
    const openFailure = opened.match({ ok: () => undefined, err: (error) => error });
    if (openFailure) callback.resolve(undefined);
    if (options.signal?.aborted) callback.resolve(undefined);
    const responseUrl = await callback.promise;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    await listener.stop(true);
    if (openFailure) return Result.err(openFailure);
    if (!responseUrl)
      return Result.err(
        failure(
          "canceled",
          "Login canceled or timed out. For SSH, run locally or forward the callback port.",
        ),
      );
    const tokens = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          const params = oauth.validateAuthResponse(server, client, responseUrl, state);
          const response = await oauth.authorizationCodeGrantRequest(
            server,
            client,
            oauth.None(),
            params,
            redirectUri,
            verifier,
            { signal: options.signal },
          );
          return oauth.processAuthorizationCodeResponse(server, client, response);
        },
        catch: () => failure("login", "Clerk authorization failed"),
      }),
    );
    return tokenCredential(options, issuer, clientId, tokens);
  });
}
async function refreshCredential(
  options: TuiAuthOptions,
  credential: TuiCredential,
): Promise<Result<TuiCredential, TuiAuthError>> {
  if (credential.provider === "local")
    return Result.err(failure("login", "Local session expired. Sign in again."));
  return Result.gen(async function* () {
    if (!credential.issuer || !credential.clientId || !credential.refreshToken)
      return Result.err(failure("login", "Clerk session expired. Sign in again."));
    const issuer = credential.issuer,
      clientId = credential.clientId,
      refreshToken = credential.refreshToken;
    const server = yield* Result.await(discover(issuer, options.signal));
    const tokens = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          const client = { client_id: clientId };
          const response = await oauth.refreshTokenGrantRequest(
            server,
            client,
            oauth.None(),
            refreshToken,
            { signal: options.signal },
          );
          return oauth.processRefreshTokenResponse(server, client, response);
        },
        catch: (error) =>
          error instanceof oauth.ResponseBodyError && error.status < 500
            ? failure("login", "Clerk refresh failed. Sign in again.")
            : failure("network", "Clerk refresh is temporarily unavailable"),
      }),
    );
    return tokenCredential(options, issuer, clientId, tokens, refreshToken);
  });
}
async function revokeClerkRefresh(
  credential: TuiCredential,
  signal: AbortSignal,
): Promise<Result<void, TuiAuthError>> {
  return Result.gen(async function* () {
    if (!credential.refreshToken) return Result.ok();
    if (!credential.issuer || !credential.clientId)
      return Result.err(failure("configuration", "Clerk refresh revocation is not configured"));
    const server = yield* Result.await(discover(credential.issuer, signal));
    if (!server.revocation_endpoint)
      return Result.err(
        failure(
          "configuration",
          "Clerk does not advertise revocation; local credentials were removed",
        ),
      );
    const client = { client_id: credential.clientId };
    const token = credential.refreshToken;
    return await Result.tryPromise({
      try: async () => {
        const response = await oauth.revocationRequest(server, client, oauth.None(), token, {
          signal,
          additionalParameters: { token_type_hint: "refresh_token" },
        });
        await oauth.processRevocationResponse(response);
      },
      catch: () => failure("network", "Clerk revocation failed; local credentials were removed"),
    });
  });
}
async function revoke(
  options: TuiAuthOptions,
  credential: TuiCredential,
): Promise<Result<void, TuiAuthError>> {
  const signal = AbortSignal.timeout(15000);
  const response = await Result.tryPromise({
    try: () =>
      fetch(new URL("/api/auth/logout", options.baseUrl), {
        method: "POST",
        headers: { Authorization: `Bearer ${credential.token}` },
        signal,
      }),
    catch: () => failure("network", "Logout could not reach the server"),
  });
  const native = response.andThen((reply) =>
    reply.ok || reply.status === 401
      ? Result.ok()
      : Result.err(failure("network", "Server logout failed")),
  );
  if (credential.provider === "local") return native;
  // Clerk JWT access tokens cannot be revoked upstream. Native logout invalidates the current token locally.
  const provider = await revokeClerkRefresh(credential, AbortSignal.timeout(15000));
  return native.andThen(() => provider);
}
export async function createTuiAuth(
  input: TuiAuthOptions,
): Promise<Result<TuiAuthSession, TuiAuthError>> {
  const lifetime = new AbortController();
  const options = {
    ...input,
    signal: input.signal ? AbortSignal.any([input.signal, lifetime.signal]) : lifetime.signal,
  };
  return Result.gen(async function* () {
    const url = yield* Result.try({
      try: () => new URL(options.baseUrl),
      catch: () => failure("configuration", "Invalid native server URL"),
    });
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        ["https:"].includes(url.protocol) ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      )
    )
      return Result.err(
        failure("configuration", "Use HTTPS, or HTTP on loopback, without URL credentials"),
      );
    const info = yield* Result.await(
      Result.tryPromise({
        try: async (): Promise<unknown> => {
          const response = await fetch(new URL("/api/auth/info", url), { signal: options.signal });
          return response.json();
        },
        catch: () => failure("network", "Cannot reach native authentication"),
      }),
    );
    const parsed = yield* decodeTuiAuthInfo(info);
    let credential = yield* (await savedCredential(options)).mapError(() =>
      failure("storage", "Cannot read login credentials"),
    );
    if (credential?.baseUrl !== options.baseUrl || credential?.provider !== parsed.provider)
      credential = undefined;
    if (
      credential?.provider === "clerk" &&
      (credential.issuer !== parsed.issuer || credential.clientId !== parsed.oauthClientId)
    )
      credential = undefined;
    const grace = credential?.provider === "clerk" ? 30 : 0;
    if (credential && credential.expiresAt <= Date.now() / 1000 + grace) {
      const refreshed = (await refreshCredential(options, credential)).match<
        { value: TuiCredential } | { error: TuiAuthError }
      >({ ok: (value) => ({ value }), err: (error) => ({ error }) });
      if ("error" in refreshed && refreshed.error.code !== "login")
        return Result.err(refreshed.error);
      credential = "value" in refreshed ? refreshed.value : undefined;
    }
    if (!credential) {
      if (parsed.provider === "local") credential = yield* Result.await(localLogin(options));
      else {
        if (!parsed.issuer || !parsed.oauthClientId)
          return Result.err(
            failure(
              "configuration",
              "Configure a public Clerk OAuth client with PKCE for terminal login",
            ),
          );
        credential = yield* Result.await(clerkLogin(options, parsed.issuer, parsed.oauthClientId));
      }
    }
    yield* Result.await(persist(options, credential));
    let current = credential;
    let inflight: Promise<Result<void, TuiAuthError>> | undefined;
    let loggedOut = false;
    async function refresh(): Promise<Result<void, TuiAuthError>> {
      if (loggedOut) return Result.err(failure("login", "Signed out"));
      const grace = current.provider === "clerk" ? 30 : 0;
      if (current.expiresAt > Date.now() / 1000 + grace) return Result.ok();
      if (inflight) return inflight;
      async function perform(): Promise<Result<void, TuiAuthError>> {
        return Result.gen(async function* () {
          const updated = yield* Result.await(refreshCredential(options, current));
          current = updated;
          if (loggedOut) return Result.err(failure("login", "Signed out"));
          yield* Result.await(persist(options, updated));
          return Result.ok();
        });
      }
      inflight = perform();
      const result = await inflight;
      inflight = undefined;
      return result;
    }
    async function logout(): Promise<Result<void, TuiAuthError>> {
      loggedOut = true;
      await inflight;
      const cleared = await removePrivateFile(credentialPath(options));
      const revoked = await revoke(options, current);
      current = { ...current, token: "", refreshToken: undefined, expiresAt: 0 };
      return cleared
        .mapError(() => failure("storage", "Cannot remove login credentials"))
        .andThen(() => revoked);
    }
    return Result.ok({
      get provider() {
        return current.provider;
      },
      get token() {
        return current.token;
      },
      get expiresAt() {
        return current.expiresAt;
      },
      authorization: () => `Bearer ${current.token}`,
      dispose: () => lifetime.abort(),
      refresh,
      logout,
    });
  });
}
