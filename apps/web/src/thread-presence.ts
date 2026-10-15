import { Result } from "better-result";
import type { NativeClient } from "@stanley2058/lilac-client";

export function createThreadPresence(client: Pick<NativeClient, "rpc" | "subscribe">) {
  const clientId = crypto.randomUUID();
  let viewedThread: string | undefined;

  async function report() {
    const rpc = client.rpc;
    if (!rpc) return;
    await Result.tryPromise({
      try: () => rpc.notifications.presence({ clientId, threadId: viewedThread }),
      catch: () => "Presence unavailable",
    });
  }

  function view(threadId?: string) {
    viewedThread = threadId;
    void report();
  }

  function start() {
    void report();
    const timer = setInterval(() => {
      if (viewedThread) void report();
    }, 30_000);
    const unsubscribe = client.subscribe((event) => {
      if (event.kind === "connection" && event.state === "online") void report();
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
      view();
    };
  }

  return { view, start };
}
