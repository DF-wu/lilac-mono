import { Result } from "better-result";
import { InputFile } from "grammy";
import type { Bot } from "grammy";

import type { MsgRef, SurfaceAttachment } from "../../types";
import { captureError } from "../../../shared/error-capture";
import {
  SurfaceOperationPartiallyCompleted,
  type SurfaceFinalTextMode,
  type SurfaceOperationResult,
  type SurfaceOutputPart,
  type SurfaceOutputPartDisposition,
  type SurfaceOutputResult,
  type SurfaceOutputStream,
} from "../../adapter";
import { parseTelegramSessionId, telegramMsgRef } from "../telegram-ids";
import type { TelegramSessionRef } from "../../types";
import { projectTelegramError, type TelegramErrorProjection } from "../telegram-error-projection";
import type { TelegramSurplusDeletionFailure } from "./telegram-output-stream";

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
  getSurplusDeletionFailures(): TelegramSurplusDeletionFailure[];
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

/**
 * One attachment that reached Telegram.
 *
 * The attachment travels alongside the ref because the caller has to index the
 * resulting message afterwards, and an attachment-only message carries no text
 * of its own to index by.
 */
export type TelegramAttachmentUpload = {
  ref: MsgRef;
  messageId: number;
  attachment: SurfaceAttachment;
};

export type TelegramAttachmentDeliveryResult = {
  /** Uploads that reached Telegram, in submission order. */
  uploaded: TelegramAttachmentUpload[];
  /**
   * The upload that stopped the run. Attachments queued behind it were not
   * attempted. `attachment` is absent when the failure could not be attributed
   * to a particular upload.
   */
  failure?: { error: TelegramErrorProjection; attachment?: SurfaceAttachment };
};

export type TelegramAttachmentFailureContext = {
  readonly filename?: string;
  readonly uploaded?: number;
  readonly total?: number;
};

/**
 * The body recorded for an attachment-only message in the local index.
 *
 * A Telegram message carrying just a photo or document has no text, but the
 * index is what reply-chain traversal reads: with no row for it, a reply to
 * the attachment resolves to nothing and the chain truncates there. A short
 * label is recorded rather than an empty string so an agent reading its own
 * history can tell what it sent, instead of seeing a message it apparently
 * left blank.
 */
export function telegramAttachmentIndexText(attachment: SurfaceAttachment): string {
  return `[${attachment.kind}] ${attachment.filename}`;
}

/**
 * Uploads buffered attachments, one message each.
 *
 * Reports failure in the result rather than throwing, and stops at the first
 * one. Both choices follow from the same fact: uploads that already returned
 * are visible in the chat and cannot be taken back. Throwing would strand them
 * — the caller would hold no refs for messages the user can see, so replies to
 * them would not resolve. Pressing on past a failure would instead leave a gap
 * in the sequence (1 and 3 delivered, 2 missing), which is harder to read than
 * a truncated prefix; and an upload failure is usually a rate limit or an auth
 * problem, which the next upload would only run into again.
 */
