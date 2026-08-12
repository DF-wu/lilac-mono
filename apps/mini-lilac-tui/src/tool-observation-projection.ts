import { posix } from "node:path";

import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import {
  MINI_LILAC_TOOL_NAMES,
  miniLilacSkillSummarySchema,
  miniLilacTodoWriteInputSchema,
  miniLilacWebfetchUrlSchema,
  normalizeMiniLilacToolName,
} from "@stanley2058/mini-lilac-client";

import { captureTuiOperation } from "./failure-adapter";

const KNOWN_TOOL_NAMES = MINI_LILAC_TOOL_NAMES;

type KnownToolName = (typeof MINI_LILAC_TOOL_NAMES)[number];

export type ToolObservation =
  | { readonly toolName: string; readonly lifecycle: "pending" }
  | {
      readonly toolName: string;
      readonly lifecycle: "active";
      readonly input: unknown;
      readonly partial?: unknown;
    }
  | {
      readonly toolName: string;
      readonly lifecycle: "approval";
      readonly input: unknown;
    }
  | {
      readonly toolName: string;
      readonly lifecycle: "success";
      readonly input: unknown;
      readonly output: unknown;
      readonly partial?: unknown;
    }
  | {
      readonly toolName: string;
      readonly lifecycle: "error";
      readonly input: unknown;
      readonly errorText: string;
      readonly partial?: unknown;
    }
  | {
      readonly toolName: string;
      readonly lifecycle: "denied";
      readonly input: unknown;
    }
  | {
      readonly toolName: string;
      readonly lifecycle: "cancelled";
      readonly input: unknown;
      readonly reason?: string;
      readonly partial?: unknown;
    };

export type ToolObservationLifecycle = ToolObservation["lifecycle"];
export type ToolProjectionTone = "normal" | "muted" | "accent" | "success" | "warning" | "danger";

export type ToolProjectionState =
  | { readonly status: "pending" }
  | { readonly status: "active" }
  | { readonly status: "approval" }
  | { readonly status: "success" }
  | { readonly status: "error"; readonly errorText: string }
  | { readonly status: "denied" }
  | { readonly status: "cancelled"; readonly reason?: string };

type BashExecutionError =
  | { readonly type: "blocked"; readonly reason: string }
  | { readonly type: "aborted" }
  | {
      readonly type: "timeout";
      readonly timeoutMs: number;
      readonly timeoutKind: "no_output" | "wall_clock";
    }
  | { readonly type: "exception"; readonly message: string };

interface BashOutputData {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly executionError?: BashExecutionError;
}

interface BashDecodedObservation {
  readonly toolName: "bash";
  readonly state: ToolProjectionState;
  readonly command?: string;
  readonly cwd?: string;
  readonly resultText?: string;
  readonly resultTone: "normal" | "muted" | "danger";
  readonly outputDelta?: string;
}

interface ReadDecodedObservation {
  readonly toolName: "read";
  readonly state: ToolProjectionState;
  readonly path?: string;
  readonly start?:
    | { readonly offset: number }
    | { readonly line: number; readonly column?: number };
  readonly maxLines?: number;
  readonly maxCharacters?: number;
}

interface GlobDecodedObservation {
  readonly toolName: "glob";
  readonly state: ToolProjectionState;
  readonly patterns?: readonly string[];
  readonly cwd?: string;
}

interface GrepDecodedObservation {
  readonly toolName: "grep";
  readonly state: ToolProjectionState;
  readonly pattern?: string;
  readonly path?: string;
}

interface FuzzyDecodedObservation {
  readonly toolName: "fuzzy_search";
  readonly state: ToolProjectionState;
  readonly query?: string;
  readonly cwd?: string;
}

interface EditInput {
  readonly path: string;
  readonly oldText?: string;
  readonly newText?: string;
  readonly edits?: readonly {
    readonly op: "replace" | "append" | "prepend";
    readonly pos: string;
    readonly end?: string;
    readonly lines?: string | readonly string[] | null;
  }[];
}

interface EditFileDecodedObservation {
  readonly toolName: "edit";
  readonly state: ToolProjectionState;
  readonly edit?: EditInput;
  readonly replacementsMade: number;
}

interface ApplyPatchDecodedObservation {
  readonly toolName: "patch";
  readonly state: ToolProjectionState;
  readonly patchText?: string;
  readonly cwd?: string;
}

interface SubagentDelegateDecodedObservation {
  readonly toolName: "subagent_delegate";
  readonly state: ToolProjectionState;
  readonly profile: string;
  readonly prompt: string;
  readonly mode: "sync" | "deferred";
  readonly sessionName?: string;
  readonly result?: {
    readonly status: "accepted" | "completed" | "cancelled" | "error" | "rejected";
    readonly childRunId?: string;
    readonly childSessionId?: string;
    readonly sessionName?: string;
    readonly profile?: string;
    readonly text?: string;
    readonly error?: string;
    readonly reason?: string;
  };
}

interface SubagentResultDecodedObservation {
  readonly toolName: "subagent_result";
  readonly state: ToolProjectionState;
}

interface BatchDecodedObservation {
  readonly toolName: "batch";
  readonly state: ToolProjectionState;
  readonly toolCount?: number;
}

interface SkillDecodedObservation {
  readonly toolName: "skill";
  readonly state: ToolProjectionState;
  readonly name?: string;
}

interface TodoDecodedObservation {
  readonly toolName: "todowrite";
  readonly state: ToolProjectionState;
  readonly todoCount?: number;
}

interface WebfetchDecodedObservation {
  readonly toolName: "webfetch";
  readonly state: ToolProjectionState;
  readonly url?: string;
}

interface WebsearchDecodedObservation {
  readonly toolName: "websearch";
  readonly state: ToolProjectionState;
  readonly query?: string;
}

export type DecodedKnownToolObservation =
  | BashDecodedObservation
  | ReadDecodedObservation
  | GlobDecodedObservation
  | GrepDecodedObservation
  | FuzzyDecodedObservation
  | EditFileDecodedObservation
  | ApplyPatchDecodedObservation
  | SubagentDelegateDecodedObservation
  | SubagentResultDecodedObservation
  | BatchDecodedObservation
  | SkillDecodedObservation
  | TodoDecodedObservation
  | WebfetchDecodedObservation
  | WebsearchDecodedObservation;

