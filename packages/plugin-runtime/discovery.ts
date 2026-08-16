import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { Result, type Result as ResultType } from "better-result";
import { z } from "zod";

import { ToolPluginDiscoveryError } from "./errors";
import {
  isPluginPanic,
  opaquePluginExceptionMessage,
  safePluginExceptionCause,
} from "./capabilities";

export type DiscoveredExternalToolPlugin = {
  type: "plugin";
  pluginId: string;
  pluginDir: string;
  packageJsonPath: string;
  entrypointPath: string;
  packageJsonMtimeMs: number;
  entrypointMtimeMs: number;
};

export type InvalidExternalToolPlugin = {
  type: "invalid";
  pluginId: string;
  pluginDir: string;
  packageJsonPath?: string;
  reason: string;
  packageJsonMtimeMs?: number;
};

export type ExternalToolPluginDiscovery = DiscoveredExternalToolPlugin | InvalidExternalToolPlugin;

const packageJsonSchema = z.object({
  lilac: z.object({
    plugin: z.string().trim().min(1),
  }),
});

export type PluginPackageJson = z.output<typeof packageJsonSchema>;

const errorCodeSchema = z.object({ code: z.string() });

export function opaquePluginDiscoveryExceptionMessage(cause: unknown): string {
  return opaquePluginExceptionMessage(cause);
}

export function decodePluginFilesystemErrorCode(value: unknown): string | undefined {
  try {
    const parsed = errorCodeSchema.safeParse(value);
    return parsed.success ? parsed.data.code : undefined;
  } catch {
    return undefined;
  }
}

function isMissingPluginPathCode(code: string | undefined): boolean {
  return code === "ENOENT" || code === "ENOTDIR";
}

async function captureFileOperation<T>(params: {
  operation: "read_plugins" | "fingerprint_plugins";
  filePath: string;
  run: () => Promise<T>;
}): Promise<ResultType<T, ToolPluginDiscoveryError>> {
  try {
    return Result.ok(await params.run());
  } catch (cause) {
    if (isPluginPanic(cause)) throw cause;
    return Result.err(
      new ToolPluginDiscoveryError({
        operation: params.operation,
        path: params.filePath,
        code: decodePluginFilesystemErrorCode(cause),
        cause: safePluginExceptionCause(cause),
        message: `Failed to ${params.operation.replaceAll("_", " ")} at ${params.filePath}: ${opaquePluginDiscoveryExceptionMessage(cause)}`,
      }),
    );
  }
}

async function statMtimeMs(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath);
  return stat.mtimeMs;
}

async function hashFile(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath);
  return Bun.hash(raw).toString(16);
}

type DirectoryFingerprintEntry =
  | {
      readonly type: "dir";
      readonly path: string;
      readonly entries: readonly DirectoryFingerprintEntry[];
    }
  | {
      readonly type: "file";
      readonly path: string;
      readonly mtimeMs: number;
      readonly hash: string;
    }
  | { readonly type: "symlink"; readonly path: string; readonly target: string };

async function buildDirectoryFingerprint(
  rootDir: string,
  currentDir = rootDir,
): Promise<readonly DirectoryFingerprintEntry[]> {
  const dirents = await fs.readdir(currentDir, { withFileTypes: true });
  const out: DirectoryFingerprintEntry[] = [];

  for (const dirent of [...dirents].sort((a, b) => a.name.localeCompare(b.name))) {
    if (dirent.name.includes(".lilac-")) continue;

    const entryPath = path.join(currentDir, dirent.name);
    const relativePath = path.relative(rootDir, entryPath);

    if (dirent.isDirectory()) {
      out.push({
        type: "dir",
        path: relativePath,
        entries: await buildDirectoryFingerprint(rootDir, entryPath),
      });
      continue;
    }

    if (dirent.isFile()) {
      out.push({
        type: "file",
        path: relativePath,
        mtimeMs: await statMtimeMs(entryPath),
        hash: await hashFile(entryPath),
      });
      continue;
    }

    if (dirent.isSymbolicLink()) {
      out.push({
        type: "symlink",
        path: relativePath,
        target: await fs.readlink(entryPath),
      });
    }
  }

  return out;
}

export function decodePluginPackageJsonText(raw: string): ResultType<PluginPackageJson, string> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    if (isPluginPanic(cause)) throw cause;
    return Result.err(
      `Failed to parse package.json: ${opaquePluginDiscoveryExceptionMessage(cause)}`,
    );
  }
  const parsed = packageJsonSchema.safeParse(json);
  if (parsed.success) return Result.ok(parsed.data);
  return Result.err(`Invalid package.json: ${parsed.error.message}`);
}

export function resolveExternalPluginsDir(dataDir: string): string {
  return path.join(dataDir, "plugins");
}

