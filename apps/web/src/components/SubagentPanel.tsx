import { LoadingSpinner } from "./ui/loading-spinner";
import { defaultRightPanel } from "../panel-store";
import { useContext, useMemo, useEffect, type ReactNode } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useStore } from "zustand";
import {
  ArrowLeft,
  Bot,
  CircleAlert,
  CircleCheck,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import type { DisplayMessage, SubagentSummary } from "@stanley2058/lilac-client-protocol";
import { useWorkspace } from "../workspace-context";
import {
  subagentsOptions,
  subagentTranscriptOptions,
  subagentHistoryOptions,
  useNativeOnline,
} from "../queries";
import { SubagentContext, subagentProfileName } from "./subagent-context";
import { MessageIdentityContext } from "./message-identity";
import { Message } from "./Timeline";
import { Button } from "./ui/button";
import { IconButton } from "./ui";
import { PanelToggleButton } from "./PanelToggleButton";
import "./subagent-panel.css";

export function NativeSubagentProvider({
  threadId,
  running,
  foreground,
  children,
}: {
  threadId: string;
  running: boolean;
  foreground: boolean;
  children: ReactNode;
}) {
  const { client, panels } = useWorkspace();
  const online = useNativeOnline(client);
  const query = useInfiniteQuery({
    ...subagentsOptions(client, threadId),
    enabled: online && foreground,
    refetchInterval: (query) =>
      foreground &&
      (running ||
        query.state.data?.pages.some((page) =>
          page.items.some((agent) => agent.state === "running"),
        ))
        ? 2000
        : false,
  });
  const agents = useMemo(
    () =>
      new Map(
        query.data?.pages.flatMap((page) => page.items).map((agent) => [agent.activityId, agent]),
      ),
    [query.data],
  );
  const value = useMemo(
    () => ({ agents, open: (id: string) => panels.getState().select(threadId, id) }),
    [agents, panels, threadId],
  );
  return <SubagentContext value={value}>{children}</SubagentContext>;
}

export function NativeSubagentPanel({
  threadId,
  foreground,
  embedded,
}: {
  threadId: string;
  foreground: boolean;
  embedded?: boolean;
}) {
  const { client, panels } = useWorkspace();
  const open = useStore(panels, (state) => (state.threads.get(threadId) ?? defaultRightPanel).open);
  const selection = useStore(panels, (state) => state.selection);
  const queries = useQueryClient();
  const targetId = selection?.threadId === threadId ? selection.agentId : "";
  const online = useNativeOnline(client);
  const list = useInfiniteQuery({
    ...subagentsOptions(client, threadId),
    enabled: open && online && foreground,
  });
  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const target = items.find((agent) => agent.id === targetId || agent.activityId === targetId);
  const agentId = target?.id ?? "";
  const resolving = !!targetId && !target && (list.isPending || !!list.hasNextPage);
  useEffect(() => {
    if (
      open &&
      foreground &&
      online &&
      targetId &&
      !target &&
      list.hasNextPage &&
      !list.isFetching &&
      !list.error
    )
      void list.fetchNextPage();
  }, [
    open,
    foreground,
    online,
    targetId,
    target,
    list.hasNextPage,
    list.isFetching,
    list.error,
    list.fetchNextPage,
  ]);
  const transcript = useQuery({
    ...subagentTranscriptOptions(client, queries, threadId, agentId),
    enabled: open && online && foreground && !!agentId,
    refetchInterval: (query) => {
      if (!open || !foreground || !query.state.data) return false;
      const page = query.state.data;
      if (page.offset + page.messages.length < page.total) return 100;
      return page.agent.state === "running" ? 1000 : false;
    },
  });
  const page = transcript.data;
  const history = useInfiniteQuery({
    ...subagentHistoryOptions(client, threadId, agentId, page?.nextBefore),
    enabled: false,
  });
  const selected = page?.agent ?? target;
  const messages = useMemo(() => {
    const entries = [
      ...(history.data?.pages.toReversed().flatMap((page) => page.messages) ?? []),
      ...(page?.messages ?? []),
    ];
    return [...new Map(entries.map((message) => [message.id, message])).values()];
  }, [history.data, page?.messages]);
  const loading = resolving || (agentId ? transcript.isPending : list.isPending);
  const missing =
    targetId && !target && !resolving ? "Subagent is no longer available." : undefined;
  const error =
    list.error?.message ?? transcript.error?.message ?? history.error?.message ?? missing;
  const moreHistory = history.data ? history.hasNextPage : page?.nextBefore !== undefined;
  const actions = panels.getState();
  return (
    <SubagentPanelView
      embedded={embedded}
      items={items}
      selected={selected}
      messages={messages}
      loading={loading}
      error={error}
      unavailable={page?.unavailable}
      onSelect={(id) => actions.select(threadId, id)}
      onBack={actions.back}
      hasMore={agentId ? moreHistory : list.hasNextPage}
      loadingMore={agentId ? history.isFetchingNextPage : list.isFetchingNextPage}
      onMore={() => {
        void (agentId ? history.fetchNextPage() : list.fetchNextPage());
      }}
    />
  );
}

export function SubagentPanelView({
  embedded,
  items,
  selected,
  messages = [],
  loading,
  error,
  unavailable,
  onSelect,
  onBack,
  hasMore,
  loadingMore,
  onMore,
}: {
  embedded?: boolean;
  items: readonly SubagentSummary[];
  selected?: SubagentSummary;
  messages?: readonly DisplayMessage[];
  loading?: boolean;
  error?: string;
  unavailable?: boolean;
  onSelect: (id: string) => void;
  onBack: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onMore?: () => void;
}) {
  const identity = useContext(MessageIdentityContext);
  const transcriptIdentity = useMemo(
    () => ({
      ...identity,
      viewerId: undefined,
      agent: { displayName: selected ? subagentProfileName(selected.profile) : "Agent" },
    }),
    [identity, selected?.profile],
  );
  const more = hasMore ? (
    <Button variant="ghost" disabled={loadingMore} onClick={onMore}>
      {selected ? "Load older messages" : "Load more agents"}
    </Button>
  ) : null;
  return (
    <aside
      className="subagent-panel flex flex-col min-w-0 h-full bg-sidebar text-sidebar-foreground"
      aria-label="Subagents"
    >
      {selected || !embedded ? (
        <header className="subagent-panel-header flex items-center gap-2 h-8 flex-none px-2 pr-[calc(calc(var(--ui-space-unit)*3)_+_var(--ui-control-compact)_+_calc(var(--ui-space-unit)*2))]">
          {selected ? (
            <IconButton label="Back to agents" onClick={onBack}>
              <ArrowLeft />
            </IconButton>
          ) : (
            <Bot />
          )}
          <h2>{selected ? subagentProfileName(selected.profile) : "Agents"}</h2>
        </header>
      ) : null}
      {selected ? (
        <div className="subagent-heading grid gap-2 p-3 wrap-anywhere">
          <span>{selected.name}</span>
          <span className="subagent-status flex gap-2 items-center min-w-0 text-muted-foreground text-sm">
            <AgentStatus agent={selected} />
            <span className={selected.state === "running" ? "working-text" : undefined}>
              {selected.title}
            </span>
          </span>
          <small>Read-only</small>
        </div>
      ) : null}
      {error ? (
        <p className="subagent-notice p-3 text-muted-foreground text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p className="subagent-notice p-3 text-muted-foreground text-sm" role="status">
          Loading…
        </p>
      ) : null}
      {selected ? (
        <div
          className="subagent-transcript flex-1 flex flex-col-reverse overflow-y-auto overflow-x-hidden min-h-0 bg-background"
          role="region"
          aria-label="Subagent transcript"
          tabIndex={0}
        >
          <div className="subagent-transcript-content shrink-0 flex flex-col gap-4 p-3 min-w-0">
            {more}
            {unavailable ? (
              <p className="subagent-notice p-3 text-muted-foreground text-sm">
                Transcript unavailable.
              </p>
            ) : null}
            {!loading && !unavailable && messages.length === 0 ? (
              <p className="subagent-notice p-3 text-muted-foreground text-sm">
                Waiting for the first message…
              </p>
            ) : null}
            <MessageIdentityContext value={transcriptIdentity}>
              {messages.map((message) => (
                <Message
                  key={message.id}
                  message={message}
                  canEdit={false}
                  resourceUrl={() => ""}
                  onAction={() => {}}
                  onReaction={() => {}}
                />
              ))}
            </MessageIdentityContext>
          </div>
        </div>
      ) : (
        <div className="subagent-list overflow-auto min-h-0 flex-1 p-2">
          {!loading && !error && items.length === 0 ? (
            <div className="subagent-empty flex items-center flex-col justify-center text-center gap-3 min-h-56 text-muted-foreground p-4">
              <Bot />
              <p>No subagents yet</p>
              <span>Agents spawned in this conversation appear here.</span>
            </div>
          ) : null}
          {items.map((agent) => (
            <Button
              key={agent.id}
              variant="ghost"
              className="subagent-card flex items-start justify-start w-full h-auto p-3 text-left gap-3"
              onClick={() => onSelect(agent.id)}
            >
              <Bot />
              <span>
                <strong>{subagentProfileName(agent.profile)}</strong>
                <span className="subagent-name overflow-hidden text-ellipsis whitespace-nowrap">
                  {agent.name}
                </span>
                <span className="subagent-status flex gap-2 items-center min-w-0 text-muted-foreground text-sm">
                  <AgentStatus agent={agent} />
                  <span className={agent.state === "running" ? "working-text" : undefined}>
                    {agent.title}
                  </span>
                </span>
              </span>
            </Button>
          ))}
          {more}
        </div>
      )}
    </aside>
  );
}

function AgentStatus({ agent }: { agent: SubagentSummary }) {
  if (agent.state === "running") return <LoadingSpinner />;
  if (agent.state === "complete") return <CircleCheck />;
  return <CircleAlert />;
}

export function RightPanelToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="right-panel-toggle">
      <PanelToggleButton
        shortcut="rightPanel"
        label={open ? "Hide right panel" : "Show right panel"}
        open={open}
        onToggle={onToggle}
      >
        {open ? <PanelRightClose /> : <PanelRightOpen />}
      </PanelToggleButton>
    </div>
  );
}
