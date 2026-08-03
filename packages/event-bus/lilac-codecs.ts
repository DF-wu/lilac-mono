import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import {
  adapterPlatformSchema,
  cmdAgentCreateDataSchema,
  cmdRequestMessageDataSchema,
  cmdSurfaceOutputReanchorDataSchema,
  evtAdapterActionInvokedDataSchema,
  evtAdapterMessageCreatedDataSchema,
  evtAdapterMessageDeletedDataSchema,
  evtAdapterMessageUpdatedDataSchema,
  evtAdapterReactionAddedDataSchema,
  evtAdapterReactionRemovedDataSchema,
  evtAgentOutputActivityDataSchema,
  evtAgentOutputDeltaReasoningDataSchema,
  evtAgentOutputDeltaTextDataSchema,
  evtAgentOutputResponseBinaryDataSchema,
  evtAgentOutputResponseTextDataSchema,
  evtAgentOutputTextResetDataSchema,
  evtAgentOutputToolCallDataSchema,
  evtRequestLifecycleChangedDataSchema,
  evtRequestReplyDataSchema,
  evtSurfaceOutputMessageCreatedDataSchema,
  evtWorkflowOperationChangedDataSchema,
  evtWorkflowProgressRequestedDataSchema,
  evtWorkflowResultReadyDataSchema,
  evtWorkflowRunChangedDataSchema,
  evtWorkflowUsageChangedDataSchema,
  evtWorkflowWaitResolverBarrierDataSchema,
  lilacEventTypes,
  outReqTopic,
  outReqTopicSchema,
  type AdapterPlatform,
  type LilacDataForType,
  type LilacEventTypesForTopic,
  type LilacEventType,
  type LilacTopic,
  type LilacTopicForType,
} from "./lilac-spec";
import type { DecodedMessage, Message } from "./types";

const nonemptyStringSchema = z.string().min(1);
const finiteNumberSchema = z.number().finite();

type LilacKeySource = "request_id" | "messageId" | "actionId" | "barrierId" | "runId" | "agentId";

type OutputEventType =
  | typeof lilacEventTypes.EvtAgentOutputDeltaReasoning
  | typeof lilacEventTypes.EvtAgentOutputDeltaText
  | typeof lilacEventTypes.EvtAgentOutputTextReset
  | typeof lilacEventTypes.EvtAgentOutputResponseText
  | typeof lilacEventTypes.EvtAgentOutputResponseBinary
  | typeof lilacEventTypes.EvtAgentOutputToolCall
  | typeof lilacEventTypes.EvtAgentOutputActivity;
type RequestScopedEventType =
  | typeof lilacEventTypes.CmdRequestMessage
  | typeof lilacEventTypes.CmdSurfaceOutputReanchor
  | typeof lilacEventTypes.EvtRequestLifecycleChanged
  | typeof lilacEventTypes.EvtRequestReply
  | typeof lilacEventTypes.EvtSurfaceOutputMessageCreated
  | OutputEventType;
type AdapterMessageKeyEventType =
  | typeof lilacEventTypes.EvtAdapterMessageCreated
  | typeof lilacEventTypes.EvtAdapterMessageUpdated
  | typeof lilacEventTypes.EvtAdapterMessageDeleted
  | typeof lilacEventTypes.EvtAdapterReactionAdded
  | typeof lilacEventTypes.EvtAdapterReactionRemoved;
type WorkflowEventType =
  | typeof lilacEventTypes.EvtWorkflowRunChanged
  | typeof lilacEventTypes.EvtWorkflowOperationChanged
  | typeof lilacEventTypes.EvtWorkflowProgressRequested
  | typeof lilacEventTypes.EvtWorkflowUsageChanged
  | typeof lilacEventTypes.EvtWorkflowResultReady;
