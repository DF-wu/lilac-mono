import { Bot, GrammyError, HttpError } from "grammy";
import type {
  InlineKeyboardMarkup,
  MaybeInaccessibleMessage,
  Message,
  ReactionTypeEmoji,
  Update,
  UserFromGetMe,
} from "grammy/types";

import {
  createLogger,
  getCoreConfig,
  resolveTelegramDbPath,
  resolveTelegramToken,
  type CoreConfig,
} from "@stanley2058/lilac-utils";

import type {
  AdapterCapabilities,
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfaceSelf,
  SurfaceSession,
  TelegramMsgRef,
  TelegramSessionRef,
} from "../types";
import type { AdapterEvent } from "../events";
import type {
  AdapterEventHandler,
  AdapterSubscription,
  StartOutputOpts,
  SurfaceAdapter,
  SurfaceOutputStream,
  TypingIndicatorSubscription,
} from "../adapter";
import { SurfaceMessageNotFoundError } from "../adapter";

import {
  chatIdOf,
  formatTelegramSessionId,
  parseTelegramMessageId,
  parseTelegramSessionId,
  telegramMsgRef,
  telegramSessionRef,
  threadIdOf,
} from "./telegram-ids";
import {
  isRoutableTelegramMessage,
  isTelegramChatAllowed,
  isTelegramUserAllowed,
  telegramUserName,
} from "./telegram-guards";
import {
  telegramMessageText,
  telegramTopicIdOf,
  toSurfaceMessage,
  toTelegramRawEnvelope,
} from "./telegram-raw";
import { TelegramSurfaceStore } from "./store/telegram-surface-store";
import {
  createGrammyAttachmentApi,
  TelegramOutputStreamWithAttachments,
} from "./output/telegram-attachment-delivery";
import {
  TelegramOutputStream,
  type TelegramOutputApi,
  parseTelegramCancelCallbackData,
  type TelegramReplyMarkup,
} from "./output/telegram-output-stream";

export type TelegramAdapterHealthSnapshot = {
  connectionState: "idle" | "connecting" | "ready" | "disconnected";
  isReady: boolean;
  readyAt?: number;
  lastUpdateAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  botUsername?: string;
};

export type TelegramAdapterOptions = {
  /** Injected config, primarily for tests. Defaults to the shared core config. */
  getConfig?: () => Promise<CoreConfig>;
  /**
   * Override the Bot API endpoint. The integration harness points this at a
   * local fake server so tests never touch api.telegram.org.
   */
  apiRoot?: string;
};

/**
 * Updates we ask Telegram to deliver.
 *
 * `message_reaction` is not part of the Bot API default set, so it has to be
 * requested explicitly or reaction events silently never arrive.
 */
const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "callback_query",
  "message_reaction",
] as const satisfies readonly (keyof Update)[];

function assertTelegramSessionRef(
  sessionRef: SessionRef,
): asserts sessionRef is TelegramSessionRef {
  if (sessionRef.platform !== "telegram") {
    throw new Error(`Expected telegram sessionRef (got '${sessionRef.platform}')`);
  }
}

function assertTelegramMsgRef(msgRef: MsgRef): asserts msgRef is TelegramMsgRef {
  if (msgRef.platform !== "telegram") {
    throw new Error(`Expected telegram msgRef (got '${msgRef.platform}')`);
  }
}

/**
 * Telegram reports a missing/inaccessible message as a 400 with a descriptive
 * string rather than a stable code, so classification is textual.
 */
export function classifyTelegramNotFound(error: unknown): SurfaceMessageNotFoundError | null {
  if (!(error instanceof GrammyError)) return null;
  const description = error.description.toLowerCase();
  const isNotFound =
    description.includes("message to edit not found") ||
    description.includes("message to delete not found") ||
    description.includes("message not found") ||
    description.includes("message can't be edited") ||
    description.includes("message identifier is not specified");

  return isNotFound
    ? new SurfaceMessageNotFoundError("telegram", error.error_code, error.description)
    : null;
}

