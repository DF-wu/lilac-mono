import { Panic, Result } from "better-result";

import {
  createIssueComment,
  createIssueCommentReaction,
  createIssueReaction,
  deleteIssueComment,
  deleteIssueCommentReactionById,
  deleteIssueReactionById,
  editIssueComment,
  getGithubAppSlugOrNull,
  getIssue,
  getIssueComment,
  getPreferredGithubActorLoginOrNull,
  GithubApiError,
  listIssueCommentReactions,
  listIssueComments,
  listIssueReactions,
  type GithubReaction,
} from "../../github/github-api";
import { GithubAuthFailed } from "../../github/github-auth";
import { markGithubAgentComment } from "../../github/github-comment-marker";
import { isGithubIssueTriggerId, parseGithubSessionId } from "../../github/github-ids";
import {
  SurfaceInvalidInput,
  SurfaceMessageNotFound,
  SurfaceOperationPartiallyCompleted,
  SurfaceOperationUnsupported,
  SurfacePermissionDenied,
  SurfacePlatformMismatch,
  SurfaceRateLimited,
  SurfaceSessionMismatch,
  SurfaceUnavailable,
  type StartOutputOpts,
  type SurfaceAdapter,
  type SurfaceOperation,
  type SurfaceOperationError,
  type SurfaceOperationResult,
  type SurfaceOutputStream,
  type SurfaceSendPreparationInput,
  type TypingIndicatorSubscription,
} from "../adapter";
import type {
  ContentOpts,
  GithubMsgRef,
  GithubSessionRef,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfaceReactionDetail,
  SurfaceSelf,
  SurfaceSession,
  SurfaceSessionParticipantsResult,
} from "../types";
import { renderGithubActionContent } from "./github-actions";
import { GithubOutputStream } from "./output/github-output-stream";

const GITHUB_REACTION_CONTENTS = [
  "+1",
  "-1",
  "laugh",
  "confused",
  "heart",
  "hooray",
  "rocket",
  "eyes",
] as const;

type GithubReactionContent = (typeof GITHUB_REACTION_CONTENTS)[number];

const DEFAULT_GITHUB_ADAPTER_API = {
  getIssue,
  listIssueComments,
  createIssueComment,
  getIssueComment,
  editIssueComment,
  deleteIssueComment,
  createIssueReaction,
  createIssueCommentReaction,
  listIssueReactions,
  listIssueCommentReactions,
  deleteIssueReactionById,
  deleteIssueCommentReactionById,
  getGithubAppSlugOrNull,
  getPreferredGithubActorLoginOrNull,
};

export type GithubAdapterApi = Omit<
  typeof DEFAULT_GITHUB_ADAPTER_API,
  "getPreferredGithubActorLoginOrNull"
> & {
  readonly getPreferredGithubActorLoginOrNull?: typeof getPreferredGithubActorLoginOrNull;
};

function unsupported(operation: SurfaceOperation, message: string): SurfaceOperationError {
  return new SurfaceOperationUnsupported({ platform: "github", operation, message });
}

function invalidInput(
  operation: SurfaceOperation,
  field: string,
  message: string,
): SurfaceOperationError {
  return new SurfaceInvalidInput({ platform: "github", operation, field, message });
}

function githubSessionRefResult(
  operation: SurfaceOperation,
  sessionRef: SessionRef,
  refRole = "sessionRef",
): SurfaceOperationResult<GithubSessionRef> {
  if (sessionRef.platform === "github") return Result.ok(sessionRef);
  return Result.err(
    new SurfacePlatformMismatch({
      operation,
      refRole,
      expectedPlatform: "github",
      receivedPlatform: sessionRef.platform,
      message: `Expected a GitHub ${refRole}, received '${sessionRef.platform}'`,
    }),
  );
}

function githubMsgRefResult(
  operation: SurfaceOperation,
  msgRef: MsgRef,
  refRole = "msgRef",
): SurfaceOperationResult<GithubMsgRef> {
  if (msgRef.platform === "github") return Result.ok(msgRef);
  return Result.err(
    new SurfacePlatformMismatch({
      operation,
      refRole,
      expectedPlatform: "github",
      receivedPlatform: msgRef.platform,
      message: `Expected a GitHub ${refRole}, received '${msgRef.platform}'`,
    }),
  );
}

