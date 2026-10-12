import { describe, expect, it } from "bun:test";

import {
  chatIdOf,
  formatTelegramSessionId,
  parseTelegramMessageId,
  parseTelegramSessionId,
  telegramMsgRef,
  telegramSessionRef,
  threadIdOf,
  tryParseTelegramSessionId,
} from "../../../src/surface/telegram/telegram-ids";

describe("telegram session ids", () => {
  it("formats a plain chat as the bare chat id", () => {
    expect(formatTelegramSessionId({ chatId: 1001 })).toBe("1001");
  });

  it("keeps negative supergroup ids intact", () => {
    expect(formatTelegramSessionId({ chatId: -1_001_234_567_890 })).toBe("-1001234567890");
  });

  it("composes forum topics as chat:thread", () => {
    expect(formatTelegramSessionId({ chatId: -1001, threadId: 7 })).toBe("-1001:7");
  });

  it("treats a null thread id as no topic", () => {
    expect(formatTelegramSessionId({ chatId: 5, threadId: null })).toBe("5");
  });

  it("round-trips a negative chat id with a topic", () => {
    const sessionId = formatTelegramSessionId({ chatId: -1_001_234_567_890, threadId: 7 });
    expect(parseTelegramSessionId(sessionId)).toEqual({
      chatId: -1_001_234_567_890,
      threadId: 7,
    });
  });

  it("parses a plain chat without a thread id", () => {
    expect(parseTelegramSessionId("1001")).toEqual({ chatId: 1001 });
  });

  it("rejects non-canonical spellings so ids have one representation", () => {
    expect(tryParseTelegramSessionId("01001")).toBeNull();
    expect(tryParseTelegramSessionId("+1001")).toBeNull();
    expect(tryParseTelegramSessionId(" 1001")).toBeNull();
    expect(tryParseTelegramSessionId("1001.0")).toBeNull();
  });

  it("rejects malformed session ids", () => {
    expect(tryParseTelegramSessionId("")).toBeNull();
    expect(tryParseTelegramSessionId("abc")).toBeNull();
    expect(tryParseTelegramSessionId("1001:")).toBeNull();
    expect(tryParseTelegramSessionId(":7")).toBeNull();
    expect(tryParseTelegramSessionId("1001:7:9")).toBeNull();
  });

  it("rejects a non-positive topic id", () => {
    expect(tryParseTelegramSessionId("1001:0")).toBeNull();
    expect(tryParseTelegramSessionId("1001:-3")).toBeNull();
  });

  it("throws with the offending id when parsing strictly", () => {
    expect(() => parseTelegramSessionId("nope")).toThrow("nope");
  });

  it("builds refs that carry the composed session id", () => {
    const ref = telegramMsgRef({ chatId: -1001, threadId: 7, messageId: 55 });

    expect(ref).toEqual({
      platform: "telegram",
      channelId: "-1001:7",
      messageId: "55",
    });
    expect(chatIdOf(ref)).toBe(-1001);
    expect(threadIdOf(ref)).toBe(7);
  });

  it("reports no topic for a plain session ref", () => {
    const ref = telegramSessionRef({ chatId: 1001 });

    expect(ref).toEqual({ platform: "telegram", channelId: "1001" });
    expect(threadIdOf(ref)).toBeUndefined();
  });

  it("rejects message ids that are not positive integers", () => {
    expect(parseTelegramMessageId("55")).toBe(55);
    expect(() => parseTelegramMessageId("0")).toThrow();
    expect(() => parseTelegramMessageId("-1")).toThrow();
    expect(() => parseTelegramMessageId("abc")).toThrow();
  });
});
