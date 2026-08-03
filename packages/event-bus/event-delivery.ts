import { TaggedError } from "better-result";

import type {
  EventDeadLetter,
  EventDeadLetterRecordV1,
  EventTransportEvidence,
} from "./event-dead-letter";
import type { Cursor, Mode, RawMessageDecodeOutcome } from "./types";

export type DeliveryDisposition = "commit" | "park-pending" | "dead-letter" | "stop";

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

export type EventDeliveryContext = {
  readonly cursor: Cursor;
  readonly mode: Mode;
  readonly evidence: EventTransportEvidence;
};

export type RawDeliveryAction =
  | { readonly disposition: "commit" | "park-pending" | "stop" }
  | { readonly disposition: "dead-letter"; readonly record: EventDeadLetterRecordV1 };

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
  readonly deadLetter?: EventDeadLetter;
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

export type EventDeliveryDoneError = EventDeliveryTransportFailed | EventDeliveryStopped;

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
