import { createHash, randomUUID } from "node:crypto";
import type { NativeQuestion, NativeRpcInputs } from "@stanley2058/lilac-client-protocol";
import { Result } from "better-result";
import type { QuestionAnswers } from "../../question/question-domain";
import {
  QuestionCancelled,
  QuestionInterrupted,
  QuestionTimedOut,
  QuestionUnavailable,
  QUESTION_INACTIVITY_TIMEOUT_MS,
  type QuestionHandle,
  type QuestionRequest,
  type QuestionServiceError,
} from "../../question/question-service";
import type { SurfaceQuestionPort } from "../question";
import { nativeSurfaceError } from "./adapter";
import { nativeFailure } from "./errors";
import type { NativeStore } from "./store";

function questionFailure(error: { message: string }): QuestionUnavailable {
  return new QuestionUnavailable({ message: error.message });
}

export class NativeQuestions {
  private readonly syncStops = new Set<() => void>();

  constructor(private readonly store: NativeStore) {}

  readonly port: SurfaceQuestionPort<"native"> = {
    begin: (input) => this.begin(input),
    present: async () =>
      Result.err(
        nativeSurfaceError(
          "send-message",
          nativeFailure("invalid", "Native questions require a complete question call"),
        ),
      ),
    finish: async () => Result.ok(undefined),
    subscribeAnswers: async () => ({
      stop: async () => {
        for (const stop of this.syncStops) stop();
      },
    }),
  };

  async begin(input: QuestionRequest): Promise<Result<QuestionHandle, QuestionServiceError>> {
    return Result.gen(function* (this: NativeQuestions) {
      const question = yield* this.create(input).mapError(questionFailure);
      const completion =
        question.mode === "sync"
          ? this.waitForReply(input, question)
          : Promise.resolve(Result.ok([]));
      return Result.ok({
        mode: question.mode,
        questionCallId: question.questionCallId,
        completion,
      });
    }, this);
  }

  private create(input: QuestionRequest) {
    const questionCallId = createHash("sha256")
      .update(JSON.stringify([input.requestDeliveryId, input.toolCallId]))
      .digest("hex");
    return this.store.createQuestion(input.userId, input.sessionId, questionCallId, () => {
      const prompts = input.questions.questions.map((question, index) => ({
        ordinal: index + 1,
        total: input.questions.questions.length,
        header: question.header,
        question: question.question,
        options: question.options.map((option, index) => ({
          index: index + 1,
          label: option.label,
          description: option.description,
          token: randomUUID(),
        })),
        customToken: randomUUID(),
      }));
      const prompt = prompts[0];
      if (!prompt) return Result.err(nativeFailure("invalid", "A question is required"));
      return Result.ok({
        questionCallId,
        requestId: input.requestId,
        respondentId: input.userId,
        historyGeneration: 0,
        mode: input.mode ?? "deferred",
        prompts,
        view: { state: "pending", prompt },
      } satisfies NativeQuestion);
    });
  }

  recover() {
    return this.store.interruptPendingSyncQuestions();
  }

  read(actorId: string, input: NativeRpcInputs["questions"]["read"]) {
    return this.store.readQuestion(actorId, input.threadId, input.messageId);
  }

  pending(actorId: string, input: NativeRpcInputs["questions"]["pending"]) {
    return this.store.listPendingQuestions(actorId, input.threadId);
  }

  dismiss(actorId: string, input: NativeRpcInputs["questions"]["dismiss"]) {
    return this.store.dismissQuestion(actorId, input);
  }

  private waitForReply(
    input: QuestionRequest,
    initial: NativeQuestion,
  ): Promise<Result<QuestionAnswers, QuestionServiceError>> {
    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe = () => {};
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const settle = (result: Result<QuestionAnswers, QuestionServiceError>) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", abort);
        this.syncStops.delete(stop);
        resolve(result);
      };
      const terminal = (
        state: "cancelled" | "expired" | "interrupted",
        error: QuestionServiceError,
      ) => {
        check();
        if (settled) return;
        const result = this.store
          .finishQuestion(input.userId, input.sessionId, initial.questionCallId, state)
          .mapError(questionFailure);
        settle(result.andThen(() => Result.err(error)));
      };
      const abort = () =>
        terminal("cancelled", new QuestionCancelled({ message: "Question cancelled" }));
      const stop = () =>
        terminal("interrupted", new QuestionInterrupted({ message: "Question interrupted" }));
      const check = () => {
        const result = Result.gen(function* (this: NativeQuestions) {
          const question = yield* this.read(input.userId, {
            threadId: input.sessionId,
            messageId: initial.questionCallId,
          }).mapError(questionFailure);
          if (question.view.state === "pending") return Result.ok(null);
          if (question.view.state === "cancelled")
            return Result.err(new QuestionCancelled({ message: "Question cancelled" }));
          if (question.view.state === "expired")
            return Result.err(new QuestionTimedOut({ message: "Question timed out" }));
          if (question.view.state !== "answered" || !question.view.replyInputId)
            return Result.err(
              new QuestionInterrupted({ message: "Question closed without a reply" }),
            );
          const reply = yield* this.store
            .getInput(question.view.replyInputId)
            .mapError(questionFailure);
          const answers: QuestionAnswers = [
            {
              questionId: initial.questionCallId,
              answer: {
                kind: "message",
                text: reply.text,
                messageId: reply.messageId,
                attachmentIds: reply.attachmentIds,
              },
            },
          ];
          return Result.ok(answers);
        }, this);
        result.match({
          ok: (answers) => {
            if (answers) settle(Result.ok(answers));
          },
          err: (error) => settle(Result.err(error)),
        });
      };
      this.syncStops.add(stop);
      unsubscribe = this.store.subscribe((threadId) => {
        if (threadId === input.sessionId) check();
      });
      timeout = setTimeout(
        () => terminal("expired", new QuestionTimedOut({ message: "Question timed out" })),
        QUESTION_INACTIVITY_TIMEOUT_MS,
      );
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort();
      check();
    });
  }
}
