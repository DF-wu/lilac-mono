import type { Chat, Message, MessageEntity, User } from "grammy/types";

export const BOT_USER_ID = 8_792_842_071;
export const BOT_USERNAME = "Catalina_agentbot";

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1001,
    is_bot: false,
    first_name: "Ada",
    ...overrides,
  };
}

export function makePrivateChat(overrides: Partial<Chat.PrivateChat> = {}): Chat.PrivateChat {
  return {
    id: 1001,
    type: "private",
    first_name: "Ada",
    ...overrides,
  };
}

export function makeSupergroupChat(
  overrides: Partial<Chat.SupergroupChat> = {},
): Chat.SupergroupChat {
  return {
    id: -1_001_234_567_890,
    type: "supergroup",
    title: "ops",
    ...overrides,
  };
}

/**
 * Minimal well-formed message. Tests override only the fields under test so a
 * failure points at the behaviour rather than at fixture noise.
 */
export function makeMessage(overrides: Partial<Message> = {}): Message {
  const base = {
    message_id: 42,
    date: 1_700_000_000,
    chat: makePrivateChat(),
    from: makeUser(),
    text: "hello",
  };

  return { ...base, ...overrides } as Message;
}

/**
 * The Bot API models `reply_to_message` as a message that cannot itself carry a
 * reply, so it needs its own builder rather than reusing `makeMessage`.
 */
export type ReplyMessage = NonNullable<Message["reply_to_message"]>;

export function makeReplyTo(overrides: Partial<ReplyMessage> = {}): ReplyMessage {
  const base = {
    message_id: 41,
    date: 1_699_999_000,
    chat: makePrivateChat(),
    from: makeUser(),
    text: "earlier",
  };

  return { ...base, ...overrides } as ReplyMessage;
}

/** Builds a message whose text contains an `@mention` entity for `handle`. */
export function makeMentionMessage(input: {
  handle: string;
  trailing?: string;
  chat?: Chat;
}): Message {
  const mention = `@${input.handle}`;
  const text = `${mention}${input.trailing ?? " ping"}`;
  const entities: MessageEntity[] = [{ type: "mention", offset: 0, length: mention.length }];

  return makeMessage({
    text,
    entities,
    ...(input.chat ? { chat: input.chat } : {}),
  });
}
