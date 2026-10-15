import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Result } from "better-result";
import { WebPushError, type sendNotification } from "web-push";
import { NativePush, allowedPushEndpoint } from "./push";
import { NativeStore } from "./store";

function fixture(
  send: typeof sendNotification = async () => ({ statusCode: 201, headers: {}, body: "" }),
) {
  const db = new Database(":memory:");
  const store = new NativeStore(db);
  store.initialize().unwrap();
  for (const id of ["owner", "alice", "bob"] as const)
    store
      .upsertUser({
        id,
        providerId: id,
        displayName: id,
        role: id === "owner" ? "owner" : "participant",
        toolMode: "full",
      })
      .unwrap();
  const push = new NativePush(db, store, send);
  push.key().unwrap();
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/device",
    keys: { p256dh: "x".repeat(87), auth: "y".repeat(22) },
    completion: true,
    failure: true,
  };
  push.subscribe("alice", subscription).unwrap();
  push.start();
  const thread = store.createThread("alice", { commandId: "new" }).unwrap();
  const receipt = store
    .acceptInput("alice", {
      threadId: thread.id,
      commandId: "input",
      historyGeneration: 0,
      text: "Hello",
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    })
    .unwrap();
  store.setActiveRun(thread.id, 0, "run").unwrap();
  function finish(state: "complete" | "failed" = "complete") {
    store
      .projectTurn(thread.id, 0, "finish", receipt.turnId!, (slot) =>
        Result.ok({
          slot: {
            ...slot,
            state,
            messages: [
              ...slot.messages,
              {
                id: "reply",
                role: "assistant",
                parts: [
                  { type: "text", text: "**Done.** Read [the result](https://example.com)." },
                ],
              },
            ],
          },
          changes: [],
        }),
      )
      .unwrap();
    store.setActiveRun(thread.id, 0).unwrap();
  }
  return { db, store, push, thread, receipt, subscription, finish };
}

test("push endpoints reject arbitrary destinations", () => {
  for (const endpoint of [
    "http://fcm.googleapis.com/x",
    "https://127.0.0.1/x",
    "https://fcm.googleapis.com.evil.test/x",
    "https://fcm.googleapis.com:444/x",
    "https://user@fcm.googleapis.com/x",
  ])
    expect(allowedPushEndpoint(endpoint)).toBe(false);
  for (const endpoint of [
    "https://fcm.googleapis.com/x",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://web.push.apple.com/x",
    "https://wns2.notify.windows.com/x",
  ])
    expect(allowedPushEndpoint(endpoint)).toBe(true);
});

test("subscriptions and signing keys survive restart, removals are owner scoped", async () => {
  const f = fixture();
  const key = f.push.key().unwrap();
  const restarted = new NativePush(f.db, f.store);
  expect(restarted.key().unwrap()).toEqual(key);
  restarted.unsubscribe("bob", f.subscription.endpoint).unwrap();
  expect(f.db.query("SELECT endpoint FROM native_push_subscriptions").all()).toHaveLength(1);
  restarted.unsubscribe("alice", f.subscription.endpoint).unwrap();
  expect(f.db.query("SELECT endpoint FROM native_push_subscriptions").all()).toHaveLength(0);
  await f.push.stop();
  f.db.close();
});

test("completion sends one bounded preview with the thread destination", async () => {
  const sent: string[] = [];
  const f = fixture(async (_subscription, payload) => {
    sent.push(String(payload));
    return { statusCode: 201, headers: {}, body: "" };
  });
  await Promise.resolve();
  f.finish();
  await Promise.resolve();
  await f.push.stop();
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!)).toMatchObject({
    threadId: f.thread.id,
    title: "Lilac · New thread",
    body: "Done. Read the result.",
  });
  expect(f.store.notificationContent("bob", f.thread.id).isErr()).toBe(true);
  f.db.close();
});

test.each(["disabled", "viewed", "revoked"] as const)(
  "does not push %s notifications",
  async (mode) => {
    const sent: string[] = [];
    const f = fixture(async (_subscription, payload) => {
      sent.push(String(payload));
      return { statusCode: 201, headers: {}, body: "" };
    });
    await Promise.resolve();
    if (mode === "disabled")
      f.push.subscribe("alice", { ...f.subscription, completion: false }).unwrap();
    if (mode === "viewed")
      f.push
        .presence("alice", {
          endpoint: f.subscription.endpoint,
          threadId: f.thread.id,
          clientId: "tab",
        })
        .unwrap();
    if (mode === "revoked") f.push.subscribe("bob", f.subscription).unwrap();
    if (mode === "viewed")
      f.push
        .presence("alice", { endpoint: f.subscription.endpoint, clientId: "background-tab" })
        .unwrap();
    f.finish();
    await Promise.resolve();
    await f.push.stop();
    expect(sent).toHaveLength(0);
    f.db.close();
  },
);

test("expired subscriptions are removed", async () => {
  const f = fixture(async () => {
    throw new WebPushError("gone", 410, {}, "", "https://fcm.googleapis.com/x");
  });
  await Promise.resolve();
  f.finish("failed");
  await Promise.resolve();
  await f.push.stop();
  expect(f.db.query("SELECT endpoint FROM native_push_subscriptions").all()).toHaveLength(0);
  f.db.close();
});

test("enabling push during a run delivers its completion", async () => {
  const f = fixture();
  await f.push.stop();
  f.push.unsubscribe("alice", f.subscription.endpoint).unwrap();
  const sent: string[] = [];
  const push = new NativePush(f.db, f.store, async (_subscription, payload) => {
    sent.push(String(payload));
    return { statusCode: 201, headers: {}, body: "" };
  });
  push.start();
  push.subscribe("alice", f.subscription).unwrap();
  f.finish();
  await Promise.resolve();
  await push.stop();
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!).threadId).toBe(f.thread.id);
  f.db.close();
});
