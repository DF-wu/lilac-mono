import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Result } from "better-result";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import { NativeStore } from "./store";
import { NativeSearchStore } from "./store-search";
import { NativeSummaryStore } from "./store-search-summary";
import { NativeSummaryRefresher } from "./search-summary";
import {
  decodeNativeSummary,
  nativeSummaryCodecCases,
  normalizeNativeSummary,
} from "./search-summary-codec";

let db: Database;
let store: NativeStore;
let summaries: NativeSummaryStore;
let search: NativeSearchStore;
beforeEach(() => {
  db = new Database(":memory:");
  store = new NativeStore(db);
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
  summaries = new NativeSummaryStore({ db, store });
  summaries.initialize().unwrap();
  search = new NativeSearchStore({ db, store });
});
afterEach(() => db.close());
function createThread() {
  const thread = store.createThread("alice", { commandId: crypto.randomUUID() }).unwrap();
  const receipt = store
    .acceptInput("alice", {
      threadId: thread.id,
      commandId: crypto.randomUUID(),
      text: "A specific topic",
      historyGeneration: 0,
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    })
    .unwrap();
  return { thread: store.getThreadRecord(thread.id).unwrap(), receipt };
}
const summary = normalizeNativeSummary({
  title: "Summary title",
  brief: "A specific topic",
  topics: ["topic"],
});

test("native summaries use current authority and disappear after rewind", () => {
  const { thread, receipt } = createThread();
  expect(
    summaries
      .put({
        threadId: thread.id,
        historyGeneration: 0,
        contentRevision: thread.revision,
        generatedAt: 1,
        messageCount: 1,
        summary,
      })
      .unwrap(),
  ).toBe(true);
  expect(summaries.search("bob", { query: "topic", limit: 10 }).unwrap()).toEqual([]);
  store.shareThread("owner", { threadId: thread.id, userId: "bob", grant: "read" }).unwrap();
  expect(summaries.search("bob", { query: "topic", limit: 10 }).unwrap()).toHaveLength(1);
  store.shareThread("owner", { threadId: thread.id, userId: "bob", grant: null }).unwrap();
  expect(summaries.search("bob", { query: "topic", limit: 10 }).unwrap()).toEqual([]);
  const current = store.getThreadRecord(thread.id).unwrap();
  store
    .beginRewind("alice", {
      threadId: thread.id,
      commandId: "rewind",
      turnId: receipt.turnId!,
      revision: current.revision,
      historyGeneration: 0,
    })
    .unwrap();
  expect(summaries.get(thread.id).unwrap()).toBeNull();
  expect(summaries.search("owner", { query: "topic", limit: 10 }).unwrap()).toEqual([]);
});

test("active threads refresh without a quiet period, and old revisions cannot overwrite new summaries", async () => {
  const { thread } = createThread();
  store.setActiveRun(thread.id, 0, "run").unwrap();
  const refresher = new NativeSummaryRefresher({
    store,
    search,
    summaries,
    getConfig: () => ({}) as CoreConfig,
    summarize: async () => Result.ok(summary),
  });
  expect((await refresher.refresh()).unwrap()).toEqual({ refreshed: 1, discarded: 0 });
  expect((await refresher.refresh()).unwrap()).toEqual({ refreshed: 0, discarded: 0 });
  expect(
    summaries
      .put({
        threadId: thread.id,
        historyGeneration: 0,
        contentRevision: 0,
        generatedAt: 2,
        messageCount: 1,
        summary,
      })
      .unwrap(),
  ).toBe(false);
});

test("rewind while generation is in flight discards the late summary", async () => {
  const { thread, receipt } = createThread();
  const refresher = new NativeSummaryRefresher({
    store,
    search,
    summaries,
    getConfig: () => ({}) as CoreConfig,
    summarize: async () => {
      const current = store.getThreadRecord(thread.id).unwrap();
      store
        .beginRewind("alice", {
          threadId: thread.id,
          commandId: "rewind",
          turnId: receipt.turnId!,
          revision: current.revision,
          historyGeneration: 0,
        })
        .unwrap();
      return Result.ok(summary);
    },
  });
  expect((await refresher.refresh()).unwrap()).toEqual({ refreshed: 0, discarded: 1 });
  expect(summaries.get(thread.id).unwrap()).toBeNull();
});

