import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  runStartupBlobStorageMigration,
  startupBlobStorageBackupDir,
} from "../../scripts/startup-blob-storage-migration";
import { runBlobStorageMigration } from "../../scripts/migrate-blob-storage";
import { applyWorkflowSchemaMigrations } from "../../src/workflow/workflow-migrations";
import { createTranscriptSchemaMigrationFixture } from "../transcript/fixtures/transcript-schema-migration-fixtures";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

async function createWorkspace(): Promise<{
  readonly configPath: string;
  readonly dataDir: string;
  readonly transcriptDbPath: string;
  readonly workflowDbPath: string;
}> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-startup-migration-"));
  temporaryDirectories.push(dataDir);
  const configPath = path.join(dataDir, "core-config.yaml");
  const transcriptDbPath = path.join(dataDir, "agent-transcripts.db");
  const workflowDbPath = path.join(dataDir, "data.sqlite3");
  await fs.writeFile(configPath, "configVersion: 2\n");
  return { configPath, dataDir, transcriptDbPath, workflowDbPath };
}

function createLegacyTranscriptDatabase(databasePath: string): void {
  createTranscriptSchemaMigrationFixture(databasePath, 5);
}

function createWorkflowDatabase(databasePath: string, version: 25 | 26): void {
  const database = new Database(databasePath, { create: true, strict: true });
  const migrated = applyWorkflowSchemaMigrations(database, () => 1, version);
  database.close(false);
  migrated.match({
    ok: () => undefined,
    err: (error) => {
      throw error;
    },
  });
}

function schemaVersion(databasePath: string, table: string): number {
  const database = new Database(databasePath, { readonly: true, strict: true });
  using _closeDatabase = {
    [Symbol.dispose]: () => database.close(false),
  };
  return (
    database.query<{ version: number }, []>(`SELECT MAX(version) AS version FROM ${table}`).get()
      ?.version ?? 0
  );
}

function advanceTranscriptSchemaHistory(databasePath: string, throughVersion: number): void {
  const database = new Database(databasePath, { strict: true });
  const currentVersion = schemaVersion(databasePath, "transcript_schema_migrations");
  for (let version = currentVersion + 1; version <= throughVersion; version += 1) {
    database.run("INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (?, ?)", [
      version,
      version,
    ]);
  }
  database.close(false);
}

describe("runStartupBlobStorageMigration", () => {
  it("backs up and migrates coordinated legacy schemas exactly once", async () => {
    const workspace = await createWorkspace();
    createLegacyTranscriptDatabase(workspace.transcriptDbPath);
    createWorkflowDatabase(workspace.workflowDbPath, 25);

    const first = await runStartupBlobStorageMigration(workspace);
    if (first.isErr()) throw first.error;
    expect(first.isOk()).toBe(true);
    expect(first.value.kind).toBe("migrated");
    expect(schemaVersion(workspace.transcriptDbPath, "transcript_schema_migrations")).toBe(6);
    expect(schemaVersion(workspace.workflowDbPath, "workflow_schema_migrations")).toBe(26);

    const backupDir = startupBlobStorageBackupDir(workspace.dataDir);
    expect(await Bun.file(path.join(backupDir, "manifest.json")).exists()).toBe(true);
    expect(await Bun.file(path.join(backupDir, "agent-transcripts.db")).exists()).toBe(true);
    expect(await Bun.file(path.join(backupDir, "data.sqlite3")).exists()).toBe(true);
    expect(
      schemaVersion(path.join(backupDir, "agent-transcripts.db"), "transcript_schema_migrations"),
    ).toBe(5);
    expect(schemaVersion(path.join(backupDir, "data.sqlite3"), "workflow_schema_migrations")).toBe(
      25,
    );

    const manifestBefore = await Bun.file(path.join(backupDir, "manifest.json")).text();
    const second = await runStartupBlobStorageMigration(workspace);
    expect(second.isOk()).toBe(true);
    if (second.isOk()) expect(second.value).toEqual({ kind: "current" });
    expect(await Bun.file(path.join(backupDir, "manifest.json")).text()).toBe(manifestBefore);
  });

  it("skips fresh and current databases without creating a backup", async () => {
    const fresh = await createWorkspace();
    const freshResult = await runStartupBlobStorageMigration(fresh);
    expect(freshResult.isOk()).toBe(true);
    expect(await Bun.file(startupBlobStorageBackupDir(fresh.dataDir)).exists()).toBe(false);

    const current = await createWorkspace();
    createLegacyTranscriptDatabase(current.transcriptDbPath);
    createWorkflowDatabase(current.workflowDbPath, 25);
    const prepared = await runBlobStorageMigration({ ...current, dryRun: false });
    if (prepared.isErr()) throw prepared.error;
    advanceTranscriptSchemaHistory(current.transcriptDbPath, 8);
    const currentResult = await runStartupBlobStorageMigration(current);
    expect(currentResult.isOk()).toBe(true);
    expect(await Bun.file(startupBlobStorageBackupDir(current.dataDir)).exists()).toBe(false);
  });

  it("refuses mixed schema states before writing data", async () => {
    const workspace = await createWorkspace();
    createLegacyTranscriptDatabase(workspace.transcriptDbPath);
    createWorkflowDatabase(workspace.workflowDbPath, 26);

    const result = await runStartupBlobStorageMigration(workspace);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toMatchObject({ phase: "inspect" });
      expect(result.error.message).toContain("transcript=legacy, workflow=current");
    }
    expect(schemaVersion(workspace.transcriptDbPath, "transcript_schema_migrations")).toBe(5);
    expect(await Bun.file(startupBlobStorageBackupDir(workspace.dataDir)).exists()).toBe(false);
  });
});
