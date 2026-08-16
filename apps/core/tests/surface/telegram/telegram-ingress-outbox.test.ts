import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils/core-config/v2";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import type { Update } from "grammy/types";

import { TelegramAdapter } from "../../../src/surface/telegram/telegram-adapter";
import { buildTelegramCancelCallbackData } from "../../../src/surface/telegram/output/telegram-output-stream";
import {
  parseStoredAdapterEvent,
  telegramIngressDedupeKey,
} from "../../../src/surface/telegram/telegram-ingress";
import { TelegramSurfaceStore } from "../../../src/surface/telegram/store/telegram-surface-store";
import type { AdapterEvent } from "../../../src/surface/events";
import { FakeBotApiServer } from "./fake-bot-api-server";
import { BOT_USER_ID, BOT_USERNAME, makeMessage } from "./telegram-fixtures";

/**
 * grammY sets `lastTriedUpdateId = update.update_id` *before* calling the
 * update handler (`bot.js`), so the poll offset has already advanced by the
 * time a publish fails. Telegram will never resend that update, which means
 * rethrowing out of the handler cannot recover it and retrying inside the
 * handler only helps if the process survives.
 *
 * The outbox is the only mechanism that can: commit before publishing, delete
 * after the bus accepts, replay whatever is left on the next start.
 */
const CHAT = 1001;

let server: FakeBotApiServer;
let adapter: TelegramAdapter | null = null;
let scratchDir = "";

function dbPath(): string {
  return path.join(scratchDir, "telegram.db");
}

function testConfig(): CoreConfig {
  const cfg = parseCoreConfigV2ToUniversal({
    configVersion: 2,
    surface: {
      telegram: {
        enabled: true,
        token: "000000:fake-token",
        botName: "lilac",
        allowedChatIds: [String(CHAT)],
        commandMenu: false,
      },
    },
  });
  return { ...cfg, agent: { ...cfg.agent, systemPrompt: "(test)" } };
}

function makeAdapter(): TelegramAdapter {
  const cfg = testConfig();
  return new TelegramAdapter({
    apiRoot: server.url,
    getConfig: async () => ({
      ...cfg,
      surface: { ...cfg.surface, telegram: { ...cfg.surface.telegram, dbPath: dbPath() } },
    }),
  });
}

function inboundMessage(messageId: number, text: string): NonNullable<Update["message"]> {
  return makeMessage({
    message_id: messageId,
    chat: { id: CHAT, type: "private", first_name: "Ada" },
    from: { id: 7, is_bot: false, first_name: "Ada" },
    text,
  }) as NonNullable<Update["message"]>;
}

