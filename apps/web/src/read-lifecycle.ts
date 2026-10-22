import type { NativeClient } from "@stanley2058/lilac-client";

export function watchReadLifecycle(
  client: Pick<NativeClient, "subscribe">,
  markRead: () => Promise<boolean>,
  page: Pick<
    Document,
    "visibilityState" | "hasFocus" | "addEventListener" | "removeEventListener"
  > = document,
  events: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  let disposed = false;
  let pending = false;
  let acknowledged = false;
  let retry = false;
  async function update() {
    if (disposed || acknowledged || page.visibilityState !== "visible" || !page.hasFocus()) return;
    if (pending) {
      retry = true;
      return;
    }
    pending = true;
    retry = false;
    acknowledged = await markRead();
    pending = false;
    if (retry) void update();
  }
  const unsubscribe = client.subscribe((event) => {
    if (event.kind === "connection" && event.state === "online") void update();
  });
  page.addEventListener("visibilitychange", update);
  events.addEventListener("focus", update);
  events.addEventListener("pageshow", update);
  void update();
  return () => {
    disposed = true;
    unsubscribe();
    page.removeEventListener("visibilitychange", update);
    events.removeEventListener("focus", update);
    events.removeEventListener("pageshow", update);
  };
}
