import { describe, expect, it } from "bun:test";
import { Panic, Result } from "better-result";
import SuperJSON from "superjson";

import {
  createLilacBus,
  decodeLilacMessage,
  lilacEventCodecRegistry,
  lilacEventTypes,
  type DecodedMessage,
  type FetchOptions,
  type LilacBus,
  type LilacDataForType,
  type LilacEventDecodeStage,
  type LilacEventType,
  type LilacTopicForType,
  type Message,
  type PublishMessage,
  type PublishOptions,
  type RawBus,
  type RawDeliveryHandler,
  type RawMessageDecodeOutcome,
  type SubscriptionOptions,
} from "../index";

function envelope<TData>(input: {
  type: string;
  topic: string;
  key?: string;
  data: TData;
  headers?: Record<string, string>;
}): DecodedMessage<TData> {
  return {
    id: "1736973100000-0",
    ts: 1_736_973_100_000,
    ...input,
  };
}

const requestHeaders = {
  request_id: "request-1",
  session_id: "session-1",
  request_client: "discord",
  trace_id: "trace-1",
};

type EventFamily =
  | "command/request"
  | "workflow-control"
  | "lifecycle"
  | "adapter"
  | "surface"
  | "agent-output";

type CompatibilityFixture = {
  readonly family: EventFamily;
  readonly type: LilacEventType;
  readonly message: DecodedMessage<unknown>;
  readonly overrideMessage: DecodedMessage<unknown>;
  readonly malformedData: unknown;
  publish(bus: LilacBus): Promise<void>;
  publishWithOverrides(bus: LilacBus): Promise<void>;
};

function compatibilityFixture<TType extends LilacEventType>(input: {
  readonly family: EventFamily;
  readonly type: TType;
  readonly topic: LilacTopicForType<TType>;
  readonly key: string;
  readonly data: LilacDataForType<TType>;
  readonly headers?: Record<string, string>;
  readonly overrideTopic?: LilacTopicForType<TType>;
}): CompatibilityFixture {
  const message = envelope({
    type: input.type,
    topic: input.topic,
    key: input.key,
    data: input.data,
    ...(input.headers === undefined ? {} : { headers: input.headers }),
  });
  const overrideTopic = input.overrideTopic ?? input.topic;
  const overrideKey = `override.${input.key}`;
  const overrideMessage = envelope({
    type: input.type,
    topic: overrideTopic,
    key: overrideKey,
    data: input.data,
    ...(input.headers === undefined ? {} : { headers: input.headers }),
  });
  return {
    family: input.family,
    type: input.type,
    message,
    overrideMessage,
    malformedData: { ...input.data, unexpectedWireField: true },
    publish: async (bus) => {
      await bus.publish(
        input.type,
        input.data,
        input.headers === undefined ? undefined : { headers: input.headers },
      );
    },
    publishWithOverrides: async (bus) => {
      await bus.publish(input.type, input.data, {
        ...(input.headers === undefined ? {} : { headers: input.headers }),
        topic: overrideTopic,
        key: overrideKey,
      });
    },
  };
}

const opaqueWireUrl = new URL("https://example.com/request?source=fixture");
const opaqueWireDate = new Date("2026-08-03T12:34:56.789Z");
const opaqueRequestRaw = { url: opaqueWireUrl, receivedAt: opaqueWireDate };
const opaqueAgentContext = { callbackUrl: opaqueWireUrl, createdAt: opaqueWireDate };

