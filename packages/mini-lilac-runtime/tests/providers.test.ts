import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { formatTaggedErrorForLog } from "@stanley2058/lilac-utils";

import {
  createAiProviderRegistry,
  createAiProviderRegistryResult,
  decodeProviderAuth,
  loadProviderAuth,
  loadProviderAuthResult,
  loadProviderConfig,
  loadProviderRegistry,
  loadProviderRegistryResult,
  providerConfigSchema,
  reasoningProviderOptions,
  writeProviderAuth,
  writeProviderAuthResult,
  type ProviderAuth,
  type ProviderConfig,
} from "../src/providers";
import { loadRuntimeConfig } from "../src/config";

const directories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-providers-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const config: ProviderConfig = {
  configVersion: 1,
  providers: {
    local: {
      type: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      catalog: "v1",
    },
  },
};
const auth: ProviderAuth = { local: { type: "api-key", key: "not-from-env" } };

const oauthTokens = {
  type: "oauth" as const,
  access: "oauth-access-secret",
  refresh: "oauth-refresh-secret",
  expires: Date.now() + 60_000,
};

async function loadTestRegistry(
  providerConfig: ProviderConfig,
  providerAuth: ProviderAuth,
  oauth: typeof oauthTokens | null,
) {
  const runtimeConfig = await writeRegistryFixture(providerConfig, providerAuth);
  return loadProviderRegistry(runtimeConfig, { readCodexTokens: async () => oauth });
}

async function writeRegistryFixture(providerConfig: ProviderConfig, providerAuth: ProviderAuth) {
  const directory = await tempDirectory();
  const providerConfigFile = path.join(directory, "providers.yaml");
  const providerAuthFile = path.join(directory, "auth.json");
  const runtimeConfigFile = path.join(directory, "config.yaml");
  await Bun.write(providerConfigFile, JSON.stringify(providerConfig));
  await Bun.write(providerAuthFile, JSON.stringify(providerAuth));
  await chmod(providerAuthFile, 0o600);
  await Bun.write(
    runtimeConfigFile,
    JSON.stringify({
      configVersion: 1,
      server: { host: "127.0.0.1", port: 8090 },
      providerConfigFile: "./providers.yaml",
      providerAuthFile: "./auth.json",
      agent: {
        systemPrompt: "test",
        defaultProfile: "coding",
        profiles: {
          coding: {
            subagentOnly: false,
            tools: ["*"],
            execution: true,
            workspaceWrites: true,
            delegation: true,
          },
        },
      },
    }),
  );
  return loadRuntimeConfig(runtimeConfigFile);
}

describe("reasoningProviderOptions", () => {
  it("merges Codex OAuth store/include options with detailed summaries", () => {
    expect(
      reasoningProviderOptions({
        usesCodexOAuth: true,
        providerType: "openai",
        reasoningEnabled: true,
      }),
    ).toEqual({
      openai: {
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoningSummary: "detailed",
      },
    });
  });

  it("requests detailed summaries for direct OpenAI providers", () => {
    expect(
      reasoningProviderOptions({
        usesCodexOAuth: false,
        providerType: "openai",
        reasoningEnabled: true,
      }),
    ).toEqual({
      openai: { reasoningSummary: "detailed" },
    });
  });

  it("keeps encrypted reasoning content out of storage for direct OpenAI server compaction", () => {
    expect(
      reasoningProviderOptions({
        usesCodexOAuth: false,
        providerType: "openai",
        reasoningEnabled: true,
        openaiServerCompactionEnabled: true,
      }),
    ).toEqual({
      openai: {
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoningSummary: "detailed",
      },
    });
  });

  it("leaves other provider types and unknown providers untouched", () => {
    expect(
      reasoningProviderOptions({
        usesCodexOAuth: false,
        providerType: "anthropic",
        reasoningEnabled: true,
      }),
    ).toBeUndefined();
    expect(
      reasoningProviderOptions({
        usesCodexOAuth: false,
        providerType: undefined,
        reasoningEnabled: true,
      }),
    ).toBeUndefined();
  });

  it("does not request summaries when reasoning is disabled", () => {
    expect(
      reasoningProviderOptions({
        usesCodexOAuth: true,
        providerType: "openai",
        reasoningEnabled: false,
      }),
    ).toEqual({
      openai: { store: false, include: ["reasoning.encrypted_content"] },
    });
    expect(
      reasoningProviderOptions({
        usesCodexOAuth: false,
        providerType: "openai",
        reasoningEnabled: false,
      }),
    ).toBeUndefined();
  });
});

