import type { ModelCapabilityInfo } from "@stanley2058/lilac-utils";
import { boundToolResultMediaForModelView } from "@stanley2058/lilac-tool-results/tool-result-media";
import type { ModelMessage } from "ai";

export const READ_FILE_MEDIA_MAX_BYTES_PER_PART = 10 * 1024 * 1024;
export const READ_FILE_MEDIA_MAX_BYTES_TOTAL = 20 * 1024 * 1024;

export function supportsReadFileMedia(info: ModelCapabilityInfo | null | undefined): boolean {
  if (info?.attachment !== true) return false;
  const input = info.modalities?.input;
  return input?.includes("image") === true && input.includes("pdf");
}

export function scrubReadFileMediaForModelView(
  messages: readonly ModelMessage[],
  limits: { maxBytesPerPart: number; maxBytesTotal: number } = {
    maxBytesPerPart: READ_FILE_MEDIA_MAX_BYTES_PER_PART,
    maxBytesTotal: READ_FILE_MEDIA_MAX_BYTES_TOTAL,
  },
): ModelMessage[] {
  return boundToolResultMediaForModelView(messages, limits);
}
