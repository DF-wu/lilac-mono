import fs from "node:fs/promises";
import path from "node:path";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { errorCode, isPanic, opaqueErrorMessage } from "@stanley2058/lilac-utils";

import { projectRuntimeError } from "../runtime/error-format";
import { adaptToolResultToHost, preserveToolPanic } from "../tools/tool-result-adapters";

import {
  MAX_WORKFLOW_SOURCE_BYTES,
  sha256,
  validateWorkflowSourceUnchecked,
  workflowDefinitionNameSchema,
  type ValidatedWorkflowDefinition,
} from "./workflow-definition";
import { compareCodeUnits, workflowScopeSchema, type WorkflowScope } from "./workflow-domain";

export type WorkflowDefinitionScope = WorkflowScope | "auto";

export type ResolvedWorkflowDefinition = {
  scope: WorkflowScope;
  name: string;
  normalizedPath: string;
  canonicalPath: string;
  source: string;
  validation: ValidatedWorkflowDefinition;
};

type WorkflowDefinitionStoreOperation =
  | "create"
  | "get"
  | "save"
  | "list"
  | "create-snapshot"
  | "read-snapshot";

export class WorkflowDefinitionStoreFailed extends TaggedError("WorkflowDefinitionStoreFailed")<{
  readonly operation: WorkflowDefinitionStoreOperation;
  readonly message: string;
}> {}

async function captureWorkflowDefinitionStoreOperation<T>(
  operation: WorkflowDefinitionStoreOperation,
  effect: () => Promise<ResultType<T, WorkflowDefinitionStoreFailed>>,
): Promise<ResultType<T, WorkflowDefinitionStoreFailed>> {
  const [settled] = await Promise.allSettled([effect()]);
  if (settled.status === "rejected") {
    if (isPanic(settled.reason)) preserveToolPanic(settled.reason);
    return Result.err(
      new WorkflowDefinitionStoreFailed({
        operation,
        message: opaqueErrorMessage(settled.reason, `Workflow definition ${operation} failed`),
      }),
    );
  }
  return settled.value;
}

function storeFailure(
  operation: WorkflowDefinitionStoreOperation,
  message: string,
): WorkflowDefinitionStoreFailed {
  return new WorkflowDefinitionStoreFailed({ operation, message });
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function lstatOrNull(target: string) {
  const [stat] = await Promise.allSettled([fs.lstat(target)]);
  if (stat.status === "fulfilled") return stat.value;
  if (isPanic(stat.reason)) preserveToolPanic(stat.reason);
  if (errorCode(stat.reason) === "ENOENT") return null;
  return adaptToolResultToHost(
    Result.err(projectRuntimeError(stat.reason, `Could not inspect workflow path: ${target}`)),
  );
}

async function ensureDirectoryWithoutSymlinks(
  root: string,
  segments: readonly string[],
  operation: WorkflowDefinitionStoreOperation,
): Promise<ResultType<string, WorkflowDefinitionStoreFailed>> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const existing = await lstatOrNull(current);
    if (existing?.isSymbolicLink()) {
      return Result.err(
        storeFailure(operation, `Workflow path cannot contain symlinks: ${current}`),
      );
    }
    if (existing && !existing.isDirectory()) {
      return Result.err(
        storeFailure(operation, `Workflow path component is not a directory: ${current}`),
      );
    }
    if (!existing) await fs.mkdir(current, { mode: 0o700 });
  }
  const canonical = await fs.realpath(current);
  if (!isContained(root, canonical)) {
    return Result.err(
      storeFailure(operation, `Workflow root escapes canonical containment: ${canonical}`),
    );
  }
  return Result.ok(canonical);
}

