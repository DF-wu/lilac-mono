import { parseReasoningSummary } from "@stanley2058/lilac-utils/reasoning-summary";

import type {
  MiniLilacCompactionEvent,
  MiniLilacControlResult,
  MiniLilacOutputRollback,
  MiniLilacSessionSnapshot,
  MiniLilacSubagentStatus,
  MiniLilacTodoState,
  MiniLilacTranscriptReset,
} from "@stanley2058/mini-lilac-client";

import type { ToolProjection, ToolProjectionState } from "./tool-observation-projection";
import type {
  ProjectedDataChunk,
  ProjectedInitialMessage,
  ProjectedUIMessageChunk,
  RenderedUIMessageChunk,
} from "./ui-message-chunk-projection";

type TranscriptKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool"
  | "shell"
  | "exploration"
  | "edit"
  | "file"
  | "source"
  | "status"
  | "subagent"
  | "compaction"
  | "error";

export type TranscriptTone = "normal" | "muted" | "accent" | "success" | "warning" | "danger";

export interface TranscriptEntry {
  readonly id: string;
  readonly kind: TranscriptKind;
  readonly tone: TranscriptTone;
  readonly text: string;
  readonly singleLine?: boolean;
  readonly streaming?: boolean;
  readonly running?: boolean;
  readonly shell?: ShellTranscript;
  readonly exploration?: ExplorationTranscript;
  readonly edit?: EditTranscript;
  readonly subagent?: SubagentTranscript;
}

export interface SubagentTranscript {
  readonly toolCallId: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly sessionName?: string;
  readonly profile: string;
  readonly prompt: string;
  readonly mode: "sync" | "deferred";
  readonly state:
    | "pending"
    | "running"
    | "completed"
    | "cancelled"
    | "denied"
    | "error"
    | "rejected";
  readonly toolCount: number;
  readonly activity?: string;
  readonly text?: string;
  readonly error?: string;
}

export interface ShellTranscript {
  readonly command: string;
  readonly cwd?: string;
  readonly output?: string;
}

interface ShellTranscriptPreview {
  readonly command: string;
  readonly output?: string;
}

export interface ExplorationOperation {
  readonly action: "Read" | "Grep" | "Glob" | "Find";
  readonly detail: string;
  readonly status: "pending" | "success" | "error" | "denied" | "cancelled";
  readonly error?: string;
}

export interface ExplorationTranscript {
  readonly reads: number;
  readonly searches: number;
  readonly failures: number;
  readonly cancellations?: number;
  readonly operations: readonly ExplorationOperation[];
}

export interface EditOperation {
  readonly action: "Patch" | "Edit";
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  readonly tone: TranscriptTone;
  readonly detail?: string;
}

export interface EditTranscript {
  readonly operations: readonly EditOperation[];
}

export interface TranscriptRenderOptions {
  readonly cwd?: string;
}

export interface ChunkOutputSink {
  append(entry: Omit<TranscriptEntry, "id">): string;
  update(id: string, entry: Omit<TranscriptEntry, "id">): void;
  remove(id: string): void;
  appendText(id: string, delta: string): void;
  finish(id: string): void;
}

export interface ChunkRendererHooks {
  onSnapshot(snapshot: MiniLilacSessionSnapshot): void;
  onControl?(result: MiniLilacControlResult): void;
  onTodos?(todos: MiniLilacTodoState): void;
  onTranscriptReset(reset: MiniLilacTranscriptReset): void;
  onOutputRollback?(rollback: MiniLilacOutputRollback): void;
}

type ExplorationState = {
  id: string;
  reads: number;
  searches: number;
  failures: number;
  errors: number;
  cancellations: number;
  operations: ExplorationOperation[];
  toolCallIds: string[];
  pending: Set<string>;
};

const DEFAULT_SHELL_OUTPUT_LINES = 8;
const DEFAULT_SHELL_OUTPUT_CHARACTERS = 2_000;

