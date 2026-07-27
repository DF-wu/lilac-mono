import { describe, expect, it } from "bun:test";

import { parseCoreConfig } from "../core-config";

describe("core config surface.telegram", () => {
  it("is disabled by default on v2 so existing deployments are unaffected", async () => {
    const cfg = await parseCoreConfig({ configVersion: 2 });

    expect(cfg.surface.telegram.enabled).toBe(false);
    expect(cfg.surface.telegram.tokenEnv).toBe("TELEGRAM_BOT_TOKEN");
    expect(cfg.surface.telegram.parseMode).toBe("html");
    expect(cfg.surface.telegram.outputMode).toBe("preview");
    expect(cfg.surface.telegram.streamEditIntervalMs).toBe(1500);
    expect(cfg.surface.telegram.commandMenu).toBe(true);
  });

  it("fails closed: the default allowlists are empty", async () => {
    const cfg = await parseCoreConfig({ configVersion: 2 });

    expect(cfg.surface.telegram.allowedChatIds).toEqual([]);
    expect(cfg.surface.telegram.allowedUserIds).toEqual([]);
  });

  it("accepts an explicit v2 configuration", async () => {
    const cfg = await parseCoreConfig({
      configVersion: 2,
      surface: {
        telegram: {
          enabled: true,
          botName: "catalina",
          botUsername: "Catalina_agentbot",
          allowedChatIds: ["12345", "-1009876543210"],
          allowedUserIds: ["42"],
          parseMode: "plain",
          outputMode: "inline",
          streamEditIntervalMs: 2500,
          commandMenu: false,
        },
      },
    });

    expect(cfg.surface.telegram.enabled).toBe(true);
    expect(cfg.surface.telegram.botName).toBe("catalina");
    expect(cfg.surface.telegram.botUsername).toBe("Catalina_agentbot");
    expect(cfg.surface.telegram.allowedChatIds).toEqual(["12345", "-1009876543210"]);
    expect(cfg.surface.telegram.allowedUserIds).toEqual(["42"]);
    expect(cfg.surface.telegram.parseMode).toBe("plain");
    expect(cfg.surface.telegram.outputMode).toBe("inline");
    expect(cfg.surface.telegram.streamEditIntervalMs).toBe(2500);
    expect(cfg.surface.telegram.commandMenu).toBe(false);
  });

  it("rejects a botUsername written with a leading '@'", async () => {
    await expect(
      parseCoreConfig({
        configVersion: 2,
        surface: { telegram: { botUsername: "@Catalina_agentbot" } },
      }),
    ).rejects.toThrow();
  });

  it("rejects a botName containing spaces", async () => {
    await expect(
      parseCoreConfig({
        configVersion: 2,
        surface: { telegram: { botName: "my bot" } },
      }),
    ).rejects.toThrow();
  });

  it("rejects a streamEditIntervalMs below the Bot API edit rate limit", async () => {
    await expect(
      parseCoreConfig({
        configVersion: 2,
        surface: { telegram: { streamEditIntervalMs: 100 } },
      }),
    ).rejects.toThrow();
  });

  it("gives frozen v1 configs the same disabled fallback", async () => {
    const cfg = await parseCoreConfig({ configVersion: 1 });

    expect(cfg.surface.telegram.enabled).toBe(false);
    expect(cfg.surface.telegram.tokenEnv).toBe("TELEGRAM_BOT_TOKEN");
    expect(cfg.surface.telegram.allowedChatIds).toEqual([]);
  });

  it("does not let v1 configure the telegram surface", async () => {
    // The v1 input schema is frozen, so an unknown key must not silently enable
    // a surface that the operator cannot otherwise control.
    const seen: string[] = [];
    const cfg = await parseCoreConfig(
      {
        configVersion: 1,
        surface: { telegram: { enabled: true } },
      },
      { onUnknownKey: (path) => seen.push(path.join(".")) },
    );

    expect(cfg.surface.telegram.enabled).toBe(false);
    expect(seen).toContain("surface.telegram");
  });

  it("returns independent default objects per parse", async () => {
    const a = await parseCoreConfig({ configVersion: 2 });
    const b = await parseCoreConfig({ configVersion: 2 });

    a.surface.telegram.allowedChatIds.push("mutated");

    expect(b.surface.telegram.allowedChatIds).toEqual([]);
  });
});
