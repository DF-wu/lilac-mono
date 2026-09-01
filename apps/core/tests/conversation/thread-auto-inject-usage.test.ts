import { describe, expect, it } from "bun:test";

import {
  createConversationThreadAutoInjectUsageAccumulator,
  type ConversationThreadAutoInjectUsageAccumulator,
} from "../../src/conversation/thread-service";

type PlannerUsage = Parameters<
  ConversationThreadAutoInjectUsageAccumulator["recordPlannerUsage"]
>[0];
type EmbeddingUsage = Parameters<
  ConversationThreadAutoInjectUsageAccumulator["recordEmbeddingUsage"]
>[0];

describe("conversation thread auto-inject usage", () => {
  it("combines planner and concurrent search embedding usage into one structured log", () => {
    const entries: Array<{ message: string; record: unknown }> = [];
    const times = [100, 156];
    const usage = createConversationThreadAutoInjectUsageAccumulator({
      requestId: "request-1",
      now: () => times.shift() ?? 156,
      log: (message, record) => entries.push({ message, record }),
    });

    usage.recordPlannerUsage({
      model: "codex/gpt-5.3-codex-spark",
      inputTokens: 424,
      outputTokens: 730,
      cacheReadTokens: 0,
      reasoningTokens: 402,
    } satisfies PlannerUsage);
    usage.recordEmbeddingUsage(embeddingUsage({ calls: 3, inputChars: 158, tokens: 30 }));
    usage.recordEmbeddingUsage(embeddingUsage({ calls: 3, inputChars: 130, tokens: 29 }));

    usage.finish({ status: "completed", searchCount: 2, queryCount: 6 });
    usage.finish({ status: "failed" });

    expect(entries).toEqual([
      {
        message: "conversation.thread.auto_inject.usage",
        record: {
          status: "completed",
          requestId: "request-1",
          elapsedMs: 56,
          searches: 2,
          queries: 6,
          planner: {
            model: "codex/gpt-5.3-codex-spark",
            calls: 1,
            inputTokens: 424,
            outputTokens: 730,
            cacheReadTokens: 0,
            reasoningTokens: 402,
          },
          embedding: {
            model: "openai/text-embedding-3-small",
            calls: 6,
            inputChars: 288,
            tokens: 59,
            warnings: 0,
          },
        },
      },
    ]);
  });
});

function embeddingUsage(input: {
  calls: number;
  inputChars: number;
  tokens: number;
}): EmbeddingUsage {
  return {
    model: "openai/text-embedding-3-small",
    calls: input.calls,
    inputChars: input.inputChars,
    tokens: input.tokens,
    warnings: 0,
  };
}
