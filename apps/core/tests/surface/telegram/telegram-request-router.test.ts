import { describe, expect, it } from "bun:test";
import { Result } from "better-result";

import { createLilacBus, lilacEventTypes, type Message } from "@stanley2058/lilac-event-bus";

import type {
  RouterGateDecision,
  RouterGateInput,
} from "../../../src/surface/telegram/telegram-request-router";
import { startTelegramRequestRouter } from "../../../src/surface/telegram/telegram-request-router";
import type {
  SurfaceAdapter,
  SurfaceOperationResult,
  SurfaceOutputStream,
} from "../../../src/surface/adapter";
import { SurfaceOperationUnsupported } from "../../../src/surface/adapter";
import type {
  LimitOpts,
  MsgRef,
  SessionRef,
  SurfaceMessage,
  SurfaceSelf,
  SurfaceSession,
} from "../../../src/surface/types";
import { createInMemoryDeliveryBus } from "../../helpers/in-memory-delivery-bus";
import { getTestBlobStore } from "../../helpers/blob-store";
import { SurfaceAdapterTestBase } from "../../helpers/surface-adapter-test-base";

const CHAT = "1001";
const DISCORD_BOT_NAME = "lilac";
const TELEGRAM_BOT_NAME = "catalina";
const TELEGRAM_HANDLE = "Catalina_agentbot";
const TELEGRAM_BOT_ID = "8792842071";