export class TelegramAdapter implements SurfaceAdapter {
  private bot: Bot | null = null;
  private store: TelegramSurfaceStore | null = null;
  private cfg: CoreConfig | null = null;
  private me: UserFromGetMe | null = null;
  private self: SurfaceSelf | null = null;
  private readonly handlers = new Set<AdapterEventHandler>();
  private pollingStopped: Promise<void> | null = null;

  private readonly logger = createLogger({ module: "surface:telegram" });

  private healthState: TelegramAdapterHealthSnapshot = {
    connectionState: "idle",
    isReady: false,
  };

  constructor(private readonly opts?: TelegramAdapterOptions) {}

  async connect(): Promise<void> {
    if (this.bot) return;

    this.healthState = { connectionState: "connecting", isReady: false };

    const cfg = await this.resolveCoreConfig();
    this.cfg = cfg;
    this.store = new TelegramSurfaceStore(resolveTelegramDbPath(cfg));

    const bot = new Bot(
      resolveTelegramToken(cfg),
      this.opts?.apiRoot ? { client: { apiRoot: this.opts.apiRoot } } : {},
    );
    this.bot = bot;

    bot.catch((err) => {
      const cause = err.error;
      const message =
        cause instanceof GrammyError
          ? `Bot API error: ${cause.description}`
          : cause instanceof HttpError
            ? `network error: ${cause.message}`
            : cause instanceof Error
              ? cause.message
              : String(cause);

      this.healthState = {
        ...this.healthState,
        lastErrorAt: Date.now(),
        lastError: message,
      };
      this.logger.error("telegram update handler failed", { updateId: err.ctx.update.update_id });
    });

    this.registerHandlers(bot);

    await bot.init();
    this.me = bot.botInfo;
    this.self = {
      platform: "telegram",
      userId: String(bot.botInfo.id),
      userName: bot.botInfo.username,
    };

    if (cfg.surface.telegram.commandMenu) {
      await this.registerCommandMenu(bot).catch((e: unknown) => {
        this.logger.warn("failed to register telegram command menu", {}, e);
      });
    }

    // bot.start() resolves only once polling stops, so it is intentionally not
    // awaited here; connect() must return as soon as the bot is live.
    this.pollingStopped = bot.start({
      allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
      onStart: (info) => {
        this.healthState = {
          connectionState: "ready",
          isReady: true,
          readyAt: Date.now(),
          botUsername: info.username,
        };
        this.logger.info("telegram surface ready", { botUsername: info.username });
      },
    });
  }

  async disconnect(): Promise<void> {
    const bot = this.bot;
    if (!bot) return;

    this.bot = null;
    await bot.stop();
    // Let the polling loop unwind before tearing down the store it may touch.
    await this.pollingStopped?.catch(() => undefined);
    this.pollingStopped = null;

    this.store?.close();
    this.store = null;
    this.healthState = {
      ...this.healthState,
      connectionState: "disconnected",
      isReady: false,
    };
  }

  getHealthSnapshot(): TelegramAdapterHealthSnapshot {
    return { ...this.healthState };
  }

  async refreshCoreConfig(): Promise<void> {
    this.cfg = await this.resolveCoreConfig();
  }

  async getSelf(): Promise<SurfaceSelf> {
    if (this.self) return this.self;
    throw new Error("telegram adapter: not connected");
  }

  async getCapabilities(): Promise<AdapterCapabilities> {
    return {
      platform: "telegram",
      send: true,
      edit: true,
      delete: true,
      reactions: true,
      // Served from the local index rather than the Bot API, which has no
      // history endpoint.
      readHistory: true,
      threads: true,
      markRead: true,
    };
  }

  async listSessions(): Promise<SurfaceSession[]> {
    const store = this.mustStore();
    return store.listSessions().map((row) => ({
      ref: telegramSessionRef({ chatId: row.chat_id, threadId: row.thread_id }),
      ...(row.title === null ? {} : { title: row.title }),
      kind: row.kind,
    }));
  }

