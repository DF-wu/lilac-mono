import path from "node:path";
import fs from "node:fs/promises";

import { Result, TaggedError, type Result as ResultType } from "better-result";

import { env } from "./env";
import {
  capturePromiseResult,
  captureResultOutcome,
  errorMessage,
  isPanic,
  isRecord,
} from "./runtime-utils";
import { findWorkspaceRoot } from "./find-root";
import { createLogger } from "./logging";
import { parseModelSpecifierResult } from "./model-capability";
import {
  formatModelProviderOptionWarning,
  validateConfiguredModelProviderOptions,
} from "./model-provider-option-validation";
import {
  buildAgentSystemPrompt,
  CORE_PROMPT_FILES,
  promptWorkspaceSignature,
} from "./agent-prompts";
import {
  coreConfigInputSchemaV1,
  coreConfigSchema,
  decodeCoreConfigV1,
  decodeCoreConfigV1ToUniversal,
  parseCoreConfigV1,
  parseCoreConfigV1ToUniversal,
  CoreConfigV1Invalid,
} from "./core-config/v1";
import {
  CURRENT_CORE_CONFIG_VERSION,
  DEFAULT_CORE_CONFIG_VERSION,
  SUPPORTED_CORE_CONFIG_VERSIONS,
  coreConfigInputSchemaV2,
  decodeCoreConfigV2,
  decodeCoreConfigV2ToUniversal,
  parseCoreConfigV2,
  parseCoreConfigV2ToUniversal,
  CoreConfigV2Invalid,
} from "./core-config/v2";
import { formatCoreConfigKeyPath } from "./core-config/unknown-keys";
import type {
  CoreConfig,
  CoreConfigModelOptionWarning,
  CoreConfigParseOptions,
  CoreConfigVersion,
  DiscordSessionAliasConfig,
  DiscordUserAliasConfig,
  JSONObject,
} from "./core-config/types";

export {
  coreConfigInputSchemaV1,
  coreConfigSchema,
  coreConfigInputSchemaV2,
  decodeCoreConfigV1,
  decodeCoreConfigV1ToUniversal,
  decodeCoreConfigV2,
  decodeCoreConfigV2ToUniversal,
  parseCoreConfigV1,
  parseCoreConfigV1ToUniversal,
  parseCoreConfigV2,
  parseCoreConfigV2ToUniversal,
};
export { MODEL_REASONING_EFFORTS } from "./core-config/types";
export type {
  BlobStorageConfig,
  ConfiguredModelChainEntry,
  ConfiguredModelRef,
  ConfigParser,
  CoreConfig,
  CoreConfigKeyPath,
  CoreConfigModelOptionWarning,
  CoreConfigParseOptions,
  CoreConfigVersion,
  DiscordSessionAliasConfig,
  DiscordUserAliasConfig,
  JSONValue,
  JSONArray,
  JSONObject,
  ModelReasoningEffort,
  SubagentExecution,
  SubagentProfileConfig,
  UniversalCoreConfig,
} from "./core-config/types";

const logger = createLogger({ module: "core-config" });

export function getDiscordUserAliasValue(alias: DiscordUserAliasConfig | undefined): {
  discordId: string;
  comment?: string;
} | null {
  if (!alias) return null;
  return {
    discordId: alias.discord,
    comment: alias.comment,
  };
}

export function getDiscordSessionAliasValue(alias: DiscordSessionAliasConfig | undefined): {
  discordId: string;
  comment?: string;
} | null {
  if (!alias) return null;
  if (typeof alias === "string") {
    return { discordId: alias };
  }
  return {
    discordId: alias.discord,
    comment: alias.comment,
  };
}
let cached: CoreConfig | null = null;
let cachedMtimeMs: number | null = null;
let cachedPromptMaxMtimeMs: number | null = null;
let warnedPromptNewFilesKey: string | null = null;

export function resolveCoreConfigPath(options?: { dataDir?: string }): string {
  const dataDir = options?.dataDir ?? env.dataDir;
  return path.join(dataDir, "core-config.yaml");
}

async function resolveCoreConfigTemplatePath(): Promise<string> {
  // Prefer an internal template so docker volume mounts can't hide it.
  const internal = path.join(import.meta.dir, "config-templates", "core-config.example.yaml");
  if (await Bun.file(internal).exists()) return internal;

  // Back-compat for older layouts.
  return path.resolve(findWorkspaceRoot(), "data", "core-config.example.yaml");
}

