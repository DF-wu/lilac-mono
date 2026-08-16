import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createLilacBus, lilacEventTypes, type Message } from "@stanley2058/lilac-event-bus";
import { Result } from "better-result";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils/core-config/v2";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import type { Message as TelegramMessage, Update } from "grammy/types";

import { CustomCommandManager } from "../../../src/custom-commands/manager";
import { bridgeAdapterToBus } from "../../../src/surface/bridge/publish-to-bus";
import { TelegramAdapter } from "../../../src/surface/telegram/telegram-adapter";
import { startTelegramRequestRouter } from "../../../src/surface/telegram/telegram-request-router";
import { createInMemoryDeliveryBus } from "../../helpers/in-memory-delivery-bus";
import { FakeBotApiServer } from "./fake-bot-api-server";
import { BOT_USER_ID, BOT_USERNAME, makeMessage, makeSupergroupChat } from "./telegram-fixtures";

/**
 * The whole inbound chain, with only the Bot API faked:
 *
 *   TelegramAdapter -> bridgeAdapterToBus -> bus -> startTelegramRequestRouter
 *
 * This is the seam that shipped broken. The adapter integration suite stops at
 * the emitted `AdapterEvent`, and the router suite starts by publishing bus
 * events directly, so the mapper between them was exercised by neither — and
 * it labelled every Telegram event as Discord, which sent it to the wrong
 * router and got it silently skipped.
 */
const CHAT = 1001;

let server: FakeBotApiServer;
let adapter: TelegramAdapter | null = null;
let stopBridge: { stop(): Promise<void> } | null = null;
let stopRouter: { stop(): Promise<void> } | null = null;
let scratchDir = "";

function testConfig(telegram: Record<string, unknown> = {}): CoreConfig {
  const cfg = parseCoreConfigV2ToUniversal({
    configVersion: 2,
    surface: {
      // Deliberately different from the Telegram name, so an identity fallback
      // is visible rather than silently harmless.
      discord: { botName: "lilac" },
      telegram: {
        enabled: true,
        token: "000000:fake-token",
        botName: "catalina",
        botUsername: BOT_USERNAME,
        allowedChatIds: [String(CHAT)],
        ...telegram,
      },
      router: {
        // Mirrors the shipped default. A private chat must still be routed,
        // which only works when the DM flag survives the bus hop.
        defaultMode: "mention",
        sessionModes: {},
        activeDebounceMs: 1,
        activeGate: { enabled: false, timeoutMs: 2500 },
      },
    },
  });
  return { ...cfg, agent: { ...cfg.agent, systemPrompt: "(test)" } };
}

/**
 * A registry on disk, so the menu alias is resolved by the real loader rather
 * than a stand-in that could accept spellings the real one rejects.
 */
async function loadRegistry(
  commands: readonly { name: string; description: string; args?: unknown[] }[],
): Promise<CustomCommandManager> {
  const dataDir = path.join(scratchDir, "data");
  for (const cmd of commands) {
    const dir = path.join(dataDir, "cmds", cmd.name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "def.json"),
      JSON.stringify({
        name: cmd.name,
        description: cmd.description,
        args: cmd.args ?? [],
      }),
      "utf8",
    );
    await writeFile(path.join(dir, "index.ts"), "export async function execute() {}\n", "utf8");
  }

  const manager = new CustomCommandManager(dataDir);
  await manager.init();
  return manager;
}

async function startChain(cfg: CoreConfig = testConfig(), customCommands?: CustomCommandManager) {
  const bus = createLilacBus(createInMemoryDeliveryBus());
  const requests: Array<Message<unknown>> = [];

  await bus.subscribeTopic(
    "cmd.request",
    { mode: "fanout", subscriptionId: "sink", consumerId: "sink-1" },
    async (msg) => {
      if (msg.type === lilacEventTypes.CmdRequestMessage) requests.push(msg);
      return Result.ok(undefined);
    },
    () => "park-pending",
  );

  const created = new TelegramAdapter({
    apiRoot: server.url,
    ...(customCommands ? { customCommands } : {}),
    getConfig: async () => ({
      ...cfg,
      surface: {
        ...cfg.surface,
        telegram: { ...cfg.surface.telegram, dbPath: path.join(scratchDir, "telegram.db") },
      },
    }),
  });

  // Exactly the runtime's order: both subscriptions live before polling starts.
  stopBridge = await bridgeAdapterToBus({
    eventSource: created,
    platform: "telegram",
    bus,
    subscriptionId: "e2e-bridge",
  });
  stopRouter = await startTelegramRequestRouter({
    adapter: created,
    bus,
    subscriptionId: "e2e-router",
    ...(customCommands ? { customCommands } : {}),
    config: {
      configVersion: 2,
      surface: {
        discord: { botName: "lilac" },
        telegram: cfg.surface.telegram,
        router: cfg.surface.router,
      },
    },
  });

  await created.connect();
  await created.whenReady();
  adapter = created;

  return { requests };
}

