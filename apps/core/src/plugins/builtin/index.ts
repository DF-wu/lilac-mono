import type { CoreToolPlugin } from "../types";
import { createBuiltinLocalToolsPlugin } from "./local-tools";
import {
  createBuiltinAttachmentPlugin,
  createBuiltinCodexPlugin,
  createBuiltinConversationThreadPlugin,
  createBuiltinContentInspectPlugin,
  createBuiltinDiscoveryPlugin,
  createBuiltinGeneratePlugin,
  createBuiltinMcpPlugin,
  createBuiltinOnboardingPlugin,
  createBuiltinResourcePlugin,
  createBuiltinSkillsPlugin,
  createBuiltinSshPlugin,
  createBuiltinSurfacePlugin,
  createBuiltinWebPlugin,
  createBuiltinWorkflowPlugin,
} from "./server-tools";

export function createBuiltinCoreToolPlugins(): CoreToolPlugin[] {
  return [
    createBuiltinLocalToolsPlugin(),
    createBuiltinWebPlugin(),
    createBuiltinSkillsPlugin(),
    createBuiltinMcpPlugin(),
    createBuiltinDiscoveryPlugin(),
    createBuiltinConversationThreadPlugin(),
    createBuiltinWorkflowPlugin(),
    createBuiltinSurfacePlugin(),
    createBuiltinAttachmentPlugin(),
    createBuiltinResourcePlugin(),
    createBuiltinOnboardingPlugin(),
    createBuiltinGeneratePlugin(),
    createBuiltinCodexPlugin(),
    createBuiltinContentInspectPlugin(),
    createBuiltinSshPlugin(),
  ];
}
