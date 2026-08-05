import { z } from "zod";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import type {
  AdapterCapabilities,
  ContentOpts,
  GithubMsgRef,
  GithubSessionRef,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfaceSelf,
  SurfaceSession,
} from "../types";
import type {
  AdapterEventHandler,
  AdapterSubscription,
  StartOutputOpts,
  SurfaceAdapter,
  SurfaceOutputStream,
} from "../adapter";
import { preserveSurfacePanic, signalSurfaceFailure } from "../adapter";
import {
  createIssueComment,
  editIssueComment,
  getIssue,
  getIssueComment,
  getPreferredGithubAuthoritativeActorOrNull,
  GithubApiError,
  listIssueComments,
  type GithubAuthoritativeActor,
} from "../../github/github-api";
import { markGithubAgentComment } from "../../github/github-comment-marker";
import { isGithubIssueTriggerId, parseGithubSessionId } from "../../github/github-ids";
import { GithubOutputStream } from "./output/github-output-stream";
import { renderGithubActionContent } from "./github-actions";

class GithubAdapterContractFailed extends TaggedError("GithubAdapterContractFailed")<{
  readonly reason:
    | "wrong-session-platform"
    | "wrong-message-platform"
    | "empty-message"
    | "invalid-comment-id"
    | "unsupported-operation";
  readonly message: string;
}> {}

function resolveGithubSessionRef(
  sessionRef: SessionRef,
): ResultType<GithubSessionRef, GithubAdapterContractFailed> {
  if (sessionRef.platform === "github") return Result.ok(sessionRef);
  return Result.err(
    new GithubAdapterContractFailed({
      reason: "wrong-session-platform",
      message: `Expected github sessionRef (got '${sessionRef.platform}')`,
    }),
  );
}

function resolveGithubMsgRef(
  msgRef: MsgRef,
): ResultType<GithubMsgRef, GithubAdapterContractFailed> {
  if (msgRef.platform === "github") return Result.ok(msgRef);
  return Result.err(
    new GithubAdapterContractFailed({
      reason: "wrong-message-platform",
      message: `Expected github msgRef (got '${msgRef.platform}')`,
    }),
  );
}

export function isGithubCommentAuthoredByActor(
  raw: unknown,
  actor: GithubAuthoritativeActor,
): boolean {
  const parsed = z
    .object({
      user: z.object({ login: z.string().min(1), id: z.number().int().positive() }).optional(),
      performed_via_github_app: z.object({ id: z.number().int().positive() }).nullable().optional(),
    })
    .safeParse(raw);
  if (!parsed.success) return false;
  return actor.source === "app"
    ? parsed.data.performed_via_github_app?.id === actor.appId
    : parsed.data.user?.login.toLowerCase() === actor.login;
}

export class GithubAdapter implements SurfaceAdapter {
  constructor(
    private readonly resolveAuthoritativeActor: typeof getPreferredGithubAuthoritativeActorOrNull = getPreferredGithubAuthoritativeActorOrNull,
  ) {}

  async connect(): Promise<void> {
    // No persistent connection.
  }

  async disconnect(): Promise<void> {
    // No persistent connection.
  }

  async getSelf(): Promise<SurfaceSelf> {
    // We don't have a stable user id for GitHub App installation tokens.
    // Best-effort: return a placeholder; webhook matching uses gh/app slug.
    return { platform: "github", userId: "github", userName: "github" };
  }

  async isAuthoritativelySelfAuthored(message: SurfaceMessage): Promise<boolean> {
    const verify = await this.resolveAuthoritativeSelfMessageVerifier();
    return verify(message);
  }

  async resolveAuthoritativeSelfMessageVerifier(): Promise<(message: SurfaceMessage) => boolean> {
    const actor = await this.resolveAuthoritativeActor();
    return (message) =>
      message.ref.platform === "github" &&
      actor !== null &&
      isGithubCommentAuthoredByActor(message.raw, actor);
  }

  async getCapabilities(): Promise<AdapterCapabilities> {
    return {
      platform: "github",
      send: true,
      edit: true,
      delete: false,
      reactions: true,
      readHistory: true,
      threads: false,
      markRead: false,
    };
  }

  async listSessions(): Promise<SurfaceSession[]> {
    return [];
  }

