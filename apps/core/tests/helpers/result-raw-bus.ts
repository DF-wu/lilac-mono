import {
  EventDeliveryStartFailed,
  EventDeliveryStopped,
  EventDeliveryStopFailed,
  EventDeliveryTransportFailed,
  type RawDeliveryAction,
  type RawMessageDecodeOutcome,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";
import { Panic, Result, type Result as ResultType } from "better-result";

export const testDeliveryActions = new WeakMap<RawBus, string[]>();
export const testDeliveriesRemainOpenOnPolicyStop = new WeakSet<RawBus>();

export async function startResultForTest<T, E>(started: Promise<ResultType<T, E>>): Promise<T> {
  const result = await started;
  if (result.status === "error") throw result.error;
  return result.value;
}

export async function stopResultForTest<E>(stopped: Promise<ResultType<void, E>>): Promise<void> {
  const result = await stopped;
  if (result.status === "error") throw result.error;
}

export function okResultForTest(): ResultType<void, never> {
  return Result.ok(undefined);
}

export type TestRawMessageHandler = (
  message: RawMessageDecodeOutcome,
  cursor: string,
) => Promise<void>;

export type TestRawSubscription = {
  readonly done?: Promise<void>;
  stop(): Promise<void>;
};

export interface TestRawSubscriptionHost {
  openTestSubscription(
    topic: string,
    options: SubscriptionOptions,
    handler: TestRawMessageHandler,
  ): Promise<TestRawSubscription>;
  onTestDeliveryAction?(action: RawDeliveryAction, cursor: string): void | Promise<void>;
}

export const subscribeForTest: RawBus["subscribe"] = async function (
  this: RawBus & TestRawSubscriptionHost,
  topic,
  options,
  handler,
) {
  const done =
    Promise.withResolvers<ResultType<void, EventDeliveryTransportFailed | EventDeliveryStopped>>();
  void done.promise.catch(() => undefined);
  let active = true;
  try {
    const subscription = await this.openTestSubscription(
      topic,
      options,
      async (message, cursor) => {
        if (!active) return;
        try {
          const evidence = {
            source: {
              transport: "redis-streams" as const,
              streamKey: `test:${topic}`,
              topic,
              messageId: cursor,
            },
            wire: { kind: "bounded-complete" as const, fields: [] },
          };
          for (const attempt of [1, 2, 3, 4, 5] as const) {
            const action = await handler(
              message,
              options.mode === "tail"
                ? { cursor, mode: "tail", evidence }
                : {
                    cursor,
                    mode: options.mode,
                    evidence,
                    deliveryId: "0000000000000000000000000000000000000000000000000000000000000000",
                    attempt,
                    leaseDeadline: Date.now() + 60_000,
                    signal: new AbortController().signal,
                  },
            );
            testDeliveryActions.get(this)?.push(action.disposition);
            await this.onTestDeliveryAction?.(action, cursor);
            switch (action.disposition) {
              case "commit":
              case "dead-letter":
                return;
              case "retry":
                if (options.mode !== "tail" && attempt < 5) continue;
                active = false;
                if (options.mode === "tail") {
                  done.resolve(
                    Result.err(
                      new EventDeliveryStopped({
                        reason: "tail-cannot-park",
                        topic,
                        cursor,
                        message:
                          "Tail delivery stopped because retry is not supported in tail mode",
                      }),
                    ),
                  );
                } else {
                  done.resolve(
                    Result.err(
                      new EventDeliveryTransportFailed({
                        cause: new Error(
                          "Test delivery retry exhausted without a dead-letter store",
                        ),
                        operation: "ack",
                        topic,
                        cursor,
                        message: "Test delivery could not terminalize an exhausted retry",
                      }),
                    ),
                  );
                }
                return;
              case "park-pending":
              case "stop":
                if (testDeliveriesRemainOpenOnPolicyStop.has(this)) return;
                active = false;
                done.resolve(
                  Result.err(
                    new EventDeliveryStopped({
                      reason: action.disposition === "stop" ? "requested" : "tail-cannot-park",
                      topic,
                      cursor,
                      message: "Test delivery stopped by policy",
                    }),
                  ),
                );
                return;
            }
          }
          throw new Error("Test delivery retry attempts were not exhausted");
        } catch (cause) {
          done.reject(cause);
          throw cause;
        }
      },
    );
    void subscription.done?.then(
      () => done.resolve(Result.ok(undefined)),
      (cause: unknown) =>
        done.resolve(
          Result.err(
            new EventDeliveryTransportFailed({
              cause,
              operation: "read",
              topic,
              message: "Test subscription failed",
            }),
          ),
        ),
    );
    return Result.ok({
      done: done.promise,
      stop: async () => {
        active = false;
        try {
          await subscription.stop();
          done.resolve(Result.ok(undefined));
          return Result.ok(undefined);
        } catch (cause) {
          if (Panic.is(cause)) throw cause;
          return Result.err(
            new EventDeliveryStopFailed({
              cause,
              topic,
              message: "Test subscription stop failed",
            }),
          );
        }
      },
    });
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new EventDeliveryStartFailed({ cause, topic, message: "Test subscription start failed" }),
    );
  }
};
