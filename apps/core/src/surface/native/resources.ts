import type { NativeClerkAuthenticator } from "./auth-clerk";
import type { NativeAuthError } from "./auth";
import { agentIdentity, nativeUserDisplay } from "./identity";
import { readPreviewPrefix, textPreview } from "./resource-preview";
import { classifyResourcePrefix } from "../../resource/resource-mime";
import type { PersistedDataError } from "@stanley2058/lilac-utils";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import {
  createResourceId,
  formatResourceUri,
  parseResourceUri,
  RESOURCE_MAX_BYTES,
  RESOURCE_MODEL_INLINE_MAX_BYTES,
  type ResourceId,
  type ResourceRecordV1,
} from "../../resource/contracts";
import { ResourceNotFound, type ResourceStoreFailure } from "../../resource/errors";
import {
  consumeVerifiedResourceRead,
  type ResourceAccess,
  type ResourceMaterializeOptions,
  type ResourceOpenOptions,
  type VerifiedResourceRead,
} from "../../resource/service";
import type { ResourceStore } from "../../resource/store";
import type { NativeThreadRecord, NativeUploadRecord, NativeUser } from "./codec";
import { nativeFailure, type NativeStoreFailure, type NativeStoreFailureCode } from "./errors";

type NativeResourceStateError = NativeStoreFailure | PersistedDataError;
export class NativeUploadSettlementFailed extends TaggedError("NativeUploadSettlementFailed")<{
  readonly uploadFailure: NativeResourceStateError;
  readonly settlementFailure: NativeResourceStateError;
  readonly message: string;
}> {}
export type NativeResourceError =
  | NativeResourceStateError
  | NativeUploadSettlementFailed
  | NativeAuthError;
type NativeResult<T> = ResultType<T, NativeResourceError>;
type NativeStateResult<T> = ResultType<T, NativeResourceStateError>;

export interface NativeUploadStore {
  setUserProfile?(
    actorId: string,
    input: { avatar?: NativeUser["avatar"] | null; providerAvatarUrl?: string | null },
  ): NativeStateResult<NativeUser>;
  setAgentIdentity?(
    actorId: string,
    input: { displayName?: string; avatar?: NativeUser["avatar"] | null },
  ): NativeStateResult<NativeUser>;
  getUser(actorId: string): NativeStateResult<NativeUser>;
  getThreadRecord(threadId: string): NativeStateResult<NativeThreadRecord>;
  authorizeThread(
    actorId: string,
    threadId: string,
    edit?: boolean,
  ): NativeStateResult<NativeThreadRecord>;
  reserveUpload(
    actorId: string,
    input: {
      threadId: string;
      filename: string;
      mediaType: string;
      size: number;
      commandId?: string;
    },
  ): NativeStateResult<NativeUploadRecord>;
  getUpload(uploadId: string): NativeStateResult<NativeUploadRecord>;
  readUpload(actorId: string, uploadId: string): NativeStateResult<NativeUploadRecord>;
  claimUpload(actorId: string, uploadId: string): NativeStateResult<NativeUploadRecord>;
  settleUpload(
    uploadId: string,
    input: {
      attempt: number;
      historyGeneration: number;
      state: "ready" | "failed";
      resourceUri?: string;
    },
  ): NativeStateResult<NativeUploadRecord>;
}

export interface NativeResourceReferences {
  retainNativeResource(input: {
    uploadId: string;
    threadId: string;
    resourceId: ResourceId;
  }): ResultType<void, ResourceStoreFailure>;
  releaseNativeResource(uploadId: string): ResultType<void, ResourceStoreFailure>;
  listNativeResourceReferences(): ResultType<
    readonly { uploadId: string; threadId: string; resourceId: ResourceId }[],
    ResourceStoreFailure
  >;
}

export type NativeResourceProgress = {
  uploadId: string;
  threadId: string;
  transferred: number;
  size: number;
};
export type NativeModelAttachment =
  | { type: "resource"; uri: string; filename: string; mediaType: string }
  | { type: "image"; image: Uint8Array; mediaType: string }
  | { type: "file"; data: Uint8Array; mediaType: string; filename: string };

