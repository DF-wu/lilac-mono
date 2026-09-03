export type BashSafetyCode =
  | "dangerous_git_operation"
  | "delete_current_cwd"
  | "delete_outside_cwd"
  | "delete_root_or_home"
  | "device_format"
  | "device_write"
  | "dynamic_recursive_delete"
  | "find_delete"
  | "interpreter_one_liner"
  | "paranoid_recursive_delete"
  | "protected_git_metadata"
  | "protected_path"
  | "shred";

export interface BashSafetyViolation {
  code: BashSafetyCode;
  reason: string;
  hint?: string;
}

export interface AnalyzeResult extends BashSafetyViolation {
  segment: string;
}

export function bashSafetyViolation(
  code: BashSafetyCode,
  reason: string,
  hint?: string,
): BashSafetyViolation {
  return hint ? { code, reason, hint } : { code, reason };
}

export interface AnalyzeOptions {
  cwd?: string;
  /** Absolute paths whose direct static access should be blocked. */
  protectedPaths?: readonly string[];
  /** Block non-temp rm -rf even within cwd */
  paranoidRm?: boolean;
  /** Block interpreter one-liners (python -c, node -e, etc.) */
  paranoidInterpreters?: boolean;
  /** Allow $TMPDIR paths (false when TMPDIR is overridden to non-temp) */
  allowTmpdirVar?: boolean;
}

export const MAX_RECURSION_DEPTH = 5;
export const MAX_STRIP_ITERATIONS = 20;

export const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh", "ksh", "dash", "fish", "csh", "tcsh"]);

export const INTERPRETERS = new Set(["python", "python3", "python2", "node", "ruby", "perl"]);

export const PARANOID_INTERPRETERS_SUFFIX =
  "\n\n(Paranoid mode: interpreter one-liners are blocked.)";
