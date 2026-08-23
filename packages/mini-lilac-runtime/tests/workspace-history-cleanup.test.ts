import {
  type LockedWorkspaceHistoryStore,
  describe,
  expect,
  it,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
  path,
  Panic,
  Result,
  WorkspaceHistoryCleanupFailed,
  WorkspaceHistoryOperationAndCleanupFailed,
  WorkspaceHistoryStore,
  WorkspaceHistoryStoreError,
  temporaryDirectory,
  createStore,
  captured,
  openFileDescriptorTargets,
} from "./workspace-history-test-support";

describe("WorkspaceHistoryStore", () => {
  it("uses exclusively owned operation directories for every private writer", async () => {
    const root = await temporaryDirectory();
    const observedModes: number[] = [];
    const { workspace, store } = await createStore(root, {
      testHooks: {
        beforePrivateFilePublish: async (_operation, temporaryPath) => {
          observedModes.push((await stat(path.dirname(temporaryPath))).mode & 0o777);
        },
      },
    });
    await writeFile(path.join(workspace, "file.txt"), "content\n");

    await captured(store);
    expect(observedModes.length).toBeGreaterThanOrEqual(5);
    expect(new Set(observedModes)).toEqual(new Set([0o700]));
  });

  it("syncs the held target directory descriptor after its pathname is replaced", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "first\n");
    await captured(store);
    const priorCache = await readFile(
      path.join(store.storeDirectory, "capture-cache.json"),
      "utf8",
    );
    await writeFile(path.join(workspace, "file.txt"), "second\n");
    let displacedDirectory: string | undefined;
    const replacing = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        afterPrivateFilePublishBeforeDirectorySync: async (
          operation,
          targetDirectory,
          targetPath,
        ) => {
          if (operation !== "write capture cache") return;
          expect(targetPath).toBe(path.join(targetDirectory, "capture-cache.json"));
          displacedDirectory = `${targetDirectory}.sync-displaced`;
          await rename(targetDirectory, displacedDirectory);
          await writeFile(targetDirectory, "replacement at directory pathname\n");
        },
      },
    });

    const result = await replacing.captureResult();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBeInstanceOf(WorkspaceHistoryCleanupFailed);
    }
    expect(displacedDirectory).toBeDefined();
    expect(await readFile(store.storeDirectory, "utf8")).toBe(
      "replacement at directory pathname\n",
    );
    if (displacedDirectory) {
      expect(await readFile(path.join(displacedDirectory, "capture-cache.json"), "utf8")).not.toBe(
        priorCache,
      );
    }
  });

  it("closes and unlinks atomic-write temporaries when stat or close fails", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "first\n");
    await captured(store);
    const cachePath = path.join(store.storeDirectory, "capture-cache.json");
    const priorCache = await readFile(cachePath, "utf8");
    await writeFile(path.join(workspace, "file.txt"), "second\n");

    for (const phase of ["stat", "close"] as const) {
      let temporaryPath: string | undefined;
      const failing = new WorkspaceHistoryStore({
        cwd: workspace,
        historyRoot: history,
        workspaceId: "workspace-01",
        namespaceId: "namespace-01",
        databasePathHash: "database-hash-01",
        testHooks: {
          beforePrivateFileStat: (operation, candidate) => {
            if (phase !== "stat" || operation !== "write capture cache") return;
            temporaryPath = candidate;
            throw new Error("injected temporary stat failure");
          },
          beforePrivateFileClose: (operation, candidate) => {
            if (phase !== "close" || operation !== "write capture cache") return;
            temporaryPath = candidate;
            throw new Error("injected temporary close failure");
          },
        },
      });
      const captureFailure = async (): Promise<void> => {
        expect(await failing.captureResult()).toMatchObject({
          status: "error",
          error: { code: "filesystem-error", operation: "write capture cache" },
        });
      };

      await captureFailure();
      expect(temporaryPath).toBeDefined();
      if (temporaryPath) {
        expect(await lstat(temporaryPath).catch(() => undefined)).toBeUndefined();
        const descriptorTargets = await openFileDescriptorTargets();
        if (descriptorTargets) {
          expect(
            descriptorTargets.some(
              (target) => target === temporaryPath || target === `${temporaryPath} (deleted)`,
            ),
          ).toBe(false);
        }
      }
      expect(await readFile(cachePath, "utf8")).toBe(priorCache);
      expect((await readdir(store.storeDirectory)).filter((name) => name.endsWith(".tmp"))).toEqual(
        [],
      );
    }
  });

  it("closes the descriptor but preserves a replacement installed before temporary stat", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "first\n");
    await captured(store);
    const cachePath = path.join(store.storeDirectory, "capture-cache.json");
    const priorCache = await readFile(cachePath, "utf8");
    await writeFile(path.join(workspace, "file.txt"), "second\n");
    let replacementPath: string | undefined;
    const failing = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        beforePrivateFileStat: async (operation, candidate) => {
          if (operation !== "write capture cache") return;
          replacementPath = candidate;
          await rm(candidate);
          await writeFile(candidate, "unowned replacement\n");
          throw new Error("injected replacement before temporary stat");
        },
      },
    });

    const result = await failing.captureResult();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBeInstanceOf(WorkspaceHistoryOperationAndCleanupFailed);
    }
    expect(replacementPath).toBeDefined();
    if (replacementPath) {
      expect(await readFile(replacementPath, "utf8")).toBe("unowned replacement\n");
      const descriptorTargets = await openFileDescriptorTargets();
      if (descriptorTargets) {
        expect(
          descriptorTargets.some(
            (target) => target === replacementPath || target === `${replacementPath} (deleted)`,
          ),
        ).toBe(false);
      }
    }
    expect(await readFile(cachePath, "utf8")).toBe(priorCache);
  });

  it("removes the exact temporary path while preserving a primary Panic over cleanup failure", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "first\n");
    await captured(store);
    await writeFile(path.join(workspace, "file.txt"), "second\n");
    const primaryPanic = new Panic({ message: "temporary stat invariant" });
    let temporaryPath: string | undefined;
    const failing = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        beforePrivateFileStat: (operation, candidate) => {
          if (operation !== "write capture cache") return;
          temporaryPath = candidate;
          throw primaryPanic;
        },
        beforePrivateFileCleanup: (operation) => {
          if (operation === "write capture cache") throw new Error("injected unlink failure");
        },
      },
    });

    const settled = await failing.captureResult().then(
      (value) => ({ status: "resolved" as const, value }),
      (cause: unknown) => ({ status: "rejected" as const, cause }),
    );
    expect(settled).toEqual({ status: "rejected", cause: primaryPanic });
    expect(temporaryPath).toBeDefined();
    if (temporaryPath) {
      expect(await lstat(temporaryPath).catch(() => undefined)).toBeUndefined();
    }
    expect((await readdir(store.storeDirectory)).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("returns owned cleanup-only and combined failures from the workspace-lock Result", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "target\n");
    const target = await captured(store);
    await writeFile(path.join(workspace, "file.txt"), "source\n");
    const source = await captured(store);
    const cleanupStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        beforePreparedRestoreDispose: () => {
          throw new Error("cleanup failed");
        },
      },
    });
    const prepare = async () =>
      await cleanupStore.withWorkspaceLockResult(async (lockedStore) => {
        const prepared = await lockedStore.prepareRestore(target.rootTreeOid, {
          status: "captured",
          rootTreeOid: source.rootTreeOid,
        });
        expect(prepared.status).toBe("prepared");
      });

    const cleanupOnly = await prepare();
    expect(cleanupOnly.status).toBe("error");
    if (cleanupOnly.status === "error") {
      expect(cleanupOnly.error).toBeInstanceOf(WorkspaceHistoryCleanupFailed);
      if (cleanupOnly.error instanceof WorkspaceHistoryCleanupFailed) {
        expect(cleanupOnly.error.failures).toHaveLength(1);
      }
    }

    const primary = new WorkspaceHistoryStoreError({
      code: "restore-conflict",
      operation: "test primary",
      message: "primary failed",
    });
    const combined = await cleanupStore.withWorkspaceLockResult(async (lockedStore) => {
      const prepared = await lockedStore.prepareRestore(target.rootTreeOid, {
        status: "captured",
        rootTreeOid: source.rootTreeOid,
      });
      expect(prepared.status).toBe("prepared");
      throw primary;
    });
    expect(combined.status).toBe("error");
    if (combined.status === "error") {
      expect(combined.error).toBeInstanceOf(WorkspaceHistoryOperationAndCleanupFailed);
      if (combined.error instanceof WorkspaceHistoryOperationAndCleanupFailed) {
        expect(combined.error.primary).toBe(primary);
        expect(combined.error.cleanup.failures).toHaveLength(1);
      }
    }
  });

  it("preserves the exact primary Panic when workspace-lock cleanup also panics", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "target\n");
    const target = await captured(store);
    await writeFile(path.join(workspace, "file.txt"), "source\n");
    const source = await captured(store);
    const cleanupPanic = new Panic({ message: "cleanup invariant" });
    const primaryPanic = new Panic({ message: "primary invariant" });
    const panicStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        beforePreparedRestoreDispose: () => {
          throw cleanupPanic;
        },
      },
    });

    const result = panicStore.withWorkspaceLockResult(async (lockedStore) => {
      const prepared = await lockedStore.prepareRestore(target.rootTreeOid, {
        status: "captured",
        rootTreeOid: source.rootTreeOid,
      });
      expect(prepared.status).toBe("prepared");
      throw primaryPanic;
    });
    await expect(result).rejects.toBe(primaryPanic);
  });

  it("runs private-Git cleanup after failures and Panic while closing hash inputs", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    const filePath = path.join(workspace, "file.txt");
    await writeFile(filePath, "first\n");
    await captured(store);
    await writeFile(filePath, "second\n");
    const cleanupFailure = new WorkspaceHistoryStoreError({
      code: "git-command-failed",
      operation: "private Git cleanup fixture",
      message: "private Git cleanup failed",
    });
    const failing = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        beforePrivateGit: (args) => {
          if (args[0] === "hash-object") throw new Error("private Git failed");
        },
        afterPrivateGit: (args) => {
          if (args[0] === "hash-object") throw cleanupFailure;
        },
      },
    });

    const result = await failing.captureResult();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBeInstanceOf(WorkspaceHistoryOperationAndCleanupFailed);
      if (result.error instanceof WorkspaceHistoryOperationAndCleanupFailed) {
        expect(result.error.cleanup.failures).toEqual([cleanupFailure]);
      }
    }
    const descriptorTargets = await openFileDescriptorTargets();
    if (descriptorTargets) expect(descriptorTargets).not.toContain(filePath);

    const primaryPanic = new Panic({ message: "private Git invariant" });
    const panicStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        beforePrivateGit: (args) => {
          if (args[0] === "hash-object") throw primaryPanic;
        },
        afterPrivateGit: (args) => {
          if (args[0] === "hash-object") throw new Error("cleanup after Panic failed");
        },
      },
    });
    await expect(panicStore.captureResult()).rejects.toBe(primaryPanic);
    const panicDescriptorTargets = await openFileDescriptorTargets();
    if (panicDescriptorTargets) expect(panicDescriptorTargets).not.toContain(filePath);
  });

  it("preserves exact throwing lock callback identity when cleanup succeeds", async () => {
    const root = await temporaryDirectory();
    const { store } = await createStore(root);
    const callbackFailure = new TypeError("callback fixture");

    await expect(
      store.withWorkspaceLock(async () => {
        throw callbackFailure;
      }),
    ).rejects.toBe(callbackFailure);
  });

  it("dispatches withWorkspaceLockResult through a legacy lock override", async () => {
    const root = await temporaryDirectory();
    const { workspace, history } = await createStore(root);
    let lockCalls = 0;
    class LockOverrideStore extends WorkspaceHistoryStore {
      override async withWorkspaceLock<T>(
        callback: (lockedStore: LockedWorkspaceHistoryStore) => Promise<T>,
      ): Promise<T> {
        lockCalls += 1;
        return await callback({
          capture: async () => ({ status: "skipped", reason: "git-unavailable" }),
          captureResult: async () =>
            Result.ok({ status: "skipped" as const, reason: "git-unavailable" as const }),
          invalidateCaptureCacheResult: async () => Result.ok(undefined),
          prepareRestore: async () => ({ status: "skipped", reason: "git-unavailable" }),
        });
      }
    }
    const store = new LockOverrideStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-lock-override",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
    });

    expect(
      await store.withWorkspaceLockResult(async (lockedStore) => await lockedStore.capture()),
    ).toMatchObject({
      status: "ok",
      value: { status: "skipped", reason: "git-unavailable" },
    });
    expect(lockCalls).toBe(1);
  });

  it("maps legacy lock override errors while preserving Panic identity", async () => {
    const root = await temporaryDirectory();
    const { workspace, history } = await createStore(root);
    const callbackFailure = new TypeError("legacy lock override failed");
    const primaryPanic = new Panic({ message: "legacy lock override invariant" });
    class FailingLockStore extends WorkspaceHistoryStore {
      constructor(private readonly failure: Error | Panic) {
        super({
          cwd: workspace,
          historyRoot: history,
          workspaceId: `workspace-lock-${Panic.is(failure) ? "panic" : "error"}`,
          namespaceId: "namespace-01",
          databasePathHash: "database-hash-01",
        });
      }

      override async withWorkspaceLock<T>(): Promise<T> {
        throw this.failure;
      }
    }

    const failed = await new FailingLockStore(callbackFailure).withWorkspaceLockResult(
      async () => undefined,
    );
    expect(failed).toMatchObject({
      status: "error",
      error: { code: "filesystem-error", operation: "run workspace history lock callback" },
    });
    await expect(
      new FailingLockStore(primaryPanic).withWorkspaceLockResult(async () => undefined),
    ).rejects.toBe(primaryPanic);
  });

  it("dispatches Result entry points through subclass throwing-method overrides", async () => {
    const root = await temporaryDirectory();
    const { workspace, history } = await createStore(root);
    const calls: string[] = [];
    class OverrideStore extends WorkspaceHistoryStore {
      override async capability() {
        calls.push("capability");
        return { status: "unavailable" as const, reason: "platform-unsupported" as const };
      }

      override async capture() {
        calls.push("capture");
        return { status: "skipped" as const, reason: "platform-unsupported" as const };
      }

      override async cleanupStaleRestoreArtifacts() {
        calls.push("cleanup");
        return { removed: [], preserved: [] };
      }
    }
    const store = new OverrideStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-override",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
    });

    expect(await store.capabilityResult()).toMatchObject({
      status: "ok",
      value: { status: "unavailable", reason: "platform-unsupported" },
    });
    expect(await store.captureResult()).toMatchObject({
      status: "ok",
      value: { status: "skipped", reason: "platform-unsupported" },
    });
    expect(await store.cleanupStaleRestoreArtifactsResult()).toMatchObject({
      status: "ok",
      value: { removed: [], preserved: [] },
    });
    expect(calls).toEqual(["capability", "capture", "cleanup"]);
  });

  it("returns owned failures from Result entry points", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "first\n");
    await captured(store);
    const mismatched = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "different-namespace",
      databasePathHash: "database-hash-01",
    });

    const result = await mismatched.captureResult();
    expect(result).toMatchObject({
      status: "error",
      error: { code: "ownership-mismatch", operation: "verify store ownership" },
    });
  });
});
