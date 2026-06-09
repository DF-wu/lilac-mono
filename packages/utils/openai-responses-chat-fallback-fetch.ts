type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];
type FetchResponse = Awaited<ReturnType<typeof globalThis.fetch>>;

type JsonRecord = Record<string, unknown>;

type OpenAIChatUsage = {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  prompt_tokens_details?: {
    cached_tokens?: number | null;
  } | null;
  completion_tokens_details?: {
    reasoning_tokens?: number | null;
  } | null;
};

type OpenAIChatToolCall = {
  id?: string | null;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type OpenAIChatResponse = {
  id?: string | null;
  created?: number | null;
  model?: string | null;
  choices: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OpenAIChatToolCall[] | null;
    } | null;
    finish_reason?: string | null;
  }>;
  usage?: OpenAIChatUsage | null;
};

type OpenAIChatChunk = {
  id?: string | null;
  created?: number | null;
  model?: string | null;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string | null;
        type?: "function" | null;
        function?: {
          name?: string | null;
          arguments?: string | null;
        } | null;
      }> | null;
    } | null;
    finish_reason?: string | null;
  }> | null;
  usage?: OpenAIChatUsage | null;
};

type ToolCallState = {
  id: string;
  name: string;
  arguments: string;
  outputIndex: number;
};

export type OpenAIResponsesChatFallbackStreamState = {
  converted: boolean;
  startedText: boolean;
  doneText: boolean;
  textItemId?: string;
  textOutputIndex?: number;
  nextOutputIndex: number;
  finalChunk?: OpenAIChatChunk;
  toolCalls: Record<number, ToolCallState | undefined>;
  emittedCreated: boolean;
};

const FALLBACK_HEADER = "x-lilac-openai-responses-chat-fallback";

export function withOpenAIResponsesChatFallbackFetch(params: {
  enabled: boolean;
  fetchFn: typeof globalThis.fetch;
  warn?: (message: string, details?: Record<string, unknown>) => void;
}): typeof globalThis.fetch {
  if (!params.enabled) return params.fetchFn;

  return (async (input: FetchInput, init?: FetchInit): Promise<FetchResponse> => {
    const response = await params.fetchFn(input, init);
    if (!shouldTryFallback(input, init, response)) return response;

    const contentType = response.headers.get("content-type") ?? "";
    if (/text\/event-stream/i.test(contentType)) {
      return convertChatCompletionSseResponse(response);
    }

    if (!/json/i.test(contentType)) return response;

    return await convertChatCompletionJsonResponse(response, (details) => {
      params.warn?.("openai responses parser fallback used chat completion response", details);
    });
  }) as typeof globalThis.fetch;
}

export function convertChatCompletionResponseToResponses(value: unknown): JsonRecord | undefined {
  if (!isChatCompletionResponse(value)) return undefined;

  const choice = value.choices[0];
  const message = choice?.message;
  const output: JsonRecord[] = [];
  let outputIndex = 0;

  const content = message?.content;
  if (typeof content === "string" && content.length > 0) {
    output.push({
      type: "message",
      role: "assistant",
      id: `${value.id ?? "chatcmpl_fallback"}_message`,
      content: [
        {
          type: "output_text",
          text: content,
          annotations: [],
        },
      ],
    });
    outputIndex += 1;
  }

  for (const toolCall of message?.tool_calls ?? []) {
    const callId = toolCall.id ?? `${value.id ?? "chatcmpl_fallback"}_tool_${outputIndex}`;
    output.push({
      type: "function_call",
      id: callId,
      call_id: callId,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    });
    outputIndex += 1;
  }

  return {
    id: value.id ?? "chatcmpl_fallback",
    created_at: value.created ?? Math.floor(Date.now() / 1000),
    model: value.model ?? "unknown",
    output,
    incomplete_details: toResponsesIncompleteDetails(choice?.finish_reason),
    usage: toResponsesUsage(value.usage),
  };
}

