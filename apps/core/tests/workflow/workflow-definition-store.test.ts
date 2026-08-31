import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WorkflowDefinitionStore } from "../../src/workflow/workflow-definition-store";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import { createWorkflowTestBlobStore } from "./workflow-test-blob-store";
import type { WorkflowArtifactReference } from "../../src/workflow/workflow-domain";

async function storeResultValue<T>(
  resultPromise: Promise<import("better-result").Result<T, Error>>,
) {
  const result = await resultPromise;
  if (result.status === "error") throw result.error;
  return result.value;
}

async function createStore(input: { workspaceRoot: string; dataDir: string }) {
  const blobStore = await createWorkflowTestBlobStore();
  const workflowStore = new DurableWorkflowStore(":memory:");
  const store = await storeResultValue(
    WorkflowDefinitionStore.createResult({ ...input, blobStore, workflowStore }),
  );
  return {
    save: (params: Parameters<typeof store.saveResult>[0]) =>
      storeResultValue(store.saveResult(params)),
    saveResult: store.saveResult.bind(store),
    get: (params: Parameters<typeof store.getResult>[0]) =>
      storeResultValue(store.getResult(params)),
    list: (params: Parameters<typeof store.listResult>[0]) =>
      storeResultValue(store.listResult(params)),
    createSnapshot: (source: string, sourceSha256: string) =>
      storeResultValue(store.createSnapshotResult(source, sourceSha256)),
    readSnapshot: (artifact: WorkflowArtifactReference) =>
      storeResultValue(store.readSnapshotResult(artifact)),
  };
}

function source(name: string, description = "Test workflow") {
  return `import { defineWorkflow } from "@lilac/workflow";
export default defineWorkflow({
  name: "${name}",
  description: "${description}",
  input: { type: "object", properties: {} },
  resources: {
    agents: { maxConcurrent: 1, maxTotal: 1 },
    waits: [],
  },
  async run({ args }) { return args; },
});
`;
}

describe("WorkflowDefinitionStore", () => {
  let root: string | null = null;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = null;
  });

  it("saves atomically, requires optimistic hashes, and resolves project before personal", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-definition-store-"));
    const workspaceRoot = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    await fs.mkdir(workspaceRoot);
    const store = await createStore({ workspaceRoot, dataDir });

    const personal = await store.save({
      scope: "personal",
      name: "audit-routes",
      source: source("audit-routes", "Personal"),
    });
    expect((await fs.stat(personal.canonicalPath)).mode & 0o777).toBe(0o600);
    await expect(
      store.save({
        scope: "personal",
        name: "audit-routes",
        source: source("audit-routes", "New"),
      }),
    ).rejects.toThrow("expectedSha256 is required");
    await expect(
      store.save({
        scope: "personal",
        name: "audit-routes",
        source: source("audit-routes", "New"),
        expectedSha256: "a".repeat(64),
      }),
    ).rejects.toThrow("optimistic hash mismatch");
    const beforeFailedWrite = await fs.readFile(personal.canonicalPath, "utf8");
    const failedWrite = await store.saveResult({
      scope: "personal",
      name: "audit-routes",
      source: source("audit-routes", "Not committed"),
      expectedSha256: "b".repeat(64),
    });
    expect(failedWrite.status).toBe("error");
    if (failedWrite.status === "error") {
      expect(failedWrite.error).toMatchObject({
        _tag: "WorkflowDefinitionStoreFailed",
        operation: "save",
      });
    }
    expect(await fs.readFile(personal.canonicalPath, "utf8")).toBe(beforeFailedWrite);
    const replaced = await store.save({
      scope: "personal",
      name: "audit-routes",
      source: source("audit-routes", "New"),
      expectedSha256: personal.validation.sourceSha256,
    });
    expect(replaced.validation.metadata.description).toBe("New");

    await store.save({
      scope: "project",
      name: "audit-routes",
      source: source("audit-routes", "Project"),
    });
    expect((await store.get({ scope: "auto", name: "audit-routes" })).scope).toBe("project");
    expect(await store.list({ scope: "auto" })).toHaveLength(1);
  });

  it("rejects symlink roots and files, traversal names, and creates immutable snapshots", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-definition-security-"));
    const workspaceRoot = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    await fs.mkdir(workspaceRoot);
    const store = await createStore({ workspaceRoot, dataDir });
    await expect(
      store.save({ scope: "project", name: "../escape", source: source("escape") }),
    ).rejects.toThrow("kebab-case");

    const outside = path.join(root, "outside.js");
    await fs.writeFile(outside, source("linked"));
    const workflowRoot = path.join(workspaceRoot, ".lilac", "workflows");
    await fs.mkdir(workflowRoot, { recursive: true });
    await fs.symlink(outside, path.join(workflowRoot, "linked.js"));
    await expect(store.get({ scope: "project", name: "linked" })).rejects.toThrow("symlink");

    const saved = await store.save({
      scope: "personal",
      name: "snapshot-test",
      source: source("snapshot-test"),
    });
    const first = await store.createSnapshot(saved.source, saved.validation.sourceSha256);
    const second = await store.createSnapshot(saved.source, saved.validation.sourceSha256);
    expect(first).toEqual(second);
    expect(await store.readSnapshot(first.artifact)).toBe(saved.source);
    expect(first.artifact.artifactId).toBe(`workflow-source:${saved.validation.sourceSha256}`);
    expect(first.artifact.blobRef.expiresAt).toBeUndefined();
    await expect(
      store.createSnapshot(`${saved.source}\n`, saved.validation.sourceSha256),
    ).rejects.toThrow("hash mismatch");
  });

  it("rejects symlinks in intermediate scope-root components", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-definition-root-symlink-"));
    const workspaceRoot = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    const outside = path.join(root, "outside");
    await fs.mkdir(workspaceRoot);
    await fs.mkdir(path.join(outside, "workflows"), { recursive: true });
    await fs.writeFile(path.join(outside, "workflows", "linked.js"), source("linked"));
    await fs.symlink(outside, path.join(workspaceRoot, ".lilac"));
    const store = await createStore({ workspaceRoot, dataDir });

    await expect(store.get({ scope: "project", name: "linked" })).rejects.toThrow(
      "cannot contain symlinks",
    );
  });

  it("returns creation boundary failures as typed values", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-definition-create-result-"));
    const workspaceRoot = path.join(root, "missing-workspace");
    const created = await WorkflowDefinitionStore.createResult({
      workspaceRoot,
      dataDir: path.join(root, "data"),
      blobStore: await createWorkflowTestBlobStore(),
      workflowStore: new DurableWorkflowStore(":memory:"),
    });
    expect(created.status).toBe("error");
    if (created.status === "error") {
      expect(created.error).toMatchObject({
        _tag: "WorkflowDefinitionStoreFailed",
        operation: "create",
      });
    }
  });
});
