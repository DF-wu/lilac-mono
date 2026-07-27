import type { AtomicToolExecutionOutcome } from "@stanley2058/lilac-agent";
import { claudeCodeExecutableSettings } from "@stanley2058/lilac-utils";
import type { LanguageModel, ToolSet } from "ai";
import {
  createClaudeCode,
  type ClaudeCodeQueryController,
  type ClaudeCodeSettings,
  type MessageInjector,
} from "ai-sdk-provider-claude-code";

import {
  createClaudeCodeToolBridge,
  validateClaudeCodeBuiltInTools,
  type ClaudeCodeBuiltInTool,
  type ClaudeCodeToolCatalogMetadataMap,
  type ClaudeCodeToolExecutionRequest,
} from "./claude-code-tools";

type CreateClaudeCodeModel = (modelId: string, settings: ClaudeCodeSettings) => LanguageModel;

export type ClaudeCodeRunControl = {
  inject(message: string, onResult?: (delivered: boolean) => void): boolean;
  interrupt(): Promise<boolean>;
  clear(): void;
};

export type MaterializedClaudeCodeRun = {
  agentModel: LanguageModel;
  utilityModel: LanguageModel;
  control: ClaudeCodeRunControl;
  dispose(): Promise<void>;
};

export async function materializeClaudeCodeRun(options: {
  modelId: string;
  cwd: string;
  tools: ToolSet;
  catalogMetadata?: ClaudeCodeToolCatalogMetadataMap;
  execute(request: ClaudeCodeToolExecutionRequest): Promise<AtomicToolExecutionOutcome>;
  /**
   * Claude built-in tools this run may call. Applied to the agent model only;
   * the utility model is always tool-free so a summarization prompt cannot
   * reach the network.
   */
  builtInTools?: readonly ClaudeCodeBuiltInTool[];
  createModel?: CreateClaudeCodeModel;
}): Promise<MaterializedClaudeCodeRun> {
  // Validated here as well as in the bridge, because this array also reaches
  // the Agent SDK's own built-in allowlist.
  const builtInTools = [
    ...new Set([...validateClaudeCodeBuiltInTools(options.builtInTools), "ToolSearch" as const]),
  ];
  const bridge = await createClaudeCodeToolBridge({
    tools: options.tools,
    catalogMetadata: options.catalogMetadata,
    execute: options.execute,
    builtInTools,
  });
  const createModel =
    options.createModel ??
    createClaudeCode({
      defaultSettings: {
        tools: [],
        settingSources: [],
        persistSession: false,
      },
    });
  const executable = claudeCodeExecutableSettings();
  let injector: MessageInjector | null = null;
  let controller: ClaudeCodeQueryController | null = null;
  let disposed = false;

  const control: ClaudeCodeRunControl = {
    inject(message, onResult) {
      if (disposed || !injector) return false;
      injector.inject(message, onResult);
      return true;
    },
    async interrupt() {
      if (disposed) return false;
      bridge.clear();
      if (!controller) return false;
      try {
        await controller.interrupt();
        return true;
      } catch {
        return false;
      }
    },
    clear() {
      injector?.close();
      injector = null;
      controller = null;
      bridge.clear();
    },
  };

  try {
    const agentModel = createModel(options.modelId, {
      ...executable,
      cwd: options.cwd,
      env: { ENABLE_TOOL_SEARCH: "true" },
      tools: builtInTools,
      settingSources: [],
      persistSession: false,
      mcpServers: bridge.mcpServers,
      canUseTool: bridge.canUseTool,
      streamingInput: "always",
      onStreamStart: (nextInjector) => {
        if (disposed) {
          nextInjector.close();
          return;
        }
        injector = nextInjector;
      },
      onQueryControllerCreated: (nextController) => {
        if (!disposed) controller = nextController;
      },
    });
    const utilityModel = createModel(options.modelId, {
      ...executable,
      cwd: options.cwd,
      tools: [],
      settingSources: [],
      persistSession: false,
    });

    return {
      agentModel,
      utilityModel,
      control,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        control.clear();
        await bridge.close();
      },
    };
  } catch (error) {
    disposed = true;
    control.clear();
    await bridge.close().catch(() => undefined);
    throw error;
  }
}
