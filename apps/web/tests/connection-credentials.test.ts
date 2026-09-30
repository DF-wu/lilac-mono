import { expect, test } from "bun:test";
import {
  prepareWebConnection,
  readConnectionToken,
  registerConnectionCredentials,
} from "../src/connection-credentials";

test("connection preparation awaits the active credentials and ignores stale cleanup", async () => {
  const old = registerConnectionCredentials(async () => {
    throw new Error("Stale provider");
  });
  const token = Promise.withResolvers<string>();
  const stop = registerConnectionCredentials(() => token.promise);
  old();
  let ready = false;
  const preparing = prepareWebConnection().then(() => {
    ready = true;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  token.resolve("fresh-token");
  await preparing;
  expect(ready).toBe(true);
  expect(await readConnectionToken()).toBe("fresh-token");
  stop();
  expect(await readConnectionToken()).toBeUndefined();
  await prepareWebConnection();
});

test("credential refresh errors reach connection retry without sending unauthenticated requests", async () => {
  const stop = registerConnectionCredentials(async () => {
    throw new Error("Offline");
  });
  await expect(prepareWebConnection()).rejects.toThrow("Offline");
  stop();
});
