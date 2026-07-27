import type { ToolSet } from "ai";
import { z } from "zod";
import type { ClaudeCodeToolCatalogMetadataMap } from "@stanley2058/lilac-claude-code-bridge";
import {
  ToolPluginManager,
  type Level1ExecutionRequestContext,
  type Level1RunProfile,
  type ServerTool,
} from "@stanley2058/lilac-plugin-runtime";
import {
  createLogger,
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
  type CoreLevel1ToolSpec,
  type CoreToolPluginRuntime,
} from "./types";

function isStructurallyAllowed(
  spec: CoreLevel1ToolSpec,
  contribution: import("@stanley2058/lilac-plugin-runtime").Level1ContributionInfo | undefined,
  params: Pick<BuildLevel1ToolsetParams, "runProfile">,
  config: CoreConfig,
): boolean {
  if (params.runProfile === "primary") return true;
  if (!contribution) return false;
  const profile = resolveNativeSubagentProfile(config, params.runProfile);
  if (!profileIncludes(profile.level1.plugins, contribution.pluginId)) return false;
  if (!profileIncludes(profile.level1.tools, spec.name)) return false;
  if (spec.name === "bash" && !profile.execution) return false;
  if (["edit_file", "apply_patch"].includes(spec.name) && !profile.workspaceWrites) return false;
  if (spec.name === "subagent_delegate" && !profile.delegation) return false;
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

async function listServerToolCallableIds(tool: ServerTool): Promise<readonly string[]> {
  const entries = await tool.list();
  return entries.map((entry: Awaited<ReturnType<ServerTool["list"]>>[number]) => entry.callableId);
}

export type BuildLevel1ToolsetParams = {
  cwd: string;
  runProfile: Level1RunProfile;
  editingToolMode: "apply_patch" | "edit_file" | "none";
  subagentDepth: number;
  subagentConfig: {
    enabled: boolean;
    idleTimeoutMs: number;
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
  genericOutputNormalizerBypassTools: ReadonlySet<string>;
};

export type CoreToolPluginManager = ReturnType<typeof createCoreToolPluginManager>;

export function createCoreToolPluginManager(params: {
  runtime: CoreToolPluginRuntime;
  dataDir: string;
}) {
  const logger = createLogger({
    module: "tool-plugin-manager",
  });

  const resolveConfig = async () =>
    params.runtime.config ?? params.runtime.getConfig?.() ?? (await getCoreConfig());

  const manager = new ToolPluginManager<CoreToolPluginRuntime, CoreLevel1ToolSpec, ServerTool>({
    runtime: params.runtime,
    dataDir: params.dataDir,
    configPath: resolveCoreConfigPath({ dataDir: params.dataDir }),
    logger,
    builtinPlugins: createBuiltinCoreToolPlugins(),
    getDisabledPluginIds: async () => (await resolveConfig()).plugins?.disabled ?? [],
    getPluginConfig: async (pluginId: string) =>
      (await resolveConfig()).plugins?.config?.[pluginId],
    getLevel1RegistrationKey: (spec, contribution) =>
      contribution.source === "builtin"
        ? spec.name
        : JSON.stringify([contribution.pluginId, spec.name]),
    getLevel1Name: (spec) => spec.name,
    getLevel2CallableIds: listServerToolCallableIds,
    initLevel2Item: async (tool) => {
      await tool.init();
    },
    destroyLevel2Item: async (tool) => {
      await tool.destroy();
    },
  });

  return {
    init: () => manager.init(),
    destroy: () => manager.destroy(),
    reload: () => manager.reload(),
    ensureFresh: () => manager.ensureFresh(),
    getStatuses: () => manager.getStatuses(),
    getLevel2Tools: () => manager.getLevel2Items(),
    getLevel2ContributionInfo: () => manager.getLevel2ContributionInfo(),
    async buildLevel1Toolset(buildParams: BuildLevel1ToolsetParams): Promise<BuiltLevel1Toolset> {
      await manager.ensureFresh();
      const resolvedConfig = await resolveConfig();

      const tools: ToolSet = {} as ToolSet;
      const batchTools: ToolSet = {} as ToolSet;
      const specs = new Map<string, CoreLevel1ToolSpec>();
      const directSpecs = new Map<string, CoreLevel1ToolSpec>();
      const contributionInfo = manager.getLevel1ContributionInfo();
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
        subagentConfig: buildParams.subagentConfig,
        requestContext: buildParams.requestContext,
      };

      const enabledSpecs = manager
        .getLevel1Items()
        .filter(
          (spec) =>
            spec.isEnabled(runContext) &&
            isStructurallyAllowed(spec, contributionInfo.get(spec), buildParams, resolvedConfig),
        );

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
          if (!contribution) throw new Error(`Missing contribution identity for '${spec.name}'`);
          return {
            source: "plugin",
            sourceId: contribution.pluginId,
            rawToolName: spec.name,
          } as const;
        }),
        ...allMcpTools.map((entry) => entry.identity),
      ];
      const directToolNames = new Set(builtinSpecs.map((spec) => spec.name));
      const reservedNames = new Set(
        manager
          .getLevel1Items()
          .filter((spec) => contributionInfo.get(spec)?.source === "builtin")
          .map((spec) => spec.name),
      );
      reservedNames.add("tool_search");
      const nameAssignment = assignCatalogToolNames(identities, reservedNames);
      if (nameAssignment.collisions.length > 0) {
        throw new Error(
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
        if (!modelName) throw new Error(`MCP tool did not receive a model name: ${entry.stableId}`);
        return isMcpStructurallyAllowed({
          serverId: entry.serverId,
          rawName: entry.rawName,
          modelName,
          runProfile: buildParams.runProfile,
          config: resolvedConfig,
        });
      });

      for (const spec of builtinSpecs) {
        specs.set(spec.name, spec);
        directSpecs.set(spec.name, spec);
      }
      for (const spec of externalSpecs) {
        const contribution = contributionInfo.get(spec);
        if (!contribution) throw new Error(`Missing contribution identity for '${spec.name}'`);
        const stableId = catalogToolStableId({
          source: "plugin",
          sourceId: contribution.pluginId,
          rawToolName: spec.name,
        });
        const modelName = nameAssignment.byStableId.get(stableId);
        if (!modelName)
          throw new Error(`External plugin tool did not receive a model name: ${stableId}`);
        specs.set(modelName, { ...spec, name: modelName });
      }

      const buildContext = {
        ...runContext,
        getTools: () => batchTools,
        getLevel1ToolSpecs: () => directSpecs,
        reportToolStatus: buildParams.reportToolStatus,
      };

      for (const spec of builtinSpecs) {
        const executable = spec.createTool(buildContext);
        (tools as Record<string, unknown>)[spec.name] = executable;
        (batchTools as Record<string, unknown>)[spec.name] = executable;
      }

      const candidateMetadataSchema = z.object({
        title: z.string().optional(),
        description: z.string().optional(),
      });
      const candidates: CatalogToolCandidate[] = [];
      for (const spec of externalSpecs) {
        const contribution = contributionInfo.get(spec);
        if (!contribution) throw new Error(`Missing contribution identity for '${spec.name}'`);
        const identity = {
          source: "plugin",
          sourceId: contribution.pluginId,
          rawToolName: spec.name,
        } as const;
        const executable = spec.createTool(buildContext);
        const metadata = candidateMetadataSchema.safeParse(executable);
        candidates.push({
          identity,
          ...(metadata.success && metadata.data.title !== undefined
            ? { title: metadata.data.title }
            : {}),
          ...(metadata.success && metadata.data.description !== undefined
            ? { description: metadata.data.description }
            : {}),
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
        const executable = batchSpec.createTool(buildContext);
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
        genericOutputNormalizerBypassTools: new Set(
          [...specs.entries()]
            .filter(([, spec]) => hasBoundedBuiltinOutput(spec))
            .map(([modelName]) => modelName),
        ),
      };
    },
  };
}
