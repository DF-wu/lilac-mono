/** Logical channel name (backed by a Redis stream). */
export type Topic = string;

/**
 * Opaque checkpoint token.
 *
 * In the Redis Streams transport this is the stream entry id (e.g. `1736973100000-0`).
 */
export type Cursor = string;

/** Where to start reading from when consuming a topic. */
export type Offset = { type: "begin" } | { type: "now" } | { type: "cursor"; cursor: Cursor };

/** Delivery model for subscriptions. */
export type Mode = "work" | "fanout" | "tail";

/** A completely decoded envelope stored in / read from the bus. */
export type DecodedMessage<TData = unknown> = {
  topic: Topic;
  id: string;
  type: string;
  ts: number;
  key?: string;
  headers?: Record<string, string>;
  data: TData;
};

export type RedisWireKnownField = "type" | "ts" | "data" | "headers" | "key";

/**
 * A bounded structural projection of one value from the flat Redis stream field array.
 *
 * This intentionally records no string content. Redis values can contain managed binary
 * payloads, data URLs, credentials, or other opaque application data even when the entry
 * is malformed. The path, role, known field name, broad content class, and length are
 * enough to diagnose the wire shape without copying that content into diagnostics or a
 * dead-letter preview.
 */
export type RedisWireValueEvidence =
  | {
      kind: "string";
      path: string;
      role: "entry" | "field-name" | "field-value";
      field?: RedisWireKnownField;
      valueKind:
        | "empty"
        | "known-field-name"
        | "unknown-field-name"
        | "data-url"
        | "base64"
        | "managed-binary-field"
        | "structured"
        | "text";
      charLength: number;
    }
  | {
      kind: "non-string";
      path: string;
      role: "entry" | "field-name" | "field-value";
      field?: RedisWireKnownField;
      valueType:
        | "array"
        | "bigint"
        | "boolean"
        | "function"
        | "null"
        | "number"
        | "object"
        | "symbol"
        | "undefined";
    };

/** Why a Redis stream entry could not be decoded as a message envelope. */
export type RedisMessageDecodeIssue =
  | {
      field: "entry";
      reason: "fields_not_array" | "odd_field_count" | "non_string_field";
      index?: number;
    }
  | { field: "type"; reason: "missing" | "empty" }
  | { field: "ts"; reason: "missing" | "invalid_number" }
  | { field: "data"; reason: "missing" | "invalid_superjson" }
  | { field: "headers"; reason: "invalid_superjson" | "not_string_record" };

/**
 * Explicit raw transport outcome for an entry that cannot form a valid message.
 *
 * Evidence is intentionally bounded and belongs in controlled recovery/dead-letter
 * handling, not ordinary logs.
 */
export type RedisMessageDecodeFailure = {
  _tag: "RedisMessageDecodeFailure";
  topic: Topic;
  id: string;
  /** Absent; declared only so legacy raw-inspection callsites can narrow without a flag day. */
  type?: never;
  /** Absent; declared only so legacy raw-inspection callsites can narrow without a flag day. */
  data?: never;
  error: {
    source: {
      transport: "redis-streams";
      streamKey: string;
      topic: Topic;
      messageId: string;
    };
    issues: readonly RedisMessageDecodeIssue[];
    evidence: {
      fields: readonly RedisWireValueEvidence[];
      omittedValueCount: number;
    };
  };
};

/** Envelope stored in / read from the bus after successful transport decoding. */
export type Message<TData = unknown> = DecodedMessage<TData>;

/** Raw receive outcome: either an unknown-payload message or bounded decode-failure evidence. */
export type RawMessageDecodeOutcome = Message<unknown> | RedisMessageDecodeFailure;

/** Valid envelope accepted by publish; Redis assigns `id` and `ts`. */
export type PublishMessage<TData> = Omit<DecodedMessage<TData>, "id" | "ts">;

/** Low-level publish options (mostly transport-focused). */
export type PublishOptions = {
  /** Destination topic/stream. */
  topic: Topic;
  /** Event type string (e.g. `cmd.request.message`). */
  type: string;
  /** Optional correlation/partition key (e.g. request_id). */
  key?: string;
  /** Optional metadata (string->string). */
  headers?: Record<string, string>;
};

/** A finite Redis lease fencing one request publication producer. */
export type RequestPublicationClaim = {
  readonly requestDeliveryId: string;
  readonly token: string;
};

export type RequestPublicationClaimAcquisition =
  | { readonly status: "acquired"; readonly claim: RequestPublicationClaim }
  | { readonly status: "contended" };

export type RawClaimedRequestPublishOutcome =
  | { readonly status: "published"; readonly receipt: PublishReceipt }
  | { readonly status: "fenced" };

export type RequestPublicationConfirmation = "absent" | "confirmed" | "fenced" | "mismatch";

export type RequestPublicationClaimAbandonment =
  | "abandoned"
  | "absent"
  | "fenced"
  | "marker-present";

export type PublishReceipt = {
  readonly id: string;
  readonly cursor: Cursor;
  /** True when request publication observed the stream entry created by an earlier attempt. */
  readonly duplicate?: boolean;
  /** Conservative absolute expiry for a sliding output replay stream. */
  readonly replayDeadline?: number;
};

/** Absolute Redis-owned replay expiry for one request output stream. */
export type OutputStreamExpiry =
  | { readonly kind: "present"; readonly expiresAt: number }
  | { readonly kind: "absent" };

/** Raw transport result when the stream exists but its expiry cannot be established. */
export type RawOutputStreamExpiry =
  | OutputStreamExpiry
  | {
      readonly kind: "uncertain";
      readonly reason: "stream-has-no-expiry" | "invalid-transport-response";
    };

/** Flow control options shared by subscription read loops. */
export type SubscriptionWaitOptions = {
  /** Max time to block waiting for messages. */
  maxWaitMs?: number;
};

/** Flow control options for non-durable tail reads. */
export type BatchOptions = SubscriptionWaitOptions & {
  /** Max messages per poll. */
  maxMessages?: number;
};

/** Durable subscription (consumer group) options. */
export type WorkOrFanoutSubscriptionOptions = {
  /**
   * `work`: competing consumers (queue semantics).
   * `fanout`: each subscriptionId receives all events.
   */
  mode: "work" | "fanout";
  /** Consumer group identifier (durable). */
  subscriptionId: string;
  /** Optional consumer identity within the group. */
  consumerId?: string;
  /** Destroy this consumer group when the subscription stops. */
  ephemeral?: boolean;
  batch?: SubscriptionWaitOptions;
};

/** Non-durable streaming read options (no consumer group). */
export type TailSubscriptionOptions = {
  mode: "tail";
  offset?: Offset;
  batch?: BatchOptions;
};

/** Options shared by `subscribe()` variants. */
export type SubscriptionOptions = WorkOrFanoutSubscriptionOptions | TailSubscriptionOptions;

/** Manual pull API options for `fetch()`. */
export type FetchOptions = {
  offset: Offset;
  limit?: number;
};
