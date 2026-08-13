import { describe, expect, it } from "bun:test";
import { lilacEventTypes, type LilacMessageForTopic } from "@stanley2058/lilac-event-bus";

import {
  isPersistedRecoveryAuthenticatedRequestProjectionSemanticallyValid,
  latchAuthenticatedRequest,
  projectAuthenticatedRequest,
  type AuthenticatedRequestProjection,
} from "../../src/surface/authenticated-request";
import { BUILTIN_SURFACE_PROTOCOLS } from "../../src/surface/builtin-surface-protocols";

type RequestMessage = Extract<LilacMessageForTopic<"cmd.request">, { type: "cmd.request.message" }>;

function requestMessage(input: {
  readonly requestId?: string;
  readonly sessionId?: string;
  readonly requestClient?: "discord" | "github" | "slack" | "unknown";
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

  it("does not derive identity or trust from understood catalog or descriptor membership", () => {
    expect(
      project(
        requestMessage({
          requestId: "discord:channel-1:message-1",
          sessionId: "channel-1",
          requestClient: "discord",
        }),
      ),
    ).toEqual({
      requestId: "discord:channel-1:message-1",
      requestClient: "discord",
      sessionId: "channel-1",
      source: "external",
      platform: "discord",
      sessionRef: { platform: "discord", channelId: "channel-1" },
      messageRef: { platform: "discord", channelId: "channel-1", messageId: "message-1" },
      authenticationMetadataKind: "absent",
      verifiedIngress: false,
    });
    expect(
      project(
        requestMessage({
          requestId: "github:owner/repo#1:41",
          sessionId: "owner/repo#1",
          requestClient: "github",
        }),
      ),
    ).toEqual({
      requestId: "github:owner/repo#1:41",
      requestClient: "github",
      sessionId: "owner/repo#1",
      source: "external",
      platform: "github",
      sessionRef: { platform: "github", channelId: "owner/repo#1" },
      authenticationMetadataKind: "absent",
      verifiedIngress: false,
    });
  });

  it("keeps wire-valid unregistered platforms principal-less and rejects claimed identity", () => {
    expect(
      project(
        requestMessage({
          requestId: "slack-request",
          sessionId: "slack-session",
          requestClient: "slack",
        }),
      ),
    ).toEqual({
      requestId: "slack-request",
      requestClient: "slack",
      sessionId: "slack-session",
      source: "external",
      authenticationMetadataKind: "absent",
      verifiedIngress: false,
    });
    const claimed = projectAuthenticatedRequest(
      requestMessage({
        requestId: "slack-request",
        sessionId: "slack-session",
        requestClient: "slack",
        raw: { authenticatedActor: { platform: "discord", userId: "user-1" } },
      }),
    );
    expect(claimed.status).toBe("error");
    if (claimed.status === "error") {
      expect(claimed.error.message).toBe(
        "surface authentication metadata requires a registered request platform",
      );
    }
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

  it("accepts normalized claims for every catalog platform", () => {
    for (const protocol of Object.values(BUILTIN_SURFACE_PROTOCOLS)) {
      const projected = project(
        requestMessage({
          requestId: `request-${protocol.platform}`,
          sessionId: `session-${protocol.platform}`,
          requestClient: protocol.platform,
          raw: {
            authenticatedActor: { platform: protocol.platform, userId: "user-1" },
          },
        }),
      );

      expect(projected?.authenticatedActor).toEqual({
        platform: protocol.platform,
        userId: "user-1",
      });
    }
  });

  it("rejects unsupported normalized claim platform strings", () => {
    for (const platform of ["slack", "future-surface"]) {
      const projected = projectAuthenticatedRequest(
        requestMessage({
          requestId: "discord:channel-1:message-1",
          sessionId: "channel-1",
          requestClient: "discord",
          raw: { authenticatedActor: { platform, userId: "user-1" } },
        }),
      );

      expect(projected.status).toBe("error");
    }
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

  it("retains correlated GitHub normalized identity with complete trigger proof", () => {
    expect(
      project(
        requestMessage({
          requestId: "github:owner/repo#1:41",
          sessionId: "owner/repo#1",
          requestClient: "github",
          raw: {
            authenticatedActor: { platform: "github", userId: "user-1" },
            authenticatedOrigin: {
              platform: "github",
              userId: "user-1",
              messageRef: { platform: "github", channelId: "owner/repo#1", messageId: "41" },
            },
            github: {
              repoFullName: "owner/repo",
              prNumber: 1,
              trigger: { kind: "comment", commentId: 41 },
            },
          },
        }),
      ),
    ).toMatchObject({
      authenticatedActor: { platform: "github", userId: "user-1" },
      authenticatedOrigin: {
        platform: "github",
        userId: "user-1",
        sessionRef: { platform: "github", channelId: "owner/repo#1" },
        messageRef: { platform: "github", channelId: "owner/repo#1", messageId: "41" },
      },
      authenticationMetadataKind: "actor-origin-github-trigger",
      githubTrigger: { targetKind: "pull-request", messageId: "41" },
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
