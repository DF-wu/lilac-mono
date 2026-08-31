import { TaggedError } from "better-result";

import type {
  EventDeadLetterHandlerFailure,
  EventDeadLetterReason,
  EventTransportEvidence,
} from "./event-dead-letter";
import type { RedisEventDeadLetter } from "./redis-event-dead-letter";
import type { Cursor, Mode, RawMessageDecodeOutcome } from "./types";

export type DeliveryDisposition = "commit" | "retry" | "park-pending" | "dead-letter" | "stop";

export class EventContractInvalid extends TaggedError("EventContractInvalid")<{
  readonly source: "transport" | "contract";
  readonly stage: "transport" | "envelope" | "event_type" | "headers" | "topic" | "key" | "payload";
  readonly eventType?: string;
  readonly issues: readonly string[];
  readonly message: string;
}> {}

export class EventHandlerFailed extends TaggedError("EventHandlerFailed")<{
  readonly message: string;
}> {}

export class EventDeadLetterFailed extends TaggedError("EventDeadLetterFailed")<{
  readonly message: string;
}> {}

export type EventDeliveryError = EventContractInvalid | EventHandlerFailed | EventDeadLetterFailed;

export class EventPublishContractInvalid extends TaggedError("EventPublishContractInvalid")<{
  readonly eventType: string;
  readonly message: string;
}> {}

export class EventPublishTransportFailed extends TaggedError("EventPublishTransportFailed")<{
  readonly cause: unknown;
  readonly eventType: string;
  readonly topic: string;
  readonly message: string;
}> {}

export class EventTopicOperationUnsupported extends TaggedError("EventTopicOperationUnsupported")<{
  readonly operation: "watermark" | "trim" | "retire-consumer-group";
  readonly topic: string;
  readonly message: string;
}> {}

export class EventTopicOperationFailed extends TaggedError("EventTopicOperationFailed")<{
  readonly cause: unknown;
  readonly operation: "watermark" | "trim" | "retire-consumer-group";
  readonly topic: string;
  readonly message: string;
}> {}

export class EventBusCloseFailed extends TaggedError("EventBusCloseFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

/** Default delivery policy for package-owned delivery failures. */
export function applyEventDeliveryPolicy(error: EventDeliveryError): DeliveryDisposition {
  switch (error._tag) {
    case "EventContractInvalid":
      return "dead-letter";
    case "EventHandlerFailed":
    case "EventDeadLetterFailed":
      return "park-pending";
  }
}

export type EventDeliveryContext =
  | {
      readonly cursor: Cursor;
      readonly mode: "work" | "fanout";
      readonly evidence: EventTransportEvidence;
      readonly deliveryId: string;
      readonly attempt: 1 | 2 | 3 | 4 | 5;
      readonly leaseDeadline: number;
      readonly signal: AbortSignal;
    }
  | {
      readonly cursor: Cursor;
      readonly mode: Extract<Mode, "tail">;
      readonly evidence: EventTransportEvidence;
    };

export type RawDeliveryAction =
  | {
      readonly disposition: "commit";
      readonly observePostCommit?: () => Promise<
        import("better-result").Result<void, EventPostCommitObservationFailed>
      >;
    }
  | { readonly disposition: "park-pending" | "stop" }
  | {
      readonly disposition: "retry";
      readonly failure: EventDeadLetterHandlerFailure;
    }
  | {
      readonly disposition: "dead-letter";
      readonly reason: EventDeadLetterReason;
    };

export type RawDeliveryHandler = (
  message: RawMessageDecodeOutcome,
  context: EventDeliveryContext,
) => Promise<RawDeliveryAction>;

export type EventDeliveryLogContext = Readonly<
  Record<string, string | number | boolean | undefined>
>;

export interface EventDeliveryLogger {
  warn(event: string, context: EventDeliveryLogContext): void;
  error(event: string, context: EventDeliveryLogContext): void;
}

export interface EventDeliveryFatalReporter {
  report(
    cause: unknown,
    context: {
      readonly topic: string;
      readonly cursor?: Cursor;
      readonly phase: "handler" | "dead-letter" | "delivery-action";
    },
  ): void | Promise<void>;
}

export type RawDeliveryDependencies = {
  readonly deadLetter?: RedisEventDeadLetter;
  readonly logger?: EventDeliveryLogger;
  readonly reportFatal?: EventDeliveryFatalReporter;
};

export class EventDeliveryStartFailed extends TaggedError("EventDeliveryStartFailed")<{
  readonly cause: unknown;
  readonly topic: string;
  readonly message: string;
}> {}

export class EventDeliveryTransportFailed extends TaggedError("EventDeliveryTransportFailed")<{
  readonly cause: unknown;
  readonly operation: "read" | "ack" | "cleanup";
  readonly topic: string;
  readonly cursor?: Cursor;
  readonly message: string;
}> {}

export class EventPostCommitObservationFailed extends TaggedError(
  "EventPostCommitObservationFailed",
)<{
  readonly cause: unknown;
  readonly topic: string;
  readonly cursor: Cursor;
  readonly message: string;
}> {}

export class EventDeliveryStopped extends TaggedError("EventDeliveryStopped")<{
  readonly reason: "requested" | "tail-cannot-park" | "dead-letter-failed";
  readonly topic: string;
  readonly cursor: Cursor;
  readonly message: string;
}> {}

export class EventDeliveryStopFailed extends TaggedError("EventDeliveryStopFailed")<{
  readonly cause: unknown;
  readonly topic: string;
  readonly message: string;
}> {}

export type EventDeliveryDoneError =
  | EventDeliveryTransportFailed
  | EventPostCommitObservationFailed
  | EventDeliveryStopped;

export class EventRequestPublicationConfirmationFailed extends TaggedError(
  "EventRequestPublicationConfirmationFailed",
)<{
  readonly cause: unknown;
  readonly requestDeliveryId: string;
  readonly expectedStreamId: string;
  readonly message: string;
}> {}

export class EventRequestPublicationConfirmationUnsupported extends TaggedError(
  "EventRequestPublicationConfirmationUnsupported",
)<{
  readonly message: string;
}> {}

export class EventRequestPublicationClaimFailed extends TaggedError(
  "EventRequestPublicationClaimFailed",
)<{
  readonly cause: unknown;
  readonly operation: "abandon" | "acquire";
  readonly requestDeliveryId: string;
  readonly message: string;
}> {}

export class EventRequestPublicationClaimUnsupported extends TaggedError(
  "EventRequestPublicationClaimUnsupported",
)<{
  readonly operation: "abandon" | "acquire" | "publish";
  readonly message: string;
}> {}

export class EventRequestPublicationClaimFenced extends TaggedError(
  "EventRequestPublicationClaimFenced",
)<{
  readonly requestDeliveryId: string;
  readonly message: string;
}> {}

export class EventOutputStreamExpiryUnavailable extends TaggedError(
  "EventOutputStreamExpiryUnavailable",
)<{
  readonly reason: "unsupported" | "transport-unavailable" | "expiry-uncertain";
  readonly requestId: string;
  readonly topic: string;
  readonly message: string;
}> {}

export class EventFetchTransportFailed extends TaggedError("EventFetchTransportFailed")<{
  readonly cause: unknown;
  readonly topic: string;
  readonly message: string;
}> {}

export class EventFetchContractInvalid extends TaggedError("EventFetchContractInvalid")<{
  readonly topic: string;
  readonly cursor: Cursor;
  readonly contractError: EventContractInvalid;
  readonly evidence?: EventTransportEvidence;
  readonly message: string;
}> {}
