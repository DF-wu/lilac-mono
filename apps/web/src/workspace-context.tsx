import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AppProps } from "./types";
import { UploadPool } from "./uploads";
import { createDraftStore } from "./draft-store";
import { releaseDraftAttachments } from "./draft-thread";

type WorkspaceServices = Pick<
  AppProps,
  "client" | "scope" | "upload" | "resourceUrl" | "draftCache"
> & {
  pool: UploadPool;
  drafts: ReturnType<typeof createDraftStore>;
};
const WorkspaceContext = createContext<WorkspaceServices | undefined>(undefined);
export function useOptionalWorkspace() {
  return useContext(WorkspaceContext);
}
export function useWorkspace() {
  return useContext(WorkspaceContext)!;
}

export function WorkspaceProvider({ children, ...props }: AppProps & { children: ReactNode }) {
  const { client, scope, upload, resourceUrl, draftCache } = props;
  const pool = useMemo(() => new UploadPool(client, upload), [client, upload]);
  const drafts = useMemo(() => createDraftStore(), [client]);
  const services = useMemo(
    () => ({ client, scope, upload, resourceUrl, draftCache, pool, drafts }),
    [client, scope, upload, resourceUrl, draftCache, pool, drafts],
  );
  const queries = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry: false, refetchOnWindowFocus: false },
        },
      }),
    [client],
  );
  useEffect(
    () =>
      client.subscribe((event) => {
        if (event.kind === "connection" && event.state === "online")
          void queries.invalidateQueries();
      }),
    [client, queries],
  );
  useEffect(() => () => pool.dispose(), [pool]);
  useEffect(
    () => () => {
      queries.clear();
      for (const draft of drafts.getState().localDrafts.values()) {
        releaseDraftAttachments(draft.attachments);
        releaseDraftAttachments(draft.creation?.entry.submission.attachments ?? []);
      }
    },
    [drafts, queries],
  );
  return (
    <WorkspaceContext value={services}>
      <QueryClientProvider client={queries}>{children}</QueryClientProvider>
    </WorkspaceContext>
  );
}
