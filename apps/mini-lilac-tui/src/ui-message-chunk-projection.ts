import type { UIMessageChunk } from "ai";

import {
  miniLilacSteeringCommittedChunkSchema,
  miniLilacSteeringChunkSchema,
  miniLilacStreamCursorChunkSchema,
  miniLilacUnsupportedUIMessageChunkSchema,
  type MiniLilacStreamCursor,
  type MiniLilacUserUIMessage,
} from "@stanley2058/mini-lilac-client";

type NonDataUIMessageChunk = Exclude<UIMessageChunk, { type: `data-${string}` }>;

type RenderedUIMessageChunkType =
  | "text-start"
  | "text-delta"
  | "text-end"
  | "reasoning-start"
  | "reasoning-delta"
  | "reasoning-end"
  | "error"
  | "tool-input-available"
  | "tool-input-error"
  | "tool-output-available"
  | "tool-output-error"
  | "tool-output-denied"
  | "tool-input-start"
  | "source-url"
  | "source-document"
  | "file"
  | "finish"
  | "abort";

type IgnoredUIMessageChunkType =
  | "custom"
  | "tool-approval-request"
  | "tool-approval-response"
  | "tool-input-delta"
  | "reasoning-file"
  | "start-step"
  | "finish-step"
  | "start"
  | "message-metadata";

export type RenderedUIMessageChunk = Extract<
  NonDataUIMessageChunk,
  { type: RenderedUIMessageChunkType }
>;

export type DataUIMessageChunk = Extract<UIMessageChunk, { type: `data-${string}` }>;

export type IgnoredUIMessageChunk = Extract<
  NonDataUIMessageChunk,
  { type: IgnoredUIMessageChunkType }
>;

export type ProjectedUIMessageChunk =
  | { readonly kind: "rendered"; readonly chunk: RenderedUIMessageChunk }
  | { readonly kind: "data"; readonly chunk: DataUIMessageChunk }
  | { readonly kind: "ignored"; readonly chunk: IgnoredUIMessageChunk }
  | { readonly kind: "unsupported"; readonly chunkType: string };

type FinishUIMessageChunk = Extract<RenderedUIMessageChunk, { type: "finish" }>;

export type ProjectedMiniLilacStreamChunk =
  | { readonly kind: "finish"; readonly chunk: FinishUIMessageChunk }
  | { readonly kind: "cursor"; readonly cursor: MiniLilacStreamCursor }
  | { readonly kind: "steering"; readonly message: MiniLilacUserUIMessage }
  | { readonly kind: "steering-committed"; readonly message: MiniLilacUserUIMessage }
  | { readonly kind: "renderer"; readonly chunk: ProjectedUIMessageChunk };

function isDataUIMessageChunk(chunk: UIMessageChunk): chunk is DataUIMessageChunk {
  return chunk.type.startsWith("data-");
}

/** Project the open AI SDK stream envelope into the TUI's closed chunk vocabulary. */
export function projectUIMessageChunk(chunk: UIMessageChunk): ProjectedUIMessageChunk {
  const chunkType: string = chunk.type;
  if (isDataUIMessageChunk(chunk)) return { kind: "data", chunk };

  switch (chunk.type) {
    case "text-start":
    case "text-delta":
    case "text-end":
    case "reasoning-start":
    case "reasoning-delta":
    case "reasoning-end":
    case "error":
    case "tool-input-available":
    case "tool-input-error":
    case "tool-output-available":
    case "tool-output-error":
    case "tool-output-denied":
    case "tool-input-start":
    case "source-url":
    case "source-document":
    case "file":
    case "finish":
    case "abort":
      return { kind: "rendered", chunk };
    case "custom":
    case "tool-approval-request":
    case "tool-approval-response":
    case "tool-input-delta":
    case "reasoning-file":
    case "start-step":
    case "finish-step":
    case "start":
    case "message-metadata":
      return { kind: "ignored", chunk };
  }

  // The installed SDK cannot express this path, but a newer stream peer can.
  return { kind: "unsupported", chunkType };
}

/** Project a validated transport result into controller control and renderer events. */
export function projectMiniLilacStreamChunk(
  wireChunk: UIMessageChunk,
): ProjectedMiniLilacStreamChunk {
  const unsupported = miniLilacUnsupportedUIMessageChunkSchema.safeParse(wireChunk);
  if (unsupported.success) {
    return {
      kind: "renderer",
      chunk: { kind: "unsupported", chunkType: unsupported.data.data.chunkType },
    };
  }

  const chunk = wireChunk;
  const cursor = miniLilacStreamCursorChunkSchema.safeParse(chunk);
  if (cursor.success) return { kind: "cursor", cursor: cursor.data.data };

  const steering = miniLilacSteeringChunkSchema.safeParse(chunk);
  if (steering.success) return { kind: "steering", message: steering.data.data };

  const committed = miniLilacSteeringCommittedChunkSchema.safeParse(chunk);
  if (committed.success) {
    return { kind: "steering-committed", message: committed.data.data };
  }

  const projected = projectUIMessageChunk(chunk);
  if (projected.kind === "rendered" && projected.chunk.type === "finish") {
    return { kind: "finish", chunk: projected.chunk };
  }
  return { kind: "renderer", chunk: projected };
}
