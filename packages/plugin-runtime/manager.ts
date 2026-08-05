import { Result, type Panic, type Result as ResultType } from "better-result";

import {
  decodeDisabledPluginIds,
  decodeLevel1RegistrationKey,
  decodeToolPlugin,
  decodeToolPluginInstance,
  isPluginPanic,
  safePluginExceptionCause,
  type Level1ToolSpecCapabilitySnapshot,
  type ServerToolCapabilitySnapshot,
  type ToolPluginCapabilitySnapshot,
  type ToolPluginInstanceCapabilitySnapshot,
} from "./capabilities";
import { buildExternalToolPluginFreshnessKey, discoverExternalToolPlugins } from "./discovery";
import {
  ToolPluginCapabilityError,
  ToolPluginCleanupError,
  ToolPluginManagerHookError,
  ToolPluginOperationAndCleanupError,
  ToolPluginReloadCommittedCleanupError,
  ToolPluginRegistrationError,
  type ToolPluginCleanupFailure,
  type ToolPluginManagerError,
  type ToolPluginOperationError,
} from "./errors";
import {
  invokeLevel2Destroy,
  invokeLevel2Init,
  invokeLevel2List,
  invokeToolPluginCreate,
  invokeToolPluginInstanceDestroy,
  invokeToolPluginInstanceInit,
} from "./hooks";
import { loadToolPluginModuleCapability } from "./loader";
import type {
  Level1ContributionInfo,
  Level1RegistrationContext,
  Level1ToolSpec,
  Level2ContributionInfo,
  LilacToolPlugin,
  PluginLogger,
  PluginSource,
  ServerTool,
  ToolPluginCreateContext,
  ToolPluginStatus,
} from "./types";

type LoadedPlugin<TRuntimeContext, TLevel1, TLevel2> = {
  readonly pluginId: string;
  readonly instance: ToolPluginInstanceCapabilitySnapshot<TRuntimeContext>;
  readonly meta: { readonly id: string; readonly name?: string; readonly version?: string };
  readonly source: PluginSource;
  readonly pluginDir?: string;
  readonly entrypointPath?: string;
  readonly level1: readonly TLevel1[];
  readonly level1Names: readonly string[];
  readonly level1Capabilities: ReadonlyMap<
    TLevel1,
    Level1ToolSpecCapabilitySnapshot<TRuntimeContext>
  >;
  readonly level2: readonly TLevel2[];
  readonly level2Capabilities: ReadonlyMap<TLevel2, ServerToolCapabilitySnapshot>;
  readonly initializedLevel2: ServerToolCapabilitySnapshot[];
};

type CleanupState = {
  readonly failures: ToolPluginCleanupFailure[];
  panic?: Panic;
};

type LoadedState<TRuntimeContext, TLevel1, TLevel2> = {
  readonly loaded: readonly LoadedPlugin<TRuntimeContext, TLevel1, TLevel2>[];
  readonly level1: readonly TLevel1[];
  readonly level2: readonly TLevel2[];
  readonly statuses: readonly ToolPluginStatus[];
  readonly freshnessKey: string;
};

type LoadedOutcome<TRuntimeContext, TLevel1, TLevel2> =
  | { readonly kind: "loaded"; readonly plugin: LoadedPlugin<TRuntimeContext, TLevel1, TLevel2> }
  | { readonly kind: "disabled"; readonly pluginId: string }
  | { readonly kind: "skipped"; readonly pluginId: string; readonly reason: string };

const level1ContributionSnapshots = new WeakMap<object, Level1ContributionInfo>();

export function getLevel1ContributionSnapshot(
  spec: Level1ToolSpec<unknown>,
): Level1ContributionInfo | undefined {
  return level1ContributionSnapshots.get(spec);
}

export type ToolPluginManagerOptions<
  TRuntimeContext,
  TLevel1 extends Level1ToolSpec<TRuntimeContext>,
  TLevel2 extends ServerTool,
> = {
  runtime: TRuntimeContext;
  dataDir: string;
  configPath?: string;
  logger?: PluginLogger;
  builtinPlugins?: readonly LilacToolPlugin<TRuntimeContext, TLevel1, TLevel2>[];
  getDisabledPluginIds?: () => Promise<readonly string[]> | readonly string[];
  getPluginConfig?: (pluginId: string) => Promise<unknown> | unknown;
  getLevel1RegistrationKey?: (
    spec: TLevel1,
    context: Level1RegistrationContext,
    capturedName: string,
  ) => string;
  adaptLevel1Item: (
    spec: Level1ToolSpec<TRuntimeContext>,
    context: Level1RegistrationContext,
  ) => TLevel1;
  adaptLevel2Item: (tool: ServerTool, context: Level1RegistrationContext) => TLevel2;
};