export class NativeResourceService {
  readonly #active = new Map<
    string,
    { controller: AbortController; completion: Promise<NativeResult<NativeUploadRecord>> }
  >();
  #stopped = false;
  readonly #now: () => number;
  constructor(
    readonly dependencies: {
      native: NativeUploadStore;
      profileProvider?: Pick<NativeClerkAuthenticator, "updateAvatar">;
      resources: ResourceStore & NativeResourceReferences;
      access: ResourceAccess;
      blobs: BlobStore;
      now?: () => number;
      onProgress?: (progress: NativeResourceProgress) => void;
    },
  ) {
    this.#now = dependencies.now ?? Date.now;
  }

  reserve(
    actorId: string,
    input: {
      threadId: string;
      filename: string;
      mediaType: string;
      size: number;
      commandId?: string;
    },
  ): NativeResult<NativeUploadRecord> {
    if (this.#stopped) return Result.err(nativeFailure("stale", "Uploads are shutting down"));
    if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > RESOURCE_MAX_BYTES)
      return Result.err(nativeFailure("invalid", "File exceeds the upload size limit"));
    if (
      !input.filename.trim() ||
      input.filename.length > 1024 ||
      /[\r\n\u0000]/u.test(input.filename)
    )
      return Result.err(nativeFailure("invalid", "Invalid filename"));
    if (input.mediaType.length > 256)
      return Result.err(nativeFailure("invalid", "Invalid media type"));
    return this.dependencies.native.reserveUpload(actorId, {
      ...input,
      mediaType:
        input.mediaType.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream",
    });
  }

  async ingest(
    actorId: string,
    threadId: string,
    input: { filename: string; mediaType: string; bytes: Uint8Array },
  ): Promise<NativeResult<NativeUploadRecord>> {
    const reservation = this.reserve(actorId, {
      threadId,
      filename: input.filename,
      mediaType: input.mediaType,
      size: input.bytes.byteLength,
    });
    const upload = reservation.match({ ok: (value) => value, err: () => null });
    if (!upload) return reservation;
    const bytes = input.bytes;
    return this.upload(
      actorId,
      upload.id,
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    );
  }

  get(actorId: string, uploadId: string): NativeResult<NativeUploadRecord> {
    return this.dependencies.native.readUpload(actorId, uploadId);
  }