const compatibilityFixtures = [
  compatibilityFixture({
    family: "command/request",
    type: lilacEventTypes.CmdRequestMessage,
    topic: "cmd.request",
    key: "request-1",
    headers: requestHeaders,
    data: {
      queue: "prompt",
      messages: [{ role: "user", content: "hello" }],
      corePrimaryLineage: undefined,
      modelOverride: "openai/gpt-5",
      raw: opaqueRequestRaw,
    },
  }),
  compatibilityFixture({
    family: "command/request",
    type: lilacEventTypes.CmdSurfaceOutputReanchor,
    topic: "cmd.surface",
    key: "request-1",
    headers: requestHeaders,
    data: {
      inheritReplyTo: false,
      mode: "steer",
      replyTo: { platform: "discord", channelId: "channel-1", messageId: "message-1" },
    },
  }),
  compatibilityFixture({
    family: "adapter",
    type: lilacEventTypes.EvtAdapterMessageCreated,
    topic: "evt.adapter",
    key: "message-1",
    data: {
      platform: "discord",
      channelId: "channel-1",
      channelName: "general",
      messageId: "message-1",
      userId: "user-1",
      userName: "Ada",
      text: "hello",
      ts: 10,
      raw: { gateway: "fixture" },
    },
  }),
  compatibilityFixture({
    family: "adapter",
    type: lilacEventTypes.EvtAdapterMessageUpdated,
    topic: "evt.adapter",
    key: "message-2",
    data: {
      platform: "slack",
      channelId: "channel-2",
      messageId: "message-2",
      userId: "user-2",
      text: "edited",
      ts: 11,
    },
  }),
  compatibilityFixture({
    family: "adapter",
    type: lilacEventTypes.EvtAdapterMessageDeleted,
    topic: "evt.adapter",
    key: "message-3",
    data: {
      platform: "telegram",
      channelId: "channel-3",
      messageId: "message-3",
      ts: 12,
    },
  }),
  compatibilityFixture({
    family: "adapter",
    type: lilacEventTypes.EvtAdapterReactionAdded,
    topic: "evt.adapter",
    key: "message-4",
    data: {
      platform: "github",
      channelId: "repo#1",
      messageId: "message-4",
      userId: "octocat",
      reaction: "+1",
      ts: 13,
    },
  }),
  compatibilityFixture({
    family: "adapter",
    type: lilacEventTypes.EvtAdapterReactionRemoved,
    topic: "evt.adapter",
    key: "message-5",
    data: {
      platform: "whatsapp",
      channelId: "channel-5",
      messageId: "message-5",
      reaction: "heart",
      ts: 14,
    },
  }),
  compatibilityFixture({
    family: "adapter",
    type: lilacEventTypes.EvtAdapterActionInvoked,
    topic: "evt.adapter",
    key: "action-1",
    data: {
      actionId: "action-1",
      platform: "web",
      userId: "user-3",
      messageRef: { platform: "web", channelId: "channel-6", messageId: "message-6" },
      sourceMessageId: "source-1",
      ts: 15,
    },
  }),
  compatibilityFixture({
    family: "workflow-control",
    type: lilacEventTypes.EvtWorkflowWaitResolverBarrier,
    topic: "evt.adapter",
    key: "barrier-1",
    data: { barrierId: "barrier-1", ts: 16 },
  }),
  compatibilityFixture({
    family: "lifecycle",
    type: lilacEventTypes.EvtRequestLifecycleChanged,
    topic: "evt.request",
    key: "request-1",
    headers: requestHeaders,
    data: { state: "running", detail: "started", ts: 17 },
  }),
  compatibilityFixture({
    family: "lifecycle",
    type: lilacEventTypes.EvtRequestReply,
    topic: "evt.request",
    key: "request-1",
    headers: { request_id: "request-1" },
    data: {},
  }),
  compatibilityFixture({
    family: "surface",
    type: lilacEventTypes.EvtSurfaceOutputMessageCreated,
    topic: "evt.surface",
    key: "request-1",
    headers: requestHeaders,
    data: {
      msgRef: { platform: "discord", channelId: "channel-1", messageId: "output-1" },
    },
  }),
  compatibilityFixture({
    family: "workflow-control",
    type: lilacEventTypes.EvtWorkflowRunChanged,
    topic: "evt.workflow",
    key: "run-1",
    headers: { workflow_outbox_id: "outbox-1" },
    data: {
      runId: "run-1",
      revisionId: "revision-1",
      state: "running",
      previousState: "queued",
      detail: "claimed",
      ts: 18,
    },
  }),
  compatibilityFixture({
    family: "workflow-control",
    type: lilacEventTypes.EvtWorkflowOperationChanged,
    topic: "evt.workflow",
    key: "run-1",
    data: {
      runId: "run-1",
      revisionId: "revision-1",
      operationId: "operation-1",
      kind: "agent",
      state: "dispatched",
      phase: "implementation",
      label: "Implement",
      ts: 19,
    },
  }),
  compatibilityFixture({
    family: "workflow-control",
    type: lilacEventTypes.EvtWorkflowProgressRequested,
    topic: "evt.workflow",
    key: "run-1",
    data: {
      runId: "run-1",
      revisionId: "revision-1",
      reason: "operation_changed",
      ts: 20,
    },
  }),
  compatibilityFixture({
    family: "workflow-control",
    type: lilacEventTypes.EvtWorkflowUsageChanged,
    topic: "evt.workflow",
    key: "run-1",
    data: {
      runId: "run-1",
      revisionId: "revision-1",
      operationId: "operation-1",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        agentCount: 1,
        activeAgents: 1,
      },
      ts: 21,
    },
  }),
  compatibilityFixture({
    family: "workflow-control",
    type: lilacEventTypes.EvtWorkflowResultReady,
    topic: "evt.workflow",
    key: "run-1",
    data: {
      runId: "run-1",
      revisionId: "revision-1",
      state: "succeeded",
      summary: "complete",
      resultArtifactId: "artifact-1",
      ts: 22,
    },
  }),
  compatibilityFixture({
    family: "command/request",
    type: lilacEventTypes.CmdAgentCreate,
    topic: "cmd.agent",
    key: "agent-1",
    data: { agentId: "agent-1", context: opaqueAgentContext },
  }),
  compatibilityFixture({
    family: "agent-output",
    type: lilacEventTypes.EvtAgentOutputDeltaReasoning,
    topic: "out.req.request-1",
    overrideTopic: "out.req.override-request-1",
    key: "request-1",
    headers: requestHeaders,
    data: { delta: "thinking", seq: 1 },
  }),
  compatibilityFixture({
    family: "agent-output",
    type: lilacEventTypes.EvtAgentOutputDeltaText,
    topic: "out.req.request-1",
    overrideTopic: "out.req.override-request-1",
    key: "request-1",
    headers: requestHeaders,
    data: { delta: "answer", phase: "final_answer", phaseBoundaryPrefixChars: 1, seq: 2 },
  }),
  compatibilityFixture({
    family: "agent-output",
    type: lilacEventTypes.EvtAgentOutputTextReset,
    topic: "out.req.request-1",
    overrideTopic: "out.req.override-request-1",
    key: "request-1",
    headers: requestHeaders,
    data: { text: "retained", phase: "commentary" },
  }),
  compatibilityFixture({
    family: "agent-output",
    type: lilacEventTypes.EvtAgentOutputResponseText,
    topic: "out.req.request-1",
    overrideTopic: "out.req.override-request-1",
    key: "request-1",
    headers: requestHeaders,
    data: {
      finalText: "answer",
      delivery: "reply",
      statsForNerdsLine: "15 tokens",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
  }),
  compatibilityFixture({
    family: "agent-output",
    type: lilacEventTypes.EvtAgentOutputResponseBinary,
    topic: "out.req.request-1",
    overrideTopic: "out.req.override-request-1",
    key: "request-1",
    headers: requestHeaders,
    data: { mimeType: "text/plain", dataBase64: "aGVsbG8=", filename: "hello.txt" },
  }),
  compatibilityFixture({
    family: "agent-output",
    type: lilacEventTypes.EvtAgentOutputToolCall,
    topic: "out.req.request-1",
    overrideTopic: "out.req.override-request-1",
    key: "request-1",
    headers: requestHeaders,
    data: { toolCallId: "tool-call-1", status: "end", display: "[bash] pwd", ok: true },
  }),
  compatibilityFixture({
    family: "agent-output",
    type: lilacEventTypes.EvtAgentOutputActivity,
    topic: "out.req.request-1",
    overrideTopic: "out.req.override-request-1",
    key: "request-1",
    headers: requestHeaders,
    data: { source: "subagent" },
  }),
] satisfies readonly CompatibilityFixture[];

