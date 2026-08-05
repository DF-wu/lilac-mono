import path from "node:path";
import fs from "node:fs/promises";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

const githubAppSecretSchema = z.object({
  type: z.literal("github_app"),
  appId: z.coerce.number().int().positive(),
  installationId: z.coerce.number().int().positive(),
  /** Optional; used for gh (GH_HOST) and/or to derive apiBaseUrl. */
  host: z.string().min(1).optional(),
  /** Optional; used to mint tokens against GHES. Example: https://github.example.com/api/v3 */
  apiBaseUrl: z.url().optional(),
  /** Absolute path to the stored private key pem file. */
  privateKeyPath: z.string().min(1),
});

export type GithubAppSecret = z.infer<typeof githubAppSecretSchema>;

export class GithubAppSecretReadError extends TaggedError("GithubAppSecretReadError")<{
  readonly secretPath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

async function captureGithubAppFs<T, E>(
  run: () => Promise<T>,
  mapError: (cause: unknown) => E,
): Promise<ResultType<T, E>> {
  try {
    return Result.ok(await run());
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(mapError(cause));
  }
}

export function decodeGithubAppSecret(
  secretPath: string,
  value: unknown,
): ResultType<GithubAppSecret, GithubAppSecretReadError> {
  const decoded = githubAppSecretSchema.safeParse(value);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new GithubAppSecretReadError({
      secretPath,
      cause: decoded.error,
      message: `Invalid GitHub App secret at ${secretPath}`,
    }),
  );
}

export function resolveGithubAppSecretPaths(dataDir: string): {
  jsonPath: string;
  pemPath: string;
} {
  const secretDir = path.join(dataDir, "secret");
  return {
    jsonPath: path.join(secretDir, "github-app.json"),
    pemPath: path.join(secretDir, "github-app.private-key.pem"),
  };
}

async function ensureSecretDir(dataDir: string): Promise<void> {
  await fs.mkdir(path.join(dataDir, "secret"), { recursive: true });
}

async function chmod0600(p: string): Promise<void> {
  await captureGithubAppFs(
    () => fs.chmod(p, 0o600),
    (cause) => cause,
  );
}

export function deriveApiBaseUrl(input: { host?: string; apiBaseUrl?: string }): string {
  if (input.apiBaseUrl) return input.apiBaseUrl;
  const host = input.host;
  if (!host || host === "github.com") return "https://api.github.com";
  return `https://${host.replace(/^https?:\/\//, "")}/api/v3`;
}

export async function readGithubAppSecretResult(
  dataDir: string,
): Promise<ResultType<GithubAppSecret | null, GithubAppSecretReadError>> {
  const { jsonPath } = resolveGithubAppSecretPaths(dataDir);
  const file = Bun.file(jsonPath);
  const loaded = await captureGithubAppFs(
    async (): Promise<unknown | null> => {
      if (!(await file.exists())) return null;
      return JSON.parse(await file.text()) as unknown;
    },
    (cause) =>
      new GithubAppSecretReadError({
        secretPath: jsonPath,
        cause,
        message: `Invalid GitHub App secret at ${jsonPath}`,
      }),
  );
  if (loaded.status === "error") return Result.err(loaded.error);
  return loaded.value === null ? Result.ok(null) : decodeGithubAppSecret(jsonPath, loaded.value);
}

export async function readGithubAppSecret(dataDir: string): Promise<GithubAppSecret | null> {
  const read = await readGithubAppSecretResult(dataDir);
  if (read.status === "error") throw read.error;
  return read.value;
}

export async function writeGithubAppSecret(params: {
  dataDir: string;
  appId: number;
  installationId: number;
  host?: string;
  apiBaseUrl?: string;
  /** Raw PEM content. */
  privateKeyPem: string;
}): Promise<{ jsonPath: string; pemPath: string; overwritten: boolean }> {
  await ensureSecretDir(params.dataDir);
  const { jsonPath, pemPath } = resolveGithubAppSecretPaths(params.dataDir);
  const existed = await Bun.file(jsonPath).exists();

  await fs.writeFile(pemPath, params.privateKeyPem, "utf8");
  await chmod0600(pemPath);

  const secret: GithubAppSecret = {
    type: "github_app",
    appId: params.appId,
    installationId: params.installationId,
    host: params.host,
    apiBaseUrl: params.apiBaseUrl,
    privateKeyPath: pemPath,
  };

  await fs.writeFile(jsonPath, JSON.stringify(secret, null, 2), "utf8");
  await chmod0600(jsonPath);

  return { jsonPath, pemPath, overwritten: existed };
}

export async function clearGithubAppSecret(dataDir: string): Promise<void> {
  const { jsonPath, pemPath } = resolveGithubAppSecretPaths(dataDir);
  for (const secretPath of [jsonPath, pemPath]) {
    await captureGithubAppFs(
      () => fs.rm(secretPath, { force: true }),
      (cause) => cause,
    );
  }
}

export class GithubAppPrivateKeyReadError extends TaggedError("GithubAppPrivateKeyReadError")<{
  readonly privateKeyPath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export async function readGithubAppPrivateKeyPemResult(
  secret: GithubAppSecret,
): Promise<ResultType<string, GithubAppPrivateKeyReadError>> {
  const loaded = await captureGithubAppFs(
    () => Bun.file(secret.privateKeyPath).text(),
    (cause) =>
      new GithubAppPrivateKeyReadError({
        privateKeyPath: secret.privateKeyPath,
        cause,
        message: `Failed to read GitHub App private key: ${secret.privateKeyPath}`,
      }),
  );
  if (loaded.status === "error") return Result.err(loaded.error);
  const raw = loaded.value;
  if (!raw.trim()) {
    return Result.err(
      new GithubAppPrivateKeyReadError({
        privateKeyPath: secret.privateKeyPath,
        cause: new Error("GitHub App private key is empty"),
        message: `GitHub App private key is empty: ${secret.privateKeyPath}`,
      }),
    );
  }
  return Result.ok(raw);
}

export async function readGithubAppPrivateKeyPem(secret: GithubAppSecret): Promise<string> {
  const loaded = await readGithubAppPrivateKeyPemResult(secret);
  if (loaded.status === "error") throw loaded.error;
  return loaded.value;
}
