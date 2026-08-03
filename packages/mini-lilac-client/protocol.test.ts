import { describe, expect, it } from "bun:test";

import type { UIMessage } from "ai";

import {
  type MiniLilacCompactRequest,
  type MiniLilacRedoRequest,
  type MiniLilacSessionSnapshot,
  type MiniLilacSteeringCommittedChunk,
  type MiniLilacSteerRequest,
  type MiniLilacTodo,
  type MiniLilacTodoChunk,
  type MiniLilacTodoState,
  type MiniLilacUIMessage,
  type MiniLilacUIMessageDataParts,
  type MiniLilacUIMessageMetadata,
  type MiniLilacUndoRequest,
  type MiniLilacUpdateSessionBindingsRequest,
  MINI_LILAC_UNSUPPORTED_UI_MESSAGE_CHUNK_TYPE,
  miniLilacCompactionEventSchema,
  miniLilacCompactRequestSchema,
  miniLilacCompactResultSchema,
  miniLilacHistoryFilesystemResultSchema,
  miniLilacReconnectQuerySchema,
  miniLilacRedoRequestSchema,
  miniLilacRedoResultSchema,
  miniLilacSessionSnapshotSchema,
  miniLilacSkillsSchema,
  miniLilacSteeringCommittedChunkSchema,
  miniLilacSteerRequestSchema,
  miniLilacTodoChunkSchema,
  miniLilacTodoSchema,
  miniLilacTodoStateSchema,
  miniLilacTodoWriteInputSchema,
  miniLilacUIMessageDataPartSchema,
  miniLilacUIMessageMetadataSchema,
  miniLilacUIMessageSchema,
  miniLilacUnsupportedUIMessageChunkSchema,
  miniLilacUndoRequestSchema,
  miniLilacUndoResultSchema,
  miniLilacUpdateSessionBindingsRequestSchema,
} from "./protocol";

function messageWith(part: unknown): unknown {
  return { id: "message-1", role: "assistant", parts: [part] };
}

describe("unsupported UI message chunk sentinel", () => {
  it("keeps only a bounded future chunk type in a strict transient data envelope", () => {
    expect(
      miniLilacUnsupportedUIMessageChunkSchema.parse({
        type: MINI_LILAC_UNSUPPORTED_UI_MESSAGE_CHUNK_TYPE,
        data: { chunkType: "future-observation" },
        transient: true,
      }),
    ).toEqual({
      type: MINI_LILAC_UNSUPPORTED_UI_MESSAGE_CHUNK_TYPE,
      data: { chunkType: "future-observation" },
      transient: true,
    });

    for (const malformed of [
      {
        type: MINI_LILAC_UNSUPPORTED_UI_MESSAGE_CHUNK_TYPE,
        data: { chunkType: "" },
        transient: true,
      },
      {
        type: MINI_LILAC_UNSUPPORTED_UI_MESSAGE_CHUNK_TYPE,
        data: { chunkType: "x".repeat(129) },
        transient: true,
      },
      {
        type: MINI_LILAC_UNSUPPORTED_UI_MESSAGE_CHUNK_TYPE,
        data: { chunkType: "future-observation", payload: true },
        transient: true,
      },
    ]) {
      expect(miniLilacUnsupportedUIMessageChunkSchema.safeParse(malformed).success).toBe(false);
    }
  });
});

const pendingTodo = {
  content: "Implement durable todos",
  status: "pending" as const,
  priority: "high" as const,
} satisfies MiniLilacTodo;

