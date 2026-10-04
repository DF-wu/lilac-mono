import type { NativeClient } from "@stanley2058/lilac-client";

export const CONNECTION_CHECK_INTERVAL_MS = 20_000;

export function watchConnectionLifecycle(
  client: Pick<NativeClient, "reconnect" | "connectionState" | "checkConnection">,
  page: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> = document,
  events: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  let hidden = page.visibilityState === "hidden";
  const visible = () => {
    if (page.visibilityState === "hidden") {
      hidden = true;
      return;
    }
    if (!hidden) return;
    hidden = false;
    client.reconnect();
  };
  const online = () => {
    if (page.visibilityState === "visible") client.reconnect();
  };
  const focus = () => {
    if (client.connectionState === "offline") online();
  };
  // Hidden pages reconnect when they return, so only a visible page needs to probe its socket.
  const check = setInterval(() => {
    if (page.visibilityState === "visible") void client.checkConnection();
  }, CONNECTION_CHECK_INTERVAL_MS);
  page.addEventListener("visibilitychange", visible);
  events.addEventListener("online", online);
  events.addEventListener("focus", focus);
  return () => {
    clearInterval(check);
    page.removeEventListener("visibilitychange", visible);
    events.removeEventListener("online", online);
    events.removeEventListener("focus", focus);
  };
}
