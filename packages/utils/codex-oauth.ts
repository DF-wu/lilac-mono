import { chmod, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { env } from "./env";
import type { DecodedPersistedValue } from "./persistence";
import { isPanic, opaqueErrorMessage } from "./runtime-utils";

export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_ISSUER = "https://auth.openai.com";
export const CODEX_OAUTH_PORT = 1455;
export const CODEX_OAUTH_REDIRECT_URI = `http://localhost:${CODEX_OAUTH_PORT}/auth/callback`;

const codexOAuthTokensSchema = z
  .object({
    type: z.literal("oauth"),
    access: z.string().min(1),
    refresh: z.string().min(1),
    expires: z.number(),
    accountId: z.string().min(1).optional(),
    idToken: z.string().min(1).optional(),
  })
  .strict();
const legacyCodexOAuthTokensSchema = codexOAuthTokensSchema.omit({ type: true });
const codexOAuthTokenTypeSchema = z.object({ type: z.string() }).passthrough();
const loggedOutCodexOAuthTokensSchema = z.object({}).strict();

const authorizationCodeTokenResponseSchema = z.object({
  id_token: z.string().min(1),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive().optional(),
});

const refreshTokenResponseSchema = z.object({
  id_token: z.string().min(1).optional(),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
});

const jwtClaimsSchema = z.record(z.string(), z.unknown());

export type CodexOAuthTokens = z.infer<typeof codexOAuthTokensSchema>;
export type AuthorizationCodeTokenResponse = z.infer<typeof authorizationCodeTokenResponseSchema>;
export type RefreshTokenResponse = z.infer<typeof refreshTokenResponseSchema>;

export class CodexTokensReadFailed extends TaggedError("CodexTokensReadFailed")<{
  readonly operation: "inspect" | "read";
  readonly storagePath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class CodexTokensMalformed extends TaggedError("CodexTokensMalformed")<{
  readonly storagePath: string;
  readonly message: string;
}> {}

export class CodexTokensCorrupt extends TaggedError("CodexTokensCorrupt")<{
  readonly storagePath: string;
  readonly issues: readonly string[];
  readonly message: string;
}> {}

export class CodexTokensUnsupportedVersion extends TaggedError("CodexTokensUnsupportedVersion")<{
  readonly storagePath: string;
  readonly version: string;
  readonly message: string;
}> {}

export class CodexTokensWriteInvalid extends TaggedError("CodexTokensWriteInvalid")<{
  readonly storagePath: string;
  readonly cause: z.ZodError;
  readonly message: string;
}> {}

export class CodexTokensWriteFailed extends TaggedError("CodexTokensWriteFailed")<{
  readonly storagePath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class CodexTokensCleanupFailed extends TaggedError("CodexTokensCleanupFailed")<{
  readonly storagePath: string;
  readonly causes: readonly unknown[];
  readonly message: string;
}> {}

export class CodexTokensWriteAndCleanupFailed extends TaggedError(
  "CodexTokensWriteAndCleanupFailed",
)<{
  readonly storagePath: string;
  readonly writeError: CodexTokensWriteFailed;
  readonly cleanupError: CodexTokensCleanupFailed;
  readonly message: string;
}> {}

export class CodexOAuthRequestFailed extends TaggedError("CodexOAuthRequestFailed")<{
  readonly operation: "exchange" | "refresh";
  readonly status?: number;
  readonly cause?: unknown;
  readonly message: string;
}> {}

export class CodexOAuthResponseInvalid extends TaggedError("CodexOAuthResponseInvalid")<{
  readonly operation: "exchange" | "refresh";
  readonly cause: unknown;
  readonly message: string;
}> {}

export class CodexOAuthLoginFailed extends TaggedError("CodexOAuthLoginFailed")<{
  readonly issue:
    | "closed"
    | "already-completed"
    | "exchange-in-progress"
    | "invalid-state"
    | "provider-error"
    | "missing-code"
    | "token-exchange"
    | "token-write";
  readonly cause?: unknown;
  readonly message: string;
}> {}

const STORAGE_PATH = path.join(env.dataDir, "secret", "codex.json");

export const OAUTH_DUMMY_KEY = "lilac-codex-oauth-dummy-key";

export function decodeCodexTokens(input: {
  readonly serialized: string | null;
  readonly storagePath: string;
}): ResultType<
  DecodedPersistedValue<CodexOAuthTokens | null>,
  CodexTokensMalformed | CodexTokensCorrupt | CodexTokensUnsupportedVersion
> {
  if (input.serialized === null) {
    return Result.ok({ value: null, provenance: "missing-defaulted" });
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(input.serialized);
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return Result.err(
      new CodexTokensMalformed({
        storagePath: input.storagePath,
        message: `Codex OAuth tokens at '${input.storagePath}' contain malformed JSON`,
      }),
    );
  }

  const current = codexOAuthTokensSchema.safeParse(decoded);
  if (current.success) {
    return Result.ok({ value: current.data, provenance: "current" });
  }

  const legacy = legacyCodexOAuthTokensSchema.safeParse(decoded);
  if (legacy.success) {
    return Result.ok({ value: { type: "oauth", ...legacy.data }, provenance: "migrated" });
  }

  if (loggedOutCodexOAuthTokensSchema.safeParse(decoded).success) {
    return Result.ok({ value: null, provenance: "current" });
  }

  const typed = codexOAuthTokenTypeSchema.safeParse(decoded);
  if (typed.success && typed.data.type !== "oauth") {
    return Result.err(
      new CodexTokensUnsupportedVersion({
        storagePath: input.storagePath,
        version: typed.data.type,
        message: `Codex OAuth tokens at '${input.storagePath}' use unsupported type '${typed.data.type}'`,
      }),
    );
  }

  return Result.err(
    new CodexTokensCorrupt({
      storagePath: input.storagePath,
      issues: current.error.issues.map((issue) => issue.message),
      message: `Codex OAuth tokens at '${input.storagePath}' have invalid fields`,
    }),
  );
}

const CODEX_TOKEN_FIXTURE_PATH = "/fixture/codex.json";
const CODEX_TOKEN_FIXTURE_FIELDS = {
  access: "fixture-access",
  refresh: "fixture-refresh",
  expires: 1,
} as const;

export const codexTokensCodecCases = {
  current: {
    input: {
      serialized: JSON.stringify({ type: "oauth", ...CODEX_TOKEN_FIXTURE_FIELDS }),
      storagePath: CODEX_TOKEN_FIXTURE_PATH,
    },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: {
      serialized: JSON.stringify(CODEX_TOKEN_FIXTURE_FIELDS),
      storagePath: CODEX_TOKEN_FIXTURE_PATH,
    },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { serialized: null, storagePath: CODEX_TOKEN_FIXTURE_PATH },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: {
      serialized: JSON.stringify({ type: "future", ...CODEX_TOKEN_FIXTURE_FIELDS }),
      storagePath: CODEX_TOKEN_FIXTURE_PATH,
    },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { serialized: "{", storagePath: CODEX_TOKEN_FIXTURE_PATH },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      serialized: JSON.stringify({ type: "oauth", ...CODEX_TOKEN_FIXTURE_FIELDS, expires: "1" }),
      storagePath: CODEX_TOKEN_FIXTURE_PATH,
    },
    outcome: "error",
  },
} as const;

function parseJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown;
    return jwtClaimsSchema.safeParse(parsed).data;
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return undefined;
  }
}

