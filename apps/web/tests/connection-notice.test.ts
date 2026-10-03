import { afterAll, expect, test } from "bun:test";

const original = Object.getOwnPropertyDescriptor(globalThis, "document");
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { visibilityState: "visible", addEventListener: () => {} },
});
const { connectionNoticeDelay } = await import("../src/use-connection-notice");
afterAll(() => {
  if (original) Object.defineProperty(globalThis, "document", original);
  else Reflect.deleteProperty(globalThis, "document");
});

test("a freshly loaded page gives its first connection the resume grace period", () => {
  expect(connectionNoticeDelay()).toBeGreaterThan(2_000);
  expect(connectionNoticeDelay(performance.now() + 60_000)).toBe(1_000);
});
