export type ParsedRequestId =
  | {
      kind: "generic";
      id: string;
    }
  | {
      kind: "queued";
      requestId: string;
    }
  | {
      kind: "discord_message";
      channelId: string;
      messageId: string;
    }
  | {
      kind: "discord_slash";
      channelId: string;
      interactionId: string;
    }
  | {
      kind: "telegram_message";
      sessionId: string;
      messageId: string;
    }
  | {
      kind: "workflow";
      workflowId: string;
      sequence: number;
    };

export function formatGenericRequestId(id: string = crypto.randomUUID()): string {
  return `req:${id}`;
}

export function formatQueuedRequestId(requestId: string): string {
  return `queued:${requestId}`;
}

export function formatDiscordMessageRequestId(input: {
  channelId: string;
  messageId: string;
}): string {
  return `discord:${input.channelId}:${input.messageId}`;
}

export function formatDiscordSlashRequestId(input: {
  channelId: string;
  interactionId: string;
}): string {
  return `discord:${input.channelId}:slash:${input.interactionId}`;
}

/**
 * Telegram request id.
 *
 * `sessionId` may itself contain a colon for forum topics
 * ("<chat_id>:<message_thread_id>"), so the message id is always the final
 * segment and parsing splits on the last colon.
 */
export function formatTelegramMessageRequestId(input: {
  sessionId: string;
  messageId: string;
}): string {
  return `telegram:${input.sessionId}:${input.messageId}`;
}

export function formatWorkflowRequestId(input: { workflowId: string; sequence: number }): string {
  return `wf:${input.workflowId}:${input.sequence}`;
}

export function isDiscordRequestId(requestId: string): boolean {
  const parsed = parseRequestId(requestId);
  return parsed?.kind === "discord_message" || parsed?.kind === "discord_slash";
}

export function isTelegramRequestId(requestId: string): boolean {
  return parseRequestId(requestId)?.kind === "telegram_message";
}

export function parseRequestId(requestId: string): ParsedRequestId | null {
  if (requestId.startsWith("req:")) {
    const id = requestId.slice("req:".length);
    return id ? { kind: "generic", id } : null;
  }

  if (requestId.startsWith("queued:")) {
    const inner = requestId.slice("queued:".length);
    return inner ? { kind: "queued", requestId: inner } : null;
  }

  if (requestId.startsWith("discord:")) {
    const parts = requestId.split(":");
    if (parts.length === 3 && parts[1] && parts[2]) {
      return { kind: "discord_message", channelId: parts[1], messageId: parts[2] };
    }
    if (parts.length === 4 && parts[1] && parts[2] === "slash" && parts[3]) {
      return { kind: "discord_slash", channelId: parts[1], interactionId: parts[3] };
    }
    return null;
  }

  if (requestId.startsWith("telegram:")) {
    const rest = requestId.slice("telegram:".length);
    const idx = rest.lastIndexOf(":");
    if (idx <= 0) return null;

    const sessionId = rest.slice(0, idx);
    const messageId = rest.slice(idx + 1);
    if (!sessionId || !messageId) return null;

    return { kind: "telegram_message", sessionId, messageId };
  }

  if (requestId.startsWith("wf:")) {
    const rest = requestId.slice("wf:".length);
    const idx = rest.lastIndexOf(":");
    if (idx <= 0) return null;

    const workflowId = rest.slice(0, idx);
    const rawSequence = rest.slice(idx + 1);
    const sequence = Number.parseInt(rawSequence, 10);
    if (!workflowId || !Number.isInteger(sequence) || String(sequence) !== rawSequence) {
      return null;
    }

    return { kind: "workflow", workflowId, sequence };
  }

  return null;
}
