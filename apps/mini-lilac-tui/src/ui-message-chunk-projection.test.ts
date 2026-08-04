import { describe, expect, it } from "bun:test";

import type { UIMessageChunk } from "ai";

import { MINI_LILAC_UNSUPPORTED_UI_MESSAGE_CHUNK_TYPE } from "@stanley2058/mini-lilac-client";

import {
  projectInitialMessages,
  projectMiniLilacStreamChunk,
  projectUIMessageChunk,
  UIMessageChunkProjectionState,
} from "./ui-message-chunk-projection";

function createProjectionState() {
  const state = new UIMessageChunkProjectionState();
  return Object.assign(state, {
    project: (chunk: UIMessageChunk) => projectUIMessageChunk(chunk, state),
  });
}

describe("projectUIMessageChunk", () => {
  it("projects non-tool SDK chunks and adapts tool chunks at the observation boundary", () => {
    const input = { command: "bun test" };
    const output = { stdout: "pass\n", exitCode: 0 };
    const inputChunk = {
      type: "tool-input-available",
      toolCallId: "tool-input",
      toolName: "bash",
      input,
    } satisfies UIMessageChunk;
    const outputChunk = {
      type: "tool-output-available",
      toolCallId: "tool-output",
      output,
    } satisfies UIMessageChunk;
    const chunks = [
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "hello" },
      { type: "text-end", id: "text" },
      { type: "reasoning-start", id: "reasoning" },
      { type: "reasoning-delta", id: "reasoning", delta: "thinking" },
      { type: "reasoning-end", id: "reasoning" },
      { type: "error", errorText: "failed" },
      {
        type: "source-url",
        sourceId: "url",
        url: "https://example.test",
        title: "Example",
      },
      {
        type: "source-document",
        sourceId: "document",
        mediaType: "text/plain",
        title: "Document",
        filename: "document.txt",
      },
      { type: "file", url: "https://example.test/file", mediaType: "text/plain" },
      { type: "finish", finishReason: "stop" },
    ] satisfies readonly UIMessageChunk[];

    expect(chunks.map((chunk) => projectUIMessageChunk(chunk))).toEqual([
      { kind: "rendered", chunk: { type: "text-start", id: "text" } },
      { kind: "rendered", chunk: { type: "text-delta", id: "text", delta: "hello" } },
      { kind: "rendered", chunk: { type: "text-end", id: "text" } },
      { kind: "rendered", chunk: { type: "reasoning-start", id: "reasoning" } },
      {
        kind: "rendered",
        chunk: { type: "reasoning-delta", id: "reasoning", delta: "thinking" },
      },
      { kind: "rendered", chunk: { type: "reasoning-end", id: "reasoning" } },
      { kind: "rendered", chunk: { type: "error", errorText: "failed" } },
      {
        kind: "rendered",
        chunk: { type: "source-url", url: "https://example.test", title: "Example" },
      },
      {
        kind: "rendered",
        chunk: {
          type: "source-document",
          mediaType: "text/plain",
          title: "Document",
          filename: "document.txt",
        },
      },
      { kind: "rendered", chunk: { type: "file", mediaType: "text/plain" } },
      { kind: "rendered", chunk: { type: "finish", finishReason: "stop" } },
    ]);

    const state = createProjectionState();
    expect(projectUIMessageChunk(inputChunk, state)).toMatchObject({
      kind: "tool",
      toolCallId: "tool-input",
      projection: { kind: "bash", command: "bun test", state: { status: "active" } },
    });
    expect(projectUIMessageChunk(outputChunk, state)).toMatchObject({
      kind: "tool",
      toolCallId: "tool-output",
      projection: { kind: "unknown-tool", state: { status: "success" } },
    });
  });

  it("projects every intentionally ignored known chunk and preserves its envelope", () => {
    const chunks = [
      { type: "custom", kind: "provider.event" },
      { type: "tool-input-delta", toolCallId: "tool", inputTextDelta: '{"command":' },
      {
        type: "reasoning-file",
        url: "https://example.test/reasoning",
        mediaType: "text/plain",
      },
      { type: "start-step" },
      { type: "finish-step" },
      { type: "start", messageId: "message" },
      { type: "message-metadata", messageMetadata: { traceId: "trace" } },
    ] satisfies readonly UIMessageChunk[];

    for (const chunk of chunks) {
      const projected = projectUIMessageChunk(chunk);
      expect(projected.kind).toBe("ignored");
      if (projected.kind !== "ignored") throw new Error("expected ignored projection");
      expect(projected).toEqual({ kind: "ignored" });
    }
  });

  it("ignores arbitrary data chunks after the open SDK boundary", () => {
    const chunk = {
      type: "data-futureExtension",
      id: "future-data",
      data: { nested: true },
      transient: true,
    } satisfies UIMessageChunk;

    const projected = projectUIMessageChunk(chunk);

    expect(projected).toEqual({ kind: "ignored" });
  });

  it("projects a future non-data SDK variant as explicitly unsupported", () => {
    const futureChunk = { type: "future-observation", payload: { opaque: true } };

    // @ts-expect-error -- simulates one future SDK variant beyond the installed union.
    expect(projectUIMessageChunk(futureChunk)).toEqual({
      kind: "unsupported",
      chunkType: "future-observation",
    });
  });
});

