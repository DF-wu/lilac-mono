import { getToolName, isToolUIPart, type UIMessageChunk } from "ai";
import {
  miniLilacSteeringCommittedChunkSchema,
  miniLilacSteeringChunkSchema,
  miniLilacStreamCursorChunkSchema,
  miniLilacTodoChunkSchema,
  miniLilacUIMessageDataPartSchema,
  miniLilacUnsupportedUIMessageChunkSchema,
  type MiniLilacCompactionEvent,
  type MiniLilacControlResult,
  type MiniLilacOutputRollback,
  type MiniLilacSessionSnapshot,
  type MiniLilacStreamCursor,
  type MiniLilacSubagentStatus,
  type MiniLilacTodoState,
  type MiniLilacTranscriptReset,
  type MiniLilacUIMessage,
  type MiniLilacUIMessageDataPart,
  type MiniLilacUserUIMessage,
} from "@stanley2058/mini-lilac-client";

import {
  projectToolObservation,
  type ToolObservation,
  type ToolProjection,
} from "./tool-observation-projection";

type NonToolRenderedChunkType =
  | "text-start"
  | "text-delta"
  | "text-end"
  | "reasoning-start"
  | "reasoning-delta"
  | "reasoning-end"
  | "error"
  | "source-url"
  | "source-document"
  | "file"
  | "finish";

export type RenderedUIMessageChunk =
  | { readonly type: "text-start"; readonly id: string }
  | { readonly type: "text-delta"; readonly id: string; readonly delta: string }
  | { readonly type: "text-end"; readonly id: string }
  | { readonly type: "reasoning-start"; readonly id: string }
  | { readonly type: "reasoning-delta"; readonly id: string; readonly delta: string }
  | { readonly type: "reasoning-end"; readonly id: string }
  | { readonly type: "error"; readonly errorText: string }
  | { readonly type: "source-url"; readonly title?: string; readonly url: string }
  | {
      readonly type: "source-document";
      readonly title: string;
      readonly mediaType: string;
      readonly filename?: string;
    }
  | { readonly type: "file"; readonly mediaType: string }
  | { readonly type: "finish"; readonly finishReason?: string };

export type ProjectedDataChunk =
  | { readonly type: "session"; readonly snapshot: MiniLilacSessionSnapshot }
  | { readonly type: "control"; readonly result: MiniLilacControlResult }
  | { readonly type: "todos"; readonly todos: MiniLilacTodoState }
  | { readonly type: "transcript-reset"; readonly reset: MiniLilacTranscriptReset }
  | { readonly type: "output-rollback"; readonly rollback: MiniLilacOutputRollback }
  | { readonly type: "subagent-status"; readonly status: MiniLilacSubagentStatus }
  | {
      readonly type: "compaction";
      readonly id?: string;
      readonly event: MiniLilacCompactionEvent;
    };

export type ProjectedUIMessageChunk =
  | { readonly kind: "rendered"; readonly chunk: RenderedUIMessageChunk }
  | {
      readonly kind: "tool";
      readonly toolCallId: string;
      readonly projection: ToolProjection;
    }
  | {
      readonly kind: "abort";
      readonly reason?: string;
      readonly cancelledTools: readonly {
        readonly toolCallId: string;
        readonly projection: ToolProjection;
      }[];
    }
  | { readonly kind: "data"; readonly chunk: ProjectedDataChunk }
  | { readonly kind: "ignored" }
  | { readonly kind: "unsupported"; readonly chunkType: string };

type FinishUIMessageChunk = Extract<RenderedUIMessageChunk, { type: "finish" }>;

