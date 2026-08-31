import { Result } from "better-result";
import { Bot } from "grammy";
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
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfaceReactionDetail,
  SurfaceSelf,
  SurfaceSession,
  SurfaceSessionParticipantsResult,
  TelegramSessionRef,
  SurfaceAction,
} from "../types";
import type { CustomCommandManager } from "../../custom-commands/manager";

import type { AdapterEvent } from "../events";
import {
  type AdapterEventHandler,
  type AdapterSubscription,
  type StartOutputOpts,
  type SurfaceAdapter,
  type SurfaceMergeBlockPlanOptions,
  type SurfaceOperationResult,
  type SurfaceOutputStream,
  type SurfaceReplyChainPlanOptions,
  type SurfaceSendPreparationInput,
  type TypingIndicatorSubscription,
} from "../adapter";

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
import { telegramIngressDedupeKey } from "./telegram-ingress";
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
import { markdownToTelegramHtml } from "./output/telegram-html";
import {
  captureTelegramOperation,
  prepareTelegramSendResult,
  TelegramAdapterUnavailable,
  telegramInvalidInput,
  telegramMsgRefResult,
  telegramNestedMsgRefResult,
  telegramSessionRefResult,
  telegramUnsupported,
} from "./telegram-operation-result";
import { captureError } from "../../shared/error-capture";
import {
  projectTelegramBotFailure,
  projectTelegramError,
  type TelegramErrorProjection,
} from "./telegram-error-projection";

export type TelegramAdapterHealthSnapshot = {
  /**
   * `failed` is distinct from `disconnected`: the latter is a deliberate
   * shutdown, the former means polling stopped on its own and the surface is
   * deaf. Collapsing the two would let a fatal exit read as a clean stop.
   */
  connectionState: "idle" | "connecting" | "ready" | "disconnected" | "failed";
  isReady: boolean;
  /** Set when polling exited unexpectedly; drives `telegram.ready` red. */
  pollingExitedAt?: number;
  /** True when the exit can never succeed on retry (bad token, rival poller). */
  pollingExitFatal?: boolean;
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
  /**
   * Source of the command menu. Without it the menu is cleared rather than
   * left stale, so a deployment that drops its commands does not keep
   * advertising them.
   */
  customCommands?: CustomCommandManager;
};

export type TelegramConfigRefreshResult = {
  restartRequiredFor: string[];
};

const TELEGRAM_RESTART_REQUIRED_FIELDS = [
  "enabled",
  "token",
  "apiRoot",
  "dbPath",
  "commandMenu",
] as const;

function sanitizeTelegramErrorMessage(message: string, token?: string): string {
  let sanitized = message;
  if (token) sanitized = sanitized.split(token).join("<redacted>");
  return sanitized.replace(/\/bot[^\s/]+/gu, "/bot<redacted>");
}

const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

export function buildTelegramActionKeyboard(
  actions: readonly SurfaceAction[] | undefined,
): InlineKeyboardMarkup | undefined {
  if (!actions) return undefined;

  const inlineKeyboard = actions.flatMap((action) =>
    Buffer.byteLength(action.actionId, "utf8") <= TELEGRAM_CALLBACK_DATA_MAX_BYTES
      ? [[{ text: action.label, callback_data: action.actionId }]]
      : [],
  );

  return { inline_keyboard: inlineKeyboard };
}

/**
 * Telegram's ceiling for `setMyCommands`. Exceeding it fails the whole call,
 * so the list is trimmed rather than losing the menu entirely.
 */
const TELEGRAM_MAX_MENU_COMMANDS = 100;

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

function isTelegramMessageAbsent(error: Error): boolean {
  const description = error.message.toLowerCase();
  return (
    description.includes("message to edit not found") ||
    description.includes("message to delete not found") ||
    description.includes("message not found")
  );
}

function isTelegramMessageNotModified(error: TelegramErrorProjection): boolean {
  return error.normalizedText.includes("message is not modified");
}

/**
 * Whether a polling exit can ever succeed on a retry.
 *
 * `401` means the token is wrong and `409` means another process is polling the
 * same token; reconnecting in either case just produces the same failure while
 * reporting healthy in between. Everything else is treated as transient.
 */
export function isFatalTelegramPollingExit(error: TelegramErrorProjection | null): boolean {
  return error?.kind === "grammy" && (error.errorCode === 401 || error.errorCode === 409);
}

type TelegramIngressDeliveryResult = { ok: true } | { ok: false; error: string; cause: Error };

export class TelegramAdapter implements SurfaceAdapter {
  private bot: Bot | null = null;
  private store: TelegramSurfaceStore | null = null;
  private cfg: CoreConfig | null = null;
  private me: UserFromGetMe | null = null;
  private self: SurfaceSelf | null = null;
  private readonly handlers = new Set<AdapterEventHandler>();
  private pollingStopped: Promise<void> | null = null;
  private ready: { promise: Promise<void>; resolve: () => void } | null = null;
  /**
   * Set by `disconnect()` so the supervisor can tell a deliberate stop from
   * polling dying on its own. Without it every clean shutdown would be
   * reported as a failure.
   */
  private stopping = false;
  /**
   * True once `stopIngress()` has quiesced polling but the adapter is still
   * able to send. Keeps `disconnect()` from stopping an already-stopped bot.
   */
  private ingressStopped = false;
  /**
   * Why polling exited, if it did. `whenReady()` throws this rather than the
   * deferred rejecting, so a failure with no waiter cannot become an unhandled
   * rejection.
   */
  private pollingFailure: Error | null = null;
  private ingressReplayTimer: ReturnType<typeof setTimeout> | null = null;
  private ingressReplayActive = false;

