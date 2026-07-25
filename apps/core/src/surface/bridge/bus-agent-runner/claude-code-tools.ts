import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
  type CallToolResult,
  type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AtomicToolExecutionOutcome, ToolResultOutput } from "@stanley2058/lilac-agent";
import { isRecord } from "@stanley2058/lilac-utils";
import { asSchema, type ToolSet } from "ai";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import path from "node:path";

const SERVER_NAME = "lilac";
const NAMESPACED_PREFIX = `mcp__${SERVER_NAME}__`;
const CORRELATION_TTL_MS = 5 * 60_000;
const MAX_PENDING_CORRELATIONS = 256;

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
  close(): Promise<void>;
};

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Tool output is not JSON-serializable: ${message}`, { cause: error });
  }
}

function resourceName(url: string, fallback: string): string {
  try {
    const parsed = new URL(url);
    return path.posix.basename(parsed.pathname) || parsed.hostname || fallback;
  } catch {
    return fallback;
  }
}

function toBase64(data: string | Uint8Array | ArrayBuffer): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString("base64");
  return Buffer.from(data).toString("base64");
}

function mapContentOutput(output: Extract<ToolResultOutput, { type: "content" }>): CallToolResult {
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
            throw new Error("Claude MCP cannot represent provider file references");
          default: {
            const _exhaustive: never = part.data;
            throw new Error(`Unsupported file data: ${String(_exhaustive)}`);
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
        throw new Error(`Claude MCP cannot represent tool output content type '${part.type}'`);
      default: {
        const _exhaustive: never = part;
        throw new Error(`Unsupported tool output content: ${String(_exhaustive)}`);
      }
    }
  }

  return { content };
}

export function mapToolResultOutputToMcp(
  output: ToolResultOutput,
  isError: boolean,
): CallToolResult {
  switch (output.type) {
    case "text":
      return { isError, content: [{ type: "text", text: output.value }] };
    case "json": {
      const text = stringifyJson(output.value);
      return {
        isError,
        content: [{ type: "text", text }],
        ...(isRecord(output.value) ? { structuredContent: output.value } : {}),
      };
    }
    case "execution-denied":
      return toolError(output.reason ?? "Tool execution was denied.");
    case "error-text":
      return toolError(output.value);
    case "error-json":
      return toolError(stringifyJson(output.value));
    case "content": {
      const result = mapContentOutput(output);
      return isError ? { ...result, isError: true } : result;
    }
    default: {
      const _exhaustive: never = output;
      throw new Error(`Unsupported tool result output: ${String(_exhaustive)}`);
    }
  }
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

export async function createClaudeCodeToolBridge(options: {
  tools: ToolSet;
  execute(request: ClaudeCodeToolExecutionRequest): Promise<AtomicToolExecutionOutcome>;
  now?: () => number;
}): Promise<ClaudeCodeToolBridge> {
  const exposedEntries = Object.entries(options.tools).filter(([name]) => name !== "batch");
  const exposedNames = new Set(exposedEntries.map(([name]) => name));
  const validators = new Map<string, NonNullable<ReturnType<typeof asSchema>["validate"]>>();
  const declarations: McpTool[] = [];

  for (const [toolName, definition] of exposedEntries) {
    if (typeof definition.execute !== "function") {
      throw new Error(`Cannot expose Claude MCP tool '${toolName}': execute is missing`);
    }
    const schema = asSchema(definition.inputSchema);
    if (!schema.validate) {
      throw new Error(`Cannot expose Claude MCP tool '${toolName}': input validation is missing`);
    }
    validators.set(toolName, schema.validate);
    try {
      declarations.push(
        ToolSchema.parse({
          name: toolName,
          ...(typeof definition.description === "string"
            ? { description: definition.description }
            : {}),
          inputSchema: await schema.jsonSchema,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot expose Claude MCP tool '${toolName}': ${message}`, { cause: error });
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
    const toolName = request.params.name;
    const validate = validators.get(toolName);
    if (!validate || !exposedNames.has(toolName))
      return toolError(`Unknown Lilac tool '${toolName}'`);

    const rawInput = { ...request.params.arguments };
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
      if (outcome.expansion) {
        return toolError(`Lilac tool '${toolName}' returned an unsupported tool-call expansion`);
      }
      return mapToolResultOutputToMcp(outcome.toolOutput, outcome.isError);
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  });

  const canUseTool: CanUseTool = async (toolName, input, callbackOptions) => {
    if (!toolName.startsWith(NAMESPACED_PREFIX)) {
      return { behavior: "deny", message: `Claude built-in tool '${toolName}' is disabled` };
    }
    const localName = toolName.slice(NAMESPACED_PREFIX.length);
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

  return {
    mcpServers: {
      [SERVER_NAME]: { type: "sdk", name: SERVER_NAME, instance: server },
    },
    canUseTool,
    exposedToolNames: [...exposedNames],
    clear: () => pending.clear(),
    close: async () => {
      pending.clear();
      await server.close();
    },
  };
}

export function displayClaudeCodeToolName(toolName: string): string {
  return toolName.startsWith(NAMESPACED_PREFIX)
    ? toolName.slice(NAMESPACED_PREFIX.length)
    : toolName;
}
