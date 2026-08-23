import { describe, expect, it } from "bun:test";

import {
  coreConfigSchema,
  parseCoreConfigV1ToUniversal,
  resolveRouterSessionConfig,
} from "../core-config";

describe("coreConfigSchema surface.router.sessionModes", () => {
  it("inherits every option independently from guild through parent and channel", () => {
    const parsed = parseCoreConfigV1ToUniversal({
      surface: {
        router: {
          sessionModes: {
            guild: {
              mode: "active",
              gate: false,
              model: "guild-model",
              safetyMode: "restricted",
              additionalPrompts: ["guild memo"],
            },
            parent: {
              gate: true,
              model: "parent-model",
            },
            channel: {
              model: "channel-model",
              additionalPrompts: [],
            },
          },
        },
      },
    });

    expect(
      resolveRouterSessionConfig(parsed, {
        sessionId: "channel",
        parentChannelId: "parent",
        guildId: "guild",
      }),
    ).toEqual({
      mode: "active",
      gate: true,
      model: "channel-model",
      safetyMode: "restricted",
      additionalPrompts: [],
    });
  });

  it("inherits fields added after the resolver", () => {
    const parsed = parseCoreConfigV1ToUniversal({
      surface: {
        router: {
          sessionModes: {
            guild: { gate: false },
            channel: { mode: "active" },
          },
        },
      },
    });
    Object.assign(parsed.surface.router.sessionModes.guild!, {
      futureOption: "guild-value",
    });

    const resolved = resolveRouterSessionConfig(parsed, {
      sessionId: "channel",
      guildId: "guild",
    }) as Record<string, unknown>;

    expect(resolved.futureOption).toBe("guild-value");
  });

  it("accepts gate-only session overrides", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        router: {
          defaultMode: "active",
          sessionModes: {
            "123": {
              gate: true,
            },
          },
        },
      },
    });

    expect(parsed.surface.router.defaultMode).toBe("active");
    expect(parsed.surface.router.sessionModes["123"]?.mode).toBeUndefined();
    expect(parsed.surface.router.sessionModes["123"]?.gate).toBe(true);
  });

  it("accepts additionalPrompts session overrides", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        router: {
          sessionModes: {
            chan: {
              additionalPrompts: [
                "Keep this session focused on release readiness.",
                "file:///tmp/session-memo.md",
              ],
            },
          },
        },
      },
    });

    expect(parsed.surface.router.sessionModes.chan?.additionalPrompts).toEqual([
      "Keep this session focused on release readiness.",
      "file:///tmp/session-memo.md",
    ]);
  });

  it("accepts model session overrides", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        router: {
          sessionModes: {
            chan: {
              model: "sonnet",
            },
          },
        },
      },
    });

    expect(parsed.surface.router.sessionModes.chan?.model).toBe("sonnet");
  });

  it("accepts restricted safety mode session overrides", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        router: {
          sessionModes: {
            public: {
              safetyMode: "restricted",
            },
          },
        },
      },
    });

    expect(parsed.surface.router.sessionModes.public?.safetyMode).toBe("restricted");
  });

  it("accepts canonical and alias heartbeat session keys", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        router: {
          sessionModes: {
            __heartbeat__: {
              model: "sonnet",
            },
            heartbeat: {
              model: "haiku",
            },
          },
        },
      },
    });

    expect(parsed.surface.router.sessionModes.__heartbeat__?.model).toBe("sonnet");
    expect(parsed.surface.router.sessionModes.heartbeat?.model).toBe("haiku");
  });
});

describe("coreConfigSchema entity aliases", () => {
  it("accepts optional alias comments and legacy session strings", () => {
    const parsed = coreConfigSchema.parse({
      entity: {
        users: {
          alice: {
            discord: "u1",
            comment: "Primary operator",
          },
        },
        sessions: {
          discord: {
            ops: {
              discord: "c1",
              comment: "Deploy coordination",
            },
            general: "c2",
          },
        },
      },
    });

    expect(parsed.entity?.users.alice).toEqual({
      discord: "u1",
      comment: "Primary operator",
    });
    expect(parsed.entity?.sessions.discord.ops).toEqual({
      discord: "c1",
      comment: "Deploy coordination",
    });
    expect(parsed.entity?.sessions.discord.general).toBe("c2");
  });
});
