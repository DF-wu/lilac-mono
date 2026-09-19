import { Result } from "better-result";
import type { ResourcePreview } from "@stanley2058/lilac-client-protocol";
import { nativeFailure, type NativeStoreFailure } from "./errors";

export const NATIVE_TEXT_PREVIEW_BYTES = 65_536;

export function textPreview(
  bytes: Uint8Array,
  byteLength: number,
): Result<ResourcePreview, NativeStoreFailure> {
  const prefix = bytes.subarray(0, NATIVE_TEXT_PREVIEW_BYTES);
  if (
    prefix.some(
      (value) => value === 0 || (value < 32 && value !== 9 && value !== 10 && value !== 13),
    )
  )
    return Result.err(nativeFailure("invalid", "Text preview is unavailable for this binary file"));
  const truncated = byteLength > prefix.byteLength;
  return Result.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(prefix, { stream: truncated }),
    catch: () => nativeFailure("invalid", "Text preview is unavailable for this binary file"),
  }).map((text) => ({ text, truncated, byteLength }));
}

export async function readPreviewPrefix(
  stream: ReadableStream<Uint8Array>,
): Promise<Result<Uint8Array, NativeStoreFailure>> {
  const reader = stream.getReader();
  const read = await Result.tryPromise({
    try: async () => {
      const bytes = new Uint8Array(NATIVE_TEXT_PREVIEW_BYTES);
      let length = 0;
      while (length < bytes.byteLength) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const prefix = chunk.value.subarray(0, bytes.byteLength - length);
        bytes.set(prefix, length);
        length += prefix.byteLength;
      }
      return bytes.subarray(0, length);
    },
    catch: () => nativeFailure("not-found", "File bytes are unavailable"),
  });
  const canceled = await Result.tryPromise({
    try: () => reader.cancel(),
    catch: () => nativeFailure("not-found", "File bytes are unavailable"),
  });
  reader.releaseLock();
  return Result.all([read, canceled]).map(([bytes]) => bytes);
}