  private readonly logger = createLogger({ module: "surface:telegram" });

  private healthState: TelegramAdapterHealthSnapshot = {
    connectionState: "idle",
    isReady: false,
  };

  constructor(private readonly opts?: TelegramAdapterOptions) {}

  async connect(): Promise<void> {
    if (this.bot) return;

    this.healthState = { connectionState: "connecting", isReady: false };
    this.ready = createDeferred();

    const cfg = await this.resolveCoreConfig();
    this.cfg = cfg;
    this.store = new TelegramSurfaceStore(resolveTelegramDbPath(cfg));

    const bot = new Bot(
      resolveTelegramToken(cfg),
      this.opts?.apiRoot ? { client: { apiRoot: this.opts.apiRoot } } : {},
    );
    this.bot = bot;

    bot.catch((failure) => {
      const projected = projectTelegramBotFailure(failure);
      let message = projected.error.message;
      if (projected.error.kind === "grammy") message = `Bot API error: ${message}`;
      if (projected.error.kind === "http") message = `network error: ${message}`;
      const safeMessage = sanitizeTelegramErrorMessage(message, this.cfg?.surface.telegram.token);

      this.healthState = {
        ...this.healthState,
        lastErrorAt: Date.now(),
        lastError: safeMessage,
      };
      this.logger.error("telegram update handler failed", { updateId: projected.updateId });
    });

    this.registerHandlers(bot);

    await bot.init();
    this.me = bot.botInfo;
    this.self = {
      platform: "telegram",
      userId: String(bot.botInfo.id),
      userName: bot.botInfo.username,
    };

    // Drain anything a previous run committed but never published, before new
    // updates start arriving, so a backlog keeps its arrival order. Subscribers
    // are registered before connect(), so they are in place by now.
    const replayed = await Result.tryPromise({
      try: () => this.replayPendingIngress(),
      catch: (cause) => captureError(cause, "Telegram ingress replay failed"),
    });
    if (replayed.isErr()) {
      const error = projectTelegramError(replayed.error.cause, "Telegram ingress replay failed");
      this.logger.error("telegram ingress replay failed; entries are retained", {}, error.error);
    }

    if (cfg.surface.telegram.commandMenu) {
      const registered = await Result.tryPromise({
        try: () => this.registerCommandMenu(bot),
        catch: (cause) => captureError(cause, "Telegram command menu registration failed"),
      });
      if (registered.isErr()) {
        const error = projectTelegramError(
          registered.error.cause,
          "Telegram command menu registration failed",
        );
        this.logger.warn("failed to register telegram command menu", {}, error.error);
      }
    }

    this.stopping = false;
    this.pollingFailure = null;

    // bot.start() resolves only once polling stops, so it is intentionally not
    // awaited here; connect() must return as soon as the bot is live.
    //
    // grammY calls onStart *before* the first getUpdates, so "ready" is only a
    // claim that polling was launched. A fatal 401/409 rejects this promise
    // moments later, which is why the supervisor below is attached
    // immediately rather than left until disconnect(): otherwise the surface
    // keeps reporting ready while it is deaf, and the rejection sits unhandled.
    const polling = bot.start({
      allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
      onStart: (info) => {
        this.healthState = {
          connectionState: "ready",
          isReady: true,
          readyAt: Date.now(),
          botUsername: info.username,
        };
        this.logger.info("telegram surface ready", { botUsername: info.username });
        this.ready?.resolve();
      },
    });

    this.pollingStopped = this.supervisePolling(polling);
  }

  private async supervisePolling(polling: Promise<void>): Promise<void> {
    const settled = await Result.tryPromise({
      try: () => polling,
      catch: (cause) => captureError(cause, "Telegram long polling failed"),
    });
    if (settled.isErr()) {
      this.onPollingSettled(
        projectTelegramError(settled.error.cause, "Telegram long polling failed"),
      );
      return;
    }
    this.onPollingSettled(null);
  }

  /**
   * Records an unexpected end of long polling.
   *
   * Runs for both outcomes, because a resolved `start()` is just as wrong as a
   * rejected one while we still believe we are connected — either way no
   * further updates arrive.
   */
  private onPollingSettled(error: TelegramErrorProjection | null): void {
    if (this.stopping) return;

    const fatal = isFatalTelegramPollingExit(error);
    let failure: Error;
    if (error === null) failure = new Error("telegram long polling stopped unexpectedly");
    else failure = error.error;
    const safeFailure = new Error(
      sanitizeTelegramErrorMessage(failure.message, this.cfg?.surface.telegram.token),
    );

    this.pollingFailure = safeFailure;
    this.healthState = {
      ...this.healthState,
      connectionState: "failed",
      isReady: false,
      pollingExitedAt: Date.now(),
      pollingExitFatal: fatal,
      lastErrorAt: Date.now(),
      lastError: safeFailure.message,
    };

    this.logger.error(
      "telegram long polling exited; surface is no longer receiving updates",
      { fatal, willRecoverOnRestart: !fatal },
      safeFailure,
    );

    // Unblock anyone waiting on readiness; whenReady() surfaces the failure.
    this.ready?.resolve();
  }