class CapturingRawBus implements RawBus {
  readonly messages: PublishMessage<unknown>[] = [];

  async publish<TData>(
    message: PublishMessage<TData>,
    _options: PublishOptions,
  ): Promise<{ id: string; cursor: string }> {
    this.messages.push(message);
    return { id: "1736973100000-0", cursor: "1736973100000-0" };
  }

  async subscribe(_topic: string, _options: SubscriptionOptions, _handler: RawDeliveryHandler) {
    return Result.ok({
      done: Promise.resolve(Result.ok(undefined)),
      stop: async () => Result.ok(undefined),
    });
  }

  async fetch(
    _topic: string,
    _options: FetchOptions,
  ): Promise<{ messages: Array<{ msg: RawMessageDecodeOutcome; cursor: string }>; next?: string }> {
    return { messages: [] };
  }

  async close(): Promise<void> {}
}

function expectDecodeError(message: Message<unknown>, stage: LilacEventDecodeStage): void {
  const result = decodeLilacMessage(message);
  expect(result.status).toBe("error");
  if (result.status === "error") {
    expect(result.error._tag).toBe("LilacEventDecodeError");
    expect(result.error.stage).toBe(stage);
    expect(result.error.issues.length).toBeGreaterThan(0);
  }
}

describe("canonical Lilac event codecs", () => {
  it("registers one valid consumer fixture for every event type across all six families", () => {
    expect(Object.keys(lilacEventCodecRegistry)).toHaveLength(25);
    expect(Object.keys(lilacEventCodecRegistry).sort()).toEqual(
      Object.values(lilacEventTypes).sort(),
    );
    expect(compatibilityFixtures).toHaveLength(Object.values(lilacEventTypes).length);
    expect(compatibilityFixtures.map(({ type }) => type).sort()).toEqual(
      Object.values(lilacEventTypes).sort(),
    );
    expect(compatibilityFixtures.map(({ family }) => family)).toEqual(
      expect.arrayContaining<EventFamily>([
        "command/request",
        "workflow-control",
        "lifecycle",
        "adapter",
        "surface",
        "agent-output",
      ]),
    );
    expect(compatibilityFixtures.filter(({ family }) => family === "command/request")).toHaveLength(
      3,
    );
    expect(
      compatibilityFixtures.filter(({ family }) => family === "workflow-control"),
    ).toHaveLength(6);
    expect(compatibilityFixtures.filter(({ family }) => family === "lifecycle")).toHaveLength(2);
    expect(compatibilityFixtures.filter(({ family }) => family === "adapter")).toHaveLength(6);
    expect(compatibilityFixtures.filter(({ family }) => family === "surface")).toHaveLength(1);
    expect(compatibilityFixtures.filter(({ family }) => family === "agent-output")).toHaveLength(7);

    for (const fixture of compatibilityFixtures) {
      const result = decodeLilacMessage(fixture.message);
      expect(result.status, fixture.type).toBe("ok");
      if (result.status === "ok") expect<unknown>(result.value).toEqual(fixture.message);
    }
  });

  it("round-trips every producer fixture through createLilacBus, SuperJSON, and the consumer codec", async () => {
    for (const fixture of compatibilityFixtures) {
      const raw = new CapturingRawBus();
      await fixture.publish(createLilacBus(raw));
      expect(raw.messages, fixture.type).toHaveLength(1);

      const produced = raw.messages[0]!;
      expect(produced, fixture.type).toEqual({
        topic: fixture.message.topic,
        type: fixture.message.type,
        key: fixture.message.key,
        headers: fixture.message.headers,
        data: fixture.message.data,
      });
      expect(SuperJSON.stringify(produced.headers), fixture.type).toBe(
        SuperJSON.stringify(fixture.message.headers),
      );

      const wireMessage: Message<unknown> = {
        ...produced,
        id: fixture.message.id,
        ts: fixture.message.ts,
        data: SuperJSON.parse<unknown>(SuperJSON.stringify(produced.data)),
      };
      const decoded = decodeLilacMessage(wireMessage);
      expect(decoded.status, fixture.type).toBe("ok");
      if (decoded.status === "ok") expect<unknown>(decoded.value).toEqual(fixture.message);
    }

    const requestWire = SuperJSON.parse<unknown>(SuperJSON.stringify(opaqueRequestRaw));
    if (typeof requestWire !== "object" || requestWire === null) {
      throw new Error("Expected opaque request wire data to remain an object");
    }
    expect("url" in requestWire && requestWire.url).toBeInstanceOf(URL);
    expect("receivedAt" in requestWire && requestWire.receivedAt).toBeInstanceOf(Date);
  });

  it("round-trips legal topic and key publish overrides for every event type", async () => {
    for (const fixture of compatibilityFixtures) {
      const raw = new CapturingRawBus();
      await fixture.publishWithOverrides(createLilacBus(raw));
      expect(raw.messages, fixture.type).toHaveLength(1);

      const produced = raw.messages[0]!;
      const wireMessage: Message<unknown> = {
        ...produced,
        id: fixture.overrideMessage.id,
        ts: fixture.overrideMessage.ts,
        data: SuperJSON.parse<unknown>(SuperJSON.stringify(produced.data)),
      };
      const decoded = decodeLilacMessage(wireMessage);
      expect(decoded.status, fixture.type).toBe("ok");
      if (decoded.status === "ok") {
        expect<unknown>(decoded.value).toEqual(fixture.overrideMessage);
      }
    }
  });

  it("rejects malformed envelopes and unknown event types", () => {
    expectDecodeError(
      envelope({ type: "evt.future.created", topic: "evt.future", key: "future-1", data: {} }),
      "event_type",
    );
    expectDecodeError(
      { ...compatibilityFixtures[0]!.message, id: "", ts: Number.POSITIVE_INFINITY },
      "envelope",
    );
    const missingData = { ...compatibilityFixtures[0]!.message };
    Reflect.deleteProperty(missingData, "data");
    expectDecodeError(missingData, "envelope");

    const hostileEnvelope = new Proxy(compatibilityFixtures[0]!.message, {
      get(target, property, receiver) {
        if (property === "topic") throw new Error("hostile envelope getter");
        return Reflect.get(target, property, receiver);
      },
    });
    expectDecodeError(hostileEnvelope, "envelope");
  });

  it("rejects non-string extension headers and invalid canonical headers", () => {
    const nonStringExtension = { ...compatibilityFixtures[0]!.message };
    Reflect.set(nonStringExtension, "headers", { request_id: "request-1", attempt: 2 });
    expectDecodeError(nonStringExtension, "headers");

    const invalidClient = { ...compatibilityFixtures[0]!.message };
    Reflect.set(invalidClient, "headers", {
      request_id: "request-1",
      request_client: "carrier-pigeon",
    });
    expectDecodeError(invalidClient, "headers");

    const missingRequestId = { ...compatibilityFixtures[0]!.message };
    Reflect.set(missingRequestId, "headers", { session_id: "session-1" });
    expectDecodeError(missingRequestId, "headers");

    for (const index of [0, 1, 9, 10, 11, 18, 19, 20, 21, 22, 23, 24]) {
      const requestScopedMessage = { ...compatibilityFixtures[index]!.message };
      Reflect.set(requestScopedMessage, "headers", {});
      expectDecodeError(requestScopedMessage, "headers");
    }
  });

  it("rejects a malformed complete payload fixture for every event type without throwing", () => {
    for (const fixture of compatibilityFixtures) {
      expectDecodeError({ ...fixture.message, data: fixture.malformedData }, "payload");
    }

    const malformed = { ...compatibilityFixtures[12]!.message };
    Reflect.set(malformed, "data", {
      runId: "run-1",
      revisionId: "revision-1",
      state: "teleported",
      ts: Number.NaN,
    });
    expectDecodeError(malformed, "payload");

    const missingContext = envelope({
      type: lilacEventTypes.CmdAgentCreate,
      topic: "cmd.agent",
      key: "agent-1",
      data: { agentId: "agent-1" },
    });
    expectDecodeError(missingContext, "payload");

    expectDecodeError(
      { ...compatibilityFixtures[10]!.message, data: { unexpected: true } },
      "payload",
    );

    const hostilePayload = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile payload getter");
        },
      },
    );
    expectDecodeError({ ...compatibilityFixtures[0]!.message, data: hostilePayload }, "payload");
  });

  it("enforces static and request-output topic coherence", () => {
    expectDecodeError({ ...compatibilityFixtures[12]!.message, topic: "evt.request" }, "topic");
    expectDecodeError({ ...compatibilityFixtures[19]!.message, topic: "evt.request" }, "topic");
    expectDecodeError({ ...compatibilityFixtures[19]!.message, topic: "out.req." }, "topic");
  });

  it("accepts override keys and requires a non-empty string key", () => {
    const overridden = decodeLilacMessage({
      ...compatibilityFixtures[0]!.message,
      key: "request-2",
    });
    expect(overridden.status).toBe("ok");

    expectDecodeError({ ...compatibilityFixtures[2]!.message, key: "" }, "key");
    const nonStringKey = { ...compatibilityFixtures[7]!.message };
    Reflect.set(nonStringKey, "key", 2);
    expectDecodeError(nonStringKey, "key");
    const missingKey = { ...compatibilityFixtures[17]!.message };
    delete missingKey.key;
    expectDecodeError(missingKey, "key");
  });

  it("preserves intentionally opaque raw and context values", () => {
    const raw = { nested: new Map([["key", { value: 1 }]]) };
    const rawMessage = envelope({
      type: lilacEventTypes.EvtAdapterMessageCreated,
      topic: "evt.adapter",
      key: "message-opaque",
      data: {
        platform: "discord",
        channelId: "channel-1",
        messageId: "message-opaque",
        userId: "user-1",
        text: "hello",
        ts: 1,
        raw,
      },
    });
    const rawResult = decodeLilacMessage(rawMessage);
    expect(rawResult.status).toBe("ok");
    if (rawResult.status === "ok" && "raw" in rawResult.value.data) {
      expect(rawResult.value.data.raw).toBe(raw);
    }

    const context = { callback: () => "opaque", token: Symbol("token") };
    const contextMessage = envelope({
      type: lilacEventTypes.CmdAgentCreate,
      topic: "cmd.agent",
      key: "agent-opaque",
      data: { agentId: "agent-opaque", context },
    });
    const contextResult = decodeLilacMessage(contextMessage);
    expect(contextResult.status).toBe("ok");
    if (contextResult.status === "ok" && "context" in contextResult.value.data) {
      expect(contextResult.value.data.context).toBe(context);
    }
  });

  it("preserves Panic from decoder internals", () => {
    const panic = new Panic({ message: "schema invariant failed" });
    const data = new Proxy(
      {},
      {
        get() {
          throw panic;
        },
      },
    );
    const message = envelope({
      type: lilacEventTypes.CmdRequestMessage,
      topic: "cmd.request",
      key: "request-1",
      headers: { request_id: "request-1" },
      data,
    });

    expect(() => decodeLilacMessage(message)).toThrow(panic);
  });
});
