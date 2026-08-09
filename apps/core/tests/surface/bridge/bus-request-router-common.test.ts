import { describe, expect, it } from "bun:test";
import { Panic } from "better-result";

import {
  getDiscordFlags,
  parseLeadingContinueDirective,
  resolveSessionConfigId,
  resolveSessionSafetyMode,
  stripLeadingContinueDirective,
  withDefaultToolsConfig,
} from "../../../src/surface/discord/discord-request-router/common";

const EMPTY_DISCORD_FLAGS = {};

describe("Discord raw flags", () => {
  it("projects every valid Discord flag used by the router", () => {
    expect(
      getDiscordFlags({
        discord: {
          isDMBased: true,
          mentionsBot: false,
          replyToBot: true,
          replyToMessageId: "message-1",
          parentChannelId: "channel-1",
          guildId: "guild-1",
          sessionModelOverride: "model-1",
          botUserId: "bot-1",
          ignored: "not projected",
        },
      }),
    ).toEqual({
      isDMBased: true,
      mentionsBot: false,
      replyToBot: true,
      replyToMessageId: "message-1",
      parentChannelId: "channel-1",
      guildId: "guild-1",
      sessionModelOverride: "model-1",
      botUserId: "bot-1",
    });
  });

  it.each([
    ["null raw", null],
    ["array raw", []],
    ["missing Discord envelope", {}],
    ["scalar Discord envelope", { discord: "invalid" }],
    ["malformed flag", { discord: { isDMBased: "true" } }],
    ["partially malformed flags", { discord: { mentionsBot: true, replyToBot: 1 } }],
  ] as const)("fails closed for %s", (_, raw) => {
    expect(getDiscordFlags(raw)).toEqual(EMPTY_DISCORD_FLAGS);
  });

  it("ignores inherited envelopes and inherited flag fields", () => {
    const inheritedEnvelope = Object.create({ discord: { mentionsBot: true } });
    const inheritedFlags = Object.create({ mentionsBot: true, replyToBot: true });

    expect(getDiscordFlags(inheritedEnvelope)).toEqual(EMPTY_DISCORD_FLAGS);
    expect(getDiscordFlags({ discord: inheritedFlags })).toEqual(EMPTY_DISCORD_FLAGS);
  });

  it("ignores accessors without invoking them", () => {
    let getterCalls = 0;
    const accessorEnvelope = Object.defineProperty({}, "discord", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("hostile envelope getter must not run");
      },
    });
    const accessorFlags = Object.defineProperty({}, "mentionsBot", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("hostile flag getter must not run");
      },
    });

    expect(getDiscordFlags(accessorEnvelope)).toEqual(EMPTY_DISCORD_FLAGS);
    expect(getDiscordFlags({ discord: accessorFlags })).toEqual(EMPTY_DISCORD_FLAGS);
    expect(getterCalls).toBe(0);
  });

  it("contains hostile and revoked proxy failures", () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("hostile reflection trap");
        },
      },
    );
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(getDiscordFlags(hostile)).toEqual(EMPTY_DISCORD_FLAGS);
    expect(getDiscordFlags(proxy)).toEqual(EMPTY_DISCORD_FLAGS);
    expect(getDiscordFlags({ discord: proxy })).toEqual(EMPTY_DISCORD_FLAGS);
  });

  it("preserves Panic from hostile reflection", () => {
    const panic = new Panic({ message: "Discord flag reflection invariant failed" });
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw panic;
        },
      },
    );

    expect(() => getDiscordFlags(hostile)).toThrow(panic);
  });
});

describe("additional prompt config resolution", () => {
  it("selects the most specific explicit additionalPrompts entry", () => {
    const parsed = withDefaultToolsConfig({
      surface: {
        router: {
          sessionModes: {
            guild: { additionalPrompts: ["guild memo"] },
            parent: { additionalPrompts: ["parent memo"] },
            thread: { additionalPrompts: ["thread memo"] },
            empty: { additionalPrompts: [] },
            "safety-child": { safetyMode: "restricted" },
            "safety-parent": { safetyMode: "restricted" },
          },
        },
      },
    });
    expect(parsed.status).toBe("ok");
    if (parsed.status === "error") return;

    const cfg = parsed.value;
    expect(resolveSessionConfigId({ cfg, sessionId: "channel", guildId: "guild" })).toBe("guild");
    expect(
      resolveSessionConfigId({
        cfg,
        sessionId: "child",
        parentChannelId: "parent",
        guildId: "guild",
      }),
    ).toBe("parent");
    expect(
      resolveSessionConfigId({
        cfg,
        sessionId: "thread",
        parentChannelId: "parent",
        guildId: "guild",
      }),
    ).toBe("thread");
    expect(
      resolveSessionConfigId({
        cfg,
        sessionId: "empty",
        parentChannelId: "parent",
        guildId: "guild",
      }),
    ).toBe("empty");
    expect(
      resolveSessionConfigId({
        cfg,
        sessionId: "safety-child",
        parentChannelId: "parent",
        guildId: "guild",
      }),
    ).toBe("parent");
    expect(
      resolveSessionConfigId({
        cfg,
        sessionId: "child",
        parentChannelId: "safety-parent",
        guildId: "guild",
      }),
    ).toBe("guild");
    expect(resolveSessionConfigId({ cfg, sessionId: "unconfigured" })).toBe("unconfigured");
  });
});

describe("continue directives", () => {
  it("treats bare !cont and !continue as !cont=8", () => {
    const botNames = ["lilac"];

    expect(parseLeadingContinueDirective({ text: "!cont resume please", botNames })).toBe(8);
    expect(parseLeadingContinueDirective({ text: "!continue resume please", botNames })).toBe(8);
    expect(parseLeadingContinueDirective({ text: "<@bot> !cont resume please", botNames })).toBe(8);
    expect(
      parseLeadingContinueDirective({ text: "<@bot> !continue resume please", botNames }),
    ).toBe(8);
  });

  it("strips bare continue directives from message text", () => {
    const botNames = ["lilac"];

    expect(stripLeadingContinueDirective({ text: "!cont resume please", botNames })).toBe(
      "resume please",
    );
    expect(stripLeadingContinueDirective({ text: "!continue resume please", botNames })).toBe(
      "resume please",
    );
    expect(stripLeadingContinueDirective({ text: "<@bot> !cont resume please", botNames })).toBe(
      "<@bot> resume please",
    );
    expect(
      stripLeadingContinueDirective({ text: "<@bot> !continue resume please", botNames }),
    ).toBe("<@bot> resume please");
  });
});

describe("session safety mode", () => {
  it("inherits restricted safety mode from parent when child has local prompts", () => {
    const parsed = withDefaultToolsConfig({
      surface: {
        router: {
          sessionModes: {
            parent: { safetyMode: "restricted" },
            child: { additionalPrompts: ["child memo"] },
          },
        },
      },
    });
    expect(parsed.status).toBe("ok");
    if (parsed.status === "error") return;

    expect(resolveSessionSafetyMode(parsed.value, "child", "parent")).toBe("restricted");
  });
});
