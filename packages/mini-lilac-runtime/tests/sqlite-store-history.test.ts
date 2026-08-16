import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { hashCanonicalMessagesV1 } from "@stanley2058/lilac-agent";
import type { MiniLilacUserUIMessage } from "@stanley2058/mini-lilac-client";
import type { ModelMessage } from "ai";
import { Panic } from "better-result";
import superjson from "superjson";

import {
  MiniLilacSchemaInitializationCombinedFailure,
  MiniLilacSchemaMigrationFailure,
  MiniLilacSqliteDriverFailure,
} from "../src/sqlite-persistence-errors";
import {
  MINI_LILAC_DATABASE_SCHEMA_VERSION,
  MINI_MAIN_CLAUDE_ATTEMPT_RETENTION_LIMIT,
  MINI_NAMED_CLAUDE_ATTEMPT_RETENTION_LIMIT,
  MiniLilacSqliteStore,
  decodeMiniLilacStoreRow,
  type HistoryProviderState,
  type MiniNamedClaudeSessionBinding,
  type PromoteMiniMainClaudeSessionBinding,
  type PromoteMiniNamedClaudeSessionBinding,
} from "../src/sqlite-store";

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

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

const claudeProviderState = {
  lastFamily: "claude-code",
  containsCrossFamilyTurns: false,
} as const satisfies HistoryProviderState;

function reserveClaudeAttempt(
  store: MiniLilacSqliteStore,
  input: {
    sessionId: string;
    sourceHistoryStateId: string;
    requestId: string;
    candidateIndex: number;
    sourceSessionId?: string;
    expectedBindingRevision?: number;
  },
): void {
  store.reserveMiniMainClaudeSessionAttempt({
    providerId: "claude-provider",
    requestClient: "mini-test",
    lilacSessionId: input.sessionId,
    sourceHistoryStateId: input.sourceHistoryStateId,
    executionScopeHashVersion: 1,
    executionScopeHash: "scope-v1",
    requestId: input.requestId,
    attemptIndex: 0,
    candidateSessionId: testUuid(input.candidateIndex),
    sourceSessionId: input.sourceSessionId ?? null,
    expectedBindingRevision: input.expectedBindingRevision ?? null,
  });
}

function succeedClaudeAttempt(
  store: MiniLilacSqliteStore,
  sessionId: string,
  requestId: string,
): void {
  store.recordMiniMainClaudeSessionAttemptOutcome({
    providerId: "claude-provider",
    lilacSessionId: sessionId,
    requestId,
    attemptIndex: 0,
    state: "succeeded",
  });
}

function reserveNamedClaudeAttempt(
  store: MiniLilacSqliteStore,
  input: {
    sessionId: string;
    sourceHistoryStateId: string;
    requestId: string;
    candidateIndex: number;
    sourceSessionId?: string;
    expectedBindingRevision?: number;
  },
): void {
  store.reserveMiniNamedClaudeSessionAttempt({
    providerId: "claude-provider",
    requestClient: "mini-named-test",
    lilacSessionId: input.sessionId,
    sourceHistoryStateId: input.sourceHistoryStateId,
    executionScopeHashVersion: 1,
    executionScopeHash: "scope-v1",
    requestId: input.requestId,
    attemptIndex: 0,
    candidateSessionId: testUuid(input.candidateIndex),
    sourceSessionId: input.sourceSessionId ?? null,
    expectedBindingRevision: input.expectedBindingRevision ?? null,
  });
}

function succeedNamedClaudeAttempt(
  store: MiniLilacSqliteStore,
  sessionId: string,
  requestId: string,
): void {
  store.recordMiniNamedClaudeSessionAttemptOutcome({
    providerId: "claude-provider",
    lilacSessionId: sessionId,
    requestId,
    attemptIndex: 0,
    state: "succeeded",
  });
}

function claudePromotion(
  requestId: string,
  overrides: Partial<PromoteMiniMainClaudeSessionBinding> = {},
): PromoteMiniMainClaudeSessionBinding {
  return {
    providerId: "claude-provider",
    requestId,
    attemptIndex: 0,
    nativeCwd: "/native/cwd",
    nativeLastModified: 1_000,
    nativeContextTokens: 100,
    nativeContextMaxTokens: 200_000,
    lastModelSpecifier: "claude-sonnet",
    lastReasoning: "high",
    ...overrides,
  };
}

function namedClaudePromotion(
  requestId: string,
  canonicalMessages: readonly ModelMessage[],
): PromoteMiniNamedClaudeSessionBinding {
  return {
    ...claudePromotion(requestId),
    canonicalMessageCount: canonicalMessages.length,
    canonicalHeadHash: hashCanonicalMessagesV1(canonicalMessages).hash,
  };
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
    depth?: number;
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
  const current = store.getCurrentHistoryState(input.sessionId);
  const modelMessages: ModelMessage[] = [
    ...store.getHistoryStateModelMessages(current.id),
    { role: "user", content: input.message.id },
  ];
  const uiMessages = [...store.getHistoryStateUiMessages(current.id), input.message];
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
      depth: input.depth ?? 0,
    },
    commandId: input.commandId,
    commandPayload: payload,
    transitionId: input.transitionId,
    expectedCurrentStateId: current.id,
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

type PromptFinalizationInput = {
  sessionId: string;
  runId: string;
  transitionId: string;
  user: MiniLilacUserUIMessage;
  providerState?: HistoryProviderState;
  claudeBindingPromotion?: PromoteMiniMainClaudeSessionBinding;
  namedClaudeBindingPromotion?: PromoteMiniNamedClaudeSessionBinding;
};

function reservePromptFinalization(
  store: MiniLilacSqliteStore,
  input: PromptFinalizationInput,
): ModelMessage[] {
  const assistant = {
    id: `assistant:${input.runId}`,
    role: "assistant" as const,
    parts: [{ type: "text" as const, text: `answer:${input.runId}` }],
  };
  const modelMessages: ModelMessage[] = [
    ...store.getModelMessages(input.sessionId),
    { role: "assistant", content: `answer:${input.runId}` },
  ];
  store.reservePendingRunFinalization({
    runId: input.runId,
    sessionId: input.sessionId,
    openTransitionId: input.transitionId,
    modelMessages,
    uiMessages: [...store.getUiMessages(input.sessionId), assistant],
    runStatus: "completed",
    sessionStatus: "idle",
    error: null,
    terminalResult: { status: "completed" },
    inputTokens: 2,
    ...(input.providerState === undefined ? {} : { providerState: input.providerState }),
    ...(input.claudeBindingPromotion === undefined
      ? {}
      : { claudeBindingPromotion: input.claudeBindingPromotion }),
    ...(input.namedClaudeBindingPromotion === undefined
      ? {}
      : { namedClaudeBindingPromotion: input.namedClaudeBindingPromotion }),
  });
  return modelMessages;
}

function finalizePrompt(
  store: MiniLilacSqliteStore,
  input: PromptFinalizationInput & { destinationStateId: string },
): ReturnType<MiniLilacSqliteStore["commitPendingRunFinalization"]> {
  reservePromptFinalization(store, input);
  return store.commitPendingRunFinalization({
    runId: input.runId,
    destinationStateId: input.destinationStateId,
    ...(input.providerState === undefined ? {} : { providerState: input.providerState }),
    ...(input.claudeBindingPromotion === undefined
      ? {}
      : { claudeBindingPromotion: input.claudeBindingPromotion }),
    ...(input.namedClaudeBindingPromotion === undefined
      ? {}
      : { namedClaudeBindingPromotion: input.namedClaudeBindingPromotion }),
    ...unavailableWorkspace,
  });
}

