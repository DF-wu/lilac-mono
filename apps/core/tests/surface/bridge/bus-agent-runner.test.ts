import { describe, expect, it } from "bun:test";
import path from "node:path";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  buildCoreLineageManifestV1,
  createLilacBus,
  lilacEventTypes,
  outReqTopic,
  parseCorePrimaryLineageV1,
  type CmdRequestMessageData,
  type CoreLineageManifestV1,
  type CorePrimaryLineageV1,
  type HandleContext,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";
import {
  RESPONSE_COMMENTARY_INSTRUCTIONS,
  createLogger,
  ModelCapability,
  parseCoreConfigV1ToUniversal,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import { jsonSchema, tool, type ModelMessage, type ToolSet } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import {
  AiSdkPiAgent,
  attachAutoCompaction,
  ToolExpansion,
  buildSyntheticToolCallId,
  hashCanonicalMessagesV1,
  type AiSdkPiAgentOptions,
} from "@stanley2058/lilac-agent";
import {
  materializeClaudeCodeRun,
  type ClaudeNativeAttemptObservation,
  type ClaudeNativeSessionStart,
  type MaterializedClaudeCodeRun,
} from "@stanley2058/lilac-claude-code-bridge";

import {
  AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH,
  applyCompleteLevel1Tools,
  appendAutoInjectedThreadSearchLineage,
  assertWorkflowDispatchPolicy,
  appendConfiguredAliasPromptBlock,
  appendAdditionalSessionMemoBlock,
  buildAutoInjectedThreadSearchOverlay,
  buildCustomCommandFailureFinalText,
  consumeAssistantTextDelta,
  consumeReasoningChunkEvent,
  completeLevel1ToolMapping,
  computeTransientRetryDelayMs,
  createAssistantTextPartBoundaryState,
  createAgentRunIdleWatchdog,
  createTransientModelRetryController,
  degradeCorePrimaryLineageForMutation,
  formatAutoCompactionToolDisplay,
  formatUnknownErrorForDisplay,
  buildHeartbeatOverlayForRequest,
  buildAutoInjectedThreadSearchMessages,
  buildDeferredSubagentResultMessages,
  hasDeferredSubagentResult,
  planDeferredSubagentBoundary,
  maybeBuildAutoInjectedThreadSearchMessages,
  buildPersistedHeartbeatMessages,
  buildSurfaceMetadataOverlay,
  isRetryableTransientModelError,
  isActiveRuntimeModelCompatible,
  isWorkflowAgentRecoveryEntry,
  markAssistantTextPartEnded,
  markAssistantTextPartStarted,
  mapCorePrimaryCompactionCurrentCanonicalStart,
  measureMeaningfulTextUnits,
  mergeToSingleUserMessage,
  maybeAppendResponseCommentaryPrompt,
  resolveSessionAdditionalPrompts,
  refreshSelectedLevel1Tools,
  removeSilentAssistantTurnMessages,
  resolveAgentRunModel,
  resolveAgentRunModelFallbacks,
  selectNextNativeModelFallback,
  shouldRunAutoInjectedThreadSearch,
  shouldQueueIncompatibleActiveRuntimeModel,
  shouldCancelRunPolicyRequest,
  shouldCancelIdleOnlyGlobalRequest,
  shouldUsePersistentCoreClaudeRuntime,
  startBusAgentRunner,
  shouldEnableAnthropicPromptCache,
  selectPersistedTranscriptMessages,
  selectedLevel1ToolNames,
  resolveCompactionCheckpointMeta,
  resolveCorePrimaryTranscriptProviderState,
  resolveCoreStableNamedContinuation,
  toOpenAIPromptCacheKey,
  withReasoningDisplayDefaultForAnthropicModels,
  withBlankLineBetweenTextParts,
  withReasoningSummaryDefaultForOpenAIModels,
  WORKFLOW_REQUEST_CLAIM_HEARTBEAT_MS,
  validateCorePrimaryLineageAtRunnerIntake,
} from "../../../src/surface/bridge/bus-agent-runner";
import { createCorePrimaryClaudeRuntime } from "../../../src/surface/bridge/bus-agent-runner/core-primary-continuation";
import {
  createCoreToolPluginManager,
  type BuiltLevel1Toolset,
  type CoreToolPluginManager,
} from "../../../src/plugins";
import {
  CORE_SURFACE_PROJECTION_FORMAT_VERSION,
  computeCorePrimaryClaudeTerminalHead,
  SqliteTranscriptStore,
} from "../../../src/transcript/transcript-store";
import { createAgentOutputActivityPublisher } from "../../../src/shared/agent-output-activity";
import { createIdleTimer } from "../../../src/shared/idle-timer";
import { startBusRequestRouter } from "../../../src/surface/bridge/bus-request-router";
import { bridgeAdapterToBus } from "../../../src/surface/bridge/publish-to-bus";
import { bridgeBusToAdapter } from "../../../src/surface/bridge/subscribe-from-bus";
import { formatSurfaceMetadataLine } from "../../../src/surface/bridge/surface-metadata";
import type {
  AdapterEventHandler,
  StartOutputOpts,
  SurfaceAdapter,
  SurfaceOutputPart,
  SurfaceOutputStream,
} from "../../../src/surface/adapter";
import type {
  AdapterCapabilities,
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfaceSelf,
  SurfaceSession,
} from "../../../src/surface/types";
import {
  parseSubagentMetaFromRaw,
  parseWorkflowRequestHintFromRaw,
} from "../../../src/surface/bridge/bus-agent-runner/raw";
import {
  buildExperimentalDownloadForAnthropicFallback,
  shouldForceUrlDownloadForAnthropicFallback,
  withStableAnthropicUpstreamOrder,
} from "../../../src/surface/bridge/bus-agent-runner/anthropic-fallback-media";

function level1TestTool(execute: () => unknown) {
  return tool({
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute,
  });
}

function level1TestToolset(params?: {
  catalogExecute?: () => unknown;
  searchExecute?: () => unknown;
  onCatalogCreate?: () => void;
  onBatchUpdate?: (activeToolNames: ReadonlySet<string>) => void;
}): BuiltLevel1Toolset {
  params?.onCatalogCreate?.();
  const catalogTool = level1TestTool(params?.catalogExecute ?? (() => "catalog"));
  const tools = {
    builtin: level1TestTool(() => "builtin"),
    tool_search: level1TestTool(params?.searchExecute ?? (() => "search")),
    deferred_tool: catalogTool,
  } satisfies ToolSet;
  return {
    tools,
    specs: new Map(),
    directToolNames: new Set(["builtin", "tool_search"]),
    catalog: [
      {
        source: "mcp",
        sourceId: "server",
        rawName: "raw_tool",
        modelName: "deferred_tool",
        title: "Deferred tool",
        description: "Deferred metadata",
        identity: { source: "mcp", sourceId: "server", rawToolName: "raw_tool" },
        stableId: "catalog-id",
        tool: catalogTool,
      },
    ],
    catalogMetadata: {
      deferred_tool: {
        sourceId: "server",
        rawName: "raw_tool",
        title: "Deferred tool",
        description: "Deferred metadata",
      },
    },
    updateActiveBatchTools: (activeToolNames) => params?.onBatchUpdate?.(activeToolNames),
    genericOutputNormalizerBypassTools: new Set(["builtin"]),
    aggregateOutputBudgetExemptTools: new Set(),
  };
}

function level1ZeroUsage() {
  return {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
}

function level1TextStep(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "text" },
        { type: "text-delta" as const, id: "text", delta: text },
        { type: "text-end" as const, id: "text" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: level1ZeroUsage(),
        },
      ],
    }),
  };
}

function level1PhasedTextStep(finalText = "Final answer.") {
  const commentaryMetadata = {
    openai: { itemId: "msg_commentary", phase: "commentary" },
  } as const;
  const finalMetadata = { openai: { itemId: "msg_final", phase: "final_answer" } } as const;
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "commentary", providerMetadata: commentaryMetadata },
        {
          type: "text-delta" as const,
          id: "commentary",
          delta: "Commentary.",
          providerMetadata: commentaryMetadata,
        },
        { type: "text-end" as const, id: "commentary", providerMetadata: commentaryMetadata },
        { type: "text-start" as const, id: "final", providerMetadata: finalMetadata },
        {
          type: "text-delta" as const,
          id: "final",
          delta: finalText,
          providerMetadata: finalMetadata,
        },
        { type: "text-end" as const, id: "final", providerMetadata: finalMetadata },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: level1ZeroUsage(),
        },
      ],
    }),
  };
}

function level1ToolCallStep(calls: readonly { toolCallId: string; toolName: string }[]) {
  return {
    stream: simulateReadableStream({
      chunks: [
        ...calls.map((call) => ({ type: "tool-call" as const, ...call, input: "{}" })),
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage: level1ZeroUsage(),
        },
      ],
    }),
  };
}

function level1TextAndToolCallStep(text: string, call: { toolCallId: string; toolName: string }) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "text" },
        { type: "text-delta" as const, id: "text", delta: text },
        { type: "text-end" as const, id: "text" },
        { type: "tool-call" as const, ...call, input: "{}" },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage: level1ZeroUsage(),
        },
      ],
    }),
  };
}

function level1OfferedToolNames(options: { tools?: ReadonlyArray<{ name: string }> }): string[] {
  return (options.tools ?? []).map((entry) => entry.name);
}

describe("runner Level 1 catalog selection", () => {
  it("applies persisted initial selection by stable ID and omits unavailable selected rows", () => {
    const toolset = level1TestToolset();
    const persistedRows = ["catalog-id", "missing-catalog-id"];

    expect([...selectedLevel1ToolNames(toolset, persistedRows)]).toEqual([
      "builtin",
      "tool_search",
      "deferred_tool",
    ]);
    expect(persistedRows).toEqual(["catalog-id", "missing-catalog-id"]);
    expect([...selectedLevel1ToolNames({ ...toolset, catalog: [] }, persistedRows)]).toEqual([
      "builtin",
      "tool_search",
    ]);
    expect(persistedRows).toEqual(["catalog-id", "missing-catalog-id"]);
  });

  it("activates tool_search results on the next step and denies hidden same-step calls", async () => {
    const offered: string[][] = [];
    const selectedIds: string[] = [];
    let catalogCreates = 0;
    let catalogExecutions = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        offered.push(level1OfferedToolNames(options));
        if (offered.length === 1) {
          return level1ToolCallStep([
            { toolCallId: "search", toolName: "tool_search" },
            { toolCallId: "hidden", toolName: "deferred_tool" },
          ]);
        }
        return offered.length === 2
          ? level1ToolCallStep([{ toolCallId: "selected", toolName: "deferred_tool" }])
          : level1TextStep("done");
      },
    });
    const toolset = level1TestToolset({
      onCatalogCreate: () => {
        catalogCreates += 1;
      },
      searchExecute: () => {
        selectedIds.push("catalog-id");
        return "selected";
      },
      catalogExecute: () => {
        catalogExecutions += 1;
        return "catalog";
      },
    });
    let agent: AiSdkPiAgent<ToolSet> | null = null;
    agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: toolset.tools,
      beforeStep: async () => {
        if (!agent) throw new Error("agent not ready");
        await refreshSelectedLevel1Tools({
          target: agent,
          toolset,
          listSelectedCatalogIds: () => selectedIds,
        });
      },
    });

    await agent.prompt("find it");

    expect(catalogCreates).toBe(1);
    expect(catalogExecutions).toBe(1);
    expect(offered).toEqual([
      ["builtin", "tool_search"],
      ["builtin", "tool_search", "deferred_tool"],
      ["builtin", "tool_search", "deferred_tool"],
    ]);
    expect(agent.getLastStepToolSnapshot()?.names).toEqual([
      "builtin",
      "tool_search",
      "deferred_tool",
    ]);
  });

  it("executes selected expansion children and denies hidden children under the same step authority", async () => {
    let selectedExecutions = 0;
    let hiddenExecutions = 0;
    const selectedTool = level1TestTool(() => {
      selectedExecutions += 1;
      return "selected";
    });
    const hiddenTool = level1TestTool(() => {
      hiddenExecutions += 1;
      return "hidden";
    });
    const tools = {
      batch: level1TestTool(
        () =>
          new ToolExpansion("expanded", [
            { toolCallId: "selected-child", toolName: "selected_tool", input: {} },
            { toolCallId: "hidden-child", toolName: "hidden_tool", input: {} },
          ]),
      ),
      selected_tool: selectedTool,
      hidden_tool: hiddenTool,
    } satisfies ToolSet;
    const toolset: BuiltLevel1Toolset = {
      tools,
      specs: new Map(),
      directToolNames: new Set(["batch"]),
      catalog: [
        {
          source: "plugin",
          sourceId: "selected-plugin",
          rawName: "selected",
          modelName: "selected_tool",
          identity: { source: "plugin", sourceId: "selected-plugin", rawToolName: "selected" },
          stableId: "selected-id",
          tool: selectedTool,
        },
        {
          source: "plugin",
          sourceId: "hidden-plugin",
          rawName: "hidden",
          modelName: "hidden_tool",
          identity: { source: "plugin", sourceId: "hidden-plugin", rawToolName: "hidden" },
          stableId: "hidden-id",
          tool: hiddenTool,
        },
      ],
      catalogMetadata: {},
      updateActiveBatchTools: () => {},
      genericOutputNormalizerBypassTools: new Set(),
      aggregateOutputBudgetExemptTools: new Set(),
    };
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        return calls === 1
          ? level1ToolCallStep([{ toolCallId: "batch", toolName: "batch" }])
          : level1TextStep("done");
      },
    });
    let agent: AiSdkPiAgent<ToolSet> | null = null;
    agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools,
      beforeStep: async () => {
        if (!agent) throw new Error("agent not ready");
        await refreshSelectedLevel1Tools({
          target: agent,
          toolset,
          listSelectedCatalogIds: () => ["selected-id"],
        });
      },
    });

    await agent.prompt("batch it");

    expect(selectedExecutions).toBe(1);
    expect(hiddenExecutions).toBe(0);
  });

  it("passes Claude the exact complete tools and deferred metadata with complete authority", () => {
    const toolset = level1TestToolset();
    const mapping = completeLevel1ToolMapping(toolset);
    const applied: { tools?: ToolSet; names?: ReadonlySet<string> } = {};

    applyCompleteLevel1Tools(
      {
        setTools: (tools) => {
          applied.tools = tools;
        },
        setActiveTools: (names) => {
          applied.names = new Set(names);
        },
      },
      toolset,
    );

    expect(mapping.tools).toBe(toolset.tools);
    expect(mapping.catalogMetadata).toBe(toolset.catalogMetadata);
    expect(Object.keys(mapping.catalogMetadata)).toEqual(["deferred_tool"]);
    expect(applied.tools).toBe(toolset.tools);
    expect([...(applied.names ?? [])]).toEqual(["builtin", "tool_search", "deferred_tool"]);
  });

  it("refreshes selection and batch authority without rebuilding the catalog", async () => {
    let catalogCreates = 0;
    let batchUpdates = 0;
    let appliedNames: ReadonlySet<string> = new Set();
    const toolset = level1TestToolset({
      onCatalogCreate: () => {
        catalogCreates += 1;
      },
      onBatchUpdate: () => {
        batchUpdates += 1;
      },
    });

    await refreshSelectedLevel1Tools({
      target: {
        setActiveTools: (names) => {
          appliedNames = names;
        },
      },
      toolset,
      listSelectedCatalogIds: () => [],
    });

    expect(catalogCreates).toBe(1);
    expect(batchUpdates).toBe(1);
    expect([...appliedNames]).toEqual(["builtin", "tool_search"]);
  });
});

describe("reasoning chunk streaming", () => {
  it("publishes accumulated snapshots before thinking_end without duplicating on end", () => {
    const state = { chunks: new Map<string, string>(), seq: 0 };

    expect(
      consumeReasoningChunkEvent(state, { type: "delta", chunkId: "reasoning-1", delta: "" }),
    ).toEqual({ publishStart: true, snapshot: null });
    expect(
      consumeReasoningChunkEvent(state, {
        type: "delta",
        chunkId: "reasoning-1",
        delta: "**Inspecting**",
      }),
    ).toEqual({
      publishStart: false,
      snapshot: { delta: "**Inspecting**", seq: 1 },
    });
    expect(
      consumeReasoningChunkEvent(state, {
        type: "delta",
        chunkId: "reasoning-1",
        delta: "\n\nChecking the stream.",
      }),
    ).toEqual({
      publishStart: false,
      snapshot: { delta: "**Inspecting**\n\nChecking the stream.", seq: 2 },
    });
    expect(consumeReasoningChunkEvent(state, { type: "end", chunkId: "reasoning-1" })).toEqual({
      publishStart: false,
      snapshot: null,
    });
    expect(state.chunks.has("reasoning-1")).toBe(false);
  });
});

describe("deferred subagent result", () => {
  it("exposes the durable workflow run ID without exposing the child request ID", () => {
    const messages = buildDeferredSubagentResultMessages({
      runId: "wfrun:subagent:opaque-run",
      parentToolCallId: "delegate-call",
      childRequestId: "sub:synthetic-child-request",
      profile: "explore",
      sessionName: "audit",
      status: "resolved",
      ok: true,
      finalText: "complete",
    });

    expect(messages).toMatchObject([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: "subagent_result",
            input: { workflowRunId: "wfrun:subagent:opaque-run" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "subagent_result",
            output: {
              type: "json",
              value: { workflowRunId: "wfrun:subagent:opaque-run" },
            },
          },
        ],
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain("synthetic-child-request");
  });

  it("deduplicates a recovered legacy child-request result while emitting only the run ID form", () => {
    const completion = {
      runId: "wfrun:subagent:recovered-run",
      parentToolCallId: "delegate-call",
      childRequestId: "sub:legacy-child-request",
      profile: "explore" as const,
      sessionName: "recovered-audit",
      status: "resolved" as const,
      ok: true,
      finalText: "recovered",
    };
    const legacyToolCallId = buildSyntheticToolCallId({
      prefix: "subagent_result",
      seed: completion.childRequestId,
    });
    const checkpointMessages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: legacyToolCallId,
            toolName: "subagent_result",
            output: { type: "json", value: { status: "resolved" } },
          },
        ],
      },
    ];

    expect(hasDeferredSubagentResult(checkpointMessages, completion)).toBe(true);

    const emitted = buildDeferredSubagentResultMessages(completion);
    const emittedAssistant = emitted[0];
    if (
      emittedAssistant?.role !== "assistant" ||
      !Array.isArray(emittedAssistant.content) ||
      emittedAssistant.content[0]?.type !== "tool-call"
    ) {
      throw new Error("expected a synthetic subagent result tool call");
    }
    const emittedToolCallId = emittedAssistant.content[0].toolCallId;
    expect(emittedToolCallId).toBe(
      buildSyntheticToolCallId({ prefix: "subagent_result", seed: completion.runId }),
    );
    expect(emittedToolCallId).not.toBe(legacyToolCallId);
    expect(hasDeferredSubagentResult(emitted, completion)).toBe(true);

    const upgrade = planDeferredSubagentBoundary({
      canonicalMessages: checkpointMessages,
      modelInputMessages: [],
      completions: [completion],
    });
    expect(upgrade.append).toEqual(emitted);
    expect(upgrade.forceNextTurn).toBe(true);
  });

  it("keeps appended results pending until they appear in a model input", () => {
    const completion = {
      runId: "wfrun:subagent:boundary-run",
      parentToolCallId: "delegate-call",
      childRequestId: "sub:boundary-child",
      profile: "explore" as const,
      sessionName: "boundary-audit",
      status: "resolved" as const,
      ok: true,
      finalText: "boundary result",
    };

    const admitted = planDeferredSubagentBoundary({
      canonicalMessages: [],
      modelInputMessages: [],
      completions: [completion],
    });
    expect(admitted.append).toEqual(buildDeferredSubagentResultMessages(completion));
    expect(admitted.consumedRunIds).toEqual([]);
    expect(admitted.forceNextTurn).toBe(true);

    const appendedButUnconsumed = planDeferredSubagentBoundary({
      canonicalMessages: admitted.append,
      modelInputMessages: [],
      completions: [completion],
    });
    expect(appendedButUnconsumed.append).toEqual([]);
    expect(appendedButUnconsumed.consumedRunIds).toEqual([]);
    expect(appendedButUnconsumed.forceNextTurn).toBe(true);

    const consumed = planDeferredSubagentBoundary({
      canonicalMessages: admitted.append,
      modelInputMessages: admitted.append,
      completions: [completion],
    });
    expect(consumed.append).toEqual([]);
    expect(consumed.consumedRunIds).toEqual([completion.runId]);
    expect(consumed.forceNextTurn).toBe(false);
  });

  it("recognizes consumption after provider tool-call ID normalization", () => {
    const completion = {
      runId: "wfrun:subagent:normalized-run",
      parentToolCallId: "delegate-call",
      childRequestId: "sub:normalized-child",
      profile: "explore" as const,
      sessionName: "normalized-audit",
      status: "resolved" as const,
      ok: true,
      finalText: "normalized result",
    };
    const normalizedModelInput: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "subagentr",
            toolName: "subagent_result",
            input: { workflowRunId: completion.runId, status: "resolved" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "subagentr",
            toolName: "subagent_result",
            output: {
              type: "json",
              value: { workflowRunId: completion.runId, finalText: "normalized result" },
            },
          },
        ],
      },
    ];

    const consumed = planDeferredSubagentBoundary({
      canonicalMessages: buildDeferredSubagentResultMessages(completion),
      modelInputMessages: normalizedModelInput,
      completions: [completion],
    });

    expect(consumed.consumedRunIds).toEqual([completion.runId]);
    expect(consumed.forceNextTurn).toBe(false);

    const assistantOnly = planDeferredSubagentBoundary({
      canonicalMessages: buildDeferredSubagentResultMessages(completion),
      modelInputMessages: [normalizedModelInput[0]!],
      completions: [completion],
    });
    expect(assistantOnly.consumedRunIds).toEqual([]);
    expect(assistantOnly.forceNextTurn).toBe(true);

    const missingResult = planDeferredSubagentBoundary({
      canonicalMessages: [buildDeferredSubagentResultMessages(completion)[0]!],
      modelInputMessages: [],
      completions: [completion],
    });
    expect(missingResult.append).toEqual([buildDeferredSubagentResultMessages(completion)[1]!]);
  });
});