export async function deliverTelegramAttachments(input: {
  api: TelegramAttachmentApi;
  sessionRef: TelegramSessionRef;
  attachments: readonly SurfaceAttachment[];
  silent: boolean;
}): Promise<TelegramAttachmentDeliveryResult> {
  if (input.attachments.length === 0) return { uploaded: [] };

  const { chatId, threadId } = parseTelegramSessionId(input.sessionRef.channelId);
  const opts = {
    ...(threadId === undefined ? {} : { message_thread_id: threadId }),
    ...(input.silent ? { disable_notification: true } : {}),
  };

  const uploaded: TelegramAttachmentUpload[] = [];
  for (const attachment of input.attachments) {
    const file = new InputFile(attachment.bytes, attachment.filename);
    const attempted = await Result.tryPromise({
      try: () =>
        shouldSendAsPhoto(attachment)
          ? input.api.sendPhoto(chatId, file, opts)
          : input.api.sendDocument(chatId, file, opts),
      catch: (cause) => captureError(cause, "Telegram attachment delivery failed"),
    });
    if (attempted.isErr()) {
      return {
        uploaded,
        failure: {
          error: projectTelegramError(attempted.error.cause, "Telegram attachment delivery failed"),
          attachment,
        },
      };
    }
    const messageId = attempted.value.message_id;
    uploaded.push({
      ref: telegramMsgRef({ chatId, threadId, messageId }),
      messageId,
      attachment,
    });
  }

  return { uploaded };
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
      onError: (error: Error, context?: TelegramAttachmentFailureContext) => void;
      /**
       * Records what was delivered. Telegram does not echo the bot's own
       * messages back as updates, so this is the only chance to index them.
       *
       * Called twice when there are attachments: once for the text reply
       * before the uploads start, and once for the uploads that succeeded.
       * Splitting it that way keeps a failed upload from discarding the record
       * of a text reply that was already delivered.
       */
      onDelivered: (messages: readonly { messageId: number; text: string }[]) => void;
      /**
       * Reports surplus messages still visible in the chat that could not be
       * removed. A failure on the final flush has no later flush to retry it,
       * so without this the request finishes looking clean while stale output
       * remains.
       */
      onUnreconciled: (failures: readonly TelegramSurplusDeletionFailure[]) => void;
    },
  ) {}

  push(part: SurfaceOutputPart): Promise<SurfaceOperationResult<SurfaceOutputPartDisposition>> {
    return this.stream.push(part);
  }

  async finish(): Promise<SurfaceOperationResult<SurfaceOutputResult>> {
    const finished = await this.stream.finish();
    const continueFinish = finished.match<
      () => Promise<SurfaceOperationResult<SurfaceOutputResult>>
    >({
      err: (error) => async () => Result.err(error),
      ok: (result) => async () => {
        this.report(() => {
          this.deps.onDelivered(this.stream.getDeliveredMessages());

          const unreconciled = this.stream.getSurplusDeletionFailures();
          if (unreconciled.length > 0) this.deps.onUnreconciled(unreconciled);
        });

        const attachments = this.stream.takePendingAttachments();
        if (attachments.length === 0) return Result.ok(result);

        const deliveryAttempt = await Result.tryPromise({
          try: () =>
            deliverTelegramAttachments({
              api: this.deps.api,
              sessionRef: this.deps.sessionRef,
              attachments,
              silent: this.deps.silent,
            }),
          catch: (cause) => captureError(cause, "Telegram attachment delivery failed"),
        });
        let delivery: TelegramAttachmentDeliveryResult;
        if (deliveryAttempt.isErr()) {
          delivery = {
            uploaded: [],
            failure: {
              error: projectTelegramError(
                deliveryAttempt.error.cause,
                "Telegram attachment delivery failed",
              ),
            },
          };
        } else {
          delivery = deliveryAttempt.value;
        }

        // Index before reporting the failure: every upload here is visible in the
        // chat, so a reply to one has to resolve even when a later upload failed.
        if (delivery.uploaded.length > 0) {
          this.report(() =>
            this.deps.onDelivered(
              delivery.uploaded.map((upload) => ({
                messageId: upload.messageId,
                text: telegramAttachmentIndexText(upload.attachment),
              })),
            ),
          );
        }

        if (delivery.failure) {
          this.deps.onError(delivery.failure.error.error, {
            filename: delivery.failure.attachment?.filename,
            uploaded: delivery.uploaded.length,
            total: attachments.length,
          });
          const created = delivery.uploaded.at(-1)?.ref ?? result.last;
          return Result.err(
            new SurfaceOperationPartiallyCompleted({
              platform: "telegram",
              operation: "finish-output",
              created,
              message: `Telegram attachment delivery partially completed: ${delivery.failure.error.message}`,
            }),
          );
        }

        if (delivery.uploaded.length === 0) return Result.ok(result);

        const created = delivery.uploaded.map((upload) => upload.ref);
        const last = created[created.length - 1];
        return Result.ok({
          created: [...result.created, ...created],
          last: last ?? result.last,
        });
      },
    });
    return await continueFinish();
  }

  /** Reporting is best-effort; it must never fail a reply that was delivered. */
  private report(fn: () => void): void {
    const reported = Result.try({
      try: fn,
      catch: (cause) => captureError(cause, "Telegram output reporting failed"),
    });
    if (reported.isErr()) {
      this.deps.onError(
        projectTelegramError(reported.error.cause, "Telegram output reporting failed").error,
      );
    }
  }

  abort(reason?: string): Promise<SurfaceOperationResult<void>> {
    return this.stream.abort(reason);
  }

  getFinalTextMode(): SurfaceFinalTextMode {
    return this.stream.getFinalTextMode();
  }
}
