import { Buffer } from "node:buffer";

import type { UserContent } from "ai";
import { z } from "zod";

import type { Message, PhotoSize } from "grammy/types";

import { inferMimeTypeFromFilename } from "../../shared/attachment-utils";
import {
  decodeUtf8BestEffort,
  escapeMetadataValue,
  isTextExtractableMimeType,
} from "../bridge/request-composition/attachments";
import type { SurfaceAttachmentResolver } from "../adapter";

export type TelegramInboundMediaKind = "photo" | "document" | "video" | "audio" | "voice";

/**
 * Inbound media reference extracted from a Telegram message.
 *
 * Carries the permanent `file_id` rather than any URL: Telegram download URLs
 * embed the bot token and expire after about an hour, while `file_id` is stable
 * and survives in the surface store's `raw_json`, so historical re-composition
 * can re-resolve the same media after a restart.
 */
export type TelegramInboundMediaRef = {
  readonly kind: TelegramInboundMediaKind;
  readonly fileId: string;
  readonly filename?: string;
  /** Client-declared MIME type; advisory only. */
  readonly mimeType?: string;
  /** Telegram-declared size; advisory only — the download enforces the limit. */
  readonly size?: number;
};

export type TelegramInboundMediaConfig = {
  readonly enabled: boolean;
  readonly maxBytesPerAttachment: number;
  readonly maxBytesPerRequest: number;
};

/**
 * One decoded-byte budget spans every attachment in a composed request, so a
 * long reply chain cannot multiply the per-message allowance.
 */
export type TelegramInboundMediaBudget = {
  readonly perAttachmentBytes: number;
  remainingRequestBytes: number;
};

export function createTelegramInboundMediaBudget(
  config: Pick<TelegramInboundMediaConfig, "maxBytesPerAttachment" | "maxBytesPerRequest">,
): TelegramInboundMediaBudget {
  return {
    perAttachmentBytes: config.maxBytesPerAttachment,
    remainingRequestBytes: config.maxBytesPerRequest,
  };
}

function largestPhotoSize(sizes: readonly PhotoSize[]): PhotoSize | undefined {
  let best: PhotoSize | undefined;
  let bestPixels = -1;
  for (const size of sizes) {
    const pixels = size.width * size.height;
    if (pixels > bestPixels) {
      best = size;
      bestPixels = pixels;
    }
  }
  return best;
}

/** Media the model can be told about, extracted from a typed grammY message. */
export function telegramInboundMedia(message: Message): TelegramInboundMediaRef[] {
  const refs: TelegramInboundMediaRef[] = [];

  const photo = message.photo ? largestPhotoSize(message.photo) : undefined;
  if (photo) {
    refs.push({
      kind: "photo",
      fileId: photo.file_id,
      // Telegram photos are always re-encoded to JPEG server-side.
      mimeType: "image/jpeg",
      ...(photo.file_size === undefined ? {} : { size: photo.file_size }),
    });
  }

  const document = message.document;
  if (document) {
    refs.push({
      kind: "document",
      fileId: document.file_id,
      ...(document.file_name === undefined ? {} : { filename: document.file_name }),
      ...(document.mime_type === undefined ? {} : { mimeType: document.mime_type }),
      ...(document.file_size === undefined ? {} : { size: document.file_size }),
    });
  }

  const video = message.video;
  if (video) {
    refs.push({
      kind: "video",
      fileId: video.file_id,
      ...(video.file_name === undefined ? {} : { filename: video.file_name }),
      ...(video.mime_type === undefined ? {} : { mimeType: video.mime_type }),
      ...(video.file_size === undefined ? {} : { size: video.file_size }),
    });
  }

  const audio = message.audio;
  if (audio) {
    refs.push({
      kind: "audio",
      fileId: audio.file_id,
      ...(audio.file_name === undefined ? {} : { filename: audio.file_name }),
      ...(audio.mime_type === undefined ? {} : { mimeType: audio.mime_type }),
      ...(audio.file_size === undefined ? {} : { size: audio.file_size }),
    });
  }

  const voice = message.voice;
  if (voice) {
    refs.push({
      kind: "voice",
      fileId: voice.file_id,
      ...(voice.mime_type === undefined ? {} : { mimeType: voice.mime_type }),
      ...(voice.file_size === undefined ? {} : { size: voice.file_size }),
    });
  }

  return refs;
}

