import {
  type WorkspaceHistoryMetric,
  type WorkspaceHistoryStoreOptions,
  describe,
  expect,
  it,
  copyFile,
  mkdir,
  mkdtempFs,
  readFile,
  readdir,
  stat,
  writeFile,
  tmpdir,
  path,
  createToolResultArtifactStore,
  MockLanguageModelV4,
  simulateReadableStream,
  ModelCapability,
  Panic,
  z,
  MiniLilacSessionOperationRejected,
  SessionService,
  MiniLilacSqliteStore,
  WorkspaceHistoryStore,
  temporaryDirectories,
  mkdtemp,
  zeroUsage,
  textResult,
  textAndReadToolResult,
  delegateResult,
  bashToolResult,
  grepToolResult,
  readToolResult,
  batchedReadResult,
  userMessage,
  steeringMessage,
  seedCompletedHistory,
  seedOpenHistory,
  reserveRetainedHistoryOperation,
  ScriptedWorkspaceHistoryStore,
  MaintenanceProbeWorkspaceHistoryStore,
  capturedWorkspace,
  privateGit,
  removeLoosePrivateObject,
  config,
  delegatedRuns,
  collect,
} from "./session-runtime-test-support";

describe("SessionService", () => {
  it("explicitly invalidates an incompatible cache with a redacted diagnostic before recomputing", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-cache-policy-"));
    temporaryDirectories.push(directory);
    const diagnostics: object[] = [];
    let historyStore: WorkspaceHistoryStore | undefined;
    const model = new MockLanguageModelV4({
      doStream: async () => textResult("cache-policy-answer", "done"),
    });
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      workspaceHistoryStoreFactory: (options) => {
        historyStore = new WorkspaceHistoryStore(options);
        return historyStore;
      },
      onWorkspaceHistoryPersistenceDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    await collect(
      (await service.startPrompt(session.id, userMessage("first"), "cache-policy-first")).stream,
    );
    if (historyStore === undefined) throw new Error("workspace history store was not created");
    const cachePath = path.join(historyStore.storeDirectory, "capture-cache.json");
    const current = JSON.parse(await readFile(cachePath, "utf8"));
    const incompatible = JSON.stringify({
      ...current,
      implementationVersion: "secret-implementation-version",
    });
    await writeFile(cachePath, incompatible);

    await collect(
      (await service.startPrompt(session.id, userMessage("second"), "cache-policy-second")).stream,
    );

    expect(diagnostics).toEqual([
      {
        operation: "invalidate-capture-cache",
        recordKind: "capture-cache",
        issueCode: "unsupported-version",
        versionCategory: "implementation",
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("secret-implementation-version");
    expect(await readFile(cachePath, "utf8")).not.toBe(incompatible);
    expect(await readFile(cachePath, "utf8")).not.toContain("secret-implementation-version");
    service.close();
  });

  it("keeps transcript history without workspace snapshots outside Git", async () => {
    const directory = await mkdtempFs(path.join(tmpdir(), "mini-lilac-non-git-history-"));
    temporaryDirectories.push(directory);
    const model = new MockLanguageModelV4({
      doStream: async () => textResult("non-git-answer", "done"),
    });
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });

    await collect(
      (await service.startPrompt(session.id, userMessage("non-git prompt"), "non-git-prompt"))
        .stream,
    );
    const workspace = service.store.getWorkspaceForSession(session.id);
    expect(service.store.listWorkspaceSnapshots(workspace.id)).toEqual([]);
    expect(service.store.getCurrentHistoryState(session.id)).toMatchObject({
      workspaceStatus: "unavailable",
      workspaceUnavailableReason: "non-git-workspace",
    });
    expect(
      await service.undo({ sessionId: session.id, clientCommandId: "non-git-undo" }),
    ).toMatchObject({
      status: "undone",
      filesystem: { status: "skipped", reason: "non-git-workspace" },
    });
    expect(service.store.getUiMessages(session.id)).toEqual([]);
    service.close();
  });

  it("runs workspace maintenance after retained history recovery", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-maintenance-order-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const sqlite = new MiniLilacSqliteStore(databasePath);
    sqlite.createSession({
      id: "maintenance-order-session",
      cwd: directory,
      model: "test/mock",
      profile: "reader",
      reasoning: "high",
    });
    seedCompletedHistory(
      sqlite,
      "maintenance-order-session",
      [{ role: "user", content: "seed" }],
      [userMessage("seed")],
    );
    reserveRetainedHistoryOperation(sqlite, "maintenance-order-session", "retained-operation");

    const order: string[] = [];
    const service = new SessionService({
      config: config(),
      store: sqlite,
      workspaceHistoryDirectory: path.join(directory, "history"),
      modelResolver: () => new MockLanguageModelV4({}),
      workspaceHistoryStoreFactory: (options) =>
        new MaintenanceProbeWorkspaceHistoryStore(options, async (maintenanceOptions) => {
          order.push("maintenance");
          expect(sqlite.listHistoryOperations()).toEqual([]);
          expect(await maintenanceOptions.loadExpectedRootTreeOids()).toEqual([]);
          expect(await maintenanceOptions.removeStoreIfUnused?.canRemoveStore()).toBe(true);
          return { status: "unavailable", reason: "git-unavailable" };
        }),
    });

    await service.initialize();
    expect(order).toEqual(["maintenance"]);
    service.close();
  });

  it("suppresses per-workspace maintenance failures during initialization", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-maintenance-failure-"));
    temporaryDirectories.push(directory);
    const sqlite = new MiniLilacSqliteStore(path.join(directory, "runtime.sqlite"));
    sqlite.createSession({
      id: "existing-session",
      cwd: directory,
      model: "test/mock",
      profile: "reader",
      reasoning: "high",
    });
    let attempts = 0;
    const service = new SessionService({
      config: config(),
      store: sqlite,
      workspaceHistoryDirectory: path.join(directory, "history"),
      modelResolver: () => new MockLanguageModelV4({}),
      workspaceHistoryStoreFactory: (options) =>
        new MaintenanceProbeWorkspaceHistoryStore(options, async () => {
          attempts += 1;
          throw new Error("injected maintenance failure");
        }),
    });

    await expect(service.initialize()).resolves.toBeUndefined();
    expect(attempts).toBe(1);
    expect(service.loadSession("existing-session").id).toBe("existing-session");
    service.close();
  });

  for (const guard of ["active-operation", "pending-finalization"] as const) {
    it(`uses SQLite ${guard} accounting to prevent store removal`, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), `mini-lilac-maintenance-${guard}-`));
      temporaryDirectories.push(directory);
      const sqlite = new MiniLilacSqliteStore(path.join(directory, "runtime.sqlite"));
      const sessionId = `${guard}-session`;
      sqlite.createSession({
        id: sessionId,
        cwd: directory,
        model: "test/mock",
        profile: "reader",
        reasoning: "high",
      });
      if (guard === "active-operation") {
        seedCompletedHistory(
          sqlite,
          sessionId,
          [{ role: "user", content: "seed" }],
          [userMessage("seed")],
        );
      }
      let canRemove: boolean | undefined;
      const service = new SessionService({
        config: config(),
        store: sqlite,
        workspaceHistoryDirectory: path.join(directory, "history"),
        modelResolver: () => new MockLanguageModelV4({}),
        workspaceHistoryStoreFactory: (options) =>
          new MaintenanceProbeWorkspaceHistoryStore(options, async (maintenanceOptions) => {
            if (guard === "active-operation") {
              reserveRetainedHistoryOperation(sqlite, sessionId, "maintenance-active-operation");
            } else {
              const runId = "maintenance-pending-run";
              const transitionId = seedOpenHistory(
                sqlite,
                sessionId,
                runId,
                userMessage("pending during maintenance"),
              );
              sqlite.reservePendingRunFinalization({
                runId,
                sessionId,
                openTransitionId: transitionId,
                modelMessages: sqlite.getModelMessages(sessionId),
                uiMessages: sqlite.getUiMessages(sessionId),
                runStatus: "error",
                sessionStatus: "error",
                error: "test pending finalization",
                terminalResult: undefined,
                inputTokens: null,
              });
            }
            canRemove = await maintenanceOptions.removeStoreIfUnused?.canRemoveStore();
            return { status: "unavailable", reason: "git-unavailable" };
          }),
      });

      await service.initialize();
      expect(canRemove).toBe(false);
      service.close();
    });
  }

  it("removes a truly empty store without deleting a sibling", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-empty-store-removal-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    const databasePath = path.join(directory, "runtime.sqlite");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "managed.txt"), "unreferenced");
    let now = 0;
    let historyStore: WorkspaceHistoryStore | undefined;
    const initial = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({}),
      workspaceHistoryStoreFactory: (options) =>
        (historyStore = new WorkspaceHistoryStore({
          ...options,
          onMetric: undefined,
          testHooks: { now: () => now },
        })),
    });
    await initial.createSession({
      id: "empty-store-session",
      cwd: workspace,
      model: "test/mock",
    });
    if (historyStore === undefined) throw new Error("workspace history store was not created");
    expect((await historyStore.capture()).status).toBe("captured");
    now = 1;
    const cleanup = await historyStore.runMaintenance({
      loadExpectedRootTreeOids: () => [],
      orphanGracePeriodMs: 0,
    });
    expect(cleanup).toMatchObject({
      status: "maintained",
      removedOrphanRefs: [expect.any(String)],
    });
    const storeDirectory = historyStore.storeDirectory;
    const sibling = path.join(historyStore.historyRoot, "unrelated-sibling");
    await mkdir(sibling, { recursive: true });
    await writeFile(path.join(sibling, "sentinel"), "keep");
    initial.close();

    const reopened = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({}),
    });
    await reopened.initialize();
    await expect(stat(storeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await Bun.file(path.join(sibling, "sentinel")).text()).toBe("keep");
    reopened.close();
  });

  it("removes only old orphan refs during production startup maintenance", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-startup-orphans-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    const databasePath = path.join(directory, "runtime.sqlite");
    const managed = path.join(workspace, "managed.txt");
    await mkdir(workspace);
    await writeFile(managed, "expected");
    let now = 0;
    let historyStore: WorkspaceHistoryStore | undefined;
    const factory = (options: WorkspaceHistoryStoreOptions): WorkspaceHistoryStore =>
      (historyStore = new WorkspaceHistoryStore({
        ...options,
        onMetric: undefined,
        testHooks: { now: () => now },
      }));
    const initial = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () =>
        new MockLanguageModelV4({ doStream: textResult("expected-answer", "response") }),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: factory,
    });
    const session = await initial.createSession({ cwd: workspace, model: "test/mock" });
    await collect((await initial.startPrompt(session.id, userMessage("capture expected"))).stream);
    if (historyStore === undefined) throw new Error("workspace history store was not created");
    const expected = initial.store
      .listWorkspaceSnapshots(initial.store.getWorkspaceForSession(session.id).id)
      .at(0);
    if (expected === undefined) throw new Error("expected snapshot was not stored");

    await writeFile(managed, "old orphan");
    const oldOrphan = await historyStore.capture();
    if (oldOrphan.status !== "captured") throw new Error("old orphan capture was skipped");
    now = 25 * 60 * 60 * 1_000;
    await writeFile(managed, "young orphan");
    const youngOrphan = await historyStore.capture();
    if (youngOrphan.status !== "captured") throw new Error("young orphan capture was skipped");
    initial.close();

    const reopened = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({}),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: factory,
    });
    await reopened.initialize();
    if (historyStore === undefined) throw new Error("reopened history store was not created");
    await expect(
      privateGit(historyStore, ["rev-parse", "--verify", oldOrphan.gitRef]),
    ).rejects.toThrow();
    expect(await privateGit(historyStore, ["rev-parse", "--verify", youngOrphan.gitRef])).toBe(
      youngOrphan.rootTreeOid,
    );
    expect(await privateGit(historyStore, ["rev-parse", "--verify", expected.gitRef])).toBe(
      expected.rootTreeOid,
    );
    expect(reopened.getHistoryRecoveryStatus().workspaceSnapshots).toMatchObject([
      { status: "reconciled", orphanRefs: [youngOrphan.gitRef] },
    ]);
    reopened.close();
  });

  it("clears a reconciled orphan promoted to expected during pending recovery", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-recovered-orphan-status-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    const databasePath = path.join(directory, "runtime.sqlite");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "managed.txt"), "pending recovery snapshot");
    let historyStore: WorkspaceHistoryStore | undefined;
    const initial = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({}),
      workspaceHistoryStoreFactory: (options) =>
        (historyStore = new WorkspaceHistoryStore({ ...options, onMetric: undefined })),
    });
    const session = await initial.createSession({
      id: "recovered-orphan-session",
      cwd: workspace,
      model: "test/mock",
    });
    if (historyStore === undefined) throw new Error("workspace history store was not created");
    const orphan = await historyStore.capture();
    if (orphan.status !== "captured") throw new Error("orphan capture was skipped");
    expect(await historyStore.reconcileExpectedSnapshotRefs([])).toMatchObject({
      status: "reconciled",
      orphanRefs: [orphan.gitRef],
    });

    const runId = "recovered-orphan-run";
    const transitionId = seedOpenHistory(
      initial.store,
      session.id,
      runId,
      userMessage("recover this pending run"),
    );
    initial.store.reservePendingRunFinalization({
      runId,
      sessionId: session.id,
      openTransitionId: transitionId,
      modelMessages: initial.store.getModelMessages(session.id),
      uiMessages: initial.store.getUiMessages(session.id),
      runStatus: "completed",
      sessionStatus: "idle",
      error: null,
      terminalResult: { text: "recovered" },
      inputTokens: 1,
    });
    expect(
      initial.store.listWorkspaceSnapshots(initial.store.getWorkspaceForSession(session.id).id),
    ).toEqual([]);
    initial.close();

    const reopened = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({}),
      attachCompaction: async () => () => {},
    });
    await reopened.initialize();
    expect(
      reopened.store.listWorkspaceSnapshots(reopened.store.getWorkspaceForSession(session.id).id),
    ).toMatchObject([{ rootTreeOid: orphan.rootTreeOid }]);
    expect(reopened.getHistoryRecoveryStatus().workspaceSnapshots).toMatchObject([
      { status: "reconciled", orphanRefs: [] },
    ]);
    reopened.close();
  });

  it("forwards aggregate capture, restore, and maintenance metrics through the factory seam", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-session-metrics-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    const databasePath = path.join(directory, "runtime.sqlite");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "managed.txt"), "expected");
    const metrics: WorkspaceHistoryMetric[] = [];
    const metricTypes = new Set<WorkspaceHistoryMetric["type"]>();
    const accountingReads: Array<{ metricType: string; snapshotCount: number }> = [];
    let activeMetricType: string | undefined;
    const metricWaiters = new Map(
      (["capture", "restore", "maintenance"] as const).map((type) => [
        type,
        Promise.withResolvers<void>(),
      ]),
    );
    const factory = (options: WorkspaceHistoryStoreOptions): WorkspaceHistoryStore => {
      expect(options.onMetric).toBeFunction();
      const onMetric = options.onMetric;
      return new WorkspaceHistoryStore({
        ...options,
        onMetric: async (metric) => {
          activeMetricType = metric.type;
          metrics.push(metric);
          metricTypes.add(metric.type);
          try {
            await onMetric?.(metric);
          } finally {
            activeMetricType = undefined;
          }
          metricWaiters.get(metric.type as "capture" | "restore" | "maintenance")?.resolve();
        },
      });
    };
    const initial = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({ doStream: textResult("answer", "response") }),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: factory,
    });
    const originalAccounting = initial.store.getHistoryAccounting.bind(initial.store);
    initial.store.getHistoryAccounting = (workspaceId) => {
      const accounting = originalAccounting(workspaceId);
      if (activeMetricType !== undefined) {
        accountingReads.push({
          metricType: activeMetricType,
          snapshotCount: accounting.snapshotCount,
        });
      }
      return accounting;
    };
    const session = await initial.createSession({ cwd: workspace, model: "test/mock" });
    await collect((await initial.startPrompt(session.id, userMessage("metric capture"))).stream);
    await metricWaiters.get("capture")?.promise;
    await writeFile(path.join(workspace, "managed.txt"), "restore source");
    await initial.undo({ sessionId: session.id, clientCommandId: "metric-undo" });
    await metricWaiters.get("restore")?.promise;
    initial.close();

    const reopened = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({}),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: factory,
    });
    const reopenedAccounting = reopened.store.getHistoryAccounting.bind(reopened.store);
    reopened.store.getHistoryAccounting = (workspaceId) => {
      const accounting = reopenedAccounting(workspaceId);
      if (activeMetricType !== undefined) {
        accountingReads.push({
          metricType: activeMetricType,
          snapshotCount: accounting.snapshotCount,
        });
      }
      return accounting;
    };
    await reopened.initialize();
    await metricWaiters.get("maintenance")?.promise;

    expect([...metricTypes]).toEqual(expect.arrayContaining(["capture", "restore", "maintenance"]));
    expect(accountingReads).toEqual(
      expect.arrayContaining([
        { metricType: "capture", snapshotCount: expect.any(Number) },
        { metricType: "restore", snapshotCount: expect.any(Number) },
        { metricType: "maintenance", snapshotCount: expect.any(Number) },
      ]),
    );
    const serializedMetrics = JSON.stringify(metrics, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(serializedMetrics).not.toContain(directory);
    expect(serializedMetrics).not.toContain("managed.txt");
    expect(serializedMetrics).not.toContain("expected");
    reopened.close();
  });

  it("isolates copied databases under a shared workspace history root", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-database-namespace-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    const sharedHistoryRoot = path.join(directory, "shared-history");
    const firstDatabase = path.join(directory, "first.sqlite");
    const copiedDatabase = path.join(directory, "copied.sqlite");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "tracked.txt"), "first");
    const stores: WorkspaceHistoryStore[] = [];
    const factory = (options: WorkspaceHistoryStoreOptions): WorkspaceHistoryStore => {
      const store = new WorkspaceHistoryStore(options);
      stores.push(store);
      return store;
    };
    const model = new MockLanguageModelV4({ doStream: textResult("answer", "done") });
    const first = new SessionService({
      config: config(),
      databasePath: firstDatabase,
      workspaceHistoryDirectory: sharedHistoryRoot,
      workspaceHistoryStoreFactory: factory,
      modelResolver: () => model,
    });
    const session = await first.createSession({
      id: "copied-session",
      cwd: workspace,
      model: "test/mock",
    });
    await collect((await first.startPrompt(session.id, userMessage("first prompt"))).stream);
    const oldSnapshot = z
      .object({ root_tree_oid: z.string() })
      .parse(
        first.store.database
          .query("SELECT root_tree_oid FROM workspace_snapshots ORDER BY rowid DESC LIMIT 1")
          .get(),
      );
    const firstStore = stores[0];
    if (firstStore === undefined) throw new Error("First workspace history store was not created");
    first.store.database.run("PRAGMA wal_checkpoint(TRUNCATE)");
    first.close();
    await copyFile(firstDatabase, copiedDatabase);

    const copied = new SessionService({
      config: config(),
      databasePath: copiedDatabase,
      workspaceHistoryDirectory: sharedHistoryRoot,
      workspaceHistoryStoreFactory: factory,
      modelResolver: () => model,
    });
    await copied.initialize();
    copied.loadSession(session.id);
    const copiedStore = stores[1];
    if (copiedStore === undefined)
      throw new Error("Copied workspace history store was not created");
    expect(firstStore.historyRoot).not.toBe(copiedStore.historyRoot);
    expect(path.dirname(firstStore.historyRoot)).toBe(sharedHistoryRoot);
    expect(path.dirname(copiedStore.historyRoot)).toBe(sharedHistoryRoot);
    expect(path.basename(firstStore.historyRoot)).toStartWith("database-");
    expect(path.basename(copiedStore.historyRoot)).toStartWith("database-");
    expect(await copiedStore.reconcileSnapshotRef(oldSnapshot.root_tree_oid)).toBe("missing");
    expect(
      copied.store
        .listWorkspaceSnapshots(copied.store.getWorkspaceForSession(session.id).id)
        .find((snapshot) => snapshot.rootTreeOid === oldSnapshot.root_tree_oid),
    ).toMatchObject({
      availability: "missing",
      availabilityDetail: expect.stringContaining("authoritative startup reconciliation"),
    });

    await writeFile(path.join(workspace, "tracked.txt"), "second");
    await collect((await copied.startPrompt(session.id, userMessage("copied prompt"))).stream);
    const newSnapshot = z
      .object({ root_tree_oid: z.string() })
      .parse(
        copied.store.database
          .query("SELECT root_tree_oid FROM workspace_snapshots ORDER BY rowid DESC LIMIT 1")
          .get(),
      );
    expect(newSnapshot.root_tree_oid).not.toBe(oldSnapshot.root_tree_oid);
    expect(await copiedStore.objectExists(newSnapshot.root_tree_oid, "tree")).toBe(true);
    expect(await copiedStore.reconcileSnapshotRef(oldSnapshot.root_tree_oid)).toBe("missing");
    expect(
      copied.store
        .listWorkspaceSnapshots(copied.store.getWorkspaceForSession(session.id).id)
        .find((snapshot) => snapshot.rootTreeOid === oldSnapshot.root_tree_oid)?.availability,
    ).toBe("missing");
    copied.close();
  });

  it("repairs missing snapshot refs at startup without mutating the managed workspace", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-reconcile-ref-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    const databasePath = path.join(directory, "runtime.sqlite");
    await mkdir(workspace);
    const managed = path.join(workspace, "managed.txt");
    await writeFile(managed, "managed-content");
    let initialHistoryStore: WorkspaceHistoryStore | undefined;
    const initial = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({ doStream: textResult("answer", "response") }),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: (options) =>
        (initialHistoryStore = new WorkspaceHistoryStore(options)),
    });
    const session = await initial.createSession({ cwd: workspace, model: "test/mock" });
    await collect(
      (await initial.startPrompt(session.id, userMessage("capture"), "prompt-command")).stream,
    );
    if (initialHistoryStore === undefined) throw new Error("history store was not created");
    const snapshot = initial.store
      .listWorkspaceSnapshots(initial.store.getWorkspaceForSession(session.id).id)
      .at(0);
    if (snapshot === undefined) throw new Error("snapshot was not stored");
    const orphanRef = "refs/mini-lilac/snapshots/orphan-maintenance-test";
    await privateGit(initialHistoryStore, ["update-ref", "-d", snapshot.gitRef]);
    await privateGit(initialHistoryStore, ["update-ref", orphanRef, snapshot.rootTreeOid]);
    initial.close();
    const entriesBefore = (await readdir(workspace)).sort();
    const contentBefore = await Bun.file(managed).text();

    let reopenedHistoryStore: WorkspaceHistoryStore | undefined;
    const reopened = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({}),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: (options) =>
        (reopenedHistoryStore = new WorkspaceHistoryStore(options)),
    });
    await reopened.initialize();
    if (reopenedHistoryStore === undefined)
      throw new Error("reopened history store was not created");
    expect(await reopenedHistoryStore.reconcileSnapshotRef(snapshot.rootTreeOid)).toBe("present");
    expect(reopened.store.getWorkspaceSnapshot(snapshot.id)).toMatchObject({
      availability: "available",
      availabilityDetail: null,
    });
    expect(reopened.getHistoryRecoveryStatus().workspaceSnapshots).toMatchObject([
      { status: "reconciled", orphanRefs: [orphanRef] },
    ]);
    expect(await privateGit(reopenedHistoryStore, ["rev-parse", "--verify", orphanRef])).toBe(
      snapshot.rootTreeOid,
    );
    expect((await readdir(workspace)).sort()).toEqual(entriesBefore);
    expect(await Bun.file(managed).text()).toBe(contentBefore);
    reopened.close();
  });

  it("marks only missing snapshot objects and skips navigation to the affected state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-reconcile-missing-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    const databasePath = path.join(directory, "runtime.sqlite");
    await mkdir(workspace);
    const managed = path.join(workspace, "managed.txt");
    await writeFile(managed, "first-state");
    let historyStore: WorkspaceHistoryStore | undefined;
    const initial = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () =>
        new MockLanguageModelV4({
          doStream: [
            textResult("first-answer", "first response"),
            textResult("second-answer", "second response"),
          ],
        }),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: (options) =>
        (historyStore = new WorkspaceHistoryStore(options)),
    });
    const session = await initial.createSession({ cwd: workspace, model: "test/mock" });
    const firstUser = userMessage("first prompt");
    await collect((await initial.startPrompt(session.id, firstUser, "first-prompt")).stream);
    await writeFile(managed, "second-state");
    const secondUser = userMessage("second prompt");
    await collect((await initial.startPrompt(session.id, secondUser, "second-prompt")).stream);
    if (historyStore === undefined) throw new Error("history store was not created");
    const workspaceId = initial.store.getWorkspaceForSession(session.id).id;
    const firstState = initial.store.listHistoryTopology(session.id).states.find((state) => {
      const ui = initial.store.getHistoryStateUiMessages(state.id);
      return ui.length === 0 && state.workspaceSnapshotId !== null;
    });
    const affectedSnapshot =
      firstState?.workspaceSnapshotId === null || firstState?.workspaceSnapshotId === undefined
        ? undefined
        : initial.store.getWorkspaceSnapshot(firstState.workspaceSnapshotId);
    if (affectedSnapshot === undefined || affectedSnapshot === null) {
      throw new Error("first-state snapshot was not found");
    }
    await removeLoosePrivateObject(historyStore, affectedSnapshot.rootTreeOid);
    initial.close();

    const reopened = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({}),
      attachCompaction: async () => () => {},
    });
    await reopened.initialize();
    const reconciled = reopened.store.listWorkspaceSnapshots(workspaceId);
    expect(reconciled.find((snapshot) => snapshot.id === affectedSnapshot.id)).toMatchObject({
      availability: "missing",
      availabilityDetail: expect.stringContaining(affectedSnapshot.rootTreeOid),
    });
    expect(
      reconciled.filter(
        (snapshot) => snapshot.id !== affectedSnapshot.id && snapshot.availability === "available",
      ).length,
    ).toBeGreaterThan(0);

    expect(
      await reopened.undo({ sessionId: session.id, clientCommandId: "undo-second" }),
    ).toMatchObject({
      status: "undone",
      message: secondUser,
      filesystem: { status: "restored" },
    });
    expect(
      await reopened.undo({ sessionId: session.id, clientCommandId: "undo-first" }),
    ).toMatchObject({
      status: "undone",
      message: firstUser,
      filesystem: { status: "skipped", reason: "snapshot-unavailable" },
    });
    reopened.close();
  });

  it("heals a missing snapshot row when a later capture roots the same OID", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-reconcile-heal-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    const databasePath = path.join(directory, "runtime.sqlite");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "managed.txt"), "stable-state");
    let historyStore: WorkspaceHistoryStore | undefined;
    const initial = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () =>
        new MockLanguageModelV4({ doStream: textResult("first-answer", "first response") }),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: (options) =>
        (historyStore = new WorkspaceHistoryStore(options)),
    });
    const session = await initial.createSession({ cwd: workspace, model: "test/mock" });
    await collect(
      (await initial.startPrompt(session.id, userMessage("first"), "first-prompt")).stream,
    );
    if (historyStore === undefined) throw new Error("history store was not created");
    const workspaceId = initial.store.getWorkspaceForSession(session.id).id;
    const snapshot = initial.store.listWorkspaceSnapshots(workspaceId).at(0);
    if (snapshot === undefined) throw new Error("snapshot was not stored");
    await removeLoosePrivateObject(historyStore, snapshot.rootTreeOid);
    initial.close();

    const reopened = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () =>
        new MockLanguageModelV4({ doStream: textResult("second-answer", "second response") }),
      attachCompaction: async () => () => {},
    });
    await reopened.initialize();
    expect(reopened.store.getWorkspaceSnapshot(snapshot.id)).toMatchObject({
      availability: "missing",
      availabilityDetail: expect.stringContaining(snapshot.rootTreeOid),
    });
    await collect(
      (await reopened.startPrompt(session.id, userMessage("recapture"), "recapture-prompt")).stream,
    );
    expect(reopened.store.getWorkspaceSnapshot(snapshot.id)).toMatchObject({
      availability: "available",
      availabilityDetail: null,
    });
    reopened.close();
  });

  it("leaves snapshot availability unchanged when startup Git is unavailable", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-reconcile-git-missing-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    const databasePath = path.join(directory, "runtime.sqlite");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "managed.txt"), "state");
    const initial = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({ doStream: textResult("answer", "response") }),
      attachCompaction: async () => () => {},
    });
    const session = await initial.createSession({ cwd: workspace, model: "test/mock" });
    await collect(
      (await initial.startPrompt(session.id, userMessage("capture"), "prompt-command")).stream,
    );
    const workspaceId = initial.store.getWorkspaceForSession(session.id).id;
    const snapshot = initial.store.listWorkspaceSnapshots(workspaceId).at(0);
    if (snapshot === undefined) throw new Error("snapshot was not stored");
    initial.store.setWorkspaceSnapshotAvailability({
      workspaceId,
      updates: [
        {
          snapshotId: snapshot.id,
          availability: "corrupt",
          detail: "preexisting unavailable detail",
        },
      ],
    });
    initial.close();

    const reopened = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({}),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: (options) =>
        new WorkspaceHistoryStore({
          ...options,
          gitExecutable: path.join(directory, "missing-git"),
          platform: "linux",
        }),
    });
    await reopened.initialize();
    expect(reopened.store.getWorkspaceSnapshot(snapshot.id)).toMatchObject({
      availability: "corrupt",
      availabilityDetail: "preexisting unavailable detail",
    });
    expect(reopened.getHistoryRecoveryStatus().workspaceSnapshots).toMatchObject([
      { workspaceId, status: "unavailable", reason: "git-unavailable", orphanRefs: [] },
    ]);
    reopened.close();
  });

  it("does not invoke prompt capture behind another session's retained operation", async () => {
    let captureCalls = 0;
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-operation-capture-guard-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => new MockLanguageModelV4({ doStream: textResult("unused", "unused") }),
      workspaceHistoryStoreFactory: (options) =>
        new ScriptedWorkspaceHistoryStore(options, async (call, workspaceId) => {
          captureCalls += 1;
          return capturedWorkspace(call, workspaceId);
        }),
    });
    const owner = await service.createSession({
      id: "journal-owner",
      cwd: directory,
      model: "test/mock",
    });
    const blocked = await service.createSession({
      id: "journal-blocked",
      cwd: directory,
      model: "test/mock",
    });
    seedCompletedHistory(
      service.store,
      owner.id,
      [{ role: "user", content: "seed operation" }],
      [userMessage("seed operation")],
    );
    reserveRetainedHistoryOperation(service.store, owner.id, "retained-operation");

    await expect(
      service.startPrompt(blocked.id, userMessage("must not capture"), "blocked-prompt"),
    ).rejects.toThrow("retained history operation");
    expect(captureCalls).toBe(0);
    service.close();
  });

  it("does not invoke prompt capture behind another session's pending finalization", async () => {
    let captureCalls = 0;
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-finalization-capture-guard-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => new MockLanguageModelV4({ doStream: textResult("unused", "unused") }),
      workspaceHistoryStoreFactory: (options) =>
        new ScriptedWorkspaceHistoryStore(options, async (call, workspaceId) => {
          captureCalls += 1;
          return capturedWorkspace(call, workspaceId);
        }),
    });
    const owner = await service.createSession({
      id: "finalization-owner",
      cwd: directory,
      model: "test/mock",
    });
    const blocked = await service.createSession({
      id: "finalization-blocked",
      cwd: directory,
      model: "test/mock",
    });
    const transitionId = seedOpenHistory(
      service.store,
      owner.id,
      "pending-owner-run",
      userMessage("pending owner"),
    );
    service.store.reservePendingRunFinalization({
      runId: "pending-owner-run",
      sessionId: owner.id,
      openTransitionId: transitionId,
      modelMessages: service.store.getModelMessages(owner.id),
      uiMessages: service.store.getUiMessages(owner.id),
      runStatus: "completed",
      sessionStatus: "idle",
      error: null,
      terminalResult: undefined,
      inputTokens: null,
    });

    await expect(
      service.startPrompt(blocked.id, userMessage("must not capture"), "blocked-prompt"),
    ).rejects.toThrow("pending run finalization");
    expect(captureCalls).toBe(0);
    service.close();
  });

  it("does not invoke terminal capture behind another session's retained operation", async () => {
    const providerEntered = Promise.withResolvers<void>();
    const releaseProvider = Promise.withResolvers<void>();
    let captureCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        providerEntered.resolve();
        await releaseProvider.promise;
        return textResult("answer", "done");
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-terminal-journal-guard-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      workspaceHistoryStoreFactory: (options) =>
        new ScriptedWorkspaceHistoryStore(options, async (call, workspaceId) => {
          captureCalls += 1;
          return capturedWorkspace(call, workspaceId);
        }),
    });
    const blocker = await service.createSession({
      id: "terminal-blocker",
      cwd: directory,
      model: "test/mock",
    });
    const activeSession = await service.createSession({
      id: "terminal-active",
      cwd: directory,
      model: "test/mock",
    });
    seedCompletedHistory(
      service.store,
      blocker.id,
      [{ role: "user", content: "seed operation" }],
      [userMessage("seed operation")],
    );
    const started = await service.startPrompt(activeSession.id, userMessage("finish later"));
    const completion = collect(started.stream);
    await providerEntered.promise;
    expect(captureCalls).toBe(1);
    reserveRetainedHistoryOperation(service.store, blocker.id, "terminal-blocking-operation");

    releaseProvider.resolve();
    await completion;
    expect(captureCalls).toBe(1);
    expect(service.store.getPendingRunFinalization(started.runId)).toBeNull();
    expect(service.store.getRun(started.runId).status).toBe("active");
    service.close();
  });

  it("recovers cancelled and error pending finalizations with their terminal facts", async () => {
    const cases = [
      {
        name: "cancelled",
        runStatus: "cancelled" as const,
        sessionStatus: "idle" as const,
        error: null,
        terminalResult: { text: "cancelled partial output", reason: "cancelled" },
      },
      {
        name: "error",
        runStatus: "error" as const,
        sessionStatus: "error" as const,
        error: "provider failed after output",
        terminalResult: { text: "error partial output", reason: "error" },
      },
    ];

    for (const testCase of cases) {
      const directory = await mkdtemp(
        path.join(tmpdir(), `mini-lilac-pending-${testCase.name}-recovery-`),
      );
      temporaryDirectories.push(directory);
      const workspace = path.join(directory, "workspace");
      const databasePath = path.join(directory, "runtime.sqlite");
      await mkdir(workspace);
      const initial = new MiniLilacSqliteStore(databasePath);
      const sessionId = `${testCase.name}-session`;
      const runId = `${testCase.name}-run`;
      initial.createSession({
        id: sessionId,
        cwd: workspace,
        model: "test/mock",
        profile: "reader",
        reasoning: "high",
      });
      const transitionId = seedOpenHistory(
        initial,
        sessionId,
        runId,
        userMessage(`${testCase.name} pending`),
      );
      initial.reservePendingRunFinalization({
        runId,
        sessionId,
        openTransitionId: transitionId,
        modelMessages: initial.getModelMessages(sessionId),
        uiMessages: initial.getUiMessages(sessionId),
        runStatus: testCase.runStatus,
        sessionStatus: testCase.sessionStatus,
        error: testCase.error,
        terminalResult: testCase.terminalResult,
        inputTokens: 7,
      });
      initial.close();

      const recovered = new SessionService({
        config: config(),
        databasePath,
        modelResolver: () => new MockLanguageModelV4({}),
        attachCompaction: async () => () => {},
      });
      await recovered.initialize();
      expect(recovered.getHistoryRecoveryStatus().pendingFinalizations).toEqual([]);
      expect(recovered.store.getRun(runId)).toMatchObject({
        status: testCase.runStatus,
        error: testCase.error,
        terminalResult: testCase.terminalResult,
      });
      expect(recovered.getSnapshot(sessionId)).toMatchObject({
        status: testCase.sessionStatus,
        activeRunId: null,
        inputTokens: 7,
      });
      recovered.close();
    }
  });

  it("recovers a retained transcript-only navigation before initialization completes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-retained-operation-init-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const initial = new MiniLilacSqliteStore(databasePath);
    initial.createSession({
      id: "retained-session",
      cwd: directory,
      model: "test/mock",
      profile: "reader",
      reasoning: "high",
    });
    seedCompletedHistory(
      initial,
      "retained-session",
      [{ role: "user", content: "seed operation" }],
      [userMessage("seed operation")],
    );
    reserveRetainedHistoryOperation(initial, "retained-session", "blocked-initialization");
    initial.close();
    let captureCalls = 0;
    const service = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({}),
      workspaceHistoryStoreFactory: (options) =>
        new ScriptedWorkspaceHistoryStore(options, async (call, capturedWorkspaceId) => {
          captureCalls += 1;
          return capturedWorkspace(call, capturedWorkspaceId);
        }),
    });

    expect(() => service.close()).toThrow("runtime work is active");
    await expect(service.initialize()).resolves.toBeUndefined();
    expect(captureCalls).toBe(0);
    expect(service.getHistoryRecoveryStatus().navigation).toEqual([]);
    expect(service.getSnapshot("retained-session")).toMatchObject({
      canUndo: false,
      canRedo: true,
    });
    service.close();
  });

  it("waits for root workspace capture and admission commit before starting the provider", async () => {
    const captureEntered = Promise.withResolvers<void>();
    const releaseCapture = Promise.withResolvers<void>();
    const providerEntered = Promise.withResolvers<void>();
    const releaseProvider = Promise.withResolvers<void>();
    const model = new MockLanguageModelV4({
      doStream: async () => {
        providerEntered.resolve();
        await releaseProvider.promise;
        return textResult("answer", "done");
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-capture-order-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      workspaceHistoryStoreFactory: (options) =>
        new ScriptedWorkspaceHistoryStore(options, async (call, workspaceId) => {
          if (call === 1) {
            captureEntered.resolve();
            await releaseCapture.promise;
          }
          return capturedWorkspace(call, workspaceId);
        }),
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    expect(session).toMatchObject({ canUndo: false, canRedo: false });
    const prompt = service.startPrompt(session.id, userMessage("capture first"), "capture-prompt");

    await captureEntered.promise;
    expect(model.doStreamCalls).toHaveLength(0);
    expect(service.store.getCurrentHistoryState(session.id).workspaceStatus).toBe(
      "capture-deferred",
    );

    releaseCapture.resolve();
    const started = await prompt;
    await providerEntered.promise;
    expect(
      service.store
        .listHistoryTopology(session.id)
        .transitions.some(
          (transition) => transition.rootRunId === started.runId && transition.toStateId === null,
        ),
    ).toBe(true);
    releaseProvider.resolve();
    await collect(started.stream);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(service.getSnapshot(session.id)).toMatchObject({
      historyStateId: expect.any(String),
      canUndo: true,
      canRedo: false,
    });
    service.close();
  });

  it("releases an untouched prompt command when workspace capture fails operationally", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("unused", "unused") });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-prompt-capture-failure-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      workspaceHistoryStoreFactory: (options) =>
        new ScriptedWorkspaceHistoryStore(options, async () => {
          throw new Error("prompt capture failed");
        }),
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });

    await expect(
      service.startPrompt(session.id, userMessage("must not start"), "failed-prompt"),
    ).rejects.toThrow("prompt capture failed");
    expect(model.doStreamCalls).toHaveLength(0);
    expect(
      service.store.database
        .query("SELECT 1 FROM commands WHERE session_id = ? AND command_id = ?")
        .get(session.id, "failed-prompt"),
    ).toBeNull();
    expect(service.getSnapshot(session.id)).toMatchObject({ status: "idle", canUndo: false });
    service.close();
  });

  it("records terminal capture failure without losing completed run state", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("answer", "done") });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-terminal-capture-failure-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      workspaceHistoryStoreFactory: (options) =>
        new ScriptedWorkspaceHistoryStore(options, async (call, workspaceId) => {
          if (call === 2) throw new Error("terminal capture failed");
          return capturedWorkspace(call, workspaceId);
        }),
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    const started = await service.startPrompt(session.id, userMessage("finish despite capture"));
    await collect(started.stream);

    expect(service.store.getRun(started.runId).status).toBe("completed");
    expect(service.getSnapshot(session.id)).toMatchObject({ status: "idle", canUndo: true });
    expect(service.store.getCurrentHistoryState(session.id)).toMatchObject({
      workspaceStatus: "unavailable",
      workspaceUnavailableReason: "capture-failed",
    });
    expect(service.store.getPendingRunFinalization(started.runId)).toBeNull();
    service.close();
  });

  it("keeps a failed steering capture queued while the run continues", async () => {
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    let modelCall = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelCall += 1;
        if (modelCall === 1) {
          firstEntered.resolve();
          await releaseFirst.promise;
          return textAndReadToolResult("before-failure", "before failure", "visible.txt");
        }
        if (modelCall === 2) {
          secondEntered.resolve();
          await releaseSecond.promise;
          return textResult("continued", "continued without steer");
        }
        return textResult("steered", "delivered after retry");
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-steering-capture-failure-"));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, "visible.txt"), "visible");
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      workspaceHistoryStoreFactory: (options) =>
        new ScriptedWorkspaceHistoryStore(options, async (call, workspaceId) => {
          if (call === 2) throw new Error("steering capture failed");
          return capturedWorkspace(call, workspaceId);
        }),
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    const started = await service.startPrompt(session.id, userMessage("start"));
    const completion = collect(started.stream);
    await firstEntered.promise;
    await service.steer({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "capture-failed-steer",
      message: steeringMessage("retry me"),
    });
    releaseFirst.resolve();

    await secondEntered.promise;
    expect(service.getSnapshot(session.id)).toMatchObject({
      status: "streaming",
      queuedSteeringCount: 1,
    });
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).not.toContain("retry me");
    expect(
      service.store
        .listHistoryTopology(session.id)
        .transitions.filter((transition) => transition.kind === "user-message"),
    ).toHaveLength(1);

    releaseSecond.resolve();
    const chunks = await completion;
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: "error", errorText: "steering capture failed" }),
    );
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain("retry me");
    expect(service.store.getRun(started.runId).status).toBe("completed");
    service.close();
  });

  it("does not canonicalize steering when cancellation lands during capture", async () => {
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const steeringCaptureEntered = Promise.withResolvers<void>();
    const releaseSteeringCapture = Promise.withResolvers<void>();
    let modelCall = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelCall += 1;
        if (modelCall === 1) {
          firstEntered.resolve();
          await releaseFirst.promise;
          return textAndReadToolResult("before-cancel", "before cancel", "visible.txt");
        }
        return textResult("unexpected", "steering must not reach the provider");
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-steering-capture-cancel-"));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, "visible.txt"), "visible");
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      workspaceHistoryStoreFactory: (options) =>
        new ScriptedWorkspaceHistoryStore(options, async (call, workspaceId) => {
          if (call === 2) {
            steeringCaptureEntered.resolve();
            await releaseSteeringCapture.promise;
          }
          return capturedWorkspace(call, workspaceId);
        }),
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    const started = await service.startPrompt(session.id, userMessage("start"));
    const completion = collect(started.stream);
    await firstEntered.promise;
    const steer = steeringMessage("cancel during capture");
    await service.steer({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "cancelled-capture-steer",
      message: steer,
    });
    releaseFirst.resolve();
    await steeringCaptureEntered.promise;

    await service.cancel({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "cancel-during-capture",
    });
    releaseSteeringCapture.resolve();
    await completion;

    expect(
      service.store
        .listHistoryTopology(session.id)
        .transitions.filter((transition) => transition.delivery === "steer"),
    ).toEqual([]);
    expect(JSON.stringify(service.store.getModelMessages(session.id))).not.toContain(
      "cancel during capture",
    );
    expect(service.store.getUiMessages(session.id)).not.toContainEqual(steer);
    expect(model.doStreamCalls).toHaveLength(1);
    service.close();
  });

  it("exempts bounded read children from the settled aggregate budget", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-batch-overflow-"));
    temporaryDirectories.push(directory);
    const largePayload = `large:${"x".repeat(900)}\n`;
    const smallPayload = `small:${"y".repeat(400)}\n`;
    await Promise.all([
      writeFile(path.join(directory, "large.txt"), largePayload),
      writeFile(path.join(directory, "small.txt"), smallPayload),
    ]);
    const runtimeConfig = config();
    runtimeConfig.agent.profiles.reader!.tools = ["read", "batch"];
    const artifacts = createToolResultArtifactStore(path.join(directory, "tool-results"));
    await artifacts.init();
    const model = new MockLanguageModelV4({
      doStream: [batchedReadResult(["large.txt", "small.txt"]), textResult("answer", "inspected")],
    });
    const service = new SessionService({
      config: runtimeConfig,
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      toolResultArtifacts: artifacts,
      toolResultOutputConfig: {
        maxInlineBytes: 1_000,
        artifactTtlMs: 60_000,
        maxArtifactBytesPerScope: 1024 * 1024,
        maxArtifactBytes: 1024 * 1024,
      },
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    await collect((await service.startPrompt(session.id, userMessage("read both"))).stream);

    const transcript = JSON.stringify(service.store.getModelMessages(session.id));
    expect(transcript).not.toContain("[tool result overflow]");
    expect(transcript).toContain("x".repeat(500));
    expect(transcript).toContain("y".repeat(300));
    expect(await readdir(artifacts.rootDir)).toEqual([]);
    service.close();
  });

  it("bounds direct multibyte read output by UTF-8 bytes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-unicode-read-"));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, "unicode.txt"), "😀".repeat(11_000));
    const runtimeConfig = config();
    runtimeConfig.agent.profiles.reader!.tools = ["read"];
    const artifacts = createToolResultArtifactStore(path.join(directory, "tool-results"));
    await artifacts.init();
    const model = new MockLanguageModelV4({
      doStream: [readToolResult("unicode.txt"), textResult("answer", "inspected")],
    });
    const service = new SessionService({
      config: runtimeConfig,
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      toolResultArtifacts: artifacts,
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    const chunks = await collect(
      (await service.startPrompt(session.id, userMessage("read unicode"))).stream,
    );

    const transcript = JSON.stringify(service.store.getModelMessages(session.id));
    expect(transcript).not.toContain("[tool result overflow]");
    expect(transcript).toContain("😀".repeat(1_000));
    expect(await readdir(artifacts.rootDir)).toEqual([]);
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: "tool-output-available", toolCallId: "direct-read" }),
    );
    expect(chunks.some((chunk) => chunk.type === "tool-output-error")).toBe(false);
    service.close();
  });

  it("preserves capable-model image and PDF batch attachments without exposing base64 to UI chunks", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-batch-media-"));
    temporaryDirectories.push(directory);
    const image = Buffer.concat([
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axh8h0AAAAASUVORK5CYII=",
        "base64",
      ),
      Buffer.alloc(50 * 1024),
    ]);
    const pdf = Buffer.from("%PDF-1.4 mini-pdf-payload %%EOF");
    await Promise.all([
      writeFile(path.join(directory, "diagram.png"), image),
      writeFile(path.join(directory, "reference.pdf"), pdf),
    ]);
    const runtimeConfig = config();
    runtimeConfig.agent.profiles.reader!.tools = ["read", "batch"];
    const model = new MockLanguageModelV4({
      doStream: [
        batchedReadResult(["diagram.png", "reference.pdf"]),
        textResult("answer", "inspected media"),
      ],
    });
    const service = new SessionService({
      config: runtimeConfig,
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      modelCapability: new ModelCapability({
        overrides: {
          "test/mock": {
            attachment: true,
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
            limit: { context: 128_000, output: 4_096 },
          },
        },
      }),
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    const chunks = await collect(
      (await service.startPrompt(session.id, userMessage("inspect both attachments"))).stream,
    );

    const modelView = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(modelView).toContain(image.toString("base64"));
    expect(modelView).toContain(pdf.toString("base64"));
    expect(modelView.match(/"type":"file"/gu)).toHaveLength(2);
    const canonical = JSON.stringify(service.store.getModelMessages(session.id));
    expect(canonical).toContain(image.toString("base64"));
    expect(canonical).toContain(pdf.toString("base64"));
    expect(JSON.stringify(chunks)).not.toContain(image.toString("base64"));
    expect(JSON.stringify(chunks)).not.toContain(pdf.toString("base64"));
    expect(JSON.stringify(chunks)).toContain('"kind":"attachment"');
    expect(JSON.stringify(model.doStreamCalls[0]?.tools)).toContain(
      "Analyze supported images and PDFs already attached to context directly",
    );
    service.close();
  });

  it("projects structured read failures as failed exploration calls", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-read-failure-"));
    temporaryDirectories.push(directory);
    const runtimeConfig = config();
    runtimeConfig.agent.profiles.reader!.tools = ["read", "batch"];
    const model = new MockLanguageModelV4({
      doStream: [batchedReadResult(["missing.txt"]), textResult("answer", "handled")],
    });
    const service = new SessionService({
      config: runtimeConfig,
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    const chunks = await collect(
      (await service.startPrompt(session.id, userMessage("read the missing file"))).stream,
    );

    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: "tool-output-error",
        errorText: expect.stringContaining("missing.txt"),
      }),
    );
    service.close();
  });

  it("projects structured search failures as failed exploration calls", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-search-failure-"));
    temporaryDirectories.push(directory);
    const runtimeConfig = config();
    runtimeConfig.agent.profiles.reader!.tools = ["grep"];
    const missingPath = path.join(directory, "missing");
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call" as const,
                toolCallId: "failed-grep",
                toolName: "grep",
                input: JSON.stringify({ pattern: "needle", path: missingPath }),
              },
              {
                type: "finish" as const,
                finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
                usage: zeroUsage(),
              },
            ],
          }),
        },
        textResult("answer", "handled"),
      ],
    });
    const service = new SessionService({
      config: runtimeConfig,
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    const chunks = await collect(
      (await service.startPrompt(session.id, userMessage("search missing cwd"))).stream,
    );

    expect(chunks).toContainEqual(
      expect.objectContaining({ type: "tool-output-error", toolCallId: "failed-grep" }),
    );
    service.close();
  });

  it("keeps oversized grep output bounded inline without creating an artifact", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-tool-overflow-"));
    temporaryDirectories.push(directory);
    const longLine = `needle:${"x".repeat(8_000)}\n`;
    await writeFile(path.join(directory, "large.txt"), longLine);
    const runtimeConfig = config();
    runtimeConfig.agent.profiles.reader!.tools = ["grep", "read"];
    const artifacts = createToolResultArtifactStore(path.join(directory, "tool-results"));
    await artifacts.init();
    const model = new MockLanguageModelV4({
      doStream: [grepToolResult("needle"), textResult("answer", "inspected")],
    });
    const service = new SessionService({
      config: runtimeConfig,
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      toolResultArtifacts: artifacts,
      toolResultOutputConfig: {
        maxInlineBytes: 512,
        artifactTtlMs: 60_000,
        maxArtifactBytesPerScope: 1024 * 1024,
        maxArtifactBytes: 1024 * 1024,
      },
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    const chunks = await collect(
      (await service.startPrompt(session.id, userMessage("find it"))).stream,
    );

    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(secondPrompt).toContain("Search output reached the inline limit");
    expect(secondPrompt).toContain("[truncated]");
    expect(secondPrompt).not.toContain("tool-result://");
    expect(secondPrompt).not.toContain("x".repeat(1_000));
    expect(JSON.stringify(chunks)).not.toContain("x".repeat(1_000));
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: "tool-output-available",
        toolCallId: "oversized-grep",
      }),
    );

    const transcript = service.store.getModelMessages(session.id);
    const serializedTranscript = JSON.stringify(transcript);
    expect(serializedTranscript).toContain("[truncated]");
    expect(serializedTranscript).not.toContain("tool-result://");
    expect(serializedTranscript).not.toContain("x".repeat(1_000));
    expect(await readdir(artifacts.rootDir)).toEqual([]);
    service.close();
  });

  it("greps a tool-result artifact without spilling into another artifact", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-artifact-grep-"));
    temporaryDirectories.push(directory);
    const runtimeConfig = config();
    runtimeConfig.agent.profiles.reader!.tools = ["grep"];
    const artifacts = createToolResultArtifactStore(path.join(directory, "tool-results"));
    await artifacts.init();
    let artifactUri = "";
    let modelCall = 0;
    const model = new MockLanguageModelV4({
      doStream: async () =>
        modelCall++ === 0
          ? grepToolResult("needle", artifactUri)
          : textResult("answer", "inspected"),
    });
    const service = new SessionService({
      config: runtimeConfig,
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      toolResultArtifacts: artifacts,
      toolResultOutputConfig: {
        maxInlineBytes: 512,
        artifactTtlMs: 60_000,
        maxArtifactBytesPerScope: 1024 * 1024,
        maxArtifactBytes: 1024 * 1024,
      },
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    const artifact = await artifacts.create({
      scopeId: session.id,
      requestId: "producer-request",
      toolCallId: "producer-call",
      toolName: "bash",
      content: `${"x".repeat(8_000)}needle\n`,
      ttlMs: 60_000,
      maxBytesPerScope: 1024 * 1024,
    });
    if (artifact.status === "error") throw artifact.error;
    artifactUri = artifact.value.uri;
    const filesBefore = await readdir(artifacts.rootDir);

    await collect((await service.startPrompt(session.id, userMessage("search it"))).stream);

    const transcript = JSON.stringify(service.store.getModelMessages(session.id));
    expect(transcript).toContain(artifactUri);
    expect(transcript).toContain("needle");
    expect(transcript).toContain("[truncated]");
    expect(transcript).not.toContain("[tool result overflow]");
    expect(await readdir(artifacts.rootDir)).toEqual(filesBefore);
    service.close();
  });

  it("shares artifact authority between a root session and delegated children", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-child-artifacts-"));
    temporaryDirectories.push(directory);
    const runtimeConfig = config();
    runtimeConfig.agent.profiles.child!.tools = ["bash"];
    runtimeConfig.agent.profiles.child!.execution = true;
    runtimeConfig.agent.profiles.child!.workspaceWrites = true;
    const artifacts = createToolResultArtifactStore(path.join(directory, "tool-results"));
    await artifacts.init();
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        const prompt = JSON.stringify(options.prompt);
        const latestUser = JSON.stringify(
          options.prompt.filter((message) => message.role === "user").at(-1),
        );
        if (prompt.includes("child complete")) return textResult("root", "root complete");
        if (latestUser.includes("investigate") && prompt.includes("tool-result://")) {
          return textResult("child", "child complete");
        }
        if (latestUser.includes("investigate")) {
          return bashToolResult("printf '%050000d' 0");
        }
        return delegateResult("sync", "investigate");
      },
    });
    const service = new SessionService({
      config: runtimeConfig,
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      toolResultArtifacts: artifacts,
      toolResultOutputConfig: {
        maxInlineBytes: 512,
        artifactTtlMs: 60_000,
        maxArtifactBytesPerScope: 1024 * 1024,
        maxArtifactBytes: 1024 * 1024,
      },
    });
    const root = await service.createSession({
      cwd: directory,
      model: "test/mock",
      profile: "delegate",
    });
    await collect((await service.startPrompt(root.id, userMessage("delegate overflow"))).stream);

    const child = service.store
      .listSessions()
      .find((session) => session.id.startsWith(`sub:${root.id}:named:`));
    if (child === undefined) throw new Error("delegated child was not created");
    const childTranscript = JSON.stringify(service.store.getModelMessages(child.id));
    const uri = /tool-result:\/\/[0-9a-f-]{36}/u.exec(childTranscript)?.[0];
    if (uri === undefined) throw new Error("child overflow artifact URI was not persisted");
    expect((await artifacts.read(uri, root.id)).status).toBe("ok");
    expect((await artifacts.read(uri, child.id)).status).toBe("error");
    service.close();
  });

  it("accepts a loaded runtime config with its resolved configFile metadata", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-loaded-config-"));
    temporaryDirectories.push(directory);
    const runtimeConfig = config();
    const service = new SessionService({
      config: { ...runtimeConfig, configFile: path.join(directory, "config.yaml") },
      databasePath: path.join(directory, "sessions.sqlite"),
      modelResolver: () => new MockLanguageModelV4({}),
      attachCompaction: async () => () => {},
    });

    service.close();
  });

  it("returns owned session failures without misclassifying them as SQLite failures", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-session-result-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "sessions.sqlite"),
      modelResolver: () => new MockLanguageModelV4({}),
      attachCompaction: async () => () => {},
    });

    const created = await service.createSessionResult({
      id: "sub:reserved",
      cwd: directory,
      model: "test/mock",
    });

    expect(created.status).toBe("error");
    if (created.status === "error") {
      expect(created.error).toBeInstanceOf(MiniLilacSessionOperationRejected);
      expect(created.error).toMatchObject({
        _tag: "MiniLilacSessionOperationRejected",
        operation: "createSession",
      });
    }
    const externalFailure = await service.createSessionResult({
      cwd: path.join(directory, "missing"),
      model: "test/mock",
    });
    expect(externalFailure).toMatchObject({
      status: "error",
      error: {
        _tag: "MiniLilacSessionExternalFailure",
        operation: "createSession",
      },
    });
    expect(service.closeResult()).toMatchObject({ status: "ok" });
  });

  it("preserves Panic through the session Result boundary", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-session-panic-"));
    temporaryDirectories.push(directory);
    const panic = new Panic({ message: "model resolver invariant" });
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "sessions.sqlite"),
      modelResolver: () => {
        throw panic;
      },
      attachCompaction: async () => () => {},
    });

    await expect(service.createSessionResult({ cwd: directory, model: "test/mock" })).rejects.toBe(
      panic,
    );
    service.close();
  });

  it("cancels and awaits an active root before closing during shutdown", async () => {
    let rootStarted = () => {};
    const startedRoot = new Promise<void>((resolve) => {
      rootStarted = resolve;
    });
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        rootStarted();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new DOMException("shutdown", "AbortError"));
          options.abortSignal?.addEventListener("abort", abort, { once: true });
          if (options.abortSignal?.aborted) abort();
        });
        return textResult("unreachable", "unreachable");
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-root-shutdown-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const service = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => model,
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    const run = await service.startPrompt(session.id, userMessage("remain active"));
    const completion = collect(run.stream);
    await startedRoot;

    expect(() => service.close()).toThrow("use shutdown()");
    expect(() => service.store.close()).toThrow("runtime task(s) are active");
    const shutdown = service.shutdown({ graceMs: 1_000 });
    expect(() => service.startPrompt(session.id, userMessage("too late"))).toThrow(
      "not accepting admissions",
    );
    const rejectedAdmission = await service.startPromptResult(
      session.id,
      userMessage("still too late"),
    );
    expect(rejectedAdmission).toMatchObject({
      status: "error",
      error: {
        _tag: "MiniLilacSessionOperationRejected",
        operation: "admission",
      },
    });
    await shutdown;
    await completion;

    const reopened = new MiniLilacSqliteStore(databasePath);
    expect(reopened.getRun(run.runId).status).toBe("cancelled");
    expect(reopened.getSession(session.id)).toMatchObject({ status: "idle", activeRunId: null });
    reopened.close();
  });

  it("cancels a deferred delegated child before shutdown closes SQLite", async () => {
    let childStarted = () => {};
    const startedChild = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        const latestUser = JSON.stringify(
          options.prompt.filter((message) => message.role === "user").at(-1),
        );
        if (latestUser.includes("deferred child")) {
          childStarted();
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(new DOMException("shutdown", "AbortError"));
            options.abortSignal?.addEventListener("abort", abort, { once: true });
            if (options.abortSignal?.aborted) abort();
          });
        }
        if (model.doStreamCalls.length === 1) {
          return delegateResult("deferred", "deferred child");
        }
        return textResult("root-working", "waiting for deferred child");
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-child-shutdown-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const service = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => model,
    });
    const session = await service.createSession({
      cwd: directory,
      model: "test/mock",
      profile: "delegate",
    });
    const root = await service.startPrompt(session.id, userMessage("launch deferred work"));
    const completion = collect(root.stream);
    await startedChild;
    const child = delegatedRuns(service, session.id)[0];
    if (child === undefined) throw new Error("deferred child did not start");

    await service.shutdown({ graceMs: 1_000 });
    await completion;

    const reopened = new MiniLilacSqliteStore(databasePath);
    expect(reopened.getRun(root.runId).status).toBe("cancelled");
    expect(reopened.getRun(child.id).status).toBe("cancelled");
    reopened.close();
  });

  it("settles shutdown when title providers ignore cancellation", async () => {
    const runtimeConfig = config();
    runtimeConfig.agent.titleModel = "test/title";
    let titleStarted = () => {};
    const startedTitle = new Promise<void>((resolve) => {
      titleStarted = resolve;
    });
    let titleAborted = () => {};
    const abortedTitle = new Promise<void>((resolve) => {
      titleAborted = resolve;
    });
    let releaseTitle = () => {};
    const titleGate = new Promise<void>((resolve) => {
      releaseTitle = resolve;
    });
    const titleSettled = Promise.withResolvers<void>();
    const rootModel = new MockLanguageModelV4({ doStream: textResult("root", "done") });
    const titleModel = new MockLanguageModelV4({
      doStream: async (options) => {
        titleStarted();
        options.abortSignal?.addEventListener("abort", titleAborted, { once: true });
        if (options.abortSignal?.aborted) titleAborted();
        await titleGate;
        titleSettled.resolve();
        return textResult("title", "late title");
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-title-shutdown-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const service = new SessionService({
      config: runtimeConfig,
      databasePath,
      modelResolver: (specifier) => (specifier === "test/title" ? titleModel : rootModel),
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    await collect((await service.startPrompt(session.id, userMessage("fallback title"))).stream);
    await startedTitle;

    const shutdown = service.shutdown({ graceMs: 100 });
    await abortedTitle;
    await shutdown;
    releaseTitle();
    await titleSettled.promise;
    const reopened = new MiniLilacSqliteStore(databasePath);
    expect(reopened.getSession(session.id).title).toBe("fallback title");
    reopened.close();
  });
});
