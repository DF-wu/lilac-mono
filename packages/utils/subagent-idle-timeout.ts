export const SUBAGENT_IDLE_TIMEOUT_MIN_MS = 1_000;

export function deriveSubagentIdleTimeoutMs(mainIdleTimeoutMs: number): number {
  if (!Number.isFinite(mainIdleTimeoutMs)) return SUBAGENT_IDLE_TIMEOUT_MIN_MS;

  return Math.max(SUBAGENT_IDLE_TIMEOUT_MIN_MS, Math.floor((mainIdleTimeoutMs * 2) / 3));
}
