import { describe, expect, it } from "bun:test";

import {
  createLilacBus,
  lilacEventTypes,
  type HandleContext,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";

import { startBusRequestRouter } from "../../../src/surface/bridge/bus-request-router";
import type { SurfaceAdapter, SurfaceOutputStream } from "../../../src/surface/adapter";
import type {
  AdapterCapabilities,
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfaceSelf,
  SurfaceSession,
} from "../../../src/surface/types";

const CHAT = "1001";
const DISCORD_BOT_NAME = "lilac";
const TELEGRAM_BOT_NAME = "catalina";
const TELEGRAM_HANDLE = "Catalina_agentbot";
const TELEGRAM_BOT_ID = "8792842071";

function createInMemoryRawBus(): RawBus {
  const topics = new Map<string, Array<Message<unknown>>>();
  const subs = new Set<{
    topic: string;
    handler: (msg: Message<unknown>, ctx: HandleContext) => Promise<void>;
  }>();

  return {
    publish: async <TData>(msg: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
      const id = `${Date.now()}-${topics.get(opts.topic)?.length ?? 0}`;
      const stored: Message<unknown> = {
        topic: opts.topic,
        id,
        type: opts.type,
        ts: Date.now(),
        key: opts.key,
        headers: opts.headers,
        data: msg.data as unknown,
      };

      topics.set(opts.topic, [...(topics.get(opts.topic) ?? []), stored]);
      for (const s of subs) {
        if (s.topic !== opts.topic) continue;
        await s.handler(stored, { cursor: id, commit: async () => {} });
      }
      return { id, cursor: id };
    },

    subscribe: async <TData>(
      topic: string,
      _opts: SubscriptionOptions,
      handler: (msg: Message<TData>, ctx: HandleContext) => Promise<void>,
    ) => {
      const entry = {
        topic,
        handler: handler as (msg: Message<unknown>, ctx: HandleContext) => Promise<void>,
      };
      subs.add(entry);
      return { stop: async () => void subs.delete(entry) };
    },

    fetch: async <TData>(topic: string) => {
      const existing = topics.get(topic) ?? [];
      return {
        messages: existing.map((m) => ({ msg: m as unknown as Message<TData>, cursor: m.id })),
        ...(existing.length > 0 ? { next: existing[existing.length - 1]?.id } : {}),
      };
    },

    close: async () => {},
  };
}

/** Serves the Telegram history the router asks for during composition. */
class FakeTelegramAdapter implements SurfaceAdapter {
  constructor(private readonly messages: Record<string, SurfaceMessage> = {}) {}

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async getSelf(): Promise<SurfaceSelf> {
    return { platform: "telegram", userId: TELEGRAM_BOT_ID, userName: TELEGRAM_HANDLE };
  }
  async getCapabilities(): Promise<AdapterCapabilities> {
    throw new Error("not implemented");
  }
  async listSessions(): Promise<SurfaceSession[]> {
    return [];
  }
  async startOutput(_sessionRef: SessionRef): Promise<SurfaceOutputStream> {
    throw new Error("not implemented");
  }
  async sendMsg(_s: SessionRef, _c: ContentOpts, _o?: SendOpts): Promise<MsgRef> {
    throw new Error("not implemented");
  }
  async readMsg(msgRef: MsgRef): Promise<SurfaceMessage | null> {
    return this.messages[`${msgRef.channelId}:${msgRef.messageId}`] ?? null;
  }
  async listMsg(sessionRef: SessionRef, opts?: LimitOpts): Promise<SurfaceMessage[]> {
    const list = Object.values(this.messages)
      .filter((m) => m.session.channelId === sessionRef.channelId)
      .sort((a, b) => a.ts - b.ts);
    return list.slice(Math.max(0, list.length - (opts?.limit ?? 50)));
  }
  async editMsg(): Promise<void> {}
  async deleteMsg(): Promise<void> {}
  async getReplyContext(msgRef: MsgRef, opts?: LimitOpts): Promise<SurfaceMessage[]> {
    return await this.listMsg({ platform: "telegram", channelId: msgRef.channelId }, opts);
  }
  async addReaction(): Promise<void> {}
  async removeReaction(): Promise<void> {}
  async listReactions(): Promise<string[]> {
    return [];
  }
  async subscribe() {
    return { stop: async () => {} };
  }
  async getUnRead(): Promise<SurfaceMessage[]> {
    return [];
  }
  async markRead(): Promise<void> {}
}

/**
 * Discord and Telegram deliberately carry different bot names here, so any path
 * that silently falls back to the Discord identity fails these tests.
 */
function routerConfig(): Record<string, unknown> {
  return {
    configVersion: 2,
    surface: {
      discord: { botName: DISCORD_BOT_NAME },
      telegram: {
        enabled: true,
        botName: TELEGRAM_BOT_NAME,
        botUsername: TELEGRAM_HANDLE,
        allowedChatIds: [CHAT],
      },
      router: {
        defaultMode: "active",
        sessionModes: {},
        activeDebounceMs: 1,
        activeGate: { enabled: false, timeoutMs: 2500 },
      },
    },
  };
}

function surfaceMessage(input: {
  messageId: string;
  text: string;
  userId?: string;
  raw?: Record<string, unknown>;
}): SurfaceMessage {
  return {
    ref: { platform: "telegram", channelId: CHAT, messageId: input.messageId },
    session: { platform: "telegram", channelId: CHAT },
    userId: input.userId ?? "7",
    userName: "ada",
    text: input.text,
    ts: Date.now(),
    raw: input.raw ?? telegramRaw({ messageId: input.messageId }),
  };
}

function telegramRaw(overrides: Record<string, unknown> = {}) {
  return {
    telegram: {
      isDMBased: true,
      mentionsBot: true,
      replyToBot: false,
      chatId: CHAT,
      messageId: "10",
      botUserId: TELEGRAM_BOT_ID,
      ...overrides,
    },
  };
}

async function startRouter(adapter: SurfaceAdapter) {
  const bus = createLilacBus(createInMemoryRawBus());
  const published: Array<Message<unknown>> = [];

  await bus.subscribeTopic(
    "cmd.request",
    { mode: "fanout", subscriptionId: "sink", consumerId: "sink-1", offset: { type: "now" } },
    async (msg, ctx) => {
      if (msg.type === lilacEventTypes.CmdRequestMessage) published.push(msg);
      await ctx.commit();
    },
  );

  const router = await startBusRequestRouter({
    adapter,
    bus,
    platform: "telegram",
    subscriptionId: "telegram-router-test",
    config: routerConfig(),
  });

  return { bus, published, router };
}

async function publishTelegramMessage(
  bus: Awaited<ReturnType<typeof createLilacBus>>,
  input: { messageId: string; text: string; raw?: Record<string, unknown> },
) {
  await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
    platform: "telegram",
    channelId: CHAT,
    messageId: input.messageId,
    userId: "7",
    userName: "ada",
    text: input.text,
    ts: Date.now(),
    raw: input.raw ?? telegramRaw({ messageId: input.messageId }),
  });
}

