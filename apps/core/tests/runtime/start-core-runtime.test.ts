import { describe, expect, it } from "bun:test";

import { Panic, Result } from "better-result";

import {
  CoreRuntimeCreateFailed,
  CoreRuntimeStartFailed,
  type CoreRuntime,
} from "../../src/runtime/create-core-runtime";
import {
  CoreRuntimeInvocationFailed,
  startCoreRuntime,
} from "../../src/runtime/start-core-runtime";

function createRuntime(startResult: ReturnType<CoreRuntime["start"]>): CoreRuntime {
  return {
    start: () => startResult,
    stop: async () => undefined,
    getBlobStore: () => null,
    recordUnhandledRejection: () => undefined,
  };
}

describe("startCoreRuntime", () => {
  it.each([
    ["create", new Error("create threw")],
    ["start", new Error("start threw")],
    ["create", new Panic({ message: "create threw Panic" })],
    ["start", new Panic({ message: "start threw Panic" })],
  ] as const)("preserves %s invocation throw identity for %s", async (operation, cause) => {
    const runtime = createRuntime(
      Promise.resolve({ kind: "result", result: Result.ok(undefined) }),
    );
    runtime.start = async () => {
      throw cause;
    };
    const result = await startCoreRuntime({
      reportFatalError: () => undefined,
      onUnhealthy: async () => undefined,
      createRuntime: async () => {
        if (operation === "create") throw cause;
        return { kind: "result", result: Result.ok(runtime) };
      },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(CoreRuntimeInvocationFailed);
      expect(result.error).toMatchObject({ operation, cause });
      expect(result.error.cause).toBe(cause);
    }
  });

  it.each(["create", "start"] as const)(
    "retains returned %s Panic as the invocation cause",
    async (operation) => {
      const panic = new Panic({ message: `${operation} defect` });
      const runtime = createRuntime(Promise.resolve({ kind: "panic", panic }));
      const result = await startCoreRuntime({
        reportFatalError: () => undefined,
        onUnhealthy: async () => undefined,
        createRuntime: async () =>
          operation === "create"
            ? { kind: "panic", panic }
            : { kind: "result", result: Result.ok(runtime) },
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(CoreRuntimeInvocationFailed);
        expect(result.error).toMatchObject({ operation, cause: panic });
        expect(result.error.cause).toBe(panic);
      }
    },
  );

  it("returns the runtime after a successful startup", async () => {
    const runtime = createRuntime(
      Promise.resolve({ kind: "result", result: Result.ok(undefined) }),
    );
    const result = await startCoreRuntime({
      reportFatalError: () => undefined,
      onUnhealthy: async () => undefined,
      createRuntime: async () => ({ kind: "result", result: Result.ok(runtime) }),
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toBe(runtime);
  });

  it("preserves runtime creation failures and their operation", async () => {
    const cause = new CoreRuntimeCreateFailed({
      operation: "durable-stores",
      cause: new Error("schema migration required"),
      message: "schema migration required",
    });
    const result = await startCoreRuntime({
      reportFatalError: () => undefined,
      onUnhealthy: async () => undefined,
      createRuntime: async () => ({ kind: "result", result: Result.err(cause) }),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBe(cause);
      expect(result.error).toMatchObject({ operation: "durable-stores" });
    }
  });

  it("preserves runtime start failures and their operation", async () => {
    const cause = new CoreRuntimeStartFailed({
      operation: "heartbeat",
      cause: new Error("Redis unavailable"),
      message: "Redis unavailable",
    });
    const runtime = createRuntime(Promise.resolve({ kind: "result", result: Result.err(cause) }));
    const result = await startCoreRuntime({
      reportFatalError: () => undefined,
      onUnhealthy: async () => undefined,
      createRuntime: async () => ({ kind: "result", result: Result.ok(runtime) }),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBe(cause);
      expect(result.error).toMatchObject({ operation: "heartbeat" });
    }
  });
});
