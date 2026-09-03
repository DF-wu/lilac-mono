import {
  applyBasePromptForProvider,
  resolveCoreConfigPath,
  resolveNativeSubagentProfile,
  type CoreConfig,
  type EditingToolMode,
  type ResolvedModelRef,
} from "@stanley2058/lilac-utils";

import type { AgentRunProfile } from "./raw";
import type { SurfaceMetadataMessage } from "../surface-metadata";
import type { SessionSafetyMode } from "../../session-policy";
import {
  appendAdditionalSessionMemoBlock,
  appendConfiguredAliasPromptBlock,
  buildAutoInjectedThreadSearchOverlay,
  buildRestrictedSessionOverlay,
  buildSurfaceMetadataOverlay,
  maybeAppendResponseCommentaryPrompt,
} from "./prompt-overlays";
import { buildSystemPromptForProfile, selectWorkspaceSystemPrompt } from "./subagent-prompt";

export function buildAgentRunSystemPrompt(params: {
  cfg: CoreConfig;
  runProfile: AgentRunProfile;
  resolved: ResolvedModelRef;
  editingToolMode: EditingToolMode;
  skillsSection: string | null;
  additionalSessionPrompts: readonly string[];
  messages: readonly SurfaceMetadataMessage[];
  safetyMode: SessionSafetyMode;
  sessionId: string;
  heartbeatOverlay?: string | null;
}): string {
  const workspaceSystemPrompt = selectWorkspaceSystemPrompt({
    profile: params.runProfile,
    primarySystemPrompt: params.cfg.agent.systemPrompt,
    workerSystemPrompt: params.cfg.agent.workerSystemPrompt,
  });
  const providerSystemPrompt = applyBasePromptForProvider({
    systemPrompt: workspaceSystemPrompt,
    basePrompt: params.cfg.basePrompt,
    provider: params.resolved.provider,
  });
  const profilePrompt = {
    baseSystemPrompt: providerSystemPrompt,
    activeEditingTool: params.runProfile === "explore" ? null : params.editingToolMode,
    exploreOverlay: params.cfg.agent.subagents.profiles.explore.promptOverlay,
    generalOverlay: params.cfg.agent.subagents.profiles.general.promptOverlay,
    selfOverlay: params.cfg.agent.subagents.profiles.self.promptOverlay,
    skillsSection: params.skillsSection,
  };
  const baseSystemPrompt =
    params.runProfile === "primary"
      ? buildSystemPromptForProfile({ ...profilePrompt, profile: "primary" })
      : buildSystemPromptForProfile({
          ...profilePrompt,
          profile: params.runProfile,
          profileConfig: resolveNativeSubagentProfile(params.cfg, params.runProfile),
        });

  let prompt = appendConfiguredAliasPromptBlock({
    baseSystemPrompt,
    cfg: params.cfg,
    coreConfigPath: resolveCoreConfigPath(),
  });
  prompt = appendAdditionalSessionMemoBlock(prompt, params.additionalSessionPrompts);

  const autoInjectedThreadSearchOverlay = buildAutoInjectedThreadSearchOverlay({
    cfg: params.cfg,
    runProfile: params.runProfile,
  });
  const surfaceMetadataOverlay = buildSurfaceMetadataOverlay(params.messages);
  const restrictedSessionOverlay =
    params.safetyMode === "restricted"
      ? buildRestrictedSessionOverlay({ sessionId: params.sessionId })
      : null;
  for (const overlay of [
    params.heartbeatOverlay,
    autoInjectedThreadSearchOverlay,
    surfaceMetadataOverlay,
    restrictedSessionOverlay,
  ]) {
    if (overlay?.trim()) prompt = `${prompt}\n\n${overlay}`;
  }

  return maybeAppendResponseCommentaryPrompt({
    baseSystemPrompt: prompt,
    provider: params.resolved.provider,
    responseCommentary: params.resolved.responseCommentary,
  });
}
