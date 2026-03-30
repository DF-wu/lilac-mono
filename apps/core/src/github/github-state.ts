type ReactionTarget =
  | { kind: "issue"; issueNumber: number }
  | { kind: "comment"; commentId: number; issueNumber: number };

const SELF_AUTHORED_ISSUE_COMMENT_TTL_MS = 30 * 60 * 1000;

export type GithubRequestMeta = {
  requestId: string;
  sessionId: string;
  repoFullName: string;
  issueNumber: number;
  trigger: ReactionTarget;
  createdAtMs: number;
  pr?: {
    prNumber: number;
    headSha: string;
    mode: "review";
  };
};

export type GithubAckState = {
  target: ReactionTarget;
  reactionId: number;
};

const latestBySession = new Map<string, string>();
const metaByRequest = new Map<string, GithubRequestMeta>();
const ackByRequest = new Map<string, GithubAckState>();
const selfAuthoredIssueCommentExpirations = new Map<number, number>();

function pruneExpiredSelfAuthoredIssueComments(now: number) {
  for (const [commentId, exp] of selfAuthoredIssueCommentExpirations) {
    if (exp <= now) {
      selfAuthoredIssueCommentExpirations.delete(commentId);
    }
  }
}

export function setGithubLatestRequestForSession(sessionId: string, requestId: string) {
  latestBySession.set(sessionId, requestId);
}

export function getGithubLatestRequestForSession(sessionId: string): string | undefined {
  return latestBySession.get(sessionId);
}

export function setGithubRequestMeta(meta: GithubRequestMeta) {
  metaByRequest.set(meta.requestId, meta);
}

export function getGithubRequestMeta(requestId: string): GithubRequestMeta | undefined {
  return metaByRequest.get(requestId);
}

export function setGithubAck(requestId: string, ack: GithubAckState) {
  ackByRequest.set(requestId, ack);
}

export function getGithubAck(requestId: string): GithubAckState | undefined {
  return ackByRequest.get(requestId);
}

export function clearGithubAck(requestId: string) {
  ackByRequest.delete(requestId);
}

export function rememberGithubSelfAuthoredIssueComment(
  commentId: number,
  ttlMs = SELF_AUTHORED_ISSUE_COMMENT_TTL_MS,
) {
  const now = Date.now();
  pruneExpiredSelfAuthoredIssueComments(now);
  selfAuthoredIssueCommentExpirations.set(commentId, now + ttlMs);
}

export function isRecentGithubSelfAuthoredIssueComment(commentId: number): boolean {
  const now = Date.now();
  pruneExpiredSelfAuthoredIssueComments(now);
  const exp = selfAuthoredIssueCommentExpirations.get(commentId);
  return typeof exp === "number" && exp > now;
}
