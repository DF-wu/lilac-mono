import type { Result } from "better-result";

export const canonicalFixtureEvents = {
  Alpha: "fixture.alpha",
  Beta: "fixture.beta",
  Gamma: "fixture.gamma",
} as const;

declare const codec: { readonly decode: (value: unknown) => unknown };

export const completeFixtureEventCodecs = {
  [canonicalFixtureEvents.Alpha]: codec,
  [canonicalFixtureEvents.Beta]: codec,
  [canonicalFixtureEvents.Gamma]: codec,
} as const;

export const incompleteFixtureEventCodecs = {
  [canonicalFixtureEvents.Alpha]: codec,
  [canonicalFixtureEvents.Beta]: codec,
} as const;

export type Message<TData = unknown> = {
  readonly type: string;
  readonly data: TData;
};

export class RawFixtureBus {
  receiveGood(
    handler: (message: Message<unknown>, context: { readonly cursor: string }) => Promise<void>,
  ): void {
    void handler({ type: "fixture.alpha", data: unknownValue }, { cursor: "1-0" });
  }

  receiveTyped(
    handler: (message: Message<string>, context: { readonly cursor: string }) => Promise<void>,
  ): void {
    void handler({ type: "fixture.alpha", data: "trusted" }, { cursor: "1-0" });
  }

  receiveWithAssertion(
    handler: (message: Message<unknown>, context: { readonly cursor: string }) => Promise<void>,
  ): void {
    const message = unknownValue as Message<string>;
    void handler(message, { cursor: "1-0" });
  }

  receiveGeneric<TData>(
    handler: (message: Message<unknown>, context: { readonly cursor: string }) => Promise<void>,
  ): void {
    void (undefined as TData | undefined);
    void handler({ type: "fixture.alpha", data: unknownValue }, { cursor: "1-0" });
  }

  receiveWithCommit(
    handler: (
      message: Message<unknown>,
      context: { readonly cursor: string; commit(): Promise<void> },
    ) => Promise<void>,
  ): void {
    void handler(
      { type: "fixture.alpha", data: unknownValue },
      { cursor: "1-0", commit: async () => undefined },
    );
  }
}

export class LegacyRawFixtureBus {
  receiveGood(
    handler: (message: Message<unknown>, context: { readonly cursor: string }) => Promise<void>,
  ): void {
    void handler({ type: "fixture.alpha", data: unknownValue }, { cursor: "1-0" });
  }

  subscribeDelivery(): void {
    return;
  }
}

declare const unknownValue: unknown;

export type DeliveryError =
  | { readonly _tag: "DecodeFailed" }
  | { readonly _tag: "HandlerFailed" }
  | { readonly _tag: "DeadLetterFailed" };

export type DeliveryDisposition = "commit" | "park-pending" | "dead-letter" | "stop";

export interface FixtureDeliveryApi {
  good(
    handler: (
      message: Message<{ readonly value: string }>,
      context: { readonly cursor: string },
    ) => Promise<Result<void, DeliveryError>>,
  ): Promise<void>;

  bad(
    handler: (
      message: Message<{ readonly value: string }>,
      context: { readonly cursor: string; commit(): Promise<void> },
    ) => Promise<void>,
  ): Promise<void>;
}

export interface LegacyFixtureDeliveryApi {
  good(
    handler: (
      message: Message<{ readonly value: string }>,
      context: { readonly cursor: string },
    ) => Promise<Result<void, DeliveryError>>,
  ): Promise<void>;

  subscribeTopicResult(): Promise<void>;
}

export interface FixtureEventBus {
  subscribeTopic(): Promise<void>;
  fetchTopic(): Promise<void>;
}

export function registeredFixtureConsumer(bus: FixtureEventBus): void {
  void bus.subscribeTopic();
}

export function unregisteredFixtureConsumer(bus: FixtureEventBus): void {
  void bus.fetchTopic();
}

export function exhaustiveDeliveryPolicy(error: DeliveryError): DeliveryDisposition {
  switch (error._tag) {
    case "DecodeFailed":
      return "dead-letter";
    case "HandlerFailed":
      return "park-pending";
    case "DeadLetterFailed":
      return "stop";
  }
}

export function incompleteDeliveryPolicy(error: DeliveryError): DeliveryDisposition {
  switch (error._tag) {
    case "DecodeFailed":
      return "dead-letter";
    case "HandlerFailed":
      return "park-pending";
  }
  return "stop";
}
