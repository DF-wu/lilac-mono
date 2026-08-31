import {
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
  temporaryDirectory,
  git,
  captured,
} from "./workspace-history-test-support";

describe("WorkspaceHistoryStore", () => {
  it("retains the capture index and reads only changed regular-file payloads", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    const history = path.join(root, "history");
    const payloadReads: { relativePath: string; bytes: bigint }[] = [];
    await mkdir(workspace);
    await writeFile(path.join(workspace, "small.txt"), "small\n");
    await writeFile(path.join(workspace, "large.bin"), new Uint8Array(2 * 1024 * 1024));
    const store = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-retained-index",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        onCaptureRegularFilePayload: (relativePath, bytes) => {
          payloadReads.push({ relativePath, bytes });
        },
      },
    });
    const first = await captured(store);
    const indexPath = path.join(store.storeDirectory, "capture.index");
    const firstIndex = await lstat(indexPath, { bigint: true });
    const objectCountBefore = await git(store.storeDirectory, ["count-objects", "-v"]);
    payloadReads.length = 0;

    const second = await captured(store);
    const secondIndex = await lstat(indexPath, { bigint: true });
    expect(second.rootTreeOid).toBe(first.rootTreeOid);
    expect(payloadReads).toEqual([]);
    expect(secondIndex.ino).toBe(firstIndex.ino);
    expect(await git(store.storeDirectory, ["count-objects", "-v"])).toBe(objectCountBefore);

    await writeFile(path.join(workspace, "small.txt"), "small changed\n");
    payloadReads.length = 0;
    await captured(store);
    expect(payloadReads).toEqual([{ relativePath: "small.txt", bytes: 14n }]);

    await rm(path.join(workspace, "large.bin"));
    payloadReads.length = 0;
    const afterDelete = await captured(store);
    expect(afterDelete.managedPathCount).toBe(1);
    expect(payloadReads).toEqual([]);
  });

  it("warms the persistent capture state after restoring an unchanged large file", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    const history = path.join(root, "history");
    const payloadReads: string[] = [];
    await mkdir(workspace);
    await writeFile(path.join(workspace, "large.bin"), new Uint8Array(2 * 1024 * 1024));
    await writeFile(path.join(workspace, "small.txt"), "target\n");
    const store = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-post-restore-warm",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        onCaptureRegularFilePayload: (relativePath) => payloadReads.push(relativePath),
      },
    });
    const target = await captured(store);
    await writeFile(path.join(workspace, "small.txt"), "source\n");
    const source = await captured(store);
    payloadReads.length = 0;

    expect(
      await store.restore(target.rootTreeOid, {
        status: "captured",
        rootTreeOid: source.rootTreeOid,
      }),
    ).toEqual({ status: "restored" });
    expect(payloadReads).toEqual([]);
    payloadReads.length = 0;
    const immediate = await captured(store);
    expect(immediate.rootTreeOid).toBe(target.rootTreeOid);
    expect(payloadReads).toEqual([]);
  });

  it("rejects verification-to-cache races and invalidates retained capture state", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    const history = path.join(root, "history");
    const payloadReads: string[] = [];
    let raceEnabled = false;
    await mkdir(workspace);
    await writeFile(path.join(workspace, "file.txt"), "target\n");
    const store = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-post-restore-race",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        afterFinalVerificationBeforeCacheReconciliation: async () => {
          if (!raceEnabled) return;
          raceEnabled = false;
          await writeFile(path.join(workspace, "file.txt"), "raced value\n");
        },
        onCaptureRegularFilePayload: (relativePath) => payloadReads.push(relativePath),
      },
    });
    const target = await captured(store);
    await writeFile(path.join(workspace, "file.txt"), "source\n");
    const source = await captured(store);
    payloadReads.length = 0;
    raceEnabled = true;

    await expect(
      store.restore(target.rootTreeOid, {
        status: "captured",
        rootTreeOid: source.rootTreeOid,
      }),
    ).rejects.toMatchObject({ code: "restore-conflict" });
    expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe("raced value\n");
    expect(
      await lstat(path.join(store.storeDirectory, "capture-cache.json")).catch(() => undefined),
    ).toBeUndefined();
    expect(
      await lstat(path.join(store.storeDirectory, "capture.index")).catch(() => undefined),
    ).toBeUndefined();

    payloadReads.length = 0;
    const raced = await captured(store);
    expect(payloadReads).toEqual(["file.txt"]);
    expect(raced.rootTreeOid).not.toBe(target.rootTreeOid);
  });

  it("hashes only newly managed preserved paths when restored ignore rules expose them", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    const history = path.join(root, "history");
    const payloadReads: string[] = [];
    await mkdir(workspace);
    await writeFile(path.join(workspace, ".gitignore"), "other.txt\n");
    await writeFile(path.join(workspace, "large.bin"), new Uint8Array(2 * 1024 * 1024));
    const store = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-post-restore-exposed",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
      testHooks: {
        onCaptureRegularFilePayload: (relativePath) => payloadReads.push(relativePath),
      },
    });
    const target = await captured(store);
    await writeFile(path.join(workspace, ".gitignore"), "exposed.txt\n");
    await writeFile(path.join(workspace, "exposed.txt"), "preserved\n");
    const source = await captured(store);
    const refsBeforeRestore = await git(store.storeDirectory, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/mini-lilac/snapshots/",
    ]);
    payloadReads.length = 0;

    expect(
      await store.restore(target.rootTreeOid, {
        status: "captured",
        rootTreeOid: source.rootTreeOid,
      }),
    ).toEqual({ status: "restored" });
    expect(payloadReads).toEqual(["exposed.txt"]);
    expect(
      await git(store.storeDirectory, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/mini-lilac/snapshots/",
      ]),
    ).toBe(refsBeforeRestore);
    payloadReads.length = 0;
    const firstImmediate = await captured(store);
    expect(payloadReads).toEqual([]);
    const secondImmediate = await captured(store);
    expect(secondImmediate.rootTreeOid).toBe(firstImmediate.rootTreeOid);
    expect(payloadReads).toEqual([]);
  });
});
