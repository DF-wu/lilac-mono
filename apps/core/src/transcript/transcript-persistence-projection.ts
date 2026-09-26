import type { ModelMessage, UserContent } from "ai";
import { z } from "zod";

import { escapeMetadataValue } from "../surface/bridge/request-composition/attachments";

const telegramInboundFileTransientSchema = z
  .object({
    version: z.literal(1),
    source: z.literal("telegram-inbound-file"),
  })
  .strict();

const lilacPartProviderOptionsSchema = z
  .object({
    transient: telegramInboundFileTransientSchema,
  })
  .passthrough();

export const TELEGRAM_INBOUND_FILE_TRANSIENT_PROVIDER_OPTIONS = {
  lilac: {
    transient: {
      version: 1,
      source: "telegram-inbound-file",
    },
  },
} as const;

type UserPart = Exclude<UserContent, string>[number];
type UserFilePart = Extract<UserPart, { readonly type: "file" }>;

function isTransientTelegramInboundFile(part: UserFilePart): boolean {
  return lilacPartProviderOptionsSchema.safeParse(part.providerOptions?.["lilac"]).success;
}

function persistedTelegramFilePlaceholder(part: UserFilePart): UserPart {
  const fields: string[] = [];
  if (part.filename) fields.push(`filename="${escapeMetadataValue(part.filename)}"`);
  fields.push(`mime="${escapeMetadataValue(part.mediaType)}"`);
  return {
    type: "text",
    text: `[telegram_attachment ${fields.join(" ")}]\n(file content omitted from persisted transcript)`,
  };
}

function projectMessageForPersistence(message: ModelMessage): ModelMessage {
  if (message.role !== "user" || typeof message.content === "string") return message;

  let changed = false;
  const content = message.content.map((part) => {
    if (part.type !== "file" || !isTransientTelegramInboundFile(part)) return part;
    changed = true;
    return persistedTelegramFilePlaceholder(part);
  });

  return changed ? { ...message, content } : message;
}

export function projectTranscriptForPersistence(
  messages: readonly ModelMessage[],
): readonly ModelMessage[] {
  let changed = false;
  const projected = messages.map((message) => {
    const projectedMessage = projectMessageForPersistence(message);
    if (projectedMessage !== message) changed = true;
    return projectedMessage;
  });
  return changed ? projected : messages;
}
