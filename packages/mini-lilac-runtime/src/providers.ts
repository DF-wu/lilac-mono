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

import { Result, TaggedError, type Panic, type Result as ResultType } from "better-result";
import { z } from "zod";

import {
  claudeCodeExecutableSettings,
  createCodexOAuthProvider,
  readCodexTokens,
  withServerCompactionRequestFetch,
  type CodexOAuthTokens,
  isPanic,
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

export class ProviderConfigReadFailed extends TaggedError("ProviderConfigReadFailed")<{
  readonly file: string;
  readonly message: string;
}> {}

export class ProviderConfigYamlInvalid extends TaggedError("ProviderConfigYamlInvalid")<{
  readonly file: string;
  readonly message: string;
}> {}

export class ProviderConfigInvalid extends TaggedError("ProviderConfigInvalid")<{
  readonly file: string;
  readonly issues: readonly string[];
  readonly message: string;
}> {}

export class ProviderAuthInspectFailed extends TaggedError("ProviderAuthInspectFailed")<{
  readonly file: string;
  readonly message: string;
}> {}

export class ProviderAuthPathInvalid extends TaggedError("ProviderAuthPathInvalid")<{
  readonly file: string;
  readonly issue: "not-file" | "insecure-permissions";
  readonly message: string;
}> {}

export class ProviderAuthReadFailed extends TaggedError("ProviderAuthReadFailed")<{
  readonly file: string;
  readonly message: string;
}> {}

export class ProviderAuthJsonInvalid extends TaggedError("ProviderAuthJsonInvalid")<{
  readonly file: string;
  readonly message: string;
}> {}

export class ProviderAuthInvalid extends TaggedError("ProviderAuthInvalid")<{
  readonly file: string;
  readonly issues: readonly string[];
  readonly message: string;
}> {}

export class ProviderAuthWriteFailed extends TaggedError("ProviderAuthWriteFailed")<{
  readonly file: string;
  readonly message: string;
}> {}

export class ProviderAuthCleanupFailed extends TaggedError("ProviderAuthCleanupFailed")<{
  readonly file: string;
  readonly operations: readonly ("close-temporary-file" | "remove-temporary-file")[];
  readonly message: string;
}> {}

export class ProviderAuthWriteAndCleanupFailed extends TaggedError(
  "ProviderAuthWriteAndCleanupFailed",
)<{
  readonly file: string;
  readonly writeError: ProviderAuthWriteFailed;
  readonly cleanupError: ProviderAuthCleanupFailed;
  readonly message: string;
}> {}

export type LoadProviderConfigError =
  | ProviderConfigReadFailed
  | ProviderConfigYamlInvalid
  | ProviderConfigInvalid;
export type LoadProviderAuthError =
  | ProviderAuthInspectFailed
  | ProviderAuthPathInvalid
  | ProviderAuthReadFailed
  | ProviderAuthJsonInvalid
  | ProviderAuthInvalid;
export type WriteProviderAuthError =
  | ProviderAuthInvalid
  | ProviderAuthWriteFailed
  | ProviderAuthCleanupFailed
  | ProviderAuthWriteAndCleanupFailed;

type ProviderCapture<T, E> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "error"; readonly error: E }
  | { readonly status: "panic"; readonly panic: Panic };

function throwProviderPanic(panic: Panic): never {
  throw panic;
}

function captureProviderSync<T, E>(operation: () => T, error: E): ProviderCapture<T, E> {
  try {
    return { status: "ok", value: operation() };
  } catch (cause) {
    if (isPanic(cause)) return { status: "panic", panic: cause };
    return { status: "error", error };
  }
}

async function captureProviderPromise<T, E>(
  operation: () => Promise<T>,
  error: E,
): Promise<ProviderCapture<T, E>> {
  try {
    return { status: "ok", value: await operation() };
  } catch (cause) {
    if (isPanic(cause)) return { status: "panic", panic: cause };
    return { status: "error", error };
  }
}

export function decodeProviderConfig(
  input: unknown,
  file: string,
): ResultType<ProviderConfig, ProviderConfigInvalid> {
  const decoded = providerConfigSchema.safeParse(input);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new ProviderConfigInvalid({
      file,
      issues: decoded.error.issues.map((issue) => issue.message),
      message: `Provider config '${file}' is invalid: ${z.prettifyError(decoded.error)}`,
    }),
  );
}

