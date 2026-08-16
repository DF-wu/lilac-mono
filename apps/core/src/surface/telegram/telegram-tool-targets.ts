import { Result } from "better-result";

import { parseRequestId } from "../bridge/request-ids";
import { SurfaceToolTargetInvalid, type SurfaceToolTargetRouting } from "../protocol";
import { isTelegramChatAllowed } from "./telegram-guards";
import { tryParseTelegramSessionId } from "./telegram-ids";

function invalid(message: string) {
  return Result.err(new SurfaceToolTargetInvalid({ message }));
}

export const telegramToolTargetRouting = {
  helpFallbackPriority: 2,
  inferRequestTarget: (requestId) => {
    if (!requestId) return null;
    const parsed = parseRequestId(requestId);
    return parsed?.kind === "telegram_message"
      ? { sessionId: parsed.sessionId, messageId: parsed.messageId }
      : null;
  },
  describeSessionIds: () => ({
    sessionIdFormats: {
      client: "telegram",
      accepted: [
        { format: "-1001234567890", meaning: "Telegram chat id" },
        {
          format: "-1001234567890:42",
          meaning: "Telegram forum chat id and topic message_thread_id",
        },
      ],
      notes: [
        "Telegram requests can infer sessionId/messageId from requestId when it is 'telegram:<sessionId>:<messageId>'.",
      ],
    },
  }),
  resolveSession: async ({ selector, getConfig }) => {
    const parsed = tryParseTelegramSessionId(selector);
    if (!parsed) return invalid(`Invalid Telegram session id '${selector}'`);
    const config = await getConfig();
    if (!isTelegramChatAllowed({ cfg: config, chatId: parsed.chatId })) {
      return invalid(`Not allowed: Telegram chatId '${parsed.chatId}'`);
    }
    return Result.ok({
      sessionRef: { platform: "telegram", channelId: selector },
      config,
    });
  },
} satisfies SurfaceToolTargetRouting<"telegram">;
