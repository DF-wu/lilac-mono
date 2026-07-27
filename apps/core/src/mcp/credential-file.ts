import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import type {
  OAuthAuthorizationServerInformation,
  OAuthClientInformation,
  OAuthTokens,
} from "@ai-sdk/mcp";
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

export type McpOAuthCredential = z.infer<typeof mcpOAuthCredentialSchema>;

export class McpOAuthCredentialError extends Error {
  constructor(
    readonly credentialPath: string,
    operation: "read" | "write",
  ) {
    super(`Failed to ${operation} MCP OAuth credentials at ${credentialPath}`);
    this.name = "McpOAuthCredentialError";
  }
}

export function resolveMcpOAuthCredentialPath(options: {
  readonly dataDir: string;
  readonly serverId: string;
}): string {
  const serverId = mcpServerIdSchema.parse(options.serverId);
  return path.join(options.dataDir, "secret", "mcp-oauth", `${serverId}.json`);
}

export async function readMcpOAuthCredentialFile(options: {
  readonly dataDir: string;
  readonly serverId: string;
}): Promise<McpOAuthCredential | undefined> {
  const credentialPath = resolveMcpOAuthCredentialPath(options);
  let source: string;
  try {
    source = await readFile(credentialPath, "utf8");
  } catch (error) {
    const parsed = fileErrorSchema.safeParse(error);
    if (parsed.success && (parsed.data.code === "ENOENT" || parsed.data.code === "ENOTDIR")) {
      return undefined;
    }
    throw new McpOAuthCredentialError(credentialPath, "read");
  }

  try {
    return mcpOAuthCredentialSchema.parse(JSON.parse(source));
  } catch {
    throw new McpOAuthCredentialError(credentialPath, "read");
  }
}

export async function writeMcpOAuthCredentialFileAtomic(options: {
  readonly dataDir: string;
  readonly serverId: string;
  readonly credential: McpOAuthCredential;
}): Promise<void> {
  const credentialPath = resolveMcpOAuthCredentialPath(options);
  const credential = mcpOAuthCredentialSchema.parse(options.credential);
  const directory = path.dirname(credentialPath);

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(credentialPath)}.${randomUUID()}.tmp`,
    );
    let renamed = false;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(credential, null, 2)}\n`, "utf8");
        await handle.chmod(0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, credentialPath);
      renamed = true;
    } finally {
      if (!renamed) await rm(temporaryPath, { force: true });
    }
  } catch (error) {
    if (error instanceof McpOAuthCredentialError) throw error;
    throw new McpOAuthCredentialError(credentialPath, "write");
  }
}

export function updateMcpOAuthCredentialFile(options: {
  readonly dataDir: string;
  readonly serverId: string;
  readonly serverUrl: string;
  readonly update: (credential: McpOAuthCredential) => McpOAuthCredential;
}): Promise<void> {
  const credentialPath = resolveMcpOAuthCredentialPath(options);
  const previous = updateQueues.get(credentialPath) ?? Promise.resolve();
  const result = previous.then(async () => {
    const existing = await readMcpOAuthCredentialFile(options);
    const credential =
      existing?.serverUrl === options.serverUrl
        ? existing
        : {
            version: MCP_OAUTH_CREDENTIAL_VERSION,
            serverUrl: options.serverUrl,
          };
    await writeMcpOAuthCredentialFileAtomic({
      ...options,
      credential: options.update(credential),
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
