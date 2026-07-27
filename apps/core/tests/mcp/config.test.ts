import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  McpConfigError,
  mutateMcpConfigFile,
  parseMcpConfigYaml,
  readMcpConfigFile,
  resolveMcpConfigPath,
  serializeMcpConfigYaml,
  type McpServerDefinition,
} from "../../src/mcp";

const temporaryDirectories: string[] = [];

async function createDataDir(): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-mcp-config-"));
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

function stdioServer(id: string, command = "bun"): McpServerDefinition {
  return {
    id,
    transportConfig: { transport: "stdio", command, args: [], env: {} },
  };
}

describe("MCP config parsing and serialization", () => {
  it("keeps the shipped example valid", async () => {
    const source = await readFile(
      path.resolve(
        import.meta.dir,
        "../../../../packages/utils/config-templates/mcp-config.example.yaml",
      ),
      "utf8",
    );

    expect(parseMcpConfigYaml(source)).toEqual({
      ok: true,
      config: { configVersion: 1, servers: {} },
    });
  });

  it("normalizes stdio, HTTP, static OAuth, and dynamic OAuth definitions", () => {
    const parsed = parseMcpConfigYaml(`
configVersion: 1
servers:
  local-docs:
    transport: stdio
    command: bun
    args: [run, server.ts]
    cwd: /workspace
    env:
      DOCS_TOKEN: { env: DOCS_TOKEN }
  dynamic-auth:
    transport: http
    url: https://example.invalid/mcp
    auth:
      type: oauth
      grant: authorization_code
      scopes: [read, write]
      client: { type: dynamic }
  registered-auth:
    transport: http
    url: https://registered.example.invalid/mcp
    auth:
      type: oauth
      grant: authorization_code
      client:
        type: static
        clientId: lilac
        clientSecret: { file: secret/client.json, pointer: /secret }
`);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.servers["local-docs"]?.transportConfig).toEqual({
      transport: "stdio",
      command: "bun",
      args: ["run", "server.ts"],
      cwd: "/workspace",
      env: { DOCS_TOKEN: { env: "DOCS_TOKEN" } },
    });
    expect(parsed.config.servers["dynamic-auth"]?.id).toBe("dynamic-auth");

    const reparsed = parseMcpConfigYaml(serializeMcpConfigYaml(parsed.config));
    expect(reparsed).toEqual(parsed);
  });

  it("strictly rejects unknown policy fields and malformed value sources", () => {
    const unknown = parseMcpConfigYaml(`
configVersion: 1
servers:
  local:
    transport: stdio
    command: bun
    allowProfiles: [primary]
`);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.issues.join("\n")).toContain("allowProfiles");

    const malformedSource = parseMcpConfigYaml(`
configVersion: 1
servers:
  remote:
    transport: http
    url: https://example.invalid/mcp
    headers:
      X-Token: { env: TOKEN, fallback: nope }
`);
    expect(malformedSource.ok).toBe(false);

    expect(parseMcpConfigYaml("# empty\n").ok).toBe(false);
    expect(parseMcpConfigYaml("configVersion: 2\nservers: {}\n").ok).toBe(false);
  });

  it("rejects unsupported HTTP forms and ambiguous authorization", () => {
    const unsupported = parseMcpConfigYaml(`
configVersion: 1
servers:
  remote:
    transport: http
    url: ftp://example.invalid/mcp
`);
    expect(unsupported.ok).toBe(false);

    const ambiguous = parseMcpConfigYaml(`
configVersion: 1
servers:
  remote:
    transport: http
    url: https://example.invalid/mcp
    headers: { Authorization: Bearer-token }
    auth:
      type: oauth
      grant: authorization_code
      client: { type: dynamic }
`);
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.issues.join("\n")).toContain("cannot be combined");

    const clientCredentials = parseMcpConfigYaml(`
configVersion: 1
servers:
  remote:
    transport: http
    url: https://example.invalid/mcp
    auth:
      type: oauth
      grant: client_credentials
      client:
        type: static
        clientId: service-client
        clientSecret: service-secret
`);
    expect(clientCredentials.ok).toBe(false);

    const configurableRedirect = parseMcpConfigYaml(`
configVersion: 1
servers:
  remote:
    transport: http
    url: https://example.invalid/mcp
    auth:
      type: oauth
      grant: authorization_code
      redirectUri: https://example.invalid/oauth/callback
      client: { type: dynamic }
`);
    expect(configurableRedirect.ok).toBe(false);
  });
});

describe("MCP config file mutations", () => {
  it("atomically upserts and removes servers from a missing config", async () => {
    const dataDir = await createDataDir();
    const configPath = resolveMcpConfigPath({ dataDir });

    const [first, second] = await Promise.all([
      mutateMcpConfigFile({
        configPath,
        mutation: { type: "upsert", server: stdioServer("alpha") },
      }),
      mutateMcpConfigFile({
        configPath,
        mutation: { type: "upsert", server: stdioServer("beta", "node") },
      }),
    ]);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(true);

    const loaded = await readMcpConfigFile(configPath);
    expect(Object.keys(loaded.config.servers)).toEqual(["alpha", "beta"]);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);

    const removed = await mutateMcpConfigFile({
      configPath,
      mutation: { type: "remove", serverId: "alpha" },
    });
    expect(removed.changed).toBe(true);
    expect(Object.keys(removed.config.servers)).toEqual(["beta"]);

    const noOp = await mutateMcpConfigFile({
      configPath,
      mutation: { type: "remove", serverId: "alpha" },
    });
    expect(noOp.changed).toBe(false);
  });

  it("refuses to mutate an invalid existing file", async () => {
    const dataDir = await createDataDir();
    const configPath = resolveMcpConfigPath({ dataDir });
    const invalid = "configVersion: 1\nservers:\n  bad:\n    transport: websocket\n";
    await writeFile(configPath, invalid, "utf8");

    await expect(
      mutateMcpConfigFile({
        configPath,
        mutation: { type: "upsert", server: stdioServer("good") },
      }),
    ).rejects.toBeInstanceOf(McpConfigError);
    expect(await readFile(configPath, "utf8")).toBe(invalid);
  });
});
