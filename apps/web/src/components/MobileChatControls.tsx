import type { ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { PanelToggleButton } from "./PanelToggleButton";

export function MobileChatControls({
  sidebarOpen,
  rightOpen,
  onToggleSidebar,
  onToggleRight,
  children,
}: {
  sidebarOpen: boolean;
  rightOpen: boolean;
  onToggleSidebar: () => void;
  onToggleRight: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label="Conversation controls"
      className="flex workspace:hidden items-center justify-end gap-1 pb-2"
    >
      <PanelToggleButton
        label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        open={sidebarOpen}
        onToggle={onToggleSidebar}
      >
        {sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
      </PanelToggleButton>
      {children}
      <PanelToggleButton
        label={rightOpen ? "Hide right panel" : "Show right panel"}
        open={rightOpen}
        onToggle={onToggleRight}
      >
        {rightOpen ? <PanelRightClose /> : <PanelRightOpen />}
      </PanelToggleButton>
    </div>
  );
}
