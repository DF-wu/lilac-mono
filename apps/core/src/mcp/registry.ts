import { createHash } from "node:crypto";
import path from "node:path";

import {
  createMCPClient,
  UnauthorizedError,
  type ListToolsResult,
  type MCPClientConfig,
  type MCPTransport,
} from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { z } from "zod";

import { catalogToolStableId, type CatalogToolIdentity } from "./catalog-identity";
import type { McpServerDefinition } from "./config-types";
import { McpConfigError, readMcpConfigFile, type McpConfigFileSnapshot } from "./config-file";
import type {
  McpCatalogTool,
  McpConvertedTool,
  McpRegistryApi,
  McpRegistryClient,
  McpRegistryConfigStatus,
  McpRegistryOptions,
  McpRegistryPhase,
  McpRegistryTransportInput,
  McpReloadOutcome,
  McpReloadReconciliation,
  McpServerStatus,
} from "./registry-types";
import { resolveMcpValueSourceMap, validateHttpHeaders } from "./value-source";

const DEFAULT_INIT_DEADLINE_MS = 30_000;
const MAX_SAFE_ERROR_LENGTH = 1_000;
const mcpApplicationErrorSchema = z.object({
  name: z.literal("MCPClientError"),
  code: z.number(),
});

type RegistryEntry = {
  readonly definition: McpServerDefinition;
  readonly fingerprint: string;
  readonly transportFingerprint?: string;
  readonly client?: McpRegistryClient;
  readonly sensitiveValues: readonly string[];
  readonly status: McpServerStatus;
  readonly tools: readonly McpCatalogTool[];
};

type InitializedCandidate = {
  readonly client: McpRegistryClient;
  readonly sensitiveValues: readonly string[];
  readonly transportFingerprint: string;
  readonly tools: readonly McpCatalogTool[];
};

type ResolvedTransport = {
  readonly input: McpRegistryTransportInput;
  readonly sensitiveValues: readonly string[];
};

type CandidateResult =
  | { readonly ok: true; readonly candidate: InitializedCandidate }
  | {
      readonly ok: false;
      readonly status: "unavailable" | "authentication_required";
      readonly phase: McpRegistryPhase;
      readonly error: string;
    };

class McpRegistryDeadlineError extends Error {
  constructor(serverId: string, deadlineMs: number) {
    super(`MCP server ${JSON.stringify(serverId)} initialization exceeded ${deadlineMs}ms`);
    this.name = "McpRegistryDeadlineError";
  }
}

class McpRegistryCloseDeadlineError extends Error {
  constructor(serverId: string, deadlineMs: number) {
    super(`MCP server ${JSON.stringify(serverId)} client close exceeded ${deadlineMs}ms`);
    this.name = "McpRegistryCloseDeadlineError";
  }
}

export class McpAuthenticationRequiredError extends Error {
  constructor(serverId: string) {
    super(`MCP server ${JSON.stringify(serverId)} requires authentication`);
    this.name = "McpAuthenticationRequiredError";
  }
}

function defaultScheduleDeadline(callback: () => void, delayMs: number): () => void {
  const timeout = setTimeout(callback, delayMs);
  return () => clearTimeout(timeout);
}

function defaultCreateTransport(input: McpRegistryTransportInput): MCPClientConfig["transport"] {
  if (input.transport === "stdio") {
    return new Experimental_StdioMCPTransport({
      command: input.command,
      args: [...input.args],
      env: { ...input.env },
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    });
  }

  return {
    type: "http",
    url: input.url,
    headers: { ...input.headers },
    ...(input.authProvider === undefined ? {} : { authProvider: input.authProvider }),
  };
}

function definitionFingerprint(definition: McpServerDefinition): string {
  return JSON.stringify(definition.transportConfig);
}

function transportFingerprint(input: McpRegistryTransportInput): string {
  const normalized =
    input.transport === "stdio"
      ? input
      : {
          transport: input.transport,
          url: input.url,
          headers: input.headers,
          hasAuthProvider: input.authProvider !== undefined,
        };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function freezeOutcome(outcome: McpReloadOutcome): McpReloadOutcome {
  return Object.freeze(outcome);
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username) url.username = "<redacted>";
    if (url.password) url.password = "<redacted>";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<redacted-url>";
  }
}

