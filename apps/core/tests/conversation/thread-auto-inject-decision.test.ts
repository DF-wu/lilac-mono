import { describe, expect, it } from "bun:test";
import {
  buildDecisionAutoInjectCall,
  createDecisionAutoInjectEvaluator,
  createDecisionAutoInjectEvaluatorForModel,
  decideDecisionAutoInject,
  selectDecisionAutoInjectModel,
} from "../../src/conversation/thread-auto-inject-decision";

describe("Decision auto-inject gate", () => {
  it("skips only confident negatives with low usefulness", () => {
    expect(decideDecisionAutoInject({ mayHelp: 0.1, clearlyUnneeded: 0.9 }, 0.8)).toBe("skip");
    expect(decideDecisionAutoInject({ mayHelp: 0.2, clearlyUnneeded: 0.8 }, 0.8)).toBe("skip");
    for (const answers of [
      { mayHelp: 0.5, clearlyUnneeded: 0.5 },
      { mayHelp: 0.9, clearlyUnneeded: 0.9 },
      { mayHelp: 0.1, clearlyUnneeded: 0.7 },
      { mayHelp: 0.8, clearlyUnneeded: 0.1 },
    ])
      expect(decideDecisionAutoInject(answers, 0.8)).toBe("search");
  });

  it("bounds message context and asks only message questions", () => {
    const call = buildDecisionAutoInjectCall({ message: "x".repeat(7000) });
    expect(call.state).toEqual({ message: "x".repeat(6500) });
    expect(Object.keys(call.questions)).toEqual(["may_help", "clearly_unneeded"]);
  });

  it("decodes scores and usage", async () => {
    const evaluator = createDecisionAutoInjectEvaluatorForModel({
      modelId: "test",
      doDecide: async () => ({
        answers: {
          may_help: { type: "boolean", probability: 0.9 },
          clearly_unneeded: { type: "boolean", probability: 0.1 },
        },
        usage: { inputTokens: 100, outputTokens: 2 },
        warnings: [],
      }),
    });
    const result = await evaluator.evaluate({ message: "What blocks my work?" });
    expect(result.unwrap()).toMatchObject({
      mayHelp: 0.9,
      clearlyUnneeded: 0.1,
      usage: { inputTokens: 100, outputTokens: 2 },
    });
  });

  it("returns failures for refusals, malformed probabilities, and provider errors", async () => {
    for (const probability of [NaN, Infinity, -0.1, 1.1]) {
      const evaluator = createDecisionAutoInjectEvaluatorForModel({
        modelId: "test",
        doDecide: async () => ({
          answers: {
            may_help: { type: "boolean", probability },
            clearly_unneeded: { type: "boolean", probability: 1 },
          },
          warnings: [],
        }),
      });
      expect((await evaluator.evaluate({ message: "hello" })).isErr()).toBe(true);
    }
    const refusal = createDecisionAutoInjectEvaluatorForModel({
      modelId: "test",
      doDecide: async () => ({
        answers: { may_help: { type: "refusal", reason: "refused" } },
        warnings: [],
      }),
    });
    expect((await refusal.evaluate({ message: "hello" })).isErr()).toBe(true);
    const failed = createDecisionAutoInjectEvaluatorForModel({
      modelId: "test",
      doDecide: async () => {
        throw new Error("provider unavailable");
      },
    });
    expect((await failed.evaluate({ message: "hello" })).isErr()).toBe(true);
  });

  it("selects configured models and reports missing credentials", () => {
    const models = ["typesafe/jev-1.13.0", "openai/gpt-6-luna"] as const;
    expect(selectDecisionAutoInjectModel(models, false)).toBe(models[0]);
    expect(selectDecisionAutoInjectModel(models, true)).toBe(models[1]);
    expect(createDecisionAutoInjectEvaluator({ model: models[0]! }).isErr()).toBe(true);
    expect(createDecisionAutoInjectEvaluator({ model: "bad/model", apiKey: "test" }).isErr()).toBe(
      true,
    );
  });
});
