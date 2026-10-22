import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Result } from "better-result";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";

import { DiscordSearchStore } from "../../src/surface/store/discord-search-store";
import { TelegramSurfaceStore } from "../../src/surface/telegram/store/telegram-surface-store";
import {
  installTelegramConversationSource,
  readTelegramConversationAttachments,
  readTelegramConversationMessages,
  readTelegramConversationThreads,
} from "../../src/surface/telegram/telegram-conversation-source";
import { ConversationThreadSearchPool } from "../../src/conversation/thread-search-pool";
import {
  ConversationThreadStore,
  type ConversationThreadSearchHit,
} from "../../src/conversation/thread-store";
import {
  ConversationThreadService,
  createConversationThreadToolService,
} from "../../src/conversation/thread-service";
import {
  threadSummarizationHydrationRequestSchema,
  threadSummarizationWorkerRequestSchema,
} from "../../src/conversation/thread-summarization-worker-protocol";
import { ConversationThread } from "../../src/tool-server/tools/conversation-thread";
import {
  maybeBuildAutoInjectedThreadSearchMessages,
  conversationSurfaceOfRequestClient,
} from "../../src/surface/bridge/bus-agent-runner";

const CHAT = "-100123";
const TOPIC = `${CHAT}:7`;
const OTHER_CHAT = "-100999";
const TELEGRAM_BOT_NAME = "telegram-memory";

let dir: string;
let telegram: TelegramSurfaceStore;
let discord: DiscordSearchStore;
let index: ConversationThreadStore;
let service: ConversationThreadService;
let pool: ConversationThreadSearchPool;
let now: number;
let afterRecall: (() => void) | undefined;
let cfg: ReturnType<typeof parseCoreConfigV2ToUniversal>;
const aboutness = {
  domains: [],
  situations: [],
  targets: [],
  entities: [],
  userWouldAskForThisAs: [],
  intentSummary: "deployment",
};

function documentRaw(messageId: string) {
  return JSON.stringify({
    telegram: {
      chatId: CHAT,
      messageId,
      message: {
        message_id: Number(messageId),
        date: Math.floor(now / 1000),
        chat: { id: Number(CHAT), type: "supergroup" },
        document: {
          file_id: "doc-file",
          file_unique_id: "u1",
          file_name: "plan.pdf",
          mime_type: "application/pdf",
          file_size: 1234,
        },
        photo: [
          { file_id: "photo-small", file_unique_id: "p1", width: 90, height: 90, file_size: 10 },
          { file_id: "photo-large", file_unique_id: "p2", width: 800, height: 800, file_size: 999 },
        ],
      },
    },
  });
}

function upsert(input: {
  sessionId: string;
  messageId: string;
  text: string;
  offsetMs?: number;
  fromBot?: boolean;
  userId?: string;
  userName?: string;
  rawJson?: string;
  editedTs?: number;
}) {
  const chatId = input.sessionId.split(":")[0]!;
  const threadId = input.sessionId.split(":")[1];
  telegram.upsertSession({
    sessionId: input.sessionId,
    chatId,
    ...(threadId ? { threadId } : {}),
    kind: threadId ? "thread" : "channel",
    updatedTs: now,
  });
  telegram.upsertMessage({
    sessionId: input.sessionId,
    messageId: input.messageId,
    chatId,
    ...(threadId ? { threadId } : {}),
    userId: input.userId ?? (input.fromBot ? "bot" : "alice"),
    userName: input.userName ?? (input.fromBot ? "lilac_bot" : "alice"),
    text: input.text,
    ts: now + (input.offsetMs ?? 0),
    fromBot: input.fromBot ?? false,
    editedTs: input.editedTs,
    ...(input.rawJson ? { rawJson: input.rawJson } : {}),
  });
}

