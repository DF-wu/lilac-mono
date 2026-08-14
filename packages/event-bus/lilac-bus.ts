import {
  Err,
  Ok,
  Panic,
  Result,
  TaggedError,
  type AnyTaggedError,
  type Result as ResultType,
} from "better-result";
import { formatTaggedErrorForLog } from "@stanley2058/lilac-utils";

import type { RawBus } from "./raw-bus";
import type { Cursor, FetchOptions, RedisMessageDecodeFailure, SubscriptionOptions } from "./types";
import {
  createContractInvalidDeadLetterReason,
  createHandlerErrorDeadLetterReason,
  redisDecodeIssuesForDeadLetter,
} from "./event-dead-letter";
import type { RedisEventDeadLetter } from "./redis-event-dead-letter";
import {
  applyEventDeliveryPolicy,
  EventBusCloseFailed,
  EventContractInvalid,
  type EventDeliveryDoneError,
  EventDeliveryStartFailed,
  type EventDeliveryStopFailed,
  EventFetchContractInvalid,
  EventFetchTransportFailed,
  EventPublishContractInvalid,
  EventPublishTransportFailed,
  EventTopicOperationFailed,
  EventTopicOperationUnsupported,
  type DeliveryDisposition,
  type EventDeliveryContext,
  type EventDeliveryFatalReporter,
  type EventDeliveryLogger,
  type RawDeliveryAction,
} from "./event-delivery";
import {
  decodeLilacMessageForTopic,
  lilacEventCodecRegistry,
  type DecodedLilacMessage,
  type LilacEventDecodeError,
} from "./lilac-codecs";
import {
  lilacEventTypes,
  type AdapterPlatform,
  type LilacDataForType,
  type LilacEventType,
  type LilacEventTypesForTopic,
  type LilacTopic,
  type LilacTopicForType,
} from "./lilac-spec";

/**
 * Canonical request-scoped envelope headers.
 *
 * These are optional at the type level because adapter ingestion events may not
 * be tied to a request. For request/workflow/output events, publishers should
 * treat missing `request_id` as an error.
 */
export type LilacEnvelopeHeaders = {
  request_id?: string;
  session_id?: string;
  request_client?: AdapterPlatform;
};

/** Discriminated union of all events that may appear on `TTopic`. */
export type LilacMessageForTopic<TTopic extends LilacTopic> = DecodedLilacMessage<
  LilacEventTypesForTopic<TTopic>
>;

export type DecodedLilacMessageForTopic<TTopic extends LilacTopic> = DecodedLilacMessage<
  LilacEventTypesForTopic<TTopic>
>;

export type CreateLilacBusOptions = {
  readonly deadLetter?: RedisEventDeadLetter;
  readonly logger?: EventDeliveryLogger;
  readonly reportFatal?: EventDeliveryFatalReporter;
};

const KNOWN_EVENT_TYPES = new Set<string>(Object.values(lilacEventTypes));

function requireRequestId(
  headers: LilacEnvelopeHeaders | undefined,
  eventType: LilacEventType,
): ResultType<string, EventPublishContractInvalid> {
  const requestId = headers?.request_id;
  if (!requestId) {
    return Result.err(
      new EventPublishContractInvalid({
        eventType,
        message: `publish(${eventType}) requires headers.request_id`,
      }),
    );
  }
  return Result.ok(requestId);
}

function getTopicForType<TType extends LilacEventType>(
  type: TType,
  headers: LilacEnvelopeHeaders | undefined,
): ResultType<LilacTopicForType<TType>, EventPublishContractInvalid> {
  const codec = lilacEventCodecRegistry[type];
  if (!codec.requiresRequestId) return Result.ok(codec.resolveTopic(""));
  const requestId = requireRequestId(headers, type);
  if (requestId.status === "error") return Result.err(requestId.error);
  return Result.ok(codec.resolveTopic(requestId.value));
}

function getKeyForType<TType extends LilacEventType>(
  type: TType,
  headers: LilacEnvelopeHeaders | undefined,
  data: LilacDataForType<TType>,
): ResultType<string | undefined, EventPublishContractInvalid> {
  const keySource = lilacEventCodecRegistry[type].keySource;
  if (keySource === "request_id") {
    const requestId = requireRequestId(headers, type);
    if (requestId.status === "error") return Result.err(requestId.error);
    return Result.ok(requestId.value);
  }
  const key: unknown = Reflect.get(data, keySource);
  return Result.ok(typeof key === "string" ? key : undefined);
}

