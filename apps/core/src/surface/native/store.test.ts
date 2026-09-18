import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Result } from "better-result";
import { nativeThreadSchema, nativeInputReceiptSchema } from "@stanley2058/lilac-client-protocol";
import { NativeStore } from "./store";
import { decodeNativeRecord, nativeRecordCodecCases } from "./codec";
import { nativeFailure } from "./errors";

function fixture(db = new Database(":memory:")) {
  let now = 1000;
  const store = new NativeStore(db, () => ++now);
  store.initialize().unwrap();
  for (const [id, role, toolMode] of [
    ["owner", "owner", "full"],
    ["alice", "participant", "full"],
    ["bob", "participant", "restricted"],
    ["lilac", "service", "full"],
  ] as const)
    store.upsertUser({ id, providerId: id, displayName: id, role, toolMode }).unwrap();
  return { store, db };
}
function prompt(threadId: string, commandId: string, text = "Hello", historyGeneration = 0) {
  return {
    threadId,
    commandId,
    historyGeneration,
    text,
    mode: "prompt" as const,
    attachmentIds: [],
    skillIds: [],
  };
}

describe("native store codecs", () => {
  for (const [name, fixture] of Object.entries(nativeRecordCodecCases))
    test(name, () => {
      expect(decodeNativeRecord(fixture.input).status).toBe(
        fixture.outcome === "ok" ? "ok" : "error",
      );
    });
});
describe("native store authority and admission", () => {
  test("owner sees all, starter retains restricted access, shared restricted users only read", () => {
    const { store } = fixture();
    const a = store.createThread("alice", { commandId: "new" }).unwrap();
    expect(store.getThread("bob", a.id).isErr()).toBe(true);
    store.shareThread("owner", { threadId: a.id, userId: "bob", grant: "edit" }).unwrap();
    expect(store.getThread("bob", a.id).unwrap().capabilities).toEqual({
      read: true,
      edit: false,
      share: false,
    });
    expect(store.acceptInput("bob", prompt(a.id, "send")).isErr()).toBe(true);
    const b = store.createThread("bob", { commandId: "new" }).unwrap();
    expect(store.getThread("bob", b.id).unwrap().capabilities.edit).toBe(true);
    expect(store.listThreads("owner").unwrap()).toHaveLength(2);
    expect(
      store.shareThread("alice", { threadId: a.id, userId: "bob", grant: "edit" }).isErr(),
    ).toBe(true);
  });
  test("command receipts deduplicate and conflict; generation fences stale inputs", () => {
    const { store } = fixture();
    const thread = store.createThread("alice", { commandId: "new" }).unwrap();
    expect(store.createThread("alice", { commandId: "new" }).unwrap().id).toBe(thread.id);
    const receipt = store.acceptInput("alice", prompt(thread.id, "send")).unwrap();
    expect(store.acceptInput("alice", prompt(thread.id, "send")).unwrap()).toEqual(receipt);
    expect(store.acceptInput("alice", prompt(thread.id, "send", "Different")).isErr()).toBe(true);
    expect(store.acceptInput("alice", prompt(thread.id, "stale", "x", 4)).isErr()).toBe(true);
  });
  test("pending uploads survive acceptance and cancellation prevents late admission", () => {
    const { store } = fixture();
    const thread = store.createThread("alice", { commandId: "new" }).unwrap();
    const upload = store
      .reserveUpload("alice", {
        threadId: thread.id,
        filename: "large.bin",
        mediaType: "application/octet-stream",
        size: 2 ** 28,
      })
      .unwrap();
    const receipt = store
      .acceptInput("alice", { ...prompt(thread.id, "send"), attachmentIds: [upload.id] })
      .unwrap();
    expect(receipt.state).toBe("uploading");
    expect(store.prepareInput(receipt.inputId).unwrap()).toBeNull();
    store.cancelRun("alice", thread.id).unwrap();
    expect(store.claimUpload("alice", upload.id).isErr()).toBe(true);
    expect(
      store
        .settleUpload(upload.id, {
          attempt: upload.attempt,
          historyGeneration: 0,
          state: "ready",
          resourceUri: "resource://upload",
        })
        .isErr(),
    ).toBe(true);
    expect(store.prepareInput(receipt.inputId).unwrap()).toBeNull();
  });
  test("ready input pins starter authority and admitted retry preserves identity", () => {
    const { store } = fixture();
    const thread = store.createThread("bob", { commandId: "new" }).unwrap();
    const receipt = store.acceptInput("bob", prompt(thread.id, "send")).unwrap();
    const ready = store.prepareInput(receipt.inputId).unwrap()!;
    expect(ready.pinnedToolMode).toBe("restricted");
    store.settleInput(ready.id, "admitted").unwrap();
    store.setToolMode("owner", "bob", "full").unwrap();
    expect(store.prepareInput(ready.id).unwrap()?.pinnedToolMode).toBe("restricted");
  });
  test("projection failure rolls back changed record and receipt", () => {
    const { store } = fixture();
    const thread = store.createThread("alice", { commandId: "new" }).unwrap();
    const receipt = store.acceptInput("alice", prompt(thread.id, "send")).unwrap();
    const before = store.getThreadRecord(thread.id).unwrap().revision;
    expect(
      store
        .projectTurn(thread.id, 0, "event1", receipt.turnId!, () =>
          Result.err(nativeFailure("invalid", "No")),
        )
        .isErr(),
    ).toBe(true);
    expect(store.getThreadRecord(thread.id).unwrap().revision).toBe(before);
    store
      .appendMessage(
        thread.id,
        0,
        receipt.turnId!,
        { id: "assistant", role: "assistant", parts: [{ type: "text", text: "Hi" }] },
        "event1",
      )
      .unwrap();
    store
      .appendMessage(
        thread.id,
        0,
        receipt.turnId!,
        { id: "assistant", role: "assistant", parts: [{ type: "text", text: "Hi" }] },
        "event1",
      )
      .unwrap();
    expect(store.getThreadRecord(thread.id).unwrap().revision).toBe(before + 1);
  });
  test("rewind removes suffix, preserves prefix canonical pointer, fences late output", () => {
    const { store } = fixture();
    const thread = store.createThread("alice", { commandId: "new" }).unwrap();
    const a = store.acceptInput("alice", prompt(thread.id, "a")).unwrap();
    store.prepareInput(a.inputId).unwrap();
    store.settleInput(a.inputId, "admitted").unwrap();
    store.markInputCompleted(a.inputId).unwrap();
    const b = store.acceptInput("alice", prompt(thread.id, "b", "second")).unwrap();
    const current = store.getThreadRecord(thread.id).unwrap();
    const result = store
      .beginRewind("alice", {
        threadId: thread.id,
        commandId: "rewind",
        turnId: b.turnId!,
        historyGeneration: 0,
        revision: current.revision,
      })
      .unwrap();
    expect(result.text).toBe("second");
    expect(store.getLatestCanonicalRequestId(thread.id).unwrap()).toBe(
      store.getInput(a.inputId).unwrap().requestId,
    );
    expect(
      store
        .appendMessage(thread.id, 0, b.turnId!, { id: "late", role: "assistant", parts: [] })
        .isErr(),
    ).toBe(true);
    expect(store.acceptInput("alice", prompt(thread.id, "post-rewind", "x", 1)).isErr()).toBe(true);
    store.finishMutation(thread.id, 1).unwrap();
    expect(store.acceptInput("alice", prompt(thread.id, "post-rewind", "x", 1)).isOk()).toBe(true);
  });
  test("latest window uses deferred history and unchanged cursor stays tiny after pruning", () => {
    const { store, db } = fixture();
    const thread = store.createThread("alice", { commandId: "new" }).unwrap();
    for (let i = 0; i < 12; i++) {
      const input = store.acceptInput("alice", prompt(thread.id, `send${i}`)).unwrap();
      store.prepareInput(input.inputId).unwrap();
      store.settleInput(input.inputId, "admitted").unwrap();
      store.markInputCompleted(input.inputId).unwrap();
    }
    const reply = store.sync("alice", thread.id).unwrap();
    expect(reply.kind).toBe("window");
    if (reply.kind !== "window") return;
    expect(reply.slots).toHaveLength(6);
    expect(reply.slots[0]?.kind).toBe("deferred");
    db.run("DELETE FROM native_changes");
    const same = store.sync("alice", thread.id, reply.checkpoint).unwrap();
    expect(same.kind).toBe("unchanged");
    expect(JSON.stringify(same).length).toBeLessThan(1024);
  });
});

