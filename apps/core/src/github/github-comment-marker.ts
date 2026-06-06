export const GITHUB_AGENT_COMMENT_MARKER = "<!-- lilac:agent-comment -->";

export function markGithubAgentComment(body: string): string {
  const trimmed = body.trim();
  return trimmed.startsWith(GITHUB_AGENT_COMMENT_MARKER)
    ? trimmed
    : `${GITHUB_AGENT_COMMENT_MARKER}\n${trimmed}`;
}

export function isMarkedGithubAgentComment(body: string): boolean {
  const firstContentLine = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstContentLine === GITHUB_AGENT_COMMENT_MARKER;
}
