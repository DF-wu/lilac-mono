import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  McpOAuthCredentialError,
  readMcpOAuthCredentialFile,
  resolveMcpOAuthCredentialPath,
  updateMcpOAuthCredentialFile,
} from "../../src/mcp";

const temporaryDirectories: string[] = [];

async function createDataDir(): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-mcp-oauth-credentials-"));
  temporaryDirectories.push(dataDir);
  return dataDir;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("MCP OAuth credential files", () => {
  it("atomically persists durable fields with private modes", async () => {
    const dataDir = await createDataDir();
    const credentialPath = resolveMcpOAuthCredentialPath({ dataDir, serverId: "docs" });

    await updateMcpOAuthCredentialFile({
      dataDir,
      serverId: "docs",
      serverUrl: "https://mcp.example.test/service",
      update: (credential) => ({
        ...credential,
        clientInformation: { client_id: "registered-client", client_secret: "client-secret" },
      }),
    });
    await updateMcpOAuthCredentialFile({
      dataDir,
      serverId: "docs",
      serverUrl: "https://mcp.example.test/service",
      update: (credential) => ({
        ...credential,
        tokens: {
          access_token: "access-token",
          token_type: "Bearer",
          refresh_token: "refresh-token",
        },
      }),
    });

    expect(await readMcpOAuthCredentialFile({ dataDir, serverId: "docs" })).toMatchObject({
      version: 1,
      serverUrl: "https://mcp.example.test/service",
      clientInformation: { client_id: "registered-client" },
      tokens: { access_token: "access-token", refresh_token: "refresh-token" },
    });
    expect((await stat(path.dirname(credentialPath))).mode & 0o777).toBe(0o700);
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(credentialPath))).toEqual(["docs.json"]);
  });

  it("restores private directory mode and rejects malformed credentials safely", async () => {
    const dataDir = await createDataDir();
    await updateMcpOAuthCredentialFile({
      dataDir,
      serverId: "docs",
      serverUrl: "https://mcp.example.test/service",
      update: (credential) => credential,
    });
    const credentialPath = resolveMcpOAuthCredentialPath({ dataDir, serverId: "docs" });
    await chmod(path.dirname(credentialPath), 0o755);
    await Bun.write(credentialPath, '{"access_token":"must-not-appear"}\n');

    await expect(readMcpOAuthCredentialFile({ dataDir, serverId: "docs" })).rejects.toBeInstanceOf(
      McpOAuthCredentialError,
    );
    try {
      await readMcpOAuthCredentialFile({ dataDir, serverId: "docs" });
    } catch (error) {
      expect(String(error)).not.toContain("must-not-appear");
    }

    await updateMcpOAuthCredentialFile({
      dataDir,
      serverId: "other",
      serverUrl: "https://mcp.example.test/other",
      update: (credential) => credential,
    });
    expect((await stat(path.dirname(credentialPath))).mode & 0o777).toBe(0o700);
    expect(
      await readFile(resolveMcpOAuthCredentialPath({ dataDir, serverId: "other" }), "utf8"),
    ).toContain('"version": 1');
  });

  it("starts a clean durable record when a server ID is pointed at a new URL", async () => {
    const dataDir = await createDataDir();
    await updateMcpOAuthCredentialFile({
      dataDir,
      serverId: "docs",
      serverUrl: "https://old.example.test/mcp",
      update: (credential) => ({
        ...credential,
        tokens: { access_token: "old-token", token_type: "Bearer" },
      }),
    });
    await updateMcpOAuthCredentialFile({
      dataDir,
      serverId: "docs",
      serverUrl: "https://new.example.test/mcp",
      update: (credential) => ({
        ...credential,
        clientInformation: { client_id: "new-client" },
      }),
    });

    expect(await readMcpOAuthCredentialFile({ dataDir, serverId: "docs" })).toEqual({
      version: 1,
      serverUrl: "https://new.example.test/mcp",
      clientInformation: { client_id: "new-client" },
    });
  });
});
