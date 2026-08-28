import { captureError } from "../shared/error-capture.js";

import {
  validateJSONRPCMessage,
  type JSONRPCError,
  type JSONRPCMessage,
  type JSONRPCResponse,
  type MCPClientConfig,
  type MCPTransport,
} from "@ai-sdk/mcp";
import { Panic, Result } from "better-result";
import { z } from "zod";

const MODERN_MCP_PROTOCOL_VERSION = "2026-07-28";
// This local response normalization never goes on the wire. The AI SDK suppresses legacy fallback
// only for errors carrying a recognized modern protocol code.
const INVALID_MODERN_RESULT_ERROR_CODE = -32022;
const MODERN_PROTOCOL_ERROR_CODES = [-32020, -32021, INVALID_MODERN_RESULT_ERROR_CODE] as const;
const AI_SDK_SUPPORTED_LEGACY_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;
const unsupportedProtocolVersionDataSchema = z.object({
  requested: z.literal(MODERN_MCP_PROTOCOL_VERSION),
  supported: z
    .array(z.string())
    .nonempty()
    .refine((versions) =>
      versions.every((version) =>
        AI_SDK_SUPPORTED_LEGACY_PROTOCOL_VERSIONS.some((supported) => supported === version),
      ),
    ),
});
const discoveryErrorWithNullIdSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.null(),
  error: z.strictObject({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  }),
});
const modernCacheableCompleteResultSchema = z.looseObject({
  resultType: z.literal("complete"),
  ttlMs: z.number().int().min(0),
  cacheScope: z.union([z.literal("public"), z.literal("private")]),
});
const modernDiscoverResultSchema = modernCacheableCompleteResultSchema.extend({
  supportedVersions: z.array(z.string()),
  capabilities: z.looseObject({
    experimental: z.looseObject({}).optional(),
    logging: z.looseObject({}).optional(),
    completions: z.looseObject({}).optional(),
    prompts: z.looseObject({ listChanged: z.boolean().optional() }).optional(),
    resources: z
      .looseObject({ subscribe: z.boolean().optional(), listChanged: z.boolean().optional() })
      .optional(),
    tools: z.looseObject({ listChanged: z.boolean().optional() }).optional(),
    elicitation: z.looseObject({ applyDefaults: z.boolean().optional() }).optional(),
  }),
  instructions: z.string().optional(),
  _meta: z.looseObject({}).optional(),
});

type McpFetch = typeof globalThis.fetch;

type DecodedJsonRpcPayload = {
  readonly batched: boolean;
  readonly messages: readonly JSONRPCMessage[];
};

type ModernRequestContext = {
  readonly id: string | number;
  readonly method: string;
};

type DiscoveryState = "allowed-legacy" | "blocked" | "modern" | "not-attempted" | "pending";
type JSONRPCReply = JSONRPCError | JSONRPCResponse;
type DiscoveryPanicHolder = { panic?: Panic };

function isJsonRpcReply(message: JSONRPCMessage): message is JSONRPCReply {
  return !("method" in message);
}

function decodeJsonRpcPayload(
  text: string,
  expectedDiscoveryId?: string | number,
): DecodedJsonRpcPayload | undefined {
  const decoded = Result.try({
    try: () => {
      const value: unknown = JSON.parse(text);
      const values: readonly unknown[] = Array.isArray(value) ? value : [value];
      if (values.length === 0) throw new Error("JSON-RPC batches must not be empty");
      return {
        batched: Array.isArray(value),
        messages: values.map((item) => {
          if (expectedDiscoveryId === undefined) return validateJSONRPCMessage(item);
          const nullIdError = discoveryErrorWithNullIdSchema.safeParse(item);
          if (!nullIdError.success) return validateJSONRPCMessage(item);
          return validateJSONRPCMessage({ ...nullIdError.data, id: expectedDiscoveryId });
        }),
      } satisfies DecodedJsonRpcPayload;
    },
    catch: captureError,
  });
  return decoded.match({
    ok: (value) => value,
    err: () => undefined,
  });
}

function invalidModernResultMessage(
  id: string | number | undefined,
  message: string,
): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    ...(id === undefined ? {} : { id }),
    error: {
      code: INVALID_MODERN_RESULT_ERROR_CODE,
      message,
    },
  };
}

