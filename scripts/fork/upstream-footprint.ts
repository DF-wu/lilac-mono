/**
 * Upstream footprint: the set of upstream-owned files this fork has modified.
 *
 * A fork that wants to stay mergeable keeps this set small and explicit. Every
 * entry in the allowlist names one upstream file and the reason the fork must
 * touch it; a file that drifts into the set without an entry fails the check,
 * and an entry whose file no longer differs is reported as stale so the list
 * shrinks when upstream accepts a change.
 */

export type FootprintAllowlistEntry = {
  readonly path: string;
  readonly reason: string;
};

export type FootprintAllowlist = {
  readonly entries: readonly FootprintAllowlistEntry[];
  readonly problems: readonly string[];
};

export type FootprintComparison = {
  /** Modified upstream files with no allowlist entry. */
  readonly unlisted: readonly string[];
  /** Allowlist entries whose file no longer differs from upstream. */
  readonly stale: readonly FootprintAllowlistEntry[];
  /** Modified upstream files that are covered by an entry. */
  readonly covered: readonly string[];
};

const ENTRY_SEPARATOR = "  #";

/**
 * One entry per line: `<path>  # <reason>`. Blank lines and lines starting
 * with `#` are comments. The two-space separator keeps paths that legitimately
 * contain ` #` unambiguous enough for this repository.
 */
export function parseFootprintAllowlist(text: string): FootprintAllowlist {
  const entries: FootprintAllowlistEntry[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  text.split("\n").forEach((rawLine, index) => {
    const line = rawLine.trimEnd();
    const lineNumber = index + 1;
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) return;

    const separatorIndex = line.indexOf(ENTRY_SEPARATOR);
    if (separatorIndex === -1) {
      problems.push(`line ${lineNumber}: missing '  # <reason>' after the path`);
      return;
    }

    const path = line.slice(0, separatorIndex).trim();
    const reason = line.slice(separatorIndex + ENTRY_SEPARATOR.length).trim();
    if (path.length === 0) {
      problems.push(`line ${lineNumber}: empty path`);
      return;
    }
    if (reason.length === 0) {
      problems.push(`line ${lineNumber}: empty reason for ${path}`);
      return;
    }
    if (seen.has(path)) {
      problems.push(`line ${lineNumber}: duplicate entry for ${path}`);
      return;
    }

    seen.add(path);
    entries.push({ path, reason });
  });

  return { entries, problems };
}

export function compareFootprint(input: {
  readonly modifiedUpstreamFiles: readonly string[];
  readonly allowlist: readonly FootprintAllowlistEntry[];
}): FootprintComparison {
  const modified = new Set(input.modifiedUpstreamFiles);
  const allowed = new Map(input.allowlist.map((entry) => [entry.path, entry] as const));

  const unlisted = [...modified].filter((path) => !allowed.has(path)).sort();
  const covered = [...modified].filter((path) => allowed.has(path)).sort();
  const stale = input.allowlist
    .filter((entry) => !modified.has(entry.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { unlisted, stale, covered };
}

export function formatAllowlistEntries(paths: readonly string[], reason: string): string {
  return paths.map((path) => `${path}${ENTRY_SEPARATOR} ${reason}`).join("\n");
}
