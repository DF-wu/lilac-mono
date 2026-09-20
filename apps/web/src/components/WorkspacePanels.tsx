import { useEffect, useRef, type ReactNode } from "react";
import "./workspace-panels.css";

export function WorkspacePanels({
  leftOpen,
  rightOpen,
  children,
}: {
  leftOpen?: boolean;
  rightOpen: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="workspace-panels"
      data-has-left={leftOpen !== undefined}
      data-left-open={leftOpen ?? false}
      data-right-open={rightOpen}
    >
      {children}
    </div>
  );
}

function restorePanelTransition(grid: HTMLElement) {
  // Commit the final track sizes while transitions are disabled, before restoring close/open motion.
  void getComputedStyle(grid).gridTemplateColumns;
  delete grid.dataset.resizing;
}

const minimumChatWidth = 160;

const panelSizes = {
  left: { initial: 288, min: 192, max: 512 },
  right: { initial: 360, min: 240, max: 640 },
};

export function WorkspaceSidePanel({
  side,
  open,
  id,
  label,
  children,
}: {
  side: "left" | "right";
  open: boolean;
  id: string;
  label: string;
  children: ReactNode;
}) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    width: number;
    max: number;
    grid: HTMLElement;
  } | null>(null);
  const sizes = panelSizes[side];
  const direction = side === "left" ? 1 : -1;

  function finishResize() {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    restorePanelTransition(current.grid);
    if (handle.current?.hasPointerCapture(current.pointerId)) {
      handle.current.releasePointerCapture(current.pointerId);
    }
  }

  useEffect(() => {
    if (!open) finishResize();
    return finishResize;
  }, [open]);

  function resizeBounds() {
    const panel = handle.current?.parentElement;
    const grid = panel?.parentElement;
    if (!panel || !grid) return;
    const other = grid.querySelector<HTMLElement>(
      `.workspace-side-panel[data-side="${side === "left" ? "right" : "left"}"]`,
    );
    const max = Math.max(
      sizes.min,
      Math.min(sizes.max, grid.clientWidth - (other?.offsetWidth ?? 0) - minimumChatWidth - 1),
    );
    handle.current?.setAttribute("aria-valuemax", String(max));
    return { grid, width: panel.clientWidth - 1, max };
  }

  useEffect(() => {
    const panel = handle.current?.parentElement;
    if (!panel) return;
    const observer = new ResizeObserver(() => {
      const bounds = resizeBounds();
      if (bounds) handle.current?.setAttribute("aria-valuenow", String(bounds.width));
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  function resize(grid: HTMLElement, width: number, max: number) {
    const pixels = Math.round(Math.max(sizes.min, Math.min(max, width)));
    grid.style.setProperty(`--${side}-panel-width`, `${pixels}px`);
    handle.current?.setAttribute("aria-valuenow", String(pixels));
  }

  return (
    <div
      id={id}
      className="workspace-side-panel"
      data-side={side}
      data-open={open}
      inert={!open}
      aria-hidden={!open}
    >
      {children}
      <div
        ref={handle}
        className="workspace-resize-handle"
        role="separator"
        tabIndex={open ? 0 : -1}
        aria-label={label}
        aria-orientation="vertical"
        aria-controls={id}
        aria-valuemin={sizes.min}
        aria-valuemax={sizes.max}
        aria-valuenow={sizes.initial}
        onFocus={resizeBounds}
        onPointerDown={(event) => {
          if (event.button !== 0 || !open) return;
          const bounds = resizeBounds();
          if (!bounds || bounds.grid.getAnimations().length) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          bounds.grid.dataset.resizing = "true";
          drag.current = { ...bounds, pointerId: event.pointerId, startX: event.clientX };
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current || current.pointerId !== event.pointerId) return;
          resize(
            current.grid,
            current.width + direction * (event.clientX - current.startX),
            current.max,
          );
        }}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={finishResize}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          const bounds = resizeBounds();
          if (!bounds || bounds.grid.getAnimations().length) return;
          event.preventDefault();
          const delta = (event.key === "ArrowRight" ? 10 : -10) * direction;
          let width = bounds.width + delta;
          if (event.key === "Home") width = sizes.min;
          if (event.key === "End") width = bounds.max;
          bounds.grid.dataset.resizing = "true";
          resize(bounds.grid, width, bounds.max);
          restorePanelTransition(bounds.grid);
        }}
      />
    </div>
  );
}
