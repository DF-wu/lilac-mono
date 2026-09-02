import { tool } from "ai";
import { Result } from "better-result";
import { z } from "zod";

import {
  questionAnswersSchema,
  questionInputSchema,
  type QuestionInput,
} from "../question/question-domain";
import { QuestionUnavailable, type QuestionService } from "../question/question-service";
import { adaptToolResultToHost } from "./tool-result-adapters";

const questionRequestContextSchema = z.object({
  requestId: z.string().min(1),
  requestDeliveryId: z.string().min(1),
  sessionId: z.string().min(1),
  requestClient: z.literal("discord"),
  currentTurnUserId: z.string().min(1).optional(),
  currentTurnMessageRef: z
    .strictObject({
      platform: z.literal("discord"),
      channelId: z.string().min(1),
      messageId: z.string().min(1),
    })
    .optional(),
  requestInitiator: z.strictObject({
    platform: z.literal("discord"),
    userId: z.string().min(1),
  }),
  requestInitiatorSessionId: z.string().min(1),
});

export function formatQuestionToolArgs(input: unknown): string {
  const decoded = questionInputSchema.safeParse(input);
  if (!decoded.success) return "question";
  const first = decoded.data.questions[0];
  return first ? first.header : "question";
}

export function createQuestionTool(service: QuestionService) {
  return tool({
    description: [
      "Ask the current user one to three questions when their decision is required to continue.",
      "Each question must have a stable ID and two or three mutually exclusive options.",
      "Put the recommended option first and explain the effect of every option.",
      "Do not add an Other option; the interface provides custom text input.",
      "Do not use this for status updates, questions you can answer from available context, or permission escalation.",
    ].join(" "),
    inputSchema: questionInputSchema,
    outputSchema: z.strictObject({ answers: questionAnswersSchema }),
    execute: async (input: QuestionInput, { abortSignal, context, toolCallId }) => {
      const decoded = questionRequestContextSchema.safeParse(context);
      if (!decoded.success) {
        return adaptToolResultToHost(
          Result.err(
            new QuestionUnavailable({
              message: "question requires an authenticated Discord request",
            }),
          ),
        );
      }
      const request = decoded.data;
      if (request.requestInitiatorSessionId !== request.sessionId) {
        return adaptToolResultToHost(
          Result.err(
            new QuestionUnavailable({
              message: "question request origin does not match the active Discord session",
            }),
          ),
        );
      }
      const result = await service.ask({
        requestDeliveryId: request.requestDeliveryId,
        requestId: request.requestId,
        toolCallId,
        sessionId: request.sessionId,
        userId: request.currentTurnUserId ?? request.requestInitiator.userId,
        ...(request.currentTurnMessageRef ? { replyTo: request.currentTurnMessageRef } : {}),
        questions: input,
        signal: abortSignal,
      });
      return { answers: adaptToolResultToHost(result) };
    },
  });
}
