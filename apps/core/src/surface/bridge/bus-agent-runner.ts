/* oxlint-disable eslint/no-control-regex */

import {
  type CallWarning,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolContent,
  type ToolSet,
  type UserContent,
} from "ai";
import {
  Result,
  TaggedError,
  type AnyTaggedError,
  type Panic,
  type Result as ResultType,
} from "better-result";
import { boundToolResultMediaForModelView } from "@stanley2058/lilac-tool-results/tool-result-media";
import type {
  ConfiguredModelChainEntry,
  CoreConfig,
  CustomCommandResult,
  DurableResolvedModelRequest,
  ModelCapabilityInfo,
  ModelResolutionFailed,
  ModelReasoningEffort,
  ResolvedModelPlan,
  ResolvedModelRef,
} from "@stanley2058/lilac-utils";
import {
  CUSTOM_COMMAND_TOOL_NAME,
  discoverSkills,
  deriveSubagentIdleTimeoutMs,
  env,
  extractAiErrorLogDetails,
  findWorkspaceRootResult,
  formatAvailableSkillsSection,
  getCoreConfig,
  isPanic,
  isRecord,
  opaqueErrorMessage,
  ModelCapability,
  openAIMessagePhase,
  resolveCoreConfigPath,
  createLogger,
  resolveEditingToolMode,
  fromDurableResolvedModelPlanResult,
  claudeCodeExecutableSettings,
  resolveModelChainResult,
  resolveModelPlanResult,
  resolveNativeSubagentProfile,
  withModelPlanReasoning,
} from "@stanley2058/lilac-utils";
import {
  corePrimaryLineageV1Schema,
  createCorePrimaryLineageFreshOnlyV1,
  decodeCorePrimaryLineageV1,
  EventDeliveryStopped,
  extendCoreLineagePrefixDigestV1,
  lilacEventTypes,
  type AdapterPlatform,
  type CoreLineageManifestV1,
  type CorePrimaryLineageV1,
  type DecodedLilacMessageForTopic,
  type DeliveryDisposition,
  type LilacBus,
  type RequestLifecycleState,
  type RequestOrigin,
  type RequestQueueMode,
  type RequestRunPolicy,
} from "@stanley2058/lilac-event-bus";
import {
  advanceHistoryProviderState,
  AgentIdleTimeoutError,
  AiSdkPiAgent,
  attachAutoCompaction,
  buildSafeRecoveryCheckpoint,
  buildSyntheticToolCallId,
  classifyHistoryProviderFamily,
  compactWithOpenAIResponsesResult,
  createAgentRunIdleWatchdog,
  createRetryBackoffBudget,
  hasMatchingOpenAIServerCompaction,
  hasOpenAIServerCompaction,
  hashCanonicalMessagesV1,
  materializeOpenAIServerCompaction,
  type AiSdkPiAgentOptions,
  type AiSdkPiAgentEvent,
  type HistoryProviderState,
  type RetryBackoffAborted,
  type RetryBackoffAttempt,
  type RetryBackoffDelayFailed,
  type TransformMessagesContext,
  type PrepareFullModelView,
} from "@stanley2058/lilac-agent";

import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { BuiltLevel1Toolset, CoreToolPluginManager } from "../../plugins";
import type { ToolResultArtifactStore } from "../../artifacts/tool-result-artifact-store";
import { createAgentOutputActivityPublisher } from "../../shared/agent-output-activity";
import {
  createToolResultOutputNormalizer,
  normalizeSubagentFinalText,
} from "../../artifacts/tool-result-output-normalizer";
import type {
  SubagentDelegationRegistration,
  TrustedSubagentDelegationRegistration,
} from "../../tools/subagent";
import type {
  WorkflowLiveParentBridge,
  WorkflowLiveParentCompletion,
} from "../../workflow/workflow-live-parent-bridge";
import type { WorkflowSubagentDispatcher } from "../../workflow/workflow-subagent-dispatcher";
import type { DurableWorkflowStore } from "../../workflow/durable-workflow-store";
import type { WorkflowUsage } from "../../workflow/workflow-domain";
import type { WorkflowRequestPolicy } from "../../workflow/workflow-request-authority";
import {
  createRequestMessageCache,
  type RequestIdentityAliasTargetOccupied,
  type RequestIdentitySourceMissing,
  type RequestMessageCache,
  type RequestMessageCacheAdmissionError,
  type RequestMessageCacheOwner,
} from "../../tool-server/request-message-cache";
import {
  AuthenticatedRequestProjectionInvalid,
  isAuthenticatedRequestProjectionSemanticallyValid,
  projectAuthenticatedRequest,
  type AuthenticatedRequestProjection,
} from "../authenticated-request";
import {
  getBuiltinSurfaceProtocol,
  resolveAuthenticatedRequestSafetyMode,
} from "../builtin-surface-protocols";
import { formatToolArgsForDisplayWithSpecs } from "../../tools/tool-args-display";
import { isHeartbeatAckText, isHeartbeatSessionId } from "../../heartbeat/common";

import {
  buildHeartbeatHandoffTranscript,
  extractHeartbeatSurfaceSendHandoffs,
  HEARTBEAT_HANDOFF_SESSION_ID,
} from "../../transcript/heartbeat-handoff";
import {
  COMPACTION_CHECKPOINT_FORMAT_VERSION,
  type TranscriptSnapshot,
  type TranscriptStore,
} from "../../transcript/transcript-store";
import type {
  ConversationThreadSearchResult,
  ConversationThreadToolService,
} from "../../conversation/thread-service";
import { isPossibleNoReplyPrefix, resolveReplyDeliveryFromFinalText } from "./reply-directive";
import { formatBridgeLogContext, formatBridgeTaggedErrorForLog } from "./bridge-log";
import { buildSystemPromptForProfile } from "./bus-agent-runner/subagent-prompt";
import {
  formatToolLogPreview,
  summarizeToolFailure,
} from "./bus-agent-runner/tool-failure-logging";
import {
  buildExperimentalDownloadForAnthropicFallback,
  isAnthropicModelSpec,
  withStableAnthropicUpstreamOrder,
} from "./bus-agent-runner/anthropic-fallback-media";
import { formatUnknownErrorForDisplay } from "./bus-agent-runner/error-display";
import {
  debugJsonStringify,
  safeStringify,
  sanitizeFilenameToken,
} from "./bus-agent-runner/formatting";
import {
  ANTHROPIC_PROMPT_CACHE_PROVIDER_OPTIONS,
  shouldEnableAnthropicPromptCache,
  toOpenAIPromptCacheKey,
  withOpenAIPromptCacheKey,
  withOpenAIServerCompaction,
  withProviderOptionsOnLastUserMessage,
  withReasoningDisplayDefaultForAnthropicModels,
  withReasoningSummaryDefaultForOpenAIModels,
} from "./bus-agent-runner/provider-options";
import {
  parseCustomCommandFromRaw,
  parseBufferedForActiveRequestIdFromRaw,
  getParticipantUserIdsFromRaw,
  parseRequestControlFromRaw,
  parseRequestModelOverrideFromRaw,
  parseRouterSessionModeFromRaw,
  parseSessionConfigIdFromRaw,
  parseSubagentMetaFromRaw,
  parseWorkflowRequestHintFromRaw,
  preserveAgentRunnerRaw,
  requestRawReferencesMessage,
  type AgentRunProfile,
  type AgentRunnerRaw,
  type ParsedSubagentMeta,
} from "./bus-agent-runner/raw";
import {
  type AgentOutputPublishFailed,
  createAgentOutputPublisher,
} from "./bus-agent-runner/output-publisher";
import { latestUserInput, shouldRunAutoInjectedThreadSearch } from "./bus-agent-runner/text-units";
import { createTransientModelRetryController } from "./bus-agent-runner/transient-retry";
import {
  materializeClaudeCodeRun,
  materializeClaudeCodeRunResult,
  type ClaudeCodeRunExternalFailure,
  type ClaudeCodeRunControl,
  type MaterializedClaudeCodeRun,
} from "@stanley2058/lilac-claude-code-bridge";
import {
  buildInputCompositionLine,
  buildNoAssistantTextError,
  buildStatsLine,
  formatCallWarning,
  getStatsForNerdsOptions,
  maybeAppendWarningSummaryToUnclearError,
  summarizeCallWarnings,
  systemPromptToText,
} from "./bus-agent-runner/stats";
import {
  appendAdditionalSessionMemoBlock,
  appendConfiguredAliasPromptBlock,
  buildAutoInjectedThreadSearchOverlay,
  buildHeartbeatOverlayForRequest,
  buildRestrictedSessionOverlay,
  buildSurfaceMetadataOverlay,
  maybeAppendResponseCommentaryPrompt,
  resolveSessionAdditionalPrompts,
} from "./bus-agent-runner/prompt-overlays";
import { resolveSessionSafetyMode, type SessionSafetyMode } from "../session-policy";
import type { AuthenticatedSurfaceOrigin, SurfacePrincipal } from "../types";
import type { SurfaceProtocolResolver } from "../runtime-descriptor";
import type {
  CustomCommandExecutionError,
  CustomCommandManager,
} from "../../custom-commands/manager";
import {
  coreProfileExecutionScopeAuthority,
  createCoreNamedClaudeRuntime as createCoreNamedClaudeRuntimeResult,
  hashCoreNamedExecutionScope,
  prepareCoreNamedHistoryView,
  shouldReplayCoreNamedHistory,
  supportsCoreNamedContinuationStore,
  type CoreNamedClaudeRuntime,
} from "./bus-agent-runner/core-named-continuation";
import {
  createCorePrimaryClaudeRuntime as createCorePrimaryClaudeRuntimeResult,
  prepareCorePrimaryHistoryView,
  shouldReplayCorePrimaryHistory,
  supportsCorePrimaryContinuationStore,
  type CorePrimaryClaudeRuntime,
} from "./bus-agent-runner/core-primary-continuation";

export { formatUnknownErrorForDisplay } from "./bus-agent-runner/error-display";
export {
  shouldEnableAnthropicPromptCache,
  toOpenAIPromptCacheKey,
  withReasoningDisplayDefaultForAnthropicModels,
  withReasoningSummaryDefaultForOpenAIModels,
} from "./bus-agent-runner/provider-options";
export {
  measureMeaningfulTextUnits,
  shouldRunAutoInjectedThreadSearch,
} from "./bus-agent-runner/text-units";
export {
  appendAdditionalSessionMemoBlock,
  appendConfiguredAliasPromptBlock,
  buildAutoInjectedThreadSearchOverlay,
  buildHeartbeatOverlayForRequest,
  buildRestrictedSessionOverlay,
  buildSurfaceMetadataOverlay,
  maybeAppendResponseCommentaryPrompt,
  resolveSessionAdditionalPrompts,
} from "./bus-agent-runner/prompt-overlays";

export class CoreStableNamedContinuationInvalid extends TaggedError(
  "CoreStableNamedContinuationInvalid",
)<{
  readonly reason: "primary-run" | "session-mismatch";
  readonly message: string;
}> {}

export function resolveCoreStableNamedContinuation(input: {
  readonly runProfile: AgentRunProfile;
  readonly sessionId: string;
  readonly workflowPolicy: WorkflowRequestPolicy | null;
}): ResultType<
  NonNullable<WorkflowRequestPolicy["stableNamedContinuation"]> | null,
  CoreStableNamedContinuationInvalid
> {
  const identity = input.workflowPolicy?.stableNamedContinuation;
  if (!identity) return Result.ok(null);
  if (input.runProfile === "primary") {
    return Result.err(
      new CoreStableNamedContinuationInvalid({
        reason: "primary-run",
        message: "Stable named continuation cannot authorize a primary run",
      }),
    );
  }
  if (identity.sessionId !== input.sessionId) {
    return Result.err(
      new CoreStableNamedContinuationInvalid({
        reason: "session-mismatch",
        message: "Stable named continuation identity does not match the child session",
      }),
    );
  }
  return Result.ok(identity);
}

export function shouldUsePersistentCoreClaudeRuntime(input: {
  runProfile: AgentRunProfile;
  requestClient: AdapterPlatform;
  stableNamedContinuation: NonNullable<WorkflowRequestPolicy["stableNamedContinuation"]> | null;
  corePrimaryLineage?: CorePrimaryLineageV1;
}): boolean {
  if (input.runProfile === "primary") return input.requestClient === "discord";
  return input.stableNamedContinuation !== null;
}

function supportsReadFileDirectAttachments(info: ModelCapabilityInfo | null): boolean {
  if (info?.attachment !== true) return false;
  const inputModalities = info?.modalities?.input;
  if (!inputModalities) return false;
  return inputModalities.includes("image") && inputModalities.includes("pdf");
}

function consumerId(prefix: string): string {
  return `${prefix}:${process.pid}:${Math.random().toString(16).slice(2)}`;
}

export function rethrowBusAgentRunnerPanic(
  cause: unknown,
  beforeRethrow?: (panic: Panic) => void,
): void {
  if (!isPanic(cause)) return;
  beforeRethrow?.(cause);
  throw cause;
}

export class BusAgentRunnerRequestHeadersInvalid extends TaggedError(
  "BusAgentRunnerRequestHeadersInvalid",
)<{
  readonly missing: readonly ("request_id" | "session_id")[];
  readonly message: string;
}> {}

export class BusAgentRunnerQueueAttemptRouteInvalid extends TaggedError(
  "BusAgentRunnerQueueAttemptRouteInvalid",
)<{
  readonly eventId: string;
  readonly message: string;
}> {}

export class BusAgentRunnerRecoveryStopped extends TaggedError("BusAgentRunnerRecoveryStopped")<{
  readonly message: string;
}> {}

export class BusAgentRunnerIntakeFailed extends TaggedError("BusAgentRunnerIntakeFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class BusAgentRunnerAuthenticationProjectionInvalid extends TaggedError(
  "BusAgentRunnerAuthenticationProjectionInvalid",
)<{
  readonly cause:
    | AuthenticatedRequestProjectionInvalid
    | RequestMessageCacheAdmissionError
    | RequestIdentitySourceMissing
    | RequestIdentityAliasTargetOccupied
    | AuthenticatedRequestProjectionInvalid;
  readonly message: string;
}> {}

export class BusAgentRunnerOperationFailed extends TaggedError("BusAgentRunnerOperationFailed")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly failureKind: "idle-timeout" | "pre-agent-cancelled" | "restart-draining" | "other";
  readonly displayMessage: string;
  readonly details?: ReturnType<typeof extractAiErrorLogDetails>;
  readonly message: string;
}> {}

export async function captureBusAgentRunnerOperation<T>(
  operation: string,
  run: () => T | Promise<T>,
  beforePanicRethrow?: (panic: Panic) => void,
): Promise<ResultType<Awaited<T>, BusAgentRunnerOperationFailed>> {
  try {
    return Result.ok(await run());
  } catch (cause) {
    rethrowBusAgentRunnerPanic(cause, beforePanicRethrow);
    const projection = projectBusAgentRunnerError(cause, `${operation} failed`);
    let failureKind: BusAgentRunnerOperationFailed["failureKind"] = "other";
    if (cause instanceof AgentIdleTimeoutError) failureKind = "idle-timeout";
    if (cause instanceof PreAgentRunCancelledError) failureKind = "pre-agent-cancelled";
    if (cause instanceof RestartDrainingAbort) failureKind = "restart-draining";
    return Result.err(
      new BusAgentRunnerOperationFailed({
        operation,
        cause,
        failureKind,
        displayMessage: formatUnknownErrorForDisplay(cause),
        details: projection.details,
        message: projection.message,
      }),
    );
  }
}

export function toIdleRetryDecision(
  backoff: ResultType<RetryBackoffAttempt | null, RetryBackoffAborted | RetryBackoffDelayFailed>,
):
  | { readonly status: "retry"; readonly attempt: RetryBackoffAttempt }
  | { readonly status: "fail"; readonly reason: "aborted" | "delay-failed" | "exhausted" } {
  if (backoff.status === "error") {
    switch (backoff.error._tag) {
      case "RetryBackoffAborted":
        return { status: "fail", reason: "aborted" };
      case "RetryBackoffDelayFailed":
        return { status: "fail", reason: "delay-failed" };
    }
  }
  return backoff.value === null
    ? { status: "fail", reason: "exhausted" }
    : { status: "retry", attempt: backoff.value };
}

export function signalBusAgentRunnerHostFailure(
  failure: Error | BusAgentRunnerOperationFailed,
): never {
  throw failure instanceof BusAgentRunnerOperationFailed ? failure.cause : failure;
}

function adaptModelResolutionToBusRunnerHost<T>(result: ResultType<T, ModelResolutionFailed>): T {
  if (result.status === "ok") return result.value;
  switch (result.error._tag) {
    case "ModelResolutionFailed":
      throw result.error;
  }
}

type BusAgentRunnerErrorProjection = {
  readonly message: string;
  readonly details?: ReturnType<typeof extractAiErrorLogDetails>;
};

export function projectBusAgentRunnerError(
  cause: unknown,
  fallback = "Agent runner operation failed",
): BusAgentRunnerErrorProjection {
  const projectedCause =
    isRecord(cause) && cause["loaded"] === false && "error" in cause ? cause["error"] : cause;
  const message = opaqueErrorMessage(projectedCause, fallback);
  try {
    const details = extractAiErrorLogDetails(projectedCause);
    return details ? { message, details } : { message };
  } catch {
    return { message };
  }
}

export type BusAgentRunnerDeliveryError =
  | BusAgentRunnerRequestHeadersInvalid
  | BusAgentRunnerQueueAttemptRouteInvalid
  | BusAgentRunnerRecoveryStopped
  | BusAgentRunnerAuthenticationProjectionInvalid
  | BusAgentRunnerIntakeFailed;

export function busAgentRunnerDeliveryDisposition(
  error: BusAgentRunnerDeliveryError,
): DeliveryDisposition {
  switch (error._tag) {
    case "BusAgentRunnerRequestHeadersInvalid":
    case "BusAgentRunnerQueueAttemptRouteInvalid":
    case "BusAgentRunnerAuthenticationProjectionInvalid":
      return "dead-letter";
    case "BusAgentRunnerRecoveryStopped":
      return "stop";
    case "BusAgentRunnerIntakeFailed":
      return "park-pending";
  }
}

export function resolveCoreClaudeCompactionSummaryModel(input: {
  readonly run: Pick<MaterializedClaudeCodeRun, "createUtilityModelResult"> | null;
  readonly fallback: () => LanguageModel;
  readonly onFailure: (error: ClaudeCodeRunExternalFailure) => void;
}): LanguageModel {
  if (input.run === null) return input.fallback();

  const created = input.run.createUtilityModelResult();
  if (created.status === "ok") return created.value;

  switch (created.error._tag) {
    case "ClaudeCodeRunExternalFailure":
      input.onFailure(created.error);
      return input.fallback();
  }
}

export async function rethrowBusAgentRunnerCleanupDefect(
  cleanup: () => void | Promise<void>,
): Promise<void> {
  await cleanup();
}

export type BusAgentRunnerTerminalCleanup = {
  readonly label:
    | "workflow-claim-timer-clear"
    | "control-capability-expire"
    | "workflow-request-expire"
    | "run-idle-watchdog-stop"
    | "agent-unsubscribe"
    | "compaction-unsubscribe"
    | "output-publisher-drain"
    | "core-named-retire"
    | "core-primary-retire"
    | "claude-dispose"
    | "live-close";
  readonly run: () => void | Promise<void>;
};

export type BusAgentRunnerTerminalCleanupOperation = {
  readonly label: BusAgentRunnerTerminalCleanup["label"];
  readonly operation: Promise<void>;
};

export type BusAgentRunnerTerminalCleanupBatch = {
  readonly operations: readonly BusAgentRunnerTerminalCleanupOperation[];
  readonly completion: Promise<void>;
};

export function startBusAgentRunnerTerminalCleanup(
  cleanups: readonly BusAgentRunnerTerminalCleanup[],
): BusAgentRunnerTerminalCleanupBatch {
  const operations = cleanups.map((cleanup) => {
    const operation = rethrowBusAgentRunnerCleanupDefect(cleanup.run);
    return { label: cleanup.label, operation };
  });
  const completion = Promise.allSettled(operations.map(({ operation }) => operation)).then(
    () => undefined,
  );
  return { operations, completion };
}

function buildResumePrompt(partialText: string): ModelMessage {
  const base =
    "System notice: the server restarted during your previous turn. Continue from the last stable boundary. If a tool was interrupted, treat it as failed with error: server restarted, and proceed safely.";
  const content =
    partialText.trim().length > 0
      ? `${base}\n\nPartial response already shown to user:\n\n${partialText}\n\nContinue from there without duplicating already visible text.`
      : `${base}\n\nNo visible partial response was persisted.`;

  return {
    role: "user",
    content,
  };
}

// OpenCode-style tool output pruning:
// - Keep full tool call/result structure for forkability.
// - Compact *old* tool results (replace output with a placeholder) only in the
//   model-facing view, right before sending.
// - Track compacted toolCallIds in-memory per session for stability (cache hits).
const TOOL_OUTPUT_PLACEHOLDER = "[Old tool result content cleared]";
const TOOL_OUTPUT_CHARS_PER_TOKEN = 4;
const TOOL_OUTPUT_PRUNE_PROTECTED_TOOLS = new Set(["skill", "subagent_result"]);

export function withBlankLineBetweenTextParts(params: {
  accumulatedText: string;
  delta: string;
  partChanged: boolean;
}): string {
  if (!params.partChanged) return params.delta;
  if (params.accumulatedText.length === 0) return params.delta;
  if (params.delta.length === 0) return params.delta;
  if (/^\s/u.test(params.delta)) return params.delta;
  if (/\n\s*\n\s*$/u.test(params.accumulatedText)) return params.delta;
  if (/\n\s*$/u.test(params.accumulatedText)) return `\n${params.delta}`;
  return `\n\n${params.delta}`;
}

export type AssistantTextPartBoundaryState = {
  lastTextPartId: string | null;
  pendingRecoveryTextBoundary: boolean;
  pendingTextPartStartIds: Set<string>;
};

export function createAssistantTextPartBoundaryState(
  partialText: string | undefined,
): AssistantTextPartBoundaryState {
  return {
    lastTextPartId: null,
    pendingRecoveryTextBoundary: Boolean(partialText?.trim()),
    pendingTextPartStartIds: new Set<string>(),
  };
}

export function markAssistantTextPartStarted(
  state: AssistantTextPartBoundaryState,
  partId: string,
): void {
  state.pendingTextPartStartIds.add(partId);
}

export function markAssistantTextPartEnded(
  state: AssistantTextPartBoundaryState,
  partId: string,
): void {
  state.pendingTextPartStartIds.delete(partId);
}

export function consumeAssistantTextDelta(params: {
  state: AssistantTextPartBoundaryState;
  finalText: string;
  recoveryPartialText?: string;
  partId: string;
  delta: string;
}): string {
  const startedNewTextBlock = params.state.pendingTextPartStartIds.has(params.partId);
  const hasPartBoundary =
    startedNewTextBlock ||
    (params.state.lastTextPartId !== null && params.partId !== params.state.lastTextPartId);
  const accumulatedTextForBoundary =
    params.finalText.length > 0 ? params.finalText : (params.recoveryPartialText ?? "");
  const nextDelta = withBlankLineBetweenTextParts({
    accumulatedText: accumulatedTextForBoundary,
    delta: params.delta,
    partChanged: hasPartBoundary || params.state.pendingRecoveryTextBoundary,
  });
  if (nextDelta.length > 0) {
    const boundaryResolvedByThisDelta = /\S/u.test(params.delta);
    if (boundaryResolvedByThisDelta) {
      params.state.pendingRecoveryTextBoundary = false;
      params.state.pendingTextPartStartIds.delete(params.partId);
    }
  }
  params.state.lastTextPartId = params.partId;
  return nextDelta;
}

export function removeSilentAssistantTurnMessages(input: {
  messages: readonly ModelMessage[];
  startIndex: number;
  messageCount: number;
}): ModelMessage[] {
  const endIndex = input.startIndex + input.messageCount;
  const messages: ModelMessage[] = [];

  for (let index = 0; index < input.messages.length; index += 1) {
    const message = input.messages[index]!;
    if (index < input.startIndex || index >= endIndex || message.role !== "assistant") {
      messages.push(message);
      continue;
    }

    const text = (() => {
      if (typeof message.content === "string") return message.content;
      const textParts = message.content.filter((part) => part.type === "text");
      const finalAnswerParts = textParts.filter(
        (part) => openAIMessagePhase(part.providerOptions) === "final_answer",
      );
      return (finalAnswerParts.length > 0 ? finalAnswerParts : textParts)
        .map((part) => part.text)
        .join("\n\n");
    })();
    if (resolveReplyDeliveryFromFinalText(text) !== "skip") {
      messages.push(message);
      continue;
    }
    if (typeof message.content === "string") continue;

    const content = message.content.filter((part) => part.type !== "text");
    if (content.every((part) => part.type === "reasoning")) continue;
    messages.push({ ...message, content });
  }

  return messages;
}

export type ReasoningChunkState = {
  chunks: Map<string, string>;
  seq: number;
};

export function consumeReasoningChunkEvent(
  state: ReasoningChunkState,
  event:
    | { type: "start"; chunkId: string }
    | { type: "delta"; chunkId: string; delta: string }
    | { type: "end"; chunkId: string },
): {
  publishStart: boolean;
  snapshot: { delta: string; seq: number } | null;
} {
  if (event.type === "end") {
    state.chunks.delete(event.chunkId);
    return { publishStart: false, snapshot: null };
  }

  if (event.type === "start") {
    if (!state.chunks.has(event.chunkId)) {
      state.chunks.set(event.chunkId, "");
    }
    return { publishStart: true, snapshot: null };
  }

  const publishStart = !state.chunks.has(event.chunkId);
  const chunk = `${state.chunks.get(event.chunkId) ?? ""}${event.delta}`;
  state.chunks.set(event.chunkId, chunk);
  if (event.delta.length === 0) {
    return { publishStart, snapshot: null };
  }

  state.seq += 1;
  return {
    publishStart,
    snapshot: { delta: chunk, seq: state.seq },
  };
}

function estimateTokensFromValue(value: unknown): number {
  // Best-effort token estimate (OpenCode uses chars/4).
  const chars = safeStringify(value).length;
  return Math.max(0, Math.round(chars / TOOL_OUTPUT_CHARS_PER_TOKEN));
}

export function maybeMarkOldToolOutputsCompacted(params: {
  messages: readonly ModelMessage[];
  compactedToolCallIds: Set<string>;
  protectTokens: number;
  minimumTokens: number;
}): number {
  let turns = 0;
  let total = 0;
  let pruned = 0;
  const toCompact = new Set<string>();

  // Walk backwards; skip the last turn (turn = user message).
  // This mirrors OpenCode's "turns < 2" behavior.
  outer: for (let msgIndex = params.messages.length - 1; msgIndex >= 0; msgIndex--) {
    const msg = params.messages[msgIndex]!;
    if (msg.role === "user") turns++;
    if (turns < 2) continue;

    if (msg.role !== "tool") continue;
    if (!Array.isArray(msg.content)) continue;

    for (let partIndex = msg.content.length - 1; partIndex >= 0; partIndex--) {
      const part = msg.content[partIndex];
      if (part?.type !== "tool-result") continue;

      const toolName = part.toolName;
      if (toolName && TOOL_OUTPUT_PRUNE_PROTECTED_TOOLS.has(toolName)) continue;
      const toolCallId = part.toolCallId;
      if (!toolCallId) continue;

      // Once we reach already-compacted results, stop. Older ones should already be compacted.
      if (params.compactedToolCallIds.has(toolCallId)) break outer;

      const output = part.output;
      const estimate = estimateTokensFromValue(output);
      total += estimate;

      if (total > params.protectTokens) {
        pruned += estimate;
        toCompact.add(toolCallId);
      }
    }
  }

  if (pruned <= params.minimumTokens) return 0;

  let changed = false;
  for (const id of toCompact) {
    if (params.compactedToolCallIds.has(id)) continue;
    params.compactedToolCallIds.add(id);
    changed = true;
  }
  return changed ? pruned : 0;
}

export function applyToolOutputCompactionView(params: {
  messages: readonly ModelMessage[];
  compactedToolCallIds: ReadonlySet<string>;
}): ModelMessage[] {
  let changed = false;

  const out = params.messages.map((m) => {
    if (m.role !== "tool") return m;
    if (!Array.isArray(m.content)) return m;

    let nextContent: ToolContent | null = null;

    for (let i = 0; i < m.content.length; i++) {
      const part = m.content[i];
      if (part?.type !== "tool-result") continue;

      const toolCallId = part.toolCallId;
      if (!toolCallId) continue;
      if (!params.compactedToolCallIds.has(toolCallId)) continue;

      nextContent ??= m.content.map((p) => ({ ...p }));

      const nextPart = nextContent?.[i];
      if (nextPart?.type !== "tool-result") continue;

      nextPart["output"] = { type: "text", value: TOOL_OUTPUT_PLACEHOLDER };
      changed = true;
    }

    if (!nextContent) return m;
    return {
      ...m,
      content: nextContent,
    } satisfies ModelMessage;
  });

  return changed ? out : [...params.messages];
}

export function scrubLargeBinaryForModelView(
  messages: readonly ModelMessage[],
  limits: { maxBytesPerPart: number; maxBytesTotal: number },
): ModelMessage[] {
  return boundToolResultMediaForModelView(messages, limits);
}

function getBatchOkFromResult(result: unknown): boolean | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const v = (result as Record<string, unknown>)["ok"];
  return typeof v === "boolean" ? v : null;
}

function getSubagentOkFromResult(result: unknown): boolean | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const v = (result as Record<string, unknown>)["ok"];
  return typeof v === "boolean" ? v : null;
}

function decodeDeferredSubagentAcceptedResult(result: unknown): {
  ok: true;
  mode: "deferred";
  status: "accepted";
  sessionName: string;
} | null {
  if (!isRecord(result)) return null;
  const sessionName = result["sessionName"];
  if (
    result["ok"] !== true ||
    result["mode"] !== "deferred" ||
    result["status"] !== "accepted" ||
    typeof sessionName !== "string"
  ) {
    return null;
  }
  return { ok: true, mode: "deferred", status: "accepted", sessionName };
}

function buildSubagentResultToolCallId(seed: string): string {
  return buildSyntheticToolCallId({
    prefix: "subagent_result",
    seed,
  });
}

function buildCustomCommandToolCallId(requestId: string, name: string): string {
  return buildSyntheticToolCallId({
    prefix: CUSTOM_COMMAND_TOOL_NAME,
    seed: `${requestId}:${name}`,
  });
}

function buildAutoInjectedThreadSearchToolCallId(requestId: string): string {
  return buildSyntheticToolCallId({
    prefix: "conversation_thread_search",
    seed: `${requestId}:auto-inject`,
  });
}

function formatCompactCount(count: number | undefined): string {
  if (typeof count !== "number" || !Number.isFinite(count)) return "?";
  return String(Math.max(0, Math.trunc(count)));
}

export function formatAutoCompactionToolDisplay(
  input:
    | { phase: "start"; messageCountBefore: number }
    | {
        phase: "end";
        ok: boolean;
        messageCountBefore: number;
        messageCountAfter?: number;
      },
): string {
  if (input.phase === "start") {
    return `compact context (${formatCompactCount(input.messageCountBefore)} msgs)`;
  }

  if (!input.ok) return "compact context failed";

  return `compact context (${formatCompactCount(input.messageCountBefore)}->${formatCompactCount(input.messageCountAfter)} msgs)`;
}

function buildCustomCommandMessages(params: {
  toolCallId: string;
  name: string;
  args: readonly unknown[];
  prompt?: string;
  text: string;
  source: "text" | "discord-slash";
  output: CustomCommandResult;
}): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: params.toolCallId,
          toolName: CUSTOM_COMMAND_TOOL_NAME,
          input: {
            name: params.name,
            args: params.args,
            ...(params.prompt ? { prompt: params.prompt } : {}),
            text: params.text,
            source: params.source,
          },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: params.toolCallId,
          toolName: CUSTOM_COMMAND_TOOL_NAME,
          output: params.output,
        },
      ],
    },
  ];
}

export function buildCustomCommandFailureFinalText(params: {
  commandText: string;
  normalizedOutput: CustomCommandResult;
}): string {
  const normalizedError =
    params.normalizedOutput.type === "error-text"
      ? params.normalizedOutput.value
      : "Custom command failed.";
  return `Error running ${params.commandText}: ${normalizedError}`;
}

export function customCommandExecutionErrorText(error: CustomCommandExecutionError): string {
  switch (error._tag) {
    case "CustomCommandImportError":
    case "CustomCommandExecuteMissingError":
    case "CustomCommandExecuteThrownError":
    case "CustomCommandExecuteRejectedError":
    case "CustomCommandResultInvalidError":
      return error.message;
  }
}

const AUTO_INJECTED_THREAD_SEARCH_TOOL_NAME = "conversation_thread_search";
export const AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH = 320;
const AUTO_INJECTED_THREAD_BRIEF_FULL_THRESHOLD = Math.floor(
  AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH * 1.1,
);

export type AutoInjectedThreadSearchPayload = {
  entries: Array<{
    threadId: string;
    title: string;
    brief?: string;
    timeRange?: string;
  }>;
};

type AutoInjectedThreadSearchEntry = AutoInjectedThreadSearchPayload["entries"][number];

type AutoInjectedThreadSearchCandidate = AutoInjectedThreadSearchEntry & {
  score: number;
  searchIndex: number;
  rank: number;
};

type AutoInjectedThreadSearchAppendedEvent = {
  toolCallId: string;
  mode: "hybrid" | "semantic" | "lexical";
  limit: number;
  searches: readonly (readonly string[])[];
  participantFilterUserCount: number;
  entries: readonly AutoInjectedThreadSearchEntry[];
};

export function buildAutoInjectedThreadSearchMessages(params: {
  toolCallId: string;
  entries: readonly AutoInjectedThreadSearchEntry[];
}): ModelMessage[] {
  const payload: AutoInjectedThreadSearchPayload = {
    entries: params.entries.map((entry) => ({
      threadId: entry.threadId,
      title: entry.title,
      ...(entry.brief ? { brief: entry.brief } : {}),
      ...(entry.timeRange ? { timeRange: entry.timeRange } : {}),
    })),
  };

  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: params.toolCallId,
          toolName: AUTO_INJECTED_THREAD_SEARCH_TOOL_NAME,
          input: {
            note: "auto-injected after long user input",
          },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: params.toolCallId,
          toolName: AUTO_INJECTED_THREAD_SEARCH_TOOL_NAME,
          output: {
            type: "json",
            value: payload,
          },
        },
      ],
    },
  ];
}

