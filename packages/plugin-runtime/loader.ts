import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Result, type Result as ResultType } from "better-result";

import {
  decodeDynamicToolPluginModule,
  isPluginPanic,
  opaquePluginExceptionMessage,
  safePluginExceptionCause,
  type DynamicToolPluginModuleCapabilitySnapshot,
  type ToolPluginCapabilitySnapshot,
} from "./capabilities";
import { ToolPluginCapabilityError, ToolPluginModuleLoadError } from "./errors";
import type { Level1ToolSpec, LilacToolPlugin, ServerTool } from "./types";

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

async function createSnapshot(params: {
  entrypointPath: string;
  pluginDir?: string;
  cacheBustKey: string;
}): Promise<string> {
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
}

async function importDynamicModule(specifier: string): Promise<unknown> {
  return import(specifier);
}

export type ToolPluginLoaderError = ToolPluginModuleLoadError | ToolPluginCapabilityError;

export async function loadToolPluginModuleCapability<TRuntimeContext = unknown>(params: {
  entrypointPath: string;
  pluginDir?: string;
  cacheBustKey: string;
}): Promise<ResultType<ToolPluginCapabilitySnapshot<TRuntimeContext>, ToolPluginLoaderError>> {
  const captured = await Result.tryPromise({
    try: async () => {
      const snapshotPath = await createSnapshot(params);
      const imported = await importDynamicModule(pathToFileURL(snapshotPath).toString());
      return () => imported;
    },
    catch: (cause) => ({ restoreCause: () => cause }),
  });
  const outcome = captured.match<
    | { readonly kind: "imported"; readonly restoreImported: () => unknown }
    | { readonly kind: "failure"; readonly restoreCause: () => unknown }
  >({
    ok: (restoreImported) => ({ kind: "imported", restoreImported }),
    err: ({ restoreCause }) => ({ kind: "failure", restoreCause }),
  });
  if (outcome.kind === "failure") {
    const cause = outcome.restoreCause();
    if (isPluginPanic(cause)) throw cause;
    return Result.err(
      new ToolPluginModuleLoadError({
        entrypointPath: params.entrypointPath,
        cause: safePluginExceptionCause(cause),
        message: `Failed to load plugin module at ${params.entrypointPath}: ${opaquePluginExceptionMessage(cause)}`,
      }),
    );
  }

  const decoded = decodeDynamicToolPluginModule<TRuntimeContext>(outcome.restoreImported());
  const decodedOutcome = decoded.match<
    | {
        readonly ok: true;
        readonly value: DynamicToolPluginModuleCapabilitySnapshot<TRuntimeContext>;
      }
    | { readonly ok: false; readonly error: ToolPluginCapabilityError }
  >({
    ok: (value) => ({ ok: true, value }),
    err: (error) => ({ ok: false, error }),
  });
  return decodedOutcome.ok
    ? Result.ok(decodedOutcome.value.plugin)
    : Result.err(decodedOutcome.error);
}

export async function loadToolPluginModule<TRuntimeContext = unknown>(params: {
  entrypointPath: string;
  pluginDir?: string;
  cacheBustKey: string;
}): Promise<
  ResultType<
    LilacToolPlugin<TRuntimeContext, Level1ToolSpec<TRuntimeContext>, ServerTool>,
    ToolPluginLoaderError
  >
> {
  const loaded = await loadToolPluginModuleCapability<TRuntimeContext>(params);
  const loadedOutcome = loaded.match<
    | { readonly ok: true; readonly value: ToolPluginCapabilitySnapshot<TRuntimeContext> }
    | { readonly ok: false; readonly error: ToolPluginLoaderError }
  >({
    ok: (value) => ({ ok: true, value }),
    err: (error) => ({ ok: false, error }),
  });
  return loadedOutcome.ok ? Result.ok(loadedOutcome.value.plugin) : Result.err(loadedOutcome.error);
}
