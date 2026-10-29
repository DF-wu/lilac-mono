import type { ModelMessage } from "ai";
import type { QuestionCall } from "./question-domain";

const PREFIX = "<question_result>\n";

export class QuestionContinuation {
  private readonly delivered: Set<string>;
  private readonly consumed: Set<string>;

  constructor(consumed: readonly string[] = []) {
    this.delivered = new Set(consumed);
    this.consumed = new Set(consumed);
  }

  checkpoint(messages: readonly ModelMessage[]): string[] {
    for (const id of this.delivered) {
      const marker = `${PREFIX}${JSON.stringify(id)}\n`;
      if (
        messages.some(
          (message) =>
            message.role === "user" &&
            typeof message.content === "string" &&
            message.content.startsWith(marker),
        )
      )
        this.consumed.add(id);
    }
    return [...this.consumed];
  }

  drain(calls: readonly QuestionCall[], messages: readonly ModelMessage[]): ModelMessage[] {
    for (const call of calls) {
      const marker = `${PREFIX}${JSON.stringify(call.questionCallId)}\n`;
      if (
        messages.some(
          (message) =>
            message.role === "user" &&
            typeof message.content === "string" &&
            message.content.startsWith(marker),
        )
      ) {
        this.delivered.add(call.questionCallId);
        this.consumed.add(call.questionCallId);
      }
    }
    const results: ModelMessage[] = [];
    for (const call of calls) {
      if (call.state === "pending" || this.delivered.has(call.questionCallId)) continue;
      this.delivered.add(call.questionCallId);
      results.push({
        role: "user",
        content: `${PREFIX}${JSON.stringify(call.questionCallId)}\n${JSON.stringify({
          status: call.state,
          questions: call.input.questions,
          answers: call.answers,
          respondentId: call.userId,
        })}\n</question_result>`,
      });
    }
    return results;
  }
}
