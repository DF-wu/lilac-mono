import { createHash } from "node:crypto";

import { Err, Ok, Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import type { BlobRefV1 } from "@stanley2058/lilac-blob-storage";

import { panic as signalEventBusPanic } from "./redis-managed-delivery";
import type { RedisMessageDecodeIssue, RedisWireValueEvidence, Topic } from "./types";

export const EVENT_DEAD_LETTER_VERSION = 3 as const;
export const EVENT_DEAD_LETTER_MAX_ATTEMPTS = 5 as const;

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
        readonly fields: readonly RedisWireValueEvidence[];
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
              readonly kind: "blob-ref";
              readonly blob: BlobRefV1;
            };
        readonly preview: {
          readonly fields: readonly RedisWireValueEvidence[];
          readonly omittedValueCount: number;
        };
      };
};

export type EventDeadLetterHandlerFailure = {
  readonly kind: "handler-error";
  readonly errorTag: string;
  readonly errorMessage: string;
};

export type EventDeadLetterReason =
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
  | EventDeadLetterHandlerFailure
  | {
      readonly kind: "attempts-exhausted";
      readonly finalFailure: EventDeadLetterHandlerFailure | { readonly kind: "lease-expired" };
    };

export type EventDeadLetterRecord = {
  readonly version: typeof EVENT_DEAD_LETTER_VERSION;
  readonly deadLetterId: string;
  readonly recordedAt: number;
  readonly source: {
    readonly topic: Topic;
    readonly cursor: string;
    readonly messageId: string;
    readonly mode: "work" | "fanout" | "tail";
  };
  readonly delivery:
    | {
        readonly kind: "managed-v2";
        readonly physicalGroup: string;
        readonly attempt: 1 | 2 | 3 | 4 | 5;
        readonly maxAttempts: typeof EVENT_DEAD_LETTER_MAX_ATTEMPTS;
      }
    | { readonly kind: "tail" };
  readonly reason: EventDeadLetterReason;
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
    record: EventDeadLetterRecord,
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

export function createContractInvalidDeadLetterReason(options: {
  readonly stage: Extract<EventDeadLetterReason, { kind: "contract-invalid" }>["stage"];
  readonly eventType?: string;
  readonly issues: readonly string[];
}): Extract<EventDeadLetterReason, { kind: "contract-invalid" }> {
  return {
    kind: "contract-invalid",
    diagnostic: "event_bus.contract_invalid",
    stage: options.stage,
    ...(options.eventType === undefined ? {} : { eventType: boundReasonText(options.eventType) }),
    issues: options.issues.slice(0, MAX_REASON_ISSUES).map(boundReasonText),
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

export function createHandlerErrorDeadLetterReason(options: {
  readonly errorTag: string;
  readonly errorMessage: string;
}): EventDeadLetterHandlerFailure {
  return {
    kind: "handler-error",
    errorTag: boundReasonText(options.errorTag),
    errorMessage: boundReasonText(options.errorMessage),
  };
}

export function createAttemptsExhaustedDeadLetterReason(options: {
  readonly finalFailure:
    | { readonly kind: "handler-error"; readonly errorTag: string; readonly errorMessage: string }
    | { readonly kind: "lease-expired" };
}): Extract<EventDeadLetterReason, { kind: "attempts-exhausted" }> {
  return {
    kind: "attempts-exhausted",
    finalFailure:
      options.finalFailure.kind === "handler-error"
        ? createHandlerErrorDeadLetterReason(options.finalFailure)
        : { kind: "lease-expired" },
  };
}

function appendLengthPrefixedIdentityPart(
  hash: ReturnType<typeof createHash>,
  value: string,
): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  hash.update(length);
  hash.update(bytes);
}

function managedDeadLetterId(streamKey: string, physicalGroup: string, messageId: string): string {
  const hash = createHash("sha256");
  hash.update("lilac:event-dead-letter");
  hash.update(Uint8Array.of(EVENT_DEAD_LETTER_VERSION));
  appendLengthPrefixedIdentityPart(hash, streamKey);
  appendLengthPrefixedIdentityPart(hash, physicalGroup);
  appendLengthPrefixedIdentityPart(hash, messageId);
  return hash.digest("hex");
}

export function createManagedEventDeadLetterRecord(options: {
  readonly topic: Topic;
  readonly cursor: string;
  readonly mode: "work" | "fanout";
  readonly physicalGroup: string;
  readonly attempt: 1 | 2 | 3 | 4 | 5;
  readonly recordedAt: number;
  readonly reason: EventDeadLetterReason;
  readonly evidence: EventTransportEvidence;
}): EventDeadLetterRecord {
  return {
    version: EVENT_DEAD_LETTER_VERSION,
    deadLetterId: managedDeadLetterId(
      options.evidence.source.streamKey,
      options.physicalGroup,
      options.evidence.source.messageId,
    ),
    recordedAt: options.recordedAt,
    source: {
      topic: options.topic,
      cursor: options.cursor,
      messageId: options.evidence.source.messageId,
      mode: options.mode,
    },
    delivery: {
      kind: "managed-v2",
      physicalGroup: options.physicalGroup,
      attempt: options.attempt,
      maxAttempts: EVENT_DEAD_LETTER_MAX_ATTEMPTS,
    },
    reason: options.reason,
    evidence: options.evidence,
  };
}

export function createTailEventDeadLetterRecord(options: {
  readonly topic: Topic;
  readonly cursor: string;
  readonly reason: EventDeadLetterReason;
  readonly evidence: EventTransportEvidence;
}): EventDeadLetterRecord {
  return {
    version: EVENT_DEAD_LETTER_VERSION,
    deadLetterId: crypto.randomUUID(),
    recordedAt: Date.now(),
    source: {
      topic: options.topic,
      cursor: options.cursor,
      messageId: options.evidence.source.messageId,
      mode: "tail",
    },
    delivery: { kind: "tail" },
    reason: options.reason,
    evidence: options.evidence,
  };
}

type CapturedDeadLetterAcceptanceFailure =
  | { readonly kind: "failure"; readonly error: EventDeadLetterAcceptFailed }
  | { readonly kind: "panic"; readonly panic: Panic };

export async function captureDeadLetterAcceptance(
  operation: () => Promise<EventDeadLetterAcceptance>,
): Promise<ResultType<EventDeadLetterAcceptance, EventDeadLetterAcceptFailed>> {
  const captured = await Result.tryPromise({
    try: operation,
    catch: (cause): (() => CapturedDeadLetterAcceptanceFailure) => {
      return () => {
        const inspectedPanic = Result.try({
          try: (): Panic | undefined => (Panic.is(cause) ? cause : undefined),
          catch: () => undefined,
        });
        const panic = inspectedPanic.match({ ok: (value) => value, err: () => undefined });
        if (panic) return { kind: "panic" as const, panic };
        return {
          kind: "failure" as const,
          error: new EventDeadLetterAcceptFailed({
            cause,
            message: "Dead-letter acceptance failed",
          }),
        };
      };
    },
  });
  const outcome = captured
    .mapError((settle) => settle())
    .match<
      | {
          readonly kind: "result";
          readonly result: ResultType<EventDeadLetterAcceptance, EventDeadLetterAcceptFailed>;
        }
      | { readonly kind: "panic"; readonly panic: Panic }
    >({
      ok: (acceptance) => ({ kind: "result", result: Result.ok(acceptance) }),
      err: (failure) =>
        failure.kind === "panic" ? failure : { kind: "result", result: Result.err(failure.error) },
    });
  if (outcome.kind === "panic") {
    const failure = outcome;
    return signalEventBusPanic(failure.panic);
  }
  return outcome.result;
}
