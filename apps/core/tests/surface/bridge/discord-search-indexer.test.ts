import { describe, expect, it } from "bun:test";
import { parseCoreConfigV1ToUniversal, type CoreConfig } from "@stanley2058/lilac-utils";

import type { AdapterEventHandler } from "../../../src/surface/adapter";
import type { AdapterEvent } from "../../../src/surface/events";
import { startDiscordSearchIndexer } from "../../../src/surface/bridge/discord-search-indexer";
import type {
  DiscordSearchIndexedMessage,
  DiscordSearchMessageMutation,
} from "../../../src/surface/store/discord-search-store";
import type { SurfaceMessage } from "../../../src/surface/types";

class FakeAdapter {
  handler: AdapterEventHandler | null = null;

  async subscribe(handler: AdapterEventHandler) {
    this.handler = handler;
    return { stop: async () => {} };
  }
}

function testConfig(): CoreConfig {
  return parseCoreConfigV1ToUniversal({
    surface: {
      discord: {
        botName: "lilac",
        allowedChannelIds: ["c1"],
      },
      router: {
        defaultMode: "mention",
        sessionModes: {},
      },
    },
  });
}

function discordMessage(): SurfaceMessage {
  return {
    ref: { platform: "discord", channelId: "c1", messageId: "m1" },
    session: { platform: "discord", channelId: "c1", guildId: "g1" },
    userId: "u1",
    text: "hello",
    ts: 1,
  };
}

function indexedMessage(text: string): DiscordSearchIndexedMessage {
  return {
    ref: { platform: "discord", channelId: "c1", messageId: "m1" },
    session: { platform: "discord", channelId: "c1", guildId: "g1" },
    userId: "u1",
    text,
    ts: 1,
    deleted: false,
    updatedTs: 1,
    attachments: [],
  };
}

type DirtyInput =
  | { channelId: string; kind: "topology" }
  | { channelId: string; kind: "content"; messageId: string };

describe("discord search indexer", () => {
  it("marks creates topology-dirty without waiting for materialization", async () => {
    const adapter = new FakeAdapter();
    const cfg = testConfig();
    const createdMessages: SurfaceMessage[] = [];
    const dirties: DirtyInput[] = [];

    await startDiscordSearchIndexer({
      eventSource: adapter,
      search: {
        async onMessageCreated(message) {
          createdMessages.push(message);
        },
        onMessageUpdated() {
          return null;
        },
        onMessageDeleted() {},
      },
      getConfig: async () => cfg,
      materializer: {
        markDirty(input) {
          dirties.push(input);
        },
      },
    });

    const evt: AdapterEvent = {
      type: "adapter.message.created",
      platform: "discord",
      ts: 1,
      message: discordMessage(),
    };

    await adapter.handler?.(evt);

    expect(createdMessages).toHaveLength(1);
    expect(dirties).toEqual([{ channelId: "c1", kind: "topology" }]);
  });

  it("keeps ordinary edits on the content-only path", async () => {
    const adapter = new FakeAdapter();
    const dirties: DirtyInput[] = [];
    const before = indexedMessage("partial reply");
    const after = { ...before, text: "final reply", editedTs: 2, updatedTs: 2 };
    const mutation: DiscordSearchMessageMutation = { before, after, changed: true };

    await startDiscordSearchIndexer({
      eventSource: adapter,
      search: {
        async onMessageCreated() {},
        onMessageUpdated() {
          return mutation;
        },
        onMessageDeleted() {},
      },
      getConfig: async () => testConfig(),
      materializer: {
        markDirty(input) {
          dirties.push(input);
        },
      },
    });

    await adapter.handler?.({
      type: "adapter.message.updated",
      platform: "discord",
      ts: 2,
      message: { ...discordMessage(), text: "final reply", editedTs: 2 },
    });

    expect(dirties).toEqual([{ channelId: "c1", messageId: "m1", kind: "content" }]);
  });

  it("marks structural edits topology-dirty and ignores duplicate updates", async () => {
    const adapter = new FakeAdapter();
    const dirties: DirtyInput[] = [];
    const before = indexedMessage("hello");
    let mutation: DiscordSearchMessageMutation = {
      before,
      after: { ...before, text: "[LILAC_SESSION_DIVIDER]", updatedTs: 2 },
      changed: true,
    };

    await startDiscordSearchIndexer({
      eventSource: adapter,
      search: {
        async onMessageCreated() {},
        onMessageUpdated() {
          return mutation;
        },
        onMessageDeleted() {},
      },
      getConfig: async () => testConfig(),
      materializer: {
        markDirty(input) {
          dirties.push(input);
        },
      },
    });

    const evt: AdapterEvent = {
      type: "adapter.message.updated",
      platform: "discord",
      ts: 2,
      message: { ...discordMessage(), text: "[LILAC_SESSION_DIVIDER]" },
    };
    await adapter.handler?.(evt);
    mutation = { before, after: before, changed: false };
    await adapter.handler?.(evt);

    expect(dirties).toEqual([{ channelId: "c1", kind: "topology" }]);
  });
});
