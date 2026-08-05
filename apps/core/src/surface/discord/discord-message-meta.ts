import {
  ActivityType,
  type Attachment,
  type Embed,
  type Message,
  type MessageSnapshot,
  MessageType,
  type Presence,
} from "discord.js";
import { z } from "zod";

import type { SurfaceSessionParticipant, SurfaceSessionParticipantActivity } from "../types";
import {
  buildDiscordTaggedTextFromContentAndEmbeds,
  type DiscordEmbedTextMeta,
} from "./discord-embed-text";

export function getChannelName<T extends { isDMBased?: () => boolean } | { name?: string }>(
  channel: T | null,
): string | undefined {
  if (!channel) return undefined;
  if ("isDMBased" in channel && typeof channel.isDMBased === "function" && channel.isDMBased()) {
    return "dm";
  }
  const n = "name" in channel ? channel.name : undefined;
  return typeof n === "string" ? n : undefined;
}

export function getMessageTs(msg: Message): number {
  return msg.createdTimestamp;
}

export function getMessageEditedTs(msg: Message): number | undefined {
  return msg.editedTimestamp ?? undefined;
}

export function getDisplayName(msg: Message): string {
  const memberName = msg.member && "displayName" in msg.member ? msg.member.displayName : undefined;
  return memberName ?? msg.author.globalName ?? msg.author.username;
}

export function toSurfaceParticipantActivities(
  presence: Presence | null | undefined,
): SurfaceSessionParticipantActivity[] {
  if (!presence) return [];

  const out: SurfaceSessionParticipantActivity[] = [];
  for (const activity of presence.activities) {
    const typeName = ActivityType[activity.type];
    const mapped: SurfaceSessionParticipantActivity = {
      type: typeof typeName === "string" ? typeName.toLowerCase() : String(activity.type),
    };

    if (typeof activity.name === "string" && activity.name.length > 0) {
      mapped.name = activity.name;
    }
    if (typeof activity.state === "string" && activity.state.length > 0) {
      mapped.state = activity.state;
    }
    if (typeof activity.details === "string" && activity.details.length > 0) {
      mapped.details = activity.details;
    }
    if (typeof activity.url === "string" && activity.url.length > 0) {
      mapped.url = activity.url;
    }
    if (activity.emoji?.name && activity.emoji.name.length > 0) {
      mapped.emoji = activity.emoji.name;
    }

    out.push(mapped);
  }

  return out;
}

export function sortSurfaceParticipants(
  participants: readonly SurfaceSessionParticipant[],
): SurfaceSessionParticipant[] {
  return [...participants].sort((a, b) => {
    const aName = (a.displayName ?? a.userName ?? a.userId).toLowerCase();
    const bName = (b.displayName ?? b.userName ?? b.userId).toLowerCase();
    if (aName !== bName) return aName.localeCompare(bName);
    return a.userId.localeCompare(b.userId);
  });
}

export type DiscordAttachmentMeta = {
  url: string;
  filename?: string;
  mimeType?: string;
  size?: number;
};

const DISCORD_REFERENCE_TYPE_DEFAULT = 0;
const DISCORD_REFERENCE_TYPE_FORWARD = 1;

export function normalizeDiscordReference(msg: Message): {
  messageId?: string;
  channelId?: string;
  guildId?: string;
  type?: number;
} | null {
  const ref = msg.reference;
  if (!ref) return null;

  const messageId = typeof ref.messageId === "string" ? ref.messageId : undefined;
  const channelId = typeof ref.channelId === "string" ? ref.channelId : undefined;
  const guildId = typeof ref.guildId === "string" ? ref.guildId : undefined;
  const type = typeof ref.type === "number" ? ref.type : undefined;

  if (!messageId && !channelId && !guildId && type === undefined) {
    return null;
  }

  return {
    ...(messageId ? { messageId } : {}),
    ...(channelId ? { channelId } : {}),
    ...(guildId ? { guildId } : {}),
    ...(type !== undefined ? { type } : {}),
  };
}

export function getReplyReference(msg: Message): {
  messageId: string;
  channelId?: string;
} | null {
  const ref = normalizeDiscordReference(msg);
  if (!ref?.messageId) return null;

  const type = ref.type ?? DISCORD_REFERENCE_TYPE_DEFAULT;
  if (type === DISCORD_REFERENCE_TYPE_FORWARD) return null;

  return {
    messageId: ref.messageId,
    ...(ref.channelId ? { channelId: ref.channelId } : {}),
  };
}

function toDiscordAttachmentMeta(attachment: Attachment): DiscordAttachmentMeta {
  return {
    url: attachment.url,
    filename: attachment.name,
    ...(attachment.contentType ? { mimeType: attachment.contentType } : {}),
    size: attachment.size,
  };
}

export function collectDiscordAttachmentMeta(input: Iterable<Attachment>): DiscordAttachmentMeta[] {
  return [...input].map(toDiscordAttachmentMeta);
}

