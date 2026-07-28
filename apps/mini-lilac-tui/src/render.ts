import { posix } from "node:path";

import { getToolName, isToolUIPart, type UIMessageChunk } from "ai";
import { z } from "zod";

import { parseReasoningSummary } from "@stanley2058/lilac-utils/reasoning-summary";

import {
  miniLilacTodoChunkSchema,
  miniLilacTodosSchema,
  miniLilacUIMessageDataPartSchema,
  type MiniLilacCompactionEvent,
  type MiniLilacControlResult,
  type MiniLilacOutputRollback,
  type MiniLilacSessionSnapshot,
  type MiniLilacSubagentStatus,
  type MiniLilacTodoState,
  type MiniLilacTranscriptReset,
  type MiniLilacUIMessage,
} from "@stanley2058/mini-lilac-client";

export type TranscriptKind =
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

export interface ShellTranscriptPreview {
  readonly command: string;
  readonly output?: string;
}

export interface ExplorationOperation {
  readonly action: "Read" | "Grep" | "Glob" | "Find";
  readonly detail: string;
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

const DEFAULT_SHELL_OUTPUT_LINES = 8;
const DEFAULT_SHELL_OUTPUT_CHARACTERS = 2_000;

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

function previewText(value: string, max = 120): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 3)}...` : singleLine;
}

function toolErrorSummary(summary: string, errorText: string): string {
  const trimmed = errorText.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return `${summary} failed`;
  return `${summary}: ${previewText(errorText, 180)}`;
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
  if (subagent.sessionId !== undefined && lines.length === 1)
    lines.push("  ↳ Click to view transcript");
  return {
    kind: "subagent",
    tone: running
      ? "accent"
      : subagent.state === "completed"
        ? "success"
        : subagent.state === "cancelled"
          ? "muted"
          : subagent.state === "denied"
            ? "warning"
            : "danger",
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

/**
 * Header line for a compaction entry.
 *
 * The entry is updated in place across the lifecycle, so this covers the live
 * phases as well as every terminal one. `noop`/`empty` deliberately get their
 * own wording: reporting a saving when nothing was compacted is worse than
 * saying nothing, which is what the UI used to do.
 */
export function compactionHeadline(event: MiniLilacCompactionEvent): string {
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
    // The summary is the thing the user cannot otherwise see; carrying it on the
    // entry lets the transcript show what compaction actually kept.
    text: summary ? `${compactionHeadline(event)}\n${summary}` : compactionHeadline(event),
    ...(live ? { running: true, streaming: true } : {}),
  };
}

const pathInputSchema = z.object({ path: z.string() });
const readInputSchema = z.object({
  path: z.string(),
  start: z
    .union([
      z.object({ offset: z.number().int().nonnegative() }),
      z.object({
        line: z.number().int().positive(),
        column: z.number().int().nonnegative().optional(),
      }),
    ])
    .optional(),
  maxLines: z.number().int().positive().optional(),
  maxCharacters: z.number().int().positive().optional(),
});
const bashInputSchema = z.object({ command: z.string(), cwd: z.string().optional() });
const globInputSchema = z.object({ patterns: z.array(z.string()), cwd: z.string().optional() });
const grepInputSchema = z.object({ pattern: z.string(), cwd: z.string().optional() });
const fuzzyInputSchema = z.object({ query: z.string(), cwd: z.string().optional() });
const patchInputSchema = z.object({ patchText: z.string(), cwd: z.string().optional() });
const editInputSchema = z.object({
  path: z.string(),
  oldText: z.string().optional(),
  newText: z.string().optional(),
  edits: z
    .array(
      z.object({
        op: z.enum(["replace", "append", "prepend"]),
        pos: z.string(),
        end: z.string().optional(),
        lines: z.union([z.string(), z.array(z.string()), z.null()]).optional(),
      }),
    )
    .optional(),
});
const editOutputSchema = z.object({ replacementsMade: z.number().int().nonnegative().optional() });
const bashExecutionErrorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("blocked"), reason: z.string() }),
  z.object({ type: z.literal("aborted"), signal: z.literal("SIGTERM") }),
  z.object({
    type: z.literal("timeout"),
    timeoutMs: z.number().nonnegative(),
    signal: z.literal("SIGTERM"),
  }),
  z.object({ type: z.literal("exception"), message: z.string() }),
]);
const bashOutputSchema = z
  .object({
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exitCode: z.number().int().optional(),
    stdoutTruncated: z.boolean().optional(),
    stderrTruncated: z.boolean().optional(),
    executionError: bashExecutionErrorSchema.optional(),
  })
  .strict()
  .refine(
    (output) =>
      output.stdout !== undefined ||
      output.stderr !== undefined ||
      output.exitCode !== undefined ||
      output.stdoutTruncated !== undefined ||
      output.stderrTruncated !== undefined ||
      output.executionError !== undefined,
  );
const bashOutputDeltaSchema = z.object({
  type: z.literal("output-delta"),
  delta: z.string(),
});
const subagentInputSchema = z.object({
  profile: z.string().optional(),
  prompt: z.string().optional(),
  task: z.string().optional(),
  mode: z.enum(["sync", "deferred"]).optional(),
  sessionName: z.string().optional(),
});
const subagentResultSchema = z.object({
  status: z.enum(["accepted", "completed", "cancelled", "error", "rejected"]),
  childRunId: z.string().optional(),
  childSessionId: z.string().optional(),
  sessionName: z.string().optional(),
  profile: z.string().optional(),
  text: z.string().optional(),
  error: z.string().optional(),
  reason: z.string().optional(),
});

function subagentFromTool(
  toolCallId: string,
  input: unknown,
  output?: unknown,
): SubagentTranscript {
  const parsedInput = subagentInputSchema.safeParse(input);
  const parsedOutput = subagentResultSchema.safeParse(output);
  const profile = parsedOutput.success
    ? (parsedOutput.data.profile ?? parsedInput.data?.profile)
    : parsedInput.data?.profile;
  const prompt = parsedInput.success
    ? (parsedInput.data.prompt ?? parsedInput.data.task ?? "Delegated task")
    : "Delegated task";
  const mode = parsedInput.success ? (parsedInput.data.mode ?? "sync") : "sync";
  if (!parsedOutput.success) {
    return {
      toolCallId,
      profile: profile ?? "subagent",
      prompt,
      mode,
      state: "pending",
      toolCount: 0,
    };
  }
  const state = parsedOutput.data.status === "accepted" ? "running" : parsedOutput.data.status;
  return {
    toolCallId,
    ...(parsedOutput.data.childRunId ? { runId: parsedOutput.data.childRunId } : {}),
    ...(parsedOutput.data.childSessionId ? { sessionId: parsedOutput.data.childSessionId } : {}),
    ...(parsedOutput.data.sessionName || parsedInput.data?.sessionName
      ? { sessionName: parsedOutput.data.sessionName ?? parsedInput.data?.sessionName }
      : {}),
    profile: profile ?? "subagent",
    prompt,
    mode,
    state,
    toolCount: 0,
    ...(parsedOutput.data.text ? { text: parsedOutput.data.text } : {}),
    ...(parsedOutput.data.error || parsedOutput.data.reason
      ? { error: parsedOutput.data.error ?? parsedOutput.data.reason }
      : {}),
  };
}

function subagentFromStatus(status: MiniLilacSubagentStatus): SubagentTranscript {
  return { ...status };
}
const skillInputSchema = z.object({ name: z.string().trim().min(1) });
const todoWriteInputSchema = z.strictObject({ todos: miniLilacTodosSchema });
const batchInputSchema = z.object({ tool_calls: z.array(z.unknown()) });
const webfetchInputSchema = z.object({ url: z.string().trim().min(1) });
const websearchInputSchema = z.object({ query: z.string().trim().min(1) });
const websearchOutputSchema = z.object({
  action: z.object({ query: z.string().trim().min(1) }),
});

type ToolRenderState =
  | { readonly status: "active"; readonly output?: unknown }
  | { readonly status: "success"; readonly output: unknown }
  | { readonly status: "error"; readonly errorText: string }
  | { readonly status: "denied" }
  | { readonly status: "cancelled"; readonly reason?: string; readonly output?: unknown };

type ExplorationState = {
  id: string;
  reads: number;
  searches: number;
  failures: number;
  errors: number;
  cancellations: number;
  operations: ExplorationOperation[];
  toolCallIds: string[];
  outcomes: Map<string, "error" | "denied" | "cancelled" | undefined>;
  pending: Set<string>;
};

function explorationCategory(name: string): "read" | "search" | undefined {
  if (name === "read_file") return "read";
  if (name === "glob" || name === "grep" || name === "fuzzy_search") return "search";
  return undefined;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
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
      (operation) => `${operation.action} ${previewText(operation.detail, 240)}`,
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
    tone:
      state.errors > 0
        ? "danger"
        : state.failures > 0
          ? "warning"
          : state.cancellations > 0
            ? "muted"
            : running
              ? "accent"
              : "normal",
    text: explorationTranscriptText(exploration, running),
    ...(running ? { running: true } : {}),
    exploration,
  };
}

function explorationOperation(
  name: string,
  input: unknown,
  options: TranscriptRenderOptions = {},
): ExplorationOperation {
  if (name === "read_file") {
    const parsed = readInputSchema.safeParse(input);
    if (parsed.success) {
      const start = parsed.data.start;
      const details = [
        start && "offset" in start ? `offset ${start.offset}` : undefined,
        start && "line" in start
          ? `line ${start.line}${start.column === undefined ? "" : `:${start.column}`}`
          : undefined,
        parsed.data.maxLines === undefined ? undefined : plural(parsed.data.maxLines, "line"),
        parsed.data.maxCharacters === undefined
          ? undefined
          : plural(parsed.data.maxCharacters, "character"),
      ].filter((value) => value !== undefined);
      return {
        action: "Read",
        detail: [explorationPath(parsed.data.path, options.cwd), ...details].join(" · "),
      };
    }
    return { action: "Read", detail: "file" };
  }
  if (name === "grep") {
    const parsed = grepInputSchema.safeParse(input);
    if (parsed.success) {
      return {
        action: "Grep",
        detail: [
          explorationScope(parsed.data.cwd, options.cwd),
          JSON.stringify(parsed.data.pattern),
        ]
          .filter((value) => value !== undefined)
          .join(" · "),
      };
    }
    return { action: "Grep", detail: "pattern" };
  }
  if (name === "glob") {
    const parsed = globInputSchema.safeParse(input);
    if (parsed.success) {
      return {
        action: "Glob",
        detail: [explorationScope(parsed.data.cwd, options.cwd), parsed.data.patterns.join(", ")]
          .filter((value) => value !== undefined)
          .join(" · "),
      };
    }
    return { action: "Glob", detail: "files" };
  }
  const parsed = fuzzyInputSchema.safeParse(input);
  return {
    action: "Find",
    detail: parsed.success
      ? [explorationScope(parsed.data.cwd, options.cwd), JSON.stringify(parsed.data.query)]
          .filter((value) => value !== undefined)
          .join(" · ")
      : "query",
  };
}

function explorationPath(value: string, cwd: string | undefined): string {
  if (cwd === undefined) return value;
  const normalizedValue = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  const normalizedCwd = cwd.replaceAll("\\", "/").replace(/\/+$/u, "");
  if (normalizedValue === normalizedCwd) return ".";
  if (normalizedValue.startsWith(`${normalizedCwd}/`)) {
    return normalizedValue.slice(normalizedCwd.length + 1);
  }
  return value;
}

function explorationScope(value: string | undefined, cwd: string | undefined): string | undefined {
  if (value === undefined || sameCwd(value, cwd)) return undefined;
  return explorationPath(value, cwd);
}

function lineCount(value: string): number {
  if (value.length === 0) return 0;
  const lines = value.split("\n").length;
  return value.endsWith("\n") ? lines - 1 : lines;
}

function replacementLineCount(value: string | readonly string[] | null | undefined): number {
  if (value === undefined || value === null) return 0;
  return typeof value === "string" ? lineCount(value) : value.length;
}

function hashlineNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)#[0-9a-f]+\b/iu.exec(value.trim());
  if (!match) return undefined;
  const line = Number(match[1]);
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

function editPath(value: string, cwd: string | undefined): string {
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (cwd === undefined || !normalized.startsWith("/")) return normalized;
  const normalizedCwd = posix.normalize(cwd.replaceAll("\\", "/"));
  return posix.relative(normalizedCwd, normalized) || ".";
}

export function editTranscriptAction(edit: EditTranscript): "Patch" | "Edit" {
  const first = edit.operations[0]?.action ?? "Edit";
  return edit.operations.every((operation) => operation.action === first) ? first : "Edit";
}

export function editOperationText(edit: EditOperation): string {
  const additions = edit.added > 0 ? ` +${edit.added}` : "";
  const removals = edit.removed > 0 ? ` -${edit.removed}` : "";
  return `${edit.action} ${edit.path}${additions}${removals}${edit.detail ?? ""}`;
}

export function editTranscriptText(edit: EditTranscript): string {
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
      tone:
        previous.tone === "danger" || entry.tone === "danger"
          ? "danger"
          : previous.tone === "warning" || entry.tone === "warning"
            ? "warning"
            : previous.tone === "muted" || entry.tone === "muted"
              ? "muted"
              : "normal",
      running: previous.running === true || entry.running === true ? true : undefined,
      text: editTranscriptText(edit),
      edit,
    };
  }
  return grouped;
}

function patchEdits(input: unknown, cwd: string | undefined): EditOperation[] | undefined {
  const parsed = patchInputSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const edits: Array<{ path: string; added: number; removed: number }> = [];
  let current: { path: string; added: number; removed: number } | undefined;
  for (const line of parsed.data.patchText.split("\n")) {
    const header = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/u.exec(line);
    if (header?.[1] !== undefined) {
      current = { path: header[1], added: 0, removed: 0 };
      edits.push(current);
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/u.exec(line);
    if (move?.[1] !== undefined && current !== undefined) {
      current.path = move[1];
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("+")) current.added += 1;
    else if (line.startsWith("-")) current.removed += 1;
  }
  return edits.map((edit) => ({
    action: "Patch",
    path: editPath(edit.path, parsed.data.cwd ?? cwd),
    added: edit.added,
    removed: edit.removed,
    tone: "normal",
  }));
}

function fileEdits(
  input: unknown,
  output: unknown,
  cwd: string | undefined,
): EditOperation[] | undefined {
  const parsed = editInputSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const replacements = editOutputSchema.safeParse(output);
  const multiplier = replacements.success ? (replacements.data.replacementsMade ?? 1) : 1;
  if (parsed.data.oldText !== undefined && parsed.data.newText !== undefined) {
    return [
      {
        action: "Edit",
        path: editPath(parsed.data.path, cwd),
        added: lineCount(parsed.data.newText) * multiplier,
        removed: lineCount(parsed.data.oldText) * multiplier,
        tone: "normal",
      },
    ];
  }
  if (parsed.data.edits !== undefined) {
    let added = 0;
    let removed = 0;
    for (const edit of parsed.data.edits) {
      added += replacementLineCount(edit.lines);
      if (edit.op !== "replace") continue;
      const start = hashlineNumber(edit.pos);
      const end = hashlineNumber(edit.end) ?? start;
      if (start !== undefined && end !== undefined && end >= start) removed += end - start + 1;
    }
    return [
      {
        action: "Edit",
        path: editPath(parsed.data.path, cwd),
        added,
        removed,
        tone: "normal",
      },
    ];
  }
  return [
    {
      action: "Edit",
      path: editPath(parsed.data.path, cwd),
      added: 0,
      removed: 0,
      tone: "normal",
    },
  ];
}

function shellOutput(output: unknown): string | undefined {
  if (typeof output === "string") return output.trimEnd() || undefined;
  const parsed = bashOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  const executionError = parsed.data.executionError;
  const executionErrorText =
    executionError?.type === "blocked"
      ? executionError.reason
      : executionError?.type === "timeout"
        ? `Command timed out after ${executionError.timeoutMs}ms`
        : executionError?.type === "aborted"
          ? "Command aborted"
          : executionError?.type === "exception"
            ? executionError.message
            : undefined;
  const chunks = [
    parsed.data.stdout?.trimEnd(),
    parsed.data.stderr?.trimEnd(),
    executionErrorText,
  ].filter((value) => value !== undefined && value.length > 0);
  if (parsed.data.exitCode !== undefined && parsed.data.exitCode !== 0 && chunks.length === 0) {
    chunks.push(`Process exited with code ${parsed.data.exitCode}`);
  }
  return chunks.join("\n") || undefined;
}

function shellOutputTone(output: unknown): "normal" | "muted" | "danger" {
  const parsed = bashOutputSchema.safeParse(output);
  if (!parsed.success || parsed.data.executionError === undefined) return "normal";
  return parsed.data.executionError.type === "aborted" ? "muted" : "danger";
}

function sameCwd(commandCwd: string, clientCwd: string | undefined): boolean {
  if (clientCwd === undefined) return false;
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalize(commandCwd) === normalize(clientCwd);
}

export function shellTranscriptText(
  shell: ShellTranscript,
  expanded = false,
  lineLimit = DEFAULT_SHELL_OUTPUT_LINES,
  characterLimit = DEFAULT_SHELL_OUTPUT_CHARACTERS,
): string {
  const collapsible = isShellTranscriptCollapsible(shell, lineLimit, characterLimit);
  const preview = shellTranscriptPreview(shell, expanded, lineLimit, characterLimit);
  const lines = [
    shell.cwd === undefined ? undefined : `# Running in ${shell.cwd}`,
    shell.cwd === undefined ? undefined : "",
    `$ ${preview.command}`,
    preview.output === undefined ? undefined : "",
    preview.output,
    collapsible ? "" : undefined,
    collapsible ? (expanded ? "Click to collapse" : "Click to expand") : undefined,
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

