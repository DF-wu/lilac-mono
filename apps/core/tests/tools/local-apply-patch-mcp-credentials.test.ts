import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseCoreConfigV1ToUniversal } from "@stanley2058/lilac-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCoreToolPluginManager as createCoreToolPluginManagerResult } from "../../src/plugins";

function createCoreToolPluginManager(
  params: Parameters<typeof createCoreToolPluginManagerResult>[0],
) {
  const manager = createCoreToolPluginManagerResult(params);
  return {
    ...manager,
    async buildLevel1Toolset(buildParams: Parameters<typeof manager.buildLevel1ToolsetResult>[0]) {
      const built = await manager.buildLevel1ToolsetResult(buildParams);
      if (built.status === "error") throw new Error(built.error.message, { cause: built.error });
      return built.value;
    },
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

async function resolveExecuteResult<T>(value: T | PromiseLike<T> | AsyncIterable<T>): Promise<T> {
  if (!isAsyncIterable(value)) return await value;

  let last: T | undefined;
  for await (const chunk of value) last = chunk;
  if (last === undefined) throw new Error("AsyncIterable tool execute produced no values");
  return last;
}

describe("local apply_patch MCP credential guards", () => {
  let dataDir: string;
  let secretDir: string;
  let workspace: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-apply-patch-secret-guard-"));
    secretDir = path.join(dataDir, "secret");
    workspace = path.join(dataDir, "workspace");
    await fs.mkdir(secretDir, { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(secretDir, "update.txt"), "old\n", "utf8");
    await fs.writeFile(path.join(secretDir, "delete.txt"), "keep\n", "utf8");
    await fs.writeFile(path.join(workspace, "move-source.txt"), "public\n", "utf8");
    await fs.symlink(secretDir, path.join(workspace, "secret-alias"));
    await fs.symlink("missing/../cyclic-alias", path.join(workspace, "cyclic-alias"));
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("denies add, update, delete, move, traversal, absolute, and symlink access normally", async () => {
    const config = parseCoreConfigV1ToUniversal({});
    const manager = createCoreToolPluginManager({ runtime: { config }, dataDir });
    await manager.init();
    try {
      const toolset = await manager.buildLevel1Toolset({
        cwd: workspace,
        runProfile: "primary",
        editingToolMode: "apply_patch",
        subagentDepth: 0,
        subagentConfig: config.agent.subagents,
      });
      const applyPatch = toolset.tools["apply_patch"];
      if (!applyPatch || typeof applyPatch.execute !== "function") {
        throw new Error("expected executable apply_patch tool");
      }
      const execute = applyPatch.execute;
      const executePatch = (input: unknown) =>
        Reflect.apply(execute, applyPatch, [
          input,
          { toolCallId: "apply-patch-secret-guard", messages: [], context: {} },
        ]);
      const patches = [
        {
          label: "add",
          cwd: dataDir,
          patchText: [
            "*** Begin Patch",
            "*** Add File: secret/add.txt",
            "+blocked",
            "*** End Patch",
          ].join("\n"),
        },
        {
          label: "update",
          cwd: dataDir,
          patchText: [
            "*** Begin Patch",
            "*** Update File: secret/update.txt",
            "@@",
            "-old",
            "+changed",
            "*** End Patch",
          ].join("\n"),
        },
        {
          label: "delete",
          cwd: dataDir,
          patchText: [
            "*** Begin Patch",
            "*** Delete File: secret/delete.txt",
            "*** End Patch",
          ].join("\n"),
        },
        {
          label: "move",
          cwd: workspace,
          patchText: [
            "*** Begin Patch",
            "*** Update File: move-source.txt",
            `*** Move to: ${path.join(secretDir, "moved.txt")}`,
            "@@",
            "-public",
            "+changed",
            "*** End Patch",
          ].join("\n"),
        },
        {
          label: "relative traversal",
          cwd: workspace,
          patchText: [
            "*** Begin Patch",
            "*** Add File: ../secret/traversal.txt",
            "+blocked",
            "*** End Patch",
          ].join("\n"),
        },
        {
          label: "absolute path",
          cwd: workspace,
          patchText: [
            "*** Begin Patch",
            `*** Add File: ${path.join(secretDir, "absolute.txt")}`,
            "+blocked",
            "*** End Patch",
          ].join("\n"),
        },
        {
          label: "symlink alias",
          cwd: workspace,
          patchText: [
            "*** Begin Patch",
            "*** Add File: secret-alias/symlink.txt",
            "+blocked",
            "*** End Patch",
          ].join("\n"),
        },
        {
          label: "cyclic symlink alias",
          cwd: workspace,
          patchText: [
            "*** Begin Patch",
            "*** Add File: cyclic-alias/file.txt",
            "+blocked",
            "*** End Patch",
          ].join("\n"),
        },
      ];

      for (const input of patches) {
        const result = await resolveExecuteResult(executePatch(input));
        expect(result, input.label).toMatchObject({ status: "failed" });
        if (!result || typeof result !== "object") throw new Error("expected apply_patch result");
        expect(Reflect.get(result, "output"), input.label).toContain(
          input.label === "cyclic symlink alias" ? "Too many symbolic links" : "Access denied",
        );
      }

      expect(await fs.readFile(path.join(secretDir, "update.txt"), "utf8")).toBe("old\n");
      expect(await fs.readFile(path.join(secretDir, "delete.txt"), "utf8")).toBe("keep\n");
      expect(await fs.readFile(path.join(workspace, "move-source.txt"), "utf8")).toBe("public\n");
      for (const name of ["add.txt", "moved.txt", "traversal.txt", "absolute.txt", "symlink.txt"]) {
        expect(await fs.exists(path.join(secretDir, name)), name).toBe(false);
      }

      const allowedPath = path.join(secretDir, "dangerously-allowed.txt");
      const allowed = await resolveExecuteResult(
        executePatch({
          cwd: workspace,
          dangerouslyAllow: true,
          patchText: [
            "*** Begin Patch",
            `*** Add File: ${allowedPath}`,
            "+allowed",
            "*** End Patch",
          ].join("\n"),
        }),
      );
      expect(allowed).toMatchObject({ status: "completed" });
      expect(await fs.readFile(allowedPath, "utf8")).toBe("allowed");
    } finally {
      await manager.destroy();
    }
  });
});
