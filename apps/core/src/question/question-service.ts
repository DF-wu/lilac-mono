import { createHash } from "node:crypto";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import {
  SurfaceQuestionAnswerHandlingFailed,
  type SurfaceQuestionAnswer,
  type SurfaceQuestionInteractionUpdater,
  type SurfaceQuestionAnswerSubscription,
  type SurfaceQuestionPort,
  type SurfaceQuestionPrompt,
  type SurfaceQuestionSummary,
} from "../surface/question";
import type { SurfaceQuestionResolver } from "../surface/runtime-descriptor";
import type { SurfaceOperationError } from "../surface/adapter";
import type { MsgRefFor } from "../surface/types";
import { isAdapterPlatform } from "../shared/is-adapter-platform";
import type { QuestionActionToken, QuestionAnswers, QuestionCall } from "./question-domain";
import type { QuestionInput } from "./question-domain";
import {
  QuestionStoreCorrupt,
  QuestionStoreFailed,
  SqliteQuestionStore,
  type QuestionStoreError,
} from "./question-store";

export class QuestionUnavailable extends TaggedError("QuestionUnavailable")<{
  readonly message: string;
}> {}

export class QuestionPresentationFailed extends TaggedError("QuestionPresentationFailed")<{
  readonly operation: "present" | "update";
  readonly cause: SurfaceOperationError;
  readonly message: string;
}> {}

export class QuestionCancelled extends TaggedError("QuestionCancelled")<{
  readonly message: string;
}> {}

export class QuestionInterrupted extends TaggedError("QuestionInterrupted")<{
  readonly message: string;
}> {}

export type QuestionServiceError =
  | QuestionUnavailable
  | QuestionPresentationFailed
  | QuestionCancelled
  | QuestionInterrupted
  | QuestionStoreFailed
  | QuestionStoreCorrupt;

type QuestionServiceLogger = {
  warn(message: string, context: Readonly<Record<string, unknown>>): void;
};

type PendingQuestion = {
  readonly resolve: (result: ResultType<QuestionAnswers, QuestionServiceError>) => void;
};