  async startOutput(sessionRef: SessionRef, opts?: StartOutputOpts): Promise<SurfaceOutputStream> {
    assertTelegramSessionRef(sessionRef);
    const bot = this.mustBot();
    const cfg = this.cfg ?? (await this.resolveCoreConfig());
    const telegram = cfg.surface.telegram;

    const silent = opts?.silent === true || !telegram.outputNotification;

    const stream = new TelegramOutputStream({
      api: createGrammyOutputApi(bot),
      sessionRef,
      ...(opts ? { opts } : {}),
      now: () => Date.now(),
      scheduleEdit: (cb, delayMs) => {
        const timer = setTimeout(cb, delayMs);
        return () => clearTimeout(timer);
      },
      streamEditIntervalMs: telegram.streamEditIntervalMs,
      parseMode: telegram.parseMode,
      outputMode: telegram.outputMode,
      outputNotification: !silent,
      workingIndicators: telegram.workingIndicators,
      ...(telegram.markdownTableRender.enabled
        ? { markdownTableRender: telegram.markdownTableRender }
        : {}),
    });

    return new TelegramOutputStreamWithAttachments(stream, {
      api: createGrammyAttachmentApi(bot),
      sessionRef,
      silent,
      onError: (error: unknown) => {
        this.logger.warn("failed to deliver telegram attachments", {}, error);
      },
      onDelivered: (messages) => this.recordOwnOutput(sessionRef, messages),
    });
  }

  async sendMsg(sessionRef: SessionRef, content: ContentOpts, opts?: SendOpts): Promise<MsgRef> {
    assertTelegramSessionRef(sessionRef);
    const bot = this.mustBot();
    const text = content.text ?? "";
    if (!text.trim()) {
      throw new Error("telegram adapter: sendMsg requires non-empty text");
    }

    const { chatId, threadId } = parseTelegramSessionId(sessionRef.channelId);
    const replyTo = opts?.replyTo;

    const sent = await bot.api.sendMessage(chatId, text, {
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
      ...(opts?.silent ? { disable_notification: true } : {}),
      ...(replyTo && replyTo.platform === "telegram"
        ? {
            reply_parameters: {
              message_id: parseTelegramMessageId(replyTo.messageId),
              // The agent may be replying to a message that has since been
              // deleted; sending anyway beats dropping the reply entirely.
              allow_sending_without_reply: true,
            },
          }
        : {}),
    });

    this.recordMessage(sent, { fromBot: true });

    return telegramMsgRef({ chatId, threadId, messageId: sent.message_id });
  }

  async readMsg(msgRef: MsgRef): Promise<SurfaceMessage | null> {
    assertTelegramMsgRef(msgRef);
    const record = this.mustStore().getMessage({
      sessionId: msgRef.channelId,
      messageId: msgRef.messageId,
    });
    if (!record) return null;

    return {
      ref: msgRef,
      session: { platform: "telegram", channelId: msgRef.channelId },
      userId: record.userId,
      ...(record.userName === undefined ? {} : { userName: record.userName }),
      text: record.text,
      ts: record.ts,
      ...(record.editedTs === undefined ? {} : { editedTs: record.editedTs }),
    };
  }

  async listMsg(sessionRef: SessionRef, opts?: LimitOpts): Promise<SurfaceMessage[]> {
    assertTelegramSessionRef(sessionRef);
    const records = this.mustStore().listMessages({
      sessionId: sessionRef.channelId,
      ...(opts?.limit === undefined ? {} : { limit: opts.limit }),
      ...(opts?.beforeMessageId === undefined ? {} : { beforeMessageId: opts.beforeMessageId }),
      ...(opts?.afterMessageId === undefined ? {} : { afterMessageId: opts.afterMessageId }),
    });

    return records.map((record) => ({
      ref: telegramMsgRef({
        chatId: record.chatId,
        threadId: record.threadId,
        messageId: record.messageId,
      }),
      session: sessionRef,
      userId: record.userId,
      ...(record.userName === undefined ? {} : { userName: record.userName }),
      text: record.text,
      ts: record.ts,
      ...(record.editedTs === undefined ? {} : { editedTs: record.editedTs }),
    }));
  }

  async editMsg(msgRef: MsgRef, content: ContentOpts): Promise<void> {
    assertTelegramMsgRef(msgRef);
    const bot = this.mustBot();
    const text = content.text ?? "";
    if (!text.trim()) {
      throw new Error("telegram adapter: editMsg requires non-empty text");
    }

    try {
      await bot.api.editMessageText(
        chatIdOf(msgRef),
        parseTelegramMessageId(msgRef.messageId),
        text,
      );
    } catch (error: unknown) {
      const notFound = classifyTelegramNotFound(error);
      if (notFound) throw notFound;
      throw error;
    }
  }

