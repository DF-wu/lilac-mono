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
  it("defaults to deferred on native and returns before completion", async () => {
    const completion = Promise.withResolvers<Result<never, never>>();
    let request: Parameters<QuestionService["begin"]>[0] | undefined;
    const service = {
      begin: async (input: Parameters<QuestionService["begin"]>[0]) => {
        request = input;
        return Result.ok({
          mode: "deferred",
          questionCallId: "q1",
          completion: completion.promise,
        });
      },
    } as unknown as QuestionService;
    const tool = createQuestionTool(service);
    const result = await tool.execute!(questions, {
      toolCallId: "t1",
      messages: [],
      context: {
        requestId: "r1",
        requestDeliveryId: "d1",
        sessionId: "native:thread",
        requestClient: "native",
        requestInitiator: { platform: "native", userId: "owner" },
        requestInitiatorSessionId: "native:thread",
      },
    });
    expect(result).toEqual({ mode: "deferred", status: "accepted", questionCallId: "q1" });
    expect(request).toMatchObject({ mode: "deferred", platform: "native", sessionId: "thread" });
  });

  it("accepts the full request context supplied by the agent runner", async () => {
    let received: Parameters<QuestionService["ask"]>[0] | null = null;
    const activitySources: string[] = [];
    const service = {
      begin: async (input: Parameters<QuestionService["ask"]>[0]) => {
        received = input;
        input.onActivity?.();
        return Result.ok({
          mode: "sync",
          questionCallId: "question-1",
          completion: Promise.resolve(
            Result.ok([{ questionId: "target", answer: { kind: "option", optionId: "staging" } }]),
          ),
        });
      },
    } as unknown as QuestionService;
    const question = createQuestionTool(service);
    if (!question.execute) throw new Error("Question tool execute function is missing");

    const result = await question.execute(
      { ...questions, mode: "sync" },
      {
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
          currentTurnMessageRef: {
            platform: "discord",
            channelId: "channel-1",
            messageId: "message-1",
          },
          metadata: {
            onActivity: (source: string) => {
              activitySources.push(source);
            },
          },
        },
      },
    );

    expect(result).toEqual({
      mode: "sync",
      status: "answered",
      questionCallId: "question-1",
      answers: [{ questionId: "target", answer: { kind: "option", optionId: "staging" } }],
    });
    expect(received).toMatchObject({
      requestDeliveryId: "delivery-1",
      requestId: "request-1",
      toolCallId: "tool-call-1",
      sessionId: "channel-1",
      userId: "user-1",
      replyTo: {
        platform: "discord",
        channelId: "channel-1",
        messageId: "message-1",
      },
      questions,
    });
    expect(activitySources).toEqual(["tool"]);
  });
});
