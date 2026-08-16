import { describe, expect, it } from "bun:test";

import {
  isTelegramSurfaceUsable,
  parseCoreConfig,
  resolveTelegramToken,
  resolveTelegramTokenResult,
} from "../core-config";

describe("core config surface.telegram", () => {
  it("is disabled by default on v2 so existing deployments are unaffected", async () => {
    const cfg = await parseCoreConfig({ configVersion: 2 });

    expect(cfg.surface.telegram.enabled).toBe(false);
    expect(cfg.surface.telegram.token).toBeUndefined();
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
          token: "123:abc",
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
    expect(cfg.surface.telegram.token).toBe("123:abc");
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

  it("rejects the removed tokenEnv configuration", async () => {
    await expect(
      parseCoreConfig({
        configVersion: 2,
        surface: { telegram: { enabled: true, tokenEnv: "TELEGRAM_BOT_TOKEN" } },
      }),
    ).rejects.toThrow("copy the token to surface.telegram.token");
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
    expect(cfg.surface.telegram.token).toBeUndefined();
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

  it("has no apiRoot by default, so the public Bot API is used", async () => {
    const cfg = await parseCoreConfig({ configVersion: 2 });
    expect(cfg.surface.telegram.apiRoot).toBeUndefined();
  });

  it("accepts a self-hosted Bot API endpoint", async () => {
    const cfg = await parseCoreConfig({
      configVersion: 2,
      surface: { telegram: { apiRoot: "http://127.0.0.1:8081" } },
    });

    expect(cfg.surface.telegram.apiRoot).toBe("http://127.0.0.1:8081");
  });

  it("rejects an apiRoot that is not a URL", async () => {
    // A bare host would silently produce malformed request paths at runtime.
    await expect(
      parseCoreConfig({
        configVersion: 2,
        surface: { telegram: { apiRoot: "127.0.0.1:8081" } },
      }),
    ).rejects.toThrow();
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
  it("is unusable while disabled, even with a token present", async () => {
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
    const cfg = await parseCoreConfig({
      configVersion: 2,
      surface: { telegram: { enabled: true, token: "123:abc" } },
    });

    expect(isTelegramSurfaceUsable(cfg)).toBe(true);
  });

  it("reads the token directly from core-config", async () => {
    const cfg = await parseCoreConfig({
      configVersion: 2,
      surface: { telegram: { enabled: true, token: "123:abc" } },
    });

    expect(isTelegramSurfaceUsable(cfg)).toBe(true);
    expect(resolveTelegramToken(cfg)).toBe("123:abc");
    expect(resolveTelegramTokenResult(cfg).status).toBe("ok");
  });

  it("names the config key when resolving a token that is not set", async () => {
    const cfg = await parseCoreConfig({
      configVersion: 2,
      surface: { telegram: { enabled: true } },
    });

    expect(() => resolveTelegramToken(cfg)).toThrow("surface.telegram.token");
    const result = resolveTelegramTokenResult(cfg);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error._tag).toBe("TelegramTokenMissing");
  });
});
