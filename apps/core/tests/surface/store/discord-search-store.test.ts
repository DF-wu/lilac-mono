import { describe, expect, it } from "bun:test";
import { Result } from "better-result";
import type { LimitOpts, SessionRef, SurfaceMessage } from "../../../src/surface/types";
import {
  DISCORD_SEARCH_FIRST_SEARCH_HEAL_LIMIT,
  DISCORD_SEARCH_NEW_MESSAGE_HEAL_LIMIT,
  DiscordSearchService,
  DiscordSearchStore,
} from "../../../src/surface/store/discord-search-store";

class FakeSearchAdapter {
  public listCalls: Array<{ sessionRef: SessionRef; opts?: LimitOpts }> = [];

  constructor(private readonly messagesByChannelId: Record<string, SurfaceMessage[]>) {}

  async listMsg(sessionRef: SessionRef, opts?: LimitOpts) {
    this.listCalls.push({ sessionRef, opts });
    const messages = this.messagesByChannelId[sessionRef.channelId] ?? [];
    return Result.ok(messages.slice(0, opts?.limit ?? 50));
  }
}

describe("discord search store", () => {
  it("does not advance freshness when re-upserting identical messages", () => {
    const originalDateNow = Date.now;
    let now = 1_000;
    Date.now = () => now;

    const store = new DiscordSearchStore(":memory:");
    const message: SurfaceMessage = {
      ref: { platform: "discord", channelId: "123", messageId: "m1" },
      session: { platform: "discord", channelId: "123" },
      userId: "u1",
      userName: "user one",
      text: "deploy completed",
      ts: 1,
    };

    try {
      expect(store.upsertMessages([message])).toBe(1);
      const first = store.listMessagesForDiscovery()[0]?.updatedTs;

      now = 2_000;
      expect(store.upsertMessages([message])).toBe(0);
      const unchanged = store.listMessagesForDiscovery()[0]?.updatedTs;
      expect(unchanged).toBe(first);

      expect(store.upsertMessages([{ ...message, text: "deploy completed successfully" }])).toBe(1);
      const changed = store.listMessagesForDiscovery()[0]?.updatedTs;
      expect(changed).toBe(2_000);
    } finally {
      store.close();
      Date.now = originalDateNow;
    }
  });

  it("persists stable attachment metadata without signed URLs", () => {
    const store = new DiscordSearchStore(":memory:");
    const message: SurfaceMessage = {
      ref: { platform: "discord", channelId: "123", messageId: "m1" },
      session: { platform: "discord", channelId: "123" },
      userId: "u1",
      text: "",
      ts: 1,
      raw: {
        attachments: [
          {
            id: "a1",
            url: "https://cdn.discordapp.com/attachments/1/2/image.png?ex=secret",
            filename: "image.png",
            mimeType: "image/png",
            size: 123,
          },
        ],
      },
    };

    expect(store.upsertMessages([message])).toBe(1);
    expect(store.getIndexedMessage({ channelId: "123", messageId: "m1" })?.attachments).toEqual([
      { id: "a1", filename: "image.png", mimeType: "image/png", size: 123 },
    ]);
    expect(store.upsertMessages([message])).toBe(0);
    expect(
      store.upsertMessages([
        {
          ...message,
          raw: {
            attachments: [
              {
                id: "a2",
                url: "https://cdn.discordapp.com/attachments/1/2/other.png?ex=other",
                filename: "other.png",
                mimeType: "image/png",
                size: 456,
              },
            ],
          },
        },
      ]),
    ).toBe(1);
    store.close();
  });

  it("returns message mutations for inserts, edits, and duplicate updates", () => {
    const store = new DiscordSearchStore(":memory:");
    const service = new DiscordSearchService({
      adapter: new FakeSearchAdapter({}),
      store,
    });
    const message: SurfaceMessage = {
      ref: { platform: "discord", channelId: "123", messageId: "m1" },
      session: { platform: "discord", channelId: "123" },
      userId: "u1",
      text: "deploy started",
      ts: 1,
    };

    try {
      const inserted = service.onMessageUpdated(message);
      expect(inserted?.before).toBeNull();
      expect(inserted?.after?.text).toBe("deploy started");
      expect(inserted?.changed).toBe(true);

      const edited = service.onMessageUpdated({
        ...message,
        text: "deploy completed",
        editedTs: 2,
      });
      expect(edited?.before?.text).toBe("deploy started");
      expect(edited?.after?.text).toBe("deploy completed");
      expect(edited?.changed).toBe(true);

      const duplicate = service.onMessageUpdated({
        ...message,
        text: "deploy completed",
        editedTs: 2,
      });
      expect(duplicate?.before).toEqual(duplicate?.after);
      expect(duplicate?.changed).toBe(false);
    } finally {
      store.close();
    }
  });

  it("searches within a single channel", () => {
    const store = new DiscordSearchStore(":memory:");

    store.upsertMessages([
      {
        ref: { platform: "discord", channelId: "123", messageId: "m1" },
        session: { platform: "discord", channelId: "123" },
        userId: "u1",
        text: "deploy completed",
        ts: 1,
      },
      {
        ref: { platform: "discord", channelId: "456", messageId: "m2" },
        session: { platform: "discord", channelId: "456" },
        userId: "u2",
        text: "deploy elsewhere",
        ts: 2,
      },
    ]);

    const hits = store.searchChannel({ channelId: "123", query: "deploy" });
    expect(hits.length).toBe(1);
    expect(hits[0]?.ref.channelId).toBe("123");

    store.close();
  });

  it("heals recent history on create and respects cooldown", async () => {
    const adapter = new FakeSearchAdapter({
      "123": [
        {
          ref: { platform: "discord", channelId: "123", messageId: "m1" },
          session: { platform: "discord", channelId: "123" },
          userId: "u1",
          text: "deploy completed",
          ts: 1,
        },
      ],
    });

    const store = new DiscordSearchStore(":memory:");
    const service = new DiscordSearchService({ adapter, store });

    await service.onMessageCreated({
      ref: { platform: "discord", channelId: "123", messageId: "seed-1" },
      session: { platform: "discord", channelId: "123" },
      userId: "u1",
      text: "hello",
      ts: 10,
    });

    await service.onMessageCreated({
      ref: { platform: "discord", channelId: "123", messageId: "seed-2" },
      session: { platform: "discord", channelId: "123" },
      userId: "u1",
      text: "world",
      ts: 11,
    });

    expect(adapter.listCalls.length).toBe(1);
    expect(adapter.listCalls[0]?.opts?.limit).toBe(DISCORD_SEARCH_NEW_MESSAGE_HEAL_LIMIT);

    store.close();
  });

  it("uses first-search heal limit then cooldown", async () => {
    const adapter = new FakeSearchAdapter({
      "123": [
        {
          ref: { platform: "discord", channelId: "123", messageId: "m1" },
          session: { platform: "discord", channelId: "123" },
          userId: "u1",
          text: "deploy completed",
          ts: 1,
        },
      ],
    });

    const store = new DiscordSearchStore(":memory:");
    const indexedChannels: string[] = [];
    const service = new DiscordSearchService({
      adapter,
      store,
      onMessagesIndexed(channelId) {
        indexedChannels.push(channelId);
      },
    });

    const first = await service.searchSession({
      sessionRef: { platform: "discord", channelId: "123" },
      query: "deploy",
    });

    expect(first.heal?.attempted).toBe(true);
    expect(first.heal?.limit).toBe(DISCORD_SEARCH_FIRST_SEARCH_HEAL_LIMIT);
    expect(adapter.listCalls.length).toBe(1);
    expect(indexedChannels).toEqual(["123"]);

    const second = await service.searchSession({
      sessionRef: { platform: "discord", channelId: "123" },
      query: "deploy",
    });

    expect(second.heal?.skipped).toBe(true);
    expect(second.heal?.reason).toBe("cooldown");
    expect(adapter.listCalls.length).toBe(1);
    expect(indexedChannels).toEqual(["123"]);

    store.close();
  });
});
