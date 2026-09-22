import { afterEach, describe, expect, test } from "bun:test";
import { implement } from "@orpc/server";
import { ORPCError } from "@orpc/client";
import { RPCHandler } from "@orpc/server/bun-ws";
import {
  nativeContract,
  type BootstrapReply,
  type NativeInput,
} from "@stanley2058/lilac-client-protocol";
import { NativeClient, type ClientEvent } from "../src/client.ts";
import { MemoryNativeCache, type CacheScope } from "../src/cache.ts";
import { reconnectDelay } from "../src/transport.ts";

const scope: CacheScope = {
  installationId: "installation",
  principalId: "owner",
  protocolVersion: 1,
  projectionVersion: 1,
};
const checkpoint = {
  protocolVersion: 1 as const,
  historyGeneration: 0,
  projectionRevision: 1,
  cursor: "cursor",
};
const bootstrap: BootstrapReply = {
  installationId: "installation",
  viewer: { id: "owner", displayName: "Owner", role: "owner", toolMode: "full" },
  threads: { items: [] },
  catalog: {
    kind: "catalog",
    catalog: { revision: "catalog", skills: [], commands: [], models: [] },
  },
  catalogCursor: "catalog_cursor",
  selectedThread: {
    kind: "window",
    checkpoint,
    slots: [
      {
        kind: "ready",
        slotId: "slot",
        turnId: "turn",
        position: 0,
        messages: [{ id: "message", role: "user", parts: [{ type: "text", text: "hello" }] }],
      },
    ],
  },
};
const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

