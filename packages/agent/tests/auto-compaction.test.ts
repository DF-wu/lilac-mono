import { describe, expect, it } from "bun:test";
import type { LanguageModel, ModelMessage } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import { ModelCapability } from "@stanley2058/lilac-utils";

import {
  attachAutoCompaction,
  buildSummaryProviderOptions,
  combineCompactionSummaryParts,
  compactMessages,
  __autoCompactionInternals,
  type CompactionProgress,
} from "../auto-compaction";
import { AiSdkPiAgent } from "../ai-sdk-pi-agent";

function createRegistryFetch(registry: unknown): typeof fetch {
  return (async () => {
    return new Response(JSON.stringify(registry), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function fakeModel(): LanguageModel {
  return {} as LanguageModel;
}

function zeroUsage() {
  return {
    inputTokens: {
      total: 0,
      noCache: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: 0,
      text: 0,
      reasoning: 0,
    },
  };
}

describe("auto-compaction internals", () => {
  it("wraps summaries as stable prior context rather than a new request", () => {
    expect(__autoCompactionInternals.buildCompactionSummaryMessage("summary details")).toEqual({
      role: "user",
      content: [
        "<context-compaction>",
        "The conversation before this point was automatically compacted.",
        "Treat this summary as prior conversation context, not as a new user request.",
        "",
        "summary details",
        "</context-compaction>",
      ].join("\n"),
    });
  });

  it("counts canonical inline media separately from text token estimates", () => {
    const withMedia: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "image/png",
            data: "aGVsbG8=",
          },
        ],
      },
    ];
    const scrubbed: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "Image omitted after its limit." }] },
    ];

    expect(__autoCompactionInternals.inlineMediaStorageBytes(withMedia)).toBe(8);
    expect(__autoCompactionInternals.inlineMediaStorageBytes(scrubbed)).toBe(0);
    expect(
      __autoCompactionInternals.estimateMessagesTokens([
        {
          role: "user",
          content: [
            {
              type: "file",
              mediaType: "image/png",
              data: "a".repeat(10 * 1024 * 1024),
            },
          ],
        },
      ]),
    ).toBeLessThan(100);
  });

  it("selects a split-turn boundary using token budget", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "old request" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "large turn" },
      { role: "assistant", content: "x".repeat(4000) },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read_file",
            input: { filePath: "src/index.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read_file",
            output: { type: "text", value: "content" },
          },
        ],
      },
      { role: "assistant", content: "recent assistant" },
      { role: "user", content: "latest user" },
    ];

    const boundary = __autoCompactionInternals.resolveCompactionBoundary({
      messages,
      keepRecentTokens: 15,
      keepLastMessages: 2,
    });

    expect(boundary.suffixStart).toBeGreaterThan(0);
    expect(messages[boundary.suffixStart]?.role).not.toBe("tool");
    expect(boundary.splitTurnStart).toBe(2);
  });

  it("packs under-budget messages into a single summarization call", async () => {
    const messages: ModelMessage[] = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index} ${"x".repeat(200)}`,
    }));

    let calls = 0;
    await __autoCompactionInternals.summarizeMessagesHierarchical({
      messages,
      initialChunkTokenBudget: 129_000,
      maxReductionPasses: 6,
      initialMaxCharsPerMessage: 516_000,
      initialMaxCharsTotal: 774_000,
      stage: "history",
      summarizeChunk: async () => {
        calls += 1;
        return "summary";
      },
    });

    expect(calls).toBe(1);
  });

  it("summarizes a below-threshold transcript in one call without pre-splitting", async () => {
    // Exceeds the old 35% split while remaining below the context limit.
    const messages: ModelMessage[] = Array.from({ length: 300 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `msg ${index} ${"x".repeat(2_930)}`,
    }));
    const contextLimit = 369_000;
    const estimated = __autoCompactionInternals.estimateMessagesTokens(messages);
    expect(estimated).toBeGreaterThan(contextLimit * 0.35);
    expect(estimated).toBeLessThan(contextLimit);

    let calls = 0;
    await __autoCompactionInternals.summarizeMessagesHierarchical({
      messages,
      initialChunkTokenBudget: contextLimit,
      maxReductionPasses: 6,
      initialMaxCharsPerMessage: contextLimit * 4,
      initialMaxCharsTotal: contextLimit * 6,
      stage: "history",
      summarizeChunk: async () => {
        calls += 1;
        return "summary";
      },
    });

    expect(calls).toBe(1);
  });

  it("preserves message order and content when packing a segment", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "FIRST" },
      { role: "assistant", content: "SECOND" },
      { role: "user", content: "THIRD" },
    ];

    const segments = __autoCompactionInternals.renderMessagesForSummarySegments(messages, {
      maxCharsPerMessage: 10_000,
      maxCharsTotal: 10_000,
    });

    expect(segments).toHaveLength(1);
    const segment = segments[0] ?? "";
    expect(segment.indexOf("FIRST")).toBeLessThan(segment.indexOf("SECOND"));
    expect(segment.indexOf("SECOND")).toBeLessThan(segment.indexOf("THIRD"));
  });

  it("starts a new segment once the char limit is reached, losing no messages", () => {
    const markers = ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO", "FOXTROT"];
    const messages: ModelMessage[] = markers.map((marker) => ({
      role: "user" as const,
      content: `${marker}${"y".repeat(100)}`,
    }));

    const segments = __autoCompactionInternals.renderMessagesForSummarySegments(messages, {
      maxCharsPerMessage: 250,
      maxCharsTotal: 250,
    });

    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(250);
    }

    const joined = segments.join("\n");
    for (const marker of markers) {
      expect(joined.split(marker)).toHaveLength(2);
    }
    const positions = markers.map((marker) => joined.indexOf(marker));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("flushes buffered messages before splitting an oversized message", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "SMALL" },
      { role: "assistant", content: "z".repeat(600) },
    ];

    const segments = __autoCompactionInternals.renderMessagesForSummarySegments(messages, {
      maxCharsPerMessage: 200,
      maxCharsTotal: 200,
    });

    expect(segments[0]).toContain("SMALL");
    expect(segments.slice(1).every((segment) => segment.startsWith("[message continuation"))).toBe(
      true,
    );
    expect(segments.slice(1).length).toBeGreaterThan(1);
  });

  it("retries hierarchical summary with smaller budgets after overflow", async () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "a".repeat(3500) },
      { role: "assistant", content: "b".repeat(3500) },
      { role: "user", content: "c".repeat(3500) },
    ];

    let calls = 0;
    const summary = await __autoCompactionInternals.summarizeMessagesHierarchical({
      messages,
      initialChunkTokenBudget: 10_000,
      maxReductionPasses: 6,
      initialMaxCharsPerMessage: 8_000,
      initialMaxCharsTotal: 8_000,
      stage: "history",
      summarizeChunk: async (transcript, previousSummary) => {
        calls += 1;
        if (transcript.length > 1600) {
          throw new Error("maximum context length exceeded");
        }
        return previousSummary
          ? `${previousSummary}|${transcript.length}`
          : `S${transcript.length}`;
      },
    });

    expect(calls).toBeGreaterThan(1);
    expect(summary.startsWith("S")).toBe(true);
  });

  it("sends every marker from an oversized selected message through summarization", async () => {
    const markers = ["MARKER_A", "MARKER_B", "MARKER_C", "MARKER_D"];
    const content = markers.map((marker) => `${marker}${"x".repeat(90)}`).join("");
    const transcripts: string[] = [];
    const previousSummaries: Array<string | null> = [];

    await __autoCompactionInternals.summarizeMessagesHierarchical({
      messages: [{ role: "user", content }],
      initialChunkTokenBudget: 10_000,
      maxReductionPasses: 1,
      initialMaxCharsPerMessage: 200,
      initialMaxCharsTotal: 500,
      stage: "history",
      summarizeChunk: async (transcript, previousSummary) => {
        transcripts.push(transcript);
        previousSummaries.push(previousSummary);
        return `${previousSummary ?? "summary"}|updated`;
      },
    });

    expect(transcripts.length).toBeGreaterThan(1);
    for (const marker of markers) {
      expect(transcripts.some((transcript) => transcript.includes(marker))).toBe(true);
    }
    expect(previousSummaries[0]).toBeNull();
    expect(previousSummaries.slice(1).every((summary) => summary !== null)).toBe(true);
  });

  it("computes overflow recovery decisions", () => {
    const noOverflow = __autoCompactionInternals.computeOverflowRecoveryDecision({
      error: new Error("rate limit"),
      attempts: 0,
      maxAttempts: 2,
      aborted: false,
    });
    expect(noOverflow.recover).toBe(false);
    expect(noOverflow.nextAttempts).toBe(0);

    const recoverable = __autoCompactionInternals.computeOverflowRecoveryDecision({
      error: new Error("prompt is too long"),
      attempts: 1,
      maxAttempts: 2,
      aborted: false,
    });
    expect(recoverable.recover).toBe(true);
    expect(recoverable.nextAttempts).toBe(2);

    const exhausted = __autoCompactionInternals.computeOverflowRecoveryDecision({
      error: new Error("maximum context length"),
      attempts: 2,
      maxAttempts: 2,
      aborted: false,
    });
    expect(exhausted.recover).toBe(false);
    expect(exhausted.terminalError instanceof Error).toBe(true);
  });

  it("computes input budget from safe and early thresholds", () => {
    const largeWindow = __autoCompactionInternals.computeInputCompactionBudget({
      contextLimit: 200_000,
      outputLimit: 16_000,
      thresholdFraction: 0.8,
    });
    expect(largeWindow.earlyInputBudget).toBe(160_000);
    expect(largeWindow.reservedOutputTokens).toBe(40_000);
    expect(largeWindow.safeInputBudget).toBe(160_000);
    expect(largeWindow.inputBudget).toBe(160_000);

    const smallWindow = __autoCompactionInternals.computeInputCompactionBudget({
      contextLimit: 32_000,
      outputLimit: 12_000,
      thresholdFraction: 0.8,
    });
    expect(smallWindow.earlyInputBudget).toBe(25_600);
    expect(smallWindow.reservedOutputTokens).toBe(12_000);
    expect(smallWindow.safeInputBudget).toBe(20_000);
    expect(smallWindow.inputBudget).toBe(20_000);

    const fullOutputWindow = __autoCompactionInternals.computeInputCompactionBudget({
      contextLimit: 500_000,
      outputLimit: 500_000,
      thresholdFraction: 0.8,
    });
    expect(fullOutputWindow.reservedOutputTokens).toBe(100_000);
    expect(fullOutputWindow.safeInputBudget).toBe(400_000);
    expect(fullOutputWindow.inputBudget).toBe(400_000);
  });

  it("normalizes configurable threshold fractions", () => {
    expect(__autoCompactionInternals.normalizeThresholdFraction(undefined)).toBe(0.8);
    expect(__autoCompactionInternals.normalizeThresholdFraction(Number.NaN)).toBe(0.8);
    expect(__autoCompactionInternals.normalizeThresholdFraction(0)).toBe(0.05);
    expect(__autoCompactionInternals.normalizeThresholdFraction(1)).toBe(0.95);
    expect(__autoCompactionInternals.normalizeThresholdFraction(0.6)).toBe(0.6);
  });

  it("manually compacts persisted messages without an agent", async () => {
    const summaryResponse = () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "summary" },
          {
            type: "text-delta" as const,
            id: "summary",
            delta: "Condensed prior work.",
          },
          { type: "text-end" as const, id: "summary" },
          {
            type: "finish" as const,
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage: zeroUsage(),
          },
        ],
      }),
    });
    const model = new MockLanguageModelV4({
      doStream: [summaryResponse(), summaryResponse()],
    });
    const messages: ModelMessage[] = [
      { role: "user", content: `old request ${"a".repeat(6_000)}` },
      { role: "assistant", content: `old response ${"b".repeat(6_000)}` },
      { role: "user", content: "latest request must remain verbatim" },
    ];

    const result = await compactMessages({
      messages,
      currentModel: model,
      contextLimit: 10_000,
      outputLimit: 1_000,
      thresholdFraction: 0.25,
      keepRecentTokens: 1,
      keepLastMessages: 1,
    });

    expect(result.status).toBe("compacted");
    expect(result.messageCountBefore).toBe(3);
    expect(result.messageCountAfter).toBe(2);
    expect(result.estimatedTokensAfter).toBeLessThan(result.estimatedTokensBefore);
    expect(result.budget.inputBudget).toBe(2_500);
    expect(result.messages[0]).toEqual({
      role: "user",
      content: [
        "<context-compaction>",
        "The conversation before this point was automatically compacted.",
        "Treat this summary as prior conversation context, not as a new user request.",
        "",
        "Condensed prior work.",
        "</context-compaction>",
      ].join("\n"),
    });
    expect(result.messages[1]).toEqual(messages[2]);
    expect(messages).toHaveLength(3);
  });

  it("issues a single summarization request for a below-threshold transcript", async () => {
    const summaryResponse = () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "summary" },
          { type: "text-delta" as const, id: "summary", delta: "Condensed prior work." },
          { type: "text-end" as const, id: "summary" },
          {
            type: "finish" as const,
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage: zeroUsage(),
          },
        ],
      }),
    });

    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        return summaryResponse();
      },
    });

    // Exceeds the old 35% split while remaining below the compaction threshold.
    const messages: ModelMessage[] = Array.from({ length: 300 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `msg ${index} ${"x".repeat(2_930)}`,
    }));

    const result = await compactMessages({
      messages,
      currentModel: model,
      contextLimit: 369_000,
      outputLimit: 128_000,
    });

    expect(result.status).toBe("compacted");
    expect(result.estimatedTokensBefore).toBeLessThan(result.budget.inputBudget);
    expect(result.estimatedTokensBefore).toBeGreaterThan(369_000 * 0.35);
    expect(calls).toBe(1);
  });

  it("sizes chunk budgets against a smaller summary model's own context window", async () => {
    const summaryModelContextLimit = 128_000;
    const summaryResponse = () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "summary" },
          { type: "text-delta" as const, id: "summary", delta: "Condensed prior work." },
          { type: "text-end" as const, id: "summary" },
          {
            type: "finish" as const,
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage: zeroUsage(),
          },
        ],
      }),
    });

    const requestedTranscriptChars: number[] = [];
    const summaryModel = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        requestedTranscriptChars.push(JSON.stringify(prompt).length);
        return summaryResponse();
      },
    });

    const messages: ModelMessage[] = Array.from({ length: 400 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `msg ${index} ${"x".repeat(6_000)}`,
    }));

    const result = await compactMessages({
      messages,
      currentModel: fakeModel(),
      contextLimit: 2_000_000,
      outputLimit: 128_000,
      summaryModel,
      summaryContextLimit: summaryModelContextLimit,
    });

    expect(result.status).toBe("compacted");
    expect(requestedTranscriptChars.length).toBeGreaterThan(1);
    for (const chars of requestedTranscriptChars) {
      expect(chars).toBeLessThanOrEqual(summaryModelContextLimit * 4);
    }
  });

  it("streams summary deltas that reconstruct the persisted summary", async () => {
    const pieces = ["Condensed ", "prior ", "work."];
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start" as const, id: "summary" },
            ...pieces.map((delta) => ({ type: "text-delta" as const, id: "summary", delta })),
            { type: "text-end" as const, id: "summary" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: "stop" },
              usage: zeroUsage(),
            },
          ],
        }),
      }),
    });

    const deltas: string[] = [];
    const progressEvents: CompactionProgress[] = [];
    const result = await compactMessages({
      messages: [
        { role: "user", content: `old request ${"a".repeat(6_000)}` },
        { role: "assistant", content: `old response ${"b".repeat(6_000)}` },
        { role: "user", content: "latest request must remain verbatim" },
      ],
      currentModel: model,
      contextLimit: 10_000,
      outputLimit: 1_000,
      thresholdFraction: 0.25,
      keepRecentTokens: 1,
      keepLastMessages: 1,
      onProgress: (progress) => progressEvents.push(progress),
      onSummaryDelta: (delta) => deltas.push(delta),
    });

    expect(result.status).toBe("compacted");
    // Deltas arrive piecewise and rejoin into exactly the summary that is persisted.
    expect(deltas).toEqual(pieces);
    expect(result.messages[0]).toMatchObject({ content: expect.stringContaining(deltas.join("")) });
    // Progress precedes the request it describes, so a renderer can reset its buffer.
    expect(progressEvents).toEqual([{ stage: "history", step: 1, stepCount: 1, pass: 1 }]);
  });

  it("reports a summary covering every stage, including the split turn", async () => {
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        // The split-turn prompt is built separately from the history prompt, so
        // the two stages are distinguishable by what they were asked to do.
        const splitTurn = JSON.stringify(prompt).includes("split");
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start" as const, id: "summary" },
              {
                type: "text-delta" as const,
                id: "summary",
                delta: splitTurn ? "Turn so far." : "Prior work.",
              },
              { type: "text-end" as const, id: "summary" },
              {
                type: "finish" as const,
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage: zeroUsage(),
              },
            ],
          }),
        };
      },
    });

    const stages: Array<CompactionProgress["stage"]> = [];
    const result = await compactMessages({
      messages: [
        { role: "user", content: `old request ${"a".repeat(6_000)}` },
        { role: "assistant", content: `old response ${"b".repeat(6_000)}` },
        { role: "user", content: "latest request" },
        // A trailing assistant message leaves a split turn, so both stages run.
        { role: "assistant", content: `partial answer ${"c".repeat(6_000)}` },
      ],
      currentModel: model,
      contextLimit: 10_000,
      outputLimit: 1_000,
      thresholdFraction: 0.25,
      keepRecentTokens: 1,
      keepLastMessages: 1,
      onProgress: (progress) => stages.push(progress.stage),
      buildSplitTurnSummaryPrompt: (prefix) => `Summarize this split turn:\n${prefix}`,
    });

    expect(result.status).toBe("compacted");
    expect(new Set(stages)).toEqual(new Set(["history", "split-turn"]));
    // The reported summary is the one written into the transcript, so a consumer
    // never has to reassemble the stages itself and cannot get it wrong.
    expect(result.summary).toBe(combineCompactionSummaryParts("Prior work.", "Turn so far."));
    expect(result.messages[0]).toMatchObject({
      content: expect.stringContaining(result.summary ?? " "),
    });
  });

  it("aborts and awaits the sibling stage when one summarization fails", async () => {
    let splitTurnAborted = false;
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt, abortSignal }) => {
        const splitTurn = JSON.stringify(prompt).includes("split");
        if (!splitTurn) throw new Error("history summarization exploded");
        // The split-turn request hangs like a live provider call. When its
        // sibling fails, it must be aborted and awaited before the failure
        // surfaces, or it would keep streaming after the terminal event.
        await new Promise<never>((_, reject) => {
          const fail = () => {
            splitTurnAborted = true;
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (abortSignal?.aborted) fail();
          else abortSignal?.addEventListener("abort", fail, { once: true });
        });
        throw new Error("unreachable");
      },
    });

    const failure = await compactMessages({
      messages: [
        { role: "user", content: `old request ${"a".repeat(6_000)}` },
        { role: "assistant", content: `old response ${"b".repeat(6_000)}` },
        { role: "user", content: "latest request" },
        // A trailing assistant message leaves a split turn, so both run.
        { role: "assistant", content: `partial answer ${"c".repeat(6_000)}` },
      ],
      currentModel: model,
      contextLimit: 10_000,
      outputLimit: 1_000,
      thresholdFraction: 0.25,
      keepRecentTokens: 1,
      keepLastMessages: 1,
      buildSplitTurnSummaryPrompt: (prefix) => `Summarize this split turn:\n${prefix}`,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    // The genuine failure wins over the abort it induced in the sibling, so
    // callers classify this as a failure rather than a cancellation.
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.name : "").not.toBe("AbortError");
    // By the time the failure surfaced, the sibling request had been aborted
    // (and awaited): nothing keeps streaming past the terminal event.
    expect(splitTurnAborted).toBe(true);
  });

  it("stops before the next summarization request once aborted", async () => {
    const controller = new AbortController();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        // Cancel while the first request is in flight; the refine chain must not
        // continue into the remaining segments.
        controller.abort();
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start" as const, id: "summary" },
              { type: "text-delta" as const, id: "summary", delta: "partial" },
              { type: "text-end" as const, id: "summary" },
              {
                type: "finish" as const,
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage: zeroUsage(),
              },
            ],
          }),
        };
      },
    });

    // Ending on a user message keeps the cut off a split turn, so only the
    // history chain runs and the call count is unambiguous.
    const messages: ModelMessage[] = Array.from({ length: 41 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `msg ${index} ${"x".repeat(4_000)}`,
    }));
    expect(
      __autoCompactionInternals.resolveCompactionBoundary({
        messages,
        keepRecentTokens: 1,
        keepLastMessages: 1,
      }).splitTurnStart,
    ).toBeNull();

    await expect(
      compactMessages({
        messages,
        currentModel: model,
        contextLimit: 200_000,
        outputLimit: 1_000,
        summaryContextLimit: 2_000,
        keepRecentTokens: 1,
        keepLastMessages: 1,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("honours a split-turn summary update prompt override", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start" as const, id: "summary" },
            { type: "text-delta" as const, id: "summary", delta: "Condensed prior work." },
            { type: "text-end" as const, id: "summary" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: "stop" },
              usage: zeroUsage(),
            },
          ],
        }),
      }),
    });

    // Cutting on an assistant message makes the preceding turn a split-turn
    // prefix; oversizing it forces a second segment, which is the only path that
    // reaches the update prompt.
    const messages: ModelMessage[] = [
      { role: "user", content: `turn request ${"a".repeat(4_000)}` },
      { role: "assistant", content: `early progress ${"b".repeat(4_000)}` },
      { role: "assistant", content: `more progress ${"c".repeat(4_000)}` },
      { role: "assistant", content: "retained suffix" },
    ];
    expect(
      __autoCompactionInternals.resolveCompactionBoundary({
        messages,
        keepRecentTokens: 1,
        keepLastMessages: 1,
      }),
    ).toEqual({ suffixStart: 3, splitTurnStart: 0 });

    const splitTurnUpdates: string[] = [];
    const result = await compactMessages({
      messages,
      currentModel: model,
      contextLimit: 40_000,
      outputLimit: 1_000,
      // Small enough that the prefix cannot fit one segment.
      summaryContextLimit: 500,
      keepRecentTokens: 1,
      keepLastMessages: 1,
      buildSplitTurnSummaryUpdatePrompt: (previousSummary, nextTranscript) => {
        const prompt = `CUSTOM SPLIT UPDATE\n${previousSummary}\n${nextTranscript}`;
        splitTurnUpdates.push(prompt);
        return prompt;
      },
    });

    expect(result.status).toBe("compacted");
    expect(splitTurnUpdates.length).toBeGreaterThan(0);
  });

  it("drops discarded reasoning summaries from summarization provider options", () => {
    expect(
      buildSummaryProviderOptions({
        openai: {
          store: false,
          include: ["reasoning.encrypted_content"],
          reasoningSummary: "detailed",
        },
        anthropic: { cacheControl: "ephemeral" },
      }),
    ).toEqual({
      openai: { store: false, include: ["reasoning.encrypted_content"] },
      anthropic: { cacheControl: "ephemeral" },
    });
    expect(buildSummaryProviderOptions(undefined)).toBeUndefined();
  });

  it("returns typed noop metrics for an empty persisted transcript", async () => {
    const result = await compactMessages({
      messages: [],
      currentModel: fakeModel(),
      contextLimit: 100_000,
    });

    expect(result).toMatchObject({
      status: "noop",
      reason: "empty",
      messages: [],
      messageCountBefore: 0,
      messageCountAfter: 0,
      estimatedTokensBefore: 0,
      estimatedTokensAfter: 0,
    });
  });

  it("computes fallback budget for unknown-model overflow retries", () => {
    const firstAttempt = __autoCompactionInternals.computeUnknownOverflowCompactionBudget({
      estimatedInputTokens: 12_000,
      lastTurnInputTokens: 10_000,
      overflowAttempt: 1,
    });
    const secondAttempt = __autoCompactionInternals.computeUnknownOverflowCompactionBudget({
      estimatedInputTokens: 12_000,
      lastTurnInputTokens: 10_000,
      overflowAttempt: 2,
    });

    expect(firstAttempt.inputBudget).toBe(8_400);
    expect(secondAttempt.inputBudget).toBe(6_599);
    expect(secondAttempt.inputBudget).toBeLessThan(firstAttempt.inputBudget);
    expect(firstAttempt.reservedOutputTokens).toBe(0);
    expect(firstAttempt.safeInputBudget).toBe(firstAttempt.inputBudget);
  });

  it("clears pending threshold compaction when capability becomes unknown", () => {
    const cleared = __autoCompactionInternals.reconcilePendingCompactionReason({
      pendingReason: "threshold",
      capabilityKnown: false,
    });
    const keepOverflow = __autoCompactionInternals.reconcilePendingCompactionReason({
      pendingReason: "overflow",
      capabilityKnown: false,
    });
    const keepKnownThreshold = __autoCompactionInternals.reconcilePendingCompactionReason({
      pendingReason: "threshold",
      capabilityKnown: true,
    });

    expect(cleared).toBeNull();
    expect(keepOverflow).toBe("overflow");
    expect(keepKnownThreshold).toBe("threshold");
  });

  it("does not fail attach when model capability cannot be resolved", async () => {
    const unknownCapabilityEvents: Array<{ spec: string; reason: string }> = [];

    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      modelSpecifier: "custom/private-model",
    });

    const detach = await attachAutoCompaction(agent, {
      model: "custom/private-model",
      modelCapability: new ModelCapability({
        apiUrl: "https://example.invalid/models.dev/api.json",
        fetch: createRegistryFetch({}),
      }),
      onUnknownCapability: ({ spec, reason }) => {
        unknownCapabilityEvents.push({ spec, reason });
      },
    });

    expect(unknownCapabilityEvents).toHaveLength(1);
    expect(unknownCapabilityEvents[0]).toEqual({
      spec: "custom/private-model",
      reason: "capability_unresolved",
    });

    detach();
  });

  it("uses explicit context and output limits without fetching model capabilities", async () => {
    let capabilityFetches = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      modelSpecifier: "custom/private-model",
    });

    const resolved = await __autoCompactionInternals.resolveContextLimit({
      agent,
      options: {
        model: "custom/private-model",
        modelCapability: new ModelCapability({
          fetch: Object.assign(
            async () => {
              capabilityFetches += 1;
              throw new Error("model capability fetch must not run");
            },
            { preconnect() {} },
          ),
        }),
        resolveContextLimit: async () => ({ context: 32_000, output: 12_000 }),
      },
    });

    expect(capabilityFetches).toBe(0);
    expect(resolved).toMatchObject({
      known: true,
      contextLimit: 32_000,
      outputLimit: 12_000,
    });
  });

  it("keeps numeric explicit context resolvers compatible", async () => {
    let capabilityFetches = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      modelSpecifier: "custom/private-model",
    });

    const resolved = await __autoCompactionInternals.resolveContextLimit({
      agent,
      options: {
        model: "custom/private-model",
        modelCapability: new ModelCapability({
          fetch: Object.assign(
            async () => {
              capabilityFetches += 1;
              throw new Error("model capability fetch must not run");
            },
            { preconnect() {} },
          ),
        }),
        resolveContextLimit: async () => 32_000,
      },
    });

    expect(capabilityFetches).toBe(0);
    expect(resolved).toMatchObject({ known: true, contextLimit: 32_000, outputLimit: 0 });
  });

  it("repairs orphan tool results before boundary selection", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read",
            input: { filePath: "a.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read",
            output: { type: "text", value: "ok" },
          },
          {
            type: "tool-result",
            toolCallId: "orphan-1",
            toolName: "read",
            output: { type: "text", value: "orphan" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "orphan-2",
            toolName: "grep",
            output: { type: "text", value: "orphan" },
          },
        ],
      },
      { role: "user", content: "latest" },
    ];

    const repaired = __autoCompactionInternals.repairTranscriptForCompaction(messages);

    expect(repaired.droppedOrphanToolResultParts).toBe(2);
    expect(repaired.droppedEmptyToolMessages).toBe(1);
    expect(repaired.messages).toHaveLength(3);
    expect(repaired.messages[1]?.role).toBe("tool");
  });

  it("preserves the complete subset of a partial multi-call group", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "complete-call",
            toolName: "read_file",
            input: { filePath: "complete.ts" },
          },
          {
            type: "tool-call",
            toolCallId: "dangling-call",
            toolName: "read_file",
            input: { filePath: "dangling.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "complete-call",
            toolName: "read_file",
            output: { type: "text", value: "complete result" },
          },
        ],
      },
      { role: "user", content: "latest" },
    ];

    expect(__autoCompactionInternals.isValidSuffix(messages, 0)).toBe(false);
    const repaired = __autoCompactionInternals.repairTranscriptForCompaction(messages);
    const rendered = JSON.stringify(repaired.messages);

    expect(repaired.droppedDanglingToolCallParts).toBe(1);
    expect(rendered).toContain("complete-call");
    expect(rendered).toContain("complete result");
    expect(rendered).not.toContain("dangling-call");
    expect(__autoCompactionInternals.isValidSuffix(repaired.messages, 0)).toBe(true);
  });

  it("preserves a complete inline provider tool exchange", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "read" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "inline-call",
            toolName: "mcp__lilac__read",
            input: { path: "README.md" },
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: "inline-call",
            toolName: "mcp__lilac__read",
            output: { type: "text", value: "contents" },
          },
          { type: "text", text: "done" },
        ],
      },
    ];

    expect(__autoCompactionInternals.isValidSuffix(messages, 0)).toBe(true);
    expect(__autoCompactionInternals.repairTranscriptForCompaction(messages)).toEqual({
      messages,
      droppedDanglingToolCallParts: 0,
      droppedOrphanToolResultParts: 0,
      droppedEmptyAssistantMessages: 0,
      droppedEmptyToolMessages: 0,
    });
  });

  it("removes a dangling assistant tool call", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "dangling-call",
            toolName: "bash",
            input: { command: "pwd" },
          },
        ],
      },
      { role: "user", content: "latest" },
    ];

    expect(__autoCompactionInternals.isValidSuffix(messages, 0)).toBe(false);
    const repaired = __autoCompactionInternals.repairTranscriptForCompaction(messages);

    expect(repaired.droppedDanglingToolCallParts).toBe(1);
    expect(repaired.droppedEmptyAssistantMessages).toBe(1);
    expect(repaired.messages).toEqual([{ role: "user", content: "latest" }]);
    expect(__autoCompactionInternals.isValidSuffix(repaired.messages, 0)).toBe(true);
  });

  it("does not connect a tool call and result across an intervening message", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "progress before tool" },
          {
            type: "tool-call",
            toolCallId: "separated-call",
            toolName: "bash",
            input: { command: "pwd" },
          },
        ],
      },
      { role: "user", content: "intervening user" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "separated-call",
            toolName: "bash",
            output: { type: "text", value: "must not reconnect" },
          },
        ],
      },
    ];

    expect(__autoCompactionInternals.isValidSuffix(messages, 0)).toBe(false);
    const repaired = __autoCompactionInternals.repairTranscriptForCompaction(messages);
    const rendered = JSON.stringify(repaired.messages);

    expect(rendered).toContain("progress before tool");
    expect(rendered).toContain("intervening user");
    expect(rendered).not.toContain("separated-call");
    expect(rendered).not.toContain("must not reconnect");
    expect(__autoCompactionInternals.isValidSuffix(repaired.messages, 0)).toBe(true);
  });

  it("drops a result that appears before its call without losing the later complete group", () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "misordered-call",
            toolName: "bash",
            output: { type: "text", value: "misordered result" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "misordered-call",
            toolName: "bash",
            input: { command: "pwd" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "misordered-call",
            toolName: "bash",
            output: { type: "text", value: "ordered result" },
          },
        ],
      },
      { role: "user", content: "latest" },
    ];

    expect(__autoCompactionInternals.isValidSuffix(messages, 0)).toBe(false);
    const repaired = __autoCompactionInternals.repairTranscriptForCompaction(messages);
    const rendered = JSON.stringify(repaired.messages);

    expect(repaired.droppedOrphanToolResultParts).toBe(1);
    expect(rendered).not.toContain("misordered result");
    expect(rendered).toContain("ordered result");
    expect(__autoCompactionInternals.isValidSuffix(repaired.messages, 0)).toBe(true);
  });

  it("shrinks only the summary and preserves retained tool call-result context", () => {
    const summary = `<summary>\n${"s".repeat(8_000)}\n</summary>`;
    const retainedOutputMarker = `UNSUMMARIZED_SUFFIX_OUTPUT_${"x".repeat(10_000)}`;
    const messages: ModelMessage[] = [
      { role: "user", content: summary },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "ls" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: retainedOutputMarker },
          },
        ],
      },
      { role: "user", content: "latest" },
    ];

    const budget = 3_000;
    const shrunk = __autoCompactionInternals.shrinkCompactedMessagesToBudget({
      messages,
      inputBudget: budget,
      summary,
    });

    expect(__autoCompactionInternals.estimateMessagesTokens(shrunk.messages)).toBeLessThanOrEqual(
      budget,
    );
    expect(shrunk.messages.length).toBeGreaterThan(0);
    expect(shrunk.messages[shrunk.messages.length - 1]?.role).not.toBe("assistant");
    expect(JSON.stringify(shrunk.messages)).toContain(retainedOutputMarker);
    expect(JSON.stringify(shrunk.messages)).not.toContain(
      "tool output omitted by emergency compaction",
    );
    // The reported summary is the truncated one the model will actually see.
    expect(shrunk.summary.length).toBeLessThan(summary.length);
    const first = shrunk.messages[0];
    expect(typeof first?.content === "string" && first.content.includes(shrunk.summary)).toBe(true);
  });

  it("preserves the latest user request while shrinking the summary", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: `<summary>\n${"s".repeat(3_000)}\n</summary>` },
      { role: "user", content: "Please continue from here and make sure tests pass." },
    ];

    const { messages: shrunk } = __autoCompactionInternals.shrinkCompactedMessagesToBudget({
      messages,
      inputBudget: 300,
      summary: "s".repeat(3_000),
    });

    expect(shrunk.length).toBeGreaterThan(0);
    expect(shrunk[shrunk.length - 1]?.role).toBe("user");
    const content = shrunk[shrunk.length - 1]?.content;
    expect(typeof content === "string" && content.includes("Please continue from here")).toBe(true);
  });

  it("throws instead of dropping an unsummarized suffix that cannot fit", () => {
    const retainedOutputMarker = `IRREDUCIBLE_SUFFIX_${"x".repeat(4_000)}`;
    const messages: ModelMessage[] = [
      { role: "user", content: "<summary>summary</summary>" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-retained",
            toolName: "bash",
            input: { command: "generate output" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-retained",
            toolName: "bash",
            output: { type: "text", value: retainedOutputMarker },
          },
        ],
      },
      { role: "user", content: "latest request" },
    ];

    expect(() =>
      __autoCompactionInternals.shrinkCompactedMessagesToBudget({
        messages,
        inputBudget: 100,
        summary: "summary",
      }),
    ).toThrow("no retained suffix messages were discarded");
    expect(JSON.stringify(messages)).toContain(retainedOutputMarker);
  });

  it("surfaces a clear failure when an irreducible bounded message cannot fit", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "application/octet-stream",
            data: "x".repeat(1_000),
          },
        ],
      },
    ];

    expect(() =>
      __autoCompactionInternals.shrinkCompactedMessagesToBudget({
        messages,
        inputBudget: 1,
        summary: "",
      }),
    ).toThrow("Compaction could not fit bounded context within the input budget");
  });
});
