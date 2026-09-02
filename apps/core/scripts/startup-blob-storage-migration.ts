import { Database } from "bun:sqlite";
import path from "node:path";

import { formatTaggedErrorForLog } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { runBlobStorageMigration } from "./migrate-blob-storage";
import { ensureStartupBlobStorageBackup } from "./startup-blob-storage-backup";
import { TRANSCRIPT_PERSISTENCE_SCHEMA_VERSION } from "../src/transcript/transcript-persistence-codec";

export { startupBlobStorageBackupDir } from "./startup-blob-storage-backup";

const LEGACY_TRANSCRIPT_SCHEMA_VERSION = 5;
const FIRST_BLOB_TRANSCRIPT_SCHEMA_VERSION = 6;
const CURRENT_TRANSCRIPT_SCHEMA_VERSION = TRANSCRIPT_PERSISTENCE_SCHEMA_VERSION;
const LEGACY_WORKFLOW_SCHEMA_VERSION = 25;
const CURRENT_WORKFLOW_SCHEMA_VERSION = 26;

export type StartupBlobStorageMigrationOptions = {
  readonly configPath: string;
  readonly dataDir: string;
  readonly workflowDbPath: string;
};

export type StartupBlobStorageMigrationOutcome =
  | { readonly kind: "current" }
  | { readonly kind: "migrated"; readonly backupDir: string };

export class StartupBlobStorageMigrationFailed extends TaggedError(
  "StartupBlobStorageMigrationFailed",
)<{
  readonly phase: "inspect" | "backup" | "migrate";
  readonly cause: unknown;
  readonly message: string;
}> {}

type SchemaState = "absent" | "legacy" | "current" | "unsupported";

async function inspectSchema(input: {
  readonly databasePath: string;
  readonly table: string;
  readonly legacyVersion: number;
  readonly firstCurrentVersion: number;
  readonly latestCurrentVersion: number;
}): Promise<SchemaState> {
  if (!(await Bun.file(input.databasePath).exists())) return "absent";
  const database = new Database(input.databasePath, { readonly: true, strict: true });
  using _closeDatabase = {
    [Symbol.dispose]: () => database.close(false),
  };
  const tableExists =
    database
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(input.table)?.count === 1;
  if (!tableExists) return "absent";
  const versions = database
    .query<{ version: number }, []>(`SELECT version FROM ${input.table} ORDER BY version`)
    .all()
    .map(({ version }) => version);
  const consecutive = versions.every((version, index) => version === index + 1);
  if (consecutive && versions.length === input.legacyVersion) return "legacy";
  if (
    consecutive &&
    versions.length >= input.firstCurrentVersion &&
    versions.length <= input.latestCurrentVersion
  )
    return "current";
  return "unsupported";
}

export async function runStartupBlobStorageMigration(
  options: StartupBlobStorageMigrationOptions,
): Promise<ResultType<StartupBlobStorageMigrationOutcome, StartupBlobStorageMigrationFailed>> {
  return Result.gen(async function* () {
    const { transcript, workflow } = yield* Result.await(
      Result.tryPromise({
        try: async () => ({
          transcript: await inspectSchema({
            databasePath: path.join(options.dataDir, "agent-transcripts.db"),
            table: "transcript_schema_migrations",
            legacyVersion: LEGACY_TRANSCRIPT_SCHEMA_VERSION,
            firstCurrentVersion: FIRST_BLOB_TRANSCRIPT_SCHEMA_VERSION,
            latestCurrentVersion: CURRENT_TRANSCRIPT_SCHEMA_VERSION,
          }),
          workflow: await inspectSchema({
            databasePath: options.workflowDbPath,
            table: "workflow_schema_migrations",
            legacyVersion: LEGACY_WORKFLOW_SCHEMA_VERSION,
            firstCurrentVersion: CURRENT_WORKFLOW_SCHEMA_VERSION,
            latestCurrentVersion: CURRENT_WORKFLOW_SCHEMA_VERSION,
          }),
        }),
        catch: (cause) =>
          new StartupBlobStorageMigrationFailed({
            phase: "inspect",
            cause,
            message: "Failed to inspect persisted schema versions before Core startup",
          }),
      }),
    );
    if (
      (transcript === "absent" || transcript === "current") &&
      (workflow === "absent" || workflow === "current")
    ) {
      return Result.ok({ kind: "current" } as const);
    }
    if (transcript !== "legacy" || workflow !== "legacy") {
      return Result.err(
        new StartupBlobStorageMigrationFailed({
          phase: "inspect",
          cause: { transcript, workflow },
          message: `Unsupported coordinated blob migration state: transcript=${transcript}, workflow=${workflow}`,
        }),
      );
    }
    const backupDir = yield* Result.await(
      ensureStartupBlobStorageBackup(options).then((result) =>
        result.mapError(
          (cause) =>
            new StartupBlobStorageMigrationFailed({
              phase: "backup",
              cause,
              message: cause.message,
            }),
        ),
      ),
    );
    yield* Result.await(
      runBlobStorageMigration({ ...options, dryRun: false }).then((result) =>
        result.mapError(
          (cause) =>
            new StartupBlobStorageMigrationFailed({
              phase: "migrate",
              cause,
              message: `Automatic blob storage migration failed: ${cause.message}`,
            }),
        ),
      ),
    );
    return Result.ok({ kind: "migrated", backupDir } as const);
  });
}

async function main(): Promise<void> {
  const dataDir = path.resolve(process.env.DATA_DIR ?? "data");
  const migrated = await runStartupBlobStorageMigration({
    configPath: path.join(dataDir, "core-config.yaml"),
    dataDir,
    workflowDbPath: path.resolve(process.env.SQLITE_URL ?? path.join(dataDir, "data.sqlite3")),
  });
  migrated.match({
    ok: (outcome) => console.log(JSON.stringify({ startupBlobStorage: outcome })),
    err: (error) => {
      console.error(JSON.stringify(formatTaggedErrorForLog(error)));
      process.exitCode = 1;
    },
  });
}

if (import.meta.main) await main();
