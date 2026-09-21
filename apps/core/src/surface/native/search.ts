import { Result } from "better-result";
import type {
  ConversationThreadToolService,
  ConversationThreadSearchResult,
  ConversationThreadReadOutput,
  ConversationThreadMetadataOutput,
} from "../../conversation/thread-service";
import {
  resolveTimeWindow,
  compareGroups,
  stripVerboseGroup,
  type DiscoveryService,
  type DiscoverySearchInput,
  type DiscoverySearchResult,
} from "../../discovery/discovery-service";
import type { RequestContext } from "../../tool-server/types";
import { NativeStore, type NativeStoreResult, type NativeStoreError } from "./store";
import { NativeSearchStore, type NativeSearchMessage } from "./store-search";
import type { NativeSummaryStore } from "./store-search-summary";
import { nativeFailure } from "./errors";

type SearchHit = {
  threadId: string;
  turnId?: string;
  title: string;
  excerpt: string;
  surface: "native";
};
type ThreadSearchInput = Parameters<ConversationThreadToolService["search"]>[0];

function discoveryGroupKey(
  groupBy: "none" | "source" | "origin",
  row: NativeSearchMessage,
): string {
  if (groupBy === "none") return `native:${row.threadId}:${row.messageId}`;
  if (groupBy === "source") return "conversation";
  return `native:${row.threadId}`;
}

function excerpt(text: string, query = ""): string {
  const index = text.toLowerCase().indexOf(query.toLowerCase().split(/\s+/u)[0] ?? "");
  const start = Math.max(0, index - 100);
  return `${start > 0 ? "…" : ""}${text.slice(start, start + 1800)}${text.length > start + 1800 ? "…" : ""}`;
}

function offsetCursor(cursor?: string): NativeStoreResult<number> {
  if (!cursor) return Result.ok(0);
  const offset = Number(cursor);
  if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(offset) || offset < 0)
    return Result.err(nativeFailure("invalid", "Invalid search cursor"));
  return Result.ok(offset);
}

function metadata(page: {
  thread: { id: string; title: string; createdAt: number; updatedAt: number };
  messages: NativeSearchMessage[];
  total: number;
  startMessageId: string | null;
  endMessageId: string | null;
}): ConversationThreadReadOutput["thread"] {
  return {
    threadId: page.thread.id,
    title: page.thread.title,
    brief: excerpt(page.messages[0]?.text ?? ""),
    session: { platform: "native", channelId: page.thread.id },
    anchors: { startMessageId: page.startMessageId ?? "", endMessageId: page.endMessageId ?? "" },
    timeRange: {
      start: new Date(page.thread.createdAt).toISOString(),
      end: new Date(page.thread.updatedAt).toISOString(),
    },
    messageCount: page.total,
  };
}

export function nativeSearchFailureToHost(error: NativeStoreError): never {
  throw error;
}

export function resolveNativeSearchToHost<T>(result: NativeStoreResult<T>): T {
  const settle = result.match({
    ok: (value) => () => value,
    err: (error) => () => nativeSearchFailureToHost(error),
  });
  return settle();
}

export class NativeSearchService {
  constructor(
    private readonly params: {
      store: NativeStore;
      searchStore: NativeSearchStore;
      planner?: Pick<ConversationThreadToolService, "planAutoInjectSearch">;
      summaries?: NativeSummaryStore;
      externalThreads?: ConversationThreadToolService;
    },
  ) {}

  forThread(threadId: string): ConversationThreadToolService {
    const service = () => this.forUser(resolveNativeSearchToHost(this.starter(threadId)));
    return {
      search: (input) => service().search(input),
      metadata: (input) => service().metadata(input),
      read: (input) => service().read(input),
      runSummarization: (input) => service().runSummarization(input),
      planAutoInjectSearch: (input) => service().planAutoInjectSearch(input),
    };
  }