function legacyDiscoveryMessage(id: string | number | undefined): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    ...(id === undefined ? {} : { id }),
    error: { code: -32601, message: "Method not found" },
  };
}

function allowsLegacyFallback(message: JSONRPCMessage): boolean {
  if (!("error" in message)) return false;
  const isStructuredLegacyOffer =
    message.error.code === INVALID_MODERN_RESULT_ERROR_CODE &&
    unsupportedProtocolVersionDataSchema.safeParse(message.error.data).success;
  if (isStructuredLegacyOffer) return true;
  // A completed server reply is era evidence. Transport, authentication, and infrastructure
  // failures are classified separately and never reach this fallback decision.
  return !MODERN_PROTOCOL_ERROR_CODES.some((code) => code === message.error.code);
}

function isValidModernDiscoverResult(message: JSONRPCMessage): boolean {
  if ("method" in message || "error" in message) return false;
  const parsed = modernDiscoverResultSchema.safeParse(message.result);
  return parsed.success && parsed.data.supportedVersions.includes(MODERN_MCP_PROTOCOL_VERSION);
}

function isLegacyDiscoverResult(message: JSONRPCMessage): boolean {
  if ("method" in message || "error" in message) return false;
  const parsed = modernDiscoverResultSchema.safeParse(message.result);
  if (!parsed.success) return false;
  return (
    parsed.data.supportedVersions.length > 0 &&
    parsed.data.supportedVersions.every((version) =>
      AI_SDK_SUPPORTED_LEGACY_PROTOCOL_VERSIONS.some((supported) => supported === version),
    )
  );
}

function isValidModernCacheableCompleteResult(message: JSONRPCMessage): boolean {
  return (
    !("method" in message) &&
    !("error" in message) &&
    modernCacheableCompleteResultSchema.safeParse(message.result).success
  );
}

function enforceModernResultType(message: JSONRPCMessage, requestMethod?: string): JSONRPCMessage {
  if ("method" in message) return message;
  if ("error" in message) {
    if (requestMethod !== "server/discover") return message;
    if (message.error.code === -32601) return message;
    if (allowsLegacyFallback(message)) return legacyDiscoveryMessage(message.id);
    return invalidModernResultMessage(message.id, "Modern MCP discovery request failed");
  }
  const resultType = message.result.resultType;
  if (requestMethod === "server/discover") {
    if (isValidModernDiscoverResult(message)) return message;
    if (isLegacyDiscoverResult(message)) return legacyDiscoveryMessage(message.id);
    return invalidModernResultMessage(message.id, "Invalid modern MCP discovery result");
  }
  if (resultType === "input_required") return message;
  if (resultType === "complete") {
    if (requestMethod !== "tools/list" || isValidModernCacheableCompleteResult(message)) {
      return message;
    }
    return invalidModernResultMessage(message.id, "Invalid modern MCP tools/list result");
  }
  if (resultType === undefined) {
    return invalidModernResultMessage(message.id, "Modern MCP result is missing resultType");
  }
  return invalidModernResultMessage(
    message.id,
    `Unsupported modern MCP resultType ${JSON.stringify(resultType)}`,
  );
}

function enforceModernPayload(
  payload: DecodedJsonRpcPayload,
  request: ModernRequestContext,
  requireResponse: boolean,
): {
  readonly changed: boolean;
  readonly payload: DecodedJsonRpcPayload;
  readonly responseSeen: boolean;
} {
  const responses = payload.messages.filter(isJsonRpcReply);
  const responseSeen = responses.length > 0;
  const hasInvalidResponseSet =
    responses.length > 1 ||
    responses.some((message) => message.id !== request.id) ||
    (requireResponse && responses.length !== 1);
  if (hasInvalidResponseSet) {
    return {
      changed: true,
      payload: {
        batched: false,
        messages: [
          invalidModernResultMessage(request.id, "Invalid modern MCP JSON-RPC response identity"),
        ],
      },
      responseSeen: true,
    };
  }

  let changed = false;
  const messages = payload.messages.map((message) => {
    const enforced = enforceModernResultType(message, request.method);
    if (enforced !== message) changed = true;
    return enforced;
  });
  return {
    changed,
    payload: { batched: payload.batched, messages },
    responseSeen,
  };
}

