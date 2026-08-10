import {
  lilacEventTypes,
  outReqTopic,
  type DeliveryDisposition,
  type EventDeliveryDoneError,
  type EventDeliveryStartFailed,
  type EventDeliveryStopFailed,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import { createLogger, env, formatTaggedErrorForLog } from "@stanley2058/lilac-utils";
import type { Logger } from "@stanley2058/simple-module-logger";

import type {
  SurfaceFinalTextMode,
  SurfaceAdapter,
  SurfaceOutputPart,
  SurfaceOutputPartDisposition,
  SurfaceOutputResult,
  SurfaceOperationError,
  SurfaceOperationResult,
  StartOutputOpts,
  SurfaceToolStatusUpdate,
  TypingIndicatorSubscription,
} from "../adapter";
import type { MsgRef, SessionRef, SurfaceAttachment } from "../types";
import type {
  RegisteredSurfacePlatform,
  SurfaceIngressAcknowledgementCleanupFailed,
  SurfaceRelayPolicy,
  SurfaceRelaySnapshotFor,
  SurfaceReplyTargetInvalid,
  SurfaceRefInvalid,
} from "../runtime-descriptor";
import { requireSurfaceRelayPolicyRefs, requireSurfaceRelaySnapshot } from "../produced-ref-guard";
import { mergeSubagentToolStatus } from "../subagent-tool-status";

import { parseRequestControlFromRaw } from "./bus-agent-runner/raw";
import { isPossibleNoReplyPrefix, resolveReplyDeliveryFromFinalText } from "./reply-directive";

import type { TranscriptStore } from "../../transcript/transcript-store";
import { adaptEventPublishResultToHost } from "../../shared/event-bus-result";
import { formatBridgeTaggedErrorForLog } from "./bridge-log";

class CmdRequestRequiredHeadersMissing extends TaggedError("CmdRequestRequiredHeadersMissing")<{
  readonly message: string;
}> {}

class CmdRequestCancelFailed extends TaggedError("CmdRequestCancelFailed")<{
  readonly cause: BusToAdapterEffectFailed;
  readonly message: string;
}> {}

class RelayEventCorrelationInvalid extends TaggedError("RelayEventCorrelationInvalid")<{
  readonly messageType: string;
  readonly message: string;
}> {}

type CmdRequestDeliveryError =
  | CmdRequestRequiredHeadersMissing
  | CmdRequestCancelFailed
  | RelayEventCorrelationInvalid;

function applyCmdRequestDeliveryPolicy(error: CmdRequestDeliveryError): DeliveryDisposition {
  switch (error._tag) {
    case "CmdRequestRequiredHeadersMissing":
      return "park-pending";
    case "CmdRequestCancelFailed":
      return "commit";
    case "RelayEventCorrelationInvalid":
      return "dead-letter";
  }
}

class CmdSurfaceRequiredHeadersMissing extends TaggedError("CmdSurfaceRequiredHeadersMissing")<{
  readonly message: string;
}> {}

class CmdSurfaceReanchorFailed extends TaggedError("CmdSurfaceReanchorFailed")<{
  readonly cause: BusToAdapterEffectFailed;
  readonly message: string;
}> {}

class CmdSurfaceReplyTargetInvalid extends TaggedError("CmdSurfaceReplyTargetInvalid")<{
  readonly cause: SurfaceRefInvalid;
  readonly message: string;
}> {}

type CmdSurfaceDeliveryError =
  | CmdSurfaceRequiredHeadersMissing
  | CmdSurfaceReanchorFailed
  | CmdSurfaceReplyTargetInvalid
  | RelayEventCorrelationInvalid;

function applyCmdSurfaceDeliveryPolicy(error: CmdSurfaceDeliveryError): DeliveryDisposition {
  switch (error._tag) {
    case "CmdSurfaceRequiredHeadersMissing":
      return "park-pending";
    case "CmdSurfaceReanchorFailed":
    case "CmdSurfaceReplyTargetInvalid":
      return "commit";
    case "RelayEventCorrelationInvalid":
      return "dead-letter";
  }
}

class EvtRequestRequiredHeadersMissing extends TaggedError("EvtRequestRequiredHeadersMissing")<{
  readonly message: string;
}> {}

class EvtRequestStopTypingFailed extends TaggedError("EvtRequestStopTypingFailed")<{
  readonly cause: BusToAdapterEffectFailed;
  readonly message: string;
}> {}

class EvtRequestReplyTargetInvalid extends TaggedError("EvtRequestReplyTargetInvalid")<{
  readonly cause: SurfaceReplyTargetInvalid;
  readonly message: string;
}> {}

type EvtRequestDeliveryError =
  | EvtRequestRequiredHeadersMissing
  | EvtRequestStopTypingFailed
  | EvtRequestReplyTargetInvalid
  | RelayEventCorrelationInvalid;

function applyEvtRequestDeliveryPolicy(error: EvtRequestDeliveryError): DeliveryDisposition {
  switch (error._tag) {
    case "EvtRequestRequiredHeadersMissing":
      return "park-pending";
    case "EvtRequestReplyTargetInvalid":
      return "dead-letter";
    case "EvtRequestStopTypingFailed":
      return "commit";
    case "RelayEventCorrelationInvalid":
      return "dead-letter";
  }
}

class OutReqPushFailed extends TaggedError("OutReqPushFailed")<{
  readonly cause: BusToAdapterEffectFailed;
  readonly message: string;
}> {}

class OutReqFinishFailed extends TaggedError("OutReqFinishFailed")<{
  readonly cause: BusToAdapterEffectFailed;
  readonly message: string;
}> {}

type OutReqDeliveryError = OutReqPushFailed | OutReqFinishFailed | RelayEventCorrelationInvalid;

type BusToAdapterEffect =
  | "abort-output"
  | "cancel-active-relay"
  | "cleanup-skipped-output"
  | "clear-ingress-acknowledgement"
  | "delete-transcript-checkpoint"
  | "finish-output"
  | "link-transcript"
  | "publish-output-created"
  | "push-output"
  | "reanchor-output"
  | "start-output"
  | "start-typing"
  | "stop-output-subscription"
  | "stop-relay"
  | "stop-typing";

export class BusToAdapterEffectFailed extends TaggedError("BusToAdapterEffectFailed")<{
  readonly operation: BusToAdapterEffect;
  readonly failureKind: "external-effect" | "partial-completion" | "permanent" | "transient";
  readonly surfaceErrorTag: SurfaceOperationError["_tag"] | null;
  readonly created: MsgRef | null;
  readonly cause: unknown;
  readonly message: string;
}> {}

function applyOutReqDeliveryPolicy(error: OutReqDeliveryError): DeliveryDisposition {
  switch (error._tag) {
    case "OutReqPushFailed":
    case "OutReqFinishFailed":
      return "stop";
    case "RelayEventCorrelationInvalid":
      return "dead-letter";
  }
}

type ResultSubscription = {
  readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
  stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
};

export function rethrowBusToAdapterPanic(cause: unknown): void {
  if (Panic.is(cause)) throw cause;
}

export async function captureBusToAdapterEffect<T>(
  operation: BusToAdapterEffect,
  effect: () => Promise<T>,
): Promise<ResultType<T, BusToAdapterEffectFailed>> {
  try {
    return Result.ok(await effect());
  } catch (cause) {
    rethrowBusToAdapterPanic(cause);
    if (cause instanceof BusToAdapterEffectFailed) return Result.err(cause);
    return Result.err(
      new BusToAdapterEffectFailed({
        operation,
        failureKind: "external-effect",
        surfaceErrorTag: null,
        created: null,
        cause,
        message: `Bus-to-adapter effect failed: ${operation}`,
      }),
    );
  }
}

function classifySurfaceOperationForRelay(
  operation: BusToAdapterEffect,
  error: SurfaceOperationError,
): BusToAdapterEffectFailed {
  switch (error._tag) {
    case "SurfaceOperationUnsupported":
    case "SurfacePlatformMismatch":
    case "SurfaceSessionMismatch":
    case "SurfaceInvalidInput":
    case "SurfaceMessageNotFound":
    case "SurfacePermissionDenied":
      return new BusToAdapterEffectFailed({
        operation,
        failureKind: "permanent",
        surfaceErrorTag: error._tag,
        created: null,
        cause: { errorTag: error._tag },
        message: `Surface relay operation '${operation}' was rejected permanently (${error._tag})`,
      });
    case "SurfaceRateLimited":
    case "SurfaceUnavailable":
      return new BusToAdapterEffectFailed({
        operation,
        failureKind: "transient",
        surfaceErrorTag: error._tag,
        created: null,
        cause:
          error._tag === "SurfaceRateLimited"
            ? { errorTag: error._tag, retryAfterMs: error.retryAfterMs }
            : { errorTag: error._tag },
        message: `Surface relay operation '${operation}' failed transiently (${error._tag})`,
      });
    case "SurfaceOperationPartiallyCompleted":
      return new BusToAdapterEffectFailed({
        operation,
        failureKind: "partial-completion",
        surfaceErrorTag: error._tag,
        created: error.created,
        cause: { errorTag: error._tag },
        message: `Surface relay operation '${operation}' partially completed`,
      });
  }
}

export function adaptSurfaceOperationToRelay<T>(
  operation: BusToAdapterEffect,
  result: SurfaceOperationResult<T>,
): T {
  if (result.status === "ok") return result.value;
  throw classifySurfaceOperationForRelay(operation, result.error);
}

export function adaptBusToAdapterSubscriptionStart(
  started: ResultType<ResultSubscription, EventDeliveryStartFailed>,
): ResultSubscription {
  if (started.status === "error") throw started.error;
  return started.value;
}

export function adaptBusToAdapterSubscriptionStop(
  stopped: ResultType<void, EventDeliveryStopFailed>,
): void {
  if (stopped.status === "error") throw stopped.error;
}

export async function superviseBusToAdapterCleanup(
  effects: readonly (() => Promise<void>)[],
): Promise<void> {
  let failure: { readonly cause: unknown; readonly panic: boolean } | null = null;
  for (const effect of effects) {
    try {
      await effect();
    } catch (cause) {
      const panic = Panic.is(cause);
      if (failure === null || (panic && !failure.panic)) failure = { cause, panic };
    }
  }
  if (failure !== null) throw failure.cause;
}

async function runBusToAdapterBestEffort(input: {
  operation: BusToAdapterEffect;
  effect: () => Promise<void>;
  logger?: Logger;
  logLevel?: "debug" | "warn" | "error";
  logMessage?: string;
  context?: Readonly<Record<string, string | number | boolean | undefined>>;
}): Promise<void> {
  const result = await captureBusToAdapterEffect(input.operation, input.effect);
  if (result.status === "ok" || !input.logger || !input.logLevel || !input.logMessage) return;
  input.logger[input.logLevel](
    input.logMessage,
    formatBridgeTaggedErrorForLog(result.error, input.context),
  );
}

export function logIngressAcknowledgementCleanupFailure(input: {
  readonly logger: Pick<Logger, "warn">;
  readonly error: SurfaceIngressAcknowledgementCleanupFailed;
  readonly requestId: string;
  readonly sessionId: string;
}): void {
  input.logger.warn(
    "failed to clear ingress acknowledgement",
    formatBridgeTaggedErrorForLog(input.error, {
      requestId: input.requestId,
      sessionId: input.sessionId,
      causeErrorTag: input.error.cause.errorTag,
      causeErrorMessage: input.error.cause.errorMessage,
    }),
  );
}

function observeSubscriptionDone(
  subscription: ResultSubscription,
  topic: string,
  logger: Logger,
): void {
  void subscription.done.then((done) => {
    if (done.status === "ok") return;
    logger.error(
      "event subscription stopped",
      formatBridgeTaggedErrorForLog(done.error, { topic }),
    );
  });
}

async function stopResultSubscription(subscription: ResultSubscription): Promise<void> {
  adaptBusToAdapterSubscriptionStop(await subscription.stop());
}

function getConsumerId(prefix: string): string {
  return `${prefix}:${process.pid}:${Math.random().toString(16).slice(2)}`;
}

function scheduleTimeout(callback: () => void, delayMs: number): () => void {
  const timeout = setTimeout(callback, delayMs);
  return () => clearTimeout(timeout);
}

function parseRouterSessionMode(raw: string | undefined): "mention" | "active" | undefined {
  if (raw === "mention" || raw === "active") return raw;
  return undefined;
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  // Bun provides Buffer.
  const buf = Buffer.from(base64, "base64");
  return new Uint8Array(buf);
}

function toAttachment(params: {
  mimeType: string;
  dataBase64: string;
  filename?: string;
}): SurfaceAttachment {
  const kind: SurfaceAttachment["kind"] = params.mimeType.startsWith("image/") ? "image" : "file";

  const filename = params.filename ?? (kind === "image" ? "image" : "file");

  return {
    kind,
    mimeType: params.mimeType,
    filename,
    bytes: decodeBase64ToBytes(params.dataBase64),
  };
}

const MAX_REASONING_DETAIL_CHARS = 4_000;

function clampReasoningDetail(text: string): string {
  const normalized = text.trim();
  if (normalized.length <= MAX_REASONING_DETAIL_CHARS) return normalized;
  return `${normalized.slice(0, MAX_REASONING_DETAIL_CHARS - 1)}…`;
}

function appendReasoningDetail(base: string, delta: string): string {
  const baseTrimmedEnd = base.replace(/\s+$/u, "");
  const deltaTrimmedStart = delta.replace(/^\s+/u, "");
  const needsSpacer =
    /[\p{L}\p{N}.!?]$/u.test(baseTrimmedEnd) && /^[\p{L}\p{N}]/u.test(deltaTrimmedStart);
  const merged = needsSpacer ? `${baseTrimmedEnd} ${deltaTrimmedStart}` : `${base}${delta}`;
  return clampReasoningDetail(merged);
}

type ActiveRelay = {
  requestId: string;
  sessionId: string;
  platform: RegisteredSurfacePlatform;
  stopTyping(): Promise<void>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
  startedAt: number;
  firstOutLogged: boolean;
  reanchor(input: {
    inheritReplyTo: boolean;
    mode?: "steer" | "interrupt";
    replyTo?: MsgRef;
  }): Promise<void>;
  snapshot(): BusToAdapterRelaySnapshot;
};

export type BusToAdapterRelaySnapshot = {
  requestId: string;
  sessionId: string;
  requestClient?: string;
  platform: RegisteredSurfacePlatform;
  requestStartedAtMs?: number;
  routerSessionMode?: "mention" | "active";
  replyTo?: MsgRef;
  createdOutputRefs: MsgRef[];
  activeOutputRefs?: MsgRef[];
  visibleText: string;
  totalTextChars?: number;
  streamTextPrefixChars?: number;
  streamPhaseBoundaryPrefixChars?: number;
  streamPhaseBoundaryOffsetChars?: number;
  streamPhaseBoundaryPrefix?: string;
  awaitingFinalPhaseBoundaryPrefix?: boolean;
  textPhase?: "commentary" | "final_answer";
  commentaryText?: string;
  finalAnswerText?: string;
  phaseSegmentsValid?: boolean;
  reasoning?: {
    startedAtMs: number;
    frozenAtMs?: number;
    detailText: string;
  };
  toolStatus: SurfaceToolStatusUpdate[];
  outCursor?: string;
};

function mergeContinuationText(existing: string, continuation: string): string {
  if (existing.length === 0) return continuation;
  if (continuation.length === 0) return existing;
  if (continuation.startsWith(existing)) return continuation;

  const maxOverlap = Math.min(existing.length, continuation.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const existingSuffix = existing.slice(existing.length - overlap);
    const continuationPrefix = continuation.slice(0, overlap);
    if (existingSuffix === continuationPrefix) {
      return `${existing}${continuation.slice(overlap)}`;
    }
  }

  return `${existing}${continuation}`;
}

export async function bridgeBusToAdapter<P extends RegisteredSurfacePlatform>(params: {
  adapter: SurfaceAdapter;
  bus: LilacBus;
  platform: P;
  policy: SurfaceRelayPolicy<P>;
  subscriptionId: string;
  idleTimeoutMs?: number;
  scheduleIdleTimeout?: (callback: () => void, delayMs: number) => () => void;
  transcriptStore?: TranscriptStore;
}) {
  const logger = createLogger({
    module: "bridge:bus-to-adapter",
  });

  const {
    adapter,
    bus,
    platform,
    subscriptionId,
    idleTimeoutMs = 60 * 60 * 1000,
    scheduleIdleTimeout = scheduleTimeout,
  } = params;
  const policy = requireSurfaceRelayPolicyRefs(platform, params.policy);

  const activeRelays = new Map<string, ActiveRelay>();
  const terminalLifecycleByRequestId = new Map<
    string,
    {
      readonly platform: RegisteredSurfacePlatform;
      readonly sessionId: string;
      readonly at: number;
    }
  >();
  const TERMINAL_LIFECYCLE_TTL_MS = 5 * 60 * 1000;

  const pruneTerminalLifecycleCache = (nowMs: number) => {
    for (const [rid, terminal] of terminalLifecycleByRequestId) {
      if (nowMs - terminal.at > TERMINAL_LIFECYCLE_TTL_MS) {
        terminalLifecycleByRequestId.delete(rid);
      }
    }
  };
  let draining = false;
  let ingressStopped = false;
  const correlationError = (messageType: string) =>
    Result.err(
      new RelayEventCorrelationInvalid({
        messageType,
        message: "Relay event platform or session does not match its request correlation",
      }),
    );
  const matchesRelay = (relay: ActiveRelay, eventPlatform: string, eventSessionId: string) =>
    relay.platform === eventPlatform && relay.sessionId === eventSessionId;

  const cmdRequestStarted = await bus.subscribeTopic(
    "cmd.request",
    {
      mode: "fanout",
      subscriptionId: `${subscriptionId}:cmd_request`,
      consumerId: getConsumerId(`${subscriptionId}:cmd_request`),
      offset: { type: "now" },
      batch: { maxWaitMs: 1000 },
    },
    async (msg): Promise<ResultType<void, CmdRequestDeliveryError>> => {
      if (msg.type !== lilacEventTypes.CmdRequestMessage) {
        return Result.ok(undefined);
      }

      const requestId = msg.headers?.request_id;
      const sessionId = msg.headers?.session_id;
      const requestClient = msg.headers?.request_client;

      if (!requestId || !sessionId || !requestClient) {
        if (requestId && activeRelays.has(requestId)) return correlationError(msg.type);
        logger.warn("relay.event.rejected", {
          requestId,
          sessionId,
          platform,
          reason: "missing_headers",
          messageType: msg.type,
        });
        return Result.err(
          new CmdRequestRequiredHeadersMissing({
            message:
              "cmd.request.message missing required headers.request_id/session_id/request_client",
          }),
        );
      }

      if (requestClient !== platform) {
        const relay = activeRelays.get(requestId);
        if (relay) return correlationError(msg.type);
        logger.debug("relay.event.ignored", {
          requestId,
          sessionId,
          platform,
          requestClient,
          reason: "platform_mismatch",
          messageType: msg.type,
        });
        return Result.ok(undefined);
      }

      const cancel = parseRequestControlFromRaw(msg.data.raw).cancel;

      if (!cancel) {
        return Result.ok(undefined);
      }

      const relay = activeRelays.get(requestId);
      if (!relay) {
        logger.debug("relay.event.ignored", {
          requestId,
          sessionId,
          platform,
          reason: "no_active_relay",
          messageType: msg.type,
        });
        return Result.ok(undefined);
      }
      if (!matchesRelay(relay, requestClient, sessionId)) return correlationError(msg.type);

      const cancelled = await captureBusToAdapterEffect("cancel-active-relay", () =>
        relay.cancel(),
      );
      if (cancelled.status === "ok") return Result.ok(undefined);
      logger.error(
        "failed to cancel active relay",
        formatBridgeTaggedErrorForLog(cancelled.error, { requestId, sessionId }),
      );
      return Result.err(
        new CmdRequestCancelFailed({
          cause: cancelled.error,
          message: "Failed to cancel active relay",
        }),
      );
    },
    applyCmdRequestDeliveryPolicy,
  );
  const cmdRequestSub = adaptBusToAdapterSubscriptionStart(cmdRequestStarted);
  observeSubscriptionDone(cmdRequestSub, "cmd.request", logger);

  const cmdSurfaceStarted = await bus.subscribeTopic(
    "cmd.surface",
    {
      mode: "fanout",
      subscriptionId: `${subscriptionId}:cmd_surface`,
      consumerId: getConsumerId(`${subscriptionId}:cmd_surface`),
      offset: { type: "now" },
      batch: { maxWaitMs: 1000 },
    },
    async (msg): Promise<ResultType<void, CmdSurfaceDeliveryError>> => {
      if (msg.type !== lilacEventTypes.CmdSurfaceOutputReanchor) {
        return Result.ok(undefined);
      }

      const requestId = msg.headers?.request_id;
      const sessionId = msg.headers?.session_id;
      const requestClient = msg.headers?.request_client;
      if (!requestId || !sessionId || !requestClient) {
        if (requestId && activeRelays.has(requestId)) return correlationError(msg.type);
        return Result.err(
          new CmdSurfaceRequiredHeadersMissing({
            message:
              "cmd.surface.output.reanchor missing required headers.request_id/session_id/request_client",
          }),
        );
      }

      if (requestClient !== platform) {
        const relay = activeRelays.get(requestId);
        if (relay) return correlationError(msg.type);
        logger.debug("relay.event.ignored", {
          requestId,
          sessionId,
          platform,
          requestClient,
          reason: "platform_mismatch",
          messageType: msg.type,
        });
        return Result.ok(undefined);
      }

      const relay = activeRelays.get(requestId);
      if (!relay) {
        logger.debug("relay.event.ignored", {
          requestId,
          sessionId,
          platform,
          reason: "no_active_relay",
          messageType: msg.type,
        });
        return Result.ok(undefined);
      }
      if (!matchesRelay(relay, requestClient, sessionId)) return correlationError(msg.type);

      let replyTo: MsgRef | undefined;
      if (msg.data.replyTo) {
        const decoded = policy.refs.decodeReanchorTarget({
          ref: msg.data.replyTo,
          expectedSessionId: sessionId,
        });
        if (decoded.status === "error") {
          logger.warn(
            "relay reanchor target rejected",
            formatBridgeTaggedErrorForLog(decoded.error, { requestId, sessionId, platform }),
          );
          return Result.err(
            new CmdSurfaceReplyTargetInvalid({
              cause: decoded.error,
              message: "Output reanchor target is invalid",
            }),
          );
        }
        replyTo = decoded.value;
      }

      const reanchored = await captureBusToAdapterEffect("reanchor-output", () =>
        relay.reanchor({
          inheritReplyTo: msg.data.inheritReplyTo,
          mode: msg.data.mode,
          replyTo,
        }),
      );
      if (reanchored.status === "ok") return Result.ok(undefined);
      logger.error(
        "reanchor failed",
        formatBridgeTaggedErrorForLog(reanchored.error, { requestId, sessionId }),
      );
      return Result.err(
        new CmdSurfaceReanchorFailed({
          cause: reanchored.error,
          message: "Output reanchor failed",
        }),
      );
    },
    applyCmdSurfaceDeliveryPolicy,
  );
  if (cmdSurfaceStarted.status === "error") {
    await runBusToAdapterBestEffort({
      operation: "stop-output-subscription",
      effect: () => stopResultSubscription(cmdRequestSub),
    });
  }
  const cmdSurfaceSub = adaptBusToAdapterSubscriptionStart(cmdSurfaceStarted);
  observeSubscriptionDone(cmdSurfaceSub, "cmd.surface", logger);

  const subStarted = await bus.subscribeTopic(
    "evt.request",
    {
      mode: "fanout",
      subscriptionId,
      consumerId: getConsumerId(subscriptionId),
      offset: { type: "now" },
      batch: { maxWaitMs: 1000 },
    },
    async (msg): Promise<ResultType<void, EvtRequestDeliveryError>> => {
      if (
        msg.type !== lilacEventTypes.EvtRequestReply &&
        msg.type !== lilacEventTypes.EvtRequestLifecycleChanged
      ) {
        return Result.ok(undefined);
      }

      const requestId = msg.headers?.request_id;
      const sessionId = msg.headers?.session_id;
      const requestClient = msg.headers?.request_client;
      const routerSessionMode = parseRouterSessionMode(msg.headers?.router_session_mode);

      if (!requestId || !sessionId || !requestClient) {
        if (
          requestId &&
          (activeRelays.has(requestId) || terminalLifecycleByRequestId.has(requestId))
        ) {
          return correlationError(msg.type);
        }
        // Do not ack malformed messages: they need investigation.
        logger.error("relay.event.rejected", {
          requestId,
          sessionId,
          platform,
          reason: "missing_headers",
          messageType: msg.type,
        });
        return Result.err(
          new EvtRequestRequiredHeadersMissing({
            message:
              "evt.request event missing required headers.request_id/session_id/request_client",
          }),
        );
      }

      if (requestClient !== platform) {
        if (activeRelays.has(requestId) || terminalLifecycleByRequestId.has(requestId)) {
          return correlationError(msg.type);
        }
        logger.debug("relay.event.ignored", {
          requestId,
          sessionId,
          platform,
          requestClient,
          reason: "platform_mismatch",
          messageType: msg.type,
        });
        return Result.ok(undefined);
      }

      pruneTerminalLifecycleCache(Date.now());

      const activeRelay = activeRelays.get(requestId);
      if (activeRelay && !matchesRelay(activeRelay, requestClient, sessionId)) {
        return correlationError(msg.type);
      }
      const terminalLifecycle = terminalLifecycleByRequestId.get(requestId);
      if (
        terminalLifecycle &&
        (terminalLifecycle.platform !== requestClient || terminalLifecycle.sessionId !== sessionId)
      ) {
        return correlationError(msg.type);
      }

      if (msg.type === lilacEventTypes.EvtRequestLifecycleChanged) {
        if (
          msg.data.state === "resolved" ||
          msg.data.state === "failed" ||
          msg.data.state === "cancelled"
        ) {
          terminalLifecycleByRequestId.set(requestId, {
            platform,
            sessionId,
            at: Date.now(),
          });

          const relay = activeRelays.get(requestId);
          if (relay) {
            const stoppedTyping = await captureBusToAdapterEffect("stop-typing", () =>
              relay.stopTyping(),
            );
            if (stoppedTyping.status === "error") {
              logger.debug(
                "failed to stop relay typing from lifecycle event",
                formatBridgeTaggedErrorForLog(stoppedTyping.error, {
                  requestId,
                  sessionId,
                  lifecycleState: msg.data.state,
                }),
              );
              return Result.err(
                new EvtRequestStopTypingFailed({
                  cause: stoppedTyping.error,
                  message: "Failed to stop relay typing from lifecycle event",
                }),
              );
            }
            terminalLifecycleByRequestId.delete(requestId);
          }
        }

        return Result.ok(undefined);
      }

      if (activeRelays.has(requestId)) {
        logger.debug("relay.event.ignored", {
          requestId,
          sessionId,
          platform,
          requestClient,
          reason: "already_active",
          messageType: msg.type,
        });
        return Result.ok(undefined);
      }

      if (env.perf.log) {
        const lagMs = Date.now() - msg.ts;
        const shouldWarn = lagMs >= env.perf.lagWarnMs;
        const shouldSample = env.perf.sampleRate > 0 && Math.random() < env.perf.sampleRate;
        if (shouldWarn || shouldSample) {
          if (shouldWarn) {
            logger.warn("perf.bus_lag", {
              stage: "evt.request.reply->bus_to_adapter",
              lagMs,
              requestId,
              sessionId,
              requestClient,
            });
          } else {
            logger.info("perf.bus_lag", {
              stage: "evt.request.reply->bus_to_adapter",
              lagMs,
              requestId,
              sessionId,
              requestClient,
            });
          }
        }
      }

      logger.debug("starting reply relay", {
        requestId,
        sessionId,
        requestClient,
      });

      const initialReplyTarget = policy.refs.resolveInitialReplyTarget({ requestId, sessionId });
      if (initialReplyTarget.kind === "invalid") {
        logger.error(
          "relay initial reply target rejected",
          formatBridgeTaggedErrorForLog(initialReplyTarget.error, {
            requestId,
            sessionId,
            platform,
          }),
        );
        return Result.err(
          new EvtRequestReplyTargetInvalid({
            cause: initialReplyTarget.error,
            message: "Initial output reply target is invalid",
          }),
        );
      }

      const relay = await startRelay({
        adapter,
        bus,
        platform,
        requestId,
        sessionId,
        requestStartedAtMs: msg.ts,
        routerSessionMode,
        requestClient,
        idleTimeoutMs,
        initialReplyTo: initialReplyTarget.kind === "target" ? initialReplyTarget.ref : undefined,
      });

      activeRelays.set(requestId, relay);

      if (terminalLifecycleByRequestId.has(requestId)) {
        const stoppedTyping = await captureBusToAdapterEffect("stop-typing", () =>
          relay.stopTyping(),
        );
        if (stoppedTyping.status === "error") {
          logger.debug(
            "failed to stop relay typing after delayed terminal lifecycle",
            formatBridgeTaggedErrorForLog(stoppedTyping.error, { requestId, sessionId }),
          );
          return Result.err(
            new EvtRequestStopTypingFailed({
              cause: stoppedTyping.error,
              message: "Failed to stop relay typing after delayed terminal lifecycle",
            }),
          );
        }
        terminalLifecycleByRequestId.delete(requestId);
      }

      return Result.ok(undefined);
    },
    applyEvtRequestDeliveryPolicy,
  );
  if (subStarted.status === "error") {
    await superviseBusToAdapterCleanup([
      () =>
        runBusToAdapterBestEffort({
          operation: "stop-output-subscription",
          effect: () => stopResultSubscription(cmdRequestSub),
        }),
      () =>
        runBusToAdapterBestEffort({
          operation: "stop-output-subscription",
          effect: () => stopResultSubscription(cmdSurfaceSub),
        }),
    ]);
  }
  const sub = adaptBusToAdapterSubscriptionStart(subStarted);
  observeSubscriptionDone(sub, "evt.request", logger);

  const stopIngress = async () => {
    if (ingressStopped) return;
    ingressStopped = true;
    await superviseBusToAdapterCleanup([
      () => stopResultSubscription(sub),
      () => stopResultSubscription(cmdSurfaceSub),
      () => stopResultSubscription(cmdRequestSub),
    ]);
  };

  async function startRelay(input: {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    platform: P;
    requestId: string;
    sessionId: string;
    requestStartedAtMs?: number;
    routerSessionMode?: "mention" | "active";
    requestClient?: string;
    idleTimeoutMs: number;
    initialReplyTo?: MsgRef;
    restore?: BusToAdapterRelaySnapshot;
  }): Promise<ActiveRelay> {
    const { requestId, sessionId, idleTimeoutMs } = input;

    const relayStartedAt = Date.now();
    const requestStartedAtMs = Math.max(
      0,
      input.restore?.requestStartedAtMs ?? input.requestStartedAtMs ?? relayStartedAt,
    );

    const sessionRef: SessionRef = policy.refs.createSessionRef(sessionId);
    const baseReplyTo = input.initialReplyTo;
    let currentReplyTo: MsgRef | undefined = baseReplyTo;

    let totalTextChars = input.restore?.totalTextChars ?? input.restore?.visibleText.length ?? 0;
    let streamTextPrefixChars = input.restore?.streamTextPrefixChars ?? 0;
    let streamPhaseBoundaryPrefixChars = input.restore?.streamPhaseBoundaryPrefixChars ?? 0;
    let streamPhaseBoundaryOffsetChars = input.restore?.streamPhaseBoundaryOffsetChars ?? 0;
    let streamPhaseBoundaryPrefix = input.restore?.streamPhaseBoundaryPrefix;
    let awaitingFinalPhaseBoundaryPrefix = input.restore?.awaitingFinalPhaseBoundaryPrefix ?? false;
    let visibleTextAcc = input.restore?.visibleText ?? "";
    let textPhase = input.restore?.textPhase;
    let commentaryText = input.restore?.commentaryText ?? "";
    let finalAnswerText = input.restore?.finalAnswerText ?? "";
    let phaseSegmentsValid = input.restore?.phaseSegmentsValid ?? true;
    let reasoningStartedAtMs = input.restore?.reasoning?.startedAtMs;
    let reasoningFrozenAtMs = input.restore?.reasoning?.frozenAtMs;
    let reasoningDetailText = input.restore?.reasoning?.detailText ?? "";
    let pendingNoReplyPrefix = "";
    let bufferNoReplyPrefix = true;
    let streamShouldFinish = false;
    const withoutStreamPhaseBoundary = (text: string, textOffsetChars = 0): string => {
      if (streamPhaseBoundaryPrefixChars === 0) return text;
      const boundaryStart = Math.min(
        Math.max(0, streamPhaseBoundaryOffsetChars - textOffsetChars),
        text.length,
      );
      const possibleBoundaryPrefix = text.slice(
        boundaryStart,
        boundaryStart + streamPhaseBoundaryPrefixChars,
      );
      const matchesKnownBoundary =
        streamPhaseBoundaryPrefix !== undefined &&
        possibleBoundaryPrefix === streamPhaseBoundaryPrefix;
      if (
        possibleBoundaryPrefix.length !== streamPhaseBoundaryPrefixChars ||
        !matchesKnownBoundary
      ) {
        return text;
      }
      return `${text.slice(0, boundaryStart)}${text.slice(
        boundaryStart + streamPhaseBoundaryPrefixChars,
      )}`;
    };
    const toolStatusById = new Map<string, SurfaceToolStatusUpdate>();
    if (input.restore) {
      for (const update of input.restore.toolStatus) {
        const merged = mergeSubagentToolStatus(toolStatusById.get(update.toolCallId), update);
        toolStatusById.delete(update.toolCallId);
        toolStatusById.set(update.toolCallId, merged);
      }
    }
    const createdOutputRefs: MsgRef[] = [];
    const createdOutputRefKeys = new Set<string>();
    if (input.restore) {
      for (const ref of input.restore.createdOutputRefs) {
        const key = `${ref.platform}:${ref.channelId}:${ref.messageId}`;
        if (createdOutputRefKeys.has(key)) continue;
        createdOutputRefKeys.add(key);
        createdOutputRefs.push(ref);
      }
    }
    let activeOutputRefs = input.restore?.activeOutputRefs?.slice() ?? createdOutputRefs.slice();
    let activeOutputRefKeys = new Set(
      activeOutputRefs.map((ref) => `${ref.platform}:${ref.channelId}:${ref.messageId}`),
    );
    let lastOutCursor = input.restore?.outCursor;

    const recordCreatedOutputRef = (msgRef: MsgRef) => {
      const key = `${msgRef.platform}:${msgRef.channelId}:${msgRef.messageId}`;
      if (createdOutputRefKeys.has(key)) return;
      createdOutputRefKeys.add(key);
      createdOutputRefs.push(msgRef);
    };

    // Serialize all mutations to the active output stream so reanchor doesn't race.
    let op = Promise.resolve();
    const enqueue = async (fn: () => Promise<void>) => {
      op = op.then(fn);
      await op;
    };

    let streamToken = 0;

    const publishCreatedForToken = (token: number) => (msgRef: MsgRef) => {
      recordCreatedOutputRef(msgRef);

      // Only publish created messages for the currently active output stream.
      // This prevents a reanchor from temporarily treating "frozen" follow-up messages
      // (e.g. attachment flushes) as the active streaming target.
      if (token !== streamToken) return;
      const key = `${msgRef.platform}:${msgRef.channelId}:${msgRef.messageId}`;
      if (!activeOutputRefKeys.has(key)) {
        activeOutputRefKeys.add(key);
        activeOutputRefs.push(msgRef);
      }

      void runBusToAdapterBestEffort({
        operation: "publish-output-created",
        effect: async () => {
          adaptEventPublishResultToHost(
            await bus.publish(
              lilacEventTypes.EvtSurfaceOutputMessageCreated,
              {
                msgRef: {
                  platform: msgRef.platform,
                  channelId: msgRef.channelId,
                  messageId: msgRef.messageId,
                },
              },
              {
                headers: {
                  request_id: requestId,
                  session_id: sessionId,
                  request_client: input.platform,
                },
              },
            ),
          );
        },
        logger,
        logLevel: "debug",
        logMessage: "failed to publish output message created",
        context: { requestId },
      });
    };

    let useResumeOpts = Boolean(input.restore);

    const buildStartOpts = (
      overrideReplyTo: MsgRef | undefined,
      token: number,
    ): StartOutputOpts => {
      const startOpts: StartOutputOpts = {
        replyTo: overrideReplyTo,
        requestId,
        requestStartedAtMs,
        onMessageCreated: publishCreatedForToken(token),
        ...(useResumeOpts
          ? {
              resume: {
                created: activeOutputRefs.slice(),
              },
            }
          : {}),
      };
      if (input.routerSessionMode) {
        startOpts.sessionMode = input.routerSessionMode;
      }
      return startOpts;
    };

    streamToken += 1;
    let out = adaptSurfaceOperationToRelay(
      "start-output",
      await adapter.startOutput(sessionRef, buildStartOpts(baseReplyTo, streamToken)),
    );
    let finalTextMode: SurfaceFinalTextMode = out.getFinalTextMode?.() ?? "continuation";
    useResumeOpts = false;
    const recordOutputPartDisposition = (disposition: SurfaceOutputPartDisposition): void => {
      if (disposition === "visible" || disposition === "terminal") {
        streamShouldFinish = true;
      }
    };

    if (input.restore) {
      // Re-publish existing output refs so router active-output tracking can recover.
      for (const ref of createdOutputRefs) {
        void runBusToAdapterBestEffort({
          operation: "publish-output-created",
          effect: async () => {
            adaptEventPublishResultToHost(
              await bus.publish(
                lilacEventTypes.EvtSurfaceOutputMessageCreated,
                {
                  msgRef: {
                    platform: ref.platform,
                    channelId: ref.channelId,
                    messageId: ref.messageId,
                  },
                },
                {
                  headers: {
                    request_id: requestId,
                    session_id: sessionId,
                    request_client: input.platform,
                  },
                },
              ),
            );
          },
          logger,
          logLevel: "debug",
          logMessage: "failed to publish restored output message created",
          context: { requestId, sessionId, messageId: ref.messageId },
        });
      }

      if (visibleTextAcc.trim().length > 0) {
        recordOutputPartDisposition(
          adaptSurfaceOperationToRelay(
            "push-output",
            await out.push({ type: "text.set", text: visibleTextAcc }),
          ),
        );
      }
      if (textPhase !== "final_answer" && typeof reasoningStartedAtMs === "number") {
        recordOutputPartDisposition(
          adaptSurfaceOperationToRelay(
            "push-output",
            await out.push({
              type: "reasoning.status",
              update: {
                startedAtMs: reasoningStartedAtMs,
                frozenAtMs: reasoningFrozenAtMs,
                detailText: reasoningDetailText,
              },
            }),
          ),
        );
      }
      if (textPhase !== "final_answer") {
        for (const update of toolStatusById.values()) {
          recordOutputPartDisposition(
            adaptSurfaceOperationToRelay(
              "push-output",
              await out.push({ type: "tool.status", update }),
            ),
          );
        }
      }
    }

    const switchOutputLane = async (lane: {
      replyTo?: MsgRef;
      resolveReplyToAfterAbort?: () => MsgRef | undefined;
      abortReason: "reanchor" | "reanchor_interrupt";
      replayStatus: boolean;
    }): Promise<void> => {
      // Make the new stream active before abort can create follow-up messages.
      streamToken += 1;
      activeOutputRefs = [];
      activeOutputRefKeys = new Set();
      await runBusToAdapterBestEffort({
        operation: "abort-output",
        effect: async () => {
          adaptSurfaceOperationToRelay("abort-output", await out.abort(lane.abortReason));
        },
      });

      const nextReplyTo = lane.resolveReplyToAfterAbort?.() ?? lane.replyTo;
      currentReplyTo = nextReplyTo;
      streamTextPrefixChars = Math.max(0, totalTextChars - pendingNoReplyPrefix.length);
      streamPhaseBoundaryPrefixChars = 0;
      streamPhaseBoundaryOffsetChars = 0;
      streamPhaseBoundaryPrefix = undefined;
      awaitingFinalPhaseBoundaryPrefix = false;
      textPhase = undefined;
      commentaryText = "";
      finalAnswerText = "";
      phaseSegmentsValid = true;
      visibleTextAcc = "";
      streamShouldFinish = false;
      out = adaptSurfaceOperationToRelay(
        "start-output",
        await adapter.startOutput(sessionRef, buildStartOpts(nextReplyTo, streamToken)),
      );
      finalTextMode = out.getFinalTextMode?.() ?? "continuation";

      if (!lane.replayStatus) return;
      if (typeof reasoningStartedAtMs === "number") {
        recordOutputPartDisposition(
          adaptSurfaceOperationToRelay(
            "push-output",
            await out.push({
              type: "reasoning.status",
              update: {
                startedAtMs: reasoningStartedAtMs,
                frozenAtMs: reasoningFrozenAtMs,
                detailText: reasoningDetailText,
              },
            }),
          ),
        );
      }
      for (const update of toolStatusById.values()) {
        recordOutputPartDisposition(
          adaptSurfaceOperationToRelay(
            "push-output",
            await out.push({ type: "tool.status", update }),
          ),
        );
      }
    };

    let typing: TypingIndicatorSubscription | null = null;

    const stopTyping = async () => {
      const currentTyping = typing;
      typing = null;
      if (!currentTyping) return;
      await runBusToAdapterBestEffort({
        operation: "stop-typing",
        effect: async () => {
          adaptSurfaceOperationToRelay("stop-typing", await currentTyping.stop());
        },
      });
    };

    let cancelTimeout: (() => void) | null = null;
    const bumpTimeout = () => {
      cancelTimeout?.();
      cancelTimeout = scheduleIdleTimeout(() => {
        logger.warn("reply relay idle timeout", {
          requestId,
          sessionId,
          idleTimeoutMs,
        });

        const abortOutput = runBusToAdapterBestEffort({
          operation: "abort-output",
          effect: async () => {
            adaptSurfaceOperationToRelay("abort-output", await out.abort("timeout"));
          },
          logger,
          logLevel: "error",
          logMessage: "failed to abort output stream",
          context: { requestId },
        });
        const stopRelay = runBusToAdapterBestEffort({
          operation: "stop-relay",
          effect: relayStop,
          logger,
          logLevel: "error",
          logMessage: "failed to stop relay",
          context: { requestId },
        });
        void superviseBusToAdapterCleanup([() => abortOutput, () => stopRelay]);
      }, idleTimeoutMs);
    };

    let stopped = false;
    let outputSub: ResultSubscription | null = null;
    let firstOutLogged = false;
    let handlingOutputEvent = false;

    const cleanupSkippedOutput = async () => {
      const cleanup = policy.finalization?.cleanupSkippedOutput;
      if (!cleanup) return;
      const deletions: Array<() => Promise<void>> = [];
      for (let i = createdOutputRefs.length - 1; i >= 0; i--) {
        const ref = createdOutputRefs[i];
        if (!ref) continue;
        const decoded = policy.refs.decodeReanchorTarget({
          ref,
          expectedSessionId: sessionId,
        });
        if (decoded.status === "error") {
          logger.warn(
            "skipped output cleanup ref rejected",
            formatBridgeTaggedErrorForLog(decoded.error, { requestId, sessionId, platform }),
          );
          continue;
        }
        deletions.push(() =>
          runBusToAdapterBestEffort({
            operation: "cleanup-skipped-output",
            effect: () => cleanup({ ref: decoded.value }),
            logger,
            logLevel: "debug",
            logMessage: "failed to delete skipped output message",
            context: { requestId, sessionId, messageId: ref.messageId },
          }),
        );
      }
      await superviseBusToAdapterCleanup(deletions);
    };

    const clearIngressAcknowledgement = async () => {
      const clear = policy.finalization?.clearIngressAcknowledgement;
      if (!clear) return;
      const cleared = await captureBusToAdapterEffect("clear-ingress-acknowledgement", () =>
        clear({ requestId, sessionId }),
      );
      if (cleared.status === "error") {
        logger.warn(
          "failed to clear ingress acknowledgement",
          formatBridgeTaggedErrorForLog(cleared.error, { requestId, sessionId }),
        );
        return;
      }
      if (cleared.value.status === "error") {
        logIngressAcknowledgementCleanupFailure({
          logger,
          error: cleared.value.error,
          requestId,
          sessionId,
        });
      }
    };

    const deleteUnlinkedCheckpointCandidate = async () => {
      const deleted = params.transcriptStore?.deleteUnlinkedCheckpointCandidate?.({ requestId });
      if (!deleted) return;
      if (deleted.status === "ok") {
        if (!deleted.value) return;
        logger.info("compaction checkpoint deleted", {
          requestId,
          sessionId,
          reason: "unlinked_candidate_cleanup",
        });
        return;
      }
      logger.warn(
        "failed to delete unlinked transcript checkpoint",
        formatBridgeTaggedErrorForLog(deleted.error, { requestId, sessionId }),
      );
    };

    const relayStop = async () => {
      if (stopped) return;
      stopped = true;

      // Remove from recoverable set immediately so graceful snapshots cannot
      // include a relay that has already reached terminal state.
      activeRelays.delete(requestId);
      terminalLifecycleByRequestId.delete(requestId);

      cancelTimeout?.();
      cancelTimeout = null;

      const subToStop = outputSub;
      if (!subToStop) {
        await stopTyping();
      } else if (handlingOutputEvent) {
        const stopOutputSubscription = () => stopResultSubscription(subToStop);
        void runBusToAdapterBestEffort({
          operation: "stop-output-subscription",
          effect: stopOutputSubscription,
        });
        await stopTyping();
      } else {
        await superviseBusToAdapterCleanup([
          stopTyping,
          () =>
            runBusToAdapterBestEffort({
              operation: "stop-output-subscription",
              effect: () => stopResultSubscription(subToStop),
            }),
        ]);
      }
    };

    bumpTimeout();

    const pushOutputPart = async (
      part: SurfaceOutputPart,
    ): Promise<ResultType<SurfaceOutputPartDisposition, OutReqPushFailed>> => {
      const pushed = await out.push(part);
      if (pushed.status === "ok") return Result.ok(pushed.value);
      logger.error(
        "failed to push relay output",
        formatBridgeTaggedErrorForLog(pushed.error, { requestId, sessionId }),
      );
      return Result.err(
        new OutReqPushFailed({
          cause: classifySurfaceOperationForRelay("push-output", pushed.error),
          message: "Failed to push relay output",
        }),
      );
    };

    const finishOutput = async (): Promise<ResultType<SurfaceOutputResult, OutReqFinishFailed>> => {
      const finished = await out.finish();
      if (finished.status === "ok") return Result.ok(finished.value);
      logger.error(
        "failed to finish relay output",
        formatBridgeTaggedErrorForLog(finished.error, { requestId, sessionId }),
      );
      return Result.err(
        new OutReqFinishFailed({
          cause: classifySurfaceOperationForRelay("finish-output", finished.error),
          message: "Failed to finish relay output",
        }),
      );
    };

    const subStart = Date.now();
    const outputStarted = await bus.subscribeTopic(
      outReqTopic(requestId),
      {
        mode: "tail",
        offset: lastOutCursor ? { type: "cursor", cursor: lastOutCursor } : { type: "begin" },
        batch: { maxWaitMs: 250 },
      },
      async (outMsg, outCtx): Promise<ResultType<void, OutReqDeliveryError>> => {
        if (
          outMsg.headers?.request_id !== requestId ||
          outMsg.headers?.session_id !== sessionId ||
          outMsg.headers?.request_client !== input.platform
        ) {
          return correlationError(outMsg.type);
        }
        if (stopped) {
          lastOutCursor = outCtx.cursor;
          return Result.ok(undefined);
        }

        if (env.perf.log && !firstOutLogged) {
          firstOutLogged = true;
          const now = Date.now();
          const sinceRelayStartMs = now - relayStartedAt;
          const outBusLagMs = now - outMsg.ts;
          const shouldWarn =
            sinceRelayStartMs >= env.perf.lagWarnMs || outBusLagMs >= env.perf.lagWarnMs;
          const shouldSample = env.perf.sampleRate > 0 && Math.random() < env.perf.sampleRate;
          if (shouldWarn || shouldSample) {
            if (shouldWarn) {
              logger.warn("perf.output_first_event", {
                requestId,
                sessionId,
                sinceRelayStartMs,
                outBusLagMs,
                outType: outMsg.type,
              });
            } else {
              logger.info("perf.output_first_event", {
                requestId,
                sessionId,
                sinceRelayStartMs,
                outBusLagMs,
                outType: outMsg.type,
              });
            }
          }
        }

        bumpTimeout();

        let processingError: OutReqDeliveryError | undefined;
        await enqueue(async () => {
          if (stopped) {
            return;
          }

          handlingOutputEvent = true;
          try {
            let part: SurfaceOutputPart | null = null;

            switch (outMsg.type) {
              case lilacEventTypes.EvtAgentOutputActivity: {
                break;
              }

              case lilacEventTypes.EvtAgentOutputDeltaReasoning: {
                const startedAtMs = reasoningStartedAtMs ?? outMsg.ts;
                reasoningStartedAtMs = startedAtMs;

                const seq = outMsg.data.seq;
                if (typeof seq === "number" && Number.isFinite(seq)) {
                  reasoningDetailText = clampReasoningDetail(outMsg.data.delta);
                } else {
                  reasoningDetailText = appendReasoningDetail(
                    reasoningDetailText,
                    outMsg.data.delta,
                  );
                }

                part = {
                  type: "reasoning.status",
                  update: {
                    startedAtMs,
                    frozenAtMs: reasoningFrozenAtMs,
                    detailText: reasoningDetailText,
                  },
                };
                break;
              }

              case lilacEventTypes.EvtAgentOutputDeltaText: {
                const incomingPhase = outMsg.data.phase;
                const visibleDelta = outMsg.data.delta;
                let phasedDelta = outMsg.data.delta;
                if (incomingPhase === "commentary" && textPhase === "final_answer") {
                  phaseSegmentsValid = false;
                }
                if (incomingPhase === "final_answer" && textPhase === "commentary") {
                  streamPhaseBoundaryPrefixChars = 0;
                  streamPhaseBoundaryOffsetChars = 0;
                  streamPhaseBoundaryPrefix = undefined;
                  awaitingFinalPhaseBoundaryPrefix = true;
                }
                const boundaryPrefixChars = Math.max(
                  0,
                  Math.min(outMsg.data.phaseBoundaryPrefixChars ?? 0, outMsg.data.delta.length),
                );
                if (
                  incomingPhase === "final_answer" &&
                  awaitingFinalPhaseBoundaryPrefix &&
                  boundaryPrefixChars > 0
                ) {
                  streamPhaseBoundaryOffsetChars = Math.max(
                    0,
                    totalTextChars - streamTextPrefixChars,
                  );
                  streamPhaseBoundaryPrefixChars = boundaryPrefixChars;
                  streamPhaseBoundaryPrefix = outMsg.data.delta.slice(0, boundaryPrefixChars);
                  phasedDelta = outMsg.data.delta.slice(boundaryPrefixChars);
                  awaitingFinalPhaseBoundaryPrefix = false;
                } else if (
                  incomingPhase === "final_answer" &&
                  awaitingFinalPhaseBoundaryPrefix &&
                  /\S/u.test(outMsg.data.delta)
                ) {
                  awaitingFinalPhaseBoundaryPrefix = false;
                }
                if (incomingPhase === "commentary") commentaryText += phasedDelta;
                if (incomingPhase === "final_answer") finalAnswerText += phasedDelta;
                textPhase = incomingPhase ?? textPhase;
                totalTextChars += outMsg.data.delta.length;

                if (
                  typeof reasoningStartedAtMs === "number" &&
                  typeof reasoningFrozenAtMs !== "number"
                ) {
                  reasoningFrozenAtMs = outMsg.ts;
                }

                if (!bufferNoReplyPrefix) {
                  part = { type: "text.delta", delta: visibleDelta };
                  visibleTextAcc += visibleDelta;
                  break;
                }

                pendingNoReplyPrefix += visibleDelta;
                if (isPossibleNoReplyPrefix(pendingNoReplyPrefix)) {
                  break;
                }

                bufferNoReplyPrefix = false;
                part = { type: "text.delta", delta: pendingNoReplyPrefix };
                visibleTextAcc += pendingNoReplyPrefix;
                pendingNoReplyPrefix = "";
                break;
              }

              case lilacEventTypes.EvtAgentOutputTextReset: {
                const clampedStreamPrefixChars = Math.max(
                  0,
                  Math.min(streamTextPrefixChars, outMsg.data.text.length),
                );
                const laneText = outMsg.data.text.slice(clampedStreamPrefixChars);
                totalTextChars = outMsg.data.text.length;
                visibleTextAcc = laneText;
                pendingNoReplyPrefix = "";
                bufferNoReplyPrefix = true;
                textPhase = outMsg.data.phase;
                if (outMsg.data.phase === "commentary") {
                  commentaryText = laneText;
                  finalAnswerText = "";
                  phaseSegmentsValid = true;
                } else if (outMsg.data.phase === "final_answer") {
                  phaseSegmentsValid =
                    phaseSegmentsValid &&
                    (commentaryText.length === 0 || laneText.startsWith(commentaryText));
                  finalAnswerText = laneText.startsWith(commentaryText)
                    ? withoutStreamPhaseBoundary(
                        laneText.slice(commentaryText.length),
                        commentaryText.length,
                      )
                    : laneText;
                } else {
                  commentaryText = "";
                  finalAnswerText = "";
                  phaseSegmentsValid = true;
                }
                if (outMsg.data.phase !== "final_answer") {
                  streamPhaseBoundaryPrefixChars = 0;
                  streamPhaseBoundaryOffsetChars = 0;
                  streamPhaseBoundaryPrefix = undefined;
                }
                awaitingFinalPhaseBoundaryPrefix = false;
                part = { type: "text.set", text: laneText };
                break;
              }

              case lilacEventTypes.EvtAgentOutputToolCall: {
                const incoming = {
                  toolCallId: outMsg.data.toolCallId,
                  display: outMsg.data.display,
                  status: outMsg.data.status,
                  ok: outMsg.data.ok,
                  error: outMsg.data.error,
                } satisfies SurfaceToolStatusUpdate;
                const update = mergeSubagentToolStatus(
                  toolStatusById.get(incoming.toolCallId),
                  incoming,
                );

                toolStatusById.delete(update.toolCallId);
                toolStatusById.set(update.toolCallId, update);

                part = {
                  type: "tool.status",
                  update,
                };
                break;
              }

              case lilacEventTypes.EvtAgentOutputResponseBinary: {
                part = {
                  type: "attachment.add",
                  attachment: toAttachment(outMsg.data),
                };
                break;
              }

              case lilacEventTypes.EvtAgentOutputResponseText: {
                const delivery =
                  outMsg.data.delivery ?? resolveReplyDeliveryFromFinalText(outMsg.data.finalText);

                if (delivery === "skip") {
                  await superviseBusToAdapterCleanup([
                    () =>
                      runBusToAdapterBestEffort({
                        operation: "abort-output",
                        effect: async () => {
                          adaptSurfaceOperationToRelay("abort-output", await out.abort("skip"));
                        },
                      }),
                    cleanupSkippedOutput,
                    deleteUnlinkedCheckpointCandidate,
                    relayStop,
                    clearIngressAcknowledgement,
                  ]);

                  logger.info("reply relay skipped final surface reply", {
                    requestId,
                    sessionId,
                  });
                  return;
                }

                if (
                  policy.finalization?.isFinalResponseSuperseded?.({ requestId, sessionId }) ===
                  true
                ) {
                  logger.info("surface reply suppressed (superseded)", {
                    requestId,
                    sessionId,
                    platform,
                  });
                  await superviseBusToAdapterCleanup([
                    () =>
                      runBusToAdapterBestEffort({
                        operation: "abort-output",
                        effect: async () => {
                          adaptSurfaceOperationToRelay(
                            "abort-output",
                            await out.abort("superseded"),
                          );
                        },
                      }),
                    relayStop,
                  ]);
                  return;
                }

                const statsLineRaw = outMsg.data.statsForNerdsLine;
                const statsLine = typeof statsLineRaw === "string" ? statsLineRaw.trim() : "";

                const previousVisibleText = visibleTextAcc;
                const finalText = outMsg.data.finalText;
                const clampedStreamPrefixChars = Math.max(
                  0,
                  Math.min(streamTextPrefixChars, finalText.length),
                );
                const isContinuationOnlyFinal = finalText.length < totalTextChars;
                const hasPriorLanePrefix = clampedStreamPrefixChars > 0;
                const shouldUseFullLaneFinal = finalTextMode === "full" && !hasPriorLanePrefix;
                let streamFinalText = finalText;
                if (!shouldUseFullLaneFinal && !isContinuationOnlyFinal) {
                  streamFinalText = finalText.slice(clampedStreamPrefixChars);
                }

                const hasTrackedPhasedText =
                  commentaryText.trim().length > 0 && finalAnswerText.trim().length > 0;
                if (!hasTrackedPhasedText) {
                  streamFinalText = withoutStreamPhaseBoundary(streamFinalText);
                }

                // On recovery resumes, the agent may emit only the continuation suffix
                // (instead of the full final text). In that case, preserve already visible
                // stream text and append the new suffix with overlap-aware merge.
                if (isContinuationOnlyFinal) {
                  streamFinalText = mergeContinuationText(previousVisibleText, streamFinalText);
                }

                if (streamFinalText.length === 0 && !streamShouldFinish) {
                  await superviseBusToAdapterCleanup([
                    () =>
                      runBusToAdapterBestEffort({
                        operation: "abort-output",
                        effect: async () => {
                          adaptSurfaceOperationToRelay("abort-output", await out.abort("skip"));
                        },
                      }),
                    cleanupSkippedOutput,
                    deleteUnlinkedCheckpointCandidate,
                    relayStop,
                    clearIngressAcknowledgement,
                  ]);

                  logger.info("reply relay skipped empty post-reanchor stream", {
                    requestId,
                    sessionId,
                  });
                  return;
                }

                if (statsLine.length > 0) {
                  const pushedStats = await pushOutputPart({
                    type: "meta.stats",
                    line: statsLine,
                  });
                  if (pushedStats.status === "error") {
                    processingError = pushedStats.error;
                    return;
                  }
                }

                totalTextChars = Math.max(
                  totalTextChars,
                  finalText.length,
                  clampedStreamPrefixChars + streamFinalText.length,
                );
                visibleTextAcc = streamFinalText;
                pendingNoReplyPrefix = "";
                bufferNoReplyPrefix = false;
                if (
                  typeof reasoningStartedAtMs === "number" &&
                  typeof reasoningFrozenAtMs !== "number"
                ) {
                  reasoningFrozenAtMs = outMsg.ts;
                }
                const preservesCommentaryPrefix = streamFinalText.startsWith(commentaryText);
                const authoritativeFinalAnswer = preservesCommentaryPrefix
                  ? withoutStreamPhaseBoundary(
                      streamFinalText.slice(commentaryText.length),
                      commentaryText.length,
                    )
                  : "";
                const finalSegments =
                  phaseSegmentsValid &&
                  commentaryText.trim().length > 0 &&
                  finalAnswerText.trim().length > 0 &&
                  authoritativeFinalAnswer.startsWith(finalAnswerText) &&
                  authoritativeFinalAnswer.trim().length > 0
                    ? [commentaryText, authoritativeFinalAnswer]
                    : undefined;
                const pushedFinal = await pushOutputPart({
                  type: "text.set",
                  text: streamFinalText,
                  ...(finalSegments === undefined ? {} : { finalSegments }),
                });
                if (pushedFinal.status === "error") {
                  processingError = pushedFinal.error;
                  return;
                }
                recordOutputPartDisposition(pushedFinal.value);
                const finished = await finishOutput();
                if (finished.status === "error") {
                  processingError = finished.error;
                  return;
                }
                const res = finished.value;

                const transcriptStore = params.transcriptStore;
                await superviseBusToAdapterCleanup([
                  ...(transcriptStore
                    ? [
                        () =>
                          runBusToAdapterBestEffort({
                            operation: "link-transcript",
                            effect: async () => {
                              transcriptStore.linkSurfaceMessagesToRequest({
                                requestId,
                                created: res.created,
                                last: res.last,
                              });
                            },
                            logger,
                            logLevel: "error",
                            logMessage: "failed to link transcript to surface messages",
                            context: { requestId, sessionId },
                          }),
                      ]
                    : []),
                  relayStop,
                  clearIngressAcknowledgement,
                ]);

                logger.info("reply relay finished", {
                  requestId,
                  sessionId,
                  finalTextChars: streamFinalText.length,
                });
                return;
              }

              default:
                return;
            }

            if (part) {
              const pushed = await pushOutputPart(part);
              if (pushed.status === "error") {
                processingError = pushed.error;
                return;
              }
              recordOutputPartDisposition(pushed.value);
            }
          } finally {
            handlingOutputEvent = false;
          }
        });

        if (processingError) return Result.err(processingError);
        lastOutCursor = outCtx.cursor;
        return Result.ok(undefined);
      },
      applyOutReqDeliveryPolicy,
    );
    outputSub = adaptBusToAdapterSubscriptionStart(outputStarted);
    observeSubscriptionDone(outputSub, outReqTopic(requestId), logger);

    const startedTyping = await adapter.startTyping(sessionRef);
    if (startedTyping.status === "ok") {
      typing = startedTyping.value;
    } else {
      typing = null;
      logger.warn("surface typing indicator unavailable", {
        requestId,
        sessionId,
        ...formatTaggedErrorForLog(startedTyping.error),
      });
    }

    if (env.perf.log) {
      const setupMs = Date.now() - subStart;
      const shouldWarn = setupMs >= env.perf.lagWarnMs;
      const shouldSample = env.perf.sampleRate > 0 && Math.random() < env.perf.sampleRate;
      if (shouldWarn || shouldSample) {
        if (shouldWarn) {
          logger.warn("perf.subscription_setup", {
            stage: "bus_to_adapter.output_subscribe",
            requestId,
            sessionId,
            setupMs,
          });
        } else {
          logger.info("perf.subscription_setup", {
            stage: "bus_to_adapter.output_subscribe",
            requestId,
            sessionId,
            setupMs,
          });
        }
      }
    }

    return {
      requestId,
      sessionId,
      platform: input.platform,
      stopTyping,
      stop: relayStop,
      cancel: async () => {
        await enqueue(async () => {
          await superviseBusToAdapterCleanup([
            () =>
              runBusToAdapterBestEffort({
                operation: "abort-output",
                effect: async () => {
                  adaptSurfaceOperationToRelay("abort-output", await out.abort("cancel"));
                },
                logger,
                logLevel: "error",
                logMessage: "failed to abort output stream on cancel",
                context: { requestId },
              }),
            relayStop,
          ]);
        });
      },
      startedAt: relayStartedAt,
      firstOutLogged,
      reanchor: async (reanchorInput) => {
        await enqueue(async () => {
          const nextReplyTo = reanchorInput.inheritReplyTo ? currentReplyTo : reanchorInput.replyTo;
          const reanchorAbortReason =
            reanchorInput.mode === "interrupt" ? "reanchor_interrupt" : "reanchor";
          await switchOutputLane({
            replyTo: nextReplyTo,
            abortReason: reanchorAbortReason,
            replayStatus: true,
          });
        });
      },
      snapshot: () => ({
        requestId,
        sessionId,
        requestClient: input.requestClient,
        platform: input.platform,
        requestStartedAtMs,
        routerSessionMode: input.routerSessionMode,
        replyTo: currentReplyTo,
        createdOutputRefs: createdOutputRefs.slice(),
        activeOutputRefs: activeOutputRefs.slice(),
        visibleText: visibleTextAcc,
        totalTextChars,
        streamTextPrefixChars,
        streamPhaseBoundaryPrefixChars,
        streamPhaseBoundaryOffsetChars,
        ...(streamPhaseBoundaryPrefix === undefined ? {} : { streamPhaseBoundaryPrefix }),
        awaitingFinalPhaseBoundaryPrefix,
        ...(textPhase === undefined ? {} : { textPhase }),
        ...(commentaryText.length === 0 ? {} : { commentaryText }),
        ...(finalAnswerText.length === 0 ? {} : { finalAnswerText }),
        phaseSegmentsValid,
        reasoning:
          typeof reasoningStartedAtMs === "number"
            ? {
                startedAtMs: reasoningStartedAtMs,
                frozenAtMs: reasoningFrozenAtMs,
                detailText: reasoningDetailText,
              }
            : undefined,
        toolStatus: [...toolStatusById.values()],
        outCursor: lastOutCursor,
      }),
    };
  }

  return {
    platform,
    beginDrain: async (opts?: { deadlineMs?: number }) => {
      draining = true;
      await stopIngress();

      const deadlineMs = Math.max(1, opts?.deadlineMs ?? 3_000);
      const startedAt = Date.now();

      while (activeRelays.size > 0 && Date.now() - startedAt < deadlineMs) {
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    snapshotRelays: (): SurfaceRelaySnapshotFor<P>[] => {
      return [...activeRelays.values()].map((relay) => {
        const snapshot = { ...relay.snapshot(), platform };
        requireSurfaceRelaySnapshot(platform, snapshot, "relay.snapshotRelays");
        return snapshot;
      });
    },
    restoreRelays: async (snapshots: readonly BusToAdapterRelaySnapshot[]) => {
      if (draining) return;

      for (const snapshot of snapshots) {
        requireSurfaceRelaySnapshot(platform, snapshot, "relay.restoreRelays");
      }

      for (const snapshot of snapshots) {
        if (activeRelays.has(snapshot.requestId)) continue;

        let initialReplyTo: MsgRef | undefined;
        if (snapshot.replyTo) {
          const decoded = policy.refs.decodeReanchorTarget({
            ref: snapshot.replyTo,
            expectedSessionId: snapshot.sessionId,
          });
          if (decoded.status === "error") {
            logger.error(
              "relay restore reply target rejected",
              formatBridgeTaggedErrorForLog(decoded.error, {
                requestId: snapshot.requestId,
                sessionId: snapshot.sessionId,
                platform,
              }),
            );
          } else {
            initialReplyTo = decoded.value;
          }
        } else {
          const resolved = policy.refs.resolveInitialReplyTarget({
            requestId: snapshot.requestId,
            sessionId: snapshot.sessionId,
          });
          if (resolved.kind === "invalid") {
            logger.error(
              "relay restore initial reply target rejected",
              formatBridgeTaggedErrorForLog(resolved.error, {
                requestId: snapshot.requestId,
                sessionId: snapshot.sessionId,
                platform,
              }),
            );
          }
          if (resolved.kind === "target") initialReplyTo = resolved.ref;
        }

        const relay = await startRelay({
          adapter,
          bus,
          platform,
          requestId: snapshot.requestId,
          sessionId: snapshot.sessionId,
          routerSessionMode: snapshot.routerSessionMode,
          requestClient: snapshot.requestClient,
          idleTimeoutMs,
          initialReplyTo,
          restore: snapshot,
        });

        activeRelays.set(snapshot.requestId, relay);
      }
    },
    stop: async () => {
      await stopIngress();
      await superviseBusToAdapterCleanup(
        [...activeRelays.values()].map((relay) => () => relay.stop()),
      );
    },
  };
}
