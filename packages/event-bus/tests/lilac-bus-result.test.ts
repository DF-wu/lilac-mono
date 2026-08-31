import { describe, expect, it } from "bun:test";
import { Panic, Result, TaggedError } from "better-result";

import {
  createLilacBus,
  lilacEventTypes,
  type FetchOptions,
  type LilacBus,
  type PublishMessage,
  type PublishOptions,
  type RawBus,
  type RawDeliveryHandler,
} from "../index";

type PublicResultHandler = Parameters<LilacBus["subscribeTopic"]>[2];
type PublicResultHandlerContext = Parameters<PublicResultHandler>[1];
type PublicResultHandlerHasNoAck = "commit" extends keyof PublicResultHandlerContext ? false : true;

const PUBLIC_RESULT_HANDLER_HAS_NO_ACK: PublicResultHandlerHasNoAck = true;

class DeliveryPolicyFailure extends TaggedError("DeliveryPolicyFailure")<{
  readonly message: string;
}> {}

function rawBusWithFetch(
  fetch: RawBus["fetch"],
  subscribe: RawBus["subscribe"] = async () =>
    Result.ok({
      done: Promise.resolve(Result.ok(undefined)),
      stop: async () => Result.ok(undefined),
    }),
): RawBus {
  return {
    publish: async <TData>(_message: PublishMessage<TData>, _options: PublishOptions) => ({
      id: "1-0",
      cursor: "1-0",
    }),
    subscribe,
    fetch,
    close: async () => {},
  };
}