describe("subagent model selection", () => {
  it("runtime-validates primary lineage, rejects stale proof, and omits it outside Discord", () => {
    const messages = [{ role: "user", content: "hello" }] satisfies ModelMessage[];
    const manifest = buildCoreLineageManifestV1([
      {
        atoms: [
          {
            kind: "surface",
            requestClient: "discord",
            surfaceId: "discord:channel",
            sessionId: "channel",
            messageId: "message",
          },
        ],
        canonicalMessages: messages,
      },
    ]);
    const staleStore = {
      saveRequestTranscript() {},
      linkSurfaceMessagesToRequest() {},
      getCoreSurfaceProjection() {
        return null;
      },
      getTranscriptBySurfaceMessage() {
        return null;
      },
      validateCorePrimaryLineageReferences() {
        return "stale-surface-lineage";
      },
      close() {},
    };
    const validStore = {
      ...staleStore,
      getCoreSurfaceProjection() {
        return {
          requestClient: "discord" as const,
          surfaceId: "discord:channel",
          sessionId: "channel",
          messageId: "message",
          projectionFormatVersion: 1 as const,
          canonicalMessages: messages,
          sourceFacts: {
            segmentMessageIds: ["message"],
            segmentDigest: hashCanonicalMessagesV1(messages).hash,
          },
          ownedBlobs: [],
          createdAt: 1,
        };
      },
      validateCorePrimaryLineageReferences(input: { manifest: CoreLineageManifestV1 }) {
        return input.manifest.segments[0]?.canonicalMessages[0]?.content === "hello"
          ? null
          : "transformed-surface-lineage";
      },
    };

    expect(
      validateCorePrimaryLineageAtRunnerIntake({
        requestClient: "discord",
        sessionId: "channel",
        runProfile: "primary",
        messages,
        corePrimaryLineage: manifest,
        transcriptStore: validStore,
      }),
    ).toEqual(manifest);

    expect(
      validateCorePrimaryLineageAtRunnerIntake({
        requestClient: "discord",
        sessionId: "channel",
        runProfile: "primary",
        messages,
        corePrimaryLineage: manifest,
        transcriptStore: staleStore,
      }),
    ).toEqual({
      state: "fresh-only",
      lineageVersion: 1,
      currentCanonicalStart: 0,
      reason: "stale-surface-lineage",
    });
    const transformedMessages = [{ role: "user", content: "edited" }] satisfies ModelMessage[];
    const transformedManifest = buildCoreLineageManifestV1([
      {
        atoms: manifest.segments[0]!.atoms,
        canonicalMessages: transformedMessages,
      },
    ]);
    expect(
      validateCorePrimaryLineageAtRunnerIntake({
        requestClient: "discord",
        sessionId: "channel",
        runProfile: "primary",
        messages: transformedMessages,
        corePrimaryLineage: transformedManifest,
        transcriptStore: validStore,
      }),
    ).toEqual({
      state: "fresh-only",
      lineageVersion: 1,
      currentCanonicalStart: 0,
      reason: "transformed-surface-lineage",
    });
    expect(
      validateCorePrimaryLineageAtRunnerIntake({
        requestClient: "discord",
        sessionId: "channel",
        runProfile: "primary",
        messages,
        corePrimaryLineage: { ...manifest, segments: [] },
        transcriptStore: staleStore,
      }),
    ).toEqual({
      state: "fresh-only",
      lineageVersion: 1,
      currentCanonicalStart: 0,
      reason: "malformed-or-unaligned-manifest",
    });
    expect(
      validateCorePrimaryLineageAtRunnerIntake({
        requestClient: "github",
        sessionId: "channel",
        runProfile: "primary",
        messages,
        corePrimaryLineage: manifest,
        transcriptStore: staleStore,
      }),
    ).toBeUndefined();
  });

  it("enables persistent Claude only for Discord primary or stable named ownership", () => {
    const manifest = buildCoreLineageManifestV1([
      {
        atoms: [
          {
            kind: "synthetic",
            source: "test",
            messageDigest: "11".repeat(32),
          },
        ],
        canonicalMessages: [{ role: "user", content: "hello" }],
      },
    ]);
    expect(
      shouldUsePersistentCoreClaudeRuntime({
        runProfile: "primary",
        requestClient: "discord",
        stableNamedContinuation: null,
        corePrimaryLineage: manifest,
      }),
    ).toBe(true);
    expect(
      shouldUsePersistentCoreClaudeRuntime({
        runProfile: "primary",
        requestClient: "github",
        stableNamedContinuation: null,
        corePrimaryLineage: manifest,
      }),
    ).toBe(false);
  });

  it("treats missing provider metadata and unidentified assistant history as mixed", () => {
    const requestLineage = buildCoreLineageManifestV1([
      {
        atoms: [
          {
            kind: "request",
            requestId: "request",
            transcriptDigest: "11".repeat(32),
            providerFamily: "claude-code",
            containsCrossFamilyTurns: false,
          },
        ],
        requestSource: {
          aliases: [
            {
              requestClient: "discord",
              surfaceId: "discord:channel",
              sessionId: "channel",
              messageId: "output",
            },
          ],
        },
        canonicalMessages: [{ role: "assistant", content: "request output" }],
      },
    ]);
    expect(
      resolveCorePrimaryTranscriptProviderState({
        targetFamily: "claude-code",
        lineage: requestLineage,
      }).containsCrossFamilyTurns,
    ).toBe(true);

    const syntheticAssistantLineage = buildCoreLineageManifestV1([
      {
        atoms: [{ kind: "synthetic", source: "test", messageDigest: "22".repeat(32) }],
        canonicalMessages: [{ role: "assistant", content: "unknown provider" }],
      },
    ]);
    expect(
      resolveCorePrimaryTranscriptProviderState({
        targetFamily: "claude-code",
        lineage: syntheticAssistantLineage,
      }).containsCrossFamilyTurns,
    ).toBe(true);
  });

  it("marks queue, follow-up, steering, recovery, and synthetic transforms fresh-only", () => {
    for (const reason of [
      "queued-request-coalesced",
      "queued-buffer-absorbed-into-steering",
      "follow-up-transform",
      "steering-transform",
      "restart-recovery-checkpoint",
      "compaction-checkpoint-transform",
      "synthetic-thread-search-insertion",
      "deferred-result-insertion",
    ]) {
      expect(degradeCorePrimaryLineageForMutation(reason)).toEqual({
        state: "fresh-only",
        lineageVersion: 1,
        currentCanonicalStart: 0,
        reason,
      });
    }
  });

  it("parses the minimal workflow dispatch hint and requires its epoch", () => {
    expect(
      parseWorkflowRequestHintFromRaw({
        workflow: {
          runId: "run-1",
          operationId: "operation-1",
          dispatchEpoch: "dispatch-epoch-0001",
        },
      }),
    ).toEqual({
      runId: "run-1",
      operationId: "operation-1",
      dispatchEpoch: "dispatch-epoch-0001",
    });
    expect(
      parseWorkflowRequestHintFromRaw({
        workflow: { runId: "run-1", operationId: "operation-1" },
      }),
    ).toBeNull();
  });

  it("parses a subagent reasoning override from raw request metadata", () => {
    expect(
      parseSubagentMetaFromRaw({
        subagent: { profile: "explore", depth: 1, reasoning: "xhigh" },
      }),
    ).toEqual({ profile: "explore", depth: 1, reasoning: "xhigh" });
  });

  it("preserves subagent profile and depth when reasoning metadata is invalid", () => {
    expect(
      parseSubagentMetaFromRaw({
        subagent: { profile: "explore", depth: 2, reasoning: "future-effort" },
      }),
    ).toEqual({ profile: "explore", depth: 2 });
  });

  it("resolves an agent-selectable alias and applies per-call reasoning", () => {
    const cfg = parseCoreConfigV1ToUniversal({});
    cfg.models.def = {
      scout: {
        model: "openai/gpt-4o-mini",
        reasoning: "low",
        agentCanSelect: true,
      },
    };

    const resolved = resolveAgentRunModel({
      cfg,
      runProfile: "explore",
      requestModelOverride: "scout",
      reasoningOverride: "high",
    });

    expect(resolved.head.alias).toBe("scout");
    expect(resolved.head.spec).toBe("openai/gpt-4o-mini");
    expect(resolved.head.reasoning).toBe("high");
  });

  it("rejects direct and opted-out subagent model overrides", () => {
    const cfg = parseCoreConfigV1ToUniversal({});
    cfg.models.def = {
      manual: {
        model: "openai/gpt-4o",
        agentCanSelect: false,
      },
    };

    expect(() =>
      resolveAgentRunModel({
        cfg,
        runProfile: "general",
        requestModelOverride: "openai/gpt-4o",
      }),
    ).toThrow("must be a models.def alias");
    expect(() =>
      resolveAgentRunModel({
        cfg,
        runProfile: "general",
        requestModelOverride: "manual",
      }),
    ).toThrow("not available for agent selection");
  });

  it("allows an opted-out alias in an explicit static profile", () => {
    const cfg = parseCoreConfigV1ToUniversal({});
    cfg.models.def = {
      manual: {
        model: "openai/gpt-4o",
        agentCanSelect: false,
      },
    };
    cfg.agent.subagents.profiles.general = {
      ...cfg.agent.subagents.profiles.general,
      modelSlot: "main",
      model: "manual",
    };

    const resolved = resolveAgentRunModel({
      cfg,
      runProfile: "general",
    });

    expect(resolved.head.alias).toBe("manual");
  });

  it("applies reasoning overrides to the configured profile fallback", () => {
    const cfg = parseCoreConfigV1ToUniversal({});
    cfg.agent.subagents.profiles.explore = {
      ...cfg.agent.subagents.profiles.explore,
      modelSlot: "fast",
      reasoning: "low",
    };

    const resolved = resolveAgentRunModel({
      cfg,
      runProfile: "explore",
      reasoningOverride: "medium",
    });

    expect(resolved.head.reasoning).toBe("medium");
  });

  it("rehydrates a durable workflow model request without current preset resolution", () => {
    const cfg = parseCoreConfigV1ToUniversal({});
    cfg.models.def = {
      changed: {
        model: "openai/current-model",
        options: { openai: { route: "current" } },
      },
    };
    const resolved = resolveAgentRunModel({
      cfg,
      runProfile: "general",
      resolvedModelRequest: {
        alias: "removed-preset",
        spec: "codex/durable-model",
        provider: "codex",
        modelId: "durable-model",
        providerOptions: { openai: { route: "durable", store: false } },
        reasoning: "high",
        responseCommentary: true,
        anthropicPromptCache: true,
        reasoningDisplay: "none",
      },
    });

    expect(resolved.head).toMatchObject({
      alias: "removed-preset",
      spec: "codex/durable-model",
      provider: "codex",
      modelId: "durable-model",
      providerOptions: { openai: { route: "durable", store: false } },
      reasoning: "high",
      responseCommentary: true,
      anthropicPromptCache: true,
    });
  });

  it("preserves request alias fallback order and applies the strongest reasoning chain-wide", () => {
    const cfg = parseCoreConfigV1ToUniversal({});
    cfg.models.def = {
      requested: {
        model: "openai/head",
        reasoning: "low",
        agentCanSelect: true,
        fallback: [
          "openai/backup",
          { model: "openai/special", reasoning: "none" },
          "openai/backup",
        ],
      },
    };
    cfg.agent.subagents.profiles.general = {
      ...cfg.agent.subagents.profiles.general,
      reasoning: "medium",
    };

    const defaultReasoningPlan = resolveAgentRunModel({
      cfg,
      runProfile: "general",
      requestModelOverride: "requested",
    });
    expect(
      [defaultReasoningPlan.head, ...defaultReasoningPlan.fallbacks].map(
        (candidate) => candidate.reasoning,
      ),
    ).toEqual(["medium", "medium", "none", "medium"]);

    const plan = resolveAgentRunModel({
      cfg,
      runProfile: "general",
      requestModelOverride: "requested",
      reasoningOverride: "xhigh",
    });

    expect([plan.head, ...plan.fallbacks].map((candidate) => candidate.spec)).toEqual([
      "openai/head",
      "openai/backup",
      "openai/special",
      "openai/backup",
    ]);
    expect([plan.head, ...plan.fallbacks].map((candidate) => candidate.reasoning)).toEqual([
      "xhigh",
      "xhigh",
      "xhigh",
      "xhigh",
    ]);
  });

  it("resolves current override fallbacks without resolving or validating the alias head", () => {
    const cfg = parseCoreConfigV1ToUniversal({});
    cfg.models.def = {
      requested: {
        model: "invalid-changed-head",
        agentCanSelect: false,
        fallback: ["openai/current", { model: "openai/explicit", reasoning: "low" }],
      },
    };
    cfg.agent.subagents.profiles.general = {
      ...cfg.agent.subagents.profiles.general,
      reasoning: "medium",
    };

    const fallbacks = resolveAgentRunModelFallbacks({
      cfg,
      runProfile: "general",
      requestModelOverride: "requested",
    });

    expect(fallbacks.map((candidate) => [candidate.spec, candidate.reasoning])).toEqual([
      ["openai/current", "medium"],
      ["openai/explicit", "low"],
    ]);
    delete cfg.models.def.requested;
    expect(
      resolveAgentRunModelFallbacks({
        cfg,
        runProfile: "general",
        requestModelOverride: "requested",
        reasoningOverride: "high",
      }),
    ).toEqual([]);
  });

  it("keeps explicit profile and slot fallbacks when their head aliases are missing", () => {
    const cfg = parseCoreConfigV1ToUniversal({});
    cfg.models.main = {
      model: "missing-slot-head",
      fallback: ["openai/slot-backup"],
    };
    cfg.agent.subagents.profiles.general = {
      ...cfg.agent.subagents.profiles.general,
      model: "missing-profile-head",
      fallback: ["openai/profile-backup"],
    };

    expect(
      resolveAgentRunModelFallbacks({ cfg, runProfile: "general" }).map(
        (candidate) => candidate.spec,
      ),
    ).toEqual(["openai/profile-backup"]);
    expect(
      resolveAgentRunModelFallbacks({ cfg, runProfile: "explore" }).map(
        (candidate) => candidate.spec,
      ),
    ).toEqual(["openai/slot-backup"]);
  });

  it("uses explicit profile fallback and profile reasoning unless an entry overrides it", () => {
    const cfg = parseCoreConfigV1ToUniversal({});
    cfg.models.def = {
      profile: {
        model: "openai/profile",
        fallback: ["openai/alias-backup"],
      },
    };
    cfg.agent.subagents.profiles.general = {
      ...cfg.agent.subagents.profiles.general,
      model: "profile",
      reasoning: "medium",
      fallback: [
        "openai/common-reasoning",
        { model: "openai/own-reasoning", reasoning: "low" },
        "openai/common-reasoning",
      ],
    };

    const plan = resolveAgentRunModel({ cfg, runProfile: "general" });

    expect([plan.head, ...plan.fallbacks].map((candidate) => candidate.spec)).toEqual([
      "openai/profile",
      "openai/common-reasoning",
      "openai/own-reasoning",
      "openai/common-reasoning",
    ]);
    expect([plan.head, ...plan.fallbacks].map((candidate) => candidate.reasoning)).toEqual([
      "medium",
      "medium",
      "low",
      "medium",
    ]);
  });

  it("lets profile fallback replace slot and alias fallback", () => {
    const cfg = parseCoreConfigV1ToUniversal({});
    cfg.models.def = {
      slot: { model: "openai/slot", fallback: ["openai/alias-backup"] },
    };
    cfg.models.fast = { model: "slot", fallback: ["openai/slot-backup"] };
    cfg.agent.subagents.profiles.explore = {
      ...cfg.agent.subagents.profiles.explore,
      modelSlot: "fast",
      fallback: ["openai/profile-backup", "openai/profile-backup"],
    };

    const plan = resolveAgentRunModel({ cfg, runProfile: "explore" });

    expect([plan.head, ...plan.fallbacks].map((candidate) => candidate.spec)).toEqual([
      "openai/slot",
      "openai/profile-backup",
      "openai/profile-backup",
    ]);
  });

  it("inherits alias fallback for a direct profile and slot fallback for a slot profile", () => {
    const cfg = parseCoreConfigV1ToUniversal({});
    cfg.models.def = {
      direct: { model: "openai/direct", fallback: ["openai/direct-alias-backup"] },
      slot: { model: "openai/slot", fallback: ["openai/slot-alias-backup"] },
    };
    cfg.models.fast = { model: "slot", fallback: ["openai/slot-backup"] };
    cfg.agent.subagents.profiles.general = {
      ...cfg.agent.subagents.profiles.general,
      model: "direct",
    };
    cfg.agent.subagents.profiles.explore = {
      ...cfg.agent.subagents.profiles.explore,
      modelSlot: "fast",
    };

    expect(
      resolveAgentRunModel({ cfg, runProfile: "general" }).fallbacks.map(
        (candidate) => candidate.spec,
      ),
    ).toEqual(["openai/direct-alias-backup"]);
    expect(
      resolveAgentRunModel({ cfg, runProfile: "explore" }).fallbacks.map(
        (candidate) => candidate.spec,
      ),
    ).toEqual(["openai/slot-backup"]);
  });

  it("rehydrates the complete durable fallback plan", () => {
    const cfg = parseCoreConfigV1ToUniversal({});
    const plan = resolveAgentRunModel({
      cfg,
      runProfile: "general",
      resolvedModelRequest: {
        spec: "openai/durable-head",
        provider: "openai",
        modelId: "durable-head",
        reasoning: "low",
        reasoningDisplay: "simple",
        fallbacks: [
          {
            spec: "openai/durable-backup",
            provider: "openai",
            modelId: "durable-backup",
            reasoning: "high",
            reasoningDisplay: "simple",
          },
        ],
      },
    });

    expect([plan.head, ...plan.fallbacks].map((candidate) => candidate.spec)).toEqual([
      "openai/durable-head",
      "openai/durable-backup",
    ]);
    expect(plan.fallbacks[0]?.reasoning).toBe("high");
    expect(plan.fallbacks[0]?.reasoningDisplay).toBe("simple");
  });

  it("skips claude-code candidates, preserves duplicates, and never advances a claude head", () => {
    const cfg = parseCoreConfigV1ToUniversal({});
    cfg.models.main = {
      model: "openai/head",
      fallback: ["claude-code/sonnet", "openai/backup", "openai/backup"],
    };
    const plan = resolveAgentRunModel({ cfg, runProfile: "primary" });
    const skipped: string[] = [];

    const first = selectNextNativeModelFallback({
      plan,
      activeIndex: 0,
      onSkipClaudeCode: (candidate) => skipped.push(candidate.spec),
    });
    const second = selectNextNativeModelFallback({
      plan,
      activeIndex: first?.index ?? 0,
    });

    expect(skipped).toEqual(["claude-code/sonnet"]);
    expect(first).toMatchObject({ index: 2, candidate: { spec: "openai/backup" } });
    expect(second).toMatchObject({ index: 3, candidate: { spec: "openai/backup" } });

    cfg.models.main = { model: "claude-code/sonnet", fallback: ["openai/backup"] };
    expect(
      selectNextNativeModelFallback({
        plan: resolveAgentRunModel({ cfg, runProfile: "primary" }),
        activeIndex: 0,
      }),
    ).toBeNull();
  });

  it("keeps active model and effort immutable for steering compatibility", () => {
    const requested = {
      spec: "claude-code/sonnet",
      provider: "claude-code",
      modelId: "sonnet",
      model: new MockLanguageModelV4({ modelId: "sonnet" }),
      reasoning: "high" as const,
    };
    expect(
      isActiveRuntimeModelCompatible({
        activeSpec: requested.spec,
        activeReasoning: "high",
        activeFamily: "claude-code",
        requested,
      }),
    ).toBe(true);
    expect(
      isActiveRuntimeModelCompatible({
        activeSpec: requested.spec,
        activeReasoning: "low",
        activeFamily: "claude-code",
        requested,
      }),
    ).toBe(false);
    expect(
      isActiveRuntimeModelCompatible({
        activeSpec: "openai/gpt-5",
        activeReasoning: "high",
        activeFamily: "ai-sdk",
        requested,
      }),
    ).toBe(false);
    expect(
      shouldQueueIncompatibleActiveRuntimeModel({
        activeSpec: "openai/gpt-5",
        activeReasoning: "high",
        activeFamily: "ai-sdk",
        requested,
      }),
    ).toBe(true);
  });

  it("validates workflow reasoning against the operation request, not resolved defaults", () => {
    const policy = {
      runId: "run-1",
      operationId: "operation-1",
      dispatchEpoch: "dispatch-epoch-0001",
      profile: "general" as const,
      model: null,
      reasoning: null,
      resolvedModelRequest: {
        spec: "provider/default-model",
        provider: "provider",
        modelId: "default-model",
        reasoning: "high" as const,
        reasoningDisplay: "simple" as const,
      },
      cwd: "/workspace",
      originSession: {
        requestId: null,
        sessionId: null,
        client: null,
        userId: null,
      },
    };

    expect(() =>
      assertWorkflowDispatchPolicy(policy, { profile: "general", depth: 1 }),
    ).not.toThrow();
    expect(() =>
      assertWorkflowDispatchPolicy(
        { ...policy, reasoning: "medium" },
        { profile: "general", depth: 1, reasoning: "low" },
      ),
    ).toThrow("reasoning does not match the approved operation policy");
  });

  it("accepts only the exact durable stable-named identity", () => {
    const policy = {
      runId: "run-1",
      operationId: "operation-1",
      dispatchEpoch: "dispatch-epoch-0001",
      profile: "general" as const,
      model: null,
      reasoning: null,
      resolvedModelRequest: {
        spec: "claude-code/sonnet",
        provider: "claude-code",
        modelId: "sonnet",
        reasoningDisplay: "simple" as const,
      },
      cwd: "/workspace",
      originSession: {
        requestId: "parent",
        sessionId: "channel",
        client: "discord" as const,
        userId: "user",
      },
      stableNamedContinuation: {
        sessionId: "sub:channel:named:audit",
        requestClient: "discord" as const,
      },
    };

    expect(
      resolveCoreStableNamedContinuation({
        runProfile: "general",
        sessionId: "sub:channel:named:audit",
        workflowPolicy: policy,
      }),
    ).toEqual(policy.stableNamedContinuation);
    expect(
      resolveCoreStableNamedContinuation({
        runProfile: "general",
        sessionId: "sub:channel:named:generated",
        workflowPolicy: { ...policy, stableNamedContinuation: undefined },
      }),
    ).toBeNull();
    expect(() =>
      resolveCoreStableNamedContinuation({
        runProfile: "general",
        sessionId: "sub:channel:named:other",
        workflowPolicy: policy,
      }),
    ).toThrow("does not match the child session");
    expect(() =>
      resolveCoreStableNamedContinuation({
        runProfile: "primary",
        sessionId: "sub:channel:named:audit",
        workflowPolicy: policy,
      }),
    ).toThrow("cannot authorize a primary run");
  });
});

