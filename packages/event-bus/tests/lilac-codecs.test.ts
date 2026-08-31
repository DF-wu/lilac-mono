import { describe, expect, it } from "bun:test";
import { Panic, Result } from "better-result";
import SuperJSON from "superjson";

import {
  createLilacBus,
  decodeLilacMessage,
  LILAC_EVENTS,
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
  | "command-request"
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
    family: "command-request",
    type: "cmd.request.message",
    topic: "cmd.request",
    key: "request-1",
    headers: requestHeaders,
    data: {
      requestDeliveryId: crypto.randomUUID(),
      queue: "prompt",
      messages: [{ role: "user", content: "hello" }],
      corePrimaryLineage: undefined,
      modelOverride: "openai/gpt-5",
      raw: opaqueRequestRaw,
    },
  }),
  compatibilityFixture({
    family: "command-request",
    type: "cmd.surface.output.reanchor",
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
    type: "evt.adapter.message.created",
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
    type: "evt.adapter.message.updated",
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
    type: "evt.adapter.message.deleted",
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
    type: "evt.adapter.reaction.added",
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
    type: "evt.adapter.reaction.removed",
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
    type: "evt.adapter.action.invoked",
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
    type: "evt.adapter.workflow-wait-resolver.barrier",
    topic: "evt.adapter",
    key: "barrier-1",
    data: { barrierId: "barrier-1", ts: 16 },
  }),
  compatibilityFixture({
    family: "lifecycle",
    type: "evt.request.lifecycle.changed",
    topic: "evt.request",
    key: "request-1",
    headers: requestHeaders,
    data: { state: "running", detail: "started", ts: 17 },
  }),
  compatibilityFixture({
    family: "lifecycle",
    type: "evt.request.reply",
    topic: "evt.request",
    key: "request-1",
    headers: { request_id: "request-1" },
    data: {},
  }),
  compatibilityFixture({
    family: "surface",
    type: "evt.surface.output.message.created",
    topic: "evt.surface",
    key: "request-1",
    headers: requestHeaders,
    data: {
      msgRef: { platform: "discord", channelId: "channel-1", messageId: "output-1" },
    },
  }),
  compatibilityFixture({
    family: "workflow-control",
    type: "evt.workflow.run.changed",
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
    type: "evt.workflow.operation.changed",
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
    type: "evt.workflow.progress.requested",
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
    type: "evt.workflow.usage.changed",
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
    type: "evt.workflow.result.ready",
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
    family: "command-request",
    type: "cmd.agent.create",
    topic: "cmd.agent",
    key: "agent-1",
    data: { agentId: "agent-1", context: opaqueAgentContext },
  }),
  compatibilityFixture({
    family: "agent-output",
    type: "evt.agent.output.delta.reasoning",
    topic: "out.req.request-1",
    overrideTopic: "out.req.override-request-1",
    key: "request-1",
    headers: requestHeaders,
    data: { delta: "thinking", seq: 1 },
  }),
  compatibilityFixture({
    family: "agent-output",
    type: "evt.agent.output.delta.text",
    topic: "out.req.request-1",
    overrideTopic: "out.req.override-request-1",
    key: "request-1",
    headers: requestHeaders,
    data: { delta: "answer", phase: "final_answer", phaseBoundaryPrefixChars: 1, seq: 2 },
  }),
  compatibilityFixture({
    family: "agent-output",
    type: "evt.agent.output.text.reset",
    topic: "out.req.request-1",
    overrideTopic: "out.req.override-request-1",
    key: "request-1",
    headers: requestHeaders,
    data: { text: "retained", phase: "commentary" },
  }),
  compatibilityFixture({
    family: "agent-output",
    type: "evt.agent.output.response.text",
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
    type: "evt.agent.output.response.binary",
    topic: "out.req.request-1",
    overrideTopic: "out.req.override-request-1",
    key: "request-1",
    headers: requestHeaders,
    data: {
      blob: { version: 1, objectId: `b1_${"ab".repeat(16)}` },
      mimeType: "text/plain",
      filename: "hello.txt",
    },
  }),
  compatibilityFixture({
    family: "agent-output",
    type: "evt.agent.output.toolcall",
    topic: "out.req.request-1",
    overrideTopic: "out.req.override-request-1",
    key: "request-1",
    headers: requestHeaders,
    data: { toolCallId: "tool-call-1", status: "end", display: "[bash] pwd", ok: true },
  }),
  compatibilityFixture({
    family: "agent-output",
    type: "evt.agent.output.activity",
    topic: "out.req.request-1",
    overrideTopic: "out.req.override-request-1",
    key: "request-1",
    headers: requestHeaders,
    data: { source: "subagent" },
  }),
] satisfies readonly CompatibilityFixture[];

