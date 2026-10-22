import { useLayoutEffect, useRef } from "react";

export function useWorkspaceViewport() {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    const viewport = window.visualViewport;
    if (!element || !viewport) return;
    function syncViewport() {
      if (!element || !viewport) return;
      // Safari does not resize viewport units for the keyboard. Preserve normal pinch zoom.
      if (viewport.scale !== 1) {
        element.style.removeProperty("max-height");
        element.style.removeProperty("transform");
        return;
      }
      element.style.maxHeight = `${viewport.height}px`;
      // iOS can pan the layout viewport to reveal the editor even with root overflow hidden.
      // A transform keeps the fixed panel toggles in the same coordinate system as the workspace.
      element.style.transform = `translateY(${viewport.offsetTop}px)`;
    }
    syncViewport();
    viewport.addEventListener("resize", syncViewport);
    viewport.addEventListener("scroll", syncViewport);
    return () => {
      viewport.removeEventListener("resize", syncViewport);
      viewport.removeEventListener("scroll", syncViewport);
      element.style.removeProperty("max-height");
      element.style.removeProperty("transform");
    };
  }, []);
  return ref;
}
