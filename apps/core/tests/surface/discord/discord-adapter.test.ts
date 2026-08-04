import { describe, expect, it } from "bun:test";
import { ActivityType, ApplicationCommandOptionType, MessageType, type Message } from "discord.js";
import { parseCoreConfigV1ToUniversal, type CoreConfig } from "@stanley2058/lilac-utils";
import { Panic } from "better-result";

import {
  DiscordAdapter,
  classifyDiscordSurfaceNotFound,
  buildDiscordSlashOption,
  hasExplicitDiscordUserMentionInContent,
  isExplicitDiscordUserMention,
  isRoutableDiscordUserMessage,
  resolveDiscordSurfaceEditTargetResult,
  resolveOutputNotificationEnabled,
  resolveEffectiveSessionModelOverride,
  type DiscordAdapterOptions,
} from "../../../src/surface/discord/discord-adapter";
import { SurfaceMessageNotFoundError } from "../../../src/surface/adapter";
import type { AdapterEvent } from "../../../src/surface/events";

function testConfigWithStatusMessage(statusMessage?: string): CoreConfig {
  const discord = {
    botName: "lilac",
    allowedChannelIds: ["c1"],
    ...(statusMessage === undefined ? {} : { statusMessage }),
  };
  const cfg = parseCoreConfigV1ToUniversal({
    surface: {
      discord,
    },
  });
  return { ...cfg, agent: { ...cfg.agent, systemPrompt: "(test)" } };
}

function createTestDiscordAdapter(
  options: Omit<DiscordAdapterOptions, "reportFatalPanic"> = {},
): DiscordAdapter {
  return new DiscordAdapter({ ...options, reportFatalPanic: () => {} });
}

function makeMessage(input: { bot: boolean; system: boolean; type: MessageType }): Message {
  return {
    author: { bot: input.bot },
    system: input.system,
    type: input.type,
  } as unknown as Message;
}

describe("classifyDiscordSurfaceNotFound", () => {
  it("maps only Discord unknown-channel/message codes to the common typed error", () => {
    for (const code of [10_003, 10_008]) {
      const classified = classifyDiscordSurfaceNotFound({ code }, "missing");
      expect(classified).toBeInstanceOf(SurfaceMessageNotFoundError);
      expect(classified).toMatchObject({ platform: "discord", code });
    }
    expect(classifyDiscordSurfaceNotFound({ code: 50_013 }, "forbidden")).toBeNull();
    expect(classifyDiscordSurfaceNotFound(new Error("network"), "network")).toBeNull();
  });
});

describe("isRoutableDiscordUserMessage", () => {
  it("accepts normal user chat messages", () => {
    const msg = makeMessage({
      bot: false,
      system: false,
      type: MessageType.Default,
    });

    expect(isRoutableDiscordUserMessage(msg)).toBe(true);
  });

  it("accepts user replies", () => {
    const msg = makeMessage({
      bot: false,
      system: false,
      type: MessageType.Reply,
    });

    expect(isRoutableDiscordUserMessage(msg)).toBe(true);
  });

  it("rejects non-chat/system message types", () => {
    const threadCreated = makeMessage({
      bot: false,
      system: false,
      type: MessageType.ThreadCreated,
    });
    const threadStarter = makeMessage({
      bot: false,
      system: false,
      type: MessageType.ThreadStarterMessage,
    });

    expect(isRoutableDiscordUserMessage(threadCreated)).toBe(false);
    expect(isRoutableDiscordUserMessage(threadStarter)).toBe(false);
  });

  it("rejects bot-authored and system messages", () => {
    const botMessage = makeMessage({
      bot: true,
      system: false,
      type: MessageType.Default,
    });
    const systemMessage = makeMessage({
      bot: false,
      system: true,
      type: MessageType.Default,
    });

    expect(isRoutableDiscordUserMessage(botMessage)).toBe(false);
    expect(isRoutableDiscordUserMessage(systemMessage)).toBe(false);
  });
});