function extractAccountIdFromClaims(claims: Record<string, unknown>): string | undefined {
  const direct = claims["chatgpt_account_id"];
  if (typeof direct === "string" && direct.length > 0) return direct;

  const auth = claims["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    const parsed = jwtClaimsSchema.safeParse(auth);
    const nested = parsed.success ? parsed.data["chatgpt_account_id"] : undefined;
    if (typeof nested === "string" && nested.length > 0) return nested;
  }

  const orgs = claims["organizations"];
  if (Array.isArray(orgs) && orgs.length > 0) {
    const parsed = jwtClaimsSchema.safeParse(orgs[0]);
    const id = parsed.success ? parsed.data.id : undefined;
    if (typeof id === "string" && id.length > 0) return id;
  }

  return undefined;
}

export function extractAccountId(tokens: {
  id_token?: string;
  access_token?: string;
}): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token);
    if (claims) {
      const id = extractAccountIdFromClaims(claims);
      if (id) return id;
    }
  }

  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token);
    if (claims) return extractAccountIdFromClaims(claims);
  }

  return undefined;
}

async function ensureSecretDir(storagePath: string): Promise<void> {
  const directory = path.dirname(storagePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

type CodexSecretFileHandle = Pick<FileHandle, "close" | "sync" | "writeFile">;

export type CodexSecretFileOperations = {
  readonly ensureDirectory: (storagePath: string) => Promise<void>;
  readonly openTemporaryFile: (temporaryPath: string) => Promise<CodexSecretFileHandle>;
  readonly openDirectory: (directoryPath: string) => Promise<CodexSecretFileHandle>;
  readonly rename: (temporaryPath: string, storagePath: string) => Promise<void>;
  readonly chmod: (storagePath: string, mode: number) => Promise<void>;
  readonly unlink: (temporaryPath: string) => Promise<void>;
  readonly syncDirectory: boolean;
};

const CODEX_SECRET_FILE_OPERATIONS: CodexSecretFileOperations = {
  ensureDirectory: ensureSecretDir,
  openTemporaryFile: (temporaryPath) => open(temporaryPath, "wx", 0o600),
  openDirectory: (directoryPath) => open(directoryPath, "r"),
  rename,
  chmod,
  unlink,
  syncDirectory: process.platform !== "win32",
};

export async function writeSecretFileResult(
  storagePath: string,
  contents: string,
  operations: CodexSecretFileOperations = CODEX_SECRET_FILE_OPERATIONS,
): Promise<
  ResultType<
    void,
    CodexTokensWriteFailed | CodexTokensCleanupFailed | CodexTokensWriteAndCleanupFailed
  >
> {
  const directory = path.dirname(storagePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(storagePath)}.${crypto.randomUUID()}.tmp`,
  );
  let handle: CodexSecretFileHandle | undefined;
  let directoryHandle: CodexSecretFileHandle | undefined;
  let needsCleanup = false;
  let writeFailed = false;
  let writeCause: unknown;
  const cleanupCauses: unknown[] = [];

  try {
    await operations.ensureDirectory(storagePath);
    handle = await operations.openTemporaryFile(temporaryPath);
    needsCleanup = true;
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (cause) {
    writeFailed = true;
    writeCause = cause;
  }

  if (handle) {
    try {
      await handle.close();
    } catch (cause) {
      cleanupCauses.push(cause);
    }
    handle = undefined;
  }

  if (!writeFailed && cleanupCauses.length === 0) {
    try {
      if (operations.syncDirectory) directoryHandle = await operations.openDirectory(directory);
      await operations.rename(temporaryPath, storagePath);
      needsCleanup = false;
      if (process.platform !== "win32") await operations.chmod(storagePath, 0o600);
      await directoryHandle?.sync();
    } catch (cause) {
      writeFailed = true;
      writeCause = cause;
    }
  }

  if (directoryHandle) {
    try {
      await directoryHandle.close();
    } catch (cause) {
      cleanupCauses.push(cause);
    }
  }
  if (needsCleanup) {
    try {
      await operations.unlink(temporaryPath);
    } catch (cause) {
      cleanupCauses.push(cause);
    }
  }

  if (isPanic(writeCause)) throw writeCause;
  const cleanupPanic = cleanupCauses.find(isPanic);
  if (cleanupPanic) throw cleanupPanic;

  const cleanupError =
    cleanupCauses.length > 0
      ? new CodexTokensCleanupFailed({
          storagePath,
          causes: cleanupCauses,
          message: `Failed to clean up resources after writing Codex OAuth tokens to '${storagePath}'`,
        })
      : undefined;
  if (writeFailed) {
    const writeError = new CodexTokensWriteFailed({
      storagePath,
      cause: writeCause,
      message: `Failed to write Codex OAuth tokens to '${storagePath}': ${opaqueErrorMessage(writeCause, "Unknown write failure")}`,
    });
    return cleanupError
      ? Result.err(
          new CodexTokensWriteAndCleanupFailed({
            storagePath,
            writeError,
            cleanupError,
            message: `Failed to write Codex OAuth tokens to '${storagePath}' and clean up resources`,
          }),
        )
      : Result.err(writeError);
  }
  return cleanupError ? Result.err(cleanupError) : Result.ok(undefined);
}

export async function readCodexTokensResult(
  storagePath: string = STORAGE_PATH,
): Promise<
  ResultType<
    DecodedPersistedValue<CodexOAuthTokens | null>,
    | CodexTokensReadFailed
    | CodexTokensMalformed
    | CodexTokensCorrupt
    | CodexTokensUnsupportedVersion
  >
> {
  const file = Bun.file(storagePath);
  let exists: boolean;
  try {
    exists = await file.exists();
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return Result.err(
      new CodexTokensReadFailed({
        operation: "inspect",
        storagePath,
        cause,
        message: `Failed to inspect Codex OAuth tokens at '${storagePath}'`,
      }),
    );
  }
  if (!exists) return decodeCodexTokens({ serialized: null, storagePath });

  let text: string;
  try {
    text = await file.text();
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return Result.err(
      new CodexTokensReadFailed({
        operation: "read",
        storagePath,
        cause,
        message: `Failed to read Codex OAuth tokens at '${storagePath}'`,
      }),
    );
  }

  return decodeCodexTokens({ serialized: text, storagePath });
}

export async function readCodexTokens(
  storagePath: string = STORAGE_PATH,
): Promise<CodexOAuthTokens | null> {
  const result = await readCodexTokensResult(storagePath);
  if (result.status === "ok") return result.value.value;
  if (result.error._tag === "CodexTokensReadFailed") {
    if (result.error.operation === "inspect") throw result.error.cause;
    return null;
  }
  return null;
}

export async function writeCodexTokensResult(
  tokens: CodexOAuthTokens,
  storagePath: string = STORAGE_PATH,
  operations: CodexSecretFileOperations = CODEX_SECRET_FILE_OPERATIONS,
): Promise<
  ResultType<
    void,
    | CodexTokensWriteInvalid
    | CodexTokensWriteFailed
    | CodexTokensCleanupFailed
    | CodexTokensWriteAndCleanupFailed
  >
> {
  const validated = codexOAuthTokensSchema.safeParse(tokens);
  if (!validated.success) {
    return Result.err(
      new CodexTokensWriteInvalid({
        storagePath,
        cause: validated.error,
        message: `Refusing to write invalid Codex OAuth tokens to '${storagePath}'`,
      }),
    );
  }
  return writeSecretFileResult(
    storagePath,
    `${JSON.stringify(validated.data, null, 2)}\n`,
    operations,
  );
}

export async function writeCodexTokens(
  tokens: CodexOAuthTokens,
  storagePath: string = STORAGE_PATH,
  operations: CodexSecretFileOperations = CODEX_SECRET_FILE_OPERATIONS,
): Promise<void> {
  const result = await writeCodexTokensResult(tokens, storagePath, operations);
  if (result.status === "error") throw projectLegacyCodexTokenWriteFailure(result.error);
}

export async function clearCodexTokensResult(
  storagePath: string = STORAGE_PATH,
): Promise<
  ResultType<
    void,
    | CodexTokensReadFailed
    | CodexTokensWriteFailed
    | CodexTokensCleanupFailed
    | CodexTokensWriteAndCleanupFailed
  >
> {
  const file = Bun.file(storagePath);
  let exists: boolean;
  try {
    exists = await file.exists();
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return Result.err(
      new CodexTokensReadFailed({
        operation: "inspect",
        storagePath,
        cause,
        message: `Failed to inspect Codex OAuth tokens at '${storagePath}'`,
      }),
    );
  }
  if (!exists) return Result.ok(undefined);
  return writeSecretFileResult(storagePath, "{}\n");
}

export async function clearCodexTokens(storagePath: string = STORAGE_PATH): Promise<void> {
  const result = await clearCodexTokensResult(storagePath);
  if (result.status === "ok") return;
  if (result.error._tag === "CodexTokensReadFailed") throw result.error.cause;
  throw projectLegacyCodexTokenWriteFailure(result.error);
}

function projectLegacyCodexTokenWriteFailure(
  error:
    | CodexTokensWriteInvalid
    | CodexTokensWriteFailed
    | CodexTokensCleanupFailed
    | CodexTokensWriteAndCleanupFailed,
): unknown {
  switch (error._tag) {
    case "CodexTokensWriteInvalid":
      return error.cause;
    case "CodexTokensWriteFailed":
      return new Error(error.message, { cause: error.cause });
    case "CodexTokensCleanupFailed": {
      const [firstCause, ...additionalCauses] = error.causes;
      return additionalCauses.length === 0
        ? new Error(
            `Failed to write Codex OAuth tokens to '${error.storagePath}': ${opaqueErrorMessage(firstCause, "Unknown cleanup failure")}`,
            { cause: firstCause },
          )
        : new AggregateError(
            error.causes,
            `Failed to write Codex OAuth tokens to '${error.storagePath}' and clean up resources`,
          );
    }
    case "CodexTokensWriteAndCleanupFailed":
      return new AggregateError(
        [error.writeError.cause, ...error.cleanupError.causes],
        error.message,
      );
  }
}

export type PkceCodes = {
  verifier: string;
  challenge: string;
};

export async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(hash) };
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes)
    .map((byte) => chars[byte % chars.length]!)
    .join("");
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64url");
}

export function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

export function buildAuthorizeUrl(options: {
  redirectUri: string;
  pkce: PkceCodes;
  state: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_OAUTH_CLIENT_ID,
    redirect_uri: options.redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: options.pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: options.state,
    originator: "lilac",
  });

  return `${CODEX_OAUTH_ISSUER}/oauth/authorize?${params.toString()}`;
}

export type CodexOAuthFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export async function exchangeCodeForTokensResult(options: {
  code: string;
  redirectUri: string;
  pkce: PkceCodes;
  fetch?: CodexOAuthFetch;
  signal?: AbortSignal;
}): Promise<
  ResultType<AuthorizationCodeTokenResponse, CodexOAuthRequestFailed | CodexOAuthResponseInvalid>
> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${CODEX_OAUTH_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: options.code,
        redirect_uri: options.redirectUri,
        client_id: CODEX_OAUTH_CLIENT_ID,
        code_verifier: options.pkce.verifier,
      }).toString(),
      signal: options.signal,
    });
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return Result.err(
      new CodexOAuthRequestFailed({
        operation: "exchange",
        cause,
        message: "Token exchange request failed",
      }),
    );
  }
  if (!response.ok) {
    return Result.err(
      new CodexOAuthRequestFailed({
        operation: "exchange",
        status: response.status,
        message: `Token exchange failed: ${response.status}`,
      }),
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return Result.err(
      new CodexOAuthResponseInvalid({
        operation: "exchange",
        cause,
        message: "Token exchange response was not valid JSON",
      }),
    );
  }
  const parsed = authorizationCodeTokenResponseSchema.safeParse(payload);
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(
        new CodexOAuthResponseInvalid({
          operation: "exchange",
          cause: parsed.error,
          message: "Token exchange response has invalid fields",
        }),
      );
}

export async function exchangeCodeForTokens(options: {
  code: string;
  redirectUri: string;
  pkce: PkceCodes;
  fetch?: CodexOAuthFetch;
  signal?: AbortSignal;
}): Promise<AuthorizationCodeTokenResponse> {
  const result = await exchangeCodeForTokensResult(options);
  if (result.status === "error") throw projectLegacyCodexOAuthFailure(result.error);
  return result.value;
}

export async function refreshAccessTokenResult(
  refreshToken: string,
  fetchFn: CodexOAuthFetch = fetch,
): Promise<ResultType<RefreshTokenResponse, CodexOAuthRequestFailed | CodexOAuthResponseInvalid>> {
  let response: Response;
  try {
    response = await fetchFn(`${CODEX_OAUTH_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CODEX_OAUTH_CLIENT_ID,
      }).toString(),
    });
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return Result.err(
      new CodexOAuthRequestFailed({
        operation: "refresh",
        cause,
        message: "Token refresh request failed",
      }),
    );
  }
  if (!response.ok) {
    return Result.err(
      new CodexOAuthRequestFailed({
        operation: "refresh",
        status: response.status,
        message: `Token refresh failed: ${response.status}`,
      }),
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return Result.err(
      new CodexOAuthResponseInvalid({
        operation: "refresh",
        cause,
        message: "Token refresh response was not valid JSON",
      }),
    );
  }
  const parsed = refreshTokenResponseSchema.safeParse(payload);
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(
        new CodexOAuthResponseInvalid({
          operation: "refresh",
          cause: parsed.error,
          message: "Token refresh response has invalid fields",
        }),
      );
}

