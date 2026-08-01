import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import SuperJSON from "superjson";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ModelMessage } from "ai";
import { hashCanonicalMessagesV1 } from "@stanley2058/lilac-agent";
import {
  buildCoreLineageManifestV1,
  computeCoreLineagePrefixDigestV1,
  type CoreLineageAtomV1,
  type CoreLineageManifestV1,
  type CoreRequestAliasV1,
} from "@stanley2058/lilac-event-bus";

import {
  CORE_SURFACE_PROJECTION_FORMAT_VERSION,
  computeCorePrimaryClaudeTerminalHead,
  CoreOwnedBlobIntegrityError,
  SqliteTranscriptStore,
} from "../../src/transcript/transcript-store";
import { selectCorePrimaryClaudePrefix } from "../../src/surface/bridge/bus-agent-runner/core-primary-continuation";

function manifestFor(
  atoms: readonly CoreLineageAtomV1[],
  canonicalMessages: readonly ModelMessage[],
  requestAliases?: readonly CoreRequestAliasV1[],
): CoreLineageManifestV1 {
  return {
    state: "complete",
    lineageVersion: 1,
    currentCanonicalStart: 0,
    segments: [
      {
        atoms: [...atoms],
        canonicalMessages: [...canonicalMessages],
        ...(requestAliases ? { requestSource: { aliases: [...requestAliases] } } : {}),
        canonicalStart: 0,
        canonicalEnd: canonicalMessages.length,
        cumulativeAtomCount: atoms.length,
        cumulativePrefixDigest: computeCoreLineagePrefixDigestV1(atoms),
      },
    ],
  };
}

function syntheticManifestSegment(messages: readonly ModelMessage[]) {
  return {
    atoms: [
      {
        kind: "synthetic" as const,
        source: "transcript-store-test",
        messageDigest: hashCanonicalMessagesV1(messages).hash,
      },
    ],
    canonicalMessages: messages,
  };
}

function seedPrimaryBinding(store: SqliteTranscriptStore, requestId: string, sessionId: string) {
  const inputMessages = [{ role: "user", content: `input:${requestId}` }] satisfies ModelMessage[];
  const manifest = buildCoreLineageManifestV1([syntheticManifestSegment(inputMessages)]);
  const responseMessages = [
    { role: "assistant", content: `response:${requestId}` },
  ] satisfies ModelMessage[];
  const providerState = {
    lastFamily: "claude-code",
    containsCrossFamilyTurns: false,
  } as const;
  store.reserveCorePrimaryClaudeSessionAttempt({
    providerId: "claude-code",
    requestClient: "discord",
    lilacSessionId: sessionId,
    executionScopeHashVersion: 1,
    executionScopeHash: "scope",
    requestId,
    attemptIndex: 0,
    candidateSessionId: crypto.randomUUID(),
    sourceSessionId: null,
    expectedBindingRevision: null,
  });
  store.saveRequestTranscript({
    requestId,
    sessionId,
    requestClient: "discord",
    messages: responseMessages,
    corePrimaryLineage: manifest,
  });
  const transcript = store.getRequestTranscript({ requestId });
  if (!transcript?.transcriptDigest) throw new Error("seed terminal transcript missing");
  const head = computeCorePrimaryClaudeTerminalHead({
    manifest,
    requestId,
    transcriptDigest: transcript.transcriptDigest,
    responseMessageCount: responseMessages.length,
    providerState,
  });
  store.publishCorePrimaryClaudeSuccess({
    providerId: "claude-code",
    requestClient: "discord",
    lilacSessionId: sessionId,
    requestId,
    attemptIndex: 0,
    terminalRequestId: requestId,
    terminalLineageVersion: 1,
    terminalAtomCount: head.atomCount,
    terminalPrefixDigest: head.prefixDigest,
    terminalCanonicalMessageCount: head.canonicalMessageCount,
    providerState,
    nativeCwd: "/workspace",
    nativeLastModified: 10,
    nativeContextTokens: 100,
    nativeContextMaxTokens: 1_000,
    lastModelSpecifier: "claude-code/sonnet",
    lastReasoning: "medium",
  });
  expect(
    store.promoteCorePrimaryClaudeSessionBinding({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      requestId,
      attemptIndex: 0,
    }),
  ).toBe(true);
  const binding = store.getCorePrimaryClaudeSessionBinding({
    providerId: "claude-code",
    requestClient: "discord",
    lilacSessionId: sessionId,
  });
  if (!binding) throw new Error("seed primary binding missing");
  return { binding, canonicalMessages: [...inputMessages, ...responseMessages], manifest };
}

