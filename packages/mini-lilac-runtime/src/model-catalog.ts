import { open, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { Result, TaggedError, type Panic, type Result as ResultType } from "better-result";
import { z } from "zod";

import { errorCode, isPanic, type ModelCapabilityOverrides } from "@stanley2058/lilac-utils";

import type {
  LoadedProviderRegistry,
  ProviderAuth,
  ProviderConfig,
  ProviderDefinition,
  ProviderModelOverride,
  ProviderType,
} from "./providers";

type OpaqueModelCatalogValue = {} | null | undefined;

function throwModelCatalogPanic(cause: OpaqueModelCatalogValue): never {
  throw cause;
}

type ModelCatalogCapture<T, E> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "error"; readonly error: E }
  | { readonly status: "panic"; readonly panic: Panic };

type ModelCatalogFailureKind = "missing" | "other";

function captureModelCatalogSync<T, E>(
  operation: () => Awaited<T>,
  mapError: (cause: OpaqueModelCatalogValue) => E,
): ModelCatalogCapture<T, E> {
  const captured = Result.try<T, OpaqueModelCatalogValue>({
    try: operation,
    catch: (cause) => cause,
  });
  const outcome = captured.match<
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: OpaqueModelCatalogValue }
  >({ ok: (value) => ({ ok: true, value }), err: (error) => ({ ok: false, error }) });
  if (outcome.ok) return { status: "ok", value: outcome.value };
  if (isPanic(outcome.error)) return { status: "panic", panic: outcome.error };
  return { status: "error", error: mapError(outcome.error) };
}

async function captureModelCatalogPromise<T, E>(
  operation: () => Promise<T>,
  mapError: (kind: ModelCatalogFailureKind) => E,
): Promise<ModelCatalogCapture<T, E>> {
  const captured = await Result.tryPromise<T, OpaqueModelCatalogValue>({
    try: operation,
    catch: (cause) => cause,
  });
  const outcome = captured.match<
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: OpaqueModelCatalogValue }
  >({ ok: (value) => ({ ok: true, value }), err: (error) => ({ ok: false, error }) });
  if (outcome.ok) return { status: "ok", value: outcome.value };
  if (isPanic(outcome.error)) return { status: "panic", panic: outcome.error };
  const kind = errorCode(outcome.error) === "ENOENT" ? "missing" : "other";
  return { status: "error", error: mapError(kind) };
}

const modalitySchema = z.enum(["text", "image", "audio", "video", "pdf"]);
export const modelSpecifierSchema = z.string().refine((value) => {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return false;
  const providerId = value.slice(0, slash);
  const modelId = value.slice(slash + 1);
  return (
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(providerId) &&
    modelId.trim() === modelId &&
    modelId.length > 0
  );
}, "expected provider/model");

const modelsDevModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    family: z.string().min(1).optional(),
    attachment: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    tool_call: z.boolean().optional(),
    modalities: z
      .object({
        input: z.array(modalitySchema),
        output: z.array(modalitySchema).optional(),
      })
      .optional(),
    limit: z
      .object({
        context: z.number().nonnegative(),
        output: z.number().nonnegative(),
      })
      .optional(),
  })
  .strip();

const modelsDevProviderSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    models: z.record(z.string(), modelsDevModelSchema),
  })
  .strip();

export const modelsDevRegistrySchema = z.record(z.string(), z.unknown());

const modelsDevCacheSchema = z
  .object({
    version: z.literal(1),
    fetchedAt: z.number().int().nonnegative(),
    registry: modelsDevRegistrySchema,
  })
  .strict();

const v1ModelSchema = z
  .object({
    id: z.string().min(1),
    owned_by: z.string().optional(),
  })
  .strip();

export const v1ModelsResponseSchema = z
  .object({
    data: z.array(v1ModelSchema),
  })
  .passthrough();

export type ProviderRef = {
  id: string;
  type: ProviderType;
};

export type ModelRef = {
  providerId: string;
  modelId: string;
  value: `${string}/${string}`;
};

export type CatalogModel = {
  ref: ModelRef;
  provider: ProviderRef;
  source: "models-dev" | "v1";
  name?: string;
  family?: string;
  ownedBy?: string;
  attachment?: boolean;
  reasoning?: boolean;
  toolCall?: boolean;
  openaiServerCompaction?: boolean;
  modalities?: {
    input: z.infer<typeof modalitySchema>[];
    output?: z.infer<typeof modalitySchema>[];
  };
  limits?: {
    context: number;
    output: number;
  };
};

export type ModelCatalogWarning = {
  code:
    | "source-fetch-failed"
    | "source-invalid"
    | "provider-not-found"
    | "stale-cache"
    | "cache-invalid"
    | "cache-read-failed"
    | "cache-write-failed";
  providerId: string;
  message: string;
};

export type ModelCatalogSnapshot = {
  providers: ProviderRef[];
  models: CatalogModel[];
  warnings: ModelCatalogWarning[];
  fetchedAt: Date;
  stale: boolean;
};

export type ModelCatalogOptions = {
  fetch?: CatalogFetch;
  modelsDevUrl?: string;
  cacheTtlMs?: number;
  cacheFilePath?: string;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
  onWarning?: (warning: ModelCatalogWarning) => void;
  codexOAuthProviderIds?: readonly string[];
  openCacheFile?: (cacheFilePath: string) => Promise<FileHandle>;
};

export type CatalogFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ModelReferenceInvalid extends TaggedError("ModelReferenceInvalid")<{
  readonly value: string;
  readonly validationError: z.ZodError;
  readonly message: string;
}> {}

export class ModelProviderNotConfigured extends TaggedError("ModelProviderNotConfigured")<{
  readonly providerId: string;
  readonly message: string;
}> {}

export class LanguageModelResolutionFailed extends TaggedError("LanguageModelResolutionFailed")<{
  readonly modelRef: string;
  readonly message: string;
}> {}

export class ModelCatalogCancelled extends TaggedError("ModelCatalogCancelled")<{
  readonly message: string;
}> {}

export class ModelCatalogOptionsInvalid extends TaggedError("ModelCatalogOptionsInvalid")<{
  readonly option: "requestTimeoutMs" | "maxResponseBytes";
  readonly message: string;
}> {}

export class ModelCatalogRequestFailed extends TaggedError("ModelCatalogRequestFailed")<{
  readonly message: string;
}> {}