  forUser(userId: string): ConversationThreadToolService {
    const isOwner = () =>
      resolveNativeSearchToHost(this.params.store.getUser(userId)).role === "owner";
    const local = (threadId: string) =>
      resolveNativeSearchToHost(
        this.params.store
          .getThreadRecord(threadId)
          .map(() => true)
          .tryRecover((error) =>
            error._tag === "NativeStoreFailure" && error.code === "not-found"
              ? Result.ok(false)
              : Result.err(error),
          ),
      );
    return {
      search: async (input) => {
        const native = resolveNativeSearchToHost(this.conversationSearch(userId, input));
        if (!isOwner() || !this.params.externalThreads) return native;
        const external = await this.params.externalThreads.search(input);
        const results = [...native.results, ...external.results].slice(0, input.limit ?? 5);
        return { meta: { ...external.meta, count: results.length }, results };
      },
      read: async (input) => {
        if (isOwner() && this.params.externalThreads && !local(input.threadId))
          return this.params.externalThreads.read(input);
        return resolveNativeSearchToHost(this.conversationRead(userId, input));
      },
      metadata: async (input) => {
        if (!isOwner() || !this.params.externalThreads)
          return resolveNativeSearchToHost(this.conversationMetadata(userId, input));
        const nativeIds: string[] = [];
        const externalIds: string[] = [];
        for (const id of input.threadIds) (local(id) ? nativeIds : externalIds).push(id);
        const native = resolveNativeSearchToHost(
          this.conversationMetadata(userId, { threadIds: nativeIds }),
        );
        if (externalIds.length === 0) return native;
        const external = await this.params.externalThreads.metadata({ threadIds: externalIds });
        return { threads: [...native.threads, ...external.threads], missing: external.missing };
      },
      runSummarization: async () =>
        resolveNativeSearchToHost(
          Result.err(
            nativeFailure(
              "forbidden",
              "Native summary maintenance requires the owner maintenance service",
            ),
          ),
        ),
      planAutoInjectSearch: async (input) => {
        resolveNativeSearchToHost(this.params.store.getUser(userId));
        const planner = this.params.planner ?? this.params.externalThreads;
        if (planner) return planner.planAutoInjectSearch(input);
        return {
          searches: [
            {
              queries: [input.text],
              aboutness: {
                domains: [],
                situations: [],
                targets: [],
                entities: [],
                userWouldAskForThisAs: [],
                intentSummary: input.text,
              },
            },
          ],
        };
      },
    };
  }

