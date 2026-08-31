import {
  describe,
  expect,
  it,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
  path,
  WorkspaceHistoryStore,
  temporaryDirectory,
  createStore,
  captured,
  restoreFromCurrent,
  restoreTempNames,
  runArtifactCrash,
  runApplySeamCrash,
} from "./workspace-history-test-support";

describe("WorkspaceHistoryStore", () => {
  it("recovers owned crash staging and treats an unowned recognizable name as managed", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "target\n");
    const snapshot = await captured(store);
    await writeFile(path.join(workspace, "file.txt"), "current\n");
    const collisionName = ".mini-lilac-restore-00000000-0000-4000-8000-000000000000";
    const collisionPath = path.join(workspace, collisionName);
    await writeFile(collisionPath, "unowned-collision\n");

    const childScript = path.join(root, "crash-restore.ts");
    const moduleUrl = new URL("../src/workspace-history-store.ts", import.meta.url).href;
    await Bun.write(
      childScript,
      `import { WorkspaceHistoryStore } from ${JSON.stringify(moduleUrl)};\n` +
        `const store = new WorkspaceHistoryStore({ ...${JSON.stringify({
          cwd: workspace,
          historyRoot: history,
          workspaceId: "workspace-01",
          namespaceId: "namespace-01",
          databasePathHash: "database-hash-01",
        })}, testHooks: { afterDestinationStaging: () => process.exit(91) } });\n` +
        `const current = await store.capture();\n` +
        `if (current.status !== "captured") throw new Error("capture unavailable");\n` +
        `await store.restore(${JSON.stringify(snapshot.rootTreeOid)}, { status: "captured", rootTreeOid: current.rootTreeOid });\n`,
    );
    const child = Bun.spawn(["bun", childScript], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, , exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(91);
    expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe("current\n");
    expect(restoreTempNames(await readdir(workspace))).toContain(collisionName);
    expect(restoreTempNames(await readdir(workspace)).length).toBeGreaterThan(1);

    const retryStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
    });
    expect(await restoreFromCurrent(retryStore, snapshot.rootTreeOid)).toEqual({
      status: "restored",
    });
    expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe("target\n");
    expect(await lstat(collisionPath).catch(() => undefined)).toBeUndefined();
    expect(restoreTempNames(await readdir(workspace))).toEqual([]);
  });

  it("recovers create-before-identity crashes for every destination artifact role", async () => {
    const root = await temporaryDirectory();
    const roles = [
      "destination-regular",
      "destination-symlink",
      "replacement-root",
      "hard-link-probe",
    ] as const;
    for (const role of roles) {
      const caseRoot = path.join(root, role);
      const workspace = path.join(caseRoot, "workspace");
      const history = path.join(caseRoot, "history");
      await mkdir(workspace, { recursive: true });
      const workspaceId = `workspace-${role}`;
      const store = new WorkspaceHistoryStore({
        cwd: workspace,
        historyRoot: history,
        workspaceId,
        namespaceId: "namespace-01",
        databasePathHash: "database-hash-01",
      });
      if (role === "destination-symlink") {
        await symlink("target-before", path.join(workspace, "link"));
      } else if (role === "replacement-root") {
        await mkdir(path.join(workspace, "tree"));
        await writeFile(path.join(workspace, "tree", "child.txt"), "target\n");
      } else {
        await writeFile(path.join(workspace, "file.txt"), "target\n");
      }
      const snapshot = await captured(store);
      if (role === "destination-symlink") {
        await rm(path.join(workspace, "link"));
        await symlink("current", path.join(workspace, "link"));
      } else if (role === "replacement-root") {
        await rm(path.join(workspace, "tree"), { recursive: true });
        await writeFile(path.join(workspace, "tree"), "current\n");
      } else {
        await writeFile(path.join(workspace, "file.txt"), "current\n");
      }

      expect(
        await runArtifactCrash({
          root: caseRoot,
          workspace,
          history,
          workspaceId,
          rootTreeOid: snapshot.rootTreeOid,
          role,
        }),
      ).toBe(92);
      if (role === "destination-symlink") {
        expect(await readlink(path.join(workspace, "link"))).toBe("current");
      } else if (role === "replacement-root") {
        expect(await readFile(path.join(workspace, "tree"), "utf8")).toBe("current\n");
      } else {
        expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe("current\n");
      }
      const recoveryStore = new WorkspaceHistoryStore({
        cwd: workspace,
        historyRoot: history,
        workspaceId,
        namespaceId: "namespace-01",
        databasePathHash: "database-hash-01",
      });
      const cleanup = await recoveryStore.cleanupStaleRestoreArtifacts();
      expect(cleanup.removed.length).toBeGreaterThan(0);
      expect(cleanup.preserved).toEqual([]);
      expect(restoreTempNames(await readdir(workspace))).toEqual([]);
      const manifestDirectory = path.join(recoveryStore.storeDirectory, "temp", "live-staging");
      expect((await readdir(manifestDirectory)).filter((name) => name.endsWith(".json"))).toEqual(
        [],
      );
      expect(
        (await readdir(path.join(recoveryStore.storeDirectory, "temp"))).filter((name) =>
          name.startsWith("restore-"),
        ),
      ).toEqual([]);
    }
  });

  it("preserves an unresolved intent collision and retains its manifest for visibility", async () => {
    const root = await temporaryDirectory();
    const { workspace, history, store } = await createStore(root);
    await writeFile(path.join(workspace, "file.txt"), "target\n");
    const snapshot = await captured(store);
    await writeFile(path.join(workspace, "file.txt"), "current\n");
    expect(
      await runArtifactCrash({
        root,
        workspace,
        history,
        workspaceId: "workspace-01",
        rootTreeOid: snapshot.rootTreeOid,
        role: "destination-regular",
        replaceWithCollision: true,
      }),
    ).toBe(92);
    const collision = restoreTempNames(await readdir(workspace));
    expect(collision).toHaveLength(1);
    const collisionPath = path.join(workspace, collision[0] ?? "missing");

    const recoveryStore = new WorkspaceHistoryStore({
      cwd: workspace,
      historyRoot: history,
      workspaceId: "workspace-01",
      namespaceId: "namespace-01",
      databasePathHash: "database-hash-01",
    });
    const cleanup = await recoveryStore.cleanupStaleRestoreArtifacts();
    expect(cleanup.removed).toEqual([]);
    expect(cleanup.preserved).toEqual([collisionPath]);
    expect(await readFile(collisionPath, "utf8")).toBe("unowned-intent-collision\n");
    const manifestDirectory = path.join(recoveryStore.storeDirectory, "temp", "live-staging");
    expect(
      (await readdir(manifestDirectory)).filter((name) => name.endsWith(".json")),
    ).toHaveLength(1);
    expect(
      (await readdir(path.join(recoveryStore.storeDirectory, "temp"))).filter((name) =>
        name.startsWith("restore-"),
      ),
    ).toEqual([]);

    const collisionSnapshot = await captured(recoveryStore);
    expect(collisionSnapshot.managedPathCount).toBe(2);
    expect(await readFile(collisionPath, "utf8")).toBe("unowned-intent-collision\n");
    const visibleAgain = await recoveryStore.cleanupStaleRestoreArtifacts();
    expect(visibleAgain.preserved).toEqual([collisionPath]);
    expect(
      (await readdir(manifestDirectory)).filter((name) => name.endsWith(".json")),
    ).toHaveLength(1);
  });

  it("converges after deletion, publication, and final-verification crashes", async () => {
    const root = await temporaryDirectory();
    const hooks = ["afterLiveDeletion", "afterPublication", "beforeFinalVerification"] as const;
    for (const hook of hooks) {
      const caseRoot = path.join(root, hook);
      const workspace = path.join(caseRoot, "workspace");
      const history = path.join(caseRoot, "history");
      await mkdir(workspace, { recursive: true });
      const workspaceId = `workspace-${hook}`;
      const store = new WorkspaceHistoryStore({
        cwd: workspace,
        historyRoot: history,
        workspaceId,
        namespaceId: "namespace-01",
        databasePathHash: "database-hash-01",
      });
      await writeFile(path.join(workspace, "file.txt"), "target\n");
      const target = await captured(store);
      await writeFile(path.join(workspace, "file.txt"), "current\n");
      expect(
        await runApplySeamCrash({
          root: caseRoot,
          workspace,
          history,
          workspaceId,
          rootTreeOid: target.rootTreeOid,
          hook,
        }),
      ).toBe(93);

      const recoveryStore = new WorkspaceHistoryStore({
        cwd: workspace,
        historyRoot: history,
        workspaceId,
        namespaceId: "namespace-01",
        databasePathHash: "database-hash-01",
      });
      await recoveryStore.cleanupStaleRestoreArtifacts();
      expect(await restoreFromCurrent(recoveryStore, target.rootTreeOid)).toEqual({
        status: "restored",
      });
      expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe("target\n");
      expect(await recoveryStore.verifySnapshot(target.rootTreeOid)).toEqual({
        status: "verified",
      });
      expect(restoreTempNames(await readdir(workspace))).toEqual([]);
    }
  });

  it("does not scan ignored or untracked FIFOs", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    await writeFile(path.join(workspace, ".gitignore"), "ignored.pipe\n");
    const ignoredFifo = path.join(workspace, "ignored.pipe");
    const managedFifo = path.join(workspace, "managed.pipe");
    expect(
      await Bun.spawn(["mkfifo", ignoredFifo], { stdout: "ignore", stderr: "ignore" }).exited,
    ).toBe(0);
    expect((await captured(store)).managedPathCount).toBe(1);
    expect(
      await Bun.spawn(["mkfifo", managedFifo], { stdout: "ignore", stderr: "ignore" }).exited,
    ).toBe(0);
    expect(await store.capture()).toMatchObject({ status: "captured", managedPathCount: 1 });
  });
});