  /**
   * Stops taking new updates while leaving the surface able to send.
   *
   * Graceful restart needs these separated. Long polling is the one ingress
   * that keeps pulling work in on its own, and grammY acks up to
   * `lastTriedUpdateId` when it stops — so an update still in flight during a
   * restart is one Telegram will never resend. It has to be quiesced before
   * the snapshot. But the output relay drains *after* that snapshot and needs
   * this adapter to deliver the replies, so a full `disconnect()` at that
   * point would strand them.
   *
   * Awaits the polling loop, so in-flight handlers finish and their outbox
   * entries commit before this resolves.
   */
  async stopIngress(): Promise<void> {
    const bot = this.bot;
    if (!bot || this.ingressStopped) return;

    this.ingressStopped = true;
    // Tell the supervisor this settlement is deliberate.
    this.stopping = true;
    const stopped = await Result.tryPromise({
      try: () => bot.stop(),
      catch: (cause) => captureError(cause, "Telegram bot stop failed"),
    });
    if (stopped.isErr()) projectTelegramError(stopped.error.cause, "Telegram bot stop failed");
    if (this.pollingStopped) {
      const settled = await Result.tryPromise({
        try: () => this.pollingStopped ?? Promise.resolve(),
        catch: (cause) => captureError(cause, "Telegram polling settlement failed"),
      });
      if (settled.isErr()) {
        projectTelegramError(settled.error.cause, "Telegram polling settlement failed");
      }
    }
    this.pollingStopped = null;

    this.healthState = { ...this.healthState, isReady: false };
    this.logger.info("telegram ingress stopped; output remains available", {
      pendingIngress: this.store?.countPendingIngress() ?? 0,
    });
  }

  async disconnect(): Promise<void> {
    const bot = this.bot;
    if (!bot) return;

    // Set before stopping so the supervisor treats the resulting settlement as
    // a deliberate shutdown rather than a failure.
    this.stopping = true;
    this.bot = null;
    if (!this.ingressStopped) {
      // Stopping aborts the in-flight getUpdates, which surfaces as a transport
      // error. That is the expected shape of a clean shutdown, not a failure.
      const stopped = await Result.tryPromise({
        try: () => bot.stop(),
        catch: (cause) => captureError(cause, "Telegram bot stop failed"),
      });
      if (stopped.isErr()) projectTelegramError(stopped.error.cause, "Telegram bot stop failed");
      // Let the polling loop unwind before tearing down the store it may touch.
      if (this.pollingStopped) {
        const settled = await Result.tryPromise({
          try: () => this.pollingStopped ?? Promise.resolve(),
          catch: (cause) => captureError(cause, "Telegram polling settlement failed"),
        });
        if (settled.isErr()) {
          projectTelegramError(settled.error.cause, "Telegram polling settlement failed");
        }
      }
    }
    this.pollingStopped = null;
    this.ingressStopped = false;
    this.cancelIngressReplay();

    this.ready = null;
    this.store?.close();
    this.store = null;
    this.healthState = {
      ...this.healthState,
      connectionState: "disconnected",
      isReady: false,
    };
  }

  /**
   * Resolves once long polling is actually running.
   *
   * `connect()` deliberately returns before this, because grammY's `start()`
   * only settles when polling stops. Callers that need the distinction — the
   * startup log line, and tests — await this instead of guessing.
   *
   * Throws if polling has already exited. Note the ordering caveat: grammY
   * fires `onStart` before the first `getUpdates`, so a call that lands in
   * that window returns successfully even though the very next poll will fail.
   * Readiness is therefore "polling was launched", and the health snapshot is
   * the authority on whether it is still running.
   */
  async whenReady(): Promise<void> {
    await this.ready?.promise;
    // Polling can die between launch and the first getUpdates, in which case
    // the deferred was resolved by the supervisor rather than by onStart.
    // Throwing here means startup fails loudly instead of proceeding deaf.
    if (this.pollingFailure) throw this.pollingFailure;
  }

  getHealthSnapshot(): TelegramAdapterHealthSnapshot {
    return { ...this.healthState };
  }

  async refreshCoreConfig(): Promise<TelegramConfigRefreshResult> {
    const next = await this.resolveCoreConfig();
    const current = this.cfg;
    if (!current || !this.bot) {
      this.cfg = next;
      return { restartRequiredFor: [] };
    }

    const restartRequiredFor = TELEGRAM_RESTART_REQUIRED_FIELDS.filter(
      (field) => next.surface.telegram[field] !== current.surface.telegram[field],
    );

    // Authorization and rendering settings are safe to reload immediately.
    // Connection-lifecycle settings remain pinned to the active bot/store so a
    // config edit cannot claim to rotate or disable a poller that is still live.
    this.cfg = {
      ...next,
      surface: {
        ...next.surface,
        telegram: {
          ...next.surface.telegram,
          enabled: current.surface.telegram.enabled,
          token: current.surface.telegram.token,
          apiRoot: current.surface.telegram.apiRoot,
          dbPath: current.surface.telegram.dbPath,
          commandMenu: current.surface.telegram.commandMenu,
        },
      },
    };

    return { restartRequiredFor };
  }

  async getSelf(): Promise<SurfaceSelf> {
    if (this.self) return this.self;
    throw new Error("telegram adapter: not connected");
  }

  async listSessions(): Promise<SurfaceOperationResult<SurfaceSession[]>> {
    return await captureTelegramOperation("list-sessions", async () =>
      this.mustStore()
        .listSessions()
        .map((row) => ({
          ref: telegramSessionRef({ chatId: row.chat_id, threadId: row.thread_id }),
          ...(row.title === null ? {} : { title: row.title }),
          kind: row.kind,
        })),
    );
  }