export class ModelCatalogResponseCleanupFailed extends TaggedError(
  "ModelCatalogResponseCleanupFailed",
)<{
  readonly operations: readonly (
    | "cancel-response-body"
    | "cancel-response-reader"
    | "release-response-reader"
  )[];
  readonly message: string;
}> {}

export class ModelCatalogRequestAndCleanupFailed extends TaggedError(
  "ModelCatalogRequestAndCleanupFailed",
)<{
  readonly primary: ModelCatalogCancelled | ModelCatalogRequestFailed;
  readonly cleanup: ModelCatalogResponseCleanupFailed;
  readonly message: string;
}> {}

export type ModelCatalogGetError = ModelCatalogCancelled | ModelCatalogRequestAndCleanupFailed;

type ModelCatalogFetchError =
  | ModelCatalogCancelled
  | ModelCatalogRequestFailed
  | ModelCatalogResponseCleanupFailed
  | ModelCatalogRequestAndCleanupFailed;

function combineCatalogRequestAndCleanup(
  primary: ModelCatalogCancelled | ModelCatalogRequestFailed,
  cleanup: ModelCatalogResponseCleanupFailed | undefined,
): ModelCatalogFetchError {
  if (cleanup === undefined) return primary;
  return new ModelCatalogRequestAndCleanupFailed({
    primary,
    cleanup,
    message: primary.message,
  });
}

function isCatalogCancellation(error: ModelCatalogFetchError): error is ModelCatalogGetError {
  if (error._tag === "ModelCatalogCancelled") return true;
  return (
    error._tag === "ModelCatalogRequestAndCleanupFailed" &&
    error.primary._tag === "ModelCatalogCancelled"
  );
}

function catalogCancellationMessage(error: ModelCatalogGetError): string {
  if (error._tag === "ModelCatalogCancelled") return error.message;
  return error.primary.message;
}

class ModelCatalogCacheReadFailed extends TaggedError("ModelCatalogCacheReadFailed")<{
  readonly message: string;
}> {}

class ModelCatalogCacheWriteFailed extends TaggedError("ModelCatalogCacheWriteFailed")<{
  readonly message: string;
}> {}

class ModelCatalogCacheCleanupFailed extends TaggedError("ModelCatalogCacheCleanupFailed")<{
  readonly message: string;
}> {}

class ModelCatalogCacheReadAndCleanupFailed extends TaggedError(
  "ModelCatalogCacheReadAndCleanupFailed",
)<{
  readonly readError: ModelCatalogCacheReadFailed;
  readonly cleanupError: ModelCatalogCacheCleanupFailed;
  readonly message: string;
}> {}

class ModelCatalogCacheWriteAndCleanupFailed extends TaggedError(
  "ModelCatalogCacheWriteAndCleanupFailed",
)<{
  readonly writeError: ModelCatalogCacheWriteFailed;
  readonly cleanupError: ModelCatalogCacheCleanupFailed;
  readonly message: string;
}> {}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  openai: "https://api.openai.com/v1",
  "openai-compatible": "",
  anthropic: "https://api.anthropic.com/v1",
  // The local Claude installation owns the endpoint, and `catalog: v1` is
  // rejected for this type, so no model listing URL is ever built.
  "claude-code": "",
  xai: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  vercel: "https://ai-gateway.vercel.sh/v1",
};

export function parseModelRefResult(value: string): ResultType<ModelRef, ModelReferenceInvalid> {
  const parsed = modelSpecifierSchema.safeParse(value);
  if (!parsed.success) {
    return Result.err(
      new ModelReferenceInvalid({
        value,
        validationError: parsed.error,
        message: `Invalid model reference '${value}'; expected provider/model`,
      }),
    );
  }
  const slash = parsed.data.indexOf("/");
  const providerId = parsed.data.slice(0, slash);
  const modelId = parsed.data.slice(slash + 1);
  return Result.ok({ providerId, modelId, value: `${providerId}/${modelId}` });
}

/** Compatibility adapter for callers that consume model reference failures as exceptions. */
export function parseModelRef(value: string): ModelRef {
  const parsed = parseModelRefResult(value);
  let ref!: ModelRef;
  let failure: ModelReferenceInvalid | undefined;
  parsed.match({
    ok: (value) => void (ref = value),
    err: (error) => void (failure = error),
  });
  if (failure !== undefined) {
    throw new Error(failure.message, {
      cause: failure.validationError,
    });
  }
  return ref;
}

export function resolveLanguageModelResult(
  value: string,
  providers: LoadedProviderRegistry,
): ResultType<
  { ref: ModelRef; model: ReturnType<LoadedProviderRegistry["registry"]["languageModel"]> },
  ModelReferenceInvalid | ModelProviderNotConfigured | LanguageModelResolutionFailed
> {
  const parsed = parseModelRefResult(value);
  let ref!: ModelRef;
  let parseFailure: ModelReferenceInvalid | undefined;
  parsed.match({
    ok: (value) => void (ref = value),
    err: (error) => void (parseFailure = error),
  });
  if (parseFailure !== undefined) return Result.err(parseFailure);
  if (!providers.config.providers[ref.providerId]) {
    return Result.err(
      new ModelProviderNotConfigured({
        providerId: ref.providerId,
        message: `Provider '${ref.providerId}' is not configured`,
      }),
    );
  }
  const resolved = captureModelCatalogSync(
    () => ({
      ref,
      model: providers.registry.languageModel(ref.value),
    }),
    () =>
      new LanguageModelResolutionFailed({
        modelRef: ref.value,
        message: `Failed to resolve configured model '${ref.value}'`,
      }),
  );
  if (resolved.status === "panic") return throwModelCatalogPanic(resolved.panic);
  if (resolved.status === "error") return Result.err(resolved.error);
  return Result.ok(resolved.value);
}

/** Compatibility adapter for callers that consume model resolution failures as exceptions. */
export function resolveLanguageModel(value: string, providers: LoadedProviderRegistry) {
  const ref = parseModelRef(value);
  if (!providers.config.providers[ref.providerId]) {
    throw new Error(`Provider '${ref.providerId}' is not configured`);
  }
  return {
    ref,
    model: providers.registry.languageModel(ref.value),
  };
}

function providerModelsUrl(definition: ProviderDefinition): string {
  const baseUrl = definition.baseUrl ?? DEFAULT_BASE_URLS[definition.type];
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? `${normalized}/models` : `${normalized}/v1/models`;
}

