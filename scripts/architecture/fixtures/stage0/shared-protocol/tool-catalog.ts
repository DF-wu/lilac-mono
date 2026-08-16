export const EXECUTABLE_TOOL_NAMES = [
  "bash",
  "read_file",
  "glob",
  "grep",
  "fuzzy_search",
  "edit_file",
  "apply_patch",
  "subagent_delegate",
  "batch",
  "skill",
  "todowrite",
  "webfetch",
  "websearch",
] as const;

export const TRANSCRIPT_TOOL_NAMES = ["subagent_result"] as const;

export const SHARED_TOOL_NAMES = [...EXECUTABLE_TOOL_NAMES, ...TRANSCRIPT_TOOL_NAMES] as const;

export const DRIFTED_SHARED_TOOL_NAMES = [
  ...EXECUTABLE_TOOL_NAMES,
  ...TRANSCRIPT_TOOL_NAMES,
  "future_tool",
] as const;
