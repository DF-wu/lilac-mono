import type {
  EventPublishContractInvalid,
  EventPublishTransportFailed,
  LilacBus,
} from "@stanley2058/lilac-event-bus";
import { lilacEventTypes } from "@stanley2058/lilac-event-bus";
import { createLogger } from "@stanley2058/lilac-utils";
import { Panic, type Result as ResultType } from "better-result";

import type { SurfaceAdapterEventSource } from "../adapter";
import type { AdapterEvent } from "../events";
import { requireDescriptorBoundAdapterEvent } from "../produced-ref-guard";
import type { RegisteredSurfacePlatform } from "../types";
import {
  toBusEvtAdapterMessageCreated,
  toBusEvtAdapterMessageDeleted,
  toBusEvtAdapterMessageUpdated,
  toBusEvtAdapterReactionAdded,
  toBusEvtAdapterReactionRemoved,
} from "./adapter-event-projection";
import { toBusDiscordCommandInvokedData } from "../discord/discord-command-projection";
import type { TranscriptStore } from "../../transcript/transcript-store";
import { adaptEventPublishResultToHost } from "../../shared/event-bus-result";
import { formatBridgeLogContext } from "./bridge-log";

export async function bridgeAdapterToBus(params: {
  eventSource: SurfaceAdapterEventSource;
  platform: RegisteredSurfacePlatform;
  bus: LilacBus;
  subscriptionId: string;
  transcriptStore?: TranscriptStore;
}) {
  const { eventSource, bus } = params;
  const logger = createLogger({
    module: "bridge:adapter-to-bus",
  });

  const logPublish = (input: {
    adapterEventType: AdapterEvent["type"];
    busType: string;
    platform: string;
    channelId?: string;
    messageId?: string;
    userId?: string;
    requestId?: string;
    sessionId?: string;
    startedAt: number;
    ok: boolean;
    errorClass?: string;
  }) => {
    logger.debug("adapter.event.publish", {
      adapterEventType: input.adapterEventType,
      busType: input.busType,
      platform: input.platform,
      channelId: input.channelId,
      messageId: input.messageId,
      userId: input.userId,
      requestId: input.requestId,
      sessionId: input.sessionId,
      durationMs: Date.now() - input.startedAt,
      ok: input.ok,
      errorClass: input.errorClass,
    });
  };
  const finishPublish = <T>(
    published: ResultType<T, EventPublishContractInvalid | EventPublishTransportFailed>,
    context: Omit<Parameters<typeof logPublish>[0], "errorClass" | "ok">,
  ): void => {
    if (published.status === "error") {
      logPublish({ ...context, ok: false, errorClass: published.error._tag });
      adaptEventPublishResultToHost(published);
      return;
    }
    logPublish({ ...context, ok: true });
  };

  return await eventSource.subscribe(async (evt: AdapterEvent) => {
    requireDescriptorBoundAdapterEvent(params.platform, evt);
    const startedAt = Date.now();

    switch (evt.type) {
      case "adapter.message.created": {
        const published = await bus.publish(
          lilacEventTypes.EvtAdapterMessageCreated,
          toBusEvtAdapterMessageCreated(evt),
        );
        finishPublish(published, {
          adapterEventType: evt.type,
          busType: lilacEventTypes.EvtAdapterMessageCreated,
          platform: evt.message.ref.platform,
          channelId: evt.message.ref.channelId,
          messageId: evt.message.ref.messageId,
          userId: evt.message.userId,
          startedAt,
        });
        break;
      }

      case "adapter.message.updated": {
        const published = await bus.publish(
          lilacEventTypes.EvtAdapterMessageUpdated,
          toBusEvtAdapterMessageUpdated(evt),
        );
        finishPublish(published, {
          adapterEventType: evt.type,
          busType: lilacEventTypes.EvtAdapterMessageUpdated,
          platform: evt.message.ref.platform,
          channelId: evt.message.ref.channelId,
          messageId: evt.message.ref.messageId,
          userId: evt.message.userId,
          startedAt,
        });
        break;
      }

      case "adapter.message.deleted": {
        try {
          const unlinkResult = params.transcriptStore?.unlinkSurfaceMessage?.({
            platform: evt.messageRef.platform,
            channelId: evt.messageRef.channelId,
            messageId: evt.messageRef.messageId,
          });
          if (unlinkResult?.status === "error") {
            logger.warn(
              "failed to unlink deleted surface message",
              formatBridgeLogContext({
                platform: evt.messageRef.platform,
                channelId: evt.messageRef.channelId,
                messageId: evt.messageRef.messageId,
                errorTag: unlinkResult.error.name,
                errorMessage: unlinkResult.error.message,
              }),
            );
          } else if (unlinkResult?.value.checkpointDeleted) {
            logger.info("compaction checkpoint deleted", {
              requestId: unlinkResult.value.requestId,
              platform: evt.messageRef.platform,
              channelId: evt.messageRef.channelId,
              messageId: evt.messageRef.messageId,
              reason: "last_surface_link_deleted",
            });
          }
        } catch (cause) {
          if (Panic.is(cause)) throw cause;
          logger.warn(
            "failed to unlink deleted surface message",
            formatBridgeLogContext({
              platform: evt.messageRef.platform,
              channelId: evt.messageRef.channelId,
              messageId: evt.messageRef.messageId,
              errorMessage: cause instanceof Error ? cause.message : "Unknown unlink failure",
            }),
          );
        }

        const published = await bus.publish(
          lilacEventTypes.EvtAdapterMessageDeleted,
          toBusEvtAdapterMessageDeleted(evt),
        );
        finishPublish(published, {
          adapterEventType: evt.type,
          busType: lilacEventTypes.EvtAdapterMessageDeleted,
          platform: evt.messageRef.platform,
          channelId: evt.messageRef.channelId,
          messageId: evt.messageRef.messageId,
          startedAt,
        });
        break;
      }

      case "adapter.reaction.added": {
        const published = await bus.publish(
          lilacEventTypes.EvtAdapterReactionAdded,
          toBusEvtAdapterReactionAdded(evt),
        );
        finishPublish(published, {
          adapterEventType: evt.type,
          busType: lilacEventTypes.EvtAdapterReactionAdded,
          platform: evt.messageRef.platform,
          channelId: evt.messageRef.channelId,
          messageId: evt.messageRef.messageId,
          userId: evt.userId,
          startedAt,
        });
        break;
      }

      case "adapter.reaction.removed": {
        const published = await bus.publish(
          lilacEventTypes.EvtAdapterReactionRemoved,
          toBusEvtAdapterReactionRemoved(evt),
        );
        finishPublish(published, {
          adapterEventType: evt.type,
          busType: lilacEventTypes.EvtAdapterReactionRemoved,
          platform: evt.messageRef.platform,
          channelId: evt.messageRef.channelId,
          messageId: evt.messageRef.messageId,
          userId: evt.userId,
          startedAt,
        });
        break;
      }

      case "adapter.request.cancel": {
        const cancelScope = evt.cancelScope ?? "active_only";
        const cancelQueued = cancelScope === "active_or_queued";

        const published = await bus.publish(
          lilacEventTypes.CmdRequestMessage,
          {
            queue: "interrupt",
            messages: [],
            raw: {
              cancel: true,
              cancelQueued,
              requiresActive: !cancelQueued,
              source:
                evt.source ??
                (cancelQueued ? "discord_cancel_context_menu" : "discord_cancel_button"),
              ...(evt.userId ? { userId: evt.userId } : {}),
              ...(evt.messageId ? { messageId: evt.messageId } : {}),
            },
          },
          {
            headers: {
              request_id: evt.requestId,
              session_id: evt.sessionId,
              request_client: evt.platform,
            },
          },
        );
        finishPublish(published, {
          adapterEventType: evt.type,
          busType: lilacEventTypes.CmdRequestMessage,
          platform: evt.platform,
          messageId: evt.messageId,
          userId: evt.userId,
          requestId: evt.requestId,
          sessionId: evt.sessionId,
          startedAt,
        });
        break;
      }

      case "adapter.command.invoked": {
        const published = await bus.publish(
          lilacEventTypes.CmdRequestMessage,
          toBusDiscordCommandInvokedData(evt),
          {
            headers: {
              request_id: evt.requestId,
              session_id: evt.sessionId,
              request_client: evt.platform,
            },
          },
        );
        finishPublish(published, {
          adapterEventType: evt.type,
          busType: lilacEventTypes.CmdRequestMessage,
          platform: evt.platform,
          requestId: evt.requestId,
          sessionId: evt.sessionId,
          startedAt,
        });
        break;
      }

      case "adapter.action.invoked": {
        adaptEventPublishResultToHost(
          await bus.publish(lilacEventTypes.EvtAdapterActionInvoked, {
            actionId: evt.actionId,
            platform: evt.platform,
            userId: evt.userId,
            messageRef: evt.messageRef,
            sourceMessageId: evt.sourceMessageId,
            ts: evt.ts,
          }),
        );
        break;
      }

      default: {
        const _exhaustive: never = evt;
        return _exhaustive;
      }
    }
  });
}
