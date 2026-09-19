import { expect, test } from "bun:test";
import { InfiniteQueryObserver, QueryObserver, QueryClient } from "@tanstack/react-query";
import { NativeClient } from "@stanley2058/lilac-client";
import type { NativeRpcOutputs } from "@stanley2058/lilac-client-protocol";
import {
  participantOptions,
  searchOptions,
  userOptions,
  queueOptions,
  refreshQueue,
} from "../src/queries";

type Rpc = NonNullable<NativeClient["rpc"]>;
function clientWith(rpc: {
  search?: Pick<Rpc["search"], "query">;
  participants?: Pick<Rpc["participants"], "list">;
  users?: Pick<Rpc["users"], "list">;
  runs?: Pick<Rpc["runs"], "queue">;
}) {
  const client = new NativeClient({
    scope: {
      installationId: "fixture",
      principalId: "owner",
      protocolVersion: 1,
      projectionVersion: 1,
    },
    openSocket: () => {
      throw new Error("No socket needed for query fixtures");
    },
    bootstrap: async () => {
      throw new Error("No bootstrap needed for query fixtures");
    },
  });
  Object.defineProperty(client, "rpc", { get: () => rpc });
  return client;
}
function cache() {
  return new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } });
}

test("participant consumers share one request and invalidation refreshes the shared entry", async () => {
  let requests = 0;
  const pending = Promise.withResolvers<NativeRpcOutputs["participants"]["list"]>();
  const client = clientWith({
    participants: {
      list: async () => {
        requests++;
        return pending.promise;
      },
    },
  });
  const queries = cache();
  const first = queries.fetchQuery(participantOptions(client, "thread"));
  const second = queries.fetchQuery(participantOptions(client, "thread"));
  pending.resolve({ items: [] });
  await Promise.all([first, second]);
  expect(requests).toBe(1);
  await queries.fetchQuery(participantOptions(client, "thread"));
  expect(requests).toBe(1);
  await queries.invalidateQueries({ queryKey: ["participants", "thread"] });
  await queries.fetchQuery(participantOptions(client, "thread"));
  expect(requests).toBe(2);
  queries.clear();
});

test("switching and clearing searches aborts obsolete requests and keeps late results out of the active view", async () => {
  const first = Promise.withResolvers<NativeRpcOutputs["search"]["query"]>();
  const second = Promise.withResolvers<NativeRpcOutputs["search"]["query"]>();
  const signals: AbortSignal[] = [];
  const client = clientWith({
    search: {
      query: async ({ query }, options) => {
        if (options?.signal) signals.push(options.signal);
        return query === "first" ? first.promise : second.promise;
      },
    },
  });
  const queries = cache();
  const observer = new InfiniteQueryObserver(queries, searchOptions(client, "first"));
  const stop = observer.subscribe(() => {});
  observer.setOptions(searchOptions(client, "second"));
  expect(signals[0]?.aborted).toBe(true);
  second.resolve({ items: [], nextCursor: "second-page" });
  await queries.fetchInfiniteQuery(searchOptions(client, "second"));
  first.resolve({ items: [], nextCursor: "obsolete-page" });
  await first.promise;
  expect(observer.getCurrentResult().data?.pages[0]?.nextCursor).toBe("second-page");
  observer.setOptions({ ...searchOptions(client, ""), enabled: false });
  expect(observer.getCurrentResult().data).toBeUndefined();
  stop();
  queries.clear();
});

test("infinite people queries deduplicate concurrent page requests and carry the returned cursor", async () => {
  const cursors: (string | undefined)[] = [];
  const next = Promise.withResolvers<NativeRpcOutputs["users"]["list"]>();
  const client = clientWith({
    users: {
      list: async ({ cursor }) => {
        cursors.push(cursor);
        return cursor ? next.promise : { items: [], nextCursor: "more" };
      },
    },
  });
  const queries = cache();
  const options = userOptions(client);
  await queries.fetchInfiniteQuery(options);
  const observer = new InfiniteQueryObserver(queries, options);
  const stop = observer.subscribe(() => {});
  const first = observer.fetchNextPage({ cancelRefetch: false });
  const duplicate = observer.fetchNextPage({ cancelRefetch: false });
  next.resolve({ items: [] });
  await Promise.all([first, duplicate]);
  expect(cursors).toEqual([undefined, "more"]);
  expect(observer.getCurrentResult().data?.pages.length).toBe(2);
  expect(observer.getCurrentResult().hasNextPage).toBe(false);
  stop();
  queries.clear();
});

test("resubmitted searches fetch current results even within the ordinary cache freshness window", async () => {
  let requests = 0;
  const client = clientWith({
    search: { query: async () => ({ items: [], nextCursor: String(++requests) }) },
  });
  const queries = cache();
  const first = await queries.fetchInfiniteQuery(searchOptions(client, "same"));
  const second = await queries.fetchInfiniteQuery(searchOptions(client, "same"));
  expect(first.pages[0]?.nextCursor).toBe("1");
  expect(second.pages[0]?.nextCursor).toBe("2");
  queries.clear();
});

test("queue events during initial loading replace the obsolete request", async () => {
  const pending = Promise.withResolvers<NativeRpcOutputs["runs"]["queue"]>();
  let requests = 0;
  let initialSignal: AbortSignal | undefined;
  const client = clientWith({
    runs: {
      queue: async (_input, options) => {
        requests++;
        if (requests === 1) {
          initialSignal = options?.signal;
          return pending.promise;
        }
        return { items: [] };
      },
    },
  });
  const queries = cache();
  const observer = new QueryObserver(queries, queueOptions(client, "thread"));
  const stop = observer.subscribe(() => {});
  await refreshQueue(queries, "thread");
  expect(initialSignal?.aborted).toBe(true);
  expect(requests).toBe(2);
  expect(observer.getCurrentResult().isSuccess).toBe(true);
  pending.resolve({ items: [] });
  await pending.promise;
  expect(requests).toBe(2);
  stop();
  queries.clear();
});
