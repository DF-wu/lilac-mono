import { createDownload } from "ai";
import { opaqueErrorMessage } from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError } from "better-result";

import { captureError } from "../../shared/error-capture";
import type { ReadRemoteMedia } from "./fs";

class RemoteMediaDownloadFailed extends TaggedError("RemoteMediaDownloadFailed")<{
  readonly cause?: unknown;
  readonly message: string;
}> {}

export const readRemoteMedia: ReadRemoteMedia = async ({ url, abortSignal, maxBytes }) => {
  const captured = (
    await Result.tryPromise({
      try: () => createDownload({ maxBytes })({ url, abortSignal }),
      catch: captureError,
    })
  ).match<
    | { readonly kind: "success"; readonly data: Uint8Array }
    | { readonly kind: "failure"; readonly cause: Error }
  >({
    ok: ({ data }) => ({ kind: "success", data }),
    err: ({ cause }) => ({ kind: "failure", cause }),
  });
  if (captured.kind === "success") return Result.ok({ data: captured.data });
  if (Panic.is(captured.cause)) throw captured.cause;
  return Result.err(
    new RemoteMediaDownloadFailed({
      cause: captured.cause,
      message: opaqueErrorMessage(captured.cause, "Remote media download failed"),
    }),
  );
};
