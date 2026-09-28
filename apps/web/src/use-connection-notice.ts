import { useEffect } from "react";
import { toast } from "./components/ui/toast";
import { useEventCallback } from "./use-event-callback";

export function useConnectionNotice(online: boolean, reconnect: () => void, id = "connection") {
  const retry = useEventCallback(reconnect);
  useEffect(() => {
    if (online) {
      toast.close(id);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The delay only counts visible time, so the reconnect that runs when the tab returns gets
    // the full grace period instead of revealing a notice armed in the background.
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
      }, 1_000);
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
