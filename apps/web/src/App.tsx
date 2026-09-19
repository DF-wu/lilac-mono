import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Result } from "better-result";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  Plus,
  Search,
  Settings as SettingsIcon,
  LogOut,
  Archive,
  ArchiveRestore,
  Pencil,
  Trash2,
  Users,
  Globe,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  WifiOff,
  X,
  MoreHorizontal,
} from "lucide-react";
import type {
  DisplayCatalog,
  NativeThread,
  NativeRpcOutputs,
} from "@stanley2058/lilac-client-protocol";
import type { AppProps, ComposerSubmission } from "./types";
import { UploadPool, resolveAttachmentIds } from "./uploads";
import { Chat, type Draft, type PendingInput } from "./components/Chat";
import { Settings } from "./components/Settings";
import { Sharing } from "./components/Sharing";
import { External } from "./components/External";
import { attempt, ErrorNotice, IconButton, Modal, VirtualList } from "./components/ui";
import { DraftChat } from "./components/DraftChat";
import { ThreadSelect } from "./components/ThreadSelect";
import {
  newDraftThread,
  restoreDraftThread,
  draftThreadTitle,
  hasDraftContent,
  prepareDraftSend,
  releaseDraftAttachments,
  type DraftThread,
} from "./draft-thread";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "./components/ui/resizable";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "./components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./components/ui/dropdown-menu";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import "./styles.css";

