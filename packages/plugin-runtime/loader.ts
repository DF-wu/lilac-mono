import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { LilacToolPlugin } from "./types";

async function copyDirectoryTree(sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  const dirents = await fs.readdir(sourceDir, { withFileTypes: true });

  for (const dirent of dirents) {
    if (dirent.name.includes(".lilac-")) continue;

    const sourcePath = path.join(sourceDir, dirent.name);
    const targetPath = path.join(targetDir, dirent.name);

    if (dirent.isDirectory()) {
      await copyDirectoryTree(sourcePath, targetPath);
      continue;
    }

    if (dirent.isFile()) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
      continue;
    }

    if (dirent.isSymbolicLink()) {
      const target = await fs.readlink(sourcePath);
      await fs.symlink(target, targetPath);
    }
  }
}

export async function loadToolPluginModule(params: {
  entrypointPath: string;
  pluginDir?: string;
  cacheBustKey: string;
}): Promise<LilacToolPlugin<unknown, unknown, unknown>> {
  const snapshotPath = await (async () => {
    if (!params.pluginDir) {
      const parsedPath = path.parse(params.entrypointPath);
      const extension = parsedPath.ext || ".js";
      const nextPath = path.join(
        parsedPath.dir,
        `.${parsedPath.name}.lilac-${params.cacheBustKey}${extension}`,
      );

      const source = await fs.readFile(params.entrypointPath);
      await fs.writeFile(nextPath, source);
      return nextPath;
    }

    const snapshotDir = path.join(params.pluginDir, `.lilac-${params.cacheBustKey}`);
    await fs.rm(snapshotDir, { recursive: true, force: true });
    await copyDirectoryTree(params.pluginDir, snapshotDir);
    return path.join(snapshotDir, path.relative(params.pluginDir, params.entrypointPath));
  })();

  const url = pathToFileURL(snapshotPath);

  const mod = await import(url.toString());
  const importedDefault = mod.default;
  const plugin: unknown = importedDefault;
  if (
    typeof plugin !== "object" ||
    plugin === null ||
    Array.isArray(plugin) ||
    !("meta" in plugin) ||
    !("create" in plugin)
  ) {
    throw new Error("Plugin entrypoint must default export a LilacToolPlugin");
  }

  const meta = plugin.meta;
  if (
    typeof meta !== "object" ||
    meta === null ||
    Array.isArray(meta) ||
    !("id" in meta) ||
    typeof meta.id !== "string" ||
    meta.id.trim().length === 0 ||
    ("name" in meta && meta.name !== undefined && typeof meta.name !== "string") ||
    ("version" in meta && meta.version !== undefined && typeof meta.version !== "string") ||
    typeof plugin.create !== "function"
  ) {
    throw new Error("Plugin entrypoint must default export a LilacToolPlugin");
  }

  return importedDefault;
}