function harness(
  options: {
    delayedSubmit?: Promise<void>;
    delayedCatalog?: Promise<void>;
    bootstrap?: () => Promise<BootstrapReply>;
  } = {},
) {
  const watches: unknown[] = [];
  const sentInputs: NativeInput[] = [];
  const opened = Promise.withResolvers<void>();
  const watching = Promise.withResolvers<void>();
  const submitting = Promise.withResolvers<void>();
  const fetchingCatalog = Promise.withResolvers<void>();
  const watch = implement(nativeContract.threads.watch).handler(async function* ({
    input,
    signal,
  }) {
    watches.push(input);
    watching.resolve();
    yield { kind: "replay" as const, reply: { kind: "unchanged" as const, checkpoint } };
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  const catalog = implement(nativeContract.bootstrap.watch).handler(async function* ({ signal }) {
    if (options.delayedCatalog)
      yield { kind: "catalog-invalidated" as const, cursor: "changed", revision: "changed" };
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  const submit = implement(nativeContract.inputs.submit).handler(async ({ input }) => {
    sentInputs.push(input);
    submitting.resolve();
    await options.delayedSubmit;
    return { inputId: "input", messageId: "message", state: "admitted" as const, turnId: "turn" };
  });
  const getCatalog = implement(nativeContract.catalogs.get).handler(async () => {
    fetchingCatalog.resolve();
    await options.delayedCatalog;
    return {
      kind: "catalog" as const,
      catalog: { revision: "new", models: [], skills: [], commands: [] },
    };
  });
  const handler = new RPCHandler({
    threads: { watch },
    bootstrap: { watch: catalog },
    inputs: { submit },
    catalogs: { get: getCatalog },
  });
  let socketCount = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message: (socket, message) => handler.message(socket, message),
      close: (socket) => handler.close(socket),
    },
  });
  disposers.push(() => server.stop(true));
  const events: ClientEvent[] = [];
  const cache = new MemoryNativeCache();
  const client = new NativeClient({
    scope,
    cache,
    openSocket: () => {
      socketCount++;
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
      socket.addEventListener("open", () => opened.resolve());
      return socket;
    },
    bootstrap: async () => {
      await opened.promise;
      return options.bootstrap ? options.bootstrap() : bootstrap;
    },
    onEvent: (event) => events.push(event),
  });
  disposers.push(() => client.dispose());
  return {
    client,
    cache,
    events,
    watches,
    sentInputs,
    watching: watching.promise,
    fetchingCatalog: fetchingCatalog.promise,
    submitting: submitting.promise,
    socketCount: () => socketCount,
  };
}
const input: NativeInput = {
  commandId: "command",
  threadId: "thread",
  historyGeneration: 0,
  mode: "prompt",
  text: "hello",
  attachmentIds: [],
  skillIds: [],
};

describe("NativeClient", () => {
  test("bootstrap owns initial content and socket attaches at its watermark", async () => {
    const test = harness();
    await test.client.start("thread");
    await test.watching;
    expect(test.socketCount()).toBe(1);
    expect(test.watches).toEqual([{ threadId: "thread", checkpoint }]);
    expect(test.client.thread("thread").get("slot")).toMatchObject({ turnId: "turn" });
    expect(test.events.some((event) => event.kind === "bootstrap")).toBe(true);
  });

  test("retry retains one command identity and rejects changed payload", async () => {
    const test = harness();
    expect(await test.client.submit(input)).toEqual({ kind: "uncertain", commandId: "command" });
    await test.client.start("thread");
    expect(await test.client.retry("command")).toMatchObject({
      kind: "accepted",
      receipt: { inputId: "input" },
    });
    expect(await test.client.retry("command")).toMatchObject({ kind: "accepted" });
    expect(await test.client.submit({ ...input, text: "different" })).toMatchObject({
      kind: "rejected",
      error: { kind: "conflict" },
    });
    expect(test.sentInputs).toHaveLength(1);
    expect(test.sentInputs[0]?.commandId).toBe("command");
  });

  test("logout fences a pending response and purges private state", async () => {
    const pending = Promise.withResolvers<void>();
    const test = harness({ delayedSubmit: pending.promise });
    await test.client.start("thread");
    const submitted = test.client.submit(input);
    await test.submitting;
    await test.client.logout();
    pending.resolve();
    expect(await submitted).toMatchObject({ kind: "uncertain" });
    expect(await test.client.retry("command")).toMatchObject({ kind: "rejected" });
    expect(await test.cache.read(scope, "thread")).toBeUndefined();
    expect(test.client.thread("thread").size).toBe(0);
    expect(test.events.at(-1)).toEqual({ kind: "connection", state: "logged-out" });
  });

  test("revocation removes persisted thread after already queued writes finish", async () => {
    const test = harness();
    await test.client.start("thread");
    const store = test.client.thread("thread");
    await test.client.revoke("thread");
    expect(store.size).toBe(0);
    expect(await test.cache.read(scope, "thread")).toBeUndefined();
    expect(test.events.at(-1)).toEqual({ kind: "removed", threadId: "thread" });
  });

  test("late catalog response cannot repopulate state after logout", async () => {
    const pending = Promise.withResolvers<void>();
    const test = harness({ delayedCatalog: pending.promise });
    await test.client.start("thread");
    await test.fetchingCatalog;
    await test.client.logout();
    pending.resolve();
    await test.client.dispose();
    expect(test.client.catalogs.get(scope)).toBeUndefined();
    expect(test.events.at(-1)).toEqual({ kind: "connection", state: "logged-out" });
  });

  test("bootstrap forbidden purges cached private state and logs out", async () => {
    const test = harness({
      bootstrap: async () => {
        throw new ORPCError("FORBIDDEN");
      },
    });
    await test.cache.commit(scope, "thread", {
      checkpoint,
      replace: true,
      remove: [],
      put: [
        {
          revision: 1,
          slot: { kind: "ready", slotId: "secret", turnId: "secret", position: 0, messages: [] },
        },
      ],
    });
    await test.client.start("thread");
    expect(test.events.at(-1)).toEqual({ kind: "connection", state: "logged-out" });
    expect(test.client.thread("thread").size).toBe(0);
    expect(await test.cache.read(scope, "thread")).toBeUndefined();
  });

  test("failed HTTP bootstrap retries while its socket remains open", async () => {
    let attempts = 0;
    const test = harness({
      bootstrap: async () => {
        attempts++;
        if (attempts === 1) throw new Error("Temporary HTTP failure");
        return bootstrap;
      },
    });
    await test.client.start("thread");
    await test.watching;
    expect(attempts).toBe(2);
    expect(test.socketCount()).toBe(1);
    expect(test.client.thread("thread").get("slot")).toBeDefined();
  });

  test("reconnect delay is jittered and bounded without fixed test waits", () => {
    expect(reconnectDelay(0, () => 0)).toBe(250);
    expect(reconnectDelay(0, () => 1)).toBe(500);
    expect(reconnectDelay(100, () => 1)).toBe(30_000);
  });
});

test("UI selection during bootstrap attaches one watch after the snapshot watermark", async () => {
  const release = Promise.withResolvers<BootstrapReply>();
  const requested = Promise.withResolvers<void>();
  const test = harness({
    bootstrap: async () => {
      requested.resolve();
      return release.promise;
    },
  });
  const starting = test.client.start("thread");
  await requested.promise;
  await test.client.selectThread("thread");
  expect(test.watches).toEqual([]);
  release.resolve(bootstrap);
  await starting;
  await test.watching;
  await test.client.selectThread("thread");
  await test.client.selectThread("thread");
  expect(test.watches).toEqual([{ threadId: "thread", checkpoint }]);
});

test("first-thread selection while an unselected bootstrap loads creates one content watch", async () => {
  const release = Promise.withResolvers<BootstrapReply>();
  const requested = Promise.withResolvers<void>();
  const test = harness({
    bootstrap: async () => {
      requested.resolve();
      return release.promise;
    },
  });
  const starting = test.client.start();
  await requested.promise;
  await test.client.selectThread("thread");
  release.resolve({ ...bootstrap, selectedThread: undefined });
  await starting;
  await test.watching;
  await test.client.selectThread("thread");
  expect(test.watches).toEqual([{ threadId: "thread" }]);
});

test("inactive stores evict while selected and observed stores stay stable", async () => {
  const test = harness();
  await test.client.selectThread("selected");
  const selected = test.client.thread("selected");
  const observed = test.client.thread("observed");
  const release = observed.subscribe(() => {});
  const oldest = test.client.thread("oldest");
  for (let index = 0; index < 24; index++) test.client.thread(`visited_${index}`);
  expect(test.client.thread("selected")).toBe(selected);
  expect(test.client.thread("observed")).toBe(observed);
  expect(test.client.thread("oldest")).not.toBe(oldest);
  release();
  for (let index = 0; index < 12; index++) test.client.thread(`later_${index}`);
  expect(test.client.thread("observed")).not.toBe(observed);
});

test("an evicted store restores only after its queued checkpoint commits", async () => {
  const saving = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  class DelayedCache extends MemoryNativeCache {
    override async commit(...args: Parameters<MemoryNativeCache["commit"]>): Promise<void> {
      saving.resolve();
      await release.promise;
      await super.commit(...args);
    }
  }
  const cache = new DelayedCache();
  const client = new NativeClient({
    scope,
    cache,
    openSocket: () => new WebSocket("ws://unused.invalid"),
    bootstrap: async () => bootstrap,
  });
  disposers.push(() => client.dispose());
  const original = client.thread("original");
  const selected = bootstrap.selectedThread;
  if (selected) original.replay(selected);
  await saving.promise;
  for (let index = 0; index < 24; index++) client.thread(`visited_${index}`);
  const restored = client.thread("original");
  expect(restored).not.toBe(original);
  const loading = client.loadCached("original");
  expect(restored.checkpoint).toBeUndefined();
  release.resolve();
  await loading;
  expect(restored.checkpoint).toEqual(checkpoint);
  expect(restored.get("slot")).toBeDefined();
  expect((await cache.read(scope, "original"))?.checkpoint).toEqual(checkpoint);
});

test("no-cache clients retain the selected store but release visited inactive history", async () => {
  const client = new NativeClient({
    scope,
    openSocket: () => new WebSocket("ws://unused.invalid"),
    bootstrap: async () => bootstrap,
  });
  disposers.push(() => client.dispose());
  await client.selectThread("selected");
  const selected = client.thread("selected");
  const old = client.thread("old");
  client.thread("next");
  expect(client.thread("old")).not.toBe(old);
  expect(client.thread("selected")).toBe(selected);
});

test("HTTP retry does not cancel socket reconnection after both transports fail", async () => {
  const closed = Promise.withResolvers<void>();
  const reopened = Promise.withResolvers<void>();
  const bootstrapped = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === "/fail") return new Response(null, { status: 503 });
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: { message() {} },
  });
  disposers.push(() => server.stop(true));
  let socketCount = 0;
  let bootstrapCount = 0;
  const client = new NativeClient({
    scope,
    openSocket: () => {
      const path = socketCount++ === 0 ? "/fail" : "/socket";
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}${path}`);
      socket.addEventListener("close", () => closed.resolve());
      socket.addEventListener("open", () => reopened.resolve());
      return socket;
    },
    bootstrap: async () => {
      if (bootstrapCount++ === 0) {
        await closed.promise;
        throw new Error("HTTP unavailable");
      }
      return bootstrap;
    },
    onEvent: (event) => {
      if (event.kind === "bootstrap") bootstrapped.resolve();
    },
  });
  disposers.push(() => client.dispose());
  await client.start();
  await Promise.all([reopened.promise, bootstrapped.promise]);
  expect(socketCount).toBe(2);
  expect(bootstrapCount).toBeGreaterThanOrEqual(2);
  expect(client.rpc).toBeDefined();
});