export interface ProjectedEditOperation {
  readonly action: "Patch" | "Edit";
  readonly path: string;
  readonly added: number;
  readonly removed: number;
}

interface ToolProjectionBase {
  readonly lifecycle: ToolObservationLifecycle;
  readonly state: ToolProjectionState;
  readonly tone: ToolProjectionTone;
  readonly summary: string;
  readonly headline: string;
  readonly running: boolean;
  readonly singleLine: boolean;
  readonly visibility: "visible" | "hidden";
}

export type ToolProjection =
  | (ToolProjectionBase & {
      readonly kind: "bash";
      readonly toolName: "bash";
      readonly command?: string;
      readonly cwd?: string;
      readonly resultText?: string;
      readonly outputDelta?: string;
    })
  | (ToolProjectionBase & {
      readonly kind: "exploration";
      readonly toolName: "read" | "glob" | "grep" | "fuzzy_search";
      readonly action: "Read" | "Glob" | "Grep" | "Find";
      readonly detail?: string;
      readonly operationStatus: "pending" | "success" | "error" | "denied" | "cancelled";
      readonly error?: string;
    })
  | (ToolProjectionBase & {
      readonly kind: "edit";
      readonly toolName: "edit" | "patch";
      readonly operations: readonly ProjectedEditOperation[];
    })
  | (ToolProjectionBase & {
      readonly kind: "subagent-delegate";
      readonly toolName: "subagent_delegate";
      readonly profile: string;
      readonly prompt: string;
      readonly mode: "sync" | "deferred";
      readonly sessionName?: string;
      readonly childRunId?: string;
      readonly childSessionId?: string;
      readonly resultStatus?: "accepted" | "completed" | "cancelled" | "error" | "rejected";
      readonly resultText?: string;
      readonly error?: string;
    })
  | (ToolProjectionBase & {
      readonly kind: "subagent-result";
      readonly toolName: "subagent_result";
    })
  | (ToolProjectionBase & {
      readonly kind: "batch";
      readonly toolName: "batch";
      readonly toolCount?: number;
    })
  | (ToolProjectionBase & {
      readonly kind: "skill";
      readonly toolName: "skill";
      readonly name?: string;
    })
  | (ToolProjectionBase & {
      readonly kind: "todo";
      readonly toolName: "todowrite";
      readonly todoCount?: number;
    })
  | (ToolProjectionBase & {
      readonly kind: "webfetch";
      readonly toolName: "webfetch";
      readonly url?: string;
    })
  | (ToolProjectionBase & {
      readonly kind: "websearch";
      readonly toolName: "websearch";
      readonly query?: string;
    })
  | (ToolProjectionBase & {
      readonly kind: "malformed-known-tool";
      readonly toolName: KnownToolName;
      readonly malformedField: "input" | "output" | "partial";
      readonly payloadPreview: string;
    })
  | (ToolProjectionBase & {
      readonly kind: "unknown-tool";
      readonly toolName: string;
      readonly payloadPreview: string;
    });

export class KnownToolObservationMalformed extends TaggedError("KnownToolObservationMalformed")<{
  readonly toolName: KnownToolName;
  readonly lifecycle: ToolObservationLifecycle;
  readonly field: "input" | "output" | "partial";
  readonly payloadPreview: string;
  readonly message: string;
}> {
  declare readonly cause?: never;
}

const knownToolNameSet: ReadonlySet<string> = new Set(KNOWN_TOOL_NAMES);

function isKnownToolName(name: string): name is KnownToolName {
  return knownToolNameSet.has(name);
}

