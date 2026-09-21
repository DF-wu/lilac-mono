import { describe, expect, test } from "bun:test";
import { watchAppUpdates, type AppUpdate } from "../src/updates";

class Worker extends EventTarget {
  sent: unknown[] = [];
  postMessage(value: unknown) {
    this.sent.push(value);
  }
}
class Registration extends EventTarget {
  waiting: Worker | null = null;
  installing: Worker | null = null;
}
class Workers extends EventTarget {
  controller: Worker | null = new Worker();
  registration = new Registration();
  unavailable = false;
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
  test("missing old lazy chunks offer a reload without an automatic reload loop", async () => {
    const f = fixture();
    const cleanup = await watchAppUpdates((value) => f.updates.push(value), f.environment);
    const error = new Event("vite:preloadError", { cancelable: true });
    f.events.dispatchEvent(error);
    expect(error.defaultPrevented).toBe(true);
    expect(f.updates).toHaveLength(1);
    expect(f.reloads()).toBe(0);
    cleanup();
  });
});