function downgradePrimaryBindingSchemaToV4(dbPath: string, corruptHead = false): void {
  const db = new Database(dbPath);
  db.run("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE core_primary_claude_bindings_v4 (
      request_client TEXT NOT NULL CHECK (request_client = 'discord'),
      session_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      binding_protocol_version INTEGER NOT NULL CHECK (binding_protocol_version = 1),
      provider_family TEXT NOT NULL CHECK (provider_family = 'claude-code'),
      lineage_version INTEGER NOT NULL CHECK (lineage_version = 1),
      atom_count INTEGER NOT NULL CHECK (atom_count > 0),
      prefix_digest TEXT NOT NULL,
      canonical_message_count INTEGER NOT NULL CHECK (canonical_message_count > 0),
      execution_scope_hash_version INTEGER NOT NULL CHECK (execution_scope_hash_version = 1),
      execution_scope_hash TEXT NOT NULL,
      claude_session_id TEXT NOT NULL,
      native_cwd TEXT NOT NULL,
      native_last_modified REAL NOT NULL CHECK (native_last_modified >= 0),
      native_context_tokens INTEGER NOT NULL CHECK (native_context_tokens >= 0),
      native_context_max_tokens INTEGER NOT NULL CHECK (native_context_max_tokens > 0),
      last_model_specifier TEXT NOT NULL,
      last_reasoning TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      updated_ts INTEGER NOT NULL,
      PRIMARY KEY (request_client, session_id, provider_id)
    );
    INSERT INTO core_primary_claude_bindings_v4 (
      request_client, session_id, provider_id, binding_protocol_version, provider_family,
      lineage_version, atom_count, prefix_digest, canonical_message_count,
      execution_scope_hash_version, execution_scope_hash, claude_session_id, native_cwd,
      native_last_modified, native_context_tokens, native_context_max_tokens,
      last_model_specifier, last_reasoning, revision, updated_ts
    ) SELECT
      request_client, session_id, provider_id, binding_protocol_version, provider_family,
      lineage_version, atom_count, prefix_digest, canonical_message_count,
      execution_scope_hash_version, execution_scope_hash, claude_session_id, native_cwd,
      native_last_modified, native_context_tokens, native_context_max_tokens,
      last_model_specifier, last_reasoning, revision, updated_ts
    FROM core_primary_claude_bindings;
    DROP TABLE core_primary_claude_bindings;
    ALTER TABLE core_primary_claude_bindings_v4 RENAME TO core_primary_claude_bindings;
    DELETE FROM core_primary_claude_attempts;
    DELETE FROM transcript_schema_migrations WHERE version = 5;
  `);
  if (corruptHead) {
    db.run("UPDATE core_primary_claude_bindings SET prefix_digest = ?", ["00".repeat(32)]);
  }
  db.close();
}

describe("SqliteTranscriptStore", () => {
  it("roundtrips transcripts without mutating tool outputs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");

    const store = new SqliteTranscriptStore(dbPath);

    const big = "x".repeat(60_000);

    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "echo hi" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: big },
          },
        ],
      },
      { role: "assistant", content: "a1" },
    ] satisfies ModelMessage[];

    store.saveRequestTranscript({
      requestId: "r1",
      sessionId: "chan",
      requestClient: "discord",
      messages,
      finalText: "done",
      modelLabel: "test-model",
    });

    store.linkSurfaceMessagesToRequest({
      requestId: "r1",
      created: [{ platform: "discord", channelId: "chan", messageId: "bot-1" }],
      last: { platform: "discord", channelId: "chan", messageId: "bot-1" },
    });

    const snap = store.getTranscriptBySurfaceMessage({
      platform: "discord",
      channelId: "chan",
      messageId: "bot-1",
    });

    expect(snap).not.toBeNull();
    expect(snap!.requestId).toBe("r1");
    expect(snap!.messages.length).toBe(messages.length);

    const toolMsg = snap!.messages.find((m) => m.role === "tool");
    expect(toolMsg).not.toBeUndefined();

    const parts = Array.isArray(toolMsg!.content) ? (toolMsg!.content as unknown[]) : [];
    const toolResult = parts.find((p) => {
      if (!p || typeof p !== "object") return false;
      return (p as Record<string, unknown>)["type"] === "tool-result";
    }) as Record<string, unknown> | undefined;

    const output = toolResult?.["output"] as Record<string, unknown> | undefined;
    expect(output?.["type"]).toBe("text");
    expect(output?.["value"]).toBe(big);

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("roundtrips large base64 tool attachments without scrubbing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");

    const store = new SqliteTranscriptStore(dbPath);

    const hugeBase64 = "A".repeat(400_000);

    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read_file",
            input: { path: "doc.pdf" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read_file",
            output: {
              type: "content",
              value: [
                { type: "text", text: "Attached file from read_file" },
                {
                  type: "file",
                  mediaType: "application/pdf",
                  filename: "doc.pdf",
                  data: { type: "data", data: hugeBase64 },
                },
              ],
            },
          },
        ],
      },
      { role: "assistant", content: "a1" },
    ] satisfies ModelMessage[];

    store.saveRequestTranscript({
      requestId: "r1",
      sessionId: "chan",
      requestClient: "discord",
      messages,
      finalText: "done",
      modelLabel: "test-model",
    });

    store.linkSurfaceMessagesToRequest({
      requestId: "r1",
      created: [{ platform: "discord", channelId: "chan", messageId: "bot-1" }],
      last: { platform: "discord", channelId: "chan", messageId: "bot-1" },
    });

    const snap = store.getTranscriptBySurfaceMessage({
      platform: "discord",
      channelId: "chan",
      messageId: "bot-1",
    });

    expect(snap).not.toBeNull();

    const toolMsg = snap!.messages.find((m) => m.role === "tool");
    expect(toolMsg).not.toBeUndefined();

    const parts = Array.isArray(toolMsg!.content) ? (toolMsg!.content as unknown[]) : [];
    const toolResult = parts.find((p) => {
      if (!p || typeof p !== "object") return false;
      return (p as Record<string, unknown>)["type"] === "tool-result";
    }) as Record<string, unknown> | undefined;

    const output = toolResult?.["output"] as Record<string, unknown> | undefined;
    expect(output?.["type"]).toBe("content");

    const value = Array.isArray(output?.["value"]) ? (output?.["value"] as unknown[]) : [];

    // The binary data should be preserved in the persisted transcript.
    const filePart = value.find(
      (v) => !!v && typeof v === "object" && (v as Record<string, unknown>)["type"] === "file",
    ) as Record<string, unknown> | undefined;

    expect(filePart).toBeDefined();
    expect(filePart?.["filename"]).toBe("doc.pdf");
    expect(filePart?.["data"]).toEqual({ type: "data", data: hugeBase64 });

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("keeps the first surface-to-request writer and treats same-request relinks as idempotent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const store = new SqliteTranscriptStore(path.join(dir, "transcripts.db"));
    for (const requestId of ["first", "second"]) {
      store.saveRequestTranscript({
        requestId,
        sessionId: "chan",
        requestClient: "discord",
        messages: [{ role: "assistant", content: requestId }],
      });
    }
    const ref = { platform: "discord", channelId: "chan", messageId: "output" } as const;
    store.linkSurfaceMessagesToRequest({ requestId: "first", created: [ref], last: ref });
    store.linkSurfaceMessagesToRequest({ requestId: "first", created: [ref], last: ref });
    store.linkSurfaceMessagesToRequest({ requestId: "second", created: [ref], last: ref });

    expect(store.getTranscriptBySurfaceMessage(ref)?.requestId).toBe("first");
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns latest transcript by session", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");

    const store = new SqliteTranscriptStore(dbPath);

    store.saveRequestTranscript({
      requestId: "r1",
      sessionId: "sub:s:1:r1",
      requestClient: "unknown",
      messages: [{ role: "assistant", content: "first" }],
      finalText: "first",
      modelLabel: "test-model",
    });

    // test-wait-justification: gives the second transcript a later wall-clock timestamp for latest ordering
    await new Promise((resolve) => setTimeout(resolve, 2));

    store.saveRequestTranscript({
      requestId: "r2",
      sessionId: "sub:s:1:r1",
      requestClient: "unknown",
      messages: [{ role: "assistant", content: "second" }],
      finalText: "second",
      modelLabel: "test-model",
    });

    const latest = store.getLatestTranscriptBySession({ sessionId: "sub:s:1:r1" });
    expect(latest).not.toBeNull();
    expect(latest?.requestId).toBe("r2");
    expect(latest?.finalText).toBe("second");

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("heals stringified assistant tool-call inputs when loading old transcripts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");

    const store = new SqliteTranscriptStore(dbPath);

    const rawDb = new Database(dbPath);
    rawDb.run(
      `
      INSERT INTO request_transcripts (
        request_id, session_id, request_client, created_ts, updated_ts, model_label, final_text, messages_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        "r1",
        "chan",
        "discord",
        Date.now(),
        Date.now(),
        "test-model",
        null,
        SuperJSON.stringify([
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "edit_file",
                input: '{"path":"note.txt","edits":[{"op":"replace","lines":["after install."]}}',
              },
            ],
          },
        ] satisfies ModelMessage[]),
      ],
    );
    rawDb.close();

    const latest = store.getLatestTranscriptBySession({ sessionId: "chan" });
    expect(latest).not.toBeNull();

    const assistant = latest?.messages[1];
    expect(assistant?.role).toBe("assistant");
    if (!assistant || assistant.role !== "assistant" || !Array.isArray(assistant.content)) {
      throw new Error("expected assistant message");
    }

    const part = assistant.content[0];
    expect(part?.type).toBe("tool-call");
    if (!part || part.type !== "tool-call") {
      throw new Error("expected tool-call part");
    }

    expect(part.input).toEqual({
      path: "note.txt",
      edits: [
        {
          op: "replace",
          lines: ["after install."],
        },
      ],
    });

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("drops duplicate tool results when loading old transcripts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");

    const store = new SqliteTranscriptStore(dbPath);

    const rawDb = new Database(dbPath);
    rawDb.run(
      `
      INSERT INTO request_transcripts (
        request_id, session_id, request_client, created_ts, updated_ts, model_label, final_text, messages_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        "r1",
        "chan",
        "discord",
        Date.now(),
        Date.now(),
        "test-model",
        null,
        SuperJSON.stringify([
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "edit_file",
                input: { path: "note.txt" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "edit_file",
                output: { type: "error-text", value: "first" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "edit_file",
                output: { type: "error-text", value: "second" },
              },
            ],
          },
        ] satisfies ModelMessage[]),
      ],
    );
    rawDb.close();

    const latest = store.getLatestTranscriptBySession({ sessionId: "chan" });
    expect(latest).not.toBeNull();
    expect(latest?.messages).toHaveLength(2);

    const tool = latest?.messages[1];
    expect(tool?.role).toBe("tool");
    if (!tool || tool.role !== "tool") {
      throw new Error("expected tool message");
    }

    const part = tool.content[0];
    expect(part?.type).toBe("tool-result");
    if (!part || part.type !== "tool-result") {
      throw new Error("expected tool-result part");
    }

    expect(part.output).toEqual({ type: "error-text", value: "first" });

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("lists linked surface messages by request in creation order", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");

    const store = new SqliteTranscriptStore(dbPath);

    store.saveRequestTranscript({
      requestId: "r1",
      sessionId: "chan",
      requestClient: "unknown",
      messages: [{ role: "assistant", content: "first" }],
      finalText: "first",
      modelLabel: "test-model",
    });

    store.linkSurfaceMessagesToRequest({
      requestId: "r1",
      created: [
        { platform: "discord", channelId: "chan", messageId: "m1" },
        { platform: "discord", channelId: "chan", messageId: "m2" },
      ],
      last: { platform: "discord", channelId: "chan", messageId: "m2" },
    });

    expect(store.listSurfaceMessagesForRequest?.({ requestId: "r1" })).toEqual([
      { platform: "discord", channelId: "chan", messageId: "m1" },
      { platform: "discord", channelId: "chan", messageId: "m2" },
    ]);

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("roundtrips compaction metadata and degrades invalid metadata to ordinary", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);

    store.saveRequestTranscript({
      requestId: "checkpoint",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "checkpoint" }],
      contextMeta: { type: "compaction", formatVersion: 1 },
    });
    store.linkSurfaceMessagesToRequest({
      requestId: "checkpoint",
      created: [{ platform: "discord", channelId: "chan", messageId: "m1" }],
      last: { platform: "discord", channelId: "chan", messageId: "m1" },
    });
    expect(
      store.getTranscriptBySurfaceMessage({
        platform: "discord",
        channelId: "chan",
        messageId: "m1",
      })?.contextMeta,
    ).toEqual({ type: "compaction", formatVersion: 1 });

    const db = new Database(dbPath);
    db.run("UPDATE request_transcripts SET context_meta_json = ? WHERE request_id = ?", [
      '{"type":"compaction","formatVersion":999}',
      "checkpoint",
    ]);
    db.close();
    expect(
      store.getTranscriptBySurfaceMessage({
        platform: "discord",
        channelId: "chan",
        messageId: "m1",
      })?.contextMeta,
    ).toBeUndefined();

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("migrates existing transcript databases with ordinary metadata defaults", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");
    const db = new Database(dbPath);
    db.run(`
      CREATE TABLE request_transcripts (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request_client TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL,
        model_label TEXT,
        final_text TEXT,
        messages_json TEXT NOT NULL
      )
    `);
    db.run(`INSERT INTO request_transcripts VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      "old",
      "chan",
      "discord",
      1,
      1,
      null,
      "old",
      SuperJSON.stringify([{ role: "assistant", content: "old" }]),
    ]);
    db.close();

    const store = new SqliteTranscriptStore(dbPath);
    const old = store.getLatestTranscriptBySession({ sessionId: "chan" });
    expect(old?.requestId).toBe("old");
    expect(old?.contextMeta).toBeUndefined();

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("preserves split-output checkpoints until the final mapping is unlinked", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    store.saveRequestTranscript({
      requestId: "checkpoint",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "checkpoint" }],
      contextMeta: { type: "compaction", formatVersion: 1 },
    });
    store.linkSurfaceMessagesToRequest({
      requestId: "checkpoint",
      created: [
        { platform: "discord", channelId: "chan", messageId: "m1" },
        { platform: "discord", channelId: "chan", messageId: "m2" },
      ],
      last: { platform: "discord", channelId: "chan", messageId: "m2" },
    });

    expect(
      store.unlinkSurfaceMessage({ platform: "discord", channelId: "chan", messageId: "m1" }),
    ).toEqual({ requestId: "checkpoint", checkpointDeleted: false });
    expect(
      store.getTranscriptBySurfaceMessage({
        platform: "discord",
        channelId: "chan",
        messageId: "m2",
      })?.requestId,
    ).toBe("checkpoint");
    expect(
      store.unlinkSurfaceMessage({ platform: "discord", channelId: "chan", messageId: "m2" }),
    ).toEqual({ requestId: "checkpoint", checkpointDeleted: true });
    expect(
      store.unlinkSurfaceMessage({ platform: "discord", channelId: "chan", messageId: "m2" }),
    ).toEqual({ checkpointDeleted: false });
    expect(store.getLatestTranscriptBySession({ sessionId: "chan" })).toBeNull();

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not delete ordinary transcripts when their final mapping is unlinked", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const store = new SqliteTranscriptStore(path.join(dir, "transcripts.db"));
    store.saveRequestTranscript({
      requestId: "ordinary",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "ordinary" }],
    });
    store.linkSurfaceMessagesToRequest({
      requestId: "ordinary",
      created: [{ platform: "discord", channelId: "chan", messageId: "m1" }],
      last: { platform: "discord", channelId: "chan", messageId: "m1" },
    });

    expect(
      store.unlinkSurfaceMessage({ platform: "discord", channelId: "chan", messageId: "m1" }),
    ).toEqual({ requestId: "ordinary", checkpointDeleted: false });
    expect(store.getLatestTranscriptBySession({ sessionId: "chan" })?.requestId).toBe("ordinary");

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("cleans only unlinked checkpoint candidates", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const store = new SqliteTranscriptStore(path.join(dir, "transcripts.db"));
    for (const requestId of ["unlinked", "linked"]) {
      store.saveRequestTranscript({
        requestId,
        sessionId: "chan",
        requestClient: "discord",
        messages: [{ role: "assistant", content: requestId }],
        contextMeta: { type: "compaction", formatVersion: 1 },
      });
    }
    store.linkSurfaceMessagesToRequest({
      requestId: "linked",
      created: [{ platform: "discord", channelId: "chan", messageId: "m1" }],
      last: { platform: "discord", channelId: "chan", messageId: "m1" },
    });

    expect(store.deleteUnlinkedCheckpointCandidate({ requestId: "unlinked" })).toBe(true);
    expect(store.deleteUnlinkedCheckpointCandidate({ requestId: "linked" })).toBe(false);
    expect(store.getLatestTranscriptBySession({ sessionId: "chan" })?.requestId).toBe("linked");

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("persists unbounded tool selections within their Lilac session namespace", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");
    const catalogIds = Array.from(
      { length: 5_000 },
      (_, index) => `plugin_catalog_tool_${index.toString().padStart(4, "0")}`,
    );

    const first = new SqliteTranscriptStore(dbPath);
    first.selectSessionToolIds({
      requestClient: "discord",
      sessionId: "shared-session-id",
      catalogIds,
    });
    first.selectSessionToolIds({
      requestClient: "discord",
      sessionId: "shared-session-id",
      catalogIds: [catalogIds[0]!],
    });
    first.selectSessionToolIds({
      requestClient: "github",
      sessionId: "shared-session-id",
      catalogIds: ["mcp_github_only_tool"],
    });
    first.selectSessionToolIds({
      requestClient: "discord",
      sessionId: "other-session",
      catalogIds: ["mcp_other_session_tool"],
    });
    first.close();

    const second = new SqliteTranscriptStore(dbPath);
    expect(
      second.listSessionToolIds({
        requestClient: "discord",
        sessionId: "shared-session-id",
      }),
    ).toEqual(catalogIds);
    expect(
      second.listSessionToolIds({
        requestClient: "github",
        sessionId: "shared-session-id",
      }),
    ).toEqual(["mcp_github_only_tool"]);
    expect(
      second.listSessionToolIds({ requestClient: "discord", sessionId: "other-session" }),
    ).toEqual(["mcp_other_session_tool"]);
    second.close();

    const db = new Database(dbPath);
    const row = db
      .query(
        `SELECT selected_ts FROM session_loaded_tools
         WHERE request_client = ? AND session_id = ? AND catalog_id = ?`,
      )
      .get("discord", "shared-session-id", catalogIds[0]!) as {
      selected_ts: number;
    } | null;
    expect(row?.selected_ts).toBeGreaterThan(0);
    db.close();

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("prunes tool selections after their session transcripts expire", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);

    store.selectSessionToolIds({
      requestClient: "discord",
      sessionId: "abandoned-session",
      catalogIds: ["mcp_abandoned_tool"],
    });
    store.selectSessionToolIds({
      requestClient: "discord",
      sessionId: "active-session",
      catalogIds: ["mcp_active_tool"],
    });
    store.selectSessionToolIds({
      requestClient: "discord",
      sessionId: "in-flight-session",
      catalogIds: ["mcp_in_flight_tool"],
    });
    const rawDb = new Database(dbPath);
    rawDb.run("UPDATE session_loaded_tools SET selected_ts = 0 WHERE session_id = ?", [
      "abandoned-session",
    ]);
    rawDb.close();
    store.saveRequestTranscript({
      requestId: "active-request",
      sessionId: "active-session",
      requestClient: "discord",
      messages: [{ role: "user", content: "keep this session" }],
    });

    expect(
      store.listSessionToolIds({ requestClient: "discord", sessionId: "abandoned-session" }),
    ).toEqual([]);
    expect(
      store.listSessionToolIds({ requestClient: "discord", sessionId: "active-session" }),
    ).toEqual(["mcp_active_tool"]);
    expect(
      store.listSessionToolIds({ requestClient: "discord", sessionId: "in-flight-session" }),
    ).toEqual(["mcp_in_flight_tool"]);

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates the generic selection table without migrating attempt-1 state", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");
    const db = new Database(dbPath);
    db.run(`
      CREATE TABLE session_loaded_mcp_tools (
        request_client TEXT NOT NULL,
        session_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        loaded_ts INTEGER NOT NULL
      )
    `);
    db.run("INSERT INTO session_loaded_mcp_tools VALUES (?, ?, ?, ?, ?)", [
      "discord",
      "session",
      "legacy-server",
      "legacy-tool",
      1,
    ]);
    db.close();

    const store = new SqliteTranscriptStore(dbPath);
    expect(store.listSessionToolIds({ requestClient: "discord", sessionId: "session" })).toEqual(
      [],
    );
    store.close();

    const rawDb = new Database(dbPath);
    const columns = rawDb.query("PRAGMA table_info(session_loaded_tools)").all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toEqual([
      "request_client",
      "session_id",
      "catalog_id",
      "selected_ts",
    ]);
    expect(rawDb.query("SELECT COUNT(*) AS count FROM session_loaded_mcp_tools").get()).toEqual({
      count: 1,
    });
    rawDb.close();

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("transactionally migrates the shipped layout with provider metadata and FK validation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage5-"));
    const dbPath = path.join(dir, "transcripts.db");
    const legacy = new Database(dbPath);
    legacy.run(`
      CREATE TABLE request_transcripts (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request_client TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL,
        model_label TEXT,
        final_text TEXT,
        messages_json TEXT NOT NULL
      )
    `);
    legacy.run("INSERT INTO request_transcripts VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      "legacy",
      "sub:legacy:named:audit",
      "unknown",
      1,
      1,
      "old-model",
      "old",
      SuperJSON.stringify([{ role: "assistant", content: "old" }]),
    ]);
    legacy.close();

    const store = new SqliteTranscriptStore(dbPath);
    expect(store.getRequestTranscript({ requestId: "legacy" })?.providerState).toBeNull();
    store.close();

    const migrated = new Database(dbPath);
    const version = migrated
      .query("SELECT MAX(version) AS version FROM transcript_schema_migrations")
      .get();
    expect(version).toEqual({ version: 5 });
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const columns = migrated.query("PRAGMA table_info(request_transcripts)").all() as Array<{
      name: string;
    }>;
    expect(columns.map(({ name }) => name)).toContain("provider_state_json");
    expect(columns.map(({ name }) => name)).toContain("stable_named_request_client");
    expect(
      migrated
        .query(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name LIKE 'core_primary_claude_%' ORDER BY name`,
        )
        .all(),
    ).toEqual([{ name: "core_primary_claude_attempts" }, { name: "core_primary_claude_bindings" }]);
    migrated.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("migrates a valid v4 primary binding from its durable head after its attempt was pruned", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-v4-primary-"));
    const dbPath = path.join(dir, "transcripts.db");
    const initial = new SqliteTranscriptStore(dbPath);
    const seeded = seedPrimaryBinding(initial, "v4-terminal", "v4-session");
    initial.close();
    downgradePrimaryBindingSchemaToV4(dbPath);

    const migrated = new SqliteTranscriptStore(dbPath);
    const binding = migrated.getCorePrimaryClaudeSessionBinding({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: "v4-session",
    });
    expect(binding).toMatchObject({
      terminalRequestId: "v4-terminal",
      atomCount: seeded.binding.atomCount,
      prefixDigest: seeded.binding.prefixDigest,
      canonicalMessageCount: seeded.binding.canonicalMessageCount,
      claudeSessionId: seeded.binding.claudeSessionId,
      revision: seeded.binding.revision,
    });
    expect(
      selectCorePrimaryClaudePrefix({
        lineage: {
          state: "complete",
          lineageVersion: 1,
          currentCanonicalStart: seeded.canonicalMessages.length,
          segments: [
            {
              atoms: seeded.manifest.segments[0]!.atoms,
              canonicalMessages: seeded.canonicalMessages,
              canonicalStart: 0,
              canonicalEnd: seeded.canonicalMessages.length,
              cumulativeAtomCount: seeded.binding.atomCount,
              cumulativePrefixDigest: seeded.binding.prefixDigest,
            },
          ],
        },
        canonicalMessages: seeded.canonicalMessages,
        binding,
        executionScopeHash: "scope",
        executionCwd: "/workspace",
      }),
    ).toEqual({ mode: "fork", canonicalEnd: seeded.canonicalMessages.length });
    expect(
      migrated.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: "v4-session",
        requestId: "v4-terminal",
        attemptIndex: 0,
      }),
    ).toBeNull();
    migrated.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("retires a v4 primary binding with no matching durable terminal head", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-v4-stale-"));
    const dbPath = path.join(dir, "transcripts.db");
    const initial = new SqliteTranscriptStore(dbPath);
    seedPrimaryBinding(initial, "v4-stale-terminal", "v4-stale-session");
    initial.close();
    downgradePrimaryBindingSchemaToV4(dbPath, true);

    const migrated = new SqliteTranscriptStore(dbPath);
    expect(
      migrated.getCorePrimaryClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: "v4-stale-session",
      }),
    ).toBeNull();
    const raw = new Database(dbPath);
    expect(raw.query("SELECT COUNT(*) AS count FROM core_primary_claude_bindings").get()).toEqual({
      count: 0,
    });
    raw.close();
    migrated.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("promotes a canonically verified named candidate and rejects a stale revision race", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage5-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const sessionId = "sub:parent:named:audit";
    const sourceMessages = [{ role: "user", content: "first" }] satisfies ModelMessage[];
    store.saveRequestTranscript({
      requestId: "source",
      sessionId,
      requestClient: "unknown",
      messages: sourceMessages,
      providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
      stableNamedRequestClient: "discord",
    });
    const firstCandidate = crypto.randomUUID();
    store.reserveCoreNamedClaudeSessionAttempt({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      executionScopeHashVersion: 1,
      executionScopeHash: "scope-a",
      requestId: "candidate-1",
      attemptIndex: 0,
      candidateSessionId: firstCandidate,
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    const firstTerminal = [
      ...sourceMessages,
      { role: "assistant", content: "first answer" },
    ] satisfies ModelMessage[];
    const firstHash = hashCanonicalMessagesV1(firstTerminal).hash;
    store.saveRequestTranscript({
      requestId: "candidate-1",
      sessionId,
      requestClient: "unknown",
      messages: firstTerminal,
    });
    store.publishCoreNamedClaudeSuccess({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      requestId: "candidate-1",
      attemptIndex: 0,
      terminalRequestId: "candidate-1",
      terminalCanonicalHeadHash: firstHash,
      terminalCanonicalMessageCount: firstTerminal.length,
      providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
      nativeCwd: "/workspace",
      nativeLastModified: 10,
      nativeContextTokens: 100,
      nativeContextMaxTokens: 1_000,
      lastModelSpecifier: "claude-code/sonnet",
      lastReasoning: "low",
    });
    expect(
      store.promoteCoreNamedClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "candidate-1",
        attemptIndex: 0,
      }),
    ).toBe(true);
    const base = store.getCoreNamedClaudeSessionBinding({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
    });
    expect(base?.claudeSessionId).toBe(firstCandidate);
    expect(base?.revision).toBe(1);

    const reserveCompeting = (requestId: string, candidateSessionId: string) =>
      store.reserveCoreNamedClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        executionScopeHashVersion: 1,
        executionScopeHash: "scope-a",
        requestId,
        attemptIndex: 0,
        candidateSessionId,
        sourceSessionId: firstCandidate,
        expectedBindingRevision: 1,
      });
    reserveCompeting("candidate-2", crypto.randomUUID());
    reserveCompeting("candidate-stale", crypto.randomUUID());
    for (const requestId of ["candidate-2", "candidate-stale"]) {
      const terminal = [
        ...firstTerminal,
        { role: "user", content: requestId },
        { role: "assistant", content: `answer:${requestId}` },
      ] satisfies ModelMessage[];
      const hash = hashCanonicalMessagesV1(terminal).hash;
      store.saveRequestTranscript({
        requestId,
        sessionId,
        requestClient: "unknown",
        messages: terminal,
      });
      store.publishCoreNamedClaudeSuccess({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId,
        attemptIndex: 0,
        terminalRequestId: requestId,
        terminalCanonicalHeadHash: hash,
        terminalCanonicalMessageCount: terminal.length,
        providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
        nativeCwd: "/workspace",
        nativeLastModified: 20,
        nativeContextTokens: 200,
        nativeContextMaxTokens: 1_000,
        lastModelSpecifier: "claude-code/opus",
        lastReasoning: "high",
      });
    }
    expect(
      store.promoteCoreNamedClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "candidate-2",
        attemptIndex: 0,
      }),
    ).toBe(true);
    expect(
      store.promoteCoreNamedClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "candidate-stale",
        attemptIndex: 0,
      }),
    ).toBe(false);
    expect(
      store.getCoreNamedClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "candidate-stale",
        attemptIndex: 0,
      })?.state,
    ).toBe("failed");

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("recovers succeeded promotions, marks crash-left attempts uncertain, and cascades deleted heads", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage5-"));
    const dbPath = path.join(dir, "transcripts.db");
    const sessionId = "sub:parent:named:restart";
    const first = new SqliteTranscriptStore(dbPath);
    const terminal = [
      { role: "user", content: "restart" },
      { role: "assistant", content: "ready" },
    ] satisfies ModelMessage[];
    first.saveRequestTranscript({
      requestId: "succeeded-pending",
      sessionId,
      requestClient: "unknown",
      messages: terminal,
    });
    first.reserveCoreNamedClaudeSessionAttempt({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId: "succeeded-pending",
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    first.publishCoreNamedClaudeSuccess({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      requestId: "succeeded-pending",
      attemptIndex: 0,
      terminalRequestId: "succeeded-pending",
      terminalCanonicalHeadHash: hashCanonicalMessagesV1(terminal).hash,
      terminalCanonicalMessageCount: terminal.length,
      providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
      nativeCwd: "/workspace",
      nativeLastModified: 10,
      nativeContextTokens: 100,
      nativeContextMaxTokens: 1_000,
      lastModelSpecifier: "claude-code/sonnet",
      lastReasoning: "medium",
    });
    first.reserveCoreNamedClaudeSessionAttempt({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: "sub:parent:named:crashed",
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId: "crash-left",
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    first.saveRequestTranscript({
      requestId: "crash-left",
      sessionId: "sub:parent:named:crashed",
      requestClient: "unknown",
      messages: terminal,
    });
    first.close();

    const recovered = new SqliteTranscriptStore(dbPath);
    expect(
      recovered.getCoreNamedClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      })?.terminalRequestId,
    ).toBe("succeeded-pending");
    expect(
      recovered.getCoreNamedClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: "sub:parent:named:crashed",
        requestId: "crash-left",
        attemptIndex: 0,
      })?.state,
    ).toBe("uncertain");
    expect(
      recovered.getLatestCompleteNamedTranscript({
        requestClient: "discord",
        sessionId: "sub:parent:named:crashed",
      }),
    ).toBeNull();
    const crashTranscript = recovered.getRequestTranscript({ requestId: "crash-left" });
    expect(crashTranscript?.providerState).toBeNull();
    expect(crashTranscript?.stableNamedRequestClient).toBeUndefined();

    const raw = new Database(dbPath);
    raw.run("PRAGMA foreign_keys = ON");
    raw.run("DELETE FROM request_transcripts WHERE request_id = ?", ["succeeded-pending"]);
    raw.close();
    expect(
      recovered.getCoreNamedClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      }),
    ).toBeNull();

    recovered.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("bounds terminal attempt metadata per exact named owner", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage5-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    store.reserveCoreNamedClaudeSessionAttempt({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: "sub:parent:named:bounded",
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId: "bounded-active",
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    for (let attemptIndex = 0; attemptIndex < 40; attemptIndex += 1) {
      store.reserveCoreNamedClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: "sub:parent:named:bounded",
        executionScopeHashVersion: 1,
        executionScopeHash: "scope",
        requestId: "bounded-request",
        attemptIndex,
        candidateSessionId: crypto.randomUUID(),
        sourceSessionId: null,
        expectedBindingRevision: null,
      });
      store.recordCoreNamedClaudeSessionAttemptOutcome({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: "sub:parent:named:bounded",
        requestId: "bounded-request",
        attemptIndex,
        state: "failed",
      });
    }
    store.close();

    const raw = new Database(dbPath);
    expect(
      raw
        .query(
          `SELECT COUNT(*) AS count FROM core_named_claude_attempts
           WHERE request_client = 'discord' AND session_id = 'sub:parent:named:bounded'`,
        )
        .get(),
    ).toEqual({ count: 33 });
    expect(
      raw
        .query(
          `SELECT state FROM core_named_claude_attempts
           WHERE request_client = 'discord' AND session_id = 'sub:parent:named:bounded'
             AND request_id = 'bounded-active'`,
        )
        .get(),
    ).toEqual({ state: "active" });
    raw.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("cannot promote when the canonical terminal transcript was not durably saved", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage5-"));
    const store = new SqliteTranscriptStore(path.join(dir, "transcripts.db"));
    const sessionId = "sub:parent:named:save-failure";
    store.reserveCoreNamedClaudeSessionAttempt({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId: "missing-terminal",
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    expect(() =>
      store.publishCoreNamedClaudeSuccess({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "missing-terminal",
        attemptIndex: 0,
        terminalRequestId: "missing-terminal",
        terminalCanonicalHeadHash: "not-saved",
        terminalCanonicalMessageCount: 2,
        providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
        nativeCwd: "/workspace",
        nativeLastModified: 10,
        nativeContextTokens: 100,
        nativeContextMaxTokens: 1_000,
        lastModelSpecifier: "claude-code/sonnet",
        lastReasoning: "medium",
      }),
    ).toThrow("failed publication verification");
    store.recordCoreNamedClaudeSessionAttemptOutcome({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      requestId: "missing-terminal",
      attemptIndex: 0,
      state: "failed",
    });
    expect(
      store.getCoreNamedClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      }),
    ).toBeNull();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("atomically rolls back transcript publication when success recording fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage5-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const sessionId = "sub:parent:named:atomic-publication";
    const requestId = "atomic-publication";
    const terminal = [
      { role: "user", content: "publish" },
      { role: "assistant", content: "candidate" },
    ] satisfies ModelMessage[];
    store.reserveCoreNamedClaudeSessionAttempt({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId,
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    store.saveRequestTranscript({
      requestId,
      sessionId,
      requestClient: "unknown",
      messages: terminal,
    });
    const raw = new Database(dbPath);
    raw.run(`CREATE TRIGGER reject_core_named_success
      BEFORE UPDATE OF state ON core_named_claude_attempts
      WHEN NEW.state = 'succeeded'
      BEGIN SELECT RAISE(ABORT, 'simulated success recording failure'); END`);
    raw.close();

    expect(() =>
      store.publishCoreNamedClaudeSuccess({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId,
        attemptIndex: 0,
        terminalRequestId: requestId,
        terminalCanonicalHeadHash: hashCanonicalMessagesV1(terminal).hash,
        terminalCanonicalMessageCount: terminal.length,
        providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
        nativeCwd: "/workspace",
        nativeLastModified: 10,
        nativeContextTokens: 100,
        nativeContextMaxTokens: 1_000,
        lastModelSpecifier: "claude-code/sonnet",
        lastReasoning: "medium",
      }),
    ).toThrow("simulated success recording failure");
    const unpublished = store.getRequestTranscript({ requestId });
    expect(unpublished?.providerState).toBeNull();
    expect(unpublished?.stableNamedRequestClient).toBeUndefined();
    expect(
      store.getCoreNamedClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId,
        attemptIndex: 0,
      })?.state,
    ).toBe("active");
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rejects unmarked and cross-client named history", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage5-"));
    const store = new SqliteTranscriptStore(path.join(dir, "transcripts.db"));
    const sessionId = "sub:parent:named:exact-client";
    store.saveRequestTranscript({
      requestId: "unmarked",
      sessionId,
      requestClient: "unknown",
      messages: [{ role: "assistant", content: "generic" }],
    });
    store.saveRequestTranscript({
      requestId: "discord-marked",
      sessionId,
      requestClient: "unknown",
      messages: [{ role: "assistant", content: "discord" }],
      stableNamedRequestClient: "discord",
      providerState: { lastFamily: "ai-sdk", containsCrossFamilyTurns: false },
    });
    store.saveRequestTranscript({
      requestId: "github-marked",
      sessionId,
      requestClient: "unknown",
      messages: [{ role: "assistant", content: "github" }],
      stableNamedRequestClient: "github",
      providerState: { lastFamily: "ai-sdk", containsCrossFamilyTurns: false },
    });
    store.saveRequestTranscript({
      requestId: "unmarked-only",
      sessionId: "sub:parent:named:unmarked-only",
      requestClient: "unknown",
      messages: [{ role: "assistant", content: "generic only" }],
    });

    expect(
      store.getLatestCompleteNamedTranscript({ requestClient: "discord", sessionId })?.requestId,
    ).toBe("discord-marked");
    expect(
      store.getLatestCompleteNamedTranscript({ requestClient: "github", sessionId })?.requestId,
    ).toBe("github-marked");
    expect(store.getLatestCompleteNamedTranscript({ requestClient: "web", sessionId })).toBeNull();
    expect(
      store.getLatestCompleteNamedTranscript({
        requestClient: "discord",
        sessionId: "sub:parent:named:unmarked-only",
      }),
    ).toBeNull();

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("transactionally migrates a schema-v1 database to the Stage 6 layout", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage6-"));
    const dbPath = path.join(dir, "transcripts.db");
    const db = new Database(dbPath);
    db.run(`CREATE TABLE transcript_schema_migrations (
      version INTEGER PRIMARY KEY, applied_ts INTEGER NOT NULL
    )`);
    db.run("INSERT INTO transcript_schema_migrations VALUES (1, 1)");
    db.run(`CREATE TABLE request_transcripts (
      request_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      request_client TEXT NOT NULL,
      created_ts INTEGER NOT NULL,
      updated_ts INTEGER NOT NULL,
      model_label TEXT,
      final_text TEXT,
      messages_json TEXT NOT NULL,
      context_meta_json TEXT,
      provider_state_json TEXT,
      stable_named_request_client TEXT
    )`);
    const messages = [{ role: "assistant", content: "legacy" }] satisfies ModelMessage[];
    db.run("INSERT INTO request_transcripts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      "legacy-v1",
      "session",
      "discord",
      1,
      1,
      null,
      "legacy",
      SuperJSON.stringify(messages),
      null,
      SuperJSON.stringify({ lastFamily: "ai-sdk", containsCrossFamilyTurns: false }),
      null,
    ]);
    db.close();

    const store = new SqliteTranscriptStore(dbPath);
    expect(store.getRequestTranscript({ requestId: "legacy-v1" })).toMatchObject({
      canonicalHashVersion: 1,
      transcriptDigest: hashCanonicalMessagesV1(messages).hash,
    });
    store.close();

    const migrated = new Database(dbPath);
    expect(
      migrated.query("SELECT version FROM transcript_schema_migrations ORDER BY version").all(),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }]);
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'core_%'")
        .all(),
    ).toContainEqual({ name: "core_primary_lineage_manifests" });
    migrated.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("keeps the first admitted surface projection and its owned blob immutable", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage6-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const blob = store.putCoreOwnedBlob({
      bytes: new TextEncoder().encode("owned attachment"),
      mediaType: "text/plain",
      filename: "attachment.txt",
    });
    const key = {
      requestClient: "discord",
      surfaceId: "guild:channel",
      sessionId: "channel",
      messageId: "message-1",
      projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
    } as const;
    const first = store.admitCoreSurfaceProjection({
      ...key,
      canonicalMessages: [{ role: "user", content: "first text" }],
      sourceFacts: {
        author: { id: "author-1", name: "First Author" },
        reactions: ["one"],
        attachmentUrl: "https://first.invalid/attachment",
      },
      ownedBlobs: [blob],
    });
    const readmitted = store.admitCoreSurfaceProjection({
      ...key,
      canonicalMessages: [{ role: "user", content: "edited text" }],
      sourceFacts: {
        author: { id: "author-2", name: "Edited Author" },
        reactions: ["changed"],
        attachmentUrl: "https://edited.invalid/attachment",
      },
      ownedBlobs: [],
    });

    expect(readmitted).toEqual(first);
    expect(readmitted.canonicalMessages).toEqual([{ role: "user", content: "first text" }]);
    expect(readmitted.ownedBlobs).toEqual([
      {
        sha256: blob.sha256,
        mediaType: "text/plain",
        filename: "attachment.txt",
        byteLength: blob.byteLength,
      },
    ]);
    store.close();

    const reopened = new SqliteTranscriptStore(dbPath);
    expect(reopened.getCoreSurfaceProjection(key)).toEqual(first);
    reopened.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reports immutable orphan projections and prunes only an explicitly selected unowned blob", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-retention-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const retainedBlob = store.putCoreOwnedBlob({
      bytes: new TextEncoder().encode("retained"),
      mediaType: "text/plain",
      filename: "retained.txt",
    });
    const orphanBlob = store.putCoreOwnedBlob({
      bytes: new TextEncoder().encode("orphan"),
      mediaType: "text/plain",
      filename: "orphan.txt",
    });
    const projectionKey = {
      requestClient: "discord",
      surfaceId: "discord:retention",
      sessionId: "retention",
      messageId: "first-seen",
      projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
    } as const;
    store.admitCoreSurfaceProjection({
      ...projectionKey,
      canonicalMessages: [{ role: "user", content: "first seen" }],
      sourceFacts: {},
      ownedBlobs: [retainedBlob],
    });
    expect(store.getCoreRetentionDiagnostics()).toMatchObject({
      unreferencedProjectionCount: 1,
      ownedBlobBytes: retainedBlob.byteLength + orphanBlob.byteLength,
      unreferencedOwnedBlobCount: 1,
      unreferencedOwnedBlobBytes: orphanBlob.byteLength,
      orphanManifestCount: 0,
    });
    store.close();

    const reopened = new SqliteTranscriptStore(dbPath);
    expect(reopened.getCoreSurfaceProjection(projectionKey)?.ownedBlobs).toEqual([
      {
        sha256: retainedBlob.sha256,
        mediaType: retainedBlob.mediaType,
        filename: retainedBlob.filename,
        byteLength: retainedBlob.byteLength,
      },
    ]);
    expect(reopened.getCoreOwnedBlob({ sha256: orphanBlob.sha256 }).sha256).toBe(orphanBlob.sha256);
    expect(reopened.deleteCoreOwnedBlobIfUnreferenced({ sha256: orphanBlob.sha256 })).toBe(true);
    expect(() => reopened.getCoreOwnedBlob({ sha256: orphanBlob.sha256 })).toThrow("is missing");
    expect(reopened.getCoreRetentionDiagnostics()).toMatchObject({
      unreferencedProjectionCount: 1,
      ownedBlobBytes: retainedBlob.byteLength,
      unreferencedOwnedBlobCount: 0,
      unreferencedOwnedBlobBytes: 0,
    });
    const indexed = new Database(dbPath);
    expect(
      indexed
        .query(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (
             'idx_core_lineage_projection_refs_projection',
             'idx_core_surface_projection_blobs_blob'
           ) ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "idx_core_lineage_projection_refs_projection" },
      { name: "idx_core_surface_projection_blobs_blob" },
    ]);
    indexed.close();
    reopened.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("fails explicitly for corrupt or missing owned projection blobs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage6-"));
    const dbPath = path.join(dir, "transcripts.db");
    const originalBytes = new TextEncoder().encode("blob bytes");
    const key = {
      requestClient: "discord",
      surfaceId: "surface",
      sessionId: "session",
      messageId: "message",
      projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
    } as const;
    const first = new SqliteTranscriptStore(dbPath);
    const blob = first.putCoreOwnedBlob({
      bytes: originalBytes,
      mediaType: "text/plain",
      filename: "blob.txt",
    });
    first.admitCoreSurfaceProjection({
      ...key,
      canonicalMessages: [{ role: "user", content: "with blob" }],
      sourceFacts: {},
      ownedBlobs: [blob],
    });
    first.close();

    const raw = new Database(dbPath);
    raw.run("UPDATE core_owned_blobs SET bytes = ? WHERE sha256 = ?", [
      new TextEncoder().encode("corrupt!!!"),
      blob.sha256,
    ]);
    raw.close();
    const corrupt = new SqliteTranscriptStore(dbPath);
    expect(() => corrupt.getCoreSurfaceProjection(key)).toThrow(CoreOwnedBlobIntegrityError);
    expect(() => corrupt.getCoreSurfaceProjection(key)).toThrow("failed SHA-256 validation");
    corrupt.close();

    const missing = new SqliteTranscriptStore(dbPath);
    const remove = new Database(dbPath);
    remove.run("UPDATE core_owned_blobs SET bytes = ? WHERE sha256 = ?", [
      originalBytes,
      blob.sha256,
    ]);
    remove.run("PRAGMA foreign_keys = OFF");
    remove.run("DELETE FROM core_owned_blobs WHERE sha256 = ?", [blob.sha256]);
    remove.close();
    expect(() => missing.getCoreSurfaceProjection(key)).toThrow(CoreOwnedBlobIntegrityError);
    expect(() => missing.getCoreSurfaceProjection(key)).toThrow("references a missing blob");
    missing.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("roundtrips aligned manifests and exposes exact request atom metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage6-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const sourceMessages = [
      { role: "assistant", content: "source output" },
    ] satisfies ModelMessage[];
    store.saveRequestTranscript({
      requestId: "source",
      sessionId: "session",
      requestClient: "discord",
      messages: sourceMessages,
      providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: true },
    });
    const metadata = store.getCoreRequestAtomMetadata({ requestId: "source" });
    expect(metadata).toEqual({
      requestId: "source",
      transcriptDigest: hashCanonicalMessagesV1(sourceMessages).hash,
      providerFamily: "claude-code",
      containsCrossFamilyTurns: true,
    });
    if (!metadata) throw new Error("expected request atom metadata");
    const atom = { kind: "request", ...metadata } as const;
    const requestAlias = {
      requestClient: "discord",
      surfaceId: "discord:session",
      sessionId: "session",
      messageId: "source-output",
    } as const;
    store.admitCoreSurfaceProjection({
      ...requestAlias,
      projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
      canonicalMessages: [{ role: "assistant", content: "surface output" }],
      sourceFacts: {},
      ownedBlobs: [],
    });
    const sourceOutputRef = {
      platform: "discord",
      channelId: "session",
      messageId: "source-output",
    } as const;
    store.linkSurfaceMessagesToRequest({
      requestId: "source",
      created: [sourceOutputRef],
      last: sourceOutputRef,
    });
    const manifest = manifestFor([atom], sourceMessages, [requestAlias]);
    store.saveRequestTranscript({
      requestId: "destination",
      sessionId: "session",
      requestClient: "discord",
      messages: sourceMessages,
      corePrimaryLineage: manifest,
    });
    expect(store.getCorePrimaryLineageManifest({ requestId: "destination" })).toEqual(manifest);
    const constrained = new Database(dbPath);
    constrained.run("PRAGMA foreign_keys = ON");
    expect(() =>
      constrained.run("DELETE FROM core_surface_projections WHERE message_id = 'source-output'"),
    ).toThrow();
    constrained.close();

    const replacementMessages = [
      { role: "assistant", content: "different projection" },
    ] satisfies ModelMessage[];
    expect(() =>
      store.saveCorePrimaryLineageManifest({
        requestId: "destination",
        manifest: manifestFor([atom], replacementMessages, [requestAlias]),
      }),
    ).toThrow("is immutable");

    store.saveRequestTranscript({
      requestId: "provider-mismatch",
      sessionId: "session",
      requestClient: "discord",
      messages: sourceMessages,
    });
    expect(() =>
      store.saveCorePrimaryLineageManifest({
        requestId: "provider-mismatch",
        manifest: manifestFor(
          [
            {
              ...atom,
              providerFamily: "ai-sdk",
              containsCrossFamilyTurns: false,
            },
          ],
          sourceMessages,
          [requestAlias],
        ),
      }),
    ).toThrow("stale-request-provider-lineage");

    expect(() =>
      store.saveRequestTranscript({
        requestId: "wrong-scope",
        sessionId: "other-session",
        requestClient: "discord",
        messages: sourceMessages,
        corePrimaryLineage: manifest,
      }),
    ).toThrow("stale-request-lineage");

    const ordinaryMessages = [
      { role: "assistant", content: "not a checkpoint" },
    ] satisfies ModelMessage[];
    store.saveRequestTranscript({
      requestId: "ordinary",
      sessionId: "session",
      requestClient: "discord",
      messages: ordinaryMessages,
    });
    expect(() =>
      store.saveRequestTranscript({
        requestId: "invalid-checkpoint-owner",
        sessionId: "session",
        requestClient: "discord",
        messages: ordinaryMessages,
        corePrimaryLineage: buildCoreLineageManifestV1([
          {
            atoms: [
              {
                kind: "checkpoint",
                requestId: "ordinary",
                transcriptDigest: hashCanonicalMessagesV1(ordinaryMessages).hash,
              },
            ],
            canonicalMessages: ordinaryMessages,
          },
        ]),
      }),
    ).toThrow("stale-checkpoint-lineage");

    store.saveRequestTranscript({
      requestId: "unlinked-checkpoint",
      sessionId: "session",
      requestClient: "discord",
      messages: ordinaryMessages,
      contextMeta: { type: "compaction", formatVersion: 1 },
    });
    const checkpointManifest = buildCoreLineageManifestV1([
      {
        atoms: [
          {
            kind: "checkpoint",
            requestId: "unlinked-checkpoint",
            transcriptDigest: hashCanonicalMessagesV1(ordinaryMessages).hash,
          },
        ],
        canonicalMessages: ordinaryMessages,
      },
    ]);
    expect(() =>
      store.saveRequestTranscript({
        requestId: "unlinked-checkpoint-owner",
        sessionId: "session",
        requestClient: "discord",
        messages: ordinaryMessages,
        corePrimaryLineage: checkpointManifest,
      }),
    ).toThrow("stale-checkpoint-lineage");
    store.linkSurfaceMessagesToRequest({
      requestId: "unlinked-checkpoint",
      created: [{ platform: "discord", channelId: "other-session", messageId: "wrong-output" }],
      last: { platform: "discord", channelId: "other-session", messageId: "wrong-output" },
    });
    expect(() =>
      store.saveRequestTranscript({
        requestId: "wrong-scope-checkpoint-owner",
        sessionId: "session",
        requestClient: "discord",
        messages: ordinaryMessages,
        corePrimaryLineage: checkpointManifest,
      }),
    ).toThrow("stale-checkpoint-lineage");

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("retains transcripts, projections, and blobs referenced by complete manifests", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage6-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const checkpointMessages = [
      { role: "assistant", content: "checkpoint" },
    ] satisfies ModelMessage[];
    store.saveRequestTranscript({
      requestId: "checkpoint",
      sessionId: "session",
      requestClient: "discord",
      messages: checkpointMessages,
      contextMeta: { type: "compaction", formatVersion: 1 },
    });
    const checkpointOutputRef = {
      platform: "discord",
      channelId: "session",
      messageId: "checkpoint-output",
    } as const;
    store.linkSurfaceMessagesToRequest({
      requestId: "checkpoint",
      created: [checkpointOutputRef],
      last: checkpointOutputRef,
    });
    const blob = store.putCoreOwnedBlob({
      bytes: new TextEncoder().encode("retained"),
      mediaType: "text/plain",
      filename: "retained.txt",
    });
    const projectionKey = {
      requestClient: "discord",
      surfaceId: "discord:session",
      sessionId: "session",
      messageId: "surface-message",
      projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
    } as const;
    store.admitCoreSurfaceProjection({
      ...projectionKey,
      canonicalMessages: [{ role: "user", content: "surface" }],
      sourceFacts: {
        segmentMessageIds: ["surface-message"],
        segmentDigest: hashCanonicalMessagesV1([{ role: "user", content: "surface" }]).hash,
      },
      ownedBlobs: [blob],
    });
    const destinationMessages = [
      ...checkpointMessages,
      { role: "user", content: "surface" },
    ] satisfies ModelMessage[];
    const manifest = buildCoreLineageManifestV1([
      {
        atoms: [
          {
            kind: "checkpoint",
            requestId: "checkpoint",
            transcriptDigest: hashCanonicalMessagesV1(checkpointMessages).hash,
          },
        ],
        canonicalMessages: checkpointMessages,
      },
      {
        atoms: [
          {
            kind: "surface",
            requestClient: "discord",
            surfaceId: "discord:session",
            sessionId: "session",
            messageId: "surface-message",
          },
        ],
        canonicalMessages: [{ role: "user", content: "surface" }],
      },
    ]);
    store.saveRequestTranscript({
      requestId: "destination",
      sessionId: "session",
      requestClient: "discord",
      messages: destinationMessages,
      corePrimaryLineage: manifest,
    });

    expect(store.unlinkSurfaceMessage(checkpointOutputRef)).toEqual({
      requestId: "checkpoint",
      checkpointDeleted: false,
    });
    expect(
      store.validateCorePrimaryLineageReferences({
        manifest,
        requestClient: "discord",
        sessionId: "session",
        surfaceId: "discord:session",
      }),
    ).toBe("stale-checkpoint-lineage");
    expect(store.deleteUnlinkedCheckpointCandidate({ requestId: "checkpoint" })).toBe(false);
    const constrained = new Database(dbPath);
    constrained.run("PRAGMA foreign_keys = ON");
    expect(() =>
      constrained.run("DELETE FROM request_transcripts WHERE request_id = 'checkpoint'"),
    ).toThrow();
    expect(() =>
      constrained.run("DELETE FROM core_surface_projections WHERE message_id = 'surface-message'"),
    ).toThrow();
    expect(() =>
      constrained.run("DELETE FROM core_owned_blobs WHERE sha256 = ?", [blob.sha256]),
    ).toThrow();

    constrained.run("DELETE FROM request_transcripts WHERE request_id = 'destination'");
    expect(store.deleteUnlinkedCheckpointCandidate({ requestId: "checkpoint" })).toBe(true);
    constrained.run("DELETE FROM core_surface_projections WHERE message_id = 'surface-message'");
    constrained.run("DELETE FROM core_owned_blobs WHERE sha256 = ?", [blob.sha256]);
    expect(constrained.query("PRAGMA foreign_key_check").all()).toEqual([]);
    constrained.close();

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("publishes and CAS-promotes a primary head without output links", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage7-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const sessionId = "primary-channel";
    const inputMessages = [{ role: "user", content: "first" }] satisfies ModelMessage[];
    const manifest = buildCoreLineageManifestV1([
      {
        atoms: [
          {
            kind: "synthetic",
            source: "stage7-test",
            messageDigest: hashCanonicalMessagesV1(inputMessages).hash,
          },
        ],
        canonicalMessages: inputMessages,
      },
    ]);
    const response = [{ role: "assistant", content: "answer" }] satisfies ModelMessage[];
    const providerState = {
      lastFamily: "claude-code",
      containsCrossFamilyTurns: false,
    } as const;
    const candidateSessionId = crypto.randomUUID();
    store.reserveCorePrimaryClaudeSessionAttempt({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId: "primary-1",
      attemptIndex: 0,
      candidateSessionId,
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    store.saveRequestTranscript({
      requestId: "primary-1",
      sessionId,
      requestClient: "discord",
      messages: response,
      corePrimaryLineage: manifest,
    });
    const transcript = store.getRequestTranscript({ requestId: "primary-1" });
    if (!transcript?.transcriptDigest) throw new Error("terminal transcript missing");
    const head = computeCorePrimaryClaudeTerminalHead({
      manifest,
      requestId: "primary-1",
      transcriptDigest: transcript.transcriptDigest,
      responseMessageCount: response.length,
      providerState,
    });
    store.publishCorePrimaryClaudeSuccess({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      requestId: "primary-1",
      attemptIndex: 0,
      terminalRequestId: "primary-1",
      terminalLineageVersion: 1,
      terminalAtomCount: head.atomCount,
      terminalPrefixDigest: head.prefixDigest,
      terminalCanonicalMessageCount: head.canonicalMessageCount,
      providerState,
      nativeCwd: "/workspace",
      nativeLastModified: 10,
      nativeContextTokens: 100,
      nativeContextMaxTokens: 1_000,
      lastModelSpecifier: "claude-code/sonnet",
      lastReasoning: "medium",
    });
    expect(store.listSurfaceMessagesForRequest({ requestId: "primary-1" })).toEqual([]);
    expect(
      store.promoteCorePrimaryClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "primary-1",
        attemptIndex: 0,
      }),
    ).toBe(true);
    expect(
      store.getCorePrimaryClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      }),
    ).toMatchObject({
      claudeSessionId: candidateSessionId,
      lineageVersion: 1,
      atomCount: head.atomCount,
      prefixDigest: head.prefixDigest,
      canonicalMessageCount: 2,
      revision: 1,
    });
    expect(store.getRequestTranscript({ requestId: "primary-1" })?.providerState).toEqual(
      providerState,
    );

    const clean = store.getCorePrimaryClaudeSessionBinding({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
    });
    if (!clean) throw new Error("clean binding missing");
    const reservePublished = (requestId: string) => {
      store.reserveCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        executionScopeHashVersion: 1,
        executionScopeHash: "scope",
        requestId,
        attemptIndex: 0,
        candidateSessionId: crypto.randomUUID(),
        sourceSessionId: clean.claudeSessionId,
        expectedBindingRevision: clean.revision,
      });
      store.saveRequestTranscript({
        requestId,
        sessionId,
        requestClient: "discord",
        messages: [{ role: "assistant", content: requestId }],
        corePrimaryLineage: manifest,
      });
      const candidateTranscript = store.getRequestTranscript({ requestId });
      if (!candidateTranscript?.transcriptDigest) throw new Error("candidate transcript missing");
      const candidateHead = computeCorePrimaryClaudeTerminalHead({
        manifest,
        requestId,
        transcriptDigest: candidateTranscript.transcriptDigest,
        responseMessageCount: 1,
        providerState,
      });
      store.publishCorePrimaryClaudeSuccess({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId,
        attemptIndex: 0,
        terminalRequestId: requestId,
        terminalLineageVersion: 1,
        terminalAtomCount: candidateHead.atomCount,
        terminalPrefixDigest: candidateHead.prefixDigest,
        terminalCanonicalMessageCount: candidateHead.canonicalMessageCount,
        providerState,
        nativeCwd: "/workspace",
        nativeLastModified: 20,
        nativeContextTokens: 200,
        nativeContextMaxTokens: 1_000,
        lastModelSpecifier: "claude-code/opus",
        lastReasoning: "high",
      });
    };
    reservePublished("primary-winner");
    reservePublished("primary-stale");
    expect(
      store.promoteCorePrimaryClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "primary-winner",
        attemptIndex: 0,
      }),
    ).toBe(true);
    expect(
      store.promoteCorePrimaryClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "primary-stale",
        attemptIndex: 0,
      }),
    ).toBe(false);
    expect(
      store.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "primary-stale",
        attemptIndex: 0,
      })?.state,
    ).toBe("failed");

    const current = store.getCorePrimaryClaudeSessionBinding({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
    });
    expect(current?.terminalRequestId).toBe("primary-winner");
    const corrupt = new Database(dbPath);
    corrupt.run(
      "UPDATE core_primary_lineage_manifests SET manifest_json = 'corrupt' WHERE request_id = ?",
      ["primary-winner"],
    );
    corrupt.close();
    store.close();
    const lazyVerification = new SqliteTranscriptStore(dbPath);
    expect(lazyVerification.getCoreRetentionDiagnostics()).toMatchObject({
      primaryBindingCount: 1,
      unverifiablePrimaryBindingCount: 0,
    });
    const retiredBinding = lazyVerification.getCorePrimaryClaudeSessionBinding({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
    });
    expect(retiredBinding).toBeNull();
    expect(
      selectCorePrimaryClaudePrefix({
        lineage: manifest,
        canonicalMessages: inputMessages,
        binding: retiredBinding,
        executionScopeHash: "scope",
        executionCwd: "/workspace",
      }),
    ).toEqual({ mode: "fresh", reason: "missing-binding" });
    expect(lazyVerification.getCoreRetentionDiagnostics()).toMatchObject({
      primaryBindingCount: 0,
      unverifiablePrimaryBindingCount: 0,
      orphanSucceededAttemptCount: 0,
    });

    lazyVerification.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("recovers primary outcomes and rejects stale promotion races", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage7-"));
    const dbPath = path.join(dir, "transcripts.db");
    const sessionId = "primary-recovery";
    const providerState = {
      lastFamily: "claude-code",
      containsCrossFamilyTurns: false,
    } as const;
    const inputMessages = [{ role: "user", content: "recover" }] satisfies ModelMessage[];
    const manifest = buildCoreLineageManifestV1([
      {
        atoms: [
          {
            kind: "synthetic",
            source: "recovery",
            messageDigest: hashCanonicalMessagesV1(inputMessages).hash,
          },
        ],
        canonicalMessages: inputMessages,
      },
    ]);
    const first = new SqliteTranscriptStore(dbPath);
    const publishPending = (requestId: string, expectedBindingRevision: number | null) => {
      const candidateSessionId = crypto.randomUUID();
      const binding = first.getCorePrimaryClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      });
      first.reserveCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        executionScopeHashVersion: 1,
        executionScopeHash: "scope",
        requestId,
        attemptIndex: 0,
        candidateSessionId,
        sourceSessionId: binding?.claudeSessionId ?? null,
        expectedBindingRevision,
      });
      const response = [{ role: "assistant", content: requestId }] satisfies ModelMessage[];
      first.saveRequestTranscript({
        requestId,
        sessionId,
        requestClient: "discord",
        messages: response,
        corePrimaryLineage: manifest,
      });
      const transcript = first.getRequestTranscript({ requestId });
      if (!transcript?.transcriptDigest) throw new Error("terminal transcript missing");
      const head = computeCorePrimaryClaudeTerminalHead({
        manifest,
        requestId,
        transcriptDigest: transcript.transcriptDigest,
        responseMessageCount: response.length,
        providerState,
      });
      first.publishCorePrimaryClaudeSuccess({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId,
        attemptIndex: 0,
        terminalRequestId: requestId,
        terminalLineageVersion: 1,
        terminalAtomCount: head.atomCount,
        terminalPrefixDigest: head.prefixDigest,
        terminalCanonicalMessageCount: head.canonicalMessageCount,
        providerState,
        nativeCwd: "/workspace",
        nativeLastModified: 10,
        nativeContextTokens: 100,
        nativeContextMaxTokens: 1_000,
        lastModelSpecifier: "claude-code/sonnet",
        lastReasoning: "medium",
      });
      return candidateSessionId;
    };
    const recoveredCandidate = publishPending("recover-pending", null);
    first.reserveCorePrimaryClaudeSessionAttempt({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: "crashed-owner",
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId: "crashed",
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    first.close();

    const recovered = new SqliteTranscriptStore(dbPath);
    expect(
      recovered.getCorePrimaryClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      })?.claudeSessionId,
    ).toBe(recoveredCandidate);
    expect(
      recovered.getCorePrimaryClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      })?.revision,
    ).toBe(1);
    expect(
      recovered.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: "crashed-owner",
        requestId: "crashed",
        attemptIndex: 0,
      })?.state,
    ).toBe("uncertain");
    recovered.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reports startup promotion rejection conservatively without claiming a CAS race", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-recovery-event-"));
    const dbPath = path.join(dir, "transcripts.db");
    const sessionId = "recovery-rejected";
    const first = new SqliteTranscriptStore(dbPath);
    const seeded = seedPrimaryBinding(first, "recovery-base", sessionId);
    const requestId = "recovery-pending";
    const inputMessages = [{ role: "user", content: "pending" }] satisfies ModelMessage[];
    const manifest = buildCoreLineageManifestV1([syntheticManifestSegment(inputMessages)]);
    const responseMessages = [
      { role: "assistant", content: "pending response" },
    ] satisfies ModelMessage[];
    const providerState = {
      lastFamily: "claude-code",
      containsCrossFamilyTurns: false,
    } as const;
    first.reserveCorePrimaryClaudeSessionAttempt({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId,
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
      sourceSessionId: seeded.binding.claudeSessionId,
      expectedBindingRevision: seeded.binding.revision,
    });
    first.saveRequestTranscript({
      requestId,
      sessionId,
      requestClient: "discord",
      messages: responseMessages,
      corePrimaryLineage: manifest,
    });
    const transcript = first.getRequestTranscript({ requestId });
    if (!transcript?.transcriptDigest) throw new Error("pending transcript missing");
    const head = computeCorePrimaryClaudeTerminalHead({
      manifest,
      requestId,
      transcriptDigest: transcript.transcriptDigest,
      responseMessageCount: responseMessages.length,
      providerState,
    });
    first.publishCorePrimaryClaudeSuccess({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      requestId,
      attemptIndex: 0,
      terminalRequestId: requestId,
      terminalLineageVersion: 1,
      terminalAtomCount: head.atomCount,
      terminalPrefixDigest: head.prefixDigest,
      terminalCanonicalMessageCount: head.canonicalMessageCount,
      providerState,
      nativeCwd: "/workspace",
      nativeLastModified: 20,
      nativeContextTokens: 200,
      nativeContextMaxTokens: 1_000,
      lastModelSpecifier: "claude-code/opus",
      lastReasoning: "high",
    });
    first.close();
    const raw = new Database(dbPath);
    raw.run(
      `UPDATE core_primary_claude_bindings SET revision = revision + 1
       WHERE request_client = 'discord' AND session_id = ? AND provider_id = 'claude-code'`,
      [sessionId],
    );
    raw.close();
    const events: Array<{
      level: string;
      event: string;
      detail: Readonly<Record<string, unknown>>;
    }> = [];
    const recovered = new SqliteTranscriptStore(dbPath, (level, event, detail) => {
      events.push({ level, event, detail });
    });

    expect(
      events.find(
        (entry) =>
          entry.event === "core_primary_claude.promotion_recovered" &&
          entry.detail["requestId"] === requestId,
      ),
    ).toMatchObject({
      level: "warn",
      detail: {
        reason: "promotion-rejected",
        outcome: "rejected",
        promoted: false,
      },
    });
    expect(events.some((entry) => entry.detail["reason"] === "binding-cas-lost")).toBe(false);
    recovered.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rolls back primary publication failures and bounds terminal attempts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage7-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const sessionId = "primary-atomic";
    const inputMessages = [{ role: "user", content: "atomic" }] satisfies ModelMessage[];
    const manifest = buildCoreLineageManifestV1([syntheticManifestSegment(inputMessages)]);
    const response = [{ role: "assistant", content: "candidate" }] satisfies ModelMessage[];
    const candidateSessionId = crypto.randomUUID();
    store.reserveCorePrimaryClaudeSessionAttempt({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId: "atomic-primary",
      attemptIndex: 0,
      candidateSessionId,
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    store.saveRequestTranscript({
      requestId: "atomic-primary",
      sessionId,
      requestClient: "discord",
      messages: response,
      corePrimaryLineage: manifest,
    });
    const transcript = store.getRequestTranscript({ requestId: "atomic-primary" });
    if (!transcript?.transcriptDigest) throw new Error("atomic transcript missing");
    const providerState = {
      lastFamily: "claude-code",
      containsCrossFamilyTurns: false,
    } as const;
    const head = computeCorePrimaryClaudeTerminalHead({
      manifest,
      requestId: "atomic-primary",
      transcriptDigest: transcript.transcriptDigest,
      responseMessageCount: response.length,
      providerState,
    });
    const raw = new Database(dbPath);
    raw.run(`CREATE TRIGGER reject_core_primary_success
      BEFORE UPDATE OF state ON core_primary_claude_attempts
      WHEN NEW.state = 'succeeded'
      BEGIN SELECT RAISE(ABORT, 'simulated primary success failure'); END`);
    raw.close();
    expect(() =>
      store.publishCorePrimaryClaudeSuccess({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "atomic-primary",
        attemptIndex: 0,
        terminalRequestId: "atomic-primary",
        terminalLineageVersion: 1,
        terminalAtomCount: head.atomCount,
        terminalPrefixDigest: head.prefixDigest,
        terminalCanonicalMessageCount: head.canonicalMessageCount,
        providerState,
        nativeCwd: "/workspace",
        nativeLastModified: 10,
        nativeContextTokens: 100,
        nativeContextMaxTokens: 1_000,
        lastModelSpecifier: "claude-code/sonnet",
        lastReasoning: "medium",
      }),
    ).toThrow("simulated primary success failure");
    expect(store.getRequestTranscript({ requestId: "atomic-primary" })?.providerState).toBeNull();
    expect(
      store.getCorePrimaryClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      }),
    ).toBeNull();
    store.recordCorePrimaryClaudeSessionAttemptOutcome({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      requestId: "atomic-primary",
      attemptIndex: 0,
      state: "failed",
    });
    store.reserveCorePrimaryClaudeSessionAttempt({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId: "bounded-primary-active",
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
      sourceSessionId: null,
      expectedBindingRevision: null,
    });

    for (let attemptIndex = 1; attemptIndex <= 40; attemptIndex += 1) {
      store.reserveCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        executionScopeHashVersion: 1,
        executionScopeHash: "scope",
        requestId: "bounded-primary",
        attemptIndex,
        candidateSessionId: crypto.randomUUID(),
        sourceSessionId: null,
        expectedBindingRevision: null,
      });
      store.recordCorePrimaryClaudeSessionAttemptOutcome({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "bounded-primary",
        attemptIndex,
        state: "failed",
      });
    }
    store.close();
    const retained = new Database(dbPath);
    expect(
      retained
        .query(
          `SELECT COUNT(*) AS count FROM core_primary_claude_attempts
           WHERE request_client = 'discord' AND session_id = ?`,
        )
        .get(sessionId),
    ).toEqual({ count: 33 });
    expect(
      retained
        .query(
          `SELECT state FROM core_primary_claude_attempts
           WHERE request_client = 'discord' AND session_id = ?
             AND request_id = 'bounded-primary-active'`,
        )
        .get(sessionId),
    ).toEqual({ state: "active" });
    retained.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