function formatAutoInjectedThreadBrief(brief: string): string | undefined {
  const trimmed = brief.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length <= AUTO_INJECTED_THREAD_BRIEF_FULL_THRESHOLD) return trimmed;

  return `${trimmed.slice(0, AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH).trimEnd()} ...(${trimmed.length - AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH} remaining)`;
}

function compareAutoInjectedThreadSearchCandidates(
  left: AutoInjectedThreadSearchCandidate,
  right: AutoInjectedThreadSearchCandidate,
): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.searchIndex !== right.searchIndex) return left.searchIndex - right.searchIndex;
  return left.rank - right.rank;
}

function stripAutoInjectedThreadSearchCandidate(
  candidate: AutoInjectedThreadSearchCandidate,
): AutoInjectedThreadSearchEntry {
  return {
    threadId: candidate.threadId,
    title: candidate.title,
    ...(candidate.brief ? { brief: candidate.brief } : {}),
    ...(candidate.timeRange ? { timeRange: candidate.timeRange } : {}),
  };
}

function selectAutoInjectedThreadSearchEntries(
  groups: readonly (readonly AutoInjectedThreadSearchCandidate[])[],
  limit: number,
): AutoInjectedThreadSearchEntry[] {
  const selected: AutoInjectedThreadSearchCandidate[] = [];
  const selectedThreadIds = new Set<string>();
  const earlierGroupThreadIds = new Set<string>();

  for (const group of groups) {
    if (selected.length >= limit) break;
    const candidate = group.find(
      (item) => !selectedThreadIds.has(item.threadId) && !earlierGroupThreadIds.has(item.threadId),
    );
    for (const item of group) {
      earlierGroupThreadIds.add(item.threadId);
    }
    if (!candidate) continue;
    selected.push(candidate);
    selectedThreadIds.add(candidate.threadId);
  }

  if (selected.length < limit) {
    const remainingByThreadId = new Map<string, AutoInjectedThreadSearchCandidate>();
    for (const group of groups) {
      for (const candidate of group) {
        if (selectedThreadIds.has(candidate.threadId)) continue;
        const existing = remainingByThreadId.get(candidate.threadId);
        if (!existing || compareAutoInjectedThreadSearchCandidates(candidate, existing) < 0) {
          remainingByThreadId.set(candidate.threadId, candidate);
        }
      }
    }

    const remaining = [...remainingByThreadId.values()].sort(
      compareAutoInjectedThreadSearchCandidates,
    );
    for (const candidate of remaining) {
      if (selected.length >= limit) break;
      selected.push(candidate);
      selectedThreadIds.add(candidate.threadId);
    }
  }

  return selected.map(stripAutoInjectedThreadSearchCandidate);
}

function buildAutoInjectedThreadSearchCandidates(input: {
  search: ConversationThreadSearchResult;
  searchIndex: number;
  previouslyInjectedThreadIds: ReadonlySet<string>;
}): AutoInjectedThreadSearchCandidate[] {
  return input.search.results
    .filter((result) => !input.previouslyInjectedThreadIds.has(result.threadId))
    .map((result, index) => {
      const timeRange = result.timeRange
        ? formatInjectedThreadTimeRange(result.timeRange)
        : undefined;
      const brief = formatAutoInjectedThreadBrief(result.brief);
      return {
        threadId: result.threadId,
        title: result.title,
        ...(brief ? { brief } : {}),
        ...(timeRange ? { timeRange } : {}),
        score: result.score ?? 0,
        searchIndex: input.searchIndex,
        rank: index + 1,
      };
    });
}

function collectAutoInjectedThreadIds(messages: readonly ModelMessage[]): Set<string> {
  const threadIds = new Set<string>();

  for (const message of messages) {
    const content: unknown = message.content;
    if (message.role !== "tool" || !Array.isArray(content)) continue;

    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type !== "tool-result" || part.toolName !== AUTO_INJECTED_THREAD_SEARCH_TOOL_NAME) {
        continue;
      }

      const output = part.output;
      const payload = isRecord(output) && output.type === "json" ? output.value : output;
      const entries = isRecord(payload) ? payload.entries : undefined;
      if (!Array.isArray(entries)) continue;

      for (const entry of entries) {
        if (!isRecord(entry)) continue;
        const threadId = entry.threadId;
        if (typeof threadId === "string" && threadId.length > 0) threadIds.add(threadId);
      }
    }
  }

  return threadIds;
}

function padLocalDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalThreadTime(value: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;

  const year = date.getFullYear();
  const month = padLocalDatePart(date.getMonth() + 1);
  const day = padLocalDatePart(date.getDate());
  const hour = padLocalDatePart(date.getHours());
  const minute = padLocalDatePart(date.getMinutes());
  return `${year}/${month}/${day} ${hour}:${minute}`;
}

function formatInjectedThreadTimeRange(input: { start: string; end: string }): string | undefined {
  const start = formatLocalThreadTime(input.start);
  const end = formatLocalThreadTime(input.end);
  if (!start || !end) return undefined;
  return `${start} - ${end}`;
}

export async function maybeBuildAutoInjectedThreadSearchMessages(params: {
  cfg: CoreConfig;
  conversationThreads?: ConversationThreadToolService;
  requestId: string;
  raw?: AgentRunnerRaw;
  previousMessages?: readonly ModelMessage[];
  userMessages: readonly ModelMessage[];
  publishToolStatus: (update: {
    toolCallId: string;
    status: "start" | "end";
    display: string;
    ok?: boolean;
    error?: string;
  }) => Promise<void>;
  onInjected?: (event: AutoInjectedThreadSearchAppendedEvent) => void;
  onError: (message: string, error: BusAgentRunnerErrorProjection) => void;
}): Promise<ModelMessage[]> {
  const autoInject = params.cfg.conversation.thread.autoInject;
  if (!autoInject.enabled) return [];
  if (!params.conversationThreads) return [];
  const conversationThreads = params.conversationThreads;

  const latestInput = latestUserInput(params.userMessages);
  const text = latestInput.text;
  const previouslyInjectedThreadIds = collectAutoInjectedThreadIds(params.previousMessages ?? []);
  const minTextUnits =
    previouslyInjectedThreadIds.size > 0
      ? autoInject.followUpMinTextUnits
      : autoInject.minTextUnits;
  if (
    !latestInput.hasAttachment &&
    !shouldRunAutoInjectedThreadSearch({ text: latestInput.authoredText, minTextUnits })
  ) {
    return [];
  }

  const participantIds = autoInject.filterCurrentParticipants
    ? getParticipantUserIdsFromRaw(params.raw)
    : [];
  if (autoInject.filterCurrentParticipants && participantIds.length === 0) return [];

  const toolCallId = buildAutoInjectedThreadSearchToolCallId(params.requestId);
  const display = `${AUTO_INJECTED_THREAD_SEARCH_TOOL_NAME} auto-injected metadata`;
  const publishToolStatusBestEffort = async (update: {
    toolCallId: string;
    status: "start" | "end";
    display: string;
    ok?: boolean;
    error?: string;
  }) => {
    try {
      await params.publishToolStatus(update);
    } catch (error) {
      params.onError(
        "auto-injected thread search status publish failed; continuing",
        projectBusAgentRunnerError(error),
      );
    }
  };

  await publishToolStatusBestEffort({ toolCallId, status: "start", display });

  try {
    const plan = await conversationThreads.planAutoInjectSearch({
      text,
      content: latestInput.content,
    });
    const searchRecallLimit = Math.min(50, autoInject.limit * plan.searches.length);
    const settledSearches = await Promise.allSettled(
      plan.searches.map((searchPlan) =>
        conversationThreads.search({
          query: searchPlan.queries,
          queryAboutness: searchPlan.aboutness,
          limit: searchRecallLimit,
          minScore: autoInject.minScore,
          mode: autoInject.mode,
          verbose: true,
          ...(participantIds.length > 0 ? { participantIdsAny: participantIds } : {}),
        }),
      ),
    );
    let fulfilledSearches = 0;
    const candidateGroups = settledSearches.map((result, searchIndex) => {
      if (result.status === "fulfilled") {
        fulfilledSearches += 1;
        return buildAutoInjectedThreadSearchCandidates({
          search: result.value,
          searchIndex,
          previouslyInjectedThreadIds,
        });
      }

      params.onError(
        "auto-injected thread search failed; continuing with partial metadata",
        projectBusAgentRunnerError(result.reason, `Search ${searchIndex} failed`),
      );
      return [];
    });
    if (fulfilledSearches === 0) {
      const failure = projectBusAgentRunnerError(
        new Error("all auto-injected thread searches failed"),
      );
      await publishToolStatusBestEffort({
        toolCallId,
        status: "end",
        display,
        ok: false,
        error: failure.message,
      });
      params.onError("auto-injected thread search failed; continuing without metadata", failure);
      return [];
    }
    const entries = selectAutoInjectedThreadSearchEntries(candidateGroups, autoInject.limit);

    await publishToolStatusBestEffort({
      toolCallId,
      status: "end",
      display,
      ok: true,
    });

    if (entries.length === 0) return [];
    try {
      params.onInjected?.({
        toolCallId,
        mode: autoInject.mode,
        limit: autoInject.limit,
        searches: plan.searches.map((searchPlan) => searchPlan.queries),
        participantFilterUserCount: participantIds.length,
        entries,
      });
    } catch (error) {
      params.onError(
        "auto-injected thread search append log failed; continuing",
        projectBusAgentRunnerError(error),
      );
    }
    return buildAutoInjectedThreadSearchMessages({ toolCallId, entries });
  } catch (error) {
    const projected = projectBusAgentRunnerError(error);
    await publishToolStatusBestEffort({
      toolCallId,
      status: "end",
      display,
      ok: false,
      error: projected.message,
    });
    params.onError("auto-injected thread search failed; continuing without metadata", projected);
    return [];
  }
}

export function buildDeferredSubagentResultMessages(
  completion: WorkflowLiveParentCompletion,
): ModelMessage[] {
  const toolCallId = buildSubagentResultToolCallId(completion.runId);
  const payload = {
    ok: completion.ok,
    mode: "deferred" as const,
    status: completion.status,
    workflowRunId: completion.runId,
    profile: completion.profile,
    sessionName: completion.sessionName,
    finalText: completion.finalText,
    ...(completion.detail ? { detail: completion.detail } : {}),
  };

  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId,
          toolName: "subagent_result",
          input: {
            profile: completion.profile,
            sessionName: completion.sessionName,
            status: completion.status,
            workflowRunId: completion.runId,
          },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: "subagent_result",
          output: {
            type: "json",
            value: payload,
          },
        },
      ],
    },
  ];
}

function buildDeferredSubagentDisplay(completion: WorkflowLiveParentCompletion): string {
  return `subagent (${completion.profile}; ${completion.status})`;
}

function hasToolResult(messages: readonly ModelMessage[], toolCallId: string): boolean {
  return messages.some(
    (message) =>
      message.role === "tool" &&
      message.content.some((part) => part.type === "tool-result" && part.toolCallId === toolCallId),
  );
}

function hasDeferredSubagentWorkflowCall(
  messages: readonly ModelMessage[],
  workflowRunId: string,
): boolean {
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (
        part.type === "tool-call" &&
        part.toolName === "subagent_result" &&
        isRecord(part.input) &&
        part.input["workflowRunId"] === workflowRunId
      ) {
        return true;
      }
    }
  }
  return false;
}

function hasDeferredSubagentWorkflowResult(
  messages: readonly ModelMessage[],
  workflowRunId: string,
): boolean {
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (
        part.type === "tool-result" &&
        part.toolName === "subagent_result" &&
        part.output.type === "json" &&
        isRecord(part.output.value) &&
        part.output.value["workflowRunId"] === workflowRunId
      ) {
        return true;
      }
    }
  }
  return false;
}

function hasConsumedDeferredSubagentResult(
  messages: readonly ModelMessage[],
  completion: Pick<WorkflowLiveParentCompletion, "runId">,
): boolean {
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.toolName !== "subagent_result") continue;
      if (
        part.output.type === "json" &&
        isRecord(part.output.value) &&
        part.output.value["workflowRunId"] === completion.runId
      ) {
        return true;
      }
    }
  }
  return false;
}

export function hasDeferredSubagentResult(
  messages: readonly ModelMessage[],
  completion: Pick<WorkflowLiveParentCompletion, "runId" | "childRequestId">,
): boolean {
  return (
    hasDeferredSubagentWorkflowResult(messages, completion.runId) ||
    hasToolResult(messages, buildSubagentResultToolCallId(completion.runId)) ||
    hasToolResult(messages, buildSubagentResultToolCallId(completion.childRequestId))
  );
}

function hasCurrentDeferredSubagentResult(
  messages: readonly ModelMessage[],
  completion: Pick<WorkflowLiveParentCompletion, "runId">,
): boolean {
  return (
    hasDeferredSubagentWorkflowResult(messages, completion.runId) ||
    hasToolResult(messages, buildSubagentResultToolCallId(completion.runId))
  );
}

export function planDeferredSubagentBoundary(input: {
  canonicalMessages: readonly ModelMessage[];
  modelInputMessages: readonly ModelMessage[];
  completions: readonly WorkflowLiveParentCompletion[];
}): {
  append: ModelMessage[];
  consumedRunIds: string[];
  forceNextTurn: boolean;
} {
  const consumedRunIds = input.completions
    .filter((completion) => hasConsumedDeferredSubagentResult(input.modelInputMessages, completion))
    .map((completion) => completion.runId);
  const consumed = new Set(consumedRunIds);
  const unconsumed = input.completions.filter((completion) => !consumed.has(completion.runId));
  const append = unconsumed.flatMap((completion) => {
    if (hasCurrentDeferredSubagentResult(input.canonicalMessages, completion)) return [];
    const messages = buildDeferredSubagentResultMessages(completion);
    return hasDeferredSubagentWorkflowCall(input.canonicalMessages, completion.runId)
      ? messages.slice(1)
      : messages;
  });

  return {
    append,
    consumedRunIds,
    forceNextTurn: unconsumed.length > 0,
  };
}

function buildHeartbeatHandoffRequestId(requestId: string, index: number): string {
  return `${requestId}:heartbeat-handoff:${index + 1}`;
}

function persistHeartbeatSurfaceHandoffs(params: {
  logger: ReturnType<typeof createLogger>;
  transcriptStore: TranscriptStore;
  requestId: string;
  requestClient: AdapterPlatform;
  sessionId: string;
  modelLabel: string;
  responseMessages: readonly ModelMessage[];
}): void {
  if (!isHeartbeatSessionId(params.sessionId)) return;

  const refs = params.transcriptStore.listSurfaceMessagesForRequest?.({
    requestId: params.requestId,
  });
  if (!refs || refs.length === 0) return;

  const extracted = extractHeartbeatSurfaceSendHandoffs(params.responseMessages);
  const fallback = buildHeartbeatHandoffTranscript(params.responseMessages);
  if (!fallback) return;

  if (extracted.length !== refs.length) {
    params.logger.warn("heartbeat handoff transcript count mismatch", {
      requestId: params.requestId,
      linkedSurfaceMessages: refs.length,
      detectedSends: extracted.length,
    });
  }

  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i]!;
    const handoff = extracted[i] ?? fallback;
    const handoffRequestId = buildHeartbeatHandoffRequestId(params.requestId, i);

    const saved = params.transcriptStore.saveRequestTranscript({
      requestId: handoffRequestId,
      sessionId: HEARTBEAT_HANDOFF_SESSION_ID,
      requestClient: params.requestClient,
      messages: handoff.messages,
      finalText: handoff.finalText,
      modelLabel: params.modelLabel,
    });
    if (saved.status === "error") {
      params.logger.warn(
        "heartbeat handoff transcript persistence failed",
        formatBridgeLogContext({
          requestId: handoffRequestId,
          errorTag: saved.error.name,
          errorMessage: saved.error.message,
        }),
      );
      continue;
    }
    params.transcriptStore.linkSurfaceMessagesToRequest({
      requestId: handoffRequestId,
      created: [ref],
      last: ref,
    });
  }
}

type Enqueued = {
  queueEntryId: string;
  requestId: string;
  sessionId: string;
  requestClient: AdapterPlatform;
  queue: RequestQueueMode;
  runPolicy: RequestRunPolicy;
  origin?: RequestOrigin;
  messages: ModelMessage[];
  corePrimaryLineage?: CorePrimaryLineageV1;
  modelOverride?: string;
  raw?: AgentRunnerRaw;
  authenticatedOrigin?: AuthenticatedSurfaceOrigin;
  currentTurnUserId?: string;
  verifiedIngress?: boolean;
  identityOwner?: RequestMessageCacheOwner;
  restoredSafetyMode?: SessionSafetyMode;
  recovery?: {
    checkpointMessages: ModelMessage[];
    partialText: string;
  };
};

type QueueCancellationGroup = {
  readonly requestId: string;
  readonly requestClient: AdapterPlatform;
  readonly entries: readonly Enqueued[];
};

type QueueLifecycleAttempt = {
  readonly eventId: string;
  readonly controlRequestId: string;
  readonly controlRequestClient: AdapterPlatform;
  readonly sessionId: string;
  readonly kind: "queued-cancellation" | "buffered-absorption";
  readonly detail: string;
  pendingGroups: QueueCancellationGroup[];
  controlApplied: boolean;
};

export type AgentRunnerRecoveryIdentity =
  | {
      readonly state: "durable";
      readonly projection: AuthenticatedRequestProjection;
      readonly assertedSafetyMode: SessionSafetyMode;
      readonly parkedEventIds: readonly string[];
      readonly delegationProof?: {
        readonly kind: "workflow";
        readonly runId: string;
        readonly operationId: string;
        readonly dispatchEpoch: string;
      };
    }
  | {
      readonly state: "restricted";
      readonly reason: "legacy-no-durable-proof" | "missing-cache-proof";
    };

export type AgentRunnerQueueAttempt = {
  readonly eventId: string;
  readonly controlRequestId: string;
  readonly controlRequestClient: AdapterPlatform;
  readonly sessionId: string;
  readonly kind: "queued-cancellation" | "buffered-absorption";
  readonly detail: string;
  readonly controlApplied: boolean;
  readonly controlIdentity: AgentRunnerRecoveryIdentity;
  readonly pendingGroups: readonly {
    readonly publicationIndex: number;
    readonly requestId: string;
    readonly requestClient: AdapterPlatform;
    readonly targetQueueEntryIds: readonly string[];
  }[];
};

export type AgentRunnerRecoveryEntry = {
  queueEntryId?: string;
  kind: "active" | "queued";
  requestId: string;
  sessionId: string;
  requestClient: AdapterPlatform;
  queue: RequestQueueMode;
  runPolicy?: RequestRunPolicy;
  origin?: RequestOrigin;
  messages: ModelMessage[];
  corePrimaryLineage?: CorePrimaryLineageV1;
  modelOverride?: string;
  currentTurnUserId?: string;
  raw?: AgentRunnerRaw;
  recovery?: {
    checkpointMessages: ModelMessage[];
    partialText: string;
  };
  identity?: AgentRunnerRecoveryIdentity;
};

export type AgentRunnerRecoveryState = {
  readonly entries: readonly AgentRunnerRecoveryEntry[];
  readonly queueAttempts: readonly AgentRunnerQueueAttempt[];
};

export class AgentRecoveryUnavailable extends TaggedError("AgentRecoveryUnavailable")<{
  readonly requestId: string;
  readonly reason:
    | "cache-conflict"
    | "delegation-proof-unavailable"
    | "identity-conflict"
    | "queue-admission-conflict"
    | "queue-attempt-conflict";
  readonly message: string;
}> {}

export type AgentRecoveryAttempt = {
  apply(): ResultType<void, AgentRecoveryUnavailable>;
  rollback(): void;
  activate(): void;
};

export function isWorkflowAgentRecoveryEntry(entry: AgentRunnerRecoveryEntry): boolean {
  return (
    parseWorkflowRequestHintFromRaw(entry.raw) !== null ||
    entry.requestId.startsWith("wfr:") ||
    entry.sessionId.startsWith("workflow:")
  );
}

function createFreshOnlyLineage(reason: string, currentCanonicalStart = 0): CorePrimaryLineageV1 {
  const created = createCorePrimaryLineageFreshOnlyV1(reason, currentCanonicalStart);
  if (created.status === "ok") return created.value;
  return {
    state: "fresh-only",
    lineageVersion: 1,
    currentCanonicalStart: 0,
    reason: "lineage-fallback-construction-failed",
  };
}

export function validateCorePrimaryLineageAtRunnerIntake(input: {
  requestClient: AdapterPlatform;
  sessionId?: string;
  runProfile: AgentRunProfile;
  messages: readonly ModelMessage[];
  corePrimaryLineage: unknown;
  transcriptStore?: TranscriptStore;
}): CorePrimaryLineageV1 | undefined {
  if (input.requestClient !== "discord" || input.runProfile !== "primary") return undefined;
  const fallbackCurrentCanonicalStart = Math.max(
    0,
    input.messages.findLastIndex((message) => message.role === "user"),
  );
  if (input.corePrimaryLineage === undefined) {
    return createFreshOnlyLineage("missing-manifest", fallbackCurrentCanonicalStart);
  }
  const decoded = decodeCorePrimaryLineageV1(input.corePrimaryLineage, input.messages);
  if (decoded.status === "error") {
    return createFreshOnlyLineage("malformed-or-unaligned-manifest", fallbackCurrentCanonicalStart);
  }
  const lineage = decoded.value;
  if (lineage.state !== "complete") return lineage;
  if (!input.sessionId) {
    return createFreshOnlyLineage("missing-lineage-scope", lineage.currentCanonicalStart);
  }
  if (!input.transcriptStore?.validateCorePrimaryLineageReferences) {
    return createFreshOnlyLineage("lineage-store-unavailable", lineage.currentCanonicalStart);
  }
  const invalidReason = input.transcriptStore.validateCorePrimaryLineageReferences({
    manifest: lineage,
    requestClient: input.requestClient,
    sessionId: input.sessionId,
    surfaceId: `discord:${input.sessionId}`,
  });
  if (invalidReason.status === "error") {
    return createFreshOnlyLineage("lineage-store-unavailable", lineage.currentCanonicalStart);
  }
  if (invalidReason.value) {
    return createFreshOnlyLineage(invalidReason.value, lineage.currentCanonicalStart);
  }
  return lineage;
}

export function degradeCorePrimaryLineageForMutation(
  reason: string,
  currentCanonicalStart = 0,
): CorePrimaryLineageV1 {
  return createFreshOnlyLineage(reason, currentCanonicalStart);
}

const AUTO_INJECTED_THREAD_SEARCH_LINEAGE_SOURCE = "conversation-thread-auto-inject";

export function appendAutoInjectedThreadSearchLineage(input: {
  lineage: unknown;
  canonicalMessages: readonly ModelMessage[];
  injectedMessages: readonly ModelMessage[];
}): CorePrimaryLineageV1 {
  const parsedShape = corePrimaryLineageV1Schema.safeParse(input.lineage);
  const fallbackCurrentCanonicalStart = parsedShape.success
    ? parsedShape.data.currentCanonicalStart
    : Math.max(
        0,
        input.canonicalMessages.findLastIndex((message) => message.role === "user"),
      );
  const failClosed = () =>
    degradeCorePrimaryLineageForMutation(
      "synthetic-thread-search-insertion",
      fallbackCurrentCanonicalStart,
    );

  const decoded = decodeCorePrimaryLineageV1(input.lineage, input.canonicalMessages);
  if (decoded.status === "error") return failClosed();
  const lineage = decoded.value;
  if (lineage.state !== "complete" || input.injectedMessages.length === 0) return failClosed();
  const previous = lineage.segments.at(-1);
  if (!previous || previous.canonicalEnd !== input.canonicalMessages.length) return failClosed();

  const atom = {
    kind: "synthetic" as const,
    source: AUTO_INJECTED_THREAD_SEARCH_LINEAGE_SOURCE,
    messageDigest: hashCanonicalMessagesV1(input.injectedMessages).hash,
  };
  const cumulativeAtomCount = previous.cumulativeAtomCount + 1;
  const extended = extendCoreLineagePrefixDigestV1(
    previous.cumulativePrefixDigest,
    cumulativeAtomCount,
    atom,
  );
  if (extended.status === "error") return failClosed();
  const candidate = {
    ...lineage,
    segments: [
      ...lineage.segments,
      {
        atoms: [atom],
        canonicalMessages: [...input.injectedMessages],
        canonicalStart: previous.canonicalEnd,
        canonicalEnd: previous.canonicalEnd + input.injectedMessages.length,
        cumulativeAtomCount,
        cumulativePrefixDigest: extended.value,
      },
    ],
  };
  const parsed = decodeCorePrimaryLineageV1(candidate, [
    ...input.canonicalMessages,
    ...input.injectedMessages,
  ]);
  return parsed.status === "ok" && parsed.value.state === "complete" ? parsed.value : failClosed();
}

export function mapCorePrimaryCompactionCurrentCanonicalStart(input: {
  previousCurrentCanonicalStart: number;
  replacement: {
    originalSuffixStart: number;
    replacementSuffixStart: number;
    replacementMessageCount: number;
  };
}): number {
  const retainedOffset =
    input.previousCurrentCanonicalStart - input.replacement.originalSuffixStart;
  if (retainedOffset < 0) return 0;
  return Math.min(
    input.replacement.replacementMessageCount,
    input.replacement.replacementSuffixStart + retainedOffset,
  );
}

function persistedCompleteLineage(lineage: CorePrimaryLineageV1 | undefined): {
  corePrimaryLineage?: CoreLineageManifestV1;
} {
  return lineage?.state === "complete" ? { corePrimaryLineage: lineage } : {};
}

export function resolveCorePrimaryTranscriptProviderState(input: {
  targetFamily: HistoryProviderState["lastFamily"];
  lineage?: CorePrimaryLineageV1;
  transcriptStore?: TranscriptStore;
}): HistoryProviderState {
  const lineage = input.lineage;
  let containsCrossFamilyTurns = lineage?.state !== "complete";
  if (lineage?.state === "complete") {
    for (const segment of lineage.segments) {
      const atom = segment.atoms[0];
      if (!atom) {
        containsCrossFamilyTurns = true;
        continue;
      }
      if (atom.kind === "request") {
        const transcript = input.transcriptStore?.getRequestTranscript?.({
          requestId: atom.requestId,
        });
        const state = transcript?.status === "ok" ? transcript.value?.providerState : undefined;
        if (
          !state ||
          state.lastFamily !== atom.providerFamily ||
          state.containsCrossFamilyTurns !== atom.containsCrossFamilyTurns ||
          state.lastFamily !== input.targetFamily ||
          state.containsCrossFamilyTurns
        ) {
          containsCrossFamilyTurns = true;
        }
        continue;
      }
      if (atom.kind === "checkpoint") {
        const transcript = input.transcriptStore?.getRequestTranscript?.({
          requestId: atom.requestId,
        });
        const state = transcript?.status === "ok" ? transcript.value?.providerState : undefined;
        if (!state || state.lastFamily !== input.targetFamily || state.containsCrossFamilyTurns) {
          containsCrossFamilyTurns = true;
        }
        continue;
      }
      if (
        segment.canonicalMessages.some(
          (message) => message.role === "assistant" || message.role === "tool",
        )
      ) {
        containsCrossFamilyTurns = true;
      }
    }
  }
  return {
    lastFamily: input.targetFamily,
    containsCrossFamilyTurns,
  };
}

class RestartDrainingAbort extends Error {
  constructor() {
    super("server restarting");
    this.name = "RestartDrainingAbort";
  }
}

class PreAgentRunCancelledError extends Error {
  constructor() {
    super("cancelled before agent start");
    this.name = "PreAgentRunCancelledError";
  }
}

const AGENT_TIMEOUT_ABORT_GRACE_MS = 5_000;
const TERMINAL_CLEANUP_SHUTDOWN_WAIT_MS = 4_000;
const LIVE_PARENT_RECONCILE_MS = 1_000;
const SUBAGENT_RESULT_MATERIALIZATION_ATTEMPTS = 3;
export const WORKFLOW_REQUEST_CLAIM_HEARTBEAT_MS = 10_000;

function isCancelControlEntry(entry: Enqueued): boolean {
  return parseRequestControlFromRaw(entry.raw).cancel;
}

function collectBufferedPromptEntriesForActiveRequest(input: {
  queue: readonly Enqueued[];
  activeRequestId: string;
}): Enqueued[] {
  const out: Enqueued[] = [];

  for (const next of input.queue) {
    if (next.queue !== "prompt") continue;
    if (parseBufferedForActiveRequestIdFromRaw(next.raw) !== input.activeRequestId) continue;
    out.push(next);
  }

  return out;
}

function removeQueuedEntriesByReference(queue: Enqueued[], removed: readonly Enqueued[]): number {
  if (removed.length === 0) return 0;
  const targets = new Set(removed);
  const before = queue.length;

  for (let i = 0; i < queue.length; ) {
    if (!targets.has(queue[i]!)) {
      i += 1;
      continue;
    }

    queue.splice(i, 1);
  }

  return before - queue.length;
}

function groupQueueCancellationEntries(entries: readonly Enqueued[]): QueueCancellationGroup[] {
  const groups = new Map<string, QueueCancellationGroup>();
  for (const entry of entries) {
    const existing = groups.get(entry.requestId);
    if (existing) {
      groups.set(entry.requestId, { ...existing, entries: [...existing.entries, entry] });
      continue;
    }
    groups.set(entry.requestId, {
      requestId: entry.requestId,
      requestClient: entry.requestClient,
      entries: [entry],
    });
  }
  return [...groups.values()];
}

async function maybeBuildSkillsSectionForPrimary(): Promise<string | null> {
  const workspaceRoot = findWorkspaceRootResult();
  if (workspaceRoot.status === "error") {
    switch (workspaceRoot.error._tag) {
      case "WorkspaceRootNotFound":
        return null;
    }
  }
  try {
    const { skills } = await discoverSkills({
      workspaceRoot: workspaceRoot.value,
      dataDir: env.dataDir,
    });
    return formatAvailableSkillsSection(skills);
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    // Best-effort: never fail a run due to skill discovery.
    return null;
  }
}

export function buildPersistedHeartbeatMessages(finalText: string): ModelMessage[] {
  return [{ role: "assistant", content: finalText } satisfies ModelMessage];
}

function toolCallIdsFromMessages(messages: readonly ModelMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call") ids.add(part.toolCallId);
    }
  }
  return ids;
}

export function shouldCancelIdleOnlyGlobalRequest(params: {
  runPolicy: RequestRunPolicy;
  sessionId: string;
  states: ReadonlyMap<string, SessionQueue>;
}): boolean {
  if (params.runPolicy !== "idle_only_global") return false;

  for (const [queuedSessionId, state] of params.states) {
    if (!state.running) continue;
    if (queuedSessionId === params.sessionId) return true;
    if (!isHeartbeatSessionId(queuedSessionId)) return true;
  }

  return false;
}

export function shouldCancelRunPolicyRequest(params: {
  runPolicy: RequestRunPolicy;
  sessionId: string;
  states: ReadonlyMap<string, SessionQueue>;
}): boolean {
  if (params.runPolicy === "idle_only_global") {
    return shouldCancelIdleOnlyGlobalRequest(params);
  }

  if (params.runPolicy !== "idle_only_session") return false;

  const state = params.states.get(params.sessionId);
  return Boolean(state?.running);
}

export class AgentRunModelSelectionInvalid extends TaggedError("AgentRunModelSelectionInvalid")<{
  readonly reason: "alias-not-selectable" | "alias-required";
  readonly modelOverride: string;
  readonly message: string;
}> {}

type AgentRunModelResolutionError = AgentRunModelSelectionInvalid | ModelResolutionFailed;

export function resolveAgentRunModelResult(params: {
  cfg: CoreConfig;
  runProfile: AgentRunProfile;
  requestModelOverride?: string;
  reasoningOverride?: ModelReasoningEffort;
  resolvedModelRequest?: DurableResolvedModelRequest;
}): ResultType<ResolvedModelPlan, AgentRunModelResolutionError> {
  const subagentProfileConfig =
    params.runProfile === "primary"
      ? null
      : resolveNativeSubagentProfile(params.cfg, params.runProfile);

  if (params.resolvedModelRequest) {
    const plan = fromDurableResolvedModelPlanResult(params.resolvedModelRequest);
    if (plan.status === "error") return plan;
    return Result.ok(
      params.reasoningOverride
        ? withModelPlanReasoning(plan.value, params.reasoningOverride)
        : plan.value,
    );
  }

  if (params.runProfile !== "primary" && params.requestModelOverride) {
    const selectedPreset = params.cfg.models.def[params.requestModelOverride];
    if (!selectedPreset || params.requestModelOverride.includes("/")) {
      return Result.err(
        new AgentRunModelSelectionInvalid({
          reason: "alias-required",
          modelOverride: params.requestModelOverride,
          message: `Subagent model override must be a models.def alias (got '${params.requestModelOverride}')`,
        }),
      );
    }
    if (selectedPreset.agentCanSelect !== true) {
      return Result.err(
        new AgentRunModelSelectionInvalid({
          reason: "alias-not-selectable",
          modelOverride: params.requestModelOverride,
          message: `Subagent model alias '${params.requestModelOverride}' is not available for agent selection`,
        }),
      );
    }
  }

  const applyHeadReasoning = (head: ResolvedModelRef): ResolvedModelRef => {
    const profileHead = subagentProfileConfig?.reasoning
      ? { ...head, reasoning: subagentProfileConfig.reasoning }
      : head;
    return params.reasoningOverride
      ? { ...profileHead, reasoning: params.reasoningOverride }
      : profileHead;
  };

  if (params.requestModelOverride) {
    const resolved = resolveModelPlanResult(params.cfg, {
      head: { model: params.requestModelOverride },
      fallback: [],
      headSource: "cmd.request.message.modelOverride",
      fallbackSource: "cmd.request.message.modelOverride.fallback",
    });
    if (resolved.status === "error") return resolved;
    const fallbacks = resolveAgentRunModelFallbacksResult(params);
    if (fallbacks.status === "error") return fallbacks;
    return Result.ok({
      head: applyHeadReasoning(resolved.value.head),
      fallbacks: fallbacks.value,
    });
  }

  if (subagentProfileConfig?.model) {
    const resolved = resolveModelPlanResult(params.cfg, {
      head: {
        model: subagentProfileConfig.model,
        reasoning: subagentProfileConfig.reasoning,
        options: subagentProfileConfig.options,
      },
      fallback: [],
      headSource: `agent.subagents.profiles.${params.runProfile}.model`,
      fallbackSource: `agent.subagents.profiles.${params.runProfile}.fallback`,
    });
    if (resolved.status === "error") return resolved;
    const fallbacks = resolveAgentRunModelFallbacksResult(params);
    if (fallbacks.status === "error") return fallbacks;
    return Result.ok({
      head: applyHeadReasoning(resolved.value.head),
      fallbacks: fallbacks.value,
    });
  }

  const slot = subagentProfileConfig?.modelSlot ?? "main";
  const resolved = resolveModelPlanResult(params.cfg, {
    head: params.cfg.models[slot],
    fallback: [],
    headSource: `models.${slot}.model`,
    fallbackSource: `models.${slot}.fallback`,
  });
  if (resolved.status === "error") return resolved;
  const fallbacks = resolveAgentRunModelFallbacksResult(params);
  if (fallbacks.status === "error") return fallbacks;
  return Result.ok({
    head: applyHeadReasoning(resolved.value.head),
    fallbacks: fallbacks.value,
  });
}

