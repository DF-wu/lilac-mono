import {
  materializeBlobRead,
  type BlobHandleV1,
  type BlobReadError,
  type BlobReadTerminalError,
  type BlobRefV1,
  type BlobResolveError,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import type { SurfaceAttachment } from "../types";

export const SURFACE_OUTPUT_BLOB_RESOLVE_TIMEOUT_MS = 60_000;

type SurfaceOutputBlobMaterializationCause =
  | BlobResolveError
  | BlobReadError
  | BlobReadTerminalError;

export class SurfaceOutputBlobMaterializationFailed extends TaggedError(
  "SurfaceOutputBlobMaterializationFailed",
)<{
  readonly stage: "resolve" | "open" | "read";
  readonly cause: SurfaceOutputBlobMaterializationCause;
  readonly message: string;
}> {}

export type MaterializedSurfaceOutputAttachment = {
  readonly blob: BlobRefV1;
  readonly attachment: SurfaceAttachment;
};

function materializationFailure(
  stage: SurfaceOutputBlobMaterializationFailed["stage"],
  cause: SurfaceOutputBlobMaterializationCause,
): SurfaceOutputBlobMaterializationFailed {
  return new SurfaceOutputBlobMaterializationFailed({
    stage,
    cause,
    message: `Failed to ${stage} generated surface output blob`,
  });
}

export async function materializeSurfaceOutputAttachment(input: {
  readonly blobStore: Pick<BlobStore, "resolve" | "open">;
  readonly blob: BlobHandleV1;
  readonly mimeType: string;
  readonly filename?: string;
}): Promise<
  ResultType<MaterializedSurfaceOutputAttachment, SurfaceOutputBlobMaterializationFailed>
> {
  return Result.gen(async function* () {
    const blob = yield* Result.await(
      input.blobStore
        .resolve(input.blob, { timeoutMs: SURFACE_OUTPUT_BLOB_RESOLVE_TIMEOUT_MS })
        .then((resolved) => resolved.mapError((cause) => materializationFailure("resolve", cause))),
    );
    const read = yield* Result.await(
      input.blobStore
        .open(blob)
        .then((opened) => opened.mapError((cause) => materializationFailure("open", cause))),
    );
    const bytes = yield* Result.await(
      materializeBlobRead(read).then((materialized) =>
        materialized.mapError((cause) => materializationFailure("read", cause)),
      ),
    );
    const kind: SurfaceAttachment["kind"] = input.mimeType.startsWith("image/") ? "image" : "file";

    return Result.ok({
      blob,
      attachment: {
        kind,
        mimeType: input.mimeType,
        filename: input.filename ?? (kind === "image" ? "image" : "file"),
        bytes,
      },
    });
  });
}
