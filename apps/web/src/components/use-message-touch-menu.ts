import { useEffect, useRef, type ComponentProps } from "react";
import type { ContextMenuTrigger } from "./ui/context-menu";

type TriggerProps = ComponentProps<typeof ContextMenuTrigger>;
const interactiveTarget =
  'a, button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"], [tabindex]';

export function useMessageTouchMenu() {
  const touchInput = useRef(false);
  const releaseEvent = useRef<Event | null>(null);
  const gesture = useRef<{
    x: number;
    y: number;
    dismissSelection: boolean;
    selectionUnchanged: () => boolean | undefined;
  } | null>(null);
  const cleanup = useRef<(() => void) | undefined>(undefined);
  const cancel = () => {
    gesture.current = null;
    cleanup.current?.();
    cleanup.current = undefined;
  };
  useEffect(() => () => cleanup.current?.(), []);

  const onTouchStart: TriggerProps["onTouchStart"] = (event) => {
    // Let native selection own the hold instead of racing Base UI's long-press timer.
    event.preventBaseUIHandler();
    touchInput.current = true;
    cancel();
    const target = event.target;
    if (!(target instanceof Element)) return;
    const control = target.closest(interactiveTarget);
    if (control && event.currentTarget.contains(control)) return;
    const doc = event.currentTarget.ownerDocument;
    if (event.touches.length !== 1) return;
    const selection = doc.getSelection();
    const dismissSelection = !!selection && !selection.isCollapsed;
    const anchorNode = selection?.anchorNode;
    const anchorOffset = selection?.anchorOffset;
    const focusNode = selection?.focusNode;
    const focusOffset = selection?.focusOffset;
    const selectionUnchanged = () => {
      const current = doc.getSelection();
      return (
        current?.isCollapsed ||
        (dismissSelection &&
          current?.anchorNode === anchorNode &&
          current?.anchorOffset === anchorOffset &&
          current?.focusNode === focusNode &&
          current?.focusOffset === focusOffset)
      );
    };
    const touch = event.touches[0];
    if (!touch) return;
    gesture.current = { x: touch.clientX, y: touch.clientY, dismissSelection, selectionUnchanged };
    const selectionChanged = () => {
      if (!selectionUnchanged()) cancel();
    };
    doc.addEventListener("selectionchange", selectionChanged);
    doc.addEventListener("scroll", cancel, true);
    cleanup.current = () => {
      doc.removeEventListener("selectionchange", selectionChanged);
      doc.removeEventListener("scroll", cancel, true);
    };
  };
  const onTouchMove: TriggerProps["onTouchMove"] = (event) => {
    const start = gesture.current;
    const touch = event.touches[0];
    if (!start) return;
    if (
      event.touches.length !== 1 ||
      !touch ||
      Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10
    )
      cancel();
  };
  const onTouchEnd: TriggerProps["onTouchEnd"] = (event) => {
    const start = gesture.current;
    if (!start) return;
    if (event.touches.length) {
      cancel();
      return;
    }
    const target = event.currentTarget;
    const removeListeners = cleanup.current;
    // Selection changes queued by touch-up must settle before the menu takes focus.
    const frame = requestAnimationFrame(() => {
      const allowed = gesture.current && target.isConnected && start.selectionUnchanged();
      cancel();
      if (!allowed) return;
      if (start.dismissSelection) {
        target.ownerDocument.getSelection()?.removeAllRanges();
        return;
      }
      const contextMenu = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: start.x,
        clientY: start.y,
        button: 2,
      });
      releaseEvent.current = contextMenu;
      target.dispatchEvent(contextMenu);
      releaseEvent.current = null;
    });
    cleanup.current = () => {
      removeListeners?.();
      cancelAnimationFrame(frame);
    };
  };
  const onContextMenu: TriggerProps["onContextMenu"] = (event) => {
    if (
      (touchInput.current && event.nativeEvent !== releaseEvent.current) ||
      !event.currentTarget.ownerDocument.getSelection()?.isCollapsed
    ) {
      event.preventBaseUIHandler();
      event.stopPropagation();
    }
  };
  const onPointerDown: TriggerProps["onPointerDown"] = (event) => {
    touchInput.current = event.pointerType === "touch";
    cancel();
  };
  const onKeyDown: TriggerProps["onKeyDown"] = () => {
    touchInput.current = false;
    cancel();
  };
  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel: cancel,
    onContextMenu,
    onPointerDown,
    onKeyDown,
  };
}
