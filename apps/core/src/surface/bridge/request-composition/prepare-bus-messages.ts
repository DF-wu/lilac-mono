import {
  materializeBlobRead,
  type BlobHandleV1,
  type BlobRefV1,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";
import type {
  BusFilePartV2,
  BusMessageV2,
  StoredFilePartV1,
  StoredMessageV1,
} from "@stanley2058/lilac-event-bus";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import {
  deleteDiscordRequestBlobHandles,
  type DiscordRequestBlobCleanupFailed,
} from "./attachments";

export class DiscordStoredBlobPreparationFailed extends TaggedError(
  "DiscordStoredBlobPreparationFailed",
)<{
  readonly objectId: string;
  readonly stage: "open" | "read" | "upload";
  readonly message: string;
}> {}

export class DiscordStoredBlobPreparationAndCleanupFailed extends TaggedError(
  "DiscordStoredBlobPreparationAndCleanupFailed",
)<{
  readonly primary: DiscordStoredBlobPreparationFailed;
  readonly cleanup: DiscordRequestBlobCleanupFailed;
  readonly message: string;
}> {}

export type DiscordStoredBlobPreparationError =
  | DiscordStoredBlobPreparationFailed
  | DiscordStoredBlobPreparationAndCleanupFailed;

type MessageForRole<TMessage, TRole> = Extract<TMessage, { role: TRole }>;
type MessageContent<TMessage> = TMessage extends { content: infer TContent } ? TContent : never;
type ArrayContentPart<TMessage> = Extract<MessageContent<TMessage>, readonly object[]>[number];

type StoredUserMessage = MessageForRole<StoredMessageV1, "user">;
type StoredAssistantMessage = MessageForRole<StoredMessageV1, "assistant">;
type StoredToolMessage = MessageForRole<StoredMessageV1, "tool">;
type BusUserMessage = MessageForRole<BusMessageV2, "user">;
type BusAssistantMessage = MessageForRole<BusMessageV2, "assistant">;
type BusToolMessage = MessageForRole<BusMessageV2, "tool">;

type StoredUserPart = ArrayContentPart<StoredUserMessage>;
type StoredAssistantPart = ArrayContentPart<StoredAssistantMessage>;
type StoredToolPart = ArrayContentPart<StoredToolMessage>;
type BusUserPart = ArrayContentPart<BusUserMessage>;
type BusAssistantPart = ArrayContentPart<BusAssistantMessage>;
type BusToolPart = ArrayContentPart<BusToolMessage>;
type StoredToolResultPart = Extract<StoredAssistantPart | StoredToolPart, { type: "tool-result" }>;
type BusToolResultPart = Extract<BusAssistantPart | BusToolPart, { type: "tool-result" }>;
type StoredToolContentPart = Extract<
  StoredToolResultPart["output"],
  { type: "content" }
>["value"][number];
type BusToolContentPart = Extract<
  BusToolResultPart["output"],
  { type: "content" }
>["value"][number];

function preparationFailure(
  blob: BlobRefV1,
  stage: DiscordStoredBlobPreparationFailed["stage"],
  message: string,
): DiscordStoredBlobPreparationFailed {
  return new DiscordStoredBlobPreparationFailed({ objectId: blob.objectId, stage, message });
}

async function copyStoredBlob(input: {
  blobStore?: BlobStore;
  part: StoredFilePartV1;
  handles: BlobHandleV1[];
}): Promise<ResultType<BusFilePartV2, DiscordStoredBlobPreparationFailed>> {
  if (!input.blobStore) {
    return Result.err(
      preparationFailure(input.part.blob, "open", "Discord request blob storage is unavailable"),
    );
  }
  const blobStore = input.blobStore;
  return Result.gen(async function* () {
    const read = yield* Result.await(
      blobStore
        .open(input.part.blob)
        .then((opened) =>
          opened.mapError((error) => preparationFailure(input.part.blob, "open", error.message)),
        ),
    );
    const bytes = yield* Result.await(
      materializeBlobRead(read).then((materialized) =>
        materialized.mapError((error) =>
          preparationFailure(input.part.blob, "read", error.message),
        ),
      ),
    );
    const upload = yield* Result.await(
      blobStore
        .startUpload({
          source: bytes,
          retention: { kind: "durable" },
          expectedSha256: input.part.blob.sha256,
          expectedByteLength: input.part.blob.byteLength,
        })
        .then((started) =>
          started.mapError((error) => preparationFailure(input.part.blob, "upload", error.message)),
        ),
    );
    input.handles.push(upload.handle);
    return Result.ok({
      type: "blob" as const,
      blob: upload.handle,
      mediaType: input.part.mediaType,
      ...(input.part.filename ? { filename: input.part.filename } : {}),
    });
  });
}

async function prepareToolContentPart(input: {
  blobStore?: BlobStore;
  part: StoredToolContentPart;
  handles: BlobHandleV1[];
}): Promise<ResultType<BusToolContentPart, DiscordStoredBlobPreparationFailed>> {
  switch (input.part.type) {
    case "blob":
      return copyStoredBlob({
        blobStore: input.blobStore,
        part: input.part,
        handles: input.handles,
      });
    case "text":
    case "custom":
      return Result.ok(input.part);
  }
}

async function prepareToolResultPart(input: {
  blobStore?: BlobStore;
  part: StoredToolResultPart;
  handles: BlobHandleV1[];
}): Promise<ResultType<BusToolResultPart, DiscordStoredBlobPreparationFailed>> {
  if (input.part.output.type !== "content") return Result.ok(input.part);
  const part = input.part;
  const output = input.part.output;
  return Result.gen(async function* () {
    const values: BusToolContentPart[] = [];
    for (const value of output.value) {
      values.push(
        yield* Result.await(
          prepareToolContentPart({
            blobStore: input.blobStore,
            part: value,
            handles: input.handles,
          }),
        ),
      );
    }
    return Result.ok({ ...part, output: { ...output, value: values } });
  });
}

async function prepareUserPart(input: {
  blobStore?: BlobStore;
  part: StoredUserPart;
  handles: BlobHandleV1[];
}): Promise<ResultType<BusUserPart, DiscordStoredBlobPreparationFailed>> {
  switch (input.part.type) {
    case "blob":
      return copyStoredBlob({
        blobStore: input.blobStore,
        part: input.part,
        handles: input.handles,
      });
    case "text":
      return Result.ok(input.part);
  }
}

async function prepareAssistantPart(input: {
  blobStore?: BlobStore;
  part: StoredAssistantPart;
  handles: BlobHandleV1[];
}): Promise<ResultType<BusAssistantPart, DiscordStoredBlobPreparationFailed>> {
  switch (input.part.type) {
    case "blob":
      return copyStoredBlob({
        blobStore: input.blobStore,
        part: input.part,
        handles: input.handles,
      });
    case "tool-result":
      return prepareToolResultPart({
        blobStore: input.blobStore,
        part: input.part,
        handles: input.handles,
      });
    case "text":
    case "reasoning":
    case "custom":
    case "tool-call":
    case "tool-approval-request":
      return Result.ok(input.part);
  }
}

async function prepareToolPart(input: {
  blobStore?: BlobStore;
  part: StoredToolPart;
  handles: BlobHandleV1[];
}): Promise<ResultType<BusToolPart, DiscordStoredBlobPreparationFailed>> {
  switch (input.part.type) {
    case "tool-result":
      return prepareToolResultPart({
        blobStore: input.blobStore,
        part: input.part,
        handles: input.handles,
      });
    case "tool-approval-response":
      return Result.ok(input.part);
  }
}

async function prepareMessage(input: {
  blobStore?: BlobStore;
  message: StoredMessageV1;
  handles: BlobHandleV1[];
}): Promise<ResultType<BusMessageV2, DiscordStoredBlobPreparationFailed>> {
  switch (input.message.role) {
    case "system":
      return Result.ok(input.message);
    case "user": {
      const sourceContent = input.message.content;
      if (typeof sourceContent === "string") return Result.ok(input.message);
      const message = input.message;
      return Result.gen(async function* () {
        const content: BusUserPart[] = [];
        for (const part of sourceContent) {
          content.push(
            yield* Result.await(
              prepareUserPart({ blobStore: input.blobStore, part, handles: input.handles }),
            ),
          );
        }
        return Result.ok({ ...message, content });
      });
    }
    case "assistant": {
      const sourceContent = input.message.content;
      if (typeof sourceContent === "string") return Result.ok(input.message);
      const message = input.message;
      return Result.gen(async function* () {
        const content: BusAssistantPart[] = [];
        for (const part of sourceContent) {
          content.push(
            yield* Result.await(
              prepareAssistantPart({ blobStore: input.blobStore, part, handles: input.handles }),
            ),
          );
        }
        return Result.ok({ ...message, content });
      });
    }
    case "tool": {
      const message = input.message;
      return Result.gen(async function* () {
        const content: BusToolPart[] = [];
        for (const part of message.content) {
          content.push(
            yield* Result.await(
              prepareToolPart({ blobStore: input.blobStore, part, handles: input.handles }),
            ),
          );
        }
        return Result.ok({ ...message, content });
      });
    }
  }
}

export async function prepareStoredMessagesForBus(input: {
  readonly blobStore?: BlobStore;
  readonly messages: readonly StoredMessageV1[];
}): Promise<
  ResultType<
    { readonly messages: BusMessageV2[]; readonly inputHandles: readonly BlobHandleV1[] },
    DiscordStoredBlobPreparationError
  >
> {
  type PreparedMessages = {
    readonly messages: BusMessageV2[];
    readonly inputHandles: readonly BlobHandleV1[];
  };
  const handles: BlobHandleV1[] = [];
  const prepared = await Result.gen(async function* () {
    const messages: BusMessageV2[] = [];
    for (const message of input.messages) {
      messages.push(
        yield* Result.await(prepareMessage({ blobStore: input.blobStore, message, handles })),
      );
    }
    return Result.ok({ messages, inputHandles: handles });
  });
  return prepared.match({
    ok: async (value): Promise<ResultType<PreparedMessages, DiscordStoredBlobPreparationError>> =>
      Result.ok(value),
    err: async (
      error,
    ): Promise<ResultType<PreparedMessages, DiscordStoredBlobPreparationError>> => {
      const blobStore = input.blobStore;
      if (blobStore) {
        const cleanup = await deleteDiscordRequestBlobHandles(blobStore, handles);
        return cleanup.match<ResultType<PreparedMessages, DiscordStoredBlobPreparationError>>({
          ok: () => Result.err(error),
          err: (cleanupError) =>
            Result.err(
              new DiscordStoredBlobPreparationAndCleanupFailed({
                primary: error,
                cleanup: cleanupError,
                message: "Discord stored blob preparation and input handle cleanup failed",
              }),
            ),
        });
      }
      return Result.err(error);
    },
  });
}
