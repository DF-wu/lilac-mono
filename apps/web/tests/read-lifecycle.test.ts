import { expect, test } from "bun:test";
import type { NativeClient } from "@stanley2058/lilac-client";
import { watchReadLifecycle } from "../src/read-lifecycle";

function fixture(markRead: () => Promise<boolean>, focused = false) {
  const page = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
    focused,
    hasFocus() {
      return this.focused;
    },
  });
  const events = new EventTarget();
  let listener: Parameters<NativeClient["subscribe"]>[0] | undefined;
  const stop = watchReadLifecycle(
    {
      subscribe(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    },
    markRead,
    page,
    events,
  );
  return { page, events, stop, online: () => listener?.({ kind: "connection", state: "online" }) };
}

test("returning focus acknowledges a visible completed turn without a visibility change", async () => {
  let reads = 0;
  const f = fixture(async () => {
    reads++;
    return true;
  });
  expect(reads).toBe(0);
  f.page.focused = true;
  f.events.dispatchEvent(new Event("focus"));
  await Promise.resolve();
  expect(reads).toBe(1);
  f.events.dispatchEvent(new Event("focus"));
  f.page.dispatchEvent(new Event("visibilitychange"));
  f.online();
  expect(reads).toBe(1);
  f.stop();
});

test("hidden or unfocused pages stay unread and reconnect retries a failed read", async () => {
  let reads = 0;
  const f = fixture(async () => {
    reads++;
    return reads > 1;
  });
  f.online();
  f.page.dispatchEvent(new Event("visibilitychange"));
  expect(reads).toBe(0);
  f.page.focused = true;
  f.page.visibilityState = "hidden";
  f.events.dispatchEvent(new Event("focus"));
  expect(reads).toBe(0);
  f.page.visibilityState = "visible";
  f.page.dispatchEvent(new Event("visibilitychange"));
  await Promise.resolve();
  expect(reads).toBe(1);
  f.online();
  await Promise.resolve();
  expect(reads).toBe(2);
  f.stop();
});

test("a reconnect during a pending failed read retries once, cleanup prevents later attempts", async () => {
  const first = Promise.withResolvers<boolean>();
  let reads = 0;
  const f = fixture(() => {
    reads++;
    return reads === 1 ? first.promise : Promise.resolve(false);
  }, true);
  f.online();
  f.events.dispatchEvent(new Event("focus"));
  expect(reads).toBe(1);
  first.resolve(false);
  await first.promise;
  expect(reads).toBe(2);
  f.stop();
  f.online();
  f.events.dispatchEvent(new Event("focus"));
  f.events.dispatchEvent(new Event("pageshow"));
  f.page.dispatchEvent(new Event("visibilitychange"));
  await Promise.resolve();
  expect(reads).toBe(2);
});
