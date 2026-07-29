/**
 * Throttled streaming output for Telegram.
 *
 * Telegram is edit-based rather than append-based: a reply is one message that
 * gets rewritten as tokens arrive. That imposes three constraints this class is
 * built around:
 *
 * - edits are rate limited (roughly one per second per chat), so deltas are
 *   buffered and flushed on an interval;
 * - an edit whose payload is byte-identical to the previous one fails with
 *   "message is not modified", so every edit is deduplicated;
 * - a message caps out at 4096 characters, so overflow finalises the current
 *   message and continues in a new one.
 *
 * All I/O and time are injected: the class performs no network calls and no
 * real waiting of its own, which keeps it unit-testable.
 */

import { formatWorkingStatus } from "@stanley2058/lilac-utils";
import { z } from "zod";

import type {
  StartOutputOpts,
  SurfaceFinalTextMode,
  SurfaceOutputPart,
  SurfaceOutputResult,
  SurfaceOutputStream,
  SurfaceToolStatusUpdate,
} from "../../adapter";
import type { MsgRef, SurfaceAttachment, TelegramSessionRef } from "../../types";
import { isSubagentToolDisplay, mergeSubagentToolStatus } from "../../subagent-tool-status";
import {
  type MarkdownTableRenderOptions,
  renderMarkdownTablesAsCodeBlocks,
} from "../../../shared/markdown-table-renderer";
import { chatIdOf, parseTelegramMessageId, telegramMsgRef, threadIdOf } from "../telegram-ids";

import { TELEGRAM_MAX_MESSAGE_CHARS, chunkTelegramHtml } from "./telegram-chunker";
import { escapeTelegramHtml, markdownToTelegramHtml, stripTelegramHtml } from "./telegram-html";

export type TelegramInlineKeyboardButton = {
  readonly text: string;
  readonly callback_data: string;
};

export type TelegramReplyMarkup = {
  readonly inline_keyboard: readonly (readonly TelegramInlineKeyboardButton[])[];
};

export type TelegramParseMode = "HTML";

export type TelegramSendMessageParams = {
  readonly chat_id: number;
  readonly message_thread_id?: number;
  readonly text: string;
  readonly parse_mode?: TelegramParseMode;
  readonly reply_to_message_id?: number;
  readonly disable_notification?: boolean;
  readonly reply_markup?: TelegramReplyMarkup;
  readonly link_preview_options?: { readonly is_disabled: true };
};

export type TelegramEditMessageTextParams = {
  readonly chat_id: number;
  readonly message_id: number;
  readonly text: string;
  readonly parse_mode?: TelegramParseMode;
  readonly reply_markup?: TelegramReplyMarkup;
  readonly link_preview_options?: { readonly is_disabled: true };
};

export type TelegramDeleteMessageParams = {
  readonly chat_id: number;
  readonly message_id: number;
};

export type TelegramSendChatActionParams = {
  readonly chat_id: number;
  readonly message_thread_id?: number;
  readonly action: "typing";
};

export type TelegramSentMessage = {
  readonly message_id: number;
};

/**
 * The slice of the Bot API this stream needs. Deliberately narrow and
 * framework-agnostic so the adapter can back it with grammY while tests back it
 * with a recorder.
 */
export interface TelegramOutputApi {
  sendMessage(params: TelegramSendMessageParams): Promise<TelegramSentMessage>;
  editMessageText(params: TelegramEditMessageTextParams): Promise<void>;
  deleteMessage(params: TelegramDeleteMessageParams): Promise<void>;
  sendChatAction(params: TelegramSendChatActionParams): Promise<void>;
}

export type TelegramOutputStreamDeps = {
  api: TelegramOutputApi;
  sessionRef: TelegramSessionRef;
  opts?: StartOutputOpts;
  now: () => number;
  /** Schedules `cb` after `delayMs`; the returned function cancels it. */
  scheduleEdit: (cb: () => void, delayMs: number) => () => void;
  streamEditIntervalMs: number;
  parseMode: "html" | "plain";
  outputMode: "inline" | "preview";
  outputNotification: boolean;
  workingIndicators: readonly string[];
  markdownTableRender?: MarkdownTableRenderOptions;
};

const CANCEL_CALLBACK_PREFIX = "lc:";
const CANCEL_CALLBACK_MAX_BYTES = 64;
const CANCEL_BUTTON_LABEL = "Cancel";