export function decodeProviderAuth(
  input: unknown,
  file: string,
): ResultType<ProviderAuth, ProviderAuthInvalid> {
  const decoded = providerAuthSchema.safeParse(input);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new ProviderAuthInvalid({
      file,
      issues: decoded.error.issues.map((issue) => issue.message),
      message: `Provider auth file '${file}' is invalid`,
    }),
  );
}

export function decodeProviderConfigYaml(
  source: string,
  file: string,
): ResultType<ProviderConfig, ProviderConfigYamlInvalid | ProviderConfigInvalid> {
  const captured = captureProviderSync(
    () => decodeProviderConfig(Bun.YAML.parse(source), file),
    new ProviderConfigYamlInvalid({ file, message: `Failed to parse YAML file '${file}'` }),
  );
  if (captured.status === "panic") return throwProviderPanic(captured.panic);
  if (captured.status === "error") return Result.err(captured.error);
  return captured.value;
}

export async function loadProviderConfigResult(
  file: string,
): Promise<ResultType<ProviderConfig, LoadProviderConfigError>> {
  const absoluteFile = path.resolve(file);
  const source = await captureProviderPromise(
    () => readFile(absoluteFile, "utf8"),
    new ProviderConfigReadFailed({
      file: absoluteFile,
      message: `Failed to read provider config '${absoluteFile}'`,
    }),
  );
  if (source.status === "panic") return throwProviderPanic(source.panic);
  if (source.status === "error") return Result.err(source.error);
  return decodeProviderConfigYaml(source.value, absoluteFile);
}

/** Compatibility adapter for callers that consume provider config failures as rejections. */
export async function loadProviderConfig(file: string): Promise<ProviderConfig> {
  const loaded = await loadProviderConfigResult(file);
  let config!: ProviderConfig;
  let failure: LoadProviderConfigError | undefined;
  loaded.match({
    ok: (value) => void (config = value),
    err: (error) => void (failure = error),
  });
  if (failure !== undefined) throw failure;
  return config;
}

export async function loadProviderAuthResult(
  file: string,
): Promise<ResultType<ProviderAuth, LoadProviderAuthError>> {
  const absoluteFile = path.resolve(file);
  const inspected = await captureProviderPromise(
    () => stat(absoluteFile),
    new ProviderAuthInspectFailed({
      file: absoluteFile,
      message: `Failed to inspect provider auth file '${absoluteFile}'`,
    }),
  );
  if (inspected.status === "panic") return throwProviderPanic(inspected.panic);
  if (inspected.status === "error") return Result.err(inspected.error);
  const fileStat = inspected.value;
  if (!fileStat.isFile()) {
    return Result.err(
      new ProviderAuthPathInvalid({
        file: absoluteFile,
        issue: "not-file",
        message: `Provider auth path '${absoluteFile}' is not a regular file`,
      }),
    );
  }
  if (process.platform !== "win32" && (fileStat.mode & 0o077) !== 0) {
    return Result.err(
      new ProviderAuthPathInvalid({
        file: absoluteFile,
        issue: "insecure-permissions",
        message: `Provider auth file '${absoluteFile}' must not be readable or writable by group or others (use mode 0600)`,
      }),
    );
  }

  const source = await captureProviderPromise(
    () => readFile(absoluteFile, "utf8"),
    new ProviderAuthReadFailed({
      file: absoluteFile,
      message: `Failed to read provider auth file '${absoluteFile}'`,
    }),
  );
  if (source.status === "panic") return throwProviderPanic(source.panic);
  if (source.status === "error") return Result.err(source.error);
  const parsed = captureProviderSync(
    () => JSON.parse(source.value),
    new ProviderAuthJsonInvalid({
      file: absoluteFile,
      message: `Failed to parse provider auth file '${absoluteFile}'`,
    }),
  );
  if (parsed.status === "panic") return throwProviderPanic(parsed.panic);
  if (parsed.status === "error") return Result.err(parsed.error);
  return decodeProviderAuth(parsed.value, absoluteFile);
}