describe("projectMiniLilacStreamChunk", () => {
  it("projects transport unsupported and controller-owned variants into a closed union", () => {
    const steering = {
      id: "steering-1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "change direction" }],
    };

    expect(
      projectMiniLilacStreamChunk({
        type: MINI_LILAC_UNSUPPORTED_UI_MESSAGE_CHUNK_TYPE,
        data: { chunkType: "future-observation" },
        transient: true,
      }),
    ).toEqual({
      kind: "renderer",
      chunk: { kind: "unsupported", chunkType: "future-observation" },
    });
    expect(projectMiniLilacStreamChunk({ type: "finish", finishReason: "stop" })).toEqual({
      kind: "finish",
      chunk: { type: "finish", finishReason: "stop" },
    });
    expect(
      projectMiniLilacStreamChunk({
        type: "data-streamCursor",
        data: { runId: "run-1", seq: 2 },
        transient: true,
      }),
    ).toEqual({ kind: "cursor", cursor: { runId: "run-1", seq: 2 } });
    expect(projectMiniLilacStreamChunk({ type: "data-steering", data: steering })).toEqual({
      kind: "steering",
      message: steering,
    });
    expect(projectMiniLilacStreamChunk({ type: "data-steeringCommitted", data: steering })).toEqual(
      { kind: "steering-committed", message: steering },
    );
  });
});