function previewText(value: string, max = 120): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 3)}...` : singleLine;
}

function controlSummary(result: MiniLilacControlResult): string {
  switch (result.status) {
    case "queued":
      return `steer queued (${result.steeringId})`;
    case "interrupted":
      return `queued steering interrupted (${result.steeringIds.length})`;
    case "empty":
      return "no queued steering to interrupt";
    case "inactive":
      return "no active run";
    case "cancelled":
      return "run cancelled";
  }
}

function subagentTone(state: SubagentTranscript["state"]): TranscriptTone {
  switch (state) {
    case "pending":
    case "running":
      return "accent";
    case "completed":
      return "success";
    case "cancelled":
      return "muted";
    case "denied":
      return "warning";
    case "error":
    case "rejected":
      return "danger";
  }
}

function humanizeToolName(name: string): string {
  return name
    .split(/[_-]+/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function subagentEntry(subagent: SubagentTranscript): Omit<TranscriptEntry, "id"> {
  const running = subagent.state === "pending" || subagent.state === "running";
  const profile = humanizeToolName(subagent.profile);
  const background = subagent.mode === "deferred" ? " (background)" : "";
  const session = subagent.sessionName === undefined ? "" : ` [${subagent.sessionName}]`;
  const lines = [`${profile} Task${session}${background} - ${previewText(subagent.prompt, 160)}`];
  if (running && subagent.activity !== undefined) {
    lines.push(
      `  ↳ ${humanizeToolName(subagent.activity)}${subagent.toolCount > 1 ? ` · ${subagent.toolCount} tool calls` : ""}`,
    );
  } else if (subagent.error !== undefined) {
    lines.push(`  ↳ ${previewText(subagent.error, 180)}`);
  } else if (subagent.toolCount > 0) {
    lines.push(`  ↳ ${subagent.toolCount} tool call${subagent.toolCount === 1 ? "" : "s"}`);
  }
  if (subagent.sessionId !== undefined && lines.length === 1) {
    lines.push("  ↳ Click to view transcript");
  }
  return {
    kind: "subagent",
    tone: subagentTone(subagent.state),
    text: lines.join("\n"),
    ...(running ? { running: true } : {}),
    subagent,
  };
}

function compactTokenCount(tokens: number | undefined): string | undefined {
  if (tokens === undefined) return undefined;
  if (tokens < 1_000) return String(tokens);
  const divisor = tokens < 1_000_000 ? 1_000 : 1_000_000;
  const suffix = divisor === 1_000 ? "K" : "M";
  return `${Math.round((tokens / divisor) * 10) / 10}${suffix}`;
}

function formatCompactionDuration(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function compactionHeadline(event: MiniLilacCompactionEvent): string {
  const elapsed = formatCompactionDuration(event.durationMs ?? event.elapsedMs);
  switch (event.phase) {
    case "started":
    case "progress": {
      const progress = event.progress;
      const step =
        progress === undefined || progress.stepCount <= 1
          ? "summarizing"
          : `summarizing ${progress.step}/${progress.stepCount}`;
      const pass = progress !== undefined && progress.pass > 1 ? ` · pass ${progress.pass}` : "";
      return ["Compacting context", step + pass, elapsed].filter(Boolean).join(" · ");
    }
    case "cancelled":
      return "Compaction cancelled · transcript unchanged";
    case "failed":
      return `Compaction failed${event.error ? `: ${event.error}` : ""} · transcript unchanged`;
    case "completed":
      break;
  }
  if (event.outcome !== undefined && event.outcome !== "compacted") {
    return "Nothing to compact · transcript already minimal";
  }
  const before = compactTokenCount(event.estimatedInputTokensBefore);
  const after = compactTokenCount(event.estimatedInputTokensAfter);
  const parts = ["Context compacted"];
  if (event.messageCountAfter !== undefined) {
    parts.push(`${event.messageCountBefore} → ${event.messageCountAfter} msgs`);
  }
  if (before !== undefined && after !== undefined) parts.push(`${before} → ${after}`);
  if (elapsed !== undefined) parts.push(elapsed);
  if (event.modelCalls !== undefined && event.modelCalls > 0) {
    parts.push(`${event.modelCalls} ${event.modelCalls === 1 ? "call" : "calls"}`);
  }
  return parts.join(" · ");
}

export function compactionEntry(event: MiniLilacCompactionEvent): Omit<TranscriptEntry, "id"> {
  const live = event.phase === "started" || event.phase === "progress";
  const summary = event.summary?.trim();
  return {
    kind: "compaction",
    tone: event.phase === "failed" ? "danger" : "warning",
    text: summary ? `${compactionHeadline(event)}\n${summary}` : compactionHeadline(event),
    ...(live ? { running: true, streaming: true } : {}),
  };
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function explorationTone(state: ExplorationState): TranscriptTone {
  if (state.errors > 0) return "danger";
  if (state.failures > 0) return "warning";
  if (state.cancellations > 0) return "muted";
  if (state.pending.size > 0) return "accent";
  return "normal";
}

export function explorationTranscriptText(
  exploration: ExplorationTranscript,
  latest: boolean,
  expanded = false,
): string {
  const counts = [
    exploration.reads > 0 ? plural(exploration.reads, "read") : undefined,
    exploration.searches > 0 ? plural(exploration.searches, "search") : undefined,
  ].filter((value) => value !== undefined);
  const header = `${latest ? "Exploring" : "Explored"} · ${counts.join(", ")}${exploration.failures > 0 ? ` · ${plural(exploration.failures, "failure")}` : ""}${exploration.cancellations ? ` · ${exploration.cancellations} cancelled` : ""}`;
  if (!expanded) return header;
  return [
    header,
    ...exploration.operations.map(
      (operation) =>
        `${operation.action} ${previewText(operation.detail, 240)} · ${operation.status}${operation.error === undefined ? "" : `: ${operation.error}`}`,
    ),
  ].join("\n");
}

function explorationEntry(state: ExplorationState): Omit<TranscriptEntry, "id"> {
  const running = state.pending.size > 0;
  const exploration = {
    reads: state.reads,
    searches: state.searches,
    failures: state.failures,
    ...(state.cancellations > 0 ? { cancellations: state.cancellations } : {}),
    operations: [...state.operations],
  } satisfies ExplorationTranscript;
  return {
    kind: "exploration",
    tone: explorationTone(state),
    text: explorationTranscriptText(exploration, running),
    ...(running ? { running: true } : {}),
    exploration,
  };
}

export function editTranscriptAction(edit: EditTranscript): "Patch" | "Edit" {
  const first = edit.operations[0]?.action ?? "Edit";
  return edit.operations.every((operation) => operation.action === first) ? first : "Edit";
}

function editOperationText(edit: EditOperation): string {
  const additions = edit.added > 0 ? ` +${edit.added}` : "";
  const removals = edit.removed > 0 ? ` -${edit.removed}` : "";
  return `${edit.action} ${edit.path}${additions}${removals}${edit.detail ?? ""}`;
}

function editTranscriptText(edit: EditTranscript): string {
  if (edit.operations.length === 1) {
    const operation = edit.operations[0];
    return operation === undefined ? "Edit" : editOperationText(operation);
  }
  return `${editTranscriptAction(edit)} ${plural(edit.operations.length, "file")}`;
}

export function groupNearbyEdits(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const grouped: TranscriptEntry[] = [];
  for (const entry of entries) {
    const previous = grouped.at(-1);
    if (entry.edit === undefined || previous?.edit === undefined) {
      grouped.push(entry);
      continue;
    }
    const edit = {
      operations: [...previous.edit.operations, ...entry.edit.operations],
    } satisfies EditTranscript;
    grouped[grouped.length - 1] = {
      ...previous,
      tone: combinedEditTone(previous.tone, entry.tone),
      running: previous.running === true || entry.running === true ? true : undefined,
      text: editTranscriptText(edit),
      edit,
    };
  }
  return grouped;
}

function combinedEditTone(left: TranscriptTone, right: TranscriptTone): TranscriptTone {
  const leftGroup = groupedEditTone(left);
  const rightGroup = groupedEditTone(right);
  if (leftGroup === "danger" || rightGroup === "danger") return "danger";
  if (leftGroup === "warning" || rightGroup === "warning") return "warning";
  if (leftGroup === "muted" || rightGroup === "muted") return "muted";
  return "normal";
}

function groupedEditTone(tone: TranscriptTone): "normal" | "muted" | "warning" | "danger" {
  switch (tone) {
    case "danger":
      return "danger";
    case "warning":
      return "warning";
    case "muted":
      return "muted";
    case "normal":
    case "accent":
    case "success":
      return "normal";
  }
}

function shellTranscriptText(
  shell: ShellTranscript,
  expanded = false,
  lineLimit = DEFAULT_SHELL_OUTPUT_LINES,
  characterLimit = DEFAULT_SHELL_OUTPUT_CHARACTERS,
): string {
  const collapsible = isShellTranscriptCollapsible(shell, lineLimit, characterLimit);
  const preview = shellTranscriptPreview(shell, expanded, lineLimit, characterLimit);
  let disclosure: string | undefined;
  if (collapsible) disclosure = expanded ? "Click to collapse" : "Click to expand";
  const lines = [
    shell.cwd === undefined ? undefined : `# Running in ${shell.cwd}`,
    shell.cwd === undefined ? undefined : "",
    `$ ${preview.command}`,
    preview.output === undefined ? undefined : "",
    preview.output,
    collapsible ? "" : undefined,
    disclosure,
  ].filter((value) => value !== undefined);
  return lines.join("\n");
}