function projectRenderedChunk(
  chunk: Extract<UIMessageChunk, { type: NonToolRenderedChunkType }>,
): RenderedUIMessageChunk {
  switch (chunk.type) {
    case "text-start":
    case "text-end":
    case "reasoning-start":
    case "reasoning-end":
      return { type: chunk.type, id: chunk.id };
    case "text-delta":
    case "reasoning-delta":
      return { type: chunk.type, id: chunk.id, delta: chunk.delta };
    case "error":
      return { type: "error", errorText: chunk.errorText };
    case "source-url":
      return {
        type: "source-url",
        ...(chunk.title === undefined ? {} : { title: chunk.title }),
        url: chunk.url,
      };
    case "source-document":
      return {
        type: "source-document",
        title: chunk.title,
        mediaType: chunk.mediaType,
        ...(chunk.filename === undefined ? {} : { filename: chunk.filename }),
      };
    case "file":
      return { type: "file", mediaType: chunk.mediaType };
    case "finish":
      return {
        type: "finish",
        ...(chunk.finishReason === undefined ? {} : { finishReason: chunk.finishReason }),
      };
  }
}

export type ProjectedMiniLilacStreamChunk =
  | { readonly kind: "finish"; readonly chunk: FinishUIMessageChunk }
  | { readonly kind: "cursor"; readonly cursor: MiniLilacStreamCursor }
  | { readonly kind: "steering"; readonly message: MiniLilacUserUIMessage }
  | { readonly kind: "steering-committed"; readonly message: MiniLilacUserUIMessage }
  | { readonly kind: "renderer"; readonly chunk: ProjectedUIMessageChunk };

export type ProjectedInitialMessagePart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string; readonly finalized: boolean }
  | {
      readonly kind: "tool";
      readonly toolCallId: string;
      readonly projection: ToolProjection;
    }
  | { readonly kind: "data"; readonly chunk: ProjectedDataChunk }
  | { readonly kind: "file"; readonly mediaType: string; readonly filename?: string }
  | {
      readonly kind: "source-url";
      readonly title?: string;
      readonly url: string;
    }
  | {
      readonly kind: "source-document";
      readonly title: string;
      readonly mediaType: string;
      readonly filename?: string;
    }
  | { readonly kind: "ignored" };

export interface ProjectedInitialMessage {
  readonly id: string;
  readonly role: "system" | "user" | "assistant";
  readonly parts: readonly ProjectedInitialMessagePart[];
}

interface RawToolState {
  readonly toolName: string;
  input: unknown;
  bashOutput: string;
  active: boolean;
}

function projectCanonicalDataChunk(part: MiniLilacUIMessageDataPart): ProjectedDataChunk {
  switch (part.type) {
    case "data-session":
      return { type: "session", snapshot: part.data };
    case "data-control":
      return { type: "control", result: part.data };
    case "data-transcriptReset":
      return { type: "transcript-reset", reset: part.data };
    case "data-outputRollback":
      return { type: "output-rollback", rollback: part.data };
    case "data-subagentStatus":
      return { type: "subagent-status", status: part.data };
    case "data-compaction":
      return {
        type: "compaction",
        ...(part.id === undefined ? {} : { id: part.id }),
        event: part.data,
      };
  }
}

function observationFromCanonicalPart(
  toolName: string,
  part: Extract<MiniLilacUIMessage["parts"][number], { toolCallId: string }>,
): ToolObservation {
  switch (part.state) {
    case "input-streaming":
      return { toolName, lifecycle: "pending" };
    case "input-available":
      return { toolName, lifecycle: "active", input: part.input };
    case "approval-requested":
      return { toolName, lifecycle: "approval", input: part.input };
    case "approval-responded":
      return part.approval.approved
        ? { toolName, lifecycle: "active", input: part.input }
        : { toolName, lifecycle: "denied", input: part.input };
    case "output-available":
      return part.preliminary === true
        ? { toolName, lifecycle: "active", input: part.input, partial: part.output }
        : { toolName, lifecycle: "success", input: part.input, output: part.output };
    case "output-error":
      return {
        toolName,
        lifecycle: "error",
        input: part.rawInput === undefined ? part.input : part.rawInput,
        errorText: part.errorText,
      };
    case "output-denied":
      return { toolName, lifecycle: "denied", input: part.input };
  }
}

