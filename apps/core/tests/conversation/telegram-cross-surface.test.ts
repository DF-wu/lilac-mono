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
import { ConversationThreadStore } from "../../src/conversation/thread-store";
import {
  ConversationThreadService,
  createConversationThreadToolService,
} from "../../src/conversation/thread-service";
import {
  threadSummarizationHydrationRequestSchema,
  threadSummarizationWorkerRequestSchema,
} from "../../src/conversation/thread-summarization-worker-protocol";
import { ConversationThread } from "../../src/tool-server/tools/conversation-thread";
import { conversationSurfaceOfRequestClient } from "../../src/surface/bridge/bus-agent-runner";

const CHAT = "-100123";
const TOPIC = `${CHAT}:7`;
const OTHER_CHAT = "-100999";

let dir: string;
let telegram: TelegramSurfaceStore;
let discord: DiscordSearchStore;
let index: ConversationThreadStore;
let service: ConversationThreadService;
let now: number;
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
  telegram = new TelegramSurfaceStore(path.join(dir, "telegram.db"));
  discord = new DiscordSearchStore(path.join(dir, "search.db"));
  index = new ConversationThreadStore(path.join(dir, "search.db"), {
    telegramDbPath: path.join(dir, "telegram.db"),
    telegramBotName: "lilac",
    mainAgentUserNames: ["lilac"],
  });
  cfg = parseCoreConfigV2ToUniversal({
    configVersion: 2,
    surface: {
      discord: { botName: "lilac", allowedChannelIds: ["c1"] },
      telegram: { enabled: true, token: "test-token", botName: "lilac", allowedChatIds: [CHAT] },
    },
  });
  service = new ConversationThreadService({
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
    queryAboutnessSummarizer: async () => aboutness,
    autoInjectQueryPlanner: async () => ({ searches: [{ queries: ["deployment"], aboutness }] }),
  });
});
afterEach(async () => {
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
        updated_at: now + 3_000,
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