  async deleteMsg(msgRef: MsgRef): Promise<void> {
    assertTelegramMsgRef(msgRef);
    const bot = this.mustBot();

    try {
      await bot.api.deleteMessage(chatIdOf(msgRef), parseTelegramMessageId(msgRef.messageId));
    } catch (error: unknown) {
      const notFound = classifyTelegramNotFound(error);
      if (notFound) throw notFound;
      throw error;
    }

    this.store?.markDeleted({ sessionId: msgRef.channelId, messageId: msgRef.messageId });
  }

  async getReplyContext(msgRef: MsgRef, opts?: LimitOpts): Promise<SurfaceMessage[]> {
    assertTelegramMsgRef(msgRef);
    return await this.listMsg({ platform: "telegram", channelId: msgRef.channelId }, opts);
  }

  async addReaction(msgRef: MsgRef, reaction: string): Promise<void> {
    assertTelegramMsgRef(msgRef);
    const bot = this.mustBot();

    // setMessageReaction replaces the whole reaction set for the bot, so a
    // single emoji is both "add" and "set".
    await bot.api.setMessageReaction(chatIdOf(msgRef), parseTelegramMessageId(msgRef.messageId), [
      { type: "emoji", emoji: toTelegramEmojiReaction(reaction) },
    ]);
  }

  async removeReaction(msgRef: MsgRef, _reaction: string): Promise<void> {
    assertTelegramMsgRef(msgRef);
    const bot = this.mustBot();
    await bot.api.setMessageReaction(
      chatIdOf(msgRef),
      parseTelegramMessageId(msgRef.messageId),
      [],
    );
  }

  async listReactions(_msgRef: MsgRef): Promise<string[]> {
    // The Bot API exposes reactions only as update events, never as a query.
    return [];
  }

