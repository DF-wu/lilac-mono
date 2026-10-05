import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import type { BusMessageV2, EvtAdapterMessageCreatedData } from "@stanley2058/lilac-event-bus";
import { z } from "zod";

import {
  customCommandInvocationErrorText,
  type CustomCommandArgumentValue,
  type CustomCommandManager,
} from "../../custom-commands/manager";
import { hasSurfaceAttachmentResolver, type SurfaceAdapter } from "../adapter";
import type { MsgRef, SurfaceMessage, TelegramMsgRef } from "../types";
import { formatSurfaceAttributionHeader } from "../bridge/request-composition/normalization";
import {
  appendTelegramMediaToUserContent,
  createTelegramInboundMediaBudget,
  telegramInboundMediaFromRaw,
  type TelegramBusUserContentPart,
  type TelegramInboundMediaConfig,
} from "./telegram-inbound-media";

const telegramFlagsSchema = z
  .object({
    telegram: z
      .object({
        isDMBased: z.boolean().optional(),
        mentionsBot: z.boolean().optional(),
        replyToBot: z.boolean().optional(),
        replyToMessageId: z.string().optional(),
        parentChannelId: z.string().optional(),
        botUserId: z.string().optional(),
      })
      .loose(),
  })
  .loose();

export type TelegramFlags = z.output<typeof telegramFlagsSchema>["telegram"];

export function telegramFlags(input: { readonly raw?: unknown }): TelegramFlags {
  const parsed = telegramFlagsSchema.safeParse(input.raw);
  return parsed.success ? parsed.data.telegram : {};
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Drop the leading `@handle` the user typed to address the bot. Directive
 * stripping (`!model:`, `!continue`, `!interrupt`) happens before this through
 * the shared router helpers, which keep the mention prefix in place.
 */
function stripLeadingBotMention(text: string, botNames: readonly string[]): string {
  const names = botNames.map(escapeRegExp).join("|");
  if (!names) return text;
  return text.replace(new RegExp(`^\\s*@(?:${names})(?:[:,]\\s*|\\s+)`, "iu"), "");
}

/** The message subset every routed Telegram message carries, on or off the bus. */
export type TelegramRoutedMessage = Pick<
  EvtAdapterMessageCreatedData,
  "channelId" | "messageId" | "userId" | "userName" | "text" | "ts" | "raw"
> & { readonly platform?: EvtAdapterMessageCreatedData["platform"] };

export function messageRef(event: TelegramRoutedMessage): TelegramMsgRef {
  return { platform: "telegram", channelId: event.channelId, messageId: event.messageId };
}

/**
 * The message as the bus event described it, used when the local index has no
 * copy yet. It carries no raw envelope: reply flags come from the event's own
 * decoded flags, and media needs the indexed copy's stored file ids.
 */
export function surfaceMessageFromEvent(event: TelegramRoutedMessage): SurfaceMessage {
  const flags = telegramFlags(event);
  return {
    ref: messageRef(event),
    session: {
      platform: "telegram",
      channelId: event.channelId,
      ...(flags.parentChannelId ? { parentChannelId: flags.parentChannelId } : {}),
    },
    userId: event.userId,
    ...(event.userName ? { userName: event.userName } : {}),
    text: event.text,
    ts: event.ts,
  };
}

export type TelegramCustomCommandMetadata = {
  readonly customCommand: {
    readonly name: string;
    readonly args: readonly (CustomCommandArgumentValue | undefined)[];
    readonly text: string;
    readonly source: "text";
    readonly prompt?: string;
    readonly error?: string;
  };
};

export function commandMetadata(
  commands: CustomCommandManager,
  text: string,
  botUsername: string | undefined,
): TelegramCustomCommandMetadata | null {
  const options = botUsername ? { botUsername } : {};
  const name = commands.peekTextName(text, options);
  if (!name) return null;
  const parsed = commands.parseText(text, options);
  return parsed.match({
    err: (error) => ({
      customCommand: {
        name,
        args: [],
        text,
        source: "text",
        error: customCommandInvocationErrorText(error),
      },
    }),
    ok: (invocation) =>
      invocation
        ? {
            customCommand: {
              name: invocation.command.def.name,
              args: invocation.args,
              ...(invocation.prompt ? { prompt: invocation.prompt } : {}),
              text: invocation.text,
              source: "text",
            },
          }
        : {
            customCommand: {
              name,
              args: [],
              text,
              source: "text",
              error: `Unknown custom command '${name}'.`,
            },
          },
  });
}

export async function readMessage(
  adapter: SurfaceAdapter,
  ref: MsgRef,
): Promise<SurfaceMessage | null> {
  const read = await adapter.readMsg(ref);
  return read.match({
    ok: (message) => message,
    err: (error) => {
      throw error;
    },
  });
}

const MAX_REPLY_CHAIN_DEPTH = 20;

function compareMessages(a: SurfaceMessage, b: SurfaceMessage): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  const left = Number(a.ref.messageId);
  const right = Number(b.ref.messageId);
  if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
  return a.ref.messageId.localeCompare(b.ref.messageId);
}

