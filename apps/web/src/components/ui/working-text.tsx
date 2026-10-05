import type { ReactNode } from "react";
import { cn } from "cn";

// The shine is a masked foreground copy over muted text. Gradient text (`background-clip: text`
// with transparent color) breaks `text-overflow: ellipsis` in Firefox.
export function WorkingText({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("working-text", className)}>
      {children}
      <span aria-hidden="true" className="working-text-shine">
        {children}
      </span>
    </span>
  );
}
