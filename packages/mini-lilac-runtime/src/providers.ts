import { createAnthropic } from "@ai-sdk/anthropic";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createGateway, createProviderRegistry, type JSONValue } from "ai";
import { createClaudeCode } from "ai-sdk-provider-claude-code";
import { chmod, open, readFile, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  claudeCodeExecutableSettings,
  createCodexOAuthProvider,
  readCodexTokens,
  withServerCompactionRequestFetch,
  type CodexOAuthTokens,
} from "@stanley2058/lilac-utils";

import { slugSchema, type LoadedRuntimeConfig } from "./config";

export const providerTypeSchema = z.enum([
  "openai",
  "openai-compatible",
  "anthropic",
  "claude-code",
  "xai",
  "openrouter",
  "groq",
  "vercel",
]);

/**
 * Provider types that authenticate through local tooling instead of a Lilac-held
 * key. Lilac never reads, stores, or refreshes their credentials.
 */
const CREDENTIALLESS_PROVIDER_TYPES = new Set<ProviderType>(["claude-code"]);

const modelModalitySchema = z.enum(["text", "image", "audio", "video", "pdf"]);
const providerModelOverrideSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    family: z.string().trim().min(1).optional(),
    attachment: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    toolCall: z.boolean().optional(),
    openaiServerCompaction: z.boolean().optional(),
    modalities: z
      .object({
        input: z.array(modelModalitySchema),
        output: z.array(modelModalitySchema).optional(),
      })
      .strict()
      .optional(),
    limit: z
      .object({
        context: z.number().int().positive().optional(),
        output: z.number().int().nonnegative().optional(),
      })
      .strict()
      .refine((limit) => limit.context !== undefined || limit.output !== undefined, {
        message: "at least one model limit override is required",
      })
      .optional(),
  })
  .strict();

export const providerDefinitionSchema = z
  .object({
    type: providerTypeSchema,
    baseUrl: z.url().optional(),
    catalog: z.enum(["models-dev", "v1"]),
    models: z.record(z.string().trim().min(1), providerModelOverrideSchema).optional(),
  })
  .strict()
  .superRefine((provider, context) => {
    if (provider.type === "openai-compatible" && !provider.baseUrl) {
      context.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "openai-compatible providers require baseUrl",
      });
    }
    if (provider.type === "claude-code") {
      if (provider.baseUrl) {
        context.addIssue({
          code: "custom",
          path: ["baseUrl"],
          message:
            "claude-code providers cannot set baseUrl; the local Claude installation owns the endpoint",
        });
      }
      if (provider.catalog === "v1") {
        context.addIssue({
          code: "custom",
          path: ["catalog"],
          message: "claude-code providers must set catalog: models-dev; there is no /v1/models",
        });
      }
    }
    if (provider.type !== "openai") {
      for (const [modelId, override] of Object.entries(provider.models ?? {})) {
        if (override.openaiServerCompaction !== true) continue;
        context.addIssue({
          code: "custom",
          path: ["models", modelId, "openaiServerCompaction"],
          message: "openaiServerCompaction is supported only by openai providers",
        });
      }
    }
  });

export const providerConfigSchema = z
  .object({
    configVersion: z.literal(1),
    providers: z
      .record(slugSchema, providerDefinitionSchema)
      .refine((providers) => Object.keys(providers).length > 0, {
        message: "at least one provider is required",
      }),
  })
  .strict();

export const apiKeyCredentialSchema = z
  .object({
    type: z.literal("api-key"),
    key: z.string().trim().min(1),
  })
  .strict();

export const providerCredentialSchema = z.discriminatedUnion("type", [apiKeyCredentialSchema]);
export const providerAuthSchema = z.record(slugSchema, providerCredentialSchema);

export type ProviderType = z.infer<typeof providerTypeSchema>;
export type ProviderModelOverride = z.infer<typeof providerModelOverrideSchema>;
export type ProviderDefinition = z.infer<typeof providerDefinitionSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ApiKeyCredential = z.infer<typeof apiKeyCredentialSchema>;
export type ProviderCredential = z.infer<typeof providerCredentialSchema>;
export type ProviderAuth = z.infer<typeof providerAuthSchema>;