type LilacKeySourceForType<TType extends LilacEventType> = TType extends RequestScopedEventType
  ? "request_id"
  : TType extends AdapterMessageKeyEventType
    ? "messageId"
    : TType extends typeof lilacEventTypes.EvtAdapterActionInvoked
      ? "actionId"
      : TType extends typeof lilacEventTypes.EvtWorkflowWaitResolverBarrier
        ? "barrierId"
        : TType extends WorkflowEventType
          ? "runId"
          : TType extends typeof lilacEventTypes.CmdAgentCreate
            ? "agentId"
            : never;

export type LilacEventCodec<TType extends LilacEventType> = {
  readonly type: TType;
  readonly topic: TType extends OutputEventType ? "out.req" : LilacTopicForType<TType>;
  readonly topicSchema: z.ZodType<LilacTopicForType<TType>>;
  readonly resolveTopic: (requestId: string) => LilacTopicForType<TType>;
  readonly requiresRequestId: TType extends RequestScopedEventType ? true : false;
  readonly keySource: LilacKeySourceForType<TType> & LilacKeySource;
  readonly dataSchema: z.ZodType<LilacDataForType<TType>>;
};

type DecodedLilacMessageOf<TType extends LilacEventType> = Omit<
  DecodedMessage<LilacDataForType<TType>>,
  "headers" | "key" | "topic" | "type"
> & {
  readonly type: TType;
  readonly topic: LilacTopicForType<TType>;
  readonly key: string;
  readonly headers?: Record<string, string> & {
    readonly request_id?: string;
    readonly session_id?: string;
    readonly request_client?: AdapterPlatform;
  };
};

/** A fully decoded event union whose type discriminant controls topic and payload. */
export type DecodedLilacMessage<TType extends LilacEventType = LilacEventType> =
  TType extends LilacEventType ? DecodedLilacMessageOf<TType> : never;

export type LilacEventCodecRegistry = {
  readonly [TType in LilacEventType]: LilacEventCodec<TType>;
};

function staticTopic<TTopic extends LilacTopic>(topic: TTopic): () => TTopic {
  return () => topic;
}

