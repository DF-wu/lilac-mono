import { resolveRouterSessionConfig, type CoreConfig } from "@stanley2058/lilac-utils";

export type SessionSafetyMode = "trusted" | "restricted";

export function resolveSessionSafetyMode(
  cfg: CoreConfig,
  sessionId: string,
  parentChannelId?: string,
  guildId?: string,
): SessionSafetyMode {
  return (
    resolveRouterSessionConfig(cfg, { sessionId, parentChannelId, guildId }).safetyMode ?? "trusted"
  );
}
