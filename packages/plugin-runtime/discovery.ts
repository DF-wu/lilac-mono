import { createHash } from "node:crypto";
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

type PluginDiscoveryOutcome<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "error"; readonly error: ToolPluginDiscoveryError };

function discoveryOutcome<T>(
  result: ResultType<T, ToolPluginDiscoveryError>,
): PluginDiscoveryOutcome<T> {
  return result.match<PluginDiscoveryOutcome<T>>({
    ok: (value) => ({ kind: "value" as const, value }),
    err: (error) => ({ kind: "error" as const, error }),
  });
}

export function opaquePluginDiscoveryExceptionMessage(cause: unknown): string {
  return opaquePluginExceptionMessage(cause);
}

export function decodePluginFilesystemErrorCode(value: unknown): string | undefined {
  return Result.try({
    try: () => errorCodeSchema.safeParse(value),
    catch: () => undefined,
  }).match({
    ok: (parsed) => (parsed.success ? parsed.data.code : undefined),
    err: () => undefined,
  });
}

function isMissingPluginPathCode(code: string | undefined): boolean {
  return code === "ENOENT" || code === "ENOTDIR";
}

function updateFreshnessHash(
  hash: ReturnType<typeof createHash>,
  value: string | number | null,
): void {
  const text = value === null ? "" : String(value);
  hash.update(String(Buffer.byteLength(text, "utf8")));
  hash.update(":");
  hash.update(text);
}

async function captureFileOperation<T>(params: {
  operation: "read_plugins" | "fingerprint_plugins";
  filePath: string;
  run: () => Promise<T>;
}): Promise<ResultType<T, ToolPluginDiscoveryError>> {
  const captured = await Result.tryPromise({
    try: params.run,
    catch: (cause) => ({ restoreCause: () => cause }),
  });
  const outcome = captured.match<
    | { readonly kind: "value"; readonly value: T }
    | { readonly kind: "failure"; readonly restoreCause: () => unknown }
  >({
    ok: (value) => ({ kind: "value", value }),
    err: ({ restoreCause }) => ({ kind: "failure", restoreCause }),
  });
  if (outcome.kind === "value") return Result.ok(outcome.value);
  const cause = outcome.restoreCause();
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

function updateDirectoryFreshnessHash(
  hash: ReturnType<typeof createHash>,
  entries: readonly DirectoryFingerprintEntry[],
): void {
  for (const entry of entries) {
    updateFreshnessHash(hash, entry.type);
    updateFreshnessHash(hash, entry.path);
    if (entry.type === "dir") updateDirectoryFreshnessHash(hash, entry.entries);
    else if (entry.type === "file") {
      updateFreshnessHash(hash, entry.mtimeMs);
      updateFreshnessHash(hash, entry.hash);
    } else updateFreshnessHash(hash, entry.target);
  }
}

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
  const decoded = Result.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) => ({ cause }),
  });
  const json = decoded.match<{ readonly parsed: unknown } | { readonly cause: unknown }>({
    ok: (value) => ({ parsed: value }),
    err: ({ cause }) => ({ cause }),
  });
  if ("cause" in json && isPluginPanic(json.cause)) throw json.cause;
  if ("cause" in json) {
    return Result.err(
      `Failed to parse package.json: ${opaquePluginDiscoveryExceptionMessage(json.cause)}`,
    );
  }
  const parsed = packageJsonSchema.safeParse(json.parsed);
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
  const readPluginsOutcome = discoveryOutcome(readPlugins);
  if (readPluginsOutcome.kind === "error") {
    if (isMissingPluginPathCode(readPluginsOutcome.error.code)) {
      return Result.ok([]);
    }
    return Result.err(readPluginsOutcome.error);
  }
  const pluginDirents = readPluginsOutcome.value;

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
    const packageStatOutcome = discoveryOutcome(packageStat);
    if (packageStatOutcome.kind === "error") {
      entries.push({
        type: "invalid",
        pluginId,
        pluginDir,
        packageJsonPath,
        reason: isMissingPluginPathCode(packageStatOutcome.error.code)
          ? "missing package.json"
          : packageStatOutcome.error.message,
      });
      continue;
    }
    const packageMtime = packageStatOutcome.value;

    const packageText = await captureFileOperation({
      operation: "fingerprint_plugins",
      filePath: packageJsonPath,
      run: () => fs.readFile(packageJsonPath, "utf8"),
    });
    const packageTextOutcome = discoveryOutcome(packageText);
    if (packageTextOutcome.kind === "error") {
      entries.push({
        type: "invalid",
        pluginId,
        pluginDir,
        packageJsonPath,
        packageJsonMtimeMs: packageMtime,
        reason: packageTextOutcome.error.message,
      });
      continue;
    }
    const packageRaw = packageTextOutcome.value;

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
    const entrypointStatOutcome = discoveryOutcome(entrypointStat);
    if (entrypointStatOutcome.kind === "error") {
      entries.push({
        type: "invalid",
        pluginId,
        pluginDir,
        packageJsonPath,
        packageJsonMtimeMs: packageMtime,
        reason: `plugin entrypoint missing or unreadable: ${entrypointStatOutcome.error.message}`,
      });
      continue;
    }
    const entrypointMtime = entrypointStatOutcome.value;

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
  const discoveredOutcome = discoveryOutcome(discovered);
  if (discoveredOutcome.kind === "error") return Result.err(discoveredOutcome.error);
  const discoveredEntries = discoveredOutcome.value;

  let configMtimeMs: number | null = null;
  if (params.configPath) {
    const configStat = await captureFileOperation({
      operation: "fingerprint_plugins",
      filePath: params.configPath,
      run: () => statMtimeMs(params.configPath!),
    });
    const configStatOutcome = discoveryOutcome(configStat);
    if (configStatOutcome.kind === "error") {
      if (!isMissingPluginPathCode(configStatOutcome.error.code)) {
        return Result.err(configStatOutcome.error);
      }
    } else {
      configMtimeMs = configStatOutcome.value;
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
          packageJsonMtimeMs: entry.packageJsonMtimeMs ?? null,
          packageJsonHash: entry.packageJsonPath ? await hashFile(entry.packageJsonPath) : null,
        });
      }

      return { configMtimeMs, discovered: discoveredFingerprints };
    },
  });
  const fingerprintOutcome = discoveryOutcome(fingerprint);
  if (fingerprintOutcome.kind === "error") return Result.err(fingerprintOutcome.error);
  const hash = createHash("sha256");
  updateFreshnessHash(hash, fingerprintOutcome.value.configMtimeMs);
  for (const entry of fingerprintOutcome.value.discovered) {
    updateFreshnessHash(hash, entry.type);
    updateFreshnessHash(hash, entry.pluginId);
    if (entry.type === "plugin") {
      updateFreshnessHash(hash, entry.pluginDir);
      updateDirectoryFreshnessHash(hash, entry.fingerprint);
    } else {
      updateFreshnessHash(hash, entry.packageJsonMtimeMs);
      updateFreshnessHash(hash, entry.packageJsonHash);
    }
  }
  return Result.ok(hash.digest("hex"));
}
