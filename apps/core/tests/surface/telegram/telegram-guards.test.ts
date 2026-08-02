import { describe, expect, it } from "bun:test";

import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils/core-config/v2";
import type { CoreConfig } from "@stanley2058/lilac-utils";

import {
  isRoutableTelegramMessage,
  isTelegramChatAllowed,
  isTelegramServiceMessage,
  isTelegramUserAllowed,
  telegramUserName,
} from "../../../src/surface/telegram/telegram-guards";
import { BOT_USER_ID, makeMessage, makeSupergroupChat, makeUser } from "./telegram-fixtures";

function testConfig(telegram: Record<string, unknown> = {}): CoreConfig {
  const cfg = parseCoreConfigV2ToUniversal({
    configVersion: 2,
    surface: { telegram: { enabled: true, ...telegram } },
  });
  return { ...cfg, agent: { ...cfg.agent, systemPrompt: "(test)" } };
}

describe("telegram chat allowlist", () => {
  it("fails closed when no chats are configured", () => {
    expect(isTelegramChatAllowed({ cfg: testConfig(), chatId: 1001 })).toBe(false);
  });

  it("admits a configured chat", () => {
    const cfg = testConfig({ allowedChatIds: ["1001"] });
    expect(isTelegramChatAllowed({ cfg, chatId: 1001 })).toBe(true);
  });

  it("rejects a chat that is not on the list", () => {
    const cfg = testConfig({ allowedChatIds: ["1001"] });
    expect(isTelegramChatAllowed({ cfg, chatId: 2002 })).toBe(false);
  });

  it("matches negative supergroup ids", () => {
    const cfg = testConfig({ allowedChatIds: ["-1001234567890"] });
    expect(isTelegramChatAllowed({ cfg, chatId: -1_001_234_567_890 })).toBe(true);
  });
});

describe("telegram user allowlist", () => {
  it("imposes no user restriction when unset", () => {
    const cfg = testConfig({ allowedChatIds: ["1001"] });
    expect(isTelegramUserAllowed({ cfg, userId: 7 })).toBe(true);
    expect(isTelegramUserAllowed({ cfg, userId: undefined })).toBe(true);
  });

  it("restricts to the configured users once set", () => {
    const cfg = testConfig({ allowedChatIds: ["1001"], allowedUserIds: ["7"] });
    expect(isTelegramUserAllowed({ cfg, userId: 7 })).toBe(true);
    expect(isTelegramUserAllowed({ cfg, userId: 8 })).toBe(false);
  });

  it("rejects an unknown author when a user list is configured", () => {
    const cfg = testConfig({ allowedChatIds: ["1001"], allowedUserIds: ["7"] });
    expect(isTelegramUserAllowed({ cfg, userId: undefined })).toBe(false);
  });
});

describe("isRoutableTelegramMessage", () => {
  it("accepts an ordinary user message", () => {
    expect(isRoutableTelegramMessage({ message: makeMessage() })).toBe(true);
  });

  it("ignores the bot's own messages so replies do not loop", () => {
    const message = makeMessage({
      from: makeUser({ id: BOT_USER_ID, is_bot: true, first_name: "Catalina" }),
    });
    expect(isRoutableTelegramMessage({ message, botUserId: BOT_USER_ID })).toBe(false);
  });

  it("ignores other bots", () => {
    const message = makeMessage({ from: makeUser({ id: 99, is_bot: true }) });
    expect(isRoutableTelegramMessage({ message })).toBe(false);
  });

  it("ignores service messages such as joins", () => {
    const message = makeMessage({
      text: undefined,
      new_chat_members: [makeUser({ id: 5 })],
      chat: makeSupergroupChat(),
    });
    expect(isRoutableTelegramMessage({ message })).toBe(false);
  });

  it("ignores whitespace-only text with no media", () => {
    expect(isRoutableTelegramMessage({ message: makeMessage({ text: "   " }) })).toBe(false);
  });

  it("accepts a photo post carrying only a caption", () => {
    const message = makeMessage({
      text: undefined,
      caption: "look at this",
      photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }],
    });
    expect(isRoutableTelegramMessage({ message })).toBe(true);
  });

  it("ignores media with no caption, which would start an empty run", () => {
    // Inbound attachments are not forwarded to the model yet, so an uncaptioned
    // photo would produce a request containing only attribution metadata.
    const message = makeMessage({
      text: undefined,
      document: { file_id: "f", file_unique_id: "u" },
    });
    expect(isRoutableTelegramMessage({ message })).toBe(false);
  });
});

describe("isTelegramServiceMessage", () => {
  it("recognises forum topic lifecycle messages", () => {
    const message = makeMessage({
      text: undefined,
      forum_topic_created: { name: "topic", icon_color: 0 },
    });
    expect(isTelegramServiceMessage(message)).toBe(true);
  });

  it("treats a plain text message as non-service", () => {
    expect(isTelegramServiceMessage(makeMessage())).toBe(false);
  });
});

describe("telegramUserName", () => {
  it("prefers the stable handle", () => {
    expect(telegramUserName(makeUser({ username: "ada", first_name: "Ada" }))).toBe("ada");
  });

  it("falls back to the full name", () => {
    expect(telegramUserName(makeUser({ first_name: "Ada", last_name: "Lovelace" }))).toBe(
      "Ada Lovelace",
    );
  });

  it("returns undefined when there is nothing to show", () => {
    expect(telegramUserName(undefined)).toBeUndefined();
    expect(telegramUserName(makeUser({ first_name: "" }))).toBeUndefined();
  });
});
