import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { DisplayMessage } from "@stanley2058/lilac-client-protocol";
import { Message } from "./Timeline";
import { Skeleton } from "./ui/skeleton";

function noop() {}

export function ExternalMessages({
  messages,
  resourceUrl,
  loadDirection,
  hasMore,
  loading,
  onLoadMore,
}: {
  messages: readonly DisplayMessage[];
  resourceUrl: (id: string) => string;
  loadDirection: "start" | "end";
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const [positioning, setPositioning] = useState(0);
  const getItemKey = useCallback((index: number) => messages[index]!.id, [messages]);
  const virtual = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: messages.length,
    getItemKey,
    getScrollElement: () => parent.current,
    estimateSize: () => 160,
    overscan: 3,
    anchorTo: "end",
    followOnAppend: true,
    // Measure the tail before positioning the normal virtual window at the bottom.
    rangeExtractor: (range) => {
      if (positioning > 0) return defaultRangeExtractor(range);
      const tail: number[] = [];
      for (let index = Math.max(0, range.count - 5); index < range.count; index++) tail.push(index);
      return tail;
    },
  });
  useLayoutEffect(() => {
    if (positioning >= 2) return;
    virtual.scrollToEnd();
    setPositioning((value) => value + 1);
  });
  const total = virtual.getTotalSize();
  const offset = virtual.scrollOffset ?? 0;
  const remaining = total - offset - (virtual.scrollRect?.height ?? 0);
  const nearEdge = loadDirection === "start" ? offset < 160 : remaining < 160;
  const loadMore = useEffectEvent(onLoadMore);
  useEffect(() => {
    if (positioning < 2 || !nearEdge || !hasMore || loading) return;
    const viewport = parent.current;
    if (!viewport) return;
    const distance =
      loadDirection === "start"
        ? viewport.scrollTop
        : viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distance < 160) loadMore();
  }, [positioning, nearEdge, hasMore, loading, messages.length, loadDirection]);
  return (
    <div className="relative flex flex-1 min-h-0 flex-col">
      <div
        ref={parent}
        className="external-messages overflow-auto min-h-0 flex-1 relative [overflow-anchor:none]"
        role="log"
        aria-label="External conversation"
        aria-busy={loading || undefined}
      >
        <div className="relative w-full" style={{ height: total }}>
          {virtual.getVirtualItems().map((row) => (
            <div
              key={row.key}
              ref={virtual.measureElement}
              data-index={row.index}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              <Message
                message={messages[row.index]!}
                canEdit={false}
                resourceUrl={resourceUrl}
                onAction={noop}
                onReaction={noop}
              />
            </div>
          ))}
        </div>
      </div>
      {loading ? (
        <div
          className="absolute top-0 inset-x-0 px-6 py-1 pointer-events-none"
          role="status"
          aria-label="Loading messages"
        >
          <Skeleton className="h-2 w-full" />
        </div>
      ) : null}
    </div>
  );
}
