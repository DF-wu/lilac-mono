import path from "node:path";
import fs from "node:fs/promises";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

const githubUserTokenSecretSchema = z.object({
  type: z.literal("github_user_token"),
  token: z.string().min(1),
  /** Optional; used for gh (GH_HOST) and/or to derive apiBaseUrl. */
  host: z.string().min(1).optional(),
  /** Optional; used for GHES. Example: https://github.example.com/api/v3 */
  apiBaseUrl: z.url().optional(),
  /** Optional cached login from onboarding test/configure flow. */
  login: z.string().min(1).optional(),
});

export type GithubUserTokenSecret = z.infer<typeof githubUserTokenSecretSchema>;

export class GithubUserTokenSecretReadError extends TaggedError("GithubUserTokenSecretReadError")<{
  readonly secretPath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

async function captureGithubUserTokenFs<T, E>(
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

export function decodeGithubUserTokenSecret(
  secretPath: string,
  value: unknown,
): ResultType<GithubUserTokenSecret, GithubUserTokenSecretReadError> {
  const decoded = githubUserTokenSecretSchema.safeParse(value);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new GithubUserTokenSecretReadError({
      secretPath,
      cause: decoded.error,
      message: `Invalid GitHub user token secret at ${secretPath}`,
    }),
  );
}

export function resolveGithubUserTokenSecretPath(dataDir: string): string {
  return path.join(dataDir, "secret", "github-user-token.json");
}

async function ensureSecretDir(dataDir: string): Promise<void> {
  await fs.mkdir(path.join(dataDir, "secret"), { recursive: true });
}

async function chmod0600(p: string): Promise<void> {
  await captureGithubUserTokenFs(
    () => fs.chmod(p, 0o600),
    (cause) => cause,
  );
}

export async function readGithubUserTokenSecretResult(
  dataDir: string,
): Promise<ResultType<GithubUserTokenSecret | null, GithubUserTokenSecretReadError>> {
  const jsonPath = resolveGithubUserTokenSecretPath(dataDir);
  const file = Bun.file(jsonPath);
  const loaded = await captureGithubUserTokenFs(
    async (): Promise<unknown | null> => {
      if (!(await file.exists())) return null;
      return JSON.parse(await file.text()) as unknown;
    },
    (cause) =>
      new GithubUserTokenSecretReadError({
        secretPath: jsonPath,
        cause,
        message: `Invalid GitHub user token secret at ${jsonPath}`,
      }),
  );
  if (loaded.status === "error") return Result.err(loaded.error);
  return loaded.value === null
    ? Result.ok(null)
    : decodeGithubUserTokenSecret(jsonPath, loaded.value);
}

export async function readGithubUserTokenSecret(
  dataDir: string,
): Promise<GithubUserTokenSecret | null> {
  const read = await readGithubUserTokenSecretResult(dataDir);
  if (read.status === "error") throw read.error;
  return read.value;
}

export async function writeGithubUserTokenSecret(params: {
  dataDir: string;
  token: string;
  host?: string;
  apiBaseUrl?: string;
  login?: string;
}): Promise<{ jsonPath: string; overwritten: boolean }> {
  await ensureSecretDir(params.dataDir);
  const jsonPath = resolveGithubUserTokenSecretPath(params.dataDir);
  const existed = await Bun.file(jsonPath).exists();

  const decoded = decodeGithubUserTokenSecret(jsonPath, {
    type: "github_user_token",
    token: params.token.trim(),
    host: params.host,
    apiBaseUrl: params.apiBaseUrl,
    login: params.login,
  });
  if (decoded.status === "error") throw decoded.error;

  await fs.writeFile(jsonPath, JSON.stringify(decoded.value, null, 2), "utf8");
  await chmod0600(jsonPath);

  return { jsonPath, overwritten: existed };
}

export async function clearGithubUserTokenSecret(dataDir: string): Promise<void> {
  const jsonPath = resolveGithubUserTokenSecretPath(dataDir);
  await captureGithubUserTokenFs(
    () => fs.rm(jsonPath, { force: true }),
    (cause) => cause,
  );
}
