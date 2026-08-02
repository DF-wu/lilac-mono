import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Panic, Result } from "better-result";

import {
  applyStartupLockCleanup,
  connectOnce,
  ensureRuntimeDir,
  executeDaemonRequest,
  releaseStartupLock,
  RemoteFsDaemonStartupError,
  RemoteFsDaemonSpawnError,
  RemoteFsRequestCleanupCombinedError,
  RemoteFsRuntimeSetupError,
  RemoteFsStartupLockCleanupError,
  RemoteFsSocketTransportError,
  reportMainFailure,
  runWithStartupLockCleanup,
  spawnDaemon,
  tryAcquireStartupLock,
} from "../src/cli";

describe("remote fs daemon socket transport", () => {
  let runtimeDir = "";
  const previousRuntimeDir = process.env.LILAC_REMOTE_FS_RUNNER_DIR;

  afterEach(async () => {
    if (previousRuntimeDir === undefined) delete process.env.LILAC_REMOTE_FS_RUNNER_DIR;
    else process.env.LILAC_REMOTE_FS_RUNNER_DIR = previousRuntimeDir;
    if (runtimeDir) await rm(runtimeDir, { recursive: true, force: true });
  });

  it("returns an owned transport error when the daemon socket is unavailable", async () => {
    runtimeDir = await mkdtemp(path.join(tmpdir(), "lilac-remote-fs-socket-"));
    process.env.LILAC_REMOTE_FS_RUNNER_DIR = runtimeDir;

    const result = await connectOnce({
      op: "health",
      input: {},
      denyPaths: [],
      cwd: runtimeDir,
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(RemoteFsSocketTransportError.is(result.error)).toBeTrue();
    }
  });

  it("bounds a daemon that accepts a request without responding", async () => {
    runtimeDir = await mkdtemp(path.join(tmpdir(), "lilac-remote-fs-socket-"));
    process.env.LILAC_REMOTE_FS_RUNNER_DIR = runtimeDir;
    const socket = new net.Socket();
    const createConnection = spyOn(net, "createConnection").mockReturnValue(socket);

    try {
      // test-wait-justification: verifies the real bounded socket response deadline
      const result = await connectOnce(
        { op: "health", input: {}, denyPaths: [], cwd: runtimeDir },
        25,
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(RemoteFsSocketTransportError.is(result.error)).toBeTrue();
        expect(result.error.message).toContain("socket transport failed");
      }
    } finally {
      createConnection.mockRestore();
    }
  });

  it("captures runtime directory filesystem failures as an owned Result", async () => {
    runtimeDir = await mkdtemp(path.join(tmpdir(), "lilac-remote-fs-setup-"));
    const blockingFile = path.join(runtimeDir, "not-a-directory");
    await writeFile(blockingFile, "file");

    const result = await ensureRuntimeDir(path.join(blockingFile, "nested"));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(RemoteFsRuntimeSetupError.is(result.error)).toBeTrue();
    }
  });

  it("captures asynchronous child spawn failures as an owned Result", async () => {
    const result = await spawnDaemon("/lilac/definitely-missing-runtime");

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(RemoteFsDaemonSpawnError.is(result.error)).toBeTrue();
    }
  });

  it("preserves Panic thrown while spawning the daemon", async () => {
    const panic = new Panic({ message: "daemon spawn invariant" });
    let caught: unknown;

    try {
      await spawnDaemon(process.execPath, () => {
        throw panic;
      });
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBe(panic);
  });

  it("preserves Panic thrown while acquiring the startup lock", async () => {
    const panic = new Panic({ message: "startup lock invariant" });
    let caught: unknown;

    try {
      await tryAcquireStartupLock(async () => {
        throw panic;
      });
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBe(panic);
  });

  it("preserves Panic during startup-lock cleanup", async () => {
    const panic = new Panic({ message: "startup lock cleanup invariant" });
    let caught: unknown;

    try {
      await releaseStartupLock(async () => {
        throw panic;
      });
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBe(panic);
  });

  it("returns a typed startup-lock cleanup failure", async () => {
    const result = await releaseStartupLock(async () => {
      throw new Error("remove failed");
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(RemoteFsStartupLockCleanupError.is(result.error)).toBeTrue();
      expect(result.error.message).toContain("failed to release remote fs startup lock");
    }
  });

  it("gives cleanup failure precedence after operation success", () => {
    const cleanupError = new RemoteFsStartupLockCleanupError({
      lockPath: "/tmp/startup.lock",
      cause: new Error("remove failed"),
      message: "cleanup failed",
    });
    const result = applyStartupLockCleanup(
      Result.ok({ ok: false, error: "operation response" }),
      Result.err(cleanupError),
    );

    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toBe(cleanupError);
  });

  it("preserves operation failure when startup-lock cleanup succeeds", () => {
    const operationError = new RemoteFsDaemonStartupError({ message: "daemon failed" });
    const result = applyStartupLockCleanup(Result.err(operationError), Result.ok(undefined));

    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toBe(operationError);
  });

  it("preserves operation and cleanup errors when both fail", () => {
    const operationError = new RemoteFsDaemonStartupError({ message: "daemon failed" });
    const cleanupError = new RemoteFsStartupLockCleanupError({
      lockPath: "/tmp/startup.lock",
      cause: new Error("remove failed"),
      message: "cleanup failed",
    });
    const result = applyStartupLockCleanup(Result.err(operationError), Result.err(cleanupError));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(RemoteFsRequestCleanupCombinedError.is(result.error)).toBeTrue();
      if (RemoteFsRequestCleanupCombinedError.is(result.error)) {
        expect(result.error.operationError).toBe(operationError);
        expect(result.error.cleanupError).toBe(cleanupError);
      }
    }
  });

  it("releases the startup lock after operation Panic and reports cleanup Err", async () => {
    const operationPanic = new Panic({ message: "operation invariant" });
    const cleanupError = new RemoteFsStartupLockCleanupError({
      lockPath: "/tmp/startup.lock",
      cause: new Error("remove failed"),
      message: "cleanup failed",
    });
    const reports: string[] = [];
    let cleanupCalled = false;
    let caught: unknown;

    try {
      await runWithStartupLockCleanup(
        async () => {
          throw operationPanic;
        },
        async () => {
          cleanupCalled = true;
          return Result.err(cleanupError);
        },
        (failure) => reports.push(failure.message),
      );
    } catch (cause) {
      caught = cause;
    }

    expect(cleanupCalled).toBeTrue();
    expect(caught).toBe(operationPanic);
    expect(reports).toEqual(["cleanup failed"]);
  });

  it("keeps the original operation Panic when cleanup also panics", async () => {
    const operationPanic = new Panic({ message: "operation invariant" });
    const cleanupPanic = new Panic({ message: "cleanup invariant" });
    const reports: string[] = [];
    let caught: unknown;

    try {
      await runWithStartupLockCleanup(
        async () => {
          throw operationPanic;
        },
        async () => {
          throw cleanupPanic;
        },
        (failure) => reports.push(failure.message),
      );
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBe(operationPanic);
    expect(reports).toEqual(["cleanup invariant"]);
  });

  it("preserves Panic at the installable runner top level", () => {
    const panic = new Panic({ message: "runner invariant" });

    expect(() => reportMainFailure(panic)).toThrow(panic);
  });

  it("preserves Panic from daemon request execution", async () => {
    const panic = new Panic({ message: "daemon request invariant" });
    let caught: unknown;

    try {
      await executeDaemonRequest(
        { op: "health", input: {}, denyPaths: [], cwd: process.cwd() },
        async () => {
          throw panic;
        },
      );
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBe(panic);
  });

  it("returns an owned daemon error when execution rejects with a revoked proxy", async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    const result = await executeDaemonRequest(
      { op: "health", input: {}, denyPaths: [], cwd: process.cwd() },
      async () => {
        throw proxy;
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected daemon execution failure");
    expect(RemoteFsSocketTransportError.is(result.error)).toBeTrue();
    if (RemoteFsSocketTransportError.is(result.error)) {
      expect(result.error.cause).toBeInstanceOf(Error);
      expect(result.error.cause).toHaveProperty("message", "Opaque remote fs runner failure");
    }
  });
});
