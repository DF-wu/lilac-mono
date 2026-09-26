import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Menu,
  PanelLeft,
  PanelRight,
  Users,
  Pencil,
  Archive,
  ArchiveRestore,
  Trash2,
} from "lucide-react";
import { cn } from "cn";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu";

const EDGE_INSET = 16;
// Matches translate-x-7, the distance the resting touch target is tucked toward the edge.
const TUCK_OFFSET = 28;

function visibleViewport() {
  const viewport = window.visualViewport;
  return {
    left: viewport?.offsetLeft ?? 0,
    top: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  };
}

export function FloatingChatMenu({
  sidebarOpen,
  rightOpen,
  onToggleSidebar,
  onToggleRight,
  archived,
  onShare,
  onRename,
  onArchive,
  onDelete,
}: {
  sidebarOpen: boolean;
  rightOpen: boolean;
  onToggleSidebar: () => void;
  onToggleRight: () => void;
  archived?: boolean;
  onShare?: () => void;
  onRename?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [snapping, setSnapping] = useState(false);
  const [side, setSide] = useState<"left" | "right">("right");
  const [position, setPosition] = useState<{ x: number; y: number }>();
  const anchor = useRef<HTMLDivElement>(null);
  const drag = useRef<
    | {
        id: number;
        x: number;
        y: number;
        left: number;
        top: number;
        moved: boolean;
      }
    | undefined
  >(undefined);
  const suppressClick = useRef(false);
  const expanded = open || pressed;

  function move(x: number, y: number) {
    const bounds = anchor.current?.getBoundingClientRect();
    if (!bounds) return;
    const view = visibleViewport();
    setPosition({
      x: Math.max(view.left, Math.min(x, view.left + view.width - bounds.width)),
      y: Math.max(view.top, Math.min(y, view.top + view.height - bounds.height)),
    });
  }

  function dock(next: "left" | "right", y: number) {
    const bounds = anchor.current?.getBoundingClientRect();
    if (!bounds) return;
    const view = visibleViewport();
    setSide(next);
    move(
      next === "left" ? view.left + EDGE_INSET : view.left + view.width - bounds.width - EDGE_INSET,
      y,
    );
  }

  function release() {
    const current = drag.current;
    drag.current = undefined;
    setPressed(false);
    const bounds = anchor.current?.getBoundingClientRect();
    if (!current?.moved || !bounds) return;
    const view = visibleViewport();
    setSnapping(true);
    dock(
      bounds.left + bounds.width / 2 < view.left + view.width / 2 ? "left" : "right",
      bounds.top,
    );
  }

  useLayoutEffect(() => {
    const resize = () => {
      // Only a drag release animates; viewport changes must track without lag.
      setSnapping(false);
      const bounds = anchor.current?.getBoundingClientRect();
      if (!bounds?.width) {
        setOpen(false);
        return;
      }
      dock(side, bounds.top);
    };
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("scroll", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("scroll", resize);
    };
  }, [side]);

  return createPortal(
    <div
      ref={anchor}
      data-floating-chat-menu
      className={cn(
        "pointer-events-none fixed right-4 top-1/2 z-40 workspace:hidden",
        snapping && !pressed && "transition-[left]",
      )}
      style={
        position ? { left: position.x, top: position.y, right: "auto", bottom: "auto" } : undefined
      }
    >
      <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              data-expanded={expanded || undefined}
              className={cn(
                // The touch target stays still and mostly off-screen; only the visual expands
                // inward, so a press near the edge cannot slide the target out from under it.
                "pointer-events-auto size-11 rounded-full touch-none hover:bg-transparent aria-expanded:bg-transparent focus-visible:border-transparent focus-visible:ring-0",
                side === "left" ? "-translate-x-7" : "translate-x-7",
              )}
            />
          }
          aria-label="Conversation menu"
          title="Conversation menu · Drag to move"
          onPointerDown={(event) => {
            if (!event.isPrimary || event.button !== 0) return;
            // Open on click so a touch drag cannot open or activate a menu item.
            event.preventDefault();
            const bounds = anchor.current!.getBoundingClientRect();
            suppressClick.current = false;
            drag.current = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              left: bounds.left,
              top: bounds.top,
              moved: false,
            };
            setPressed(true);
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (!current || current.id !== event.pointerId) return;
            const dx = event.clientX - current.x;
            const dy = event.clientY - current.y;
            if (!current.moved && Math.hypot(dx, dy) < 6) return;
            current.moved = true;
            suppressClick.current = true;
            setOpen(false);
            move(current.left + dx, current.top + dy);
          }}
          onPointerUp={release}
          onPointerCancel={() => {
            suppressClick.current = true;
            release();
          }}
          onLostPointerCapture={release}
          onClick={(event) => {
            event.preventDefault();
            if (suppressClick.current && event.detail !== 0) return;
            setOpen((value) => !value);
          }}
        >
          <span
            className={cn(
              "flex size-3 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/60 text-primary-foreground ring-1 ring-foreground/20 transition-all group-focus-visible/button:size-11 group-focus-visible/button:bg-primary group-focus-visible/button:ring-3 group-focus-visible/button:ring-ring/50 group-data-expanded/button:size-11 group-data-expanded/button:bg-primary group-data-expanded/button:shadow-md",
              side === "left"
                ? "group-focus-visible/button:translate-x-7 group-data-expanded/button:translate-x-7"
                : "group-focus-visible/button:-translate-x-7 group-data-expanded/button:-translate-x-7",
            )}
          >
            <Menu className="opacity-0 transition-opacity group-focus-visible/button:opacity-100 group-data-expanded/button:opacity-100" />
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="bottom"
          align={side === "left" ? "start" : "end"}
          alignOffset={TUCK_OFFSET}
          finalFocus={(type) => type === "keyboard"}
          className="min-w-52 [&_[role=menuitem]]:min-h-11"
        >
          <DropdownMenuItem onClick={onToggleSidebar}>
            <PanelLeft />
            {sidebarOpen ? "Hide Sidebar" : "Show Sidebar"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onToggleRight}>
            <PanelRight />
            {rightOpen ? "Hide Right panel" : "Show Right panel"}
          </DropdownMenuItem>
          {onShare ? (
            <DropdownMenuItem onClick={onShare}>
              <Users />
              Share
            </DropdownMenuItem>
          ) : null}
          {onRename ? (
            <DropdownMenuItem onClick={onRename}>
              <Pencil />
              Rename
            </DropdownMenuItem>
          ) : null}
          {onArchive ? (
            <DropdownMenuItem onClick={onArchive}>
              {archived ? <ArchiveRestore /> : <Archive />}
              {archived ? "Unarchive" : "Archive"}
            </DropdownMenuItem>
          ) : null}
          {onDelete ? (
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 />
              Delete
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>,
    document.body,
  );
}