describe("native store replay durability", () => {
  test("replays only appended text metadata and validates persisted replay", () => {
    const { store } = fixture();
    const thread = store.createThread("alice", { commandId: "new" }).unwrap();
    const receipt = store.acceptInput("alice", prompt(thread.id, "input")).unwrap();
    store
      .appendMessage(thread.id, 0, receipt.turnId!, {
        id: "reply",
        role: "assistant",
        parts: [{ type: "text", text: "old" }],
      })
      .unwrap();
    const before = store.sync("alice", thread.id).unwrap().checkpoint;
    store
      .projectTurn(thread.id, 0, "chunk", receipt.turnId!, (slot) =>
        Result.ok({
          slot: {
            ...slot,
            messages: slot.messages.map((message) =>
              message.id === "reply"
                ? { ...message, parts: [{ type: "text", text: "old new" }] }
                : message,
            ),
          },
          changes: [
            {
              kind: "append-text",
              turnId: slot.turnId,
              position: slot.position,
              messageId: "reply",
              partIndex: 0,
              text: " new",
            },
          ],
        }),
      )
      .unwrap();
    const reply = store.sync("alice", thread.id, before).unwrap();
    expect(reply.kind).toBe("delta");
    expect(JSON.stringify(reply)).not.toContain('"old"');
    expect(JSON.stringify(reply)).toContain('" new"');
  });
  test("checkpoint for another thread cannot return unchanged", () => {
    const { store } = fixture();
    const a = store.createThread("alice", { commandId: "a" }).unwrap();
    const b = store.createThread("alice", { commandId: "b" }).unwrap();
    const checkpoint = store.sync("alice", a.id).unwrap().checkpoint;
    expect(store.sync("alice", b.id, checkpoint).unwrap().kind).toBe("window");
  });
  test("persisted corrupt input fails rather than silently skipping work", () => {
    const { store, db } = fixture();
    const thread = store.createThread("alice", { commandId: "new" }).unwrap();
    const receipt = store.acceptInput("alice", prompt(thread.id, "input")).unwrap();
    db.query("UPDATE native_records SET data_json='{' WHERE kind='input' AND id=?").run(
      receipt.inputId,
    );
    expect(store.listPendingInputs(thread.id).isErr()).toBe(true);
  });
  test("revision and receipt recover from a reopened disk database", () => {
    const path = `/tmp/lilac-native-store-${crypto.randomUUID()}.sqlite`;
    const db = new Database(path);
    const store = new NativeStore(db);
    store.initialize().unwrap();
    store
      .upsertUser({
        id: "owner",
        providerId: "local",
        displayName: "Owner",
        role: "owner",
        toolMode: "full",
      })
      .unwrap();
    const thread = store.createThread("owner", { commandId: "new" }).unwrap();
    const receipt = store.acceptInput("owner", prompt(thread.id, "input")).unwrap();
    const checkpoint = store.sync("owner", thread.id).unwrap().checkpoint;
    store.close();
    const reopened = new NativeStore(new Database(path));
    reopened.initialize().unwrap();
    expect(reopened.acceptInput("owner", prompt(thread.id, "input")).unwrap()).toEqual(receipt);
    expect(reopened.sync("owner", thread.id, checkpoint).unwrap().kind).toBe("unchanged");
    reopened.close();
    return Bun.file(path).delete();
  });
});