export function resolveAgentRunModel(params: {
  cfg: CoreConfig;
  runProfile: AgentRunProfile;
  requestModelOverride?: string;
  reasoningOverride?: ModelReasoningEffort;
  resolvedModelRequest?: DurableResolvedModelRequest;
}): ResolvedModelPlan {
  const resolved = resolveAgentRunModelResult(params);
  if (resolved.status === "error") return signalBusAgentRunnerHostFailure(resolved.error);
  return resolved.value;
}

type AgentRunFallbackSource = {
  entries: readonly ConfiguredModelChainEntry[];
  source: string;
  profileReasoning?: ModelReasoningEffort;
};

function resolveAgentRunFallbackSource(params: {
  cfg: CoreConfig;
  runProfile: AgentRunProfile;
  requestModelOverride?: string;
}): AgentRunFallbackSource | null {
  const profile =
    params.runProfile === "primary"
      ? null
      : resolveNativeSubagentProfile(params.cfg, params.runProfile);

  if (params.requestModelOverride) {
    if (params.requestModelOverride.includes("/")) {
      return { entries: [], source: "cmd.request.message.modelOverride.fallback" };
    }
    const preset = params.cfg.models.def[params.requestModelOverride];
    if (!preset) return null;
    return {
      entries: preset.fallback ?? [],
      source: `models.def.${params.requestModelOverride}.fallback`,
      ...(profile?.reasoning ? { profileReasoning: profile.reasoning } : {}),
    };
  }

  if (profile?.model) {
    if (profile.fallback !== undefined) {
      return {
        entries: profile.fallback,
        source: `agent.subagents.profiles.${params.runProfile}.fallback`,
        ...(profile.reasoning ? { profileReasoning: profile.reasoning } : {}),
      };
    }
    const preset = profile.model.includes("/") ? undefined : params.cfg.models.def[profile.model];
    if (!profile.model.includes("/") && !preset) return null;
    return {
      entries: preset?.fallback ?? [],
      source: `models.def.${profile.model}.fallback`,
      ...(profile.reasoning ? { profileReasoning: profile.reasoning } : {}),
    };
  }

  const slot = profile?.modelSlot ?? "main";
  const slotConfig = params.cfg.models[slot];
  if (profile?.fallback !== undefined) {
    return {
      entries: profile.fallback,
      source: `agent.subagents.profiles.${params.runProfile}.fallback`,
      ...(profile.reasoning ? { profileReasoning: profile.reasoning } : {}),
    };
  }
  if (slotConfig.fallback !== undefined) {
    return {
      entries: slotConfig.fallback,
      source: `models.${slot}.fallback`,
      ...(profile?.reasoning ? { profileReasoning: profile.reasoning } : {}),
    };
  }
  const preset = slotConfig.model.includes("/")
    ? undefined
    : params.cfg.models.def[slotConfig.model];
  if (!slotConfig.model.includes("/") && !preset) return null;
  return {
    entries: preset?.fallback ?? [],
    source: `models.def.${slotConfig.model}.fallback`,
    ...(profile?.reasoning ? { profileReasoning: profile.reasoning } : {}),
  };
}

export function resolveAgentRunModelFallbacksResult(params: {
  cfg: CoreConfig;
  runProfile: AgentRunProfile;
  requestModelOverride?: string;
  reasoningOverride?: ModelReasoningEffort;
}): ResultType<readonly ResolvedModelRef[], ModelResolutionFailed> {
  const fallbackSource = resolveAgentRunFallbackSource(params);
  if (!fallbackSource) return Result.ok([]);
  const resolved = resolveModelChainResult(
    params.cfg,
    fallbackSource.entries,
    fallbackSource.source,
  );
  if (resolved.status === "error") return resolved;
  let fallbacks = resolved.value;
  if (fallbackSource.profileReasoning) {
    fallbacks = fallbacks.map((candidate, index) => {
      const configured = fallbackSource.entries[index];
      return typeof configured === "object" && configured.reasoning !== undefined
        ? candidate
        : { ...candidate, reasoning: fallbackSource.profileReasoning };
    });
  }
  return Result.ok(
    params.reasoningOverride
      ? fallbacks.map((fallback) => ({ ...fallback, reasoning: params.reasoningOverride }))
      : fallbacks,
  );
}

export function resolveAgentRunModelFallbacks(params: {
  cfg: CoreConfig;
  runProfile: AgentRunProfile;
  requestModelOverride?: string;
  reasoningOverride?: ModelReasoningEffort;
}): readonly ResolvedModelRef[] {
  return adaptModelResolutionToBusRunnerHost(resolveAgentRunModelFallbacksResult(params));
}

export function selectNextNativeModelFallback(params: {
  plan: ResolvedModelPlan;
  activeIndex: number;
  onSkipClaudeCode?: (candidate: ResolvedModelRef, index: number) => void;
}): { candidate: ResolvedModelRef; index: number } | null {
  const candidates = [params.plan.head, ...params.plan.fallbacks];
  const current = candidates[params.activeIndex];
  if (!current) return null;
  const latchedFamily = classifyHistoryProviderFamily({ type: params.plan.head.provider });
  if (latchedFamily === "claude-code") return null;

  for (let index = params.activeIndex + 1; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) continue;
    if (classifyHistoryProviderFamily({ type: candidate.provider }) !== latchedFamily) {
      params.onSkipClaudeCode?.(candidate, index);
      continue;
    }
    return { candidate, index };
  }
  return null;
}

export class WorkflowDispatchPolicyMismatch extends TaggedError("WorkflowDispatchPolicyMismatch")<{
  readonly field: "profile" | "reasoning";
  readonly message: string;
}> {}

export function assertWorkflowDispatchPolicy(
  workflowPolicy: WorkflowRequestPolicy,
  subagentMeta: ParsedSubagentMeta,
): ResultType<void, WorkflowDispatchPolicyMismatch> {
  if (workflowPolicy.profile !== subagentMeta.profile) {
    return Result.err(
      new WorkflowDispatchPolicyMismatch({
        field: "profile",
        message: "Workflow request profile envelope does not match the runner profile",
      }),
    );
  }
  if ((workflowPolicy.reasoning ?? null) !== (subagentMeta.reasoning ?? null)) {
    return Result.err(
      new WorkflowDispatchPolicyMismatch({
        field: "reasoning",
        message: "Workflow request reasoning does not match the approved operation policy",
      }),
    );
  }
  return Result.ok(undefined);
}

type Level1ToolAuthorityTarget = Pick<AiSdkPiAgent<ToolSet>, "setTools" | "setActiveTools">;

export function selectedLevel1ToolNames(
  toolset: BuiltLevel1Toolset,
  selectedCatalogIds: readonly string[],
): ReadonlySet<string> {
  const selected = new Set(selectedCatalogIds);
  const active = new Set(toolset.directToolNames);
  for (const entry of toolset.catalog) {
    if (selected.has(entry.stableId)) active.add(entry.modelName);
  }
  return active;
}

export async function refreshSelectedLevel1Tools(params: {
  target: Pick<Level1ToolAuthorityTarget, "setActiveTools">;
  toolset: BuiltLevel1Toolset;
  listSelectedCatalogIds: () => readonly string[];
}): Promise<BuiltLevel1Toolset> {
  const toolset = params.toolset;
  const activeToolNames = selectedLevel1ToolNames(toolset, params.listSelectedCatalogIds());
  toolset.updateActiveBatchTools(activeToolNames);
  params.target.setActiveTools(activeToolNames);
  return toolset;
}

export function applyCompleteLevel1Tools(
  target: Level1ToolAuthorityTarget,
  toolset: BuiltLevel1Toolset,
): void {
  toolset.updateActiveBatchTools(new Set(Object.keys(toolset.tools)));
  target.setTools(toolset.tools);
  target.setActiveTools(new Set(Object.keys(toolset.tools)));
}

export function completeLevel1ToolMapping(toolset: BuiltLevel1Toolset): {
  tools: ToolSet;
  catalogMetadata: BuiltLevel1Toolset["catalogMetadata"];
} {
  toolset.updateActiveBatchTools(new Set(Object.keys(toolset.tools)));
  return {
    tools: toolset.tools,
    catalogMetadata: toolset.catalogMetadata,
  };
}

type SessionQueue = {
  running: boolean;
  agent: AiSdkPiAgent<ToolSet> | null;
  queue: Enqueued[];
  activeRequestId: string | null;
  activeRun: {
    requestId: string;
    sessionId: string;
    requestClient: AdapterPlatform;
    runProfile: AgentRunProfile;
    queue: RequestQueueMode;
    runPolicy: RequestRunPolicy;
    origin?: RequestOrigin;
    messages: ModelMessage[];
    corePrimaryLineage?: CorePrimaryLineageV1;
    modelOverride?: string;
    currentTurnUserId?: string;
    raw?: AgentRunnerRaw;
    resolvedModelSpec: string | null;
    resolvedReasoning: ModelReasoningEffort | undefined;
    resolvedProviderFamily: HistoryProviderState["lastFamily"] | null;
    partialText: string;
    liveParent: ReturnType<WorkflowLiveParentBridge["registerParent"]> | undefined;
    claudeCodeControl: ClaudeCodeRunControl | null;
    notifyWaiters: () => void;
    flushOutput: () => void;
    setCurrentTurnUserId: (userId: string | undefined) => void;
    cancel: () => void;
    started: boolean;
    startedAt: number;
    activeTools: Map<string, { toolName: string; startedAt: number }>;
  } | null;
  /** Track toolCallIds whose outputs are compacted in the model-facing view. */
  compactedToolCallIds: Set<string>;
};

export function isActiveRuntimeModelCompatible(input: {
  readonly activeSpec: string;
  readonly activeReasoning: ModelReasoningEffort | undefined;
  readonly activeFamily: HistoryProviderState["lastFamily"];
  readonly requested: ResolvedModelRef;
}): boolean {
  return (
    input.activeSpec === input.requested.spec &&
    input.activeReasoning === input.requested.reasoning &&
    input.activeFamily === classifyHistoryProviderFamily({ type: input.requested.provider })
  );
}

export function shouldQueueIncompatibleActiveRuntimeModel(input: {
  readonly activeSpec: string;
  readonly activeReasoning: ModelReasoningEffort | undefined;
  readonly activeFamily: HistoryProviderState["lastFamily"];
  readonly requested: ResolvedModelRef;
}): boolean {
  return !isActiveRuntimeModelCompatible(input);
}

export function deriveModelChangingRequestId(input: {
  readonly requestId: string;
  readonly authenticatedOrigin?: AuthenticatedSurfaceOrigin;
}): string {
  const messageRef = input.authenticatedOrigin?.messageRef;
  if (messageRef) {
    return `${messageRef.platform}:${messageRef.channelId}:${messageRef.messageId}`;
  }
  return `${input.requestId}:model-turn:${crypto.randomUUID()}`;
}

function projectDurableWorkflowRequestIdentity(input: {
  readonly projection: AuthenticatedRequestProjection;
  readonly raw: AgentRunnerRaw | undefined;
  readonly store?: DurableWorkflowStore;
}): AuthenticatedRequestProjection {
  if (input.projection.requestClient !== "unknown" || !input.store) return input.projection;
  const hint = parseWorkflowRequestHintFromRaw(input.raw);
  if (!hint) return input.projection;
  const authorized = input.store.authorizeWorkflowRequest({
    requestId: input.projection.requestId,
    sessionId: input.projection.sessionId,
    platform: input.projection.requestClient,
  });
  if (
    !authorized ||
    authorized.policy.runId !== hint.runId ||
    authorized.policy.operationId !== hint.operationId ||
    authorized.policy.dispatchEpoch !== hint.dispatchEpoch
  ) {
    return input.projection;
  }
  const origin = authorized.policy.originSession;
  const authenticatedOrigin = projectAuthorizedWorkflowOrigin(origin);
  return {
    ...input.projection,
    source: "internal-delegated",
    ...(authenticatedOrigin ? { authenticatedOrigin } : {}),
    authenticationMetadataKind: authenticatedOrigin ? "origin" : "absent",
    verifiedIngress: false,
  };
}

function projectAuthorizedWorkflowOrigin(origin: {
  readonly client: AdapterPlatform | null;
  readonly sessionId: string | null;
  readonly userId: string | null;
}): AuthenticatedSurfaceOrigin | undefined {
  if (!origin.client || !origin.sessionId || !origin.userId) return undefined;
  const protocol = getBuiltinSurfaceProtocol(origin.client);
  if (!protocol) return undefined;
  return {
    platform: protocol.platform,
    userId: origin.userId,
    sessionRef: protocol.refs.createSessionRef(origin.sessionId),
  } as AuthenticatedSurfaceOrigin;
}

export type AgentRunnerActiveWork = {
  requestId: string;
  requestClient: AdapterPlatform;
  runProfile: AgentRunProfile;
  phase: "preparing" | "model" | "tool";
  runAgeMs: number;
  tools: readonly {
    toolCallId: string;
    toolName: string;
    ageMs: number;
  }[];
};

export function formatClaudeLifecycleLogFields(
  event: string,
  detail: Readonly<Record<string, string | number | boolean | null | undefined>>,
  error?: AnyTaggedError,
): Readonly<Record<string, string | number | boolean | null | undefined>> {
  const context = formatBridgeLogContext({ lifecycle: event, ...detail });
  return error ? formatBridgeTaggedErrorForLog(error, context) : context;
}

