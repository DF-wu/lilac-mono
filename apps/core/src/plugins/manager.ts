import type { ToolSet } from "ai";
import type { ClaudeCodeToolCatalogMetadataMap } from "@stanley2058/lilac-claude-code-bridge";
import {
  ToolPluginManager,
  decodeLevel1ExecutableMetadata,
  invokeLevel1CreateTool,
  invokeLevel1EditTargets,
  invokeLevel1IsEnabled,
  type Level1ContributionInfo,
  type Level1ExecutionRequestContext,
  type Level1RunProfile,
  type Level1ToolSpecCapabilitySnapshot,
  type ServerTool,
} from "@stanley2058/lilac-plugin-runtime";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import {
  createLogger,
  deriveSubagentIdleTimeoutMs,
  formatTaggedErrorForLog,
  getCoreConfig,
  profileIncludes,
  resolveCoreConfigPath,
  resolveNativeSubagentProfile,
  type CoreConfig,
} from "@stanley2058/lilac-utils";

import { createBuiltinCoreToolPlugins } from "./builtin";
import {
  buildUnifiedToolCatalogResult,
  catalogCandidateExecutable,
  createPortableToolSearchResult,
  type PortableToolSearchInvalid,
  type UnifiedToolCatalogInvalid,
  type CatalogToolCandidate,
  type CatalogToolEntry,
} from "../mcp/catalog";
import {
  assignCatalogToolNames,
  baseCatalogToolName,
  catalogToolStableId,
} from "../mcp/catalog-identity";
import {
  hasBoundedBuiltinOutput,
  isAggregateOutputBudgetExempt,
  type CoreLevel1ToolSpec,
  type CoreToolPluginRuntime,
} from "./types";
import type { RegisteredSurfacePlatform } from "../surface/types";

function isStructurallyAllowed(
  specName: string,
  contribution: import("@stanley2058/lilac-plugin-runtime").Level1ContributionInfo | undefined,
  params: Pick<BuildLevel1ToolsetParams, "runProfile">,
  config: CoreConfig,
): boolean {
  if (params.runProfile === "primary") return true;
  if (!contribution) return false;
  const profile = resolveNativeSubagentProfile(config, params.runProfile);
  if (!profileIncludes(profile.level1.plugins, contribution.pluginId)) return false;
  if (!profileIncludes(profile.level1.tools, specName)) return false;
  if (specName === "bash" && profile.execution === false) return false;
  if (["edit", "patch"].includes(specName) && !profile.workspaceWrites) return false;
  if (specName === "subagent_delegate" && !profile.delegation) return false;
  return true;
}

function isMcpStructurallyAllowed(params: {
  serverId: string;
  rawName: string;
  modelName: string;
  runProfile: Level1RunProfile;
  config: CoreConfig;
}): boolean {
  if (params.runProfile === "primary") return true;
  const profile = resolveNativeSubagentProfile(params.config, params.runProfile);
  const serverAllowed =
    profileIncludes(profile.level1.plugins, "mcp") ||
    profileIncludes(profile.level1.plugins, `mcp:${params.serverId}`);
  if (!serverAllowed) return false;
  return (
    profileIncludes(profile.level1.tools, params.modelName) ||
    profileIncludes(profile.level1.tools, params.rawName)
  );
}

export type BuildLevel1ToolsetParams = {
  cwd: string;
  runProfile: Level1RunProfile;
  editingToolMode: "apply_patch" | "edit_file" | "none";
  subagentDepth: number;
  subagentConfig: {
    enabled: boolean;
    idleTimeoutMs?: number;
    maxDepth: number;
  };
  requestContext?: Level1ExecutionRequestContext<RegisteredSurfacePlatform>;
  reportToolStatus?: (update: {
    toolCallId: string;
    status: "start" | "update" | "end";
    display: string;
    ok?: boolean;
    error?: string;
  }) => void | Promise<void>;
};

