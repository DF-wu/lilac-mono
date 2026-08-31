import {
  type CacheType,
  type Channel,
  Client,
  MessageFlags,
  MessageType,
  type Message,
  type RepliableInteraction,
} from "discord.js";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import { Panic, Result } from "better-result";

import { settleSurfaceFallback } from "../adapter";

export function shouldAllowMessage(params: {
  cfg: CoreConfig;
  channelId: string;
  guildId?: string | null;
}): boolean {
  const allowedChannelIds = new Set(params.cfg.surface.discord.allowedChannelIds);
  const allowedGuildIds = new Set(params.cfg.surface.discord.allowedGuildIds);

  if (allowedChannelIds.size === 0 && allowedGuildIds.size === 0) return false;

  if (allowedChannelIds.has(params.channelId)) return true;

  const gid = params.guildId ?? null;
  if (gid && allowedGuildIds.has(gid)) return true;

  return false;
}

export type SendableDiscordChannel = {
  send: Extract<Channel, { send: (...args: never[]) => unknown }>["send"];
};

export function isTextSendableChannel(ch: Channel | null): ch is Channel & SendableDiscordChannel {
  return ch !== null && "send" in ch && typeof ch.send === "function";
}

export async function resolveTextSendableChannel(
  client: Client,
  channelId: string,
): Promise<SendableDiscordChannel | null> {
  const fetched = settleSurfaceFallback(
    await Result.tryPromise({
      try: () => client.channels.fetch(channelId),
      catch: (cause) =>
        Panic.is(cause)
          ? { kind: "panic", panic: cause, fallback: null }
          : { kind: "fallback", fallback: null },
    }),
  );
  const channel = fetched.unwrapOr(null);
  return isTextSendableChannel(channel) ? channel : null;
}

export async function replyEphemeral(
  interaction: RepliableInteraction<CacheType>,
  content: string,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({
      content,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
  });
}

export async function editOrReplyEphemeral(
  interaction: RepliableInteraction<CacheType>,
  content: string,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content });
    return;
  }

  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
  });
}

export async function tryReplyEphemeral(
  interaction: RepliableInteraction<CacheType>,
  content: string,
): Promise<void> {
  settleSurfaceFallback(
    await Result.tryPromise({
      try: () => replyEphemeral(interaction, content),
      catch: (cause) =>
        Panic.is(cause)
          ? { kind: "panic", panic: cause, fallback: undefined }
          : { kind: "fallback", fallback: undefined },
    }),
  );
}

export async function tryEditOrReplyEphemeral(
  interaction: RepliableInteraction<CacheType>,
  content: string,
): Promise<void> {
  settleSurfaceFallback(
    await Result.tryPromise({
      try: () => editOrReplyEphemeral(interaction, content),
      catch: (cause) =>
        Panic.is(cause)
          ? { kind: "panic", panic: cause, fallback: undefined }
          : { kind: "fallback", fallback: undefined },
    }),
  );
}

export function isRoutableDiscordUserMessage(msg: Message): boolean {
  if (msg.author.bot) return false;
  if (msg.system) return false;

  return msg.type === MessageType.Default || msg.type === MessageType.Reply;
}

export function hasExplicitDiscordUserMentionInContent(input: {
  content: string;
  userId: string;
}): boolean {
  return (
    input.content.includes(`<@${input.userId}>`) || input.content.includes(`<@!${input.userId}>`)
  );
}

export function isExplicitDiscordUserMention(input: {
  content: string;
  userId: string;
  hasParsedMention: boolean;
}): boolean {
  return (
    input.hasParsedMention &&
    hasExplicitDiscordUserMentionInContent({
      content: input.content,
      userId: input.userId,
    })
  );
}