function truncateShellTranscript(value: string, lineLimit: number, characterLimit: number): string {
  const lineLimitedValue = value.split("\n").slice(0, lineLimit).join("\n");
  const characters = Array.from(lineLimitedValue);
  if (characters.length <= characterLimit) return lineLimitedValue;
  return `${characters.slice(0, Math.max(0, characterLimit - 3)).join("")}...`;
}

function shellTranscriptContent(shell: ShellTranscript): string {
  return shell.output === undefined || shell.output.length === 0
    ? shell.command
    : `${shell.command}\n${shell.output}`;
}

export function shellTranscriptPreview(
  shell: ShellTranscript,
  expanded = false,
  lineLimit = DEFAULT_SHELL_OUTPUT_LINES,
  characterLimit = DEFAULT_SHELL_OUTPUT_CHARACTERS,
): ShellTranscriptPreview {
  const output = shell.output === undefined || shell.output.length === 0 ? undefined : shell.output;
  if (expanded || !isShellTranscriptCollapsible(shell, lineLimit, characterLimit)) {
    return { command: shell.command, ...(output === undefined ? {} : { output }) };
  }
  const visible = truncateShellTranscript(shellTranscriptContent(shell), lineLimit, characterLimit);
  const outputPrefix = `${shell.command}\n`;
  if (!visible.startsWith(outputPrefix)) return { command: visible };
  const visibleOutput = visible.slice(outputPrefix.length);
  return {
    command: shell.command,
    ...(visibleOutput.length === 0 ? {} : { output: visibleOutput }),
  };
}

export function isShellTranscriptCollapsible(
  shell: ShellTranscript,
  lineLimit = DEFAULT_SHELL_OUTPUT_LINES,
  characterLimit = DEFAULT_SHELL_OUTPUT_CHARACTERS,
): boolean {
  const transcript = shellTranscriptContent(shell);
  return (
    transcript.split("\n").length > lineLimit || Array.from(transcript).length > characterLimit
  );
}

function stateDetail(state: ToolProjectionState): string | undefined {
  switch (state.status) {
    case "pending":
    case "active":
    case "approval":
    case "success":
      return undefined;
    case "error":
      return `: ${previewText(state.errorText, 180)}`;
    case "denied":
      return ": denied";
    case "cancelled":
      return `: cancelled${state.reason === undefined ? "" : ` (${previewText(state.reason, 160)})`}`;
  }
}