export type BuiltLevel1Toolset = {
  /** Every executable tool, including deferred plugin and MCP tools. */
  tools: ToolSet;
  specs: ReadonlyMap<string, CoreLevel1ToolSpec>;
  /** Builtins that may be active before any deferred catalog selection. */
  directToolNames: ReadonlySet<string>;
  /** The complete deferred plugin and MCP catalog. */
  catalog: readonly CatalogToolEntry[];
  /** Deferred metadata consumed by the Claude Code MCP bridge. */
  catalogMetadata: ClaudeCodeToolCatalogMetadataMap;
  /** Refresh the run-scoped batch child mapping before freezing step authority. */
  updateActiveBatchTools(activeToolNames: ReadonlySet<string>): void;
  contributionInfo: ReadonlyMap<CoreLevel1ToolSpec, Level1ContributionInfo>;
  genericOutputNormalizerBypassTools: ReadonlySet<string>;
  aggregateOutputBudgetExemptTools: ReadonlySet<string>;
};

export class Level1ToolsetBuildFailed extends TaggedError("Level1ToolsetBuildFailed")<{
  readonly operation: string;
  readonly cause: import("@stanley2058/lilac-plugin-runtime").ToolPluginManagerError;
  readonly message: string;
}> {}

export class Level1ToolsetInvariantViolation extends TaggedError(
  "Level1ToolsetInvariantViolation",
)<{
  readonly message: string;
}> {}

export class Level1ToolsetAssemblyFailed extends TaggedError("Level1ToolsetAssemblyFailed")<{
  readonly cause: UnifiedToolCatalogInvalid | PortableToolSearchInvalid;
  readonly message: string;
}> {}

type CreatedCoreToolPluginManager = ReturnType<typeof createCoreToolPluginManager>;
export type CoreToolPluginManager = Omit<CreatedCoreToolPluginManager, "getLevel2Capabilities"> &
  Partial<Pick<CreatedCoreToolPluginManager, "getLevel2Capabilities">>;

export function resolveOpaquePluginConfig(config: CoreConfig, pluginId: string): unknown {
  return config.plugins?.config?.[pluginId];
}

export function assignOpaqueTool(target: ToolSet, name: string, executable: unknown): void {
  (target as Record<string, unknown>)[name] = executable;
}

export function readOpaqueTool(target: ToolSet, name: string): unknown {
  return (target as Record<string, unknown>)[name];
}

function successfulResultValue<T>(result: { readonly status: "ok"; readonly value: T }): T {
  return result.value;
}