export const lilacEventCodecRegistry = {
  [lilacEventTypes.CmdRequestMessage]: {
    type: lilacEventTypes.CmdRequestMessage,
    topic: "cmd.request",
    topicSchema: z.literal("cmd.request"),
    resolveTopic: staticTopic("cmd.request"),
    requiresRequestId: true,
    keySource: "request_id",
    dataSchema: cmdRequestMessageDataSchema,
  },
  [lilacEventTypes.CmdSurfaceOutputReanchor]: {
    type: lilacEventTypes.CmdSurfaceOutputReanchor,
    topic: "cmd.surface",
    topicSchema: z.literal("cmd.surface"),
    resolveTopic: staticTopic("cmd.surface"),
    requiresRequestId: true,
    keySource: "request_id",
    dataSchema: cmdSurfaceOutputReanchorDataSchema,
  },
  [lilacEventTypes.EvtAdapterMessageCreated]: {
    type: lilacEventTypes.EvtAdapterMessageCreated,
    topic: "evt.adapter",
    topicSchema: z.literal("evt.adapter"),
    resolveTopic: staticTopic("evt.adapter"),
    requiresRequestId: false,
    keySource: "messageId",
    dataSchema: evtAdapterMessageCreatedDataSchema,
  },
  [lilacEventTypes.EvtAdapterMessageUpdated]: {
    type: lilacEventTypes.EvtAdapterMessageUpdated,
    topic: "evt.adapter",
    topicSchema: z.literal("evt.adapter"),
    resolveTopic: staticTopic("evt.adapter"),
    requiresRequestId: false,
    keySource: "messageId",
    dataSchema: evtAdapterMessageUpdatedDataSchema,
  },
  [lilacEventTypes.EvtAdapterMessageDeleted]: {
    type: lilacEventTypes.EvtAdapterMessageDeleted,
    topic: "evt.adapter",
    topicSchema: z.literal("evt.adapter"),
    resolveTopic: staticTopic("evt.adapter"),
    requiresRequestId: false,
    keySource: "messageId",
    dataSchema: evtAdapterMessageDeletedDataSchema,
  },
  [lilacEventTypes.EvtAdapterReactionAdded]: {
    type: lilacEventTypes.EvtAdapterReactionAdded,
    topic: "evt.adapter",
    topicSchema: z.literal("evt.adapter"),
    resolveTopic: staticTopic("evt.adapter"),
    requiresRequestId: false,
    keySource: "messageId",
    dataSchema: evtAdapterReactionAddedDataSchema,
  },
  [lilacEventTypes.EvtAdapterReactionRemoved]: {
    type: lilacEventTypes.EvtAdapterReactionRemoved,
    topic: "evt.adapter",
    topicSchema: z.literal("evt.adapter"),
    resolveTopic: staticTopic("evt.adapter"),
    requiresRequestId: false,
    keySource: "messageId",
    dataSchema: evtAdapterReactionRemovedDataSchema,
  },
  [lilacEventTypes.EvtAdapterActionInvoked]: {
    type: lilacEventTypes.EvtAdapterActionInvoked,
    topic: "evt.adapter",
    topicSchema: z.literal("evt.adapter"),
    resolveTopic: staticTopic("evt.adapter"),
    requiresRequestId: false,
    keySource: "actionId",
    dataSchema: evtAdapterActionInvokedDataSchema,
  },
  [lilacEventTypes.EvtWorkflowWaitResolverBarrier]: {
    type: lilacEventTypes.EvtWorkflowWaitResolverBarrier,
    topic: "evt.adapter",
    topicSchema: z.literal("evt.adapter"),
    resolveTopic: staticTopic("evt.adapter"),
    requiresRequestId: false,
    keySource: "barrierId",
    dataSchema: evtWorkflowWaitResolverBarrierDataSchema,
  },
  [lilacEventTypes.EvtRequestLifecycleChanged]: {
    type: lilacEventTypes.EvtRequestLifecycleChanged,
    topic: "evt.request",
    topicSchema: z.literal("evt.request"),
    resolveTopic: staticTopic("evt.request"),
    requiresRequestId: true,
    keySource: "request_id",
    dataSchema: evtRequestLifecycleChangedDataSchema,
  },
  [lilacEventTypes.EvtRequestReply]: {
    type: lilacEventTypes.EvtRequestReply,
    topic: "evt.request",
    topicSchema: z.literal("evt.request"),
    resolveTopic: staticTopic("evt.request"),
    requiresRequestId: true,
    keySource: "request_id",
    dataSchema: evtRequestReplyDataSchema,
  },
  [lilacEventTypes.EvtSurfaceOutputMessageCreated]: {
    type: lilacEventTypes.EvtSurfaceOutputMessageCreated,
    topic: "evt.surface",
    topicSchema: z.literal("evt.surface"),
    resolveTopic: staticTopic("evt.surface"),
    requiresRequestId: true,
    keySource: "request_id",
    dataSchema: evtSurfaceOutputMessageCreatedDataSchema,
  },
  [lilacEventTypes.EvtWorkflowRunChanged]: {
    type: lilacEventTypes.EvtWorkflowRunChanged,
    topic: "evt.workflow",
    topicSchema: z.literal("evt.workflow"),
    resolveTopic: staticTopic("evt.workflow"),
    requiresRequestId: false,
    keySource: "runId",
    dataSchema: evtWorkflowRunChangedDataSchema,
  },
  [lilacEventTypes.EvtWorkflowOperationChanged]: {
    type: lilacEventTypes.EvtWorkflowOperationChanged,
    topic: "evt.workflow",
    topicSchema: z.literal("evt.workflow"),
    resolveTopic: staticTopic("evt.workflow"),
    requiresRequestId: false,
    keySource: "runId",
    dataSchema: evtWorkflowOperationChangedDataSchema,
  },
  [lilacEventTypes.EvtWorkflowProgressRequested]: {
    type: lilacEventTypes.EvtWorkflowProgressRequested,
    topic: "evt.workflow",
    topicSchema: z.literal("evt.workflow"),
    resolveTopic: staticTopic("evt.workflow"),
    requiresRequestId: false,
    keySource: "runId",
    dataSchema: evtWorkflowProgressRequestedDataSchema,
  },
  [lilacEventTypes.EvtWorkflowUsageChanged]: {
    type: lilacEventTypes.EvtWorkflowUsageChanged,
    topic: "evt.workflow",
    topicSchema: z.literal("evt.workflow"),
    resolveTopic: staticTopic("evt.workflow"),
    requiresRequestId: false,
    keySource: "runId",
    dataSchema: evtWorkflowUsageChangedDataSchema,
  },
  [lilacEventTypes.EvtWorkflowResultReady]: {
    type: lilacEventTypes.EvtWorkflowResultReady,
    topic: "evt.workflow",
    topicSchema: z.literal("evt.workflow"),
    resolveTopic: staticTopic("evt.workflow"),
    requiresRequestId: false,
    keySource: "runId",
    dataSchema: evtWorkflowResultReadyDataSchema,
  },
  [lilacEventTypes.CmdAgentCreate]: {
    type: lilacEventTypes.CmdAgentCreate,
    topic: "cmd.agent",
    topicSchema: z.literal("cmd.agent"),
    resolveTopic: staticTopic("cmd.agent"),
    requiresRequestId: false,
    keySource: "agentId",
    dataSchema: cmdAgentCreateDataSchema,
  },
  [lilacEventTypes.EvtAgentOutputDeltaReasoning]: {
    type: lilacEventTypes.EvtAgentOutputDeltaReasoning,
    topic: "out.req",
    topicSchema: outReqTopicSchema,
    resolveTopic: outReqTopic,
    requiresRequestId: true,
    keySource: "request_id",
    dataSchema: evtAgentOutputDeltaReasoningDataSchema,
  },
  [lilacEventTypes.EvtAgentOutputDeltaText]: {
    type: lilacEventTypes.EvtAgentOutputDeltaText,
    topic: "out.req",
    topicSchema: outReqTopicSchema,
    resolveTopic: outReqTopic,
    requiresRequestId: true,
    keySource: "request_id",
    dataSchema: evtAgentOutputDeltaTextDataSchema,
  },
  [lilacEventTypes.EvtAgentOutputTextReset]: {
    type: lilacEventTypes.EvtAgentOutputTextReset,
    topic: "out.req",
    topicSchema: outReqTopicSchema,
    resolveTopic: outReqTopic,
    requiresRequestId: true,
    keySource: "request_id",
    dataSchema: evtAgentOutputTextResetDataSchema,
  },
  [lilacEventTypes.EvtAgentOutputResponseText]: {
    type: lilacEventTypes.EvtAgentOutputResponseText,
    topic: "out.req",
    topicSchema: outReqTopicSchema,
    resolveTopic: outReqTopic,
    requiresRequestId: true,
    keySource: "request_id",
    dataSchema: evtAgentOutputResponseTextDataSchema,
  },
  [lilacEventTypes.EvtAgentOutputResponseBinary]: {
    type: lilacEventTypes.EvtAgentOutputResponseBinary,
    topic: "out.req",
    topicSchema: outReqTopicSchema,
    resolveTopic: outReqTopic,
    requiresRequestId: true,
    keySource: "request_id",
    dataSchema: evtAgentOutputResponseBinaryDataSchema,
  },
  [lilacEventTypes.EvtAgentOutputToolCall]: {
    type: lilacEventTypes.EvtAgentOutputToolCall,
    topic: "out.req",
    topicSchema: outReqTopicSchema,
    resolveTopic: outReqTopic,
    requiresRequestId: true,
    keySource: "request_id",
    dataSchema: evtAgentOutputToolCallDataSchema,
  },
  [lilacEventTypes.EvtAgentOutputActivity]: {
    type: lilacEventTypes.EvtAgentOutputActivity,
    topic: "out.req",
    topicSchema: outReqTopicSchema,
    resolveTopic: outReqTopic,
    requiresRequestId: true,
    keySource: "request_id",
    dataSchema: evtAgentOutputActivityDataSchema,
  },
} satisfies LilacEventCodecRegistry;

