import type { SurfaceMsgRef } from "@stanley2058/lilac-event-bus";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import { errorMessage } from "@stanley2058/lilac-utils";

import { deleteIssueCommentReactionById, deleteIssueReactionById } from "../../github/github-api";
import { parseGithubRequestId, parseGithubSessionId } from "../../github/github-ids";
import {
  clearGithubAck,
  getGithubAck,
  getGithubLatestRequestForSession,
  getGithubRequestMeta,
  type GithubAckState,
} from "../../github/github-state";
import type { SurfaceAdapter } from "../adapter";
import type {
  SurfaceRelayDescriptor,
  SurfaceRelayPolicy,
  SurfaceReplyTargetInvalid,
  SurfaceRequestIngress,
  SurfaceRuntimeDescriptor,
  SurfaceWorkflowProgressPort,
} from "../runtime-descriptor";
import {
  SurfaceIngressAcknowledgementCleanupFailed,
  SurfaceReplyTargetInvalid as ReplyTargetInvalid,
} from "../runtime-descriptor";
import { SurfaceRefInvalid as RefInvalid } from "../runtime-descriptor";

export type GithubAcknowledgementApi = {
  readonly deleteIssueReactionById: typeof deleteIssueReactionById;
  readonly deleteIssueCommentReactionById: typeof deleteIssueCommentReactionById;
};

const DEFAULT_GITHUB_ACKNOWLEDGEMENT_API: GithubAcknowledgementApi = {
  deleteIssueReactionById,
  deleteIssueCommentReactionById,
};

class GithubAcknowledgementDeleteFailed extends TaggedError("GithubAcknowledgementDeleteFailed")<{
  readonly cause: unknown;
  readonly isNotFound: boolean;
  readonly message: string;
}> {}

export function preserveGithubRelayPolicyPanic(cause: unknown): void {
  if (Panic.is(cause)) throw cause;
}

export async function deleteGithubAcknowledgement(
  input: {
    readonly owner: string;
    readonly repo: string;
    readonly ack: GithubAckState;
  },
  api: GithubAcknowledgementApi,
): Promise<ResultType<void, GithubAcknowledgementDeleteFailed>> {
  try {
    if (input.ack.target.kind === "issue") {
      await api.deleteIssueReactionById({
        owner: input.owner,
        repo: input.repo,
        issueNumber: input.ack.target.issueNumber,
        reactionId: input.ack.reactionId,
      });
    } else {
      await api.deleteIssueCommentReactionById({
        owner: input.owner,
        repo: input.repo,
        commentId: input.ack.target.commentId,
        reactionId: input.ack.reactionId,
      });
    }
    return Result.ok(undefined);
  } catch (cause) {
    preserveGithubRelayPolicyPanic(cause);
    return Result.err(
      new GithubAcknowledgementDeleteFailed({
        cause,
        isNotFound: errorMessage(cause).includes("404"),
        message: "Failed to delete GitHub acknowledgement reaction",
      }),
    );
  }
}

async function clearGithubIngressAcknowledgement(
  input: {
    readonly requestId: string;
    readonly sessionId: string;
  },
  api: GithubAcknowledgementApi,
): Promise<ResultType<void, SurfaceIngressAcknowledgementCleanupFailed>> {
  const ack = getGithubAck(input.requestId);
  if (!ack) return Result.ok(undefined);

  const meta = getGithubRequestMeta(input.requestId);
  const thread = (() => {
    if (meta?.repoFullName) {
      const [owner, repo] = meta.repoFullName.split("/");
      if (owner && repo) return { owner, repo };
    }
    return parseGithubSessionId(input.sessionId);
  })();

  let deleted: ResultType<void, GithubAcknowledgementDeleteFailed>;
  try {
    deleted = await deleteGithubAcknowledgement(
      {
        owner: thread.owner,
        repo: thread.repo,
        ack,
      },
      api,
    );
  } finally {
    clearGithubAck(input.requestId);
  }

  if (deleted.status === "ok" || deleted.error.isNotFound) return Result.ok(undefined);
  return Result.err(
    new SurfaceIngressAcknowledgementCleanupFailed({
      message: "Failed to clear surface ingress acknowledgement",
    }),
  );
}

function invalidInitialTarget(input: {
  readonly reason: SurfaceReplyTargetInvalid["reason"];
  readonly sessionId: string;
  readonly message: string;
}) {
  return {
    kind: "invalid" as const,
    error: new ReplyTargetInvalid({
      reason: input.reason,
      expectedPlatform: "github",
      expectedSessionId: input.sessionId,
      message: input.message,
    }),
  };
}

