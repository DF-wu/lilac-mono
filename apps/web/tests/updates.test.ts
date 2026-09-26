import { describe, expect, test } from "bun:test";
import type { ClientEvent } from "@stanley2058/lilac-client";
import { watchAppUpdates, watchAppUpdateChecks, type AppUpdate } from "../src/updates";

class Worker extends EventTarget {
  sent: unknown[] = [];
  postMessage(value: unknown) {
    this.sent.push(value);
  }
}
class Registration extends EventTarget {
  waiting: Worker | null = null;
  installing: Worker | null = null;
  checks = 0;
  failUpdate = false;
  checked = Promise.withResolvers<void>();
  async update() {
    this.checks++;
    this.checked.resolve();
    this.checked = Promise.withResolvers<void>();
    if (this.failUpdate) throw new Error("Offline");
    return this;
  }
}
class Client {
  connectionState: "online" | "offline" = "offline";
  listeners = new Set<(event: ClientEvent) => void>();
  subscribe(listener: (event: ClientEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  connection(state: "online" | "offline") {
    this.connectionState = state;
    for (const listener of this.listeners) listener({ kind: "connection", state });
  }
}
class Workers extends EventTarget {
  controller: Worker | null = new Worker();
  registration = new Registration();
  unavailable = false;
  lookup: Promise<Registration | undefined> | undefined;
  async getRegistration() {
    return this.lookup ?? this.registration;
  }
  async register() {
    if (this.unavailable) throw new Error("Unsupported context");
    return this.registration;
  }
}
function fixture(unavailable = false) {
  const workers = new Workers();
  workers.unavailable = unavailable;
  const events = new EventTarget();
  let reloads = 0;
  const updates: AppUpdate[] = [];
  return {
    workers,
    events,
    updates,
    reloads: () => reloads,
    environment: {
      production: true,
      workers: workers as unknown as ServiceWorkerContainer,
      events: events as unknown as Pick<Window, "addEventListener" | "removeEventListener">,
      buildId: "1234567890abcdef1234",
      reload: () => {
        reloads++;
      },
    },
  };
}
describe("app update notifications", () => {
  test("replacing a client preserves the visible update while pending checks are discarded", async () => {
    const f = fixture();
    const registration = f.workers.registration;
    registration.waiting = new Worker();
    const cleanup = await watchAppUpdates((value) => f.updates.push(value), f.environment);
    const update = f.updates[0]!;
    const pending = Promise.withResolvers<Registration>();
    f.workers.lookup = pending.promise;
    const previous = new Client();
    previous.connection("online");
    const stopPrevious = watchAppUpdateChecks(previous, f.environment);
    stopPrevious();
    pending.resolve(registration);
    await f.workers.getRegistration();
    expect(registration.checks).toBe(0);
    expect(previous.listeners.size).toBe(0);

    f.workers.lookup = undefined;
    registration.failUpdate = true;
    const current = new Client();
    current.connection("online");
    const stopCurrent = watchAppUpdateChecks(current, f.environment);
    await registration.checked.promise;
    expect(registration.checks).toBe(1);
    expect(f.updates).toEqual([update]);
    update.activate();
    expect(registration.waiting.sent).toEqual(["activate-update"]);
    f.workers.dispatchEvent(new Event("controllerchange"));
    expect(f.reloads()).toBe(1);
    stopCurrent();
    cleanup();
  });
  test("reconnecting checks for an update and offers reload after it installs", async () => {
    const f = fixture();
    const client = new Client();
    const cleanup = await watchAppUpdates((value) => f.updates.push(value), f.environment);
    const stopChecks = watchAppUpdateChecks(client, f.environment);
    const registration = f.workers.registration;
    expect(registration.checks).toBe(0);
    const checked = registration.checked.promise;
    client.connection("online");
    await checked;
    expect(registration.checks).toBe(1);
    client.connection("offline");
    expect(registration.checks).toBe(1);
    const rechecked = registration.checked.promise;
    client.connection("online");
    await rechecked;
    expect(registration.checks).toBe(2);
    expect(f.updates).toHaveLength(0);
    registration.installing = new Worker();
    registration.dispatchEvent(new Event("updatefound"));
    registration.waiting = registration.installing;
    registration.installing.dispatchEvent(new Event("statechange"));
    expect(f.updates).toHaveLength(1);
    expect(f.reloads()).toBe(0);
    f.updates[0]!.activate();
    expect(registration.waiting.sent).toEqual(["activate-update"]);
    f.workers.dispatchEvent(new Event("controllerchange"));
    expect(f.reloads()).toBe(1);
    stopChecks();
    cleanup();
    client.connection("online");
    expect(registration.checks).toBe(2);
    expect(client.listeners.size).toBe(0);
  });
  test("an already online client checks and a failed check can retry on reconnect", async () => {
    const f = fixture();
    const client = new Client();
    client.connection("online");
    f.workers.registration.failUpdate = true;
    const cleanup = await watchAppUpdates((value) => f.updates.push(value), f.environment);
    const stopChecks = watchAppUpdateChecks(client, f.environment);
    await f.workers.registration.checked.promise;
    expect(f.workers.registration.checks).toBe(1);
    f.workers.registration.failUpdate = false;
    client.connection("offline");
    const checked = f.workers.registration.checked.promise;
    client.connection("online");
    await checked;
    expect(f.workers.registration.checks).toBe(2);
    expect(f.updates).toHaveLength(0);
    expect(f.reloads()).toBe(0);
    stopChecks();
    cleanup();
  });
  test("service-worker absence and registration rejection are optional", async () => {
    const f = fixture(true);
    const cleanup = await watchAppUpdates((value) => f.updates.push(value), f.environment);
    cleanup();
    expect(f.updates).toEqual([]);
    const absent = await watchAppUpdates((value) => f.updates.push(value), {
      ...f.environment,
      workers: undefined,
    });
    absent();
    expect(f.reloads()).toBe(0);
  });
  test("a missing chunk still offers reload when service workers are unavailable", async () => {
    const f = fixture();
    const cleanup = await watchAppUpdates((value) => f.updates.push(value), {
      ...f.environment,
      workers: undefined,
    });
    f.events.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    expect(f.updates).toHaveLength(1);
    expect(f.reloads()).toBe(0);
    f.updates[0]!.activate();
    expect(f.reloads()).toBe(1);
    cleanup();
  });
  test("a rejected registration still installs and cleans up the reload fallback", async () => {
    const f = fixture(true);
    const cleanup = await watchAppUpdates((value) => f.updates.push(value), f.environment);
    f.events.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    expect(f.updates).toHaveLength(1);
    f.updates[0]!.activate();
    expect(f.reloads()).toBe(1);
    cleanup();
    f.events.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    expect(f.updates).toHaveLength(1);
  });
  test("waiting updates reload only after explicit activation and controller change", async () => {
    const f = fixture();
    f.workers.registration.waiting = new Worker();
    const cleanup = await watchAppUpdates((value) => f.updates.push(value), f.environment);
    expect(f.updates).toHaveLength(1);
    expect(f.reloads()).toBe(0);
    f.updates[0]!.activate();
    f.updates[0]!.activate();
    expect(f.workers.registration.waiting.sent).toEqual(["activate-update"]);
    expect(f.reloads()).toBe(0);
    f.workers.dispatchEvent(new Event("controllerchange"));
    expect(f.reloads()).toBe(1);
    cleanup();
  });
  test("other tabs keep their draft until choosing to reload a mismatched build", async () => {
    const f = fixture();
    const cleanup = await watchAppUpdates((value) => f.updates.push(value), f.environment);
    f.workers.dispatchEvent(new Event("controllerchange"));
    expect(f.reloads()).toBe(0);
    f.workers.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "lilac-build-version", id: "aaaaaaaaaaaaaaaaaaaa" },
      }),
    );
    expect(f.updates).toHaveLength(1);
    expect(f.reloads()).toBe(0);
    f.updates[0]!.activate();
    expect(f.reloads()).toBe(1);
    cleanup();
    f.workers.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "lilac-build-version", id: "bbbbbbbbbbbbbbbbbbbb" },
      }),
    );
    expect(f.updates).toHaveLength(1);
  });
  test("missing old lazy chunks preserve the import failure and offer an explicit reload", async () => {
    const f = fixture();
    const cleanup = await watchAppUpdates((value) => f.updates.push(value), f.environment);
    const error = new Event("vite:preloadError", { cancelable: true });
    f.events.dispatchEvent(error);
    expect(error.defaultPrevented).toBe(false);
    expect(f.updates).toHaveLength(1);
    expect(f.reloads()).toBe(0);
    cleanup();
  });
});
