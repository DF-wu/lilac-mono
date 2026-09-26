import { expect, test } from "bun:test";
import {
  ariaBinding,
  bindingConflict,
  browserConflict,
  createKeybindings,
  decodeKeybindings,
  defaultKeybindings,
  editingConflict,
  formatBinding,
  recordedBinding,
  sameBinding,
  threadShortcutTarget,
} from "../src/keybindings";

function key(overrides: Partial<Parameters<typeof recordedBinding>[0]> = {}) {
  return {
    code: "KeyN",
    ctrlKey: true,
    metaKey: false,
    altKey: true,
    shiftKey: false,
    isComposing: false,
    repeat: false,
    getModifierState: () => false,
    ...overrides,
  };
}

test("physical shortcuts match exact modifiers on Windows and Mac without stealing AltGr or composition", () => {
  expect(recordedBinding(key(), false)).toEqual(defaultKeybindings.newThread!);
  expect(recordedBinding(key({ ctrlKey: false, metaKey: true }), true)).toEqual(
    defaultKeybindings.newThread!,
  );
  expect(recordedBinding(key(), true)).toBeUndefined();
  expect(recordedBinding(key({ metaKey: true }), false)).toBeUndefined();
  expect(recordedBinding(key({ isComposing: true }), false)).toBeUndefined();
  expect(recordedBinding(key({ repeat: true }), false)).toBeUndefined();
  expect(
    recordedBinding(key({ getModifierState: (name) => name === "AltGraph" }), false),
  ).toBeUndefined();
  expect(recordedBinding(key({ ctrlKey: false, altKey: false }), false)).toBeUndefined();
  expect(recordedBinding(key({ code: "AltLeft" }), false)).toBeUndefined();
  expect(
    sameBinding(recordedBinding(key({ shiftKey: true }), false)!, defaultKeybindings.newThread),
  ).toBe(false);
});

test("formatting combinations remain scoped outside editors; panel defaults work inside", () => {
  expect(editingConflict({ code: "KeyB", mod: true, alt: false, shift: false })).toBe(true);
  expect(editingConflict({ code: "KeyV", mod: true, alt: false, shift: true })).toBe(true);
  expect(editingConflict(defaultKeybindings.sidebar)).toBe(false);
  expect(editingConflict(defaultKeybindings.rightPanel)).toBe(false);
  expect(
    browserConflict({ code: "KeyN", mod: true, alt: false, shift: false }, false),
  ).toBeTruthy();
  expect(browserConflict(defaultKeybindings.newThread, false)).toBeUndefined();
  expect(formatBinding(defaultKeybindings.newThread, false)).toBe("Ctrl+Alt+N");
  expect(formatBinding(defaultKeybindings.settings, true)).toBe("⌘⇧,");
  expect(ariaBinding(defaultKeybindings.thread10, true)).toBe("Meta+Alt+0");
  expect(formatBinding(null)).toBe("");
});

test("invalid, duplicate and unsupported stored bindings use defaults without rewriting", () => {
  expect(decodeKeybindings(null)).toBe(defaultKeybindings);
  expect(decodeKeybindings("{")).toBe(defaultKeybindings);
  expect(decodeKeybindings(JSON.stringify({ version: 2, bindings: defaultKeybindings }))).toBe(
    defaultKeybindings,
  );
  expect(decodeKeybindings(JSON.stringify({ version: 1, bindings: {} }))).toBe(defaultKeybindings);
  expect(
    decodeKeybindings(
      JSON.stringify({
        version: 1,
        bindings: { ...defaultKeybindings, settings: defaultKeybindings.newThread },
      }),
    ),
  ).toBe(defaultKeybindings);
  const cleared = { ...defaultKeybindings, newThread: null };
  expect(decodeKeybindings(JSON.stringify({ version: 1, bindings: cleared }))).toEqual(cleared);
  expect(bindingConflict(defaultKeybindings, "settings", defaultKeybindings.newThread)).toBe(
    "newThread",
  );
  expect(bindingConflict(defaultKeybindings, "settings", null)).toBeUndefined();
});

test("bindings persist independently for each installation and user; failures keep session changes", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  let fail = false;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (fail) throw new Error("Unavailable");
        values.set(key, value);
      },
    },
  });
  try {
    const scope = { installationId: "one", principalId: "owner" };
    const store = createKeybindings(scope);
    store.getState().setBinding("newThread", null);
    expect(createKeybindings(scope).getState().bindings.newThread).toBeNull();
    expect(
      createKeybindings({ ...scope, principalId: "other" }).getState().bindings.newThread,
    ).toEqual(defaultKeybindings.newThread);
    expect(
      createKeybindings({ ...scope, installationId: "two" }).getState().bindings.newThread,
    ).toEqual(defaultKeybindings.newThread);
    store.getState().setBinding("settings", defaultKeybindings.sidebar);
    expect(store.getState().bindings.settings).toEqual(defaultKeybindings.settings);
    fail = true;
    store.getState().setBinding("settings", null);
    expect(store.getState().bindings.settings).toBeNull();
    expect(store.getState().storageError).toBeTruthy();
    expect(createKeybindings(scope).getState().bindings.settings).toEqual(
      defaultKeybindings.settings,
    );
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("held thread slots survive live reordering without selecting removed threads", () => {
  const original = Array.from({ length: 12 }, (_, index) => `thread-${index}`);
  const held = original.slice(0, 10);
  const updated = ["new-thread", ...original];
  expect(threadShortcutTarget(updated, held, 9)).toBe("thread-9");
  expect(threadShortcutTarget(updated, held, 0)).toBe("thread-0");
  expect(threadShortcutTarget(updated, undefined, 0)).toBe("new-thread");
  expect(
    threadShortcutTarget(
      updated.filter((id) => id !== "thread-9"),
      held,
      9,
    ),
  ).toBeUndefined();
  expect(threadShortcutTarget([], undefined, 0)).toBeUndefined();
});
