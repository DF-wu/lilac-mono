import { afterEach, expect, test } from "bun:test";
import { readMotionDuration } from "../src/theme/motion";

const globals = ["document", "matchMedia", "getComputedStyle"] as const;
const descriptors = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
afterEach(() => {
  globals.forEach((name, index) => {
    const descriptor = descriptors[index];
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  });
});

function browserMotion(value: string, animation = "slow", reduced = false) {
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: { documentElement: { dataset: { animation } } } },
    matchMedia: { configurable: true, value: () => ({ matches: reduced }) },
    getComputedStyle: {
      configurable: true,
      value: () => ({
        getPropertyValue: (name: string) => {
          expect(name).toBe("--ui-motion-duration");
          return value;
        },
      }),
    },
  });
}

test("sidebar motion reads development and production CSS times in milliseconds", () => {
  for (const [value, expected] of [
    ["350ms", 350],
    [".35s", 350],
    ["150ms", 150],
    [".15s", 150],
    ["0s", 0],
  ] as const) {
    browserMotion(value);
    expect(readMotionDuration()).toBe(expected);
  }
});

test("sidebar motion honors disabled and reduced motion", () => {
  browserMotion(".35s", "off");
  expect(readMotionDuration()).toBe(0);
  browserMotion(".35s", "slow", true);
  expect(readMotionDuration()).toBe(0);
});
