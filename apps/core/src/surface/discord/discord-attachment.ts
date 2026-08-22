import { createHash } from "node:crypto";

import type { BlobRefV1 } from "@stanley2058/lilac-blob-storage";

import type { NormalizedDiscordRaw } from "./discord-raw-normalizer";

export type DiscordAttachmentMeta = {
  id?: string;
  url: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  cache?: DiscordAttachmentCacheEntry;
};

export type DiscordIndexedAttachmentMeta = Omit<DiscordAttachmentMeta, "url">;

export type DiscordAttachmentCacheEntry = {
  readonly blob: BlobRefV1;
  readonly cachedAt: number;
};

export type DiscordAttachmentCacheKey = {
  readonly channelId: string;
  readonly messageId: string;
  readonly ordinal: number;
  readonly attachmentId?: string;
};

export type DiscordAttachmentCacheAccess = {
  get(input: DiscordAttachmentCacheKey): DiscordAttachmentCacheEntry | null;
  put(input: DiscordAttachmentCacheKey & DiscordAttachmentCacheEntry): void;
  clear(input: DiscordAttachmentCacheKey & { readonly expected: BlobRefV1 }): BlobRefV1 | null;
};

export function selectVisibleDiscordAttachments(
  normalized: NormalizedDiscordRaw | null,
): DiscordAttachmentMeta[] {
  const snapshotAttachments = normalized?.forwardSnapshot?.attachments;
  if (snapshotAttachments && snapshotAttachments.length > 0) return snapshotAttachments;
  return normalized?.attachments ?? [];
}

export function toIndexedDiscordAttachments(
  attachments: readonly DiscordAttachmentMeta[],
): DiscordIndexedAttachmentMeta[] {
  return attachments.map((attachment) => ({
    ...(attachment.id ? { id: attachment.id } : {}),
    ...(attachment.filename ? { filename: attachment.filename } : {}),
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    ...(attachment.cache ? { cache: attachment.cache } : {}),
  }));
}

export function hashIndexedDiscordAttachments(
  attachments: readonly DiscordIndexedAttachmentMeta[],
): string {
  return createHash("sha256")
    .update(
      attachments
        .map((attachment, ordinal) =>
          [
            ordinal,
            attachment.id ?? "",
            attachment.filename ?? "",
            attachment.mimeType ?? "",
            attachment.size ?? "",
          ].join("\u001f"),
        )
        .join("\u001e"),
    )
    .digest("hex");
}
