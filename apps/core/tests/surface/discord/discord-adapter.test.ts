import { describe, expect, it } from "bun:test";
import {
  ActivityType,
  ApplicationCommandOptionType,
  Collection,
  type GuildMember,
  MessageType,
  type Message,
  Options,
  type ThreadMember,
} from "discord.js";
import { parseCoreConfigV1ToUniversal, type CoreConfig } from "@stanley2058/lilac-utils";
import { Panic, Result } from "better-result";

import {
  DiscordAdapter,
  DiscordAdapterUnavailable,
  DISCORD_CACHE_LIMITS,
  DISCORD_CACHE_SETTINGS,
  classifyDiscordSurfaceNotFound,
  buildDiscordSlashOption,
  classifyDiscordSurfaceError,
  hasExplicitDiscordUserMentionInContent,
  isExplicitDiscordUserMention,
  isRoutableDiscordUserMessage,
  resolveDiscordSurfaceEditTargetResult,
  resolveOutputNotificationEnabled,
  resolveEffectiveSessionModelOverride,
  type DiscordAdapterOptions,
} from "../../../src/surface/discord/discord-adapter";
import {
  SurfaceMessageNotFound,
  SurfacePermissionDenied,
  SurfacePlatformMismatch,
  SurfaceRateLimited,
  SurfaceSessionMismatch,
  SurfaceUnavailable,
  SurfaceInvalidInput,
} from "../../../src/surface/adapter";
import type { AdapterEvent } from "../../../src/surface/events";
import type { ContentOpts } from "../../../src/surface/types";
import { toBusDiscordCommandInvokedData } from "../../../src/surface/discord/discord-command-projection";
import { DiscordSurfaceStore } from "../../../src/surface/store/discord-surface-store";

describe("Discord command actor projection", () => {
  it("omits an anonymous actor instead of emitting an incomplete actor", () => {
    const projected = toBusDiscordCommandInvokedData({
      type: "adapter.command.invoked",
      platform: "discord",
      requestId: "discord:channel:command",
      sessionId: "channel",
      commandName: "ask",
      args: [],
      text: "hello",
      ts: 1,
      sessionMode: "mention",
      sessionConfigId: "channel",
    });

    expect(Object.hasOwn(projected.raw ?? {}, "authenticatedActor")).toBe(false);
  });
});

describe("Discord reply-chain channel boundary", () => {
  it("truncates a thread-parent relation without exposing parent content or raising Panic", async () => {
    const store = new DiscordSurfaceStore(":memory:");
    const adapter = createTestDiscordAdapter();
    Object.assign(adapter, { store });
    store.upsertMessageRelation({
      channelId: "thread",
      messageId: "reply",
      authorId: "user",
      ts: 2,
      isChat: true,
      replyToChannelId: "parent",
      replyToMessageId: "private-parent-content",
      updatedTs: 2,
    });
    store.upsertMessageRelation({
      channelId: "parent",
      messageId: "private-parent-content",
      authorId: "other-user",
      ts: 1,
      isChat: true,
      updatedTs: 1,
    });

    try {
      const planned = await adapter.planReplyChain({
        platform: "discord",
        channelId: "thread",
        messageId: "reply",
      });
      expect(planned).toEqual(
        Result.ok([{ platform: "discord", channelId: "thread", messageId: "reply" }]),
      );
      expect(JSON.stringify(planned)).not.toContain("private-parent-content");
    } finally {
      store.close();
    }
  });
});

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

const EMPTY_DISCORD_CONTENT_CASES: ContentOpts[] = [
  {},
  { text: "" },
  { text: "   " },
  { attachments: [] },
  { actions: [] },
];

const VALID_DISCORD_CONTENT_CASES: ContentOpts[] = [
  { text: "hello" },
  {
    attachments: [
      { kind: "file", filename: "a.txt", mimeType: "text/plain", bytes: new Uint8Array() },
    ],
  },
  { actions: [{ actionId: "continue", label: "Continue", style: "primary" }] },
];

describe("classifyDiscordSurfaceNotFound", () => {
  it("maps only Discord unknown-channel/message codes to the common typed error", () => {
    for (const code of [10_003, 10_008]) {
      const classified = classifyDiscordSurfaceNotFound({ code }, "missing");
      expect(classified).toBeInstanceOf(SurfaceMessageNotFound);
      expect(classified).toMatchObject({
        platform: "discord",
        operation: "read-message",
      });
    }
    expect(classifyDiscordSurfaceNotFound({ code: 50_013 }, "forbidden")).toBeNull();
    expect(classifyDiscordSurfaceNotFound(new Error("network"), "network")).toBeNull();
  });
});

