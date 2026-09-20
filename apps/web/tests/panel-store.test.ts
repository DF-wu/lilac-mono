import { describe, expect, test } from "bun:test";
import { createPanelStore, defaultRightPanel } from "../src/panel-store";

const scope = { installationId: "installation", principalId: "viewer" };
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("local panel layouts", () => {
  test("restores global sidebar and independent right panels across reloads", () => {
    const storage = memoryStorage();
    const store = createPanelStore(scope, storage).getState();
    store.resizeSidebar(345);
    store.toggleSidebar();
    store.resize("thread-a", 480);
    store.toggle("thread-a");
    store.resize("thread-b", 280);
    const loaded = createPanelStore(scope, storage).getState();
    expect(loaded.sidebar).toEqual({ open: false, width: 345 });
    expect(loaded.threads.get("thread-a")).toEqual({ open: true, width: 480 });
    expect(loaded.threads.get("thread-b")).toEqual({ open: false, width: 280 });
    loaded.toggle("thread-b");
    loaded.toggle("thread-a");
    const again = createPanelStore(scope, storage).getState();
    expect(again.threads.get("thread-a")).toEqual({ open: false, width: 480 });
    expect(again.threads.get("thread-b")).toEqual({ open: true, width: 280 });
  });

  test("isolates installations and users", () => {
    const storage = memoryStorage();
    createPanelStore(scope, storage).getState().toggleSidebar();
    createPanelStore(scope, storage).getState().toggle("shared-thread-id");
    for (const other of [
      { ...scope, principalId: "other" },
      { ...scope, installationId: "other" },
    ]) {
      const state = createPanelStore(other, storage).getState();
      expect(state.sidebar.open).toBe(true);
      expect(state.threads.size).toBe(0);
    }
  });

  test("opening a subagent saves only its thread layout, not transcript selection", () => {
    const storage = memoryStorage();
    const store = createPanelStore(scope, storage);
    store.getState().resize("a", 440);
    store.getState().select("a", "child-agent");
    const loaded = createPanelStore(scope, storage).getState();
    expect(loaded.threads.get("a")).toEqual({ open: true, width: 440 });
    expect(loaded.threads.get("b") ?? defaultRightPanel).toEqual({ open: false, width: 360 });
    expect(loaded.selection).toBeUndefined();
  });

  test("transfers a local draft layout to its created thread", () => {
    const storage = memoryStorage();
    const state = createPanelStore(scope, storage).getState();
    state.resize("draft:a", 460);
    state.toggle("draft:a");
    state.moveThread("draft:a", "created-a");
    const loaded = createPanelStore(scope, storage).getState();
    expect(loaded.threads.has("draft:a")).toBe(false);
    expect(loaded.threads.get("created-a")).toEqual({ open: true, width: 460 });
  });

  test.each([
    "{invalid",
    JSON.stringify({ sidebar: { open: true, width: -10 }, threads: [] }),
    JSON.stringify({
      sidebar: { open: true, width: 288 },
      threads: [["a", { open: "yes", width: 360 }]],
    }),
    JSON.stringify({
      sidebar: { open: true, width: 288 },
      threads: [["a", { open: true, width: 99999 }]],
    }),
  ])("ignores invalid local layouts: %s", (raw) => {
    const storage = { getItem: () => raw, setItem: () => {} };
    const state = createPanelStore(scope, storage).getState();
    expect(state.sidebar).toEqual({ open: true, width: 288 });
    expect(state.threads.size).toBe(0);
  });

  test("keeps controls usable when storage is blocked", () => {
    const storage = {
      getItem: (): string => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const store = createPanelStore(scope, storage);
    store.getState().toggleSidebar();
    store.getState().resize("a", 400);
    store.getState().toggle("a");
    expect(store.getState().sidebar.open).toBe(false);
    expect(store.getState().threads.get("a")).toEqual({ open: true, width: 400 });
  });

  test("unscoped design demos never read or write device preferences", () => {
    let accesses = 0;
    const storage = {
      getItem: () => {
        accesses++;
        return null;
      },
      setItem: () => {
        accesses++;
      },
    };
    const demo = createPanelStore(undefined, storage);
    demo.getState().toggle("demo");
    demo.getState().resize("demo", 400);
    expect(accesses).toBe(0);
    expect(createPanelStore(undefined, storage).getState().threads.size).toBe(0);
  });
});