function classifyDiscoveryMessage(message: JSONRPCMessage): DiscoveryState {
  if ("method" in message) return "blocked";
  if ("error" in message) return allowsLegacyFallback(message) ? "allowed-legacy" : "blocked";
  if (isValidModernDiscoverResult(message)) return "modern";
  if (isLegacyDiscoverResult(message)) return "allowed-legacy";
  return "blocked";
}

function classifyDiscoveryPayload(
  payload: DecodedJsonRpcPayload,
  request: ModernRequestContext,
  requireResponse: boolean,
): DiscoveryState | undefined {
  const responses = payload.messages.filter(isJsonRpcReply);
  if (responses.length === 0) return requireResponse ? "blocked" : undefined;
  if (responses.length !== 1 || responses[0]?.id !== request.id) return "blocked";
  const response = responses[0];
  return response ? classifyDiscoveryMessage(response) : "blocked";
}

function classifyHttpDiscoveryResponse(
  response: Response,
  payload: DecodedJsonRpcPayload,
  request: ModernRequestContext,
): DiscoveryState {
  const classified = classifyDiscoveryPayload(payload, request, true);
  if (response.ok) return classified ?? "blocked";
  if (classified !== "allowed-legacy") return "blocked";
  const isAuthenticationFailure =
    response.status === 401 || response.status === 403 || response.status === 407;
  const isOperationalFailure =
    response.status === 408 || response.status === 429 || response.status >= 500;
  if (isAuthenticationFailure || isOperationalFailure) return "blocked";
  return response.status >= 400 && response.status < 500 ? "allowed-legacy" : "blocked";
}

function serializeJsonRpcPayload(payload: DecodedJsonRpcPayload): string {
  return JSON.stringify(payload.batched ? payload.messages : payload.messages[0]);
}

function responseWithBody(response: Response, body: BodyInit, contentType?: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  if (contentType) headers.set("content-type", contentType);
  return new Response(body, {
    status: response.status === 202 || response.status === 204 ? 200 : response.status,
    statusText: response.statusText,
    headers,
  });
}

function invalidModernHttpResponse(
  response: Response,
  requestId: string | number | undefined,
  message: string,
): Response {
  return responseWithBody(
    response,
    JSON.stringify(invalidModernResultMessage(requestId, message)),
    "application/json",
  );
}

async function enforceModernJsonResponse(
  response: Response,
  request: ModernRequestContext,
): Promise<{
  readonly discoveryState: DiscoveryState | undefined;
  readonly response: Response;
}> {
  const read = await Result.tryPromise({
    try: () => response.clone().text(),
    catch: captureError,
  });
  const text = read.match({
    ok: (value) => value,
    err: () => undefined,
  });
  if (text === undefined) {
    return {
      discoveryState: request.method === "server/discover" ? "blocked" : undefined,
      response: invalidModernHttpResponse(response, request.id, "Invalid modern MCP response body"),
    };
  }

  const decoded = decodeJsonRpcPayload(
    text,
    request.method === "server/discover" ? request.id : undefined,
  );
  if (!decoded) {
    return {
      discoveryState: request.method === "server/discover" ? "blocked" : undefined,
      response: invalidModernHttpResponse(
        response,
        request.id,
        "Invalid modern MCP JSON-RPC response",
      ),
    };
  }
  const enforced = enforceModernPayload(decoded, request, true);
  return {
    discoveryState:
      request.method === "server/discover"
        ? classifyHttpDiscoveryResponse(response, decoded, request)
        : undefined,
    response: enforced.changed
      ? responseWithBody(response, serializeJsonRpcPayload(enforced.payload))
      : response,
  };
}

async function enforceModernDiscoveryFailureResponse(
  response: Response,
  request: ModernRequestContext,
): Promise<{ readonly discoveryState: DiscoveryState; readonly response: Response }> {
  const read = await Result.tryPromise({
    try: () => response.clone().text(),
    catch: captureError,
  });
  const decoded = read.match({
    ok: (text) => decodeJsonRpcPayload(text, request.id),
    err: () => undefined,
  });
  const discoveryState = decoded
    ? classifyHttpDiscoveryResponse(response, decoded, request)
    : "blocked";
  const message = decoded?.messages.length === 1 ? decoded.messages[0] : undefined;
  if (discoveryState === "allowed-legacy" && message && "error" in message) {
    const enforced = enforceModernResultType(message, request.method);
    return {
      discoveryState,
      response:
        enforced === message
          ? response
          : responseWithBody(response, JSON.stringify(enforced), "application/json"),
    };
  }
  return {
    discoveryState: "blocked",
    response: invalidModernHttpResponse(
      response,
      request.id,
      "Modern MCP discovery request failed",
    ),
  };
}

