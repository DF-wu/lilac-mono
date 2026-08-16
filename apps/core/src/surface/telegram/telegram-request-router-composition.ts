import type { ModelMessage } from "ai";
import type { EvtAdapterMessageCreatedData } from "@stanley2058/lilac-event-bus";
import { z } from "zod";

import {
  customCommandInvocationErrorText,
  type CustomCommandArgumentValue,
  type CustomCommandManager,
} from "../../custom-commands/manager";
import type { SurfaceAdapter } from "../adapter";
import type { MsgRef, SurfaceMessage } from "../types";
import { formatSurfaceAttributionHeader } from "../bridge/request-composition/normalization";

const telegramFlagsSchema = z
  .object({
    telegram: z
      .object({
        isDMBased: z.boolean().optional(),
        mentionsBot: z.boolean().optional(),
        replyToBot: z.boolean().optional(),
        replyToMessageId: z.string().optional(),
        parentChannelId: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type TelegramFlags = z.output<typeof telegramFlagsSchema>["telegram"];

export function telegramFlags(input: { readonly raw?: unknown }): TelegramFlags {
  const parsed = telegramFlagsSchema.safeParse(input.raw);
  return parsed.success ? parsed.data.telegram : {};
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function visibleTelegramText(
  text: string,
  botNames: readonly string[],
  modelOverride?: string,
): string {
  const names = botNames.map(escapeRegExp).join("|");
  const withoutMention = names
    ? text.replace(new RegExp(`^\\s*@(?:${names})(?:[:,]\\s*|\\s+)`, "iu"), "")
    : text;
  return modelOverride
    ? withoutMention.replace(/^\s*(?:[:,]\s*)?!(?:m|model):[^\s]+(?:\s+|$)/iu, "")
    : withoutMention;
}

export function messageRef(event: EvtAdapterMessageCreatedData): MsgRef {
  return { platform: "telegram", channelId: event.channelId, messageId: event.messageId };
}

function fallbackMessage(event: EvtAdapterMessageCreatedData): SurfaceMessage {
  return {
    ref: messageRef(event),
    session: { platform: "telegram", channelId: event.channelId },
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

export async function composeTelegramMessages(input: {
  readonly adapter: SurfaceAdapter;
  readonly event: EvtAdapterMessageCreatedData;
  readonly botUserId: string;
  readonly botNames: readonly string[];
  readonly modelOverride?: string;
}): Promise<{ readonly messages: ModelMessage[]; readonly chainMessageIds: string[] }> {
  const chain: SurfaceMessage[] = [];
  const seen = new Set<string>();
  const triggerFlags = telegramFlags(input.event);
  let current =
    (await readMessage(input.adapter, messageRef(input.event))) ?? fallbackMessage(input.event);
  while (!seen.has(current.ref.messageId) && chain.length < 20) {
    seen.add(current.ref.messageId);
    chain.unshift(current);
    const replyToMessageId =
      current.ref.messageId === input.event.messageId
        ? triggerFlags.replyToMessageId
        : telegramFlags(current).replyToMessageId;
    if (!replyToMessageId) break;
    const ancestor = await readMessage(input.adapter, {
      platform: "telegram",
      channelId: current.ref.channelId,
      messageId: replyToMessageId,
    });
    if (!ancestor) break;
    current = ancestor;
  }
  return {
    messages: chain.map((message) => {
      const text =
        message.ref.messageId === input.event.messageId
          ? visibleTelegramText(message.text, input.botNames, input.modelOverride)
          : message.text;
      if (message.userId === input.botUserId) return { role: "assistant", content: text };
      const header = formatSurfaceAttributionHeader({
        platform: "telegram",
        authorId: message.userId,
        authorName: message.userName ?? `user_${message.userId}`,
        messageId: message.ref.messageId,
        messageTs: message.ts,
      });
      return { role: "user", content: `${header}\n${text}` };
    }),
    chainMessageIds: chain.map((message) => message.ref.messageId),
  };
}