function seedChat(sessionId = CHAT) {
  upsert({ sessionId, messageId: "1", text: "deployment telegram" });
  upsert({ sessionId, messageId: "2", text: "deployment answer", offsetMs: 1_000, fromBot: true });
  return `telegram:${sessionId}`;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "lilac-telegram-cross-surface-"));
  now = Date.now() - 7_200_000;
  afterRecall = undefined;
  telegram = new TelegramSurfaceStore(path.join(dir, "telegram.db"));
  discord = new DiscordSearchStore(path.join(dir, "search.db"));
  index = new ConversationThreadStore(path.join(dir, "search.db"), {
    telegramDbPath: path.join(dir, "telegram.db"),
    telegramBotName: TELEGRAM_BOT_NAME,
    mainAgentUserNames: ["lilac", TELEGRAM_BOT_NAME],
  });
  cfg = parseCoreConfigV2ToUniversal({
    configVersion: 2,
    surface: {
      discord: { botName: "lilac", allowedChannelIds: ["c1"] },
      telegram: {
        enabled: true,
        token: "test-token",
        botName: TELEGRAM_BOT_NAME,
        allowedChatIds: [CHAT],
      },
    },
  });
  pool = new ConversationThreadSearchPool({
    searchDbPath: path.join(dir, "search.db"),
    telegramDbPath: path.join(dir, "telegram.db"),
    telegramBotName: TELEGRAM_BOT_NAME,
    botName: "lilac",
  });
  service = new ConversationThreadService({
    searchPool: pool,
    store: index,
    getConfig: async () => cfg,
    summarizer: async (input) => ({
      title: "deployment",
      brief: input.messages.map((m) => m.text).join(" "),
      topics: ["deployment"],
    }),
    attachmentHydrator: async () => Result.ok([]),
    getEmbeddingAdapter: async () => ({
      modelId: "test",
      dimensions: 2,
      embed: async () => new Float32Array([1, 0]),
    }),
    queryAboutnessSummarizer: async () => {
      afterRecall?.();
      afterRecall = undefined;
      return aboutness;
    },
    autoInjectQueryPlanner: async () => ({ searches: [{ queries: ["deployment"], aboutness }] }),
  });
});
afterEach(async () => {
  pool.close();
  index.close();
  discord.close();
  telegram.close();
  await rm(dir, { recursive: true, force: true });
});

