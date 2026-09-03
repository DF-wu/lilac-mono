import type { AnalyzeOptions } from "../types";
import { bashSafetyViolation, type BashSafetyCode, type BashSafetyViolation } from "../types";
import { analyzeDestructiveFilesystemCommand } from "../rules-filesystem";
import { analyzeGit } from "../rules-git";
import { analyzeRm } from "../rules-rm";
import { DYNAMIC_EXPANSION_MARKER } from "../shell";

import { hasRecursiveFlag, hasRecursiveForceFlags } from "./rm-flags";

const DANGEROUS_TEXT_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  code: BashSafetyCode;
  reason: string;
}> = [
  {
    pattern: /\bgit\b[^\n;|&)]*\breset\s+--hard\b/iu,
    code: "dangerous_git_operation",
    reason: "git reset --hard",
  },
  {
    pattern: /\bgit\b[^\n;|&)]*\breset\s+--merge\b/iu,
    code: "dangerous_git_operation",
    reason: "git reset --merge",
  },
  {
    pattern: /\bgit\b[^\n;|&)]*\bclean\b[^\n;|&)]*(?:-[^\s]*f|--force)\b/iu,
    code: "dangerous_git_operation",
    reason: "git clean -f",
  },
  {
    pattern: /\bgit\b[^\n;|&)]*\bbranch\b[^\n;|&)]*\s-[A-Za-z]*D[A-Za-z]*\b/u,
    code: "dangerous_git_operation",
    reason: "git branch -D",
  },
  {
    pattern: /\bgit\b[^\n;|&)]*\bstash\s+(?:drop|clear)\b/iu,
    code: "dangerous_git_operation",
    reason: "git stash drop/clear",
  },
  {
    pattern:
      /\bgit\b[^\n;|&)]*\bpush\b[^\n;|&)]*(?:\s-[A-Za-z]*f[A-Za-z]*\b|--force(?![-A-Za-z]))/iu,
    code: "dangerous_git_operation",
    reason: "git push --force",
  },
  {
    pattern: /\bgit\b[^\n;|&)]*\brestore\b[^\n;|&)]*(?:--worktree|\s-W\b)/iu,
    code: "dangerous_git_operation",
    reason: "git restore --worktree",
  },
  {
    pattern: /\bgit\b[^\n;|&)]*\brestore\b(?![^\n;|&)]*--staged)/iu,
    code: "dangerous_git_operation",
    reason: "git restore",
  },
  {
    pattern: /\bgit\b[^\n;|&)]*\bcheckout\b[^\n;|&)]*\s--(?:\s|$)/iu,
    code: "dangerous_git_operation",
    reason: "git checkout --",
  },
  {
    pattern: /\bgit\b[^\n;|&)]*\bcheckout\b[^\n;|&)]*--pathspec-from-file(?:=|\b)/iu,
    code: "dangerous_git_operation",
    reason: "git checkout --pathspec-from-file",
  },
  {
    pattern: /\bgit\b[^\n;|&)]*\bworktree\s+remove\b[^\n;|&)]*(?:\s-f\b|--force\b)/iu,
    code: "dangerous_git_operation",
    reason: "git worktree remove --force",
  },
  {
    pattern: /\bfind\b[^\n;|&]*\s-delete\b/iu,
    code: "find_delete",
    reason: "find -delete",
  },
];

export function dangerousReasonInText(
  text: string,
  options: Pick<AnalyzeOptions, "allowTmpdirVar" | "cwd" | "paranoidRm"> = {},
): BashSafetyViolation | null {
  for (const match of text.matchAll(/\brm\b([^\n;|&)]*)/giu)) {
    const tokens = ["rm", ...tokenizeStaticText(match[1] ?? "")];
    const filesystemReason = analyzeDestructiveFilesystemCommand(tokens, options.cwd);
    if (filesystemReason) return filesystemReason;
    if (!hasRecursiveFlag(tokens)) continue;
    const hasDynamicTarget = hasDynamicRmOperand(tokens);
    if (hasDynamicTarget) {
      if (hasRecursiveForceFlags(tokens)) {
        return bashSafetyViolation(
          "dynamic_recursive_delete",
          "rm -rf with a dynamic target is blocked because the deletion scope cannot be verified.",
          "Remove known literal child paths, then use rmdir for an empty directory.",
        );
      }
    }
    const reason = analyzeRm(withoutDynamicRmOperands(tokens), {
      cwd: options.cwd,
      originalCwd: options.cwd,
      paranoid: options.paranoidRm,
      allowTmpdirVar: options.allowTmpdirVar,
    });
    if (reason) return reason;
  }

  for (const match of text.matchAll(/\bgit\b([^\n;|&)]*)/giu)) {
    const reason = analyzeGit(["git", ...tokenizeStaticText(match[1] ?? "")]);
    if (reason) return reason;
  }

  for (const match of text.matchAll(
    /\b(cp|dd|install|ln|mkfs(?:\.[a-z0-9_-]+)?|mke2fs|mkdosfs|mkntfs|mv|rmdir|shred|tee|truncate)\b([^\n;|&)]*)/giu,
  )) {
    const command = match[1];
    if (!command) continue;
    const reason = analyzeDestructiveFilesystemCommand(
      [command, ...tokenizeStaticText(match[2] ?? "")],
      options.cwd,
    );
    if (reason) return reason;
  }

  for (const { pattern, code, reason } of DANGEROUS_TEXT_PATTERNS) {
    if (pattern.test(text)) return bashSafetyViolation(code, reason);
  }
  return null;
}

function tokenizeStaticText(text: string): string[] {
  return Array.from(text.matchAll(/"(?:\\.|[^"])*"|'[^']*'|[^\s]+/gu), (match) =>
    markDynamicText(stripMatchingQuotes(match[0] ?? "")),
  );
}

function stripMatchingQuotes(token: string): string {
  if (
    token.length >= 2 &&
    ((token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'")))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

function markDynamicText(token: string): string {
  const dynamicIndex = token.search(/[$`]/u);
  return dynamicIndex === -1 ? token : `${token.slice(0, dynamicIndex)}${DYNAMIC_EXPANSION_MARKER}`;
}

function hasDynamicRmOperand(tokens: readonly string[]): boolean {
  return withoutDynamicRmOperands(tokens).length !== tokens.length;
}

function withoutDynamicRmOperands(tokens: readonly string[]): string[] {
  const result: string[] = [];
  let pastDoubleDash = false;
  for (const token of tokens) {
    if (token === "--") {
      pastDoubleDash = true;
      result.push(token);
      continue;
    }
    const markerIndex = token.indexOf(DYNAMIC_EXPANSION_MARKER);
    const staticPrefix = markerIndex === -1 ? token : token.slice(0, markerIndex);
    if (markerIndex !== -1 && (pastDoubleDash || !staticPrefix.startsWith("-"))) continue;
    result.push(token);
  }
  return result;
}