describe("agent run activity", () => {
  function createManualTimers() {
    type Entry = { at: number; cb: () => void };
    let now = 0;
    let nextId = 0;
    const entries = new Map<number, Entry>();

    return {
      timers: {
        now: () => now,
        setTimeout: ((cb: () => void, ms?: number) => {
          nextId += 1;
          entries.set(nextId, { at: now + Math.max(0, ms ?? 0), cb });
          return nextId as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout,
        clearTimeout: ((id: ReturnType<typeof setTimeout>) => {
          entries.delete(id as unknown as number);
        }) as typeof clearTimeout,
      },
      async advance(ms: number) {
        now += ms;
        const due = [...entries]
          .filter(([, entry]) => entry.at <= now)
          .sort((a, b) => a[1].at - b[1].at);
        for (const [id, entry] of due) {
          if (!entries.delete(id)) continue;
          entry.cb();
          await Promise.resolve();
        }
      },
      delay(ms: number): Promise<string> {
        return new Promise((resolve) => {
          this.timers.setTimeout(() => resolve("resolved"), ms);
        });
      },
    };
  }

  it("fails a wait after the configured idle interval", async () => {
    const timedOut: Error[] = [];
    const watchdog = createAgentRunIdleWatchdog({
      idleTimeoutMs: 30,
      onTimeout: (error) => timedOut.push(error),
    });

    watchdog.start();
    await expect(watchdog.waitFor(new Promise<void>(() => {}))).rejects.toThrow(
      "agent idle timed out after 30ms",
    );

    expect(timedOut).toHaveLength(1);
    watchdog.stop();
  });

  it("extends the idle deadline when activity continues", async () => {
    const fakeTimers = createManualTimers();
    let timeoutCount = 0;
    const watchdog = createAgentRunIdleWatchdog({
      idleTimeoutMs: 45,
      onTimeout: () => {
        timeoutCount += 1;
      },
      timers: fakeTimers.timers,
    });

    watchdog.start();
    await fakeTimers.advance(30);
    watchdog.reset();

    const watched = watchdog.waitFor(fakeTimers.delay(30));
    await fakeTimers.advance(30);
    await expect(watched).resolves.toBe("resolved");
    watchdog.stop();
    await fakeTimers.advance(20);
    expect(timeoutCount).toBe(0);
  });

  it("can pause between separately raced operations", async () => {
    let timeoutCount = 0;
    const watchdog = createAgentRunIdleWatchdog({
      idleTimeoutMs: 20,
      onTimeout: () => {
        timeoutCount += 1;
      },
    });

    watchdog.start();
    watchdog.pause();
    // test-wait-justification: crosses the real idle deadline while watchdog timing is paused
    await Bun.sleep(30);

    expect(timeoutCount).toBe(0);
    watchdog.stop();
  });

  it("does not clamp large idle deadlines to an immediate timer", async () => {
    let timeoutCount = 0;
    const timer = createIdleTimer(30 * 24 * 60 * 60 * 1000, () => {
      timeoutCount += 1;
    });

    timer.reset();
    // test-wait-justification: verifies a very large real idle deadline is not clamped to an immediate timer
    await Bun.sleep(10);

    expect(timeoutCount).toBe(0);
    timer.stop();
  });

  it("publishes throttled activity on the request output topic", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const requestId = "activity-request";
    const sources: string[] = [];
    const sub = await bus.subscribeTopic(
      outReqTopic(requestId),
      { mode: "tail", offset: { type: "begin" } },
      async (msg, ctx) => {
        if (msg.type === lilacEventTypes.EvtAgentOutputActivity) {
          sources.push(msg.data.source);
        }
        await ctx.commit();
      },
    );
    const publishActivity = createAgentOutputActivityPublisher({
      publish: async (source) => {
        await bus.publish(
          lilacEventTypes.EvtAgentOutputActivity,
          { source },
          { headers: { request_id: requestId } },
        );
      },
      intervalMs: 25,
    });

    publishActivity("model");
    publishActivity("tool");
    // test-wait-justification: crosses the activity publisher's real throttle interval before the next publish
    await Bun.sleep(30);
    publishActivity("subagent");
    // test-wait-justification: drains the throttled activity publication through the in-memory bus subscriber
    await Bun.sleep(0);

    expect(sources).toEqual(["model", "subagent"]);
    await sub.stop();
  });
});

describe("workflow request claim pacing", () => {
  it("refreshes at one third of the engine's 30s stale-owner threshold", () => {
    expect(WORKFLOW_REQUEST_CLAIM_HEARTBEAT_MS).toBe(10_000);
  });
});

describe("agent recovery ownership", () => {
  it("does not treat workflow-owned recovery entries as root parent requests", () => {
    const base = {
      kind: "active" as const,
      requestId: "request-1",
      sessionId: "session-1",
      requestClient: "discord" as const,
      queue: "prompt" as const,
      messages: [] as ModelMessage[],
    };

    expect(isWorkflowAgentRecoveryEntry(base)).toBe(false);
    expect(
      isWorkflowAgentRecoveryEntry({
        ...base,
        requestId: "wfr:run:operation:0",
        requestClient: "unknown",
        raw: {
          workflow: {
            runId: "run-1",
            operationId: "operation-1",
            dispatchEpoch: "1234567890abcdef",
          },
        },
      }),
    ).toBe(true);
  });
});

describe("selectPersistedTranscriptMessages", () => {
  const finalMessages = [
    { role: "user", content: "compacted summary" },
    { role: "assistant", content: "retained response" },
    { role: "tool", content: [] },
    { role: "assistant", content: "final response" },
  ] satisfies ModelMessage[];

  it("persists response-only messages for ordinary primary runs", () => {
    expect(
      selectPersistedTranscriptMessages({
        finalMessages,
        responseStartIndex: 3,
        isPrimary: true,
        didCompact: false,
      }),
    ).toEqual([finalMessages[3]!]);
  });

  it("persists the full final canonical transcript after compaction despite a stale index", () => {
    expect(
      selectPersistedTranscriptMessages({
        finalMessages,
        responseStartIndex: 99,
        isPrimary: true,
        didCompact: true,
      }),
    ).toEqual(finalMessages);
  });

  it("keeps non-primary full-transcript persistence unchanged", () => {
    expect(
      selectPersistedTranscriptMessages({
        finalMessages,
        responseStartIndex: 3,
        isPrimary: false,
        didCompact: false,
      }),
    ).toEqual(finalMessages);
  });

  it("creates one checkpoint marker after one or many completed compactions", () => {
    for (const completedCompactionCount of [1, 3]) {
      expect(
        resolveCompactionCheckpointMeta({
          runSucceeded: true,
          isPrimary: true,
          isCancelled: false,
          shouldSkipSurfaceReply: false,
          completedCompactionCount,
        }),
      ).toEqual({ type: "compaction", formatVersion: 1 });
    }
  });

  it("does not mark failed, cancelled, skipped, uncompacted, or non-primary runs", () => {
    const base = {
      runSucceeded: true,
      isPrimary: true,
      isCancelled: false,
      shouldSkipSurfaceReply: false,
      completedCompactionCount: 1,
    };
    expect(resolveCompactionCheckpointMeta({ ...base, runSucceeded: false })).toBeUndefined();
    expect(resolveCompactionCheckpointMeta({ ...base, isCancelled: true })).toBeUndefined();
    expect(
      resolveCompactionCheckpointMeta({ ...base, shouldSkipSurfaceReply: true }),
    ).toBeUndefined();
    expect(
      resolveCompactionCheckpointMeta({ ...base, completedCompactionCount: 0 }),
    ).toBeUndefined();
    expect(resolveCompactionCheckpointMeta({ ...base, isPrimary: false })).toBeUndefined();
  });
});

function formatExpectedLocalThreadTimeRange(start: string, end: string): string {
  const format = (value: string) => {
    const date = new Date(value);
    const pad = (part: number) => String(part).padStart(2, "0");
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(
      date.getHours(),
    )}:${pad(date.getMinutes())}`;
  };
  return `${format(start)} - ${format(end)}`;
}

function autoInjectPlanForQuery(query: string, intentSummary: string) {
  return {
    searches: [
      {
        queries: [query],
        aboutness: {
          domains: [],
          situations: [],
          targets: [],
          entities: [],
          userWouldAskForThisAs: [query],
          intentSummary,
        },
      },
    ],
  };
}

function createInMemoryRawBus(): RawBus {
  const topics = new Map<string, Array<Message<unknown>>>();
  const subs = new Set<{
    topic: string;
    opts: SubscriptionOptions;
    handler: (msg: Message<unknown>, ctx: HandleContext) => Promise<void>;
  }>();

  return {
    publish: async <TData>(msg: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const stored: Message<unknown> = {
        topic: opts.topic,
        id,
        type: opts.type,
        ts: Date.now(),
        key: opts.key,
        headers: opts.headers,
        data: msg.data as unknown,
      };

      const list = topics.get(opts.topic) ?? [];
      list.push(stored);
      topics.set(opts.topic, list);

      for (const s of subs) {
        if (s.topic !== opts.topic) continue;
        await s.handler(stored, { cursor: id, commit: async () => {} });
      }

      return { id, cursor: id };
    },

    subscribe: async <TData>(
      topic: string,
      opts: SubscriptionOptions,
      handler: (msg: Message<TData>, ctx: HandleContext) => Promise<void>,
    ) => {
      const entry = {
        topic,
        opts,
        handler: handler as unknown as (msg: Message<unknown>, ctx: HandleContext) => Promise<void>,
      };
      subs.add(entry);

      const offset = opts.offset;
      if (offset?.type === "begin" || offset?.type === "cursor") {
        const existing = topics.get(topic) ?? [];
        const replay =
          offset.type === "cursor"
            ? (() => {
                const cursorIndex = existing.findIndex((m) => m.id === offset.cursor);
                return cursorIndex >= 0 ? existing.slice(cursorIndex + 1) : existing;
              })()
            : existing;
        for (const m of replay) {
          await handler(m as unknown as Message<TData>, {
            cursor: m.id,
            commit: async () => {},
          });
        }
      }

      return {
        stop: async () => {
          subs.delete(entry);
        },
      };
    },

    fetch: async <TData>(topic: string) => {
      const existing = topics.get(topic) ?? [];
      return {
        messages: existing.map((m) => ({
          msg: m as unknown as Message<TData>,
          cursor: m.id,
        })),
        next: existing.length > 0 ? existing[existing.length - 1]?.id : undefined,
      };
    },

    close: async () => {},
  };
}

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

type ProductionPathOutput = {
  readonly messageId: string;
  readonly parts: SurfaceOutputPart[];
  readonly finished: Promise<void>;
};

class ProductionPathDiscordAdapter implements SurfaceAdapter {
  readonly messages = new Map<string, SurfaceMessage>();
  readonly outputs: ProductionPathOutput[] = [];
  readonly updatedOutputMessageIds: string[] = [];
  private readonly handlers = new Set<AdapterEventHandler>();
  private outputSequence = 0;
  private timestamp = 10_000;

  async emitCreated(message: SurfaceMessage): Promise<void> {
    this.messages.set(message.ref.messageId, message);
    await Promise.all(
      [...this.handlers].map((handler) =>
        handler({
          type: "adapter.message.created",
          platform: "discord",
          ts: message.ts,
          message,
        }),
      ),
    );
  }

  private async emitOutputUpdated(message: SurfaceMessage): Promise<void> {
    this.updatedOutputMessageIds.push(message.ref.messageId);
    await Promise.all(
      [...this.handlers].map((handler) =>
        handler({
          type: "adapter.message.updated",
          platform: "discord",
          ts: message.ts,
          message,
        }),
      ),
    );
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async getSelf(): Promise<SurfaceSelf> {
    return { platform: "discord", userId: "bot", userName: "lilac" };
  }

  async getCapabilities(): Promise<AdapterCapabilities> {
    throw new Error("not used");
  }

  async listSessions(): Promise<SurfaceSession[]> {
    throw new Error("not used");
  }

  async startOutput(sessionRef: SessionRef, opts?: StartOutputOpts): Promise<SurfaceOutputStream> {
    this.outputSequence += 1;
    const messageId = `output-${this.outputSequence}`;
    const parts: SurfaceOutputPart[] = [];
    const finished = deferred<void>();
    let outputMessage: SurfaceMessage | null = null;
    let visibleText = "";
    const ensureOutputMessage = (): SurfaceMessage => {
      if (outputMessage) return outputMessage;
      outputMessage = {
        ref: { platform: "discord", channelId: sessionRef.channelId, messageId },
        session: { platform: "discord", channelId: sessionRef.channelId },
        userId: "bot",
        userName: "lilac",
        text: "",
        ts: this.timestamp++,
        raw: {
          reference: opts?.replyTo
            ? { messageId: opts.replyTo.messageId, channelId: opts.replyTo.channelId }
            : {},
          discord: { isChat: true },
        },
      };
      this.messages.set(messageId, outputMessage);
      opts?.onMessageCreated?.(outputMessage.ref);
      return outputMessage;
    };
    this.outputs.push({ messageId, parts, finished: finished.promise });

    return {
      push: async (part) => {
        parts.push(part);
        const message = ensureOutputMessage();
        if (part.type === "text.delta") visibleText += part.delta;
        if (part.type === "text.set") visibleText = part.text;
        message.text = visibleText;
        await this.emitOutputUpdated(message);
      },
      finish: async () => {
        const message = ensureOutputMessage();
        finished.resolve(undefined);
        return { created: [message.ref], last: message.ref };
      },
      abort: async () => {
        finished.resolve(undefined);
      },
      getFinalTextMode: () => "continuation",
    };
  }

  async sendMsg(_sessionRef: SessionRef, _content: ContentOpts, _opts?: SendOpts): Promise<MsgRef> {
    throw new Error("not used");
  }

  async readMsg(msgRef: MsgRef): Promise<SurfaceMessage | null> {
    return this.messages.get(msgRef.messageId) ?? null;
  }

  async listMsg(sessionRef: SessionRef, opts?: LimitOpts): Promise<SurfaceMessage[]> {
    const before = opts?.beforeMessageId ? this.messages.get(opts.beforeMessageId)?.ts : undefined;
    return [...this.messages.values()]
      .filter((message) => message.session.channelId === sessionRef.channelId)
      .filter((message) => before === undefined || message.ts < before)
      .toSorted((left, right) => left.ts - right.ts)
      .slice(-(opts?.limit ?? 50));
  }

  async editMsg(): Promise<void> {}
  async deleteMsg(): Promise<void> {}
  async getReplyContext(): Promise<SurfaceMessage[]> {
    return [];
  }
  async addReaction(): Promise<void> {}
  async removeReaction(): Promise<void> {}
  async listReactions(): Promise<string[]> {
    return [];
  }

  async subscribe(handler: AdapterEventHandler): Promise<{ stop(): Promise<void> }> {
    this.handlers.add(handler);
    return {
      stop: async () => {
        this.handlers.delete(handler);
      },
    };
  }

  async getUnRead(): Promise<SurfaceMessage[]> {
    return [];
  }
  async markRead(): Promise<void> {}
}

async function observeRequestLifecycle(bus: ReturnType<typeof createLilacBus>, requestId: string) {
  const terminal = deferred<"resolved" | "cancelled" | "failed">();
  const states: string[] = [];
  const details: Array<string | undefined> = [];
  const subscription = await bus.subscribeTopic(
    "evt.request",
    { mode: "tail", offset: { type: "begin" } },
    async (message, context) => {
      if (
        message.type === lilacEventTypes.EvtRequestLifecycleChanged &&
        message.headers?.request_id === requestId
      ) {
        states.push(message.data.state);
        details.push(message.data.detail);
        if (
          message.data.state === "resolved" ||
          message.data.state === "cancelled" ||
          message.data.state === "failed"
        ) {
          terminal.resolve(message.data.state);
        }
      }
      await context.commit();
    },
  );
  return { states, details, terminal: terminal.promise, stop: subscription.stop };
}

async function observeResponseAfterOutputRelay(
  bus: ReturnType<typeof createLilacBus>,
  requestId: string,
) {
  const relayed = deferred<void>();
  let outputSubscription: { stop(): Promise<void> } | null = null;
  const lifecycleSubscription = await bus.subscribeTopic(
    "evt.request",
    { mode: "tail", offset: { type: "now" } },
    async (message, context) => {
      if (
        message.type === lilacEventTypes.EvtRequestLifecycleChanged &&
        message.headers?.request_id === requestId &&
        message.data.state === "resolved" &&
        outputSubscription === null
      ) {
        outputSubscription = await bus.subscribeTopic(
          outReqTopic(requestId),
          { mode: "tail", offset: { type: "now" } },
          async (outputMessage, outputContext) => {
            if (outputMessage.type === lilacEventTypes.EvtAgentOutputResponseText) {
              relayed.resolve(undefined);
            }
            await outputContext.commit();
          },
        );
      }
      await context.commit();
    },
  );
  return {
    relayed: relayed.promise,
    stop: async () => {
      await lifecycleSubscription.stop();
      await outputSubscription?.stop();
    },
  };
}

async function publishRunnerRequest(input: {
  bus: ReturnType<typeof createLilacBus>;
  requestId: string;
  sessionId: string;
  queue?: "prompt" | "followUp" | "steer" | "interrupt";
  text: string;
  messages?: ModelMessage[];
  modelOverride?: string;
  requestClient?: "discord" | "github";
  corePrimaryLineage?: CorePrimaryLineageV1;
  raw?: unknown;
}) {
  await input.bus.publish(
    lilacEventTypes.CmdRequestMessage,
    {
      queue: input.queue ?? "prompt",
      messages: input.messages ?? [{ role: "user", content: input.text }],
      ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
      ...(input.corePrimaryLineage ? { corePrimaryLineage: input.corePrimaryLineage } : {}),
      ...(input.raw === undefined ? {} : { raw: input.raw }),
    },
    {
      headers: {
        request_id: input.requestId,
        session_id: input.sessionId,
        request_client: input.requestClient ?? "github",
      },
    },
  );
}

describe("startBusAgentRunner production path", () => {
  it("latches the active model, applies an unqualified follow-up, and queues an explicit change", async () => {
    const config = parseCoreConfigV1ToUniversal({});
    config.models.main = { model: "openai/initial" };
    config.models.def = {
      active: { model: "openai/active", agentCanSelect: true },
      other: { model: "openai/other", agentCanSelect: true },
    };
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-production-"));
    const pluginManager = createCoreToolPluginManager({ runtime: { config }, dataDir });
    const bus = createLilacBus(createInMemoryRawBus());
    const firstCallStarted = deferred<void>();
    const releaseFirstCall = deferred<void>();
    const createdSpecs: string[] = [];
    let activeCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "production-model-latch",
      config,
      pluginManager,
      issueControlCapability: () => ({ capability: "test-capability", principal: null }),
      createAgent: (options: AiSdkPiAgentOptions<ToolSet>) => {
        const spec = options.modelSpecifier ?? "unknown";
        createdSpecs.push(spec);
        const model = new MockLanguageModelV4({
          modelId: spec,
          doStream: async () => {
            if (spec === "openai/active") {
              activeCalls += 1;
              if (activeCalls === 1) {
                firstCallStarted.resolve(undefined);
                await releaseFirstCall.promise;
              }
            }
            return level1TextStep(`${spec} response`);
          },
        });
        return new AiSdkPiAgent({ ...options, model });
      },
    });
    const requestId = "github:session:model-latch";
    const changedRequestId = "github:session:changed-message";
    const activeLifecycle = await observeRequestLifecycle(bus, requestId);
    const changedLifecycle = await observeRequestLifecycle(bus, changedRequestId);

    await publishRunnerRequest({
      bus,
      requestId,
      sessionId: "session",
      text: "first",
      modelOverride: "active",
    });
    expect(
      await Promise.race([
        firstCallStarted.promise.then(() => "model-started" as const),
        activeLifecycle.terminal,
      ]),
    ).toBe("model-started");
    await publishRunnerRequest({
      bus,
      requestId,
      sessionId: "session",
      queue: "followUp",
      text: "same model",
    });
    await publishRunnerRequest({
      bus,
      requestId,
      sessionId: "session",
      queue: "followUp",
      text: "change model",
      modelOverride: "other",
      raw: {
        authenticatedOrigin: { messageRef: { messageId: "changed-message" } },
      },
    });
    expect(changedLifecycle.states).toContain("queued");

    releaseFirstCall.resolve(undefined);
    await expect(activeLifecycle.terminal).resolves.toBe("resolved");
    await expect(changedLifecycle.terminal).resolves.toBe("resolved");
    expect(activeCalls).toBe(2);
    expect(createdSpecs).toEqual(["openai/active", "openai/other"]);

    await activeLifecycle.stop();
    await changedLifecycle.stop();
    await runner.stop();
    await pluginManager.destroy();
    await bus.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("cancels an active model call after the running lifecycle transition", async () => {
    const config = parseCoreConfigV1ToUniversal({});
    config.models.main = { model: "openai/cancellable" };
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-cancel-"));
    const pluginManager = createCoreToolPluginManager({ runtime: { config }, dataDir });
    const bus = createLilacBus(createInMemoryRawBus());
    const modelCallStarted = deferred<void>();
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "production-cancel",
      config,
      pluginManager,
      issueControlCapability: () => ({ capability: "test-capability", principal: null }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "cancellable",
            doStream: async ({ abortSignal }) => {
              modelCallStarted.resolve(undefined);
              await new Promise<void>((resolve) => {
                abortSignal?.addEventListener("abort", () => resolve(), { once: true });
              });
              throw Object.assign(new Error("cancelled"), { name: "AbortError" });
            },
          }),
        }),
    });
    const requestId = "github:cancel-session:request";
    const lifecycle = await observeRequestLifecycle(bus, requestId);

    await publishRunnerRequest({ bus, requestId, sessionId: "cancel-session", text: "start" });
    expect(
      await Promise.race([
        modelCallStarted.promise.then(() => "model-started" as const),
        lifecycle.terminal,
      ]),
    ).toBe("model-started");
    await publishRunnerRequest({
      bus,
      requestId,
      sessionId: "cancel-session",
      queue: "interrupt",
      text: "cancel",
      raw: { cancel: true },
    });

    await expect(lifecycle.terminal).resolves.toBe("cancelled");
    expect(lifecycle.states[0]).toBe("running");
    expect(lifecycle.states.at(-1)).toBe("cancelled");

    await lifecycle.stop();
    await runner.stop();
    await pluginManager.destroy();
    await bus.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("advances the live agent to the configured fallback transport", async () => {
    const config = parseCoreConfigV1ToUniversal({});
    config.models.main = { model: "openai/primary", fallback: ["openai/fallback"] };
    config.agent.retry = { enabled: false, maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 };
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-fallback-"));
    const pluginManager = createCoreToolPluginManager({ runtime: { config }, dataDir });
    const bus = createLilacBus(createInMemoryRawBus());
    const switchedSpecs: Array<string | undefined> = [];
    const successModel = new MockLanguageModelV4({
      modelId: "fallback",
      doStream: async () => level1TextStep("fallback response"),
    });
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "production-fallback",
      config,
      pluginManager,
      issueControlCapability: () => ({ capability: "test-capability", principal: null }),
      createAgent: (options) => {
        const agent = new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "primary",
            doStream: async () => {
              throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
            },
          }),
        });
        const setModel = agent.setModel.bind(agent);
        agent.setModel = (_model, providerOptions, modelSpecifier, reasoning) => {
          switchedSpecs.push(modelSpecifier);
          setModel(successModel, providerOptions, modelSpecifier, reasoning);
        };
        return agent;
      },
    });
    const requestId = "github:fallback-session:request";
    const lifecycle = await observeRequestLifecycle(bus, requestId);

    await publishRunnerRequest({ bus, requestId, sessionId: "fallback-session", text: "start" });

    expect({ terminal: await lifecycle.terminal, details: lifecycle.details }).toEqual({
      terminal: "resolved",
      details: [undefined, undefined],
    });
    expect(switchedSpecs).toEqual(["openai/fallback"]);

    await lifecycle.stop();
    await runner.stop();
    await pluginManager.destroy();
    await bus.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("publishes OpenAI phases and honors a final-answer NO_REPLY", async () => {
    const config = parseCoreConfigV1ToUniversal({});
    config.models.main = { model: "openai/phased" };
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-phased-output-"));
    const pluginManager = createCoreToolPluginManager({ runtime: { config }, dataDir });
    const bus = createLilacBus(createInMemoryRawBus());
    let createdAgents = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "production-phased-output",
      config,
      pluginManager,
      issueControlCapability: () => ({ capability: "test-capability", principal: null }),
      createAgent: (options) => {
        createdAgents += 1;
        return new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "phased",
            doStream: level1PhasedTextStep(createdAgents === 1 ? "Final answer." : "NO_REPLY"),
          }),
        });
      },
    });
    const requestId = "github:phased-output:request";
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    const responsePublished = deferred<void>();
    const textDeltas: Array<{
      delta: string;
      phase?: "commentary" | "final_answer";
      phaseBoundaryPrefixChars?: number;
    }> = [];
    const outputSubscription = await bus.subscribeTopic(
      outReqTopic(requestId),
      { mode: "tail", offset: { type: "now" } },
      async (message, context) => {
        if (message.type === lilacEventTypes.EvtAgentOutputDeltaText) {
          textDeltas.push(message.data);
        }
        if (message.type === lilacEventTypes.EvtAgentOutputResponseText) {
          responsePublished.resolve(undefined);
        }
        await context.commit();
      },
    );

    await publishRunnerRequest({
      bus,
      requestId,
      sessionId: "phased-output",
      text: "show both phases",
    });

    await expect(lifecycle.terminal).resolves.toBe("resolved");
    await responsePublished.promise;
    expect(textDeltas).toEqual([
      { delta: "Commentary.", phase: "commentary" },
      {
        delta: "\n\nFinal answer.",
        phase: "final_answer",
        phaseBoundaryPrefixChars: 2,
      },
    ]);

    const skippedRequestId = "github:phased-output:skip";
    const skippedLifecycle = await observeRequestLifecycle(bus, skippedRequestId);
    const skippedDeltas: typeof textDeltas = [];
    const skippedResets: string[] = [];
    const skippedResponse = deferred<{
      finalText: string;
      delivery?: "reply" | "skip";
    }>();
    const skippedOutputSubscription = await bus.subscribeTopic(
      outReqTopic(skippedRequestId),
      { mode: "tail", offset: { type: "now" } },
      async (message, context) => {
        if (message.type === lilacEventTypes.EvtAgentOutputDeltaText) {
          skippedDeltas.push(message.data);
        }
        if (message.type === lilacEventTypes.EvtAgentOutputTextReset) {
          skippedResets.push(message.data.text);
        }
        if (message.type === lilacEventTypes.EvtAgentOutputResponseText) {
          skippedResponse.resolve(message.data);
        }
        await context.commit();
      },
    );
    await publishRunnerRequest({
      bus,
      requestId: skippedRequestId,
      sessionId: "phased-output-skip",
      text: "skip the final response",
    });

    await expect(skippedLifecycle.terminal).resolves.toBe("resolved");
    await expect(skippedResponse.promise).resolves.toMatchObject({
      finalText: "",
      delivery: "skip",
    });
    expect(skippedDeltas).toEqual([{ delta: "Commentary.", phase: "commentary" }]);
    expect(skippedResets).toEqual([""]);

    await skippedOutputSubscription.stop();
    await skippedLifecycle.stop();
    await outputSubscription.stop();
    await lifecycle.stop();
    await runner.stop();
    await pluginManager.destroy();
    await bus.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("silences an intermediate NO_REPLY turn while preserving its tool exchange", async () => {
    const config = parseCoreConfigV1ToUniversal({});
    config.models.main = { model: "openai/silent-turn" };
    config.agent.retry = { enabled: false, maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 };
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-silent-turn-"));
    const store = new SqliteTranscriptStore(path.join(dataDir, "transcripts.db"));
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    const modelPrompts: ModelMessage[][] = [];
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "production-silent-turn",
      config,
      pluginManager,
      transcriptStore: store,
      issueControlCapability: () => ({ capability: "test-capability", principal: null }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "silent-turn",
            doStream: async (call) => {
              modelPrompts.push([...call.prompt]);
              modelCalls += 1;
              return modelCalls === 1
                ? level1TextAndToolCallStep("NO_REPLY", {
                    toolCallId: "call-silent",
                    toolName: "builtin",
                  })
                : level1TextStep("final answer");
            },
          }),
        }),
    });
    const requestId = "github:silent-turn-session:request";
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    const responsePublished = deferred<void>();
    const outputEvents: Array<Message<unknown>> = [];
    const outputSubscription = await bus.subscribeTopic(
      outReqTopic(requestId),
      { mode: "tail", offset: { type: "now" } },
      async (message, context) => {
        outputEvents.push(message);
        if (message.type === lilacEventTypes.EvtAgentOutputResponseText) {
          responsePublished.resolve(undefined);
        }
        await context.commit();
      },
    );

    await publishRunnerRequest({
      bus,
      requestId,
      sessionId: "silent-turn-session",
      text: "wait for the work",
    });

    await expect(lifecycle.terminal).resolves.toBe("resolved");
    await responsePublished.promise;
    expect(modelCalls).toBe(2);
    expect(JSON.stringify(outputEvents)).not.toContain("NO_REPLY");
    expect(
      outputEvents.find((message) => message.type === lilacEventTypes.EvtAgentOutputResponseText)
        ?.data,
    ).toMatchObject({ finalText: "final answer", delivery: "reply" });
    const secondTurnAssistantMessages = modelPrompts[1]?.filter(
      (message) => message.role === "assistant",
    );
    expect(JSON.stringify(secondTurnAssistantMessages)).not.toContain("NO_REPLY");
    expect(JSON.stringify(secondTurnAssistantMessages)).toContain("call-silent");
    const transcript = store.getRequestTranscript({ requestId });
    expect(transcript?.finalText).toBe("final answer");
    expect(JSON.stringify(transcript?.messages)).not.toContain("NO_REPLY");
    expect(JSON.stringify(transcript?.messages)).toContain("call-silent");

    await outputSubscription.stop();
    await lifecycle.stop();
    await runner.stop();
    await pluginManager.destroy();
    store.close();
    await bus.close();
    await rm(dataDir, { recursive: true, force: true });
  });
});

function corePrimaryTestPluginManager(): CoreToolPluginManager {
  const toolset = level1TestToolset();
  return {
    init: async () => {},
    destroy: async () => {},
    reload: async () => {},
    ensureFresh: async () => {},
    getStatuses: () => [],
    getLevel2Tools: () => [],
    getLevel2ContributionInfo: () => new Map(),
    buildLevel1Toolset: async () => toolset,
  };
}

function admitPrimarySurface(
  store: SqliteTranscriptStore,
  sessionId: string,
  messageId: string,
  canonicalMessages: readonly ModelMessage[],
) {
  store.admitCoreSurfaceProjection({
    requestClient: "discord",
    surfaceId: `discord:${sessionId}`,
    sessionId,
    messageId,
    projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
    canonicalMessages,
    sourceFacts: {
      segmentMessageIds: [messageId],
      segmentDigest: hashCanonicalMessagesV1(canonicalMessages).hash,
    },
    ownedBlobs: [],
  });
  return {
    atoms: [
      {
        kind: "surface" as const,
        requestClient: "discord",
        surfaceId: `discord:${sessionId}`,
        sessionId,
        messageId,
      },
    ],
    canonicalMessages,
  };
}

function extendPrimaryManifest(input: {
  store: SqliteTranscriptStore;
  sessionId: string;
  previous: CoreLineageManifestV1;
  completedRequestId: string;
  outputMessageId: string;
  currentMessageId: string;
  currentMessages: readonly ModelMessage[];
}): CoreLineageManifestV1 {
  const transcript = input.store.getRequestTranscript({ requestId: input.completedRequestId });
  const metadata = input.store.getCoreRequestAtomMetadata({ requestId: input.completedRequestId });
  if (!transcript || !metadata) throw new Error("completed primary request metadata is missing");
  input.store.admitCoreSurfaceProjection({
    requestClient: "discord",
    surfaceId: `discord:${input.sessionId}`,
    sessionId: input.sessionId,
    messageId: input.outputMessageId,
    projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
    canonicalMessages: transcript.messages,
    sourceFacts: {},
    ownedBlobs: [],
  });
  input.store.linkSurfaceMessagesToRequest({
    requestId: input.completedRequestId,
    created: [
      { platform: "discord", channelId: input.sessionId, messageId: input.outputMessageId },
    ],
    last: { platform: "discord", channelId: input.sessionId, messageId: input.outputMessageId },
  });
  const currentSegment = admitPrimarySurface(
    input.store,
    input.sessionId,
    input.currentMessageId,
    input.currentMessages,
  );
  return buildCoreLineageManifestV1(
    [
      ...input.previous.segments.map((segment) => ({
        atoms: segment.atoms,
        canonicalMessages: segment.canonicalMessages,
        ...(segment.requestSource ? { requestSource: segment.requestSource } : {}),
      })),
      {
        atoms: [{ kind: "request" as const, ...metadata }],
        canonicalMessages: transcript.messages,
        requestSource: {
          aliases: [
            {
              requestClient: "discord",
              surfaceId: `discord:${input.sessionId}`,
              sessionId: input.sessionId,
              messageId: input.outputMessageId,
            },
          ],
        },
      },
      currentSegment,
    ],
    { currentSegmentIndex: input.previous.segments.length + 1 },
  );
}

describe("startBusAgentRunner Core-primary Claude production path", () => {
  it("promotes an auto-injected first turn and forks the exact linked reply with suffix-only input", async () => {
    const config = parseCoreConfigV1ToUniversal({});
    config.models.main = { model: "claude-code/sonnet" };
    config.agent.retry = { enabled: false, maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 };
    config.conversation.thread.autoInject = {
      ...config.conversation.thread.autoInject,
      enabled: true,
      minTextUnits: 20,
      followUpMinTextUnits: 20,
      limit: 1,
      minScore: 0.1,
      mode: "hybrid",
      filterCurrentParticipants: false,
    };
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-primary-auto-inject-"));
    const store = new SqliteTranscriptStore(path.join(dataDir, "transcripts.db"));
    const bus = createLilacBus(createInMemoryRawBus());
    const adapter = new ProductionPathDiscordAdapter();
    const sessionId = "primary-auto-inject-session";
    const starts: ClaudeNativeSessionStart[] = [];
    const modelPrompts: ModelMessage[][] = [];
    let plannedSearches = 0;
    const routedRequests: Array<{
      readonly headers?: Readonly<Record<string, string>>;
      readonly data: CmdRequestMessageData;
    }> = [];
    const routedSub = await bus.subscribeTopic(
      "cmd.request",
      { mode: "tail", offset: { type: "now" } },
      async (message, context) => {
        if (message.type === lilacEventTypes.CmdRequestMessage) {
          routedRequests.push(message);
        }
        await context.commit();
      },
    );
    const outputCreated = deferred<MsgRef>();
    const outputCreatedSub = await bus.subscribeTopic(
      "evt.surface",
      { mode: "tail", offset: { type: "now" } },
      async (message, context) => {
        if (
          message.type === lilacEventTypes.EvtSurfaceOutputMessageCreated &&
          message.headers?.request_id === `discord:${sessionId}:input-1`
        ) {
          const msgRef = message.data.msgRef;
          if (msgRef.platform === "discord") {
            outputCreated.resolve({
              platform: "discord",
              channelId: msgRef.channelId,
              messageId: msgRef.messageId,
            });
          }
        }
        await context.commit();
      },
    );
    const routedOutputUpdates: string[] = [];
    const outputUpdatedSub = await bus.subscribeTopic(
      "evt.adapter",
      { mode: "tail", offset: { type: "now" } },
      async (message, context) => {
        if (
          message.type === lilacEventTypes.EvtAdapterMessageUpdated &&
          message.data.platform === "discord"
        ) {
          routedOutputUpdates.push(message.data.messageId);
        }
        await context.commit();
      },
    );
    const adapterIngress = await bridgeAdapterToBus({
      adapter,
      bus,
      subscriptionId: "production-primary-auto-inject-ingress",
      transcriptStore: store,
    });
    const router = await startBusRequestRouter({
      adapter,
      bus,
      subscriptionId: "production-primary-auto-inject-router",
      config,
      transcriptStore: store,
      routerGate: async () => ({ forward: true, reason: "deterministic integration route" }),
    });
    const outputRelay = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "discord",
      subscriptionId: "production-primary-auto-inject-relay",
      transcriptStore: store,
    });
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "production-primary-auto-inject",
      config,
      pluginManager: corePrimaryTestPluginManager(),
      cwd: dataDir,
      transcriptStore: store,
      issueControlCapability: () => ({ capability: "test-capability", principal: null }),
      conversationThreads: {
        planAutoInjectSearch: async () => {
          plannedSearches += 1;
          return autoInjectPlanForQuery("native continuation", "Find continuation context.");
        },
        search: async () => ({
          meta: {
            query: "native continuation",
            limit: 1,
            mode: "hybrid",
            minScore: 0.1,
            count: 1,
            vectorAvailable: false,
          },
          results: [
            {
              threadId: "related-thread",
              title: "Relevant native continuation context",
              brief: "A deterministic auto-injected result.",
              score: 0.9,
            },
          ],
        }),
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      materializeClaudeCodeRun: async (options) => {
        const start = options.nativeSession;
        if (!start || start.mode === "ephemeral")
          throw new Error("expected persistent Claude start");
        const runIndex = starts.length;
        starts.push(start);
        const observation = (): ClaudeNativeAttemptObservation => ({
          requestedSessionId: start.sessionId,
          sourceSessionId: start.mode === "fork" ? start.baseSessionId : null,
          initSessionId: start.sessionId,
          resultSessionId: start.sessionId,
          contextTokens: 100 + runIndex,
          contextMaxTokens: 4_000,
          requestedModel: options.modelId,
          initializedModel: options.modelId,
          requestedReasoning: options.reasoning ?? null,
          providerWarnings: [],
          invoked: true,
          requiredObservabilityError: null,
          callbackError: null,
        });
        const model = new MockLanguageModelV4({
          modelId: options.modelId,
          doStream: async (call) => {
            modelPrompts.push([...call.prompt]);
            return level1TextStep(`auto-inject response ${runIndex + 1}`);
          },
        });
        return {
          agentModel: model,
          continuationModel: model,
          createUtilityModel: () => model,
          control: { inject: () => false, interrupt: async () => false, clear: () => {} },
          nativeSession: {
            getObservation: observation,
            waitForObservation: async () => observation(),
            recordWarning: () => {},
            finalize: async () => ({
              status: "promotable" as const,
              issues: [] as const,
              observations: observation(),
              candidate: {
                sessionId: start.sessionId,
                cwd: options.cwd,
                lastModified: 1_000 + runIndex,
              },
              sourcePreflight:
                start.mode === "fork"
                  ? {
                      sessionId: start.baseSessionId,
                      cwd: options.cwd,
                      lastModified: start.expectedSourceLastModified,
                    }
                  : null,
              sourceFinal:
                start.mode === "fork"
                  ? {
                      sessionId: start.baseSessionId,
                      cwd: options.cwd,
                      lastModified: start.expectedSourceLastModified,
                    }
                  : null,
            }),
          },
          dispose: async () => {},
        };
      },
    });

    const firstRequestId = `discord:${sessionId}:input-1`;
    const firstText = Array.from({ length: 40 }, (_, index) => `detail-${index}`).join(" ");
    const firstLifecycle = await observeRequestLifecycle(bus, firstRequestId);
    const firstRelayedResponse = await observeResponseAfterOutputRelay(bus, firstRequestId);
    await adapter.emitCreated({
      ref: { platform: "discord", channelId: sessionId, messageId: "input-1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "user-1",
      userName: "User One",
      text: `<@bot> ${firstText}`,
      ts: 1_000,
      raw: {
        reference: {},
        discord: {
          isChat: true,
          isDMBased: false,
          mentionsBot: true,
          replyToBot: false,
          botUserId: "bot",
        },
      },
    });
    await expect(firstLifecycle.terminal).resolves.toBe("resolved");
    await firstRelayedResponse.relayed;
    expect(await outputCreated.promise).toEqual({
      platform: "discord",
      channelId: sessionId,
      messageId: "output-1",
    });

    const firstRouted = routedRequests.find(
      (request) => request.headers?.request_id === firstRequestId,
    );
    if (!firstRouted || firstRouted.data.corePrimaryLineage?.state !== "complete") {
      throw new Error("first request did not route with complete Stage 6 lineage");
    }
    const firstInputManifest = firstRouted.data.corePrimaryLineage;
    const persistedFirstManifest = store.getCorePrimaryLineageManifest({
      requestId: firstRequestId,
    });
    if (!persistedFirstManifest) throw new Error("auto-injected manifest was not persisted");
    expect(persistedFirstManifest.currentCanonicalStart).toBe(
      firstInputManifest.currentCanonicalStart,
    );
    expect(persistedFirstManifest.segments.slice(0, -1)).toEqual(firstInputManifest.segments);
    expect(persistedFirstManifest.segments.at(-1)?.atoms).toEqual([
      expect.objectContaining({ kind: "synthetic", source: "conversation-thread-auto-inject" }),
    ]);
    expect(
      persistedFirstManifest.segments.at(-1)?.canonicalMessages.map((message) => message.role),
    ).toEqual(["assistant", "tool"]);
    const firstOutput = adapter.outputs[0];
    if (!firstOutput) throw new Error("first output stream was not created");
    expect(
      firstOutput.parts
        .filter((part) => part.type === "tool.status")
        .map((part) => part.update.status),
    ).toEqual(["start", "end"]);
    expect(firstOutput.parts[0]).toMatchObject({
      type: "tool.status",
      update: { status: "start", display: "conversation_thread_search auto-injected metadata" },
    });
    expect(
      adapter.updatedOutputMessageIds.filter((id) => id === firstOutput.messageId).length,
    ).toBe(firstOutput.parts.length);
    expect(routedOutputUpdates.filter((id) => id === firstOutput.messageId).length).toBe(
      firstOutput.parts.length,
    );
    expect(adapter.messages.get(firstOutput.messageId)?.text).toBe("auto-inject response 1");
    expect(
      store.getTranscriptBySurfaceMessage({
        platform: "discord",
        channelId: sessionId,
        messageId: firstOutput.messageId,
      })?.requestId,
    ).toBe(firstRequestId);
    const firstBinding = store.getCorePrimaryClaudeSessionBinding({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
    });
    const firstTranscript = store.getRequestTranscript({ requestId: firstRequestId });
    if (!firstBinding || !firstTranscript?.transcriptDigest || !firstTranscript.providerState) {
      throw new Error("auto-injected first turn did not promote");
    }
    expect(firstBinding).toMatchObject(
      computeCorePrimaryClaudeTerminalHead({
        manifest: persistedFirstManifest,
        requestId: firstRequestId,
        transcriptDigest: firstTranscript.transcriptDigest,
        responseMessageCount: firstTranscript.messages.length,
        providerState: firstTranscript.providerState,
      }),
    );

    const secondRequestId = `discord:${sessionId}:input-2`;
    const secondLifecycle = await observeRequestLifecycle(bus, secondRequestId);
    const secondRelayedResponse = await observeResponseAfterOutputRelay(bus, secondRequestId);
    await adapter.emitCreated({
      ref: { platform: "discord", channelId: sessionId, messageId: "input-2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "user-1",
      userName: "User One",
      text: "next",
      ts: 20_000,
      raw: {
        reference: { messageId: firstOutput.messageId, channelId: sessionId },
        discord: {
          isChat: true,
          isDMBased: false,
          mentionsBot: false,
          replyToBot: true,
          botUserId: "bot",
        },
      },
    });
    await expect(secondLifecycle.terminal).resolves.toBe("resolved");
    await secondRelayedResponse.relayed;

    const secondRouted = routedRequests.find(
      (request) => request.headers?.request_id === secondRequestId,
    );
    if (!secondRouted || secondRouted.data.corePrimaryLineage?.state !== "complete") {
      throw new Error("second request did not route with complete Stage 6 lineage");
    }
    const secondManifest = secondRouted.data.corePrimaryLineage;
    expect(secondManifest.segments.map((segment) => segment.atoms[0]?.kind)).toEqual([
      "surface",
      "synthetic",
      "request",
      "surface",
    ]);
    expect(secondManifest.segments[2]?.requestSource?.aliases).toEqual([
      {
        requestClient: "discord",
        surfaceId: `discord:${sessionId}`,
        sessionId,
        messageId: firstOutput.messageId,
      },
    ]);
    expect(secondManifest.segments[1]?.canonicalMessages).toEqual(
      persistedFirstManifest.segments.at(-1)?.canonicalMessages,
    );
    const secondCurrentSegment = secondManifest.segments.at(-1);
    if (!secondCurrentSegment) throw new Error("second current segment is missing");
    expect(secondManifest.currentCanonicalStart).toBe(secondCurrentSegment.canonicalStart);

    expect(plannedSearches).toBe(1);
    expect(starts[0]).toMatchObject({ mode: "fresh", sessionId: firstBinding.claudeSessionId });
    expect(starts[1]).toMatchObject({
      mode: "fork",
      baseSessionId: firstBinding.claudeSessionId,
    });
    expect(modelPrompts).toHaveLength(2);
    expect(JSON.stringify(modelPrompts[0])).toContain("related-thread");
    expect(JSON.stringify(modelPrompts[1])).toContain("next");
    expect(JSON.stringify(modelPrompts[1])).not.toContain("detail-0");
    expect(JSON.stringify(modelPrompts[1])).not.toContain("related-thread");
    expect(
      store.getCorePrimaryClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      })?.revision,
    ).toBe(2);

    await Promise.all([
      firstLifecycle.stop(),
      secondLifecycle.stop(),
      firstRelayedResponse.stop(),
      secondRelayedResponse.stop(),
    ]);
    await runner.stop();
    await outputRelay.stop();
    await router.stop();
    await adapterIngress.stop();
    await routedSub.stop();
    await outputCreatedSub.stop();
    await outputUpdatedSub.stop();
    store.close();
    await bus.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("promotes fresh and exact-fork tool-loop turns, then fences cancellation and CAS loss", async () => {
    const config = parseCoreConfigV1ToUniversal({});
    config.models.main = {
      model: "claude-code/sonnet",
      fallback: ["openai/must-not-run"],
    };
    config.agent.retry = { enabled: false, maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 };
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-primary-claude-"));
    const store = new SqliteTranscriptStore(path.join(dataDir, "transcripts.db"));
    const bus = createLilacBus(createInMemoryRawBus());
    const sessionId = "primary-claude-session";
    const starts: ClaudeNativeSessionStart[] = [];
    const modelPrompts: ModelMessage[][][] = [];
    const finalizationStarted = [deferred<void>(), deferred<void>()];
    const releaseFinalization = [deferred<void>(), deferred<void>()];
    const switchedModels: Array<string | undefined> = [];
    const materialize = async (
      options: Parameters<typeof materializeClaudeCodeRun>[0],
    ): Promise<MaterializedClaudeCodeRun> => {
      const start = options.nativeSession;
      if (!start || start.mode === "ephemeral") throw new Error("expected persistent Claude start");
      const runIndex = starts.length;
      starts.push(start);
      modelPrompts.push([]);
      let modelCalls = 0;
      let contextTokens = 100 + runIndex * 100;
      const observation = (): ClaudeNativeAttemptObservation => ({
        requestedSessionId: start.sessionId,
        sourceSessionId: start.mode === "fork" ? start.baseSessionId : null,
        initSessionId: start.sessionId,
        resultSessionId: start.sessionId,
        contextTokens,
        contextMaxTokens: 4_000,
        requestedModel: options.modelId,
        initializedModel: options.modelId,
        requestedReasoning: options.reasoning ?? null,
        providerWarnings: [],
        invoked: true,
        requiredObservabilityError: null,
        callbackError: null,
      });
      const model = new MockLanguageModelV4({
        modelId: options.modelId,
        doStream: async (call) => {
          modelPrompts[runIndex]!.push([...call.prompt]);
          modelCalls += 1;
          if (runIndex === 1 && modelCalls === 1) {
            return level1ToolCallStep([{ toolCallId: "native-tool", toolName: "builtin" }]);
          }
          return level1TextStep(`native response ${runIndex + 1}`);
        },
      });
      return {
        agentModel: model,
        continuationModel: model,
        createUtilityModel: () => model,
        control: { inject: () => false, interrupt: async () => false, clear: () => {} },
        nativeSession: {
          getObservation: observation,
          waitForObservation: async () => {
            contextTokens += 25;
            return observation();
          },
          recordWarning: () => {},
          finalize: async () => {
            if (runIndex === 2 || runIndex === 3) {
              const gateIndex = runIndex - 2;
              finalizationStarted[gateIndex]!.resolve(undefined);
              await releaseFinalization[gateIndex]!.promise;
            }
            return {
              status: "promotable" as const,
              issues: [] as const,
              observations: observation(),
              candidate: {
                sessionId: start.sessionId,
                cwd: options.cwd,
                lastModified: 1_000 + runIndex,
              },
              sourcePreflight:
                start.mode === "fork"
                  ? {
                      sessionId: start.baseSessionId,
                      cwd: options.cwd,
                      lastModified: start.expectedSourceLastModified,
                    }
                  : null,
              sourceFinal:
                start.mode === "fork"
                  ? {
                      sessionId: start.baseSessionId,
                      cwd: options.cwd,
                      lastModified: start.expectedSourceLastModified,
                    }
                  : null,
            };
          },
        },
        dispose: async () => {},
      };
    };
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "production-primary-claude",
      config,
      pluginManager: corePrimaryTestPluginManager(),
      cwd: dataDir,
      transcriptStore: store,
      issueControlCapability: () => ({ capability: "test-capability", principal: null }),
      materializeClaudeCodeRun: materialize,
      createAgent: (options) => {
        const agent = new AiSdkPiAgent(options);
        const setModel = agent.setModel.bind(agent);
        agent.setModel = (model, providerOptions, modelSpecifier, reasoning) => {
          switchedModels.push(modelSpecifier);
          setModel(model, providerOptions, modelSpecifier, reasoning);
        };
        return agent;
      },
    });

    const firstRequestId = "discord:primary-claude-session:input-1";
    const firstMessages = [{ role: "user", content: "first current" }] satisfies ModelMessage[];
    const firstManifest = buildCoreLineageManifestV1([
      admitPrimarySurface(store, sessionId, "input-1", firstMessages),
    ]);
    const firstLifecycle = await observeRequestLifecycle(bus, firstRequestId);
    await publishRunnerRequest({
      bus,
      requestId: firstRequestId,
      sessionId,
      requestClient: "discord",
      text: "first current",
      corePrimaryLineage: firstManifest,
    });
    await expect(firstLifecycle.terminal).resolves.toBe("resolved");
    const firstBinding = store.getCorePrimaryClaudeSessionBinding({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
    });
    if (!firstBinding) throw new Error("first binding was not promoted");
    const firstTranscript = store.getRequestTranscript({ requestId: firstRequestId });
    if (!firstTranscript?.transcriptDigest) throw new Error("first transcript digest is missing");
    const firstHead = computeCorePrimaryClaudeTerminalHead({
      manifest: firstManifest,
      requestId: firstRequestId,
      transcriptDigest: firstTranscript.transcriptDigest,
      responseMessageCount: firstTranscript.messages.length,
      providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
    });
    expect(starts[0]).toMatchObject({ mode: "fresh", sessionId: firstBinding.claudeSessionId });
    expect(firstBinding).toMatchObject(firstHead);

    const secondRequestId = "discord:primary-claude-session:input-2";
    const secondMessages = [{ role: "user", content: "second current" }] satisfies ModelMessage[];
    const secondManifest = extendPrimaryManifest({
      store,
      sessionId,
      previous: firstManifest,
      completedRequestId: firstRequestId,
      outputMessageId: "output-1",
      currentMessageId: "input-2",
      currentMessages: secondMessages,
    });
    const secondLifecycle = await observeRequestLifecycle(bus, secondRequestId);
    await publishRunnerRequest({
      bus,
      requestId: secondRequestId,
      sessionId,
      requestClient: "discord",
      text: "second current",
      messages: secondManifest.segments.flatMap((segment) => segment.canonicalMessages),
      corePrimaryLineage: secondManifest,
    });
    expect({ terminal: await secondLifecycle.terminal, details: secondLifecycle.details }).toEqual({
      terminal: "resolved",
      details: [undefined, undefined],
    });
    const secondBinding = store.getCorePrimaryClaudeSessionBinding({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
    });
    if (!secondBinding) throw new Error("second binding was not promoted");
    const secondTranscript = store.getRequestTranscript({ requestId: secondRequestId });
    if (!secondTranscript?.transcriptDigest) throw new Error("second transcript digest is missing");
    const secondHead = computeCorePrimaryClaudeTerminalHead({
      manifest: secondManifest,
      requestId: secondRequestId,
      transcriptDigest: secondTranscript.transcriptDigest,
      responseMessageCount: secondTranscript.messages.length,
      providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
    });
    expect(starts[1]).toMatchObject({
      mode: "fork",
      baseSessionId: firstBinding.claudeSessionId,
      sessionId: secondBinding.claudeSessionId,
    });
    expect(modelPrompts[1]).toHaveLength(2);
    expect(JSON.stringify(modelPrompts[1]?.[0])).not.toContain("first current");
    expect(JSON.stringify(modelPrompts[1]?.[0])).toContain("second current");
    expect(JSON.stringify(modelPrompts[1]?.[1])).toContain(
      "Continue after the completed tool call.",
    );
    expect(
      JSON.stringify(store.getRequestTranscript({ requestId: secondRequestId })?.messages),
    ).toContain("native-tool");
    expect(secondBinding.canonicalMessageCount).toBe(
      secondManifest.segments.at(-1)!.canonicalEnd +
        store.getRequestTranscript({ requestId: secondRequestId })!.messages.length,
    );
    expect(secondBinding).toMatchObject(secondHead);
    expect(secondBinding.nativeContextTokens).toBeGreaterThan(firstBinding.nativeContextTokens);

    const cancellationRequestId = "discord:primary-claude-session:input-cancel";
    const cancellationMessages = [
      { role: "user", content: "cancel during finalize" },
    ] satisfies ModelMessage[];
    const cancellationManifest = extendPrimaryManifest({
      store,
      sessionId,
      previous: secondManifest,
      completedRequestId: secondRequestId,
      outputMessageId: "output-2",
      currentMessageId: "input-cancel",
      currentMessages: cancellationMessages,
    });
    const cancellationLifecycle = await observeRequestLifecycle(bus, cancellationRequestId);
    await publishRunnerRequest({
      bus,
      requestId: cancellationRequestId,
      sessionId,
      requestClient: "discord",
      text: "cancel during finalize",
      messages: cancellationManifest.segments.flatMap((segment) => segment.canonicalMessages),
      corePrimaryLineage: cancellationManifest,
    });
    await finalizationStarted[0]!.promise;
    await publishRunnerRequest({
      bus,
      requestId: cancellationRequestId,
      sessionId,
      requestClient: "discord",
      queue: "interrupt",
      text: "cancel",
      raw: { cancel: true },
    });
    releaseFinalization[0]!.resolve(undefined);
    await expect(cancellationLifecycle.terminal).resolves.toBe("cancelled");
    expect(starts[2]).toMatchObject({
      mode: "fork",
      baseSessionId: secondBinding.claudeSessionId,
    });
    expect(
      store.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: cancellationRequestId,
        attemptIndex: 0,
      }),
    ).toMatchObject({
      candidateSessionId:
        starts[2]?.mode === "fresh" || starts[2]?.mode === "fork" ? starts[2].sessionId : null,
      sourceSessionId: secondBinding.claudeSessionId,
      state: "cancelled",
    });
    expect(
      store.getCorePrimaryClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      }),
    ).toEqual(secondBinding);

    const raceRequestId = "discord:primary-claude-session:input-race";
    const raceMessages = [{ role: "user", content: "race finalize" }] satisfies ModelMessage[];
    const raceManifest = extendPrimaryManifest({
      store,
      sessionId,
      previous: secondManifest,
      completedRequestId: secondRequestId,
      outputMessageId: "output-2-race",
      currentMessageId: "input-race",
      currentMessages: raceMessages,
    });
    const raceLifecycle = await observeRequestLifecycle(bus, raceRequestId);
    await publishRunnerRequest({
      bus,
      requestId: raceRequestId,
      sessionId,
      requestClient: "discord",
      text: "race finalize",
      messages: raceManifest.segments.flatMap((segment) => segment.canonicalMessages),
      corePrimaryLineage: raceManifest,
    });
    await finalizationStarted[1]!.promise;
    expect(starts[3]).toMatchObject({
      mode: "fork",
      baseSessionId: secondBinding.claudeSessionId,
    });

    const competitorRequestId = "primary-competitor";
    const competitorSessionId = crypto.randomUUID();
    store.reserveCorePrimaryClaudeSessionAttempt({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      executionScopeHashVersion: 1,
      executionScopeHash: secondBinding.executionScopeHash,
      requestId: competitorRequestId,
      attemptIndex: 0,
      candidateSessionId: competitorSessionId,
      sourceSessionId: secondBinding.claudeSessionId,
      expectedBindingRevision: secondBinding.revision,
    });
    store.saveRequestTranscript({
      requestId: competitorRequestId,
      sessionId,
      requestClient: "discord",
      messages: [{ role: "assistant", content: "competitor response" }],
      corePrimaryLineage: raceManifest,
    });
    const competitorTranscript = store.getRequestTranscript({ requestId: competitorRequestId });
    if (!competitorTranscript?.transcriptDigest)
      throw new Error("competitor transcript is missing");
    const competitorHead = computeCorePrimaryClaudeTerminalHead({
      manifest: raceManifest,
      requestId: competitorRequestId,
      transcriptDigest: competitorTranscript.transcriptDigest,
      responseMessageCount: competitorTranscript.messages.length,
      providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
    });
    store.publishCorePrimaryClaudeSuccess({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      requestId: competitorRequestId,
      attemptIndex: 0,
      terminalRequestId: competitorRequestId,
      terminalLineageVersion: 1,
      terminalAtomCount: competitorHead.atomCount,
      terminalPrefixDigest: competitorHead.prefixDigest,
      terminalCanonicalMessageCount: competitorHead.canonicalMessageCount,
      providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
      nativeCwd: dataDir,
      nativeLastModified: 9_999,
      nativeContextTokens: 999,
      nativeContextMaxTokens: 4_000,
      lastModelSpecifier: "claude-code/sonnet",
      lastReasoning: "provider-default",
    });
    expect(
      store.promoteCorePrimaryClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: competitorRequestId,
        attemptIndex: 0,
      }),
    ).toBe(true);
    releaseFinalization[1]!.resolve(undefined);
    await expect(raceLifecycle.terminal).resolves.toBe("resolved");
    expect(
      store.getCorePrimaryClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      }),
    ).toMatchObject({
      claudeSessionId: competitorSessionId,
      atomCount: competitorHead.atomCount,
      prefixDigest: competitorHead.prefixDigest,
      canonicalMessageCount: competitorHead.canonicalMessageCount,
    });
    expect(
      store.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: raceRequestId,
        attemptIndex: 0,
      })?.state,
    ).toBe("failed");
    expect(
      store.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: raceRequestId,
        attemptIndex: 0,
      }),
    ).toMatchObject({
      candidateSessionId:
        starts[3]?.mode === "fresh" || starts[3]?.mode === "fork" ? starts[3].sessionId : null,
      sourceSessionId: secondBinding.claudeSessionId,
    });
    expect(switchedModels).toEqual([]);

    await Promise.all([
      firstLifecycle.stop(),
      secondLifecycle.stop(),
      cancellationLifecycle.stop(),
      raceLifecycle.stop(),
    ]);
    await runner.stop();
    store.close();
    await bus.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("does not invoke a configured cross-family fallback after a Claude failure", async () => {
    const config = parseCoreConfigV1ToUniversal({});
    config.models.main = {
      model: "claude-code/sonnet",
      fallback: ["openai/must-not-run"],
    };
    config.agent.retry = { enabled: false, maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 };
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-primary-fallback-"));
    const store = new SqliteTranscriptStore(path.join(dataDir, "transcripts.db"));
    const bus = createLilacBus(createInMemoryRawBus());
    const sessionId = "primary-no-fallback";
    let materializations = 0;
    const switchedModels: Array<string | undefined> = [];
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "production-primary-no-fallback",
      config,
      pluginManager: corePrimaryTestPluginManager(),
      cwd: dataDir,
      transcriptStore: store,
      issueControlCapability: () => ({ capability: "test-capability", principal: null }),
      materializeClaudeCodeRun: async (options) => {
        materializations += 1;
        const start = options.nativeSession;
        if (!start || start.mode === "ephemeral")
          throw new Error("expected persistent Claude start");
        const observation: ClaudeNativeAttemptObservation = {
          requestedSessionId: start.sessionId,
          sourceSessionId: null,
          initSessionId: start.sessionId,
          resultSessionId: start.sessionId,
          contextTokens: 100,
          contextMaxTokens: 4_000,
          requestedModel: options.modelId,
          initializedModel: options.modelId,
          requestedReasoning: options.reasoning ?? null,
          providerWarnings: [],
          invoked: true,
          requiredObservabilityError: null,
          callbackError: null,
        };
        const failingModel = new MockLanguageModelV4({
          modelId: options.modelId,
          doStream: async () => {
            throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
          },
        });
        return {
          agentModel: failingModel,
          continuationModel: failingModel,
          createUtilityModel: () => failingModel,
          control: { inject: () => false, interrupt: async () => false, clear: () => {} },
          nativeSession: {
            getObservation: () => observation,
            waitForObservation: async () => observation,
            recordWarning: () => {},
            finalize: async () => ({
              status: "promotable" as const,
              issues: [] as const,
              observations: observation,
              candidate: { sessionId: start.sessionId, cwd: options.cwd, lastModified: 1 },
              sourcePreflight: null,
              sourceFinal: null,
            }),
          },
          dispose: async () => {},
        };
      },
      createAgent: (options) => {
        const agent = new AiSdkPiAgent(options);
        const setModel = agent.setModel.bind(agent);
        agent.setModel = (model, providerOptions, modelSpecifier, reasoning) => {
          switchedModels.push(modelSpecifier);
          setModel(model, providerOptions, modelSpecifier, reasoning);
        };
        return agent;
      },
    });
    const requestId = "discord:primary-no-fallback:input";
    const messages = [{ role: "user", content: "fail without fallback" }] satisfies ModelMessage[];
    const manifest = buildCoreLineageManifestV1([
      admitPrimarySurface(store, sessionId, "input", messages),
    ]);
    const lifecycle = await observeRequestLifecycle(bus, requestId);

    await publishRunnerRequest({
      bus,
      requestId,
      sessionId,
      requestClient: "discord",
      text: "fail without fallback",
      corePrimaryLineage: manifest,
    });

    await expect(lifecycle.terminal).resolves.toBe("failed");
    expect(materializations).toBe(1);
    expect(switchedModels).toEqual([]);
    expect(
      store.getCorePrimaryClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      }),
    ).toBeNull();

    await lifecycle.stop();
    await runner.stop();
    store.close();
    await bus.close();
    await rm(dataDir, { recursive: true, force: true });
  });
});

describe("Core-primary local compaction replacement", () => {
  it("maps the current boundary and text-lowers retained mixed history in the fresh payload", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-primary-compaction-"));
    const store = new SqliteTranscriptStore(path.join(dataDir, "transcripts.db"));
    const oldPrefix = [
      { role: "user", content: `old question ${"x".repeat(20_000)}` },
      { role: "assistant", content: "old answer" },
    ] satisfies ModelMessage[];
    const retainedHistorical = [
      { role: "user", content: "retained historical question" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "old-tool", toolName: "builtin", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "old-tool",
            toolName: "builtin",
            output: { type: "text", value: "historical tool output" },
          },
        ],
      },
      { role: "assistant", content: "retained historical answer" },
    ] satisfies ModelMessage[];
    const current = [
      {
        role: "user",
        content: [
          { type: "text", text: "current question" },
          { type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
        ],
      },
    ] satisfies ModelMessage[];
    const originalMessages = [...oldPrefix, ...retainedHistorical, ...current];
    let lineage: CorePrimaryLineageV1 = buildCoreLineageManifestV1(
      [
        {
          atoms: [
            {
              kind: "synthetic",
              source: "old-prefix",
              messageDigest: hashCanonicalMessagesV1(oldPrefix).hash,
            },
          ],
          canonicalMessages: oldPrefix,
        },
        {
          atoms: [
            {
              kind: "synthetic",
              source: "retained-history",
              messageDigest: hashCanonicalMessagesV1(retainedHistorical).hash,
            },
          ],
          canonicalMessages: retainedHistorical,
        },
        {
          atoms: [
            {
              kind: "synthetic",
              source: "current-media",
              messageDigest: hashCanonicalMessagesV1(current).hash,
            },
          ],
          canonicalMessages: current,
        },
      ],
      { currentSegmentIndex: 2 },
    );
    const mainPayloads: ModelMessage[][] = [];
    const mainModel = new MockLanguageModelV4({
      modelId: "sonnet",
      doStream: async (call) => {
        mainPayloads.push([...call.prompt]);
        return level1TextStep("fresh response");
      },
    });
    const summaryModel = new MockLanguageModelV4({
      modelId: "summary",
      doStream: async () => level1TextStep("## Objective\n- Preserve current input."),
    });
    const materializedStarts: ClaudeNativeSessionStart[] = [];
    const disposedSessionIds: string[] = [];
    const observation: ClaudeNativeAttemptObservation = {
      requestedSessionId: null,
      sourceSessionId: null,
      initSessionId: null,
      resultSessionId: null,
      contextTokens: null,
      contextMaxTokens: null,
      requestedModel: "sonnet",
      initializedModel: null,
      requestedReasoning: null,
      providerWarnings: [],
      invoked: false,
      requiredObservabilityError: null,
      callbackError: null,
    };
    const runtime = createCorePrimaryClaudeRuntime({
      store,
      sessionId: "compaction-session",
      requestId: "compaction-request",
      providerId: "claude-code",
      modelSpecifier: "claude-code/sonnet",
      reasoning: "provider-default",
      executionScopeHash: "scope",
      executionCwd: dataDir,
      getLineage: () => lineage,
      materialize: async (start) => {
        materializedStarts.push(start);
        return {
          agentModel: mainModel,
          continuationModel: mainModel,
          createUtilityModel: () => summaryModel,
          control: { inject: () => false, interrupt: async () => false, clear: () => {} },
          nativeSession: {
            getObservation: () => ({
              ...observation,
              requestedSessionId: start.mode === "ephemeral" ? null : start.sessionId,
              initSessionId: start.mode === "ephemeral" ? null : start.sessionId,
              resultSessionId: start.mode === "ephemeral" ? null : start.sessionId,
              invoked: true,
            }),
            waitForObservation: async () => observation,
            recordWarning: () => {},
            finalize: async () => ({
              status: "unpromotable" as const,
              issues: [
                { code: "candidate-missing" as const, message: "not finalized in this test" },
              ],
              observations: observation,
              candidate: null,
              sourcePreflight: null,
              sourceFinal: null,
            }),
          },
          dispose: async () => {
            if (start.mode !== "ephemeral") disposedSessionIds.push(start.sessionId);
          },
        };
      },
    });
    await runtime.prepareModelCall({
      canonicalMessages: originalMessages,
      fullBudgetView: originalMessages,
      runtime: {
        model: mainModel,
        modelSpecifier: "claude-code/sonnet",
        executionMode: "provider-tools",
      },
      payload: { mode: "full" },
      transformContext: { system: "test", tools: level1TestToolset().tools },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model: mainModel,
      modelSpecifier: "claude-code/sonnet",
      messages: originalMessages,
      tools: level1TestToolset().tools,
      sendToolsToModel: false,
      prepareModelCall: runtime.prepareModelCall,
    });
    let replacement:
      | {
          originalSuffixStart: number;
          replacementSuffixStart: number;
          replacementMessageCount: number;
        }
      | undefined;
    const detach = await attachAutoCompaction(agent, {
      model: "claude-code/sonnet",
      modelCapability: new ModelCapability({ fetch: globalThis.fetch }),
      summaryModel,
      resolveContextLimit: async () => ({ context: 2_000, output: 200 }),
      resolveSummaryContextLimit: () => 2_000,
      thresholdInputSource: "transcript-estimate",
      keepRecentTurns: 2,
      keepRecentTokens: 1_000,
      prepareFullModelView: (messages) => runtime.prepareHistoryView(messages),
      prepareFullBudgetView: (messages, context) =>
        runtime.prepareFullBudgetView(messages, context.canonicalStartIndex),
      resolveCurrentInputCanonicalStart: () => lineage.currentCanonicalStart,
      onCompactionEnd: (event) => {
        if (event.status !== "completed" || !event.canonicalReplacement) return;
        replacement = event.canonicalReplacement;
        lineage = degradeCorePrimaryLineageForMutation(
          "compaction-checkpoint-transform",
          mapCorePrimaryCompactionCurrentCanonicalStart({
            previousCurrentCanonicalStart: lineage.currentCanonicalStart,
            replacement: event.canonicalReplacement,
          }),
        );
      },
    });

    try {
      await agent.continue();
    } finally {
      detach();
      await runtime.retireAtRunEnd();
    }

    expect(replacement).toMatchObject({
      originalSuffixStart: 3,
      replacementSuffixStart: 1,
      replacementMessageCount: 5,
    });
    expect(String(lineage.state)).toBe("fresh-only");
    expect(lineage.currentCanonicalStart).toBe(4);
    expect("reason" in lineage ? lineage.reason : null).toBe("compaction-checkpoint-transform");
    expect(materializedStarts).toHaveLength(2);
    expect(materializedStarts[0]).toMatchObject({ mode: "fresh" });
    expect(materializedStarts[1]).toMatchObject({ mode: "fresh" });
    const firstStart = materializedStarts[0];
    const replacementStart = materializedStarts[1];
    if (
      !firstStart ||
      !replacementStart ||
      firstStart.mode === "ephemeral" ||
      replacementStart.mode === "ephemeral"
    ) {
      throw new Error("expected persisted compaction candidates");
    }
    expect(replacementStart.sessionId).not.toBe(firstStart.sessionId);
    expect(disposedSessionIds).toContain(firstStart.sessionId);
    expect(agent.state.messages.slice(1, 5)).toEqual([...retainedHistorical.slice(1), ...current]);
    expect(mainPayloads).toHaveLength(1);
    const actualPayload = mainPayloads[0]!;
    const serializedPayload = JSON.stringify(actualPayload);
    expect(serializedPayload).not.toContain('"type":"tool-call"');
    expect(serializedPayload).not.toContain('"type":"tool-result"');
    expect(serializedPayload).toContain("historical tool output");
    const payloadCurrent = actualPayload.find(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "file"),
    );
    if (!payloadCurrent || !Array.isArray(payloadCurrent.content)) {
      throw new Error("current media payload is missing");
    }
    expect(
      payloadCurrent.content.some(
        (part) => part.type === "text" && part.text === "current question",
      ),
    ).toBe(true);
    expect(
      payloadCurrent.content.some((part) => part.type === "file" && part.mediaType === "image/png"),
    ).toBe(true);

    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
});

describe("formatAutoCompactionToolDisplay", () => {
  it("keeps start and successful end displays compact", () => {
    expect(
      formatAutoCompactionToolDisplay({
        phase: "start",
        messageCountBefore: 42,
      }),
    ).toBe("compact context (42 msgs)");

    expect(
      formatAutoCompactionToolDisplay({
        phase: "end",
        ok: true,
        messageCountBefore: 42,
        messageCountAfter: 9,
      }),
    ).toBe("compact context (42->9 msgs)");
  });

  it("keeps failed end display compact", () => {
    expect(
      formatAutoCompactionToolDisplay({
        phase: "end",
        ok: false,
        messageCountBefore: 42,
      }),
    ).toBe("compact context failed");
  });
});

describe("buildAutoInjectedThreadSearchMessages", () => {
  it("builds slim auto-injected thread search metadata messages", () => {
    const messages = buildAutoInjectedThreadSearchMessages({
      toolCallId: "auto-thread-1",
      entries: [
        {
          threadId: "thread-1",
          title: "Short thread title",
          brief: "Short thread brief",
          timeRange: "2026/06/28 12:01 - 2026/06/28 13:23",
        },
      ],
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("assistant");
    expect(messages[1]?.role).toBe("tool");
    const assistantMessage = messages[0];
    if (assistantMessage?.role !== "assistant" || typeof assistantMessage.content === "string") {
      throw new Error("expected assistant tool-call message");
    }
    const toolCall = assistantMessage.content[0];
    expect(toolCall?.type).toBe("tool-call");
    if (toolCall?.type !== "tool-call") throw new Error("expected tool call");
    expect(toolCall.toolName).toBe("conversation_thread_search");
    const toolMessage = messages[1];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("expected tool message");
    }
    const result = toolMessage.content[0];
    expect(result?.type).toBe("tool-result");
    if (result?.type !== "tool-result") throw new Error("expected tool result");
    expect(result.toolName).toBe("conversation_thread_search");
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          {
            threadId: "thread-1",
            title: "Short thread title",
            brief: "Short thread brief",
            timeRange: "2026/06/28 12:01 - 2026/06/28 13:23",
          },
        ],
      },
    });
  });

  it("appends one deterministic unsliceable synthetic segment after the current boundary", () => {
    const sourceMessages = [
      { role: "user", content: "historical" },
      { role: "user", content: "current" },
    ] satisfies ModelMessage[];
    const source = buildCoreLineageManifestV1(
      [
        {
          atoms: [
            {
              kind: "surface",
              requestClient: "discord",
              surfaceId: "discord:channel",
              sessionId: "channel",
              messageId: "historical",
            },
          ],
          canonicalMessages: sourceMessages.slice(0, 1),
        },
        {
          atoms: [
            {
              kind: "surface",
              requestClient: "discord",
              surfaceId: "discord:channel",
              sessionId: "channel",
              messageId: "current",
            },
          ],
          canonicalMessages: sourceMessages.slice(1),
        },
      ],
      { currentSegmentIndex: 1 },
    );
    const injected = buildAutoInjectedThreadSearchMessages({
      toolCallId: "auto-thread-deterministic",
      entries: [{ threadId: "thread-1", title: "Relevant thread" }],
    });

    const first = appendAutoInjectedThreadSearchLineage({
      lineage: source,
      canonicalMessages: sourceMessages,
      injectedMessages: injected,
    });
    const second = appendAutoInjectedThreadSearchLineage({
      lineage: source,
      canonicalMessages: sourceMessages,
      injectedMessages: injected,
    });

    expect(first).toEqual(second);
    if (first.state !== "complete") throw new Error("expected complete appended lineage");
    expect(first.currentCanonicalStart).toBe(source.currentCanonicalStart);
    expect(first.segments.slice(0, -1)).toEqual(source.segments);
    const synthetic = first.segments.at(-1)!;
    expect(synthetic).toMatchObject({
      atoms: [
        {
          kind: "synthetic",
          source: "conversation-thread-auto-inject",
          messageDigest: hashCanonicalMessagesV1(injected).hash,
        },
      ],
      canonicalMessages: injected,
      canonicalStart: sourceMessages.length,
      canonicalEnd: sourceMessages.length + injected.length,
      cumulativeAtomCount: source.segments.at(-1)!.cumulativeAtomCount + 1,
    });
    expect(synthetic.canonicalMessages).toHaveLength(2);
    expect(synthetic.atoms).toHaveLength(1);
    expect(synthetic.atoms[0]?.kind).toBe("synthetic");
    expect(() => parseCorePrimaryLineageV1(first, [...sourceMessages, ...injected])).not.toThrow();
  });

  it("fails closed for missing, fresh-only, malformed, or unaligned source lineage", () => {
    const canonicalMessages = [{ role: "user", content: "current" }] satisfies ModelMessage[];
    const injectedMessages = buildAutoInjectedThreadSearchMessages({
      toolCallId: "auto-thread-invalid",
      entries: [{ threadId: "thread-1", title: "Relevant thread" }],
    });
    const complete = buildCoreLineageManifestV1([
      {
        atoms: [
          {
            kind: "surface",
            requestClient: "discord",
            surfaceId: "discord:channel",
            sessionId: "channel",
            messageId: "current",
          },
        ],
        canonicalMessages,
      },
    ]);
    const cases: unknown[] = [
      undefined,
      degradeCorePrimaryLineageForMutation("already-fresh", 0),
      { ...complete, segments: [] },
      complete,
    ];

    expect(
      cases.map((lineage, index) =>
        appendAutoInjectedThreadSearchLineage({
          lineage,
          canonicalMessages:
            index === cases.length - 1
              ? [{ role: "user", content: "transformed" }]
              : canonicalMessages,
          injectedMessages,
        }),
      ),
    ).toEqual(
      cases.map(() => ({
        state: "fresh-only",
        lineageVersion: 1,
        currentCanonicalStart: 0,
        reason: "synthetic-thread-search-insertion",
      })),
    );
  });
});

describe("maybeBuildAutoInjectedThreadSearchMessages", () => {
  it("includes dynamically capped brief metadata", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 1,
            limit: 3,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const fullThreshold = Math.floor(AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH * 1.1);
    const belowDisplayBrief = "a".repeat(AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH - 1);
    const nearThresholdBrief = "b".repeat(fullThreshold);
    const overThresholdBrief = "c".repeat(fullThreshold + 1);

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-briefs",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful message" }],
      conversationThreads: {
        planAutoInjectSearch: async () =>
          autoInjectPlanForQuery("meaningful message", "Find meaningful message threads."),
        search: async () => ({
          meta: {
            query: "meaningful message",
            limit: 3,
            mode: "hybrid",
            minScore: 0.1,
            count: 3,
            vectorAvailable: false,
          },
          results: [
            { threadId: "thread-1", title: "Below display", brief: belowDisplayBrief },
            { threadId: "thread-2", title: "Near threshold", brief: nearThresholdBrief },
            { threadId: "thread-3", title: "Over threshold", brief: overThresholdBrief },
          ],
        }),
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    const toolMessage = messages[1];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("expected tool message");
    }
    const result = toolMessage.content[0];
    if (result?.type !== "tool-result") throw new Error("expected tool result");
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          { threadId: "thread-1", title: "Below display", brief: belowDisplayBrief },
          { threadId: "thread-2", title: "Near threshold", brief: nearThresholdBrief },
          {
            threadId: "thread-3",
            title: "Over threshold",
            brief: `${overThresholdBrief.slice(0, AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH)} ...(${overThresholdBrief.length - AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH} remaining)`,
          },
        ],
      },
    });
  });

  it("ignores surface metadata when deciding whether to auto-inject", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 80,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    let plannerCalls = 0;
    let searchCalls = 0;

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-1",
      raw: {},
      userMessages: [
        {
          role: "user",
          content: `${formatSurfaceMetadataLine({
            platform: "discord",
            user_id: "u1",
            user_name: "Alice",
            message_id: "m1",
            message_time: new Date(1_234).toISOString(),
          })}\nlol`,
        },
      ],
      conversationThreads: {
        planAutoInjectSearch: async () => {
          plannerCalls += 1;
          return autoInjectPlanForQuery("lol", "Short message.");
        },
        search: async () => {
          searchCalls += 1;
          return {
            meta: {
              query: "lol",
              limit: 3,
              mode: "hybrid",
              minScore: 0.1,
              count: 1,
              vectorAvailable: false,
            },
            results: [{ threadId: "thread-1", title: "Should not appear", brief: "" }],
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(messages).toEqual([]);
    expect(plannerCalls).toBe(0);
    expect(searchCalls).toBe(0);
  });

  it("passes stripped user text to auto-inject query planning", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 80,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.42,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const body =
      "I keep getting logged out after the OAuth callback, but only on mobile. It started after I changed the cookie settings and now Safari loops back to the login page.";
    const startTime = "2026-06-28T12:01:00.000Z";
    const endTime = "2026-06-28T13:23:00.000Z";
    let plannedText = "";
    let searchVerbose: boolean | undefined;
    let searchMinScore: number | undefined;

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-1",
      raw: {},
      userMessages: [
        {
          role: "user",
          content: `${formatSurfaceMetadataLine({
            platform: "discord",
            user_id: "u1",
            user_name: "Alice",
            message_id: "m1",
            message_time: new Date(1_234).toISOString(),
          })}\n${body}`,
        },
      ],
      conversationThreads: {
        planAutoInjectSearch: async (input) => {
          plannedText = input.text;
          return {
            searches: [
              {
                queries: ["OAuth callback mobile login loop"],
                aboutness: {
                  domains: ["OAuth debugging"],
                  situations: ["mobile login loop after callback"],
                  targets: ["cookie settings"],
                  entities: ["Safari", "SameSite", "secure"],
                  userWouldAskForThisAs: ["OAuth callback mobile login loop"],
                  intentSummary: "Find prior threads about OAuth callback login loops on mobile.",
                },
              },
            ],
          };
        },
        search: async (input) => {
          searchVerbose = input.verbose;
          searchMinScore = input.minScore;
          return {
            meta: {
              query: "OAuth callback mobile login loop",
              limit: 3,
              mode: "hybrid",
              minScore: 0.42,
              count: 1,
              vectorAvailable: false,
            },
            results: [
              {
                threadId: "thread-1",
                title: "OAuth callback login loop",
                brief: "",
                timeRange: {
                  start: startTime,
                  end: endTime,
                },
              },
            ],
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(plannedText).toBe(body);
    expect(plannedText).not.toContain("LILAC_META");
    expect(searchVerbose).toBe(true);
    expect(searchMinScore).toBe(0.42);
    expect(messages).toHaveLength(2);
    const toolMessage = messages[1];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("expected tool message");
    }
    const result = toolMessage.content[0];
    if (result?.type !== "tool-result") throw new Error("expected tool result");
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          {
            threadId: "thread-1",
            title: "OAuth callback login loop",
            timeRange: formatExpectedLocalThreadTimeRange(startTime, endTime),
          },
        ],
      },
    });
  });

  it("selects one unique auto-injected result per planned search before score fill", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 1,
            limit: 3,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const searchQueries: string[] = [];

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-grouped",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful grouped message" }],
      conversationThreads: {
        planAutoInjectSearch: async () => ({
          searches: [
            autoInjectPlanForQuery("auth cookies", "Find auth cookie threads.").searches[0]!,
            autoInjectPlanForQuery("workplace context", "Find workplace context threads.")
              .searches[0]!,
            autoInjectPlanForQuery("project architecture", "Find project architecture threads.")
              .searches[0]!,
          ],
        }),
        search: async (input) => {
          const query = String(Array.isArray(input.query) ? (input.query[0] ?? "") : input.query);
          searchQueries.push(query);
          const resultsByQuery: Record<
            string,
            Array<{ threadId: string; title: string; brief: string; score: number }>
          > = {
            "auth cookies": [
              { threadId: "shared", title: "Shared top", brief: "", score: 0.99 },
              { threadId: "auth-second", title: "Auth second", brief: "", score: 0.4 },
            ],
            "workplace context": [
              { threadId: "shared", title: "Shared top", brief: "", score: 0.98 },
              { threadId: "work-second", title: "Work second", brief: "", score: 0.3 },
            ],
            "project architecture": [
              { threadId: "project-top", title: "Project top", brief: "", score: 0.2 },
            ],
          };
          return {
            meta: {
              query,
              limit: 3,
              mode: "hybrid",
              minScore: 0.1,
              count: resultsByQuery[query]?.length ?? 0,
              vectorAvailable: false,
            },
            results: resultsByQuery[query] ?? [],
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(searchQueries).toEqual(["auth cookies", "workplace context", "project architecture"]);
    const toolMessage = messages[1];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("expected tool message");
    }
    const result = toolMessage.content[0];
    if (result?.type !== "tool-result") throw new Error("expected tool result");
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          { threadId: "shared", title: "Shared top" },
          { threadId: "work-second", title: "Work second" },
          { threadId: "project-top", title: "Project top" },
        ],
      },
    });
  });

  it("caps auto-injected category coverage by global limit and planner order", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 1,
            limit: 2,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-limit-two",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful grouped message" }],
      conversationThreads: {
        planAutoInjectSearch: async () => ({
          searches: [
            autoInjectPlanForQuery("first category", "Find first category threads.").searches[0]!,
            autoInjectPlanForQuery("second category", "Find second category threads.").searches[0]!,
            autoInjectPlanForQuery("third category", "Find third category threads.").searches[0]!,
          ],
        }),
        search: async (input) => {
          const query = Array.isArray(input.query) ? input.query[0]! : input.query;
          const title = `${query} result`;
          return {
            meta: {
              query,
              limit: 2,
              mode: "hybrid",
              minScore: 0.1,
              count: 1,
              vectorAvailable: false,
            },
            results: [
              {
                threadId: query,
                title,
                brief: "",
                score: query === "third category" ? 1 : 0.1,
              },
            ],
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    const toolMessage = messages[1];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("expected tool message");
    }
    const result = toolMessage.content[0];
    if (result?.type !== "tool-result") throw new Error("expected tool result");
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          { threadId: "first category", title: "first category result" },
          { threadId: "second category", title: "second category result" },
        ],
      },
    });
  });

  it("fetches extra per-search recall before deduping grouped auto-inject results", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 1,
            limit: 2,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const requestedLimits: number[] = [];

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-dedupe-recall",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful grouped message" }],
      conversationThreads: {
        planAutoInjectSearch: async () => ({
          searches: [
            autoInjectPlanForQuery("first category", "Find first category threads.").searches[0]!,
            autoInjectPlanForQuery("second category", "Find second category threads.").searches[0]!,
          ],
        }),
        search: async (input) => {
          const query = String(Array.isArray(input.query) ? (input.query[0] ?? "") : input.query);
          const requestedLimit = input.limit ?? 5;
          requestedLimits.push(requestedLimit);
          const resultsByQuery: Record<
            string,
            Array<{ threadId: string; title: string; brief: string; score: number }>
          > = {
            "first category": [
              { threadId: "shared-1", title: "Shared 1", brief: "", score: 1 },
              { threadId: "shared-2", title: "Shared 2", brief: "", score: 0.9 },
            ],
            "second category": [
              { threadId: "shared-1", title: "Shared 1", brief: "", score: 1 },
              { threadId: "shared-2", title: "Shared 2", brief: "", score: 0.9 },
              { threadId: "second-unique", title: "Second unique", brief: "", score: 0.8 },
            ],
          };
          const results = resultsByQuery[query]?.slice(0, requestedLimit) ?? [];
          return {
            meta: {
              query,
              limit: requestedLimit,
              mode: "hybrid",
              minScore: 0.1,
              count: results.length,
              vectorAvailable: false,
            },
            results,
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(requestedLimits).toEqual([4, 4]);
    const toolMessage = messages[1];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("expected tool message");
    }
    const result = toolMessage.content[0];
    if (result?.type !== "tool-result") throw new Error("expected tool result");
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          { threadId: "shared-1", title: "Shared 1" },
          { threadId: "second-unique", title: "Second unique" },
        ],
      },
    });
  });

  it("keeps successful auto-inject search groups when another group fails", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 1,
            limit: 2,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const errors: string[] = [];

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-partial-search-failure",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful grouped message" }],
      conversationThreads: {
        planAutoInjectSearch: async () => ({
          searches: [
            autoInjectPlanForQuery("working category", "Find working category threads.")
              .searches[0]!,
            autoInjectPlanForQuery("failing category", "Find failing category threads.")
              .searches[0]!,
          ],
        }),
        search: async (input) => {
          const query = String(Array.isArray(input.query) ? (input.query[0] ?? "") : input.query);
          if (query === "failing category") throw new Error("vector search unavailable");
          return {
            meta: {
              query,
              limit: input.limit ?? 2,
              mode: "hybrid",
              minScore: 0.1,
              count: 1,
              vectorAvailable: false,
            },
            results: [{ threadId: "working-thread", title: "Working thread", brief: "" }],
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: (message) => {
        errors.push(message);
      },
    });

    expect(errors).toEqual([
      "auto-injected thread search failed; continuing with partial metadata",
    ]);
    const toolMessage = messages[1];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("expected tool message");
    }
    const result = toolMessage.content[0];
    if (result?.type !== "tool-result") throw new Error("expected tool result");
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [{ threadId: "working-thread", title: "Working thread" }],
      },
    });
  });

  it("skips injection when all search results were already auto-injected", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 1,
            limit: 3,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const statuses: Array<"start" | "end"> = [];
    let injectedCalls = 0;

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-2",
      raw: {},
      previousMessages: buildAutoInjectedThreadSearchMessages({
        toolCallId: "conversation_thread_previous",
        entries: [{ threadId: "thread-1", title: "Previously injected" }],
      }),
      userMessages: [{ role: "user", content: "A sufficiently meaningful message" }],
      conversationThreads: {
        planAutoInjectSearch: async () =>
          autoInjectPlanForQuery("meaningful message", "Find meaningful message threads."),
        search: async () => ({
          meta: {
            query: "meaningful message",
            limit: 3,
            mode: "hybrid",
            minScore: 0.1,
            count: 1,
            vectorAvailable: false,
          },
          results: [{ threadId: "thread-1", title: "Previously injected", brief: "" }],
        }),
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async (update) => {
        statuses.push(update.status);
      },
      onError: () => {},
      onInjected: () => {
        injectedCalls += 1;
      },
    });

    expect(messages).toEqual([]);
    expect(statuses).toEqual(["start", "end"]);
    expect(injectedCalls).toBe(0);
  });

  it("uses the initial threshold before any previous auto-injected metadata", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 80,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    let plannerCalls = 0;

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-1",
      raw: {},
      userMessages: [
        {
          role: "user",
          content:
            "please also verify whether our current cookie domain would cover the callback subdomain before changing code",
        },
      ],
      conversationThreads: {
        planAutoInjectSearch: async () => {
          plannerCalls += 1;
          return autoInjectPlanForQuery(
            "cookie callback subdomain",
            "Find cookie callback subdomain threads.",
          );
        },
        search: async () => ({
          meta: {
            query: "cookie callback subdomain",
            limit: 3,
            mode: "hybrid",
            minScore: 0.1,
            count: 1,
            vectorAvailable: false,
          },
          results: [{ threadId: "thread-1", title: "Cookie callback thread", brief: "" }],
        }),
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(plannerCalls).toBe(1);
    expect(messages).toHaveLength(2);
  });

  it("uses the follow-up threshold after previous auto-injected metadata", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 80,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    let plannerCalls = 0;
    let searchCalls = 0;

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-2",
      raw: {},
      previousMessages: buildAutoInjectedThreadSearchMessages({
        toolCallId: "conversation_thread_previous",
        entries: [{ threadId: "thread-1", title: "Previously injected" }],
      }),
      userMessages: [
        {
          role: "user",
          content:
            "please also verify whether our current cookie domain would cover the callback subdomain before changing code",
        },
      ],
      conversationThreads: {
        planAutoInjectSearch: async () => {
          plannerCalls += 1;
          return autoInjectPlanForQuery(
            "cookie callback subdomain",
            "Find cookie callback subdomain threads.",
          );
        },
        search: async () => {
          searchCalls += 1;
          return {
            meta: {
              query: "cookie callback subdomain",
              limit: 3,
              mode: "hybrid",
              minScore: 0.1,
              count: 1,
              vectorAvailable: false,
            },
            results: [{ threadId: "thread-2", title: "Cookie callback thread", brief: "" }],
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(messages).toEqual([]);
    expect(plannerCalls).toBe(0);
    expect(searchCalls).toBe(0);
  });

  it("still injects follow-up metadata when the follow-up threshold is met", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 80,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    let plannerCalls = 0;

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-3",
      raw: {},
      previousMessages: buildAutoInjectedThreadSearchMessages({
        toolCallId: "conversation_thread_previous",
        entries: [{ threadId: "thread-1", title: "Previously injected" }],
      }),
      userMessages: [
        {
          role: "user",
          content:
            "different angle: this started right after the edge middleware deploy, and the redirect host header differs between Vercel preview and production",
        },
      ],
      conversationThreads: {
        planAutoInjectSearch: async () => {
          plannerCalls += 1;
          return autoInjectPlanForQuery(
            "edge middleware redirect host header",
            "Find redirect host header threads.",
          );
        },
        search: async () => ({
          meta: {
            query: "edge middleware redirect host header",
            limit: 3,
            mode: "hybrid",
            minScore: 0.1,
            count: 1,
            vectorAvailable: false,
          },
          results: [{ threadId: "thread-2", title: "Edge middleware host header", brief: "" }],
        }),
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(plannerCalls).toBe(1);
    expect(messages).toHaveLength(2);
  });

  it("skips injection when participant filtering is enabled without visible participants", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: true,
          },
        },
      },
    };
    let plannerCalls = 0;
    let searchCalls = 0;

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-1",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful message" }],
      conversationThreads: {
        planAutoInjectSearch: async () => {
          plannerCalls += 1;
          return autoInjectPlanForQuery("meaningful message", "Find meaningful message threads.");
        },
        search: async () => {
          searchCalls += 1;
          return {
            meta: {
              query: "meaningful message",
              limit: 3,
              mode: "hybrid",
              minScore: 0.1,
              count: 1,
              vectorAvailable: false,
            },
            results: [{ threadId: "thread-1", title: "Should not appear", brief: "" }],
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(messages).toEqual([]);
    expect(plannerCalls).toBe(0);
    expect(searchCalls).toBe(0);
  });

  it("continues injecting metadata when optional status publishing fails", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const errors: string[] = [];
    const injectedEvents: Array<{
      toolCallId: string;
      mode: "hybrid" | "semantic" | "lexical";
      limit: number;
      searches: readonly (readonly string[])[];
      participantFilterUserCount: number;
      entries: readonly { threadId: string; title: string }[];
    }> = [];

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-1",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful message" }],
      conversationThreads: {
        planAutoInjectSearch: async () =>
          autoInjectPlanForQuery("meaningful message", "Find meaningful message threads."),
        search: async () => ({
          meta: {
            query: "meaningful message",
            limit: 3,
            mode: "hybrid",
            minScore: 0.1,
            count: 1,
            vectorAvailable: false,
          },
          results: [{ threadId: "thread-1", title: "Related title", brief: "" }],
        }),
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {
        throw new Error("status bus unavailable");
      },
      onError: (message) => {
        errors.push(message);
      },
      onInjected: (event) => {
        injectedEvents.push(event);
      },
    });

    expect(messages).toHaveLength(2);
    expect(injectedEvents).toHaveLength(1);
    const injectedEvent = injectedEvents[0];
    expect(injectedEvent?.toolCallId.startsWith("conversation_thread_")).toBe(true);
    expect(injectedEvent).toMatchObject({
      mode: "hybrid",
      limit: 3,
      searches: [["meaningful message"]],
      participantFilterUserCount: 0,
      entries: [{ threadId: "thread-1", title: "Related title" }],
    });
    expect(errors).toEqual([
      "auto-injected thread search status publish failed; continuing",
      "auto-injected thread search status publish failed; continuing",
    ]);
  });
});

describe("shouldRunAutoInjectedThreadSearch", () => {
  const shouldRun = (text: string) => shouldRunAutoInjectedThreadSearch({ text, minTextUnits: 80 });

  it("skips short and Discord-syntax-heavy messages", () => {
    expect(shouldRun("lol")).toBe(false);
    expect(shouldRun("wtf is this")).toBe(false);
    expect(shouldRun("https://x.com/foo lmao")).toBe(false);
    expect(shouldRun("<@123> thoughts? <#456> <:blob:789> <t:1710000000:R>")).toBe(false);
  });

  it("runs for enough authored Latin text", () => {
    expect(
      shouldRun(
        "I keep getting logged out after the OAuth callback, but only on mobile. It started after I changed the cookie settings and now Safari loops back to the login page.",
      ),
    ).toBe(true);
  });

  it("weights CJK text enough to trigger on shorter authored messages", () => {
    expect(
      shouldRun(
        "我登入後一直被踢回登入頁，只有手機版會發生，改 cookie 設定之後才開始，想知道是不是 SameSite 或 secure 設定造成的",
      ),
    ).toBe(true);
  });

  it("does not let giant code blocks dominate the gate", () => {
    const code =
      "```ts\n" + "const value = computeBrokenOAuthCookieState();\n".repeat(50) + "```\nwhy";
    expect(measureMeaningfulTextUnits(code)).toBeLessThan(80);
    expect(shouldRun(code)).toBe(false);
  });

  it("counts prose around inline code while discounting code syntax", () => {
    expect(
      shouldRun(
        "The OAuth callback works on desktop, but mobile Safari loses the session after `setCookie` runs. I changed `sameSite`, `secure`, and the callback domain yesterday.",
      ),
    ).toBe(true);
  });
});

describe("transient model retry", () => {
  const retry = {
    enabled: true,
    maxRetries: 2,
    baseDelayMs: 0,
    maxDelayMs: 0,
  } satisfies CoreConfig["agent"]["retry"];

  it("classifies Codex overload stream errors as retryable", () => {
    expect(
      isRetryableTransientModelError({
        type: "error",
        sequence_number: 2,
        error: {
          type: "service_unavailable_error",
          code: "server_is_overloaded",
          message: "Our servers are currently overloaded. Please try again later.",
          param: null,
        },
      }),
    ).toBe(true);
  });

  it("formats Codex overload stream errors for display", () => {
    expect(
      formatUnknownErrorForDisplay({
        type: "error",
        sequence_number: 2,
        error: {
          type: "service_unavailable_error",
          code: "server_is_overloaded",
          message: "Our servers are currently overloaded. Please try again later.",
          param: null,
        },
      }),
    ).toBe("server_is_overloaded: Our servers are currently overloaded. Please try again later.");
  });

  it("classifies transient errors inside arrays", () => {
    expect(
      isRetryableTransientModelError({
        errors: [{ code: "server_is_overloaded" }],
      }),
    ).toBe(true);
  });

  it("classifies SSE socket closures as retryable", () => {
    const message =
      "The socket connection was closed unexpectedly. For more information, pass verbose: true in the second argument to fetch()";

    expect(
      isRetryableTransientModelError(
        Object.assign(new Error(message), { code: "ConnectionClosed" }),
      ),
    ).toBe(true);
    expect(isRetryableTransientModelError(new Error(message))).toBe(true);
    expect(
      isRetryableTransientModelError({
        cause: Object.assign(new Error("connection reset"), { code: "ConnectionClosed" }),
      }),
    ).toBe(true);
    expect(isRetryableTransientModelError({ code: "ECONNRESET" })).toBe(true);
    expect(
      isRetryableTransientModelError(
        new Error("WebSocket closed before a terminal response event"),
      ),
    ).toBe(true);
  });

  it("does not classify context overflow or exhausted AI SDK retries", () => {
    expect(isRetryableTransientModelError("maximum context length is 128000 tokens")).toBe(false);
    expect(
      isRetryableTransientModelError({
        name: "AI_RetryError",
        reason: "maxRetriesExceeded",
        lastError: { statusCode: 503, message: "Service unavailable" },
      }),
    ).toBe(false);
  });

  it("computes capped exponential backoff", () => {
    expect(
      computeTransientRetryDelayMs({ attempt: 1, baseDelayMs: 2_000, maxDelayMs: 30_000 }),
    ).toBe(2_000);
    expect(
      computeTransientRetryDelayMs({ attempt: 5, baseDelayMs: 2_000, maxDelayMs: 30_000 }),
    ).toBe(30_000);
  });

  it("retries ConnectionClosed errors up to the configured max and resets after success", async () => {
    const logger = createLogger({ module: "bus-agent-runner-test" });
    const error = Object.assign(new Error("The socket connection was closed unexpectedly"), {
      code: "ConnectionClosed",
    });
    const controller = createTransientModelRetryController({
      retry,
      logger,
      requestId: "request-1",
      sessionId: "session-1",
      modelSpec: "codex/gpt-5.5",
    });
    const context = { retrySafety: { canRetry: true } as const };

    await expect(controller.handler(error, context)).resolves.toBe("retry");
    await expect(controller.handler(error, context)).resolves.toBe("retry");
    await expect(controller.handler(error, context)).resolves.toBe("fail");

    controller.reset();
    await expect(controller.handler(error, context)).resolves.toBe("retry");
  });

  it("does not retry when the transcript boundary is unsafe", async () => {
    const logger = createLogger({ module: "bus-agent-runner-test" });
    const controller = createTransientModelRetryController({
      retry,
      logger,
      requestId: "request-1",
      sessionId: "session-1",
      modelSpec: "codex/gpt-5.5",
    });

    await expect(
      controller.handler(
        { statusCode: 503, message: "Service unavailable" },
        { retrySafety: { canRetry: false, reason: "post-model-phase" } },
      ),
    ).resolves.toBe("fail");
  });
});

describe("toOpenAIPromptCacheKey", () => {
  it("returns the session id when it fits provider limits", () => {
    const sessionId = "sub:abc123";

    expect(toOpenAIPromptCacheKey(sessionId)).toBe(sessionId);
  });

  it("hashes long session ids down to 64 chars", () => {
    const sessionId =
      "sub:680343695673131032:sub:req:7984efa2-6f00-41c5-b1d0-bf77ada46e59:309873d2-712a-424e-9dd1-45273b4655d9";

    const key = toOpenAIPromptCacheKey(sessionId);
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(key).not.toBe(sessionId);
  });
});

describe("withReasoningSummaryDefaultForOpenAIModels", () => {
  it("does not inject reasoning summary when display is none", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "none",
      provider: "openai",
      modelId: "gpt-5",
      providerOptions: undefined,
    });

    expect(next).toBeUndefined();
  });

  it("injects detailed reasoning summary for openai provider", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "simple",
      provider: "openai",
      modelId: "gpt-5",
      providerOptions: undefined,
    });

    expect(next).toEqual({
      openai: {
        include: ["reasoning.encrypted_content"],
        reasoningSummary: "detailed",
      },
    });
  });

  it("injects for vercel/openai/* and openrouter/openai/* models", () => {
    const vercel = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "detailed",
      provider: "vercel",
      modelId: "openai/gpt-5",
      providerOptions: { gateway: { order: ["openai"] } },
    });

    const openrouter = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "detailed",
      provider: "openrouter",
      modelId: "openai/gpt-5-mini",
      providerOptions: { openrouter: { route: "fallback" } },
    });

    expect(vercel?.openai?.reasoningSummary).toBe("detailed");
    expect(vercel?.openai?.include).toEqual(["reasoning.encrypted_content"]);
    expect(openrouter?.openai?.reasoningSummary).toBe("detailed");
    expect(openrouter?.openai?.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("does not override explicit reasoningSummary and injects encrypted reasoning include", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "simple",
      provider: "openai",
      modelId: "gpt-5",
      providerOptions: {
        openai: {
          reasoningSummary: "auto",
          parallelToolCalls: true,
        },
      },
    });

    expect(next).toEqual({
      openai: {
        reasoningSummary: "auto",
        parallelToolCalls: true,
        include: ["reasoning.encrypted_content"],
      },
    });
  });

  it("preserves existing encrypted reasoning include", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "simple",
      provider: "codex",
      modelId: "gpt-5.5",
      providerOptions: {
        openai: {
          include: ["reasoning.encrypted_content"],
        },
      },
    });

    expect(next?.openai?.include).toEqual(["reasoning.encrypted_content"]);
  });
});

describe("withReasoningDisplayDefaultForAnthropicModels", () => {
  it("does not inject summarized thinking when display is none", () => {
    const next = withReasoningDisplayDefaultForAnthropicModels({
      reasoningDisplay: "none",
      provider: "anthropic",
      modelId: "claude-fable-5",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "enabled",
            budgetTokens: 12000,
          },
        },
      },
    });

    expect(next).toEqual({
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: 12000,
        },
      },
    });
  });

  it("injects summarized display without changing thinking type", () => {
    const next = withReasoningDisplayDefaultForAnthropicModels({
      reasoningDisplay: "simple",
      provider: "anthropic",
      modelId: "claude-fable-5",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "enabled",
            budgetTokens: 12000,
          },
        },
      },
    });

    expect(next).toEqual({
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: 12000,
          display: "summarized",
        },
      },
    });
  });

  it("injects summarized display for vercel/openrouter anthropic models", () => {
    const vercel = withReasoningDisplayDefaultForAnthropicModels({
      reasoningDisplay: "detailed",
      provider: "vercel",
      modelId: "anthropic/claude-fable-5",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "adaptive",
          },
        },
        gateway: {
          order: ["anthropic"],
        },
      },
    });

    const openrouter = withReasoningDisplayDefaultForAnthropicModels({
      reasoningDisplay: "detailed",
      provider: "openrouter",
      modelId: "anthropic/claude-future-6",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "adaptive",
          },
        },
        openrouter: {
          route: "fallback",
        },
      },
    });

    expect(vercel).toEqual({
      anthropic: {
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
      },
      gateway: {
        order: ["anthropic"],
      },
    });
    expect(openrouter).toEqual({
      anthropic: {
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
      },
      openrouter: {
        route: "fallback",
      },
    });
  });

  it("does not override explicit anthropic thinking display", () => {
    const next = withReasoningDisplayDefaultForAnthropicModels({
      reasoningDisplay: "simple",
      provider: "anthropic",
      modelId: "claude-future-6",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "adaptive",
            display: "omitted",
          },
        },
      },
    });

    expect(next).toEqual({
      anthropic: {
        thinking: {
          type: "adaptive",
          display: "omitted",
        },
      },
    });
  });
});

describe("shouldEnableAnthropicPromptCache", () => {
  it("keeps Anthropic prompt caching disabled by default", () => {
    expect(
      shouldEnableAnthropicPromptCache({
        spec: "openrouter/anthropic/claude-sonnet-4.5",
      }),
    ).toBe(false);
  });

  it("enables Anthropic prompt caching only when explicitly opted in", () => {
    expect(
      shouldEnableAnthropicPromptCache({
        spec: "openrouter/anthropic/claude-sonnet-4.5",
        anthropicPromptCache: true,
      }),
    ).toBe(true);

    expect(
      shouldEnableAnthropicPromptCache({
        spec: "openrouter/openai/gpt-4o",
        anthropicPromptCache: true,
      }),
    ).toBe(false);
  });
});

describe("withStableAnthropicUpstreamOrder", () => {
  it("injects the default order for vercel anthropic when none is configured", () => {
    const next = withStableAnthropicUpstreamOrder("vercel", {
      anthropic: {
        thinking: { type: "enabled" },
      },
    });

    expect(next).toEqual({
      anthropic: {
        thinking: { type: "enabled" },
      },
      gateway: {
        order: ["anthropic", "vertex", "bedrock"],
      },
    });
  });

  it("preserves an explicit vercel gateway order", () => {
    const next = withStableAnthropicUpstreamOrder("vercel", {
      gateway: {
        order: ["vertex", "anthropic", "bedrock"],
      },
    });

    expect(next).toEqual({
      gateway: {
        order: ["vertex", "anthropic", "bedrock"],
      },
    });
  });

  it("preserves an explicit openrouter provider order", () => {
    const next = withStableAnthropicUpstreamOrder("openrouter", {
      openrouter: {
        provider: {
          order: ["bedrock", "anthropic"],
        },
      },
    });

    expect(next).toEqual({
      openrouter: {
        provider: {
          order: ["bedrock", "anthropic"],
        },
      },
    });
  });
});

describe("anthropic fallback URL downloads", () => {
  it("detects fallback-capable anthropic gateway models", () => {
    expect(
      shouldForceUrlDownloadForAnthropicFallback({
        spec: "vercel/anthropic/claude-opus-4.6",
        provider: "vercel",
        providerOptions: {
          gateway: {
            order: ["vertex", "anthropic", "bedrock"],
          },
        },
      }),
    ).toBe(true);

    expect(
      shouldForceUrlDownloadForAnthropicFallback({
        spec: "openrouter/anthropic/claude-sonnet-4.5",
        provider: "openrouter",
        providerOptions: {
          openrouter: {
            provider: {
              order: ["anthropic"],
            },
          },
        },
      }),
    ).toBe(false);

    expect(
      shouldForceUrlDownloadForAnthropicFallback({
        spec: "vercel/anthropic/claude-opus-4.6",
        provider: "vercel",
        providerOptions: {
          gateway: {
            only: ["anthropic"],
            order: ["vertex", "anthropic", "bedrock"],
          },
        },
      }),
    ).toBe(false);
  });

  it("forces downloads for http urls when fallback order includes vertex or bedrock", async () => {
    const downloadCalls: string[] = [];
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    const download = buildExperimentalDownloadForAnthropicFallback({
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      downloadUrl: async (url) => {
        downloadCalls.push(url.toString());
        return {
          data: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
        };
      },
      cacheDir: dir,
    });

    try {
      expect(download).toBeDefined();

      const result = await download!([
        {
          url: new URL("https://example.com/image.png?test=force-download"),
          isUrlSupportedByModel: true,
        },
        {
          url: new URL("data:image/png;base64,AA=="),
          isUrlSupportedByModel: false,
        },
      ]);

      expect(downloadCalls.toSorted()).toEqual([
        "data:image/png;base64,AA==",
        "https://example.com/image.png?test=force-download",
      ]);
      expect(result).toEqual([
        {
          data: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
        },
        {
          data: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caches fallback downloads across repeated requests", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    let calls = 0;

    const download = buildExperimentalDownloadForAnthropicFallback({
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      cacheDir: dir,
      downloadUrl: async () => {
        calls += 1;
        return {
          data: new Uint8Array([9, 8, 7, 6]),
          mediaType: "application/pdf",
        };
      },
    });

    try {
      expect(download).toBeDefined();

      const request = [
        {
          url: new URL("https://example.com/report.pdf?test=cache"),
          isUrlSupportedByModel: true,
        },
      ];

      await download!(request);
      await download!(request);

      expect(calls).toBe(1);
      const files = await readdir(dir);
      expect(files.some((file) => file.endsWith(".bin"))).toBe(true);
      expect(files.some((file) => file.endsWith(".json"))).toBe(true);

      const dirStat = await stat(dir);
      expect(dirStat.mode & 0o077).toBe(0);

      for (const file of files) {
        const fileStat = await stat(path.join(dir, file));
        expect(fileStat.mode & 0o077).toBe(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads large cached attachments back from disk without re-downloading", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    let calls = 0;

    const download = buildExperimentalDownloadForAnthropicFallback({
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      cacheDir: dir,
      downloadUrl: async () => {
        calls += 1;
        return {
          data: new Uint8Array(9 * 1024 * 1024),
          mediaType: "application/pdf",
        };
      },
    });

    try {
      expect(download).toBeDefined();

      const request = [
        {
          url: new URL("https://example.com/large-report.pdf?test=disk-cache"),
          isUrlSupportedByModel: true,
        },
      ];

      const first = await download!(request);
      const second = await download!(request);

      expect(calls).toBe(1);
      expect(second).toEqual(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resizes oversized images to fit anthropic fallback limits", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    let downloadCalls = 0;
    let fitCalls = 0;

    const download = buildExperimentalDownloadForAnthropicFallback({
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      cacheDir: dir,
      downloadUrl: async () => {
        downloadCalls += 1;
        return {
          data: new Uint8Array(6 * 1024 * 1024),
          mediaType: "image/png",
        };
      },
      fitImage: async () => {
        fitCalls += 1;
        return {
          data: new Uint8Array([1, 2, 3, 4]),
          mediaType: "image/jpeg",
        };
      },
    });

    try {
      expect(download).toBeDefined();

      const request = [
        {
          url: new URL("https://example.com/huge-image.png?test=resize"),
          isUrlSupportedByModel: true,
        },
      ];

      const first = await download!(request);
      const second = await download!(request);

      expect(downloadCalls).toBe(1);
      expect(fitCalls).toBe(1);
      expect(first).toEqual([
        {
          data: new Uint8Array([1, 2, 3, 4]),
          mediaType: "image/jpeg",
        },
      ]);
      expect(second).toEqual(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caches oversize image failures to avoid repeated downloads", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    let downloadCalls = 0;
    let fitCalls = 0;

    const download = buildExperimentalDownloadForAnthropicFallback({
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      cacheDir: dir,
      downloadUrl: async () => {
        downloadCalls += 1;
        return {
          data: new Uint8Array(6 * 1024 * 1024),
          mediaType: "image/png",
        };
      },
      fitImage: async () => {
        fitCalls += 1;
        return null;
      },
    });

    try {
      expect(download).toBeDefined();

      const request = [
        {
          url: new URL("https://example.com/too-big-image.png?test=oversize"),
          isUrlSupportedByModel: true,
        },
      ];

      await expect(download!(request)).rejects.toThrow("Image attachment too large");
      await expect(download!(request)).rejects.toThrow("Image attachment too large");
      expect(downloadCalls).toBe(1);
      expect(fitCalls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not build a download hook when routing is pinned away from fallback providers", () => {
    const download = buildExperimentalDownloadForAnthropicFallback({
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          only: ["anthropic"],
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
    });

    expect(download).toBeUndefined();
  });
});

describe("resolveSessionAdditionalPrompts", () => {
  it("keeps literal prompts and drops empty entries", async () => {
    const prompts = await resolveSessionAdditionalPrompts({
      entries: ["  Keep answers short.  ", "\n\n", "   "],
    });

    expect(prompts).toEqual(["Keep answers short."]);
  });

  it("loads file:// prompts with filename and location header", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-runner-prompts-"));
    try {
      const memoPath = path.join(dir, "session-notes.md");
      await writeFile(memoPath, "be strict about scope\n", "utf8");

      const prompts = await resolveSessionAdditionalPrompts({
        entries: [pathToFileURL(memoPath).toString()],
      });

      expect(prompts).toEqual([`# session-notes.md (${memoPath})\nbe strict about scope`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips unreadable file prompts and reports a warning", async () => {
    const warnings: string[] = [];

    const prompts = await resolveSessionAdditionalPrompts({
      entries: ["file:///tmp/does-not-exist-session-prompt.md"],
      onWarn: (warning) => warnings.push(warning.reason),
    });

    expect(prompts).toEqual([]);
    expect(warnings).toEqual(["read_failed"]);
  });
});

