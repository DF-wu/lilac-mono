import { modelMessageSchema, type ModelMessage } from "ai";
import {
  materializeBlobRead,
  type BlobRefV1,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";
import { storedFilePartV1Schema, type StoredMessageV1 } from "@stanley2058/lilac-event-bus";
import { Result, TaggedError, type Result as ResultType } from "better-result";

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
}): Promise<ResultType<object, StoredMessageMaterializationError>> {
  if (input.part.output.type !== "content") return Result.ok(input.part);
  const value: object[] = [];
  for (const part of input.part.output.value) {
    if (part.type !== "blob") {
      value.push(part);
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
}): Promise<ResultType<object, StoredMessageMaterializationError>> {
  if (input.part.type === "blob") return materializeStoredFile({ ...input, part: input.part });
  if (input.part.type === "tool-result") {
    return materializeToolResult({ ...input, part: input.part });
  }
  return Result.ok(input.part);
}

async function materializeStoredMessage(input: {
  readonly message: StoredMessageV1;
  readonly blobStore: BlobStore;
  readonly cache: Map<string, Promise<ResultType<Uint8Array, StoredMessageMaterializationError>>>;
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
    const failure = materialized.match({ ok: () => null, err: (error) => error });
    if (failure) return Result.err(failure);
    materialized.match({ ok: (value) => content.push(value), err: () => undefined });
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
    });
    const failure = materialized.match({ ok: () => null, err: (error) => error });
    if (failure) return Result.err(failure);
    materialized.match({ ok: (value) => output.push(value), err: () => undefined });
  }
  return Result.ok(output);
}
