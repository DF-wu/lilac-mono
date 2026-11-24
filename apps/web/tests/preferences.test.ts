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

test("dictation destination/model are scoped; the personal token is never persisted or reused", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  try {
    const scope = { installationId: "fixture", principalId: "one" };
    const first = createPreferences(scope).getState();
    first.setAsrEndpoint("https://asr.example.test/v1/audio/transcriptions");
    first.setAsrModel("custom-model");
    first.setAsrToken("synthetic-secret");
    const reloaded = createPreferences(scope).getState();
    expect(reloaded.asrEndpoint).toBe("https://asr.example.test/v1/audio/transcriptions");
    expect(reloaded.asrModel).toBe("custom-model");
    expect(reloaded.asrToken).toBe("");
    expect([...values.values()].join(" ")).not.toContain("synthetic-secret");
    expect(createPreferences({ ...scope, principalId: "two" }).getState().asrEndpoint).toBe("");
    expect(createPreferences({ ...scope, installationId: "other" }).getState().asrEndpoint).toBe(
      "",
    );
    const store = createPreferences(scope);
    store.getState().setAsrToken("synthetic-secret");
    store.getState().setAsrEndpoint("https://different.example.test/v1/audio/transcriptions");
    expect(store.getState().asrToken).toBe("");
    store.getState().setAsrEndpoint("https://user:synthetic-secret@example.test/asr");
    expect([...values.values()].join(" ")).not.toContain("synthetic-secret");
    expect(createPreferences(scope).getState().asrEndpoint).toBe("");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
