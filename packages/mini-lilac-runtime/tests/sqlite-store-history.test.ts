import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { MiniLilacUserUIMessage } from "@stanley2058/mini-lilac-client";
import type { ModelMessage } from "ai";
import superjson from "superjson";

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

async function temporaryDatabasePath(prefix: string): Promise<{ directory: string; file: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return { directory, file: path.join(directory, "runtime.sqlite") };
}

function createSession(store: MiniLilacSqliteStore, id: string, cwd: string): void {
  store.createSession({
    id,
    cwd,
    model: "test/mock",
    profile: "reader",
    reasoning: "high",
  });
}

function userMessage(id: string): MiniLilacUserUIMessage {
  return { id, role: "user", parts: [{ type: "text", text: id }] };
}

const unavailableWorkspace = {
  workspaceSnapshotId: null,
  workspaceStatus: "unavailable",
  workspaceUnavailableReason: "git-unavailable",
} as const;

function admitPrompt(
  store: MiniLilacSqliteStore,
  input: {
    sessionId: string;
    runId: string;
    commandId: string;
    transitionId: string;
    message: MiniLilacUserUIMessage;
    observationIds?: { stateId: string; transitionId: string };
    observationWorkspace?:
      | typeof unavailableWorkspace
      | {
          workspaceSnapshotId: string;
          workspaceStatus: "captured";
          workspaceUnavailableReason: null;
        };
  },
): void {
  const modelMessages: ModelMessage[] = [{ role: "user", content: input.message.id }];
  const uiMessages = [input.message];
  const payload = { messageId: input.message.id };
  store.reserveCommand(input.sessionId, input.commandId, {
    kind: "prompt",
    runId: null,
    payload,
  });
  store.admitRootPromptHistory({
    run: {
      id: input.runId,
      sessionId: input.sessionId,
      profile: "reader",
      depth: 0,
    },
    commandId: input.commandId,
    commandPayload: payload,
    transitionId: input.transitionId,
    expectedCurrentStateId: store.getCurrentHistoryState(input.sessionId).id,
    modelMessages,
    uiMessages,
    ...(input.observationIds === undefined
      ? {}
      : {
          observation: {
            ...input.observationIds,
            ...(input.observationWorkspace ?? unavailableWorkspace),
          },
        }),
  });
}

function finalizePrompt(
  store: MiniLilacSqliteStore,
  input: {
    sessionId: string;
    runId: string;
    transitionId: string;
    destinationStateId: string;
    user: MiniLilacUserUIMessage;
  },
): void {
  const assistant = {
    id: `assistant:${input.runId}`,
    role: "assistant" as const,
    parts: [{ type: "text" as const, text: `answer:${input.runId}` }],
  };
  store.reservePendingRunFinalization({
    runId: input.runId,
    sessionId: input.sessionId,
    openTransitionId: input.transitionId,
    modelMessages: [
      { role: "user", content: input.user.id },
      { role: "assistant", content: `answer:${input.runId}` },
    ],
    uiMessages: [input.user, assistant],
    runStatus: "completed",
    sessionStatus: "idle",
    error: null,
    terminalResult: { status: "completed" },
    inputTokens: 2,
  });
  store.commitPendingRunFinalization({
    runId: input.runId,
    destinationStateId: input.destinationStateId,
    ...unavailableWorkspace,
  });
}