export async function discoverExternalToolPlugins(params: {
  dataDir: string;
}): Promise<ResultType<readonly ExternalToolPluginDiscovery[], ToolPluginDiscoveryError>> {
  const pluginsDir = resolveExternalPluginsDir(params.dataDir);
  const readPlugins = await captureFileOperation<Dirent[]>({
    operation: "read_plugins",
    filePath: pluginsDir,
    run: () => fs.readdir(pluginsDir, { withFileTypes: true }),
  });
  const pluginDirents = readPlugins.match<Dirent[] | ToolPluginDiscoveryError>({
    ok: (value) => value,
    err: (error) => error,
  });
  if (ToolPluginDiscoveryError.is(pluginDirents)) {
    if (isMissingPluginPathCode(pluginDirents.code)) {
      return Result.ok([]);
    }
    return Result.err(pluginDirents);
  }

  const entries: ExternalToolPluginDiscovery[] = [];
  for (const dirent of [...pluginDirents].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dirent.isDirectory()) continue;

    const pluginId = dirent.name;
    const pluginDir = path.join(pluginsDir, pluginId);
    const packageJsonPath = path.join(pluginDir, "package.json");
    const packageStat = await captureFileOperation({
      operation: "fingerprint_plugins",
      filePath: packageJsonPath,
      run: () => statMtimeMs(packageJsonPath),
    });
    const packageMtime = packageStat.match<number | ToolPluginDiscoveryError>({
      ok: (value) => value,
      err: (error) => error,
    });
    if (ToolPluginDiscoveryError.is(packageMtime)) {
      entries.push({
        type: "invalid",
        pluginId,
        pluginDir,
        packageJsonPath,
        reason: isMissingPluginPathCode(packageMtime.code)
          ? "missing package.json"
          : packageMtime.message,
      });
      continue;
    }

    const packageText = await captureFileOperation({
      operation: "fingerprint_plugins",
      filePath: packageJsonPath,
      run: () => fs.readFile(packageJsonPath, "utf8"),
    });
    const packageRaw = packageText.match<string | ToolPluginDiscoveryError>({
      ok: (value) => value,
      err: (error) => error,
    });
    if (ToolPluginDiscoveryError.is(packageRaw)) {
      entries.push({
        type: "invalid",
        pluginId,
        pluginDir,
        packageJsonPath,
        packageJsonMtimeMs: packageMtime,
        reason: packageRaw.message,
      });
      continue;
    }

    const packageJson = decodePluginPackageJsonText(packageRaw).match<PluginPackageJson | string>({
      ok: (value) => value,
      err: (error) => error,
    });
    if (typeof packageJson === "string") {
      entries.push({
        type: "invalid",
        pluginId,
        pluginDir,
        packageJsonPath,
        packageJsonMtimeMs: packageMtime,
        reason: packageJson,
      });
      continue;
    }

    const entrypointPath = path.resolve(pluginDir, packageJson.lilac.plugin);
    const entrypointStat = await captureFileOperation({
      operation: "fingerprint_plugins",
      filePath: entrypointPath,
      run: () => statMtimeMs(entrypointPath),
    });
    const entrypointMtime = entrypointStat.match<number | ToolPluginDiscoveryError>({
      ok: (value) => value,
      err: (error) => error,
    });
    if (ToolPluginDiscoveryError.is(entrypointMtime)) {
      entries.push({
        type: "invalid",
        pluginId,
        pluginDir,
        packageJsonPath,
        packageJsonMtimeMs: packageMtime,
        reason: `plugin entrypoint missing or unreadable: ${entrypointMtime.message}`,
      });
      continue;
    }

    entries.push({
      type: "plugin",
      pluginId,
      pluginDir,
      packageJsonPath,
      entrypointPath,
      packageJsonMtimeMs: packageMtime,
      entrypointMtimeMs: entrypointMtime,
    });
  }

  return Result.ok(entries);
}

export async function buildExternalToolPluginFreshnessKey(params: {
  dataDir: string;
  configPath?: string;
}): Promise<ResultType<string, ToolPluginDiscoveryError>> {
  const discovered = await discoverExternalToolPlugins({ dataDir: params.dataDir });
  const discoveredEntries = discovered.match<
    readonly ExternalToolPluginDiscovery[] | ToolPluginDiscoveryError
  >({
    ok: (value) => value,
    err: (error) => error,
  });
  if (ToolPluginDiscoveryError.is(discoveredEntries)) return Result.err(discoveredEntries);

  let configMtimeMs: number | null = null;
  if (params.configPath) {
    const configStat = await captureFileOperation({
      operation: "fingerprint_plugins",
      filePath: params.configPath,
      run: () => statMtimeMs(params.configPath!),
    });
    const configMtime = configStat.match<number | ToolPluginDiscoveryError>({
      ok: (value) => value,
      err: (error) => error,
    });
    if (ToolPluginDiscoveryError.is(configMtime)) {
      if (!isMissingPluginPathCode(configMtime.code)) return Result.err(configMtime);
    } else {
      configMtimeMs = configMtime;
    }
  }

  const fingerprint = await captureFileOperation({
    operation: "fingerprint_plugins",
    filePath: resolveExternalPluginsDir(params.dataDir),
    run: async () => {
      const discoveredFingerprints = [];
      for (const entry of discoveredEntries) {
        if (entry.type === "plugin") {
          discoveredFingerprints.push({
            type: entry.type,
            pluginId: entry.pluginId,
            pluginDir: entry.pluginDir,
            fingerprint: await buildDirectoryFingerprint(entry.pluginDir),
          });
          continue;
        }
        discoveredFingerprints.push({
          type: entry.type,
          pluginId: entry.pluginId,
          reason: entry.reason,
          packageJsonMtimeMs: entry.packageJsonMtimeMs ?? null,
          packageJsonHash: entry.packageJsonPath ? await hashFile(entry.packageJsonPath) : null,
        });
      }

      return { configMtimeMs, discovered: discoveredFingerprints };
    },
  });
  return fingerprint.map((value) => Bun.hash(JSON.stringify(value)).toString(16));
}