function normalizeTransportInvalid(failure: RedisMessageDecodeFailure): EventContractInvalid {
  return new EventContractInvalid({
    source: "transport",
    stage: "transport",
    issues: redisDecodeIssuesForDeadLetter(failure.error.issues),
    message: "Invalid event transport envelope",
  });
}

function normalizeContractInvalid(error: LilacEventDecodeError): EventContractInvalid {
  return new EventContractInvalid({
    source: "contract",
    stage: error.stage,
    eventType: error.eventType,
    issues: error.issues,
    message: "Invalid Lilac event contract",
  });
}

function logContractInvalid(
  logger: EventDeliveryLogger | undefined,
  topic: LilacTopic,
  cursor: Cursor,
  error: EventContractInvalid,
): void {
  let eventType: string | undefined;
  if (error.eventType !== undefined) {
    eventType = KNOWN_EVENT_TYPES.has(error.eventType) ? error.eventType : "<unknown>";
  }
  logger?.warn("event_bus.contract_invalid", {
    topic,
    cursor,
    source: error.source,
    stage: error.stage,
    eventType,
  });
}

function checkedDisposition(value: DeliveryDisposition): DeliveryDisposition {
  switch (value) {
    case "commit":
    case "retry":
    case "park-pending":
    case "dead-letter":
    case "stop":
      return value;
    default: {
      const unhandled: never = value;
      throw new Panic({
        message: `Event delivery policy returned an unknown disposition: ${String(unhandled)}`,
      });
    }
  }
}

function checkedHandlerResult<TError extends AnyTaggedError>(
  value: ResultType<void, TError>,
): ResultType<void, TError> {
  if (value instanceof Ok && Object.getPrototypeOf(value) === Ok.prototype) {
    const status = Object.getOwnPropertyDescriptor(value, "status");
    const payload = Object.getOwnPropertyDescriptor(value, "value");
    if (
      status === undefined ||
      !("value" in status) ||
      status.value !== "ok" ||
      payload === undefined ||
      !("value" in payload) ||
      payload.value !== undefined
    ) {
      throw new Panic({ message: "Event handler returned an incomplete Ok<void> Result" });
    }
    return value;
  }

  if (value instanceof Err && Object.getPrototypeOf(value) === Err.prototype) {
    const status = Object.getOwnPropertyDescriptor(value, "status");
    const error = Object.getOwnPropertyDescriptor(value, "error");
    if (
      status === undefined ||
      !("value" in status) ||
      status.value !== "error" ||
      error === undefined ||
      !("value" in error) ||
      Panic.is(error.value) ||
      !TaggedError.is(error.value) ||
      !Object.hasOwn(error.value, "_tag") ||
      !Object.hasOwn(error.value, "name") ||
      !Object.hasOwn(error.value, "message") ||
      typeof error.value._tag !== "string" ||
      typeof error.value.name !== "string" ||
      typeof error.value.message !== "string"
    ) {
      throw new Panic({ message: "Event handler returned an incomplete Err Result" });
    }
    return value;
  }

  throw new Panic({ message: "Event handler returned a forged or malformed Result" });
}

/**
 * Typed bus API for the Lilac monorepo.
 *
 * This enforces event payload types based on `lilacEventTypes`.
 */
export interface LilacBus {
  /** Publish a typed event and return its id/cursor. */
  publish<TType extends LilacEventType>(
    type: TType,
    data: LilacDataForType<TType>,
    options?: {
      /** Optional metadata (string->string). */
      headers?: Record<string, string> & Partial<LilacEnvelopeHeaders>;
      /** Override the default routing topic (advanced). */
      topic?: LilacTopicForType<TType>;
      /** Override the default correlation key (advanced). */
      key?: string;
    },
  ): Promise<
    ResultType<
      { id: string; cursor: Cursor; topic: LilacTopicForType<TType> },
      EventPublishContractInvalid | EventPublishTransportFailed
    >
  >;

  subscribeTopic<TTopic extends LilacTopic, TError extends AnyTaggedError>(
    topic: TTopic,
    opts: SubscriptionOptions,
    handler: (
      msg: DecodedLilacMessageForTopic<TTopic>,
      ctx: EventDeliveryContext,
    ) => Promise<ResultType<void, TError>>,
    deliveryPolicy: (error: TError) => DeliveryDisposition,
  ): Promise<
    ResultType<
      {
        readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
        stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
      },
      EventDeliveryStartFailed
    >
  >;