export function formatBusAgentRunnerDrainFailureForLog(
  error: unknown,
  context: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | number | boolean | null | undefined>> {
  return formatBridgeTaggedErrorForLog(error, context, {
    errorTag: "BusAgentRunnerDrainFailed",
    errorMessage: "Agent runner session queue drain failed",
  });
}

export async function startBusAgentRunner(params: {
  bus: LilacBus;
  subscriptionId: string;
  config?: CoreConfig;
  pluginManager: CoreToolPluginManager;
  customCommands?: CustomCommandManager;
  conversationThreads?: ConversationThreadToolService;
  /** Where core tools operate (fs tool root). */
  cwd?: string;
  transcriptStore?: TranscriptStore;
  toolResultArtifacts?: ToolResultArtifactStore;
  workflowLiveParentBridge?: WorkflowLiveParentBridge;
  workflowSubagentDispatcher?: WorkflowSubagentDispatcher;
  durableWorkflowStore?: DurableWorkflowStore;
  projectAuthenticatedRequest?: (
    message: Extract<
      DecodedLilacMessageForTopic<"cmd.request">,
      { type: typeof lilacEventTypes.CmdRequestMessage }
    >,
  ) => ResultType<
    AuthenticatedRequestProjection | undefined,
    AuthenticatedRequestProjectionInvalid
  >;
  requestMessageCache?: RequestMessageCache;
  surfaceProtocolResolver?: SurfaceProtocolResolver;
  startPaused?: boolean;
  beforeRequestIntake?: (
    message: DecodedLilacMessageForTopic<"cmd.request">,
  ) => void | Promise<void>;
  resolveParentChannelId?: (sessionId: string) => string | null | undefined;
  issueControlCapability?: (input: {
    requestId: string;
    sessionId: string;
    requestClient: AdapterPlatform;
    profile: AgentRunProfile;
    canonicalCwd: string;
    safetyMode: SessionSafetyMode;
    expiresAt: number;
    authenticatedOrigin?: AuthenticatedSurfaceOrigin;
    verifiedIngress?: boolean;
  }) =>
    | {
        capability: string;
        principal: SurfacePrincipal | null;
        authenticatedOrigin?: AuthenticatedSurfaceOrigin | null;
        safetyMode?: SessionSafetyMode;
      }
    | Promise<{
        capability: string;
        principal: SurfacePrincipal | null;
        authenticatedOrigin?: AuthenticatedSurfaceOrigin | null;
        safetyMode?: SessionSafetyMode;
      }>;
  issueHeartbeatCapability?: (input: {
    requestId: string;
    sessionId: string;
    requestClient: AdapterPlatform;
    canonicalCwd: string;
    expiresAt: number;
  }) => string | Promise<string>;
  expireControlCapability?: (requestId: string) => void;
  /** Injection seam for exercising the complete bus runner with deterministic model transports. */
  createAgent?: (options: AiSdkPiAgentOptions<ToolSet>) => AiSdkPiAgent<ToolSet>;
  /** Injection seam for deterministic Claude native lifecycle/observation coverage. */
  materializeClaudeCodeRun?: typeof materializeClaudeCodeRun;
  reportFatalPanic: (panic: Panic) => void;
}) {
  const { bus, subscriptionId } = params;

  const logger = createLogger({
    module: "bus-agent-runner",
  });

  let cfg = params.config ?? (await getCoreConfig());
  let coreConfigReloadHadError = false;
  let lastCoreConfigReloadError: string | null = null;

  async function reloadCoreConfigIfNeeded(): Promise<void> {
    if (params.config) return;

    const loaded = await captureBusAgentRunnerOperation("core config reload", getCoreConfig);
    if (loaded.status === "error") {
      const message = loaded.error.message;
      if (!coreConfigReloadHadError || lastCoreConfigReloadError !== message) {
        logger.warn(
          "core-config reload failed; using last known config",
          formatBridgeTaggedErrorForLog(loaded.error, { path: "core-config.yaml" }),
        );
      }
      coreConfigReloadHadError = true;
      lastCoreConfigReloadError = message;
      return;
    }

    cfg = loaded.value;
    if (coreConfigReloadHadError) {
      logger.info("core-config reload recovered", {
        path: "core-config.yaml",
      });
    }
    coreConfigReloadHadError = false;
    lastCoreConfigReloadError = null;
  }
  const cwd = params.cwd ?? process.env.LILAC_WORKSPACE_DIR ?? process.cwd();
  const workflowRunnerOwnerId = `agent-runner:${process.pid}:${crypto.randomUUID()}`;

  const bySession = new Map<string, SessionQueue>();
  const cancelledByRequestId = new Set<string>();
  const reservedQueueEntries = new Set<Enqueued>();
  const queueLifecycleAttempts = new Map<string, QueueLifecycleAttempt>();
  const restartAbortRequestIds = new Set<string>();
  const forcedRecoveryByRequestId = new Map<string, AgentRunnerRecoveryEntry>();
  const requestMessageCache = params.requestMessageCache ?? createRequestMessageCache();
  let draining = false;
  let terminalPanic: Panic | null = null;
  let terminalPanicReported = false;
  let activeDrainOperation: Promise<void> | null = null;
  let terminalCleanupOperations: readonly BusAgentRunnerTerminalCleanupOperation[] = [];
  let terminalCleanupCompletion: Promise<void> | null = null;
  let runnerActivated = params.startPaused !== true;
  let runnerAdmissionStopped = false;
  let resolveRunnerAdmission: ((outcome: "active" | "stopped") => void) | null = null;
  const runnerActivation = runnerActivated
    ? Promise.resolve("active" as const)
    : new Promise<"active" | "stopped">((resolve) => {
        resolveRunnerAdmission = resolve;
      });
  const activateRunnerAdmission = (): void => {
    if (runnerActivated || runnerAdmissionStopped) return;
    runnerActivated = true;
    resolveRunnerAdmission?.("active");
    resolveRunnerAdmission = null;
  };
  const stopRunnerAdmission = (): void => {
    if (runnerActivated || runnerAdmissionStopped) return;
    runnerAdmissionStopped = true;
    resolveRunnerAdmission?.("stopped");
    resolveRunnerAdmission = null;
  };
  const reportFatalPanic = (panic: Panic): void => {
    terminalPanic ??= panic;
    if (terminalPanicReported) return;
    terminalPanicReported = true;
    params.reportFatalPanic(panic);
  };

  async function resumeQueueLifecycleAttempt(
    attempt: QueueLifecycleAttempt,
    state: SessionQueue,
  ): Promise<void> {
    if (attempt.kind === "buffered-absorption" && !attempt.controlApplied) {
      return signalBusAgentRunnerHostFailure(
        new Error("Buffered absorption publication resumed before control application"),
      );
    }
    while (attempt.pendingGroups.length > 0) {
      const group = attempt.pendingGroups[0]!;
      await publishLifecycle({
        bus,
        headers: {
          request_id: group.requestId,
          session_id: attempt.sessionId,
          request_client: group.requestClient,
        },
        state: "cancelled",
        detail: attempt.detail,
      });
      removeQueuedEntriesByReference(state.queue, group.entries);
      for (const queued of group.entries) {
        reservedQueueEntries.delete(queued);
        if (queued.identityOwner) requestMessageCache.releaseOwner(queued.identityOwner);
      }
      attempt.pendingGroups.shift();
    }
    queueLifecycleAttempts.delete(attempt.eventId);
    if (!state.running) startSessionQueueDrain(attempt.sessionId, state);
  }

  function abandonQueueLifecycleAttempt(eventId: string): void {
    const attempt = queueLifecycleAttempts.get(eventId);
    if (!attempt) return;
    for (const group of attempt.pendingGroups) {
      for (const queued of group.entries) reservedQueueEntries.delete(queued);
    }
    queueLifecycleAttempts.delete(eventId);
    const state = bySession.get(attempt.sessionId);
    if (state && !state.running) startSessionQueueDrain(attempt.sessionId, state);
  }

  function startSessionQueueDrain(
    sessionId: string,
    state: SessionQueue,
    requestId?: string,
  ): void {
    const superviseDetachedDrain = (error: unknown): void => {
      rethrowBusAgentRunnerPanic(error, reportFatalPanic);
      logger.error(
        "drainSessionQueue failed",
        formatBusAgentRunnerDrainFailureForLog(error, { sessionId, requestId }),
      );
    };
    const observeSupervisedDrainRejection = (): void => undefined;
    const operation = drainSessionQueue(sessionId, state).catch(superviseDetachedDrain);
    activeDrainOperation = operation;
    void operation.catch(observeSupervisedDrainRejection);
  }

  type CmdRequestMessage = Extract<
    DecodedLilacMessageForTopic<"cmd.request">,
    { type: typeof lilacEventTypes.CmdRequestMessage }
  >;

  async function handleCmdRequestMessage(
    msg: CmdRequestMessage,
  ): Promise<ResultType<void, BusAgentRunnerDeliveryError>> {
    if ((await runnerActivation) === "stopped") {
      return Result.err(
        new BusAgentRunnerRecoveryStopped({
          message: "Paused agent recovery stopped before delivery activation",
        }),
      );
    }
    const requestId = msg.headers?.request_id;
    const sessionId = msg.headers?.session_id;
    const requestClient = msg.headers?.request_client ?? "unknown";
    const pendingAttempt = queueLifecycleAttempts.get(msg.id);
    if (
      pendingAttempt &&
      (requestId !== pendingAttempt.controlRequestId ||
        sessionId !== pendingAttempt.sessionId ||
        requestClient !== pendingAttempt.controlRequestClient)
    ) {
      return Result.err(
        new BusAgentRunnerQueueAttemptRouteInvalid({
          eventId: msg.id,
          message: "Redelivered queue control route conflicts with persisted delivery ownership",
        }),
      );
    }
    if (!requestId || !sessionId) {
      if (!pendingAttempt) abandonQueueLifecycleAttempt(msg.id);
      const missing: ("request_id" | "session_id")[] = [];
      if (!requestId) missing.push("request_id");
      if (!sessionId) missing.push("session_id");
      return Result.err(
        new BusAgentRunnerRequestHeadersInvalid({
          missing,
          message: "cmd.request.message missing required request/session headers",
        }),
      );
    }

    const projectedRequest = (params.projectAuthenticatedRequest ?? projectAuthenticatedRequest)(
      msg,
    );
    if (projectedRequest.status === "error") {
      if (!pendingAttempt) abandonQueueLifecycleAttempt(msg.id);
      return Result.err(
        new BusAgentRunnerAuthenticationProjectionInvalid({
          cause: projectedRequest.error,
          message: "cmd.request.message authentication projection is invalid",
        }),
      );
    }
    if (!projectedRequest.value) {
      if (!pendingAttempt) abandonQueueLifecycleAttempt(msg.id);
      return Result.ok(undefined);
    }
    const raw = preserveAgentRunnerRaw(msg.data.raw);
    let cacheAdmitted = false;
    let identityError:
      | RequestIdentitySourceMissing
      | RequestIdentityAliasTargetOccupied
      | AuthenticatedRequestProjectionInvalid
      | undefined;
    let intakeError: BusAgentRunnerOperationFailed | undefined;
    let parkPending = false;
    try {
      const cachedExternal = requestMessageCache.cacheMessage(msg, projectedRequest.value);
      if (cachedExternal.status === "error") {
        return Result.err(
          new BusAgentRunnerAuthenticationProjectionInvalid({
            cause: cachedExternal.error,
            message: "cmd.request.message cache admission is invalid",
          }),
        );
      }
      if (!cachedExternal.value) return Result.ok(undefined);
      cacheAdmitted = true;
      const trustedProjection = projectDurableWorkflowRequestIdentity({
        projection: projectedRequest.value,
        raw,
        store: params.durableWorkflowStore,
      });
      const cachedTrusted = requestMessageCache.cacheMessage(msg, trustedProjection);
      if (cachedTrusted.status === "error") {
        return Result.err(
          new BusAgentRunnerAuthenticationProjectionInvalid({
            cause: cachedTrusted.error,
            message: "cmd.request.message trusted cache admission is invalid",
          }),
        );
      }
      const authenticatedRequest = cachedTrusted.value ?? cachedExternal.value;
      await (async () => {
        rethrowBusAgentRunnerPanic(terminalPanic);
        await params.beforeRequestIntake?.(msg);

        if (env.perf.log) {
          const lagMs = Date.now() - msg.ts;
          const shouldWarn = lagMs >= env.perf.lagWarnMs;
          const shouldSample = env.perf.sampleRate > 0 && Math.random() < env.perf.sampleRate;
          if (shouldWarn || shouldSample) {
            if (shouldWarn) {
              logger.warn("perf.bus_lag", {
                stage: "cmd.request->agent_runner",
                lagMs,
                requestId,
                sessionId,
                requestClient,
                queue: msg.data.queue,
              });
            } else {
              logger.info("perf.bus_lag", {
                stage: "cmd.request->agent_runner",
                lagMs,
                requestId,
                sessionId,
                requestClient,
                queue: msg.data.queue,
              });
            }
          }
        }

        logger.debug("cmd.request.message received", {
          requestId,
          sessionId,
          requestClient,
          queue: msg.data.queue,
          runPolicy: msg.data.runPolicy ?? "normal",
          originKind: msg.data.origin?.kind,
          modelOverride: msg.data.modelOverride,
          messageCount: msg.data.messages.length,
        });

        // reload config opportunistically (mtime cached in getCoreConfig).
        // If reload fails, keep using the last known good config.
        await reloadCoreConfigIfNeeded();

        const intakeRunProfile = parseSubagentMetaFromRaw(raw).profile;
        const entry: Enqueued = {
          queueEntryId: msg.id,
          requestId,
          sessionId,
          requestClient,
          queue: msg.data.queue,
          runPolicy: msg.data.runPolicy ?? "normal",
          origin: msg.data.origin,
          messages: msg.data.messages,
          corePrimaryLineage: validateCorePrimaryLineageAtRunnerIntake({
            requestClient,
            sessionId,
            runProfile: intakeRunProfile,
            messages: msg.data.messages,
            corePrimaryLineage: msg.data.corePrimaryLineage,
            transcriptStore: params.transcriptStore,
          }),
          modelOverride: msg.data.modelOverride,
          raw,
          authenticatedOrigin: authenticatedRequest?.authenticatedOrigin,
          currentTurnUserId: trustedProjection.authenticatedOrigin?.userId,
          verifiedIngress: authenticatedRequest?.verifiedIngress,
        };

        const requestControl = parseRequestControlFromRaw(entry.raw);

        const state =
          bySession.get(sessionId) ??
          ({
            running: false,
            agent: null,
            queue: [] as Enqueued[],
            activeRequestId: null,
            activeRun: null,
            compactedToolCallIds: new Set<string>(),
          } satisfies SessionQueue);
        bySession.set(sessionId, state);

        const logQueueTransition = (input: {
          action: string;
          queueDepthBefore: number;
          queueDepthAfter: number;
          reason?: string;
          activeRequestId?: string | null;
        }) => {
          logger.debug("agent.queue.transition", {
            requestId,
            sessionId,
            requestClient,
            queueMode: entry.queue,
            running: state.running,
            queueDepthBefore: input.queueDepthBefore,
            queueDepthAfter: input.queueDepthAfter,
            action: input.action,
            reason: input.reason,
            activeRequestId: input.activeRequestId ?? state.activeRequestId,
            draining,
          });
        };
        const logQueuedBehindActiveRun = (queuedRequestId: string) => {
          logger.info("request queued behind active run", {
            requestId: queuedRequestId,
            activeRequestId: state.activeRequestId,
            queueDepth: state.queue.length,
          });
        };

        if (pendingAttempt) {
          await resumeQueueLifecycleAttempt(pendingAttempt, state);
          return;
        }
        const enqueueWithLifecycle = async (
          queuedEntry: Enqueued,
          detail: string,
        ): Promise<ResultType<void, BusAgentRunnerOperationFailed>> => {
          state.queue.push(queuedEntry);
          const published = await captureBusAgentRunnerOperation(
            "queued lifecycle publication",
            () =>
              publishLifecycle({
                bus,
                headers: {
                  request_id: queuedEntry.requestId,
                  session_id: sessionId,
                  request_client: queuedEntry.requestClient,
                },
                state: "queued",
                detail,
              }),
          );
          if (published.status === "error") {
            removeQueuedEntriesByReference(state.queue, [queuedEntry]);
            if (queuedEntry.identityOwner) {
              requestMessageCache.releaseOwner(queuedEntry.identityOwner);
            }
            return Result.err(published.error);
          }
          return Result.ok(undefined);
        };

        if (
          !requestControl.cancel &&
          shouldCancelRunPolicyRequest({ runPolicy: entry.runPolicy, sessionId, states: bySession })
        ) {
          await publishLifecycle({
            bus,
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: requestClient,
            },
            state: "cancelled",
            detail:
              entry.runPolicy === "idle_only_session"
                ? "idle_only_session_busy"
                : "idle_only_global_busy",
          });
          logQueueTransition({
            action: "drop",
            queueDepthBefore: state.queue.length,
            queueDepthAfter: state.queue.length,
            reason:
              entry.runPolicy === "idle_only_session"
                ? "idle_only_session_busy"
                : "idle_only_global_busy",
          });
          return;
        }

        if (draining) {
          logger.debug("dropping request message while draining", {
            requestId,
            sessionId,
            queue: msg.data.queue,
          });
          logQueueTransition({
            action: "drop",
            queueDepthBefore: state.queue.length,
            queueDepthAfter: state.queue.length,
            reason: "draining",
          });
          return;
        }

        const dropCancelNoTarget = async (reason: string) => {
          logger.debug("dropping cancel request with no target", {
            requestId,
            sessionId,
            queue: entry.queue,
            activeRequestId: state.activeRequestId,
            reason,
          });
          logQueueTransition({
            action: "drop",
            queueDepthBefore: state.queue.length,
            queueDepthAfter: state.queue.length,
            reason,
          });
        };

        if (requestControl.cancel && requestControl.cancelQueued) {
          const matchedEntries: Enqueued[] = [];

          for (const queued of state.queue) {
            if (queued.requestId === requestId && !reservedQueueEntries.has(queued)) {
              matchedEntries.push(queued);
            }
          }

          const targetMessageId = requestControl.targetMessageId;
          if (targetMessageId) {
            for (const queued of state.queue) {
              if (
                !matchedEntries.includes(queued) &&
                !reservedQueueEntries.has(queued) &&
                requestRawReferencesMessage(queued.raw, targetMessageId)
              ) {
                matchedEntries.push(queued);
              }
            }
          }

          if (matchedEntries.length > 0) {
            for (const queued of matchedEntries) reservedQueueEntries.add(queued);
            const attempt: QueueLifecycleAttempt = {
              eventId: msg.id,
              controlRequestId: requestId,
              controlRequestClient: requestClient,
              sessionId,
              kind: "queued-cancellation",
              detail: "cancelled while queued",
              pendingGroups: groupQueueCancellationEntries(matchedEntries),
              controlApplied: true,
            };
            queueLifecycleAttempts.set(msg.id, attempt);
            await resumeQueueLifecycleAttempt(attempt, state);

            logger.debug("queued request cancelled", {
              requestId,
              sessionId,
              cancelledRequestIds: [...new Set(matchedEntries.map((queued) => queued.requestId))],
              queueDepth: state.queue.length,
            });
            logQueueTransition({
              action: "cancel_queued",
              queueDepthBefore: state.queue.length + matchedEntries.length,
              queueDepthAfter: state.queue.length,
              reason: "cancel_queued",
            });

            return;
          }

          const targetMessageIdForActive = requestControl.targetMessageId;
          const targetMatchesActive =
            typeof targetMessageIdForActive === "string" &&
            requestRawReferencesMessage(state.activeRun?.raw, targetMessageIdForActive);

          if (
            !state.running ||
            !state.activeRequestId ||
            (!state.agent && !state.activeRun?.cancel)
          ) {
            await dropCancelNoTarget("request not queued or active");
            return;
          }

          if (state.activeRequestId === requestId || targetMatchesActive) {
            const activeCancelEntry: Enqueued = {
              ...entry,
              requestId: state.activeRequestId,
              requestClient: state.activeRun?.requestClient ?? entry.requestClient,
            };
            if (state.activeRun?.started === false) {
              state.activeRun.cancel();
            } else if (state.agent) {
              await applyToRunningAgent(
                state.agent,
                activeCancelEntry,
                cancelledByRequestId,
                state.activeRun,
              );
            }
            logQueueTransition({
              action: "apply_to_active",
              queueDepthBefore: state.queue.length,
              queueDepthAfter: state.queue.length,
              reason: targetMatchesActive
                ? "cancel_active_by_message_id"
                : "cancel_active_by_request_id",
            });
            return;
          }

          await dropCancelNoTarget("request not queued or active");
          return;
        }

        if (!state.running) {
          if (requestControl.cancel) {
            await dropCancelNoTarget("request not active");
            return;
          }

          // Some messages only make sense when a run is already active.
          if (requestControl.requiresActive && entry.queue !== "prompt") {
            logger.debug("dropping request message (requires active run)", {
              requestId,
              sessionId,
              queue: entry.queue,
            });
            logQueueTransition({
              action: "drop",
              queueDepthBefore: state.queue.length,
              queueDepthAfter: state.queue.length,
              reason: "requires_active_without_run",
            });
            return;
          }

          const queueDepthBefore = state.queue.length;
          const owner = requestMessageCache.acquireOwner(requestId);
          if (owner.status === "error") {
            identityError = owner.error;
            return;
          }
          entry.identityOwner = owner.value;
          state.queue.push(entry);
          logQueueTransition({
            action: "enqueue",
            queueDepthBefore,
            queueDepthAfter: state.queue.length,
            reason: "start_when_idle",
          });
          startSessionQueueDrain(sessionId, state, requestId);
        } else {
          if (
            state.activeRequestId === requestId &&
            requestControl.cancel &&
            state.activeRun?.started === false &&
            state.activeRun?.cancel
          ) {
            state.activeRun.cancel();
            logQueueTransition({
              action: "apply_to_active",
              queueDepthBefore: state.queue.length,
              queueDepthAfter: state.queue.length,
              reason: "cancel_active_before_agent_start",
            });
            return;
          }

          if (
            state.activeRequestId === requestId &&
            !requestControl.cancel &&
            state.activeRun?.runProfile === "primary"
          ) {
            const activeRun = state.activeRun;
            const incomingOverride =
              entry.modelOverride ?? parseRequestModelOverrideFromRaw(entry.raw) ?? undefined;
            let incompatible =
              activeRun.resolvedModelSpec === null &&
              incomingOverride !== undefined &&
              incomingOverride !== activeRun.modelOverride;
            if (
              incomingOverride !== undefined &&
              activeRun.resolvedModelSpec !== null &&
              activeRun.resolvedProviderFamily !== null
            ) {
              const requestedPlan = resolveAgentRunModelResult({
                cfg,
                runProfile: "primary",
                requestModelOverride: incomingOverride,
              });
              if (requestedPlan.status === "error") {
                incompatible = true;
              } else {
                incompatible = shouldQueueIncompatibleActiveRuntimeModel({
                  activeSpec: activeRun.resolvedModelSpec,
                  activeReasoning: activeRun.resolvedReasoning,
                  activeFamily: activeRun.resolvedProviderFamily,
                  requested: requestedPlan.value.head,
                });
              }
            }
            if (incompatible) {
              const aliasRequestId = deriveModelChangingRequestId(entry);
              const aliased = requestMessageCache.createAliasOwner({
                sourceRequestId: requestId,
                aliasRequestId,
                requestClient,
                sessionId,
              });
              if (aliased.status === "error") {
                identityError = aliased.error;
                return;
              }
              const aliasProjection = aliased.value.projection;
              const queuedEntry: Enqueued = {
                ...entry,
                requestId: aliasProjection.requestId,
                sessionId: aliasProjection.sessionId,
                requestClient: aliasProjection.requestClient,
                queue: "prompt",
                authenticatedOrigin: aliasProjection.authenticatedOrigin,
                verifiedIngress: aliasProjection.verifiedIngress,
                identityOwner: {
                  requestId: aliased.value.requestId,
                  ownerId: aliased.value.ownerId,
                },
              };
              const queueDepthBefore = state.queue.length;
              const enqueued = await enqueueWithLifecycle(
                queuedEntry,
                "queued for incompatible model or reasoning selection",
              );
              if (enqueued.status === "error") {
                intakeError = enqueued.error;
                return;
              }
              logQueueTransition({
                action: "enqueue",
                queueDepthBefore,
                queueDepthAfter: state.queue.length,
                reason: "incompatible_active_model",
              });
              logQueuedBehindActiveRun(queuedEntry.requestId);
              return;
            }
          }

          // If the message is intended for the currently active request, apply immediately.
          if (state.activeRequestId && state.activeRequestId === requestId && state.agent) {
            const runningAgent = state.agent;
            const queueDepthBefore = state.queue.length;
            const shouldAbsorbBufferedPrompts =
              (entry.queue === "steer" || entry.queue === "interrupt") &&
              !isCancelControlEntry(entry);

            const bufferedPrompts = shouldAbsorbBufferedPrompts
              ? collectBufferedPromptEntriesForActiveRequest({
                  queue: state.queue,
                  activeRequestId: requestId,
                }).filter((queued) => !reservedQueueEntries.has(queued))
              : [];

            const mergedEntry =
              bufferedPrompts.length > 0
                ? ({
                    ...entry,
                    messages: [
                      ...bufferedPrompts.flatMap((queuedPrompt) => queuedPrompt.messages),
                      ...entry.messages,
                    ],
                    corePrimaryLineage: degradeCorePrimaryLineageForMutation(
                      "queued-buffer-absorbed-into-steering",
                      runningAgent.state.messages.length,
                    ),
                  } satisfies Enqueued)
                : entry;

            if (bufferedPrompts.length > 0) {
              const absorbMode: "steer" | "interrupt" =
                entry.queue === "interrupt" ? "interrupt" : "steer";
              for (const bufferedPrompt of bufferedPrompts) {
                reservedQueueEntries.add(bufferedPrompt);
              }
              const attempt: QueueLifecycleAttempt = {
                eventId: msg.id,
                controlRequestId: requestId,
                controlRequestClient: requestClient,
                sessionId,
                kind: "buffered-absorption",
                detail:
                  absorbMode === "interrupt"
                    ? "cancelled: absorbed into active interrupt"
                    : "cancelled: absorbed into active steer",
                pendingGroups: groupQueueCancellationEntries(bufferedPrompts),
                controlApplied: false,
              };
              queueLifecycleAttempts.set(msg.id, attempt);
              const applied = await captureBusAgentRunnerOperation(
                "buffered prompt control application",
                () =>
                  applyToRunningAgent(
                    runningAgent,
                    mergedEntry,
                    cancelledByRequestId,
                    state.activeRun,
                  ),
              );
              if (applied.status === "error") {
                for (const bufferedPrompt of bufferedPrompts) {
                  reservedQueueEntries.delete(bufferedPrompt);
                }
                queueLifecycleAttempts.delete(msg.id);
                signalBusAgentRunnerHostFailure(applied.error);
              }
              attempt.controlApplied = true;
              await resumeQueueLifecycleAttempt(attempt, state);
            } else {
              await applyToRunningAgent(
                runningAgent,
                mergedEntry,
                cancelledByRequestId,
                state.activeRun,
              );
            }

            logQueueTransition({
              action: "apply_to_active",
              queueDepthBefore,
              queueDepthAfter: state.queue.length,
              reason:
                bufferedPrompts.length > 0
                  ? `same_request_id_absorbed_${bufferedPrompts.length}`
                  : "same_request_id",
            });
          } else {
            // Prevent stale surface controls (e.g. Cancel button) from enqueueing behind
            // an unrelated active request.
            if (requestControl.requiresActive || requestControl.cancel) {
              logger.debug("dropping request message (requires active request id)", {
                requestId,
                sessionId,
                activeRequestId: state.activeRequestId,
                queue: entry.queue,
              });
              logQueueTransition({
                action: "drop",
                queueDepthBefore: state.queue.length,
                queueDepthAfter: state.queue.length,
                reason: "requires_active_different_request_id",
              });
              return;
            }

            // No parallel runs: queue prompt messages for later.
            const queueDepthBefore = state.queue.length;
            const owner = requestMessageCache.acquireOwner(requestId);
            if (owner.status === "error") {
              identityError = owner.error;
              return;
            }
            entry.identityOwner = owner.value;
            const enqueued = await enqueueWithLifecycle(entry, "queued behind active request");
            if (enqueued.status === "error") {
              intakeError = enqueued.error;
              return;
            }

            logQueuedBehindActiveRun(requestId);
            logQueueTransition({
              action: "enqueue",
              queueDepthBefore,
              queueDepthAfter: state.queue.length,
              reason: "queued_behind_active",
            });
          }
        }
      })();
      if (intakeError) {
        parkPending = true;
        return Result.err(
          new BusAgentRunnerIntakeFailed({
            cause: intakeError,
            message: "cmd.request.message intake failed",
          }),
        );
      }
      if (identityError) {
        return Result.err(
          new BusAgentRunnerAuthenticationProjectionInvalid({
            cause: identityError,
            message: "cmd.request.message identity ownership is invalid",
          }),
        );
      }
      return Result.ok(undefined);
    } catch (cause) {
      rethrowBusAgentRunnerPanic(cause);
      parkPending = true;
      return Result.err(
        new BusAgentRunnerIntakeFailed({
          cause,
          message: "cmd.request.message intake failed",
        }),
      );
    } finally {
      if (!parkPending) abandonQueueLifecycleAttempt(msg.id);
      if (cacheAdmitted) {
        requestMessageCache.finishDelivery({
          requestId,
          eventId: msg.id,
          disposition: parkPending ? "park" : "release",
        });
      }
    }
  }

  let stopStartedSubscription: (() => Promise<void>) | null = null;
  let subscriptionStart: Promise<void> | null = null;
  const superviseAgentRunnerBackgroundFailure = (cause: unknown): void => {
    rethrowBusAgentRunnerPanic(cause, reportFatalPanic);
    const error = projectBusAgentRunnerError(cause, "agent runner background operation failed");
    logger.error("agent runner background operation failed", { error: error.message });
  };
  const observeSupervisedSubscriptionDoneRejection = (): void => undefined;
  const isRunnerAdmissionStop = (error: EventDeliveryStopped): boolean =>
    runnerAdmissionStopped && error.reason === "requested";
  const startSubscription = (): Promise<void> => {
    if (subscriptionStart) return subscriptionStart;
    subscriptionStart = (async () => {
      const startedSubscription = await bus.subscribeTopic(
        "cmd.request",
        {
          mode: "work",
          subscriptionId,
          consumerId: consumerId(subscriptionId),
          batch: { maxWaitMs: 1000 },
        },
        async (msg) => {
          switch (msg.type) {
            case lilacEventTypes.CmdRequestMessage:
              return await handleCmdRequestMessage(msg);
          }
        },
        busAgentRunnerDeliveryDisposition,
      );
      if (startedSubscription.status === "error") {
        signalBusAgentRunnerHostFailure(startedSubscription.error);
      }
      const sub = startedSubscription.value;
      const subscriptionDone = sub.done.then((done) => {
        if (
          done.status === "error" &&
          !(done.error instanceof EventDeliveryStopped && isRunnerAdmissionStop(done.error))
        ) {
          signalBusAgentRunnerHostFailure(done.error);
        }
      });
      const supervisedSubscriptionDone = subscriptionDone.catch(
        superviseAgentRunnerBackgroundFailure,
      );
      void supervisedSubscriptionDone.catch(observeSupervisedSubscriptionDoneRejection);
      stopStartedSubscription = async () => {
        const stopped = await sub.stop();
        if (stopped.status === "error") signalBusAgentRunnerHostFailure(stopped.error);
        const done = await sub.done;
        if (
          done.status === "error" &&
          !(done.error instanceof EventDeliveryStopped && isRunnerAdmissionStop(done.error))
        ) {
          signalBusAgentRunnerHostFailure(done.error);
        }
      };
    })();
    return subscriptionStart;
  };

  let subscriptionStopped = false;
  const stopSubscription = async () => {
    if (subscriptionStopped) return;
    subscriptionStopped = true;
    await stopStartedSubscription?.();
  };

  function buildRecoveryIdentity(input: {
    readonly requestId: string;
    readonly requestClient: AdapterPlatform;
    readonly sessionId: string;
  }): AgentRunnerRecoveryIdentity {
    const projection = requestMessageCache.getOrigin(input.requestId);
    if (!projection) return { state: "restricted", reason: "missing-cache-proof" };
    const cacheState = requestMessageCache.snapshot(input.requestId);
    let safetyMode: SessionSafetyMode =
      projection.source === "external"
        ? currentSurfaceSafetyMode({
            platform: projection.requestClient,
            sessionId: input.sessionId,
            verifiedIngress: projection.verifiedIngress,
          })
        : "restricted";
    if (projection.source === "internal-delegated") {
      const authorized = params.durableWorkflowStore?.authorizeWorkflowRequest({
        requestId: input.requestId,
        sessionId: input.sessionId,
        platform: input.requestClient,
      });
      if (!authorized) return { state: "restricted", reason: "missing-cache-proof" };
      return {
        state: "durable",
        projection,
        assertedSafetyMode: safetyMode,
        parkedEventIds: cacheState?.parkedEventIds ?? [],
        delegationProof: {
          kind: "workflow",
          runId: authorized.policy.runId,
          operationId: authorized.policy.operationId,
          dispatchEpoch: authorized.policy.dispatchEpoch,
        },
      };
    }
    return {
      state: "durable",
      projection,
      assertedSafetyMode: safetyMode,
      parkedEventIds: cacheState?.parkedEventIds ?? [],
    };
  }

  function buildActiveRecoveryEntry(state: SessionQueue): AgentRunnerRecoveryEntry | null {
    if (!state.running || !state.activeRun) return null;

    if (!state.agent) {
      return {
        queueEntryId: `active:${state.activeRun.requestId}`,
        kind: "active",
        requestId: state.activeRun.requestId,
        sessionId: state.activeRun.sessionId,
        requestClient: state.activeRun.requestClient,
        queue: "prompt",
        runPolicy: state.activeRun.runPolicy,
        origin: state.activeRun.origin,
        messages: state.activeRun.messages,
        corePrimaryLineage: state.activeRun.corePrimaryLineage,
        ...(state.activeRun.modelOverride ? { modelOverride: state.activeRun.modelOverride } : {}),
        currentTurnUserId: state.activeRun.currentTurnUserId,
        raw: state.activeRun.raw,
        identity: buildRecoveryIdentity(state.activeRun),
      };
    }

    const checkpointMessages = buildSafeRecoveryCheckpoint(
      state.agent.getRecoverableMessages(),
      "server restarted",
    );

    return {
      queueEntryId: `active:${state.activeRun.requestId}`,
      kind: "active",
      requestId: state.activeRun.requestId,
      sessionId: state.activeRun.sessionId,
      requestClient: state.activeRun.requestClient,
      queue: "prompt",
      runPolicy: state.activeRun.runPolicy,
      origin: state.activeRun.origin,
      messages: [],
      corePrimaryLineage: degradeCorePrimaryLineageForMutation("restart-recovery-checkpoint"),
      ...(state.activeRun.modelOverride ? { modelOverride: state.activeRun.modelOverride } : {}),
      currentTurnUserId: state.activeRun.currentTurnUserId,
      raw: state.activeRun.raw,
      identity: buildRecoveryIdentity(state.activeRun),
      recovery: {
        checkpointMessages,
        partialText: state.activeRun.partialText,
      },
    };
  }

  async function beginDrain(opts?: { deadlineMs?: number }) {
    draining = true;
    await stopSubscription();

    const deadlineMs = Math.max(1, opts?.deadlineMs ?? 3_000);
    const startedAt = Date.now();

    const hasRunning = () => [...bySession.values()].some((s) => s.running);

    while (hasRunning() && Date.now() - startedAt < deadlineMs) {
      await new Promise((r) => setTimeout(r, 50));
    }

    if (!hasRunning()) return;

    for (const state of bySession.values()) {
      if (!state.running || !state.activeRun) continue;

      const recovery = buildActiveRecoveryEntry(state);
      if (recovery) {
        forcedRecoveryByRequestId.set(recovery.requestId, recovery);
        restartAbortRequestIds.add(recovery.requestId);
      }

      state.agent?.abort();
    }

    await new Promise((r) => setTimeout(r, 150));
  }

  function snapshotRecoverables(): AgentRunnerRecoveryEntry[] {
    const out: AgentRunnerRecoveryEntry[] = [];
    const seenActive = new Set<string>();

    for (const forced of forcedRecoveryByRequestId.values()) {
      out.push(forced);
      seenActive.add(forced.requestId);
    }

    for (const state of bySession.values()) {
      const active = buildActiveRecoveryEntry(state);
      if (active && !seenActive.has(active.requestId)) {
        out.push(active);
        seenActive.add(active.requestId);
      }

      for (const queued of state.queue) {
        out.push({
          queueEntryId: queued.queueEntryId,
          kind: "queued",
          requestId: queued.requestId,
          sessionId: queued.sessionId,
          requestClient: queued.requestClient,
          queue: queued.queue,
          runPolicy: queued.runPolicy,
          origin: queued.origin,
          messages: queued.messages,
          corePrimaryLineage: queued.corePrimaryLineage,
          ...(queued.modelOverride ? { modelOverride: queued.modelOverride } : {}),
          currentTurnUserId: queued.currentTurnUserId,
          raw: queued.raw,
          identity: buildRecoveryIdentity(queued),
        });
      }
    }

    return out;
  }

  function snapshotQueueAttempts(): AgentRunnerQueueAttempt[] {
    return [...queueLifecycleAttempts.values()].map((attempt) => ({
      eventId: attempt.eventId,
      controlRequestId: attempt.controlRequestId,
      controlRequestClient: attempt.controlRequestClient,
      sessionId: attempt.sessionId,
      kind: attempt.kind,
      detail: attempt.detail,
      controlApplied: attempt.controlApplied,
      controlIdentity: buildRecoveryIdentity({
        requestId: attempt.controlRequestId,
        requestClient: attempt.controlRequestClient,
        sessionId: attempt.sessionId,
      }),
      pendingGroups: attempt.pendingGroups.map((group, publicationIndex) => ({
        publicationIndex,
        requestId: group.requestId,
        requestClient: group.requestClient,
        targetQueueEntryIds: group.entries.map((entry) => entry.queueEntryId),
      })),
    }));
  }

  function sameRestoredOrigin(
    left: AuthenticatedSurfaceOrigin | undefined,
    right: AuthenticatedSurfaceOrigin | undefined,
  ): boolean {
    if (!left || !right) return left === right;
    return (
      left.platform === right.platform &&
      left.userId === right.userId &&
      left.sessionRef.channelId === right.sessionRef.channelId &&
      left.messageRef?.messageId === right.messageRef?.messageId
    );
  }

  function currentSurfaceSafetyMode(input: {
    readonly platform: AdapterPlatform;
    readonly sessionId: string;
    readonly verifiedIngress: boolean;
  }): SessionSafetyMode {
    let assertedSafetyMode: SessionSafetyMode = "restricted";
    if (input.platform === "discord") {
      const parentResolution = params.resolveParentChannelId?.(input.sessionId);
      if (parentResolution !== undefined) {
        assertedSafetyMode = resolveSessionSafetyMode(
          cfg,
          input.sessionId,
          parentResolution ?? undefined,
        );
      }
    }
    return resolveAuthenticatedRequestSafetyMode({
      projection: {
        requestClient: input.platform,
        source: "external",
        verifiedIngress: input.verifiedIngress,
      },
      assertedSafetyMode,
      correlatedAuthority: true,
    });
  }

  function resolveRecoveryIdentity(input: {
    readonly requestId: string;
    readonly sessionId: string;
    readonly requestClient: AdapterPlatform;
    readonly identity: AgentRunnerRecoveryIdentity | undefined;
  }): ResultType<
    {
      readonly projection?: AuthenticatedRequestProjection;
      readonly safetyMode: SessionSafetyMode;
      readonly parkedEventIds: readonly string[];
    },
    AgentRecoveryUnavailable
  > {
    const identity = input.identity;
    if (!identity || identity.state === "restricted") {
      return Result.ok({ safetyMode: "restricted", parkedEventIds: [] });
    }
    const projection = identity.projection;
    if (
      projection.requestId !== input.requestId ||
      projection.requestClient !== input.requestClient ||
      projection.sessionId !== input.sessionId ||
      !isAuthenticatedRequestProjectionSemanticallyValid(projection)
    ) {
      return Result.err(
        new AgentRecoveryUnavailable({
          requestId: input.requestId,
          reason: "identity-conflict",
          message: "Persisted recovery identity conflicts with its request route",
        }),
      );
    }
    if (projection.source === "internal-delegated") {
      const proof = identity.delegationProof;
      const authorized = params.durableWorkflowStore?.authorizeWorkflowRequest({
        requestId: input.requestId,
        sessionId: input.sessionId,
        platform: input.requestClient,
      });
      if (
        !proof ||
        !authorized ||
        authorized.policy.runId !== proof.runId ||
        authorized.policy.operationId !== proof.operationId ||
        authorized.policy.dispatchEpoch !== proof.dispatchEpoch
      ) {
        return Result.err(
          new AgentRecoveryUnavailable({
            requestId: input.requestId,
            reason: "delegation-proof-unavailable",
            message: "Persisted delegated recovery proof is unavailable or stale",
          }),
        );
      }
      const origin = authorized.policy.originSession;
      const authenticatedOrigin = projectAuthorizedWorkflowOrigin(origin);
      if (!sameRestoredOrigin(projection.authenticatedOrigin, authenticatedOrigin)) {
        return Result.err(
          new AgentRecoveryUnavailable({
            requestId: input.requestId,
            reason: "identity-conflict",
            message: "Persisted delegated identity conflicts with durable workflow authority",
          }),
        );
      }
      const safetyMode = "restricted" as const;
      if (identity.assertedSafetyMode !== safetyMode) {
        return Result.err(
          new AgentRecoveryUnavailable({
            requestId: input.requestId,
            reason: "identity-conflict",
            message: "Persisted delegated safety assertion is not durably authorized",
          }),
        );
      }
      return Result.ok({
        projection: { ...projection, authenticatedOrigin, verifiedIngress: false },
        safetyMode,
        parkedEventIds: identity.parkedEventIds,
      });
    }
    const safetyMode = currentSurfaceSafetyMode({
      platform: projection.requestClient,
      sessionId: projection.sessionId,
      verifiedIngress: projection.verifiedIngress,
    });
    if (identity.assertedSafetyMode !== safetyMode) {
      return Result.err(
        new AgentRecoveryUnavailable({
          requestId: input.requestId,
          reason: "identity-conflict",
          message: "Persisted safety assertion conflicts with current surface policy",
        }),
      );
    }
    return Result.ok({
      projection,
      safetyMode,
      parkedEventIds: identity.parkedEventIds,
    });
  }

  function prepareRecovery(
    recoveryState: AgentRunnerRecoveryState,
  ): ResultType<AgentRecoveryAttempt, AgentRecoveryUnavailable> {
    const queueEntries = new Map<string, AgentRunnerRecoveryEntry>();
    const resolvedIdentities = new Map<
      string,
      {
        readonly projection?: AuthenticatedRequestProjection;
        readonly safetyMode: SessionSafetyMode;
        readonly parkedEventIds: readonly string[];
      }
    >();
    const cacheRecords: Array<{
      readonly projection: AuthenticatedRequestProjection;
      readonly parkedEventIds: readonly string[];
    }> = [];
    for (const entry of recoveryState.entries) {
      const queueEntryId = entry.queueEntryId;
      if (!queueEntryId || queueEntries.has(queueEntryId) || bySession.has(entry.sessionId)) {
        return Result.err(
          new AgentRecoveryUnavailable({
            requestId: entry.requestId,
            reason: "queue-admission-conflict",
            message: "Persisted recovery queue admission conflicts with active state",
          }),
        );
      }
      queueEntries.set(queueEntryId, entry);
      const resolved = resolveRecoveryIdentity({
        requestId: entry.requestId,
        sessionId: entry.sessionId,
        requestClient: entry.requestClient,
        identity: entry.identity,
      });
      if (resolved.status === "error") return Result.err(resolved.error);
      resolvedIdentities.set(queueEntryId, resolved.value);
      if (resolved.value.projection) {
        cacheRecords.push({
          projection: resolved.value.projection,
          parkedEventIds: resolved.value.parkedEventIds,
        });
      }
    }

    const reservedIds = new Set<string>();
    const attemptEventIds = new Set<string>();
    for (const attempt of recoveryState.queueAttempts) {
      if (
        attemptEventIds.has(attempt.eventId) ||
        queueEntries.has(attempt.eventId) ||
        queueLifecycleAttempts.has(attempt.eventId)
      ) {
        return Result.err(
          new AgentRecoveryUnavailable({
            requestId: attempt.controlRequestId,
            reason: "queue-attempt-conflict",
            message: "Persisted control delivery event identity is duplicated",
          }),
        );
      }
      attemptEventIds.add(attempt.eventId);
      const control = resolveRecoveryIdentity({
        requestId: attempt.controlRequestId,
        sessionId: attempt.sessionId,
        requestClient: attempt.controlRequestClient,
        identity: attempt.controlIdentity,
      });
      if (
        control.status === "error" ||
        !control.value.projection ||
        !control.value.parkedEventIds.includes(attempt.eventId) ||
        (attempt.kind === "queued-cancellation" && !attempt.controlApplied)
      ) {
        return Result.err(
          control.status === "error"
            ? control.error
            : new AgentRecoveryUnavailable({
                requestId: attempt.controlRequestId,
                reason: "queue-attempt-conflict",
                message: "Persisted control delivery ownership is incomplete",
              }),
        );
      }
      cacheRecords.push({
        projection: control.value.projection,
        parkedEventIds: control.value.parkedEventIds,
      });
      for (const group of attempt.pendingGroups) {
        for (const queueEntryId of group.targetQueueEntryIds) {
          const target = queueEntries.get(queueEntryId);
          if (
            !target ||
            reservedIds.has(queueEntryId) ||
            target.kind !== "queued" ||
            target.requestId !== group.requestId ||
            target.requestClient !== group.requestClient ||
            target.sessionId !== attempt.sessionId
          ) {
            return Result.err(
              new AgentRecoveryUnavailable({
                requestId: attempt.controlRequestId,
                reason: "queue-attempt-conflict",
                message: "Persisted queue reservation conflicts with its target entry",
              }),
            );
          }
          reservedIds.add(queueEntryId);
        }
      }
    }
    const cacheAttempt = requestMessageCache.prepareRestore(cacheRecords);
    if (cacheAttempt.status === "error") {
      return Result.err(
        new AgentRecoveryUnavailable({
          requestId: recoveryState.entries[0]?.requestId ?? "recovery",
          reason: "cache-conflict",
          message: "Persisted recovery identity conflicts with request cache state",
        }),
      );
    }

    const inserted = new Map<string, Enqueued>();
    const owners: RequestMessageCacheOwner[] = [];
    const sessions = new Set<string>();
    let applied = false;
    let activated = false;
    const rollback = (): void => {
      if (!applied || activated) return;
      for (const attempt of recoveryState.queueAttempts) {
        queueLifecycleAttempts.delete(attempt.eventId);
      }
      for (const queued of inserted.values()) reservedQueueEntries.delete(queued);
      for (const sessionId of sessions) bySession.delete(sessionId);
      for (const owner of owners) requestMessageCache.releaseOwner(owner);
      cacheAttempt.value.rollback();
      inserted.clear();
      owners.length = 0;
      sessions.clear();
      applied = false;
    };
    return Result.ok({
      apply: () => {
        if (applied) return Result.ok(undefined);
        const cached = cacheAttempt.value.apply();
        if (cached.status === "error") {
          return Result.err(
            new AgentRecoveryUnavailable({
              requestId: recoveryState.entries[0]?.requestId ?? "recovery",
              reason: "cache-conflict",
              message: "Request cache changed during paused recovery admission",
            }),
          );
        }
        applied = true;
        for (const entry of recoveryState.entries) {
          const queueEntryId = entry.queueEntryId;
          if (!queueEntryId) continue;
          const identity = resolvedIdentities.get(queueEntryId);
          let identityOwner: RequestMessageCacheOwner | undefined;
          if (identity?.projection) {
            const owner = requestMessageCache.acquireOwner(entry.requestId);
            if (owner.status === "error") {
              rollback();
              return Result.err(
                new AgentRecoveryUnavailable({
                  requestId: entry.requestId,
                  reason: "cache-conflict",
                  message: "Persisted recovery queue owner could not be acquired",
                }),
              );
            }
            identityOwner = owner.value;
            owners.push(owner.value);
          }
          const queued: Enqueued = {
            queueEntryId,
            requestId: entry.requestId,
            sessionId: entry.sessionId,
            requestClient: entry.requestClient,
            queue: entry.queue,
            runPolicy: entry.runPolicy ?? "normal",
            origin: entry.origin,
            messages: entry.messages,
            corePrimaryLineage: entry.recovery
              ? degradeCorePrimaryLineageForMutation("restart-recovery-checkpoint")
              : entry.corePrimaryLineage,
            modelOverride: entry.modelOverride,
            currentTurnUserId: entry.currentTurnUserId,
            raw: entry.raw,
            recovery: entry.recovery,
            authenticatedOrigin: identity?.projection?.authenticatedOrigin,
            verifiedIngress: identity?.projection?.verifiedIngress,
            restoredSafetyMode: identity?.safetyMode ?? "restricted",
            ...(identityOwner ? { identityOwner } : {}),
          };
          const state =
            bySession.get(entry.sessionId) ??
            ({
              running: false,
              agent: null,
              queue: [] as Enqueued[],
              activeRequestId: null,
              activeRun: null,
              compactedToolCallIds: new Set<string>(),
            } satisfies SessionQueue);
          state.queue.push(queued);
          bySession.set(entry.sessionId, state);
          sessions.add(entry.sessionId);
          inserted.set(queueEntryId, queued);
        }
        for (const persisted of recoveryState.queueAttempts) {
          const pendingGroups = persisted.pendingGroups
            .toSorted((left, right) => left.publicationIndex - right.publicationIndex)
            .map((group) => ({
              requestId: group.requestId,
              requestClient: group.requestClient,
              entries: group.targetQueueEntryIds.flatMap((id) => {
                const queued = inserted.get(id);
                return queued ? [queued] : [];
              }),
            }));
          const attempt: QueueLifecycleAttempt = {
            eventId: persisted.eventId,
            controlRequestId: persisted.controlRequestId,
            controlRequestClient: persisted.controlRequestClient,
            sessionId: persisted.sessionId,
            kind: persisted.kind,
            detail: persisted.detail,
            pendingGroups,
            controlApplied: persisted.controlApplied,
          };
          queueLifecycleAttempts.set(attempt.eventId, attempt);
          for (const group of pendingGroups) {
            for (const queued of group.entries) reservedQueueEntries.add(queued);
          }
        }
        return Result.ok(undefined);
      },
      rollback,
      activate: () => {
        if (!applied || activated) return;
        activated = true;
        activateRunnerAdmission();
        for (const sessionId of sessions) {
          const state = bySession.get(sessionId);
          if (state && !state.running) startSessionQueueDrain(sessionId, state);
        }
      },
    });
  }

  async function drainSessionQueue(sessionId: string, state: SessionQueue) {
    rethrowBusAgentRunnerPanic(terminalPanic);
    if (state.running) return;

    const queueDepthBefore = state.queue.length;
    const next = state.queue[0];
    if (!next) return;
    if (reservedQueueEntries.has(next)) return;
    state.queue.shift();

    logger.debug("agent.queue.transition", {
      requestId: next.requestId,
      sessionId,
      requestClient: next.requestClient,
      queueMode: next.queue,
      running: state.running,
      queueDepthBefore,
      queueDepthAfter: state.queue.length,
      action: "dequeue",
      reason: "drain_session_queue",
      activeRequestId: state.activeRequestId,
      draining,
    });

    state.running = true;
    state.activeRequestId = next.requestId;

    const runStartedAt = Date.now();

    const subagentMeta = parseSubagentMetaFromRaw(next.raw);
    const runProfile = subagentMeta.profile;
    if (next.recovery && runProfile === "primary" && next.requestClient === "discord") {
      next.corePrimaryLineage = degradeCorePrimaryLineageForMutation("restart-recovery-checkpoint");
    }
    const workflowHint = parseWorkflowRequestHintFromRaw(next.raw);
    let workflowDispatchEpoch = workflowHint?.dispatchEpoch;
    let workflowPolicy: WorkflowRequestPolicy | null = null;
    let workflowRequestClaimed = false;
    let workflowClaimTimer: ReturnType<typeof setInterval> | null = null;
    let preserveWorkflowClaim = false;
    let controlCapability: string | null = null;
    let trustedFallbackSurface: TrustedSubagentDelegationRegistration["fallbackSurface"] | null =
      null;
    const subagents = cfg.agent.subagents;

    const routerSessionMode = parseRouterSessionModeFromRaw(next.raw);

    let activeAgent: AiSdkPiAgent<ToolSet> | null = null;
    let claudeCodeRun: MaterializedClaudeCodeRun | null = null;
    let coreNamedClaudeRuntime: CoreNamedClaudeRuntime | null = null;
    let corePrimaryClaudeRuntime: CorePrimaryClaudeRuntime | null = null;
    const getClaudeCodeRun = (): MaterializedClaudeCodeRun | null => claudeCodeRun;
    const getCoreNamedClaudeRuntime = (): CoreNamedClaudeRuntime | null => coreNamedClaudeRuntime;
    const getCorePrimaryClaudeRuntime = (): CorePrimaryClaudeRuntime | null =>
      corePrimaryClaudeRuntime;
    let activeRunOperation: Promise<unknown> | null = null;
    let customCommandAbortController: AbortController | null = null;
    let activeCustomCommandTool: { toolCallId: string; display: string } | null = null;
    let rejectPreAgentCancellation: ((error: PreAgentRunCancelledError) => void) | null = null;
    const preAgentCancellationPromise = new Promise<never>((_, reject) => {
      rejectPreAgentCancellation = reject;
    });
    void captureBusAgentRunnerOperation(
      "pre-agent cancellation observation",
      () => preAgentCancellationPromise,
    );
    let unsubscribe = () => {};
    let unsubscribeCompaction = () => {};

    const headers: {
      request_id: string;
      session_id: string;
      request_client: AdapterPlatform;
      workflow_dispatch_epoch?: string;
      router_session_mode?: "mention" | "active";
    } = {
      request_id: next.requestId,
      session_id: next.sessionId,
      request_client: next.requestClient,
      ...(workflowDispatchEpoch ? { workflow_dispatch_epoch: workflowDispatchEpoch } : {}),
      ...(routerSessionMode ? { router_session_mode: routerSessionMode } : {}),
    };
    const reportOutputPublisherError = (label: string, cause: AgentOutputPublishFailed): void => {
      logger.error(
        `failed to publish ${label}`,
        formatBridgeTaggedErrorForLog(cause, {
          requestId: headers.request_id,
          sessionId: headers.session_id,
        }),
      );
    };
    const outputPublisher = createAgentOutputPublisher({
      bus,
      headers,
      onError: reportOutputPublisherError,
      reportFatalPanic,
    });
    const publishAuxiliaryOutput = async (
      operation: string,
      publish: () => Promise<void>,
    ): Promise<void> => {
      const published = await captureBusAgentRunnerOperation(operation, publish);
      if (published.status === "ok") return;
      logger.error(
        operation,
        formatBridgeTaggedErrorForLog(published.error, {
          requestId: headers.request_id,
          sessionId: headers.session_id,
        }),
      );
    };
    let auxiliaryOutputTail = Promise.resolve();
    const publishCurrentLifecycle = async (input: {
      state: RequestLifecycleState;
      detail?: string;
      output?: string;
      usage?: WorkflowUsage;
    }): Promise<void> => {
      if (input.state === "resolved" || input.state === "failed" || input.state === "cancelled") {
        await auxiliaryOutputTail;
        await outputPublisher.drain();
      }
      if (
        workflowPolicy &&
        workflowRequestClaimed &&
        workflowDispatchEpoch &&
        (input.state === "resolved" || input.state === "failed" || input.state === "cancelled")
      ) {
        const recorded = params.durableWorkflowStore?.recordWorkflowRequestTerminal({
          requestId: next.requestId,
          runId: workflowPolicy.runId,
          operationId: workflowPolicy.operationId,
          dispatchEpoch: workflowDispatchEpoch,
          ownerId: workflowRunnerOwnerId,
          state: input.state,
          detail: input.detail,
          output: input.output,
          usage: input.usage,
          now: Date.now(),
        });
        if (recorded !== true) {
          return signalBusAgentRunnerHostFailure(
            new Error("Workflow terminal receipt persistence lost its fenced dispatch claim"),
          );
        }
      }
      await publishLifecycle({ bus, headers, ...input });
    };
    const reportAgentActivityError = (cause: unknown): void => {
      const error = projectBusAgentRunnerError(cause, "Agent activity publish failed");
      logger.debug("agent activity publish failed", {
        requestId: next.requestId,
        sessionId: next.sessionId,
        error: error.message,
      });
    };
    const publishAgentActivity = createAgentOutputActivityPublisher({
      publish: async (source) => {
        await outputPublisher.publishActivity({ source });
      },
      onError: reportAgentActivityError,
    });
    const idleRetryBudget = createRetryBackoffBudget(cfg.agent.retry);
    let idleRecoveryPromise: ReturnType<AiSdkPiAgent<ToolSet>["requestIdleRecovery"]> | null = null;
    const decideIdleRecovery = async (
      _idleError: unknown,
      { abortSignal }: { readonly abortSignal: AbortSignal },
    ) => {
      await liveParentSession?.cancelAll("parent idle timeout recovery");

      await coreNamedClaudeRuntime?.retireForRetry();
      await corePrimaryClaudeRuntime?.retireForRetry();
      const retryResult = await captureBusAgentRunnerOperation("idle retry backoff", () =>
        idleRetryBudget.next(abortSignal),
      );
      if (retryResult.status === "error") return "fail" as const;
      const decision = toIdleRetryDecision(retryResult.value);
      if (decision.status === "fail") return "fail" as const;
      const retry = decision.attempt;
      logger.warn("agent idle timeout; retrying", {
        requestId: headers.request_id,
        sessionId: headers.session_id,
        attempt: retry.attempt,
        maxRetries: cfg.agent.retry.maxRetries,
        delayMs: retry.delayMs,
      });
      return "retry" as const;
    };
    const runIdleWatchdog =
      runProfile === "primary"
        ? createAgentRunIdleWatchdog({
            idleTimeoutMs: cfg.agent.idleTimeoutMs,
            onTimeout: (error) => {
              logger.warn("agent run idle timeout", {
                requestId: headers.request_id,
                sessionId: headers.session_id,
                idleTimeoutMs: cfg.agent.idleTimeoutMs,
              });
              customCommandAbortController?.abort();
              const agent = activeAgent;
              if (!agent) return;
              idleRecoveryPromise = agent.requestIdleRecovery(error, decideIdleRecovery);
            },
          })
        : null;
    const waitForRun = async <T>(
      promise: Promise<T>,
    ): Promise<ResultType<T, BusAgentRunnerOperationFailed>> => {
      let tracked: Promise<T>;
      tracked = promise.finally(() => {
        if (activeRunOperation === tracked) activeRunOperation = null;
      });
      activeRunOperation = tracked;
      if (!runIdleWatchdog) {
        return await captureBusAgentRunnerOperation("agent run wait", () => tracked);
      }

      while (true) {
        const waited = await captureBusAgentRunnerOperation("agent idle watchdog wait", () =>
          runIdleWatchdog.waitFor(tracked),
        );
        if (waited.status === "ok") return Result.ok(waited.value);
        const recovery = idleRecoveryPromise;
        if (waited.error.failureKind !== "idle-timeout" || !recovery) {
          return Result.err(waited.error);
        }
        const result = await recovery;
        if (idleRecoveryPromise === recovery) idleRecoveryPromise = null;
        if (
          result.status !== "retried" &&
          !(
            result.status === "superseded" &&
            (result.reason === "cancel" || result.reason === "interrupt")
          )
        ) {
          return Result.err(waited.error);
        }
        runIdleWatchdog.restart();
      }
    };
    const waitForRunAtHost = async <T>(promise: Promise<T>): Promise<T> => {
      const waited = await waitForRun(promise);
      if (waited.status === "error") return signalBusAgentRunnerHostFailure(waited.error);
      return waited.value;
    };
    const getActiveRunOperation = (): Promise<unknown> | null => activeRunOperation;
    const waitForPreAgent = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, preAgentCancellationPromise]);
    const markRunActivity = (source: "model" | "tool" | "subagent") => {
      publishAgentActivity(source);
      runIdleWatchdog?.reset();
    };

    const normalizeToolResultOutput = createToolResultOutputNormalizer({
      artifacts: params.toolResultArtifacts,
      owner: {
        requestId: next.requestId,
        sessionId: next.sessionId,
      },
      getOutputConfig: () => cfg.tools.output,
    });

    const liveParentSession = params.workflowLiveParentBridge?.registerParent({
      parentRequestId: next.requestId,
      onActivity: () => markRunActivity("subagent"),
      publishToolStatus: async (update) => {
        await outputPublisher.publishToolCall(update);
      },
      recoverSynchronousDeliveries: next.recovery !== undefined,
    });
    await liveParentSession?.ready;
    const workflowSubagentDispatcher = params.workflowSubagentDispatcher;
    let continuationSignalVersion = 0;
    const continuationWaiters = new Set<() => void>();
    const notifyContinuationWaiters = () => {
      continuationSignalVersion += 1;
      const current = [...continuationWaiters];
      continuationWaiters.clear();
      for (const waiter of current) waiter();
    };
    const waitForContinuationSignalSince = async (version: number, abortSignal?: AbortSignal) => {
      if (continuationSignalVersion !== version || abortSignal?.aborted) return;
      await new Promise<void>((resolve) => {
        const finish = () => {
          continuationWaiters.delete(finish);
          abortSignal?.removeEventListener("abort", finish);
          resolve();
        };
        if (continuationSignalVersion !== version || abortSignal?.aborted) {
          finish();
          return;
        }
        continuationWaiters.add(finish);
        abortSignal?.addEventListener("abort", finish, { once: true });
      });
    };
    const waitForDeferredWake = async (
      liveParentSignalVersion: number,
      continuationVersion: number,
    ) => {
      if (!liveParentSession) return;
      const controller = new AbortController();
      try {
        await Promise.race([
          liveParentSession.waitForSignalSince(liveParentSignalVersion, controller.signal),
          waitForContinuationSignalSince(continuationVersion, controller.signal),
          Bun.sleep(LIVE_PARENT_RECONCILE_MS),
        ]);
      } finally {
        controller.abort();
      }
    };

    state.activeRun = {
      requestId: next.requestId,
      sessionId: next.sessionId,
      requestClient: next.requestClient,
      runProfile,
      queue: next.queue,
      runPolicy: next.runPolicy,
      origin: next.origin,
      messages: next.messages,
      corePrimaryLineage: next.corePrimaryLineage,
      modelOverride: next.modelOverride,
      currentTurnUserId: next.currentTurnUserId,
      raw: next.raw,
      resolvedModelSpec: null,
      resolvedReasoning: undefined,
      resolvedProviderFamily: null,
      partialText: next.recovery?.partialText ?? "",
      liveParent: liveParentSession,
      claudeCodeControl: null,
      notifyWaiters: notifyContinuationWaiters,
      flushOutput: outputPublisher.flush,
      setCurrentTurnUserId: () => undefined,
      cancel: () => {
        cancelledByRequestId.add(headers.request_id);
        customCommandAbortController?.abort();
        rejectPreAgentCancellation?.(new PreAgentRunCancelledError());
        rejectPreAgentCancellation = null;
      },
      started: false,
      startedAt: runStartedAt,
      activeTools: new Map(),
    };

    let initialMessages: ModelMessage[] = [];
    const parsedCustomCommand = next.recovery ? null : parseCustomCommandFromRaw(next.raw);
    let customCommandMessages: ModelMessage[] = [];
    let initialMessagesEndWithInjectedTool = false;
    let responseStartIndex = 0;
    const runStats: {
      totalUsage?: LanguageModelUsage;
      finalMessages?: ModelMessage[];
      firstTextDeltaAt?: number;
      lastTurnFinishReason?: FinishReason;
      lastTurnEndAt?: number;
    } = {};
    let completedCompactionCount = 0;
    const streamWarnings: CallWarning[] = [];
    const modelCapabilityConfig = cfg.models.capability;
    const modelCapability = new ModelCapability({
      forceUnknownProviders: modelCapabilityConfig?.forceUnknownProviders ?? ["openai-compatible"],
      overrides: modelCapabilityConfig?.overrides ?? {},
    });
    let modelCapabilityInfo: ModelCapabilityInfo | null = null;
    let costEstimateStatus: "estimated" | "unavailable" = "unavailable";
    let costEstimateReason: string | undefined;
    let roundEstimatedCostUsdTotal: number | undefined;
    let roundEstimatedCostCount = 0;

    let resolvedModelLabel = "unknown";
    let resolvedProviderFamily: HistoryProviderState["lastFamily"] = "ai-sdk";
    try {
      const runResult = await captureBusAgentRunnerOperation(
        "agent queue run",
        async () => {
          const looksLikeWorkflowRequest =
            next.requestId.startsWith("wfr:") || next.sessionId.startsWith("workflow:");
          if (workflowHint || looksLikeWorkflowRequest) {
            if (!workflowHint || !params.durableWorkflowStore) {
              return signalBusAgentRunnerHostFailure(
                new Error("Workflow request is missing server-issued dispatch authority"),
              );
            }
            const authorized = params.durableWorkflowStore.authorizeWorkflowRequest({
              requestId: next.requestId,
              sessionId: next.sessionId,
              platform: next.requestClient,
            });
            if (
              !authorized ||
              authorized.policy.runId !== workflowHint.runId ||
              authorized.policy.operationId !== workflowHint.operationId ||
              authorized.policy.dispatchEpoch !== workflowHint.dispatchEpoch
            ) {
              return signalBusAgentRunnerHostFailure(
                new Error("Workflow request dispatch authority is invalid or inactive"),
              );
            }
            workflowDispatchEpoch = authorized.policy.dispatchEpoch;
            headers.workflow_dispatch_epoch = workflowDispatchEpoch;
            if (
              !params.durableWorkflowStore.claimWorkflowRequest({
                requestId: next.requestId,
                dispatchEpoch: authorized.policy.dispatchEpoch,
                ownerId: workflowRunnerOwnerId,
                now: Date.now(),
              })
            ) {
              return signalBusAgentRunnerHostFailure(
                new Error("Workflow request dispatch is owned by another live runner"),
              );
            }
            workflowRequestClaimed = true;
            workflowPolicy = authorized.policy;
            const fallbackClient = authorized.policy.originSession.client;
            const fallbackProtocol = fallbackClient
              ? params.surfaceProtocolResolver?.resolve(fallbackClient)
              : null;
            trustedFallbackSurface =
              authorized.policy.originSession.sessionId &&
              fallbackProtocol &&
              authorized.policy.originSession.userId
                ? {
                    platform: fallbackProtocol.platform,
                    sessionId: authorized.policy.originSession.sessionId,
                    userId: authorized.policy.originSession.userId,
                  }
                : null;
            workflowClaimTimer = setInterval(() => {
              const refreshed = params.durableWorkflowStore?.refreshWorkflowRequestClaim(
                next.requestId,
                workflowRunnerOwnerId,
                Date.now(),
              );
              if (refreshed === false) {
                activeAgent?.abort();
                rejectPreAgentCancellation?.(new PreAgentRunCancelledError());
              }
            }, WORKFLOW_REQUEST_CLAIM_HEARTBEAT_MS);
            workflowClaimTimer.unref?.();
          }
          if (workflowPolicy) {
            const validatedPolicy = assertWorkflowDispatchPolicy(workflowPolicy, subagentMeta);
            if (validatedPolicy.status === "error") {
              return signalBusAgentRunnerHostFailure(validatedPolicy.error);
            }
          }
          const resolvedStableNamedContinuation = resolveCoreStableNamedContinuation({
            runProfile,
            sessionId: next.sessionId,
            workflowPolicy,
          });
          if (resolvedStableNamedContinuation.status === "error") {
            return signalBusAgentRunnerHostFailure(resolvedStableNamedContinuation.error);
          }
          const stableNamedContinuation = resolvedStableNamedContinuation.value;
          const maxSubagentDepth = subagents.maxDepth;
          if (subagentMeta.depth > maxSubagentDepth) {
            const detail = `subagent depth ${subagentMeta.depth} exceeds maxDepth=${maxSubagentDepth}`;
            await publishCurrentLifecycle({
              state: "failed",
              detail,
              output: `Error: ${detail}`,
            });
            await outputPublisher.publishResponseText({ finalText: `Error: ${detail}` });
            return;
          }

          let lifecycleDetail: string | undefined;
          if (next.recovery) {
            lifecycleDetail = "resumed after server restart";
          } else {
            switch (next.queue) {
              case "prompt":
                lifecycleDetail = undefined;
                break;
              case "steer":
              case "followUp":
              case "interrupt":
                lifecycleDetail = `coerced queue=${next.queue} to prompt (no active run)`;
                break;
              default: {
                const _exhaustive: never = next.queue;
                lifecycleDetail = _exhaustive;
                break;
              }
            }
          }
          await publishCurrentLifecycle({
            state: "running",
            detail: lifecycleDetail,
          });
          const replyPublished = await bus.publish(
            lilacEventTypes.EvtRequestReply,
            {},
            { headers },
          );
          if (replyPublished.status === "error") {
            return signalBusAgentRunnerHostFailure(replyPublished.error);
          }

          if (parsedCustomCommand) {
            if (runProfile === "primary" && next.requestClient === "discord") {
              next.corePrimaryLineage = degradeCorePrimaryLineageForMutation(
                "custom-command-tool-insertion",
                next.corePrimaryLineage?.currentCanonicalStart,
              );
              if (state.activeRun) state.activeRun.corePrimaryLineage = next.corePrimaryLineage;
            }
            const toolCallId = buildCustomCommandToolCallId(
              next.requestId,
              parsedCustomCommand.name,
            );
            const display = `${CUSTOM_COMMAND_TOOL_NAME} ${parsedCustomCommand.text}`;
            activeCustomCommandTool = { toolCallId, display };

            await outputPublisher.publishToolCall({
              toolCallId,
              status: "start",
              display,
            });

            let output: CustomCommandResult = { type: "json", value: null };
            let customError = parsedCustomCommand.error ?? null;
            const command = params.customCommands?.get(parsedCustomCommand.name) ?? null;

            if (!customError && !params.customCommands) {
              customError = "Custom command manager is unavailable.";
            }
            if (!customError && !command) {
              customError = `Unknown custom command '${parsedCustomCommand.name}'.`;
            }

            if (!customError && command && params.customCommands) {
              if (cancelledByRequestId.has(headers.request_id)) {
                return signalBusAgentRunnerHostFailure(new PreAgentRunCancelledError());
              }
              customCommandAbortController = new AbortController();
              runIdleWatchdog?.start();
              try {
                const executed = await waitForPreAgent(
                  waitForRunAtHost(
                    params.customCommands.execute({
                      command,
                      args: parsedCustomCommand.args,
                      context: {
                        cwd,
                        dataDir: env.dataDir,
                        commandDir: command.dir,
                        commandName: command.def.name,
                        requestId: next.requestId,
                        sessionId: next.sessionId,
                        abortSignal: customCommandAbortController.signal,
                        reportActivity: () => markRunActivity("tool"),
                      },
                    }),
                  ),
                );
                if (executed.status === "error") {
                  customError = customCommandExecutionErrorText(executed.error);
                } else {
                  output = executed.value;
                }
              } finally {
                runIdleWatchdog?.pause();
                customCommandAbortController = null;
              }
            }

            const customCancelled = cancelledByRequestId.has(headers.request_id);

            if (customCancelled) {
              const finalText = "Cancelled.";
              await outputPublisher.publishToolCall({
                toolCallId,
                status: "end",
                display,
                ok: false,
                error: "cancelled by interrupt",
              });
              activeCustomCommandTool = null;
              await publishCurrentLifecycle({
                state: "cancelled",
                detail: "cancelled by interrupt",
                output: finalText,
              });
              await outputPublisher.publishResponseText({ finalText });
              return;
            }

            if (customError) {
              output = { type: "error-text", value: customError };
            }

            output = await waitForPreAgent(
              Promise.resolve(
                normalizeToolResultOutput(output, {
                  toolCallId,
                  toolName: CUSTOM_COMMAND_TOOL_NAME,
                }),
              ),
            );

            customCommandMessages = buildCustomCommandMessages({
              toolCallId,
              name: parsedCustomCommand.name,
              args: parsedCustomCommand.args,
              prompt: parsedCustomCommand.prompt,
              text: parsedCustomCommand.text,
              source: parsedCustomCommand.source,
              output,
            });

            await outputPublisher.publishToolCall({
              toolCallId,
              status: "end",
              display,
              ok: !customError,
              error: customError ?? undefined,
            });
            activeCustomCommandTool = null;

            if (customError) {
              const finalText = buildCustomCommandFailureFinalText({
                commandText: parsedCustomCommand.text,
                normalizedOutput: output,
              });
              resolvedModelLabel = CUSTOM_COMMAND_TOOL_NAME;

              if (params.transcriptStore) {
                const persisted = params.transcriptStore.saveRequestTranscript({
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  requestClient: headers.request_client,
                  messages: [
                    ...customCommandMessages,
                    { role: "assistant", content: finalText } satisfies ModelMessage,
                  ],
                  finalText,
                  modelLabel: resolvedModelLabel,
                });
                if (persisted.status === "error") {
                  logger.error(
                    "failed to persist transcript after custom command error",
                    formatBridgeLogContext({
                      requestId: headers.request_id,
                      sessionId: headers.session_id,
                      errorTag: persisted.error.name,
                      errorMessage: persisted.error.message,
                    }),
                  );
                }
              }

              await publishCurrentLifecycle({
                state: "failed",
                detail: customError,
                output: finalText,
              });
              await outputPublisher.publishResponseText({ finalText });

              logger.warn(
                "custom command failed",
                formatBridgeLogContext({
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  commandName: parsedCustomCommand.name,
                  errorMessage: customError,
                }),
              );
              return;
            }
          }

          const requestModelOverride =
            runProfile === "primary"
              ? (next.modelOverride ?? parseRequestModelOverrideFromRaw(next.raw) ?? undefined)
              : next.modelOverride;
          if (
            workflowPolicy &&
            requestModelOverride !== undefined &&
            requestModelOverride !== workflowPolicy.resolvedModelRequest.alias &&
            requestModelOverride !== workflowPolicy.resolvedModelRequest.spec
          ) {
            return signalBusAgentRunnerHostFailure(
              new Error("Workflow request model does not match the approved operation policy"),
            );
          }
          const resolvedModelPlan = resolveAgentRunModelResult({
            cfg,
            runProfile,
            requestModelOverride,
            reasoningOverride: subagentMeta.reasoning,
            resolvedModelRequest: workflowPolicy?.resolvedModelRequest,
          });
          if (resolvedModelPlan.status === "error") {
            return signalBusAgentRunnerHostFailure(resolvedModelPlan.error);
          }
          const modelPlan = resolvedModelPlan.value;
          const initialResolvedModel = modelPlan.head;
          resolvedModelLabel = initialResolvedModel.modelId;
          resolvedProviderFamily = classifyHistoryProviderFamily({
            type: initialResolvedModel.provider,
          });
          if (state.activeRun) {
            state.activeRun.resolvedModelSpec = initialResolvedModel.spec;
            state.activeRun.resolvedReasoning = initialResolvedModel.reasoning;
            state.activeRun.resolvedProviderFamily = resolvedProviderFamily;
          }

          const skillsSection =
            runProfile === "explore"
              ? null
              : await waitForPreAgent(maybeBuildSkillsSectionForPrimary());

          const sessionConfigId = parseSessionConfigIdFromRaw(next.raw) ?? sessionId;
          const parentChannelResolution =
            next.requestClient === "discord" ? params.resolveParentChannelId?.(sessionId) : null;
          const parentChannelId = parentChannelResolution ?? undefined;
          let safetyMode: SessionSafetyMode =
            next.restoredSafetyMode ??
            (next.requestClient === "discord" && parentChannelResolution === undefined
              ? "restricted"
              : resolveSessionSafetyMode(cfg, sessionId, parentChannelId));
          if (runProfile === "primary" && !workflowPolicy && isHeartbeatSessionId(next.sessionId)) {
            controlCapability =
              (await params.issueHeartbeatCapability?.({
                requestId: next.requestId,
                sessionId: next.sessionId,
                requestClient: next.requestClient,
                canonicalCwd: cwd,
                expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1_000,
              })) ?? null;
            if (!controlCapability) {
              return signalBusAgentRunnerHostFailure(
                new Error("Heartbeat request is missing server-issued Level-2 authority"),
              );
            }
            safetyMode = "trusted";
          } else if (
            workflowPolicy ||
            (params.surfaceProtocolResolver?.resolve(next.requestClient) ?? null) !== null
          ) {
            let capabilityOrigin: AuthenticatedSurfaceOrigin | undefined = next.authenticatedOrigin;
            if (trustedFallbackSurface) {
              const protocol = getBuiltinSurfaceProtocol(trustedFallbackSurface.platform);
              capabilityOrigin = {
                platform: protocol.platform,
                userId: trustedFallbackSurface.userId,
                sessionRef: protocol.refs.createSessionRef(trustedFallbackSurface.sessionId),
              } as AuthenticatedSurfaceOrigin;
            }
            const issuedControl = await params.issueControlCapability?.({
              requestId: next.requestId,
              sessionId: next.sessionId,
              requestClient: next.requestClient,
              profile: runProfile,
              canonicalCwd: workflowPolicy?.cwd ?? cwd,
              safetyMode,
              expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1_000,
              ...(capabilityOrigin ? { authenticatedOrigin: capabilityOrigin } : {}),
              ...(next.verifiedIngress === undefined
                ? {}
                : { verifiedIngress: next.verifiedIngress }),
            });
            if (!issuedControl) {
              return signalBusAgentRunnerHostFailure(
                new Error(
                  "Native profile request is missing server-issued Level-2 control authority",
                ),
              );
            }
            controlCapability = issuedControl.capability;
            safetyMode = issuedControl.safetyMode ?? safetyMode;
            if (issuedControl.authenticatedOrigin) {
              trustedFallbackSurface = {
                platform: issuedControl.authenticatedOrigin.platform,
                sessionId: issuedControl.authenticatedOrigin.sessionRef.channelId,
                userId: issuedControl.authenticatedOrigin.userId,
              };
            }
          }

          const additionalSessionPrompts = await waitForPreAgent(
            resolveSessionAdditionalPrompts({
              entries: cfg.surface.router.sessionModes[sessionConfigId]?.additionalPrompts,
              onWarn: (warning) => {
                logger.warn("skipping invalid session additionalPrompts entry", {
                  requestId: next.requestId,
                  sessionId,
                  sessionConfigId,
                  reason: warning.reason,
                  value: warning.value,
                  filePath: warning.filePath,
                  error: warning.error,
                });
              },
            }),
          );

          const heartbeatOverlay = buildHeartbeatOverlayForRequest({
            cfg,
            requestId: next.requestId,
            sessionId: next.sessionId,
            runProfile,
            nowMs: Date.now(),
          });

          const autoInjectedThreadSearchOverlay = buildAutoInjectedThreadSearchOverlay({
            cfg,
            runProfile,
          });

          const surfaceMetadataOverlay = buildSurfaceMetadataOverlay(next.messages);

          const restrictedSessionOverlay =
            safetyMode === "restricted"
              ? buildRestrictedSessionOverlay({ sessionId: next.sessionId })
              : null;

          const buildSystemPrompt = (
            resolved: ResolvedModelRef,
            editingToolMode: ReturnType<typeof resolveEditingToolMode>,
          ): string => {
            const profilePrompt = {
              baseSystemPrompt: cfg.agent.systemPrompt,
              activeEditingTool: runProfile === "explore" ? null : editingToolMode,
              exploreOverlay: subagents.profiles.explore.promptOverlay,
              generalOverlay: subagents.profiles.general.promptOverlay,
              selfOverlay: subagents.profiles.self.promptOverlay,
              skillsSection,
            };
            const baseSystemPrompt =
              runProfile === "primary"
                ? buildSystemPromptForProfile({ ...profilePrompt, profile: "primary" })
                : buildSystemPromptForProfile({
                    ...profilePrompt,
                    profile: runProfile,
                    profileConfig: resolveNativeSubagentProfile(cfg, runProfile),
                  });
            let prompt = appendConfiguredAliasPromptBlock({
              baseSystemPrompt,
              cfg,
              coreConfigPath: resolveCoreConfigPath(),
            });
            prompt = appendAdditionalSessionMemoBlock(prompt, additionalSessionPrompts);
            for (const overlay of [
              heartbeatOverlay,
              autoInjectedThreadSearchOverlay,
              surfaceMetadataOverlay,
              restrictedSessionOverlay,
            ]) {
              if (overlay?.trim()) prompt = `${prompt}\n\n${overlay}`;
            }
            return maybeAppendResponseCommentaryPrompt({
              baseSystemPrompt: prompt,
              provider: resolved.provider,
              responseCommentary: resolved.responseCommentary,
            });
          };

          let seededSessionMessages: ModelMessage[] = [];
          let seededSessionTranscript: TranscriptSnapshot | null = null;
          if (!next.recovery && runProfile !== "primary" && params.transcriptStore) {
            const loadedTranscript = await captureBusAgentRunnerOperation(
              "subagent continuation transcript load",
              () =>
                stableNamedContinuation
                  ? params.transcriptStore?.getLatestCompleteNamedTranscript?.({
                      requestClient: stableNamedContinuation.requestClient,
                      sessionId: next.sessionId,
                    })
                  : params.transcriptStore?.getLatestTranscriptBySession?.({
                      sessionId: next.sessionId,
                    }),
            );
            if (loadedTranscript.status === "ok" && loadedTranscript.value?.status === "ok") {
              const latest = loadedTranscript.value.value;
              if (latest && latest.messages.length > 0) {
                seededSessionMessages = latest.messages;
                seededSessionTranscript = latest;
                logger.info("subagent continuation seeded from transcript", {
                  requestId: next.requestId,
                  sessionId: next.sessionId,
                  fromRequestId: latest.requestId,
                  messagesSeeded: latest.messages.length,
                });
              }
            } else if (loadedTranscript.status === "error") {
              logger.warn(
                "failed to load subagent continuation transcript",
                formatBridgeTaggedErrorForLog(loadedTranscript.error, {
                  requestId: next.requestId,
                  sessionId: next.sessionId,
                }),
              );
            } else if (loadedTranscript.value?.status === "error") {
              logger.warn(
                "failed to decode subagent continuation transcript",
                formatBridgeTaggedErrorForLog(loadedTranscript.value.error, {
                  requestId: next.requestId,
                  sessionId: next.sessionId,
                }),
              );
            }
          }

          const fallbackSurfaceForDelegation = trustedFallbackSurface;
          const executionCwd = path.resolve(workflowPolicy?.cwd ?? cwd);
          let currentTurnUserId = next.currentTurnUserId;
          const listSelectedCatalogIds = () =>
            params.transcriptStore?.listSessionToolIds?.({
              requestClient: next.requestClient,
              sessionId: next.sessionId,
            }) ?? [];
          const buildModelBinding = async (resolved: ResolvedModelRef) => {
            let capabilityInfo: ModelCapabilityInfo | null = null;
            let bindingCostEstimateStatus: "estimated" | "unavailable" = "unavailable";
            let bindingCostEstimateReason: string | undefined;
            const capability = await captureBusAgentRunnerOperation(
              "model capability resolution",
              () => waitForPreAgent(modelCapability.resolve(resolved.spec)),
            );
            if (capability.status === "ok") {
              capabilityInfo = capability.value;
              if (capabilityInfo.cost) {
                bindingCostEstimateStatus = "estimated";
              } else {
                bindingCostEstimateReason = "model_cost_missing";
              }
            } else {
              if (capability.error.failureKind === "pre-agent-cancelled") {
                return Result.err(capability.error);
              }
              bindingCostEstimateReason = `capability_resolve_failed:${capability.error.message}`;
            }

            const editingToolMode = resolveEditingToolMode({
              provider: resolved.provider,
              modelId: resolved.modelId,
            });
            const anthropicModel = isAnthropicModelSpec(resolved.spec);
            const anthropicPromptCachingEnabled = shouldEnableAnthropicPromptCache({
              spec: resolved.spec,
              anthropicPromptCache: resolved.anthropicPromptCache,
            });
            const reasoningDisplay =
              resolved.reasoningDisplay ??
              workflowPolicy?.resolvedModelRequest.reasoningDisplay ??
              cfg.agent.reasoningDisplay;
            const providerOptionsWithOpenAIReasoningSummary =
              withReasoningSummaryDefaultForOpenAIModels({
                reasoningDisplay,
                provider: resolved.provider,
                modelId: resolved.modelId,
                providerOptions: resolved.providerOptions,
              });
            const providerOptionsWithReasoningDisplay =
              withReasoningDisplayDefaultForAnthropicModels({
                reasoningDisplay,
                provider: resolved.provider,
                modelId: resolved.modelId,
                providerOptions: providerOptionsWithOpenAIReasoningSummary,
              });
            const providerOptionsWithPromptCacheKey =
              resolved.provider === "openai" || resolved.provider === "codex"
                ? withOpenAIPromptCacheKey(
                    providerOptionsWithReasoningDisplay,
                    toOpenAIPromptCacheKey(sessionId),
                  )
                : providerOptionsWithReasoningDisplay;
            const providerOptionsWithServerCompaction = resolved.openaiServerCompaction
              ? withOpenAIServerCompaction(providerOptionsWithPromptCacheKey)
              : providerOptionsWithPromptCacheKey;
            const providerOptionsForAgent = anthropicModel
              ? withStableAnthropicUpstreamOrder(
                  resolved.provider,
                  providerOptionsWithServerCompaction,
                )
              : providerOptionsWithServerCompaction;
            const systemPrompt = buildSystemPrompt(resolved, editingToolMode);
            const agentSystem = anthropicPromptCachingEnabled
              ? {
                  role: "system" as const,
                  content: systemPrompt,
                  providerOptions: ANTHROPIC_PROMPT_CACHE_PROVIDER_OPTIONS,
                }
              : systemPrompt;
            const experimentalDownload = buildExperimentalDownloadForAnthropicFallback({
              spec: resolved.spec,
              provider: resolved.provider,
              providerOptions: providerOptionsForAgent,
            });
            const level1RequestContext = {
              requestId: next.requestId,
              sessionId: next.sessionId,
              requestClient: next.requestClient,
              subagentDepth: subagentMeta.depth,
              subagentProfile: runProfile,
              safetyMode,
              ...(trustedFallbackSurface
                ? {
                    requestInitiator: {
                      platform: trustedFallbackSurface.platform,
                      userId: trustedFallbackSurface.userId,
                    },
                    requestInitiatorSessionId: trustedFallbackSurface.sessionId,
                  }
                : {}),
              currentTurnUserId,
              metadata: {
                controlCapability: controlCapability ?? undefined,
                readFileDirectAttachmentSupported:
                  supportsReadFileDirectAttachments(capabilityInfo),
                onActivity: (source: "tool" | "subagent") => markRunActivity(source),
                onSubagentDelegate:
                  workflowSubagentDispatcher && liveParentSession && fallbackSurfaceForDelegation
                    ? async (registration: SubagentDelegationRegistration) =>
                        await workflowSubagentDispatcher.delegate({
                          ...registration,
                          projectRoot: executionCwd,
                          fallbackSurface: fallbackSurfaceForDelegation,
                        })
                    : undefined,
              },
            };
            const builtToolset = await waitForPreAgent(
              params.pluginManager.buildLevel1ToolsetResult({
                cwd: executionCwd,
                runProfile,
                editingToolMode: runProfile === "explore" ? "none" : editingToolMode,
                subagentDepth: subagentMeta.depth,
                subagentConfig: {
                  enabled: subagents.enabled,
                  idleTimeoutMs: deriveSubagentIdleTimeoutMs(cfg.agent.idleTimeoutMs),
                  maxDepth: subagents.maxDepth,
                },
                requestContext: level1RequestContext,
                reportToolStatus: (update) => {
                  void publishAuxiliaryOutput("failed to publish batch tool status", () =>
                    outputPublisher.publishToolCall(update),
                  );
                },
              }),
            );
            level1RequestContext.currentTurnUserId = currentTurnUserId;
            if (builtToolset.status === "error") return Result.err(builtToolset.error);
            const toolset = builtToolset.value;
            return Result.ok({
              resolved,
              capabilityInfo,
              costEstimateStatus: bindingCostEstimateStatus,
              costEstimateReason: bindingCostEstimateReason,
              editingToolMode,
              anthropicPromptCachingEnabled,
              providerOptionsForAgent,
              agentSystem,
              experimentalDownload,
              toolset,
              requestContext: level1RequestContext,
              activeToolNames: selectedLevel1ToolNames(toolset, listSelectedCatalogIds()),
            });
          };

          const initialBinding = await waitForPreAgent(buildModelBinding(initialResolvedModel));
          if (initialBinding.status === "error") {
            return signalBusAgentRunnerHostFailure(initialBinding.error);
          }
          let activeBinding = initialBinding.value;
          modelCapabilityInfo = activeBinding.capabilityInfo;
          costEstimateStatus = activeBinding.costEstimateStatus;
          costEstimateReason = activeBinding.costEstimateReason;

          logger.info(
            "agent run starting",
            formatBridgeLogContext({
              requestId: next.requestId,
              runProfile,
              safetyMode,
              model: activeBinding.resolved.spec,
              isRecoveryResume: Boolean(next.recovery),
            }),
          );

          let agent: AiSdkPiAgent<ToolSet> | null = null;
          let activeModelIndex = 0;
          let didSwitchModel = false;
          const advanceModel = async () => {
            if (!agent) {
              return signalBusAgentRunnerHostFailure(
                new Error("Model fallback started before the agent was ready"),
              );
            }
            const nextFallback = selectNextNativeModelFallback({
              plan: modelPlan,
              activeIndex: activeModelIndex,
              onSkipClaudeCode: (candidate, index) => {
                logger.warn("skipping claude-code model fallback for native agent run", {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  modelSpec: candidate.spec,
                  fallbackIndex: index,
                });
              },
            });
            if (!nextFallback) return { ok: false as const, reason: "model fallback exhausted" };

            const builtNextBinding = await buildModelBinding(nextFallback.candidate);
            if (builtNextBinding.status === "error") {
              return signalBusAgentRunnerHostFailure(builtNextBinding.error);
            }
            const nextBinding = builtNextBinding.value;
            nextBinding.toolset.updateActiveBatchTools(nextBinding.activeToolNames);
            agent.setModel(
              nextBinding.resolved.model,
              nextBinding.providerOptionsForAgent,
              nextBinding.resolved.spec,
              nextBinding.resolved.reasoning,
            );
            agent.setSystem(nextBinding.agentSystem);
            agent.setTools(nextBinding.toolset.tools);
            agent.setActiveTools(nextBinding.activeToolNames);
            agent.setExperimentalDownload(nextBinding.experimentalDownload);
            agent.setGenericOutputNormalizerBypassTools(
              nextBinding.toolset.genericOutputNormalizerBypassTools,
            );
            agent.setAggregateOutputBudgetExemptTools(
              nextBinding.toolset.aggregateOutputBudgetExemptTools,
            );

            activeBinding = nextBinding;
            activeModelIndex = nextFallback.index;
            didSwitchModel = true;
            modelCapabilityInfo = nextBinding.capabilityInfo;
            costEstimateStatus = nextBinding.costEstimateStatus;
            costEstimateReason = nextBinding.costEstimateReason;
            resolvedModelLabel = nextBinding.resolved.modelId;
            resolvedProviderFamily = classifyHistoryProviderFamily({
              type: nextBinding.resolved.provider,
            });
            if (state.activeRun) {
              state.activeRun.resolvedModelSpec = nextBinding.resolved.spec;
              state.activeRun.resolvedReasoning = nextBinding.resolved.reasoning;
              state.activeRun.resolvedProviderFamily = resolvedProviderFamily;
            }
            return { ok: true as const, modelSpec: nextBinding.resolved.spec };
          };
          const hasNativeModelFallback =
            activeBinding.resolved.provider !== "claude-code" && modelPlan.fallbacks.length > 0;
          const transientRetryController = createTransientModelRetryController({
            retry: cfg.agent.retry,
            logger,
            requestId: headers.request_id,
            sessionId: headers.session_id,
            modelSpec: activeBinding.resolved.spec,
            ...(hasNativeModelFallback ? { advanceModel } : {}),
          });
          const disabledServerCompactionReplayKeys = new Set<string>();
          let activeNativeServerCompactionReplayKey: string | null = null;
          const turnErrorHandler = async (
            error: unknown,
            errorContext: Parameters<
              NonNullable<Parameters<typeof attachAutoCompaction>[1]["baseTurnErrorHandler"]>
            >[1],
          ) => {
            const projectedError = projectBusAgentRunnerError(error, "Model turn failed");
            const transientDecision = await transientRetryController.handler(error, errorContext);
            if (transientDecision === "retry") {
              await coreNamedClaudeRuntime?.retireForRetry();
              await corePrimaryClaudeRuntime?.retireForRetry();
              return "retry" as const;
            }
            if (
              activeNativeServerCompactionReplayKey &&
              errorContext.phase === "model-call" &&
              errorContext.retrySafety.canRetry &&
              errorContext.abortSignal?.aborted !== true
            ) {
              disabledServerCompactionReplayKeys.add(activeNativeServerCompactionReplayKey);
              logger.warn(
                "OpenAI server compaction replay failed; retrying portable summary",
                formatBridgeLogContext({
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  modelSpec: activeBinding.resolved.spec,
                  ...projectedError.details,
                  error: projectedError.message,
                }),
              );
              activeNativeServerCompactionReplayKey = null;
              return "retry" as const;
            }
            return "fail" as const;
          };
          if (activeBinding.resolved.provider === "claude-code") {
            const claudeCodeToolMapping = completeLevel1ToolMapping(activeBinding.toolset);
            const continuationStore = params.transcriptStore;
            const materializeClaude = async (
              nativeSession?: Parameters<typeof materializeClaudeCodeRunResult>[0]["nativeSession"],
            ) => {
              const options = {
                modelId: activeBinding.resolved.modelId,
                cwd: executionCwd,
                tools: claudeCodeToolMapping.tools,
                catalogMetadata: claudeCodeToolMapping.catalogMetadata,
                // Core admits no Claude built-ins; Lilac remains the only tool source.
                builtInTools: [],
                reasoning: activeBinding.resolved.reasoning,
                ...(nativeSession ? { nativeSession } : {}),
                execute: async (request) => {
                  if (!activeAgent) {
                    return signalBusAgentRunnerHostFailure(
                      new Error("Claude Code tool execution started before the agent was ready"),
                    );
                  }
                  return await activeAgent.executeExternalToolCall(request);
                },
              } satisfies Parameters<typeof materializeClaudeCodeRunResult>[0];
              const materialized = params.materializeClaudeCodeRun
                ? Result.ok(await params.materializeClaudeCodeRun(options))
                : await materializeClaudeCodeRunResult(options);
              if (materialized.status === "error") {
                switch (materialized.error._tag) {
                  case "ClaudeCodeRunInvalidConfiguration":
                  case "ClaudeNativeSessionPreflightError":
                  case "ClaudeCodeRunExternalFailure":
                  case "ClaudeCodeBuiltInToolUnsupported":
                  case "ClaudeCodeToolBridgeConfigurationFailed":
                  case "ClaudeCodeRunOperationAndCleanupFailed":
                    throw materialized.error;
                }
              }
              const run = materialized.value;
              if (state.activeRun) state.activeRun.claudeCodeControl = run.control;
              return run;
            };
            const shouldPersistClaude = shouldUsePersistentCoreClaudeRuntime({
              runProfile,
              requestClient: next.requestClient,
              stableNamedContinuation,
              corePrimaryLineage: state.activeRun?.corePrimaryLineage ?? next.corePrimaryLineage,
            });
            if (shouldPersistClaude && continuationStore !== undefined) {
              const canonicalCwdResult = await captureBusAgentRunnerOperation(
                "Claude execution cwd canonicalization",
                () => fs.realpath(executionCwd),
              );
              const canonicalExecutionCwd =
                canonicalCwdResult.status === "ok"
                  ? canonicalCwdResult.value
                  : path.resolve(executionCwd);
              const nativeStorageNamespace = path.resolve(
                process.env["CLAUDE_CONFIG_DIR"] ?? path.join(homedir(), ".claude"),
              );
              const profileConfig =
                runProfile === "primary" ? null : resolveNativeSubagentProfile(cfg, runProfile);
              const executionScope = hashCoreNamedExecutionScope({
                canonicalCwd: canonicalExecutionCwd,
                providerIdentity: "core:claude-code",
                nativeStorageNamespaceIdentity: nativeStorageNamespace,
                nativeExecutableConfig: claudeCodeExecutableSettings(),
                profile: runProfile,
                safetyMode,
                profileAuthority: {
                  level1: profileConfig?.level1 ?? null,
                  level2: profileConfig?.level2 ?? null,
                  network: profileConfig?.network ?? null,
                  workspaceWrites: profileConfig?.workspaceWrites ?? null,
                  execution:
                    profileConfig === null
                      ? null
                      : coreProfileExecutionScopeAuthority(profileConfig.execution),
                  delegation: profileConfig?.delegation ?? null,
                },
                pluginAuthority: cfg.plugins ?? null,
                workflowAuthority: workflowPolicy
                  ? {
                      profile: workflowPolicy.profile,
                      cwd: workflowPolicy.cwd,
                      originClient: workflowPolicy.originSession.client,
                    }
                  : null,
                systemPolicy: {
                  base: cfg.agent.systemPrompt,
                  profileOverlay: profileConfig?.promptOverlay ?? null,
                  additionalSessionPrompts,
                  skillsSection,
                },
                directToolNames: [...activeBinding.toolset.directToolNames],
                externalToolAuthority: activeBinding.toolset.catalog
                  .map((entry) => ({
                    source: entry.source,
                    sourceId: entry.sourceId,
                    stableId: entry.stableId,
                    modelName: entry.modelName,
                  }))
                  .sort((left, right) => left.stableId.localeCompare(right.stableId)),
                subagentAuthority: {
                  enabled: subagents.enabled,
                  maxDepth: subagents.maxDepth,
                  currentDepth: subagentMeta.depth,
                },
              });
              if (
                runProfile === "primary" &&
                next.requestClient === "discord" &&
                supportsCorePrimaryContinuationStore(continuationStore)
              ) {
                const createdPrimaryRuntime = createCorePrimaryClaudeRuntimeResult({
                  store: continuationStore,
                  sessionId: next.sessionId,
                  requestId: next.requestId,
                  providerId: activeBinding.resolved.provider,
                  modelSpecifier: activeBinding.resolved.spec,
                  reasoning: activeBinding.resolved.reasoning ?? "provider-default",
                  executionScopeHash: executionScope.hash,
                  executionCwd,
                  getLineage: () => state.activeRun?.corePrimaryLineage ?? next.corePrimaryLineage,
                  materialize: (nativeSession) => waitForPreAgent(materializeClaude(nativeSession)),
                  onDiagnostic: (event, detail, error) => {
                    const fields = formatClaudeLifecycleLogFields(event, detail, error);
                    if (
                      event === "native-source-invalid" ||
                      event === "candidate-observability-lost" ||
                      event === "candidate-unpromotable" ||
                      event === "candidate-finalization-failed" ||
                      event === "canonical-publication-failed" ||
                      event === "promotion-failed" ||
                      event === "promotion-rejected"
                    ) {
                      logger.warn("core_primary_claude.lifecycle", fields);
                    } else if (event === "canonical-published" || event === "promotion") {
                      logger.info("core_primary_claude.lifecycle", fields);
                    } else {
                      logger.debug("core_primary_claude.lifecycle", fields);
                    }
                  },
                });
                if (createdPrimaryRuntime.status === "error") {
                  return signalBusAgentRunnerHostFailure(createdPrimaryRuntime.error);
                }
                corePrimaryClaudeRuntime = createdPrimaryRuntime.value;
              } else if (
                stableNamedContinuation !== null &&
                supportsCoreNamedContinuationStore(continuationStore)
              ) {
                const createdNamedRuntime = createCoreNamedClaudeRuntimeResult({
                  store: continuationStore,
                  requestClient: stableNamedContinuation.requestClient,
                  sessionId: next.sessionId,
                  requestId: next.requestId,
                  providerId: activeBinding.resolved.provider,
                  modelSpecifier: activeBinding.resolved.spec,
                  reasoning: activeBinding.resolved.reasoning ?? "provider-default",
                  executionScopeHash: executionScope.hash,
                  executionCwd,
                  sourceTranscript: seededSessionTranscript,
                  getCurrentTurnMessages: () => initialMessages,
                  materialize: (nativeSession) => waitForPreAgent(materializeClaude(nativeSession)),
                  onDiagnostic: (event, detail, error) => {
                    const fields = formatClaudeLifecycleLogFields(event, detail, error);
                    if (
                      event === "native-source-invalid" ||
                      event === "candidate-observability-lost" ||
                      event === "candidate-unpromotable" ||
                      event === "candidate-finalization-failed" ||
                      event === "canonical-publication-failed" ||
                      event === "promotion-failed" ||
                      event === "promotion-rejected"
                    ) {
                      logger.warn("core_named_claude.lifecycle", fields);
                    } else if (event === "canonical-published" || event === "promotion") {
                      logger.info("core_named_claude.lifecycle", fields);
                    } else {
                      logger.debug("core_named_claude.lifecycle", fields);
                    }
                  },
                });
                if (createdNamedRuntime.status === "error") {
                  return signalBusAgentRunnerHostFailure(createdNamedRuntime.error);
                }
                coreNamedClaudeRuntime = createdNamedRuntime.value;
              } else {
                claudeCodeRun = await waitForPreAgent(materializeClaude());
              }
            } else {
              claudeCodeRun = await waitForPreAgent(materializeClaude());
            }
          }

          const agentOptions: AiSdkPiAgentOptions<ToolSet> = {
            system: activeBinding.agentSystem,
            model: claudeCodeRun?.agentModel ?? activeBinding.resolved.model,
            modelSpecifier: activeBinding.resolved.spec,
            messages: next.recovery?.checkpointMessages ?? seededSessionMessages,
            tools: activeBinding.toolset.tools,
            providerOptions: activeBinding.providerOptionsForAgent,
            reasoning: activeBinding.resolved.reasoning,
            ...(hasNativeModelFallback ||
            coreNamedClaudeRuntime !== null ||
            corePrimaryClaudeRuntime !== null
              ? { streamTextMaxRetries: 0 }
              : {}),
            turnErrorHandler,
            beforeStep:
              activeBinding.resolved.provider !== "claude-code"
                ? async () => {
                    if (!agent) {
                      return signalBusAgentRunnerHostFailure(
                        new Error("Tool refresh started before the agent was ready"),
                      );
                    }
                    await refreshSelectedLevel1Tools({
                      target: agent,
                      toolset: activeBinding.toolset,
                      listSelectedCatalogIds,
                    });
                  }
                : undefined,
            normalizeToolResultOutput,
            normalizeSettledToolResultOutputs: normalizeToolResultOutput.normalizeSettled,
            genericOutputNormalizerBypassTools:
              activeBinding.toolset.genericOutputNormalizerBypassTools,
            aggregateOutputBudgetExemptTools:
              activeBinding.toolset.aggregateOutputBudgetExemptTools,
            experimentalDownload: activeBinding.experimentalDownload,
            sendToolsToModel: activeBinding.resolved.provider !== "claude-code",
            debug: {
              captureModelViewMessages: env.debug.contextDump.enabled,
            },
          };
          agent = params.createAgent
            ? params.createAgent(agentOptions)
            : new AiSdkPiAgent<ToolSet>(agentOptions);
          if (activeBinding.resolved.provider === "claude-code") {
            applyCompleteLevel1Tools(agent, activeBinding.toolset);
          }
          agent.setPrepareModelCall(
            coreNamedClaudeRuntime?.prepareModelCall ?? corePrimaryClaudeRuntime?.prepareModelCall,
          );
          activeAgent = agent;

          const setCurrentTurnUserId = (userId: string | undefined) => {
            currentTurnUserId = userId;
            if (state.activeRun) state.activeRun.currentTurnUserId = userId;
            activeBinding.requestContext.currentTurnUserId = userId;
            agent?.setContext({
              sessionId: next.sessionId,
              requestId: next.requestId,
              requestClient: next.requestClient,
              subagentDepth: subagentMeta.depth,
              subagentProfile: runProfile,
              safetyMode,
              ...(trustedFallbackSurface
                ? {
                    requestInitiator: {
                      platform: trustedFallbackSurface.platform,
                      userId: trustedFallbackSurface.userId,
                    },
                    requestInitiatorSessionId: trustedFallbackSurface.sessionId,
                  }
                : {}),
              currentTurnUserId: userId,
            });
          };
          setCurrentTurnUserId(next.currentTurnUserId);
          if (state.activeRun) state.activeRun.setCurrentTurnUserId = setCurrentTurnUserId;

          // Drain all buffered messages at boundaries (better UX in chat surfaces).
          agent.setFollowUpMode("all");
          agent.setSteeringMode("all");

          const prepareModelView = async (
            messages: readonly ModelMessage[],
            transformContext: TransformMessagesContext,
            fullBudget: boolean,
          ): Promise<ModelMessage[]> => {
            const configuredServerCompactionReplayKey = activeBinding.resolved
              .openaiServerCompaction
              ? `${activeBinding.resolved.provider}:${activeBinding.resolved.spec}`
              : undefined;
            const serverCompactionReplayKey =
              configuredServerCompactionReplayKey &&
              !disabledServerCompactionReplayKeys.has(configuredServerCompactionReplayKey)
                ? configuredServerCompactionReplayKey
                : undefined;
            activeNativeServerCompactionReplayKey = null;
            if (
              configuredServerCompactionReplayKey &&
              hasMatchingOpenAIServerCompaction(messages, serverCompactionReplayKey)
            ) {
              activeNativeServerCompactionReplayKey = serverCompactionReplayKey ?? null;
            }
            const materialized =
              configuredServerCompactionReplayKey || hasOpenAIServerCompaction(messages)
                ? materializeOpenAIServerCompaction(messages, serverCompactionReplayKey)
                : messages;
            const targetFamily = classifyHistoryProviderFamily({
              type: activeBinding.resolved.provider,
            });
            let historyPrepared: readonly ModelMessage[];
            if (coreNamedClaudeRuntime) {
              historyPrepared = coreNamedClaudeRuntime.prepareHistoryView(materialized);
            } else if (corePrimaryClaudeRuntime) {
              historyPrepared = fullBudget
                ? corePrimaryClaudeRuntime.prepareFullBudgetView(
                    materialized,
                    transformContext.canonicalStartIndex,
                  )
                : corePrimaryClaudeRuntime.prepareHistoryView(materialized);
            } else {
              switch (runProfile) {
                case "primary": {
                  const lineage = state.activeRun?.corePrimaryLineage ?? next.corePrimaryLineage;
                  const historicalEnd = lineage?.currentCanonicalStart ?? 0;
                  historyPrepared = prepareCorePrimaryHistoryView({
                    canonicalMessages: materialized,
                    lineage,
                    replayHistoricalPrefix: shouldReplayCorePrimaryHistory({
                      lineage,
                      historicalEnd,
                      store: params.transcriptStore ?? {},
                      targetFamily,
                    }),
                    targetFamily,
                    modelSpecifier: activeBinding.resolved.spec,
                    canonicalStartIndex: transformContext.canonicalStartIndex,
                  });
                  break;
                }
                case "explore":
                case "general":
                case "self":
                  historyPrepared = stableNamedContinuation
                    ? prepareCoreNamedHistoryView({
                        canonicalMessages: materialized,
                        sourceMessages: seededSessionMessages,
                        currentTurnMessages: initialMessages,
                        replayHistoricalPrefix: shouldReplayCoreNamedHistory({
                          sourceTranscript: seededSessionTranscript,
                          targetFamily,
                        }),
                        targetFamily,
                        modelSpecifier: activeBinding.resolved.spec,
                      })
                    : materialized;
                  break;
                default: {
                  const _exhaustive: never = runProfile;
                  historyPrepared = _exhaustive;
                  break;
                }
              }
            }
            if (
              configuredServerCompactionReplayKey &&
              disabledServerCompactionReplayKeys.has(configuredServerCompactionReplayKey) &&
              hasMatchingOpenAIServerCompaction(messages, configuredServerCompactionReplayKey)
            ) {
              agent.replaceMessages(materializeOpenAIServerCompaction(messages, undefined), {
                reason: "compaction",
                preserveRecoveryCheckpoint: true,
              });
              disabledServerCompactionReplayKeys.delete(configuredServerCompactionReplayKey);
            }
            // First, remove pathological binary blobs from the *model-facing* view.
            const scrubbed = scrubLargeBinaryForModelView(historyPrepared, {
              maxBytesPerPart: cfg.tools.media.maxInlineBytesPerPart,
              maxBytesTotal: cfg.tools.media.maxInlineBytesTotal,
            });

            // Then, compact older tool outputs (placeholder) with session-stable state.
            if (cfg.tools.historicalResultPruning.enabled) {
              const estimatedPrunedTokens = maybeMarkOldToolOutputsCompacted({
                messages: scrubbed,
                compactedToolCallIds: state.compactedToolCallIds,
                protectTokens: cfg.tools.historicalResultPruning.protectTokens,
                minimumTokens: cfg.tools.historicalResultPruning.minimumTokens,
              });
              if (estimatedPrunedTokens > 0) {
                logger.info("agent.historical_result_pruned", {
                  requestId: next.requestId,
                  sessionId: next.sessionId,
                  compactedToolCallCount: state.compactedToolCallIds.size,
                  estimatedPrunedTokens,
                });
              }
            }

            const compacted = cfg.tools.historicalResultPruning.enabled
              ? applyToolOutputCompactionView({
                  messages: scrubbed,
                  compactedToolCallIds: state.compactedToolCallIds,
                })
              : scrubbed;

            return compacted;
          };
          const toolPruneTransform: PrepareFullModelView = (messages, transformContext) =>
            prepareModelView(messages, transformContext, false);
          const fullBudgetTransform: PrepareFullModelView = (messages, transformContext) =>
            prepareModelView(messages, transformContext, true);
          // History protocol safety is required even when automatic compaction is disabled.
          agent.setPrepareFullModelView(toolPruneTransform);
          agent.setPrepareFullBudgetView(fullBudgetTransform);

          let autoCompactionSeq = 0;
          let activeAutoCompactionToolCallId: string | null = null;
          const publishAutoCompactionToolStatus = (update: {
            toolCallId: string;
            status: "start" | "end";
            display: string;
            ok?: boolean;
            error?: string;
          }) => {
            const publishOne = async () => {
              await publishAuxiliaryOutput("failed to publish auto-compaction tool status", () =>
                outputPublisher.publishToolCall(update),
              );
            };

            auxiliaryOutputTail = auxiliaryOutputTail.then(publishOne);
          };
          const reportServerCompactionError = (cause: unknown): void => {
            const error = projectBusAgentRunnerError(cause, "OpenAI server compaction failed");
            logger.warn(
              "OpenAI server compaction failed; using portable summary",
              formatBridgeLogContext({
                requestId: headers.request_id,
                sessionId: headers.session_id,
                modelSpec: activeBinding.resolved.spec,
                ...error.details,
                error: error.message,
              }),
            );
          };
          const resolveClaudeCompactionSummaryModel = (): LanguageModel =>
            resolveCoreClaudeCompactionSummaryModel({
              run:
                claudeCodeRun ??
                coreNamedClaudeRuntime?.currentRun() ??
                corePrimaryClaudeRuntime?.currentRun() ??
                null,
              fallback: () => activeBinding.resolved.model,
              onFailure: (error) => {
                logger.warn(
                  "Claude utility model construction failed; using model fallback",
                  formatBridgeTaggedErrorForLog(error, {
                    requestId: headers.request_id,
                    sessionId: headers.session_id,
                    modelSpec: activeBinding.resolved.spec,
                    operation: error.operation,
                  }),
                );
              },
            });

          unsubscribeCompaction = await waitForPreAgent(
            attachAutoCompaction(agent, {
              model: activeBinding.resolved.spec,
              summaryModel:
                activeBinding.resolved.provider === "claude-code"
                  ? resolveClaudeCompactionSummaryModel
                  : "current",
              modelCapability,
              thresholdInputSource:
                activeBinding.resolved.provider === "claude-code" ? "transcript-estimate" : "usage",
              resolveCurrentModelSpecifier: () =>
                agent.state.modelSpecifier ?? activeBinding.resolved.spec,
              prepareFullModelView: toolPruneTransform,
              prepareFullBudgetView: fullBudgetTransform,
              inputEstimateFloor:
                coreNamedClaudeRuntime === null && corePrimaryClaudeRuntime === null
                  ? undefined
                  : ({ canonicalMessages, overlay, estimateMessagesTokens }) =>
                      (coreNamedClaudeRuntime ?? corePrimaryClaudeRuntime)?.inputEstimateFloor({
                        canonicalMessages,
                        overlay,
                        estimateMessagesTokens,
                      }) ?? null,
              resolveCurrentInputCanonicalStart: () =>
                (state.activeRun?.corePrimaryLineage ?? next.corePrimaryLineage)
                  ?.currentCanonicalStart ?? null,
              decorateRequestPayload: (payload) => {
                const requestPayload =
                  payload.length === 0 && (coreNamedClaudeRuntime || corePrimaryClaudeRuntime)
                    ? ([
                        {
                          role: "user",
                          content: "Continue after the completed tool call.",
                        },
                      ] satisfies ModelMessage[])
                    : [...payload];
                return activeBinding.anthropicPromptCachingEnabled
                  ? withProviderOptionsOnLastUserMessage(
                      requestPayload,
                      ANTHROPIC_PROMPT_CACHE_PROVIDER_OPTIONS,
                    )
                  : requestPayload;
              },
              baseTurnErrorHandler: turnErrorHandler,
              serverCompaction: async ({
                messages: prefix,
                portableSummary,
                context: modelContext,
                abortSignal,
              }) => {
                if (!activeBinding.resolved.openaiServerCompaction) {
                  return signalBusAgentRunnerHostFailure(
                    new Error("OpenAI server compaction is disabled for the active model"),
                  );
                }
                const compacted = await compactWithOpenAIResponsesResult({
                  model: agent.state.model,
                  replayKey: `${activeBinding.resolved.provider}:${activeBinding.resolved.spec}`,
                  portableSummary,
                  messages: prefix,
                  system: modelContext?.system ?? agent.state.system,
                  tools: modelContext?.tools,
                  providerOptions: agent.state.providerOptions,
                  reasoning: agent.state.reasoning,
                  abortSignal,
                });
                if (compacted.status === "error") {
                  switch (compacted.error._tag) {
                    case "OpenAIServerCompactionAborted":
                    case "OpenAIServerCompactionRequestFailed":
                    case "OpenAIServerCompactionOutputInvalid":
                      throw compacted.error;
                  }
                }
                return compacted.value;
              },
              serverCompactionEnabled: () => {
                if (!activeBinding.resolved.openaiServerCompaction) return false;
                const replayKey = `${activeBinding.resolved.provider}:${activeBinding.resolved.spec}`;
                return !disabledServerCompactionReplayKeys.has(replayKey);
              },
              onServerCompactionError: reportServerCompactionError,
              onUnknownCapability: ({ spec, reason, error }) => {
                logger.warn(
                  "auto-compaction capability unknown; disabling threshold compaction",
                  {
                    requestId: headers.request_id,
                    sessionId: headers.session_id,
                    modelSpec: spec,
                    reason,
                  },
                  error,
                );
              },
              onOverflowRecoveryAttempt: ({ spec, attempt, maxAttempts }) => {
                logger.info("auto-compaction overflow recovery retry", {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  modelSpec: spec,
                  attempt,
                  maxAttempts,
                });
              },
              onOverflowRecoveryExhausted: ({ spec, attempts, maxAttempts }) => {
                logger.warn("auto-compaction overflow recovery exhausted", {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  modelSpec: spec,
                  attempts,
                  maxAttempts,
                });
              },
              onCompactionStart: ({
                spec,
                reason,
                messageCountBefore,
                observedInputTokens,
                inputTokenSource,
                estimatedInputTokens,
                budget,
              }) => {
                autoCompactionSeq += 1;
                activeAutoCompactionToolCallId = buildSyntheticToolCallId({
                  prefix: "auto_compaction",
                  seed: `${headers.request_id}:${autoCompactionSeq}`,
                });

                publishAutoCompactionToolStatus({
                  toolCallId: activeAutoCompactionToolCallId,
                  status: "start",
                  display: formatAutoCompactionToolDisplay({
                    phase: "start",
                    messageCountBefore,
                  }),
                });

                logger.info("auto-compaction start", {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  subagentDepth: subagentMeta.depth,
                  modelSpec: spec,
                  reason,
                  messageCountBefore,
                  observedInputTokens,
                  inputTokenSource,
                  estimatedInputTokens,
                  inputBudget: budget.inputBudget,
                  safeInputBudget: budget.safeInputBudget,
                  reservedOutputTokens: budget.reservedOutputTokens,
                });
              },
              onCompactionEnd: ({
                spec,
                reason,
                messageCountBefore,
                messageCountAfter,
                estimatedInputTokens,
                estimatedInputTokensAfter,
                durationMs,
                status,
                error,
                canonicalReplacement,
              }) => {
                const toolCallId =
                  activeAutoCompactionToolCallId ??
                  buildSyntheticToolCallId({
                    prefix: "auto_compaction",
                    seed: `${headers.request_id}:orphan-end`,
                  });
                activeAutoCompactionToolCallId = null;

                publishAutoCompactionToolStatus({
                  toolCallId,
                  status: "end",
                  display: formatAutoCompactionToolDisplay({
                    phase: "end",
                    ok: status === "completed",
                    messageCountBefore,
                    messageCountAfter,
                  }),
                  ok: status === "completed",
                  error: status === "completed" ? undefined : "auto compaction failed",
                });

                const payload = {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  subagentDepth: subagentMeta.depth,
                  modelSpec: spec,
                  reason,
                  status,
                  durationMs,
                  messageCountBefore,
                  messageCountAfter,
                  estimatedInputTokens,
                  estimatedInputTokensAfter,
                };
                if (status === "completed") {
                  completedCompactionCount += 1;
                  if (runProfile === "primary" && next.requestClient === "discord") {
                    const previousLineage =
                      state.activeRun?.corePrimaryLineage ?? next.corePrimaryLineage;
                    const mappedCurrentStart = (() => {
                      if (!canonicalReplacement || !previousLineage) return 0;
                      return mapCorePrimaryCompactionCurrentCanonicalStart({
                        previousCurrentCanonicalStart: previousLineage.currentCanonicalStart,
                        replacement: canonicalReplacement,
                      });
                    })();
                    next.corePrimaryLineage = degradeCorePrimaryLineageForMutation(
                      "compaction-checkpoint-transform",
                      mappedCurrentStart,
                    );
                    if (state.activeRun)
                      state.activeRun.corePrimaryLineage = next.corePrimaryLineage;
                  }
                  logger.info("auto-compaction end", payload);
                  return;
                }
                logger.warn(
                  "auto-compaction end",
                  { ...payload, ...extractAiErrorLogDetails(error) },
                  error,
                );
              },
            }),
          );

          const publishedDeferredCompletionRunIds = new Set<string>();
          let lastBoundaryModelInputMessages: readonly ModelMessage[] = [];
          const drainDeferredCompletions = async (input: {
            modelInputMessages: readonly ModelMessage[];
            abortSignal?: AbortSignal;
          }): Promise<
            ResultType<
              { append: ModelMessage[]; forceNextTurn: boolean },
              BusAgentRunnerOperationFailed
            >
          > => {
            if (!liveParentSession) {
              return Result.ok({ append: [], forceNextTurn: false });
            }

            const pendingIdentities = liveParentSession.listPendingIdentities();
            const consumedBeforeMaterialization = pendingIdentities
              .filter((identity) =>
                hasConsumedDeferredSubagentResult(input.modelInputMessages, identity),
              )
              .map((identity) => identity.runId);
            if (consumedBeforeMaterialization.length > 0) {
              await liveParentSession.acknowledge(consumedBeforeMaterialization);
            }
            if (input.abortSignal?.aborted) {
              return Result.ok({ append: [], forceNextTurn: false });
            }

            const queried = await captureBusAgentRunnerOperation(
              "workflow subagent completion query",
              () => liveParentSession.listPendingSettledAsync(),
            );
            if (queried.status === "error") {
              logger.warn(
                "workflow subagent completion query failed; delivery remains pending",
                formatBridgeTaggedErrorForLog(queried.error, {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                }),
              );
              return Result.err(queried.error);
            }
            const settled = queried.value;

            if (input.abortSignal?.aborted) {
              return Result.ok({ append: [], forceNextTurn: false });
            }

            const completions: WorkflowLiveParentCompletion[] = [];
            for (const result of settled) {
              let completion: WorkflowLiveParentCompletion | null = null;
              let materializationError: BusAgentRunnerErrorProjection | undefined;
              if (result.loaded) {
                const normalized = await captureBusAgentRunnerOperation(
                  "workflow subagent completion materialization",
                  () =>
                    normalizeSubagentFinalText({
                      normalize: normalizeToolResultOutput,
                      finalText: result.completion.finalText,
                      toolCallId: buildSubagentResultToolCallId(result.completion.runId),
                    }),
                );
                if (normalized.status === "ok") {
                  completion = {
                    ...result.completion,
                    finalText: normalized.value,
                  };
                } else {
                  materializationError = {
                    message: normalized.error.message,
                    details: normalized.error.details,
                  };
                }
              } else {
                materializationError = projectBusAgentRunnerError(
                  result,
                  "Workflow subagent completion load failed",
                );
              }

              if (completion) {
                if (!liveParentSession.isPending(completion.runId)) continue;
                liveParentSession.clearMaterializationFailure(completion.runId);
                completions.push(completion);
                continue;
              }

              const identity = result.loaded ? result.completion : result.identity;
              const errorMessage =
                materializationError?.message ??
                "Workflow subagent completion materialization failed";
              const attempts = liveParentSession.recordMaterializationFailure(
                identity.runId,
                errorMessage,
              );
              logger.warn(
                "workflow subagent completion materialization failed",
                formatBridgeLogContext({
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  runId: identity.runId,
                  attempts,
                  maxAttempts: SUBAGENT_RESULT_MATERIALIZATION_ATTEMPTS,
                  errorMessage,
                }),
              );
              if (attempts === null || attempts < SUBAGENT_RESULT_MATERIALIZATION_ATTEMPTS)
                continue;
              if (!liveParentSession.isPending(identity.runId)) continue;

              completions.push({
                ...identity,
                status: "failed",
                ok: false,
                finalText: "",
                detail: `subagent result delivery failed after ${attempts} attempts: ${errorMessage}`,
              });
            }

            const deliverableCompletions = completions.filter((completion) =>
              liveParentSession.isPending(completion.runId),
            );

            const provisionalPlan = planDeferredSubagentBoundary({
              canonicalMessages: agent.state.messages,
              modelInputMessages: input.modelInputMessages,
              completions: deliverableCompletions,
            });

            for (const completion of deliverableCompletions) {
              if (!liveParentSession.isPending(completion.runId)) continue;
              if (publishedDeferredCompletionRunIds.has(completion.runId)) continue;
              const published = await captureBusAgentRunnerOperation(
                "workflow subagent completion publish",
                () =>
                  outputPublisher.publishToolCall({
                    toolCallId: completion.parentToolCallId,
                    status: "end",
                    display: buildDeferredSubagentDisplay(completion),
                    ok: completion.ok,
                    error: completion.ok
                      ? undefined
                      : (completion.detail ?? `subagent ${completion.status}`),
                  }),
              );
              if (published.status === "ok") {
                publishedDeferredCompletionRunIds.add(completion.runId);
              } else {
                logger.warn(
                  "workflow subagent completion publish failed",
                  formatBridgeTaggedErrorForLog(published.error, { runId: completion.runId }),
                );
              }
            }

            if (provisionalPlan.consumedRunIds.length > 0 && !input.abortSignal?.aborted) {
              await liveParentSession.acknowledge(provisionalPlan.consumedRunIds);
            }

            const finalPlan = planDeferredSubagentBoundary({
              canonicalMessages: agent.state.messages,
              modelInputMessages: input.modelInputMessages,
              completions: deliverableCompletions.filter((completion) =>
                liveParentSession.isPending(completion.runId),
              ),
            });
            if (
              finalPlan.append.length > 0 &&
              runProfile === "primary" &&
              next.requestClient === "discord"
            ) {
              next.corePrimaryLineage = degradeCorePrimaryLineageForMutation(
                "deferred-result-insertion",
                agent.state.messages.length,
              );
              if (state.activeRun) state.activeRun.corePrimaryLineage = next.corePrimaryLineage;
            }

            return Result.ok({
              append: finalPlan.append,
              forceNextTurn: finalPlan.forceNextTurn,
            });
          };
          const adaptDeferredDrainToHost = (
            drained: Awaited<ReturnType<typeof drainDeferredCompletions>>,
          ): { append: ModelMessage[]; forceNextTurn: boolean } => {
            if (drained.status === "error") return { append: [], forceNextTurn: false };
            return drained.value;
          };
          let pendingSilentTurnStartIndex: number | null = null;
          const removePendingSilentTurn = () => {
            if (pendingSilentTurnStartIndex === null) return;
            const startIndex = pendingSilentTurnStartIndex;
            pendingSilentTurnStartIndex = null;
            const hasAssistantMessage = agent.state.messages
              .slice(startIndex)
              .some((message) => message.role === "assistant");
            if (!hasAssistantMessage) return;

            const messages = removeSilentAssistantTurnMessages({
              messages: agent.state.messages,
              startIndex,
              messageCount: agent.state.messages.length - startIndex,
            });
            if (runProfile === "primary" && next.requestClient === "discord") {
              const currentCanonicalStart =
                state.activeRun?.corePrimaryLineage?.currentCanonicalStart ??
                next.corePrimaryLineage?.currentCanonicalStart ??
                startIndex;
              next.corePrimaryLineage = degradeCorePrimaryLineageForMutation(
                "silent-turn-removal",
                currentCanonicalStart,
              );
              if (state.activeRun) state.activeRun.corePrimaryLineage = next.corePrimaryLineage;
            }
            agent.replaceMessages(messages);
          };

          agent.setTurnBoundaryHandler(async (context) => {
            await coreNamedClaudeRuntime?.recordSuccessfulModelCall(agent.state.messages);
            await corePrimaryClaudeRuntime?.recordSuccessfulModelCall(agent.state.messages);
            removePendingSilentTurn();

            lastBoundaryModelInputMessages = context.modelInputMessages;
            const drained = await drainDeferredCompletions({
              modelInputMessages: context.modelInputMessages,
              abortSignal: context.abortSignal,
            });
            return adaptDeferredDrainToHost(drained);
          });

          state.agent = agent;

          let finalText = "";
          let stableFinalText = "";
          let stablePartialText = state.activeRun?.partialText ?? "";
          let attemptStartFinalText = stableFinalText;
          let attemptStartPartialText = stablePartialText;
          const currentTurnToolCallIds = new Set<string>();
          let turnTextStartIndex = 0;
          let turnPartialTextStartIndex = stablePartialText.length;
          let pendingNoReplyTurnText = "";
          let pendingNoReplyTurnOutputs: Array<{
            delta: string;
            phase?: ReturnType<typeof openAIMessagePhase>;
            phaseBoundaryPrefixChars: number;
          }> = [];
          let bufferNoReplyTurnText = true;
          let lastCompletedTurnWasSilent = false;
          let turnFinalAnswerText = "";
          let turnHasFinalAnswerPhase = false;
          let lastCompletedTurnFinalAnswerText: string | undefined;
          let currentTextPhase: ReturnType<typeof openAIMessagePhase>;
          let retainedTextPhase: ReturnType<typeof openAIMessagePhase>;
          const assistantTextPhaseByPartId = new Map<
            string,
            NonNullable<ReturnType<typeof openAIMessagePhase>>
          >();
          const assistantTextPartBoundaryState = createAssistantTextPartBoundaryState(
            next.recovery?.partialText,
          );
          const appendPendingNoReplyOutput = (
            delta: string,
            phase: ReturnType<typeof openAIMessagePhase>,
            phaseBoundaryPrefixChars: number,
          ): void => {
            const previous = pendingNoReplyTurnOutputs.at(-1);
            if (
              previous !== undefined &&
              previous.phase === phase &&
              phaseBoundaryPrefixChars === 0
            ) {
              previous.delta += delta;
              return;
            }
            pendingNoReplyTurnOutputs.push({ delta, phase, phaseBoundaryPrefixChars });
          };
          const publishPendingNoReplyOutputs = (): void => {
            for (const output of pendingNoReplyTurnOutputs) {
              outputPublisher.publishText(
                output.delta,
                output.phase,
                output.phaseBoundaryPrefixChars,
              );
            }
            pendingNoReplyTurnOutputs = [];
          };
          const reasoningChunkState: ReasoningChunkState = {
            chunks: new Map<string, string>(),
            seq: 0,
          };
          let retryAttemptHadReasoning = false;

          const toolStartMs = new Map<string, number>();

          const contextDumpEnabled = env.debug.contextDump.enabled;
          const contextDumpDir = env.debug.contextDump.dir;
          let turnEndCount = 0;

          const dumpContextAfterTurn = async (
            event: Extract<AiSdkPiAgentEvent<ToolSet>, { type: "turn_end" }>,
          ) => {
            if (!contextDumpEnabled) return;

            const tsMs = Date.now();
            const safeSessionId = sanitizeFilenameToken(headers.session_id);
            const safeRequestId = sanitizeFilenameToken(headers.request_id);
            const fileName = `${safeSessionId}-${safeRequestId}-${tsMs}.json`;
            const filePath = path.join(contextDumpDir, fileName);

            const modelView = agent.state.debug?.lastModelViewMessages;
            const modelViewTurn = agent.state.debug?.lastModelViewTurn;

            const payload = {
              meta: {
                tsMs,
                ts: new Date(tsMs).toISOString(),
                sessionId: headers.session_id,
                requestId: headers.request_id,
                requestClient: headers.request_client,
                runProfile,
                subagentDepth: subagentMeta.depth,
                modelSpec: activeBinding.resolved.spec,
                modelId: activeBinding.resolved.modelId,
                turnEndIndex: turnEndCount,
                modelViewTurn,
              },
              system: agent.state.system,
              providerOptions: agent.state.providerOptions,
              reasoning: agent.state.reasoning,
              tools: {
                names: Object.keys(agent.state.tools ?? {}),
              },
              usage: {
                lastTurn: event.usage,
                lastTurnTotal: event.totalUsage,
              },
              transcript: {
                messages: agent.state.messages,
              },
              modelViewMessagesForTurn: modelView,
            };

            const dumped = await captureBusAgentRunnerOperation("context dump write", async () => {
              await fs.mkdir(contextDumpDir, { recursive: true });
              await fs.writeFile(filePath, debugJsonStringify(payload), "utf8");
            });
            if (dumped.status === "ok") {
              logger.debug("context dump wrote", {
                requestId: headers.request_id,
                sessionId: headers.session_id,
                filePath,
              });
            } else {
              logger.warn(
                "context dump failed",
                formatBridgeTaggedErrorForLog(dumped.error, {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  filePath,
                }),
              );
            }
          };

          const estimateUsageCostUsd = (
            usage: LanguageModelUsage | undefined,
          ): number | undefined => {
            if (!usage || !modelCapabilityInfo?.cost) return undefined;
            return modelCapability.estimateCostUsd(modelCapabilityInfo, usage);
          };

          unsubscribe = agent.subscribe((event: AiSdkPiAgentEvent<ToolSet>) => {
            markRunActivity(
              event.type === "tool_execution_start" ||
                event.type === "tool_execution_update" ||
                event.type === "tool_execution_end"
                ? "tool"
                : "model",
            );

            if (event.type === "agent_end") {
              runStats.totalUsage = event.totalUsage;
              runStats.finalMessages = event.messages;
            }

            if (event.type === "turn_start") {
              attemptStartFinalText = stableFinalText;
              attemptStartPartialText = stablePartialText;
              currentTurnToolCallIds.clear();
            }

            if (event.type === "messages_reset") {
              removePendingSilentTurn();
            }

            if (event.type === "turn_end") {
              transientRetryController.reset();
              retryAttemptHadReasoning = false;
              const turnText = finalText.slice(turnTextStartIndex);
              const turnDeliveryText = turnHasFinalAnswerPhase ? turnFinalAnswerText : turnText;
              const silentTurn = resolveReplyDeliveryFromFinalText(turnDeliveryText) === "skip";
              lastCompletedTurnWasSilent = silentTurn;
              lastCompletedTurnFinalAnswerText = turnHasFinalAnswerPhase
                ? turnFinalAnswerText
                : undefined;
              if (silentTurn) {
                finalText = finalText.slice(0, turnTextStartIndex);
                if (state.activeRun?.requestId === next.requestId) {
                  state.activeRun.partialText = state.activeRun.partialText.slice(
                    0,
                    turnPartialTextStartIndex,
                  );
                }
                void outputPublisher.publishTextReset({
                  text:
                    state.activeRun?.requestId === next.requestId
                      ? state.activeRun.partialText
                      : `${next.recovery?.partialText ?? ""}${finalText}`,
                  ...(retainedTextPhase === undefined ? {} : { phase: retainedTextPhase }),
                });
                pendingSilentTurnStartIndex =
                  agent.state.messages.length - event.newMessages.length;
              } else if (bufferNoReplyTurnText && pendingNoReplyTurnText.length > 0) {
                if (state.activeRun?.requestId === next.requestId) {
                  state.activeRun.partialText += pendingNoReplyTurnText;
                }
                publishPendingNoReplyOutputs();
              }
              if (!silentTurn) retainedTextPhase = currentTextPhase ?? retainedTextPhase;

              pendingNoReplyTurnText = "";
              pendingNoReplyTurnOutputs = [];
              bufferNoReplyTurnText = true;
              turnFinalAnswerText = "";
              turnHasFinalAnswerPhase = false;
              currentTextPhase = undefined;
              assistantTextPhaseByPartId.clear();
              turnTextStartIndex = finalText.length;
              turnPartialTextStartIndex = state.activeRun?.partialText.length ?? 0;
              stableFinalText = finalText;
              stablePartialText = state.activeRun?.partialText ?? stablePartialText;

              turnEndCount++;
              runStats.lastTurnFinishReason = event.finishReason;
              runStats.lastTurnEndAt = Date.now();

              const roundEstimatedCostUsd = estimateUsageCostUsd(event.usage);
              if (roundEstimatedCostUsd !== undefined) {
                roundEstimatedCostUsdTotal =
                  (roundEstimatedCostUsdTotal ?? 0) + roundEstimatedCostUsd;
                roundEstimatedCostCount += 1;
              }

              logger.debug(
                "agent.round.stats",
                formatBridgeLogContext({
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  round: turnEndCount,
                  finishReason: event.finishReason,
                  inputTokens: event.usage.inputTokens,
                  outputTokens: event.usage.outputTokens,
                  totalTokens: event.usage.totalTokens,
                  cacheReadTokens: event.usage.inputTokenDetails.cacheReadTokens,
                  cacheWriteTokens: event.usage.inputTokenDetails.cacheWriteTokens,
                  estimatedCostUsd: roundEstimatedCostUsd,
                  estimatedCostUsdTotal: roundEstimatedCostUsdTotal,
                  modelSpec: activeBinding.resolved.spec,
                  costEstimateStatus:
                    roundEstimatedCostUsd !== undefined ? "estimated" : costEstimateStatus,
                  costEstimateReason:
                    roundEstimatedCostUsd === undefined ? costEstimateReason : undefined,
                }),
              );

              // Fire-and-forget debug dump; do not block the run.
              void dumpContextAfterTurn(event);
            }

            if (event.type === "turn_abort" && event.reason === "interrupt") {
              transientRetryController.reset();
            }

            if (event.type === "turn_abort") {
              if (bufferNoReplyTurnText) {
                finalText = finalText.slice(0, turnTextStartIndex);
              }
              pendingNoReplyTurnText = "";
              pendingNoReplyTurnOutputs = [];
              bufferNoReplyTurnText = true;
              turnFinalAnswerText = "";
              turnHasFinalAnswerPhase = false;
              currentTextPhase = undefined;
              assistantTextPhaseByPartId.clear();
              turnTextStartIndex = finalText.length;
              turnPartialTextStartIndex = state.activeRun?.partialText.length ?? 0;
            }

            if (
              event.type === "turn_retry" ||
              (event.type === "messages_reset" && event.reason === "recovery")
            ) {
              if (event.type === "messages_reset") {
                const retainedToolCallIds = toolCallIdsFromMessages(event.messages);
                const retainsCurrentTurn = [...currentTurnToolCallIds].some((toolCallId) =>
                  retainedToolCallIds.has(toolCallId),
                );
                if (!retainsCurrentTurn) {
                  stableFinalText = attemptStartFinalText;
                  stablePartialText = attemptStartPartialText;
                }
              }
              outputPublisher.flush();
              assistantTextPartBoundaryState.lastTextPartId = null;
              assistantTextPartBoundaryState.pendingTextPartStartIds.clear();
              assistantTextPartBoundaryState.pendingRecoveryTextBoundary =
                event.type === "turn_retry" ? event.hadPartialOutput : true;
              finalText = stableFinalText;
              if (state.activeRun?.requestId === next.requestId) {
                state.activeRun.partialText = stablePartialText;
              }
              pendingNoReplyTurnText = "";
              pendingNoReplyTurnOutputs = [];
              bufferNoReplyTurnText = true;
              turnFinalAnswerText = "";
              turnHasFinalAnswerPhase = false;
              currentTextPhase = undefined;
              assistantTextPhaseByPartId.clear();
              turnTextStartIndex = stableFinalText.length;
              turnPartialTextStartIndex = stablePartialText.length;

              if (event.type === "messages_reset") {
                void outputPublisher.publishTextReset({
                  text: stablePartialText,
                  ...(retainedTextPhase === undefined ? {} : { phase: retainedTextPhase }),
                });
              }

              if (retryAttemptHadReasoning) {
                reasoningChunkState.chunks.clear();
                reasoningChunkState.seq += 1;
                void publishAuxiliaryOutput("failed to clear reasoning after model retry", () =>
                  outputPublisher.publishReasoningBoundary({
                    delta: "",
                    seq: reasoningChunkState.seq,
                  }),
                );
              }
              retryAttemptHadReasoning = false;
            }

            if (event.type === "turn_warnings") {
              streamWarnings.push(...event.warnings);

              logger.warn("model stream warnings", {
                requestId: headers.request_id,
                sessionId: headers.session_id,
                count: event.warnings.length,
                warnings: event.warnings.map((warning) => formatCallWarning(warning)),
              });
            }

            if (
              event.type === "message_update" &&
              event.assistantMessageEvent.type === "text_start"
            ) {
              const phase = openAIMessagePhase(event.assistantMessageEvent.raw.providerMetadata);
              if (phase !== undefined) {
                assistantTextPhaseByPartId.set(event.assistantMessageEvent.id, phase);
              }
              markAssistantTextPartStarted(
                assistantTextPartBoundaryState,
                event.assistantMessageEvent.id,
              );
            }

            if (
              event.type === "message_update" &&
              event.assistantMessageEvent.type === "text_delta"
            ) {
              runStats.firstTextDeltaAt ??= Date.now();
              const phase =
                openAIMessagePhase(event.assistantMessageEvent.raw.providerMetadata) ??
                assistantTextPhaseByPartId.get(event.assistantMessageEvent.id);
              if (phase === "final_answer" && currentTextPhase === "commentary") {
                if (pendingNoReplyTurnText.length > 0) {
                  if (state.activeRun?.requestId === next.requestId) {
                    state.activeRun.partialText += pendingNoReplyTurnText;
                  }
                  publishPendingNoReplyOutputs();
                  pendingNoReplyTurnText = "";
                }
                bufferNoReplyTurnText = true;
              }
              currentTextPhase = phase ?? currentTextPhase;

              const delta = consumeAssistantTextDelta({
                state: assistantTextPartBoundaryState,
                finalText,
                recoveryPartialText: next.recovery?.partialText,
                partId: event.assistantMessageEvent.id,
                delta: event.assistantMessageEvent.delta,
              });
              const phaseBoundaryPrefixChars = Math.max(
                0,
                delta.length - event.assistantMessageEvent.delta.length,
              );

              finalText += delta;
              if (phase === "final_answer") {
                turnHasFinalAnswerPhase = true;
                turnFinalAnswerText += event.assistantMessageEvent.delta;
              }

              if (bufferNoReplyTurnText) {
                pendingNoReplyTurnText += delta;
                appendPendingNoReplyOutput(delta, phase, phaseBoundaryPrefixChars);
                if (!isPossibleNoReplyPrefix(pendingNoReplyTurnText)) {
                  bufferNoReplyTurnText = false;
                  if (state.activeRun?.requestId === next.requestId) {
                    state.activeRun.partialText += pendingNoReplyTurnText;
                  }
                  publishPendingNoReplyOutputs();
                  pendingNoReplyTurnText = "";
                }
              } else {
                if (state.activeRun?.requestId === next.requestId) {
                  state.activeRun.partialText += delta;
                }
                outputPublisher.publishText(delta, phase, phaseBoundaryPrefixChars);
              }
            }

            if (
              event.type === "message_update" &&
              event.assistantMessageEvent.type === "text_end"
            ) {
              markAssistantTextPartEnded(
                assistantTextPartBoundaryState,
                event.assistantMessageEvent.id,
              );
              assistantTextPhaseByPartId.delete(event.assistantMessageEvent.id);
            }

            if (
              event.type === "message_update" &&
              event.assistantMessageEvent.type === "thinking_start"
            ) {
              const chunkId = event.assistantMessageEvent.id;
              retryAttemptHadReasoning = true;
              consumeReasoningChunkEvent(reasoningChunkState, { type: "start", chunkId });

              void publishAuxiliaryOutput("failed to publish reasoning start", () =>
                outputPublisher.publishReasoningBoundary({ delta: "" }),
              );
            }

            if (
              event.type === "message_update" &&
              event.assistantMessageEvent.type === "thinking_delta"
            ) {
              const chunkId = event.assistantMessageEvent.id;
              const delta = event.assistantMessageEvent.delta;
              retryAttemptHadReasoning = true;
              const update = consumeReasoningChunkEvent(reasoningChunkState, {
                type: "delta",
                chunkId,
                delta,
              });
              if (update.publishStart) {
                void publishAuxiliaryOutput("failed to publish implicit reasoning start", () =>
                  outputPublisher.publishReasoningBoundary({ delta: "" }),
                );
              }

              if (update.snapshot) {
                outputPublisher.publishReasoningSnapshot(update.snapshot, Buffer.byteLength(delta));
              }
            }

            if (
              event.type === "message_update" &&
              event.assistantMessageEvent.type === "thinking_end"
            ) {
              const chunkId = event.assistantMessageEvent.id;
              consumeReasoningChunkEvent(reasoningChunkState, { type: "end", chunkId });
              outputPublisher.flush();
            }

            if (event.type === "tool_execution_start") {
              const startedAt = Date.now();
              toolStartMs.set(event.toolCallId, startedAt);
              currentTurnToolCallIds.add(event.toolCallId);
              state.activeRun?.activeTools.set(event.toolCallId, {
                toolName: event.toolName,
                startedAt,
              });

              if (event.toolName !== "batch") {
                void publishAuxiliaryOutput("failed to publish tool start", () =>
                  outputPublisher.publishToolCall({
                    toolCallId: event.toolCallId,
                    status: "start",
                    display: `${event.toolName}${formatToolArgsForDisplayWithSpecs(event.toolName, event.args, activeBinding.toolset.specs)}`,
                  }),
                );
              }
            }

            if (event.type === "tool_execution_end") {
              state.activeRun?.activeTools.delete(event.toolCallId);
              const started = toolStartMs.get(event.toolCallId);
              const toolDurationMs = started ? Date.now() - started : undefined;
              const toolFailure = summarizeToolFailure({
                toolName: event.toolName,
                isError: event.isError,
                result: event.result,
                toolSpecs: activeBinding.toolset.specs,
              });
              const deferredAccepted =
                event.toolName === "subagent_delegate" &&
                decodeDeferredSubagentAcceptedResult(event.result) !== null;

              let ok: boolean;
              switch (event.toolName) {
                case "batch":
                  ok = getBatchOkFromResult(event.result) ?? toolFailure.ok;
                  break;
                case "subagent_delegate":
                  ok = getSubagentOkFromResult(event.result) ?? toolFailure.ok;
                  break;
                default:
                  ok = toolFailure.ok;
                  break;
              }
              const interruptedForRestart = restartAbortRequestIds.has(headers.request_id);
              const toolFailureError = toolFailure.error ?? "tool failed";

              if (!ok) {
                logger.warn(
                  "tool call failed",
                  formatBridgeLogContext({
                    requestId: headers.request_id,
                    sessionId: headers.session_id,
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    durationMs: toolDurationMs,
                    failureKind: toolFailure.failureKind ?? "soft",
                    error: interruptedForRestart ? "server restarted" : toolFailureError,
                    argsPreview: formatToolLogPreview({
                      toolName: event.toolName,
                      value: event.args,
                    }),
                    resultPreview: formatToolLogPreview({
                      toolName: event.toolName,
                      value: event.result,
                    }),
                  }),
                );
              }

              logger.debug(
                "tool finished",
                formatBridgeLogContext({
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  ok,
                  deferredAccepted,
                  durationMs: toolDurationMs,
                  failureKind: ok ? undefined : (toolFailure.failureKind ?? "soft"),
                }),
              );

              if (event.toolName === "batch" || deferredAccepted) {
                return;
              }

              let publishedToolError: string | undefined;
              if (!ok) {
                publishedToolError = interruptedForRestart ? "server restarted" : toolFailureError;
              }
              void publishAuxiliaryOutput("failed to publish tool end", () =>
                outputPublisher.publishToolCall({
                  toolCallId: event.toolCallId,
                  status: "end",
                  display: `${event.toolName}${formatToolArgsForDisplayWithSpecs(event.toolName, event.args, activeBinding.toolset.specs)}`,
                  ok,
                  error: publishedToolError,
                }),
              );
            }

            if (event.type === "agent_end") {
              // Best-effort fallback: if deltas didn't populate finalText, take last assistant string.
              if (!finalText) {
                const last = event.messages[event.messages.length - 1];
                if (last && last.role === "assistant") {
                  if (typeof last.content === "string") {
                    finalText = last.content;
                  } else {
                    const buf: string[] = [];
                    for (const part of last.content) {
                      if (part.type !== "text") continue;
                      buf.push(part.text);
                    }
                    finalText = buf.join("\n\n");
                  }
                }
              }
            }
          });

          if (next.recovery) {
            initialMessages = [buildResumePrompt(next.recovery.partialText)];
            responseStartIndex = agent.state.messages.length + initialMessages.length;
          } else if (parsedCustomCommand) {
            initialMessages = [...next.messages];
            agent.appendMessages(initialMessages);
            responseStartIndex = agent.state.messages.length;
            agent.appendMessages(customCommandMessages);
          } else {
            // First message should be a prompt.
            // If additional messages for the same request id were queued before the run started,
            // merge them into the initial prompt so they don't become separate runs.
            const coalesced = mergeQueuedForSameRequest(next, state.queue, reservedQueueEntries);
            const mergedInitial = coalesced.messages;
            state.activeRun?.setCurrentTurnUserId(next.currentTurnUserId);
            for (const discarded of coalesced.discarded) {
              if (discarded.identityOwner)
                requestMessageCache.releaseOwner(discarded.identityOwner);
            }
            if (state.activeRun) state.activeRun.corePrimaryLineage = next.corePrimaryLineage;
            const control = parseRequestControlFromRaw(next.raw);
            const reportAutoInjectedThreadSearchError = (
              message: string,
              error: BusAgentRunnerErrorProjection,
            ): void => {
              logger.warn(message, {
                requestId: headers.request_id,
                sessionId: headers.session_id,
                ...error.details,
                error: error.message,
              });
            };
            const autoInjectedThreadSearchMessages =
              runProfile === "primary" &&
              !isHeartbeatSessionId(headers.session_id) &&
              !control.cancel &&
              !control.requiresActive
                ? await waitForPreAgent(
                    maybeBuildAutoInjectedThreadSearchMessages({
                      cfg,
                      conversationThreads: params.conversationThreads,
                      requestId: headers.request_id,
                      raw: next.raw,
                      previousMessages: agent.state.messages,
                      userMessages: mergedInitial,
                      publishToolStatus: async (update) => {
                        await outputPublisher.publishToolCall(update);
                      },
                      onError: reportAutoInjectedThreadSearchError,
                      onInjected: (event) => {
                        logger.info("conversation.thread.auto_inject.appended", {
                          requestId: headers.request_id,
                          sessionId: headers.session_id,
                          toolCallId: event.toolCallId,
                          mode: event.mode,
                          limit: event.limit,
                          searchCount: event.searches.length,
                          queryCount: event.searches.reduce(
                            (sum, queries) => sum + queries.length,
                            0,
                          ),
                          searches: event.searches,
                          participantFilterUserCount: event.participantFilterUserCount,
                          appendedCount: event.entries.length,
                          entries: event.entries,
                        });
                      },
                    }),
                  )
                : [];
            initialMessages = [...mergedInitial, ...autoInjectedThreadSearchMessages];
            if (
              autoInjectedThreadSearchMessages.length > 0 &&
              runProfile === "primary" &&
              next.requestClient === "discord"
            ) {
              next.corePrimaryLineage = appendAutoInjectedThreadSearchLineage({
                lineage: next.corePrimaryLineage,
                canonicalMessages: mergedInitial,
                injectedMessages: autoInjectedThreadSearchMessages,
              });
              if (state.activeRun) state.activeRun.corePrimaryLineage = next.corePrimaryLineage;
            }
            initialMessagesEndWithInjectedTool = autoInjectedThreadSearchMessages.length > 0;
            responseStartIndex = agent.state.messages.length + initialMessages.length;
          }

          if (cancelledByRequestId.has(headers.request_id)) {
            const finalText = "Cancelled.";
            await publishCurrentLifecycle({
              state: "cancelled",
              detail: "cancelled by interrupt",
              output: finalText,
            });
            await outputPublisher.publishResponseText({ finalText });
            return;
          }

          if (state.activeRun) state.activeRun.started = true;
          runIdleWatchdog?.start();

          if (parsedCustomCommand) {
            await waitForRunAtHost(agent.continue());
          } else if (initialMessagesEndWithInjectedTool) {
            agent.appendMessages(initialMessages);
            await waitForRunAtHost(agent.continue());
          } else {
            await waitForRunAtHost(agent.prompt(initialMessages));
          }

          while (true) {
            await waitForRunAtHost(agent.waitForIdle());

            if (restartAbortRequestIds.delete(headers.request_id)) {
              return signalBusAgentRunnerHostFailure(new RestartDrainingAbort());
            }

            const continuationWaitVersion = continuationSignalVersion;
            const deferredWaitState = liveParentSession?.snapshot();

            if (liveParentSession && deferredWaitState?.hasPendingCompletions) {
              const drained = await drainDeferredCompletions({
                modelInputMessages: lastBoundaryModelInputMessages,
              });
              const decision = adaptDeferredDrainToHost(drained);
              if (decision.append.length > 0) agent.appendMessages(decision.append);
              if (cancelledByRequestId.has(headers.request_id)) break;
              if (decision.append.length > 0 || decision.forceNextTurn) {
                await waitForRunAtHost(agent.continue());
              } else if (liveParentSession.snapshot().hasPendingCompletions) {
                await waitForRunAtHost(
                  waitForDeferredWake(deferredWaitState.signalVersion, continuationWaitVersion),
                );
              }
              continue;
            }

            if (!deferredWaitState?.hasOutstandingRuns) {
              break;
            }
            if (!liveParentSession) break;

            await waitForRunAtHost(
              waitForDeferredWake(deferredWaitState.signalVersion, continuationWaitVersion),
            );
            if (agent.state.isStreaming) {
              continue;
            }
          }
          runIdleWatchdog?.stop();

          let isCancelled = cancelledByRequestId.has(headers.request_id);
          if (isCancelled) coreNamedClaudeRuntime?.markTerminalFailure(true);
          if (isCancelled) corePrimaryClaudeRuntime?.markTerminalFailure(true);
          if (isCancelled && !finalText) {
            finalText = "Cancelled.";
          }

          const terminalDeliveryText = isCancelled
            ? finalText
            : (lastCompletedTurnFinalAnswerText ?? finalText);
          const isHeartbeatAckOnly =
            isHeartbeatSessionId(headers.session_id) && isHeartbeatAckText(terminalDeliveryText);
          const delivery =
            finalText.length === 0 && lastCompletedTurnWasSilent
              ? "skip"
              : resolveReplyDeliveryFromFinalText(terminalDeliveryText);
          if (
            !isCancelled &&
            delivery !== "skip" &&
            !isHeartbeatAckOnly &&
            finalText.length === 0
          ) {
            return signalBusAgentRunnerHostFailure(
              new Error(
                buildNoAssistantTextError({
                  provider: activeBinding.resolved.provider,
                  modelId: activeBinding.resolved.modelId,
                  finishReason: runStats.lastTurnFinishReason,
                  warningSummary: summarizeCallWarnings(streamWarnings) ?? undefined,
                }),
              ),
            );
          }

          const shouldSkipSurfaceReply = delivery === "skip" || isHeartbeatAckOnly;
          if (shouldSkipSurfaceReply) {
            logger.info("agent requested skip reply", {
              requestId: headers.request_id,
              sessionId: headers.session_id,
            });
            finalText = "";
          }

          // Keep skip-reply behavior for primary runs.
          // For subagent runs we still persist to support explicit session continuation.
          const transcriptStore = params.transcriptStore;
          if (transcriptStore && (!shouldSkipSurfaceReply || runProfile !== "primary")) {
            const persistedTranscript = await captureBusAgentRunnerOperation(
              "successful transcript persistence",
              async () => {
                const finalMessagesForPersistence = runStats.finalMessages ?? agent.state.messages;
                const checkpointMeta = resolveCompactionCheckpointMeta({
                  runSucceeded: true,
                  isPrimary: runProfile === "primary",
                  isCancelled,
                  shouldSkipSurfaceReply,
                  completedCompactionCount,
                });
                const isCompactionCheckpoint = checkpointMeta !== undefined;
                const persistedMessages = (() => {
                  if (isHeartbeatSessionId(headers.session_id)) {
                    return buildPersistedHeartbeatMessages(finalText);
                  }

                  return selectPersistedTranscriptMessages({
                    finalMessages: finalMessagesForPersistence,
                    responseStartIndex,
                    isPrimary: runProfile === "primary",
                    didCompact: isCompactionCheckpoint,
                  });
                })();
                const targetProviderFamily = classifyHistoryProviderFamily({
                  type: activeBinding.resolved.provider,
                });
                let providerState: HistoryProviderState | undefined;
                switch (runProfile) {
                  case "primary":
                    providerState = resolveCorePrimaryTranscriptProviderState({
                      targetFamily: targetProviderFamily,
                      lineage: state.activeRun?.corePrimaryLineage ?? next.corePrimaryLineage,
                      transcriptStore,
                    });
                    break;
                  case "explore":
                  case "general":
                  case "self":
                    providerState = undefined;
                    if (stableNamedContinuation && !isCancelled) {
                      const sourceProviderState =
                        seededSessionTranscript === null
                          ? "empty-history"
                          : (seededSessionTranscript.providerState ?? "unknown-populated-history");
                      providerState = advanceHistoryProviderState(
                        sourceProviderState,
                        targetProviderFamily,
                      );
                    }
                    break;
                  default: {
                    const _exhaustive: never = runProfile;
                    providerState = _exhaustive;
                    break;
                  }
                }
                const terminalPrimaryLineage =
                  state.activeRun?.corePrimaryLineage ?? next.corePrimaryLineage;
                const canPublishCorePrimaryClaude =
                  corePrimaryClaudeRuntime !== null &&
                  terminalPrimaryLineage?.state === "complete" &&
                  !isCompactionCheckpoint;

                const savedTranscript = transcriptStore.saveRequestTranscript({
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  requestClient: headers.request_client,
                  // Primary runs can reconstruct context from the surface thread.
                  // Subagent runs need full per-session transcript for explicit continuation.
                  messages: persistedMessages,
                  finalText,
                  modelLabel: resolvedModelLabel,
                  contextMeta: checkpointMeta,
                  ...(providerState && !coreNamedClaudeRuntime && !canPublishCorePrimaryClaude
                    ? { providerState }
                    : {}),
                  ...(runProfile === "primary"
                    ? persistedCompleteLineage(terminalPrimaryLineage)
                    : {}),
                  ...(stableNamedContinuation && !isCancelled && !coreNamedClaudeRuntime
                    ? { stableNamedRequestClient: stableNamedContinuation.requestClient }
                    : {}),
                });
                if (savedTranscript.status === "error") {
                  coreNamedClaudeRuntime?.markTerminalFailure(false);
                  corePrimaryClaudeRuntime?.markTerminalFailure(false);
                  logger.error(
                    "failed to persist transcript",
                    formatBridgeLogContext({
                      requestId: headers.request_id,
                      sessionId: headers.session_id,
                      errorTag: savedTranscript.error.name,
                      errorMessage: savedTranscript.error.message,
                    }),
                  );
                  return;
                }
                if (coreNamedClaudeRuntime && !isCancelled) {
                  if (!providerState) {
                    return signalBusAgentRunnerHostFailure(
                      new Error("Core named Claude finalization requires provider history state"),
                    );
                  }
                  const verified = transcriptStore.getRequestTranscript?.({
                    requestId: headers.request_id,
                  });
                  const verifiedTranscript = verified?.status === "ok" ? verified.value : null;
                  const expectedHash = hashCanonicalMessagesV1(persistedMessages).hash;
                  if (
                    !verifiedTranscript ||
                    verifiedTranscript.messages.length !== persistedMessages.length ||
                    hashCanonicalMessagesV1(verifiedTranscript.messages).hash !== expectedHash
                  ) {
                    return signalBusAgentRunnerHostFailure(
                      new Error("persisted Core named transcript failed canonical re-read"),
                    );
                  }
                  const promoted = await coreNamedClaudeRuntime.finalize({
                    terminalTranscript: verifiedTranscript,
                    canonicalMessages: persistedMessages,
                    providerState,
                    isCancellationRequested: () => cancelledByRequestId.has(headers.request_id),
                  });
                  const cancelledDuringFinalization = cancelledByRequestId.has(headers.request_id);
                  isCancelled ||= cancelledDuringFinalization;
                  logger.info(
                    "Core named Claude binding promotion",
                    formatBridgeLogContext({
                      requestId: headers.request_id,
                      sessionId: headers.session_id,
                      promoted,
                    }),
                  );
                }
                if (corePrimaryClaudeRuntime && !isCancelled && canPublishCorePrimaryClaude) {
                  if (!providerState) {
                    return signalBusAgentRunnerHostFailure(
                      new Error("Core primary Claude finalization requires provider history state"),
                    );
                  }
                  const verified = transcriptStore.getRequestTranscript?.({
                    requestId: headers.request_id,
                  });
                  const verifiedManifest = transcriptStore.getCorePrimaryLineageManifest?.({
                    requestId: headers.request_id,
                  });
                  const verifiedTranscript = verified?.status === "ok" ? verified.value : null;
                  const manifest =
                    verifiedManifest?.status === "ok" ? verifiedManifest.value : null;
                  const expectedHash = hashCanonicalMessagesV1(persistedMessages).hash;
                  const terminalCanonicalMessages = runStats.finalMessages ?? agent.state.messages;
                  if (
                    !verifiedTranscript ||
                    !manifest ||
                    verifiedTranscript.providerState != null ||
                    verifiedTranscript.messages.length !== persistedMessages.length ||
                    hashCanonicalMessagesV1(verifiedTranscript.messages).hash !== expectedHash
                  ) {
                    return signalBusAgentRunnerHostFailure(
                      new Error("persisted Core primary transcript failed canonical re-read"),
                    );
                  }
                  const promoted = await corePrimaryClaudeRuntime.finalize({
                    terminalTranscript: verifiedTranscript,
                    canonicalMessages: terminalCanonicalMessages,
                    providerState,
                    isCancellationRequested: () => cancelledByRequestId.has(headers.request_id),
                  });
                  const cancelledDuringFinalization = cancelledByRequestId.has(headers.request_id);
                  isCancelled ||= cancelledDuringFinalization;
                  logger.info(
                    "Core primary Claude binding promotion",
                    formatBridgeLogContext({
                      requestId: headers.request_id,
                      sessionId: headers.session_id,
                      promoted,
                    }),
                  );
                } else if (corePrimaryClaudeRuntime && !isCancelled) {
                  corePrimaryClaudeRuntime.markTerminalFailure(false);
                }
                if (isCompactionCheckpoint) {
                  logger.info(
                    "compaction checkpoint persisted",
                    formatBridgeLogContext({
                      requestId: headers.request_id,
                      sessionId: headers.session_id,
                      messageCount: persistedMessages.length,
                      compactionCount: completedCompactionCount,
                      formatVersion: COMPACTION_CHECKPOINT_FORMAT_VERSION,
                    }),
                  );
                }
              },
            );
            if (persistedTranscript.status === "error") {
              coreNamedClaudeRuntime?.markTerminalFailure(false);
              corePrimaryClaudeRuntime?.markTerminalFailure(false);
              logger.error(
                "failed to persist transcript",
                formatBridgeTaggedErrorForLog(persistedTranscript.error, {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                }),
              );
            }
          }
          if (corePrimaryClaudeRuntime && shouldSkipSurfaceReply) {
            corePrimaryClaudeRuntime.markTerminalFailure(false);
          }

          // Build stats in the js-llmcord-ish one-liner format.
          const endAt = runStats.lastTurnEndAt ?? Date.now();
          const ttftMs = runStats.firstTextDeltaAt
            ? runStats.firstTextDeltaAt - runStartedAt
            : null;
          const outputTokens = runStats.totalUsage?.outputTokens;
          const rawTps =
            typeof outputTokens === "number" &&
            runStats.lastTurnFinishReason === "stop" &&
            endAt > runStartedAt
              ? outputTokens / ((endAt - runStartedAt) / 1000)
              : null;
          const tps = rawTps !== null && Number.isFinite(rawTps) ? rawTps : null;

          const responseMessages = runStats.finalMessages
            ? runStats.finalMessages.slice(responseStartIndex)
            : [];

          if (transcriptStore && isHeartbeatSessionId(headers.session_id)) {
            const persistedHandoffs = await captureBusAgentRunnerOperation(
              "heartbeat handoff transcript persistence",
              () =>
                persistHeartbeatSurfaceHandoffs({
                  logger,
                  transcriptStore,
                  requestId: headers.request_id,
                  requestClient: headers.request_client,
                  sessionId: headers.session_id,
                  modelLabel: resolvedModelLabel,
                  responseMessages,
                }),
            );
            if (persistedHandoffs.status === "error") {
              logger.error(
                "failed to persist heartbeat handoff transcripts",
                formatBridgeTaggedErrorForLog(persistedHandoffs.error, {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                }),
              );
            }
          }

          const icLine = buildInputCompositionLine({
            system: systemPromptToText(agent.state.system),
            initialMessages,
            responseMessages,
            tools: agent.state.tools,
          });

          const modelLabel = activeBinding.resolved.modelId;
          const statsForNerds = getStatsForNerdsOptions(cfg.agent.statsForNerds);
          const statsForNerdsLine = statsForNerds.enabled
            ? buildStatsLine({
                modelLabel,
                usage: runStats.totalUsage,
                ttftMs,
                tps,
                icLine: statsForNerds.verbose ? icLine : null,
              })
            : undefined;

          const estimatedCostUsdFromTotalUsage = didSwitchModel
            ? undefined
            : estimateUsageCostUsd(runStats.totalUsage);
          const estimatedCostUsdTotal =
            estimatedCostUsdFromTotalUsage ?? roundEstimatedCostUsdTotal;
          const resolvedCostEstimateStatus =
            estimatedCostUsdTotal !== undefined ? "estimated" : costEstimateStatus;
          const resolvedCostEstimateReason =
            estimatedCostUsdTotal !== undefined ? undefined : costEstimateReason;

          await publishCurrentLifecycle({
            state: isCancelled ? "cancelled" : "resolved",
            detail: isCancelled ? "cancelled by interrupt" : undefined,
            output: finalText,
            usage: runStats.totalUsage
              ? {
                  inputTokens: runStats.totalUsage.inputTokens ?? 0,
                  outputTokens: runStats.totalUsage.outputTokens ?? 0,
                  totalTokens: runStats.totalUsage.totalTokens ?? 0,
                }
              : undefined,
          });

          await outputPublisher.publishResponseText({
            finalText,
            delivery,
            statsForNerdsLine,
            usage: runStats.totalUsage
              ? {
                  inputTokens: runStats.totalUsage.inputTokens ?? 0,
                  outputTokens: runStats.totalUsage.outputTokens ?? 0,
                  totalTokens: runStats.totalUsage.totalTokens ?? 0,
                }
              : undefined,
          });

          logger.info(
            "agent run resolved",
            formatBridgeLogContext({
              requestId: headers.request_id,
              model: activeBinding.resolved.spec,
              durationMs: Date.now() - runStartedAt,
              turns: turnEndCount,
              finalTextChars: finalText.length,
              ttftMs,
              tokensPerSecond: tps,
              inputComposition: icLine,
              inputTokens: runStats.totalUsage?.inputTokens,
              outputTokens: runStats.totalUsage?.outputTokens,
              totalTokens: runStats.totalUsage?.totalTokens,
              noCacheTokens: runStats.totalUsage?.inputTokenDetails.noCacheTokens,
              cacheReadTokens: runStats.totalUsage?.inputTokenDetails.cacheReadTokens,
              cacheWriteTokens: runStats.totalUsage?.inputTokenDetails.cacheWriteTokens,
              textTokens: runStats.totalUsage?.outputTokenDetails.textTokens,
              reasoningTokens: runStats.totalUsage?.outputTokenDetails.reasoningTokens,
              estimatedCostUsd: estimatedCostUsdTotal,
              costEstimateStatus: resolvedCostEstimateStatus,
              costEstimateReason: resolvedCostEstimateReason,
              estimatedCostTurnCoverage:
                turnEndCount > 0 ? roundEstimatedCostCount / turnEndCount : undefined,
            }),
          );
        },
        (panic) => {
          terminalPanic = panic;
        },
      );
      if (runResult.status === "error") {
        const failure = runResult.error;
        const failedCoreNamedRuntime = getCoreNamedClaudeRuntime();
        const failedCorePrimaryRuntime = getCorePrimaryClaudeRuntime();
        runIdleWatchdog?.stop();

        if (failure.failureKind === "restart-draining") {
          failedCoreNamedRuntime?.markUncertain();
          failedCorePrimaryRuntime?.markUncertain();
        } else if (failure.failureKind === "pre-agent-cancelled") {
          failedCoreNamedRuntime?.markTerminalFailure(true);
          failedCorePrimaryRuntime?.markTerminalFailure(true);
        } else {
          failedCoreNamedRuntime?.markTerminalFailure(false);
          failedCorePrimaryRuntime?.markTerminalFailure(false);
        }

        if (activeCustomCommandTool) {
          const { toolCallId, display } = activeCustomCommandTool;
          activeCustomCommandTool = null;
          let customCommandError: string;
          if (failure.failureKind === "pre-agent-cancelled") {
            customCommandError = "cancelled by interrupt";
          } else {
            customCommandError = failure.displayMessage;
          }
          await captureBusAgentRunnerOperation("custom command failure status publish", () =>
            outputPublisher.publishToolCall({
              toolCallId,
              status: "end",
              display,
              ok: false,
              error: customCommandError,
            }),
          );
        }

        const timedOutOperation = getActiveRunOperation();
        if (
          (failure.failureKind === "idle-timeout" ||
            failure.failureKind === "pre-agent-cancelled") &&
          timedOutOperation
        ) {
          const observeTimedOutOperation = captureBusAgentRunnerOperation(
            "cancelled agent operation settlement",
            () => timedOutOperation,
            (panic) => {
              terminalPanic ??= panic;
            },
          ).then(() => true);
          const settled = await Promise.race([
            observeTimedOutOperation,
            Bun.sleep(AGENT_TIMEOUT_ABORT_GRACE_MS).then(() => false),
          ]);
          if (!settled) {
            logger.warn(
              "agent operation did not settle after cancellation grace period",
              formatBridgeLogContext({
                requestId: headers.request_id,
                sessionId: headers.session_id,
                reason: failure.failureKind === "idle-timeout" ? "idle_timeout" : "cancelled",
                abortGraceMs: AGENT_TIMEOUT_ABORT_GRACE_MS,
              }),
            );
          }
        }

        if (failure.failureKind === "restart-draining") {
          preserveWorkflowClaim = true;
          if (workflowHint) {
            params.durableWorkflowStore?.releaseWorkflowRequestClaim(
              next.requestId,
              workflowRunnerOwnerId,
              Date.now(),
            );
          }
          logger.info("agent run interrupted for graceful restart", {
            requestId: headers.request_id,
            sessionId: headers.session_id,
            durationMs: Date.now() - runStartedAt,
          });
          return;
        }

        if (failure.failureKind === "pre-agent-cancelled") {
          if (liveParentSession) {
            await captureBusAgentRunnerOperation("cancel deferred subagents", () =>
              liveParentSession.cancelAll("parent request cancelled"),
            );
          }
          const finalText = "Cancelled.";
          await publishCurrentLifecycle({
            state: "cancelled",
            detail: "cancelled by interrupt",
            output: finalText,
          });
          await outputPublisher.publishResponseText({ finalText });
          return;
        }

        const rawMsg = failure.displayMessage;
        const msg = maybeAppendWarningSummaryToUnclearError(
          rawMsg,
          summarizeCallWarnings(streamWarnings),
        );

        const failureTranscriptStore = params.transcriptStore;
        if (failureTranscriptStore) {
          const persistedFailure = await captureBusAgentRunnerOperation(
            "failed run transcript persistence",
            () => {
              const finalMessagesForPersistence =
                runStats.finalMessages ?? activeAgent?.getRecoverableMessages() ?? [];
              const safeFinalMessages = buildSafeRecoveryCheckpoint(
                finalMessagesForPersistence,
                "agent run failed",
              );
              const responseMessages = safeFinalMessages.slice(responseStartIndex);
              const persistedMessages = (() => {
                if (isHeartbeatSessionId(headers.session_id)) {
                  return buildPersistedHeartbeatMessages(`Error: ${msg}`);
                }

                return runProfile === "primary" ? responseMessages : safeFinalMessages;
              })();

              return failureTranscriptStore.saveRequestTranscript({
                requestId: headers.request_id,
                sessionId: headers.session_id,
                requestClient: headers.request_client,
                messages: persistedMessages,
                finalText: `Error: ${msg}`,
                modelLabel: resolvedModelLabel,
                ...(runProfile === "primary"
                  ? {
                      providerState: resolveCorePrimaryTranscriptProviderState({
                        targetFamily: resolvedProviderFamily,
                        lineage: state.activeRun?.corePrimaryLineage ?? next.corePrimaryLineage,
                        transcriptStore: failureTranscriptStore,
                      }),
                    }
                  : {}),
                ...(runProfile === "primary"
                  ? persistedCompleteLineage(
                      state.activeRun?.corePrimaryLineage ?? next.corePrimaryLineage,
                    )
                  : {}),
              });
            },
          );
          if (persistedFailure.status === "error") {
            logger.error(
              "failed to persist transcript after error",
              formatBridgeTaggedErrorForLog(persistedFailure.error, {
                requestId: headers.request_id,
                sessionId: headers.session_id,
              }),
            );
          } else if (persistedFailure.value.status === "error") {
            logger.error(
              "failed to persist transcript after error",
              formatBridgeLogContext({
                requestId: headers.request_id,
                sessionId: headers.session_id,
                errorTag: persistedFailure.value.error.name,
                errorMessage: persistedFailure.value.error.message,
              }),
            );
          }
        }

        if (liveParentSession) {
          const cancelledSubagents = await captureBusAgentRunnerOperation(
            "deferred subagent cancellation after parent failure",
            () => liveParentSession.cancelAll(`parent run failed: ${msg}`),
          );
          if (cancelledSubagents.status === "error") {
            logger.warn(
              "failed to cancel deferred subagents after parent failure",
              formatBridgeTaggedErrorForLog(cancelledSubagents.error, {
                requestId: headers.request_id,
                sessionId: headers.session_id,
              }),
            );
          }
        }

        if (failureTranscriptStore && isHeartbeatSessionId(headers.session_id)) {
          const persistedFailureHandoffs = await captureBusAgentRunnerOperation(
            "failed run heartbeat handoff persistence",
            () => {
              const finalMessagesForPersistence =
                runStats.finalMessages ?? activeAgent?.getRecoverableMessages() ?? [];
              const responseMessages = buildSafeRecoveryCheckpoint(
                finalMessagesForPersistence,
                "agent run failed",
              ).slice(responseStartIndex);

              persistHeartbeatSurfaceHandoffs({
                logger,
                transcriptStore: failureTranscriptStore,
                requestId: headers.request_id,
                requestClient: headers.request_client,
                sessionId: headers.session_id,
                modelLabel: resolvedModelLabel,
                responseMessages,
              });
            },
          );
          if (persistedFailureHandoffs.status === "error") {
            logger.error(
              "failed to persist heartbeat handoff transcripts after error",
              formatBridgeTaggedErrorForLog(persistedFailureHandoffs.error, {
                requestId: headers.request_id,
                sessionId: headers.session_id,
              }),
            );
          }
        }
        await publishCurrentLifecycle({
          state: "failed",
          detail: msg,
          output: `Error: ${msg}`,
          usage: runStats.totalUsage
            ? {
                inputTokens: runStats.totalUsage.inputTokens ?? 0,
                outputTokens: runStats.totalUsage.outputTokens ?? 0,
                totalTokens: runStats.totalUsage.totalTokens ?? 0,
              }
            : undefined,
        });
        await outputPublisher.publishResponseText({ finalText: `Error: ${msg}` });

        const projectedError: BusAgentRunnerErrorProjection = {
          message: failure.message,
          details: failure.details,
        };
        logger.error(
          "agent run failed",
          formatBridgeLogContext({
            requestId: headers.request_id,
            sessionId: headers.session_id,
            durationMs: Date.now() - runStartedAt,
            model: resolvedModelLabel,
            ...projectedError.details,
            errorMessage: projectedError.message,
          }),
        );
      }
    } finally {
      const cleanupCoreNamedRuntime = getCoreNamedClaudeRuntime();
      const cleanupCorePrimaryRuntime = getCorePrimaryClaudeRuntime();
      const cleanupClaudeCodeRun = getClaudeCodeRun();
      if (next.identityOwner) requestMessageCache.releaseOwner(next.identityOwner);
      if (terminalPanic) {
        rejectPreAgentCancellation = null;
        const terminalCleanups: BusAgentRunnerTerminalCleanup[] = [];
        if (workflowClaimTimer) {
          const timer = workflowClaimTimer;
          terminalCleanups.push({
            label: "workflow-claim-timer-clear",
            run: () => clearInterval(timer),
          });
        }
        if (params.expireControlCapability) {
          const expireControlCapability = params.expireControlCapability;
          terminalCleanups.push({
            label: "control-capability-expire",
            run: () => expireControlCapability(next.requestId),
          });
        }
        if (workflowHint && !preserveWorkflowClaim && params.durableWorkflowStore) {
          const durableWorkflowStore = params.durableWorkflowStore;
          terminalCleanups.push({
            label: "workflow-request-expire",
            run: () => {
              durableWorkflowStore.expireWorkflowRequest(
                next.requestId,
                Date.now(),
                workflowRunnerOwnerId,
              );
            },
          });
        }
        if (runIdleWatchdog) {
          const watchdog = runIdleWatchdog;
          terminalCleanups.push({
            label: "run-idle-watchdog-stop",
            run: () => watchdog.stop(),
          });
        }
        terminalCleanups.push(
          { label: "agent-unsubscribe", run: unsubscribe },
          { label: "compaction-unsubscribe", run: unsubscribeCompaction },
          { label: "output-publisher-drain", run: () => outputPublisher.drain() },
        );
        if (cleanupCoreNamedRuntime) {
          const runtime = cleanupCoreNamedRuntime;
          terminalCleanups.push({
            label: "core-named-retire",
            run: () => runtime.retireAtRunEnd(),
          });
        }
        if (cleanupCorePrimaryRuntime) {
          const runtime = cleanupCorePrimaryRuntime;
          terminalCleanups.push({
            label: "core-primary-retire",
            run: () => runtime.retireAtRunEnd(),
          });
        }
        if (cleanupClaudeCodeRun) {
          const run = cleanupClaudeCodeRun;
          terminalCleanups.push({ label: "claude-dispose", run: () => run.dispose() });
        }
        if (liveParentSession) {
          const session = liveParentSession;
          terminalCleanups.push({ label: "live-close", run: () => session.close() });
        }
        const cleanupBatch = startBusAgentRunnerTerminalCleanup(terminalCleanups);
        terminalCleanupOperations = [...terminalCleanupOperations, ...cleanupBatch.operations];
        terminalCleanupCompletion = terminalCleanupCompletion
          ? Promise.all([terminalCleanupCompletion, cleanupBatch.completion]).then(() => undefined)
          : cleanupBatch.completion;
      } else {
        if (workflowClaimTimer) clearInterval(workflowClaimTimer);
        if (controlCapability) params.expireControlCapability?.(next.requestId);
        if (workflowHint && !preserveWorkflowClaim) {
          params.durableWorkflowStore?.expireWorkflowRequest(
            next.requestId,
            Date.now(),
            workflowRunnerOwnerId,
          );
        }
        runIdleWatchdog?.stop();
        rejectPreAgentCancellation = null;
        unsubscribe();
        unsubscribeCompaction();
        await outputPublisher.drain();
        if (cleanupCoreNamedRuntime) {
          const runtime = cleanupCoreNamedRuntime;
          const retired = await captureBusAgentRunnerOperation(
            "Core named Claude runtime retirement",
            () => runtime.retireAtRunEnd(),
          );
          if (retired.status === "error") {
            logger.warn(
              "failed to retire Core named Claude runtime",
              formatBridgeTaggedErrorForLog(retired.error, {
                requestId: headers.request_id,
                sessionId: headers.session_id,
              }),
            );
          }
        }
        if (cleanupCorePrimaryRuntime) {
          const runtime = cleanupCorePrimaryRuntime;
          const retired = await captureBusAgentRunnerOperation(
            "Core primary Claude runtime retirement",
            () => runtime.retireAtRunEnd(),
          );
          if (retired.status === "error") {
            logger.warn(
              "failed to retire Core primary Claude runtime",
              formatBridgeTaggedErrorForLog(retired.error, {
                requestId: headers.request_id,
                sessionId: headers.session_id,
              }),
            );
          }
        }
        if (cleanupClaudeCodeRun) {
          const run = cleanupClaudeCodeRun;
          const disposed = await captureBusAgentRunnerOperation("Claude Code run disposal", () =>
            run.dispose(),
          );
          if (disposed.status === "error") {
            logger.warn(
              "failed to dispose Claude Code run resources",
              formatBridgeTaggedErrorForLog(disposed.error, {
                requestId: headers.request_id,
                sessionId: headers.session_id,
              }),
            );
          }
        }
        await liveParentSession?.close();
      }
      state.agent = null;
      state.activeRequestId = null;
      state.activeRun = null;
      state.running = false;
      cancelledByRequestId.delete(headers.request_id);
      restartAbortRequestIds.delete(headers.request_id);
      if (!terminalPanic) {
        startSessionQueueDrain(sessionId, state);
      }
    }
  }

  function getActiveLevel1Work(): readonly AgentRunnerActiveWork[] {
    const now = Date.now();
    const active: AgentRunnerActiveWork[] = [];
    for (const state of bySession.values()) {
      const run = state.activeRun;
      if (!run) continue;
      const tools = [...run.activeTools.entries()].map(([toolCallId, tool]) => ({
        toolCallId,
        toolName: tool.toolName,
        ageMs: Math.max(0, now - tool.startedAt),
      }));
      let phase: AgentRunnerActiveWork["phase"] = "preparing";
      if (tools.length > 0) {
        phase = "tool";
      } else if (run.started) {
        phase = "model";
      }
      active.push({
        requestId: run.requestId,
        requestClient: run.requestClient,
        runProfile: run.runProfile,
        phase,
        runAgeMs: Math.max(0, now - run.startedAt),
        tools,
      });
    }
    return active;
  }

  await startSubscription();
  const activate = (): void => {
    activateRunnerAdmission();
  };

  return {
    activate,
    beginDrain,
    getActiveLevel1Work,
    snapshotRecoverables,
    snapshotQueueAttempts,
    prepareRecovery,
    getActiveDrainOperation: () => activeDrainOperation,
    getTerminalCleanupOperations: () => terminalCleanupOperations,
    stop: async () => {
      stopRunnerAdmission();
      await stopSubscription();
      if (terminalCleanupCompletion) {
        let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
        const completed = await Promise.race([
          terminalCleanupCompletion.then(() => true),
          new Promise<false>((resolve) => {
            deadlineTimer = setTimeout(() => resolve(false), TERMINAL_CLEANUP_SHUTDOWN_WAIT_MS);
            deadlineTimer.unref?.();
          }),
        ]).finally(() => {
          if (deadlineTimer) clearTimeout(deadlineTimer);
        });
        if (!completed) {
          logger.warn("terminal agent-runner cleanup exceeded shutdown wait", {
            timeoutMs: TERMINAL_CLEANUP_SHUTDOWN_WAIT_MS,
            pendingLabels: terminalCleanupOperations.map(({ label }) => label),
          });
        }
      }
      bySession.clear();
      queueLifecycleAttempts.clear();
      reservedQueueEntries.clear();
      forcedRecoveryByRequestId.clear();
      restartAbortRequestIds.clear();
    },
  };
}

