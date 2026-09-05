import {
  type WorkspaceHistoryMetric,
  describe,
  expect,
  it,
  lstat,
  mkdir,
  readFile,
  rm,
  writeFile,
  path,
  WorkspaceHistoryStore,
  deferred,
  temporaryDirectory,
  git,
  createStore,
  captured,
} from "./workspace-history-test-support";

describe("WorkspaceHistoryStore", () => {
  it("emits best-effort capture and restore metrics without path contents", async () => {
    const root = await temporaryDirectory();
    const metrics: WorkspaceHistoryMetric[] = [];
    let metricNotification = deferred();
    const waitForMetrics = async (count: number): Promise<void> => {
      while (metrics.length < count) await metricNotification.promise;
    };
    const { workspace, store } = await createStore(root, {
      onMetric: (metric) => {
        metrics.push(metric);
        metricNotification.resolve();
        metricNotification = deferred();
      },
    });
    await writeFile(path.join(workspace, "file.txt"), "target\n");
    const target = await captured(store);
    await captured(store);
    await waitForMetrics(2);
    const captureMetrics = metrics.filter((metric) => metric.type === "capture");
    expect(captureMetrics).toHaveLength(2);
    expect(captureMetrics[0]).toMatchObject({
      workspaceId: "workspace-01",
      outcome: "captured",
      changed: true,
      candidatePathCount: 1,
      managedPathCount: 1,
      payloadBytes: 7n,
    });
    expect(captureMetrics[1]).toMatchObject({ changed: false, payloadBytes: 0n });

    await writeFile(path.join(workspace, "file.txt"), "source\n");
    const source = await captured(store);
    await waitForMetrics(3);
    metrics.length = 0;
    expect(
      await store.restore(target.rootTreeOid, {
        status: "captured",
        rootTreeOid: source.rootTreeOid,
      }),
    ).toEqual({ status: "restored" });
    await waitForMetrics(1);
    expect(metrics.filter((metric) => metric.type === "restore")).toEqual([
      expect.objectContaining({
        outcome: "restored",
        changed: true,
        candidatePathCount: 1,
        managedPathCount: 1,
        payloadBytes: 14n,
      }),
    ]);
    metrics.length = 0;
    expect(await store.restore(target.rootTreeOid)).toEqual({ status: "restored" });
    await waitForMetrics(1);
    expect(metrics.filter((metric) => metric.type === "restore")).toEqual([
      expect.objectContaining({ outcome: "restored", changed: false, payloadBytes: 7n }),
    ]);

    await writeFile(path.join(workspace, "file.txt"), "verification failure\n");
    metrics.length = 0;
    await expect(store.verifySnapshot(target.rootTreeOid)).rejects.toMatchObject({
      operation: "verify restored workspace",
    });
    await waitForMetrics(2);
    expect(metrics.filter((metric) => metric.type === "verify")).toEqual([
      expect.objectContaining({ outcome: "failed", managedPathCount: 1 }),
    ]);
    expect(metrics.filter((metric) => metric.type === "verification-failure")).toEqual([
      expect.objectContaining({ operation: "verify", errorCode: "filesystem-error" }),
    ]);

    const syncRejectionObserved = deferred();
    const throwingStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: path.join(root, "throwing-metric-history"),
      workspaceId: "workspace-throwing-metric",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      onMetric: () => {
        syncRejectionObserved.resolve();
        throw new Error("metric callback failure");
      },
    });
    await expect(throwingStore.capture()).resolves.toMatchObject({ status: "captured" });
    await syncRejectionObserved.promise;

    const asyncRejectionObserved = deferred();
    const rejectingStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: path.join(root, "rejecting-metric-history"),
      workspaceId: "workspace-rejecting-metric",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      onMetric: async () => {
        asyncRejectionObserved.resolve();
        throw new Error("async metric callback failure");
      },
    });
    await expect(rejectingStore.capture()).resolves.toMatchObject({ status: "captured" });
    await asyncRejectionObserved.promise;

    const unavailableMetrics: WorkspaceHistoryMetric[] = [];
    const unavailableMetricObserved = deferred();
    const unavailableStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: path.join(root, "unavailable-metric-history"),
      workspaceId: "workspace-unavailable-metric",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      gitExecutable: path.join(root, "missing-git"),
      onMetric: (metric) => {
        unavailableMetrics.push(metric);
        unavailableMetricObserved.resolve();
      },
    });
    expect(await unavailableStore.capability()).toEqual({
      status: "unavailable",
      reason: "git-unavailable",
    });
    await unavailableMetricObserved.promise;
    expect(unavailableMetrics).toEqual([
      expect.objectContaining({
        type: "capability-unavailable",
        reason: "git-unavailable",
        workspaceId: "workspace-unavailable-metric",
      }),
    ]);
  });

  it("runs metric callbacks after the outer lock and queues callback-initiated operations", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    const history = path.join(root, "history");
    await mkdir(workspace);
    await git(workspace, ["init", "--quiet"]);
    await writeFile(path.join(workspace, "file.txt"), "content\n");
    const callbackFinished = deferred();
    let callbackStarted = false;
    let callbackTriggered = false;
    let expectedRootTreeOid = "";
    let store!: WorkspaceHistoryStore;
    store = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-metric-reentry",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      onMetric: async (metric) => {
        if (metric.type !== "capture" || callbackTriggered) return;
        callbackTriggered = true;
        callbackStarted = true;
        const nested = await store.capture();
        expect(nested).toMatchObject({ status: "captured", rootTreeOid: expectedRootTreeOid });
        await store.runMaintenance({
          loadExpectedRootTreeOids: () => [expectedRootTreeOid],
          orphanGracePeriodMs: 1_000,
        });
        callbackFinished.resolve();
      },
    });

    await store.withWorkspaceLock(async (lockedStore) => {
      const outer = await lockedStore.capture();
      if (outer.status !== "captured") throw new Error("capture unavailable");
      expectedRootTreeOid = outer.rootTreeOid;
      expect(callbackStarted).toBe(false);
    });
    await callbackFinished.promise;
    expect(callbackStarted).toBe(true);
  });

  it("serializes maintenance and restore with the shared workspace lock", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "target\n");
    const target = await captured(store);
    await writeFile(path.join(workspace, "file.txt"), "source\n");
    const source = await captured(store);
    const gcEntered = deferred();
    const releaseGc = deferred();
    let restoreEntered = false;
    const lockedStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        beforePrivateGit: async (args) => {
          if (!args.includes("gc")) return;
          gcEntered.resolve();
          await releaseGc.promise;
        },
        afterBoundSourceCapture: () => {
          restoreEntered = true;
        },
      },
    });
    const maintenance = lockedStore.runMaintenance({
      loadExpectedRootTreeOids: () => [target.rootTreeOid, source.rootTreeOid],
      orphanGracePeriodMs: 1_000,
    });
    await gcEntered.promise;
    const restore = lockedStore.restore(target.rootTreeOid, {
      status: "captured",
      rootTreeOid: source.rootTreeOid,
    });
    expect(restoreEntered).toBe(false);
    releaseGc.resolve();
    await maintenance;
    expect(await restore).toEqual({ status: "restored" });
    expect(restoreEntered).toBe(true);
  });

  it("removes only an explicitly requested empty and inactive private store", async () => {
    const refusalRoot = await temporaryDirectory();
    const refusal = await createStore(refusalRoot, { testHooks: { now: () => 1_000 } });
    await writeFile(path.join(refusal.workspace, "file.txt"), "content\n");
    const retained = await captured(refusal.store);
    expect(
      await refusal.store.runMaintenance({
        loadExpectedRootTreeOids: () => [retained.rootTreeOid],
        orphanGracePeriodMs: 0,
        removeStoreIfUnused: { canRemoveStore: () => true },
      }),
    ).toMatchObject({
      status: "maintained",
      storeDisposition: "retained",
      removalRefusalReason: "expected-snapshots",
    });
    expect((await lstat(refusal.store.storeDirectory)).isDirectory()).toBe(true);

    expect(
      await refusal.store.runMaintenance({
        loadExpectedRootTreeOids: () => [],
        orphanGracePeriodMs: 10_000,
        removeStoreIfUnused: { canRemoveStore: () => true },
      }),
    ).toMatchObject({
      storeDisposition: "retained",
      removalRefusalReason: "snapshot-refs",
    });

    await git(refusal.store.storeDirectory, ["update-ref", "-d", retained.gitRef]);
    const planPath = path.join(refusal.store.storeDirectory, "restore-plans", "active.json");
    await writeFile(planPath, "{}\n");
    expect(
      await refusal.store.runMaintenance({
        loadExpectedRootTreeOids: () => [],
        orphanGracePeriodMs: 0,
        removeStoreIfUnused: { canRemoveStore: () => true },
      }),
    ).toMatchObject({
      storeDisposition: "retained",
      removalRefusalReason: "restore-plans",
    });
    await rm(planPath);

    const artifactDirectory = path.join(refusal.store.storeDirectory, "temp", "live-staging");
    await mkdir(artifactDirectory, { recursive: true });
    const artifactPath = path.join(artifactDirectory, "active.json");
    await writeFile(artifactPath, "{}\n");
    expect(
      await refusal.store.runMaintenance({
        loadExpectedRootTreeOids: () => [],
        orphanGracePeriodMs: 0,
        removeStoreIfUnused: { canRemoveStore: () => true },
      }),
    ).toMatchObject({
      storeDisposition: "retained",
      removalRefusalReason: "artifact-manifests",
    });
    await rm(artifactPath);

    let guardCalled = false;
    expect(
      await refusal.store.runMaintenance({
        loadExpectedRootTreeOids: () => [],
        orphanGracePeriodMs: 0,
        removeStoreIfUnused: {
          canRemoveStore: () => {
            guardCalled = true;
            return false;
          },
        },
      }),
    ).toMatchObject({
      storeDisposition: "retained",
      removalRefusalReason: "durable-work",
    });
    expect(guardCalled).toBe(true);

    const workspaceStoreRoot = path.dirname(refusal.store.storeDirectory);
    const siblingPath = path.join(workspaceStoreRoot, "must-survive.txt");
    await writeFile(siblingPath, "sibling\n");
    expect(
      await refusal.store.runMaintenance({
        loadExpectedRootTreeOids: () => [],
        orphanGracePeriodMs: 0,
        removeStoreIfUnused: { canRemoveStore: () => true },
      }),
    ).toMatchObject({ status: "maintained", storeDisposition: "removed" });
    expect(await lstat(refusal.store.storeDirectory).catch(() => undefined)).toBeUndefined();
    expect(await readFile(siblingPath, "utf8")).toBe("sibling\n");
  });

  it("checks free space before restore journals or live mutation and accepts the exact boundary", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "target\n");
    const target = await captured(store);
    await writeFile(path.join(workspace, "file.txt"), "source\n");
    const source = await captured(store);
    let artifactCreated = false;
    let mutationStarted = false;
    const insufficient = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        statfs: async () => ({ bavail: 13n, bsize: 1n, filesystemId: "same" }),
        afterArtifactCreateBeforeIdentity: () => {
          artifactCreated = true;
        },
        beforeMutation: () => {
          mutationStarted = true;
        },
      },
    });
    await expect(
      insufficient.restore(target.rootTreeOid, {
        status: "captured",
        rootTreeOid: source.rootTreeOid,
      }),
    ).rejects.toThrow("Restore filesystem has insufficient available space");
    expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe("source\n");
    expect(artifactCreated).toBe(false);
    expect(mutationStarted).toBe(false);

    const boundary = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        statfs: async () => ({ bavail: 14n, bsize: 1n, filesystemId: "same" }),
      },
    });
    expect(
      await boundary.restore(target.rootTreeOid, {
        status: "captured",
        rootTreeOid: source.rootTreeOid,
      }),
    ).toEqual({ status: "restored" });
    expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe("target\n");
  });

  it("checks private and destination capacity separately on different filesystems", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "target\n");
    const target = await captured(store);
    await writeFile(path.join(workspace, "file.txt"), "source\n");
    const source = await captured(store);
    const checked: string[] = [];
    const separateFilesystems = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        statfs: async (targetPath) => {
          checked.push(targetPath);
          return {
            bavail: 7n,
            bsize: 1n,
            filesystemId: targetPath === store.storeDirectory ? "private" : "destination",
          };
        },
      },
    });

    expect(
      await separateFilesystems.restore(target.rootTreeOid, {
        status: "captured",
        rootTreeOid: source.rootTreeOid,
      }),
    ).toEqual({ status: "restored" });
    expect(checked).toContain(store.storeDirectory);
    expect(checked).toContain(workspace);
  });

  it("preflights resumed restore staging capacity and reports all materialized bytes", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "target\n");
    const target = await captured(store);
    await writeFile(path.join(workspace, "file.txt"), "source\n");
    const source = await captured(store);
    const operationId = "resume-capacity";
    await store.withWorkspaceLock(async (lockedStore) => {
      const prepared = await lockedStore.prepareRestore(
        target.rootTreeOid,
        { status: "captured", rootTreeOid: source.rootTreeOid },
        operationId,
      );
      if (prepared.status !== "prepared") throw new Error("restore preparation unavailable");
      await prepared.plan.dispose();
    });

    let artifactCreated = false;
    const insufficient = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        statfs: async () => ({ bavail: 13n, bsize: 1n, filesystemId: "same" }),
        afterArtifactCreateBeforeIdentity: () => {
          artifactCreated = true;
        },
      },
    });
    await expect(
      insufficient.resumeRestore({
        operationId,
        targetRootTreeOid: target.rootTreeOid,
        sourceRootTreeOid: source.rootTreeOid,
      }),
    ).rejects.toThrow("Restore filesystem has insufficient available space");
    expect(artifactCreated).toBe(false);
    expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe("source\n");

    const restoreMetricObserved = deferred();
    let restoreMetric: Extract<WorkspaceHistoryMetric, { type: "restore" }> | undefined;
    const sufficient = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      onMetric: (metric) => {
        if (metric.type !== "restore") return;
        restoreMetric = metric;
        restoreMetricObserved.resolve();
      },
      testHooks: {
        statfs: async () => ({ bavail: 14n, bsize: 1n, filesystemId: "same" }),
      },
    });
    expect(
      await sufficient.resumeRestore({
        operationId,
        targetRootTreeOid: target.rootTreeOid,
        sourceRootTreeOid: source.rootTreeOid,
      }),
    ).toEqual({ status: "restored" });
    await restoreMetricObserved.promise;
    expect(restoreMetric).toMatchObject({ outcome: "restored", payloadBytes: 14n });
  });

  it("keeps Git capability and reconciliation distinct from a deleted workspace", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "content\n");
    const snapshot = await captured(store);
    await rm(workspace, { recursive: true });
    const reopened = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
    });

    expect(await reopened.capability()).toMatchObject({ status: "available" });
    await expect(reopened.capture()).rejects.toMatchObject({
      code: "workspace-invalid",
    });
    expect(await reopened.reconcileSnapshotRef(snapshot.rootTreeOid)).toBe("present");
  });
});
