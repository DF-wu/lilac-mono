import { Result } from "better-result";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createLilacBus, lilacEventTypes } from "@stanley2058/lilac-event-bus";
import { createInMemoryDeliveryBus } from "../../../tests/helpers/in-memory-delivery-bus";
import { NativeStore } from "./store";
import { reconcileNativeDeferredSends, subscribeNativeDeferredSends } from "./deferred-sends";

for (const state of ["resolved", "failed", "cancelled"] as const) {
  test(`lifecycle bus releases the complete group on ${state} and replay is idempotent`, async () => {
    using db = new Database(":memory:");
    const store = new NativeStore(db);
    store.initialize().unwrap();
    store
      .upsertUser({
        id: "owner",
        providerId: "owner",
        displayName: "Owner",
        role: "owner",
        toolMode: "full",
      })
      .unwrap();
    const thread = store.createThread("owner", { commandId: "create" }).unwrap();
    for (const id of ["one", "two"])
      store
        .queueSurfaceSend(
          "owner",
          thread.id,
          "heartbeat:test",
          { id, role: "assistant", parts: [{ type: "text", text: id }] },
          false,
        )
        .unwrap();
    const bus = createLilacBus(createInMemoryDeliveryBus());
    const subscription = (
      await subscribeNativeDeferredSends({
        bus,
        store,
        subscriptionPrefix: "test",
        flush: () => store.deliverSurfaceSends().map(() => undefined),
      })
    ).unwrap();
    const publish = (value: "running" | typeof state) =>
      bus.publish(
        lilacEventTypes.EvtRequestLifecycleChanged,
        { state: value },
        {
          headers: {
            request_id: "heartbeat:test",
            session_id: "__heartbeat__",
            request_client: "unknown",
          },
        },
      );
    try {
      (await publish("running")).unwrap();
      expect(store.listProjectedMessageLinks().unwrap()).toEqual([]);
      (await publish(state)).unwrap();
      expect(store.listProjectedMessageLinks().unwrap()).toEqual([
        { requestId: "heartbeat:test", threadId: thread.id, messageIds: ["one", "two"] },
      ]);
      (await publish(state)).unwrap();
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM native_records WHERE kind='turn'",
          )
          .get()?.count,
      ).toBe(2);
    } finally {
      (await subscription.stop()).unwrap();
    }
  });
}

test("recoverable failure keeps a tracked group open until durable settlement", async () => {
  using db = new Database(":memory:");
  const store = new NativeStore(db);
  store.initialize().unwrap();
  store
    .upsertUser({
      id: "owner",
      providerId: "owner",
      displayName: "Owner",
      role: "owner",
      toolMode: "full",
    })
    .unwrap();
  const thread = store.createThread("owner", { commandId: "create" }).unwrap();
  const send = (id: string) =>
    store
      .queueSurfaceSend(
        "owner",
        thread.id,
        "source",
        { id, role: "assistant", parts: [{ type: "text", text: id }] },
        false,
        { deliveryId: "delivery" },
      )
      .unwrap();
  send("before-failure");
  let state: "owned" | "completed" = "owned";
  const flush = () =>
    Result.gen(function* () {
      yield* reconcileNativeDeferredSends(store, () => Result.ok(state));
      yield* store.deliverSurfaceSends();
      return Result.ok(undefined);
    });
  const bus = createLilacBus(createInMemoryDeliveryBus());
  const subscription = (
    await subscribeNativeDeferredSends({ bus, store, subscriptionPrefix: "test", flush })
  ).unwrap();
  try {
    (
      await bus.publish(
        lilacEventTypes.EvtRequestLifecycleChanged,
        { state: "failed" },
        {
          headers: { request_id: "source", session_id: "native:source", request_client: "native" },
        },
      )
    ).unwrap();
    expect(store.listProjectedMessageLinks().unwrap()).toEqual([]);
    send("after-recovery");
    state = "completed";
    flush().unwrap();
    expect(store.listProjectedMessageLinks().unwrap()[0]?.messageIds).toEqual([
      "before-failure",
      "after-recovery",
    ]);
  } finally {
    (await subscription.stop()).unwrap();
  }
});

test("clearing destination activity wakes deferred delivery through native store notifications", async () => {
  using db = new Database(":memory:");
  const store = new NativeStore(db);
  store.initialize().unwrap();
  store
    .upsertUser({
      id: "owner",
      providerId: "owner",
      displayName: "Owner",
      role: "owner",
      toolMode: "full",
    })
    .unwrap();
  const thread = store.createThread("owner", { commandId: "create" }).unwrap();
  store.setActiveRun(thread.id, 0, "active").unwrap();
  store
    .queueSurfaceSend(
      "owner",
      thread.id,
      "source",
      { id: "notice", role: "assistant", parts: [{ type: "text", text: "notice" }] },
      false,
    )
    .unwrap();
  store.settleSurfaceSends("source").unwrap();
  expect(store.deliverSurfaceSends().unwrap().notifications).toEqual([]);
  const delivered = Promise.withResolvers<void>();
  const unsubscribe = store.subscribeChanges((id) => {
    const notifications = store.deliverSurfaceSends(id).unwrap().notifications;
    if (notifications.includes(thread.id)) delivered.resolve();
  });
  try {
    store.setActiveRun(thread.id, 0, undefined).unwrap();
    await delivered.promise;
    expect(store.listProjectedMessageLinks().unwrap()[0]?.messageIds).toEqual(["notice"]);
  } finally {
    unsubscribe();
  }
});
