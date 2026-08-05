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

/** A bounded projection of one value from the flat Redis stream field array. */
export type RedisWireValueEvidence =
  | { kind: "string"; value: string; truncated: boolean }
  | {
      kind: "non-string";
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
  /** Best-effort retention hint (e.g. approximate MAXLEN). */
  retention?: { maxLenApprox?: number };
};

/** Flow control options for read loops. */
export type BatchOptions = {
  /** Max messages per poll. */
  maxMessages?: number;
  /** Max time to block waiting for messages. */
  maxWaitMs?: number;
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
  /**
   * Only applied if the consumer group needs to be created.
   * If the group already exists, the offset is ignored.
   */
  offset?: Exclude<Offset, { type: "cursor" }>;
  batch?: BatchOptions;
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