  async startTyping(sessionRef: SessionRef): Promise<TypingIndicatorSubscription> {
    assertTelegramSessionRef(sessionRef);
    const bot = this.mustBot();
    const { chatId, threadId } = parseTelegramSessionId(sessionRef.channelId);

    let stopped = false;
    const send = () => {
      if (stopped) return;
      void bot.api
        .sendChatAction(
          chatId,
          "typing",
          threadId === undefined ? {} : { message_thread_id: threadId },
        )
        .catch(() => undefined);
    };

    send();
    // Telegram clears the typing indicator after ~5s, so it must be refreshed.
    const timer = setInterval(send, 4_500);

    return {
      stop: async () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  async subscribe(handler: AdapterEventHandler): Promise<AdapterSubscription> {
    this.handlers.add(handler);
    return {
      stop: async () => {
        this.handlers.delete(handler);
      },
    };
  }

  async getUnRead(sessionRef: SessionRef): Promise<SurfaceMessage[]> {
    assertTelegramSessionRef(sessionRef);
    const records = this.mustStore().listUnread({ sessionId: sessionRef.channelId });

    return records.map((record) => ({
      ref: telegramMsgRef({
        chatId: record.chatId,
        threadId: record.threadId,
        messageId: record.messageId,
      }),
      session: sessionRef,
      userId: record.userId,
      ...(record.userName === undefined ? {} : { userName: record.userName }),
      text: record.text,
      ts: record.ts,
    }));
  }

  async markRead(sessionRef: SessionRef, upToMsgRef?: MsgRef): Promise<void> {
    assertTelegramSessionRef(sessionRef);
    const store = this.mustStore();

    const target = upToMsgRef?.platform === "telegram" ? upToMsgRef : undefined;
    const latest = target
      ? store.getMessage({ sessionId: sessionRef.channelId, messageId: target.messageId })
      : store.listMessages({ sessionId: sessionRef.channelId, limit: 1 })[0];

    if (!latest) return;
    store.markRead({
      sessionId: sessionRef.channelId,
      messageId: latest.messageId,
      ts: latest.ts,
    });
  }

  // ---------------------------------------------------------------------------
  // Ingress
  // ---------------------------------------------------------------------------

  private registerHandlers(bot: Bot): void {
    bot.on("message", async (ctx) => {
      this.healthState = { ...this.healthState, lastUpdateAt: Date.now() };
      await this.onMessage(ctx.message, "created");
    });

    bot.on("edited_message", async (ctx) => {
      this.healthState = { ...this.healthState, lastUpdateAt: Date.now() };
      await this.onMessage(ctx.editedMessage, "updated");
    });

    bot.on("message_reaction", async (ctx) => {
      const update = ctx.messageReaction;
      if (!this.isAllowed({ chatId: update.chat.id, userId: update.user?.id })) return;

      const sessionId = formatTelegramSessionId({ chatId: update.chat.id });
      const messageRef = telegramMsgRef({
        chatId: update.chat.id,
        messageId: update.message_id,
      });
      const session = telegramSessionRef({ chatId: update.chat.id });

      const before = new Set(
        update.old_reaction.flatMap((r) => (r.type === "emoji" ? [r.emoji] : [])),
      );
      const after = new Set(
        update.new_reaction.flatMap((r) => (r.type === "emoji" ? [r.emoji] : [])),
      );

      for (const emoji of after) {
        if (before.has(emoji)) continue;
        await this.emit({
          type: "adapter.reaction.added",
          platform: "telegram",
          ts: Date.now(),
          messageRef,
          session,
          reaction: emoji,
          ...(update.user ? { userId: String(update.user.id) } : {}),
          ...(telegramUserName(update.user) === undefined
            ? {}
            : { userName: telegramUserName(update.user) }),
        });
      }

      for (const emoji of before) {
        if (after.has(emoji)) continue;
        await this.emit({
          type: "adapter.reaction.removed",
          platform: "telegram",
          ts: Date.now(),
          messageRef,
          session,
          reaction: emoji,
          ...(update.user ? { userId: String(update.user.id) } : {}),
        });
      }

      this.logger.debug("telegram reaction update", { sessionId });
    });

    bot.on("callback_query:data", async (ctx) => {
      const query = ctx.callbackQuery;
      const message = query.message;
      if (!message) return;
      if (!this.isAllowed({ chatId: message.chat.id, userId: query.from.id })) return;

      const cancelRequestId = parseTelegramCancelCallbackData(query.data);

      // Always answer, otherwise the client spins until the query times out.
      await ctx
        .answerCallbackQuery(cancelRequestId ? { text: "Cancelling\u2026" } : {})
        .catch(() => undefined);

      const threadId = topicIdOfCallbackMessage(message);

      // The cancel button rides the same callback_query channel as ordinary
      // actions, but the runtime cancels through a distinct event.
      if (cancelRequestId) {
        await this.emit({
          type: "adapter.request.cancel",
          platform: "telegram",
          ts: Date.now(),
          requestId: cancelRequestId,
          sessionId: formatTelegramSessionId({ chatId: message.chat.id, threadId }),
          cancelScope: "active_or_queued",
          source: "button",
          userId: String(query.from.id),
          messageId: String(message.message_id),
        });
        return;
      }

      await this.emit({
        type: "adapter.action.invoked",
        platform: "telegram",
        ts: Date.now(),
        actionId: query.data,
        userId: String(query.from.id),
        messageRef: telegramMsgRef({
          chatId: message.chat.id,
          threadId,
          messageId: message.message_id,
        }),
      });
    });
  }

  private async onMessage(message: Message, kind: "created" | "updated"): Promise<void> {
    if (!this.isAllowed({ chatId: message.chat.id, userId: message.from?.id })) return;

    // Record first, gate second. Non-routable messages (other bots, service
    // posts) still belong in the local index so they can appear as reply
    // context; only routing them to the agent would be wrong.
    const fromBot = message.from?.is_bot === true;
    this.recordMessage(message, { fromBot });

    if (!isRoutableTelegramMessage({ message, botUserId: this.me?.id })) return;

    const surfaceMessage = toSurfaceMessage({
      message,
      ...(this.me?.username === undefined ? {} : { botUsername: this.me.username }),
      ...(this.me?.id === undefined ? {} : { botUserId: this.me.id }),
    });

    await this.emit(
      kind === "created"
        ? {
            type: "adapter.message.created",
            platform: "telegram",
            ts: Date.now(),
            message: surfaceMessage,
            ...(chatTitleOf(message) === undefined ? {} : { channelName: chatTitleOf(message) }),
          }
        : {
            type: "adapter.message.updated",
            platform: "telegram",
            ts: Date.now(),
            message: surfaceMessage,
            ...(chatTitleOf(message) === undefined ? {} : { channelName: chatTitleOf(message) }),
          },
    );
  }

  private isAllowed(input: { chatId: number; userId?: number }): boolean {
    const cfg = this.cfg;
    if (!cfg) return false;
    if (!isTelegramChatAllowed({ cfg, chatId: input.chatId })) return false;
    return isTelegramUserAllowed({ cfg, userId: input.userId });
  }

  private recordMessage(message: Message, opts: { fromBot: boolean }): void {
    const store = this.store;
    if (!store) return;

    const threadId = telegramTopicIdOf(message);
    const sessionId = formatTelegramSessionId({ chatId: message.chat.id, threadId });

    store.upsertSession({
      sessionId,
      chatId: String(message.chat.id),
      ...(threadId === undefined ? {} : { threadId: String(threadId) }),
      ...(chatTitleOf(message) === undefined ? {} : { title: chatTitleOf(message) }),
      kind: message.chat.type === "private" ? "dm" : threadId === undefined ? "channel" : "thread",
      updatedTs: Date.now(),
    });

    store.upsertMessage({
      sessionId,
      messageId: String(message.message_id),
      chatId: String(message.chat.id),
      ...(threadId === undefined ? {} : { threadId: String(threadId) }),
      userId: message.from ? String(message.from.id) : "unknown",
      ...(telegramUserName(message.from) === undefined
        ? {}
        : { userName: telegramUserName(message.from) }),
      text: telegramMessageText(message),
      ts: message.date * 1000,
      ...(message.edit_date === undefined ? {} : { editedTs: message.edit_date * 1000 }),
      ...(message.reply_to_message === undefined
        ? {}
        : { replyToMessageId: String(message.reply_to_message.message_id) }),
      fromBot: opts.fromBot,
      raw: toTelegramRawEnvelope({
        message,
        ...(this.me?.username === undefined ? {} : { botUsername: this.me.username }),
        ...(this.me?.id === undefined ? {} : { botUserId: this.me.id }),
      }),
    });
  }

  /**
   * Indexes the bot's own replies.
   *
   * Telegram long polling never echoes them back as updates, so without this
   * the agent would have no record of what it already said and reply context
   * would show only the human side of the conversation.
   */
  private recordOwnOutput(
    sessionRef: TelegramSessionRef,
    messages: readonly { messageId: number; text: string }[],
  ): void {
    const store = this.store;
    if (!store || messages.length === 0) return;

    const { chatId, threadId } = parseTelegramSessionId(sessionRef.channelId);
    const self = this.self;
    const now = Date.now();

    for (const message of messages) {
      store.upsertMessage({
        sessionId: sessionRef.channelId,
        messageId: String(message.messageId),
        chatId: String(chatId),
        ...(threadId === undefined ? {} : { threadId: String(threadId) }),
        userId: self?.userId ?? "bot",
        ...(self?.userName === undefined ? {} : { userName: self.userName }),
        text: message.text,
        ts: now,
        fromBot: true,
      });
    }
  }

  private async emit(evt: AdapterEvent): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(evt);
      } catch (e: unknown) {
        this.logger.error("telegram adapter handler failed", { type: evt.type }, e);
      }
    }
  }

  private async registerCommandMenu(bot: Bot): Promise<void> {
    await bot.api.setMyCommands([
      { command: "help", description: "Show what this bot can do" },
      { command: "cancel", description: "Cancel the request currently running" },
      { command: "new", description: "Start a fresh conversation in this chat" },
    ]);
  }

  private async resolveCoreConfig(): Promise<CoreConfig> {
    return this.opts?.getConfig ? await this.opts.getConfig() : await getCoreConfig();
  }

  private mustBot(): Bot {
    const bot = this.bot;
    if (!bot) throw new Error("telegram adapter: not connected");
    return bot;
  }

  private mustStore(): TelegramSurfaceStore {
    const store = this.store;
    if (!store) throw new Error("telegram adapter: not connected");
    return store;
  }
}

