import "./chat-panels.css";
import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { Button } from "./ui/button";

type Panels = {
  shown: string;
  requested: string;
  visible: boolean;
  ready: boolean;
  revision: number;
};
type RenderPanel = (
  id: string,
  foreground: boolean,
  revision: number,
  onReady: () => void,
  onPrepare: () => void,
) => ReactNode;

export function ChatPanels({ threadId, children }: { threadId: string; children: RenderPanel }) {
  const [panels, setPanels] = useState<Panels>({
    shown: threadId,
    requested: threadId,
    visible: false,
    ready: false,
    revision: 0,
  });
  if (panels.requested !== threadId)
    setPanels({ ...panels, requested: threadId, ready: false, revision: panels.revision + 1 });
  const ids = panels.shown === threadId ? [threadId] : [panels.shown, threadId];
  return (
    <div className="chat-panels" aria-busy={!panels.ready}>
      {!panels.visible ? (
        <p role="status" className="chat-loading">
          Loading conversation…
        </p>
      ) : null}
      {ids.map((id) => (
        <ChatPanel key={id} id={id} panels={panels} setPanels={setPanels}>
          {children}
        </ChatPanel>
      ))}
    </div>
  );
}

function ChatPanel({
  id,
  panels,
  setPanels,
  children,
}: {
  id: string;
  panels: Panels;
  setPanels: Dispatch<SetStateAction<Panels>>;
  children: RenderPanel;
}) {
  const visible = panels.visible && id === panels.shown;
  const foreground = visible && panels.ready && id === panels.requested;
  const revision = panels.revision;
  const onReady = useCallback(
    () =>
      setPanels((current) =>
        current.requested === id && current.revision === revision && !current.ready
          ? { ...current, shown: id, visible: true, ready: true }
          : current,
      ),
    [id, revision, setPanels],
  );
  const onPrepare = useCallback(
    () =>
      setPanels((current) =>
        current.shown === id && current.visible
          ? { ...current, visible: false, ready: false }
          : current,
      ),
    [id, setPanels],
  );
  return (
    <div
      className="chat-buffer"
      data-thread-id={id}
      data-visible={visible}
      inert={!foreground}
      aria-hidden={!visible}
    >
      {children(id, foreground, id === panels.requested ? revision : -1, onReady, onPrepare)}
    </div>
  );
}

export function ChatLoadState({
  message,
  onReady,
  onRetry,
}: {
  message?: string;
  onReady: () => void;
  onRetry: () => void;
}) {
  useEffect(() => {
    if (message) onReady();
  }, [message, onReady]);
  return (
    <div className="chat-loading" role="status">
      <p>{message ?? "Loading conversation…"}</p>
      {message ? (
        <Button variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
