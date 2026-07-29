import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  TelegramSurfaceStore,
  type TelegramMessageRecord,
} from "../../../src/surface/telegram/store/telegram-surface-store";

let store: TelegramSurfaceStore;

function record(overrides: Partial<TelegramMessageRecord> = {}): TelegramMessageRecord {
  return {
    sessionId: "1001",
    messageId: "1",
    chatId: "1001",
    userId: "7",
    userName: "ada",
    text: "hello",
    ts: 1_000,
    fromBot: false,
    ...overrides,
  };
}

beforeEach(() => {
  // Telegram has no history API, so this index is the only source of past
  // messages. An in-memory DB keeps the suite hermetic.
  store = new TelegramSurfaceStore(":memory:");
});

afterEach(() => {
  store.close();
});

describe("TelegramSurfaceStore messages", () => {
  it("round-trips a message", () => {
    store.upsertMessage(record());

    expect(store.getMessage({ sessionId: "1001", messageId: "1" })).toMatchObject({
      messageId: "1",
      userId: "7",
      userName: "ada",
      text: "hello",
      fromBot: false,
    });
  });

  it("returns null for an unknown message", () => {
    expect(store.getMessage({ sessionId: "1001", messageId: "9" })).toBeNull();
  });

  it("updates text on edit rather than inserting a duplicate", () => {
    store.upsertMessage(record({ text: "before" }));
    store.upsertMessage(record({ text: "after", editedTs: 2_000 }));

    expect(store.listMessages({ sessionId: "1001" })).toHaveLength(1);
    expect(store.getMessage({ sessionId: "1001", messageId: "1" })).toMatchObject({
      text: "after",
      editedTs: 2_000,
    });
  });

  it("keeps forum topics in separate sessions", () => {
    store.upsertMessage(record({ sessionId: "1001", messageId: "1" }));
    store.upsertMessage(record({ sessionId: "1001:7", messageId: "2", threadId: "7" }));

    expect(store.listMessages({ sessionId: "1001" }).map((m) => m.messageId)).toEqual(["1"]);
    expect(store.listMessages({ sessionId: "1001:7" }).map((m) => m.messageId)).toEqual(["2"]);
  });

  it("lists newest first", () => {
    store.upsertMessage(record({ messageId: "1", ts: 1_000 }));
    store.upsertMessage(record({ messageId: "2", ts: 2_000 }));
    store.upsertMessage(record({ messageId: "3", ts: 3_000 }));

    expect(store.listMessages({ sessionId: "1001" }).map((m) => m.messageId)).toEqual([
      "3",
      "2",
      "1",
    ]);
  });

  it("honours the limit", () => {
    for (let i = 1; i <= 5; i++) {
      store.upsertMessage(record({ messageId: String(i), ts: i * 1_000 }));
    }

    expect(store.listMessages({ sessionId: "1001", limit: 2 })).toHaveLength(2);
  });

  it("pages backwards with beforeMessageId", () => {
    for (let i = 1; i <= 5; i++) {
      store.upsertMessage(record({ messageId: String(i), ts: i * 1_000 }));
    }

    const page = store.listMessages({ sessionId: "1001", beforeMessageId: "3" });
    expect(page.map((m) => m.messageId)).toEqual(["2", "1"]);
  });

  it("compares message ids numerically, not lexically", () => {
    // "9" > "10" as strings; Telegram ids are numeric and monotonic.
    store.upsertMessage(record({ messageId: "9", ts: 9_000 }));
    store.upsertMessage(record({ messageId: "10", ts: 10_000 }));

    const page = store.listMessages({ sessionId: "1001", beforeMessageId: "10" });
    expect(page.map((m) => m.messageId)).toEqual(["9"]);
  });

  it("hides messages marked deleted", () => {
    store.upsertMessage(record({ messageId: "1" }));
    store.markDeleted({ sessionId: "1001", messageId: "1" });

    expect(store.getMessage({ sessionId: "1001", messageId: "1" })).toBeNull();
    expect(store.listMessages({ sessionId: "1001" })).toHaveLength(0);
  });
});