async function assertDirectorySegmentsWithoutSymlinks(
  root: string,
  segments: readonly string[],
  operation: WorkflowDefinitionStoreOperation,
): Promise<ResultType<string, WorkflowDefinitionStoreFailed>> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const existing = await lstatOrNull(current);
    if (!existing) return Result.ok(path.join(root, ...segments));
    if (existing.isSymbolicLink()) {
      return Result.err(
        storeFailure(operation, `Workflow path cannot contain symlinks: ${current}`),
      );
    }
    if (!existing.isDirectory()) {
      return Result.err(
        storeFailure(operation, `Workflow path component is not a directory: ${current}`),
      );
    }
  }
  return Result.ok(current);
}

async function canonicalDirectory(
  target: string,
  operation: WorkflowDefinitionStoreOperation,
): Promise<ResultType<string, WorkflowDefinitionStoreFailed>> {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(target);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return Result.err(storeFailure(operation, `Workflow base must be a real directory: ${target}`));
  }
  return Result.ok(await fs.realpath(target));
}

async function readBoundedRegularFile(
  filePath: string,
  operation: WorkflowDefinitionStoreOperation,
): Promise<ResultType<{ source: string; canonicalPath: string }, WorkflowDefinitionStoreFailed>> {
  const stats = await fs.lstat(filePath);
  if (stats.isSymbolicLink()) {
    return Result.err(
      storeFailure(operation, `Workflow definition cannot be a symlink: ${filePath}`),
    );
  }
  if (!stats.isFile()) {
    return Result.err(
      storeFailure(operation, `Workflow definition is not a regular file: ${filePath}`),
    );
  }
  if (stats.size > MAX_WORKFLOW_SOURCE_BYTES) {
    return Result.err(
      storeFailure(operation, `Workflow source exceeds ${MAX_WORKFLOW_SOURCE_BYTES} bytes`),
    );
  }
  const canonicalPath = await fs.realpath(filePath);
  const source = await fs.readFile(canonicalPath, "utf8");
  if (Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_SOURCE_BYTES) {
    return Result.err(
      storeFailure(operation, `Workflow source exceeds ${MAX_WORKFLOW_SOURCE_BYTES} bytes`),
    );
  }
  return Result.ok({ source, canonicalPath });
}

export class WorkflowDefinitionStore {
  readonly canonicalWorkspaceRoot: string;
  readonly canonicalProjectId: string;

  private constructor(
    canonicalWorkspaceRoot: string,
    private readonly canonicalDataDir: string,
  ) {
    this.canonicalWorkspaceRoot = canonicalWorkspaceRoot;
    this.canonicalProjectId = `project:${sha256(canonicalWorkspaceRoot)}`;
  }

  static async createResult(params: {
    workspaceRoot: string;
    dataDir: string;
  }): Promise<ResultType<WorkflowDefinitionStore, WorkflowDefinitionStoreFailed>> {
    return captureWorkflowDefinitionStoreOperation("create", async () => {
      const workspaceStats = await fs.lstat(params.workspaceRoot);
      if (workspaceStats.isSymbolicLink() || !workspaceStats.isDirectory()) {
        return Result.err(
          storeFailure(
            "create",
            `Workspace root must be a real directory: ${params.workspaceRoot}`,
          ),
        );
      }
      const canonicalWorkspaceRoot = await fs.realpath(params.workspaceRoot);
      const canonicalDataDir = await canonicalDirectory(params.dataDir, "create");
      if (canonicalDataDir.status === "error") return Result.err(canonicalDataDir.error);
      return Result.ok(new WorkflowDefinitionStore(canonicalWorkspaceRoot, canonicalDataDir.value));
    });
  }

  private async scopeRoot(
    scope: WorkflowScope,
    create: boolean,
    operation: WorkflowDefinitionStoreOperation,
  ): Promise<ResultType<string, WorkflowDefinitionStoreFailed>> {
    if (scope === "project") {
      if (create) {
        return await ensureDirectoryWithoutSymlinks(
          this.canonicalWorkspaceRoot,
          [".lilac", "workflows"],
          operation,
        );
      }
      return await assertDirectorySegmentsWithoutSymlinks(
        this.canonicalWorkspaceRoot,
        [".lilac", "workflows"],
        operation,
      );
    }
    if (create) {
      return await ensureDirectoryWithoutSymlinks(this.canonicalDataDir, ["workflows"], operation);
    }
    return await assertDirectorySegmentsWithoutSymlinks(
      this.canonicalDataDir,
      ["workflows"],
      operation,
    );
  }

