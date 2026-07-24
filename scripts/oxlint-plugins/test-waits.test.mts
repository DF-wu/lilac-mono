import { describe, expect, it } from "bun:test";

import { findTestWaitViolations, formatTestWaitViolation } from "./test-waits.mts";

describe("test wait policy", () => {
  it("flags fixed Bun.sleep delays, including aliases and zero-duration yields", () => {
    const violations = findTestWaitViolations(`
      const runtime = Bun;
      const { sleep: originalWait } = runtime;
      const wait = originalWait;
      const FIXED_DELAY = 2 * 5;
      await Bun.sleep(0);
      await wait(FIXED_DELAY);
      await Bun.sleep(-1);
      await Bun.sleep(variableDelay);
    `);

    expect(violations.map((violation) => violation.kind)).toEqual(["bun-sleep", "bun-sleep"]);
  });

  it("flags direct, namespace, require, and chained aliases of node promise timers", () => {
    const violations = findTestWaitViolations(`
      import { setTimeout as delay } from "node:timers/promises";
      import * as timers from "timers/promises";
      const { setTimeout: namespacedDelay } = timers;
      const promisedTimers = require("node:timers/promises");
      const pause = delay;
      await pause(1);
      return timers.setTimeout(2);
      await promisedTimers.setTimeout(3);
      await namespacedDelay(4);
    `);

    expect(violations.map((violation) => violation.kind)).toEqual([
      "node-timer-promise",
      "node-timer-promise",
      "node-timer-promise",
      "node-timer-promise",
    ]);
  });

  it("flags awaited Promises resolved by direct and aliased callback timers", () => {
    const violations = findTestWaitViolations(`
      import { setTimeout as schedule } from "node:timers";
      const later = setTimeout;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((done) => later(() => done("ready"), 5));
      await new Promise((resolve) => schedule(resolve, 10));
      await new Promise((resolve) => globalThis.setTimeout(resolve, 15));
    `);

    expect(violations.map((violation) => violation.kind)).toEqual([
      "promise-timeout",
      "promise-timeout",
      "promise-timeout",
      "promise-timeout",
    ]);
  });

  it("flags fixed calls through one-level local sleep and wait wrappers", () => {
    const violations = findTestWaitViolations(`
      import { setTimeout as timerDelay } from "node:timers/promises";
      async function sleep(ms: number): Promise<void> {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
      }
      const wait = (duration: number) => Bun.sleep(duration);
      function pause(duration: number) {
        return timerDelay(duration);
      }
      const indirect = (duration: number) => sleep(duration);
      const FIXED_DELAY = 2 * 5;
      await sleep(25);
      await wait(FIXED_DELAY);
      await pause(0);
      await sleep(variableDelay);
      await wait(-1);
      await indirect(5);
    `);

    expect(violations.map((violation) => violation.kind)).toEqual([
      "promise-timeout",
      "bun-sleep",
      "node-timer-promise",
    ]);
  });

  it("flags fixed callback timers using split Promise.withResolvers resolvers", () => {
    const violations = findTestWaitViolations(`
      const deferred = Promise.withResolvers<void>();
      const { resolve: finish } = deferred;
      const direct = Promise.withResolvers<void>();
      const FIXED_DELAY = 2 * 5;
      setTimeout(finish, 0);
      globalThis.setTimeout(direct.resolve, FIXED_DELAY);
      setTimeout(() => direct.resolve(), 5);
      setTimeout(finish, dynamicDelay);
      setTimeout(direct.resolve, -1);
    `);

    expect(violations.map((violation) => violation.kind)).toEqual([
      "promise-timeout",
      "promise-timeout",
      "promise-timeout",
    ]);
  });

  it("accepts only a nonempty justification immediately before the containing statement", () => {
    const violations = findTestWaitViolations(`
      // test-wait-justification: verifies the real debounce deadline fires
      await Bun.sleep(5);
      // test-wait-justification:
      await Bun.sleep(5);
      // test-wait-justification: separated comments do not authorize a wait

      await Bun.sleep(5);
      // test-wait-justification: authorizes the whole statement
      await expect(Bun.sleep(5).then(() => "ready")).resolves.toBe("ready");
    `);

    expect(violations).toHaveLength(2);
    expect(violations.map((violation) => violation.line)).toEqual([5, 8]);
  });

  it("does not flag rejection guards, abort timers, dynamic waits, or fixture text", () => {
    const violations = findTestWaitViolations(`
      await Promise.race([
        operation,
        Bun.sleep(100).then(() => { throw new Error("timeout"); }),
        Bun.sleep(100).then(() => { return Promise.reject(new Error("timeout")); }),
      ]);
      await new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 100));
      await new Promise((resolve) => setTimeout(() => controller.abort(), 100));
      await new Promise((resolve) => setTimeout(resolve, duration));
      const fixture = "await Bun.sleep(100); setTimeout(resolve, 5)";
    `);

    expect(violations).toEqual([]);
  });

  it("reports source locations and actionable diagnostics", () => {
    const [violation] = findTestWaitViolations("\nawait Bun.sleep(0);", "sample.test.ts");

    expect(violation).toMatchObject({ filePath: "sample.test.ts", line: 2, column: 7 });
    expect(violation && formatTestWaitViolation(violation)).toContain(
      "sample.test.ts:2:7 [bun-sleep]",
    );
  });
});