async function publishLifecycle(params: {
  bus: LilacBus;
  headers: {
    request_id: string;
    session_id: string;
    request_client: AdapterPlatform;
    router_session_mode?: "mention" | "active";
  };
  state: RequestLifecycleState;
  detail?: string;
}) {
  const published = await params.bus.publish(
    lilacEventTypes.EvtRequestLifecycleChanged,
    { state: params.state, detail: params.detail, ts: Date.now() },
    { headers: params.headers },
  );
  if (published.status === "error") signalBusAgentRunnerHostFailure(published.error);
}

function mergeQueuedForSameRequest(
  first: Enqueued,
  queue: Enqueued[],
  reservedQueueEntries: ReadonlySet<Enqueued>,
): { readonly messages: ModelMessage[]; readonly discarded: readonly Enqueued[] } {
  const merged: ModelMessage[] = [...first.messages];
  const discarded: Enqueued[] = [];

  // Pull in any already-queued items for the same request id so they become
  // additional user messages in the same initial run.
  for (let i = 0; i < queue.length; ) {
    const next = queue[i]!;
    if (next.requestId !== first.requestId || reservedQueueEntries.has(next)) {
      i += 1;
      continue;
    }

    merged.push(...next.messages);
    first.currentTurnUserId = next.currentTurnUserId;
    discarded.push(next);
    queue.splice(i, 1);
  }

  if (discarded.length > 0) {
    first.corePrimaryLineage = degradeCorePrimaryLineageForMutation(
      "queued-request-coalesced",
      first.corePrimaryLineage?.currentCanonicalStart,
    );
  }

  return { messages: merged, discarded };
}