  /** Fetch and decode a complete batch without exposing invalid entries as typed messages. */
  fetchTopic<TTopic extends LilacTopic>(
    topic: TTopic,
    opts: FetchOptions,
  ): Promise<
    ResultType<
      {
        messages: Array<{ msg: DecodedLilacMessageForTopic<TTopic>; cursor: Cursor }>;
        next?: Cursor;
      },
      EventFetchContractInvalid | EventFetchTransportFailed
    >
  >;

  /** Return the latest durable cursor currently present on a topic. */
  getTopicWatermark(
    topic: LilacTopic,
  ): Promise<ResultType<Cursor | null, EventTopicOperationUnsupported | EventTopicOperationFailed>>;

  /** Reclaim a processed prefix while retaining a safety margin behind all durable frontiers. */
  trimTopicBeforeCheckpoint(
    topic: LilacTopic,
    checkpoint: Cursor,
    safetyMargin: number,
  ): Promise<ResultType<number, EventTopicOperationUnsupported | EventTopicOperationFailed>>;

  /** Remove a retired durable consumer group after checking for registered old-version consumers. */
  retireTopicConsumerGroup(
    topic: LilacTopic,
    group: string,
    confirmSingleVersionRollout?: boolean,
  ): Promise<
    ResultType<"absent" | "destroyed", EventTopicOperationUnsupported | EventTopicOperationFailed>
  >;

  /** Close the underlying transport. */
  close(): Promise<ResultType<void, EventBusCloseFailed>>;
}

