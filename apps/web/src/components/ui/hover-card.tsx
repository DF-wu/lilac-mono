import { PreviewCard } from "@base-ui/react/preview-card";
import { cn } from "cn";
import { useSurfaceOpen } from "./surface-visibility";

export function HoverCard(props: PreviewCard.Root.Props) {
  const open = useSurfaceOpen(props);
  return <PreviewCard.Root {...props} {...open} />;
}
export const HoverCardTrigger = PreviewCard.Trigger;
export function HoverCardContent({ className, ...props }: PreviewCard.Popup.Props) {
  return (
    <PreviewCard.Portal>
      <PreviewCard.Positioner side="top" align="start" sideOffset={8} className="isolate z-50">
        <PreviewCard.Popup
          data-slot="hover-card-content"
          className={cn(
            "w-80 max-h-(--available-height) max-w-(--available-width) overflow-y-auto rounded-lg bg-popover p-3 text-sm text-popover-foreground shadow-md ring-1 ring-border outline-hidden",
            className,
          )}
          {...props}
        />
      </PreviewCard.Positioner>
    </PreviewCard.Portal>
  );
}