for (const [name, fixture] of Object.entries(nativeSummaryCodecCases)) {
  test(`native summary codec ${name}`, () => {
    const result = decodeNativeSummary(fixture.input);
    if (fixture.outcome === "ok") {
      expect(result.unwrap().provenance).toBe(fixture.provenance);
      return;
    }
    const error = result.match({ ok: () => null, err: (value) => value });
    expect(error?._tag).toBe(fixture.errorTag);
    expect(error?.issueCode).toBe(fixture.issueCode);
  });
}

test("long threads retain opening and recent context under a bounded model input", async () => {
  const { thread } = createThread();
  for (let index = 0; index < 220; index += 1) {
    store
      .postMessage("alice", thread.id, {
        id: `message-${index}`,
        role: "user",
        parts: [{ type: "text", text: `message-${index} ${"x".repeat(2000)}` }],
      })
      .unwrap();
  }
  let seen = false;
  const refresher = new NativeSummaryRefresher({
    store,
    search,
    summaries,
    getConfig: () => ({}) as CoreConfig,
    summarize: async (input) => {
      seen = true;
      expect(input.messages.length).toBe(200);
      expect(input.omittedMessages).toBe(21);
      expect(input.messages[0]!.text).toBe("A specific topic");
      expect(input.messages.at(-1)!.text.startsWith("message-219")).toBe(true);
      expect(
        input.messages.reduce((sum, message) => sum + message.text.length, 0),
      ).toBeLessThanOrEqual(96 * 1024);
      return Result.ok(summary);
    },
  });
  expect((await refresher.refresh()).unwrap().refreshed).toBe(1);
  expect(seen).toBe(true);
  expect(summaries.get(thread.id).unwrap()!.messageCount).toBe(221);
});

test("shutdown abort reaches in-flight summary generation and prevents the next candidate", async () => {
  const first = createThread();
  const second = createThread();
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const refresher = new NativeSummaryRefresher({
    store,
    search,
    summaries,
    getConfig: () => ({}) as CoreConfig,
    summarize: async (input) => {
      calls++;
      expect(input.abortSignal).toBe(controller.signal);
      started.resolve();
      await new Promise<void>((resolve) =>
        input.abortSignal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      return Result.ok(summary);
    },
  });
  const refresh = refresher.refresh({ abortSignal: controller.signal });
  await started.promise;
  controller.abort();
  expect((await refresh).unwrap()).toEqual({ refreshed: 0, discarded: 1 });
  expect(calls).toBe(1);
  expect(summaries.get(first.thread.id).unwrap()).toBeNull();
  expect(summaries.get(second.thread.id).unwrap()).toBeNull();
  expect((await refresher.refresh({ abortSignal: controller.signal })).unwrap().refreshed).toBe(0);
  expect(calls).toBe(1);
});

test("summary maintenance physically removes deleted and rewound private content", () => {
  const first = createThread();
  const second = createThread();
  for (const item of [first, second])
    summaries
      .put({
        threadId: item.thread.id,
        historyGeneration: 0,
        contentRevision: item.thread.revision,
        generatedAt: 1000,
        messageCount: 1,
        summary,
      })
      .unwrap();
  const deletion = store
    .deleteThread("alice", { threadId: first.thread.id, commandId: "delete_summary" })
    .unwrap();
  store.finishMutation(first.thread.id, deletion.historyGeneration!).unwrap();
  const rewind = store
    .beginRewind("alice", {
      threadId: second.thread.id,
      turnId: second.receipt.turnId!,
      commandId: "rewind_summary",
      historyGeneration: 0,
      revision: second.thread.revision,
    })
    .unwrap();
  store.finishMutation(second.thread.id, rewind.historyGeneration!).unwrap();
  expect(summaries.pruneDeleted().unwrap()).toBe(2);
  expect(db.query("SELECT count(*) AS count FROM native_thread_summaries").get()).toEqual({
    count: 0,
  });
});