/** Resolves once the outbox reaches `expected`, without a fixed wait. */
async function waitForPending(expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const store = new TelegramSurfaceStore(dbPath());
    const count = store.countPendingIngress();
    store.close();
    if (count === expected) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${expected} pending ingress entries`);
}

beforeEach(async () => {
  scratchDir = await mkdtemp(path.join(tmpdir(), "lilac-telegram-outbox-"));
  server = new FakeBotApiServer(BOT_USER_ID, BOT_USERNAME);
});

afterEach(async () => {
  await adapter?.disconnect();
  adapter = null;
  await server.close();
  await rm(scratchDir, { recursive: true, force: true });
});

describe("ingress dedupe keys", () => {
  const messageEvent = (messageId: string, editedTs?: number): AdapterEvent => ({
    type: "adapter.message.updated",
    platform: "telegram",
    ts: 1_700_000_000_000,
    message: {
      ref: { platform: "telegram", channelId: "1001", messageId },
      session: { platform: "telegram", channelId: "1001" },
      userId: "7",
      userName: "ada",
      text: "hi",
      ts: 1_700_000_000_000,
      ...(editedTs === undefined ? {} : { editedTs }),
    },
  });

  it("distinguishes two edits of the same message", () => {
    // Keying an edit on the message id alone would make the second edit look
    // like a duplicate of the first and silently drop it.
    const first = telegramIngressDedupeKey(messageEvent("10", 1_000));
    const second = telegramIngressDedupeKey(messageEvent("10", 2_000));

    expect(first).not.toBe(second);
  });

  it("gives the same key to the same event twice", () => {
    expect(telegramIngressDedupeKey(messageEvent("10", 1_000))).toBe(
      telegramIngressDedupeKey(messageEvent("10", 1_000)),
    );
  });

  it("separates a reaction from its removal, and one emoji from another", () => {
    const base = {
      platform: "telegram" as const,
      ts: 1,
      messageRef: { platform: "telegram" as const, channelId: "1001", messageId: "10" },
      session: { platform: "telegram" as const, channelId: "1001" },
      userId: "7",
    };

    const added = telegramIngressDedupeKey({
      ...base,
      type: "adapter.reaction.added",
      reaction: "👍",
    });
    const removed = telegramIngressDedupeKey({
      ...base,
      type: "adapter.reaction.removed",
      reaction: "👍",
    });
    const other = telegramIngressDedupeKey({
      ...base,
      type: "adapter.reaction.added",
      reaction: "🎉",
    });

    expect(new Set([added, removed, other]).size).toBe(3);
  });

  it("refuses to queue interactive events", () => {
    // Replaying a cancel after a restart would abort a different request than
    // the one the user clicked on. Losing it is the safer failure.
    expect(
      telegramIngressDedupeKey({
        type: "adapter.request.cancel",
        platform: "telegram",
        ts: 1,
        requestId: "telegram:1001:10",
        sessionId: "1001",
      }),
    ).toBeNull();

    expect(
      telegramIngressDedupeKey({
        type: "adapter.action.invoked",
        platform: "telegram",
        ts: 1,
        actionId: "a",
        userId: "7",
        messageRef: { platform: "telegram", channelId: "1001", messageId: "10" },
      }),
    ).toBeNull();

    expect(
      telegramIngressDedupeKey({
        type: "adapter.command.invoked",
        platform: "discord",
        ts: 1,
        requestId: "discord:1001:10",
        sessionId: "1001",
        commandName: "inspect",
        args: [],
        text: "/inspect",
        sessionMode: "mention",
        sessionConfigId: "1001",
      }),
    ).toBeNull();
  });
});

describe("stored payload parsing", () => {
  it("round-trips an event through JSON", () => {
    const evt: AdapterEvent = {
      type: "adapter.message.created",
      platform: "telegram",
      ts: 1_700_000_000_000,
      message: {
        ref: { platform: "telegram", channelId: "1001", messageId: "10" },
        session: { platform: "telegram", channelId: "1001" },
        userId: "7",
        userName: "ada",
        text: "hello",
        ts: 1_700_000_000_000,
      },
    };

    const parsed = parseStoredAdapterEvent(JSON.stringify(evt));
    expect(parsed).toEqual(evt);
  });

  it("rejects a payload that is not a usable event", () => {
    // A row written by an older build must not reach subscribers half-built.
    expect(parseStoredAdapterEvent("null")).toBeNull();
    expect(parseStoredAdapterEvent(JSON.stringify({ type: "adapter.message.created" }))).toBeNull();
    expect(
      parseStoredAdapterEvent(
        JSON.stringify({ type: "adapter.request.cancel", platform: "telegram", ts: 1 }),
      ),
    ).toBeNull();
    expect(
      parseStoredAdapterEvent(
        JSON.stringify({
          type: "adapter.message.created",
          platform: "discord",
          ts: 1,
          message: {
            ref: { platform: "discord", channelId: "c", messageId: "m" },
            session: { platform: "discord", channelId: "c" },
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("durable ingress", () => {
  it("keeps the update when the bus publish fails", async () => {
    adapter = makeAdapter();
    const seen: AdapterEvent[] = [];
    await adapter.subscribe(async (evt) => {
      seen.push(evt);
      throw new Error("redis unavailable");
    });

    await adapter.connect();
    await adapter.whenReady();

    server.enqueueMessage(inboundMessage(33, "hello"));
    await waitForPending(1);

    const store = new TelegramSurfaceStore(dbPath());
    const entries = store.listPendingIngress();
    store.close();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.lastError).toContain("redis unavailable");
    expect(entries[0]?.attempts).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it("retries a retained update in the same process", async () => {
    adapter = makeAdapter();
    const seen: AdapterEvent[] = [];
    let failing = true;
    await adapter.subscribe(async (evt) => {
      seen.push(evt);
      if (failing) throw new Error("redis unavailable");
    });

    await adapter.connect();
    await adapter.whenReady();

    server.enqueueMessage(inboundMessage(37, "retry in place"));
    await waitForPending(1);
    failing = false;
    await waitForPending(0);

    expect(seen).toHaveLength(2);
    expect(JSON.stringify(seen[1])).toContain("retry in place");
  });

  it("does not tell the user a cancel succeeded when publishing it failed", async () => {
    adapter = makeAdapter();
    await adapter.subscribe(async () => {
      throw new Error("bus down");
    });
    await adapter.connect();
    await adapter.whenReady();

    const callbackData = buildTelegramCancelCallbackData("telegram:1001:42");
    expect(callbackData).not.toBeNull();

    server.enqueueUpdate({
      callback_query: {
        id: "cb-1",
        from: { id: 7, is_bot: false, first_name: "Ada" },
        chat_instance: "ci",
        data: callbackData ?? "",
        message: {
          message_id: 500,
          date: Math.floor(Date.now() / 1000),
          chat: { id: CHAT, type: "private", first_name: "Ada" },
        },
      },
    });

    const answer = await server.waitForCall("answerCallbackQuery");
    expect(answer.params.text).toContain("could not be delivered");
    expect(answer.params.show_alert).toBe(true);
    const store = new TelegramSurfaceStore(dbPath());
    expect(store.countPendingIngress()).toBe(0);
    store.close();
  });

  it("forgets the update once the bus accepts it", async () => {
    adapter = makeAdapter();
    await adapter.subscribe(async () => {});
    await adapter.connect();
    await adapter.whenReady();

    server.enqueueMessage(inboundMessage(34, "hello"));
    await waitForPending(0);

    const store = new TelegramSurfaceStore(dbPath());
    expect(store.countPendingIngress()).toBe(0);
    store.close();
  });

  it("republishes a retained update on the next start and removes it after acceptance", async () => {
    // The whole point: the first run loses the bus, the second run recovers
    // the message even though Telegram will never resend it.
    adapter = makeAdapter();
    await adapter.subscribe(async () => {
      throw new Error("redis unavailable");
    });
    await adapter.connect();
    await adapter.whenReady();

    server.enqueueMessage(inboundMessage(35, "recover me"));
    await waitForPending(1);
    await adapter.disconnect();

    const second = makeAdapter();
    adapter = second;
    const replayed: AdapterEvent[] = [];
    await second.subscribe(async (evt) => void replayed.push(evt));
    await second.connect();
    await second.whenReady();

    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.type).toBe("adapter.message.created");
    expect(JSON.stringify(replayed[0])).toContain("recover me");

    const store = new TelegramSurfaceStore(dbPath());
    expect(store.countPendingIngress()).toBe(0);
    store.close();

    // Restarting again must not deliver it a second time.
    await second.disconnect();
    const third = makeAdapter();
    adapter = third;
    const again: AdapterEvent[] = [];
    await third.subscribe(async (evt) => void again.push(evt));
    await third.connect();
    await third.whenReady();

    expect(again).toHaveLength(0);
  });

  it("retains an entry when the replay also fails", async () => {
    adapter = makeAdapter();
    await adapter.subscribe(async () => {
      throw new Error("redis unavailable");
    });
    await adapter.connect();
    await adapter.whenReady();

    server.enqueueMessage(inboundMessage(36, "still stuck"));
    await waitForPending(1);
    await adapter.disconnect();

    const second = makeAdapter();
    adapter = second;
    await second.subscribe(async () => {
      throw new Error("redis still unavailable");
    });
    await second.connect();
    await second.whenReady();

    const store = new TelegramSurfaceStore(dbPath());
    const entries = store.listPendingIngress();
    store.close();

    expect(entries).toHaveLength(1);
    // Attempts accumulate, so an operator can see how long it has been stuck.
    expect(entries[0]?.attempts).toBeGreaterThanOrEqual(2);
  });

  it("does not drop an entry when there is nothing subscribed to take it", async () => {
    // A vacuous success over zero handlers would delete the row and lose the
    // message — the same outcome the outbox exists to prevent.
    const store = new TelegramSurfaceStore(dbPath());
    store.enqueueIngress({
      dedupeKey: "created:1001:99",
      payloadJson: JSON.stringify({
        type: "adapter.message.created",
        platform: "telegram",
        ts: 1,
        message: {
          ref: { platform: "telegram", channelId: "1001", messageId: "99" },
          session: { platform: "telegram", channelId: "1001" },
          userId: "7",
          text: "orphan",
          ts: 1,
        },
      }),
      ts: 1,
    });
    store.close();

    adapter = makeAdapter();
    await adapter.connect();
    await adapter.whenReady();

    const after = new TelegramSurfaceStore(dbPath());
    expect(after.countPendingIngress()).toBe(1);
    after.close();
  });

  it("drops an entry it can never parse rather than blocking the queue", async () => {
    const store = new TelegramSurfaceStore(dbPath());
    store.enqueueIngress({
      dedupeKey: "corrupt:1",
      payloadJson: JSON.stringify({ type: "nonsense" }),
      ts: 1,
    });
    store.close();

    adapter = makeAdapter();
    const seen: AdapterEvent[] = [];
    await adapter.subscribe(async (evt) => void seen.push(evt));
    await adapter.connect();
    await adapter.whenReady();

    const after = new TelegramSurfaceStore(dbPath());
    expect(after.countPendingIngress()).toBe(0);
    after.close();
    expect(seen).toHaveLength(0);
  });

  it("replays a backlog in arrival order", async () => {
    const store = new TelegramSurfaceStore(dbPath());
    for (const [index, messageId] of ["10", "11", "12"].entries()) {
      store.enqueueIngress({
        dedupeKey: `created:1001:${messageId}`,
        payloadJson: JSON.stringify({
          type: "adapter.message.created",
          platform: "telegram",
          ts: 1_000 + index,
          message: {
            ref: { platform: "telegram", channelId: "1001", messageId },
            session: { platform: "telegram", channelId: "1001" },
            userId: "7",
            text: `m${messageId}`,
            ts: 1_000 + index,
          },
        }),
        ts: 1_000 + index,
      });
    }
    store.close();

    adapter = makeAdapter();
    const order: string[] = [];
    await adapter.subscribe(async (evt) => {
      if (evt.type === "adapter.message.created") order.push(evt.message.ref.messageId);
    });
    await adapter.connect();
    await adapter.whenReady();

    expect(order).toEqual(["10", "11", "12"]);
  });
});

/**
 * Graceful restart takes its snapshot *after* ingress is meant to be quiet but
 * *before* the output relay drains. Those two needs pull in opposite
 * directions, which is why quiescing ingress is separate from disconnecting.
 */
describe("ingress quiescing for graceful restart", () => {
  it("stops accepting updates but can still send", async () => {
    adapter = makeAdapter();
    const seen: AdapterEvent[] = [];
    await adapter.subscribe(async (evt) => void seen.push(evt));
    await adapter.connect();
    await adapter.whenReady();

    await adapter.stopIngress();

    // The relay drain happens after this point and needs the send path alive;
    // a full disconnect() here would strand every in-flight reply.
    const sent = await adapter.sendMsg(
      { platform: "telegram", channelId: String(CHAT) },
      { text: "drained reply" },
    );
    if (sent.status === "error") throw sent.error;
    const ref = sent.value;
    expect(ref.platform).toBe("telegram");

    const sentCall = server.callsOf("sendMessage").at(-1);
    expect(String(sentCall?.params.text)).toContain("drained reply");
  });

  it("reports not-ready once ingress is quiesced, without claiming failure", async () => {
    adapter = makeAdapter();
    await adapter.subscribe(async () => {});
    await adapter.connect();
    await adapter.whenReady();

    await adapter.stopIngress();

    const health = adapter.getHealthSnapshot();
    expect(health.isReady).toBe(false);
    // A deliberate quiesce is not a polling failure; conflating them would
    // make every restart look like an incident.
    expect(health.connectionState).not.toBe("failed");
    expect(health.pollingExitFatal).toBeUndefined();
  });

  it("survives a disconnect after ingress was already stopped", async () => {
    adapter = makeAdapter();
    await adapter.subscribe(async () => {});
    await adapter.connect();
    await adapter.whenReady();

    await adapter.stopIngress();
    await adapter.disconnect();

    expect(adapter.getHealthSnapshot().connectionState).toBe("disconnected");
    adapter = null;
  });

  it("is idempotent", async () => {
    adapter = makeAdapter();
    await adapter.subscribe(async () => {});
    await adapter.connect();
    await adapter.whenReady();

    await adapter.stopIngress();
    await adapter.stopIngress();

    expect(adapter.getHealthSnapshot().connectionState).not.toBe("failed");
  });
});