function githubNestedMsgRefResult(input: {
  readonly operation: SurfaceOperation;
  readonly sessionRef: GithubSessionRef;
  readonly msgRef: MsgRef;
  readonly refRole: string;
}): SurfaceOperationResult<GithubMsgRef> {
  const ref = githubMsgRefResult(input.operation, input.msgRef, input.refRole);
  if (ref.status === "error") return ref;
  if (ref.value.channelId === input.sessionRef.channelId) return ref;
  return Result.err(
    new SurfaceSessionMismatch({
      operation: input.operation,
      refRole: input.refRole,
      expectedSessionId: input.sessionRef.channelId,
      receivedSessionId: ref.value.channelId,
      message: `GitHub ${input.refRole} belongs to session '${ref.value.channelId}'`,
    }),
  );
}

function parseGithubThreadResult(
  operation: SurfaceOperation,
  sessionRef: GithubSessionRef,
): SurfaceOperationResult<ReturnType<typeof parseGithubSessionId>> {
  try {
    return Result.ok(parseGithubSessionId(sessionRef.channelId));
  } catch {
    return Result.err(
      invalidInput(
        operation,
        "sessionRef.channelId",
        `Invalid GitHub session id '${sessionRef.channelId}'`,
      ),
    );
  }
}

type PreparedGithubSend = {
  readonly ref: GithubSessionRef;
  readonly text: string;
  readonly thread: ReturnType<typeof parseGithubSessionId>;
};

function prepareGithubSendResult(
  sessionRef: SessionRef,
  input: SurfaceSendPreparationInput,
  opts?: SendOpts,
): SurfaceOperationResult<PreparedGithubSend> {
  const ref = githubSessionRefResult("send-message", sessionRef);
  if (ref.status === "error") return ref;
  if (opts?.replyTo) {
    const reply = githubNestedMsgRefResult({
      operation: "send-message",
      sessionRef: ref.value,
      msgRef: opts.replyTo,
      refRole: "replyTo",
    });
    if (reply.status === "error") return reply;
    return Result.err(
      unsupported("send-message", "GitHub message replies are not supported by sendMsg"),
    );
  }
  if (input.attachmentCount > 0) {
    return Result.err(unsupported("send-message", "GitHub message attachments are not supported"));
  }
  const text = input.text ?? "";
  if (!text.trim()) {
    return Result.err(invalidInput("send-message", "content.text", "Message text is required"));
  }
  const thread = parseGithubThreadResult("send-message", ref.value);
  if (thread.status === "error") return thread;
  return Result.ok({ ref: ref.value, text, thread: thread.value });
}

function githubCommentIdResult(
  operation: SurfaceOperation,
  messageId: string,
): SurfaceOperationResult<number> {
  if (!/^[1-9]\d*$/u.test(messageId)) {
    return Result.err(
      invalidInput(operation, "messageId", `Invalid GitHub commentId '${messageId}'`),
    );
  }
  const commentId = Number(messageId);
  if (Number.isSafeInteger(commentId) && commentId > 0) return Result.ok(commentId);
  return Result.err(
    invalidInput(operation, "messageId", `Invalid GitHub commentId '${messageId}'`),
  );
}

export function classifyGithubSurfaceError(
  operation: SurfaceOperation,
  cause: unknown,
): SurfaceOperationError | null {
  if (cause instanceof GithubAuthFailed) {
    return new SurfaceUnavailable({
      platform: "github",
      operation,
      message: cause.message,
    });
  }
  if (!(cause instanceof GithubApiError)) return null;
  if (cause.status === 404) {
    return new SurfaceMessageNotFound({ platform: "github", operation, message: cause.message });
  }
  if (cause.status === 429 || cause.rateLimit) {
    return new SurfaceRateLimited({
      platform: "github",
      operation,
      ...(cause.rateLimit?.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: cause.rateLimit.retryAfterMs }),
      message: cause.message,
    });
  }
  if (cause.status === 401 || cause.status === 403) {
    return new SurfacePermissionDenied({ platform: "github", operation, message: cause.message });
  }
  if (cause.status === 400 || cause.status === 422) {
    return invalidInput(operation, "request", cause.message);
  }
  if (cause.status >= 500) {
    return new SurfaceUnavailable({ platform: "github", operation, message: cause.message });
  }
  return null;
}

async function captureGithubOperation<T>(
  operation: SurfaceOperation,
  effect: () => Promise<T>,
): Promise<SurfaceOperationResult<T>> {
  try {
    return Result.ok(await effect());
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    const classified = classifyGithubSurfaceError(operation, cause);
    if (classified) return Result.err(classified);
    throw cause;
  }
}