const envelopeSchema = z
  .strictObject({
    topic: nonemptyStringSchema,
    id: nonemptyStringSchema,
    type: nonemptyStringSchema,
    ts: finiteNumberSchema,
    key: z.unknown().optional(),
    headers: z.unknown().optional(),
    data: z.unknown(),
  })
  .superRefine((envelope, context) => {
    if (!Object.hasOwn(envelope, "data")) {
      context.addIssue({ code: "custom", path: ["data"], message: "Required" });
    }
  });
const headersSchema = z.record(z.string(), z.string());

export type LilacEventDecodeStage =
  | "envelope"
  | "event_type"
  | "headers"
  | "topic"
  | "key"
  | "payload";

export class LilacEventDecodeError extends TaggedError("LilacEventDecodeError")<{
  readonly stage: LilacEventDecodeStage;
  readonly eventType?: string;
  readonly issues: readonly string[];
  readonly message: string;
}> {}

function formatIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => {
    const location = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    return `${location}: ${issue.message}`;
  });
}

function decodeSchema<T>(options: {
  readonly schema: z.ZodType<T>;
  readonly value: unknown;
  readonly stage: LilacEventDecodeStage;
  readonly eventType?: string;
}): ResultType<T, LilacEventDecodeError> {
  let parsed: z.ZodSafeParseResult<T>;
  try {
    parsed = options.schema.safeParse(options.value);
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new LilacEventDecodeError({
        stage: options.stage,
        eventType: options.eventType,
        issues: [cause instanceof Error ? cause.message : "Decoder failed"],
        message: `Invalid Lilac event ${options.stage}`,
      }),
    );
  }
  if (parsed.success) return Result.ok(parsed.data);
  return Result.err(
    new LilacEventDecodeError({
      stage: options.stage,
      eventType: options.eventType,
      issues: formatIssues(parsed.error),
      message: `Invalid Lilac event ${options.stage}`,
    }),
  );
}

