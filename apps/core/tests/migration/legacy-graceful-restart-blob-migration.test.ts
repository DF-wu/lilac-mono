import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import SuperJSON from "superjson";

import {
  commitLegacyGracefulRestartMigration,
  LegacyGracefulRestartMigrationFailed,
  preflightLegacyGracefulRestartMigration,
} from "../../scripts/legacy-graceful-restart-blob-migration";
import { gracefulRestartSnapshotCodecCases } from "../../src/migration/frozen-graceful-restart-store";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function tempDatabasePath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lilac-graceful-migration-"));
  tempDirs.push(dir);
  return path.join(dir, "graceful-restart.db");
}

function createDatabase(
  dbPath: string,
  options: {
    readonly payloadJson?: string;
    readonly status?: string;
    readonly singletonId?: number;
    readonly ddl?: string;
    readonly addIndex?: boolean;
  } = {},
): void {
  using database = new Database(dbPath, { strict: true });
  database.run(
    options.ddl ??
      `CREATE TABLE IF NOT EXISTS graceful_restart_state (
        singleton_id INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        updated_ts INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      )`,
  );
  if (options.addIndex) {
    database.run("CREATE INDEX idx_graceful_restart_status ON graceful_restart_state(status)");
  }
  if (options.payloadJson !== undefined) {
    database.run(
      `INSERT INTO graceful_restart_state
         (singleton_id, status, updated_ts, payload_json)
       VALUES (?, ?, 1, ?)`,
      [options.singletonId ?? 1, options.status ?? "completed", options.payloadJson],
    );
  }
}

function exactLegacySnapshot(version: 1 | 2 | 3 | 4): string {
  const common = {
    version,
    createdAt: 1,
    deadlineMs: 1_000,
    agent: [],
    relays: [],
  };
  return SuperJSON.stringify(
    version < 3
      ? common
      : {
          ...common,
          queueAttemptProof: "complete",
          queueAttempts: [],
        },
  );
}

function rowCount(dbPath: string): number {
  using database = new Database(dbPath, { readonly: true, strict: true });
  return database
    .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM graceful_restart_state")
    .get()!.count;
}

