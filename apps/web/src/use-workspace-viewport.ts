import { useLayoutEffect, useRef } from "react";

export function useWorkspaceViewport() {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    const viewport = window.visualViewport;
    if (!element || !viewport) return;
    function resize() {
      if (!element || !viewport) return;
      // Safari does not resize viewport units for the keyboard. Preserve normal pinch zoom.
      if (viewport.scale !== 1) {
        element.style.removeProperty("max-height");
        return;
      }
      element.style.maxHeight = `${viewport.height}px`;
    }
    resize();
    viewport.addEventListener("resize", resize);
    return () => {
      viewport.removeEventListener("resize", resize);
      element.style.removeProperty("max-height");
    };
  }, []);
  return ref;
}