export function convertChatCompletionChunkToResponsesEvents(input: {
  chunk: unknown;
  state: OpenAIResponsesChatFallbackStreamState;
}): JsonRecord[] | undefined {
  if (!isChatCompletionChunk(input.chunk)) return undefined;

  const { chunk, state } = input;
  const events: JsonRecord[] = [];
  const choice = chunk.choices?.[0];
  const responseId = chunk.id ?? "chatcmpl_fallback";

  if (!state.emittedCreated && (chunk.id || chunk.created || chunk.model)) {
    state.emittedCreated = true;
    events.push({
      type: "response.created",
      response: {
        id: responseId,
        created_at: chunk.created ?? Math.floor(Date.now() / 1000),
        model: chunk.model ?? "unknown",
      },
    });
  }

  const content = choice?.delta?.content;
  if (typeof content === "string" && content.length > 0) {
    if (!state.startedText) {
      const outputIndex = state.nextOutputIndex;
      state.nextOutputIndex += 1;
      state.startedText = true;
      state.textOutputIndex = outputIndex;
      state.textItemId = `${responseId}_message`;
      events.push({
        type: "response.output_item.added",
        output_index: outputIndex,
        item: {
          type: "message",
          id: state.textItemId,
        },
      });
    }

    events.push({
      type: "response.output_text.delta",
      item_id: state.textItemId ?? `${responseId}_message`,
      output_index: state.textOutputIndex ?? 0,
      delta: content,
    });
  }

  for (const toolDelta of choice?.delta?.tool_calls ?? []) {
    const existing = state.toolCalls[toolDelta.index];
    const id = existing?.id ?? toolDelta.id ?? `call_${toolDelta.index}`;
    const name = existing?.name ?? toolDelta.function?.name;
    const argsDelta = toolDelta.function?.arguments ?? "";
    const args = `${existing?.arguments ?? ""}${argsDelta}`;

    if (!existing) {
      if (!name) continue;
      const outputIndex = state.nextOutputIndex;
      state.nextOutputIndex += 1;
      state.toolCalls[toolDelta.index] = { id, name, arguments: args, outputIndex };
      events.push({
        type: "response.output_item.added",
        output_index: outputIndex,
        item: {
          type: "function_call",
          id,
          call_id: id,
          name,
          arguments: "",
        },
      });
    } else {
      existing.arguments = args;
    }

    if (argsDelta.length > 0) {
      events.push({
        type: "response.function_call_arguments.delta",
        item_id: id,
        output_index: state.toolCalls[toolDelta.index]?.outputIndex ?? toolDelta.index,
        delta: argsDelta,
      });
    }
  }

  if (choice?.finish_reason != null || chunk.usage != null) {
    input.state.finalChunk = chunk;
  }

  return events;
}

function shouldTryFallback(
  input: FetchInput,
  init: FetchInit | undefined,
  response: Response,
): boolean {
  if (!response.ok || !response.body) return false;
  if (getRequestMethod(input, init) !== "POST") return false;
  return getRequestUrl(input).pathname.endsWith("/responses");
}

async function convertChatCompletionJsonResponse(
  response: Response,
  onConverted: (details: Record<string, unknown>) => void,
): Promise<Response> {
  let raw: string;
  try {
    raw = await response.clone().text();
  } catch {
    return response;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return response;
  }

  const converted = convertChatCompletionResponseToResponses(parsed);
  if (!converted) return response;

  onConverted({
    mode: "json",
    responseId: typeof converted.id === "string" ? converted.id : undefined,
  });

  return new Response(JSON.stringify(converted), {
    status: response.status,
    statusText: response.statusText,
    headers: withFallbackHeader(response.headers),
  });
}

function convertChatCompletionSseResponse(response: Response): Response {
  if (!response.body) return response;

  const state: OpenAIResponsesChatFallbackStreamState = {
    converted: false,
    startedText: false,
    doneText: false,
    nextOutputIndex: 0,
    toolCalls: {},
    emittedCreated: false,
  };
  const source = response.body;
  const transformed = new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = source.getReader();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      let buffered = "";

      const enqueueFrame = (frame: string) => {
        for (const output of convertSseFrame(frame, state)) {
          controller.enqueue(encoder.encode(output));
        }
      };

      void (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;

            buffered += decoder.decode(value, { stream: true });
            while (true) {
              const split = findSseFrameDelimiter(buffered);
              if (!split) break;
              const frame = buffered.slice(0, split.index);
              buffered = buffered.slice(split.index + split.delimiterLength);
              enqueueFrame(frame);
            }
          }

          const tail = decoder.decode();
          if (tail.length > 0) buffered += tail;
          if (buffered.length > 0) enqueueFrame(buffered);

          if (state.converted) {
            for (const event of createFinalEvents(state)) {
              controller.enqueue(encoder.encode(formatSseData(event)));
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          }
          controller.close();
        } catch (error) {
          controller.error(error instanceof Error ? error : new Error(String(error)));
        } finally {
          try {
            reader.releaseLock();
          } catch {}
        }
      })();
    },
  });

  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers: withFallbackHeader(response.headers),
  });
}

function convertSseFrame(frame: string, state: OpenAIResponsesChatFallbackStreamState): string[] {
  const data = getSseData(frame);
  if (!data) return [`${normalizeSseFrameText(frame)}\n\n`];
  if (data.trim() === "[DONE]") return state.converted ? [] : ["data: [DONE]\n\n"];

  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return [`${normalizeSseFrameText(frame)}\n\n`];
  }

  const events = convertChatCompletionChunkToResponsesEvents({ chunk: parsed, state });
  if (!events) return [`${normalizeSseFrameText(frame)}\n\n`];

  state.converted = true;
  return events.map(formatSseData);
}

