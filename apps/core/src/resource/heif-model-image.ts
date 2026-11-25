import { Panic, Result } from "better-result";

import { captureError } from "../shared/error-capture";
import { adaptToolResultToHost } from "../tools/tool-result-adapters";
import { RESOURCE_IMAGE_INLINE_MAX_BYTES, RESOURCE_MODEL_INLINE_MAX_BYTES } from "./contracts";

export function isHeifMediaType(mediaType: string | undefined): boolean {
  return /^image\/hei[cf](?:-sequence)?$/u.test(mediaType ?? "");
}

export function hasHeifFilename(filename: string): boolean {
  return /\.(?:heic|heif|heics|heifs)$/iu.test(filename);
}

export async function convertHeifForModel(data: Uint8Array, filename?: string) {
  if (data.byteLength > RESOURCE_MODEL_INLINE_MAX_BYTES) return null;
  const converted = await Result.tryPromise({
    try: async () => {
      const child = Bun.spawn(
        [
          "magick",
          "-limit",
          "thread",
          "1",
          "-limit",
          "memory",
          "256MiB",
          "-limit",
          "map",
          "0",
          "-limit",
          "disk",
          "0",
          "-limit",
          "width",
          "8192",
          "-limit",
          "height",
          "8192",
          "heic:-[0]",
          "-auto-orient",
          "-resize",
          "1600x1600>",
          "-strip",
          "-quality",
          "85",
          "-define",
          "jpeg:extent=1024KB",
          "jpeg:-",
        ],
        {
          stdin: data,
          stdout: "pipe",
          stderr: "ignore",
          timeout: 10_000,
          killSignal: "SIGKILL",
          maxBuffer: RESOURCE_IMAGE_INLINE_MAX_BYTES,
        },
      );
      const [output, code] = await Promise.all([
        new Response(child.stdout).arrayBuffer(),
        child.exited,
      ]);
      return code === 0 ? new Uint8Array(output) : null;
    },
    catch: captureError,
  });
  if (converted.isErr()) {
    if (Panic.is(converted.error.cause))
      return adaptToolResultToHost(Result.err(converted.error.cause));
    return null;
  }
  const jpeg = converted.match({ ok: (bytes) => bytes, err: () => null });
  if (
    !jpeg ||
    jpeg[0] !== 0xff ||
    jpeg[1] !== 0xd8 ||
    jpeg.byteLength > RESOURCE_IMAGE_INLINE_MAX_BYTES
  )
    return null;
  return {
    data: jpeg,
    mediaType: "image/jpeg",
    ...(filename ? { filename: filename.replace(/\.[^.]+$/u, "") + ".jpg" } : {}),
  };
}
