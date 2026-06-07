export const GITHUB_AGENT_COMMENT_MARKER = "<!-- lilac:agent-comment -->";

function transformOutsideMarkdownFences(
  input: string,
  transform: (chunk: string) => string,
): string {
  let out = "";
  let outside = "";
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;

  const flushOutside = () => {
    if (outside.length === 0) return;
    out += transform(outside);
    outside = "";
  };

  const lines = input.match(/[^\n]*(?:\n|$)/gu) ?? [];
  for (const line of lines) {
    if (line.length === 0) continue;

    const fence = /^(\s*)(`{3,}|~{3,})/u.exec(line);
    if (fence) {
      const marker = fence[2] ?? "";
      const char = marker[0] as "`" | "~";
      const len = marker.length;

      if (fenceChar === null) {
        flushOutside();
        fenceChar = char;
        fenceLen = len;
        out += line;
        continue;
      }

      if (char === fenceChar && len >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
        out += line;
        continue;
      }
    }

    if (fenceChar === null) {
      outside += line;
    } else {
      out += line;
    }
  }

  flushOutside();
  return out;
}

function stripThinkingBlocks(input: string): string {
  return input
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/giu, "")
    .replace(/<thinking\b[^>]*>[\s\S]*$/giu, "");
}

export function sanitizeGithubAgentCommentBody(body: string): string {
  const sanitized = transformOutsideMarkdownFences(body, stripThinkingBlocks)
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

  return sanitized.length > 0 ? sanitized : "[internal output omitted]";
}

export function markGithubAgentComment(body: string): string {
  const trimmed = sanitizeGithubAgentCommentBody(body);
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