async function waitForRequest(requests: Array<Message<unknown>>): Promise<Message<unknown>> {
  const deadline = Date.now() + 10_000;
  while (requests.length === 0) {
    if (Date.now() > deadline) throw new Error("no cmd.request.message was published");
    await new Promise((resolve) => setImmediate(resolve));
  }
  return requests[0] as Message<unknown>;
}

function privateMessage(overrides: Partial<TelegramMessage> = {}): NonNullable<Update["message"]> {
  return makeMessage({
    chat: { id: CHAT, type: "private", first_name: "Ada" },
    from: { id: 547_663_716, is_bot: false, first_name: "Ada" },
    ...overrides,
  }) as NonNullable<Update["message"]>;
}

beforeEach(async () => {
  scratchDir = await mkdtemp(path.join(tmpdir(), "lilac-telegram-e2e-"));
  server = new FakeBotApiServer(BOT_USER_ID, BOT_USERNAME);
});

afterEach(async () => {
  await stopRouter?.stop();
  await stopBridge?.stop();
  stopRouter = null;
  stopBridge = null;
  await adapter?.disconnect();
  adapter = null;
  await server.close();
  await rm(scratchDir, { recursive: true, force: true });
});

describe("a telegram message reaches the router as a telegram message", () => {
  it("routes a plain DM even under the default mention mode", async () => {
    // The regression: the DM flag lives in raw.telegram, and a mislabelled
    // platform made the router look under raw.discord, see no flags, treat the
    // chat as a non-DM channel, and skip it as 'mention_mode_non_trigger'.
    const { requests } = await startChain();

    server.enqueueMessage(privateMessage({ message_id: 33, text: "hello there" }));
    const msg = await waitForRequest(requests);

    expect(msg.headers?.request_client).toBe("telegram");
    expect(msg.headers?.session_id).toBe(String(CHAT));
    expect(String(msg.headers?.request_id ?? "")).toStartWith("telegram:");
  });

  it("carries the user's text through to the composed request", async () => {
    const { requests } = await startChain();

    server.enqueueMessage(privateMessage({ message_id: 34, text: "what is 2 plus 2?" }));
    const msg = await waitForRequest(requests);

    const data = msg.data as { messages: Array<{ content: unknown }> };
    expect(JSON.stringify(data.messages)).toContain("what is 2 plus 2?");
  });

  it("attributes the request to telegram, not discord", async () => {
    const { requests } = await startChain();

    server.enqueueMessage(privateMessage({ message_id: 35, text: "who am I talking to?" }));
    const msg = await waitForRequest(requests);

    const serialized = JSON.stringify(msg.data);
    expect(serialized).toContain("telegram");
    // The attribution header would otherwise label a Telegram message as Discord.
    expect(serialized).not.toContain("[discord");
  });

  it("routes a group message that mentions the bot", async () => {
    const cfg = testConfig({ allowedChatIds: ["-1001234567890"] });
    const { requests } = await startChain(cfg);

    const mention = `@${BOT_USERNAME}`;
    server.enqueueMessage(
      makeMessage({
        message_id: 36,
        chat: makeSupergroupChat(),
        text: `${mention} status please`,
        entities: [{ type: "mention", offset: 0, length: mention.length }],
      }) as NonNullable<Update["message"]>,
    );

    const msg = await waitForRequest(requests);
    expect(msg.headers?.request_client).toBe("telegram");
  });

  it("ignores a group message that does not address the bot", async () => {
    const cfg = testConfig({ allowedChatIds: ["-1001234567890"] });
    const { requests } = await startChain(cfg);

    // Not a DM and no mention: correctly skipped under mention mode. Sending an
    // addressed message afterwards proves the first was seen and rejected.
    server.enqueueMessage(
      makeMessage({
        message_id: 37,
        chat: makeSupergroupChat(),
        text: "just chatting among ourselves",
      }) as NonNullable<Update["message"]>,
    );
    const mention = `@${BOT_USERNAME}`;
    server.enqueueMessage(
      makeMessage({
        message_id: 38,
        chat: makeSupergroupChat(),
        text: `${mention} now I mean you`,
        entities: [{ type: "mention", offset: 0, length: mention.length }],
      }) as NonNullable<Update["message"]>,
    );

    await waitForRequest(requests);
    expect(requests).toHaveLength(1);
  });
});

/**
 * A menu tap sends ordinary message text, so the alias has to survive the same
 * adapter -> bridge -> router path as anything the user types. Asserting only
 * that the registry resolves the alias would miss a surface that never gets it
 * that far.
 */