/**
 * Walk the reply chain behind `anchor` through the local history index. The
 * anchor itself is included; the result is oldest first. `anchorFlags` are the
 * trigger event's own decoded flags, which stand in when the indexed copy of
 * the anchor has not been written yet.
 */
async function resolveReplyChain(
  adapter: SurfaceAdapter,
  anchor: SurfaceMessage,
  anchorFlags: TelegramFlags,
): Promise<SurfaceMessage[]> {
  const chain: SurfaceMessage[] = [];
  const seen = new Set<string>();
  let current = anchor;
  while (!seen.has(current.ref.messageId) && chain.length < MAX_REPLY_CHAIN_DEPTH) {
    seen.add(current.ref.messageId);
    chain.unshift(current);
    const replyToMessageId =
      current.ref.messageId === anchor.ref.messageId
        ? (telegramFlags(current).replyToMessageId ?? anchorFlags.replyToMessageId)
        : telegramFlags(current).replyToMessageId;
    if (!replyToMessageId) break;
    const ancestor = await readMessage(adapter, {
      platform: "telegram",
      channelId: current.ref.channelId,
      messageId: replyToMessageId,
    });
    if (!ancestor) break;
    current = ancestor;
  }
  return chain;
}

/** Prefer the indexed copy: it carries the stored raw envelope and media file ids. */
async function resolveIndexedOrGiven(
  adapter: SurfaceAdapter,
  event: TelegramRoutedMessage,
): Promise<SurfaceMessage> {
  return (await readMessage(adapter, messageRef(event))) ?? surfaceMessageFromEvent(event);
}

export type ComposeTelegramMessagesInput = {
  readonly adapter: SurfaceAdapter;
  /** The message that triggered this request; it anchors the reply chain. */
  readonly event: TelegramRoutedMessage;
  /**
   * Other current messages to include beside the trigger (an active-mode
   * batch or a pending mention-reply batch). Ordered by time with the chain.
   */
  readonly batch?: readonly TelegramRoutedMessage[];
  /** `false` composes only the current messages, as steer and follow-up do. */
  readonly includeReplyChain?: boolean;
  readonly botUserId: string;
  readonly botNames: readonly string[];
  readonly blobStore: BlobStore;
  readonly inboundMedia?: TelegramInboundMediaConfig;
  /** Applied to one current user message, usually the directive carrier. */
  readonly transformUserText?: (text: string) => string;
  readonly transformUserTextForMessageId?: string;
};

export type ComposedTelegramRequest = {
  readonly messages: BusMessageV2[];
  readonly chainMessageIds: string[];
  readonly participantUserIds: string[];
  readonly mediaDelivered: boolean;
};

