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
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu";

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

  function move(x: number, y: number) {
    const bounds = anchor.current?.getBoundingClientRect();
    if (!bounds) return;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    setPosition({
      x: Math.max(left, Math.min(x, left + (viewport?.width ?? window.innerWidth) - bounds.width)),
      y: Math.max(top, Math.min(y, top + (viewport?.height ?? window.innerHeight) - bounds.height)),
    });
  }

  useLayoutEffect(() => {
    const resize = () => {
      const bounds = anchor.current?.getBoundingClientRect();
      if (!bounds?.width) {
        setOpen(false);
        return;
      }
      move(bounds.left, bounds.top);
    };
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("scroll", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("scroll", resize);
    };
  }, []);

  return createPortal(
    <div
      ref={anchor}
      data-floating-chat-menu
      className="fixed right-4 top-1/2 z-40 workspace:hidden"
      style={
        position ? { left: position.x, top: position.y, right: "auto", bottom: "auto" } : undefined
      }
    >
      <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="default"
              size="icon"
              className="size-11 rounded-full shadow-md ring-1 ring-foreground/20 touch-none"
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
          onPointerUp={() => {
            drag.current = undefined;
          }}
          onPointerCancel={() => {
            drag.current = undefined;
            suppressClick.current = true;
          }}
          onLostPointerCapture={() => {
            drag.current = undefined;
          }}
          onClick={(event) => {
            event.preventDefault();
            if (suppressClick.current && event.detail !== 0) return;
            setOpen((value) => !value);
          }}
        >
          <Menu />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="end"
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
