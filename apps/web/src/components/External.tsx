import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { externalListOptions, externalReadOptions, useNativeOnline } from "../queries";
import { RefreshCw, ArrowLeft } from "lucide-react";
import type { NativeClient } from "@stanley2058/lilac-client";
import { ErrorNotice, IconButton, VirtualList } from "./ui";
import { mergeExternalPage, type ExternalPage } from "../external-pages";
import { Message } from "./Timeline";
import { Button } from "./ui/button";

export function External({
  client,
  resourceUrl,
  initialThreadId,
}: {
  client: NativeClient;
  resourceUrl: (id: string) => string;
  initialThreadId?: string;
}) {
  const [threadId, setThreadId] = useState(initialThreadId);
  const online = useNativeOnline(client);
  const list = useInfiniteQuery({ ...externalListOptions(client), enabled: online && !threadId });
  const read = useInfiniteQuery({
    ...externalReadOptions(client, threadId),
    enabled: online && !!threadId,
  });
  const threads = list.data?.pages.flatMap((page) => page.items) ?? [];
  const view = read.data?.pages.reduce<ExternalPage | undefined>(
    (previous, page) => mergeExternalPage(previous, page, true),
    undefined,
  );
  const error = threadId ? read.error : list.error;
  return (
    <section className="external-view">
      <header className="thread-header">
        {threadId ? (
          <IconButton label="Back to external conversations" onClick={() => setThreadId(undefined)}>
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
            if (threadId) void read.refetch();
            else void list.refetch();
          }}
        >
          <RefreshCw />
        </IconButton>
      </header>
      <ErrorNotice message={error?.message} />
      {threadId && !view ? (
        <p role="status">
          {read.isFetching ? "Loading conversation…" : "Conversation unavailable"}
        </p>
      ) : null}
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
          {read.hasNextPage ? (
            <Button
              variant="ghost"
              className="text-button"
              disabled={read.isFetching}
              onClick={() => {
                if (!read.isFetching) void read.fetchNextPage({ cancelRefetch: false });
              }}
            >
              {view.thread.surface === "discord" ? "Load older messages" : "Load more messages"}
            </Button>
          ) : null}
        </>
      ) : null}
      {!threadId ? (
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
                onClick={() => setThreadId(thread.id)}
              >
                <span>{thread.title}</span>
                <span className="badge">{thread.surface}</span>
              </Button>
            )}
          />
          {list.hasNextPage ? (
            <Button
              variant="ghost"
              className="text-button"
              disabled={list.isFetching}
              onClick={() => {
                if (!list.isFetching) void list.fetchNextPage({ cancelRefetch: false });
              }}
            >
              Load more conversations
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