  async listSessionParticipants(
    sessionRef: SessionRef,
    _opts?: { limit?: number },
  ): Promise<SurfaceOperationResult<SurfaceSessionParticipantsResult>> {
    const ref = telegramSessionRefResult("list-session-participants", sessionRef);
    return ref.andThen(() =>
      Result.err(
        telegramUnsupported(
          "list-session-participants",
          "Telegram session participant listing is not supported",
        ),
      ),
    );
  }

  async startOutput(
    sessionRef: SessionRef,
    opts?: StartOutputOpts,
  ): Promise<SurfaceOperationResult<SurfaceOutputStream>> {
    const ref = telegramSessionRefResult("start-output", sessionRef);
    const replyTo = opts?.replyTo;
    const replyValidated = replyTo
      ? ref.andThen((session) =>
          telegramNestedMsgRefResult({
            operation: "start-output",
            sessionRef: session,
            msgRef: replyTo,
            refRole: "replyTo",
          }).map(() => session),
        )
      : ref;
    const validated = opts?.resumeAt
      ? replyValidated.andThen((session) =>
          telegramNestedMsgRefResult({
            operation: "start-output",
            sessionRef: session,
            msgRef: opts.resumeAt!,
            refRole: "resumeAt",
          }).map(() => session),
        )
      : replyValidated;
    const continueStart = validated.match<
      () => Promise<SurfaceOperationResult<SurfaceOutputStream>>
    >({
      err: (error) => async () => Result.err(error),
      ok: (telegramRef) => () =>
        captureTelegramOperation("start-output", async () => {
          const bot = this.mustBot();
          const cfg = this.cfg ?? (await this.resolveCoreConfig());
          const telegram = cfg.surface.telegram;
          const silent = opts?.silent === true || !telegram.outputNotification;
          const stream = new TelegramOutputStream({
            api: createGrammyOutputApi(bot),
            sessionRef: telegramRef,
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
            sessionRef: telegramRef,
            silent,
            onError: (error, context) => {
              this.logger.warn(
                "failed to deliver telegram attachments",
                { sessionId: telegramRef.channelId, ...context },
                error,
              );
            },
            onDelivered: (messages) => this.recordOwnOutput(telegramRef, messages),
            onUnreconciled: (failures) => {
              this.logger.warn("telegram surplus messages left in the chat", {
                sessionId: telegramRef.channelId,
                failures: failures.map((failure) => ({
                  messageId: failure.messageId,
                  outcome: failure.outcome,
                  reason: failure.reason,
                })),
              });
            },
          });
        }),
    });
    return await continueStart();
  }

  async prepareSendMsg(
    sessionRef: SessionRef,
    input: SurfaceSendPreparationInput,
    opts?: SendOpts,
  ): Promise<SurfaceOperationResult<void>> {
    return prepareTelegramSendResult(sessionRef, input, opts).map(() => undefined);
  }

  async sendMsg(
    sessionRef: SessionRef,
    content: ContentOpts,
    opts?: SendOpts,
  ): Promise<SurfaceOperationResult<MsgRef>> {
    const prepared = prepareTelegramSendResult(
      sessionRef,
      {
        text: content.text,
        attachmentCount: content.attachments?.length ?? 0,
        actionCount: content.actions?.length ?? 0,
      },
      opts,
    );
    const continueSend = prepared.match<() => Promise<SurfaceOperationResult<MsgRef>>>({
      err: (error) => async () => Result.err(error),
      ok: (telegramRef) => () =>
        captureTelegramOperation("send-message", async () => {
          const bot = this.mustBot();
          const text = content.text ?? "";
          const { chatId, threadId } = parseTelegramSessionId(telegramRef.channelId);
          const replyMarkup = buildTelegramActionKeyboard(content.actions);
          const renderedText = content.format === "markdown" ? markdownToTelegramHtml(text) : text;

          for (const action of content.actions ?? []) {
            if (Buffer.byteLength(action.actionId, "utf8") > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
              this.logger.warn("telegram action omitted because callback_data exceeds 64 bytes", {
                actionIdBytes: Buffer.byteLength(action.actionId, "utf8"),
                label: action.label,
              });
            }
          }

          const sent = await bot.api.sendMessage(chatId, renderedText, {
            ...(content.format === "markdown" ? { parse_mode: "HTML" as const } : {}),
            ...(threadId === undefined ? {} : { message_thread_id: threadId }),
            ...(opts?.silent ? { disable_notification: true } : {}),
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            ...(opts?.replyTo
              ? {
                  reply_parameters: {
                    message_id: parseTelegramMessageId(opts.replyTo.messageId),
                    allow_sending_without_reply: true,
                  },
                }
              : {}),
          });

          this.recordMessage(sent, { fromBot: true });
          return telegramMsgRef({ chatId, threadId, messageId: sent.message_id });
        }),
    });
    return await continueSend();
  }

  async readMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage | null>> {
    const ref = telegramMsgRefResult("read-message", msgRef);
    const continueRead = ref.match<() => Promise<SurfaceOperationResult<SurfaceMessage | null>>>({
      err: (error) => async () => Result.err(error),
      ok: (telegramRef) => () =>
        captureTelegramOperation("read-message", async () => {
          const record = this.mustStore().getMessage({
            sessionId: telegramRef.channelId,
            messageId: telegramRef.messageId,
          });
          if (!record) return null;
          return {
            ref: telegramRef,
            session: { platform: "telegram", channelId: telegramRef.channelId },
            userId: record.userId,
            ...(record.userName === undefined ? {} : { userName: record.userName }),
            text: record.text,
            ts: record.ts,
            ...(record.editedTs === undefined ? {} : { editedTs: record.editedTs }),
            ...(record.raw === undefined ? {} : { raw: record.raw }),
          };
        }),
    });
    return await continueRead();
  }

