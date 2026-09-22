import { Result, type Result as ResultType } from "better-result";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import {
  defaultSummarizer,
  type ConversationThreadRunSummarizationInput,
  type ConversationThreadRunSummarizationResult,
  type ConversationThreadGenerationError,
} from "../../conversation/thread-service";
import type { NativeThreadRecord } from "./codec";
import { normalizeNativeSummary } from "./search-summary-codec";
import { NativeSearchStore, type NativeSearchMessage } from "./store-search";
import { NativeSummaryStore } from "./store-search-summary";
import type { NativeStore, NativeStoreError } from "./store";

export type NativeSummaryRefreshError = NativeStoreError | ConversationThreadGenerationError;
const INPUT_CHAR_LIMIT = 96 * 1024;
const INPUT_MESSAGE_LIMIT = 200;

function boundedMessages(messages: NativeSearchMessage[]): NativeSearchMessage[] {
  const perMessage = Math.min(
    16 * 1024,
    Math.floor(INPUT_CHAR_LIMIT / Math.max(1, messages.length)),
  );
  return messages.map((message) => ({ ...message, text: message.text.slice(0, perMessage) }));
}

export function emptyNativeSummaryResult(dryRun = false): ConversationThreadRunSummarizationResult {
  return {
    dryRun,
    refreshed: { channels: 0, threads: 0, messages: 0 },
    eligible: 0,
    eligibleTotal: 0,
    eligibility: { summary: 0, embeddingOnly: 0, reasons: {} },
    cleared: 0,
    summarized: 0,
    failed: 0,
    failures: [],
    threadIds: [],
  };
}

export class NativeSummaryRefresher {
  constructor(
    private readonly params: {
      store: NativeStore;
      search: NativeSearchStore;
      summaries: NativeSummaryStore;
      getConfig: () => CoreConfig;
      summarize?: typeof defaultSummarizer;
      now?: () => number;
    },
  ) {}

  async refresh(
    input: ConversationThreadRunSummarizationInput & { abortSignal?: AbortSignal } = {},
  ): Promise<ResultType<ConversationThreadRunSummarizationResult, NativeSummaryRefreshError>> {
    return Result.gen(async function* () {
      if (input.abortSignal?.aborted) return Result.ok(emptyNativeSummaryResult(input.dryRun));
      const result = yield* this.prepareRefresh(input);
      if (input.clear && input.dryRun) return Result.ok(result);
      const candidates = yield* this.params.summaries.candidates({
        ...input,
        now: input.now ?? (this.params.now ?? Date.now)(),
      });
      const selected = candidates.slice(
        0,
        input.limit === undefined ? candidates.length : Math.min(10000, Math.max(1, input.limit)),
      );
      result.eligibleTotal = candidates.length;
      result.eligible = selected.length;
      result.eligibility.summary = candidates.length;
      result.threadIds = selected.map((thread) => thread.id);
      for (const thread of candidates) {
        const previous = yield* this.params.summaries.get(thread.id);
        const contentReason = previous ? "content-changed" : "never-summarized";
        const reason = input.force ? "forced" : contentReason;
        result.eligibility.reasons[reason] = (result.eligibility.reasons[reason] ?? 0) + 1;
      }
      if (input.dryRun) return Result.ok(result);
      for (const thread of selected) {
        if (input.abortSignal?.aborted) break;
        const written = yield* Result.await(this.refreshThread(thread, input.abortSignal));
        if (written) result.summarized += 1;
      }
      return Result.ok(result);
    }, this);
  }

  private prepareRefresh(
    input: ConversationThreadRunSummarizationInput,
  ): ResultType<ConversationThreadRunSummarizationResult, NativeStoreError> {
    return Result.gen(function* () {
      const result = emptyNativeSummaryResult(input.dryRun);
      if (!input.clear) return Result.ok(result);
      const cleared = yield* this.params.summaries.clear(input);
      if (!input.dryRun) return Result.ok({ ...result, cleared: cleared.length });
      return Result.ok({
        ...result,
        eligible: cleared.length,
        eligibleTotal: cleared.length,
        eligibility: { summary: cleared.length, embeddingOnly: 0, reasons: {} },
        threadIds: cleared,
      });
    }, this);
  }

  private async refreshThread(
    thread: NativeThreadRecord,
    abortSignal?: AbortSignal,
  ): Promise<ResultType<boolean, NativeSummaryRefreshError>> {
    return Result.gen(async function* () {
      const first = yield* this.params.search.readThread(thread.starterId, thread.id, {
        limit: INPUT_MESSAGE_LIMIT / 2,
      });
      const content = yield* this.params.search.readThread(thread.starterId, thread.id, {
        limit: INPUT_MESSAGE_LIMIT / 2,
        offset: Math.max(first.messages.length, first.total - INPUT_MESSAGE_LIMIT / 2),
      });
      if (first.thread.revision !== thread.revision || content.thread.revision !== thread.revision)
        return Result.ok(false);
      const messages = boundedMessages([...first.messages, ...content.messages]);
      const summary = yield* Result.await(
        (this.params.summarize ?? defaultSummarizer)({
          cfg: this.params.getConfig(),
          abortSignal,
          threadId: thread.id,
          previousSummary: null,
          promptContext: null,
          messages: messages.map((message) => ({
            channelId: thread.id,
            messageId: message.messageId,
            ordinal: message.ordinal,
            userId: message.authorId,
            text: message.text,
            ts: message.createdAt,
            attachments: [],
          })),
          omittedMessages: Math.max(0, content.total - messages.length),
        }),
      );
      if (abortSignal?.aborted) return Result.ok(false);
      return this.params.summaries.put({
        threadId: thread.id,
        historyGeneration: content.thread.historyGeneration,
        contentRevision: content.thread.revision,
        generatedAt: (this.params.now ?? Date.now)(),
        messageCount: content.total,
        summary: normalizeNativeSummary(summary),
      });
    }, this);
  }
}
