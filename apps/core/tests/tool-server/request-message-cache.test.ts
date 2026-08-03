import { describe, expect, it } from "bun:test";
import {
  createLilacBus,
  EventDeliveryStartFailed,
  EventDeliveryStopped,
  EventDeliveryStopFailed,
  lilacEventTypes,
  type DeliveryDisposition,
  type EventDeliveryDoneError,
  type FetchOptions,
  type Message,
  type PublishOptions,
  type RawBus,
  type RawDeliveryHandler,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";
import { Panic, Result, type Result as ResultType } from "better-result";

import {
  createRequestMessageCache,
  RequestMessageCacheProjectionInvalid,
  RequestMessageCacheRequestIdMissing,
  requestMessageCacheDeliveryDisposition,
} from "../../src/tool-server/request-message-cache";

type InMemoryRawBusHarness = {
  readonly raw: RawBus;
  readonly dispositions: DeliveryDisposition[];
  readonly transportCommitCount: () => number;
};

function createInMemoryRawBusHarness(options?: {
  readonly startPanic?: Panic;
  readonly startFailure?: EventDeliveryStartFailed;
  readonly stopFailure?: EventDeliveryStopFailed;
  readonly doneFailure?: EventDeliveryDoneError;
  readonly stopPanic?: Panic;
}): InMemoryRawBusHarness {
  const topics = new Map<string, Array<Message<unknown>>>();
  const deliverySubs = new Set<{
    topic: string;
    opts: SubscriptionOptions;
    handler: RawDeliveryHandler;
  }>();
  const dispositions: DeliveryDisposition[] = [];
  let transportCommitCount = 0;

  const raw: RawBus = {
    publish: async <TData>(msg: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
      const id = `${Date.now()}-0`;
      const stored: Message<unknown> = {
        topic: opts.topic,
        id,
        type: opts.type,
        ts: Date.now(),
        key: opts.key,
        headers: opts.headers,
        data: msg.data,
      };

      const list = topics.get(opts.topic) ?? [];
      list.push(stored);
      topics.set(opts.topic, list);

      for (const s of deliverySubs) {
        if (s.topic !== opts.topic) continue;
        const context = {
          cursor: id,
          mode: s.opts.mode,
          evidence: {
            source: {
              transport: "redis-streams" as const,
              streamKey: opts.topic,
              topic: opts.topic,
              messageId: id,
            },
            wire: { kind: "bounded-complete" as const, fields: [] },
          },
        };
        const action = await s.handler(stored, context);
        dispositions.push(action.disposition);
        if (action.disposition === "commit") transportCommitCount += 1;
      }

      return { id, cursor: id };
    },

    subscribe: async (topic, opts, handler) => {
      if (options?.startPanic) throw options.startPanic;
      if (options?.startFailure) return Result.err(options.startFailure);

      const done = Promise.withResolvers<ResultType<void, EventDeliveryDoneError>>();
      if (options?.doneFailure) done.resolve(Result.err(options.doneFailure));
      const entry = { topic, opts, handler };
      deliverySubs.add(entry);
      return Result.ok({
        done: done.promise,
        stop: async () => {
          deliverySubs.delete(entry);
          if (!options?.doneFailure) done.resolve(Result.ok(undefined));
          if (options?.stopPanic) throw options.stopPanic;
          if (options?.stopFailure) return Result.err(options.stopFailure);
          return Result.ok(undefined);
        },
      });
    },

    fetch: async (topic: string, _opts: FetchOptions) => {
      const existing = topics.get(topic) ?? [];
      return {
        messages: existing.map((m) => ({
          msg: m,
          cursor: m.id,
        })),
        next: existing.length > 0 ? existing[existing.length - 1]!.id : undefined,
      };
    },

    close: async () => {},
  };

  return {
    raw,
    dispositions,
    transportCommitCount: () => transportCommitCount,
  };
}

function createInMemoryRawBus(): RawBus {
  return createInMemoryRawBusHarness().raw;
}

describe("request-message-cache", () => {
  it("commits successful projections through the transport without handler acknowledgement", async () => {
    const harness = createInMemoryRawBusHarness();
    const bus = createLilacBus(harness.raw);
    const cache = await createRequestMessageCache({ bus, ttlMs: 60_000, maxEntries: 32 });
    const requestId = "req:cache-policy";

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      { queue: "prompt", messages: [{ role: "user", content: "one" }] },
      { headers: { request_id: requestId } },
    );

    expect(cache.get(requestId)).toHaveLength(1);
    expect(harness.dispositions).toEqual(["commit"]);
    expect(harness.transportCommitCount()).toBe(1);
    await cache.stop();
  });

  it("adapts lifecycle failures with stop-before-done precedence and preserves Panic", async () => {
    const startPanic = new Panic({ message: "request cache startup invariant failed" });
    await expect(
      createRequestMessageCache({
        bus: createLilacBus(createInMemoryRawBusHarness({ startPanic }).raw),
      }),
    ).rejects.toBe(startPanic);

    const startFailure = new EventDeliveryStartFailed({
      cause: undefined,
      topic: "cmd.request",
      message: "start unavailable",
    });
    await expect(
      createRequestMessageCache({
        bus: createLilacBus(createInMemoryRawBusHarness({ startFailure }).raw),
      }),
    ).rejects.toBe(startFailure);

    const stopFailure = new EventDeliveryStopFailed({
      cause: undefined,
      topic: "cmd.request",
      message: "stop wins",
    });
    const doneFailure = new EventDeliveryStopped({
      reason: "requested",
      topic: "cmd.request",
      cursor: "1-0",
      message: "done loses",
    });
    const precedenceCache = await createRequestMessageCache({
      bus: createLilacBus(createInMemoryRawBusHarness({ stopFailure, doneFailure }).raw),
    });
    await expect(precedenceCache.stop()).rejects.toBe(stopFailure);

    const doneCache = await createRequestMessageCache({
      bus: createLilacBus(createInMemoryRawBusHarness({ doneFailure }).raw),
    });
    await expect(doneCache.stop()).rejects.toBe(doneFailure);

    const panic = new Panic({ message: "request cache cleanup invariant failed" });
    const panicCache = await createRequestMessageCache({
      bus: createLilacBus(createInMemoryRawBusHarness({ stopPanic: panic }).raw),
    });
    await expect(panicCache.stop()).rejects.toBe(panic);
  });

  it("parks a request message missing its required request id", () => {
    const error = new RequestMessageCacheRequestIdMissing({
      messageType: lilacEventTypes.CmdRequestMessage,
      message: "cmd.request.message missing headers.request_id",
    });

    expect(requestMessageCacheDeliveryDisposition(error)).toBe("park-pending");
  });

  it("dead-letters malformed cache-owned authentication projections", async () => {
    const harness = createInMemoryRawBusHarness();
    const bus = createLilacBus(harness.raw);
    const cache = await createRequestMessageCache({ bus, ttlMs: 60_000, maxEntries: 32 });
    const requestId = "req:cache-invalid-projection";

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        queue: "prompt",
        messages: [{ role: "user", content: "one" }],
        raw: { authenticatedActor: { platform: "discord", userId: "" } },
      },
      {
        headers: {
          request_id: requestId,
          session_id: "channel",
          request_client: "discord",
        },
      },
    );

    expect(harness.dispositions).toEqual(["dead-letter"]);
    expect(harness.transportCommitCount()).toBe(0);
    expect(cache.get(requestId)).toBeUndefined();
    expect(
      requestMessageCacheDeliveryDisposition(
        new RequestMessageCacheProjectionInvalid({
          messageType: lilacEventTypes.CmdRequestMessage,
          message: "invalid projection",
        }),
      ),
    ).toBe("dead-letter");
    await cache.stop();
  });

  it("stores and appends cmd.request message batches per request id", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const cache = await createRequestMessageCache({ bus, ttlMs: 60_000, maxEntries: 32 });

    const requestId = "req:cache-1";

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        queue: "prompt",
        messages: [{ role: "user", content: "one" }],
      },
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "discord",
        },
      },
    );

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        queue: "followUp",
        messages: [{ role: "user", content: "two" }],
      },
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "discord",
        },
      },
    );

    const cached = cache.get(requestId);
    expect(Array.isArray(cached)).toBe(true);
    expect(cached?.length).toBe(2);

    await cache.stop();
  });

  it("expires cached entries after ttl", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const cache = await createRequestMessageCache({ bus, ttlMs: 5, maxEntries: 32 });

    const requestId = "req:cache-expire";

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        queue: "prompt",
        messages: [{ role: "user", content: "one" }],
      },
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "discord",
        },
      },
    );

    expect(cache.get(requestId)?.length).toBe(1);

    // test-wait-justification: crosses the cache's real five-millisecond TTL before asserting eviction
    await new Promise((r) => setTimeout(r, 10));
    expect(cache.get(requestId)).toBeUndefined();

    await cache.stop();
  });

  it("retains authenticated surface origins from server-published request state", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const cache = await createRequestMessageCache({ bus, ttlMs: 60_000, maxEntries: 32 });
    const requestId = "discord:channel-1:message-1";
    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      { queue: "prompt", messages: [{ role: "user", content: "run" }] },
      {
        headers: {
          request_id: requestId,
          session_id: "channel-1",
          request_client: "discord",
        },
      },
    );
    expect(cache.getOrigin(requestId)).toEqual({
      requestId,
      sessionId: "channel-1",
      platform: "discord",
      messageRef: { platform: "discord", channelId: "channel-1", messageId: "message-1" },
      actorUserId: null,
    });

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        queue: "prompt",
        messages: [{ role: "user", content: "active channel" }],
        raw: {
          authenticatedOrigin: {
            platform: "discord",
            userId: "user-2",
            messageRef: { platform: "discord", channelId: "channel-1", messageId: "message-2" },
          },
        },
      },
      {
        headers: {
          request_id: "req:random-server-id",
          session_id: "channel-1",
          request_client: "discord",
        },
      },
    );
    expect(cache.getOrigin("req:random-server-id")).toMatchObject({
      actorUserId: "user-2",
      messageRef: { messageId: "message-2" },
    });

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        queue: "prompt",
        messages: [{ role: "user", content: "review" }],
        raw: {
          authenticatedActor: { platform: "github", userId: "octocat" },
          github: { trigger: { kind: "comment", commentId: 42 } },
        },
      },
      {
        headers: {
          request_id: "github:owner/repo#7:42",
          session_id: "owner/repo#7",
          request_client: "github",
        },
      },
    );
    expect(cache.getOrigin("github:owner/repo#7:42")).toMatchObject({
      platform: "github",
      actorUserId: "octocat",
      messageRef: { messageId: "42" },
    });
    expect(cache.getOrigin("forged-request")).toBeUndefined();
    await cache.stop();
  });

  it("clamps large per-request message history and evicts oldest request ids", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const cache = await createRequestMessageCache({ bus, ttlMs: 60_000, maxEntries: 2 });

    const hotRequest = "req:cache-hot";

    for (let i = 0; i < 520; i++) {
      await bus.publish(
        lilacEventTypes.CmdRequestMessage,
        {
          queue: "followUp",
          messages: [{ role: "user", content: `m${i}` }],
        },
        {
          headers: {
            request_id: hotRequest,
            session_id: "chan",
            request_client: "discord",
          },
        },
      );
    }

    const hot = cache.get(hotRequest);
    expect(hot?.length).toBe(512);

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      { queue: "prompt", messages: [{ role: "user", content: "a" }] },
      { headers: { request_id: "req:a", session_id: "chan", request_client: "discord" } },
    );

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      { queue: "prompt", messages: [{ role: "user", content: "b" }] },
      { headers: { request_id: "req:b", session_id: "chan", request_client: "discord" } },
    );

    // maxEntries=2 should evict least recently updated request ids.
    expect(cache.get("req:a")).toBeDefined();
    expect(cache.get("req:b")).toBeDefined();
    expect(cache.get(hotRequest)).toBeUndefined();

    await cache.stop();
  });
});