  private async definitionPath(
    scope: WorkflowScope,
    nameInput: string,
    createRoot: boolean,
    operation: WorkflowDefinitionStoreOperation,
  ): Promise<
    ResultType<{ name: string; root: string; candidate: string }, WorkflowDefinitionStoreFailed>
  > {
    const parsedName = workflowDefinitionNameSchema.safeParse(nameInput);
    if (!parsedName.success) {
      return Result.err(
        storeFailure(operation, parsedName.error.issues[0]?.message ?? "Workflow name is invalid"),
      );
    }
    const name = parsedName.data;
    const rootResult = await this.scopeRoot(scope, createRoot, operation);
    if (rootResult.status === "error") return Result.err(rootResult.error);
    const root = rootResult.value;
    const candidate = path.join(root, `${name}.js`);
    if (!isContained(root, candidate) || path.dirname(candidate) !== root) {
      return Result.err(storeFailure(operation, `Workflow definition escapes scope root: ${name}`));
    }
    return Result.ok({ name, root, candidate });
  }

  private async validateSource(
    input: {
      name: string;
      source: string;
    },
    operation: WorkflowDefinitionStoreOperation,
  ): Promise<ResultType<ValidatedWorkflowDefinition, WorkflowDefinitionStoreFailed>> {
    const validated = validateWorkflowSourceUnchecked(input);
    return validated.status === "error"
      ? Result.err(storeFailure(operation, validated.error.message))
      : Result.ok(validated.value);
  }

