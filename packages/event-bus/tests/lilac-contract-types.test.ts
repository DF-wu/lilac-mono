import { expect, it } from "bun:test";
import type { z } from "zod";

import {
  lilacEventCodecRegistry,
  lilacEventTypes,
  type CmdAgentCreateData,
  type CmdRequestMessageData,
  type LilacBus,
  type LilacDataForType,
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

it("keeps registry schema outputs and publish overrides compile-equivalent to contracts", () => {
  expect(Object.keys(lilacEventCodecRegistry)).toHaveLength(25);
  expect<RegistryPayloadsEqualContractPayloads>(true).toBe(true);
  expect<RequestRawRemainsOpaque>(true).toBe(true);
  expect<AgentContextRemainsOpaque>(true).toBe(true);
  expect<AgentContextRemainsRequired>(true).toBe(true);
  expect(typeof compilePublishOverrideContract).toBe("function");
});
