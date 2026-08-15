import type { ModelMessage } from "ai";

import {
  lilacEventTypes,
  type LilacBus,
  type CorePrimaryLineageV1,
  type RequestQueueMode,
} from "@stanley2058/lilac-event-bus";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import type { Logger } from "@stanley2058/simple-module-logger";
import { Result, type Result as ResultType } from "better-result";

import type { SurfaceAdapter } from "../../adapter";
import type { MsgRef, SurfaceMessage } from "../../types";
import type { TranscriptStore } from "../../../transcript/transcript-store";
import { adaptEventPublishResultToHost } from "../../../shared/event-bus-result";
import {
  composeRecentChannelMessages,
  composeRequestMessages,
  composeSingleMessageWithLineage,
  type RequestCompositionError,
} from "../../bridge/request-composition";
import { buildDiscordUserAliasById, previewText, type SessionMode } from "./common";

export type PublishBusRequestInput = {
  requestId: string;
  sessionId: string;
  sessionConfigId: string;
  parentChannelId?: string;
  queue: RequestQueueMode;
  triggerType: "mention" | "reply" | "active";
  sessionMode: SessionMode;
  modelOverride?: string;
  messages: ModelMessage[];
  corePrimaryLineage: CorePrimaryLineageV1;
  raw: unknown;
};

function getLastUserPreview(messages: readonly ModelMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return previewText(message.content);
  }
  return undefined;
}

function uniqueNonEmptyStrings(
  values: readonly (string | undefined)[],
  options: { exclude?: string } = {},
): string[] {
  const exclude = options.exclude?.trim();
  return [
    ...new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => !!value && value !== exclude),
    ),
  ];
}

export async function publishBusRequest(params: {
  logger: Logger;
  bus: LilacBus;
  input: PublishBusRequestInput;
}) {
  params.logger.debug("cmd.request.message publish", {
    requestId: params.input.requestId,
    sessionId: params.input.sessionId,
    queue: params.input.queue,
    triggerType: params.input.triggerType,
    modelOverride: params.input.modelOverride,
    messageCount: params.input.messages.length,
    lastUserPreview: getLastUserPreview(params.input.messages),
  });

  adaptEventPublishResultToHost(
    await params.bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        queue: params.input.queue,
        messages: params.input.messages,
        corePrimaryLineage: params.input.corePrimaryLineage,
        ...(params.input.modelOverride ? { modelOverride: params.input.modelOverride } : {}),
        raw: {
          ...(params.input.raw && typeof params.input.raw === "object" ? params.input.raw : {}),
          sessionMode: params.input.sessionMode,
          sessionConfigId: params.input.sessionConfigId,
          ...(params.input.parentChannelId
            ? { parentChannelId: params.input.parentChannelId }
            : {}),
          ...(params.input.modelOverride ? { modelOverride: params.input.modelOverride } : {}),
        },
      },
      {
        headers: {
          request_id: params.input.requestId,
          session_id: params.input.sessionId,
          request_client: "discord",
        },
      },
    ),
  );
}