function parseYaml(source: string, file: string): unknown {
  try {
    return Bun.YAML.parse(source) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse YAML file '${file}': ${message}`, { cause: error });
  }
}

export async function loadProviderConfig(file: string): Promise<ProviderConfig> {
  const absoluteFile = path.resolve(file);
  return providerConfigSchema.parse(parseYaml(await readFile(absoluteFile, "utf8"), absoluteFile));
}

export async function loadProviderAuth(file: string): Promise<ProviderAuth> {
  const absoluteFile = path.resolve(file);
  const fileStat = await stat(absoluteFile);
  if (!fileStat.isFile()) {
    throw new Error(`Provider auth path '${absoluteFile}' is not a regular file`);
  }
  if (process.platform !== "win32" && (fileStat.mode & 0o077) !== 0) {
    throw new Error(
      `Provider auth file '${absoluteFile}' must not be readable or writable by group or others (use mode 0600)`,
    );
  }

  const source = await readFile(absoluteFile, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse provider auth file '${absoluteFile}': ${message}`, {
      cause: error,
    });
  }
  return providerAuthSchema.parse(parsed);
}

export async function writeProviderAuth(file: string, auth: unknown): Promise<void> {
  const validated = providerAuthSchema.parse(auth);
  const absoluteFile = path.resolve(file);
  const temporaryFile = path.join(
    path.dirname(absoluteFile),
    `.${path.basename(absoluteFile)}.${crypto.randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  let needsCleanup = false;

  try {
    handle = await open(temporaryFile, "wx", 0o600);
    needsCleanup = true;
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryFile, absoluteFile);
    needsCleanup = false;
    await chmod(absoluteFile, 0o600);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
    }
    if (needsCleanup) {
      try {
        await unlink(temporaryFile);
      } catch (unlinkError) {
        cleanupErrors.push(unlinkError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `Failed to write provider auth file '${absoluteFile}' and clean up its temporary file`,
      );
    }
    throw error;
  }
}

function isCredentialless(definition: ProviderDefinition | undefined): boolean {
  return definition !== undefined && CREDENTIALLESS_PROVIDER_TYPES.has(definition.type);
}

function validateProviderAuth(
  config: ProviderConfig,
  auth: ProviderAuth,
  supersededProviderIds: ReadonlySet<string>,
): void {
  for (const [providerId, definition] of Object.entries(config.providers)) {
    if (isCredentialless(definition)) {
      if (auth[providerId]) {
        throw new Error(
          `Provider '${providerId}' uses local ${definition.type} authentication and must not have credentials in the auth file`,
        );
      }
      continue;
    }
    if (!auth[providerId] && !supersededProviderIds.has(providerId)) {
      throw new Error(`Missing credentials for configured provider '${providerId}'`);
    }
  }
  for (const providerId of Object.keys(auth)) {
    if (!config.providers[providerId]) {
      throw new Error(`Credentials supplied for unconfigured provider '${providerId}'`);
    }
  }
}

export type CreateAiProviderRegistryOptions = {
  supersededProviderIds?: ReadonlySet<string>;
  codexOAuthProvider?: ReturnType<typeof createCodexOAuthProvider>;
};

export function createAiProviderRegistry(
  config: ProviderConfig,
  auth: ProviderAuth,
  options: CreateAiProviderRegistryOptions = {},
) {
  const supersededProviderIds = options.supersededProviderIds ?? new Set<string>();
  validateProviderAuth(config, auth, supersededProviderIds);
  const providers = Object.fromEntries(
    Object.entries(config.providers).map(([providerId, definition]) => {
      if (supersededProviderIds.has(providerId)) {
        if (definition.type !== "openai" || definition.baseUrl) {
          throw new Error(`Provider '${providerId}' cannot be superseded by Codex OAuth`);
        }
        return [providerId, options.codexOAuthProvider ?? createCodexOAuthProvider()] as const;
      }
      if (definition.type === "claude-code") {
        // Credentialless: the official Claude tooling resolves its own local
        // authentication. This base instance carries no tools and no MCP
        // server, so it is safe for title generation and other utility calls;
        // per-run agent models are materialized separately.
        return [
          providerId,
          createClaudeCode({
            defaultSettings: {
              ...claudeCodeExecutableSettings(),
              tools: [],
              settingSources: [],
              persistSession: false,
            },
          }),
        ] as const;
      }
      const apiKey = auth[providerId]?.key;
      if (!apiKey) throw new Error(`Missing credentials for configured provider '${providerId}'`);

      switch (definition.type) {
        case "openai":
          return [
            providerId,
            createOpenAI({
              apiKey,
              baseURL: definition.baseUrl,
              fetch: withServerCompactionRequestFetch(globalThis.fetch),
            }),
          ] as const;
        case "openai-compatible":
          return [
            providerId,
            createOpenAICompatible({
              name: providerId,
              apiKey,
              baseURL: definition.baseUrl!,
              includeUsage: true,
            }),
          ] as const;
        case "anthropic":
          return [providerId, createAnthropic({ apiKey, baseURL: definition.baseUrl })] as const;
        case "xai":
          return [providerId, createXai({ apiKey, baseURL: definition.baseUrl })] as const;
        case "openrouter":
          return [providerId, createOpenRouter({ apiKey, baseURL: definition.baseUrl })] as const;
        case "groq":
          return [providerId, createGroq({ apiKey, baseURL: definition.baseUrl })] as const;
        case "vercel":
          return [providerId, createGateway({ apiKey, baseURL: definition.baseUrl })] as const;
      }
    }),
  );

  return createProviderRegistry(providers, { separator: "/" });
}

/**
 * Build the OpenAI `providerOptions` for the selected model turn so reasoning
 * summaries surface in the transcript.
 *
 * Codex OAuth keeps its existing `store: false` / encrypted-content include and
 * additionally requests detailed summaries. Direct provider definitions of type
 * `openai` request detailed summaries as well. All other provider types (and
 * unknown providers) are left untouched.
 */
export function reasoningProviderOptions(params: {
  readonly usesCodexOAuth: boolean;
  readonly providerType: ProviderType | undefined;
  readonly reasoningEnabled: boolean;
  readonly openaiServerCompactionEnabled?: boolean;
}): { readonly openai: Record<string, JSONValue> } | undefined {
  if (params.usesCodexOAuth) {
    return {
      openai: {
        store: false,
        include: ["reasoning.encrypted_content"],
        ...(params.reasoningEnabled ? { reasoningSummary: "detailed" } : {}),
      },
    };
  }
  if (params.providerType === "openai" && params.openaiServerCompactionEnabled) {
    return {
      openai: {
        store: false,
        include: ["reasoning.encrypted_content"],
        ...(params.reasoningEnabled ? { reasoningSummary: "detailed" } : {}),
      },
    };
  }
  if (params.providerType === "openai" && params.reasoningEnabled) {
    return { openai: { reasoningSummary: "detailed" } };
  }
  return undefined;
}

export type LoadedProviderRegistry = {
  config: ProviderConfig;
  auth: ProviderAuth;
  registry: ReturnType<typeof createAiProviderRegistry>;
  supersededProviderIds: readonly string[];
};

export type LoadProviderRegistryOptions = {
  readCodexTokens?: () => Promise<CodexOAuthTokens | null>;
  createCodexOAuthProvider?: typeof createCodexOAuthProvider;
};

export async function loadProviderRegistry(
  runtimeConfig: LoadedRuntimeConfig,
  options: LoadProviderRegistryOptions = {},
): Promise<LoadedProviderRegistry> {
  const [config, auth, codexTokens] = await Promise.all([
    loadProviderConfig(runtimeConfig.providerConfigFile),
    loadProviderAuth(runtimeConfig.providerAuthFile),
    (options.readCodexTokens ?? readCodexTokens)(),
  ]);
  const supersededProviderIds = codexTokens
    ? Object.entries(config.providers)
        .filter(([, definition]) => definition.type === "openai" && !definition.baseUrl)
        .map(([providerId]) => providerId)
    : [];
  for (const providerId of supersededProviderIds) {
    if (config.providers[providerId]?.catalog === "v1") {
      throw new Error(
        `OpenAI provider '${providerId}' uses Codex OAuth and must set catalog: models-dev; /v1/models requires OpenAI API-key authentication`,
      );
    }
  }
  const supersededSet = new Set(supersededProviderIds);
  const registry = createAiProviderRegistry(config, auth, {
    supersededProviderIds: supersededSet,
    codexOAuthProvider:
      supersededProviderIds.length > 0
        ? (options.createCodexOAuthProvider ?? createCodexOAuthProvider)()
        : undefined,
  });
  return { config, auth, registry, supersededProviderIds };
}
