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
  temporaryDirectory,
  git,
  createStore,
  captured,
  invalidateCaptureCache,
  restoreFromCurrent,
  restoreTempNames,
  runDurablePlanCrash,
} from "./workspace-history-test-support";

describe("WorkspaceHistoryStore", () => {
  it("supports journaling between prepared restore and apply and rejects stale plans", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "target\n");
    const snapshot = await captured(store);
    await writeFile(path.join(workspace, "file.txt"), "current\n");
    const current = await captured(store);

    let journalWritten = false;
    await store.withWorkspaceLock(async (lockedStore) => {
      const entriesBeforePrepare = (await readdir(workspace)).sort();
      const prepared = await lockedStore.prepareRestore(snapshot.rootTreeOid, {
        status: "captured",
        rootTreeOid: current.rootTreeOid,
      });
      expect(prepared.status).toBe("prepared");
      if (prepared.status !== "prepared") return;
      expect(await store.objectExists(snapshot.rootTreeOid, "tree")).toBe(true);
      expect(await store.reconcileSnapshotRef(snapshot.rootTreeOid)).toBe("present");
      expect((await readdir(workspace)).sort()).toEqual(entriesBeforePrepare);
      expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe("current\n");
      journalWritten = true;
      expect(await prepared.plan.apply()).toEqual({ status: "restored" });
    });
    expect(journalWritten).toBe(true);
    expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe("target\n");

    await writeFile(path.join(workspace, "file.txt"), "before-prepare\n");
    const beforePrepare = await captured(store);
    await store.withWorkspaceLock(async (lockedStore) => {
      const prepared = await lockedStore.prepareRestore(snapshot.rootTreeOid, {
        status: "captured",
        rootTreeOid: beforePrepare.rootTreeOid,
      });
      expect(prepared.status).toBe("prepared");
      if (prepared.status !== "prepared") return;
      await writeFile(path.join(workspace, "file.txt"), "stale-change\n");
      await expect(prepared.plan.apply()).rejects.toMatchObject({ code: "restore-conflict" });
    });
    expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe("stale-change\n");
    expect(restoreTempNames(await readdir(workspace))).toEqual([]);
  });

  it("rejects capture-to-preflight drift before returning a restore plan", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "target\n");
    const target = await captured(store);
    await writeFile(path.join(workspace, "file.txt"), "captured-source\n");
    const expectedCurrent = await captured(store);
    await writeFile(path.join(workspace, "file.txt"), "drift-after-capture\n");
    const entriesBefore = (await readdir(workspace)).sort();

    await store.withWorkspaceLock(async (lockedStore) => {
      await expect(
        lockedStore.prepareRestore(target.rootTreeOid, {
          status: "captured",
          rootTreeOid: expectedCurrent.rootTreeOid,
        }),
      ).rejects.toMatchObject({ code: "restore-conflict" });
    });
    expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe("drift-after-capture\n");
    expect((await readdir(workspace)).sort()).toEqual(entriesBefore);
  });

  it("rejects a deterministic mutation after bound source capture without losing the edit", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    const history = path.join(root, "history");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "file.txt"), "target\n");
    const baseStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-bound-seam",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
    });
    const target = await captured(baseStore);
    await writeFile(path.join(workspace, "file.txt"), "expected-source\n");
    const expected = await captured(baseStore);
    let mutated = false;
    const seamStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-bound-seam",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        afterBoundSourceCapture: async () => {
          if (mutated) return;
          mutated = true;
          await writeFile(path.join(workspace, "file.txt"), "seam-edit\n");
        },
      },
    });
    await seamStore.withWorkspaceLock(async (lockedStore) => {
      await expect(
        lockedStore.prepareRestore(target.rootTreeOid, {
          status: "captured",
          rootTreeOid: expected.rootTreeOid,
        }),
      ).rejects.toMatchObject({ code: "restore-conflict" });
    });
    expect(mutated).toBe(true);
    expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe("seam-edit\n");
  });

  for (const scenario of [
    {
      name: "removed-ignore-rule",
      sourceRule: "secret.txt\n",
      targetRule: "other.txt\n",
      kept: "secret.txt",
    },
    {
      name: "added-ignore-rule",
      sourceRule: "other.txt\n",
      targetRule: "secret.txt\n",
      kept: "other.txt",
    },
  ] as const) {
    it(`resumes a durable frozen plan after publishing target ignore rules (${scenario.name})`, async () => {
      const root = await temporaryDirectory();
      const workspace = path.join(root, "workspace");
      const history = path.join(root, "history");
      const protectedPath = path.join(workspace, "protected.txt");
      const operationId = `operation-${scenario.name}`;
      await mkdir(workspace);
      await writeFile(path.join(workspace, ".gitignore"), scenario.targetRule);
      await writeFile(path.join(workspace, "managed.txt"), "target\n");
      const store = new WorkspaceHistoryStore({
        cwd: workspace,
        historyRoot: history,
        workspaceId: `workspace-${scenario.name}`,
        namespaceId: "namespace-01",
        databasePathHash: "database-hash-01",
        protectedPaths: [protectedPath],
      });
      const target = await captured(store);
      await writeFile(path.join(workspace, ".gitignore"), scenario.sourceRule);
      await writeFile(path.join(workspace, "managed.txt"), "source\n");
      await writeFile(path.join(workspace, scenario.kept), "preserved secret\n");
      await writeFile(protectedPath, "protected value\n");
      const source = await captured(store);

      expect(
        await runDurablePlanCrash({
          root,
          workspace,
          history,
          workspaceId: `workspace-${scenario.name}`,
          rootTreeOid: target.rootTreeOid,
          operationId,
          protectedPath,
        }),
      ).toBe(94);
      expect(await readFile(path.join(workspace, ".gitignore"), "utf8")).toBe(scenario.targetRule);
      const resumeInput = {
        operationId,
        targetRootTreeOid: target.rootTreeOid,
        sourceRootTreeOid: source.rootTreeOid,
      };
      if (scenario.name === "added-ignore-rule") {
        await writeFile(protectedPath, "tampered after crash\n");
        await expect(store.resumeRestore(resumeInput)).rejects.toMatchObject({
          code: "restore-conflict",
        });
        await writeFile(protectedPath, "protected value\n");
      }
      expect(await store.resumeRestore(resumeInput)).toEqual({ status: "restored" });
      expect(await readFile(path.join(workspace, scenario.kept), "utf8")).toBe(
        "preserved secret\n",
      );
      expect(await readFile(protectedPath, "utf8")).toBe("protected value\n");
      expect(await readFile(path.join(workspace, "managed.txt"), "utf8")).toBe("target\n");
      await store.deleteRestorePlan(operationId);
      expect(
        await lstat(path.join(store.storeDirectory, "restore-plans", `${operationId}.json`)).catch(
          () => undefined,
        ),
      ).toBeUndefined();
    });
  }

  it("retains active durable plans and removes only caller-released old plans", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    const history = path.join(root, "history");
    let now = 1_000;
    await mkdir(workspace);
    await writeFile(path.join(workspace, "file.txt"), "target\n");
    const store = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-plan-cleanup",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: { now: () => now },
    });
    const target = await captured(store);
    await writeFile(path.join(workspace, "file.txt"), "source\n");
    const source = await captured(store);
    await store.withWorkspaceLock(async (locked) => {
      const prepared = await locked.prepareRestore(
        target.rootTreeOid,
        { status: "captured", rootTreeOid: source.rootTreeOid },
        "active-plan",
      );
      expect(prepared.status).toBe("prepared");
    });
    now = 10_000;
    expect(await store.cleanupRestorePlans(["active-plan"], 1_000)).toEqual({
      removedOperationIds: [],
      preservedOperationIds: ["active-plan"],
    });
    expect(await store.cleanupRestorePlans([], 1_000)).toEqual({
      removedOperationIds: ["active-plan"],
      preservedOperationIds: [],
    });
  });

  it("activates a prepared durable plan after protected journal state changes", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    const history = path.join(root, "history");
    const protectedPath = path.join(workspace, "journal.db");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "file.txt"), "target\n");
    await writeFile(protectedPath, "before journal\n");
    const store = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-plan-activation",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      protectedPaths: [protectedPath],
    });
    const target = await captured(store);
    await writeFile(path.join(workspace, "file.txt"), "source\n");
    const source = await captured(store);
    await store.withWorkspaceLock(async (locked) => {
      const prepared = await locked.prepareRestore(
        target.rootTreeOid,
        { status: "captured", rootTreeOid: source.rootTreeOid },
        "journal-gap",
      );
      expect(prepared.status).toBe("prepared");
    });

    await writeFile(protectedPath, "after journal\n");
    expect(
      await store.resumeRestore({
        operationId: "journal-gap",
        targetRootTreeOid: target.rootTreeOid,
        sourceRootTreeOid: source.rootTreeOid,
      }),
    ).toEqual({ status: "restored" });
    expect(await readFile(protectedPath, "utf8")).toBe("after journal\n");
  });

  it("preserves an exact unavailable source expectation during restore preparation", async () => {
    const root = await temporaryDirectory();
    const { store } = await createStore(root);
    await store.withWorkspaceLock(async (lockedStore) => {
      expect(
        await lockedStore.prepareRestore("0".repeat(40), {
          status: "unavailable",
          reason: "git-unavailable",
        }),
      ).toEqual({ status: "skipped", reason: "git-unavailable" });
      expect(
        await lockedStore.prepareRestore("0".repeat(40), {
          status: "unavailable",
          reason: "platform-unsupported",
        }),
      ).toEqual({ status: "skipped", reason: "platform-unsupported" });
    });
  });

  it("verifies a target snapshot without materializing or modifying the workspace", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "target\n");
    const target = await captured(store);
    expect(await store.verifySnapshot(target.rootTreeOid)).toEqual({ status: "verified" });

    await writeFile(path.join(workspace, "file.txt"), "drift\n");
    const entriesBefore = (await readdir(workspace)).sort();
    await expect(store.verifySnapshot(target.rootTreeOid)).rejects.toMatchObject({
      code: "filesystem-error",
      operation: "verify restored workspace",
    });
    expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe("drift\n");
    expect((await readdir(workspace)).sort()).toEqual(entriesBefore);

    expect(await restoreFromCurrent(store, target.rootTreeOid)).toEqual({ status: "restored" });
    const current = await captured(store);
    await store.withWorkspaceLock(async (lockedStore) => {
      const prepared = await lockedStore.prepareRestore(target.rootTreeOid, {
        status: "captured",
        rootTreeOid: current.rootTreeOid,
      });
      expect(prepared.status).toBe("prepared");
      if (prepared.status === "prepared") {
        expect(await prepared.plan.verify()).toEqual({ status: "verified" });
      }
    });
  });

  it("verification rejects extra managed paths but permits ignored and protected extras", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    const history = path.join(root, "history");
    const protectedExtra = path.join(workspace, "protected-extra.txt");
    await mkdir(workspace);
    await writeFile(path.join(workspace, ".gitignore"), "ignored-extra.txt\n");
    await writeFile(path.join(workspace, "file.txt"), "target\n");
    const store = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-verify-extra",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      protectedPaths: [protectedExtra],
    });
    const target = await captured(store);
    await writeFile(path.join(workspace, "extra.txt"), "extra\n");
    const current = await captured(store);
    await expect(store.verifySnapshot(target.rootTreeOid)).rejects.toThrow(
      "Managed path is absent from target snapshot: extra.txt",
    );
    await store.withWorkspaceLock(async (lockedStore) => {
      const prepared = await lockedStore.prepareRestore(target.rootTreeOid, {
        status: "captured",
        rootTreeOid: current.rootTreeOid,
      });
      expect(prepared.status).toBe("prepared");
      if (prepared.status === "prepared") {
        await expect(prepared.plan.verify()).rejects.toThrow(
          "Managed path is absent from target snapshot: extra.txt",
        );
      }
    });

    await rm(path.join(workspace, "extra.txt"));
    await writeFile(path.join(workspace, "ignored-extra.txt"), "ignored\n");
    await writeFile(protectedExtra, "protected\n");
    expect(await store.verifySnapshot(target.rootTreeOid)).toEqual({ status: "verified" });
    expect(await readFile(path.join(workspace, "ignored-extra.txt"), "utf8")).toBe("ignored\n");
    expect(await readFile(protectedExtra, "utf8")).toBe("protected\n");
  });

  it("treats Git exit 128 as operational and Git disappearance as unavailable", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "content\n");
    const snapshot = await captured(store);
    expect(await store.objectExists("0".repeat(40), "tree")).toBe(false);
    const failingGit = path.join(root, "failing-git");
    await writeFile(
      failingGit,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then exec git --version; fi\nexit 128\n',
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
    await expect(failingStore.objectExists(snapshot.rootTreeOid, "tree")).rejects.toMatchObject({
      code: "git-command-failed",
      exitCode: 128,
    });
    await expect(
      failingStore.reconcileExpectedSnapshotRefs([snapshot.rootTreeOid]),
    ).rejects.toMatchObject({ code: "git-command-failed", exitCode: 128 });

    const disappearingGit = path.join(root, "disappearing-git");
    await writeFile(disappearingGit, '#!/bin/sh\nexec git "$@"\n');
    await chmod(disappearingGit, 0o755);
    const disappearingStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      gitExecutable: disappearingGit,
    });
    expect(await disappearingStore.capability()).toMatchObject({ status: "available" });
    await rm(disappearingGit);
    await expect(
      disappearingStore.objectExists(snapshot.rootTreeOid, "tree"),
    ).rejects.toMatchObject({ code: "git-unavailable" });
    expect(await disappearingStore.reconcileSnapshotRef(snapshot.rootTreeOid)).toBe(
      "git-unavailable",
    );
  });

  it("rejects case-fold collisions under an explicit case-insensitive destination policy", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root, { pathComparison: "case-insensitive" });
    await writeFile(path.join(workspace, "Readme"), "one\n");
    await writeFile(path.join(workspace, "readme"), "two\n");

    expect(await store.capability()).toMatchObject({ pathComparison: "case-insensitive" });
    await expect(store.capture()).rejects.toMatchObject({
      code: "snapshot-invalid",
      operation: "validate snapshot paths",
    });
  });

  it("applies case-insensitive policy to Git boundaries and protected aliases", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    const history = path.join(root, "history");
    const protectedAlias = path.join(workspace, "Secret");
    await mkdir(path.join(workspace, "nested", ".GIT"), { recursive: true });
    await mkdir(path.join(workspace, "secret"));
    await writeFile(path.join(workspace, "nested", ".GIT", "config"), "metadata\n");
    await writeFile(path.join(workspace, "nested", "hidden.txt"), "nested\n");
    await writeFile(path.join(workspace, "secret", "token.txt"), "protected\n");
    await writeFile(path.join(workspace, "visible.txt"), "visible\n");
    const store = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-case-policy",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      pathComparison: "case-insensitive",
      protectedPaths: [protectedAlias],
    });
    const snapshot = await captured(store);
    expect(snapshot.managedPathCount).toBe(1);

    const sensitiveStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-case-policy",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      pathComparison: "case-sensitive",
    });
    await rm(path.join(workspace, "nested"), { recursive: true });
    await writeFile(path.join(workspace, "secret", "token.txt"), "target replacement\n");
    await invalidateCaptureCache(sensitiveStore);
    const protectedAliasTarget = await captured(sensitiveStore);
    await writeFile(path.join(workspace, "secret", "token.txt"), "protected\n");
    await invalidateCaptureCache(store);
    const current = await captured(store);
    await store.withWorkspaceLock(async (locked) => {
      await expect(
        locked.prepareRestore(protectedAliasTarget.rootTreeOid, {
          status: "captured",
          rootTreeOid: current.rootTreeOid,
        }),
      ).rejects.toThrow("Target path overlaps a protected path: secret/token.txt");
    });

    const gitMetadataTreeOid = (
      await git(
        sensitiveStore.storeDirectory,
        ["mktree"],
        `100644 blob ${protectedAliasTarget.manifestBlobOid}\tconfig\n`,
      )
    ).trim();
    const tamperedWorkspaceTreeOid = (
      await git(
        sensitiveStore.storeDirectory,
        ["mktree"],
        `040000 tree ${gitMetadataTreeOid}\t.GIT\n`,
      )
    ).trim();
    const tamperedRootTreeOid = (
      await git(
        sensitiveStore.storeDirectory,
        ["mktree"],
        `100644 blob ${protectedAliasTarget.manifestBlobOid}\tmanifest.json\n` +
          `040000 tree ${tamperedWorkspaceTreeOid}\tworkspace\n`,
      )
    ).trim();
    const insensitiveReader = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-case-policy",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      pathComparison: "case-insensitive",
    });
    await expect(
      insensitiveReader.reconcileExpectedSnapshotRefs([tamperedRootTreeOid]),
    ).resolves.toMatchObject({
      status: "reconciled",
      expected: [{ status: "corrupt" }],
    });
  });
});
