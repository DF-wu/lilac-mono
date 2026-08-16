import type { MiniLilacSessionSnapshot } from "@stanley2058/mini-lilac-client";

const MAX_TITLE_LENGTH = 100;

export interface SessionPresentation {
  readonly title: string;
  readonly inputTokens: number | null;
  /** True when `inputTokens` is a post-compaction estimate, not reported usage. */
  readonly inputTokensEstimated: boolean;
  readonly contextWindow: number | null;
  /** Context fraction at which the server compacts automatically. */
  readonly compactionThreshold: number | null;
}

const EMPTY_PRESENTATION: SessionPresentation = {
  title: "Mini Lilac",
  inputTokens: null,
  inputTokensEstimated: false,
  contextWindow: null,
  compactionThreshold: null,
};

export function sessionPresentation(
  snapshot:
    | Pick<
        MiniLilacSessionSnapshot,
        "title" | "inputTokens" | "inputTokensEstimated" | "contextWindow" | "compactionThreshold"
      >
    | undefined,
): SessionPresentation {
  if (snapshot === undefined) return EMPTY_PRESENTATION;
  return {
    title: snapshot.title ?? "Mini Lilac",
    inputTokens: snapshot.inputTokens ?? null,
    inputTokensEstimated: snapshot.inputTokensEstimated ?? false,
    contextWindow: snapshot.contextWindow ?? null,
    compactionThreshold: snapshot.compactionThreshold ?? null,
  };
}

export function formatSessionTitle(title: string): string {
  const characters = Array.from(title);
  if (characters.length <= MAX_TITLE_LENGTH) return title;
  return `${characters.slice(0, MAX_TITLE_LENGTH - 3).join("")}...`;
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens));
  const divisor = tokens < 1_000_000 ? 1_000 : 1_000_000;
  const suffix = divisor === 1_000 ? "K" : "M";
  const rounded = Math.round((tokens / divisor) * 10) / 10;
  if (suffix === "K" && rounded >= 1_000) return "1M";
  return `${rounded}${suffix}`;
}

export function resolveContextWindow(
  sessionContextWindow: number | null,
  modelContextWindow: number | undefined,
): number | null {
  return sessionContextWindow ?? modelContextWindow ?? null;
}

/**
 * Context meter text.
 *
 * The threshold is shown once usage is within ten points of it, so the user can
 * compact at a clean boundary instead of being interrupted mid-task. A leading
 * tilde marks an estimate, which is what post-compaction usage is until the next
 * turn reports real numbers.
 */
export function formatTokenUsage(
  inputTokens: number | null,
  contextWindow: number | null,
  options: { estimated?: boolean; compactionThreshold?: number | null } = {},
): string | undefined {
  if (inputTokens === null || contextWindow === null || contextWindow <= 0) return undefined;
  const fraction = inputTokens / contextWindow;
  const percent = Math.round(fraction * 100);
  const prefix = options.estimated === true ? "~" : "";
  const threshold = options.compactionThreshold ?? null;
  const showThreshold = threshold !== null && fraction >= threshold - 0.1;
  const detail = showThreshold
    ? `${percent}% · compacts at ${Math.round(threshold * 100)}%`
    : `${percent}%`;
  return `${prefix}${formatTokenCount(inputTokens)} (${detail})`;
}