const storedFileSchema = z.object({
  file_id: z.string().min(1),
  file_name: z.string().min(1).optional(),
  mime_type: z.string().min(1).optional(),
  file_size: z.number().int().nonnegative().optional(),
});

const storedPhotoSizeSchema = z.object({
  file_id: z.string().min(1),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  file_size: z.number().int().nonnegative().optional(),
});

const storedMediaEnvelopeSchema = z.object({
  telegram: z.object({
    message: z
      .object({
        photo: z.array(storedPhotoSizeSchema).optional(),
        document: storedFileSchema.optional(),
        video: storedFileSchema.optional(),
        audio: storedFileSchema.optional(),
        voice: storedFileSchema.optional(),
      })
      .passthrough(),
  }),
});

/**
 * Media extraction for messages read back from the surface store, where the
 * envelope is `unknown`. Parses only the fields media resolution needs; a raw
 * value that is not a Telegram envelope yields no media rather than an error.
 *
 * Takes the whole message-shaped input (like `telegramFlags`) so the unknown
 * `raw` member is only ever read inside this registered decoder.
 */
export function telegramInboundMediaFromRaw(input: {
  readonly raw?: unknown;
}): TelegramInboundMediaRef[] {
  const parsed = storedMediaEnvelopeSchema.safeParse(input.raw);
  if (!parsed.success) return [];
  const message = parsed.data.telegram.message;

  const refs: TelegramInboundMediaRef[] = [];

  const photo = message.photo
    ? [...message.photo].sort((a, b) => b.width * b.height - a.width * a.height)[0]
    : undefined;
  if (photo) {
    refs.push({
      kind: "photo",
      fileId: photo.file_id,
      mimeType: "image/jpeg",
      ...(photo.file_size === undefined ? {} : { size: photo.file_size }),
    });
  }

  const pushFile = (kind: Exclude<TelegramInboundMediaKind, "photo">) => {
    const file = message[kind];
    if (!file) return;
    refs.push({
      kind,
      fileId: file.file_id,
      ...(file.file_name === undefined ? {} : { filename: file.file_name }),
      ...(file.mime_type === undefined ? {} : { mimeType: file.mime_type }),
      ...(file.file_size === undefined ? {} : { size: file.file_size }),
    });
  };
  pushFile("document");
  pushFile("video");
  pushFile("audio");
  pushFile("voice");

  return refs;
}

/**
 * One-line metadata marker for media that is not delivered as bytes.
 *
 * Deliberately a different marker from Discord's `[discord_attachment …]`:
 * that marker carries a fetchable URL and existing behavior depends on its
 * exact shape, while this one never carries a URL — there is no way to fetch
 * Telegram media without the bot token.
 */
export function formatTelegramAttachmentMarker(ref: TelegramInboundMediaRef): string {
  const fields: string[] = [`kind="${escapeMetadataValue(ref.kind)}"`];
  if (ref.filename) fields.push(`filename="${escapeMetadataValue(ref.filename)}"`);
  if (ref.mimeType) fields.push(`mime="${escapeMetadataValue(ref.mimeType)}"`);
  if (typeof ref.size === "number") fields.push(`size=${ref.size}`);
  return `[telegram_attachment ${fields.join(" ")}]`;
}

type TelegramMediaPart = Exclude<UserContent, string>[number];

function markerPart(ref: TelegramInboundMediaRef, reason: string): TelegramMediaPart {
  return { type: "text", text: `${formatTelegramAttachmentMarker(ref)}\n(${reason})` };
}

