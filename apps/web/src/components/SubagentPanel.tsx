import { defaultRightPanel } from "../panel-store";
import { useContext, useMemo, useEffect, type ReactNode } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useStore } from "zustand";
import {
  ArrowLeft,
  Bot,
  CircleAlert,
  CircleCheck,
  LoaderCircle,
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
}: {
  threadId: string;
  foreground: boolean;
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
      items={items}
      selected={selected}
      messages={error ? [] : messages}
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
    <aside className="subagent-panel" aria-label="Subagents">
      <header className="subagent-panel-header">
        {selected ? (
          <IconButton label="Back to agents" onClick={onBack}>
            <ArrowLeft />
          </IconButton>
        ) : (
          <Bot />
        )}
        <h2>{selected ? subagentProfileName(selected.profile) : "Agents"}</h2>
      </header>
      {selected ? (
        <div className="subagent-heading">
          <span>{selected.name}</span>
          <span className="subagent-status">
            <AgentStatus agent={selected} />
            <span className={selected.state === "running" ? "working-text" : undefined}>
              {selected.title}
            </span>
          </span>
          <small>Read-only</small>
        </div>
      ) : null}
      {error ? (
        <p className="subagent-notice" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p className="subagent-notice" role="status">
          Loading…
        </p>
      ) : null}
      {selected ? (
        <div
          className="subagent-transcript"
          role="region"
          aria-label="Subagent transcript"
          tabIndex={0}
        >
          <div className="subagent-transcript-content">
            {more}
            {unavailable ? <p className="subagent-notice">Transcript unavailable.</p> : null}
            {!loading && !unavailable && messages.length === 0 ? (
              <p className="subagent-notice">Waiting for the first message…</p>
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
        <div className="subagent-list">
          {!loading && !error && items.length === 0 ? (
            <div className="subagent-empty">
              <Bot />
              <p>No subagents yet</p>
              <span>Agents spawned in this conversation appear here.</span>
            </div>
          ) : null}
          {items.map((agent) => (
            <Button
              key={agent.id}
              variant="ghost"
              className="subagent-card"
              onClick={() => onSelect(agent.id)}
            >
              <Bot />
              <span>
                <strong>{subagentProfileName(agent.profile)}</strong>
                <span className="subagent-name">{agent.name}</span>
                <span className="subagent-status">
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
  if (agent.state === "running") return <LoaderCircle className="animate-spin" />;
  if (agent.state === "complete") return <CircleCheck />;
  return <CircleAlert />;
}

export function RightPanelToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="right-panel-toggle">
      <IconButton
        label={open ? "Hide right panel" : "Show right panel"}
        aria-expanded={open}
        onClick={onToggle}
      >
        {open ? <PanelRightClose /> : <PanelRightOpen />}
      </IconButton>
    </div>
  );
}