function bashOutput(projection: Extract<ToolProjection, { kind: "bash" }>): string | undefined {
  switch (projection.state.status) {
    case "pending":
    case "approval":
      return undefined;
    case "active":
      return projection.outputDelta?.trimEnd() || undefined;
    case "success":
    case "denied":
      return projection.resultText;
    case "error":
      return [projection.outputDelta?.trimEnd(), projection.resultText]
        .filter((value) => value !== undefined && value.length > 0)
        .join("\n");
    case "cancelled":
      return [projection.outputDelta?.trimEnd(), projection.resultText]
        .filter((value) => value !== undefined && value.length > 0)
        .join("\n");
  }
}

function subagentState(
  projection: Extract<ToolProjection, { kind: "subagent-delegate" }>,
): SubagentTranscript["state"] {
  if (projection.resultStatus !== undefined) {
    switch (projection.resultStatus) {
      case "accepted":
        return "running";
      case "completed":
        return "completed";
      case "cancelled":
        return "cancelled";
      case "error":
        return "error";
      case "rejected":
        return "rejected";
    }
  }
  switch (projection.state.status) {
    case "pending":
      return "pending";
    case "active":
    case "approval":
      return "running";
    case "success":
      return "completed";
    case "error":
      return "error";
    case "denied":
      return "denied";
    case "cancelled":
      return "cancelled";
  }
}

function subagentFromProjection(
  toolCallId: string,
  projection: Extract<ToolProjection, { kind: "subagent-delegate" }>,
): SubagentTranscript {
  const state = subagentState(projection);
  let stateError: string | undefined;
  switch (projection.state.status) {
    case "error":
      stateError = projection.state.errorText;
      break;
    case "denied":
      stateError = "Denied";
      break;
    case "cancelled":
      stateError = `Cancelled${projection.state.reason === undefined ? "" : `: ${projection.state.reason}`}`;
      break;
    case "pending":
    case "active":
    case "approval":
    case "success":
      break;
  }
  return {
    toolCallId,
    ...(projection.childRunId === undefined ? {} : { runId: projection.childRunId }),
    ...(projection.childSessionId === undefined ? {} : { sessionId: projection.childSessionId }),
    ...(projection.sessionName === undefined ? {} : { sessionName: projection.sessionName }),
    profile: projection.profile,
    prompt: projection.prompt,
    mode: projection.mode,
    state,
    toolCount: 0,
    ...(projection.resultText === undefined ? {} : { text: projection.resultText }),
    ...((projection.error ?? stateError) === undefined
      ? {}
      : { error: projection.error ?? stateError }),
  };
}

function projectionEntry(
  toolCallId: string,
  projection: ToolProjection,
): Omit<TranscriptEntry, "id"> | undefined {
  switch (projection.kind) {
    case "bash": {
      if (projection.command === undefined && projection.resultText === undefined) {
        return {
          kind: "tool",
          tone: projection.tone,
          text: projection.headline,
          ...(projection.running ? { running: true } : {}),
        };
      }
      const output = bashOutput(projection);
      const shell = {
        command: projection.command ?? "Bash",
        ...(projection.cwd === undefined ? {} : { cwd: projection.cwd }),
        ...(output === undefined || output.length === 0 ? {} : { output }),
      } satisfies ShellTranscript;
      return {
        kind: "shell",
        tone: projection.tone,
        text: shellTranscriptText(shell),
        ...(projection.running ? { running: true } : {}),
        shell,
      };
    }
    case "exploration":
      return undefined;
    case "edit": {
      if (projection.operations.length === 0) {
        return {
          kind: "tool",
          tone: projection.tone,
          text: projection.headline,
          ...(projection.singleLine ? { singleLine: true } : {}),
          ...(projection.running ? { running: true } : {}),
        };
      }
      const detail = stateDetail(projection.state);
      const edit = {
        operations: projection.operations.map((operation, index) => ({
          ...operation,
          tone: projection.tone,
          ...(index === 0 && detail !== undefined ? { detail } : {}),
        })),
      } satisfies EditTranscript;
      return {
        kind: "edit",
        tone: projection.tone,
        text: editTranscriptText(edit),
        singleLine: true,
        ...(projection.running ? { running: true } : {}),
        edit,
      };
    }
    case "subagent-delegate":
      return subagentEntry(subagentFromProjection(toolCallId, projection));
    case "subagent-result":
      return undefined;
    case "batch":
      return projection.visibility === "hidden"
        ? undefined
        : {
            kind: "tool",
            tone: projection.tone,
            text: projection.headline,
            ...(projection.running ? { running: true } : {}),
          };
    case "skill":
    case "todo":
    case "webfetch":
    case "websearch":
      return projection.visibility === "hidden"
        ? undefined
        : {
            kind: "tool",
            tone: projection.tone,
            text: projection.headline,
            ...(projection.singleLine ? { singleLine: true } : {}),
            ...(projection.running ? { running: true } : {}),
          };
    case "malformed-known-tool":
      return {
        kind: "tool",
        tone: projection.tone,
        text: `${projection.headline} · malformed ${projection.malformedField}: ${projection.payloadPreview}`,
        ...(projection.running ? { running: true } : {}),
      };
    case "unknown-tool":
      return {
        kind: "tool",
        tone: projection.tone,
        text: projection.headline,
        ...(projection.running ? { running: true } : {}),
      };
  }
}