describe("miniLilacUIMessageSchema", () => {
  it("strictly validates initial and exact-run reconnect queries", () => {
    expect(miniLilacReconnectQuerySchema.parse({})).toEqual({});
    expect(miniLilacReconnectQuerySchema.parse({ runId: "run-1", after: "12" })).toEqual({
      runId: "run-1",
      after: 12,
    });

    for (const malformed of [
      { runId: "run-1" },
      { after: "0" },
      { runId: "run-1", after: "-1" },
      { runId: "run-1", after: "1.5" },
      { runId: "run-1", after: "0", unexpected: "value" },
    ]) {
      expect(miniLilacReconnectQuerySchema.safeParse(malformed).success).toBe(false);
    }
  });

  it("validates bounded skill summaries", () => {
    expect(
      miniLilacSkillsSchema.parse([
        { name: "frontend-design", description: "Build deliberate interfaces." },
      ]),
    ).toEqual([{ name: "frontend-design", description: "Build deliberate interfaces." }]);
    expect(miniLilacSkillsSchema.safeParse([{ name: "Bad_Name", description: "no" }]).success).toBe(
      false,
    );
  });

  it("accepts durable title and context usage on session snapshots", () => {
    const snapshot = {
      id: "session-1",
      activeRunId: null,
      status: "idle",
      cwd: "/workspace",
      model: "openai/gpt-test",
      profile: "coding",
      reasoning: "high",
      historyStateId: "history-1",
      canUndo: true,
      canRedo: false,
      title: "Implement context display",
      inputTokens: 12_500,
      contextWindow: 128_000,
      queuedSteeringCount: 0,
    } satisfies MiniLilacSessionSnapshot;
    expect(miniLilacSessionSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      miniLilacSessionSnapshotSchema.safeParse({ ...snapshot, contextWindow: 0 }).success,
    ).toBe(false);
    expect(
      miniLilacSessionSnapshotSchema.safeParse({ ...snapshot, title: "x".repeat(101) }).success,
    ).toBe(false);
    for (const malformed of [
      { ...snapshot, historyStateId: undefined },
      { ...snapshot, canUndo: undefined },
      { ...snapshot, canRedo: undefined },
      { ...snapshot, unexpected: true },
    ]) {
      expect(miniLilacSessionSnapshotSchema.safeParse(malformed).success).toBe(false);
    }
  });

  it("strictly validates todo fields and bounds", () => {
    expect(miniLilacTodoSchema.parse(pendingTodo)).toEqual(pendingTodo);

    for (const malformed of [
      { ...pendingTodo, content: "x".repeat(501) },
      { ...pendingTodo, status: "blocked" },
      { ...pendingTodo, priority: "urgent" },
      { ...pendingTodo, unexpected: true },
    ]) {
      expect(miniLilacTodoSchema.safeParse(malformed).success).toBe(false);
    }

    expect(
      miniLilacTodoSchema.safeParse({ content: "", status: "cancelled", priority: "low" }).success,
    ).toBe(true);
  });

  it("validates todo state revisions, list size, and a single active todo", () => {
    const state = {
      revision: Number.MAX_SAFE_INTEGER,
      todos: [pendingTodo, { ...pendingTodo, content: "Run tests", status: "in_progress" }],
    } satisfies MiniLilacTodoState;

    expect(miniLilacTodoStateSchema.parse(state)).toEqual(state);
    expect(
      miniLilacTodoStateSchema.safeParse({ revision: 0, todos: Array(50).fill(pendingTodo) })
        .success,
    ).toBe(true);

    for (const malformed of [
      { revision: -1, todos: [] },
      { revision: 1.5, todos: [] },
      { revision: Number.MAX_SAFE_INTEGER + 1, todos: [] },
      { revision: 0, todos: Array(51).fill(pendingTodo) },
      {
        revision: 0,
        todos: [
          { ...pendingTodo, status: "in_progress" },
          { ...pendingTodo, content: "Also active", status: "in_progress" },
        ],
      },
      { revision: 0, todos: [], unexpected: true },
    ]) {
      expect(miniLilacTodoStateSchema.safeParse(malformed).success).toBe(false);
    }
  });

  it("applies the exact serialized todo-state byte limit to tool input", () => {
    const oversizedTodos = Array.from({ length: 50 }, (_, index) => ({
      content: `${index}-${"\u754c".repeat(497)}`,
      status: "pending" as const,
      priority: "medium" as const,
    }));
    expect(oversizedTodos.every((todo) => todo.content.length <= 500)).toBe(true);
    expect(miniLilacTodoWriteInputSchema.safeParse({ todos: oversizedTodos }).success).toBe(false);
    expect(
      miniLilacTodoWriteInputSchema.safeParse({
        todos: [{ content: "", status: "cancelled", priority: "low" }],
      }).success,
    ).toBe(true);
  });

  it("enforces the deterministic serialized todo state UTF-8 byte limit", () => {
    const todos = Array.from({ length: 50 }, (_, index) => ({
      content: index < 20 ? "\u0800".repeat(500) : index === 20 ? "a".repeat(29) : "",
      status: "pending" as const,
      priority: "medium" as const,
    }));
    const exactLimit = { revision: 0, todos };

    expect(
      new TextEncoder().encode(JSON.stringify({ ...exactLimit, revision: Number.MAX_SAFE_INTEGER }))
        .byteLength,
    ).toBe(32 * 1_024);
    expect(miniLilacTodoStateSchema.safeParse(exactLimit).success).toBe(true);

    const boundaryTodo = todos[20];
    if (!boundaryTodo) throw new Error("Expected boundary todo fixture");
    todos[20] = { ...boundaryTodo, content: "a".repeat(30) };
    expect(miniLilacTodoStateSchema.safeParse({ revision: 0, todos }).success).toBe(false);
  });

  it("validates a standalone strict transient todos chunk", () => {
    const chunk = {
      type: "data-todos",
      id: "todos-1",
      data: { revision: 2, todos: [pendingTodo] },
      transient: true,
    } satisfies MiniLilacTodoChunk;

    expect(miniLilacTodoChunkSchema.parse(chunk)).toEqual(chunk);
    expect(miniLilacTodoChunkSchema.safeParse({ ...chunk, transient: false }).success).toBe(false);
    expect(miniLilacTodoChunkSchema.safeParse({ ...chunk, unexpected: true }).success).toBe(false);
    expect(miniLilacUIMessageDataPartSchema.safeParse(chunk).success).toBe(false);
    expect(miniLilacUIMessageSchema.safeParse(messageWith(chunk)).success).toBe(false);
  });

  it("strictly validates committed steering chunks", () => {
    const chunk: MiniLilacSteeringCommittedChunk = {
      type: "data-steeringCommitted",
      id: "steering-message-1",
      data: {
        id: "steering-message-1",
        role: "user",
        parts: [{ type: "text", text: "Change direction" }],
      },
    };

    expect(miniLilacSteeringCommittedChunkSchema.parse(chunk)).toEqual(chunk);
    expect(
      miniLilacSteeringCommittedChunkSchema.safeParse({ ...chunk, unexpected: true }).success,
    ).toBe(false);
    expect(
      miniLilacSteeringCommittedChunkSchema.safeParse({
        ...chunk,
        data: { ...chunk.data, role: "assistant" },
      }).success,
    ).toBe(false);
  });

  it("requires strict binding updates with a wire command ID and at least one binding", () => {
    const request = {
      sessionId: "session-1",
      clientCommandId: "bindings-1",
      model: "test/new-model",
      reasoning: "high",
    } satisfies MiniLilacUpdateSessionBindingsRequest;

    expect(miniLilacUpdateSessionBindingsRequestSchema.parse(request)).toEqual(request);
    expect(
      miniLilacUpdateSessionBindingsRequestSchema.safeParse({
        sessionId: "session-1",
        clientCommandId: "bindings-1",
      }).success,
    ).toBe(false);
    expect(
      miniLilacUpdateSessionBindingsRequestSchema.safeParse({
        ...request,
        clientCommandId: undefined,
      }).success,
    ).toBe(false);
    expect(
      miniLilacUpdateSessionBindingsRequestSchema.safeParse({ ...request, cwd: "/other" }).success,
    ).toBe(false);
  });

  it("strictly validates undo commands and their exact removed user message", () => {
    const request = {
      sessionId: "session-1",
      clientCommandId: "undo-1",
    } satisfies MiniLilacUndoRequest;
    const message = {
      id: "user-image",
      role: "user" as const,
      parts: [
        { type: "text" as const, text: "describe this" },
        { type: "file" as const, mediaType: "image/png", url: "data:image/png;base64,AA==" },
      ],
    };
    const successfulResult = {
      status: "undone" as const,
      clientCommandId: "undo-1",
      message,
      historyStateId: "history-1",
      filesystem: { status: "restored" as const },
    };

    expect(miniLilacUndoRequestSchema.parse(request)).toEqual(request);
    expect(miniLilacUndoRequestSchema.safeParse({ sessionId: "session-1" }).success).toBe(false);
    expect(miniLilacUndoRequestSchema.safeParse({ ...request, runId: "run-1" }).success).toBe(
      false,
    );
    expect(miniLilacUndoResultSchema.parse(successfulResult)).toEqual(successfulResult);
    expect(
      miniLilacUndoResultSchema.safeParse({
        ...successfulResult,
        message: { ...successfulResult.message, role: "assistant" },
      }).success,
    ).toBe(false);
    expect(
      miniLilacUndoResultSchema.parse({
        status: "empty",
        clientCommandId: "undo-empty",
      }),
    ).toEqual({ status: "empty", clientCommandId: "undo-empty" });
    expect(
      miniLilacUndoResultSchema.safeParse({
        status: "empty",
        clientCommandId: "undo-empty",
        message,
      }).success,
    ).toBe(false);
    expect(
      miniLilacUndoResultSchema.safeParse({
        ...successfulResult,
        historyStateId: undefined,
      }).success,
    ).toBe(false);
    expect(
      miniLilacUndoResultSchema.safeParse({ ...successfulResult, message: undefined }).success,
    ).toBe(false);
    expect(
      miniLilacUndoResultSchema.safeParse({ ...successfulResult, filesystem: undefined }).success,
    ).toBe(false);
    expect(
      miniLilacUndoResultSchema.safeParse({ ...successfulResult, unexpected: true }).success,
    ).toBe(false);
  });

  it("strictly validates history filesystem outcomes", () => {
    expect(miniLilacHistoryFilesystemResultSchema.parse({ status: "restored" })).toEqual({
      status: "restored",
    });

    for (const reason of [
      "git-unavailable",
      "non-git-workspace",
      "snapshot-unavailable",
      "platform-unsupported",
    ] as const) {
      expect(miniLilacHistoryFilesystemResultSchema.parse({ status: "skipped", reason })).toEqual({
        status: "skipped",
        reason,
      });
    }

    for (const malformed of [
      { status: "restored", reason: "git-unavailable" },
      { status: "restored", unexpected: true },
      { status: "skipped" },
      { status: "skipped", reason: "capture-failed" },
      { status: "skipped", reason: "git-unavailable", unexpected: true },
    ]) {
      expect(miniLilacHistoryFilesystemResultSchema.safeParse(malformed).success).toBe(false);
    }
  });

  it("strictly validates redo commands and their exact restored user message", () => {
    const request = {
      sessionId: "session-1",
      clientCommandId: "redo-1",
    } satisfies MiniLilacRedoRequest;
    const message = {
      id: "user-1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "restore this" }],
    };
    const successfulResult = {
      status: "redone" as const,
      clientCommandId: "redo-1",
      message,
      historyStateId: "history-2",
      filesystem: { status: "skipped" as const, reason: "snapshot-unavailable" as const },
    };

    expect(miniLilacRedoRequestSchema.parse(request)).toEqual(request);
    expect(miniLilacRedoRequestSchema.safeParse({ sessionId: "session-1" }).success).toBe(false);
    expect(miniLilacRedoRequestSchema.safeParse({ ...request, runId: "run-1" }).success).toBe(
      false,
    );
    expect(miniLilacRedoResultSchema.parse(successfulResult)).toEqual(successfulResult);
    expect(
      miniLilacRedoResultSchema.safeParse({
        ...successfulResult,
        message: { ...message, role: "assistant" },
      }).success,
    ).toBe(false);
    expect(
      miniLilacRedoResultSchema.parse({ status: "empty", clientCommandId: "redo-empty" }),
    ).toEqual({ status: "empty", clientCommandId: "redo-empty" });

    for (const malformed of [
      { ...successfulResult, message: undefined },
      { ...successfulResult, historyStateId: undefined },
      { ...successfulResult, filesystem: undefined },
      { ...successfulResult, unexpected: true },
      { status: "empty" },
      { status: "empty", clientCommandId: "redo-empty", message },
      { status: "empty", clientCommandId: "redo-empty", historyStateId: "history-2" },
    ]) {
      expect(miniLilacRedoResultSchema.safeParse(malformed).success).toBe(false);
    }
  });

  it("strictly validates durable manual compaction commands and results", () => {
    const request = {
      sessionId: "session-1",
      clientCommandId: "compact-1",
    } satisfies MiniLilacCompactRequest;
    const metrics = {
      clientCommandId: "compact-1",
      messageCountBefore: 12,
      messageCountAfter: 4,
      estimatedInputTokensBefore: 8_000,
      estimatedInputTokensAfter: 2_000,
    };

    expect(miniLilacCompactRequestSchema.parse(request)).toEqual(request);
    expect(miniLilacCompactRequestSchema.safeParse({ sessionId: "session-1" }).success).toBe(false);
    expect(miniLilacCompactRequestSchema.safeParse({ ...request, runId: "run-1" }).success).toBe(
      false,
    );

    for (const status of ["compacted", "empty", "noop"] as const) {
      expect(miniLilacCompactResultSchema.parse({ status, ...metrics })).toEqual({
        status,
        ...metrics,
      });
    }
    expect(
      miniLilacCompactResultSchema.parse({
        status: "empty",
        clientCommandId: "compact-empty",
        messageCountBefore: 0,
        messageCountAfter: 0,
      }),
    ).toEqual({
      status: "empty",
      clientCommandId: "compact-empty",
      messageCountBefore: 0,
      messageCountAfter: 0,
    });
    expect(
      miniLilacCompactResultSchema.safeParse({
        status: "compacted",
        ...metrics,
        estimatedInputTokensAfter: -1,
      }).success,
    ).toBe(false);
    expect(
      miniLilacCompactResultSchema.safeParse({
        status: "noop",
        ...metrics,
        messageCountBefore: 1.5,
      }).success,
    ).toBe(false);
    expect(
      miniLilacCompactResultSchema.safeParse({ status: "compacted", ...metrics, reason: "manual" })
        .success,
    ).toBe(false);
  });

  it("requires steering to carry one strict nonempty user UI message", () => {
    const request = {
      sessionId: "session-1",
      runId: "run-1",
      message: {
        id: "steer-1",
        role: "user",
        parts: [{ type: "text", text: "change direction" }],
      },
    } satisfies MiniLilacSteerRequest;

    expect(miniLilacSteerRequestSchema.parse(request)).toEqual(request);
    expect(
      miniLilacSteerRequestSchema.safeParse({ ...request, message: "change direction" }).success,
    ).toBe(false);
    expect(
      miniLilacSteerRequestSchema.safeParse({
        ...request,
        message: { ...request.message, role: "assistant" },
      }).success,
    ).toBe(false);
    expect(
      miniLilacSteerRequestSchema.safeParse({
        ...request,
        message: { ...request.message, parts: [] },
      }).success,
    ).toBe(false);
    expect(miniLilacSteerRequestSchema.safeParse({ ...request, unexpected: true }).success).toBe(
      false,
    );
  });

  it("accepts strict browser-safe AI SDK 7 usage metadata", () => {
    const metadata = {
      createdAt: "2026-07-21T12:00:00.000Z",
      model: "test/model",
      profile: "coding",
      reasoning: "high" as const,
      usage: {
        inputTokens: 12,
        inputTokenDetails: { noCacheTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2 },
        outputTokens: 8,
        outputTokenDetails: { textTokens: 5, reasoningTokens: 3 },
        totalTokens: 20,
        raw: { billed_tokens: 18 },
      },
    };

    expect(miniLilacUIMessageMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(
      miniLilacUIMessageMetadataSchema.safeParse({
        ...metadata,
        usage: { ...metadata.usage, unexpected: true },
      }).success,
    ).toBe(false);
    expect(
      miniLilacUIMessageMetadataSchema.safeParse({
        ...metadata,
        usage: { ...metadata.usage, raw: { invalid: undefined } },
      }).success,
    ).toBe(false);
  });

  it("accepts all supported AI SDK 7 content, source, file, and custom parts", () => {
    const parts: unknown[] = [
      {
        type: "text",
        text: "answer",
        state: "done",
        providerMetadata: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
      {
        type: "reasoning",
        text: "thinking",
        state: "streaming",
        providerMetadata: { openai: { itemId: "reasoning-1" } },
      },
      {
        type: "file",
        mediaType: "text/plain",
        filename: "answer.txt",
        url: "data:,answer",
        providerReference: { openai: "file-1" },
        providerMetadata: { openai: { containerId: "container-1" } },
      },
      {
        type: "source-url",
        sourceId: "source-1",
        url: "https://example.test",
        title: "Example",
        providerMetadata: { openai: { citedText: "example" } },
      },
      {
        type: "source-document",
        sourceId: "source-2",
        mediaType: "text/plain",
        title: "Document",
        filename: "document.txt",
        providerMetadata: { openai: { page: 1 } },
      },
      {
        type: "reasoning-file",
        mediaType: "application/json",
        url: "data:application/json,%7B%7D",
        providerMetadata: { openai: { itemId: "reasoning-file-1" } },
      },
      { type: "step-start" },
      {
        type: "custom",
        kind: "anthropic.redacted-thinking",
        providerMetadata: { anthropic: { data: "redacted" } },
      },
      {
        type: "data-session",
        id: "session-part-1",
        data: {
          id: "session-1",
          activeRunId: null,
          status: "idle",
          cwd: "/workspace",
          model: null,
          profile: null,
          reasoning: null,
          historyStateId: "history-1",
          canUndo: false,
          canRedo: false,
          queuedSteeringCount: 0,
        },
      },
      { type: "data-control", data: { status: "empty" } },
      { type: "data-transcriptReset", data: { reason: "interrupt" } },
      {
        type: "data-outputRollback",
        data: {
          reason: "interrupt",
          reasoningIds: ["reasoning-current"],
          textIds: [],
          toolCallIds: ["tool-current"],
        },
      },
      {
        type: "data-subagentStatus",
        data: {
          toolCallId: "tool-1",
          runId: "run-1",
          sessionId: "sub:session-1:named:research",
          sessionName: "research",
          profile: "explore",
          prompt: "Inspect the code",
          mode: "sync",
          state: "running",
          toolCount: 0,
        },
      },
      {
        type: "data-compaction",
        id: "compact-1",
        data: {
          source: "automatic",
          reason: "threshold",
          phase: "completed",
          outcome: "compacted",
          messageCountBefore: 12,
          messageCountAfter: 4,
          estimatedInputTokensBefore: 8_000,
          estimatedInputTokensAfter: 2_000,
        },
      },
    ];

    for (const part of parts) {
      expect(miniLilacUIMessageSchema.safeParse(messageWith(part)).success).toBe(true);
    }
  });

  it("accepts every AI SDK 7 tool state for static and dynamic tools", () => {
    const toolParts: unknown[] = [
      {
        type: "tool-shell",
        toolCallId: "tool-1",
        title: "Shell",
        toolMetadata: { destructive: false, tags: ["local"] },
        state: "input-streaming",
        input: { command: "pw" },
        preliminary: undefined,
        providerExecuted: false,
        callProviderMetadata: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
      {
        type: "dynamic-tool",
        toolName: "search",
        toolCallId: "tool-2",
        state: "input-available",
        input: { query: "lilac" },
        preliminary: undefined,
      },
      {
        type: "tool-shell",
        toolCallId: "tool-3",
        state: "approval-requested",
        input: { command: "rm file" },
        preliminary: undefined,
        approval: {
          id: "approval-1",
          isAutomatic: false,
          signature: "signed-request",
        },
      },
      {
        type: "dynamic-tool",
        toolName: "deploy",
        toolCallId: "tool-4",
        state: "approval-responded",
        input: { environment: "test" },
        preliminary: undefined,
        approval: {
          id: "approval-2",
          approved: true,
          reason: "approved",
          isAutomatic: false,
          signature: "signed-response",
        },
      },
      {
        type: "tool-shell",
        toolCallId: "tool-5",
        state: "output-available",
        input: { command: "pwd" },
        output: "/workspace",
        resultProviderMetadata: { openai: { itemId: "result-1" } },
        preliminary: true,
        approval: {
          id: "approval-3",
          approved: true,
          isAutomatic: true,
          signature: "signed-result",
        },
      },
      {
        type: "dynamic-tool",
        toolName: "search",
        toolCallId: "tool-6",
        state: "output-error",
        rawInput: "invalid-json",
        errorText: "invalid input",
        preliminary: undefined,
        resultProviderMetadata: { openai: { retryable: false } },
      },
      {
        type: "tool-shell",
        toolCallId: "tool-7",
        state: "output-denied",
        input: { command: "rm file" },
        preliminary: undefined,
        approval: {
          id: "approval-4",
          approved: false,
          reason: "unsafe",
          isAutomatic: false,
          signature: "signed-denial",
        },
      },
    ];

    for (const part of toolParts) {
      expect(miniLilacUIMessageSchema.safeParse(messageWith(part)).success).toBe(true);
    }
  });

  it("infers a strongly typed AI SDK UIMessage", () => {
    const message: MiniLilacUIMessage = miniLilacUIMessageSchema.parse(
      messageWith({ type: "text", text: "typed" }),
    );
    const sdkMessage: UIMessage<MiniLilacUIMessageMetadata, MiniLilacUIMessageDataParts> = message;

    expect(sdkMessage.parts[0]?.type).toBe("text");
  });

  it("rejects empty parts and malformed standard parts", () => {
    const malformedMessages: unknown[] = [
      { id: "message-1", role: "assistant", parts: [] },
      messageWith({ type: "text", text: 42 }),
      messageWith({ type: "reasoning", text: null }),
      messageWith({ type: "file", mediaType: "text/plain", url: 42 }),
      messageWith({ type: "source-url", sourceId: 42, url: "https://example.test" }),
      messageWith({ type: "source-document", sourceId: "source-1", mediaType: "text/plain" }),
      messageWith({
        type: "tool-shell",
        toolCallId: 42,
        state: "input-available",
        input: { command: "pwd" },
      }),
      messageWith({
        type: "tool-shell",
        toolCallId: "tool-1",
        state: "output-error",
        input: { command: "pwd" },
      }),
    ];

    for (const message of malformedMessages) {
      expect(miniLilacUIMessageSchema.safeParse(message).success).toBe(false);
    }
  });

  it("keeps custom data parts strict", () => {
    expect(
      miniLilacUIMessageDataPartSchema.safeParse({
        type: "data-subagentStatus",
        data: {
          toolCallId: "tool-1",
          runId: "run-1",
          profile: "explore",
          prompt: "Inspect the code",
          mode: "sync",
          state: "running",
          toolCount: 0,
          unexpected: true,
        },
      }).success,
    ).toBe(false);
    expect(
      miniLilacUIMessageDataPartSchema.safeParse({
        type: "data-compaction",
        data: {
          source: "manual",
          reason: "threshold",
          phase: "completed",
          messageCountBefore: 1,
        },
      }).success,
    ).toBe(false);
    expect(
      miniLilacUIMessageSchema.safeParse(
        messageWith({ type: "data-unknown", data: { value: true } }),
      ).success,
    ).toBe(false);
  });

  it("requires terminal result fields on completed compaction events", () => {
    const completed = {
      source: "manual",
      reason: "manual",
      phase: "completed",
      messageCountBefore: 4,
      messageCountAfter: 2,
      outcome: "compacted",
    } as const;

    expect(miniLilacCompactionEventSchema.safeParse(completed).success).toBe(true);
    expect(
      miniLilacCompactionEventSchema.safeParse({ ...completed, outcome: undefined }).success,
    ).toBe(false);
    expect(
      miniLilacCompactionEventSchema.safeParse({ ...completed, messageCountAfter: undefined })
        .success,
    ).toBe(false);
  });

  it("accepts legacy persisted split-turn compaction progress", () => {
    expect(
      miniLilacCompactionEventSchema.safeParse({
        source: "automatic",
        reason: "threshold",
        phase: "progress",
        messageCountBefore: 12,
        progress: { stage: "split-turn", step: 1, stepCount: 1, pass: 1 },
      }).success,
    ).toBe(true);
  });

  it("rejects unknown top-level and nested fields instead of stripping them", () => {
    const messagesWithUnknownFields: unknown[] = [
      {
        id: "message-1",
        role: "assistant",
        parts: [{ type: "text", text: "answer" }],
        unexpected: true,
      },
      {
        id: "message-1",
        role: "assistant",
        metadata: { model: "test/model", unexpected: true },
        parts: [{ type: "text", text: "answer" }],
      },
      messageWith({ type: "text", text: "answer", unexpected: true }),
      messageWith({ type: "step-start", unexpected: true }),
      messageWith({
        type: "tool-shell",
        toolCallId: "tool-1",
        state: "input-available",
        input: {},
        unexpected: true,
      }),
      messageWith({
        type: "tool-shell",
        toolCallId: "tool-1",
        state: "approval-requested",
        input: {},
        approval: { id: "approval-1", unexpected: true },
      }),
      messageWith({
        type: "data-subagentStatus",
        data: {
          toolCallId: "tool-1",
          runId: "run-1",
          profile: "explore",
          prompt: "Inspect the code",
          mode: "sync",
          state: "running",
          toolCount: 0,
        },
        unexpected: true,
      }),
      messageWith({
        type: "data-subagentStatus",
        data: {
          toolCallId: "tool-1",
          runId: "run-1",
          profile: "explore",
          prompt: "Inspect the code",
          mode: "sync",
          state: "running",
          toolCount: 0,
          unexpected: true,
        },
      }),
    ];

    for (const message of messagesWithUnknownFields) {
      expect(miniLilacUIMessageSchema.safeParse(message).success).toBe(false);
    }
  });
});
