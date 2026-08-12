import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { LEVEL1_TOOL_NAMES } from "@stanley2058/lilac-coding-tools";
import {
  MINI_LILAC_EXECUTABLE_TOOL_NAMES,
  MINI_LILAC_SYNTHETIC_TOOL_NAMES,
} from "@stanley2058/mini-lilac-client";

import {
  decodeRuntimeConfig,
  decodeRuntimeConfigYaml,
  loadRuntimeConfig,
  loadRuntimeConfigResult,
  runtimeConfigSchema,
} from "../src/config";
import * as runtimeRoot from "../src/index";

const directories: string[] = [];

describe("Mini Lilac tool catalog", () => {
  it("stays aligned with Level 1 and runtime-owned tools", () => {
    expect(new Set(MINI_LILAC_EXECUTABLE_TOOL_NAMES)).toEqual(
      new Set([...LEVEL1_TOOL_NAMES, "skill", "todowrite", "webfetch", "websearch"]),
    );
    expect(MINI_LILAC_SYNTHETIC_TOOL_NAMES).toEqual(["subagent_result"]);
  });
});

describe("package root exports", () => {
  it("exports Result APIs and owned error contracts without removing legacy APIs", () => {
    for (const exportName of [
      "loadRuntimeConfig",
      "loadRuntimeConfigResult",
      "decodeRuntimeConfig",
      "decodeRuntimeConfigYaml",
      "loadProviderConfig",
      "loadProviderConfigResult",
      "loadProviderAuth",
      "loadProviderAuthResult",
      "writeProviderAuth",
      "writeProviderAuthResult",
      "createAiProviderRegistry",
      "createAiProviderRegistryResult",
      "loadProviderRegistry",
      "loadProviderRegistryResult",
      "ModelCatalog",
      "createModelCatalogResult",
      "parseModelRef",
      "parseModelRefResult",
      "resolveLanguageModel",
      "resolveLanguageModelResult",
      "RuntimeConfigInvalid",
      "ProviderAuthInvalid",
      "ProviderCodexTokensReadFailed",
      "ModelCatalogRequestAndCleanupFailed",
      "ModelCatalogResponseCleanupFailed",
      "MiniLilacSkillUnavailable",
    ]) {
      expect(Object.hasOwn(runtimeRoot, exportName)).toBe(true);
    }
    expect(runtimeRoot.MiniLilacSkillCatalogSnapshot.prototype.loadResult).toBeFunction();
    expect(runtimeRoot.MiniLilacSkillCatalog.prototype.discoverResult).toBeFunction();
  });
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-config-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const baseConfig = {
  configVersion: 1,
  server: { host: "127.0.0.1", port: 8080 },
  providerConfigFile: "providers.yaml",
  providerAuthFile: "secret/auth.json",
  agent: {
    systemPrompt: "Be useful.",
    defaultProfile: "main",
    profiles: {
      main: {
        tools: ["*"],
        execution: true,
        workspaceWrites: true,
        delegation: false,
      },
    },
  },
} as const;

describe("runtime config", () => {
  it("redacts malformed YAML parser payloads", () => {
    const secret = "runtime-config-parser-secret";
    const malformed = decodeRuntimeConfigYaml(`server: [${secret}`, "fixture.yaml");

    expect(malformed.status).toBe("error");
    if (malformed.status === "error") {
      expect(Object.hasOwn(malformed.error, "cause")).toBe(false);
      expect(JSON.stringify(malformed.error)).not.toContain(secret);
    }
  });

  it("returns typed decode and load failures without exposing config contents", async () => {
    const invalid = decodeRuntimeConfig({ ...baseConfig, secret: "must-not-leak" }, "fixture.yaml");
    expect(invalid.status).toBe("error");
    if (invalid.status === "error") {
      expect(invalid.error._tag).toBe("RuntimeConfigInvalid");
      expect(JSON.stringify(invalid.error)).not.toContain("must-not-leak");
    }

    const missing = await loadRuntimeConfigResult("/definitely/missing/mini-lilac.yaml");
    expect(missing.status).toBe("error");
    if (missing.status === "error") expect(missing.error._tag).toBe("RuntimeConfigReadFailed");
  });

  it("loads strict config, defaults profile fields, and resolves sibling paths", async () => {
    const directory = await tempDirectory();
    const file = path.join(directory, "config.yaml");
    await Bun.write(file, JSON.stringify(baseConfig));

    const config = await loadRuntimeConfig(file, { env: {} });

    expect(config.providerConfigFile).toBe(path.join(directory, "providers.yaml"));
    expect(config.providerAuthFile).toBe(path.join(directory, "secret/auth.json"));
    expect(config.agent.profiles.main?.subagentOnly).toBe(false);
    expect(config.agent.idleTimeoutMs).toBe(900_000);
    expect(config.agent.subagents).toEqual({
      enabled: true,
      maxDepth: 1,
    });
    expect(config.agent.compaction).toEqual({
      model: "inherit",
      earlyCompactionPoint: 0.8,
    });
  });

  it("rejects unknown top-level and profile keys", () => {
    expect(() => runtimeConfigSchema.parse({ ...baseConfig, models: {} })).toThrow();
    expect(() =>
      runtimeConfigSchema.parse({
        ...baseConfig,
        agent: {
          ...baseConfig.agent,
          profiles: { main: { ...baseConfig.agent.profiles.main, workspace: "/tmp" } },
        },
      }),
    ).toThrow();
    expect(() =>
      runtimeConfigSchema.parse({
        ...baseConfig,
        agent: {
          ...baseConfig.agent,
          subagents: {
            enabled: true,
            maxDepth: 1,
            maxChildrenPerRun: 8,
            maxConcurrent: 4,
            idleTimeoutMs: 360_000,
          },
        },
      }),
    ).toThrow();
  });

  it("accepts title and compaction model overrides with a bounded early point", () => {
    const parsed = runtimeConfigSchema.parse({
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        titleModel: "openai/gpt-title",
        compaction: { model: "anthropic/claude-summary", earlyCompactionPoint: 0.65 },
      },
    });
    expect(parsed.agent.titleModel).toBe("openai/gpt-title");
    expect(parsed.agent.compaction).toEqual({
      model: "anthropic/claude-summary",
      earlyCompactionPoint: 0.65,
    });
    expect(() =>
      runtimeConfigSchema.parse({
        ...baseConfig,
        agent: {
          ...baseConfig.agent,
          compaction: { model: "inherit", earlyCompactionPoint: 1 },
        },
      }),
    ).toThrow();
  });

  it("requires authentication for non-loopback hosts and a populated token env", async () => {
    expect(() =>
      runtimeConfigSchema.parse({ ...baseConfig, server: { host: "0.0.0.0", port: 8080 } }),
    ).toThrow("authTokenEnv");

    const directory = await tempDirectory();
    const file = path.join(directory, "config.yaml");
    await Bun.write(
      file,
      JSON.stringify({
        ...baseConfig,
        server: { host: "0.0.0.0", port: 8080, authTokenEnv: "MINI_TOKEN" },
      }),
    );
    await expect(loadRuntimeConfig(file, { env: {} })).rejects.toThrow("missing or empty");
    expect((await loadRuntimeConfig(file, { env: { MINI_TOKEN: "secret" } })).server.host).toBe(
      "0.0.0.0",
    );
  });

  it("requires authentication for localhost hostnames but accepts explicit loopback addresses", () => {
    expect(() =>
      runtimeConfigSchema.parse({
        ...baseConfig,
        server: { host: "localhost", port: 8080 },
      }),
    ).toThrow("non-loopback hosts require server.authTokenEnv");
    expect(() =>
      runtimeConfigSchema.parse({
        ...baseConfig,
        server: { host: "localhost", port: 8080, authTokenEnv: "MINI_TOKEN" },
      }),
    ).not.toThrow();
    expect(() =>
      runtimeConfigSchema.parse({
        ...baseConfig,
        server: { host: "127.0.0.42", port: 8080 },
      }),
    ).not.toThrow();
    expect(() =>
      runtimeConfigSchema.parse({
        ...baseConfig,
        server: { host: "::1", port: 8080 },
      }),
    ).not.toThrow();
  });

  it("rejects invalid profile references and slug keys", () => {
    expect(() =>
      runtimeConfigSchema.parse({
        ...baseConfig,
        agent: { ...baseConfig.agent, defaultProfile: "missing" },
      }),
    ).toThrow("not defined");
    expect(() =>
      runtimeConfigSchema.parse({
        ...baseConfig,
        agent: {
          ...baseConfig.agent,
          profiles: { "Not Valid": baseConfig.agent.profiles.main },
        },
      }),
    ).toThrow();
  });

  it("rejects unknown configured tools but permits the wildcard", () => {
    expect(() =>
      runtimeConfigSchema.parse({
        ...baseConfig,
        agent: {
          ...baseConfig.agent,
          profiles: { main: { ...baseConfig.agent.profiles.main, tools: ["not-a-tool"] } },
        },
      }),
    ).toThrow("unknown tool");
    expect(runtimeConfigSchema.parse(baseConfig).agent.profiles.main?.tools).toEqual(["*"]);
    expect(
      runtimeConfigSchema.parse({
        ...baseConfig,
        agent: {
          ...baseConfig.agent,
          profiles: {
            main: {
              ...baseConfig.agent.profiles.main,
              tools: [...MINI_LILAC_EXECUTABLE_TOOL_NAMES],
            },
          },
        },
      }).agent.profiles.main?.tools,
    ).toEqual([...MINI_LILAC_EXECUTABLE_TOOL_NAMES]);
    expect(() =>
      runtimeConfigSchema.parse({
        ...baseConfig,
        agent: {
          ...baseConfig.agent,
          profiles: {
            main: { ...baseConfig.agent.profiles.main, tools: ["subagent_result"] },
          },
        },
      }),
    ).toThrow("unknown tool");
  });

  it("accepts legacy configured tool names and normalizes them to canonical names", () => {
    const parsed = runtimeConfigSchema.parse({
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        profiles: {
          main: {
            ...baseConfig.agent.profiles.main,
            tools: ["read_file", "edit_file", "apply_patch"],
          },
        },
      },
    });

    expect(parsed.agent.profiles.main?.tools).toEqual(["read", "edit", "patch"]);
  });
});