export async function publishComposedRequest(params: {
  adapter: SurfaceAdapter;
  bus: LilacBus;
  cfg: CoreConfig;
  transcriptStore?: TranscriptStore;
  logger: Logger;
  input: {
    requestId: string;
    sessionId: string;
    sessionConfigId: string;
    parentChannelId?: string;
    queue: RequestQueueMode;
    triggerType: "mention" | "reply" | "active";
    msgRef: MsgRef;
    userId: string;
    sessionMode: SessionMode;
    modelOverride?: string;
    currentMessageIds?: readonly string[];
    transformTriggerUserText?: (text: string) => string;
    transformUserTextForMessageId?: string;
  };
}): Promise<ResultType<void, RequestCompositionError>> {
  const self = await params.adapter.getSelf();
  const discordUserAliasById = buildDiscordUserAliasById(params.cfg);

  const composed = await composeRequestMessages(params.adapter, {
    platform: "discord",
    botUserId: self.userId,
    botName: params.cfg.surface.discord.botName,
    transcriptStore: params.transcriptStore,
    currentRequestId: params.input.requestId,
    currentMessageIds: params.input.currentMessageIds ?? [params.input.msgRef.messageId],
    discordUserAliasById,
    transformUserText: params.input.transformTriggerUserText,
    transformUserTextForMessageId: params.input.transformUserTextForMessageId,
    trigger: {
      type: params.input.triggerType === "mention" ? "mention" : "reply",
      msgRef: params.input.msgRef,
    },
  });
  const continuePublish = composed.match<() => Promise<ResultType<void, RequestCompositionError>>>({
    err: (error) => async () => Result.err(error),
    ok: (composition) => async () => {
      await publishBusRequest({
        logger: params.logger,
        bus: params.bus,
        input: {
          requestId: params.input.requestId,
          sessionId: params.input.sessionId,
          sessionConfigId: params.input.sessionConfigId,
          parentChannelId: params.input.parentChannelId,
          queue: params.input.queue,
          triggerType: params.input.triggerType,
          sessionMode: params.input.sessionMode,
          modelOverride: params.input.modelOverride,
          messages: composition.messages,
          corePrimaryLineage: composition.corePrimaryLineage,
          raw: {
            authenticatedOrigin: {
              platform: "discord",
              userId: params.input.userId,
              messageRef: params.input.msgRef,
            },
            triggerType: params.input.triggerType,
            chainMessageIds: composition.chainMessageIds,
            mergedGroups: composition.mergedGroups,
            participantUserIds: uniqueNonEmptyStrings(
              composition.mergedGroups.map((group) => group.authorId),
              { exclude: self.userId },
            ),
          },
        },
      });
      return Result.ok(undefined);
    },
  });
  return continuePublish();
}

export async function publishActiveChannelPrompt(params: {
  adapter: SurfaceAdapter;
  bus: LilacBus;
  cfg: CoreConfig;
  transcriptStore?: TranscriptStore;
  logger: Logger;
  input: {
    requestId: string;
    sessionId: string;
    sessionConfigId: string;
    parentChannelId?: string;
    triggerMsgRef: MsgRef | undefined;
    triggerType: "mention" | "reply" | undefined;
    sessionMode: SessionMode;
    modelOverride?: string;
    currentMessageIds?: readonly string[];
    botMentionNames?: readonly string[];
    transformTriggerUserText?: (text: string) => string;
    transformUserTextForMessageId?: string;
  };
}): Promise<ResultType<void, RequestCompositionError>> {
  const self = await params.adapter.getSelf();
  const discordUserAliasById = buildDiscordUserAliasById(params.cfg);

  const composed =
    params.input.triggerMsgRef && params.input.triggerType === "reply"
      ? await composeRequestMessages(params.adapter, {
          platform: "discord",
          botUserId: self.userId,
          botName: params.cfg.surface.discord.botName,
          transcriptStore: params.transcriptStore,
          currentRequestId: params.input.requestId,
          currentMessageIds:
            params.input.currentMessageIds ??
            (params.input.triggerMsgRef ? [params.input.triggerMsgRef.messageId] : []),
          discordUserAliasById,
          transformUserText: params.input.transformTriggerUserText,
          transformUserTextForMessageId: params.input.transformUserTextForMessageId,
          trigger: {
            type: "reply",
            msgRef: params.input.triggerMsgRef,
          },
        })
      : await composeRecentChannelMessages(params.adapter, {
          platform: "discord",
          sessionId: params.input.sessionId,
          botUserId: self.userId,
          botName: params.cfg.surface.discord.botName,
          botMentionNames: params.input.botMentionNames,
          limit: 8,
          transcriptStore: params.transcriptStore,
          currentRequestId: params.input.requestId,
          currentMessageIds:
            params.input.currentMessageIds ??
            (params.input.triggerMsgRef ? [params.input.triggerMsgRef.messageId] : []),
          discordUserAliasById,
          transformUserText: params.input.transformTriggerUserText,
          transformUserTextForMessageId: params.input.transformUserTextForMessageId,
          triggerMsgRef: params.input.triggerMsgRef,
          triggerType: params.input.triggerType,
        });
  const continueComposition = composed.match<
    () => Promise<ResultType<void, RequestCompositionError>>
  >({
    err: (error) => async () => Result.err(error),
    ok: (composition) => async () => {
      const originMessageResult: ResultType<SurfaceMessage | null, RequestCompositionError> = params
        .input.triggerMsgRef
        ? await params.adapter.readMsg(params.input.triggerMsgRef)
        : Result.ok<SurfaceMessage | null>(null);
      const continueOrigin = originMessageResult.match<
        () => Promise<ResultType<void, RequestCompositionError>>
      >({
        err: (error) => async () => Result.err(error),
        ok: (originMessage) => async () => {
          await publishBusRequest({
            logger: params.logger,
            bus: params.bus,
            input: {
              requestId: params.input.requestId,
              sessionId: params.input.sessionId,
              sessionConfigId: params.input.sessionConfigId,
              parentChannelId: params.input.parentChannelId,
              queue: "prompt",
              triggerType: params.input.triggerType ?? "active",
              sessionMode: params.input.sessionMode,
              modelOverride: params.input.modelOverride,
              messages: composition.messages,
              corePrimaryLineage: composition.corePrimaryLineage,
              raw: {
                ...(originMessage && params.input.triggerMsgRef
                  ? {
                      authenticatedOrigin: {
                        platform: "discord",
                        userId: originMessage.userId,
                        messageRef: params.input.triggerMsgRef,
                      },
                    }
                  : {}),
                triggerType: params.input.triggerType ?? "active",
                chainMessageIds: composition.chainMessageIds,
                mergedGroups: composition.mergedGroups,
                participantUserIds: uniqueNonEmptyStrings(
                  composition.mergedGroups.map((group) => group.authorId),
                  { exclude: self.userId },
                ),
              },
            },
          });
          return Result.ok(undefined);
        },
      });
      return continueOrigin();
    },
  });
  return continueComposition();
}