export type { AppProps } from "./types";
export function App(props: AppProps) {
  const { client, initial } = props;
  const [threads, setThreads] = useState(initial.threads.items);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const [nextCursor, setNextCursor] = useState(initial.threads.nextCursor);
  const [firstDraft] = useState(newDraftThread);
  const [localDrafts, setLocalDrafts] = useState(() => new Map([[firstDraft.id, firstDraft]]));
  const removedDrafts = useRef(new Set<string>());
  const selectionVersion = useRef(0);
  const localDraftsRef = useRef(localDrafts);
  localDraftsRef.current = localDrafts;
  const [selectedId, setSelectedId] = useState<string | undefined>(
    props.initialThreadId ?? initial.threads.items[0]?.id ?? firstDraft.id,
  );
  const [catalog, setCatalog] = useState<DisplayCatalog | undefined>(() =>
    initial.catalog.kind === "catalog" ? initial.catalog.catalog : client.catalogs.get(props.scope),
  );
  const [connection, setConnection] = useState("online");
  const [error, setError] = useState<string>();
  const [settings, setSettings] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [archived, setArchived] = useState(false);
  const [external, setExternal] = useState(false);
  const [externalId, setExternalId] = useState<string>();
  const [sidebar, setSidebar] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState<NativeRpcOutputs["search"]["query"]>();
  const [searching, setSearching] = useState(false);
  const [rename, setRename] = useState<{ id: string; title: string }>();
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const [theme, setTheme] = useState(() => readTheme());
  const drafts = useRef(new Map<string, Draft>());
  const [pendingInputs, setPendingInputs] = useState(new Map<string, PendingInput[]>());
  const pending = useRef(pendingInputs);
  pending.current = pendingInputs;
  const patchPending = useCallback(
    (id: string, update: (entries: PendingInput[]) => PendingInput[]) => {
      const changed = new Map(pending.current);
      changed.set(id, update(changed.get(id) ?? []));
      pending.current = changed;
      setPendingInputs(changed);
    },
    [],
  );
  const positions = useRef(new Map<string, number>());
  const readTurns = useRef(new Map<string, string>());
  const pool = useMemo(() => new UploadPool(client, props.upload), [client, props.upload]);
  const selectedDraft = selectedId ? localDrafts.get(selectedId) : undefined;
  const selected = threads.find((thread) => thread.id === selectedId);
  const owner = initial.viewer.role === "owner";
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const archivedRef = useRef(archived);
  archivedRef.current = archived;

  useEffect(() => {
    const cache = props.draftCache;
    if (!cache) return;
    let canceled = false;
    const version = selectionVersion.current;
    const state: unknown = history.state;
    void attempt(() => cache.listLocalDrafts(props.scope), setError).then((saved) => {
      if (!saved || canceled) return;
      const changed = new Map(localDraftsRef.current);
      for (const { threadId, draft } of saved) {
        if (changed.has(threadId) || removedDrafts.current.has(threadId)) continue;
        changed.set(threadId, {
          id: threadId,
          draft: { ...draft, attachments: [] },
          attachments: [],
          title: draft.title,
          modelId: draft.modelId,
        });
      }
      localDraftsRef.current = changed;
      setLocalDrafts(changed);
      if (selectionVersion.current !== version || new URL(location.href).searchParams.has("thread"))
        return;
      const restored = restoreDraftThread(changed, state);
      if (!changed.has(restored.id)) return;
      setSelectedId(restored.id);
      history.replaceState({ draftThreadId: restored.id }, "", location.href);
    });
    return () => {
      canceled = true;
    };
  }, [props.draftCache, props.scope]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const saved = Result.try({
      try: () => localStorage.setItem("lilac-theme-v1", theme),
      catch: () => "Storage unavailable",
    });
    saved.match({ ok: () => {}, err: () => {} });
  }, [theme]);
  useEffect(
    () => () => {
      pool.dispose();
      for (const thread of localDraftsRef.current.values()) {
        releaseDraftAttachments(thread.attachments);
        releaseDraftAttachments(thread.creation?.entry.submission.attachments ?? []);
      }
    },
    [pool],
  );
  const upsert = useCallback(
    (thread: NativeThread) =>
      setThreads((current) => {
        const found = current.some((entry) => entry.id === thread.id);
        if (!found && thread.archived !== archivedRef.current && thread.id !== selectedRef.current)
          return current;
        return [...current.filter((entry) => entry.id !== thread.id), thread].sort(
          (a, b) => b.updatedAt - a.updatedAt,
        );
      }),
    [],
  );
  useEffect(
    () =>
      client.subscribe((event) => {
        switch (event.kind) {
          case "bootstrap":
            setThreads(event.bootstrap.threads.items);
            setNextCursor(event.bootstrap.threads.nextCursor);
            setCatalog(client.catalogs.get(props.scope));
            return;
          case "thread":
            upsert(event.thread);
            return;
          case "removed":
            setThreads((items) => items.filter((thread) => thread.id !== event.threadId));
            drafts.current.delete(event.threadId);
            pending.current.delete(event.threadId);
            readTurns.current.delete(event.threadId);
            if (selectedRef.current === event.threadId) setSelectedId(undefined);
            return;
          case "catalog":
            setCatalog(client.catalogs.get(props.scope));
            return;
          case "connection":
            setConnection(event.state);
            return;
          case "error":
            setError(event.error.message);
            return;
          case "checkpoint":
            return;
          case "input":
            return;
        }
      }),
    [client, props.scope, upsert],
  );
  useEffect(() => {
    if (selectedId && !selectedId.startsWith("draft:")) void client.selectThread(selectedId);
  }, [client, selectedId]);
  useEffect(() => {
    const rpc = client.rpc;
    if (!selectedId || selectedId.startsWith("draft:") || selected || !rpc) return;
    let canceled = false;
    void attempt(() => rpc.threads.get({ threadId: selectedId }), setError).then((thread) => {
      if (thread && !canceled) upsert(thread);
    });
    return () => {
      canceled = true;
    };
  }, [client, selectedId, !!selected, connection, upsert]);
  useEffect(() => {
    if (selectedRef.current?.startsWith("draft:")) {
      history.replaceState({ draftThreadId: selectedRef.current }, "", location.href);
    }
    const pop = (event: PopStateEvent) => {
      selectionVersion.current++;
      setExternal(false);
      const id = new URL(window.location.href).searchParams.get("thread");
      if (id) {
        setSelectedId(id);
        return;
      }
      const draft = restoreDraftThread(localDraftsRef.current, event.state);
      const changed = new Map(localDraftsRef.current);
      changed.set(draft.id, draft);
      localDraftsRef.current = changed;
      setLocalDrafts(changed);
      setSelectedId(draft.id);
      history.replaceState({ draftThreadId: draft.id }, "", location.href);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  function changeLocalDraft(id: string, update: (thread: DraftThread) => DraftThread) {
    const current = localDraftsRef.current.get(id);
    if (!current) return;
    const changed = new Map(localDraftsRef.current);
    const next = update(current);
    changed.set(id, next);
    localDraftsRef.current = changed;
    setLocalDrafts(changed);
    const cache = props.draftCache;
    if (!cache) return;
    void attempt(
      () =>
        cache.saveDraft(props.scope, id, {
          ...next.draft,
          title: next.title,
          modelId: next.modelId,
        }),
      setError,
    );
  }
  function removeLocalDraft(id: string) {
    removedDrafts.current.add(id);
    if (props.draftCache)
      void attempt(() => props.draftCache!.deleteDraft(props.scope, id), setError);
    const current = localDraftsRef.current.get(id);
    if (!current) return;
    releaseDraftAttachments(current.attachments);
    releaseDraftAttachments(current.creation?.entry.submission.attachments ?? []);
    const changed = new Map(localDraftsRef.current);
    changed.delete(id);
    localDraftsRef.current = changed;
    setLocalDrafts(changed);
  }
  function select(id: string) {
    selectionVersion.current++;
    setSelectedId(id);
    setExternal(false);
    const url = new URL(window.location.href);
    if (id.startsWith("draft:")) url.searchParams.delete("thread");
    else url.searchParams.set("thread", id);
    history.pushState(id.startsWith("draft:") ? { draftThreadId: id } : {}, "", url);
  }
  function createThread() {
    const draft = newDraftThread();
    const changed = new Map(localDraftsRef.current);
    for (const [id, existing] of changed) if (!hasDraftContent(existing)) changed.delete(id);
    changed.set(draft.id, draft);
    localDraftsRef.current = changed;
    setLocalDrafts(changed);
    setArchived(false);
    select(draft.id);
  }
  async function submitDraft(id: string, submission: ComposerSubmission) {
    const current = localDraftsRef.current.get(id);
    const rpc = client.rpc;
    if (!current || current.sending) return;
    if (!rpc) {
      changeLocalDraft(id, (draft) => ({ ...draft, error: "Connect before sending" }));
      return;
    }
    const creation = prepareDraftSend(current, submission);
    changeLocalDraft(id, (draft) => ({
      ...draft,
      creation,
      sending: true,
      error: undefined,
      ...(draft.creation
        ? {}
        : { attachments: [], draft: { text: "", skillIds: [], attachments: [] } }),
    }));
    const created = await attempt(
      () =>
        rpc.threads.create({
          commandId: creation.commandId,
          title: creation.title,
          modelId: creation.modelId,
        }),
      (error) => changeLocalDraft(id, (draft) => ({ ...draft, sending: false, error })),
    );
    if (!created || pool.signal.aborted) return;
    upsert(created);
    const latest = localDraftsRef.current.get(id);
    const moveAttachments = (files: ComposerSubmission["attachments"]) =>
      files.map((item) => {
        const key = pool.add(created.id, item.file);
        return pool.get(created.id).find((item) => item.key === key)!;
      });
    const files = moveAttachments(creation.entry.submission.attachments);
    const entry: PendingInput = {
      ...creation.entry,
      submission: { ...creation.entry.submission, attachments: files },
    };
    patchPending(created.id, (entries) => [...entries, entry]);
    if (latest) {
      const unsent = moveAttachments(latest.attachments);
      drafts.current.set(created.id, {
        ...latest.draft,
        attachments: unsent.map((file) => file.key),
      });
      if (props.draftCache)
        void attempt(
          () => props.draftCache!.saveDraft(props.scope, created.id, latest.draft),
          setError,
        );
    }
    removeLocalDraft(id);
    if (selectedRef.current === id) select(created.id);
    const patch = (change: Partial<PendingInput> | null) =>
      patchPending(created.id, (entries) =>
        change
          ? entries.map((item) =>
              item.commandId === entry.commandId ? { ...item, ...change } : item,
            )
          : entries.filter((item) => item.commandId !== entry.commandId),
      );
    const prepared = await attempt(
      async () => {
        const [attachmentIds, replay] = await Promise.all([
          resolveAttachmentIds(pool, created.id, files, false),
          rpc.threads.sync({ threadId: created.id }),
        ]);
        if (attachmentIds.some((resourceId) => !resourceId)) {
          patch({
            state: "rejected",
            error: "A file could not be prepared. Retry this message to retry its upload.",
          });
          return;
        }
        return {
          threadId: created.id,
          commandId: entry.commandId,
          historyGeneration: replay.checkpoint.historyGeneration,
          text: entry.text,
          mode: "prompt" as const,
          modelId: entry.submission.modelId,
          attachmentIds: attachmentIds.filter((resourceId): resourceId is string => !!resourceId),
          skillIds: entry.submission.skillIds,
          command: entry.submission.command,
        };
      },
      (error) => patch({ state: "rejected", error }),
    );
    if (!prepared || pool.signal.aborted) return;
    patch({ input: prepared });
    const outcome = await client.submit(prepared);
    if (pool.signal.aborted) return;
    if (outcome.kind === "accepted") {
      for (const file of files) pool.release(created.id, file.key);
      patch(null);
      return;
    }
    patch(
      outcome.kind === "uncertain"
        ? { state: "uncertain", error: "Send not confirmed. Retry safely when connected." }
        : { state: "rejected", error: outcome.error.message },
    );
  }
  async function listThreads(showArchived: boolean, cursor?: string) {
    if (!client.rpc) return;
    const page = await attempt(
      () => client.rpc!.threads.list({ archived: showArchived, limit: 100, cursor }),
      setError,
    );
    if (page) {
      setThreads((current) =>
        cursor
          ? [
              ...current,
              ...page.items.filter((thread) => !current.some((item) => item.id === thread.id)),
            ]
          : page.items,
      );
      setNextCursor(page.nextCursor);
    }
  }
  async function search(cursor?: string) {
    if (!client.rpc || !searchQuery.trim()) {
      setResults(undefined);
      return;
    }
    setSearching(true);
    const result = await attempt(
      () => client.rpc!.search.query({ query: searchQuery.trim(), limit: 100, cursor }),
      setError,
    );
    setSearching(false);
    if (result)
      setResults((current) =>
        cursor && current ? { ...result, items: [...current.items, ...result.items] } : result,
      );
  }
  async function update(id: string, change: { title?: string; archived?: boolean }) {
    if (localDraftsRef.current.has(id)) {
      changeLocalDraft(id, (draft) => ({ ...draft, title: change.title ?? draft.title }));
      setRename(undefined);
      return;
    }
    const target = threads.find((thread) => thread.id === id);
    if (!client.rpc || !target) return;
    const revision = client.thread(id).checkpoint?.projectionRevision ?? target.revision;
    const changed = await attempt(
      () => client.rpc!.threads.update({ threadId: id, expectedRevision: revision, ...change }),
      setError,
    );
    if (changed) {
      upsert(changed);
      setRename(undefined);
    }
  }
  async function deleteThread() {
    const id = confirmDelete;
    if (!id) return;
    if (localDraftsRef.current.has(id)) {
      removeLocalDraft(id);
      setConfirmDelete(undefined);
      if (selectedRef.current === id) createThread();
      return;
    }
    const rpc = client.rpc;
    if (!rpc) return;
    const checkpoint =
      client.thread(id).checkpoint ??
      (await attempt(() => rpc.threads.sync({ threadId: id }), setError))?.checkpoint;
    if (!checkpoint) return;
    const deleted = await attempt(
      () =>
        rpc.threads.delete({
          threadId: id,
          commandId: crypto.randomUUID(),
          historyGeneration: checkpoint.historyGeneration,
        }),
      setError,
    );
    if (!deleted) return;
    setThreads((items) => items.filter((item) => item.id !== id));
    drafts.current.delete(id);
    patchPending(id, () => []);
    setConfirmDelete(undefined);
    if (selectedRef.current === id) createThread();
  }
  const sidebarThreads = [
    ...(!archived
      ? [...localDrafts.values()].filter(hasDraftContent).map((thread) => ({
          id: thread.id,
          title: draftThreadTitle(thread),
          draft: true,
          editable: !thread.creation,
          archived: false,
          source: undefined,
        }))
      : []),
    ...threads
      .filter((thread) => thread.archived === archived)
      .map((thread) => ({
        id: thread.id,
        title: thread.title,
        draft: false,
        editable: thread.capabilities.edit,
        archived: thread.archived,
        source: thread,
      })),
  ];
  const draft = selectedId
    ? (drafts.current.get(selectedId) ?? { text: "", skillIds: [], attachments: [] })
    : { text: "", skillIds: [], attachments: [] };
  const notices = (
    <>
      {connection !== "online" ? (
        <div className="connection-notice" role="status">
          <WifiOff />
          {connection === "connecting"
            ? "Connecting…"
            : "Offline. Cached conversations remain available."}
        </div>
      ) : null}
      <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
    </>
  );
  return (
    <Tooltip.Provider delay={350}>
      <div className={`app-shell ${sidebar ? "" : "sidebar-hidden"}`}>
        <div className="sidebar-toggle">
          <IconButton
            label={sidebar ? "Hide sidebar" : "Show sidebar"}
            onClick={() => setSidebar((value) => !value)}
          >
            {sidebar ? <PanelLeftClose /> : <PanelLeftOpen />}
          </IconButton>
        </div>
        <ResizablePanelGroup orientation="horizontal" className="workspace-panels">
          {sidebar ? (
            <ResizablePanel
              id="sidebar"
              defaultSize="18rem"
              minSize="12rem"
              maxSize="40%"
              className="sidebar-panel"
            >
              <aside className="sidebar">
                <header className="sidebar-header">
                  <span className="brand">
                    lilac
                    <span />
                  </span>
                  <span className="toolbar-spacer" />
                  <IconButton label="New conversation" onClick={() => void createThread()}>
                    <Plus />
                  </IconButton>
                </header>
                <form
                  className="search-box"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void search();
                  }}
                >
                  <Search />
                  <Input
                    className="pl-9 pr-9"
                    value={searchQuery}
                    onChange={(event) => {
                      setSearchQuery(event.target.value);
                      if (!event.target.value) setResults(undefined);
                    }}
                    aria-label="Search conversations"
                    placeholder="Search conversations"
                  />
                  <Button type="submit" className="sr-only">
                    Search
                  </Button>
                  {searchQuery ? (
                    <IconButton
                      label="Clear search"
                      onClick={() => {
                        setSearchQuery("");
                        setResults(undefined);
                      }}
                    >
                      <X />
                    </IconButton>
                  ) : null}
                </form>
                <nav className="sidebar-tabs">
                  <IconButton
                    label={archived ? "Show active conversations" : "Show archived conversations"}
                    aria-pressed={archived}
                    onClick={() => {
                      const value = !archived;
                      setArchived(value);
                      setExternal(false);
                      void listThreads(value);
                    }}
                  >
                    <Archive />
                  </IconButton>
                  {owner ? (
                    <IconButton
                      label="Read other surfaces"
                      aria-pressed={external}
                      onClick={() => {
                        setExternalId(undefined);
                        setExternal((value) => !value);
                      }}
                    >
                      <Globe />
                    </IconButton>
                  ) : null}
                  <span className="toolbar-spacer" />
                  {archived ? <small>Archived</small> : null}
                </nav>
                {results ? (
                  <>
                    <VirtualList
                      items={results.items}
                      itemKey={(hit) => `${hit.threadId}:${hit.turnId ?? hit.excerpt}`}
                      label="Search results"
                      className="thread-list"
                      estimate={92}
                      render={(hit) => (
                        <Button
                          type="button"
                          variant="ghost"
                          className="search-result h-auto flex-col items-start whitespace-normal"
                          onClick={() => {
                            if (hit.surface === "native") select(hit.threadId);
                            else {
                              setExternalId(hit.threadId);
                              setExternal(true);
                            }
                          }}
                        >
                          <strong>{hit.title}</strong>
                          <span>{hit.excerpt}</span>
                        </Button>
                      )}
                    />
                    {results.items.length === 0 && !searching ? (
                      <p className="muted empty-list">No results</p>
                    ) : null}
                    {results.nextCursor ? (
                      <Button
                        variant="ghost"
                        className="text-button"
                        onClick={() => void search(results.nextCursor)}
                      >
                        More results
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <>
                    <VirtualList
                      items={sidebarThreads}
                      itemKey={(thread) => thread.id}
                      label="Conversations"
                      className="thread-list"
                      estimate={64}
                      render={(thread) => (
                        <ContextMenu>
                          <ContextMenuTrigger
                            className={`thread-row ${selectedId === thread.id && !external ? "selected" : ""}`}
                          >
                            {thread.source ? (
                              <ThreadSelect
                                thread={thread.source}
                                viewer={initial.viewer}
                                client={client}
                                modelLabel={
                                  catalog?.models.find(
                                    (model) => model.id === thread.source.modelId,
                                  )?.label
                                }
                                now={now}
                                onSelect={() => select(thread.id)}
                              />
                            ) : (
                              <Button
                                type="button"
                                variant="ghost"
                                className="thread-select flex-1 min-w-0 shrink justify-start"
                                onClick={() => select(thread.id)}
                              >
                                <MessageSquare />
                                <span>{thread.title || "Untitled"}</span>
                                <span className="badge">Draft</span>
                              </Button>
                            )}
                            {thread.editable ? (
                              <span className="thread-actions">
                                <IconButton
                                  label={`Rename ${thread.title || "conversation"}`}
                                  onClick={() => setRename({ id: thread.id, title: thread.title })}
                                >
                                  <Pencil />
                                </IconButton>
                                <IconButton
                                  label={`Delete ${thread.title || "conversation"}`}
                                  onClick={() => setConfirmDelete(thread.id)}
                                >
                                  <Trash2 />
                                </IconButton>
                              </span>
                            ) : null}
                          </ContextMenuTrigger>
                          {thread.editable ? (
                            <ContextMenuContent>
                              <ContextMenuItem
                                onClick={() => setRename({ id: thread.id, title: thread.title })}
                              >
                                <Pencil />
                                Rename
                              </ContextMenuItem>
                              {!thread.draft ? (
                                <ContextMenuItem
                                  onClick={() =>
                                    void update(thread.id, { archived: !thread.archived })
                                  }
                                >
                                  {thread.archived ? <ArchiveRestore /> : <Archive />}
                                  {thread.archived ? "Unarchive" : "Archive"}
                                </ContextMenuItem>
                              ) : null}
                              <ContextMenuItem
                                variant="destructive"
                                onClick={() => setConfirmDelete(thread.id)}
                              >
                                <Trash2 />
                                Delete
                              </ContextMenuItem>
                            </ContextMenuContent>
                          ) : null}
                        </ContextMenu>
                      )}
                    />
                    {nextCursor ? (
                      <Button
                        variant="ghost"
                        className="text-button"
                        onClick={() => void listThreads(archived, nextCursor)}
                      >
                        More conversations
                      </Button>
                    ) : null}
                  </>
                )}
                <footer className="sidebar-footer">
                  {props.userControl ?? (
                    <span className="viewer-name">{initial.viewer.displayName}</span>
                  )}
                  <span className="toolbar-spacer" />
                  {owner ? (
                    <IconButton label="Settings" onClick={() => setSettings(true)}>
                      <SettingsIcon />
                    </IconButton>
                  ) : null}
                  <IconButton
                    label="Sign out"
                    onClick={() => void attempt(props.onLogout, setError)}
                  >
                    <LogOut />
                  </IconButton>
                </footer>
              </aside>
            </ResizablePanel>
          ) : null}
          {sidebar ? (
            <ResizableHandle aria-label="Sidebar width" className="sidebar-resize-handle" />
          ) : null}
          <ResizablePanel id="chat" minSize="40%" className="chat-panel">
            <main className="main-panel">
              {!selected || external ? notices : null}
              {external && owner ? (
                <External
                  client={client}
                  resourceUrl={props.resourceUrl}
                  initialThreadId={externalId}
                />
              ) : null}
              {!external && selected ? (
                <>
                  <header className="thread-header">
                    <h1>{selected.title || "Untitled"}</h1>
                    {selected.archived ? <span className="badge">Archived</span> : null}
                    <span className="toolbar-spacer" />
                    {owner ? (
                      <IconButton label="Share conversation" onClick={() => setSharing(true)}>
                        <Users />
                      </IconButton>
                    ) : null}
                    {selected.capabilities.edit ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <IconButton label="Conversation actions">
                              <MoreHorizontal />
                            </IconButton>
                          }
                        />
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => setRename({ id: selected.id, title: selected.title })}
                          >
                            <Pencil />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              void update(selected.id, { archived: !selected.archived })
                            }
                          >
                            {selected.archived ? <ArchiveRestore /> : <Archive />}
                            {selected.archived ? "Unarchive" : "Archive"}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setConfirmDelete(selected.id)}
                          >
                            <Trash2 />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </header>
                  {notices}
                  <Chat
                    key={selected.id}
                    {...props}
                    thread={selected}
                    catalog={catalog}
                    onError={setError}
                    pool={pool}
                    positions={positions.current}
                    readTurns={readTurns.current}
                    draft={draft}
                    onDraft={(value) => {
                      drafts.current.set(selected.id, value);
                    }}
                    pending={pending.current.get(selected.id) ?? []}
                    onPending={(change) => {
                      patchPending(selected.id, change);
                    }}
                  />
                </>
              ) : null}
              {!external && selectedDraft ? (
                <DraftChat
                  key={selectedDraft.id}
                  client={client}
                  scope={props.scope}
                  catalog={catalog}
                  thread={selectedDraft}
                  onChange={(change) => changeLocalDraft(selectedDraft.id, change)}
                  onSubmit={(submission) => void submitDraft(selectedDraft.id, submission)}
                />
              ) : null}
              {!external && !selected && !selectedDraft ? (
                <div className="welcome">
                  <Button onClick={createThread}>
                    <Plus />
                    New conversation
                  </Button>
                </div>
              ) : null}
            </main>
          </ResizablePanel>
        </ResizablePanelGroup>
        {settings && owner ? (
          <Settings
            client={client}
            onClose={() => setSettings(false)}
            theme={theme}
            onTheme={setTheme}
          />
        ) : null}
        {sharing && owner && selected ? (
          <Sharing client={client} thread={selected} onClose={() => setSharing(false)} />
        ) : null}
        {rename !== undefined ? (
          <Modal title="Rename conversation" onClose={() => setRename(undefined)}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void update(rename.id, { title: rename.title });
              }}
            >
              <Input
                className="wide-input"
                autoFocus
                aria-label="Conversation name"
                value={rename.title}
                onChange={(event) => setRename({ ...rename, title: event.target.value })}
                maxLength={512}
              />
              <div className="dialog-actions">
                <Button className="button primary" type="submit">
                  Rename
                </Button>
              </div>
            </form>
          </Modal>
        ) : null}
        {confirmDelete ? (
          <Modal title="Delete conversation?" onClose={() => setConfirmDelete(undefined)}>
            <p>
              This removes the conversation and makes its files unavailable. Any active run will be
              canceled.
            </p>
            <div className="dialog-actions">
              <Button className="button" onClick={() => setConfirmDelete(undefined)}>
                Keep conversation
              </Button>
              <Button
                variant="destructive"
                className="button danger"
                onClick={() => void deleteThread()}
              >
                Delete
              </Button>
            </div>
          </Modal>
        ) : null}
      </div>
    </Tooltip.Provider>
  );
}
export default App;

function readTheme(): string {
  const stored = Result.try({
    try: () => localStorage.getItem("lilac-theme-v1"),
    catch: () => "Storage unavailable",
  });
  return stored.match({
    ok: (value) => (value === "dark" || value === "light" ? value : "system"),
    err: () => "system",
  });
}