/**
 * Backs the stream's narrow Bot API surface with grammY.
 *
 * The stream stays framework-agnostic so it can be unit-tested against a
 * recorder; this is the only place the two are joined.
 */
function createGrammyOutputApi(bot: Bot): TelegramOutputApi {
  return {
    sendMessage: async (params) => {
      const {
        chat_id,
        text,
        message_thread_id,
        parse_mode,
        reply_to_message_id,
        disable_notification,
        reply_markup,
        link_preview_options,
      } = params;

      const sent = await bot.api.sendMessage(chat_id, text, {
        ...(message_thread_id === undefined ? {} : { message_thread_id }),
        ...(parse_mode === undefined ? {} : { parse_mode }),
        ...(disable_notification === undefined ? {} : { disable_notification }),
        ...(reply_to_message_id === undefined
          ? {}
          : {
              reply_parameters: {
                message_id: reply_to_message_id,
                allow_sending_without_reply: true,
              },
            }),
        ...(reply_markup === undefined ? {} : { reply_markup: toGrammyKeyboard(reply_markup) }),
        ...(link_preview_options === undefined
          ? {}
          : { link_preview_options: { is_disabled: true } }),
      });
      return { message_id: sent.message_id };
    },
    editMessageText: async (params) => {
      const { chat_id, message_id, text, parse_mode, reply_markup, link_preview_options } = params;

      await bot.api.editMessageText(chat_id, message_id, text, {
        ...(parse_mode === undefined ? {} : { parse_mode }),
        ...(reply_markup === undefined ? {} : { reply_markup: toGrammyKeyboard(reply_markup) }),
        ...(link_preview_options === undefined
          ? {}
          : { link_preview_options: { is_disabled: true } }),
      });
    },
    deleteMessage: async (params) => {
      await bot.api.deleteMessage(params.chat_id, params.message_id);
    },
    sendChatAction: async (params) => {
      const { chat_id, action, message_thread_id } = params;
      await bot.api.sendChatAction(
        chat_id,
        action,
        message_thread_id === undefined ? {} : { message_thread_id },
      );
    },
  };
}

