import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils/core-config/v2";
import type { CoreConfig } from "@stanley2058/lilac-utils";

import { CustomCommandManager } from "../../../src/custom-commands/manager";
import { TelegramAdapter } from "../../../src/surface/telegram/telegram-adapter";
import { FakeBotApiServer } from "./fake-bot-api-server";
import { BOT_USER_ID, BOT_USERNAME } from "./telegram-fixtures";

/**
 * What Telegram is actually told at connect time.
 *
 * The menu previously published an empty list while the docs claimed it
 * advertised the bot's commands, so these assertions read the recorded
 * `setMyCommands` payload rather than trusting the registry alone.
 */
const ALLOWED_CHAT = 1001;

const menuPayloadSchema = z.object({
  commands: z.array(z.object({ command: z.string(), description: z.string() })),
});

let server: FakeBotApiServer;
let adapter: TelegramAdapter | null = null;
let scratchDir = "";

function testConfig(telegram: Record<string, unknown> = {}): CoreConfig {
  const cfg = parseCoreConfigV2ToUniversal({
    configVersion: 2,
    surface: {
      telegram: {
        enabled: true,
        token: "000000:fake-token",
        botName: "lilac",
        allowedChatIds: [String(ALLOWED_CHAT)],
        ...telegram,
      },
    },
  });
  return { ...cfg, agent: { ...cfg.agent, systemPrompt: "(test)" } };
}

async function loadRegistry(
  commands: readonly { name: string; description: string }[],
): Promise<CustomCommandManager> {
  const dataDir = path.join(scratchDir, "data");
  for (const cmd of commands) {
    const dir = path.join(dataDir, "cmds", cmd.name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "def.json"),
      JSON.stringify({ name: cmd.name, description: cmd.description, args: [] }),
      "utf8",
    );
    await writeFile(path.join(dir, "index.ts"), "export async function execute() {}\n", "utf8");
  }

  const manager = new CustomCommandManager(dataDir);
  await manager.init();
  return manager;
}

async function connect(input: {
  cfg?: CoreConfig;
  customCommands?: CustomCommandManager;
}): Promise<TelegramAdapter> {
  const cfg = input.cfg ?? testConfig();

  const created = new TelegramAdapter({
    apiRoot: server.url,
    ...(input.customCommands ? { customCommands: input.customCommands } : {}),
    getConfig: async () => ({
      ...cfg,
      surface: {
        ...cfg.surface,
        telegram: { ...cfg.surface.telegram, dbPath: path.join(scratchDir, "telegram.db") },
      },
    }),
  });

  await created.connect();
  await created.whenReady();
  adapter = created;
  return created;
}

function registeredMenu(): { command: string; description: string }[] {
  const call = server.callsOf("setMyCommands").at(-1);
  if (!call) throw new Error("setMyCommands was never called");
  return menuPayloadSchema.parse(call.params).commands;
}

beforeEach(async () => {
  scratchDir = await mkdtemp(path.join(tmpdir(), "lilac-telegram-menu-"));
  server = new FakeBotApiServer(BOT_USER_ID, BOT_USERNAME);
});

afterEach(async () => {
  await adapter?.disconnect();
  adapter = null;
  await server.close();
  await rm(scratchDir, { recursive: true, force: true });
});

describe("telegram command menu", () => {
  it("advertises each custom command under its menu alias", async () => {
    const registry = await loadRegistry([
      { name: "tarot", description: "Draw a tarot spread" },
      { name: "daily-standup", description: "Summarize yesterday" },
    ]);
    await connect({ customCommands: registry });

    expect(registeredMenu()).toEqual([
      { command: "lilac_daily_standup", description: "Summarize yesterday" },
      { command: "lilac_tarot", description: "Draw a tarot spread" },
    ]);
  });

  it("publishes an empty menu when the registry is empty", async () => {
    // Empty rather than skipped: a deployment that removed its last command
    // must stop advertising the ones it used to have.
    await connect({ customCommands: await loadRegistry([]) });

    expect(registeredMenu()).toEqual([]);
  });

  it("does not touch the menu when the option is off", async () => {
    const registry = await loadRegistry([{ name: "tarot", description: "Draw a tarot spread" }]);
    await connect({ cfg: testConfig({ commandMenu: false }), customCommands: registry });

    expect(server.callsOf("setMyCommands")).toHaveLength(0);
  });

  it("clears the menu when no registry is wired in", async () => {
    await connect({});

    expect(registeredMenu()).toEqual([]);
  });

  it("omits a command that has no representable alias", async () => {
    const long = "q".repeat(27);
    const registry = await loadRegistry([
      { name: long, description: "Too long to advertise" },
      { name: "tarot", description: "Draw a tarot spread" },
    ]);
    await connect({ customCommands: registry });

    expect(registeredMenu()).toEqual([
      { command: "lilac_tarot", description: "Draw a tarot spread" },
    ]);
  });

  it("stays within Telegram's 100-command ceiling", async () => {
    // The whole call fails if the list is too long, so the menu is trimmed
    // rather than lost entirely.
    const many = Array.from({ length: 105 }, (_, i) => ({
      name: `cmd-${String(i).padStart(3, "0")}`,
      description: `Command ${i}`,
    }));
    const registry = await loadRegistry(many);
    await connect({ customCommands: registry });

    const menu = registeredMenu();
    expect(menu).toHaveLength(100);
    expect(menu[0]?.command).toBe("lilac_cmd_000");
    expect(menu.every((entry) => /^[a-z0-9_]{1,32}$/.test(entry.command))).toBe(true);
  });

  it("only publishes commands Telegram's grammar accepts", async () => {
    const registry = await loadRegistry([
      { name: "daily-standup", description: "Summarize yesterday" },
      { name: "a1-b2-c3", description: "Mixed segments" },
    ]);
    await connect({ customCommands: registry });

    for (const entry of registeredMenu()) {
      expect(entry.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(256);
    }
  });
});