export async function refreshAccessToken(
  refreshToken: string,
  fetchFn: CodexOAuthFetch = fetch,
): Promise<RefreshTokenResponse> {
  const result = await refreshAccessTokenResult(refreshToken, fetchFn);
  if (result.status === "error") throw projectLegacyCodexOAuthFailure(result.error);
  return result.value;
}

function projectLegacyCodexOAuthFailure(
  error: CodexOAuthRequestFailed | CodexOAuthResponseInvalid,
): unknown {
  switch (error._tag) {
    case "CodexOAuthRequestFailed":
      return Object.hasOwn(error, "cause") ? error.cause : new Error(error.message);
    case "CodexOAuthResponseInvalid":
      return error.cause;
  }
}

export type CodexOAuthCallbackPayload = {
  callbackUrl?: string;
  code?: string;
  state?: string;
  pkceVerifier?: string;
};

export function parseCodexOAuthCallback(input: CodexOAuthCallbackPayload): {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
} {
  if (input.callbackUrl) {
    try {
      const url = new URL(input.callbackUrl);
      return {
        code: url.searchParams.get("code") ?? undefined,
        state: url.searchParams.get("state") ?? undefined,
        error: url.searchParams.get("error") ?? undefined,
        errorDescription: url.searchParams.get("error_description") ?? undefined,
      };
    } catch (cause) {
      if (isPanic(cause)) throw cause;
      // Fall back to explicit fields for manual exchange.
    }
  }
  return { code: input.code, state: input.state };
}

