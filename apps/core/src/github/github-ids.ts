export type GithubThreadRef = {
  owner: string;
  repo: string;
  number: number;
};

export function parseGithubSessionId(sessionId: string): GithubThreadRef {
  // Expected: OWNER/REPO#<number>
  const m = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(sessionId.trim());
  if (!m) {
    throw new Error(`Invalid GitHub sessionId '${sessionId}'. Expected 'OWNER/REPO#<number>'.`);
  }
  const number = Number(m[3]);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Invalid GitHub issue/PR number in sessionId '${sessionId}'`);
  }
  return { owner: m[1]!, repo: m[2]!, number };
}

export function parseGithubRequestId(input: { requestId: string }): {
  platform: "github";
  sessionId: string;
  triggerId: string;
  extra: string[];
} | null {
  const parts = input.requestId.split(":");
  if (parts.length < 3) return null;
  if (parts[0] !== "github") return null;
  const sessionId = parts[1];
  const triggerId = parts[2];
  if (!sessionId || !triggerId) return null;
  return {
    platform: "github",
    sessionId,
    triggerId,
    extra: parts.slice(3),
  };
}

export function isGithubIssueTriggerId(input: { sessionId: string; triggerId: string }): boolean {
  // Convention: if triggerId equals the issue/PR number in sessionId, treat it
  // as a reaction target on the issue itself (PR description).
  const thread = parseGithubSessionId(input.sessionId);
  return String(thread.number) === input.triggerId;
}

export function githubMessageUrl(input: {
  sessionId: string;
  messageId: string;
  issueId?: number;
}): string {
  const thread = parseGithubSessionId(input.sessionId);
  const threadUrl = `https://github.com/${encodeURIComponent(thread.owner)}/${encodeURIComponent(thread.repo)}/issues/${thread.number}`;

  if (String(thread.number) === input.messageId) {
    return input.issueId ? `${threadUrl}#issue-${input.issueId}` : threadUrl;
  }

  return `${threadUrl}#issuecomment-${encodeURIComponent(input.messageId)}`;
}