export async function seedCoreConfig(options?: { dataDir?: string; overwrite?: boolean }): Promise<{
  dataDir: string;
  configPath: string;
  created: boolean;
  overwritten: boolean;
}> {
  const dataDir = options?.dataDir ?? env.dataDir;
  const overwrite = options?.overwrite ?? false;

  await fs.mkdir(dataDir, { recursive: true });

  const configPath = resolveCoreConfigPath({ dataDir });
  const existed = await Bun.file(configPath).exists();

  if (!existed || overwrite) {
    const templatePath = await resolveCoreConfigTemplatePath();
    const template = await Bun.file(templatePath).text();
    await Bun.write(configPath, template);
  }

  return {
    dataDir,
    configPath,
    created: !existed,
    overwritten: existed && overwrite,
  };
}

async function ensureDataDirSeeded() {
  await seedCoreConfig({ overwrite: false });
}

export class CoreConfigYamlInvalid extends TaggedError("CoreConfigYamlInvalid")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export function decodeCoreConfigYaml(raw: string): ResultType<unknown, CoreConfigYamlInvalid> {
  const captured = Result.try({
    try: () => Bun.YAML.parse(raw),
    catch: (cause) => ({ cause }),
  });
  const outcome = captured.match<
    | { readonly kind: "result"; readonly result: ResultType<unknown, CoreConfigYamlInvalid> }
    | { readonly kind: "panic"; readonly panic: import("better-result").Panic }
  >({
    ok: (value) => ({ kind: "result", result: Result.ok(value) }),
    err: ({ cause }) =>
      isPanic(cause)
        ? { kind: "panic", panic: cause }
        : {
            kind: "result",
            result: Result.err(
              new CoreConfigYamlInvalid({
                cause,
                message: `Failed to parse core-config.yaml: ${errorMessage(cause)}`,
              }),
            ),
          },
  });
  if (outcome.kind === "panic") throw outcome.panic;
  return outcome.result;
}

export class CoreConfigVersionInvalid extends TaggedError("CoreConfigVersionInvalid")<{
  readonly version: string;
  readonly message: string;
}> {}

export class CoreConfigMustBeObject extends TaggedError("CoreConfigMustBeObject")<{
  readonly message: string;
}> {}

export function readCoreConfigVersionResult(
  raw: unknown,
): ResultType<CoreConfigVersion, CoreConfigVersionInvalid> {
  if (!isRecord(raw)) return Result.ok(DEFAULT_CORE_CONFIG_VERSION);

  const version = raw.configVersion;
  if (version === undefined || version === null) return Result.ok(DEFAULT_CORE_CONFIG_VERSION);
  if (version === 1 || version === CURRENT_CORE_CONFIG_VERSION) return Result.ok(version);
  const versionDescription =
    typeof version === "string" ||
    typeof version === "number" ||
    typeof version === "boolean" ||
    typeof version === "bigint"
      ? String(version)
      : "<non-scalar>";
  return Result.err(
    new CoreConfigVersionInvalid({
      version: versionDescription,
      message: `Unsupported core config version: ${versionDescription} (supported: ${SUPPORTED_CORE_CONFIG_VERSIONS.join(", ")})`,
    }),
  );
}

export function readCoreConfigVersion(raw: unknown): CoreConfigVersion {
  const result = readCoreConfigVersionResult(raw);
  const resolved = result.match<
    { readonly value: CoreConfigVersion } | { readonly error: CoreConfigVersionInvalid }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw new Error(resolved.error.message);
  return resolved.value;
}

function reportConfiguredModelOptionWarnings(
  cfg: CoreConfig,
  report: (warning: CoreConfigModelOptionWarning, source: string) => void,
): void {
  const validate = (model: string, options: JSONObject | undefined, source: string) => {
    if (!options) return;
    const modelSpec = model.includes("/") ? model : cfg.models.def[model]?.model;
    if (!modelSpec?.includes("/")) return;

    const parsedModel = parseModelSpecifierResult(modelSpec);
    const provider = parsedModel.match({
      ok: (value) => value.provider,
      err: () => undefined,
    });
    if (provider === undefined) return;
    for (const warning of validateConfiguredModelProviderOptions(provider, options)) {
      report(warning, source);
    }
  };

  for (const [alias, preset] of Object.entries(cfg.models.def)) {
    validate(preset.model, preset.options, `models.def.${alias}.options`);
    for (const [index, fallback] of (preset.fallback ?? []).entries()) {
      if (typeof fallback !== "string") {
        validate(
          fallback.model,
          fallback.options,
          `models.def.${alias}.fallback[${index}].options`,
        );
      }
    }
  }
  validate(cfg.models.main.model, cfg.models.main.options, "models.main.options");
  validate(cfg.models.fast.model, cfg.models.fast.options, "models.fast.options");
  for (const slot of ["main", "fast"] as const) {
    for (const [index, fallback] of (cfg.models[slot].fallback ?? []).entries()) {
      if (typeof fallback !== "string") {
        validate(fallback.model, fallback.options, `models.${slot}.fallback[${index}].options`);
      }
    }
  }
}

