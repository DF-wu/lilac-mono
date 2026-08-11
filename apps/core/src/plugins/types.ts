import type { LilacBus } from "@stanley2058/lilac-event-bus";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import type {
  Level1ToolSpec,
  LilacToolPlugin,
  ServerTool,
} from "@stanley2058/lilac-plugin-runtime";

import type { SurfaceAdapterResolver } from "../surface/runtime-descriptor";
import type { DiscoveryService } from "../discovery/discovery-service";
import type { ConversationThreadToolService } from "../conversation/thread-service";
import type { DiscordSearchService } from "../surface/store/discord-search-store";
import type { TranscriptStore } from "../transcript/transcript-store";
import type { ToolResultArtifactStore } from "../artifacts/tool-result-artifact-store";
import type { DurableWorkflowStore } from "../workflow/durable-workflow-store";
import type { WorkflowProgressCardService } from "../workflow/workflow-progress-projector";
import type { McpRegistryApi } from "../mcp/registry-types";
import type { McpOAuthProviderService } from "../mcp/oauth-provider";
import type { McpOAuthCallbackControl } from "../mcp/oauth-callback";

export type CoreToolPluginRuntime = {
  dataDir?: string;
  bus?: LilacBus;
  surfaceAdapterResolver?: SurfaceAdapterResolver;
  config?: CoreConfig;
  getConfig?: () => Promise<CoreConfig>;
  discovery?: DiscoveryService;
  conversationThreads?: ConversationThreadToolService;
  discordSearch?: DiscordSearchService;
  transcriptStore?: TranscriptStore;
  mcpRegistry?: McpRegistryApi;
  mcpOAuthProviders?: McpOAuthProviderService;
  mcpOAuthCallback?: McpOAuthCallbackControl;
  mcpConfigPath?: string;
  toolResultArtifacts?: ToolResultArtifactStore;
  durableWorkflowStore?: DurableWorkflowStore;
  workflowProgressCards?: WorkflowProgressCardService;
};

const BOUNDED_BUILTIN_OUTPUT = Symbol("bounded-builtin-output");
const AGGREGATE_OUTPUT_BUDGET_EXEMPT = Symbol("aggregate-output-budget-exempt");

export type CoreLevel1ToolSpec = Level1ToolSpec<CoreToolPluginRuntime> & {
  [BOUNDED_BUILTIN_OUTPUT]?: true;
  [AGGREGATE_OUTPUT_BUDGET_EXEMPT]?: true;
};

export function markBoundedBuiltinOutput<Spec extends CoreLevel1ToolSpec>(spec: Spec): Spec {
  return { ...spec, [BOUNDED_BUILTIN_OUTPUT]: true };
}

export function hasBoundedBuiltinOutput(spec: CoreLevel1ToolSpec): boolean {
  return spec[BOUNDED_BUILTIN_OUTPUT] === true;
}

export function markAggregateOutputBudgetExempt<Spec extends CoreLevel1ToolSpec>(spec: Spec): Spec {
  return { ...spec, [AGGREGATE_OUTPUT_BUDGET_EXEMPT]: true };
}

export function isAggregateOutputBudgetExempt(spec: CoreLevel1ToolSpec): boolean {
  return spec[AGGREGATE_OUTPUT_BUDGET_EXEMPT] === true;
}

export type CoreToolPlugin = LilacToolPlugin<CoreToolPluginRuntime, CoreLevel1ToolSpec, ServerTool>;