/** Adapt canonical SDK messages before they enter transcript rendering. */
export function projectInitialMessages(
  messages: readonly MiniLilacUIMessage[],
  options: { readonly cwd?: string } = {},
): readonly ProjectedInitialMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    parts: message.parts.map((part): ProjectedInitialMessagePart => {
      if (part.type === "text") return { kind: "text", text: part.text };
      if (part.type === "reasoning") {
        return { kind: "reasoning", text: part.text, finalized: part.state !== "streaming" };
      }
      if (isToolUIPart(part)) {
        return {
          kind: "tool",
          toolCallId: part.toolCallId,
          projection: projectToolObservation(
            observationFromCanonicalPart(getToolName(part), part),
            options,
          ),
        };
      }
      switch (part.type) {
        case "data-session":
        case "data-control":
        case "data-transcriptReset":
        case "data-outputRollback":
        case "data-subagentStatus":
        case "data-compaction":
          return { kind: "data", chunk: projectCanonicalDataChunk(part) };
        case "file":
          return {
            kind: "file",
            mediaType: part.mediaType,
            ...(part.filename === undefined ? {} : { filename: part.filename }),
          };
        case "source-url":
          return {
            kind: "source-url",
            ...(part.title === undefined ? {} : { title: part.title }),
            url: part.url,
          };
        case "source-document":
          return {
            kind: "source-document",
            title: part.title,
            mediaType: part.mediaType,
            ...(part.filename === undefined ? {} : { filename: part.filename }),
          };
        case "reasoning-file":
        case "custom":
        case "step-start":
          return { kind: "ignored" };
      }
      return { kind: "ignored" };
    }),
  }));
}

/** Owns open SDK tool state and emits only closed render-ready projections. */
export class UIMessageChunkProjectionState {
  private readonly tools = new Map<string, RawToolState>();
  private readonly approvalToolIds = new Map<string, string>();

  constructor(private readonly options: { readonly cwd?: string } = {}) {}

  reset(): void {
    this.tools.clear();
    this.approvalToolIds.clear();
  }

  project(chunk: UIMessageChunk): ProjectedUIMessageChunk {
    return projectUIMessageChunk(chunk, this);
  }

  projectToolStart(toolCallId: string, toolName: string): ProjectedUIMessageChunk {
    const existing = this.tools.get(toolCallId);
    if (existing !== undefined && !existing.active) return { kind: "ignored" };
    this.tools.set(toolCallId, {
      toolName,
      input: undefined,
      bashOutput: "",
      active: true,
    });
    return this.toolChunk(toolCallId, { toolName, lifecycle: "pending" });
  }

  projectToolInput<T>(toolCallId: string, toolName: string, input: T): ProjectedUIMessageChunk {
    const state = this.ensureTool(toolCallId, toolName);
    if (!state.active) return { kind: "ignored" };
    state.input = input;
    return this.toolChunk(toolCallId, {
      toolName: state.toolName,
      lifecycle: "active",
      input: state.input,
    });
  }

  projectToolInputError<T>(
    toolCallId: string,
    toolName: string,
    input: T,
    errorText: string,
  ): ProjectedUIMessageChunk {
    const state = this.ensureTool(toolCallId, toolName);
    if (!state.active) return { kind: "ignored" };
    state.input = input;
    state.active = false;
    return this.toolChunk(toolCallId, {
      toolName: state.toolName,
      lifecycle: "error",
      input: state.input,
      errorText,
    });
  }

  projectToolError(toolCallId: string, errorText: string): ProjectedUIMessageChunk {
    const state = this.ensureTool(toolCallId);
    if (!state.active) return { kind: "ignored" };
    state.active = false;
    return this.toolChunk(toolCallId, {
      toolName: state.toolName,
      lifecycle: "error",
      input: state.input,
      errorText,
      ...(state.bashOutput.length === 0
        ? {}
        : { partial: { type: "output-delta", delta: state.bashOutput } }),
    });
  }

  projectToolDenied(toolCallId: string): ProjectedUIMessageChunk {
    const state = this.ensureTool(toolCallId);
    if (!state.active) return { kind: "ignored" };
    state.active = false;
    return this.toolChunk(toolCallId, {
      toolName: state.toolName,
      lifecycle: "denied",
      input: state.input,
    });
  }