export function parseCoreConfigResult(
  raw: unknown,
  options?: CoreConfigParseOptions,
): ResultType<
  CoreConfig,
  CoreConfigVersionInvalid | CoreConfigMustBeObject | CoreConfigV1Invalid | CoreConfigV2Invalid
> {
  const version = readCoreConfigVersionResult(raw);
  const parsedVersion = version.match<CoreConfigVersion | CoreConfigVersionInvalid>({
    ok: (value) => value,
    err: (error) => error,
  });
  if (CoreConfigVersionInvalid.is(parsedVersion)) return Result.err(parsedVersion);
  if (!isRecord(raw)) {
    return Result.err(new CoreConfigMustBeObject({ message: "Core config must be an object" }));
  }

  const onUnknownKey =
    options?.onUnknownKey ??
    ((path) => {
      logger.warn("unknown core-config key ignored", {
        path: formatCoreConfigKeyPath(path),
        parserVersion: parsedVersion,
      });
    });

  const parsed =
    parsedVersion === 1
      ? decodeCoreConfigV1ToUniversal(raw, { onUnknownKey })
      : decodeCoreConfigV2ToUniversal(raw, { onUnknownKey });
  const cfg = Result.match<
    CoreConfig,
    CoreConfigV1Invalid | CoreConfigV2Invalid,
    CoreConfig | CoreConfigV1Invalid | CoreConfigV2Invalid
  >(parsed, {
    ok: (value) => value,
    err: (error) => error,
  });
  if (CoreConfigV1Invalid.is(cfg) || CoreConfigV2Invalid.is(cfg)) return Result.err(cfg);
  const onUnknownModelOption =
    options?.onUnknownModelOption ??
    ((warning, source) => logger.warn(formatModelProviderOptionWarning(warning, source)));
  reportConfiguredModelOptionWarnings(cfg, onUnknownModelOption);
  return Result.ok(cfg);
}

export async function parseCoreConfig(
  raw: unknown,
  options?: CoreConfigParseOptions,
): Promise<CoreConfig> {
  const result = parseCoreConfigResult(raw, options);
  const resolved = result.match<
    | { readonly value: CoreConfig }
    | {
        readonly error:
          | CoreConfigVersionInvalid
          | CoreConfigMustBeObject
          | CoreConfigV1Invalid
          | CoreConfigV2Invalid;
      }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw projectLegacyCoreConfigFailure(resolved.error);
  return resolved.value;
}

function projectLegacyCoreConfigFailure(
  error:
    | CoreConfigVersionInvalid
    | CoreConfigMustBeObject
    | CoreConfigV1Invalid
    | CoreConfigV2Invalid,
): Error {
  switch (error._tag) {
    case "CoreConfigV1Invalid":
    case "CoreConfigV2Invalid":
      return error.cause;
    case "CoreConfigVersionInvalid":
    case "CoreConfigMustBeObject":
      return new Error(error.message);
  }
}

async function listPromptTemplateNewFiles(promptDir: string): Promise<string[]> {
  const pending: string[] = [];
  for (const name of CORE_PROMPT_FILES) {
    const p = path.join(promptDir, `${name}.new`);
    if (await Bun.file(p).exists()) {
      pending.push(p);
    }
  }
  return pending;
}

function warnPendingPromptTemplateMerges(pending: readonly string[]): void {
  if (pending.length === 0) {
    warnedPromptNewFilesKey = null;
    return;
  }

  const key = pending.join("\n");
  if (warnedPromptNewFilesKey === key) {
    return;
  }
  warnedPromptNewFilesKey = key;

  const names = pending.map((p) => path.basename(p)).join(", ");
  console.warn(
    `[lilac-utils] Prompt template updates are waiting in *.new files (${names}). Merge them into prompts/* and delete the .new files when finished.`,
  );
}

