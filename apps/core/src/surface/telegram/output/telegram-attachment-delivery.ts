import { InputFile } from "grammy";
import type { Bot } from "grammy";

import type { MsgRef, SurfaceAttachment } from "../../types";
import type { SurfaceFinalTextMode, SurfaceOutputResult, SurfaceOutputStream } from "../../adapter";
import { parseTelegramSessionId, telegramMsgRef } from "../telegram-ids";
import type { TelegramSessionRef } from "../../types";
/**
 * The capabilities the wrapper needs after `finish()`. Depending on this rather
 * than the concrete stream class keeps the two loosely coupled and lets tests
 * substitute a double without casting.
 */
export type TelegramDeliverableStream = SurfaceOutputStream & {
  // Required here, unlike on SurfaceOutputStream where it is optional.
  getFinalTextMode(): SurfaceFinalTextMode;
  getDeliveredMessages(): { messageId: number; text: string }[];
  takePendingAttachments(): SurfaceAttachment[];
};

/**
 * Telegram rejects `sendPhoto` for image types it cannot render inline
 * (notably SVG), so those fall back to a document upload rather than failing.
 */
const PHOTO_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function shouldSendAsPhoto(attachment: SurfaceAttachment): boolean {
  return attachment.kind === "image" && PHOTO_MIME_TYPES.has(attachment.mimeType.toLowerCase());
}

export type TelegramAttachmentApi = {
  sendPhoto(
    chatId: number,
    file: InputFile,
    opts: { message_thread_id?: number; disable_notification?: boolean },
  ): Promise<{ message_id: number }>;
  sendDocument(
    chatId: number,
    file: InputFile,
    opts: { message_thread_id?: number; disable_notification?: boolean },
  ): Promise<{ message_id: number }>;
};

export function createGrammyAttachmentApi(bot: Bot): TelegramAttachmentApi {
  return {
    sendPhoto: async (chatId, file, opts) => {
      const sent = await bot.api.sendPhoto(chatId, file, opts);
      return { message_id: sent.message_id };
    },
    sendDocument: async (chatId, file, opts) => {
      const sent = await bot.api.sendDocument(chatId, file, opts);
      return { message_id: sent.message_id };
    },
  };
}

export async function deliverTelegramAttachments(input: {
  api: TelegramAttachmentApi;
  sessionRef: TelegramSessionRef;
  attachments: readonly SurfaceAttachment[];
  silent: boolean;
}): Promise<MsgRef[]> {
  if (input.attachments.length === 0) return [];

  const { chatId, threadId } = parseTelegramSessionId(input.sessionRef.channelId);
  const opts = {
    ...(threadId === undefined ? {} : { message_thread_id: threadId }),
    ...(input.silent ? { disable_notification: true } : {}),
  };

  const created: MsgRef[] = [];
  for (const attachment of input.attachments) {
    const file = new InputFile(attachment.bytes, attachment.filename);
    const sent = shouldSendAsPhoto(attachment)
      ? await input.api.sendPhoto(chatId, file, opts)
      : await input.api.sendDocument(chatId, file, opts);

    created.push(telegramMsgRef({ chatId, threadId, messageId: sent.message_id }));
  }

  return created;
}

/**
 * Wraps the output stream so buffered attachments are uploaded once the text
 * reply is finalised.
 *
 * The stream itself stays free of multipart upload concerns, and attachments
 * land after the answer they belong to rather than interrupting the stream.
 */
export class TelegramOutputStreamWithAttachments implements SurfaceOutputStream {
  constructor(
    private readonly stream: TelegramDeliverableStream,
    private readonly deps: {
      api: TelegramAttachmentApi;
      sessionRef: TelegramSessionRef;
      silent: boolean;
      onError: (error: unknown) => void;
      /**
       * Records what was delivered. Telegram does not echo the bot's own
       * messages back as updates, so this is the only chance to index them.
       */
      onDelivered: (messages: readonly { messageId: number; text: string }[]) => void;
    },
  ) {}

  push(part: Parameters<SurfaceOutputStream["push"]>[0]): Promise<void> {
    return this.stream.push(part);
  }

  async finish(): Promise<SurfaceOutputResult> {
    const result = await this.stream.finish();

    try {
      this.deps.onDelivered(this.stream.getDeliveredMessages());
    } catch (error: unknown) {
      // Indexing is best-effort; it must not fail a delivered reply.
      this.deps.onError(error);
    }

    const attachments = this.stream.takePendingAttachments();
    if (attachments.length === 0) return result;

    try {
      const created = await deliverTelegramAttachments({
        api: this.deps.api,
        sessionRef: this.deps.sessionRef,
        attachments,
        silent: this.deps.silent,
      });
      if (created.length === 0) return result;

      const last = created[created.length - 1];
      return {
        created: [...result.created, ...created],
        last: last ?? result.last,
      };
    } catch (error: unknown) {
      // A failed upload must not discard an answer that was already delivered.
      this.deps.onError(error);
      return result;
    }
  }

  abort(reason?: string): Promise<void> {
    return this.stream.abort(reason);
  }

  getFinalTextMode(): SurfaceFinalTextMode {
    return this.stream.getFinalTextMode();
  }
}
