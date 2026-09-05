import {
  describe,
  expect,
  it,
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
  path,
  WorkspaceHistoryStore,
  temporaryDirectory,
  git,
  createStore,
  captured,
  restoreFromCurrent,
  restoreTempNames,
} from "./workspace-history-test-support";

describe("WorkspaceHistoryStore", () => {
  it("restores added, modified, deleted, binary, and executable files", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    await writeFile(path.join(workspace, "modified.txt"), "version-a\n");
    await writeFile(path.join(workspace, "deleted-in-b.txt"), "only-a\n");
    await writeFile(path.join(workspace, "binary.bin"), new Uint8Array([0, 1, 2, 0, 255]));
    await writeFile(path.join(workspace, "script.sh"), "#!/bin/sh\necho a\n");
    await chmod(path.join(workspace, "script.sh"), 0o755);
    const first = await captured(store);

    await writeFile(path.join(workspace, "modified.txt"), "version-b\n");
    await rm(path.join(workspace, "deleted-in-b.txt"));
    await writeFile(path.join(workspace, "added-in-b.txt"), "only-b\n");
    await writeFile(path.join(workspace, "binary.bin"), new Uint8Array([255, 0, 9, 8, 0]));
    await chmod(path.join(workspace, "script.sh"), 0o644);
    const second = await captured(store);

    expect(await restoreFromCurrent(store, first.rootTreeOid)).toEqual({ status: "restored" });
    expect(await readFile(path.join(workspace, "modified.txt"), "utf8")).toBe("version-a\n");
    expect(await readFile(path.join(workspace, "deleted-in-b.txt"), "utf8")).toBe("only-a\n");
    expect(
      await lstat(path.join(workspace, "added-in-b.txt")).catch(() => undefined),
    ).toBeUndefined();
    expect(Array.from(await readFile(path.join(workspace, "binary.bin")))).toEqual([
      0, 1, 2, 0, 255,
    ]);
    expect((await stat(path.join(workspace, "script.sh"))).mode & 0o111).not.toBe(0);
    expect(await restoreFromCurrent(store, first.rootTreeOid)).toEqual({ status: "restored" });

    expect(await restoreFromCurrent(store, second.rootTreeOid)).toEqual({ status: "restored" });
    expect(await readFile(path.join(workspace, "modified.txt"), "utf8")).toBe("version-b\n");
    expect(
      await lstat(path.join(workspace, "deleted-in-b.txt")).catch(() => undefined),
    ).toBeUndefined();
    expect(await readFile(path.join(workspace, "added-in-b.txt"), "utf8")).toBe("only-b\n");
    expect(Array.from(await readFile(path.join(workspace, "binary.bin")))).toEqual([
      255, 0, 9, 8, 0,
    ]);
    expect((await stat(path.join(workspace, "script.sh"))).mode & 0o111).toBe(0);
  });

  it("restores file, directory, and symlink type transitions", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    await mkdir(path.join(workspace, "directory-to-file"));
    await writeFile(path.join(workspace, "directory-to-file", "child.txt"), "child-a\n");
    await writeFile(path.join(workspace, "file-to-directory"), "file-a\n");
    await symlink("file-to-directory", path.join(workspace, "link"));
    const first = await captured(store);

    await rm(path.join(workspace, "directory-to-file"), { recursive: true });
    await writeFile(path.join(workspace, "directory-to-file"), "file-b\n");
    await rm(path.join(workspace, "file-to-directory"));
    await mkdir(path.join(workspace, "file-to-directory"));
    await writeFile(path.join(workspace, "file-to-directory", "child.txt"), "child-b\n");
    await rm(path.join(workspace, "link"));
    await writeFile(path.join(workspace, "link"), "regular-b\n");
    const second = await captured(store);

    expect(await restoreFromCurrent(store, first.rootTreeOid)).toEqual({ status: "restored" });
    expect((await lstat(path.join(workspace, "directory-to-file"))).isDirectory()).toBe(true);
    expect(await readFile(path.join(workspace, "directory-to-file", "child.txt"), "utf8")).toBe(
      "child-a\n",
    );
    expect(await readFile(path.join(workspace, "file-to-directory"), "utf8")).toBe("file-a\n");
    expect((await lstat(path.join(workspace, "link"))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(workspace, "link"))).toBe("file-to-directory");

    expect(await restoreFromCurrent(store, second.rootTreeOid)).toEqual({ status: "restored" });
    expect(await readFile(path.join(workspace, "directory-to-file"), "utf8")).toBe("file-b\n");
    expect((await lstat(path.join(workspace, "file-to-directory"))).isDirectory()).toBe(true);
    expect(await readFile(path.join(workspace, "file-to-directory", "child.txt"), "utf8")).toBe(
      "child-b\n",
    );
    expect((await lstat(path.join(workspace, "link"))).isFile()).toBe(true);
    expect(await readFile(path.join(workspace, "link"), "utf8")).toBe("regular-b\n");
  });

  it("preserves protected paths and nested Git repository boundaries", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    const history = path.join(workspace, ".mini-lilac-history");
    const protectedDirectory = path.join(workspace, "protected");
    await mkdir(workspace);
    await mkdir(protectedDirectory);
    await mkdir(path.join(workspace, "nested"));
    await git(path.join(workspace, "nested"), ["init", "--quiet"]);
    await writeFile(path.join(workspace, "managed.txt"), "before\n");
    await writeFile(path.join(protectedDirectory, "secret.txt"), "protected-before\n");
    await writeFile(path.join(workspace, "nested", "inside.txt"), "nested-before\n");
    const nestedHead = await readFile(path.join(workspace, "nested", ".git", "HEAD"));
    const store = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      protectedPaths: [protectedDirectory],
    });
    const snapshot = await captured(store);

    await writeFile(path.join(workspace, "managed.txt"), "after\n");
    await writeFile(path.join(protectedDirectory, "secret.txt"), "protected-after\n");
    await writeFile(path.join(workspace, "nested", "inside.txt"), "nested-after\n");
    expect(await restoreFromCurrent(store, snapshot.rootTreeOid)).toEqual({ status: "restored" });
    expect(await readFile(path.join(workspace, "managed.txt"), "utf8")).toBe("before\n");
    expect(await readFile(path.join(protectedDirectory, "secret.txt"), "utf8")).toBe(
      "protected-after\n",
    );
    expect(await readFile(path.join(workspace, "nested", "inside.txt"), "utf8")).toBe(
      "nested-after\n",
    );
    expect(await readFile(path.join(workspace, "nested", ".git", "HEAD"))).toEqual(nestedHead);
    expect(await lstat(store.storeDirectory).then((value) => value.isDirectory())).toBe(true);
    expect((await captured(store)).rootTreeOid).toBe(snapshot.rootTreeOid);
  });

  it("allows exact protected target collisions and freezes protected signatures", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    const history = path.join(root, "history");
    const protectedFile = path.join(workspace, "protected.txt");
    await mkdir(workspace);
    await writeFile(protectedFile, "protected-target\n");
    await writeFile(path.join(workspace, "managed.txt"), "managed-target\n");
    const unprotectedStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-protected-collision",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
    });
    const target = await captured(unprotectedStore);
    const protectedStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-protected-collision",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      protectedPaths: [protectedFile],
    });
    await writeFile(path.join(workspace, "managed.txt"), "managed-current\n");
    const current = await captured(protectedStore);
    expect(
      await protectedStore.restore(target.rootTreeOid, {
        status: "captured",
        rootTreeOid: current.rootTreeOid,
      }),
    ).toEqual({ status: "restored" });
    expect(await readFile(protectedFile, "utf8")).toBe("protected-target\n");
    expect(await readFile(path.join(workspace, "managed.txt"), "utf8")).toBe("managed-target\n");

    await writeFile(protectedFile, "protected-conflict\n");
    const conflictingCurrent = await captured(protectedStore);
    await protectedStore.withWorkspaceLock(async (lockedStore) => {
      await expect(
        lockedStore.prepareRestore(target.rootTreeOid, {
          status: "captured",
          rootTreeOid: conflictingCurrent.rootTreeOid,
        }),
      ).rejects.toMatchObject({ code: "restore-conflict" });
    });

    await writeFile(protectedFile, "protected-target\n");
    await writeFile(path.join(workspace, "managed.txt"), "managed-current-again\n");
    const frozenCurrent = await captured(protectedStore);
    await protectedStore.withWorkspaceLock(async (lockedStore) => {
      const prepared = await lockedStore.prepareRestore(target.rootTreeOid, {
        status: "captured",
        rootTreeOid: frozenCurrent.rootTreeOid,
      });
      expect(prepared.status).toBe("prepared");
      if (prepared.status !== "prepared") return;
      await writeFile(protectedFile, "changed-after-prepare\n");
      await expect(prepared.plan.apply()).rejects.toMatchObject({ code: "restore-conflict" });
    });
    expect(await readFile(path.join(workspace, "managed.txt"), "utf8")).toBe(
      "managed-current-again\n",
    );
  });

  it("reuses identical snapshot OIDs and roots them in a private ref", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    await writeFile(path.join(workspace, "large.dat"), new Uint8Array(1024 * 1024).fill(7));
    const first = await captured(store);
    const objectCountBefore = await git(store.storeDirectory, ["count-objects", "-v"]);
    const second = await captured(store);
    const objectCountAfter = await git(store.storeDirectory, ["count-objects", "-v"]);

    expect(second.rootTreeOid).toBe(first.rootTreeOid);
    expect(second.gitRef).toBe(first.gitRef);
    expect(objectCountAfter).toBe(objectCountBefore);
    expect(await store.objectExists(first.rootTreeOid, "tree")).toBe(true);
    expect(await store.reconcileSnapshotRef(first.rootTreeOid)).toBe("present");
  });

  it("captures and restores an empty managed workspace with an explicit empty subtree", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    const empty = await captured(store);
    expect(empty.managedPathCount).toBe(0);

    await writeFile(path.join(workspace, "later.txt"), "later\n");
    expect(await restoreFromCurrent(store, empty.rootTreeOid)).toEqual({ status: "restored" });
    expect(await readdir(workspace)).toEqual([".git"]);
    expect((await captured(store)).rootTreeOid).toBe(empty.rootTreeOid);
  });

  it("never removes a preexisting ignored colliding-looking restore temp", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    await writeFile(path.join(workspace, ".gitignore"), "*.tmp\n");
    await writeFile(path.join(workspace, "managed.txt"), "before\n");
    const snapshot = await captured(store);
    const collision = path.join(
      workspace,
      `.managed.txt.mini-lilac-restore-${snapshot.rootTreeOid.slice(0, 12)}.tmp`,
    );
    await writeFile(collision, "must-survive\n");
    await writeFile(path.join(workspace, "managed.txt"), "after\n");

    expect(await restoreFromCurrent(store, snapshot.rootTreeOid)).toEqual({ status: "restored" });
    expect(await readFile(collision, "utf8")).toBe("must-survive\n");
    expect(await readFile(path.join(workspace, "managed.txt"), "utf8")).toBe("before\n");
  });

  it("restores a near-name-limit target using a short basename-independent sibling", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    const nearLimitName = "n".repeat(250);
    const targetPath = path.join(workspace, nearLimitName);
    await writeFile(targetPath, "before\n");
    const snapshot = await captured(store);
    await writeFile(targetPath, "after\n");
    const nearLimitCurrent = await captured(store);

    await store.withWorkspaceLock(async (lockedStore) => {
      const entriesBeforePrepare = (await readdir(workspace)).sort();
      const prepared = await lockedStore.prepareRestore(snapshot.rootTreeOid, {
        status: "captured",
        rootTreeOid: nearLimitCurrent.rootTreeOid,
      });
      expect(prepared.status).toBe("prepared");
      if (prepared.status !== "prepared") return;
      expect((await readdir(workspace)).sort()).toEqual(entriesBeforePrepare);
      expect(await prepared.plan.apply()).toEqual({ status: "restored" });
    });
    expect(await readFile(targetPath, "utf8")).toBe("before\n");
    expect(restoreTempNames(await readdir(workspace))).toEqual([]);
  });

  it("round-trips non-UTF-8 symlink target bytes without replacement", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    const target = Buffer.from([0x66, 0x6f, 0x80, 0xff]);
    await symlink(target, path.join(workspace, "byte-link"));
    const snapshot = await captured(store);
    await rm(path.join(workspace, "byte-link"));
    await symlink("different", path.join(workspace, "byte-link"));

    expect(await restoreFromCurrent(store, snapshot.rootTreeOid)).toEqual({ status: "restored" });
    expect(await readlink(path.join(workspace, "byte-link"), { encoding: "buffer" })).toEqual(
      target,
    );
  });

  it("leaves the original workspace intact when destination symlink staging fails", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    const history = path.join(root, "history");
    await mkdir(workspace);
    const initialStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-stage-failure",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
    });
    await symlink("target-before", path.join(workspace, "link"));
    const snapshot = await captured(initialStore);
    await rm(path.join(workspace, "link"));
    await symlink("current-must-survive", path.join(workspace, "link"));

    const failingStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-stage-failure",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        beforeDestinationStage: (relativePath) => {
          if (relativePath === "link")
            throw new Error("injected destination symlink staging failure");
        },
      },
    });
    const failingCurrent = await captured(failingStore);
    await expect(
      failingStore.restore(snapshot.rootTreeOid, {
        status: "captured",
        rootTreeOid: failingCurrent.rootTreeOid,
      }),
    ).rejects.toMatchObject({
      code: "filesystem-error",
      operation: "apply prepared workspace restore",
    });
    expect(await readlink(path.join(workspace, "link"))).toBe("current-must-survive");
    expect(restoreTempNames(await readdir(workspace))).toEqual([]);
  });

  it("fails hard-link validation before removing the original", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    const history = path.join(root, "history");
    await mkdir(workspace);
    const initialStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-link-rejection",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
    });
    await writeFile(path.join(workspace, "file.txt"), "target\n");
    const snapshot = await captured(initialStore);
    await writeFile(path.join(workspace, "file.txt"), "original-must-survive\n");

    const rejectingStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-link-rejection",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        beforeHardLinkValidation: () => {
          throw Object.assign(new Error("hard links unsupported"), { code: "EOPNOTSUPP" });
        },
      },
    });
    const rejectingCurrent = await captured(rejectingStore);
    const entriesBeforeRejection = (await readdir(workspace)).sort();
    await expect(
      rejectingStore.restore(snapshot.rootTreeOid, {
        status: "captured",
        rootTreeOid: rejectingCurrent.rootTreeOid,
      }),
    ).rejects.toMatchObject({
      code: "filesystem-error",
      operation: "prepare workspace restore",
    });
    expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe(
      "original-must-survive\n",
    );
    expect((await readdir(workspace)).sort()).toEqual(entriesBeforeRejection);
    expect(restoreTempNames(await readdir(workspace))).toEqual([]);
  });
});
