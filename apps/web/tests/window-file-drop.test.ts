import { expect, test } from "bun:test";
import { hasFileDrag, installWindowFileDrop } from "../src/window-file-drop";

function fixture() {
  const target = new EventTarget();
  let allowed = true;
  const visibility: boolean[] = [];
  const batches: File[][] = [];
  const dispose = installWindowFileDrop(target as unknown as Window, {
    canAttach: () => allowed,
    show: (visible) => visibility.push(visible),
    attach: (files) => batches.push(files),
  });
  function drag(type: string, types = ["Files"], files: File[] = []) {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      dataTransfer: { types, files, dropEffect: "none" },
    });
    target.dispatchEvent(event);
    return event;
  }
  return {
    target,
    visibility,
    batches,
    dispose,
    drag,
    disable: () => {
      allowed = false;
    },
  };
}

test("window file drops retain nested enter state and attach each file once", () => {
  const view = fixture();
  expect(view.drag("dragenter").defaultPrevented).toBe(true);
  view.drag("dragenter");
  view.drag("dragleave");
  expect(view.visibility.at(-1)).toBe(true);
  expect(view.drag("dragover").dataTransfer.dropEffect).toBe("copy");
  const files = [new File(["one"], "one.txt"), new File(["two"], "two.txt")];
  expect(view.drag("drop", ["Files"], files).defaultPrevented).toBe(true);
  expect(view.batches).toEqual([files]);
  expect(view.visibility.at(-1)).toBe(false);
  view.dispose();
});

test("text and Plate drags keep their existing browser behavior", () => {
  const view = fixture();
  for (const type of ["dragenter", "dragover", "dragleave", "drop"]) {
    expect(view.drag(type, ["text/plain", "application/x-slate-fragment"]).defaultPrevented).toBe(
      false,
    );
  }
  expect(view.visibility).toEqual([]);
  expect(view.batches).toEqual([]);
  expect(hasFileDrag(null)).toBe(false);
  view.dispose();
});

test("a permission change before drop prevents file admission", () => {
  const view = fixture();
  view.drag("dragenter");
  view.disable();
  expect(view.drag("dragover").dataTransfer.dropEffect).toBe("none");
  view.drag("drop", ["Files"], [new File(["private"], "private.txt")]);
  expect(view.batches).toEqual([]);
  expect(view.visibility.at(-1)).toBe(false);
  view.dispose();
});

test("leaving, canceling, and cleanup dismiss the overlay without later listeners", () => {
  const view = fixture();
  view.drag("dragenter");
  view.drag("dragleave");
  expect(view.visibility.at(-1)).toBe(false);
  view.drag("dragenter");
  view.target.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" }));
  expect(view.visibility.at(-1)).toBe(false);
  view.dispose();
  const events = view.visibility.length;
  expect(
    view.drag("drop", ["Files"], [new File(["ignored"], "ignored.txt")]).defaultPrevented,
  ).toBe(false);
  expect(view.visibility).toHaveLength(events);
  expect(view.batches).toEqual([]);
});
