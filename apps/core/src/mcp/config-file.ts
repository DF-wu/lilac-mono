import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  createEmptyMcpConfig,
  MCP_CONFIG_FILE_NAME,
  type McpServerDefinition,
  type UniversalMcpConfig,
} from "./config-types";
import { mcpServerIdSchema, parseMcpConfigYaml, serializeMcpConfigYaml } from "./config";

const errorCodeSchema = z.object({ code: z.string() });
const mutationQueues = new Map<string, Promise<void>>();

export class McpConfigError extends Error {
  readonly configPath: string;
  readonly issues: readonly string[];

  constructor(options: { configPath: string; issues: readonly string[] }) {
    super(
      `Invalid MCP configuration at ${options.configPath}:\n${options.issues
        .map((issue) => `  - ${issue}`)
        .join("\n")}`,
    );
    this.name = "McpConfigError";
    this.configPath = options.configPath;
    this.issues = options.issues;
  }
}

export type McpConfigFileSnapshot = {
  readonly configPath: string;
  readonly exists: boolean;
  readonly config: UniversalMcpConfig;
};

export type McpConfigMutation =
  | { readonly type: "upsert"; readonly server: McpServerDefinition }
  | { readonly type: "remove"; readonly serverId: string };

export type McpConfigMutationResult = {
  readonly configPath: string;
  readonly changed: boolean;
  readonly previousConfig: UniversalMcpConfig;
  readonly config: UniversalMcpConfig;
};

function isMissingFileError(error: unknown): boolean {
  const parsed = errorCodeSchema.safeParse(error);
  return parsed.success && (parsed.data.code === "ENOENT" || parsed.data.code === "ENOTDIR");
}

function enqueueMutation<T>(configPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(configPath) ?? Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  mutationQueues.set(configPath, settled);

  return result.finally(() => {
    if (mutationQueues.get(configPath) === settled) mutationQueues.delete(configPath);
  });
}

export function resolveMcpConfigPath(options: { dataDir: string }): string {
  return path.join(options.dataDir, MCP_CONFIG_FILE_NAME);
}

export async function readMcpConfigFile(configPath: string): Promise<McpConfigFileSnapshot> {
  let source: string;
  try {
    source = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return { configPath, exists: false, config: createEmptyMcpConfig() };
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new McpConfigError({
      configPath,
      issues: [`<root>: failed to read file: ${message}`],
    });
  }

  const parsed = parseMcpConfigYaml(source);
  if (!parsed.ok) throw new McpConfigError({ configPath, issues: parsed.issues });
  return { configPath, exists: true, config: parsed.config };
}

/** Write a complete validated config through a same-directory rename. */
export async function writeMcpConfigFileAtomic(
  configPath: string,
  config: UniversalMcpConfig,
): Promise<void> {
  const source = serializeMcpConfigYaml(config);
  const parent = path.dirname(configPath);
  await fs.mkdir(parent, { recursive: true });

  const temporaryPath = path.join(parent, `.${path.basename(configPath)}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(source, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, configPath);
    renamed = true;
  } finally {
    if (!renamed) await fs.rm(temporaryPath, { force: true });
  }
}

/**
 * Apply one add/replace/remove operation against the latest file contents.
 * Mutations to the same path are serialized within the Core process.
 */
export function mutateMcpConfigFile(options: {
  configPath: string;
  mutation: McpConfigMutation;
}): Promise<McpConfigMutationResult> {
  return enqueueMutation(options.configPath, async () => {
    const snapshot = await readMcpConfigFile(options.configPath);
    const previousConfig = snapshot.config;
    const servers = { ...previousConfig.servers };

    if (options.mutation.type === "upsert") {
      mcpServerIdSchema.parse(options.mutation.server.id);
      servers[options.mutation.server.id] = options.mutation.server;
    } else {
      mcpServerIdSchema.parse(options.mutation.serverId);
      delete servers[options.mutation.serverId];
    }

    const config: UniversalMcpConfig = {
      configVersion: previousConfig.configVersion,
      servers,
    };
    const changed = serializeMcpConfigYaml(previousConfig) !== serializeMcpConfigYaml(config);
    if (changed) await writeMcpConfigFileAtomic(options.configPath, config);

    return { configPath: options.configPath, changed, previousConfig, config };
  });
}
