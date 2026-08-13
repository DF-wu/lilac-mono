import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import { formatTaggedErrorForLog } from "@stanley2058/lilac-utils";

import {
  deleteIssueCommentReactionById,
  deleteIssueReactionById,
  GithubApiError,
} from "../../github/github-api";
import { parseGithubSessionId } from "../../github/github-ids";
import { markGithubAgentComment } from "../../github/github-comment-marker";
import {
  clearGithubAck,
  getGithubAck,
  getGithubLatestRequestForSession,
  getGithubRequestMeta,
  type GithubAckState,
} from "../../github/github-state";
import type { SurfaceAdapter, SurfaceOperationError } from "../adapter";
import { resolveBuiltinSurfaceRequestMessageRef } from "../builtin-surface-protocols";
import { githubSurfaceProtocol } from "./github-surface-protocol";
import type {
  SurfaceRelayDescriptor,
  SurfaceRelayPolicy,
  SurfaceRequestIngress,
  SurfaceRuntimeDescriptor,
  SurfaceWorkflowProgressPort,
  WorkflowProgressOperationFailed,
} from "../runtime-descriptor";
import {
  SurfaceIngressAcknowledgementCleanupFailed,
  workflowProgressOperationFailure,
} from "../runtime-descriptor";

type GithubWorkflowProgressOperation = "check-message" | "send" | "edit";

// Bump when the declared workflow operation contract or failure policy changes.
export const GITHUB_WORKFLOW_PROGRESS_CONFIGURATION_REVISION = "github-workflow-progress-v1";

function githubWorkflowError(
  operation: GithubWorkflowProgressOperation,
  error: SurfaceOperationError,
): { readonly kind: "failed"; readonly error: WorkflowProgressOperationFailed } {
  return { kind: "failed", error: workflowProgressOperationFailure(operation, error) };
}

export function createGithubWorkflowProgressPort(
  adapter: SurfaceAdapter,
): SurfaceWorkflowProgressPort<"github"> {
  return {
    configurationRevision: GITHUB_WORKFLOW_PROGRESS_CONFIGURATION_REVISION,
    checkMessage: async (target) => {
      const checked = await adapter.readMsg({
        platform: "github",
        channelId: target.channelId,
        messageId: target.messageId,
      });
      if (checked.status === "error") {
        if (checked.error._tag === "SurfaceMessageNotFound") {
          return Result.ok("missing");
        }
        return Result.err(githubWorkflowError("check-message", checked.error));
      }
      return Result.ok(checked.value ? "found" : "missing");
    },
    send: async (input) => {
      const content = input.replyToMessageId
        ? {
            ...input.content,
            text: `In reply to ${input.replyToMessageId}:\n\n${input.content.text ?? ""}`,
          }
        : input.content;
      const sent = await adapter.sendMsg(
        { platform: "github", channelId: input.channelId },
        content,
        { silent: input.silent },
      );
      if (sent.status === "error") {
        if (sent.error._tag === "SurfaceOperationPartiallyCompleted") {
          return Result.err({
            kind: "created",
            ref: {
              platform: "github",
              channelId: sent.error.created.channelId,
              messageId: sent.error.created.messageId,
            },
          });
        }
        return Result.err(githubWorkflowError("send", sent.error));
      }
      return Result.ok({
        platform: "github",
        channelId: sent.value.channelId,
        messageId: sent.value.messageId,
      });
    },
    edit: async (target, content) => {
      const edited = await adapter.editMsg(
        {
          platform: "github",
          channelId: target.channelId,
          messageId: target.messageId,
        },
        {
          ...content,
          text: markGithubAgentComment(content.text ?? ""),
        },
      );
      if (edited.status === "ok") return Result.ok(undefined);
      if (edited.error._tag === "SurfaceMessageNotFound") {
        return Result.err({ kind: "not-found" });
      }
      return Result.err(githubWorkflowError("edit", edited.error));
    },
  };
}

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
    readonly requestId: string;
    readonly sessionId: string;
    readonly ack: GithubAckState;
  },
  api: GithubAcknowledgementApi,
): Promise<ResultType<void, GithubAcknowledgementDeleteFailed>> {
  try {
    const meta = getGithubRequestMeta(input.requestId);
    const thread = (() => {
      if (meta?.repoFullName) {
        const [owner, repo] = meta.repoFullName.split("/");
        if (owner && repo) return { owner, repo };
      }
      return parseGithubSessionId(input.sessionId);
    })();
    if (input.ack.target.kind === "issue") {
      await api.deleteIssueReactionById({
        owner: thread.owner,
        repo: thread.repo,
        issueNumber: input.ack.target.issueNumber,
        reactionId: input.ack.reactionId,
      });
    } else {
      await api.deleteIssueCommentReactionById({
        owner: thread.owner,
        repo: thread.repo,
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
        isNotFound: cause instanceof GithubApiError && cause.status === 404,
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

  let deleted: ResultType<void, GithubAcknowledgementDeleteFailed>;
  try {
    deleted = await deleteGithubAcknowledgement(
      {
        requestId: input.requestId,
        sessionId: input.sessionId,
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
      cause: formatTaggedErrorForLog(deleted.error),
      message: "Failed to clear surface ingress acknowledgement",
    }),
  );
}

export function createGithubRelayPolicy(
  input: {
    readonly acknowledgementApi?: GithubAcknowledgementApi;
  } = {},
): SurfaceRelayPolicy<"github"> {
  const acknowledgementApi = input.acknowledgementApi ?? DEFAULT_GITHUB_ACKNOWLEDGEMENT_API;
  return {
    refs: {
      createSessionRef: githubSurfaceProtocol.refs.createSessionRef,
      resolveInitialReplyTarget: ({ requestId, sessionId }) =>
        resolveBuiltinSurfaceRequestMessageRef({
          protocol: githubSurfaceProtocol,
          requestId,
          sessionRef: githubSurfaceProtocol.refs.createSessionRef(sessionId),
        }),
      decodeReanchorTarget: githubSurfaceProtocol.refs.decodeMessageRef,
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
  readonly createRelay?: (guardedAdapter: SurfaceAdapter) => SurfaceRelayDescriptor<"github">;
}): SurfaceRuntimeDescriptor<"github"> {
  return {
    protocol: githubSurfaceProtocol,
    adapter: input.adapter,
    ...(input.requestIngress ? { requestIngress: input.requestIngress } : {}),
    ...(input.createRelay ? { createRelay: input.createRelay } : {}),
    createWorkflowProgress: createGithubWorkflowProgressPort,
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
  readonly createRelay: (guardedAdapter: SurfaceAdapter) => SurfaceRelayDescriptor<"github">;
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
    ...(input.appCredentialsAvailable ? { createRelay: input.createRelay } : {}),
  });
}
