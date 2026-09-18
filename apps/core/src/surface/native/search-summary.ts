import { Result, type Result as ResultType } from "better-result";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import {
  defaultSummarizer,
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
    input: { limit?: number; abortSignal?: AbortSignal } = {},
  ): Promise<ResultType<{ refreshed: number; discarded: number }, NativeSummaryRefreshError>> {
    const self = this;
    return Result.gen(async function* () {
      const candidates = yield* self.params.summaries.candidates(input.limit);
      let refreshed = 0;
      let discarded = 0;
      for (const thread of candidates) {
        if (input.abortSignal?.aborted) break;
        const written = yield* Result.await(self.refreshThread(thread, input.abortSignal));
        if (written) {
          refreshed += 1;
          continue;
        }
        discarded += 1;
      }
      return Result.ok({ refreshed, discarded });
    });
  }

  private async refreshThread(
    thread: NativeThreadRecord,
    abortSignal?: AbortSignal,
  ): Promise<ResultType<boolean, NativeSummaryRefreshError>> {
    const self = this;
    return Result.gen(async function* () {
      const first = yield* self.params.search.readThread(thread.starterId, thread.id, {
        limit: INPUT_MESSAGE_LIMIT / 2,
      });
      const content = yield* self.params.search.readThread(thread.starterId, thread.id, {
        limit: INPUT_MESSAGE_LIMIT / 2,
        offset: Math.max(first.messages.length, first.total - INPUT_MESSAGE_LIMIT / 2),
      });
      const previous = yield* self.params.summaries.get(thread.id);
      const messages = boundedMessages([...first.messages, ...content.messages]);
      const summary = yield* Result.await(
        (self.params.summarize ?? defaultSummarizer)({
          cfg: self.params.getConfig(),
          abortSignal,
          threadId: thread.id,
          previousSummary: previous?.summary ?? null,
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
      return self.params.summaries.put({
        threadId: thread.id,
        historyGeneration: content.thread.historyGeneration,
        contentRevision: content.thread.revision,
        generatedAt: (self.params.now ?? Date.now)(),
        messageCount: content.total,
        summary: normalizeNativeSummary(summary),
      });
    });
  }
}
