import { useEffect, useRef, useState } from "react";
import { RefreshCw, ArrowLeft } from "lucide-react";
import type { NativeClient } from "@stanley2058/lilac-client";
import type { NativeRpcOutputs } from "@stanley2058/lilac-client-protocol";
import { attempt, ErrorNotice, IconButton, VirtualList } from "./ui";
import { mergeExternalPage } from "../external-pages";
import { Message } from "./Timeline";
import { Button } from "./ui/button";

type ExternalThread = NativeRpcOutputs["external"]["list"]["items"][number];
export function External({
  client,
  resourceUrl,
  initialThreadId,
}: {
  client: NativeClient;
  resourceUrl: (id: string) => string;
  initialThreadId?: string;
}) {
  const [threads, setThreads] = useState<ExternalThread[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [view, setView] = useState<NativeRpcOutputs["external"]["read"]>();
  const [error, setError] = useState<string>();
  const readSequence = useRef(0);
  async function list(cursor?: string) {
    if (!client.rpc) return;
    const result = await attempt(() => client.rpc!.external.list({ limit: 100, cursor }), setError);
    if (result) {
      setThreads((items) => (cursor ? [...items, ...result.items] : result.items));
      setNextCursor(result.nextCursor);
    }
  }
  async function read(threadId: string, cursor?: string) {
    if (!client.rpc) return;
    const sequence = ++readSequence.current;
    const result = await attempt(
      () => client.rpc!.external.read({ threadId, cursor }),
      (message) => {
        if (readSequence.current === sequence) setError(message);
      },
    );
    if (result && readSequence.current === sequence)
      setView((previous) => mergeExternalPage(previous, result, !!cursor));
  }
  useEffect(
    () => () => {
      readSequence.current++;
    },
    [],
  );
  useEffect(() => {
    if (initialThreadId) {
      void read(initialThreadId);
      return;
    }
    void list();
  }, [client, initialThreadId]);
  return (
    <section className="external-view">
      <header className="thread-header">
        {view ? (
          <IconButton
            label="Back to external conversations"
            onClick={() => {
              readSequence.current++;
              setView(undefined);
              void list();
            }}
          >
            <ArrowLeft />
          </IconButton>
        ) : null}
        <h1>{view?.thread.title ?? "Other surfaces"}</h1>
        <span className="badge">Read-only</span>
        {view ? (
          <time
            className="retrieved-time"
            dateTime={new Date(view.thread.retrievedAt).toISOString()}
          >
            Retrieved {new Date(view.thread.retrievedAt).toLocaleString()}
          </time>
        ) : null}
        <span className="toolbar-spacer" />
        <IconButton
          label="Refresh external conversation"
          onClick={() => {
            if (view) void read(view.thread.id);
            else void list();
          }}
        >
          <RefreshCw />
        </IconButton>
      </header>
      <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
      {view ? (
        <>
          <VirtualList
            items={view.messages}
            itemKey={(message) => message.id}
            label="External conversation"
            className="external-messages"
            estimate={160}
            render={(message) => (
              <Message
                message={message}
                canEdit={false}
                resourceUrl={resourceUrl}
                onAction={() => {}}
                onReaction={() => {}}
              />
            )}
          />
          {view.nextCursor ? (
            <Button
              variant="ghost"
              className="text-button"
              onClick={() => void read(view.thread.id, view.nextCursor)}
            >
              {view.thread.surface === "discord" ? "Load older messages" : "Load more messages"}
            </Button>
          ) : null}
        </>
      ) : (
        <>
          <VirtualList
            items={threads}
            itemKey={(thread) => thread.id}
            label="External conversations"
            className="external-thread-list"
            render={(thread) => (
              <Button
                type="button"
                variant="ghost"
                className="external-thread h-auto"
                onClick={() => void read(thread.id)}
              >
                <span>{thread.title}</span>
                <span className="badge">{thread.surface}</span>
              </Button>
            )}
          />
          {nextCursor ? (
            <Button variant="ghost" className="text-button" onClick={() => void list(nextCursor)}>
              Load more conversations
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