/**
 * Telegram caps `callback_data` at 64 bytes; longer request ids simply lose the
 * button rather than making the whole send fail.
 */
export function buildTelegramCancelCallbackData(requestId: string): string | null {
  if (requestId.length === 0) return null;
  const data = `${CANCEL_CALLBACK_PREFIX}${requestId}`;
  return new TextEncoder().encode(data).length <= CANCEL_CALLBACK_MAX_BYTES ? data : null;
}

export function parseTelegramCancelCallbackData(data: string): string | null {
  if (!data.startsWith(CANCEL_CALLBACK_PREFIX)) return null;
  const requestId = data.slice(CANCEL_CALLBACK_PREFIX.length);
  return requestId.length > 0 ? requestId : null;
}

const telegramApiErrorSchema = z.object({
  error_code: z.number().optional(),
  description: z.string().optional(),
  parameters: z
    .object({
      retry_after: z.number().optional(),
    })
    .optional(),
});

type TelegramApiErrorShape = z.infer<typeof telegramApiErrorSchema>;

function toTelegramApiError(error: unknown): TelegramApiErrorShape | null {
  if (typeof error !== "object" || error === null) return null;
  const parsed = telegramApiErrorSchema.safeParse(error);
  return parsed.success ? parsed.data : null;
}

function errorText(error: unknown): string {
  const shape = toTelegramApiError(error);
  const description = shape?.description ?? "";
  const message = error instanceof Error ? error.message : "";
  return `${description} ${message}`.toLowerCase();
}

/** Reads `retry_after` (seconds) from a 429 response, if present. */
export function telegramRetryAfterSeconds(error: unknown): number | null {
  const shape = toTelegramApiError(error);
  if (!shape) return null;

  const retryAfter = shape.parameters?.retry_after;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return retryAfter;
  }
  if (shape.error_code === 429) return 0;
  return errorText(error).includes("too many requests") ? 0 : null;
}

/** True when Telegram rejected the message because it could not parse entities. */
export function isTelegramEntityError(error: unknown): boolean {
  const text = errorText(error);
  return (
    text.includes("can't parse entities") ||
    text.includes("cant parse entities") ||
    text.includes("unsupported start tag") ||
    text.includes("unclosed start tag") ||
    text.includes("can't find end tag") ||
    text.includes("entity")
  );
}

/** True for the benign "nothing changed" edit rejection. */
export function isTelegramNotModifiedError(error: unknown): boolean {
  return errorText(error).includes("message is not modified");
}

const PROGRESS_MAX_LINES = 5;
const PROGRESS_LINE_MAX_CHARS = 90;
const STATS_MAX_CHARS = 200;
/**
 * Chunk budget is reduced by a fixed reserve so the progress header and stats
 * line always fit on the live message. The reserve is constant for the whole
 * stream: varying it would re-flow already-sent messages.
 */
const RESERVED_OVERHEAD_CHARS = 512;
const WORKING_INDICATOR_ROTATE_MS = 12_000;
const EMPTY_OUTPUT_PLACEHOLDER = "<i>(no output)</i>";
const CANCELLED_PLACEHOLDER = "Cancelled.";

type ProgressEntry = {
  readonly toolCallId: string;
  readonly update: SurfaceToolStatusUpdate;
  readonly updatedSeq: number;
};

function clampWithEllipsis(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars === 1) return "…";
  return `${text.slice(0, maxChars - 1)}…`;
}

function statusIcon(update: SurfaceToolStatusUpdate): string {
  if (update.status === "start") return "▶";
  if (update.status === "update") return "…";
  return update.ok ? "✓" : "✗";
}

function normalizeToolDisplay(display: string): string {
  return display.replace(/\s+/gu, " ").trim();
}

export function buildTelegramProgressLines(entries: readonly ProgressEntry[]): string[] {
  return [...entries]
    .sort((a, b) => a.updatedSeq - b.updatedSeq)
    .slice(-PROGRESS_MAX_LINES)
    .map((entry) =>
      clampWithEllipsis(
        `${statusIcon(entry.update)} ${normalizeToolDisplay(entry.update.display)}`,
        PROGRESS_LINE_MAX_CHARS,
      ),
    );
}