function createFinalEvents(state: OpenAIResponsesChatFallbackStreamState): JsonRecord[] {
  const finalChunk = state.finalChunk;
  const choice = finalChunk?.choices?.[0];
  const events: JsonRecord[] = [];

  if (state.startedText && !state.doneText) {
    events.push({
      type: "response.output_item.done",
      output_index: state.textOutputIndex ?? 0,
      item: {
        type: "message",
        id: state.textItemId ?? `${finalChunk?.id ?? "chatcmpl_fallback"}_message`,
      },
    });
    state.doneText = true;
  }

  for (const toolCall of Object.values(state.toolCalls)) {
    if (!toolCall) continue;
    events.push({
      type: "response.output_item.done",
      output_index: toolCall.outputIndex,
      item: {
        type: "function_call",
        id: toolCall.id,
        call_id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
        status: "completed",
      },
    });
  }

  events.push({
    type: "response.completed",
    response: {
      incomplete_details: toResponsesIncompleteDetails(choice?.finish_reason),
      usage: toResponsesUsage(finalChunk?.usage),
    },
  });

  return events;
}

function isChatCompletionResponse(value: unknown): value is OpenAIChatResponse {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.choices)) return false;
  const choice = value.choices[0];
  if (!isRecord(choice)) return false;
  const message = choice.message;
  if (!isRecord(message)) return false;

  const content = message.content;
  if (content !== undefined && content !== null && typeof content !== "string") return false;

  const toolCalls = message.tool_calls;
  if (toolCalls !== undefined && toolCalls !== null) {
    if (!Array.isArray(toolCalls)) return false;
    for (const toolCall of toolCalls) {
      if (!isChatToolCall(toolCall)) return false;
    }
  }

  return content != null || (Array.isArray(toolCalls) && toolCalls.length > 0);
}

function isChatCompletionChunk(value: unknown): value is OpenAIChatChunk {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.choices)) return false;

  const firstChoice = value.choices[0];
  if (firstChoice !== undefined && !isRecord(firstChoice)) return false;

  return (
    value.choices.length === 0 ||
    isRecord(firstChoice?.delta) ||
    firstChoice?.finish_reason != null ||
    isRecord(value.usage)
  );
}

function isChatToolCall(value: unknown): value is OpenAIChatToolCall {
  if (!isRecord(value)) return false;
  if (value.type !== "function") return false;
  const fn = value.function;
  return isRecord(fn) && typeof fn.name === "string" && typeof fn.arguments === "string";
}

function toResponsesUsage(usage: OpenAIChatUsage | null | undefined): JsonRecord {
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  return {
    input_tokens: inputTokens,
    input_tokens_details: {
      cached_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
    output_tokens: outputTokens,
    output_tokens_details: {
      reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}

function toResponsesIncompleteDetails(finishReason: string | null | undefined): JsonRecord | null {
  if (finishReason === "length") return { reason: "max_output_tokens" };
  if (finishReason === "content_filter") return { reason: "content_filter" };
  return null;
}

function withFallbackHeader(headers: Headers): Headers {
  const next = new Headers(headers);
  next.set(FALLBACK_HEADER, "chat_completion");
  return next;
}

function getSseData(frame: string): string {
  const lines = normalizeSseFrameText(frame).split("\n");
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.join("\n");
}

function formatSseData(value: JsonRecord): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function normalizeSseFrameText(frame: string): string {
  return frame.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function findSseFrameDelimiter(input: string): { index: number; delimiterLength: number } | null {
  const lf = input.indexOf("\n\n");
  const crlf = input.indexOf("\r\n\r\n");
  const cr = input.indexOf("\r\r");

  let bestIndex = -1;
  let delimiterLength = 0;
  for (const candidate of [
    { index: lf, delimiterLength: 2 },
    { index: crlf, delimiterLength: 4 },
    { index: cr, delimiterLength: 2 },
  ]) {
    if (candidate.index < 0) continue;
    if (bestIndex < 0 || candidate.index < bestIndex) {
      bestIndex = candidate.index;
      delimiterLength = candidate.delimiterLength;
    }
  }

  return bestIndex >= 0 ? { index: bestIndex, delimiterLength } : null;
}

function getRequestUrl(input: FetchInput): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

function getRequestMethod(input: FetchInput, init?: FetchInit): string {
  const method = init?.method ?? (input instanceof Request ? input.method : undefined) ?? "GET";
  return method.toUpperCase();
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
