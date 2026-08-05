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
  if (readPlugins.status === "error") {
    if (isMissingPluginPathCode(readPlugins.error.code)) {
      return Result.ok([]);
    }
    return readPlugins;
  }

  const entries: ExternalToolPluginDiscovery[] = [];
  for (const dirent of [...readPlugins.value].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dirent.isDirectory()) continue;

    const pluginId = dirent.name;
    const pluginDir = path.join(pluginsDir, pluginId);
    const packageJsonPath = path.join(pluginDir, "package.json");
    const packageStat = await captureFileOperation({
      operation: "fingerprint_plugins",
      filePath: packageJsonPath,
      run: () => statMtimeMs(packageJsonPath),
    });
    if (packageStat.status === "error") {
      entries.push({
        type: "invalid",
        pluginId,
        pluginDir,
        packageJsonPath,
        reason: isMissingPluginPathCode(packageStat.error.code)
          ? "missing package.json"
          : packageStat.error.message,
      });
      continue;
    }

    const packageText = await captureFileOperation({
      operation: "fingerprint_plugins",
      filePath: packageJsonPath,
      run: () => fs.readFile(packageJsonPath, "utf8"),
    });
    if (packageText.status === "error") {
      entries.push({
        type: "invalid",
        pluginId,
        pluginDir,
        packageJsonPath,
        packageJsonMtimeMs: packageStat.value,
        reason: packageText.error.message,
      });
      continue;
    }

    const packageJson = decodePluginPackageJsonText(packageText.value);
    if (packageJson.status === "error") {
      entries.push({
        type: "invalid",
        pluginId,
        pluginDir,
        packageJsonPath,
        packageJsonMtimeMs: packageStat.value,
        reason: packageJson.error,
      });
      continue;
    }

    const entrypointPath = path.resolve(pluginDir, packageJson.value.lilac.plugin);
    const entrypointStat = await captureFileOperation({
      operation: "fingerprint_plugins",
      filePath: entrypointPath,
      run: () => statMtimeMs(entrypointPath),
    });
    if (entrypointStat.status === "error") {
      entries.push({
        type: "invalid",
        pluginId,
        pluginDir,
        packageJsonPath,
        packageJsonMtimeMs: packageStat.value,
        reason: `plugin entrypoint missing or unreadable: ${entrypointStat.error.message}`,
      });
      continue;
    }

    entries.push({
      type: "plugin",
      pluginId,
      pluginDir,
      packageJsonPath,
      entrypointPath,
      packageJsonMtimeMs: packageStat.value,
      entrypointMtimeMs: entrypointStat.value,
    });
  }

  return Result.ok(entries);
}

export async function buildExternalToolPluginFreshnessKey(params: {
  dataDir: string;
  configPath?: string;
}): Promise<ResultType<string, ToolPluginDiscoveryError>> {
  const discovered = await discoverExternalToolPlugins({ dataDir: params.dataDir });
  if (discovered.status === "error") return discovered;

  let configMtimeMs: number | null = null;
  if (params.configPath) {
    const configStat = await captureFileOperation({
      operation: "fingerprint_plugins",
      filePath: params.configPath,
      run: () => statMtimeMs(params.configPath!),
    });
    if (configStat.status === "ok") configMtimeMs = configStat.value;
    if (configStat.status === "error" && !isMissingPluginPathCode(configStat.error.code)) {
      return configStat;
    }
  }

  const fingerprint = await captureFileOperation({
    operation: "fingerprint_plugins",
    filePath: resolveExternalPluginsDir(params.dataDir),
    run: async () => {
      const discoveredFingerprints = [];
      for (const entry of discovered.value) {
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
  if (fingerprint.status === "error") return fingerprint;
  return Result.ok(Bun.hash(JSON.stringify(fingerprint.value)).toString(16));
}
