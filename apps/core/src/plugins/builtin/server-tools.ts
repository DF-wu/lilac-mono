import { ToolPluginSkipError, type ServerTool } from "@stanley2058/lilac-plugin-runtime";

import {
  Attachment,
  Codex,
  ConversationThread,
  ContentInspect,
  Discovery,
  Generate,
  McpManagement,
  Onboarding,
  ProgrammaticWorkflow,
  Resource,
  SSH,
  Skills,
  Surface,
  Web,
} from "../../tool-server/tools";
import type { CoreToolPlugin } from "../types";

function signalBuiltinPluginSkip(reason: string): never {
  throw new ToolPluginSkipError(reason);
}

function singletonLevel2(pluginId: string, createTool: () => ServerTool): CoreToolPlugin {
  return {
    meta: {
      id: pluginId,
    },
    create() {
      return {
        level2: [createTool()],
      };
    },
  };
}

export function createBuiltinWebPlugin(): CoreToolPlugin {
  return singletonLevel2("web", () => new Web());
}

export function createBuiltinSkillsPlugin(): CoreToolPlugin {
  return singletonLevel2("skills", () => new Skills());
}

export function createBuiltinMcpPlugin(): CoreToolPlugin {
  return {
    meta: {
      id: "mcp",
    },
    create({ runtime }) {
      if (!runtime.mcpRegistry || !runtime.mcpOAuthProviders || !runtime.mcpConfigPath) {
        return signalBuiltinPluginSkip(
          "mcp requires registry, OAuth provider service, and config path",
        );
      }
      return {
        level2: [
          new McpManagement({
            registry: runtime.mcpRegistry,
            providers: runtime.mcpOAuthProviders,
            callback: runtime.mcpOAuthCallback,
            configPath: runtime.mcpConfigPath,
          }),
        ],
      };
    },
  };
}

export function createBuiltinDiscoveryPlugin(): CoreToolPlugin {
  return {
    meta: {
      id: "discovery",
    },
    create({ runtime }) {
      if (!runtime.discovery) {
        return signalBuiltinPluginSkip("discovery requires discovery service");
      }
      return {
        level2: [new Discovery({ discovery: runtime.discovery })],
      };
    },
  };
}

export function createBuiltinConversationThreadPlugin(): CoreToolPlugin {
  return {
    meta: {
      id: "conversation.thread",
    },
    create({ runtime }) {
      if (!runtime.conversationThreads) {
        return signalBuiltinPluginSkip("conversation.thread requires conversation thread service");
      }
      return {
        level2: [new ConversationThread({ service: runtime.conversationThreads })],
      };
    },
  };
}

export function createBuiltinOnboardingPlugin(): CoreToolPlugin {
  return singletonLevel2("onboarding", () => new Onboarding());
}

export function createBuiltinCodexPlugin(): CoreToolPlugin {
  return singletonLevel2("codex", () => new Codex());
}

export function createBuiltinGeneratePlugin(): CoreToolPlugin {
  return singletonLevel2("generate", () => new Generate());
}

export function createBuiltinContentInspectPlugin(): CoreToolPlugin {
  return {
    meta: {
      id: "content.inspect",
    },
    create({ runtime }) {
      const config = runtime.config;
      const getConfig = runtime.getConfig ?? (config ? async () => config : undefined);
      return {
        level2: [new ContentInspect({ getConfig })],
      };
    },
  };
}

export function createBuiltinSshPlugin(): CoreToolPlugin {
  return singletonLevel2("ssh", () => new SSH());
}

export function createBuiltinAttachmentPlugin(): CoreToolPlugin {
  return {
    meta: {
      id: "attachment",
    },
    create({ runtime }) {
      if (!runtime.bus) {
        return signalBuiltinPluginSkip("attachment requires bus");
      }
      if (!runtime.blobStore || !runtime.attachmentOutputLifecycle) {
        return signalBuiltinPluginSkip("attachment requires blob output lifecycle");
      }
      return {
        level2: [
          new Attachment({
            bus: runtime.bus,
            blobStore: runtime.blobStore,
            outputLifecycle: runtime.attachmentOutputLifecycle,
            ...(runtime.resourceAccess ? { resourceAccess: runtime.resourceAccess } : {}),
          }),
        ],
      };
    },
  };
}

export function createBuiltinResourcePlugin(): CoreToolPlugin {
  return {
    meta: {
      id: "resource",
    },
    create({ runtime }) {
      if (!runtime.resourceAccess) {
        return signalBuiltinPluginSkip("resource requires resource access");
      }
      return {
        level2: [new Resource({ access: runtime.resourceAccess })],
      };
    },
  };
}

export function createBuiltinWorkflowPlugin(): CoreToolPlugin {
  return {
    meta: {
      id: "workflow",
    },
    create({ runtime, dataDir }) {
      if (!runtime.bus) {
        return signalBuiltinPluginSkip("workflow requires bus");
      }
      if (!runtime.blobStore) {
        return signalBuiltinPluginSkip("workflow requires blob storage");
      }
      const getConfig = runtime.getConfig;
      const config = runtime.config;
      let getMaxActiveRuns: (() => Promise<number>) | (() => number) | undefined;
      if (getConfig) {
        getMaxActiveRuns = async () => (await getConfig()).workflows.maxActiveRuns;
      } else if (config) {
        getMaxActiveRuns = () => config.workflows.maxActiveRuns;
      }
      return {
        level2: [
          new ProgrammaticWorkflow({
            dataDir,
            blobStore: runtime.blobStore,
            store: runtime.durableWorkflowStore,
            bus: runtime.bus,
            progressCards: runtime.workflowProgressCards,
            getMaxActiveRuns,
          }),
        ],
      };
    },
  };
}

export function createBuiltinSurfacePlugin(): CoreToolPlugin {
  return {
    meta: {
      id: "surface",
    },
    create({ runtime }) {
      if (!runtime.surfaceAdapterResolver || !(runtime.config || runtime.getConfig)) {
        return signalBuiltinPluginSkip("surface requires an adapter resolver and config access");
      }
      return {
        level2: [
          new Surface({
            adapterResolver: runtime.surfaceAdapterResolver,
            config: runtime.config,
            getConfig: runtime.getConfig,
            discordSearch: runtime.discordSearch,
            transcriptStore: runtime.transcriptStore,
          }),
        ],
      };
    },
  };
}