export type CodexOAuthLoginResult = {
  ok: true;
  accountId?: string;
  expires: number;
  storagePath: string;
};

export type CodexOAuthLogin = {
  authorizeUrl: string;
  redirectUri: string;
  port: number;
  state: string;
  pkce: PkceCodes;
  storagePath: string;
  result: Promise<CodexOAuthLoginResult>;
  exchange(input: CodexOAuthCallbackPayload): Promise<CodexOAuthLoginResult>;
  close(): Promise<void>;
};

export type CodexOAuthLoginWithResult = CodexOAuthLogin & {
  exchangeResult(
    input: CodexOAuthCallbackPayload,
  ): Promise<ResultType<CodexOAuthLoginResult, CodexOAuthLoginFailed>>;
};

export type StartCodexOAuthLoginOptions = {
  port?: number;
  callbackServer?: "required" | "optional" | "disabled";
  fetch?: CodexOAuthFetch;
  writeTokens?: (tokens: CodexOAuthTokens) => Promise<void>;
  storagePath?: string;
  now?: () => number;
};

const HTML_SUCCESS = `<!doctype html><html><head><title>Lilac - Codex Authorization Successful</title></head><body><h1>Authorization Successful</h1><p>You can close this tab and return to Lilac.</p></body></html>`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function htmlError(error: string): string {
  return `<!doctype html><html><head><title>Lilac - Codex Authorization Failed</title></head><body><h1>Authorization Failed</h1><p>${escapeHtml(error)}</p></body></html>`;
}