async function applyToRunningAgent(
  agent: AiSdkPiAgent<ToolSet>,
  entry: Enqueued,
  cancelledByRequestId: Set<string>,
  activeRun: SessionQueue["activeRun"],
) {
  activeRun?.flushOutput();
  const merged = mergeToSingleUserMessage(entry.messages);
  const liveParent = activeRun?.liveParent;
  const claudeCodeControl = activeRun?.claudeCodeControl;
  const notifyWaiters = activeRun?.notifyWaiters;
  const queueWhileIdle = (mode: "followUp" | "steer") => {
    if (mode === "steer") {
      agent.steer(merged);
    } else {
      agent.followUp(merged);
    }
    notifyWaiters?.();
  };

  const promptWhileIdle = () => {
    void agent.prompt(merged).catch(() => {
      notifyWaiters?.();
    });
    notifyWaiters?.();
  };

  const cancel = parseRequestControlFromRaw(entry.raw).cancel;
  if (!cancel) activeRun?.setCurrentTurnUserId(entry.currentTurnUserId);
  if (!cancel && activeRun?.runProfile === "primary" && activeRun.requestClient === "discord") {
    activeRun.corePrimaryLineage = degradeCorePrimaryLineageForMutation(
      entry.queue === "steer" || entry.queue === "interrupt"
        ? "steering-transform"
        : "follow-up-transform",
      agent.state.messages.length,
    );
  }

  const hasBufferedCompletions = liveParent?.snapshot().hasPendingCompletions ?? false;

  if (!agent.state.isStreaming) {
    switch (entry.queue) {
      case "steer": {
        if (hasBufferedCompletions) {
          queueWhileIdle("steer");
          return;
        }
        promptWhileIdle();
        return;
      }
      case "followUp":
      case "prompt": {
        if (hasBufferedCompletions) {
          queueWhileIdle("followUp");
          return;
        }
        promptWhileIdle();
        return;
      }
      case "interrupt": {
        if (cancel) {
          cancelledByRequestId.add(entry.requestId);
          await liveParent?.cancelAll("parent request aborted");
          agent.cancel();
          notifyWaiters?.();
          return;
        }
        if (hasBufferedCompletions) {
          queueWhileIdle("steer");
          return;
        }
        await agent.interrupt(merged);
        notifyWaiters?.();
        return;
      }
      default: {
        const _exhaustive: never = entry.queue;
        return _exhaustive;
      }
    }
  }

  switch (entry.queue) {
    case "steer": {
      const steeringId = agent.steer(merged);
      if (merged.role === "user" && typeof merged.content === "string") {
        claudeCodeControl?.inject(merged.content, (delivered) => {
          if (delivered) agent.acknowledgeSteeringDelivery(steeringId);
        });
      }
      notifyWaiters?.();
      return;
    }
    case "followUp": {
      agent.followUp(merged);
      notifyWaiters?.();
      return;
    }
    case "interrupt": {
      if (cancel) {
        cancelledByRequestId.add(entry.requestId);
        await liveParent?.cancelAll("parent request aborted");
        await claudeCodeControl?.interrupt();
        agent.cancel();
        notifyWaiters?.();
        return;
      }
      agent.steer(merged);
      const interruptedNatively = (await claudeCodeControl?.interrupt()) ?? false;
      if (!interruptedNatively) agent.interruptQueuedSteering();
      notifyWaiters?.();
      return;
    }
    case "prompt": {
      // Cannot prompt while streaming; treat as followUp.
      agent.followUp(merged);
      notifyWaiters?.();
      return;
    }
    default: {
      const _exhaustive: never = entry.queue;
      return _exhaustive;
    }
  }
}

