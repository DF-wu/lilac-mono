import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync } from "node:fs";
import path from "node:path";

import type {
  MiniLilacTodo,
  MiniLilacTodoState,
  MiniLilacReasoning,
  MiniLilacCompactResult,
  MiniLilacSessionSnapshot,
  MiniLilacUIMessage,
  MiniLilacUndoResult,
  MiniLilacUpdateSessionBindingsRequest,
  MiniLilacUserUIMessage,
} from "@stanley2058/mini-lilac-client";
import {
  miniLilacControlResultSchema,
  miniLilacCompactResultSchema,
  miniLilacCompactionEventSchema,
  miniLilacMessagesSchema,
  miniLilacProviderMetadataSchema,
  miniLilacSessionSnapshotSchema,
  miniLilacSteeringCommittedChunkSchema,
  miniLilacSteeringChunkSchema,
  miniLilacSubagentStatusSchema,
  miniLilacTodoChunkSchema,
  miniLilacTodoStateSchema,
  miniLilacTodosSchema,
  miniLilacTranscriptResetSchema,
  miniLilacUIMessageMetadataSchema,
  miniLilacUndoResultSchema,
  miniLilacUserUIMessageSchema,
} from "@stanley2058/mini-lilac-client";
import type { ModelMessage } from "ai";
import superjson from "superjson";
import { z } from "zod";

const sessionStatusSchema = z.enum(["idle", "streaming", "cancelling", "error"]);
const runStatusSchema = z.enum(["active", "completed", "cancelled", "error"]);
export const MINI_LILAC_DATABASE_SCHEMA_VERSION = 3;

export class MiniLilacDatabaseVersionError extends Error {
  constructor(
    readonly actualVersion: number,
    readonly expectedVersion = MINI_LILAC_DATABASE_SCHEMA_VERSION,
  ) {
    super(
      `Unsupported mini-lilac database version ${actualVersion}; create a fresh database for schema version ${expectedVersion}`,
    );
    this.name = "MiniLilacDatabaseVersionError";
  }
}

const sessionRowSchema = z.object({
  id: z.string(),
  active_run_id: z.string().nullable(),
  cwd: z.string(),
  model: z.string(),
  profile: z.string(),
  reasoning: z.string(),
  title: z.string(),
  input_tokens: z.number().int().nonnegative().nullable(),
  context_window: z.number().int().positive().nullable(),
  status: sessionStatusSchema,
  queued_steering_count: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});

const runRowSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  parent_run_id: z.string().nullable(),
  profile: z.string(),
  depth: z.number().int().nonnegative(),
  status: runStatusSchema,
  error: z.string().nullable(),
  terminal_result_json: z.string().nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
});

const jsonRowSchema = z.object({ value_json: z.string() });
const todosRowSchema = z.object({
  revision: z.number().int().nonnegative(),
  todos_json: z.string(),
});
const checkpointRowSchema = z.object({
  ui_position: z.number().int().nonnegative(),
  user_message_json: z.string(),
  model_head_id: z.number().int().positive().nullable(),
  ui_head_id: z.number().int().positive().nullable(),
  root_run_id: z.string(),
  replay_after_seq: z.number().int().nonnegative(),
});
const transcriptNodeRowSchema = z.object({
  id: z.number().int().positive(),
  parent_id: z.number().int().positive().nullable(),
  depth: z.number().int().positive(),
  value_json: z.string(),
  hash: z.string(),
});
const transcriptHeadRowSchema = z.object({
  model_head_id: z.number().int().positive().nullable(),
  ui_head_id: z.number().int().positive().nullable(),
});
const legacyPositionedJsonRowSchema = z.object({
  session_id: z.string(),
  position: z.number().int().nonnegative(),
  value_json: z.string(),
});
const legacyCheckpointRowSchema = z.object({
  session_id: z.string(),
  ui_position: z.number().int().nonnegative(),
  user_message_json: z.string(),
  model_prefix_json: z.string(),
  ui_prefix_json: z.string(),
  root_run_id: z.string(),
  replay_after_seq: z.number().int().nonnegative(),
});
const commandRowSchema = z.object({
  kind: z.string(),
  run_id: z.string().nullable(),
  request_fingerprint: z.string(),
  request_json: z.string(),
  side_effect_started: z.number().int().min(0).max(1),
  result_json: z.string().nullable(),
});

const providerMetadataFields = {
  providerMetadata: miniLilacProviderMetadataSchema.optional(),
};

const standardChunkSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("start"),
    messageId: z.string().optional(),
    messageMetadata: miniLilacUIMessageMetadataSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("finish"),
    finishReason: z
      .enum(["stop", "length", "content-filter", "tool-calls", "error", "other"])
      .optional(),
    messageMetadata: miniLilacUIMessageMetadataSchema.optional(),
  }),
  z.strictObject({ type: z.literal("start-step") }),
  z.strictObject({ type: z.literal("finish-step") }),
  z.strictObject({ type: z.literal("text-start"), id: z.string(), ...providerMetadataFields }),
  z.strictObject({
    type: z.literal("text-delta"),
    id: z.string(),
    delta: z.string(),
    ...providerMetadataFields,
  }),
  z.strictObject({ type: z.literal("text-end"), id: z.string(), ...providerMetadataFields }),
  z.strictObject({
    type: z.literal("reasoning-start"),
    id: z.string(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("reasoning-delta"),
    id: z.string(),
    delta: z.string(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("reasoning-end"),
    id: z.string(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("custom"),
    kind: z.custom<`${string}.${string}`>(
      (value): value is `${string}.${string}` => typeof value === "string" && value.includes("."),
    ),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("source-url"),
    sourceId: z.string(),
    url: z.string(),
    title: z.string().optional(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("source-document"),
    sourceId: z.string(),
    mediaType: z.string(),
    title: z.string(),
    filename: z.string().optional(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("file"),
    mediaType: z.string(),
    url: z.string(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("reasoning-file"),
    mediaType: z.string(),
    url: z.string(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("tool-input-start"),
    toolCallId: z.string(),
    toolName: z.string(),
    providerExecuted: z.boolean().optional(),
    toolMetadata: z.record(z.string(), z.json()).optional(),
    dynamic: z.boolean().optional(),
    title: z.string().optional(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("tool-input-delta"),
    toolCallId: z.string(),
    inputTextDelta: z.string(),
  }),
  z.strictObject({
    type: z.literal("tool-input-available"),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    dynamic: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("tool-input-error"),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    errorText: z.string(),
    dynamic: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("tool-output-available"),
    toolCallId: z.string(),
    output: z.unknown(),
    dynamic: z.boolean().optional(),
    preliminary: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("tool-output-error"),
    toolCallId: z.string(),
    errorText: z.string(),
    dynamic: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal("tool-output-denied"), toolCallId: z.string() }),
  z.strictObject({ type: z.literal("abort"), reason: z.string().optional() }),
  z.strictObject({ type: z.literal("error"), errorText: z.string() }),
  z.strictObject({
    type: z.literal("data-session"),
    id: z.string().optional(),
    data: miniLilacSessionSnapshotSchema,
  }),
  z.strictObject({
    type: z.literal("data-control"),
    id: z.string().optional(),
    data: miniLilacControlResultSchema,
  }),
  z.strictObject({
    type: z.literal("data-transcriptReset"),
    id: z.string().optional(),
    data: miniLilacTranscriptResetSchema,
  }),
  z.strictObject({
    type: z.literal("data-subagentStatus"),
    id: z.string().optional(),
    data: miniLilacSubagentStatusSchema,
  }),
  z.strictObject({
    type: z.literal("data-compaction"),
    id: z.string().optional(),
    data: miniLilacCompactionEventSchema,
  }),
  miniLilacTodoChunkSchema,
  miniLilacSteeringChunkSchema,
  miniLilacSteeringCommittedChunkSchema,
]);

export type StoredUIMessageChunk = z.infer<typeof standardChunkSchema>;
export type StoredRunChunk = { seq: number; chunk: StoredUIMessageChunk };

export function parseStoredUIMessageChunk(value: unknown): StoredUIMessageChunk {
  return standardChunkSchema.parse(value);
}

const modelMessagesSchema = z.custom<ModelMessage[]>(
  (value) =>
    Array.isArray(value) &&
    value.every(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        ["system", "user", "assistant", "tool"].includes(String(message.role)),
    ),
  "Invalid canonical model transcript",
);

export type MiniLilacRunStatus = z.infer<typeof runStatusSchema>;

export type StoredRun = {
  id: string;
  sessionId: string;
  parentRunId: string | null;
  profile: string;
  depth: number;
  status: MiniLilacRunStatus;
  error: string | null;
  terminalResult: unknown;
  startedAt: string;
  finishedAt: string | null;
};

export type CreateStoredSession = {
  id: string;
  cwd: string;
  model: string;
  profile: string;
  reasoning: MiniLilacReasoning;
  contextWindow?: number;
};

export type CreateStoredRun = {
  id: string;
  sessionId: string;
  parentRunId?: string;
  profile: string;
  depth: number;
};

export type BeginStoredRootRun = {
  run: CreateStoredRun;
  commandId: string;
  commandPayload: unknown;
  modelMessages: readonly ModelMessage[];
  uiMessages: readonly MiniLilacUIMessage[];
  title?: string;
};

export type StoredCommandRequest = {
  kind: string;
  runId: string | null;
  payload: unknown;
};

export type StoredSessionBindingUpdate = Pick<
  MiniLilacUpdateSessionBindingsRequest,
  "model" | "profile" | "reasoning"
> & { readonly contextWindow?: number | null };

export type FinalizeStoredRootRun = {
  runId: string;
  sessionId: string;
  runStatus: Exclude<MiniLilacRunStatus, "active">;
  sessionStatus: MiniLilacSessionSnapshot["status"];
  error?: string;
  terminalResult?: unknown;
  modelMessages: readonly ModelMessage[];
  uiMessages: readonly MiniLilacUIMessage[];
  inputTokens?: number | null;
};

export type StoredUserCheckpoint = {
  message: MiniLilacUserUIMessage;
  modelPrefix: readonly ModelMessage[];
  uiPrefix: readonly MiniLilacUIMessage[];
  replayAfterSeq: number;
};

export type StoredSessionResume = {
  snapshot: MiniLilacSessionSnapshot;
  messages: MiniLilacUIMessage[];
  replayCursor: { runId: string; afterSeq: number } | null;
};

export type ReplaceTodosForRun = {
  sessionId: string;
  runId: string;
  todos: readonly MiniLilacTodo[];
};

export type ReplaceTodosForRunResult = {
  state: MiniLilacTodoState;
};

function serialize(value: unknown): string {
  return superjson.stringify(value);
}

function deserialize(value: string): unknown {
  return superjson.parse(value);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalJsonValue(nested)]),
    );
  }
  return value;
}

function canonicalCommandPayload(payload: unknown): { json: string; fingerprint: string } {
  const normalized: unknown = JSON.parse(JSON.stringify(payload));
  const json = JSON.stringify(canonicalJsonValue(z.json().parse(normalized)));
  const fingerprint = new Bun.CryptoHasher("sha256").update(json).digest("hex");
  return { json, fingerprint };
}

function toSnapshot(rowValue: unknown): MiniLilacSessionSnapshot {
  const row = sessionRowSchema.parse(rowValue);
  return {
    id: row.id,
    activeRunId: row.active_run_id,
    status: row.status,
    cwd: row.cwd,
    model: row.model,
    profile: row.profile,
    reasoning: z
      .enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"])
      .parse(row.reasoning),
    title: row.title,
    inputTokens: row.input_tokens,
    contextWindow: row.context_window,
    queuedSteeringCount: row.queued_steering_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRun(rowValue: unknown): StoredRun {
  const row = runRowSchema.parse(rowValue);
  return {
    id: row.id,
    sessionId: row.session_id,
    parentRunId: row.parent_run_id,
    profile: row.profile,
    depth: row.depth,
    status: row.status,
    error: row.error,
    terminalResult: row.terminal_result_json ? deserialize(row.terminal_result_json) : undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export class MiniLilacSqliteStore {
  readonly database: Database;
  readonly filename: string;
  private closeBlockers = 0;
  private closed = false;

  constructor(filename: string) {
    this.filename = filename === ":memory:" ? filename : path.resolve(filename);
    if (this.filename !== ":memory:" && existsSync(this.filename)) {
      if (lstatSync(this.filename).isSymbolicLink()) {
        throw new Error(`Mini Lilac database path '${this.filename}' must not be a symbolic link`);
      }
    }
    this.database = new Database(this.filename, { create: true, strict: true });
    try {
      this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      this.secureDatabaseFiles();
      this.initializeSchema();
      this.recoverInterruptedRuns();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private secureDatabaseFiles(): void {
    if (this.filename === ":memory:" || process.platform === "win32") return;
    for (const file of [
      this.filename,
      `${this.filename}-journal`,
      `${this.filename}-shm`,
      `${this.filename}-wal`,
    ]) {
      if (existsSync(file)) chmodSync(file, 0o600);
    }
  }

  private initializeSchema(): void {
    const version = z
      .object({ user_version: z.number().int() })
      .parse(this.database.query("PRAGMA user_version").get()).user_version;
    if (version === MINI_LILAC_DATABASE_SCHEMA_VERSION) return;
    if (version !== 0 && version !== 2) {
      throw new MiniLilacDatabaseVersionError(version);
    }

    this.database.transaction(() => {
      if (version === 0) {
        this.createSchemaV3();
      } else {
        this.migrateSchemaV2ToV3();
      }
      this.database.exec(`PRAGMA user_version = ${MINI_LILAC_DATABASE_SCHEMA_VERSION};`);
    })();
  }

  private createSchemaV3(): void {
    this.database.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          active_run_id TEXT,
          cwd TEXT NOT NULL,
          model TEXT NOT NULL,
          profile TEXT NOT NULL,
          reasoning TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT 'Mini Lilac',
          input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
          context_window INTEGER CHECK(context_window IS NULL OR context_window > 0),
          status TEXT NOT NULL CHECK(status IN ('idle', 'streaming', 'cancelling', 'error')),
          queued_steering_count INTEGER NOT NULL DEFAULT 0 CHECK(queued_steering_count >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          parent_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
          profile TEXT NOT NULL,
          depth INTEGER NOT NULL CHECK(depth >= 0),
          status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'cancelled', 'error')),
          error TEXT,
          terminal_result_json TEXT,
          undone_at TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT
        );
        CREATE UNIQUE INDEX one_active_root_run_per_session
          ON runs(session_id) WHERE status = 'active' AND parent_run_id IS NULL;
        CREATE TABLE commands (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          command_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          run_id TEXT,
          request_fingerprint TEXT NOT NULL,
          request_json TEXT NOT NULL,
          side_effect_started INTEGER NOT NULL CHECK(side_effect_started IN (0, 1)),
          result_json TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY(session_id, command_id)
        );
        CREATE TABLE transcript_nodes (
          id INTEGER PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          lane TEXT NOT NULL CHECK(lane IN ('model', 'ui')),
          parent_id INTEGER,
          depth INTEGER NOT NULL CHECK(depth > 0),
          value_json TEXT NOT NULL,
          hash TEXT NOT NULL,
          UNIQUE(session_id, lane, hash),
          UNIQUE(id, session_id, lane),
          FOREIGN KEY(parent_id, session_id, lane)
            REFERENCES transcript_nodes(id, session_id, lane)
        );
        CREATE INDEX transcript_nodes_parent ON transcript_nodes(parent_id);
        CREATE TABLE session_transcript_heads (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          model_head_id INTEGER,
          model_lane TEXT NOT NULL DEFAULT 'model' CHECK(model_lane = 'model'),
          ui_head_id INTEGER,
          ui_lane TEXT NOT NULL DEFAULT 'ui' CHECK(ui_lane = 'ui'),
          FOREIGN KEY(model_head_id, session_id, model_lane)
            REFERENCES transcript_nodes(id, session_id, lane),
          FOREIGN KEY(ui_head_id, session_id, ui_lane)
            REFERENCES transcript_nodes(id, session_id, lane)
        );
        CREATE TABLE user_checkpoints (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          ui_position INTEGER NOT NULL,
          user_message_json TEXT NOT NULL,
          model_head_id INTEGER,
          model_lane TEXT NOT NULL DEFAULT 'model' CHECK(model_lane = 'model'),
          ui_head_id INTEGER,
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
          revision INTEGER NOT NULL CHECK(revision >= 0 AND revision <= 9007199254740991),
          todos_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
  }

  private migrateSchemaV2ToV3(): void {
    this.database.exec(`
      CREATE TABLE transcript_nodes (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        lane TEXT NOT NULL CHECK(lane IN ('model', 'ui')),
        parent_id INTEGER,
        depth INTEGER NOT NULL CHECK(depth > 0),
        value_json TEXT NOT NULL,
        hash TEXT NOT NULL,
        UNIQUE(session_id, lane, hash),
        UNIQUE(id, session_id, lane),
        FOREIGN KEY(parent_id, session_id, lane)
          REFERENCES transcript_nodes(id, session_id, lane)
      );
      CREATE INDEX transcript_nodes_parent ON transcript_nodes(parent_id);
      CREATE TABLE session_transcript_heads (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        model_head_id INTEGER,
        model_lane TEXT NOT NULL DEFAULT 'model' CHECK(model_lane = 'model'),
        ui_head_id INTEGER,
        ui_lane TEXT NOT NULL DEFAULT 'ui' CHECK(ui_lane = 'ui'),
        FOREIGN KEY(model_head_id, session_id, model_lane)
          REFERENCES transcript_nodes(id, session_id, lane),
        FOREIGN KEY(ui_head_id, session_id, ui_lane)
          REFERENCES transcript_nodes(id, session_id, lane)
      );
      CREATE TABLE user_checkpoints_v3 (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        ui_position INTEGER NOT NULL,
        user_message_json TEXT NOT NULL,
        model_head_id INTEGER,
        model_lane TEXT NOT NULL DEFAULT 'model' CHECK(model_lane = 'model'),
        ui_head_id INTEGER,
        ui_lane TEXT NOT NULL DEFAULT 'ui' CHECK(ui_lane = 'ui'),
        root_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        replay_after_seq INTEGER NOT NULL CHECK(replay_after_seq >= 0),
        PRIMARY KEY(session_id, ui_position),
        FOREIGN KEY(model_head_id, session_id, model_lane)
          REFERENCES transcript_nodes(id, session_id, lane),
        FOREIGN KEY(ui_head_id, session_id, ui_lane)
          REFERENCES transcript_nodes(id, session_id, lane)
      );
    `);

    const sessionIds = z
      .array(z.object({ id: z.string() }))
      .parse(this.database.query("SELECT id FROM sessions ORDER BY rowid").all());
    for (const { id: sessionId } of sessionIds) {
      const modelValues = this.database
        .query(
          "SELECT session_id, position, value_json FROM model_transcript WHERE session_id = ? ORDER BY position",
        )
        .all(sessionId)
        .map((value) => legacyPositionedJsonRowSchema.parse(value).value_json);
      const uiValues = this.database
        .query(
          "SELECT session_id, position, value_json FROM ui_messages WHERE session_id = ? ORDER BY position",
        )
        .all(sessionId)
        .map((value) => legacyPositionedJsonRowSchema.parse(value).value_json);
      modelMessagesSchema.parse(modelValues.map(deserialize));
      miniLilacMessagesSchema.parse(uiValues.map(deserialize));
      const modelHeadId = this.internSerializedChain(sessionId, "model", modelValues);
      const uiHeadId = this.internSerializedChain(sessionId, "ui", uiValues);
      this.setTranscriptHeads(sessionId, modelHeadId, uiHeadId);
    }

    const checkpoints = this.database
      .query(
        `SELECT session_id, ui_position, user_message_json, model_prefix_json,
                ui_prefix_json, root_run_id, replay_after_seq
         FROM user_checkpoints ORDER BY session_id, ui_position`,
      )
      .all()
      .map((value) => legacyCheckpointRowSchema.parse(value));
    const insertCheckpoint = this.database.query(
      `INSERT INTO user_checkpoints_v3
        (session_id, ui_position, user_message_json, model_head_id, ui_head_id, root_run_id, replay_after_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const checkpoint of checkpoints) {
      const message = miniLilacUserUIMessageSchema.parse(deserialize(checkpoint.user_message_json));
      const modelPrefix = modelMessagesSchema.parse(deserialize(checkpoint.model_prefix_json));
      const uiPrefix = miniLilacMessagesSchema.parse(deserialize(checkpoint.ui_prefix_json));
      const modelHeadId = this.internChain(checkpoint.session_id, "model", modelPrefix);
      const uiHeadId = this.internChain(checkpoint.session_id, "ui", uiPrefix);
      insertCheckpoint.run(
        checkpoint.session_id,
        checkpoint.ui_position,
        serialize(message),
        modelHeadId,
        uiHeadId,
        checkpoint.root_run_id,
        checkpoint.replay_after_seq,
      );
    }

    this.database.exec(`
      DROP TABLE run_chunks;
      DROP TABLE user_checkpoints;
      DROP TABLE model_transcript;
      DROP TABLE ui_messages;
      ALTER TABLE user_checkpoints_v3 RENAME TO user_checkpoints;
    `);
  }

  private recoverInterruptedRuns(): void {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database
        .query(
          "UPDATE runs SET status = 'error', error = ?, finished_at = ? WHERE status = 'active'",
        )
        .run("Runtime process stopped while run was active", now);
      this.database
        .query(
          "UPDATE sessions SET status = 'error', active_run_id = NULL, queued_steering_count = 0, updated_at = ? WHERE status IN ('streaming', 'cancelling')",
        )
        .run(now);
      this.database
        .query(
          `DELETE FROM commands
           WHERE result_json IS NULL AND side_effect_started = 0`,
        )
        .run();
    })();
  }

  close(): void {
    if (this.closed) return;
    if (this.closeBlockers > 0) {
      throw new Error(
        `Cannot close Mini Lilac database while ${this.closeBlockers} runtime task(s) are active`,
      );
    }
    this.database.close();
    this.closed = true;
  }

  acquireCloseBlocker(): () => void {
    if (this.closed) throw new Error("Mini Lilac database is closed");
    this.closeBlockers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.closeBlockers = Math.max(0, this.closeBlockers - 1);
    };
  }

  createSession(input: CreateStoredSession): MiniLilacSessionSnapshot {
    const now = new Date().toISOString();
    this.database
      .query(
        `INSERT INTO sessions
          (id, cwd, model, profile, reasoning, title, input_tokens, context_window, status, queued_steering_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'Mini Lilac', NULL, ?, 'idle', 0, ?, ?)`,
      )
      .run(
        input.id,
        input.cwd,
        input.model,
        input.profile,
        input.reasoning,
        input.contextWindow ?? null,
        now,
        now,
      );
    return this.getSession(input.id);
  }

  getSession(sessionId: string): MiniLilacSessionSnapshot {
    const row = this.database.query("SELECT * FROM sessions WHERE id = ?").get(sessionId);
    if (!row) throw new Error(`Session '${sessionId}' was not found`);
    return toSnapshot(row);
  }

  listSessions(): MiniLilacSessionSnapshot[] {
    return this.database.query("SELECT * FROM sessions ORDER BY created_at").all().map(toSnapshot);
  }

  updateSessionState(
    sessionId: string,
    status: MiniLilacSessionSnapshot["status"],
    queuedSteeringCount: number,
    activeRunId: string | null = this.getSession(sessionId).activeRunId,
  ): MiniLilacSessionSnapshot {
    this.database
      .query(
        "UPDATE sessions SET status = ?, active_run_id = ?, queued_steering_count = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, activeRunId, queuedSteeringCount, new Date().toISOString(), sessionId);
    return this.getSession(sessionId);
  }

  updateActiveRunInputTokens(
    sessionId: string,
    runId: string,
    inputTokens: number,
  ): MiniLilacSessionSnapshot {
    z.number().int().nonnegative().parse(inputTokens);
    const updated = this.database
      .query(
        `UPDATE sessions SET input_tokens = ?, updated_at = ?
         WHERE id = ? AND active_run_id = ? AND input_tokens IS NOT ?`,
      )
      .run(inputTokens, new Date().toISOString(), sessionId, runId, inputTokens);
    const snapshot = this.getSession(sessionId);
    if (updated.changes === 0 && snapshot.activeRunId !== runId) {
      throw new Error(`Run '${runId}' is not active for session '${sessionId}'`);
    }
    return snapshot;
  }

  updateSessionTitle(
    sessionId: string,
    expectedTitle: string,
    title: string,
  ): MiniLilacSessionSnapshot {
    this.database
      .query("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND title = ?")
      .run(title, new Date().toISOString(), sessionId, expectedTitle);
    return this.getSession(sessionId);
  }

  updateSessionBindings(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
    bindings: StoredSessionBindingUpdate,
  ): MiniLilacSessionSnapshot {
    const command = canonicalCommandPayload(request.payload);
    return this.database.transaction(() => {
      const previous = this.getCommandResult(sessionId, commandId, request);
      if (previous !== undefined) return miniLilacSessionSnapshotSchema.parse(previous);
      const snapshot = this.getSession(sessionId);
      const activeRunCount = z
        .object({ count: z.number().int().nonnegative() })
        .parse(
          this.database
            .query("SELECT COUNT(*) AS count FROM runs WHERE session_id = ? AND status = 'active'")
            .get(sessionId),
        ).count;
      if (
        !["idle", "error"].includes(snapshot.status) ||
        snapshot.activeRunId !== null ||
        activeRunCount > 0
      ) {
        throw new Error(`Session '${sessionId}' must be quiescent to update bindings`);
      }

      const now = new Date().toISOString();
      this.database
        .query(
          `UPDATE sessions
           SET model = ?, profile = ?, reasoning = ?,
               context_window = ?, input_tokens = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          bindings.model ?? snapshot.model,
          bindings.profile ?? snapshot.profile,
          bindings.reasoning ?? snapshot.reasoning,
          bindings.model === undefined
            ? (snapshot.contextWindow ?? null)
            : (bindings.contextWindow ?? null),
          bindings.model === undefined ? (snapshot.inputTokens ?? null) : null,
          now,
          sessionId,
        );
      const result = this.getSession(sessionId);
      this.database
        .query(
          `INSERT INTO commands
            (session_id, command_id, kind, run_id, request_fingerprint, request_json, side_effect_started, result_json, created_at)
           VALUES (?, ?, ?, NULL, ?, ?, 1, ?, ?)`,
        )
        .run(
          sessionId,
          commandId,
          request.kind,
          command.fingerprint,
          command.json,
          serialize(result),
          now,
        );
      return result;
    })();
  }

  createRun(input: CreateStoredRun): StoredRun {
    const now = new Date().toISOString();
    this.database
      .query(
        `INSERT INTO runs
          (id, session_id, parent_run_id, profile, depth, status, started_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(input.id, input.sessionId, input.parentRunId ?? null, input.profile, input.depth, now);
    return this.getRun(input.id);
  }

  beginRootRun(input: BeginStoredRootRun): MiniLilacSessionSnapshot {
    modelMessagesSchema.parse(input.modelMessages);
    miniLilacMessagesSchema.parse(input.uiMessages);
    if (input.run.parentRunId !== undefined) throw new Error("beginRootRun requires a root run");
    const command = canonicalCommandPayload(input.commandPayload);
    const userMessage = miniLilacUserUIMessageSchema.parse(input.uiMessages.at(-1));
    const userModelMessage = input.modelMessages.at(-1);
    if (userModelMessage?.role !== "user") {
      throw new Error("A root run must end with its admitted model user message");
    }
    const uiPosition = input.uiMessages.length - 1;
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.insertMessages(input.run.sessionId, input.modelMessages, input.uiMessages);
      this.database
        .query(
          `INSERT INTO runs
            (id, session_id, parent_run_id, profile, depth, status, started_at)
           VALUES (?, ?, NULL, ?, ?, 'active', ?)`,
        )
        .run(input.run.id, input.run.sessionId, input.run.profile, input.run.depth, now);
      this.insertUserCheckpoint(
        input.run.sessionId,
        uiPosition,
        userMessage,
        input.modelMessages.slice(0, -1),
        input.uiMessages.slice(0, -1),
        input.run.id,
        0,
      );
      this.database
        .query(
          "UPDATE sessions SET status = 'streaming', active_run_id = ?, queued_steering_count = 0, title = COALESCE(?, title), updated_at = ? WHERE id = ?",
        )
        .run(input.run.id, input.title ?? null, now, input.run.sessionId);
      const assigned = this.database
        .query(
          `UPDATE commands
           SET run_id = ?, side_effect_started = 1, result_json = ?
           WHERE session_id = ? AND command_id = ? AND kind = 'prompt'
             AND run_id IS NULL AND result_json IS NULL
             AND request_fingerprint = ? AND request_json = ?`,
        )
        .run(
          input.run.id,
          serialize({ runId: input.run.id }),
          input.run.sessionId,
          input.commandId,
          command.fingerprint,
          command.json,
        );
      if (assigned.changes !== 1) {
        throw new Error(`Prompt command '${input.commandId}' could not be assigned atomically`);
      }
    })();
    return this.getSession(input.run.sessionId);
  }

  getRun(runId: string): StoredRun {
    const row = this.database.query("SELECT * FROM runs WHERE id = ?").get(runId);
    if (!row) throw new Error(`Run '${runId}' was not found`);
    return toRun(row);
  }

  getLatestRun(sessionId: string): StoredRun | null {
    const row = this.database
      .query(
        "SELECT * FROM runs WHERE session_id = ? AND parent_run_id IS NULL AND undone_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get(sessionId);
    return row ? toRun(row) : null;
  }

  finishRun(
    runId: string,
    status: Exclude<MiniLilacRunStatus, "active">,
    options: { error?: string; terminalResult?: unknown } = {},
  ): void {
    this.database
      .query(
        "UPDATE runs SET status = ?, error = ?, terminal_result_json = ?, finished_at = ? WHERE id = ?",
      )
      .run(
        status,
        options.error ?? null,
        options.terminalResult === undefined ? null : serialize(options.terminalResult),
        new Date().toISOString(),
        runId,
      );
  }

  finalizeRootRun(input: FinalizeStoredRootRun): MiniLilacSessionSnapshot {
    modelMessagesSchema.parse(input.modelMessages);
    miniLilacMessagesSchema.parse(input.uiMessages);
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.insertMessages(input.sessionId, input.modelMessages, input.uiMessages);
      const finished = this.database
        .query(
          `UPDATE runs
           SET status = ?, error = ?, terminal_result_json = ?, finished_at = ?
           WHERE id = ? AND session_id = ? AND parent_run_id IS NULL AND status = 'active'`,
        )
        .run(
          input.runStatus,
          input.error ?? null,
          input.terminalResult === undefined ? null : serialize(input.terminalResult),
          now,
          input.runId,
          input.sessionId,
        );
      if (finished.changes !== 1) throw new Error(`Run '${input.runId}' is not active`);
      const updated = this.database
        .query(
          `UPDATE sessions
           SET status = ?, active_run_id = NULL, queued_steering_count = 0,
               input_tokens = ?, updated_at = ?
           WHERE id = ? AND active_run_id = ?`,
        )
        .run(input.sessionStatus, input.inputTokens ?? null, now, input.sessionId, input.runId);
      if (updated.changes !== 1) {
        throw new Error(`Run '${input.runId}' is not active for session '${input.sessionId}'`);
      }
    })();
    return this.getSession(input.sessionId);
  }

  getTodos(sessionId: string): MiniLilacTodoState {
    const session = this.database.query("SELECT 1 FROM sessions WHERE id = ?").get(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' was not found`);
    const value = this.database
      .query("SELECT revision, todos_json FROM session_todos WHERE session_id = ?")
      .get(sessionId);
    if (!value) return miniLilacTodoStateSchema.parse({ revision: 0, todos: [] });
    const row = todosRowSchema.parse(value);
    return miniLilacTodoStateSchema.parse({
      revision: row.revision,
      todos: JSON.parse(row.todos_json),
    });
  }

  replaceTodosForRun(input: ReplaceTodosForRun): ReplaceTodosForRunResult {
    const todos = miniLilacTodosSchema.parse(input.todos);
    const todosJson = JSON.stringify(canonicalJsonValue(todos));

    return this.database.transaction(() => {
      const activeRun = this.database
        .query(
          `SELECT 1
           FROM sessions
           JOIN runs ON runs.id = ? AND runs.session_id = sessions.id
           WHERE sessions.id = ? AND sessions.active_run_id = runs.id
             AND runs.parent_run_id IS NULL AND runs.status = 'active'`,
        )
        .get(input.runId, input.sessionId);
      if (!activeRun) {
        throw new Error(`Run '${input.runId}' is not active for session '${input.sessionId}'`);
      }

      const current = this.getTodos(input.sessionId);
      const currentJson = JSON.stringify(canonicalJsonValue(current.todos));
      if (currentJson === todosJson) return { state: current };
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new Error(`Session '${input.sessionId}' todo revision is exhausted`);
      }

      const now = new Date().toISOString();
      const updatedValue = this.database
        .query(
          `INSERT INTO session_todos (session_id, revision, todos_json, updated_at)
           VALUES (?, 1, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             revision = session_todos.revision + 1,
             todos_json = excluded.todos_json,
             updated_at = excluded.updated_at
           WHERE session_todos.todos_json <> excluded.todos_json
           RETURNING revision, todos_json`,
        )
        .get(input.sessionId, todosJson, now);
      if (!updatedValue) return { state: this.getTodos(input.sessionId) };

      const updated = todosRowSchema.parse(updatedValue);
      const state = miniLilacTodoStateSchema.parse({
        revision: updated.revision,
        todos: JSON.parse(updated.todos_json),
      });
      this.database
        .query("UPDATE sessions SET updated_at = ? WHERE id = ?")
        .run(now, input.sessionId);
      return { state };
    })();
  }

  replaceMessages(
    sessionId: string,
    modelMessages: readonly ModelMessage[],
    uiMessages: readonly MiniLilacUIMessage[],
  ): void {
    modelMessagesSchema.parse(modelMessages);
    miniLilacMessagesSchema.parse(uiMessages);
    this.database.transaction(() => this.insertMessages(sessionId, modelMessages, uiMessages))();
  }

  commitCompaction(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
    modelMessages: readonly ModelMessage[],
    resultValue: MiniLilacCompactResult,
  ): MiniLilacCompactResult {
    modelMessagesSchema.parse(modelMessages);
    const result = miniLilacCompactResultSchema.parse(resultValue);
    const command = canonicalCommandPayload(request.payload);
    return this.database.transaction(() => {
      const snapshot = this.getSession(sessionId);
      const activeRunCount = z
        .object({ count: z.number().int().nonnegative() })
        .parse(
          this.database
            .query("SELECT COUNT(*) AS count FROM runs WHERE session_id = ? AND status = 'active'")
            .get(sessionId),
        ).count;
      if (
        !["idle", "error"].includes(snapshot.status) ||
        snapshot.activeRunId !== null ||
        activeRunCount > 0
      ) {
        throw new Error(`Session '${sessionId}' must be quiescent to compact`);
      }

      if (result.status === "compacted") {
        this.insertModelMessages(sessionId, modelMessages);
        const uiMessages = this.getUiMessages(sessionId);
        uiMessages.push({
          id: `compaction:${commandId}`,
          role: "assistant",
          parts: [
            {
              type: "data-compaction",
              id: commandId,
              data: {
                source: "manual",
                reason: "manual",
                status: "completed",
                messageCountBefore: result.messageCountBefore,
                messageCountAfter: result.messageCountAfter,
                estimatedInputTokensBefore: result.estimatedInputTokensBefore,
                estimatedInputTokensAfter: result.estimatedInputTokensAfter,
              },
            },
          ],
        });
        this.insertUiMessages(sessionId, uiMessages);
        // Manual compaction is an undo barrier. New prompts create checkpoints
        // against the compacted transcript while the visible UI history remains intact.
        this.database.query("DELETE FROM user_checkpoints WHERE session_id = ?").run(sessionId);
        this.database
          .query("UPDATE sessions SET input_tokens = NULL, updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), sessionId);
      }
      const saved = this.database
        .query(
          `UPDATE commands SET side_effect_started = 1, result_json = ?
           WHERE session_id = ? AND command_id = ? AND kind = ?
             AND run_id IS NULL AND request_fingerprint = ? AND request_json = ?
             AND side_effect_started = 0 AND result_json IS NULL`,
        )
        .run(
          serialize(result),
          sessionId,
          commandId,
          request.kind,
          command.fingerprint,
          command.json,
        );
      if (saved.changes !== 1) {
        throw new Error(`Compact command '${commandId}' could not be committed atomically`);
      }
      return result;
    })();
  }

  appendUserCheckpoints(
    sessionId: string,
    rootRunId: string,
    checkpoints: readonly StoredUserCheckpoint[],
  ): void {
    if (checkpoints.length === 0) return;
    checkpoints.forEach((checkpoint) => {
      miniLilacUserUIMessageSchema.parse(checkpoint.message);
      modelMessagesSchema.parse(checkpoint.modelPrefix);
      miniLilacMessagesSchema.parse(checkpoint.uiPrefix);
      z.number().int().nonnegative().parse(checkpoint.replayAfterSeq);
    });
    this.database.transaction(() => {
      const checkpointPosition = z
        .object({ position: z.number().int() })
        .parse(
          this.database
            .query(
              "SELECT COALESCE(MAX(ui_position), -1) + 1 AS position FROM user_checkpoints WHERE session_id = ?",
            )
            .get(sessionId),
        ).position;
      const uiMessages = this.getUiMessages(sessionId);
      checkpoints.forEach((checkpoint, index) => {
        this.insertUserCheckpoint(
          sessionId,
          checkpointPosition + index,
          checkpoint.message,
          checkpoint.modelPrefix,
          checkpoint.uiPrefix,
          rootRunId,
          checkpoint.replayAfterSeq,
        );
        uiMessages.push(checkpoint.message);
      });
      this.insertUiMessages(sessionId, uiMessages);
    })();
  }

  undoLatestUser(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
  ): MiniLilacUndoResult {
    const command = canonicalCommandPayload(request.payload);
    return this.database.transaction(() => {
      const previous = this.getCommandResult(sessionId, commandId, request);
      if (previous !== undefined) return miniLilacUndoResultSchema.parse(previous);
      const snapshot = this.getSession(sessionId);
      const activeRunCount = z
        .object({ count: z.number().int().nonnegative() })
        .parse(
          this.database
            .query("SELECT COUNT(*) AS count FROM runs WHERE session_id = ? AND status = 'active'")
            .get(sessionId),
        ).count;
      if (
        !["idle", "error"].includes(snapshot.status) ||
        snapshot.activeRunId !== null ||
        activeRunCount > 0
      ) {
        throw new Error(`Session '${sessionId}' must be quiescent to undo`);
      }

      const uiMessages = this.getUiMessages(sessionId);
      const latestUserPosition = uiMessages.findLastIndex((message) => message.role === "user");
      const latestManualCompactionPosition = uiMessages.findLastIndex((message) => {
        return message.parts.some(
          (part) => part.type === "data-compaction" && part.data.source === "manual",
        );
      });
      if (latestUserPosition < 0 || latestManualCompactionPosition > latestUserPosition) {
        const result = miniLilacUndoResultSchema.parse({
          status: "empty",
          clientCommandId: commandId,
        });
        this.database
          .query(
            `INSERT INTO commands
              (session_id, command_id, kind, run_id, request_fingerprint, request_json, side_effect_started, result_json, created_at)
             VALUES (?, ?, ?, NULL, ?, ?, 1, ?, ?)`,
          )
          .run(
            sessionId,
            commandId,
            request.kind,
            command.fingerprint,
            command.json,
            serialize(result),
            new Date().toISOString(),
          );
        return result;
      }
      const latestUser = miniLilacUserUIMessageSchema.parse(uiMessages[latestUserPosition]);
      const checkpointValue = this.database
        .query(
          `SELECT ui_position, user_message_json, model_head_id, ui_head_id, root_run_id, replay_after_seq
           FROM user_checkpoints
           WHERE session_id = ?
           ORDER BY ui_position DESC LIMIT 1`,
        )
        .get(sessionId);
      if (!checkpointValue) {
        throw new Error(
          `Session '${sessionId}' has no durable checkpoint for its latest user message`,
        );
      }
      const checkpoint = checkpointRowSchema.parse(checkpointValue);
      const message = miniLilacUserUIMessageSchema.parse(deserialize(checkpoint.user_message_json));
      const latestUserJson = JSON.stringify(canonicalJsonValue(latestUser));
      const checkpointMessageJson = JSON.stringify(canonicalJsonValue(message));
      if (checkpointMessageJson !== latestUserJson) {
        throw new Error(
          `Session '${sessionId}' has an invalid checkpoint for its latest user message`,
        );
      }
      const result = miniLilacUndoResultSchema.parse({
        status: "undone",
        clientCommandId: commandId,
        message,
      });

      this.database
        .query(
          `DELETE FROM user_checkpoints
           WHERE session_id = ? AND ui_position >= ?`,
        )
        .run(sessionId, checkpoint.ui_position);
      this.setTranscriptHeads(sessionId, checkpoint.model_head_id, checkpoint.ui_head_id);
      this.database
        .query("UPDATE runs SET undone_at = ? WHERE id = ? AND session_id = ?")
        .run(new Date().toISOString(), checkpoint.root_run_id, sessionId);
      this.database
        .query("UPDATE sessions SET updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), sessionId);
      this.database
        .query(
          `INSERT INTO commands
            (session_id, command_id, kind, run_id, request_fingerprint, request_json, side_effect_started, result_json, created_at)
           VALUES (?, ?, ?, NULL, ?, ?, 1, ?, ?)`,
        )
        .run(
          sessionId,
          commandId,
          request.kind,
          command.fingerprint,
          command.json,
          serialize(result),
          new Date().toISOString(),
        );
      return result;
    })();
  }

  private insertMessages(
    sessionId: string,
    modelMessages: readonly ModelMessage[],
    uiMessages: readonly MiniLilacUIMessage[],
  ): void {
    this.insertModelMessages(sessionId, modelMessages);
    this.insertUiMessages(sessionId, uiMessages);
  }

  private insertUiMessages(sessionId: string, uiMessages: readonly MiniLilacUIMessage[]): void {
    const headId = this.internChain(sessionId, "ui", uiMessages);
    const heads = this.getTranscriptHeads(sessionId);
    this.setTranscriptHeads(sessionId, heads.model_head_id, headId);
  }

  private insertModelMessages(sessionId: string, modelMessages: readonly ModelMessage[]): void {
    const headId = this.internChain(sessionId, "model", modelMessages);
    const heads = this.getTranscriptHeads(sessionId);
    this.setTranscriptHeads(sessionId, headId, heads.ui_head_id);
  }

  private insertUserCheckpoint(
    sessionId: string,
    uiPosition: number,
    message: MiniLilacUserUIMessage,
    modelPrefix: readonly ModelMessage[],
    uiPrefix: readonly MiniLilacUIMessage[],
    rootRunId: string,
    replayAfterSeq: number,
  ): void {
    const modelHeadId = this.internChain(sessionId, "model", modelPrefix);
    const uiHeadId = this.internChain(sessionId, "ui", uiPrefix);
    this.database
      .query(
        `INSERT INTO user_checkpoints
          (session_id, ui_position, user_message_json, model_head_id, ui_head_id, root_run_id, replay_after_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        uiPosition,
        serialize(message),
        modelHeadId,
        uiHeadId,
        rootRunId,
        replayAfterSeq,
      );
  }

  getModelMessages(sessionId: string): ModelMessage[] {
    const values = this.readSerializedChain(
      sessionId,
      "model",
      this.getTranscriptHeads(sessionId).model_head_id,
    ).map(deserialize);
    return modelMessagesSchema.parse(values);
  }

  getUiMessages(sessionId: string): MiniLilacUIMessage[] {
    const values = this.readSerializedChain(
      sessionId,
      "ui",
      this.getTranscriptHeads(sessionId).ui_head_id,
    ).map(deserialize);
    return miniLilacMessagesSchema.parse(values);
  }

  getSessionResume(sessionId: string): StoredSessionResume {
    return {
      snapshot: this.getSession(sessionId),
      messages: this.getUiMessages(sessionId),
      replayCursor: null,
    };
  }

  private internChain(
    sessionId: string,
    lane: "model" | "ui",
    values: readonly unknown[],
  ): number | null {
    return this.internSerializedChain(sessionId, lane, values.map(serialize));
  }

  private internSerializedChain(
    sessionId: string,
    lane: "model" | "ui",
    values: readonly string[],
  ): number | null {
    let parent: z.infer<typeof transcriptNodeRowSchema> | null = null;
    for (const valueJson of values) {
      const hash: string = new Bun.CryptoHasher("sha256")
        .update(parent?.hash ?? "root")
        .update("\0")
        .update(valueJson)
        .digest("hex");
      const existingValue = this.database
        .query(
          `SELECT id, parent_id, depth, value_json, hash FROM transcript_nodes
           WHERE session_id = ? AND lane = ? AND hash = ?`,
        )
        .get(sessionId, lane, hash);
      if (existingValue) {
        const existing = transcriptNodeRowSchema.parse(existingValue);
        if (
          existing.parent_id !== (parent?.id ?? null) ||
          existing.depth !== (parent?.depth ?? 0) + 1 ||
          existing.value_json !== valueJson
        ) {
          throw new Error(`Transcript hash collision for session '${sessionId}' lane '${lane}'`);
        }
        parent = existing;
        continue;
      }
      const inserted = transcriptNodeRowSchema.pick({ id: true }).parse(
        this.database
          .query(
            `INSERT INTO transcript_nodes
              (session_id, lane, parent_id, depth, value_json, hash)
             VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
          )
          .get(sessionId, lane, parent?.id ?? null, (parent?.depth ?? 0) + 1, valueJson, hash),
      );
      parent = {
        id: inserted.id,
        parent_id: parent?.id ?? null,
        depth: (parent?.depth ?? 0) + 1,
        value_json: valueJson,
        hash,
      };
    }
    return parent?.id ?? null;
  }

  private getTranscriptHeads(sessionId: string): z.infer<typeof transcriptHeadRowSchema> {
    const value = this.database
      .query("SELECT model_head_id, ui_head_id FROM session_transcript_heads WHERE session_id = ?")
      .get(sessionId);
    return value ? transcriptHeadRowSchema.parse(value) : { model_head_id: null, ui_head_id: null };
  }

  private setTranscriptHeads(
    sessionId: string,
    modelHeadId: number | null,
    uiHeadId: number | null,
  ): void {
    this.database
      .query(
        `INSERT INTO session_transcript_heads (session_id, model_head_id, ui_head_id)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           model_head_id = excluded.model_head_id,
           ui_head_id = excluded.ui_head_id`,
      )
      .run(sessionId, modelHeadId, uiHeadId);
  }

  private readSerializedChain(
    sessionId: string,
    lane: "model" | "ui",
    headId: number | null,
  ): string[] {
    if (headId === null) return [];
    return this.database
      .query(
        `WITH RECURSIVE chain(id, parent_id, depth, value_json) AS (
           SELECT id, parent_id, depth, value_json FROM transcript_nodes
           WHERE id = ? AND session_id = ? AND lane = ?
           UNION ALL
           SELECT parent.id, parent.parent_id, parent.depth, parent.value_json
           FROM transcript_nodes AS parent
           JOIN chain AS child ON child.parent_id = parent.id
           WHERE parent.session_id = ? AND parent.lane = ?
         )
         SELECT value_json FROM chain ORDER BY depth`,
      )
      .all(headId, sessionId, lane, sessionId, lane)
      .map((value) => jsonRowSchema.parse(value).value_json);
  }

  getCommandResult(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
  ): unknown | undefined {
    const command = canonicalCommandPayload(request.payload);
    const value = this.database
      .query(
        `SELECT kind, run_id, request_fingerprint, request_json, side_effect_started, result_json
         FROM commands WHERE session_id = ? AND command_id = ?`,
      )
      .get(sessionId, commandId);
    if (!value) return undefined;
    const row = commandRowSchema.parse(value);
    if (row.kind !== request.kind) {
      throw new Error(`Command '${commandId}' was already used for '${row.kind}'`);
    }
    if (request.runId !== null && row.run_id !== request.runId) {
      throw new Error(`Command '${commandId}' was already used for a different run`);
    }
    if (row.request_fingerprint !== command.fingerprint || row.request_json !== command.json) {
      throw new Error(`Command '${commandId}' was already used with a different payload`);
    }
    if (row.result_json === null) throw new Error(`Command '${commandId}' is pending`);
    return deserialize(row.result_json);
  }

  reserveCommand(sessionId: string, commandId: string, request: StoredCommandRequest): void {
    const command = canonicalCommandPayload(request.payload);
    this.database
      .query(
        `INSERT INTO commands
          (session_id, command_id, kind, run_id, request_fingerprint, request_json, side_effect_started, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
      )
      .run(
        sessionId,
        commandId,
        request.kind,
        request.runId,
        command.fingerprint,
        command.json,
        new Date().toISOString(),
      );
  }

  releaseCommand(sessionId: string, commandId: string, request: StoredCommandRequest): void {
    const command = canonicalCommandPayload(request.payload);
    this.database
      .query(
        `DELETE FROM commands
         WHERE session_id = ? AND command_id = ? AND kind = ?
           AND run_id IS ? AND request_fingerprint = ? AND request_json = ?
           AND side_effect_started = 0 AND result_json IS NULL`,
      )
      .run(sessionId, commandId, request.kind, request.runId, command.fingerprint, command.json);
  }

  markCommandSideEffectStarted(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
  ): void {
    const command = canonicalCommandPayload(request.payload);
    const marked = this.database
      .query(
        `UPDATE commands SET side_effect_started = 1
         WHERE session_id = ? AND command_id = ? AND kind = ?
           AND run_id IS ? AND request_fingerprint = ? AND request_json = ?
           AND side_effect_started = 0 AND result_json IS NULL`,
      )
      .run(sessionId, commandId, request.kind, request.runId, command.fingerprint, command.json);
    if (marked.changes !== 1) {
      throw new Error(`Command '${commandId}' could not begin its side effect`);
    }
  }

  saveCommandResult(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
    result: unknown,
  ): void {
    const command = canonicalCommandPayload(request.payload);
    const saved = this.database
      .query(
        `UPDATE commands SET result_json = ?
         WHERE session_id = ? AND command_id = ? AND kind = ?
           AND run_id IS ? AND request_fingerprint = ? AND request_json = ?
           AND side_effect_started = 1 AND result_json IS NULL`,
      )
      .run(
        serialize(result),
        sessionId,
        commandId,
        request.kind,
        request.runId,
        command.fingerprint,
        command.json,
      );
    if (saved.changes !== 1) throw new Error(`Command '${commandId}' result could not be saved`);
  }
}