describe("appendAdditionalSessionMemoBlock", () => {
  it("appends Additional Session Memo at the end", () => {
    const out = appendAdditionalSessionMemoBlock("Base prompt", ["Line one", "Line two"]);

    expect(out).toBe("Base prompt\n\nAdditional Session Memo:\nLine one\n\nLine two");
  });

  it("omits the block when combined memo is empty", () => {
    const out = appendAdditionalSessionMemoBlock("Base prompt", ["  ", "\n\n"]);
    expect(out).toBe("Base prompt");
  });
});

describe("appendConfiguredAliasPromptBlock", () => {
  it("appends sorted user and session aliases with ids and comments", () => {
    const out = appendConfiguredAliasPromptBlock({
      baseSystemPrompt: "Base prompt",
      cfg: {
        entity: {
          users: {
            Stanley: { discord: "u1", comment: "Primary operator" },
            alice: { discord: "u2" },
          },
          sessions: {
            discord: {
              ops: { discord: "c1", comment: "Deploy coordination" },
              Deployments: "c2",
            },
          },
        },
      } as Pick<CoreConfig, "entity">,
      coreConfigPath: "/tmp/core-config.yaml",
    });

    expect(out).toContain("Configured Aliases (Discord):");
    expect(out).toContain("- @alice (discord, u2)");
    expect(out).toContain("- @Stanley (discord, u1): Primary operator");
    expect(out).toContain("- #Deployments (discord, c2)");
    expect(out).toContain("- #ops (discord, c1): Deploy coordination");
    expect(out).not.toContain("read /tmp/core-config.yaml");
  });

  it("points to core-config when alias sections are truncated", () => {
    const out = appendConfiguredAliasPromptBlock({
      baseSystemPrompt: "",
      cfg: {
        entity: {
          users: {
            alice: { discord: "u1" },
            bob: { discord: "u2" },
          },
          sessions: {
            discord: {
              dev: "c1",
              ops: "c2",
            },
          },
        },
      } as Pick<CoreConfig, "entity">,
      coreConfigPath: "/tmp/core-config.yaml",
      maxUserAliases: 1,
      maxSessionAliases: 1,
    });

    expect(out).toContain("- @alice (discord, u1)");
    expect(out).not.toContain("- @bob (discord, u2)");
    expect(out).toContain("- #dev (discord, c1)");
    expect(out).not.toContain("- #ops (discord, c2)");
    expect(out).toContain("read /tmp/core-config.yaml");
  });

  it("handles configs with user aliases but no session aliases", () => {
    const out = appendConfiguredAliasPromptBlock({
      baseSystemPrompt: "Base prompt",
      cfg: {
        entity: {
          users: {
            alice: { discord: "u1" },
          },
        },
      } as unknown as Pick<CoreConfig, "entity">,
    });

    expect(out).toContain("- @alice (discord, u1)");
    expect(out).not.toContain("Sessions:");
  });
});