/** Wrap a `RawBus` with the Lilac typed event spec. */
export function createLilacBus(raw: RawBus, options: CreateLilacBusOptions = {}): LilacBus {
  const bus: LilacBus = {
    publish: async <TType extends LilacEventType>(
      type: TType,
      data: LilacDataForType<TType>,
      options?: {
        headers?: Record<string, string> & Partial<LilacEnvelopeHeaders>;
        topic?: LilacTopicForType<TType>;
        key?: string;
      },
    ) => {
      let topic = options?.topic;
      if (topic === undefined) {
        const resolvedTopic = getTopicForType(type, options?.headers);
        if (resolvedTopic.status === "error") return Result.err(resolvedTopic.error);
        topic = resolvedTopic.value;
      }
      let key = options?.key;
      if (key === undefined) {
        const resolvedKey = getKeyForType(type, options?.headers, data);
        if (resolvedKey.status === "error") return Result.err(resolvedKey.error);
        key = resolvedKey.value;
      }

      let res: Awaited<ReturnType<RawBus["publish"]>>;
      try {
        res = await raw.publish(
          {
            topic,
            type,
            key,
            headers: options?.headers,
            data,
          },
          {
            topic,
            type,
            key,
            headers: options?.headers,
          },
        );
      } catch (cause) {
        if (Panic.is(cause)) throw cause;
        return Result.err(
          new EventPublishTransportFailed({
            cause,
            eventType: type,
            topic,
            message: "Event publish failed",
          }),
        );
      }

      return Result.ok({ ...res, topic });
    },

    subscribeTopic: async <TTopic extends LilacTopic, TError extends AnyTaggedError>(
      topic: TTopic,
      opts: SubscriptionOptions,
      handler: (
        msg: DecodedLilacMessageForTopic<TTopic>,
        ctx: EventDeliveryContext,
      ) => Promise<ResultType<void, TError>>,
      deliveryPolicy: (error: TError) => DeliveryDisposition,
    ) => {
      if (typeof raw.subscribe !== "function") {
        return Result.err(
          new EventDeliveryStartFailed({
            cause: undefined,
            topic,
            message: "The configured raw bus does not implement subscribe",
          }),
        );
      }
      return await raw.subscribe(
        topic,
        opts,
        async (message, context): Promise<RawDeliveryAction> => {
          let contractError: EventContractInvalid | undefined;
          let eventType: string | undefined;
          if ("_tag" in message) {
            contractError = normalizeTransportInvalid(message);
          } else {
            eventType = message.type;
            const decoded = decodeLilacMessageForTopic(message, topic);
            if (decoded.status === "error") {
              contractError = normalizeContractInvalid(decoded.error);
            } else {
              const handled = checkedHandlerResult(await handler(decoded.value, context));
              if (handled.status === "ok") return { disposition: "commit" };

              const disposition = checkedDisposition(deliveryPolicy(handled.error));
              const formatted = formatTaggedErrorForLog(handled.error);
              if (disposition === "retry") {
                return {
                  disposition,
                  failure: createHandlerErrorDeadLetterReason({
                    errorTag: formatted.errorTag,
                    errorMessage: formatted.errorMessage,
                  }),
                };
              }
              if (disposition !== "dead-letter") return { disposition };
              return {
                disposition,
                reason: createHandlerErrorDeadLetterReason({
                  errorTag: formatted.errorTag,
                  errorMessage: formatted.errorMessage,
                }),
              };
            }
          }

          logContractInvalid(options.logger, topic, context.cursor, contractError);
          const disposition = applyEventDeliveryPolicy(contractError);
          if (disposition === "retry") {
            throw new Panic({
              message: "Package event delivery policy cannot retry without a failure",
            });
          }
          if (disposition !== "dead-letter") return { disposition };
          return {
            disposition,
            reason: createContractInvalidDeadLetterReason({
              stage: contractError.stage,
              eventType: contractError.eventType ?? eventType,
              issues: contractError.issues,
            }),
          };
        },
        {
          deadLetter: options.deadLetter,
          logger: options.logger,
          reportFatal: options.reportFatal,
        },
      );
    },

    fetchTopic: async <TTopic extends LilacTopic>(topic: TTopic, opts: FetchOptions) => {
      let fetched: Awaited<ReturnType<RawBus["fetch"]>>;
      try {
        fetched = await raw.fetch(topic, opts);
      } catch (cause) {
        if (Panic.is(cause)) throw cause;
        return Result.err(
          new EventFetchTransportFailed({
            cause,
            topic,
            message: "Event topic fetch failed",
          }),
        );
      }

      const messages: Array<{
        msg: DecodedLilacMessageForTopic<TTopic>;
        cursor: Cursor;
      }> = [];
      for (const entry of fetched.messages) {
        let contractError: EventContractInvalid;
        if ("_tag" in entry.msg) {
          contractError = normalizeTransportInvalid(entry.msg);
        } else {
          const decoded = decodeLilacMessageForTopic(entry.msg, topic);
          if (decoded.status === "ok") {
            messages.push({ msg: decoded.value, cursor: entry.cursor });
            continue;
          }
          contractError = normalizeContractInvalid(decoded.error);
        }
        logContractInvalid(options.logger, topic, entry.cursor, contractError);
        return Result.err(
          new EventFetchContractInvalid({
            topic,
            cursor: entry.cursor,
            contractError,
            evidence: entry.evidence,
            message: "Fetched event failed its contract",
          }),
        );
      }
      return Result.ok({ messages, next: fetched.next });
    },

    getTopicWatermark: async (topic) => {
      if (!raw.watermark) {
        return Result.err(
          new EventTopicOperationUnsupported({
            operation: "watermark",
            topic,
            message: "The configured event bus does not expose durable topic watermarks",
          }),
        );
      }
      try {
        return Result.ok(await raw.watermark(topic));
      } catch (cause) {
        if (Panic.is(cause)) throw cause;
        return Result.err(
          new EventTopicOperationFailed({
            cause,
            operation: "watermark",
            topic,
            message: "Event topic watermark read failed",
          }),
        );
      }
    },

    trimTopicBeforeCheckpoint: async (topic, checkpoint, safetyMargin) => {
      if (!raw.trimBeforeCheckpoint) {
        return Result.err(
          new EventTopicOperationUnsupported({
            operation: "trim",
            topic,
            message: "The configured event bus does not expose checkpoint trimming",
          }),
        );
      }
      try {
        return Result.ok(await raw.trimBeforeCheckpoint(topic, checkpoint, safetyMargin));
      } catch (cause) {
        if (Panic.is(cause)) throw cause;
        return Result.err(
          new EventTopicOperationFailed({
            cause,
            operation: "trim",
            topic,
            message: "Event topic checkpoint trim failed",
          }),
        );
      }
    },

    retireTopicConsumerGroup: async (topic, group, confirmSingleVersionRollout = false) => {
      if (!raw.retireConsumerGroup) {
        return Result.err(
          new EventTopicOperationUnsupported({
            operation: "retire-consumer-group",
            topic,
            message: "The configured event bus does not expose consumer-group retirement",
          }),
        );
      }
      try {
        return Result.ok(await raw.retireConsumerGroup(topic, group, confirmSingleVersionRollout));
      } catch (cause) {
        if (Panic.is(cause)) throw cause;
        return Result.err(
          new EventTopicOperationFailed({
            cause,
            operation: "retire-consumer-group",
            topic,
            message: "Event topic consumer-group retirement failed",
          }),
        );
      }
    },

    close: async () => {
      try {
        await raw.close();
        return Result.ok(undefined);
      } catch (cause) {
        if (Panic.is(cause)) throw cause;
        return Result.err(
          new EventBusCloseFailed({
            cause,
            message: "Event bus close failed",
          }),
        );
      }
    },
  };

  return bus;
}