export function retainTransportPanic(cause: unknown, holder: DiscoveryPanicHolder): void {
  if (Panic.is(cause)) holder.panic = cause;
}

function preserveTransportPanic(cause: unknown): void {
  if (Panic.is(cause)) throw cause;
}

function signalTransportCancellation(signal: AbortSignal | null | undefined): void {
  if (!signal?.aborted) return;
  signal.throwIfAborted();
}

async function fetchModernDiscovery(
  fetchFn: McpFetch,
  args: Parameters<McpFetch>,
  request: ModernRequestContext,
  panicHolder: DiscoveryPanicHolder,
): Promise<Response> {
  const fetched = await Result.tryPromise({
    try: () => fetchFn(...args),
    catch: captureError,
  });
  const decision = fetched.match<
    | { readonly kind: "response"; readonly response: Response }
    | { readonly kind: "failure"; readonly failure: ReturnType<typeof captureError> }
  >({
    ok: (response) => ({ kind: "response", response }),
    err: (failure) => ({ kind: "failure", failure }),
  });
  if (decision.kind === "response") return decision.response;

  signalTransportCancellation(args[1]?.signal);
  retainTransportPanic(decision.failure.cause, panicHolder);
  preserveTransportPanic(decision.failure.cause);
  return new Response(
    JSON.stringify(invalidModernResultMessage(request.id, "Modern MCP discovery request failed")),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function eventDelimiterIndex(
  value: string,
): { readonly index: number; readonly length: number } | null {
  let lineStart = 0;
  let previousLineEnding = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\r" && character !== "\n") continue;
    const lineEndingLength = character === "\r" && value[index + 1] === "\n" ? 2 : 1;
    if (index === lineStart) {
      return { index: previousLineEnding, length: index + lineEndingLength - previousLineEnding };
    }
    previousLineEnding = index;
    lineStart = index + lineEndingLength;
    index += lineEndingLength - 1;
  }
  return null;
}

function enforceModernSseEvent(
  eventBlock: string,
  request: ModernRequestContext,
): {
  readonly discoveryState?: DiscoveryState;
  readonly eventBlock: string;
  readonly responseSeen: boolean;
} {
  const lines = eventBlock.split(/\r\n|[\r\n]/);
  const eventName = lines
    .find((line) => line.startsWith("event:"))
    ?.slice("event:".length)
    .trim();
  if (eventName && eventName !== "message") {
    return { eventBlock, responseSeen: false };
  }

  const dataLines = lines.filter((line) => line.startsWith("data:"));
  if (dataLines.length === 0) return { eventBlock, responseSeen: false };
  const data = dataLines.map((line) => line.slice("data:".length).trimStart()).join("\n");
  const decoded = decodeJsonRpcPayload(
    data,
    request.method === "server/discover" ? request.id : undefined,
  );
  const enforced = decoded ? enforceModernPayload(decoded, request, false) : undefined;
  const discoveryState =
    request.method === "server/discover" && decoded
      ? classifyDiscoveryPayload(decoded, request, false)
      : undefined;
  if (enforced && !enforced.changed) {
    return {
      ...(discoveryState === undefined ? {} : { discoveryState }),
      eventBlock,
      responseSeen: enforced.responseSeen,
    };
  }

  const replacement = enforced
    ? serializeJsonRpcPayload(enforced.payload)
    : JSON.stringify(
        invalidModernResultMessage(request.id, "Invalid modern MCP JSON-RPC response"),
      );
  let replaced = false;
  const rewritten = lines.flatMap((line) => {
    if (!line.startsWith("data:")) return [line];
    if (replaced) return [];
    replaced = true;
    return [`data: ${replacement}`];
  });
  return {
    ...(discoveryState === undefined ? {} : { discoveryState }),
    eventBlock: rewritten.join("\n"),
    responseSeen: true,
  };
}

function enforceModernSseResponse(
  response: Response,
  request: ModernRequestContext,
  onDiscoveryState: (state: DiscoveryState) => void,
): Response {
  if (!response.body) {
    return invalidModernHttpResponse(response, request.id, "Modern MCP SSE response has no body");
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let responseSeen = false;
  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        for (;;) {
          const delimiter = eventDelimiterIndex(buffer);
          if (!delimiter) return;
          const eventBlock = buffer.slice(0, delimiter.index);
          const eventDelimiter = buffer.slice(delimiter.index, delimiter.index + delimiter.length);
          buffer = buffer.slice(delimiter.index + delimiter.length);
          const enforced = enforceModernSseEvent(eventBlock, request);
          if (enforced.responseSeen) responseSeen = true;
          if (enforced.discoveryState) onDiscoveryState(enforced.discoveryState);
          controller.enqueue(encoder.encode(`${enforced.eventBlock}${eventDelimiter}`));
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (!buffer) {
          if (!responseSeen && request.method === "server/discover") {
            onDiscoveryState("blocked");
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify(
                  invalidModernResultMessage(request.id, "Modern MCP discovery request failed"),
                )}\n\n`,
              ),
            );
          }
          return;
        }
        const enforced = enforceModernSseEvent(buffer, request);
        if (enforced.responseSeen) responseSeen = true;
        if (enforced.discoveryState) onDiscoveryState(enforced.discoveryState);
        if (!responseSeen && request.method === "server/discover") {
          onDiscoveryState("blocked");
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify(
                invalidModernResultMessage(request.id, "Modern MCP discovery request failed"),
              )}\n\n`,
            ),
          );
          return;
        }
        controller.enqueue(encoder.encode(enforced.eventBlock));
      },
    }),
  );
  return responseWithBody(response, stream);
}

