import { describe, expect, it } from "bun:test";
import { createLogger } from "@stanley2058/lilac-utils";
import { Panic } from "better-result";

import { createProcessHandlers } from "../../src/runtime/process-handlers";

function createLoggerStub() {
  return createLogger({
    module: "process-handlers-test",
  });
}

function createExitCodeHooks() {
  let exitCode: number | undefined;
  return {
    getExitCode: () => exitCode,
    setExitCode: (code: number) => {
      exitCode = code;
    },
  };
}

describe("createProcessHandlers", () => {
  it("logs unhandled rejections without exiting", () => {
    const seen: unknown[] = [];
    const exitCalls: number[] = [];
    const exitCodeHooks = createExitCodeHooks();
    const handlers = createProcessHandlers({
      logger: createLoggerStub(),
      stop: async () => {},
      recordUnhandledRejection: (reason) => {
        seen.push(reason);
      },
      getExitCode: exitCodeHooks.getExitCode,
      setExitCode: exitCodeHooks.setExitCode,
      exit: ((code: number) => {
        exitCalls.push(code);
        return undefined as never;
      }) as (code: number) => never,
    });

    handlers.handleUnhandledRejection(new Error("boom"), Promise.resolve(undefined));

    expect(seen).toHaveLength(1);
    expect(exitCalls).toEqual([]);
  });

  it("treats uncaught exceptions as fatal and exits after stop", async () => {
    const exitCalls: number[] = [];
    let stopCalls = 0;
    const exitCodeHooks = createExitCodeHooks();
    const handlers = createProcessHandlers({
      logger: createLoggerStub(),
      stop: async () => {
        stopCalls += 1;
      },
      getExitCode: exitCodeHooks.getExitCode,
      setExitCode: exitCodeHooks.setExitCode,
      exit: ((code: number) => {
        exitCalls.push(code);
        return undefined as never;
      }) as (code: number) => never,
    });

    handlers.handleUncaughtException(new Error("fatal"));
    // test-wait-justification: yields until the fatal handler's asynchronous stop and exit sequence completes
    await Bun.sleep(0);

    expect(stopCalls).toBe(1);
    expect(exitCalls).toEqual([1]);
  });

  it("reports a Panic through fatal supervision without losing its identity", async () => {
    const panic = new Panic({ message: "agent runner invariant failed" });
    const stoppedWith: Array<Error | undefined> = [];
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const exitCodeHooks = createExitCodeHooks();
    const handlers = createProcessHandlers({
      logger: createLoggerStub(),
      stop: async (fatalError) => {
        stoppedWith.push(fatalError);
      },
      getExitCode: exitCodeHooks.getExitCode,
      setExitCode: exitCodeHooks.setExitCode,
      exit: ((code: number) => {
        resolveExit(code);
        return undefined as never;
      }) as (code: number) => never,
    });

    handlers.reportFatalError(panic);

    await expect(exited).resolves.toBe(1);
    expect(stoppedWith).toEqual([panic]);
  });

  it("exits immediately on a second fatal error during shutdown", async () => {
    const exitCalls: number[] = [];
    let resolveStop!: () => void;
    const exitCodeHooks = createExitCodeHooks();
    const stopPromise = new Promise<void>((resolve) => {
      resolveStop = () => resolve();
    });
    const handlers = createProcessHandlers({
      logger: createLoggerStub(),
      stop: async () => {
        await stopPromise;
      },
      getExitCode: exitCodeHooks.getExitCode,
      setExitCode: exitCodeHooks.setExitCode,
      exit: ((code: number) => {
        exitCalls.push(code);
        return undefined as never;
      }) as (code: number) => never,
    });

    void handlers.handleSignal("SIGTERM");
    handlers.handleUncaughtException(new Error("fatal during shutdown"));
    // test-wait-justification: yields until the concurrently started signal shutdown enters its pending stop
    await Bun.sleep(0);

    expect(exitCalls).toEqual([1]);

    resolveStop();
    // test-wait-justification: drains the released asynchronous shutdown before the test returns
    await Bun.sleep(0);
  });
});
