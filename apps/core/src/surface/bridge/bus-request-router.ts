import {
  createLogger,
  extractAiErrorLogDetails,
  getCoreConfig,
  env,
  errorMessage,
  isPanic,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import {
  buildCoreLineageManifestV1,
  createCorePrimaryLineageFreshOnlyV1,
  lilacEventTypes,
  type DeliveryDisposition,
  type EventDeliveryDoneError,
  type EventDeliveryStartFailed,
  type EventDeliveryStopFailed,
  type EvtAdapterMessageCreatedData,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
import { Result, TaggedError, type Panic, type Result as ResultType } from "better-result";
import type { SurfaceAdapter } from "../adapter";
import type { MsgRef } from "../types";
import type { TranscriptStore } from "../../transcript/transcript-store";
import { composeRequestMessages, composeSingleMessageWithLineage } from "./request-composition";
import { formatDiscordMessageRequestId } from "./request-ids";

import {
  type SessionMode,
  type RouterConfigOverride,
  previewText,
  resolveBotMentionNames,
  normalizeGateText,
  parseLeadingContinueDirective,
  parseLeadingModelOverride,
  stripLeadingModelOverrideDirective,
  parseSteerDirectiveMode,
  stripLeadingContinueDirective,
  stripLeadingInterruptDirective,
  shouldRunDirectReplyMentionGate,
  consumerId,
  randomRequestId,
  bufferedPromptRequestIdForActiveRequest,
  parseDiscordMsgRefFromAdapterEvent,
  resolveSessionConfigId,
  getSessionMode,
  resolveSessionGateEnabled,
  resolveSessionModelOverride,
  buildDiscordUserAliasById,
  getDiscordFlags,
  withDefaultToolsConfig,
} from "./bus-request-router/common";
import {
  type BufferedMessage,
  type RouterGateInput,
  type RouterGateDecision,
  shouldForwardByGate,
} from "./bus-request-router/gate";
import {
  type PendingMentionReplyBatch,
  type PendingMentionReplyBatchItem,
  enqueuePendingMentionReplyBatch as enqueuePendingMentionReplyBatchImpl,
  takePendingMentionReplyBatch as takePendingMentionReplyBatchImpl,
  transformPendingUserText as transformPendingUserTextImpl,
} from "./bus-request-router/pending-batch";
import {
  type PublishBusRequestInput,
  publishActiveChannelPrompt as publishActiveChannelPromptImpl,
  publishBusRequest as publishBusRequestImpl,
  publishComposedRequest as publishComposedRequestImpl,
  publishSingleMessagePrompt as publishSingleMessagePromptImpl,
  publishSingleMessageToActiveRequest as publishSingleMessageToActiveRequestImpl,
  publishSurfaceOutputReanchor as publishSurfaceOutputReanchorImpl,
} from "./bus-request-router/publish";
import {
  resolvePreviousBatchMessageText as resolvePreviousBatchMessageTextImpl,
  resolvePreviousMessageText as resolvePreviousMessageTextImpl,
  resolveRepliedToMessageText as resolveRepliedToMessageTextImpl,
} from "./bus-request-router/context";
import { decideActiveRequestRoute } from "./bus-request-router/decisions";
import {
  customCommandInvocationErrorText,
  type CustomCommandManager,
} from "../../custom-commands/manager";

type ActiveSessionState = {
  requestId: string;
  /** IDs of bot output messages in the current active output chain. */
  activeOutputMessageIds: Set<string>;
};

export class BusRequestRouterMissingHeadersError extends TaggedError(
  "BusRequestRouterMissingHeadersError",
)<{
  readonly topic: "evt.request" | "evt.surface";
  readonly messageType: string;
  readonly message: string;
}> {}

export class BusRequestRouterRoutingError extends TaggedError("BusRequestRouterRoutingError")<{
  readonly topic: "evt.request" | "evt.adapter";
  readonly cause: unknown;
  readonly message: string;
}> {}

export class BusRequestRouterActiveBatchGateFailed extends TaggedError(
  "BusRequestRouterActiveBatchGateFailed",
)<{
  readonly sessionId: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class BusRequestRouterDebounceFlushFailed extends TaggedError(
  "BusRequestRouterDebounceFlushFailed",
)<{
  readonly sessionId: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

type RouterDeliverySubscription = {
  readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
  stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
};

export type BusRequestRouter = {
  readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
  stop(): Promise<void>;
};

function lifecycleDeliveryPolicy(
  error: BusRequestRouterMissingHeadersError | BusRequestRouterRoutingError,
): DeliveryDisposition {
  switch (error._tag) {
    case "BusRequestRouterMissingHeadersError":
    case "BusRequestRouterRoutingError":
      return "park-pending";
  }
}

function surfaceDeliveryPolicy(error: BusRequestRouterMissingHeadersError): DeliveryDisposition {
  switch (error._tag) {
    case "BusRequestRouterMissingHeadersError":
      return "park-pending";
  }
}

function adapterDeliveryPolicy(error: BusRequestRouterRoutingError): DeliveryDisposition {
  switch (error._tag) {
    case "BusRequestRouterRoutingError":
      return "park-pending";
  }
}

async function captureRouterRouting(
  topic: "evt.request" | "evt.adapter",
  operation: () => Promise<void>,
): Promise<ResultType<void, BusRequestRouterRoutingError>> {
  try {
    await operation();
    return Result.ok(undefined);
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return Result.err(
      new BusRequestRouterRoutingError({
        topic,
        cause,
        message: `Bus request router failed while handling ${topic}`,
      }),
    );
  }
}

async function captureRouterActiveBatchGate(
  sessionId: string,
  operation: () => Promise<RouterGateDecision>,
): Promise<ResultType<RouterGateDecision, BusRequestRouterActiveBatchGateFailed>> {
  try {
    return Result.ok(await operation());
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return Result.err(
      new BusRequestRouterActiveBatchGateFailed({
        sessionId,
        cause,
        message: "Active-batch router gate failed",
      }),
    );
  }
}

async function captureRouterDebounceFlush(input: {
  readonly sessionId: string;
  readonly operation: () => Promise<void>;
  readonly reportFatalPanic: (panic: Panic) => void;
}): Promise<ResultType<void, BusRequestRouterDebounceFlushFailed>> {
  try {
    await input.operation();
    return Result.ok(undefined);
  } catch (cause) {
    if (isPanic(cause)) {
      input.reportFatalPanic(cause);
      return Result.ok(undefined);
    }
    return Result.err(
      new BusRequestRouterDebounceFlushFailed({
        sessionId: input.sessionId,
        cause,
        message: "Bus request router debounce flush failed",
      }),
    );
  }
}

function adaptRouterSubscriptionStart(
  result: ResultType<RouterDeliverySubscription, EventDeliveryStartFailed>,
): RouterDeliverySubscription {
  if (result.status === "error") throw result.error;
  return result.value;
}

function superviseRouterSubscriptionsDone(
  subscriptions: readonly RouterDeliverySubscription[],
): Promise<ResultType<void, EventDeliveryDoneError>> {
  return Promise.race(subscriptions.map((subscription) => subscription.done));
}

async function adaptRouterSubscriptionsStop(
  subscriptions: readonly RouterDeliverySubscription[],
): Promise<void> {
  const results = await Promise.all(subscriptions.map((subscription) => subscription.stop()));
  for (const result of results) {
    if (result.status === "error") throw result.error;
  }
}

function resolveTriggerType(input: {
  replyToBot: boolean | undefined;
  mentionsBot: boolean | undefined;
}): "reply" | "mention" | undefined {
  if (input.replyToBot) return "reply";
  if (input.mentionsBot) return "mention";
  return undefined;
}

function uniqueParticipantUserIds(input: {
  values: readonly (string | undefined)[];
  exclude: string;
}): string[] {
  const exclude = input.exclude.trim();
  return [
    ...new Set(
      input.values
        .map((value) => value?.trim())
        .filter((value): value is string => !!value && value !== exclude),
    ),
  ];
}

type DebounceBuffer = {
  sessionId: string;
  sessionConfigId: string;
  parentChannelId?: string;
  messages: BufferedMessage[];
  timer: ReturnType<typeof setTimeout> | null;
};

export async function startBusRequestRouter(params: {
  adapter: SurfaceAdapter;
  bus: LilacBus;
  subscriptionId: string;
  customCommands?: CustomCommandManager;
  /** Optionally inject config; defaults to getCoreConfig(). */
  config?: RouterConfigOverride;
  transcriptStore?: TranscriptStore;
  /**
   * Optionally suppress routing for specific adapter events.
   * Used to prevent workflow-resume replies from also being treated as normal prompts.
   */
  shouldSuppressAdapterEvent?: (input: {
    evt: EvtAdapterMessageCreatedData;
  }) => Promise<{ suppress: boolean; reason?: string }>;
  /** Optional injection for unit tests (bypasses real model call). */
  routerGate?: (input: RouterGateInput) => Promise<RouterGateDecision>;
}): Promise<BusRequestRouter> {
  const { adapter, bus, subscriptionId, customCommands } = params;

  const logger = createLogger({
    module: "bus-request-router",
  });

  let cfg = params.config ? await withDefaultToolsConfig(params.config) : await getCoreConfig();
  let coreConfigReloadHadError = false;
  let lastCoreConfigReloadError: string | null = null;

  async function reloadCoreConfigIfNeeded(): Promise<void> {
    if (params.config) return;

    try {
      cfg = await getCoreConfig();

      if (coreConfigReloadHadError) {
        logger.info("core-config reload recovered", {
          path: "core-config.yaml",
        });
      }

      coreConfigReloadHadError = false;
      lastCoreConfigReloadError = null;
    } catch (e) {
      if (isPanic(e)) throw e;
      const msg = errorMessage(e);
      if (!coreConfigReloadHadError || lastCoreConfigReloadError !== msg) {
        logger.warn("core-config reload failed; using last known config", {
          path: "core-config.yaml",
          error: msg,
        });
      }

      coreConfigReloadHadError = true;
      lastCoreConfigReloadError = msg;
    }
  }

  const activeBySession = new Map<string, ActiveSessionState>();
  const buffers = new Map<string, DebounceBuffer>();
  const pendingMentionReplyBatchBySession = new Map<string, PendingMentionReplyBatch>();
  const debounceDefect = Promise.withResolvers<ResultType<void, EventDeliveryDoneError>>();
  const evaluateRouterGate = (input: RouterGateInput): Promise<RouterGateDecision> => {
    return params.routerGate
      ? params.routerGate(input)
      : shouldForwardByGate({ cfg, input, logger });
  };

  async function resolvePreviousMessageText(input: {
    msgRef: MsgRef;
    triggerTs: number;
  }): Promise<string | undefined> {
    return resolvePreviousMessageTextImpl({ adapter, input });
  }

  async function resolveRepliedToMessageText(input: {
    sessionId: string;
    replyToMessageId?: string;
  }): Promise<string | undefined> {
    return resolveRepliedToMessageTextImpl({ adapter, input });
  }

  async function resolvePreviousBatchMessageText(
    messages: readonly BufferedMessage[],
  ): Promise<string | undefined> {
    return resolvePreviousBatchMessageTextImpl({ adapter, messages });
  }

  function combineTextTransforms(
    ...transforms: Array<((text: string) => string) | undefined>
  ): ((text: string) => string) | undefined {
    const activeTransforms = transforms.filter(
      (transform): transform is (text: string) => string => typeof transform === "function",
    );
    if (activeTransforms.length === 0) return undefined;
    return (text: string) => activeTransforms.reduce((acc, transform) => transform(acc), text);
  }

  function stripCurrentContinueDirective(input: {
    text: string;
    botNames: readonly string[];
    continueCount?: number;
  }): ((text: string) => string) | undefined {
    if (input.continueCount === undefined) return undefined;
    return (text: string) =>
      stripLeadingContinueDirective({
        text,
        botNames: input.botNames,
      });
  }

  async function evaluateAdapterSuppression(
    evt: EvtAdapterMessageCreatedData,
  ): Promise<{ suppress: boolean; reason?: string }> {
    if (!params.shouldSuppressAdapterEvent) return { suppress: false };
    try {
      return await params.shouldSuppressAdapterEvent({ evt });
    } catch (cause) {
      if (isPanic(cause)) throw cause;
      logger.error("router suppression hook failed; proceeding", cause);
      return { suppress: false };
    }
  }

  async function evaluateDirectReplyRouterGate(input: {
    readonly sessionId: string;
    readonly gateInput: RouterGateInput;
  }): Promise<RouterGateDecision> {
    try {
      return await evaluateRouterGate(input.gateInput);
    } catch (cause) {
      if (isPanic(cause)) throw cause;
      logger.error(
        "router direct-reply gate failed; forwarding",
        { sessionId: input.sessionId, ...extractAiErrorLogDetails(cause) },
        cause,
      );
      return { forward: true, reason: "error-fail-open" };
    }
  }

  const lifecycleSub = adaptRouterSubscriptionStart(
    await bus.subscribeTopic(
      "evt.request",
      {
        mode: "fanout",
        subscriptionId: `${subscriptionId}:lifecycle`,
        consumerId: consumerId(`${subscriptionId}:lifecycle`),
        offset: { type: "now" },
        batch: { maxWaitMs: 1000 },
      },
      async (msg, ctx) => {
        if (msg.type !== lilacEventTypes.EvtRequestLifecycleChanged) {
          return Result.ok(undefined);
        }

        const requestId = msg.headers?.request_id;
        const sessionId = msg.headers?.session_id;
        if (!requestId || !sessionId) {
          logger.error("router.message.invalid_headers", {
            topic: "evt.request",
            messageType: msg.type,
            hasRequestId: Boolean(requestId),
            hasSessionId: Boolean(sessionId),
            cursor: ctx.cursor,
            rawHeadersKeys: msg.headers ? Object.keys(msg.headers) : [],
            action: "park_pending",
          });
          return Result.err(
            new BusRequestRouterMissingHeadersError({
              topic: "evt.request",
              messageType: msg.type,
              message:
                "evt.request.lifecycle.changed missing required headers.request_id/session_id",
            }),
          );
        }

        return captureRouterRouting("evt.request", async () => {
          if (msg.data.state === "running") {
            activeBySession.set(sessionId, {
              requestId,
              activeOutputMessageIds: new Set(),
            });
          }

          if (
            msg.data.state === "resolved" ||
            msg.data.state === "failed" ||
            msg.data.state === "cancelled"
          ) {
            const cur = activeBySession.get(sessionId);
            if (cur?.requestId === requestId) {
              await flushPendingMentionReplyBatchAsPrompt({
                sessionId,
                sourceRequestId: requestId,
              });
              activeBySession.delete(sessionId);
            }
          }
        });
      },
      lifecycleDeliveryPolicy,
    ),
  );

  const surfaceSub = adaptRouterSubscriptionStart(
    await bus.subscribeTopic(
      "evt.surface",
      {
        mode: "fanout",
        subscriptionId: `${subscriptionId}:surface`,
        consumerId: consumerId(`${subscriptionId}:surface`),
        offset: { type: "now" },
        batch: { maxWaitMs: 1000 },
      },
      async (msg, ctx) => {
        if (msg.type !== lilacEventTypes.EvtSurfaceOutputMessageCreated) {
          return Result.ok(undefined);
        }

        const requestId = msg.headers?.request_id;
        const sessionId = msg.headers?.session_id;
        if (!requestId || !sessionId) {
          logger.error("router.message.invalid_headers", {
            topic: "evt.surface",
            messageType: msg.type,
            hasRequestId: Boolean(requestId),
            hasSessionId: Boolean(sessionId),
            cursor: ctx.cursor,
            rawHeadersKeys: msg.headers ? Object.keys(msg.headers) : [],
            action: "park_pending",
          });
          return Result.err(
            new BusRequestRouterMissingHeadersError({
              topic: "evt.surface",
              messageType: msg.type,
              message:
                "evt.surface.output.message.created missing required headers.request_id/session_id",
            }),
          );
        }

        const cur = activeBySession.get(sessionId);
        if (!cur || cur.requestId !== requestId) {
          return Result.ok(undefined);
        }

        const msgRef = msg.data.msgRef;
        if (
          msgRef?.platform === "discord" &&
          typeof msgRef.messageId === "string" &&
          msgRef.messageId
        ) {
          cur.activeOutputMessageIds.add(msgRef.messageId);
        }

        return Result.ok(undefined);
      },
      surfaceDeliveryPolicy,
    ),
  );

  const adapterSub = adaptRouterSubscriptionStart(
    await bus.subscribeTopic(
      "evt.adapter",
      {
        mode: "fanout",
        subscriptionId: `${subscriptionId}:adapter`,
        consumerId: consumerId(`${subscriptionId}:adapter`),
        offset: { type: "now" },
        batch: { maxWaitMs: 1000 },
      },
      async (msg) => {
        if (msg.type !== lilacEventTypes.EvtAdapterMessageCreated) {
          return Result.ok(undefined);
        }
        if (msg.data.platform !== "discord") {
          return Result.ok(undefined);
        }

        return captureRouterRouting("evt.adapter", async () => {
          if (env.perf.log) {
            const lagMs = Date.now() - msg.ts;
            const shouldWarn = lagMs >= env.perf.lagWarnMs;
            const shouldSample = env.perf.sampleRate > 0 && Math.random() < env.perf.sampleRate;
            if (shouldWarn || shouldSample) {
              if (shouldWarn) {
                logger.warn("perf.bus_lag", {
                  stage: "evt.adapter->router",
                  lagMs,
                  sessionId: msg.data.channelId,
                  messageId: msg.data.messageId,
                  userId: msg.data.userId,
                });
              } else {
                logger.info("perf.bus_lag", {
                  stage: "evt.adapter->router",
                  lagMs,
                  sessionId: msg.data.channelId,
                  messageId: msg.data.messageId,
                  userId: msg.data.userId,
                });
              }
            }
          }

          const suppression = await evaluateAdapterSuppression(msg.data);
          if (suppression.suppress) {
            logger.info("router suppressed adapter message", {
              sessionId: msg.data.channelId,
              messageId: msg.data.messageId,
              userId: msg.data.userId,
              reason: suppression.reason,
            });
            return;
          }

          // reload config opportunistically (mtime cached in getCoreConfig).
          // If reload fails, keep using the last known good config.
          await reloadCoreConfigIfNeeded();

          const sessionId = msg.data.channelId;
          const msgRef = parseDiscordMsgRefFromAdapterEvent(msg.data);

          const flags = getDiscordFlags(msg.data.raw);
          const isDm = flags.isDMBased === true;
          const parentChannelId = flags.parentChannelId;
          const botMentionNames = resolveBotMentionNames({
            cfg,
            botUserId: flags.botUserId ?? (await adapter.getSelf()).userId,
          });
          const requestModelOverride = parseLeadingModelOverride({
            text: msg.data.text,
            botNames: botMentionNames,
          });
          const continueCount = parseLeadingContinueDirective({
            text: msg.data.text,
            botNames: botMentionNames,
          });
          const configuredSessionModelOverride = resolveSessionModelOverride(
            cfg,
            sessionId,
            parentChannelId,
          );
          const modelOverride =
            requestModelOverride ?? flags.sessionModelOverride ?? configuredSessionModelOverride;
          const sessionConfigId = isDm
            ? sessionId
            : resolveSessionConfigId({
                cfg,
                sessionId,
                parentChannelId,
              });

          const mode: SessionMode = isDm
            ? "active"
            : getSessionMode(cfg, sessionId, parentChannelId);
          const gateEnabled = resolveSessionGateEnabled(cfg, sessionId, parentChannelId);

          const active = activeBySession.get(sessionId);

          const logRouteDecision = (input: {
            decision:
              | "forward"
              | "skip"
              | "queue_followup"
              | "queue_prompt"
              | "steer"
              | "interrupt";
            reason: string;
          }) => {
            logger.info("router.route.decision", {
              sessionId,
              messageId: msgRef.messageId,
              userId: msg.data.userId,
              mode,
              gateEnabled,
              decision: input.decision,
              reason: input.reason,
              activeRequestId: active?.requestId,
              sessionConfigId,
              modelOverride,
              requestModelOverride,
              continueCount,
            });
          };

          logger.debug("adapter.message.created", {
            sessionId,
            messageId: msgRef.messageId,
            userId: msg.data.userId,
            mode,
            isDm,
            mentionsBot: flags.mentionsBot === true,
            replyToBot: flags.replyToBot === true,
            activeRequestId: active?.requestId,
            sessionConfigId,
            modelOverride,
            requestModelOverride,
            continueCount,
            textPreview:
              typeof msg.data.text === "string" && msg.data.text.trim().length > 0
                ? previewText(msg.data.text)
                : undefined,
          });

          const customName = customCommands?.peekTextName(msg.data.text) ?? null;
          if (customName) {
            const requestId = formatDiscordMessageRequestId({
              channelId: sessionId,
              messageId: msgRef.messageId,
            });
            const raw = (() => {
              const known = customCommands?.get(customName);
              if (!known) {
                return {
                  customCommand: {
                    name: customName,
                    args: [],
                    text: msg.data.text,
                    source: "text",
                    error: `Unknown custom command '${customName}'.`,
                  },
                };
              }

              const parsed = customCommands?.parseText(msg.data.text);
              if (!parsed || parsed.status === "error") {
                return {
                  customCommand: {
                    name: customName,
                    args: [],
                    text: msg.data.text,
                    source: "text",
                    error: parsed
                      ? customCommandInvocationErrorText(parsed.error)
                      : `Unknown custom command '${customName}'.`,
                  },
                };
              }
              if (!parsed.value) {
                return {
                  customCommand: {
                    name: customName,
                    args: [],
                    text: msg.data.text,
                    source: "text",
                    error: `Unknown custom command '${customName}'.`,
                  },
                };
              }

              return {
                customCommand: {
                  name: parsed.value.command.def.name,
                  args: parsed.value.args,
                  ...(parsed.value.prompt ? { prompt: parsed.value.prompt } : {}),
                  text: parsed.value.text,
                  source: parsed.value.source,
                },
              };
            })();

            await publishSingleMessagePrompt({
              adapter,
              bus,
              cfg,
              requestId,
              sessionId,
              sessionConfigId,
              parentChannelId,
              msgRef,
              sessionMode: mode,
              modelOverride,
              raw,
            });

            logRouteDecision({
              decision: "forward",
              reason: `custom_command:${customName}`,
            });
            return;
          }

          if (
            !isDm &&
            gateEnabled &&
            shouldRunDirectReplyMentionGate({
              replyToBot: flags.replyToBot === true,
              mentionsBot: flags.mentionsBot === true,
              text: msg.data.text,
              botNames: botMentionNames,
            })
          ) {
            const [previousMessageText, repliedToMessageText] = await Promise.all([
              resolvePreviousMessageText({ msgRef, triggerTs: msg.data.ts }),
              resolveRepliedToMessageText({
                sessionId,
                replyToMessageId: flags.replyToMessageId,
              }),
            ]);

            const decision = await evaluateDirectReplyRouterGate({
              sessionId,
              gateInput: {
                sessionId,
                botName: cfg.surface.discord.botName,
                messages: [
                  {
                    msgRef,
                    userId: msg.data.userId,
                    text: msg.data.text,
                    ts: msg.data.ts,
                    mentionsBot: flags.mentionsBot === true,
                    replyToBot: flags.replyToBot === true,
                  },
                ],
                context: {
                  mode: "direct-reply-mention-disambiguation",
                  triggerMessageText: normalizeGateText(msg.data.text),
                  previousMessageText,
                  repliedToMessageText,
                },
              },
            });

            if (!decision.forward) {
              logRouteDecision({
                decision: "skip",
                reason: `direct_reply_gate:${decision.reason ?? "skip"}`,
              });
              return;
            }

            logRouteDecision({
              decision: "forward",
              reason: `direct_reply_gate:${decision.reason ?? "forward"}`,
            });
          }

          if (mode === "active") {
            if (isDm) {
              await handleActiveDmMode({
                adapter,
                bus,
                cfg,
                sessionId,
                msgRef,
                userId: msg.data.userId,
                userText: msg.data.text,
                mentionsBot: flags.mentionsBot === true,
                replyToBot: flags.replyToBot === true,
                replyToMessageId: flags.replyToMessageId,
                active,
                sessionMode: mode,
                sessionConfigId,
                modelOverride,
                requestModelOverride,
                continueCount,
                botMentionNames,
              });
            } else {
              await handleActiveChannelMode({
                adapter,
                bus,
                cfg,
                buffers,
                sessionId,
                msgRef,
                userId: msg.data.userId,
                userText: msg.data.text,
                messageTs: msg.data.ts,
                mentionsBot: flags.mentionsBot === true,
                replyToBot: flags.replyToBot === true,
                replyToMessageId: flags.replyToMessageId,
                botUserId: flags.botUserId,
                parentChannelId,
                active,
                sessionMode: mode,
                sessionConfigId,
                modelOverride,
                requestModelOverride,
                continueCount,
                botMentionNames,
              });
            }

            return;
          }

          await handleMentionMode({
            adapter,
            bus,
            cfg,
            activeBySession,
            sessionId,
            msgRef,
            userId: msg.data.userId,
            userText: msg.data.text,
            mentionsBot: flags.mentionsBot,
            replyToBot: flags.replyToBot,
            replyToMessageId: flags.replyToMessageId,
            active,
            parentChannelId,
            sessionMode: mode,
            sessionConfigId,
            modelOverride,
            requestModelOverride,
            continueCount,
            botMentionNames,
          });
        });
      },
      adapterDeliveryPolicy,
    ),
  );

  function clearDebounceBuffer(sessionId: string) {
    const b = buffers.get(sessionId);
    if (!b) return;
    buffers.delete(sessionId);
    if (b.timer) {
      clearTimeout(b.timer);
      b.timer = null;
    }
  }

  function enqueuePendingMentionReplyBatch(input: {
    sessionId: string;
    sourceRequestId: string;
    sessionConfigId: string;
    parentChannelId?: string;
    sessionMode: SessionMode;
    modelOverride?: string;
    item: PendingMentionReplyBatchItem;
  }) {
    enqueuePendingMentionReplyBatchImpl({
      pendingMentionReplyBatchBySession,
      input,
    });
  }

  function takePendingMentionReplyBatch(input: {
    sessionId: string;
    sourceRequestId: string;
  }): PendingMentionReplyBatch | null {
    return takePendingMentionReplyBatchImpl({
      pendingMentionReplyBatchBySession,
      input,
    });
  }

  function transformPendingUserText(
    item: PendingMentionReplyBatchItem,
  ): ((text: string) => string) | undefined {
    return transformPendingUserTextImpl(item);
  }

  async function flushPendingMentionReplyBatchAsFollowUp(input: {
    sessionId: string;
    sourceRequestId: string;
  }) {
    const batch = takePendingMentionReplyBatch(input);
    if (!batch || batch.items.length === 0) return;

    for (const item of batch.items) {
      await publishSingleMessageToActiveRequest({
        adapter,
        bus,
        cfg,
        requestId: input.sourceRequestId,
        sessionId: input.sessionId,
        sessionConfigId: batch.sessionConfigId,
        parentChannelId: batch.parentChannelId,
        queue: "followUp",
        msgRef: item.msgRef,
        sessionMode: batch.sessionMode,
        modelOverride: batch.modelOverride,
        transformUserText: transformPendingUserText(item),
      });
    }
  }

  async function flushPendingMentionReplyBatchAsPrompt(input: {
    sessionId: string;
    sourceRequestId: string;
  }) {
    const batch = takePendingMentionReplyBatch(input);
    if (!batch || batch.items.length === 0) return;

    const last = batch.items[batch.items.length - 1]!;
    const requestId = formatDiscordMessageRequestId({
      channelId: input.sessionId,
      messageId: last.msgRef.messageId,
    });

    const self = await adapter.getSelf();
    const discordUserAliasById = buildDiscordUserAliasById(cfg);

    const composed = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: self.userId,
      botName: cfg.surface.discord.botName,
      transcriptStore: params.transcriptStore,
      currentRequestId: requestId,
      currentMessageIds: batch.items.map((item) => item.msgRef.messageId),
      discordUserAliasById,
      transformUserText: transformPendingUserText(last),
      transformUserTextForMessageId: last.msgRef.messageId,
      trigger: {
        type: "reply",
        msgRef: last.msgRef,
      },
    });

    const chainMessageIds = new Set(composed.chainMessageIds);
    const extraCompositions: Array<
      NonNullable<Awaited<ReturnType<typeof composeSingleMessageWithLineage>>>
    > = [];
    const batchParticipantUserIds: string[] = [];

    for (const item of batch.items) {
      const surfaceMessage = await adapter.readMsg(item.msgRef);
      if (surfaceMessage?.userId) batchParticipantUserIds.push(surfaceMessage.userId);
      if (chainMessageIds.has(item.msgRef.messageId)) continue;
      const extra = await composeSingleMessageWithLineage(adapter, {
        platform: "discord",
        botUserId: self.userId,
        botName: cfg.surface.discord.botName,
        msgRef: item.msgRef,
        discordUserAliasById,
        transcriptStore: params.transcriptStore,
        transformUserText: transformPendingUserText(item),
      });

      if (!extra) continue;
      extraCompositions.push(extra);
      chainMessageIds.add(item.msgRef.messageId);
    }

    let baseInsertAt = composed.messages.length;
    const finalMessages = (() => {
      const extraMessages = extraCompositions.flatMap((extra) => extra.messages);
      if (extraMessages.length === 0) return composed.messages;

      for (let i = composed.messages.length - 1; i >= 0; i--) {
        if (composed.messages[i]?.role === "user") {
          baseInsertAt = i;
          break;
        }
      }

      if (baseInsertAt === composed.messages.length) {
        return [...composed.messages, ...extraMessages];
      }

      return [
        ...composed.messages.slice(0, baseInsertAt),
        ...extraMessages,
        ...composed.messages.slice(baseInsertAt),
      ];
    })();
    const finalLineage = (() => {
      if (extraCompositions.length === 0) return composed.corePrimaryLineage;
      if (
        composed.corePrimaryLineage.state !== "complete" ||
        extraCompositions.some((extra) => extra.corePrimaryLineage.state !== "complete")
      ) {
        return createCorePrimaryLineageFreshOnlyV1(
          "deferred-batch-incomplete-lineage",
          Math.min(baseInsertAt, composed.corePrimaryLineage.currentCanonicalStart),
        );
      }
      const baseSegments = composed.corePrimaryLineage.segments;
      const insertSegmentIndex =
        baseInsertAt === composed.messages.length
          ? baseSegments.length
          : baseSegments.findIndex((segment) => segment.canonicalStart === baseInsertAt);
      if (insertSegmentIndex < 0) {
        return createCorePrimaryLineageFreshOnlyV1(
          "deferred-batch-unaligned-insertion",
          composed.corePrimaryLineage.currentCanonicalStart,
        );
      }
      const extraSegments = extraCompositions.flatMap((extra) =>
        extra.corePrimaryLineage.state === "complete" ? extra.corePrimaryLineage.segments : [],
      );
      const combinedSegments = [
        ...baseSegments.slice(0, insertSegmentIndex),
        ...extraSegments,
        ...baseSegments.slice(insertSegmentIndex),
      ];
      const baseCurrentSegment = baseSegments.findIndex(
        (segment) => segment.canonicalStart === composed.corePrimaryLineage.currentCanonicalStart,
      );
      const currentSegmentIndex = Math.min(
        insertSegmentIndex,
        baseCurrentSegment < 0
          ? insertSegmentIndex
          : baseCurrentSegment +
              (insertSegmentIndex <= baseCurrentSegment ? extraSegments.length : 0),
      );
      return buildCoreLineageManifestV1(
        combinedSegments.map((segment) => ({
          atoms: segment.atoms,
          canonicalMessages: segment.canonicalMessages,
          ...(segment.requestSource ? { requestSource: segment.requestSource } : {}),
        })),
        { currentSegmentIndex },
      );
    })();

    await publishBusRequest({
      requestId,
      sessionId: input.sessionId,
      sessionConfigId: batch.sessionConfigId,
      parentChannelId: batch.parentChannelId,
      queue: "prompt",
      triggerType: "reply",
      sessionMode: batch.sessionMode,
      modelOverride: batch.modelOverride,
      messages: finalMessages,
      corePrimaryLineage: finalLineage,
      raw: {
        triggerType: "reply",
        chainMessageIds: [...chainMessageIds],
        mergedGroups: composed.mergedGroups,
        participantUserIds: uniqueParticipantUserIds({
          values: [
            ...composed.mergedGroups.map((group) => group.authorId),
            ...batchParticipantUserIds,
          ],
          exclude: self.userId,
        }),
        pendingMentionReplyBatch: {
          sourceRequestId: batch.sourceRequestId,
          size: batch.items.length,
        },
      },
    });
  }

  async function handleActiveDmMode(input: {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
    sessionId: string;
    msgRef: MsgRef;
    userId: string;
    userText: string;
    mentionsBot: boolean;
    replyToBot: boolean;
    replyToMessageId?: string;
    active: ActiveSessionState | undefined;
    sessionMode: SessionMode;
    sessionConfigId: string;
    modelOverride?: string;
    requestModelOverride?: string;
    continueCount?: number;
    botMentionNames: readonly string[];
  }) {
    const {
      adapter,
      bus,
      cfg,
      sessionId,
      msgRef,
      userText,
      userId: _userId,
      mentionsBot,
      replyToBot,
      active,
      sessionMode,
      sessionConfigId,
      modelOverride,
      requestModelOverride,
      continueCount,
      botMentionNames,
    } = input;

    const modelOverrideTransform = requestModelOverride
      ? (text: string) =>
          stripLeadingModelOverrideDirective({
            text,
            botNames: botMentionNames,
          })
      : undefined;
    const continueDirectiveTransform = stripCurrentContinueDirective({
      text: userText,
      botNames: botMentionNames,
      continueCount,
    });

    if (active && requestModelOverride) {
      await publishActiveChannelPrompt({
        adapter,
        bus,
        cfg,
        requestId: formatDiscordMessageRequestId({
          channelId: sessionId,
          messageId: msgRef.messageId,
        }),
        sessionId,
        triggerMsgRef: msgRef,
        triggerType: resolveTriggerType({ replyToBot, mentionsBot }),
        sessionMode,
        sessionConfigId,
        modelOverride: requestModelOverride,
        botMentionNames,
        transformTriggerUserText: combineTextTransforms(
          modelOverrideTransform,
          continueDirectiveTransform,
        ),
        transformUserTextForMessageId: msgRef.messageId,
        markActive: false,
      });
      return;
    }

    if (active) {
      // While a request is running:
      // - Replies to the active output message chain stay in the active request.
      //   - reply + mention => steer (plus output reanchor)
      //   - reply only => followUp
      // - Replies to other bot messages fork into a queued-behind prompt.
      // - Everything else becomes a follow-up into the running request.
      const isReplyToActiveOutput =
        replyToBot &&
        typeof input.replyToMessageId === "string" &&
        active.activeOutputMessageIds.has(input.replyToMessageId);

      if (isReplyToActiveOutput) {
        if (mentionsBot) {
          const steerMode = parseSteerDirectiveMode({
            text: userText,
            botNames: botMentionNames,
          });

          await publishSurfaceOutputReanchor({
            bus,
            requestId: active.requestId,
            sessionId,
            inheritReplyTo: false,
            replyTo: msgRef,
            mode: steerMode,
          });
          active.activeOutputMessageIds.clear();

          await publishSingleMessageToActiveRequest({
            adapter,
            bus,
            cfg,
            requestId: active.requestId,
            sessionId,
            queue: steerMode,
            msgRef,
            sessionMode,
            sessionConfigId,
            modelOverride,
            transformUserText: combineTextTransforms(
              modelOverrideTransform,
              continueDirectiveTransform,
              steerMode === "interrupt"
                ? (text) =>
                    stripLeadingInterruptDirective({
                      text,
                      botNames: botMentionNames,
                    })
                : undefined,
            ),
          });
          return;
        }

        await publishSingleMessageToActiveRequest({
          adapter,
          bus,
          cfg,
          requestId: active.requestId,
          sessionId,
          queue: "followUp",
          msgRef,
          sessionMode,
          sessionConfigId,
          modelOverride,
          transformUserText: combineTextTransforms(
            modelOverrideTransform,
            continueDirectiveTransform,
          ),
        });
        return;
      }

      if (replyToBot) {
        const requestId = formatDiscordMessageRequestId({
          channelId: sessionId,
          messageId: msgRef.messageId,
        });

        await publishActiveChannelPrompt({
          adapter,
          bus,
          cfg,
          requestId,
          sessionId,
          triggerMsgRef: msgRef,
          triggerType: "reply",
          sessionMode,
          sessionConfigId,
          modelOverride,
          botMentionNames,
          transformTriggerUserText: combineTextTransforms(
            modelOverrideTransform,
            continueDirectiveTransform,
          ),
          transformUserTextForMessageId: msgRef.messageId,
          markActive: false,
        });
        return;
      }

      await publishSingleMessageToActiveRequest({
        adapter,
        bus,
        cfg,
        requestId: active.requestId,
        sessionId,
        queue: "followUp",
        msgRef,
        sessionMode,
        sessionConfigId,
        modelOverride,
        transformUserText: continueDirectiveTransform,
      });
      return;
    }

    const requestId = formatDiscordMessageRequestId({
      channelId: sessionId,
      messageId: msgRef.messageId,
    });

    const triggerType = resolveTriggerType({ replyToBot, mentionsBot });

    // DMs are ungated: start a new request immediately.
    await publishActiveChannelPrompt({
      adapter,
      bus,
      cfg,
      requestId,
      sessionId,
      triggerMsgRef: msgRef,
      triggerType,
      sessionMode,
      sessionConfigId,
      modelOverride,
      botMentionNames,
      transformTriggerUserText: combineTextTransforms(
        modelOverrideTransform,
        continueDirectiveTransform,
      ),
      transformUserTextForMessageId: msgRef.messageId,
      markActive: true,
    });
  }

  async function handleActiveChannelMode(input: {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
    buffers: Map<string, DebounceBuffer>;
    sessionId: string;
    msgRef: MsgRef;
    userId: string;
    userText: string;
    messageTs: number;
    mentionsBot: boolean;
    replyToBot: boolean;
    replyToMessageId?: string;
    botUserId?: string;
    parentChannelId?: string;
    active: ActiveSessionState | undefined;
    sessionMode: SessionMode;
    sessionConfigId: string;
    modelOverride?: string;
    requestModelOverride?: string;
    continueCount?: number;
    botMentionNames: readonly string[];
  }) {
    const {
      adapter,
      bus,
      cfg,
      buffers,
      sessionId,
      msgRef,
      userId,
      userText,
      messageTs,
      mentionsBot,
      replyToBot,
      botUserId,
      parentChannelId,
      active,
      sessionMode,
      sessionConfigId,
      modelOverride,
      requestModelOverride,
      continueCount,
      botMentionNames,
    } = input;
    const hasReplyTarget =
      typeof input.replyToMessageId === "string" && input.replyToMessageId.trim().length > 0;

    const modelOverrideTransform = requestModelOverride
      ? (text: string) =>
          stripLeadingModelOverrideDirective({
            text,
            botNames: botMentionNames,
          })
      : undefined;
    const continueDirectiveTransform = stripCurrentContinueDirective({
      text: userText,
      botNames: botMentionNames,
      continueCount,
    });

    if (active && requestModelOverride) {
      await publishActiveChannelPrompt({
        adapter,
        bus,
        cfg,
        requestId: formatDiscordMessageRequestId({
          channelId: sessionId,
          messageId: msgRef.messageId,
        }),
        sessionId,
        triggerMsgRef: msgRef,
        triggerType: resolveTriggerType({ replyToBot, mentionsBot }),
        sessionMode,
        sessionConfigId,
        parentChannelId,
        modelOverride: requestModelOverride,
        botMentionNames,
        transformTriggerUserText: combineTextTransforms(
          modelOverrideTransform,
          continueDirectiveTransform,
        ),
        transformUserTextForMessageId: msgRef.messageId,
        markActive: false,
      });
      return;
    }

    if (active) {
      // Active channels behave like group chats while a request is running.
      // - Replies to the active output message chain stay in the active request.
      //   - reply + mention => steer (plus output reanchor)
      //   - reply only => followUp
      // - Mentions (not replies) can steer the active request (plus output reanchor).
      // - Replies to other bot messages fork into a queued-behind prompt.
      // - Everything else becomes a follow-up into the running request.
      const routeDecision = decideActiveRequestRoute({
        activeOutputMessageIds: active.activeOutputMessageIds,
        replyToBot,
        mentionsBot,
        replyToMessageId: input.replyToMessageId,
        userText,
        botMentionNames,
        allowMentionSteer: true,
        plainMessageBehavior: "buffered_prompt",
      });

      switch (routeDecision.kind) {
        case "active_output_steer":
        case "active_mention_steer": {
          await publishSurfaceOutputReanchor({
            bus,
            requestId: active.requestId,
            sessionId,
            inheritReplyTo: routeDecision.inheritReplyTo,
            ...(routeDecision.inheritReplyTo ? {} : { replyTo: msgRef }),
            mode: routeDecision.queue,
          });
          active.activeOutputMessageIds.clear();

          await publishSingleMessageToActiveRequest({
            adapter,
            bus,
            cfg,
            requestId: active.requestId,
            sessionId,
            queue: routeDecision.queue,
            msgRef,
            sessionMode,
            sessionConfigId,
            parentChannelId,
            modelOverride,
            transformUserText: combineTextTransforms(
              modelOverrideTransform,
              continueDirectiveTransform,
              routeDecision.queue === "interrupt"
                ? (text) =>
                    stripLeadingInterruptDirective({
                      text,
                      botNames: botMentionNames,
                    })
                : undefined,
            ),
          });
          return;
        }
        case "active_output_follow_up":
        case "plain_follow_up": {
          await publishSingleMessageToActiveRequest({
            adapter,
            bus,
            cfg,
            requestId: active.requestId,
            sessionId,
            queue: "followUp",
            msgRef,
            sessionMode,
            sessionConfigId,
            parentChannelId,
            modelOverride,
            transformUserText: combineTextTransforms(
              modelOverrideTransform,
              continueDirectiveTransform,
            ),
          });
          return;
        }
        case "fork_reply_prompt": {
          const requestId = formatDiscordMessageRequestId({
            channelId: sessionId,
            messageId: msgRef.messageId,
          });

          await publishActiveChannelPrompt({
            adapter,
            bus,
            cfg,
            requestId,
            sessionId,
            triggerMsgRef: msgRef,
            triggerType: "reply",
            sessionMode,
            sessionConfigId,
            parentChannelId,
            botMentionNames,
            transformTriggerUserText: combineTextTransforms(
              modelOverrideTransform,
              continueDirectiveTransform,
            ),
            transformUserTextForMessageId: msgRef.messageId,
            modelOverride,
            markActive: false,
          });
          return;
        }
        case "buffered_prompt": {
          await publishSingleMessagePrompt({
            adapter,
            bus,
            cfg,
            requestId: bufferedPromptRequestIdForActiveRequest(active.requestId),
            sessionId,
            sessionConfigId,
            parentChannelId,
            msgRef,
            sessionMode,
            modelOverride,
            transformUserText: combineTextTransforms(
              modelOverrideTransform,
              continueDirectiveTransform,
            ),
            raw: {
              bufferedForActiveRequestId: active.requestId,
            },
          });
          return;
        }
      }
    }

    // No active request.
    if (continueCount !== undefined && !mentionsBot && !replyToBot && !hasReplyTarget) {
      clearDebounceBuffer(sessionId);

      await publishActiveChannelPrompt({
        adapter,
        bus,
        cfg,
        requestId: randomRequestId(),
        sessionId,
        triggerMsgRef: msgRef,
        triggerType: undefined,
        sessionMode,
        sessionConfigId,
        parentChannelId,
        modelOverride,
        botMentionNames,
        transformTriggerUserText: combineTextTransforms(
          modelOverrideTransform,
          continueDirectiveTransform,
        ),
        transformUserTextForMessageId: msgRef.messageId,
        markActive: true,
      });
      return;
    }

    if (mentionsBot || replyToBot) {
      // Mention/reply is a bypass trigger.
      // Discard any pending buffer to avoid a second gated request for the same context.
      clearDebounceBuffer(sessionId);

      const triggerType: "mention" | "reply" = replyToBot ? "reply" : "mention";
      const requestId = formatDiscordMessageRequestId({
        channelId: sessionId,
        messageId: msgRef.messageId,
      });

      await publishActiveChannelPrompt({
        adapter,
        bus,
        cfg,
        requestId,
        sessionId,
        triggerMsgRef: msgRef,
        triggerType,
        sessionMode,
        sessionConfigId,
        parentChannelId,
        modelOverride,
        botMentionNames,
        transformTriggerUserText: combineTextTransforms(
          modelOverrideTransform,
          continueDirectiveTransform,
        ),
        transformUserTextForMessageId: msgRef.messageId,
        markActive: true,
      });
      return;
    }

    bufferActiveChannelMessage({
      buffers,
      cfg,
      sessionId,
      sessionConfigId,
      parentChannelId,
      message: {
        msgRef,
        userId,
        text: userText,
        ts: messageTs,
        mentionsBot,
        replyToBot,
        botUserId,
        sessionModelOverride: modelOverride,
        requestModelOverride,
      },
    });
  }

  function bufferActiveChannelMessage(input: {
    buffers: Map<string, DebounceBuffer>;
    cfg: CoreConfig;
    sessionId: string;
    sessionConfigId: string;
    parentChannelId?: string;
    message: BufferedMessage;
  }) {
    const { buffers, cfg, sessionId, sessionConfigId, parentChannelId, message } = input;

    const existing = buffers.get(sessionId);
    if (!existing) {
      logger.debug("router debounce start", {
        sessionId,
        debounceMs: cfg.surface.router.activeDebounceMs,
      });

      const buffer: DebounceBuffer = {
        sessionId,
        sessionConfigId,
        parentChannelId,
        messages: [message],
        timer: null,
      };

      buffer.timer = setTimeout(() => {
        void runDebounceTimer(sessionId);
      }, cfg.surface.router.activeDebounceMs);

      buffers.set(sessionId, buffer);
      return;
    }

    existing.messages.push(message);
  }

  async function runDebounceTimer(sessionId: string): Promise<void> {
    const flushed = await captureRouterDebounceFlush({
      sessionId,
      operation: () => flushDebounce(sessionId),
      reportFatalPanic: debounceDefect.reject,
    });
    if (flushed.status === "error") {
      logger.error("router flushDebounce failed", { sessionId }, flushed.error.cause);
    }
  }

  async function flushDebounce(sessionId: string): Promise<void> {
    const b = buffers.get(sessionId);
    if (!b) return;
    clearDebounceBuffer(sessionId);

    // Gate is only for active channels with no running request.
    const gateEnabled = resolveSessionGateEnabled(cfg, b.sessionId, b.parentChannelId);
    const previousMessageText = gateEnabled
      ? await resolvePreviousBatchMessageText(b.messages)
      : undefined;

    let decision: RouterGateDecision = { forward: true, reason: "disabled" };
    if (gateEnabled) {
      const evaluated = await captureRouterActiveBatchGate(sessionId, () =>
        evaluateRouterGate({
          sessionId,
          botName: cfg.surface.discord.botName,
          messages: b.messages,
          context: {
            mode: "active-batch",
            previousMessageText,
          },
        }),
      );
      if (evaluated.status === "error") {
        logger.error(
          "router gate failed; skipping",
          { sessionId, ...extractAiErrorLogDetails(evaluated.error.cause) },
          evaluated.error.cause,
        );
        decision = { forward: false, reason: "error" };
      } else {
        decision = evaluated.value;
      }
    }

    if (!decision.forward) {
      logger.info("router.route.decision", {
        sessionId,
        mode: "active",
        gateEnabled,
        decision: "skip",
        reason: `active_batch_gate:${decision.reason ?? "skip"}`,
        messageCount: b.messages.length,
      });
      return;
    }

    logger.info("router.route.decision", {
      sessionId,
      mode: "active",
      gateEnabled,
      decision: "forward",
      reason: `active_batch_gate:${decision.reason ?? "forward"}`,
      messageCount: b.messages.length,
    });

    const overrideCarrier = (() => {
      for (let i = b.messages.length - 1; i >= 0; i--) {
        const requestOverride = b.messages[i]?.requestModelOverride;
        if (requestOverride) {
          const messageId = b.messages[i]?.msgRef.messageId;
          if (messageId) {
            return {
              model: requestOverride,
              messageId,
              botUserId: b.messages[i]?.botUserId,
            };
          }
          return {
            model: requestOverride,
            messageId: undefined,
            botUserId: b.messages[i]?.botUserId,
          };
        }
      }
      return undefined;
    })();
    const modelOverride =
      overrideCarrier?.model ?? b.messages[b.messages.length - 1]?.sessionModelOverride;
    const self = await adapter.getSelf();

    // Gate-forwarded prompt: do NOT reply-to a message.
    // Use newest message as the context anchor.
    await publishActiveChannelPrompt({
      adapter,
      bus,
      cfg,
      requestId: randomRequestId(),
      sessionId,
      sessionConfigId: b.sessionConfigId,
      parentChannelId: b.parentChannelId,
      // Use newest message as the context anchor (not a reply trigger).
      triggerMsgRef: b.messages[b.messages.length - 1]?.msgRef,
      currentMessageIds: b.messages.map((message) => message.msgRef.messageId),
      triggerType: undefined,
      sessionMode: "active",
      modelOverride,
      botMentionNames: resolveBotMentionNames({
        cfg,
        botUserId:
          overrideCarrier?.botUserId ?? b.messages[b.messages.length - 1]?.botUserId ?? self.userId,
      }),
      transformTriggerUserText: overrideCarrier
        ? (text: string) =>
            stripLeadingModelOverrideDirective({
              text,
              botNames: resolveBotMentionNames({ cfg, botUserId: overrideCarrier?.botUserId }),
            })
        : undefined,
      transformUserTextForMessageId: overrideCarrier?.messageId,
      markActive: true,
    });
  }

  async function handleMentionMode(input: {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
    activeBySession: Map<string, ActiveSessionState>;
    sessionId: string;
    msgRef: MsgRef;
    userId: string;
    userText: string;
    mentionsBot?: boolean;
    replyToBot?: boolean;
    replyToMessageId?: string;
    active: ActiveSessionState | undefined;
    parentChannelId?: string;
    sessionMode: SessionMode;
    sessionConfigId: string;
    modelOverride?: string;
    requestModelOverride?: string;
    continueCount?: number;
    botMentionNames: readonly string[];
  }) {
    const {
      adapter,
      bus,
      cfg,
      activeBySession,
      sessionId,
      msgRef,
      userId,
      userText,
      mentionsBot,
      replyToBot,
      active,
      parentChannelId,
      requestModelOverride,
      continueCount,
      botMentionNames,
    } = input;

    const modelOverrideTransform = requestModelOverride
      ? (text: string) =>
          stripLeadingModelOverrideDirective({
            text,
            botNames: botMentionNames,
          })
      : undefined;
    const continueDirectiveTransform = stripCurrentContinueDirective({
      text: userText,
      botNames: botMentionNames,
      continueCount,
    });

    const triggerType = resolveTriggerType({ replyToBot, mentionsBot }) ?? null;

    if (!triggerType) {
      // Mention-only channels: ignore non-triggers (even if a request is active).
      logger.debug("router.route.decision", {
        sessionId,
        mode: input.sessionMode,
        gateEnabled: false,
        decision: "skip",
        reason: "mention_mode_non_trigger",
        activeRequestId: active?.requestId,
      });
      return;
    }

    const requestId = formatDiscordMessageRequestId({
      channelId: sessionId,
      messageId: msgRef.messageId,
    });

    if (active && requestModelOverride) {
      await publishComposedRequest({
        adapter,
        bus,
        cfg,
        requestId,
        sessionId,
        queue: "prompt",
        triggerType,
        msgRef,
        userId,
        sessionMode: input.sessionMode,
        sessionConfigId: input.sessionConfigId,
        parentChannelId,
        modelOverride: requestModelOverride,
        transformTriggerUserText: combineTextTransforms(
          modelOverrideTransform,
          continueDirectiveTransform,
        ),
        transformUserTextForMessageId: msgRef.messageId,
      });
      return;
    }

    // Special case: if the user is replying to the currently active output message chain,
    // treat mention replies as steer/interrupt into the running request, and
    // queue plain replies into a deferred prompt batch.
    if (
      active &&
      replyToBot &&
      typeof input.replyToMessageId === "string" &&
      active.activeOutputMessageIds.has(input.replyToMessageId)
    ) {
      if (mentionsBot) {
        const steerMode = parseSteerDirectiveMode({
          text: userText,
          botNames: botMentionNames,
        });

        await publishSurfaceOutputReanchor({
          bus,
          requestId: active.requestId,
          sessionId,
          inheritReplyTo: false,
          replyTo: msgRef,
          mode: steerMode,
        });
        active.activeOutputMessageIds.clear();

        await publishSingleMessageToActiveRequest({
          adapter,
          bus,
          cfg,
          requestId: active.requestId,
          sessionId,
          queue: steerMode,
          msgRef,
          sessionMode: input.sessionMode,
          sessionConfigId: input.sessionConfigId,
          parentChannelId,
          modelOverride: input.modelOverride,
          transformUserText: combineTextTransforms(
            modelOverrideTransform,
            continueDirectiveTransform,
            steerMode === "interrupt"
              ? (text) =>
                  stripLeadingInterruptDirective({
                    text,
                    botNames: botMentionNames,
                  })
              : undefined,
          ),
        });

        await flushPendingMentionReplyBatchAsFollowUp({
          sessionId,
          sourceRequestId: active.requestId,
        });
      } else {
        enqueuePendingMentionReplyBatch({
          sessionId,
          sourceRequestId: active.requestId,
          sessionConfigId: input.sessionConfigId,
          parentChannelId,
          sessionMode: input.sessionMode,
          modelOverride: input.modelOverride,
          item: {
            msgRef,
            requestModelOverride,
            continueCount,
            botMentionNames,
          },
        });
      }
      return;
    }

    if (!active) {
      // Optimistically mark active to avoid a brief window before lifecycle updates.
      activeBySession.set(sessionId, {
        requestId,
        activeOutputMessageIds: new Set(),
      });
    }

    // Triggers always start a new request. If a request is running, the runner will queue it.
    await publishComposedRequest({
      adapter,
      bus,
      cfg,
      requestId,
      sessionId,
      queue: "prompt",
      triggerType,
      msgRef,
      userId,
      sessionMode: input.sessionMode,
      sessionConfigId: input.sessionConfigId,
      parentChannelId,
      modelOverride: input.modelOverride,
      transformTriggerUserText: combineTextTransforms(
        modelOverrideTransform,
        continueDirectiveTransform,
      ),
      transformUserTextForMessageId: msgRef.messageId,
    });
  }

  async function publishBusRequest(input: PublishBusRequestInput) {
    await publishBusRequestImpl({ logger, bus, input });
  }

  type PublishComposedLocalInput = Parameters<typeof publishComposedRequestImpl>[0]["input"] & {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
  };

  async function publishComposedRequest(input: PublishComposedLocalInput) {
    const { adapter, bus, cfg, ...requestInput } = input;
    await publishComposedRequestImpl({
      adapter,
      bus,
      cfg,
      transcriptStore: params.transcriptStore,
      logger,
      input: requestInput,
    });
  }

  type PublishActiveChannelPromptLocalInput = Parameters<
    typeof publishActiveChannelPromptImpl
  >[0]["input"] & {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
    markActive: boolean;
  };

  async function publishActiveChannelPrompt(input: PublishActiveChannelPromptLocalInput) {
    const { adapter, bus, cfg, markActive, ...requestInput } = input;
    await publishActiveChannelPromptImpl({
      adapter,
      bus,
      cfg,
      transcriptStore: params.transcriptStore,
      logger,
      input: requestInput,
    });

    if (markActive) {
      activeBySession.set(input.sessionId, {
        requestId: input.requestId,
        activeOutputMessageIds: new Set(),
      });
    }
  }

  type PublishSingleMessageToActiveRequestLocalInput = Parameters<
    typeof publishSingleMessageToActiveRequestImpl
  >[0]["input"] & {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
  };

  async function publishSingleMessageToActiveRequest(
    input: PublishSingleMessageToActiveRequestLocalInput,
  ) {
    const { adapter, bus, cfg, ...requestInput } = input;
    await publishSingleMessageToActiveRequestImpl({
      adapter,
      bus,
      cfg,
      transcriptStore: params.transcriptStore,
      logger,
      input: requestInput,
    });
  }

  type PublishSingleMessagePromptLocalInput = Parameters<
    typeof publishSingleMessagePromptImpl
  >[0]["input"] & {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
  };

  async function publishSingleMessagePrompt(input: PublishSingleMessagePromptLocalInput) {
    const { adapter, bus, cfg, ...requestInput } = input;
    await publishSingleMessagePromptImpl({
      adapter,
      bus,
      cfg,
      transcriptStore: params.transcriptStore,
      logger,
      input: requestInput,
    });
  }

  async function publishSurfaceOutputReanchor(
    input: Parameters<typeof publishSurfaceOutputReanchorImpl>[0],
  ) {
    await publishSurfaceOutputReanchorImpl(input);
  }

  const subscriptions = [adapterSub, lifecycleSub, surfaceSub] as const;
  const done = Promise.race([
    superviseRouterSubscriptionsDone(subscriptions),
    debounceDefect.promise,
  ]);

  return {
    done,
    stop: async () => {
      try {
        await adaptRouterSubscriptionsStop(subscriptions);
      } finally {
        for (const b of buffers.values()) {
          if (b.timer) clearTimeout(b.timer);
        }
        buffers.clear();
        pendingMentionReplyBatchBySession.clear();
      }
    },
  };
}
