import type {
  Cursor,
  FetchOptions,
  PublishMessage,
  PublishOptions,
  RawMessageDecodeOutcome,
  SubscriptionOptions,
  Topic,
} from "./types";
import type { Result as ResultType } from "better-result";

import type {
  EventDeliveryDoneError,
  EventDeliveryStartFailed,
  EventDeliveryStopFailed,
  RawDeliveryDependencies,
  RawDeliveryHandler,
} from "./event-delivery";

/**
 * Low-level bus interface.
 *
 * This is transport-focused (topics are strings, payload is generic/unknown).
 * Most app code should prefer `LilacBus` from `lilac-bus.ts`.
 */
export interface RawBus {
  /** Append a message to a topic/stream. */
  publish<TData>(
    msg: PublishMessage<TData>,
    opts: PublishOptions,
  ): Promise<{ id: string; cursor: Cursor }>;

  /**
   * Subscribe to a topic. The transport owns acknowledgement and applies the
   * handler's disposition. `park-pending` leaves durable entries in the PEL; it
   * does not schedule or imply automatic retry/reclamation.
   */
  subscribe(
    topic: Topic,
    opts: SubscriptionOptions,
    handler: RawDeliveryHandler,
    dependencies?: RawDeliveryDependencies,
  ): Promise<
    ResultType<
      {
        readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
        stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
      },
      EventDeliveryStartFailed
    >
  >;

  /** Fetch messages without creating a subscription. */
  fetch(
    topic: Topic,
    opts: FetchOptions,
  ): Promise<{
    messages: Array<{
      msg: RawMessageDecodeOutcome;
      cursor: Cursor;
      /** Present on transports that expose controlled delivery evidence. */
      evidence?: import("./event-dead-letter").EventTransportEvidence;
    }>;
    next?: Cursor;
  }>;

  /** Return the latest durable cursor currently present on a topic. */
  watermark?(topic: Topic): Promise<Cursor | null>;

  /** Reclaim entries older than a durable tail checkpoint and every durable group frontier. */
  trimBeforeCheckpoint?(topic: Topic, checkpoint: Cursor, safetyMargin: number): Promise<number>;

  /** Destroy a retired durable group, optionally after an explicit mixed-version rollout guard. */
  retireConsumerGroup?(
    topic: Topic,
    group: string,
    confirmSingleVersionRollout: boolean,
  ): Promise<"absent" | "destroyed">;

  /** Close any owned resources (connections, timers, etc). */
  close(): Promise<void>;
}
