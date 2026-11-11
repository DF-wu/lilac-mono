import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeStore } from "./store";
import { createDiscordMirrorThreads, discordMirrorThreadName } from "./discord-mirror-threads";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
});

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "native-mirror-"));
  const file = path.join(dir, "native.db");
  let db = new Database(file);
  let store = new NativeStore(db);
  store.initialize().unwrap();
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const warnings: string[] = [];
  let parent = "200";
  let next = 300;
  const threads = new Map<
    string,
    {
      id: string;
      type: number;
      parent_id: string;
      thread_metadata: { archived: boolean; locked: boolean };
    }
  >();
  let create: (() => Promise<Response>) | undefined;
  let channelStatus = 200;
  let parentType = 0;
  let onWait = async () => {};
  let token: string | undefined = "synthetic-bot";
  const abort = new AbortController();
  const make = (webhookId = "100", secret = "synthetic-webhook") =>
    createDiscordMirrorThreads({
      store,
      url: `https://discord.com/api/v10/webhooks/${webhookId}/${secret}`,
      botToken: () => token,
      signal: abort.signal,
      warn: (warning) => warnings.push(warning),
      wait: async () => {
        await onWait();
      },
      fetch: async (url, init) => {
        const method = init.method ?? "GET";
        const body = JSON.parse(String(init.body ?? "{}"));
        calls.push({ url, method, body });
        expect(init.redirect).toBe("error");
        expect(init.signal).toBeDefined();
        if (url.includes("/webhooks/")) {
          expect(new Headers(init.headers).has("authorization")).toBe(false);
          return Response.json({ id: webhookId, channel_id: parent, type: 1 });
        }
        expect(new Headers(init.headers).get("authorization")).toBe("Bot synthetic-bot");
        if (method === "POST") {
          if (create) return create();
          const thread = {
            id: String(next++),
            type: 11,
            parent_id: parent,
            thread_metadata: { archived: false, locked: false },
          };
          threads.set(thread.id, thread);
          return Response.json(thread);
        }
        const id = new URL(url).pathname.split("/").at(-1)!;
        if (id === parent) return Response.json({ id, type: parentType, parent_id: null });
        if (channelStatus !== 200)
          return Response.json({ message: "PRIVATE_SENTINEL" }, { status: channelStatus });
        const thread = threads.get(id);
        if (!thread) return Response.json({}, { status: 404 });
        if (method === "PATCH") thread.thread_metadata.archived = false;
        return Response.json(thread);
      },
    });
  cleanup.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    make,
    onWait: (wait: () => Promise<void>) => {
      onWait = wait;
    },
    calls,
    warnings,
    threads,
    abort,
    get store() {
      return store;
    },
    creates: () => calls.filter((call) => call.method === "POST"),
    parent: (id: string) => {
      parent = id;
    },
    parentType: (type: number) => {
      parentType = type;
    },
    token: (value: string | undefined) => {
      token = value;
    },
    status: (status: number) => {
      channelStatus = status;
    },
    create: (handler: (() => Promise<Response>) | undefined) => {
      create = handler;
    },
    reopen: () => {
      db.close();
      db = new Database(file);
      store = new NativeStore(db);
      store.initialize().unwrap();
    },
  };
}

test("two conversations get distinct children; concurrent and repeated resolution reuse durable mappings", async () => {
  const f = fixture();
  const router = f.make();
  const ids = await Promise.all([
    router.resolve("native-a", "First"),
    router.resolve("native-a", "First"),
    router.resolve("native-b", "Second"),
  ]);
  expect(ids).toEqual(["300", "300", "301"]);
  expect(f.creates()).toHaveLength(2);
  expect(f.creates()[0]?.body).toMatchObject({ type: 11, auto_archive_duration: 1440 });
  expect(await router.resolve("native-a", "Renamed")).toBe("300");
  f.reopen();
  expect(await f.make().resolve("native-a", "After restart")).toBe("300");
  expect(f.creates()).toHaveLength(2);
});

test("destination includes webhook and parent identity, but excludes credential rotation", async () => {
  const f = fixture();
  expect(await f.make().resolve("native-a", "First")).toBe("300");
  expect(await f.make("100", "rotated-synthetic").resolve("native-a", "First")).toBe("300");
  expect(await f.make("101").resolve("native-a", "First")).toBe("301");
  f.parent("201");
  expect(await f.make().resolve("native-a", "First")).toBe("302");
  expect(f.creates()).toHaveLength(3);
});

