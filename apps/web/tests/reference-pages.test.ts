import { expect, test } from "bun:test";
import { QueryClient, InfiniteQueryObserver } from "@tanstack/react-query";
import {
  newerReferencePage,
  olderReferencePage,
  updateReferencePages,
  type ReferencePages,
  type ReferencePage,
  type ReferenceCursor,
} from "../src/reference-pages";

const checkpoint = {
  protocolVersion: 1 as const,
  historyGeneration: 0,
  projectionRevision: 1,
  cursor: "revision1",
};
const message = (id: string, position = 0) => ({
  id,
  role: "assistant" as const,
  metadata: { position },
  parts: [{ type: "text" as const, text: id }],
});

test("loading newer reference messages retains the anchor and older history on query refetch", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = (ids: string[], nextCursor?: string, nextAfter?: string): ReferencePage => ({
    title: "Thread",
    messages: ids.map((id) => message(id)),
    messageFound: true,
    nextCursor,
    nextAfter,
    checkpoint,
  });
  const observer = new InfiniteQueryObserver(client, {
    queryKey: ["reference"],
    initialPageParam: undefined as ReferenceCursor,
    queryFn: async ({ pageParam }) => {
      if (!pageParam) return page(["anchor"], "older", "newer");
      if (pageParam.direction === "after") return page(["newer"], "anchor");
      return pageParam.cursor === "anchor"
        ? page(["anchor"], "older", "newer")
        : page(["older"], undefined, "anchor");
    },
    getNextPageParam: olderReferencePage,
    getPreviousPageParam: newerReferencePage,
  });
  const stop = observer.subscribe(() => {});
  await observer.refetch();
  await observer.fetchNextPage();
  await observer.fetchPreviousPage();
  await observer.refetch();
  expect(
    observer
      .getCurrentResult()
      .data?.pages.flatMap((page) => page.messages.map((message) => message.id)),
  ).toEqual(["newer", "anchor", "older"]);
  stop();
  client.clear();
});

test("streaming patches cached reference messages without refetching or replaying text twice", () => {
  const data: ReferencePages = {
    pageParams: [undefined, { cursor: "before", direction: "before" }],
    pages: [
      { title: "Thread", messages: [message("current", 2)], messageFound: true, checkpoint },
      {
        title: "Thread",
        messages: [message("older", 1)],
        nextAfter: "current",
        messageFound: true,
        checkpoint,
      },
    ],
  };
  const update = {
    checkpoint: { ...checkpoint, projectionRevision: 2, cursor: "revision2" },
    changes: [
      {
        kind: "append-text" as const,
        turnId: "turn",
        position: 2,
        messageId: "current",
        partIndex: 0,
        text: " token",
      },
    ],
  };
  const next = updateReferencePages(data, update, 1)!;
  expect(next.pages[0]?.messages[0]?.parts[0]).toEqual({ type: "text", text: "current token" });
  expect(next.pages[1]?.messages[0]).toBe(data.pages[1]?.messages[0]);
  expect(updateReferencePages(next, update, 1)?.pages[0]?.messages[0]?.parts[0]).toEqual({
    type: "text",
    text: "current token",
  });
  expect(
    updateReferencePages(
      data,
      { ...update, checkpoint: { ...update.checkpoint, historyGeneration: 1 } },
      1,
    ),
  ).toBeUndefined();
});
