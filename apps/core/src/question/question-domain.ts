import { z } from "zod";

export const questionOptionSchema = z.strictObject({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(100),
  description: z.string().min(1).max(1_000),
});

const QUESTION_PROMPT_TEXT_MAX_LENGTH = 3_900;

export const questionDefinitionSchema = z
  .strictObject({
    id: z.string().min(1).max(80),
    header: z.string().min(1).max(80),
    question: z.string().min(1).max(2_000),
    options: z.array(questionOptionSchema).min(2).max(3),
  })
  .superRefine((question, context) => {
    const optionTextLength = question.options.reduce(
      (length, option) => length + option.label.length + option.description.length + 8,
      0,
    );
    const separatorLength = Math.max(0, question.options.length - 1) * 2;
    const renderedLength =
      question.header.length + question.question.length + optionTextLength + separatorLength + 24;
    if (renderedLength <= QUESTION_PROMPT_TEXT_MAX_LENGTH) return;
    context.addIssue({
      code: "custom",
      path: ["question"],
      message: "Question and option text is too long for an interactive card",
    });
  });

export const questionInputSchema = z
  .strictObject({
    questions: z.array(questionDefinitionSchema).min(1).max(3),
  })
  .superRefine((input, context) => {
    const questionIds = new Set<string>();
    input.questions.forEach((question, questionIndex) => {
      if (questionIds.has(question.id)) {
        context.addIssue({
          code: "custom",
          path: ["questions", questionIndex, "id"],
          message: `Duplicate question id: ${question.id}`,
        });
      }
      questionIds.add(question.id);
      const optionIds = new Set<string>();
      question.options.forEach((option, optionIndex) => {
        if (optionIds.has(option.id)) {
          context.addIssue({
            code: "custom",
            path: ["questions", questionIndex, "options", optionIndex, "id"],
            message: `Duplicate option id: ${option.id}`,
          });
        }
        optionIds.add(option.id);
      });
    });
  });

export type QuestionInput = z.output<typeof questionInputSchema>;
export type QuestionDefinition = QuestionInput["questions"][number];

export const questionAnswerSchema = z.strictObject({
  questionId: z.string().min(1),
  answer: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("option"), optionId: z.string().min(1) }),
    z.strictObject({ kind: z.literal("custom"), text: z.string().min(1).max(4_000) }),
  ]),
});

export const questionAnswersSchema = z.array(questionAnswerSchema).max(3);

export type QuestionAnswer = z.output<typeof questionAnswerSchema>;
export type QuestionAnswers = z.output<typeof questionAnswersSchema>;

export type QuestionCallState = "pending" | "answered" | "cancelled" | "interrupted";

export type QuestionCall = {
  readonly questionCallId: string;
  readonly requestDeliveryId: string;
  readonly requestId: string;
  readonly toolCallId: string;
  readonly platform: "discord";
  readonly sessionId: string;
  readonly userId: string;
  readonly input: QuestionInput;
  readonly currentIndex: number;
  readonly answers: QuestionAnswers;
  readonly messageId: string | null;
  readonly state: QuestionCallState;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type QuestionActionToken = {
  readonly tokenSha256: string;
  readonly questionIndex: number;
  readonly kind: "option" | "custom";
  readonly optionIndex: number | null;
};