  async listMsg(
    sessionRef: SessionRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const ref = telegramSessionRefResult("list-messages", sessionRef);
    const continueList = ref.match<() => Promise<SurfaceOperationResult<SurfaceMessage[]>>>({
      err: (error) => async () => Result.err(error),
      ok: (telegramRef) => () =>
        captureTelegramOperation("list-messages", async () =>
          this.mustStore()
            .listMessages({
              sessionId: telegramRef.channelId,
              ...(opts?.limit === undefined ? {} : { limit: opts.limit }),
              ...(opts?.beforeMessageId === undefined
                ? {}
                : { beforeMessageId: opts.beforeMessageId }),
              ...(opts?.afterMessageId === undefined
                ? {}
                : { afterMessageId: opts.afterMessageId }),
            })
            .map((record) => ({
              ref: telegramMsgRef({
                chatId: record.chatId,
                threadId: record.threadId,
                messageId: record.messageId,
              }),
              session: telegramRef,
              userId: record.userId,
              ...(record.userName === undefined ? {} : { userName: record.userName }),
              text: record.text,
              ts: record.ts,
              ...(record.editedTs === undefined ? {} : { editedTs: record.editedTs }),
              ...(record.raw === undefined ? {} : { raw: record.raw }),
            })),
        ),
    });
    return await continueList();
  }

  async editMsg(msgRef: MsgRef, content: ContentOpts): Promise<SurfaceOperationResult<void>> {
    const ref = telegramMsgRefResult("edit-message", msgRef);
    const text = content.text ?? "";
    if (!text.trim()) {
      return Result.err(
        telegramInvalidInput(
          "edit-message",
          "content.text",
          "Telegram edits require non-empty text",
        ),
      );
    }

    const continueEdit = ref.match<() => Promise<SurfaceOperationResult<void>>>({
      err: (error) => async () => Result.err(error),
      ok: (telegramRef) => async () => {
        const edited = await captureTelegramOperation("edit-message", async () => {
          const bot = this.mustBot();
          const replyMarkup = buildTelegramActionKeyboard(content.actions);
          const renderedText = content.format === "markdown" ? markdownToTelegramHtml(text) : text;
          try {
            const message = await bot.api.editMessageText(
              chatIdOf(telegramRef),
              parseTelegramMessageId(telegramRef.messageId),
              renderedText,
              {
                ...(content.format === "markdown" ? { parse_mode: "HTML" as const } : {}),
                ...(content.actions === undefined ? {} : { reply_markup: replyMarkup }),
              },
            );
            if (message !== true) this.recordMessage(message, { fromBot: true });
          } catch (cause) {
            if (
              isTelegramMessageNotModified(
                projectTelegramError(cause, "Telegram message edit failed"),
              )
            ) {
              return;
            }
            throw cause;
          }
        });
        edited.match({
          ok: () => undefined,
          err: (error) => {
            if (error._tag === "SurfaceMessageNotFound" && isTelegramMessageAbsent(error)) {
              this.store?.markDeleted({
                sessionId: telegramRef.channelId,
                messageId: telegramRef.messageId,
              });
            }
          },
        });
        return edited;
      },
    });
    return await continueEdit();
  }

  async deleteMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<void>> {
    const ref = telegramMsgRefResult("delete-message", msgRef);
    const continueDelete = ref.match<() => Promise<SurfaceOperationResult<void>>>({
      err: (error) => async () => Result.err(error),
      ok: (telegramRef) => async () => {
        const deleted = await captureTelegramOperation("delete-message", async () => {
          await this.mustBot().api.deleteMessage(
            chatIdOf(telegramRef),
            parseTelegramMessageId(telegramRef.messageId),
          );
        });
        deleted.match({
          ok: () =>
            this.store?.markDeleted({
              sessionId: telegramRef.channelId,
              messageId: telegramRef.messageId,
            }),
          err: (error) => {
            if (error._tag === "SurfaceMessageNotFound" && isTelegramMessageAbsent(error)) {
              this.store?.markDeleted({
                sessionId: telegramRef.channelId,
                messageId: telegramRef.messageId,
              });
            }
          },
        });
        return deleted;
      },
    });
    return await continueDelete();
  }

  async getReplyContext(
    msgRef: MsgRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const ref = telegramMsgRefResult("get-reply-context", msgRef);
    const continueContext = ref.match<() => Promise<SurfaceOperationResult<SurfaceMessage[]>>>({
      err: (error) => async () => Result.err(error),
      ok: (telegramRef) => () =>
        this.listMsg({ platform: "telegram", channelId: telegramRef.channelId }, opts),
    });
    return await continueContext();
  }

  async planReplyChain(
    msgRef: MsgRef,
    _opts?: SurfaceReplyChainPlanOptions,
  ): Promise<SurfaceOperationResult<readonly MsgRef[]>> {
    const ref = telegramMsgRefResult("plan-reply-chain", msgRef);
    return ref.andThen(() =>
      Result.err(
        telegramUnsupported("plan-reply-chain", "Telegram reply-chain planning is not supported"),
      ),
    );
  }

