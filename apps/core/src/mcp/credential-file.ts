import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import type {
  OAuthAuthorizationServerInformation,
  OAuthClientInformation,
  OAuthTokens,
} from "@ai-sdk/mcp";
import { isPanic } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Panic, type Result as ResultType } from "better-result";
import { z } from "zod";

import { mcpServerIdSchema } from "./config";

const MCP_OAUTH_CREDENTIAL_VERSION = 1 as const;

const oauthTokensSchema: z.ZodType<OAuthTokens> = z.strictObject({
  access_token: z.string(),
  id_token: z.string().optional(),
  token_type: z.string(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  refresh_token: z.string().optional(),
  authorization_server: z.url().optional(),
  token_endpoint: z.url().optional(),
});

const oauthClientInformationSchema: z.ZodType<OAuthClientInformation> = z.object({
  client_id: z.string(),
  client_secret: z.string().optional(),
  client_id_issued_at: z.number().optional(),
  client_secret_expires_at: z.number().optional(),
  authorization_server: z.url().optional(),
  token_endpoint: z.url().optional(),
});

const authorizationServerInformationSchema: z.ZodType<OAuthAuthorizationServerInformation> =
  z.strictObject({
    authorizationServerUrl: z.url(),
    tokenEndpoint: z.url(),
  });

const mcpOAuthCredentialSchema = z.strictObject({
  version: z.literal(MCP_OAUTH_CREDENTIAL_VERSION),
  serverUrl: z.url(),
  tokens: oauthTokensSchema.optional(),
  clientInformation: oauthClientInformationSchema.optional(),
  authorizationServerInformation: authorizationServerInformationSchema.optional(),
});

const fileErrorSchema = z.object({ code: z.string() });
const updateQueues = new Map<string, Promise<void>>();

type McpOAuthCredentialFileHandle = Pick<
  Awaited<ReturnType<typeof open>>,
  "writeFile" | "chmod" | "sync" | "close"
>;

export type McpOAuthCredentialFileDependencies = {
  readonly mkdir: typeof mkdir;
  readonly chmod: typeof chmod;
  readonly open: (
    filePath: string,
    flags: string,
    mode: number,
  ) => Promise<McpOAuthCredentialFileHandle>;
  readonly rename: typeof rename;
  readonly rm: typeof rm;
  readonly randomUUID: () => string;
};

const DEFAULT_FILE_DEPENDENCIES: McpOAuthCredentialFileDependencies = {
  mkdir,
  chmod,
  open,
  rename,
  rm,
  randomUUID,
};

export type McpOAuthCredential = z.infer<typeof mcpOAuthCredentialSchema>;

export class McpOAuthCredentialError extends TaggedError("McpOAuthCredentialError")<{
  readonly credentialPath: string;
  readonly operation: "resolve" | "read" | "write" | "update" | "cleanup";
  readonly cause?: unknown;
  readonly message: string;
}> {}

export class McpOAuthCredentialWriteAndCleanupError extends TaggedError(
  "McpOAuthCredentialWriteAndCleanupError",
)<{
  readonly credentialPath: string;
  readonly primary: McpOAuthCredentialError | McpOAuthCredentialWriteAndCleanupError;
  readonly cleanup: McpOAuthCredentialError;
  readonly message: string;
}> {}

export type McpOAuthCredentialWriteError =
  | McpOAuthCredentialError
  | McpOAuthCredentialWriteAndCleanupError;

function credentialError(
  credentialPath: string,
  operation: McpOAuthCredentialError["operation"],
  cause?: unknown,
): McpOAuthCredentialError {
  return new McpOAuthCredentialError({
    credentialPath,
    operation,
    cause,
    message: `Failed to ${operation} MCP OAuth credentials at ${credentialPath}`,
  });
}

function combineCredentialWriteFailures(
  credentialPath: string,
  primary: McpOAuthCredentialWriteError,
  cleanup: McpOAuthCredentialError,
): McpOAuthCredentialWriteAndCleanupError {
  return new McpOAuthCredentialWriteAndCleanupError({
    credentialPath,
    primary,
    cleanup,
    message: `${primary.message}; cleanup also failed: ${cleanup.message}`,
  });
}

export function resolveMcpOAuthCredentialPathResult(options: {
  readonly dataDir: string;
  readonly serverId: string;
}): ResultType<string, McpOAuthCredentialError> {
  const serverId = mcpServerIdSchema.safeParse(options.serverId);
  if (!serverId.success) {
    return Result.err(
      credentialError(path.join(options.dataDir, "secret", "mcp-oauth"), "resolve"),
    );
  }
  return Result.ok(path.join(options.dataDir, "secret", "mcp-oauth", `${serverId.data}.json`));
}

export function resolveMcpOAuthCredentialPath(options: {
  readonly dataDir: string;
  readonly serverId: string;
}): string {
  const resolved = resolveMcpOAuthCredentialPathResult(options);
  if (resolved.status === "error") throw resolved.error;
  return resolved.value;
}

export async function readMcpOAuthCredentialFileResult(options: {
  readonly dataDir: string;
  readonly serverId: string;
}): Promise<ResultType<McpOAuthCredential | undefined, McpOAuthCredentialError>> {
  const resolvedPath = resolveMcpOAuthCredentialPathResult(options);
  if (resolvedPath.status === "error") return resolvedPath;
  const credentialPath = resolvedPath.value;
  let source: string;
  try {
    source = await readFile(credentialPath, "utf8");
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    const parsed = fileErrorSchema.safeParse(cause);
    if (parsed.success && (parsed.data.code === "ENOENT" || parsed.data.code === "ENOTDIR")) {
      return Result.ok(undefined);
    }
    return Result.err(credentialError(credentialPath, "read", cause));
  }

  try {
    return Result.ok(mcpOAuthCredentialSchema.parse(JSON.parse(source)));
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return Result.err(credentialError(credentialPath, "read", cause));
  }
}

export async function readMcpOAuthCredentialFile(options: {
  readonly dataDir: string;
  readonly serverId: string;
}): Promise<McpOAuthCredential | undefined> {
  const read = await readMcpOAuthCredentialFileResult(options);
  if (read.status === "error") throw read.error;
  return read.value;
}

export async function writeMcpOAuthCredentialFileAtomicResult(options: {
  readonly dataDir: string;
  readonly serverId: string;
  readonly credential: McpOAuthCredential;
  readonly dependencies?: McpOAuthCredentialFileDependencies;
}): Promise<ResultType<void, McpOAuthCredentialWriteError>> {
  const resolvedPath = resolveMcpOAuthCredentialPathResult(options);
  if (resolvedPath.status === "error") return resolvedPath;
  const credentialPath = resolvedPath.value;
  const decoded = mcpOAuthCredentialSchema.safeParse(options.credential);
  if (!decoded.success) return Result.err(credentialError(credentialPath, "write"));
  const credential = decoded.data;
  const directory = path.dirname(credentialPath);
  const dependencies = options.dependencies ?? DEFAULT_FILE_DEPENDENCIES;
  let panic: Panic | undefined;
  let failure: McpOAuthCredentialWriteError | undefined;

  const recordFailure = (cause: unknown, operation: "write" | "cleanup"): void => {
    if (isPanic(cause)) {
      panic ??= cause;
      return;
    }
    const next = credentialError(credentialPath, operation, cause);
    failure = failure ? combineCredentialWriteFailures(credentialPath, failure, next) : next;
  };
  const finish = (): ResultType<void, McpOAuthCredentialWriteError> => {
    if (panic) throw panic;
    return failure ? Result.err(failure) : Result.ok();
  };

  let temporaryPath: string;
  try {
    await dependencies.mkdir(directory, { recursive: true, mode: 0o700 });
    await dependencies.chmod(directory, 0o700);
    temporaryPath = path.join(
      directory,
      `.${path.basename(credentialPath)}.${dependencies.randomUUID()}.tmp`,
    );
  } catch (cause) {
    recordFailure(cause, "write");
    return finish();
  }

  let handle: McpOAuthCredentialFileHandle | undefined;
  try {
    handle = await dependencies.open(temporaryPath, "wx", 0o600);
  } catch (cause) {
    recordFailure(cause, "write");
  }

  if (handle) {
    try {
      await handle.writeFile(`${JSON.stringify(credential, null, 2)}\n`, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } catch (cause) {
      recordFailure(cause, "write");
    }
    try {
      await handle.close();
    } catch (cause) {
      recordFailure(cause, "cleanup");
    }
  }

  let renamed = false;
  if (!panic && !failure) {
    try {
      await dependencies.rename(temporaryPath, credentialPath);
      renamed = true;
    } catch (cause) {
      recordFailure(cause, "write");
    }
  }

  if (!renamed) {
    try {
      await dependencies.rm(temporaryPath, { force: true });
    } catch (cause) {
      recordFailure(cause, "cleanup");
    }
  }

  return finish();
}

export async function writeMcpOAuthCredentialFileAtomic(options: {
  readonly dataDir: string;
  readonly serverId: string;
  readonly credential: McpOAuthCredential;
  readonly dependencies?: McpOAuthCredentialFileDependencies;
}): Promise<void> {
  const written = await writeMcpOAuthCredentialFileAtomicResult(options);
  if (written.status === "error") throw written.error;
}

export function updateMcpOAuthCredentialFileResult(options: {
  readonly dataDir: string;
  readonly serverId: string;
  readonly serverUrl: string;
  readonly update: (credential: McpOAuthCredential) => McpOAuthCredential;
}): Promise<ResultType<void, McpOAuthCredentialWriteError>> {
  const resolvedPath = resolveMcpOAuthCredentialPathResult(options);
  if (resolvedPath.status === "error") return Promise.resolve(resolvedPath);
  const credentialPath = resolvedPath.value;
  const previous = updateQueues.get(credentialPath) ?? Promise.resolve();
  const result = previous.then(async () => {
    const read = await readMcpOAuthCredentialFileResult(options);
    if (read.status === "error") return read;
    const existing = read.value;
    const credential =
      existing?.serverUrl === options.serverUrl
        ? existing
        : {
            version: MCP_OAUTH_CREDENTIAL_VERSION,
            serverUrl: options.serverUrl,
          };
    let updatedCredential: McpOAuthCredential;
    try {
      updatedCredential = options.update(credential);
    } catch (cause) {
      if (isPanic(cause)) throw cause;
      return Result.err(credentialError(credentialPath, "update", cause));
    }
    return writeMcpOAuthCredentialFileAtomicResult({
      ...options,
      credential: updatedCredential,
    });
  });
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  updateQueues.set(credentialPath, settled);

  return result.finally(() => {
    if (updateQueues.get(credentialPath) === settled) updateQueues.delete(credentialPath);
  });
}

export async function updateMcpOAuthCredentialFile(options: {
  readonly dataDir: string;
  readonly serverId: string;
  readonly serverUrl: string;
  readonly update: (credential: McpOAuthCredential) => McpOAuthCredential;
}): Promise<void> {
  const updated = await updateMcpOAuthCredentialFileResult(options);
  if (updated.status === "error") throw updated.error;
}
