/*
  ai-sdk-pi-agent.ts

  Demo wrapper that provides a pi-agent-like DX (event stream + steering/follow-up queues)
  on top of AI SDK `streamText().stream`.

  This is intentionally self-contained and not part of any package.
*/

import {
  type CallWarning,
  type Experimental_DownloadFunction as DownloadFunction,
  streamText,
  type AssistantContent,
  type AssistantModelMessage,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type SystemModelMessage,
  type TextStreamPart,
  type ToolModelMessage,
  type ToolSet,
} from "ai";
import {
  createLogger,
  isRecord,
  type ModelReasoningEffort,
  normalizeReplayMessages,
  normalizeAssistantToolCallInputMessage,
  normalizeToolCallInputValue,
} from "@stanley2058/lilac-utils";

import {
  executeAtomicToolCall,
  finalizeSettledAtomicToolCall,
  normalizeToolResultOutput,
  settleAtomicToolCall,
  type AtomicToolExecutionOutcome,
  type AtomicToolExecutionOutcomeKind,
  type ExecuteAtomicToolCallOptions,
  type NormalizeSettledToolResultOutputsFn,
  type NormalizeToolResultOutputFn,
  type SettledToolResultOutputEntry,
  type ToolResultOutput,
} from "./atomic-tool-execution";
import { normalizeModelMessagesToolCallIds } from "./tool-call-id-normalization";
import type { ExpandedToolCall } from "./tool-call-expansion";

const logger = createLogger({ module: "ai-sdk-pi-agent" });
const SETTLED_NORMALIZATION_FAILED = "[settled tool results could not be normalized]";

export type {
  NormalizeSettledToolResultOutputsFn,
  NormalizeToolResultOutputFn,
  SettledToolResultOutputEntry,
  ToolResultOutput,
} from "./atomic-tool-execution";

export type SystemPrompt = string | SystemModelMessage | SystemModelMessage[];

/** Immutable tool authority for one model step. */
export type StepToolSnapshot<TOOLS extends ToolSet = ToolSet> = {
  /** Monotonic model-step number, 1-based. */
  readonly step: number;
  /** Exact tool implementations authorized for calls produced by this step. */
  readonly tools: TOOLS;
  /** Authorized names in toolset order. */
  readonly names: readonly string[];
};

/**
 * Controls how `steer()` messages are drained.
 *
 * - `one-at-a-time`: inject at most one steering message per check.
 * - `all`: drain the queue and inject all steering messages.
 */
export type SteeringMode = "one-at-a-time" | "all";

/**
 * Controls how `followUp()` messages are drained.
 *
 * Follow-ups are only injected when the model finishes a turn without tool calls.
 */
export type FollowUpMode = "one-at-a-time" | "all";

/** Stable identifier returned for an entry added to the steering queue. */
export type SteeringQueueId = string;

/** Agent path that will deliver a prepared steering batch. */
export type SteeringDeliveryKind = "queued" | "interrupt";

/** One stable queued steering entry exposed at the pre-delivery boundary. */
export type SteeringDeliveryEntry = {
  readonly id: SteeringQueueId;
  readonly message: ModelMessage;
};

/** Context supplied immediately before a steering batch becomes canonical. */
export type BeforeSteeringDeliveryContext = {
  readonly deliveryKind: SteeringDeliveryKind;
  /** Ordered snapshot of the exact steering entries selected for this delivery. */
  readonly batch: readonly SteeringDeliveryEntry[];
  /**
   * Exact canonical messages that will be appended and made provider-visible.
   * Every selected steering entry retains its own message boundary; selected follow-ups may
   * precede or merge into the first steering message.
   */
  readonly canonicalMessages: readonly ModelMessage[];
  /** Aborted when the active run is cancelled or interrupted while the hook is pending. */
  readonly abortSignal?: AbortSignal;
};

/**
 * Awaited hook that must finish before a selected steering batch is consumed or delivered.
 * Ordinary delivery uses `queued`; `interruptQueuedSteeringAsync()` uses `interrupt`.
 */
export type BeforeSteeringDeliveryHandler = (
  context: BeforeSteeringDeliveryContext,
) => void | Promise<void>;

/** Outcome of requesting an immediate interrupt from the current steering queue. */
export type InterruptQueuedSteeringResult =
  | { status: "interrupted"; steeringIds: SteeringQueueId[] }
  | { status: "empty" }
  | { status: "inactive" };

/** Outcome of the awaited, non-destructive-until-prepared interrupt path. */
export type AsyncInterruptQueuedSteeringResult =
  | InterruptQueuedSteeringResult
  | { status: "failed"; steeringIds: SteeringQueueId[]; error: string };

/**
 * Fine-grained events emitted while an assistant message is streaming.
 *
 * These are derived from AI SDK `streamText(...).stream` parts.
 */
export type AiSdkPiAssistantMessageEvent<TOOLS extends ToolSet> =
  | {
      type: "text_start";
      id: string;
      raw: Extract<TextStreamPart<TOOLS>, { type: "text-start" }>;
    }
  | {
      type: "text_delta";
      id: string;
      delta: string;
      raw: Extract<TextStreamPart<TOOLS>, { type: "text-delta" }>;
    }
  | {
      type: "text_end";
      id: string;
      raw: Extract<TextStreamPart<TOOLS>, { type: "text-end" }>;
    }
  | {
      type: "thinking_start";
      id: string;
      raw: Extract<TextStreamPart<TOOLS>, { type: "reasoning-start" }>;
    }
  | {
      type: "thinking_delta";
      id: string;
      delta: string;
      raw: Extract<TextStreamPart<TOOLS>, { type: "reasoning-delta" }>;
    }
  | {
      type: "thinking_end";
      id: string;
      raw: Extract<TextStreamPart<TOOLS>, { type: "reasoning-end" }>;
    }
  | {
      type: "toolcall_start";
      toolCallId: string;
      toolName: string;
      raw: Extract<TextStreamPart<TOOLS>, { type: "tool-input-start" }>;
    }
  | {
      type: "toolcall_delta";
      toolCallId: string;
      delta: string;
      raw: Extract<TextStreamPart<TOOLS>, { type: "tool-input-delta" }>;
    }
  | {
      type: "toolcall_end";
      toolCallId: string;
      raw: Extract<TextStreamPart<TOOLS>, { type: "tool-input-end" }>;
    }
  | {
      type: "custom";
      raw: Extract<TextStreamPart<TOOLS>, { type: "custom" }>;
    }
  | {
      type: "source";
      raw: Extract<TextStreamPart<TOOLS>, { type: "source" }>;
    }
  | {
      type: "file";
      raw: Extract<TextStreamPart<TOOLS>, { type: "file" }>;
    }
  | {
      type: "reasoning_file";
      raw: Extract<TextStreamPart<TOOLS>, { type: "reasoning-file" }>;
    };

/** Why a turn ended without producing a `turn_end`. */
export type TurnAbortReason = "cancel" | "interrupt" | "manual";

/** Where the abort occurred: model streaming vs tool execution. */
export type TurnAbortPhase = "model" | "tools";

/**
 * High-level event stream for building a `pi-agent`-style UI.
 *
 * Downstream should treat `messages_reset` as authoritative and replace any
 * locally accumulated transcript state when it occurs.
 */
export type AiSdkPiAgentEvent<TOOLS extends ToolSet> =
  /** Run started (triggered by `prompt()` or `continue()`). */
  | { type: "agent_start" }
  /** Run finished (success, manual abort, or error). */
  | {
      type: "agent_end";
      messages: ModelMessage[];
      /** Total usage across all successful turns in the run. */
      totalUsage?: LanguageModelUsage;
    }
  /** A new model request (turn) started. */
  | { type: "turn_start" }
  /** A model request (turn) completed normally. */
  | {
      type: "turn_end";
      finishReason: FinishReason;
      newMessages: ModelMessage[];
      /** Token usage of the last step for this turn. */
      usage: LanguageModelUsage;
      /** Token usage summed across steps for this turn. */
      totalUsage: LanguageModelUsage;
    }
  /** A failed model request will be replayed from the unchanged canonical transcript. */
  | {
      type: "turn_retry";
      hadPartialOutput: boolean;
      abandonedToolCallIds: string[];
    }
  /** Provider warnings emitted for the active model turn. */
  | {
      type: "turn_warnings";
      warnings: CallWarning[];
    }
  /** A steering batch remained queued because its pre-delivery hook rejected. */
  | {
      type: "steering_delivery_failed";
      deliveryKind: SteeringDeliveryKind;
      steeringIds: SteeringQueueId[];
      error: string;
    }
  /** A model request (turn) was aborted and will not emit `turn_end`. */
  | {
      type: "turn_abort";
      reason: TurnAbortReason;
      phase: TurnAbortPhase;
      detail?: string;
    }
  /**
   * Canonical transcript was replaced or rewound.
   *
   * Downstream should treat this as authoritative and replace any locally
   * accumulated transcript state.
   */
  | {
      type: "messages_reset";
      reason: "cancel" | "interrupt";
      messages: ModelMessage[];
      droppedMessageCount: number;
    }
  | {
      type: "messages_reset";
      reason: "replace" | "compaction";
      messages: ModelMessage[];
      previousMessageCount: number;
    }
  /** A message was appended to the transcript (or assistant streaming started). */
  | { type: "message_start"; message: ModelMessage }
  /** Incremental assistant updates (text/reasoning/toolcall deltas). */
  | {
      type: "message_update";
      message: ModelMessage;
      assistantMessageEvent: AiSdkPiAssistantMessageEvent<TOOLS>;
    }
  /** A message is complete (user/tool are immediate; assistant ends after stream). */
  | { type: "message_end"; message: ModelMessage }
  /** Local tool execution started (only for non-provider-executed tools). */
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  /** Local tool produced incremental output (AsyncIterable tool results). */
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  /** Local tool execution finished; a tool-result message will be appended. */
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      args: unknown;
      result: unknown;
      isError: boolean;
      output: ToolResultOutput;
      outcome: "success" | "invalid-input" | "denied" | "error";
    };

/**
 * Live agent state.
 *
 * This object is mutated during execution; treat it as read-only unless you
 * deliberately want to override internals.
 */
export interface AiSdkPiAgentState<TOOLS extends ToolSet> {
  /** System prompt for the model. */
  system: SystemPrompt;
  /** AI SDK model instance used for `streamText()`. */
  model: LanguageModel;
  /** Optional canonical model spec (`provider/model`). */
  modelSpecifier?: string;
  /** Toolset available to the model. */
  tools: TOOLS;
  /** Canonical transcript (system is kept separately in `system`). */
  messages: ModelMessage[];
  /** True while the agent run loop is active. */
  isStreaming: boolean;
  /** Partial assistant message while streaming, otherwise `null`. */
  streamMessage: Extract<ModelMessage, { role: "assistant" }> | null;
  /** Tool call IDs currently executing locally. */
  pendingToolCalls: Set<string>;
  /** Set when the run terminates due to an error. */
  error?: string;
  /** Provider-specific options. */
  providerOptions?: { [x: string]: JSONObject };
  /** Portable AI SDK reasoning effort. */
  reasoning?: ModelReasoningEffort;

  /** Debug-only state (optional, can be large). */
  debug?: {
    /** The exact messages array sent to the model for the last completed turn. */
    lastModelViewMessages?: ModelMessage[];
    /** Monotonic turn counter for lastModelViewMessages (1-based). */
    lastModelViewTurn?: number;
    /** When lastModelViewMessages was captured (Date.now()). */
    lastModelViewCapturedAt?: number;
  };
}

type JSONArray = JSONValue[];
type JSONValue = null | string | number | boolean | JSONObject | JSONArray;
type JSONObject = {
  [key: string]: JSONValue | undefined;
};

export type TransformMessagesContext = {
  /** The system prompt that will be sent via `streamText({ system })`. */
  system: SystemPrompt;
  /** Exact tool declarations that will be sent with this model request. */
  tools: ToolSet;
  /** Abort signal for this turn (if present). */
  abortSignal?: AbortSignal;
  /** Canonical offset for full-budget subset preparation; payload transforms normally omit it. */
  canonicalStartIndex?: number;
};

export type PrepareFullModelView = (
  canonicalMessages: readonly ModelMessage[],
  context: TransformMessagesContext,
) => ModelMessage[] | Promise<ModelMessage[]>;

/** Prepares the complete target-protocol view used for estimation and compaction only. */
export type PrepareFullBudgetView = PrepareFullModelView;

export type CanonicalModelCallPreflight = (
  canonicalMessages: readonly ModelMessage[],
  context: TransformMessagesContext,
) => void | Promise<void>;

export type BuildEphemeralOverlay = (
  context: TransformMessagesContext,
) => readonly ModelMessage[] | Promise<readonly ModelMessage[]>;

export type DecorateRequestPayload = (
  payload: readonly ModelMessage[],
  context: TransformMessagesContext,
) => ModelMessage[] | Promise<ModelMessage[]>;

export type ModelCallExecutionMode = "local-tools" | "provider-tools";

export type ModelCallRuntime = {
  readonly model: LanguageModel;
  readonly modelSpecifier?: string;
  readonly executionMode: ModelCallExecutionMode;
  /** Stable identity for outer calls that belong to one persistent provider attempt. */
  readonly persistentAttemptIdentity?: string;
  /** Per-call AI SDK retry limit. Omit to inherit the Agent constructor default. */
  readonly streamTextMaxRetries?: number;
};

export type CanonicalPayloadSelection =
  | { readonly mode: "full" }
  | { readonly mode: "suffix"; readonly startIndex: number };

export type PrepareModelCallContext = {
  readonly canonicalMessages: readonly ModelMessage[];
  readonly fullBudgetView: readonly ModelMessage[];
  readonly runtime: ModelCallRuntime;
  readonly payload: CanonicalPayloadSelection;
  readonly transformContext: TransformMessagesContext;
};

