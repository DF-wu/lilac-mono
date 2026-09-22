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

let now: number;
let db: Database;
let store: NativeStore;
let summaries: NativeSummaryStore;
let search: NativeSearchStore;
beforeEach(() => {
  db = new Database(":memory:");
  now = 1000;
  store = new NativeStore(db, () => now);
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
function createThread(completed = true) {
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
  if (completed) {
    store.settleInput(receipt.inputId!, "admitted").unwrap();
    completeTurn(thread.id, receipt.turnId!);
    store.markInputCompleted(receipt.inputId!).unwrap();
    const second = store
      .acceptInput("alice", {
        threadId: thread.id,
        commandId: crypto.randomUUID(),
        text: "A follow-up",
        historyGeneration: 0,
        mode: "prompt",
        attachmentIds: [],
        skillIds: [],
      })
      .unwrap();
    store.settleInput(second.inputId!, "admitted").unwrap();
    completeTurn(thread.id, second.turnId!);
    store.markInputCompleted(second.inputId!).unwrap();
  }
  return { thread: store.getThreadRecord(thread.id).unwrap(), receipt };
}
function completeTurn(threadId: string, turnId: string) {
  store
    .projectTurn(threadId, 0, crypto.randomUUID(), turnId, (slot) =>
      Result.ok({
        slot: {
          ...slot,
          state: "complete",
          messages: [
            ...slot.messages,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              parts: [{ type: "text", text: "An answer" }],
            },
          ],
        },
        changes: [],
      }),
    )
    .unwrap();
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

test("summaries require two completed exchanges and an hour of inactivity", async () => {
  const { thread } = createThread();
  const short = createThread(false);
  completeTurn(short.thread.id, short.receipt.turnId!);
  const refresher = new NativeSummaryRefresher({
    store,
    search,
    summaries,
    getConfig: () => ({}) as CoreConfig,
    now: () => now,
    summarize: async () => Result.ok(summary),
  });
  now += 60 * 60 * 1000 - 1;
  expect((await refresher.refresh()).unwrap().eligible).toBe(0);
  now += 1;
  expect((await refresher.refresh()).unwrap().summarized).toBe(1);
  expect((await refresher.refresh()).unwrap().eligible).toBe(0);
  expect(summaries.get(short.thread.id).unwrap()).toBeNull();
  store.setActiveRun(thread.id, 0, "run").unwrap();
  now += 60 * 60 * 1000;
  expect((await refresher.refresh({ force: true })).unwrap().eligible).toBe(0);
});

test("rewind while generation is in flight discards the late summary", async () => {
  const { thread, receipt } = createThread();
  const refresher = new NativeSummaryRefresher({
    store,
    search,
    summaries,
    getConfig: () => ({}) as CoreConfig,
    now: () => now + 60 * 60 * 1000,
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
  expect((await refresher.refresh()).unwrap()).toMatchObject({ summarized: 0, eligible: 1 });
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
    now: () => now + 60 * 60 * 1000,
    summarize: async (input) => {
      seen = true;
      expect(input.messages.length).toBe(200);
      expect(input.omittedMessages).toBe(24);
      expect(input.messages[0]!.text).toBe("A specific topic");
      expect(input.messages.at(-1)!.text.startsWith("message-219")).toBe(true);
      expect(
        input.messages.reduce((sum, message) => sum + message.text.length, 0),
      ).toBeLessThanOrEqual(96 * 1024);
      return Result.ok(summary);
    },
  });
  expect((await refresher.refresh()).unwrap().summarized).toBe(1);
  expect(seen).toBe(true);
  expect(summaries.get(thread.id).unwrap()!.messageCount).toBe(224);
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
    now: () => now + 60 * 60 * 1000,
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
  expect((await refresh).unwrap()).toMatchObject({ summarized: 0, eligible: 2 });
  expect(calls).toBe(1);
  expect(summaries.get(first.thread.id).unwrap()).toBeNull();
  expect(summaries.get(second.thread.id).unwrap()).toBeNull();
  expect((await refresher.refresh({ abortSignal: controller.signal })).unwrap().summarized).toBe(0);
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

test("a message during generation leaves the revision dirty until the next quiet period", async () => {
  const { thread } = createThread();
  now += 60 * 60 * 1000;
  let calls = 0;
  const refresher = new NativeSummaryRefresher({
    store,
    search,
    summaries,
    getConfig: () => ({}) as CoreConfig,
    now: () => now,
    summarize: async () => {
      calls++;
      if (calls === 1)
        store
          .postMessage("alice", thread.id, {
            id: "late",
            role: "user",
            parts: [{ type: "text", text: "New context" }],
          })
          .unwrap();
      return Result.ok(summary);
    },
  });
  expect((await refresher.refresh()).unwrap().summarized).toBe(0);
  expect(summaries.get(thread.id).unwrap()).toBeNull();
  expect((await refresher.refresh()).unwrap().eligible).toBe(0);
  now += 60 * 60 * 1000;
  expect((await refresher.refresh()).unwrap().summarized).toBe(1);
  expect(summaries.get(thread.id).unwrap()?.contentRevision).toBe(
    store.getThreadRecord(thread.id).unwrap().revision,
  );
  expect((await refresher.refresh()).unwrap().eligible).toBe(0);
});

test("manual scopes, preview, force and clear use the same native eligibility", async () => {
  const first = createThread();
  now += 10;
  const second = createThread();
  now += 60 * 60 * 1000;
  let calls = 0;
  const refresher = new NativeSummaryRefresher({
    store,
    search,
    summaries,
    getConfig: () => ({}) as CoreConfig,
    now: () => now,
    summarize: async () => {
      calls++;
      return Result.ok(summary);
    },
  });
  const preview = (await refresher.refresh({ dryRun: true, limit: 1 })).unwrap();
  expect(preview).toMatchObject({
    eligible: 1,
    eligibleTotal: 2,
    summarized: 0,
    threadIds: [first.thread.id],
  });
  expect(calls).toBe(0);
  expect((await refresher.refresh({ threadId: "discord-thread" })).unwrap().eligible).toBe(0);
  expect(
    (await refresher.refresh({ beforeTs: first.thread.updatedAt })).unwrap().threadIds,
  ).toEqual([first.thread.id]);
  expect(
    (
      await refresher.refresh({
        afterTs: second.thread.updatedAt,
        threadId: `native:${second.thread.id}`,
      })
    ).unwrap().summarized,
  ).toBe(1);
  expect((await refresher.refresh()).unwrap().eligible).toBe(0);
  expect(
    (await refresher.refresh({ force: true, threadId: first.thread.id })).unwrap().summarized,
  ).toBe(1);
  const clearPreview = (
    await refresher.refresh({ clear: true, dryRun: true, threadId: first.thread.id })
  ).unwrap();
  expect(clearPreview).toMatchObject({ eligible: 1, cleared: 0, summarized: 0 });
  expect(calls).toBe(3);
  expect(summaries.get(first.thread.id).unwrap()).not.toBeNull();
  expect(
    (await refresher.refresh({ clear: true, threadId: first.thread.id })).unwrap(),
  ).toMatchObject({ cleared: 1, summarized: 1 });
  expect(summaries.get(second.thread.id).unwrap()).not.toBeNull();
});

test("rewind summarizes only the retained visible exchanges after inactivity", async () => {
  const { thread } = createThread();
  const third = store
    .acceptInput("alice", {
      threadId: thread.id,
      commandId: "third",
      text: "Discard me",
      historyGeneration: 0,
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    })
    .unwrap();
  store.settleInput(third.inputId!, "admitted").unwrap();
  completeTurn(thread.id, third.turnId!);
  store.markInputCompleted(third.inputId!).unwrap();
  now += 60 * 60 * 1000;
  const refresher = new NativeSummaryRefresher({
    store,
    search,
    summaries,
    getConfig: () => ({}) as CoreConfig,
    now: () => now,
    summarize: async (input) => {
      expect(input.messages.some((message) => message.text === "Discard me")).toBe(false);
      expect(input.previousSummary).toBeNull();
      return Result.ok(summary);
    },
  });
  const current = store.getThreadRecord(thread.id).unwrap();
  store
    .beginRewind("alice", {
      threadId: thread.id,
      commandId: "rewind-third",
      turnId: third.turnId!,
      revision: current.revision,
      historyGeneration: 0,
    })
    .unwrap();
  store.finishMutation(thread.id, 1).unwrap();
  expect((await refresher.refresh()).unwrap().eligible).toBe(0);
  now += 60 * 60 * 1000;
  expect((await refresher.refresh()).unwrap().summarized).toBe(1);
  expect(summaries.get(thread.id).unwrap()?.historyGeneration).toBe(1);
});

test("standalone assistant messages and failed turns do not count as completed exchanges", () => {
  const { thread, receipt } = createThread(false);
  completeTurn(thread.id, receipt.turnId!);
  store
    .postMessage("alice", thread.id, {
      id: "standalone",
      role: "assistant",
      parts: [{ type: "text", text: "Standalone" }],
    })
    .unwrap();
  now += 60 * 60 * 1000;
  expect(summaries.candidates({ now }).unwrap()).toHaveLength(0);
  store
    .projectTurn(thread.id, 0, "fail", receipt.turnId!, (slot) =>
      Result.ok({ slot: { ...slot, state: "failed" }, changes: [] }),
    )
    .unwrap();
  now += 60 * 60 * 1000;
  expect(summaries.candidates({ now, force: true }).unwrap()).toHaveLength(0);
});

test("regeneration does not feed removed content back through an older summary", async () => {
  const { thread } = createThread();
  store
    .postMessage("alice", thread.id, {
      id: "remove",
      role: "assistant",
      parts: [{ type: "text", text: "Removed topic" }],
    })
    .unwrap();
  now += 60 * 60 * 1000;
  let calls = 0;
  const refresher = new NativeSummaryRefresher({
    store,
    search,
    summaries,
    getConfig: () => ({}) as CoreConfig,
    now: () => now,
    summarize: async (input) => {
      calls++;
      if (calls === 1)
        return Result.ok(
          normalizeNativeSummary({ title: "Removed topic", brief: "Removed topic", topics: [] }),
        );
      expect(input.previousSummary).toBeNull();
      expect(input.messages.some((message) => message.text.includes("Removed topic"))).toBe(false);
      return Result.ok(summary);
    },
  });
  expect((await refresher.refresh()).unwrap().summarized).toBe(1);
  store.updateSurfaceMessage("alice", thread.id, "remove", null).unwrap();
  expect((await refresher.refresh()).unwrap().eligible).toBe(0);
  now += 60 * 60 * 1000;
  expect((await refresher.refresh()).unwrap().summarized).toBe(1);
  expect(summaries.get(thread.id).unwrap()?.summary.title).toBe("Summary title");
});
