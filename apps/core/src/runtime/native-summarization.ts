import { Result, type Result as ResultType } from "better-result";
import {
  ConversationThreadSummarizationRuntimeError,
  type ConversationThreadSummarizationRunner,
} from "../conversation/thread-worker";

export type NativeSummaryRefresh = (input: {
  limit?: number;
}) => Promise<ResultType<{ refreshed: number; discarded: number }, Error>>;

export function withNativeThreadSummaries(
  runner: ConversationThreadSummarizationRunner,
  refresh: NativeSummaryRefresh,
): ConversationThreadSummarizationRunner {
  return {
    async runSummarization(input) {
      if (input?.trigger !== "periodic" || input.dryRun || input.threadId) {
        return runner.runSummarization(input);
      }
      const [legacy, native] = await Promise.all([
        runner.runSummarization(input),
        refresh({ limit: input.limit }),
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
        return Result.ok({ ...result, summarized: result.summarized + summary.refreshed });
      });
    },
  };
}