const readInputSchema = z.object({
  path: z.string(),
  cwd: z.string().optional(),
  start: z
    .union([
      z.object({ offset: z.number().int().nonnegative() }),
      z.object({
        line: z.number().int().positive(),
        column: z.number().int().nonnegative().optional(),
      }),
      z.object({ type: z.literal("offset"), offset: z.number().int().nonnegative() }),
      z.object({
        type: z.literal("line"),
        line: z.number().int().positive(),
        column: z.number().int().nonnegative().optional(),
      }),
    ])
    .optional(),
  maxLines: z.number().int().positive().optional(),
  maxCharacters: z.number().int().positive().max(40_960).optional(),
  format: z.enum(["raw", "numbered", "hashline"]).optional(),
  dangerouslyAllow: z.boolean().optional(),
});
const bashInputSchema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
  timeoutMs: z.number().nonnegative().optional(),
  stdinMode: z.enum(["error", "eof"]).optional(),
  dangerouslyAllow: z.boolean().optional(),
});
const globInputSchema = z.object({
  patterns: z.array(z.string().min(1)).min(1).max(100),
  cwd: z.string().optional(),
  maxEntries: z.number().int().positive().max(10_000).optional(),
  mode: z.enum(["default", "detailed"]).optional(),
  dangerouslyAllow: z.boolean().optional(),
});
const grepInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  regex: z.boolean().optional(),
  maxResults: z.number().int().positive().max(10_000).optional(),
  fileExtensions: z.array(z.string().min(1)).max(100).optional(),
  includeContextLines: z.number().int().nonnegative().max(100).optional(),
  mode: z.enum(["default", "detailed", "hashline"]).optional(),
  dangerouslyAllow: z.boolean().optional(),
});
const fuzzyInputSchema = z.object({
  query: z.string().min(1),
  cwd: z.string().optional(),
  maxResults: z.number().int().positive().max(10_000).optional(),
  dangerouslyAllow: z.boolean().optional(),
});
const patchInputSchema = z.object({
  patchText: z.string(),
  cwd: z.string().optional(),
  dangerouslyAllow: z.boolean().optional(),
});
const hashlineEditSchema = z.object({
  op: z.enum(["replace", "append", "prepend"]),
  pos: z.string().min(1),
  end: z.string().min(1).optional(),
  lines: z.union([z.string(), z.array(z.string()), z.null()]).optional(),
});
const editInputSchema = z.union([
  z.object({
    path: z.string(),
    cwd: z.string().optional(),
    oldText: z.string().min(1),
    newText: z.string(),
    matching: z.enum(["exact", "regex"]).optional(),
    replaceAll: z.boolean().optional(),
    expectedMatches: z.union([z.literal("any"), z.number().int().positive()]).optional(),
    expectedHash: z.string().optional(),
    dangerouslyAllow: z.boolean().optional(),
  }),
  z.object({
    path: z.string(),
    cwd: z.string().optional(),
    edits: z.array(hashlineEditSchema).min(1),
    expectedHash: z.string().optional(),
    dangerouslyAllow: z.boolean().optional(),
  }),
]);
const editErrorCodeSchema = z.enum([
  "NOT_FOUND",
  "PERMISSION",
  "UNKNOWN",
  "NOT_READ",
  "HASH_MISMATCH",
  "INVALID_RANGE",
  "RANGE_MISMATCH",
  "NO_MATCHES",
  "TOO_MANY_MATCHES",
  "NOT_ENOUGH_MATCHES",
  "INVALID_REGEX",
  "INVALID_EDIT",
  "STALE_ANCHOR",
]);
const fileEditSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("replace_range"),
      range: z.object({ startLine: z.number(), endLine: z.number() }).strict(),
      newText: z.string(),
      expectedOldText: z.string().optional(),
    })
    .strict(),
  z.object({ type: z.literal("insert_at"), line: z.number(), newText: z.string() }).strict(),
  z
    .object({
      type: z.literal("delete_range"),
      range: z.object({ startLine: z.number(), endLine: z.number() }).strict(),
      expectedOldText: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("replace_snippet"),
      target: z.string(),
      matching: z.enum(["exact", "regex"]).optional(),
      newText: z.string(),
      occurrence: z.union([z.literal("first"), z.literal("all"), z.number()]).optional(),
      expectedMatches: z.union([z.number(), z.literal("any")]).optional(),
    })
    .strict(),
]);
const editErrorSchema = z.object({ code: editErrorCodeSchema, message: z.string() }).strict();
const editOutputSchema = z.discriminatedUnion("success", [
  z
    .object({
      success: z.literal(true),
      resolvedPath: z.string(),
      oldHash: z.string(),
      newHash: z.string(),
      changesMade: z.boolean(),
      replacementsMade: z.number(),
    })
    .strict(),
  z
    .object({
      success: z.literal(false),
      resolvedPath: z.string(),
      currentHash: z.string().optional(),
      error: editErrorSchema,
      errors: z
        .array(
          z
            .object({
              code: editErrorCodeSchema,
              message: z.string(),
              editIndex: z.number(),
              edit: fileEditSchema,
            })
            .strict(),
        )
        .optional(),
    })
    .strict(),
]);
const bashExecutionErrorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("blocked"), reason: z.string(), segment: z.string().optional() }),
  z.object({ type: z.literal("aborted"), signal: z.literal("SIGTERM") }),
  z.object({
    type: z.literal("timeout"),
    timeoutMs: z.number().nonnegative(),
    timeoutKind: z.enum(["no_output", "wall_clock"]).optional().default("wall_clock"),
    signal: z.literal("SIGTERM"),
  }),
  z.object({ type: z.literal("exception"), message: z.string() }),
]);
const bashTruncationSchema = z.object({
  artifactUri: z.string().optional(),
  artifactBytes: z.number().int().nonnegative().optional(),
  message: z.string(),
  originalStdoutBytes: z.number().int().nonnegative(),
  originalStderrBytes: z.number().int().nonnegative(),
  previewBytes: z.number().int().nonnegative(),
  completeOutputRetained: z.boolean(),
  retentionStatus: z.enum([
    "retained",
    "spool-limit-exceeded",
    "spool-unavailable",
    "artifact-write-failed",
    "identity-unavailable",
  ]),
});
const bashStructuredOutputSchema = z
  .object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().int(),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
    executionError: bashExecutionErrorSchema.optional(),
    truncation: bashTruncationSchema.optional(),
  })
  .strict();
const bashOutputSchema = z.union([z.string(), bashStructuredOutputSchema]);
const bashPartialSchema = z.object({ type: z.literal("output-delta"), delta: z.string() });
const subagentSessionNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const subagentInputSchema = z
  .object({
    profile: z.string().min(1),
    prompt: z.string().trim().min(1),
    mode: z.enum(["sync", "deferred"]).default("sync"),
    model: z.string().trim().min(1).optional(),
    effort: z
      .enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"])
      .optional(),
    sessionName: subagentSessionNameSchema.optional(),
  })
  .strict();
const subagentTerminalResultSchema = z
  .object({
    status: z.enum(["completed", "cancelled", "error"]),
    childRunId: z.string().min(1),
    childSessionId: z.string().min(1),
    sessionName: subagentSessionNameSchema,
    profile: z.string().min(1),
    text: z.string(),
    error: z.string().optional(),
  })
  .strict();
const subagentResultSchema = z.union([
  z
    .object({
      status: z.literal("accepted"),
      childRunId: z.string().min(1),
      childSessionId: z.string().min(1),
      sessionName: subagentSessionNameSchema,
      profile: z.string().min(1),
      mode: z.literal("deferred"),
    })
    .strict(),
  subagentTerminalResultSchema,
  z
    .object({
      status: z.literal("rejected"),
      reason: z.string().min(1),
      childSessionId: z.string().min(1).optional(),
      sessionName: subagentSessionNameSchema.optional(),
    })
    .strict(),
]);
const subagentResultInputSchema = z
  .object({ childRunId: z.string().min(1), profile: z.string().min(1) })
  .strict();
