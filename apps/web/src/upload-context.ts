import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { UploadPool } from "./uploads";

export const UploadProgressContext = createContext<
  { pool: UploadPool; threadId: string } | undefined
>(undefined);

export function useUploadProgress(resourceId: string) {
  const context = useContext(UploadProgressContext);
  const subscribe = useCallback(
    (listener: () => void) => context?.pool.subscribe(context.threadId, listener) ?? (() => {}),
    [context],
  );
  const snapshot = useCallback(
    () =>
      context?.pool
        .get(context.threadId)
        .find((item) => (item.resourceId ?? item.key) === resourceId),
    [context, resourceId],
  );
  const attachment = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!attachment || !context) return undefined;
  return { ...attachment, retry: () => context.pool.retry(context.threadId, attachment.key) };
}
