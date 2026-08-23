import {
  describe,
  expect,
  it,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
  path,
  WorkspaceHistoryOperationAndCleanupFailed,
  WorkspaceHistoryStore,
  WorkspaceHistoryStoreError,
  temporaryDirectory,
  git,
  createStore,
  captured,
} from "./workspace-history-test-support";

describe("WorkspaceHistoryStore", () => {
  it("fails before following an ancestor replaced by a symlink at the mutation seam", async () => {
    const root = await temporaryDirectory();
    let workspace = "";
    let swapped = false;
    const created = await createStore(root, {
      testHooks: {
        beforeMutation: async (relativePath) => {
          if (swapped || relativePath !== "dir/file.txt") return;
          swapped = true;
          await rename(path.join(workspace, "dir"), path.join(workspace, "dir-original"));
          await symlink(path.join(root, "outside"), path.join(workspace, "dir"));
        },
      },
    });
    workspace = created.workspace;
    await mkdir(path.join(workspace, "dir"));
    await mkdir(path.join(root, "outside"));
    await writeFile(path.join(workspace, "dir", "file.txt"), "target\n");
    await writeFile(path.join(root, "outside", "file.txt"), "outside\n");
    const snapshot = await captured(created.store);
    await writeFile(path.join(workspace, "dir", "file.txt"), "current\n");

    const raceCurrent = await captured(created.store);
    await expect(
      created.store.restore(snapshot.rootTreeOid, {
        status: "captured",
        rootTreeOid: raceCurrent.rootTreeOid,
      }),
    ).rejects.toMatchObject({
      code: "restore-conflict",
    });
    expect(await readFile(path.join(root, "outside", "file.txt"), "utf8")).toBe("outside\n");
    expect(await readFile(path.join(workspace, "dir-original", "file.txt"), "utf8")).toBe(
      "current\n",
    );
  });

  it("rejects a history root containing a symlinked path component", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    const realHistory = path.join(root, "real-history");
    const linkedHistory = path.join(root, "linked-history");
    await mkdir(workspace);
    await git(workspace, ["init", "--quiet"]);
    await mkdir(realHistory);
    await symlink(realHistory, linkedHistory);
    const store = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: linkedHistory,
      workspaceId: "workspace-linked-history",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
    });

    await expect(store.capture()).rejects.toMatchObject({
      code: "workspace-invalid",
      operation: "validate path traversal",
    });
  });

  it("reports missing Git and unsupported platforms as typed capabilities without restoring", async () => {
    const root = await temporaryDirectory();
    const { workspace } = await createStore(root);
    await writeFile(path.join(workspace, "untouched.txt"), "untouched\n");

    const missingGit = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: path.join(root, "missing-history"),
      workspaceId: "workspace-missing",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      gitExecutable: path.join(root, "does-not-exist", "git"),
      platform: "linux",
    });
    expect(await missingGit.capability()).toEqual({
      status: "unavailable",
      reason: "git-unavailable",
    });
    expect(await missingGit.capture()).toEqual({ status: "skipped", reason: "git-unavailable" });
    expect(await missingGit.restore("0".repeat(40))).toEqual({
      status: "skipped",
      reason: "git-unavailable",
    });

    const windows = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: path.join(root, "windows-history"),
      workspaceId: "workspace-windows",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      platform: "win32",
    });
    expect(await windows.capability()).toEqual({
      status: "unavailable",
      reason: "platform-unsupported",
    });
    expect(await windows.capture()).toEqual({
      status: "skipped",
      reason: "platform-unsupported",
    });
    expect(await windows.restore("0".repeat(40))).toEqual({
      status: "skipped",
      reason: "platform-unsupported",
    });
    expect(await readFile(path.join(workspace, "untouched.txt"), "utf8")).toBe("untouched\n");
  });

  it("reports malformed, nonzero, and permission Git failures as operational errors", async () => {
    const root = await temporaryDirectory();
    const { workspace } = await createStore(root);
    const malformedGit = path.join(root, "malformed-git");
    const failingGit = path.join(root, "failing-git");
    const forbiddenGit = path.join(root, "forbidden-git");
    await writeFile(malformedGit, "#!/bin/sh\nprintf 'not git\\n'\n");
    await writeFile(failingGit, "#!/bin/sh\nexit 23\n");
    await writeFile(forbiddenGit, "#!/bin/sh\nexit 0\n");
    await chmod(malformedGit, 0o755);
    await chmod(failingGit, 0o755);
    await chmod(forbiddenGit, 0o644);

    const options = {
      cwd: workspace,
      historyRoot: path.join(root, "history-errors"),
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      platform: "linux" as const,
    };
    await expect(
      new WorkspaceHistoryStore({
        ...options,
        workspaceId: "workspace-malformed",
        gitExecutable: malformedGit,
      }).capability(),
    ).rejects.toMatchObject({ code: "malformed-git-output", operation: "probe Git" });
    await expect(
      new WorkspaceHistoryStore({
        ...options,
        workspaceId: "workspace-failing",
        gitExecutable: failingGit,
      }).capability(),
    ).rejects.toMatchObject({ code: "git-command-failed", operation: "probe Git", exitCode: 23 });
    await expect(
      new WorkspaceHistoryStore({
        ...options,
        workspaceId: "workspace-forbidden",
        gitExecutable: forbiddenGit,
      }).capability(),
    ).rejects.toMatchObject({ code: "git-command-failed", operation: "probe Git" });
  });

  it("rejects ownership marker reuse by a different database", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "content\n");
    await captured(store);
    const mismatched = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "different-namespace",
      databasePathHash: "database-hash-01",
    });
    const capture = mismatched.capture();
    await expect(capture).rejects.toBeInstanceOf(WorkspaceHistoryStoreError);
    await expect(capture).rejects.toMatchObject({ code: "ownership-mismatch" });
  });

  it("returns invalid caches as typed Errs without rewriting persisted bytes", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "first\n");
    await captured(store);
    const cachePath = path.join(store.storeDirectory, "capture-cache.json");
    const current = JSON.parse(await readFile(cachePath, "utf8"));
    const cases = [
      {
        serialized: '{"token":"must-not-appear"',
        tag: "WorkspaceHistoryPersistenceMalformed",
        issueCode: "malformed-serialization",
      },
      {
        serialized: JSON.stringify({
          ...current,
          implementationVersion: "must-not-appear-implementation",
        }),
        tag: "WorkspaceHistoryPersistenceUnsupportedVersion",
        issueCode: "unsupported-version",
      },
      {
        serialized: JSON.stringify({ ...current, entries: [] }),
        tag: "WorkspaceHistoryPersistenceCorrupt",
        issueCode: "corrupt-fields",
      },
      {
        serialized: JSON.stringify({ ...current, workspaceId: "different-workspace" }),
        tag: "WorkspaceHistoryPersistenceCorrupt",
        issueCode: "identity-mismatch",
      },
    ] as const;

    for (const fixture of cases) {
      await writeFile(cachePath, fixture.serialized);
      const result = await store.captureResult();
      expect(result).toMatchObject({
        status: "error",
        error: {
          _tag: fixture.tag,
          recordKind: "capture-cache",
          issueCode: fixture.issueCode,
        },
      });
      expect(await readFile(cachePath, "utf8")).toBe(fixture.serialized);
      expect(JSON.stringify(result)).not.toContain("must-not-appear");
    }
  });

  it("does not rewrite a corrupt strict ownership record while reading it", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "first\n");
    await captured(store);
    const markerPath = path.join(store.storeDirectory, "ownership.json");
    const corruptMarker = '{"formatVersion":1,"databasePathHash":"secret-but-corrupt"}\n';
    await writeFile(markerPath, corruptMarker);

    await expect(store.capture()).rejects.toMatchObject({ code: "ownership-mismatch" });
    expect(await readFile(markerPath, "utf8")).toBe(corruptMarker);
  });

  it("does not rewrite newline-less current ownership or snapshot metadata while reading", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "first\n");
    const snapshot = await captured(store);

    const markerPath = path.join(store.storeDirectory, "ownership.json");
    const markerWithoutNewline = (await readFile(markerPath, "utf8")).replace(/\n$/u, "");
    await writeFile(markerPath, markerWithoutNewline);
    await captured(store);
    expect(await readFile(markerPath, "utf8")).toBe(markerWithoutNewline);

    const manifestWithNewline = await git(store.storeDirectory, [
      "cat-file",
      "blob",
      snapshot.manifestBlobOid,
    ]);
    expect(manifestWithNewline.endsWith("\n")).toBe(true);
    const manifestWithoutNewline = manifestWithNewline.replace(/\n$/u, "");
    const manifestBlobOid = (
      await git(store.storeDirectory, ["hash-object", "-w", "--stdin"], manifestWithoutNewline)
    ).trim();
    const rootTreeOid = (
      await git(
        store.storeDirectory,
        ["mktree"],
        `100644 blob ${manifestBlobOid}\tmanifest.json\n` +
          `040000 tree ${snapshot.workspaceTreeOid}\tworkspace\n`,
      )
    ).trim();

    expect(await store.verifySnapshot(rootTreeOid)).toMatchObject({ status: "verified" });
    expect(await git(store.storeDirectory, ["cat-file", "blob", manifestBlobOid])).toBe(
      manifestWithoutNewline,
    );
  });

  it("preserves migrated ownership bytes without a read-time rewrite", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "first\n");
    const snapshot = await captured(store);
    const markerPath = path.join(store.storeDirectory, "ownership.json");
    const current = JSON.parse(await readFile(markerPath, "utf8"));
    const legacy = `${JSON.stringify({ ...current, formatVersion: undefined })}\n`;
    await writeFile(markerPath, legacy);

    expect(await store.objectExistsResult(snapshot.rootTreeOid, "tree")).toMatchObject({
      status: "ok",
      value: true,
    });
    expect(await readFile(markerPath, "utf8")).toBe(legacy);
  });

  it("atomically preserves the prior capture cache when publication fails", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "first\n");
    await captured(store);
    const cachePath = path.join(store.storeDirectory, "capture-cache.json");
    const priorCache = await readFile(cachePath, "utf8");
    await writeFile(path.join(workspace, "file.txt"), "second\n");
    const failing = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        beforePrivateFilePublish: (operation) => {
          if (operation === "write capture cache") throw new Error("publication failed");
        },
      },
    });

    expect(await failing.captureResult()).toMatchObject({
      status: "error",
      error: { code: "filesystem-error", operation: "write capture cache" },
    });
    expect(await readFile(cachePath, "utf8")).toBe(priorCache);
    expect((await readdir(store.storeDirectory)).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );

    const combinedStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        beforePrivateFilePublish: (operation) => {
          if (operation === "write capture cache") throw new Error("publication failed again");
        },
        beforePrivateFileCleanup: (operation) => {
          if (operation === "write capture cache") throw new Error("temporary cleanup failed");
        },
      },
    });
    const combined = await combinedStore.captureResult();
    expect(combined.status).toBe("error");
    if (combined.status === "error") {
      expect(combined.error).toBeInstanceOf(WorkspaceHistoryOperationAndCleanupFailed);
      if (combined.error instanceof WorkspaceHistoryOperationAndCleanupFailed) {
        expect(combined.error.primary.operation).toBe("write capture cache");
        expect(combined.error.cleanup.failures).toHaveLength(1);
      }
    }
    expect(await readFile(cachePath, "utf8")).toBe(priorCache);
    expect((await readdir(store.storeDirectory)).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("refuses to publish or remove a capture-cache temporary replaced before publication", async () => {
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
        beforePrivateFilePublish: async (operation, temporaryPath) => {
          if (operation !== "write capture cache") return;
          replacementPath = temporaryPath;
          await rm(temporaryPath);
          await writeFile(temporaryPath, "unowned replacement\n");
        },
      },
    });

    const result = await failing.captureResult();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBeInstanceOf(WorkspaceHistoryOperationAndCleanupFailed);
      if (result.error instanceof WorkspaceHistoryOperationAndCleanupFailed) {
        expect(result.error.primary).toMatchObject({
          code: "ownership-mismatch",
          operation: "write capture cache",
        });
        expect(result.error.cleanup.failures).toEqual([
          expect.objectContaining({
            code: "ownership-mismatch",
            operation: "write capture cache",
          }),
        ]);
      }
    }
    expect(replacementPath).toBeDefined();
    if (replacementPath) {
      expect(await readFile(replacementPath, "utf8")).toBe("unowned replacement\n");
    }
    expect(await readFile(cachePath, "utf8")).toBe(priorCache);
  });

  it("preserves the prior cache when its validated source name is replaced by rename", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "first\n");
    await captured(store);
    const cachePath = path.join(store.storeDirectory, "capture-cache.json");
    const priorCache = await readFile(cachePath, "utf8");
    await writeFile(path.join(workspace, "file.txt"), "second\n");
    let replacementPath: string | undefined;
    let displacedPath: string | undefined;
    const failing = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        beforePrivateFilePublish: async (operation, temporaryPath) => {
          if (operation !== "write capture cache") return;
          replacementPath = temporaryPath;
          displacedPath = `${temporaryPath}.displaced`;
          await rename(temporaryPath, displacedPath);
          await writeFile(temporaryPath, "unowned replacement\n");
        },
      },
    });

    const result = await failing.captureResult();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBeInstanceOf(WorkspaceHistoryOperationAndCleanupFailed);
    }
    expect(replacementPath).toBeDefined();
    expect(displacedPath).toBeDefined();
    if (replacementPath) {
      expect(await readFile(replacementPath, "utf8")).toBe("unowned replacement\n");
    }
    if (displacedPath) expect(await lstat(displacedPath)).toBeDefined();
    expect(await readFile(cachePath, "utf8")).toBe(priorCache);
  });

  it("preserves a replacement installed at the final cleanup seam", async () => {
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
        beforePrivateFilePublish: (operation) => {
          if (operation === "write capture cache") throw new Error("publication failed");
        },
        beforePrivateFileCleanup: async (operation, temporaryPath) => {
          if (operation !== "write capture cache") return;
          replacementPath = temporaryPath;
          const operationDirectory = path.dirname(temporaryPath);
          await rename(operationDirectory, `${operationDirectory}.displaced`);
          await mkdir(operationDirectory, { mode: 0o700 });
          await writeFile(temporaryPath, "cleanup replacement\n");
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
      expect(await readFile(replacementPath, "utf8")).toBe("cleanup replacement\n");
    }
    expect(await readFile(cachePath, "utf8")).toBe(priorCache);
  });

  it("preserves a directory replacement installed by a throwing cleanup seam", async () => {
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
        beforePrivateFilePublish: (operation) => {
          if (operation === "write capture cache") throw new Error("publication failed");
        },
        beforePrivateFileCleanup: async (operation, temporaryPath) => {
          if (operation !== "write capture cache") return;
          replacementPath = temporaryPath;
          const operationDirectory = path.dirname(temporaryPath);
          await rename(operationDirectory, `${operationDirectory}.throwing-displaced`);
          await mkdir(operationDirectory, { mode: 0o700 });
          await writeFile(temporaryPath, "throwing cleanup replacement\n");
          throw new Error("cleanup seam failed after replacement");
        },
      },
    });

    const result = await failing.captureResult();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBeInstanceOf(WorkspaceHistoryOperationAndCleanupFailed);
      if (result.error instanceof WorkspaceHistoryOperationAndCleanupFailed) {
        expect(result.error.cleanup.failures).toHaveLength(1);
      }
    }
    expect(replacementPath).toBeDefined();
    if (replacementPath) {
      expect(await readFile(replacementPath, "utf8")).toBe("throwing cleanup replacement\n");
    }
    expect(await readFile(cachePath, "utf8")).toBe(priorCache);
  });

  it("refuses to publish or remove snapshot metadata replaced before publication", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "first\n");
    await captured(store);
    await writeFile(path.join(workspace, "file.txt"), "second\n");
    let replacementPath: string | undefined;
    let metadataPath: string | undefined;
    const failing = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        beforePrivateFilePublish: async (operation, temporaryPath, targetPath) => {
          if (operation !== "write snapshot-ref metadata") return;
          replacementPath = temporaryPath;
          metadataPath = targetPath;
          await rm(temporaryPath);
          await writeFile(temporaryPath, "unowned replacement\n");
        },
      },
    });

    const result = await failing.captureResult();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBeInstanceOf(WorkspaceHistoryOperationAndCleanupFailed);
    }
    expect(replacementPath).toBeDefined();
    expect(metadataPath).toBeDefined();
    if (replacementPath) {
      expect(await readFile(replacementPath, "utf8")).toBe("unowned replacement\n");
    }
    if (metadataPath) {
      expect(await lstat(metadataPath).catch(() => undefined)).toBeUndefined();
    }
  });

  it("refuses to publish or remove a private control temporary replaced before publication", async () => {
    const root = await temporaryDirectory();
    const { workspace, history } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "content\n");
    let replacementPath: string | undefined;
    let controlPath: string | undefined;
    const failing = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        beforePrivateFilePublish: async (operation, temporaryPath, targetPath) => {
          if (operation !== "write private control file") return;
          replacementPath = temporaryPath;
          controlPath = targetPath;
          await rm(temporaryPath);
          await writeFile(temporaryPath, "unowned replacement\n");
        },
      },
    });

    const result = await failing.captureResult();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBeInstanceOf(WorkspaceHistoryOperationAndCleanupFailed);
    }
    expect(replacementPath).toBeDefined();
    expect(controlPath).toBeDefined();
    if (replacementPath) {
      expect(await readFile(replacementPath, "utf8")).toBe("unowned replacement\n");
    }
    if (controlPath) {
      expect(await lstat(controlPath).catch(() => undefined)).toBeUndefined();
    }
  });

  it("refuses to publish or remove restore metadata temporaries replaced before publication", async () => {
    for (const operation of [
      "write restore ownership manifest",
      "write durable restore plan",
    ] as const) {
      const root = await temporaryDirectory();
      const workspace = path.join(root, "workspace");
      const history = path.join(root, "history");
      const protectedPath = path.join(workspace, "journal.db");
      await mkdir(workspace);
      await writeFile(path.join(workspace, "file.txt"), "target\n");
      await writeFile(protectedPath, "journal\n");
      const store = new WorkspaceHistoryStore({
        cwd: workspace,
        historyRoot: history,
        workspaceId: `workspace-${operation.replaceAll(" ", "-")}`,
        namespaceId: "namespace-01",
        databasePathHash: "database-hash-01",
        protectedPaths: [protectedPath],
      });
      const target = await captured(store);
      await writeFile(path.join(workspace, "file.txt"), "source\n");
      const source = await captured(store);
      let replacementPath: string | undefined;
      let targetPath: string | undefined;
      const failing = new WorkspaceHistoryStore({
        cwd: workspace,
        historyRoot: history,
        workspaceId: `workspace-${operation.replaceAll(" ", "-")}`,
        namespaceId: "namespace-01",
        databasePathHash: "database-hash-01",
        protectedPaths: [protectedPath],
        testHooks: {
          beforePrivateFilePublish: async (
            candidateOperation,
            temporaryPath,
            candidateTargetPath,
          ) => {
            if (candidateOperation !== operation || replacementPath) return;
            replacementPath = temporaryPath;
            targetPath = candidateTargetPath;
            await rm(temporaryPath);
            await writeFile(temporaryPath, "unowned replacement\n");
          },
        },
      });

      const result = await failing.withWorkspaceLockResult(
        async (lockedStore) =>
          await lockedStore.prepareRestore(
            target.rootTreeOid,
            { status: "captured", rootTreeOid: source.rootTreeOid },
            "atomic-plan",
          ),
      );
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error).toBeInstanceOf(WorkspaceHistoryOperationAndCleanupFailed);
      }
      expect(replacementPath).toBeDefined();
      expect(targetPath).toBeDefined();
      if (replacementPath) {
        expect(await readFile(replacementPath, "utf8")).toBe("unowned replacement\n");
      }
      if (targetPath) {
        expect(await lstat(targetPath).catch(() => undefined)).toBeUndefined();
      }
    }
  });

  it("preserves restore metadata replacements installed at the final cleanup seam", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    const history = path.join(root, "history");
    const protectedPath = path.join(workspace, "journal.db");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "file.txt"), "target\n");
    await writeFile(protectedPath, "journal\n");
    const store = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-cleanup-seam",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      protectedPaths: [protectedPath],
    });
    const target = await captured(store);
    await writeFile(path.join(workspace, "file.txt"), "source\n");
    const source = await captured(store);
    let replacementPath: string | undefined;
    const failing = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-cleanup-seam",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      protectedPaths: [protectedPath],
      testHooks: {
        beforePrivateFilePublish: (operation) => {
          if (operation === "write durable restore plan") throw new Error("publication failed");
        },
        beforePrivateFileCleanup: async (operation, temporaryPath) => {
          if (operation !== "write durable restore plan") return;
          replacementPath = temporaryPath;
          await writeFile(temporaryPath, "cleanup replacement\n");
        },
      },
    });

    const result = await failing.withWorkspaceLockResult(
      async (lockedStore) =>
        await lockedStore.prepareRestore(
          target.rootTreeOid,
          { status: "captured", rootTreeOid: source.rootTreeOid },
          "cleanup-seam-plan",
        ),
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBeInstanceOf(WorkspaceHistoryOperationAndCleanupFailed);
    }
    expect(replacementPath).toBeDefined();
    if (replacementPath) {
      expect(await readFile(replacementPath, "utf8")).toBe("cleanup replacement\n");
    }
  });
});