  projectToolApproval(toolCallId: string, approvalId: string): ProjectedUIMessageChunk {
    const state = this.ensureTool(toolCallId);
    if (!state.active) return { kind: "ignored" };
    this.approvalToolIds.set(approvalId, toolCallId);
    return this.toolChunk(toolCallId, {
      toolName: state.toolName,
      lifecycle: "approval",
      input: state.input,
    });
  }

  projectToolApprovalResponse(approvalId: string, approved: boolean): ProjectedUIMessageChunk {
    const state = this.findToolByApproval(approvalId);
    if (state === undefined || !state.tool.active) return { kind: "ignored" };
    state.tool.active = approved;
    return this.toolChunk(
      state.toolCallId,
      approved
        ? { toolName: state.tool.toolName, lifecycle: "active", input: state.tool.input }
        : { toolName: state.tool.toolName, lifecycle: "denied", input: state.tool.input },
    );
  }

  projectAbort(reason: string | undefined): ProjectedUIMessageChunk {
    const activeTools = [...this.tools.entries()].filter(([, state]) => state.active);
    const cancelledTools = activeTools.map(([toolCallId, state]) => ({
      toolCallId,
      projection: projectToolObservation(
        {
          toolName: state.toolName,
          lifecycle: "cancelled",
          input: state.input,
          ...(reason === undefined ? {} : { reason }),
          ...(state.bashOutput.length === 0
            ? {}
            : { partial: { type: "output-delta" as const, delta: state.bashOutput } }),
        },
        this.options,
      ),
    }));
    for (const [, state] of activeTools) state.active = false;
    return {
      kind: "abort",
      ...(reason === undefined ? {} : { reason }),
      cancelledTools,
    };
  }

  rollbackTools(toolCallIds: readonly string[]): void {
    const rolledBack = new Set(toolCallIds);
    for (const toolCallId of rolledBack) this.tools.delete(toolCallId);
    for (const [approvalId, toolCallId] of this.approvalToolIds) {
      if (rolledBack.has(toolCallId)) this.approvalToolIds.delete(approvalId);
    }
  }

  private ensureTool(toolCallId: string, toolName = "tool"): RawToolState {
    const existing = this.tools.get(toolCallId);
    if (existing !== undefined) return existing;
    const state = { toolName, input: undefined, bashOutput: "", active: true };
    this.tools.set(toolCallId, state);
    return state;
  }

  projectToolOutput<T>(
    toolCallId: string,
    output: T,
    preliminary: boolean,
  ): ProjectedUIMessageChunk {
    const state = this.ensureTool(toolCallId);
    if (!state.active) return { kind: "ignored" };
    if (preliminary) {
      if (state.toolName !== "bash") return { kind: "ignored" };
      const deltaProjection = this.toolChunk(toolCallId, {
        toolName: state.toolName,
        lifecycle: "active",
        input: state.input,
        partial: output,
      });
      if (deltaProjection.kind !== "tool" || deltaProjection.projection.kind !== "bash") {
        return { kind: "ignored" };
      }
      const delta = deltaProjection.projection.outputDelta;
      if (delta === undefined) return deltaProjection;
      state.bashOutput += delta;
      return this.toolChunk(toolCallId, {
        toolName: state.toolName,
        lifecycle: "active",
        input: state.input,
        partial: { type: "output-delta", delta: state.bashOutput },
      });
    }
    const projected = this.toolChunk(toolCallId, {
      toolName: state.toolName,
      lifecycle: "success",
      input: state.input,
      output,
      ...(state.bashOutput.length === 0
        ? {}
        : { partial: { type: "output-delta", delta: state.bashOutput } }),
    });
    state.active = projected.kind === "tool" && projected.projection.running;
    return projected;
  }

  private toolChunk(toolCallId: string, observation: ToolObservation): ProjectedUIMessageChunk {
    return {
      kind: "tool",
      toolCallId,
      projection: projectToolObservation(observation, this.options),
    };
  }

