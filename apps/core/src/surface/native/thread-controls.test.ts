import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  nativeInputReceiptSchema,
  nativeThreadSchema,
  replayReplySchema,
} from "@stanley2058/lilac-client-protocol";
import { NativeStore } from "./store";

test("pending uploads keep prompt mode and active runs expose the actual cancellation target", () => {
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
  const thread = store.createThread("owner", { commandId: "create" }).unwrap();
  const upload = store
    .reserveUpload("owner", {
      threadId: thread.id,
      filename: "large.bin",
      mediaType: "application/octet-stream",
      size: 1_000_000,
    })
    .unwrap();
  const uploading = store
    .acceptInput("owner", {
      threadId: thread.id,
      commandId: "uploading",
      historyGeneration: 0,
      text: "First",
      mode: "prompt",
      attachmentIds: [upload.id],
      skillIds: [],
    })
    .unwrap();
  expect(uploading.state).toBe("uploading");
  expect(
    nativeThreadSchema.parse(store.getThread("owner", thread.id).unwrap()).activeRunId,
  ).toBeUndefined();
  const queued = store
    .acceptInput("owner", {
      threadId: thread.id,
      commandId: "queued",
      historyGeneration: 0,
      text: "Second",
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    })
    .unwrap();
  expect(queued.state).toBe("queued");
  expect(queued.turnId).toBeUndefined();
  store.cancelRun("owner", thread.id).unwrap();
  const canceled = replayReplySchema.parse(store.sync("owner", thread.id).unwrap());
  expect(canceled.kind).toBe("window");
  if (canceled.kind === "window") expect(canceled.slots[0]).toMatchObject({ state: "canceled" });
  expect(store.getInput(queued.inputId).unwrap().state).toBe("canceled");
  const next = store
    .acceptInput("owner", {
      threadId: thread.id,
      commandId: "next",
      historyGeneration: 0,
      text: "Third",
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    })
    .unwrap();
  const requestId = store.getInput(next.inputId).unwrap().requestId;
  expect(requestId.startsWith("native:")).toBe(true);
  store.setActiveRun(thread.id, 0, requestId).unwrap();
  expect(nativeThreadSchema.parse(store.getThread("owner", thread.id).unwrap()).activeRunId).toBe(
    requestId,
  );
  const steer = store
    .acceptInput("owner", {
      threadId: thread.id,
      commandId: "steer",
      historyGeneration: 0,
      text: "Steer",
      mode: "steer",
      attachmentIds: [],
      skillIds: [],
    })
    .unwrap();
  expect(nativeInputReceiptSchema.parse(steer).runId).toBe(requestId);
  store.cancelRun("owner", thread.id, requestId).unwrap();
  expect(
    nativeThreadSchema.parse(store.getThread("owner", thread.id).unwrap()).activeRunId,
  ).toBeUndefined();
  store.close();
});