function githubReactionContentResult(
  operation: SurfaceOperation,
  reaction: string,
): SurfaceOperationResult<GithubReactionContent> {
  const raw = reaction.trim();
  const alias = raw.startsWith(":") && raw.endsWith(":") ? raw.slice(1, -1) : raw;
  const normalized = alias.trim().toLowerCase();
  const aliases: Readonly<Record<string, GithubReactionContent>> = {
    "+1": "+1",
    "-1": "-1",
    "👍": "+1",
    "👎": "-1",
    "😄": "laugh",
    "😕": "confused",
    "❤️": "heart",
    "🎉": "hooray",
    "🚀": "rocket",
    "👀": "eyes",
    thumbsup: "+1",
    thumbs_up: "+1",
    like: "+1",
    thumbsdown: "-1",
    thumbs_down: "-1",
    dislike: "-1",
    smile: "laugh",
    grin: "laugh",
    confusion: "confused",
    thinking: "confused",
    love: "heart",
    tada: "hooray",
    party: "hooray",
  };
  const content = aliases[raw] ?? aliases[normalized];
  if (content) return Result.ok(content);
  if ((GITHUB_REACTION_CONTENTS as readonly string[]).includes(normalized)) {
    return Result.ok(normalized as GithubReactionContent);
  }
  return Result.err(
    invalidInput(
      operation,
      "reaction",
      `Unsupported GitHub reaction '${reaction}'. Supported: ${GITHUB_REACTION_CONTENTS.join(", ")}, or emoji equivalents like 👍 👀 🚀`,
    ),
  );
}

function githubReactionEmoji(content: string): string {
  switch (content) {
    case "+1":
      return "👍";
    case "-1":
      return "👎";
    case "laugh":
      return "😄";
    case "confused":
      return "😕";
    case "heart":
      return "❤️";
    case "hooray":
      return "🎉";
    case "rocket":
      return "🚀";
    case "eyes":
      return "👀";
    default:
      return content;
  }
}

function parseGithubTimestamp(value: string | undefined): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function toGithubMessage(input: {
  readonly ref: GithubMsgRef;
  readonly session: GithubSessionRef;
  readonly body: string;
  readonly user?: { readonly login?: string; readonly id?: number };
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly raw: unknown;
}): SurfaceMessage {
  const login = input.user?.login;
  const id = input.user?.id;
  return {
    ref: input.ref,
    session: input.session,
    userId: id !== undefined ? String(id) : (login ?? "unknown"),
    ...(login ? { userName: login } : {}),
    text: input.body,
    ts: parseGithubTimestamp(input.createdAt),
    editedTs: parseGithubTimestamp(input.updatedAt),
    raw: input.raw,
  };
}

export class GithubAdapter implements SurfaceAdapter {
  private readonly api: GithubAdapterApi;