describe("tool chunk projection state", () => {
  it("projects canonical replay and live completion through the same boundary", () => {
    const canonical = projectInitialMessages([
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "bash",
            toolCallId: "bash-1",
            state: "output-available",
            input: { command: "bun test" },
            output: {
              stdout: "pass\n",
              stderr: "",
              exitCode: 0,
              stdoutTruncated: false,
              stderrTruncated: false,
            },
          },
        ],
      },
    ])[0]?.parts[0];
    const state = createProjectionState();
    state.project({
      type: "tool-input-available",
      toolCallId: "bash-1",
      toolName: "bash",
      input: { command: "bun test" },
    });
    const live = state.project({
      type: "tool-output-available",
      toolCallId: "bash-1",
      output: {
        stdout: "pass\n",
        stderr: "",
        exitCode: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    });

    expect(canonical?.kind).toBe("tool");
    expect(live.kind).toBe("tool");
    if (canonical?.kind !== "tool" || live.kind !== "tool") {
      throw new Error("expected tool projections");
    }
    expect(live.projection).toEqual(canonical.projection);
  });

  it("accumulates Bash deltas and falls back to them for a malformed final output", () => {
    const state = createProjectionState();
    state.project({
      type: "tool-input-available",
      toolCallId: "bash-partial",
      toolName: "bash",
      input: { command: "long-task" },
    });
    state.project({
      type: "tool-output-available",
      toolCallId: "bash-partial",
      output: { type: "output-delta", delta: "first\n" },
      preliminary: true,
    });
    state.project({
      type: "tool-output-available",
      toolCallId: "bash-partial",
      output: { type: "output-delta", delta: "last\n" },
      preliminary: true,
    });

    expect(
      state.project({
        type: "tool-output-available",
        toolCallId: "bash-partial",
        output: { futureShape: true },
      }),
    ).toMatchObject({
      kind: "tool",
      projection: {
        kind: "bash",
        resultText: "first\nlast",
        outputDelta: "first\nlast\n",
      },
    });
  });

  it("ignores malformed Bash deltas, preserves partial output on error, and rejects late output", () => {
    const state = createProjectionState();
    state.project({
      type: "tool-input-available",
      toolCallId: "bash-errors",
      toolName: "bash",
      input: { command: "long-task" },
    });
    const partial = state.project({
      type: "tool-output-available",
      toolCallId: "bash-errors",
      output: { type: "output-delta", delta: "kept\n" },
      preliminary: true,
    });
    expect(partial).toMatchObject({
      kind: "tool",
      projection: { kind: "bash", outputDelta: "kept\n" },
    });
    expect(
      state.project({
        type: "tool-output-available",
        toolCallId: "bash-errors",
        output: { type: "future-delta", delta: "discarded\n" },
        preliminary: true,
      }),
    ).toEqual({ kind: "ignored" });
    expect(
      state.project({
        type: "tool-output-error",
        toolCallId: "bash-errors",
        errorText: "command failed",
      }),
    ).toMatchObject({
      kind: "tool",
      projection: {
        kind: "bash",
        outputDelta: "kept\n",
        resultText: "command failed",
        state: { status: "error" },
      },
    });
    expect(
      state.project({
        type: "tool-output-available",
        toolCallId: "bash-errors",
        output: "late success",
      }),
    ).toEqual({ kind: "ignored" });
  });

  it("maps canonical input streaming to pending and preliminary Bash output to active", () => {
    const [pending, preliminary] =
      projectInitialMessages([
        {
          id: "assistant-partials",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "bash",
              toolCallId: "bash-pending",
              state: "input-streaming",
              input: { command: "partial" },
            },
            {
              type: "dynamic-tool",
              toolName: "bash",
              toolCallId: "bash-preliminary",
              state: "output-available",
              input: { command: "run" },
              output: { type: "output-delta", delta: "working\n" },
              preliminary: true,
            },
          ],
        },
      ])[0]?.parts ?? [];

    expect(pending).toMatchObject({
      kind: "tool",
      projection: { kind: "bash", state: { status: "pending" } },
    });
    expect(preliminary).toMatchObject({
      kind: "tool",
      projection: {
        kind: "bash",
        state: { status: "active" },
        outputDelta: "working\n",
      },
    });
  });

  it("projects approval, denial, and abort as explicit tool states", () => {
    const state = createProjectionState();
    state.project({
      type: "tool-input-available",
      toolCallId: "fetch-approval",
      toolName: "webfetch",
      input: { url: "https://example.test" },
    });
    expect(
      state.project({
        type: "tool-approval-request",
        approvalId: "approval-1",
        toolCallId: "fetch-approval",
      }),
    ).toMatchObject({ kind: "tool", projection: { state: { status: "approval" } } });
    expect(
      state.project({
        type: "tool-approval-response",
        approvalId: "approval-1",
        approved: false,
      }),
    ).toMatchObject({ kind: "tool", projection: { state: { status: "denied" } } });

    state.project({
      type: "tool-input-available",
      toolCallId: "search-active",
      toolName: "websearch",
      input: { query: "runtime" },
    });
    expect(state.project({ type: "abort", reason: "stopped" })).toMatchObject({
      kind: "abort",
      cancelledTools: [
        {
          toolCallId: "search-active",
          projection: { state: { status: "cancelled", reason: "stopped" } },
        },
      ],
    });
    expect(
      state.project({
        type: "tool-output-available",
        toolCallId: "search-active",
        output: { action: { query: "late" } },
      }),
    ).toEqual({ kind: "ignored" });
  });

  it("keeps cancellation terminal for every later chunk until rollback", () => {
    const state = createProjectionState();
    state.project({
      type: "tool-input-available",
      toolCallId: "cancelled-tool",
      toolName: "webfetch",
      input: { url: "https://example.test" },
    });
    state.project({
      type: "tool-approval-request",
      toolCallId: "cancelled-tool",
      approvalId: "approval-before-cancel",
    });
    state.project({ type: "abort", reason: "stopped" });

    const lateChunks = [
      { type: "tool-input-start", toolCallId: "cancelled-tool", toolName: "webfetch" },
      {
        type: "tool-input-available",
        toolCallId: "cancelled-tool",
        toolName: "webfetch",
        input: { url: "https://late.example.test" },
      },
      {
        type: "tool-input-error",
        toolCallId: "cancelled-tool",
        toolName: "webfetch",
        input: { url: "https://late.example.test" },
        errorText: "late input error",
      },
      {
        type: "tool-approval-request",
        toolCallId: "cancelled-tool",
        approvalId: "late-approval",
      },
      {
        type: "tool-approval-response",
        approvalId: "approval-before-cancel",
        approved: true,
      },
      {
        type: "tool-output-available",
        toolCallId: "cancelled-tool",
        output: { requestedUrl: "https://example.test" },
      },
      { type: "tool-output-error", toolCallId: "cancelled-tool", errorText: "late error" },
      { type: "tool-output-denied", toolCallId: "cancelled-tool" },
    ] satisfies readonly UIMessageChunk[];
    for (const chunk of lateChunks) expect(state.project(chunk)).toEqual({ kind: "ignored" });

    projectMiniLilacStreamChunk(
      {
        type: "data-outputRollback",
        data: {
          reason: "cancel",
          reasoningIds: [],
          textIds: [],
          toolCallIds: ["cancelled-tool"],
        },
      },
      state,
    );
    expect(
      state.project({
        type: "tool-input-available",
        toolCallId: "cancelled-tool",
        toolName: "webfetch",
        input: { url: "https://example.test" },
      }),
    ).toMatchObject({ kind: "tool", projection: { kind: "webfetch" } });
    expect(
      state.project({
        type: "tool-approval-response",
        approvalId: "approval-before-cancel",
        approved: true,
      }),
    ).toEqual({ kind: "ignored" });
  });

  it("uses canonical rawInput and clears raw aggregation on rollback", () => {
    const canonical = projectInitialMessages([
      {
        id: "assistant-error",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "bash",
            toolCallId: "reused",
            state: "output-error",
            input: { command: "safe fallback" },
            rawInput: { command: 42 },
            errorText: "invalid input",
          },
        ],
      },
    ])[0]?.parts[0];
    expect(canonical).toMatchObject({
      kind: "tool",
      projection: { kind: "malformed-known-tool", malformedField: "input" },
    });

    const state = createProjectionState();
    state.project({
      type: "tool-input-available",
      toolCallId: "reused",
      toolName: "bash",
      input: { command: "old" },
    });
    projectMiniLilacStreamChunk(
      {
        type: "data-outputRollback",
        data: { reason: "cancel", reasoningIds: [], textIds: [], toolCallIds: ["reused"] },
      },
      state,
    );
    expect(
      state.project({
        type: "tool-input-available",
        toolCallId: "reused",
        toolName: "webfetch",
        input: { url: "https://example.test" },
      }),
    ).toMatchObject({
      kind: "tool",
      toolCallId: "reused",
      projection: { kind: "webfetch", toolName: "webfetch" },
    });
  });
});
