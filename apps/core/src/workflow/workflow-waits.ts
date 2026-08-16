import { z } from "zod";
import type { EvtAdapterMessageCreatedData } from "@stanley2058/lilac-event-bus";

import type { WorkflowWait } from "./workflow-domain";

const replyMetadataSchema = z
  .object({
    replyToMessageId: z.string().min(1).optional(),
    discord: z
      .object({ replyToMessageId: z.string().min(1).optional() })
      .passthrough()
      .optional(),
    github: z
      .object({ replyToMessageId: z.string().min(1).optional() })
      .passthrough()
      .optional(),
    telegram: z
      .object({ replyToMessageId: z.string().min(1).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function workflowReplyMatchKey(platform: string, channelId: string): string {
  return `${platform}:${channelId}`;
}

function replyToMessageId(event: EvtAdapterMessageCreatedData): string | null {
  const parsed = replyMetadataSchema.safeParse(event.raw);
  if (!parsed.success) return null;
  return (
    parsed.data.replyToMessageId ??
    parsed.data.discord?.replyToMessageId ??
    parsed.data.github?.replyToMessageId ??
    parsed.data.telegram?.replyToMessageId ??
    null
  );
}

export function matchWorkflowReplyWait(
  wait: WorkflowWait,
  eventInput: EvtAdapterMessageCreatedData,
): WorkflowWait["result"] | null {
  if (wait.match.kind !== "reply") return null;
  const event = eventInput;
  if (event.ts < wait.createdAt) return null;
  if (wait.deadlineAt !== null && event.ts >= wait.deadlineAt) return null;
  if (event.platform !== wait.match.platform || event.channelId !== wait.match.channelId)
    return null;
  if (wait.match.fromUserId && event.userId !== wait.match.fromUserId) return null;
  if (wait.match.messageId && replyToMessageId(event) !== wait.match.messageId) return null;
  return {
    platform: event.platform,
    channelId: event.channelId,
    messageId: event.messageId,
    userId: event.userId,
    ...(event.userName ? { userName: event.userName } : {}),
    text: event.text,
    ts: event.ts,
  };
}