export async function publishSingleMessageToActiveRequest(params: {
  adapter: SurfaceAdapter;
  bus: LilacBus;
  cfg: CoreConfig;
  transcriptStore?: TranscriptStore;
  logger: Logger;
  input: {
    requestId: string;
    sessionId: string;
    sessionConfigId: string;
    parentChannelId?: string;
    queue: "followUp" | "steer" | "interrupt";
    msgRef: MsgRef;
    sessionMode: SessionMode;
    modelOverride?: string;
    transformUserText?: (text: string) => string;
  };
}): Promise<ResultType<void, RequestCompositionError>> {
  const self = await params.adapter.getSelf();
  const discordUserAliasById = buildDiscordUserAliasById(params.cfg);

  const composed = await composeSingleMessageWithLineage(params.adapter, {
    platform: "discord",
    botUserId: self.userId,
    botName: params.cfg.surface.discord.botName,
    msgRef: params.input.msgRef,
    discordUserAliasById,
    transcriptStore: params.transcriptStore,
    transformUserText: params.input.transformUserText,
  });
  const continueComposition = composed.match<
    () => Promise<ResultType<void, RequestCompositionError>>
  >({
    err: (error) => async () => Result.err(error),
    ok: (composition) => async () => {
      if (!composition) return Result.ok(undefined);
      const surfaceMessageResult = await params.adapter.readMsg(params.input.msgRef);
      const continueMessage = surfaceMessageResult.match<
        () => Promise<ResultType<void, RequestCompositionError>>
      >({
        err: (error) => async () => Result.err(error),
        ok: (surfaceMessage) => async () => {
          await publishBusRequest({
            logger: params.logger,
            bus: params.bus,
            input: {
              requestId: params.input.requestId,
              sessionId: params.input.sessionId,
              sessionConfigId: params.input.sessionConfigId,
              parentChannelId: params.input.parentChannelId,
              queue: params.input.queue,
              triggerType: "active",
              sessionMode: params.input.sessionMode,
              modelOverride: params.input.modelOverride,
              messages: composition.messages,
              corePrimaryLineage: composition.corePrimaryLineage,
              raw: {
                ...(surfaceMessage
                  ? {
                      authenticatedOrigin: {
                        platform: "discord",
                        userId: surfaceMessage.userId,
                        messageRef: params.input.msgRef,
                      },
                    }
                  : {}),
                triggerType: "active",
                participantUserIds: uniqueNonEmptyStrings([surfaceMessage?.userId], {
                  exclude: self.userId,
                }),
              },
            },
          });
          return Result.ok(undefined);
        },
      });
      return continueMessage();
    },
  });
  return continueComposition();
}