describe("classifyDiscordSurfaceError", () => {
  it.each([
    [{ code: 50_013 }, SurfacePermissionDenied],
    [{ status: 403 }, SurfacePermissionDenied],
    [{ code: 20_028, retry_after: 1.25 }, SurfaceRateLimited],
    [{ status: 400 }, SurfaceInvalidInput],
    [{ status: 503 }, SurfaceUnavailable],
  ] as const)("classifies recognized Discord failures", (cause, ErrorType) => {
    const classified = classifyDiscordSurfaceError("send-message", cause);
    expect(classified).toBeInstanceOf(ErrorType);
    expect(classified).toMatchObject({ platform: "discord", operation: "send-message" });
  });

  it("classifies adapter availability and leaves unknown defects unclassified", () => {
    expect(
      classifyDiscordSurfaceError(
        "list-sessions",
        new DiscordAdapterUnavailable({ message: "disconnected" }),
      ),
    ).toBeInstanceOf(SurfaceUnavailable);
    expect(classifyDiscordSurfaceError("send-message", new Error("unknown"))).toBeNull();
  });
});

describe("DiscordAdapter nested refs", () => {
  it("starts a resumable output stream without invoking Discord", async () => {
    let providerCalls = 0;
    const config = testConfigWithStatusMessage();
    const adapter = createTestDiscordAdapter({ config });
    const internals = adapter as unknown as { client: unknown; cfg: CoreConfig };
    internals.client = {
      channels: {
        fetch: async () => {
          providerCalls += 1;
          return null;
        },
      },
    };
    internals.cfg = config;

    const result = await adapter.startOutput(
      { platform: "discord", channelId: "c1" },
      {
        resume: {
          created: [{ platform: "discord", channelId: "c1", messageId: "existing" }],
        },
      },
    );

    expect(result.status).toBe("ok");
    expect(providerCalls).toBe(0);
  });

  it("threads enabled math options into output streams and omits disabled options", async () => {
    const base = testConfigWithStatusMessage();
    const enabledConfig: CoreConfig = {
      ...base,
      surface: {
        ...base.surface,
        discord: {
          ...base.surface.discord,
          markdownMathRender: {
            enabled: true,
            maxWidth: 37,
            fallbackMode: "passthrough",
          },
        },
      },
    };

    for (const [config, expected] of [
      [enabledConfig, { maxWidth: 37, fallbackMode: "passthrough" }],
      [base, undefined],
    ] as const) {
      const adapter = createTestDiscordAdapter({ config });
      Object.assign(adapter, {
        client: { channels: { fetch: async () => null } },
        cfg: config,
      });

      const result = await adapter.startOutput({ platform: "discord", channelId: "c1" });
      expect(result.status).toBe("ok");
      if (result.status === "error") throw result.error;
      const deps = Reflect.get(result.value as object, "deps") as {
        markdownMathRender?: unknown;
      };
      expect(deps.markdownMathRender).toEqual(expected);
    }
  });

  it.each([
    [
      { platform: "github", channelId: "c1", messageId: "m1" } as const,
      SurfacePlatformMismatch,
      "replyTo",
    ],
    [
      { platform: "discord", channelId: "c2", messageId: "m1" } as const,
      SurfaceSessionMismatch,
      "replyTo",
    ],
  ] as const)(
    "rejects invalid reply targets before connecting",
    async (replyTo, ErrorType, refRole) => {
      const result = await createTestDiscordAdapter().startOutput(
        { platform: "discord", channelId: "c1" },
        { replyTo },
      );

      expect(result.status).toBe("error");
      if (result.status === "ok") throw new Error("expected nested-ref failure");
      expect(result.error).toBeInstanceOf(ErrorType);
      expect(result.error).toMatchObject({ operation: "start-output", refRole });
    },
  );

  it("identifies the mismatched resumed ref", async () => {
    const result = await createTestDiscordAdapter().startOutput(
      { platform: "discord", channelId: "c1" },
      {
        resume: {
          created: [{ platform: "discord", channelId: "c2", messageId: "m1" }],
        },
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected nested-ref failure");
    expect(result.error).toBeInstanceOf(SurfaceSessionMismatch);
    expect(result.error).toMatchObject({ refRole: "resume.created[0]" });
  });
});

describe("DiscordAdapter.sendMsg content validation", () => {
  it("prepares sends without invoking the Discord provider", async () => {
    let providerCalls = 0;
    const adapter = createTestDiscordAdapter();
    (adapter as unknown as { client: unknown }).client = {
      channels: {
        fetch: async () => {
          providerCalls += 1;
          return null;
        },
      },
    };

    expect(
      await adapter.prepareSendMsg(
        { platform: "discord", channelId: "c1" },
        { text: "prepared", attachmentCount: 1, actionCount: 0 },
      ),
    ).toEqual(Result.ok(undefined));
    expect(providerCalls).toBe(0);
  });

  it.each(EMPTY_DISCORD_CONTENT_CASES)("rejects a truly empty payload %#", async (content) => {
    const result = await createTestDiscordAdapter().sendMsg(
      { platform: "discord", channelId: "c1" },
      content,
    );

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected empty payload failure");
    expect(result.error).toBeInstanceOf(SurfaceInvalidInput);
    expect(result.error).toMatchObject({ operation: "send-message", field: "content" });
  });

  it.each(VALID_DISCORD_CONTENT_CASES)(
    "accepts non-empty payload shape %# before provider availability",
    async (content) => {
      const result = await createTestDiscordAdapter().sendMsg(
        { platform: "discord", channelId: "c1" },
        content,
      );

      expect(result.status).toBe("error");
      if (result.status === "ok") throw new Error("expected disconnected adapter failure");
      expect(result.error).toBeInstanceOf(SurfaceUnavailable);
    },
  );
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

describe("Discord cache policy", () => {
  it("preserves defaults and applies the bounded manager limits", () => {
    expect(DISCORD_CACHE_SETTINGS.MessageManager).toBe(
      Options.DefaultMakeCacheSettings.MessageManager,
    );
    expect(DISCORD_CACHE_SETTINGS.GuildMemberManager.maxSize).toBe(256);
    expect(DISCORD_CACHE_SETTINGS.PresenceManager).toBe(256);
    expect(DISCORD_CACHE_SETTINGS.ThreadMemberManager).toBe(256);
    expect(DISCORD_CACHE_SETTINGS.UserManager).toBe(2_048);
    expect(DISCORD_CACHE_SETTINGS.ReactionManager).toBe(25);
    expect(DISCORD_CACHE_SETTINGS.ReactionUserManager).toBe(0);

    const botMember = {
      id: "bot",
      client: { user: { id: "bot" } },
    } as unknown as GuildMember;
    const otherMember = {
      id: "other",
      client: { user: { id: "bot" } },
    } as unknown as GuildMember;

    expect(DISCORD_CACHE_SETTINGS.GuildMemberManager.keepOverLimit(botMember)).toBe(true);
    expect(DISCORD_CACHE_SETTINGS.GuildMemberManager.keepOverLimit(otherMember)).toBe(false);
  });
});

describe("DiscordAdapter.getHealthSnapshot", () => {
  it("samples gateway state and reports aggregate cache diagnostics", () => {
    const adapter = createTestDiscordAdapter();
    const adapterWithClient = adapter as unknown as {
      client: {
        token: string;
        ws: {
          ping: number;
          shards: Map<number, { lastPingTimestamp: number }>;
        };
        guilds: {
          cache: Map<
            string,
            {
              members: { cache: Map<string, unknown> };
              presences: { cache: Map<string, unknown> };
            }
          >;
        };
        users: { cache: Map<string, unknown> };
        channels: { cache: Map<string, unknown> };
      } | null;
    };

    adapterWithClient.client = {
      token: "discord-secret-token",
      ws: {
        ping: 123,
        shards: new Map<number, { lastPingTimestamp: number }>([
          [0, { lastPingTimestamp: 1_000 }],
          [1, { lastPingTimestamp: 2_000 }],
        ]),
      },
      guilds: {
        cache: new Map([
          [
            "g1",
            {
              members: {
                cache: new Map([
                  ["u1", {}],
                  ["u2", {}],
                ]),
              },
              presences: { cache: new Map([["u1", {}]]) },
            },
          ],
        ]),
      },
      users: {
        cache: new Map([
          ["u1", {}],
          ["u2", {}],
          ["u3", {}],
        ]),
      },
      channels: {
        cache: new Map([
          [
            "c1",
            {
              isThread: () => false,
              messages: {
                cache: new Map([
                  [
                    "m1",
                    {
                      reactions: {
                        cache: new Map([
                          [
                            "r1",
                            {
                              users: {
                                cache: new Map([
                                  ["u1", {}],
                                  ["u2", {}],
                                ]),
                              },
                            },
                          ],
                        ]),
                      },
                    },
                  ],
                ]),
              },
            },
          ],
          [
            "t1",
            {
              isThread: () => true,
              members: {
                cache: new Map([
                  ["u1", {}],
                  ["u2", {}],
                ]),
              },
              messages: { cache: new Map() },
            },
          ],
        ]),
      },
    };

    expect(adapter.getHealthSnapshot().cache).toBeUndefined();
    const snapshot = adapter.getHealthSnapshot({ includeCache: true });

    expect(snapshot.gatewayPingMs).toBe(123);
    expect(snapshot.lastGatewayPingAt).toBe(2_000);
    expect(snapshot.cache).toEqual({
      perManagerLimits: DISCORD_CACHE_LIMITS,
      aggregateSizes: {
        MessageManager: 1,
        GuildMemberManager: 2,
        PresenceManager: 1,
        ThreadMemberManager: 2,
        UserManager: 3,
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("discord-secret-token");
  });
});

describe("DiscordAdapter.listSessionParticipants", () => {
  it("lists guild members without populating the member cache", async () => {
    const listCalls: unknown[] = [];
    const user = { id: "u1", username: "alice", globalName: "Alice" };
    const member = {
      id: "u1",
      user,
      displayName: "Alice",
      presence: null,
    } as unknown as GuildMember;
    const guild = {
      members: {
        list: async (options: unknown) => {
          listCalls.push(options);
          return new Collection([[member.id, member]]);
        },
        cache: new Collection<string, GuildMember>(),
      },
      presences: { cache: new Collection() },
    };
    const adapter = createTestDiscordAdapter();
    const state = adapter as unknown as {
      cfg: CoreConfig | null;
      client: { channels: { fetch(): Promise<unknown> } } | null;
      store: { upsertUserName(input: unknown): void } | null;
    };
    state.cfg = testConfigWithStatusMessage();
    state.client = {
      channels: {
        fetch: async () => ({ guildId: "g1", isThread: () => false, guild }),
      },
    };
    state.store = { upsertUserName: () => {} };

    const result = await adapter.listSessionParticipants(
      { platform: "discord", channelId: "c1", guildId: "g1" },
      { limit: 1 },
    );

    expect(listCalls).toEqual([{ limit: 1, cache: false }]);
    expect(result.status).toBe("ok");
    if (result.status === "error") throw result.error;
    expect(result.value).toMatchObject({
      source: "guild_members",
      participants: [{ userId: "u1", userName: "alice", displayName: "Alice" }],
    });
  });

  it("uses thread member payloads without per-participant member or user fetches", async () => {
    const threadFetchCalls: unknown[] = [];
    let guildMemberFetches = 0;
    let userFetches = 0;
    const user = { id: "u1", username: "alice", globalName: "Alice" };
    const member = {
      id: "u1",
      user,
      displayName: "Alice",
      presence: null,
    } as unknown as GuildMember;
    const threadMember = {
      id: "u1",
      guildMember: member,
      user,
    } as unknown as ThreadMember<true>;
    const adapter = createTestDiscordAdapter();
    const state = adapter as unknown as {
      cfg: CoreConfig | null;
      client: {
        channels: { fetch(): Promise<unknown> };
        users: { fetch(userId: string): Promise<unknown> };
      } | null;
      store: { upsertUserName(input: unknown): void } | null;
    };
    state.cfg = testConfigWithStatusMessage();
    state.client = {
      channels: {
        fetch: async () => ({
          guildId: "g1",
          isThread: () => true,
          members: {
            fetch: async (options: unknown) => {
              threadFetchCalls.push(options);
              return new Collection([[threadMember.id, threadMember]]);
            },
          },
          guild: {
            members: {
              cache: new Collection<string, GuildMember>(),
              fetch: async () => {
                guildMemberFetches += 1;
                return member;
              },
            },
            presences: { cache: new Collection() },
          },
        }),
      },
      users: {
        fetch: async () => {
          userFetches += 1;
          return user;
        },
      },
    };
    state.store = { upsertUserName: () => {} };

    const result = await adapter.listSessionParticipants(
      { platform: "discord", channelId: "c1", guildId: "g1" },
      { limit: 200 },
    );

    expect(threadFetchCalls).toEqual([{ withMember: true, limit: 100, cache: false }]);
    expect(guildMemberFetches).toBe(0);
    expect(userFetches).toBe(0);
    expect(result.status).toBe("ok");
    if (result.status === "error") throw result.error;
    expect(result.value).toMatchObject({
      source: "thread_members",
      participants: [{ userId: "u1", userName: "alice", displayName: "Alice" }],
    });
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
  it("keeps paused recovery preparation provider-mutation free until normal output preparation", async () => {
    const previousConfig = testConfigWithStatusMessage("previous presence");
    const changedConfig = testConfigWithStatusMessage("changed presence");
    let cfg = previousConfig;
    let configReads = 0;
    let channelFetches = 0;
    const providerMutations: Array<{ readonly operation: string; readonly value?: unknown }> = [];
    const adapter = createTestDiscordAdapter({
      getConfig: async () => {
        configReads += 1;
        return cfg;
      },
    });
    const internals = adapter as unknown as {
      client: unknown;
      cfg: CoreConfig;
      appliedStatusMessage: string | null | undefined;
    };
    internals.client = {
      user: {
        setPresence(value: unknown) {
          providerMutations.push({ operation: "setPresence", value });
        },
      },
      channels: {
        fetch: async () => {
          channelFetches += 1;
          const restoredMessage = {
            id: "restored-output",
            channelId: "c1",
            attachments: new Map(),
            edit: async (value: unknown) => {
              providerMutations.push({ operation: "edit", value });
              return restoredMessage;
            },
            reply: async (value: unknown) => {
              providerMutations.push({ operation: "reply", value });
              return restoredMessage;
            },
            delete: async () => {
              providerMutations.push({ operation: "delete" });
            },
          };
          return {
            send: async (value: unknown) => {
              providerMutations.push({ operation: "send", value });
              return restoredMessage;
            },
            messages: { fetch: async () => restoredMessage },
          };
        },
      },
    };
    internals.cfg = previousConfig;
    internals.appliedStatusMessage = "previous presence";
    cfg = changedConfig;

    const prepared = await adapter.startOutput(
      { platform: "discord", channelId: "c1" },
      {
        preparationMode: "paused-recovery",
        resume: {
          created: [{ platform: "discord", channelId: "c1", messageId: "restored-output" }],
        },
      },
    );
    expect(prepared.status).toBe("ok");
    if (prepared.status === "error") throw prepared.error;
    expect(
      prepared.value.hydrateRecovery?.([{ type: "text.set", text: "restored response" }]),
    ).toBe("visible");
    await expect(prepared.value.abort("restore_rollback")).resolves.toEqual(Result.ok(undefined));
    expect({ configReads, channelFetches, providerMutations }).toEqual({
      configReads: 1,
      channelFetches: 0,
      providerMutations: [],
    });

    const normal = await adapter.startOutput({ platform: "discord", channelId: "c1" });
    expect(normal.status).toBe("ok");
    expect(configReads).toBe(2);
    expect(channelFetches).toBe(0);
    expect(providerMutations).toEqual([
      {
        operation: "setPresence",
        value: {
          activities: [
            {
              name: "changed presence",
              state: "changed presence",
              type: ActivityType.Custom,
            },
          ],
          status: "online",
        },
      },
    ]);
  });

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
    const fetchCalls: unknown[] = [];
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
            fetch: async (options: unknown) => {
              fetchCalls.push(options);
              return message;
            },
          },
        }),
      },
    };

    await adapter.editMsg(
      { platform: "discord", channelId: "c1", messageId: "m1" },
      { text: "new-description" },
    );

    expect(editCalls).toHaveLength(1);
    expect(fetchCalls).toEqual([{ message: "m1", cache: false, force: true }]);
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

    const result = await adapter.editMsg(
      { platform: "discord", channelId: "c1", messageId: "m1" },
      { text: "updated" },
    );
    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected edit failure");
    expect(result.error).toBeInstanceOf(SurfacePermissionDenied);
    expect(result.error.message).toContain("authored by the Lilac Discord bot");
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
