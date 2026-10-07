import { describe, expect, it } from "bun:test";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";

import {
  buildDecisionAutoInjectCall,
  createDecisionAutoInjectEvaluator,
  createDecisionAutoInjectEvaluatorForModel,
  decideDecisionAutoInject,
  type DecisionAutoInjectAnswers,
  type DecisionAutoInjectCandidate,
} from "../../src/conversation/thread-auto-inject-decision";

const config = parseCoreConfigV2ToUniversal({ configVersion: 2 }).conversation.thread
  .decisionAutoInject;
const options = { ...config.jev, limit: config.limit };

const candidates: DecisionAutoInjectCandidate[] = [
  { threadId: "t0", title: "Router retries", brief: "Retry policy for the router." },
  { threadId: "t1", title: "Garden plan", brief: "Planting schedule." },
  { threadId: "t2", title: "Router outage", brief: "Postmortem for the router outage." },
];

function answers(input: Partial<DecisionAutoInjectAnswers>): DecisionAutoInjectAnswers {
  return {
    asksToRecall: 0,
    durableSubject: 0,
    casual: 0,
    relevance: [0.9, 0.2, 0.7],
    ...input,
  };
}

function booleanAnswers(probabilities: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(probabilities).map(([id, probability]) => [
      id,
      { type: "boolean" as const, probability },
    ]),
  );
}