describe("buildDiscordSlashOption", () => {
  it("includes static string choices when declared", () => {
    expect(
      buildDiscordSlashOption({
        key: "mode",
        type: "string",
        description: "Spread",
        required: false,
        choices: ["single", "past-present-future"],
      }),
    ).toEqual({
      type: ApplicationCommandOptionType.String,
      name: "mode",
      description: "Spread",
      required: false,
      choices: [
        { name: "single", value: "single" },
        { name: "past-present-future", value: "past-present-future" },
      ],
    });
  });

  it("truncates static string choices to Discord's 25-choice limit", () => {
    const choices = Array.from({ length: 26 }, (_, index) => `choice-${index + 1}`);

    expect(
      buildDiscordSlashOption({
        key: "mode",
        type: "string",
        description: "Spread",
        required: false,
        choices,
      }),
    ).toEqual({
      type: ApplicationCommandOptionType.String,
      name: "mode",
      description: "Spread",
      required: false,
      choices: choices.slice(0, 25).map((choice) => ({ name: choice, value: choice })),
    });
  });
});

describe("hasExplicitDiscordUserMentionInContent", () => {
  it("returns false when text has no explicit mention token", () => {
    expect(
      hasExplicitDiscordUserMentionInContent({
        content: "thanks for the help",
        userId: "42",
      }),
    ).toBe(false);
  });

  it("returns true for <@id> mention tokens", () => {
    expect(
      hasExplicitDiscordUserMentionInContent({
        content: "<@42> can you take a look?",
        userId: "42",
      }),
    ).toBe(true);
  });

  it("returns true for <@!id> nickname mention tokens", () => {
    expect(
      hasExplicitDiscordUserMentionInContent({
        content: "hey <@!42> please review",
        userId: "42",
      }),
    ).toBe(true);
  });
});

describe("isExplicitDiscordUserMention", () => {
  it("returns false when Discord did not parse a mention", () => {
    expect(
      isExplicitDiscordUserMention({
        content: "`<@42>`",
        userId: "42",
        hasParsedMention: false,
      }),
    ).toBe(false);
  });

  it("returns false when parsed mention exists but no explicit token in content", () => {
    expect(
      isExplicitDiscordUserMention({
        content: "thanks for the answer",
        userId: "42",
        hasParsedMention: true,
      }),
    ).toBe(false);
  });

  it("returns true when parsed mention and explicit token both exist", () => {
    expect(
      isExplicitDiscordUserMention({
        content: "<@42> please refine this",
        userId: "42",
        hasParsedMention: true,
      }),
    ).toBe(true);
  });
});

describe("resolveEffectiveSessionModelOverride", () => {
  it("uses thread override when present", () => {
    const overrides = new Map<string, string>([
      ["parent-1", "sonnet"],
      ["thread-1", "gpt-5"],
    ]);

    const result = resolveEffectiveSessionModelOverride({
      sessionId: "thread-1",
      parentChannelId: "parent-1",
      overrides,
    });

    expect(result).toBe("gpt-5");
  });

  it("inherits parent override when thread has none", () => {
    const overrides = new Map<string, string>([["parent-1", "sonnet"]]);

    const result = resolveEffectiveSessionModelOverride({
      sessionId: "thread-1",
      parentChannelId: "parent-1",
      overrides,
    });

    expect(result).toBe("sonnet");
  });

  it("returns undefined when neither session nor parent has override", () => {
    const result = resolveEffectiveSessionModelOverride({
      sessionId: "thread-1",
      parentChannelId: "parent-1",
      overrides: new Map<string, string>(),
    });

    expect(result).toBeUndefined();
  });
});

describe("resolveOutputNotificationEnabled", () => {
  it("defaults to enabled when config is unset", () => {
    expect(resolveOutputNotificationEnabled({})).toBe(true);
  });

  it("respects explicit config false", () => {
    expect(resolveOutputNotificationEnabled({ configured: false })).toBe(false);
  });

  it("forces notifications off when silent=true", () => {
    expect(resolveOutputNotificationEnabled({ configured: true, silent: true })).toBe(false);
  });
});

describe("resolveDiscordSurfaceEditTargetResult", () => {
  it("uses plain content for non-embed bot messages", () => {
    expect(
      resolveDiscordSurfaceEditTargetResult({
        authorId: "bot",
        selfUserId: "bot",
        embedCount: 0,
      }),
    ).toMatchObject({ status: "ok", value: "content" });
  });

  it("uses embed description for single-embed bot messages", () => {
    expect(
      resolveDiscordSurfaceEditTargetResult({
        authorId: "bot",
        selfUserId: "bot",
        embedCount: 1,
      }),
    ).toMatchObject({ status: "ok", value: "embed_description" });
  });

  it("prefers content when single-embed bot messages also have visible content", () => {
    expect(
      resolveDiscordSurfaceEditTargetResult({
        authorId: "bot",
        selfUserId: "bot",
        embedCount: 1,
        content: "visible content",
      }),
    ).toMatchObject({ status: "ok", value: "content" });
  });

  it("exposes non-bot authorship as a typed validation error", () => {
    const result = resolveDiscordSurfaceEditTargetResult({
      authorId: "user",
      selfUserId: "bot",
      embedCount: 1,
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error._tag).toBe("DiscordSurfaceEditUnsupported");
      expect(result.error.reason).toBe("not-author");
    }
  });

  it("returns a typed failure for multi-embed messages", () => {
    const result = resolveDiscordSurfaceEditTargetResult({
      authorId: "bot",
      selfUserId: "bot",
      embedCount: 2,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.reason).toBe("multiple-embeds");
      expect(result.error.message).toContain("single embed");
    }
  });
});

