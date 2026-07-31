import { afterEach, describe, expect, it } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  WorkspaceHistoryStore,
  WorkspaceHistoryStoreError,
  type WorkspaceHistoryMetric,
} from "../src/workspace-history-store";

const temporaryDirectories: string[] = [];

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-history-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function git(cwd: string, args: readonly string[], input?: string): Promise<string> {
  const processHandle = Bun.spawn(["git", "-C", cwd, ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
    },
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args[0] ?? ""} failed: ${stderr}`);
  return stdout;
}

async function createStore(
  root: string,
  options: Partial<ConstructorParameters<typeof WorkspaceHistoryStore>[0]> = {},
): Promise<{ workspace: string; history: string; store: WorkspaceHistoryStore }> {
  const workspace = path.join(root, "workspace");
  const history = path.join(root, "history");
  await mkdir(workspace);
  const store = new WorkspaceHistoryStore({
    cwd: workspace,
    historyRoot: history,
    workspaceId: "workspace-01",
    namespaceId: "namespace-01",
    databasePathHash: "database-hash-01",
    ...options,
  });
  return { workspace, history, store };
}

async function captured(store: WorkspaceHistoryStore) {
  const result = await store.capture();
  expect(result.status).toBe("captured");
  if (result.status !== "captured") throw new Error(`capture skipped: ${result.reason}`);
  return result;
}

async function restoreFromCurrent(store: WorkspaceHistoryStore, targetRootTreeOid: string) {
  const current = await captured(store);
  return await store.restore(targetRootTreeOid, {
    status: "captured",
    rootTreeOid: current.rootTreeOid,
  });
}

function restoreTempNames(entries: readonly string[]): string[] {
  return entries.filter((name) => name.startsWith(".mini-lilac-restore-"));
}

async function runArtifactCrash(params: {
  root: string;
  workspace: string;
  history: string;
  workspaceId: string;
  rootTreeOid: string;
  role: string;
  replaceWithCollision?: boolean;
}): Promise<number> {
  const childScript = path.join(params.root, `crash-${params.role}.ts`);
  const moduleUrl = new URL("../src/workspace-history-store.ts", import.meta.url).href;
  await Bun.write(
    childScript,
    `import { rm, writeFile } from "node:fs/promises";\n` +
      `import { WorkspaceHistoryStore } from ${JSON.stringify(moduleUrl)};\n` +
      `const store = new WorkspaceHistoryStore({ ...${JSON.stringify({
        cwd: params.workspace,
        historyRoot: params.history,
        workspaceId: params.workspaceId,
        namespaceId: "namespace-01",
        databasePathHash: "database-hash-01",
      })}, testHooks: { afterArtifactCreateBeforeIdentity: async (role, artifactPath) => {\n` +
      `  if (role !== ${JSON.stringify(params.role)}) return;\n` +
      (params.replaceWithCollision
        ? `  await rm(artifactPath, { recursive: true, force: true });\n  await writeFile(artifactPath, "unowned-intent-collision\\n");\n`
        : "") +
      `  process.exit(92);\n` +
      `} } });\n` +
      `const current = await store.capture();\n` +
      `if (current.status !== "captured") throw new Error("capture unavailable");\n` +
      `await store.restore(${JSON.stringify(params.rootTreeOid)}, { status: "captured", rootTreeOid: current.rootTreeOid });\n`,
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
  return exitCode;
}

async function runApplySeamCrash(params: {
  root: string;
  workspace: string;
  history: string;
  workspaceId: string;
  rootTreeOid: string;
  hook: "afterLiveDeletion" | "afterPublication" | "beforeFinalVerification";
}): Promise<number> {
  const childScript = path.join(params.root, `crash-${params.hook}.ts`);
  const moduleUrl = new URL("../src/workspace-history-store.ts", import.meta.url).href;
  await Bun.write(
    childScript,
    `import { WorkspaceHistoryStore } from ${JSON.stringify(moduleUrl)};\n` +
      `const store = new WorkspaceHistoryStore({ ...${JSON.stringify({
        cwd: params.workspace,
        historyRoot: params.history,
        workspaceId: params.workspaceId,
        namespaceId: "namespace-01",
        databasePathHash: "database-hash-01",
      })}, testHooks: { ${params.hook}: () => process.exit(93) } });\n` +
      `const current = await store.capture();\n` +
      `if (current.status !== "captured") throw new Error("capture unavailable");\n` +
      `await store.restore(${JSON.stringify(params.rootTreeOid)}, { status: "captured", rootTreeOid: current.rootTreeOid });\n`,
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
  return exitCode;
}

async function runDurablePlanCrash(params: {
  root: string;
  workspace: string;
  history: string;
  workspaceId: string;
  rootTreeOid: string;
  operationId: string;
  protectedPath: string;
}): Promise<number> {
  const childScript = path.join(params.root, `durable-crash-${params.operationId}.ts`);
  const moduleUrl = new URL("../src/workspace-history-store.ts", import.meta.url).href;
  await Bun.write(
    childScript,
    `import { WorkspaceHistoryStore } from ${JSON.stringify(moduleUrl)};\n` +
      `const store = new WorkspaceHistoryStore({ ...${JSON.stringify({
        cwd: params.workspace,
        historyRoot: params.history,
        workspaceId: params.workspaceId,
        namespaceId: "namespace-01",
        databasePathHash: "database-hash-01",
        protectedPaths: [params.protectedPath],
      })}, testHooks: { afterPublication: (relativePath) => { if (relativePath === ".gitignore") process.exit(94); } } });\n` +
      `await store.withWorkspaceLock(async (locked) => {\n` +
      `  const current = await locked.capture();\n` +
      `  if (current.status !== "captured") throw new Error("capture unavailable");\n` +
      `  const prepared = await locked.prepareRestore(${JSON.stringify(params.rootTreeOid)}, { status: "captured", rootTreeOid: current.rootTreeOid }, ${JSON.stringify(params.operationId)});\n` +
      `  if (prepared.status !== "prepared") throw new Error("prepare unavailable");\n` +
      `  await prepared.plan.apply();\n` +
      `});\n`,
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
  return exitCode;
}

describe("WorkspaceHistoryStore", () => {
  it("captures and restores a non-Git workspace with hierarchical .gitignore rules", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    await mkdir(path.join(workspace, "build", "keep"), { recursive: true });
    await mkdir(path.join(workspace, "src", "generated"), { recursive: true });
    await writeFile(path.join(workspace, ".gitignore"), "build/\nsrc/generated/*.tmp\n");
    await writeFile(path.join(workspace, "src", ".gitignore"), "*.log\n");
    await writeFile(path.join(workspace, "source.txt"), "before\n");
    await writeFile(path.join(workspace, "src", "managed.txt"), "managed-before\n");
    await writeFile(path.join(workspace, "src", "ignored.log"), "ignored-before\n");
    await writeFile(path.join(workspace, "src", "generated", "cache.tmp"), "cache-before\n");
    await writeFile(path.join(workspace, "build", "keep", "artifact.bin"), "artifact-before\n");

    const first = await captured(store);
    await writeFile(path.join(workspace, "source.txt"), "after\n");
    await rm(path.join(workspace, "src", "managed.txt"));
    await writeFile(path.join(workspace, "added.txt"), "added\n");
    await writeFile(path.join(workspace, "src", "ignored.log"), "ignored-after\n");
    await writeFile(path.join(workspace, "src", "generated", "cache.tmp"), "cache-after\n");
    await writeFile(path.join(workspace, "build", "keep", "artifact.bin"), "artifact-after\n");

    expect(await restoreFromCurrent(store, first.rootTreeOid)).toEqual({ status: "restored" });
    expect(await readFile(path.join(workspace, "source.txt"), "utf8")).toBe("before\n");
    expect(await readFile(path.join(workspace, "src", "managed.txt"), "utf8")).toBe(
      "managed-before\n",
    );
    expect(await lstat(path.join(workspace, "added.txt")).catch(() => undefined)).toBeUndefined();
    expect(await readFile(path.join(workspace, "src", "ignored.log"), "utf8")).toBe(
      "ignored-after\n",
    );
    expect(await readFile(path.join(workspace, "src", "generated", "cache.tmp"), "utf8")).toBe(
      "cache-after\n",
    );
    expect(await readFile(path.join(workspace, "build", "keep", "artifact.bin"), "utf8")).toBe(
      "artifact-after\n",
    );
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

  it("restores add, modify, delete, binary, executable, symlink, and type transitions", async () => {
    const root = await temporaryDirectory();
    const { workspace, store } = await createStore(root);
    await mkdir(path.join(workspace, "directory-to-file"));
    await writeFile(path.join(workspace, "directory-to-file", "child.txt"), "child-a\n");
    await writeFile(path.join(workspace, "file-to-directory"), "file-a\n");
    await writeFile(path.join(workspace, "modified.txt"), "version-a\n");
    await writeFile(path.join(workspace, "deleted-in-b.txt"), "only-a\n");
    await writeFile(path.join(workspace, "binary.bin"), new Uint8Array([0, 1, 2, 0, 255]));
    await writeFile(path.join(workspace, "script.sh"), "#!/bin/sh\necho a\n");
    await chmod(path.join(workspace, "script.sh"), 0o755);
    await symlink("modified.txt", path.join(workspace, "link"));
    const first = await captured(store);

    await rm(path.join(workspace, "directory-to-file"), { recursive: true });
    await writeFile(path.join(workspace, "directory-to-file"), "file-b\n");
    await rm(path.join(workspace, "file-to-directory"));
    await mkdir(path.join(workspace, "file-to-directory"));
    await writeFile(path.join(workspace, "file-to-directory", "child.txt"), "child-b\n");
    await writeFile(path.join(workspace, "modified.txt"), "version-b\n");
    await rm(path.join(workspace, "deleted-in-b.txt"));
    await writeFile(path.join(workspace, "added-in-b.txt"), "only-b\n");
    await writeFile(path.join(workspace, "binary.bin"), new Uint8Array([255, 0, 9, 8, 0]));
    await chmod(path.join(workspace, "script.sh"), 0o644);
    await rm(path.join(workspace, "link"));
    await writeFile(path.join(workspace, "link"), "regular-b\n");
    const second = await captured(store);

    expect(await restoreFromCurrent(store, first.rootTreeOid)).toEqual({ status: "restored" });
    expect((await lstat(path.join(workspace, "directory-to-file"))).isDirectory()).toBe(true);
    expect(await readFile(path.join(workspace, "directory-to-file", "child.txt"), "utf8")).toBe(
      "child-a\n",
    );
    expect(await readFile(path.join(workspace, "file-to-directory"), "utf8")).toBe("file-a\n");
    expect(await readFile(path.join(workspace, "modified.txt"), "utf8")).toBe("version-a\n");
    expect(await readFile(path.join(workspace, "deleted-in-b.txt"), "utf8")).toBe("only-a\n");
    expect(
      await lstat(path.join(workspace, "added-in-b.txt")).catch(() => undefined),
    ).toBeUndefined();
    expect(Array.from(await readFile(path.join(workspace, "binary.bin")))).toEqual([
      0, 1, 2, 0, 255,
    ]);
    expect((await stat(path.join(workspace, "script.sh"))).mode & 0o111).not.toBe(0);
    expect((await lstat(path.join(workspace, "link"))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(workspace, "link"))).toBe("modified.txt");
    expect(await restoreFromCurrent(store, first.rootTreeOid)).toEqual({ status: "restored" });

    expect(await restoreFromCurrent(store, second.rootTreeOid)).toEqual({ status: "restored" });
    expect(await readFile(path.join(workspace, "directory-to-file"), "utf8")).toBe("file-b\n");
    expect((await lstat(path.join(workspace, "file-to-directory"))).isDirectory()).toBe(true);
    expect(await readFile(path.join(workspace, "file-to-directory", "child.txt"), "utf8")).toBe(
      "child-b\n",
    );
    expect(
      await lstat(path.join(workspace, "deleted-in-b.txt")).catch(() => undefined),
    ).toBeUndefined();
    expect(await readFile(path.join(workspace, "added-in-b.txt"), "utf8")).toBe("only-b\n");
    expect(Array.from(await readFile(path.join(workspace, "binary.bin")))).toEqual([
      255, 0, 9, 8, 0,
    ]);
    expect((await stat(path.join(workspace, "script.sh"))).mode & 0o111).toBe(0);
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
    expect(await readdir(workspace)).toEqual([]);
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

  it("ignores ignored FIFOs but rejects a FIFO in the managed set", async () => {
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
    await expect(store.capture()).rejects.toMatchObject({
      code: "workspace-invalid",
      operation: "capture workspace",
    });
  });

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
    const protectedAliasTarget = await captured(sensitiveStore);
    await writeFile(path.join(workspace, "secret", "token.txt"), "protected\n");
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
});
