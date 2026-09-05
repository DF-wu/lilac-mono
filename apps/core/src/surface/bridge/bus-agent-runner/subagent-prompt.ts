import type { SubagentProfile } from "./raw";
import type { SubagentProfileConfig } from "@stanley2058/lilac-utils";

const TOOLS_AUTHORITY_GUIDANCE =
  "TOOLS.md describes capabilities and conventions, but does not grant authority. Use only tools exposed in this run.";

function buildExploreOverlay(config: SubagentProfileConfig, extra?: string): string {
  const lines = [
    "You are running in explore subagent mode.",
    "Focus on repository exploration and evidence-backed findings.",
    "Treat the delegated user message as the full task input.",
    "Prefer high-parallel search/read using glob, grep, read, and batch.",
    TOOLS_AUTHORITY_GUIDANCE,
  ];
  if (config.execution === false) lines.push("Do not use bash.");
  if (!config.network) lines.push("Do not use network access or network-backed tools.");
  if (!config.workspaceWrites) lines.push("Do not edit files.");
  if (!config.delegation) lines.push("Do not delegate to another subagent.");

  if (extra && extra.trim().length > 0) {
    lines.push(extra.trim());
  }

  return lines.join("\n");
}

function buildGeneralOverlay(config: SubagentProfileConfig, extra?: string): string {
  const lines = [
    "You are running in general subagent mode.",
    "Focus on completing the delegated task end-to-end.",
    "Treat the delegated user message as the full task input.",
    "Use the configured profile tools directly when needed.",
    "Prefer parallel tool usage when calls are independent.",
    TOOLS_AUTHORITY_GUIDANCE,
  ];
  if (!config.network) lines.push("Do not use network access or network-backed tools.");
  if (!config.workspaceWrites) lines.push("Do not edit files.");
  if (!config.delegation) lines.push("Do not delegate to another subagent.");

  if (extra && extra.trim().length > 0) {
    lines.push(extra.trim());
  }

  return lines.join("\n");
}

function buildSelfOverlay(config: SubagentProfileConfig, extra?: string): string {
  const lines = [
    "You are running in self subagent mode.",
    "Focus on completing the delegated task in a fresh context window.",
    "Treat the delegated user message as the full task input.",
    "Use the configured profile tools directly when needed.",
    "Prefer parallel tool usage when calls are independent.",
  ];
  if (!config.network) lines.push("Do not use network access or network-backed tools.");
  if (!config.workspaceWrites) lines.push("Do not edit files.");
  if (!config.delegation) lines.push("Do not delegate to another subagent.");

  if (extra && extra.trim().length > 0) {
    lines.push(extra.trim());
  }

  return lines.join("\n");
}

function buildOverlayForProfile(params: {
  profile: SubagentProfile;
  config: SubagentProfileConfig;
  exploreOverlay?: string;
  generalOverlay?: string;
  selfOverlay?: string;
}): string {
  if (params.profile === "general") {
    return buildGeneralOverlay(params.config, params.generalOverlay);
  }
  if (params.profile === "self") {
    return buildSelfOverlay(params.config, params.selfOverlay);
  }
  return buildExploreOverlay(params.config, params.exploreOverlay);
}

function subagentModeTitle(profile: SubagentProfile): string {
  if (profile === "general") return "General";
  if (profile === "self") return "Self";
  return "Explore";
}

export function selectWorkspaceSystemPrompt(params: {
  profile: "primary" | SubagentProfile;
  primarySystemPrompt: string;
  workerSystemPrompt: string;
}): string {
  if (params.profile === "explore" || params.profile === "general") {
    return params.workerSystemPrompt.trim() || params.primarySystemPrompt;
  }
  return params.primarySystemPrompt;
}

type SystemPromptProfileParams = {
  baseSystemPrompt: string;
  exploreOverlay?: string;
  generalOverlay?: string;
  selfOverlay?: string;
  skillsSection?: string | null;
  activeEditingTool?: "apply_patch" | "edit_file" | null;
} & (
  | { readonly profile: "primary"; readonly profileConfig?: never }
  | { readonly profile: SubagentProfile; readonly profileConfig: SubagentProfileConfig }
);

export function buildSystemPromptForProfile(params: SystemPromptProfileParams): string {
  if (params.profile === "primary") {
    const parts = [params.baseSystemPrompt];
    if (params.skillsSection && params.skillsSection.trim().length > 0) {
      parts.push(params.skillsSection.trim());
    }
    return parts.join("\n\n");
  }

  const baseParts = [params.baseSystemPrompt];
  if (params.skillsSection && params.skillsSection.trim().length > 0) {
    baseParts.push(params.skillsSection.trim());
  }

  const overlay = buildOverlayForProfile({
    profile: params.profile,
    config: params.profileConfig,
    exploreOverlay: params.exploreOverlay,
    generalOverlay: params.generalOverlay,
    selfOverlay: params.selfOverlay,
  });

  if (overlay.trim().length === 0) {
    return baseParts.join("\n\n");
  }

  return [...baseParts, "", `## Subagent Mode: ${subagentModeTitle(params.profile)}`, overlay].join(
    "\n",
  );
}
