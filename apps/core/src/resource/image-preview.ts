import { materializeBlobRead, type BlobStore } from "@stanley2058/lilac-blob-storage";
import { Panic, Result, type Result as ResultType } from "better-result";

import { adaptToolResultToHost } from "../tools/tool-result-adapters";
import { captureError } from "../shared/error-capture";
import {
  RESOURCE_IMAGE_INLINE_MAX_BYTES,
  type ResourceImagePreview,
  type ResourceRecordV1,
} from "./contracts";
import { ResourceCacheUnavailable, ResourceTooLarge, type ResourceAccessError } from "./errors";
import {
  cancelVerifiedResourceRead,
  consumeVerifiedResourceRead,
  type VerifiedResourceRead,
} from "./service";
import type { ResourceStore } from "./store";

const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PIXELS = 40_000_000;
const IMAGE_OPTIONS = { autoOrient: true, maxPixels: MAX_PIXELS };

type PreviewContent = { readonly bytes: Uint8Array; readonly preview: ResourceImagePreview };
type FittedImage = Omit<ResourceImagePreview, "blob" | "sourceSha256" | "policyVersion"> & {
  readonly bytes: Uint8Array;
};

async function fitImage(bytes: Uint8Array): Promise<FittedImage | null> {
  const original = await new Bun.Image(bytes, IMAGE_OPTIONS).metadata();
  for (const edge of [3072, 2560, 2048, 1600, 1280, 1024, 768, 512]) {
    const pipeline = new Bun.Image(bytes, IMAGE_OPTIONS).resize(edge, edge, {
      fit: "inside",
      withoutEnlargement: true,
    });
    // Prefer lossless output for screenshots and transparent artwork before JPEG.
    const png = await pipeline.png().bytes();
    if (png.byteLength <= RESOURCE_IMAGE_INLINE_MAX_BYTES) {
      return fittedImage(png, "image/png", original);
    }
    for (const quality of [88, 72]) {
      const jpeg = await new Bun.Image(bytes, IMAGE_OPTIONS)
        .resize(edge, edge, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality })
        .bytes();
      if (jpeg.byteLength > RESOURCE_IMAGE_INLINE_MAX_BYTES) continue;
      return fittedImage(jpeg, "image/jpeg", original);
    }
  }
  return null;
}

async function fittedImage(
  bytes: Uint8Array,
  mediaType: FittedImage["mediaType"],
  original: Bun.Image.Metadata,
): Promise<FittedImage> {
  const size = await new Bun.Image(bytes).metadata();
  return {
    bytes,
    mediaType,
    originalWidth: original.width,
    originalHeight: original.height,
    width: size.width,
    height: size.height,
  };
}

async function reusePreview(
  read: VerifiedResourceRead,
  content:
    | ResultType<PreviewContent, ResourceAccessError>
    | Promise<ResultType<PreviewContent, ResourceAccessError>>,
): Promise<ResultType<VerifiedResourceRead, ResourceAccessError>> {
  await cancelVerifiedResourceRead(read);
  return (await content).map((value) => previewRead(read, value));
}

export class ResourceImagePreviews {
  readonly #pending = new Map<string, Promise<ResultType<PreviewContent, ResourceAccessError>>>();

  constructor(
    private readonly dependencies: {
      readonly store: ResourceStore;
      readonly blobStore: BlobStore;
      readonly now: () => number;
    },
  ) {}

  async open(
    read: VerifiedResourceRead,
    record: ResourceRecordV1,
  ): Promise<ResultType<VerifiedResourceRead, ResourceAccessError>> {
    const cached = await this.#readCached(read, record.imagePreview);
    if (cached) return reusePreview(read, Result.ok(cached));
    const key = `${record.resourceId}:${read.blob.sha256}`;
    const existing = this.#pending.get(key);
    if (existing) return reusePreview(read, existing);
    const pending = this.#create(read, record).finally(() => this.#pending.delete(key));
    this.#pending.set(key, pending);
    return (await pending).map((content) => previewRead(read, content));
  }