export async function getCoreConfig(options?: {
  /** Bypass cache and re-read from disk. */
  forceReload?: boolean;
}): Promise<CoreConfig> {
  const forceReload = options?.forceReload ?? false;

  await ensureDataDirSeeded();

  const filePath = resolveCoreConfigPath();

  if (!forceReload && cached) {
    const inspected = await capturePromiseResult(async () => ({
      stat: await Bun.file(filePath).stat(),
      promptSig: await promptWorkspaceSignature(),
    }));
    const inspectOutcome = captureResultOutcome(inspected);
    if (!inspectOutcome.ok && isPanic(inspectOutcome.error)) throw inspectOutcome.error;
    const cacheMatches =
      inspectOutcome.ok &&
      cachedMtimeMs !== null &&
      inspectOutcome.value.stat.mtimeMs === cachedMtimeMs &&
      cachedPromptMaxMtimeMs !== null &&
      inspectOutcome.value.promptSig.maxMtimeMs === cachedPromptMaxMtimeMs;
    if (cacheMatches) return cached;
  }

  const raw = await Bun.file(filePath).text();
  const decoded = decodeCoreConfigYaml(raw);
  const decodedValue = decoded.match<unknown | CoreConfigYamlInvalid>({
    ok: (value) => value,
    err: (error) => error,
  });
  if (CoreConfigYamlInvalid.is(decodedValue)) throw new Error(decodedValue.message);
  const parsed = parseCoreConfigResult(decodedValue);
  const cfg = parsed.match<
    | CoreConfig
    | CoreConfigVersionInvalid
    | CoreConfigMustBeObject
    | CoreConfigV1Invalid
    | CoreConfigV2Invalid
  >({
    ok: (value) => value,
    err: (error) => error,
  });
  if (TaggedError.is(cfg)) throw projectLegacyCoreConfigFailure(cfg);

  // Always use file-based system prompt (data/prompts/*).
  // This also ensures missing files are created from templates.
  const built = await buildAgentSystemPrompt({ basePrompt: cfg.basePrompt });
  const pendingPromptNewFiles = await listPromptTemplateNewFiles(built.promptDir);
  warnPendingPromptTemplateMerges(pendingPromptNewFiles);

  const nextCfg: CoreConfig = {
    ...cfg,
    agent: {
      ...cfg.agent,
      systemPrompt: built.systemPrompt,
    },
  };

  cached = nextCfg;
  const stat = await capturePromiseResult(() => Bun.file(filePath).stat());
  const statOutcome = captureResultOutcome(stat);
  if (!statOutcome.ok && isPanic(statOutcome.error)) throw statOutcome.error;
  cachedMtimeMs = statOutcome.ok ? statOutcome.value.mtimeMs : null;

  const signature = await capturePromiseResult(() => promptWorkspaceSignature());
  const signatureOutcome = captureResultOutcome(signature);
  if (!signatureOutcome.ok && isPanic(signatureOutcome.error)) throw signatureOutcome.error;
  cachedPromptMaxMtimeMs = signatureOutcome.ok ? signatureOutcome.value.maxMtimeMs : null;

  return nextCfg;
}

export function resolveDiscordDbPath(cfg: CoreConfig): string {
  return cfg.surface.discord.dbPath ?? path.join(env.dataDir, "discord-surface.db");
}

export function resolveTranscriptDbPath(): string {
  return path.join(env.dataDir, "agent-transcripts.db");
}

export function resolveDiscordSearchDbPath(): string {
  return path.join(env.dataDir, "discord-search.db");
}

export function resolveDiscoveryDbPath(): string {
  return path.join(env.dataDir, "discovery.db");
}

export function resolveDiscordToken(cfg: CoreConfig): string {
  const result = resolveDiscordTokenResult(cfg);
  const resolved = result.match<
    { readonly value: string } | { readonly error: DiscordTokenMissing }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw new Error(resolved.error.message);
  return resolved.value;
}

export class DiscordTokenMissing extends TaggedError("DiscordTokenMissing")<{
  readonly environmentVariable: string;
  readonly message: string;
}> {}

export function resolveDiscordTokenResult(
  cfg: CoreConfig,
): ResultType<string, DiscordTokenMissing> {
  const key = cfg.surface.discord.tokenEnv;
  const value = process.env[key];
  if (!value) {
    return Result.err(
      new DiscordTokenMissing({
        environmentVariable: key,
        message: `Discord token missing: env var ${key} is not set (set it or change surface.discord.tokenEnv in core-config.yaml)`,
      }),
    );
  }
  return Result.ok(value);
}