export function createCoreToolPluginManager(params: {
  runtime: CoreToolPluginRuntime;
  dataDir: string;
}) {
  const logger = createLogger({
    module: "tool-plugin-manager",
  });

  const resolveConfig = async () =>
    params.runtime.config ?? params.runtime.getConfig?.() ?? (await getCoreConfig());

  const logPluginOperation = (
    operation: string,
    error: import("@stanley2058/lilac-plugin-runtime").ToolPluginManagerError,
  ): string => {
    const formatted = formatTaggedErrorForLog(error);
    logger.error("tool plugin operation failed", { operation, ...formatted });
    return `Tool plugin ${operation} failed: ${formatted.errorMessage}`;
  };

  const adaptPluginResultToHost = <T>(
    operation: string,
    result: ResultType<T, import("@stanley2058/lilac-plugin-runtime").ToolPluginManagerError>,
  ): T => {
    if (result.status === "ok") return result.value;
    throw new Error(logPluginOperation(operation, result.error));
  };

  const pluginOperationFailure = (
    operation: string,
    error: import("@stanley2058/lilac-plugin-runtime").ToolPluginManagerError,
  ): Level1ToolsetBuildFailed =>
    new Level1ToolsetBuildFailed({
      operation,
      cause: error,
      message: logPluginOperation(operation, error),
    });

  async function buildLevel1ToolsetResult(
    buildParams: BuildLevel1ToolsetParams,
  ): Promise<
    ResultType<
      BuiltLevel1Toolset,
      Level1ToolsetBuildFailed | Level1ToolsetInvariantViolation | Level1ToolsetAssemblyFailed
    >
  > {
    const fresh = await manager.ensureFresh();
    if (fresh.status === "error") {
      if (fresh.error._tag !== "ToolPluginReloadCommittedCleanupError") {
        return Result.err(pluginOperationFailure("ensureFresh", fresh.error));
      }
      logger.error("tool plugin refresh committed with cleanup failure", {
        operation: "ensureFresh",
        ...formatTaggedErrorForLog(fresh.error),
      });
    }
    const resolvedConfig = await resolveConfig();

    const tools: ToolSet = {} as ToolSet;
    const batchTools: ToolSet = {} as ToolSet;
    const specs = new Map<string, CoreLevel1ToolSpec>();
    const directSpecs = new Map<string, CoreLevel1ToolSpec>();
    const contributionInfo = manager.getLevel1ContributionInfo();
    const level1Capabilities = manager.getLevel1Capabilities();
    const level1Specs = manager.getLevel1Items();
    for (const spec of level1Specs) {
      if (!level1Capabilities.has(spec)) {
        return Result.err(
          new Level1ToolsetInvariantViolation({
            message: "Missing captured Level 1 plugin capability",
          }),
        );
      }
      if (!contributionInfo.has(spec)) {
        return Result.err(
          new Level1ToolsetInvariantViolation({
            message: "Missing captured Level 1 contribution identity",
          }),
        );
      }
    }
    const capabilityForSpec = (
      spec: CoreLevel1ToolSpec,
    ): Level1ToolSpecCapabilitySnapshot<CoreToolPluginRuntime> => level1Capabilities.get(spec)!;
    const contributionForSpec = (spec: CoreLevel1ToolSpec): Level1ContributionInfo =>
      contributionInfo.get(spec)!;
    const nameForSpec = (spec: CoreLevel1ToolSpec): string => capabilityForSpec(spec).name;
    const runContext = {
      runtime: {
        ...params.runtime,
        dataDir: params.dataDir,
        config: resolvedConfig,
      },
      cwd: buildParams.cwd,
      runProfile: buildParams.runProfile,
      editingToolMode: buildParams.editingToolMode,
      subagentDepth: buildParams.subagentDepth,
      subagentConfig: {
        ...buildParams.subagentConfig,
        idleTimeoutMs:
          buildParams.subagentConfig.idleTimeoutMs ??
          deriveSubagentIdleTimeoutMs(resolvedConfig.agent.idleTimeoutMs),
      },
      requestContext: buildParams.requestContext,
    };

    const enabledSpecs: CoreLevel1ToolSpec[] = [];
    for (const spec of level1Specs) {
      const contribution = contributionForSpec(spec);
      const specName = nameForSpec(spec);
      const enabled = invokeLevel1IsEnabled({
        pluginId: contribution.pluginId,
        source: contribution.source,
        spec,
        capability: capabilityForSpec(spec),
        context: runContext,
      });
      if (enabled.status === "error") {
        return Result.err(pluginOperationFailure("level1.isEnabled", enabled.error));
      }
      if (
        enabled.value &&
        isStructurallyAllowed(specName, contribution, buildParams, resolvedConfig)
      ) {
        enabledSpecs.push(spec);
      }
    }

    const builtinSpecs = enabledSpecs.filter(
      (spec) => contributionInfo.get(spec)?.source === "builtin",
    );
    const externalSpecs = enabledSpecs.filter(
      (spec) => contributionInfo.get(spec)?.source === "external",
    );
    const allMcpTools = params.runtime.mcpRegistry?.getTools() ?? [];
    const identities = [
      ...externalSpecs.map((spec) => {
        const contribution = contributionForSpec(spec);
        const specName = nameForSpec(spec);
        return {
          source: "plugin",
          sourceId: contribution.pluginId,
          rawToolName: specName,
        } as const;
      }),
      ...allMcpTools.map((entry) => entry.identity),
    ];
    const directToolNames = new Set(builtinSpecs.map(nameForSpec));
    const reservedNames = new Set(
      manager
        .getLevel1Items()
        .filter((spec) => contributionForSpec(spec).source === "builtin")
        .map(nameForSpec),
    );
    reservedNames.add("tool_search");
    const nameAssignment = assignCatalogToolNames(identities, reservedNames);
    if (nameAssignment.collisions.length > 0) {
      return Result.err(
        new Level1ToolsetInvariantViolation({
          message: `Unable to assign unique deferred catalog tool names: ${nameAssignment.collisions
            .map(
              (collision) =>
                `${collision.modelName}: ${collision.identities
                  .map((identity) => catalogToolStableId(identity))
                  .join(", ")}`,
            )
            .join("; ")}`,
        }),
      );
    }
    const mcpTools: Array<(typeof allMcpTools)[number]> = [];
    for (const entry of allMcpTools) {
      const modelName = nameAssignment.byStableId.get(entry.stableId);
      if (!modelName) {
        return Result.err(
          new Level1ToolsetInvariantViolation({
            message: `MCP tool did not receive a model name: ${entry.stableId}`,
          }),
        );
      }
      if (
        isMcpStructurallyAllowed({
          serverId: entry.serverId,
          rawName: entry.rawName,
          modelName,
          runProfile: buildParams.runProfile,
          config: resolvedConfig,
        })
      ) {
        mcpTools.push(entry);
      }
    }

    for (const spec of builtinSpecs) {
      const specName = nameForSpec(spec);
      specs.set(specName, spec);
      directSpecs.set(specName, spec);
    }
    for (const spec of externalSpecs) {
      const contribution = contributionForSpec(spec);
      const specName = nameForSpec(spec);
      const stableId = catalogToolStableId({
        source: "plugin",
        sourceId: contribution.pluginId,
        rawToolName: specName,
      });
      const modelName = nameAssignment.byStableId.get(stableId);
      if (!modelName) {
        return Result.err(
          new Level1ToolsetInvariantViolation({
            message: `External plugin tool did not receive a model name: ${stableId}`,
          }),
        );
      }
      specs.set(modelName, spec);
    }

    const buildContext = {
      ...runContext,
      getTools: () => batchTools,
      getLevel1ToolSpecs: () => directSpecs,
      resolveEditTargets: async <TArgs>(
        spec: CoreLevel1ToolSpec,
        args: TArgs,
        context: { cwd: string },
      ) => {
        const contribution = contributionForSpec(spec);
        const resolved = await invokeLevel1EditTargets({
          pluginId: contribution.pluginId,
          source: contribution.source,
          spec,
          capability: capabilityForSpec(spec),
          args,
          cwd: context.cwd,
        });
        return adaptPluginResultToHost("level1.editTargets", resolved) ?? [];
      },
      reportToolStatus: buildParams.reportToolStatus,
    };

    for (const spec of builtinSpecs) {
      const contribution = contributionForSpec(spec);
      const specName = nameForSpec(spec);
      const executable = invokeLevel1CreateTool({
        pluginId: contribution.pluginId,
        source: contribution.source,
        spec,
        capability: capabilityForSpec(spec),
        context: buildContext,
      });
      if (executable.status === "error") {
        return Result.err(pluginOperationFailure("level1.createTool", executable.error));
      }
      const executableValue = successfulResultValue(executable);
      assignOpaqueTool(tools, specName, executableValue);
      assignOpaqueTool(batchTools, specName, executableValue);
    }

    const candidates: CatalogToolCandidate[] = [];
    for (const spec of externalSpecs) {
      const contribution = contributionForSpec(spec);
      const specName = nameForSpec(spec);
      const identity = {
        source: "plugin",
        sourceId: contribution.pluginId,
        rawToolName: specName,
      } as const;
      const executable = invokeLevel1CreateTool({
        pluginId: contribution.pluginId,
        source: contribution.source,
        spec,
        capability: capabilityForSpec(spec),
        context: buildContext,
      });
      if (executable.status === "error") {
        return Result.err(pluginOperationFailure("level1.createTool", executable.error));
      }
      const executableValue = successfulResultValue(executable);
      const metadata = decodeLevel1ExecutableMetadata(contribution.pluginId, executableValue);
      if (metadata.status === "error") {
        return Result.err(pluginOperationFailure("level1.executableMetadata", metadata.error));
      }
      candidates.push({
        identity,
        ...(metadata.value.title === undefined ? {} : { title: metadata.value.title }),
        ...(metadata.value.description === undefined
          ? {}
          : { description: metadata.value.description }),
        tool: executableValue,
      });
    }
    for (const entry of mcpTools) {
      candidates.push({
        identity: entry.identity,
        ...(entry.title === undefined ? {} : { title: entry.title }),
        ...(entry.description === undefined ? {} : { description: entry.description }),
        tool: entry.tool,
      });
    }

    const catalogReservedNames = new Set(reservedNames);
    for (const candidate of candidates) {
      const assignedName = nameAssignment.byStableId.get(catalogToolStableId(candidate.identity));
      const baseName = baseCatalogToolName(candidate.identity);
      if (assignedName !== baseName) catalogReservedNames.add(baseName);
    }
    const catalogResult = buildUnifiedToolCatalogResult({
      candidates,
      reservedNames: catalogReservedNames,
    });
    if (catalogResult.status === "error") {
      return Result.err(
        new Level1ToolsetAssemblyFailed({
          cause: catalogResult.error,
          message: catalogResult.error.message,
        }),
      );
    }
    const catalog = catalogResult.value;
    for (const entry of catalog.entries) {
      assignOpaqueTool(tools, entry.modelName, catalogCandidateExecutable(entry));
    }
    if (catalog.entries.length > 0) {
      directToolNames.add("tool_search");
      const search = createPortableToolSearchResult({
        catalog: catalog.entries,
        transcriptStore: params.runtime.transcriptStore,
        requestContext: buildParams.requestContext,
      });
      if (search.status === "error") {
        return Result.err(
          new Level1ToolsetAssemblyFailed({ cause: search.error, message: search.error.message }),
        );
      }
      assignOpaqueTool(tools, "tool_search", search.value);
    }

    let batchAuthorityKey = [...directSpecs.keys()].sort().join("\0");
    const updateActiveBatchTools = (activeToolNames: ReadonlySet<string>) => {
      for (const name of Object.keys(batchTools)) delete batchTools[name];
      directSpecs.clear();
      for (const name of activeToolNames) {
        const executable = readOpaqueTool(tools, name);
        const spec = specs.get(name);
        if (executable && spec) {
          assignOpaqueTool(batchTools, name, executable);
          directSpecs.set(name, spec);
        }
      }

      const batchSpec = specs.get("batch");
      if (!activeToolNames.has("batch") || !batchSpec) return;
      const nextBatchAuthorityKey = [...directSpecs.keys()].sort().join("\0");
      if (nextBatchAuthorityKey === batchAuthorityKey) return;
      batchAuthorityKey = nextBatchAuthorityKey;
      const contribution = contributionForSpec(batchSpec);
      const executable = adaptPluginResultToHost(
        "level1.createTool",
        invokeLevel1CreateTool({
          pluginId: contribution.pluginId,
          source: contribution.source,
          spec: batchSpec,
          capability: capabilityForSpec(batchSpec),
          context: buildContext,
        }),
      );
      assignOpaqueTool(tools, "batch", executable);
      assignOpaqueTool(batchTools, "batch", executable);
    };

    return Result.ok({
      tools,
      specs,
      directToolNames,
      catalog: catalog.entries,
      catalogMetadata: catalog.catalogMetadata,
      updateActiveBatchTools,
      contributionInfo,
      genericOutputNormalizerBypassTools: new Set(
        [...specs.entries()]
          .filter(
            ([, spec]) =>
              contributionForSpec(spec).source === "builtin" && hasBoundedBuiltinOutput(spec),
          )
          .map(([modelName]) => modelName),
      ),
      aggregateOutputBudgetExemptTools: new Set(
        [...specs.entries()]
          .filter(
            ([, spec]) =>
              contributionForSpec(spec).source === "builtin" && isAggregateOutputBudgetExempt(spec),
          )
          .map(([modelName]) => modelName),
      ),
    });
  }

  const manager = new ToolPluginManager<CoreToolPluginRuntime, CoreLevel1ToolSpec, ServerTool>({
    runtime: params.runtime,
    dataDir: params.dataDir,
    configPath: resolveCoreConfigPath({ dataDir: params.dataDir }),
    logger,
    builtinPlugins: createBuiltinCoreToolPlugins(),
    getDisabledPluginIds: async () => (await resolveConfig()).plugins?.disabled ?? [],
    getPluginConfig: async (pluginId: string) =>
      resolveOpaquePluginConfig(await resolveConfig(), pluginId),
    getLevel1RegistrationKey: (_spec, contribution, capturedName) =>
      contribution.source === "builtin"
        ? capturedName
        : JSON.stringify([contribution.pluginId, capturedName]),
    adaptLevel1Item: (spec) => spec,
    adaptLevel2Item: (tool) => tool,
  });

  return {
    init: () => manager.init(),
    destroy: () => manager.destroy(),
    reload: () => manager.reload(),
    ensureFresh: () => manager.ensureFresh(),
    getStatuses: () => manager.getStatuses(),
    getLevel2Tools: () => manager.getLevel2Items(),
    getLevel2ContributionInfo: () => manager.getLevel2ContributionInfo(),
    getLevel2Capabilities: () => manager.getLevel2Capabilities(),
    buildLevel1ToolsetResult,
  };
}
