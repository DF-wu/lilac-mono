/**
 * Canonical event contracts for the Lilac monorepo.
 *
 * Payload types are derived from the colocated runtime schemas used at the
 * event-bus trust boundary.
 */

import { modelMessageSchema } from "ai";
import { z } from "zod";

import { corePrimaryLineageV1Schema, decodeCorePrimaryLineageV1 } from "./core-primary-lineage";

/**
 * Event type string constants (use for autocomplete).
 */
export const lilacEventTypes = {
  CmdRequestMessage: "cmd.request.message",

  CmdSurfaceOutputReanchor: "cmd.surface.output.reanchor",

  EvtAdapterMessageCreated: "evt.adapter.message.created",
  EvtAdapterMessageUpdated: "evt.adapter.message.updated",
  EvtAdapterMessageDeleted: "evt.adapter.message.deleted",
  EvtAdapterReactionAdded: "evt.adapter.reaction.added",
  EvtAdapterReactionRemoved: "evt.adapter.reaction.removed",
  EvtAdapterActionInvoked: "evt.adapter.action.invoked",
  EvtWorkflowWaitResolverBarrier: "evt.adapter.workflow-wait-resolver.barrier",

  EvtRequestLifecycleChanged: "evt.request.lifecycle.changed",
  EvtRequestReply: "evt.request.reply",

  EvtSurfaceOutputMessageCreated: "evt.surface.output.message.created",

  EvtWorkflowRunChanged: "evt.workflow.run.changed",
  EvtWorkflowOperationChanged: "evt.workflow.operation.changed",
  EvtWorkflowProgressRequested: "evt.workflow.progress.requested",
  EvtWorkflowUsageChanged: "evt.workflow.usage.changed",
  EvtWorkflowResultReady: "evt.workflow.result.ready",

  CmdAgentCreate: "cmd.agent.create",

  EvtAgentOutputDeltaReasoning: "evt.agent.output.delta.reasoning",
  EvtAgentOutputDeltaText: "evt.agent.output.delta.text",
  EvtAgentOutputTextReset: "evt.agent.output.text.reset",
  EvtAgentOutputResponseText: "evt.agent.output.response.text",
  EvtAgentOutputResponseBinary: "evt.agent.output.response.binary",
  EvtAgentOutputToolCall: "evt.agent.output.toolcall",
  EvtAgentOutputActivity: "evt.agent.output.activity",
} as const;

/** Union of all supported Lilac event types. */
export type LilacEventType = (typeof lilacEventTypes)[keyof typeof lilacEventTypes];

/** Output stream topic for a single request (agent output deltas/responses). */
export type OutReqTopic = `out.req.${string}`;

/** Runtime contract for an output stream topic with a non-empty request suffix. */
export const outReqTopicSchema = z.templateLiteral(["out.req.", z.string().min(1)]);

/** Build the output stream topic for a requestId. */
export function outReqTopic(requestId: string): OutReqTopic {
  return `out.req.${requestId}`;
}

const nonemptyStringSchema = z.string().min(1);
const finiteNumberSchema = z.number().finite();

export const requestLifecycleStateSchema = z.enum([
  "queued",
  "running",
  "resolved",
  "failed",
  "cancelled",
]);
export type RequestLifecycleState = z.output<typeof requestLifecycleStateSchema>;

export const adapterPlatformSchema = z.enum([
  "discord",
  "github",
  "whatsapp",
  "slack",
  "telegram",
  "web",
  "unknown",
]);
export type AdapterPlatform = z.output<typeof adapterPlatformSchema>;

/** Reference to a surface message (platform+channel+message). */
export const surfaceMsgRefSchema = z.strictObject({
  platform: adapterPlatformSchema,
  channelId: nonemptyStringSchema,
  messageId: nonemptyStringSchema,
});
export type SurfaceMsgRef = z.output<typeof surfaceMsgRefSchema>;

export const requestQueueModeSchema = z.enum(["prompt", "steer", "followUp", "interrupt"]);
export type RequestQueueMode = z.output<typeof requestQueueModeSchema>;

export const requestRunPolicySchema = z.enum(["normal", "idle_only_session", "idle_only_global"]);
export type RequestRunPolicy = z.output<typeof requestRunPolicySchema>;

export const requestOriginSchema = z.strictObject({
  kind: z.literal("heartbeat"),
  reason: z.enum(["interval", "retry"]),
});
export type RequestOrigin = z.output<typeof requestOriginSchema>;

