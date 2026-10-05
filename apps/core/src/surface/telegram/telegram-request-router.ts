import {
  lilacEventTypes,
  type DeliveryDisposition,
  type EventDeliveryDoneError,
  type EventDeliveryStopFailed,
  type EvtAdapterMessageCreatedData,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import {
  createLogger,
  extractAiErrorLogDetails,
  getCoreConfig,
  parseCoreConfigResult,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import type { Logger } from "@stanley2058/simple-module-logger";
import {
  Panic,
  Result,
  TaggedError,
  type AnyTaggedError,
  type Result as ResultType,
} from "better-result";

import type { CustomCommandManager } from "../../custom-commands/manager";
import { captureError } from "../../shared/error-capture";
import type { SurfaceAdapter } from "../adapter";
import type { TelegramMsgRef } from "../types";
import { formatBridgeLogContext, formatBridgeTaggedErrorForLog } from "../bridge/bridge-log";
import {
  formatGenericRequestId,
  formatQueuedRequestId,
  formatTelegramMessageRequestId,
} from "../bridge/request-ids";
import {
  getSessionMode,
  normalizeGateText,
  parseLeadingContinueDirective,
  parseLeadingModelOverride,
  parseSteerDirectiveMode,
  resolveSessionConfigId,
  resolveSessionGateEnabled,
  resolveSessionModelOverride,
  shouldRunDirectReplyMentionGate,
  stripLeadingContinueDirective,
  stripLeadingInterruptDirective,
  stripLeadingModelOverrideDirective,
  type SessionMode,
} from "../discord/discord-request-router/common";
import {
  resolvePreviousBatchMessageText,
  resolvePreviousMessageText,
} from "../discord/discord-request-router/context";
import { decideActiveRequestRoute } from "../discord/discord-request-router/decisions";
import {
  shouldForwardByGate,
  type BufferedMessage,
  type RouterGateDecision,
  type RouterGateInput,
} from "../discord/discord-request-router/gate";
import { resolveTelegramBotMentionNames } from "./telegram-raw";
import {
  commandMetadata,
  composeTelegramMessages,
  messageRef,
  readMessage,
  telegramFlags,
} from "./telegram-request-router-composition";
import {
  publishTelegramOutputReanchor,
  publishTelegramRequest,
  type TelegramRequestPublishFailed,
  type TelegramRequestRawExtra,
  type TelegramTriggerType,
} from "./telegram-request-router-publish";

export type { RouterGateDecision, RouterGateInput };

/**
 * Telegram request router.
 *
 * Mirrors the shape of the upstream Discord router so the two surfaces route
 * the same way: a lifecycle subscription tracks the active request per
 * session, a surface subscription tracks the bot's output messages for that
 * request, and the adapter subscription turns inbound messages into
 * `cmd.request.message` commands. Decisions (gate, debounce, steer, interrupt,
 * follow-up, pending mention replies) reuse the shared helpers; only message
 * composition is Telegram-specific, because history comes from the local
 * index rather than the platform.
 */

type TelegramRouterConfig = Record<string, unknown>;

export class TelegramRequestRoutingFailed extends TaggedError("TelegramRequestRoutingFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

/**
 * A subscription failed to start and at least one already-running
 * subscription refused to stop during rollback. `residual` carries the live
 * handles so the host can still stop or supervise them.
 */
export class TelegramRequestRouterStartFailed extends TaggedError(
  "TelegramRequestRouterStartFailed",
)<{
  readonly cause: AnyTaggedError;
  readonly rollbackFailures: readonly EventDeliveryStopFailed[];
  readonly residual: readonly RouterSubscription[];
  readonly message: string;
}> {}

export type TelegramRequestRouter = {
  readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
  stop(): Promise<void>;
};

export type StartTelegramRequestRouterInput = {
  readonly adapter: SurfaceAdapter;
  readonly bus: LilacBus;
  readonly blobStore: BlobStore;
  readonly subscriptionId: string;
  readonly customCommands?: CustomCommandManager;
  readonly config?: TelegramRouterConfig;
  readonly logger?: Logger;
  /** Test seam; production uses the shared LLM router gate. */
  readonly routerGate?: (input: RouterGateInput) => Promise<RouterGateDecision>;
  readonly shouldSuppressAdapterEvent?: (input: {
    readonly evt: EvtAdapterMessageCreatedData;
  }) => Promise<{ readonly suppress: boolean; readonly reason?: string }>;
};

type ActiveSessionState = {
  requestId: string;
  /** Ids of the bot's output messages in the active request's current chain. */
  readonly activeOutputMessageIds: Set<string>;
};

type TelegramBufferedMessage = BufferedMessage & { readonly event: EvtAdapterMessageCreatedData };

type DebounceBuffer = {
  readonly sessionId: string;
  readonly sessionConfigId: string;
  readonly parentChannelId?: string;
  readonly messages: TelegramBufferedMessage[];
  timer: ReturnType<typeof setTimeout> | null;
};

type PendingMentionReplyItem = {
  readonly event: EvtAdapterMessageCreatedData;
  readonly requestModelOverride?: string;
  readonly continueCount?: number;
  readonly botNames: readonly string[];
};

type PendingMentionReplyBatch = {
  readonly sourceRequestId: string;
  readonly sessionConfigId: string;
  readonly parentChannelId?: string;
  readonly sessionMode: SessionMode;
  readonly modelOverride?: string;
  readonly items: PendingMentionReplyItem[];
};

type RouterState = {
  readonly activeBySession: Map<string, ActiveSessionState>;
  readonly buffers: Map<string, DebounceBuffer>;
  /** Keyed by `pendingReplyKey`, so batches of different requests never collide. */
  readonly pendingMentionRepliesByRequest: Map<string, PendingMentionReplyBatch>;
};

type RouterContext = {
  readonly adapter: SurfaceAdapter;
  readonly bus: LilacBus;
  readonly blobStore: BlobStore;
  readonly logger: Logger;
  readonly customCommands?: CustomCommandManager;
  readonly state: RouterState;
  currentConfig(): Promise<CoreConfig>;
  evaluateGate(cfg: CoreConfig, input: RouterGateInput): Promise<RouterGateDecision>;
  scheduleDebounceFlush(sessionId: string, delayMs: number): ReturnType<typeof setTimeout>;
};

type RoutingFailure = TelegramRequestPublishFailed;
type RoutingResult = Promise<ResultType<void, RoutingFailure>>;

/** Everything the dispatch derives from one inbound message before deciding. */
type RoutedMessage = {
  readonly cfg: CoreConfig;
  readonly event: EvtAdapterMessageCreatedData;
  readonly sessionId: string;
  readonly msgRef: TelegramMsgRef;
  readonly isDm: boolean;
  readonly mentionsBot: boolean;
  readonly replyToBot: boolean;
  readonly replyToMessageId?: string;
  readonly parentChannelId?: string;
  readonly botUserId: string;
  readonly botNames: readonly string[];
  readonly requestModelOverride?: string;
  readonly continueCount?: number;
  readonly modelOverride?: string;
  readonly sessionConfigId: string;
  readonly mode: SessionMode;
  readonly gateEnabled: boolean;
  readonly active: ActiveSessionState | undefined;
};

type TextTransform = (text: string) => string;

function configFromOverride(config: TelegramRouterConfig): CoreConfig {
  return parseCoreConfigResult(config).match({
    ok: (value) => value,
    err: (error) => {
      throw error;
    },
  });
}

function deliveryPolicy(_error: TelegramRequestRoutingFailed): DeliveryDisposition {
  return "park-pending";
}

function combineTextTransforms(
  ...transforms: Array<TextTransform | undefined>
): TextTransform | undefined {
  const active = transforms.filter(
    (transform): transform is TextTransform => typeof transform === "function",
  );
  if (active.length === 0) return undefined;
  return (text) => active.reduce((acc, transform) => transform(acc), text);
}

/** Strips the directives this message carried so the model never sees them. */
function directiveTransform(input: {
  readonly botNames: readonly string[];
  readonly requestModelOverride?: string;
  readonly continueCount?: number;
  readonly interrupt?: boolean;
}): TextTransform | undefined {
  const { botNames } = input;
  return combineTextTransforms(
    input.requestModelOverride
      ? (text) => stripLeadingModelOverrideDirective({ text, botNames })
      : undefined,
    input.continueCount === undefined
      ? undefined
      : (text) => stripLeadingContinueDirective({ text, botNames }),
    input.interrupt ? (text) => stripLeadingInterruptDirective({ text, botNames }) : undefined,
  );
}

function triggerTypeOf(input: {
  readonly replyToBot: boolean;
  readonly mentionsBot: boolean;
}): TelegramTriggerType {
  if (input.replyToBot) return "reply";
  if (input.mentionsBot) return "mention";
  return "active";
}

function logRouteDecision(
  ctx: RouterContext,
  routed: RoutedMessage,
  input: {
    readonly decision:
      | "forward"
      | "skip"
      | "queue_followup"
      | "queue_prompt"
      | "steer"
      | "interrupt"
      | "buffer";
    readonly reason: string;
  },
): void {
  ctx.logger.info(
    "router.route.decision",
    formatBridgeLogContext({
      sessionId: routed.sessionId,
      messageId: routed.msgRef.messageId,
      userId: routed.event.userId,
      mode: routed.mode,
      gateEnabled: routed.gateEnabled,
      decision: input.decision,
      reason: input.reason,
      activeRequestId: routed.active?.requestId,
      sessionConfigId: routed.sessionConfigId,
      modelOverride: routed.modelOverride,
      requestModelOverride: routed.requestModelOverride,
      continueCount: routed.continueCount,
    }),
  );
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

function markActive(ctx: RouterContext, sessionId: string, requestId: string): void {
  ctx.state.activeBySession.set(sessionId, { requestId, activeOutputMessageIds: new Set() });
}

async function publishPrompt(
  ctx: RouterContext,
  routed: RoutedMessage,
  input: {
    readonly requestId: string;
    readonly triggerType: TelegramTriggerType;
    readonly includeReplyChain: boolean;
    readonly modelOverride?: string;
    readonly transform?: TextTransform;
    readonly markActive: boolean;
    readonly raw?: TelegramRequestRawExtra;
  },
): RoutingResult {
  const composed = await composeTelegramMessages({
    adapter: ctx.adapter,
    event: routed.event,
    includeReplyChain: input.includeReplyChain,
    botUserId: routed.botUserId,
    botNames: routed.botNames,
    blobStore: ctx.blobStore,
    inboundMedia: routed.cfg.surface.telegram.inboundMedia,
    transformUserText: input.transform,
  });
  const published = await publishTelegramRequest({
    bus: ctx.bus,
    logger: ctx.logger,
    requestId: input.requestId,
    sessionId: routed.sessionId,
    sessionConfigId: routed.sessionConfigId,
    parentChannelId: routed.parentChannelId,
    queue: "prompt",
    triggerType: input.triggerType,
    sessionMode: routed.mode,
    modelOverride: input.modelOverride ?? routed.modelOverride,
    composed,
    origin: { userId: routed.event.userId, messageRef: routed.msgRef },
    raw: input.raw,
  });
  return published.map(() => {
    if (input.markActive) markActive(ctx, routed.sessionId, input.requestId);
  });
}

async function publishToActiveRequest(
  ctx: RouterContext,
  routed: RoutedMessage,
  input: {
    readonly active: ActiveSessionState;
    readonly queue: "followUp" | "steer" | "interrupt";
    readonly transform?: TextTransform;
  },
): RoutingResult {
  const composed = await composeTelegramMessages({
    adapter: ctx.adapter,
    event: routed.event,
    includeReplyChain: false,
    botUserId: routed.botUserId,
    botNames: routed.botNames,
    blobStore: ctx.blobStore,
    inboundMedia: routed.cfg.surface.telegram.inboundMedia,
    transformUserText: input.transform,
  });
  return publishTelegramRequest({
    bus: ctx.bus,
    logger: ctx.logger,
    requestId: input.active.requestId,
    sessionId: routed.sessionId,
    sessionConfigId: routed.sessionConfigId,
    parentChannelId: routed.parentChannelId,
    queue: input.queue,
    triggerType: "active",
    sessionMode: routed.mode,
    modelOverride: routed.modelOverride,
    composed,
    origin: { userId: routed.event.userId, messageRef: routed.msgRef },
  });
}

async function steerActiveRequest(
  ctx: RouterContext,
  routed: RoutedMessage,
  input: {
    readonly active: ActiveSessionState;
    readonly queue: "steer" | "interrupt";
    readonly inheritReplyTo: boolean;
  },
): RoutingResult {
  const reanchored = await publishTelegramOutputReanchor({
    bus: ctx.bus,
    logger: ctx.logger,
    requestId: input.active.requestId,
    sessionId: routed.sessionId,
    inheritReplyTo: input.inheritReplyTo,
    ...(input.inheritReplyTo ? {} : { replyTo: routed.msgRef }),
    mode: input.queue,
  });
  const continueSteer = reanchored.match<() => RoutingResult>({
    err: (error) => async () => Result.err(error),
    ok: () => () => {
      input.active.activeOutputMessageIds.clear();
      logRouteDecision(ctx, routed, { decision: input.queue, reason: "reply_to_active_output" });
      return publishToActiveRequest(ctx, routed, {
        active: input.active,
        queue: input.queue,
        transform: directiveTransform({
          botNames: routed.botNames,
          requestModelOverride: routed.requestModelOverride,
          continueCount: routed.continueCount,
          interrupt: input.queue === "interrupt",
        }),
      });
    },
  });
  return continueSteer();
}

// ---------------------------------------------------------------------------
// Active mode
// ---------------------------------------------------------------------------

async function routeWhileActive(
  ctx: RouterContext,
  routed: RoutedMessage,
  active: ActiveSessionState,
): RoutingResult {
  const transform = directiveTransform({
    botNames: routed.botNames,
    requestModelOverride: routed.requestModelOverride,
    continueCount: routed.continueCount,
  });

  // A per-request model override cannot join the running request; it starts
  // its own, which the runner queues behind the active one.
  if (routed.requestModelOverride) {
    logRouteDecision(ctx, routed, { decision: "queue_prompt", reason: "request_model_override" });
    return publishPrompt(ctx, routed, {
      requestId: formatTelegramMessageRequestId({
        sessionId: routed.sessionId,
        messageId: routed.msgRef.messageId,
      }),
      triggerType: triggerTypeOf(routed),
      includeReplyChain: true,
      modelOverride: routed.requestModelOverride,
      transform,
      markActive: false,
    });
  }

  const decision = decideActiveRequestRoute({
    activeOutputMessageIds: active.activeOutputMessageIds,
    replyToBot: routed.replyToBot,
    mentionsBot: routed.mentionsBot,
    replyToMessageId: routed.replyToMessageId,
    userText: routed.event.text,
    botMentionNames: routed.botNames,
    allowMentionSteer: !routed.isDm,
    plainMessageBehavior: routed.isDm ? "follow_up" : "buffered_prompt",
  });

  switch (decision.kind) {
    case "active_output_steer":
    case "active_mention_steer":
      return steerActiveRequest(ctx, routed, {
        active,
        queue: decision.queue,
        inheritReplyTo: decision.inheritReplyTo,
      });
    case "active_output_follow_up":
    case "plain_follow_up":
      logRouteDecision(ctx, routed, { decision: "queue_followup", reason: decision.kind });
      return publishToActiveRequest(ctx, routed, { active, queue: "followUp", transform });
    case "fork_reply_prompt":
      logRouteDecision(ctx, routed, { decision: "queue_prompt", reason: decision.kind });
      return publishPrompt(ctx, routed, {
        requestId: formatTelegramMessageRequestId({
          sessionId: routed.sessionId,
          messageId: routed.msgRef.messageId,
        }),
        triggerType: "reply",
        includeReplyChain: true,
        transform,
        markActive: false,
      });
    case "buffered_prompt":
      logRouteDecision(ctx, routed, { decision: "queue_prompt", reason: decision.kind });
      return publishPrompt(ctx, routed, {
        requestId: formatQueuedRequestId(active.requestId),
        triggerType: "active",
        includeReplyChain: false,
        transform,
        markActive: false,
        raw: { bufferedForActiveRequestId: active.requestId },
      });
  }
}

async function handleActiveDm(ctx: RouterContext, routed: RoutedMessage): RoutingResult {
  if (routed.active) return routeWhileActive(ctx, routed, routed.active);

  // DMs are ungated: start a new request immediately.
  logRouteDecision(ctx, routed, { decision: "forward", reason: "dm" });
  return publishPrompt(ctx, routed, {
    requestId: formatTelegramMessageRequestId({
      sessionId: routed.sessionId,
      messageId: routed.msgRef.messageId,
    }),
    triggerType: triggerTypeOf(routed),
    includeReplyChain: true,
    transform: directiveTransform({
      botNames: routed.botNames,
      requestModelOverride: routed.requestModelOverride,
      continueCount: routed.continueCount,
    }),
    markActive: true,
  });
}

function clearDebounceBuffer(ctx: RouterContext, sessionId: string): void {
  const buffer = ctx.state.buffers.get(sessionId);
  if (!buffer) return;
  if (buffer.timer) clearTimeout(buffer.timer);
  ctx.state.buffers.delete(sessionId);
}

function bufferActiveChannelMessage(ctx: RouterContext, routed: RoutedMessage): void {
  const message: TelegramBufferedMessage = {
    event: routed.event,
    msgRef: routed.msgRef,
    userId: routed.event.userId,
    text: routed.event.text,
    ts: routed.event.ts,
    mentionsBot: routed.mentionsBot,
    replyToBot: routed.replyToBot,
    botUserId: routed.botUserId,
    sessionModelOverride: routed.modelOverride,
    requestModelOverride: routed.requestModelOverride,
  };
  const existing = ctx.state.buffers.get(routed.sessionId);
  if (existing) {
    existing.messages.push(message);
    logRouteDecision(ctx, routed, { decision: "buffer", reason: "active_batch_append" });
    return;
  }
  const debounceMs = routed.cfg.surface.router.activeDebounceMs;
  const buffer: DebounceBuffer = {
    sessionId: routed.sessionId,
    sessionConfigId: routed.sessionConfigId,
    parentChannelId: routed.parentChannelId,
    messages: [message],
    timer: null,
  };
  ctx.state.buffers.set(routed.sessionId, buffer);
  buffer.timer = ctx.scheduleDebounceFlush(routed.sessionId, debounceMs);
  logRouteDecision(ctx, routed, { decision: "buffer", reason: "active_batch_start" });
}

async function handleActiveChannel(ctx: RouterContext, routed: RoutedMessage): RoutingResult {
  if (routed.active) return routeWhileActive(ctx, routed, routed.active);

  const transform = directiveTransform({
    botNames: routed.botNames,
    requestModelOverride: routed.requestModelOverride,
    continueCount: routed.continueCount,
  });
  const isTrigger = routed.mentionsBot || routed.replyToBot;
  const hasReplyTarget = typeof routed.replyToMessageId === "string";

  if (routed.continueCount !== undefined && !isTrigger && !hasReplyTarget) {
    clearDebounceBuffer(ctx, routed.sessionId);
    logRouteDecision(ctx, routed, { decision: "forward", reason: "continue_directive" });
    return publishPrompt(ctx, routed, {
      requestId: formatGenericRequestId(),
      triggerType: "active",
      includeReplyChain: true,
      transform,
      markActive: true,
    });
  }

  if (isTrigger) {
    // A mention or reply bypasses the gate; drop any pending batch so the same
    // context is not forwarded twice.
    clearDebounceBuffer(ctx, routed.sessionId);
    logRouteDecision(ctx, routed, { decision: "forward", reason: "mention_or_reply" });
    return publishPrompt(ctx, routed, {
      requestId: formatTelegramMessageRequestId({
        sessionId: routed.sessionId,
        messageId: routed.msgRef.messageId,
      }),
      triggerType: triggerTypeOf(routed),
      includeReplyChain: true,
      transform,
      markActive: true,
    });
  }

  bufferActiveChannelMessage(ctx, routed);
  return Result.ok(undefined);
}

async function flushDebounce(ctx: RouterContext, sessionId: string): RoutingResult {
  const buffer = ctx.state.buffers.get(sessionId);
  if (!buffer) return Result.ok(undefined);
  clearDebounceBuffer(ctx, sessionId);

  const cfg = await ctx.currentConfig();
  const gateEnabled = resolveSessionGateEnabled(cfg, sessionId, buffer.parentChannelId);
  const decision = gateEnabled
    ? await evaluateActiveBatchGate(ctx, cfg, buffer)
    : { forward: true, reason: "disabled" };
  ctx.logger.info(
    "router.route.decision",
    formatBridgeLogContext({
      sessionId,
      mode: "active",
      gateEnabled,
      decision: decision.forward ? "forward" : "skip",
      reason: `active_batch_gate:${decision.reason ?? (decision.forward ? "forward" : "skip")}`,
      messageCount: buffer.messages.length,
    }),
  );
  if (!decision.forward) return Result.ok(undefined);

  const newest = buffer.messages[buffer.messages.length - 1];
  if (!newest) return Result.ok(undefined);
  const overrideCarrier = [...buffer.messages].reverse().find((m) => m.requestModelOverride);
  const botNames = resolveTelegramBotMentionNames({
    botName: cfg.surface.telegram.botName,
    botUsername: cfg.surface.telegram.botUsername,
  });
  const composed = await composeTelegramMessages({
    adapter: ctx.adapter,
    event: newest.event,
    batch: buffer.messages.map((message) => message.event),
    includeReplyChain: true,
    botUserId: newest.botUserId ?? (await ctx.adapter.getSelf()).userId,
    botNames,
    blobStore: ctx.blobStore,
    inboundMedia: cfg.surface.telegram.inboundMedia,
    ...(overrideCarrier
      ? {
          transformUserText: (text: string) =>
            stripLeadingModelOverrideDirective({ text, botNames }),
          transformUserTextForMessageId: overrideCarrier.msgRef.messageId,
        }
      : {}),
  });
  // Gate-forwarded prompts do not reply to a message; the newest one anchors context.
  const requestId = formatGenericRequestId();
  const published = await publishTelegramRequest({
    bus: ctx.bus,
    logger: ctx.logger,
    requestId,
    sessionId,
    sessionConfigId: buffer.sessionConfigId,
    parentChannelId: buffer.parentChannelId,
    queue: "prompt",
    triggerType: "active",
    sessionMode: "active",
    modelOverride: overrideCarrier?.requestModelOverride ?? newest.sessionModelOverride,
    composed,
    origin: { userId: newest.userId, messageRef: messageRef(newest.event) },
  });
  return published.map(() => markActive(ctx, sessionId, requestId));
}

async function evaluateActiveBatchGate(
  ctx: RouterContext,
  cfg: CoreConfig,
  buffer: DebounceBuffer,
): Promise<RouterGateDecision> {
  const previousMessageText = await resolvePreviousBatchMessageText({
    adapter: ctx.adapter,
    messages: buffer.messages,
  });
  const evaluated = await Result.tryPromise({
    try: () =>
      ctx.evaluateGate(cfg, {
        sessionId: buffer.sessionId,
        botName: cfg.surface.telegram.botName,
        messages: buffer.messages,
        context: { mode: "active-batch", previousMessageText },
      }),
    catch: (cause) => captureError(cause, "Telegram active-batch gate failed"),
  });
  return evaluated.match<RouterGateDecision>({
    ok: (decision) => decision,
    err: (failure) => {
      rethrowPanic(failure.cause);
      ctx.logger.error(
        "router gate failed; skipping",
        formatBridgeTaggedErrorForLog(failure.cause, {
          sessionId: buffer.sessionId,
          ...extractAiErrorLogDetails(failure.cause),
        }),
      );
      return { forward: false, reason: "error" };
    },
  });
}

// ---------------------------------------------------------------------------
// Mention mode
// ---------------------------------------------------------------------------

/**
 * One batch per (session, source request): a batch preserved across a parked
 * settle event must survive a later request becoming active in the session.
 */
function pendingReplyKey(sessionId: string, sourceRequestId: string): string {
  return `${sessionId}\n${sourceRequestId}`;
}

function enqueuePendingMentionReply(
  ctx: RouterContext,
  routed: RoutedMessage,
  active: ActiveSessionState,
): void {
  const item: PendingMentionReplyItem = {
    event: routed.event,
    requestModelOverride: routed.requestModelOverride,
    continueCount: routed.continueCount,
    botNames: routed.botNames,
  };
  const pending = ctx.state.pendingMentionRepliesByRequest;
  const key = pendingReplyKey(routed.sessionId, active.requestId);
  const existing = pending.get(key);
  if (existing) {
    if (!existing.items.some((i) => i.event.messageId === routed.msgRef.messageId)) {
      existing.items.push(item);
    }
    return;
  }
  pending.set(key, {
    sourceRequestId: active.requestId,
    sessionConfigId: routed.sessionConfigId,
    parentChannelId: routed.parentChannelId,
    sessionMode: routed.mode,
    modelOverride: routed.modelOverride,
    items: [item],
  });
}

function pendingItemTransform(item: PendingMentionReplyItem): TextTransform | undefined {
  return directiveTransform({
    botNames: item.botNames,
    requestModelOverride: item.requestModelOverride,
    continueCount: item.continueCount,
  });
}

/** Replies queued behind a steer join the running request as follow-ups. */
async function flushPendingMentionRepliesAsFollowUp(
  ctx: RouterContext,
  routed: RoutedMessage,
  active: ActiveSessionState,
): RoutingResult {
  const pending = ctx.state.pendingMentionRepliesByRequest;
  const key = pendingReplyKey(routed.sessionId, active.requestId);
  const batch = pending.get(key);
  if (!batch) return Result.ok(undefined);
  while (batch.items.length > 0) {
    const item = batch.items[0]!;
    const published = await publishToActiveRequest(
      ctx,
      { ...routed, event: item.event, msgRef: messageRef(item.event) },
      { active, queue: "followUp", transform: pendingItemTransform(item) },
    );
    const failure = published.match({ ok: () => null, err: (error) => error });
    if (failure) return Result.err(failure);
    batch.items.shift();
  }
  if (pending.get(key) === batch) pending.delete(key);
  return Result.ok(undefined);
}

/** Once the source request settles, its queued replies become one new prompt. */
async function flushPendingMentionRepliesAsPrompt(
  ctx: RouterContext,
  input: { readonly sessionId: string; readonly sourceRequestId: string },
): RoutingResult {
  const pending = ctx.state.pendingMentionRepliesByRequest;
  const key = pendingReplyKey(input.sessionId, input.sourceRequestId);
  const batch = pending.get(key);
  if (!batch) return Result.ok(undefined);
  const last = batch.items[batch.items.length - 1];
  if (!last) {
    pending.delete(key);
    return Result.ok(undefined);
  }

  // The batch stays queued until its prompt is published: a composition
  // failure parks the lifecycle event, and the redelivery must find it.
  const cfg = await ctx.currentConfig();
  const self = await ctx.adapter.getSelf();
  const overrideCarrier = [...batch.items].reverse().find((item) => item.requestModelOverride);
  const composed = await composeTelegramMessages({
    adapter: ctx.adapter,
    event: last.event,
    batch: batch.items.map((item) => item.event),
    includeReplyChain: true,
    botUserId: self.userId,
    botNames: last.botNames,
    blobStore: ctx.blobStore,
    inboundMedia: cfg.surface.telegram.inboundMedia,
    ...(overrideCarrier
      ? {
          transformUserText: pendingItemTransform(overrideCarrier),
          transformUserTextForMessageId: overrideCarrier.event.messageId,
        }
      : { transformUserText: pendingItemTransform(last) }),
  });
  const requestId = formatTelegramMessageRequestId({
    sessionId: input.sessionId,
    messageId: last.event.messageId,
  });
  const published = await publishTelegramRequest({
    bus: ctx.bus,
    logger: ctx.logger,
    requestId,
    sessionId: input.sessionId,
    sessionConfigId: batch.sessionConfigId,
    parentChannelId: batch.parentChannelId,
    queue: "prompt",
    triggerType: "reply",
    sessionMode: batch.sessionMode,
    modelOverride: overrideCarrier?.requestModelOverride ?? batch.modelOverride,
    composed,
    origin: { userId: last.event.userId, messageRef: messageRef(last.event) },
  });
  return published.map(() => {
    if (pending.get(key) === batch) pending.delete(key);
    markActive(ctx, input.sessionId, requestId);
  });
}

/**
 * Forget a settled request, unless flushing its deferred replies already made
 * a newer request active for the session.
 */
function releaseSettledRequest(state: RouterState, sessionId: string, requestId: string): void {
  if (state.activeBySession.get(sessionId)?.requestId === requestId) {
    state.activeBySession.delete(sessionId);
  }
}

async function handleMentionMode(ctx: RouterContext, routed: RoutedMessage): RoutingResult {
  if (!routed.mentionsBot && !routed.replyToBot) {
    logRouteDecision(ctx, routed, { decision: "skip", reason: "mention_mode_non_trigger" });
    return Result.ok(undefined);
  }
  const requestId = formatTelegramMessageRequestId({
    sessionId: routed.sessionId,
    messageId: routed.msgRef.messageId,
  });
  const transform = directiveTransform({
    botNames: routed.botNames,
    requestModelOverride: routed.requestModelOverride,
    continueCount: routed.continueCount,
  });
  const { active } = routed;

  if (active && routed.requestModelOverride) {
    logRouteDecision(ctx, routed, { decision: "queue_prompt", reason: "request_model_override" });
    return publishPrompt(ctx, routed, {
      requestId,
      triggerType: triggerTypeOf(routed),
      includeReplyChain: true,
      modelOverride: routed.requestModelOverride,
      transform,
      markActive: false,
    });
  }

  const repliesToActiveOutput =
    active !== undefined &&
    routed.replyToBot &&
    routed.replyToMessageId !== undefined &&
    active.activeOutputMessageIds.has(routed.replyToMessageId);
  if (active && repliesToActiveOutput && routed.mentionsBot) {
    const steered = await steerActiveRequest(ctx, routed, {
      active,
      queue: parseSteerDirectiveMode({ text: routed.event.text, botNames: routed.botNames }),
      inheritReplyTo: false,
    });
    const continueFlush = steered.match<() => RoutingResult>({
      err: (error) => async () => Result.err(error),
      ok: () => () => flushPendingMentionRepliesAsFollowUp(ctx, routed, active),
    });
    return continueFlush();
  }
  if (active && repliesToActiveOutput) {
    enqueuePendingMentionReply(ctx, routed, active);
    logRouteDecision(ctx, routed, { decision: "queue_prompt", reason: "pending_mention_reply" });
    return Result.ok(undefined);
  }

  // Optimistically mark active so a second trigger before the lifecycle event
  // arrives still sees a running request.
  if (!active) markActive(ctx, routed.sessionId, requestId);
  logRouteDecision(ctx, routed, { decision: "forward", reason: "mention_or_reply" });
  return publishPrompt(ctx, routed, {
    requestId,
    triggerType: triggerTypeOf(routed),
    includeReplyChain: true,
    transform,
    markActive: false,
  });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function describeRouting(
  ctx: RouterContext,
  event: EvtAdapterMessageCreatedData,
): Promise<RoutedMessage> {
  const cfg = await ctx.currentConfig();
  const self = await ctx.adapter.getSelf();
  if (self.platform !== "telegram") {
    throw new Panic({ message: "Telegram request router requires a Telegram adapter" });
  }
  const flags = telegramFlags(event);
  const sessionId = event.channelId;
  const isDm = flags.isDMBased === true;
  const parentChannelId = flags.parentChannelId;
  const botNames = resolveTelegramBotMentionNames({
    botName: cfg.surface.telegram.botName,
    botUsername: cfg.surface.telegram.botUsername,
  });
  const requestModelOverride = parseLeadingModelOverride({ text: event.text, botNames });
  const continueCount = parseLeadingContinueDirective({ text: event.text, botNames });
  return {
    cfg,
    event,
    sessionId,
    msgRef: messageRef(event),
    isDm,
    mentionsBot: flags.mentionsBot === true,
    replyToBot: flags.replyToBot === true,
    replyToMessageId: flags.replyToMessageId,
    parentChannelId,
    botUserId: flags.botUserId ?? self.userId,
    botNames,
    requestModelOverride,
    continueCount,
    modelOverride:
      requestModelOverride ?? resolveSessionModelOverride(cfg, sessionId, parentChannelId),
    sessionConfigId: isDm ? sessionId : resolveSessionConfigId({ cfg, sessionId, parentChannelId }),
    mode: isDm ? "active" : getSessionMode(cfg, sessionId, parentChannelId),
    gateEnabled: resolveSessionGateEnabled(cfg, sessionId, parentChannelId),
    active: ctx.state.activeBySession.get(sessionId),
  };
}

async function handleCustomCommand(
  ctx: RouterContext,
  routed: RoutedMessage,
  command: NonNullable<ReturnType<typeof commandMetadata>>,
): RoutingResult {
  logRouteDecision(ctx, routed, {
    decision: "forward",
    reason: `custom_command:${command.customCommand.name}`,
  });
  return publishPrompt(ctx, routed, {
    requestId: formatTelegramMessageRequestId({
      sessionId: routed.sessionId,
      messageId: routed.msgRef.messageId,
    }),
    triggerType: triggerTypeOf(routed),
    includeReplyChain: false,
    markActive: false,
    raw: command,
  });
}

/**
 * A reply to the bot that also @mentions someone else is ambiguous: it may
 * address the bot or merely reference it. The shared gate decides; failures
 * fail open so a real question is never dropped.
 */
async function passesDirectReplyGate(ctx: RouterContext, routed: RoutedMessage): Promise<boolean> {
  const applies =
    !routed.isDm &&
    routed.gateEnabled &&
    shouldRunDirectReplyMentionGate({
      replyToBot: routed.replyToBot,
      mentionsBot: routed.mentionsBot,
      text: routed.event.text,
      botNames: routed.botNames,
    });
  if (!applies) return true;

  const repliedTo = routed.replyToMessageId
    ? await readMessage(ctx.adapter, {
        platform: "telegram",
        channelId: routed.sessionId,
        messageId: routed.replyToMessageId,
      })
    : null;
  const previousMessageText = await resolvePreviousMessageText({
    adapter: ctx.adapter,
    input: { msgRef: routed.msgRef, triggerTs: routed.event.ts },
  });
  const evaluated = await Result.tryPromise({
    try: () =>
      ctx.evaluateGate(routed.cfg, {
        sessionId: routed.sessionId,
        botName: routed.cfg.surface.telegram.botName,
        messages: [
          {
            msgRef: routed.msgRef,
            userId: routed.event.userId,
            text: routed.event.text,
            ts: routed.event.ts,
            mentionsBot: routed.mentionsBot,
            replyToBot: routed.replyToBot,
          },
        ],
        context: {
          mode: "direct-reply-mention-disambiguation",
          triggerMessageText: normalizeGateText(routed.event.text),
          previousMessageText,
          repliedToMessageText: normalizeGateText(repliedTo?.text),
        },
      }),
    catch: (cause) => captureError(cause, "Telegram direct-reply gate failed"),
  });
  const decision = evaluated.match<RouterGateDecision>({
    ok: (value) => value,
    err: (failure) => {
      rethrowPanic(failure.cause);
      ctx.logger.error(
        "router direct-reply gate failed; forwarding",
        formatBridgeTaggedErrorForLog(failure.cause, {
          sessionId: routed.sessionId,
          ...extractAiErrorLogDetails(failure.cause),
        }),
      );
      return { forward: true, reason: "error-fail-open" };
    },
  });
  logRouteDecision(ctx, routed, {
    decision: decision.forward ? "forward" : "skip",
    reason: `direct_reply_gate:${decision.reason ?? (decision.forward ? "forward" : "skip")}`,
  });
  return decision.forward;
}

async function routeAdapterMessage(
  ctx: RouterContext,
  event: EvtAdapterMessageCreatedData,
  input: StartTelegramRequestRouterInput,
): RoutingResult {
  const suppressed = await input.shouldSuppressAdapterEvent?.({ evt: event });
  if (suppressed?.suppress) {
    ctx.logger.info("router suppressed adapter message", {
      sessionId: event.channelId,
      messageId: event.messageId,
      userId: event.userId,
      reason: suppressed.reason,
    });
    return Result.ok(undefined);
  }

  const routed = await describeRouting(ctx, event);
  const command = ctx.customCommands
    ? commandMetadata(ctx.customCommands, event.text, routed.cfg.surface.telegram.botUsername)
    : null;
  if (command) return handleCustomCommand(ctx, routed, command);

  if (!(await passesDirectReplyGate(ctx, routed))) return Result.ok(undefined);

  switch (true) {
    case routed.mode === "active" && routed.isDm:
      return handleActiveDm(ctx, routed);
    case routed.mode === "active":
      return handleActiveChannel(ctx, routed);
    default:
      return handleMentionMode(ctx, routed);
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

type RouterSubscription = {
  readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
  stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
};

function toRoutingFailure(
  cause: TelegramRequestPublishFailed | Error,
  message: string,
): TelegramRequestRoutingFailed {
  return new TelegramRequestRoutingFailed({ cause, message });
}

/** Panics are defects, not routing failures; they escape to the host supervisor. */
function rethrowPanic(cause: Error): void {
  if (Panic.is(cause)) throw cause;
}

/**
 * A subscription that fails to start must leave nothing behind, so the ones
 * already running are stopped before the failure reaches the host. A rollback
 * stop that fails is reported with its live handle instead of being dropped.
 */
async function adaptSubscriptionStartToHost<E extends AnyTaggedError>(
  started: ResultType<RouterSubscription, E>,
  rollback: readonly RouterSubscription[],
  logger: Logger,
): Promise<RouterSubscription> {
  const outcome = started.match<
    | { readonly kind: "ok"; readonly subscription: RouterSubscription }
    | { readonly kind: "err"; readonly error: E }
  >({
    ok: (subscription) => ({ kind: "ok", subscription }),
    err: (error) => ({ kind: "err", error }),
  });
  if (outcome.kind === "ok") return outcome.subscription;
  const residual: RouterSubscription[] = [];
  const rollbackFailures: EventDeliveryStopFailed[] = [];
  for (const subscription of rollback) {
    const stopped = await subscription.stop();
    stopped.match({
      ok: () => undefined,
      err: (failure) => {
        residual.push(subscription);
        rollbackFailures.push(failure);
      },
    });
  }
  if (rollbackFailures.length === 0) throw outcome.error;
  const failure = new TelegramRequestRouterStartFailed({
    cause: outcome.error,
    rollbackFailures,
    residual,
    message: "Telegram request router start failed and its rollback left subscriptions running",
  });
  logger.error(
    "telegram request router rollback left subscriptions running",
    formatBridgeTaggedErrorForLog(failure, {
      residualTopics: rollbackFailures.map((rollbackFailure) => rollbackFailure.topic).join(","),
    }),
  );
  throw failure;
}

function adaptSubscriptionStopToHost(stopped: ResultType<void, EventDeliveryStopFailed>): void {
  const failure = stopped.match({ ok: () => null, err: (error) => error });
  if (failure) throw failure;
}

export async function startTelegramRequestRouter(
  input: StartTelegramRequestRouterInput,
): Promise<TelegramRequestRouter> {
  const logger = input.logger ?? createLogger({ module: "telegram-request-router" });
  let cfg = input.config ? configFromOverride(input.config) : await getCoreConfig();
  const state: RouterState = {
    activeBySession: new Map(),
    buffers: new Map(),
    pendingMentionRepliesByRequest: new Map(),
  };
  const debounceDefect = Promise.withResolvers<ResultType<void, EventDeliveryDoneError>>();

  const ctx: RouterContext = {
    adapter: input.adapter,
    bus: input.bus,
    blobStore: input.blobStore,
    logger,
    customCommands: input.customCommands,
    state,
    async currentConfig() {
      if (input.config) return cfg;
      cfg = await getCoreConfig();
      return cfg;
    },
    evaluateGate(liveCfg, gateInput) {
      return input.routerGate
        ? input.routerGate(gateInput)
        : shouldForwardByGate({ cfg: liveCfg, input: gateInput, logger });
    },
    scheduleDebounceFlush(sessionId, delayMs) {
      return setTimeout(() => void runDebounceTimer(sessionId), delayMs);
    },
  };

  async function runDebounceTimer(sessionId: string): Promise<void> {
    const flushed = await Result.tryPromise({
      try: () => flushDebounce(ctx, sessionId),
      catch: (cause) => captureError(cause, "Telegram debounce flush failed"),
    });
    flushed.match({
      ok: (result) =>
        result.match({
          ok: () => undefined,
          err: (error) =>
            logger.error(
              "router flushDebounce failed",
              formatBridgeTaggedErrorForLog(error, { sessionId }),
            ),
        }),
      err: (failure) => {
        if (Panic.is(failure.cause)) {
          debounceDefect.reject(failure.cause);
          return;
        }
        logger.error(
          "router flushDebounce failed",
          formatBridgeTaggedErrorForLog(failure.cause, { sessionId }),
        );
      },
    });
  }

  const lifecycle = await input.bus.subscribeTopic(
    "evt.request",
    {
      mode: "fanout",
      subscriptionId: `${input.subscriptionId}:lifecycle`,
      consumerId: `${input.subscriptionId}:lifecycle:${process.pid}`,
      batch: { maxWaitMs: 1000 },
    },
    async (message) => {
      if (message.type !== lilacEventTypes.EvtRequestLifecycleChanged) return Result.ok(undefined);
      const requestId = message.headers?.request_id;
      const sessionId = message.headers?.session_id;
      if (message.headers?.request_client !== "telegram" || !requestId || !sessionId) {
        return Result.ok(undefined);
      }
      const current = state.activeBySession.get(sessionId);
      if (message.data.state === "running" && current?.requestId !== requestId) {
        state.activeBySession.set(sessionId, { requestId, activeOutputMessageIds: new Set() });
        return Result.ok(undefined);
      }
      const settled =
        message.data.state === "resolved" ||
        message.data.state === "failed" ||
        message.data.state === "cancelled";
      if (!settled) return Result.ok(undefined);
      const ownsPendingReplies = state.pendingMentionRepliesByRequest.has(
        pendingReplyKey(sessionId, requestId),
      );
      if (current?.requestId !== requestId && !ownsPendingReplies) return Result.ok(undefined);
      // A failed flush parks this event; the active entry and the batch both
      // survive so the redelivery can retry.
      const flushed = await Result.tryPromise({
        try: () =>
          flushPendingMentionRepliesAsPrompt(ctx, { sessionId, sourceRequestId: requestId }),
        catch: (cause) => captureError(cause, "Telegram pending reply flush failed"),
      });
      return flushed.match<ResultType<void, TelegramRequestRoutingFailed>>({
        ok: (result) =>
          result
            .map(() => releaseSettledRequest(state, sessionId, requestId))
            .mapError((error) => toRoutingFailure(error, "Telegram pending reply flush failed")),
        err: (failure) => {
          rethrowPanic(failure.cause);
          return Result.err(toRoutingFailure(failure.cause, "Telegram pending reply flush failed"));
        },
      });
    },
    deliveryPolicy,
  );
  const lifecycleSubscription = await adaptSubscriptionStartToHost(lifecycle, [], logger);

  const surface = await input.bus.subscribeTopic(
    "evt.surface",
    {
      mode: "fanout",
      subscriptionId: `${input.subscriptionId}:surface`,
      consumerId: `${input.subscriptionId}:surface:${process.pid}`,
      batch: { maxWaitMs: 1000 },
    },
    async (message) => {
      if (message.type !== lilacEventTypes.EvtSurfaceOutputMessageCreated) {
        return Result.ok(undefined);
      }
      const requestId = message.headers?.request_id;
      const sessionId = message.headers?.session_id;
      if (!requestId || !sessionId) return Result.ok(undefined);
      const current = state.activeBySession.get(sessionId);
      if (!current || current.requestId !== requestId) return Result.ok(undefined);
      const ref = message.data.msgRef;
      if (ref.platform === "telegram" && ref.messageId) {
        current.activeOutputMessageIds.add(ref.messageId);
      }
      return Result.ok(undefined);
    },
    deliveryPolicy,
  );
  const surfaceSubscription = await adaptSubscriptionStartToHost(
    surface,
    [lifecycleSubscription],
    logger,
  );

  const adapterEvents = await input.bus.subscribeTopic(
    "evt.adapter",
    {
      mode: "fanout",
      subscriptionId: `${input.subscriptionId}:adapter`,
      consumerId: `${input.subscriptionId}:adapter:${process.pid}`,
    },
    async (message) => {
      if (
        message.type !== lilacEventTypes.EvtAdapterMessageCreated ||
        message.data.platform !== "telegram"
      ) {
        return Result.ok(undefined);
      }
      const routed = await Result.tryPromise({
        try: () => routeAdapterMessage(ctx, message.data, input),
        catch: (cause) => captureError(cause, "Telegram request routing failed"),
      });
      return routed.match<ResultType<void, TelegramRequestRoutingFailed>>({
        ok: (result) =>
          result.mapError((error) => toRoutingFailure(error, "Telegram request routing failed")),
        err: (failure) => {
          rethrowPanic(failure.cause);
          return Result.err(toRoutingFailure(failure.cause, "Telegram request routing failed"));
        },
      });
    },
    deliveryPolicy,
  );
  const adapterSubscription = await adaptSubscriptionStartToHost(
    adapterEvents,
    [surfaceSubscription, lifecycleSubscription],
    logger,
  );

  const subscriptions = [adapterSubscription, surfaceSubscription, lifecycleSubscription];
  return {
    done: Promise.race([...subscriptions.map((s) => s.done), debounceDefect.promise]),
    stop: async () => {
      // Buffered active-mode messages are already durable in the ingress
      // outbox, but flushing them keeps a graceful restart from re-gating the
      // same batch twice.
      const bufferedSessions = Array.from(state.buffers.keys());
      for (const sessionId of bufferedSessions) await runDebounceTimer(sessionId);
      // Every subscription gets its stop attempt before the first failure
      // propagates, so a failed stop cannot leave the others running.
      const stopped: ResultType<void, EventDeliveryStopFailed>[] = [];
      for (const subscription of subscriptions) stopped.push(await subscription.stop());
      state.pendingMentionRepliesByRequest.clear();
      for (const result of stopped) adaptSubscriptionStopToHost(result);
    },
  };
}