export async function publishSingleMessagePrompt(params: {
  adapter: SurfaceAdapter;
  bus: LilacBus;
  cfg: CoreConfig;
  transcriptStore?: TranscriptStore;
  logger: Logger;
  input: {
    requestId: string;
    sessionId: string;
    sessionConfigId: string;
    parentChannelId?: string;
    msgRef: MsgRef;
    sessionMode: SessionMode;
    modelOverride?: string;
    transformUserText?: (text: string) => string;
    raw?: Record<string, unknown>;
  };
}): Promise<ResultType<void, RequestCompositionError>> {
  const self = await params.adapter.getSelf();
  const discordUserAliasById = buildDiscordUserAliasById(params.cfg);

  const composed = await composeSingleMessageWithLineage(params.adapter, {
    platform: "discord",
    botUserId: self.userId,
    botName: params.cfg.surface.discord.botName,
    msgRef: params.input.msgRef,
    discordUserAliasById,
    transcriptStore: params.transcriptStore,
    transformUserText: params.input.transformUserText,
  });
  const continueComposition = composed.match<
    () => Promise<ResultType<void, RequestCompositionError>>
  >({
    err: (error) => async () => Result.err(error),
    ok: (composition) => async () => {
      if (!composition) return Result.ok(undefined);
      const surfaceMessageResult = await params.adapter.readMsg(params.input.msgRef);
      const continueMessage = surfaceMessageResult.match<
        () => Promise<ResultType<void, RequestCompositionError>>
      >({
        err: (error) => async () => Result.err(error),
        ok: (surfaceMessage) => async () => {
          await publishBusRequest({
            logger: params.logger,
            bus: params.bus,
            input: {
              requestId: params.input.requestId,
              sessionId: params.input.sessionId,
              sessionConfigId: params.input.sessionConfigId,
              parentChannelId: params.input.parentChannelId,
              queue: "prompt",
              triggerType: "active",
              sessionMode: params.input.sessionMode,
              modelOverride: params.input.modelOverride,
              messages: composition.messages,
              corePrimaryLineage: composition.corePrimaryLineage,
              raw: {
                ...(surfaceMessage
                  ? {
                      authenticatedOrigin: {
                        platform: "discord",
                        userId: surfaceMessage.userId,
                        messageRef: params.input.msgRef,
                      },
                    }
                  : {}),
                triggerType: "active",
                chainMessageIds: [params.input.msgRef.messageId],
                participantUserIds: uniqueNonEmptyStrings([surfaceMessage?.userId], {
                  exclude: self.userId,
                }),
                ...params.input.raw,
              },
            },
          });
          return Result.ok(undefined);
        },
      });
      return continueMessage();
    },
  });
  return continueComposition();
}

export async function publishSurfaceOutputReanchor(input: {
  bus: LilacBus;
  requestId: string;
  sessionId: string;
  inheritReplyTo: boolean;
  replyTo?: MsgRef;
  mode?: "steer" | "interrupt";
}) {
  adaptEventPublishResultToHost(
    await input.bus.publish(
      lilacEventTypes.CmdSurfaceOutputReanchor,
      {
        inheritReplyTo: input.inheritReplyTo,
        mode: input.mode,
        replyTo: input.replyTo
          ? {
              platform: input.replyTo.platform,
              channelId: input.replyTo.channelId,
              messageId: input.replyTo.messageId,
            }
          : undefined,
      },
      {
        headers: {
          request_id: input.requestId,
          session_id: input.sessionId,
          request_client: "discord",
        },
      },
    ),
  );
}
