import { describe, expect, it } from "bun:test";

import { createMemoryBlobStore } from "@stanley2058/lilac-blob-storage";
import type { StoredMessageV1 } from "@stanley2058/lilac-event-bus";
import type { Result as ResultType } from "better-result";

import {
  materializeStoredMessagesV1,
  projectStoredMessagesV1,
  StoredMessageProjectionError,
} from "../../src/transcript/stored-message-materialization";

function resultValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

describe("stored message materialization", () => {
  it("strictly rejects inline bytes and unresolved handles", () => {
    const inline = projectStoredMessagesV1([
      {
        role: "user",
        content: [
          {
            type: "file",
            data: new Uint8Array([1, 2, 3]),
            mediaType: "application/octet-stream",
          },
        ],
      },
    ]);
    expect(inline.status).toBe("error");
    if (inline.status === "error")
      expect(inline.error).toBeInstanceOf(StoredMessageProjectionError);

    const handle = projectStoredMessagesV1([
      {
        role: "user",
        content: [
          {
            type: "blob",
            blob: { version: 1, objectId: "b1_00000000000000000000000000000000" },
            mediaType: "application/octet-stream",
          },
        ],
      },
    ]);
    expect(handle.status).toBe("error");
  });

  it("verifies blobs before returning provider messages", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const bytes = new TextEncoder().encode("verified attachment");
    const upload = resultValue(
      await blobStore.startUpload({ source: bytes, retention: { kind: "durable" } }),
    );
    const blob = resultValue(await upload.completion);
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          {
            type: "blob",
            blob,
            mediaType: "text/plain",
            filename: "attachment.txt",
          },
        ],
      },
    ] satisfies StoredMessageV1[];

    const materialized = resultValue(await materializeStoredMessagesV1({ messages, blobStore }));
    expect(materialized).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          {
            type: "file",
            data: bytes,
            mediaType: "text/plain",
            filename: "attachment.txt",
          },
        ],
      },
    ]);

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });
});
