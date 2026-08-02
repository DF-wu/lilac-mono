import { z } from "zod";
import type { Result } from "better-result";

import {
  MCP_CONFIG_VERSION,
  mcpServerIdSchema,
  mcpServerInputSchemaV1,
  mutateMcpConfigFile,
  parseMcpConfigDocument,
  readMcpConfigFile,
  type McpConfigFileSnapshot,
  type McpOAuthCallbackControl,
  type McpOAuthProviderService,
  type McpRegistryApi,
  type McpRegistryConfigStatus,
  type McpReloadOutcome,
  type McpServerStatus,
} from "../../mcp";
import type { ServerTool } from "../types";
import { parseToolInput } from "../validation-error-message";
import { zodObjectToCliLines } from "./zod-cli";

const emptyInputSchema = z.strictObject({});
const serverIdInputSchema = z.strictObject({
  serverId: mcpServerIdSchema.describe("Configured MCP server ID."),
});
const optionalServerIdInputSchema = z.strictObject({
  serverId: mcpServerIdSchema
    .optional()
    .describe("Configured MCP server ID; omit for all servers."),
});

const [stdioServerInputSchema, httpServerInputSchema] = mcpServerInputSchemaV1.options;
const mcpAddInputSchema = z.discriminatedUnion("transport", [
  stdioServerInputSchema.extend({
    serverId: mcpServerIdSchema.describe("Configured MCP server ID."),
  }),
  httpServerInputSchema.extend({
    serverId: mcpServerIdSchema.describe("Configured MCP server ID."),
  }),
]);

type McpManagementProviders = Pick<McpOAuthProviderService, "reconcile" | "startAuthorization">;

function safeStatus(status: McpServerStatus): McpServerStatus {
  if (status.status === "available") {
    return {
      serverId: status.serverId,
      transport: status.transport,
      status: status.status,
      toolCount: status.toolCount,
    };
  }
  return {
    serverId: status.serverId,
    transport: status.transport,
    status: status.status,
    phase: status.phase,
    error: status.error,
  };
}

function safeConfigStatus(status: McpRegistryConfigStatus): McpRegistryConfigStatus {
  return status.status === "valid"
    ? { status: "valid" }
    : { status: "invalid", error: status.error };
}

function safeReloadOutcomes(outcomes: readonly McpReloadOutcome[]): readonly McpReloadOutcome[] {
  return outcomes.map((outcome) => ({
    serverId: outcome.serverId,
    reconciliation: outcome.reconciliation,
    result: outcome.result,
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
  }));
}

function resultToMcpToolValue<T, E extends Error>(result: Result<T, E>): T {
  if (result.status === "ok") return result.value;
  // ServerTool reports failures through the host's exception channel; never throw the TaggedError.
  throw new Error(result.error.message);
}

