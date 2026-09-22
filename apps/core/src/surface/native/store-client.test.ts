import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { NativeThreadStore } from "../../../../../packages/client/src/thread-store";
import { replayReplySchema, turnPageSchema } from "@stanley2058/lilac-client-protocol";
import { NativeStore } from "./store";

test("huge turns paint recent content then hydrate without duplicate or reordered messages", () => {
  const store = new NativeStore(new Database(":memory:"));
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
  const receipt = store
    .acceptInput("owner", {
      threadId: thread.id,
      commandId: "input",
      historyGeneration: 0,
      text: "hello",
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    })
    .unwrap();
  for (let i = 0; i < 50; i++)
    store
      .appendMessage(thread.id, 0, receipt.turnId!, {
        id: `message_${i}`,
        role: "assistant",
        parts: [{ type: "text", text: `${i}:` + "漢".repeat(6000) }],
      })
      .unwrap();
  const reply = store.sync("owner", thread.id).unwrap();
  expect(replayReplySchema.safeParse(reply).success).toBe(true);
  const client = new NativeThreadStore();
  expect(client.replay(reply)).toBe("applied");
  const slotId = receipt.turnId!;
  let slot = client.get(slotId);
  expect(slot?.kind).toBe("ready");
  if (slot?.kind !== "ready") return;
  expect(slot.messages.at(-1)?.id).toBe("message_49");
  let pages = 0;
  while (slot.partsCursor) {
    const cursor = slot.partsCursor;
    const page = store
      .turnPage("owner", {
        threadId: thread.id,
        turnId: slot.turnId,
        historyGeneration: reply.checkpoint.historyGeneration,
        projectionRevision: reply.checkpoint.projectionRevision,
        cursor,
      })
      .unwrap();
    expect(turnPageSchema.safeParse(page).success).toBe(true);
    expect(client.turnPage(slotId, cursor, page)).toBe("applied");
    const next = client.get(slotId);
    if (next?.kind !== "ready") throw new Error("Lost turn");
    slot = next;
    pages++;
    expect(pages).toBeLessThan(10);
  }
  expect(slot.messages).toHaveLength(51);
  expect(slot.messages[0]?.role).toBe("user");
  expect(slot.messages.slice(1).map((message) => message.id)).toEqual(
    Array.from({ length: 50 }, (_, i) => `message_${i}`),
  );
});

test("steering and removed queued inputs do not create gaps in deferred turn coverage", () => {
  const store = new NativeStore(new Database(":memory:"));
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
  const base = {
    threadId: thread.id,
    historyGeneration: 0,
    text: "hello",
    mode: "prompt" as const,
    attachmentIds: [],
    skillIds: [],
  };
  const first = store.acceptInput("owner", { ...base, commandId: "first" }).unwrap();
  const prepared = store.prepareInput(first.inputId).unwrap()!;
  store.settleInput(first.inputId, "admitted").unwrap();
  store.setActiveRun(thread.id, 0, prepared.requestId).unwrap();
  store.acceptInput("owner", { ...base, commandId: "steer", mode: "steer" }).unwrap();
  const queued = store
    .acceptInput("owner", { ...base, commandId: "queued", mode: "followup" })
    .unwrap();
  store.removeInput("owner", queued.inputId).unwrap();
  store.setActiveRun(thread.id, 0).unwrap();
  store.markInputCompleted(first.inputId).unwrap();
  for (let i = 0; i < 7; i++) {
    const input = store.acceptInput("owner", { ...base, commandId: `next_${i}` }).unwrap();
    store.prepareInput(input.inputId).unwrap();
    store.settleInput(input.inputId, "admitted").unwrap();
    store.markInputCompleted(input.inputId).unwrap();
  }
  const reply = store.sync("owner", thread.id).unwrap();
  const client = new NativeThreadStore();
  expect(client.replay(reply)).toBe("applied");
  const deferred = client.at(0);
  expect(deferred?.kind).toBe("deferred");
  if (deferred?.kind !== "deferred") return;
  const hydration = store
    .hydrate("owner", {
      threadId: thread.id,
      slotId: deferred.slotId,
      historyGeneration: reply.checkpoint.historyGeneration,
      projectionRevision: reply.checkpoint.projectionRevision,
    })
    .unwrap();
  expect(client.hydrate(hydration)).toBe("applied");
  expect(client.slotIds.map((id) => client.get(id)?.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
});

test("renaming a cached thread advances its cursor without repeating message text", () => {
  const store = new NativeStore(new Database(":memory:"));
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
  store
    .acceptInput("owner", {
      threadId: thread.id,
      commandId: "input",
      historyGeneration: 0,
      text: "secret visible history",
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    })
    .unwrap();
  const before = store.sync("owner", thread.id).unwrap();
  store
    .updateThread("owner", { threadId: thread.id, commandId: "rename", title: "Renamed" })
    .unwrap();
  const after = store.sync("owner", thread.id, before.checkpoint).unwrap();
  expect(replayReplySchema.safeParse(after).success).toBe(true);
  expect(after.kind).toBe("delta");
  expect(JSON.stringify(after)).not.toContain("secret visible history");
  expect(JSON.stringify(after).length).toBeLessThan(1024);
  const client = new NativeThreadStore();
  expect(client.replay(before)).toBe("applied");
  expect(client.replay(after)).toBe("applied");
});