describe("TelegramSurfaceStore sessions", () => {
  it("upserts and lists sessions", () => {
    store.upsertSession({
      sessionId: "1001",
      chatId: "1001",
      title: "Ada",
      kind: "dm",
      updatedTs: 1_000,
    });

    expect(store.listSessions()).toMatchObject([{ session_id: "1001", kind: "dm", title: "Ada" }]);
  });

  it("refreshes an existing session in place", () => {
    store.upsertSession({ sessionId: "1001", chatId: "1001", kind: "dm", updatedTs: 1_000 });
    store.upsertSession({
      sessionId: "1001",
      chatId: "1001",
      title: "renamed",
      kind: "dm",
      updatedTs: 2_000,
    });

    const sessions = store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.title).toBe("renamed");
  });
});

describe("TelegramSurfaceStore read state", () => {
  it("treats everything as unread before a read marker exists", () => {
    store.upsertMessage(record({ messageId: "1", ts: 1_000 }));
    store.upsertMessage(record({ messageId: "2", ts: 2_000 }));

    expect(store.listUnread({ sessionId: "1001" })).toHaveLength(2);
  });

  it("only returns messages newer than the read marker", () => {
    store.upsertMessage(record({ messageId: "1", ts: 1_000 }));
    store.upsertMessage(record({ messageId: "2", ts: 2_000 }));
    store.markRead({ sessionId: "1001", messageId: "1", ts: 1_000 });

    expect(store.listUnread({ sessionId: "1001" }).map((m) => m.messageId)).toEqual(["2"]);
  });

  it("excludes the bot's own messages from unread", () => {
    store.upsertMessage(record({ messageId: "1", ts: 1_000, fromBot: true }));

    expect(store.listUnread({ sessionId: "1001" })).toHaveLength(0);
  });

  it("excludes deleted messages from unread", () => {
    store.upsertMessage(record({ messageId: "1", ts: 1_000 }));
    store.upsertMessage(record({ messageId: "2", ts: 2_000 }));
    store.markDeleted({ sessionId: "1001", messageId: "2" });

    expect(store.listUnread({ sessionId: "1001" }).map((m) => m.messageId)).toEqual(["1"]);
  });

  it("still returns messages sharing the read marker's second", () => {
    // Telegram timestamps are second-resolution, so a burst lands on one `ts`.
    store.upsertMessage(record({ messageId: "1", ts: 1_000 }));
    store.upsertMessage(record({ messageId: "2", ts: 1_000 }));
    store.markRead({ sessionId: "1001", messageId: "1", ts: 1_000 });

    expect(store.listUnread({ sessionId: "1001" }).map((m) => m.messageId)).toEqual(["2"]);
  });

  it("lists unread oldest first", () => {
    store.upsertMessage(record({ messageId: "1", ts: 1_000 }));
    store.upsertMessage(record({ messageId: "2", ts: 2_000 }));
    store.upsertMessage(record({ messageId: "3", ts: 3_000 }));

    expect(store.listUnread({ sessionId: "1001" }).map((m) => m.messageId)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("orders same-second unread numerically, not lexically", () => {
    // "10" < "9" as strings, which would invert the arrival order.
    store.upsertMessage(record({ messageId: "10", ts: 1_000 }));
    store.upsertMessage(record({ messageId: "9", ts: 1_000 }));

    expect(store.listUnread({ sessionId: "1001" }).map((m) => m.messageId)).toEqual(["9", "10"]);
  });

  it("compares the read marker id numerically", () => {
    store.upsertMessage(record({ messageId: "9", ts: 1_000 }));
    store.upsertMessage(record({ messageId: "10", ts: 1_000 }));
    store.markRead({ sessionId: "1001", messageId: "9", ts: 1_000 });

    expect(store.listUnread({ sessionId: "1001" }).map((m) => m.messageId)).toEqual(["10"]);
  });
});
