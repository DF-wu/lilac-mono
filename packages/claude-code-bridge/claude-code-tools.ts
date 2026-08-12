import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
  type CallToolResult,
  type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExternalToolExecutionOutcome, ToolResultOutput } from "@stanley2058/lilac-agent";
import { isRecord, opaqueErrorMessage } from "@stanley2058/lilac-utils";
import { asSchema, type ToolSet } from "ai";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import path from "node:path";
import { z } from "zod";

const SERVER_NAME = "lilac";
const NAMESPACED_PREFIX = `mcp__${SERVER_NAME}__`;
const CORRELATION_TTL_MS = 5 * 60_000;
const MAX_PENDING_CORRELATIONS = 256;

function canonicalLilacToolName(name: string): string {
  switch (name) {
    case "read_file":
      return "read";
    case "edit_file":
      return "edit";
    case "apply_patch":
      return "patch";
    default:
      return name;
  }
}

const legacyBatchArgumentsSchema = z.object({
  tool_calls: z.array(
    z.object({
      tool: z.string(),
      parameters: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

export function normalizeLegacyBatchArguments(
  input: Record<string, unknown>,
  exposedNames: ReadonlySet<string>,
): Record<string, unknown> {
  const decoded = legacyBatchArgumentsSchema.safeParse(input);
  if (!decoded.success) return input;
  let changed = false;
  const toolCalls = decoded.data.tool_calls.map((call) => {
    const requestedName = call.tool;
    const toolName = exposedNames.has(requestedName)
      ? requestedName
      : canonicalLilacToolName(requestedName);
    if (toolName === requestedName || !exposedNames.has(toolName)) return call;
    changed = true;
    return {
      tool: toolName,
      ...(call.parameters === undefined ? {} : { parameters: call.parameters }),
    };
  });
  return changed ? { ...decoded.data, tool_calls: toolCalls } : input;
}

type CanUseTool = NonNullable<ClaudeCodeSettings["canUseTool"]>;
type McpServers = NonNullable<ClaudeCodeSettings["mcpServers"]>;

type PendingCorrelation = {
  toolName: string;
  toolUseId: string;
  createdAt: number;
};

export type ClaudeCodeToolExecutionRequest = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  abortSignal?: AbortSignal;
  inputValidation: "prevalidated";
};

export type ClaudeCodeToolBridge = {
  mcpServers: McpServers;
  canUseTool: CanUseTool;
  exposedToolNames: readonly string[];
  clear(): void;
  closeResult(): Promise<ResultType<void, ClaudeCodeToolBridgeCleanupFailed>>;
  close(): Promise<void>;
};

export class ClaudeCodeBuiltInToolUnsupported extends TaggedError(
  "ClaudeCodeBuiltInToolUnsupported",
)<{
  readonly toolName: string;
  readonly message: string;
}> {}

export class ClaudeCodeToolBridgeConfigurationFailed extends TaggedError(
  "ClaudeCodeToolBridgeConfigurationFailed",
)<{
  readonly toolName: string;
  readonly cause?: unknown;
  readonly message: string;
}> {}

export class ClaudeCodeToolOutputMappingFailed extends TaggedError(
  "ClaudeCodeToolOutputMappingFailed",
)<{
  readonly outputType: string;
  readonly cause?: unknown;
  readonly message: string;
}> {}

export class ClaudeCodeToolExecutionFailed extends TaggedError("ClaudeCodeToolExecutionFailed")<{
  readonly toolName: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class ClaudeCodeToolExecutionCancelled extends TaggedError(
  "ClaudeCodeToolExecutionCancelled",
)<{
  readonly toolName: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class ClaudeCodeToolBridgeCleanupFailed extends TaggedError(
  "ClaudeCodeToolBridgeCleanupFailed",
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export type ClaudeCodeToolBridgeCreateError =
  | ClaudeCodeBuiltInToolUnsupported
  | ClaudeCodeToolBridgeConfigurationFailed;

export type ClaudeCodeToolCatalogMetadata = {
  readonly sourceId: string;
  readonly rawName: string;
  readonly title?: string;
  readonly description?: string;
};

export type ClaudeCodeToolCatalogMetadataMap = Readonly<
  Record<string, ClaudeCodeToolCatalogMetadata>
>;

/**
 * Claude built-in tools a surface may re-enable. Anything else is rejected
 * before it can reach the Agent SDK's own allowlist, so a caller cannot widen
 * the model's reach with a name that merely typechecks.
 */
export const CLAUDE_CODE_BUILT_IN_TOOLS = ["WebSearch", "ToolSearch"] as const;
export type ClaudeCodeBuiltInTool = (typeof CLAUDE_CODE_BUILT_IN_TOOLS)[number];

const SUPPORTED_BUILT_IN_TOOLS: ReadonlySet<string> = new Set(CLAUDE_CODE_BUILT_IN_TOOLS);

/** Fail closed on any built-in Lilac has not vetted, however it was supplied. */
export function validateClaudeCodeBuiltInToolsResult(
  names: readonly string[] = [],
): ResultType<ClaudeCodeBuiltInTool[], ClaudeCodeBuiltInToolUnsupported> {
  for (const name of names) {
    if (!SUPPORTED_BUILT_IN_TOOLS.has(name)) {
      return Result.err(
        new ClaudeCodeBuiltInToolUnsupported({
          toolName: name,
          message: `Claude built-in tool '${name}' is not supported; allowed: ${CLAUDE_CODE_BUILT_IN_TOOLS.join(", ")}`,
        }),
      );
    }
  }
  return Result.ok(
    names.filter((name): name is ClaudeCodeBuiltInTool => SUPPORTED_BUILT_IN_TOOLS.has(name)),
  );
}

/** Compatibility adapter for callers that still consume configuration failures as exceptions. */
export function validateClaudeCodeBuiltInTools(
  names: readonly string[] = [],
): ClaudeCodeBuiltInTool[] {
  const validated = validateClaudeCodeBuiltInToolsResult(names);
  if (validated.status === "error") throw validated.error;
  return validated.value;
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function stringifyJson(value: unknown): ResultType<string, ClaudeCodeToolOutputMappingFailed> {
  try {
    return Result.ok(JSON.stringify(value) ?? "null");
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new ClaudeCodeToolOutputMappingFailed({
        outputType: "json",
        cause,
        message: `Tool output is not JSON-serializable: ${opaqueErrorMessage(cause, "opaque serialization failure")}`,
      }),
    );
  }
}

function resourceName(url: string, fallback: string): string {
  if (!URL.canParse(url)) return fallback;
  const parsed = new URL(url);
  return path.posix.basename(parsed.pathname) || parsed.hostname || fallback;
}

function toBase64(data: string | Uint8Array | ArrayBuffer): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString("base64");
  return Buffer.from(data).toString("base64");
}

function mapContentOutput(
  output: Extract<ToolResultOutput, { type: "content" }>,
): ResultType<CallToolResult, ClaudeCodeToolOutputMappingFailed> {
  const content: CallToolResult["content"] = [];

  for (const part of output.value) {
    switch (part.type) {
      case "text":
        content.push({ type: "text", text: part.text });
        break;
      case "image-data":
        content.push({ type: "image", data: part.data, mimeType: part.mediaType });
        break;
      case "image-url":
        content.push({
          type: "resource_link",
          uri: part.url,
          name: resourceName(part.url, "image"),
        });
        break;
      case "file-data": {
        if (part.mediaType.startsWith("image/")) {
          content.push({ type: "image", data: part.data, mimeType: part.mediaType });
          break;
        }
        if (part.mediaType.startsWith("audio/")) {
          content.push({ type: "audio", data: part.data, mimeType: part.mediaType });
          break;
        }
        const uri = `urn:lilac:tool-result:${crypto.randomUUID()}`;
        if (part.mediaType.startsWith("text/")) {
          content.push({
            type: "resource",
            resource: {
              uri,
              text: Buffer.from(part.data, "base64").toString("utf8"),
              mimeType: part.mediaType,
            },
          });
          break;
        }
        content.push({
          type: "resource",
          resource: { uri, blob: part.data, mimeType: part.mediaType },
        });
        break;
      }
      case "file": {
        switch (part.data.type) {
          case "data": {
            const data = toBase64(part.data.data);
            if (part.mediaType.startsWith("image/")) {
              content.push({ type: "image", data, mimeType: part.mediaType });
            } else if (part.mediaType.startsWith("audio/")) {
              content.push({ type: "audio", data, mimeType: part.mediaType });
            } else {
              content.push({
                type: "resource",
                resource: {
                  uri: `urn:lilac:tool-result:${crypto.randomUUID()}`,
                  blob: data,
                  mimeType: part.mediaType,
                },
              });
            }
            break;
          }
          case "text":
            content.push({
              type: "resource",
              resource: {
                uri: `urn:lilac:tool-result:${crypto.randomUUID()}`,
                text: part.data.text,
                mimeType: part.mediaType,
              },
            });
            break;
          case "url":
            content.push({
              type: "resource_link",
              uri: part.data.url.toString(),
              name: part.filename ?? resourceName(part.data.url.toString(), "file"),
              mimeType: part.mediaType,
            });
            break;
          case "reference":
            return Result.err(
              new ClaudeCodeToolOutputMappingFailed({
                outputType: "file-reference",
                message: "Claude MCP cannot represent provider file references",
              }),
            );
          default: {
            const _exhaustive: never = part.data;
            return _exhaustive;
          }
        }
        break;
      }
      case "file-url":
        content.push({
          type: "resource_link",
          uri: part.url,
          name: resourceName(part.url, "file"),
        });
        break;
      case "file-id":
      case "file-reference":
      case "image-file-id":
      case "image-file-reference":
      case "custom":
        return Result.err(
          new ClaudeCodeToolOutputMappingFailed({
            outputType: part.type,
            message: `Claude MCP cannot represent tool output content type '${part.type}'`,
          }),
        );
      default: {
        const _exhaustive: never = part;
        return _exhaustive;
      }
    }
  }

  return Result.ok({ content });
}

export function mapToolResultOutputToMcpResult(
  output: ToolResultOutput,
  isError: boolean,
): ResultType<CallToolResult, ClaudeCodeToolOutputMappingFailed> {
  switch (output.type) {
    case "text":
      return Result.ok({ isError, content: [{ type: "text", text: output.value }] });
    case "json": {
      const text = stringifyJson(output.value);
      if (text.status === "error") return text;
      return Result.ok({
        isError,
        content: [{ type: "text", text: text.value }],
        ...(isRecord(output.value) ? { structuredContent: output.value } : {}),
      });
    }
    case "execution-denied":
      return Result.ok(toolError(output.reason ?? "Tool execution was denied."));
    case "error-text":
      return Result.ok(toolError(output.value));
    case "error-json": {
      const text = stringifyJson(output.value);
      return text.status === "error" ? text : Result.ok(toolError(text.value));
    }
    case "content": {
      const result = mapContentOutput(output);
      if (result.status === "error") return result;
      return Result.ok(isError ? { ...result.value, isError: true } : result.value);
    }
    default: {
      const _exhaustive: never = output;
      return _exhaustive;
    }
  }
}

/** Compatibility adapter for the established synchronous MCP mapping API. */
export function mapToolResultOutputToMcp(
  output: ToolResultOutput,
  isError: boolean,
): CallToolResult {
  const mapped = mapToolResultOutputToMcpResult(output, isError);
  if (mapped.status === "error") throw mapped.error;
  return mapped.value;
}

function mapExecutedExpansionToMcp(
  executedExpansion: NonNullable<ExternalToolExecutionOutcome["executedExpansion"]>,
): CallToolResult {
  const { children } = executedExpansion;
  const content: CallToolResult["content"] = [
    { type: "text", text: `Batch accepted: ${children.length} children.` },
  ];
  const childMetadata = children.map((child, childOffset) => {
    const index = childOffset + 1;
    const contentStart = content.length;
    content.push({
      type: "text",
      text: `[${index}/${children.length}] tool=${child.toolName} id=${child.toolCallId} outcome=${child.outcome} isError=${child.isError}`,
    });

    const mapped = mapToolResultOutputToMcpResult(child.toolOutput, child.isError);
    if (mapped.status === "ok") content.push(...mapped.value.content);
    else {
      content.push({
        type: "text",
        text: `Failed to map child tool output: ${mapped.error.message}`,
      });
    }

    return {
      index,
      toolCallId: child.toolCallId,
      toolName: child.toolName,
      outcome: child.outcome,
      isError: child.isError,
      outputType: child.toolOutput.type,
      contentStart,
      contentCount: content.length - contentStart,
    };
  });

  return {
    content,
    structuredContent: {
      type: "lilac.batch-result",
      version: 1,
      accepted: true,
      total: children.length,
      children: childMetadata,
    },
  };
}

function pruneCorrelations(pending: Map<string, PendingCorrelation>, now: number): void {
  for (const [nonce, correlation] of pending) {
    if (now - correlation.createdAt > CORRELATION_TTL_MS) pending.delete(nonce);
  }
  while (pending.size >= MAX_PENDING_CORRELATIONS) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}

function catalogSearchHint(metadata: ClaudeCodeToolCatalogMetadata): string {
  return [
    `Source ID: ${metadata.sourceId}`,
    `Raw tool name: ${metadata.rawName}`,
    ...(metadata.title ? [`Title: ${metadata.title}`] : []),
    ...(metadata.description ? [`Description: ${metadata.description}`] : []),
  ].join("\n");
}

export async function createClaudeCodeToolBridgeResult(options: {
  tools: ToolSet;
  /**
   * Deferred catalog tools keyed by model-facing name. Exposed tools absent
   * from this map are Lilac builtins and are marked always-load.
   */
  catalogMetadata?: ClaudeCodeToolCatalogMetadataMap;
  execute(request: ClaudeCodeToolExecutionRequest): Promise<ExternalToolExecutionOutcome>;
  /**
   * Claude built-in tools this run may call directly. They bypass the MCP
   * bridge entirely, so they get no Lilac approval, execution events, output
   * normalization, or artifact capture.
   */
  builtInTools?: readonly ClaudeCodeBuiltInTool[];
  now?: () => number;
}): Promise<ResultType<ClaudeCodeToolBridge, ClaudeCodeToolBridgeCreateError>> {
  // Provider-executed tools are run by the model, not Lilac, so there is
  // nothing to expose through MCP. A tool that is merely missing `execute`
  // still fails loudly below, because that is a toolset bug rather than a
  // deliberate handover.
  const exposedEntries = Object.entries(options.tools).filter(
    ([name, definition]) => name !== "tool_search" && definition.isProviderExecuted !== true,
  );
  const exposedNames = new Set(exposedEntries.map(([name]) => name));
  const validatedBuiltIns = validateClaudeCodeBuiltInToolsResult(options.builtInTools);
  if (validatedBuiltIns.status === "error") return validatedBuiltIns;
  const allowedBuiltIns = new Set<string>(validatedBuiltIns.value);
  const validators = new Map<string, NonNullable<ReturnType<typeof asSchema>["validate"]>>();
  const declarations: McpTool[] = [];

  for (const [toolName, definition] of exposedEntries) {
    if (typeof definition.execute !== "function") {
      return Result.err(
        new ClaudeCodeToolBridgeConfigurationFailed({
          toolName,
          message: `Cannot expose Claude MCP tool '${toolName}': execute is missing`,
        }),
      );
    }
    const schema = asSchema(definition.inputSchema);
    if (!schema.validate) {
      return Result.err(
        new ClaudeCodeToolBridgeConfigurationFailed({
          toolName,
          message: `Cannot expose Claude MCP tool '${toolName}': input validation is missing`,
        }),
      );
    }
    validators.set(toolName, schema.validate);
    const catalogMetadata = options.catalogMetadata?.[toolName];
    try {
      declarations.push(
        ToolSchema.parse({
          name: toolName,
          ...(typeof definition.description === "string"
            ? { description: definition.description }
            : {}),
          inputSchema: await schema.jsonSchema,
          _meta: catalogMetadata
            ? { "anthropic/searchHint": catalogSearchHint(catalogMetadata) }
            : { "anthropic/alwaysLoad": true },
        }),
      );
    } catch (error) {
      if (Panic.is(error)) throw error;
      return Result.err(
        new ClaudeCodeToolBridgeConfigurationFailed({
          toolName,
          cause: error,
          message: `Cannot expose Claude MCP tool '${toolName}': ${opaqueErrorMessage(error, "opaque schema failure")}`,
        }),
      );
    }
  }

  const now = options.now ?? Date.now;
  const nonceKey = `__lilac_tool_${crypto.randomUUID().replaceAll("-", "")}`;
  const pending = new Map<string, PendingCorrelation>();
  const server = new McpServer(
    { name: SERVER_NAME, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: declarations }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const requestedName = request.params.name;
    const toolName = exposedNames.has(requestedName)
      ? requestedName
      : canonicalLilacToolName(requestedName);
    const validate = validators.get(toolName);
    if (!validate || !exposedNames.has(toolName))
      return toolError(`Unknown Lilac tool '${toolName}'`);

    let rawInput = { ...request.params.arguments };
    const nonce = rawInput[nonceKey];
    delete rawInput[nonceKey];
    if (typeof nonce !== "string") {
      return toolError(`Lilac tool '${toolName}' is missing execution correlation`);
    }

    const correlation = pending.get(nonce);
    pending.delete(nonce);
    if (!correlation || correlation.toolName !== toolName) {
      return toolError(`Lilac tool '${toolName}' has invalid or expired execution correlation`);
    }
    if (now() - correlation.createdAt > CORRELATION_TTL_MS) {
      return toolError(`Lilac tool '${toolName}' has expired execution correlation`);
    }
    if (toolName === "batch") rawInput = normalizeLegacyBatchArguments(rawInput, exposedNames);

    const validation = await validate(rawInput);
    if (!validation.success) {
      return toolError(validation.error.message);
    }

    try {
      const outcome = await options.execute({
        toolCallId: correlation.toolUseId,
        toolName,
        input: validation.value,
        abortSignal: extra.signal,
        inputValidation: "prevalidated",
      });
      if (outcome.executedExpansion) {
        return mapExecutedExpansionToMcp(outcome.executedExpansion);
      }
      if (outcome.expansion) {
        return toolError(`Lilac tool '${toolName}' returned an unsupported tool-call expansion`);
      }
      const mapped = mapToolResultOutputToMcpResult(outcome.toolOutput, outcome.isError);
      return mapped.status === "ok" ? mapped.value : toolError(mapped.error.message);
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      const error = extra.signal.aborted
        ? new ClaudeCodeToolExecutionCancelled({
            toolName,
            cause,
            message: opaqueErrorMessage(cause, `Lilac tool '${toolName}' execution was cancelled`),
          })
        : new ClaudeCodeToolExecutionFailed({
            toolName,
            cause,
            message: opaqueErrorMessage(cause, `Lilac tool '${toolName}' execution failed`),
          });
      return toolError(error.message);
    }
  });

  const canUseTool: CanUseTool = async (toolName, input, callbackOptions) => {
    if (!toolName.startsWith(NAMESPACED_PREFIX)) {
      // Exact membership only: no prefix or pattern matching, so an unexpected
      // built-in can never be admitted by resembling an allowlisted one.
      if (allowedBuiltIns.has(toolName)) return { behavior: "allow", updatedInput: input };
      return { behavior: "deny", message: `Claude built-in tool '${toolName}' is disabled` };
    }
    const requestedName = toolName.slice(NAMESPACED_PREFIX.length);
    const localName = exposedNames.has(requestedName)
      ? requestedName
      : canonicalLilacToolName(requestedName);
    if (!exposedNames.has(localName)) {
      return { behavior: "deny", message: `Unknown Lilac tool '${localName}'` };
    }

    pruneCorrelations(pending, now());
    const nonce = crypto.randomUUID();
    pending.set(nonce, {
      toolName: localName,
      toolUseId: callbackOptions.toolUseID,
      createdAt: now(),
    });
    return {
      behavior: "allow",
      updatedInput: { ...input, [nonceKey]: nonce },
      decisionClassification: "user_permanent",
    };
  };

  const closeResult = async (): Promise<ResultType<void, ClaudeCodeToolBridgeCleanupFailed>> => {
    pending.clear();
    try {
      await server.close();
      return Result.ok();
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      return Result.err(
        new ClaudeCodeToolBridgeCleanupFailed({
          cause,
          message: "Claude MCP bridge cleanup failed",
        }),
      );
    }
  };
  return Result.ok({
    mcpServers: {
      [SERVER_NAME]: { type: "sdk", name: SERVER_NAME, instance: server },
    },
    canUseTool,
    exposedToolNames: [...exposedNames],
    clear: () => pending.clear(),
    closeResult,
    close: async () => {
      const closed = await closeResult();
      if (closed.status === "error") throw closed.error;
    },
  });
}

/** Compatibility adapter for the established bridge construction rejection contract. */
export async function createClaudeCodeToolBridge(
  options: Parameters<typeof createClaudeCodeToolBridgeResult>[0],
): Promise<ClaudeCodeToolBridge> {
  const created = await createClaudeCodeToolBridgeResult(options);
  if (created.status === "error") throw created.error;
  return created.value;
}

export function displayClaudeCodeToolName(toolName: string): string {
  return toolName.startsWith(NAMESPACED_PREFIX)
    ? canonicalLilacToolName(toolName.slice(NAMESPACED_PREFIX.length))
    : toolName;
}
