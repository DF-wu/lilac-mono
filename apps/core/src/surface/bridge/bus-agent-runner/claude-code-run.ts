import type { AtomicToolExecutionOutcome } from "@stanley2058/lilac-agent";
import type { LanguageModel, ToolSet } from "ai";
import {
  createClaudeCode,
  type ClaudeCodeQueryController,
  type ClaudeCodeSettings,
  type MessageInjector,
} from "ai-sdk-provider-claude-code";

import {
  createClaudeCodeToolBridge,
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
  execute(request: ClaudeCodeToolExecutionRequest): Promise<AtomicToolExecutionOutcome>;
  createModel?: CreateClaudeCodeModel;
}): Promise<MaterializedClaudeCodeRun> {
  const bridge = await createClaudeCodeToolBridge({
    tools: options.tools,
    execute: options.execute,
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
      cwd: options.cwd,
      tools: [],
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
