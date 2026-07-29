export type AgentOutputActivitySource = "model" | "tool" | "subagent";

const DEFAULT_PUBLISH_INTERVAL_MS = 30_000;

export function createAgentOutputActivityPublisher(params: {
  publish: (source: AgentOutputActivitySource) => Promise<unknown>;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}): (source: AgentOutputActivitySource) => void {
  const intervalMs = params.intervalMs ?? DEFAULT_PUBLISH_INTERVAL_MS;
  let lastPublishedAt: number | null = null;

  return (source) => {
    const now = Date.now();
    if (lastPublishedAt !== null && now - lastPublishedAt < intervalMs) return;
    lastPublishedAt = now;

    void params.publish(source).catch((error: unknown) => params.onError?.(error));
  };
}