describe("provider configuration", () => {
  it("returns typed auth failures and keeps rejected secrets out of serialization", async () => {
    const rejected = decodeProviderAuth(
      { local: { type: "api-key", key: "do-not-print", unexpected: true } },
      "auth.json",
    );
    expect(rejected.status).toBe("error");
    if (rejected.status === "error") {
      expect(rejected.error._tag).toBe("ProviderAuthInvalid");
      expect(JSON.stringify(rejected.error)).not.toContain("do-not-print");
    }

    const directory = await tempDirectory();
    const authFile = path.join(directory, "auth.json");
    const written = await writeProviderAuthResult(authFile, {
      local: { type: "api-key", key: "do-not-print", unexpected: true },
    });
    expect(written.status).toBe("error");
    expect(await readdir(directory)).toEqual([]);
    const missing = await loadProviderAuthResult(authFile);
    expect(missing.status).toBe("error");

    const malformedSecret = "malformed-auth-secret";
    await Bun.write(authFile, `{"local":{"type":"api-key","key":"${malformedSecret}"}`);
    await chmod(authFile, 0o600);
    const malformed = await loadProviderAuthResult(authFile);
    expect(malformed.status).toBe("error");
    if (malformed.status === "error") {
      expect(JSON.stringify(malformed.error)).not.toContain(malformedSecret);
      expect(JSON.stringify(formatTaggedErrorForLog(malformed.error))).not.toContain(
        malformedSecret,
      );
      expect(Object.hasOwn(malformed.error, "cause")).toBe(false);
    }
  });

  it("loads versioned provider YAML and private auth JSON", async () => {
    const directory = await tempDirectory();
    const configFile = path.join(directory, "providers.yaml");
    const authFile = path.join(directory, "auth.json");
    await Bun.write(configFile, JSON.stringify(config));
    await Bun.write(authFile, JSON.stringify(auth));
    await chmod(authFile, 0o600);

    expect(await loadProviderConfig(configFile)).toEqual(config);
    expect(await loadProviderAuth(authFile)).toEqual(auth);
  });

  it("accepts strict per-model catalog overrides", async () => {
    const directory = await tempDirectory();
    const configFile = path.join(directory, "providers.yaml");
    const providerConfig = {
      configVersion: 1,
      providers: {
        local: {
          type: "openai-compatible",
          baseUrl: "http://127.0.0.1:11434/v1",
          catalog: "v1",
          models: {
            "llama/custom": {
              reasoning: true,
              limit: { context: 131_072 },
              modalities: { input: ["text", "image"], output: ["text"] },
            },
          },
        },
      },
    } satisfies ProviderConfig;
    await Bun.write(configFile, JSON.stringify(providerConfig));

    expect(await loadProviderConfig(configFile)).toEqual(providerConfig);
    await Bun.write(
      configFile,
      JSON.stringify({
        ...providerConfig,
        providers: {
          local: { ...providerConfig.providers.local, models: { bad: { unknown: true } } },
        },
      }),
    );
    await expect(loadProviderConfig(configFile)).rejects.toThrow();
  });

  it("allows openaiServerCompaction only for openai model overrides", () => {
    const openaiConfig = {
      configVersion: 1,
      providers: {
        openai: {
          type: "openai",
          catalog: "models-dev",
          models: { "gpt-test": { openaiServerCompaction: true } },
        },
      },
    } satisfies ProviderConfig;
    expect(providerConfigSchema.parse(openaiConfig)).toEqual(openaiConfig);

    expect(
      providerConfigSchema.safeParse({
        ...openaiConfig,
        providers: {
          local: {
            type: "openai-compatible",
            baseUrl: "http://127.0.0.1:11434/v1",
            catalog: "v1",
            models: { "llama/test": { openaiServerCompaction: true } },
          },
        },
      }).success,
    ).toBe(false);

    expect(
      providerConfigSchema.safeParse({
        ...openaiConfig,
        providers: {
          local: {
            type: "openai-compatible",
            baseUrl: "http://127.0.0.1:11434/v1",
            catalog: "v1",
            models: { "llama/test": { openaiServerCompaction: false } },
          },
        },
      }).success,
    ).toBe(true);
  });

  it("rejects group-readable auth files on POSIX", async () => {
    if (process.platform === "win32") return;
    const directory = await tempDirectory();
    const authFile = path.join(directory, "auth.json");
    await Bun.write(authFile, JSON.stringify(auth));
    await chmod(authFile, 0o640);
    await expect(loadProviderAuth(authFile)).rejects.toThrow("mode 0600");
  });

  it("atomically writes private auth JSON and replaces existing content", async () => {
    const directory = await tempDirectory();
    const authFile = path.join(directory, "auth.json");
    await Bun.write(authFile, "old content");
    await chmod(authFile, 0o644);

    await writeProviderAuth(authFile, auth);
    expect(await readFile(authFile, "utf8")).toBe(`${JSON.stringify(auth, null, 2)}\n`);
    if (process.platform !== "win32") {
      expect((await stat(authFile)).mode & 0o777).toBe(0o600);
    }
    expect(await loadProviderAuth(authFile)).toEqual(auth);

    const replacement: ProviderAuth = { local: { type: "api-key", key: "replacement" } };
    await writeProviderAuth(authFile, replacement);
    expect(await loadProviderAuth(authFile)).toEqual(replacement);
  });

  it("rejects legacy fields before creating auth or provider files", async () => {
    const directory = await tempDirectory();
    const authFile = path.join(directory, "auth.json");
    const configFile = path.join(directory, "providers.yaml");

    await expect(
      writeProviderAuth(authFile, { local: { type: "api-key", apiKey: "legacy" } }),
    ).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);

    await Bun.write(
      configFile,
      JSON.stringify({
        configVersion: 1,
        providers: { local: { kind: "openai-compatible", catalog: "v1" } },
      }),
    );
    await expect(loadProviderConfig(configFile)).rejects.toThrow();
  });

  it("cleans up its temporary file when replacement fails", async () => {
    const directory = await tempDirectory();
    const authFile = path.join(directory, "auth.json");
    await mkdir(authFile);

    await expect(writeProviderAuth(authFile, auth)).rejects.toThrow();
    expect((await readdir(directory)).sort()).toEqual(["auth.json"]);
  });

  it("builds a config-injected registry and rejects credential drift", () => {
    const registry = createAiProviderRegistry(config, auth);
    const model = registry.languageModel("local/example-model");
    expect(model.modelId).toBe("example-model");
    expect(() => createAiProviderRegistry(config, {})).toThrow("Missing credentials");
    expect(() =>
      createAiProviderRegistry(config, {
        ...auth,
        extra: { type: "api-key", key: "unused" },
      }),
    ).toThrow("unconfigured provider");
    const missing = createAiProviderRegistryResult(config, {});
    expect(missing.status).toBe("error");
    if (missing.status === "error") expect(missing.error._tag).toBe("ProviderCredentialsInvalid");
  });

  it("supersedes standard OpenAI with Codex OAuth without changing its model namespace", async () => {
    const loaded = await loadTestRegistry(
      {
        configVersion: 1,
        providers: { openai: { type: "openai", catalog: "models-dev" } },
      },
      {},
      oauthTokens,
    );

    expect(loaded.supersededProviderIds).toEqual(["openai"]);
    expect(loaded.registry.languageModel("openai/gpt-5").modelId).toBe("gpt-5");
    const diagnostics = JSON.stringify(loaded);
    expect(diagnostics).not.toContain(oauthTokens.access);
    expect(diagnostics).not.toContain(oauthTokens.refresh);
  });

  it("uses API-key OpenAI when OAuth is absent and lets OAuth win when both exist", async () => {
    const providerConfig: ProviderConfig = {
      configVersion: 1,
      providers: { openai: { type: "openai", catalog: "models-dev" } },
    };
    const providerAuth: ProviderAuth = {
      openai: { type: "api-key", key: "openai-api-key" },
    };

    const fallback = await loadTestRegistry(providerConfig, providerAuth, null);
    expect(fallback.supersededProviderIds).toEqual([]);
    expect(fallback.registry.languageModel("openai/gpt-5").modelId).toBe("gpt-5");
    expect(JSON.stringify(fallback)).not.toContain("openai-api-key");

    const superseded = await loadTestRegistry(providerConfig, providerAuth, oauthTokens);
    expect(superseded.supersededProviderIds).toEqual(["openai"]);
  });

  it("exposes provider registry startup failures as values", async () => {
    const directory = await tempDirectory();
    const result = await loadProviderRegistryResult({
      configVersion: 1,
      configFile: path.join(directory, "config.yaml"),
      providerConfigFile: path.join(directory, "missing-providers.yaml"),
      providerAuthFile: path.join(directory, "missing-auth.json"),
      server: { host: "127.0.0.1", port: 8090 },
      agent: {
        systemPrompt: "test",
        defaultProfile: "coding",
        idleTimeoutMs: 900_000,
        compaction: { model: "inherit", earlyCompactionPoint: 0.8 },
        subagents: { enabled: true, maxDepth: 1 },
        profiles: {
          coding: {
            subagentOnly: false,
            tools: ["*"],
            execution: true,
            workspaceWrites: true,
            delegation: true,
          },
        },
      },
    });
    expect(result.status).toBe("error");
  });

  it("redacts credential-store rejection causes from JSON and log projections", async () => {
    const credentialSecret = "credential-store-token-secret";
    const runtimeConfig = await writeRegistryFixture(config, auth);
    const result = await loadProviderRegistryResult(runtimeConfig, {
      readCodexTokens: async () => {
        throw new Error(`token=${credentialSecret}`);
      },
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error._tag).toBe("ProviderCodexTokensReadFailed");
      expect(JSON.stringify(result.error)).not.toContain(credentialSecret);
      expect(JSON.stringify(formatTaggedErrorForLog(result.error))).not.toContain(credentialSecret);
      expect(Object.hasOwn(result.error, "cause")).toBe(false);
    }
  });

  it("redacts provider-construction rejection causes from JSON and log projections", async () => {
    const providerSecret = "provider-construction-secret";
    const runtimeConfig = await writeRegistryFixture(
      {
        configVersion: 1,
        providers: { openai: { type: "openai", catalog: "models-dev" } },
      },
      {},
    );
    const result = await loadProviderRegistryResult(runtimeConfig, {
      readCodexTokens: async () => oauthTokens,
      createCodexOAuthProvider: () => {
        throw new Error(`authorization=Bearer ${providerSecret}`);
      },
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error._tag).toBe("ProviderRegistryCreationFailed");
      expect(JSON.stringify(result.error)).not.toContain(providerSecret);
      expect(JSON.stringify(formatTaggedErrorForLog(result.error))).not.toContain(providerSecret);
      expect(Object.hasOwn(result.error, "cause")).toBe(false);
    }
  });

  it("never supersedes custom-baseUrl OpenAI and still requires its API key", async () => {
    const customConfig: ProviderConfig = {
      configVersion: 1,
      providers: {
        openai: {
          type: "openai",
          baseUrl: "https://openai-compatible.example/v1",
          catalog: "v1",
        },
      },
    };
    await expect(loadTestRegistry(customConfig, {}, oauthTokens)).rejects.toThrow(
      "Missing credentials",
    );

    const loaded = await loadTestRegistry(
      customConfig,
      { openai: { type: "api-key", key: "custom-key" } },
      oauthTokens,
    );
    expect(loaded.supersededProviderIds).toEqual([]);
  });

  it("rejects missing credentials without OAuth and v1 catalogs with OAuth", async () => {
    const modelsDevConfig: ProviderConfig = {
      configVersion: 1,
      providers: { openai: { type: "openai", catalog: "models-dev" } },
    };
    await expect(loadTestRegistry(modelsDevConfig, {}, null)).rejects.toThrow(
      "Missing credentials",
    );

    const v1Config: ProviderConfig = {
      configVersion: 1,
      providers: { openai: { type: "openai", catalog: "v1" } },
    };
    await expect(loadTestRegistry(v1Config, {}, oauthTokens)).rejects.toThrow(
      "must set catalog: models-dev",
    );
  });
});