export async function startCodexOAuthLogin(
  options: StartCodexOAuthLoginOptions = {},
): Promise<CodexOAuthLoginWithResult> {
  const pkce = await generatePKCE();
  const state = generateState();
  const callbackServer = options.callbackServer ?? "required";
  const storagePath = options.storagePath ?? getCodexAuthStoragePath();
  const now = options.now ?? Date.now;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let redirectUri = `http://localhost:${options.port ?? CODEX_OAUTH_PORT}/auth/callback`;
  let settled = false;
  let closed = false;
  let activeExchange: Promise<ResultType<CodexOAuthLoginResult, CodexOAuthLoginFailed>> | null =
    null;
  let closePromise: Promise<void> | null = null;
  const exchangeController = new AbortController();
  const resultDeferred = Promise.withResolvers<CodexOAuthLoginResult>();
  const result = resultDeferred.promise;
  // Manual exchange callers are not required to await the automatic callback result.
  void result.catch((cause) => {
    if (isPanic(cause)) throw cause;
  });

  const stopServer = () => {
    server?.stop();
    server = undefined;
  };

  const runExchangeResult = async (
    input: CodexOAuthCallbackPayload,
  ): Promise<ResultType<CodexOAuthLoginResult, CodexOAuthLoginFailed>> => {
    if (closed) {
      return Result.err(
        new CodexOAuthLoginFailed({ issue: "closed", message: "Codex OAuth login closed" }),
      );
    }
    const parsed = parseCodexOAuthCallback(input);
    if (parsed.state !== state) {
      return Result.err(
        new CodexOAuthLoginFailed({
          issue: "invalid-state",
          message: "Invalid state - potential CSRF or mismatched start step",
        }),
      );
    }
    if (parsed.error) {
      return Result.err(
        new CodexOAuthLoginFailed({
          issue: "provider-error",
          message: `OAuth error: ${parsed.errorDescription || parsed.error}`,
        }),
      );
    }
    if (!parsed.code) {
      return Result.err(
        new CodexOAuthLoginFailed({
          issue: "missing-code",
          message: "Missing authorization code",
        }),
      );
    }

    const tokens = await exchangeCodeForTokensResult({
      code: parsed.code,
      redirectUri,
      pkce: { verifier: input.pkceVerifier ?? pkce.verifier, challenge: pkce.challenge },
      fetch: options.fetch,
      signal: exchangeController.signal,
    });
    if (tokens.status === "error") {
      return Result.err(
        new CodexOAuthLoginFailed({
          issue: "token-exchange",
          cause: tokens.error,
          message: tokens.error.message,
        }),
      );
    }
    if (closed) {
      return Result.err(
        new CodexOAuthLoginFailed({ issue: "closed", message: "Codex OAuth login closed" }),
      );
    }
    const accountId = extractAccountId(tokens.value);
    const expires = now() + (tokens.value.expires_in ?? 3600) * 1000;
    try {
      await (options.writeTokens ?? ((tokens) => writeCodexTokens(tokens, storagePath)))({
        type: "oauth",
        access: tokens.value.access_token,
        refresh: tokens.value.refresh_token,
        expires,
        accountId,
        idToken: tokens.value.id_token,
      });
    } catch (cause) {
      if (isPanic(cause)) throw cause;
      return Result.err(
        new CodexOAuthLoginFailed({
          issue: "token-write",
          cause,
          message: cause instanceof Error ? cause.message : "Failed to write Codex OAuth tokens",
        }),
      );
    }
    if (closed) {
      return Result.err(
        new CodexOAuthLoginFailed({ issue: "closed", message: "Codex OAuth login closed" }),
      );
    }
    const completed = { ok: true as const, accountId, expires, storagePath };
    if (!settled) {
      settled = true;
      stopServer();
      resultDeferred.resolve(completed);
    }
    return Result.ok(completed);
  };

  const exchangeResult = (
    input: CodexOAuthCallbackPayload,
  ): Promise<ResultType<CodexOAuthLoginResult, CodexOAuthLoginFailed>> => {
    if (closed) {
      return Promise.resolve(
        Result.err(
          new CodexOAuthLoginFailed({ issue: "closed", message: "Codex OAuth login closed" }),
        ),
      );
    }
    if (settled) {
      return Promise.resolve(
        Result.err(
          new CodexOAuthLoginFailed({
            issue: "already-completed",
            message: "Codex OAuth login already completed",
          }),
        ),
      );
    }
    if (activeExchange) {
      return Promise.resolve(
        Result.err(
          new CodexOAuthLoginFailed({
            issue: "exchange-in-progress",
            message: "Codex OAuth token exchange already in progress",
          }),
        ),
      );
    }

    const currentExchange = runExchangeResult(input);
    const trackedExchange = currentExchange.finally(() => {
      if (activeExchange === trackedExchange) activeExchange = null;
    });
    activeExchange = trackedExchange;
    return trackedExchange;
  };

  const exchange = async (input: CodexOAuthCallbackPayload): Promise<CodexOAuthLoginResult> => {
    const exchanged = await exchangeResult(input);
    if (exchanged.status === "error") throw projectLegacyCodexOAuthLoginFailure(exchanged.error);
    return exchanged.value;
  };

  if (callbackServer !== "disabled") {
    try {
      server = Bun.serve({
        hostname: "localhost",
        port: options.port ?? CODEX_OAUTH_PORT,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname !== "/auth/callback") return new Response("Not found", { status: 404 });

          const callbackState = url.searchParams.get("state");
          if (callbackState !== state) {
            const error = new Error("Invalid state - potential CSRF or mismatched start step");
            return new Response(htmlError(error.message), {
              status: 400,
              headers: { "Content-Type": "text/html" },
            });
          }

          const exchanged = await exchangeResult({ callbackUrl: request.url });
          if (exchanged.status === "error") {
            const cause = projectLegacyCodexOAuthLoginFailure(exchanged.error);
            if (!activeExchange && !settled) {
              settled = true;
              stopServer();
              resultDeferred.reject(cause);
            }
            return new Response(
              htmlError(opaqueErrorMessage(cause, "Unknown Codex OAuth callback failure")),
              {
                status: 400,
                headers: { "Content-Type": "text/html" },
              },
            );
          }
          return new Response(HTML_SUCCESS, { headers: { "Content-Type": "text/html" } });
        },
      });
      redirectUri = `http://localhost:${server.port}/auth/callback`;
    } catch (error) {
      if (isPanic(error)) throw error;
      if (callbackServer === "required") throw error;
    }
  }

  const port = server?.port ?? options.port ?? CODEX_OAUTH_PORT;
  return {
    authorizeUrl: buildAuthorizeUrl({ redirectUri, pkce, state }),
    redirectUri,
    port,
    state,
    pkce,
    storagePath,
    result,
    exchangeResult,
    exchange,
    close() {
      if (closePromise) return closePromise;
      closed = true;
      exchangeController.abort();
      if (!settled) {
        settled = true;
        resultDeferred.reject(new Error("Codex OAuth login closed"));
      }
      stopServer();
      const exchangeToWaitFor = activeExchange;
      closePromise = (async () => {
        if (!exchangeToWaitFor) return;
        await exchangeToWaitFor;
      })();
      return closePromise;
    },
  };
}

function projectLegacyCodexOAuthLoginFailure(error: CodexOAuthLoginFailed): unknown {
  switch (error.issue) {
    case "token-exchange":
      if (
        error.cause instanceof CodexOAuthRequestFailed ||
        error.cause instanceof CodexOAuthResponseInvalid
      ) {
        return projectLegacyCodexOAuthFailure(error.cause);
      }
      return Object.hasOwn(error, "cause") ? error.cause : new Error(error.message);
    case "token-write":
      return Object.hasOwn(error, "cause") ? error.cause : new Error(error.message);
    case "closed":
    case "already-completed":
    case "exchange-in-progress":
    case "invalid-state":
    case "provider-error":
    case "missing-code":
      return new Error(error.message);
  }
}

export function getCodexAuthStoragePath(): string {
  return STORAGE_PATH;
}
