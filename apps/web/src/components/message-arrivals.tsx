import { createContext, useContext, useLayoutEffect, useRef } from "react";
import type { MessageArrivals } from "../message-arrivals";

export const MessageArrivalsContext = createContext<MessageArrivals | undefined>(undefined);

export const LiveMessageContext = createContext(false);

export function useMessageArrival(id: string, present = true) {
  const live = useContext(LiveMessageContext);
  const arrivals = useContext(MessageArrivalsContext);
  const ref = useRef<HTMLDivElement>(null);
  const frame = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !present || !arrivals?.claim(id, live)) return;
    element.dataset.messageArrival = "pending";
    // Resolve the starting opacity before the next frame so insertion produces a transition.
    getComputedStyle(element).opacity;
    frame.current = requestAnimationFrame(() => {
      element.dataset.messageArrival = "ready";
    });
  }, [arrivals, id, live, present]);
  useLayoutEffect(() => {
    const element = ref.current;
    return () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      if (element) delete element.dataset.messageArrival;
    };
  }, [arrivals, id]);
  return ref;
}