function authHeaders(type: ProviderType, apiKey: string): Headers {
  const headers = new Headers({ accept: "application/json" });
  if (type === "anthropic") {
    headers.set("x-api-key", apiKey);
    headers.set("anthropic-version", "2023-06-01");
  } else {
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

function modelRef(providerId: string, modelId: string): ModelRef {
  return { providerId, modelId, value: `${providerId}/${modelId}` };
}

function applyModelOverride(
  model: CatalogModel,
  override: ProviderModelOverride | undefined,
): CatalogModel {
  if (override === undefined) return model;
  return {
    ...model,
    ...(override.name === undefined ? {} : { name: override.name }),
    ...(override.family === undefined ? {} : { family: override.family }),
    ...(override.attachment === undefined ? {} : { attachment: override.attachment }),
    ...(override.reasoning === undefined ? {} : { reasoning: override.reasoning }),
    ...(override.toolCall === undefined ? {} : { toolCall: override.toolCall }),
    ...(override.openaiServerCompaction === undefined
      ? {}
      : { openaiServerCompaction: override.openaiServerCompaction }),
    ...(override.modalities === undefined ? {} : { modalities: override.modalities }),
    ...(override.limit === undefined
      ? {}
      : {
          limits: {
            context: override.limit.context ?? model.limits?.context ?? 0,
            output: override.limit.output ?? model.limits?.output ?? 0,
          },
        }),
  };
}

export function modelCapabilityOverrides(
  snapshot: Pick<ModelCatalogSnapshot, "models">,
): ModelCapabilityOverrides {
  return Object.fromEntries(
    snapshot.models.flatMap((model) =>
      model.limits === undefined && model.attachment === undefined && model.modalities === undefined
        ? []
        : [
            [
              model.ref.value,
              {
                limit: model.limits ?? { context: 0, output: 0 },
                ...(model.attachment === undefined ? {} : { attachment: model.attachment }),
                ...(model.modalities === undefined ? {} : { modalities: model.modalities }),
              },
            ] as const,
          ],
    ),
  );
}

type ModelsDevModel = z.infer<typeof modelsDevModelSchema>;
type ModelsDevRegistry = z.infer<typeof modelsDevRegistrySchema>;
type ModelsDevCache = z.infer<typeof modelsDevCacheSchema>;
type ModelsDevProvider = z.infer<typeof modelsDevProviderSchema>;

type ModelsDevProviderError = {
  code: "source-invalid" | "provider-not-found";
  providerId: string;
  message: string;
};

type ModelsDevCatalogResult = {
  models: CatalogModel[];
  errors: ModelsDevProviderError[];
};

function decodePositiveInteger(
  value: number,
  option: "requestTimeoutMs" | "maxResponseBytes",
): ResultType<number, ModelCatalogOptionsInvalid> {
  if (Number.isInteger(value) && value > 0) return Result.ok(value);
  return Result.err(
    new ModelCatalogOptionsInvalid({
      option,
      message: `${option} must be a positive integer`,
    }),
  );
}

function decodeModelsDevRegistry(
  source: string,
): ResultType<ModelsDevRegistry, ModelCatalogRequestFailed> {
  const input = captureModelCatalogSync<unknown, ModelCatalogRequestFailed>(
    () => JSON.parse(source),
    () =>
      new ModelCatalogRequestFailed({
        message: "Model catalog response contained malformed JSON",
      }),
  );
  if (input.status === "panic") return throwModelCatalogPanic(input.panic);
  if (input.status === "error") return Result.err(input.error);
  const decoded = modelsDevRegistrySchema.safeParse(input.value);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new ModelCatalogRequestFailed({
      message: "models.dev returned an invalid registry",
    }),
  );
}

function decodeModelsDevCache(
  source: string,
): ResultType<ModelsDevCache, ModelCatalogCacheReadFailed> {
  const input = captureModelCatalogSync<unknown, ModelCatalogCacheReadFailed>(
    () => JSON.parse(source),
    () =>
      new ModelCatalogCacheReadFailed({
        message: "Malformed JSON",
      }),
  );
  if (input.status === "panic") return throwModelCatalogPanic(input.panic);
  if (input.status === "error") return Result.err(input.error);
  const decoded = modelsDevCacheSchema.safeParse(input.value);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new ModelCatalogCacheReadFailed({
      message: z.prettifyError(decoded.error),
    }),
  );
}

function decodeV1ModelsResponse(
  source: string,
): ResultType<z.infer<typeof v1ModelsResponseSchema>, ModelCatalogRequestFailed> {
  const input = captureModelCatalogSync<unknown, ModelCatalogRequestFailed>(
    () => JSON.parse(source),
    () =>
      new ModelCatalogRequestFailed({
        message: "Provider model catalog response contained malformed JSON",
      }),
  );
  if (input.status === "panic") return throwModelCatalogPanic(input.panic);
  if (input.status === "error") return Result.err(input.error);
  const decoded = v1ModelsResponseSchema.safeParse(input.value);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new ModelCatalogRequestFailed({
      message: "Provider returned invalid /v1/models data",
    }),
  );
}

// Codex OAuth exposes only modern conversational coding models, not the full OpenAI API catalog.
function isCodexOAuthModel(model: ModelsDevModel): boolean {
  const match = /^gpt-5\.(\d+)(?:-[a-z0-9][a-z0-9.-]*)?$/.exec(model.id);
  if (!match || Number(match[1]) < 3) return false;
  const input = model.modalities?.input;
  const output = model.modalities?.output;
  return (
    model.tool_call === true &&
    model.reasoning === true &&
    input?.includes("text") === true &&
    output?.includes("text") === true &&
    output.every((modality) => modality === "text")
  );
}

// The Claude CLI runs Claude models only, so the Anthropic catalog is filtered
// to the Claude families it can actually launch. Deliberately permissive:
// `providers.<id>.models` overrides cover anything this misses.
function isClaudeCodeModel(model: ModelsDevModel): boolean {
  return model.id.startsWith("claude-");
}

/**
 * models.dev entry for a configured provider. Ordinary providers may be named
 * after their models.dev id, so that name wins; `claude-code` always reads
 * Anthropic's metadata, because a provider id that happens to collide with an
 * unrelated models.dev key would otherwise yield an empty Claude catalog.
 */
