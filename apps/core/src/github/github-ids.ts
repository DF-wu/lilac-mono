export type GithubThreadRef = {
  owner: string;
  repo: string;
  number: number;
};

// Expected: OWNER/REPO#<number>
const GITHUB_SESSION_ID_PATTERN = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/;

export function parseGithubSessionId(sessionId: string): GithubThreadRef {
  const m = GITHUB_SESSION_ID_PATTERN.exec(sessionId.trim());
  if (!m) {
    throw new Error(`Invalid GitHub sessionId '${sessionId}'. Expected 'OWNER/REPO#<number>'.`);
  }
  const number = Number(m[3]);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Invalid GitHub issue/PR number in sessionId '${sessionId}'`);
  }
  return { owner: m[1]!, repo: m[2]!, number };
}

export function parseGithubSessionIdOrNull(sessionId: string): GithubThreadRef | null {
  const m = GITHUB_SESSION_ID_PATTERN.exec(sessionId.trim());
  if (!m) return null;
  const number = Number(m[3]);
  if (!Number.isFinite(number) || number <= 0) return null;
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

export const DEFAULT_GITHUB_WEB_BASE_URL = "https://github.com";

/**
 * Web origin for links into the configured GitHub host, the reverse of `deriveApiBaseUrl`: an
 * explicit host wins, then the API base URL's origin without a leading `api.`, then github.com.
 */
export function githubWebBaseUrl(input: {
  host?: string | undefined;
  apiBaseUrl?: string | undefined;
}): string {
  const host = input.host
    ?.trim()
    .replace(/^https?:\/\//u, "")
    .replace(/\/+$/u, "");
  if (host) return host === "github.com" ? DEFAULT_GITHUB_WEB_BASE_URL : `https://${host}`;
  const api = input.apiBaseUrl ? /^(https?):\/\/([^/?#]+)/u.exec(input.apiBaseUrl.trim()) : null;
  if (!api) return DEFAULT_GITHUB_WEB_BASE_URL;
  const apiHost = api[2]!;
  const webHost = apiHost.startsWith("api.") ? apiHost.slice("api.".length) : apiHost;
  return `${api[1]!}://${webHost}`;
}

function githubThreadMessageUrl(
  thread: GithubThreadRef,
  input: { messageId: string; webBaseUrl?: string | undefined },
): string {
  const base = (input.webBaseUrl ?? DEFAULT_GITHUB_WEB_BASE_URL).replace(/\/+$/u, "");
  const threadUrl = `${base}/${encodeURIComponent(thread.owner)}/${encodeURIComponent(thread.repo)}/issues/${thread.number}`;
  if (String(thread.number) === input.messageId) return threadUrl;
  return `${threadUrl}#issuecomment-${encodeURIComponent(input.messageId)}`;
}

/**
 * Permalink for a GitHub message reference. `messageId` carries the thread number for an issue or
 * pull request body and the issue-comment database id otherwise (see `isGithubIssueTriggerId`).
 * The `/issues/<number>` base also serves pull requests: GitHub redirects to `/pull/<number>` and
 * keeps the fragment. The thread URL already opens at the body, so body links carry no anchor.
 */
export function githubMessageUrl(input: {
  sessionId: string;
  messageId: string;
  webBaseUrl?: string | undefined;
}): string {
  return githubThreadMessageUrl(parseGithubSessionId(input.sessionId), input);
}

/**
 * GitHub comments have no native reply target, so replies carry a permalink prefix instead. A
 * session id that is not a GitHub thread keeps the bare message id, so callers never throw.
 */
export function githubReplyPrefix(input: {
  sessionId: string;
  messageId: string;
  webBaseUrl?: string | undefined;
}): string {
  const thread = parseGithubSessionIdOrNull(input.sessionId);
  const target = thread ? githubThreadMessageUrl(thread, input) : input.messageId;
  return `In reply to ${target}:\n\n`;
}
