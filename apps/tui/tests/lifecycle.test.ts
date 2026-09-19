import { expect, test } from "bun:test";
import { Panic } from "better-result";
import { runTuiHost, runTuiWithCleanup } from "../src/main";

test("terminal cleanup settles before preserving the original operation Panic", async () => {
  const original = new Panic({ message: "synthetic operation defect" });
  const cleanup = new Panic({ message: "synthetic cleanup defect" });
  const calls: string[] = [];
  const operation = runTuiWithCleanup(
    async () => {
      calls.push("operation");
      throw original;
    },
    async () => {
      calls.push("cleanup");
      throw cleanup;
    },
  );
  await expect(operation).rejects.toBe(original);
  expect(calls).toEqual(["operation", "cleanup"]);
});

test("cleanup Panic wins over an ordinary operation exception", async () => {
  const original = new Error("synthetic operation failure");
  const cleanup = new Panic({ message: "synthetic cleanup defect" });
  await expect(
    runTuiWithCleanup(
      async () => {
        throw original;
      },
      async () => {
        throw cleanup;
      },
    ),
  ).rejects.toBe(cleanup);
});

test("ordinary operation defects also retain identity after cleanup", async () => {
  const original = new Error("synthetic defect");
  let cleaned = false;
  await expect(
    runTuiWithCleanup(
      async () => {
        throw original;
      },
      async () => {
        cleaned = true;
      },
    ),
  ).rejects.toBe(original);
  expect(cleaned).toBe(true);
});

test("successful operation still surfaces failed cleanup", async () => {
  const cleanup = new Error("synthetic cleanup failure");
  await expect(
    runTuiWithCleanup(
      async () => {},
      async () => {
        throw cleanup;
      },
    ),
  ).rejects.toBe(cleanup);
});

test("final host reports a sanitized fatal error after cleanup", async () => {
  const original = new Panic({ message: "synthetic private payload" });
  const events: string[] = [];
  const status = await runTuiHost(
    async () => {
      await runTuiWithCleanup(
        async () => {
          throw original;
        },
        async () => {
          events.push("cleanup");
        },
      );
      return 0;
    },
    (message) => events.push(message),
  );
  expect(status).toBe(1);
  expect(events[0]).toBe("cleanup");
  expect(events[1]).toContain("internal error");
  expect(events.join(" ")).not.toContain("synthetic private payload");
  expect(
    await runTuiHost(
      async () => 42,
      () => {},
    ),
  ).toBe(42);
});
