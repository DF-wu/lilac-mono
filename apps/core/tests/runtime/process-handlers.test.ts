import { describe, expect, it } from "bun:test";
import { createLogger } from "@stanley2058/lilac-utils";
import { Panic } from "better-result";

import { createProcessHandlers } from "../../src/runtime/process-handlers";
import {
  captureRuntimeError,
  projectRuntimeError,
  safeRuntimeErrorText,
} from "../../src/runtime/error-format";

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
  it("passes one absolute hard deadline to runtime shutdown", async () => {
    const exitCodeHooks = createExitCodeHooks();
    const deadlines: number[] = [];
    const before = Date.now();
    const handlers = createProcessHandlers({
      logger: createLoggerStub(),
      stop: async (_fatalError, hardDeadlineAtMs) => {
        if (hardDeadlineAtMs !== undefined) deadlines.push(hardDeadlineAtMs);
      },
      getExitCode: exitCodeHooks.getExitCode,
      setExitCode: exitCodeHooks.setExitCode,
      exitTimeoutMs: 2_000,
      exit: (() => undefined as never) as (code: number) => never,
    });

    await handlers.handleSignal("SIGTERM");

    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]).toBeGreaterThanOrEqual(before + 2_000);
    expect(deadlines[0]).toBeLessThanOrEqual(Date.now() + 2_000);
  });

  it("redacts standalone provider and AWS credential formats", () => {
    const credentials = [
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "github_pat_abcdefghijklmnopqrstuvwxyz123456",
      "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "xoxb-1234567890-abcdefghijklmnopqrstuvwxyz",
      "AKIAIOSFODNN7EXAMPLE",
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      `FwoG${"A".repeat(96)}`,
    ] as const;

    for (const credential of credentials) {
      const redacted = safeRuntimeErrorText(new Error(credential), "fallback");
      expect(redacted).toBe("<redacted>");
      expect(redacted).not.toContain(credential);
    }
  });

  it("safely projects revoked failures", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(captureRuntimeError(proxy)).toEqual({ kind: "opaque" });
    const projected = projectRuntimeError(proxy, "Opaque revoked process failure");
    expect(projected).toBeInstanceOf(Error);
    expect(projected.message).toBe("Opaque revoked process failure");
  });

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
