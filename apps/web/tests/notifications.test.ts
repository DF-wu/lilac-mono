import { expect, test } from "bun:test";
import type { NativeThread } from "@stanley2058/lilac-client-protocol";
import { createNotificationPreferences, notificationTransition } from "../src/notifications";

const working: NativeThread = {
  id: "thread",
  title: "Example",
  starterId: "owner",
  archived: false,
  updatedAt: 1,
  revision: 1,
  displayStatus: "working",
  activeRunId: "run",
  capabilities: { read: true, edit: true, share: true },
};
const complete: NativeThread = { ...working, revision: 2, displayStatus: "completed" };

test("alerts require a new terminal transition from an observed working state", () => {
  expect(notificationTransition(working, complete)).toBe("completion");
  expect(notificationTransition(working, { ...complete, displayStatus: "error" })).toBe("failure");
  expect(notificationTransition(undefined, complete)).toBeUndefined();
  expect(notificationTransition(complete, { ...complete, revision: 3 })).toBeUndefined();
  expect(notificationTransition(working, { ...complete, revision: 1 })).toBeUndefined();
  expect(notificationTransition(working, { ...complete, revision: 0 })).toBeUndefined();
  expect(notificationTransition(working, { ...working, revision: 2 })).toBeUndefined();
  expect(notificationTransition(working, { ...complete, displayStatus: "idle" })).toBeUndefined();
  expect(notificationTransition(working, { ...complete, archived: true })).toBeUndefined();
  expect(
    notificationTransition(working, {
      ...complete,
      capabilities: { read: false, edit: false, share: false },
    }),
  ).toBeUndefined();
});

test("preferences are opt-in, scoped, synchronized and tolerate corrupt or unavailable storage", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  try {
    const scope = { installationId: "one", principalId: "owner" };
    const first = createNotificationPreferences(scope);
    const second = createNotificationPreferences(scope);
    expect(first.store.getState()).toEqual({ enabled: false, completion: true, failure: true });
    first.update({ enabled: true, completion: false });
    second.sync();
    expect(second.store.getState()).toEqual({ enabled: true, completion: false, failure: true });
    expect(
      createNotificationPreferences({ ...scope, principalId: "other" }).store.getState().enabled,
    ).toBe(false);
    expect(
      createNotificationPreferences({ ...scope, installationId: "two" }).store.getState().enabled,
    ).toBe(false);
    for (const key of values.keys()) values.set(key, "bad");
    second.sync();
    expect(second.store.getState().enabled).toBe(false);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("Unavailable");
      },
    });
    expect(createNotificationPreferences(scope).store.getState().enabled).toBe(false);
    expect(() => first.update({ enabled: false })).not.toThrow();
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("live delivery suppresses viewed, disabled, duplicate and reconnect events and cleans up", async () => {
  const { watchNotifications, notificationScope } = await import("../src/notifications");
  type ClientEvent = Parameters<
    Parameters<typeof watchNotifications>[0]["client"]["subscribe"]
  >[0] extends (event: infer E) => void
    ? E
    : never;
  let listener: (event: ClientEvent) => void = () => {};
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalNotification = Object.getOwnPropertyDescriptor(globalThis, "Notification");
  const scope = { installationId: "test", principalId: "user" };
  const shown: {
    title: string;
    body?: string;
    tag?: string;
    closed: boolean;
    onclick?: () => void;
    close: () => void;
  }[] = [];
  let focused = false;
  let registrationLookup = async (): Promise<undefined> => undefined;
  let opened = "";
  let unsubscribed = false;
  class TestNotification {
    static permission = "granted";
    closed = false;
    onclick?: () => void;
    body?: string;
    tag?: string;
    constructor(
      public title: string,
      options: NotificationOptions,
    ) {
      this.body = options.body;
      this.tag = options.tag;
      shown.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  const fakeWindow = Object.assign(new EventTarget(), {
    isSecureContext: true,
    Notification: TestNotification,
    focus() {},
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: TestNotification,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      serviceWorker: { getRegistration: () => registrationLookup() },
      locks: {
        request: (_name: string, _options: object, callback: () => Promise<void>) => callback(),
        query: async () => ({
          held: focused ? [{ name: `${notificationScope(scope)}:view:thread` }] : [],
        }),
      },
    },
  });
  let stop = () => {};
  try {
    const preferences = createNotificationPreferences(scope);
    preferences.store.setState({ enabled: true });
    stop = watchNotifications({
      client: {
        connectionState: "online",
        subscribe(callback) {
          listener = callback;
          return () => {
            unsubscribed = true;
          };
        },
      },
      initial: [working],
      scope,
      preferences,
      openThread: (id) => {
        opened = id;
      },
    });
    await listener({ kind: "thread", thread: complete });
    expect(shown.map((notification) => notification.body)).toEqual(["Response finished"]);
    shown[0]!.onclick?.();
    expect(opened).toBe("thread");
    expect(shown[0]!.closed).toBe(true);
    await listener({ kind: "thread", thread: complete });
    await listener({ kind: "thread", thread: working });
    await listener({ kind: "thread", thread: { ...complete, revision: 3 } });
    expect(shown).toHaveLength(1);
    focused = true;
    await listener({ kind: "thread", thread: { ...working, revision: 4 } });
    await listener({ kind: "thread", thread: { ...complete, revision: 5 } });
    expect(shown).toHaveLength(1);
    focused = false;
    preferences.store.setState({ completion: false });
    await listener({ kind: "thread", thread: { ...working, revision: 6 } });
    await listener({ kind: "thread", thread: { ...complete, revision: 7 } });
    expect(shown).toHaveLength(1);
    await listener({ kind: "thread", thread: { ...working, revision: 8 } });
    await listener({
      kind: "thread",
      thread: { ...complete, revision: 9, displayStatus: "error" },
    });
    expect(shown[1]?.body).toBe("Run failed");
    expect(shown[1]?.tag).not.toBe(shown[0]?.tag);
    await listener({ kind: "connection", state: "offline" });
    await listener({ kind: "connection", state: "online" });
    await listener({ kind: "thread", thread: { ...complete, revision: 10 } });
    expect(shown).toHaveLength(2);
    preferences.store.setState({ enabled: false });
    await listener({ kind: "thread", thread: { ...working, revision: 11 } });
    await listener({
      kind: "thread",
      thread: { ...complete, revision: 12, displayStatus: "error" },
    });
    expect(shown).toHaveLength(2);
    preferences.store.setState({ enabled: true, completion: true });
    let releaseLookup: () => void = () => {};
    let lookupStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    registrationLookup = () => {
      lookupStarted();
      return new Promise<undefined>((resolve) => {
        releaseLookup = () => resolve(undefined);
      });
    };
    await listener({ kind: "thread", thread: { ...working, revision: 13 } });
    const delivery = listener({ kind: "thread", thread: { ...complete, revision: 14 } });
    await started;
    await listener({
      kind: "thread",
      thread: { ...complete, revision: 15, title: "Updated title" },
    });
    releaseLookup();
    await delivery;
    expect(shown).toHaveLength(3);
    expect(shown[2]?.title).toBe("Updated title");
    expect(shown[2]?.tag).toContain(":14:completion");
    expect(new Set(shown.map((notification) => notification.tag)).size).toBe(3);
    registrationLookup = async () => undefined;
    stop();
    expect(unsubscribed).toBe(true);
    expect(shown.every((notification) => notification.closed)).toBe(true);
  } finally {
    stop();
    for (const [key, original] of [
      ["window", originalWindow],
      ["navigator", originalNavigator],
      ["Notification", originalNotification],
    ] as const) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
