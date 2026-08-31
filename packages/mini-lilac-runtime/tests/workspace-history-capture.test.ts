import {
  type WorkspaceHistoryMetric,
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
  symlink,
  writeFile,
  path,
  createWorkspaceHistoryStore,
  temporaryDirectory,
  git,
  createStore,
  captured,
  restoreFromCurrent,
} from "./workspace-history-test-support";

describe("WorkspaceHistoryStore", () => {
  it("returns owned constructor validation failures", async () => {
    const root = await temporaryDirectory();
    const invalid = createWorkspaceHistoryStore({
      cwd: path.join(root, "workspace"),
      historyRoot: path.join(root, "history"),
      workspaceId: "../unsafe",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
    });

    expect(invalid).toMatchObject({
      status: "error",
      error: { code: "workspace-invalid", operation: "construct store" },
    });
  });

  it("skips non-Git workspaces before initializing the private store", async () => {
    const root = await temporaryDirectory();
    const metrics: WorkspaceHistoryMetric[] = [];
    const { workspace, history, store } = await createStore(
      root,
      {
        onMetric: (metric) => {
          metrics.push(metric);
        },
      },
      false,
    );
    await mkdir(path.join(workspace, "large", "nested"), { recursive: true });
    await writeFile(path.join(workspace, "large", "nested", "secret.txt"), "secret\n");

    expect(await store.capture()).toEqual({ status: "skipped", reason: "non-git-workspace" });
    expect(metrics.find((metric) => metric.type === "capture")).toMatchObject({
      outcome: "skipped",
      candidatePathCount: 0,
      managedPathCount: 0,
      payloadBytes: 0n,
    });
    expect(await lstat(history).catch(() => undefined)).toBeUndefined();

    await git(workspace, ["init", "--quiet"]);
    expect((await captured(store)).managedPathCount).toBe(1);
  });

  it("treats a bare repository as outside a Git worktree", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root, {}, false);
    await git(workspace, ["init", "--bare", "--quiet"]);

    expect(await store.capture()).toEqual({ status: "skipped", reason: "non-git-workspace" });
    expect(await lstat(history).catch(() => undefined)).toBeUndefined();
  });

  it("does not mutate a dirty source repository and keeps tracked-but-ignored files managed", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    await git(workspace, ["init", "--quiet"]);
    await writeFile(path.join(workspace, ".gitignore"), "*.ignored\n");
    await writeFile(
      path.join(workspace, ".gitattributes"),
      "filtered.dat filter=hostile text eol=crlf\n",
    );
    await writeFile(path.join(workspace, "filtered.dat"), new Uint8Array([0, 10, 255, 13, 10]));
    await writeFile(path.join(workspace, "tracked.ignored"), "tracked-before\n");
    await writeFile(path.join(workspace, "tracked.txt"), "index-version\n");
    await git(workspace, [
      "add",
      ".gitattributes",
      ".gitignore",
      "filtered.dat",
      "tracked.ignored",
      "tracked.txt",
      "--force",
    ]);
    await git(workspace, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "base",
    ]);
    const filterMarker = path.join(root, "filter-ran");
    const filterScript = path.join(root, "hostile-filter.sh");
    await writeFile(filterScript, `#!/bin/sh\ntouch '${filterMarker}'\ncat\n`);
    await chmod(filterScript, 0o755);
    await git(workspace, ["config", "filter.hostile.clean", filterScript]);
    await git(workspace, ["config", "filter.hostile.required", "true"]);
    await writeFile(path.join(workspace, "tracked.txt"), "dirty-worktree\n");
    await writeFile(path.join(workspace, "untracked.txt"), "untracked-before\n");
    await writeFile(path.join(workspace, "private.ignored"), "ignored-before\n");

    const indexPath = path.join(workspace, ".git", "index");
    const indexBefore = await readFile(indexPath);
    const configBefore = await readFile(path.join(workspace, ".git", "config"));
    const refsBefore = await git(workspace, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const objectsBefore = await git(workspace, ["count-objects", "-v"]);
    const statusBefore = await git(workspace, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    await rm(filterMarker, { force: true });
    const gitEntriesBefore = (await readdir(path.join(workspace, ".git"))).sort();

    const snapshot = await captured(store);

    expect(await lstat(filterMarker).catch(() => undefined)).toBeUndefined();
    expect(await readFile(indexPath)).toEqual(indexBefore);
    expect(await readFile(path.join(workspace, ".git", "config"))).toEqual(configBefore);
    expect(await git(workspace, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(
      refsBefore,
    );
    expect(await git(workspace, ["count-objects", "-v"])).toBe(objectsBefore);
    expect(await git(workspace, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(
      statusBefore,
    );
    expect((await readdir(path.join(workspace, ".git"))).sort()).toEqual(gitEntriesBefore);

    await writeFile(path.join(workspace, "tracked.ignored"), "tracked-after\n");
    await writeFile(path.join(workspace, "filtered.dat"), new Uint8Array([9, 9, 9]));
    await writeFile(path.join(workspace, "private.ignored"), "ignored-after\n");
    await rm(path.join(workspace, "untracked.txt"));
    expect(await restoreFromCurrent(store, snapshot.rootTreeOid)).toEqual({ status: "restored" });
    expect(await readFile(path.join(workspace, "tracked.ignored"), "utf8")).toBe(
      "tracked-before\n",
    );
    expect(Array.from(await readFile(path.join(workspace, "filtered.dat")))).toEqual([
      0, 10, 255, 13, 10,
    ]);
    expect(await readFile(path.join(workspace, "private.ignored"), "utf8")).toBe("ignored-after\n");
    expect(await readFile(path.join(workspace, "untracked.txt"), "utf8")).toBe(
      "untracked-before\n",
    );
    expect(await readFile(indexPath)).toEqual(indexBefore);
    expect(await readFile(path.join(workspace, ".git", "config"))).toEqual(configBefore);
    expect(await git(workspace, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(
      refsBefore,
    );
    expect(await git(workspace, ["count-objects", "-v"])).toBe(objectsBefore);
    expect(await git(workspace, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(
      statusBefore,
    );
    expect((await readdir(path.join(workspace, ".git"))).sort()).toEqual(gitEntriesBefore);
  });

  it("does not recursively scan ignored directories when capturing a Git workspace", async () => {
    const root = await temporaryDirectory();
    const metrics: WorkspaceHistoryMetric[] = [];
    const { workspace, store } = await createStore(root, {
      onMetric: (metric) => {
        metrics.push(metric);
      },
    });
    await git(workspace, ["init", "--quiet"]);
    await mkdir(path.join(workspace, "ignored"));
    await writeFile(path.join(workspace, ".gitignore"), "ignored/\n");
    await writeFile(path.join(workspace, "tracked.txt"), "tracked\n");
    await git(workspace, ["add", ".gitignore", "tracked.txt"]);
    for (let index = 0; index < 100; index += 1) {
      await writeFile(path.join(workspace, "ignored", `artifact-${index}.txt`), "ignored\n");
    }

    await captured(store);

    expect(metrics.find((metric) => metric.type === "capture")).toMatchObject({
      candidatePathCount: 3,
      managedPathCount: 2,
      outcome: "captured",
    });
  });

  it("captures Git directory-to-file transitions without traversing stale index paths", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    await git(workspace, ["init", "--quiet"]);
    await mkdir(path.join(workspace, "entry"));
    await writeFile(path.join(workspace, "entry", "child.txt"), "child\n");
    await git(workspace, ["add", "entry/child.txt"]);
    const directorySnapshot = await captured(store);

    await rm(path.join(workspace, "entry"), { recursive: true });
    await writeFile(path.join(workspace, "entry"), "file\n");

    expect((await captured(store)).managedPathCount).toBe(1);
    expect(await restoreFromCurrent(store, directorySnapshot.rootTreeOid)).toEqual({
      status: "restored",
    });
    expect(await readFile(path.join(workspace, "entry", "child.txt"), "utf8")).toBe("child\n");
  });

  it("does not traverse a symlink that replaces a tracked directory", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    const external = path.join(root, "external");
    await git(workspace, ["init", "--quiet"]);
    await mkdir(path.join(workspace, "entry"));
    await mkdir(external);
    await writeFile(path.join(workspace, "entry", "child.txt"), "inside\n");
    await writeFile(path.join(external, "child.txt"), "outside\n");
    await git(workspace, ["add", "entry/child.txt"]);

    await rm(path.join(workspace, "entry"), { recursive: true });
    await symlink(external, path.join(workspace, "entry"));
    const snapshot = await captured(store);

    expect(snapshot.managedPathCount).toBe(1);
    await rm(path.join(workspace, "entry"));
    expect(await restoreFromCurrent(store, snapshot.rootTreeOid)).toEqual({ status: "restored" });
    expect(await readlink(path.join(workspace, "entry"))).toBe(external);
    expect(await readFile(path.join(external, "child.txt"), "utf8")).toBe("outside\n");
  });
});