describe("DiscordAdapter.getHealthSnapshot", () => {
  it("samples current gateway ping state from discord.js shards", () => {
    const adapter = createTestDiscordAdapter();
    const adapterWithClient = adapter as unknown as {
      client: {
        ws: {
          ping: number;
          shards: Map<number, { lastPingTimestamp: number }>;
        };
      } | null;
    };

    adapterWithClient.client = {
      ws: {
        ping: 123,
        shards: new Map<number, { lastPingTimestamp: number }>([
          [0, { lastPingTimestamp: 1_000 }],
          [1, { lastPingTimestamp: 2_000 }],
        ]),
      },
    };

    const snapshot = adapter.getHealthSnapshot();

    expect(snapshot.gatewayPingMs).toBe(123);
    expect(snapshot.lastGatewayPingAt).toBe(2_000);
  });
});

describe("DiscordAdapter.disconnect", () => {
  it("runs store cleanup before rethrowing the original client Panic", async () => {
    const adapter = createTestDiscordAdapter();
    const panic = new Panic({ message: "discord destroy invariant failed" });
    let storeClosed = false;
    const state = adapter as unknown as {
      client: { destroy(): Promise<void> } | null;
      store: { close(): void } | null;
    };
    state.client = {
      async destroy() {
        throw panic;
      },
    };
    state.store = {
      close() {
        storeClosed = true;
      },
    };

    await expect(adapter.disconnect()).rejects.toBe(panic);
    expect(storeClosed).toBe(true);
  });
});

describe("DiscordAdapter detached event supervision", () => {
  const event: AdapterEvent = {
    type: "adapter.request.cancel",
    platform: "discord",
    ts: 1,
    requestId: "request-1",
    sessionId: "channel-1",
  };

  it("reports the exact handler Panic to the owned fatal boundary", async () => {
    const panic = new Panic({ message: "surface handler invariant failed" });
    let resolveReported!: (reported: Panic) => void;
    const reported = new Promise<Panic>((resolve) => {
      resolveReported = resolve;
    });
    const adapter = new DiscordAdapter({ reportFatalPanic: resolveReported });
    await adapter.subscribe(async () => {
      throw panic;
    });

    (adapter as unknown as { emit(evt: AdapterEvent): void }).emit(event);

    await expect(reported).resolves.toBe(panic);
  });

  it("keeps ordinary detached handler failures best-effort", async () => {
    const reported: Panic[] = [];
    let resolveHandled!: () => void;
    const handled = new Promise<void>((resolve) => {
      resolveHandled = resolve;
    });
    const adapter = new DiscordAdapter({
      reportFatalPanic: (panic) => reported.push(panic),
    });
    await adapter.subscribe(async () => {
      throw new Error("ordinary handler failure");
    });
    await adapter.subscribe(() => resolveHandled());

    (adapter as unknown as { emit(evt: AdapterEvent): void }).emit(event);
    await handled;
    await Promise.resolve();

    expect(reported).toEqual([]);
  });
});

describe("DiscordAdapter.refreshCoreConfig", () => {
  it("applies, changes, and clears configured presence", async () => {
    let cfg = testConfigWithStatusMessage("reading threads");
    const presenceCalls: unknown[] = [];
    const adapter = createTestDiscordAdapter({
      getConfig: async () => cfg,
    });
    (
      adapter as unknown as {
        client: {
          user: {
            setPresence(options: unknown): void;
          };
        } | null;
      }
    ).client = {
      user: {
        setPresence(options: unknown) {
          presenceCalls.push(options);
        },
      },
    };

    await adapter.refreshCoreConfig();
    cfg = testConfigWithStatusMessage("summarizing threads");
    await adapter.refreshCoreConfig();
    cfg = testConfigWithStatusMessage();
    await adapter.refreshCoreConfig();

    expect(presenceCalls).toEqual([
      {
        activities: [
          {
            name: "reading threads",
            state: "reading threads",
            type: ActivityType.Custom,
          },
        ],
        status: "online",
      },
      {
        activities: [
          {
            name: "summarizing threads",
            state: "summarizing threads",
            type: ActivityType.Custom,
          },
        ],
        status: "online",
      },
      { activities: [], status: "online" },
    ]);
  });
});