export type PreparedModelCall = {
  readonly runtime: ModelCallRuntime;
  readonly payload: CanonicalPayloadSelection;
};

export type PrepareModelCall = (
  context: PrepareModelCallContext,
) => PreparedModelCall | Promise<PreparedModelCall>;

export type TurnErrorHandlerDecision = "retry" | "fail";

export type TurnErrorPhase = "before-step" | "transform-messages" | "model-call" | "post-model";

export type TurnRetrySafety =
  | { canRetry: true }
  | {
      canRetry: false;
      reason: "invalid-transcript-boundary" | "post-model-phase" | "provider-executed-tool";
    };

export type TurnErrorHandler = (
  error: unknown,
  context: {
    abortSignal?: AbortSignal;
    retrySafety: TurnRetrySafety;
    /** Origin of the error. Optional for compatibility with direct handler callers. */
    phase?: TurnErrorPhase;
  },
) => TurnErrorHandlerDecision | Promise<TurnErrorHandlerDecision>;

export type TurnBoundaryContext = {
  finishReason: FinishReason;
  /** Exact transformed messages used by the model call that just completed. */
  modelInputMessages: readonly ModelMessage[];
  /** Number of local tool calls completed before this boundary. */
  executedToolCallCount: number;
  abortSignal?: AbortSignal;
};

export type TurnBoundaryDecision = {
  append?: readonly ModelMessage[];
  /** Continue even when the messages were already present, such as after recovery. */
  forceNextTurn?: boolean;
};

export type TurnBoundaryHandler = (
  context: TurnBoundaryContext,
) => TurnBoundaryDecision | Promise<TurnBoundaryDecision>;

/** Hook run immediately before each model step's tool authority is frozen. */
export type BeforeStepHandler = (context: {
  step: number;
  abortSignal?: AbortSignal;
}) => void | Promise<void>;

export type ExecutedExpansionChild = {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  outcome: AtomicToolExecutionOutcomeKind;
  toolOutput: ToolResultOutput;
};

export type ExternalToolExecutionOutcome = AtomicToolExecutionOutcome & {
  executedExpansion?: {
    children: ExecutedExpansionChild[];
  };
};

export type AiSdkPiAgentOptions<TOOLS extends ToolSet> = {
  /** System prompt for the model. */
  system: SystemPrompt;
  /** AI SDK model instance used for `streamText()`. */
  model: LanguageModel;
  /** Optional retry limit forwarded to each AI SDK `streamText()` call. */
  streamTextMaxRetries?: number;
  /** Optional canonical model spec (`provider/model`). */
  modelSpecifier?: string;
  /** Optional toolset (defaults to empty). */
  tools?: TOOLS;
  /** Keep tools executable locally without sending their declarations to the model. */
  sendToolsToModel?: boolean;
  /** Optional initial transcript (defaults to empty). */
  messages?: ModelMessage[];
  prepareFullModelView?: PrepareFullModelView;
  prepareFullBudgetView?: PrepareFullBudgetView;
  canonicalModelCallPreflight?: CanonicalModelCallPreflight;
  buildEphemeralOverlay?: BuildEphemeralOverlay;
  decorateRequestPayload?: DecorateRequestPayload;
  prepareModelCall?: PrepareModelCall;
  /** Optional hook to recover from turn errors (e.g. context overflow). */
  turnErrorHandler?: TurnErrorHandler;
  /** Inject messages after tools finish and before the next model turn. */
  turnBoundaryHandler?: TurnBoundaryHandler;
  /** Prepare selected steering entries before they are consumed or delivered. */
  beforeSteeringDelivery?: BeforeSteeringDeliveryHandler;
  /** Refresh active tools and other per-step state before tool authority is frozen. */
  beforeStep?: BeforeStepHandler;
  /** Normalize model-facing tool output before it enters the canonical transcript. */
  normalizeToolResultOutput?: NormalizeToolResultOutputFn;
  /** Normalize one fully settled expansion cohort in declared child order. */
  normalizeSettledToolResultOutputs?: NormalizeSettledToolResultOutputsFn;
  /** Tool names whose specs guarantee already-bounded model output. */
  genericOutputNormalizerBypassTools?: ReadonlySet<string>;
  /** Trusted tool names excluded from the settled cohort's aggregate output budget. */
  aggregateOutputBudgetExemptTools?: ReadonlySet<string>;
  /** When any of these tools are called, other tools in the same model turn are rejected. */
  exclusiveToolNames?: ReadonlySet<string>;
  /** Optional provider-specific options. */
  providerOptions?: {
    [x: string]: JSONObject;
  };
  /** Optional portable AI SDK reasoning effort. */
  reasoning?: ModelReasoningEffort;

  /** Optional custom URL download hook forwarded to AI SDK. */
  experimentalDownload?: DownloadFunction;

  /** Optional debug features. */
  debug?: {
    /** Capture and store model-view messages per turn (can be large). */
    captureModelViewMessages?: boolean;
  };
};

function cloneMessage(message: ModelMessage): ModelMessage {
  if (message.role === "assistant") {
    return {
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map((p) => ({ ...p }))
        : message.content,
    };
  }
  if (message.role === "tool") {
    return {
      ...message,
      content: message.content.map((p) => ({ ...p })),
    };
  }
  if (message.role === "user" && Array.isArray(message.content)) {
    return {
      ...message,
      content: message.content.map((p) => ({ ...p })),
    };
  }
  return { ...message };
}

function cloneSteeringValue(value: unknown, ancestors: ReadonlySet<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new Error(`unsupported ${typeof value} value`);
  }
  if (value instanceof URL) return new URL(value.href);
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    throw new Error(`unsupported buffer view '${value.constructor.name}'`);
  }
  if (ancestors.has(value)) throw new Error("cyclic values are unsupported");
  const nestedAncestors = new Set(ancestors);
  nestedAncestors.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => cloneSteeringValue(entry, nestedAncestors));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`unsupported object prototype '${prototype?.constructor?.name ?? "unknown"}'`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error("symbol-keyed properties are unsupported");
  }
  const cloned: Record<string, unknown> = prototype === null ? { __proto__: null } : {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) throw new Error(`non-enumerable property '${key}' is unsupported`);
    if (!("value" in descriptor)) throw new Error(`accessor property '${key}' is unsupported`);
    Object.defineProperty(cloned, key, {
      value: cloneSteeringValue(descriptor.value, nestedAncestors),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return cloned;
}

function isClonedModelMessage(value: unknown): value is ModelMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    typeof value.role === "string" &&
    ["system", "user", "assistant", "tool"].includes(value.role)
  );
}

function cloneQueuedMessageValue(message: ModelMessage): ModelMessage {
  const cloned = cloneSteeringValue(message, new Set());
  if (!isClonedModelMessage(cloned)) throw new Error("cloned message lost its valid role");
  return cloned;
}

