import { describe, expect, it } from "bun:test";
import { jsonSchema, tool } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import { AiSdkPiAgent } from "../ai-sdk-pi-agent";
import { ToolExpansion } from "../tool-call-expansion";

function zeroUsage() {
  return {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
}

function textStep(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "text" },
        { type: "text-delta" as const, id: "text", delta: text },
        { type: "text-end" as const, id: "text" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

function toolCallStep(calls: readonly { toolCallId: string; toolName: string }[]) {
  return {
    stream: simulateReadableStream({
      chunks: [
        ...calls.map((call) => ({ type: "tool-call" as const, ...call, input: "{}" })),
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

function emptyTool(execute: () => unknown) {
  return tool({
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute,
  });
}

type ToolDeclarationProbe = { tools?: ReadonlyArray<{ name: string }> };

function offeredToolNames(options: ToolDeclarationProbe): string[] {
  return (options.tools ?? []).map((entry) => entry.name);
}

describe("AiSdkPiAgent step tool authority", () => {
  it("refreshes builtins plus selected tools before each step and defers new selection", async () => {
    const offered: string[][] = [];
    const selected = new Set<string>();
    let catalogExecutions = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        offered.push(offeredToolNames(options));
        return offered.length === 1
          ? toolCallStep([
              { toolCallId: "search", toolName: "tool_search" },
              { toolCallId: "hidden", toolName: "catalog_tool" },
            ])
          : textStep("done");
      },
    });

    let agent: AiSdkPiAgent;
    agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        builtin: emptyTool(() => "builtin"),
        tool_search: emptyTool(() => {
          selected.add("catalog_tool");
          return "selected";
        }),
        catalog_tool: emptyTool(() => {
          catalogExecutions += 1;
          return "catalog";
        }),
      },
      beforeStep: () => {
        agent.setActiveTools(new Set(["builtin", "tool_search", ...selected]));
      },
    });

    await agent.prompt("find and use a tool");

    expect(catalogExecutions).toBe(0);
    expect(offered).toEqual([
      ["builtin", "tool_search"],
      ["builtin", "tool_search", "catalog_tool"],
    ]);
    expect(agent.getLastStepToolSnapshot()?.names).toEqual([
      "builtin",
      "tool_search",
      "catalog_tool",
    ]);
    expect(Object.isFrozen(agent.getLastStepToolSnapshot())).toBe(true);
    expect(Object.isFrozen(agent.getLastStepToolSnapshot()?.tools)).toBe(true);
  });

  it("uses the producing step mapping after the configured toolset changes", async () => {
    let originalExecutions = 0;
    let replacementExecutions = 0;
    let modelCalls = 0;
    const original = emptyTool(() => {
      originalExecutions += 1;
      return "original";
    });
    const replacement = emptyTool(() => {
      replacementExecutions += 1;
      return "replacement";
    });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          agent.setTools({ exact_tool: replacement });
          return toolCallStep([{ toolCallId: "exact", toolName: "exact_tool" }]);
        }
        return textStep("done");
      },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: { exact_tool: original },
    });

    await agent.prompt("call it");

    expect(originalExecutions).toBe(1);
    expect(replacementExecutions).toBe(0);
  });

  it("copies and freezes definitions so in-place mutation cannot change producing-step execution", async () => {
    let originalExecutions = 0;
    let replacementExecutions = 0;
    const definition = emptyTool(() => {
      originalExecutions += 1;
      return "original";
    });
    let modelCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelCalls += 1;
        if (modelCalls > 1) return textStep("done");
        definition.execute = () => {
          replacementExecutions += 1;
          return "replacement";
        };
        return toolCallStep([{ toolCallId: "exact", toolName: "exact_tool" }]);
      },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: { exact_tool: definition },
    });

    await agent.prompt("call it");

    expect(originalExecutions).toBe(1);
    expect(replacementExecutions).toBe(0);
    expect(Object.isFrozen(agent.getLastStepToolSnapshot()?.tools.exact_tool)).toBe(true);
  });

  it("applies the producing step mapping to expansion children", async () => {
    const offered: string[][] = [];
    let childExecutions = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        offered.push(offeredToolNames(options));
        return offered.length === 1
          ? toolCallStep([{ toolCallId: "expand", toolName: "expander" }])
          : textStep("done");
      },
    });
    let agent: AiSdkPiAgent;
    agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        expander: emptyTool(() => {
          agent.activateTools(["child"]);
          return new ToolExpansion("expanded", [
            { toolCallId: "child-call", toolName: "child", input: {} },
          ]);
        }),
        child: emptyTool(() => {
          childExecutions += 1;
          return "child";
        }),
      },
    });
    agent.setActiveTools(new Set(["expander"]));

    await agent.prompt("expand");

    expect(childExecutions).toBe(0);
    expect(offered).toEqual([["expander"], ["expander", "child"]]);
  });

  it("uses the current step mapping for external calls", async () => {
    let originalExecutions = 0;
    let replacementExecutions = 0;
    const original = emptyTool(() => {
      originalExecutions += 1;
      return "original";
    });
    const replacement = emptyTool(() => {
      replacementExecutions += 1;
      return "replacement";
    });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        agent.setTools({ external_tool: replacement });
        await agent.executeExternalToolCall({
          toolCallId: "external",
          toolName: "external_tool",
          input: {},
        });
        return textStep("done");
      },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: { external_tool: original },
    });

    await agent.prompt("external");

    expect(originalExecutions).toBe(1);
    expect(replacementExecutions).toBe(0);
  });

  it("rejects external calls outside the most recent step mapping", async () => {
    let hiddenExecutions = 0;
    const model = new MockLanguageModelV4({ doStream: async () => textStep("done") });
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        builtin: emptyTool(() => "builtin"),
        hidden: emptyTool(() => {
          hiddenExecutions += 1;
          return "hidden";
        }),
      },
    });
    agent.setActiveTools(new Set(["builtin"]));
    await agent.prompt("done");

    const outcome = await agent.executeExternalToolCall({
      toolCallId: "external",
      toolName: "hidden",
      input: {},
    });

    expect(hiddenExecutions).toBe(0);
    expect(outcome.isError).toBe(true);
    expect(String(outcome.result)).toContain("was not offered on the step");
  });
});