function decodeKnownMessage<TType extends LilacEventType>(
  codec: LilacEventCodec<TType>,
  envelope: z.output<typeof envelopeSchema>,
): ResultType<DecodedLilacMessageOf<TType>, LilacEventDecodeError> {
  const eventType = codec.type;
  const headersResult = decodeSchema({
    schema: headersSchema,
    value: envelope.headers ?? {},
    stage: "headers",
    eventType,
  });
  if (headersResult.status === "error") return Result.err(headersResult.error);
  const headers = headersResult.value;

  const requestId = headers["request_id"];
  if (codec.requiresRequestId && !requestId) {
    return Result.err(
      new LilacEventDecodeError({
        stage: "headers",
        eventType,
        issues: ["request_id: Required non-empty request ID header"],
        message: "Invalid Lilac event headers",
      }),
    );
  }
  if (requestId !== undefined && requestId.length === 0) {
    return Result.err(
      new LilacEventDecodeError({
        stage: "headers",
        eventType,
        issues: ["request_id: Request ID must not be empty"],
        message: "Invalid Lilac event headers",
      }),
    );
  }
  if (headers["session_id"] !== undefined && headers["session_id"].length === 0) {
    return Result.err(
      new LilacEventDecodeError({
        stage: "headers",
        eventType,
        issues: ["session_id: Session ID must not be empty"],
        message: "Invalid Lilac event headers",
      }),
    );
  }
  const requestClient = headers["request_client"];
  if (requestClient !== undefined && !adapterPlatformSchema.safeParse(requestClient).success) {
    return Result.err(
      new LilacEventDecodeError({
        stage: "headers",
        eventType,
        issues: ["request_client: Unknown adapter platform"],
        message: "Invalid Lilac event headers",
      }),
    );
  }

  const topicResult = decodeSchema({
    schema: codec.topicSchema,
    value: envelope.topic,
    stage: "topic",
    eventType,
  });
  if (topicResult.status === "error") return Result.err(topicResult.error);

  const dataResult = decodeSchema({
    schema: codec.dataSchema,
    value: envelope.data,
    stage: "payload",
    eventType,
  });
  if (dataResult.status === "error") return Result.err(dataResult.error);
  const keyResult = decodeSchema({
    schema: nonemptyStringSchema,
    value: envelope.key,
    stage: "key",
    eventType,
  });
  if (keyResult.status === "error") return Result.err(keyResult.error);

  const decoded: DecodedLilacMessageOf<TType> = {
    topic: topicResult.value,
    id: envelope.id,
    type: eventType,
    ts: envelope.ts,
    key: keyResult.value,
    ...(envelope.headers === undefined ? {} : { headers }),
    data: dataResult.value,
  };
  return Result.ok(decoded);
}

