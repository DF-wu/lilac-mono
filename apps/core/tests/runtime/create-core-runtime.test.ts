import { describe, expect, it } from "bun:test";

import { Panic, Result } from "better-result";
import { CustomCommandDirectoryReadError } from "@stanley2058/lilac-utils";

import { CustomCommandManager } from "../../src/custom-commands/manager";
import {
  adaptCustomCommandInitializationResultToStartup,
  createCoreRuntimeCleanupSupervisor,
} from "../../src/runtime/create-core-runtime";

describe("Core runtime startup", () => {
  it("returns the initialized custom command manager", () => {
    const manager = new CustomCommandManager("/data");

    expect(adaptCustomCommandInitializationResultToStartup(Result.ok(undefined), manager)).toBe(
      manager,
    );
  });

  it("maps custom command initialization failure to a fresh plain startup Error", () => {
    const manager = new CustomCommandManager("/data");
    const discoveryError = new CustomCommandDirectoryReadError({
      directoryPath: "/data/cmds",
      cause: new Error("permission denied"),
      message: "Failed to read custom command directory '/data/cmds': permission denied",
    });

    let thrown: unknown;
    try {
      adaptCustomCommandInitializationResultToStartup(Result.err(discoveryError), manager);
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(thrown)).toBe(Error.prototype);
    expect(thrown).not.toBe(discoveryError);
    expect(thrown).toHaveProperty("message", discoveryError.message);
    expect(thrown).not.toHaveProperty("cause");
  });

  it.each([
    ["Error", () => new Error("cleanup failed")],
    ["Panic", () => new Panic({ message: "cleanup invariant failed" })],
  ] as const)(
    "preserves a startup Panic through cleanup %s and continues cleanup",
    async (_, cause) => {
      const startupPanic = new Panic({ message: "startup invariant failed" });
      const cleanupFailure = cause();
      const calls: string[] = [];
      const cleanup = createCoreRuntimeCleanupSupervisor(startupPanic);
      let thrown: unknown;

      try {
        await cleanup.run("failing", async () => {
          calls.push("failing");
          throw cleanupFailure;
        });
        await cleanup.run("continued", async () => {
          calls.push("continued");
        });
        cleanup.finish();
        throw startupPanic;
      } catch (cause) {
        thrown = cause;
      }

      expect(calls).toEqual(["failing", "continued"]);
      expect(cleanup.failures).toEqual([
        {
          label: "failing",
          error: cleanupFailure.message,
          panic: Panic.is(cleanupFailure),
        },
      ]);
      expect(thrown).toBe(startupPanic);
    },
  );

  it("continues cleanup before propagating the first cleanup Panic without a prior Panic", async () => {
    const firstPanic = new Panic({ message: "first cleanup invariant failed" });
    const secondPanic = new Panic({ message: "second cleanup invariant failed" });
    const calls: string[] = [];
    const cleanup = createCoreRuntimeCleanupSupervisor(null);

    await cleanup.run("first", async () => {
      calls.push("first");
      throw firstPanic;
    });
    await cleanup.run("second", async () => {
      calls.push("second");
      throw secondPanic;
    });
    await cleanup.run("continued", async () => {
      calls.push("continued");
    });

    expect(calls).toEqual(["first", "second", "continued"]);
    expect(() => cleanup.finish()).toThrow(firstPanic);
  });

  it("contains a revoked cleanup cause, continues cleanup, and preserves the startup Panic", async () => {
    const startupPanic = new Panic({ message: "startup invariant failed" });
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const calls: string[] = [];
    const cleanup = createCoreRuntimeCleanupSupervisor(startupPanic);

    await cleanup.run("revoked", async () => {
      calls.push("revoked");
      throw proxy;
    });
    await cleanup.run("continued", async () => {
      calls.push("continued");
    });

    expect(calls).toEqual(["revoked", "continued"]);
    expect(cleanup.failures).toEqual([
      { label: "revoked", error: "Opaque cleanup failure", panic: false },
    ]);
    expect(() => {
      cleanup.finish();
      throw startupPanic;
    }).toThrow(startupPanic);
  });
});