export function selectPersistedTranscriptMessages(input: {
  finalMessages: readonly ModelMessage[];
  responseStartIndex: number;
  isPrimary: boolean;
  didCompact: boolean;
}): ModelMessage[] {
  if (!input.isPrimary || input.didCompact) return [...input.finalMessages];
  return input.finalMessages.slice(input.responseStartIndex);
}

export function resolveCompactionCheckpointMeta(input: {
  runSucceeded: boolean;
  isPrimary: boolean;
  isCancelled: boolean;
  shouldSkipSurfaceReply: boolean;
  completedCompactionCount: number;
}) {
  if (
    !input.runSucceeded ||
    !input.isPrimary ||
    input.isCancelled ||
    input.shouldSkipSurfaceReply ||
    input.completedCompactionCount <= 0
  ) {
    return undefined;
  }

  return {
    type: "compaction",
    formatVersion: COMPACTION_CHECKPOINT_FORMAT_VERSION,
  } as const;
}

export function mergeToSingleUserMessage(messages: ModelMessage[]): ModelMessage {
  const userMessages = messages.filter((m) => m.role === "user");
  if (userMessages.length === 0) {
    return { role: "user", content: "" };
  }

  const hasMultipart = userMessages.some((m) => typeof m.content !== "string");

  if (hasMultipart) {
    const parts: UserContent = [];
    for (let i = 0; i < userMessages.length; i++) {
      const msg = userMessages[i]!;
      if (i > 0) {
        parts.push({ type: "text", text: "\n\n" });
      }

      if (typeof msg.content === "string") {
        if (msg.content.length > 0) {
          parts.push({ type: "text", text: msg.content });
        }
      } else {
        parts.push(...msg.content);
      }
    }

    return {
      role: "user",
      content: parts,
    };
  }

  // Preserve existing behavior: merge batches into one user message separated by blank lines.
  const parts: string[] = [];
  for (const m of userMessages) {
    if (typeof m.content === "string") {
      parts.push(m.content);
    }
  }

  return {
    role: "user",
    content: parts.join("\n\n").trim(),
  };
}