function requestContextFromBody(
  body: BodyInit | null | undefined,
): ModernRequestContext | undefined {
  if (typeof body !== "string") return undefined;
  const decoded = decodeJsonRpcPayload(body);
  const message = decoded?.messages[0];
  if (!message || !("method" in message) || !("id" in message)) return undefined;
  return { id: message.id, method: message.method };
}

function blockedInitializeResponse(requestId: string | number): Response {
  return new Response(
    JSON.stringify(
      invalidModernResultMessage(requestId, "Legacy initialization lacks valid discovery evidence"),
    ),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function shouldBlockInitialize(discoveryState: DiscoveryState): boolean {
  return discoveryState !== "not-attempted" && discoveryState !== "allowed-legacy";
}

function createModernResultValidatingFetch(fetchFn: McpFetch): McpFetch {
  let discoveryState: DiscoveryState = "not-attempted";
  const discoveryPanic: DiscoveryPanicHolder = {};
  const wrappedFetch = async (...args: Parameters<McpFetch>): Promise<Response> => {
    const [input, init] = args;
    const headers = new Headers(init?.headers);
    const request = requestContextFromBody(init?.body);
    if (request?.method === "initialize" && shouldBlockInitialize(discoveryState)) {
      preserveTransportPanic(discoveryPanic.panic);
      return blockedInitializeResponse(request.id);
    }
    if (
      request?.method === "server/discover" &&
      headers.get("mcp-protocol-version") === MODERN_MCP_PROTOCOL_VERSION
    ) {
      discoveryState = "pending";
    }
    const response =
      headers.get("mcp-protocol-version") === MODERN_MCP_PROTOCOL_VERSION &&
      request?.method === "server/discover"
        ? await fetchModernDiscovery(fetchFn, args, request, discoveryPanic)
        : await fetchFn(input, init);
    if (headers.get("mcp-protocol-version") !== MODERN_MCP_PROTOCOL_VERSION) return response;

    if (!request) return response;
    if (!response.ok) {
      if (request.method !== "server/discover") return response;
      const enforced = await enforceModernDiscoveryFailureResponse(response, request);
      discoveryState = enforced.discoveryState;
      return enforced.response;
    }
    if (response.status === 202) {
      if (request.method === "server/discover") discoveryState = "blocked";
      return invalidModernHttpResponse(
        response,
        request.id,
        "Modern MCP request received an empty accepted response",
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const enforced = await enforceModernJsonResponse(response, request);
      if (enforced.discoveryState) discoveryState = enforced.discoveryState;
      return enforced.response;
    }
    if (contentType.includes("text/event-stream")) {
      return enforceModernSseResponse(response, request, (state) => {
        discoveryState = state;
      });
    }
    if (request.method === "server/discover") discoveryState = "blocked";
    return invalidModernHttpResponse(
      response,
      request.id,
      `Unexpected modern MCP response content type ${JSON.stringify(contentType)}`,
    );
  };
  return Object.assign(wrappedFetch, fetchFn);
}

function wrapCustomTransport(transport: MCPTransport): MCPTransport {
  const requestMethods = new Map<string | number, string>();
  let discoveryState: DiscoveryState = "not-attempted";
  const discoveryPanic: DiscoveryPanicHolder = {};
  const failOutstandingDiscovery = (message: string) => {
    for (const [id, method] of requestMethods) {
      if (method !== "server/discover") continue;
      requestMethods.delete(id);
      discoveryState = "blocked";
      wrapped.onmessage?.(invalidModernResultMessage(id, message));
    }
  };
  const wrapped: MCPTransport = {
    supportsProtocolVersionDiscovery: transport.supportsProtocolVersionDiscovery,
    supportsMcpToolParameterHeaders: transport.supportsMcpToolParameterHeaders,
    protocolVersion: transport.protocolVersion,
    start: () => transport.start(),
    send: async (message, options) => {
      if ("method" in message && "id" in message) {
        requestMethods.set(message.id, message.method);
      }
      if (
        "method" in message &&
        "id" in message &&
        message.method === "initialize" &&
        shouldBlockInitialize(discoveryState)
      ) {
        requestMethods.delete(message.id);
        preserveTransportPanic(discoveryPanic.panic);
        wrapped.onmessage?.(
          invalidModernResultMessage(
            message.id,
            "Legacy initialization lacks valid discovery evidence",
          ),
        );
        return;
      }
      const isModernDiscovery =
        wrapped.protocolVersion === MODERN_MCP_PROTOCOL_VERSION &&
        "method" in message &&
        "id" in message &&
        message.method === "server/discover";
      if (!isModernDiscovery) return transport.send(message, options);
      discoveryState = "pending";

      const sent = await Result.tryPromise({
        try: () => transport.send(message, options),
        catch: captureError,
      });
      const decision = sent.match<
        | { readonly kind: "sent" }
        | { readonly kind: "failure"; readonly failure: ReturnType<typeof captureError> }
      >({
        ok: () => ({ kind: "sent" }),
        err: (failure) => ({ kind: "failure", failure }),
      });
      if (decision.kind === "sent") return;

      signalTransportCancellation(options?.signal);
      retainTransportPanic(decision.failure.cause, discoveryPanic);
      preserveTransportPanic(decision.failure.cause);
      requestMethods.delete(message.id);
      discoveryState = "blocked";
      wrapped.onmessage?.(
        invalidModernResultMessage(message.id, "Modern MCP discovery request failed"),
      );
    },
    close: (options) => {
      requestMethods.clear();
      return transport.close(options);
    },
    setProtocolVersion: (version) => {
      wrapped.protocolVersion = version;
      if (transport.setProtocolVersion) {
        transport.setProtocolVersion(version);
        return;
      }
      transport.protocolVersion = version;
    },
  };
  transport.onclose = () => {
    failOutstandingDiscovery("Modern MCP discovery transport closed");
    wrapped.onclose?.();
  };
  transport.onerror = (error) => wrapped.onerror?.(error);
  transport.onmessage = (message) => {
    if ("method" in message) {
      wrapped.onmessage?.(message);
      return;
    }
    const responseId = message.id;
    const requestMethod = responseId === undefined ? undefined : requestMethods.get(responseId);
    if (responseId !== undefined) requestMethods.delete(responseId);
    if (requestMethod === "server/discover") {
      discoveryState = classifyDiscoveryMessage(message);
    }
    const enforced =
      wrapped.protocolVersion === MODERN_MCP_PROTOCOL_VERSION
        ? enforceModernResultType(message, requestMethod)
        : message;
    wrapped.onmessage?.(enforced);
  };
  return wrapped;
}

function isCustomTransport(transport: MCPClientConfig["transport"]): transport is MCPTransport {
  return "start" in transport;
}

export function enforceModernMcpResultContract(
  transport: MCPClientConfig["transport"],
): MCPClientConfig["transport"] {
  if (isCustomTransport(transport)) return wrapCustomTransport(transport);
  if (transport.type !== "http") return transport;
  return {
    ...transport,
    fetch: createModernResultValidatingFetch(transport.fetch ?? globalThis.fetch),
  };
}