export function pickWorkingIndicator(input: {
  indicators: readonly string[];
  elapsedMs: number;
}): string {
  const usable = input.indicators.map((word) => word.trim()).filter((word) => word.length > 0);
  if (usable.length === 0) return "Working";
  const index = Math.floor(Math.max(0, input.elapsedMs) / WORKING_INDICATOR_ROTATE_MS);
  return usable[index % usable.length] ?? "Working";
}

type OutputMessage = {
  messageId: number;
  /** Last payload successfully handed to the API, for edit deduplication. */
  sentText: string;
  sentMarkup: string;
};

function markupKey(markup: TelegramReplyMarkup | undefined): string {
  return markup ? JSON.stringify(markup) : "";
}

export class TelegramOutputStream implements SurfaceOutputStream {
  private readonly chatId: number;
  private readonly threadId: number | undefined;
  private readonly requestStartedAtMs: number;
  private readonly bodyMaxChars: number;
  private readonly cancelCallbackData: string | null;

  private readonly messages: OutputMessage[] = [];
  private readonly created: MsgRef[] = [];
  private readonly toolEntries: ProgressEntry[] = [];
  private readonly pendingAttachments: SurfaceAttachment[] = [];

  private textAcc = "";
  private statsLine: string | null = null;
  private progressSeq = 0;
  private reasoningStartedAtMs: number | null = null;
  private reasoningFrozenAtMs: number | null = null;

  private renderCacheInput: string | null = null;
  private renderCacheOutput = "";

  private lastFlushAtMs = Number.NEGATIVE_INFINITY;
  private cancelPendingFlush: (() => void) | null = null;
  private chain: Promise<void> = Promise.resolve();
  private finished = false;
  private typingSent = false;

  constructor(private readonly deps: TelegramOutputStreamDeps) {
    this.chatId = chatIdOf(deps.sessionRef);
    this.threadId = threadIdOf(deps.sessionRef);

    const startedAt = deps.opts?.requestStartedAtMs;
    this.requestStartedAtMs =
      typeof startedAt === "number" && Number.isFinite(startedAt)
        ? Math.max(0, startedAt)
        : deps.now();

    this.bodyMaxChars = Math.max(1, TELEGRAM_MAX_MESSAGE_CHARS - RESERVED_OVERHEAD_CHARS);

    const requestId = deps.opts?.requestId;
    this.cancelCallbackData = requestId ? buildTelegramCancelCallbackData(requestId) : null;

    for (const ref of deps.opts?.resume?.created ?? []) {
      if (ref.platform !== "telegram") continue;
      if (chatIdOf(ref) !== this.chatId) continue;
      // `sentText` is intentionally left empty: the remote content is unknown,
      // so the first edit must always be issued.
      this.messages.push({
        messageId: parseTelegramMessageId(ref.messageId),
        sentText: "",
        sentMarkup: "",
      });
      this.created.push(ref);
    }
  }

  getFinalTextMode(): SurfaceFinalTextMode {
    return "full";
  }

  /**
   * Messages this stream delivered, with their rendered text.
   *
   * Telegram long polling does not echo the bot's own messages back as
   * updates, so the adapter has to record them into its local index from here
   * or the agent would never see its own prior replies as reply context.
   */
  getDeliveredMessages(): { messageId: number; text: string }[] {
    return this.messages.map((message) => ({
      messageId: message.messageId,
      text: stripTelegramHtml(message.sentText),
    }));
  }

  /** Attachments are buffered here; the adapter owns their delivery. */
  takePendingAttachments(): SurfaceAttachment[] {
    return this.pendingAttachments.splice(0, this.pendingAttachments.length);
  }

  /** Resolves once every queued send/edit has settled. */
  async settled(): Promise<void> {
    await this.chain;
  }

  async push(part: SurfaceOutputPart): Promise<void> {
    switch (part.type) {
      case "text.delta":
        this.freezeReasoningTimer();
        this.textAcc += part.delta;
        await this.onStateChanged();
        return;
      case "text.set":
        this.freezeReasoningTimer();
        this.textAcc = part.text;
        await this.onStateChanged();
        return;
      case "meta.stats":
        this.statsLine = part.line.trim().length > 0 ? part.line.trim() : null;
        return;
      case "reasoning.status": {
        if (this.reasoningStartedAtMs === null) {
          this.reasoningStartedAtMs = part.update.startedAtMs;
        }
        if (part.update.frozenAtMs !== undefined) {
          this.reasoningFrozenAtMs = part.update.frozenAtMs;
        }
        await this.onStateChanged();
        return;
      }
      case "tool.status": {
        this.recordToolStatus(part.update);
        await this.onStateChanged();
        return;
      }
      case "attachment.add":
        this.pendingAttachments.push(part.attachment);
        return;
      default: {
        const exhaustive: never = part;
        return exhaustive;
      }
    }
  }