  async upload(
    actorId: string,
    uploadId: string,
    source: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<NativeResult<NativeUploadRecord>> {
    if (this.#stopped) return Result.err(nativeFailure("stale", "Uploads are shutting down"));
    if (this.#active.has(uploadId))
      return Result.err(nativeFailure("conflict", "This file is already uploading"));
    const existing = this.dependencies.native
      .getUpload(uploadId)
      .match({ ok: (value) => value, err: () => null });
    if (existing?.state === "ready") {
      if (existing.ownerId !== actorId)
        return Result.err(nativeFailure("forbidden", "Only the uploader can complete this file"));
      return this.dependencies.native
        .authorizeThread(actorId, existing.threadId, true)
        .map(() => existing);
    }
    const claim = this.dependencies.native.claimUpload(actorId, uploadId);
    const claimed = claim.match({ ok: (value) => value, err: () => null });
    if (claimed === null) return claim;
    const controller = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const completion = this.#completeUpload(actorId, claimed, source, combinedSignal);
    this.#active.set(uploadId, { controller, completion });
    const outcome = await completion;
    this.#active.delete(uploadId);
    return outcome;
  }

  async #completeUpload(
    actorId: string,
    claimed: NativeUploadRecord,
    source: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<NativeResult<NativeUploadRecord>> {
    const operation = await this.#uploadClaimed(actorId, claimed, source, signal);
    const uploadFailure = operation.match({ ok: () => null, err: (error) => error });
    if (uploadFailure === null) return operation;
    const settlement = this.dependencies.native.settleUpload(claimed.id, {
      attempt: claimed.attempt,
      historyGeneration: claimed.historyGeneration,
      state: "failed",
    });
    const settlementFailure = settlement.match({ ok: () => null, err: (error) => error });
    if (settlementFailure === null) return operation;
    if (
      settlementFailure._tag === "NativeStoreFailure" &&
      (settlementFailure.code === "stale" || settlementFailure.code === "not-found")
    )
      return operation;
    return Result.err(
      new NativeUploadSettlementFailed({
        uploadFailure,
        settlementFailure,
        message: "Upload failed and its failure state could not be persisted",
      }),
    );
  }

  async stop(): Promise<NativeResult<void>> {
    this.#stopped = true;
    const active = [...this.#active.values()];
    for (const upload of active) upload.controller.abort();
    const outcomes = await Promise.all(active.map((upload) => upload.completion));
    for (const outcome of outcomes) {
      const failure = outcome.match({ ok: () => null, err: (error) => error });
      if (failure?._tag === "NativeUploadSettlementFailed") return Result.err(failure);
    }
    return Result.ok(undefined);
  }

  async #uploadClaimed(
    actorId: string,
    upload: NativeUploadRecord,
    source: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<NativeStateResult<NativeUploadRecord>> {
    const service = this;
    return Result.gen(async function* () {
      const bounded = service.#uploadStream(upload, source, signal);
      const transfer = yield* Result.await(
        service.dependencies.blobs
          .startStagedUpload({
            source: bounded,
            stagingExpiresAt: service.#now() + 24 * 60 * 60_000,
            expectedByteLength: upload.size,
          })
          .then((result) =>
            result.mapError(() => nativeFailure("invalid", "Upload could not start")),
          ),
      );
      const blob = yield* Result.await(
        transfer.completion.then((result) =>
          result.mapError(() =>
            nativeFailure("invalid", "Upload was interrupted or did not match its declared size"),
          ),
        ),
      );
      yield* service.dependencies.native.authorizeThread(actorId, upload.threadId, true);
      const current = yield* service.dependencies.native.getUpload(upload.id);
      if (
        current.state === "canceled" ||
        current.attempt !== upload.attempt ||
        current.historyGeneration !== upload.historyGeneration
      )
        return Result.err(nativeFailure("stale", "Upload no longer belongs to an active input"));
      const registered = yield* service.dependencies.resources
        .registerOrGet({
          candidateResourceId: createResourceId(),
          origin: {
            version: 1,
            kind: "native-upload",
            threadId: upload.threadId,
            uploadId: upload.id,
            uploaderId: actorId,
          },
          filename: upload.filename,
          declaredMediaType: upload.mediaType,
          reportedByteLength: upload.size,
          createdAt: service.#now(),
        })
        .mapError(() => nativeFailure("sqlite", "File metadata could not be stored"));
      if (registered.kind === "collision")
        return Result.err(
          nativeFailure("conflict", "Upload resource identity collided; retry the transfer"),
        );
      const record = registered.record;
      yield* service.dependencies.resources
        .retainNativeResource({
          uploadId: upload.id,
          threadId: upload.threadId,
          resourceId: record.resourceId,
        })
        .mapError(() => nativeFailure("sqlite", "File ownership could not be stored"));
      const adopted = yield* Result.await(
        service.dependencies.blobs
          .adopt(transfer.handle)
          .then((result) =>
            result.mapError(() => nativeFailure("invalid", "Uploaded bytes are unavailable")),
          ),
      );
      const attachment = service.dependencies.resources.compareAndSwapCache({
        resourceId: record.resourceId,
        ...(record.cache ? { expected: record.cache } : {}),
        next: { blob: adopted, cachedAt: service.#now() },
      });
      const attached = attachment.match({
        ok: (value) => value.kind === "attached",
        err: () => false,
      });
      if (!attached) {
        yield* Result.await(
          service.dependencies.blobs
            .delete(adopted)
            .then((result) =>
              result.mapError(() =>
                nativeFailure("sqlite", "Discarded upload bytes could not be released"),
              ),
            ),
        );
        return Result.err(nativeFailure("stale", "File was removed while uploading"));
      }
      if (record.cache && record.cache.blob.objectId !== blob.objectId)
        yield* Result.await(
          service.dependencies.blobs
            .delete(record.cache.blob)
            .then((result) =>
              result.mapError(() =>
                nativeFailure("sqlite", "Previous upload bytes could not be released"),
              ),
            ),
        );
      return service.dependencies.native.settleUpload(upload.id, {
        attempt: upload.attempt,
        historyGeneration: upload.historyGeneration,
        state: "ready",
        resourceUri: formatResourceUri(record.resourceId),
      });
    });
  }

  #uploadStream(
    upload: NativeUploadRecord,
    source: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): ReadableStream<Uint8Array> {
    let transferred = 0;
    let lastReportedAt = 0;
    const now = this.#now;
    const onProgress = this.dependencies.onProgress;
    return source.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (signal?.aborted) {
            signalNativeResourceStreamFailure(
              controller,
              nativeFailure("stale", "Upload canceled"),
            );
            return;
          }
          transferred += chunk.byteLength;
          if (transferred > upload.size || transferred > RESOURCE_MAX_BYTES) {
            signalNativeResourceStreamFailure(
              controller,
              nativeFailure("invalid", "Upload exceeds its declared size"),
            );
            return;
          }
          const at = now();
          if (at - lastReportedAt >= 250 || transferred === upload.size) {
            lastReportedAt = at;
            onProgress?.({
              uploadId: upload.id,
              threadId: upload.threadId,
              transferred,
              size: upload.size,
            });
          }
          controller.enqueue(chunk);
        },
      }),
      signal ? { signal } : undefined,
    );
  }

