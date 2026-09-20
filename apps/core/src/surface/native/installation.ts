import { Database } from "bun:sqlite";
import path from "node:path";
import type { NativeSurfaceConfig } from "@stanley2058/lilac-utils";
import { Result, TaggedError } from "better-result";
import { NativeStore, type NativeStoreError } from "./store";
import type { NativeAuthenticator, NativeAuthError, NativeLogin } from "./auth";
import { authFailure } from "./auth";
import { createNativeLocalAuthenticator } from "./auth-local";
import { createNativeClerkAuthenticator, type NativeClerkAuthenticator } from "./auth-clerk";

export class NativeInstallationFailed extends TaggedError("NativeInstallationFailed")<{
  readonly message: string;
}> {}

export type NativeInstallationError = NativeInstallationFailed | NativeStoreError | NativeAuthError;
export type NativeInstallationSecrets = {
  localUsername?: string;
  localPasswordHash?: string;
  sessionSecret?: string;
  clerkSecretKey?: string;
  clerkPublishableKey?: string;
  clerkJwtKey?: string;
};
export type NativeInstallation = {
  database: Database;
  store: NativeStore;
  auth: NativeAuthenticator;
  clerk?: NativeClerkAuthenticator;
  login?: (request: Request, clientKey: string) => Promise<Result<NativeLogin, NativeAuthError>>;
};

export async function openNativeInstallation(input: {
  config: NativeSurfaceConfig;
  secrets: NativeInstallationSecrets;
  dataDir: string;
}): Promise<Result<NativeInstallation, NativeInstallationError>> {
  return Result.gen(async function* () {
    yield* Result.await(validateNativeInstallation(input.config, input.secrets));
    const database = yield* Result.try({
      try: () => new Database(path.join(input.dataDir, "native-surface.db"), { create: true }),
      catch: () => new NativeInstallationFailed({ message: "Cannot open native surface storage" }),
    });
    const initialized = await initializeNativeInstallation(database, input);
    const failed = initialized.match({ ok: () => false, err: () => true });
    if (failed) {
      yield* Result.try({
        try: () => database.close(),
        catch: () =>
          new NativeInstallationFailed({ message: "Cannot close native surface storage" }),
      });
    }
    return initialized;
  });
}

async function validateNativeInstallation(
  config: NativeSurfaceConfig,
  secrets: NativeInstallationSecrets,
): Promise<Result<void, NativeInstallationFailed>> {
  if (!config.enabled || !config.installationId || config.auth.ownerId === "lilac") {
    return Result.err(
      new NativeInstallationFailed({ message: "Native installation configuration is invalid" }),
    );
  }
  if (config.auth.provider === "clerk") {
    if (
      !secrets.clerkSecretKey ||
      !secrets.clerkPublishableKey ||
      !config.auth.ownerProviderUserId ||
      !config.auth.clerkIssuer
    ) {
      return Result.err(
        new NativeInstallationFailed({ message: "Native Clerk authentication is not configured" }),
      );
    }
    return Result.ok();
  }
  const username = secrets.localUsername ?? "owner";
  if (
    !username ||
    username.includes(":") ||
    username.length > 256 ||
    !secrets.localPasswordHash ||
    !/^\$argon2id\$v=19\$m=[1-9]\d*,t=[1-9]\d*,p=[1-9]\d*\$[A-Za-z0-9+/]{11,}\$[A-Za-z0-9+/]{22,}$/.test(
      secrets.localPasswordHash ?? "",
    ) ||
    new TextEncoder().encode(secrets.sessionSecret ?? "").byteLength < 32
  ) {
    return Result.err(
      new NativeInstallationFailed({
        message:
          "Native local authentication requires an Argon2id password hash and a session secret of at least 32 bytes",
      }),
    );
  }
  const passwordHash = secrets.localPasswordHash;
  return (
    await Result.tryPromise({
      try: () => Bun.password.verify("", passwordHash),
      catch: () =>
        new NativeInstallationFailed({ message: "Native local password hash is invalid" }),
    })
  ).map(() => undefined);
}

