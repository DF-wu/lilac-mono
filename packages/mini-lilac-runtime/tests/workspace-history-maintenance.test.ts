import {
  describe,
  expect,
  it,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
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
  it("repairs expected refs and reports orphan snapshot refs without deleting them", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "one\n");
    const first = await captured(store);
    await writeFile(path.join(workspace, "file.txt"), "two\n");
    const second = await captured(store);
    await git(store.storeDirectory, ["update-ref", "-d", first.gitRef]);

    const reconciliation = await store.reconcileExpectedSnapshotRefs([first.rootTreeOid]);
    expect(reconciliation.status).toBe("reconciled");
    if (reconciliation.status !== "reconciled") return;
    expect(reconciliation.expected).toEqual([
      {
        rootTreeOid: first.rootTreeOid,
        gitRef: first.gitRef,
        status: "repaired",
      },
    ]);
    expect(reconciliation.orphanRefs).toEqual([second.gitRef]);
    expect(await store.reconcileSnapshotRef(second.rootTreeOid)).toBe("present");
  });

  it("validates every object in expected snapshot graphs before repairing refs", async () => {
    const makeSnapshot = async (name: string) => {
      const root = await temporaryDirectory();
      const workspace = path.join(root, "workspace");
      const history = path.join(root, "history");
      await mkdir(path.join(workspace, "nested"), { recursive: true });
      await writeFile(path.join(workspace, "nested", "file.txt"), `${name}\n`);
      const store = new WorkspaceHistoryStore({
        cwd: workspace,
        historyRoot: history,
        workspaceId: `workspace-${name}`,
        namespaceId: "namespace-01",
        databasePathHash: "database-hash-01",
      });
      return { store, snapshot: await captured(store) };
    };
    const removeObject = async (store: WorkspaceHistoryStore, oid: string) => {
      await rm(path.join(store.storeDirectory, "objects", oid.slice(0, 2), oid.slice(2)));
    };
    const statusFor = async (store: WorkspaceHistoryStore, rootTreeOid: string) => {
      const result = await store.reconcileExpectedSnapshotRefs([rootTreeOid]);
      expect(result.status).toBe("reconciled");
      if (result.status !== "reconciled") throw new Error("reconciliation unavailable");
      return result.expected[0]?.status;
    };

    const missingManifest = await makeSnapshot("missing-manifest");
    await removeObject(missingManifest.store, missingManifest.snapshot.manifestBlobOid);
    expect(await statusFor(missingManifest.store, missingManifest.snapshot.rootTreeOid)).toBe(
      "missing",
    );

    const missingSubtree = await makeSnapshot("missing-subtree");
    const subtreeLine = await git(missingSubtree.store.storeDirectory, [
      "ls-tree",
      missingSubtree.snapshot.workspaceTreeOid,
      "nested",
    ]);
    const subtreeOid = subtreeLine.trim().split(/\s+/)[2];
    if (!subtreeOid) throw new Error("missing subtree oid");
    await removeObject(missingSubtree.store, subtreeOid);
    expect(await statusFor(missingSubtree.store, missingSubtree.snapshot.rootTreeOid)).toBe(
      "missing",
    );

    const missingBlob = await makeSnapshot("missing-blob");
    const blobLine = await git(missingBlob.store.storeDirectory, [
      "ls-tree",
      "-r",
      missingBlob.snapshot.workspaceTreeOid,
      "nested/file.txt",
    ]);
    const blobOid = blobLine.trim().split(/\s+/)[2];
    if (!blobOid) throw new Error("missing blob oid");
    await removeObject(missingBlob.store, blobOid);
    expect(await statusFor(missingBlob.store, missingBlob.snapshot.rootTreeOid)).toBe("missing");

    const malformed = await makeSnapshot("malformed-wrapper");
    const malformedRoot = (
      await git(
        malformed.store.storeDirectory,
        ["mktree"],
        `100644 blob ${malformed.snapshot.manifestBlobOid}\tmanifest.json\n`,
      )
    ).trim();
    expect(await statusFor(malformed.store, malformedRoot)).toBe("corrupt");
    expect(
      await git(malformed.store.storeDirectory, [
        "for-each-ref",
        "--format=%(refname)",
        `refs/mini-lilac/snapshots/${malformedRoot}`,
      ]),
    ).toBe("");
  });

  it("bulk-validates thousands of snapshot entries with bounded Git processes", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    const base = await captured(store);
    const workspaceTreeOid = (
      await git(
        store.storeDirectory,
        ["mktree"],
        Array.from(
          { length: 3_000 },
          (_, index) =>
            `100644 blob ${base.manifestBlobOid}\tfile-${index.toString().padStart(4, "0")}.txt\n`,
        ).join(""),
      )
    ).trim();
    const rootTreeOid = (
      await git(
        store.storeDirectory,
        ["mktree"],
        `100644 blob ${base.manifestBlobOid}\tmanifest.json\n` +
          `040000 tree ${workspaceTreeOid}\tworkspace\n`,
      )
    ).trim();
    const processCounter = path.join(root, "git-processes");
    const batchCounter = path.join(root, "git-batch-checks");
    const countingGit = path.join(root, "counting-git");
    await writeFile(
      countingGit,
      "#!/bin/sh\n" +
        `printf '1\\n' >> '${processCounter}'\n` +
        'case "$*" in\n' +
        `  *"cat-file --batch-check="*) printf '1\\n' >> '${batchCounter}' ;;\n` +
        "esac\n" +
        'exec git "$@"\n',
    );
    await chmod(countingGit, 0o755);
    await writeFile(processCounter, "");
    await writeFile(batchCounter, "");
    const countingStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      gitExecutable: countingGit,
    });

    const reconciliation = await countingStore.reconcileExpectedSnapshotRefs([rootTreeOid]);
    expect(reconciliation).toEqual({
      status: "reconciled",
      expected: [
        {
          rootTreeOid,
          gitRef: `refs/mini-lilac/snapshots/${rootTreeOid}`,
          status: "repaired",
        },
      ],
      orphanRefs: [base.gitRef],
    });
    const processCount = (await readFile(processCounter, "utf8")).trim().split("\n").length;
    const batchCount = (await readFile(batchCounter, "utf8")).trim().split("\n").length;
    expect(processCount).toBeLessThanOrEqual(10);
    expect(batchCount).toBe(2);
  });

  it("does not materialize a store when no snapshots are expected", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    const history = path.join(root, "history");
    await mkdir(workspace);
    const store = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-empty-reconcile",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      gitExecutable: path.join(root, "missing-git"),
    });

    expect(await store.reconcileExpectedSnapshotRefs([])).toEqual({
      status: "reconciled",
      expected: [],
      orphanRefs: [],
    });
    expect(await lstat(history).catch(() => undefined)).toBeUndefined();
  });

  it("reports existing refs as orphans when the expected set is empty", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "content\n");
    const snapshot = await captured(store);

    expect(await store.reconcileExpectedSnapshotRefs([])).toEqual({
      status: "reconciled",
      expected: [],
      orphanRefs: [snapshot.gitRef],
    });
  });

  it("reports copied-database snapshot roots missing without materializing a store", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    const history = path.join(root, "copied-history");
    const rootTreeOid = "1".repeat(40);
    await mkdir(workspace);
    const store = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-copied-db",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      gitExecutable: path.join(root, "missing-git"),
    });

    expect(await store.reconcileExpectedSnapshotRefs([rootTreeOid])).toEqual({
      status: "reconciled",
      expected: [
        {
          rootTreeOid,
          gitRef: `refs/mini-lilac/snapshots/${rootTreeOid}`,
          status: "missing",
        },
      ],
      orphanRefs: [],
    });
    expect(await lstat(history).catch(() => undefined)).toBeUndefined();
  });

  it("cleans only old timestamped orphan refs and retains expected, fresh, and legacy refs", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    const history = path.join(root, "history");
    let now = 1_000;
    await mkdir(workspace);
    const store = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-orphan-cleanup",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: { now: () => now },
    });
    await writeFile(path.join(workspace, "file.txt"), "expected\n");
    const expected = await captured(store);
    now = 2_000;
    await writeFile(path.join(workspace, "file.txt"), "old orphan\n");
    const oldOrphan = await captured(store);
    now = 3_000;
    await writeFile(path.join(workspace, "file.txt"), "legacy orphan\n");
    const legacyOrphan = await captured(store);
    await rm(
      path.join(store.storeDirectory, "snapshot-ref-created", `${legacyOrphan.rootTreeOid}.json`),
    );
    now = 9_000;
    await writeFile(path.join(workspace, "file.txt"), "fresh orphan\n");
    const freshOrphan = await captured(store);
    now = 10_000;

    const cleanup = await store.cleanupOrphanSnapshotRefs([expected.rootTreeOid], 5_000);
    expect(cleanup).toEqual({
      status: "cleaned",
      expected: [
        {
          rootTreeOid: expected.rootTreeOid,
          gitRef: expected.gitRef,
          status: "present",
        },
      ],
      removedOrphanRefs: [oldOrphan.gitRef],
      preservedOrphanRefs: [freshOrphan.gitRef, legacyOrphan.gitRef].sort(),
    });
    const remainingRefs = await git(store.storeDirectory, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/mini-lilac/snapshots/",
    ]);
    expect(remainingRefs.trim().split("\n").sort()).toEqual(
      [expected.gitRef, freshOrphan.gitRef, legacyOrphan.gitRef].sort(),
    );
  });

  it("does not publish a snapshot ref when durable metadata creation fails", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root, {
      testHooks: {
        beforeSnapshotRefMetadataWrite: () => {
          throw new Error("injected metadata failure");
        },
      },
    });
    await writeFile(path.join(workspace, "file.txt"), "content\n");

    await expect(store.capture()).rejects.toThrow("injected metadata failure");
    expect(
      await git(store.storeDirectory, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/mini-lilac/snapshots/",
      ]),
    ).toBe("");
    expect(
      (await readdir(path.join(store.storeDirectory, "snapshot-ref-created"))).filter((name) =>
        name.endsWith(".json"),
      ),
    ).toEqual([]);
  });

  it("leaves failed update-ref metadata unrooted and later cleans it", async () => {
    const root = await temporaryDirectory();
    let now = 1_000;
    let failRefUpdate = true;
    const { workspace, store } = await createStore(root, {
      testHooks: {
        now: () => now,
        beforePrivateGit: (args) => {
          if (failRefUpdate && args[0] === "update-ref" && args[1] !== "-d") {
            throw new Error("injected update-ref failure");
          }
        },
      },
    });
    await writeFile(path.join(workspace, "file.txt"), "content\n");
    await expect(store.capture()).rejects.toThrow("injected update-ref failure");
    expect(
      await git(store.storeDirectory, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/mini-lilac/snapshots/",
      ]),
    ).toBe("");
    const metadataDirectory = path.join(store.storeDirectory, "snapshot-ref-created");
    expect(
      (await readdir(metadataDirectory)).filter((name) => name.endsWith(".json")),
    ).toHaveLength(1);

    failRefUpdate = false;
    now = 10_000;
    await store.runMaintenance({
      loadExpectedRootTreeOids: () => [],
      orphanGracePeriodMs: 5_000,
    });
    expect((await readdir(metadataDirectory)).filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("leaves durable unrooted metadata before publication and cleans or removes it safely", async () => {
    const root = await temporaryDirectory();
    let now = 1_000;
    let failBeforeRef = true;
    const { workspace, store } = await createStore(root, {
      testHooks: {
        now: () => now,
        afterSnapshotRefMetadataWriteBeforeRef: () => {
          if (failBeforeRef) throw new Error("injected pre-publication crash");
        },
      },
    });
    await writeFile(path.join(workspace, "file.txt"), "first\n");
    await expect(store.capture()).rejects.toThrow("injected pre-publication crash");
    expect(
      await git(store.storeDirectory, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/mini-lilac/snapshots/",
      ]),
    ).toBe("");
    const metadataDirectory = path.join(store.storeDirectory, "snapshot-ref-created");
    const firstMetadataName = (await readdir(metadataDirectory)).find((name) =>
      name.endsWith(".json"),
    );
    if (!firstMetadataName) throw new Error("metadata intent missing");
    expect(
      JSON.parse(await readFile(path.join(metadataDirectory, firstMetadataName), "utf8")),
    ).toMatchObject({ createdAtMs: 1_000 });

    failBeforeRef = false;
    now = 10_000;
    await store.runMaintenance({
      loadExpectedRootTreeOids: () => [],
      orphanGracePeriodMs: 5_000,
    });
    expect(
      await lstat(path.join(metadataDirectory, firstMetadataName)).catch(() => undefined),
    ).toBeUndefined();

    failBeforeRef = true;
    now = 20_000;
    await writeFile(path.join(workspace, "file.txt"), "second\n");
    await expect(store.capture()).rejects.toThrow("injected pre-publication crash");
    failBeforeRef = false;
    const workspaceStoreRoot = path.dirname(store.storeDirectory);
    const siblingPath = path.join(workspaceStoreRoot, "sibling.txt");
    await writeFile(siblingPath, "survives\n");
    expect(
      await store.runMaintenance({
        loadExpectedRootTreeOids: () => [],
        orphanGracePeriodMs: 100_000,
        removeStoreIfUnused: { canRemoveStore: () => true },
      }),
    ).toMatchObject({ storeDisposition: "removed" });
    expect(await readFile(siblingPath, "utf8")).toBe("survives\n");
  });

  it("publishes age metadata before a crash and never removes an expected ref", async () => {
    const root = await temporaryDirectory();
    let now = 1_000;
    let failAfterPublication = true;
    const { workspace, store } = await createStore(root, {
      testHooks: {
        now: () => now,
        afterSnapshotRefPublication: () => {
          if (failAfterPublication) throw new Error("injected post-publication crash");
        },
      },
    });
    await writeFile(path.join(workspace, "file.txt"), "published\n");
    await expect(store.capture()).rejects.toThrow("injected post-publication crash");
    failAfterPublication = false;
    const refs = (
      await git(store.storeDirectory, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/mini-lilac/snapshots/",
      ])
    ).trim();
    const [gitRef, rootTreeOid] = refs.split(" ");
    if (!gitRef || !rootTreeOid) throw new Error("published ref missing");
    const metadataPath = path.join(
      store.storeDirectory,
      "snapshot-ref-created",
      `${rootTreeOid}.json`,
    );
    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toEqual({
      formatVersion: 1,
      rootTreeOid,
      gitRef,
      createdAtMs: 1_000,
    });

    now = 10_000;
    expect(
      await store.runMaintenance({
        loadExpectedRootTreeOids: () => [rootTreeOid],
        orphanGracePeriodMs: 5_000,
      }),
    ).toMatchObject({ removedOrphanRefs: [], expected: [{ status: "present" }] });
    expect(await store.reconcileSnapshotRef(rootTreeOid)).toBe("present");
    expect(
      await store.runMaintenance({
        loadExpectedRootTreeOids: () => [],
        orphanGracePeriodMs: 5_000,
      }),
    ).toMatchObject({ removedOrphanRefs: [gitRef] });
  });

  it("preserves valid age and gives expected legacy refs a finite conservative age", async () => {
    const root = await temporaryDirectory();
    let now = 1_000;
    const { workspace, store } = await createStore(root, { testHooks: { now: () => now } });
    await writeFile(path.join(workspace, "file.txt"), "content\n");
    const snapshot = await captured(store);
    const metadataPath = path.join(
      store.storeDirectory,
      "snapshot-ref-created",
      `${snapshot.rootTreeOid}.json`,
    );
    now = 5_000;
    await captured(store);
    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toMatchObject({ createdAtMs: 1_000 });

    await rm(metadataPath);
    now = 6_000;
    await captured(store);
    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toMatchObject({ createdAtMs: 6_000 });
    await rm(metadataPath);
    now = 10_000;
    expect(await store.cleanupOrphanSnapshotRefs([], 1_000)).toMatchObject({
      removedOrphanRefs: [],
      preservedOrphanRefs: [snapshot.gitRef],
    });
    expect(await store.reconcileExpectedSnapshotRefs([snapshot.rootTreeOid])).toMatchObject({
      expected: [{ status: "present" }],
    });
    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toMatchObject({ createdAtMs: 10_000 });
    now = 16_000;
    expect(await store.cleanupOrphanSnapshotRefs([], 5_000)).toMatchObject({
      removedOrphanRefs: [snapshot.gitRef],
    });
  });

  it("reconciles and cleans orphan refs before maintenance accounting", async () => {
    const root = await temporaryDirectory();
    let now = 1_000;
    const commands: string[] = [];
    const maintenanceEvents: string[] = [];
    const { workspace, store } = await createStore(root, {
      testHooks: {
        now: () => now,
        beforePrivateGit: (args) => {
          commands.push(args.join(" "));
          if (args.includes("gc")) maintenanceEvents.push("gc:start");
          if (args.includes("count-objects")) maintenanceEvents.push("count:start");
        },
        afterPrivateGit: (args) => {
          if (args.includes("gc")) maintenanceEvents.push("gc:exit");
          if (args.includes("count-objects")) maintenanceEvents.push("count:exit");
        },
      },
    });
    await writeFile(path.join(workspace, "file.txt"), "expected\n");
    const expected = await captured(store);
    now = 2_000;
    await writeFile(path.join(workspace, "file.txt"), "old\n");
    const oldOrphan = await captured(store);
    now = 9_000;
    await writeFile(path.join(workspace, "file.txt"), "young\n");
    const youngOrphan = await captured(store);
    now = 9_100;
    await writeFile(path.join(workspace, "file.txt"), "legacy\n");
    const legacyOrphan = await captured(store);
    await rm(
      path.join(store.storeDirectory, "snapshot-ref-created", `${legacyOrphan.rootTreeOid}.json`),
    );
    await git(store.storeDirectory, ["update-ref", "-d", expected.gitRef]);
    now = 10_000;
    commands.length = 0;
    maintenanceEvents.length = 0;

    const result = await store.runMaintenance({
      loadExpectedRootTreeOids: () => [expected.rootTreeOid],
      orphanGracePeriodMs: 5_000,
    });
    expect(result).toMatchObject({
      status: "maintained",
      storeDisposition: "retained",
      expected: [{ rootTreeOid: expected.rootTreeOid, status: "repaired" }],
      removedOrphanRefs: [oldOrphan.gitRef],
      preservedOrphanRefs: [legacyOrphan.gitRef, youngOrphan.gitRef].sort(),
      accounting: {
        looseObjectCount: expect.any(Number),
        looseObjectBytes: expect.any(BigInt),
        inPackObjectCount: expect.any(Number),
        packCount: expect.any(Number),
        packBytes: expect.any(BigInt),
        prunePackableObjectCount: expect.any(Number),
        garbageObjectCount: expect.any(Number),
        garbageBytes: expect.any(BigInt),
      },
    });
    expect(await store.objectExists(expected.rootTreeOid, "tree")).toBe(true);
    const gcIndex = commands.findIndex((command) => command.includes("gc --auto --no-detach"));
    const countIndex = commands.findIndex((command) => command.endsWith("count-objects -v"));
    expect(gcIndex).toBeGreaterThan(0);
    expect(commands[gcIndex]).toContain("gc.pruneExpire=5.seconds.ago");
    expect(countIndex).toBeGreaterThan(gcIndex);
    expect(commands.slice(0, gcIndex).some((command) => command.includes("ls-tree"))).toBe(true);
    expect(commands.slice(0, gcIndex).some((command) => command.includes("update-ref"))).toBe(true);
    expect(maintenanceEvents.slice(-4)).toEqual([
      "gc:start",
      "gc:exit",
      "count:start",
      "count:exit",
    ]);
  });

  it("loads expected roots inside the lock after a concurrent capture commits its durable root", async () => {
    const root = await temporaryDirectory();
    let now = 1_000;
    const { workspace, store } = await createStore(root, { testHooks: { now: () => now } });
    await writeFile(path.join(workspace, "file.txt"), "expected-a\n");
    const expectedA = await captured(store);
    now = 2_000;
    await writeFile(path.join(workspace, "file.txt"), "old-orphan\n");
    const oldOrphan = await captured(store);
    now = 3_000;
    await writeFile(path.join(workspace, "file.txt"), "newly-expected\n");
    const captureFinished = deferred();
    const allowDurableCommit = deferred();
    const durableRoots = new Set([expectedA.rootTreeOid]);
    let newlyExpected: Awaited<ReturnType<typeof captured>> | undefined;
    const captureAndCommit = store.withWorkspaceLock(async (lockedStore) => {
      const result = await lockedStore.capture();
      if (result.status !== "captured") throw new Error("capture unavailable");
      newlyExpected = result;
      captureFinished.resolve();
      await allowDurableCommit.promise;
      durableRoots.add(result.rootTreeOid);
    });
    await captureFinished.promise;
    now = 10_000;
    let providerCalled = false;
    const maintenance = store.runMaintenance({
      loadExpectedRootTreeOids: () => {
        providerCalled = true;
        return [...durableRoots];
      },
      orphanGracePeriodMs: 1_000,
    });
    expect(providerCalled).toBe(false);
    allowDurableCommit.resolve();
    await captureAndCommit;
    const result = await maintenance;
    expect(providerCalled).toBe(true);
    expect(result).toMatchObject({
      status: "maintained",
      removedOrphanRefs: [oldOrphan.gitRef],
    });
    if (!newlyExpected) throw new Error("new expected snapshot missing");
    expect(await store.reconcileSnapshotRef(newlyExpected.rootTreeOid)).toBe("present");
  });

  it("does not create a missing store during maintenance or accounting", async () => {
    const root = await temporaryDirectory();
    const { history, store } = await createStore(root, {
      gitExecutable: path.join(root, "missing-git"),
    });
    const oid = "1".repeat(40);

    expect(
      await store.runMaintenance({
        loadExpectedRootTreeOids: () => [oid],
        orphanGracePeriodMs: 1_000,
      }),
    ).toMatchObject({
      status: "missing",
      expected: [{ rootTreeOid: oid, status: "missing" }],
    });
    expect(await store.getObjectAccounting()).toEqual({
      status: "missing",
      accounting: {
        looseObjectCount: 0,
        looseObjectBytes: 0n,
        inPackObjectCount: 0,
        packCount: 0,
        packBytes: 0n,
        prunePackableObjectCount: 0,
        garbageObjectCount: 0,
        garbageBytes: 0n,
      },
    });
    expect(await lstat(history).catch(() => undefined)).toBeUndefined();
  });

  it("classifies maintenance Git failures and unavailable capability", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "content\n");
    const snapshot = await captured(store);
    const failingGit = path.join(root, "failing-maintenance-git");
    await writeFile(
      failingGit,
      "#!/bin/sh\n" + 'case "$*" in *"gc --auto"*) exit 31 ;; esac\n' + 'exec git "$@"\n',
    );
    await chmod(failingGit, 0o755);
    const failingStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      gitExecutable: failingGit,
    });
    await expect(
      failingStore.runMaintenance({
        loadExpectedRootTreeOids: () => [snapshot.rootTreeOid],
        orphanGracePeriodMs: 1_000,
      }),
    ).rejects.toMatchObject({
      code: "git-command-failed",
      operation: "maintain private Git objects",
      exitCode: 31,
    });

    const unavailableStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      gitExecutable: path.join(root, "missing-git"),
    });
    expect(
      await unavailableStore.runMaintenance({
        loadExpectedRootTreeOids: () => [snapshot.rootTreeOid],
        orphanGracePeriodMs: 1_000,
      }),
    ).toEqual({ status: "unavailable", reason: "git-unavailable" });
  });

  it("strictly parses object accounting and rejects malformed output", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "content\n");
    await captured(store);
    const accountingGit = path.join(root, "accounting-git");
    await writeFile(
      accountingGit,
      "#!/bin/sh\n" +
        'case "$*" in\n' +
        '  *"count-objects -v"*) printf "count: 2\\nsize: 3\\nin-pack: 4\\npacks: 5\\nsize-pack: 6\\nprune-packable: 7\\ngarbage: 8\\nsize-garbage: 9\\n"; exit 0 ;;\n' +
        "esac\n" +
        'exec git "$@"\n',
    );
    await chmod(accountingGit, 0o755);
    const accountingStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      gitExecutable: accountingGit,
    });
    expect(await accountingStore.getObjectAccounting()).toEqual({
      status: "accounted",
      accounting: {
        looseObjectCount: 2,
        looseObjectBytes: 3n * 1024n,
        inPackObjectCount: 4,
        packCount: 5,
        packBytes: 6n * 1024n,
        prunePackableObjectCount: 7,
        garbageObjectCount: 8,
        garbageBytes: 9n * 1024n,
      },
    });

    for (const [name, output] of [
      ["missing", "count: 0\n"],
      [
        "duplicate",
        "count: 0\ncount: 0\nsize: 0\nin-pack: 0\npacks: 0\nsize-pack: 0\nprune-packable: 0\ngarbage: 0\nsize-garbage: 0\n",
      ],
      [
        "decimal",
        "count: 0\nsize: 1.5\nin-pack: 0\npacks: 0\nsize-pack: 0\nprune-packable: 0\ngarbage: 0\nsize-garbage: 0\n",
      ],
    ] as const) {
      const malformedGit = path.join(root, `accounting-${name}-git`);
      await writeFile(
        malformedGit,
        "#!/bin/sh\n" +
          'case "$*" in *"count-objects -v"*) printf ' +
          `${JSON.stringify(output)}; exit 0 ;; esac\n` +
          'exec git "$@"\n',
      );
      await chmod(malformedGit, 0o755);
      const malformedStore = new WorkspaceHistoryStore({
        cwd: workspace,
        historyRoot: history,
        workspaceId: "workspace-01",
        namespaceId: "namespace-01",
        databasePathHash: "database-hash-01",
        gitExecutable: malformedGit,
      });
      await expect(malformedStore.getObjectAccounting()).rejects.toMatchObject({
        code: "malformed-git-output",
        operation: "account private Git objects",
      });
    }
  });

  it("rejects private object alternates before accounting or maintenance", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "content\n");
    const snapshot = await captured(store);
    const alternatesPath = path.join(store.storeDirectory, "objects", "info", "alternates");
    await writeFile(alternatesPath, `${path.join(root, "external-objects")}\n`);

    await expect(store.getObjectAccounting()).rejects.toMatchObject({
      code: "ownership-mismatch",
      operation: "verify private Git isolation",
    });
    await expect(
      store.runMaintenance({
        loadExpectedRootTreeOids: () => [snapshot.rootTreeOid],
        orphanGracePeriodMs: 1_000,
      }),
    ).rejects.toMatchObject({
      code: "ownership-mismatch",
      operation: "verify private Git isolation",
    });
  });
});