  async planMergeBlockEndingAt(
    msgRef: MsgRef,
    _opts?: SurfaceMergeBlockPlanOptions,
  ): Promise<SurfaceOperationResult<readonly MsgRef[]>> {
    const ref = telegramMsgRefResult("plan-merge-block", msgRef);
    return ref.andThen(() =>
      Result.err(
        telegramUnsupported("plan-merge-block", "Telegram merge-block planning is not supported"),
      ),
    );
  }

  async addReaction(msgRef: MsgRef, reaction: string): Promise<SurfaceOperationResult<void>> {
    const ref = telegramMsgRefResult("add-reaction", msgRef);
    const continueAdd = ref.match<() => Promise<SurfaceOperationResult<void>>>({
      err: (error) => async () => Result.err(error),
      ok: (telegramRef) => () =>
        captureTelegramOperation("add-reaction", async () => {
          await this.mustBot().api.setMessageReaction(
            chatIdOf(telegramRef),
            parseTelegramMessageId(telegramRef.messageId),
            [{ type: "emoji", emoji: toTelegramEmojiReaction(reaction) }],
          );
        }),
    });
    return await continueAdd();
  }

  async removeReaction(msgRef: MsgRef, _reaction: string): Promise<SurfaceOperationResult<void>> {
    const ref = telegramMsgRefResult("remove-reaction", msgRef);
    const continueRemove = ref.match<() => Promise<SurfaceOperationResult<void>>>({
      err: (error) => async () => Result.err(error),
      ok: (telegramRef) => () =>
        captureTelegramOperation("remove-reaction", async () => {
          await this.mustBot().api.setMessageReaction(
            chatIdOf(telegramRef),
            parseTelegramMessageId(telegramRef.messageId),
            [],
          );
        }),
    });
    return await continueRemove();
  }

  async listReactions(msgRef: MsgRef): Promise<SurfaceOperationResult<string[]>> {
    return telegramMsgRefResult("list-reactions", msgRef).map(() => []);
  }

  async listReactionDetails(
    msgRef: MsgRef,
  ): Promise<SurfaceOperationResult<SurfaceReactionDetail[]>> {
    const ref = telegramMsgRefResult("list-reaction-details", msgRef);
    return ref.andThen(() =>
      Result.err(
        telegramUnsupported(
          "list-reaction-details",
          "Telegram reaction detail listing is not supported",
        ),
      ),
    );
  }

  async startTyping(
    sessionRef: SessionRef,
  ): Promise<SurfaceOperationResult<TypingIndicatorSubscription>> {
    const ref = telegramSessionRefResult("start-typing", sessionRef);
    const continueTyping = ref.match<
      () => Promise<SurfaceOperationResult<TypingIndicatorSubscription>>
    >({
      err: (error) => async () => Result.err(error),
      ok: (telegramRef) => () =>
        captureTelegramOperation("start-typing", async () => {
          const bot = this.mustBot();
          const { chatId, threadId } = parseTelegramSessionId(telegramRef.channelId);
          let stopped = false;
          const send = async () => {
            if (stopped) return;
            const attempted = await Result.tryPromise({
              try: () =>
                bot.api.sendChatAction(
                  chatId,
                  "typing",
                  threadId === undefined ? {} : { message_thread_id: threadId },
                ),
              catch: (cause) => captureError(cause, "Telegram typing heartbeat failed"),
            });
            if (attempted.isErr()) {
              projectTelegramError(attempted.error.cause, "Telegram typing heartbeat failed");
            }
          };
          void send();
          const timer = setInterval(send, 4_500);
          return {
            stop: async () => {
              stopped = true;
              clearInterval(timer);
              return Result.ok(undefined);
            },
          };
        }),
    });
    return await continueTyping();
  }

  async subscribe(handler: AdapterEventHandler): Promise<AdapterSubscription> {
    this.handlers.add(handler);
    return {
      stop: async () => {
        this.handlers.delete(handler);
      },
    };
  }

