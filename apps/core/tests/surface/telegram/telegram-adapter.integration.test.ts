import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Message, Update } from "grammy/types";

import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils/core-config/v2";
import type { CoreConfig } from "@stanley2058/lilac-utils";

import { SurfaceMessageNotFoundError } from "../../../src/surface/adapter";
import {
  buildTelegramActionKeyboard,
  TelegramAdapter,
} from "../../../src/surface/telegram/telegram-adapter";
import { buildTelegramCancelCallbackData } from "../../../src/surface/telegram/output/telegram-output-stream";
import type { AdapterEvent } from "../../../src/surface/events";
import { FakeBotApiServer } from "./fake-bot-api-server";
import { BOT_USER_ID, BOT_USERNAME, makeMessage, makeSupergroupChat } from "./telegram-fixtures";

const ALLOWED_CHAT = 1001;
const TOKEN_ENV = "TELEGRAM_BOT_TOKEN";

let server: FakeBotApiServer;
let adapter: TelegramAdapter | null = null;
let scratchDir = "";
let previousToken: string | undefined;

/**
 * Collects adapter events and lets a test await a specific one, so nothing has
 * to guess how long an update takes to travel through long polling.
 */
class EventSink {
  readonly events: AdapterEvent[] = [];
  private waiters: { match: (e: AdapterEvent) => boolean; resolve: (e: AdapterEvent) => void }[] =
    [];

  handle = (evt: AdapterEvent): void => {
    this.events.push(evt);
    this.waiters = this.waiters.filter((waiter) => {
      if (!waiter.match(evt)) return true;
      waiter.resolve(evt);
      return false;
    });
  };

  waitFor(match: (e: AdapterEvent) => boolean, label: string): Promise<AdapterEvent> {
    const existing = this.events.find(match);
    if (existing) return Promise.resolve(existing);

    return new Promise<AdapterEvent>((resolve, reject) => {
      this.waiters.push({ match, resolve });
      // Rejection-only guard: it never delays the successful path.
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 10_000);
      void Promise.resolve().then(() => timer.unref?.());
    });
  }

  ofType(type: AdapterEvent["type"]): AdapterEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}

function testConfig(telegram: Record<string, unknown> = {}): CoreConfig {
  const cfg = parseCoreConfigV2ToUniversal({
    configVersion: 2,
    surface: {
      telegram: {
        enabled: true,
        botName: "lilac",
        allowedChatIds: [String(ALLOWED_CHAT)],
        streamEditIntervalMs: 500,
        ...telegram,
      },
    },
  });
  return { ...cfg, agent: { ...cfg.agent, systemPrompt: "(test)" } };
}

async function connectAdapter(input: {
  cfg?: CoreConfig;
  sink?: EventSink;
}): Promise<{ adapter: TelegramAdapter; sink: EventSink }> {
  const cfg = input.cfg ?? testConfig();
  const sink = input.sink ?? new EventSink();

  const created = new TelegramAdapter({
    apiRoot: server.url,
    getConfig: async () => ({
      ...cfg,
      surface: {
        ...cfg.surface,
        telegram: { ...cfg.surface.telegram, dbPath: path.join(scratchDir, "telegram.db") },
      },
    }),
  });

  await created.subscribe(sink.handle);
  await created.connect();
  // connect() returns before polling actually starts, so wait for the first
  // successful getUpdates rather than racing it.
  await created.whenReady();
  adapter = created;

  return { adapter: created, sink };
}

/**
 * Runs `fn` with the adapter's logger raised above `warn`.
 *
 * A test that deliberately fails an upload gets a warning from the adapter,
 * which is expected output rather than signal. The level is read when the
 * logger is constructed, so this has to wrap the `connectAdapter` call and not
 * just the failing operation.
 */
async function withQuietLogger<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "error";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous;
  }
}

