import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { X } from "lucide-react";
import { Result } from "better-result";

export function IconButton({
  label,
  tooltip = label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tooltip?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            {...props}
            className={`icon-button ${props.className ?? ""}`}
            aria-label={label}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export function Modal({
  title,
  children,
  onClose,
  wide = false,
  open: controlledOpen,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  open?: boolean;
}) {
  const [localOpen, setLocalOpen] = useState(true);
  const close = () => {
    if (controlledOpen !== undefined) onClose();
    else setLocalOpen(false);
  };
  return (
    <Dialog
      open={controlledOpen ?? localOpen}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onOpenChangeComplete={(open) => {
        if (!open && controlledOpen === undefined) onClose();
      }}
    >
      <DialogContent
        className={`block max-h-[calc(100dvh-var(--space-6))] overflow-y-auto p-5 ${wide ? "sm:max-w-4xl" : "sm:max-w-lg"}`}
        showCloseButton={false}
      >
        <DialogHeader className="modal-header flex-row items-center justify-between">
          <DialogTitle>{title}</DialogTitle>
          <IconButton label="Close" onClick={close}>
            <X />
          </IconButton>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function VirtualList<T>({
  items,
  itemKey,
  render,
  label,
  className = "",
  estimate = 52,
  activeIndex,
  presentation = false,
  onEndReached,
  hasMore = false,
  loading = false,
  scrollFade = false,
  fillBeforeIndex,
}: {
  items: readonly T[];
  itemKey: (item: T) => string;
  render: (item: T, index: number) => ReactNode;
  label: string;
  className?: string;
  estimate?: number;
  activeIndex?: number;
  presentation?: boolean;
  onEndReached?: () => void;
  hasMore?: boolean;
  loading?: boolean;
  scrollFade?: boolean;
  fillBeforeIndex?: number;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const getItemKey = useCallback((index: number) => itemKey(items[index]!), [items, itemKey]);
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => parent.current,
    estimateSize: () => estimate,
    getItemKey,
    overscan: 5,
  });
  const fillSpace =
    fillBeforeIndex !== undefined && fillBeforeIndex >= 0
      ? Math.max(0, (virtual.scrollRect?.height ?? 0) - virtual.getTotalSize())
      : 0;
  const remaining =
    virtual.getTotalSize() - (virtual.scrollOffset ?? 0) - (virtual.scrollRect?.height ?? 0);
  const nearEnd = remaining < estimate * 3;
  const reachEnd = useEffectEvent(() => onEndReached?.());
  useEffect(() => {
    if (nearEnd && hasMore && !loading) reachEnd();
  }, [nearEnd, hasMore, loading, items.length]);
  useEffect(() => {
    if (activeIndex !== undefined) virtual.scrollToIndex(activeIndex, { align: "auto" });
  }, [activeIndex, virtual]);
  return (
    <div
      ref={parent}
      className={`virtual-list ${className} ${scrollFade && (remaining > 1 || hasMore) ? "scroll-fade" : ""}`}
      aria-busy={loading || undefined}
      aria-label={presentation ? undefined : label}
      role={presentation ? "presentation" : "list"}
    >
      <div className="virtual-canvas" style={{ height: virtual.getTotalSize() + fillSpace }}>
        {virtual.getVirtualItems().map((row) => (
          <div
            key={row.key}
            ref={virtual.measureElement}
            data-index={row.index}
            role={presentation ? "presentation" : "listitem"}
            className="virtual-row"
            style={{
              transform: `translateY(${row.start + (fillBeforeIndex !== undefined && row.index >= fillBeforeIndex ? fillSpace : 0)}px)`,
            }}
          >
            {render(items[row.index]!, row.index)}
          </div>
        ))}
      </div>
    </div>
  );
}

export function uiError(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The request failed";
}

export async function attempt<T>(
  operation: () => Promise<T>,
  onError: (message: string) => void,
): Promise<T | undefined> {
  const result = await Result.tryPromise({ try: operation, catch: uiError });
  return result.match({
    ok: (value) => value,
    err: (message) => {
      onError(message);
      return undefined;
    },
  });
}

export function ErrorNotice({ message, onDismiss }: { message?: string; onDismiss?: () => void }) {
  if (!message) return null;
  return (
    <div className="error-notice" role="alert">
      <span>{message}</span>
      {onDismiss ? (
        <IconButton label="Dismiss error" onClick={onDismiss}>
          <X />
        </IconButton>
      ) : null}
    </div>
  );
}