describe("heartbeat overlays", () => {
  it("adds ordinary-session request metadata when heartbeat is enabled", () => {
    const cfg = {
      surface: {
        heartbeat: {
          enabled: true,
          cron: "*/30 * * * *",
          quietAfterActivityMs: 300000,
          retryBusyMs: 60000,
        },
      },
    } as unknown as Pick<CoreConfig, "surface">;

    const overlay = buildHeartbeatOverlayForRequest({
      cfg,
      requestId: "discord:1:2",
      sessionId: "chan",
      runProfile: "primary",
      nowMs: 0,
    });

    expect(overlay).toContain("Heartbeat Context");
    expect(overlay).toContain("sourceSessionId='chan'");
    expect(overlay).toContain("sourceRequestId='discord:1:2'");
  });

  it("adds heartbeat quiet-hours context for heartbeat session", () => {
    const cfg = {
      surface: {
        heartbeat: {
          enabled: true,
          cron: "*/30 * * * *",
          quietAfterActivityMs: 300000,
          retryBusyMs: 60000,
          softQuietHours: {
            start: "23:00",
            end: "08:00",
            timezone: "UTC",
          },
        },
      },
    } as unknown as Pick<CoreConfig, "surface">;

    const overlay = buildHeartbeatOverlayForRequest({
      cfg,
      requestId: "heartbeat:1",
      sessionId: "__heartbeat__",
      runProfile: "primary",
      nowMs: Date.UTC(2026, 2, 11, 23, 30, 0),
    });

    expect(overlay).toContain("Heartbeat Quiet Hours");
    expect(overlay).toContain("Current local quiet-hours state: inside");
  });
});