  constructor(input: { readonly api?: GithubAdapterApi } = {}) {
    this.api = input.api ?? DEFAULT_GITHUB_ADAPTER_API;
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async getSelf(): Promise<SurfaceSelf> {
    return { platform: "github", userId: "github", userName: "github" };
  }

  async listSessions(): Promise<SurfaceOperationResult<SurfaceSession[]>> {
    return Result.err(
      unsupported(
        "list-sessions",
        "GitHub session discovery is not supported; use GitHub issue/PR discovery",
      ),
    );
  }

  async listSessionParticipants(
    sessionRef: SessionRef,
    _opts?: { limit?: number },
  ): Promise<SurfaceOperationResult<SurfaceSessionParticipantsResult>> {
    const ref = githubSessionRefResult("list-session-participants", sessionRef);
    if (ref.status === "error") return ref;
    return Result.err(
      unsupported(
        "list-session-participants",
        "GitHub session participant listing is not supported",
      ),
    );
  }

  async startOutput(
    sessionRef: SessionRef,
    opts?: StartOutputOpts,
  ): Promise<SurfaceOperationResult<SurfaceOutputStream>> {
    const ref = githubSessionRefResult("start-output", sessionRef);
    if (ref.status === "error") return ref;
    if (opts?.replyTo) {
      const reply = githubNestedMsgRefResult({
        operation: "start-output",
        sessionRef: ref.value,
        msgRef: opts.replyTo,
        refRole: "replyTo",
      });
      if (reply.status === "error") return reply;
    }
    for (const [index, created] of (opts?.resume?.created ?? []).entries()) {
      const resumed = githubNestedMsgRefResult({
        operation: "start-output",
        sessionRef: ref.value,
        msgRef: created,
        refRole: `resume.created[${index}]`,
      });
      if (resumed.status === "error") return resumed;
    }
    const thread = parseGithubThreadResult("start-output", ref.value);
    if (thread.status === "error") return thread;
    return Result.ok(
      new GithubOutputStream(
        ref.value,
        {
          createComment: async (body) => {
            const created = await captureGithubOperation("finish-output", () =>
              this.api.createIssueComment({
                owner: thread.value.owner,
                repo: thread.value.repo,
                issueNumber: thread.value.number,
                body,
              }),
            );
            if (created.status === "error") return created;
            return Result.ok({ id: created.value.id });
          },
        },
        opts?.replyTo ? { replyTo: opts.replyTo } : undefined,
      ),
    );
  }

  async startTyping(
    sessionRef: SessionRef,
  ): Promise<SurfaceOperationResult<TypingIndicatorSubscription>> {
    const ref = githubSessionRefResult("start-typing", sessionRef);
    if (ref.status === "error") return ref;
    return Result.err(unsupported("start-typing", "GitHub typing indicators are not supported"));
  }

  async prepareSendMsg(
    sessionRef: SessionRef,
    input: SurfaceSendPreparationInput,
    opts?: SendOpts,
  ): Promise<SurfaceOperationResult<void>> {
    const prepared = prepareGithubSendResult(sessionRef, input, opts);
    return prepared.status === "error" ? prepared : Result.ok(undefined);
  }

  async sendMsg(
    sessionRef: SessionRef,
    content: ContentOpts,
    opts?: SendOpts,
  ): Promise<SurfaceOperationResult<MsgRef>> {
    const prepared = prepareGithubSendResult(
      sessionRef,
      {
        text: content.text,
        attachmentCount: content.attachments?.length ?? 0,
        actionCount: content.actions?.length ?? 0,
      },
      opts,
    );
    if (prepared.status === "error") return prepared;
    const created = await captureGithubOperation("send-message", () =>
      this.api.createIssueComment({
        owner: prepared.value.thread.owner,
        repo: prepared.value.thread.repo,
        issueNumber: prepared.value.thread.number,
        body: markGithubAgentComment(prepared.value.text),
      }),
    );
    if (created.status === "error") return created;
    const createdRef: GithubMsgRef = {
      platform: "github",
      channelId: prepared.value.ref.channelId,
      messageId: String(created.value.id),
    };
    if (content.actions && content.actions.length > 0) {
      const edited = await captureGithubOperation("send-message", () =>
        this.api.editIssueComment({
          owner: prepared.value.thread.owner,
          repo: prepared.value.thread.repo,
          commentId: created.value.id,
          body: markGithubAgentComment(
            renderGithubActionContent({
              text: prepared.value.text,
              messageId: createdRef.messageId,
              actions: content.actions ?? [],
            }),
          ),
        }),
      );
      if (edited.status === "error") {
        return Result.err(
          new SurfaceOperationPartiallyCompleted({
            platform: "github",
            operation: "send-message",
            created: createdRef,
            message: `GitHub comment ${createdRef.messageId} was created but its action edit failed`,
          }),
        );
      }
    }
    return Result.ok(createdRef);
  }

  async readMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage | null>> {
    const ref = githubMsgRefResult("read-message", msgRef);
    if (ref.status === "error") return ref;
    const session: GithubSessionRef = { platform: "github", channelId: ref.value.channelId };
    const thread = parseGithubThreadResult("read-message", session);
    if (thread.status === "error") return thread;
    if (
      isGithubIssueTriggerId({ sessionId: ref.value.channelId, triggerId: ref.value.messageId })
    ) {
      const issue = await captureGithubOperation("read-message", () =>
        this.api.getIssue({
          owner: thread.value.owner,
          repo: thread.value.repo,
          number: thread.value.number,
        }),
      );
      if (issue.status === "error") return issue;
      return Result.ok(
        toGithubMessage({
          ref: { ...ref.value, messageId: String(thread.value.number) },
          session,
          body: `Title: ${issue.value.title}\n\n${issue.value.body ?? ""}`.trim(),
          user: issue.value.user,
          createdAt: issue.value.created_at,
          updatedAt: issue.value.updated_at,
          raw: { title: issue.value.title, htmlUrl: issue.value.html_url },
        }),
      );
    }
    const commentId = githubCommentIdResult("read-message", ref.value.messageId);
    if (commentId.status === "error") return commentId;
    const comment = await captureGithubOperation("read-message", () =>
      this.api.getIssueComment({
        owner: thread.value.owner,
        repo: thread.value.repo,
        commentId: commentId.value,
      }),
    );
    if (comment.status === "error") return comment;
    return Result.ok(
      toGithubMessage({
        ref: { ...ref.value, messageId: String(comment.value.id) },
        session,
        body: comment.value.body ?? "",
        user: comment.value.user,
        createdAt: comment.value.created_at,
        updatedAt: comment.value.updated_at,
        raw: { htmlUrl: comment.value.html_url },
      }),
    );
  }

  async listMsg(
    sessionRef: SessionRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const ref = githubSessionRefResult("list-messages", sessionRef);
    if (ref.status === "error") return ref;
    return await this.listGithubMessages("list-messages", ref.value, opts);
  }

  private async listGithubMessages(
    operation: SurfaceOperation,
    sessionRef: GithubSessionRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    if (opts?.beforeMessageId || opts?.afterMessageId) {
      return Result.err(
        unsupported(operation, "GitHub message listing does not support cursor options"),
      );
    }
    const thread = parseGithubThreadResult(operation, sessionRef);
    if (thread.status === "error") return thread;
    const comments = await captureGithubOperation(operation, () =>
      this.api.listIssueComments({
        owner: thread.value.owner,
        repo: thread.value.repo,
        number: thread.value.number,
        limit: Math.min(Math.max(opts?.limit ?? 50, 1), 100),
        page: opts?.page,
      }),
    );
    if (comments.status === "error") return comments;
    return Result.ok(
      comments.value.map((comment) =>
        toGithubMessage({
          ref: {
            platform: "github",
            channelId: sessionRef.channelId,
            messageId: String(comment.id),
          },
          session: sessionRef,
          body: comment.body ?? "",
          user: comment.user,
          createdAt: comment.created_at,
          updatedAt: comment.updated_at,
          raw: { htmlUrl: comment.html_url },
        }),
      ),
    );
  }

  async editMsg(msgRef: MsgRef, content: ContentOpts): Promise<SurfaceOperationResult<void>> {
    const ref = githubMsgRefResult("edit-message", msgRef);
    if (ref.status === "error") return ref;
    if ((content.attachments?.length ?? 0) > 0) {
      return Result.err(
        unsupported("edit-message", "GitHub comment attachment edits are not supported"),
      );
    }
    if (
      isGithubIssueTriggerId({ sessionId: ref.value.channelId, triggerId: ref.value.messageId })
    ) {
      return Result.err(
        unsupported("edit-message", "Editing GitHub issue or PR bodies is not supported"),
      );
    }
    const body = content.text ?? "";
    if (!body.trim()) {
      return Result.err(invalidInput("edit-message", "content.text", "Message text is required"));
    }
    const session: GithubSessionRef = { platform: "github", channelId: ref.value.channelId };
    const thread = parseGithubThreadResult("edit-message", session);
    if (thread.status === "error") return thread;
    const commentId = githubCommentIdResult("edit-message", ref.value.messageId);
    if (commentId.status === "error") return commentId;
    const rendered = content.actions
      ? renderGithubActionContent({
          text: body,
          messageId: ref.value.messageId,
          actions: content.actions,
        })
      : body;
    return await captureGithubOperation("edit-message", () =>
      this.api.editIssueComment({
        owner: thread.value.owner,
        repo: thread.value.repo,
        commentId: commentId.value,
        body: rendered,
      }),
    );
  }

  async deleteMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<void>> {
    const ref = githubMsgRefResult("delete-message", msgRef);
    if (ref.status === "error") return ref;
    if (
      isGithubIssueTriggerId({ sessionId: ref.value.channelId, triggerId: ref.value.messageId })
    ) {
      return Result.err(
        unsupported("delete-message", "Deleting GitHub issue or PR bodies is not supported"),
      );
    }
    const session: GithubSessionRef = { platform: "github", channelId: ref.value.channelId };
    const thread = parseGithubThreadResult("delete-message", session);
    if (thread.status === "error") return thread;
    const commentId = githubCommentIdResult("delete-message", ref.value.messageId);
    if (commentId.status === "error") return commentId;
    return await captureGithubOperation("delete-message", () =>
      this.api.deleteIssueComment({
        owner: thread.value.owner,
        repo: thread.value.repo,
        commentId: commentId.value,
      }),
    );
  }

  async getReplyContext(
    msgRef: MsgRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const ref = githubMsgRefResult("get-reply-context", msgRef);
    if (ref.status === "error") return ref;
    return await this.listGithubMessages(
      "get-reply-context",
      { platform: "github", channelId: ref.value.channelId },
      opts,
    );
  }

  async planReplyChain(msgRef: MsgRef): Promise<SurfaceOperationResult<readonly MsgRef[]>> {
    const ref = githubMsgRefResult("plan-reply-chain", msgRef);
    if (ref.status === "error") return ref;
    return Result.err(
      unsupported("plan-reply-chain", "GitHub reply-chain planning is not supported"),
    );
  }

  async planMergeBlockEndingAt(msgRef: MsgRef): Promise<SurfaceOperationResult<readonly MsgRef[]>> {
    const ref = githubMsgRefResult("plan-merge-block", msgRef);
    if (ref.status === "error") return ref;
    return Result.err(
      unsupported("plan-merge-block", "GitHub merge-block planning is not supported"),
    );
  }

  private async listGithubReactions(
    operation: SurfaceOperation,
    ref: GithubMsgRef,
  ): Promise<SurfaceOperationResult<GithubReaction[]>> {
    const session: GithubSessionRef = { platform: "github", channelId: ref.channelId };
    const thread = parseGithubThreadResult(operation, session);
    if (thread.status === "error") return thread;
    if (isGithubIssueTriggerId({ sessionId: ref.channelId, triggerId: ref.messageId })) {
      return await captureGithubOperation(operation, () =>
        this.api.listIssueReactions({
          owner: thread.value.owner,
          repo: thread.value.repo,
          issueNumber: thread.value.number,
          limit: 100,
        }),
      );
    }
    const commentId = githubCommentIdResult(operation, ref.messageId);
    if (commentId.status === "error") return commentId;
    return await captureGithubOperation(operation, () =>
      this.api.listIssueCommentReactions({
        owner: thread.value.owner,
        repo: thread.value.repo,
        commentId: commentId.value,
        limit: 100,
      }),
    );
  }

  async addReaction(msgRef: MsgRef, reaction: string): Promise<SurfaceOperationResult<void>> {
    const ref = githubMsgRefResult("add-reaction", msgRef);
    if (ref.status === "error") return ref;
    const content = githubReactionContentResult("add-reaction", reaction);
    if (content.status === "error") return content;
    const session: GithubSessionRef = { platform: "github", channelId: ref.value.channelId };
    const thread = parseGithubThreadResult("add-reaction", session);
    if (thread.status === "error") return thread;
    if (
      isGithubIssueTriggerId({ sessionId: ref.value.channelId, triggerId: ref.value.messageId })
    ) {
      const created = await captureGithubOperation("add-reaction", () =>
        this.api.createIssueReaction({
          owner: thread.value.owner,
          repo: thread.value.repo,
          issueNumber: thread.value.number,
          content: content.value,
        }),
      );
      return created.status === "error" ? created : Result.ok(undefined);
    }
    const commentId = githubCommentIdResult("add-reaction", ref.value.messageId);
    if (commentId.status === "error") return commentId;
    const created = await captureGithubOperation("add-reaction", () =>
      this.api.createIssueCommentReaction({
        owner: thread.value.owner,
        repo: thread.value.repo,
        commentId: commentId.value,
        content: content.value,
      }),
    );
    return created.status === "error" ? created : Result.ok(undefined);
  }

  async removeReaction(msgRef: MsgRef, reaction: string): Promise<SurfaceOperationResult<void>> {
    const ref = githubMsgRefResult("remove-reaction", msgRef);
    if (ref.status === "error") return ref;
    const content = githubReactionContentResult("remove-reaction", reaction);
    if (content.status === "error") return content;
    const session: GithubSessionRef = { platform: "github", channelId: ref.value.channelId };
    const thread = parseGithubThreadResult("remove-reaction", session);
    if (thread.status === "error") return thread;
    const actor = await captureGithubOperation("remove-reaction", async () => {
      const preferred = this.api.getPreferredGithubActorLoginOrNull
        ? await this.api.getPreferredGithubActorLoginOrNull()
        : null;
      if (preferred) return preferred;
      const slug = await this.api.getGithubAppSlugOrNull();
      return slug ? `${slug}[bot]` : null;
    });
    if (actor.status === "error") return actor;
    if (!actor.value) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "github",
          operation: "remove-reaction",
          message: "Unable to resolve the outbound GitHub actor login",
        }),
      );
    }
    const reactions = await this.listGithubReactions("remove-reaction", ref.value);
    if (reactions.status === "error") return reactions;
    const mine = reactions.value.filter(
      (item) => item.content === content.value && item.user?.login === actor.value,
    );
    if (
      isGithubIssueTriggerId({ sessionId: ref.value.channelId, triggerId: ref.value.messageId })
    ) {
      for (const item of mine) {
        const deleted = await captureGithubOperation("remove-reaction", () =>
          this.api.deleteIssueReactionById({
            owner: thread.value.owner,
            repo: thread.value.repo,
            issueNumber: thread.value.number,
            reactionId: item.id,
          }),
        );
        if (deleted.status === "error") return deleted;
      }
      return Result.ok(undefined);
    }
    const commentId = githubCommentIdResult("remove-reaction", ref.value.messageId);
    if (commentId.status === "error") return commentId;
    for (const item of mine) {
      const deleted = await captureGithubOperation("remove-reaction", () =>
        this.api.deleteIssueCommentReactionById({
          owner: thread.value.owner,
          repo: thread.value.repo,
          commentId: commentId.value,
          reactionId: item.id,
        }),
      );
      if (deleted.status === "error") return deleted;
    }
    return Result.ok(undefined);
  }

  async listReactions(msgRef: MsgRef): Promise<SurfaceOperationResult<string[]>> {
    const detailed = await this.listGithubReactionDetails("list-reactions", msgRef);
    if (detailed.status === "error") return detailed;
    return Result.ok(detailed.value.map((item) => item.emoji));
  }

  async listReactionDetails(
    msgRef: MsgRef,
  ): Promise<SurfaceOperationResult<SurfaceReactionDetail[]>> {
    return await this.listGithubReactionDetails("list-reaction-details", msgRef);
  }

  private async listGithubReactionDetails(
    operation: "list-reactions" | "list-reaction-details",
    msgRef: MsgRef,
  ): Promise<SurfaceOperationResult<SurfaceReactionDetail[]>> {
    const ref = githubMsgRefResult(operation, msgRef);
    if (ref.status === "error") return ref;
    const reactions = await this.listGithubReactions(operation, ref.value);
    if (reactions.status === "error") return reactions;
    const byContent = new Map<
      string,
      { count: number; users: Array<{ userId: string; userName?: string }> }
    >();
    for (const reaction of reactions.value) {
      const entry = byContent.get(reaction.content) ?? { count: 0, users: [] };
      entry.count += 1;
      const login = reaction.user?.login;
      const id = reaction.user?.id;
      if (login || id !== undefined) {
        const userId = id !== undefined ? String(id) : login!;
        if (!entry.users.some((user) => user.userId === userId)) {
          entry.users.push({ userId, ...(login ? { userName: login } : {}) });
        }
      }
      byContent.set(reaction.content, entry);
    }
    return Result.ok(
      Array.from(byContent.entries()).map(([content, entry]) => ({
        emoji: githubReactionEmoji(content),
        count: entry.count,
        users: entry.users,
      })),
    );
  }

  async getUnRead(sessionRef: SessionRef): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const ref = githubSessionRefResult("get-unread", sessionRef);
    if (ref.status === "error") return ref;
    return Result.err(unsupported("get-unread", "GitHub unread tracking is not supported"));
  }

  async markRead(
    sessionRef: SessionRef,
    upToMsgRef?: MsgRef,
  ): Promise<SurfaceOperationResult<void>> {
    const ref = githubSessionRefResult("mark-read", sessionRef);
    if (ref.status === "error") return ref;
    if (upToMsgRef) {
      const upTo = githubNestedMsgRefResult({
        operation: "mark-read",
        sessionRef: ref.value,
        msgRef: upToMsgRef,
        refRole: "upToMsgRef",
      });
      if (upTo.status === "error") return upTo;
    }
    return Result.err(unsupported("mark-read", "GitHub read-state tracking is not supported"));
  }
}