test("completed deletion removes native payloads while keeping fencing and idempotency receipts", () => {
  const path = `/tmp/lilac-native-delete-${crypto.randomUUID()}.sqlite`;
  const { store, db } = fixture(new Database(path));
  const thread = store
    .createThread("alice", { commandId: "create", title: "private title" })
    .unwrap();
  const upload = store
    .reserveUpload("alice", {
      threadId: thread.id,
      filename: "private file.txt",
      mediaType: "text/plain",
      size: 2,
    })
    .unwrap();
  const receipt = store
    .acceptInput("alice", {
      ...prompt(thread.id, "input", "private prompt"),
      attachmentIds: [upload.id],
    })
    .unwrap();
  store.registerPublishedPath("alice", thread.id, "/private/path").unwrap();
  store
    .appendMessage(thread.id, 0, receipt.turnId!, {
      id: "response",
      role: "assistant",
      parts: [{ type: "text", text: "private response" }],
    })
    .unwrap();
  const checkpoint = store.sync("alice", thread.id).unwrap().checkpoint;
  const deleted = store
    .deleteThread("alice", { threadId: thread.id, commandId: "delete" })
    .unwrap();
  expect(store.getInput(receipt.inputId).unwrap().text).toBe("private prompt");
  store.finishMutation(thread.id, deleted.historyGeneration!).unwrap();
  const persisted = db
    .query<{ data_json: string }, [string]>(
      "SELECT data_json FROM native_records WHERE thread_id=?",
    )
    .all(thread.id)
    .map((row) => row.data_json)
    .join("\n");
  expect(persisted).not.toContain("private");
  expect(store.getUpload(upload.id).isErr()).toBe(true);
  expect(store.getInput(receipt.inputId).unwrap().state).toBe("canceled");
  expect(store.sync("alice", thread.id, checkpoint).isErr()).toBe(true);
  expect(
    store.deleteThread("alice", { threadId: thread.id, commandId: "delete" }).unwrap(),
  ).toEqual(deleted);
  expect(
    store
      .appendMessage(thread.id, 0, receipt.turnId!, { id: "late", role: "assistant", parts: [] })
      .isErr(),
  ).toBe(true);
  store.finishMutation(thread.id, deleted.historyGeneration!).unwrap();
  store.close();
  const reopened = new NativeStore(new Database(path));
  reopened.initialize().unwrap();
  expect(reopened.sync("alice", thread.id, checkpoint).isErr()).toBe(true);
  expect(reopened.getInput(receipt.inputId).unwrap().text).toBe("");
  expect(
    reopened.deleteThread("alice", { threadId: thread.id, commandId: "delete" }).unwrap(),
  ).toEqual(deleted);
  reopened.close();
  return Bun.file(path).delete();
});