  async #readCached(
    read: VerifiedResourceRead,
    preview: ResourceImagePreview | undefined,
  ): Promise<PreviewContent | null> {
    if (
      !preview ||
      preview.policyVersion !== 1 ||
      preview.sourceSha256 !== read.blob.sha256 ||
      preview.blob.byteLength > RESOURCE_IMAGE_INLINE_MAX_BYTES ||
      preview.blob.expiresAt <= this.dependencies.now()
    )
      return null;
    const opened = await this.dependencies.blobStore.open(preview.blob);
    const cachedRead = opened.match({ ok: (value) => value, err: () => null });
    if (!cachedRead) return null;
    const consumed = await materializeBlobRead(cachedRead);
    return consumed.match({ ok: (bytes) => ({ bytes, preview }), err: () => null });
  }

  async #create(
    read: VerifiedResourceRead,
    record: ResourceRecordV1,
  ): Promise<ResultType<PreviewContent, ResourceAccessError>> {
    const uri = read.descriptor.uri;
    const unavailable = () =>
      new ResourceCacheUnavailable({
        uri,
        retryable: true,
        message: "Image preview cache is unavailable",
      });
    const consumed = await consumeVerifiedResourceRead(read);
    const decision = consumed.match<
      { kind: "source"; bytes: Uint8Array } | { kind: "error"; error: ResourceAccessError }
    >({ ok: (bytes) => ({ kind: "source", bytes }), err: (error) => ({ kind: "error", error }) });
    if (decision.kind === "error") return Result.err(decision.error);
    const source = decision.bytes;
    const rendered = await Result.tryPromise({ try: () => fitImage(source), catch: captureError });
    if (rendered.isErr()) {
      if (Panic.is(rendered.error.cause))
        return adaptToolResultToHost(Result.err(rendered.error.cause));
      return Result.err(
        new ResourceTooLarge({
          uri,
          limit: RESOURCE_IMAGE_INLINE_MAX_BYTES,
          limitKind: "operation",
          message: "Image could not be converted to a preview",
        }),
      );
    }
    const image = rendered.value;
    if (!image)
      return Result.err(
        new ResourceTooLarge({
          uri,
          limit: RESOURCE_IMAGE_INLINE_MAX_BYTES,
          limitKind: "operation",
          message: "Image preview exceeds the inline limit",
        }),
      );
    const expiresAt = this.dependencies.now() + PREVIEW_TTL_MS;
    return Result.gen(
      async function* (this: ResourceImagePreviews) {
        const upload = yield* Result.await(
          this.dependencies.blobStore
            .startUpload({ source: image.bytes, retention: { kind: "expires", expiresAt } })
            .then((result) => result.mapError(unavailable)),
        );
        const blob = yield* Result.await(
          upload.completion.then((result) => result.mapError(unavailable)),
        );
        const { bytes, ...dimensions } = image;
        const preview: ResourceImagePreview = {
          ...dimensions,
          policyVersion: 1,
          sourceSha256: read.blob.sha256,
          blob: { ...blob, expiresAt },
        };
        const current = yield* this.dependencies.store
          .getRetained(record.resourceId)
          .mapError(unavailable);
        if (!current?.cache || current.cache.blob.sha256 !== read.blob.sha256) {
          return Result.err(unavailable());
        }
        const attached = yield* this.dependencies.store
          .setImagePreview({ resourceId: record.resourceId, source: current.cache, preview })
          .mapError(unavailable);
        if (!attached) return Result.err(unavailable());
        return Result.ok({ bytes, preview });
      }.bind(this),
    );
  }
}

function previewRead(source: VerifiedResourceRead, content: PreviewContent): VerifiedResourceRead {
  return {
    descriptor: source.descriptor,
    classification: { kind: "image", mediaType: content.preview.mediaType },
    blob: content.preview.blob,
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(content.bytes);
        controller.close();
      },
    }),
    completion: Promise.resolve(
      Result.ok({ sha256: content.preview.blob.sha256, byteLength: content.bytes.byteLength }),
    ),
    imagePreview: content.preview,
  };
}