/** A message from the allowlisted chat, authored by a human. */
function inboundMessage(overrides: Partial<Message> = {}): NonNullable<Update["message"]> {
  const message = makeMessage({
    chat: { id: ALLOWED_CHAT, type: "private", first_name: "Ada" },
    ...overrides,
  });
  return message as NonNullable<Update["message"]>;
}

beforeEach(async () => {
  previousToken = process.env[TOKEN_ENV];
  process.env[TOKEN_ENV] = "000000:fake-token";
  scratchDir = await mkdtemp(path.join(tmpdir(), "lilac-telegram-it-"));
  server = new FakeBotApiServer(BOT_USER_ID, BOT_USERNAME);
});

afterEach(async () => {
  await adapter?.disconnect();
  adapter = null;
  await server.close();
  await rm(scratchDir, { recursive: true, force: true });

  if (previousToken === undefined) delete process.env[TOKEN_ENV];
  else process.env[TOKEN_ENV] = previousToken;
});

describe("telegram adapter against a fake Bot API", () => {
  it("renders action buttons on sends and replaces them on edits", async () => {
    const { adapter: a } = await connectAdapter({});
    const sessionRef = { platform: "telegram", channelId: String(ALLOWED_CHAT) } as const;

    const ref = await a.sendMsg(sessionRef, {
      text: "**Queued**",
      format: "markdown",
      actions: [{ actionId: "pause-token", label: "Pause", style: "secondary" }],
    });
    expect(server.callsOf("sendMessage").at(-1)?.params).toMatchObject({
      text: "<b>Queued</b>",
      parse_mode: "HTML",
    });
    expect(server.callsOf("sendMessage").at(-1)?.params.reply_markup).toEqual({
      inline_keyboard: [[{ text: "Pause", callback_data: "pause-token" }]],
    });

    const actionOnlyEdit = {
      text: "**Queued**",
      format: "markdown" as const,
      actions: [{ actionId: "resume-token", label: "Resume", style: "primary" as const }],
    };
    await a.editMsg(ref, actionOnlyEdit);
    expect(server.editablePayloadOf(Number(ref.messageId))).toMatchObject({
      text: "<b>Queued</b>",
      reply_markup: {
        inline_keyboard: [[{ text: "Resume", callback_data: "resume-token" }]],
      },
    });
    await expect(a.editMsg(ref, actionOnlyEdit)).resolves.toBeUndefined();

    await a.editMsg(ref, {
      text: "**Paused**",
      format: "markdown",
      actions: [{ actionId: "resume-token", label: "Resume", style: "primary" }],
    });
    expect(server.callsOf("editMessageText").at(-1)?.params).toMatchObject({
      text: "<b>Paused</b>",
      parse_mode: "HTML",
    });
    expect(server.callsOf("editMessageText").at(-1)?.params.reply_markup).toEqual({
      inline_keyboard: [[{ text: "Resume", callback_data: "resume-token" }]],
    });
    expect((await a.readMsg(ref))?.text).toBe("<b>Paused</b>");

    await a.editMsg(ref, { text: "done", actions: [] });
    expect(server.callsOf("editMessageText").at(-1)?.params.reply_markup).toEqual({
      inline_keyboard: [],
    });
  });

  it("tombstones the local cache when a direct edit confirms remote deletion", async () => {
    const { adapter: a } = await connectAdapter({});
    const sessionRef = { platform: "telegram", channelId: String(ALLOWED_CHAT) } as const;
    const ref = await a.sendMsg(sessionRef, { text: "locally cached" });

    expect(server.removeMessage(Number(ref.messageId))).toBe(true);
    expect(await a.readMsg(ref)).not.toBeNull();
    await expect(a.editMsg(ref, { text: "remote probe" })).rejects.toBeInstanceOf(
      SurfaceMessageNotFoundError,
    );
    expect(await a.readMsg(ref)).toBeNull();
  });

  it("keeps a locally cached message when Telegram only says it cannot be edited", async () => {
    const { adapter: a } = await connectAdapter({});
    const sessionRef = { platform: "telegram", channelId: String(ALLOWED_CHAT) } as const;
    const ref = await a.sendMsg(sessionRef, { text: "still exists" });
    server.failNext("editMessageText", {
      errorCode: 400,
      description: "Bad Request: message can't be edited",
    });

    await expect(a.editMsg(ref, { text: "not editable" })).rejects.toBeInstanceOf(
      SurfaceMessageNotFoundError,
    );
    expect((await a.readMsg(ref))?.text).toBe("still exists");
    expect(server.textOf(Number(ref.messageId))).toBe("still exists");
  });

  it("omits action ids that exceed Telegram's callback_data byte limit", () => {
    expect(
      buildTelegramActionKeyboard([
        { actionId: "x".repeat(65), label: "Too long", style: "danger" },
        { actionId: "ok", label: "Keep", style: "primary" },
      ]),
    ).toEqual({ inline_keyboard: [[{ text: "Keep", callback_data: "ok" }]] });
    expect(
      buildTelegramActionKeyboard([
        { actionId: "界".repeat(22), label: "Too long", style: "danger" },
      ]),
    ).toEqual({ inline_keyboard: [] });
    expect(buildTelegramActionKeyboard([])).toEqual({ inline_keyboard: [] });
  });

  it("connects, identifies itself, and reports ready", async () => {
    const { adapter: a } = await connectAdapter({});

    expect(server.callsOf("getMe")).toHaveLength(1);
    expect(await a.getSelf()).toEqual({
      platform: "telegram",
      userId: String(BOT_USER_ID),
      userName: BOT_USERNAME,
    });
    expect(a.getHealthSnapshot().isReady).toBe(true);
  });

  it("requests message_reaction updates, which are outside the API default set", async () => {
    await connectAdapter({});
    const poll = await server.waitForCall("getUpdates");

    expect(poll.params.allowed_updates).toEqual([
      "message",
      "edited_message",
      "callback_query",
      "message_reaction",
    ]);
  });

  it("registers the command menu, and skips it when disabled", async () => {
    await connectAdapter({});
    expect(server.callsOf("setMyCommands")).toHaveLength(1);

    await adapter?.disconnect();
    adapter = null;
    await connectAdapter({ cfg: testConfig({ commandMenu: false }) });

    expect(server.callsOf("setMyCommands")).toHaveLength(1);
  });

  it("routes a message from an allowlisted chat", async () => {
    const { sink } = await connectAdapter({});

    server.enqueueMessage(inboundMessage({ text: "hello there" }));
    const evt = await sink.waitFor((e) => e.type === "adapter.message.created", "message.created");

    expect(evt.type === "adapter.message.created" && evt.message.text).toBe("hello there");
    expect(evt.type === "adapter.message.created" && evt.message.session.channelId).toBe(
      String(ALLOWED_CHAT),
    );
  });

  it("ignores a chat that is not allowlisted", async () => {
    const { sink } = await connectAdapter({});

    // Enqueue the rejected message first, then an allowed one. When the second
    // arrives the first has demonstrably been processed and discarded.
    server.enqueueMessage(
      makeMessage({ chat: { id: 9999, type: "private", first_name: "Mal" } }) as NonNullable<
        Update["message"]
      >,
    );
    server.enqueueMessage(inboundMessage({ message_id: 77, text: "allowed" }));

    await sink.waitFor((e) => e.type === "adapter.message.created", "message.created");

    expect(sink.ofType("adapter.message.created")).toHaveLength(1);
  });

  it("ignores its own messages so replies cannot loop", async () => {
    const { sink } = await connectAdapter({});

    server.enqueueMessage(
      inboundMessage({
        message_id: 50,
        from: { id: BOT_USER_ID, is_bot: true, first_name: "Catalina" },
        text: "my own output",
      }),
    );
    server.enqueueMessage(inboundMessage({ message_id: 51, text: "from a human" }));

    await sink.waitFor((e) => e.type === "adapter.message.created", "message.created");

    const created = sink.ofType("adapter.message.created");
    expect(created).toHaveLength(1);
    expect(created[0]?.type === "adapter.message.created" && created[0].message.text).toBe(
      "from a human",
    );
  });

  it("gives a forum topic its own session id", async () => {
    const cfg = testConfig({ allowedChatIds: ["-1001234567890"] });
    const { sink } = await connectAdapter({ cfg });

    server.enqueueMessage(
      makeMessage({
        chat: makeSupergroupChat(),
        is_topic_message: true,
        message_thread_id: 7,
        text: "in a topic",
      }) as NonNullable<Update["message"]>,
    );

    const evt = await sink.waitFor((e) => e.type === "adapter.message.created", "topic message");

    expect(evt.type === "adapter.message.created" && evt.message.session.channelId).toBe(
      "-1001234567890:7",
    );
  });

  it("streams a reply as a send followed by edits", async () => {
    const { adapter: a } = await connectAdapter({});

    const stream = await a.startOutput({ platform: "telegram", channelId: String(ALLOWED_CHAT) });
    await stream.push({ type: "text.set", text: "the complete answer" });
    const result = await stream.finish();

    expect(server.callsOf("sendMessage").length).toBeGreaterThanOrEqual(1);
    expect(result.last.platform).toBe("telegram");

    const messageId = Number(result.last.messageId);
    expect(server.textOf(messageId)).toContain("the complete answer");
  });

  it("splits an over-long answer across several messages", async () => {
    const { adapter: a } = await connectAdapter({});

    const stream = await a.startOutput({ platform: "telegram", channelId: String(ALLOWED_CHAT) });
    await stream.push({ type: "text.set", text: "lorem ipsum ".repeat(900) });
    const result = await stream.finish();

    expect(result.created.length).toBeGreaterThan(1);
    for (const call of server.callsOf("sendMessage")) {
      expect(String(call.params.text ?? "").length).toBeLessThanOrEqual(4096);
    }
  });

  it("indexes a delivered attachment so a reply to it resolves", async () => {
    // Telegram never echoes the bot's own sends back, and an attachment message
    // carries no text, so without an explicit index entry a user replying to
    // the picture produces a reply target that readMsg cannot resolve — and the
    // reply chain silently truncates there.
    const { adapter: a } = await connectAdapter({});

    const stream = await a.startOutput({ platform: "telegram", channelId: String(ALLOWED_CHAT) });
    await stream.push({ type: "text.set", text: "here is the chart" });
    await stream.push({
      type: "attachment.add",
      attachment: {
        kind: "image",
        mimeType: "image/png",
        filename: "chart.png",
        bytes: new Uint8Array([1, 2, 3]),
      },
    });
    const result = await stream.finish();

    const upload = await server.waitForCall("sendPhoto");
    expect(upload.params.chat_id).toBe(ALLOWED_CHAT);
    // grammY uploads the file as a separate multipart part and points `photo`
    // at it with `attach://`; the fake resolves that back.
    expect(upload.params.photo).toMatchObject({ filename: "chart.png" });

    // The attachment lands last, so it is what a user replying to the bot's
    // picture would target.
    const read = await a.readMsg(result.last);
    expect(read).not.toBeNull();
    expect(read?.text).toBe("[image] chart.png");
  });

  it("keeps the first upload indexed when a later one fails", async () => {
    // The document is already in the chat by the time the photo is rejected.
    // Discarding its ref would leave a visible message nothing can resolve.
    const { adapter: a, result } = await withQuietLogger(async () => {
      const connected = await connectAdapter({});
      server.failNext("sendPhoto", {
        errorCode: 400,
        description: "Bad Request: IMAGE_PROCESS_FAILED",
      });

      const stream = await connected.adapter.startOutput({
        platform: "telegram",
        channelId: String(ALLOWED_CHAT),
      });
      await stream.push({ type: "text.set", text: "two files" });
      await stream.push({
        type: "attachment.add",
        attachment: {
          kind: "file",
          mimeType: "application/pdf",
          filename: "report.pdf",
          bytes: new Uint8Array([1]),
        },
      });
      await stream.push({
        type: "attachment.add",
        attachment: {
          kind: "image",
          mimeType: "image/png",
          filename: "chart.png",
          bytes: new Uint8Array([2]),
        },
      });

      return { adapter: connected.adapter, result: await stream.finish() };
    });

    expect(server.callsOf("sendDocument")).toHaveLength(1);
    expect(server.callsOf("sendPhoto")).toHaveLength(1);

    // `last` is the document, not the text reply: the surviving upload is the
    // most recent message the bot actually put in the chat.
    const read = await a.readMsg(result.last);
    expect(read?.text).toBe("[file] report.pdf");
  });

  it("turns the cancel button into a cancellation, not a workflow action", async () => {
    const { sink } = await connectAdapter({});

    const requestId = `telegram:${ALLOWED_CHAT}:42`;
    const callbackData = buildTelegramCancelCallbackData(requestId);
    expect(callbackData).not.toBeNull();

    server.enqueueUpdate({
      callback_query: {
        id: "cb-1",
        from: { id: 7, is_bot: false, first_name: "Ada" },
        chat_instance: "ci",
        data: callbackData ?? "",
        message: {
          message_id: 500,
          date: Math.floor(Date.now() / 1000),
          chat: { id: ALLOWED_CHAT, type: "private", first_name: "Ada" },
        },
      },
    });

    const evt = await sink.waitFor((e) => e.type === "adapter.request.cancel", "request.cancel");

    expect(evt.type === "adapter.request.cancel" && evt.requestId).toBe(requestId);
    expect(evt.type === "adapter.request.cancel" && evt.sessionId).toBe(String(ALLOWED_CHAT));
    expect(sink.ofType("adapter.action.invoked")).toHaveLength(0);
    await server.waitForCall("answerCallbackQuery");
    expect(server.callsOf("answerCallbackQuery")).toHaveLength(1);
  });

  it("turns an inline-keyboard callback into a workflow action event", async () => {
    const { sink } = await connectAdapter({});
    const actionId = crypto.randomUUID();

    server.enqueueUpdate({
      callback_query: {
        id: "cb-action",
        from: { id: 7, is_bot: false, first_name: "Ada" },
        chat_instance: "ci",
        data: actionId,
        message: {
          message_id: 501,
          date: Math.floor(Date.now() / 1000),
          chat: { id: ALLOWED_CHAT, type: "private", first_name: "Ada" },
        },
      },
    });

    const evt = await sink.waitFor((event) => event.type === "adapter.action.invoked", "action");
    expect(evt).toMatchObject({
      type: "adapter.action.invoked",
      platform: "telegram",
      actionId,
      userId: "7",
      messageRef: {
        platform: "telegram",
        channelId: String(ALLOWED_CHAT),
        messageId: "501",
      },
    });
    await server.waitForCall("answerCallbackQuery");
  });

  it("maps a reaction update onto add and remove events", async () => {
    const { sink } = await connectAdapter({});

    server.enqueueUpdate({
      message_reaction: {
        chat: { id: ALLOWED_CHAT, type: "private", first_name: "Ada" },
        message_id: 60,
        user: { id: 7, is_bot: false, first_name: "Ada" },
        date: Math.floor(Date.now() / 1000),
        old_reaction: [{ type: "emoji", emoji: "👀" }],
        new_reaction: [{ type: "emoji", emoji: "🔥" }],
      },
    });

    await sink.waitFor((e) => e.type === "adapter.reaction.added", "reaction.added");
    await sink.waitFor((e) => e.type === "adapter.reaction.removed", "reaction.removed");

    const added = sink.ofType("adapter.reaction.added")[0];
    const removed = sink.ofType("adapter.reaction.removed")[0];
    expect(added?.type === "adapter.reaction.added" && added.reaction).toBe("🔥");
    expect(removed?.type === "adapter.reaction.removed" && removed.reaction).toBe("👀");
  });

  it("attributes reaction updates on topic messages to the topic session", async () => {
    const topicChat = makeSupergroupChat();
    const cfg = testConfig({ allowedChatIds: [String(topicChat.id)] });
    const { sink } = await connectAdapter({ cfg });

    server.enqueueMessage(
      makeMessage({
        message_id: 61,
        chat: topicChat,
        is_topic_message: true,
        message_thread_id: 7,
        text: "topic message",
      }) as NonNullable<Update["message"]>,
    );
    await sink.waitFor((e) => e.type === "adapter.message.created", "topic message.created");

    server.enqueueUpdate({
      message_reaction: {
        chat: topicChat,
        message_id: 61,
        user: { id: 7, is_bot: false, first_name: "Ada" },
        date: Math.floor(Date.now() / 1000),
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "🔥" }],
      },
    });

    const added = await sink.waitFor((e) => e.type === "adapter.reaction.added", "topic reaction");
    expect(added.type === "adapter.reaction.added" && added.session.channelId).toBe(
      `${topicChat.id}:7`,
    );
    expect(added.type === "adapter.reaction.added" && added.messageRef.channelId).toBe(
      `${topicChat.id}:7`,
    );
  });

  it("sends a reaction through setMessageReaction", async () => {
    const { adapter: a } = await connectAdapter({});

    await a.addReaction(
      { platform: "telegram", channelId: String(ALLOWED_CHAT), messageId: "60" },
      "👍",
    );

    expect(server.callsOf("setMessageReaction")).toHaveLength(1);
  });

  it("serves history from the local index, since the Bot API has none", async () => {
    const { adapter: a, sink } = await connectAdapter({});
    const sessionRef = { platform: "telegram", channelId: String(ALLOWED_CHAT) } as const;

    server.enqueueMessage(inboundMessage({ message_id: 10, text: "first", date: 1_700_000_000 }));
    server.enqueueMessage(inboundMessage({ message_id: 11, text: "second", date: 1_700_000_060 }));

    await sink.waitFor(
      (e) => e.type === "adapter.message.created" && e.message.text === "second",
      "second message",
    );

    const history = await a.listMsg(sessionRef);
    expect(history.map((m) => m.text)).toEqual(["second", "first"]);

    const read = await a.readMsg({ ...sessionRef, messageId: "10" });
    expect(read?.text).toBe("first");
  });

  it("sends, edits and deletes a message", async () => {
    const { adapter: a } = await connectAdapter({});
    const sessionRef = { platform: "telegram", channelId: String(ALLOWED_CHAT) } as const;

    const ref = await a.sendMsg(sessionRef, { text: "hello" });
    await a.editMsg(ref, { text: "hello again" });
    await a.deleteMsg(ref);

    expect(server.textOf(Number(ref.messageId))).toBeUndefined();
    expect(await a.readMsg(ref)).toBeNull();
    expect(server.callsOf("deleteMessage")).toHaveLength(1);
  });

  it("delivers a message that was already waiting in the first getUpdates", async () => {
    // Long polling can return a backlog immediately on connect. Anything
    // published before every bus subscriber is live would be dropped, since
    // the router subscribes at offset "now" — which is why create-core-runtime
    // starts the router before calling connect().
    const sink = new EventSink();
    server.enqueueMessage(inboundMessage({ message_id: 5, text: "queued before connect" }));

    const { adapter: a } = await connectAdapter({ sink });
    const evt = await sink.waitFor((e) => e.type === "adapter.message.created", "backlog message");

    expect(evt.type === "adapter.message.created" && evt.message.text).toBe(
      "queued before connect",
    );
    expect(a.getHealthSnapshot().isReady).toBe(true);
  });

  it("disconnects cleanly and tolerates a second disconnect", async () => {
    const { adapter: a } = await connectAdapter({});

    await a.disconnect();
    await a.disconnect();
    adapter = null;

    expect(a.getHealthSnapshot().isReady).toBe(false);
  });
});