describe("Decision auto-inject", () => {
  it("opens the gate on recall requests or durable non-casual subjects", () => {
    expect(
      decideDecisionAutoInject({ answers: answers({ asksToRecall: 0.7 }), candidates, options })
        .gate,
    ).toBe("recall");
    expect(
      decideDecisionAutoInject({
        answers: answers({ durableSubject: 0.6, casual: 0.59 }),
        candidates,
        options,
      }).gate,
    ).toBe("durable-subject");
    expect(
      decideDecisionAutoInject({
        answers: answers({ durableSubject: 0.9, casual: 0.6 }),
        candidates,
        options,
      }),
    ).toEqual({
      gate: null,
      selected: [],
      highestRejected: { index: 0, threadId: "t0", probability: 0.9 },
    });
  });

  it("selects relevant candidates by probability up to the limit", () => {
    const decision = decideDecisionAutoInject({
      answers: answers({ asksToRecall: 0.95 }),
      candidates,
      options: { ...options, limit: 1 },
    });

    expect(decision.selected).toEqual([{ index: 0, threadId: "t0", probability: 0.9 }]);
    expect(decision.highestRejected).toEqual({ index: 2, threadId: "t2", probability: 0.7 });
    expect(
      decideDecisionAutoInject({ answers: answers({ asksToRecall: 0.95 }), candidates, options })
        .selected,
    ).toEqual([
      { index: 0, threadId: "t0", probability: 0.9 },
      { index: 2, threadId: "t2", probability: 0.7 },
    ]);
  });

  it("asks gate and per-candidate questions in one call", () => {
    const call = buildDecisionAutoInjectCall({ message: "x".repeat(5000), candidates });

    expect(call.state).toEqual({ message: "x".repeat(4000) });
    expect(Object.keys(call.questions)).toEqual([
      "asks_to_recall",
      "durable_subject",
      "casual",
      "candidate_0",
      "candidate_1",
      "candidate_2",
    ]);
    expect(call.questions.candidate_2).toEqual({
      type: "boolean",
      instructions: {
        candidate_thread: { title: "Router outage", summary: "Postmortem for the router outage." },
        question: "Would reading `candidate_thread` help respond to `message`?",
      },
    });
  });

  it("decodes boolean answers aligned with candidates", async () => {
    const evaluator = createDecisionAutoInjectEvaluatorForModel({
      modelId: "jev-test",
      doDecide: async () => ({
        answers: booleanAnswers({
          asks_to_recall: 0.8,
          durable_subject: 0.4,
          casual: 0.1,
          candidate_0: 0.3,
          candidate_1: 0.65,
          candidate_2: 0.05,
        }),
        usage: { inputTokens: 900 },
        warnings: [],
      }),
    });

    const result = await evaluator.evaluate({ message: "remember the router thing?", candidates });

    expect(evaluator.model).toBe("jev-test");
    expect(result.isOk() ? result.value : result.error).toEqual({
      asksToRecall: 0.8,
      durableSubject: 0.4,
      casual: 0.1,
      relevance: [0.3, 0.65, 0.05],
      usage: { inputTokens: 900 },
    });
  });

  it("reports missing answers and provider failures as evaluation errors", async () => {
    const incomplete = createDecisionAutoInjectEvaluatorForModel({
      modelId: "jev-test",
      doDecide: async () => ({
        answers: booleanAnswers({ asks_to_recall: 0.8, durable_subject: 0.4, casual: 0.1 }),
        warnings: [],
      }),
    });
    const rejected = createDecisionAutoInjectEvaluatorForModel({
      modelId: "jev-test",
      doDecide: async () => {
        throw new Error("401 Unauthorized");
      },
    });

    const missing = await incomplete.evaluate({
      message: "hi",
      candidates: candidates.slice(0, 1),
    });
    const failed = await rejected.evaluate({ message: "hi", candidates });

    expect(missing.isErr() ? missing.error.message : "ok").toBe(
      "Decision must return exactly one answer for every question.",
    );
    expect(failed.isErr() ? failed.error.message : "ok").toBe("401 Unauthorized");
  });

  it("requires a TypeSafe API key", () => {
    const missing = createDecisionAutoInjectEvaluator({ apiKey: " ", model: "jev-1.13.0" });
    const configured = createDecisionAutoInjectEvaluator({
      apiKey: "test-key",
      baseUrl: "https://jev.example.test/v1",
      model: "jev-1.13.0",
    });

    expect(missing.isErr() ? missing.error._tag : "ok").toBe("DecisionAutoInjectUnavailable");
    expect(configured.isOk() ? configured.value.model : "err").toBe("jev-1.13.0");
  });

  it("resolves OpenAI separately and rejects unsupported providers", () => {
    const missing = createDecisionAutoInjectEvaluator({ model: "openai/gpt-6-luna" });
    expect(missing.isErr() ? missing.error.message : "ok").toContain("OPENAI_API_KEY");
    const configured = createDecisionAutoInjectEvaluator({
      apiKey: "test",
      model: "openai/gpt-6-luna",
    });
    expect(configured.isOk() ? configured.value.supportsImages : false).toBe(true);
    expect(
      createDecisionAutoInjectEvaluator({ apiKey: "test", model: "codex/gpt-6-luna" }).isErr(),
    ).toBe(true);
  });

  it("asks Luna whether each candidate covers the same subject and caps its candidates", async () => {
    const requests: Array<{ questions: Array<{ name: string; instructions: string }> }> = [];
    const fetch = Object.assign(
      async (_request: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        return Response.json({
          model: "gpt-6-luna",
          answers: body.questions.map((question: { name: string }) => ({
            type: "predicate",
            name: question.name,
            probability: 0.5,
          })),
        });
      },
      { preconnect: () => {} },
    );
    const created = createDecisionAutoInjectEvaluator({
      apiKey: "test",
      model: "openai/gpt-6-luna",
      fetch,
    });
    if (created.isErr()) throw created.error;

    const result = await created.value.evaluate({ message: "router retries", candidates });

    expect(created.value.maxCandidates).toBe(10);
    expect(result.isOk()).toBe(true);
    const candidateQuestion = requests[0]?.questions.find(
      (question) => question.name === "candidate_0",
    );
    expect(JSON.parse(candidateQuestion?.instructions ?? "{}")).toMatchObject({
      question:
        "Is `candidate_thread` about the same specific project, problem, or item that `message` is about?",
    });
  });

  it("reports refusals and invalid probabilities as evaluation failures", async () => {
    for (const answer of [
      { type: "refusal" as const },
      { type: "boolean" as const, probability: 1.1 },
    ]) {
      const evaluator = createDecisionAutoInjectEvaluatorForModel({
        modelId: "test",
        doDecide: async () => ({
          answers: {
            ...booleanAnswers({ asks_to_recall: 0, durable_subject: 0, casual: 0 }),
            asks_to_recall: answer,
          },
          warnings: [],
        }),
      });
      const result = await evaluator.evaluate({ message: "hi", candidates: [] });
      expect(result.isErr() ? result.error._tag : "ok").toBe("DecisionAutoInjectEvaluationFailed");
    }
  });
});
