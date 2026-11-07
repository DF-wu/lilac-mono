import { describe, expect, it } from "bun:test";

import {
  resolveTelegramBotMentionNames,
  telegramMentionsBot,
  telegramMessageText,
  telegramRepliesToBot,
  telegramTopicIdOf,
  toSurfaceMessage,
  toTelegramRawEnvelope,
} from "../../../src/surface/telegram/telegram-raw";
import {
  BOT_USER_ID,
  BOT_USERNAME,
  makeMentionMessage,
  makeMessage,
  makeReplyTo,
  makeSupergroupChat,
  makeUser,
} from "./telegram-fixtures";

describe("telegramMentionsBot", () => {
  it("detects a plain @username mention", () => {
    const message = makeMentionMessage({ handle: BOT_USERNAME });
    expect(telegramMentionsBot({ message, botUsername: BOT_USERNAME })).toBe(true);
  });

  it("matches the handle case-insensitively", () => {
    const message = makeMentionMessage({ handle: BOT_USERNAME.toLowerCase() });
    expect(telegramMentionsBot({ message, botUsername: BOT_USERNAME })).toBe(true);
  });

  it("does not match a different bot's handle", () => {
    const message = makeMentionMessage({ handle: "someone_else_bot" });
    expect(telegramMentionsBot({ message, botUsername: BOT_USERNAME })).toBe(false);
  });

  it("detects a text_mention entity, used when the account has no username", () => {
    const message = makeMessage({
      text: "Catalina ping",
      entities: [
        {
          type: "text_mention",
          offset: 0,
          length: 8,
          user: makeUser({ id: BOT_USER_ID, is_bot: true, first_name: "Catalina" }),
        },
      ],
    });

    expect(telegramMentionsBot({ message, botUserId: BOT_USER_ID })).toBe(true);
  });

  it("detects a /command@botname suffix", () => {
    const command = `/cancel@${BOT_USERNAME}`;
    const message = makeMessage({
      text: command,
      entities: [{ type: "bot_command", offset: 0, length: command.length }],
    });

    expect(telegramMentionsBot({ message, botUsername: BOT_USERNAME })).toBe(true);
  });

  it("does not treat a bare /command as addressing this bot", () => {
    const message = makeMessage({
      text: "/cancel",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
    });

    expect(telegramMentionsBot({ message, botUsername: BOT_USERNAME })).toBe(false);
  });

  it("finds a mention in a media caption", () => {
    const mention = `@${BOT_USERNAME}`;
    const message = makeMessage({
      text: undefined,
      caption: `${mention} describe this`,
      caption_entities: [{ type: "mention", offset: 0, length: mention.length }],
      photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }],
    });

    expect(telegramMentionsBot({ message, botUsername: BOT_USERNAME })).toBe(true);
  });

  it("returns false when the bot handle is unknown", () => {
    const message = makeMentionMessage({ handle: BOT_USERNAME });
    expect(telegramMentionsBot({ message })).toBe(false);
  });
});

describe("telegramRepliesToBot", () => {
  it("is true when replying to the bot", () => {
    const message = makeMessage({
      reply_to_message: makeReplyTo({
        message_id: 41,
        from: makeUser({ id: BOT_USER_ID, is_bot: true }),
      }),
    });

    expect(telegramRepliesToBot({ message, botUserId: BOT_USER_ID })).toBe(true);
  });

  it("is false when replying to another human", () => {
    const message = makeMessage({
      reply_to_message: makeReplyTo({ message_id: 41, from: makeUser({ id: 5 }) }),
    });

    expect(telegramRepliesToBot({ message, botUserId: BOT_USER_ID })).toBe(false);
  });

  it("is false when there is no reply", () => {
    expect(telegramRepliesToBot({ message: makeMessage(), botUserId: BOT_USER_ID })).toBe(false);
  });
});

describe("telegramTopicIdOf", () => {
  it("returns the topic id only when Telegram flags it as a topic message", () => {
    const topic = makeMessage({
      chat: makeSupergroupChat(),
      is_topic_message: true,
      message_thread_id: 7,
    });

    expect(telegramTopicIdOf(topic)).toBe(7);
  });

  it("ignores message_thread_id on ordinary supergroup replies", () => {
    // Telegram also sets message_thread_id for plain reply chains; keying
    // sessions off it would split one group into a session per thread.
    const reply = makeMessage({ chat: makeSupergroupChat(), message_thread_id: 7 });

    expect(telegramTopicIdOf(reply)).toBeUndefined();
  });
});

