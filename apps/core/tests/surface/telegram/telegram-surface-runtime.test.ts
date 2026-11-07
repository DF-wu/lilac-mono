import { describe, expect, it } from "bun:test";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils/core-config/v2";

import { CustomCommandManager } from "../../../src/custom-commands/manager";
import { TelegramAdapter } from "../../../src/surface/telegram/telegram-adapter";
import {
  createTelegramWorkflowTargetAuthorizer,
  hydrateTelegramConversationAttachments,
  refreshTelegramCoreConfig,
  resolveTelegramAdapterForStartup,
  telegramConversationMemoryInput,
} from "../../../src/surface/telegram/telegram-surface-runtime";

function testConfig(telegram: Record<string, unknown> = {}): CoreConfig {
  const cfg = parseCoreConfigV2ToUniversal({
    configVersion: 2,
    surface: { telegram },
  });
  return { ...cfg, agent: { ...cfg.agent, systemPrompt: "(test)" } };
}

function recordingLogger() {
  const warnings: Array<{ message: string; context: Readonly<Record<string, unknown>> }> = [];
  return {
    warnings,
    logger: {
      debug: () => {},
      warn: (message: string, context: Readonly<Record<string, unknown>>) => {
        warnings.push({ message, context });
      },
    },
  };
}

describe("resolveTelegramAdapterForStartup", () => {
  const customCommands = new CustomCommandManager("/nonexistent");

  it("returns null without a warning when the surface is disabled", () => {
    const { logger, warnings } = recordingLogger();
    const adapter = resolveTelegramAdapterForStartup({
      config: testConfig({ enabled: false }),
      customCommands,
      logger,
    });
    expect(adapter).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("warns and returns null when enabled without a token", () => {
    const { logger, warnings } = recordingLogger();
    const adapter = resolveTelegramAdapterForStartup({
      config: testConfig({ enabled: true }),
      customCommands,
      logger,
    });
    expect(adapter).toBeNull();
    expect(warnings).toEqual([
      {
        message: "telegram surface enabled but no token available; skipping",
        context: { configKey: "surface.telegram.token" },
      },
    ]);
  });

  it("constructs the adapter when enabled with a token", () => {
    const { logger, warnings } = recordingLogger();
    const adapter = resolveTelegramAdapterForStartup({
      config: testConfig({ enabled: true, token: "123:abc", allowedChatIds: ["1"] }),
      customCommands,
      logger,
    });
    expect(adapter).toBeInstanceOf(TelegramAdapter);
    expect(warnings).toEqual([]);
  });
});

describe("refreshTelegramCoreConfig", () => {
  it("is a no-op without an adapter", async () => {
    const { logger, warnings } = recordingLogger();
    await refreshTelegramCoreConfig(null, logger);
    expect(warnings).toEqual([]);
  });
});

describe("createTelegramWorkflowTargetAuthorizer", () => {
  const cfg = testConfig({ enabled: true, token: "123:abc", allowedChatIds: ["1001"] });
  const authorize = createTelegramWorkflowTargetAuthorizer(async () => cfg);

  it("passes non-telegram targets through", async () => {
    await expect(
      authorize({ platform: "discord", channelId: "anything", replyToMessageId: null }),
    ).resolves.toBe(true);
  });

  it("allows an allowlisted telegram chat, including forum topics", async () => {
    await expect(
      authorize({ platform: "telegram", channelId: "1001", replyToMessageId: null }),
    ).resolves.toBe(true);
    await expect(
      authorize({ platform: "telegram", channelId: "1001:42", replyToMessageId: null }),
    ).resolves.toBe(true);
  });

  it("rejects chats outside the allowlist and unparseable session ids", async () => {
    await expect(
      authorize({ platform: "telegram", channelId: "2002", replyToMessageId: null }),
    ).resolves.toBe(false);
    await expect(
      authorize({ platform: "telegram", channelId: "not-a-chat", replyToMessageId: null }),
    ).resolves.toBe(false);
  });
});

describe("telegram conversation memory helpers", () => {
  it("attaches the history index only when the adapter exists", () => {
    const config = testConfig({
      enabled: true,
      token: "test-token",
      botName: "memorybot",
      dbPath: "/tmp/lilac-telegram-memory.db",
    });
    expect(telegramConversationMemoryInput({ adapter: null, config })).toBeUndefined();
    const adapter = new TelegramAdapter({
      customCommands: new CustomCommandManager("/nonexistent"),
    });
    expect(telegramConversationMemoryInput({ adapter, config })).toEqual({
      dbPath: "/tmp/lilac-telegram-memory.db",
      botName: "memorybot",
    });
  });

  it("reports unavailable storage instead of hydrating without an adapter", async () => {
    const result = await hydrateTelegramConversationAttachments({
      adapter: null,
      ref: { channelId: "-100123", messageId: "5" },
    });
    expect(result.isErr()).toBe(true);
    expect(result.match({ ok: () => "", err: (error) => error.message })).toContain(
      "Telegram conversation storage is unavailable",
    );
  });
});