/** Compatibility adapter for callers that consume provider auth failures as rejections. */
export async function loadProviderAuth(file: string): Promise<ProviderAuth> {
  const loaded = await loadProviderAuthResult(file);
  let auth!: ProviderAuth;
  let failure: LoadProviderAuthError | undefined;
  loaded.match({
    ok: (value) => void (auth = value),
    err: (error) => void (failure = error),
  });
  if (failure !== undefined) throw failure;
  return auth;
}

export async function writeProviderAuthResult(
  file: string,
  auth: unknown,
): Promise<ResultType<void, WriteProviderAuthError>> {
  const absoluteFile = path.resolve(file);
  const decoded = decodeProviderAuth(auth, absoluteFile);
  let providerAuth!: ProviderAuth;
  let decodeFailure: ProviderAuthInvalid | undefined;
  decoded.match({
    ok: (value) => void (providerAuth = value),
    err: (error) => void (decodeFailure = error),
  });
  if (decodeFailure !== undefined) return Result.err(decodeFailure);
  const temporaryFile = path.join(
    path.dirname(absoluteFile),
    `.${path.basename(absoluteFile)}.${crypto.randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  let needsCleanup = false;
  const writeError = new ProviderAuthWriteFailed({
    file: absoluteFile,
    message: `Failed to write provider auth file '${absoluteFile}'`,
  });
  const written = await captureProviderPromise(async () => {
    handle = await open(temporaryFile, "wx", 0o600);
    needsCleanup = true;
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(providerAuth, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryFile, absoluteFile);
    needsCleanup = false;
    await chmod(absoluteFile, 0o600);
  }, writeError);

  const cleanupOperations: ("close-temporary-file" | "remove-temporary-file")[] = [];
  let cleanupPanic: Panic | undefined;
  const openHandle = handle;
  if (openHandle) {
    const closed = await captureProviderPromise(
      () => openHandle.close(),
      "close-temporary-file" as const,
    );
    if (closed.status === "panic") cleanupPanic = closed.panic;
    else if (closed.status === "error") {
      cleanupOperations.push("close-temporary-file");
    }
  }
  if (needsCleanup) {
    const removed = await captureProviderPromise(
      () => unlink(temporaryFile),
      "remove-temporary-file" as const,
    );
    if (removed.status === "panic") cleanupPanic ??= removed.panic;
    else if (removed.status === "error") {
      cleanupOperations.push("remove-temporary-file");
    }
  }

  if (written.status === "panic") return throwProviderPanic(written.panic);
  if (cleanupPanic !== undefined) return throwProviderPanic(cleanupPanic);
  const cleanupError =
    cleanupOperations.length > 0
      ? new ProviderAuthCleanupFailed({
          file: absoluteFile,
          operations: cleanupOperations,
          message: `Failed to clean up the temporary provider auth file for '${absoluteFile}'`,
        })
      : undefined;
  if (written.status === "error" && cleanupError) {
    return Result.err(
      new ProviderAuthWriteAndCleanupFailed({
        file: absoluteFile,
        writeError: written.error,
        cleanupError,
        message: `Failed to write provider auth file '${absoluteFile}' and clean up its temporary file`,
      }),
    );
  }
  if (written.status === "error") return Result.err(written.error);
  if (cleanupError) return Result.err(cleanupError);
  return Result.ok(undefined);
}

/** Compatibility adapter for callers that consume provider auth failures as rejections. */
export async function writeProviderAuth(file: string, auth: unknown): Promise<void> {
  let failure: WriteProviderAuthError | undefined;
  (await writeProviderAuthResult(file, auth)).match({
    ok: () => {},
    err: (error) => void (failure = error),
  });
  if (failure !== undefined) throw failure;
}

function isCredentialless(definition: ProviderDefinition | undefined): boolean {
  return definition !== undefined && CREDENTIALLESS_PROVIDER_TYPES.has(definition.type);
}

export class ProviderCredentialsInvalid extends TaggedError("ProviderCredentialsInvalid")<{
  readonly providerId: string;
  readonly issue:
    | "credential-for-local-auth"
    | "missing-credentials"
    | "unconfigured-provider"
    | "invalid-codex-supersession"
    | "codex-v1-catalog";
  readonly message: string;
}> {}

export class ProviderRegistryCreationFailed extends TaggedError("ProviderRegistryCreationFailed")<{
  readonly message: string;
}> {}

export class ProviderCodexTokensReadFailed extends TaggedError("ProviderCodexTokensReadFailed")<{
  readonly message: string;
}> {}

export type CreateAiProviderRegistryError =
  | ProviderCredentialsInvalid
  | ProviderRegistryCreationFailed;

function validateProviderAuth(
  config: ProviderConfig,
  auth: ProviderAuth,
  supersededProviderIds: ReadonlySet<string>,
): ResultType<void, ProviderCredentialsInvalid> {
  for (const [providerId, definition] of Object.entries(config.providers)) {
    if (isCredentialless(definition)) {
      if (auth[providerId]) {
        return Result.err(
          new ProviderCredentialsInvalid({
            providerId,
            issue: "credential-for-local-auth",
            message: `Provider '${providerId}' uses local ${definition.type} authentication and must not have credentials in the auth file`,
          }),
        );
      }
      continue;
    }
    if (!auth[providerId] && !supersededProviderIds.has(providerId)) {
      return Result.err(
        new ProviderCredentialsInvalid({
          providerId,
          issue: "missing-credentials",
          message: `Missing credentials for configured provider '${providerId}'`,
        }),
      );
    }
  }
  for (const providerId of Object.keys(auth)) {
    if (!config.providers[providerId]) {
      return Result.err(
        new ProviderCredentialsInvalid({
          providerId,
          issue: "unconfigured-provider",
          message: `Credentials supplied for unconfigured provider '${providerId}'`,
        }),
      );
    }
  }
  return Result.ok(undefined);
}

export type CreateAiProviderRegistryOptions = {
  supersededProviderIds?: ReadonlySet<string>;
  codexOAuthProvider?: ReturnType<typeof createCodexOAuthProvider>;
};

function createAiProviderRegistryUnchecked(
  config: ProviderConfig,
  auth: ProviderAuth,
  options: CreateAiProviderRegistryOptions,
) {
  const supersededProviderIds = options.supersededProviderIds ?? new Set<string>();
  const providers = Object.fromEntries(
    Object.entries(config.providers).map(([providerId, definition]) => {
      if (supersededProviderIds.has(providerId)) {
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
      const apiKey = auth[providerId]?.key ?? "";

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
              baseURL: definition.baseUrl ?? "",
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

export function createAiProviderRegistryResult(
  config: ProviderConfig,
  auth: ProviderAuth,
  options: CreateAiProviderRegistryOptions = {},
): ResultType<ReturnType<typeof createAiProviderRegistryUnchecked>, CreateAiProviderRegistryError> {
  const supersededProviderIds = options.supersededProviderIds ?? new Set<string>();
  const validated = validateProviderAuth(config, auth, supersededProviderIds);
  let validationFailure: ProviderCredentialsInvalid | undefined;
  validated.match({
    ok: () => {},
    err: (error) => void (validationFailure = error),
  });
  if (validationFailure !== undefined) return Result.err(validationFailure);
  for (const providerId of supersededProviderIds) {
    const definition = config.providers[providerId];
    if (definition?.type !== "openai" || definition.baseUrl) {
      return Result.err(
        new ProviderCredentialsInvalid({
          providerId,
          issue: "invalid-codex-supersession",
          message: `Provider '${providerId}' cannot be superseded by Codex OAuth`,
        }),
      );
    }
  }
  const created = captureProviderSync(
    () => createAiProviderRegistryUnchecked(config, auth, options),
    new ProviderRegistryCreationFailed({ message: "Failed to create the AI provider registry" }),
  );
  if (created.status === "panic") return throwProviderPanic(created.panic);
  if (created.status === "error") return Result.err(created.error);
  return Result.ok(created.value);
}

/** Compatibility adapter for callers that consume registry failures as exceptions. */
export function createAiProviderRegistry(
  config: ProviderConfig,
  auth: ProviderAuth,
  options: CreateAiProviderRegistryOptions = {},
) {
  const created = createAiProviderRegistryResult(config, auth, options);
  let registry!: ReturnType<typeof createAiProviderRegistryUnchecked>;
  let failure: CreateAiProviderRegistryError | undefined;
  created.match({
    ok: (value) => void (registry = value),
    err: (error) => void (failure = error),
  });
  if (failure !== undefined) throw failure;
  return registry;
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

export type LoadProviderRegistryError =
  | LoadProviderConfigError
  | LoadProviderAuthError
  | ProviderCodexTokensReadFailed
  | CreateAiProviderRegistryError;

export async function loadProviderRegistryResult(
  runtimeConfig: LoadedRuntimeConfig,
  options: LoadProviderRegistryOptions = {},
): Promise<ResultType<LoadedProviderRegistry, LoadProviderRegistryError>> {
  const codexTokensPromise = (async (): Promise<
    ResultType<CodexOAuthTokens | null, ProviderCodexTokensReadFailed>
  > => {
    const captured = await captureProviderPromise(
      () => (options.readCodexTokens ?? readCodexTokens)(),
      new ProviderCodexTokensReadFailed({ message: "Failed to read Codex OAuth credentials" }),
    );
    if (captured.status === "panic") return throwProviderPanic(captured.panic);
    if (captured.status === "error") return Result.err(captured.error);
    return Result.ok(captured.value);
  })();
  const [configResult, authResult, codexTokensResult] = await Promise.all([
    loadProviderConfigResult(runtimeConfig.providerConfigFile),
    loadProviderAuthResult(runtimeConfig.providerAuthFile),
    codexTokensPromise,
  ]);
  let providerInputs!: readonly [ProviderConfig, ProviderAuth, CodexOAuthTokens | null];
  let providerInputFailure: LoadProviderRegistryError | undefined;
  Result.all([configResult, authResult, codexTokensResult]).match({
    ok: (value) => void (providerInputs = value),
    err: (error) => void (providerInputFailure = error),
  });
  if (providerInputFailure !== undefined) return Result.err(providerInputFailure);
  const [config, auth, codexTokens] = providerInputs;
  const supersededProviderIds = codexTokens
    ? Object.entries(config.providers)
        .filter(([, definition]) => definition.type === "openai" && !definition.baseUrl)
        .map(([providerId]) => providerId)
    : [];
  for (const providerId of supersededProviderIds) {
    if (config.providers[providerId]?.catalog === "v1") {
      return Result.err(
        new ProviderCredentialsInvalid({
          providerId,
          issue: "codex-v1-catalog",
          message: `OpenAI provider '${providerId}' uses Codex OAuth and must set catalog: models-dev; /v1/models requires OpenAI API-key authentication`,
        }),
      );
    }
  }
  const supersededSet = new Set(supersededProviderIds);
  let codexOAuthProvider: ReturnType<typeof createCodexOAuthProvider> | undefined;
  if (supersededProviderIds.length > 0) {
    const created = captureProviderSync(
      () => (options.createCodexOAuthProvider ?? createCodexOAuthProvider)(),
      new ProviderRegistryCreationFailed({ message: "Failed to create the Codex OAuth provider" }),
    );
    if (created.status === "panic") return throwProviderPanic(created.panic);
    if (created.status === "error") return Result.err(created.error);
    codexOAuthProvider = created.value;
  }
  const registry = createAiProviderRegistryResult(config, auth, {
    supersededProviderIds: supersededSet,
    codexOAuthProvider,
  });
  let createdRegistry!: ReturnType<typeof createAiProviderRegistryUnchecked>;
  let registryFailure: CreateAiProviderRegistryError | undefined;
  registry.match({
    ok: (value) => void (createdRegistry = value),
    err: (error) => void (registryFailure = error),
  });
  if (registryFailure !== undefined) return Result.err(registryFailure);
  const loaded = { config, auth, registry: createdRegistry, supersededProviderIds };
  Object.defineProperty(loaded, "toJSON", {
    enumerable: false,
    value: () => ({ config, supersededProviderIds }),
  });
  return Result.ok(loaded);
}

/** Compatibility adapter for callers that consume startup failures as rejections. */
export async function loadProviderRegistry(
  runtimeConfig: LoadedRuntimeConfig,
  options: LoadProviderRegistryOptions = {},
): Promise<LoadedProviderRegistry> {
  const loaded = await loadProviderRegistryResult(runtimeConfig, options);
  let registry!: LoadedProviderRegistry;
  let failure: LoadProviderRegistryError | undefined;
  loaded.match({
    ok: (value) => void (registry = value),
    err: (error) => void (failure = error),
  });
  if (failure !== undefined) throw failure;
  return registry;
}
