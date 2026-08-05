import { createAppAuth } from "@octokit/auth-app";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import {
  deriveApiBaseUrl,
  readGithubAppPrivateKeyPemResult,
  readGithubAppSecretResult,
  type GithubAppSecret,
} from "./github-app";

type InstallationToken = {
  token: string;
  expiresAtMs: number;
  host?: string;
  apiBaseUrl: string;
  fingerprint: string;
};

let cached: InstallationToken | null = null;
export class GithubAppTokenUnavailable extends TaggedError("GithubAppTokenUnavailable")<{
  readonly cause?: unknown;
  readonly message: string;
}> {}

export class GithubAppTokenMintFailed extends TaggedError("GithubAppTokenMintFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export type GithubAppTokenError = GithubAppTokenUnavailable | GithubAppTokenMintFailed;

let pending: Promise<ResultType<InstallationToken, GithubAppTokenError>> | null = null;

async function captureGithubAppAuth<T>(
  run: () => Promise<T>,
): Promise<ResultType<T, GithubAppTokenMintFailed>> {
  try {
    return Result.ok(await run());
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new GithubAppTokenMintFailed({
        cause,
        message: "Failed to mint GitHub App installation token",
      }),
    );
  }
}

function fingerprintSecret(secret: GithubAppSecret): string {
  return [
    secret.appId,
    secret.installationId,
    secret.host ?? "",
    secret.apiBaseUrl ?? "",
    secret.privateKeyPath,
  ].join("|");
}

function parseExpiresAtMs(
  expiresAt: string | undefined,
): ResultType<number, GithubAppTokenMintFailed> {
  if (!expiresAt) {
    return Result.err(
      new GithubAppTokenMintFailed({
        cause: new Error("GitHub App token missing expiresAt"),
        message: "GitHub App token missing expiresAt",
      }),
    );
  }
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) {
    return Result.err(
      new GithubAppTokenMintFailed({
        cause: new Error("GitHub App token has invalid expiresAt"),
        message: `GitHub App token has invalid expiresAt: ${expiresAt}`,
      }),
    );
  }
  return Result.ok(ms);
}

export async function getGithubInstallationTokenResult(params: {
  dataDir: string;
}): Promise<ResultType<Omit<InstallationToken, "fingerprint">, GithubAppTokenError>> {
  const secretResult = await readGithubAppSecretResult(params.dataDir);
  if (secretResult.status === "error") {
    return Result.err(
      new GithubAppTokenUnavailable({
        cause: secretResult.error,
        message: secretResult.error.message,
      }),
    );
  }
  const secret = secretResult.value;
  if (!secret) {
    return Result.err(
      new GithubAppTokenUnavailable({
        message: "GitHub App not configured (run onboarding.github_app mode=configure)",
      }),
    );
  }

  const apiBaseUrl = deriveApiBaseUrl({
    host: secret.host,
    apiBaseUrl: secret.apiBaseUrl,
  });
  const fp = fingerprintSecret(secret);

  const now = Date.now();
  if (
    cached &&
    cached.fingerprint === fp &&
    cached.apiBaseUrl === apiBaseUrl &&
    cached.expiresAtMs - now > 60_000
  ) {
    return Result.ok({
      token: cached.token,
      expiresAtMs: cached.expiresAtMs,
      host: cached.host,
      apiBaseUrl: cached.apiBaseUrl,
    });
  }

  if (pending) {
    const resolved = await pending;
    if (resolved.status === "error") return Result.err(resolved.error);
    const t = resolved.value;
    return Result.ok({
      token: t.token,
      expiresAtMs: t.expiresAtMs,
      host: t.host,
      apiBaseUrl: t.apiBaseUrl,
    });
  }

  pending = (async () => {
    const privateKey = await readGithubAppPrivateKeyPemResult(secret);
    if (privateKey.status === "error") {
      return Result.err(
        new GithubAppTokenMintFailed({
          cause: privateKey.error,
          message: privateKey.error.message,
        }),
      );
    }
    const auth = createAppAuth({
      appId: secret.appId,
      privateKey: privateKey.value,
      installationId: secret.installationId,
      baseUrl: apiBaseUrl,
    });

    const authenticated = await captureGithubAppAuth(() => auth({ type: "installation" }));
    if (authenticated.status === "error") return Result.err(authenticated.error);
    const res = authenticated.value;
    const token = res.token;
    if (typeof token !== "string" || token.length === 0) {
      return Result.err(
        new GithubAppTokenMintFailed({
          cause: new Error("GitHub App installation token missing"),
          message: "Failed to mint GitHub App installation token",
        }),
      );
    }

    const expiresAtMs = parseExpiresAtMs(res.expiresAt);
    if (expiresAtMs.status === "error") return Result.err(expiresAtMs.error);

    const t: InstallationToken = {
      token,
      expiresAtMs: expiresAtMs.value,
      host: secret.host,
      apiBaseUrl,
      fingerprint: fp,
    };
    cached = t;
    return Result.ok(t);
  })();

  try {
    const resolved = await pending;
    if (resolved.status === "error") return Result.err(resolved.error);
    const t = resolved.value;
    return Result.ok({
      token: t.token,
      expiresAtMs: t.expiresAtMs,
      host: t.host,
      apiBaseUrl: t.apiBaseUrl,
    });
  } finally {
    pending = null;
  }
}

export async function getGithubInstallationTokenOrThrow(params: { dataDir: string }): Promise<{
  token: string;
  expiresAtMs: number;
  host?: string;
  apiBaseUrl: string;
}> {
  const token = await getGithubInstallationTokenResult(params);
  if (token.status === "error") throw token.error;
  return token.value;
}
