import type { ShortcutAction } from "../keybindings";
import { useRef, type ReactNode } from "react";
import { IconButton } from "./ui";

export function PanelToggleButton({
  label,
  open,
  shortcut,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  shortcut?: ShortcutAction;
  onToggle: () => void;
  children: ReactNode;
}) {
  const touchPress = useRef(false);
  return (
    <IconButton
      label={label}
      shortcut={shortcut}
      className="touch-manipulation"
      aria-expanded={open}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        touchPress.current = event.pointerType === "touch";
        if (!touchPress.current) return;
        event.preventDefault();
        onToggle();
      }}
      onClick={(event) => {
        // Touch already activated on press; zero-detail clicks still allow keyboard and assistive activation.
        if (touchPress.current && event.detail !== 0) {
          event.preventDefault();
          return;
        }
        onToggle();
      }}
    >
      {children}
    </IconButton>
  );
}