describe("a command menu tap invokes the same command as the typed form", () => {
  const customCommandOf = (msg: Message<unknown>) => {
    const data = msg.data as { raw?: { customCommand?: Record<string, unknown> } };
    return data.raw?.customCommand;
  };

  it("resolves the menu alias to the registry command", async () => {
    const registry = await loadRegistry([
      { name: "daily-standup", description: "Summarize yesterday" },
    ]);
    const { requests } = await startChain(testConfig(), registry);

    server.enqueueMessage(privateMessage({ message_id: 40, text: "/lilac_daily_standup" }));
    const msg = await waitForRequest(requests);

    expect(customCommandOf(msg)).toMatchObject({
      name: "daily-standup",
      source: "text",
    });
    expect(customCommandOf(msg)?.["error"]).toBeUndefined();
  });

  it("carries arguments and trailing prompt from the alias form", async () => {
    const registry = await loadRegistry([
      {
        name: "daily-standup",
        description: "Summarize yesterday",
        args: [{ key: "team", type: "string", required: true }],
      },
    ]);
    const { requests } = await startChain(testConfig(), registry);

    server.enqueueMessage(
      privateMessage({ message_id: 41, text: "/lilac_daily_standup team=core keep it short" }),
    );
    const msg = await waitForRequest(requests);

    expect(customCommandOf(msg)).toMatchObject({
      name: "daily-standup",
      args: ["core"],
      prompt: "keep it short",
    });
  });

  it("accepts the alias with the @botusername suffix a group tap produces", async () => {
    const registry = await loadRegistry([{ name: "tarot", description: "Draw a tarot spread" }]);
    const cfg = testConfig({ allowedChatIds: ["-1001234567890"] });
    const { requests } = await startChain(cfg, registry);

    server.enqueueMessage(
      makeMessage({
        message_id: 42,
        chat: makeSupergroupChat(),
        text: `/lilac_tarot@${BOT_USERNAME}`,
        entities: [
          { type: "bot_command", offset: 0, length: `/lilac_tarot@${BOT_USERNAME}`.length },
        ],
      }) as NonNullable<Update["message"]>,
    );

    const msg = await waitForRequest(requests);
    expect(customCommandOf(msg)).toMatchObject({ name: "tarot" });
  });

  /**
   * The targeting defect: the parser used to strip any `@suffix`, so a command
   * explicitly addressed to another bot ran ours. Mention gating does not save
   * us — the router's custom-command branch is ahead of it.
   */
  it("does not run a command addressed to a different bot in the same group", async () => {
    const registry = await loadRegistry([{ name: "tarot", description: "Draw a tarot spread" }]);
    const cfg = testConfig({ allowedChatIds: ["-1001234567890"] });
    const { requests } = await startChain(cfg, registry);

    const foreign = "/lilac_tarot@SomeOtherBot";
    server.enqueueMessage(
      makeMessage({
        message_id: 45,
        chat: makeSupergroupChat(),
        text: foreign,
        entities: [{ type: "bot_command", offset: 0, length: foreign.length }],
      }) as NonNullable<Update["message"]>,
    );

    // Send an addressed command afterwards: it proves the first was seen and
    // rejected rather than merely still in flight.
    const mine = `/lilac_tarot@${BOT_USERNAME}`;
    server.enqueueMessage(
      makeMessage({
        message_id: 46,
        chat: makeSupergroupChat(),
        text: mine,
        entities: [{ type: "bot_command", offset: 0, length: mine.length }],
      }) as NonNullable<Update["message"]>,
    );

    const msg = await waitForRequest(requests);
    expect(requests).toHaveLength(1);
    expect(customCommandOf(msg)).toMatchObject({ name: "tarot" });
    expect(String(msg.headers?.request_id ?? "")).toContain("46");
  });

  it("reports an unknown alias instead of silently treating it as chat", async () => {
    const registry = await loadRegistry([{ name: "tarot", description: "Draw a tarot spread" }]);
    const { requests } = await startChain(testConfig(), registry);

    server.enqueueMessage(privateMessage({ message_id: 43, text: "/lilac_not_a_command" }));
    const msg = await waitForRequest(requests);

    expect(customCommandOf(msg)).toMatchObject({
      name: "not-a-command",
      error: "Unknown custom command 'not-a-command'.",
    });
  });

  it("leaves an ordinary message alone", async () => {
    const registry = await loadRegistry([{ name: "tarot", description: "Draw a tarot spread" }]);
    const { requests } = await startChain(testConfig(), registry);

    server.enqueueMessage(privateMessage({ message_id: 44, text: "lilac_tarot without a slash" }));
    const msg = await waitForRequest(requests);

    expect(customCommandOf(msg)).toBeUndefined();
  });
});
