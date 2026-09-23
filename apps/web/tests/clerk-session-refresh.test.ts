import { expect, test } from "bun:test";
import type { NativeClient } from "@stanley2058/lilac-client";
import { createClerkSessionRefresh } from "../src/clerk-session-refresh";

function setup() {
  const controller = new AbortController();
  const errors: string[] = [];
  let signedOut = 0;
  const client = {
    rpc: {} as NonNullable<NativeClient["rpc"]>,
    reauthenticate: async (_token: string) => true,
  };
  const refresh = createClerkSessionRefresh({
    client,
    getToken: async () => "test-token",
    signal: controller.signal,
    onSignedOut: async () => {
      signedOut++;
    },
    onError: (message) => errors.push(message),
  });
  return { client, controller, refresh, errors, signedOut: () => signedOut };
}

test("online during an old refresh retries the current connection without showing the old failure", async () => {
  const state = setup();
  const started = Promise.withResolvers<void>();
  const old = Promise.withResolvers<boolean>();
  let calls = 0;
  state.client.reauthenticate = async () => {
    if (calls++ > 0) return true;
    started.resolve();
    return old.promise;
  };
  const first = state.refresh();
  await started.promise;
  state.client.rpc = {} as NonNullable<NativeClient["rpc"]>;
  await state.refresh();
  old.resolve(false);
  await first;
  expect(calls).toBe(2);
  expect(state.errors).toEqual([""]);
  expect(state.signedOut()).toBe(0);
});

test("a focus refresh requested in flight is retained even on the same connection", async () => {
  const state = setup();
  const started = Promise.withResolvers<void>();
  const old = Promise.withResolvers<boolean>();
  let calls = 0;
  state.client.reauthenticate = async () => {
    if (calls++ > 0) return true;
    started.resolve();
    return old.promise;
  };
  const first = state.refresh();
  await started.promise;
  await state.refresh();
  old.reject(new Error("Temporarily unavailable"));
  await first;
  expect(calls).toBe(2);
  expect(state.errors).toEqual([""]);
});

test("unmount cancels queued refreshes and suppresses stale feedback", async () => {
  const state = setup();
  const started = Promise.withResolvers<void>();
  const old = Promise.withResolvers<boolean>();
  let calls = 0;
  state.client.reauthenticate = async () => {
    calls++;
    started.resolve();
    return old.promise;
  };
  const first = state.refresh();
  await started.promise;
  await state.refresh();
  state.controller.abort();
  old.resolve(false);
  await first;
  expect(calls).toBe(1);
  expect(state.errors).toEqual([]);
});

test("current connection failures remain visible until a successful refresh", async () => {
  const state = setup();
  state.client.reauthenticate = async () => false;
  await state.refresh();
  expect(state.errors).toEqual(["Session refresh failed. Reconnecting will retry."]);
  state.client.reauthenticate = async () => true;
  await state.refresh();
  expect(state.errors.at(-1)).toBe("");
});
