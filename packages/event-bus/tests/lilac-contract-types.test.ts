import { expect, it } from "bun:test";
import { z } from "zod";

import {
  createLilacEventCodecRegistry,
  createLilacEventTypes,
  dataKey,
  defineLilacEvents,
  fixedTopic,
  LILAC_EVENTS,
  lilacEventCodecRegistry,
  lilacEventTypes,
  type CmdAgentCreateData,
  type CmdRequestMessageData,
  type LilacBus,
  type LilacDataForType,
  type LilacEventTypesForTopic,
  type LilacEventType,
} from "../index";

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2
    ? (<T>() => T extends TRight ? 1 : 2) extends <T>() => T extends TLeft ? 1 : 2
      ? true
      : false
    : false;
type Expect<T extends true> = T;

type RegistryPayloads = {
  [TType in LilacEventType]: z.output<(typeof lilacEventCodecRegistry)[TType]["dataSchema"]>;
};
type ContractPayloads = {
  [TType in LilacEventType]: LilacDataForType<TType>;
};

type RegistryPayloadsEqualContractPayloads = Expect<Equal<RegistryPayloads, ContractPayloads>>;
type CatalogNamesEqualEventTypeNames = Expect<
  Equal<keyof typeof LILAC_EVENTS, keyof typeof lilacEventTypes>
>;
type CatalogWireTypesEqualRegistryKeys = Expect<
  Equal<
    (typeof LILAC_EVENTS)[keyof typeof LILAC_EVENTS]["type"],
    keyof typeof lilacEventCodecRegistry
  >
>;
type CatalogHasNoBroadNameIndex = Expect<
  Equal<string extends keyof typeof LILAC_EVENTS ? true : false, false>
>;
type LiteralOutputTopicRetainsOutputEvents = Expect<
  Equal<
    LilacEventTypesForTopic<"out.req.literal-request">,
    | "evt.agent.output.delta.reasoning"
    | "evt.agent.output.delta.text"
    | "evt.agent.output.text.reset"
    | "evt.agent.output.response.text"
    | "evt.agent.output.response.binary"
    | "evt.agent.output.toolcall"
    | "evt.agent.output.activity"
  >
>;
type RequestRawRemainsOpaque = Expect<Equal<CmdRequestMessageData["raw"], unknown>>;
type AgentContextRemainsOpaque = Expect<Equal<CmdAgentCreateData["context"], unknown>>;
type AgentContextRemainsRequired = Expect<
  Equal<{} extends Pick<CmdAgentCreateData, "context"> ? false : true, true>
>;

function compilePublishOverrideContract(bus: LilacBus): void {
  void bus.publish(
    lilacEventTypes.EvtAgentOutputDeltaText,
    { delta: "fixture" },
    { topic: "out.req.override-request", key: "override-key" },
  );
  void bus.publish(
    lilacEventTypes.EvtAdapterMessageDeleted,
    {
      platform: "discord",
      channelId: "channel-1",
      messageId: "message-1",
      ts: 1,
    },
    { topic: "evt.adapter", key: "override-key" },
  );

  void bus.publish(
    lilacEventTypes.EvtAgentOutputDeltaText,
    { delta: "fixture" },
    {
      // @ts-expect-error output events cannot publish into a different topic family
      topic: "evt.request",
    },
  );
}

function compileEventDefinitionContract(): void {
  void defineLilacEvents({
    Valid: {
      type: "fixture.valid",
      family: "fixture",
      topic: fixedTopic("fixture.topic"),
      key: dataKey("id"),
      data: z.strictObject({ id: z.string() }),
    },
  });

  void defineLilacEvents({
    // @ts-expect-error data keys must name required string-valued payload output fields
    InvalidDataKey: {
      type: "fixture.invalid-data-key",
      family: "fixture",
      topic: fixedTopic("fixture.topic"),
      key: dataKey("missing"),
      data: z.strictObject({ id: z.string() }),
    },
  });

  // @ts-expect-error __proto__ object-literal semantics cannot represent a catalog entry safely
  void defineLilacEvents({
    ["__proto__"]: {
      type: "fixture.reserved-name",
      family: "fixture",
      topic: fixedTopic("fixture.topic"),
      key: dataKey("id"),
      data: z.strictObject({ id: z.string() }),
    },
  });
}

it("keeps registry schema outputs and publish overrides compile-equivalent to contracts", () => {
  expect(Object.keys(lilacEventCodecRegistry)).toHaveLength(25);
  expect<RegistryPayloadsEqualContractPayloads>(true).toBe(true);
  expect<CatalogNamesEqualEventTypeNames>(true).toBe(true);
  expect<CatalogWireTypesEqualRegistryKeys>(true).toBe(true);
  expect<CatalogHasNoBroadNameIndex>(true).toBe(true);
  expect<LiteralOutputTopicRetainsOutputEvents>(true).toBe(true);
  expect<RequestRawRemainsOpaque>(true).toBe(true);
  expect<AgentContextRemainsOpaque>(true).toBe(true);
  expect<AgentContextRemainsRequired>(true).toBe(true);
  expect(typeof compilePublishOverrideContract).toBe("function");
  expect(typeof compileEventDefinitionContract).toBe("function");
});

it("projects reserved wire types as own properties", () => {
  const catalog = defineLilacEvents({
    ReservedWireType: {
      type: "__proto__",
      family: "fixture",
      topic: fixedTopic("fixture.topic"),
      key: dataKey("id"),
      data: z.strictObject({ id: z.string() }),
    },
  });

  const eventTypes = createLilacEventTypes(catalog);
  const codecs = createLilacEventCodecRegistry(catalog);
  expect(Object.hasOwn(codecs, "__proto__")).toBe(true);
  expect(eventTypes.ReservedWireType).toBe("__proto__");
  expect(codecs.__proto__.type).toBe("__proto__");
});