/**
 * The stream models its keyboard as deeply readonly; grammY's parameter types
 * are mutable. Copy rather than assert, so neither side has to relax its types.
 */
function toGrammyKeyboard(markup: TelegramReplyMarkup): InlineKeyboardMarkup {
  return {
    inline_keyboard: markup.inline_keyboard.map((row) =>
      row.map((button) => ({ text: button.text, callback_data: button.callback_data })),
    ),
  };
}

/**
 * A callback query's message may be "inaccessible" (Telegram omits everything
 * but the id and chat), so the topic id can only be read when the full message
 * is present.
 */
function topicIdOfCallbackMessage(message: MaybeInaccessibleMessage): number | undefined {
  return "date" in message && message.date !== 0 ? telegramTopicIdOf(message) : undefined;
}

function chatTitleOf(message: Message): string | undefined {
  const chat = message.chat;
  if (chat.type === "private") return telegramUserName(message.from);
  return chat.title;
}

/**
 * Telegram accepts only a fixed emoji set for bot reactions, and rejects
 * anything else with a 400. Map the surface-neutral names the tool layer uses
 * onto members of that set; unknown input degrades to a thumbs up rather than
 * failing the call.
 */
export function toTelegramEmojiReaction(reaction: string): ReactionTypeEmoji["emoji"] {
  const known: Record<string, ReactionTypeEmoji["emoji"]> = {
    "👍": "👍",
    "👎": "👎",
    "❤️": "❤",
    "🔥": "🔥",
    "🎉": "🎉",
    "👀": "👀",
    "😁": "😁",
    "🤔": "🤔",
    "🙏": "🙏",
    "✅": "👍",
    white_check_mark: "👍",
    eyes: "👀",
    thumbsup: "👍",
    "+1": "👍",
  };

  return known[reaction] ?? "👍";
}

export { threadIdOf };