type PluginManagerHookExceptionParams = {
  hook: ToolPluginManagerHookError["hook"];
  pluginId?: string;
  cause: Error;
};

export function mapPluginManagerHookException(
  params: PluginManagerHookExceptionParams,
): ToolPluginManagerHookError {
  return new ToolPluginManagerHookError({
    hook: params.hook,
    pluginId: params.pluginId,
    cause: params.cause,
    message: `Plugin manager ${params.hook} failed${params.pluginId ? ` for '${params.pluginId}'` : ""}: ${params.cause.message}`,
  });
}

async function captureManagerHook<T>(params: {
  hook: ToolPluginManagerHookError["hook"];
  pluginId?: string;
  run: () => Promise<T> | T;
}): Promise<ResultType<T, ToolPluginManagerHookError>>;
async function captureManagerHook<TInput, TOutput, E>(params: {
  hook: ToolPluginManagerHookError["hook"];
  pluginId?: string;
  run: () => Promise<TInput> | TInput;
  continueWith: (
    value: Awaited<TInput>,
  ) => Promise<ResultType<TOutput, E>> | ResultType<TOutput, E>;
}): Promise<ResultType<TOutput, ToolPluginManagerHookError | E>>;
async function captureManagerHook<TInput, TOutput = TInput, E = never>(params: {
  hook: ToolPluginManagerHookError["hook"];
  pluginId?: string;
  run: () => Promise<TInput> | TInput;
  continueWith?: (
    value: Awaited<TInput>,
  ) => Promise<ResultType<TOutput, E>> | ResultType<TOutput, E>;
}): Promise<ResultType<Awaited<TInput> | TOutput, ToolPluginManagerHookError | E>> {
  try {
    const value = await params.run();
    return params.continueWith ? await params.continueWith(value) : Result.ok(value);
  } catch (cause) {
    if (isPluginPanic(cause)) throw cause;
    return Result.err(
      mapPluginManagerHookException({ ...params, cause: safePluginExceptionCause(cause) }),
    );
  }
}

function cleanupError(failures: readonly ToolPluginCleanupFailure[]): ToolPluginCleanupError {
  return new ToolPluginCleanupError({
    failures,
    message: `Plugin cleanup failed: ${failures.map((failure) => failure.message).join("; ")}`,
  });
}

function combineOperationAndCleanup(
  primary: ToolPluginOperationError,
  cleanup: ResultType<void, ToolPluginCleanupError>,
): ToolPluginManagerError {
  if (cleanup.status === "ok") return primary;
  return new ToolPluginOperationAndCleanupError({
    primary,
    cleanup: cleanup.error,
    message: `${primary.message}; cleanup also failed: ${cleanup.error.message}`,
  });
}

function appendCleanup(
  error: ToolPluginManagerError,
  cleanup: ResultType<void, ToolPluginCleanupError>,
): ToolPluginManagerError {
  if (cleanup.status === "ok") return error;
  if (error._tag === "ToolPluginCleanupError") {
    return cleanupError([...error.failures, ...cleanup.error.failures]);
  }
  if (error._tag === "ToolPluginOperationAndCleanupError") {
    const combinedCleanup = cleanupError([...error.cleanup.failures, ...cleanup.error.failures]);
    return new ToolPluginOperationAndCleanupError({
      primary: error.primary,
      cleanup: combinedCleanup,
      message: `${error.primary.message}; cleanup also failed: ${combinedCleanup.message}`,
    });
  }
  if (error._tag === "ToolPluginReloadCommittedCleanupError") {
    const combinedCleanup = cleanupError([...error.cleanup.failures, ...cleanup.error.failures]);
    return new ToolPluginReloadCommittedCleanupError({
      cleanup: combinedCleanup,
      message: `Plugin reload committed, but cleanup failed: ${combinedCleanup.message}`,
    });
  }
  return combineOperationAndCleanup(error, cleanup);
}

function cleanupRejectionError<TCause>(pluginId: string, cause: TCause): ToolPluginCapabilityError {
  const safeCause = safePluginExceptionCause(cause);
  const message = `Plugin manager adaptLevel2Item failed for '${pluginId}': ${safeCause.message}`;
  return new ToolPluginCapabilityError({
    capability: "hook_result",
    pluginId,
    issues: [message],
    cause: safeCause,
    message,
  });
}