function decodeGithubRef(input: {
  readonly ref: SurfaceMsgRef;
  readonly expectedSessionId: string;
}) {
  if (input.ref.platform !== "github") {
    return Result.err(
      new RefInvalid({
        reason: "platform-mismatch",
        expectedPlatform: "github",
        expectedSessionId: input.expectedSessionId,
        message: `Expected a GitHub reply target, received '${input.ref.platform}'`,
      }),
    );
  }
  if (input.ref.channelId !== input.expectedSessionId) {
    return Result.err(
      new RefInvalid({
        reason: "session-mismatch",
        expectedPlatform: "github",
        expectedSessionId: input.expectedSessionId,
        message: `GitHub reply target belongs to session '${input.ref.channelId}'`,
      }),
    );
  }
  return Result.ok({
    platform: "github" as const,
    channelId: input.ref.channelId,
    messageId: input.ref.messageId,
  });
}

export function createGithubRelayPolicy(
  input: {
    readonly acknowledgementApi?: GithubAcknowledgementApi;
  } = {},
): SurfaceRelayPolicy<"github"> {
  const acknowledgementApi = input.acknowledgementApi ?? DEFAULT_GITHUB_ACKNOWLEDGEMENT_API;
  return {
    refs: {
      createSessionRef: (sessionId) => ({ platform: "github", channelId: sessionId }),
      resolveInitialReplyTarget: ({ requestId, sessionId }) => {
        const parsed = parseGithubRequestId({ requestId });
        if (parsed) {
          if (parsed.sessionId !== sessionId) {
            return invalidInitialTarget({
              reason: "session-mismatch",
              sessionId,
              message: `GitHub request belongs to session '${parsed.sessionId}'`,
            });
          }
          return {
            kind: "target",
            ref: {
              platform: "github",
              channelId: sessionId,
              messageId: parsed.triggerId,
            },
          };
        }
        if (requestId.startsWith("github:")) {
          return invalidInitialTarget({
            reason: "malformed",
            sessionId,
            message: `Malformed GitHub request ID '${requestId}'`,
          });
        }
        if (requestId.startsWith("discord:")) {
          return invalidInitialTarget({
            reason: "platform-mismatch",
            sessionId,
            message: `Discord request ID cannot target GitHub output`,
          });
        }
        return { kind: "none" };
      },
      decodeReanchorTarget: decodeGithubRef,
    },
    finalization: {
      isFinalResponseSuperseded: ({ requestId, sessionId }) => {
        const latest = getGithubLatestRequestForSession(sessionId);
        return latest !== undefined && latest !== requestId;
      },
      clearIngressAcknowledgement: (finalizationInput) =>
        clearGithubIngressAcknowledgement(finalizationInput, acknowledgementApi),
    },
  };
}

export function createGithubSurfaceRuntimeDescriptor(input: {
  readonly adapter: SurfaceAdapter;
  readonly requestIngress?: SurfaceRequestIngress;
  readonly relay?: SurfaceRelayDescriptor<"github">;
  readonly workflowProgress?: SurfaceWorkflowProgressPort<"github">;
}): SurfaceRuntimeDescriptor<"github"> {
  return {
    platform: "github",
    adapter: input.adapter,
    ...(input.requestIngress ? { requestIngress: input.requestIngress } : {}),
    ...(input.relay ? { relay: input.relay } : {}),
    ...(input.workflowProgress ? { workflowProgress: input.workflowProgress } : {}),
  };
}

type GithubSurfaceRuntimeCompositionLogger = {
  info(message: string, context: Readonly<Record<string, string>>): void;
  warn(message: string, context: Readonly<Record<string, string>>): void;
};

export function createConfiguredGithubSurfaceRuntimeDescriptor(input: {
  readonly adapter: SurfaceAdapter;
  readonly webhookSecret: string | undefined;
  readonly appCredentialsAvailable: boolean;
  readonly requestIngress: SurfaceRequestIngress;
  readonly relay: SurfaceRelayDescriptor<"github">;
  readonly workflowProgress?: SurfaceWorkflowProgressPort<"github">;
  readonly logger: GithubSurfaceRuntimeCompositionLogger;
}): SurfaceRuntimeDescriptor<"github"> {
  const requestIngressAvailable = Boolean(input.webhookSecret) && input.appCredentialsAvailable;
  if (!requestIngressAvailable) {
    input.logger.warn("GitHub webhook ingress unavailable", {
      subsystem: "request-ingress",
      reason: input.webhookSecret ? "app-credentials-missing" : "webhook-secret-missing",
    });
  }
  if (!input.appCredentialsAvailable) {
    input.logger.info("GitHub output relay unavailable", {
      subsystem: "output-relay",
      reason: "app-credentials-missing",
    });
  }
  return createGithubSurfaceRuntimeDescriptor({
    adapter: input.adapter,
    ...(requestIngressAvailable ? { requestIngress: input.requestIngress } : {}),
    ...(input.appCredentialsAvailable ? { relay: input.relay } : {}),
    ...(input.workflowProgress ? { workflowProgress: input.workflowProgress } : {}),
  });
}
