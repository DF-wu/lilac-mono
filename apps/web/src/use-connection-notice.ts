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
    const timer = setTimeout(() => {
      toast.add({
        id,
        title: "Reconnecting…",
        type: "info",
        timeout: 0,
        actionProps: { children: "Retry", onClick: retry },
      });
    }, 1_000);
    return () => {
      clearTimeout(timer);
      toast.close(id);
    };
  }, [online, id, retry]);
}
