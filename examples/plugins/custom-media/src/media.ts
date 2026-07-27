import fs from "node:fs/promises";
import path from "node:path";
import type { RequestContext } from "@stanley2058/lilac-plugin-runtime";
import { CustomMediaError } from "./errors";
import { assertSafeInputFile, formatToolPath } from "./paths";

export const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;

export type ValidatedImage = {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  extension: ".png" | ".jpg" | ".gif" | ".webp";
  filename: string;
};

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

export function detectImageType(
  bytes: Uint8Array,
): Pick<ValidatedImage, "mimeType" | "extension"> | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: "image/png", extension: ".png" };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { mimeType: "image/jpeg", extension: ".jpg" };
  }
  const ascii = Buffer.from(bytes.subarray(0, 12)).toString("ascii");
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) {
    return { mimeType: "image/gif", extension: ".gif" };
  }
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
    return { mimeType: "image/webp", extension: ".webp" };
  }
  return null;
}

export async function readValidatedImage(params: {
  filePath: string;
  context?: RequestContext;
  maxBytes?: number;
}): Promise<ValidatedImage> {
  const safe = await assertSafeInputFile(params.filePath, params.context);
  const maxBytes = params.maxBytes ?? MAX_INPUT_IMAGE_BYTES;
  if (safe.size > maxBytes) {
    throw new CustomMediaError(
      "MEDIA_TOO_LARGE",
      `Input image '${formatToolPath(params.filePath, params.context)}' exceeds ${maxBytes} bytes.`,
    );
  }

  const bytes = await fs.readFile(safe.realPath);
  const type = detectImageType(bytes);
  if (!type) {
    throw new CustomMediaError(
      "INVALID_MEDIA",
      `Input file '${formatToolPath(params.filePath, params.context)}' is not a supported PNG, JPEG, GIF, or WebP image.`,
    );
  }
  return {
    bytes,
    ...type,
    filename: `${path.basename(safe.realPath, path.extname(safe.realPath))}${type.extension}`,
  };
}

export function imageExtensionForMime(mimeType: string, bytes: Uint8Array): string {
  const detected = detectImageType(bytes);
  if (detected) return detected.extension;
  switch (mimeType.toLowerCase().split(";")[0]?.trim()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      throw new CustomMediaError(
        "INVALID_MEDIA",
        "Provider returned data that is not a supported image.",
      );
  }
}

export function videoExtensionForMime(mimeType: string): string {
  switch (mimeType.toLowerCase().split(";")[0]?.trim()) {
    case "video/mp4":
      return ".mp4";
    case "video/webm":
      return ".webm";
    case "video/quicktime":
      return ".mov";
    case "application/octet-stream":
      return ".mp4";
    default:
      throw new CustomMediaError(
        "INVALID_MEDIA",
        `Provider returned unsupported video content type '${mimeType.slice(0, 100)}'.`,
      );
  }
}
