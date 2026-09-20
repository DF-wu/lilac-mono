import { useLocation, useNavigate, useMatch, useRouter } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { profileOptions, searchOptions, threadOptions, useNativeOnline } from "./queries";
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
import { ChatPanels, ChatLoadState } from "./components/ChatPanels";
import { Chat, type Draft, type PendingInput } from "./components/Chat";
import { Settings } from "./components/Settings";
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
  const navigate = useNavigate();
  const router = useRouter();
  const active = useMatch({ from: "/chat", shouldThrow: false, select: () => true }) ?? false;
  const routeThreadId = useMatch({
    from: "/chat/threads/$threadId",
    shouldThrow: false,
    select: (match) => match.params.threadId,
  });
  const routeDraftId = useLocation({ select: (location) => location.state.draftThreadId });
  const { pool, drafts: draftStore } = useWorkspace();
  const draftIds = useStore(draftStore, (state) => state.ids);
  const setLocalDrafts = draftStore.getState().setLocalDrafts;
  const { client, initial } = props;
  const online = useNativeOnline(client);
  const profile = useQuery({ ...profileOptions(client), enabled: online });
  const viewer = profile.data ?? initial.viewer;
  const [threads, setThreads] = useState(initial.threads.items);
  const [nextCursor, setNextCursor] = useState(initial.threads.nextCursor);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [threadListError, setThreadListError] = useState(false);
  const threadListRequest = useRef({ loading: false });
  const [firstDraft] = useState(() => draftStore.getState().localDrafts.values().next().value!);
  const removedDrafts = useRef(new Set<string>());
  const routeSelection =
    routeThreadId ?? routeDraftId ?? initial.threads.items[0]?.id ?? firstDraft.id;
  const [lastSelectedId, setLastSelectedId] = useState(routeSelection);
  if (active && lastSelectedId !== routeSelection) setLastSelectedId(routeSelection);
  const selectedId = active ? routeSelection : lastSelectedId;
  useEffect(() => {
    if (!active || routeThreadId || routeDraftId) return;
    if (selectedId.startsWith("draft:")) {
      void navigate({ to: "/", state: { draftThreadId: selectedId }, replace: true });
      return;
    }
    void navigate({ to: "/threads/$threadId", params: { threadId: selectedId }, replace: true });
  }, [active, routeThreadId, routeDraftId, selectedId, navigate]);
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
  const [sidebarPixels, setSidebarPixels] = useState(288);
  const [sidebarSliding, setSidebarSliding] = useState(false);
  const panelGroup = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sidebarSliding) return;
    let canceled = false;
    const animations = panelGroup.current?.getAnimations() ?? [];
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (!canceled) setSidebarSliding(false);
    });
    return () => {
      canceled = true;
    };
  }, [sidebar, sidebarSliding]);
  const [searchQuery, setSearchQuery] = useState("");
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
  useEffect(() => {
    if (active) return;
    setSettings(false);
    setSharing(false);
    setRename(undefined);
    setConfirmDelete(undefined);
  }, [active]);
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
  const selected = threads.find((thread) => thread.id === selectedId);
  const owner = viewer.role === "owner";
  const activeRef = useRef(active);
  activeRef.current = active;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const archivedRef = useRef(archived);
  archivedRef.current = archived;

  const identities = useMemo(
    () => ({
      agent: catalog?.agent ?? { displayName: "Lilac" },
      viewerId: viewer.id,
      users: new Map([
        [viewer.id, { displayName: viewer.displayName, avatarUrl: viewer.avatarUrl }],
      ]),
    }),
    [catalog?.agent, viewer],
  );
  useEffect(() => {
    setExternal(false);
  }, [selectedId]);
  const [loadedThreadId, setLoadedThreadId] = useState<string>();
  const [draftsHydrated, setDraftsHydrated] = useState(!props.draftCache);
  const routeDraftExists = useStore(
    draftStore,
    (state) => !routeDraftId || state.localDrafts.has(routeDraftId),
  );
  useEffect(() => {
    const cache = props.draftCache;
    if (!cache) return;
    let canceled = false;
    void attempt(() => cache.listLocalDrafts(props.scope), setError).then((saved) => {
      if (canceled) return;
      setDraftsHydrated(true);
      if (!saved) return;
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
    });
    return () => {
      canceled = true;
    };
  }, [props.draftCache, props.scope]);
  useEffect(() => {
    if (!active || !draftsHydrated || !routeDraftId || routeDraftExists) return;
    const changed = new Map(draftStore.getState().localDrafts);
    const draft = restoreDraftThread(changed, { draftThreadId: routeDraftId });
    changed.set(draft.id, draft);
    setLocalDrafts(changed);
    void navigate({ to: "/", state: { draftThreadId: draft.id }, replace: true });
  }, [
    active,
    draftsHydrated,
    routeDraftId,
    routeDraftExists,
    draftStore,
    setLocalDrafts,
    navigate,
  ]);

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
            queries.setQueryData(["profile"], event.bootstrap.viewer);
            void queries.invalidateQueries({ queryKey: ["participants"] });
            void queries.invalidateQueries({ queryKey: ["users"] });
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
            if (activeRef.current && selectedRef.current === event.threadId) createThread();
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
    if (!selectedId || selectedId.startsWith("draft:")) return;
    let canceled = false;
    void client.selectThread(selectedId).then(() => {
      if (!canceled) setLoadedThreadId(selectedId);
    });
    return () => {
      canceled = true;
    };
  }, [client, selectedId]);
  const selectedMetadata = useQuery({
    ...threadOptions(client, selectedId ?? ""),
    enabled: online && !!selectedId && !selectedId.startsWith("draft:") && !selected,
  });
  useEffect(() => {
    if (selectedMetadata.data && !selected) upsert(selectedMetadata.data);
  }, [selectedMetadata.data, !!selected, upsert]);
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
    setExternal(false);
    if (id.startsWith("draft:")) {
      void navigate({ to: "/", state: { draftThreadId: id } });
      return;
    }
    void navigate({ to: "/threads/$threadId", params: { threadId: id } });
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
  function finishDraftNavigation(draftId: string, threadId: string) {
    if (selectedRef.current !== draftId) return;
    if (activeRef.current) {
      select(threadId);
      return;
    }
    const location = router.state.location;
    if (location.pathname !== "/design-system" || location.state.draftThreadId !== draftId) return;
    void navigate({ to: "/design-system", state: { chatThreadId: threadId }, replace: true });
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
    finishDraftNavigation(id, created.id);
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
    if (id.startsWith("draft:")) {
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
    if (id.startsWith("draft:")) {
      removeLocalDraft(id);
      setConfirmDelete(undefined);
      if (activeRef.current && selectedRef.current === id) createThread();
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
    if (activeRef.current && selectedRef.current === id) createThread();
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
          style={
            {
              "--sidebar-panel-width": `${sidebarPixels}px`,
              "--sidebar-offset": `${sidebarPixels + 1}px`,
            } as CSSProperties
          }
          aria-label="Chat workspace"
        >
          <div className="sidebar-toggle">
            <IconButton
              label={sidebar ? "Hide sidebar" : "Show sidebar"}
              onClick={() => {
                setSidebarSliding(true);
                setSidebar((value) => !value);
              }}
            >
              {sidebar ? <PanelLeftClose /> : <PanelLeftOpen />}
            </IconButton>
          </div>
          <ResizablePanelGroup
            orientation="horizontal"
            className="workspace-panels"
            elementRef={panelGroup}
            data-sidebar-fixed={!sidebar || sidebarSliding}
            style={{ width: "var(--workspace-width, 100%)" }}
          >
            <ResizablePanel
              inert={!sidebar}
              aria-hidden={!sidebar}
              onResize={(size) => {
                if (sidebar && !sidebarSliding && size.inPixels > 0)
                  setSidebarPixels(size.inPixels);
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
                          viewer={viewer}
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
                  {props.userControl ?? <span className="viewer-name">{viewer.displayName}</span>}
                  <span className="toolbar-spacer" />
                  <IconButton
                    label="Design system"
                    onClick={() =>
                      void navigate({
                        to: "/design-system",
                        state: selectedId.startsWith("draft:")
                          ? { draftThreadId: selectedId }
                          : { chatThreadId: selectedId },
                      })
                    }
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
              disabled={!sidebar || sidebarSliding}
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
                {!external && selectedId ? (
                  <ChatPanels threadId={selectedId}>
                    {(id, foreground, revision, onReady, onPrepare) => {
                      if (id.startsWith("draft:"))
                        return (
                          <DraftChat
                            threadId={id}
                            foreground={foreground && active}
                            displayRevision={revision}
                            onPrepare={onPrepare}
                            onReady={onReady}
                            catalog={catalog}
                            onChange={(change) => changeLocalDraft(id, change)}
                            onSubmit={(submission) => void submitDraft(id, submission)}
                          />
                        );
                      const thread = threads.find((entry) => entry.id === id);
                      if (!thread)
                        return (
                          <ChatLoadState
                            message={
                              selectedMetadata.error?.message ??
                              (!online
                                ? "This conversation is unavailable while offline."
                                : undefined)
                            }
                            onReady={onReady}
                            onRetry={() => {
                              void selectedMetadata.refetch();
                            }}
                          />
                        );
                      return (
                        <Chat
                          foreground={foreground && active}
                          displayRevision={revision}
                          onPrepare={onPrepare}
                          onReady={onReady}
                          cacheLoaded={loadedThreadId === id}
                          header={
                            <header className="thread-header">
                              <h1>{thread.title || "Untitled"}</h1>
                              {thread.archived ? <span className="badge">Archived</span> : null}
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
                              {thread.capabilities.edit ? (
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
                                        setRename({ id: thread.id, title: thread.title })
                                      }
                                    >
                                      <Pencil />
                                      Rename
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() =>
                                        void update(thread.id, { archived: !thread.archived })
                                      }
                                    >
                                      {thread.archived ? <ArchiveRestore /> : <Archive />}
                                      {thread.archived ? "Unarchive" : "Archive"}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      variant="destructive"
                                      onClick={() => setConfirmDelete(thread.id)}
                                    >
                                      <Trash2 />
                                      Delete
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              ) : null}
                            </header>
                          }
                          key={thread.id}
                          thread={thread}
                          catalog={catalog}
                          onError={setError}
                          readTurns={readTurns.current}
                          draft={
                            drafts.current.get(id) ?? { text: "", skillIds: [], attachments: [] }
                          }
                          onDraft={(value) => {
                            drafts.current.set(thread.id, value);
                          }}
                          pending={pending.current.get(thread.id) ?? []}
                          onPending={(change) => {
                            patchPending(thread.id, change);
                          }}
                        />
                      );
                    }}
                  </ChatPanels>
                ) : null}
                {!external && !selectedId ? (
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
            <Settings
              viewer={viewer}
              onLogout={props.onLogout}
              onClose={() => setSettings(false)}
              agent={identities.agent}
              theme={theme}
              onTheme={setTheme}
            />
          ) : null}
          {sharing && owner && selected ? (
            <Modal title="Share conversation" onClose={() => setSharing(false)}>
              <Suspense fallback={<p role="status">Loading people…</p>}>
                <Sharing key={selected.id} thread={selected} />
              </Suspense>
            </Modal>
          ) : null}
          <Modal open={!!rename} title="Rename conversation" onClose={() => setRename(undefined)}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (rename) void update(rename.id, { title: rename.title });
              }}
            >
              <Input
                className="wide-input"
                autoFocus
                aria-label="Conversation name"
                value={rename?.title ?? ""}
                onChange={(event) => {
                  if (rename) setRename({ ...rename, title: event.target.value });
                }}
                maxLength={512}
              />
              <div className="dialog-actions">
                <Button className="button primary" type="submit">
                  Rename
                </Button>
              </div>
            </form>
          </Modal>
          <Modal
            open={!!confirmDelete}
            title="Delete conversation?"
            onClose={() => setConfirmDelete(undefined)}
          >
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
