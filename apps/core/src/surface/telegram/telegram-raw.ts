import type { Message, MessageEntity } from "grammy/types";

import type { SurfaceMessage } from "../types";
import { telegramMsgRef, telegramSessionRef } from "./telegram-ids";
import { telegramUserName } from "./telegram-guards";

/**
 * Router-facing flags, published on the bus as `raw.telegram`.
 *
 * The Discord adapter publishes the same shape under `raw.discord`; the shared
 * request router reads whichever envelope matches the event platform, so this
 * must stay structurally compatible with `getSurfaceFlags`.
 */
export type TelegramRouterFlags = {
  isDMBased: boolean;
  mentionsBot: boolean;
  replyToBot: boolean;
  replyToMessageId?: string;
  botUserId?: string;
  /** Forum topic id, when the message belongs to one. */
  parentChannelId?: string;
};

export type TelegramRawEnvelope = {
  telegram: TelegramRouterFlags & {
    chatId: string;
    chatType: Message["chat"]["type"];
    threadId?: string;
    messageId: string;
    /** Retained so downstream consumers can inspect the original update. */
    message: Message;
  };
};

/**
 * A message belongs to a forum topic only when Telegram says so. `message_thread_id`
 * alone is also populated for ordinary supergroup replies, so keying sessions off it
 * unconditionally would shatter one group chat into a session per reply chain.
 */
export function telegramTopicIdOf(message: Message): number | undefined {
  return message.is_topic_message === true ? message.message_thread_id : undefined;
}

function entityText(text: string, entity: MessageEntity): string {
  return text.slice(entity.offset, entity.offset + entity.length);
}

/**
 * Whether the message addresses the bot.
 *
 * Covers the three ways Telegram expresses this: a plain `@username` mention,
 * a `text_mention` entity carrying the user object (used when the account has
 * no username), and a `/command@username` suffix.
 */
export function telegramMentionsBot(input: {
  message: Message;
  botUsername?: string;
  botUserId?: number;
}): boolean {
  const { message } = input;
  const text = message.text ?? message.caption ?? "";
  const entities = message.entities ?? message.caption_entities ?? [];
  const handle = input.botUsername?.toLowerCase();

  for (const entity of entities) {
    if (entity.type === "text_mention") {
      if (input.botUserId !== undefined && entity.user.id === input.botUserId) return true;
      continue;
    }

    if (entity.type === "mention" && handle) {
      if (entityText(text, entity).slice(1).toLowerCase() === handle) return true;
      continue;
    }

    if (entity.type === "bot_command" && handle) {
      const command = entityText(text, entity);
      const at = command.indexOf("@");
      if (at !== -1 && command.slice(at + 1).toLowerCase() === handle) return true;
    }
  }

  return false;
}

export function telegramRepliesToBot(input: { message: Message; botUserId?: number }): boolean {
  const from = input.message.reply_to_message?.from;
  if (!from) return false;
  if (input.botUserId !== undefined) return from.id === input.botUserId;
  return from.is_bot === true;
}

export function toTelegramRouterFlags(input: {
  message: Message;
  botUsername?: string;
  botUserId?: number;
}): TelegramRouterFlags {
  const { message } = input;
  const topicId = telegramTopicIdOf(message);
  const replyToId = message.reply_to_message?.message_id;

  return {
    isDMBased: message.chat.type === "private",
    mentionsBot: telegramMentionsBot(input),
    replyToBot: telegramRepliesToBot(input),
    ...(replyToId === undefined ? {} : { replyToMessageId: String(replyToId) }),
    ...(input.botUserId === undefined ? {} : { botUserId: String(input.botUserId) }),
    ...(topicId === undefined ? {} : { parentChannelId: String(message.chat.id) }),
  };
}

export function toTelegramRawEnvelope(input: {
  message: Message;
  botUsername?: string;
  botUserId?: number;
}): TelegramRawEnvelope {
  const { message } = input;
  const topicId = telegramTopicIdOf(message);

  return {
    telegram: {
      ...toTelegramRouterFlags(input),
      chatId: String(message.chat.id),
      chatType: message.chat.type,
      ...(topicId === undefined ? {} : { threadId: String(topicId) }),
      messageId: String(message.message_id),
      message,
    },
  };
}

/** Text the agent should see. Telegram captions carry the text of media posts. */
export function telegramMessageText(message: Message): string {
  return message.text ?? message.caption ?? "";
}

export function toSurfaceMessage(input: {
  message: Message;
  botUsername?: string;
  botUserId?: number;
}): SurfaceMessage {
  const { message } = input;
  const threadId = telegramTopicIdOf(message);
  const editedTs = message.edit_date === undefined ? undefined : message.edit_date * 1000;

  return {
    ref: telegramMsgRef({
      chatId: message.chat.id,
      threadId,
      messageId: message.message_id,
    }),
    session: telegramSessionRef({ chatId: message.chat.id, threadId }),
    userId: message.from ? String(message.from.id) : "unknown",
    ...(telegramUserName(message.from) === undefined
      ? {}
      : { userName: telegramUserName(message.from) }),
    text: telegramMessageText(message),
    // Bot API timestamps are unix seconds.
    ts: message.date * 1000,
    ...(editedTs === undefined ? {} : { editedTs }),
    raw: toTelegramRawEnvelope(input),
  };
}

/**
 * Names the router should treat as addressing the bot, used for mention
 * stripping and leading-directive parsing.
 */
export function resolveTelegramBotMentionNames(input: {
  botName: string;
  botUsername?: string;
}): string[] {
  const names = new Set<string>([input.botName]);
  if (input.botUsername) names.add(input.botUsername);
  return [...names];
}
