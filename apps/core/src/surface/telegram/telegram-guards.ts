import type { Chat, Message, User } from "grammy/types";

import type { CoreConfig } from "@stanley2058/lilac-utils";

/**
 * Chat access. The allowlist fails closed: an empty `allowedChatIds` means the
 * bot ignores every chat, so a misconfigured deployment is silent rather than
 * open to anyone who finds the bot.
 */
export function isTelegramChatAllowed(input: {
  cfg: CoreConfig;
  chatId: number | string;
}): boolean {
  const allowed = input.cfg.surface.telegram.allowedChatIds;
  if (allowed.length === 0) return false;
  return allowed.includes(String(input.chatId));
}

/**
 * User access. Unlike chats, an empty `allowedUserIds` means "no additional
 * restriction" — the chat allowlist is already the primary gate, and requiring
 * both would make group usage impractical.
 */
export function isTelegramUserAllowed(input: {
  cfg: CoreConfig;
  userId: number | string | undefined;
}): boolean {
  const allowed = input.cfg.surface.telegram.allowedUserIds;
  if (allowed.length === 0) return true;
  if (input.userId === undefined) return false;
  return allowed.includes(String(input.userId));
}

/**
 * Messages worth routing to the agent.
 *
 * Rejects the bot's own output (which would otherwise loop), other bots, and
 * Telegram service messages (joins, pins, title changes and friends), which
 * carry no user intent.
 */
export function isRoutableTelegramMessage(input: {
  message: Message;
  botUserId?: number;
}): boolean {
  const { message } = input;

  if (message.from?.is_bot === true) return false;
  if (input.botUserId !== undefined && message.from?.id === input.botUserId) return false;

  if (isTelegramServiceMessage(message)) return false;

  // Anything with no text and no supported attachment has nothing to act on.
  const hasText = typeof message.text === "string" && message.text.trim().length > 0;
  const hasCaption = typeof message.caption === "string" && message.caption.trim().length > 0;
  const hasMedia = hasSupportedTelegramMedia(message);

  return hasText || hasCaption || hasMedia;
}

/**
 * Service messages are described by the presence of one of a fixed set of
 * fields on the message. Listing them explicitly beats a heuristic because the
 * Bot API adds new ones over time and an unknown field should default to
 * "ordinary message" rather than being silently dropped.
 */
export function isTelegramServiceMessage(message: Message): boolean {
  const serviceFields = [
    "new_chat_members",
    "left_chat_member",
    "new_chat_title",
    "new_chat_photo",
    "delete_chat_photo",
    "group_chat_created",
    "supergroup_chat_created",
    "channel_chat_created",
    "message_auto_delete_timer_changed",
    "migrate_to_chat_id",
    "migrate_from_chat_id",
    "pinned_message",
    "successful_payment",
    "users_shared",
    "chat_shared",
    "write_access_allowed",
    "proximity_alert_triggered",
    "boost_added",
    "forum_topic_created",
    "forum_topic_edited",
    "forum_topic_closed",
    "forum_topic_reopened",
    "general_forum_topic_hidden",
    "general_forum_topic_unhidden",
    "video_chat_scheduled",
    "video_chat_started",
    "video_chat_ended",
    "video_chat_participants_invited",
    "web_app_data",
  ] as const satisfies readonly (keyof Message)[];

  return serviceFields.some((field) => message[field] !== undefined);
}

export function hasSupportedTelegramMedia(message: Message): boolean {
  return (
    message.photo !== undefined ||
    message.document !== undefined ||
    message.voice !== undefined ||
    message.audio !== undefined ||
    message.video !== undefined
  );
}

export function isPrivateChat(chat: Chat): boolean {
  return chat.type === "private";
}

/**
 * Display name for attribution, preferring the handle because it is stable and
 * unambiguous, then the human name.
 */
export function telegramUserName(user: User | undefined): string | undefined {
  if (!user) return undefined;
  if (user.username) return user.username;

  const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return full.length > 0 ? full : undefined;
}