type IssuedPrompt = {
  readonly prompt: SurfaceQuestionPrompt;
  readonly tokens: readonly QuestionActionToken[];
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function issuePrompt(call: QuestionCall): IssuedPrompt {
  const question = call.input.questions[call.currentIndex]!;
  const options = question.options.map((option, index) => {
    const token = crypto.randomUUID();
    return {
      view: {
        index: index + 1,
        label: option.label,
        description: option.description,
        token,
      },
      stored: {
        tokenSha256: sha256(token),
        questionIndex: call.currentIndex,
        kind: "option" as const,
        optionIndex: index + 1,
      },
    };
  });
  const customToken = crypto.randomUUID();
  return {
    prompt: {
      ordinal: call.currentIndex + 1,
      total: call.input.questions.length,
      header: question.header,
      question: question.question,
      options: options.map((option) => option.view),
      customToken,
    },
    tokens: [
      ...options.map((option) => option.stored),
      {
        tokenSha256: sha256(customToken),
        questionIndex: call.currentIndex,
        kind: "custom",
        optionIndex: null,
      },
    ],
  };
}

function presentationFailure(
  operation: QuestionPresentationFailed["operation"],
  cause: SurfaceOperationError,
): QuestionPresentationFailed {
  return new QuestionPresentationFailed({
    operation,
    cause,
    message: `Question ${operation} failed: ${cause.message}`,
  });
}

function answerHandlingFailure(error: {
  readonly message: string;
}): SurfaceQuestionAnswerHandlingFailed {
  return new SurfaceQuestionAnswerHandlingFailed({ message: error.message });
}

function questionSummary(call: QuestionCall): SurfaceQuestionSummary {
  return {
    answers: call.answers.map((answer) => {
      const question = call.input.questions.find((candidate) => candidate.id === answer.questionId);
      const selectedAnswer = answer.answer;
      if (selectedAnswer.kind === "custom") {
        return {
          header: question?.header ?? answer.questionId,
          answer: { kind: "custom" as const },
        };
      }
      const option = question?.options.find(
        (candidate) => candidate.id === selectedAnswer.optionId,
      );
      return {
        header: question?.header ?? answer.questionId,
        answer: {
          kind: "option" as const,
          label: option?.label ?? selectedAnswer.optionId,
        },
      };
    }),
  };
}

export class QuestionService {
  readonly #waiters = new Map<string, PendingQuestion>();
  readonly #subscriptions: SurfaceQuestionAnswerSubscription[] = [];
  readonly #startupInterrupted: QuestionCall[] = [];

  constructor(
    private readonly input: {
      readonly store: SqliteQuestionStore;
      readonly surfaces: SurfaceQuestionResolver;
      readonly logger: QuestionServiceLogger;
    },
  ) {}

  supports(platform: string): boolean {
    return isAdapterPlatform(platform) && this.input.surfaces.resolve(platform) !== null;
  }

  async start(): Promise<ResultType<void, QuestionStoreError>> {
    for (const resolved of this.input.surfaces.entries()) {
      const subscription = await resolved.question.subscribeAnswers(
        async (answer, updateInteraction) =>
          await this.handleAnswer(answer as SurfaceQuestionAnswer<"discord">, updateInteraction),
      );
      this.#subscriptions.push(subscription);
    }

    const interrupted = this.input.store.interruptPending();
    const interruptedOutcome = interrupted.match<
      | { readonly kind: "calls"; readonly calls: QuestionCall[] }
      | { readonly kind: "error"; readonly error: QuestionStoreError }
    >({
      ok: (calls) => ({ kind: "calls", calls }),
      err: (error) => ({ kind: "error", error }),
    });
    if (interruptedOutcome.kind === "error") return Result.err(interruptedOutcome.error);

    this.#startupInterrupted.push(...interruptedOutcome.calls);
    return Result.ok(undefined);
  }

  async finishStartupRecovery(): Promise<void> {
    for (const call of this.#startupInterrupted.splice(0)) {
      if (!call.messageId) continue;
      const surface = this.input.surfaces.resolve(call.platform);
      if (!surface) continue;
      const finished = await (surface.question as SurfaceQuestionPort<"discord">).finish({
        messageRef: {
          platform: "discord",
          channelId: call.sessionId,
          messageId: call.messageId,
        },
        state: "interrupted",
      });
      finished.match({
        ok: () => undefined,
        err: (error) =>
          this.input.logger.warn("Question startup cleanup failed", {
            questionCallId: call.questionCallId,
            errorTag: error._tag,
            errorMessage: error.message,
          }),
      });
    }
  }

  async stop(): Promise<void> {
    for (const subscription of this.#subscriptions.splice(0)) await subscription.stop();
    for (const [questionCallId, waiter] of this.#waiters) {
      this.input.store.transitionPending(questionCallId, "interrupted");
      await this.finishCall(questionCallId, "interrupted");
      waiter.resolve(
        Result.err(
          new QuestionInterrupted({
            message: "Question interrupted by shutdown",
          }),
        ),
      );
    }
    this.#waiters.clear();
  }

  async ask(input: {
    readonly requestDeliveryId: string;
    readonly requestId: string;
    readonly toolCallId: string;
    readonly sessionId: string;
    readonly userId: string;
    readonly replyTo?: MsgRefFor<"discord">;
    readonly questions: QuestionInput;
    readonly signal?: AbortSignal;
  }): Promise<ResultType<QuestionAnswers, QuestionServiceError>> {
    if (input.signal?.aborted) {
      return Result.err(new QuestionCancelled({ message: "Question cancelled" }));
    }
    const resolved = this.input.surfaces.resolve("discord");
    if (!resolved) {
      return Result.err(
        new QuestionUnavailable({
          message: "The active surface does not support questions",
        }),
      );
    }
    const existing = this.input.store.getByIdentity(input.requestDeliveryId, input.toolCallId);
    const existingOutcome = existing.match<
      | { readonly kind: "call"; readonly call: QuestionCall | null }
      | { readonly kind: "error"; readonly error: QuestionStoreError }
    >({
      ok: (call) => ({ kind: "call", call }),
      err: (error) => ({ kind: "error", error }),
    });
    if (existingOutcome.kind === "error") return Result.err(existingOutcome.error);
    if (existingOutcome.call?.state === "answered") {
      return Result.ok(existingOutcome.call.answers);
    }
    if (existingOutcome.call) {
      return Result.err(
        new QuestionInterrupted({
          message: "The previous question call did not complete",
        }),
      );
    }

    const questionCallId = crypto.randomUUID();
    const initialCall: QuestionCall = {
      questionCallId,
      requestDeliveryId: input.requestDeliveryId,
      requestId: input.requestId,
      toolCallId: input.toolCallId,
      platform: "discord",
      sessionId: input.sessionId,
      userId: input.userId,
      input: input.questions,
      currentIndex: 0,
      answers: [],
      messageId: null,
      state: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const issued = issuePrompt(initialCall);
    const created = this.input.store.create({
      questionCallId,
      requestDeliveryId: input.requestDeliveryId,
      requestId: input.requestId,
      toolCallId: input.toolCallId,
      sessionId: input.sessionId,
      userId: input.userId,
      questionInput: input.questions,
      tokens: issued.tokens,
    });
    const createdOutcome = created.match<
      | { readonly kind: "call"; readonly call: QuestionCall }
      | { readonly kind: "error"; readonly error: QuestionStoreError }
    >({
      ok: (call) => ({ kind: "call", call }),
      err: (error) => ({ kind: "error", error }),
    });
    if (createdOutcome.kind === "error") return Result.err(createdOutcome.error);

    const port = resolved.question as SurfaceQuestionPort<"discord">;
    const presented = await port.present({
      sessionRef: { platform: "discord", channelId: input.sessionId },
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      prompt: issued.prompt,
    });
    const presentedOutcome = presented.match<
      | { readonly kind: "message"; readonly messageId: string }
      | { readonly kind: "error"; readonly error: SurfaceOperationError }
    >({
      ok: (messageRef) => ({
        kind: "message",
        messageId: messageRef.messageId,
      }),
      err: (error) => ({ kind: "error", error }),
    });
    if (presentedOutcome.kind === "error") {
      this.input.store.transitionPending(questionCallId, "cancelled");
      return Result.err(presentationFailure("present", presentedOutcome.error));
    }
    const bound = this.input.store.bindMessage(questionCallId, presentedOutcome.messageId);
    const boundError = bound.match({ ok: () => null, err: (error) => error });
    if (boundError) {
      this.input.store.transitionPending(questionCallId, "cancelled");
      await port.finish({
        messageRef: {
          platform: "discord",
          channelId: input.sessionId,
          messageId: presentedOutcome.messageId,
        },
        state: "cancelled",
      });
      return Result.err(boundError);
    }
    return await this.waitForAnswer(questionCallId, input.signal);
  }

  private async waitForAnswer(
    questionCallId: string,
    signal?: AbortSignal,
  ): Promise<ResultType<QuestionAnswers, QuestionServiceError>> {
    return await new Promise((resolve) => {
      const settle = (result: ResultType<QuestionAnswers, QuestionServiceError>) => {
        signal?.removeEventListener("abort", abort);
        this.#waiters.delete(questionCallId);
        resolve(result);
      };
      const abort = () => {
        if (abortStarted) return;
        abortStarted = true;
        void this.cancelPendingQuestion(questionCallId, settle);
      };
      let abortStarted = false;
      this.#waiters.set(questionCallId, { resolve: settle });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const stored = this.input.store.getById(questionCallId);
      stored.match({
        ok: (call) => {
          if (call?.state === "answered") settle(Result.ok(call.answers));
        },
        err: (error) => settle(Result.err(error)),
      });
    });
  }

  private async cancelPendingQuestion(
    questionCallId: string,
    settle: (result: ResultType<QuestionAnswers, QuestionServiceError>) => void,
  ): Promise<void> {
    this.input.store.transitionPending(questionCallId, "cancelled");
    await this.finishCall(questionCallId, "cancelled");
    settle(Result.err(new QuestionCancelled({ message: "Question cancelled" })));
  }

  private async handleAnswer(
    answer: SurfaceQuestionAnswer<"discord">,
    updateInteraction: SurfaceQuestionInteractionUpdater,
  ): Promise<
    ResultType<
      "accepted" | "not-found" | "stale" | "unauthorized",
      SurfaceQuestionAnswerHandlingFailed
    >
  > {
    const applied = this.input.store.applyAnswer({
      tokenSha256: sha256(answer.token),
      platform: answer.platform,
      channelId: answer.channelId,
      messageId: answer.messageRef.messageId,
      userId: answer.principal.userId,
      answer: answer.answer,
    });
    const outcome = applied.match<
      | {
          readonly kind: "result";
          readonly result:
            | { readonly disposition: "not-found" | "stale" | "unauthorized" }
            | { readonly disposition: "accepted"; readonly call: QuestionCall };
        }
      | { readonly kind: "error"; readonly error: QuestionStoreError }
    >({
      ok: (result) => ({ kind: "result", result }),
      err: (error) => ({ kind: "error", error }),
    });
    if (outcome.kind === "error") return Result.err(answerHandlingFailure(outcome.error));
    if (outcome.result.disposition !== "accepted") return Result.ok(outcome.result.disposition);

    const call = outcome.result.call;
    if (call.state === "answered") {
      const finished = await updateInteraction({
        state: "answered",
        summary: questionSummary(call),
      });
      finished.match({
        ok: () => undefined,
        err: (error) =>
          this.input.logger.warn("Question presentation cleanup failed", {
            questionCallId: call.questionCallId,
            errorTag: error._tag,
            errorMessage: error.message,
          }),
      });
      this.#waiters.get(call.questionCallId)?.resolve(Result.ok(call.answers));
      return Result.ok("accepted");
    }
    const issued = issuePrompt(call);
    const replaced = this.input.store.replaceTokens(call.questionCallId, issued.tokens);
    const replaceError = replaced.match({
      ok: () => null,
      err: (error) => error,
    });
    if (replaceError) {
      this.input.store.transitionPending(call.questionCallId, "cancelled");
      await this.finishCall(call.questionCallId, "cancelled");
      this.#waiters.get(call.questionCallId)?.resolve(Result.err(replaceError));
      return Result.err(answerHandlingFailure(replaceError));
    }
    const updated = await updateInteraction({
      state: "pending",
      prompt: issued.prompt,
    });
    const updateError = updated.match({
      ok: () => null,
      err: (error) => error,
    });
    if (!updateError) return Result.ok("accepted");
    this.input.store.transitionPending(call.questionCallId, "cancelled");
    this.#waiters
      .get(call.questionCallId)
      ?.resolve(Result.err(presentationFailure("update", updateError)));
    return Result.err(answerHandlingFailure(updateError));
  }

  private async finishCall(
    questionCallId: string,
    state: "cancelled" | "interrupted",
  ): Promise<void> {
    const call = this.input.store.getById(questionCallId).match({
      ok: (value) => value,
      err: () => null,
    });
    if (!call) return;
    if (!call.messageId) return;
    const resolved = this.input.surfaces.resolve(call.platform);
    if (!resolved) return;
    const messageRef = {
      platform: "discord" as const,
      channelId: call.sessionId,
      messageId: call.messageId,
    };
    const port = resolved.question as SurfaceQuestionPort<"discord">;
    const finished = await port.finish({ messageRef, state });
    finished.match({
      ok: () => undefined,
      err: (error) =>
        this.input.logger.warn("Question presentation cleanup failed", {
          questionCallId,
          errorTag: error._tag,
          errorMessage: error.message,
        }),
    });
  }
}