/** Rejection-only guard; it never delays the successful path. */
async function waitForPublish(published: Array<Message<unknown>>): Promise<Message<unknown>> {
  const deadline = Date.now() + 5_000;
  while (published.length === 0) {
    if (Date.now() > deadline) throw new Error("router published no cmd.request.message");
    await new Promise((resolve) => setImmediate(resolve));
  }
  return published[0] as Message<unknown>;
}

describe("the shared router serving the telegram surface", () => {
  it("turns a telegram adapter event into a request tagged as telegram", async () => {
    const adapter = new FakeTelegramAdapter();
    const { bus, published, router } = await startRouter(adapter);

    try {
      await publishTelegramMessage(bus, { messageId: "10", text: "hello there" });
      const msg = await waitForPublish(published);

      expect(msg.headers?.request_client).toBe("telegram");
      expect(msg.headers?.session_id).toBe(CHAT);
      expect(String(msg.headers?.request_id ?? "")).toStartWith("telegram:");
    } finally {
      await router.stop();
    }
  });

  it("flushes active debounce buffers before stopping", async () => {
    const adapter = new FakeTelegramAdapter({
      [`${CHAT}:12`]: surfaceMessage({
        messageId: "12",
        text: "queued before restart",
        raw: telegramRaw({ messageId: "12", mentionsBot: false, isDMBased: false }),
      }),
    });
    const { bus, published, router } = await startRouter(adapter);

    await publishTelegramMessage(bus, {
      messageId: "12",
      text: "queued before restart",
      raw: telegramRaw({ messageId: "12", mentionsBot: false, isDMBased: false }),
    });
    expect(published).toHaveLength(0);

    await router.stop();

    expect(published).toHaveLength(1);
    expect(JSON.stringify(published[0]?.data)).toContain("queued before restart");
  });

  it("ignores adapter events from another platform", async () => {
    // One router instance serves one adapter; a Discord event must not leak in.
    const adapter = new FakeTelegramAdapter();
    const { bus, published, router } = await startRouter(adapter);

    try {
      await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
        platform: "discord",
        channelId: CHAT,
        messageId: "99",
        userId: "7",
        text: "not mine",
        ts: Date.now(),
      });

      // Follow with a Telegram event: once it has been routed, the earlier
      // Discord one has demonstrably been seen and discarded. Asserting on an
      // observable outcome rather than waiting out a silence.
      await publishTelegramMessage(bus, { messageId: "10", text: "mine" });
      const msg = await waitForPublish(published);

      expect(published).toHaveLength(1);
      expect(msg.headers?.request_client).toBe("telegram");
    } finally {
      await router.stop();
    }
  });

  it("parses a leading model override against the telegram name, not the discord one", async () => {
    // The directive only parses once the leading @handle is recognised as this
    // bot, so a Discord-name fallback would make this return undefined.
    const text = `@${TELEGRAM_HANDLE} !model:sonnet what is 2+2?`;
    const adapter = new FakeTelegramAdapter({
      [`${CHAT}:10`]: surfaceMessage({ messageId: "10", text }),
    });
    const { bus, published, router } = await startRouter(adapter);

    try {
      await publishTelegramMessage(bus, { messageId: "10", text });
      const msg = await waitForPublish(published);

      const data = msg.data as { modelOverride?: string };
      expect(data.modelOverride).toBe("sonnet");
    } finally {
      await router.stop();
    }
  });

  it("strips the telegram handle from the text the model sees", async () => {
    const text = `@${TELEGRAM_HANDLE} summarise this`;
    const adapter = new FakeTelegramAdapter({
      [`${CHAT}:10`]: surfaceMessage({ messageId: "10", text }),
    });
    const { bus, published, router } = await startRouter(adapter);

    try {
      await publishTelegramMessage(bus, { messageId: "10", text });
      const msg = await waitForPublish(published);

      const data = msg.data as { messages: Array<{ content: unknown }> };
      const serialized = JSON.stringify(data.messages);
      expect(serialized).toContain("summarise this");
      // The Discord name must never appear on a Telegram request.
      expect(serialized).not.toContain(`@${DISCORD_BOT_NAME}`);
    } finally {
      await router.stop();
    }
  });

  it("pulls the replied-to ancestor into context", async () => {
    // Regression guard: the reply reference lives in raw.telegram, and the
    // shared extractor previously only understood the Discord envelope, so
    // chains stopped at the trigger message.
    const ancestor: SurfaceMessage = {
      ref: { platform: "telegram", channelId: CHAT, messageId: "9" },
      session: { platform: "telegram", channelId: CHAT },
      userId: TELEGRAM_BOT_ID,
      userName: TELEGRAM_HANDLE,
      text: "the earlier answer worth remembering",
      ts: Date.now() - 10_000,
      raw: telegramRaw({ messageId: "9" }),
    };

    const trigger: SurfaceMessage = {
      ref: { platform: "telegram", channelId: CHAT, messageId: "10" },
      session: { platform: "telegram", channelId: CHAT },
      userId: "7",
      userName: "ada",
      text: "expand on that",
      ts: Date.now(),
      raw: telegramRaw({ messageId: "10", replyToMessageId: "9", replyToBot: true }),
    };

    const adapter = new FakeTelegramAdapter({
      [`${CHAT}:9`]: ancestor,
      [`${CHAT}:10`]: trigger,
    });
    const { bus, published, router } = await startRouter(adapter);

    try {
      await publishTelegramMessage(bus, {
        messageId: "10",
        text: "expand on that",
        raw: telegramRaw({ messageId: "10", replyToMessageId: "9", replyToBot: true }),
      });
      const msg = await waitForPublish(published);

      const data = msg.data as { messages: Array<{ content: unknown }> };
      expect(JSON.stringify(data.messages)).toContain("the earlier answer worth remembering");
    } finally {
      await router.stop();
    }
  });
});
