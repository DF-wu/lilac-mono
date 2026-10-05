import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Result } from "better-result";

import {
  EventDeliveryStopFailed,
  createLilacBus,
  lilacEventTypes,
  type LilacBus,
  type Message,
} from "@stanley2058/lilac-event-bus";

import { CustomCommandManager } from "../../../src/custom-commands/manager";
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
    return {
      platform: "telegram",
      userId: TELEGRAM_BOT_ID,
      userName: TELEGRAM_HANDLE,
    };
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

type Bus = Awaited<ReturnType<typeof createLilacBus>>;

async function startRouter(
  adapter: SurfaceAdapter,
  opts: {
    config?: Record<string, unknown>;
    customCommands?: CustomCommandManager;
    routerGate?: (input: RouterGateInput) => Promise<RouterGateDecision>;
    shouldSuppressAdapterEvent?: Parameters<
      typeof startTelegramRequestRouter
    >[0]["shouldSuppressAdapterEvent"];
  } = {},
) {
  const deliveries: string[] = [];
  const lifecycleDeliveries: string[] = [];
  const bus = createLilacBus(
    createInMemoryDeliveryBus((observation) => {
      if (observation.topic === "evt.adapter") deliveries.push(observation.disposition);
      if (observation.topic === "evt.request") lifecycleDeliveries.push(observation.disposition);
    }),
  );
  const published: Array<Message<unknown>> = [];
  const reanchors: Array<Message<unknown>> = [];

  await bus.subscribeTopic(
    "cmd.request",
    { mode: "fanout", subscriptionId: "sink", consumerId: "sink-1" },
    async (msg) => {
      if (msg.type === lilacEventTypes.CmdRequestMessage) published.push(msg);
      return Result.ok(undefined);
    },
    () => "park-pending",
  );
  await bus.subscribeTopic(
    "cmd.surface",
    {
      mode: "fanout",
      subscriptionId: "surface-sink",
      consumerId: "surface-sink-1",
    },
    async (msg) => {
      if (msg.type === lilacEventTypes.CmdSurfaceOutputReanchor) reanchors.push(msg);
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
    customCommands: opts.customCommands,
    routerGate: opts.routerGate,
    shouldSuppressAdapterEvent: opts.shouldSuppressAdapterEvent,
  });

  return { bus, deliveries, lifecycleDeliveries, published, reanchors, router };
}

