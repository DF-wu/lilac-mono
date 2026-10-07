import type { OpaqueAgentValue } from "./failure-adapters";

export type AgentToolCall = {
  toolCallId: string;
  toolName: string;
  input: OpaqueAgentValue;
  invalid?: boolean;
  error?: OpaqueAgentValue;
};