describe("toTelegramRawEnvelope", () => {
  it("publishes the router flags the shared router reads", () => {
    const message = makeMentionMessage({ handle: BOT_USERNAME });
    const envelope = toTelegramRawEnvelope({
      message,
      botUsername: BOT_USERNAME,
      botUserId: BOT_USER_ID,
    });

    expect(envelope.telegram.isDMBased).toBe(true);
    expect(envelope.telegram.mentionsBot).toBe(true);
    expect(envelope.telegram.replyToBot).toBe(false);
    expect(envelope.telegram.botUserId).toBe(String(BOT_USER_ID));
    expect(envelope.telegram.chatId).toBe("1001");
    expect(envelope.telegram.chatType).toBe("private");
  });

  it("carries the replied-to message id", () => {
    const message = makeMessage({
      reply_to_message: makeReplyTo({
        message_id: 41,
        from: makeUser({ id: BOT_USER_ID, is_bot: true }),
      }),
    });

    const envelope = toTelegramRawEnvelope({ message, botUserId: BOT_USER_ID });

    expect(envelope.telegram.replyToMessageId).toBe("41");
    expect(envelope.telegram.replyToBot).toBe(true);
  });

  it("marks group chats as not DM-based", () => {
    const message = makeMessage({ chat: makeSupergroupChat() });
    const envelope = toTelegramRawEnvelope({ message });

    expect(envelope.telegram.isDMBased).toBe(false);
  });

  it("exposes the topic id for forum messages", () => {
    const message = makeMessage({
      chat: makeSupergroupChat(),
      is_topic_message: true,
      message_thread_id: 7,
    });

    const envelope = toTelegramRawEnvelope({ message });

    expect(envelope.telegram.threadId).toBe("7");
  });
});

describe("toSurfaceMessage", () => {
  it("maps a private message onto the surface shape", () => {
    const message = makeMessage({ from: makeUser({ id: 1001, username: "ada" }) });
    const surface = toSurfaceMessage({ message, botUserId: BOT_USER_ID });

    expect(surface.ref).toEqual({
      platform: "telegram",
      channelId: "1001",
      messageId: "42",
    });
    expect(surface.session).toEqual({ platform: "telegram", channelId: "1001" });
    expect(surface.userId).toBe("1001");
    expect(surface.userName).toBe("ada");
    expect(surface.text).toBe("hello");
  });

  it("converts unix seconds to milliseconds", () => {
    const surface = toSurfaceMessage({ message: makeMessage({ date: 1_700_000_000 }) });
    expect(surface.ts).toBe(1_700_000_000_000);
  });

  it("carries the edit timestamp when present", () => {
    const surface = toSurfaceMessage({
      message: makeMessage({ edit_date: 1_700_000_060 }),
    });

    expect(surface.editedTs).toBe(1_700_000_060_000);
  });

  it("routes a forum topic to its own session", () => {
    const message = makeMessage({
      chat: makeSupergroupChat(),
      is_topic_message: true,
      message_thread_id: 7,
    });

    const surface = toSurfaceMessage({ message });

    expect(surface.session.channelId).toBe("-1001234567890:7");
  });

  it("falls back to 'unknown' when the author is absent", () => {
    const surface = toSurfaceMessage({ message: makeMessage({ from: undefined }) });
    expect(surface.userId).toBe("unknown");
  });
});

describe("telegramMessageText", () => {
  it("prefers text and falls back to caption", () => {
    expect(telegramMessageText(makeMessage({ text: "a" }))).toBe("a");
    expect(telegramMessageText(makeMessage({ text: undefined, caption: "b" }))).toBe("b");
    expect(telegramMessageText(makeMessage({ text: undefined }))).toBe("");
  });
});

describe("resolveTelegramBotMentionNames", () => {
  it("includes both the configured name and the handle", () => {
    expect(resolveTelegramBotMentionNames({ botName: "lilac", botUsername: BOT_USERNAME })).toEqual(
      ["lilac", BOT_USERNAME],
    );
  });

  it("deduplicates when they are the same", () => {
    expect(resolveTelegramBotMentionNames({ botName: "lilac", botUsername: "lilac" })).toEqual([
      "lilac",
    ]);
  });

  it("works before the handle is resolved", () => {
    expect(resolveTelegramBotMentionNames({ botName: "lilac" })).toEqual(["lilac"]);
  });
});