describe("buildPersistedHeartbeatMessages", () => {
  it("stores heartbeat summary as a single assistant message", () => {
    expect(buildPersistedHeartbeatMessages("summary")).toEqual([
      { role: "assistant", content: "summary" },
    ]);
  });
});

describe("shouldCancelIdleOnlyGlobalRequest", () => {
  it("cancels when another non-heartbeat session is running", () => {
    type IdleOnlyGlobalState =
      Parameters<typeof shouldCancelIdleOnlyGlobalRequest>[0]["states"] extends ReadonlyMap<
        string,
        infer T
      >
        ? T
        : never;

    const states = new Map<string, IdleOnlyGlobalState>([
      [
        "discord-session",
        {
          running: true,
          agent: null,
          queue: [],
          activeRequestId: "req:1",
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        },
      ],
      [
        "__heartbeat__",
        {
          running: false,
          agent: null,
          queue: [],
          activeRequestId: null,
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        },
      ],
    ]);

    expect(
      shouldCancelIdleOnlyGlobalRequest({
        runPolicy: "idle_only_global",
        sessionId: "__heartbeat__",
        states,
      }),
    ).toBe(true);
  });

  it("cancels when the heartbeat session is already running", () => {
    type IdleOnlyGlobalState =
      Parameters<typeof shouldCancelIdleOnlyGlobalRequest>[0]["states"] extends ReadonlyMap<
        string,
        infer T
      >
        ? T
        : never;

    const states = new Map<string, IdleOnlyGlobalState>([
      [
        "__heartbeat__",
        {
          running: true,
          agent: null,
          queue: [],
          activeRequestId: "heartbeat:1",
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        },
      ],
    ]);

    expect(
      shouldCancelIdleOnlyGlobalRequest({
        runPolicy: "idle_only_global",
        sessionId: "__heartbeat__",
        states,
      }),
    ).toBe(true);
  });
});

