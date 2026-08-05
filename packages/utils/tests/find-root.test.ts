import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { findWorkspaceRoot, findWorkspaceRootResult, hasWorkspacesFieldResult } from "../find-root";

describe("workspace root Results", () => {
  it("distinguishes a discovered root from a missing root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "utils-find-root-"));
    const child = path.join(root, "a", "b");
    await mkdir(child, { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ workspaces: ["a/*"] }));

    try {
      const manifest = hasWorkspacesFieldResult(path.join(root, "package.json"));
      expect(manifest.status).toBe("ok");

      const found = findWorkspaceRootResult(child);
      expect(found.status).toBe("ok");
      if (found.status === "ok") expect(found.value).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("continues past unreadable and malformed intermediate manifests", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "utils-find-root-intermediate-"));
    const malformedDir = path.join(root, "a");
    const unreadableDir = path.join(malformedDir, "b");
    const child = path.join(unreadableDir, "c");
    await mkdir(child, { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ workspaces: ["a/*"] }));
    await writeFile(path.join(malformedDir, "package.json"), "{");
    await mkdir(path.join(unreadableDir, "package.json"));

    try {
      const found = findWorkspaceRootResult(child);
      expect(found.status).toBe("ok");
      if (found.status === "ok") expect(found.value).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the legacy not-found exception as a plain Error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "utils-find-root-missing-"));
    let caught: unknown;
    try {
      findWorkspaceRoot(root);
    } catch (cause) {
      caught = cause;
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) expect(caught.constructor).toBe(Error);
  });
});