function safeErrorText(error: unknown, sensitiveValues: readonly string[] = []): string {
  let message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";

  for (const value of sensitiveValues) {
    if (value.length > 0) message = message.replaceAll(value, "<redacted>");
  }
  message = message.replace(/https?:\/\/[^\s"'<>]+/gi, redactUrl);
  message = message.replace(
    /(authorization\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^\s,;]+/gi,
    "$1<redacted>",
  );
  message = message.replace(/\b(bearer|basic)\s+[^\s,;]+/gi, "$1 <redacted>");
  message = message.replace(/([?&](?:code|state|token|key|secret)=)[^&\s]+/gi, "$1<redacted>");
  message = message.replace(
    /\b(token|secret|password|api[_-]?key|code|state)\s*[:=]\s*[^\s,;]+/gi,
    "$1=<redacted>",
  );
  return message.length <= MAX_SAFE_ERROR_LENGTH
    ? message
    : `${message.slice(0, MAX_SAFE_ERROR_LENGTH)}...`;
}

function configErrorStatus(
  error: unknown,
): Extract<McpRegistryConfigStatus, { readonly status: "invalid" }> {
  if (!(error instanceof McpConfigError)) {
    return Object.freeze({
      status: "invalid",
      error:
        "Could not read MCP configuration. Check the file syntax and permissions, then run mcp.reload.",
    });
  }

  const detail =
    error.issues.length === 0
      ? "The configuration is invalid."
      : safeErrorText(error.issues.join("; "));
  return Object.freeze({
    status: "invalid",
    error: `Invalid MCP configuration at ${JSON.stringify(error.configPath)}: ${detail} Fix the file, then run mcp.reload.`,
  });
}

function isCustomTransport(transport: MCPClientConfig["transport"]): transport is MCPTransport {
  return (
    "start" in transport &&
    typeof transport.start === "function" &&
    "send" in transport &&
    typeof transport.send === "function" &&
    "close" in transport &&
    typeof transport.close === "function"
  );
}

export class McpRegistry implements McpRegistryApi {
  private readonly configPath: string;
  private readonly initDeadlineMs: number;
  private readonly valueContext: {
    readonly baseDir: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly readTextFile?: (filePath: string) => Promise<string>;
  };
  private readonly readConfig;
  private readonly createClient;
  private readonly createTransport;
  private readonly createAuthProvider;
  private readonly scheduleDeadline;
  private readonly clientClosures = new WeakMap<object, Promise<void>>();
  private readonly transportClosures = new WeakMap<object, Promise<void>>();
  private entries = new Map<string, RegistryEntry>();
  private configStatus: McpRegistryConfigStatus = Object.freeze({ status: "valid" });
  private statusSnapshot: readonly McpServerStatus[] = Object.freeze([]);
  private toolSnapshot: readonly McpCatalogTool[] = Object.freeze([]);
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private initialized = false;
  private stopped = false;

  constructor(options: McpRegistryOptions) {
    const deadline = options.initDeadlineMs ?? DEFAULT_INIT_DEADLINE_MS;
    if (!Number.isFinite(deadline)) throw new Error("MCP initialization deadline must be finite");
    if (deadline <= 0) throw new Error("MCP initialization deadline must be greater than zero");

    this.configPath = options.configPath;
    this.initDeadlineMs = deadline;
    this.valueContext = {
      baseDir: path.dirname(options.configPath),
      env: options.env ?? process.env,
      ...(options.readTextFile === undefined ? {} : { readTextFile: options.readTextFile }),
    };
    this.readConfig = options.dependencies?.readConfig ?? readMcpConfigFile;
    this.createClient = options.dependencies?.createClient ?? createMCPClient;
    this.createTransport = options.dependencies?.createTransport ?? defaultCreateTransport;
    this.createAuthProvider = options.dependencies?.createAuthProvider;
    this.scheduleDeadline = options.dependencies?.scheduleDeadline ?? defaultScheduleDeadline;
  }

  init(): Promise<void> {
    return this.runLifecycle(async () => {
      if (this.stopped) throw new Error("MCP registry has been shut down");
      if (this.initialized) return;

      let snapshot: McpConfigFileSnapshot;
      try {
        snapshot = await this.readConfig(this.configPath);
        this.configStatus = Object.freeze({ status: "valid" });
      } catch (error) {
        this.configStatus = configErrorStatus(error);
        this.initialized = true;
        return;
      }
      const definitions = Object.values(snapshot.config.servers).sort((left, right) =>
        left.id.localeCompare(right.id),
      );
      await Promise.all(
        definitions.map(async (definition) => {
          const result = await this.initializeCandidate(definition);
          this.entries.set(definition.id, this.entryFromResult(definition, result));
          this.publishSnapshots();
        }),
      );
      this.initialized = true;
      this.publishSnapshots();
    });
  }

  waitUntilInitialized(): Promise<void> {
    return this.runLifecycle(async () => {
      this.assertRunning();
    });
  }

  reload(serverId?: string): Promise<readonly McpReloadOutcome[]> {
    return this.runLifecycle(async () => {
      this.assertRunning();
      let snapshot: McpConfigFileSnapshot;
      try {
        snapshot = await this.readConfig(this.configPath);
        this.configStatus = Object.freeze({ status: "valid" });
      } catch (error) {
        const configStatus = configErrorStatus(error);
        this.configStatus = configStatus;
        throw new Error(configStatus.error);
      }
      const ids = new Set<string>();
      if (serverId === undefined) {
        for (const id of this.entries.keys()) ids.add(id);
        for (const id of Object.keys(snapshot.config.servers)) ids.add(id);
      } else {
        ids.add(serverId);
      }

      const outcomes = await Promise.all(
        [...ids].sort().map((id) => this.reconcileServer(id, snapshot.config.servers[id])),
      );
      this.publishSnapshots();
      return Object.freeze(outcomes);
    });
  }

  list(): readonly McpServerStatus[] {
    return this.statusSnapshot;
  }

  getConfigStatus(): McpRegistryConfigStatus {
    return this.configStatus;
  }

  getTools(): readonly McpCatalogTool[] {
    return this.toolSnapshot;
  }

  shutdown(): Promise<void> {
    return this.runLifecycle(async () => {
      if (this.stopped) return;
      this.stopped = true;
      const entries = [...this.entries.values()];
      this.entries.clear();
      this.publishSnapshots();

      const failures: string[] = [];
      await Promise.all(
        entries.map(async (entry) => {
          if (!entry.client) return;
          try {
            await this.closeClientWithinDeadline(entry.definition.id, entry.client);
          } catch (error) {
            failures.push(`${entry.definition.id}: ${safeErrorText(error, entry.sensitiveValues)}`);
          }
        }),
      );
      if (failures.length > 0) {
        throw new Error(`Failed to close MCP clients: ${failures.sort().join("; ")}`);
      }
    });
  }

  private runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(operation);
    this.lifecycleQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertRunning(): void {
    if (this.stopped) throw new Error("MCP registry has been shut down");
    if (!this.initialized) throw new Error("MCP registry has not been initialized");
  }

  private async reconcileServer(
    serverId: string,
    definition: McpServerDefinition | undefined,
  ): Promise<McpReloadOutcome> {
    const current = this.entries.get(serverId);
    if (!definition) {
      if (!current) {
        return freezeOutcome({ serverId, reconciliation: "not_found", result: "not_found" });
      }

      this.entries.delete(serverId);
      this.publishSnapshots();
      const closeError = await this.closeEntry(current);
      return freezeOutcome({
        serverId,
        reconciliation: "removed",
        result: "removed",
        ...(closeError === undefined ? {} : { error: closeError }),
      });
    }

    let reconciliation = this.classifyReconciliation(current, definition);
    let resolvedTransport: ResolvedTransport | undefined;
    if (reconciliation === "unchanged" && current) {
      try {
        resolvedTransport = await this.resolveTransport(definition);
      } catch (error) {
        return freezeOutcome({
          serverId,
          reconciliation,
          result: "retained",
          error: safeErrorText(error, current.sensitiveValues),
        });
      }
      if (current.transportFingerprint !== transportFingerprint(resolvedTransport.input)) {
        reconciliation = "changed";
      }
    }
    if (reconciliation === "unchanged" && current) {
      if (!current.client) {
        throw new Error(`Available MCP server ${JSON.stringify(serverId)} has no client`);
      }
      const retainedClient = current.client;
      try {
        const tools = await this.withDeadline(definition.id, (signal) =>
          this.discoverTools(definition, retainedClient, signal),
        );
        if (this.entries.get(serverId) !== current || current.status.status !== "available") {
          return freezeOutcome({
            serverId,
            reconciliation,
            result: "unavailable",
            error: "MCP server became unavailable while refreshing its tool manifest",
          });
        }
        this.entries.set(serverId, {
          ...current,
          tools,
          status: Object.freeze({
            serverId,
            transport: definition.transportConfig.transport,
            status: "available",
            toolCount: tools.length,
          }),
        });
        this.publishSnapshots();
        return freezeOutcome({ serverId, reconciliation, result: "available" });
      } catch (error) {
        const latest = this.entries.get(serverId);
        if (!latest || latest.client !== retainedClient || latest.status.status !== "available") {
          return freezeOutcome({
            serverId,
            reconciliation,
            result:
              latest?.status.status === "authentication_required"
                ? "authentication_required"
                : "unavailable",
            error:
              latest?.status.status === "unavailable" ||
              latest?.status.status === "authentication_required"
                ? latest.status.error
                : "MCP server became unavailable while refreshing its tool manifest",
          });
        }
        return freezeOutcome({
          serverId,
          reconciliation,
          result: "retained",
          error: safeErrorText(error, current.sensitiveValues),
        });
      }
    }

    let priorCloseError: string | undefined;
    if (reconciliation === "unavailable" && current) {
      priorCloseError = await this.closeEntry(current);
      this.entries.set(serverId, { ...current, client: undefined });
    }

    const result = await this.initializeCandidate(definition, resolvedTransport);
    if (!result.ok) {
      if (reconciliation === "changed" && current?.status.status === "available") {
        return freezeOutcome({
          serverId,
          reconciliation,
          result: "retained",
          error: result.error,
        });
      }

      this.entries.set(serverId, this.entryFromResult(definition, result));
      this.publishSnapshots();
      return freezeOutcome({
        serverId,
        reconciliation,
        result: result.status,
        error:
          priorCloseError === undefined
            ? result.error
            : `${result.error}; failed to close previous client: ${priorCloseError}`,
      });
    }

    const replacement = this.entryFromResult(definition, result);
    this.entries.set(serverId, replacement);
    this.publishSnapshots();
    const closeError =
      current && reconciliation !== "unavailable" ? await this.closeEntry(current) : undefined;
    const cleanupError = closeError ?? priorCloseError;
    return freezeOutcome({
      serverId,
      reconciliation,
      result: "available",
      ...(cleanupError === undefined ? {} : { error: cleanupError }),
    });
  }

  private classifyReconciliation(
    current: RegistryEntry | undefined,
    definition: McpServerDefinition,
  ): McpReloadReconciliation {
    if (!current) return "new";
    if (current.status.status !== "available") return "unavailable";
    return current.fingerprint === definitionFingerprint(definition) ? "unchanged" : "changed";
  }

  private async initializeCandidate(
    definition: McpServerDefinition,
    prefetchedTransport?: ResolvedTransport,
  ): Promise<CandidateResult> {
    let phase: McpRegistryPhase = "configuration";
    let sensitiveValues: readonly string[] = [];
    let client: McpRegistryClient | undefined;
    const holder: { client?: McpRegistryClient; terminalError?: unknown } = {};

    try {
      const resolved = prefetchedTransport ?? (await this.resolveTransport(definition));
      sensitiveValues = resolved.sensitiveValues;
      const transport = this.createTransport(resolved.input);
      phase = "connection";

      const candidate = await this.withDeadline(
        definition.id,
        async (signal) => {
          const createdClient = await this.createClient({
            transport,
            clientName: `lilac-mcp-${definition.id}`,
            maxRetries: 0,
            onUncaughtError: (error) => {
              holder.terminalError = error;
              if (holder.client) this.handleTerminalFailure(definition.id, holder.client, error);
            },
          });
          client = createdClient;
          holder.client = createdClient;
          this.observeTransportClose(definition.id, createdClient, transport);
          if (signal.aborted) this.closeClientInBackground(createdClient);
          signal.throwIfAborted();
          if (holder.terminalError !== undefined) throw holder.terminalError;

          phase = "discovery";
          const tools = await this.discoverTools(definition, createdClient, signal, holder);
          return {
            client: createdClient,
            sensitiveValues: Object.freeze([...sensitiveValues]),
            transportFingerprint: transportFingerprint(resolved.input),
            tools,
          } satisfies InitializedCandidate;
        },
        () => {
          if (isCustomTransport(transport)) this.closeTransportInBackground(transport);
        },
      );

      return { ok: true, candidate };
    } catch (error) {
      if (client) {
        this.closeClientInBackground(client);
      }
      return {
        ok: false,
        status: this.failureStatus(definition, error),
        phase,
        error: safeErrorText(error, sensitiveValues),
      };
    }
  }

  private async resolveTransport(definition: McpServerDefinition): Promise<ResolvedTransport> {
    const config = definition.transportConfig;
    if (config.transport === "stdio") {
      const resolved = await resolveMcpValueSourceMap(config.env, this.valueContext);
      if (!resolved.ok) throw new Error(`Failed to resolve stdio environment: ${resolved.error}`);
      return {
        input: {
          transport: "stdio",
          command: config.command,
          args: config.args,
          ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
          env: resolved.values,
        },
        sensitiveValues: Object.freeze(Object.values(resolved.values)),
      };
    }

    const resolved = await resolveMcpValueSourceMap(config.headers, this.valueContext);
    if (!resolved.ok) throw new Error(`Failed to resolve HTTP headers: ${resolved.error}`);
    const validHeaders = validateHttpHeaders(resolved.values);
    if (!validHeaders.ok) throw new Error(`Invalid HTTP headers: ${validHeaders.error}`);

    let authProvider;
    if (config.auth) {
      authProvider = await this.createAuthProvider?.({
        server: definition,
        configPath: this.configPath,
        valueContext: this.valueContext,
      });
      if (!authProvider) {
        if (config.auth.grant === "authorization_code") {
          throw new McpAuthenticationRequiredError(definition.id);
        }
        throw new Error(
          `No OAuth provider is configured for MCP server ${JSON.stringify(definition.id)}`,
        );
      }
      if (config.auth.grant === "authorization_code" && !(await authProvider.tokens())) {
        throw new McpAuthenticationRequiredError(definition.id);
      }
    }

    return {
      input: {
        transport: "http",
        url: config.url,
        headers: resolved.values,
        ...(authProvider === undefined ? {} : { authProvider }),
      },
      sensitiveValues: Object.freeze(Object.values(resolved.values)),
    };
  }

  private async listAllTools(
    client: McpRegistryClient,
    signal: AbortSignal,
    holder: { readonly terminalError?: unknown },
  ): Promise<ListToolsResult> {
    const tools: ListToolsResult["tools"] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    while (true) {
      signal.throwIfAborted();
      if (holder.terminalError !== undefined) throw holder.terminalError;
      const page = await client.listTools({
        ...(cursor === undefined ? {} : { params: { cursor } }),
        options: { signal },
      });
      tools.push(...page.tools);
      const nextCursor = page.nextCursor;
      if (nextCursor === undefined) break;
      if (seenCursors.has(nextCursor)) {
        throw new Error("MCP tools/list returned a repeated cursor");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    signal.throwIfAborted();
    if (holder.terminalError !== undefined) throw holder.terminalError;
    return { tools };
  }

  private async discoverTools(
    definition: McpServerDefinition,
    client: McpRegistryClient,
    signal: AbortSignal,
    holder: { readonly terminalError?: unknown } = {},
  ): Promise<readonly McpCatalogTool[]> {
    const definitions = await this.listAllTools(client, signal, holder);
    const names = new Set<string>();
    for (const toolDefinition of definitions.tools) {
      if (names.has(toolDefinition.name)) {
        throw new Error(
          `MCP tools/list returned duplicate tool name ${JSON.stringify(toolDefinition.name)}`,
        );
      }
      names.add(toolDefinition.name);
    }

    const sdkTools = client.toolsFromDefinitions(definitions);
    const tools = definitions.tools.map((toolDefinition) => {
      const sdkTool = sdkTools[toolDefinition.name];
      if (!sdkTool) {
        throw new Error(`MCP tool conversion omitted ${JSON.stringify(toolDefinition.name)}`);
      }
      const identity = Object.freeze({
        source: "mcp",
        sourceId: definition.id,
        rawToolName: toolDefinition.name,
      } satisfies CatalogToolIdentity);
      const title = toolDefinition.title ?? toolDefinition.annotations?.title;
      return Object.freeze({
        serverId: definition.id,
        rawName: toolDefinition.name,
        ...(title === undefined ? {} : { title }),
        ...(toolDefinition.description === undefined
          ? {}
          : { description: toolDefinition.description }),
        identity,
        stableId: catalogToolStableId(identity),
        tool: this.wrapToolExecution(definition.id, client, sdkTool),
      } satisfies McpCatalogTool);
    });
    return Object.freeze(tools);
  }

  private wrapToolExecution(
    serverId: string,
    client: McpRegistryClient,
    sdkTool: McpConvertedTool,
  ): McpConvertedTool {
    const execute = sdkTool.execute;
    if (!execute) return sdkTool;
    return {
      ...sdkTool,
      execute: (...args: Parameters<typeof execute>) => {
        try {
          const result = execute(...args);
          if (result instanceof Promise) {
            return result.catch((error: unknown) => {
              if (!mcpApplicationErrorSchema.safeParse(error).success) {
                this.handleTerminalFailure(serverId, client, error);
              }
              throw error;
            });
          }
          return result;
        } catch (error) {
          if (!mcpApplicationErrorSchema.safeParse(error).success) {
            this.handleTerminalFailure(serverId, client, error);
          }
          throw error;
        }
      },
    };
  }

  private withDeadline<T>(
    serverId: string,
    operation: (signal: AbortSignal) => Promise<T>,
    onDeadline?: () => void,
  ): Promise<T> {
    const controller = new AbortController();
    let rejectDeadline: (error: Error) => void = () => undefined;
    const deadline = new Promise<never>((_, reject) => {
      rejectDeadline = reject;
    });
    const cancelDeadline = this.scheduleDeadline(() => {
      const error = new McpRegistryDeadlineError(serverId, this.initDeadlineMs);
      controller.abort(error);
      onDeadline?.();
      rejectDeadline(error);
    }, this.initDeadlineMs);
    const pending = operation(controller.signal);
    return Promise.race([pending, deadline]).finally(cancelDeadline);
  }

  private failureStatus(
    definition: McpServerDefinition,
    error: unknown,
  ): "unavailable" | "authentication_required" {
    return error instanceof McpAuthenticationRequiredError ||
      (error instanceof UnauthorizedError &&
        definition.transportConfig.transport === "http" &&
        definition.transportConfig.auth?.grant === "authorization_code")
      ? "authentication_required"
      : "unavailable";
  }

  private entryFromResult(definition: McpServerDefinition, result: CandidateResult): RegistryEntry {
    if (!result.ok) {
      return {
        definition,
        fingerprint: definitionFingerprint(definition),
        sensitiveValues: Object.freeze([]),
        status: Object.freeze({
          serverId: definition.id,
          transport: definition.transportConfig.transport,
          status: result.status,
          phase: result.phase,
          error: result.error,
        }),
        tools: Object.freeze([]),
      };
    }

    return {
      definition,
      fingerprint: definitionFingerprint(definition),
      transportFingerprint: result.candidate.transportFingerprint,
      client: result.candidate.client,
      sensitiveValues: result.candidate.sensitiveValues,
      status: Object.freeze({
        serverId: definition.id,
        transport: definition.transportConfig.transport,
        status: "available",
        toolCount: result.candidate.tools.length,
      }),
      tools: result.candidate.tools,
    };
  }

  private observeTransportClose(
    serverId: string,
    client: McpRegistryClient,
    transport: MCPClientConfig["transport"],
  ): void {
    if (!isCustomTransport(transport)) return;
    const sdkOnClose = transport.onclose;
    transport.onclose = () => {
      try {
        sdkOnClose?.();
      } finally {
        this.handleTerminalFailure(serverId, client, new Error("MCP transport closed"));
      }
    };
  }

  private handleTerminalFailure(serverId: string, client: McpRegistryClient, error: unknown): void {
    const current = this.entries.get(serverId);
    if (!current || current.client !== client || current.status.status !== "available") return;

    const message = safeErrorText(error, current.sensitiveValues);
    const status = this.failureStatus(current.definition, error);
    this.entries.set(serverId, {
      ...current,
      status: Object.freeze({
        serverId,
        transport: current.definition.transportConfig.transport,
        status,
        phase: "runtime",
        error: message,
      }),
      tools: Object.freeze([]),
    });
    this.publishSnapshots();
    void this.closeClientOnce(client).catch((closeError) => {
      const latest = this.entries.get(serverId);
      if (!latest || latest.client !== client || latest.status.status === "available") return;
      this.entries.set(serverId, {
        ...latest,
        status: Object.freeze({
          ...latest.status,
          error: `${latest.status.error}; cleanup failed: ${safeErrorText(closeError, latest.sensitiveValues)}`,
        }),
      });
      this.publishSnapshots();
    });
  }

  private async closeEntry(entry: RegistryEntry): Promise<string | undefined> {
    if (!entry.client) return undefined;
    try {
      await this.closeClientWithinDeadline(entry.definition.id, entry.client);
      return undefined;
    } catch (error) {
      return safeErrorText(error, entry.sensitiveValues);
    }
  }

  private async closeClientOnce(client: McpRegistryClient): Promise<void> {
    const existing = this.clientClosures.get(client);
    if (existing) return existing;
    let closure: Promise<void>;
    try {
      closure = client.close();
    } catch (error) {
      closure = Promise.reject(error);
    }
    this.clientClosures.set(client, closure);
    await closure;
  }

  private closeClientInBackground(client: McpRegistryClient): void {
    void this.closeClientOnce(client).catch(() => undefined);
  }

  private closeClientWithinDeadline(serverId: string, client: McpRegistryClient): Promise<void> {
    let rejectDeadline: (error: Error) => void = () => undefined;
    const deadline = new Promise<never>((_, reject) => {
      rejectDeadline = reject;
    });
    const cancelDeadline = this.scheduleDeadline(() => {
      rejectDeadline(new McpRegistryCloseDeadlineError(serverId, this.initDeadlineMs));
    }, this.initDeadlineMs);
    return Promise.race([this.closeClientOnce(client), deadline]).finally(cancelDeadline);
  }

  private async closeTransportOnce(transport: MCPTransport): Promise<void> {
    const existing = this.transportClosures.get(transport);
    if (existing) return existing;
    let closure: Promise<void>;
    try {
      closure = transport.close();
    } catch (error) {
      closure = Promise.reject(error);
    }
    this.transportClosures.set(transport, closure);
    await closure;
  }

  private closeTransportInBackground(transport: MCPTransport): void {
    void this.closeTransportOnce(transport).catch(() => undefined);
  }

  private publishSnapshots(): void {
    const entries = [...this.entries.values()].sort((left, right) =>
      left.definition.id.localeCompare(right.definition.id),
    );
    this.statusSnapshot = Object.freeze(entries.map((entry) => entry.status));
    this.toolSnapshot = Object.freeze(
      entries.flatMap((entry) => (entry.status.status === "available" ? entry.tools : [])),
    );
  }
}
