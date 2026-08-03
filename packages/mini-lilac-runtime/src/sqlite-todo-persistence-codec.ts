import type { Database } from "bun:sqlite";

import {
  CorruptPersistedFields,
  MalformedSerialization,
  UnsupportedVersion,
  isRecord,
  type DecodedPersistedValue,
  type PersistedDataError,
  type PersistedDataIssueCode,
  type PersistenceProvenance,
} from "@stanley2058/lilac-utils";
import {
  miniLilacTodoStateSchema,
  miniLilacTodosSchema,
  type MiniLilacTodoState,
} from "@stanley2058/mini-lilac-client";
import { Panic, Result, type Result as ResultType } from "better-result";

import {
  MiniLilacSqliteDriverFailure,
  classifyMiniLilacSqliteDriverFailure,
} from "./sqlite-persistence-errors";

const CURRENT_VERSION = 8;

export type MiniLilacTodosCodecInput = {
  readonly schemaVersion: number;
  readonly recordId: string;
  readonly row: unknown;
};

type DecodedVersion = {
  readonly version: 2 | 3 | 4 | 5 | 6 | 7 | 8;
  readonly provenance: Exclude<PersistenceProvenance, "missing-defaulted">;
};

function context(input: {
  readonly version: number;
  readonly issueCode: PersistedDataIssueCode;
  readonly recordId: string;
}) {
  return {
    table: "session_todos",
    field: "todos",
    version: input.version,
    issueCode: input.issueCode,
    recordId: input.recordId.slice(0, 128),
    message: `Persisted Mini Lilac todos ${input.issueCode}`,
  };
}

function corrupt(input: {
  readonly version: number;
  readonly issueCode: PersistedDataIssueCode;
  readonly recordId: string;
}): CorruptPersistedFields {
  return new CorruptPersistedFields(context(input));
}

function decodeVersion(
  schemaVersion: number,
  recordId: string,
): ResultType<DecodedVersion, UnsupportedVersion | CorruptPersistedFields> {
  if (!Number.isInteger(schemaVersion) || schemaVersion < 2) {
    return Result.err(
      corrupt({ version: schemaVersion, issueCode: "invalid-row-version", recordId }),
    );
  }
  if (schemaVersion > CURRENT_VERSION) {
    return Result.err(
      new UnsupportedVersion(
        context({ version: schemaVersion, issueCode: "unsupported-version", recordId }),
      ),
    );
  }
  switch (schemaVersion) {
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
    case 7:
    case 8:
      return Result.ok({
        version: schemaVersion,
        provenance: schemaVersion === CURRENT_VERSION ? "current" : "migrated",
      });
  }
  return Result.err(
    corrupt({ version: schemaVersion, issueCode: "invalid-row-version", recordId }),
  );
}

export function decodeMiniLilacTodos(
  input: MiniLilacTodosCodecInput,
): ResultType<DecodedPersistedValue<MiniLilacTodoState>, PersistedDataError> {
  const version = decodeVersion(input.schemaVersion, input.recordId);
  if (version.status === "error") return Result.err(version.error);
  if (input.row === null) {
    return Result.ok({ value: { revision: 0, todos: [] }, provenance: "missing-defaulted" });
  }
  if (
    !isRecord(input.row) ||
    typeof input.row.todos_json !== "string" ||
    typeof input.row.revision !== "number" ||
    !Number.isSafeInteger(input.row.revision) ||
    input.row.revision < 0
  ) {
    return Result.err(
      corrupt({
        version: version.value.version,
        issueCode: "invalid-row-field",
        recordId: input.recordId,
      }),
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(input.row.todos_json);
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new MalformedSerialization(
        context({
          version: version.value.version,
          issueCode: "malformed-json",
          recordId: input.recordId,
        }),
      ),
    );
  }
  const todos = miniLilacTodosSchema.safeParse(value);
  const state = todos.success
    ? miniLilacTodoStateSchema.safeParse({ revision: input.row.revision, todos: todos.data })
    : todos;
  if (!state.success) {
    return Result.err(
      corrupt({
        version: version.value.version,
        issueCode: "invalid-row-field",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: state.data, provenance: version.value.provenance });
}

export function readMiniLilacTodos(
  database: Database,
  sessionId: string,
): ResultType<MiniLilacTodoState, PersistedDataError | MiniLilacSqliteDriverFailure> {
  try {
    const session = database.query("SELECT 1 FROM sessions WHERE id = ?").get(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' was not found`);
    const row = database
      .query("SELECT revision, todos_json FROM session_todos WHERE session_id = ?")
      .get(sessionId);
    const decoded = decodeMiniLilacTodos({
      row,
      schemaVersion: CURRENT_VERSION,
      recordId: sessionId,
    });
    if (decoded.status === "error") return Result.err(decoded.error);
    return Result.ok(decoded.value.value);
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    if (!(cause instanceof Error)) throw cause;
    const driverFailure = classifyMiniLilacSqliteDriverFailure("getTodos", cause);
    if (driverFailure !== undefined) return Result.err(driverFailure);
    throw cause;
  }
}

export const miniLilacTodosCodecCases = {
  current: {
    input: { row: { todos_json: "[]", revision: 0 }, schemaVersion: 8, recordId: "current" },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: { row: { todos_json: "[]", revision: 0 }, schemaVersion: 2, recordId: "legacy" },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { row: null, schemaVersion: 8, recordId: "missing" },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: { row: { todos_json: "[]", revision: 0 }, schemaVersion: 9, recordId: "unsupported" },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { row: { todos_json: "[", revision: 0 }, schemaVersion: 8, recordId: "malformed" },
    outcome: "error",
  },
  "corrupt-fields": {
    input: { row: { todos_json: "{}", revision: 0 }, schemaVersion: 8, recordId: "corrupt" },
    outcome: "error",
  },
} as const;
