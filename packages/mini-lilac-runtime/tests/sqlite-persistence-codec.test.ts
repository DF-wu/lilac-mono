import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import SuperJSON from "superjson";

import {
  CorruptPersistedFields,
  MalformedSerialization,
  UnsupportedVersion,
} from "@stanley2058/lilac-utils";

import {
  decodeMiniLilacCommandRequest,
  decodeMiniLilacModelTranscript,
  decodeMiniLilacSuperJsonPayload,
  decodeMiniLilacTranscriptChain,
  decodeMiniLilacUiTranscript,
  miniLilacCommandRequestCodecCases,
  miniLilacModelTranscriptCodecCases,
  miniLilacUiTranscriptCodecCases,
} from "../src/sqlite-persistence-codec";
import { MiniLilacSqliteDriverFailure, MiniLilacSqliteStore } from "../src/sqlite-store";
import {
  decodeMiniLilacTodos,
  miniLilacTodosCodecCases,
} from "../src/sqlite-todo-persistence-codec";
import {
  adaptPersistedModelMessagesToSdk,
  adaptPersistedUiMessagesToSdk,
} from "../src/sqlite-transcript-representation-adapter";

const EXPECTED_CASES = [
  "corrupt-fields",
  "current",
  "legacy",
  "malformed-serialization",
  "missing-defaulted",
  "unsupported-version",
];

function expectCatalog(
  catalog: Readonly<Record<string, { readonly input: object; readonly outcome: "ok" | "error" }>>,
  decode: (input: never) => { readonly status: "ok" | "error" },
): void {
  expect(Object.keys(catalog).sort()).toEqual(EXPECTED_CASES);
  for (const fixture of Object.values(catalog)) {
    expect(decode(fixture.input as never).status).toBe(fixture.outcome);
  }
}

