import { Err, Ok, Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import type { RedisMessageDecodeIssue, RedisWireValueEvidence, Topic } from "./types";

export const EVENT_DEAD_LETTER_VERSION = 1 as const;

export type RedisEvidenceSource = {
  readonly transport: "redis-streams";
  readonly streamKey: string;
  readonly topic: Topic;
  readonly messageId: string;
};

export type EventTransportEvidence = {
  readonly source: RedisEvidenceSource;
  readonly wire:
    | {
        readonly kind: "bounded-complete";
        readonly fields: readonly string[];
      }
    | {
        readonly kind: "controlled-reference";
        readonly locator:
          | {
              readonly kind: "redis-stream-entry";
              readonly streamKey: string;
              readonly messageId: string;
            }
          | {
              readonly kind: "redis-key";
              readonly key: string;
              readonly expiresAt: number;
            };
        readonly preview: {
          readonly fields: readonly RedisWireValueEvidence[];
          readonly omittedValueCount: number;
        };
      };
};

export type EventDeadLetterReasonV1 =
  | {
      readonly kind: "contract-invalid";
      readonly diagnostic: "event_bus.contract_invalid";
      readonly stage:
        | "transport"
        | "envelope"
        | "event_type"
        | "headers"
        | "topic"
        | "key"
        | "payload";
      readonly eventType?: string;
      readonly issues: readonly string[];
    }
  | {
      readonly kind: "handler-error";
      readonly errorTag: string;
      readonly errorMessage: string;
    };

export type EventDeadLetterRecordV1 = {
  readonly version: typeof EVENT_DEAD_LETTER_VERSION;
  readonly deadLetterId: string;
  readonly recordedAt: number;
  readonly source: {
    readonly topic: Topic;
    readonly cursor: string;
    readonly messageId: string;
    readonly mode: "work" | "fanout" | "tail";
  };
  readonly reason: EventDeadLetterReasonV1;
  readonly evidence: EventTransportEvidence;
};

export class EventDeadLetterAcceptFailed extends TaggedError("EventDeadLetterAcceptFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export type EventDeadLetterAcceptance = {
  readonly id: string;
};

export interface EventDeadLetter {
  accept(
    record: EventDeadLetterRecordV1,
  ): Promise<ResultType<EventDeadLetterAcceptance, EventDeadLetterAcceptFailed>>;
}

function hasOwnDataProperty<TExpected>(
  value: object,
  property: string,
  expected: TExpected,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  return descriptor !== undefined && "value" in descriptor && descriptor.value === expected;
}

function isCompleteAcceptFailed(value: EventDeadLetterAcceptFailed): boolean {
  return (
    TaggedError.is(value) &&
    Object.hasOwn(value, "_tag") &&
    Object.hasOwn(value, "name") &&
    Object.hasOwn(value, "message") &&
    Object.hasOwn(value, "cause") &&
    typeof value._tag === "string" &&
    typeof value.name === "string" &&
    typeof value.message === "string"
  );
}

/** Validate the nominal Result and receipt returned by a dead-letter adapter. */
export function checkedDeadLetterAcceptance(
  value: ResultType<EventDeadLetterAcceptance, EventDeadLetterAcceptFailed>,
): ResultType<EventDeadLetterAcceptance, EventDeadLetterAcceptFailed> {
  if (value instanceof Ok && Object.getPrototypeOf(value) === Ok.prototype) {
    const receiptDescriptor = Object.getOwnPropertyDescriptor(value, "value");
    if (
      !hasOwnDataProperty(value, "status", "ok") ||
      receiptDescriptor === undefined ||
      !("value" in receiptDescriptor)
    ) {
      throw new Panic({ message: "Dead-letter adapter returned an incomplete Ok Result" });
    }
    const receipt = receiptDescriptor.value;
    if (typeof receipt !== "object" || receipt === null) {
      throw new Panic({ message: "Dead-letter adapter returned a malformed acceptance receipt" });
    }
    const id = Object.getOwnPropertyDescriptor(receipt, "id");
    if (id === undefined || !("value" in id) || typeof id.value !== "string" || id.value === "") {
      throw new Panic({ message: "Dead-letter adapter returned a malformed acceptance receipt" });
    }
    return value;
  }

  if (value instanceof Err && Object.getPrototypeOf(value) === Err.prototype) {
    const errorDescriptor = Object.getOwnPropertyDescriptor(value, "error");
    if (
      !hasOwnDataProperty(value, "status", "error") ||
      errorDescriptor === undefined ||
      !("value" in errorDescriptor) ||
      !EventDeadLetterAcceptFailed.is(errorDescriptor.value) ||
      !isCompleteAcceptFailed(errorDescriptor.value)
    ) {
      throw new Panic({ message: "Dead-letter adapter returned an incomplete Err Result" });
    }
    return value;
  }

  throw new Panic({ message: "Dead-letter adapter returned a forged or malformed Result" });
}

const MAX_REASON_ISSUES = 32;
const MAX_REASON_CHARS = 512;

function boundReasonText(value: string): string {
  return value.length <= MAX_REASON_CHARS ? value : value.slice(0, MAX_REASON_CHARS);
}

export function createContractInvalidDeadLetterRecord(options: {
  readonly topic: Topic;
  readonly cursor: string;
  readonly mode: "work" | "fanout" | "tail";
  readonly evidence: EventTransportEvidence;
  readonly stage: Extract<EventDeadLetterReasonV1, { kind: "contract-invalid" }>["stage"];
  readonly eventType?: string;
  readonly issues: readonly string[];
}): EventDeadLetterRecordV1 {
  return {
    version: EVENT_DEAD_LETTER_VERSION,
    deadLetterId: crypto.randomUUID(),
    recordedAt: Date.now(),
    source: {
      topic: options.topic,
      cursor: options.cursor,
      messageId: options.evidence.source.messageId,
      mode: options.mode,
    },
    reason: {
      kind: "contract-invalid",
      diagnostic: "event_bus.contract_invalid",
      stage: options.stage,
      ...(options.eventType === undefined ? {} : { eventType: boundReasonText(options.eventType) }),
      issues: options.issues.slice(0, MAX_REASON_ISSUES).map(boundReasonText),
    },
    evidence: options.evidence,
  };
}

export function redisDecodeIssuesForDeadLetter(
  issues: readonly RedisMessageDecodeIssue[],
): readonly string[] {
  return issues.map((issue) => {
    if (issue.field === "entry" && issue.index !== undefined) {
      return `${issue.field}:${issue.reason}:${issue.index}`;
    }
    return `${issue.field}:${issue.reason}`;
  });
}

export function createHandlerErrorDeadLetterRecord(options: {
  readonly topic: Topic;
  readonly cursor: string;
  readonly mode: "work" | "fanout" | "tail";
  readonly evidence: EventTransportEvidence;
  readonly errorTag: string;
  readonly errorMessage: string;
}): EventDeadLetterRecordV1 {
  return {
    version: EVENT_DEAD_LETTER_VERSION,
    deadLetterId: crypto.randomUUID(),
    recordedAt: Date.now(),
    source: {
      topic: options.topic,
      cursor: options.cursor,
      messageId: options.evidence.source.messageId,
      mode: options.mode,
    },
    reason: {
      kind: "handler-error",
      errorTag: boundReasonText(options.errorTag),
      errorMessage: boundReasonText(options.errorMessage),
    },
    evidence: options.evidence,
  };
}

export function captureDeadLetterAcceptance(
  operation: () => Promise<EventDeadLetterAcceptance>,
): Promise<ResultType<EventDeadLetterAcceptance, EventDeadLetterAcceptFailed>> {
  return Result.tryPromise({
    try: operation,
    catch: (cause) => {
      if (Panic.is(cause)) throw cause;
      return new EventDeadLetterAcceptFailed({ cause, message: "Dead-letter acceptance failed" });
    },
  });
}
