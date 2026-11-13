import type { TelegramMsgRef, TelegramSessionRef } from "../types";

/**
 * A Telegram "session" is a chat, or a single topic inside a forum-enabled
 * supergroup. Topics are addressed by `message_thread_id`, which is only
 * meaningful together with its chat, so the session id composes both:
 *
 * - `"<chat_id>"`            regular chat, group, or channel
 * - `"<chat_id>:<thread_id>"` one forum topic
 *
 * Chat ids are signed integers (supergroups and channels are negative), which
 * is why parsing is explicit rather than a naive `split(":")`.
 */
export type TelegramSessionId = {
  chatId: number;
  threadId?: number;
};

function isValidId(value: number): boolean {
  return Number.isSafeInteger(value);
}

function parseIdSegment(raw: string): number | null {
  // Reject "+1", " 1", "1.0", "01" and other shapes that would round-trip
  // differently, so a session id always has exactly one canonical spelling.
  if (!/^-?(0|[1-9]\d*)$/u.test(raw)) return null;
  const value = Number(raw);
  return isValidId(value) ? value : null;
}

export function formatTelegramSessionId(input: {
  chatId: number | string;
  threadId?: number | string | null;
}): string {
  const chatId = typeof input.chatId === "number" ? String(input.chatId) : input.chatId;
  const threadId =
    input.threadId === null || input.threadId === undefined ? undefined : String(input.threadId);

  return threadId === undefined ? chatId : `${chatId}:${threadId}`;
}

export function tryParseTelegramSessionId(sessionId: string): TelegramSessionId | null {
  const separator = sessionId.indexOf(":");
  if (separator === -1) {
    const chatId = parseIdSegment(sessionId);
    return chatId === null ? null : { chatId };
  }

  const chatId = parseIdSegment(sessionId.slice(0, separator));
  const threadId = parseIdSegment(sessionId.slice(separator + 1));
  if (chatId === null || threadId === null) return null;
  // Telegram numbers topics from 1; 0 and negatives are not valid topic ids.
  if (threadId <= 0) return null;

  return { chatId, threadId };
}

export function parseTelegramSessionId(sessionId: string): TelegramSessionId {
  const parsed = tryParseTelegramSessionId(sessionId);
  if (!parsed) {
    throw new Error(`telegram: invalid session id '${sessionId}'`);
  }
  return parsed;
}

export function telegramSessionRef(input: {
  chatId: number | string;
  threadId?: number | string | null;
}): TelegramSessionRef {
  return { platform: "telegram", channelId: formatTelegramSessionId(input) };
}

export function telegramMsgRef(input: {
  chatId: number | string;
  threadId?: number | string | null;
  messageId: number | string;
}): TelegramMsgRef {
  return {
    platform: "telegram",
    channelId: formatTelegramSessionId(input),
    messageId: String(input.messageId),
  };
}

/** The numeric chat id a ref belongs to, ignoring any forum topic. */
export function chatIdOf(ref: TelegramSessionRef | TelegramMsgRef): number {
  return parseTelegramSessionId(ref.channelId).chatId;
}

/** The forum topic id a ref belongs to, if any. */
export function threadIdOf(ref: TelegramSessionRef | TelegramMsgRef): number | undefined {
  return parseTelegramSessionId(ref.channelId).threadId;
}

export function parseTelegramMessageId(messageId: string): number {
  const parsed = parseIdSegment(messageId);
  if (parsed === null || parsed <= 0) {
    throw new Error(`telegram: invalid message id '${messageId}'`);
  }
  return parsed;
}
