import { afterEach, describe, expect, it, jest } from "bun:test";

import {
  FirecrawlPermitPool,
  type FirecrawlPermit,
} from "../../src/tool-server/tools/web-search/firecrawl-permit-pool";

afterEach(() => {
  jest.useRealTimers();
});

async function requirePermit(promise: ReturnType<FirecrawlPermitPool["acquire"]>) {
  return (await promise).match<FirecrawlPermit>({
    ok: (permit) => permit,
    err: (error) => {
      throw new Error(error.message);
    },
  });
}

describe("FirecrawlPermitPool", () => {
  it("admits up to the configured limit and drains waiters in FIFO order", async () => {
    const pool = new FirecrawlPermitPool("fetch");
    pool.configure({ maxConcurrency: 2, queueTtlMs: 3_000 });

    const first = await requirePermit(pool.acquire());
    const second = await requirePermit(pool.acquire());
    const order: number[] = [];
    const thirdPromise = requirePermit(pool.acquire()).then((permit) => {
      order.push(3);
      return permit;
    });
    const fourthPromise = requirePermit(pool.acquire()).then((permit) => {
      order.push(4);
      return permit;
    });

    await Promise.resolve();
    expect(order).toEqual([]);

    first.release();
    const third = await thirdPromise;
    expect(order).toEqual([3]);

    second.release();
    const fourth = await fourthPromise;
    expect(order).toEqual([3, 4]);

    third.release();
    fourth.release();
  });

  it("expires queued requests at their configured TTL", async () => {
    jest.useFakeTimers({ now: 0 });
    const pool = new FirecrawlPermitPool("fetch");
    pool.configure({ maxConcurrency: 1, queueTtlMs: 3_000 });

    const active = await requirePermit(pool.acquire());
    const queued = pool.acquire();
    jest.advanceTimersByTime(3_000);

    const failure = (await queued).match({
      ok: () => null,
      err: (error) => error,
    });
    expect(failure?._tag).toBe("FirecrawlPermitQueueTimedOut");
    expect(failure?.message).toContain("3000ms");

    active.release();
  });

  it("removes an aborted waiter without consuming a later permit", async () => {
    const pool = new FirecrawlPermitPool("search");
    pool.configure({ maxConcurrency: 1, queueTtlMs: 3_000 });

    const active = await requirePermit(pool.acquire());
    const controller = new AbortController();
    const aborted = pool.acquire(controller.signal);
    controller.abort();

    expect(
      (await aborted).match({
        ok: () => null,
        err: (error) => error._tag,
      }),
    ).toBe("FirecrawlPermitQueueAborted");

    active.release();
    const next = await requirePermit(pool.acquire());
    next.release();
  });

  it("drains queued requests when the active policy is relaxed", async () => {
    const pool = new FirecrawlPermitPool("fetch");
    pool.configure({ maxConcurrency: 1, queueTtlMs: 3_000 });

    const active = await requirePermit(pool.acquire());
    const queued = requirePermit(pool.acquire());
    pool.configure({ maxConcurrency: 2, queueTtlMs: 3_000 });

    const admitted = await queued;
    active.release();
    admitted.release();
  });

  it("keeps fetch and search permits independent", async () => {
    const fetchPool = new FirecrawlPermitPool("fetch");
    const searchPool = new FirecrawlPermitPool("search");
    fetchPool.configure({ maxConcurrency: 1, queueTtlMs: 3_000 });
    searchPool.configure({ maxConcurrency: 1, queueTtlMs: 3_000 });

    const activeFetch = await requirePermit(fetchPool.acquire());
    const activeSearch = await requirePermit(searchPool.acquire());
    let fetchAdmitted = false;
    let searchAdmitted = false;
    const queuedFetch = requirePermit(fetchPool.acquire()).then((permit) => {
      fetchAdmitted = true;
      return permit;
    });
    const queuedSearch = requirePermit(searchPool.acquire()).then((permit) => {
      searchAdmitted = true;
      return permit;
    });

    activeFetch.release();
    const nextFetch = await queuedFetch;
    expect(fetchAdmitted).toBe(true);
    expect(searchAdmitted).toBe(false);

    activeSearch.release();
    const nextSearch = await queuedSearch;
    expect(searchAdmitted).toBe(true);

    nextFetch.release();
    nextSearch.release();
  });
});