function explorationCategory(
  projection: Extract<ToolProjection, { kind: "exploration" }>,
): "read" | "search" {
  switch (projection.toolName) {
    case "read_file":
      return "read";
    case "glob":
    case "grep":
    case "fuzzy_search":
      return "search";
  }
}

function explorationOperation(
  projection: Extract<ToolProjection, { kind: "exploration" }>,
): ExplorationOperation | undefined {
  if (projection.detail === undefined) return undefined;
  return {
    action: projection.action,
    detail: projection.detail,
    status: projection.operationStatus,
    ...(projection.error === undefined ? {} : { error: projection.error }),
  };
}

function fileEntry(mediaType: string, filename?: string): Omit<TranscriptEntry, "id"> {
  const label = mediaType.startsWith("image/") ? "Image" : "File";
  return { kind: "file", tone: "muted", text: filename ? `${label}: ${filename}` : label };
}

function sourceUrlEntry(title: string | undefined, url: string): Omit<TranscriptEntry, "id"> {
  return { kind: "source", tone: "muted", text: title === undefined ? url : `${title}: ${url}` };
}

function sourceDocumentEntry(
  title: string,
  mediaType: string,
  filename: string | undefined,
): Omit<TranscriptEntry, "id"> {
  const detail = filename === undefined ? mediaType : `${filename}; ${mediaType}`;
  return { kind: "source", tone: "muted", text: `${title}: ${detail}` };
}

function reasoningEntry(text: string, finalized: boolean): Omit<TranscriptEntry, "id"> {
  const summary = parseReasoningSummary(text);
  const verb = finalized ? "Thought" : "Thinking";
  const header = summary.title === null ? verb : `${verb}: ${summary.title}`;
  return {
    kind: "reasoning",
    tone: "muted",
    text: summary.body ? `${header}\n${summary.body}` : header,
  };
}

function transcriptKindForRole(role: ProjectedInitialMessage["role"]): TranscriptKind {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "system":
      return "status";
  }
}

function dataEntry(chunk: ProjectedDataChunk): Omit<TranscriptEntry, "id"> | undefined {
  switch (chunk.type) {
    case "session":
    case "todos":
    case "output-rollback":
    case "subagent-status":
      return undefined;
    case "control":
      return { kind: "status", tone: "muted", text: controlSummary(chunk.result) };
    case "transcript-reset":
      return {
        kind: "status",
        tone: "warning",
        text: `transcript rewound (${chunk.reset.reason})`,
      };
    case "compaction":
      return compactionEntry(chunk.event);
  }
}

function addExplorationProjection(
  state: ExplorationState | undefined,
  toolCallId: string,
  projection: Extract<ToolProjection, { kind: "exploration" }>,
): ExplorationState | undefined {
  const operation = explorationOperation(projection);
  if (operation === undefined) return state;
  const target =
    state ??
    ({
      id: "",
      reads: 0,
      searches: 0,
      failures: 0,
      errors: 0,
      cancellations: 0,
      operations: [],
      toolCallIds: [],
      pending: new Set(),
    } satisfies ExplorationState);
  const category = explorationCategory(projection);
  if (category === "read") target.reads += 1;
  else target.searches += 1;
  target.operations.push(operation);
  target.toolCallIds.push(toolCallId);
  if (operation.status === "pending") target.pending.add(toolCallId);
  if (operation.status === "error" || operation.status === "denied") target.failures += 1;
  if (operation.status === "error") target.errors += 1;
  if (operation.status === "cancelled") target.cancellations += 1;
  return target;
}

/** Render canonical messages after the SDK/tool boundary has projected every part. */
export function renderInitialMessages(
  messages: readonly ProjectedInitialMessage[],
): TranscriptEntry[] {
  return messages.flatMap((message) => {
    const entries: TranscriptEntry[] = [];
    const subagentIndexes = new Map<string, number>();
    let exploration: ExplorationState | undefined;
    const append = (entry: TranscriptEntry) => {
      exploration = undefined;
      entries.push(entry);
    };
    message.parts.forEach((part, index) => {
      const id = `message:${message.id}:${index}`;
      switch (part.kind) {
        case "text": {
          const kind = transcriptKindForRole(message.role);
          append({ id, kind, tone: kind === "user" ? "accent" : "normal", text: part.text });
          return;
        }
        case "reasoning":
          append({ id, ...reasoningEntry(part.text, part.finalized) });
          return;
        case "tool": {
          if (part.projection.kind === "exploration") {
            const previous = exploration;
            exploration = addExplorationProjection(exploration, part.toolCallId, part.projection);
            if (exploration === undefined) return;
            if (previous === undefined) {
              exploration.id = id;
              entries.push({ id, ...explorationEntry(exploration) });
            } else {
              const entryIndex = entries.findIndex((entry) => entry.id === exploration?.id);
              if (entryIndex >= 0) {
                entries[entryIndex] = { id: exploration.id, ...explorationEntry(exploration) };
              }
            }
            return;
          }
          if (part.projection.kind === "subagent-delegate") {
            const subagent = subagentFromProjection(part.toolCallId, part.projection);
            append({ id, ...subagentEntry(subagent) });
            subagentIndexes.set(part.toolCallId, entries.length - 1);
            return;
          }
          const entry = projectionEntry(part.toolCallId, part.projection);
          if (entry !== undefined) append({ id, ...entry });
          return;
        }
        case "data":
          if (part.chunk.type === "subagent-status") {
            const subagent = { ...part.chunk.status };
            const entryIndex = subagentIndexes.get(subagent.toolCallId);
            if (entryIndex === undefined) {
              append({ id, ...subagentEntry(subagent) });
              subagentIndexes.set(subagent.toolCallId, entries.length - 1);
            } else {
              entries[entryIndex] = {
                id: entries[entryIndex]?.id ?? id,
                ...subagentEntry(subagent),
              };
            }
            return;
          }
          {
            const entry = dataEntry(part.chunk);
            if (entry !== undefined) append({ id, ...entry });
          }
          return;
        case "file":
          append({ id, ...fileEntry(part.mediaType, part.filename) });
          return;
        case "source-url":
          append({ id, ...sourceUrlEntry(part.title, part.url) });
          return;
        case "source-document":
          append({ id, ...sourceDocumentEntry(part.title, part.mediaType, part.filename) });
          return;
        case "ignored":
          return;
      }
    });
    return entries;
  });
}

