const TOOL_EXPANSION_BRAND = Symbol("lilac.tool-expansion");

import type { OpaqueAgentValue } from "./failure-adapters";

export type ExpandedToolCall = {
  toolCallId: string;
  toolName: string;
  input: OpaqueAgentValue;
  invalid?: boolean;
  error?: OpaqueAgentValue;
};

export class ToolExpansion {
  readonly [TOOL_EXPANSION_BRAND] = true;

  constructor(
    readonly result: OpaqueAgentValue,
    readonly children: readonly ExpandedToolCall[],
  ) {}
}

export function isToolExpansion(value: unknown): value is ToolExpansion {
  return value instanceof ToolExpansion && value[TOOL_EXPANSION_BRAND] === true;
}
