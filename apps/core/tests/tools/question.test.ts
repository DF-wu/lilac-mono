import { describe, expect, it } from "bun:test";
import { Result } from "better-result";

import type { QuestionInput } from "../../src/question/question-domain";
import type { QuestionService } from "../../src/question/question-service";
import { createQuestionTool } from "../../src/tools/question";

const questions: QuestionInput = {
  questions: [
    {
      id: "target",
      header: "Target",
      question: "Where should this run?",
      options: [
        { id: "staging", label: "Staging", description: "Use staging." },
        { id: "production", label: "Production", description: "Use production." },
      ],
    },
  ],
};

describe("question tool", () => {
  it("accepts the full request context supplied by the agent runner", async () => {
    let received: Parameters<QuestionService["ask"]>[0] | null = null;
    const service = {
      ask: async (input: Parameters<QuestionService["ask"]>[0]) => {
        received = input;
        return Result.ok([
          { questionId: "target", answer: { kind: "option", optionId: "staging" } },
        ]);
      },
    } as unknown as QuestionService;
    const question = createQuestionTool(service);
    if (!question.execute) throw new Error("Question tool execute function is missing");

    const result = await question.execute(questions, {
      toolCallId: "tool-call-1",
      messages: [],
      context: {
        requestId: "request-1",
        requestDeliveryId: "delivery-1",
        sessionId: "channel-1",
        requestClient: "discord",
        subagentDepth: 0,
        subagentProfile: "primary",
        safetyMode: "trusted",
        requestInitiator: { platform: "discord", userId: "user-1" },
        requestInitiatorSessionId: "channel-1",
        currentTurnUserId: "user-1",
      },
    });

    expect(result).toEqual({
      answers: [{ questionId: "target", answer: { kind: "option", optionId: "staging" } }],
    });
    expect(received).toMatchObject({
      requestDeliveryId: "delivery-1",
      requestId: "request-1",
      toolCallId: "tool-call-1",
      sessionId: "channel-1",
      userId: "user-1",
      questions,
    });
  });
});