describe("telegram conversation source", () => {
  test("projects sessions as threads with ordered messages, bot rows, and attachment metadata", () => {
    seedChat();
    upsert({
      sessionId: CHAT,
      messageId: "3",
      text: "with files",
      offsetMs: 2_000,
      rawJson: documentRaw("3"),
      editedTs: now + 6_000,
    });
    upsert({ sessionId: CHAT, messageId: "4", text: "gone", offsetMs: 3_000 });
    telegram.markDeleted({ sessionId: CHAT, messageId: "4" });
    seedChat(TOPIC);

    const db = new Database(":memory:");
    try {
      installTelegramConversationSource(db, {
        databasePath: path.join(dir, "telegram.db"),
        botName: "lilac",
      });
      const threads = readTelegramConversationThreads(db).unwrap();
      expect(threads.map((thread) => thread.id).sort()).toEqual([CHAT, TOPIC]);
      expect(threads.find((thread) => thread.id === CHAT)).toMatchObject({
        chat_id: CHAT,
        updated_at: now + 6_000,
      });

      const messages = readTelegramConversationMessages(db, CHAT).unwrap();
      expect(messages.map((message) => message.message_id)).toEqual(["1", "2", "3"]);
      expect(messages.map((message) => message.ordinal)).toEqual([0, 1, 2]);
      expect(messages[1]).toMatchObject({ user_id: "bot", user_name: "lilac" });

      const attachments = readTelegramConversationAttachments(db, CHAT, "3").unwrap();
      expect(attachments).toEqual([
        { id: "photo-large", filename: "photo", mimeType: "image/jpeg", size: 999 },
        { id: "doc-file", filename: "plan.pdf", mimeType: "application/pdf", size: 1234 },
      ]);
      expect(readTelegramConversationAttachments(db, CHAT, "1").unwrap()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("materializes one thread per session and rebuilds it when the revision changes", () => {
    const ref = seedChat();
    index.refreshTelegramThreads();
    const first = index.getThread(ref);
    expect(first?.kind).toBe("telegram_thread");
    expect(first?.summary_input_hash?.startsWith("telegram:")).toBe(true);
    expect(index.listMessages(ref).map((message) => message.surface)).toEqual([
      "telegram",
      "telegram",
    ]);

    upsert({
      sessionId: CHAT,
      messageId: "3",
      text: "more",
      offsetMs: 2_000,
      rawJson: documentRaw("3"),
    });
    index.refreshTelegramThreads();
    const second = index.getThread(ref);
    expect(second?.summary_input_hash).not.toBe(first?.summary_input_hash);
    expect(index.countThreadMessages(ref)).toBe(3);
    expect(index.listMessages(ref).at(-1)?.attachments).toEqual([
      { id: "photo-large", filename: "photo", mimeType: "image/jpeg", size: 999 },
      { id: "doc-file", filename: "plan.pdf", mimeType: "application/pdf", size: 1234 },
    ]);

    for (const id of ["1", "2", "3"]) telegram.markDeleted({ sessionId: CHAT, messageId: id });
    index.refreshTelegramThreads();
    expect(index.getThread(ref)).toBeNull();
  });

  test("same-second content edits rebuild the thread with a bounded retained revision", () => {
    const ref = seedChat();
    const editedTs = Math.floor((now + 5_000) / 1_000) * 1_000;
    upsert({ sessionId: CHAT, messageId: "1", text: "first edit", editedTs });
    index.refreshTelegramThreads();
    const first = index.getThread(ref)!;
    const text = "deployment replacement ".repeat(40);
    upsert({ sessionId: CHAT, messageId: "1", text, editedTs });
    index.refreshTelegramThreads();
    const second = index.getThread(ref)!;
    expect(second.summary_input_hash).not.toBe(first.summary_input_hash);
    expect(second.summary_input_hash!.length).toBeLessThan(128);
    expect(index.listMessages(ref)[0]?.text).toBe(text);

    upsert({ sessionId: CHAT, messageId: "1", text, editedTs });
    index.refreshTelegramThreads();
    expect(index.getThread(ref)?.summary_input_hash).toBe(second.summary_input_hash);
  });

  test("attachment metadata changes rebuild the thread without changed text or timestamps", () => {
    const ref = seedChat();
    upsert({ sessionId: CHAT, messageId: "3", text: "with files", rawJson: documentRaw("3") });
    index.refreshTelegramThreads();
    const originalRevision = index.getThread(ref)?.summary_input_hash;

    upsert({
      sessionId: CHAT,
      messageId: "3",
      text: "with files",
      rawJson: documentRaw("3").replace("doc-file", "replacement-file"),
    });
    index.refreshTelegramThreads();
    expect(index.getThread(ref)?.summary_input_hash).not.toBe(originalRevision);
    expect(
      index.listMessages(ref).find((message) => message.messageId === "3")?.attachments,
    ).toContainEqual({
      id: "replacement-file",
      filename: "plan.pdf",
      mimeType: "application/pdf",
      size: 1234,
    });
  });

  test("edits delay summarization until the quiet period has elapsed", async () => {
    const ref = seedChat();
    expect((await service.runSummarization({ now: Date.now() })).summarized).toBe(1);
    const editedTs = Math.floor(Date.now() / 1_000) * 1_000;
    upsert({ sessionId: CHAT, messageId: "1", text: "recent deployment edit", editedTs });

    expect((await service.runSummarization({ now: editedTs + 3_600_000 - 1 })).eligible).toBe(0);
    expect(index.getThread(ref)).toMatchObject({ updated_at: editedTs, end_ts: editedTs });
    expect((await service.runSummarization({ now: editedTs + 3_600_000 })).summarized).toBe(1);
    expect(index.getSummary(ref).unwrap()?.brief).toContain("recent deployment edit");
  });

  test("search, read, and metadata follow the chat allowlist and label the surface", async () => {
    const chat = seedChat();
    const topic = seedChat(TOPIC);
    const denied = seedChat(OTHER_CHAT);
    const refreshed = await service.runSummarization({ now: Date.now() });
    expect(refreshed.failed).toBe(0);
    expect(refreshed.summarized).toBe(3);

    const all = (await service.search({ query: "deployment", mode: "lexical" })).unwrap();
    expect(all.results.map((hit) => hit.threadId).sort()).toEqual([chat, topic].sort());
    expect(all.results.every((hit) => hit.surface === "telegram")).toBe(true);
    expect(all.results[0]?.session).toBeUndefined();

    const verbose = (
      await service.search({ query: "deployment", mode: "lexical", verbose: true })
    ).unwrap();
    expect(verbose.results[0]?.session?.platform).toBe("telegram");

    const bySurface = (
      await service.search({ query: "deployment", mode: "lexical", surface: "telegram" })
    ).unwrap();
    expect(bySurface.results.length).toBe(2);
    expect(
      (await service.search({ query: "deployment", mode: "lexical", surface: "discord" })).unwrap()
        .results,
    ).toEqual([]);

    const bySession = (
      await service.search({ query: "deployment", mode: "lexical", sessionId: topic })
    ).unwrap();
    expect(bySession.results.map((hit) => hit.threadId)).toEqual([topic]);

    const byParticipant = (
      await service.search({
        query: "deployment",
        mode: "lexical",
        participantIdsAny: ["alice"],
        participantSurface: "telegram",
      })
    ).unwrap();
    expect(byParticipant.results.map((hit) => hit.threadId).sort()).toEqual([chat, topic].sort());
    const fromDiscord = (
      await service.search({
        query: "deployment",
        mode: "lexical",
        participantIdsAny: ["alice"],
        participantSurface: "discord",
      })
    ).unwrap();
    expect(fromDiscord.results).toEqual([]);

    const read = (await service.read({ threadId: chat })).unwrap();
    expect(read.thread).toMatchObject({ surface: "telegram", session: { platform: "telegram" } });
    expect(read.messages.map((message) => message.content)).toEqual([
      "deployment telegram",
      "deployment answer",
    ]);
    expect((await service.read({ threadId: denied })).isErr()).toBe(true);
    expect((await service.metadata({ threadIds: [chat, denied] })).isErr()).toBe(true);

    cfg.surface.telegram.allowedChatIds = [];
    expect(
      (await service.search({ query: "deployment", mode: "lexical" })).unwrap().results,
    ).toEqual([]);
    expect((await service.read({ threadId: chat })).isErr()).toBe(true);
    expect(await service.getAutoInjectRankingCorpusDocuments()).toEqual([]);
  });

  test("the Jev shortlist follows the chat allowlist and refreshes deleted sessions", async () => {
    const chat = seedChat();
    seedChat(OTHER_CHAT);
    const refreshed = await service.runSummarization({ now: Date.now() });
    expect(refreshed.summarized).toBe(2);

    const shortlist = (
      await service.shortlistAutoInjectCandidates({
        text: "deployment",
        limit: 5,
        semanticFallback: false,
      })
    ).unwrap();
    expect(shortlist.source).toBe("lexical");
    expect(shortlist.results.map((hit) => hit.threadId)).toEqual([chat]);
    expect(shortlist.results[0]?.surface).toBe("telegram");

    for (const id of ["1", "2"]) telegram.markDeleted({ sessionId: CHAT, messageId: id });
    const afterDelete = (
      await service.shortlistAutoInjectCandidates({
        text: "deployment",
        limit: 5,
        semanticFallback: false,
      })
    ).unwrap();
    expect(afterDelete.results).toEqual([]);
  });

  test("the conversation.thread tool accepts the telegram surface", async () => {
    seedChat();
    await service.runSummarization({ now: Date.now() });
    const tool = new ConversationThread({ service: createConversationThreadToolService(service) });
    const results = (
      await tool.call("conversation.thread.search", {
        query: "deployment",
        mode: "lexical",
        surface: "telegram",
      })
    ).unwrap();
    expect(results).toMatchObject({
      results: [{ surface: "telegram", threadId: `telegram:${CHAT}`, title: "deployment" }],
    });
  });
});

describe("telegram conversation memory plumbing", () => {
  test("worker protocol carries the Telegram source and surface", () => {
    expect(
      threadSummarizationWorkerRequestSchema.safeParse({
        id: "job",
        input: {},
        searchDbPath: "/tmp/search.db",
        telegramDbPath: "/tmp/telegram.db",
        telegramBotName: "lilac",
      }).success,
    ).toBe(true);
    expect(
      threadSummarizationHydrationRequestSchema.safeParse({
        type: "hydrate-discord-attachments",
        id: "hydrate",
        refs: [{ surface: "telegram", channelId: CHAT, messageId: "1" }],
      }).success,
    ).toBe(true);
  });

  test("request clients map to the surface used for recall", () => {
    expect(conversationSurfaceOfRequestClient("telegram")).toBe("telegram");
    expect(conversationSurfaceOfRequestClient("native")).toBe("native");
    expect(conversationSurfaceOfRequestClient("discord")).toBe("discord");
    expect(conversationSurfaceOfRequestClient("github")).toBe("discord");
  });
});

describe("Telegram search through the actual worker pool", () => {
  test("concurrent refreshes across three SQLite workers preserve pool usability", async () => {
    // Initialize all three connections before changing the source, so each worker must
    // rebuild the same index rather than seeing it already materialized at startup.
    const initial = await Promise.all(
      Array.from({ length: 3 }, () => pool.strings({ type: "prepare" })),
    );
    expect(initial).toEqual([[], [], []]);

    const sessions = Array.from({ length: 150 }, (_, i) => `${CHAT}:${i + 1}`);
    const threadIds = sessions.map((sessionId) => seedChat(sessionId)).sort();
    const allowlist = { channelIds: [], guildIds: [], telegramChatIds: [CHAT] };
    const prepared = Array.from({ length: 3 }, () => pool.strings({ type: "prepare", allowlist }));
    const searched = Array.from({ length: 3 }, () =>
      pool.hits({ type: "lexical", query: "deployment", allowlist }),
    );
    const [preparedResults, searchResults] = await Promise.all([
      Promise.all(prepared),
      Promise.all(searched),
    ]);
    for (const ids of preparedResults) expect(ids.sort()).toEqual(threadIds);
    // Unsummarized threads are eligible for preparation but have no lexical facets yet.
    for (const result of searchResults) expect(result.unwrap()).toEqual([]);

    const target = `telegram:${sessions[0]}`;
    const summarized = await service.runSummarization({ threadId: target, now: Date.now() });
    expect(summarized.failed).toBe(0);
    expect(summarized.summarized).toBe(1);
    expect(index.listMessages(target)[1]?.userName).toBe(TELEGRAM_BOT_NAME);
    const subsequent = await Promise.all(
      Array.from({ length: 3 }, () =>
        pool.hits({ type: "lexical", query: "deployment", allowlist }),
      ),
    );
    for (const result of subsequent) {
      const hits = result.unwrap();
      expect(hits.map((hit) => hit.threadId)).toEqual([target]);
      expect(hits[0]?.messageCount).toBe(2);
    }
    expect((await pool.strings({ type: "prepare", allowlist })).sort()).toEqual(threadIds);
  });

  test("semantic, hybrid and automatic recall include only allowlisted chats and honor revocation", async () => {
    const chat = seedChat();
    seedChat(OTHER_CHAT);
    expect((await service.runSummarization({ now: Date.now() })).summarized).toBe(2);
    expect(index.isVectorSearchAvailable()).toBe(true);
    for (const mode of ["lexical", "semantic", "hybrid"] as const) {
      const result = (
        await service.search({
          query: "deployment",
          mode,
          surface: "telegram",
          queryAboutness: aboutness,
        })
      ).unwrap();
      expect(result.results.map((hit) => hit.threadId)).toEqual([chat]);
    }
    const shortlist = (
      await service.shortlistAutoInjectCandidates({
        text: "deployment",
        semanticFallback: true,
        limit: 5,
        participantSurface: "telegram",
        participantIdsAny: ["alice"],
      })
    ).unwrap();
    expect(shortlist.source).toBe("hybrid");
    expect(shortlist.results.map((hit) => hit.threadId)).toEqual([chat]);
    cfg.conversation.thread.autoInject.enabled = true;
    cfg.conversation.thread.autoInject.minTextUnits = 1;
    cfg.conversation.thread.autoInject.expansionMinConfidence = 0;
    const recall = () =>
      maybeBuildAutoInjectedThreadSearchMessages({
        cfg,
        surface: "telegram",
        conversationThreads: createConversationThreadToolService(service),
        requestId: crypto.randomUUID(),
        userMessages: [{ role: "user", content: "Please recall our deployment discussion" }],
        publishToolStatus: async () => {},
        onError: (_message, error) => {
          throw new Error(JSON.stringify(error));
        },
      });
    expect(JSON.stringify(await recall())).toContain(chat);
    cfg.surface.telegram.allowedChatIds = [];
    for (const mode of ["lexical", "semantic", "hybrid"] as const)
      expect(
        (await service.search({ query: "deployment", mode, queryAboutness: aboutness })).unwrap()
          .results,
      ).toEqual([]);
    expect(
      (
        await service.shortlistAutoInjectCandidates({
          text: "deployment",
          semanticFallback: true,
          limit: 5,
        })
      ).unwrap().results,
    ).toEqual([]);
    expect(await service.getAutoInjectRankingCorpusDocuments()).toEqual([]);
    expect(await recall()).toEqual([]);
  });

  test("service rechecks permissions and source revisions after recall before publishing worker hits", async () => {
    seedChat();
    seedChat(TOPIC);
    await service.runSummarization({ now: Date.now() });
    afterRecall = () => {
      cfg.surface.telegram.allowedChatIds = [];
    };
    expect(
      (await service.search({ query: "deployment", mode: "hybrid" })).unwrap().results,
    ).toEqual([]);
    cfg.surface.telegram.allowedChatIds = [CHAT];
    afterRecall = () => {
      for (const sessionId of [CHAT, TOPIC])
        upsert({ sessionId, messageId: "1", text: "replacement", editedTs: now + 5_000 });
    };
    expect(
      (await service.search({ query: "deployment", mode: "hybrid" })).unwrap().results,
    ).toEqual([]);
    await service.runSummarization({ now: Date.now() });
    expect(
      (await service.search({ query: "replacement", mode: "hybrid" })).unwrap().results,
    ).toHaveLength(2);
    afterRecall = () => {
      for (const sessionId of [CHAT, TOPIC]) {
        telegram.markDeleted({ sessionId, messageId: "1" });
        telegram.markDeleted({ sessionId, messageId: "2" });
      }
    };
    expect(
      (await service.search({ query: "replacement", mode: "hybrid" })).unwrap().results,
    ).toEqual([]);
  });

  test("current-hit checks reject Telegram revisions after edits, partial deletions and complete deletions", async () => {
    const chat = seedChat();
    upsert({ sessionId: CHAT, messageId: "3", text: "deployment retained", offsetMs: 2_000 });
    await service.runSummarization({ now: Date.now() });
    const allowlist = { channelIds: [], guildIds: [], telegramChatIds: [CHAT] };
    const current = async (hits: readonly ConversationThreadSearchHit[]) =>
      (await pool.hits({ type: "current", hits, allowlist })).unwrap();
    const original = (
      await pool.hits({ type: "lexical", query: "deployment", allowlist })
    ).unwrap();
    expect(original.map((hit) => hit.threadId)).toEqual([chat]);
    expect((await current(original)).map((hit) => hit.threadId)).toEqual([chat]);
    upsert({ sessionId: CHAT, messageId: "1", text: "replacement", editedTs: now + 5_000 });
    expect(await current(original)).toEqual([]);
    await service.runSummarization({ now: Date.now() });
    const edited = (await pool.hits({ type: "lexical", query: "replacement", allowlist })).unwrap();
    expect(edited).toHaveLength(1);
    expect(edited[0]?.sourceRevision).not.toBe(original[0]?.sourceRevision);
    upsert({ sessionId: CHAT, messageId: "1", text: "second replacement", editedTs: now + 5_000 });
    expect(await current(edited)).toEqual([]);
    await service.runSummarization({ now: Date.now() });
    const secondEdit = (await pool.hits({ type: "lexical", query: "second", allowlist })).unwrap();
    expect(secondEdit).toHaveLength(1);
    expect(secondEdit[0]?.sourceRevision).not.toBe(edited[0]?.sourceRevision);
    telegram.markDeleted({ sessionId: CHAT, messageId: "1" });
    expect(await current(secondEdit)).toEqual([]);
    expect(
      (await service.search({ query: "replacement", mode: "lexical" })).unwrap().results,
    ).toEqual([]);
    await service.runSummarization({ now: Date.now() });
    const remaining = (
      await pool.hits({ type: "lexical", query: "deployment", allowlist })
    ).unwrap();
    expect(remaining).toHaveLength(1);
    telegram.markDeleted({ sessionId: CHAT, messageId: "2" });
    telegram.markDeleted({ sessionId: CHAT, messageId: "3" });
    expect(await current(remaining)).toEqual([]);
    expect(await pool.strings({ type: "prepare", allowlist })).toEqual([]);
  });

  test("candidate SQL binds both participant filters and isolates equal user, channel and message IDs by platform", async () => {
    const chat = seedChat();
    cfg.surface.discord.allowedChannelIds = [CHAT];
    for (const [messageId, userId] of [
      ["1", "alice"],
      ["2", "bot"],
    ])
      discord.upsertMessages([
        {
          ref: { platform: "discord", channelId: CHAT, messageId: messageId! },
          session: { platform: "discord", channelId: CHAT },
          userId: userId!,
          userName: userId === "bot" ? "lilac" : "alice",
          text: "deployment discord",
          ts: now,
          attachments: [],
        },
      ]);
    index.refreshInferredChannel({ channelId: CHAT });
    await service.runSummarization({ now: Date.now() });
    for (const participantSurface of ["discord", "telegram"] as const) {
      for (const mode of ["lexical", "semantic"] as const) {
        const result = (
          await service.search({
            query: "deployment",
            mode,
            participantId: "alice",
            participantIdsAny: ["alice"],
            participantSurface,
            beforeTs: now + 2_000,
            afterTs: now - 1,
            queryAboutness: aboutness,
          })
        ).unwrap();
        expect(result.results).toHaveLength(1);
        expect(result.results[0]?.surface).toBe(participantSurface);
        if (participantSurface === "telegram") expect(result.results[0]?.threadId).toBe(chat);
      }
    }
    // An identically addressed Discord row must not satisfy a Telegram participant lookup.
    const db = new Database(path.join(dir, "telegram.db"));
    db.run("UPDATE telegram_messages SET user_id='telegram-only' WHERE message_id='1'");
    db.close();
    expect(
      (
        await service.search({
          query: "deployment",
          mode: "lexical",
          surface: "telegram",
          participantId: "alice",
          queryAboutness: aboutness,
        })
      ).unwrap().results,
    ).toEqual([]);
  });
});
