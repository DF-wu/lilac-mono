import type { SurfaceAdapter } from "../../adapter";
import type { MsgRef, SurfaceMessage } from "../../types";
import type { TranscriptStore } from "../../../transcript/transcript-store";
import { buildAssistantOnlyMessageFromTranscript } from "../../bridge/request-composition/normalization";
import type { DiscordMessageCacheAccess } from "../../store/discord-search-store";

import { compareMessagePosition, normalizeGateText } from "./common";
import type { BufferedMessage } from "./gate";

export async function resolvePreviousMessageText(params: {
  adapter: SurfaceAdapter;
  messageCache?: DiscordMessageCacheAccess;
  input: {
    msgRef: MsgRef;
    triggerTs: number;
  };
}): Promise<string | undefined> {
  const cached = params.messageCache?.listIndexedMessagesBefore({
    channelId: params.input.msgRef.channelId,
    before: { messageId: params.input.msgRef.messageId, ts: params.input.triggerTs },
    limit: 8,
  });
  if (cached && cached.length > 0) return normalizeGateText(cached.at(-1)?.text);

  const around = await params.adapter.getReplyContext(params.input.msgRef, { limit: 8 });
  const messages = around.match({
    err: () => [] as readonly SurfaceMessage[],
    ok: (value) => value,
  });
  if (messages.length === 0) return undefined;

  let prev: SurfaceMessage | null = null;
  for (const candidate of messages) {
    const cmp = compareMessagePosition(
      { ts: candidate.ts, messageId: candidate.ref.messageId },
      { ts: params.input.triggerTs, messageId: params.input.msgRef.messageId },
    );
    if (cmp >= 0) continue;
    if (
      !prev ||
      compareMessagePosition(
        { ts: prev.ts, messageId: prev.ref.messageId },
        { ts: candidate.ts, messageId: candidate.ref.messageId },
      ) < 0
    ) {
      prev = candidate;
    }
  }

  return normalizeGateText(prev?.text);
}

export async function resolveRepliedToMessageText(params: {
  adapter: SurfaceAdapter;
  messageCache?: DiscordMessageCacheAccess;
  transcriptStore?: TranscriptStore;
  input: {
    sessionId: string;
    replyToMessageId?: string;
  };
}): Promise<string | undefined> {
  if (!params.input.replyToMessageId) return undefined;

  const cached = params.messageCache?.getIndexedMessage({
    channelId: params.input.sessionId,
    messageId: params.input.replyToMessageId,
  });
  if (cached && !cached.deleted) return normalizeGateText(cached.text);

  const linked = params.transcriptStore?.getTranscriptBySurfaceMessage({
    platform: "discord",
    channelId: params.input.sessionId,
    messageId: params.input.replyToMessageId,
  });
  const snapshot =
    linked?.match({
      ok: (value) =>
        value?.requestClient === "discord" && value.sessionId === params.input.sessionId
          ? value
          : null,
      err: () => null,
    }) ?? null;
  const assistant = snapshot ? buildAssistantOnlyMessageFromTranscript(snapshot) : null;
  if (assistant && typeof assistant.content === "string") {
    return normalizeGateText(assistant.content);
  }

  const repliedTo = await params.adapter.readMsg({
    platform: "discord",
    channelId: params.input.sessionId,
    messageId: params.input.replyToMessageId,
  });
  return normalizeGateText(
    repliedTo.match({
      err: () => undefined,
      ok: (value) => value?.text,
    }),
  );
}

export async function resolvePreviousBatchMessageText(params: {
  adapter: SurfaceAdapter;
  messageCache?: DiscordMessageCacheAccess;
  messages: readonly BufferedMessage[];
}): Promise<string | undefined> {
  if (params.messages.length === 0) return undefined;

  const oldest = params.messages.reduce((best, cur) => {
    return compareMessagePosition(
      { ts: cur.ts, messageId: cur.msgRef.messageId },
      { ts: best.ts, messageId: best.msgRef.messageId },
    ) < 0
      ? cur
      : best;
  });

  return resolvePreviousMessageText({
    adapter: params.adapter,
    messageCache: params.messageCache,
    input: {
      msgRef: oldest.msgRef,
      triggerTs: oldest.ts,
    },
  });
}