export async function composeTelegramMessages(
  input: ComposeTelegramMessagesInput,
): Promise<ComposedTelegramRequest> {
  const trigger = await resolveIndexedOrGiven(input.adapter, input.event);
  const chain =
    input.includeReplyChain === false
      ? [trigger]
      : await resolveReplyChain(input.adapter, trigger, telegramFlags(input.event));

  const byId = new Map<string, SurfaceMessage>();
  for (const message of chain) byId.set(message.ref.messageId, message);
  for (const event of input.batch ?? []) {
    if (byId.has(event.messageId)) continue;
    byId.set(event.messageId, await resolveIndexedOrGiven(input.adapter, event));
  }
  const ordered = [...byId.values()].sort(compareMessages);
  const currentIds = new Set([
    input.event.messageId,
    ...(input.batch ?? []).map((event) => event.messageId),
  ]);
  const transformTargetId = input.transformUserTextForMessageId ?? input.event.messageId;

  const mediaPartsByMessageId = await resolveChainMediaParts({
    adapter: input.adapter,
    chain: ordered,
    botUserId: input.botUserId,
    blobStore: input.blobStore,
    inboundMedia: input.inboundMedia,
  });

  let mediaDelivered = false;
  const participants = new Set<string>();
  const messages = ordered.map((message): BusMessageV2 => {
    if (message.userId === input.botUserId) return { role: "assistant", content: message.text };
    participants.add(message.userId);
    const text = visibleUserText(message, {
      isCurrent: currentIds.has(message.ref.messageId),
      transform: message.ref.messageId === transformTargetId ? input.transformUserText : undefined,
      botNames: input.botNames,
    });
    const header = formatSurfaceAttributionHeader({
      platform: "telegram",
      authorId: message.userId,
      authorName: message.userName ?? `user_${message.userId}`,
      messageId: message.ref.messageId,
      messageTs: message.ts,
    });
    const mainText = `${header}\n${text}`.trimEnd();
    const mediaParts = mediaPartsByMessageId.get(message.ref.messageId);
    if (!mediaParts || mediaParts.length === 0) return { role: "user", content: mainText };
    if (mediaParts.some((part) => part.type === "blob")) mediaDelivered = true;
    return { role: "user", content: [{ type: "text", text: mainText }, ...mediaParts] };
  });

  return {
    messages,
    chainMessageIds: ordered.map((message) => message.ref.messageId),
    participantUserIds: [...participants],
    mediaDelivered,
  };
}

function visibleUserText(
  message: SurfaceMessage,
  opts: {
    readonly isCurrent: boolean;
    readonly transform?: (text: string) => string;
    readonly botNames: readonly string[];
  },
): string {
  if (!opts.isCurrent) return message.text;
  const transformed = opts.transform ? opts.transform(message.text) : message.text;
  return stripLeadingBotMention(transformed, opts.botNames);
}

async function resolveChainMediaParts(input: {
  readonly adapter: SurfaceAdapter;
  readonly chain: readonly SurfaceMessage[];
  readonly botUserId: string;
  readonly blobStore: BlobStore;
  readonly inboundMedia?: TelegramInboundMediaConfig;
}): Promise<ReadonlyMap<string, readonly TelegramBusUserContentPart[]>> {
  const parts = new Map<string, readonly TelegramBusUserContentPart[]>();
  const config = input.inboundMedia;
  if (!config?.enabled || !hasSurfaceAttachmentResolver(input.adapter)) return parts;

  // Newest first: the trigger wins the shared byte budget over older history.
  const budget = createTelegramInboundMediaBudget(config);
  for (let index = input.chain.length - 1; index >= 0; index -= 1) {
    const message = input.chain[index];
    if (!message || message.userId === input.botUserId) continue;
    const media = telegramInboundMediaFromRaw(message);
    if (media.length === 0) continue;

    const messageParts: TelegramBusUserContentPart[] = [];
    await appendTelegramMediaToUserContent({
      parts: messageParts,
      media,
      resolver: input.adapter,
      blobStore: input.blobStore,
      budget,
    });
    parts.set(message.ref.messageId, messageParts);
  }
  return parts;
}
