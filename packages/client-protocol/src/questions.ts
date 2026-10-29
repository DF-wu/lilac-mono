import { z } from "zod";

export const questionPromptSchema = z.strictObject({
  ordinal: z.number().int().min(1).max(3),
  total: z.number().int().min(1).max(3),
  header: z.string().min(1).max(80),
  question: z.string().min(1).max(2000),
  options: z
    .array(
      z.strictObject({
        index: z.number().int().min(1).max(3),
        label: z.string().min(1).max(100),
        description: z.string().min(1).max(1000),
        token: z.string().min(1).max(128),
      }),
    )
    .min(2)
    .max(3),
  customToken: z.string().min(1).max(128),
});
export const questionSummarySchema = z.strictObject({
  answers: z
    .array(
      z.strictObject({
        header: z.string().min(1).max(80),
        answer: z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("option"), label: z.string().min(1).max(100) }),
          z.strictObject({ kind: z.literal("custom") }),
        ]),
      }),
    )
    .max(3),
});
export const nativeQuestionSchema = z.strictObject({
  questionCallId: z.string().min(1).max(128),
  requestId: z.string().min(1).max(512),
  respondentId: z.string().min(1).max(256),
  historyGeneration: z.number().int().nonnegative(),
  mode: z.enum(["deferred", "sync"]),
  prompts: z.array(questionPromptSchema).min(1).max(3).optional(),
  view: z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("pending"), prompt: questionPromptSchema }),
    z.strictObject({
      state: z.literal("answered"),
      summary: questionSummarySchema,
      replyMessageId: z.string().optional(),
      replyInputId: z.string().optional(),
    }),
    z.strictObject({ state: z.enum(["cancelled", "expired", "interrupted"]) }),
  ]),
});
export type NativeQuestion = z.infer<typeof nativeQuestionSchema>;