  authorize(actorId: string, uri: string): NativeResult<ResourceRecordV1> {
    const service = this;
    return Result.gen(function* () {
      const id = yield* parseResourceUri(uri).mapError(() =>
        nativeFailure("invalid", "Invalid resource reference"),
      );
      const record = yield* service.dependencies.resources
        .getRetained(id)
        .mapError(() => nativeFailure("sqlite", "File metadata is unavailable"));
      if (!record) return Result.err(nativeFailure("not-found", "File is unavailable"));
      if (record.origin.kind === "discord-attachment") {
        const user = yield* service.dependencies.native.getUser(actorId);
        if (user.role !== "owner")
          return Result.err(
            nativeFailure("forbidden", "Only the owner can read external attachments"),
          );
        return Result.ok(record);
      }
      yield* service.dependencies.native.authorizeThread(actorId, record.origin.threadId);
      const upload = yield* service.dependencies.native.readUpload(actorId, record.origin.uploadId);
      if (upload.state !== "ready" || upload.resourceUri !== uri)
        return Result.err(nativeFailure("not-found", "File is unavailable"));
      return Result.ok(record);
    });
  }

  validateReference(actorId: string, destinationThreadId: string, uri: string): NativeResult<void> {
    const service = this;
    return Result.gen(function* () {
      yield* service.dependencies.native.authorizeThread(actorId, destinationThreadId, true);
      yield* service.authorize(actorId, uri);
      return Result.ok(undefined);
    });
  }

  async open(
    actorId: string,
    uri: string,
    signal?: AbortSignal,
  ): Promise<NativeResult<VerifiedResourceRead>> {
    const authorization = this.authorize(actorId, uri);
    const error = authorization.match({ ok: () => null, err: (failure) => failure });
    if (error) return Result.err(error);
    return (
      await this.dependencies.access.open(uri, {
        maxBytes: RESOURCE_MAX_BYTES,
        expected: "any",
        ...(signal ? { signal } : {}),
      })
    ).mapError(() => nativeFailure("not-found", "File bytes are unavailable"));
  }

  scopedAccess(actorId: string): ResourceAccess {
    const service = this;
    const verify = (uri: string) =>
      service
        .authorize(actorId, uri)
        .mapError(
          () => new ResourceNotFound({ uri, message: "Resource is unavailable to this thread" }),
        );
    return {
      describe(uri) {
        return verify(uri).andThen(() => service.dependencies.access.describe(uri));
      },
      async open(uri: string, options: ResourceOpenOptions) {
        const authorization = verify(uri);
        const error = authorization.match({ ok: () => null, err: (failure) => failure });
        if (error) return Result.err(error);
        return service.dependencies.access.open(uri, options);
      },
      async materialize(uri: string, options: ResourceMaterializeOptions) {
        const authorization = verify(uri);
        const error = authorization.match({ ok: () => null, err: (failure) => failure });
        if (error) return Result.err(error);
        return service.dependencies.access.materialize(uri, options);
      },
    };
  }

