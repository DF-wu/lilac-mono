import type { NativeClient } from "@stanley2058/lilac-client";

export function watchConnectionLifecycle(
  client: Pick<NativeClient, "reconnect" | "connectionState">,
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
  page.addEventListener("visibilitychange", visible);
  events.addEventListener("online", online);
  events.addEventListener("focus", focus);
  return () => {
    page.removeEventListener("visibilitychange", visible);
    events.removeEventListener("online", online);
    events.removeEventListener("focus", focus);
  };
}
