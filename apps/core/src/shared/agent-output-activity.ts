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

    void publish();

    async function publish(): Promise<void> {
      const published = await Result.tryPromise({
        try: () => params.publish(source),
        catch: captureError,
      });
      const failure = published.match({ ok: () => null, err: ({ cause }) => ({ cause }) });
      if (failure) params.onError?.(failure.cause);
    }
  };
}
import { captureError } from "./error-capture.js";
import { Result } from "better-result";
