import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { participantOptions, searchOptions, useNativeOnline } from "./queries";
import { useStore } from "zustand";
import { WorkspaceProvider, useWorkspace } from "./workspace-context";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Result } from "better-result";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  Plus,
  Settings as SettingsIcon,
  LogOut,
  Archive,
  ArchiveRestore,
  Pencil,
  Trash2,
  Users,
  Globe,
  PanelLeftClose,
  PanelLeftOpen,
  MoreHorizontal,
  Palette,
} from "lucide-react";
import type { DisplayCatalog, NativeThread } from "@stanley2058/lilac-client-protocol";
import type { AppProps, ComposerSubmission } from "./types";
import { resolveAttachmentIds } from "./uploads";
import { Chat, type Draft, type PendingInput } from "./components/Chat";
const Settings = lazy(() =>
  import("./components/Settings").then((module) => ({ default: module.Settings })),
);
import { SidebarSearch } from "./components/SidebarSearch";
const Sharing = lazy(() =>
  import("./components/Sharing").then((module) => ({ default: module.Sharing })),
);
const External = lazy(() =>
  import("./components/External").then((module) => ({ default: module.External })),
);
import { attempt, IconButton, Modal, VirtualList } from "./components/ui";
import { DraftChat } from "./components/DraftChat";
import { MessageIdentityContext } from "./components/message-identity";
import { toast } from "./components/ui/toast";
import { SidebarThread } from "./components/SidebarThread";
import {
  newDraftThread,
  restoreDraftThread,
  hasDraftContent,
  prepareDraftSend,
  releaseDraftAttachments,
  type DraftThread,
} from "./draft-thread";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "./components/ui/resizable";
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
  return (
    <WorkspaceProvider {...props}>
      <Workspace {...props} />
    </WorkspaceProvider>
  );
}
function Workspace(props: AppProps) {
  const { pool, drafts: draftStore } = useWorkspace();
  const draftIds = useStore(draftStore, (state) => state.ids);
  const setLocalDrafts = draftStore.getState().setLocalDrafts;
  const { client, initial } = props;
  const [threads, setThreads] = useState(initial.threads.items);
  const [nextCursor, setNextCursor] = useState(initial.threads.nextCursor);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [threadListError, setThreadListError] = useState(false);
  const threadListRequest = useRef({ loading: false });
  const [firstDraft] = useState(() => draftStore.getState().localDrafts.values().next().value!);
  const removedDrafts = useRef(new Set<string>());
  const selectionVersion = useRef(0);
  const [selectedId, setSelectedId] = useState<string | undefined>(
    props.initialThreadId ?? initial.threads.items[0]?.id ?? firstDraft.id,
  );
  const [catalog, setCatalog] = useState<DisplayCatalog | undefined>(() =>
    initial.catalog.kind === "catalog" ? initial.catalog.catalog : client.catalogs.get(props.scope),
  );
  const [unknownAuthor, setUnknownAuthor] = useState<{ threadId: string; authorId: string }>();
  const onUnknownAuthor = useCallback(
    (authorId: string) => {
      if (selectedId)
        setUnknownAuthor((current) =>
          current?.threadId === selectedId && current.authorId === authorId
            ? current
            : { threadId: selectedId, authorId },
        );
    },
    [selectedId],
  );
  const [connection, setConnection] = useState("online");
  const [error, setError] = useState<string>();
  const [settings, setSettings] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [archived, setArchived] = useState(false);
  const [external, setExternal] = useState(false);
  const [externalId, setExternalId] = useState<string>();
  const [sidebar, setSidebar] = useState(true);
  const [sidebarPixels, setSidebarPixels] = useState(288);
  const [searchQuery, setSearchQuery] = useState("");
  const online = useNativeOnline(client);
  const queries = useQueryClient();
  const searchResults = useInfiniteQuery({
    ...searchOptions(client, searchQuery),
    enabled: online && !!searchQuery,
  });
  const results = searchQuery
    ? {
        items: searchResults.data?.pages.flatMap((page) => page.items) ?? [],
        nextCursor: searchResults.hasNextPage,
      }
    : undefined;
  const searching = searchResults.isFetching;
  useEffect(() => {
    if (searchResults.error) setError(searchResults.error.message);
  }, [searchResults.error]);
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
  const readTurns = useRef(new Map<string, string>());
  const selectedDraft = useStore(draftStore, (state) =>
    selectedId && state.localDrafts.has(selectedId) ? selectedId : undefined,
  );
  const selected = threads.find((thread) => thread.id === selectedId);
  const owner = initial.viewer.role === "owner";
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const archivedRef = useRef(archived);
  archivedRef.current = archived;

  const participantQuery = useQuery({
    ...participantOptions(client, selected?.id ?? ""),
    enabled: online && !!selected && !external,
  });
  useEffect(() => {
    if (!unknownAuthor || unknownAuthor.threadId !== selected?.id) return;
    void queries.invalidateQueries({ queryKey: ["participants", unknownAuthor.threadId] });
  }, [queries, unknownAuthor, selected?.id]);
  const identities = useMemo(() => {
    const users = new Map(
      participantQuery.data?.items.map(({ user }) => [user.id, { displayName: user.displayName }]),
    );
    users.set(initial.viewer.id, { displayName: initial.viewer.displayName });
    return {
      agent: catalog?.agent ?? { displayName: "Lilac" },
      viewerId: initial.viewer.id,
      users,
      onUnknownAuthor: participantQuery.data ? onUnknownAuthor : undefined,
    };
  }, [catalog?.agent, participantQuery.data, initial.viewer, onUnknownAuthor]);
  useEffect(() => {
    const cache = props.draftCache;
    if (!cache) return;
    let canceled = false;
    const version = selectionVersion.current;
    const state: unknown = history.state;
    void attempt(() => cache.listLocalDrafts(props.scope), setError).then((saved) => {
      if (!saved || canceled) return;
      const changed = new Map(draftStore.getState().localDrafts);
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
            threadListRequest.current = { loading: false };
            setLoadingThreads(false);
            setThreadListError(false);
            setCatalog(client.catalogs.get(props.scope));
            if (archivedRef.current) {
              void listThreads(true);
              return;
            }
            setThreads(event.bootstrap.threads.items);
            setNextCursor(event.bootstrap.threads.nextCursor);
            return;
          case "thread":
            upsert(event.thread);
            return;
          case "removed":
            setThreads((items) => items.filter((thread) => thread.id !== event.threadId));
            queries.removeQueries({ queryKey: ["participants", event.threadId] });
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
      const draft = restoreDraftThread(draftStore.getState().localDrafts, event.state);
      const changed = new Map(draftStore.getState().localDrafts);
      changed.set(draft.id, draft);
      setLocalDrafts(changed);
      setSelectedId(draft.id);
      history.replaceState({ draftThreadId: draft.id }, "", location.href);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  function changeLocalDraft(id: string, update: (thread: DraftThread) => DraftThread) {
    const current = draftStore.getState().localDrafts.get(id);
    if (!current) return;
    const changed = new Map(draftStore.getState().localDrafts);
    const next = update(current);
    changed.set(id, next);
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
    const current = draftStore.getState().localDrafts.get(id);
    if (!current) return;
    releaseDraftAttachments(current.attachments);
    releaseDraftAttachments(current.creation?.entry.submission.attachments ?? []);
    const changed = new Map(draftStore.getState().localDrafts);
    changed.delete(id);
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
    const changed = new Map(draftStore.getState().localDrafts);
    for (const [id, existing] of changed) if (!hasDraftContent(existing)) changed.delete(id);
    changed.set(draft.id, draft);
    setLocalDrafts(changed);
    setArchived(false);
    if (archived) void listThreads(false);
    select(draft.id);
  }
  async function submitDraft(id: string, submission: ComposerSubmission) {
    const current = draftStore.getState().localDrafts.get(id);
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
    const { remapComposerAttachments, resolveComposerAttachments } =
      await import("./components/composer-editor");
    const latest = draftStore.getState().localDrafts.get(id);
    const moveAttachments = (files: ComposerSubmission["attachments"]) =>
      files.map((item) => {
        const key = pool.add(created.id, item.file);
        return pool.get(created.id).find((item) => item.key === key)!;
      });
    const files = moveAttachments(creation.entry.submission.attachments);
    const entry: PendingInput = {
      ...creation.entry,
      submission: {
        ...creation.entry.submission,
        attachmentText: creation.entry.submission.attachmentText
          ? remapComposerAttachments(
              creation.entry.submission.attachmentText,
              new Map(
                creation.entry.submission.attachments.map((attachment, index) => [
                  attachment.key,
                  files[index]!.key,
                ]),
              ),
            )
          : undefined,
        attachments: files,
      },
    };
    patchPending(created.id, (entries) => [...entries, entry]);
    if (latest) {
      const unsent = moveAttachments(latest.attachments);
      const transferredDraft = {
        ...latest.draft,
        text: remapComposerAttachments(
          latest.draft.text,
          new Map(latest.attachments.map((item, index) => [item.key, unsent[index]!.key])),
        ),
        attachments: unsent.map((file) => file.key),
      };
      drafts.current.set(created.id, transferredDraft);
      if (props.draftCache)
        void attempt(
          () => props.draftCache!.saveDraft(props.scope, created.id, transferredDraft),
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
          text: entry.submission.attachmentText
            ? resolveComposerAttachments(
                entry.submission.attachmentText,
                new Map(files.map((file, index) => [file.key, attachmentIds[index]!])),
              )
            : entry.text,
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
    if (!client.rpc || (cursor && threadListRequest.current.loading)) return;
    const request = { loading: true };
    threadListRequest.current = request;
    setLoadingThreads(true);
    setThreadListError(false);
    if (!cursor) setNextCursor(undefined);
    const page = await attempt(
      () => client.rpc!.threads.list({ archived: showArchived, limit: 100, cursor }),
      (message) => {
        if (threadListRequest.current === request) setError(message);
      },
    );
    if (threadListRequest.current !== request) return;
    request.loading = false;
    setLoadingThreads(false);
    if (!page) {
      setThreadListError(true);
      return;
    }
    setThreads((current) => {
      if (!cursor) return page.items;
      const ids = new Set(current.map((thread) => thread.id));
      return [...current, ...page.items.filter((thread) => !ids.has(thread.id))];
    });
    setNextCursor(page.nextCursor);
  }
  async function update(id: string, change: { title?: string; archived?: boolean }) {
    if (draftStore.getState().localDrafts.has(id)) {
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
    if (draftStore.getState().localDrafts.has(id)) {
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
    ...(!archived ? draftIds.map((id) => ({ id, source: undefined })) : []),
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
  useEffect(() => {
    if (!error) return;
    toast.add({ id: "app-error", title: error, type: "error", onClose: () => setError(undefined) });
  }, [error]);
  useEffect(() => {
    if (connection === "online") {
      toast.close("connection");
      return;
    }
    toast.add({
      id: "connection",
      title: connection === "connecting" ? "Connecting…" : "You're offline",
      description: "Cached conversations remain available.",
      type: "info",
      timeout: 0,
    });
    return () => toast.close("connection");
  }, [connection]);
  return (
    <MessageIdentityContext.Provider value={identities}>
      <Tooltip.Provider delay={350}>
        <main
          className={`app-shell ${sidebar ? "" : "sidebar-hidden"}`}
          style={{ "--sidebar-offset": `${sidebarPixels + 1}px` } as CSSProperties}
          aria-label="Chat workspace"
        >
          <div className="sidebar-toggle">
            <IconButton
              label={sidebar ? "Hide sidebar" : "Show sidebar"}
              onClick={() => setSidebar((value) => !value)}
            >
              {sidebar ? <PanelLeftClose /> : <PanelLeftOpen />}
            </IconButton>
          </div>
          <ResizablePanelGroup
            orientation="horizontal"
            className="workspace-panels"
            style={{ width: "var(--workspace-width, 100%)" }}
          >
            <ResizablePanel
              inert={!sidebar}
              aria-hidden={!sidebar}
              onResize={(size) => {
                if (size.inPixels > 0) setSidebarPixels(size.inPixels);
              }}
              id="sidebar"
              groupResizeBehavior="preserve-pixel-size"
              defaultSize="18rem"
              minSize="12rem"
              maxSize="32rem"
              className="sidebar-panel"
            >
              <aside className="sidebar">
                <header className="sidebar-header">
                  <span className="brand">
                    lilac
                    <span />
                  </span>
                </header>
                <div className="sidebar-search-row">
                  <SidebarSearch
                    onSearch={(query) => {
                      const next = query.trim();
                      if (next && next === searchQuery) void searchResults.refetch();
                      setSearchQuery(next);
                    }}
                    onClear={() => setSearchQuery("")}
                  />
                  <nav className="sidebar-tabs" aria-label="Conversation filters and actions">
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
                    <IconButton label="New conversation" onClick={() => void createThread()}>
                      <Plus />
                    </IconButton>
                  </nav>
                </div>
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
                        disabled={searching}
                        onClick={() => {
                          if (!searching)
                            void searchResults.fetchNextPage({ cancelRefetch: false });
                        }}
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
                      scrollFade
                      hasMore={!!nextCursor && !threadListError}
                      loading={loadingThreads}
                      onEndReached={() => {
                        if (nextCursor) void listThreads(archived, nextCursor);
                      }}
                      className="thread-list"
                      estimate={64}
                      render={(thread) => (
                        <SidebarThread
                          id={thread.id}
                          thread={thread.source}
                          viewer={initial.viewer}
                          modelLabel={
                            catalog?.models.find((model) => model.id === thread.source?.modelId)
                              ?.label
                          }
                          selected={selectedId === thread.id && !external}
                          onSelect={select}
                          onRename={(id, title) => setRename({ id, title })}
                          onArchive={(id, archived) => void update(id, { archived })}
                          onDelete={setConfirmDelete}
                        />
                      )}
                    />
                    {threadListError ? (
                      <Button
                        variant="ghost"
                        onClick={() => void listThreads(archived, nextCursor)}
                      >
                        Retry loading conversations
                      </Button>
                    ) : null}
                  </>
                )}
                <footer className="sidebar-footer">
                  {props.userControl ?? (
                    <span className="viewer-name">{initial.viewer.displayName}</span>
                  )}
                  <span className="toolbar-spacer" />
                  <IconButton
                    label="Design system"
                    onClick={() => location.assign("/design-system")}
                  >
                    <Palette />
                  </IconButton>
                  <IconButton label="Settings" onClick={() => setSettings(true)}>
                    <SettingsIcon />
                  </IconButton>
                  <IconButton
                    label="Sign out"
                    onClick={() => void attempt(props.onLogout, setError)}
                  >
                    <LogOut />
                  </IconButton>
                </footer>
              </aside>
            </ResizablePanel>
            <ResizableHandle
              disabled={!sidebar}
              aria-label="Sidebar width"
              className="sidebar-resize-handle"
            />
            <ResizablePanel id="chat" minSize="40%" className="chat-panel">
              <div className="main-panel">
                {external && owner ? (
                  <Suspense fallback={<p role="status">Loading conversations…</p>}>
                    <External key={externalId ?? "list"} initialThreadId={externalId} />
                  </Suspense>
                ) : null}
                {!external && selected ? (
                  <Chat
                    header={
                      <header className="thread-header">
                        <h1>{selected.title || "Untitled"}</h1>
                        {selected.archived ? <span className="badge">Archived</span> : null}
                        <span className="toolbar-spacer" />
                        {owner ? (
                          <IconButton
                            label="Share conversation"
                            tooltip="Share"
                            onClick={() => setSharing(true)}
                          >
                            <Users />
                          </IconButton>
                        ) : null}
                        {selected.capabilities.edit ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <IconButton label="Conversation actions" tooltip="Options">
                                  <MoreHorizontal />
                                </IconButton>
                              }
                            />
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() =>
                                  setRename({ id: selected.id, title: selected.title })
                                }
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
                    }
                    key={selected.id}
                    thread={selected}
                    catalog={catalog}
                    onError={setError}
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
                ) : null}
                {!external && selectedDraft ? (
                  <DraftChat
                    key={selectedDraft}
                    catalog={catalog}
                    threadId={selectedDraft}
                    onChange={(change) => changeLocalDraft(selectedDraft, change)}
                    onSubmit={(submission) => void submitDraft(selectedDraft, submission)}
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
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
          {settings ? (
            <Suspense
              fallback={
                <Modal title="Settings" onClose={() => setSettings(false)}>
                  <p role="status">Loading settings…</p>
                </Modal>
              }
            >
              <Settings
                viewer={initial.viewer}
                onLogout={props.onLogout}
                onClose={() => setSettings(false)}
                agent={identities.agent}
                theme={theme}
                onTheme={setTheme}
              />
            </Suspense>
          ) : null}
          {sharing && owner && selected ? (
            <Suspense
              fallback={
                <Modal title="Share conversation" onClose={() => setSharing(false)}>
                  <p role="status">Loading people…</p>
                </Modal>
              }
            >
              <Sharing key={selected.id} thread={selected} onClose={() => setSharing(false)} />
            </Suspense>
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
                This removes the conversation and makes its files unavailable. Any active run will
                be canceled.
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
        </main>
      </Tooltip.Provider>
    </MessageIdentityContext.Provider>
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