const cmdRequestMessageDataShapeSchema = z.strictObject({
  queue: requestQueueModeSchema,
  messages: z.array(modelMessageSchema),
  corePrimaryLineage: corePrimaryLineageV1Schema.optional(),
  runPolicy: requestRunPolicySchema.optional(),
  origin: requestOriginSchema.optional(),
  modelOverride: z.string().optional(),
  raw: z.unknown().optional(),
});

/** Command payload, including cross-field validation of Core primary lineage. */
export const cmdRequestMessageDataSchema = cmdRequestMessageDataShapeSchema.superRefine(
  (data, context) => {
    if (!data.corePrimaryLineage) return;
    const decoded = decodeCorePrimaryLineageV1(data.corePrimaryLineage, data.messages);
    if (decoded.status === "error") {
      for (const issue of decoded.error.issues) {
        context.addIssue({
          code: "custom",
          path: ["corePrimaryLineage", ...issue.path],
          message: issue.message,
        });
      }
    }
  },
);
export type CmdRequestMessageData = z.output<typeof cmdRequestMessageDataSchema>;

/** Parse request data and validate any supplied lineage against `messages`. */
export function parseCmdRequestMessageData(value: unknown): CmdRequestMessageData {
  return cmdRequestMessageDataSchema.parse(value);
}

/** Command: switch an active output relay to a new reply anchor. */
export const cmdSurfaceOutputReanchorDataSchema = z.strictObject({
  /** When true, keep the relay's current reply mode (reply vs top-level). */
  inheritReplyTo: z.boolean(),
  /** Optional reanchor mode for UI placeholders. */
  mode: z.enum(["steer", "interrupt"]).optional(),
  /** Override reply target when inheritReplyTo=false; omit for top-level. */
  replyTo: surfaceMsgRefSchema.optional(),
});
export type CmdSurfaceOutputReanchorData = z.output<typeof cmdSurfaceOutputReanchorDataSchema>;

const adapterMessageDataShape = {
  platform: adapterPlatformSchema,
  channelId: nonemptyStringSchema,
  channelName: z.string().optional(),
  messageId: nonemptyStringSchema,
  userId: nonemptyStringSchema,
  userName: z.string().optional(),
  text: z.string(),
  ts: finiteNumberSchema,
  raw: z.unknown().optional(),
};
export const evtAdapterMessageCreatedDataSchema = z.strictObject(adapterMessageDataShape);
export type EvtAdapterMessageCreatedData = z.output<typeof evtAdapterMessageCreatedDataSchema>;
export const evtAdapterMessageUpdatedDataSchema = z.strictObject(adapterMessageDataShape);
export type EvtAdapterMessageUpdatedData = z.output<typeof evtAdapterMessageUpdatedDataSchema>;

export const evtAdapterMessageDeletedDataSchema = z.strictObject({
  platform: adapterPlatformSchema,
  channelId: nonemptyStringSchema,
  channelName: z.string().optional(),
  messageId: nonemptyStringSchema,
  ts: finiteNumberSchema,
  raw: z.unknown().optional(),
});
export type EvtAdapterMessageDeletedData = z.output<typeof evtAdapterMessageDeletedDataSchema>;

const adapterReactionDataShape = {
  platform: adapterPlatformSchema,
  channelId: nonemptyStringSchema,
  channelName: z.string().optional(),
  messageId: nonemptyStringSchema,
  userId: nonemptyStringSchema.optional(),
  userName: z.string().optional(),
  reaction: z.string(),
  ts: finiteNumberSchema,
  raw: z.unknown().optional(),
};
export const evtAdapterReactionAddedDataSchema = z.strictObject(adapterReactionDataShape);
export type EvtAdapterReactionAddedData = z.output<typeof evtAdapterReactionAddedDataSchema>;
export const evtAdapterReactionRemovedDataSchema = z.strictObject(adapterReactionDataShape);
export type EvtAdapterReactionRemovedData = z.output<typeof evtAdapterReactionRemovedDataSchema>;

export const evtAdapterActionInvokedDataSchema = z.strictObject({
  actionId: nonemptyStringSchema,
  platform: adapterPlatformSchema,
  userId: nonemptyStringSchema,
  messageRef: surfaceMsgRefSchema,
  sourceMessageId: nonemptyStringSchema.optional(),
  ts: finiteNumberSchema,
});
export type EvtAdapterActionInvokedData = z.output<typeof evtAdapterActionInvokedDataSchema>;

