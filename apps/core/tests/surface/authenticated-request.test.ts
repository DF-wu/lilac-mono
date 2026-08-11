import { describe, expect, it } from "bun:test";
import { lilacEventTypes, type LilacMessageForTopic } from "@stanley2058/lilac-event-bus";

import {
  isPersistedRecoveryAuthenticatedRequestProjectionSemanticallyValid,
  latchAuthenticatedRequest,
  projectAuthenticatedRequest,
  type AuthenticatedRequestProjection,
} from "../../src/surface/authenticated-request";

type RequestMessage = Extract<LilacMessageForTopic<"cmd.request">, { type: "cmd.request.message" }>;

function requestMessage(input: {
  readonly requestId?: string;
  readonly sessionId?: string;
  readonly requestClient?: "discord" | "github" | "unknown";
  readonly raw?: unknown;
}): RequestMessage {
  return {
    id: "1-0",
    topic: "cmd.request",
    type: lilacEventTypes.CmdRequestMessage,
    ts: 100,
    key: input.requestId ?? "uncorrelated",
    headers: {
      ...(input.requestId ? { request_id: input.requestId } : {}),
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(input.requestClient ? { request_client: input.requestClient } : {}),
    },
    data: {
      queue: "prompt",
      messages: [{ role: "user", content: "hello" }],
      ...(input.raw !== undefined ? { raw: input.raw } : {}),
    },
  };
}

function project(message: RequestMessage): AuthenticatedRequestProjection | undefined {
  const projected = projectAuthenticatedRequest(message);
  if (projected.status === "error") throw projected.error;
  return projected.value;
}

describe("authenticated request projection", () => {
  it("ignores uncorrelated requests only when they do not claim authentication metadata", () => {
    expect(project(requestMessage({ raw: { source: "internal" } }))).toBeUndefined();

    expect(
      projectAuthenticatedRequest(
        requestMessage({
          raw: { authenticatedActor: { platform: "discord", userId: "user-1" } },
        }),
      ).status,
    ).toBe("error");
  });

  it("projects unsupported clients only without surface authentication claims", () => {
    expect(
      project(
        requestMessage({
          requestId: "request-1",
          sessionId: "session-1",
          requestClient: "unknown",
        }),
      ),
    ).toEqual({
      requestId: "request-1",
      requestClient: "unknown",
      sessionId: "session-1",
      source: "external",
      authenticationMetadataKind: "absent",
      verifiedIngress: false,
    });

    expect(
      projectAuthenticatedRequest(
        requestMessage({
          requestId: "request-1",
          sessionId: "session-1",
          requestClient: "unknown",
          raw: { authenticatedActor: { platform: "discord", userId: "user-1" } },
        }),
      ).status,
    ).toBe("error");
  });

  it("rejects whitespace-only correlation IDs for unsupported clients", () => {
    expect(
      projectAuthenticatedRequest(
        requestMessage({
          requestId: "   ",
          sessionId: "session-1",
          requestClient: "unknown",
        }),
      ).status,
    ).toBe("error");
    expect(
      projectAuthenticatedRequest(
        requestMessage({
          requestId: "request-1",
          sessionId: "   ",
          requestClient: "unknown",
        }),
      ).status,
    ).toBe("error");
  });

  it("normalizes Discord actor evidence into a verified origin", () => {
    expect(
      project(
        requestMessage({
          requestId: "discord:channel-1:message-1",
          sessionId: "channel-1",
          requestClient: "discord",
          raw: { authenticatedActor: { platform: "discord", userId: "user-1" } },
        }),
      ),
    ).toMatchObject({
      authenticationMetadataKind: "actor",
      authenticatedActor: { platform: "discord", userId: "user-1" },
      authenticatedOrigin: {
        platform: "discord",
        userId: "user-1",
        messageRef: { platform: "discord", channelId: "channel-1", messageId: "message-1" },
      },
      verifiedIngress: true,
    });
  });

  it("distinguishes partial and complete GitHub trigger evidence", () => {
    const partial = project(
      requestMessage({
        requestId: "github:owner/repo#1:41",
        sessionId: "owner/repo#1",
        requestClient: "github",
        raw: {
          github: { issueNumber: 1, trigger: { kind: "comment", commentId: 41 } },
        },
      }),
    );
    expect(partial).toMatchObject({
      githubTrigger: { issueNumber: 1, messageId: "41" },
      verifiedIngress: false,
    });

    const complete = project(
      requestMessage({
        requestId: "github:owner/repo#1:41",
        sessionId: "owner/repo#1",
        requestClient: "github",
        raw: {
          github: {
            repoFullName: "owner/repo",
            issueNumber: 1,
            trigger: { kind: "comment", commentId: 41 },
          },
        },
      }),
    );
    expect(complete).toMatchObject({
      githubTrigger: {
        targetKind: "issue",
        repoFullName: "owner/repo",
        issueNumber: 1,
        messageId: "41",
      },
      verifiedIngress: true,
    });
  });

  it("requires canonical request identity when persisted message proof exists", () => {
    const projection = project(
      requestMessage({
        requestId: "generic-request",
        sessionId: "channel-1",
        requestClient: "discord",
        raw: {
          authenticatedOrigin: {
            platform: "discord",
            userId: "user-1",
            messageRef: {
              platform: "discord",
              channelId: "channel-1",
              messageId: "message-1",
            },
          },
        },
      }),
    );
    if (!projection) throw new Error("Expected projection");

    expect(isPersistedRecoveryAuthenticatedRequestProjectionSemanticallyValid(projection)).toBe(
      false,
    );
  });

  it("rejects authority upgrades while retaining the first accepted identity", () => {
    const restricted = project(
      requestMessage({
        requestId: "request-1",
        sessionId: "channel-1",
        requestClient: "discord",
      }),
    );
    const verified = project(
      requestMessage({
        requestId: "request-1",
        sessionId: "channel-1",
        requestClient: "discord",
        raw: { authenticatedActor: { platform: "discord", userId: "user-1" } },
      }),
    );
    if (!restricted || !verified) throw new Error("Expected projections");

    expect(latchAuthenticatedRequest(restricted, verified, "cmd.request.message").status).toBe(
      "error",
    );
    const retained = latchAuthenticatedRequest(verified, restricted, "cmd.request.message");
    expect(retained.status).toBe("ok");
    if (retained.status === "error") throw retained.error;
    expect(retained.value).toBe(verified);
  });
});
