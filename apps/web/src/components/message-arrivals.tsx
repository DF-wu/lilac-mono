import { createContext, useContext, useLayoutEffect, useRef } from "react";
import type { MessageArrivals } from "../message-arrivals";

export const MessageArrivalsContext = createContext<MessageArrivals | undefined>(undefined);

export const LiveMessageContext = createContext(false);

export function useMessageArrival(id: string, present = true) {
  const live = useContext(LiveMessageContext);
  const arrivals = useContext(MessageArrivalsContext);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !present || !arrivals?.claim(id, live)) return;
    element.dataset.messageArrival = "ready";
  }, [arrivals, id, live, present]);
  useLayoutEffect(() => {
    const element = ref.current;
    return () => {
      if (element) delete element.dataset.messageArrival;
    };
  }, [arrivals, id]);
  return ref;
}