function cloneQueuedMessage(message: ModelMessage, operation: "queue" | "deliver"): ModelMessage {
  try {
    return cloneQueuedMessageValue(message);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot ${operation} steering message: messages must be safely cloneable (${detail})`,
      { cause: error },
    );
  }
}

function cloneAssistantMessage(message: AssistantModelMessage): AssistantModelMessage {
  const cloned = cloneMessage(message);
  if (cloned.role !== "assistant") throw new Error("Expected an assistant message");
  return cloned;
}

function sumOptionalNumber(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function sumLanguageModelUsage(
  a: LanguageModelUsage | undefined,
  b: LanguageModelUsage | undefined,
): LanguageModelUsage | undefined {
  if (!a) return b;
  if (!b) return a;

  return {
    inputTokens: sumOptionalNumber(a.inputTokens, b.inputTokens),
    inputTokenDetails: {
      noCacheTokens: sumOptionalNumber(
        a.inputTokenDetails.noCacheTokens,
        b.inputTokenDetails.noCacheTokens,
      ),
      cacheReadTokens: sumOptionalNumber(
        a.inputTokenDetails.cacheReadTokens,
        b.inputTokenDetails.cacheReadTokens,
      ),
      cacheWriteTokens: sumOptionalNumber(
        a.inputTokenDetails.cacheWriteTokens,
        b.inputTokenDetails.cacheWriteTokens,
      ),
    },
    outputTokens: sumOptionalNumber(a.outputTokens, b.outputTokens),
    outputTokenDetails: {
      textTokens: sumOptionalNumber(
        a.outputTokenDetails.textTokens,
        b.outputTokenDetails.textTokens,
      ),
      reasoningTokens: sumOptionalNumber(
        a.outputTokenDetails.reasoningTokens,
        b.outputTokenDetails.reasoningTokens,
      ),
    },
    totalTokens: sumOptionalNumber(a.totalTokens, b.totalTokens),
    raw: undefined,
  };
}

function takeQueued<T>(mode: "one-at-a-time" | "all", queue: T[]): T[] {
  if (queue.length === 0) return [];
  if (mode === "one-at-a-time") {
    return [queue.shift()!];
  }
  const out = queue.slice();
  queue.length = 0;
  return out;
}

function peekQueued<T>(mode: "one-at-a-time" | "all", queue: T[]): T[] {
  if (queue.length === 0) return [];
  return mode === "one-at-a-time" ? queue.slice(0, 1) : queue.slice();
}

type FollowUpQueueEntry = {
  readonly message: ModelMessage;
};

type SteeringDeliverySelection = {
  readonly deliveryKind: SteeringDeliveryKind;
  readonly steeringEntries: readonly SteeringDeliveryEntry[];
  readonly followUpEntries: readonly FollowUpQueueEntry[];
  readonly canonicalMessages: readonly ModelMessage[];
};

type SteeringDeliveryHookResult =
  | { readonly status: "prepared" }
  | { readonly status: "failed"; readonly error: string };

type SteeringDeliveryPreparation = SteeringDeliverySelection & {
  readonly settled: Promise<void>;
  readonly settle: () => void;
  hookStatus: "pending" | "prepared";
};

type AwaitedSteeringInterruptRequest = {
  settled: boolean;
  readonly resolve: (result: AsyncInterruptQueuedSteeringResult) => void;
};

function takeAll<T>(queue: T[]): T[] {
  if (queue.length === 0) return [];
  const out = queue.slice();
  queue.length = 0;
  return out;
}

function makeUserMessage(input: string | ModelMessage): ModelMessage {
  if (typeof input === "string") {
    return { role: "user", content: input };
  }
  return input;
}

function mergeUserMessages(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return [];

  // If any user message has non-string content (multipart), do not merge.
  for (let i = messages.length - 1; i >= 0; i--) {
    const newest = messages[i]!;
    if (newest.role !== "user") continue;
    if (typeof newest.content !== "string") {
      return messages;
    }
  }

  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") {
      parts.push(m.content);
    }
  }

  const merged = parts.join("\n\n").trim();
  if (!merged) return messages;

  return [{ role: "user", content: merged }];
}

function canonicalSteeringMessages(
  followUps: readonly FollowUpQueueEntry[],
  steeringEntries: readonly SteeringDeliveryEntry[],
): ModelMessage[] {
  const firstSteering = steeringEntries[0];
  if (!firstSteering) return [];
  return [
    ...mergeUserMessages([...followUps.map((entry) => entry.message), firstSteering.message]),
    ...steeringEntries.slice(1).map((entry) => entry.message),
  ];
}

function hiddenToolRejection(toolName: string): string {
  return `Tool '${toolName}' was not offered on the step that produced this call, so it was not executed.`;
}

export function stripToolExecuteForModel<TOOLS extends ToolSet>(tools: TOOLS): ToolSet {
  // We keep the schema/description/title so the model can call tools,
  // but remove execution so we can run tools ourselves (enables steering).
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const {
        execute: _execute,
        needsApproval: _needsApproval,
        contextSchema: _contextSchema,
        ...rest
      } = tool;
      return [name, rest];
    }),
  ) as ToolSet;
}

type AssistantContentParts = Extract<AssistantContent, unknown[]>;
function upsertTextPart(
  content: AssistantContentParts,
  partType: "text" | "reasoning",
  delta: string,
): void {
  const last = content.length > 0 ? content[content.length - 1] : undefined;
  if (last && last.type === partType && "text" in last && typeof last.text === "string") {
    last.text += delta;
    return;
  }
  if (partType === "text") {
    content.push({ type: "text", text: delta });
    return;
  }
  content.push({ type: "reasoning", text: delta });
}

class TurnAbortedError extends Error {
  readonly reason: TurnAbortReason;
  readonly phase: TurnAbortPhase;
  readonly detail?: string;

  constructor(options: { reason: TurnAbortReason; phase: TurnAbortPhase; detail?: string }) {
    super(`Turn aborted (${options.reason}, ${options.phase})`);
    this.name = "TurnAbortedError";
    this.reason = options.reason;
    this.phase = options.phase;
    this.detail = options.detail;
  }
}

function getToolResultToolCallIds(message: ModelMessage): string[] {
  if (message.role !== "tool" && message.role !== "assistant") return [];
  if (!Array.isArray(message.content)) return [];

  const ids: string[] = [];
  for (const part of message.content) {
    if (part.type === "tool-result") {
      ids.push(part.toolCallId);
    }
  }
  return ids;
}

function getUnresolvedAssistantToolCallIds(message: ModelMessage): string[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];

  const open = new Set<string>();
  for (const part of message.content) {
    if (part.type === "tool-call") open.add(part.toolCallId);
    if (part.type === "tool-result") open.delete(part.toolCallId);
  }
  return [...open];
}

function completedAssistantPrefix(message: AssistantModelMessage): AssistantModelMessage | null {
  if (!Array.isArray(message.content)) {
    return message.content.length === 0 ? null : cloneAssistantMessage(message);
  }

  const openToolCallIds = new Set<string>();
  let lastValidIndex = -1;
  for (let index = 0; index < message.content.length; index += 1) {
    const part = message.content[index]!;
    if (part.type === "tool-call") openToolCallIds.add(part.toolCallId);
    if (part.type === "tool-result") openToolCallIds.delete(part.toolCallId);
    if (openToolCallIds.size === 0) lastValidIndex = index;
  }
  if (lastValidIndex < 0) return null;
  return {
    ...message,
    content: message.content.slice(0, lastValidIndex + 1).map((part) => ({ ...part })),
  };
}

type RecoveryCheckpoint = {
  baseMessages: ModelMessage[];
  suffixMessages: ModelMessage[];
};

function cloneMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map(cloneMessage);
}

function recoveryCheckpointForMessages(messages: readonly ModelMessage[]): RecoveryCheckpoint {
  const truncated = truncateToLastValidBoundary([...messages]);
  const baseMessages = cloneMessages(truncated.messages);
  if (truncated.droppedMessageCount === 0) return { baseMessages, suffixMessages: [] };

  const assistant = messages[baseMessages.length];
  if (assistant?.role !== "assistant" || !Array.isArray(assistant.content)) {
    return { baseMessages, suffixMessages: [] };
  }
  const completedToolCallIds = new Set(getToolResultToolCallIds(assistant));
  for (const message of messages.slice(baseMessages.length + 1)) {
    for (const toolCallId of getToolResultToolCallIds(message))
      completedToolCallIds.add(toolCallId);
  }
  const assistantContent = assistant.content.filter(
    (part) => part.type !== "tool-call" || completedToolCallIds.has(part.toolCallId),
  );
  const suffixMessages: ModelMessage[] = [];
  if (assistantContent.length > 0) {
    suffixMessages.push({
      ...assistant,
      content: assistantContent.map((part) => ({ ...part })),
    });
  }
  for (const message of messages.slice(baseMessages.length + 1)) {
    if (message.role !== "tool") continue;
    const content = message.content
      .filter((part) => part.type === "tool-result" && completedToolCallIds.has(part.toolCallId))
      .map((part) => ({ ...part }));
    if (content.length > 0) suffixMessages.push({ ...message, content });
  }
  return { baseMessages, suffixMessages };
}

function hasInlineToolResult(message: ModelMessage): boolean {
  return (
    message.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === "tool-result")
  );
}

function recoveryToolOutput(value: unknown): ToolResultOutput {
  if (typeof value === "string") return { type: "text", value };
  if (isRecord(value)) {
    if (value.type === "text" && typeof value.value === "string") {
      return { type: "text", value: value.value };
    }
    if (value.type === "error-text" && typeof value.value === "string") {
      return { type: "error-text", value: value.value };
    }
    if (value.type === "execution-denied") {
      return {
        type: "execution-denied",
        reason: typeof value.reason === "string" ? value.reason : undefined,
      };
    }
  }
  try {
    return { type: "text", value: JSON.stringify(value) ?? String(value) };
  } catch {
    return { type: "text", value: String(value) };
  }
}

function truncateToLastValidBoundary(messages: ModelMessage[]): {
  messages: ModelMessage[];
  droppedMessageCount: number;
} {
  let lastValidIndex = -1;
  let openToolCallIds: Set<string> | null = null;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;

    if (openToolCallIds) {
      if (message.role !== "tool") {
        break;
      }

      for (const toolCallId of getToolResultToolCallIds(message)) {
        openToolCallIds.delete(toolCallId);
      }

      if (openToolCallIds.size === 0) {
        openToolCallIds = null;
        lastValidIndex = i;
      }

      continue;
    }

    if (message.role === "tool") {
      break;
    }

    const toolCallIds = getUnresolvedAssistantToolCallIds(message);
    if (toolCallIds.length > 0) {
      openToolCallIds = new Set(toolCallIds);
      continue;
    }

    lastValidIndex = i;
  }

  const nextLength = lastValidIndex + 1;
  return {
    messages: messages.slice(0, nextLength),
    droppedMessageCount: messages.length - nextLength,
  };
}

/**
 * A small wrapper that provides a `pi-agent`-style event stream on top of
 * AI SDK `streamText(...).stream`.
 *
 * Notable behavior:
 * - The model can emit tool calls, but tools are executed locally by this wrapper.
 * - `steer()` is injected at turn boundaries (after the current tool phase).
 * - `interrupt()` aborts, rewinds to a valid boundary, appends a message, and reruns.
 */
export class AiSdkPiAgent<TOOLS extends ToolSet = ToolSet> {
  private listeners = new Set<(event: AiSdkPiAgentEvent<TOOLS>) => void>();
  private abortController: AbortController | undefined;
  private running: Promise<void> | undefined;

  private turnCounter = 0;
  private readonly captureModelViewMessages: boolean;
  private readonly sendToolsToModel: boolean;
  private readonly streamTextMaxRetries: number | undefined;

  /** `null` authorizes every tool in the current toolset. */
  private activeToolNames: ReadonlySet<string> | null = null;
  private lastStepToolSnapshot: StepToolSnapshot<TOOLS> | null = null;

  private steeringMode: SteeringMode = "one-at-a-time";
  private followUpMode: FollowUpMode = "one-at-a-time";
  private nextSteeringId = 1;
  private steeringQueue: SteeringDeliveryEntry[] = [];
  private steeringDeliveryPreparation: SteeringDeliveryPreparation | undefined;
  private deliveredSteeringMessages: ModelMessage[] = [];
  private followUpQueue: FollowUpQueueEntry[] = [];
  private recoveryCheckpoint: RecoveryCheckpoint | null = null;

  private pendingInterrupt: ModelMessage[] | null = null;
  private awaitedSteeringInterrupt: AwaitedSteeringInterruptRequest | null = null;
  private cancelResetPending = false;
  private abortRequestedReason: TurnAbortReason | null = null;

  private prepareFullModelView: PrepareFullModelView | undefined;
  private prepareFullBudgetView: PrepareFullBudgetView | undefined;
  private canonicalModelCallPreflight: CanonicalModelCallPreflight | undefined;
  private buildEphemeralOverlay: BuildEphemeralOverlay | undefined;
  private decorateRequestPayload: DecorateRequestPayload | undefined;
  private prepareModelCall: PrepareModelCall | undefined;
  private turnErrorHandler: TurnErrorHandler | undefined;
  private turnBoundaryHandler: TurnBoundaryHandler | undefined;
  private beforeSteeringDelivery: BeforeSteeringDeliveryHandler | undefined;
  private beforeStep: BeforeStepHandler | undefined;
  private experimentalDownload: DownloadFunction | undefined;
  private normalizeToolResultOutput: NormalizeToolResultOutputFn | undefined;
  private normalizeSettledToolResultOutputs: NormalizeSettledToolResultOutputsFn | undefined;
  private genericOutputNormalizerBypassTools: ReadonlySet<string>;
  private aggregateOutputBudgetExemptTools: ReadonlySet<string>;
  private exclusiveToolNames: ReadonlySet<string>;
  private alreadyNormalizedExternalToolCallIds = new Set<string>();
  private providerExecutedToolAttemptLatched = false;
  private activePersistentAttemptIdentity: string | undefined;

  private context?: unknown;

  /** Live execution and transcript state. */
  readonly state: AiSdkPiAgentState<TOOLS>;

  /** Create a new agent instance. */
  constructor(options: AiSdkPiAgentOptions<TOOLS>) {
    this.prepareFullModelView = options.prepareFullModelView;
    this.prepareFullBudgetView = options.prepareFullBudgetView;
    this.canonicalModelCallPreflight = options.canonicalModelCallPreflight;
    this.buildEphemeralOverlay = options.buildEphemeralOverlay;
    this.decorateRequestPayload = options.decorateRequestPayload;
    this.prepareModelCall = options.prepareModelCall;
    this.turnErrorHandler = options.turnErrorHandler;
    this.turnBoundaryHandler = options.turnBoundaryHandler;
    this.beforeSteeringDelivery = options.beforeSteeringDelivery;
    this.beforeStep = options.beforeStep;
    this.experimentalDownload = options.experimentalDownload;
    this.normalizeToolResultOutput = options.normalizeToolResultOutput;
    this.normalizeSettledToolResultOutputs = options.normalizeSettledToolResultOutputs;
    this.genericOutputNormalizerBypassTools =
      options.genericOutputNormalizerBypassTools ?? new Set<string>();
    this.aggregateOutputBudgetExemptTools =
      options.aggregateOutputBudgetExemptTools ?? new Set<string>();
    this.exclusiveToolNames = options.exclusiveToolNames ?? new Set<string>();
    this.sendToolsToModel = options.sendToolsToModel !== false;
    this.streamTextMaxRetries = options.streamTextMaxRetries;

    this.captureModelViewMessages = options.debug?.captureModelViewMessages === true;

    this.state = {
      system: options.system,
      model: options.model,
      modelSpecifier: options.modelSpecifier,
      tools: (options.tools ?? ({} as TOOLS)) as TOOLS,
      messages: normalizeReplayMessages(options.messages ?? []),
      providerOptions: options.providerOptions,
      reasoning: options.reasoning,
      isStreaming: false,
      streamMessage: null,
      pendingToolCalls: new Set<string>(),
      debug: this.captureModelViewMessages ? {} : undefined,
    };
  }

  /** Subscribe to streaming events. Returns an unsubscribe function. */
  subscribe(listener: (event: AiSdkPiAgentEvent<TOOLS>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AiSdkPiAgentEvent<TOOLS>) {
    // Avoid relying on Set iteration config (keeps this file tsconfig-agnostic).
    for (const listener of Array.from(this.listeners)) listener(event);
  }

  /** Replace the system prompt used for subsequent turns. */
  setSystem(system: SystemPrompt) {
    this.state.system = system;
  }

  /** Replace the model used for subsequent turns. */
  setModel(
    model: LanguageModel,
    providerOptions?: { [x: string]: JSONObject },
    modelSpecifier?: string,
    reasoning?: ModelReasoningEffort,
  ) {
    this.state.model = model;
    this.state.modelSpecifier = modelSpecifier;

    // (When not provided) Reset provider options in case incompatible.
    this.state.providerOptions = providerOptions;
    this.state.reasoning = reasoning;
  }

  /** Replace the toolset used for subsequent turns. */
  setTools(tools: TOOLS) {
    this.state.tools = tools;
  }

  /** Replace the tool names authorized on subsequent model steps. */
  setActiveTools(names: ReadonlySet<string>) {
    this.activeToolNames = new Set(names);
  }

  /** Authorize every tool in the current toolset on subsequent model steps. */
  clearActiveTools() {
    this.activeToolNames = null;
  }

  /** Add tool names to the authority of subsequent model steps. */
  activateTools(names: readonly string[]) {
    if (names.length === 0) return;
    const next = new Set(this.activeToolNames ?? Object.keys(this.state.tools));
    for (const name of names) next.add(name);
    this.activeToolNames = next;
  }

  /** Snapshot the configured active names, or `null` when unrestricted. */
  getActiveToolNames(): ReadonlySet<string> | null {
    return this.activeToolNames ? new Set(this.activeToolNames) : null;
  }

  /** Return the immutable authority used by the most recent model step. */
  getLastStepToolSnapshot(): StepToolSnapshot<TOOLS> | null {
    return this.lastStepToolSnapshot;
  }

  private createStepToolSnapshot(step: number): StepToolSnapshot<TOOLS> {
    const entries = Object.entries(this.state.tools).filter(
      ([name]) => this.activeToolNames === null || this.activeToolNames.has(name),
    );
    const tools = Object.freeze(
      Object.fromEntries(
        entries.map(([name, definition]) => [name, Object.freeze({ ...definition })]),
      ),
    ) as TOOLS;

    return Object.freeze({
      step,
      tools,
      names: Object.freeze(entries.map(([name]) => name)),
    });
  }

  /** Replace the tool context used for subsequent turns. */
  setContext(context: unknown) {
    this.context = context;
  }

  /** Snapshot the last replay-safe boundary, including completed provider-executed tool activity. */
  getRecoverableMessages(): ModelMessage[] {
    const checkpoint = this.recoveryCheckpoint;
    return checkpoint
      ? [...cloneMessages(checkpoint.baseMessages), ...cloneMessages(checkpoint.suffixMessages)]
      : cloneMessages(this.state.messages);
  }

  private markExternalToolCallNormalized(toolCallId: string): void {
    this.alreadyNormalizedExternalToolCallIds.delete(toolCallId);
    this.alreadyNormalizedExternalToolCallIds.add(toolCallId);
    while (this.alreadyNormalizedExternalToolCallIds.size > 256) {
      const oldest = this.alreadyNormalizedExternalToolCallIds.values().next().value;
      if (oldest === undefined) break;
      this.alreadyNormalizedExternalToolCallIds.delete(oldest);
    }
  }

  /** Execute a provider-originated tool call through the same atomic path as local calls. */
  async executeExternalToolCall(input: {
    toolCallId: string;
    toolName: string;
    input: unknown;
    abortSignal?: AbortSignal;
    inputValidation?: "validate" | "prevalidated";
  }): Promise<ExternalToolExecutionOutcome> {
    this.providerExecutedToolAttemptLatched = true;
    const signals = [input.abortSignal, this.abortController?.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const abortSignal =
      signals.length > 1 ? AbortSignal.any(signals) : signals.length === 1 ? signals[0] : undefined;

    const snapshot: StepToolSnapshot<TOOLS> = this.lastStepToolSnapshot ?? {
      step: 0,
      tools: this.state.tools,
      names: Object.keys(this.state.tools),
    };
    const snapshotTools = snapshot.tools;

    let outcome: AtomicToolExecutionOutcome;
    try {
      outcome = await executeAtomicToolCall({
        call: {
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          input: input.input,
        },
        tools: snapshotTools,
        ...(snapshotTools[input.toolName] === undefined && this.state.tools[input.toolName]
          ? { executionRejection: hiddenToolRejection(input.toolName) }
          : {}),
        messages: this.state.messages,
        context: this.context,
        abortSignal,
        pendingToolCalls: this.state.pendingToolCalls,
        inputValidation: { type: input.inputValidation ?? "validate" },
        expansionHandling: { type: "capture" },
        normalizeToolResultOutput: this.normalizeToolResultOutput,
        bypassGenericOutputNormalizer: this.genericOutputNormalizerBypassTools.has(input.toolName),
        aggregateOutputBudgetExempt: this.aggregateOutputBudgetExemptTools.has(input.toolName),
        onEvent: (event) => this.emit(event),
      });
    } catch (error) {
      if (abortSignal?.aborted) this.alreadyNormalizedExternalToolCallIds.clear();
      throw error;
    }

    let executedExpansion: ExternalToolExecutionOutcome["executedExpansion"];
    if (outcome.expansion) {
      let childOutcomes: AtomicToolExecutionOutcome[];
      try {
        childOutcomes =
          outcome.expansion.children.length === 0
            ? []
            : await this.executeExpansionChildren([...outcome.expansion.children], snapshot, {
                abortSignal,
                appendToTranscript: false,
              });
      } catch (error) {
        if (abortSignal?.aborted) this.alreadyNormalizedExternalToolCallIds.clear();
        throw error;
      }
      executedExpansion = {
        children: outcome.expansion.children.map((child, index) => {
          const childOutcome = childOutcomes[index];
          if (!childOutcome) {
            throw new Error(`Missing tool execution outcome for toolCallId=${child.toolCallId}`);
          }
          return {
            toolCallId: child.toolCallId,
            toolName: child.toolName,
            isError: childOutcome.isError,
            outcome: childOutcome.outcome,
            toolOutput: childOutcome.toolOutput,
          };
        }),
      };
    }

    this.markExternalToolCallNormalized(input.toolCallId);
    return { ...outcome, ...(executedExpansion ? { executedExpansion } : {}) };
  }

  setPrepareFullModelView(prepareFullModelView: PrepareFullModelView | undefined) {
    this.prepareFullModelView = prepareFullModelView;
  }

  setPrepareFullBudgetView(prepareFullBudgetView: PrepareFullBudgetView | undefined) {
    this.prepareFullBudgetView = prepareFullBudgetView;
  }

  setCanonicalModelCallPreflight(
    canonicalModelCallPreflight: CanonicalModelCallPreflight | undefined,
  ) {
    this.canonicalModelCallPreflight = canonicalModelCallPreflight;
  }

  setBuildEphemeralOverlay(buildEphemeralOverlay: BuildEphemeralOverlay | undefined) {
    this.buildEphemeralOverlay = buildEphemeralOverlay;
  }

  setDecorateRequestPayload(decorateRequestPayload: DecorateRequestPayload | undefined) {
    this.decorateRequestPayload = decorateRequestPayload;
  }

  appendDecorateRequestPayload(decorateRequestPayload: DecorateRequestPayload) {
    const previous = this.decorateRequestPayload;
    this.decorateRequestPayload = previous
      ? async (messages, context) =>
          decorateRequestPayload(await previous(messages, context), context)
      : decorateRequestPayload;
  }

  setPrepareModelCall(prepareModelCall: PrepareModelCall | undefined) {
    this.prepareModelCall = prepareModelCall;
  }

  /** Replace the turn-error recovery hook. */
  setTurnErrorHandler(turnErrorHandler: TurnErrorHandler | undefined) {
    this.turnErrorHandler = turnErrorHandler;
  }

  /** Replace the custom URL download hook used by subsequent model calls. */
  setExperimentalDownload(experimentalDownload: DownloadFunction | undefined) {
    this.experimentalDownload = experimentalDownload;
  }

  /** Replace tool names whose outputs bypass the generic output normalizer. */
  setGenericOutputNormalizerBypassTools(toolNames: ReadonlySet<string>) {
    this.genericOutputNormalizerBypassTools = new Set(toolNames);
  }

  /** Replace trusted tool names excluded from settled aggregate output budgeting. */
  setAggregateOutputBudgetExemptTools(toolNames: ReadonlySet<string>) {
    this.aggregateOutputBudgetExemptTools = new Set(toolNames);
  }

  /** Replace the post-tool, pre-model turn-boundary hook. */
  setTurnBoundaryHandler(turnBoundaryHandler: TurnBoundaryHandler | undefined) {
    this.turnBoundaryHandler = turnBoundaryHandler;
  }

  /** Replace the awaited pre-steering-delivery hook. */
  setBeforeSteeringDeliveryHandler(
    beforeSteeringDelivery: BeforeSteeringDeliveryHandler | undefined,
  ) {
    this.beforeSteeringDelivery = beforeSteeringDelivery;
  }

  /** Replace the pre-model-step refresh hook. */
  setBeforeStep(beforeStep: BeforeStepHandler | undefined) {
    this.beforeStep = beforeStep;
  }

  /** Replace the entire transcript. Use with care. */
  replaceMessages(
    messages: ModelMessage[],
    options?: {
      reason?: "replace" | "compaction";
      /** Rebuild an existing crash-recovery checkpoint against the replacement transcript. */
      preserveRecoveryCheckpoint?: boolean;
    },
  ) {
    if (this.state.streamMessage || this.state.pendingToolCalls.size > 0) {
      throw new Error(
        "Cannot replace messages during a turn. Wait for the current model/tool step to finish.",
      );
    }

    const previousMessageCount = this.state.messages.length;
    const hadRecoveryCheckpoint = this.recoveryCheckpoint !== null;
    this.state.messages = normalizeReplayMessages(messages);
    this.state.streamMessage = null;
    this.state.pendingToolCalls = new Set();
    this.recoveryCheckpoint =
      options?.preserveRecoveryCheckpoint && hadRecoveryCheckpoint
        ? recoveryCheckpointForMessages(this.state.messages)
        : null;
    this.alreadyNormalizedExternalToolCallIds.clear();

    this.emit({
      type: "messages_reset",
      reason: options?.reason ?? "replace",
      messages: this.state.messages.map(cloneMessage),
      previousMessageCount,
    });
  }

  /** Append messages to the existing transcript while idle. */
  appendMessages(messages: ModelMessage[]) {
    if (this.state.streamMessage || this.state.pendingToolCalls.size > 0) {
      throw new Error(
        "Cannot append messages during a turn. Wait for the current model/tool step to finish.",
      );
    }

    for (const message of messages) {
      this.appendMessage(message);
    }
  }

  /** Clear the transcript. */
  clearMessages() {
    this.replaceMessages([], { reason: "replace" });
  }

  /** Configure how `steer()` messages are drained. */
  setSteeringMode(mode: SteeringMode) {
    this.steeringMode = mode;
  }

  /** Configure how `followUp()` messages are drained. */
  setFollowUpMode(mode: FollowUpMode) {
    this.followUpMode = mode;
  }

  /**
   * Queue a steering message.
   *
   * Steering is checked at turn boundaries. If a turn is executing tools,
   * queued steering messages are injected after the current tool phase completes.
   */
  steer(message: string | ModelMessage): SteeringQueueId {
    const queuedMessage = cloneQueuedMessage(makeUserMessage(message), "queue");
    const id = `steering-${this.nextSteeringId++}`;
    this.steeringQueue.push({
      id,
      message: queuedMessage,
    });
    return id;
  }

  /** Snapshot entries that have not yet been drained at a steering boundary. */
  getQueuedSteeringIds(): SteeringQueueId[] {
    return this.steeringQueue.map((entry) => entry.id);
  }

  /** Mark provider-injected steering as delivered and retain it in the canonical transcript. */
  acknowledgeSteeringDelivery(id: SteeringQueueId): boolean {
    if (this.awaitedSteeringInterrupt && this.steeringQueue.some((entry) => entry.id === id)) {
      throw new Error(`Cannot acknowledge steering '${id}' while an interrupt is pending`);
    }
    if (this.steeringDeliveryPreparation?.steeringEntries.some((entry) => entry.id === id)) {
      throw new Error(`Cannot acknowledge steering '${id}' while its delivery is being prepared`);
    }
    const index = this.steeringQueue.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    const [entry] = this.steeringQueue.splice(index, 1);
    if (!entry) return false;
    this.deliveredSteeringMessages.push(entry.message);
    return true;
  }

  /**
   * Queue a follow-up user message.
   *
   * Follow-ups are only injected when a turn finishes without tool calls.
   */
  followUp(message: string | ModelMessage) {
    this.followUpQueue.push({
      message: cloneQueuedMessage(makeUserMessage(message), "queue"),
    });
  }

  /**
   * Interrupt the active turn with a snapshot of every currently queued steering message.
   *
   * Buffered follow-ups are included ahead of steering messages, matching normal
   * steering-boundary behavior. Queued steering is left untouched while idle.
   *
   * This legacy synchronous path cannot await `beforeSteeringDelivery` and therefore is
   * not a durable pre-delivery boundary. It refuses to race an ordinary preparation.
   * Durable integrations must use `interruptQueuedSteeringAsync()`, which passes the selected
   * entries to the hook with `deliveryKind: "interrupt"`, awaits it, and only then removes
   * them and requests the abort.
   */
  interruptQueuedSteering(): InterruptQueuedSteeringResult {
    if (this.steeringQueue.length === 0) return { status: "empty" };
    if (!this.state.isStreaming || this.cancelResetPending) return { status: "inactive" };
    if (this.awaitedSteeringInterrupt || this.steeringDeliveryPreparation) {
      return { status: "inactive" };
    }

    const steering = takeAll(this.steeringQueue);
    const followUps = takeAll(this.followUpQueue);
    const pendingInterrupt = this.pendingInterrupt;
    this.pendingInterrupt = mergeUserMessages([
      ...(pendingInterrupt ?? []),
      ...followUps.map((entry) => entry.message),
      ...steering.map((entry) => entry.message),
    ]);
    if (!pendingInterrupt) this.requestAbort("interrupt");

    return {
      status: "interrupted",
      steeringIds: steering.map((entry) => entry.id),
    };
  }

  /**
   * Request an awaited steering interrupt.
   *
   * The active model/tool phase is aborted and settled first. The run loop then rewinds to a
   * valid boundary, creates a fresh abort controller, and only there selects and prepares the
   * steering/follow-up prefixes. Selected entries remain queued until the hook succeeds.
   */
  async interruptQueuedSteeringAsync(): Promise<AsyncInterruptQueuedSteeringResult> {
    if (this.steeringQueue.length === 0) return { status: "empty" };
    if (
      !this.state.isStreaming ||
      this.cancelResetPending ||
      this.pendingInterrupt ||
      this.awaitedSteeringInterrupt ||
      this.steeringDeliveryPreparation
    ) {
      return { status: "inactive" };
    }

    return new Promise<AsyncInterruptQueuedSteeringResult>((resolve) => {
      this.awaitedSteeringInterrupt = { settled: false, resolve };
      this.requestAbort("interrupt");
    });
  }

  private requestAbort(reason: TurnAbortReason) {
    this.alreadyNormalizedExternalToolCallIds.clear();
    if (reason === "cancel") {
      this.abortRequestedReason = "cancel";
    } else if (reason === "interrupt" && this.abortRequestedReason !== "cancel") {
      this.abortRequestedReason = "interrupt";
    } else if (!this.abortRequestedReason) {
      this.abortRequestedReason = "manual";
    }

    this.abortController?.abort();
  }

  private takePendingInterrupt(): ModelMessage[] | null {
    const messages = this.pendingInterrupt;
    this.pendingInterrupt = null;
    return messages;
  }

  /**
   * Abort the current run.
   *
   * Emits `turn_abort` (reason: `manual`) and ends the agent loop without
   * rewinding the transcript.
   */
  abort() {
    const awaitedInterrupt = this.awaitedSteeringInterrupt;
    if (awaitedInterrupt && !this.steeringDeliveryPreparation) {
      this.settleAwaitedSteeringInterrupt(awaitedInterrupt, { status: "inactive" });
      this.abortRequestedReason = "manual";
      this.abortController?.abort();
      return;
    }
    this.requestAbort("manual");
  }

  /**
   * Cancel the current run without adding a message.
   *
   * Cancellation clears queued work and rewinds the transcript to its last valid
   * boundary. A `messages_reset` event with reason `cancel` is authoritative.
   */
  cancel() {
    // Queued (undelivered) work is discarded, but messages the model already
    // received are committed by `finishCancellation`.
    if (!this.steeringDeliveryPreparation) {
      this.steeringQueue.length = 0;
      this.followUpQueue.length = 0;
    }
    this.pendingInterrupt = null;

    if (!this.state.isStreaming) {
      this.finishCancellation();
      return;
    }

    this.cancelResetPending = true;
    this.requestAbort("cancel");
  }

  /**
   * Interrupt the current run.
   *
   * Behavior:
   * - If streaming: abort, emit `turn_abort`/`messages_reset`, append the message, rerun.
   * - If idle: falls back to `prompt(message)`.
   *
   * Only one interrupt may be pending at a time; a second call throws.
   */
  async interrupt(message: string | ModelMessage) {
    if (!this.state.isStreaming) {
      await this.prompt(message);
      return;
    }

    if (this.pendingInterrupt) {
      throw new Error("Interrupt already pending");
    }
    if (this.awaitedSteeringInterrupt) {
      throw new Error("Queued steering interrupt already pending");
    }
    if (this.steeringDeliveryPreparation) {
      throw new Error("Cannot interrupt while steering delivery is being prepared");
    }

    this.pendingInterrupt = [makeUserMessage(message)];
    this.requestAbort("interrupt");
  }

  /** Wait until the agent finishes processing (or aborts/errors). */
  async waitForIdle() {
    await this.running;
  }

  /**
   * Start a new agent run by appending message(s) and executing turns until done.
   */
  async prompt(input: string | ModelMessage | ModelMessage[]) {
    if (this.state.isStreaming) {
      throw new Error("Agent is already processing. Use steer() or followUp(), or waitForIdle().");
    }

    const newMessages = Array.isArray(input)
      ? input
      : typeof input === "string"
        ? [makeUserMessage(input)]
        : [input];

    await this.runLoop({ newMessages });
  }

  /**
   * Continue from the current transcript.
   *
   * The last message must not be an assistant message.
   */
  async continue() {
    if (this.state.isStreaming) {
      throw new Error("Agent is already processing. Wait for completion before continuing.");
    }

    const messages = this.state.messages;
    if (messages.length === 0) throw new Error("No messages to continue from");
    const last = messages[messages.length - 1]!;
    if (last.role === "assistant") throw new Error("Cannot continue from assistant message");

    await this.runLoop({ newMessages: undefined });
  }

  private appendMessage(message: ModelMessage) {
    const normalizedMessage = normalizeAssistantToolCallInputMessage(message);
    this.state.messages.push(normalizedMessage);
    this.emit({ type: "message_start", message: cloneMessage(normalizedMessage) });
    this.emit({ type: "message_end", message: cloneMessage(normalizedMessage) });
  }

  private async normalizeToolOutput(
    output: ToolResultOutput,
    context: Parameters<NormalizeToolResultOutputFn>[1],
  ): Promise<ToolResultOutput> {
    return normalizeToolResultOutput(output, context, this.normalizeToolResultOutput);
  }

  private selectSteeringDelivery(
    deliveryKind: SteeringDeliveryKind,
    mode: SteeringMode,
  ): SteeringDeliverySelection | undefined {
    const steeringEntries = Object.freeze(peekQueued(mode, this.steeringQueue));
    if (steeringEntries.length === 0) return undefined;
    const followUpEntries = Object.freeze(this.followUpQueue.slice());
    const canonicalMessages = Object.freeze(
      canonicalSteeringMessages(followUpEntries, steeringEntries).map((message) =>
        cloneQueuedMessage(normalizeAssistantToolCallInputMessage(message), "deliver"),
      ),
    );
    return Object.freeze({
      deliveryKind,
      steeringEntries,
      followUpEntries,
      canonicalMessages,
    });
  }

  private createSteeringDeliveryPreparation(
    selection: SteeringDeliverySelection,
  ): SteeringDeliveryPreparation {
    let settle = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    return {
      ...selection,
      hookStatus: "pending",
      settled,
      settle,
    };
  }

  private steeringPreparationMatchesQueues(preparation: SteeringDeliveryPreparation): boolean {
    return (
      preparation.steeringEntries.every((entry, index) => this.steeringQueue[index] === entry) &&
      preparation.followUpEntries.every((entry, index) => this.followUpQueue[index] === entry)
    );
  }

  private async invokeSteeringDeliveryHook(
    preparation: SteeringDeliveryPreparation,
  ): Promise<SteeringDeliveryHookResult> {
    try {
      if (this.beforeSteeringDelivery) {
        const batch = Object.freeze(
          preparation.steeringEntries.map((entry) =>
            Object.freeze({
              id: entry.id,
              message: cloneQueuedMessage(entry.message, "deliver"),
            }),
          ),
        );
        const canonicalMessages = Object.freeze(
          preparation.canonicalMessages.map((message) => cloneQueuedMessage(message, "deliver")),
        );
        const abortSignal = this.abortController?.signal;
        await this.beforeSteeringDelivery(
          Object.freeze({
            deliveryKind: preparation.deliveryKind,
            batch,
            canonicalMessages,
            ...(abortSignal ? { abortSignal } : {}),
          }),
        );
      }
      preparation.hookStatus = "prepared";
      return { status: "prepared" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        type: "steering_delivery_failed",
        deliveryKind: preparation.deliveryKind,
        steeringIds: preparation.steeringEntries.map((entry) => entry.id),
        error: message,
      });
      return { status: "failed", error: message };
    }
  }

  private clearSteeringDeliveryPreparation(preparation: SteeringDeliveryPreparation): void {
    if (this.steeringDeliveryPreparation === preparation) {
      this.steeringDeliveryPreparation = undefined;
    }
    preparation.settle();
  }

  private consumeSteeringDelivery(preparation: SteeringDeliveryPreparation): ModelMessage[] {
    if (
      this.steeringDeliveryPreparation !== preparation ||
      preparation.hookStatus !== "prepared" ||
      !this.steeringPreparationMatchesQueues(preparation)
    ) {
      throw new Error("Cannot consume steering entries without their successful preparation");
    }

    this.steeringQueue.splice(0, preparation.steeringEntries.length);
    this.followUpQueue.splice(0, preparation.followUpEntries.length);
    const canonicalMessages = preparation.canonicalMessages.map((message) =>
      cloneQueuedMessage(message, "deliver"),
    );
    this.clearSteeringDeliveryPreparation(preparation);
    return canonicalMessages;
  }

  private settleAwaitedSteeringInterrupt(
    request: AwaitedSteeringInterruptRequest,
    result: AsyncInterruptQueuedSteeringResult,
  ): void {
    if (request.settled) return;
    request.settled = true;
    if (this.awaitedSteeringInterrupt === request) this.awaitedSteeringInterrupt = null;
    request.resolve(result);
  }

  private async deliverAwaitedSteeringInterrupt(
    request: AwaitedSteeringInterruptRequest,
  ): Promise<void> {
    if (request.settled || this.awaitedSteeringInterrupt !== request) return;
    if (this.cancelResetPending) {
      this.settleAwaitedSteeringInterrupt(request, { status: "inactive" });
      return;
    }

    const selection = this.selectSteeringDelivery("interrupt", "all");
    if (!selection) {
      this.settleAwaitedSteeringInterrupt(request, { status: "empty" });
      return;
    }

    const preparation = this.createSteeringDeliveryPreparation(selection);
    this.steeringDeliveryPreparation = preparation;
    const hookResult = await this.invokeSteeringDeliveryHook(preparation);
    if (hookResult.status === "failed") {
      this.clearSteeringDeliveryPreparation(preparation);
      this.settleAwaitedSteeringInterrupt(request, {
        status: "failed",
        steeringIds: preparation.steeringEntries.map((entry) => entry.id),
        error: hookResult.error,
      });
      return;
    }

    const canonicalMessages = this.consumeSteeringDelivery(preparation);
    for (const message of canonicalMessages) this.appendMessage(message);
    this.settleAwaitedSteeringInterrupt(request, {
      status: "interrupted",
      steeringIds: preparation.steeringEntries.map((entry) => entry.id),
    });
  }

  private beginFreshPostInterruptPhase(): void {
    this.abortController = new AbortController();
    this.abortRequestedReason = null;
  }

  private async prepareQueuedSteeringDelivery(): Promise<
    | { readonly status: "empty" | "failed" | "external-settled" }
    | { readonly status: "prepared"; readonly preparation: SteeringDeliveryPreparation }
  > {
    const existing = this.steeringDeliveryPreparation;
    if (existing) {
      if (existing.deliveryKind === "interrupt") {
        await existing.settled;
        return { status: "external-settled" };
      }
      if (!this.steeringPreparationMatchesQueues(existing)) {
        throw new Error("Prepared steering entries no longer match the queue prefixes");
      }
      if (existing.hookStatus === "prepared") {
        return { status: "prepared", preparation: existing };
      }
      throw new Error("Queued steering preparation was re-entered while still pending");
    }

    const selection = this.selectSteeringDelivery("queued", this.steeringMode);
    if (!selection) return { status: "empty" };
    const preparation = this.createSteeringDeliveryPreparation(selection);
    this.steeringDeliveryPreparation = preparation;
    const hookResult = await this.invokeSteeringDeliveryHook(preparation);
    if (hookResult.status === "failed") {
      this.clearSteeringDeliveryPreparation(preparation);
      return { status: "failed" };
    }
    return { status: "prepared", preparation };
  }

  private async normalizeNewToolMessage(message: ToolModelMessage): Promise<ToolModelMessage> {
    const content: ToolModelMessage["content"] = [];
    for (const part of message.content) {
      if (part.type !== "tool-result") {
        content.push(part);
        continue;
      }
      if (this.alreadyNormalizedExternalToolCallIds.delete(part.toolCallId)) {
        content.push(part);
        continue;
      }
      if (!this.normalizeToolResultOutput) {
        content.push(part);
        continue;
      }
      content.push({
        ...part,
        output: await this.normalizeToolOutput(part.output, {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
        }),
      });
    }
    return { ...message, content };
  }

  private async normalizeNewAssistantMessage(
    message: AssistantModelMessage,
  ): Promise<AssistantModelMessage> {
    if (!Array.isArray(message.content)) return message;

    const content: AssistantContentParts = [];
    for (const part of message.content) {
      if (part.type !== "tool-result") {
        content.push(part);
        continue;
      }
      if (this.alreadyNormalizedExternalToolCallIds.delete(part.toolCallId)) {
        content.push(part);
        continue;
      }
      if (!this.normalizeToolResultOutput) {
        content.push(part);
        continue;
      }
      content.push({
        ...part,
        output: await this.normalizeToolOutput(part.output, {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
        }),
      });
    }
    return { ...message, content };
  }

  private resetMessagesAfterAbort(
    reason: "cancel" | "interrupt",
    appendBeforeRecovery: ModelMessage[] = [],
  ) {
    const truncated = truncateToLastValidBoundary(this.state.messages);
    const checkpoint = this.recoveryCheckpoint;
    this.state.messages = [
      ...(checkpoint === null ? truncated.messages : cloneMessages(checkpoint.baseMessages)),
      ...appendBeforeRecovery,
      ...(checkpoint === null ? [] : cloneMessages(checkpoint.suffixMessages)),
    ];
    this.state.streamMessage = null;
    this.state.pendingToolCalls = new Set();
    this.recoveryCheckpoint = null;
    this.alreadyNormalizedExternalToolCallIds.clear();

    this.emit({
      type: "messages_reset",
      reason,
      messages: this.state.messages.map(cloneMessage),
      droppedMessageCount: truncated.droppedMessageCount,
    });
  }

  private checkpointRecoveryDraft(message: AssistantModelMessage): void {
    const checkpoint = completedAssistantPrefix(message);
    if (checkpoint === null) return;
    this.recoveryCheckpoint = {
      baseMessages: cloneMessages(truncateToLastValidBoundary(this.state.messages).messages),
      suffixMessages: [checkpoint],
    };
  }

  private checkpointCurrentToolExchange(): void {
    this.recoveryCheckpoint = recoveryCheckpointForMessages(this.state.messages);
  }

  private finishCancellation() {
    const awaitedInterrupt = this.awaitedSteeringInterrupt;
    if (awaitedInterrupt) {
      this.settleAwaitedSteeringInterrupt(awaitedInterrupt, { status: "inactive" });
    }
    // Steering the model already received stays in the transcript even though
    // the run was cancelled. Provider-executed work it caused is preserved by
    // recovery, so dropping the message would leave an answer to a question no
    // user turn ever asked. Undelivered steering is still discarded.
    this.resetMessagesAfterAbort("cancel", takeAll(this.deliveredSteeringMessages));
    this.steeringQueue.length = 0;
    this.steeringDeliveryPreparation = undefined;
    this.followUpQueue.length = 0;
    this.pendingInterrupt = null;
    this.cancelResetPending = false;
  }

  private async runLoop(options: { newMessages: ModelMessage[] | undefined }) {
    this.state.isStreaming = true;
    this.state.streamMessage = null;
    this.state.pendingToolCalls = new Set();
    this.recoveryCheckpoint = null;
    this.state.error = undefined;

    this.abortController = new AbortController();
    this.abortRequestedReason = null;

    this.running = (async () => {
      this.emit({ type: "agent_start" });

      let runTotalUsage: LanguageModelUsage | undefined = undefined;

      try {
        if (options.newMessages) {
          for (const msg of options.newMessages) {
            this.appendMessage(msg);
          }
        }

        while (true) {
          if (this.cancelResetPending) {
            this.emit({ type: "turn_abort", reason: "cancel", phase: "tools" });
            this.finishCancellation();
            break;
          }

          // Awaited steering interrupts prepare only after the active phase has settled.
          const awaitedInterrupt = this.awaitedSteeringInterrupt;
          if (awaitedInterrupt) {
            this.emit({
              type: "turn_abort",
              reason: "interrupt",
              phase: "tools",
            });
            this.resetMessagesAfterAbort("interrupt");
            this.beginFreshPostInterruptPhase();
            await this.deliverAwaitedSteeringInterrupt(awaitedInterrupt);
            if (this.cancelResetPending) {
              this.finishCancellation();
              break;
            }
            if (this.abortController?.signal.aborted) {
              const reason = this.abortRequestedReason ?? "manual";
              this.emit({ type: "turn_abort", reason, phase: "tools" });
              break;
            }
            continue;
          }

          // Handle a legacy interrupt that arrived between awaited operations.
          if (this.pendingInterrupt) {
            const interruptMessages = this.takePendingInterrupt();
            if (!interruptMessages) continue;

            this.emit({
              type: "turn_abort",
              reason: "interrupt",
              phase: "tools",
            });

            this.resetMessagesAfterAbort("interrupt");
            if (this.cancelResetPending) {
              this.finishCancellation();
              break;
            }
            for (const message of interruptMessages) this.appendMessage(message);

            this.beginFreshPostInterruptPhase();
          } else if (this.abortController?.signal.aborted) {
            // Manual abort between turns.
            const reason: TurnAbortReason = this.abortRequestedReason ?? "manual";
            this.emit({ type: "turn_abort", reason, phase: "tools" });
            break;
          }

          let modelTurnCompleted = false;
          let turnErrorPhase: TurnErrorPhase = "before-step";
          const localToolDraftIds = new Set<string>();

          try {
            const turn = await this.runTurn({
              onErrorPhase: (phase) => {
                turnErrorPhase = phase;
                if (phase === "post-model") modelTurnCompleted = true;
              },
              onProviderExecutedTool: () => {
                this.providerExecutedToolAttemptLatched = true;
              },
              onLocalToolDraft: (toolCallId) => {
                localToolDraftIds.add(toolCallId);
              },
            });
            modelTurnCompleted = true;
            turnErrorPhase = "post-model";
            if (this.cancelResetPending) {
              throw new TurnAbortedError({ reason: "cancel", phase: "model" });
            }

            for (const delivered of takeAll(this.deliveredSteeringMessages)) {
              this.appendMessage(delivered);
            }
            for (const added of turn.newMessages) {
              this.state.messages.push(added);
            }
            this.recoveryCheckpoint = null;
            for (const added of turn.newMessages) {
              if (
                added.role === "assistant" &&
                getUnresolvedAssistantToolCallIds(added).length > 0
              ) {
                this.checkpointCurrentToolExchange();
              }
            }
            if (truncateToLastValidBoundary(this.state.messages).droppedMessageCount === 0) {
              this.recoveryCheckpoint = null;
            }

            runTotalUsage = sumLanguageModelUsage(runTotalUsage, turn.totalUsage);

            this.emit({
              type: "turn_end",
              finishReason: turn.finishReason,
              newMessages: turn.newMessages.map(cloneMessage),
              usage: turn.usage,
              totalUsage: turn.totalUsage,
            });

            if (this.cancelResetPending) {
              throw new TurnAbortedError({ reason: "cancel", phase: "tools" });
            }

            // Parsed local calls are authoritative even when compatible providers
            // return a non-standard finish reason such as "other".
            const hasLocalToolCalls = turn.toolCalls.length > 0;
            // AI SDK materializes rejected tool inputs as completed tool results.
            // Continue so the model can inspect the validation error and retry.
            const hasCompletedToolExchange =
              turn.finishReason === "tool-calls" &&
              turn.newMessages.some(
                (message) => message.role === "tool" || hasInlineToolResult(message),
              );
            const executedToolCallCount = hasLocalToolCalls
              ? await this.executeToolCalls(turn.toolCalls, turn.toolSnapshot)
              : 0;
            if (hasLocalToolCalls) this.recoveryCheckpoint = null;

            const boundaryDecision = await this.applyTurnBoundary({
              finishReason: turn.finishReason,
              modelInputMessages: turn.modelInputMessages,
              executedToolCallCount,
            });

            if (this.cancelResetPending) {
              throw new TurnAbortedError({ reason: "cancel", phase: "tools" });
            }
            if (this.awaitedSteeringInterrupt) continue;
            if (this.pendingInterrupt) continue;

            // Steering should pick up any buffered follow-ups and remains ahead of
            // the normal tool-result continuation decision.
            const steeringPreparation = await this.prepareQueuedSteeringDelivery();
            if (steeringPreparation.status === "prepared") {
              const canonicalMessages = this.consumeSteeringDelivery(
                steeringPreparation.preparation,
              );
              for (const msg of canonicalMessages) {
                this.appendMessage(msg);
              }
              continue;
            }

            if (this.cancelResetPending) {
              throw new TurnAbortedError({ reason: "cancel", phase: "tools" });
            }
            if (this.pendingInterrupt || this.abortController?.signal.aborted) continue;

            const naturallyRequiresNextTurn =
              hasLocalToolCalls || hasCompletedToolExchange || boundaryDecision.requiresNextTurn;
            if (
              steeringPreparation.status === "failed" ||
              steeringPreparation.status === "external-settled"
            ) {
              if (naturallyRequiresNextTurn) continue;
              this.recoveryCheckpoint = null;
              break;
            }

            if (turn.finishReason !== "tool-calls") {
              const followUps = takeQueued(this.followUpMode, this.followUpQueue);
              if (followUps.length > 0) {
                const merged = mergeUserMessages(followUps.map((entry) => entry.message));
                for (const msg of merged) {
                  this.appendMessage(msg);
                }
                continue;
              }
            }

            if (naturallyRequiresNextTurn) {
              continue;
            }

            // A normally completed run persists its finalized messages. The
            // checkpoint is only authoritative when the active block aborts.
            this.recoveryCheckpoint = null;
            break;
          } catch (err) {
            if (err instanceof TurnAbortedError) {
              this.emit({
                type: "turn_abort",
                reason: err.reason,
                phase: err.phase,
                detail: err.detail,
              });

              if (this.cancelResetPending && err.reason !== "cancel") {
                this.finishCancellation();
                break;
              }

              if (err.reason === "interrupt") {
                const awaitedInterrupt = this.awaitedSteeringInterrupt;
                if (awaitedInterrupt) {
                  this.resetMessagesAfterAbort("interrupt");
                  this.beginFreshPostInterruptPhase();
                  await this.deliverAwaitedSteeringInterrupt(awaitedInterrupt);
                  if (this.cancelResetPending) {
                    this.finishCancellation();
                    break;
                  }
                  if (this.abortController?.signal.aborted) {
                    const reason = this.abortRequestedReason ?? "manual";
                    this.emit({ type: "turn_abort", reason, phase: "tools" });
                    break;
                  }
                  continue;
                }

                const interruptMessages = this.takePendingInterrupt();

                if (!interruptMessages) {
                  break;
                }

                this.resetMessagesAfterAbort("interrupt");
                if (this.cancelResetPending) {
                  this.finishCancellation();
                  break;
                }
                for (const message of interruptMessages) this.appendMessage(message);

                this.beginFreshPostInterruptPhase();

                continue;
              }

              if (err.reason === "cancel") {
                this.finishCancellation();
                break;
              }

              // Manual abort: stop agent loop cleanly.
              break;
            }

            if (this.cancelResetPending) {
              this.emit({
                type: "turn_abort",
                reason: "cancel",
                phase: this.state.pendingToolCalls.size > 0 ? "tools" : "model",
                detail: err instanceof Error ? err.message : String(err),
              });
              this.finishCancellation();
              break;
            }

            for (const delivered of takeAll(this.deliveredSteeringMessages)) {
              this.appendMessage(delivered);
            }

            if (this.turnErrorHandler) {
              const lastMessage = this.state.messages.at(-1);
              const retrySafety: TurnRetrySafety = modelTurnCompleted
                ? { canRetry: false, reason: "post-model-phase" }
                : this.providerExecutedToolAttemptLatched
                  ? { canRetry: false, reason: "provider-executed-tool" }
                  : lastMessage?.role === "assistant" || this.state.pendingToolCalls.size > 0
                    ? { canRetry: false, reason: "invalid-transcript-boundary" }
                    : { canRetry: true };
              let decision: TurnErrorHandlerDecision | undefined;
              try {
                decision = await this.turnErrorHandler(err, {
                  abortSignal: this.abortController?.signal,
                  retrySafety,
                  phase: turnErrorPhase,
                });
              } catch (handlerError) {
                if (
                  !this.cancelResetPending &&
                  !this.pendingInterrupt &&
                  !this.abortController?.signal.aborted
                ) {
                  throw handlerError;
                }
              }
              if (this.cancelResetPending) {
                this.emit({
                  type: "turn_abort",
                  reason: "cancel",
                  phase: this.state.pendingToolCalls.size > 0 ? "tools" : "model",
                });
                this.finishCancellation();
                break;
              }
              if (this.pendingInterrupt || this.abortController?.signal.aborted) {
                continue;
              }
              if (decision === "retry" && retrySafety.canRetry) {
                const hadPartialOutput = this.state.streamMessage !== null;
                this.state.streamMessage = null;
                this.emit({
                  type: "turn_retry",
                  hadPartialOutput,
                  abandonedToolCallIds: [...localToolDraftIds],
                });
                continue;
              }
            }

            throw err;
          }
        }

        this.emit({
          type: "agent_end",
          messages: this.getRecoverableMessages().map(cloneMessage),
          totalUsage: runTotalUsage,
        });
      } catch (err) {
        this.state.error = err instanceof Error ? err.message : String(err);
        this.emit({
          type: "agent_end",
          messages: this.getRecoverableMessages().map(cloneMessage),
          totalUsage: runTotalUsage,
        });
        throw err;
      } finally {
        const awaitedInterrupt = this.awaitedSteeringInterrupt;
        if (awaitedInterrupt) {
          this.settleAwaitedSteeringInterrupt(awaitedInterrupt, { status: "inactive" });
        }
        this.state.isStreaming = false;
        this.state.streamMessage = null;
        this.state.pendingToolCalls = new Set();
        this.abortController = undefined;
        this.abortRequestedReason = null;
        this.pendingInterrupt = null;
        this.alreadyNormalizedExternalToolCallIds.clear();
        if (this.cancelResetPending) {
          this.steeringQueue.length = 0;
          this.steeringDeliveryPreparation = undefined;
          this.deliveredSteeringMessages.length = 0;
          this.followUpQueue.length = 0;
        }
        this.cancelResetPending = false;
      }
    })();

    await this.running;
  }

  private async runTurn(params: {
    onErrorPhase: (phase: TurnErrorPhase) => void;
    onProviderExecutedTool: () => void;
    onLocalToolDraft: (toolCallId: string) => void;
  }): Promise<{
    finishReason: FinishReason;
    newMessages: ModelMessage[];
    toolCalls: Array<{
      toolCallId: string;
      toolName: string;
      input: unknown;
      invalid?: boolean;
      error?: unknown;
    }>;
    usage: LanguageModelUsage;
    totalUsage: LanguageModelUsage;
    modelInputMessages: ModelMessage[];
    toolSnapshot: StepToolSnapshot<TOOLS>;
  }> {
    // Ordinary runtimes retain per-call retry semantics. Persistent runtimes
    // keep the latch until model-call preparation installs a distinct attempt.
    if (this.activePersistentAttemptIdentity === undefined) {
      this.providerExecutedToolAttemptLatched = false;
    }
    params.onErrorPhase("before-step");
    this.emit({ type: "turn_start" });

    const turnIndex = ++this.turnCounter;

    if (this.beforeStep) {
      const preStepSignal = this.abortController?.signal;
      if (preStepSignal?.aborted) {
        throw new TurnAbortedError({
          reason: this.abortRequestedReason ?? (this.pendingInterrupt ? "interrupt" : "manual"),
          phase: "model",
        });
      }
      await this.beforeStep({
        step: turnIndex,
        ...(preStepSignal ? { abortSignal: preStepSignal } : {}),
      });
      if (preStepSignal?.aborted) {
        throw new TurnAbortedError({
          reason: this.abortRequestedReason ?? (this.pendingInterrupt ? "interrupt" : "manual"),
          phase: "model",
        });
      }
    }

    const toolSnapshot = this.createStepToolSnapshot(turnIndex);
    this.lastStepToolSnapshot = toolSnapshot;
    const allModelTools = stripToolExecuteForModel(toolSnapshot.tools);

    const getAbortReason = (): TurnAbortReason =>
      this.abortRequestedReason ?? (this.pendingInterrupt ? "interrupt" : "manual");

    const abortSignal = this.abortController?.signal;

    params.onErrorPhase("transform-messages");
    const throwIfPreparationAborted = () => {
      if (!abortSignal?.aborted) return;
      throw new TurnAbortedError({ reason: getAbortReason(), phase: "model" });
    };
    const contextForMode = (executionMode: ModelCallExecutionMode): TransformMessagesContext => ({
      system: this.state.system,
      tools: executionMode === "local-tools" ? allModelTools : {},
      abortSignal,
    });
    const initialRuntime: ModelCallRuntime = {
      model: this.state.model,
      modelSpecifier: this.state.modelSpecifier,
      executionMode: this.sendToolsToModel ? "local-tools" : "provider-tools",
      streamTextMaxRetries: this.streamTextMaxRetries,
    };
    let canonicalMessages: ModelMessage[] = [];
    let preparedCanonical: ModelMessage[] = [];
    let preparationContext = contextForMode(initialRuntime.executionMode);
    throwIfPreparationAborted();
    canonicalMessages = normalizeReplayMessages(this.state.messages.map(cloneMessage));
    await this.canonicalModelCallPreflight?.(canonicalMessages, preparationContext);
    canonicalMessages = normalizeReplayMessages(this.state.messages.map(cloneMessage));
    preparedCanonical = this.prepareFullBudgetView
      ? await this.prepareFullBudgetView(canonicalMessages, {
          ...preparationContext,
          canonicalStartIndex: 0,
        })
      : this.prepareFullModelView
        ? await this.prepareFullModelView(canonicalMessages, preparationContext)
        : canonicalMessages;
    preparedCanonical = normalizeReplayMessages(preparedCanonical);
    throwIfPreparationAborted();

    const budgetOverlay = this.buildEphemeralOverlay
      ? await this.buildEphemeralOverlay(preparationContext)
      : [];
    const fullBudgetView = normalizeReplayMessages([...preparedCanonical, ...budgetOverlay]);
    const defaultPreparation: PreparedModelCall = {
      runtime: initialRuntime,
      payload: { mode: "full" },
    };
    const callPreparation = this.prepareModelCall
      ? await this.prepareModelCall({
          canonicalMessages,
          fullBudgetView,
          runtime: defaultPreparation.runtime,
          payload: defaultPreparation.payload,
          transformContext: preparationContext,
        })
      : defaultPreparation;
    throwIfPreparationAborted();

    const suffixStart =
      callPreparation.payload.mode === "full" ? 0 : callPreparation.payload.startIndex;
    if (
      !Number.isInteger(suffixStart) ||
      suffixStart < 0 ||
      suffixStart > canonicalMessages.length
    ) {
      throw new Error(`prepareModelCall selected invalid canonical suffix index ${suffixStart}`);
    }
    const persistentAttemptIdentity = callPreparation.runtime.persistentAttemptIdentity;
    if (
      persistentAttemptIdentity === undefined ||
      persistentAttemptIdentity !== this.activePersistentAttemptIdentity
    ) {
      this.providerExecutedToolAttemptLatched = false;
    }
    this.activePersistentAttemptIdentity = persistentAttemptIdentity;
    preparationContext = contextForMode(callPreparation.runtime.executionMode);
    const selectedCanonical = canonicalMessages.slice(suffixStart);
    let messagesForModel = this.prepareFullModelView
      ? await this.prepareFullModelView(selectedCanonical, preparationContext)
      : selectedCanonical;
    messagesForModel = normalizeReplayMessages(messagesForModel);
    if (messagesForModel.at(-1)?.role === "assistant") {
      throw new Error("Cannot append an ephemeral overlay after an assistant message");
    }
    const payloadOverlay = this.buildEphemeralOverlay
      ? await this.buildEphemeralOverlay(preparationContext)
      : [];
    messagesForModel = normalizeReplayMessages([...messagesForModel, ...payloadOverlay]);
    if (this.decorateRequestPayload) {
      messagesForModel = normalizeReplayMessages(
        await this.decorateRequestPayload(messagesForModel, preparationContext),
      );
    }
    throwIfPreparationAborted();

    messagesForModel = normalizeModelMessagesToolCallIds({
      messages: messagesForModel,
      modelSpecifier: callPreparation.runtime.modelSpecifier,
    });

    if (this.captureModelViewMessages) {
      const cloned = messagesForModel.map(cloneMessage);
      this.state.debug ??= {};
      this.state.debug.lastModelViewMessages = cloned;
      this.state.debug.lastModelViewTurn = turnIndex;
      this.state.debug.lastModelViewCapturedAt = Date.now();
    }

    const lastMessage =
      messagesForModel.length > 0 ? messagesForModel[messagesForModel.length - 1] : undefined;
    if (lastMessage?.role === "assistant") {
      throw new Error(
        "Request preparation produced an invalid outbound context: last message is assistant.",
      );
    }

    params.onErrorPhase("model-call");
    const streamTextMaxRetries =
      callPreparation.runtime.streamTextMaxRetries ?? this.streamTextMaxRetries;
    const result = streamText({
      model: callPreparation.runtime.model,
      instructions: this.state.system,
      messages: messagesForModel,
      ...(callPreparation.runtime.executionMode === "local-tools" ? { tools: allModelTools } : {}),
      reasoning: this.state.reasoning,
      providerOptions: this.state.providerOptions,
      experimental_download: this.experimentalDownload,
      ...(streamTextMaxRetries === undefined ? {} : { maxRetries: streamTextMaxRetries }),
      abortSignal,
      onError: () => {},
    });

    let assistantStarted = false;
    let partialAssistant: Omit<AssistantModelMessage, "content"> & {
      content: Exclude<AssistantContent, string>;
    } = {
      role: "assistant",
      content: [],
    };
    // Tool calls observed in `stream` may still have raw/unvalidated JSON.
    // They are useful for UI events, but we must execute tools only from the
    // finalized `response.messages` (post-parse + schema validation).

    let aborted = false;

    for await (const part of result.stream) {
      if (part.type === "abort") {
        aborted = true;
        break;
      }
      if (this.abortController?.signal.aborted) {
        aborted = true;
        break;
      }
      if (part.type === "start-step") {
        continue;
      }

      if (
        !assistantStarted &&
        (part.type === "text-start" ||
          part.type === "text-delta" ||
          part.type === "reasoning-start" ||
          part.type === "reasoning-delta" ||
          part.type === "tool-input-start" ||
          part.type === "tool-input-delta" ||
          part.type === "tool-call" ||
          part.type === "custom" ||
          part.type === "source" ||
          part.type === "file" ||
          part.type === "reasoning-file")
      ) {
        assistantStarted = true;
        this.state.streamMessage = partialAssistant;
        this.emit({
          type: "message_start",
          message: cloneMessage(partialAssistant),
        });
      }

      switch (part.type) {
        case "text-start": {
          // Some providers omit the preceding block's explicit end event. A new
          // block still makes the accumulated prefix a completed boundary.
          this.checkpointRecoveryDraft(partialAssistant);
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: {
              type: "text_start",
              id: part.id,
              raw: part,
            },
          });
          break;
        }
        case "text-delta": {
          if (partialAssistant.content.at(-1)?.type === "reasoning") {
            this.checkpointRecoveryDraft(partialAssistant);
          }
          upsertTextPart(partialAssistant.content, "text", part.text);
          this.state.streamMessage = partialAssistant;
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: {
              type: "text_delta",
              id: part.id,
              delta: part.text,
              raw: part,
            },
          });
          break;
        }
        case "text-end": {
          if (this.abortController?.signal.aborted) break;
          this.checkpointRecoveryDraft(partialAssistant);
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: {
              type: "text_end",
              id: part.id,
              raw: part,
            },
          });
          break;
        }
        case "reasoning-start": {
          this.checkpointRecoveryDraft(partialAssistant);
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: {
              type: "thinking_start",
              id: part.id,
              raw: part,
            },
          });
          break;
        }
        case "reasoning-delta": {
          if (partialAssistant.content.at(-1)?.type === "text") {
            this.checkpointRecoveryDraft(partialAssistant);
          }
          upsertTextPart(partialAssistant.content, "reasoning", part.text);
          this.state.streamMessage = partialAssistant;
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: {
              type: "thinking_delta",
              id: part.id,
              delta: part.text,
              raw: part,
            },
          });
          break;
        }
        case "reasoning-end": {
          if (this.abortController?.signal.aborted) break;
          this.checkpointRecoveryDraft(partialAssistant);
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: {
              type: "thinking_end",
              id: part.id,
              raw: part,
            },
          });
          break;
        }
        case "tool-input-start": {
          this.checkpointRecoveryDraft(partialAssistant);
          if (part.providerExecuted === true) {
            params.onProviderExecutedTool();
          } else {
            params.onLocalToolDraft(part.id);
          }
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: {
              type: "toolcall_start",
              toolCallId: part.id,
              toolName: part.toolName,
              raw: part,
            },
          });
          break;
        }
        case "tool-input-delta": {
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: {
              type: "toolcall_delta",
              toolCallId: part.id,
              delta: part.delta,
              raw: part,
            },
          });
          break;
        }
        case "tool-input-end": {
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: {
              type: "toolcall_end",
              toolCallId: part.id,
              raw: part,
            },
          });
          break;
        }
        case "custom": {
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: { type: "custom", raw: part },
          });
          break;
        }
        case "source": {
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: { type: "source", raw: part },
          });
          break;
        }
        case "file": {
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: { type: "file", raw: part },
          });
          break;
        }
        case "reasoning-file": {
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: { type: "reasoning_file", raw: part },
          });
          break;
        }
        case "tool-call": {
          if (this.abortController?.signal.aborted) break;
          this.checkpointRecoveryDraft(partialAssistant);
          const { toolCallId, toolName, input } = part;
          if (part.providerExecuted === true) {
            params.onProviderExecutedTool();
          } else {
            params.onLocalToolDraft(toolCallId);
          }
          partialAssistant.content.push({
            type: "tool-call",
            toolCallId,
            toolName,
            input: normalizeToolCallInputValue(input),
            providerExecuted: part.providerExecuted,
          });
          this.state.streamMessage = partialAssistant;
          break;
        }
        case "tool-result": {
          if (this.abortController?.signal.aborted) break;
          if (part.providerExecuted === true) {
            params.onProviderExecutedTool();
            partialAssistant.content.push({
              type: "tool-result",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: recoveryToolOutput(part.output),
            });
            this.state.streamMessage = partialAssistant;
            this.checkpointRecoveryDraft(partialAssistant);
          }
          break;
        }
        case "tool-error": {
          if (this.abortController?.signal.aborted) break;
          if (part.providerExecuted === true) {
            params.onProviderExecutedTool();
            partialAssistant.content.push({
              type: "tool-result",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: { type: "error-text", value: String(part.error) },
            });
            this.state.streamMessage = partialAssistant;
            this.checkpointRecoveryDraft(partialAssistant);
          }
          break;
        }
        case "tool-output-denied": {
          if (this.abortController?.signal.aborted) break;
          if (part.providerExecuted === true) {
            params.onProviderExecutedTool();
            partialAssistant.content.push({
              type: "tool-result",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: { type: "execution-denied", reason: "Tool output was denied." },
            });
            this.state.streamMessage = partialAssistant;
            this.checkpointRecoveryDraft(partialAssistant);
          }
          break;
        }
        case "tool-approval-response": {
          if (part.providerExecuted === true) {
            params.onProviderExecutedTool();
          }
          break;
        }
        case "tool-approval-request": {
          if (part.toolCall.providerExecuted === true) {
            params.onProviderExecutedTool();
          }
          break;
        }
        case "error": {
          throw part.error;
        }
        default:
          break;
      }
    }

    if (aborted) {
      if (assistantStarted) {
        this.emit({
          type: "message_end",
          message: cloneMessage(partialAssistant),
        });
      }
      this.state.streamMessage = null;

      const reason: TurnAbortReason =
        this.abortRequestedReason ?? (this.pendingInterrupt ? "interrupt" : "manual");

      throw new TurnAbortedError({ reason, phase: "model" });
    }

    let response: Awaited<typeof result.response>;
    let finishReason: FinishReason;
    let usage: LanguageModelUsage;
    let totalUsage: LanguageModelUsage;
    let warnings: CallWarning[] | undefined;
    try {
      response = await result.response;
      finishReason = await result.finishReason;
      usage = await result.usage;
      totalUsage = await result.totalUsage;
      warnings = await result.warnings;
    } catch (e) {
      if (this.abortController?.signal.aborted) {
        if (assistantStarted) {
          this.emit({
            type: "message_end",
            message: cloneMessage(partialAssistant),
          });
        }
        this.state.streamMessage = null;

        const reason: TurnAbortReason =
          this.abortRequestedReason ?? (this.pendingInterrupt ? "interrupt" : "manual");

        throw new TurnAbortedError({ reason, phase: "model" });
      }
      throw e;
    }
    params.onErrorPhase("post-model");

    if (warnings && warnings.length > 0) {
      this.emit({
        type: "turn_warnings",
        warnings,
      });
    }

    const newMessages: ModelMessage[] = [];
    for (const message of normalizeReplayMessages(response.messages)) {
      if (message.role === "tool") {
        newMessages.push(await this.normalizeNewToolMessage(message));
      } else if (message.role === "assistant") {
        newMessages.push(await this.normalizeNewAssistantMessage(message));
      } else {
        newMessages.push(message);
      }
    }
    this.alreadyNormalizedExternalToolCallIds.clear();
    const toolCalls = extractToolCallsFromMessages(newMessages);

    // Emit message_end for assistant message (first assistant in response.messages)
    const assistantMessage = newMessages.find((m) => m.role === "assistant");
    if (assistantStarted) {
      if (assistantMessage) {
        this.emit({
          type: "message_end",
          message: cloneMessage(assistantMessage),
        });
      } else {
        this.emit({
          type: "message_end",
          message: cloneMessage(partialAssistant),
        });
      }
    }
    this.state.streamMessage = null;

    // If provider-executed tools produced tool messages, emit them too.
    for (const m of newMessages) {
      if (m.role === "tool") {
        this.emit({ type: "message_start", message: cloneMessage(m) });
        this.emit({ type: "message_end", message: cloneMessage(m) });
      }
    }

    return {
      finishReason,
      newMessages,
      toolCalls,
      usage,
      totalUsage,
      modelInputMessages: messagesForModel.map(cloneMessage),
      toolSnapshot,
    };
  }

  private async applyTurnBoundary(input: {
    finishReason: FinishReason;
    modelInputMessages: readonly ModelMessage[];
    executedToolCallCount: number;
  }): Promise<{ requiresNextTurn: boolean }> {
    if (!this.turnBoundaryHandler) return { requiresNextTurn: false };

    const getAbortReason = (): TurnAbortReason =>
      this.abortRequestedReason ?? (this.pendingInterrupt ? "interrupt" : "manual");
    const assertNotAborted = () => {
      if (this.abortController?.signal.aborted) {
        throw new TurnAbortedError({ reason: getAbortReason(), phase: "tools" });
      }
    };

    assertNotAborted();
    const decision = await this.turnBoundaryHandler({
      finishReason: input.finishReason,
      modelInputMessages: input.modelInputMessages.map(cloneMessage),
      executedToolCallCount: input.executedToolCallCount,
      abortSignal: this.abortController?.signal,
    });
    assertNotAborted();

    const appended: ModelMessage[] = [];
    for (const message of decision.append ?? []) {
      appended.push(
        message.role === "tool" ? await this.normalizeNewToolMessage(message) : message,
      );
    }
    assertNotAborted();
    for (const message of appended) this.appendMessage(message);
    return {
      requiresNextTurn: appended.length > 0 || decision.forceNextTurn === true,
    };
  }

  private async executeExpansionChildren(
    toolCalls: ExpandedToolCall[],
    snapshot: StepToolSnapshot<TOOLS>,
    options: { abortSignal?: AbortSignal; appendToTranscript: boolean },
  ): Promise<AtomicToolExecutionOutcome[]> {
    const MAX_PARALLEL_TOOLS = 8;
    const hasExclusiveTool = toolCalls.some((call) => this.exclusiveToolNames.has(call.toolName));
    const getAbortReason = (): TurnAbortReason =>
      this.abortRequestedReason ?? (this.pendingInterrupt ? "interrupt" : "manual");
    const isAborted = (): boolean => options.abortSignal?.aborted === true;
    const assertNotAborted = () => {
      if (!isAborted()) return;
      if (this.abortController?.signal.aborted) {
        throw new TurnAbortedError({ reason: getAbortReason(), phase: "tools" });
      }
      options.abortSignal?.throwIfAborted();
    };

    const atomicOptions = toolCalls.map(
      (call): ExecuteAtomicToolCallOptions => ({
        call,
        tools: snapshot.tools,
        messages: this.state.messages,
        context: this.context,
        abortSignal: options.abortSignal,
        pendingToolCalls: this.state.pendingToolCalls,
        inputValidation: call.invalid
          ? { type: "invalid", error: call.error }
          : { type: "prevalidated" },
        expansionHandling: {
          type: "reject",
          message: "Nested tool-call expansions are not supported.",
        },
        bypassGenericOutputNormalizer: this.genericOutputNormalizerBypassTools.has(call.toolName),
        aggregateOutputBudgetExempt: this.aggregateOutputBudgetExemptTools.has(call.toolName),
        executionRejection:
          snapshot.tools[call.toolName] === undefined && this.state.tools[call.toolName]
            ? hiddenToolRejection(call.toolName)
            : hasExclusiveTool && !this.exclusiveToolNames.has(call.toolName)
              ? `Tool '${call.toolName}' was not executed because an exclusive tool was selected in the same turn. Retry it after processing the exclusive tool result.`
              : undefined,
        assertNotAborted,
        onEvent: (event) => this.emit(event),
      }),
    );

    const settled: Array<AtomicToolExecutionOutcome | undefined> = Array.from({
      length: toolCalls.length,
    });
    let executionError: { error: unknown } | undefined;
    let next = 0;
    const workers = Array.from({ length: Math.min(MAX_PARALLEL_TOOLS, toolCalls.length) }, () =>
      (async () => {
        while (true) {
          if (isAborted()) return;
          const index = next;
          if (index >= toolCalls.length) return;
          next += 1;
          try {
            settled[index] = await settleAtomicToolCall(atomicOptions[index]!);
          } catch (error) {
            executionError ??= { error };
            if (isAborted()) return;
          }
        }
      })(),
    );
    await Promise.all(workers);

    const entryFor = (index: number): SettledToolResultOutputEntry => {
      const child = settled[index];
      if (!child) throw new Error(`Missing settled output at index ${index}`);
      const callOptions = atomicOptions[index]!;
      return {
        output: child.toolOutput,
        context: {
          toolCallId: callOptions.call.toolCallId,
          toolName: callOptions.call.toolName,
          ...(callOptions.bypassGenericOutputNormalizer === undefined
            ? {}
            : {
                bypassGenericOutputNormalizer: callOptions.bypassGenericOutputNormalizer,
              }),
          ...(callOptions.aggregateOutputBudgetExempt === undefined
            ? {}
            : {
                aggregateOutputBudgetExempt: callOptions.aggregateOutputBudgetExempt,
              }),
        },
      };
    };

    const normalizeEntries = async (
      entries: readonly SettledToolResultOutputEntry[],
    ): Promise<ToolResultOutput[]> => {
      if (!this.normalizeSettledToolResultOutputs) {
        return await Promise.all(
          entries.map((entry) => this.normalizeToolOutput(entry.output, entry.context)),
        );
      }
      try {
        const outputs = await this.normalizeSettledToolResultOutputs(entries, (output, context) =>
          this.normalizeToolOutput(output, context),
        );
        if (outputs.length !== entries.length) {
          throw new Error(
            `Expansion output normalizer returned ${outputs.length} outputs for ${entries.length} children.`,
          );
        }
        return outputs;
      } catch (error) {
        logger.warn("settled expansion output normalization failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return entries.map(() => ({
          type: "error-text" as const,
          value: SETTLED_NORMALIZATION_FAILED,
        }));
      }
    };

    const checkpointCompleted = (
      completed: readonly (AtomicToolExecutionOutcome | undefined)[],
    ): void => {
      if (!options.appendToTranscript) return;
      const baseLength = truncateToLastValidBoundary(this.state.messages).messages.length;
      const assistant = this.state.messages[baseLength];
      if (assistant?.role !== "assistant") return;
      const candidate = this.state.messages.slice(0, baseLength + 1).map(cloneMessage);
      for (let index = 0; index < completed.length; index += 1) {
        const outcome = completed[index];
        if (!outcome) continue;
        const call = toolCalls[index]!;
        candidate.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: outcome.toolOutput,
            },
          ],
        });
      }
      this.recoveryCheckpoint = recoveryCheckpointForMessages(candidate);
    };

    const finalizeCompleted = async (): Promise<void> => {
      const completed: Array<AtomicToolExecutionOutcome | undefined> = Array.from({
        length: settled.length,
      });
      const completedIndexes = settled.flatMap((child, index) => (child ? [index] : []));
      const outputs = await normalizeEntries(completedIndexes.map(entryFor));
      for (let offset = 0; offset < completedIndexes.length; offset += 1) {
        const index = completedIndexes[offset]!;
        completed[index] = finalizeSettledAtomicToolCall(
          atomicOptions[index]!,
          settled[index]!,
          outputs[offset]!,
        );
      }
      checkpointCompleted(completed);
    };

    if (isAborted() || executionError) {
      await finalizeCompleted();
      if (executionError) throw executionError.error;
      assertNotAborted();
    }

    if (settled.some((outcome) => outcome === undefined)) {
      await finalizeCompleted();
      const missingIndex = settled.findIndex((outcome) => outcome === undefined);
      throw new Error(
        `Missing tool execution outcome for toolCallId=${toolCalls[missingIndex]!.toolCallId}`,
      );
    }

    const entries = settled.map((_child, index) => entryFor(index));
    const normalizedOutputs = await normalizeEntries(entries);

    const outcomes: AtomicToolExecutionOutcome[] = [];
    for (let index = 0; index < settled.length; index += 1) {
      outcomes.push(
        finalizeSettledAtomicToolCall(
          atomicOptions[index]!,
          settled[index]!,
          normalizedOutputs[index]!,
        ),
      );
    }

    checkpointCompleted(outcomes);
    if (isAborted()) assertNotAborted();

    if (options.appendToTranscript) {
      for (let index = 0; index < outcomes.length; index += 1) {
        const call = toolCalls[index]!;
        const toolMessage: ModelMessage = {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: outcomes[index]!.toolOutput,
            },
          ],
        };
        this.appendMessage(toolMessage);
        this.checkpointCurrentToolExchange();
      }
    }

    return outcomes;
  }

  private async executeToolCalls(
    toolCalls: ExpandedToolCall[],
    snapshot: StepToolSnapshot<TOOLS>,
  ): Promise<number> {
    const MAX_PARALLEL_TOOLS = 8;
    const hasExclusiveTool = toolCalls.some((call) => this.exclusiveToolNames.has(call.toolName));

    const getAbortReason = (): TurnAbortReason =>
      this.abortRequestedReason ?? (this.pendingInterrupt ? "interrupt" : "manual");

    const isAborted = (): boolean => this.abortController?.signal.aborted === true;
    const assertNotAborted = () => {
      if (isAborted()) {
        throw new TurnAbortedError({ reason: getAbortReason(), phase: "tools" });
      }
    };

    const executeOne = (call: ExpandedToolCall): Promise<AtomicToolExecutionOutcome> =>
      executeAtomicToolCall({
        call,
        tools: snapshot.tools,
        messages: this.state.messages,
        context: this.context,
        abortSignal: this.abortController?.signal,
        pendingToolCalls: this.state.pendingToolCalls,
        inputValidation: call.invalid
          ? { type: "invalid", error: call.error }
          : { type: "prevalidated" },
        expansionHandling: { type: "capture" },
        normalizeToolResultOutput: this.normalizeToolResultOutput,
        bypassGenericOutputNormalizer: this.genericOutputNormalizerBypassTools.has(call.toolName),
        aggregateOutputBudgetExempt: this.aggregateOutputBudgetExemptTools.has(call.toolName),
        executionRejection:
          snapshot.tools[call.toolName] === undefined && this.state.tools[call.toolName]
            ? hiddenToolRejection(call.toolName)
            : hasExclusiveTool && !this.exclusiveToolNames.has(call.toolName)
              ? `Tool '${call.toolName}' was not executed because an exclusive tool was selected in the same turn. Retry it after processing the exclusive tool result.`
              : undefined,
        assertNotAborted,
        onEvent: (event) => this.emit(event),
      });

    const outcomes: Array<AtomicToolExecutionOutcome | undefined> = Array.from({
      length: toolCalls.length,
    });
    let nextAppendIndex = 0;

    const checkpointCompletedOutcomes = () => {
      const baseLength = truncateToLastValidBoundary(this.state.messages).messages.length;
      const assistant = this.state.messages[baseLength];
      if (assistant?.role !== "assistant") return;
      const candidate = this.state.messages.slice(0, baseLength + 1).map(cloneMessage);
      for (let index = 0; index < toolCalls.length; index += 1) {
        const outcome = outcomes[index];
        if (outcome === undefined) continue;
        const call = toolCalls[index]!;
        candidate.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: outcome.toolOutput,
            },
          ],
        });
      }
      this.recoveryCheckpoint = recoveryCheckpointForMessages(candidate);
    };

    const appendReadyOutcomes = () => {
      while (nextAppendIndex < toolCalls.length) {
        const call = toolCalls[nextAppendIndex]!;
        const outcome = outcomes[nextAppendIndex];
        if (!outcome) break;

        const toolMessage: ModelMessage = {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: outcome.toolOutput,
            },
          ],
        };

        this.state.messages.push(toolMessage);
        this.emit({ type: "message_start", message: cloneMessage(toolMessage) });
        this.emit({ type: "message_end", message: cloneMessage(toolMessage) });
        this.checkpointCurrentToolExchange();

        nextAppendIndex += 1;
      }
    };

    let stoppedDueToAbort = false;
    let next = 0;
    const workers = Array.from({ length: Math.min(MAX_PARALLEL_TOOLS, toolCalls.length) }, () =>
      (async () => {
        while (true) {
          if (isAborted()) return;
          const index = next;
          if (index >= toolCalls.length) return;
          next += 1;

          outcomes[index] = await executeOne(toolCalls[index]!);
          checkpointCompletedOutcomes();
          appendReadyOutcomes();
        }
      })(),
    );
    await Promise.all(workers);
    if (isAborted()) stoppedDueToAbort = true;

    if (!stoppedDueToAbort && nextAppendIndex !== toolCalls.length) {
      const missing = toolCalls[nextAppendIndex]!;
      throw new Error(`Missing tool execution outcome for toolCallId=${missing.toolCallId}`);
    }

    if (isAborted()) {
      throw new TurnAbortedError({ reason: getAbortReason(), phase: "tools" });
    }

    let executed = toolCalls.length;
    for (const outcome of outcomes) {
      const expansion = outcome?.expansion;
      if (!expansion || expansion.children.length === 0) continue;

      const syntheticAssistant: AssistantModelMessage = {
        role: "assistant",
        content: expansion.children.map((child) => ({
          type: "tool-call" as const,
          toolCallId: child.toolCallId,
          toolName: child.toolName,
          input: normalizeToolCallInputValue(child.input),
        })),
      };
      this.appendMessage(syntheticAssistant);
      const childOutcomes = await this.executeExpansionChildren([...expansion.children], snapshot, {
        abortSignal: this.abortController?.signal,
        appendToTranscript: true,
      });
      executed += childOutcomes.length;
    }

    return executed;
  }
}

function hasOwnKey<T extends object, K extends PropertyKey>(
  obj: T,
  key: K,
): obj is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function extractToolCallsFromMessages(messages: readonly ModelMessage[]): Array<{
  toolCallId: string;
  toolName: string;
  input: unknown;
  invalid?: boolean;
  error?: unknown;
}> {
  const satisfiedToolCallIds = new Set<string>();
  for (const message of messages) {
    for (const toolCallId of getToolResultToolCallIds(message)) {
      satisfiedToolCallIds.add(toolCallId);
    }
  }

  const toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: unknown;
    invalid?: boolean;
    error?: unknown;
  }> = [];

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") continue;

    for (const part of content) {
      // Ignore tool approval request prompts and other parts.
      if (part.type !== "tool-call") continue;

      // If this batch of messages already contains a tool result for the same
      // toolCallId, do not execute it again locally.
      if (satisfiedToolCallIds.has(part.toolCallId)) continue;

      // Provider-executed tools should produce tool messages without local execution.
      if (part.providerExecuted === true) continue;

      const invalid = hasOwnKey(part, "invalid") && part.invalid === true;
      const error = hasOwnKey(part, "error") ? part.error : undefined;

      toolCalls.push({
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: normalizeToolCallInputValue(part.input),
        ...(invalid ? { invalid: true } : {}),
        ...(error !== undefined ? { error } : {}),
      });
    }
  }

  return toolCalls;
}

// Optional smoke demo (requires you to provide a model instance).
// Run with: `bun ai-sdk-pi-agent.ts` or `node --loader tsx ai-sdk-pi-agent.ts`
if (import.meta.main) {
  // Intentionally silent when run directly.
}
