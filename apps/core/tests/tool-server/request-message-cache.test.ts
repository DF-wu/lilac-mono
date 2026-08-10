import { describe, expect, it } from "bun:test";
import { lilacEventTypes, type LilacMessageForTopic } from "@stanley2058/lilac-event-bus";

import {
  createRequestMessageCache,
  type AuthenticatedRequestOrigin,
} from "../../src/tool-server/request-message-cache";

function requestMessage(input: {
  readonly eventId: string;
  readonly requestId: string;
  readonly sessionId?: string;
  readonly requestClient?: "discord" | "github" | "unknown";
  readonly text?: string;
  readonly raw?: Record<string, unknown>;
}): LilacMessageForTopic<"cmd.request"> {
  return {
    id: input.eventId,
    topic: "cmd.request",
    type: lilacEventTypes.CmdRequestMessage,
    ts: 100,
    key: input.requestId,
    headers: {
      request_id: input.requestId,
      session_id: input.sessionId ?? "channel-1",
      request_client: input.requestClient ?? "discord",
    },
    data: {
      queue: "prompt",
      messages: [{ role: "user", content: input.text ?? input.eventId }],
      ...(input.raw ? { raw: input.raw } : {}),
    },
  };
}

function trustedUnknownProjection(input: {
  readonly requestId: string;
  readonly sessionId: string;
}): AuthenticatedRequestOrigin {
  return {
    requestId: input.requestId,
    requestClient: "unknown",
    sessionId: input.sessionId,
    source: "internal-delegated",
    authenticatedOrigin: {
      platform: "discord",
      userId: "user-1",
      sessionRef: { platform: "discord", channelId: "channel-1" },
    },
    authenticationMetadataKind: "origin",
    verifiedIngress: false,
  };
}