/** Serves the Telegram history the router asks for during composition. */
class FakeTelegramAdapter extends SurfaceAdapterTestBase implements SurfaceAdapter {
  constructor(private readonly messages: Record<string, SurfaceMessage> = {}) {
    super();
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async getSelf(): Promise<SurfaceSelf> {
    return { platform: "telegram", userId: TELEGRAM_BOT_ID, userName: TELEGRAM_HANDLE };
  }
  async listSessions() {
    return Result.ok<SurfaceSession[]>([]);
  }
  async startOutput(sessionRef: SessionRef): Promise<SurfaceOperationResult<SurfaceOutputStream>> {
    return Result.err(
      new SurfaceOperationUnsupported({
        platform: sessionRef.platform,
        operation: "start-output",
        message: "Test adapter does not implement output streams",
      }),
    );
  }
  async sendMsg(sessionRef: SessionRef): Promise<SurfaceOperationResult<MsgRef>> {
    return Result.err(
      new SurfaceOperationUnsupported({
        platform: sessionRef.platform,
        operation: "send-message",
        message: "Test adapter does not implement message sending",
      }),
    );
  }
  async readMsg(msgRef: MsgRef) {
    if (msgRef.platform !== "telegram") {
      throw new Error(`expected telegram ref, received ${msgRef.platform}`);
    }
    return Result.ok(this.messages[`${msgRef.channelId}:${msgRef.messageId}`] ?? null);
  }
  async listMsg(sessionRef: SessionRef, opts?: LimitOpts) {
    const list = Object.values(this.messages)
      .filter((message) => message.session.channelId === sessionRef.channelId)
      .sort((left, right) => left.ts - right.ts);
    return Result.ok(list.slice(Math.max(0, list.length - (opts?.limit ?? 50))));
  }
  async editMsg() {
    return Result.ok(undefined);
  }
  async deleteMsg() {
    return Result.ok(undefined);
  }
  async getReplyContext(msgRef: MsgRef, opts?: LimitOpts) {
    return await this.listMsg({ platform: "telegram", channelId: msgRef.channelId }, opts);
  }
  async addReaction() {
    return Result.ok(undefined);
  }
  async removeReaction() {
    return Result.ok(undefined);
  }
  async listReactions() {
    return Result.ok<string[]>([]);
  }
  async subscribe() {
    return { stop: async () => {} };
  }
  async getUnRead() {
    return Result.ok<SurfaceMessage[]>([]);
  }
  async markRead() {
    return Result.ok(undefined);
  }
}

/**
 * Discord and Telegram deliberately carry different bot names here, so any path
 * that silently falls back to the Discord identity fails these tests.
 */
function routerConfig(
  input: {
    defaultMode?: "active" | "mention";
    sessionModes?: Record<string, { mode: "active" | "mention"; gate?: boolean }>;
  } = {},
): Record<string, unknown> {
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
        defaultMode: input.defaultMode ?? "active",
        sessionModes: input.sessionModes ?? {},
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

async function startRouter(
  adapter: SurfaceAdapter,
  opts: {
    config?: Record<string, unknown>;
    routerGate?: (input: RouterGateInput) => Promise<RouterGateDecision>;
    shouldSuppressAdapterEvent?: Parameters<
      typeof startTelegramRequestRouter
    >[0]["shouldSuppressAdapterEvent"];
  } = {},
) {
  const deliveries: string[] = [];
  const bus = createLilacBus(
    createInMemoryDeliveryBus((observation) => {
      if (observation.topic === "evt.adapter") deliveries.push(observation.disposition);
    }),
  );
  const published: Array<Message<unknown>> = [];

  await bus.subscribeTopic(
    "cmd.request",
    { mode: "fanout", subscriptionId: "sink", consumerId: "sink-1" },
    async (msg) => {
      if (msg.type === lilacEventTypes.CmdRequestMessage) published.push(msg);
      return Result.ok(undefined);
    },
    () => "park-pending",
  );

  const router = await startTelegramRequestRouter({
    adapter,
    bus,
    blobStore: await getTestBlobStore(),
    subscriptionId: "telegram-router-test",
    config: opts.config ?? routerConfig(),
    routerGate: opts.routerGate,
    shouldSuppressAdapterEvent: opts.shouldSuppressAdapterEvent,
  });

  return { bus, deliveries, published, router };
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

describe("the Telegram request router", () => {
  it("turns a telegram adapter event into a request tagged as telegram", async () => {
    const adapter = new FakeTelegramAdapter();
    const { bus, deliveries, published, router } = await startRouter(adapter);

    try {
      await publishTelegramMessage(bus, { messageId: "10", text: "hello there" });
      const msg = await waitForPublish(published);

      expect(msg.headers?.request_client).toBe("telegram");
      expect(msg.headers?.session_id).toBe(CHAT);
      expect(String(msg.headers?.request_id ?? "")).toStartWith("telegram:");
      expect(msg.data).toMatchObject({
        raw: {
          authenticatedOrigin: {
            platform: "telegram",
            userId: "7",
            messageRef: { platform: "telegram", channelId: CHAT, messageId: "10" },
          },
        },
      });
      expect(deliveries).toContain("commit");
    } finally {
      await router.stop();
    }
  });

  it("suppresses a workflow reply without blocking later Telegram messages", async () => {
    const adapter = new FakeTelegramAdapter();
    const { bus, published, router } = await startRouter(adapter, {
      shouldSuppressAdapterEvent: async ({ evt }) => ({
        suppress: evt.messageId === "10",
        ...(evt.messageId === "10" ? { reason: "workflow reply" } : {}),
      }),
    });

    try {
      await publishTelegramMessage(bus, { messageId: "10", text: "workflow answer" });
      expect(published).toHaveLength(0);

      await publishTelegramMessage(bus, { messageId: "11", text: "ordinary prompt" });
      const msg = await waitForPublish(published);
      expect(published).toHaveLength(1);
      expect(msg.headers?.request_id).toBe(`telegram:${CHAT}:11`);
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

  it("ignores lifecycle state owned by another platform", async () => {
    const adapter = new FakeTelegramAdapter({
      [`${CHAT}:10`]: surfaceMessage({ messageId: "10", text: "mine" }),
    });
    const { bus, published, router } = await startRouter(adapter);

    try {
      await bus.publish(
        lilacEventTypes.EvtRequestLifecycleChanged,
        { state: "running" },
        {
          headers: {
            request_id: `discord:${CHAT}:foreign`,
            session_id: CHAT,
            request_client: "discord",
          },
        },
      );
      await publishTelegramMessage(bus, { messageId: "10", text: "mine" });
      const msg = await waitForPublish(published);

      expect(msg.headers?.request_id).toBe(`telegram:${CHAT}:10`);
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

  it("passes Telegram replied-to text into the direct-reply gate", async () => {
    const repliedTo = surfaceMessage({
      messageId: "9",
      text: "the Telegram bot answer",
      userId: TELEGRAM_BOT_ID,
    });
    const trigger = surfaceMessage({
      messageId: "10",
      text: "@otherbot what do you think?",
      raw: telegramRaw({
        messageId: "10",
        isDMBased: false,
        mentionsBot: false,
        replyToBot: true,
        replyToMessageId: "9",
      }),
    });
    const adapter = new FakeTelegramAdapter({
      [`${CHAT}:9`]: repliedTo,
      [`${CHAT}:10`]: trigger,
    });
    const gateInputs: RouterGateInput[] = [];
    const config = routerConfig({
      defaultMode: "mention",
      sessionModes: { [CHAT]: { mode: "mention", gate: true } },
    });
    const { bus, published, router } = await startRouter(adapter, {
      config,
      routerGate: async (input) => {
        gateInputs.push(input);
        return { forward: false, reason: "addressed-to-peer" };
      },
    });

    try {
      await publishTelegramMessage(bus, {
        messageId: "10",
        text: trigger.text,
        raw: trigger.raw as Record<string, unknown>,
      });

      expect(published).toHaveLength(0);
      expect(gateInputs[0]?.context?.mode).toBe("direct-reply-mention-disambiguation");
      expect(gateInputs[0]?.context?.repliedToMessageText).toContain("Telegram bot answer");
    } finally {
      await router.stop();
    }
  });
});