  async finish(): Promise<SurfaceOutputResult> {
    this.finished = true;
    this.clearPendingFlush();
    await this.chain;
    await this.enqueue(() => this.flush({ final: true }));

    const last = this.created.at(-1);
    if (!last) {
      throw new Error("TelegramOutputStream produced no messages");
    }
    return { created: [...this.created], last };
  }

  async abort(reason?: string): Promise<void> {
    this.finished = true;
    this.clearPendingFlush();
    await this.chain;

    if (this.deps.outputMode === "preview") {
      await this.enqueue(() => this.deleteAllMessages());
      return;
    }

    // Inline mode keeps the message in place; it is only finalised so the
    // cancel keyboard and progress header do not linger.
    if (reason === "cancel" && this.textAcc.trim().length === 0) {
      this.textAcc = CANCELLED_PLACEHOLDER;
    }
    if (this.messages.length === 0 && this.textAcc.trim().length === 0) return;
    await this.enqueue(() => this.flush({ final: true }));
  }

  private freezeReasoningTimer(): void {
    if (this.reasoningStartedAtMs === null) return;
    if (this.reasoningFrozenAtMs !== null) return;
    this.reasoningFrozenAtMs = this.deps.now();
  }

  private recordToolStatus(update: SurfaceToolStatusUpdate): void {
    const index = this.toolEntries.findIndex((entry) => entry.toolCallId === update.toolCallId);
    const previous = index >= 0 ? this.toolEntries[index]?.update : undefined;
    const merged =
      isSubagentToolDisplay(update.display) ||
      (previous !== undefined && isSubagentToolDisplay(previous.display))
        ? mergeSubagentToolStatus(previous, update)
        : update;

    const entry: ProgressEntry = {
      toolCallId: update.toolCallId,
      update: merged,
      updatedSeq: ++this.progressSeq,
    };
    if (index >= 0) this.toolEntries[index] = entry;
    else this.toolEntries.push(entry);
  }

  private async onStateChanged(): Promise<void> {
    if (this.finished) return;
    if (this.lastFlushAtMs === Number.NEGATIVE_INFINITY) {
      // First paint: show something immediately rather than making the user
      // wait out a throttle window for a message that does not exist yet.
      await this.enqueue(() => this.flush({ final: false }));
      return;
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.cancelPendingFlush) return;
    const dueAtMs = this.lastFlushAtMs + this.deps.streamEditIntervalMs;
    const delayMs = Math.max(0, dueAtMs - this.deps.now());
    this.cancelPendingFlush = this.deps.scheduleEdit(() => {
      this.cancelPendingFlush = null;
      if (this.finished) return;
      void this.enqueue(() => this.flush({ final: false }));
    }, delayMs);
  }

