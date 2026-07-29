import { describe, expect, it } from "bun:test";
import type { MiniLilacTodo } from "@stanley2058/mini-lilac-client";

import { MINI_LILAC_DATABASE_SCHEMA_VERSION, MiniLilacSqliteStore } from "../src/sqlite-store";

const FIRST_TODO = {
  content: "Inspect the storage layer",
  status: "in_progress",
  priority: "high",
} as const satisfies MiniLilacTodo;

const SECOND_TODO = {
  content: "Add durable tests",
  status: "pending",
  priority: "medium",
} as const satisfies MiniLilacTodo;

function createStore(): MiniLilacSqliteStore {
  return new MiniLilacSqliteStore(":memory:");
}

function createSession(store: MiniLilacSqliteStore, sessionId: string): void {
  store.createSession({
    id: sessionId,
    cwd: "/tmp",
    model: "test/mock",
    profile: "reader",
    reasoning: "high",
  });
}

function createActiveRootRun(store: MiniLilacSqliteStore, sessionId: string, runId: string): void {
  store.createRun({ id: runId, sessionId, profile: "reader", depth: 0 });
  store.updateSessionState(sessionId, "streaming", 0, runId);
}

describe("MiniLilacSqliteStore todos", () => {
  it("creates the current schema and returns an empty state for a fresh session", () => {
    const store = createStore();
    createSession(store, "session-1");

    expect(store.database.query("PRAGMA user_version").get()).toEqual({
      user_version: MINI_LILAC_DATABASE_SCHEMA_VERSION,
    });
    expect(store.getTodos("session-1")).toEqual({ revision: 0, todos: [] });
    expect(
      store.database.query("SELECT * FROM session_todos WHERE session_id = ?").get("session-1"),
    ).toBeNull();
    expect(() => store.getTodos("missing")).toThrow("Session 'missing' was not found");

    store.close();
  });

  it("does not persist, revise, or emit for an identical canonical list", () => {
    const store = createStore();
    createSession(store, "session-1");
    createActiveRootRun(store, "session-1", "run-1");
    const updatedAt = store.getSession("session-1").updatedAt;

    expect(store.replaceTodosForRun({ sessionId: "session-1", runId: "run-1", todos: [] })).toEqual(
      { state: { revision: 0, todos: [] } },
    );
    expect(store.getSession("session-1").updatedAt).toBe(updatedAt);
    expect(store.database.query("SELECT * FROM session_todos").all()).toEqual([]);

    store.close();
  });

  it("replaces and clears durable state with monotonic revisions", () => {
    const store = createStore();
    createSession(store, "session-1");
    createActiveRootRun(store, "session-1", "run-1");

    const changed = store.replaceTodosForRun({
      sessionId: "session-1",
      runId: "run-1",
      todos: [FIRST_TODO, SECOND_TODO],
    });
    expect(changed).toEqual({
      state: { revision: 1, todos: [FIRST_TODO, SECOND_TODO] },
    });
    expect(store.getTodos("session-1")).toEqual(changed.state);

    const noOp = store.replaceTodosForRun({
      sessionId: "session-1",
      runId: "run-1",
      todos: [FIRST_TODO, SECOND_TODO],
    });
    expect(noOp).toEqual({ state: changed.state });
    const cleared = store.replaceTodosForRun({
      sessionId: "session-1",
      runId: "run-1",
      todos: [],
    });
    expect(cleared.state).toEqual({ revision: 2, todos: [] });

    store.close();
  });

  it("isolates todo state by session", () => {
    const store = createStore();
    createSession(store, "session-1");
    createSession(store, "session-2");
    createActiveRootRun(store, "session-1", "run-1");
    createActiveRootRun(store, "session-2", "run-2");

    store.replaceTodosForRun({
      sessionId: "session-1",
      runId: "run-1",
      todos: [FIRST_TODO],
    });
    store.replaceTodosForRun({
      sessionId: "session-2",
      runId: "run-2",
      todos: [SECOND_TODO],
    });

    expect(store.getTodos("session-1").todos).toEqual([FIRST_TODO]);
    expect(store.getTodos("session-2").todos).toEqual([SECOND_TODO]);
    store.database.query("DELETE FROM sessions WHERE id = ?").run("session-1");
    expect(
      store.database.query("SELECT * FROM session_todos WHERE session_id = ?").get("session-1"),
    ).toBeNull();

    store.close();
  });

  it("validates the complete todo list before writing", () => {
    const store = createStore();
    createSession(store, "session-1");
    createActiveRootRun(store, "session-1", "run-1");

    expect(() =>
      store.replaceTodosForRun({
        sessionId: "session-1",
        runId: "run-1",
        todos: [FIRST_TODO, { ...SECOND_TODO, status: "in_progress" }],
      }),
    ).toThrow("Todo list may contain at most one in-progress todo");
    expect(store.getTodos("session-1")).toEqual({ revision: 0, todos: [] });

    store.close();
  });

  it("requires the session's active root run", () => {
    const store = createStore();
    createSession(store, "session-1");
    createSession(store, "session-2");
    createActiveRootRun(store, "session-1", "run-1");
    createActiveRootRun(store, "session-2", "run-2");
    store.createRun({
      id: "child-1",
      sessionId: "session-1",
      parentRunId: "run-1",
      profile: "reader",
      depth: 1,
    });

    expect(() =>
      store.replaceTodosForRun({
        sessionId: "session-1",
        runId: "run-2",
        todos: [FIRST_TODO],
      }),
    ).toThrow("Run 'run-2' is not active for session 'session-1'");
    expect(() =>
      store.replaceTodosForRun({
        sessionId: "session-1",
        runId: "child-1",
        todos: [FIRST_TODO],
      }),
    ).toThrow("Run 'child-1' is not active for session 'session-1'");

    store.finishRun("run-1", "completed");
    expect(() =>
      store.replaceTodosForRun({
        sessionId: "session-1",
        runId: "run-1",
        todos: [FIRST_TODO],
      }),
    ).toThrow("Run 'run-1' is not active for session 'session-1'");
    expect(store.getTodos("session-1")).toEqual({ revision: 0, todos: [] });

    store.close();
  });

  it("rolls back todo state when its durable session update fails", () => {
    const store = createStore();
    createSession(store, "session-1");
    createActiveRootRun(store, "session-1", "run-1");
    store.replaceTodosForRun({
      sessionId: "session-1",
      runId: "run-1",
      todos: [FIRST_TODO],
    });
    const beforeState = store.getTodos("session-1");
    const beforeUpdatedAt = store.getSession("session-1").updatedAt;
    store.database.exec(`
      CREATE TRIGGER reject_todo_session_update BEFORE UPDATE ON sessions
      BEGIN
        SELECT RAISE(ABORT, 'rejected session update');
      END;
    `);

    expect(() =>
      store.replaceTodosForRun({
        sessionId: "session-1",
        runId: "run-1",
        todos: [SECOND_TODO],
      }),
    ).toThrow("rejected session update");
    expect(store.getTodos("session-1")).toEqual(beforeState);
    expect(store.getSession("session-1").updatedAt).toBe(beforeUpdatedAt);

    store.close();
  });

  it("rejects revision overflow without changing state or chunks", () => {
    const store = createStore();
    createSession(store, "session-1");
    createActiveRootRun(store, "session-1", "run-1");
    store.database
      .query(
        "INSERT INTO session_todos (session_id, revision, todos_json, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "session-1",
        Number.MAX_SAFE_INTEGER,
        JSON.stringify([FIRST_TODO]),
        new Date().toISOString(),
      );

    expect(() =>
      store.replaceTodosForRun({
        sessionId: "session-1",
        runId: "run-1",
        todos: [SECOND_TODO],
      }),
    ).toThrow("Session 'session-1' todo revision is exhausted");
    expect(store.getTodos("session-1")).toEqual({
      revision: Number.MAX_SAFE_INTEGER,
      todos: [FIRST_TODO],
    });
    store.close();
  });
});