  private findToolByApproval(
    approvalId: string,
  ): { readonly toolCallId: string; readonly tool: RawToolState } | undefined {
    const toolCallId = this.approvalToolIds.get(approvalId);
    if (toolCallId === undefined) return undefined;
    const tool = this.tools.get(toolCallId);
    return tool === undefined ? undefined : { toolCallId, tool };
  }
}

/** Project the open AI SDK protocol into the TUI's closed render vocabulary. */
export function projectUIMessageChunk(
  chunk: UIMessageChunk,
  state: UIMessageChunkProjectionState = new UIMessageChunkProjectionState(),
): ProjectedUIMessageChunk {
  const chunkType: string = chunk.type;
  if (chunk.type.startsWith("data-")) return { kind: "ignored" };
  switch (chunk.type) {
    case "text-start":
    case "text-delta":
    case "text-end":
    case "reasoning-start":
    case "reasoning-delta":
    case "reasoning-end":
    case "error":
    case "source-url":
    case "source-document":
    case "file":
    case "finish":
      return { kind: "rendered", chunk: projectRenderedChunk(chunk) };
    case "tool-input-start":
      return state.projectToolStart(chunk.toolCallId, chunk.toolName);
    case "tool-input-available":
      return state.projectToolInput(chunk.toolCallId, chunk.toolName, chunk.input);
    case "tool-input-error":
      return state.projectToolInputError(
        chunk.toolCallId,
        chunk.toolName,
        chunk.input,
        chunk.errorText,
      );
    case "tool-output-available":
      return state.projectToolOutput(chunk.toolCallId, chunk.output, chunk.preliminary === true);
    case "tool-output-error":
      return state.projectToolError(chunk.toolCallId, chunk.errorText);
    case "tool-output-denied":
      return state.projectToolDenied(chunk.toolCallId);
    case "tool-approval-request":
      return state.projectToolApproval(chunk.toolCallId, chunk.approvalId);
    case "tool-approval-response":
      return state.projectToolApprovalResponse(chunk.approvalId, chunk.approved);
    case "abort":
      return state.projectAbort(chunk.reason);
    case "custom":
    case "tool-input-delta":
    case "reasoning-file":
    case "start-step":
    case "finish-step":
    case "start":
    case "message-metadata":
      return { kind: "ignored" };
  }
  return { kind: "unsupported", chunkType };
}

/** Project a validated transport result into controller control and renderer events. */
export function projectMiniLilacStreamChunk(
  wireChunk: UIMessageChunk,
  state: UIMessageChunkProjectionState = new UIMessageChunkProjectionState(),
): ProjectedMiniLilacStreamChunk {
  const unsupported = miniLilacUnsupportedUIMessageChunkSchema.safeParse(wireChunk);
  if (unsupported.success) {
    return {
      kind: "renderer",
      chunk: { kind: "unsupported", chunkType: unsupported.data.data.chunkType },
    };
  }
  const cursor = miniLilacStreamCursorChunkSchema.safeParse(wireChunk);
  if (cursor.success) return { kind: "cursor", cursor: cursor.data.data };
  const steering = miniLilacSteeringChunkSchema.safeParse(wireChunk);
  if (steering.success) return { kind: "steering", message: steering.data.data };
  const committed = miniLilacSteeringCommittedChunkSchema.safeParse(wireChunk);
  if (committed.success) {
    return { kind: "steering-committed", message: committed.data.data };
  }
  const todos = miniLilacTodoChunkSchema.safeParse(wireChunk);
  if (todos.success) {
    return {
      kind: "renderer",
      chunk: { kind: "data", chunk: { type: "todos", todos: todos.data.data } },
    };
  }
  const data = miniLilacUIMessageDataPartSchema.safeParse(wireChunk);
  if (data.success) {
    const chunk = projectCanonicalDataChunk(data.data);
    if (chunk.type === "output-rollback") state.rollbackTools(chunk.rollback.toolCallIds);
    return { kind: "renderer", chunk: { kind: "data", chunk } };
  }
  const projected = state.project(wireChunk);
  if (projected.kind === "rendered" && projected.chunk.type === "finish") {
    return { kind: "finish", chunk: projected.chunk };
  }
  return { kind: "renderer", chunk: projected };
}
