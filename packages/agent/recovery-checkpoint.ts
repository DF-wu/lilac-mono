import type { ModelMessage } from "ai";

type ToolCallRef = {
  toolCallId: string;
  toolName: string;
};

function getUnresolvedAssistantToolCalls(message: ModelMessage): ToolCallRef[] {
  if (message.role !== "assistant") return [];
  if (!Array.isArray(message.content)) return [];

  const calls = new Map<string, string>();
  for (const part of message.content) {
    if (part.type === "tool-call") calls.set(part.toolCallId, part.toolName);
    if (part.type === "tool-result") calls.delete(part.toolCallId);
  }

  return [...calls].map(([toolCallId, toolName]) => ({ toolCallId, toolName }));
}

function getToolResultToolCallIds(message: ModelMessage): string[] {
  if (message.role !== "tool") return [];

  const ids: string[] = [];
  for (const part of message.content) {
    if (part.type === "tool-result") ids.push(part.toolCallId);
  }

  return ids;
}

export function buildSafeRecoveryCheckpoint(
  messages: readonly ModelMessage[],
  interruptedToolErrorText = "server restarted",
): ModelMessage[] {
  let committedIndex = -1;
  let openToolCalls: Map<string, string> | null = null;
  let openSegmentLastIndex = -1;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;

    if (openToolCalls) {
      if (message.role !== "tool") {
        break;
      }

      openSegmentLastIndex = i;

      for (const toolCallId of getToolResultToolCallIds(message)) {
        openToolCalls.delete(toolCallId);
      }

      if (openToolCalls.size === 0) {
        openToolCalls = null;
        committedIndex = openSegmentLastIndex;
      }
      continue;
    }

    if (message.role === "tool") {
      break;
    }

    const toolCalls = getUnresolvedAssistantToolCalls(message);
    if (toolCalls.length > 0) {
      openToolCalls = new Map(toolCalls.map((call) => [call.toolCallId, call.toolName]));
      openSegmentLastIndex = i;
      continue;
    }

    committedIndex = i;
  }

  if (!openToolCalls || openToolCalls.size === 0) {
    return messages.slice(0, Math.max(0, committedIndex + 1));
  }

  const base = messages.slice(0, Math.max(0, openSegmentLastIndex + 1));
  const syntheticToolMessages: ModelMessage[] = [];

  for (const [toolCallId, toolName] of openToolCalls.entries()) {
    syntheticToolMessages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName,
          output: {
            type: "error-text",
            value: interruptedToolErrorText,
          },
        },
      ],
    });
  }

  return [...base, ...syntheticToolMessages];
}
