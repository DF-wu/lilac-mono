import { z } from "zod";

import {
  MCP_CONFIG_VERSION,
  MCP_MAX_SERVER_ID_LENGTH,
  type McpServerDefinition,
  type UniversalMcpConfig,
} from "./config-types";

export const mcpServerIdSchema = z
  .string()
  .min(1)
  .max(MCP_MAX_SERVER_ID_LENGTH)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    "server IDs must start with a letter or digit and contain only letters, digits, '_', or '-'",
  );

const jsonPointerSchema = z.string().refine(
  (pointer) =>
    pointer === "" ||
    (pointer.startsWith("/") &&
      !pointer
        .slice(1)
        .split("/")
        .some((part) => /~(?:[^01]|$)/.test(part))),
  "pointer must be an RFC 6901 JSON Pointer",
);

export const mcpValueSourceSchema = z.union([
  z.string(),
  z.strictObject({ env: z.string().min(1) }),
  z.strictObject({ file: z.string().min(1), pointer: jsonPointerSchema.optional() }),
]);

const staticOAuthClientSchema = z.strictObject({
  type: z.literal("static"),
  clientId: mcpValueSourceSchema,
  clientSecret: mcpValueSourceSchema.optional(),
});

const dynamicOAuthClientSchema = z.strictObject({ type: z.literal("dynamic") });

const authorizationCodeAuthSchema = z.strictObject({
  type: z.literal("oauth"),
  grant: z.literal("authorization_code"),
  scopes: z.array(z.string().min(1)).optional(),
  client: z.union([staticOAuthClientSchema, dynamicOAuthClientSchema]),
});

export const mcpAuthConfigSchema = authorizationCodeAuthSchema;

const stdioServerInputSchemaV1 = z.strictObject({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string().min(1), mcpValueSourceSchema).optional(),
});

const httpServerInputSchemaV1 = z
  .strictObject({
    transport: z.literal("http"),
    url: z.string().min(1),
    headers: z.record(z.string().min(1), mcpValueSourceSchema).optional(),
    auth: mcpAuthConfigSchema.optional(),
  })
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value.url);
    } catch {
      context.addIssue({ code: "custom", path: ["url"], message: "url must be an absolute URL" });
      return;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "url must use http: or https:; HTTP+SSE is not a supported transport",
      });
    }

    if (!value.auth) return;
    for (const header of Object.keys(value.headers ?? {})) {
      if (header.toLowerCase() !== "authorization") continue;
      context.addIssue({
        code: "custom",
        path: ["headers", header],
        message: "an Authorization header cannot be combined with OAuth configuration",
      });
    }
  });

export const mcpServerInputSchemaV1 = z.discriminatedUnion("transport", [
  stdioServerInputSchemaV1,
  httpServerInputSchemaV1,
]);

export const mcpConfigInputSchemaV1 = z.strictObject({
  configVersion: z.literal(MCP_CONFIG_VERSION),
  servers: z.record(mcpServerIdSchema, mcpServerInputSchemaV1).optional(),
});

export type McpConfigInputV1 = z.infer<typeof mcpConfigInputSchemaV1>;
export type McpServerInputV1 = z.infer<typeof mcpServerInputSchemaV1>;

export type McpConfigParseResult =
  | { ok: true; config: UniversalMcpConfig }
  | { ok: false; issues: readonly string[] };

const configVersionProbeSchema = z.object({ configVersion: z.number().int() });

function formatZodIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => {
    const issuePath = issue.path.length === 0 ? "<root>" : issue.path.join(".");
    return `${issuePath}: ${issue.message}`;
  });
}

function sortRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value !== undefined) sorted[key] = value;
  }
  return sorted;
}

function toUniversalConfig(input: McpConfigInputV1): UniversalMcpConfig {
  const servers: Record<string, McpServerDefinition> = {};

  for (const id of Object.keys(input.servers ?? {}).sort()) {
    const server = input.servers?.[id];
    if (!server) continue;

    servers[id] = {
      id,
      transportConfig:
        server.transport === "stdio"
          ? {
              transport: "stdio",
              command: server.command,
              args: [...(server.args ?? [])],
              ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
              env: sortRecord(server.env ?? {}),
            }
          : {
              transport: "http",
              url: server.url,
              headers: sortRecord(server.headers ?? {}),
              ...(server.auth === undefined ? {} : { auth: server.auth }),
            },
    };
  }

  return { configVersion: MCP_CONFIG_VERSION, servers };
}

function toConfigInputV1(config: UniversalMcpConfig): McpConfigInputV1 {
  if (config.configVersion !== MCP_CONFIG_VERSION) {
    throw new Error(`Cannot serialize unsupported MCP config version ${config.configVersion}`);
  }

  const servers: Record<string, unknown> = {};
  for (const id of Object.keys(config.servers).sort()) {
    const server = config.servers[id];
    if (!server) continue;
    if (server.id !== id) {
      throw new Error(
        `Cannot serialize MCP server ${JSON.stringify(id)} with mismatched ID ${JSON.stringify(server.id)}`,
      );
    }

    const transport = server.transportConfig;
    servers[id] =
      transport.transport === "stdio"
        ? {
            transport: "stdio",
            command: transport.command,
            ...(transport.args.length === 0 ? {} : { args: [...transport.args] }),
            ...(transport.cwd === undefined ? {} : { cwd: transport.cwd }),
            ...(Object.keys(transport.env).length === 0 ? {} : { env: sortRecord(transport.env) }),
          }
        : {
            transport: "http",
            url: transport.url,
            ...(Object.keys(transport.headers).length === 0
              ? {}
              : { headers: sortRecord(transport.headers) }),
            ...(transport.auth === undefined ? {} : { auth: transport.auth }),
          };
  }

  return mcpConfigInputSchemaV1.parse({ configVersion: MCP_CONFIG_VERSION, servers });
}

/** Parse an already-decoded YAML document using its required version discriminator. */
export function parseMcpConfigDocument(raw: unknown): McpConfigParseResult {
  if (raw === null || raw === undefined) {
    return {
      ok: false,
      issues: [
        "<root>: the document is empty; use configVersion: 1 with servers: {} for an empty configuration",
      ],
    };
  }

  const versionProbe = configVersionProbeSchema.safeParse(raw);
  if (!versionProbe.success) return { ok: false, issues: formatZodIssues(versionProbe.error) };
  if (versionProbe.data.configVersion !== MCP_CONFIG_VERSION) {
    return {
      ok: false,
      issues: [
        `configVersion: unsupported value ${JSON.stringify(versionProbe.data.configVersion)} (supported: ${MCP_CONFIG_VERSION})`,
      ],
    };
  }

  const parsed = mcpConfigInputSchemaV1.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: formatZodIssues(parsed.error) };
  return { ok: true, config: toUniversalConfig(parsed.data) };
}

export function parseMcpConfigYaml(source: string): McpConfigParseResult {
  let document: unknown;
  try {
    document = Bun.YAML.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, issues: [`<root>: failed to parse YAML: ${message}`] };
  }
  return parseMcpConfigDocument(document);
}

/** Serialize normalized config as deterministic v1 YAML and validate the emitted shape. */
export function serializeMcpConfigYaml(config: UniversalMcpConfig): string {
  const input = toConfigInputV1(config);
  return `${Bun.YAML.stringify(input, null, 2)}\n`;
}
