import { expect, test } from "bun:test";
import { watchConnectionLifecycle } from "../src/connection-lifecycle";

test("resuming a suspended app reconnects once and removes lifecycle listeners on cleanup", () => {
  const page = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  });
  const events = new EventTarget();
  let reconnects = 0;
  const client = {
    connectionState: "online" as const,
    reconnect: () => {
      reconnects++;
    },
  };
  const stop = watchConnectionLifecycle(client, page, events);
  events.dispatchEvent(new Event("focus"));
  expect(reconnects).toBe(0);
  page.visibilityState = "hidden";
  page.dispatchEvent(new Event("visibilitychange"));
  events.dispatchEvent(new Event("online"));
  expect(reconnects).toBe(0);
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  page.dispatchEvent(new Event("visibilitychange"));
  events.dispatchEvent(new Event("focus"));
  expect(reconnects).toBe(1);
  events.dispatchEvent(new Event("online"));
  expect(reconnects).toBe(2);
  stop();
  events.dispatchEvent(new Event("online"));
  expect(reconnects).toBe(2);
});

test("focusing an offline desktop window bypasses reconnect backoff", () => {
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" as const });
  const events = new EventTarget();
  let reconnects = 0;
  const stop = watchConnectionLifecycle(
    {
      connectionState: "offline",
      reconnect: () => {
        reconnects++;
      },
    },
    page,
    events,
  );
  events.dispatchEvent(new Event("focus"));
  expect(reconnects).toBe(1);
  stop();
});
