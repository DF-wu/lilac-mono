import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Quote } from "lucide-react";
import { CITATION_TEXT_LIMIT } from "@stanley2058/lilac-client-protocol";
import { captureAssistantSelection, selectionEndRect } from "../assistant-selection";
import { citationStore } from "../citation-store";
import { Button } from "./ui/button";
import { toast } from "./ui/toast";

export function AssistantSelectionToolbar({
  viewport,
  threadId,
}: {
  viewport: HTMLElement | null;
  threadId: string;
}) {
  const [selection, setSelection] = useState<ReturnType<typeof captureAssistantSelection>>();
  const [point, setPoint] = useState<{ x: number; top: number; bottom: number }>();
  const button = useRef<HTMLButtonElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!viewport) return;
    let dragging = false;
    let dismissed = false;
    let frame: number | undefined;
    let multiClick: ReturnType<typeof setTimeout> | undefined;
    const clear = () => setSelection(undefined);
    const dismiss = () => {
      dismissed = true;
      clear();
    };
    const capture = () => {
      const captured = captureAssistantSelection(viewport, document.getSelection());
      if (!captured || captured.anchor.source.dataset.citationThread !== threadId) {
        clear();
        return;
      }
      const rect = selectionEndRect(captured.anchor);
      const bounds = viewport.getBoundingClientRect();
      if (!rect.width || rect.bottom < bounds.top || rect.top > bounds.bottom) {
        clear();
        return;
      }
      setPoint({
        x: captured.anchor.backwards ? rect.left : rect.right,
        top: Math.max(rect.top, bounds.top),
        bottom: Math.min(rect.bottom, bounds.bottom),
      });
      setSelection(captured);
    };
    const down = (event: PointerEvent) => {
      if (toolbar.current?.contains(event.target instanceof Node ? event.target : null)) return;
      const target = event.target instanceof Element ? event.target : undefined;
      dragging =
        event.button === 0 &&
        !!target &&
        viewport.contains(target) &&
        !target.closest("button,[role=button],input,textarea,[contenteditable]");
      dismissed = !dragging;
      clear();
      clearTimeout(multiClick);
    };
    const up = (event: MouseEvent) => {
      if (!dragging) return;
      dragging = false;
      clearTimeout(multiClick);
      multiClick = setTimeout(
        () => {
          multiClick = undefined;
          capture();
        },
        event.detail > 1 ? 500 : 0,
      );
    };
    const changed = () => {
      if (dismissed || dragging || multiClick !== undefined) return;
      if (button.current === document.activeElement) return;
      cancelAnimationFrame(frame ?? 0);
      frame = requestAnimationFrame(() => capture());
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismiss();
        return;
      }
      if (!dragging) dismissed = false;
      if (event.key === "Tab" && !event.shiftKey && button.current && !button.current.disabled) {
        event.preventDefault();
        button.current.focus({ preventScroll: true });
      }
    };
    const released = (event: PointerEvent) => {
      if (event.pointerType === "mouse" || !dragging) return;
      dragging = false;
      changed();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("mouseup", up);
    document.addEventListener("pointerup", released);
    document.addEventListener("selectionchange", changed);
    document.addEventListener("keydown", key);
    viewport.addEventListener("scroll", dismiss, { passive: true });
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      clearTimeout(multiClick);
      cancelAnimationFrame(frame ?? 0);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("mouseup", up);
      document.removeEventListener("pointerup", released);
      document.removeEventListener("selectionchange", changed);
      document.removeEventListener("keydown", key);
      viewport.removeEventListener("scroll", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [viewport, threadId]);
  useLayoutEffect(() => {
    const element = toolbar.current;
    if (!element || !point) return;
    const rect = element.getBoundingClientRect();
    const above = point.top - rect.height - 6;
    const fitsAbove = above >= 8;
    const top = fitsAbove ? above : point.bottom + 6;
    const left = point.x - rect.width / 2;
    element.style.left = `${Math.max(8, Math.min(left, innerWidth - rect.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(top, innerHeight - rect.height - 8))}px`;
    element.dataset.side = fitsAbove ? "top" : "bottom";
  }, [point, selection]);
  if (!selection || !point) return null;
  const tooLong = selection.selector.text.length > CITATION_TEXT_LIMIT;
  return createPortal(
    <div
      ref={toolbar}
      className="fixed z-50 flex rounded-lg bg-popover p-0.5 text-popover-foreground shadow-md ring-1 ring-border motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 data-[side=bottom]:motion-safe:slide-in-from-top-1 data-[side=top]:motion-safe:slide-in-from-bottom-1"
      style={{ left: point.x, top: point.top }}
      onPointerDown={(event) => event.preventDefault()}
    >
      <Button
        ref={button}
        size="sm"
        variant="ghost"
        data-ui="cite-selection"
        disabled={tooLong}
        onClick={() => {
          const cite = citationStore.getState().composers.get(threadId);
          const messageId = selection.anchor.source.dataset.citationSource;
          if (
            !messageId ||
            !cite?.({ version: 1, threadId, messageId, ...selection.selector }, selection.anchor)
          ) {
            toast.add({
              title: "The composer is unavailable or the quote is too long.",
              type: "error",
            });
            return;
          }
          document.getSelection()?.removeAllRanges();
          setSelection(undefined);
        }}
      >
        <Quote />
        {tooLong ? "Selection too long to cite" : "Cite"}
      </Button>
    </div>,
    document.body,
  );
}
