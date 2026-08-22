import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type {
  BlobReadComplete,
  BlobReadTerminalError,
  BlobRefV1,
  BlobStore,
} from "@stanley2058/lilac-blob-storage";
import { Result, type Result as ResultType } from "better-result";

import {
  materializeSurfaceOutputAttachment,
  SURFACE_OUTPUT_BLOB_RESOLVE_TIMEOUT_MS,
} from "../../../src/surface/bridge/generated-output-materialization";

describe("generated surface output materialization", () => {
  it("does not expose bytes until terminal blob verification succeeds", async () => {
    const bytes = new TextEncoder().encode("verified");
    const ref: BlobRefV1 = {
      version: 1,
      objectId: `b1_${"a".repeat(32)}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
    };
    const streamConsumed = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<ResultType<BlobReadComplete, BlobReadTerminalError>>();
    let observedTimeoutMs: number | undefined;
    const blobStore = {
      resolve: async (_handle, options) => {
        observedTimeoutMs = options.timeoutMs;
        return Result.ok(ref);
      },
      open: async () =>
        Result.ok({
          ref,
          stream: new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(bytes);
              controller.close();
              streamConsumed.resolve();
            },
          }),
          completion: completion.promise,
        }),
    } satisfies Pick<BlobStore, "resolve" | "open">;
    let settled = false;
    const materialized = materializeSurfaceOutputAttachment({
      blobStore,
      blob: { version: 1, objectId: ref.objectId },
      mimeType: "text/plain",
      filename: "verified.txt",
    }).finally(() => {
      settled = true;
    });

    await streamConsumed.promise;
    expect(settled).toBe(false);
    expect(observedTimeoutMs).toBe(SURFACE_OUTPUT_BLOB_RESOLVE_TIMEOUT_MS);

    completion.resolve(Result.ok({ sha256: ref.sha256, byteLength: ref.byteLength }));
    const outcome = await materialized;
    const attachment = outcome.match({
      ok: (value) => value.attachment,
      err: (error) => {
        throw error;
      },
    });
    expect(attachment.filename).toBe("verified.txt");
    expect(new TextDecoder().decode(attachment.bytes)).toBe("verified");
  });
});
