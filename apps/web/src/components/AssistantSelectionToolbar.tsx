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
  const [point, setPoint] = useState<{ x: number; y: number }>();
  const button = useRef<HTMLButtonElement>(null);
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
    const capture = (pointer?: { x: number; y: number }) => {
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
      setPoint(
        pointer ?? { x: captured.anchor.backwards ? rect.left : rect.right, y: rect.bottom + 4 },
      );
      setSelection(captured);
    };
    const down = (event: PointerEvent) => {
      if (button.current?.contains(event.target instanceof Node ? event.target : null)) return;
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
          capture({ x: event.clientX, y: event.clientY });
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
    if (!button.current || !point) return;
    const rect = button.current.getBoundingClientRect();
    button.current.style.left = `${Math.max(8, Math.min(point.x, innerWidth - rect.width - 8))}px`;
    button.current.style.top = `${Math.max(8, Math.min(point.y, innerHeight - rect.height - 8))}px`;
  }, [point, selection]);
  if (!selection || !point) return null;
  const tooLong = selection.selector.text.length > CITATION_TEXT_LIMIT;
  return createPortal(
    <Button
      ref={button}
      size="sm"
      variant="secondary"
      className="fixed z-50 shadow-md"
      data-ui="cite-selection"
      style={{ left: point.x, top: point.y }}
      disabled={tooLong}
      aria-label={tooLong ? "Selection is too long to cite" : "Cite selection"}
      onPointerDown={(event) => event.preventDefault()}
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
      {tooLong ? "Shorten selection" : "Cite"}
    </Button>,
    document.body,
  );
}
