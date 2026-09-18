import { useCallback, useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Tooltip } from "@base-ui/react/tooltip";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { Result } from "better-result";

export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <button
            type="button"
            {...props}
            className={`icon-button ${props.className ?? ""}`}
            aria-label={label}
          />
        }
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={6}>
          <Tooltip.Popup className="tooltip">{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Popup className={`modal ${wide ? "modal-wide" : ""}`}>
          <header className="modal-header">
            <Dialog.Title>{title}</Dialog.Title>
            <IconButton label="Close" onClick={onClose}>
              <X />
            </IconButton>
          </header>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
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
}: {
  items: readonly T[];
  itemKey: (item: T) => string;
  render: (item: T, index: number) => ReactNode;
  label: string;
  className?: string;
  estimate?: number;
  activeIndex?: number;
  presentation?: boolean;
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
  useEffect(() => {
    if (activeIndex !== undefined) virtual.scrollToIndex(activeIndex, { align: "auto" });
  }, [activeIndex, virtual]);
  return (
    <div
      ref={parent}
      className={`virtual-list ${className}`}
      aria-label={presentation ? undefined : label}
      role={presentation ? "presentation" : "list"}
    >
      <div className="virtual-canvas" style={{ height: virtual.getTotalSize() }}>
        {virtual.getVirtualItems().map((row) => (
          <div
            key={row.key}
            ref={virtual.measureElement}
            data-index={row.index}
            role={presentation ? "presentation" : "listitem"}
            className="virtual-row"
            style={{ transform: `translateY(${row.start}px)` }}
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
