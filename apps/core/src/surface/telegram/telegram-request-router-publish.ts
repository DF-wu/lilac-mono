import {
  lilacEventTypes,
  type CmdRequestMessageData,
  type LilacBus,
  type RequestQueueMode,
} from "@stanley2058/lilac-event-bus";
import type { Logger } from "@stanley2058/simple-module-logger";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import type { TelegramMsgRef } from "../types";
import { formatBridgeTaggedErrorForLog } from "../bridge/bridge-log";
import type { SessionMode } from "../discord/discord-request-router/common";
import type {
  ComposedTelegramRequest,
  TelegramCustomCommandMetadata,
} from "./telegram-request-router-composition";

/**
 * Publication helpers for the Telegram request router.
 *
 * `cmd.request.message` goes through the bus the runtime hands the router,
 * which in Core is the durable request bus: it validates the prepared
 * envelope, records the delivery, and owns any blob handles the composed
 * messages carry before the agent runner can admit the request.
 */

export class TelegramRequestPublishFailed extends TaggedError("TelegramRequestPublishFailed")<{
  readonly requestId: string;
  readonly sessionId: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export type TelegramTriggerType = "mention" | "reply" | "active";

/**
 * Router-specific `raw` fields beside the shared ones: custom-command metadata
 * for a command invocation, or the active request a buffered prompt waits on.
 */
export type TelegramRequestRawExtra =
  | TelegramCustomCommandMetadata
  | { readonly bufferedForActiveRequestId: string };

export type PublishTelegramRequestInput = {
  readonly bus: LilacBus;
  readonly logger: Logger;
  readonly requestId: string;
  readonly sessionId: string;
  readonly sessionConfigId: string;
  readonly parentChannelId?: string;
  readonly queue: RequestQueueMode;
  readonly triggerType: TelegramTriggerType;
  readonly sessionMode: SessionMode;
  readonly modelOverride?: string;
  readonly composed: ComposedTelegramRequest;
  /** The authenticated Telegram principal this request acts for. */
  readonly origin: { readonly userId: string; readonly messageRef: TelegramMsgRef };
  readonly raw?: TelegramRequestRawExtra;
};

export async function publishTelegramRequest(
  input: PublishTelegramRequestInput,
): Promise<ResultType<void, TelegramRequestPublishFailed>> {
  if (input.composed.messages.length === 0) {
    input.logger.debug("telegram request composed no messages; skipping", {
      requestId: input.requestId,
      sessionId: input.sessionId,
      queue: input.queue,
    });
    return Result.ok(undefined);
  }
  input.logger.debug("cmd.request.message publish", {
    requestId: input.requestId,
    sessionId: input.sessionId,
    queue: input.queue,
    triggerType: input.triggerType,
    modelOverride: input.modelOverride,
    messageCount: input.composed.messages.length,
  });
  const data = {
    requestDeliveryId: crypto.randomUUID(),
    queue: input.queue,
    messages: input.composed.messages,
    ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
    raw: {
      ...input.raw,
      authenticatedOrigin: {
        platform: "telegram",
        userId: input.origin.userId,
        messageRef: input.origin.messageRef,
      },
      triggerType: input.triggerType,
      chainMessageIds: input.composed.chainMessageIds,
      participantUserIds: input.composed.participantUserIds,
      sessionMode: input.sessionMode,
      sessionConfigId: input.sessionConfigId,
      ...(input.parentChannelId ? { parentChannelId: input.parentChannelId } : {}),
      ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
    },
  } satisfies CmdRequestMessageData;

  const published = await input.bus.publish(lilacEventTypes.CmdRequestMessage, data, {
    headers: {
      request_id: input.requestId,
      session_id: input.sessionId,
      request_client: "telegram",
    },
  });
  return published.match<ResultType<void, TelegramRequestPublishFailed>>({
    ok: () => Result.ok(undefined),
    err: (cause) => {
      const failure = new TelegramRequestPublishFailed({
        requestId: input.requestId,
        sessionId: input.sessionId,
        cause,
        message: "Telegram request publication failed",
      });
      input.logger.error(
        "cmd.request.message publish failed",
        formatBridgeTaggedErrorForLog(failure, {
          requestId: input.requestId,
          sessionId: input.sessionId,
          queue: input.queue,
        }),
      );
      return Result.err(failure);
    },
  });
}

/**
 * Move the active relay's reply anchor when a steer or interrupt arrives, so
 * the continued output replies to the steering message instead of the first.
 */
export async function publishTelegramOutputReanchor(input: {
  readonly bus: LilacBus;
  readonly logger: Logger;
  readonly requestId: string;
  readonly sessionId: string;
  readonly inheritReplyTo: boolean;
  readonly replyTo?: TelegramMsgRef;
  readonly mode: "steer" | "interrupt";
}): Promise<ResultType<void, TelegramRequestPublishFailed>> {
  const published = await input.bus.publish(
    lilacEventTypes.CmdSurfaceOutputReanchor,
    {
      inheritReplyTo: input.inheritReplyTo,
      mode: input.mode,
      ...(input.replyTo
        ? {
            replyTo: {
              platform: input.replyTo.platform,
              channelId: input.replyTo.channelId,
              messageId: input.replyTo.messageId,
            },
          }
        : {}),
    },
    {
      headers: {
        request_id: input.requestId,
        session_id: input.sessionId,
        request_client: "telegram",
      },
    },
  );
  return published.match<ResultType<void, TelegramRequestPublishFailed>>({
    ok: () => Result.ok(undefined),
    err: (cause) => {
      const failure = new TelegramRequestPublishFailed({
        requestId: input.requestId,
        sessionId: input.sessionId,
        cause,
        message: "Telegram output reanchor publication failed",
      });
      input.logger.error(
        "cmd.surface.output.reanchor publish failed",
        formatBridgeTaggedErrorForLog(failure, {
          requestId: input.requestId,
          sessionId: input.sessionId,
          mode: input.mode,
        }),
      );
      return Result.err(failure);
    },
  });
}