async function createV4Database(
  options: {
    unusual?: boolean;
    active?: boolean;
    legacySessionParts?: boolean;
    legacyCompactionParts?: boolean;
    legacySessionOnlySuffix?: boolean;
  } = {},
): Promise<{
  databasePath: string;
  directory: string;
}> {
  const { directory, file: databasePath } = await temporaryDatabasePath("mini-lilac-v4-history-");
  const database = new Database(databasePath, { create: true, strict: true });
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, active_run_id TEXT, cwd TEXT NOT NULL, model TEXT NOT NULL,
      profile TEXT NOT NULL, reasoning TEXT NOT NULL, title TEXT NOT NULL DEFAULT 'Mini Lilac',
      input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
      input_tokens_estimated INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens_estimated IN (0, 1)),
      context_window INTEGER CHECK(context_window IS NULL OR context_window > 0),
      status TEXT NOT NULL, queued_steering_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      parent_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE, profile TEXT NOT NULL,
      depth INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, terminal_result_json TEXT,
      undone_at TEXT, started_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE UNIQUE INDEX one_active_root_run_per_session
      ON runs(session_id) WHERE status = 'active' AND parent_run_id IS NULL;
    CREATE TABLE commands (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      command_id TEXT NOT NULL, kind TEXT NOT NULL, run_id TEXT,
      request_fingerprint TEXT NOT NULL, request_json TEXT NOT NULL,
      side_effect_started INTEGER NOT NULL, result_json TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY(session_id, command_id)
    );
    CREATE TABLE transcript_nodes (
      id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      lane TEXT NOT NULL CHECK(lane IN ('model', 'ui')), parent_id INTEGER,
      depth INTEGER NOT NULL CHECK(depth > 0), value_json TEXT NOT NULL, hash TEXT NOT NULL,
      UNIQUE(session_id, lane, hash), UNIQUE(id, session_id, lane),
      FOREIGN KEY(parent_id, session_id, lane) REFERENCES transcript_nodes(id, session_id, lane)
    );
    CREATE INDEX transcript_nodes_parent ON transcript_nodes(parent_id);
    CREATE TABLE session_transcript_heads (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      model_head_id INTEGER, model_lane TEXT NOT NULL DEFAULT 'model' CHECK(model_lane = 'model'),
      ui_head_id INTEGER, ui_lane TEXT NOT NULL DEFAULT 'ui' CHECK(ui_lane = 'ui'),
      FOREIGN KEY(model_head_id, session_id, model_lane)
        REFERENCES transcript_nodes(id, session_id, lane),
      FOREIGN KEY(ui_head_id, session_id, ui_lane)
        REFERENCES transcript_nodes(id, session_id, lane)
    );
    CREATE TABLE user_checkpoints (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      ui_position INTEGER NOT NULL, user_message_json TEXT NOT NULL, model_head_id INTEGER,
      model_lane TEXT NOT NULL DEFAULT 'model' CHECK(model_lane = 'model'), ui_head_id INTEGER,
      ui_lane TEXT NOT NULL DEFAULT 'ui' CHECK(ui_lane = 'ui'),
      root_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      replay_after_seq INTEGER NOT NULL CHECK(replay_after_seq >= 0),
      PRIMARY KEY(session_id, ui_position),
      FOREIGN KEY(model_head_id, session_id, model_lane)
        REFERENCES transcript_nodes(id, session_id, lane),
      FOREIGN KEY(ui_head_id, session_id, ui_lane)
        REFERENCES transcript_nodes(id, session_id, lane)
    );
    CREATE TABLE session_todos (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, todos_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    PRAGMA user_version = 4;
  `);
  const createdAt = "2026-07-29T00:00:00.000Z";
  database
    .query(
      `INSERT INTO sessions
        (id, cwd, model, profile, reasoning, title, status, created_at, updated_at)
       VALUES ('session-1', ?, 'test/mock', 'reader', 'high', 'Migrated', 'idle', ?, ?)`,
    )
    .run(directory, createdAt, createdAt);
  database.exec(`
    INSERT INTO runs
      (id, session_id, profile, depth, status, started_at, finished_at)
    VALUES ('run-1', 'session-1', 'reader', 0, 'completed',
            '2026-07-29T00:00:01.000Z', '2026-07-29T00:00:02.000Z');
  `);
  const firstUser = userMessage("user-1");
  const secondUser = userMessage("user-2");
  const legacySessionParts = options.legacySessionParts
    ? [
        {
          type: "data-session",
          data: {
            id: "session-1",
            activeRunId: null,
            status: "idle",
            cwd: directory,
            model: "test/mock",
            profile: "reader",
            reasoning: "high",
            title: "Migrated",
            inputTokens: null,
            inputTokensEstimated: false,
            contextWindow: null,
            queuedSteeringCount: 0,
            createdAt,
            updatedAt: createdAt,
          },
        },
      ]
    : [];
  const legacyCompactionParts = options.legacyCompactionParts
    ? [
        {
          type: "data-compaction",
          id: "compaction-1",
          data: {
            source: "manual",
            reason: "manual",
            status: "completed",
            messageCountBefore: 20,
            messageCountAfter: 5,
            estimatedInputTokensBefore: 2_000,
            estimatedInputTokensAfter: 500,
          },
        },
      ]
    : [];
  const model: ModelMessage[] = [
    { role: "user", content: "user-1" },
    { role: "assistant", content: "answer-1" },
    { role: "user", content: "user-2" },
    { role: "assistant", content: "answer-2" },
  ];
  const ui = [
    firstUser,
    {
      id: "assistant-1",
      role: "assistant" as const,
      parts: [...legacySessionParts, { type: "text" as const, text: "answer-1" }],
    },
    secondUser,
    {
      id: "assistant-2",
      role: "assistant" as const,
      parts: [
        ...legacySessionParts,
        ...legacyCompactionParts,
        { type: "text" as const, text: "answer-2" },
      ],
    },
  ];
  const insertNode = database.query(
    `INSERT INTO transcript_nodes
      (id, session_id, lane, parent_id, depth, value_json, hash)
     VALUES (?, 'session-1', ?, ?, ?, ?, ?)`,
  );
  let modelParent: number | null = null;
  model.forEach((message, index) => {
    const id = index + 1;
    insertNode.run(id, "model", modelParent, index + 1, serialize(message), `model-${id}`);
    modelParent = id;
  });
  let uiParent: number | null = null;
  ui.forEach((message, index) => {
    const id = index + 10;
    insertNode.run(id, "ui", uiParent, index + 1, serialize(message), `ui-${id}`);
    uiParent = id;
  });
  let currentUiHead = 13;
  if (options.legacySessionOnlySuffix) {
    insertNode.run(
      30,
      "ui",
      currentUiHead,
      5,
      serialize({
        id: "assistant-session-only",
        role: "assistant",
        parts: legacySessionParts,
      }),
      "ui-session-only",
    );
    currentUiHead = 30;
  }
  let secondUiHead = 11;
  if (options.unusual) {
    insertNode.run(
      20,
      "ui",
      11,
      3,
      serialize({
        id: "divergent",
        role: "assistant",
        parts: [{ type: "text", text: "divergent" }],
      }),
      "ui-divergent",
    );
    secondUiHead = 20;
  }
  database
    .query(
      `INSERT INTO session_transcript_heads (session_id, model_head_id, ui_head_id)
       VALUES ('session-1', 4, ?)`,
    )
    .run(currentUiHead);
  const insertCheckpoint = database.query(
    `INSERT INTO user_checkpoints
      (session_id, ui_position, user_message_json, model_head_id, ui_head_id,
       root_run_id, replay_after_seq)
     VALUES ('session-1', ?, ?, ?, ?, 'run-1', ?)`,
  );
  insertCheckpoint.run(0, serialize(firstUser), null, null, 0);
  insertCheckpoint.run(1, serialize(secondUser), 2, secondUiHead, 7);
  database
    .query(
      `INSERT INTO commands
        (session_id, command_id, kind, run_id, request_fingerprint, request_json,
         side_effect_started, result_json, created_at)
       VALUES ('session-1', 'kept', 'prompt', 'run-1', 'hash', '{}', 1, '{}', ?)`,
    )
    .run(createdAt);
  database
    .query(
      `INSERT INTO session_todos (session_id, revision, todos_json, updated_at)
       VALUES ('session-1', 1, '[]', ?)`,
    )
    .run(createdAt);
  if (options.active) {
    const thirdUser = userMessage("user-3");
    insertNode.run(5, "model", 4, 5, serialize({ role: "user", content: "user-3" }), "model-5");
    insertNode.run(
      6,
      "model",
      5,
      6,
      serialize({ role: "assistant", content: "answer-3" }),
      "model-6",
    );
    insertNode.run(14, "ui", 13, 5, serialize(thirdUser), "ui-14");
    insertNode.run(
      15,
      "ui",
      14,
      6,
      serialize({
        id: "assistant-3",
        role: "assistant",
        parts: [{ type: "text", text: "answer-3" }],
      }),
      "ui-15",
    );
    insertCheckpoint.run(2, serialize(thirdUser), 4, 13, 9);
    database
      .query(
        `UPDATE session_transcript_heads SET model_head_id = 6, ui_head_id = 15
         WHERE session_id = 'session-1'`,
      )
      .run();
    database
      .query(
        `UPDATE sessions SET active_run_id = 'run-1', status = 'streaming' WHERE id = 'session-1'`,
      )
      .run();
    database
      .query("UPDATE runs SET status = 'active', finished_at = NULL WHERE id = 'run-1'")
      .run();
  }
  database.close();
  return { databasePath, directory };
}

describe("MiniLilacSqliteStore history schema", () => {
  it("creates one deferred root and reuses a canonical workspace without Git", async () => {
    const { directory, file } = await temporaryDatabasePath("mini-lilac-history-root-");
    const store = new MiniLilacSqliteStore(file);
    createSession(store, "session-1", directory);
    createSession(store, "session-2", path.join(directory, "."));

    const firstWorkspace = store.getWorkspaceForSession("session-1");
    expect(store.getWorkspaceForSession("session-2").id).toBe(firstWorkspace.id);
    expect(store.getCurrentHistoryState("session-1")).toMatchObject({
      sessionId: "session-1",
      workspaceId: firstWorkspace.id,
      modelHeadId: null,
      uiHeadId: null,
      workspaceStatus: "capture-deferred",
      workspaceUnavailableReason: null,
      origin: "root",
    });
    expect(store.getHistoryNavigation("session-1")).toMatchObject({
      canUndo: false,
      canRedo: false,
    });
    expect(store.listHistoryTopology("session-1").transitions).toEqual([]);
    expect(store.database.query("SELECT COUNT(*) AS count FROM workspaces").get()).toEqual({
      count: 1,
    });
    expect(store.database.query("PRAGMA user_version").get()).toEqual({
      user_version: MINI_LILAC_DATABASE_SCHEMA_VERSION,
    });
    expect(
      store.database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_checkpoints'")
        .get(),
    ).toBeNull();
    expect(
      store.database
        .query(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND (
             name LIKE '%claim%' OR name LIKE '%audit%' OR name LIKE '%notice%' OR
             name LIKE '%delivery%' OR name LIKE '%warning%'
           )`,
        )
        .all(),
    ).toEqual([]);
    store.close();
  });

  it("atomically commits and replays action-specific empty navigation results", async () => {
    const { directory, file } = await temporaryDatabasePath("mini-lilac-history-empty-");
    const store = new MiniLilacSqliteStore(file);
    createSession(store, "session-1", directory);
    const undoRequest = { kind: "undo", runId: null, payload: {} };
    store.reserveCommand("session-1", "undo-empty", undoRequest);
    const result = { status: "empty", clientCommandId: "undo-empty" } as const;
    expect(
      store.commitEmptyHistoryNavigation({
        sessionId: "session-1",
        commandId: "undo-empty",
        requestedAction: "undo",
        request: undoRequest,
        result,
      }),
    ).toMatchObject({ result, replayed: false });
    expect(
      store.commitEmptyHistoryNavigation({
        sessionId: "session-1",
        commandId: "undo-empty",
        requestedAction: "undo",
        request: undoRequest,
        result,
      }),
    ).toMatchObject({ result, replayed: true });
    const redoRequest = { kind: "redo", runId: null, payload: {} };
    store.reserveCommand("session-1", "redo-empty", redoRequest);
    expect(() =>
      store.commitEmptyHistoryNavigation({
        sessionId: "session-1",
        commandId: "redo-empty",
        requestedAction: "redo",
        request: redoRequest,
        result: {
          status: "redone",
          clientCommandId: "redo-empty",
          message: userMessage("not-empty"),
          historyStateId: "not-empty",
          filesystem: { status: "restored" },
        },
      }),
    ).toThrow("must persist an empty result");
    const malformedEmpty = {
      status: "empty",
      clientCommandId: "redo-empty",
      historyStateId: "unexpected-state",
    } as const;
    expect(() =>
      store.commitEmptyHistoryNavigation({
        sessionId: "session-1",
        commandId: "redo-empty",
        requestedAction: "redo",
        request: redoRequest,
        result: malformedEmpty,
      }),
    ).toThrow();
    expect(
      store.commitEmptyHistoryNavigation({
        sessionId: "session-1",
        commandId: "redo-empty",
        requestedAction: "redo",
        request: redoRequest,
        result: { status: "empty", clientCommandId: "redo-empty" },
      }).result,
    ).toEqual({ status: "empty", clientCommandId: "redo-empty" });
    expect(store.getHistoryNavigation("session-1")).toMatchObject({
      canUndo: false,
      canRedo: false,
    });
    expect(store.listHistoryOperations()).toEqual([]);
    store.close();
  });

  it("migrates quiescent v4 checkpoints across a rewritten model root", async () => {
    const { databasePath, directory } = await createV4Database();
    const legacy = new Database(databasePath, { strict: true });
    legacy
      .query(
        `INSERT INTO transcript_nodes
          (id, session_id, lane, parent_id, depth, value_json, hash)
         VALUES (30, 'session-1', 'model', NULL, 1, ?, 'rewritten-model-root')`,
      )
      .run(serialize({ role: "assistant", content: "compacted legacy context" }));
    legacy
      .query(
        "UPDATE session_transcript_heads SET model_head_id = 30 WHERE session_id = 'session-1'",
      )
      .run();
    legacy.close();

    const store = new MiniLilacSqliteStore(databasePath);
    const topology = store.listHistoryTopology("session-1");

    expect(topology.states.map((state) => state.origin)).toEqual([
      "migration",
      "turn-boundary",
      "turn-boundary",
    ]);
    expect(
      topology.states.every((state) => state.workspaceUnavailableReason === "legacy-migration"),
    ).toBe(true);
    expect(topology.transitions.map((transition) => transition.delivery)).toEqual([
      "prompt",
      "steer",
    ]);
    expect(topology.transitions.map((transition) => transition.userMessage?.id)).toEqual([
      "user-1",
      "user-2",
    ]);
    expect(topology.history.rootStateId === topology.states[0]?.id).toBe(true);
    expect(topology.history.currentStateId === topology.states[2]?.id).toBe(true);
    expect(store.getHistoryNavigation("session-1")).toMatchObject({
      canUndo: true,
      canRedo: false,
    });
    expect(store.findLatestUndoableUserTransition("session-1")?.userMessage?.id).toBe("user-2");
    expect(store.getLatestSelectedRootRun("session-1")?.id).toBe("run-1");
    expect(store.getTodos("session-1").revision).toBe(1);
    expect(store.getWorkspaceForSession("session-1").canonicalCwd).toBe(directory);
    expect(
      store.database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_checkpoints'")
        .get(),
    ).toBeNull();
    expect(store.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    store.close();
  });

  it("normalizes legacy data parts while migrating v4 transcript chains", async () => {
    const { databasePath } = await createV4Database({
      legacySessionParts: true,
      legacyCompactionParts: true,
      legacySessionOnlySuffix: true,
    });

    const store = new MiniLilacSqliteStore(databasePath);

    expect(store.database.query("PRAGMA user_version").get()).toEqual({
      user_version: MINI_LILAC_DATABASE_SCHEMA_VERSION,
    });
    expect(store.getUiMessages("session-1")).toEqual([
      userMessage("user-1"),
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "answer-1" }],
      },
      userMessage("user-2"),
      {
        id: "assistant-2",
        role: "assistant",
        parts: [
          {
            type: "data-compaction",
            id: "compaction-1",
            data: {
              source: "manual",
              reason: "manual",
              phase: "completed",
              outcome: "compacted",
              messageCountBefore: 20,
              messageCountAfter: 5,
              estimatedInputTokensBefore: 2_000,
              estimatedInputTokensAfter: 500,
            },
          },
          { type: "text", text: "answer-2" },
        ],
      },
    ]);
    const topology = store.listHistoryTopology("session-1");
    expect(topology.transitions.map((transition) => transition.userMessage?.id)).toEqual([
      "user-1",
      "user-2",
    ]);
    expect(
      topology.states
        .flatMap((state) => store.getHistoryStateUiMessages(state.id))
        .flatMap((message) => message.parts)
        .some((part) => part.type === "data-session"),
    ).toBe(false);
    expect(store.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      store.database.query("SELECT value_json FROM transcript_nodes WHERE id = 30").get(),
    ).not.toBeNull();
    expect(
      store.database
        .query("SELECT ui_head_id FROM session_transcript_heads WHERE session_id = 'session-1'")
        .get(),
    ).not.toEqual({ ui_head_id: 30 });
    store.close();
  });

  it("preserves an active migrated prompt across a rewritten model root and reopen", async () => {
    const { databasePath } = await createV4Database({ active: true });
    const legacy = new Database(databasePath, { strict: true });
    legacy
      .query(
        `INSERT INTO transcript_nodes
          (id, session_id, lane, parent_id, depth, value_json, hash)
         VALUES (30, 'session-1', 'model', NULL, 1, ?, 'active-rewritten-model-root')`,
      )
      .run(serialize({ role: "assistant", content: "compacted active context" }));
    legacy
      .query(
        "UPDATE session_transcript_heads SET model_head_id = 30 WHERE session_id = 'session-1'",
      )
      .run();
    legacy.close();

    const migrated = new MiniLilacSqliteStore(databasePath);
    const topology = migrated.listHistoryTopology("session-1");
    expect(migrated.getSession("session-1")).toMatchObject({
      status: "streaming",
      activeRunId: "run-1",
    });
    expect(migrated.getRun("run-1").status).toBe("active");
    expect(migrated.getActiveRootRun("session-1")?.id).toBe("run-1");
    expect(migrated.getLatestSelectedRootRun("session-1")?.id).toBe("run-1");
    expect(topology.states).toHaveLength(3);
    expect(
      topology.transitions.map((transition) => ({
        delivery: transition.delivery,
        open: transition.toStateId === null,
      })),
    ).toEqual([
      { delivery: "prompt", open: false },
      { delivery: "steer", open: false },
      { delivery: "steer", open: true },
    ]);
    expect(topology.history.currentStateId === topology.states[2]?.id).toBe(true);
    migrated.close();

    const reopened = new MiniLilacSqliteStore(databasePath);
    expect(reopened.getSession("session-1")).toMatchObject({
      status: "streaming",
      activeRunId: "run-1",
    });
    expect(reopened.getRun("run-1").status).toBe("active");
    expect(reopened.listHistoryTopology("session-1").transitions.at(-1)?.toStateId).toBeNull();
    reopened.close();
  });

  it("falls back to one current state for unusual readable quiescent ordering", async () => {
    const { databasePath } = await createV4Database({ unusual: true });
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const store = new MiniLilacSqliteStore(databasePath);
      const topology = store.listHistoryTopology("session-1");
      expect(topology.states).toHaveLength(1);
      expect(topology.states[0]).toMatchObject({
        modelHeadId: 4,
        uiHeadId: 13,
        origin: "migration",
        workspaceUnavailableReason: "legacy-migration",
      });
      expect(topology.transitions).toEqual([]);
      expect(topology.history.undoFloorStateId).toBe(topology.history.currentStateId);
      expect(warning).toHaveBeenCalledTimes(1);
      store.close();
    } finally {
      warning.mockRestore();
    }
  });

  it("rolls back v4 migration on structural transcript corruption", async () => {
    const { databasePath } = await createV4Database();
    const database = new Database(databasePath, { strict: true });
    database.exec("PRAGMA foreign_keys = OFF;");
    database.query("DELETE FROM transcript_nodes WHERE id = 4").run();
    database.close();

    expect(() => new MiniLilacSqliteStore(databasePath)).toThrow("foreign key violation");
    const unchanged = new Database(databasePath, { strict: true });
    expect(unchanged.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    expect(
      unchanged
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'history_states'")
        .get(),
    ).toBeNull();
    unchanged.close();
  });

  it("rolls back v4 migration when active-run ownership is invalid", async () => {
    const { databasePath } = await createV4Database();
    const database = new Database(databasePath, { strict: true });
    database
      .query(
        "UPDATE sessions SET active_run_id = 'run-1', status = 'streaming' WHERE id = 'session-1'",
      )
      .run();
    database.close();

    expect(() => new MiniLilacSqliteStore(databasePath)).toThrow("invalid active root run");
    const unchanged = new Database(databasePath, { strict: true });
    expect(unchanged.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    expect(
      unchanged
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'history_states'")
        .get(),
    ).toBeNull();
    unchanged.close();
  });

  it("rejects a noncontiguous active checkpoint suffix", async () => {
    const { databasePath } = await createV4Database({ active: true });
    const database = new Database(databasePath, { strict: true });
    database
      .query(
        `INSERT INTO runs
          (id, session_id, profile, depth, status, started_at, finished_at)
         VALUES ('run-2', 'session-1', 'reader', 0, 'completed', ?, ?)`,
      )
      .run("2026-07-29T00:00:03.000Z", "2026-07-29T00:00:04.000Z");
    database.query("UPDATE user_checkpoints SET root_run_id = 'run-2' WHERE ui_position = 1").run();
    database.close();

    expect(() => new MiniLilacSqliteStore(databasePath)).toThrow(
      "cannot recover its active run from v4 checkpoints",
    );
    const unchanged = new Database(databasePath, { strict: true });
    expect(unchanged.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    unchanged.close();
  });

  it("commits durable undo/redo and retains a sibling branch after a new prompt", async () => {
    const { directory, file } = await temporaryDatabasePath("mini-lilac-history-branch-");
    const store = new MiniLilacSqliteStore(file);
    createSession(store, "session-1", directory);
    const firstUser = userMessage("user-a");
    admitPrompt(store, {
      sessionId: "session-1",
      runId: "run-a",
      commandId: "prompt-a",
      transitionId: "transition-a",
      message: firstUser,
      observationIds: { stateId: "observed-root", transitionId: "observe-root" },
    });
    finalizePrompt(store, {
      sessionId: "session-1",
      runId: "run-a",
      transitionId: "transition-a",
      destinationStateId: "state-a",
      user: firstUser,
    });
    store.reserveCommand("session-1", "undo-a", { kind: "undo", runId: null, payload: {} });
    expect(
      store.reserveHistoryOperation({
        id: "operation-undo-a",
        sessionId: "session-1",
        commandId: "undo-a",
        requestedAction: "undo",
        expectedSourceStateId: "state-a",
        targetStateId: "observed-root",
        userTransitionId: "transition-a",
        filesystemMode: "skip",
        skipReason: "git-unavailable",
        observation: {
          stateId: "observed-drift-a",
          transitionId: "observe-drift-a",
          ...unavailableWorkspace,
        },
      }).observedState,
    ).toMatchObject({ id: "observed-drift-a" });
    const undoResult = {
      status: "undone",
      clientCommandId: "undo-a",
      message: firstUser,
      historyStateId: "observed-root",
      filesystem: { status: "skipped", reason: "git-unavailable" },
    } as const;
    expect(() =>
      store.commitHistoryNavigation({
        operationId: "operation-undo-a",
        result: { ...undoResult, status: "redone" },
      }),
    ).toThrow("requires a 'undone'");
    expect(() =>
      store.commitHistoryNavigation({
        operationId: "operation-undo-a",
        result: { ...undoResult, historyStateId: "wrong-state" },
      }),
    ).toThrow("names the wrong state");
    expect(() =>
      store.commitHistoryNavigation({
        operationId: "operation-undo-a",
        result: {
          ...undoResult,
          filesystem: { status: "skipped", reason: "snapshot-unavailable" },
        },
      }),
    ).toThrow("wrong filesystem outcome");
    store.database.exec(`
      CREATE TRIGGER reject_navigation_result BEFORE UPDATE OF result_json ON commands
      WHEN NEW.command_id = 'undo-a'
      BEGIN SELECT RAISE(ABORT, 'reject navigation result'); END;
    `);
    expect(() =>
      store.commitHistoryNavigation({
        operationId: "operation-undo-a",
        result: undoResult,
      }),
    ).toThrow("reject navigation result");
    expect(store.getCurrentHistoryState("session-1").id).toBe("state-a");
    expect(store.peekHistoryRedo("session-1")).toBeNull();
    expect(store.getHistoryOperation("operation-undo-a")?.id).toBe("operation-undo-a");
    store.database.exec("DROP TRIGGER reject_navigation_result;");
    store.commitHistoryNavigation({
      operationId: "operation-undo-a",
      result: undoResult,
    });
    expect(
      store.getCommandResult("session-1", "undo-a", { kind: "undo", runId: null, payload: {} }),
    ).toEqual(undoResult);
    expect(store.peekHistoryRedo("session-1")?.targetStateId).toBe("observed-drift-a");
    expect(store.getHistoryAccounting()).toEqual({
      stateCount: 4,
      transitionCount: 3,
      branchTipCount: 1,
      snapshotCount: 0,
      redoStackCount: 1,
      activeOperationCount: 0,
      pendingFinalizationCount: 0,
    });
    const metadata = store.getHistoryStoreMetadata();
    store.close();

    const reopened = new MiniLilacSqliteStore(file);
    expect(reopened.getHistoryStoreMetadata()).toEqual(metadata);
    expect(reopened.getHistoryNavigation("session-1")).toEqual({
      currentStateId: "observed-root",
      canUndo: false,
      canRedo: true,
    });
    reopened.reserveCommand("session-1", "redo-a", { kind: "redo", runId: null, payload: {} });
    reopened.reserveHistoryOperation({
      id: "operation-redo-a",
      sessionId: "session-1",
      commandId: "redo-a",
      requestedAction: "redo",
      expectedSourceStateId: "observed-root",
      targetStateId: "observed-drift-a",
      userTransitionId: "transition-a",
      filesystemMode: "restore",
      skipReason: null,
    });
    reopened.updateHistoryOperationPhase("operation-redo-a", "restoring");
    reopened.updateHistoryOperationPhase("operation-redo-a", "verified");
    const redoResult = {
      status: "redone",
      clientCommandId: "redo-a",
      message: firstUser,
      historyStateId: "observed-drift-a",
      filesystem: { status: "restored" },
    } as const;
    reopened.commitHistoryNavigation({
      operationId: "operation-redo-a",
      result: redoResult,
    });
    expect(
      reopened.getCommandResult("session-1", "redo-a", {
        kind: "redo",
        runId: null,
        payload: {},
      }),
    ).toEqual(redoResult);
    reopened.reserveCommand("session-1", "undo-again", { kind: "undo", runId: null, payload: {} });
    reopened.reserveHistoryOperation({
      id: "operation-undo-again",
      sessionId: "session-1",
      commandId: "undo-again",
      requestedAction: "undo",
      expectedSourceStateId: "observed-drift-a",
      targetStateId: "observed-root",
      userTransitionId: "transition-a",
      filesystemMode: "skip",
      skipReason: "git-unavailable",
    });
    reopened.commitHistoryNavigation({
      operationId: "operation-undo-again",
      result: {
        status: "undone",
        clientCommandId: "undo-again",
        message: firstUser,
        historyStateId: "observed-root",
        filesystem: { status: "skipped", reason: "git-unavailable" },
      },
    });
    const secondUser = userMessage("user-b");
    admitPrompt(reopened, {
      sessionId: "session-1",
      runId: "run-b",
      commandId: "prompt-b",
      transitionId: "transition-b",
      message: secondUser,
    });
    finalizePrompt(reopened, {
      sessionId: "session-1",
      runId: "run-b",
      transitionId: "transition-b",
      destinationStateId: "state-b",
      user: secondUser,
    });
    reopened.database
      .query("UPDATE runs SET undone_at = ? WHERE id = 'run-b'")
      .run(new Date().toISOString());
    expect(reopened.getLatestSelectedRootRun("session-1")?.id).toBe("run-b");
    expect(reopened.peekHistoryRedo("session-1")).toBeNull();
    expect(reopened.getHistoryAccounting()).toEqual({
      stateCount: 5,
      transitionCount: 4,
      branchTipCount: 2,
      snapshotCount: 0,
      redoStackCount: 0,
      activeOperationCount: 0,
      pendingFinalizationCount: 0,
    });
    reopened.database
      .query(
        `INSERT INTO history_redo_stack
          (session_id, position, target_state_id, user_transition_id, created_at)
         VALUES ('session-1', 0, 'state-b', 'transition-a', ?)`,
      )
      .run(new Date().toISOString());
    reopened.reserveCommand("session-1", "redo-malformed", {
      kind: "redo",
      runId: null,
      payload: {},
    });
    expect(() =>
      reopened.reserveHistoryOperation({
        id: "operation-redo-malformed",
        sessionId: "session-1",
        commandId: "redo-malformed",
        requestedAction: "redo",
        expectedSourceStateId: "state-b",
        targetStateId: "state-b",
        userTransitionId: "transition-a",
        filesystemMode: "skip",
        skipReason: "git-unavailable",
      }),
    ).toThrow("Redo target must descend");
    expect(reopened.listHistoryTopology("session-1").states.map((state) => state.id)).toContain(
      "state-a",
    );
    expect(reopened.listHistoryTopology("session-1").states.map((state) => state.id)).toContain(
      "state-b",
    );
    reopened.close();
  });

  it("commits ordered steering model and UI prefixes before finalization", async () => {
    const { directory, file } = await temporaryDatabasePath("mini-lilac-history-steering-");
    const store = new MiniLilacSqliteStore(file);
    createSession(store, "session-1", directory);
    const prompt = userMessage("prompt");
    admitPrompt(store, {
      sessionId: "session-1",
      runId: "run-1",
      commandId: "prompt-command",
      transitionId: "prompt-transition",
      message: prompt,
      observationIds: { stateId: "observed-root", transitionId: "observe-root" },
    });
    const steer1 = userMessage("steer-1");
    const steer2 = userMessage("steer-2");
    for (const [commandId, message] of [
      ["steer-command-1", steer1],
      ["steer-command-2", steer2],
    ] as const) {
      const request = {
        kind: "steer",
        runId: "run-1",
        payload: {
          message,
          sessionId: "session-1",
          runId: "run-1",
          clientCommandId: commandId,
        },
      };
      store.reserveCommand("session-1", commandId, request);
      store.markCommandSideEffectStarted("session-1", commandId, request);
      store.saveCommandResult("session-1", commandId, request, { status: "queued" });
    }
    store.updateSessionState("session-1", "streaming", 2, "run-1");
    const steeringBoundary = {
      sessionId: "session-1",
      rootRunId: "run-1",
      previousOpenTransitionId: "prompt-transition",
      boundaryStateId: "prompt-destination",
      workspace: unavailableWorkspace,
      mergedModelMessages: [
        { role: "user", content: "prompt" },
        { role: "user", content: "steer-1" },
        { role: "user", content: "steer-2" },
      ],
      uiMessages: [prompt, steer1, steer2],
      entries: [
        {
          commandId: "steer-command-1",
          transitionId: "steer-transition-1",
          message: steer1,
          modelMessage: { role: "user", content: "steer-1" },
          replayAfterSeq: 4,
          intermediateStateId: "steer-intermediate",
        },
        {
          commandId: "steer-command-2",
          transitionId: "steer-transition-2",
          message: steer2,
          modelMessage: { role: "user", content: "steer-2" },
          replayAfterSeq: 4,
        },
      ],
    } as const;
    expect(() =>
      store.commitSteeringHistoryBoundary({
        ...steeringBoundary,
        entries: [
          { ...steeringBoundary.entries[0], commandId: "steer-command-2" },
          { ...steeringBoundary.entries[1], commandId: "steer-command-1" },
        ],
      }),
    ).toThrow("request does not match its boundary entry");
    expect(store.listHistoryTopology("session-1").transitions.at(-1)).toMatchObject({
      id: "prompt-transition",
      toStateId: null,
    });
    const boundary = store.commitSteeringHistoryBoundary(steeringBoundary);
    expect(boundary).toMatchObject({
      currentState: { id: "steer-intermediate" },
      openTransition: { id: "steer-transition-2", toStateId: null },
    });
    expect(store.getHistoryStateModelMessages("prompt-destination")).toEqual([
      { role: "user", content: "prompt" },
    ]);
    expect(store.getHistoryStateUiMessages("prompt-destination")).toEqual([prompt]);
    expect(store.getHistoryStateModelMessages("steer-intermediate")).toEqual([
      { role: "user", content: "prompt" },
      { role: "user", content: "steer-1" },
    ]);
    expect(store.getHistoryStateUiMessages("steer-intermediate")).toEqual([prompt, steer1]);
    expect(store.getModelMessages("session-1")).toEqual([...steeringBoundary.mergedModelMessages]);
    expect(store.getUiMessages("session-1")).toEqual([prompt, steer1, steer2]);
    const assistant = {
      id: "assistant-final",
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "done" }],
    };
    expect(() =>
      store.reservePendingRunFinalization({
        runId: "run-1",
        sessionId: "session-1",
        openTransitionId: "steer-transition-2",
        modelMessages: [],
        uiMessages: [],
        runStatus: "completed",
        sessionStatus: "idle",
        error: null,
        terminalResult: undefined,
        inputTokens: null,
      }),
    ).toThrow("does not extend the canonical active transcript");
    expect(store.getPendingRunFinalization("run-1")).toBeNull();
    expect(() =>
      store.reservePendingRunFinalization({
        runId: "run-1",
        sessionId: "session-1",
        openTransitionId: "steer-transition-2",
        modelMessages: steeringBoundary.mergedModelMessages,
        uiMessages: [prompt, steer1, userMessage("stale-steer")],
        runStatus: "completed",
        sessionStatus: "idle",
        error: null,
        terminalResult: undefined,
        inputTokens: null,
      }),
    ).toThrow("Final UI transcript does not extend");
    expect(store.getPendingRunFinalization("run-1")).toBeNull();
    store.reservePendingRunFinalization({
      runId: "run-1",
      sessionId: "session-1",
      openTransitionId: "steer-transition-2",
      modelMessages: [
        { role: "assistant", content: "automatic compaction summary" },
        { role: "assistant", content: "done" },
      ],
      uiMessages: [prompt, steer1, steer2, assistant],
      runStatus: "completed",
      sessionStatus: "idle",
      error: null,
      terminalResult: { status: "done" },
      inputTokens: 5,
    });
    const finalized = store.commitPendingRunFinalization({
      runId: "run-1",
      destinationStateId: "final-state",
      ...unavailableWorkspace,
    });
    expect(finalized).toMatchObject({
      state: { id: "final-state" },
      snapshot: { status: "idle", activeRunId: null },
    });
    expect(store.getModelMessages("session-1")).toEqual([
      { role: "assistant", content: "automatic compaction summary" },
      { role: "assistant", content: "done" },
    ]);
    expect(
      store.listHistoryTopology("session-1").transitions.map((transition) => transition.delivery),
    ).toEqual([null, "prompt", "steer", "steer"]);
    store.close();
  });

  it("enforces journal exclusion and atomic acknowledged abandonment", async () => {
    const { directory, file } = await temporaryDatabasePath("mini-lilac-history-journal-");
    const store = new MiniLilacSqliteStore(file);
    createSession(store, "session-1", directory);
    createSession(store, "session-2", directory);
    expect(store.getWorkspaceForSession("session-2").id).toBe(
      store.getWorkspaceForSession("session-1").id,
    );
    const workspaceId = store.getWorkspaceForSession("session-1").id;
    expect(() => store.assertWorkspaceHistoryAvailable("session-1")).not.toThrow();
    expect(() => store.assertWorkspaceHistoryAvailable("session-2")).not.toThrow();
    const user1 = userMessage("user-1");
    admitPrompt(store, {
      sessionId: "session-1",
      runId: "run-1",
      commandId: "prompt-1",
      transitionId: "transition-1",
      message: user1,
      observationIds: { stateId: "observed-1", transitionId: "observe-1" },
    });
    finalizePrompt(store, {
      sessionId: "session-1",
      runId: "run-1",
      transitionId: "transition-1",
      destinationStateId: "state-1",
      user: user1,
    });
    const user2 = userMessage("user-2");
    admitPrompt(store, {
      sessionId: "session-2",
      runId: "run-2",
      commandId: "prompt-2",
      transitionId: "transition-2",
      message: user2,
      observationIds: { stateId: "observed-2", transitionId: "observe-2" },
    });
    store.reserveCommand("session-1", "undo-1", { kind: "undo", runId: null, payload: {} });
    const reserved = store.reserveHistoryOperation({
      id: "operation-1",
      sessionId: "session-1",
      commandId: "undo-1",
      requestedAction: "undo",
      expectedSourceStateId: "state-1",
      targetStateId: "observed-1",
      userTransitionId: "transition-1",
      filesystemMode: "skip",
      skipReason: "git-unavailable",
      observation: {
        stateId: "drift-state",
        transitionId: "drift-transition",
        ...unavailableWorkspace,
      },
    });
    expect(reserved.observedState?.id).toBe("drift-state");
    expect(store.getHistoryAccounting(workspaceId)).toMatchObject({
      activeOperationCount: 1,
      pendingFinalizationCount: 0,
    });
    expect(() => store.assertWorkspaceHistoryAvailable("session-1")).toThrow(
      "retained history operation",
    );
    expect(() => store.assertWorkspaceHistoryAvailable("session-2")).toThrow(
      "retained history operation",
    );
    expect(() =>
      store.assertWorkspaceHistoryAvailable("session-1", {
        kind: "history-operation",
        operationId: "operation-1",
      }),
    ).not.toThrow();
    expect(() =>
      store.assertWorkspaceHistoryAvailable("session-2", {
        kind: "history-operation",
        operationId: "operation-1",
      }),
    ).toThrow("retained history operation");
    expect(store.listHistoryOperations()).toHaveLength(1);
    expect(() =>
      store.reservePendingRunFinalization({
        runId: "run-2",
        sessionId: "session-2",
        openTransitionId: "transition-2",
        modelMessages: [{ role: "user", content: "user-2" }],
        uiMessages: [user2],
        runStatus: "completed",
        sessionStatus: "idle",
        error: null,
        terminalResult: undefined,
        inputTokens: null,
      }),
    ).toThrow("retained history operation");
    const abandoned = store.abandonHistoryNavigation({
      operationId: "operation-1",
      acknowledgePartialWorktree: true,
      message: "operator accepted the partial worktree",
    });
    expect(abandoned.code).toBe("history-recovery-abandoned");
    expect(store.getCurrentHistoryState("session-1").id).toBe("state-1");
    expect(store.getHistoryOperation("operation-1")).toBeNull();
    expect(
      store.getCommandResult("session-1", "undo-1", { kind: "undo", runId: null, payload: {} }),
    ).toEqual(abandoned);
    store.reservePendingRunFinalization({
      runId: "run-2",
      sessionId: "session-2",
      openTransitionId: "transition-2",
      modelMessages: [{ role: "user", content: "user-2" }],
      uiMessages: [user2],
      runStatus: "completed",
      sessionStatus: "idle",
      error: null,
      terminalResult: undefined,
      inputTokens: null,
    });
    expect(store.getHistoryAccounting(workspaceId)).toMatchObject({
      activeOperationCount: 0,
      pendingFinalizationCount: 1,
    });
    expect(() => store.assertWorkspaceHistoryAvailable("session-1")).toThrow(
      "pending run finalization",
    );
    expect(() => store.assertWorkspaceHistoryAvailable("session-2")).toThrow(
      "pending run finalization",
    );
    expect(() =>
      store.assertWorkspaceHistoryAvailable("session-2", {
        kind: "pending-run-finalization",
        runId: "run-2",
      }),
    ).not.toThrow();
    expect(() =>
      store.assertWorkspaceHistoryAvailable("session-1", {
        kind: "pending-run-finalization",
        runId: "run-2",
      }),
    ).toThrow("pending run finalization");
    expect(() =>
      store.assertWorkspaceHistoryAvailable("session-2", {
        kind: "pending-run-finalization",
        runId: "wrong-run",
      }),
    ).toThrow("pending run finalization");
    store.reserveCommand("session-1", "undo-blocked", { kind: "undo", runId: null, payload: {} });
    expect(() =>
      store.reserveHistoryOperation({
        id: "operation-blocked",
        sessionId: "session-1",
        commandId: "undo-blocked",
        requestedAction: "undo",
        expectedSourceStateId: "state-1",
        targetStateId: "observed-1",
        userTransitionId: "transition-1",
        filesystemMode: "skip",
        skipReason: "git-unavailable",
      }),
    ).toThrow("pending run finalization");
    store.database
      .query("UPDATE workspaces SET health_status = 'corrupt', health_detail = ? WHERE id = ?")
      .run("test corruption", workspaceId);
    expect(() =>
      store.assertWorkspaceHistoryAvailable("session-2", {
        kind: "pending-run-finalization",
        runId: "run-2",
      }),
    ).toThrow("history store is corrupt");
    expect(() =>
      store.commitPendingRunFinalization({
        runId: "run-2",
        destinationStateId: "state-2",
        ...unavailableWorkspace,
      }),
    ).toThrow("history store is corrupt");
    expect(store.getPendingRunFinalization("run-2")?.runId).toBe("run-2");
    store.database
      .query("UPDATE workspaces SET health_status = 'healthy', health_detail = NULL WHERE id = ?")
      .run(workspaceId);
    store.commitPendingRunFinalization({
      runId: "run-2",
      destinationStateId: "state-2",
      ...unavailableWorkspace,
    });
    store.close();
  });

  it("scopes snapshot refs and accounting to exact workspaces", async () => {
    const first = await temporaryDatabasePath("mini-lilac-history-accounting-a-");
    const secondDirectory = await mkdtemp(path.join(tmpdir(), "mini-lilac-history-accounting-b-"));
    temporaryDirectories.push(secondDirectory);
    const store = new MiniLilacSqliteStore(first.file);
    createSession(store, "session-1", first.directory);
    createSession(store, "session-2", secondDirectory);
    const workspace1 = store.getWorkspaceForSession("session-1");
    const workspace2 = store.getWorkspaceForSession("session-2");
    const sharedRef = "refs/mini-lilac/snapshots/private-name";

    store.createOrReuseWorkspaceSnapshot({
      id: "snapshot-1",
      workspaceId: workspace1.id,
      rootTreeOid: "tree-1",
      gitRef: sharedRef,
      formatVersion: 1,
    });
    store.createOrReuseWorkspaceSnapshot({
      id: "snapshot-2",
      workspaceId: workspace2.id,
      rootTreeOid: "tree-2",
      gitRef: sharedRef,
      formatVersion: 1,
    });
    expect(() =>
      store.createOrReuseWorkspaceSnapshot({
        id: "snapshot-duplicate-ref",
        workspaceId: workspace1.id,
        rootTreeOid: "tree-duplicate-ref",
        gitRef: sharedRef,
        formatVersion: 1,
      }),
    ).toThrow("UNIQUE constraint failed");

    const emptyJournalAccounting = {
      transitionCount: 0,
      branchTipCount: 1,
      snapshotCount: 1,
      redoStackCount: 0,
      activeOperationCount: 0,
      pendingFinalizationCount: 0,
    };
    expect(store.getHistoryAccounting(workspace1.id)).toEqual({
      stateCount: 1,
      ...emptyJournalAccounting,
    });
    expect(store.getHistoryAccounting(workspace2.id)).toEqual({
      stateCount: 1,
      ...emptyJournalAccounting,
    });
    expect(store.getHistoryAccounting()).toEqual({
      stateCount: 2,
      transitionCount: 0,
      branchTipCount: 2,
      snapshotCount: 2,
      redoStackCount: 0,
      activeOperationCount: 0,
      pendingFinalizationCount: 0,
    });
    expect(() => store.getHistoryAccounting("missing-workspace")).toThrow(
      "Workspace 'missing-workspace' was not found",
    );
    expect(() => store.getHistoryAccounting("")).toThrow();
    store.close();
  });

  it("adds workspace-private snapshot ref uniqueness during v4 migration", async () => {
    const { databasePath } = await createV4Database();
    const secondDirectory = await mkdtemp(path.join(tmpdir(), "mini-lilac-migrated-ref-b-"));
    temporaryDirectories.push(secondDirectory);
    const store = new MiniLilacSqliteStore(databasePath);
    createSession(store, "session-2", secondDirectory);
    const workspace1 = store.getWorkspaceForSession("session-1");
    const workspace2 = store.getWorkspaceForSession("session-2");
    const sharedRef = "refs/mini-lilac/snapshots/migrated-private-name";

    store.createOrReuseWorkspaceSnapshot({
      id: "migrated-snapshot-1",
      workspaceId: workspace1.id,
      rootTreeOid: "migrated-tree-1",
      gitRef: sharedRef,
      formatVersion: 1,
    });
    store.createOrReuseWorkspaceSnapshot({
      id: "migrated-snapshot-2",
      workspaceId: workspace2.id,
      rootTreeOid: "migrated-tree-2",
      gitRef: sharedRef,
      formatVersion: 1,
    });
    expect(() =>
      store.createOrReuseWorkspaceSnapshot({
        id: "migrated-snapshot-duplicate",
        workspaceId: workspace1.id,
        rootTreeOid: "migrated-tree-duplicate",
        gitRef: sharedRef,
        formatVersion: 1,
      }),
    ).toThrow("UNIQUE constraint failed");
    expect(
      store.database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_checkpoints'")
        .get(),
    ).toBeNull();
    store.close();
  });

  it("reuses snapshots and commits compaction without legacy cursor mutation APIs", async () => {
    const { directory, file } = await temporaryDatabasePath("mini-lilac-history-snapshot-");
    const store = new MiniLilacSqliteStore(file);
    createSession(store, "session-1", directory);
    const workspace = store.getWorkspaceForSession("session-1");
    const first = store.createOrReuseWorkspaceSnapshot({
      id: "snapshot-1",
      workspaceId: workspace.id,
      rootTreeOid: "tree-oid",
      gitRef: "refs/mini-lilac/snapshots/snapshot-1",
      formatVersion: 1,
    });
    expect(
      store.createOrReuseWorkspaceSnapshot({
        id: "snapshot-2",
        workspaceId: workspace.id,
        rootTreeOid: "tree-oid",
        gitRef: "refs/mini-lilac/snapshots/snapshot-2",
        formatVersion: 1,
      }),
    ).toEqual(first);
    expect(store.getWorkspaceSnapshot(first.id)).toEqual(first);
    expect(store.getWorkspaceSnapshot("missing-snapshot")).toBeNull();
    expect(store.listWorkspaces()).toContainEqual(workspace);
    expect(store.listWorkspaceSnapshots(workspace.id)).toEqual([first]);
    expect(store.listWorkspaceSnapshotGroups()).toEqual([{ workspace, snapshots: [first] }]);
    store.setWorkspaceSnapshotAvailability({
      workspaceId: workspace.id,
      updates: [
        {
          snapshotId: first.id,
          availability: "missing",
          detail: "test snapshot missing",
        },
      ],
    });
    expect(store.getWorkspaceSnapshot(first.id)).toMatchObject({
      id: first.id,
      rootTreeOid: "tree-oid",
      availability: "missing",
      availabilityDetail: "test snapshot missing",
    });
    expect(
      store.createOrReuseWorkspaceSnapshot({
        id: "snapshot-heal",
        workspaceId: workspace.id,
        rootTreeOid: "tree-oid",
        gitRef: "refs/mini-lilac/snapshots/healed",
        formatVersion: 1,
      }),
    ).toMatchObject({
      id: first.id,
      availability: "available",
      availabilityDetail: null,
      gitRef: "refs/mini-lilac/snapshots/healed",
    });
    expect(() =>
      store.setWorkspaceSnapshotAvailability({
        workspaceId: workspace.id,
        updates: [
          {
            snapshotId: first.id,
            availability: "corrupt",
            detail: "must roll back",
          },
          {
            snapshotId: "unknown-snapshot",
            availability: "missing",
            detail: "not found",
          },
        ],
      }),
    ).toThrow("was not found");
    expect(store.getWorkspaceSnapshot(first.id)).toMatchObject({
      availability: "available",
      availabilityDetail: null,
    });
    const prompt = userMessage("prompt");
    admitPrompt(store, {
      sessionId: "session-1",
      runId: "run-1",
      commandId: "prompt-1",
      transitionId: "transition-1",
      message: prompt,
      observationIds: { stateId: "captured-root", transitionId: "capture-root" },
      observationWorkspace: {
        workspaceSnapshotId: first.id,
        workspaceStatus: "captured",
        workspaceUnavailableReason: null,
      },
    });
    finalizePrompt(store, {
      sessionId: "session-1",
      runId: "run-1",
      transitionId: "transition-1",
      destinationStateId: "state-1",
      user: prompt,
    });
    const topologyBeforeNoops = store.listHistoryTopology("session-1");
    for (const status of ["empty", "noop"] as const) {
      const commandId = `compact-${status}`;
      const request = { kind: "compact", runId: null, payload: { status } };
      const result = {
        status,
        clientCommandId: commandId,
        messageCountBefore: status === "empty" ? 0 : 2,
        messageCountAfter: status === "empty" ? 0 : 2,
        estimatedInputTokensBefore: 2,
        estimatedInputTokensAfter: 2,
      } as const;
      store.reserveCommand("session-1", commandId, request);
      const unchanged = store.commitHistoryCompaction({
        sessionId: "session-1",
        commandId,
        request,
        expectedCurrentStateId: "state-1",
        stateId: `unused-state-${status}`,
        transitionId: `unused-transition-${status}`,
        modelMessages: [],
        compactionEvent: {
          source: "manual",
          reason: "manual",
          phase: "completed",
          outcome: status,
          messageCountBefore: result.messageCountBefore,
          messageCountAfter: result.messageCountAfter,
          estimatedInputTokensBefore: result.estimatedInputTokensBefore,
          estimatedInputTokensAfter: result.estimatedInputTokensAfter,
        },
        result,
        ...unavailableWorkspace,
      });
      expect(unchanged.state.id).toBe("state-1");
      expect(store.listHistoryTopology("session-1")).toEqual(topologyBeforeNoops);
      expect(store.getSession("session-1")).toMatchObject({
        inputTokens: 2,
        inputTokensEstimated: false,
      });
    }
    const compactRequest = { kind: "compact", runId: null, payload: { source: "manual" } };
    store.reserveCommand("session-1", "compact-1", compactRequest);
    const uiBeforeCompaction = store.getUiMessages("session-1");
    const compactionEvent = {
      source: "manual",
      reason: "manual",
      phase: "completed",
      outcome: "compacted",
      messageCountBefore: 2,
      messageCountAfter: 1,
      estimatedInputTokensBefore: 2,
      estimatedInputTokensAfter: 1,
      summary: "summary",
    } as const;
    const compactInput = {
      sessionId: "session-1",
      commandId: "compact-1",
      request: compactRequest,
      expectedCurrentStateId: "state-1",
      stateId: "compacted-state",
      transitionId: "compaction-transition",
      modelMessages: [{ role: "assistant", content: "summary" }],
      compactionEvent,
      result: {
        status: "compacted",
        clientCommandId: "compact-1",
        messageCountBefore: 2,
        messageCountAfter: 1,
        estimatedInputTokensBefore: 2,
        estimatedInputTokensAfter: 1,
      },
      ...unavailableWorkspace,
    } as const;
    const replacementInput = {
      ...compactInput,
      uiMessages: [userMessage("replacement")],
    };
    expect(() => store.commitHistoryCompaction(replacementInput)).toThrow(
      "does not accept a replacement UI transcript",
    );
    expect(store.getCurrentHistoryState("session-1").id).toBe("state-1");
    expect(store.getUiMessages("session-1")).toEqual(uiBeforeCompaction);
    expect(
      store.database
        .query(
          `SELECT side_effect_started, result_json FROM commands
           WHERE session_id = 'session-1' AND command_id = 'compact-1'`,
        )
        .get(),
    ).toEqual({ side_effect_started: 0, result_json: null });

    const compacted = store.commitHistoryCompaction(compactInput);
    expect(compacted.state.id).toBe("compacted-state");
    expect(store.getUiMessages("session-1")).toEqual([
      ...uiBeforeCompaction,
      {
        id: "compaction:compact-1",
        role: "assistant",
        parts: [{ type: "data-compaction", id: "compact-1", data: compactionEvent }],
      },
    ]);
    expect(store.getSessionHistory("session-1").undoFloorStateId).toBe("compacted-state");
    expect(store.getSession("session-1")).toMatchObject({
      inputTokens: 1,
      inputTokensEstimated: true,
    });
    expect(() =>
      store.database.query("DELETE FROM workspace_snapshots WHERE id = ?").run(first.id),
    ).toThrow("FOREIGN KEY constraint failed");
    store.close();
  });

  it("enforces composite foreign keys and one incoming topology edge", async () => {
    const first = await temporaryDatabasePath("mini-lilac-history-fk-a-");
    const second = await mkdtemp(path.join(tmpdir(), "mini-lilac-history-fk-b-"));
    temporaryDirectories.push(second);
    const store = new MiniLilacSqliteStore(first.file);
    createSession(store, "session-1", first.directory);
    createSession(store, "session-2", second);
    const workspace2 = store.getWorkspaceForSession("session-2");
    expect(() =>
      store.database
        .query(
          `INSERT INTO history_states
            (id, session_id, workspace_id, workspace_status, origin, created_at)
           VALUES ('cross-workspace', 'session-1', ?, 'capture-deferred', 'root', ?)`,
        )
        .run(workspace2.id, new Date().toISOString()),
    ).toThrow("FOREIGN KEY constraint failed");
    const wrongMessage = userMessage("wrong-command");
    store.reserveCommand("session-2", "wrong-command", {
      kind: "steer",
      runId: null,
      payload: { messageId: wrongMessage.id },
    });
    expect(() =>
      store.admitRootPromptHistory({
        run: { id: "wrong-run", sessionId: "session-2", profile: "reader", depth: 0 },
        commandId: "wrong-command",
        commandPayload: { messageId: wrongMessage.id },
        transitionId: "wrong-transition",
        expectedCurrentStateId: store.getCurrentHistoryState("session-2").id,
        modelMessages: [{ role: "user", content: wrongMessage.id }],
        uiMessages: [wrongMessage],
        observation: {
          stateId: "wrong-observation",
          transitionId: "wrong-observation-transition",
          ...unavailableWorkspace,
        },
      }),
    ).toThrow("not an admissible reservation");
    expect(store.listHistoryTopology("session-2").states).toHaveLength(1);
    const prompt = userMessage("prompt");
    admitPrompt(store, {
      sessionId: "session-1",
      runId: "run-1",
      commandId: "prompt-1",
      transitionId: "transition-1",
      message: prompt,
      observationIds: { stateId: "observed-root", transitionId: "observe-root" },
    });
    finalizePrompt(store, {
      sessionId: "session-1",
      runId: "run-1",
      transitionId: "transition-1",
      destinationStateId: "destination",
      user: prompt,
    });
    const root = store.getSessionHistory("session-1").rootStateId;
    expect(() =>
      store.database
        .query(
          `INSERT INTO history_transitions
            (id, session_id, from_state_id, to_state_id, kind, created_at, completed_at)
           VALUES ('second-edge', 'session-1', ?, 'destination', 'workspace-observation', ?, ?)`,
        )
        .run(root, new Date().toISOString(), new Date().toISOString()),
    ).toThrow("UNIQUE constraint failed");
    expect(store.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    store.close();
  });
});