  async modelAttachment(
    actorId: string,
    uri: string,
    supports: (mediaType: string) => boolean,
  ): Promise<NativeResult<NativeModelAttachment>> {
    const service = this;
    return Result.gen(async function* () {
      const record = yield* service.authorize(actorId, uri);
      const fallback: NativeModelAttachment = {
        type: "resource",
        uri,
        filename: record.filename ?? "attachment",
        mediaType:
          record.detectedMediaType ?? record.declaredMediaType ?? "application/octet-stream",
      };
      if (
        (record.cache?.blob.byteLength ?? Infinity) > RESOURCE_MODEL_INLINE_MAX_BYTES ||
        !supports(fallback.mediaType)
      )
        return Result.ok(fallback);
      const read = yield* Result.await(service.open(actorId, uri));
      const bytes = yield* Result.await(
        consumeVerifiedResourceRead(read).then((result) =>
          result.mapError(() => nativeFailure("invalid", "File verification failed")),
        ),
      );
      const mediaType = read.classification.mediaType ?? "application/octet-stream";
      if (!supports(mediaType)) return Result.ok(fallback);
      if (read.classification.kind === "image")
        return Result.ok<NativeModelAttachment>({ type: "image", image: bytes, mediaType });
      return Result.ok<NativeModelAttachment>({
        type: "file",
        data: bytes,
        mediaType,
        filename: fallback.filename,
      });
    });
  }

