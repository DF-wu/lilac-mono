import { describe, expect, it } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText } from "ai";

import {
  convertChatCompletionChunkToResponsesEvents,
  convertChatCompletionResponseToResponses,
  withOpenAIResponsesChatFallbackFetch,
} from "../openai-responses-chat-fallback-fetch";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: {
      "content-type": "application/json",
    },
  });
}

function eventStreamResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
    },
  });
}

function fetchStub(
  handler: (...args: Parameters<typeof globalThis.fetch>) => Response | Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(
    async (...args: Parameters<typeof globalThis.fetch>) => await handler(...args),
    {
      preconnect: globalThis.fetch.preconnect,
    },
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

describe("convertChatCompletionResponseToResponses", () => {
  it("converts chat completion text and usage to a responses object", () => {
    const converted = convertChatCompletionResponseToResponses({
      id: "chatcmpl_123",
      created: 1_700_000_000,
      model: "gpt-test",
      choices: [
        {
          message: {
            role: "assistant",
            content: "hello",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 1 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    });

    expect(converted).toEqual({
      id: "chatcmpl_123",
      created_at: 1_700_000_000,
      model: "gpt-test",
      output: [
        {
          type: "message",
          role: "assistant",
          id: "chatcmpl_123_message",
          content: [
            {
              type: "output_text",
              text: "hello",
              annotations: [],
            },
          ],
        },
      ],
      incomplete_details: null,
      usage: {
        input_tokens: 3,
        input_tokens_details: { cached_tokens: 1 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 2 },
      },
    });
  });

  it("converts chat completion function calls to responses function_call output", () => {
    const converted = convertChatCompletionResponseToResponses({
      id: "chatcmpl_tools",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_123",
                type: "function",
                function: {
                  name: "lookup",
                  arguments: '{"q":"x"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });

    expect(converted?.output).toEqual([
      {
        type: "function_call",
        id: "call_123",
        call_id: "call_123",
        name: "lookup",
        arguments: '{"q":"x"}',
      },
    ]);
  });
});

describe("convertChatCompletionChunkToResponsesEvents", () => {
  it("converts chat completion stream chunks to responses events", () => {
    const state = {
      converted: false,
      startedText: false,
      doneText: false,
      nextOutputIndex: 0,
      toolCalls: {},
      emittedCreated: false,
    };

    const events = convertChatCompletionChunkToResponsesEvents({
      state,
      chunk: {
        id: "chatcmpl_stream",
        created: 1_700_000_000,
        model: "gpt-test",
        choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }],
      },
    });

    expect(events).toEqual([
      {
        type: "response.created",
        response: {
          id: "chatcmpl_stream",
          created_at: 1_700_000_000,
          model: "gpt-test",
        },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "chatcmpl_stream_message",
        },
      },
      {
        type: "response.output_text.delta",
        item_id: "chatcmpl_stream_message",
        output_index: 0,
        delta: "hi",
      },
    ]);
  });
});

describe("withOpenAIResponsesChatFallbackFetch", () => {
  it("leaves responses unchanged when the feature flag is disabled", async () => {
    const fetchFn = fetchStub(() =>
      jsonResponse({
        id: "chatcmpl_123",
        choices: [{ message: { role: "assistant", content: "hello" } }],
      }),
    );

    const wrapped = withOpenAIResponsesChatFallbackFetch({
      enabled: false,
      fetchFn,
    });

    const response = await wrapped("https://api.openai.com/v1/responses", {
      method: "POST",
    });

    expect(await response.json()).toEqual({
      id: "chatcmpl_123",
      choices: [{ message: { role: "assistant", content: "hello" } }],
    });
  });

  it("converts chat completion JSON returned from a responses request", async () => {
    const fetchFn = fetchStub(() =>
      jsonResponse({
        id: "chatcmpl_123",
        choices: [{ message: { role: "assistant", content: "hello" } }],
      }),
    );

    const wrapped = withOpenAIResponsesChatFallbackFetch({
      enabled: true,
      fetchFn,
    });

    const response = await wrapped("https://api.openai.com/v1/responses", {
      method: "POST",
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.headers.get("x-lilac-openai-responses-chat-fallback")).toBe("chat_completion");
    expect(body.output).toEqual([
      {
        type: "message",
        role: "assistant",
        id: "chatcmpl_123_message",
        content: [
          {
            type: "output_text",
            text: "hello",
            annotations: [],
          },
        ],
      },
    ]);
  });

  it("leaves native responses JSON unchanged when the fallback is enabled", async () => {
    const nativeResponsesBody = {
      id: "resp_123",
      created_at: 1_700_000_000,
      model: "gpt-test",
      output: [
        {
          type: "message",
          role: "assistant",
          id: "msg_123",
          content: [{ type: "output_text", text: "hello", annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 2,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 3,
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
    const fetchFn = fetchStub(() => jsonResponse(nativeResponsesBody));

    const wrapped = withOpenAIResponsesChatFallbackFetch({
      enabled: true,
      fetchFn,
    });

    const response = await wrapped("https://api.openai.com/v1/responses", {
      method: "POST",
    });

    expect(await response.json()).toEqual(nativeResponsesBody);
  });

  it("converts chat completion SSE returned from a responses request", async () => {
    const fetchFn = fetchStub(() =>
      eventStreamResponse(
        [
          'data: {"id":"chatcmpl_123","created":1700000000,"model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant","content":"hel"}}]}',
          "",
          'data: {"id":"chatcmpl_123","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
      ),
    );

    const wrapped = withOpenAIResponsesChatFallbackFetch({
      enabled: true,
      fetchFn,
    });

    const response = await wrapped("https://api.openai.com/v1/responses", {
      method: "POST",
    });
    const text = await response.text();

    expect(response.headers.get("x-lilac-openai-responses-chat-fallback")).toBe("chat_completion");
    expect(text).toContain('"type":"response.created"');
    expect(text).toContain('"type":"response.output_text.delta"');
    expect(text).toContain('"delta":"hel"');
    expect(text).toContain('"delta":"lo"');
    expect(text).toContain('"type":"response.output_item.done"');
    expect(text).toContain('"type":"response.completed"');
    expect(text).toContain('"input_tokens":2');
    expect(text).toContain("data: [DONE]");
  });

  it("leaves native responses SSE terminal events unchanged", async () => {
    const fetchFn = fetchStub(() =>
      eventStreamResponse(
        [
          'data: {"type":"response.created","response":{"id":"resp_123","created_at":1700000000,"model":"gpt-test"}}',
          "",
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"input_tokens_details":{"cached_tokens":0},"output_tokens":3,"output_tokens_details":{"reasoning_tokens":0}}}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
      ),
    );
    const wrapped = withOpenAIResponsesChatFallbackFetch({
      enabled: true,
      fetchFn,
    });

    const response = await wrapped("https://api.openai.com/v1/responses", {
      method: "POST",
    });
    const text = await response.text();

    expect(text.match(/"type":"response.completed"/g)?.length).toBe(1);
    expect(text).toContain("data: [DONE]");
  });

  it("lets ai-sdk generateText parse chat completion JSON as a responses result", async () => {
    const fetchFn = fetchStub(() =>
      jsonResponse({
        id: "chatcmpl_generate",
        created: 1_700_000_000,
        model: "gpt-test",
        choices: [{ message: { role: "assistant", content: "hello" } }],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
      }),
    );
    const openai = createOpenAI({
      apiKey: "test-token",
      fetch: withOpenAIResponsesChatFallbackFetch({
        enabled: true,
        fetchFn,
      }),
    });

    const result = await generateText({
      model: openai.responses("gpt-5-mini"),
      prompt: "hi",
    });

    expect(result.text).toBe("hello");
  });

  it("lets ai-sdk streamText parse chat completion SSE as a responses stream", async () => {
    const fetchFn = fetchStub(() =>
      eventStreamResponse(
        [
          'data: {"id":"chatcmpl_stream","created":1700000000,"model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant","content":"hel"}}]}',
          "",
          'data: {"id":"chatcmpl_stream","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
      ),
    );
    const openai = createOpenAI({
      apiKey: "test-token",
      fetch: withOpenAIResponsesChatFallbackFetch({
        enabled: true,
        fetchFn,
      }),
    });

    const result = streamText({
      model: openai.responses("gpt-5-mini"),
      prompt: "hi",
    });

    const text = await withTimeout(
      (async () => {
        let out = "";
        for await (const delta of result.textStream) {
          out += delta;
        }
        return out;
      })(),
    );

    expect(text).toBe("hello");
  });
});