  async startOutput(sessionRef: SessionRef, opts?: StartOutputOpts): Promise<SurfaceOutputStream> {
    const githubSessionRef = resolveGithubSessionRef(sessionRef);
    if (githubSessionRef.status === "error") {
      return signalSurfaceFailure(githubSessionRef.error);
    }
    const replyTo = opts?.replyTo;
    return new GithubOutputStream(githubSessionRef.value, replyTo ? { replyTo } : undefined);
  }

  async sendMsg(sessionRef: SessionRef, content: ContentOpts, _opts?: SendOpts): Promise<MsgRef> {
    const githubSessionRef = resolveGithubSessionRef(sessionRef);
    if (githubSessionRef.status === "error") {
      return signalSurfaceFailure(githubSessionRef.error);
    }
    const thread = parseGithubSessionId(githubSessionRef.value.channelId);
    const text = content.text ?? "";
    if (!text.trim()) {
      return signalSurfaceFailure(
        new GithubAdapterContractFailed({
          reason: "empty-message",
          message: "github adapter: sendMsg requires non-empty text",
        }),
      );
    }
    const res = await createIssueComment({
      owner: thread.owner,
      repo: thread.repo,
      issueNumber: thread.number,
      body: markGithubAgentComment(text),
    });
    if (content.actions && content.actions.length > 0) {
      try {
        await editIssueComment({
          owner: thread.owner,
          repo: thread.repo,
          commentId: res.id,
          body: markGithubAgentComment(
            renderGithubActionContent({
              text,
              messageId: String(res.id),
              actions: content.actions,
            }),
          ),
        });
      } catch (error) {
        preserveSurfacePanic(error);
        return signalSurfaceFailure(
          new GithubMessageCreatedError(
            {
              platform: "github",
              channelId: githubSessionRef.value.channelId,
              messageId: String(res.id),
            },
            error,
          ),
        );
      }
    }
    return {
      platform: "github",
      channelId: githubSessionRef.value.channelId,
      messageId: String(res.id),
    };
  }