function compatibilityFixtureFor(type: LilacEventType): CompatibilityFixture {
  const fixture = compatibilityFixtures.find((candidate) => candidate.type === type);
  if (fixture === undefined) throw new Error(`Missing compatibility fixture for ${type}`);
  return fixture;
}

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
        "command-request",
        "workflow-control",
        "lifecycle",
        "adapter",
        "surface",
        "agent-output",
      ]),
    );
    expect(compatibilityFixtures.filter(({ family }) => family === "command-request")).toHaveLength(
      3,
    );
    expect(
      compatibilityFixtures.filter(({ family }) => family === "workflow-control"),
    ).toHaveLength(6);
    expect(compatibilityFixtures.filter(({ family }) => family === "lifecycle")).toHaveLength(2);
    expect(compatibilityFixtures.filter(({ family }) => family === "adapter")).toHaveLength(6);
    expect(compatibilityFixtures.filter(({ family }) => family === "surface")).toHaveLength(1);
    expect(compatibilityFixtures.filter(({ family }) => family === "agent-output")).toHaveLength(7);
    expect(new Set(Object.values(LILAC_EVENTS).map(({ family }) => family))).toEqual(
      new Set<EventFamily>([
        "command-request",
        "workflow-control",
        "lifecycle",
        "adapter",
        "surface",
        "agent-output",
      ]),
    );

    for (const fixture of compatibilityFixtures) {
      const definition = Object.values(LILAC_EVENTS).find(({ type }) => type === fixture.type);
      expect(definition?.family, fixture.type).toBe(fixture.family);
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
    for (const type of ["evt.future.created", "constructor", "toString", "__proto__"]) {
      expectDecodeError(
        envelope({ type, topic: "evt.future", key: "future-1", data: {} }),
        "event_type",
      );
    }
    const requestFixture = compatibilityFixtureFor(lilacEventTypes.CmdRequestMessage);
    expectDecodeError(
      { ...requestFixture.message, id: "", ts: Number.POSITIVE_INFINITY },
      "envelope",
    );
    const missingData = { ...requestFixture.message };
    Reflect.deleteProperty(missingData, "data");
    expectDecodeError(missingData, "envelope");

    const hostileEnvelope = new Proxy(requestFixture.message, {
      get(target, property, receiver) {
        if (property === "topic") throw new Error("hostile envelope getter");
        return Reflect.get(target, property, receiver);
      },
    });
    expectDecodeError(hostileEnvelope, "envelope");
  });

  it("rejects non-string extension headers and invalid canonical headers", () => {
    const requestFixture = compatibilityFixtureFor(lilacEventTypes.CmdRequestMessage);
    const nonStringExtension = { ...requestFixture.message };
    Reflect.set(nonStringExtension, "headers", { request_id: "request-1", attempt: 2 });
    expectDecodeError(nonStringExtension, "headers");

    const invalidClient = { ...requestFixture.message };
    Reflect.set(invalidClient, "headers", {
      request_id: "request-1",
      request_client: "carrier-pigeon",
    });
    expectDecodeError(invalidClient, "headers");

    const missingRequestId = { ...requestFixture.message };
    Reflect.set(missingRequestId, "headers", { session_id: "session-1" });
    expectDecodeError(missingRequestId, "headers");

    for (const fixture of compatibilityFixtures.filter(
      ({ type }) => lilacEventCodecRegistry[type].requiresRequestId,
    )) {
      const requestScopedMessage = { ...fixture.message };
      Reflect.set(requestScopedMessage, "headers", {});
      expectDecodeError(requestScopedMessage, "headers");
    }
  });

  it("rejects a malformed complete payload fixture for every event type without throwing", () => {
    for (const fixture of compatibilityFixtures) {
      expectDecodeError({ ...fixture.message, data: fixture.malformedData }, "payload");
    }

    const malformed = {
      ...compatibilityFixtureFor(lilacEventTypes.EvtWorkflowRunChanged).message,
    };
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
      {
        ...compatibilityFixtureFor(lilacEventTypes.EvtRequestReply).message,
        data: { unexpected: true },
      },
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
    expectDecodeError(
      {
        ...compatibilityFixtureFor(lilacEventTypes.CmdRequestMessage).message,
        data: hostilePayload,
      },
      "payload",
    );
  });

  it("accepts only handle-bearing request and binary-output content", async () => {
    const request = compatibilityFixtureFor(lilacEventTypes.CmdRequestMessage).message;
    for (const content of [
      [{ type: "file", data: "aGVsbG8=", mediaType: "text/plain" }],
      [{ type: "image", image: new Uint8Array([1, 2, 3]), mediaType: "image/png" }],
      [{ type: "file", data: "data:text/plain;base64,aGVsbG8=", mediaType: "text/plain" }],
    ]) {
      expectDecodeError(
        {
          ...request,
          data: {
            requestDeliveryId: crypto.randomUUID(),
            queue: "prompt",
            messages: [{ role: "user", content }],
          },
        },
        "payload",
      );
    }
    for (const raw of [
      { dataBase64: "aGVsbG8=" },
      { bytes: new Uint8Array([1, 2, 3]) },
      { source: "data:text/plain;base64,aGVsbG8=" },
    ]) {
      expectDecodeError(
        {
          ...request,
          data: {
            requestDeliveryId: crypto.randomUUID(),
            queue: "prompt",
            messages: [{ role: "user", content: "hello" }],
            raw,
          },
        },
        "payload",
      );
    }

    const binary = compatibilityFixtureFor(lilacEventTypes.EvtAgentOutputResponseBinary).message;
    expectDecodeError(
      { ...binary, data: { mimeType: "text/plain", dataBase64: "aGVsbG8=" } },
      "payload",
    );

    const raw = new CapturingRawBus();
    const rejectedPublish = await createLilacBus(raw).publish(
      lilacEventTypes.CmdRequestMessage,
      {
        requestDeliveryId: crypto.randomUUID(),
        queue: "prompt",
        messages: [{ role: "user", content: "hello" }],
        raw: { bytes: new Uint8Array([1]) },
      },
      { headers: { request_id: "request-1" } },
    );
    expect(rejectedPublish.status).toBe("error");
    expect(raw.messages).toEqual([]);
  });

  it("enforces static and request-output topic coherence", () => {
    const workflowFixture = compatibilityFixtureFor(lilacEventTypes.EvtWorkflowRunChanged);
    const outputFixture = compatibilityFixtureFor(lilacEventTypes.EvtAgentOutputDeltaText);
    expectDecodeError({ ...workflowFixture.message, topic: "evt.request" }, "topic");
    expectDecodeError({ ...outputFixture.message, topic: "evt.request" }, "topic");
    expectDecodeError({ ...outputFixture.message, topic: "out.req." }, "topic");
  });

  it("accepts override keys and requires a non-empty string key", () => {
    const overridden = decodeLilacMessage({
      ...compatibilityFixtureFor(lilacEventTypes.CmdRequestMessage).message,
      key: "request-2",
    });
    expect(overridden.status).toBe("ok");

    expectDecodeError(
      { ...compatibilityFixtureFor(lilacEventTypes.EvtAdapterMessageCreated).message, key: "" },
      "key",
    );
    const nonStringKey = {
      ...compatibilityFixtureFor(lilacEventTypes.EvtAdapterActionInvoked).message,
    };
    Reflect.set(nonStringKey, "key", 2);
    expectDecodeError(nonStringKey, "key");
    const missingKey = { ...compatibilityFixtureFor(lilacEventTypes.CmdAgentCreate).message };
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
