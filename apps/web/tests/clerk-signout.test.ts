import { expect, test } from "bun:test";
import { registerClerkSignOut, signOutActiveClerk } from "../src/clerk-signout";

test("Clerk logout retains a failed operation after the provider leaves the private UI", async () => {
  let attempts = 0;
  registerClerkSignOut(async () => {
    if (attempts++ === 0) throw new Error("Provider unavailable");
  });
  expect((await signOutActiveClerk()).isErr()).toBe(true);
  expect((await signOutActiveClerk()).isOk()).toBe(true);
  expect(attempts).toBe(2);
});

test("native logout retry retains successful provider completion until a new registration", async () => {
  let attempts = 0;
  registerClerkSignOut(async () => {
    attempts++;
  });
  expect((await signOutActiveClerk()).isOk()).toBe(true);
  expect((await signOutActiveClerk()).isOk()).toBe(true);
  expect(attempts).toBe(1);
  registerClerkSignOut(async () => {
    attempts++;
  });
  expect((await signOutActiveClerk()).isOk()).toBe(true);
  expect(attempts).toBe(2);
});

test("a tab can invoke its registered provider for the first time after a logout broadcast", async () => {
  let attempts = 0;
  registerClerkSignOut(async () => {
    attempts++;
  });
  expect((await signOutActiveClerk()).isOk()).toBe(true);
  expect(attempts).toBe(1);
});