describe("request message cache", () => {
  it("has no independent bus subscription and accepts runner ingestion synchronously", () => {
    const cache = createRequestMessageCache();
    const message = requestMessage({ eventId: "1-0", requestId: "request-1" });
    expect(cache.cacheMessage(message).status).toBe("ok");
    expect(cache.get("request-1")).toHaveLength(1);
  });

  it("keeps slow intake alive beyond TTL and releases it after committed handling", () => {
    let now = 100;
    const cache = createRequestMessageCache({ ttlMs: 5, now: () => now });
    const message = requestMessage({ eventId: "1-0", requestId: "slow" });
    expect(cache.cacheMessage(message).status).toBe("ok");
    now = 1_000;
    expect(cache.get("slow")).toBeDefined();
    cache.finishDelivery({ requestId: "slow", eventId: message.id, disposition: "release" });
    expect(cache.get("slow")).toBeUndefined();
  });

  it("retains a parked event and dedupes its redelivery", () => {
    const cache = createRequestMessageCache();
    const message = requestMessage({ eventId: "1-0", requestId: "parked" });
    expect(cache.cacheMessage(message).status).toBe("ok");
    cache.finishDelivery({ requestId: "parked", eventId: message.id, disposition: "park" });
    expect(cache.snapshot("parked")).toMatchObject({
      ownerCount: 0,
      eventIdCount: 1,
      parkedEventIds: [message.id],
    });
    expect(cache.cacheMessage(message).status).toBe("ok");
    expect(cache.get("parked")).toHaveLength(1);
    cache.finishDelivery({ requestId: "parked", eventId: message.id, disposition: "release" });
    expect(cache.get("parked")).toBeUndefined();
  });

  it("bounds messages and dedupe IDs during a long active request", () => {
    const cache = createRequestMessageCache();
    const first = requestMessage({ eventId: "0-0", requestId: "active" });
    const admitted = cache.cacheMessage(first);
    if (admitted.status === "error") throw admitted.error;
    const owner = cache.acquireOwner("active");
    if (owner.status === "error") throw owner.error;
    cache.finishDelivery({ requestId: "active", eventId: first.id, disposition: "release" });
    for (let index = 1; index < 700; index += 1) {
      const message = requestMessage({ eventId: `${index}-0`, requestId: "active" });
      expect(cache.cacheMessage(message).status).toBe("ok");
      cache.finishDelivery({ requestId: "active", eventId: message.id, disposition: "release" });
    }
    expect(cache.get("active")).toHaveLength(512);
    expect(cache.snapshot("active")?.eventIdCount).toBe(0);
    expect(cache.releaseOwner(owner.value)).toBe(true);
    expect(cache.get("active")).toBeUndefined();
  });

  it.each([
    ["first then second", ["1-0", "2-0"]],
    ["second then first", ["2-0", "1-0"]],
  ] as const)("retains two parked deliveries when recovering %s", (_, recoveryOrder) => {
    const cache = createRequestMessageCache();
    const first = requestMessage({ eventId: "1-0", requestId: "two-parked" });
    const second = requestMessage({ eventId: "2-0", requestId: "two-parked" });
    expect(cache.cacheMessage(first).status).toBe("ok");
    cache.finishDelivery({ requestId: "two-parked", eventId: first.id, disposition: "park" });
    expect(cache.cacheMessage(second).status).toBe("ok");
    cache.finishDelivery({ requestId: "two-parked", eventId: second.id, disposition: "park" });
    expect(cache.snapshot("two-parked")).toMatchObject({
      ownerCount: 0,
      eventIdCount: 2,
      parkedEventIds: ["1-0", "2-0"],
    });

    const messages = new Map([
      [first.id, first],
      [second.id, second],
    ]);
    const recoveredFirst = messages.get(recoveryOrder[0]);
    if (!recoveredFirst) throw new Error("missing first recovery message");
    expect(cache.cacheMessage(recoveredFirst).status).toBe("ok");
    cache.finishDelivery({
      requestId: "two-parked",
      eventId: recoveredFirst.id,
      disposition: "release",
    });
    expect(cache.snapshot("two-parked")).toMatchObject({
      eventIdCount: 1,
      parkedEventIds: [recoveryOrder[1]],
    });

    const recoveredSecond = messages.get(recoveryOrder[1]);
    if (!recoveredSecond) throw new Error("missing second recovery message");
    expect(cache.cacheMessage(recoveredSecond).status).toBe("ok");
    cache.finishDelivery({
      requestId: "two-parked",
      eventId: recoveredSecond.id,
      disposition: "release",
    });
    expect(cache.get("two-parked")).toBeUndefined();
  });

  it("refcounts canonical self aliases and releases each owner exactly once", () => {
    const cache = createRequestMessageCache();
    const message = requestMessage({
      eventId: "1-0",
      requestId: "discord:channel-1:message-1",
      raw: {
        authenticatedOrigin: {
          platform: "discord",
          userId: "user-1",
          messageRef: { platform: "discord", channelId: "channel-1", messageId: "message-1" },
        },
      },
    });
    const admitted = cache.cacheMessage(message);
    if (admitted.status === "error") throw admitted.error;
    const current = cache.acquireOwner(message.key);
    if (current.status === "error") throw current.error;
    const queued = cache.createAliasOwner({
      sourceRequestId: message.key,
      aliasRequestId: message.key,
      requestClient: "discord",
      sessionId: "channel-1",
    });
    if (queued.status === "error") throw queued.error;
    cache.finishDelivery({ requestId: message.key, eventId: message.id, disposition: "release" });
    expect(cache.releaseOwner(current.value)).toBe(true);
    expect(cache.releaseOwner(current.value)).toBe(false);
    expect(cache.get(message.key)).toBeDefined();
    expect(cache.releaseOwner(queued.value)).toBe(true);
    expect(cache.get(message.key)).toBeUndefined();
  });

  it("requires an empty distinct alias target and clones message lineage", () => {
    const cache = createRequestMessageCache();
    const source = requestMessage({ eventId: "1-0", requestId: "source" });
    const occupied = requestMessage({ eventId: "2-0", requestId: "occupied" });
    expect(cache.cacheMessage(source).status).toBe("ok");
    expect(cache.cacheMessage(occupied).status).toBe("ok");
    expect(
      cache.createAliasOwner({
        sourceRequestId: "source",
        aliasRequestId: "occupied",
        requestClient: "discord",
        sessionId: "channel-1",
      }).status,
    ).toBe("error");
    const alias = cache.createAliasOwner({
      sourceRequestId: "source",
      aliasRequestId: "alias",
      requestClient: "discord",
      sessionId: "channel-1",
    });
    if (alias.status === "error") throw alias.error;
    expect(cache.get("alias")).toEqual(cache.get("source"));
    expect(cache.get("alias")).not.toBe(cache.get("source"));
    expect(cache.releaseOwner(alias.value)).toBe(true);
    expect(cache.get("alias")).toBeUndefined();
  });

  it("allows trusted workflow reconstruction but rejects a raw unknown-client trust upgrade", () => {
    const cache = createRequestMessageCache();
    const message = requestMessage({
      eventId: "1-0",
      requestId: "workflow-child",
      sessionId: "workflow-session",
      requestClient: "unknown",
    });
    expect(cache.cacheMessage(message).status).toBe("ok");
    expect(
      cache.cacheMessage(
        message,
        trustedUnknownProjection({ requestId: "workflow-child", sessionId: "workflow-session" }),
      ).status,
    ).toBe("ok");
    expect(cache.getOrigin("workflow-child")).toMatchObject({
      source: "internal-delegated",
      authenticatedOrigin: { platform: "discord", userId: "user-1" },
    });

    const raw = requestMessage({
      eventId: "2-0",
      requestId: "raw-unknown",
      sessionId: "workflow-session",
      requestClient: "unknown",
      raw: { authenticatedActor: { platform: "discord", userId: "user-1" } },
    });
    expect(cache.cacheMessage(raw).status).toBe("error");
  });

  it("latches GitHub trigger identity while allowing raw-free follow-up", () => {
    const cache = createRequestMessageCache();
    const trigger = (eventId: string, commentId: number) =>
      requestMessage({
        eventId,
        requestId: "github:owner/repo#1:41",
        sessionId: "owner/repo#1",
        requestClient: "github",
        raw: {
          authenticatedActor: { platform: "github", userId: "octocat" },
          github: {
            repoFullName: "owner/repo",
            issueNumber: 1,
            trigger: { kind: "comment", commentId },
          },
        },
      });
    expect(cache.cacheMessage(trigger("1-0", 41)).status).toBe("ok");
    expect(
      cache.cacheMessage(
        requestMessage({
          eventId: "2-0",
          requestId: "github:owner/repo#1:41",
          sessionId: "owner/repo#1",
          requestClient: "github",
        }),
      ).status,
    ).toBe("ok");
    expect(cache.cacheMessage(trigger("3-0", 42)).status).toBe("error");
  });

  it("treats request-ID reuse after committed release as a new lifecycle", () => {
    const cache = createRequestMessageCache();
    const first = requestMessage({ eventId: "1-0", requestId: "reused" });
    expect(cache.cacheMessage(first).status).toBe("ok");
    cache.finishDelivery({ requestId: "reused", eventId: first.id, disposition: "release" });
    const second = requestMessage({
      eventId: "2-0",
      requestId: "reused",
      raw: {
        authenticatedActor: { platform: "discord", userId: "new-user" },
      },
    });
    expect(cache.cacheMessage(second).status).toBe("ok");
    expect(cache.getOrigin("reused")?.authenticatedOrigin?.userId).toBe("new-user");
  });
});