describe("Mini Lilac SQLite persistence codecs", () => {
  it("exports honest six-case catalogs across the supported schema versions", () => {
    expectCatalog(miniLilacModelTranscriptCodecCases, decodeMiniLilacModelTranscript);
    expectCatalog(miniLilacUiTranscriptCodecCases, decodeMiniLilacUiTranscript);
    expectCatalog(miniLilacTodosCodecCases, decodeMiniLilacTodos);
    expectCatalog(miniLilacCommandRequestCodecCases, decodeMiniLilacCommandRequest);
  });

  it("distinguishes current, legacy, absent, unsupported, malformed, and corrupt values", () => {
    const current = decodeMiniLilacTodos(miniLilacTodosCodecCases.current.input);
    expect(current.status).toBe("ok");
    if (current.status === "ok") expect(current.value.provenance).toBe("current");

    const legacy = decodeMiniLilacTodos(miniLilacTodosCodecCases.legacy.input);
    expect(legacy.status).toBe("ok");
    if (legacy.status === "ok") expect(legacy.value.provenance).toBe("migrated");

    const absent = decodeMiniLilacTodos(miniLilacTodosCodecCases["missing-defaulted"].input);
    expect(absent.status).toBe("ok");
    if (absent.status === "ok") expect(absent.value.provenance).toBe("missing-defaulted");

    const unsupported = decodeMiniLilacTodos(miniLilacTodosCodecCases["unsupported-version"].input);
    expect(unsupported.status).toBe("error");
    if (unsupported.status === "error")
      expect(unsupported.error).toBeInstanceOf(UnsupportedVersion);

    const malformed = decodeMiniLilacTodos(
      miniLilacTodosCodecCases["malformed-serialization"].input,
    );
    expect(malformed.status).toBe("error");
    if (malformed.status === "error")
      expect(malformed.error).toBeInstanceOf(MalformedSerialization);

    const corrupt = decodeMiniLilacTodos(miniLilacTodosCodecCases["corrupt-fields"].input);
    expect(corrupt.status).toBe("error");
    if (corrupt.status === "error") expect(corrupt.error).toBeInstanceOf(CorruptPersistedFields);
  });

  it("does not confuse canonical JSON bytes with SuperJSON bytes", () => {
    const canonical = '{"message":"plain"}';
    const superJson = SuperJSON.stringify({ message: "wrapped" });
    expect(
      decodeMiniLilacCommandRequest({ raw: canonical, schemaVersion: 8, recordId: "plain" }).status,
    ).toBe("ok");
    expect(
      decodeMiniLilacCommandRequest({ raw: superJson, schemaVersion: 8, recordId: "wrapped" })
        .status,
    ).toBe("error");
    expect(
      decodeMiniLilacSuperJsonPayload({
        raw: canonical,
        schemaVersion: 8,
        recordId: "plain",
        field: "command_result",
      }).status,
    ).toBe("error");
    expect(
      decodeMiniLilacSuperJsonPayload({
        raw: superJson,
        schemaVersion: 8,
        recordId: "wrapped",
        field: "command_result",
      }).status,
    ).toBe("ok");
  });

  it("validates transcript content addressing over exact persisted bytes", () => {
    const valueJson = SuperJSON.stringify({ role: "user", content: "hash me" });
    const hash = new Bun.CryptoHasher("sha256")
      .update("root")
      .update("\0")
      .update(valueJson)
      .digest("hex");
    const row = { id: 1, parentId: null, depth: 1, valueJson, hash } as const;
    const input = {
      headId: 1,
      lane: "model" as const,
      rows: [row],
      schemaVersion: 8,
      recordId: "session",
    };
    expect(decodeMiniLilacTranscriptChain(input).status).toBe("ok");
    const corrupt = decodeMiniLilacTranscriptChain({
      ...input,
      rows: [{ ...row, hash: "0".repeat(64) }],
    });
    expect(corrupt.status).toBe("error");
    if (corrupt.status === "error") expect(corrupt.error.issueCode).toBe("digest-mismatch");
  });

  it("preserves exact SuperJSON representations across the closed SDK adapters", () => {
    const modelValues = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "inspect",
            input: {
              requestedAt: new Date("2026-08-03T00:00:00.000Z"),
              labels: new Set(["one", "two"]),
              lookup: new Map([["answer", 42n]]),
              bytes: new Uint8Array([1, 2, 3]),
              optional: undefined,
              limit: Infinity,
            },
            providerOptions: { openai: { store: false } },
            providerExecuted: true,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tool-1",
            toolName: "inspect",
            output: {
              type: "content",
              value: [
                { type: "text", text: "attached" },
                {
                  type: "file",
                  mediaType: "application/octet-stream",
                  filename: "fixture.bin",
                  data: { type: "data", data: new Uint8Array([4, 5, 6]) },
                },
              ],
            },
          },
        ],
      },
    ];
    const modelBytes = modelValues.map((value) => SuperJSON.stringify(value));
    const decodedModel = decodeMiniLilacModelTranscript({
      rawValues: modelBytes,
      schemaVersion: 8,
      recordId: "model-roundtrip",
    });
    expect(decodedModel.status).toBe("ok");
    if (decodedModel.status === "ok") {
      const decodedModelValues: unknown = decodedModel.value.value;
      expect(decodedModelValues).toEqual(modelValues);
      const adapted = adaptPersistedModelMessagesToSdk(decodedModel.value.value);
      expect(adapted[0]).toBe(decodedModel.value.value[0]);
      expect(adapted[1]).toBe(decodedModel.value.value[1]);
      expect(SuperJSON.stringify(adapted)).toBe(SuperJSON.stringify(decodedModel.value.value));
    }

    const uiValues = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "inspect",
            toolCallId: "tool-1",
            title: "Inspect",
            state: "output-available",
            input: { requestedAt: new Date("2026-08-03T00:00:00.000Z") },
            rawInput: undefined,
            output: {
              values: new Map([["result", { ok: true }]]),
              absent: undefined,
            },
            errorText: undefined,
            preliminary: false,
            providerExecuted: true,
            toolMetadata: { source: { kind: "fixture" } },
            callProviderMetadata: { openai: { itemId: "call-1" } },
            resultProviderMetadata: { openai: { itemId: "result-1" } },
            approval: {
              id: "approval-1",
              approved: true,
              reason: "fixture",
              isAutomatic: false,
              signature: "signed",
            },
          },
        ],
      },
    ];
    const uiBytes = uiValues.map((value) => SuperJSON.stringify(value));
    const decodedUi = decodeMiniLilacUiTranscript({
      rawValues: uiBytes,
      schemaVersion: 8,
      recordId: "ui-roundtrip",
    });
    expect(decodedUi.status).toBe("ok");
    if (decodedUi.status === "ok") {
      const decodedUiValues: unknown = decodedUi.value.value;
      expect(decodedUiValues).toEqual(uiValues);
      const adapted = adaptPersistedUiMessagesToSdk(decodedUi.value.value);
      expect(adapted[0]).toBe(decodedUi.value.value[0]);
      expect(SuperJSON.stringify(adapted)).toBe(SuperJSON.stringify(decodedUi.value.value));
    }
  });

  it("returns corruption for hostile and non-serializable nested transcript payloads", () => {
    const unsupportedModelValue = SuperJSON.stringify({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "hostile",
          toolName: "inspect",
          input: new Error("secret nested error"),
        },
      ],
    });
    const unsupportedModel = decodeMiniLilacModelTranscript({
      rawValues: [unsupportedModelValue],
      schemaVersion: 8,
      recordId: "hostile-model",
    });
    expect(unsupportedModel.status).toBe("error");
    if (unsupportedModel.status === "error") {
      expect(unsupportedModel.error).toBeInstanceOf(CorruptPersistedFields);
      expect(unsupportedModel.error.message).not.toContain("secret nested error");
    }

    const nonSerializableModel = decodeMiniLilacModelTranscript({
      rawValues: [
        SuperJSON.stringify({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "function",
              toolName: "inspect",
              output: () => "not serializable",
            },
          ],
        }),
      ],
      schemaVersion: 8,
      recordId: "non-serializable-model",
    });
    expect(nonSerializableModel.status).toBe("error");

    const malformedNestedUi = decodeMiniLilacUiTranscript({
      rawValues: [
        SuperJSON.stringify({
          id: "assistant-hostile",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "inspect",
              toolCallId: "hostile",
              state: "output-available",
              input: { ok: true },
              output: new Error("hostile UI output"),
            },
          ],
        }),
      ],
      schemaVersion: 8,
      recordId: "hostile-ui",
    });
    expect(malformedNestedUi.status).toBe("error");

    const invalidJsonToolOutput = decodeMiniLilacModelTranscript({
      rawValues: [
        SuperJSON.stringify({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "malformed-json-output",
              toolName: "inspect",
              output: { type: "json", value: { createdAt: new Date() } },
            },
          ],
        }),
      ],
      schemaVersion: 8,
      recordId: "malformed-json-output",
    });
    expect(invalidJsonToolOutput.status).toBe("error");
  });

  it("accepts cyclic SuperJSON tool values without losing reference compatibility", () => {
    const cyclic: Record<string, object> = {};
    cyclic.self = cyclic;
    const raw = SuperJSON.stringify({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "cyclic",
          toolName: "inspect",
          input: cyclic,
        },
      ],
    });
    const decoded = decodeMiniLilacModelTranscript({
      rawValues: [raw],
      schemaVersion: 8,
      recordId: "cyclic",
    });
    expect(decoded.status).toBe("ok");
    if (decoded.status === "ok") {
      expect(SuperJSON.stringify(adaptPersistedModelMessagesToSdk(decoded.value.value)[0])).toBe(
        raw,
      );
    }
  });

  it("decodes explicit legacy v2 model and UI transcript fixtures", () => {
    const model = decodeMiniLilacModelTranscript(miniLilacModelTranscriptCodecCases.legacy.input);
    expect(model.status).toBe("ok");
    if (model.status === "ok") {
      expect(model.value.provenance).toBe("migrated");
      expect(adaptPersistedModelMessagesToSdk(model.value.value)).toEqual([
        { role: "assistant", content: "legacy-v2" },
      ]);
    }

    const ui = decodeMiniLilacUiTranscript(miniLilacUiTranscriptCodecCases.legacy.input);
    expect(ui.status).toBe("ok");
    if (ui.status === "ok") {
      expect(ui.value.provenance).toBe("migrated");
      expect(adaptPersistedUiMessagesToSdk(ui.value.value)).toEqual([
        {
          id: "assistant-v2",
          role: "assistant",
          parts: [{ type: "text", text: "legacy-v2" }],
        },
      ]);
    }
  });

  it("reports an absent operational transcript as missing-defaulted", () => {
    const store = new MiniLilacSqliteStore(":memory:");
    store.createSession({
      id: "missing-transcript",
      cwd: "/tmp",
      model: "test/mock",
      profile: "reader",
      reasoning: "high",
    });
    const model = store.getModelTranscriptResult("missing-transcript");
    const ui = store.getUiTranscriptResult("missing-transcript");
    expect(model).toMatchObject({
      status: "ok",
      value: { value: [], provenance: "missing-defaulted" },
    });
    expect(ui).toMatchObject({
      status: "ok",
      value: { value: [], provenance: "missing-defaulted" },
    });
    store.close();
  });

  it("bounds and redacts diagnostics", () => {
    const secret = "secret-token-".repeat(40);
    const result = decodeMiniLilacTodos({
      row: { todos_json: `[{"secret":"${secret}"}]`, revision: 1 },
      schemaVersion: 8,
      recordId: secret,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.recordId.length).toBeLessThanOrEqual(128);
      expect(result.error.message).not.toContain(secret);
      expect(JSON.stringify(result.error.message)).not.toContain("token");
    }
  });

  it("does not rewrite malformed or corrupt persisted bytes while reading", () => {
    const store = new MiniLilacSqliteStore(":memory:");
    store.createSession({
      id: "session",
      cwd: "/tmp",
      model: "test/mock",
      profile: "reader",
      reasoning: "high",
    });
    const malformed = "[";
    store.database
      .query(
        "INSERT INTO session_todos (session_id, revision, todos_json, updated_at) VALUES (?, 1, ?, ?)",
      )
      .run("session", malformed, new Date().toISOString());
    const todos = store.getTodosResult("session");
    expect(todos.status).toBe("error");
    if (todos.status === "error") expect(todos.error).toBeInstanceOf(MalformedSerialization);
    expect(
      store.database
        .query<{ todos_json: string }, [string]>(
          "SELECT todos_json FROM session_todos WHERE session_id = ?",
        )
        .get("session")?.todos_json,
    ).toBe(malformed);

    store.internHistoryTranscriptHeads(
      "session",
      [{ role: "user", content: "original" }],
      [{ id: "user", role: "user", parts: [{ type: "text", text: "original" }] }],
    );
    const node = store.database
      .query<{ id: number; value_json: string }, []>(
        "SELECT id, value_json FROM transcript_nodes WHERE lane = 'model'",
      )
      .get();
    if (node === null) throw new Error("model transcript fixture missing");
    store.database
      .query(
        `INSERT INTO session_transcript_heads (session_id, model_head_id)
         VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET model_head_id = excluded.model_head_id`,
      )
      .run("session", node.id);
    const replacement = SuperJSON.stringify({ role: "user", content: "tampered" });
    store.database
      .query("UPDATE transcript_nodes SET value_json = ? WHERE id = ?")
      .run(replacement, node.id);
    const messages = store.getModelMessagesResult("session");
    expect(messages.status).toBe("error");
    if (messages.status === "error") {
      expect(messages.error).toBeInstanceOf(CorruptPersistedFields);
    }
    expect(
      store.database
        .query<{ value_json: string }, [number]>(
          "SELECT value_json FROM transcript_nodes WHERE id = ?",
        )
        .get(node.id)?.value_json,
    ).toBe(replacement);
    store.close();
  });

  it("returns an owned redacted driver failure and rolls back partial writes", () => {
    const store = new MiniLilacSqliteStore(":memory:");
    store.createSession({
      id: "session",
      cwd: "/tmp",
      model: "test/mock",
      profile: "reader",
      reasoning: "high",
    });
    store.database.run(`
      CREATE TRIGGER fail_root_history BEFORE INSERT ON session_history
      BEGIN SELECT RAISE(ABORT, 'sensitive trigger detail'); END;
    `);

    let failure: unknown;
    try {
      store.createSession({
        id: "rollback",
        cwd: "/var/tmp",
        model: "test/mock",
        profile: "reader",
        reasoning: "high",
      });
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(MiniLilacSqliteDriverFailure);
    if (failure instanceof MiniLilacSqliteDriverFailure) {
      expect(failure.operation).toBe("createSession");
      expect(failure.code.startsWith("SQLITE_")).toBe(true);
      expect(failure.message).not.toContain("sensitive");
    }
    expect(store.database.query("SELECT 1 FROM sessions WHERE id = 'rollback'").get()).toBeNull();
    expect(
      store.database.query("SELECT 1 FROM workspaces WHERE canonical_cwd = '/var/tmp'").get(),
    ).toBeNull();
    store.close();
  });

  it("maps real concurrent writer contention without committing the blocked writer", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-sqlite-contention-"));
    const databasePath = path.join(directory, "runtime.sqlite");
    const first = new MiniLilacSqliteStore(databasePath);
    const second = new MiniLilacSqliteStore(databasePath);
    try {
      first.database.run("BEGIN IMMEDIATE");
      let failure: unknown;
      try {
        second.createSession({
          id: "blocked",
          cwd: directory,
          model: "test/mock",
          profile: "reader",
          reasoning: "high",
        });
      } catch (cause) {
        failure = cause;
      }
      expect(failure).toBeInstanceOf(MiniLilacSqliteDriverFailure);
      first.database.run("ROLLBACK");
      expect(first.database.query("SELECT 1 FROM sessions WHERE id = 'blocked'").get()).toBeNull();
    } finally {
      first.close();
      second.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