export class ToolPluginManager<
  TRuntimeContext,
  TLevel1 extends Level1ToolSpec<TRuntimeContext>,
  TLevel2 extends ServerTool,
> {
  private state: LoadedState<TRuntimeContext, TLevel1, TLevel2> = {
    loaded: [],
    level1: [],
    level2: [],
    statuses: [],
    freshnessKey: "",
  };
  private initialized = false;

  constructor(
    private readonly options: ToolPluginManagerOptions<TRuntimeContext, TLevel1, TLevel2>,
  ) {}

  getLevel1Items(): readonly TLevel1[] {
    return this.state.level1;
  }

  getLevel1Tools(): readonly TLevel1[] {
    return this.getLevel1Items();
  }

  getLevel2Items(): readonly TLevel2[] {
    return this.state.level2;
  }

  getLevel2Tools(): readonly TLevel2[] {
    return this.getLevel2Items();
  }

  getLevel2ContributionInfo(): ReadonlyMap<TLevel2, Level2ContributionInfo> {
    const result = new Map<TLevel2, Level2ContributionInfo>();
    for (const plugin of this.state.loaded) {
      for (const item of plugin.level2) {
        result.set(item, { pluginId: plugin.pluginId, source: plugin.source });
      }
    }
    return result;
  }

  getLevel2Capabilities(): ReadonlyMap<TLevel2, ServerToolCapabilitySnapshot> {
    const result = new Map<TLevel2, ServerToolCapabilitySnapshot>();
    for (const plugin of this.state.loaded) {
      for (const [item, capability] of plugin.level2Capabilities) result.set(item, capability);
    }
    return result;
  }

  getLevel1ContributionInfo(): ReadonlyMap<TLevel1, Level1ContributionInfo> {
    const result = new Map<TLevel1, Level1ContributionInfo>();
    for (const plugin of this.state.loaded) {
      for (const item of plugin.level1) {
        result.set(item, { pluginId: plugin.pluginId, source: plugin.source });
      }
    }
    return result;
  }

  getLevel1Capabilities(): ReadonlyMap<TLevel1, Level1ToolSpecCapabilitySnapshot<TRuntimeContext>> {
    const result = new Map<TLevel1, Level1ToolSpecCapabilitySnapshot<TRuntimeContext>>();
    for (const plugin of this.state.loaded) {
      for (const [item, capability] of plugin.level1Capabilities) result.set(item, capability);
    }
    return result;
  }

  getStatuses(): readonly ToolPluginStatus[] {
    return this.state.statuses;
  }

  async init(): Promise<ResultType<void, ToolPluginManagerError>> {
    if (this.initialized) return Result.ok();
    const next = await this.loadAll();
    if (next.status === "error") return next;
    this.state = next.value;
    this.initialized = true;
    return Result.ok();
  }

  async destroy(): Promise<ResultType<void, ToolPluginCleanupError>> {
    const previous = this.state;
    this.state = { loaded: [], level1: [], level2: [], statuses: [], freshnessKey: "" };
    this.initialized = false;
    return this.destroyLoaded(previous.loaded);
  }

  async reload(): Promise<ResultType<void, ToolPluginManagerError>> {
    const next = await this.loadAll({
      cacheBustToken: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    });
    if (next.status === "error") return next;

    const previous = this.state;
    this.state = next.value;
    this.initialized = true;
    const cleanup = await this.destroyLoaded(previous.loaded);
    if (cleanup.status === "ok") return Result.ok();
    return Result.err(
      new ToolPluginReloadCommittedCleanupError({
        cleanup: cleanup.error,
        message: `Plugin reload committed, but previous plugin cleanup failed: ${cleanup.error.message}`,
      }),
    );
  }

  async ensureFresh(): Promise<ResultType<void, ToolPluginManagerError>> {
    if (!this.initialized) return this.init();
    const nextKey = await buildExternalToolPluginFreshnessKey({
      dataDir: this.options.dataDir,
      configPath: this.options.configPath,
    });
    if (nextKey.status === "error") return nextKey;
    if (nextKey.value === this.state.freshnessKey) return Result.ok();
    return this.reload();
  }

  private async loadAll(options?: {
    cacheBustToken?: string;
  }): Promise<ResultType<LoadedState<TRuntimeContext, TLevel1, TLevel2>, ToolPluginManagerError>> {
    const disabled = await this.resolveDisabledPluginIds();
    if (disabled.status === "error") return disabled;
    const disabledPluginIds = new Set(disabled.value);

    const freshness = await buildExternalToolPluginFreshnessKey({
      dataDir: this.options.dataDir,
      configPath: this.options.configPath,
    });
    if (freshness.status === "error") return freshness;
    const moduleCacheBustKey = options?.cacheBustToken
      ? `${freshness.value}-${options.cacheBustToken}`
      : freshness.value;

    const statuses: ToolPluginStatus[] = [];
    const loaded: LoadedPlugin<TRuntimeContext, TLevel1, TLevel2>[] = [];
    const level1: TLevel1[] = [];
    const level2: TLevel2[] = [];
    const seenPluginIds = new Set<string>();
    const seenLevel1Names = new Map<string, string>();
    const seenLevel2Ids = new Map<string, string>();

    for (const candidate of this.options.builtinPlugins ?? []) {
      const decoded = decodeToolPlugin<TRuntimeContext>(candidate);
      if (decoded.status === "error") return this.failLoad(decoded.error, loaded);
      const outcome = await this.tryLoadPlugin({
        plugin: decoded.value,
        source: "builtin",
        disabledPluginIds,
      });
      if (outcome.status === "error") return this.failLoad(outcome.error, loaded);
      if (outcome.value.kind !== "loaded") {
        statuses.push(this.outcomeStatus(outcome.value, "builtin"));
        continue;
      }
      const registered = await this.registerPluginPreservingPanic(
        {
          plugin: outcome.value.plugin,
          seenPluginIds,
          seenLevel1Names,
          seenLevel2Ids,
        },
        loaded,
      );
      if (registered.status === "error") {
        const ownCleanup = await this.destroyLoaded([outcome.value.plugin]);
        const primary = appendCleanup(registered.error, ownCleanup);
        return this.failLoad(primary, loaded);
      }
      loaded.push(outcome.value.plugin);
      level1.push(...outcome.value.plugin.level1);
      level2.push(...outcome.value.plugin.level2);
      statuses.push(this.loadedStatus(outcome.value.plugin, registered.value));
    }

    const discovered = await discoverExternalToolPlugins({ dataDir: this.options.dataDir });
    if (discovered.status === "error") return this.failLoad(discovered.error, loaded);
    for (const entry of discovered.value) {
      if (entry.type === "invalid") {
        statuses.push({
          pluginId: entry.pluginId,
          source: "external",
          state: disabledPluginIds.has(entry.pluginId) ? "disabled" : "failed",
          reason: disabledPluginIds.has(entry.pluginId) ? undefined : entry.reason,
          pluginDir: entry.pluginDir,
          level1Names: [],
          level2Ids: [],
        });
        continue;
      }
      if (seenPluginIds.has(entry.pluginId)) {
        statuses.push({
          pluginId: entry.pluginId,
          source: "external",
          state: disabledPluginIds.has(entry.pluginId) ? "disabled" : "failed",
          reason: disabledPluginIds.has(entry.pluginId)
            ? undefined
            : `duplicate plugin id '${entry.pluginId}'`,
          pluginDir: entry.pluginDir,
          entrypointPath: entry.entrypointPath,
          level1Names: [],
          level2Ids: [],
        });
        continue;
      }

      const module = await loadToolPluginModuleCapability<TRuntimeContext>({
        entrypointPath: entry.entrypointPath,
        pluginDir: entry.pluginDir,
        cacheBustKey: moduleCacheBustKey,
      });
      if (module.status === "error") {
        statuses.push(this.failedExternalStatus(entry, module.error.message, disabledPluginIds));
        continue;
      }
      if (module.value.meta.id !== entry.pluginId) {
        statuses.push(
          this.failedExternalStatus(
            entry,
            `plugin meta.id '${module.value.meta.id}' must match directory name '${entry.pluginId}'`,
            disabledPluginIds,
          ),
        );
        continue;
      }

      const outcome = await this.tryLoadPlugin({
        plugin: module.value,
        source: "external",
        disabledPluginIds,
        pluginDir: entry.pluginDir,
        entrypointPath: entry.entrypointPath,
      });
      if (outcome.status === "error") {
        statuses.push(this.failedExternalStatus(entry, outcome.error.message, disabledPluginIds));
        continue;
      }
      if (outcome.value.kind !== "loaded") {
        statuses.push(
          this.outcomeStatus(outcome.value, "external", entry.pluginDir, entry.entrypointPath),
        );
        continue;
      }

      const registered = await this.registerPluginPreservingPanic(
        {
          plugin: outcome.value.plugin,
          seenPluginIds,
          seenLevel1Names,
          seenLevel2Ids,
        },
        loaded,
      );
      if (registered.status === "error") {
        const ownCleanup = await this.destroyLoaded([outcome.value.plugin]);
        const failure = appendCleanup(registered.error, ownCleanup);
        statuses.push(this.failedExternalStatus(entry, failure.message, disabledPluginIds));
        continue;
      }
      loaded.push(outcome.value.plugin);
      level1.push(...outcome.value.plugin.level1);
      level2.push(...outcome.value.plugin.level2);
      statuses.push(this.loadedStatus(outcome.value.plugin, registered.value));
    }

    return Result.ok({
      loaded,
      level1,
      level2,
      statuses,
      freshnessKey: freshness.value,
    });
  }

  private async failLoad(
    error: ToolPluginManagerError,
    loaded: readonly LoadedPlugin<TRuntimeContext, TLevel1, TLevel2>[],
  ): Promise<ResultType<never, ToolPluginManagerError>> {
    const cleanup = await this.destroyLoaded(loaded);
    return Result.err(appendCleanup(error, cleanup));
  }

  private async tryLoadPlugin(params: {
    plugin: ToolPluginCapabilitySnapshot<TRuntimeContext>;
    source: PluginSource;
    disabledPluginIds: ReadonlySet<string>;
    pluginDir?: string;
    entrypointPath?: string;
  }): Promise<
    ResultType<LoadedOutcome<TRuntimeContext, TLevel1, TLevel2>, ToolPluginManagerError>
  > {
    const pluginId = params.plugin.meta.id;
    if (params.disabledPluginIds.has(pluginId)) {
      return Result.ok({ kind: "disabled", pluginId });
    }

    const createWithConfig = <TPluginConfig>(pluginConfig: TPluginConfig) => {
      const createContext: ToolPluginCreateContext<TRuntimeContext> = {
        runtime: this.options.runtime,
        dataDir: this.options.dataDir,
        pluginConfig,
        source: params.source,
        pluginDir: params.pluginDir,
        entrypointPath: params.entrypointPath,
        logger: this.options.logger,
      };
      return invokeToolPluginCreate({
        capability: params.plugin,
        context: createContext,
        source: params.source,
      });
    };
    const created = this.options.getPluginConfig
      ? await captureManagerHook({
          hook: "getPluginConfig",
          pluginId,
          run: () => this.options.getPluginConfig!(pluginId),
          continueWith: createWithConfig,
        })
      : await createWithConfig(undefined);
    if (created.status === "error") {
      if (created.error._tag === "ToolPluginSkipped") {
        return Result.ok({ kind: "skipped", pluginId, reason: created.error.reason });
      }
      return created;
    }
    const instance = decodeToolPluginInstance<TRuntimeContext>(pluginId, created.value);
    if (instance.status === "error") return instance;

    const initialized = await invokeToolPluginInstanceInit({
      pluginId,
      source: params.source,
      capability: instance.value,
    });
    if (initialized.status === "error") {
      if (initialized.error._tag === "ToolPluginSkipped") {
        const cleanup = await this.destroyInstance(pluginId, params.source, instance.value);
        if (cleanup.status === "error") {
          return Result.err(combineOperationAndCleanup(initialized.error, cleanup));
        }
        return Result.ok({ kind: "skipped", pluginId, reason: initialized.error.reason });
      }
      const cleanup = await this.destroyInstance(pluginId, params.source, instance.value);
      return Result.err(combineOperationAndCleanup(initialized.error, cleanup));
    }

    const context = { pluginId, source: params.source } satisfies Level1RegistrationContext;
    const adaptedLevel1: TLevel1[] = [];
    const level1Capabilities = new Map<
      TLevel1,
      Level1ToolSpecCapabilitySnapshot<TRuntimeContext>
    >();
    for (const capability of instance.value.level1) {
      const item = capability.spec;
      const adapted = await captureManagerHook({
        hook: "adaptLevel1Item",
        pluginId,
        run: () => this.options.adaptLevel1Item(item, context),
      });
      if (adapted.status === "error") {
        return this.cleanupFailedInstance(adapted.error, pluginId, params.source, instance.value);
      }
      if (!Object.is(adapted.value, item)) {
        const error = mapPluginManagerHookException({
          hook: "adaptLevel1Item",
          pluginId,
          cause: new Error("adapter must preserve the original object identity"),
        });
        return this.cleanupFailedInstance(error, pluginId, params.source, instance.value);
      }
      adaptedLevel1.push(adapted.value);
      level1Capabilities.set(adapted.value, capability);
      level1ContributionSnapshots.set(adapted.value, context);
    }

    const adaptedLevel2: TLevel2[] = [];
    const level2Capabilities = new Map<TLevel2, ServerToolCapabilitySnapshot>();
    for (const capability of instance.value.level2) {
      const item = capability.tool;
      const adapted = await captureManagerHook({
        hook: "adaptLevel2Item",
        pluginId,
        run: () => this.options.adaptLevel2Item(item, context),
      });
      if (adapted.status === "error") {
        return this.cleanupFailedInstance(adapted.error, pluginId, params.source, instance.value);
      }
      if (!Object.is(adapted.value, item)) {
        const error = mapPluginManagerHookException({
          hook: "adaptLevel2Item",
          pluginId,
          cause: new Error("adapter must preserve the original object identity"),
        });
        return this.cleanupFailedInstance(error, pluginId, params.source, instance.value);
      }
      adaptedLevel2.push(adapted.value);
      level2Capabilities.set(adapted.value, capability);
    }

    return Result.ok({
      kind: "loaded",
      plugin: {
        pluginId,
        instance: instance.value,
        meta: params.plugin.meta,
        source: params.source,
        pluginDir: params.pluginDir,
        entrypointPath: params.entrypointPath,
        level1: adaptedLevel1,
        level1Names: instance.value.level1.map((capability) => capability.name),
        level1Capabilities,
        level2: adaptedLevel2,
        level2Capabilities,
        initializedLevel2: [],
      },
    });
  }

  private async cleanupFailedInstance(
    primary: ToolPluginOperationError,
    pluginId: string,
    source: PluginSource,
    instance: ToolPluginInstanceCapabilitySnapshot<TRuntimeContext>,
  ): Promise<ResultType<never, ToolPluginManagerError>> {
    const cleanup = await this.destroyInstance(pluginId, source, instance);
    return Result.err(combineOperationAndCleanup(primary, cleanup));
  }

  private async registerPlugin(params: {
    plugin: LoadedPlugin<TRuntimeContext, TLevel1, TLevel2>;
    seenPluginIds: Set<string>;
    seenLevel1Names: Map<string, string>;
    seenLevel2Ids: Map<string, string>;
  }): Promise<ResultType<readonly string[], ToolPluginManagerError>> {
    const pluginId = params.plugin.pluginId;
    if (params.seenPluginIds.has(pluginId)) {
      return Result.err(
        new ToolPluginRegistrationError({
          pluginId,
          source: params.plugin.source,
          contribution: "plugin",
          key: pluginId,
          priorPluginId: pluginId,
          message: `duplicate ${params.plugin.source} plugin id '${pluginId}'`,
        }),
      );
    }

    const context = { pluginId, source: params.plugin.source } satisfies Level1RegistrationContext;
    const level1Keys: string[] = [];
    for (const item of params.plugin.level1) {
      const capability = params.plugin.level1Capabilities.get(item);
      if (!capability) {
        return Result.err(
          new ToolPluginCapabilityError({
            capability: "level1",
            pluginId,
            issues: ["captured Level 1 capability was unavailable"],
            message: `Captured Level 1 capability was unavailable for plugin '${pluginId}'`,
          }),
        );
      }
      if (!this.options.getLevel1RegistrationKey) {
        level1Keys.push(capability.name);
        continue;
      }
      const resolved = await captureManagerHook({
        hook: "getLevel1RegistrationKey",
        pluginId,
        run: () => this.options.getLevel1RegistrationKey!(item, context, capability.name),
      });
      if (resolved.status === "error") return resolved;
      const decoded = decodeLevel1RegistrationKey(pluginId, resolved.value);
      if (decoded.status === "error") return decoded;
      level1Keys.push(decoded.value);
    }

    for (const item of params.plugin.level2) {
      const capability = params.plugin.level2Capabilities.get(item);
      if (!capability) {
        return Result.err(
          new ToolPluginCapabilityError({
            capability: "level2",
            pluginId,
            issues: ["captured Level 2 capability was unavailable"],
            message: `Captured Level 2 capability was unavailable for plugin '${pluginId}'`,
          }),
        );
      }
      const result = await invokeLevel2Init({
        pluginId,
        source: params.plugin.source,
        tool: item,
        capability,
      });
      if (result.status === "error") return result;
      params.plugin.initializedLevel2.push(capability);
    }

    const callableIds: string[] = [];
    for (const item of params.plugin.level2) {
      const capability = params.plugin.level2Capabilities.get(item);
      if (!capability) {
        return Result.err(
          new ToolPluginCapabilityError({
            capability: "level2",
            pluginId,
            issues: ["captured Level 2 capability was unavailable"],
            message: `Captured Level 2 capability was unavailable for plugin '${pluginId}'`,
          }),
        );
      }
      const listed = await invokeLevel2List({
        pluginId,
        source: params.plugin.source,
        tool: item,
        capability,
      });
      if (listed.status === "error") return listed;
      callableIds.push(...listed.value.map((entry) => entry.callableId));
    }

    const localLevel1 = new Set<string>();
    for (const key of level1Keys) {
      const prior = params.seenLevel1Names.get(key);
      if (prior || localLevel1.has(key)) {
        return Result.err(
          new ToolPluginRegistrationError({
            pluginId,
            source: params.plugin.source,
            contribution: "level1",
            key,
            priorPluginId: prior ?? pluginId,
            message: `duplicate Level 1 registration key '${key}' (already provided by '${prior ?? pluginId}')`,
          }),
        );
      }
      localLevel1.add(key);
    }
    const localLevel2 = new Set<string>();
    for (const callableId of callableIds) {
      const prior = params.seenLevel2Ids.get(callableId);
      if (prior || localLevel2.has(callableId)) {
        return Result.err(
          new ToolPluginRegistrationError({
            pluginId,
            source: params.plugin.source,
            contribution: "level2",
            key: callableId,
            priorPluginId: prior ?? pluginId,
            message: `duplicate Level 2 callable id '${callableId}' (already provided by '${prior ?? pluginId}')`,
          }),
        );
      }
      localLevel2.add(callableId);
    }

    params.seenPluginIds.add(pluginId);
    for (const key of level1Keys) params.seenLevel1Names.set(key, pluginId);
    for (const callableId of callableIds) params.seenLevel2Ids.set(callableId, pluginId);
    return Result.ok(callableIds);
  }

  private async registerPluginPreservingPanic(
    params: Parameters<ToolPluginManager<TRuntimeContext, TLevel1, TLevel2>["registerPlugin"]>[0],
    loaded: readonly LoadedPlugin<TRuntimeContext, TLevel1, TLevel2>[],
  ): Promise<ResultType<readonly string[], ToolPluginManagerError>> {
    const [registered] = await Promise.allSettled([this.registerPlugin(params)]);
    if (registered.status === "fulfilled") return registered.value;
    if (!isPluginPanic(registered.reason)) {
      return Result.err(
        mapPluginManagerHookException({
          hook: "adaptLevel2Item",
          pluginId: params.plugin.pluginId,
          cause: safePluginExceptionCause(registered.reason),
        }),
      );
    }

    const [cleanup] = await Promise.allSettled([this.destroyLoaded([...loaded, params.plugin])]);
    await this.reportCleanupFailureAfterPanic(params.plugin.pluginId, cleanup);
    throw registered.reason;
  }

  private async reportCleanupFailureAfterPanic(
    pluginId: string,
    cleanup: PromiseSettledResult<ResultType<void, ToolPluginCleanupError>>,
  ): Promise<void> {
    const report = this.options.logger?.error;
    if (!report) return;

    let detail = "cleanup rejected with Panic";
    if (cleanup.status === "fulfilled") {
      if (cleanup.value.status === "ok") return;
      detail = cleanup.value.error.message;
    }
    await Promise.allSettled([
      Promise.resolve().then(() =>
        report.call(this.options.logger, "Plugin cleanup failed after operation Panic", {
          pluginId,
          detail,
        }),
      ),
    ]);
  }

  private async resolveDisabledPluginIds(): Promise<
    ResultType<readonly string[], ToolPluginManagerHookError | ToolPluginCapabilityError>
  > {
    if (!this.options.getDisabledPluginIds) return Result.ok([]);
    const resolved = await captureManagerHook({
      hook: "getDisabledPluginIds",
      run: this.options.getDisabledPluginIds,
    });
    if (resolved.status === "error") return resolved;
    return decodeDisabledPluginIds(resolved.value);
  }

  private async destroyInstance(
    pluginId: string,
    source: PluginSource,
    instance: ToolPluginInstanceCapabilitySnapshot<TRuntimeContext>,
  ): Promise<ResultType<void, ToolPluginCleanupError>> {
    const state: CleanupState = { failures: [] };
    await this.appendInstanceCleanup(state, pluginId, source, instance);
    return this.finishCleanup(state);
  }

  private async appendInstanceCleanup(
    state: CleanupState,
    pluginId: string,
    source: PluginSource,
    instance: ToolPluginInstanceCapabilitySnapshot<TRuntimeContext>,
  ): Promise<void> {
    const [settled] = await Promise.allSettled([
      invokeToolPluginInstanceDestroy({
        pluginId,
        source,
        capability: instance,
      }),
    ]);
    if (settled.status === "rejected") {
      if (!isPluginPanic(settled.reason)) {
        state.failures.push(cleanupRejectionError(pluginId, settled.reason));
        return;
      }
      if (state.panic === undefined) state.panic = settled.reason;
    } else if (settled.value.status === "error") {
      state.failures.push(settled.value.error);
    }
  }

  private async appendLevel2Cleanup(
    state: CleanupState,
    pluginId: string,
    source: PluginSource,
    items: readonly ServerToolCapabilitySnapshot[],
  ): Promise<void> {
    for (const capability of [...items].reverse()) {
      const [settled] = await Promise.allSettled([
        invokeLevel2Destroy({
          pluginId,
          source,
          tool: capability.tool,
          capability,
        }),
      ]);
      if (settled.status === "rejected") {
        if (!isPluginPanic(settled.reason)) {
          state.failures.push(cleanupRejectionError(pluginId, settled.reason));
          continue;
        }
        if (state.panic === undefined) state.panic = settled.reason;
      } else if (settled.value.status === "error") {
        state.failures.push(settled.value.error);
      }
    }
  }

  private finishCleanup(state: CleanupState): ResultType<void, ToolPluginCleanupError> {
    if (state.panic !== undefined) {
      throw state.panic;
    }
    return state.failures.length === 0 ? Result.ok() : Result.err(cleanupError(state.failures));
  }

  private async destroyLoaded(
    loaded: readonly LoadedPlugin<TRuntimeContext, TLevel1, TLevel2>[],
  ): Promise<ResultType<void, ToolPluginCleanupError>> {
    const state: CleanupState = { failures: [] };
    for (const plugin of [...loaded].reverse()) {
      await this.appendLevel2Cleanup(
        state,
        plugin.pluginId,
        plugin.source,
        plugin.initializedLevel2,
      );
      await this.appendInstanceCleanup(state, plugin.pluginId, plugin.source, plugin.instance);
    }
    return this.finishCleanup(state);
  }

  private loadedStatus(
    plugin: LoadedPlugin<TRuntimeContext, TLevel1, TLevel2>,
    callableIds: readonly string[],
  ): ToolPluginStatus {
    return {
      pluginId: plugin.pluginId,
      source: plugin.source,
      state: "loaded",
      pluginDir: plugin.pluginDir,
      entrypointPath: plugin.entrypointPath,
      level1Names: [...plugin.level1Names],
      level2Ids: [...callableIds],
    };
  }

  private outcomeStatus(
    outcome: Exclude<LoadedOutcome<TRuntimeContext, TLevel1, TLevel2>, { kind: "loaded" }>,
    source: PluginSource,
    pluginDir?: string,
    entrypointPath?: string,
  ): ToolPluginStatus {
    return {
      pluginId: outcome.pluginId,
      source,
      state: outcome.kind,
      reason: outcome.kind === "skipped" ? outcome.reason : undefined,
      pluginDir,
      entrypointPath,
      level1Names: [],
      level2Ids: [],
    };
  }

  private failedExternalStatus(
    entry: { pluginId: string; pluginDir: string; entrypointPath: string },
    reason: string,
    disabledPluginIds: ReadonlySet<string>,
  ): ToolPluginStatus {
    const disabled = disabledPluginIds.has(entry.pluginId);
    return {
      pluginId: entry.pluginId,
      source: "external",
      state: disabled ? "disabled" : "failed",
      reason: disabled ? undefined : reason,
      pluginDir: entry.pluginDir,
      entrypointPath: entry.entrypointPath,
      level1Names: [],
      level2Ids: [],
    };
  }
}