async function publishTelegramMessage(
  bus: Bus,
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

function telegramRequestHeaders(requestId: string) {
  return {
    request_id: requestId,
    session_id: CHAT,
    request_client: "telegram",
  } as const;
}

/** What the agent runner reports back about a request the router started. */
async function publishLifecycle(bus: Bus, requestId: string, state: "running" | "resolved") {
  await bus.publish(
    lilacEventTypes.EvtRequestLifecycleChanged,
    { state },
    { headers: telegramRequestHeaders(requestId) },
  );
}

/** What the output relay reports when it posts a bot message for a request. */
async function publishOutputCreated(bus: Bus, requestId: string, messageId: string) {
  await bus.publish(
    lilacEventTypes.EvtSurfaceOutputMessageCreated,
    { msgRef: { platform: "telegram", channelId: CHAT, messageId } },
    { headers: telegramRequestHeaders(requestId) },
  );
}

/** Rejection-only guard; it never delays the successful path. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitForPublish(published: Array<Message<unknown>>): Promise<Message<unknown>> {
  await waitFor(() => published.length > 0, "a cmd.request.message");
  return published[0] as Message<unknown>;
}

async function waitForPublishCount(
  published: Array<Message<unknown>>,
  count: number,
): Promise<Array<Message<unknown>>> {
  await waitFor(() => published.length >= count, `${count} cmd.request.message publications`);
  return published;
}

type PublishedRequest = {
  queue: string;
  modelOverride?: string;
  messages: Array<{ role: string; content: unknown }>;
  raw: Record<string, unknown>;
};

function requestData(msg: Message<unknown>): PublishedRequest {
  return msg.data as PublishedRequest;
}

type PublishedReanchor = {
  inheritReplyTo: boolean;
  mode?: string;
  replyTo?: { platform: string; channelId: string; messageId: string };
};

function reanchorData(msg: Message<unknown>): PublishedReanchor {
  return msg.data as PublishedReanchor;
}

function groupRaw(messageId: string, overrides: Record<string, unknown> = {}) {
  return telegramRaw({
    messageId,
    isDMBased: false,
    mentionsBot: false,
    ...overrides,
  });
}

/** Publishes a DM, waits for its request and reports it running, as the runner would. */
async function startRunningDmRequest(
  bus: Bus,
  published: Array<Message<unknown>>,
  input: { messageId: string; text: string },
): Promise<string> {
  await publishTelegramMessage(bus, input);
  const first = await waitForPublish(published);
  const requestId = String(first.headers?.request_id ?? "");
  expect(requestId).toBe(`telegram:${CHAT}:${input.messageId}`);
  await publishLifecycle(bus, requestId, "running");
  return requestId;
}

/** A registry with one text command, laid out the way discovery expects on disk. */
async function loadCustomCommands(name: string): Promise<{
  manager: CustomCommandManager;
  cleanup: () => Promise<void>;
}> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "telegram-router-cmds-"));
  const dir = path.join(dataDir, "cmds", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "def.json"),
    JSON.stringify({ name, description: `${name} command`, args: [] }),
    "utf8",
  );
  await writeFile(path.join(dir, "index.ts"), "export async function execute() {}\n", "utf8");
  const manager = new CustomCommandManager(dataDir);
  await manager.init();
  return {
    manager,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

describe("the Telegram request router", () => {
  it("turns a telegram adapter event into a request tagged as telegram", async () => {
    const adapter = new FakeTelegramAdapter();
    const { bus, deliveries, published, router } = await startRouter(adapter);

    try {
      await publishTelegramMessage(bus, {
        messageId: "10",
        text: "hello there",
      });
      const msg = await waitForPublish(published);

      expect(msg.headers?.request_client).toBe("telegram");
      expect(msg.headers?.session_id).toBe(CHAT);
      expect(String(msg.headers?.request_id ?? "")).toStartWith("telegram:");
      expect(msg.data).toMatchObject({
        raw: {
          authenticatedOrigin: {
            platform: "telegram",
            userId: "7",
            messageRef: {
              platform: "telegram",
              channelId: CHAT,
              messageId: "10",
            },
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
      await publishTelegramMessage(bus, {
        messageId: "10",
        text: "workflow answer",
      });
      expect(published).toHaveLength(0);

      await publishTelegramMessage(bus, {
        messageId: "11",
        text: "ordinary prompt",
      });
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
        raw: telegramRaw({
          messageId: "12",
          mentionsBot: false,
          isDMBased: false,
        }),
      }),
    });
    const { bus, published, router } = await startRouter(adapter);

    await publishTelegramMessage(bus, {
      messageId: "12",
      text: "queued before restart",
      raw: telegramRaw({
        messageId: "12",
        mentionsBot: false,
        isDMBased: false,
      }),
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
      raw: telegramRaw({
        messageId: "10",
        replyToMessageId: "9",
        replyToBot: true,
      }),
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
        raw: telegramRaw({
          messageId: "10",
          replyToMessageId: "9",
          replyToBot: true,
        }),
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

describe("the Telegram request router in an active group", () => {
  it("forwards every buffered message of a debounce batch as one request", async () => {
    const adapter = new FakeTelegramAdapter({
      [`${CHAT}:30`]: surfaceMessage({
        messageId: "30",
        text: "first thought",
        raw: groupRaw("30"),
      }),
      [`${CHAT}:31`]: surfaceMessage({
        messageId: "31",
        text: "second thought",
        raw: groupRaw("31"),
      }),
    });
    const { bus, published, router } = await startRouter(adapter);

    try {
      await publishTelegramMessage(bus, {
        messageId: "30",
        text: "first thought",
        raw: groupRaw("30"),
      });
      await publishTelegramMessage(bus, {
        messageId: "31",
        text: "second thought",
        raw: groupRaw("31"),
      });
      const msg = await waitForPublish(published);

      expect(published).toHaveLength(1);
      // A gate-forwarded batch answers no single message, so it gets a generic id.
      expect(String(msg.headers?.request_id ?? "")).toStartWith("req:");
      const data = requestData(msg);
      expect(data.queue).toBe("prompt");
      const serialized = JSON.stringify(data.messages);
      expect(serialized).toContain("first thought");
      expect(serialized).toContain("second thought");
      expect(data.raw.chainMessageIds).toEqual(["30", "31"]);
      expect(data.raw.participantUserIds).toEqual(["7"]);
      expect(data.raw.triggerType).toBe("active");
    } finally {
      await router.stop();
    }
  });

  it("drops a debounce batch the active-batch gate declines", async () => {
    const adapter = new FakeTelegramAdapter({
      [`${CHAT}:30`]: surfaceMessage({
        messageId: "30",
        text: "idle chatter",
        raw: groupRaw("30"),
      }),
      [`${CHAT}:31`]: surfaceMessage({
        messageId: "31",
        text: "more chatter",
        raw: groupRaw("31"),
      }),
    });
    const gateInputs: RouterGateInput[] = [];
    const { bus, published, router } = await startRouter(adapter, {
      config: routerConfig({
        sessionModes: { [CHAT]: { mode: "active", gate: true } },
      }),
      routerGate: async (input) => {
        gateInputs.push(input);
        return { forward: false, reason: "not-addressed" };
      },
    });

    try {
      await publishTelegramMessage(bus, {
        messageId: "30",
        text: "idle chatter",
        raw: groupRaw("30"),
      });
      await publishTelegramMessage(bus, {
        messageId: "31",
        text: "more chatter",
        raw: groupRaw("31"),
      });
      await waitFor(() => gateInputs.length > 0, "the active-batch gate");

      expect(gateInputs).toHaveLength(1);
      expect(gateInputs[0]?.context?.mode).toBe("active-batch");
      expect(gateInputs[0]?.sessionId).toBe(CHAT);
      expect(gateInputs[0]?.botName).toBe(TELEGRAM_BOT_NAME);
      expect(gateInputs[0]?.messages.map((message) => message.text)).toEqual([
        "idle chatter",
        "more chatter",
      ]);
      // The decline resolved before the gate call was observed; nothing follows it.
      expect(published).toHaveLength(0);
    } finally {
      await router.stop();
    }
  });

  it("forwards a debounce batch the active-batch gate accepts", async () => {
    const adapter = new FakeTelegramAdapter({
      [`${CHAT}:30`]: surfaceMessage({
        messageId: "30",
        text: "can someone help",
        raw: groupRaw("30"),
      }),
      [`${CHAT}:31`]: surfaceMessage({
        messageId: "31",
        text: "with the deploy",
        raw: groupRaw("31"),
      }),
    });
    const gateInputs: RouterGateInput[] = [];
    const { bus, published, router } = await startRouter(adapter, {
      config: routerConfig({
        sessionModes: { [CHAT]: { mode: "active", gate: true } },
      }),
      routerGate: async (input) => {
        gateInputs.push(input);
        return { forward: true, reason: "asks-for-help" };
      },
    });

    try {
      await publishTelegramMessage(bus, {
        messageId: "30",
        text: "can someone help",
        raw: groupRaw("30"),
      });
      await publishTelegramMessage(bus, {
        messageId: "31",
        text: "with the deploy",
        raw: groupRaw("31"),
      });
      const msg = await waitForPublish(published);

      expect(gateInputs).toHaveLength(1);
      expect(gateInputs[0]?.context?.mode).toBe("active-batch");
      expect(published).toHaveLength(1);
      expect(String(msg.headers?.request_id ?? "")).toStartWith("req:");
      const serialized = JSON.stringify(requestData(msg).messages);
      expect(serialized).toContain("can someone help");
      expect(serialized).toContain("with the deploy");
    } finally {
      await router.stop();
    }
  });

  it("queues a plain message behind the running request as a buffered prompt", async () => {
    const activeRequestId = "req:active-group-request";
    const adapter = new FakeTelegramAdapter({
      [`${CHAT}:40`]: surfaceMessage({
        messageId: "40",
        text: "one more thing",
        raw: groupRaw("40"),
      }),
    });
    const { bus, published, router } = await startRouter(adapter);

    try {
      await publishLifecycle(bus, activeRequestId, "running");
      await publishTelegramMessage(bus, {
        messageId: "40",
        text: "one more thing",
        raw: groupRaw("40"),
      });
      const msg = await waitForPublish(published);

      expect(published).toHaveLength(1);
      expect(msg.headers?.request_id).toBe(`queued:${activeRequestId}`);
      const data = requestData(msg);
      expect(data.queue).toBe("prompt");
      expect(data.raw.bufferedForActiveRequestId).toBe(activeRequestId);
      expect(data.raw.triggerType).toBe("active");
      expect(JSON.stringify(data.messages)).toContain("one more thing");
    } finally {
      await router.stop();
    }
  });
});

describe("the Telegram request router while a DM request is running", () => {
  it("joins a plain follow-up message to the running request", async () => {
    const adapter = new FakeTelegramAdapter();
    const { bus, published, router } = await startRouter(adapter);

    try {
      const requestId = await startRunningDmRequest(bus, published, {
        messageId: "10",
        text: "hello there",
      });
      await publishTelegramMessage(bus, {
        messageId: "11",
        text: "and also this",
        raw: telegramRaw({ messageId: "11", mentionsBot: false }),
      });
      const [, followUp] = await waitForPublishCount(published, 2);

      expect(published).toHaveLength(2);
      expect(followUp?.headers?.request_id).toBe(requestId);
      const data = requestData(followUp!);
      expect(data.queue).toBe("followUp");
      expect(JSON.stringify(data.messages)).toContain("and also this");
    } finally {
      await router.stop();
    }
  });

  it("steers the running request when the user replies to its output with a mention", async () => {
    const adapter = new FakeTelegramAdapter();
    const { bus, published, reanchors, router } = await startRouter(adapter);

    try {
      const requestId = await startRunningDmRequest(bus, published, {
        messageId: "10",
        text: "hello there",
      });
      await publishOutputCreated(bus, requestId, "500");
      await publishTelegramMessage(bus, {
        messageId: "12",
        text: "focus on the second point",
        raw: telegramRaw({
          messageId: "12",
          mentionsBot: true,
          replyToBot: true,
          replyToMessageId: "500",
        }),
      });
      const [, steer] = await waitForPublishCount(published, 2);
      await waitFor(() => reanchors.length > 0, "a cmd.surface.output.reanchor");

      expect(reanchors).toHaveLength(1);
      expect(reanchors[0]?.headers?.request_id).toBe(requestId);
      expect(reanchors[0]?.headers?.request_client).toBe("telegram");
      const reanchor = reanchorData(reanchors[0]!);
      expect(reanchor.mode).toBe("steer");
      expect(reanchor.inheritReplyTo).toBe(false);
      expect(reanchor.replyTo).toEqual({
        platform: "telegram",
        channelId: CHAT,
        messageId: "12",
      });

      expect(steer?.headers?.request_id).toBe(requestId);
      const data = requestData(steer!);
      expect(data.queue).toBe("steer");
      expect(JSON.stringify(data.messages)).toContain("focus on the second point");
    } finally {
      await router.stop();
    }
  });

  it("interrupts the running request on !interrupt and hides the directive from the model", async () => {
    const adapter = new FakeTelegramAdapter();
    const { bus, published, reanchors, router } = await startRouter(adapter);

    try {
      const requestId = await startRunningDmRequest(bus, published, {
        messageId: "10",
        text: "hello there",
      });
      await publishOutputCreated(bus, requestId, "500");
      await publishTelegramMessage(bus, {
        messageId: "13",
        text: `@${TELEGRAM_HANDLE} !interrupt stop`,
        raw: telegramRaw({
          messageId: "13",
          mentionsBot: true,
          replyToBot: true,
          replyToMessageId: "500",
        }),
      });
      const [, interrupt] = await waitForPublishCount(published, 2);
      await waitFor(() => reanchors.length > 0, "a cmd.surface.output.reanchor");

      expect(reanchors).toHaveLength(1);
      const reanchor = reanchorData(reanchors[0]!);
      expect(reanchor.mode).toBe("interrupt");
      expect(reanchor.replyTo?.messageId).toBe("13");

      expect(interrupt?.headers?.request_id).toBe(requestId);
      const data = requestData(interrupt!);
      expect(data.queue).toBe("interrupt");
      const serialized = JSON.stringify(data.messages);
      expect(serialized).toContain("stop");
      expect(serialized).not.toContain("!interrupt");
    } finally {
      await router.stop();
    }
  });
});

describe("the Telegram request router in mention mode", () => {
  it("holds a reply to the active output until the source request settles", async () => {
    const adapter = new FakeTelegramAdapter();
    const { bus, published, router } = await startRouter(adapter, {
      config: routerConfig({ defaultMode: "mention" }),
    });

    try {
      await publishTelegramMessage(bus, {
        messageId: "20",
        text: `@${TELEGRAM_HANDLE} hello`,
        raw: groupRaw("20", { mentionsBot: true }),
      });
      const first = await waitForPublish(published);
      const requestA = String(first.headers?.request_id ?? "");
      expect(requestA).toBe(`telegram:${CHAT}:20`);
      await publishLifecycle(bus, requestA, "running");
      await publishOutputCreated(bus, requestA, "600");

      // A bare reply to the bot's output is not a steer; it waits for request A.
      await publishTelegramMessage(bus, {
        messageId: "21",
        text: "what about the edge cases?",
        raw: groupRaw("21", { replyToBot: true, replyToMessageId: "600" }),
      });
      expect(published).toHaveLength(1);

      await publishLifecycle(bus, requestA, "resolved");
      const [, pending] = await waitForPublishCount(published, 2);

      expect(published).toHaveLength(2);
      expect(pending?.headers?.request_id).toBe(`telegram:${CHAT}:21`);
      const data = requestData(pending!);
      expect(data.queue).toBe("prompt");
      expect(data.raw.triggerType).toBe("reply");
      expect(JSON.stringify(data.messages)).toContain("what about the edge cases?");
    } finally {
      await router.stop();
    }
  });
});

describe("the Telegram request router with custom commands", () => {
  it("publishes a custom command from the trigger alone, without its reply chain", async () => {
    const ancestor: SurfaceMessage = {
      ref: { platform: "telegram", channelId: CHAT, messageId: "9" },
      session: { platform: "telegram", channelId: CHAT },
      userId: TELEGRAM_BOT_ID,
      userName: TELEGRAM_HANDLE,
      text: "the earlier answer worth remembering",
      ts: Date.now() - 10_000,
      raw: telegramRaw({ messageId: "9" }),
    };
    const commandText = "/lilac:hello";
    const trigger = surfaceMessage({
      messageId: "10",
      text: commandText,
      raw: telegramRaw({
        messageId: "10",
        replyToMessageId: "9",
        replyToBot: true,
      }),
    });
    const adapter = new FakeTelegramAdapter({
      [`${CHAT}:9`]: ancestor,
      [`${CHAT}:10`]: trigger,
    });
    const commands = await loadCustomCommands("hello");
    const { bus, published, router } = await startRouter(adapter, {
      customCommands: commands.manager,
    });

    try {
      await publishTelegramMessage(bus, {
        messageId: "10",
        text: commandText,
        raw: trigger.raw as Record<string, unknown>,
      });
      const msg = await waitForPublish(published);

      expect(msg.headers?.request_id).toBe(`telegram:${CHAT}:10`);
      const data = requestData(msg);
      expect(data.queue).toBe("prompt");
      expect(data.raw.customCommand).toMatchObject({
        name: "hello",
        source: "text",
      });
      expect(data.raw.chainMessageIds).toEqual(["10"]);
      expect(JSON.stringify(data.messages)).not.toContain("the earlier answer worth remembering");
    } finally {
      await router.stop();
      await commands.cleanup();
    }
  });
});

/** Fails the first indexed read of one message, the way a transient store error would. */
class FlakyReadAdapter extends FakeTelegramAdapter {
  private failed = false;

  constructor(private readonly failOnceFor: string) {
    super();
  }

  override async readMsg(msgRef: MsgRef) {
    if (!this.failed && msgRef.messageId === this.failOnceFor) {
      this.failed = true;
      throw new Error("transient index failure");
    }
    return super.readMsg(msgRef);
  }
}

describe("the Telegram request router when flushing deferred replies fails", () => {
  it("keeps the replies and the active correlation until a redelivery flushes them", async () => {
    const adapter = new FlakyReadAdapter("21");
    const { bus, lifecycleDeliveries, published, router } = await startRouter(adapter, {
      config: routerConfig({ defaultMode: "mention" }),
    });

    try {
      await publishTelegramMessage(bus, {
        messageId: "20",
        text: `@${TELEGRAM_HANDLE} hello`,
        raw: groupRaw("20", { mentionsBot: true }),
      });
      const first = await waitForPublish(published);
      const requestA = String(first.headers?.request_id ?? "");
      await publishLifecycle(bus, requestA, "running");
      await publishOutputCreated(bus, requestA, "600");
      await publishTelegramMessage(bus, {
        messageId: "21",
        text: "what about the edge cases?",
        raw: groupRaw("21", { replyToBot: true, replyToMessageId: "600" }),
      });
      expect(published).toHaveLength(1);

      // The first settle attempt composes the deferred reply, hits the read
      // failure, and is parked for redelivery. Nothing may be lost here.
      await publishLifecycle(bus, requestA, "resolved");
      await waitFor(() => lifecycleDeliveries.includes("park-pending"), "the parked settle event");
      expect(published).toHaveLength(1);

      // Redelivery finds both the batch and the request it belonged to.
      await publishLifecycle(bus, requestA, "resolved");
      const [, flushed] = await waitForPublishCount(published, 2);
      expect(flushed?.headers?.request_id).toBe(`telegram:${CHAT}:21`);
      const data = requestData(flushed!);
      expect(data.queue).toBe("prompt");
      expect(data.raw.triggerType).toBe("reply");
      expect(JSON.stringify(data.messages)).toContain("what about the edge cases?");
    } finally {
      await router.stop();
    }
  });
});

describe("the Telegram request router when a subscription refuses to stop", () => {
  it("still stops the remaining subscriptions before reporting the failure", async () => {
    const inner = createLilacBus(createInMemoryDeliveryBus());
    const stoppedTopics: string[] = [];
    const subscribeTopic: LilacBus["subscribeTopic"] = async (topic, opts, handler, policy) => {
      const started = await inner.subscribeTopic(topic, opts, handler, policy);
      return started.map((subscription) => ({
        done: subscription.done,
        stop: async () => {
          stoppedTopics.push(topic);
          await subscription.stop();
          if (topic !== "evt.surface") return Result.ok(undefined);
          return Result.err(
            new EventDeliveryStopFailed({
              cause: new Error("forced stop failure"),
              topic,
              message: "Forced stop failure",
            }),
          );
        },
      }));
    };
    const bus: LilacBus = { ...inner, subscribeTopic };
    const router = await startTelegramRequestRouter({
      adapter: new FakeTelegramAdapter(),
      bus,
      blobStore: await getTestBlobStore(),
      subscriptionId: "telegram-router-stop-test",
      config: routerConfig(),
    });

    await expect(router.stop()).rejects.toBeInstanceOf(EventDeliveryStopFailed);
    expect([...stoppedTopics].sort()).toEqual(["evt.adapter", "evt.request", "evt.surface"]);
  });
});
