import type { Result } from "better-result";

import * as sameNameImpostors from "./stage4-event-helper-impostors";

declare const codec: { readonly decode: (value: unknown) => unknown };

function defineLilacEvents<const TEvents>(events: TEvents): TEvents {
  return events;
}

function createLilacEventCodecRegistry<const TEvents>(events: TEvents): TEvents {
  return events;
}

function wrongEventCatalogHelper<const TEvents>(events: TEvents): TEvents {
  return events;
}

const wrongEventHelpers = {
  defineLilacEvents: wrongEventCatalogHelper,
  createLilacEventCodecRegistry: wrongEventCatalogHelper,
};

export const validFixtureEvents = defineLilacEvents({
  Alpha: { type: "fixture.alpha", family: "alpha", codec },
  Beta: { type: "fixture.beta", family: "remaining", codec },
  Gamma: { type: "fixture.gamma", family: "remaining", codec },
});
export const validFixtureEventCodecs = createLilacEventCodecRegistry(validFixtureEvents);

export const missingMetadataFixtureEvents = defineLilacEvents({
  Alpha: { type: "fixture.alpha", codec },
});
export const missingMetadataFixtureEventCodecs = createLilacEventCodecRegistry(
  missingMetadataFixtureEvents,
);

export const duplicateWireTypeFixtureEvents = defineLilacEvents({
  Alpha: { type: "fixture.duplicate", family: "alpha", codec },
  Beta: { type: "fixture.duplicate", family: "beta", codec },
});
export const duplicateWireTypeFixtureEventCodecs = createLilacEventCodecRegistry(
  duplicateWireTypeFixtureEvents,
);

const spreadFixtureEntry = {
  Alpha: { type: "fixture.alpha", family: "alpha", codec },
};
export const spreadFixtureEvents = defineLilacEvents({
  ...spreadFixtureEntry,
});
export const spreadFixtureEventCodecs = createLilacEventCodecRegistry(spreadFixtureEvents);

const computedFixtureName = "Alpha";
export const computedFixtureEvents = defineLilacEvents({
  [computedFixtureName]: { type: "fixture.alpha", family: "alpha", codec },
});
export const computedFixtureEventCodecs = createLilacEventCodecRegistry(computedFixtureEvents);

export const reservedNameFixtureEvents = defineLilacEvents({
  __proto__: { type: "fixture.reserved", family: "fixture", codec },
});
export const reservedNameFixtureEventCodecs =
  createLilacEventCodecRegistry(reservedNameFixtureEvents);

const nonliteralFixtureInput = {
  Alpha: { type: "fixture.alpha", family: "alpha", codec },
};
export const nonliteralFixtureEvents = defineLilacEvents(nonliteralFixtureInput);
export const nonliteralFixtureEventCodecs = createLilacEventCodecRegistry(nonliteralFixtureEvents);

const nonliteralWireType: string = "fixture.alpha";
const nonliteralFamily: string = "alpha";
export const nonliteralMetadataFixtureEvents = defineLilacEvents({
  Alpha: { type: nonliteralWireType, family: nonliteralFamily, codec },
});
export const nonliteralMetadataFixtureEventCodecs = createLilacEventCodecRegistry(
  nonliteralMetadataFixtureEvents,
);

export const wrongHelperFixtureEvents = wrongEventHelpers.defineLilacEvents({
  Alpha: { type: "fixture.alpha", family: "alpha", codec },
});
export const wrongHelperFixtureEventCodecs =
  createLilacEventCodecRegistry(wrongHelperFixtureEvents);

export const sameNameImpostorFixtureEvents = sameNameImpostors.defineLilacEvents({
  Alpha: { type: "fixture.alpha", family: "alpha", codec },
});
export const sameNameImpostorFixtureEventCodecs = createLilacEventCodecRegistry(
  sameNameImpostorFixtureEvents,
);

export const alternateFixtureEvents = defineLilacEvents({
  Alternate: { type: "fixture.alternate", family: "alternate", codec },
});
export const mismatchedFixtureEventCodecs = createLilacEventCodecRegistry(alternateFixtureEvents);
export const wrongProjectionHelperFixtureEventCodecs =
  wrongEventHelpers.createLilacEventCodecRegistry(validFixtureEvents);
export const sameNameImpostorProjectionFixtureEventCodecs =
  sameNameImpostors.createLilacEventCodecRegistry(validFixtureEvents);

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

export type DeliveryDisposition = "commit" | "retry" | "park-pending" | "dead-letter" | "stop";

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
      return "retry";
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
