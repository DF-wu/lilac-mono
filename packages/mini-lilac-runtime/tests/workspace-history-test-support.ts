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

import { Panic, Result } from "better-result";

import {
  createWorkspaceHistoryStore,
  WorkspaceHistoryCleanupFailed,
  WorkspaceHistoryOperationAndCleanupFailed,
  WorkspaceHistoryStore,
  WorkspaceHistoryStoreError,
  type LockedWorkspaceHistoryStore,
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
  initializeSourceRepository = true,
): Promise<{ workspace: string; history: string; store: WorkspaceHistoryStore }> {
  const workspace = path.join(root, "workspace");
  const history = path.join(root, "history");
  await mkdir(workspace);
  if (initializeSourceRepository) await git(workspace, ["init", "--quiet"]);
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
  if (!(await lstat(path.join(store.cwd, ".git")).catch(() => undefined))) {
    await git(store.cwd, ["init", "--quiet"]);
  }
  const result = await store.capture();
  expect(result.status).toBe("captured");
  if (result.status !== "captured") throw new Error(`capture skipped: ${result.reason}`);
  return result;
}

async function invalidateCaptureCache(store: WorkspaceHistoryStore): Promise<void> {
  const result = await store.withWorkspaceLock(
    async (lockedStore) => await lockedStore.invalidateCaptureCacheResult(),
  );
  expect(result).toMatchObject({ status: "ok" });
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

async function openFileDescriptorTargets(): Promise<readonly string[] | undefined> {
  try {
    return await Promise.all(
      (await readdir("/proc/self/fd")).map(async (descriptor) => {
        try {
          return await readlink(path.join("/proc/self/fd", descriptor));
        } catch {
          return "";
        }
      }),
    );
  } catch {
    return undefined;
  }
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

export {
  describe,
  expect,
  it,
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
  tmpdir,
  path,
  Panic,
  Result,
  createWorkspaceHistoryStore,
  WorkspaceHistoryCleanupFailed,
  WorkspaceHistoryOperationAndCleanupFailed,
  WorkspaceHistoryStore,
  WorkspaceHistoryStoreError,
  temporaryDirectories,
  deferred,
  temporaryDirectory,
  git,
  createStore,
  captured,
  invalidateCaptureCache,
  restoreFromCurrent,
  restoreTempNames,
  openFileDescriptorTargets,
  runArtifactCrash,
  runApplySeamCrash,
  runDurablePlanCrash,
};

export type { LockedWorkspaceHistoryStore, WorkspaceHistoryMetric };