export const evtWorkflowWaitResolverBarrierDataSchema = z.strictObject({
  barrierId: nonemptyStringSchema,
  ts: finiteNumberSchema,
});
export type EvtWorkflowWaitResolverBarrierData = z.output<
  typeof evtWorkflowWaitResolverBarrierDataSchema
>;

export const evtRequestLifecycleChangedDataSchema = z.strictObject({
  state: requestLifecycleStateSchema,
  detail: z.string().optional(),
  ts: finiteNumberSchema.optional(),
});
export type EvtRequestLifecycleChangedData = z.output<typeof evtRequestLifecycleChangedDataSchema>;

export const evtRequestReplyDataSchema = z.strictObject({});
export type EvtRequestReplyData = z.output<typeof evtRequestReplyDataSchema>;

/** Event: a surface output message was created for a request. */
export const evtSurfaceOutputMessageCreatedDataSchema = z.strictObject({
  msgRef: surfaceMsgRefSchema,
});
export type EvtSurfaceOutputMessageCreatedData = z.output<
  typeof evtSurfaceOutputMessageCreatedDataSchema
>;

export const workflowRunEventStateSchema = z.enum([
  "queued",
  "running",
  "blocked",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
]);
export type WorkflowRunEventState = z.output<typeof workflowRunEventStateSchema>;