  private clearPendingFlush(): void {
    const cancel = this.cancelPendingFlush;
    this.cancelPendingFlush = null;
    cancel?.();
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private delay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.deps.scheduleEdit(() => resolve(), ms);
    });
  }

  private renderBodyHtml(): string {
    if (this.renderCacheInput === this.textAcc) return this.renderCacheOutput;

    const tableRender = this.deps.markdownTableRender;
    const source = tableRender
      ? renderMarkdownTablesAsCodeBlocks(this.textAcc, tableRender)
      : this.textAcc;

    this.renderCacheInput = this.textAcc;
    this.renderCacheOutput = markdownToTelegramHtml(source);
    return this.renderCacheOutput;
  }

  private buildProgressHeader(): string | null {
    const hasReasoning = this.reasoningStartedAtMs !== null;
    if (this.toolEntries.length === 0 && !hasReasoning) return null;

    const nowMs = this.deps.now();
    const lines: string[] = [
      `<b>${escapeTelegramHtml(
        formatWorkingStatus({
          nowMs,
          startedAtMs: this.requestStartedAtMs,
          indicator: pickWorkingIndicator({
            indicators: this.deps.workingIndicators,
            elapsedMs: Math.max(0, nowMs - this.requestStartedAtMs),
          }),
        }),
      )}</b>`,
    ];

    if (this.reasoningStartedAtMs !== null) {
      const endMs = this.reasoningFrozenAtMs ?? nowMs;
      const seconds = Math.max(0, Math.floor((endMs - this.reasoningStartedAtMs) / 1000));
      lines.push(`<i>${escapeTelegramHtml(`Thought for ${seconds}s`)}</i>`);
    }

    for (const line of buildTelegramProgressLines(this.toolEntries)) {
      lines.push(escapeTelegramHtml(line));
    }

    return lines.join("\n");
  }

  private buildStatsHtml(): string | null {
    if (!this.statsLine) return null;
    return `<i>${escapeTelegramHtml(clampWithEllipsis(this.statsLine, STATS_MAX_CHARS))}</i>`;
  }

  private buildReplyMarkup(final: boolean): TelegramReplyMarkup | undefined {
    if (!this.cancelCallbackData) return undefined;
    if (final) return { inline_keyboard: [] };
    return {
      inline_keyboard: [[{ text: CANCEL_BUTTON_LABEL, callback_data: this.cancelCallbackData }]],
    };
  }

  private isSilent(): boolean {
    return this.deps.opts?.silent === true || !this.deps.outputNotification;
  }

  private async flush(opts: { final: boolean }): Promise<void> {
    this.lastFlushAtMs = this.deps.now();

    const chunks = chunkTelegramHtml(this.renderBodyHtml(), { maxChars: this.bodyMaxChars });
    const bodies = chunks.length > 0 ? chunks : [EMPTY_OUTPUT_PLACEHOLDER];
    if (!opts.final && chunks.length === 0 && this.toolEntries.length === 0) {
      // Nothing worth showing yet.
      if (this.reasoningStartedAtMs === null) return;
    }

    const header = opts.final ? null : this.buildProgressHeader();
    const stats = opts.final ? this.buildStatsHtml() : null;
    const markup = this.buildReplyMarkup(opts.final);

    await this.ensureTyping();

    for (let index = 0; index < bodies.length; index += 1) {
      const isLast = index === bodies.length - 1;
      const segments: string[] = [];
      if (isLast && header) segments.push(header);
      segments.push(bodies[index] ?? "");
      if (isLast && stats) segments.push(stats);
      const text = segments.filter((segment) => segment.length > 0).join("\n\n");

      // Only the live (last) message carries the cancel keyboard; earlier
      // messages are finalised as soon as overflow moves past them.
      const messageMarkup = isLast
        ? markup
        : this.cancelCallbackData
          ? { inline_keyboard: [] }
          : undefined;

      const existing = this.messages[index];
      if (existing) {
        await this.editMessage(existing, text, messageMarkup);
        continue;
      }
      await this.sendNewMessage(text, messageMarkup);
    }

    await this.removeSurplusMessages(bodies.length);
  }

  /**
   * Deletes messages beyond the current render.
   *
   * A stream can grow past 4096 chars and later shrink — a long draft replaced
   * by a short final answer. Without this, the old tail stays visible in the
   * chat and its refs are still reported from `finish()`, so the surface shows
   * text the agent has retracted.
   */
  private async removeSurplusMessages(keep: number): Promise<void> {
    if (this.messages.length <= keep) return;

    const surplus = this.messages.splice(keep, this.messages.length - keep);

    for (const message of surplus.reverse()) {
      const ref = telegramMsgRef({
        chatId: this.chatId,
        threadId: this.threadId,
        messageId: message.messageId,
      });
      const key = `${ref.channelId}:${ref.messageId}`;
      const index = this.created.findIndex(
        (created) => `${created.channelId}:${created.messageId}` === key,
      );
      if (index !== -1) this.created.splice(index, 1);

      try {
        await this.deps.api.deleteMessage({
          chat_id: this.chatId,
          message_id: message.messageId,
        });
      } catch {
        // Already gone, or outside the 48h delete window: the surplus entry is
        // dropped either way so it is not reported as part of the answer.
      }
    }
  }

  private async ensureTyping(): Promise<void> {
    if (this.typingSent) return;
    this.typingSent = true;
    try {
      await this.deps.api.sendChatAction({
        chat_id: this.chatId,
        ...(this.threadId === undefined ? {} : { message_thread_id: this.threadId }),
        action: "typing",
      });
    } catch {
      // A missing typing indicator must never fail the reply.
    }
  }

  private async sendNewMessage(
    html: string,
    markup: TelegramReplyMarkup | undefined,
  ): Promise<void> {
    const replyTo = this.messages.length === 0 ? this.deps.opts?.replyTo : undefined;
    const replyToMessageId =
      replyTo && replyTo.platform === "telegram" ? parseTelegramMessageId(replyTo.messageId) : null;

    const sent = await this.withFallbacks(html, async (payload) =>
      this.deps.api.sendMessage({
        chat_id: this.chatId,
        ...(this.threadId === undefined ? {} : { message_thread_id: this.threadId }),
        text: payload.text,
        ...(payload.parseMode ? { parse_mode: payload.parseMode } : {}),
        ...(replyToMessageId === null ? {} : { reply_to_message_id: replyToMessageId }),
        ...(this.isSilent() ? { disable_notification: true } : {}),
        ...(markup ? { reply_markup: markup } : {}),
        link_preview_options: { is_disabled: true },
      }),
    );
    if (sent === "not_modified" || sent === null) return;

    this.messages.push({
      messageId: sent.message_id,
      sentText: html,
      sentMarkup: markupKey(markup),
    });

    const ref = telegramMsgRef({
      chatId: this.chatId,
      threadId: this.threadId ?? null,
      messageId: sent.message_id,
    });
    this.created.push(ref);
    try {
      this.deps.opts?.onMessageCreated?.(ref);
    } catch {
      // The hook is advisory; a throwing consumer must not break delivery.
    }
  }

  private async editMessage(
    message: OutputMessage,
    html: string,
    markup: TelegramReplyMarkup | undefined,
  ): Promise<void> {
    const nextMarkup = markupKey(markup);
    // Telegram rejects an edit that changes nothing with an error, so identical
    // payloads are never sent.
    if (message.sentText === html && message.sentMarkup === nextMarkup) return;

    const result = await this.withFallbacks(html, async (payload) => {
      await this.deps.api.editMessageText({
        chat_id: this.chatId,
        message_id: message.messageId,
        text: payload.text,
        ...(payload.parseMode ? { parse_mode: payload.parseMode } : {}),
        ...(markup ? { reply_markup: markup } : {}),
        link_preview_options: { is_disabled: true },
      });
      return true;
    });

    if (result === null) return;
    message.sentText = html;
    message.sentMarkup = nextMarkup;
  }

  /**
   * Runs an API call, retrying once for a 429 (honouring `retry_after`) and
   * once without entity parsing if Telegram rejected the markup. Returns
   * `"not_modified"` for the benign no-op edit and `null` when the call could
   * not be completed.
   */
  private async withFallbacks<T>(
    html: string,
    run: (payload: { text: string; parseMode: TelegramParseMode | undefined }) => Promise<T>,
  ): Promise<T | "not_modified" | null> {
    const useHtml = this.deps.parseMode === "html";
    let payload: { text: string; parseMode: TelegramParseMode | undefined } = useHtml
      ? { text: html, parseMode: "HTML" }
      : { text: stripTelegramHtml(html), parseMode: undefined };

    let retriedRateLimit = false;
    let retriedPlain = false;

    for (;;) {
      try {
        return await run(payload);
      } catch (error) {
        if (isTelegramNotModifiedError(error)) return "not_modified";

        const retryAfter = telegramRetryAfterSeconds(error);
        if (retryAfter !== null && !retriedRateLimit) {
          retriedRateLimit = true;
          await this.delay(retryAfter * 1000);
          continue;
        }

        if (isTelegramEntityError(error) && payload.parseMode !== undefined && !retriedPlain) {
          retriedPlain = true;
          payload = { text: stripTelegramHtml(html), parseMode: undefined };
          continue;
        }

        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`telegram: message delivery failed: ${message}`);
      }
    }
  }

  private async deleteAllMessages(): Promise<void> {
    const messages = this.messages.splice(0, this.messages.length);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message) continue;
      try {
        await this.deps.api.deleteMessage({
          chat_id: this.chatId,
          message_id: message.messageId,
        });
      } catch {
        // Deleting a preview is best-effort: it may already be gone.
      }
    }
    this.created.length = 0;
  }
}