describe("shouldCancelRunPolicyRequest", () => {
  it("cancels idle_only_session when the session is already running", () => {
    type RunnerState =
      Parameters<typeof shouldCancelRunPolicyRequest>[0]["states"] extends ReadonlyMap<
        string,
        infer T
      >
        ? T
        : never;

    const states = new Map<string, RunnerState>([
      [
        "chan",
        {
          running: true,
          agent: null,
          queue: [],
          activeRequestId: "req:1",
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        },
      ],
    ]);

    expect(
      shouldCancelRunPolicyRequest({
        runPolicy: "idle_only_session",
        sessionId: "chan",
        states,
      }),
    ).toBe(true);
  });
});

describe("maybeAppendResponseCommentaryPrompt", () => {
  it("appends commentary guidance for openai provider when enabled", () => {
    const out = maybeAppendResponseCommentaryPrompt({
      baseSystemPrompt: "Base prompt",
      provider: "openai",
      responseCommentary: true,
    });

    expect(out).toBe(`Base prompt\n\n${RESPONSE_COMMENTARY_INSTRUCTIONS}`);
  });

  it("appends commentary guidance for codex provider when enabled", () => {
    const out = maybeAppendResponseCommentaryPrompt({
      baseSystemPrompt: "Base prompt",
      provider: "codex",
      responseCommentary: true,
    });

    expect(out).toBe(`Base prompt\n\n${RESPONSE_COMMENTARY_INSTRUCTIONS}`);
  });

  it("does not append when disabled", () => {
    const out = maybeAppendResponseCommentaryPrompt({
      baseSystemPrompt: "Base prompt",
      provider: "openai",
      responseCommentary: false,
    });

    expect(out).toBe("Base prompt");
  });

  it("does not append for unsupported providers", () => {
    const out = maybeAppendResponseCommentaryPrompt({
      baseSystemPrompt: "Base prompt",
      provider: "openrouter",
      responseCommentary: true,
    });

    expect(out).toBe("Base prompt");
  });
});