  async handleAvatar(request: Request, actorId: string, targetId = "lilac"): Promise<Response> {
    const service = this;
    const result = await Result.gen(async function* () {
      const actor = yield* service.dependencies.native.getUser(actorId);
      const identity = yield* service.dependencies.native.getUser(targetId);
      if (request.method === "GET") {
        if (!identity.avatar)
          return Result.err(nativeFailure("not-found", "Avatar is unavailable"));
        const avatar = identity.avatar;
        const etag = `"${avatar.blob.sha256}"`;
        const currentRevision =
          new URL(request.url).searchParams.get("revision") === avatar.blob.sha256;
        const headers = {
          "Content-Type": avatar.mediaType,
          "Cache-Control": currentRevision
            ? "private, max-age=86400, immutable"
            : "private, no-cache",
          ETag: etag,
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox; default-src 'none'",
        };
        if (request.headers.get("if-none-match") === etag)
          return Result.ok(new Response(null, { status: 304, headers }));
        const opened = yield* Result.await(
          service.dependencies.blobs
            .open(avatar.blob)
            .then((value) =>
              value.mapError(() => nativeFailure("not-found", "Avatar is unavailable")),
            ),
        );
        const bytes = yield* Result.await(
          Result.tryPromise({
            try: () => new Response(opened.stream).arrayBuffer(),
            catch: () => nativeFailure("not-found", "Avatar is unavailable"),
          }),
        );
        yield* Result.await(
          opened.completion.then((value) =>
            value.mapError(() => nativeFailure("invalid", "Avatar verification failed")),
          ),
        );
        return Result.ok(new Response(bytes, { headers }));
      }
      if (targetId !== "lilac" && (targetId !== actorId || actor.role === "service"))
        return Result.err(nativeFailure("forbidden", "You can only edit your own profile"));
      if (targetId === "lilac" && actor.role !== "owner")
        return Result.err(nativeFailure("forbidden", "Only the owner can change agent identity"));
      const update = (
        targetId === "lilac"
          ? service.dependencies.native.setAgentIdentity
          : service.dependencies.native.setUserProfile
      )?.bind(service.dependencies.native);
      const project = targetId === "lilac" ? agentIdentity : nativeUserDisplay;
      const provider = targetId !== "lilac" ? service.dependencies.profileProvider : undefined;
      if (!update) return Result.err(nativeFailure("invalid", "Agent identity is unavailable"));
      if (request.method === "DELETE") {
        if (provider)
          return Result.ok(yield* Result.await(service.updateProviderAvatar(identity, null)));
        const changed = yield* update(actorId, { avatar: null });
        if (identity.avatar)
          yield* Result.await(
            service.dependencies.blobs
              .delete(identity.avatar.blob)
              .then((value) =>
                value.mapError(() =>
                  nativeFailure("sqlite", "Previous avatar could not be removed"),
                ),
              ),
          );
        return Result.ok(
          Response.json(project(changed), { headers: { "Cache-Control": "no-store" } }),
        );
      }
      if (request.method !== "PUT") return Result.ok(new Response(null, { status: 405 }));
      const size = Number(request.headers.get("content-length"));
      if (size > 2_097_152) return Result.err(nativeFailure("invalid", "Avatar exceeds 2 MiB"));
      if (!request.body) return Result.err(nativeFailure("invalid", "Avatar bytes are required"));
      const bytes = yield* Result.await(readAvatarBytes(request.body));
      const classification = yield* Result.await(
        Result.tryPromise({
          try: () =>
            classifyResourcePrefix({
              prefix: bytes,
              filename: "avatar",
              declaredMediaType: request.headers.get("content-type") ?? undefined,
            }),
          catch: () => nativeFailure("invalid", "Avatar could not be read"),
        }),
      );
      const mediaType = classification.mediaType;
      if (
        mediaType !== "image/png" &&
        mediaType !== "image/jpeg" &&
        mediaType !== "image/webp" &&
        mediaType !== "image/gif"
      )
        return Result.err(nativeFailure("invalid", "Choose a PNG, JPEG, WebP or GIF image"));
      if (provider)
        return Result.ok(
          yield* Result.await(
            service.updateProviderAvatar(
              identity,
              new File([new Uint8Array(bytes)], "avatar", { type: mediaType }),
            ),
          ),
        );
      const transfer = yield* Result.await(
        service.dependencies.blobs
          .startUpload({ source: bytes, retention: { kind: "durable" } })
          .then((value) =>
            value.mapError(() => nativeFailure("invalid", "Avatar upload could not start")),
          ),
      );
      const blob = yield* Result.await(
        transfer.completion.then((value) =>
          value.mapError(() => nativeFailure("invalid", "Avatar upload failed")),
        ),
      );
      const persisted = Result.gen(function* () {
        const previous = yield* service.dependencies.native.getUser(targetId);
        const changed = yield* update(actorId, { avatar: { blob, mediaType } });
        return Result.ok({ previous, changed });
      });
      const failure = persisted.match({ ok: () => null, err: (error) => error });
      if (failure) {
        yield* Result.await(
          service.dependencies.blobs
            .delete(blob)
            .then((value) =>
              value.mapError(() => nativeFailure("sqlite", "Unused avatar could not be removed")),
            ),
        );
        return Result.err(failure);
      }
      const { previous, changed } = yield* persisted;
      if (previous.avatar)
        yield* Result.await(
          service.dependencies.blobs
            .delete(previous.avatar.blob)
            .then((value) =>
              value.mapError(() => nativeFailure("sqlite", "Previous avatar could not be removed")),
            ),
        );
      return Result.ok(
        Response.json(project(changed), { headers: { "Cache-Control": "no-store" } }),
      );
    });
    return result.match({ ok: (response) => response, err: resourceFailureResponse });
  }

  async updateProviderAvatar(
    identity: NativeUser,
    file: File | null,
  ): Promise<NativeResult<Response>> {
    const service = this;
    return Result.gen(async function* () {
      const provider = service.dependencies.profileProvider;
      const update = service.dependencies.native.setUserProfile?.bind(service.dependencies.native);
      if (!provider || !update)
        return Result.err(nativeFailure("invalid", "Profile provider is unavailable"));
      const profile = yield* Result.await(provider.updateAvatar(identity.providerId, file));
      const changed = yield* update(identity.id, {
        providerAvatarUrl: profile.avatarUrl ?? null,
        avatar: null,
      });
      if (identity.avatar)
        yield* Result.await(
          service.dependencies.blobs
            .delete(identity.avatar.blob)
            .then((value) =>
              value.mapError(() => nativeFailure("sqlite", "Previous avatar could not be removed")),
            ),
        );
      return Result.ok(
        Response.json(nativeUserDisplay(changed), { headers: { "Cache-Control": "no-store" } }),
      );
    });
  }

