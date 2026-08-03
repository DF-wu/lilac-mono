import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { MiniLilacUIMessage } from "@stanley2058/mini-lilac-client";
import { CorruptPersistedFields } from "@stanley2058/lilac-utils";
import type { ModelMessage } from "ai";
import superjson from "superjson";
import { z } from "zod";

import { MINI_LILAC_DATABASE_SCHEMA_VERSION, MiniLilacSqliteStore } from "../src/sqlite-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function serialize(value: unknown): string {
  return superjson.stringify(value);
}

function openStoreWithSuppressedMigrationWarning(databasePath: string): MiniLilacSqliteStore {
  const warning = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    return new MiniLilacSqliteStore(databasePath);
  } finally {
    warning.mockRestore();
  }
}

function transcriptNodeId(database: Database, sessionId: string, lane: "model" | "ui"): number {
  return z
    .object({ id: z.number().int().positive() })
    .parse(
      database
        .query("SELECT id FROM transcript_nodes WHERE session_id = ? AND lane = ?")
        .get(sessionId, lane),
    ).id;
}

async function createV2Database(): Promise<{ databasePath: string; directory: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-v2-migration-"));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, "runtime.sqlite");
  const database = new Database(databasePath, { create: true, strict: true });
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, active_run_id TEXT, cwd TEXT NOT NULL, model TEXT NOT NULL,
      profile TEXT NOT NULL, reasoning TEXT NOT NULL, title TEXT NOT NULL DEFAULT 'Mini Lilac',
      input_tokens INTEGER, context_window INTEGER,
      status TEXT NOT NULL, queued_steering_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      parent_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE, profile TEXT NOT NULL,
      depth INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, terminal_result_json TEXT,
      undone_at TEXT, started_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE TABLE commands (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      command_id TEXT NOT NULL, kind TEXT NOT NULL, run_id TEXT,
      request_fingerprint TEXT NOT NULL, request_json TEXT NOT NULL,
      side_effect_started INTEGER NOT NULL, result_json TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY(session_id, command_id)
    );
    CREATE TABLE model_transcript (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(session_id, position)
    );
    CREATE TABLE ui_messages (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(session_id, position)
    );
    CREATE TABLE run_chunks (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, chunk_json TEXT NOT NULL, PRIMARY KEY(run_id, seq)
    );
    CREATE TABLE user_checkpoints (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      ui_position INTEGER NOT NULL, user_message_json TEXT NOT NULL,
      model_prefix_json TEXT NOT NULL, ui_prefix_json TEXT NOT NULL,
      root_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      replay_after_seq INTEGER NOT NULL, PRIMARY KEY(session_id, ui_position)
    );
    CREATE TABLE session_todos (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, todos_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    PRAGMA user_version = 2;
  `);
  database
    .query(
      `INSERT INTO sessions
        (id, cwd, model, profile, reasoning, title, status, queued_steering_count, created_at, updated_at)
       VALUES ('session-1', ?, 'test/mock', 'reader', 'high', 'Migrated', 'idle', 0, ?, ?)`,
    )
    .run(directory, "2026-07-27T00:00:00.000Z", "2026-07-27T00:00:00.000Z");
  for (const [index, runId] of ["run-1", "run-2"].entries()) {
    database
      .query(
        `INSERT INTO runs
          (id, session_id, profile, depth, status, started_at, finished_at)
         VALUES (?, 'session-1', 'reader', 0, 'completed', ?, ?)`,
      )
      .run(runId, `2026-07-27T00:00:0${index}.000Z`, `2026-07-27T00:00:0${index}.500Z`);
  }
  database
    .query(
      `INSERT INTO commands
        (session_id, command_id, kind, run_id, request_fingerprint, request_json,
         side_effect_started, result_json, created_at)
       VALUES ('session-1', 'kept-command', 'prompt', 'run-1', 'hash', '{}', 1, '{}', ?)`,
    )
    .run("2026-07-27T00:00:00.000Z");
  database
    .query(
      `INSERT INTO session_todos (session_id, revision, todos_json, updated_at)
       VALUES ('session-1', 1, ?, ?)`,
    )
    .run(
      JSON.stringify([{ content: "Keep me", status: "pending", priority: "medium" }]),
      "2026-07-27T00:00:00.000Z",
    );
  database.close();
  return { databasePath, directory };
}

function seedLegacyTranscripts(
  databasePath: string,
  options: { legacySessionParts?: boolean } = {},
): {
  firstUser: MiniLilacUIMessage & { role: "user" };
  secondUser: MiniLilacUIMessage & { role: "user" };
} {
  const database = new Database(databasePath, { strict: true });
  const legacySessionParts = options.legacySessionParts
    ? [
        {
          type: "data-session",
          data: {
            id: "session-1",
            activeRunId: null,
            status: "idle",
            cwd: path.dirname(databasePath),
            model: "test/mock",
            profile: "reader",
            reasoning: "high",
            title: "Migrated",
            inputTokens: null,
            contextWindow: null,
            queuedSteeringCount: 0,
            createdAt: "2026-07-27T00:00:00.000Z",
            updatedAt: "2026-07-27T00:00:00.000Z",
          },
        },
      ]
    : [];
  const firstUser = {
    id: "user-1",
    role: "user" as const,
    parts: [{ type: "text" as const, text: "first" }],
  };
  const firstAssistant = {
    id: "assistant-1",
    role: "assistant" as const,
    parts: [...legacySessionParts, { type: "text" as const, text: "first answer" }],
  };
  const secondUser = {
    id: "user-2",
    role: "user" as const,
    parts: [{ type: "text" as const, text: "second" }],
  };
  const secondAssistant = {
    id: "assistant-2",
    role: "assistant" as const,
    parts: [...legacySessionParts, { type: "text" as const, text: "second answer" }],
  };
  const modelMessages: ModelMessage[] = [
    { role: "user", content: "first" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "second" },
    { role: "assistant", content: "second answer" },
  ];
  const uiMessages = [firstUser, firstAssistant, secondUser, secondAssistant];
  const divergentUiPrefix = [
    firstUser,
    firstAssistant,
    {
      id: "legacy-branch",
      role: "assistant",
      parts: [{ type: "text", text: "divergent checkpoint branch" }],
    },
  ];
  const sharedModelPrefix = modelMessages.slice(0, 2);
  const insertMessage = database.query(
    "INSERT INTO model_transcript (session_id, position, value_json) VALUES ('session-1', ?, ?)",
  );
  modelMessages.forEach((message, position) => insertMessage.run(position, serialize(message)));
  const insertUi = database.query(
    "INSERT INTO ui_messages (session_id, position, value_json) VALUES ('session-1', ?, ?)",
  );
  uiMessages.forEach((message, position) => insertUi.run(position, serialize(message)));
  const insertCheckpoint = database.query(
    `INSERT INTO user_checkpoints
      (session_id, ui_position, user_message_json, model_prefix_json, ui_prefix_json,
       root_run_id, replay_after_seq)
     VALUES ('session-1', ?, ?, ?, ?, ?, ?)`,
  );
  insertCheckpoint.run(0, serialize(firstUser), serialize([]), serialize([]), "run-1", 0);
  insertCheckpoint.run(
    2,
    serialize(secondUser),
    serialize(sharedModelPrefix),
    serialize(divergentUiPrefix),
    "run-2",
    7,
  );
  database
    .query("INSERT INTO run_chunks (run_id, seq, chunk_json) VALUES ('run-2', 1, ?)")
    .run(serialize({ type: "text-delta", id: "legacy", delta: "discarded" }));
  database.close();
  return { firstUser, secondUser };
}

describe("MiniLilacSqliteStore transcript schema", () => {
  it("migrates v2 chains and divergent checkpoints while preserving durable state", async () => {
    const { databasePath } = await createV2Database();
    seedLegacyTranscripts(databasePath);

    const store = openStoreWithSuppressedMigrationWarning(databasePath);

    expect(store.database.query("PRAGMA user_version").get()).toEqual({
      user_version: MINI_LILAC_DATABASE_SCHEMA_VERSION,
    });
    expect(store.getModelMessages("session-1")).toHaveLength(4);
    expect(store.getUiMessages("session-1")).toHaveLength(4);
    expect(store.getTodos("session-1").revision).toBe(1);
    expect(store.getRun("run-2").status).toBe("completed");
    expect(
      store.database
        .query("SELECT command_id FROM commands WHERE command_id = 'kept-command'")
        .get(),
    ).toEqual({ command_id: "kept-command" });
    expect(
      store.database
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('run_chunks', 'model_transcript', 'ui_messages', 'user_checkpoints')",
        )
        .all(),
    ).toEqual([]);
    expect(store.database.query("SELECT COUNT(*) AS count FROM transcript_nodes").get()).toEqual({
      count: 9,
    });

    expect(store.getModelMessages("session-1")).toHaveLength(4);
    expect(store.getUiMessages("session-1")).toHaveLength(4);
    const topology = store.listHistoryTopology("session-1");
    expect(topology.states).toHaveLength(1);
    expect(topology.transitions).toEqual([]);
    expect(topology.history).toMatchObject({
      rootStateId: topology.states[0]?.id,
      currentStateId: topology.states[0]?.id,
      undoFloorStateId: topology.states[0]?.id,
    });
    expect(store.getHistoryNavigation("session-1")).toMatchObject({
      canUndo: false,
      canRedo: false,
    });
    store.close();
  });

  it("removes legacy session snapshots while migrating v2 transcript storage", async () => {
    const { databasePath } = await createV2Database();
    seedLegacyTranscripts(databasePath, { legacySessionParts: true });

    const store = openStoreWithSuppressedMigrationWarning(databasePath);

    expect(store.getUiMessages("session-1")).toEqual([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "first" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "first answer" }],
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "second" }],
      },
      {
        id: "assistant-2",
        role: "assistant",
        parts: [{ type: "text", text: "second answer" }],
      },
    ]);
    expect(store.database.query("PRAGMA user_version").get()).toEqual({
      user_version: MINI_LILAC_DATABASE_SCHEMA_VERSION,
    });
    expect(store.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    store.close();
  });

  it("does not let reordered legacy checkpoint JSON bypass v5 history authority", async () => {
    const { databasePath } = await createV2Database();
    const { secondUser } = seedLegacyTranscripts(databasePath);
    const reorderedJson = serialize({
      parts: secondUser.parts,
      id: secondUser.id,
      role: secondUser.role,
    });
    const legacy = new Database(databasePath, { strict: true });
    legacy
      .query(
        "UPDATE user_checkpoints SET user_message_json = ? WHERE session_id = ? AND ui_position = ?",
      )
      .run(reorderedJson, "session-1", 2);
    legacy.close();

    const store = openStoreWithSuppressedMigrationWarning(databasePath);

    expect(store.getModelMessages("session-1")).toHaveLength(4);
    expect(store.getUiMessages("session-1")).toHaveLength(4);
    expect(store.listHistoryTopology("session-1")).toMatchObject({
      states: [{ origin: "migration" }],
      transitions: [],
      redoStack: [],
    });
    expect(store.getHistoryNavigation("session-1")).toMatchObject({
      canUndo: false,
      canRedo: false,
    });
    expect(
      store.database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_checkpoints'")
        .get(),
    ).toBeNull();
    store.close();
  });

  it("rolls back the whole v2 migration when legacy checkpoint data is invalid", async () => {
    const { databasePath } = await createV2Database();
    seedLegacyTranscripts(databasePath);
    const database = new Database(databasePath, { strict: true });
    database
      .query("UPDATE user_checkpoints SET model_prefix_json = ? WHERE ui_position = 2")
      .run(serialize({ invalid: true }));
    database.close();

    expect(() => new MiniLilacSqliteStore(databasePath)).toThrow(CorruptPersistedFields);

    const unchanged = new Database(databasePath, { strict: true });
    expect(unchanged.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(
      unchanged
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_chunks'")
        .get(),
    ).toEqual({ name: "run_chunks" });
    expect(
      unchanged
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transcript_nodes'")
        .get(),
    ).toBeNull();
    unchanged.close();
  });

  it("interns only missing suffix nodes and never mutates immutable transcript nodes", () => {
    const store = new MiniLilacSqliteStore(":memory:");
    store.createSession({
      id: "session-1",
      cwd: "/tmp",
      model: "test/mock",
      profile: "reader",
      reasoning: "high",
    });
    const firstUi: MiniLilacUIMessage = {
      id: "first",
      role: "user",
      parts: [{ type: "text", text: "first" }],
    };
    store.internHistoryTranscriptHeads(
      "session-1",
      [{ role: "user", content: "first" }],
      [firstUi],
    );
    expect(store.database.query("SELECT COUNT(*) AS count FROM transcript_nodes").get()).toEqual({
      count: 2,
    });
    store.database.exec(`
      CREATE TRIGGER immutable_transcript_update BEFORE UPDATE ON transcript_nodes
      BEGIN SELECT RAISE(ABORT, 'transcript node updated'); END;
      CREATE TRIGGER immutable_transcript_delete BEFORE DELETE ON transcript_nodes
      BEGIN SELECT RAISE(ABORT, 'transcript node deleted'); END;
    `);

    store.internHistoryTranscriptHeads(
      "session-1",
      [{ role: "user", content: "first" }],
      [firstUi],
    );
    expect(store.database.query("SELECT COUNT(*) AS count FROM transcript_nodes").get()).toEqual({
      count: 2,
    });
    const heads = store.internHistoryTranscriptHeads(
      "session-1",
      [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
      ],
      [firstUi, { id: "second", role: "assistant", parts: [{ type: "text", text: "second" }] }],
    );
    expect(store.database.query("SELECT COUNT(*) AS count FROM transcript_nodes").get()).toEqual({
      count: 4,
    });
    expect(heads.modelHeadId).not.toBeNull();
    expect(heads.uiHeadId).not.toBeNull();
    expect(store.getModelMessages("session-1")).toEqual([]);
    expect(store.getUiMessages("session-1")).toEqual([]);
    store.close();
  });

  it("rejects cross-session, cross-lane, and invalid-parent references in direct SQL", () => {
    const store = new MiniLilacSqliteStore(":memory:");
    for (const sessionId of ["session-1", "session-2"]) {
      store.createSession({
        id: sessionId,
        cwd: "/tmp",
        model: "test/mock",
        profile: "reader",
        reasoning: "high",
      });
      store.internHistoryTranscriptHeads(
        sessionId,
        [{ role: "user", content: sessionId }],
        [
          {
            id: `${sessionId}-user`,
            role: "user",
            parts: [{ type: "text", text: sessionId }],
          },
        ],
      );
    }
    const session1Ui = transcriptNodeId(store.database, "session-1", "ui");
    const session2Model = transcriptNodeId(store.database, "session-2", "model");

    expect(() =>
      store.database
        .query("INSERT INTO session_transcript_heads (session_id, model_head_id) VALUES (?, ?)")
        .run("session-1", session2Model),
    ).toThrow("FOREIGN KEY constraint failed");
    expect(() =>
      store.database
        .query("INSERT INTO session_transcript_heads (session_id, model_head_id) VALUES (?, ?)")
        .run("session-1", session1Ui),
    ).toThrow("FOREIGN KEY constraint failed");
    expect(() =>
      store.database
        .query(
          `INSERT INTO transcript_nodes
            (session_id, lane, parent_id, depth, value_json, hash)
           VALUES ('session-1', 'model', ?, 2, '{}', 'invalid-parent')`,
        )
        .run(session2Model),
    ).toThrow("FOREIGN KEY constraint failed");
    store.close();
  });

  it("rolls back a forced hash collision without moving the history cursor", () => {
    const store = new MiniLilacSqliteStore(":memory:");
    store.createSession({
      id: "session-1",
      cwd: "/tmp",
      model: "test/mock",
      profile: "reader",
      reasoning: "high",
    });
    const initialModel: ModelMessage[] = [{ role: "user", content: "first" }];
    const initialUi: MiniLilacUIMessage[] = [
      { id: "first", role: "user", parts: [{ type: "text", text: "first" }] },
    ];
    store.internHistoryTranscriptHeads("session-1", initialModel, initialUi);
    const replacementUi: MiniLilacUIMessage[] = [
      { id: "replacement", role: "user", parts: [{ type: "text", text: "collision" }] },
    ];
    const collisionHash = new Bun.CryptoHasher("sha256")
      .update("root")
      .update("\0")
      .update(serialize(replacementUi[0]))
      .digest("hex");
    store.database
      .query("UPDATE transcript_nodes SET hash = ? WHERE session_id = ? AND lane = 'ui'")
      .run(collisionHash, "session-1");
    const stateBefore = store.getCurrentHistoryState("session-1");
    const countBefore = store.database
      .query("SELECT COUNT(*) AS count FROM transcript_nodes")
      .get();

    expect(() =>
      store.internHistoryTranscriptHeads(
        "session-1",
        [...initialModel, { role: "assistant", content: "must roll back" }],
        replacementUi,
      ),
    ).toThrow("Transcript hash collision");

    expect(store.getCurrentHistoryState("session-1")).toEqual(stateBefore);
    expect(store.database.query("SELECT COUNT(*) AS count FROM transcript_nodes").get()).toEqual(
      countBefore,
    );
    expect(store.getModelMessages("session-1")).toEqual([]);
    expect(store.getUiMessages("session-1")).toEqual([]);
    store.close();
  });
});