function seedNamedClaudeBinding(
  store: MiniLilacSqliteStore,
  sessionId: string,
  candidateIndex: number,
): MiniNamedClaudeSessionBinding {
  const user = userMessage(`seed-user-${candidateIndex}`);
  const runId = `seed-run-${candidateIndex}`;
  const transitionId = `seed-transition-${candidateIndex}`;
  const sourceStateId = `seed-source-${candidateIndex}`;
  admitPrompt(store, {
    sessionId,
    runId,
    commandId: `seed-command-${candidateIndex}`,
    transitionId,
    message: user,
    depth: 1,
    observationIds: {
      stateId: sourceStateId,
      transitionId: `seed-observation-transition-${candidateIndex}`,
    },
  });
  reserveNamedClaudeAttempt(store, {
    sessionId,
    sourceHistoryStateId: sourceStateId,
    requestId: runId,
    candidateIndex,
  });
  succeedNamedClaudeAttempt(store, sessionId, runId);
  const canonicalMessages: ModelMessage[] = [
    ...store.getModelMessages(sessionId),
    { role: "assistant", content: `answer:${runId}` },
  ];
  const committed = finalizePrompt(store, {
    sessionId,
    runId,
    transitionId,
    destinationStateId: `seed-state-${candidateIndex}`,
    user,
    providerState: claudeProviderState,
    namedClaudeBindingPromotion: namedClaudePromotion(runId, canonicalMessages),
  });
  if (committed.bindingPromotion !== "promoted") {
    throw new Error("Failed to seed named Claude binding");
  }
  const binding = store.getMiniNamedClaudeState({
    sessionId,
    providerId: "claude-provider",
  }).binding;
  if (binding === null) throw new Error("Seeded named Claude binding is missing");
  return binding;
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

type SupportedHistoricalVersion = 0 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

function createV2Layout(database: Database): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, active_run_id TEXT, cwd TEXT NOT NULL, model TEXT NOT NULL,
      profile TEXT NOT NULL, reasoning TEXT NOT NULL, title TEXT NOT NULL DEFAULT 'Mini Lilac',
      input_tokens INTEGER, context_window INTEGER, status TEXT NOT NULL,
      queued_steering_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
}

function migrateFixtureV2ToV3(database: Database): void {
  database.exec(`
    CREATE TABLE transcript_nodes (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
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
    CREATE TABLE user_checkpoints_v3 (
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
    DROP TABLE run_chunks;
    DROP TABLE user_checkpoints;
    DROP TABLE model_transcript;
    DROP TABLE ui_messages;
    ALTER TABLE user_checkpoints_v3 RENAME TO user_checkpoints;
    PRAGMA user_version = 3;
  `);
}

function createIntermediateHistoricalLayout(databasePath: string, targetVersion: 5 | 6 | 7): void {
  const originalExec = Database.prototype.exec;
  const exec = spyOn(Database.prototype, "exec").mockImplementation(function (
    this: Database,
    sql: string,
  ) {
    if (targetVersion < 6 && sql.includes("CREATE TABLE history_states_v6")) {
      return originalExec.call(this, "SELECT 1");
    }
    if (
      targetVersion < 7 &&
      sql.includes("ALTER TABLE history_states ADD COLUMN last_provider_family")
    ) {
      return originalExec.call(this, "SELECT 1");
    }
    if (
      targetVersion < 8 &&
      sql.includes("ALTER TABLE pending_run_finalizations") &&
      sql.includes("named_claude_binding_promotion_json")
    ) {
      return originalExec.call(this, "SELECT 1");
    }
    if (sql.includes(`PRAGMA user_version = ${MINI_LILAC_DATABASE_SCHEMA_VERSION}`)) {
      return originalExec.call(this, `PRAGMA user_version = ${targetVersion}`);
    }
    return originalExec.call(this, sql);
  });
  try {
    const store = new MiniLilacSqliteStore(databasePath);
    store.close();
  } finally {
    exec.mockRestore();
  }
}

async function createHistoricalLayout(version: SupportedHistoricalVersion): Promise<{
  readonly databasePath: string;
  readonly directory: string;
}> {
  let databasePath: string;
  let directory: string;
  if (version === 4 || version === 5) {
    const v4 = await createV4Database();
    databasePath = v4.databasePath;
    directory = v4.directory;
    if (version === 5) createIntermediateHistoricalLayout(databasePath, 5);
  } else {
    const temporary = await temporaryDatabasePath(`mini-lilac-v${version}-layout-`);
    databasePath = temporary.file;
    directory = temporary.directory;
    if (version === 2 || version === 3) {
      const database = new Database(databasePath, { create: true, strict: true });
      createV2Layout(database);
      if (version === 3) migrateFixtureV2ToV3(database);
      database.close();
    } else if (version === 6 || version === 7) {
      createIntermediateHistoricalLayout(databasePath, version);
    } else if (version === 8) {
      const store = new MiniLilacSqliteStore(databasePath);
      store.close();
    } else {
      const database = new Database(databasePath, { create: true, strict: true });
      database.close();
    }
  }
  const marker = new Database(databasePath, { strict: true });
  marker.exec(
    "CREATE TABLE migration_fixture_marker (value TEXT NOT NULL); INSERT INTO migration_fixture_marker VALUES ('preserved')",
  );
  marker.close();
  return { databasePath, directory };
}