/** Consumes only closed SDK and tool projections. */
export class ChunkRenderer {
  private readonly toolEntryIds = new Map<string, string>();
  private readonly toolProjections = new Map<string, ToolProjection>();
  private readonly activeToolIds = new Set<string>();
  private readonly explorationByToolId = new Map<string, ExplorationState>();
  private readonly subagents = new Map<string, SubagentTranscript>();
  private exploration: ExplorationState | undefined;
  private readonly reasoningEntries = new Map<string, { id: string; text: string }>();
  private readonly textEntryIds = new Map<string, string>();
  private readonly compactionEntryIds = new Map<string, string>();

  constructor(
    private readonly output: ChunkOutputSink,
    private readonly hooks: ChunkRendererHooks,
    _options: TranscriptRenderOptions = {},
  ) {}

  startRun(): void {
    this.resetTransientState();
  }

  handleProjected(projected: ProjectedUIMessageChunk): void {
    switch (projected.kind) {
      case "rendered":
        this.handleRendered(projected.chunk);
        return;
      case "tool":
        this.renderToolProjection(projected.toolCallId, projected.projection);
        return;
      case "abort":
        this.finishOpenText();
        this.finalizeReasoning();
        for (const tool of projected.cancelledTools) {
          this.renderToolProjection(tool.toolCallId, tool.projection);
        }
        this.cancelStatusOnlySubagents(
          new Set(projected.cancelledTools.map((tool) => tool.toolCallId)),
          projected.reason,
        );
        this.append({
          kind: "status",
          tone: "muted",
          text: `aborted${projected.reason === undefined ? "" : `: ${projected.reason}`}`,
        });
        return;
      case "data":
        this.handleData(projected.chunk);
        return;
      case "ignored":
      case "unsupported":
        return;
    }
  }

  private handleRendered(chunk: RenderedUIMessageChunk): void {
    switch (chunk.type) {
      case "text-start":
        this.finalizeReasoning();
        this.finishOpenText();
        return;
      case "text-delta":
        this.finalizeReasoning();
        if (!this.textEntryIds.has(chunk.id)) this.finishOpenText();
        this.renderTextDelta(chunk.id, chunk.delta);
        return;
      case "text-end":
        this.finishText(chunk.id);
        return;
      case "finish":
        this.finishOpenText();
        this.finalizeReasoning();
        return;
      case "reasoning-start":
        this.finishOpenText();
        this.finalizeReasoning();
        this.startReasoning(chunk.id);
        return;
      case "reasoning-delta":
        this.finishOpenText();
        if (!this.reasoningEntries.has(chunk.id)) this.finalizeReasoning();
        this.appendReasoning(chunk.id, chunk.delta);
        return;
      case "reasoning-end":
        this.endReasoning(chunk.id);
        return;
      case "file":
        this.append(fileEntry(chunk.mediaType));
        return;
      case "source-url":
        this.append(sourceUrlEntry(chunk.title, chunk.url));
        return;
      case "source-document":
        this.append(sourceDocumentEntry(chunk.title, chunk.mediaType, chunk.filename));
        return;
      case "error":
        this.finishOpenText();
        this.finalizeReasoning();
        this.append({ kind: "error", tone: "danger", text: chunk.errorText });
        return;
    }
  }

  private handleData(chunk: ProjectedDataChunk): void {
    switch (chunk.type) {
      case "session":
        this.hooks.onSnapshot(chunk.snapshot);
        return;
      case "control":
        this.hooks.onControl?.(chunk.result);
        this.append({ kind: "status", tone: "muted", text: controlSummary(chunk.result) });
        return;
      case "todos":
        this.hooks.onTodos?.(chunk.todos);
        return;
      case "transcript-reset":
        this.resetTransientState();
        this.hooks.onTranscriptReset(chunk.reset);
        this.append({
          kind: "status",
          tone: "warning",
          text: `transcript rewound (${chunk.reset.reason}); canonical transcript will be reconciled`,
        });
        return;
      case "output-rollback":
        this.rollbackOutput(chunk.rollback);
        this.hooks.onOutputRollback?.(chunk.rollback);
        return;
      case "subagent-status":
        this.renderSubagentStatus(chunk.status);
        return;
      case "compaction":
        this.renderCompaction(chunk.id, chunk.event);
        return;
    }
  }

