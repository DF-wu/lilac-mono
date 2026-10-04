import { useEffect } from "react";
import { toast } from "./components/ui/toast";
import { useEventCallback } from "./use-event-callback";

// Registered at import so the resume time is recorded before the connection lifecycle's
// visibility listener starts the reconnect that the notice then waits on. Page load counts as a
// resume because a cached page's first connection also waits for fresh credentials.
let resumedAt = performance.now();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resumedAt = performance.now();
});

export function connectionNoticeDelay(now = performance.now()): number {
  return Math.max(1_000, resumedAt + 3_000 - now);
}

export function useConnectionNotice(online: boolean, reconnect: () => void, id = "connection") {
  const retry = useEventCallback(reconnect);
  useEffect(() => {
    if (online) {
      toast.close(id);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The delay only counts visible time. Returning to the tab reconnects, which may first wait
    // for fresh Clerk credentials, so that reconnect gets a longer grace period.
    const arm = () => {
      clearTimeout(timer);
      toast.close(id);
      if (document.visibilityState !== "visible") return;
      timer = setTimeout(() => {
        toast.add({
          id,
          title: "Reconnecting…",
          type: "info",
          timeout: 0,
          actionProps: { children: "Retry", onClick: retry },
        });
      }, connectionNoticeDelay());
    };
    arm();
    document.addEventListener("visibilitychange", arm);
    return () => {
      document.removeEventListener("visibilitychange", arm);
      clearTimeout(timer);
      toast.close(id);
    };
  }, [online, id, retry]);
}
