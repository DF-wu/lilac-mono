import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { isTelegramSurfaceUsable, parseCoreConfig, resolveTelegramToken } from "../core-config";

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

  it("keeps a disabled surface usable only when explicitly enabled", async () => {
    const cfg = await parseCoreConfig({ configVersion: 2 });
    expect(isTelegramSurfaceUsable(cfg)).toBe(false);
  });

  it("returns independent default objects per parse", async () => {
    const a = await parseCoreConfig({ configVersion: 2 });
    const b = await parseCoreConfig({ configVersion: 2 });

    a.surface.telegram.allowedChatIds.push("mutated");

    expect(b.surface.telegram.allowedChatIds).toEqual([]);
  });
});

describe("telegram surface gating", () => {
  const ENV_KEY = "TELEGRAM_BOT_TOKEN";
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
  });

  it("is unusable while disabled, even with a token present", async () => {
    process.env[ENV_KEY] = "123:abc";
    const cfg = await parseCoreConfig({ configVersion: 2 });

    expect(isTelegramSurfaceUsable(cfg)).toBe(false);
  });

  it("is unusable when enabled without a token", async () => {
    // Enabling the surface must not break startup for a deployment that has
    // no credentials configured; the runtime warns and continues instead.
    const cfg = await parseCoreConfig({
      configVersion: 2,
      surface: { telegram: { enabled: true } },
    });

    expect(isTelegramSurfaceUsable(cfg)).toBe(false);
  });

  it("is usable once enabled and a token is present", async () => {
    process.env[ENV_KEY] = "123:abc";
    const cfg = await parseCoreConfig({
      configVersion: 2,
      surface: { telegram: { enabled: true } },
    });

    expect(isTelegramSurfaceUsable(cfg)).toBe(true);
  });

  it("honours a custom tokenEnv", async () => {
    process.env.MY_TELEGRAM_TOKEN = "123:abc";
    try {
      const cfg = await parseCoreConfig({
        configVersion: 2,
        surface: { telegram: { enabled: true, tokenEnv: "MY_TELEGRAM_TOKEN" } },
      });

      expect(isTelegramSurfaceUsable(cfg)).toBe(true);
      expect(resolveTelegramToken(cfg)).toBe("123:abc");
    } finally {
      delete process.env.MY_TELEGRAM_TOKEN;
    }
  });

  it("names the missing env var when resolving a token that is not set", async () => {
    const cfg = await parseCoreConfig({
      configVersion: 2,
      surface: { telegram: { enabled: true, tokenEnv: "ABSENT_TELEGRAM_TOKEN" } },
    });

    expect(() => resolveTelegramToken(cfg)).toThrow("ABSENT_TELEGRAM_TOKEN");
  });
});
