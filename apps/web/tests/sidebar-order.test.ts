import { describe, expect, test } from "bun:test";
import {
  sidebarSnapshot,
  dropAction,
  moveInQueues,
  queueSection,
  type ThreadQueues,
} from "../src/sidebar-order";
const queues = (): ThreadQueues => ({
  pinned: [{ id: "p" }],
  active: [{ id: "a" }, { id: "b" }, { id: "c" }],
  settled: [{ id: "s" }],
});
describe("sidebar drag previews", () => {
  test("opens the exact target gap without mutating settled server data", () => {
    const original = queues();
    const next = moveInQueues(original, { threadId: "c", section: "active", beforeId: "b" });
    expect(next.active.map((t) => t.id)).toEqual(["a", "c", "b"]);
    expect(original.active.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(
      moveInQueues(next, { threadId: "a", section: "active", afterId: "b" }).active.map(
        (t) => t.id,
      ),
    ).toEqual(["c", "b", "a"]);
  });
  test("supports empty sections and re-enqueuing at the top", () => {
    const original = queues();
    const next = moveInQueues(original, { threadId: "s", section: "active", atStart: true });
    expect(next.active.map((t) => t.id)).toEqual(["s", "a", "b", "c"]);
    expect(next.settled).toEqual([]);
    const settled = moveInQueues(next, { threadId: "p", section: "settled" });
    expect(settled.settled.map((t) => t.id)).toEqual(["p"]);
    expect(queueSection(settled, "p")).toBe("settled");
  });
  test("describes property changes only when crossing sections", () => {
    expect(dropAction("active", "pinned")).toBe("Pin");
    expect(dropAction("pinned", "active")).toBe("Unpin");
    expect(dropAction("active", "settled")).toBe("Settle");
    expect(dropAction("settled", "active")).toBe("Unsettle");
    expect(dropAction("active", "active")).toBeUndefined();
  });
});

test("offline bootstrap threads remain selectable before sidebar data is available", () => {
  const thread = {
    id: "cached",
    title: "Cached",
    starterId: "owner",
    archived: false,
    updatedAt: 1,
    revision: 1,
    capabilities: { read: true, edit: true, share: true },
  };
  expect(sidebarSnapshot([], [thread]).active.map((item) => item.id)).toEqual(["cached"]);
  expect(
    sidebarSnapshot([{ section: "settled", items: [thread], updatedAt: 1 }], [thread]).active,
  ).toEqual([]);
});

test("staggered section refreshes use the newest membership without duplicate drag IDs", () => {
  const thread = {
    id: "moved",
    title: "Moved",
    starterId: "owner",
    archived: false,
    updatedAt: 1,
    revision: 1,
    capabilities: { read: true, edit: true, share: true },
  };
  const reactivated = sidebarSnapshot([
    { section: "active", items: [thread], updatedAt: 2 },
    { section: "settled", items: [thread], updatedAt: 1 },
  ]);
  expect(reactivated.active.map((item) => item.id)).toEqual(["moved"]);
  expect(reactivated.settled).toEqual([]);
  const settled = sidebarSnapshot([
    { section: "active", items: [thread], updatedAt: 2 },
    { section: "settled", items: [thread], updatedAt: 3 },
  ]);
  expect(settled.settled.map((item) => item.id)).toEqual(["moved"]);
  expect(settled.active).toEqual([]);
});
