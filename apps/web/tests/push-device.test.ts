import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { currentPushDeviceId } from "../src/push-device";

function browser(getSubscription?: () => Promise<{ endpoint: string } | null>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: getSubscription
      ? { serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription } }) } }
      : {},
  });
  return {
    [Symbol.dispose]() {
      if (original) Object.defineProperty(globalThis, "navigator", original);
      else Reflect.deleteProperty(globalThis, "navigator");
    },
  };
}

test("input device identity matches the server's subscription hash across reloads", async () => {
  const endpoint = "https://fcm.googleapis.com/fcm/send/device";
  using _fixture = browser(async () => ({ endpoint }));
  const expected = createHash("sha256").update(endpoint).digest("hex");
  expect(await currentPushDeviceId()).toBe(expected);
  expect(await currentPushDeviceId()).toBe(expected);
});

test("sending still works without push support, a subscription, or access to the registration", async () => {
  {
    using _fixture = browser();
    expect(await currentPushDeviceId()).toBeUndefined();
  }
  {
    using _fixture = browser(async () => null);
    expect(await currentPushDeviceId()).toBeUndefined();
  }
  {
    using _fixture = browser(async () => {
      throw new Error("Permission denied");
    });
    expect(await currentPushDeviceId()).toBeUndefined();
  }
});
