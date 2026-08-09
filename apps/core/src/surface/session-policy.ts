import type { CoreConfig } from "@stanley2058/lilac-utils";

export type SessionSafetyMode = "trusted" | "restricted";

export function resolveSessionSafetyMode(
  cfg: CoreConfig,
  sessionId: string,
  parentChannelId?: string,
): SessionSafetyMode {
  const threadSafetyMode = cfg.surface.router.sessionModes[sessionId]?.safetyMode;
  if (threadSafetyMode) return threadSafetyMode;

  const parentId = parentChannelId?.trim();
  if (parentId) {
    const parentSafetyMode = cfg.surface.router.sessionModes[parentId]?.safetyMode;
    if (parentSafetyMode) return parentSafetyMode;
  }

  return "trusted";
}