  private async getUnchecked(params: {
    scope: WorkflowDefinitionScope;
    name: string;
  }): Promise<ResultType<ResolvedWorkflowDefinition, WorkflowDefinitionStoreFailed>> {
    const parsedScope = workflowScopeSchema.safeParse(params.scope);
    if (params.scope !== "auto" && !parsedScope.success) {
      return Result.err(storeFailure("get", "Workflow scope is invalid"));
    }
    const scopes: readonly WorkflowScope[] =
      params.scope === "auto" ? ["project", "personal"] : [parsedScope.data!];
    for (const scope of scopes) {
      const locationResult = await this.definitionPath(scope, params.name, false, "get");
      if (locationResult.status === "error") return Result.err(locationResult.error);
      const location = locationResult.value;
      const rootStats = await lstatOrNull(location.root);
      if (!rootStats) continue;
      if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
        return Result.err(
          storeFailure("get", `Workflow scope root must be a real directory: ${location.root}`),
        );
      }
      const root = await fs.realpath(location.root);
      const fileStats = await lstatOrNull(location.candidate);
      if (!fileStats) continue;
      const file = await readBoundedRegularFile(location.candidate, "get");
      if (file.status === "error") return Result.err(file.error);
      const { source, canonicalPath } = file.value;
      if (!isContained(root, canonicalPath) || path.dirname(canonicalPath) !== root) {
        return Result.err(
          storeFailure("get", `Workflow definition escapes canonical scope root: ${canonicalPath}`),
        );
      }
      const validation = await this.validateSource({ name: location.name, source }, "get");
      if (validation.status === "error") return Result.err(validation.error);
      return Result.ok({
        scope,
        name: location.name,
        normalizedPath: `${location.name}.js`,
        canonicalPath,
        source,
        validation: validation.value,
      });
    }
    return Result.err(
      storeFailure("get", `Workflow definition not found: ${params.name} (scope=${params.scope})`),
    );
  }

  async getResult(params: {
    scope: WorkflowDefinitionScope;
    name: string;
  }): Promise<ResultType<ResolvedWorkflowDefinition, WorkflowDefinitionStoreFailed>> {
    return captureWorkflowDefinitionStoreOperation("get", () => this.getUnchecked(params));
  }

  private async saveUnchecked(params: {
    scope: WorkflowScope;
    name: string;
    source: string;
    expectedSha256?: string;
  }): Promise<ResultType<ResolvedWorkflowDefinition, WorkflowDefinitionStoreFailed>> {
    const parsedScope = workflowScopeSchema.safeParse(params.scope);
    if (!parsedScope.success) return Result.err(storeFailure("save", "Workflow scope is invalid"));
    const scope = parsedScope.data;
    const locationResult = await this.definitionPath(scope, params.name, true, "save");
    if (locationResult.status === "error") return Result.err(locationResult.error);
    const location = locationResult.value;
    const validation = await this.validateSource(
      {
        name: location.name,
        source: params.source,
      },
      "save",
    );
    if (validation.status === "error") return Result.err(validation.error);
    const lockPath = path.join(location.root, `.${location.name}.save.lock`);
    const [openedLock] = await Promise.allSettled([fs.open(lockPath, "wx", 0o600)]);
    if (openedLock.status === "rejected") {
      if (isPanic(openedLock.reason)) preserveToolPanic(openedLock.reason);
      return Result.err(
        storeFailure(
          "save",
          `Could not acquire the save lock for workflow ${location.name}: ${opaqueErrorMessage(openedLock.reason, "opaque lock failure")}`,
        ),
      );
    }
    const lock = openedLock.value;
    try {
      const existingStats = await lstatOrNull(location.candidate);
      if (existingStats) {
        const existingResult = await readBoundedRegularFile(location.candidate, "save");
        if (existingResult.status === "error") return Result.err(existingResult.error);
        const existing = existingResult.value;
        if (!isContained(location.root, existing.canonicalPath)) {
          return Result.err(
            storeFailure(
              "save",
              `Workflow definition escapes canonical scope root: ${existing.canonicalPath}`,
            ),
          );
        }
        const currentSha256 = sha256(existing.source);
        if (!params.expectedSha256) {
          return Result.err(
            storeFailure(
              "save",
              `Workflow already exists; expectedSha256 is required (current ${currentSha256})`,
            ),
          );
        }
        if (params.expectedSha256 !== currentSha256) {
          return Result.err(
            storeFailure(
              "save",
              `Workflow optimistic hash mismatch: expected ${params.expectedSha256}, current ${currentSha256}`,
            ),
          );
        }
      } else if (params.expectedSha256 !== undefined) {
        return Result.err(
          storeFailure("save", "Workflow does not exist, but expectedSha256 was provided"),
        );
      }

      const tempPath = path.join(location.root, `.${location.name}.${crypto.randomUUID()}.tmp`);
      const mode = scope === "personal" ? 0o600 : 0o644;
      const handle = await fs.open(tempPath, "wx", mode);
      try {
        await handle.writeFile(params.source, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      const [renamed] = await Promise.allSettled([
        fs.rename(tempPath, location.candidate).then(async () => {
          if (scope === "personal") await fs.chmod(location.candidate, 0o600);
        }),
      ]);
      if (renamed.status === "rejected") {
        if (isPanic(renamed.reason)) preserveToolPanic(renamed.reason);
        await fs.rm(tempPath, { force: true });
        return Result.err(
          storeFailure(
            "save",
            `Could not commit workflow ${location.name}: ${opaqueErrorMessage(renamed.reason, "opaque save failure")}`,
          ),
        );
      }

      const saved = await readBoundedRegularFile(location.candidate, "save");
      if (saved.status === "error") return Result.err(saved.error);
      const { canonicalPath } = saved.value;
      if (!isContained(location.root, canonicalPath)) {
        return Result.err(
          storeFailure("save", `Saved workflow escapes canonical scope root: ${canonicalPath}`),
        );
      }
      return Result.ok({
        scope,
        name: location.name,
        normalizedPath: `${location.name}.js`,
        canonicalPath,
        source: params.source,
        validation: validation.value,
      });
    } finally {
      await lock.close();
      await fs.rm(lockPath, { force: true });
    }
  }

  async saveResult(params: {
    scope: WorkflowScope;
    name: string;
    source: string;
    expectedSha256?: string;
  }): Promise<ResultType<ResolvedWorkflowDefinition, WorkflowDefinitionStoreFailed>> {
    return captureWorkflowDefinitionStoreOperation("save", () => this.saveUnchecked(params));
  }

  private async listUnchecked(params: { scope: WorkflowDefinitionScope }): Promise<
    ResultType<
      Array<
        | (Omit<ResolvedWorkflowDefinition, "source"> & { valid: true })
        | {
            scope: WorkflowScope;
            name: string;
            normalizedPath: string;
            canonicalPath: string;
            valid: false;
            error: string;
          }
      >,
      WorkflowDefinitionStoreFailed
    >
  > {
    const parsedScope = workflowScopeSchema.safeParse(params.scope);
    if (params.scope !== "auto" && !parsedScope.success) {
      return Result.err(storeFailure("list", "Workflow scope is invalid"));
    }
    const scopes: readonly WorkflowScope[] =
      params.scope === "auto" ? ["project", "personal"] : [parsedScope.data!];
    const seen = new Set<string>();
    const results: Array<
      | (Omit<ResolvedWorkflowDefinition, "source"> & { valid: true })
      | {
          scope: WorkflowScope;
          name: string;
          normalizedPath: string;
          canonicalPath: string;
          valid: false;
          error: string;
        }
    > = [];
    for (const scope of scopes) {
      const rootResult = await this.scopeRoot(scope, false, "list");
      if (rootResult.status === "error") return Result.err(rootResult.error);
      const rootCandidate = rootResult.value;
      const rootStats = await lstatOrNull(rootCandidate);
      if (!rootStats) continue;
      if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
        return Result.err(
          storeFailure("list", `Workflow scope root must be a real directory: ${rootCandidate}`),
        );
      }
      const entries = await fs.readdir(rootCandidate, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => compareCodeUnits(left.name, right.name))) {
        if (!entry.name.endsWith(".js")) continue;
        const name = entry.name.slice(0, -3);
        if (!workflowDefinitionNameSchema.safeParse(name).success || seen.has(name)) continue;
        seen.add(name);
        const candidate = path.join(rootCandidate, entry.name);
        const resolved = await this.getResult({ scope, name });
        if (resolved.status === "ok") {
          results.push({
            scope,
            name,
            normalizedPath: resolved.value.normalizedPath,
            canonicalPath: resolved.value.canonicalPath,
            validation: resolved.value.validation,
            valid: true,
          });
        } else {
          results.push({
            scope,
            name,
            normalizedPath: entry.name,
            canonicalPath: candidate,
            valid: false,
            error: resolved.error.message,
          });
        }
      }
    }
    return Result.ok(results);
  }

  async listResult(params: {
    scope: WorkflowDefinitionScope;
  }): Promise<
    ResultType<
      Awaited<ReturnType<WorkflowDefinitionStore["listUnchecked"]>> extends ResultType<
        infer TValue,
        WorkflowDefinitionStoreFailed
      >
        ? TValue
        : never,
      WorkflowDefinitionStoreFailed
    >
  > {
    return captureWorkflowDefinitionStoreOperation("list", () => this.listUnchecked(params));
  }

  private async createSnapshotUnchecked(
    source: string,
    sourceSha256: string,
  ): Promise<ResultType<{ artifactId: string; path: string }, WorkflowDefinitionStoreFailed>> {
    if (sha256(source) !== sourceSha256) {
      return Result.err(storeFailure("create-snapshot", "Snapshot source hash mismatch"));
    }
    const rootResult = await ensureDirectoryWithoutSymlinks(
      this.canonicalDataDir,
      ["workflow-snapshots"],
      "create-snapshot",
    );
    if (rootResult.status === "error") return Result.err(rootResult.error);
    const root = rootResult.value;
    const snapshotPath = path.join(root, `${sourceSha256}.js`);
    const existing = await lstatOrNull(snapshotPath);
    if (existing) {
      const storedResult = await readBoundedRegularFile(snapshotPath, "create-snapshot");
      if (storedResult.status === "error") return Result.err(storedResult.error);
      const stored = storedResult.value;
      if (!isContained(root, stored.canonicalPath) || sha256(stored.source) !== sourceSha256) {
        return Result.err(
          storeFailure(
            "create-snapshot",
            `Workflow snapshot hash collision or containment failure: ${sourceSha256}`,
          ),
        );
      }
      return Result.ok({
        artifactId: `workflow-source:${sourceSha256}`,
        path: stored.canonicalPath,
      });
    }
    const [opened] = await Promise.allSettled([fs.open(snapshotPath, "wx", 0o600)]);
    if (opened.status === "rejected") {
      if (isPanic(opened.reason)) preserveToolPanic(opened.reason);
      const storedResult = await readBoundedRegularFile(snapshotPath, "create-snapshot");
      if (storedResult.status === "ok") {
        const stored = storedResult.value;
        if (isContained(root, stored.canonicalPath) && sha256(stored.source) === sourceSha256) {
          return Result.ok({
            artifactId: `workflow-source:${sourceSha256}`,
            path: stored.canonicalPath,
          });
        }
      }
      return Result.err(
        storeFailure(
          "create-snapshot",
          `Could not create workflow snapshot: ${opaqueErrorMessage(opened.reason, "opaque snapshot failure")}`,
        ),
      );
    }
    const handle = opened.value;
    try {
      await handle.writeFile(source, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.chmod(snapshotPath, 0o600);
    return Result.ok({
      artifactId: `workflow-source:${sourceSha256}`,
      path: await fs.realpath(snapshotPath),
    });
  }

  async createSnapshotResult(
    source: string,
    sourceSha256: string,
  ): Promise<ResultType<{ artifactId: string; path: string }, WorkflowDefinitionStoreFailed>> {
    return captureWorkflowDefinitionStoreOperation("create-snapshot", () =>
      this.createSnapshotUnchecked(source, sourceSha256),
    );
  }

  private async readSnapshotUnchecked(
    sourceSha256: string,
  ): Promise<ResultType<string, WorkflowDefinitionStoreFailed>> {
    if (!/^[a-f0-9]{64}$/u.test(sourceSha256)) {
      return Result.err(storeFailure("read-snapshot", "Invalid workflow source hash"));
    }
    const rootResult = await this.scopeRootForSnapshots("read-snapshot");
    if (rootResult.status === "error") return Result.err(rootResult.error);
    const root = rootResult.value;
    const snapshotPath = path.join(root, `${sourceSha256}.js`);
    const storedResult = await readBoundedRegularFile(snapshotPath, "read-snapshot");
    if (storedResult.status === "error") return Result.err(storedResult.error);
    const stored = storedResult.value;
    if (!isContained(root, stored.canonicalPath) || path.dirname(stored.canonicalPath) !== root) {
      return Result.err(
        storeFailure(
          "read-snapshot",
          `Workflow snapshot escapes canonical root: ${stored.canonicalPath}`,
        ),
      );
    }
    if (sha256(stored.source) !== sourceSha256) {
      return Result.err(
        storeFailure("read-snapshot", `Workflow snapshot hash mismatch: ${sourceSha256}`),
      );
    }
    return Result.ok(stored.source);
  }

  async readSnapshotResult(
    sourceSha256: string,
  ): Promise<ResultType<string, WorkflowDefinitionStoreFailed>> {
    return captureWorkflowDefinitionStoreOperation("read-snapshot", () =>
      this.readSnapshotUnchecked(sourceSha256),
    );
  }

  private async scopeRootForSnapshots(
    operation: WorkflowDefinitionStoreOperation,
  ): Promise<ResultType<string, WorkflowDefinitionStoreFailed>> {
    return await ensureDirectoryWithoutSymlinks(
      this.canonicalDataDir,
      ["workflow-snapshots"],
      operation,
    );
  }
}