export const workflowOperationEventStateSchema = z.enum([
  "queued",
  "dispatched",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);
export type WorkflowOperationEventState = z.output<typeof workflowOperationEventStateSchema>;

export const evtWorkflowRunChangedDataSchema = z.strictObject({
  runId: nonemptyStringSchema,
  revisionId: nonemptyStringSchema,
  state: workflowRunEventStateSchema,
  previousState: workflowRunEventStateSchema.optional(),
  detail: z.string().optional(),
  ts: finiteNumberSchema,
});
export type EvtWorkflowRunChangedData = z.output<typeof evtWorkflowRunChangedDataSchema>;

export const evtWorkflowOperationChangedDataSchema = z.strictObject({
  runId: nonemptyStringSchema,
  revisionId: nonemptyStringSchema,
  operationId: nonemptyStringSchema,
  kind: z.enum(["agent", "parallel", "pipeline", "phase", "wait"]),
  state: workflowOperationEventStateSchema,
  previousState: workflowOperationEventStateSchema.optional(),
  phase: z.string().optional(),
  label: z.string().optional(),
  ts: finiteNumberSchema,
});
export type EvtWorkflowOperationChangedData = z.output<
  typeof evtWorkflowOperationChangedDataSchema
>;

export const evtWorkflowProgressRequestedDataSchema = z.strictObject({
  runId: nonemptyStringSchema,
  revisionId: nonemptyStringSchema,
  reason: z.enum(["created", "state_changed", "operation_changed", "usage_changed", "reconcile"]),
  ts: finiteNumberSchema,
});
export type EvtWorkflowProgressRequestedData = z.output<
  typeof evtWorkflowProgressRequestedDataSchema
>;

export const evtWorkflowUsageChangedDataSchema = z.strictObject({
  runId: nonemptyStringSchema,
  revisionId: nonemptyStringSchema,
  operationId: nonemptyStringSchema.optional(),
  usage: z.strictObject({
    inputTokens: finiteNumberSchema,
    outputTokens: finiteNumberSchema,
    totalTokens: finiteNumberSchema,
    agentCount: finiteNumberSchema,
    activeAgents: finiteNumberSchema,
  }),
  ts: finiteNumberSchema,
});
export type EvtWorkflowUsageChangedData = z.output<typeof evtWorkflowUsageChangedDataSchema>;

export const evtWorkflowResultReadyDataSchema = z.strictObject({
  runId: nonemptyStringSchema,
  revisionId: nonemptyStringSchema,
  state: z.enum(["succeeded", "failed", "rejected", "cancelled"]),
  summary: z.string().optional(),
  resultArtifactId: nonemptyStringSchema.optional(),
  ts: finiteNumberSchema,
});
export type EvtWorkflowResultReadyData = z.output<typeof evtWorkflowResultReadyDataSchema>;

export const cmdAgentCreateDataSchema = z
  .strictObject({
    agentId: nonemptyStringSchema,
    context: z.unknown(),
  })
  .superRefine((data, context) => {
    if (!Object.hasOwn(data, "context")) {
      context.addIssue({ code: "custom", path: ["context"], message: "Required" });
    }
  });
export type CmdAgentCreateData = z.output<typeof cmdAgentCreateDataSchema>;

export const evtAgentOutputDeltaReasoningDataSchema = z.strictObject({
  delta: z.string(),
  seq: finiteNumberSchema.optional(),
});
export type EvtAgentOutputDeltaReasoningData = z.output<
  typeof evtAgentOutputDeltaReasoningDataSchema
>;

const agentOutputPhaseSchema = z.enum(["commentary", "final_answer"]);
export const evtAgentOutputDeltaTextDataSchema = z.strictObject({
  delta: z.string(),
  /** Native OpenAI Responses message phase when available. */
  phase: agentOutputPhaseSchema.optional(),
  /** Synthetic leading separator inserted between assistant text parts. */
  phaseBoundaryPrefixChars: finiteNumberSchema.optional(),
  seq: finiteNumberSchema.optional(),
});
export type EvtAgentOutputDeltaTextData = z.output<typeof evtAgentOutputDeltaTextDataSchema>;

export const evtAgentOutputTextResetDataSchema = z.strictObject({
  /** Full retained response text after rolling back transient streamed output. */
  text: z.string(),
  /** Phase of the last retained OpenAI text item, when known. */
  phase: agentOutputPhaseSchema.optional(),
});
export type EvtAgentOutputTextResetData = z.output<typeof evtAgentOutputTextResetDataSchema>;

export const evtAgentOutputResponseTextDataSchema = z.strictObject({
  /** The full response text accumulated across all deltas. */
  finalText: z.string(),
  /** Delivery directive for surfaces. Defaults to "reply" when omitted. */
  delivery: z.enum(["reply", "skip"]).optional(),
  /** Optional one-line token/model stats for surface rendering. */
  statsForNerdsLine: z.string().optional(),
  /** Structured aggregate usage for durable workflow consumers. */
  usage: z
    .strictObject({
      inputTokens: finiteNumberSchema,
      outputTokens: finiteNumberSchema,
      totalTokens: finiteNumberSchema,
    })
    .optional(),
});
export type EvtAgentOutputResponseTextData = z.output<typeof evtAgentOutputResponseTextDataSchema>;

export const evtAgentOutputResponseBinaryDataSchema = z.strictObject({
  mimeType: nonemptyStringSchema,
  dataBase64: z.string(),
  filename: z.string().optional(),
});
export type EvtAgentOutputResponseBinaryData = z.output<
  typeof evtAgentOutputResponseBinaryDataSchema
>;

export const toolCallStatusSchema = z.enum(["start", "update", "end"]);
export type ToolCallStatus = z.output<typeof toolCallStatusSchema>;

export const evtAgentOutputToolCallDataSchema = z.strictObject({
  /** Correlates tool events within a request. */
  toolCallId: nonemptyStringSchema,
  /** Start/update/end boundaries for a tool call. */
  status: toolCallStatusSchema,
  /** Preformatted label for UI (e.g. `[bash] ls -al`). */
  display: z.string(),
  /** Present when `status === "end"`. */
  ok: z.boolean().optional(),
  /** Present when `status === "end" && ok === false`. */
  error: z.string().optional(),
});
export type EvtAgentOutputToolCallData = z.output<typeof evtAgentOutputToolCallDataSchema>;

export const evtAgentOutputActivityDataSchema = z.strictObject({
  source: z.enum(["model", "tool", "subagent"]),
});
export type EvtAgentOutputActivityData = z.output<typeof evtAgentOutputActivityDataSchema>;

/**
 * Type-level map: event type -> topic + payload.
 */
export type LilacEventSpec = {
  [lilacEventTypes.CmdRequestMessage]: {
    topic: "cmd.request";
    key: string;
    data: CmdRequestMessageData;
  };

  [lilacEventTypes.CmdSurfaceOutputReanchor]: {
    topic: "cmd.surface";
    key: string;
    data: CmdSurfaceOutputReanchorData;
  };

  [lilacEventTypes.EvtAdapterMessageCreated]: {
    topic: "evt.adapter";
    key: string;
    data: EvtAdapterMessageCreatedData;
  };

  [lilacEventTypes.EvtAdapterMessageUpdated]: {
    topic: "evt.adapter";
    key: string;
    data: EvtAdapterMessageUpdatedData;
  };

  [lilacEventTypes.EvtAdapterMessageDeleted]: {
    topic: "evt.adapter";
    key: string;
    data: EvtAdapterMessageDeletedData;
  };

  [lilacEventTypes.EvtAdapterReactionAdded]: {
    topic: "evt.adapter";
    key: string;
    data: EvtAdapterReactionAddedData;
  };

  [lilacEventTypes.EvtAdapterReactionRemoved]: {
    topic: "evt.adapter";
    key: string;
    data: EvtAdapterReactionRemovedData;
  };

  [lilacEventTypes.EvtAdapterActionInvoked]: {
    topic: "evt.adapter";
    key: string;
    data: EvtAdapterActionInvokedData;
  };

  [lilacEventTypes.EvtWorkflowWaitResolverBarrier]: {
    topic: "evt.adapter";
    key: string;
    data: EvtWorkflowWaitResolverBarrierData;
  };

  [lilacEventTypes.EvtRequestLifecycleChanged]: {
    topic: "evt.request";
    key: string;
    data: EvtRequestLifecycleChangedData;
  };

  [lilacEventTypes.EvtRequestReply]: {
    topic: "evt.request";
    key: string;
    data: EvtRequestReplyData;
  };

  [lilacEventTypes.EvtSurfaceOutputMessageCreated]: {
    topic: "evt.surface";
    key: string;
    data: EvtSurfaceOutputMessageCreatedData;
  };

  [lilacEventTypes.EvtWorkflowRunChanged]: {
    topic: "evt.workflow";
    key: string;
    data: EvtWorkflowRunChangedData;
  };

  [lilacEventTypes.EvtWorkflowOperationChanged]: {
    topic: "evt.workflow";
    key: string;
    data: EvtWorkflowOperationChangedData;
  };

  [lilacEventTypes.EvtWorkflowProgressRequested]: {
    topic: "evt.workflow";
    key: string;
    data: EvtWorkflowProgressRequestedData;
  };

  [lilacEventTypes.EvtWorkflowUsageChanged]: {
    topic: "evt.workflow";
    key: string;
    data: EvtWorkflowUsageChangedData;
  };

  [lilacEventTypes.EvtWorkflowResultReady]: {
    topic: "evt.workflow";
    key: string;
    data: EvtWorkflowResultReadyData;
  };

  [lilacEventTypes.CmdAgentCreate]: {
    topic: "cmd.agent";
    key: string;
    data: CmdAgentCreateData;
  };

  [lilacEventTypes.EvtAgentOutputDeltaReasoning]: {
    topic: OutReqTopic;
    key: string;
    data: EvtAgentOutputDeltaReasoningData;
  };

  [lilacEventTypes.EvtAgentOutputDeltaText]: {
    topic: OutReqTopic;
    key: string;
    data: EvtAgentOutputDeltaTextData;
  };

  [lilacEventTypes.EvtAgentOutputTextReset]: {
    topic: OutReqTopic;
    key: string;
    data: EvtAgentOutputTextResetData;
  };

  [lilacEventTypes.EvtAgentOutputResponseText]: {
    topic: OutReqTopic;
    key: string;
    data: EvtAgentOutputResponseTextData;
  };

  [lilacEventTypes.EvtAgentOutputResponseBinary]: {
    topic: OutReqTopic;
    key: string;
    data: EvtAgentOutputResponseBinaryData;
  };

  [lilacEventTypes.EvtAgentOutputToolCall]: {
    topic: OutReqTopic;
    key: string;
    data: EvtAgentOutputToolCallData;
  };
  [lilacEventTypes.EvtAgentOutputActivity]: {
    topic: OutReqTopic;
    key: string;
    data: EvtAgentOutputActivityData;
  };
};

/** Union of all topics used by the Lilac bus. */
export type LilacTopic = LilacEventSpec[LilacEventType]["topic"];

/** Event types that may appear on a given topic. */
export type LilacEventTypesForTopic<TTopic extends LilacTopic> = {
  [TType in LilacEventType]: LilacEventSpec[TType]["topic"] extends TTopic ? TType : never;
}[LilacEventType];

/** Payload type for a given event type. */
export type LilacDataForType<TType extends LilacEventType> = LilacEventSpec[TType]["data"];

/** Topic used to route a given event type. */
export type LilacTopicForType<TType extends LilacEventType> = LilacEventSpec[TType]["topic"];

/** Correlation/partition key type for a given event type. */
export type LilacKeyForType<TType extends LilacEventType> = LilacEventSpec[TType] extends {
  key: infer K;
}
  ? K
  : never;
