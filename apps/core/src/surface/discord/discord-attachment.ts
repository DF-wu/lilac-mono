import { createHash } from "node:crypto";

import type { NormalizedDiscordRaw } from "./discord-raw-normalizer";

export type DiscordAttachmentMeta = {
  id?: string;
  url: string;
  filename?: string;
  mimeType?: string;
  size?: number;
};

export type DiscordIndexedAttachmentMeta = Omit<DiscordAttachmentMeta, "url">;

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
