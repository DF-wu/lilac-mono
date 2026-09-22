import { createContext, useContext, useEffect, useState } from "react";

export const SurfaceVisibilityContext = createContext(true);

export function useSurfaceOpen<Details extends { isCanceled: boolean }>(props: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean, details: Details) => void;
}) {
  const visible = useContext(SurfaceVisibilityContext);
  const [localOpen, setLocalOpen] = useState(props.defaultOpen ?? false);
  useEffect(() => {
    if (!visible) setLocalOpen(false);
  }, [visible]);
  return {
    open: visible && (props.open ?? localOpen),
    onOpenChange: (open: boolean, details: Details) => {
      props.onOpenChange?.(open, details);
      if (!details.isCanceled) setLocalOpen(open);
    },
  };
}