describe("credentialless claude-code provider", () => {
  const claudeConfig: ProviderConfig = {
    configVersion: 1,
    providers: { "claude-code": { type: "claude-code", catalog: "models-dev" } },
  };

  it("builds a registry without any stored credential", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = await loadTestRegistry(claudeConfig, {}, null);
      expect(loaded.supersededProviderIds).toEqual([]);
      expect(loaded.registry.languageModel("claude-code/claude-sonnet-4-6")).toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("rejects credentials supplied for a locally authenticated provider", async () => {
    await expect(
      loadTestRegistry(claudeConfig, { "claude-code": { type: "api-key", key: "nope" } }, null),
    ).rejects.toThrow("must not have credentials in the auth file");
  });

  it("rejects a v1 catalog and a custom base URL", () => {
    expect(() =>
      providerConfigSchema.parse({
        configVersion: 1,
        providers: { claude: { type: "claude-code", catalog: "v1" } },
      }),
    ).toThrow("must set catalog: models-dev");

    expect(() =>
      providerConfigSchema.parse({
        configVersion: 1,
        providers: {
          claude: {
            type: "claude-code",
            catalog: "models-dev",
            baseUrl: "https://example.test/v1",
          },
        },
      }),
    ).toThrow("cannot set baseUrl");
  });

  it("keeps requiring credentials for ordinary providers alongside it", async () => {
    const mixed: ProviderConfig = {
      configVersion: 1,
      providers: {
        "claude-code": { type: "claude-code", catalog: "models-dev" },
        anthropic: { type: "anthropic", catalog: "models-dev" },
      },
    };
    await expect(loadTestRegistry(mixed, {}, null)).rejects.toThrow(
      "Missing credentials for configured provider 'anthropic'",
    );
  });
});