function toolEntry(
  name: string,
  input: unknown,
  state: ToolRenderState,
  options: TranscriptRenderOptions = {},
): Omit<TranscriptEntry, "id"> | undefined {
  if (name === "subagent_result") return undefined;
  if (name === "batch" && state.status !== "error") return undefined;
  if (name === "bash") {
    const parsed = bashInputSchema.safeParse(input);
    if (parsed.success) {
      const cancellation =
        state.status === "cancelled"
          ? `Cancelled${state.reason === undefined ? "" : `: ${previewText(state.reason, 180)}`}`
          : undefined;
      const cancelledOutput =
        state.status === "cancelled"
          ? [shellOutput(state.output), cancellation]
              .filter((value) => value !== undefined)
              .join("\n")
          : undefined;
      const output =
        state.status === "success" || (state.status === "active" && state.output !== undefined)
          ? shellOutput(state.output)
          : state.status === "error"
            ? /^[[{]/u.test(state.errorText.trimStart())
              ? "Command failed"
              : state.errorText
            : state.status === "denied"
              ? "Denied"
              : cancelledOutput;
      const shell = {
        command: parsed.data.command,
        ...(parsed.data.cwd === undefined || sameCwd(parsed.data.cwd, options.cwd)
          ? {}
          : { cwd: parsed.data.cwd }),
        ...(output === undefined ? {} : { output }),
      } satisfies ShellTranscript;
      return {
        kind: "shell",
        tone:
          state.status === "error"
            ? "danger"
            : state.status === "denied"
              ? "warning"
              : state.status === "cancelled"
                ? "muted"
                : state.status === "success"
                  ? shellOutputTone(state.output)
                  : "normal",
        text: shellTranscriptText(shell),
        ...(state.status === "active" ? { running: true } : {}),
        shell,
      };
    }
  }
  if (name === "skill") {
    const parsed = skillInputSchema.safeParse(input);
    if (parsed.success && (state.status === "active" || state.status === "success")) {
      return {
        kind: "tool",
        tone: state.status === "success" ? "success" : "accent",
        text: `${state.status === "success" ? "Loaded" : "Loading"} skill ${parsed.data.name}`,
        ...(state.status === "active" ? { running: true } : {}),
      };
    }
  }
  const edits =
    name === "apply_patch"
      ? patchEdits(input, options.cwd)
      : name === "edit_file"
        ? fileEdits(input, state.status === "success" ? state.output : undefined, options.cwd)
        : undefined;
  if (edits !== undefined && edits.length > 0) {
    const detail =
      state.status === "error"
        ? `: ${previewText(state.errorText, 180)}`
        : state.status === "denied"
          ? ": denied"
          : state.status === "cancelled"
            ? `: cancelled${state.reason === undefined ? "" : ` (${previewText(state.reason, 160)})`}`
            : undefined;
    const tone =
      state.status === "error"
        ? "danger"
        : state.status === "denied"
          ? "warning"
          : state.status === "cancelled"
            ? "muted"
            : "normal";
    const edit = {
      operations: edits.map((operation, index) => ({
        ...operation,
        tone,
        ...(index === 0 && detail !== undefined ? { detail } : {}),
      })),
    } satisfies EditTranscript;
    return {
      kind: "edit",
      tone,
      text: editTranscriptText(edit),
      singleLine: true,
      ...(state.status === "active" ? { running: true } : {}),
      edit,
    };
  }
  const summary =
    name === "batch"
      ? "Parallel tools"
      : toolSummary(
          name,
          input,
          state.status === "success" || state.status === "active" ? state.output : undefined,
        );
  const singleLine =
    name === "webfetch" || name === "websearch" || name === "apply_patch" || name === "edit_file";
  if (state.status === "error") {
    return {
      kind: "tool",
      tone: "danger",
      text: toolErrorSummary(summary, state.errorText),
      ...(singleLine ? { singleLine: true } : {}),
    };
  }
  if (state.status === "denied") {
    return {
      kind: "tool",
      tone: "warning",
      text: `${summary}: denied`,
      ...(singleLine ? { singleLine: true } : {}),
    };
  }
  if (state.status === "cancelled") {
    return {
      kind: "tool",
      tone: "muted",
      text: `${summary}: cancelled${state.reason === undefined ? "" : ` (${previewText(state.reason, 160)})`}`,
      ...(singleLine ? { singleLine: true } : {}),
    };
  }
  return {
    kind: "tool",
    tone: state.status === "success" ? "success" : "accent",
    text: state.status === "active" ? `${summary} · running` : summary,
    ...(singleLine ? { singleLine: true } : {}),
    ...(state.status === "active" ? { running: true } : {}),
  };
}

function humanizeToolName(name: string): string {
  return name
    .split(/[_-]+/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function toolSummary(name: string, input: unknown, output?: unknown): string {
  if (name === "bash") {
    const parsed = bashInputSchema.safeParse(input);
    if (parsed.success) return `$ ${previewText(parsed.data.command, 160)}`;
  }
  if (name === "read_file") {
    const parsed = pathInputSchema.safeParse(input);
    if (parsed.success) return `Read ${parsed.data.path}`;
  }
  if (name === "edit_file") {
    const parsed = pathInputSchema.safeParse(input);
    if (parsed.success) return `Edit ${parsed.data.path}`;
  }
  if (name === "glob") {
    const parsed = globInputSchema.safeParse(input);
    if (parsed.success) return `Glob ${parsed.data.patterns.join(", ")}`;
  }
  if (name === "grep") {
    const parsed = grepInputSchema.safeParse(input);
    if (parsed.success) return `Grep "${previewText(parsed.data.pattern)}"`;
  }
  if (name === "fuzzy_search") {
    const parsed = fuzzyInputSchema.safeParse(input);
    if (parsed.success) return `Find "${previewText(parsed.data.query)}"`;
  }
  if (name === "apply_patch") {
    const parsed = patchInputSchema.safeParse(input);
    if (parsed.success) {
      const paths = [
        ...parsed.data.patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu),
      ].map((match) => match[1]);
      if (paths[0] !== undefined) {
        return `Patch ${paths[0]}${paths.length > 1 ? ` (+${paths.length - 1})` : ""}`;
      }
    }
  }
  if (name === "subagent_delegate") {
    const parsed = subagentInputSchema.safeParse(input);
    if (parsed.success) {
      const prompt = parsed.data.prompt ?? parsed.data.task;
      if (prompt !== undefined) {
        return `${humanizeToolName(parsed.data.profile ?? "subagent")}: ${previewText(prompt)}`;
      }
    }
  }
  if (name === "skill") {
    const parsed = skillInputSchema.safeParse(input);
    if (parsed.success) return `Skill ${parsed.data.name}`;
  }
  if (name === "todowrite") {
    const parsed = todoWriteInputSchema.safeParse(input);
    if (parsed.success) {
      const count = parsed.data.todos.length;
      return `Update todos: ${count} item${count === 1 ? "" : "s"}`;
    }
  }
  if (name === "batch") {
    const parsed = batchInputSchema.safeParse(input);
    if (parsed.success) return `Batch ${parsed.data.tool_calls.length} tools`;
  }
  if (name === "webfetch") {
    const parsed = webfetchInputSchema.safeParse(input);
    if (parsed.success) return `Fetch ${parsed.data.url}`;
  }
  if (name === "websearch") {
    const parsed = websearchInputSchema.safeParse(input);
    if (parsed.success) return `Search "${parsed.data.query.replace(/\s+/gu, " ")}"`;
    const parsedOutput = websearchOutputSchema.safeParse(output);
    if (parsedOutput.success) {
      return `Search "${parsedOutput.data.action.query.replace(/\s+/gu, " ")}"`;
    }
  }
  return humanizeToolName(name);
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

function dataEntry(
  part: MiniLilacUIMessage["parts"][number],
): Omit<TranscriptEntry, "id"> | undefined {
  const parsed = miniLilacUIMessageDataPartSchema.safeParse(part);
  if (!parsed.success) return undefined;
  switch (parsed.data.type) {
    case "data-session":
      return undefined;
    case "data-control":
      return { kind: "status", tone: "muted", text: controlSummary(parsed.data.data) };
    case "data-transcriptReset":
      return {
        kind: "status",
        tone: "warning",
        text: `transcript rewound (${parsed.data.data.reason})`,
      };
    case "data-outputRollback":
      return undefined;
    case "data-subagentStatus":
      return undefined;
    case "data-compaction":
      return compactionEntry(parsed.data.data);
  }
}

/**
 * Render a provider reasoning summary as a muted transcript entry.
 *
 * Follows OpenCode's convention: a leading `**Title**` block separated by a
 * blank line becomes the header, the remainder renders inline as the body. The
 * header reads `Thinking: <title>` while streaming and `Thought: <title>` once
 * finalized; a missing title falls back to `Thinking`/`Thought`. Summaries
 * without the title convention keep the full text as the body.
 */
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

/** Convert a canonical startup transcript into the same model used by live output. */
export function renderInitialMessages(
  messages: readonly MiniLilacUIMessage[],
  options: TranscriptRenderOptions = {},
): TranscriptEntry[] {
  const rendered = messages.flatMap((message) => {
    const entries: TranscriptEntry[] = [];
    const subagentIndexes = new Map<string, number>();
    let exploration: ExplorationState | undefined;
    const append = (entry: TranscriptEntry) => {
      exploration = undefined;
      entries.push(entry);
    };
    message.parts.forEach((part, index) => {
      const id = `message:${message.id}:${index}`;
      if (part.type === "text") {
        const kind =
          message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "status";
        append({ id, kind, tone: kind === "user" ? "accent" : "normal", text: part.text });
        return;
      }
      if (part.type === "reasoning") {
        append({ id, ...reasoningEntry(part.text, part.state !== "streaming") });
        return;
      }
      if (isToolUIPart(part)) {
        const name = getToolName(part);
        const input =
          part.state === "output-error" && "rawInput" in part ? part.rawInput : part.input;
        const category = explorationCategory(name);
        if (name === "subagent_delegate") {
          let subagent = subagentFromTool(
            part.toolCallId,
            input,
            part.state === "output-available" ? part.output : undefined,
          );
          if (part.state === "output-error") {
            subagent = { ...subagent, state: "error", error: part.errorText };
          } else if (part.state === "output-denied") {
            subagent = { ...subagent, state: "denied", error: "Denied" };
          }
          append({ id, ...subagentEntry(subagent) });
          subagentIndexes.set(part.toolCallId, entries.length - 1);
          return;
        }
        if (category !== undefined) {
          if (exploration === undefined) {
            exploration = {
              id,
              reads: 0,
              searches: 0,
              failures: 0,
              errors: 0,
              cancellations: 0,
              operations: [],
              toolCallIds: [],
              outcomes: new Map(),
              pending: new Set(),
            };
            entries.push({ id, ...explorationEntry(exploration) });
          }
          if (category === "read") exploration.reads += 1;
          else exploration.searches += 1;
          exploration.operations.push(explorationOperation(name, input, options));
          exploration.toolCallIds.push(part.toolCallId);
          if (part.state !== "output-available") {
            if (part.state === "output-error" || part.state === "output-denied") {
              exploration.failures += 1;
              if (part.state === "output-error") exploration.errors += 1;
            } else {
              exploration.pending.add(id);
            }
          }
          exploration.outcomes.set(
            part.toolCallId,
            part.state === "output-error"
              ? "error"
              : part.state === "output-denied"
                ? "denied"
                : undefined,
          );
          const entryIndex = entries.findIndex((entry) => entry.id === exploration?.id);
          if (entryIndex >= 0)
            entries[entryIndex] = { id: exploration.id, ...explorationEntry(exploration) };
          return;
        }
        const state: ToolRenderState =
          part.state === "output-available"
            ? { status: "success", output: part.output }
            : part.state === "output-error"
              ? { status: "error", errorText: part.errorText }
              : part.state === "output-denied"
                ? { status: "denied" }
                : { status: "active" };
        const entry = toolEntry(name, input, state, options);
        if (entry !== undefined) append({ id, ...entry });
        return;
      }
      if (part.type.startsWith("data-")) {
        const parsed = miniLilacUIMessageDataPartSchema.safeParse(part);
        if (parsed.success && parsed.data.type === "data-subagentStatus") {
          const subagent = subagentFromStatus(parsed.data.data);
          const entryIndex = subagentIndexes.get(subagent.toolCallId);
          if (entryIndex !== undefined) {
            entries[entryIndex] = { id: entries[entryIndex]?.id ?? id, ...subagentEntry(subagent) };
          } else {
            append({ id, ...subagentEntry(subagent) });
            subagentIndexes.set(subagent.toolCallId, entries.length - 1);
          }
          return;
        }
        const entry = dataEntry(part);
        if (entry !== undefined) append({ id, ...entry });
        return;
      }
      if (part.type === "file") {
        append({ id, ...fileEntry(part.mediaType, part.filename) });
        return;
      }
      if (part.type === "source-url") {
        append({ id, ...sourceUrlEntry(part.title, part.url) });
        return;
      }
      if (part.type === "source-document") {
        append({ id, ...sourceDocumentEntry(part.title, part.mediaType, part.filename) });
      }
    });
    return entries;
  });
  return rendered;
}

/** Maps AI SDK chunks to plain semantic transcript entries for a UI adapter. */
export class ChunkRenderer {
  private readonly toolNames = new Map<string, string>();
  private readonly toolEntryIds = new Map<string, string>();
  private readonly toolSummaries = new Map<string, string>();
  private readonly toolInputs = new Map<string, unknown>();
  private readonly bashOutputByToolId = new Map<string, string>();
  private readonly flattenedBatchToolIds = new Set<string>();
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
    private readonly options: TranscriptRenderOptions = {},
  ) {}

  startRun(): void {
    this.resetTransientState();
  }

  handle(chunk: UIMessageChunk): void {
    if (chunk.type.startsWith("data-")) {
      this.handleData(chunk);
      return;
    }

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
      case "tool-input-start":
        this.renderToolStart(chunk.toolCallId, chunk.toolName);
        return;
      case "tool-input-delta":
        return;
      case "tool-input-available":
        this.renderToolStart(chunk.toolCallId, chunk.toolName, chunk.input, true);
        return;
      case "tool-input-error":
        this.renderToolStart(chunk.toolCallId, chunk.toolName, chunk.input, true);
        this.renderToolError(chunk.toolCallId, chunk.errorText);
        return;
      case "tool-output-available":
        this.renderToolOutput(chunk.toolCallId, chunk.output, chunk.preliminary === true);
        return;
      case "tool-output-error":
        this.renderToolError(chunk.toolCallId, chunk.errorText);
        return;
      case "tool-output-denied":
        this.renderToolDenied(chunk.toolCallId);
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
      case "abort":
        this.finishOpenText();
        this.finalizeReasoning();
        this.cancelActiveTools(chunk.reason);
        this.append({
          kind: "status",
          tone: "muted",
          text: `aborted${chunk.reason !== undefined ? `: ${chunk.reason}` : ""}`,
        });
        return;
      default:
        return;
    }
  }

  private handleData(chunk: UIMessageChunk): void {
    const todos = miniLilacTodoChunkSchema.safeParse(chunk);
    if (todos.success) {
      this.hooks.onTodos?.(todos.data.data);
      return;
    }
    const parsed = miniLilacUIMessageDataPartSchema.safeParse(chunk);
    if (!parsed.success) return;
    const part = parsed.data;
    switch (part.type) {
      case "data-session":
        this.hooks.onSnapshot(part.data);
        return;
      case "data-control":
        this.hooks.onControl?.(part.data);
        this.append({ kind: "status", tone: "muted", text: controlSummary(part.data) });
        return;
      case "data-transcriptReset":
        this.resetTransientState();
        this.hooks.onTranscriptReset(part.data);
        this.append({
          kind: "status",
          tone: "warning",
          text: `transcript rewound (${part.data.reason}); canonical transcript will be reconciled`,
        });
        return;
      case "data-outputRollback":
        this.rollbackOutput(part.data);
        this.hooks.onOutputRollback?.(part.data);
        return;
      case "data-subagentStatus":
        this.renderSubagentStatus(part.data);
        return;
      case "data-compaction":
        this.renderCompaction(part.id, part.data);
        return;
    }
  }

  /**
   * Compaction publishes its whole lifecycle under one chunk id, so the entry is
   * updated in place. Appending each phase instead would turn a single
   * compaction into a wall of started/progress/summary lines.
   */
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
    const subagent = subagentFromStatus(status);
    this.toolNames.set(status.toolCallId, "subagent_delegate");
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

  private renderToolStart(
    toolCallId: string,
    toolName: string,
    input?: unknown,
    inputAvailable = false,
  ): void {
    this.toolNames.set(toolCallId, toolName);
    this.activeToolIds.add(toolCallId);
    if (inputAvailable) this.toolInputs.set(toolCallId, input);
    this.finalizeReasoning();
    if (toolName === "subagent_result") return;
    if (toolName === "subagent_delegate") {
      const parsed = subagentFromTool(toolCallId, input);
      const existing = this.subagents.get(toolCallId);
      const subagent =
        existing === undefined
          ? parsed
          : { ...existing, profile: parsed.profile, prompt: parsed.prompt, mode: parsed.mode };
      this.subagents.set(toolCallId, subagent);
      if (subagent.state !== "pending" && subagent.state !== "running") {
        this.activeToolIds.delete(toolCallId);
      }
      const existingId = this.toolEntryIds.get(toolCallId);
      if (existingId === undefined) {
        this.toolEntryIds.set(toolCallId, this.append(subagentEntry(subagent)));
      } else if (inputAvailable) {
        this.output.update(existingId, subagentEntry(subagent));
      }
      return;
    }
    if (toolName === "batch") {
      this.flattenedBatchToolIds.add(toolCallId);
      return;
    }
    const category = explorationCategory(toolName);
    if (category !== undefined) {
      if (!inputAvailable || this.explorationByToolId.has(toolCallId)) return;
      if (this.exploration === undefined) {
        const state: ExplorationState = {
          id: "",
          reads: category === "read" ? 1 : 0,
          searches: category === "search" ? 1 : 0,
          failures: 0,
          errors: 0,
          cancellations: 0,
          operations: [explorationOperation(toolName, input, this.options)],
          toolCallIds: [toolCallId],
          outcomes: new Map([[toolCallId, undefined]]),
          pending: new Set([toolCallId]),
        };
        state.id = this.output.append(explorationEntry(state));
        this.exploration = state;
      } else {
        if (category === "read") this.exploration.reads += 1;
        else this.exploration.searches += 1;
        this.exploration.operations.push(explorationOperation(toolName, input, this.options));
        this.exploration.toolCallIds.push(toolCallId);
        this.exploration.outcomes.set(toolCallId, undefined);
        this.exploration.pending.add(toolCallId);
        this.output.update(this.exploration.id, explorationEntry(this.exploration));
      }
      this.explorationByToolId.set(toolCallId, this.exploration);
      this.toolEntryIds.set(toolCallId, this.exploration.id);
      return;
    }
    const summary = toolSummary(toolName, input);
    if (inputAvailable || !this.toolSummaries.has(toolCallId)) {
      this.toolSummaries.set(toolCallId, summary);
    }
    const existingId = this.toolEntryIds.get(toolCallId);
    if (existingId !== undefined) {
      if (inputAvailable) {
        this.output.update(
          existingId,
          toolEntry(toolName, input, { status: "active" }, this.options) ?? {
            kind: "tool",
            tone: "accent",
            text: summary,
            running: true,
          },
        );
      }
      return;
    }
    const entry = toolEntry(toolName, input, { status: "active" }, this.options) ?? {
      kind: "tool" as const,
      tone: "accent" as const,
      text: summary,
      running: true,
    };
    const id = this.append(entry);
    this.toolEntryIds.set(toolCallId, id);
  }

  private renderToolOutput(toolCallId: string, output: unknown, preliminary: boolean): void {
    const name = this.toolNames.get(toolCallId) ?? "tool";
    if (name === "subagent_result") {
      if (!preliminary) this.activeToolIds.delete(toolCallId);
      return;
    }
    if (name === "subagent_delegate") {
      if (preliminary) return;
      const existing = this.subagents.get(toolCallId);
      if (existing?.state === "completed" || existing?.state === "cancelled") {
        this.activeToolIds.delete(toolCallId);
        return;
      }
      const subagent = subagentFromTool(toolCallId, this.toolInputs.get(toolCallId), output);
      const merged = { ...subagent, toolCount: existing?.toolCount ?? subagent.toolCount };
      this.subagents.set(toolCallId, merged);
      if (merged.state === "pending" || merged.state === "running") {
        this.activeToolIds.add(toolCallId);
      } else {
        this.activeToolIds.delete(toolCallId);
      }
      const id = this.toolEntryIds.get(toolCallId);
      if (id === undefined) this.toolEntryIds.set(toolCallId, this.append(subagentEntry(merged)));
      else this.output.update(id, subagentEntry(merged));
      return;
    }
    if (preliminary) {
      if (name !== "bash") return;
      const parsed = bashOutputDeltaSchema.safeParse(output);
      if (!parsed.success) return;
      const partial = `${this.bashOutputByToolId.get(toolCallId) ?? ""}${parsed.data.delta}`;
      this.bashOutputByToolId.set(toolCallId, partial);
      let id = this.toolEntryIds.get(toolCallId);
      if (id === undefined) {
        this.renderToolStart(toolCallId, name);
        id = this.toolEntryIds.get(toolCallId);
      }
      if (id === undefined) return;
      this.output.update(
        id,
        toolEntry(
          name,
          this.toolInputs.get(toolCallId),
          { status: "active", output: { stdout: partial } },
          this.options,
        ) ?? {
          kind: "tool",
          tone: "accent",
          text: this.toolSummaries.get(toolCallId) ?? "Bash",
          running: true,
        },
      );
      return;
    }
    this.activeToolIds.delete(toolCallId);
    const partial = this.bashOutputByToolId.get(toolCallId);
    this.bashOutputByToolId.delete(toolCallId);
    if (this.flattenedBatchToolIds.has(toolCallId)) return;
    if (this.explorationByToolId.has(toolCallId)) {
      this.settleExploration(toolCallId);
      return;
    }
    const id = this.toolEntryIds.get(toolCallId);
    if (id === undefined) {
      this.renderToolStart(toolCallId, name);
      return this.renderToolOutput(toolCallId, output, false);
    }
    this.output.update(
      id,
      toolEntry(
        name,
        this.toolInputs.get(toolCallId),
        {
          status: "success",
          output:
            name === "bash" && !bashOutputSchema.safeParse(output).success && partial !== undefined
              ? { stdout: partial }
              : output,
        },
        this.options,
      ) ?? {
        kind: "tool",
        tone: "success",
        text: this.toolSummaries.get(toolCallId) ?? toolSummary(name, undefined),
      },
    );
  }

  private renderToolError(toolCallId: string, errorText: string): void {
    this.activeToolIds.delete(toolCallId);
    this.bashOutputByToolId.delete(toolCallId);
    const name = this.toolNames.get(toolCallId) ?? "tool";
    if (name === "subagent_result") return;
    if (name === "subagent_delegate") {
      const existing = this.subagents.get(toolCallId);
      const subagent: SubagentTranscript = {
        ...(existing ?? subagentFromTool(toolCallId, this.toolInputs.get(toolCallId))),
        state: "error",
        error: errorText,
      };
      this.subagents.set(toolCallId, subagent);
      const id = this.toolEntryIds.get(toolCallId);
      if (id === undefined) this.toolEntryIds.set(toolCallId, this.append(subagentEntry(subagent)));
      else this.output.update(id, subagentEntry(subagent));
      return;
    }
    if (this.explorationByToolId.has(toolCallId)) {
      this.settleExploration(toolCallId, "error");
      return;
    }
    if (this.flattenedBatchToolIds.has(toolCallId)) {
      const id = this.append(
        toolEntry(
          name,
          this.toolInputs.get(toolCallId),
          { status: "error", errorText },
          this.options,
        ) ?? {
          kind: "tool",
          tone: "danger",
          text: toolErrorSummary("Parallel tools", errorText),
        },
      );
      this.toolEntryIds.set(toolCallId, id);
      return;
    }
    const id = this.toolEntryIds.get(toolCallId);
    const entry = toolEntry(
      name,
      this.toolInputs.get(toolCallId),
      {
        status: "error",
        errorText,
      },
      this.options,
    ) ?? {
      kind: "tool" as const,
      tone: "danger" as const,
      text: toolErrorSummary(
        this.toolSummaries.get(toolCallId) ?? toolSummary(name, undefined),
        errorText,
      ),
    };
    if (id === undefined) this.append(entry);
    else this.output.update(id, entry);
  }

  private renderToolDenied(toolCallId: string): void {
    this.activeToolIds.delete(toolCallId);
    this.bashOutputByToolId.delete(toolCallId);
    const name = this.toolNames.get(toolCallId) ?? "tool";
    if (name === "subagent_result") return;
    if (name === "subagent_delegate") {
      const existing = this.subagents.get(toolCallId);
      const subagent: SubagentTranscript = {
        ...(existing ?? subagentFromTool(toolCallId, this.toolInputs.get(toolCallId))),
        state: "denied",
        error: "Denied",
      };
      this.subagents.set(toolCallId, subagent);
      const id = this.toolEntryIds.get(toolCallId);
      if (id === undefined) this.toolEntryIds.set(toolCallId, this.append(subagentEntry(subagent)));
      else this.output.update(id, subagentEntry(subagent));
      return;
    }
    if (this.explorationByToolId.has(toolCallId)) {
      this.settleExploration(toolCallId, "denied");
      return;
    }
    if (this.flattenedBatchToolIds.has(toolCallId)) return;
    const id = this.toolEntryIds.get(toolCallId);
    const entry = toolEntry(
      name,
      this.toolInputs.get(toolCallId),
      { status: "denied" },
      this.options,
    ) ?? {
      kind: "tool" as const,
      tone: "warning" as const,
      text: `${this.toolSummaries.get(toolCallId) ?? toolSummary(name, undefined)}: denied`,
    };
    if (id === undefined) this.append(entry);
    else this.output.update(id, entry);
  }

  private append(entry: Omit<TranscriptEntry, "id">): string {
    if (entry.kind !== "exploration" && this.exploration !== undefined) {
      this.output.update(this.exploration.id, explorationEntry(this.exploration));
      this.exploration = undefined;
    }
    return this.output.append(entry);
  }

  private settleExploration(toolCallId: string, failure?: "error" | "denied" | "cancelled"): void {
    const state = this.explorationByToolId.get(toolCallId);
    if (state === undefined) return;
    state.pending.delete(toolCallId);
    state.outcomes.set(toolCallId, failure);
    if (failure === "error" || failure === "denied") state.failures += 1;
    if (failure === "error") state.errors += 1;
    if (failure === "cancelled") state.cancellations += 1;
    this.output.update(state.id, explorationEntry(state));
  }

  private cancelActiveTools(reason: string | undefined): void {
    for (const toolCallId of this.activeToolIds) {
      const name = this.toolNames.get(toolCallId) ?? "tool";
      if (name === "subagent_result" || this.flattenedBatchToolIds.has(toolCallId)) continue;
      if (name === "subagent_delegate") {
        const existing = this.subagents.get(toolCallId);
        const subagent: SubagentTranscript = {
          ...(existing ?? subagentFromTool(toolCallId, this.toolInputs.get(toolCallId))),
          state: "cancelled",
          error: `Cancelled${reason === undefined ? "" : `: ${reason}`}`,
        };
        this.subagents.set(toolCallId, subagent);
        const id = this.toolEntryIds.get(toolCallId);
        if (id === undefined)
          this.toolEntryIds.set(toolCallId, this.append(subagentEntry(subagent)));
        else this.output.update(id, subagentEntry(subagent));
        continue;
      }
      if (this.explorationByToolId.has(toolCallId)) {
        this.settleExploration(toolCallId, "cancelled");
        continue;
      }
      const id = this.toolEntryIds.get(toolCallId);
      if (id === undefined) continue;
      const partial = this.bashOutputByToolId.get(toolCallId);
      this.output.update(
        id,
        toolEntry(
          name,
          this.toolInputs.get(toolCallId),
          {
            status: "cancelled",
            ...(reason === undefined ? {} : { reason }),
            ...(name === "bash" && partial !== undefined ? { output: { stdout: partial } } : {}),
          },
          this.options,
        ) ?? {
          kind: "tool",
          tone: "muted",
          text: `${this.toolSummaries.get(toolCallId) ?? toolSummary(name, undefined)}: cancelled`,
        },
      );
    }
    this.activeToolIds.clear();
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
        if (index >= 0) {
          exploration.toolCallIds.splice(index, 1);
          exploration.operations.splice(index, 1);
          const category = explorationCategory(this.toolNames.get(toolCallId) ?? "");
          if (category === "read") exploration.reads -= 1;
          if (category === "search") exploration.searches -= 1;
          const outcome = exploration.outcomes.get(toolCallId);
          if (outcome === "error" || outcome === "denied") exploration.failures -= 1;
          if (outcome === "error") exploration.errors -= 1;
          if (outcome === "cancelled") exploration.cancellations -= 1;
        }
        exploration.pending.delete(toolCallId);
        exploration.outcomes.delete(toolCallId);
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
      this.toolNames.delete(toolCallId);
      this.toolEntryIds.delete(toolCallId);
      this.toolSummaries.delete(toolCallId);
      this.toolInputs.delete(toolCallId);
      this.bashOutputByToolId.delete(toolCallId);
      this.flattenedBatchToolIds.delete(toolCallId);
      this.subagents.delete(toolCallId);
    }
  }

  private startReasoning(chunkId: string): void {
    if (this.reasoningEntries.has(chunkId)) return;
    const id = this.append(reasoningEntry("", false));
    this.reasoningEntries.set(chunkId, { id, text: "" });
  }

  private appendReasoning(chunkId: string, delta: string): void {
    // Codex may stream deltas without an explicit reasoning-start; open lazily.
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

  // Codex may omit reasoning-end, so finalize any open entries when a text,
  // tool, or finish boundary is reached. Each chunk keeps its own entry so
  // separate reasoning blocks never merge.
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
    this.toolNames.clear();
    this.toolEntryIds.clear();
    this.toolSummaries.clear();
    this.toolInputs.clear();
    this.bashOutputByToolId.clear();
    this.flattenedBatchToolIds.clear();
    this.activeToolIds.clear();
    this.explorationByToolId.clear();
    this.subagents.clear();
    this.exploration = undefined;
    this.textEntryIds.clear();
    this.reasoningEntries.clear();
    this.compactionEntryIds.clear();
  }
}