const batchInputSchema = z
  .object({
    tool_calls: z
      .array(
        z
          .object({
            tool: z.string().min(1),
            parameters: z.record(z.string(), z.unknown()).optional().default({}),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();
const skillInputSchema = z.strictObject({ name: miniLilacSkillSummarySchema.shape.name });
const todoWriteInputSchema = miniLilacTodoWriteInputSchema;
const webfetchInputSchema = z
  .object({
    url: miniLilacWebfetchUrlSchema,
    format: z.enum(["text", "markdown", "html"]).optional().default("markdown"),
    timeoutMs: z.number().int().positive().max(120_000).optional().default(30_000),
    maxCharacters: z.number().int().positive().max(200_000).optional().default(50_000),
  })
  .strict();
const websearchInputSchema = z.object({ query: z.string().trim().min(1).optional() });
const websearchOutputSchema = z.object({ action: z.object({ query: z.string().trim().min(1) }) });

function previewText(value: string, max: number): string {
  if (max <= 0) return "";
  const boundedSource = value.slice(0, max * 4);
  const singleLine = boundedSource.replace(/\s+/gu, " ").trim();
  if (singleLine.length <= max && boundedSource.length === value.length) return singleLine;
  if (max <= 3) return ".".repeat(max);
  return `${singleLine.slice(0, Math.max(0, max - 3))}...`;
}

/** A non-reflective fallback preview. Object properties and hooks are never inspected. */
function safeToolPayloadPreview<T>(value: T, max = 120): string {
  const limit = Number.isFinite(max) ? Math.min(256, Math.max(0, Math.floor(max))) : 120;
  switch (typeof value) {
    case "string":
      return previewText(value, limit);
    case "number":
      if (Number.isNaN(value)) return "NaN";
      if (value === Number.POSITIVE_INFINITY) return "Infinity";
      if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
      return value.toString();
    case "bigint":
      return value.toString();
    case "boolean":
      return value ? "true" : "false";
    case "undefined":
      return "undefined";
    case "symbol":
      return "<symbol>";
    case "function":
      return "<function>";
    case "object":
      return value === null ? "null" : "<object>";
  }
  return "<unavailable>";
}

function malformedError<T>(
  observation: ToolObservation & { readonly toolName: KnownToolName },
  field: "input" | "output" | "partial",
  value: T,
): KnownToolObservationMalformed {
  return new KnownToolObservationMalformed({
    toolName: observation.toolName,
    lifecycle: observation.lifecycle,
    field,
    payloadPreview: safeToolPayloadPreview(value),
    message: `Malformed ${observation.toolName} ${field}`,
  });
}

function malformed<T>(
  observation: ToolObservation & { readonly toolName: KnownToolName },
  field: "input" | "output" | "partial",
  value: T,
): ResultType<never, KnownToolObservationMalformed> {
  return Result.err(malformedError(observation, field, value));
}

function stateFromObservation(observation: ToolObservation): ToolProjectionState {
  switch (observation.lifecycle) {
    case "pending":
      return { status: "pending" };
    case "active":
      return { status: "active" };
    case "approval":
      return { status: "approval" };
    case "success":
      return { status: "success" };
    case "error":
      return { status: "error", errorText: previewText(observation.errorText, 180) };
    case "denied":
      return { status: "denied" };
    case "cancelled":
      return {
        status: "cancelled",
        ...(observation.reason === undefined
          ? {}
          : { reason: previewText(observation.reason, 160) }),
      };
  }
}

function parseInput<T>(
  observation: ToolObservation & { readonly toolName: KnownToolName },
  schema: z.ZodType<T>,
  field: "input" | "output" | "partial" = "input",
  optional = false,
): ResultType<T | undefined, KnownToolObservationMalformed> {
  if (field === "input" && observation.lifecycle === "pending") return Result.ok(undefined);
  let value: unknown;
  const attempted = captureTuiOperation(
    () => {
      switch (field) {
        case "input":
          value = observation.lifecycle === "pending" ? undefined : observation.input;
          break;
        case "output":
          value = observation.lifecycle === "success" ? observation.output : undefined;
          break;
        case "partial":
          value =
            observation.lifecycle === "active" ||
            observation.lifecycle === "success" ||
            observation.lifecycle === "error" ||
            observation.lifecycle === "cancelled"
              ? observation.partial
              : undefined;
          break;
      }
      return optional && value === undefined ? undefined : schema.safeParse(value);
    },
    () => malformedError(observation, field, value),
  );
  if (attempted.status === "error") return Result.err(attempted.error);
  if (attempted.value === undefined) return Result.ok(undefined);
  if (!attempted.value.success) {
    return malformed(observation, field, value);
  }
  return Result.ok(attempted.value.data);
}

function executionErrorText(error: BashExecutionError | undefined): string | undefined {
  if (error === undefined) return undefined;
  switch (error.type) {
    case "blocked":
      return error.reason;
    case "aborted":
      return "Command aborted";
    case "timeout":
      return error.timeoutKind === "no_output"
        ? `Command terminated after ${error.timeoutMs}ms without output`
        : `Command timed out after ${error.timeoutMs}ms`;
    case "exception":
      return error.message;
  }
}

function bashResultText(output: string | BashOutputData): string | undefined {
  if (typeof output === "string") return output.trimEnd() || undefined;
  const chunks = [
    output.stdout?.trimEnd(),
    output.stderr?.trimEnd(),
    executionErrorText(output.executionError),
  ].filter((value) => value !== undefined && value.length > 0);
  if (output.exitCode !== undefined && output.exitCode !== 0 && chunks.length === 0) {
    chunks.push(`Process exited with code ${output.exitCode}`);
  }
  return chunks.join("\n") || undefined;
}

type KnownObservation = ToolObservation & { readonly toolName: KnownToolName };
type KnownToolCodec = (
  observation: KnownObservation,
) => ResultType<DecodedKnownToolObservation, KnownToolObservationMalformed>;

function isKnownToolObservation(observation: ToolObservation): observation is KnownObservation {
  return isKnownToolName(observation.toolName);
}

const decodeBash: KnownToolCodec = (observation) => {
  const input = parseInput(observation, bashInputSchema);
  if (input.status === "error") return Result.err(input.error);
  const partial = parseInput(observation, bashPartialSchema, "partial", true);
  if (partial.status === "error") return Result.err(partial.error);
  const outputDelta = partial.value?.delta;
  let resultText: string | undefined;
  let resultTone: BashDecodedObservation["resultTone"] = "normal";
  if (observation.lifecycle === "success") {
    const output = parseInput(observation, bashOutputSchema, "output");
    if (output.status === "error") {
      if (outputDelta === undefined) return Result.err(output.error);
      resultText = outputDelta.trimEnd() || undefined;
    } else {
      if (output.value === undefined) return malformed(observation, "output", undefined);
      resultText = bashResultText(output.value);
      if (typeof output.value !== "string" && output.value.executionError !== undefined) {
        resultTone = output.value.executionError.type === "aborted" ? "muted" : "danger";
      }
    }
  }
  return Result.ok({
    toolName: "bash",
    state: stateFromObservation(observation),
    ...(input.value === undefined ? {} : { command: input.value.command, cwd: input.value.cwd }),
    ...(resultText === undefined ? {} : { resultText }),
    resultTone,
    ...(outputDelta === undefined ? {} : { outputDelta }),
  });
};

const decodeRead: KnownToolCodec = (observation) => {
  const input = parseInput(observation, readInputSchema);
  if (input.status === "error") return Result.err(input.error);
  const start = input.value?.start;
  let normalizedStart: ReadDecodedObservation["start"];
  if (start !== undefined) {
    normalizedStart =
      "offset" in start
        ? { offset: start.offset }
        : { line: start.line, ...(start.column === undefined ? {} : { column: start.column }) };
  }
  return Result.ok({
    toolName: "read",
    state: stateFromObservation(observation),
    ...(input.value === undefined
      ? {}
      : {
          path: input.value.path,
          ...(normalizedStart === undefined ? {} : { start: normalizedStart }),
          ...(input.value.maxLines === undefined ? {} : { maxLines: input.value.maxLines }),
          ...(input.value.maxCharacters === undefined
            ? {}
            : { maxCharacters: input.value.maxCharacters }),
        }),
  });
};

const decodeGlob: KnownToolCodec = (observation) => {
  const input = parseInput(observation, globInputSchema);
  if (input.status === "error") return Result.err(input.error);
  return Result.ok({
    toolName: "glob",
    state: stateFromObservation(observation),
    ...(input.value === undefined ? {} : { patterns: input.value.patterns, cwd: input.value.cwd }),
  });
};

const decodeGrep: KnownToolCodec = (observation) => {
  const input = parseInput(observation, grepInputSchema);
  if (input.status === "error") return Result.err(input.error);
  return Result.ok({
    toolName: "grep",
    state: stateFromObservation(observation),
    ...(input.value === undefined ? {} : { pattern: input.value.pattern, path: input.value.path }),
  });
};

const decodeFuzzy: KnownToolCodec = (observation) => {
  const input = parseInput(observation, fuzzyInputSchema);
  if (input.status === "error") return Result.err(input.error);
  return Result.ok({
    toolName: "fuzzy_search",
    state: stateFromObservation(observation),
    ...(input.value === undefined ? {} : { query: input.value.query, cwd: input.value.cwd }),
  });
};

const decodeEditFile: KnownToolCodec = (observation) => {
  const input = parseInput(observation, editInputSchema);
  if (input.status === "error") return Result.err(input.error);
  let replacementsMade = 1;
  let state = stateFromObservation(observation);
  if (observation.lifecycle === "success") {
    const output = parseInput(observation, editOutputSchema, "output");
    if (output.status === "error") return Result.err(output.error);
    if (output.value === undefined) return malformed(observation, "output", undefined);
    if (output.value.success) {
      replacementsMade = output.value.replacementsMade;
    } else {
      replacementsMade = 0;
      state = { status: "error", errorText: previewText(output.value.error.message, 180) };
    }
  }
  return Result.ok({
    toolName: "edit",
    state,
    ...(input.value === undefined ? {} : { edit: input.value }),
    replacementsMade,
  });
};

const decodeApplyPatch: KnownToolCodec = (observation) => {
  const input = parseInput(observation, patchInputSchema);
  if (input.status === "error") return Result.err(input.error);
  return Result.ok({
    toolName: "patch",
    state: stateFromObservation(observation),
    ...(input.value === undefined
      ? {}
      : { patchText: input.value.patchText, cwd: input.value.cwd }),
  });
};

const decodeSubagentDelegate: KnownToolCodec = (observation) => {
  const input = parseInput(observation, subagentInputSchema);
  if (input.status === "error") return Result.err(input.error);
  let result: z.output<typeof subagentResultSchema> | undefined;
  if (observation.lifecycle === "success") {
    const parsed = parseInput(observation, subagentResultSchema, "output");
    if (parsed.status === "error") return Result.err(parsed.error);
    result = parsed.value;
  }
  let state = stateFromObservation(observation);
  if (result !== undefined) {
    switch (result.status) {
      case "accepted":
        state = { status: "active" };
        break;
      case "completed":
        state = { status: "success" };
        break;
      case "cancelled":
        state = {
          status: "cancelled",
          ...(result.error ? { reason: previewText(result.error, 160) } : {}),
        };
        break;
      case "error":
        state = {
          status: "error",
          errorText: previewText(result.error ?? "Subagent failed", 180),
        };
        break;
      case "rejected":
        state = {
          status: "error",
          errorText: previewText(result.reason, 180),
        };
        break;
    }
  }
  return Result.ok({
    toolName: "subagent_delegate",
    state,
    profile:
      result !== undefined && "profile" in result
        ? result.profile
        : (input.value?.profile ?? "subagent"),
    prompt: input.value?.prompt ?? "Delegated task",
    mode: input.value?.mode ?? "sync",
    ...(input.value?.sessionName === undefined ? {} : { sessionName: input.value.sessionName }),
    ...(result === undefined ? {} : { result }),
  });
};

const decodeSubagentResult: KnownToolCodec = (observation) => {
  const input = parseInput(observation, subagentResultInputSchema);
  if (input.status === "error") return Result.err(input.error);
  if (observation.lifecycle === "success") {
    const output = parseInput(observation, subagentTerminalResultSchema, "output");
    if (output.status === "error") return Result.err(output.error);
  }
  return Result.ok({
    toolName: "subagent_result",
    state: stateFromObservation(observation),
  });
};

const decodeBatch: KnownToolCodec = (observation) => {
  const input = parseInput(observation, batchInputSchema);
  if (input.status === "error") return Result.err(input.error);
  return Result.ok({
    toolName: "batch",
    state: stateFromObservation(observation),
    ...(input.value === undefined ? {} : { toolCount: input.value.tool_calls.length }),
  });
};

const decodeSkill: KnownToolCodec = (observation) => {
  const input = parseInput(observation, skillInputSchema);
  if (input.status === "error") return Result.err(input.error);
  return Result.ok({
    toolName: "skill",
    state: stateFromObservation(observation),
    ...(input.value === undefined ? {} : { name: input.value.name }),
  });
};

const decodeTodo: KnownToolCodec = (observation) => {
  const input = parseInput(observation, todoWriteInputSchema);
  if (input.status === "error") return Result.err(input.error);
  return Result.ok({
    toolName: "todowrite",
    state: stateFromObservation(observation),
    ...(input.value === undefined ? {} : { todoCount: input.value.todos.length }),
  });
};

const decodeWebfetch: KnownToolCodec = (observation) => {
  const input = parseInput(observation, webfetchInputSchema);
  if (input.status === "error") return Result.err(input.error);
  return Result.ok({
    toolName: "webfetch",
    state: stateFromObservation(observation),
    ...(input.value === undefined ? {} : { url: input.value.url }),
  });
};

const decodeWebsearch: KnownToolCodec = (observation) => {
  const input = parseInput(observation, websearchInputSchema);
  if (input.status === "error") return Result.err(input.error);
  let outputQuery: string | undefined;
  if (observation.lifecycle === "success" && input.value?.query === undefined) {
    const output = parseInput(observation, websearchOutputSchema, "output");
    if (output.status === "error") return Result.err(output.error);
    outputQuery = output.value?.action.query;
  }
  return Result.ok({
    toolName: "websearch",
    state: stateFromObservation(observation),
    ...(input.value?.query === undefined && outputQuery === undefined
      ? {}
      : { query: input.value?.query ?? outputQuery }),
  });
};

export const toolObservationCodecRegistry = {
  bash: decodeBash,
  read: decodeRead,
  glob: decodeGlob,
  grep: decodeGrep,
  fuzzy_search: decodeFuzzy,
  edit: decodeEditFile,
  patch: decodeApplyPatch,
  subagent_delegate: decodeSubagentDelegate,
  subagent_result: decodeSubagentResult,
  batch: decodeBatch,
  skill: decodeSkill,
  todowrite: decodeTodo,
  webfetch: decodeWebfetch,
  websearch: decodeWebsearch,
} satisfies Record<KnownToolName, KnownToolCodec>;

export const knownToolCodecRegistry = toolObservationCodecRegistry;

export function decodeKnownToolObservation(
  observation: ToolObservation & { readonly toolName: KnownToolName },
): ResultType<DecodedKnownToolObservation, KnownToolObservationMalformed> {
  const decoded = captureTuiOperation(
    () => toolObservationCodecRegistry[observation.toolName](observation),
    () => malformedError(observation, "input", undefined),
  );
  return decoded.status === "error" ? Result.err(decoded.error) : decoded.value;
}

function humanizeToolName(name: string): string {
  return name
    .split(/[_-]+/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function stateTone(state: ToolProjectionState): ToolProjectionTone {
  switch (state.status) {
    case "pending":
    case "active":
      return "accent";
    case "approval":
    case "denied":
      return "warning";
    case "success":
      return "success";
    case "error":
      return "danger";
    case "cancelled":
      return "muted";
  }
}

function isRunning(state: ToolProjectionState): boolean {
  return state.status === "pending" || state.status === "active" || state.status === "approval";
}

function stateHeadline(summary: string, state: ToolProjectionState): string {
  switch (state.status) {
    case "pending":
    case "active":
      return `${summary} · running`;
    case "approval":
      return `${summary} · awaiting approval`;
    case "success":
      return summary;
    case "error": {
      const trimmed = state.errorText.trimStart();
      return trimmed.startsWith("{") || trimmed.startsWith("[")
        ? `${summary} failed`
        : `${summary}: ${state.errorText}`;
    }
    case "denied":
      return `${summary}: denied`;
    case "cancelled":
      return `${summary}: cancelled${state.reason === undefined ? "" : ` (${state.reason})`}`;
  }
}

function projectionBase(
  lifecycle: ToolObservationLifecycle,
  state: ToolProjectionState,
  summary: string,
  options: {
    readonly tone?: ToolProjectionTone;
    readonly singleLine?: boolean;
    readonly visibility?: "visible" | "hidden";
    readonly headline?: string;
  } = {},
): ToolProjectionBase {
  return {
    lifecycle,
    state,
    tone: options.tone ?? stateTone(state),
    summary,
    headline: options.headline ?? stateHeadline(summary, state),
    running: isRunning(state),
    singleLine: options.singleLine ?? false,
    visibility: options.visibility ?? "visible",
  };
}

function sameCwd(left: string, right: string | undefined): boolean {
  if (right === undefined) return false;
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalize(left) === normalize(right);
}

function relativePath(value: string, cwd: string | undefined): string {
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
  return relativePath(value, cwd);
}

function quoted(value: string): string {
  return `"${value}"`;
}

function operationStatus(state: ToolProjectionState): {
  readonly status: "pending" | "success" | "error" | "denied" | "cancelled";
  readonly error?: string;
} {
  switch (state.status) {
    case "pending":
    case "active":
    case "approval":
      return { status: "pending" };
    case "success":
      return { status: "success" };
    case "error":
      return { status: "error", error: state.errorText };
    case "denied":
      return { status: "denied" };
    case "cancelled":
      return { status: "cancelled" };
  }
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
  if (match?.[1] === undefined) return undefined;
  const line = Number(match[1]);
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

function editPath(value: string, cwd: string | undefined): string {
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (cwd === undefined || !normalized.startsWith("/")) return normalized;
  const normalizedCwd = posix.normalize(cwd.replaceAll("\\", "/"));
  return posix.relative(normalizedCwd, normalized) || ".";
}

function patchOperations(
  patchText: string | undefined,
  patchCwd: string | undefined,
  clientCwd: string | undefined,
): readonly ProjectedEditOperation[] {
  if (patchText === undefined) return [];
  const edits: Array<{ path: string; added: number; removed: number }> = [];
  let current: { path: string; added: number; removed: number } | undefined;
  for (const line of patchText.split("\n")) {
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
    path: editPath(edit.path, patchCwd ?? clientCwd),
    added: edit.added,
    removed: edit.removed,
  }));
}

function fileOperations(
  edit: EditInput | undefined,
  replacementsMade: number,
  cwd: string | undefined,
): readonly ProjectedEditOperation[] {
  if (edit === undefined) return [];
  if (edit.oldText !== undefined && edit.newText !== undefined) {
    return [
      {
        action: "Edit",
        path: editPath(edit.path, cwd),
        added: lineCount(edit.newText) * replacementsMade,
        removed: lineCount(edit.oldText) * replacementsMade,
      },
    ];
  }
  if (edit.edits === undefined) {
    return [{ action: "Edit", path: editPath(edit.path, cwd), added: 0, removed: 0 }];
  }
  let added = 0;
  let removed = 0;
  for (const operation of edit.edits) {
    added += replacementLineCount(operation.lines);
    if (operation.op !== "replace") continue;
    const start = hashlineNumber(operation.pos);
    const end = hashlineNumber(operation.end) ?? start;
    if (start !== undefined && end !== undefined && end >= start) removed += end - start + 1;
  }
  return [{ action: "Edit", path: editPath(edit.path, cwd), added, removed }];
}

function editSummary(
  action: "Patch" | "Edit",
  operations: readonly ProjectedEditOperation[],
): string {
  const first = operations[0];
  if (first === undefined) return action;
  if (operations.length > 1) return `${action} ${operations.length} files`;
  const additions = first.added > 0 ? ` +${first.added}` : "";
  const removals = first.removed > 0 ? ` -${first.removed}` : "";
  return `${first.action} ${first.path}${additions}${removals}`;
}

function projectDecoded(
  lifecycle: ToolObservationLifecycle,
  decoded: DecodedKnownToolObservation,
  cwd: string | undefined,
): ToolProjection {
  switch (decoded.toolName) {
    case "bash": {
      const summary =
        decoded.command === undefined ? "Bash" : `$ ${previewText(decoded.command, 160)}`;
      const tone =
        decoded.state.status === "success" ? decoded.resultTone : stateTone(decoded.state);
      let resultText = decoded.resultText;
      switch (decoded.state.status) {
        case "pending":
        case "active":
        case "approval":
        case "success":
          break;
        case "error": {
          const trimmed = decoded.state.errorText.trimStart();
          resultText =
            trimmed.startsWith("{") || trimmed.startsWith("[")
              ? "Command failed"
              : decoded.state.errorText;
          break;
        }
        case "denied":
          resultText = "Denied";
          break;
        case "cancelled":
          resultText = `Cancelled${decoded.state.reason === undefined ? "" : `: ${decoded.state.reason}`}`;
          break;
      }
      return {
        kind: "bash",
        toolName: "bash",
        ...projectionBase(lifecycle, decoded.state, summary, { tone }),
        ...(decoded.command === undefined ? {} : { command: decoded.command }),
        ...(decoded.cwd === undefined || sameCwd(decoded.cwd, cwd) ? {} : { cwd: decoded.cwd }),
        ...(resultText === undefined ? {} : { resultText }),
        ...(decoded.outputDelta === undefined ? {} : { outputDelta: decoded.outputDelta }),
      };
    }
    case "read": {
      const details = [
        decoded.start !== undefined && "offset" in decoded.start
          ? `offset ${decoded.start.offset}`
          : undefined,
        decoded.start !== undefined && "line" in decoded.start
          ? `line ${decoded.start.line}${decoded.start.column === undefined ? "" : `:${decoded.start.column}`}`
          : undefined,
        decoded.maxLines === undefined
          ? undefined
          : `${decoded.maxLines} line${decoded.maxLines === 1 ? "" : "s"}`,
        decoded.maxCharacters === undefined
          ? undefined
          : `${decoded.maxCharacters} character${decoded.maxCharacters === 1 ? "" : "s"}`,
      ].filter((value) => value !== undefined);
      const detail =
        decoded.path === undefined
          ? undefined
          : [relativePath(decoded.path, cwd), ...details].join(" · ");
      const outcome = operationStatus(decoded.state);
      const summary = decoded.path === undefined ? "Read File" : `Read ${decoded.path}`;
      return {
        kind: "exploration",
        toolName: "read",
        ...projectionBase(lifecycle, decoded.state, summary, {
          tone: decoded.state.status === "success" ? "normal" : undefined,
          visibility: detail === undefined ? "hidden" : "visible",
        }),
        action: "Read",
        ...(detail === undefined ? {} : { detail }),
        operationStatus: outcome.status,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      };
    }
    case "glob": {
      const detail =
        decoded.patterns === undefined
          ? undefined
          : [explorationScope(decoded.cwd, cwd), decoded.patterns.join(", ")]
              .filter((value) => value !== undefined)
              .join(" · ");
      const summary =
        decoded.patterns === undefined ? "Glob" : `Glob ${decoded.patterns.join(", ")}`;
      return explorationProjection(lifecycle, decoded, "Glob", detail, summary);
    }
    case "grep": {
      const detail =
        decoded.pattern === undefined
          ? undefined
          : [explorationScope(decoded.path, cwd), quoted(decoded.pattern)]
              .filter((value) => value !== undefined)
              .join(" · ");
      const summary =
        decoded.pattern === undefined
          ? "Grep"
          : `Grep ${quoted(previewText(decoded.pattern, 120))}`;
      return explorationProjection(lifecycle, decoded, "Grep", detail, summary);
    }
    case "fuzzy_search": {
      const detail =
        decoded.query === undefined
          ? undefined
          : [explorationScope(decoded.cwd, cwd), quoted(decoded.query)]
              .filter((value) => value !== undefined)
              .join(" · ");
      const summary =
        decoded.query === undefined
          ? "Fuzzy Search"
          : `Find ${quoted(previewText(decoded.query, 120))}`;
      return explorationProjection(lifecycle, decoded, "Find", detail, summary);
    }
    case "edit": {
      const operations = fileOperations(decoded.edit, decoded.replacementsMade, cwd);
      const summary = editSummary("Edit", operations);
      return {
        kind: "edit",
        toolName: "edit",
        ...projectionBase(lifecycle, decoded.state, summary, {
          tone:
            decoded.state.status === "pending" ||
            decoded.state.status === "active" ||
            decoded.state.status === "success"
              ? "normal"
              : undefined,
          singleLine: true,
        }),
        operations,
      };
    }
    case "patch": {
      const operations = patchOperations(decoded.patchText, decoded.cwd, cwd);
      const summary = editSummary("Patch", operations);
      return {
        kind: "edit",
        toolName: "patch",
        ...projectionBase(lifecycle, decoded.state, summary, {
          tone:
            decoded.state.status === "pending" ||
            decoded.state.status === "active" ||
            decoded.state.status === "success"
              ? "normal"
              : undefined,
          singleLine: true,
        }),
        operations,
      };
    }
    case "subagent_delegate": {
      const result = decoded.result;
      const profile = result?.profile ?? decoded.profile;
      const summary = `${humanizeToolName(profile)}: ${previewText(decoded.prompt, 120)}`;
      return {
        kind: "subagent-delegate",
        toolName: "subagent_delegate",
        ...projectionBase(lifecycle, decoded.state, summary),
        profile,
        prompt: decoded.prompt,
        mode: decoded.mode,
        ...((result?.sessionName ?? decoded.sessionName)
          ? { sessionName: result?.sessionName ?? decoded.sessionName }
          : {}),
        ...(result?.childRunId === undefined ? {} : { childRunId: result.childRunId }),
        ...(result?.childSessionId === undefined ? {} : { childSessionId: result.childSessionId }),
        ...(result?.status === undefined ? {} : { resultStatus: result.status }),
        ...(result?.text === undefined ? {} : { resultText: result.text }),
        ...((result?.error ?? result?.reason)
          ? { error: previewText(result?.error ?? result?.reason ?? "", 180) }
          : {}),
      };
    }
    case "subagent_result": {
      const summary = "Subagent Result";
      return {
        kind: "subagent-result",
        toolName: "subagent_result",
        ...projectionBase(lifecycle, decoded.state, summary, { visibility: "hidden" }),
      };
    }
    case "batch": {
      const summary =
        decoded.toolCount === undefined
          ? "Parallel tools"
          : `Batch ${decoded.toolCount} tool${decoded.toolCount === 1 ? "" : "s"}`;
      return {
        kind: "batch",
        toolName: "batch",
        ...projectionBase(lifecycle, decoded.state, summary, {
          visibility: decoded.state.status === "error" ? "visible" : "hidden",
          headline:
            decoded.state.status === "error"
              ? stateHeadline("Parallel tools", decoded.state)
              : undefined,
        }),
        ...(decoded.toolCount === undefined ? {} : { toolCount: decoded.toolCount }),
      };
    }
    case "skill": {
      const summary = decoded.name === undefined ? "Skill" : `Skill ${decoded.name}`;
      let headline = stateHeadline(summary, decoded.state);
      if (
        decoded.name !== undefined &&
        (decoded.state.status === "pending" || decoded.state.status === "active")
      ) {
        headline = `Loading skill ${decoded.name}`;
      } else if (decoded.name !== undefined && decoded.state.status === "success") {
        headline = `Loaded skill ${decoded.name}`;
      }
      return {
        kind: "skill",
        toolName: "skill",
        ...projectionBase(lifecycle, decoded.state, summary, { headline }),
        ...(decoded.name === undefined ? {} : { name: decoded.name }),
      };
    }
    case "todowrite": {
      const summary =
        decoded.todoCount === undefined
          ? "Todowrite"
          : `Update todos: ${decoded.todoCount} item${decoded.todoCount === 1 ? "" : "s"}`;
      return {
        kind: "todo",
        toolName: "todowrite",
        ...projectionBase(lifecycle, decoded.state, summary),
        ...(decoded.todoCount === undefined ? {} : { todoCount: decoded.todoCount }),
      };
    }
    case "webfetch": {
      const summary = decoded.url === undefined ? "Webfetch" : `Fetch ${decoded.url}`;
      return {
        kind: "webfetch",
        toolName: "webfetch",
        ...projectionBase(lifecycle, decoded.state, summary, { singleLine: true }),
        ...(decoded.url === undefined ? {} : { url: decoded.url }),
      };
    }
    case "websearch": {
      const query = decoded.query?.replace(/\s+/gu, " ");
      const summary = query === undefined ? "Websearch" : `Search ${quoted(query)}`;
      return {
        kind: "websearch",
        toolName: "websearch",
        ...projectionBase(lifecycle, decoded.state, summary, { singleLine: true }),
        ...(query === undefined ? {} : { query }),
      };
    }
  }
}

function explorationProjection(
  lifecycle: ToolObservationLifecycle,
  decoded: GlobDecodedObservation | GrepDecodedObservation | FuzzyDecodedObservation,
  action: "Glob" | "Grep" | "Find",
  detail: string | undefined,
  summary: string,
): Extract<ToolProjection, { readonly kind: "exploration" }> {
  const outcome = operationStatus(decoded.state);
  return {
    kind: "exploration",
    toolName: decoded.toolName,
    ...projectionBase(lifecycle, decoded.state, summary, {
      tone: decoded.state.status === "success" ? "normal" : undefined,
      visibility: detail === undefined ? "hidden" : "visible",
    }),
    action,
    ...(detail === undefined ? {} : { detail }),
    operationStatus: outcome.status,
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
  };
}

/** Decode and project one complete observation. This is the sole malformed-known recovery policy. */
export function projectToolObservation(
  observation: ToolObservation,
  options: { readonly cwd?: string } = {},
): ToolProjection {
  const toolName = normalizeMiniLilacToolName(observation.toolName);
  const normalizedObservation: ToolObservation =
    toolName === observation.toolName ? observation : { ...observation, toolName };
  if (!isKnownToolObservation(normalizedObservation)) {
    const toolName = previewText(normalizedObservation.toolName, 80) || "Unknown Tool";
    const state = stateFromObservation(normalizedObservation);
    const summary = humanizeToolName(toolName) || "Unknown Tool";
    let payloadPreview = "undefined";
    switch (normalizedObservation.lifecycle) {
      case "pending":
        break;
      case "active":
      case "approval":
      case "error":
      case "denied":
      case "cancelled":
        payloadPreview = safeToolPayloadPreview(normalizedObservation.input);
        break;
      case "success":
        payloadPreview = safeToolPayloadPreview(normalizedObservation.output);
        break;
    }
    return {
      kind: "unknown-tool",
      toolName,
      ...projectionBase(normalizedObservation.lifecycle, state, summary),
      payloadPreview,
    };
  }

  const decoded = decodeKnownToolObservation(normalizedObservation);
  if (decoded.status === "ok")
    return projectDecoded(normalizedObservation.lifecycle, decoded.value, options.cwd);
  const error = decoded.error;
  const state = stateFromObservation(normalizedObservation);
  const summary = humanizeToolName(error.toolName);
  return {
    kind: "malformed-known-tool",
    toolName: error.toolName,
    ...projectionBase(normalizedObservation.lifecycle, state, summary),
    malformedField: error.field,
    payloadPreview: error.payloadPreview,
  };
}
