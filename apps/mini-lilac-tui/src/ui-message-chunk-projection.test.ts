import { describe, expect, it } from "bun:test";

import type { UIMessageChunk } from "ai";

import { MINI_LILAC_UNSUPPORTED_UI_MESSAGE_CHUNK_TYPE } from "@stanley2058/mini-lilac-client";

import { projectMiniLilacStreamChunk, projectUIMessageChunk } from "./ui-message-chunk-projection";

describe("projectUIMessageChunk", () => {
  it("projects every renderer-owned AI SDK chunk and preserves its envelope", () => {
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
      inputChunk,
      {
        type: "tool-input-error",
        toolCallId: "tool-input-error",
        toolName: "bash",
        input,
        errorText: "invalid",
      },
      outputChunk,
      { type: "tool-output-error", toolCallId: "tool-output-error", errorText: "failed" },
      { type: "tool-output-denied", toolCallId: "tool-output-denied" },
      { type: "tool-input-start", toolCallId: "tool-start", toolName: "bash" },
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
      { type: "abort", reason: "cancelled" },
    ] satisfies readonly UIMessageChunk[];

    for (const chunk of chunks) {
      const projected = projectUIMessageChunk(chunk);
      expect(projected.kind).toBe("rendered");
      if (projected.kind !== "rendered") throw new Error("expected rendered projection");
      expect(projected.chunk).toBe(chunk);
    }

    const projectedInput = projectUIMessageChunk(inputChunk);
    const projectedOutput = projectUIMessageChunk(outputChunk);
    if (
      projectedInput.kind !== "rendered" ||
      projectedInput.chunk.type !== "tool-input-available"
    ) {
      throw new Error("expected rendered tool input projection");
    }
    if (
      projectedOutput.kind !== "rendered" ||
      projectedOutput.chunk.type !== "tool-output-available"
    ) {
      throw new Error("expected rendered tool output projection");
    }
    expect(projectedInput.chunk.input).toBe(input);
    expect(projectedOutput.chunk.output).toBe(output);
  });

  it("projects every intentionally ignored known chunk and preserves its envelope", () => {
    const chunks = [
      { type: "custom", kind: "provider.event" },
      { type: "tool-approval-request", approvalId: "approval", toolCallId: "tool" },
      { type: "tool-approval-response", approvalId: "approval", approved: true },
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
      expect(projected.chunk).toBe(chunk);
    }
  });

  it("keeps arbitrary data chunks in their open data category", () => {
    const chunk = {
      type: "data-futureExtension",
      id: "future-data",
      data: { nested: true },
      transient: true,
    } satisfies UIMessageChunk;

    const projected = projectUIMessageChunk(chunk);

    expect(projected).toEqual({ kind: "data", chunk });
    if (projected.kind !== "data") throw new Error("expected data projection");
    expect(projected.chunk).toBe(chunk);
    expect(projected.chunk.data).toBe(chunk.data);
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
