import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
  catalogIdentifierSchema,
  displayMessageSchema,
  mcpReloadReplySchema,
  nativeInputSchema,
  nativeThreadSchema,
  replayReplySchema,
  threadEventSchema,
  turnPageSchema,
} from "../src/index.ts";

const checkpoint = {
  protocolVersion: 1 as const,
  historyGeneration: 0,
  projectionRevision: 2,
  cursor: "cursor",
};
const input = {
  threadId: "thread",
  commandId: "command",
  historyGeneration: 0,
  text: "Hello",
  mode: "prompt" as const,
  attachmentIds: [],
  skillIds: [],
};

describe("native display and command contracts", () => {
  test("pending file inputs are valid without a resource URI and duplicates are rejected", () => {
    expect(
      nativeInputSchema.safeParse({ ...input, text: "", attachmentIds: ["upload"] }).success,
    ).toBe(true);
    expect(nativeInputSchema.safeParse({ ...input, text: "" }).success).toBe(false);
    expect(
      nativeInputSchema.safeParse({ ...input, attachmentIds: ["upload", "upload"] }).success,
    ).toBe(false);
    expect(nativeInputSchema.safeParse({ ...input, authority: "owner" }).success).toBe(false);
    expect(
      nativeInputSchema.safeParse({
        ...input,
        skillIds: ["personal/review:ts"],
        modelId: "openai/gpt-custom",
      }).success,
    ).toBe(true);
    expect(catalogIdentifierSchema.safeParse("Code review / owner").success).toBe(true);
  });

  test("UIMessage projection permits only visible activity, resources, compaction and input state", () => {
    const parsed = displayMessageSchema.parse({
      id: "message",
      role: "assistant",
      metadata: { createdAt: 1, phase: "commentary" },
      parts: [
        { type: "text", text: "Checking" },
        {
          type: "data-activity",
          id: "activity",
          data: { kind: "tool", label: "Read file", state: "running" },
        },
        {
          type: "data-resource",
          id: "upload",
          data: {
            resourceId: "upload",
            name: "image.png",
            mediaType: "image/png",
            size: 200,
            state: "pending",
            progress: 0.5,
          },
        },
        {
          type: "data-compaction",
          id: "compaction",
          data: { state: "complete", beforeCount: 100, afterCount: 10 },
        },
        { type: "data-input-state", id: "input", data: { state: "target-ended" } },
      ],
    });
    const message: UIMessage = parsed;
    expect(message.parts).toHaveLength(5);
    expect(displayMessageSchema.safeParse({ ...parsed, providerPrompt: "private" }).success).toBe(
      false,
    );
    expect(
      displayMessageSchema.safeParse({ ...parsed, parts: [{ type: "reasoning", text: "private" }] })
        .success,
    ).toBe(false);
  });

  test("incremental replay requires a advancing base and bounded changes", () => {
    const delta = {
      kind: "delta",
      checkpoint,
      fromRevision: 1,
      changes: [
        {
          kind: "append-text",
          turnId: "turn",
          position: 0,
          messageId: "message",
          partIndex: 0,
          text: " next",
        },
      ],
    };
    expect(replayReplySchema.safeParse(delta).success).toBe(true);
    expect(replayReplySchema.safeParse({ ...delta, fromRevision: 2 }).success).toBe(false);
    expect(replayReplySchema.safeParse({ ...delta, changes: [] }).success).toBe(true);
    expect(
      replayReplySchema.safeParse({ ...delta, threadId: "duplicate-stable-metadata" }).success,
    ).toBe(false);
    expect(threadEventSchema.safeParse({ kind: "replay", reply: delta }).success).toBe(true);
  });

  test("huge-turn pages bound encoded Unicode bytes, not only character count", () => {
    const page = {
      turnId: "turn",
      historyGeneration: 0,
      projectionRevision: 1,
      messages: [{ id: "message", role: "assistant", parts: [{ type: "text", text: "x" }] }],
      nextCursor: "next",
    };
    expect(turnPageSchema.safeParse(page).success).toBe(true);
    const large = {
      ...page,
      messages: [
        {
          id: "message",
          role: "assistant",
          parts: Array.from({ length: 4 }, () => ({ type: "text", text: "界".repeat(32_768) })),
        },
      ],
    };
    expect(turnPageSchema.safeParse(large).success).toBe(false);
  });

  test("capability displays do not expose principal policies or MCP secrets", () => {
    const thread = {
      id: "thread",
      title: "Chat",
      starterId: "owner",
      archived: false,
      updatedAt: 0,
      revision: 1,
      capabilities: { read: true, edit: true, share: true },
    };
    expect(nativeThreadSchema.safeParse(thread).success).toBe(true);
    expect(nativeThreadSchema.safeParse({ ...thread, systemPrompt: "private" }).success).toBe(
      false,
    );
    expect(
      mcpReloadReplySchema.safeParse({
        servers: [{ name: "test", state: "authentication_required", reconciliation: "changed" }],
      }).success,
    ).toBe(true);
    expect(
      mcpReloadReplySchema.safeParse({
        servers: [{ name: "test", state: "available", token: "private" }],
      }).success,
    ).toBe(false);
  });
});

test("native thread controls distinguish pending inputs from real colon-delimited run identities", () => {
  const thread = {
    id: "thread",
    title: "Chat",
    starterId: "owner",
    archived: false,
    updatedAt: 0,
    revision: 1,
    capabilities: { read: true, edit: true, share: true },
  };
  expect(nativeThreadSchema.parse(thread).activeRunId).toBeUndefined();
  expect(
    nativeThreadSchema.parse({ ...thread, activeRunId: "native:thread:message" }).activeRunId,
  ).toBe("native:thread:message");
  expect(nativeThreadSchema.safeParse({ ...thread, id: "native:thread" }).success).toBe(false);
  expect(
    threadEventSchema.safeParse({
      kind: "input",
      receipt: {
        inputId: "input",
        messageId: "message",
        turnId: "turn",
        state: "queued",
        runId: "native:thread:message",
      },
    }).success,
  ).toBe(true);
  expect(
    replayReplySchema.safeParse({
      kind: "delta",
      checkpoint,
      fromRevision: 1,
      changes: [
        {
          kind: "turn-state",
          turnId: "turn",
          position: 0,
          state: "running",
          runId: "native:thread:message",
        },
      ],
    }).success,
  ).toBe(true);
});
