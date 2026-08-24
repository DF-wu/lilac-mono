import { modelMessageSchema, type ModelMessage } from "ai";
import {
  materializeBlobRead,
  type BlobRefV1,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";
import {
  storedFilePartV1Schema,
  type StoredMessageV1,
  type StoredResourcePartV1,
} from "@stanley2058/lilac-event-bus";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import {
  cancelVerifiedResourceRead,
  consumeVerifiedResourceRead,
  hasResourceTextFilenameHint,
  RESOURCE_MODEL_INLINE_MAX_BYTES,
  type ResourceAccess,
  type ResourceAccessError,
} from "../resource";
import { normalizeStoredMessagesV1 } from "./transcript-persistence-codec";

export class StoredMessageProjectionError extends TaggedError("StoredMessageProjectionError")<{
  readonly message: string;
}> {}

export class StoredMessageMaterializationError extends TaggedError(
  "StoredMessageMaterializationError",
)<{
  readonly stage: "open" | "read" | "decode";
  readonly message: string;
}> {}

export type StoredMessageMaterializationFailure =
  | StoredMessageProjectionError
  | StoredMessageMaterializationError;

export type StoredResourceProviderTarget = {
  readonly family: "ai-sdk" | "claude-code";
  readonly supportsImage: boolean;
  readonly supportsPdf: boolean;
};

export type StoredMessageIdentityProjectionV1 = {
  remember(
    providerMessages: readonly ModelMessage[],
    storedMessages: readonly StoredMessageV1[],
  ): ResultType<void, StoredMessageProjectionError>;
  project(
    providerMessages: readonly (ModelMessage | StoredMessageV1)[],
  ): ResultType<StoredMessageV1[], StoredMessageProjectionError>;
};

/** Keeps structured durable identity beside provider-only message representations. */
export function createStoredMessageIdentityProjectionV1(): StoredMessageIdentityProjectionV1 {
  const storedByProviderMessage = new WeakMap<object, StoredMessageV1>();
  return {
    remember(providerMessages, storedMessages) {
      if (providerMessages.length !== storedMessages.length) {
        return Result.err(
          new StoredMessageProjectionError({
            message: "Provider and stored message identity sequences are not aligned",
          }),
        );
      }
      for (let index = 0; index < providerMessages.length; index += 1) {
        const providerMessage = providerMessages[index];
        const storedMessage = storedMessages[index];
        if (providerMessage && storedMessage) {
          storedByProviderMessage.set(providerMessage, storedMessage);
        }
      }
      return Result.ok(undefined);
    },
    project(providerMessages) {
      const storedMessages: StoredMessageV1[] = [];
      for (const providerMessage of providerMessages) {
        const remembered = storedByProviderMessage.get(providerMessage);
        if (remembered) {
          storedMessages.push(remembered);
          continue;
        }
        const projected = projectStoredMessagesV1([providerMessage]);
        const projectionFailure = projected.match({
          ok: () => null,
          err: (error) => error,
        });
        if (projectionFailure) return Result.err(projectionFailure);
        const storedMessage = projected.match({
          ok: ([message]) => message ?? null,
          err: () => null,
        });
        if (!storedMessage) {
          return Result.err(
            new StoredMessageProjectionError({
              message: "Provider message projection returned no stored message",
            }),
          );
        }
        storedMessages.push(storedMessage);
      }
      return Result.ok(storedMessages);
    },
  };
}

/**
 * Projects already-resolved request content into the strict durable message contract.
 * Inline bytes, data URLs, upload handles, and unknown message parts are rejected.
 */
export function projectStoredMessagesV1(
  messages: readonly unknown[],
): ResultType<StoredMessageV1[], StoredMessageProjectionError> {
  const normalized = normalizeStoredMessagesV1(messages);
  if (normalized === null) {
    return Result.err(
      new StoredMessageProjectionError({
        message: "Messages do not satisfy the resolved stored-message contract",
      }),
    );
  }
  return Result.ok(normalized);
}

function materializationFailure(
  stage: StoredMessageMaterializationError["stage"],
  message: string,
): StoredMessageMaterializationError {
  return new StoredMessageMaterializationError({ stage, message });
}

async function materializeBlobPart(input: {
  readonly blobStore: BlobStore;
  readonly blob: BlobRefV1;
}): Promise<ResultType<Uint8Array, StoredMessageMaterializationError>> {
  const opened = await input.blobStore.open(input.blob);
  const openFailure = opened.match({ ok: () => null, err: (error) => error });
  if (openFailure) {
    return Result.err(materializationFailure("open", openFailure.message));
  }
  const read = opened.match({ ok: (value) => value, err: () => null });
  if (read === null) {
    return Result.err(materializationFailure("open", "Blob storage returned no readable object"));
  }
  return (await materializeBlobRead(read)).mapError((error) =>
    materializationFailure("read", error.message),
  );
}

/** Opens and reads every reference through EOF so storage verifies its metadata and content digest. */
export async function verifyStoredBlobReferencesV1(input: {
  readonly references: readonly BlobRefV1[];
  readonly blobStore: Pick<BlobStore, "open">;
}): Promise<ResultType<void, StoredMessageMaterializationError>> {
  return Result.gen(async function* () {
    for (const blob of input.references) {
      const read = yield* Result.await(
        input.blobStore
          .open(blob)
          .then((opened) =>
            opened.mapError((error) => materializationFailure("open", error.message)),
          ),
      );
      yield* Result.await(
        materializeBlobRead(read).then((materialized) =>
          materialized
            .map(() => undefined)
            .mapError((error) => materializationFailure("read", error.message)),
        ),
      );
    }
    return Result.ok(undefined);
  });
}

type StoredUserMessage = Extract<StoredMessageV1, { readonly role: "user" }>;
type StoredAssistantMessage = Extract<StoredMessageV1, { readonly role: "assistant" }>;
type StoredToolMessage = Extract<StoredMessageV1, { readonly role: "tool" }>;
type StoredUserPart = Exclude<StoredUserMessage["content"], string>[number];
type StoredAssistantPart = Exclude<StoredAssistantMessage["content"], string>[number];
type StoredToolPart = StoredToolMessage["content"][number];
type StoredPart = StoredUserPart | StoredAssistantPart | StoredToolPart;
type StoredToolResultPart = Extract<StoredPart, { readonly type: "tool-result" }>;

function markerValue(value: string): string {
  return value.replace(/[\n\r"\\]/gu, "_");
}

export function formatStoredResourceMarkerV1(part: StoredResourcePartV1): string {
  const fields = [
    `uri="${markerValue(part.uri)}"`,
    part.filename === undefined ? null : `filename="${markerValue(part.filename)}"`,
    part.mediaType === undefined ? null : `mime="${markerValue(part.mediaType)}"`,
    part.size === undefined ? null : `size=${part.size}`,
  ].filter((field): field is string => field !== null);
  return `[discord_attachment ${fields.join(" ")}]`;
}

const RESOURCE_INLINE_GUIDANCE =
  "Use resource.materialize to write this resource into the working directory, transform it to a supported size or format, and then consume the transformed file.";

function resourceInlineErrorCode(error: ResourceAccessError): string {
  switch (error._tag) {
    case "ResourceInvalidUri":
      return "invalid_uri";
    case "ResourceNotFound":
      return "not_found";
    case "ResourceOriginUnavailable":
      return "origin_unavailable";
    case "ResourceUnsupportedClassification":
      return "unsupported";
    case "ResourceTooLarge":
      return "too_large";
    case "ResourceCacheUnavailable":
      return "cache_unavailable";
    case "ResourceIntegrityFailure":
      return "integrity_failure";
    case "ResourceCancelled":
      return "cancelled";
    case "ResourceAlreadyExists":
      return "already_exists";
    case "ResourceWriteFailed":
      return "write_failed";
  }
}

function resourceInlineGuidance(input: {
  readonly part: StoredResourcePartV1;
  readonly code: string;
  readonly limit?: number;
}): object[] {
  const fields = [
    `uri="${markerValue(input.part.uri)}"`,
    `code="${input.code}"`,
    input.limit === undefined ? null : `limit=${input.limit}`,
  ].filter((field): field is string => field !== null);
  return [
    { type: "text", text: `[resource_inline_error ${fields.join(" ")}]` },
    { type: "text", text: RESOURCE_INLINE_GUIDANCE },
  ];
}

function resourceKindFromMediaType(mediaType: string | undefined): "image" | "pdf" | null {
  if (mediaType?.startsWith("image/")) return "image";
  if (mediaType === "application/pdf") return "pdf";
  return null;
}

function providerSupportsResourceKind(
  target: StoredResourceProviderTarget,
  resourceKind: "image" | "pdf",
): boolean {
  return resourceKind === "image"
    ? target.supportsImage
    : target.family === "ai-sdk" && target.supportsPdf;
}

function resourceAccessDecision<T>(
  result: ResultType<T, ResourceAccessError>,
):
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "error"; readonly error: ResourceAccessError } {
  return result.match<
    | { readonly kind: "value"; readonly value: T }
    | { readonly kind: "error"; readonly error: ResourceAccessError }
  >({
    ok: (value) => ({ kind: "value", value }),
    err: (error) => ({ kind: "error", error }),
  });
}

function expectedResourceErrorParts(input: {
  readonly marker: object;
  readonly part: StoredResourcePartV1;
  readonly error: ResourceAccessError;
}): object[] {
  return [
    input.marker,
    ...resourceInlineGuidance({
      part: input.part,
      code: resourceInlineErrorCode(input.error),
      ...(input.error._tag === "ResourceTooLarge" ? { limit: input.error.limit } : {}),
    }),
  ];
}

async function materializeStoredResource(input: {
  readonly part: StoredResourcePartV1;
  readonly resourceAccess: Pick<ResourceAccess, "describe" | "open"> | undefined;
  readonly target: StoredResourceProviderTarget | undefined;
}): Promise<object[]> {
  const marker = { type: "text", text: formatStoredResourceMarkerV1(input.part) };
  if (!input.target) return [marker];
  if (!input.resourceAccess) {
    return [marker, ...resourceInlineGuidance({ part: input.part, code: "access_unavailable" })];
  }

  const described = resourceAccessDecision(input.resourceAccess.describe(input.part.uri));
  if (described.kind === "error") {
    return expectedResourceErrorParts({ marker, part: input.part, error: described.error });
  }
  const descriptor = described.value;

  const filename = descriptor.filename ?? input.part.filename;
  const detectedKind = resourceKindFromMediaType(descriptor.detectedMediaType);
  if (descriptor.detectedMediaType && detectedKind === null) return [marker];
  if (!descriptor.detectedMediaType && hasResourceTextFilenameHint(filename)) return [marker];

  const opened = resourceAccessDecision(
    await input.resourceAccess.open(input.part.uri, {
      maxBytes: RESOURCE_MODEL_INLINE_MAX_BYTES,
      expected: "any",
    }),
  );
  if (opened.kind === "error") {
    return expectedResourceErrorParts({ marker, part: input.part, error: opened.error });
  }
  const read = opened.value;
  const verifiedKind =
    read.classification.kind === "image" || read.classification.kind === "pdf"
      ? read.classification.kind
      : null;
  if (verifiedKind === null) {
    await cancelVerifiedResourceRead(read);
    return [marker];
  }
  if (!providerSupportsResourceKind(input.target, verifiedKind)) {
    await cancelVerifiedResourceRead(read);
    return [marker, ...resourceInlineGuidance({ part: input.part, code: "unsupported_provider" })];
  }

  const consumed = resourceAccessDecision(await consumeVerifiedResourceRead(read));
  if (consumed.kind === "error") {
    return expectedResourceErrorParts({ marker, part: input.part, error: consumed.error });
  }
  const verifiedMediaType = read.classification.mediaType;
  if (!verifiedMediaType) {
    return [marker, ...resourceInlineGuidance({ part: input.part, code: "unsupported" })];
  }

  return [
    marker,
    {
      type: "file",
      data: consumed.value,
      mediaType: verifiedMediaType,
      ...(input.part.filename === undefined ? {} : { filename: input.part.filename }),
    },
  ];
}

async function materializeStoredFile(input: {
  readonly part: ReturnType<typeof storedFilePartV1Schema.parse>;
  readonly blobStore: BlobStore;
  readonly cache: Map<string, Promise<ResultType<Uint8Array, StoredMessageMaterializationError>>>;
}): Promise<ResultType<object, StoredMessageMaterializationError>> {
  const part = input.part;
  const cacheKey = `${part.blob.objectId}:${part.blob.sha256}:${part.blob.byteLength}`;
  let pending = input.cache.get(cacheKey);
  if (pending === undefined) {
    pending = materializeBlobPart({ blobStore: input.blobStore, blob: part.blob });
    input.cache.set(cacheKey, pending);
  }
  return (await pending).map((bytes) => ({
    type: "file" as const,
    data: bytes,
    mediaType: part.mediaType,
    ...(part.filename === undefined ? {} : { filename: part.filename }),
  }));
}

async function materializeToolResult(input: {
  readonly part: StoredToolResultPart;
  readonly blobStore: BlobStore;
  readonly cache: Map<string, Promise<ResultType<Uint8Array, StoredMessageMaterializationError>>>;
  readonly resourceAccess: Pick<ResourceAccess, "describe" | "open"> | undefined;
  readonly resourceTarget: StoredResourceProviderTarget | undefined;
}): Promise<ResultType<object, StoredMessageMaterializationError>> {
  if (input.part.output.type !== "content") return Result.ok(input.part);
  const value: object[] = [];
  for (const part of input.part.output.value) {
    if (part.type !== "blob") {
      if (part.type === "resource") {
        value.push(
          ...(await materializeStoredResource({
            part,
            resourceAccess: input.resourceAccess,
            target: input.resourceTarget,
          })),
        );
      } else {
        value.push(part);
      }
      continue;
    }
    const materialized = await materializeStoredFile({ ...input, part });
    const failure = materialized.match({ ok: () => null, err: (error) => error });
    if (failure) return Result.err(failure);
    materialized.match({ ok: (file) => value.push(file), err: () => undefined });
  }
  return Result.ok({ ...input.part, output: { ...input.part.output, value } });
}

async function materializeStoredPart(input: {
  readonly part: StoredPart;
  readonly blobStore: BlobStore;
  readonly cache: Map<string, Promise<ResultType<Uint8Array, StoredMessageMaterializationError>>>;
  readonly resourceAccess: Pick<ResourceAccess, "describe" | "open"> | undefined;
  readonly resourceTarget: StoredResourceProviderTarget | undefined;
}): Promise<ResultType<object[], StoredMessageMaterializationError>> {
  if (input.part.type === "blob") {
    return (await materializeStoredFile({ ...input, part: input.part })).map((part) => [part]);
  }
  if (input.part.type === "resource") {
    return Result.ok(
      await materializeStoredResource({
        part: input.part,
        resourceAccess: input.resourceAccess,
        target: input.resourceTarget,
      }),
    );
  }
  if (input.part.type === "tool-result") {
    return (await materializeToolResult({ ...input, part: input.part })).map((part) => [part]);
  }
  return Result.ok([input.part]);
}

async function materializeStoredMessage(input: {
  readonly message: StoredMessageV1;
  readonly blobStore: BlobStore;
  readonly cache: Map<string, Promise<ResultType<Uint8Array, StoredMessageMaterializationError>>>;
  readonly resourceAccess: Pick<ResourceAccess, "describe" | "open"> | undefined;
  readonly resourceTarget: StoredResourceProviderTarget | undefined;
}): Promise<ResultType<ModelMessage, StoredMessageMaterializationError>> {
  if (typeof input.message.content === "string") {
    const decoded = modelMessageSchema.safeParse(input.message);
    if (decoded.success) return Result.ok(decoded.data);
    return Result.err(
      new StoredMessageMaterializationError({
        stage: "decode",
        message: "Stored text message does not satisfy the provider message contract",
      }),
    );
  }
  const content: object[] = [];
  for (const part of input.message.content) {
    const materialized = await materializeStoredPart({ ...input, part });
    const decision = materialized.match<
      | { readonly kind: "value"; readonly value: object[] }
      | { readonly kind: "error"; readonly error: StoredMessageMaterializationError }
    >({
      ok: (value) => ({ kind: "value", value }),
      err: (error) => ({ kind: "error", error }),
    });
    if (decision.kind === "error") return Result.err(decision.error);
    content.push(...decision.value);
  }
  const decoded = modelMessageSchema.safeParse({ ...input.message, content });
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new StoredMessageMaterializationError({
      stage: "decode",
      message: "Materialized message does not satisfy the provider message contract",
    }),
  );
}

/** Materializes and verifies every durable blob before returning provider-facing messages. */
export async function materializeStoredMessagesV1(input: {
  readonly messages: readonly StoredMessageV1[];
  readonly blobStore: BlobStore;
  readonly identityProjection?: StoredMessageIdentityProjectionV1;
  readonly resourceAccess?: Pick<ResourceAccess, "describe" | "open">;
  readonly resourceTarget?: StoredResourceProviderTarget;
}): Promise<ResultType<ModelMessage[], StoredMessageMaterializationFailure>> {
  const projected = projectStoredMessagesV1(input.messages);
  const projectionFailure = projected.match({ ok: () => null, err: (error) => error });
  if (projectionFailure) return Result.err(projectionFailure);
  const messages = projected.match({ ok: (value) => value, err: () => null });
  if (messages === null) {
    return Result.err(
      new StoredMessageProjectionError({ message: "Stored messages could not be projected" }),
    );
  }

  const output: ModelMessage[] = [];
  const cache = new Map<
    string,
    Promise<ResultType<Uint8Array, StoredMessageMaterializationError>>
  >();
  for (const message of messages) {
    const materialized = await materializeStoredMessage({
      message,
      blobStore: input.blobStore,
      cache,
      resourceAccess: input.resourceAccess,
      resourceTarget: input.resourceTarget,
    });
    const failure = materialized.match({ ok: () => null, err: (error) => error });
    if (failure) return Result.err(failure);
    materialized.match({ ok: (value) => output.push(value), err: () => undefined });
  }
  const remembered = input.identityProjection?.remember(output, messages);
  const rememberFailure = remembered?.match({ ok: () => null, err: (error) => error });
  if (rememberFailure) return Result.err(rememberFailure);
  return Result.ok(output);
}