test("input receipt lookup settles retry before catalog validation and rejects conflicting content", () => {
  const { store } = fixture();
  const thread = store.createThread("alice", { commandId: "create" }).unwrap();
  const input = prompt(thread.id, "input", "same");
  expect(store.lookupInputReceipt("alice", input).unwrap()).toBeNull();
  const accepted = store.acceptInput("alice", input).unwrap();
  expect(store.lookupInputReceipt("alice", input).unwrap()).toEqual(accepted);
  expect(store.lookupInputReceipt("alice", { ...input, text: "different" }).isErr()).toBe(true);
});

test("canonical history boundary pins once on admitted current-generation inputs", () => {
  const { store } = fixture();
  const thread = store.createThread("alice", { commandId: "thread" }).unwrap();
  const first = store.acceptInput("alice", prompt(thread.id, "first")).unwrap();
  const firstInput = store.getInput(first.inputId).unwrap();
  expect(store.setInputCanonicalHistoryStart(first.inputId, firstInput.requestId).isErr()).toBe(
    true,
  );
  store.prepareInput(first.inputId).unwrap();
  store.settleInput(first.inputId, "admitted").unwrap();
  store.setInputCanonicalHistoryStart(first.inputId, firstInput.requestId).unwrap();
  store.setInputCanonicalHistoryStart(first.inputId, firstInput.requestId).unwrap();
  store.markInputCompleted(first.inputId).unwrap();
  const second = store.acceptInput("alice", prompt(thread.id, "second")).unwrap();
  const secondInput = store.prepareInput(second.inputId).unwrap()!;
  store.settleInput(second.inputId, "admitted").unwrap();
  store.setInputCanonicalHistoryStart(second.inputId, firstInput.requestId).unwrap();
  expect(store.getInput(second.inputId).unwrap().canonicalHistoryStartRequestId).toBe(
    firstInput.requestId,
  );
  expect(store.setInputCanonicalHistoryStart(second.inputId, secondInput.requestId).isErr()).toBe(
    true,
  );
  const current = store.getThreadRecord(thread.id).unwrap();
  store
    .beginRewind("alice", {
      threadId: thread.id,
      commandId: "rewind",
      turnId: secondInput.turnId!,
      historyGeneration: 0,
      revision: current.revision,
    })
    .unwrap();
  expect(store.setInputCanonicalHistoryStart(second.inputId, firstInput.requestId).isErr()).toBe(
    true,
  );
});
