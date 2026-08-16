import { z } from "zod";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { defineServerTool } from "../types";

import {
  MCP_CONFIG_VERSION,
  mcpServerIdSchema,
  mcpServerInputSchemaV1,
  mutateMcpConfigFile,
  parseMcpConfigDocument,
  readMcpConfigFile,
  type McpOAuthCallbackControl,
  type McpOAuthProviderService,
  type McpRegistryApi,
  type McpRegistryConfigStatus,
  type McpReloadOutcome,
  type McpServerStatus,
} from "../../mcp";
import type { ServerTool } from "../types";

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

class McpToolFailure extends TaggedError("McpToolFailure")<{
  readonly message: string;
}> {}

function resultToMcpToolValue<T, E extends Error>(result: ResultType<T, E>): T {
  return result.match({
    ok: (value) => () => value,
    err: (error) => () => {
      // ServerTool reports failures through the host's exception channel; never throw the TaggedError.
      throw new Error(error.message);
    },
  })();
}

function signalMcpFailureToToolHost(message: string): never {
  return resultToMcpToolValue(Result.err(new McpToolFailure({ message })));
}

export class McpManagement implements ServerTool {
  id = "mcp";
  private readonly serverTool: ServerTool;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly params: {
      readonly registry: McpRegistryApi;
      readonly providers: McpManagementProviders;
      readonly callback?: McpOAuthCallbackControl;
      readonly configPath: string;
    },
  ) {
    this.serverTool = defineServerTool({
      id: this.id,
      callables: ({ callable }) => ({
        "mcp.list": callable({
          name: "MCP List",
          description: "List configured MCP server IDs and non-sensitive transport metadata.",
          inputSchema: emptyInputSchema,
          run: () => this.callList(),
        }),
        "mcp.add": callable({
          name: "MCP Add",
          description:
            "Atomically add or replace an HTTP or stdio MCP server, then reconcile OAuth providers and reload it.",
          inputSchema: mcpAddInputSchema,
          primaryPositional: "serverId",
          run: (input) => this.callAdd(input),
        }),
        "mcp.remove": callable({
          name: "MCP Remove",
          description:
            "Atomically remove an MCP server and reload the registry. Persisted OAuth credentials are retained.",
          inputSchema: serverIdInputSchema,
          primaryPositional: "serverId",
          run: (input) => this.callRemove(input),
        }),
        "mcp.status": callable({
          name: "MCP Status",
          description: "Show safe connection status for one configured MCP server or all servers.",
          inputSchema: optionalServerIdInputSchema,
          primaryPositional: "serverId",
          run: (input) => this.callStatus(input),
        }),
        "mcp.auth": callable({
          name: "MCP Auth",
          description: "Start authorization-code OAuth and return its one-time authorization URL.",
          inputSchema: serverIdInputSchema,
          primaryPositional: "serverId",
          run: (input) => this.callAuth(input),
        }),
        "mcp.reload": callable({
          name: "MCP Reload",
          description: "Reconcile providers and reload one MCP server or all configured servers.",
          inputSchema: optionalServerIdInputSchema,
          primaryPositional: "serverId",
          run: (input) => this.callReload(input),
        }),
      }),
    });
  }

  async init(): Promise<void> {
    await this.serverTool.init();
  }

  async destroy(): Promise<void> {
    await this.serverTool.destroy();
  }

  async list() {
    return this.serverTool.list();
  }

  async call(callableId: string, rawInput: Record<string, unknown>): Promise<unknown> {
    return this.serverTool.call(callableId, rawInput);
  }

  private async callList() {
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

  private async callAdd(input: z.output<typeof mcpAddInputSchema>) {
    const { serverId, ...transport } = input;
    const parsed = parseMcpConfigDocument({
      configVersion: MCP_CONFIG_VERSION,
      servers: { [serverId]: transport },
    });
    if (!parsed.ok) {
      return signalMcpFailureToToolHost(
        `Could not normalize MCP server input: ${parsed.issues.join("; ")}`,
      );
    }
    const server = parsed.config.servers[serverId];
    if (!server)
      return signalMcpFailureToToolHost(
        `Could not normalize MCP server ${JSON.stringify(serverId)}`,
      );

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
      let mutationResult: "replaced" | "added" | "unchanged" = "unchanged";
      if (mutation.changed) {
        mutationResult = mutation.previousConfig.servers[serverId] ? "replaced" : "added";
      }
      return {
        mutation: {
          type: "upsert" as const,
          serverId,
          changed: mutation.changed,
          result: mutationResult,
        },
        reload,
      };
    });
  }

  private async callRemove({ serverId }: z.output<typeof serverIdInputSchema>) {
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

  private callStatus({ serverId }: z.output<typeof optionalServerIdInputSchema>) {
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

  private async callAuth({ serverId }: z.output<typeof serverIdInputSchema>) {
    const callback = this.params.callback;
    if (!callback) {
      return signalMcpFailureToToolHost(
        "MCP OAuth callback listener is not configured. Restart Lilac Core, then retry mcp.auth.",
      );
    }
    const callbackStatus = callback.start();
    if (callbackStatus.status === "unavailable") {
      return signalMcpFailureToToolHost(
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

  private async callReload({ serverId }: z.output<typeof optionalServerIdInputSchema>) {
    return await this.enqueueManagementOperation(async () => {
      await this.waitUntilRegistryInitialized();
      const read = await readMcpConfigFile(this.params.configPath);
      const snapshot = read.match({
        err: () => null,
        ok: (value) => value,
      });
      if (snapshot) {
        this.params.providers.reconcile(snapshot.config);
      }
      const reload = resultToMcpToolValue(await this.params.registry.reload(serverId));
      return { reload: safeReloadOutcomes(reload) };
    });
  }

  private enqueueManagementOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = Promise.allSettled([result]).then(() => undefined);
    return result;
  }

  private async waitUntilRegistryInitialized(): Promise<void> {
    const waitUntilInitialized = this.params.registry.waitUntilInitialized;
    if (!waitUntilInitialized)
      return signalMcpFailureToToolHost("MCP registry initialization barrier is unavailable");
    const initialized = await waitUntilInitialized.call(this.params.registry);
    initialized.match({
      ok: () => () => undefined,
      err: (error) => () => signalMcpFailureToToolHost(error.message),
    })();
  }
}
