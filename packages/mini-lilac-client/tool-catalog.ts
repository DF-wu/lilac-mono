/** Tools that can be selected in Mini Lilac runtime profile configuration. */
export const MINI_LILAC_EXECUTABLE_TOOL_NAMES = [
  "bash",
  "read",
  "glob",
  "grep",
  "fuzzy_search",
  "edit",
  "patch",
  "subagent_delegate",
  "batch",
  "skill",
  "todowrite",
  "webfetch",
  "websearch",
] as const;

/** Synthetic tool records emitted only to represent transcript lifecycle events. */
export const MINI_LILAC_SYNTHETIC_TOOL_NAMES = ["subagent_result"] as const;

/** Complete protocol catalog consumed by transcript projection. */
export const MINI_LILAC_TOOL_NAMES = [
  "bash",
  "read",
  "glob",
  "grep",
  "fuzzy_search",
  "edit",
  "patch",
  "subagent_delegate",
  "subagent_result",
  "batch",
  "skill",
  "todowrite",
  "webfetch",
  "websearch",
] as const;

export type MiniLilacExecutableToolName = (typeof MINI_LILAC_EXECUTABLE_TOOL_NAMES)[number];
export type MiniLilacSyntheticToolName = (typeof MINI_LILAC_SYNTHETIC_TOOL_NAMES)[number];
export type MiniLilacToolName = (typeof MINI_LILAC_TOOL_NAMES)[number];

/** Compatibility mapping for configurations and transcripts written before the rename. */
export function normalizeMiniLilacToolName(name: string): string {
  switch (name) {
    case "read_file":
      return "read";
    case "edit_file":
      return "edit";
    case "apply_patch":
      return "patch";
    default:
      return name;
  }
}
