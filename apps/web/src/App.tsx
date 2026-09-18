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
} from "lucide-react";
import type {
  DisplayCatalog,
  NativeThread,
  NativeRpcOutputs,
} from "@stanley2058/lilac-client-protocol";
import type { AppProps } from "./types";
import { UploadPool } from "./uploads";
import { Chat, type Draft, type PendingInput } from "./components/Chat";
import { Settings } from "./components/Settings";
import { Sharing } from "./components/Sharing";
import { External } from "./components/External";
import { attempt, ErrorNotice, IconButton, Modal, VirtualList } from "./components/ui";
import "./styles.css";

export type { AppProps } from "./types";
export function App(props: AppProps) {
  const { client, initial } = props;
  const [threads, setThreads] = useState(initial.threads.items);
  const [nextCursor, setNextCursor] = useState(initial.threads.nextCursor);
  const [selectedId, setSelectedId] = useState(
    props.initialThreadId ?? initial.threads.items[0]?.id,
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
  const [rename, setRename] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [theme, setTheme] = useState(() => readTheme());
  const drafts = useRef(new Map<string, Draft>());
  const pending = useRef(new Map<string, PendingInput[]>());
  const positions = useRef(new Map<string, number>());
  const readTurns = useRef(new Map<string, string>());
  const pool = useMemo(() => new UploadPool(client, props.upload), [client, props.upload]);
  const selected = threads.find((thread) => thread.id === selectedId);
  const owner = initial.viewer.role === "owner";
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const archivedRef = useRef(archived);
  archivedRef.current = archived;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const saved = Result.try({
      try: () => localStorage.setItem("lilac-theme-v1", theme),
      catch: () => "Storage unavailable",
    });
    saved.match({ ok: () => {}, err: () => {} });
  }, [theme]);
  useEffect(() => () => pool.dispose(), [pool]);
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
    if (selectedId) void client.selectThread(selectedId);
  }, [client, selectedId]);
  useEffect(() => {
    const rpc = client.rpc;
    if (!selectedId || selected || !rpc) return;
    let canceled = false;
    void attempt(() => rpc.threads.get({ threadId: selectedId }), setError).then((thread) => {
      if (thread && !canceled) upsert(thread);
    });
    return () => {
      canceled = true;
    };
  }, [client, selectedId, !!selected, connection, upsert]);
  useEffect(() => {
    const pop = () => {
      const id = new URL(window.location.href).searchParams.get("thread");
      setSelectedId(id ?? undefined);
      setExternal(false);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  function select(id: string) {
    setSelectedId(id);
    setExternal(false);
    const url = new URL(window.location.href);
    url.searchParams.set("thread", id);
    history.pushState({}, "", url);
  }
  async function createThread() {
    if (!client.rpc) return;
    const created = await attempt(
      () =>
        client.rpc!.threads.create({ commandId: crypto.randomUUID(), title: "New conversation" }),
      setError,
    );
    if (created) {
      upsert(created);
      select(created.id);
      setArchived(false);
    }
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
  async function update(change: { title?: string; archived?: boolean }) {
    if (!client.rpc || !selected) return;
    const revision = client.thread(selected.id).checkpoint?.projectionRevision ?? selected.revision;
    const changed = await attempt(
      () =>
        client.rpc!.threads.update({
          threadId: selected.id,
          expectedRevision: revision,
          ...change,
        }),
      setError,
    );
    if (changed) {
      upsert(changed);
      setRename(undefined);
    }
  }
  async function deleteThread() {
    if (!client.rpc || !selected) return;
    const checkpoint = client.thread(selected.id).checkpoint;
    if (!checkpoint) return;
    const deleted = await attempt(
      () =>
        client.rpc!.threads.delete({
          threadId: selected.id,
          commandId: crypto.randomUUID(),
          historyGeneration: checkpoint.historyGeneration,
        }),
      setError,
    );
    if (deleted) {
      setThreads((items) => items.filter((item) => item.id !== selected.id));
      setSelectedId(undefined);
      setConfirmDelete(false);
      const url = new URL(location.href);
      url.searchParams.delete("thread");
      history.replaceState({}, "", url);
    }
  }
  const draft = selectedId
    ? (drafts.current.get(selectedId) ?? { text: "", skillIds: [], attachments: [] })
    : { text: "", skillIds: [], attachments: [] };
  return (
    <Tooltip.Provider delay={350}>
      <div className={`app-shell ${sidebar ? "" : "sidebar-hidden"}`}>
        {sidebar ? (
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
              <IconButton label="Hide sidebar" onClick={() => setSidebar(false)}>
                <PanelLeftClose />
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
              <input
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  if (!event.target.value) setResults(undefined);
                }}
                aria-label="Search conversations"
                placeholder="Search conversations"
              />
              <button type="submit" className="sr-only">
                Search
              </button>
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
                    <button
                      type="button"
                      className="search-result"
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
                    </button>
                  )}
                />
                {results.items.length === 0 && !searching ? (
                  <p className="muted empty-list">No results</p>
                ) : null}
                {results.nextCursor ? (
                  <button className="text-button" onClick={() => void search(results.nextCursor)}>
                    More results
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <VirtualList
                  items={threads.filter((thread) => thread.archived === archived)}
                  itemKey={(thread) => thread.id}
                  label="Conversations"
                  className="thread-list"
                  render={(thread) => (
                    <button
                      type="button"
                      className={`thread-row ${selectedId === thread.id && !external ? "selected" : ""}`}
                      onClick={() => select(thread.id)}
                    >
                      <MessageSquare />
                      <span>{thread.title || "Untitled"}</span>
                      {!thread.capabilities.edit ? <span className="badge">Read</span> : null}
                    </button>
                  )}
                />
                {nextCursor ? (
                  <button
                    className="text-button"
                    onClick={() => void listThreads(archived, nextCursor)}
                  >
                    More conversations
                  </button>
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
              <IconButton label="Sign out" onClick={() => void attempt(props.onLogout, setError)}>
                <LogOut />
              </IconButton>
            </footer>
          </aside>
        ) : null}
        <main className="main-panel">
          {!sidebar ? (
            <div className="sidebar-toggle">
              <IconButton label="Show sidebar" onClick={() => setSidebar(true)}>
                <PanelLeftOpen />
              </IconButton>
            </div>
          ) : null}
          {connection !== "online" ? (
            <div className="connection-notice" role="status">
              <WifiOff />
              {connection === "connecting"
                ? "Connecting…"
                : "Offline. Cached conversations remain available."}
            </div>
          ) : null}
          <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
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
                  <>
                    <IconButton
                      label="Rename conversation"
                      onClick={() => setRename(selected.title)}
                    >
                      <Pencil />
                    </IconButton>
                    <IconButton
                      label={selected.archived ? "Unarchive conversation" : "Archive conversation"}
                      onClick={() => void update({ archived: !selected.archived })}
                    >
                      {selected.archived ? <ArchiveRestore /> : <Archive />}
                    </IconButton>
                    <IconButton label="Delete conversation" onClick={() => setConfirmDelete(true)}>
                      <Trash2 />
                    </IconButton>
                  </>
                ) : null}
              </header>
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
                  pending.current.set(selected.id, change(pending.current.get(selected.id) ?? []));
                }}
              />
            </>
          ) : null}
          {!external && !selected ? (
            <div className="welcome">
              <span className="brand">
                lilac
                <span />
              </span>
              <button className="button primary" onClick={() => void createThread()}>
                <Plus />
                New conversation
              </button>
            </div>
          ) : null}
        </main>
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
                void update({ title: rename });
              }}
            >
              <input
                className="wide-input"
                autoFocus
                aria-label="Conversation name"
                value={rename}
                onChange={(event) => setRename(event.target.value)}
                maxLength={512}
              />
              <div className="dialog-actions">
                <button className="button primary" type="submit">
                  Rename
                </button>
              </div>
            </form>
          </Modal>
        ) : null}
        {confirmDelete ? (
          <Modal title="Delete conversation?" onClose={() => setConfirmDelete(false)}>
            <p>
              This removes the conversation and makes its files unavailable. Any active run will be
              canceled.
            </p>
            <div className="dialog-actions">
              <button className="button" onClick={() => setConfirmDelete(false)}>
                Keep conversation
              </button>
              <button className="button danger" onClick={() => void deleteThread()}>
                Delete
              </button>
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