  async readMsg(msgRef: MsgRef): Promise<SurfaceMessage | null> {
    const githubMsgRef = resolveGithubMsgRef(msgRef);
    if (githubMsgRef.status === "error") return signalSurfaceFailure(githubMsgRef.error);
    const resolvedMsgRef = githubMsgRef.value;
    const thread = parseGithubSessionId(resolvedMsgRef.channelId);

    // If messageId matches issue number, treat it as the PR/issue description.
    if (
      isGithubIssueTriggerId({
        sessionId: resolvedMsgRef.channelId,
        triggerId: resolvedMsgRef.messageId,
      })
    ) {
      const issue = await getIssue({
        owner: thread.owner,
        repo: thread.repo,
        number: thread.number,
      }).catch((error: unknown) => {
        if (error instanceof GithubApiError && error.status === 404) return null;
        throw error;
      });
      if (!issue) return null;
      return {
        ref: resolvedMsgRef,
        session: { platform: "github", channelId: resolvedMsgRef.channelId },
        userId: typeof issue.user?.login === "string" ? issue.user.login : "unknown",
        userName: typeof issue.user?.login === "string" ? issue.user.login : undefined,
        text: issue.body ?? "",
        ts: Date.now(),
        raw: issue,
      };
    }

    const id = Number(resolvedMsgRef.messageId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const match = await getIssueComment({
      owner: thread.owner,
      repo: thread.repo,
      commentId: id,
    }).catch((error: unknown) => {
      if (error instanceof GithubApiError && error.status === 404) return null;
      throw error;
    });
    if (!match) return null;
    return {
      ref: resolvedMsgRef,
      session: { platform: "github", channelId: resolvedMsgRef.channelId },
      userId: typeof match.user?.login === "string" ? match.user.login : "unknown",
      userName: typeof match.user?.login === "string" ? match.user.login : undefined,
      text: typeof match.body === "string" ? match.body : "",
      ts: match.created_at ? Date.parse(match.created_at) : Date.now(),
      raw: match,
    };
  }

  async listMsg(sessionRef: SessionRef, opts?: LimitOpts): Promise<SurfaceMessage[]> {
    const githubSessionRef = resolveGithubSessionRef(sessionRef);
    if (githubSessionRef.status === "error") return signalSurfaceFailure(githubSessionRef.error);
    const resolvedSessionRef = githubSessionRef.value;
    const thread = parseGithubSessionId(resolvedSessionRef.channelId);
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
    const comments = await listIssueComments({
      owner: thread.owner,
      repo: thread.repo,
      number: thread.number,
      limit,
      page: opts?.page,
    });
    return comments.map((c) => ({
      ref: {
        platform: "github",
        channelId: resolvedSessionRef.channelId,
        messageId: String(c.id),
      },
      session: resolvedSessionRef,
      userId: typeof c.user?.login === "string" ? c.user.login : "unknown",
      userName: typeof c.user?.login === "string" ? c.user.login : undefined,
      text: typeof c.body === "string" ? c.body : "",
      ts: c.created_at ? Date.parse(c.created_at) : Date.now(),
      raw: c,
    }));
  }

  async editMsg(msgRef: MsgRef, content: ContentOpts): Promise<void> {
    const githubMsgRef = resolveGithubMsgRef(msgRef);
    if (githubMsgRef.status === "error") return signalSurfaceFailure(githubMsgRef.error);
    const resolvedMsgRef = githubMsgRef.value;
    const thread = parseGithubSessionId(resolvedMsgRef.channelId);
    const body = content.text ?? "";
    if (!body.trim()) {
      return signalSurfaceFailure(
        new GithubAdapterContractFailed({
          reason: "empty-message",
          message: "github adapter: editMsg requires non-empty text",
        }),
      );
    }
    const commentId = Number(resolvedMsgRef.messageId);
    if (!Number.isFinite(commentId) || commentId <= 0) {
      return signalSurfaceFailure(
        new GithubAdapterContractFailed({
          reason: "invalid-comment-id",
          message: `github adapter: invalid comment id '${resolvedMsgRef.messageId}'`,
        }),
      );
    }
    const rendered = content.actions
      ? renderGithubActionContent({
          text: body,
          messageId: resolvedMsgRef.messageId,
          actions: content.actions,
        })
      : body;
    await editIssueComment({
      owner: thread.owner,
      repo: thread.repo,
      commentId,
      body: markGithubAgentComment(rendered),
    });
  }

  async deleteMsg(_msgRef: MsgRef): Promise<void> {
    return signalSurfaceFailure(
      new GithubAdapterContractFailed({
        reason: "unsupported-operation",
        message: "github adapter: deleteMsg not supported",
      }),
    );
  }

  async getReplyContext(sessionMsgRef: MsgRef, opts?: LimitOpts): Promise<SurfaceMessage[]> {
    const githubMsgRef = resolveGithubMsgRef(sessionMsgRef);
    if (githubMsgRef.status === "error") return signalSurfaceFailure(githubMsgRef.error);
    const sessionRef: SessionRef = {
      platform: "github",
      channelId: githubMsgRef.value.channelId,
    };
    return await this.listMsg(sessionRef, opts);
  }

  async addReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {
    return signalSurfaceFailure(
      new GithubAdapterContractFailed({
        reason: "unsupported-operation",
        message:
          "github adapter: reactions should be handled via github-api helpers (needs reaction id for safe removal)",
      }),
    );
  }

  async removeReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {
    return signalSurfaceFailure(
      new GithubAdapterContractFailed({
        reason: "unsupported-operation",
        message:
          "github adapter: reactions should be handled via github-api helpers (needs reaction id for safe removal)",
      }),
    );
  }

  async listReactions(_msgRef: MsgRef): Promise<string[]> {
    return [];
  }

  async subscribe(_handler: AdapterEventHandler): Promise<AdapterSubscription> {
    // GitHub ingress is webhook-driven (not adapter subscription).
    return {
      stop: async () => undefined,
    };
  }

  async getUnRead(_sessionRef: SessionRef): Promise<SurfaceMessage[]> {
    return [];
  }

  async markRead(_sessionRef: SessionRef, _upToMsgRef?: MsgRef): Promise<void> {
    // no-op
  }
}

export class GithubMessageCreatedError extends Error {
  constructor(
    readonly messageRef: MsgRef,
    cause: unknown,
  ) {
    super(
      `GitHub comment ${messageRef.messageId} was created but its action edit failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