function modelsDevProvider(
  registry: ModelsDevRegistry,
  providerId: string,
  definition: ProviderDefinition,
): ResultType<ModelsDevProvider, ModelsDevProviderError> {
  const sourceProviderValue =
    definition.type === "claude-code"
      ? registry.anthropic
      : (registry[providerId] ?? registry[definition.type]);
  if (!sourceProviderValue) {
    const expected = definition.type === "claude-code" ? "anthropic" : definition.type;
    return Result.err({
      code: "provider-not-found",
      providerId,
      message: `models.dev has no provider matching '${providerId}' or type '${expected}'`,
    });
  }
  const decoded = modelsDevProviderSchema.safeParse(sourceProviderValue);
  if (!decoded.success) {
    return Result.err({
      code: "source-invalid",
      providerId,
      message: `models.dev returned invalid data for provider '${providerId}'`,
    });
  }
  return Result.ok(decoded.data);
}

export class ModelCatalog {
  private readonly fetchFn: CatalogFetch;
  private readonly modelsDevUrl: string;
  private readonly cacheTtlMs: number;
  private readonly cacheFilePath?: string;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly now: () => number;
  private readonly onWarning?: (warning: ModelCatalogWarning) => void;
  private readonly codexOAuthProviderIds: ReadonlySet<string>;
  private readonly openCacheFile: (cacheFilePath: string) => Promise<FileHandle>;
  private cache: ModelCatalogSnapshot | undefined;
  private cacheTime = 0;
  private cacheComplete = false;
  private diskCacheLoaded = false;
  private diskCachePromise: Promise<void> | undefined;
  private pendingWarnings: ModelCatalogWarning[] = [];
  private refreshPromise:
    | Promise<ResultType<ModelCatalogSnapshot, ModelCatalogGetError>>
    | undefined;

