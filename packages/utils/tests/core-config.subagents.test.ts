import { describe, expect, it } from "bun:test";

import { coreConfigSchema, parseCoreConfigV2ToUniversal } from "../core-config";

describe("coreConfigSchema agent.subagents", () => {
  it("defaults all built-in subagent profiles to modelSlot=main", () => {
    const parsed = parseCoreConfigV2ToUniversal({ configVersion: 2 });
    expect(parsed.agent.subagents.maxDepth).toBe(2);
    expect(parsed.agent.subagents.profiles.explore.modelSlot).toBe("main");
    expect(parsed.agent.subagents.profiles.general.modelSlot).toBe("main");
    expect(parsed.agent.subagents.profiles.self.modelSlot).toBe("main");
    expect(parsed.agent.subagents.profiles.explore.model).toBeUndefined();
    expect(parsed.agent.subagents.profiles.general.model).toBeUndefined();
    expect(parsed.agent.subagents.profiles.self.model).toBeUndefined();
    expect(parsed.agent.subagents.profiles.explore).toMatchObject({
      level1: {
        tools: ["bash", "read", "glob", "grep", "fuzzy_search", "batch"],
        plugins: ["builtin-local-tools"],
      },
      network: true,
      workspaceWrites: false,
      execution: "restricted",
      delegation: false,
    });
    expect(parsed.agent.subagents.profiles.general).toMatchObject({
      network: true,
      workspaceWrites: true,
      execution: "native",
      delegation: false,
    });
    expect(parsed.agent.subagents.profiles.self).toMatchObject({
      network: true,
      workspaceWrites: true,
      execution: "native",
      delegation: true,
    });
  });

  it("normalizes legacy v2 tool names in profile overrides", () => {
    const profile = parseCoreConfigV2ToUniversal({
      configVersion: 2,
      agent: {
        subagents: {
          profiles: {
            general: {
              level1: { tools: ["read_file", "edit_file", "apply_patch"], plugins: ["local"] },
              level2: { callables: ["fetch"], plugins: ["web"] },
              network: false,
              workspaceWrites: false,
              execution: false,
              delegation: true,
            },
          },
        },
      },
    }).agent.subagents.profiles.general;

    expect(profile).toMatchObject({
      level1: { tools: ["read", "edit", "patch"], plugins: ["local"] },
      level2: { callables: ["fetch"], plugins: ["web"] },
      network: false,
      workspaceWrites: false,
      execution: false,
      delegation: true,
    });
  });

  it("accepts execution modes and rejects the former true value", () => {
    const parsed = parseCoreConfigV2ToUniversal({
      configVersion: 2,
      agent: {
        subagents: {
          profiles: {
            explore: { execution: false },
            general: { execution: "restricted" },
            self: { execution: "native" },
          },
        },
      },
    });

    expect(parsed.agent.subagents.profiles.explore.execution).toBe(false);
    expect(parsed.agent.subagents.profiles.general.execution).toBe("restricted");
    expect(parsed.agent.subagents.profiles.self.execution).toBe("native");
    expect(() =>
      parseCoreConfigV2ToUniversal({
        configVersion: 2,
        agent: { subagents: { profiles: { general: { execution: true } } } },
      }),
    ).toThrow();
  });

  it("accepts profile model alias/spec with options", () => {
    const parsed = coreConfigSchema.parse({
      agent: {
        subagents: {
          profiles: {
            explore: {
              model: "sonnet",
              options: {
                anthropic: {
                  thinking: { type: "enabled" },
                },
              },
            },
            general: {
              model: "openrouter/openai/gpt-4o-mini",
            },
            self: {
              model: "codex/gpt-5-mini",
            },
          },
        },
      },
    });

    expect(parsed.agent.subagents.profiles.explore.model).toBe("sonnet");
    expect(parsed.agent.subagents.profiles.general.model).toBe("openrouter/openai/gpt-4o-mini");
    expect(parsed.agent.subagents.profiles.self.model).toBe("codex/gpt-5-mini");
    expect(parsed.agent.subagents.profiles.explore.options?.anthropic).toEqual({
      thinking: { type: "enabled" },
    });
  });

  it("accepts maxDepth=2 and rejects values above 2", () => {
    const parsed = coreConfigSchema.parse({
      agent: {
        subagents: {
          maxDepth: 2,
        },
      },
    });

    expect(parsed.agent.subagents.maxDepth).toBe(2);

    expect(() =>
      coreConfigSchema.parse({
        agent: {
          subagents: {
            maxDepth: 3,
          },
        },
      }),
    ).toThrow();
  });

  it("rejects explore options when model is not set", () => {
    expect(() =>
      coreConfigSchema.parse({
        agent: {
          subagents: {
            profiles: {
              explore: {
                options: {
                  openai: {
                    temperature: 0.2,
                  },
                },
              },
            },
          },
        },
      }),
    ).toThrow("options requires model to be set");
  });

  it("rejects self options when model is not set", () => {
    expect(() =>
      coreConfigSchema.parse({
        agent: {
          subagents: {
            profiles: {
              self: {
                options: {
                  openai: {
                    temperature: 0.2,
                  },
                },
              },
            },
          },
        },
      }),
    ).toThrow("options requires model to be set");
  });
});