describe("DiscordAdapter.editMsg", () => {
  it("replaces only the embed description for single-embed bot messages", async () => {
    const editCalls: Array<Record<string, unknown>> = [];
    const message = {
      author: { id: "bot" },
      embeds: [
        {
          toJSON: () => ({
            title: "keep-title",
            description: "old-description",
            fields: [{ name: "field-1", value: "value-1" }],
            footer: { text: "keep-footer" },
          }),
        },
      ],
      edit: async (options: Record<string, unknown>) => {
        editCalls.push(options);
      },
    } as unknown as Message;

    const adapter = createTestDiscordAdapter();
    (adapter as unknown as { client: unknown }).client = {
      user: { id: "bot" },
      channels: {
        fetch: async () => ({
          messages: {
            fetch: async () => message,
          },
        }),
      },
    };

    await adapter.editMsg(
      { platform: "discord", channelId: "c1", messageId: "m1" },
      { text: "new-description" },
    );

    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.content).toBeUndefined();

    const embeds = editCalls[0]?.embeds as Array<{ toJSON(): Record<string, unknown> }> | undefined;
    expect(embeds).toHaveLength(1);

    const edited = embeds?.[0]?.toJSON();
    expect(edited?.title).toBe("keep-title");
    expect(edited?.description).toBe("new-description");
    expect(edited?.fields).toEqual([{ name: "field-1", value: "value-1" }]);
    expect(edited?.footer).toEqual({ text: "keep-footer" });
  });

  it("clears existing attachments when an edit supplies an empty attachment list", async () => {
    const editCalls: Array<Record<string, unknown>> = [];
    const message = {
      author: { id: "bot" },
      embeds: [
        {
          toJSON: () => ({ description: "old-description" }),
        },
      ],
      edit: async (options: Record<string, unknown>) => {
        editCalls.push(options);
      },
    } as unknown as Message;

    const adapter = createTestDiscordAdapter();
    (adapter as unknown as { client: unknown }).client = {
      user: { id: "bot" },
      channels: {
        fetch: async () => ({
          messages: {
            fetch: async () => message,
          },
        }),
      },
    };

    await adapter.editMsg(
      { platform: "discord", channelId: "c1", messageId: "m1" },
      { text: "new-description", attachments: [] },
    );

    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.attachments).toEqual([]);
    expect(editCalls[0]?.files).toEqual([]);
  });

  it("fails for non-bot-authored messages", async () => {
    const message = {
      author: { id: "user" },
      embeds: [],
      edit: async () => undefined,
    } as unknown as Message;

    const adapter = createTestDiscordAdapter();
    (adapter as unknown as { client: unknown }).client = {
      user: { id: "bot" },
      channels: {
        fetch: async () => ({
          messages: {
            fetch: async () => message,
          },
        }),
      },
    };

    await expect(
      adapter.editMsg(
        { platform: "discord", channelId: "c1", messageId: "m1" },
        { text: "updated" },
      ),
    ).rejects.toThrow("authored by the Lilac Discord bot");
  });

  it("edits content when a bot message has visible content plus one embed", async () => {
    const editCalls: Array<Record<string, unknown>> = [];
    const message = {
      author: { id: "bot" },
      content: "old content",
      embeds: [
        {
          toJSON: () => ({
            title: "preview-title",
            description: "preview-description",
          }),
        },
      ],
      edit: async (options: Record<string, unknown>) => {
        editCalls.push(options);
      },
    } as unknown as Message;

    const adapter = createTestDiscordAdapter();
    (adapter as unknown as { client: unknown }).client = {
      user: { id: "bot" },
      channels: {
        fetch: async () => ({
          messages: {
            fetch: async () => message,
          },
        }),
      },
    };

    await adapter.editMsg(
      { platform: "discord", channelId: "c1", messageId: "m1" },
      { text: "new content" },
    );

    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.content).toBe("new content");
    expect(editCalls[0]?.embeds).toBeUndefined();
  });
});
