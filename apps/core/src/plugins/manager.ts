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
import type { Result as ResultType } from "better-result";

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
  buildUnifiedToolCatalog,
  createPortableToolSearch,
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
  if (specName === "bash" && !profile.execution) return false;
  if (["edit_file", "apply_patch"].includes(specName) && !profile.workspaceWrites) return false;
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
  requestContext?: Level1ExecutionRequestContext;
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

type CreatedCoreToolPluginManager = ReturnType<typeof createCoreToolPluginManager>;
export type CoreToolPluginManager = Omit<CreatedCoreToolPluginManager, "getLevel2Capabilities"> &
  Partial<Pick<CreatedCoreToolPluginManager, "getLevel2Capabilities">>;

export function createCoreToolPluginManager(params: {
  runtime: CoreToolPluginRuntime;
  dataDir: string;
}) {
  const logger = createLogger({
    module: "tool-plugin-manager",
  });

  const resolveConfig = async () =>
    params.runtime.config ?? params.runtime.getConfig?.() ?? (await getCoreConfig());

  const failPluginOperation = (
    operation: string,
    error: import("@stanley2058/lilac-plugin-runtime").ToolPluginManagerError,
  ): never => {
    const formatted = formatTaggedErrorForLog(error);
    logger.error("tool plugin operation failed", { operation, ...formatted });
    throw new Error(`Tool plugin ${operation} failed: ${formatted.errorMessage}`);
  };

  const failPluginInvariant = (message: string): never => {
    throw new Error(message);
  };

  const requirePluginResult = <T>(
    operation: string,
    result: ResultType<T, import("@stanley2058/lilac-plugin-runtime").ToolPluginManagerError>,
  ): T => {
    if (result.status === "error") return failPluginOperation(operation, result.error);
    return result.value;
  };

  const manager = new ToolPluginManager<CoreToolPluginRuntime, CoreLevel1ToolSpec, ServerTool>({
    runtime: params.runtime,
    dataDir: params.dataDir,
    configPath: resolveCoreConfigPath({ dataDir: params.dataDir }),
    logger,
    builtinPlugins: createBuiltinCoreToolPlugins(),
    getDisabledPluginIds: async () => (await resolveConfig()).plugins?.disabled ?? [],
    getPluginConfig: async (pluginId: string) =>
      (await resolveConfig()).plugins?.config?.[pluginId],
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
    async buildLevel1Toolset(buildParams: BuildLevel1ToolsetParams): Promise<BuiltLevel1Toolset> {
      const fresh = await manager.ensureFresh();
      if (fresh.status === "error") {
        if (fresh.error._tag !== "ToolPluginReloadCommittedCleanupError") {
          failPluginOperation("ensureFresh", fresh.error);
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
      const capabilityForSpec = (
        spec: CoreLevel1ToolSpec,
      ): Level1ToolSpecCapabilitySnapshot<CoreToolPluginRuntime> => {
        const capability = level1Capabilities.get(spec);
        if (!capability) return failPluginInvariant("Missing captured Level 1 plugin capability");
        return capability;
      };
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
      for (const spec of manager.getLevel1Items()) {
        const contribution = contributionInfo.get(spec);
        const specName = nameForSpec(spec);
        if (!contribution)
          return failPluginInvariant(`Missing contribution identity for '${specName}'`);
        const enabled = requirePluginResult(
          "level1.isEnabled",
          invokeLevel1IsEnabled({
            pluginId: contribution.pluginId,
            source: contribution.source,
            spec,
            capability: capabilityForSpec(spec),
            context: runContext,
          }),
        );
        if (enabled && isStructurallyAllowed(specName, contribution, buildParams, resolvedConfig)) {
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
          const contribution = contributionInfo.get(spec);
          const specName = nameForSpec(spec);
          if (!contribution)
            return failPluginInvariant(`Missing contribution identity for '${specName}'`);
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
          .filter((spec) => contributionInfo.get(spec)?.source === "builtin")
          .map(nameForSpec),
      );
      reservedNames.add("tool_search");
      const nameAssignment = assignCatalogToolNames(identities, reservedNames);
      if (nameAssignment.collisions.length > 0) {
        return failPluginInvariant(
          `Unable to assign unique deferred catalog tool names: ${nameAssignment.collisions
            .map(
              (collision) =>
                `${collision.modelName}: ${collision.identities
                  .map((identity) => catalogToolStableId(identity))
                  .join(", ")}`,
            )
            .join("; ")}`,
        );
      }
      const mcpTools = allMcpTools.filter((entry) => {
        const modelName = nameAssignment.byStableId.get(entry.stableId);
        if (!modelName)
          return failPluginInvariant(`MCP tool did not receive a model name: ${entry.stableId}`);
        return isMcpStructurallyAllowed({
          serverId: entry.serverId,
          rawName: entry.rawName,
          modelName,
          runProfile: buildParams.runProfile,
          config: resolvedConfig,
        });
      });

      for (const spec of builtinSpecs) {
        const specName = nameForSpec(spec);
        specs.set(specName, spec);
        directSpecs.set(specName, spec);
      }
      for (const spec of externalSpecs) {
        const contribution = contributionInfo.get(spec);
        const specName = nameForSpec(spec);
        if (!contribution)
          return failPluginInvariant(`Missing contribution identity for '${specName}'`);
        const stableId = catalogToolStableId({
          source: "plugin",
          sourceId: contribution.pluginId,
          rawToolName: specName,
        });
        const modelName = nameAssignment.byStableId.get(stableId);
        if (!modelName)
          return failPluginInvariant(
            `External plugin tool did not receive a model name: ${stableId}`,
          );
        specs.set(modelName, spec);
      }

      const buildContext = {
        ...runContext,
        getTools: () => batchTools,
        getLevel1ToolSpecs: () => directSpecs,
        resolveEditTargets: async (
          spec: CoreLevel1ToolSpec,
          args: unknown,
          context: { cwd: string },
        ) => {
          const contribution = contributionInfo.get(spec);
          const specName = nameForSpec(spec);
          if (!contribution)
            return failPluginInvariant(`Missing contribution identity for '${specName}'`);
          const resolved = requirePluginResult(
            "level1.editTargets",
            await invokeLevel1EditTargets({
              pluginId: contribution.pluginId,
              source: contribution.source,
              spec,
              capability: capabilityForSpec(spec),
              args,
              cwd: context.cwd,
            }),
          );
          return resolved ?? [];
        },
        reportToolStatus: buildParams.reportToolStatus,
      };

      for (const spec of builtinSpecs) {
        const contribution = contributionInfo.get(spec);
        const specName = nameForSpec(spec);
        if (!contribution)
          return failPluginInvariant(`Missing contribution identity for '${specName}'`);
        const executable = requirePluginResult(
          "level1.createTool",
          invokeLevel1CreateTool({
            pluginId: contribution.pluginId,
            source: contribution.source,
            spec,
            capability: capabilityForSpec(spec),
            context: buildContext,
          }),
        );
        (tools as Record<string, unknown>)[specName] = executable;
        (batchTools as Record<string, unknown>)[specName] = executable;
      }

      const candidates: CatalogToolCandidate[] = [];
      for (const spec of externalSpecs) {
        const contribution = contributionInfo.get(spec);
        const specName = nameForSpec(spec);
        if (!contribution)
          return failPluginInvariant(`Missing contribution identity for '${specName}'`);
        const identity = {
          source: "plugin",
          sourceId: contribution.pluginId,
          rawToolName: specName,
        } as const;
        const executable = requirePluginResult(
          "level1.createTool",
          invokeLevel1CreateTool({
            pluginId: contribution.pluginId,
            source: contribution.source,
            spec,
            capability: capabilityForSpec(spec),
            context: buildContext,
          }),
        );
        const metadata = requirePluginResult(
          "level1.executableMetadata",
          decodeLevel1ExecutableMetadata(contribution.pluginId, executable),
        );
        candidates.push({
          identity,
          ...(metadata.title === undefined ? {} : { title: metadata.title }),
          ...(metadata.description === undefined ? {} : { description: metadata.description }),
          tool: executable,
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
      const catalog = buildUnifiedToolCatalog({
        candidates,
        reservedNames: catalogReservedNames,
      });
      for (const entry of catalog.entries) {
        (tools as Record<string, unknown>)[entry.modelName] = entry.tool;
      }
      if (catalog.entries.length > 0) {
        directToolNames.add("tool_search");
        (tools as Record<string, unknown>).tool_search = createPortableToolSearch({
          catalog: catalog.entries,
          transcriptStore: params.runtime.transcriptStore,
          requestContext: buildParams.requestContext,
        });
      }

      let batchAuthorityKey = [...directSpecs.keys()].sort().join("\0");
      const updateActiveBatchTools = (activeToolNames: ReadonlySet<string>) => {
        for (const name of Object.keys(batchTools)) delete batchTools[name];
        directSpecs.clear();
        for (const name of activeToolNames) {
          const executable = tools[name];
          const spec = specs.get(name);
          // MCP tools deliberately have no Level 1 spec and are never batch children.
          if (executable && spec) {
            (batchTools as Record<string, unknown>)[name] = executable;
            directSpecs.set(name, spec);
          }
        }

        const batchSpec = specs.get("batch");
        if (!activeToolNames.has("batch") || !batchSpec) return;
        const nextBatchAuthorityKey = [...directSpecs.keys()].sort().join("\0");
        if (nextBatchAuthorityKey === batchAuthorityKey) return;
        batchAuthorityKey = nextBatchAuthorityKey;
        const contribution = contributionInfo.get(batchSpec);
        const batchSpecName = nameForSpec(batchSpec);
        if (!contribution)
          return failPluginInvariant(`Missing contribution identity for '${batchSpecName}'`);
        const executable = requirePluginResult(
          "level1.createTool",
          invokeLevel1CreateTool({
            pluginId: contribution.pluginId,
            source: contribution.source,
            spec: batchSpec,
            capability: capabilityForSpec(batchSpec),
            context: buildContext,
          }),
        );
        (tools as Record<string, unknown>).batch = executable;
        (batchTools as Record<string, unknown>).batch = executable;
      };

      return {
        tools,
        specs,
        directToolNames,
        catalog: catalog.entries,
        catalogMetadata: catalog.catalogMetadata,
        updateActiveBatchTools,
        contributionInfo,
        genericOutputNormalizerBypassTools: new Set(
          [...specs.entries()]
            .filter(([, spec]) => hasBoundedBuiltinOutput(spec))
            .map(([modelName]) => modelName),
        ),
        aggregateOutputBudgetExemptTools: new Set(
          [...specs.entries()]
            .filter(([, spec]) => isAggregateOutputBudgetExempt(spec))
            .map(([modelName]) => modelName),
        ),
      };
    },
  };
}