export function canonicalNativeAuthRequest(request: Request, publicUrl: string): Request {
  const incoming = new URL(request.url);
  const canonical = new URL(publicUrl);
  canonical.pathname = incoming.pathname;
  canonical.search = incoming.search;
  canonical.hash = "";
  const headers = new Headers(request.headers);
  headers.delete("forwarded");
  for (const key of Array.from(headers.keys()))
    if (key.toLowerCase().startsWith("x-forwarded-")) headers.delete(key);
  headers.set("host", canonical.host);
  return new Request(canonical, { method: request.method, headers, signal: request.signal });
}

function canonicalAuthenticator(auth: NativeAuthenticator, publicUrl: string): NativeAuthenticator {
  return {
    checkSession: (principal) => auth.checkSession(principal),
    authenticate: (request, context) =>
      auth.authenticate(canonicalNativeAuthRequest(request, publicUrl), context),
    reauthenticate: (principal, request) =>
      auth.reauthenticate(principal, canonicalNativeAuthRequest(request, publicUrl)),
    logout: (request) => auth.logout(canonicalNativeAuthRequest(request, publicUrl)),
  };
}

async function initializeNativeInstallation(
  database: Database,
  input: {
    config: NativeSurfaceConfig;
    secrets: NativeInstallationSecrets;
    dataDir: string;
  },
): Promise<Result<NativeInstallation, NativeInstallationError>> {
  const { config, secrets } = input;
  const store = new NativeStore(database);
  return Result.gen(async function* () {
    yield* store.initialize();
    const providerId =
      config.auth.provider === "local"
        ? (secrets.localUsername ?? "owner")
        : config.auth.ownerProviderUserId;
    if (!providerId)
      return Result.err(
        new NativeInstallationFailed({ message: "Native owner provider identity is required" }),
      );
    const owner = yield* store.findUserByProviderId(providerId);
    yield* store.upsertUser({
      ...owner,
      id: config.auth.ownerId,
      providerId,
      displayName: owner?.displayName ?? "Owner",
      role: "owner",
      toolMode: "full",
    });
    const serviceUser = yield* store.findUserByProviderId("service:lilac");
    yield* store.upsertUser({
      ...serviceUser,
      id: "lilac",
      providerId: "service:lilac",
      displayName: serviceUser?.displayName ?? "Lilac",
      role: "service",
      toolMode: "full",
    });
    if (config.auth.provider === "local") {
      if (!secrets.localPasswordHash || !secrets.sessionSecret || !config.installationId) {
        return Result.err(
          new NativeInstallationFailed({
            message: "Native local authentication secrets are not configured",
          }),
        );
      }
      const auth = createNativeLocalAuthenticator({
        ownerUserId: config.auth.ownerId,
        username: providerId,
        passwordHash: secrets.localPasswordHash,
        signingKey: new TextEncoder().encode(secrets.sessionSecret),
        installationId: config.installationId,
        allowedOrigins: config.allowedOrigins,
      });
      return Result.ok({
        database,
        store,
        auth: canonicalAuthenticator(auth, config.publicUrl),
        login: (request: Request, clientKey: string) =>
          auth.login(canonicalNativeAuthRequest(request, config.publicUrl), clientKey),
      });
    }
    if (!secrets.clerkSecretKey || !secrets.clerkPublishableKey || !config.auth.clerkIssuer) {
      return Result.err(
        new NativeInstallationFailed({ message: "Native Clerk authentication is not configured" }),
      );
    }
    const clerk = yield* Result.await(
      createNativeClerkAuthenticator({
        secretKey: secrets.clerkSecretKey,
        publishableKey: secrets.clerkPublishableKey,
        jwtKey: secrets.clerkJwtKey,
        issuer: config.auth.clerkIssuer,
        oauthClientId: config.auth.clerkOAuthClientId,
        allowedOrigins: config.allowedOrigins,
        resolveUser: async (providerUserId) =>
          store
            .findUserByProviderId(providerUserId)
            .mapError(() => authFailure("unavailable", "User directory is unavailable"))
            .andThen((user) =>
              user && user.role !== "service"
                ? Result.ok({ userId: user.id })
                : Result.err(authFailure("forbidden", "The owner has not added this participant")),
            ),
      }),
    );
    return Result.ok({
      database,
      store,
      auth: canonicalAuthenticator(clerk, config.publicUrl),
      clerk,
    });
  });
}