function historicalLayoutSnapshot(databasePath: string) {
  const database = new Database(databasePath, { strict: true });
  const snapshot = {
    version: database.query("PRAGMA user_version").get(),
    schema: database
      .query(
        `SELECT type, name, sql FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      )
      .all(),
    marker: database.query("SELECT value FROM migration_fixture_marker").get(),
  };
  database.close();
  return snapshot;
}

describe("MiniLilacSqliteStore history schema", () => {
  it("distinguishes current, missing, unsupported, and corrupt store rows", () => {
    const row = {
      id: "session-1",
      active_run_id: null,
      workspace_id: "workspace-1",
      cwd: "/tmp/workspace-1",
      model: "test/mock",
      profile: "reader",
      reasoning: "high",
      title: "Mini Lilac",
      input_tokens: null,
      input_tokens_estimated: 0,
      context_window: null,
      status: "idle",
      queued_steering_count: 0,
      created_at: "2026-08-04T00:00:00.000Z",
      updated_at: "2026-08-04T00:00:00.000Z",
    };

    expect(
      decodeMiniLilacStoreRow({
        kind: "session",
        row,
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: row.id,
      }),
    ).toMatchObject({ status: "ok", value: { provenance: "current", value: row } });
    expect(
      decodeMiniLilacStoreRow({
        kind: "session",
        row: null,
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: row.id,
      }),
    ).toMatchObject({ status: "ok", value: { provenance: "missing-defaulted", value: null } });
    expect(
      decodeMiniLilacStoreRow({
        kind: "session",
        row,
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION - 1,
        recordId: row.id,
      }),
    ).toMatchObject({ status: "error", error: { _tag: "UnsupportedVersion" } });
    expect(
      decodeMiniLilacStoreRow({
        kind: "session",
        row: { id: row.id },
        schemaVersion: MINI_LILAC_DATABASE_SCHEMA_VERSION,
        recordId: row.id,
      }),
    ).toMatchObject({ status: "error", error: { _tag: "CorruptPersistedFields" } });
  });

  it("upgrades and rolls back genuine layouts for every supported migration start", async () => {
    for (const version of [0, 2, 3, 4, 5, 6, 7, 8] as const) {
      const { databasePath } = await createHistoricalLayout(version);
      const before = historicalLayoutSnapshot(databasePath);
      expect(before.version).toEqual({ user_version: version });

      if (version < 8) {
        const originalExec = Database.prototype.exec;
        const exec = spyOn(Database.prototype, "exec").mockImplementation(function (
          this: Database,
          sql: string,
        ) {
          if (sql.includes(`PRAGMA user_version = ${MINI_LILAC_DATABASE_SCHEMA_VERSION}`)) {
            return originalExec.call(this, "INVALID MIGRATION FINALIZATION SQL");
          }
          return originalExec.call(this, sql);
        });
        try {
          expect(() => new MiniLilacSqliteStore(databasePath)).toThrow(
            MiniLilacSqliteDriverFailure,
          );
        } finally {
          exec.mockRestore();
        }
        expect(historicalLayoutSnapshot(databasePath)).toEqual(before);
      }

      const migrated = new MiniLilacSqliteStore(databasePath);
      migrated.close();
      const after = historicalLayoutSnapshot(databasePath);
      expect(after.version).toEqual({ user_version: MINI_LILAC_DATABASE_SCHEMA_VERSION });
      expect(after.marker).toEqual({ value: "preserved" });
      if (version === 8) expect(after).toEqual(before);
      else expect(after.schema).not.toEqual(before.schema);
    }
  });

  it("preserves a migration Err with a recognized pragma-cleanup failure", async () => {
    const { databasePath } = await createV4Database();
    const corrupt = new Database(databasePath, { strict: true });
    corrupt.exec("PRAGMA foreign_keys = OFF");
    corrupt
      .query(
        `INSERT INTO user_checkpoints
          (session_id, ui_position, user_message_json, model_head_id, ui_head_id,
           root_run_id, replay_after_seq)
         VALUES ('missing-session', 99, '{}', NULL, NULL, 'missing-run', 0)`,
      )
      .run();
    corrupt.close();

    const originalExec = Database.prototype.exec;
    const exec = spyOn(Database.prototype, "exec").mockImplementation(function (
      this: Database,
      sql: string,
    ) {
      if (sql.includes("PRAGMA legacy_alter_table = OFF")) {
        return originalExec.call(this, "INVALID CLEANUP SQL");
      }
      return originalExec.call(this, sql);
    });
    try {
      let failure: unknown;
      try {
        new MiniLilacSqliteStore(databasePath);
      } catch (cause) {
        failure = cause;
      }
      expect(failure).toBeInstanceOf(MiniLilacSchemaInitializationCombinedFailure);
      if (failure instanceof MiniLilacSchemaInitializationCombinedFailure) {
        expect(failure.primary).toBeInstanceOf(MiniLilacSchemaMigrationFailure);
        expect(failure.cleanup).toBeInstanceOf(MiniLilacSqliteDriverFailure);
      }
    } finally {
      exec.mockRestore();
    }
    const unchanged = new Database(databasePath, { strict: true });
    expect(unchanged.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    expect(
      unchanged.query("SELECT session_id FROM user_checkpoints WHERE ui_position = 99").get(),
    ).toEqual({ session_id: "missing-session" });
    unchanged.close();
  });

  it("propagates the exact Panic and unrecognized defect from schema migration", async () => {
    for (const failure of [
      new Panic({ message: "migration panic fixture", cause: "fixture" }),
      new Error("migration defect fixture"),
    ]) {
      const { file } = await temporaryDatabasePath("mini-lilac-migration-defect-");
      const originalExec = Database.prototype.exec;
      const exec = spyOn(Database.prototype, "exec").mockImplementation(function (
        this: Database,
        sql: string,
      ) {
        if (sql.includes("CREATE TABLE history_store_metadata")) throw failure;
        return originalExec.call(this, sql);
      });
      try {
        let caught: unknown;
        try {
          new MiniLilacSqliteStore(file);
        } catch (cause) {
          caught = cause;
        }
        expect(caught).toBe(failure);
      } finally {
        exec.mockRestore();
      }
    }
  });

  it("preserves a migration defect when pragma cleanup fails and reports cleanup independently", async () => {
    for (const primary of [
      new Panic({ message: "migration panic fixture", cause: "fixture" }),
      new Error("migration defect fixture"),
    ]) {
      const { file } = await temporaryDatabasePath("mini-lilac-migration-cleanup-defect-");
      const reports: Array<{ readonly operation: string; readonly cleanupFailure: unknown }> = [];
      const originalExec = Database.prototype.exec;
      const exec = spyOn(Database.prototype, "exec").mockImplementation(function (
        this: Database,
        sql: string,
      ) {
        if (sql.includes("CREATE TABLE history_store_metadata")) throw primary;
        if (sql.includes("PRAGMA legacy_alter_table = OFF")) {
          return originalExec.call(this, "INVALID CLEANUP SQL");
        }
        return originalExec.call(this, sql);
      });
      try {
        let caught: unknown;
        try {
          new MiniLilacSqliteStore(file, { onCleanupDefect: (report) => reports.push(report) });
        } catch (cause) {
          caught = cause;
        }
        expect(caught).toBe(primary);
        expect(reports).toHaveLength(1);
        expect(reports[0]?.operation).toBe("initializeSchema.restorePragmas");
        expect(reports[0]?.cleanupFailure).toBeInstanceOf(MiniLilacSqliteDriverFailure);
      } finally {
        exec.mockRestore();
      }
    }
  });

  it("preserves a constructor defect when database-close cleanup fails", async () => {
    const { file } = await temporaryDatabasePath("mini-lilac-close-cleanup-defect-");
    const primary = new Error("constructor defect fixture");
    const closeDefect = new Error("database close defect fixture");
    const reports: Array<{ readonly operation: string; readonly cleanupFailure: unknown }> = [];
    const originalExec = Database.prototype.exec;
    const originalClose = Database.prototype.close;
    const exec = spyOn(Database.prototype, "exec").mockImplementation(function (
      this: Database,
      sql: string,
    ) {
      if (sql.includes("PRAGMA journal_mode = WAL")) throw primary;
      return originalExec.call(this, sql);
    });
    const close = spyOn(Database.prototype, "close").mockImplementation(function (this: Database) {
      originalClose.call(this);
      throw closeDefect;
    });
    try {
      let caught: unknown;
      try {
        new MiniLilacSqliteStore(file, { onCleanupDefect: (report) => reports.push(report) });
      } catch (cause) {
        caught = cause;
      }
      expect(caught).toBe(primary);
      expect(reports).toEqual([
        {
          operation: "constructor.closeAfterInitializationFailure",
          cleanupFailure: closeDefect,
        },
      ]);
    } finally {
      close.mockRestore();
      exec.mockRestore();
    }
  });

  it("returns structural corruption as a Result and emits only redacted post-read diagnostics", async () => {
    const { file, directory } = await temporaryDatabasePath("mini-lilac-history-corruption-");
    const diagnostics: Array<{ readonly recordId: string; readonly inTransaction: boolean }> = [];
    let store: MiniLilacSqliteStore;
    store = new MiniLilacSqliteStore(file, {
      onPersistenceDiagnostic: (diagnostic) => {
        diagnostics.push({
          recordId: diagnostic.recordId,
          inTransaction: store.database.inTransaction,
        });
      },
    });
    createSession(store, "corrupt-session", directory);
    const state = store.getCurrentHistoryState("corrupt-session");
    store.database.exec("PRAGMA ignore_check_constraints = ON");
    store.database
      .query(
        `UPDATE history_states
         SET last_provider_family = 'ai-sdk', contains_cross_family_turns = NULL
         WHERE id = ?`,
      )
      .run(state.id);
    store.database.exec("PRAGMA ignore_check_constraints = OFF");

    const read = store.getHistoryStateResult(state.id);
    expect(read.status).toBe("error");
    expect(diagnostics).toEqual([{ recordId: state.id, inTransaction: false }]);
    expect(JSON.stringify(diagnostics)).not.toContain(directory);
    store.close();
  });

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

  it("migrates v6 history to conservative provider metadata and native records", async () => {
    const { directory, file } = await temporaryDatabasePath("mini-lilac-history-v5-");
    const original = new MiniLilacSqliteStore(file);
    createSession(original, "session-1", directory);
    const root = original.getCurrentHistoryState("session-1");
    const message = userMessage("v5-user");
    admitPrompt(original, {
      sessionId: "session-1",
      runId: "v5-run",
      commandId: "v5-prompt",
      transitionId: "v5-transition",
      message,
      observationIds: { stateId: "v5-observation", transitionId: "v5-observation-transition" },
    });
    finalizePrompt(original, {
      sessionId: "session-1",
      runId: "v5-run",
      transitionId: "v5-transition",
      destinationStateId: "v5-destination",
      user: message,
    });
    original.reserveCommand("session-1", "v5-undo", { kind: "undo", runId: null, payload: {} });
    original.reserveHistoryOperation({
      id: "v5-operation",
      sessionId: "session-1",
      commandId: "v5-undo",
      requestedAction: "undo",
      expectedSourceStateId: "v5-destination",
      targetStateId: "v5-observation",
      userTransitionId: "v5-transition",
      filesystemMode: "skip",
      skipReason: "git-unavailable",
    });
    const rootRow = original.database
      .query("SELECT rowid FROM history_states WHERE id = ?")
      .get(root.id);
    original.close();

    const legacy = new Database(file, { strict: true });
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE mini_named_claude_attempts;
      DROP TABLE mini_named_claude_bindings;
      DROP TABLE mini_main_claude_attempts;
      DROP TABLE mini_main_claude_bindings;
      ALTER TABLE pending_run_finalizations DROP COLUMN named_claude_binding_promotion_json;
      ALTER TABLE pending_run_finalizations DROP COLUMN claude_binding_promotion_json;
      ALTER TABLE pending_run_finalizations DROP COLUMN contains_cross_family_turns;
      ALTER TABLE pending_run_finalizations DROP COLUMN last_provider_family;
      ALTER TABLE history_states DROP COLUMN contains_cross_family_turns;
      ALTER TABLE history_states DROP COLUMN last_provider_family;
      PRAGMA user_version = 6;
    `);
    legacy.close();

    const migrated = new MiniLilacSqliteStore(file);
    expect(migrated.database.query("PRAGMA user_version").get()).toEqual({
      user_version: MINI_LILAC_DATABASE_SCHEMA_VERSION,
    });
    expect(
      migrated.database.query("SELECT rowid FROM history_states WHERE id = ?").get(root.id),
    ).toEqual(rootRow);
    expect(migrated.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      migrated
        .listHistoryTopology("session-1")
        .states.every((state) => state.providerState === null),
    ).toBe(true);
    expect(
      migrated.database
        .query(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name IN (
              'mini_main_claude_bindings', 'mini_main_claude_attempts',
              'mini_named_claude_bindings', 'mini_named_claude_attempts'
            ) ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "mini_main_claude_attempts" },
      { name: "mini_main_claude_bindings" },
      { name: "mini_named_claude_attempts" },
      { name: "mini_named_claude_bindings" },
    ]);
    expect(migrated.listHistoryOperations()).toMatchObject([
      { id: "v5-operation", skipReason: "git-unavailable" },
    ]);
    expect(
      migrated.database
        .query(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name LIKE 'history_states_%' ORDER BY name`,
        )
        .all(),
    ).toEqual([{ name: "history_states_session" }, { name: "history_states_workspace_snapshot" }]);
    expect(
      migrated.database
        .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'history_operations'")
        .get(),
    ).toMatchObject({ sql: expect.stringContaining("'non-git-workspace'") });

    migrated.database
      .query(
        `UPDATE history_states
         SET workspace_status = 'unavailable', workspace_unavailable_reason = 'non-git-workspace'
         WHERE id = ?`,
      )
      .run("v5-destination");
    expect(migrated.getCurrentHistoryState("session-1")).toMatchObject({
      workspaceStatus: "unavailable",
      workspaceUnavailableReason: "non-git-workspace",
    });
    migrated.close();
  });

  it("migrates a v7 main pending promotion directly to v8 and preserves recovery", async () => {
    const { directory, file } = await temporaryDatabasePath("mini-lilac-v7-pending-");
    const original = new MiniLilacSqliteStore(file);
    createSession(original, "session-1", directory);
    const user = userMessage("v7-pending-user");
    const runId = "v7-pending-run";
    const transitionId = "v7-pending-transition";
    admitPrompt(original, {
      sessionId: "session-1",
      runId,
      commandId: "v7-pending-command",
      transitionId,
      message: user,
      observationIds: {
        stateId: "v7-pending-source",
        transitionId: "v7-pending-observation-transition",
      },
    });
    reserveClaudeAttempt(original, {
      sessionId: "session-1",
      sourceHistoryStateId: "v7-pending-source",
      requestId: runId,
      candidateIndex: 80,
    });
    succeedClaudeAttempt(original, "session-1", runId);
    const promotion = claudePromotion(runId);
    reservePromptFinalization(original, {
      sessionId: "session-1",
      runId,
      transitionId,
      user,
      providerState: claudeProviderState,
      claudeBindingPromotion: promotion,
    });
    original.close();

    const legacy = new Database(file, { strict: true });
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE mini_named_claude_attempts;
      DROP TABLE mini_named_claude_bindings;
      ALTER TABLE pending_run_finalizations DROP COLUMN named_claude_binding_promotion_json;
      PRAGMA user_version = 7;
    `);
    legacy.close();

    const migrated = new MiniLilacSqliteStore(file);
    expect(migrated.database.query("PRAGMA user_version").get()).toEqual({
      user_version: MINI_LILAC_DATABASE_SCHEMA_VERSION,
    });
    const pending = migrated.getPendingRunFinalization(runId);
    expect(pending?.claudeBindingPromotion).toEqual(promotion);
    expect(pending?.namedClaudeBindingPromotion).toBeNull();
    migrated.recoverInterruptedRuntimeState();
    expect(
      migrated.getMiniMainClaudeSessionAttempt({
        providerId: "claude-provider",
        lilacSessionId: "session-1",
        requestId: runId,
        attemptIndex: 0,
      })?.state,
    ).toBe("succeeded");
    const committed = migrated.commitPendingRunFinalization({
      runId,
      destinationStateId: "v7-pending-recovered-state",
      ...unavailableWorkspace,
    });
    expect(committed.bindingPromotion).toBe("promoted");
    expect(
      migrated.getMiniMainClaudeState({
        sessionId: "session-1",
        historyStateId: "v7-pending-recovered-state",
        providerId: "claude-provider",
      }).binding?.claudeSessionId,
    ).toBe(testUuid(80));
    expect(migrated.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
  });

  it("promotes exact-state Claude bindings and rejects a stale binding revision", async () => {
    const { directory, file } = await temporaryDatabasePath("mini-lilac-native-cas-");
    const store = new MiniLilacSqliteStore(file);
    createSession(store, "session-1", directory);

    const firstUser = userMessage("native-user-1");
    admitPrompt(store, {
      sessionId: "session-1",
      runId: "native-run-1",
      commandId: "native-command-1",
      transitionId: "native-transition-1",
      message: firstUser,
      observationIds: {
        stateId: "native-observed-root",
        transitionId: "native-observation-transition",
      },
    });
    reserveClaudeAttempt(store, {
      sessionId: "session-1",
      sourceHistoryStateId: "native-observed-root",
      requestId: "native-run-1",
      candidateIndex: 1,
    });
    succeedClaudeAttempt(store, "session-1", "native-run-1");
    const firstCommit = finalizePrompt(store, {
      sessionId: "session-1",
      runId: "native-run-1",
      transitionId: "native-transition-1",
      destinationStateId: "native-state-1",
      user: firstUser,
      providerState: claudeProviderState,
      claudeBindingPromotion: claudePromotion("native-run-1"),
    });
    expect(firstCommit.bindingPromotion).toBe("promoted");
    const firstNativeState = store.getMiniMainClaudeState({
      sessionId: "session-1",
      historyStateId: "native-state-1",
      providerId: "claude-provider",
    });
    expect(firstNativeState.providerState).toEqual(claudeProviderState);
    expect(firstNativeState.binding).toMatchObject({
      claudeSessionId: testUuid(1),
      revision: 1,
      canonicalMessageCount: 2,
      lastModelSpecifier: "claude-sonnet",
      lastReasoning: "high",
    });

    const secondUser = userMessage("native-user-2");
    admitPrompt(store, {
      sessionId: "session-1",
      runId: "native-run-2",
      commandId: "native-command-2",
      transitionId: "native-transition-2",
      message: secondUser,
    });
    reserveClaudeAttempt(store, {
      sessionId: "session-1",
      sourceHistoryStateId: "native-state-1",
      requestId: "native-run-2",
      candidateIndex: 2,
      sourceSessionId: testUuid(1),
      expectedBindingRevision: 1,
    });
    succeedClaudeAttempt(store, "session-1", "native-run-2");
    const secondCommit = finalizePrompt(store, {
      sessionId: "session-1",
      runId: "native-run-2",
      transitionId: "native-transition-2",
      destinationStateId: "native-state-2",
      user: secondUser,
      providerState: claudeProviderState,
      claudeBindingPromotion: claudePromotion("native-run-2", {
        lastModelSpecifier: "claude-opus",
        lastReasoning: "low",
      }),
    });
    expect(secondCommit.bindingPromotion).toBe("promoted");
    expect(
      store.getMiniMainClaudeState({
        sessionId: "session-1",
        historyStateId: "native-state-2",
        providerId: "claude-provider",
      }).binding,
    ).toMatchObject({
      claudeSessionId: testUuid(2),
      revision: 2,
      canonicalMessageCount: 4,
      lastModelSpecifier: "claude-opus",
      lastReasoning: "low",
    });

    const thirdUser = userMessage("native-user-3");
    admitPrompt(store, {
      sessionId: "session-1",
      runId: "native-run-3",
      commandId: "native-command-3",
      transitionId: "native-transition-3",
      message: thirdUser,
    });
    reserveClaudeAttempt(store, {
      sessionId: "session-1",
      sourceHistoryStateId: "native-state-2",
      requestId: "native-run-3",
      candidateIndex: 3,
      sourceSessionId: testUuid(2),
      expectedBindingRevision: 2,
    });
    succeedClaudeAttempt(store, "session-1", "native-run-3");
    store.database
      .query(
        `UPDATE mini_main_claude_bindings SET revision = 3
         WHERE session_id = 'session-1' AND history_state_id = 'native-state-2'
           AND provider_id = 'claude-provider'`,
      )
      .run();
    const staleCommit = finalizePrompt(store, {
      sessionId: "session-1",
      runId: "native-run-3",
      transitionId: "native-transition-3",
      destinationStateId: "native-state-3",
      user: thirdUser,
      providerState: claudeProviderState,
      claudeBindingPromotion: claudePromotion("native-run-3"),
    });
    expect(staleCommit.bindingPromotion).toBe("cas-failed");
    expect(staleCommit.state.providerState).toEqual(claudeProviderState);
    expect(
      store.getMiniMainClaudeState({
        sessionId: "session-1",
        historyStateId: "native-state-3",
        providerId: "claude-provider",
      }).binding,
    ).toBeNull();
    expect(store.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    store.close();
  });

  it("marks active Claude attempts uncertain on recovery and never promotes them", async () => {
    const { directory, file } = await temporaryDatabasePath("mini-lilac-native-recovery-");
    const store = new MiniLilacSqliteStore(file);
    createSession(store, "session-1", directory);
    const message = userMessage("recovery-user");
    admitPrompt(store, {
      sessionId: "session-1",
      runId: "recovery-run",
      commandId: "recovery-command",
      transitionId: "recovery-transition",
      message,
      observationIds: {
        stateId: "recovery-observed-root",
        transitionId: "recovery-observation-transition",
      },
    });
    reserveClaudeAttempt(store, {
      sessionId: "session-1",
      sourceHistoryStateId: "recovery-observed-root",
      requestId: "recovery-run",
      candidateIndex: 10,
    });

    store.recoverInterruptedRuntimeState();
    expect(
      store.getMiniMainClaudeSessionAttempt({
        providerId: "claude-provider",
        lilacSessionId: "session-1",
        requestId: "recovery-run",
        attemptIndex: 0,
      })?.state,
    ).toBe("uncertain");
    expect(() => succeedClaudeAttempt(store, "session-1", "recovery-run")).toThrow(
      "already terminal as 'uncertain'",
    );
    const committed = finalizePrompt(store, {
      sessionId: "session-1",
      runId: "recovery-run",
      transitionId: "recovery-transition",
      destinationStateId: "recovery-state",
      user: message,
      providerState: claudeProviderState,
      claudeBindingPromotion: claudePromotion("recovery-run"),
    });
    expect(committed.bindingPromotion).toBe("cas-failed");
    expect(
      store.getMiniMainClaudeState({
        sessionId: "session-1",
        historyStateId: "recovery-state",
        providerId: "claude-provider",
      }).binding,
    ).toBeNull();
    store.close();
  });

  it("replaces one current named-child binding only after canonical verification and CAS", async () => {
    const { directory, file } = await temporaryDatabasePath("mini-lilac-named-native-cas-");
    const store = new MiniLilacSqliteStore(file);
    const sessionId = "sub:parent:named:research";
    createSession(store, sessionId, directory);

    const firstUser = userMessage("named-user-1");
    admitPrompt(store, {
      sessionId,
      runId: "named-run-1",
      commandId: "named-command-1",
      transitionId: "named-transition-1",
      message: firstUser,
      depth: 1,
      observationIds: {
        stateId: "named-observed-root",
        transitionId: "named-observation-transition",
      },
    });
    reserveNamedClaudeAttempt(store, {
      sessionId,
      sourceHistoryStateId: "named-observed-root",
      requestId: "named-run-1",
      candidateIndex: 40,
    });
    succeedNamedClaudeAttempt(store, sessionId, "named-run-1");
    const firstCanonical = [
      ...store.getModelMessages(sessionId),
      { role: "assistant" as const, content: "answer:named-run-1" },
    ];
    const firstCommit = finalizePrompt(store, {
      sessionId,
      runId: "named-run-1",
      transitionId: "named-transition-1",
      destinationStateId: "named-state-1",
      user: firstUser,
      providerState: claudeProviderState,
      namedClaudeBindingPromotion: namedClaudePromotion("named-run-1", firstCanonical),
    });
    expect(firstCommit.bindingPromotion).toBe("promoted");
    const firstBinding = store.getMiniNamedClaudeState({
      sessionId,
      providerId: "claude-provider",
    }).binding;
    expect(firstBinding).toMatchObject({
      historyStateId: "named-state-1",
      claudeSessionId: testUuid(40),
      revision: 1,
      canonicalMessageCount: 2,
    });

    const secondUser = userMessage("named-user-2");
    admitPrompt(store, {
      sessionId,
      runId: "named-run-2",
      commandId: "named-command-2",
      transitionId: "named-transition-2",
      message: secondUser,
      depth: 1,
    });
    reserveNamedClaudeAttempt(store, {
      sessionId,
      sourceHistoryStateId: "named-state-1",
      requestId: "named-run-2",
      candidateIndex: 41,
      sourceSessionId: testUuid(40),
      expectedBindingRevision: 1,
    });
    succeedNamedClaudeAttempt(store, sessionId, "named-run-2");
    const secondCanonical = [
      ...store.getModelMessages(sessionId),
      { role: "assistant" as const, content: "answer:named-run-2" },
    ];
    const secondCommit = finalizePrompt(store, {
      sessionId,
      runId: "named-run-2",
      transitionId: "named-transition-2",
      destinationStateId: "named-state-2",
      user: secondUser,
      providerState: claudeProviderState,
      namedClaudeBindingPromotion: namedClaudePromotion("named-run-2", secondCanonical),
    });
    expect(secondCommit.bindingPromotion).toBe("promoted");
    expect(
      store.getMiniNamedClaudeState({ sessionId, providerId: "claude-provider" }).binding,
    ).toMatchObject({
      historyStateId: "named-state-2",
      claudeSessionId: testUuid(41),
      revision: 2,
      canonicalMessageCount: 4,
    });
    expect(
      store.database
        .query("SELECT COUNT(*) AS count FROM mini_named_claude_bindings WHERE session_id = ?")
        .get(sessionId),
    ).toEqual({ count: 1 });
    expect(store.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    store.close();
  });

  for (const mismatch of ["count", "hash"] as const) {
    it(`rejects a named promotion with a mismatched canonical ${mismatch}`, async () => {
      const { directory, file } = await temporaryDatabasePath(
        `mini-lilac-named-canonical-${mismatch}-`,
      );
      const store = new MiniLilacSqliteStore(file);
      const sessionId = `sub:parent:named:canonical-${mismatch}`;
      createSession(store, sessionId, directory);
      const cleanBinding = seedNamedClaudeBinding(store, sessionId, mismatch === "count" ? 50 : 51);
      const user = userMessage(`mismatch-${mismatch}`);
      const runId = `mismatch-${mismatch}-run`;
      const transitionId = `mismatch-${mismatch}-transition`;
      admitPrompt(store, {
        sessionId,
        runId,
        commandId: `mismatch-${mismatch}-command`,
        transitionId,
        message: user,
        depth: 1,
      });
      reserveNamedClaudeAttempt(store, {
        sessionId,
        sourceHistoryStateId: cleanBinding.historyStateId,
        requestId: runId,
        candidateIndex: mismatch === "count" ? 52 : 53,
        sourceSessionId: cleanBinding.claudeSessionId,
        expectedBindingRevision: cleanBinding.revision,
      });
      succeedNamedClaudeAttempt(store, sessionId, runId);
      const canonicalMessages: ModelMessage[] = [
        ...store.getModelMessages(sessionId),
        { role: "assistant", content: `answer:${runId}` },
      ];
      const validPromotion = namedClaudePromotion(runId, canonicalMessages);
      const invalidPromotion =
        mismatch === "count"
          ? { ...validPromotion, canonicalMessageCount: validPromotion.canonicalMessageCount + 1 }
          : { ...validPromotion, canonicalHeadHash: "incorrect-canonical-head" };

      const committed = finalizePrompt(store, {
        sessionId,
        runId,
        transitionId,
        destinationStateId: `mismatch-${mismatch}-state`,
        user,
        providerState: claudeProviderState,
        namedClaudeBindingPromotion: invalidPromotion,
      });

      expect(committed.bindingPromotion).toBe("cas-failed");
      expect(
        store.getMiniNamedClaudeState({ sessionId, providerId: "claude-provider" }).binding,
      ).toEqual(cleanBinding);
      store.close();
    });
  }

  it("rejects a stale named expected revision without replacing the current clean binding", async () => {
    const { directory, file } = await temporaryDatabasePath("mini-lilac-named-stale-cas-");
    const store = new MiniLilacSqliteStore(file);
    const sessionId = "sub:parent:named:stale-cas";
    createSession(store, sessionId, directory);
    const cleanBinding = seedNamedClaudeBinding(store, sessionId, 60);
    const user = userMessage("stale-candidate");
    const runId = "stale-candidate-run";
    const transitionId = "stale-candidate-transition";
    admitPrompt(store, {
      sessionId,
      runId,
      commandId: "stale-candidate-command",
      transitionId,
      message: user,
      depth: 1,
    });
    reserveNamedClaudeAttempt(store, {
      sessionId,
      sourceHistoryStateId: cleanBinding.historyStateId,
      requestId: runId,
      candidateIndex: 61,
      sourceSessionId: cleanBinding.claudeSessionId,
      expectedBindingRevision: cleanBinding.revision,
    });
    succeedNamedClaudeAttempt(store, sessionId, runId);
    store.database
      .query(
        `UPDATE mini_named_claude_bindings
         SET claude_session_id = ?, native_last_modified = ?, revision = revision + 1
         WHERE session_id = ? AND provider_id = ?`,
      )
      .run(testUuid(62), 2_000, sessionId, "claude-provider");
    const winningBinding = store.getMiniNamedClaudeState({
      sessionId,
      providerId: "claude-provider",
    }).binding;
    if (winningBinding === null) throw new Error("Expected competing clean named binding");
    const canonicalMessages: ModelMessage[] = [
      ...store.getModelMessages(sessionId),
      { role: "assistant", content: `answer:${runId}` },
    ];

    const committed = finalizePrompt(store, {
      sessionId,
      runId,
      transitionId,
      destinationStateId: "stale-candidate-state",
      user,
      providerState: claudeProviderState,
      namedClaudeBindingPromotion: namedClaudePromotion(runId, canonicalMessages),
    });

    expect(committed.bindingPromotion).toBe("cas-failed");
    expect(
      store.getMiniNamedClaudeState({ sessionId, providerId: "claude-provider" }).binding,
    ).toEqual(winningBinding);
    store.close();
  });

  it("marks interrupted named-child candidates uncertain without creating a binding", async () => {
    const { directory, file } = await temporaryDatabasePath("mini-lilac-named-recovery-");
    const store = new MiniLilacSqliteStore(file);
    const sessionId = "sub:parent:named:recovery";
    createSession(store, sessionId, directory);
    reserveNamedClaudeAttempt(store, {
      sessionId,
      sourceHistoryStateId: store.getCurrentHistoryState(sessionId).id,
      requestId: "named-interrupted-run",
      candidateIndex: 42,
    });

    store.recoverInterruptedRuntimeState();

    expect(
      store.getMiniNamedClaudeSessionAttempt({
        providerId: "claude-provider",
        lilacSessionId: sessionId,
        requestId: "named-interrupted-run",
        attemptIndex: 0,
      })?.state,
    ).toBe("uncertain");
    expect(
      store.getMiniNamedClaudeState({ sessionId, providerId: "claude-provider" }).binding,
    ).toBeNull();
    store.close();
  });

  it("recovers a succeeded named pending promotion after canonical verification", async () => {
    const { directory, file } = await temporaryDatabasePath("mini-lilac-named-pending-recovery-");
    const store = new MiniLilacSqliteStore(file);
    const sessionId = "sub:parent:named:pending-recovery";
    createSession(store, sessionId, directory);
    const cleanBinding = seedNamedClaudeBinding(store, sessionId, 70);
    const user = userMessage("pending-recovery-user");
    const runId = "named-pending-recovery-run";
    const transitionId = "named-pending-recovery-transition";
    admitPrompt(store, {
      sessionId,
      runId,
      commandId: "named-pending-recovery-command",
      transitionId,
      message: user,
      depth: 1,
    });
    reserveNamedClaudeAttempt(store, {
      sessionId,
      sourceHistoryStateId: cleanBinding.historyStateId,
      requestId: runId,
      candidateIndex: 71,
      sourceSessionId: cleanBinding.claudeSessionId,
      expectedBindingRevision: cleanBinding.revision,
    });
    succeedNamedClaudeAttempt(store, sessionId, runId);
    const canonicalMessages: ModelMessage[] = [
      ...store.getModelMessages(sessionId),
      { role: "assistant", content: `answer:${runId}` },
    ];
    reservePromptFinalization(store, {
      sessionId,
      runId,
      transitionId,
      user,
      providerState: claudeProviderState,
      namedClaudeBindingPromotion: namedClaudePromotion(runId, canonicalMessages),
    });
    store.close();

    const recovered = new MiniLilacSqliteStore(file);
    recovered.recoverInterruptedRuntimeState();
    expect(
      recovered.getMiniNamedClaudeSessionAttempt({
        providerId: "claude-provider",
        lilacSessionId: sessionId,
        requestId: runId,
        attemptIndex: 0,
      })?.state,
    ).toBe("succeeded");
    const committed = recovered.commitPendingRunFinalization({
      runId,
      destinationStateId: "named-pending-recovered-state",
      ...unavailableWorkspace,
    });

    expect(committed.bindingPromotion).toBe("promoted");
    expect(
      recovered.getMiniNamedClaudeState({
        sessionId,
        providerId: "claude-provider",
      }).binding,
    ).toMatchObject({
      historyStateId: "named-pending-recovered-state",
      claudeSessionId: testUuid(71),
      revision: cleanBinding.revision + 1,
      canonicalMessageCount: canonicalMessages.length,
    });
    recovered.close();
  });

  it("recovers persisted provider and succeeded promotion metadata", async () => {
    const { directory, file } = await temporaryDatabasePath("mini-lilac-native-pending-");
    const store = new MiniLilacSqliteStore(file);
    createSession(store, "session-1", directory);
    const message = userMessage("pending-user");
    admitPrompt(store, {
      sessionId: "session-1",
      runId: "pending-run",
      commandId: "pending-command",
      transitionId: "pending-transition",
      message,
      observationIds: {
        stateId: "pending-observed-root",
        transitionId: "pending-observation-transition",
      },
    });
    reserveClaudeAttempt(store, {
      sessionId: "session-1",
      sourceHistoryStateId: "pending-observed-root",
      requestId: "pending-run",
      candidateIndex: 30,
    });
    succeedClaudeAttempt(store, "session-1", "pending-run");
    store.reservePendingRunFinalization({
      runId: "pending-run",
      sessionId: "session-1",
      openTransitionId: "pending-transition",
      modelMessages: [
        ...store.getModelMessages("session-1"),
        { role: "assistant", content: "pending answer" },
      ],
      uiMessages: [
        ...store.getUiMessages("session-1"),
        {
          id: "pending-assistant",
          role: "assistant",
          parts: [{ type: "text", text: "pending answer" }],
        },
      ],
      runStatus: "completed",
      sessionStatus: "idle",
      error: null,
      terminalResult: { text: "pending answer" },
      inputTokens: 10,
      providerState: claudeProviderState,
      claudeBindingPromotion: claudePromotion("pending-run"),
    });

    store.recoverInterruptedRuntimeState();
    const committed = store.commitPendingRunFinalization({
      runId: "pending-run",
      destinationStateId: "pending-state",
      ...unavailableWorkspace,
    });

    expect(committed.bindingPromotion).toBe("promoted");
    expect(committed.state.providerState).toEqual(claudeProviderState);
    expect(
      store.getMiniMainClaudeState({
        sessionId: "session-1",
        historyStateId: "pending-state",
        providerId: "claude-provider",
      }).binding?.claudeSessionId,
    ).toBe(testUuid(30));
    store.close();
  });

  it("rejects promotion metadata owned by a different run", async () => {
    const { directory, file } = await temporaryDatabasePath("mini-lilac-native-owner-");
    const store = new MiniLilacSqliteStore(file);
    createSession(store, "session-1", directory);
    const message = userMessage("owner-user");
    admitPrompt(store, {
      sessionId: "session-1",
      runId: "owner-run",
      commandId: "owner-command",
      transitionId: "owner-transition",
      message,
      observationIds: {
        stateId: "owner-observed-root",
        transitionId: "owner-observation-transition",
      },
    });
    reserveClaudeAttempt(store, {
      sessionId: "session-1",
      sourceHistoryStateId: "owner-observed-root",
      requestId: "different-run",
      candidateIndex: 31,
    });
    succeedClaudeAttempt(store, "session-1", "different-run");

    const committed = finalizePrompt(store, {
      sessionId: "session-1",
      runId: "owner-run",
      transitionId: "owner-transition",
      destinationStateId: "owner-state",
      user: message,
      providerState: claudeProviderState,
      claudeBindingPromotion: claudePromotion("different-run"),
    });

    expect(committed.bindingPromotion).toBe("cas-failed");
    expect(
      store.getMiniMainClaudeState({
        sessionId: "session-1",
        historyStateId: "owner-state",
        providerId: "claude-provider",
      }).binding,
    ).toBeNull();
    store.close();
  });

  it("bounds terminal Mini main Claude attempt metadata", async () => {
    const { directory, file } = await temporaryDatabasePath("mini-lilac-native-retention-");
    const store = new MiniLilacSqliteStore(file);
    createSession(store, "session-1", directory);
    const sourceHistoryStateId = store.getCurrentHistoryState("session-1").id;
    reserveClaudeAttempt(store, {
      sessionId: "session-1",
      sourceHistoryStateId,
      requestId: "retained-active",
      candidateIndex: 99,
    });
    const total = MINI_MAIN_CLAUDE_ATTEMPT_RETENTION_LIMIT + 5;
    for (let index = 0; index < total; index += 1) {
      const requestId = `retained-request-${index}`;
      reserveClaudeAttempt(store, {
        sessionId: "session-1",
        sourceHistoryStateId,
        requestId,
        candidateIndex: 100 + index,
      });
      store.recordMiniMainClaudeSessionAttemptOutcome({
        providerId: "claude-provider",
        lilacSessionId: "session-1",
        requestId,
        attemptIndex: 0,
        state: "failed",
      });
    }
    expect(
      store.database
        .query(
          `SELECT COUNT(*) AS count FROM mini_main_claude_attempts
           WHERE session_id = 'session-1' AND provider_id = 'claude-provider'`,
        )
        .get(),
    ).toEqual({ count: MINI_MAIN_CLAUDE_ATTEMPT_RETENTION_LIMIT + 1 });
    expect(
      store.getMiniMainClaudeSessionAttempt({
        providerId: "claude-provider",
        lilacSessionId: "session-1",
        requestId: "retained-active",
        attemptIndex: 0,
      })?.state,
    ).toBe("active");
    expect(
      store.getMiniMainClaudeSessionAttempt({
        providerId: "claude-provider",
        lilacSessionId: "session-1",
        requestId: "retained-request-0",
        attemptIndex: 0,
      }),
    ).toBeNull();
    expect(
      store.getMiniMainClaudeSessionAttempt({
        providerId: "claude-provider",
        lilacSessionId: "session-1",
        requestId: `retained-request-${total - 1}`,
        attemptIndex: 0,
      })?.state,
    ).toBe("failed");
    store.close();
  });

  it("bounds terminal Mini named attempts without count-pruning active attempts", async () => {
    const { directory, file } = await temporaryDatabasePath("mini-lilac-named-retention-");
    const store = new MiniLilacSqliteStore(file);
    createSession(store, "sub:parent:named:retention", directory);
    const sessionId = "sub:parent:named:retention";
    const sourceHistoryStateId = store.getCurrentHistoryState(sessionId).id;
    reserveNamedClaudeAttempt(store, {
      sessionId,
      sourceHistoryStateId,
      requestId: "named-active",
      candidateIndex: 500,
    });
    const total = MINI_NAMED_CLAUDE_ATTEMPT_RETENTION_LIMIT + 5;
    for (let index = 0; index < total; index += 1) {
      const requestId = `named-terminal-${index}`;
      reserveNamedClaudeAttempt(store, {
        sessionId,
        sourceHistoryStateId,
        requestId,
        candidateIndex: 501 + index,
      });
      store.recordMiniNamedClaudeSessionAttemptOutcome({
        providerId: "claude-provider",
        lilacSessionId: sessionId,
        requestId,
        attemptIndex: 0,
        state: "failed",
      });
    }

    expect(
      store.database
        .query(
          `SELECT COUNT(*) AS count FROM mini_named_claude_attempts
           WHERE session_id = ? AND provider_id = 'claude-provider'`,
        )
        .get(sessionId),
    ).toEqual({ count: MINI_NAMED_CLAUDE_ATTEMPT_RETENTION_LIMIT + 1 });
    expect(
      store.getMiniNamedClaudeSessionAttempt({
        providerId: "claude-provider",
        lilacSessionId: sessionId,
        requestId: "named-active",
        attemptIndex: 0,
      })?.state,
    ).toBe("active");
    expect(store.getMiniClaudeRetentionDiagnostics()).toMatchObject({
      mainBindingCount: 0,
      namedBindingCount: 0,
      activeAttemptCount: 1,
      terminalAttemptCount: MINI_NAMED_CLAUDE_ATTEMPT_RETENTION_LIMIT,
      orphanBindingCount: 0,
      orphanAttemptCount: 0,
    });
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
    reserveClaudeAttempt(store, {
      sessionId: "session-1",
      sourceHistoryStateId: "observed-root",
      requestId: "run-a",
      candidateIndex: 20,
    });
    succeedClaudeAttempt(store, "session-1", "run-a");
    finalizePrompt(store, {
      sessionId: "session-1",
      runId: "run-a",
      transitionId: "transition-a",
      destinationStateId: "state-a",
      user: firstUser,
      providerState: claudeProviderState,
      claudeBindingPromotion: claudePromotion("run-a"),
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
    ).toThrow("Mini Lilac SQLite operation failed");
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
    expect(
      reopened.getMiniMainClaudeState({
        sessionId: "session-1",
        historyStateId: "state-a",
        providerId: "claude-provider",
      }).binding,
    ).toMatchObject({ claudeSessionId: testUuid(20), revision: 1 });
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

  it("rolls back observation, command fence, and journal when Result transaction work fails", async () => {
    const { directory, file } = await temporaryDatabasePath("mini-lilac-history-result-rollback-");
    const store = new MiniLilacSqliteStore(file);
    createSession(store, "session-1", directory);
    const user = userMessage("user-1");
    admitPrompt(store, {
      sessionId: "session-1",
      runId: "run-1",
      commandId: "prompt-1",
      transitionId: "transition-1",
      message: user,
      observationIds: { stateId: "observed-1", transitionId: "observe-1" },
    });
    finalizePrompt(store, {
      sessionId: "session-1",
      runId: "run-1",
      transitionId: "transition-1",
      destinationStateId: "state-1",
      user,
    });
    store.reserveCommand("session-1", "undo-1", { kind: "undo", runId: null, payload: {} });
    store.database.exec(`
      CREATE TRIGGER fail_history_operation BEFORE INSERT ON history_operations
      BEGIN SELECT RAISE(ABORT, 'forced journal failure'); END;
    `);

    const reserved = store.reserveHistoryOperationResult({
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

    expect(reserved).toMatchObject({
      status: "error",
      error: { _tag: "MiniLilacSqliteDriverFailure", operation: "reserveHistoryOperation" },
    });
    expect(store.getHistoryOperation("operation-1")).toBeNull();
    expect(
      store.database.query("SELECT 1 FROM history_states WHERE id = 'drift-state'").get(),
    ).toBeNull();
    expect(
      store.database
        .query("SELECT side_effect_started FROM commands WHERE command_id = 'undo-1'")
        .get(),
    ).toEqual({ side_effect_started: 0 });
    expect(store.getCurrentHistoryState("session-1").id).toBe("state-1");
    store.close();
  });

  it("rolls back history closure when finalization fails after writing its destination", async () => {
    const { directory, file } = await temporaryDatabasePath(
      "mini-lilac-finalization-result-rollback-",
    );
    const store = new MiniLilacSqliteStore(file);
    createSession(store, "session-1", directory);
    const user = userMessage("user-1");
    admitPrompt(store, {
      sessionId: "session-1",
      runId: "run-1",
      commandId: "prompt-1",
      transitionId: "transition-1",
      message: user,
      observationIds: { stateId: "observed-1", transitionId: "observe-1" },
    });
    store.reservePendingRunFinalization({
      runId: "run-1",
      sessionId: "session-1",
      openTransitionId: "transition-1",
      modelMessages: [{ role: "user", content: "user-1" }],
      uiMessages: [user],
      runStatus: "completed",
      sessionStatus: "idle",
      error: null,
      terminalResult: undefined,
      inputTokens: null,
    });
    store.database.exec(`
      CREATE TRIGGER fail_run_finalization BEFORE UPDATE ON runs
      WHEN OLD.id = 'run-1' AND NEW.status <> 'active'
      BEGIN SELECT RAISE(ABORT, 'forced run finalization failure'); END;
    `);

    const committed = store.commitPendingRunFinalizationResult({
      runId: "run-1",
      destinationStateId: "final-state",
      ...unavailableWorkspace,
    });

    expect(committed).toMatchObject({
      status: "error",
      error: { _tag: "MiniLilacSqliteDriverFailure", operation: "commitPendingRunFinalization" },
    });
    expect(store.getPendingRunFinalization("run-1")).not.toBeNull();
    expect(store.getHistoryTransition("transition-1").toStateId).toBeNull();
    expect(
      store.database.query("SELECT 1 FROM history_states WHERE id = 'final-state'").get(),
    ).toBeNull();
    expect(store.getRun("run-1").status).toBe("active");
    expect(store.getSession("session-1")).toMatchObject({
      status: "streaming",
      activeRunId: "run-1",
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
    ).toThrow("Mini Lilac SQLite operation failed");

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
    ).toThrow("Mini Lilac SQLite operation failed");
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
    const rejectedAvailability = store.setWorkspaceSnapshotAvailabilityResult({
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
    });
    expect(rejectedAvailability).toMatchObject({
      status: "error",
      error: { _tag: "MiniLilacStoreOperationRejected" },
    });
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

  it("returns owned command lifecycle failures and recognized SQLite driver failures", async () => {
    const { directory, file } = await temporaryDatabasePath("mini-lilac-command-results-");
    const store = new MiniLilacSqliteStore(file);
    createSession(store, "session-1", directory);
    const request = { kind: "test", runId: null, payload: { value: 1 } };

    expect(store.reserveCommandResult("session-1", "command-1", request).status).toBe("ok");
    const circularPayload: { self?: unknown } = {};
    circularPayload.self = circularPayload;
    expect(
      store.reserveCommandResult("session-1", "circular-command", {
        kind: "test",
        runId: null,
        payload: circularPayload,
      }),
    ).toMatchObject({
      status: "error",
      error: { _tag: "MiniLilacStoreOperationRejected", operation: "canonicalCommandPayload" },
    });
    expect(store.getCommandResultResult("session-1", "command-1", request)).toMatchObject({
      status: "error",
      error: { _tag: "MiniLilacStoreOperationRejected", operation: "getCommandResult" },
    });
    expect(store.markCommandSideEffectStartedResult("session-1", "command-1", request).status).toBe(
      "ok",
    );
    expect(
      store.saveCommandResultResult("session-1", "command-1", request, { status: "saved" }).status,
    ).toBe("ok");
    expect(store.getCommandResultResult("session-1", "command-1", request)).toMatchObject({
      status: "ok",
      value: { status: "saved" },
    });
    expect(
      store.saveCommandResultResult("session-1", "command-1", request, { status: "duplicate" }),
    ).toMatchObject({
      status: "error",
      error: { _tag: "MiniLilacStoreOperationRejected", operation: "saveCommandResult" },
    });

    expect(store.reserveCommandResult("session-1", "command-1", request)).toMatchObject({
      status: "error",
      error: { _tag: "MiniLilacSqliteDriverFailure", operation: "reserveCommand" },
    });

    const stringify = spyOn(superjson, "stringify").mockImplementation(() => {
      throw new Error("expected serialization failure");
    });
    try {
      store.reserveCommandResult("session-1", "serialization-command", request);
      store.markCommandSideEffectStartedResult("session-1", "serialization-command", request);
      expect(
        store.saveCommandResultResult("session-1", "serialization-command", request, {
          status: "unsaved",
        }),
      ).toMatchObject({
        status: "error",
        error: { _tag: "MiniLilacStoreOperationRejected", operation: "saveCommandResult" },
      });
    } finally {
      stringify.mockRestore();
    }

    expect(store.reserveCommandResult("session-1", "malformed-command", request).status).toBe("ok");
    expect(
      store.markCommandSideEffectStartedResult("session-1", "malformed-command", request).status,
    ).toBe("ok");
    const malformedResult = "{";
    store.database
      .query(
        `UPDATE commands SET result_json = ?
         WHERE session_id = ? AND command_id = ?`,
      )
      .run(malformedResult, "session-1", "malformed-command");
    expect(store.getCommandResultResult("session-1", "malformed-command", request)).toMatchObject({
      status: "error",
      error: { _tag: "MalformedSerialization" },
    });
    expect(
      store.database
        .query("SELECT result_json FROM commands WHERE session_id = ? AND command_id = ?")
        .get("session-1", "malformed-command"),
    ).toEqual({ result_json: malformedResult });
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