  async getUnRead(sessionRef: SessionRef): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const ref = telegramSessionRefResult("get-unread", sessionRef);
    const continueUnread = ref.match<() => Promise<SurfaceOperationResult<SurfaceMessage[]>>>({
      err: (error) => async () => Result.err(error),
      ok: (telegramRef) => () =>
        captureTelegramOperation("get-unread", async () =>
          this.mustStore()
            .listUnread({ sessionId: telegramRef.channelId })
            .map((record) => ({
              ref: telegramMsgRef({
                chatId: record.chatId,
                threadId: record.threadId,
                messageId: record.messageId,
              }),
              session: telegramRef,
              userId: record.userId,
              ...(record.userName === undefined ? {} : { userName: record.userName }),
              text: record.text,
              ts: record.ts,
            })),
        ),
    });
    return await continueUnread();
  }

  async markRead(
    sessionRef: SessionRef,
    upToMsgRef?: MsgRef,
  ): Promise<SurfaceOperationResult<void>> {
    const ref = telegramSessionRefResult("mark-read", sessionRef);
    const validated = upToMsgRef
      ? ref.andThen((session) =>
          telegramNestedMsgRefResult({
            operation: "mark-read",
            sessionRef: session,
            msgRef: upToMsgRef,
            refRole: "upToMsgRef",
          }).map(() => session),
        )
      : ref;
    const continueMark = validated.match<() => Promise<SurfaceOperationResult<void>>>({
      err: (error) => async () => Result.err(error),
      ok: (telegramRef) => () =>
        captureTelegramOperation("mark-read", async () => {
          const store = this.mustStore();
          const latest = upToMsgRef
            ? store.getMessage({
                sessionId: telegramRef.channelId,
                messageId: upToMsgRef.messageId,
              })
            : store.listMessages({ sessionId: telegramRef.channelId, limit: 1 })[0];
          if (!latest) return;
          store.markRead({
            sessionId: telegramRef.channelId,
            messageId: latest.messageId,
            ts: latest.ts,
          });
        }),
    });
    return await continueMark();
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

      const indexed = this.store?.getMessageByChatMessage({
        chatId: String(update.chat.id),
        messageId: String(update.message_id),
      });
      const sessionId = indexed?.sessionId ?? formatTelegramSessionId({ chatId: update.chat.id });
      const session = telegramSessionRef({
        chatId: update.chat.id,
        ...(indexed?.threadId === undefined ? {} : { threadId: Number(indexed.threadId) }),
      });
      const messageRef = telegramMsgRef({
        chatId: update.chat.id,
        ...(indexed?.threadId === undefined ? {} : { threadId: Number(indexed.threadId) }),
        messageId: update.message_id,
      });

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

      const threadId = topicIdOfCallbackMessage(message);

      // The cancel button rides the same callback_query channel as ordinary
      // actions, but the runtime cancels through a distinct event.
      if (cancelRequestId) {
        const delivered = await this.emit({
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
        const acknowledged = await Result.tryPromise({
          try: () =>
            ctx.answerCallbackQuery({
              text: delivered.ok ? "Cancelling…" : "Cancel could not be delivered. Try again.",
              show_alert: !delivered.ok,
            }),
          catch: (cause) => captureError(cause, "Telegram callback acknowledgement failed"),
        });
        if (acknowledged.isErr()) {
          projectTelegramError(
            acknowledged.error.cause,
            "Telegram callback acknowledgement failed",
          );
        }
        return;
      }

      const delivered = await this.emit({
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
      const acknowledged = await Result.tryPromise({
        try: () =>
          ctx.answerCallbackQuery(
            delivered.ok
              ? {}
              : { text: "Action could not be delivered. Try again.", show_alert: true },
          ),
        catch: (cause) => captureError(cause, "Telegram callback acknowledgement failed"),
      });
      if (acknowledged.isErr()) {
        projectTelegramError(acknowledged.error.cause, "Telegram callback acknowledgement failed");
      }
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

    let kind: SurfaceSession["kind"];
    if (message.chat.type === "private") kind = "dm";
    else if (threadId === undefined) kind = "channel";
    else kind = "thread";

    store.upsertSession({
      sessionId,
      chatId: String(message.chat.id),
      ...(threadId === undefined ? {} : { threadId: String(threadId) }),
      ...(chatTitleOf(message) === undefined ? {} : { title: chatTitleOf(message) }),
      kind,
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
      rawJson: JSON.stringify(
        toTelegramRawEnvelope({
          message,
          ...(this.me?.username === undefined ? {} : { botUsername: this.me.username }),
          ...(this.me?.id === undefined ? {} : { botUserId: this.me.id }),
        }),
      ),
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

  /**
   * Delivers an event to subscribers, committing it durably first.
   *
   * The commit is not optional bookkeeping. grammY advances its poll offset
   * before invoking the update handler, so by the time a publish fails
   * Telegram already considers the update delivered and will never resend it.
   * Rethrowing here would change nothing; only a record that outlives the
   * handler can.
   *
   * Interactive events (cancel, button presses) are deliberately not queued —
   * see `telegramIngressDedupeKey`.
   */
  private async emit(evt: AdapterEvent): Promise<TelegramIngressDeliveryResult> {
    const dedupeKey = telegramIngressDedupeKey(evt);

    if (dedupeKey !== null) {
      const fresh = this.store?.enqueueIngress({
        dedupeKey,
        payloadJson: JSON.stringify(evt),
        ts: Date.now(),
      });
      // Already queued means this is a redelivery of something the replayer
      // owns; publishing again here would duplicate it.
      if (fresh === false) {
        this.logger.debug("telegram ingress already queued; leaving it to replay", { dedupeKey });
        return {
          ok: false,
          error: "telegram ingress already queued",
          cause: new Error("telegram ingress already queued"),
        };
      }
    }

    const delivered = await this.deliver(evt);

    if (dedupeKey === null) return delivered;
    if (delivered.ok) {
      this.store?.deleteIngress(dedupeKey);
      return delivered;
    }

    this.store?.recordIngressFailure({
      dedupeKey,
      error: delivered.error,
      ts: Date.now(),
    });
    this.logger.error(
      "telegram ingress publish failed; retained for replay",
      { dedupeKey, type: evt.type },
      delivered.cause,
    );
    this.scheduleIngressReplay();
    return delivered;
  }

  /**
   * Fans an event out to subscribers.
   *
   * A subscriber throwing is reported rather than swallowed, because
   * `bridgeAdapterToBus` rethrows precisely when the bus rejected the publish
   * — the one signal that says the event has not been accepted anywhere.
   */
  private async deliver(evt: AdapterEvent): Promise<TelegramIngressDeliveryResult> {
    // No subscribers means the event reached nothing. Reporting success here
    // would delete it from the outbox, which is the exact loss the outbox
    // exists to prevent.
    if (this.handlers.size === 0) {
      const error = "no adapter subscribers";
      return { ok: false, error, cause: new Error(error) };
    }

    let failure: { error: string; cause: Error } | null = null;

    for (const handler of this.handlers) {
      const delivered = await Result.tryPromise({
        try: async () => await handler(evt),
        catch: (cause) => captureError(cause, "Telegram adapter handler failed"),
      });
      if (delivered.isErr()) {
        const error = projectTelegramError(
          delivered.error.cause,
          "Telegram adapter handler failed",
        );
        this.logger.error("telegram adapter handler failed", { type: evt.type }, error.error);
        // Keep the first failure: later handlers may succeed, but the event
        // is only safe to forget once every subscriber has taken it.
        failure ??= { error: error.message, cause: error.error };
      }
    }

    return failure === null ? { ok: true } : { ok: false, ...failure };
  }

  /**
   * Republishes everything the outbox still holds.
   *
   * Called after the bus subscriptions exist but before polling starts, so a
   * backlog from a previous run is drained in arrival order ahead of anything
   * new. Entries survive a failed replay and are tried again next time.
   */
  async replayPendingIngress(): Promise<{ replayed: number; failed: number }> {
    const store = this.store;
    if (!store) return { replayed: 0, failed: 0 };

    const pending = store.listPendingIngress();
    if (pending.length === 0) return { replayed: 0, failed: 0 };

    this.logger.info("replaying telegram ingress backlog", { count: pending.length });

    let replayed = 0;
    let failed = 0;

    for (const entry of pending) {
      const evt = entry.event;
      if (!evt) {
        // Unparseable payloads can never succeed; keeping them would block the
        // queue behind a permanent failure.
        this.logger.error("dropping unreadable telegram ingress entry", {
          dedupeKey: entry.dedupeKey,
          attempts: entry.attempts,
        });
        store.deleteIngress(entry.dedupeKey);
        failed += 1;
        continue;
      }

      const delivered = await this.deliver(evt);
      if (delivered.ok) {
        store.deleteIngress(entry.dedupeKey);
        replayed += 1;
        continue;
      }

      failed += 1;
      store.recordIngressFailure({
        dedupeKey: entry.dedupeKey,
        error: delivered.error,
        ts: Date.now(),
      });
    }

    if (failed > 0 && store.countPendingIngress() > 0) this.scheduleIngressReplay();

    this.logger.info("telegram ingress replay finished", {
      replayed,
      failed,
      stillPending: store.countPendingIngress(),
    });

    return { replayed, failed };
  }

  private scheduleIngressReplay(delayMs = 1_000): void {
    if (this.ingressReplayTimer || this.ingressStopped || this.bot === null) return;
    this.ingressReplayTimer = setTimeout(() => {
      this.ingressReplayTimer = null;
      void this.replayPendingIngressInProcess();
    }, delayMs);
  }

  private cancelIngressReplay(): void {
    if (!this.ingressReplayTimer) return;
    clearTimeout(this.ingressReplayTimer);
    this.ingressReplayTimer = null;
  }

  private async replayPendingIngressInProcess(): Promise<void> {
    if (this.ingressReplayActive || this.ingressStopped || this.bot === null) return;
    this.ingressReplayActive = true;
    const replayed = await Result.tryPromise({
      try: () => this.replayPendingIngress(),
      catch: (cause) => captureError(cause, "Telegram ingress replay attempt failed"),
    });
    if (replayed.isErr()) {
      const error = projectTelegramError(
        replayed.error.cause,
        "Telegram ingress replay attempt failed",
      );
      this.logger.error("telegram ingress replay attempt failed", {}, error.error);
      if ((this.store?.countPendingIngress() ?? 0) > 0) this.scheduleIngressReplay(5_000);
      this.ingressReplayActive = false;
      return;
    }
    if (replayed.value.failed > 0 && (this.store?.countPendingIngress() ?? 0) > 0) {
      this.scheduleIngressReplay(Math.min(30_000, 1_000 * (replayed.value.failed + 1)));
    }
    this.ingressReplayActive = false;
  }

  /**
   * Publishes the bot command menu.
   *
   * Deliberately empty for now. The menu previously advertised `/help`,
   * `/cancel` and `/new`, none of which had a handler: `/cancel` was routed as
   * ordinary conversation rather than cancelling anything. Advertising
   * behaviour that does not exist is worse than advertising nothing.
   *
   * The executable custom commands cannot be listed yet either: their text
   * name is `lilac:<name>`, and Telegram restricts command names to
   * `[a-z0-9_]{1,32}`, so exposing them needs a naming scheme the shared
   * router also understands. Tracked separately.
   */
  private async registerCommandMenu(bot: Bot): Promise<void> {
    const entries = this.opts?.customCommands?.listMenuEntries() ?? [];

    if (entries.length > TELEGRAM_MAX_MENU_COMMANDS) {
      this.logger.warn("too many custom commands for the telegram menu; extras are omitted", {
        discovered: entries.length,
        registered: TELEGRAM_MAX_MENU_COMMANDS,
        omitted: entries
          .slice(TELEGRAM_MAX_MENU_COMMANDS)
          .map((entry) => `/${entry.command}`)
          .join(", "),
      });
    }

    const registered = entries.slice(0, TELEGRAM_MAX_MENU_COMMANDS);
    await bot.api.setMyCommands([...registered]);
    this.logger.info("telegram command menu registered", {
      count: registered.length,
      commands: registered.map((entry) => `/${entry.command}`),
    });
  }

  private async resolveCoreConfig(): Promise<CoreConfig> {
    return this.opts?.getConfig ? await this.opts.getConfig() : await getCoreConfig();
  }

  private mustBot(): Bot {
    const bot = this.bot;
    if (!bot) throw new TelegramAdapterUnavailable();
    return bot;
  }

  private mustStore(): TelegramSurfaceStore {
    const store = this.store;
    if (!store) throw new TelegramAdapterUnavailable();
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

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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