describe("withBlankLineBetweenTextParts", () => {
  it("adds a blank line when text part id changes", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.",
      delta: "Part two.",
      partChanged: true,
    });

    expect(out).toBe("\n\nPart two.");
  });

  it("extends an existing trailing newline to a blank line", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.\n",
      delta: "Part two.",
      partChanged: true,
    });

    expect(out).toBe("\nPart two.");
  });

  it("does not duplicate existing blank-line separation", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.\n\n",
      delta: "Part two.",
      partChanged: true,
    });

    expect(out).toBe("Part two.");
  });

  it("keeps provider whitespace when delta already starts with whitespace", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.",
      delta: "\nPart two.",
      partChanged: true,
    });

    expect(out).toBe("\nPart two.");
  });

  it("does not change deltas when part did not change", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.",
      delta: "Part two.",
      partChanged: false,
    });

    expect(out).toBe("Part two.");
  });

  it("supports restart recovery boundaries with prior visible text", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Sure! Triggering now - see you on the other side.",
      delta: "...and I'm back.",
      partChanged: true,
    });

    expect(out).toBe("\n\n...and I'm back.");
  });

  it("does not add separator when there is no prior visible text", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "",
      delta: "Fresh reply.",
      partChanged: true,
    });

    expect(out).toBe("Fresh reply.");
  });
});

describe("silent assistant turn removal", () => {
  it("drops pure assistant output only inside the completed turn range", () => {
    const messages = [
      { role: "user", content: "request" },
      { role: "assistant", content: "NO_REPLY" },
      { role: "assistant", content: "later answer" },
    ] satisfies ModelMessage[];

    expect(removeSilentAssistantTurnMessages({ messages, startIndex: 1, messageCount: 1 })).toEqual(
      [messages[0]!, messages[2]!],
    );
  });

  it("removes sentinel text but preserves structural assistant parts", () => {
    const messages = [
      { role: "user", content: "request" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "private" },
          { type: "text", text: "NO_REPLY" },
          { type: "tool-call", toolCallId: "call-1", toolName: "builtin", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "builtin",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ] satisfies ModelMessage[];

    expect(removeSilentAssistantTurnMessages({ messages, startIndex: 1, messageCount: 1 })).toEqual(
      [
        messages[0]!,
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "private" },
            { type: "tool-call", toolCallId: "call-1", toolName: "builtin", input: {} },
          ],
        },
        messages[2]!,
      ],
    );
  });

  it("drops reasoning when no structural assistant parts remain", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "private" },
          { type: "text", text: "NO_REPLY" },
        ],
      },
    ] satisfies ModelMessage[];

    expect(removeSilentAssistantTurnMessages({ messages, startIndex: 0, messageCount: 1 })).toEqual(
      [],
    );
  });

  it("uses final-answer phase text when commentary precedes the sentinel", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Commentary update.",
            providerOptions: { openai: { phase: "commentary" } },
          },
          {
            type: "text",
            text: "NO_REPLY",
            providerOptions: { openai: { phase: "final_answer" } },
          },
          { type: "tool-call", toolCallId: "call-1", toolName: "builtin", input: {} },
        ],
      },
    ] satisfies ModelMessage[];

    expect(removeSilentAssistantTurnMessages({ messages, startIndex: 0, messageCount: 1 })).toEqual(
      [
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call-1", toolName: "builtin", input: {} }],
        },
      ],
    );
  });
});

describe("assistant text part boundary accumulation", () => {
  it("separates streamed output and final text when a resumed text block reuses the same part id", () => {
    const state = createAssistantTextPartBoundaryState(undefined);
    const streamed: string[] = [];
    let finalText = "";

    markAssistantTextPartStarted(state, "text-0");
    const firstDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "...update the notes.",
    });
    streamed.push(firstDelta);
    finalText += firstDelta;
    markAssistantTextPartEnded(state, "text-0");

    markAssistantTextPartStarted(state, "text-0");
    const secondDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "Works without the old patch...",
    });
    streamed.push(secondDelta);
    finalText += secondDelta;
    markAssistantTextPartEnded(state, "text-0");

    markAssistantTextPartStarted(state, "text-0");
    const thirdDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "Now let me update the discovery.search entry...",
    });
    streamed.push(thirdDelta);
    finalText += thirdDelta;

    expect(streamed).toEqual([
      "...update the notes.",
      "\n\nWorks without the old patch...",
      "\n\nNow let me update the discovery.search entry...",
    ]);
    expect(finalText).toBe(
      "...update the notes.\n\nWorks without the old patch...\n\nNow let me update the discovery.search entry...",
    );
  });

  it("separates resumed streamed output from recovered visible text before persistence", () => {
    const state = createAssistantTextPartBoundaryState("Done. Updated TOOLS.md...");
    const streamed: string[] = [];
    let finalText = "";

    markAssistantTextPartStarted(state, "text-0");
    const delta = consumeAssistantTextDelta({
      state,
      finalText,
      recoveryPartialText: "Done. Updated TOOLS.md...",
      partId: "text-0",
      delta: "Now let me also write a daily note...",
    });
    streamed.push(delta);
    finalText += delta;

    expect(streamed).toEqual(["\n\nNow let me also write a daily note..."]);
    expect(finalText).toBe("\n\nNow let me also write a daily note...");
  });

  it("keeps a new text-block boundary pending across whitespace-only deltas", () => {
    const state = createAssistantTextPartBoundaryState(undefined);
    const streamed: string[] = [];
    let finalText = "";

    markAssistantTextPartStarted(state, "text-0");
    const firstDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "...update the notes.",
    });
    streamed.push(firstDelta);
    finalText += firstDelta;
    markAssistantTextPartEnded(state, "text-0");

    markAssistantTextPartStarted(state, "text-0");
    const whitespaceDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "\n",
    });
    streamed.push(whitespaceDelta);
    finalText += whitespaceDelta;

    const textDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "Works without the old patch...",
    });
    streamed.push(textDelta);
    finalText += textDelta;

    expect(streamed).toEqual(["...update the notes.", "\n", "\nWorks without the old patch..."]);
    expect(finalText).toBe("...update the notes.\n\nWorks without the old patch...");
  });
});

describe("buildAutoInjectedThreadSearchOverlay", () => {
  it("returns the notice only for primary runs when auto-inject is enabled", () => {
    const baseCfg = parseCoreConfigV1ToUniversal({});
    const cfg: CoreConfig = {
      ...baseCfg,
      conversation: {
        ...baseCfg.conversation,
        thread: {
          ...baseCfg.conversation.thread,
          autoInject: {
            ...baseCfg.conversation.thread.autoInject,
            enabled: true,
          },
        },
      },
    };

    const overlay = buildAutoInjectedThreadSearchOverlay({ cfg, runProfile: "primary" });

    expect(overlay).toBe(
      "Notice on auto-injected possibly related threads:\nThese search results may appear before your reply, treat them as retrieval hints only, and use them when relevant to the current context.",
    );
    expect(
      buildAutoInjectedThreadSearchOverlay({ cfg: baseCfg, runProfile: "primary" }),
    ).toBeNull();
    expect(buildAutoInjectedThreadSearchOverlay({ cfg, runProfile: "explore" })).toBeNull();
  });
});

describe("buildSurfaceMetadataOverlay", () => {
  it("returns null when no user message starts with surface metadata", () => {
    const overlay = buildSurfaceMetadataOverlay([
      { role: "user", content: "plain user text" },
      { role: "assistant", content: '<LILAC_META:v1>{"platform":"discord"}</LILAC_META:v1>' },
    ] satisfies ModelMessage[]);

    expect(overlay).toBeNull();
  });

  it("returns instructions when a user message starts with surface metadata", () => {
    const overlay = buildSurfaceMetadataOverlay([
      {
        role: "user",
        content:
          '<LILAC_META:v1>{"platform":"discord","user_id":"u1","message_id":"m1"}</LILAC_META:v1>\nhello',
      },
    ] satisfies ModelMessage[]);

    expect(overlay).toContain("trusted injected tag");
    expect(overlay).toContain("first line of a user-message block");
    expect(overlay).toContain("&lt;LILAC_META:v1>");
  });

  it("returns instructions for slash-command metadata without message id", () => {
    const overlay = buildSurfaceMetadataOverlay([
      {
        role: "user",
        content: `${formatSurfaceMetadataLine({
          platform: "discord",
          user_id: "u1",
          user_name: "Alice",
          message_time: new Date(1_234).toISOString(),
        })}\n/lilac:tarot 3 focus`,
      },
    ] satisfies ModelMessage[]);

    expect(overlay).toContain("trusted injected tag");
    expect(overlay).toContain("first line of a user-message block");
  });
});

describe("mergeToSingleUserMessage", () => {
  it("keeps all user text when merging plain-text messages", () => {
    const out = mergeToSingleUserMessage([
      { role: "user", content: "B one" },
      { role: "assistant", content: "ignored" },
      { role: "user", content: "C two" },
      { role: "user", content: "D steer" },
    ] satisfies ModelMessage[]);

    expect(out.role).toBe("user");
    expect(typeof out.content).toBe("string");
    expect(out.content).toContain("B one");
    expect(out.content).toContain("C two");
    expect(out.content).toContain("D steer");
  });

  it("preserves later metadata lines at merged block boundaries", () => {
    const out = mergeToSingleUserMessage([
      {
        role: "user",
        content: '<LILAC_META:v1>{"platform":"discord","message_id":"m1"}</LILAC_META:v1>\nfirst',
      },
      {
        role: "user",
        content: '<LILAC_META:v1>{"platform":"discord","message_id":"m2"}</LILAC_META:v1>\nsecond',
      },
    ] satisfies ModelMessage[]);

    expect(out.role).toBe("user");
    expect(typeof out.content).toBe("string");
    expect(out.content).toContain("m1");
    expect(out.content).toContain(
      '\n\n<LILAC_META:v1>{"platform":"discord","message_id":"m2"}</LILAC_META:v1>\nsecond',
    );
  });

  it("preserves buffered multipart content and steering text in one merged user message", () => {
    const out = mergeToSingleUserMessage([
      {
        role: "user",
        content: [
          { type: "text", text: "B with image" },
          { type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
        ],
      },
      { role: "user", content: "D steer" },
    ] satisfies ModelMessage[]);

    expect(out.role).toBe("user");
    expect(Array.isArray(out.content)).toBe(true);
    expect(
      Array.isArray(out.content) &&
        out.content.some((part) => part.type === "text" && part.text.includes("B with image")),
    ).toBe(true);
    expect(
      Array.isArray(out.content) &&
        out.content.some((part) => part.type === "text" && part.text.includes("D steer")),
    ).toBe(true);
    expect(Array.isArray(out.content) && out.content.some((part) => part.type === "file")).toBe(
      true,
    );
  });

  it("preserves steering multipart content and buffered text in one merged user message", () => {
    const out = mergeToSingleUserMessage([
      { role: "user", content: "B one" },
      {
        role: "user",
        content: [
          { type: "text", text: "D interrupt with image" },
          { type: "file", data: new Uint8Array([7, 8]), mediaType: "image/jpeg" },
        ],
      },
    ] satisfies ModelMessage[]);

    expect(out.role).toBe("user");
    expect(Array.isArray(out.content)).toBe(true);
    expect(
      Array.isArray(out.content) &&
        out.content.some((part) => part.type === "text" && part.text.includes("B one")),
    ).toBe(true);
    expect(
      Array.isArray(out.content) &&
        out.content.some((part) => part.type === "text" && part.text.includes("D interrupt")),
    ).toBe(true);
    expect(Array.isArray(out.content) && out.content.some((part) => part.type === "file")).toBe(
      true,
    );
  });
});

describe("custom command failures", () => {
  it("builds persisted finalText from the bounded normalized error", () => {
    const finalText = buildCustomCommandFailureFinalText({
      commandText: "/fixture",
      normalizedOutput: {
        type: "error-text",
        value: "bounded error [tool result truncated: 100 characters omitted]",
      },
    });

    expect(finalText).toBe(
      "Error running /fixture: bounded error [tool result truncated: 100 characters omitted]",
    );
  });
});
