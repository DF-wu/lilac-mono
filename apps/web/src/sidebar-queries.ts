import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import type { NativeClient } from "@stanley2058/lilac-client";
import type { SidebarSection } from "@stanley2058/lilac-client-protocol";
export function sidebarOptions(client: NativeClient, section: SidebarSection, online: boolean) {
  return infiniteQueryOptions({
    queryKey: ["sidebar", section],
    enabled: online,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      client.rpc!.sidebar.list({ section, cursor: pageParam, limit: 100 }, { signal }),
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}
export function settledCountOptions(client: NativeClient, online: boolean) {
  return queryOptions({
    queryKey: ["sidebar", "settled", "count"],
    enabled: online,
    queryFn: ({ signal }) => client.rpc!.sidebar.list({ section: "settled", limit: 0 }, { signal }),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}
export async function refreshSidebar(queries: QueryClient) {
  await queries.cancelQueries({ queryKey: ["sidebar"] });
  await queries.invalidateQueries({ queryKey: ["sidebar"] });
}
