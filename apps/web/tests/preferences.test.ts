import { expect, test } from "bun:test";
import { createPreferences } from "../src/preferences";

test("animation preferences persist on this device and remain scoped to account and installation", () => {
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
    const store = createPreferences(scope);
    expect(store.getState().animation).toBe("fast");
    store.getState().setAnimation("slow");
    expect(createPreferences(scope).getState().animation).toBe("slow");
    expect(createPreferences({ ...scope, principalId: "participant" }).getState().animation).toBe(
      "fast",
    );
    expect(createPreferences({ ...scope, installationId: "two" }).getState().animation).toBe(
      "fast",
    );
    store.getState().setAnimation("off");
    expect(createPreferences(scope).getState().animation).toBe("off");
    for (const key of values.keys()) values.set(key, "invalid");
    expect(createPreferences(scope).getState().animation).toBe("fast");
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
