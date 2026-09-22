import type {
  ConversationThreadRunSummarizationInput,
  ConversationThreadRunSummarizationResult,
} from "../conversation/thread-service";
import { Result, type Result as ResultType } from "better-result";
import {
  ConversationThreadSummarizationRuntimeError,
  type ConversationThreadSummarizationRunner,
} from "../conversation/thread-worker";

export type NativeSummaryRefresh = (
  input: ConversationThreadRunSummarizationInput,
) => Promise<ResultType<ConversationThreadRunSummarizationResult, Error>>;

export function withNativeThreadSummaries(
  runner: ConversationThreadSummarizationRunner,
  refresh: NativeSummaryRefresh,
): ConversationThreadSummarizationRunner {
  return {
    async runSummarization(input) {
      const [legacy, native] = await Promise.all([
        runner.runSummarization(input),
        refresh(input ?? {}),
      ]);
      return Result.gen(function* () {
        const result = yield* legacy;
        const summary = yield* native.mapError(
          (cause) =>
            new ConversationThreadSummarizationRuntimeError({
              operation: "in-process",
              cause,
              message: "Native thread summarization failed",
            }),
        );
        const reasons = { ...result.eligibility.reasons };
        for (const reason of [
          "forced",
          "never-summarized",
          "content-changed",
          "summary-version",
          "embedding-missing",
          "embedding-outdated",
          "embedding-version",
          "embedding-model",
        ] as const) {
          if (summary.eligibility.reasons[reason] === undefined) continue;
          reasons[reason] = (reasons[reason] ?? 0) + (summary.eligibility.reasons[reason] ?? 0);
        }
        return Result.ok({
          ...result,
          eligible: result.eligible + summary.eligible,
          eligibleTotal: result.eligibleTotal + summary.eligibleTotal,
          eligibility: {
            summary: result.eligibility.summary + summary.eligibility.summary,
            embeddingOnly: result.eligibility.embeddingOnly + summary.eligibility.embeddingOnly,
            reasons,
          },
          cleared: result.cleared + summary.cleared,
          summarized: result.summarized + summary.summarized,
          failed: result.failed + summary.failed,
          failures: [...result.failures, ...summary.failures],
          threadIds: [...result.threadIds, ...summary.threadIds],
        });
      });
    },
  };
}
