import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { NativeRpcOutputs, NativeThread } from "@stanley2058/lilac-client-protocol";
import { useWorkspace } from "../workspace-context";
import { useNativeOnline } from "../queries";

type Context = NativeRpcOutputs["threads"]["context"];
const RecentContext = createContext<Context | undefined>(undefined);
export const useRecentContext = () => useContext(RecentContext);

export function RecentContextProvider({
  thread,
  children,
}: {
  thread?: NativeThread;
  children: ReactNode;
}) {
  const { client } = useWorkspace();
  const online = useNativeOnline(client);
  const query = useQuery({
    queryKey: ["recent-context", thread?.id],
    enabled: online && thread?.kind === "dm",
    queryFn: ({ signal }) => client.rpc!.threads.context({ threadId: thread!.id }, { signal }),
    refetchInterval: ({ state }) => {
      if (thread?.activeRunId) return 1000;
      return state.data?.expiresAt ? Math.max(1, state.data.expiresAt - Date.now()) : false;
    },
  });
  const { refetch } = query;
  useEffect(() => {
    if (online && thread?.kind === "dm") void refetch();
  }, [
    online,
    thread?.kind,
    thread?.id,
    thread?.activeRunId,
    thread?.displayStatus,
    thread?.revision,
    refetch,
  ]);
  return <RecentContext value={online ? query.data : undefined}>{children}</RecentContext>;
}

export function RecentContextNotice({ preview }: { preview?: Context } = {}) {
  const current = useRecentContext();
  const context = preview ?? current;
  if (!context) return null;
  return (
    <p className="px-6 py-1 text-xs text-muted-foreground" role="status">
      {context.hasSummary ? "Recent context includes a summary" : "Recent conversation context"}
      {context.active ? " · In use for this reply" : " · For your next message"}
    </p>
  );
}

export function ContextMessage({
  outside,
  summarized,
  children,
}: {
  outside?: boolean;
  summarized?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      title={summarized ? "Represented in the context summary" : undefined}
      data-summarized={summarized || undefined}
      data-context={outside ? "outside" : "recent"}
      className={outside ? "opacity-[var(--ui-context-outside-opacity)]" : undefined}
    >
      {children}
    </div>
  );
}