  private renderCompaction(chunkId: string | undefined, event: MiniLilacCompactionEvent): void {
    const key = chunkId ?? "compaction";
    const existing = this.compactionEntryIds.get(key);
    if (existing === undefined) {
      this.finishOpenText();
      this.finalizeReasoning();
      this.compactionEntryIds.set(key, this.append(compactionEntry(event)));
      return;
    }
    this.output.update(existing, compactionEntry(event));
  }

  private renderSubagentStatus(status: MiniLilacSubagentStatus): void {
    const subagent = { ...status };
    this.subagents.set(status.toolCallId, subagent);
    let id = this.toolEntryIds.get(status.toolCallId);
    if (id === undefined) {
      this.finalizeReasoning();
      id = this.append(subagentEntry(subagent));
      this.toolEntryIds.set(status.toolCallId, id);
    } else {
      this.output.update(id, subagentEntry(subagent));
    }
    if (status.state === "running") this.activeToolIds.add(status.toolCallId);
    else this.activeToolIds.delete(status.toolCallId);
  }

  private cancelStatusOnlySubagents(
    cancelledToolIds: ReadonlySet<string>,
    reason: string | undefined,
  ): void {
    for (const toolCallId of this.activeToolIds) {
      if (cancelledToolIds.has(toolCallId)) continue;
      const existing = this.subagents.get(toolCallId);
      if (existing === undefined) continue;
      const subagent = {
        ...existing,
        state: "cancelled" as const,
        error: `Cancelled${reason === undefined ? "" : `: ${reason}`}`,
      };
      this.subagents.set(toolCallId, subagent);
      const id = this.toolEntryIds.get(toolCallId);
      if (id === undefined) this.toolEntryIds.set(toolCallId, this.append(subagentEntry(subagent)));
      else this.output.update(id, subagentEntry(subagent));
      this.activeToolIds.delete(toolCallId);
    }
  }

  private renderToolProjection(toolCallId: string, projection: ToolProjection): void {
    this.finalizeReasoning();
    this.toolProjections.set(toolCallId, projection);
    if (projection.running) this.activeToolIds.add(toolCallId);
    else this.activeToolIds.delete(toolCallId);

    if (projection.kind === "exploration") {
      this.renderExplorationProjection(toolCallId, projection);
      return;
    }
    if (projection.kind === "subagent-delegate") {
      const projected = subagentFromProjection(toolCallId, projection);
      const existing = this.subagents.get(toolCallId);
      const existingIsTerminal =
        existing !== undefined && existing.state !== "pending" && existing.state !== "running";
      const preserveExistingState =
        existing !== undefined && (existingIsTerminal || projection.running);
      const subagent =
        existing === undefined
          ? projected
          : {
              ...projected,
              ...(existing.runId === undefined ? {} : { runId: existing.runId }),
              ...(existing.sessionId === undefined ? {} : { sessionId: existing.sessionId }),
              ...(existing.sessionName === undefined ? {} : { sessionName: existing.sessionName }),
              toolCount: existing.toolCount,
              ...(existing.activity === undefined ? {} : { activity: existing.activity }),
              ...(existing.text === undefined ? {} : { text: existing.text }),
              ...(existing.error === undefined ? {} : { error: existing.error }),
              ...(preserveExistingState ? { state: existing.state } : {}),
            };
      this.subagents.set(toolCallId, subagent);
      const id = this.toolEntryIds.get(toolCallId);
      if (id === undefined) this.toolEntryIds.set(toolCallId, this.append(subagentEntry(subagent)));
      else this.output.update(id, subagentEntry(subagent));
      return;
    }

    const entry = projectionEntry(toolCallId, projection);
    const id = this.toolEntryIds.get(toolCallId);
    if (entry === undefined) {
      if (id !== undefined && projection.visibility === "hidden") this.output.remove(id);
      return;
    }
    if (id === undefined) this.toolEntryIds.set(toolCallId, this.append(entry));
    else this.output.update(id, entry);
  }

  private renderExplorationProjection(
    toolCallId: string,
    projection: Extract<ToolProjection, { kind: "exploration" }>,
  ): void {
    const existing = this.explorationByToolId.get(toolCallId);
    if (existing !== undefined) {
      const index = existing.toolCallIds.indexOf(toolCallId);
      const operation = explorationOperation(projection);
      if (index >= 0 && operation !== undefined) {
        const previous = existing.operations[index];
        if (previous !== undefined) this.removeExplorationOutcome(existing, toolCallId, previous);
        existing.operations[index] = operation;
        this.addExplorationOutcome(existing, toolCallId, operation);
        this.output.update(existing.id, explorationEntry(existing));
      }
      return;
    }

    const previous = this.exploration;
    const next = addExplorationProjection(previous, toolCallId, projection);
    if (next === undefined) return;
    if (previous === undefined) {
      next.id = this.output.append(explorationEntry(next));
      this.exploration = next;
    } else {
      this.output.update(next.id, explorationEntry(next));
    }
    this.explorationByToolId.set(toolCallId, next);
    this.toolEntryIds.set(toolCallId, next.id);
  }

