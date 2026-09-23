import type { NativeClient } from "@stanley2058/lilac-client";
import { Result } from "better-result";

export function createClerkSessionRefresh(options: {
  client: Pick<NativeClient, "rpc" | "reauthenticate">;
  getToken: () => Promise<string | null>;
  signal: AbortSignal;
  onSignedOut: () => Promise<void>;
  onError: (message: string) => void;
}) {
  let refreshing = false;
  let requested = false;
  const { client, signal } = options;
  return async function refresh(): Promise<void> {
    if (signal.aborted) return;
    requested = true;
    if (refreshing) return;
    refreshing = true;
    while (requested && !signal.aborted) {
      requested = false;
      const rpc = client.rpc;
      const refreshed = await Result.tryPromise({
        try: async () => {
          const token = await options.getToken();
          if (signal.aborted) return "canceled" as const;
          if (!token) return "signed-out" as const;
          if (!client.rpc) return "pending" as const;
          const accepted = await client.reauthenticate(token);
          return accepted ? ("accepted" as const) : ("retry" as const);
        },
        catch: () => "retry" as const,
      });
      if (signal.aborted) break;
      if (rpc !== client.rpc) {
        requested = true;
        continue;
      }
      const outcome = refreshed.match({ ok: (value) => value, err: (value) => value });
      if (outcome === "signed-out") {
        refreshing = false;
        await options.onSignedOut();
        return;
      }
      if (requested) continue;
      options.onError(
        outcome === "retry" ? "Session refresh failed. Reconnecting will retry." : "",
      );
    }
    refreshing = false;
  };
}
