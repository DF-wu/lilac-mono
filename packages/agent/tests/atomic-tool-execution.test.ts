import { describe, expect, it } from "bun:test";
import { jsonSchema, tool, type ModelMessage } from "ai";

import { executeAtomicToolCall, type AtomicToolExecutionEvent } from "../atomic-tool-execution";
import { ToolExpansion } from "../tool-call-expansion";

describe("executeAtomicToolCall", () => {
  it("validates input and preserves execution options, updates, conversion, and normalization", async () => {
    const messages: ModelMessage[] = [{ role: "user", content: "run" }];
    const context = { workspace: "test" };
    const abortController = new AbortController();
    const events: AtomicToolExecutionEvent[] = [];
    const seen: Array<{ input: unknown; options: unknown }> = [];
    const approvalChecks: Array<{ input: unknown; options: unknown }> = [];
    const tools = {
      stream: tool({
        inputSchema: jsonSchema<{ count: number }>(
          { type: "object", properties: { count: { type: "number" } } },
          {
            validate: (value) => {
              const count =
                typeof value === "object" && value !== null && "count" in value
                  ? value.count
                  : undefined;
              return { success: true, value: { count: Number(count) + 1 } };
            },
          },
        ),
        needsApproval: (input, options) => {
          approvalChecks.push({ input, options });
          return false;
        },
        execute: async function* (input, options) {
          seen.push({ input, options });
          yield input.count;
          return input.count + 1;
        },
        toModelOutput: ({ input, output }) => ({
          type: "text",
          value: `${input.count}:${output}`,
        }),
      }),
    };
    const pendingToolCalls = new Set<string>();

    const outcome = await executeAtomicToolCall({
      call: { toolCallId: "call-1", toolName: "stream", input: { count: "2" } },
      tools,
      messages,
      context,
      abortSignal: abortController.signal,
      pendingToolCalls,
      inputValidation: { type: "validate" },
      expansionHandling: { type: "capture" },
      normalizeToolResultOutput: (output, normalizationContext) => ({
        type: "text",
        value: `${normalizationContext.toolCallId}:${output.type}`,
      }),
      onEvent: (event) => events.push(event),
    });

    expect(seen[0]?.input).toEqual({ count: 3 });
    expect(approvalChecks).toEqual([
      {
        input: { count: 3 },
        options: { toolCallId: "call-1", messages, context },
      },
    ]);
    expect(seen[0]?.options).toEqual({
      toolCallId: "call-1",
      messages,
      abortSignal: abortController.signal,
      context,
    });
    expect(events.map((event) => event.type)).toEqual([
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
    ]);
    expect(events[1]).toMatchObject({ partialResult: 3 });
    expect(outcome).toMatchObject({
      result: 4,
      isError: false,
      outcome: "success",
      toolOutput: { type: "text", value: "call-1:text" },
    });
    expect(pendingToolCalls.size).toBe(0);
  });

  it("classifies requested schema validation failures as invalid input", async () => {
    let executions = 0;
    const tools = {
      invalid: tool({
        inputSchema: jsonSchema(
          { type: "object" },
          { validate: () => ({ success: false, error: new Error("count is required") }) },
        ),
        execute: () => {
          executions += 1;
          return "unexpected";
        },
      }),
    };

    const outcome = await executeAtomicToolCall({
      call: { toolCallId: "call-invalid", toolName: "invalid", input: {} },
      tools,
      messages: [],
      pendingToolCalls: new Set(),
      inputValidation: { type: "validate" },
      expansionHandling: { type: "capture" },
    });

    expect(executions).toBe(0);
    expect(outcome.outcome).toBe("invalid-input");
    expect(outcome.isError).toBe(true);
    expect(outcome.toolOutput).toMatchObject({ type: "error-text" });
  });

  it("supports expansion capture or rejection without scheduling children", async () => {
    const expansion = new ToolExpansion({ ok: true }, [
      { toolCallId: "child-1", toolName: "child", input: {} },
    ]);
    const tools = {
      expand: tool({
        inputSchema: jsonSchema({ type: "object" }),
        execute: () => expansion,
      }),
    };
    const base = {
      call: { toolCallId: "parent-1", toolName: "expand", input: {} },
      tools,
      messages: [],
      inputValidation: { type: "prevalidated" } as const,
    };

    const captured = await executeAtomicToolCall({
      ...base,
      pendingToolCalls: new Set(),
      expansionHandling: { type: "capture" },
    });
    const rejected = await executeAtomicToolCall({
      ...base,
      pendingToolCalls: new Set(),
      expansionHandling: { type: "reject", message: "expansion rejected" },
    });

    expect(captured.expansion).toBe(expansion);
    expect(captured.toolOutput).toEqual({ type: "json", value: { ok: true } });
    expect(rejected).toMatchObject({
      isError: true,
      outcome: "error",
      toolOutput: { type: "error-text", value: "expansion rejected" },
    });
    expect(rejected.expansion).toBeUndefined();
  });

  it("cleans pending state and emits a terminal event when aborted", async () => {
    const abortController = new AbortController();
    abortController.abort(new Error("cancelled"));
    const pendingToolCalls = new Set<string>();
    const events: AtomicToolExecutionEvent[] = [];

    await expect(
      executeAtomicToolCall({
        call: { toolCallId: "aborted-call", toolName: "noop", input: {} },
        tools: {
          noop: tool({
            inputSchema: jsonSchema({ type: "object" }),
            execute: () => "unexpected",
          }),
        },
        messages: [],
        abortSignal: abortController.signal,
        pendingToolCalls,
        inputValidation: { type: "prevalidated" },
        expansionHandling: { type: "capture" },
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow("cancelled");

    expect(pendingToolCalls.size).toBe(0);
    expect(events.map((event) => event.type)).toEqual([
      "tool_execution_start",
      "tool_execution_end",
    ]);
    expect(events.at(-1)).toMatchObject({ isError: true, outcome: "error" });
  });
});
