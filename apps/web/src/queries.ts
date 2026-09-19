import { useEffect, useState } from "react";
import {
  infiniteQueryOptions,
  queryOptions,
  skipToken,
  type QueryClient,
} from "@tanstack/react-query";
import type { NativeClient } from "@stanley2058/lilac-client";

export function useNativeOnline(client: NativeClient) {
  const [online, setOnline] = useState(() => !!client.rpc);
  useEffect(
    () =>
      client.subscribe((event) => {
        if (event.kind === "connection") setOnline(event.state === "online");
      }),
    [client],
  );
  return online;
}

export function participantOptions(client: NativeClient, threadId: string) {
  const rpc = client.rpc;
  return queryOptions({
    queryKey: ["participants", threadId],
    queryFn:
      rpc && threadId ? ({ signal }) => rpc.participants.list({ threadId }, { signal }) : skipToken,
  });
}

export function userOptions(client: NativeClient) {
  const rpc = client.rpc;
  return infiniteQueryOptions({
    queryKey: ["users"],
    initialPageParam: undefined as string | undefined,
    queryFn: rpc
      ? ({ pageParam, signal }) => rpc.users.list({ limit: 100, cursor: pageParam }, { signal })
      : skipToken,
    getNextPageParam: (page) => page.nextCursor,
  });
}

export function searchOptions(client: NativeClient, query: string) {
  const rpc = client.rpc;
  return infiniteQueryOptions({
    queryKey: ["search", query],
    staleTime: 0,
    initialPageParam: undefined as string | undefined,
    queryFn:
      rpc && query
        ? ({ pageParam, signal }) =>
            rpc.search.query({ query, limit: 100, cursor: pageParam }, { signal })
        : skipToken,
    getNextPageParam: (page) => page.nextCursor,
  });
}

export function configOptions(client: NativeClient, kind: "core" | "mcp") {
  const rpc = client.rpc;
  return queryOptions({
    queryKey: ["config", kind],
    queryFn: rpc ? ({ signal }) => rpc.config.read({ kind }, { signal }) : skipToken,
    staleTime: 0,
    gcTime: 0,
  });
}

export function externalListOptions(client: NativeClient) {
  const rpc = client.rpc;
  return infiniteQueryOptions({
    queryKey: ["external", "list"],
    initialPageParam: undefined as string | undefined,
    queryFn: rpc
      ? ({ pageParam, signal }) => rpc.external.list({ limit: 100, cursor: pageParam }, { signal })
      : skipToken,
    getNextPageParam: (page) => page.nextCursor,
  });
}

export function externalReadOptions(client: NativeClient, threadId: string | undefined) {
  const rpc = client.rpc;
  return infiniteQueryOptions({
    queryKey: ["external", "read", threadId],
    initialPageParam: undefined as string | undefined,
    queryFn:
      rpc && threadId
        ? ({ pageParam, signal }) => rpc.external.read({ threadId, cursor: pageParam }, { signal })
        : skipToken,
    getNextPageParam: (page) => page.nextCursor,
  });
}

export function queueOptions(client: NativeClient, threadId: string) {
  const rpc = client.rpc;
  return queryOptions({
    queryKey: ["queue", threadId],
    queryFn: rpc ? ({ signal }) => rpc.runs.queue({ threadId }, { signal }) : skipToken,
    staleTime: 0,
  });
}

export async function refreshQueue(queries: QueryClient, threadId: string) {
  const filters = { queryKey: ["queue", threadId], exact: true };
  await queries.cancelQueries(filters);
  await queries.invalidateQueries(filters);
}