/** Decode and validate a complete Lilac message received from a raw bus boundary. */
export function decodeLilacMessage(
  message: Message<unknown>,
): ResultType<DecodedLilacMessage, LilacEventDecodeError> {
  const envelopeResult = decodeSchema({
    schema: envelopeSchema,
    value: message,
    stage: "envelope",
  });
  if (envelopeResult.status === "error") return Result.err(envelopeResult.error);
  const envelope = envelopeResult.value;

  switch (envelope.type) {
    case lilacEventTypes.CmdRequestMessage:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.CmdSurfaceOutputReanchor:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtAdapterMessageCreated:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtAdapterMessageUpdated:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtAdapterMessageDeleted:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtAdapterReactionAdded:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtAdapterReactionRemoved:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtAdapterActionInvoked:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtWorkflowWaitResolverBarrier:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtRequestLifecycleChanged:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtRequestReply:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtSurfaceOutputMessageCreated:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtWorkflowRunChanged:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtWorkflowOperationChanged:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtWorkflowProgressRequested:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtWorkflowUsageChanged:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtWorkflowResultReady:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.CmdAgentCreate:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtAgentOutputDeltaReasoning:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtAgentOutputDeltaText:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtAgentOutputTextReset:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtAgentOutputResponseText:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtAgentOutputResponseBinary:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtAgentOutputToolCall:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    case lilacEventTypes.EvtAgentOutputActivity:
      return decodeKnownMessage(lilacEventCodecRegistry[envelope.type], envelope);
    default:
      return Result.err(
        new LilacEventDecodeError({
          stage: "event_type",
          eventType: envelope.type,
          issues: [`type: Unknown Lilac event type ${JSON.stringify(envelope.type)}`],
          message: "Unknown Lilac event type",
        }),
      );
  }
}

/** Decode a message and prove that it belongs to the requested topic contract. */
export function decodeLilacMessageForTopic<TTopic extends LilacTopic>(
  message: Message<unknown>,
  topic: TTopic,
): ResultType<DecodedLilacMessage<LilacEventTypesForTopic<TTopic>>, LilacEventDecodeError> {
  const decoded = decodeLilacMessage(message);
  if (decoded.status === "error") return Result.err(decoded.error);
  if (!isDecodedLilacMessageForTopic(decoded.value, topic)) {
    return Result.err(
      new LilacEventDecodeError({
        stage: "topic",
        eventType: decoded.value.type,
        issues: [`topic: Expected subscribed topic ${JSON.stringify(topic)}`],
        message: "Lilac event does not belong to the subscribed topic",
      }),
    );
  }

  return Result.ok(decoded.value);
}

function isDecodedLilacMessageForTopic<TTopic extends LilacTopic>(
  message: DecodedLilacMessage,
  topic: TTopic,
): message is DecodedLilacMessage<LilacEventTypesForTopic<TTopic>> {
  return message.topic === topic;
}
