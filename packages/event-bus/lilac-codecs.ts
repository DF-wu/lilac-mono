import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import {
  createLilacEventCodecRegistry,
  type LilacEventDefinitionForType,
} from "./define-lilac-events";
import {
  adapterPlatformSchema,
  LILAC_EVENTS,
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

type CatalogDefinitionForType<TType extends LilacEventType> = LilacEventDefinitionForType<
  typeof LILAC_EVENTS,
  TType
>;

type RequiresRequestId<TType extends LilacEventType> =
  CatalogDefinitionForType<TType>["topic"] extends { readonly kind: "request-output" }
    ? true
    : CatalogDefinitionForType<TType>["key"] extends { readonly kind: "header" }
      ? true
      : false;

export type LilacEventCodec<TType extends LilacEventType> = {
  readonly type: TType;
  readonly topic: CatalogDefinitionForType<TType>["topic"]["topic"];
  readonly topicSchema: z.ZodType<LilacTopicForType<TType>>;
  readonly resolveTopic: (requestId: string) => LilacTopicForType<TType>;
  readonly requiresRequestId: RequiresRequestId<TType>;
  readonly keySource: CatalogDefinitionForType<TType>["key"]["source"];
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

export const lilacEventCodecRegistry: LilacEventCodecRegistry =
  createLilacEventCodecRegistry(LILAC_EVENTS);

type AnyLilacEventCodec = LilacEventCodecRegistry[LilacEventType];

const lilacEventCodecsByType = new Map<string, AnyLilacEventCodec>();
for (const codec of Object.values(lilacEventCodecRegistry)) {
  lilacEventCodecsByType.set(codec.type, codec);
}

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

function decodeKnownMessage(
  codec: AnyLilacEventCodec,
  envelope: z.output<typeof envelopeSchema>,
): ResultType<DecodedLilacMessage, LilacEventDecodeError> {
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
    schema: codec.topicSchema as z.ZodType<LilacTopic>,
    value: envelope.topic,
    stage: "topic",
    eventType,
  });
  if (topicResult.status === "error") return Result.err(topicResult.error);

  const dataResult = decodeSchema({
    schema: codec.dataSchema as z.ZodType<LilacDataForType<LilacEventType>>,
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

  const decoded = {
    topic: topicResult.value,
    id: envelope.id,
    type: eventType,
    ts: envelope.ts,
    key: keyResult.value,
    ...(envelope.headers === undefined ? {} : { headers }),
    data: dataResult.value,
  };

  // The Map key, type, topic schema, and data schema all come from one catalog entry.
  // TypeScript cannot retain that correlation after a runtime Map lookup.
  return Result.ok(decoded as DecodedLilacMessage);
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

  const codec = lilacEventCodecsByType.get(envelope.type);
  if (codec !== undefined) return decodeKnownMessage(codec, envelope);

  return Result.err(
    new LilacEventDecodeError({
      stage: "event_type",
      eventType: envelope.type,
      issues: [`type: Unknown Lilac event type ${JSON.stringify(envelope.type)}`],
      message: "Unknown Lilac event type",
    }),
  );
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