function projectDiscordEmbed(embed: Embed): DiscordEmbedTextMeta {
  return {
    ...(embed.title ? { title: embed.title } : {}),
    ...(embed.description ? { description: embed.description } : {}),
    ...(embed.fields.length > 0
      ? {
          fields: embed.fields.map((field) => ({ name: field.name, value: field.value })),
        }
      : {}),
    ...(embed.image?.url ? { imageUrl: embed.image.url } : {}),
    ...(embed.footer?.text ? { footer: embed.footer.text } : {}),
  };
}

function getSnapshotEmbeds(snapshot: MessageSnapshot): DiscordEmbedTextMeta[] {
  return snapshot.embeds.map(projectDiscordEmbed);
}

const discordFlagsSchema = z.union([
  z.number().finite(),
  z.bigint(),
  z.object({ bitfield: z.union([z.number().finite(), z.bigint()]) }).passthrough(),
]);

function normalizeFlagsNumber(input: unknown): number | undefined {
  const parsed = discordFlagsSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const bitfield = typeof parsed.data === "object" ? parsed.data.bitfield : parsed.data;
  if (typeof bitfield === "number") return Number.isFinite(bitfield) ? bitfield : undefined;
  const number = Number(bitfield);
  return Number.isFinite(number) ? number : undefined;
}

export function getForwardSnapshotPayload(msg: Message): {
  content: string;
  embeds: DiscordEmbedTextMeta[];
  attachments: DiscordAttachmentMeta[];
  timestamp?: number;
  editedTimestamp?: number;
  flags?: number;
} | null {
  const ref = normalizeDiscordReference(msg);
  const referenceType = ref?.type ?? DISCORD_REFERENCE_TYPE_DEFAULT;
  if (referenceType !== DISCORD_REFERENCE_TYPE_FORWARD) return null;

  const snapshots = msg.messageSnapshots;
  if (!snapshots || snapshots.size === 0) return null;

  const snapshot = snapshots.first();
  if (!snapshot) return null;

  const content = snapshot.content;
  const embeds = getSnapshotEmbeds(snapshot);
  const attachments = collectDiscordAttachmentMeta(snapshot.attachments.values());
  const timestamp = snapshot.createdTimestamp;
  const editedTimestamp = snapshot.editedTimestamp ?? undefined;
  const flags = normalizeFlagsNumber(snapshot.flags);

  return {
    content,
    embeds,
    attachments,
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(editedTimestamp !== undefined ? { editedTimestamp } : {}),
    ...(flags !== undefined ? { flags } : {}),
  };
}

export function buildForwardMessageSnapshots(
  forwardSnapshot: ReturnType<typeof getForwardSnapshotPayload>,
): Array<{ message: Record<string, unknown> }> | undefined {
  if (!forwardSnapshot) return undefined;

  return [
    {
      message: {
        content: forwardSnapshot.content,
        embeds: forwardSnapshot.embeds,
        attachments: forwardSnapshot.attachments,
        ...(forwardSnapshot.timestamp !== undefined
          ? { timestamp: forwardSnapshot.timestamp }
          : {}),
        ...(forwardSnapshot.editedTimestamp !== undefined
          ? { editedTimestamp: forwardSnapshot.editedTimestamp }
          : {}),
        ...(forwardSnapshot.flags !== undefined ? { flags: forwardSnapshot.flags } : {}),
      },
    },
  ];
}

export function getMessageEmbeds(msg: Message): DiscordEmbedTextMeta[] {
  return msg.embeds.map(projectDiscordEmbed);
}

function joinNonEmptyTextBlocks(blocks: readonly string[]): string {
  const nonEmpty = blocks.filter((block) => block.length > 0);
  return nonEmpty.join("\n\n");
}

export function getStoredTextFromDiscordMessage(input: {
  msg: Message;
  forwardSnapshot: ReturnType<typeof getForwardSnapshotPayload>;
}): string {
  const { msg, forwardSnapshot } = input;
  const embeds = getMessageEmbeds(msg);
  const hasOnlyEmbeds = (msg.content ?? "").trim().length === 0 && embeds.length > 0;
  const topText = buildDiscordTaggedTextFromContentAndEmbeds({
    content: msg.content ?? "",
    embeds,
    labelEmbeds: !(msg.author.bot && hasOnlyEmbeds),
  });
  const snapshotText = forwardSnapshot
    ? buildDiscordTaggedTextFromContentAndEmbeds({
        content: forwardSnapshot.content,
        embeds: forwardSnapshot.embeds,
      })
    : "";

  return joinNonEmptyTextBlocks([topText, snapshotText]);
}

export function isDiscordChatLikeMessage(msg: Message): boolean {
  if (msg.system) return false;
  return msg.type === MessageType.Default || msg.type === MessageType.Reply;
}

export function getDiscordMessageTypeName(msg: Message): string {
  const name = MessageType[msg.type];
  return typeof name === "string" && name.length > 0 ? name : String(msg.type);
}

export function previewText(text: string, max = 400): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}...`;
}