  private removeExplorationOutcome(
    state: ExplorationState,
    toolCallId: string,
    operation: ExplorationOperation,
  ): void {
    state.pending.delete(toolCallId);
    if (operation.status === "error" || operation.status === "denied") state.failures -= 1;
    if (operation.status === "error") state.errors -= 1;
    if (operation.status === "cancelled") state.cancellations -= 1;
  }

  private addExplorationOutcome(
    state: ExplorationState,
    toolCallId: string,
    operation: ExplorationOperation,
  ): void {
    if (operation.status === "pending") state.pending.add(toolCallId);
    if (operation.status === "error" || operation.status === "denied") state.failures += 1;
    if (operation.status === "error") state.errors += 1;
    if (operation.status === "cancelled") state.cancellations += 1;
  }

  private append(entry: Omit<TranscriptEntry, "id">): string {
    if (entry.kind !== "exploration" && this.exploration !== undefined) {
      this.output.update(this.exploration.id, explorationEntry(this.exploration));
      this.exploration = undefined;
    }
    return this.output.append(entry);
  }

  private rollbackOutput(rollback: MiniLilacOutputRollback): void {
    for (const chunkId of rollback.textIds) {
      const id = this.textEntryIds.get(chunkId);
      if (id !== undefined) this.output.remove(id);
      this.textEntryIds.delete(chunkId);
    }
    for (const chunkId of rollback.reasoningIds) {
      const entry = this.reasoningEntries.get(chunkId);
      if (entry !== undefined) this.output.remove(entry.id);
      this.reasoningEntries.delete(chunkId);
    }
    for (const toolCallId of rollback.toolCallIds) {
      const exploration = this.explorationByToolId.get(toolCallId);
      if (exploration !== undefined) {
        const index = exploration.toolCallIds.indexOf(toolCallId);
        const operation = exploration.operations[index];
        const projection = this.toolProjections.get(toolCallId);
        if (index >= 0 && operation !== undefined && projection?.kind === "exploration") {
          this.removeExplorationOutcome(exploration, toolCallId, operation);
          const category = explorationCategory(projection);
          if (category === "read") exploration.reads -= 1;
          else exploration.searches -= 1;
          exploration.toolCallIds.splice(index, 1);
          exploration.operations.splice(index, 1);
        }
        this.explorationByToolId.delete(toolCallId);
        if (exploration.toolCallIds.length === 0) {
          this.output.remove(exploration.id);
          if (this.exploration === exploration) this.exploration = undefined;
        } else {
          this.output.update(exploration.id, explorationEntry(exploration));
        }
      } else {
        const id = this.toolEntryIds.get(toolCallId);
        if (id !== undefined) this.output.remove(id);
      }
      this.activeToolIds.delete(toolCallId);
      this.toolEntryIds.delete(toolCallId);
      this.toolProjections.delete(toolCallId);
      this.subagents.delete(toolCallId);
    }
  }

  private startReasoning(chunkId: string): void {
    if (this.reasoningEntries.has(chunkId)) return;
    const id = this.append(reasoningEntry("", false));
    this.reasoningEntries.set(chunkId, { id, text: "" });
  }

  private appendReasoning(chunkId: string, delta: string): void {
    const existing = this.reasoningEntries.get(chunkId);
    if (existing === undefined && delta.length === 0) return;
    const entry = existing ?? { id: this.append(reasoningEntry("", false)), text: "" };
    entry.text += delta;
    this.reasoningEntries.set(chunkId, entry);
    this.output.update(entry.id, reasoningEntry(entry.text, false));
  }

  private endReasoning(chunkId: string): void {
    const entry = this.reasoningEntries.get(chunkId);
    if (entry === undefined) return;
    this.output.update(entry.id, reasoningEntry(entry.text, true));
    this.reasoningEntries.delete(chunkId);
  }

  private finalizeReasoning(): void {
    for (const entry of this.reasoningEntries.values()) {
      this.output.update(entry.id, reasoningEntry(entry.text, true));
    }
    this.reasoningEntries.clear();
  }

  private renderTextDelta(chunkId: string, delta: string): void {
    let id = this.textEntryIds.get(chunkId);
    if (id === undefined) {
      id = this.append({ kind: "assistant", tone: "normal", text: delta, streaming: true });
      this.textEntryIds.set(chunkId, id);
      return;
    }
    this.output.appendText(id, delta);
  }

  private finishText(chunkId: string): void {
    const id = this.textEntryIds.get(chunkId);
    if (id === undefined) return;
    this.output.finish(id);
    this.textEntryIds.delete(chunkId);
  }

  private finishOpenText(): void {
    for (const id of this.textEntryIds.values()) this.output.finish(id);
    this.textEntryIds.clear();
  }

  private resetTransientState(): void {
    this.toolEntryIds.clear();
    this.toolProjections.clear();
    this.activeToolIds.clear();
    this.explorationByToolId.clear();
    this.subagents.clear();
    this.exploration = undefined;
    this.textEntryIds.clear();
    this.reasoningEntries.clear();
    this.compactionEntryIds.clear();
  }
}