  constructor(
    private readonly config: ProviderConfig,
    private readonly auth: ProviderAuth,
    options: ModelCatalogOptions = {},
  ) {
    this.fetchFn = options.fetch ?? fetch;
    this.modelsDevUrl = options.modelsDevUrl ?? "https://models.dev/api.json";
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
    this.cacheFilePath = options.cacheFilePath;
    const requestTimeoutMs = decodePositiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    let invalidOption: ModelCatalogOptionsInvalid | undefined;
    let requestTimeoutValue!: number;
    requestTimeoutMs.match({
      ok: (value) => void (requestTimeoutValue = value),
      err: (error) => void (invalidOption = error),
    });
    if (invalidOption !== undefined) throw invalidOption;
    this.requestTimeoutMs = requestTimeoutValue;
    const maxResponseBytes = decodePositiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    );
    let maxResponseBytesValue!: number;
    maxResponseBytes.match({
      ok: (value) => void (maxResponseBytesValue = value),
      err: (error) => void (invalidOption = error),
    });
    if (invalidOption !== undefined) throw invalidOption;
    this.maxResponseBytes = maxResponseBytesValue;
    this.now = options.now ?? Date.now;
    this.onWarning = options.onWarning;
    this.codexOAuthProviderIds = new Set(options.codexOAuthProviderIds);
    this.openCacheFile = options.openCacheFile ?? ((cacheFilePath) => open(cacheFilePath, "r"));
  }

  async getResult(
    options: { forceRefresh?: boolean; backgroundRefresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<ResultType<ModelCatalogSnapshot, ModelCatalogGetError>> {
    await this.ensureDiskCacheLoaded();
    if (options.backgroundRefresh && !options.signal) {
      const cached = this.cache ?? this.emptySnapshot();
      this.cache ??= cached;
      this.startBackgroundRefresh();
      return Result.ok(cached);
    }
    if (
      !options.forceRefresh &&
      this.cacheComplete &&
      this.cache &&
      this.now() - this.cacheTime < this.cacheTtlMs
    ) {
      return Result.ok(this.cache);
    }
    if (options.signal) {
      return this.refresh(options.signal, true);
    }
    return this.startSharedRefresh();
  }

  /** Compatibility adapter for callers that consume cancellation as an AbortError rejection. */
  async get(
    options: { forceRefresh?: boolean; backgroundRefresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<ModelCatalogSnapshot> {
    const snapshot = await this.getResult(options);
    let value!: ModelCatalogSnapshot;
    let failure: ModelCatalogGetError | undefined;
    snapshot.match({
      ok: (result) => void (value = result),
      err: (error) => void (failure = error),
    });
    if (failure !== undefined) {
      throw new DOMException(catalogCancellationMessage(failure), "AbortError");
    }
    return value;
  }

  clear(): void {
    this.cache = undefined;
    this.cacheTime = 0;
    this.cacheComplete = false;
  }

  private startSharedRefresh(): Promise<ResultType<ModelCatalogSnapshot, ModelCatalogGetError>> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh(undefined, true).finally(() => {
        this.refreshPromise = undefined;
      });
    }
    return this.refreshPromise;
  }

  private startBackgroundRefresh(): void {
    void this.startSharedRefresh();
  }

  private emptySnapshot(): ModelCatalogSnapshot {
    return {
      providers: Object.entries(this.config.providers).map(([id, definition]) => ({
        id,
        type: definition.type,
      })),
      models: [],
      warnings: [...this.pendingWarnings],
      fetchedAt: new Date(this.now()),
      stale: true,
    };
  }

  private modelsDevProviders(): [string, ProviderDefinition][] {
    return Object.entries(this.config.providers).filter(
      (entry): entry is [string, ProviderDefinition] => entry[1].catalog === "models-dev",
    );
  }

  private modelsFromModelsDev(registry: ModelsDevRegistry): ModelsDevCatalogResult {
    const models: CatalogModel[] = [];
    const errors: ModelsDevProviderError[] = [];

    for (const [providerId, definition] of this.modelsDevProviders()) {
      const sourceProvider = modelsDevProvider(registry, providerId, definition);
      let provider!: ModelsDevProvider;
      let providerFailure: ModelsDevProviderError | undefined;
      sourceProvider.match({
        ok: (value) => void (provider = value),
        err: (error) => void (providerFailure = error),
      });
      if (providerFailure !== undefined) {
        errors.push(providerFailure);
        continue;
      }
      const entries = Object.values(provider.models).filter(
        (entry) =>
          (!this.codexOAuthProviderIds.has(providerId) || isCodexOAuthModel(entry)) &&
          (definition.type !== "claude-code" || isClaudeCodeModel(entry)),
      );
      for (const entry of entries) {
        models.push(
          applyModelOverride(
            {
              ref: modelRef(providerId, entry.id),
              provider: { id: providerId, type: definition.type },
              source: "models-dev",
              name: entry.name,
              family: entry.family,
              attachment: entry.attachment,
              reasoning: entry.reasoning,
              toolCall: entry.tool_call,
              modalities: entry.modalities,
              limits: entry.limit,
            },
            definition.models?.[entry.id],
          ),
        );
      }
    }
    return { models, errors };
  }

  private async ensureDiskCacheLoaded(): Promise<void> {
    if (this.diskCacheLoaded || !this.cacheFilePath || this.modelsDevProviders().length === 0) {
      this.diskCacheLoaded = true;
      return;
    }
    if (!this.diskCachePromise) {
      this.diskCachePromise = this.loadDiskCache().finally(() => {
        this.diskCacheLoaded = true;
        this.diskCachePromise = undefined;
      });
    }
    await this.diskCachePromise;
  }

  private cacheWarning(code: ModelCatalogWarning["code"], message: string): void {
    for (const [providerId] of this.modelsDevProviders()) {
      const warning = { code, providerId, message } satisfies ModelCatalogWarning;
      this.pendingWarnings.push(warning);
      this.onWarning?.(warning);
    }
  }

  private async loadDiskCache(): Promise<void> {
    if (!this.cacheFilePath) return;
    const sourceResult = await this.readDiskCacheSource(this.cacheFilePath);
    let source: string | null = null;
    let sourceFailure:
      | ModelCatalogCacheReadFailed
      | ModelCatalogCacheCleanupFailed
      | ModelCatalogCacheReadAndCleanupFailed
      | undefined;
    sourceResult.match({
      ok: (value) => void (source = value),
      err: (error) => void (sourceFailure = error),
    });
    if (sourceFailure !== undefined) {
      this.cacheWarning("cache-read-failed", sourceFailure.message);
      return;
    }
    if (source === null) return;

    const parsed = decodeModelsDevCache(source);
    let cache!: ModelsDevCache;
    let cacheFailure: ModelCatalogCacheReadFailed | undefined;
    parsed.match({
      ok: (value) => void (cache = value),
      err: (error) => void (cacheFailure = error),
    });
    if (cacheFailure !== undefined) {
      this.cacheWarning(
        "cache-invalid",
        `Ignoring invalid models.dev cache '${this.cacheFilePath}': ${cacheFailure.message}`,
      );
      return;
    }
    const catalog = this.modelsFromModelsDev(cache.registry);
    if (catalog.errors.length > 0) {
      this.cacheWarning(
        "cache-invalid",
        `Ignoring models.dev cache '${this.cacheFilePath}': ${catalog.errors.map((error) => error.message).join("; ")}`,
      );
      return;
    }

    const stale = this.now() - cache.fetchedAt >= this.cacheTtlMs;
    const warnings: ModelCatalogWarning[] = [];
    if (stale) {
      for (const [providerId] of this.modelsDevProviders()) {
        this.warn(warnings, {
          code: "stale-cache",
          providerId,
          message: `Using stale on-disk model catalog for provider '${providerId}'`,
        });
      }
    }
    catalog.models.sort((left, right) => left.ref.value.localeCompare(right.ref.value));
    this.cache = {
      providers: Object.entries(this.config.providers).map(([id, definition]) => ({
        id,
        type: definition.type,
      })),
      models: catalog.models,
      warnings,
      fetchedAt: new Date(cache.fetchedAt),
      stale,
    };
    this.cacheTime = cache.fetchedAt;
    this.cacheComplete = Object.values(this.config.providers).every(
      (provider) => provider.catalog === "models-dev",
    );
  }

  private async readDiskCacheSource(
    cacheFilePath: string,
  ): Promise<
    ResultType<
      string | null,
      | ModelCatalogCacheReadFailed
      | ModelCatalogCacheCleanupFailed
      | ModelCatalogCacheReadAndCleanupFailed
    >
  > {
    let handle: FileHandle | undefined;
    const read = await captureModelCatalogPromise(
      async (): Promise<ResultType<string, ModelCatalogCacheReadFailed>> => {
        handle = await this.openCacheFile(cacheFilePath);
        const cacheStat = await handle.stat();
        if (!cacheStat.isFile()) {
          return Result.err(
            new ModelCatalogCacheReadFailed({
              message: `Models.dev cache '${cacheFilePath}' is not a regular file`,
            }),
          );
        }
        if (cacheStat.size > this.maxResponseBytes) {
          return Result.err(
            new ModelCatalogCacheReadFailed({
              message: `Models.dev cache '${cacheFilePath}' exceeded ${this.maxResponseBytes} bytes`,
            }),
          );
        }
        const bytes = new Uint8Array(this.maxResponseBytes + 1);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
          if (result.bytesRead === 0) break;
          offset += result.bytesRead;
        }
        if (offset > this.maxResponseBytes) {
          return Result.err(
            new ModelCatalogCacheReadFailed({
              message: `Models.dev cache '${cacheFilePath}' exceeded ${this.maxResponseBytes} bytes`,
            }),
          );
        }
        return Result.ok(new TextDecoder().decode(bytes.subarray(0, offset)));
      },
      (kind) => {
        if (kind === "missing") return { kind: "missing" } as const;
        return {
          kind: "failed",
          error: new ModelCatalogCacheReadFailed({
            message: `Failed to read models.dev cache '${cacheFilePath}'`,
          }),
        } as const;
      },
    );
    const openedHandle = handle;
    const cleanup = openedHandle
      ? await captureModelCatalogPromise(
          () => openedHandle.close(),
          () =>
            new ModelCatalogCacheCleanupFailed({
              message: `Failed to close models.dev cache '${cacheFilePath}'`,
            }),
        )
      : undefined;

    if (read.status === "panic") return throwModelCatalogPanic(read.panic);
    if (cleanup?.status === "panic") return throwModelCatalogPanic(cleanup.panic);
    if (read.status === "error") {
      if (read.error.kind === "missing") {
        if (cleanup?.status === "error") return Result.err(cleanup.error);
        return Result.ok(null);
      }
      if (cleanup?.status === "error") {
        return Result.err(
          new ModelCatalogCacheReadAndCleanupFailed({
            readError: read.error.error,
            cleanupError: cleanup.error,
            message: `Failed to read and close models.dev cache '${cacheFilePath}'`,
          }),
        );
      }
      return Result.err(read.error.error);
    }
    let source!: string;
    let sourceFailure: ModelCatalogCacheReadFailed | undefined;
    read.value.match({
      ok: (value) => void (source = value),
      err: (error) => void (sourceFailure = error),
    });
    if (sourceFailure !== undefined) {
      if (cleanup?.status === "error") {
        return Result.err(
          new ModelCatalogCacheReadAndCleanupFailed({
            readError: sourceFailure,
            cleanupError: cleanup.error,
            message: `Failed to read and close models.dev cache '${cacheFilePath}'`,
          }),
        );
      }
      return Result.err(sourceFailure);
    }
    if (cleanup?.status === "error") return Result.err(cleanup.error);
    return Result.ok(source);
  }

  private async writeDiskCache(
    cache: ModelsDevCache,
  ): Promise<
    ResultType<
      void,
      | ModelCatalogCacheWriteFailed
      | ModelCatalogCacheCleanupFailed
      | ModelCatalogCacheWriteAndCleanupFailed
    >
  > {
    if (!this.cacheFilePath) return Result.ok(undefined);
    const cacheFilePath = this.cacheFilePath;
    const temporaryFile = path.join(
      path.dirname(cacheFilePath),
      `.${path.basename(cacheFilePath)}.${crypto.randomUUID()}.tmp`,
    );
    let handle: FileHandle | undefined;
    let needsCleanup = false;
    const writeError = new ModelCatalogCacheWriteFailed({
      message: `Failed to write models.dev cache '${cacheFilePath}'`,
    });
    const written = await captureModelCatalogPromise(
      async () => {
        handle = await open(temporaryFile, "wx", 0o600);
        needsCleanup = true;
        await handle.chmod(0o600);
        await handle.writeFile(`${JSON.stringify(cache)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporaryFile, cacheFilePath);
        needsCleanup = false;
      },
      () => writeError,
    );
    const cleanupError = new ModelCatalogCacheCleanupFailed({
      message: `Failed to clean up the temporary models.dev cache for '${cacheFilePath}'`,
    });
    const openedHandle = handle;
    const closed = openedHandle
      ? await captureModelCatalogPromise(
          () => openedHandle.close(),
          () => cleanupError,
        )
      : undefined;
    const unlinked = needsCleanup
      ? await captureModelCatalogPromise(
          () => unlink(temporaryFile),
          () => cleanupError,
        )
      : undefined;

    if (written.status === "panic") return throwModelCatalogPanic(written.panic);
    if (closed?.status === "panic") return throwModelCatalogPanic(closed.panic);
    if (unlinked?.status === "panic") return throwModelCatalogPanic(unlinked.panic);
    const cleanupFailed = closed?.status === "error" || unlinked?.status === "error";
    const writeFailed = written.status === "error";
    if (writeFailed && cleanupFailed) {
      return Result.err(
        new ModelCatalogCacheWriteAndCleanupFailed({
          writeError,
          cleanupError,
          message: `Failed to write models.dev cache '${cacheFilePath}' and clean up its temporary file`,
        }),
      );
    }
    if (writeFailed) return Result.err(writeError);
    if (cleanupFailed) return Result.err(cleanupError);
    return Result.ok(undefined);
  }

  private async fetchText(
    input: string | URL | Request,
    init: RequestInit,
    externalSignal: AbortSignal | undefined,
  ): Promise<ResultType<string, ModelCatalogFetchError>> {
    const controller = new AbortController();
    let resolveInterruption: (
      result: ModelCatalogCapture<never, ModelCatalogCancelled | ModelCatalogRequestFailed>,
    ) => void = () => {};
    const interruption = new Promise<
      ModelCatalogCapture<never, ModelCatalogCancelled | ModelCatalogRequestFailed>
    >((resolve) => {
      resolveInterruption = resolve;
    });
    const cancelForSignal = () => {
      resolveInterruption({
        status: "error",
        error: new ModelCatalogCancelled({ message: "The operation was aborted" }),
      });
      controller.abort();
    };
    if (externalSignal?.aborted) cancelForSignal();
    else externalSignal?.addEventListener("abort", cancelForSignal, { once: true });
    const timer = setTimeout(() => {
      resolveInterruption({
        status: "error",
        error: new ModelCatalogRequestFailed({
          message: `Model catalog request timed out after ${this.requestTimeoutMs}ms`,
        }),
      });
      controller.abort();
    }, this.requestTimeoutMs);

    const attempted = await Result.tryPromise<
      ResultType<string, ModelCatalogFetchError>,
      OpaqueModelCatalogValue
    >({
      try: async () => {
        const responseResult = await Promise.race([
          this.captureFetch(input, { ...init, signal: controller.signal }),
          interruption,
        ]);
        if (responseResult.status === "panic") {
          throwModelCatalogPanic(responseResult.panic);
        }
        if (responseResult.status === "error") return Result.err(responseResult.error);
        const response = responseResult.value;
        if (!response.ok) {
          return this.responseFailureAfterCancel(
            response,
            new ModelCatalogRequestFailed({
              message: `Model catalog request returned HTTP ${response.status}`,
            }),
            "HTTP response rejected",
          );
        }
        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
          controller.abort();
          return this.responseFailureAfterCancel(
            response,
            new ModelCatalogRequestFailed({
              message: `Model catalog response exceeded ${this.maxResponseBytes} bytes`,
            }),
            "response too large",
          );
        }
        if (!response.body) return Result.ok("");

        const responseBody = response.body;
        const acquired = this.acquireResponseReader(responseBody);
        if (acquired.status === "panic") {
          await this.cancelResponseBody(responseBody, "reader acquisition failed");
          throwModelCatalogPanic(acquired.panic);
        }
        if (acquired.status === "error") {
          return this.responseFailureAfterBodyCancel(
            responseBody,
            acquired.error,
            "reader acquisition failed",
          );
        }
        const reader = acquired.value;
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        let primary: ModelCatalogCancelled | ModelCatalogRequestFailed | undefined;
        let primaryPanic: Panic | undefined;
        let shouldCancel = false;

        while (primary === undefined && primaryPanic === undefined) {
          const result = await Promise.race([this.captureReaderRead(reader), interruption]);
          if (result.status === "panic") {
            primaryPanic = result.panic;
            shouldCancel = true;
            break;
          }
          if (result.status === "error") {
            primary = result.error;
            shouldCancel = true;
            break;
          }
          if (result.value.done) break;
          totalBytes += result.value.value.byteLength;
          if (totalBytes > this.maxResponseBytes) {
            controller.abort();
            primary = new ModelCatalogRequestFailed({
              message: `Model catalog response exceeded ${this.maxResponseBytes} bytes`,
            });
            shouldCancel = true;
            break;
          }
          chunks.push(result.value.value);
        }

        const cleanupOperations: ModelCatalogResponseCleanupFailed["operations"][number][] = [];
        let cleanupPanic: Panic | undefined;
        if (shouldCancel) {
          const cancelled = await this.cancelResponseReader(reader);
          if (cancelled.status === "panic") cleanupPanic = cancelled.panic;
          else if (cancelled.status === "error") {
            cleanupOperations.push(...cancelled.error.operations);
          }
        }
        const released = this.releaseReader(reader);
        if (released.status === "panic") cleanupPanic ??= released.panic;
        else if (released.status === "error") cleanupOperations.push(...released.error.operations);

        if (primaryPanic !== undefined) throwModelCatalogPanic(primaryPanic);
        if (cleanupPanic !== undefined) throwModelCatalogPanic(cleanupPanic);
        const cleanup =
          cleanupOperations.length === 0
            ? undefined
            : new ModelCatalogResponseCleanupFailed({
                operations: cleanupOperations,
                message: "Model catalog response cleanup failed",
              });
        if (primary !== undefined) {
          return Result.err(combineCatalogRequestAndCleanup(primary, cleanup));
        }
        if (cleanup !== undefined) return Result.err(cleanup);

        const bytes = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return Result.ok(new TextDecoder().decode(bytes));
      },
      catch: (cause) => cause,
    });
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", cancelForSignal);
    const outcome = attempted.match<
      | { readonly ok: true; readonly value: ResultType<string, ModelCatalogFetchError> }
      | { readonly ok: false; readonly error: OpaqueModelCatalogValue }
    >({ ok: (value) => ({ ok: true, value }), err: (error) => ({ ok: false, error }) });
    if (!outcome.ok) return throwModelCatalogPanic(outcome.error);
    return outcome.value;
  }

  private async captureFetch(
    input: string | URL | Request,
    init: RequestInit,
  ): Promise<ModelCatalogCapture<Response, ModelCatalogRequestFailed>> {
    return captureModelCatalogPromise(
      () => this.fetchFn(input, init),
      () => new ModelCatalogRequestFailed({ message: "Model catalog request failed" }),
    );
  }

  private acquireResponseReader(
    body: ReadableStream<Uint8Array>,
  ): ModelCatalogCapture<ReadableStreamDefaultReader<Uint8Array>, ModelCatalogRequestFailed> {
    return captureModelCatalogSync(
      () => body.getReader(),
      () =>
        new ModelCatalogRequestFailed({
          message: "Model catalog response reader acquisition failed",
        }),
    );
  }

  private async captureReaderRead(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<
    ModelCatalogCapture<
      Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>,
      ModelCatalogRequestFailed
    >
  > {
    return captureModelCatalogPromise(
      () => reader.read(),
      () =>
        new ModelCatalogRequestFailed({
          message: "Model catalog response read failed",
        }),
    );
  }

  private async responseFailureAfterCancel(
    response: Response,
    primary: ModelCatalogCancelled | ModelCatalogRequestFailed,
    reason: string,
  ): Promise<ResultType<never, ModelCatalogFetchError>> {
    if (!response.body) return Result.err(primary);
    return this.responseFailureAfterBodyCancel(response.body, primary, reason);
  }

  private async responseFailureAfterBodyCancel(
    body: ReadableStream<Uint8Array>,
    primary: ModelCatalogCancelled | ModelCatalogRequestFailed,
    reason: string,
  ): Promise<ResultType<never, ModelCatalogFetchError>> {
    const cleanup = await this.cancelResponseBody(body, reason);
    if (cleanup.status === "panic") throwModelCatalogPanic(cleanup.panic);
    if (cleanup.status === "error") {
      return Result.err(combineCatalogRequestAndCleanup(primary, cleanup.error));
    }
    return Result.err(primary);
  }

  private async cancelResponseBody(
    body: ReadableStream<Uint8Array>,
    reason: string,
  ): Promise<ModelCatalogCapture<void, ModelCatalogResponseCleanupFailed>> {
    return captureModelCatalogPromise(
      () => body.cancel(reason),
      () =>
        new ModelCatalogResponseCleanupFailed({
          operations: ["cancel-response-body"],
          message: "Model catalog response cleanup failed",
        }),
    );
  }

  private async cancelResponseReader(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<ModelCatalogCapture<void, ModelCatalogResponseCleanupFailed>> {
    return captureModelCatalogPromise(
      () => reader.cancel("model catalog response interrupted"),
      () =>
        new ModelCatalogResponseCleanupFailed({
          operations: ["cancel-response-reader"],
          message: "Model catalog response cleanup failed",
        }),
    );
  }

  private releaseReader(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): ModelCatalogCapture<void, ModelCatalogResponseCleanupFailed> {
    return captureModelCatalogSync(
      () => reader.releaseLock(),
      () =>
        new ModelCatalogResponseCleanupFailed({
          operations: ["release-response-reader"],
          message: "Model catalog response cleanup failed",
        }),
    );
  }

  private warn(warnings: ModelCatalogWarning[], warning: ModelCatalogWarning): void {
    warnings.push(warning);
    this.onWarning?.(warning);
  }

  private staleModels(providerId: string): CatalogModel[] {
    return this.cache?.models.filter((model) => model.ref.providerId === providerId) ?? [];
  }

  private useStale(
    providerId: string,
    models: CatalogModel[],
    warnings: ModelCatalogWarning[],
  ): boolean {
    const stale = this.staleModels(providerId);
    if (stale.length === 0) return false;
    models.push(...stale);
    this.warn(warnings, {
      code: "stale-cache",
      providerId,
      message: `Using stale in-memory model catalog for provider '${providerId}'`,
    });
    return true;
  }

  private async refresh(
    signal: AbortSignal | undefined,
    updateCache: boolean,
  ): Promise<ResultType<ModelCatalogSnapshot, ModelCatalogGetError>> {
    const warnings: ModelCatalogWarning[] = [...this.pendingWarnings];
    const models: CatalogModel[] = [];
    let stale = false;
    const configured = Object.entries(this.config.providers);
    const modelsDevProviders = this.modelsDevProviders();
    let registryForCache: ModelsDevRegistry | undefined;

    if (modelsDevProviders.length > 0) {
      const fetched = await this.fetchText(this.modelsDevUrl, {}, signal);
      let fetchedText!: string;
      let fetchFailure: ModelCatalogFetchError | undefined;
      fetched.match({
        ok: (value) => void (fetchedText = value),
        err: (error) => void (fetchFailure = error),
      });
      if (fetchFailure !== undefined) {
        if (isCatalogCancellation(fetchFailure)) return Result.err(fetchFailure);
        for (const [providerId] of modelsDevProviders) {
          this.warn(warnings, {
            code: "source-fetch-failed",
            providerId,
            message: `Failed to fetch models.dev catalog for provider '${providerId}': ${fetchFailure.message}`,
          });
          stale = this.useStale(providerId, models, warnings) || stale;
        }
      } else {
        const registry = decodeModelsDevRegistry(fetchedText);
        let decodedRegistry!: ModelsDevRegistry;
        let registryFailure: ModelCatalogRequestFailed | undefined;
        registry.match({
          ok: (value) => void (decodedRegistry = value),
          err: (error) => void (registryFailure = error),
        });
        if (registryFailure !== undefined) {
          for (const [providerId] of modelsDevProviders) {
            this.warn(warnings, {
              code: "source-invalid",
              providerId,
              message: `models.dev returned an invalid registry for provider '${providerId}': ${registryFailure.message}`,
            });
            stale = this.useStale(providerId, models, warnings) || stale;
          }
        } else {
          const catalog = this.modelsFromModelsDev(decodedRegistry);
          models.push(...catalog.models);
          for (const error of catalog.errors) {
            this.warn(warnings, error);
            stale = this.useStale(error.providerId, models, warnings) || stale;
          }
          if (catalog.errors.length === 0) registryForCache = decodedRegistry;
        }
      }
    }

    const v1Results = await Promise.all(
      configured
        .filter(([, provider]) => provider.catalog === "v1")
        .map(async ([providerId, definition]): Promise<ResultType<void, ModelCatalogGetError>> => {
          const apiKey = this.auth[providerId]?.key;
          if (!apiKey) {
            this.warn(warnings, {
              code: "source-fetch-failed",
              providerId,
              message: `Failed to fetch /v1/models for provider '${providerId}': credentials are missing`,
            });
            stale = this.useStale(providerId, models, warnings) || stale;
            return Result.ok(undefined);
          }
          const fetched = await this.fetchText(
            providerModelsUrl(definition),
            { headers: authHeaders(definition.type, apiKey) },
            signal,
          );
          let fetchedText!: string;
          let fetchFailure: ModelCatalogFetchError | undefined;
          fetched.match({
            ok: (value) => void (fetchedText = value),
            err: (error) => void (fetchFailure = error),
          });
          if (fetchFailure !== undefined) {
            if (isCatalogCancellation(fetchFailure)) return Result.err(fetchFailure);
            this.warn(warnings, {
              code: "source-fetch-failed",
              providerId,
              message: `Failed to fetch /v1/models for provider '${providerId}': ${fetchFailure.message}`,
            });
            stale = this.useStale(providerId, models, warnings) || stale;
            return Result.ok(undefined);
          }
          const parsed = decodeV1ModelsResponse(fetchedText);
          let response!: z.infer<typeof v1ModelsResponseSchema>;
          let responseFailure: ModelCatalogRequestFailed | undefined;
          parsed.match({
            ok: (value) => void (response = value),
            err: (error) => void (responseFailure = error),
          });
          if (responseFailure !== undefined) {
            this.warn(warnings, {
              code: "source-invalid",
              providerId,
              message: `Provider '${providerId}' returned invalid /v1/models data: ${responseFailure.message}`,
            });
            stale = this.useStale(providerId, models, warnings) || stale;
            return Result.ok(undefined);
          }
          for (const entry of response.data) {
            models.push(
              applyModelOverride(
                {
                  ref: modelRef(providerId, entry.id),
                  provider: { id: providerId, type: definition.type },
                  source: "v1",
                  ownedBy: entry.owned_by,
                },
                definition.models?.[entry.id],
              ),
            );
          }
          return Result.ok(undefined);
        }),
    );
    const [, cancellations] = Result.partition(v1Results);
    const cancelled = cancellations[0];
    if (cancelled !== undefined) return Result.err(cancelled);

    const fetchedAt = this.now();
    if (registryForCache) {
      const written = await this.writeDiskCache({
        version: 1,
        fetchedAt,
        registry: registryForCache,
      });
      let writeFailure:
        | ModelCatalogCacheWriteFailed
        | ModelCatalogCacheCleanupFailed
        | ModelCatalogCacheWriteAndCleanupFailed
        | undefined;
      written.match({
        ok: () => {},
        err: (error) => void (writeFailure = error),
      });
      if (writeFailure !== undefined) {
        for (const [providerId] of modelsDevProviders) {
          this.warn(warnings, {
            code: "cache-write-failed",
            providerId,
            message: writeFailure.message,
          });
        }
      }
    }
    models.sort((left, right) => left.ref.value.localeCompare(right.ref.value));
    const snapshot: ModelCatalogSnapshot = {
      providers: configured.map(([id, definition]) => ({ id, type: definition.type })),
      models,
      warnings,
      fetchedAt: new Date(fetchedAt),
      stale,
    };
    this.pendingWarnings = [];
    if (updateCache) {
      this.cache = snapshot;
      this.cacheTime = fetchedAt;
      this.cacheComplete = true;
    }
    return Result.ok(snapshot);
  }
}

export function createModelCatalogResult(
  config: ProviderConfig,
  auth: ProviderAuth,
  options: ModelCatalogOptions = {},
): ResultType<ModelCatalog, ModelCatalogOptionsInvalid> {
  const requestTimeoutMs = decodePositiveInteger(
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    "requestTimeoutMs",
  );
  const maxResponseBytes = decodePositiveInteger(
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
  );
  let optionsFailure: ModelCatalogOptionsInvalid | undefined;
  Result.all([requestTimeoutMs, maxResponseBytes]).match({
    ok: () => {},
    err: (error) => void (optionsFailure = error),
  });
  if (optionsFailure !== undefined) return Result.err(optionsFailure);
  return Result.ok(new ModelCatalog(config, auth, options));
}
