import { describe, expect, it } from "bun:test";
import { jsonSchema } from "ai";

import {
  buildNoAssistantTextError,
  estimateContextSnapshotTokens,
} from "../../../src/surface/bridge/bus-agent-runner/stats";

describe("buildNoAssistantTextError", () => {
  it("reports an uncontinuable tool-call turn instead of model unavailability", () => {
    const message = buildNoAssistantTextError({
      provider: "codex",
      modelId: "gpt-5.6-sol",
      finishReason: "tool-calls",
    });

    expect(message).toContain("neither an executable tool call nor a completed tool result");
    expect(message).not.toContain("model_not_found");
  });
});

describe("estimateContextSnapshotTokens", () => {
  it("separates prompt additions, transcript roles, and active tool schemas", () => {
    const skillsSection = "skill instructions";
    const additionalSessionPrompts = ["session memo"];
    const estimate = estimateContextSnapshotTokens({
      system: `base prompt\n\n${skillsSection}\n\nAdditional Session Memo:\n${additionalSessionPrompts[0]}`,
      skillsSection,
      additionalSessionPrompts,
      messages: [
        { role: "user", content: "question" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "working" },
            {
              type: "tool-result",
              toolCallId: "call",
              toolName: "read",
              output: { type: "text", value: "done" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call",
              toolName: "read",
              output: { type: "text", value: "done" },
            },
          ],
        },
      ],
      tools: {
        read: {
          description: "Read a file",
          inputSchema: jsonSchema({
            type: "object",
            properties: { path: { type: "string" } },
          }),
        },
      },
    });

    expect(estimate.systemPrompt).toBeGreaterThan(0);
    expect(estimate.skills).toBeGreaterThan(0);
    expect(estimate.additionalPrompts).toBeGreaterThan(0);
    expect(estimate.activeToolSchemas).toBeGreaterThan(0);
    expect(estimate.userMessages).toBeGreaterThan(0);
    expect(estimate.assistantMessages).toBeGreaterThan(0);
    expect(estimate.toolResults).toBeGreaterThan(0);
    expect(estimate.total).toBe(
      estimate.systemPrompt +
        estimate.skills +
        estimate.additionalPrompts +
        estimate.activeToolSchemas +
        estimate.userMessages +
        estimate.assistantMessages +
        estimate.toolResults,
    );
  });
});
