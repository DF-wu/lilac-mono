import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { NativeStore } from "../../../src/surface/native/store";
import { NativeSearchStore } from "../../../src/surface/native/store-search";
import { NativeSummaryStore } from "../../../src/surface/native/store-search-summary";
import { normalizeNativeSummary } from "../../../src/surface/native/search-summary-codec";
import type { ConversationThreadToolService } from "../../../src/conversation/thread-service";
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
    expect(
      search.conversationMetadata("bob", { threadIds: [hidden.id] }).unwrap().threads,
    ).toHaveLength(1);
    store.shareThread("owner", { threadId: hidden.id, userId: "bob", grant: null }).unwrap();
    expect(search.conversationRead("bob", { threadId: hidden.id }).isErr()).toBe(true);
    expect(search.conversationMetadata("bob", { threadIds: [hidden.id] }).isErr()).toBe(true);
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
  test("scope binding rechecks starter authority on every auto-inject call", async () => {
    const origin = thread("alice", "origin", "needle");
    thread("owner", "secret", "secretneedle");
    const scoped = search.forThread(origin.id);
    const result = await scoped.search({ query: "secretneedle" });
    expect(result.results).toEqual([]);
    expect((await scoped.read({ threadId: origin.id })).thread.session.platform).toBe("native");
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
  test("thread search and metadata use the whole-thread summary", () => {
    const origin = thread("alice", "origin", "literal text");
    const summaries = new NativeSummaryStore({ db, store });
    summaries.initialize().unwrap();
    summaries
      .put({
        threadId: origin.id,
        historyGeneration: 0,
        contentRevision: store.getThreadRecord(origin.id).unwrap().revision,
        generatedAt: 1000,
        messageCount: 1,
        summary: normalizeNativeSummary({
          title: "Database design",
          brief: "An architectural discussion",
          topics: ["architecture"],
        }),
      })
      .unwrap();
    const withSummaries = new NativeSearchService({ store, searchStore: messages, summaries });
    expect(
      withSummaries.conversationSearch("alice", { query: "architecture" }).unwrap().results[0]!
        .brief,
    ).toBe("An architectural discussion");
    expect(
      withSummaries.conversationMetadata("alice", { threadIds: [origin.id] }).unwrap().threads[0]!
        .title,
    ).toBe("Database design");
    expect(
      withSummaries.conversationSearch("bob", { query: "architecture" }).unwrap().results,
    ).toEqual([]);
  });
  test("only an owner starter aggregates external conversation search", async () => {
    const alice = thread("alice", "alice", "needle");
    const owner = thread("owner", "owner", "needle");
    let calls = 0;
    const externalThreads = {
      search: async () => {
        calls++;
        return {
          meta: {
            query: "needle",
            limit: 5,
            mode: "lexical",
            minScore: 0,
            count: 1,
            vectorAvailable: false,
          },
          results: [{ threadId: "discord_thread", title: "External", brief: "needle" }],
        };
      },
    } as unknown as ConversationThreadToolService;
    const service = new NativeSearchService({ store, searchStore: messages, externalThreads });
    expect((await service.forThread(alice.id).search({ query: "needle" })).results).toHaveLength(1);
    expect(calls).toBe(0);
    expect((await service.forThread(owner.id).search({ query: "needle" })).results).toHaveLength(3);
    expect(calls).toBe(1);
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

test("native search ranks lexical matches, applies minScore, and declares semantic fallback", () => {
  const body = thread("alice", "body match", "needle");
  const title = thread("alice", "needle", "needle");
  const ranked = search
    .conversationSearch("alice", { query: "needle", mode: "hybrid", verbose: true })
    .unwrap();
  expect(ranked.meta).toMatchObject({ mode: "lexical", vectorAvailable: false });
  expect(ranked.results.map((hit) => hit.threadId)).toEqual([title.id, body.id]);
  expect(ranked.results[0]!.score).toBeGreaterThan(ranked.results[1]!.score!);
  expect(
    search
      .conversationSearch("alice", { query: "needle", minScore: 0.5 })
      .unwrap()
      .results.map((hit) => hit.threadId),
  ).toEqual([title.id]);
  expect(
    search.conversationSearch("alice", { query: "needle", minScore: 100 }).unwrap().results,
  ).toEqual([]);
  expect(search.conversationSearch("alice", { query: "needle", mode: "semantic" }).isErr()).toBe(
    true,
  );
  for (const sessionId of [body.id, `native:${body.id}`]) {
    expect(
      search
        .conversationSearch("alice", { query: "needle", sessionId })
        .unwrap()
        .results.map((hit) => hit.threadId),
    ).toEqual([body.id]);
    expect(search.discovery("alice", { query: "needle", sessionId }).unwrap().groups).toHaveLength(
      1,
    );
  }
});

test("metadata reports missing IDs while preserving permission failures", () => {
  const visible = thread("alice", "visible", "hello");
  const secret = thread("bob", "secret", "hidden");
  const result = search
    .conversationMetadata("alice", { threadIds: [visible.id, "missing"] })
    .unwrap();
  expect(result.threads.map((t) => t.threadId)).toEqual([visible.id]);
  expect(result.missing).toEqual(["missing"]);
  expect(
    search.conversationMetadata("alice", { threadIds: [visible.id, secret.id, "missing"] }).isErr(),
  ).toBe(true);
});

test("lexical scoring retains a match split across title and message", () => {
  const origin = thread("alice", "alpha", "beta");
  const result = search
    .conversationSearch("alice", { query: "alpha beta", verbose: true })
    .unwrap();
  expect(result.results).toMatchObject([{ threadId: origin.id, score: 0.2 }]);
});

test("owner searches rank sources together and report lexical fallback", async () => {
  thread("owner", "Native", "needle");
  const inputs: Array<Parameters<ConversationThreadToolService["search"]>[0]> = [];
  const externalThreads: ConversationThreadToolService = {
    ...search.forUser("owner"),
    search: async (input) => {
      inputs.push(input);
      return {
        meta: {
          query: "needle",
          mode: input.mode ?? "hybrid",
          limit: 1,
          minScore: 0.1,
          count: 1,
          vectorAvailable: true,
        },
        results: [{ threadId: "external", title: "External", brief: "needle", score: 1.25 }],
      };
    },
  };
  const service = new NativeSearchService({ store, searchStore: messages, externalThreads });
  for (const verbose of [true, false]) {
    const result = await service
      .forUser("owner")
      .search({ query: "needle", mode: "hybrid", limit: 1, verbose });
    expect(result.meta).toMatchObject({ mode: "lexical", vectorAvailable: false, count: 1 });
    expect(result.results.map((hit) => hit.threadId)).toEqual(["external"]);
    expect(result.results[0]!.score).toBe(verbose ? 1.25 : undefined);
  }
  expect(inputs.every((input) => input.mode === "lexical" && input.verbose)).toBe(true);
});

test("message ranking includes older strong matches beyond the first candidate page", () => {
  const origin = thread("alice", "needle title", "older text");
  db.run(
    "UPDATE native_records SET data_json=json_set(data_json,'$.value.messages[0].metadata.createdAt',1) WHERE kind='turn' AND id=?",
    [origin.turnId],
  );
  const recent = thread("alice", "Recent", "needle");
  for (let index = 0; index < 500; index++)
    store
      .postMessage("alice", recent.id, {
        id: `recent-${index}`,
        role: "user",
        metadata: { authorId: "alice", createdAt: 1000 },
        parts: [{ type: "text", text: "needle" }],
      })
      .unwrap();
  const result = search
    .conversationSearch("alice", { query: "needle", limit: 1, minScore: 0.5 })
    .unwrap();
  expect(result.results.map((hit) => hit.threadId)).toEqual([origin.id]);
});

test("summary ranking includes older strong matches beyond the first candidate page", () => {
  const summaries = new NativeSummaryStore({ db, store });
  summaries.initialize().unwrap();
  let strongest = "";
  for (let index = 0; index < 103; index++) {
    const origin = thread("alice", `Summary ${index}`, "Unrelated message");
    summaries
      .put({
        threadId: origin.id,
        historyGeneration: 0,
        contentRevision: store.getThreadRecord(origin.id).unwrap().revision,
        generatedAt: 1000,
        messageCount: 1,
        summary: normalizeNativeSummary({
          title: index === 0 ? "needle" : "Weak match",
          brief: "needle",
          topics: [],
        }),
      })
      .unwrap();
    if (index !== 0) continue;
    strongest = origin.id;
    db.run("UPDATE native_records SET updated_at=1 WHERE kind='thread' AND id=?", [origin.id]);
  }
  const service = new NativeSearchService({ store, searchStore: messages, summaries });
  const result = service
    .conversationSearch("alice", { query: "needle", limit: 1, minScore: 0.5 })
    .unwrap();
  expect(result.results.map((hit) => hit.threadId)).toEqual([strongest]);
});

test("lexical scoring preserves summary importance field matches", () => {
  const origin = thread("alice", "Unrelated", "message");
  const summaries = new NativeSummaryStore({ db, store });
  summaries.initialize().unwrap();
  summaries
    .put({
      threadId: origin.id,
      historyGeneration: 0,
      contentRevision: store.getThreadRecord(origin.id).unwrap().revision,
      generatedAt: 1000,
      messageCount: 1,
      summary: normalizeNativeSummary({
        title: "Summary",
        brief: "Description",
        topics: [],
        importance: "high",
        importanceReasons: ["needle"],
      }),
    })
    .unwrap();
  const service = new NativeSearchService({ store, searchStore: messages, summaries });
  for (const query of ["needle", "high needle"]) {
    expect(
      service.conversationSearch("alice", { query, verbose: true }).unwrap().results,
    ).toMatchObject([{ threadId: origin.id, score: 0.2 }]);
  }
});