  async handle(request: Request, actorId: string): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname === "/api/identity/avatar") return this.handleAvatar(request, actorId);
    if (url.pathname === "/api/profile/avatar") return this.handleAvatar(request, actorId, actorId);
    const avatarUserId = /^\/api\/users\/([^/]+)\/avatar$/u.exec(url.pathname)?.[1];
    if (avatarUserId && request.method === "GET") {
      const decoded = Result.try({
        try: () => decodeURIComponent(avatarUserId),
        catch: () => nativeFailure("invalid", "Invalid avatar user ID"),
      }).match<{ id: string } | { response: Response }>({
        ok: (id) => ({ id }),
        err: (error) => ({ response: resourceFailureResponse(error) }),
      });
      if ("response" in decoded) return decoded.response;
      return this.handleAvatar(request, actorId, decoded.id);
    }
    const uploadId = /^\/api\/uploads\/([^/]+)$/u.exec(url.pathname)?.[1];
    if (uploadId !== undefined && request.method === "PUT") {
      if (!request.body) return Response.json({ error: "Missing upload bytes" }, { status: 400 });
      const result = await this.upload(actorId, uploadId, request.body, request.signal);
      return result.match({
        ok: (upload) => Response.json({ id: upload.id, state: upload.state }),
        err: resourceFailureResponse,
      });
    }
    const resourceMatch = /^\/api\/resources\/([^/]+)(\/preview)?$/u.exec(url.pathname);
    const resourceId = resourceMatch?.[1];
    if (resourceId === undefined || (request.method !== "GET" && request.method !== "HEAD"))
      return undefined;
    const reference = this.dependencies.native.readUpload(actorId, resourceId);
    const upload = reference.match({ ok: (value) => value, err: () => null });
    if (!upload)
      return reference.match({
        ok: () => new Response(null, { status: 404 }),
        err: resourceFailureResponse,
      });
    if (upload.state !== "ready" || !upload.resourceUri) return new Response(null, { status: 409 });
    const result = await this.open(actorId, upload.resourceUri, request.signal);
    const read = result.match({ ok: (value) => value, err: () => null });
    if (!read)
      return result.match({
        ok: () => new Response(null, { status: 404 }),
        err: resourceFailureResponse,
      });
    if (resourceMatch?.[2]) {
      const preview = await readPreviewPrefix(read.stream);
      return preview
        .andThen((bytes) => textPreview(bytes, read.blob.byteLength))
        .match({
          ok: (value) =>
            Response.json(value, {
              headers: {
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
              },
            }),
          err: (error) =>
            Response.json(
              { error: error.message },
              {
                status: error.code === "invalid" ? 422 : 404,
                headers: { "Cache-Control": "no-store" },
              },
            ),
        });
    }
    const size = read.blob.byteLength;
    const range = parseByteRange(request.headers.get("range"), size);
    if (range === "invalid") {
      await read.stream.cancel();
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const mediaType = read.classification.mediaType ?? "application/octet-stream";
    const safeInline = [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "application/pdf",
      "text/plain",
    ].includes(mediaType);
    const filename = read.descriptor.filename ?? "attachment";
    const headers = new Headers({
      "Content-Type": mediaType,
      "Content-Length": String(range ? range.end - range.start + 1 : size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Content-Disposition": `${safeInline && url.searchParams.get("download") !== "1" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(filename).replaceAll("'", "%27")}`,
    });
    if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    if (request.method === "HEAD") {
      await read.stream.cancel();
      return new Response(null, { status: range ? 206 : 200, headers });
    }
    let offset = 0;
    const body = read.stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          const start = range ? Math.max(0, range.start - offset) : 0;
          const end = range ? Math.min(chunk.byteLength, range.end + 1 - offset) : chunk.byteLength;
          offset += chunk.byteLength;
          if (end > start) controller.enqueue(chunk.subarray(start, end));
        },
        async flush(controller) {
          const failure = (await read.completion).match({ ok: () => null, err: (error) => error });
          if (failure)
            signalNativeResourceStreamFailure(
              controller,
              nativeFailure("invalid", "File integrity verification failed"),
            );
        },
      }),
    );
    return new Response(body, { status: range ? 206 : 200, headers });
  }

  reconcileReferences(): NativeResult<number> {
    const service = this;
    return Result.gen(function* () {
      const references = yield* service.dependencies.resources
        .listNativeResourceReferences()
        .mapError(() => nativeFailure("sqlite", "File ownership could not be read"));
      let released = 0;
      for (const reference of references) {
        const upload = yield* service.dependencies.native
          .getUpload(reference.uploadId)
          .map<NativeUploadRecord | null>((value) => value)
          .tryRecover((error) =>
            error._tag === "NativeStoreFailure" && error.code === "not-found"
              ? Result.ok(null)
              : Result.err(error),
          );
        const thread = upload
          ? yield* service.dependencies.native.getThreadRecord(upload.threadId)
          : null;
        const active = thread && !thread.deleted && upload;
        const sameGeneration =
          upload && thread && upload.historyGeneration === thread.historyGeneration;
        const withinStagingLifetime =
          upload && service.#now() - upload.createdAt < 24 * 60 * 60_000;
        if (
          active &&
          ((upload.state === "ready" && (upload.published || withinStagingLifetime)) ||
            (upload.state === "pending" && sameGeneration && withinStagingLifetime))
        )
          continue;
        yield* service.dependencies.resources
          .releaseNativeResource(reference.uploadId)
          .mapError(() => nativeFailure("sqlite", "File ownership could not be released"));
        released += 1;
      }
      return Result.ok(released);
    });
  }
}

