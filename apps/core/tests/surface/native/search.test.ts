import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { NativeStore } from "../../../src/surface/native/store";
import { NativeSearchStore } from "../../../src/surface/native/store-search";
import { NativeSearchService } from "../../../src/surface/native/search";
import { nativeSearchTool } from "../../../src/surface/native/search-tools";
import { Discovery } from "../../../src/tool-server/tools/discovery";
import type { DiscoveryService } from "../../../src/discovery/discovery-service";

let db: Database;
let store: NativeStore;
let search: NativeSearchService;
let messages: NativeSearchStore;
beforeEach(() => {
  db = new Database(":memory:");
  store = new NativeStore(db, () => 1000);
  store.initialize().unwrap();
  for (const id of ["owner", "alice", "bob"])
    store
      .upsertUser({
        id,
        providerId: id,
        displayName: id,
        role: id === "owner" ? "owner" : "participant",
        toolMode: "full",
      })
      .unwrap();
  messages = new NativeSearchStore({ db, store });
  search = new NativeSearchService({ store, searchStore: messages });
});
afterEach(() => db.close());
function thread(userId: string, title: string, text: string) {
  const created = store.createThread(userId, { commandId: `create_${title}`, title }).unwrap();
  const input = store
    .acceptInput(userId, {
      threadId: created.id,
      commandId: `input_${title}`,
      text,
      historyGeneration: 0,
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    })
    .unwrap();
  return { id: created.id, turnId: input.turnId! };
}

describe("native search authority", () => {
  test("filters thread content before limit, pagination, and snippets", () => {
    thread("alice", "secret", "Private needle secret");
    const allowed = thread("bob", "visible", "Visible needle");
    const result = search.query("bob", { query: "needle", limit: 1 }).unwrap();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.threadId).toBe(allowed.id);
    expect(result.nextCursor).toBeUndefined();
    expect(search.query("owner", { query: "needle" }).unwrap().items).toHaveLength(2);
  });
  test("share removal revokes content, metadata, and reads immediately", () => {
    const hidden = thread("alice", "secret", "needle");
    store.shareThread("owner", { threadId: hidden.id, userId: "bob", grant: "read" }).unwrap();
    expect(messages.readThread("bob", hidden.id).unwrap().total).toBe(1);
    store.shareThread("owner", { threadId: hidden.id, userId: "bob", grant: null }).unwrap();
    expect(messages.readThread("bob", hidden.id).isErr()).toBe(true);
    expect(search.query("bob", { query: "needle" }).unwrap().items).toEqual([]);
  });
  test("agent data principal remains starter when owner edits", () => {
    const origin = thread("alice", "origin", "hello");
    thread("owner", "private", "ownerneedle");
    const context = {
      serverOwnedRequest: true,
      requestInitiator: { platform: "native" as const, userId: "owner" },
      requestInitiatorSessionId: origin.id,
    };
    const result = nativeSearchTool(search, context, (service, userId) =>
      service.query(userId, { query: "ownerneedle" }),
    ).unwrap();
    expect(result.items).toEqual([]);
    expect(
      nativeSearchTool(search, { ...context, serverOwnedRequest: false }, (service, userId) =>
        service.query(userId, { query: "hello" }),
      ).isErr(),
    ).toBe(true);
  });
  test("search uses current turn projection and excludes removed turns", () => {
    const origin = thread("alice", "origin", "needle");
    expect(messages.readThread("alice", origin.id).unwrap().total).toBe(1);
    db.query("DELETE FROM native_records WHERE kind='turn' AND thread_id=?").run(origin.id);
    expect(search.query("alice", { query: "needle" }).unwrap().items).toEqual([]);
  });
  test("native discovery surrounds only visible matches and validates time windows", () => {
    thread("owner", "secret", "needle private");
    const origin = thread("alice", "origin", "needle visible");
    const result = search.discovery("alice", { query: "needle", surrounding: 2 }).unwrap();
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.origin).toEqual({
      kind: "session",
      platform: "native",
      sessionId: origin.id,
      label: "origin",
    });
    expect(result.groups[0]!.entries.flat()[0]!.text).toBe("needle visible");
    expect(search.discovery("alice", { query: "needle", offsetTime: "1d" }).isErr()).toBe(true);
  });
  test("participant discovery never consults global files or external threads", async () => {
    thread("alice", "origin", "needle");
    const result = await search.discoveryWithExternal(
      "alice",
      { query: "needle" },
      {
        searchResult: () => {
          throw new Error("Unauthorized global source");
        },
      },
    );
    expect(result.unwrap().groups).toHaveLength(1);
  });
  test("native tool context never falls back to global discovery", async () => {
    const tool = new Discovery({
      discovery: {
        searchResult: () => {
          throw new Error("Global search must not run");
        },
      } as unknown as DiscoveryService,
    });
    const result = await tool.call(
      "discovery.search",
      { query: "needle" },
      { context: { requestInitiator: { platform: "native", userId: "alice" } } },
    );
    expect(result.isErr()).toBe(true);
  });
});