  query(
    userId: string,
    input: { query: string; threadId?: string; cursor?: string; limit?: number },
  ): NativeStoreResult<{ items: SearchHit[]; nextCursor?: string }> {
    return Result.gen(function* () {
      const offset = yield* offsetCursor(input.cursor);
      const limit = Math.min(100, Math.max(1, input.limit ?? 30));
      const rows = yield* this.params.searchStore.searchMessages(userId, {
        ...input,
        limit: limit + 1,
        offset,
      });
      return Result.ok({
        items: rows.slice(0, limit).map((row) => ({
          threadId: row.threadId,
          turnId: row.turnId,
          title: row.title.slice(0, 512),
          excerpt: excerpt(row.text, input.query),
          surface: "native" as const,
        })),
        ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}),
      });
    }, this);
  }

  starter(threadId: string): NativeStoreResult<string> {
    return Result.gen(function* () {
      const thread = yield* this.params.store.getThreadRecord(threadId);
      yield* this.params.store.authorizeThread(thread.starterId, threadId);
      return Result.ok(thread.starterId);
    }, this);
  }

  principal(context?: RequestContext): NativeStoreResult<string> {
    if (!context?.serverOwnedRequest || context.requestInitiator?.platform !== "native")
      return Result.err(
        nativeFailure("forbidden", "Native search requires an authenticated thread origin"),
      );
    const threadId = context.requestInitiatorSessionId ?? context.sessionId;
    if (!threadId) return Result.err(nativeFailure("forbidden", "Native thread origin is missing"));
    return this.starter(threadId);
  }

  discovery(userId: string, input: DiscoverySearchInput): NativeStoreResult<DiscoverySearchResult> {
    return Result.gen(function* () {
      yield* this.params.store.getUser(userId);
      const limit = Math.min(100, Math.max(1, input.limit ?? 10));
      const surrounding = Math.min(20, Math.max(0, input.surrounding ?? 1));
      const groupBy = input.groupBy ?? "origin";
      const window = yield* resolveTimeWindow(input, Date.now()).mapError((error) =>
        nativeFailure("invalid", error.message),
      );
      const grouped = new Map<string, DiscoverySearchResult["groups"][number]>();
      if (
        (!input.platform || input.platform === "native") &&
        (!input.sources || input.sources.includes("conversation"))
      ) {
        const rows = yield* this.params.searchStore.searchMessages(userId, {
          query: input.query,
          threadId: input.sessionId,
          authorId: input.authorId,
          afterTs: window?.startTs,
          beforeTs: window?.endTs,
          direction: input.direction,
          limit: Math.min(500, limit * 8),
        });
        const matchedIds = new Set(rows.map((row) => row.messageId));
        const included = new Set<string>();
        for (const row of rows) {
          const key = discoveryGroupKey(groupBy, row);
          if (!grouped.has(key) && grouped.size >= limit) continue;
          const origin = {
            kind: "session" as const,
            platform: "native" as const,
            sessionId: row.threadId,
            label: row.title,
          };
          const group = grouped.get(key) ?? {
            key,
            ts: row.createdAt,
            score:
              1 / (21 + grouped.size) +
              0.35 * Math.exp(-Math.max(0, Date.now() - row.createdAt) / 604_800_000),
            source: "conversation" as const,
            ...(groupBy === "source" ? {} : { origin }),
            time: new Date(row.createdAt).toISOString(),
            entries: [],
          };
          const context =
            groupBy === "origin" && surrounding > 0
              ? (yield* this.params.searchStore.readThread(userId, row.threadId, {
                  offset: Math.max(0, row.ordinal - surrounding),
                  limit: surrounding * 2 + 1,
                })).messages
              : [row];
          const entries: DiscoverySearchResult["groups"][number]["entries"][number] = [];
          for (const message of context) {
            const identity = `${message.threadId}:${message.messageId}`;
            if (included.has(identity)) continue;
            included.add(identity);
            entries.push({
              kind: "message",
              matched: matchedIds.has(message.messageId),
              text: excerpt(message.text, input.query),
              time: new Date(message.createdAt).toISOString(),
              messageId: message.messageId,
              author: message.authorId,
              origin,
              ...(input.verbose ? { ts: message.createdAt } : {}),
            });
          }
          if (entries.length > 0) group.entries.push(entries);
          grouped.set(key, group);
        }
      }
      return Result.ok({
        meta: {
          query: input.query,
          sources: ["conversation" as const],
          orderBy: input.orderBy ?? "relevance",
          direction: input.direction ?? "desc",
          groupBy,
          surrounding,
          limit,
          verbose: input.verbose ?? false,
          platform: "native" as const,
          sessionId: input.sessionId,
          authorId: input.authorId,
          ...(window
            ? {
                window: {
                  startTime: new Date(window.startTs).toISOString(),
                  endTime: new Date(window.endTs).toISOString(),
                  ...(input.verbose ? { startTs: window.startTs, endTs: window.endTs } : {}),
                },
              }
            : {}),
        },
        groups: [...grouped.values()]
          .sort((a, b) =>
            compareGroups(a, b, input.orderBy ?? "relevance", input.direction ?? "desc"),
          )
          .map((group) => stripVerboseGroup(group, input.verbose ?? false)),
      });
    }, this);
  }

  async discoveryWithExternal(
    userId: string,
    input: DiscoverySearchInput,
    legacy: Pick<DiscoveryService, "searchResult">,
  ): Promise<NativeStoreResult<DiscoverySearchResult>> {
    return Result.gen(async function* () {
      const user = yield* this.params.store.getUser(userId);
      const native = yield* this.discovery(userId, { ...input, verbose: true });
      if (user.role !== "owner" || input.platform === "native")
        return Result.ok({
          ...native,
          meta: { ...native.meta, verbose: input.verbose ?? false },
          groups: native.groups.map((group) => stripVerboseGroup(group, input.verbose ?? false)),
        });
      const external = yield* Result.await(
        legacy
          .searchResult({ ...input, verbose: true })
          .then((result) =>
            result.mapError((error) =>
              nativeFailure(
                error._tag === "DiscoverySearchInputError" ? "invalid" : "sqlite",
                error.message,
              ),
            ),
          ),
      );
      const merged = new Map<string, DiscoverySearchResult["groups"][number]>();
      for (const group of [...native.groups, ...external.groups]) {
        const previous = merged.get(group.key);
        if (!previous) {
          merged.set(group.key, group);
          continue;
        }
        merged.set(group.key, {
          ...previous,
          entries: [...previous.entries, ...group.entries],
          score: Math.max(previous.score ?? 0, group.score ?? 0),
          ts: Math.max(previous.ts ?? 0, group.ts ?? 0),
        });
      }
      const groups = [...merged.values()]
        .sort((a, b) =>
          compareGroups(a, b, input.orderBy ?? "relevance", input.direction ?? "desc"),
        )
        .slice(0, input.limit ?? 10)
        .map((group) => stripVerboseGroup(group, input.verbose ?? false));
      return Result.ok({ meta: { ...external.meta, verbose: input.verbose ?? false }, groups });
    }, this);
  }

  conversationSearch(
    userId: string,
    input: ThreadSearchInput,
  ): NativeStoreResult<ConversationThreadSearchResult> {
    return Result.gen(function* () {
      const queries = typeof input.query === "string" ? [input.query] : [...input.query];
      const limit = Math.min(50, Math.max(1, input.limit ?? 5));
      const unique = new Map<string, ConversationThreadSearchResult["results"][number]>();
      for (const query of queries) {
        const summaries = this.params.summaries
          ? yield* this.params.summaries.search(userId, {
              query,
              threadId: input.sessionId,
              participantId: input.participantId,
              participantIdsAny: input.participantIdsAny,
              beforeTs: input.beforeTs,
              afterTs: input.afterTs,
              limit,
            })
          : [];
        for (const summary of summaries) {
          const thread = yield* this.params.store.authorizeThread(userId, summary.threadId);
          unique.set(summary.threadId, {
            threadId: summary.threadId,
            title: summary.summary.title,
            brief: summary.summary.brief,
            ...(input.verbose
              ? {
                  ...summary.summary,
                  messageCount: summary.messageCount,
                  session: { platform: "native" as const, channelId: summary.threadId },
                  derivedState: {
                    summarized: true,
                    stale: summary.contentRevision < thread.revision,
                  },
                }
              : {}),
          });
        }
        const rows = yield* this.params.searchStore.searchMessages(userId, {
          query,
          threadId: input.sessionId,
          authorId: input.participantId,
          beforeTs: input.beforeTs,
          afterTs: input.afterTs,
          limit: 500,
        });
        for (const row of rows) {
          if (unique.has(row.threadId)) continue;
          if (input.participantIdsAny?.length && !input.participantIdsAny.includes(row.authorId))
            continue;
          const summary = this.params.summaries
            ? yield* this.params.summaries.get(row.threadId)
            : null;
          unique.set(row.threadId, {
            threadId: row.threadId,
            title: summary?.summary.title ?? row.title,
            brief: summary?.summary.brief ?? excerpt(row.text),
            ...(input.verbose
              ? {
                  session: { platform: "native" as const, channelId: row.threadId },
                  derivedState: { summarized: summary !== null, stale: true },
                }
              : {}),
          });
        }
      }
      const results = [...unique.values()].slice(0, limit);
      return Result.ok({
        meta: {
          query: queries[0] ?? "",
          ...(queries.length > 1 ? { queries } : {}),
          mode: "lexical" as const,
          limit,
          minScore: input.minScore ?? 0,
          count: results.length,
          vectorAvailable: false,
        },
        results,
      });
    }, this);
  }

  conversationRead(
    userId: string,
    input: { threadId: string; offset?: number; limit?: number },
  ): NativeStoreResult<ConversationThreadReadOutput> {
    return Result.gen(function* () {
      const page = yield* this.params.searchStore.readThread(userId, input.threadId, input);
      const summary = this.params.summaries
        ? yield* this.params.summaries.get(input.threadId)
        : null;
      const offset = Math.max(0, input.offset ?? 0);
      const limit = Math.min(200, Math.max(1, input.limit ?? 50));
      const nextOffset = offset + page.messages.length;
      return Result.ok({
        thread: { ...metadata(page), ...summary?.summary },
        page: {
          offset,
          limit,
          total: page.total,
          hasMore: nextOffset < page.total,
          ...(nextOffset < page.total ? { nextOffset } : {}),
        },
        messages: page.messages.map((message) => ({
          ordinal: message.ordinal,
          messageId: message.messageId,
          userId: message.authorId,
          time: new Date(message.createdAt).toISOString(),
          content: message.text,
        })),
      });
    }, this);
  }

  conversationMetadata(
    userId: string,
    input: { threadIds: readonly string[] },
  ): NativeStoreResult<ConversationThreadMetadataOutput> {
    return Result.gen(function* () {
      const threads: ConversationThreadMetadataOutput["threads"] = [];
      for (const threadId of input.threadIds) {
        const page = yield* this.params.searchStore.readThread(userId, threadId, { limit: 1 });
        const summary = this.params.summaries ? yield* this.params.summaries.get(threadId) : null;
        threads.push({ ...metadata(page), ...summary?.summary });
      }
      return Result.ok({ threads, missing: [] });
    }, this);
  }
}