function resourceFailureResponse(error: NativeResourceError): Response {
  if (error._tag === "NativeAuthError")
    return Response.json(
      { error: error.message },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  if (error._tag !== "NativeStoreFailure")
    return Response.json({ error: "File metadata is unavailable" }, { status: 503 });
  const statusByCode = {
    forbidden: 403,
    "not-found": 404,
    conflict: 409,
    stale: 409,
    invalid: 400,
    sqlite: 503,
  } satisfies Record<NativeStoreFailureCode, number>;
  const status = statusByCode[error.code];
  return Response.json(
    { error: error.message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function parseByteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | "invalid" | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header);
  if (!match || size === 0 || (!match[1] && !match[2])) return "invalid";
  if (!match[1]) {
    const count = Number(match[2]);
    return Number.isSafeInteger(count) && count > 0
      ? { start: Math.max(0, size - count), end: size - 1 }
      : "invalid";
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end)
    return "invalid";
  return { start, end: Math.min(end, size - 1) };
}

export function signalNativeResourceStreamFailure(
  controller: TransformStreamDefaultController<Uint8Array>,
  error: NativeStoreFailure,
): void {
  controller.error(error);
}

async function readAvatarBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<NativeStateResult<Uint8Array>> {
  const reader = stream.getReader();
  const result = await Result.tryPromise({
    try: async () => {
      const bytes = new Uint8Array(2_097_153);
      let size = 0;
      while (size < bytes.byteLength) {
        const next = await reader.read();
        if (next.done) break;
        const part = next.value.subarray(0, bytes.byteLength - size);
        bytes.set(part, size);
        size += part.byteLength;
      }
      return bytes.subarray(0, size);
    },
    catch: () => nativeFailure("invalid", "Avatar upload failed"),
  });
  const cleanup = await Result.tryPromise({
    try: () => reader.cancel(),
    catch: () => nativeFailure("invalid", "Avatar upload failed"),
  });
  reader.releaseLock();
  return Result.all([result, cleanup]).andThen(([bytes]) =>
    bytes.byteLength > 2_097_152
      ? Result.err(nativeFailure("invalid", "Avatar exceeds 2 MiB"))
      : Result.ok(bytes),
  );
}