export class McpManagement implements ServerTool {
  id = "mcp";
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly params: {
      readonly registry: McpRegistryApi;
      readonly providers: McpManagementProviders;
      readonly callback?: McpOAuthCallbackControl;
      readonly configPath: string;
    },
  ) {}

  async init(): Promise<void> {}
  async destroy(): Promise<void> {}

  async list() {
    return [
      {
        callableId: "mcp.list",
        name: "MCP List",
        description: "List configured MCP server IDs and non-sensitive transport metadata.",
        shortInput: zodObjectToCliLines(emptyInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(emptyInputSchema),
      },
      {
        callableId: "mcp.add",
        name: "MCP Add",
        description:
          "Atomically add or replace an HTTP or stdio MCP server, then reconcile OAuth providers and reload it.",
        shortInput: zodObjectToCliLines(mcpAddInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(mcpAddInputSchema),
        primaryPositional: { field: "serverId" },
      },
      {
        callableId: "mcp.remove",
        name: "MCP Remove",
        description:
          "Atomically remove an MCP server and reload the registry. Persisted OAuth credentials are retained.",
        shortInput: zodObjectToCliLines(serverIdInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(serverIdInputSchema),
        primaryPositional: { field: "serverId" },
      },
      {
        callableId: "mcp.status",
        name: "MCP Status",
        description: "Show safe connection status for one configured MCP server or all servers.",
        shortInput: zodObjectToCliLines(optionalServerIdInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(optionalServerIdInputSchema),
        primaryPositional: { field: "serverId" },
      },
      {
        callableId: "mcp.auth",
        name: "MCP Auth",
        description: "Start authorization-code OAuth and return its one-time authorization URL.",
        shortInput: zodObjectToCliLines(serverIdInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(serverIdInputSchema),
        primaryPositional: { field: "serverId" },
      },
      {
        callableId: "mcp.reload",
        name: "MCP Reload",
        description: "Reconcile providers and reload one MCP server or all configured servers.",
        shortInput: zodObjectToCliLines(optionalServerIdInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(optionalServerIdInputSchema),
        primaryPositional: { field: "serverId" },
      },
    ];
  }

  async call(callableId: string, rawInput: Record<string, unknown>): Promise<unknown> {
    if (callableId === "mcp.list") {
      parseToolInput({ callableId, input: rawInput, schema: emptyInputSchema });
      const snapshot = resultToMcpToolValue(await readMcpConfigFile(this.params.configPath));
      return {
        servers: Object.values(snapshot.config.servers)
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((server) => ({
            serverId: server.id,
            transport: server.transportConfig.transport,
            authentication:
              server.transportConfig.transport === "http"
                ? (server.transportConfig.auth?.grant ?? "none")
                : "none",
          })),
      };
    }

    if (callableId === "mcp.add") {
      const input = parseToolInput({
        callableId,
        input: rawInput,
        schema: mcpAddInputSchema,
      });
      const { serverId, ...transport } = input;
      const parsed = parseMcpConfigDocument({
        configVersion: MCP_CONFIG_VERSION,
        servers: { [serverId]: transport },
      });
      if (!parsed.ok) {
        throw new Error(`Could not normalize MCP server input: ${parsed.issues.join("; ")}`);
      }
      const server = parsed.config.servers[serverId];
      if (!server) throw new Error(`Could not normalize MCP server ${JSON.stringify(serverId)}`);

      return await this.enqueueManagementOperation(async () => {
        const mutation = resultToMcpToolValue(
          await mutateMcpConfigFile({
            configPath: this.params.configPath,
            mutation: { type: "upsert", server },
          }),
        );
        await this.waitUntilRegistryInitialized();
        this.params.providers.reconcile(mutation.config);
        const reload = safeReloadOutcomes(
          resultToMcpToolValue(await this.params.registry.reload(serverId)),
        );
        return {
          mutation: {
            type: "upsert" as const,
            serverId,
            changed: mutation.changed,
            result: mutation.changed
              ? mutation.previousConfig.servers[serverId]
                ? ("replaced" as const)
                : ("added" as const)
              : ("unchanged" as const),
          },
          reload,
        };
      });
    }

    if (callableId === "mcp.remove") {
      const { serverId } = parseToolInput({
        callableId,
        input: rawInput,
        schema: serverIdInputSchema,
      });
      return await this.enqueueManagementOperation(async () => {
        const mutation = resultToMcpToolValue(
          await mutateMcpConfigFile({
            configPath: this.params.configPath,
            mutation: { type: "remove", serverId },
          }),
        );
        await this.waitUntilRegistryInitialized();
        this.params.providers.reconcile(mutation.config);
        const reload = safeReloadOutcomes(
          resultToMcpToolValue(await this.params.registry.reload(serverId)),
        );
        return {
          mutation: {
            type: "remove" as const,
            serverId,
            changed: mutation.changed,
            result: mutation.changed ? ("removed" as const) : ("not_found" as const),
          },
          reload,
        };
      });
    }

    if (callableId === "mcp.status") {
      const { serverId } = parseToolInput({
        callableId,
        input: rawInput,
        schema: optionalServerIdInputSchema,
      });
      const statuses = this.params.registry
        .list()
        .filter((status) => serverId === undefined || status.serverId === serverId)
        .map(safeStatus);
      const configStatus = this.params.registry.getConfigStatus?.() ?? { status: "valid" as const };
      const callback = this.params.callback?.getStatus();
      return {
        config: safeConfigStatus(configStatus),
        statuses,
        ...(callback ? { callback } : {}),
      };
    }

    if (callableId === "mcp.auth") {
      const { serverId } = parseToolInput({
        callableId,
        input: rawInput,
        schema: serverIdInputSchema,
      });
      const callback = this.params.callback;
      if (!callback) {
        throw new Error(
          "MCP OAuth callback listener is not configured. Restart Lilac Core, then retry mcp.auth.",
        );
      }
      const callbackStatus = callback.start();
      if (callbackStatus.status === "unavailable") {
        throw new Error(
          `MCP OAuth callback listener is unavailable on ${callbackStatus.hostname}:${callbackStatus.port}. Ensure the port is free, then retry mcp.auth.`,
        );
      }
      const result = await this.params.providers.startAuthorization(serverId);
      return result.status === "authorized"
        ? { status: result.status }
        : {
            status: result.status,
            authorizationUrl: result.authorizationUrl,
            callbackUrl: result.callbackUrl,
          };
    }

    if (callableId === "mcp.reload") {
      const { serverId } = parseToolInput({
        callableId,
        input: rawInput,
        schema: optionalServerIdInputSchema,
      });
      return await this.enqueueManagementOperation(async () => {
        await this.waitUntilRegistryInitialized();
        const read = await readMcpConfigFile(this.params.configPath);
        if (read.status === "error") {
          const reload = resultToMcpToolValue(await this.params.registry.reload(serverId));
          return { reload: safeReloadOutcomes(reload) };
        }
        const snapshot: McpConfigFileSnapshot = read.value;
        this.params.providers.reconcile(snapshot.config);
        const reload = resultToMcpToolValue(await this.params.registry.reload(serverId));
        return { reload: safeReloadOutcomes(reload) };
      });
    }

    throw new Error(`Invalid callable ID '${callableId}'`);
  }

  private enqueueManagementOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async waitUntilRegistryInitialized(): Promise<void> {
    const waitUntilInitialized = this.params.registry.waitUntilInitialized;
    if (!waitUntilInitialized)
      throw new Error("MCP registry initialization barrier is unavailable");
    await waitUntilInitialized.call(this.params.registry);
  }
}
