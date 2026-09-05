import fs from "node:fs/promises";
import path from "node:path";

import { errorCode, opaqueErrorCause, opaqueErrorMessage } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";

const BACKUP_MANIFEST = "manifest.json";

export class StartupBlobStorageBackupFailed extends TaggedError("StartupBlobStorageBackupFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export function startupBlobStorageBackupDir(dataDir: string): string {
  return path.join(dataDir, ".migration-backups", "blob-storage-v5-v25");
}

async function copyBackupEntry(
  source: string,
  destination: string,
): Promise<ResultType<void, StartupBlobStorageBackupFailed>> {
  const inspected = await Result.tryPromise({
    try: () => fs.lstat(source),
    catch: (cause) => ({ restoreCause: () => cause }),
  });
  return inspected.match<Promise<ResultType<void, StartupBlobStorageBackupFailed>>>({
    ok: async (stats) => {
      if (stats.isSymbolicLink()) {
        return Result.err(
          new StartupBlobStorageBackupFailed({
            cause: undefined,
            message: `Refusing to back up symbolic link ${source}`,
          }),
        );
      }
      const copiedEntry = await Result.tryPromise({
        try: () => fs.cp(source, destination, { recursive: stats.isDirectory() }),
        catch: (cause) =>
          new StartupBlobStorageBackupFailed({
            cause,
            message: `Failed to copy backup entry ${source}`,
          }),
      });
      return copiedEntry.map(() => undefined);
    },
    err: async ({ restoreCause }) => {
      const restoredCause = restoreCause();
      if (errorCode(restoredCause) === "ENOENT") return Result.ok(undefined);
      const cause = opaqueErrorCause(restoredCause, "Opaque backup entry inspection failure");
      return Result.err(
        new StartupBlobStorageBackupFailed({
          cause,
          message: opaqueErrorMessage(cause, "Opaque backup entry inspection failure"),
        }),
      );
    },
  });
}

export async function ensureStartupBlobStorageBackup(options: {
  readonly dataDir: string;
  readonly workflowDbPath: string;
}): Promise<ResultType<string, StartupBlobStorageBackupFailed>> {
  const backupDir = startupBlobStorageBackupDir(options.dataDir);
  return Result.gen(async function* () {
    const setup = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          if (await Bun.file(path.join(backupDir, BACKUP_MANIFEST)).exists()) return false;
          const pendingDir = `${backupDir}.pending`;
          await fs.mkdir(path.dirname(backupDir), { recursive: true });
          await fs.rm(pendingDir, { force: true, recursive: true });
          await fs.mkdir(pendingDir);
          return true;
        },
        catch: (cause) =>
          new StartupBlobStorageBackupFailed({
            cause,
            message: "Failed to prepare the pre-migration operator backup",
          }),
      }),
    );
    if (!setup) return Result.ok(backupDir);
    const pendingDir = `${backupDir}.pending`;
    const transcriptDbPath = path.join(options.dataDir, "agent-transcripts.db");
    const entries = [
      { source: transcriptDbPath, name: "agent-transcripts.db" },
      { source: `${transcriptDbPath}-wal`, name: "agent-transcripts.db-wal" },
      { source: `${transcriptDbPath}-shm`, name: "agent-transcripts.db-shm" },
      { source: options.workflowDbPath, name: "data.sqlite3" },
      { source: `${options.workflowDbPath}-wal`, name: "data.sqlite3-wal" },
      { source: `${options.workflowDbPath}-shm`, name: "data.sqlite3-shm" },
      { source: path.join(options.dataDir, "graceful-restart.db"), name: "graceful-restart.db" },
      { source: path.join(options.dataDir, "tool-results"), name: "tool-results" },
      { source: path.join(options.dataDir, "workflow-artifacts"), name: "workflow-artifacts" },
      { source: path.join(options.dataDir, "workflow-snapshots"), name: "workflow-snapshots" },
    ] as const;
    for (const entry of entries) {
      yield* Result.await(copyBackupEntry(entry.source, path.join(pendingDir, entry.name)));
    }
    yield* Result.await(
      Result.tryPromise({
        try: async () => {
          await fs.writeFile(
            path.join(pendingDir, BACKUP_MANIFEST),
            `${JSON.stringify(
              {
                migration: "blob-storage-v5-v25",
                sources: entries.map(({ source, name }) => ({ source, backup: name })),
              },
              null,
              2,
            )}\n`,
          );
          await fs.rename(pendingDir, backupDir);
        },
        catch: (cause) =>
          new StartupBlobStorageBackupFailed({
            cause,
            message: "Failed to finalize the pre-migration operator backup",
          }),
      }),
    );
    return Result.ok(backupDir);
  });
}