function declaredOrInferredMimeType(ref: TelegramInboundMediaRef): string | undefined {
  if (ref.mimeType) return ref.mimeType.split(";")[0]?.trim().toLowerCase() || undefined;
  if (ref.filename) {
    const inferred = inferMimeTypeFromFilename(ref.filename);
    if (inferred !== "application/octet-stream") return inferred;
  }
  return undefined;
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function isPdfMimeType(mimeType: string): boolean {
  return mimeType === "application/pdf";
}

/**
 * Per-modality delivery policy applied after resolution:
 * sniffed images and PDFs become file parts, text-extractable documents are
 * inlined, and everything else (video, audio, voice, unsupported binaries)
 * degrades to a metadata marker. Declared MIME and filenames are fallbacks
 * only, never a reason to skip the download. Transcription is a stated
 * non-goal of the surface.
 */
export async function appendTelegramMediaToUserContent(input: {
  readonly parts: Exclude<UserContent, string>;
  readonly media: readonly TelegramInboundMediaRef[];
  readonly resolver: SurfaceAttachmentResolver;
  readonly budget: TelegramInboundMediaBudget;
  readonly signal?: AbortSignal;
}): Promise<void> {
  for (const ref of input.media) {
    if (ref.kind === "video" || ref.kind === "audio" || ref.kind === "voice") {
      input.parts.push(markerPart(ref, "unsupported media type; not delivered"));
      continue;
    }

    if (input.budget.remainingRequestBytes <= 0) {
      input.parts.push(markerPart(ref, "inbound media budget exhausted; not delivered"));
      continue;
    }

    const maxBytes = Math.min(input.budget.perAttachmentBytes, input.budget.remainingRequestBytes);
    const resolved = await input.resolver.resolveAttachment(
      {
        platform: "telegram",
        fileId: ref.fileId,
        ...(ref.filename === undefined ? {} : { filename: ref.filename }),
        ...(ref.mimeType === undefined ? {} : { mimeType: ref.mimeType }),
        ...(ref.size === undefined ? {} : { size: ref.size }),
      },
      { maxBytes, ...(input.signal === undefined ? {} : { signal: input.signal }) },
    );

    const part = resolved.match<TelegramMediaPart | null>({
      err: (error) =>
        error._tag === "SurfaceAttachmentTooLarge"
          ? markerPart(ref, "media exceeds the inbound media limit; not delivered")
          : markerPart(ref, "media unavailable; not delivered"),
      ok: (attachment) => {
        const sniffed = attachment.mediaType;
        const declaredMime = declaredOrInferredMimeType(ref);
        const filePartType =
          isImageMimeType(sniffed) || isPdfMimeType(sniffed) ? sniffed : undefined;
        const textType = isTextExtractableMimeType(sniffed)
          ? sniffed
          : sniffed === "application/octet-stream" &&
              declaredMime &&
              isTextExtractableMimeType(declaredMime)
            ? declaredMime
            : undefined;
        if (!filePartType && !textType) {
          return markerPart(ref, "unsupported media type; not delivered");
        }

        input.budget.remainingRequestBytes -= attachment.bytes.byteLength;

        if (filePartType) {
          return {
            type: "file",
            // Base64 rather than a typed array: it survives every JSON
            // serialization boundary (bus, cache, transcript) with a
            // predictable 4/3 expansion instead of SuperJSON's ~4x numeric
            // encoding, and providers accept it as DataContent unchanged.
            data: Buffer.from(attachment.bytes).toString("base64"),
            mediaType: filePartType,
            ...(ref.filename === undefined ? {} : { filename: ref.filename }),
          };
        }

        if (textType) {
          const decoded = decodeUtf8BestEffort(attachment.bytes);
          if (!decoded.text) {
            return markerPart(
              ref,
              `text extraction failed: ${decoded.reason ?? "unknown"}; not delivered`,
            );
          }
          const suffix = decoded.truncatedBytes ? "\n\n(truncated)" : "";
          return {
            type: "text",
            text: `${formatTelegramAttachmentMarker(ref)}\n${decoded.text}${suffix}`,
          };
        }

        return markerPart(ref, "unsupported media type; not delivered");
      },
    });

    if (part) input.parts.push(part);
  }
}