test("uncertain create responses and crash reservations block duplicate creates across restart", async () => {
  for (const outcome of ["network", "server", "malformed", "http-timeout"] as const) {
    const f = fixture();
    f.create(async () => {
      if (outcome === "network") throw new Error("PRIVATE_SENTINEL");
      if (outcome === "server") return Response.json({}, { status: 503 });
      if (outcome === "http-timeout") return Response.json({}, { status: 408 });
      return Response.json({ id: "broken" });
    });
    expect(await f.make().resolve("native-a", "First")).toBeNull();
    f.reopen();
    f.create(undefined);
    expect(await f.make().resolve("native-a", "First")).toBeNull();
    expect(f.creates()).toHaveLength(1);
    expect(f.warnings.join()).not.toMatch(
      /PRIVATE_SENTINEL|synthetic-bot|synthetic-webhook|https:/,
    );
  }
  const f = fixture();
  expect(f.store.reserveDiscordMirrorThread("100:200", "native-a").unwrap()).toBe(true);
  f.reopen();
  expect(await f.make().resolve("native-a", "After crash")).toBeNull();
  expect(f.creates()).toHaveLength(0);
});

test("definite create rejection can be retried; rate limits stay bounded", async () => {
  const f = fixture();
  f.create(async () => Response.json({}, { status: 403 }));
  expect(await f.make().resolve("native-a", "First")).toBeNull();
  f.create(undefined);
  expect(await f.make().resolve("native-a", "First")).toBe("300");
  f.create(async () => Response.json({ retry_after: 0 }, { status: 429 }));
  expect(await f.make().resolve("native-b", "Second")).toBeNull();
  expect(f.creates()).toHaveLength(5);
});

test("unlocked archived children reopen; locked, deleted or inaccessible children keep their mapping", async () => {
  const f = fixture();
  const router = f.make();
  expect(await router.resolve("native-a", "First")).toBe("300");
  const thread = f.threads.get("300")!;
  thread.thread_metadata.archived = true;
  expect(await router.resolve("native-a", "First")).toBe("300");
  expect(f.calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([
    { archived: false },
  ]);
  thread.thread_metadata.archived = true;
  thread.thread_metadata.locked = true;
  expect(await router.resolve("native-a", "First")).toBeNull();
  for (const status of [403, 404]) {
    f.status(status);
    expect(await router.resolve("native-a", "First")).toBeNull();
  }
  f.reopen();
  expect(await f.make().resolve("native-a", "First")).toBeNull();
  expect(f.creates()).toHaveLength(1);
});

test("missing credentials, non-text parents and cancellation never create a child", async () => {
  const f = fixture();
  f.token(undefined);
  expect(await f.make().resolve("native-a", "First")).toBeNull();
  expect(f.calls).toHaveLength(0);
  f.token("synthetic-bot");
  for (const type of [5, 11, 15, 16]) {
    f.parentType(type);
    expect(await f.make().resolve("native-a", "First")).toBeNull();
  }
  f.abort.abort();
  expect(await f.make().resolve("native-a", "First")).toBeNull();
  expect(f.creates()).toHaveLength(0);
});

test("thread names sanitize untrusted titles and fit Discord limits with a stable suffix", () => {
  const id = "a-stable-native-id";
  const name = discordMirrorThreadName("  @everyone\n<#123> resource://private 😀".repeat(20), id);
  expect(name.length).toBeLessThanOrEqual(100);
  expect(name).not.toMatch(/@|<|>|\n|resource:\/\//);
  const suffix = name.slice(-13);
  expect(discordMirrorThreadName("Renamed", id).endsWith(suffix)).toBe(true);
  expect(discordMirrorThreadName("\n\u0000", id)).toMatch(/^Native conversation /);
});

test("independent routers atomically reserve a single child create", async () => {
  const f = fixture();
  const results = await Promise.all([
    f.make().resolve("native-a", "First"),
    f.make().resolve("native-a", "First"),
  ]);
  expect(results.filter((id) => id === "300")).toHaveLength(1);
  expect(f.creates()).toHaveLength(1);
  expect(await f.make().resolve("native-a", "First")).toBe("300");
});

test("a superseded message during the pre-create wait releases its unsent reservation", async () => {
  const f = fixture();
  let current = true;
  let waits = 0;
  f.onWait(async () => {
    if (++waits === 3) current = false;
  });
  expect(await f.make().resolve("native-a", "First", undefined, () => current)).toBeNull();
  expect(f.creates()).toHaveLength(0);
  expect(f.store.readDiscordMirrorThread("100:200", "native-a").unwrap()).toBeNull();
  f.reopen();
  f.onWait(async () => {});
  expect(await f.make().resolve("native-a", "First")).toBe("300");
});

test("uncategorized text parents accept Discord null parent_id on create and reuse", async () => {
  const f = fixture();
  expect(await f.make().resolve("native-a", "First")).toBe("300");
  expect(await f.make().resolve("native-a", "Second")).toBe("300");
  expect(f.creates()).toHaveLength(1);
});
