import {
  EventDeliveryStartFailed,
  EventDeliveryStopped,
  type EventDeliveryContext,
  type EventDeliveryDoneError,
  type FetchOptions,
  type Message,
  type PublishOptions,
  type RawBus,
  type RawDeliveryAction,
  type RawDeliveryHandler,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";
import { Result, type Result as ResultType } from "better-result";

export type DeliveryObservation = {
  readonly topic: string;
  readonly cursor: string;
  readonly disposition: RawDeliveryAction["disposition"];
  readonly contextHasCommit: boolean;
};

type InMemoryDeliverySubscription = {
  readonly topic: string;
  readonly opts: SubscriptionOptions;
  readonly handler: RawDeliveryHandler;
  readonly done: PromiseWithResolvers<ResultType<void, EventDeliveryDoneError>>;
};

function createDeliveryContext(
  topic: string,
  cursor: string,
  mode: SubscriptionOptions["mode"],
): EventDeliveryContext {
  return {
    cursor,
    mode,
    evidence: {
      source: {
        transport: "redis-streams",
        streamKey: topic,
        topic,
        messageId: cursor,
      },
      wire: { kind: "bounded-complete", fields: [] },
    },
  };
}

export function createInMemoryDeliveryBus(
  onDelivery?: (observation: DeliveryObservation) => void,
  waitForTailStop?: () => Promise<void>,
  completeSurfaceOutputHeaders = true,
  failStartForTopic?: (topic: string) => boolean,
): RawBus {
  const topics = new Map<string, Array<Message<unknown>>>();
  const correlationByRequestId = new Map<
    string,
    { readonly session_id: string; readonly request_client: string }
  >();
  let sequence = 0;
  const deliverySubs = new Set<InMemoryDeliverySubscription>();

  const deliver = async (
    subscription: InMemoryDeliverySubscription,
    message: Message<unknown>,
  ): Promise<RawDeliveryAction> => {
    const context = createDeliveryContext(subscription.topic, message.id, subscription.opts.mode);
    const action = await subscription.handler(message, context);
    onDelivery?.({
      topic: subscription.topic,
      cursor: message.id,
      disposition: action.disposition,
      contextHasCommit: Object.hasOwn(context, "commit"),
    });
    if (
      action.disposition === "stop" ||
      (action.disposition === "park-pending" && subscription.opts.mode === "tail")
    ) {
      deliverySubs.delete(subscription);
      subscription.done.resolve(
        Result.err(
          new EventDeliveryStopped({
            reason: action.disposition === "stop" ? "requested" : "tail-cannot-park",
            topic: subscription.topic,
            cursor: message.id,
            message: "In-memory delivery stopped",
          }),
        ),
      );
    }
    return action;
  };

  return {
    publish: async <TData>(message: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
      const requestId = opts.headers?.request_id;
      const sessionId = opts.headers?.session_id;
      const requestClient = opts.headers?.request_client;
      if (requestId && sessionId && requestClient) {
        correlationByRequestId.set(requestId, {
          session_id: sessionId,
          request_client: requestClient,
        });
      }
      const correlation = requestId ? correlationByRequestId.get(requestId) : undefined;
      const headers =
        completeSurfaceOutputHeaders && opts.topic.startsWith("out.req.") && correlation
          ? { ...opts.headers, ...correlation }
          : opts.headers;
      const id = `${Date.now()}-${sequence}`;
      sequence += 1;
      const stored: Message<unknown> = {
        topic: opts.topic,
        id,
        type: opts.type,
        ts: Date.now(),
        key: opts.key,
        headers,
        data: message.data,
      };

      const list = topics.get(opts.topic) ?? [];
      list.push(stored);
      topics.set(opts.topic, list);

      for (const subscription of deliverySubs) {
        if (subscription.topic !== opts.topic) continue;
        await deliver(subscription, stored);
      }

      return { id, cursor: id };
    },
    subscribe: async (topic, opts, handler) => {
      if (failStartForTopic?.(topic)) {
        return Result.err(
          new EventDeliveryStartFailed({
            topic,
            cause: new Error("forced subscription start failure"),
            message: "Forced subscription start failure",
          }),
        );
      }
      const done = Promise.withResolvers<ResultType<void, EventDeliveryDoneError>>();
      const subscription = { topic, opts, handler, done };
      deliverySubs.add(subscription);

      if (opts.mode === "tail") {
        const existing = topics.get(topic) ?? [];
        let replay = existing;
        const offset = opts.offset;
        if (offset?.type === "cursor") {
          const cursorIndex = existing.findIndex((message) => message.id === offset.cursor);
          replay = cursorIndex >= 0 ? existing.slice(cursorIndex + 1) : existing;
        } else if (opts.offset?.type === "now") {
          replay = [];
        }
        for (const message of replay) {
          const action = await deliver(subscription, message);
          if (action.disposition === "stop" || action.disposition === "park-pending") break;
        }
      }

      return Result.ok({
        done: done.promise,
        stop: async () => {
          deliverySubs.delete(subscription);
          done.resolve(Result.ok(undefined));
          if (opts.mode === "tail") await waitForTailStop?.();
          return Result.ok(undefined);
        },
      });
    },
    fetch: async (topic: string, _opts: FetchOptions) => {
      const existing = topics.get(topic) ?? [];
      return {
        messages: existing.map((message) => ({ msg: message, cursor: message.id })),
        next: existing.length > 0 ? existing[existing.length - 1]!.id : undefined,
      };
    },
    close: async () => undefined,
  };
}

export function createInMemoryDeliveryBusWithBlockingTailStop(): {
  readonly raw: RawBus;
  releaseTailStops(): void;
} {
  let tailStopGatePromise: Promise<void> | null = null;
  let tailStopGateResolve: (() => void) | null = null;
  const ensureTailStopGate = () => {
    if (tailStopGatePromise) return tailStopGatePromise;
    tailStopGatePromise = new Promise<void>((resolve) => {
      tailStopGateResolve = resolve;
    });
    return tailStopGatePromise;
  };
  return {
    raw: createInMemoryDeliveryBus(undefined, ensureTailStopGate),
    releaseTailStops: () => {
      tailStopGateResolve?.();
      tailStopGateResolve = null;
      tailStopGatePromise = null;
    },
  };
}
