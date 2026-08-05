import type { UIMessageChunk } from "ai";

import type { MiniLilacUIMessage } from "@stanley2058/mini-lilac-client";

import {
  ChunkRenderer as ProjectedChunkRenderer,
  renderInitialMessages as renderProjectedInitialMessages,
  type ChunkOutputSink,
  type ChunkRendererHooks,
  type TranscriptEntry,
  type TranscriptRenderOptions,
} from "./render";
import {
  projectMiniLilacStreamChunk,
  projectInitialMessages,
  UIMessageChunkProjectionState,
} from "./ui-message-chunk-projection";

/** SDK-facing facade; render.ts itself receives only closed projections. */
export class ChunkRenderer extends ProjectedChunkRenderer {
  private readonly projectionState: UIMessageChunkProjectionState;

  constructor(
    output: ChunkOutputSink,
    hooks: ChunkRendererHooks,
    options: TranscriptRenderOptions = {},
  ) {
    super(output, hooks, options);
    this.projectionState = new UIMessageChunkProjectionState(options);
  }

  handle(chunk: UIMessageChunk): void {
    const projected = projectMiniLilacStreamChunk(chunk, this.projectionState);
    switch (projected.kind) {
      case "finish":
        this.handleProjected({ kind: "rendered", chunk: projected.chunk });
        return;
      case "renderer":
        this.handleProjected(projected.chunk);
        return;
      case "cursor":
      case "steering":
      case "steering-committed":
        return;
    }
  }

  override startRun(): void {
    this.projectionState.reset();
    super.startRun();
  }
}

export function renderInitialMessages(
  messages: readonly MiniLilacUIMessage[],
  options: TranscriptRenderOptions = {},
): TranscriptEntry[] {
  return renderProjectedInitialMessages(projectInitialMessages(messages, options));
}