describe("legacy graceful restart blob migration", () => {
  it.each([1, 2, 3, 4] as const)(
    "recognizes and transactionally discards an exact v%s snapshot",
    async (version) => {
      const dbPath = await tempDatabasePath();
      createDatabase(dbPath, { payloadJson: exactLegacySnapshot(version) });
      const before = await readFile(dbPath);

      const preflight = preflightLegacyGracefulRestartMigration(dbPath);
      expect(preflight.status).toBe("ok");
      if (preflight.status === "error") throw preflight.error;
      expect(preflight.value.report).toEqual({
        classification: "legacy-discard",
        rowCount: 1,
        snapshotCount: 1,
        sourceVersion: version,
        discardedSnapshotCount: 0,
      });
      expect(await readFile(dbPath)).toEqual(before);
      expect(rowCount(dbPath)).toBe(1);

      const committed = commitLegacyGracefulRestartMigration({
        dbPath,
        plan: preflight.value.plan,
      });
      expect(committed.status).toBe("ok");
      if (committed.status === "error") throw committed.error;
      expect(committed.value.discardedSnapshotCount).toBe(1);
      expect(rowCount(dbPath)).toBe(0);
    },
  );

  it("classifies an exact current v5 snapshot as a no-op", async () => {
    const dbPath = await tempDatabasePath();
    createDatabase(dbPath, {
      payloadJson: gracefulRestartSnapshotCodecCases.current.input.payload_json,
    });
    const before = await readFile(dbPath);

    const preflight = preflightLegacyGracefulRestartMigration(dbPath);
    expect(preflight.status).toBe("ok");
    if (preflight.status === "error") throw preflight.error;
    expect(preflight.value.report.classification).toBe("current");
    expect(preflight.value.report.sourceVersion).toBe(5);

    const committed = commitLegacyGracefulRestartMigration({
      dbPath,
      plan: preflight.value.plan,
    });
    expect(committed.status).toBe("ok");
    expect(await readFile(dbPath)).toEqual(before);
    expect(rowCount(dbPath)).toBe(1);
  });

  it.each([
    ["malformed serialization", "{"],
    ["arbitrary payload", SuperJSON.stringify({ arbitrary: true })],
    ["future version", gracefulRestartSnapshotCodecCases["unsupported-version"].input.payload_json],
    ["corrupt current v5", gracefulRestartSnapshotCodecCases["corrupt-fields"].input.payload_json],
    ["corrupt legacy v4", SuperJSON.stringify({ version: 4, createdAt: 1 })],
  ])("blocks %s without mutating the database", async (_name, payloadJson) => {
    const dbPath = await tempDatabasePath();
    createDatabase(dbPath, { payloadJson });
    const before = await readFile(dbPath);

    const preflight = preflightLegacyGracefulRestartMigration(dbPath);
    expect(preflight.status).toBe("error");
    if (preflight.status === "ok") throw new Error("Expected preflight to fail");
    expect(preflight.error).toBeInstanceOf(LegacyGracefulRestartMigrationFailed);
    expect(preflight.error.code).toBe("invalid-snapshot");
    expect(await readFile(dbPath)).toEqual(before);
    expect(rowCount(dbPath)).toBe(1);
  });

  it("blocks an invalid row status before classifying a legacy snapshot", async () => {
    const dbPath = await tempDatabasePath();
    createDatabase(dbPath, {
      payloadJson: exactLegacySnapshot(4),
      status: "in-progress",
    });
    const before = await readFile(dbPath);

    const preflight = preflightLegacyGracefulRestartMigration(dbPath);
    expect(preflight.status).toBe("error");
    if (preflight.status === "ok") throw new Error("Expected preflight to fail");
    expect(preflight.error.code).toBe("invalid-snapshot");
    expect(await readFile(dbPath)).toEqual(before);
    expect(rowCount(dbPath)).toBe(1);
  });

  it("blocks an existing database with no graceful restart table without mutation", async () => {
    const dbPath = await tempDatabasePath();
    {
      using _database = new Database(dbPath, { strict: true });
    }
    const before = await readFile(dbPath);

    const preflight = preflightLegacyGracefulRestartMigration(dbPath);
    expect(preflight.status).toBe("error");
    if (preflight.status === "ok") throw new Error("Expected preflight to fail");
    expect(preflight.error.code).toBe("invalid-table-layout");
    expect(await readFile(dbPath)).toEqual(before);
  });

  it("blocks a non-singleton row id without mutation", async () => {
    const dbPath = await tempDatabasePath();
    createDatabase(dbPath, {
      payloadJson: exactLegacySnapshot(4),
      singletonId: 2,
    });
    const before = await readFile(dbPath);

    const preflight = preflightLegacyGracefulRestartMigration(dbPath);
    expect(preflight.status).toBe("error");
    if (preflight.status === "ok") throw new Error("Expected preflight to fail");
    expect(preflight.error.code).toBe("invalid-table-layout");
    expect(await readFile(dbPath)).toEqual(before);
    expect(rowCount(dbPath)).toBe(1);
  });

  it.each([
    {
      name: "an extra schema object",
      create: (dbPath: string) =>
        createDatabase(dbPath, {
          payloadJson: exactLegacySnapshot(4),
          addIndex: true,
        }),
    },
    {
      name: "drifted table DDL",
      create: (dbPath: string) =>
        createDatabase(dbPath, {
          payloadJson: exactLegacySnapshot(4),
          ddl: `CREATE TABLE graceful_restart_state (
            singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
            status TEXT NOT NULL,
            updated_ts INTEGER NOT NULL,
            payload_json TEXT NOT NULL
          )`,
        }),
    },
  ])("blocks $name without mutation", async ({ create }) => {
    const dbPath = await tempDatabasePath();
    create(dbPath);
    const before = await readFile(dbPath);

    const preflight = preflightLegacyGracefulRestartMigration(dbPath);
    expect(preflight.status).toBe("error");
    if (preflight.status === "ok") throw new Error("Expected preflight to fail");
    expect(preflight.error.code).toBe("invalid-table-layout");
    expect(await readFile(dbPath)).toEqual(before);
    expect(rowCount(dbPath)).toBe(1);
  });
});
