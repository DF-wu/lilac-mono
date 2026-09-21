import { useWorkspace } from "../workspace-context";
import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { externalListOptions, externalReadOptions, useNativeOnline } from "../queries";
import { RefreshCw, ArrowLeft } from "lucide-react";
import { ErrorNotice, IconButton, VirtualList } from "./ui";
import { mergeExternalPage, type ExternalPage } from "../external-pages";
import { Message } from "./Timeline";
import { Button } from "./ui/button";

export function External({ initialThreadId }: { initialThreadId?: string }) {
  const { client, resourceUrl } = useWorkspace();
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
    <section className="external-view flex flex-1 min-h-0 flex-col">
      <header className="thread-header flex items-center gap-2 h-8 min-h-0 px-6 py-0.5 [&_h1]:truncate [&_.icon-button]:size-[var(--ui-control-compact)] max-workspace:gap-1 max-workspace:pl-15 group-[.sidebar-hidden]/workspace:pl-15 group-[.right-panel-hidden]/workspace:pr-[calc(var(--ui-space-unit)*5+var(--ui-control-compact))]">
        {threadId ? (
          <IconButton label="Back to external conversations" onClick={() => setThreadId(undefined)}>
            <ArrowLeft />
          </IconButton>
        ) : null}
        <h1>{view?.thread.title ?? "Other surfaces"}</h1>
        <span className="badge inline-flex items-center gap-1 bg-surface-hover text-muted-foreground rounded-sm py-1 px-2 text-xs whitespace-nowrap">
          Read-only
        </span>
        {view ? (
          <time
            className="retrieved-time text-xs text-muted-foreground whitespace-nowrap"
            dateTime={new Date(view.thread.retrievedAt).toISOString()}
          >
            Retrieved {new Date(view.thread.retrievedAt).toLocaleString()}
          </time>
        ) : null}
        <span className="toolbar-spacer flex-1" />
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
              className="text-primary py-2 px-3 text-sm"
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
                className="external-thread flex w-full gap-3 justify-between py-4 px-6 text-left h-auto"
                onClick={() => setThreadId(thread.id)}
              >
                <span>{thread.title}</span>
                <span className="badge inline-flex items-center gap-1 bg-surface-hover text-muted-foreground rounded-sm py-1 px-2 text-xs whitespace-nowrap">
                  {thread.surface}
                </span>
              </Button>
            )}
          />
          {list.hasNextPage ? (
            <Button
              variant="ghost"
              className="text-primary py-2 px-3 text-sm"
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
