import { describe, expect, it } from "bun:test";
import {
  lilacEventTypes,
  type BusMessageV2,
  type LilacMessageForTopic,
} from "@stanley2058/lilac-event-bus";

import {
  createRequestMessageCache,
  type AuthenticatedRequestOrigin,
} from "../../src/tool-server/request-message-cache";
import {
  BusAgentRunnerAuthenticationProjectionInvalid,
  busAgentRunnerDeliveryDisposition,
} from "../../src/surface/bridge/bus-agent-runner";
import {
  isAuthenticatedRequestProjectionSemanticallyValid,
  isPersistedRecoveryAuthenticatedRequestProjectionSemanticallyValid,
} from "../../src/surface/authenticated-request";

function requestMessage(input: {
  readonly eventId: string;
  readonly requestId: string;
  readonly sessionId?: string;
  readonly requestClient?: "discord" | "github" | "unknown";
  readonly text?: string;
  readonly messages?: BusMessageV2[];
  readonly raw?: Record<string, unknown>;
}): LilacMessageForTopic<"cmd.request"> {
  const messages: BusMessageV2[] = input.messages ?? [
    { role: "user", content: input.text ?? input.eventId },
  ];
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
      requestDeliveryId: crypto.randomUUID(),
      queue: "prompt",
      messages,
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

  it("preserves structured resources in current-request and alias message caches", () => {
    const cache = createRequestMessageCache();
    const resource = {
      type: "resource" as const,
      uri: `resource://r1_${"ab".repeat(16)}`,
      filename: "diagram.png",
      mediaType: "image/png",
      size: 321,
    };
    const message = requestMessage({
      eventId: "1-0",
      requestId: "resource-source",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "inspect" }, resource],
        },
      ],
    });

    expect(cache.cacheMessage(message).status).toBe("ok");
    const alias = cache.createAliasOwner({
      sourceRequestId: "resource-source",
      aliasRequestId: "resource-alias",
      requestClient: "discord",
      sessionId: "channel-1",
    });
    if (alias.status === "error") throw alias.error;

    expect(cache.get("resource-source")).toEqual(message.data.messages);
    expect(cache.get("resource-alias")).toEqual(message.data.messages);
    expect(cache.releaseOwner(alias.value)).toBe(true);
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

  it("latches the first GitHub trigger while allowing later users", () => {
    const cache = createRequestMessageCache();
    const trigger = (eventId: string, userId: string) =>
      requestMessage({
        eventId,
        requestId: "github:owner/repo#1:41",
        sessionId: "owner/repo#1",
        requestClient: "github",
        raw: {
          authenticatedActor: { platform: "github", userId },
          github: {
            repoFullName: "owner/repo",
            issueNumber: 1,
            trigger: { kind: "comment", commentId: 41 },
          },
        },
      });
    expect(cache.cacheMessage(trigger("1-0", "octocat")).status).toBe("ok");
    expect(cache.getOrigin("github:owner/repo#1:41")?.verifiedIngress).toBe(true);
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
    expect(cache.cacheMessage(trigger("3-0", "hubot")).status).toBe("ok");
    expect(cache.getOrigin("github:owner/repo#1:41")?.githubTrigger?.messageId).toBe("41");
  });

  it("preserves the Discord initiator across different-user follow-ups", () => {
    const cache = createRequestMessageCache();
    const requestId = "discord:channel-1:message-1";
    const first = requestMessage({
      eventId: "1-0",
      requestId,
      raw: {
        authenticatedOrigin: {
          platform: "discord",
          userId: "user-1",
          messageRef: { platform: "discord", channelId: "channel-1", messageId: "message-1" },
        },
      },
    });
    const followUp = requestMessage({
      eventId: "2-0",
      requestId,
      raw: {
        authenticatedActor: { platform: "discord", userId: "user-2" },
        authenticatedOrigin: {
          platform: "discord",
          userId: "user-2",
          messageRef: { platform: "discord", channelId: "channel-1", messageId: "message-2" },
        },
      },
    });

    expect(cache.cacheMessage(first).status).toBe("ok");
    expect(cache.cacheMessage(followUp).status).toBe("ok");
    expect(cache.get(requestId)).toHaveLength(2);
    expect(cache.getOrigin(requestId)?.authenticatedOrigin?.messageRef?.messageId).toBe(
      "message-1",
    );
    expect(cache.getOrigin(requestId)?.authenticatedOrigin?.userId).toBe("user-1");
  });

  it("validates a restore batch fully at apply time before mutating any entry", () => {
    const cache = createRequestMessageCache();
    const first = requestMessage({ eventId: "1-0", requestId: "first" });
    expect(cache.cacheMessage(first).status).toBe("ok");
    const firstProjection = cache.getOrigin(first.key);
    if (!firstProjection) throw new Error("Expected first projection");

    const projectionSource = createRequestMessageCache();
    const second = requestMessage({ eventId: "2-0", requestId: "second" });
    expect(projectionSource.cacheMessage(second).status).toBe("ok");
    const secondProjection = projectionSource.getOrigin(second.key);
    if (!secondProjection) throw new Error("Expected second projection");

    const prepared = cache.prepareRestore([
      { projection: firstProjection, parkedEventIds: ["parked-first"] },
      { projection: secondProjection, parkedEventIds: ["parked-second"] },
    ]);
    if (prepared.status === "error") throw prepared.error;
    expect(
      cache.cacheMessage(
        requestMessage({ eventId: "3-0", requestId: "second", sessionId: "other-channel" }),
      ).status,
    ).toBe("ok");

    expect(prepared.value.apply().status).toBe("error");
    expect(cache.snapshot("first")?.parkedEventIds).toEqual([]);
    expect(cache.getOrigin("second")?.sessionId).toBe("other-channel");
  });

  it("restores unrelated capacity evictions on rollback", () => {
    let now = 1;
    const cache = createRequestMessageCache({ maxEntries: 2, now: () => now++ });
    const projections = ["first", "second", "third"].map((requestId, index) => {
      const source = createRequestMessageCache();
      const message = requestMessage({ eventId: `${index + 1}-0`, requestId });
      expect(source.cacheMessage(message).status).toBe("ok");
      const projection = source.getOrigin(requestId);
      if (!projection) throw new Error(`Expected ${requestId} projection`);
      return projection;
    });
    const initial = cache.prepareRestore(
      projections.slice(0, 2).map((projection) => ({ projection, parkedEventIds: [] })),
    );
    if (initial.status === "error") throw initial.error;
    expect(initial.value.apply().status).toBe("ok");

    const overCapacity = cache.prepareRestore([
      { projection: projections[2]!, parkedEventIds: [] },
    ]);
    if (overCapacity.status === "error") throw overCapacity.error;
    expect(overCapacity.value.apply().status).toBe("ok");
    expect(cache.getOrigin("first")).toBeUndefined();
    expect(cache.getOrigin("third")).toBeDefined();

    overCapacity.value.rollback();
    expect(cache.getOrigin("first")).toBeDefined();
    expect(cache.getOrigin("second")).toBeDefined();
    expect(cache.getOrigin("third")).toBeUndefined();
  });

  it("creates a restricted actor-based Discord alias without message proof", () => {
    const cache = createRequestMessageCache();
    const source = requestMessage({
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
    expect(cache.cacheMessage(source).status).toBe("ok");
    const alias = cache.createAliasOwner({
      sourceRequestId: source.key,
      aliasRequestId: "discord:channel-1:model-alias",
      requestClient: "discord",
      sessionId: "channel-1",
    });
    if (alias.status === "error") throw alias.error;

    expect(alias.value.projection).toMatchObject({
      source: "external",
      requestClient: "discord",
      sessionId: "channel-1",
      sessionRef: { platform: "discord", channelId: "channel-1" },
      authenticatedActor: { platform: "discord", userId: "user-1" },
      authenticatedOrigin: { platform: "discord", userId: "user-1" },
      authenticationMetadataKind: "actor",
      verifiedIngress: false,
    });
    expect(alias.value.projection.messageRef).toBeUndefined();
    expect(alias.value.projection.authenticatedOrigin?.messageRef).toBeUndefined();
    expect(isAuthenticatedRequestProjectionSemanticallyValid(alias.value.projection)).toBe(true);
    expect(
      isPersistedRecoveryAuthenticatedRequestProjectionSemanticallyValid(alias.value.projection),
    ).toBe(true);
  });

  it("creates a restricted actor-based GitHub alias without trigger proof", () => {
    const cache = createRequestMessageCache();
    const source = requestMessage({
      eventId: "1-0",
      requestId: "github:owner/repo#1:41",
      sessionId: "owner/repo#1",
      requestClient: "github",
      raw: {
        authenticatedActor: { platform: "github", userId: "octocat" },
        github: {
          repoFullName: "owner/repo",
          issueNumber: 1,
          trigger: { kind: "comment", commentId: 41 },
        },
      },
    });
    expect(cache.cacheMessage(source).status).toBe("ok");
    const alias = cache.createAliasOwner({
      sourceRequestId: source.key,
      aliasRequestId: "github:owner/repo#1:model-alias",
      requestClient: "github",
      sessionId: "owner/repo#1",
    });
    if (alias.status === "error") throw alias.error;

    expect(alias.value.projection).toMatchObject({
      source: "external",
      requestClient: "github",
      sessionId: "owner/repo#1",
      sessionRef: { platform: "github", channelId: "owner/repo#1" },
      authenticatedActor: { platform: "github", userId: "octocat" },
      authenticationMetadataKind: "actor",
      verifiedIngress: false,
    });
    expect(alias.value.projection.messageRef).toBeUndefined();
    expect(alias.value.projection.githubTrigger).toBeUndefined();
    expect(alias.value.projection.authenticatedOrigin?.messageRef).toBeUndefined();
    expect(isAuthenticatedRequestProjectionSemanticallyValid(alias.value.projection)).toBe(true);
  });

  it("creates an anonymous restricted alias without synthesizing authority", () => {
    const cache = createRequestMessageCache();
    const source = requestMessage({ eventId: "1-0", requestId: "anonymous-source" });
    expect(cache.cacheMessage(source).status).toBe("ok");
    const alias = cache.createAliasOwner({
      sourceRequestId: source.key,
      aliasRequestId: "discord:channel-1:anonymous-alias",
      requestClient: "discord",
      sessionId: "channel-1",
    });
    if (alias.status === "error") throw alias.error;

    expect(alias.value.projection).toMatchObject({
      source: "external",
      authenticationMetadataKind: "absent",
      verifiedIngress: false,
    });
    expect(alias.value.projection.authenticatedActor).toBeUndefined();
    expect(alias.value.projection.authenticatedOrigin).toBeUndefined();
    expect(isAuthenticatedRequestProjectionSemanticallyValid(alias.value.projection)).toBe(true);
  });

  it("keeps unregistered external aliases ref-free and restricted", () => {
    const cache = createRequestMessageCache();
    const source = requestMessage({ eventId: "1-0", requestId: "unregistered-source" });
    expect(cache.cacheMessage(source).status).toBe("ok");
    const alias = cache.createAliasOwner({
      sourceRequestId: source.key,
      aliasRequestId: "unregistered-alias",
      requestClient: "slack",
      sessionId: "channel-1",
    });
    if (alias.status === "error") throw alias.error;

    expect(alias.value.projection).toEqual({
      requestId: "unregistered-alias",
      requestClient: "slack",
      sessionId: "channel-1",
      source: "external",
      authenticationMetadataKind: "absent",
      verifiedIngress: false,
    });
    expect(isAuthenticatedRequestProjectionSemanticallyValid(alias.value.projection)).toBe(true);
  });

  it("dead-letters an unproven GitHub authenticated-origin message replacement", () => {
    const cache = createRequestMessageCache();
    const requestId = "github:owner/repo#1:41";
    const origin = (eventId: string, messageId: string) =>
      requestMessage({
        eventId,
        requestId,
        sessionId: "owner/repo#1",
        requestClient: "github",
        raw: {
          authenticatedOrigin: {
            platform: "github",
            userId: "octocat",
            messageRef: { platform: "github", channelId: "owner/repo#1", messageId },
          },
        },
      });
    expect(cache.cacheMessage(origin("1-0", "41")).status).toBe("ok");
    const replaced = cache.cacheMessage(origin("2-0", "42"));
    expect(replaced.status).toBe("error");
    if (replaced.status === "ok") throw new Error("Expected GitHub origin replacement conflict");
    expect(
      busAgentRunnerDeliveryDisposition(
        new BusAgentRunnerAuthenticationProjectionInvalid({
          cause: replaced.error,
          message: "Request authentication projection is invalid",
        }),
      ),
    ).toBe("dead-letter");
    expect(cache.get(requestId)).toHaveLength(1);
  });

  it("keeps incomplete GitHub trigger evidence restricted and rejects actor metadata without a user", () => {
    const cache = createRequestMessageCache();
    const incomplete = requestMessage({
      eventId: "1-0",
      requestId: "github:owner/repo#1:41",
      sessionId: "owner/repo#1",
      requestClient: "github",
      raw: {
        github: {
          issueNumber: 1,
          trigger: { kind: "comment", commentId: 41 },
        },
      },
    });
    expect(cache.cacheMessage(incomplete).status).toBe("ok");
    expect(cache.getOrigin(incomplete.key)?.verifiedIngress).toBe(false);

    const missingActorUser = requestMessage({
      eventId: "2-0",
      requestId: "discord:channel-1:message-1",
      raw: { authenticatedActor: { platform: "discord" } },
    });
    expect(cache.cacheMessage(missingActorUser).status).toBe("error");
  });

  it("preserves exact pull-request trigger evidence and rejects ambiguous target kinds", () => {
    const cache = createRequestMessageCache();
    const pullRequest = requestMessage({
      eventId: "1-0",
      requestId: "github:owner/repo#2:51",
      sessionId: "owner/repo#2",
      requestClient: "github",
      raw: {
        github: {
          repoFullName: "owner/repo",
          prNumber: 2,
          trigger: { kind: "comment", commentId: 51 },
        },
      },
    });
    expect(cache.cacheMessage(pullRequest).status).toBe("ok");
    expect(cache.getOrigin(pullRequest.key)).toMatchObject({
      githubTrigger: {
        kind: "comment",
        targetKind: "pull-request",
        repoFullName: "owner/repo",
        issueNumber: 2,
        messageId: "51",
      },
      verifiedIngress: true,
    });

    const ambiguous = requestMessage({
      eventId: "2-0",
      requestId: "github:owner/repo#2:52",
      sessionId: "owner/repo#2",
      requestClient: "github",
      raw: {
        github: {
          repoFullName: "owner/repo",
          issueNumber: 2,
          prNumber: 2,
          trigger: { kind: "comment", commentId: 52 },
        },
      },
    });
    expect(cache.cacheMessage(ambiguous).status).toBe("error");
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