describe("LilacBus Result APIs", () => {
  it("returns publish contract and transport failures as owned Results", async () => {
    const raw = rawBusWithFetch(async () => ({ messages: [] }));
    const bus = createLilacBus(raw);
    const missingRequestId = await bus.publish(lilacEventTypes.CmdRequestMessage, {
      requestDeliveryId: crypto.randomUUID(),
      queue: "prompt",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(missingRequestId.status).toBe("error");
    if (missingRequestId.status === "error") {
      expect(missingRequestId.error._tag).toBe("EventPublishContractInvalid");
    }

    raw.publish = async () => {
      throw new Error("redis unavailable");
    };
    const failed = await bus.publish(lilacEventTypes.EvtWorkflowRunChanged, {
      runId: "run-1",
      revisionId: "revision-1",
      state: "running",
      previousState: "queued",
      ts: 1,
    });
    expect(failed.status).toBe("error");
    if (failed.status === "error") expect(failed.error._tag).toBe("EventPublishTransportFailed");
  });

  it("preserves Panic from the raw publish boundary", async () => {
    const panic = new Panic({ message: "raw publish invariant" });
    const raw = rawBusWithFetch(async () => ({ messages: [] }));
    raw.publish = async () => {
      throw panic;
    };
    await expect(
      createLilacBus(raw).publish(lilacEventTypes.EvtWorkflowRunChanged, {
        runId: "run-1",
        revisionId: "revision-1",
        state: "running",
        previousState: "queued",
        ts: 1,
      }),
    ).rejects.toBe(panic);
  });

  it("returns owned failures for unsupported and failed request publication claim operations", async () => {
    const raw = rawBusWithFetch(async () => ({ messages: [] }));
    const bus = createLilacBus(raw);
    const requestDeliveryId = crypto.randomUUID();
    const claim = { requestDeliveryId, token: crypto.randomUUID() };
    const data = {
      requestDeliveryId,
      queue: "prompt" as const,
      messages: [{ role: "user" as const, content: "hello" }],
    };
    const options = { headers: { request_id: "request-claim-result" } };

    const unsupportedAcquire = await bus.acquireRequestPublicationClaim(requestDeliveryId);
    expect(unsupportedAcquire.status).toBe("error");
    if (unsupportedAcquire.status === "error") {
      expect(unsupportedAcquire.error._tag).toBe("EventRequestPublicationClaimUnsupported");
      expect(unsupportedAcquire.error.operation).toBe("acquire");
    }
    const unsupportedPublish = await bus.publishClaimedRequest(data, claim, options);
    expect(unsupportedPublish.status).toBe("error");
    if (unsupportedPublish.status === "error") {
      expect(unsupportedPublish.error._tag).toBe("EventRequestPublicationClaimUnsupported");
    }
    expect(await bus.confirmRequestPublication(claim, "1-0")).toMatchObject({
      status: "error",
      error: { _tag: "EventRequestPublicationConfirmationUnsupported" },
    });
    expect(await bus.abandonRequestPublicationClaim(claim)).toMatchObject({
      status: "error",
      error: {
        _tag: "EventRequestPublicationClaimUnsupported",
        operation: "abandon",
      },
    });

    raw.acquireRequestPublicationClaim = async () => {
      throw new Error("redis unavailable");
    };
    const failedAcquire = await bus.acquireRequestPublicationClaim(requestDeliveryId);
    expect(failedAcquire.status).toBe("error");
    if (failedAcquire.status === "error") {
      expect(failedAcquire.error._tag).toBe("EventRequestPublicationClaimFailed");
    }
  });

  it("returns unsupported topic operations as owned Results", async () => {
    const bus = createLilacBus(rawBusWithFetch(async () => ({ messages: [] })));
    expect((await bus.getTopicWatermark("evt.adapter")).status).toBe("error");
    expect((await bus.trimTopicBeforeCheckpoint("evt.adapter", "1-0", 10)).status).toBe("error");
    expect((await bus.retireTopicConsumerGroup("evt.adapter", "old-group")).status).toBe("error");
  });

  it("reports present, absent, uncertain, and unavailable output stream expiry outcomes", async () => {
    const raw = rawBusWithFetch(async () => ({ messages: [] }));
    const bus = createLilacBus(raw);

    const unsupported = await bus.getOutputStreamExpiry("request-unsupported");
    expect(unsupported.status).toBe("error");
    if (unsupported.status === "error") {
      expect(unsupported.error._tag).toBe("EventOutputStreamExpiryUnavailable");
      expect(unsupported.error.reason).toBe("unsupported");
    }

    raw.readOutputStreamExpiry = async (topic) => ({
      kind: "present",
      expiresAt: topic === "out.req.request-present" ? 123_456 : 654_321,
    });
    expect(await bus.getOutputStreamExpiry("request-present")).toEqual(
      Result.ok({ kind: "present", expiresAt: 123_456 }),
    );

    raw.readOutputStreamExpiry = async () => ({ kind: "absent" });
    expect(await bus.getOutputStreamExpiry("request-absent")).toEqual(
      Result.ok({ kind: "absent" }),
    );

    raw.readOutputStreamExpiry = async () => ({
      kind: "uncertain",
      reason: "stream-has-no-expiry",
    });
    const uncertain = await bus.getOutputStreamExpiry("request-uncertain");
    expect(uncertain.status).toBe("error");
    if (uncertain.status === "error") expect(uncertain.error.reason).toBe("expiry-uncertain");

    raw.readOutputStreamExpiry = async () => {
      throw new Error("redis unavailable");
    };
    const unavailable = await bus.getOutputStreamExpiry("request-unavailable");
    expect(unavailable.status).toBe("error");
    if (unavailable.status === "error") {
      expect(unavailable.error.reason).toBe("transport-unavailable");
    }
  });

  it("returns raw close rejection as an owned Result", async () => {
    const raw = rawBusWithFetch(async () => ({ messages: [] }));
    raw.close = async () => {
      throw new Error("close failed");
    };
    const closed = await createLilacBus(raw).close();
    expect(closed.status).toBe("error");
    if (closed.status === "error") expect(closed.error._tag).toBe("EventBusCloseFailed");
  });

  it("keeps acknowledgement out of the public Result handler API", async () => {
    let rawHandler: RawDeliveryHandler | undefined;
    const raw = rawBusWithFetch(
      async () => ({ messages: [] }),
      async (_topic, _options, handler) => {
        rawHandler = handler;
        return Result.ok({
          done: Promise.resolve(Result.ok(undefined)),
          stop: async () => Result.ok(undefined),
        });
      },
    );
    let handlerContextHasAck = true;
    const started = await createLilacBus(raw).subscribeTopic(
      "cmd.request",
      { mode: "tail", offset: { type: "begin" } },
      async (_message, context) => {
        handlerContextHasAck = "commit" in context;
        return Result.ok(undefined);
      },
      () => "commit",
    );
    expect(started.status).toBe("ok");
    expect(PUBLIC_RESULT_HANDLER_HAS_NO_ACK).toBe(true);
    if (!rawHandler) throw new Error("Raw delivery handler was not captured");

    const action = await rawHandler(
      {
        topic: "cmd.request",
        id: "1-0",
        type: "cmd.request.message",
        ts: 1,
        key: "request-1",
        headers: { request_id: "request-1" },
        data: {
          requestDeliveryId: crypto.randomUUID(),
          queue: "prompt",
          messages: [{ role: "user", content: "hello" }],
        },
      },
      {
        cursor: "1-0",
        mode: "tail",
        evidence: {
          source: {
            transport: "redis-streams",
            streamKey: "test:cmd.request",
            topic: "cmd.request",
            messageId: "1-0",
          },
          wire: { kind: "bounded-complete", fields: [] },
        },
      },
    );
    expect(handlerContextHasAck).toBe(false);
    expect(action).toEqual({ disposition: "commit" });
  });

  it("preserves Panic identity from the delivery policy", async () => {
    let rawHandler: RawDeliveryHandler | undefined;
    const raw = rawBusWithFetch(
      async () => ({ messages: [] }),
      async (_topic, _options, handler) => {
        rawHandler = handler;
        return Result.ok({
          done: Promise.resolve(Result.ok(undefined)),
          stop: async () => Result.ok(undefined),
        });
      },
    );
    const panic = new Panic({ message: "delivery policy invariant" });
    await createLilacBus(raw).subscribeTopic(
      "cmd.request",
      { mode: "tail", offset: { type: "begin" } },
      async () => Result.err(new DeliveryPolicyFailure({ message: "rejected" })),
      () => {
        throw panic;
      },
    );
    if (!rawHandler) throw new Error("Raw delivery handler was not captured");

    await expect(
      rawHandler(
        {
          topic: "cmd.request",
          id: "1-0",
          type: "cmd.request.message",
          ts: 1,
          key: "request-1",
          headers: { request_id: "request-1" },
          data: {
            requestDeliveryId: crypto.randomUUID(),
            queue: "prompt",
            messages: [{ role: "user", content: "hello" }],
          },
        },
        {
          cursor: "1-0",
          mode: "tail",
          evidence: {
            source: {
              transport: "redis-streams",
              streamKey: "test:cmd.request",
              topic: "cmd.request",
              messageId: "1-0",
            },
            wire: { kind: "bounded-complete", fields: [] },
          },
        },
      ),
    ).rejects.toBe(panic);
  });

  it("returns invalid contracts as typed errors and redacts diagnostic payloads", async () => {
    const secret = "secret-payload-sentinel";
    const diagnostics: unknown[] = [];
    const raw = rawBusWithFetch(async (_topic: string, _options: FetchOptions) => ({
      messages: [
        {
          cursor: "1-0",
          msg: {
            topic: "cmd.request",
            id: "1-0",
            type: "secret-type-sentinel",
            ts: 1,
            data: { secret },
          },
        },
      ],
      next: "1-0",
    }));
    const bus = createLilacBus(raw, {
      logger: {
        warn: (event, context) => diagnostics.push({ event, context }),
        error: () => {},
      },
    });

    const fetched = await bus.fetchTopic("cmd.request", {
      offset: { type: "begin" },
    });
    expect(fetched.status).toBe("error");
    if (fetched.status === "error") expect(fetched.error._tag).toBe("EventFetchContractInvalid");
    expect(diagnostics).toEqual([
      {
        event: "event_bus.contract_invalid",
        context: {
          topic: "cmd.request",
          cursor: "1-0",
          source: "contract",
          stage: "event_type",
          eventType: "<unknown>",
        },
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    expect(JSON.stringify(diagnostics)).not.toContain("secret-type-sentinel");
  });

  it("captures raw fetch rejection as a transport Result", async () => {
    const raw = rawBusWithFetch(async () => {
      throw new Error("redis unavailable");
    });
    const fetched = await createLilacBus(raw).fetchTopic("cmd.request", {
      offset: { type: "begin" },
    });
    expect(fetched.status).toBe("error");
    if (fetched.status === "error") expect(fetched.error._tag).toBe("EventFetchTransportFailed");
  });
});
