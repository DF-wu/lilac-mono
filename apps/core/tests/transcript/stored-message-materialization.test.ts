import { describe, expect, it } from "bun:test";

import { createMemoryBlobStore } from "@stanley2058/lilac-blob-storage";
import type { StoredMessageV1 } from "@stanley2058/lilac-event-bus";
import { Result, type Result as ResultType } from "better-result";

import {
  RESOURCE_MODEL_INLINE_MAX_BYTES,
  ResourceOriginUnavailable,
  ResourceTooLarge,
  type ResourceAccess,
  type ResourceClassification,
} from "../../src/resource";
import {
  createStoredMessageIdentityProjectionV1,
  materializeStoredMessagesV1,
  projectStoredMessagesV1,
  StoredMessageProjectionError,
} from "../../src/transcript/stored-message-materialization";

function resultValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

function resourceAccess(input: {
  readonly mediaType?: string;
  readonly filename?: string;
  readonly classification: ResourceClassification;
  readonly bytes: Uint8Array;
  readonly openError?: ResourceOriginUnavailable | ResourceTooLarge;
  readonly onOpen?: (maxBytes: number) => void;
}): Pick<ResourceAccess, "describe" | "open"> {
  const uri = "resource://r1_00000000000000000000000000000001" as const;
  return {
    describe: () =>
      Result.ok({
        uri,
        filename: input.filename ?? "attachment.bin",
        ...(input.mediaType === undefined ? {} : { declaredMediaType: input.mediaType }),
      }),
    open: async (_uri, options) => {
      input.onOpen?.(options.maxBytes);
      if (input.openError) return Result.err(input.openError);
      return Result.ok({
        descriptor: {
          uri,
          ...(input.mediaType === undefined ? {} : { declaredMediaType: input.mediaType }),
        },
        classification: input.classification,
        blob: {
          version: 1,
          objectId: "b1_00000000000000000000000000000000",
          sha256: "0".repeat(64),
          byteLength: input.bytes.byteLength,
        },
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(input.bytes);
            controller.close();
          },
        }),
        completion: Promise.resolve(
          Result.ok({ sha256: "0".repeat(64), byteLength: input.bytes.byteLength }),
        ),
      });
    },
  };
}

const storedImageResource = [
  {
    role: "user",
    content: [
      {
        type: "resource",
        uri: "resource://r1_00000000000000000000000000000001",
        filename: "image.png",
        mediaType: "image/png",
      },
    ],
  },
] satisfies StoredMessageV1[];

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

  it("keeps structured resource identity beside marker-only provider messages", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          {
            type: "resource",
            uri: "resource://r1_00000000000000000000000000000001",
            filename: "unsafe\nname.png",
            mediaType: "image/png",
            size: 321,
          },
        ],
      },
    ] satisfies StoredMessageV1[];
    const identityProjection = createStoredMessageIdentityProjectionV1();

    const materialized = resultValue(
      await materializeStoredMessagesV1({ messages, blobStore, identityProjection }),
    );

    expect(materialized).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          {
            type: "text",
            text: '[discord_attachment uri="resource://r1_00000000000000000000000000000001" filename="unsafe_name.png" mime="image/png" size=321]',
          },
        ],
      },
    ]);
    expect(resultValue(identityProjection.project(materialized))).toEqual(messages);
    expect(resultValue(projectStoredMessagesV1(materialized))).not.toEqual(messages);

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("adds verified byte-backed images for a capable AI SDK provider", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    let openedWith = 0;

    const materialized = resultValue(
      await materializeStoredMessagesV1({
        messages: storedImageResource,
        blobStore,
        resourceAccess: resourceAccess({
          bytes,
          mediaType: "image/png",
          classification: { kind: "image", mediaType: "image/png" },
          onOpen: (maxBytes) => {
            openedWith = maxBytes;
          },
        }),
        resourceTarget: { family: "ai-sdk", supportsImage: true, supportsPdf: true },
      }),
    );

    expect(openedWith).toBe(RESOURCE_MODEL_INLINE_MAX_BYTES);
    expect(materialized[0]?.content).toEqual([
      {
        type: "text",
        text: '[discord_attachment uri="resource://r1_00000000000000000000000000000001" filename="image.png" mime="image/png"]',
      },
      { type: "file", data: bytes, mediaType: "image/png", filename: "image.png" },
    ]);

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("keeps Claude PDFs marker-only with materialization guidance", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "resource",
            uri: "resource://r1_00000000000000000000000000000001",
            filename: "document.pdf",
            mediaType: "application/pdf",
          },
        ],
      },
    ] satisfies StoredMessageV1[];

    const materialized = resultValue(
      await materializeStoredMessagesV1({
        messages,
        blobStore,
        resourceAccess: resourceAccess({
          bytes: new TextEncoder().encode("%PDF-1.7"),
          mediaType: "application/pdf",
          classification: { kind: "pdf", mediaType: "application/pdf" },
        }),
        resourceTarget: { family: "claude-code", supportsImage: true, supportsPdf: false },
      }),
    );

    expect(materialized[0]?.content).toEqual([
      {
        type: "text",
        text: '[discord_attachment uri="resource://r1_00000000000000000000000000000001" filename="document.pdf" mime="application/pdf"]',
      },
      {
        type: "text",
        text: '[resource_inline_error uri="resource://r1_00000000000000000000000000000001" code="unsupported_provider"]',
      },
      {
        type: "text",
        text: "Use resource.materialize to write this resource into the working directory, transform it to a supported size or format, and then consume the transformed file.",
      },
    ]);

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("supports AI SDK PDFs and Claude images", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const pdfBytes = new TextEncoder().encode("%PDF-1.7");
    const pdfMessages = [
      {
        role: "user",
        content: [
          {
            type: "resource",
            uri: "resource://r1_00000000000000000000000000000001",
            mediaType: "application/pdf",
          },
        ],
      },
    ] satisfies StoredMessageV1[];
    const aiSdkPdf = resultValue(
      await materializeStoredMessagesV1({
        messages: pdfMessages,
        blobStore,
        resourceAccess: resourceAccess({
          bytes: pdfBytes,
          mediaType: "application/pdf",
          classification: { kind: "pdf", mediaType: "application/pdf" },
        }),
        resourceTarget: { family: "ai-sdk", supportsImage: true, supportsPdf: true },
      }),
    );
    const claudeImage = resultValue(
      await materializeStoredMessagesV1({
        messages: storedImageResource,
        blobStore,
        resourceAccess: resourceAccess({
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          mediaType: "image/png",
          classification: { kind: "image", mediaType: "image/png" },
        }),
        resourceTarget: { family: "claude-code", supportsImage: true, supportsPdf: false },
      }),
    );

    expect(aiSdkPdf[0]?.content).toContainEqual({
      type: "file",
      data: pdfBytes,
      mediaType: "application/pdf",
    });
    expect(claudeImage[0]?.content).toContainEqual({
      type: "file",
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mediaType: "image/png",
      filename: "image.png",
    });

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("turns expected resource open failures into marker guidance", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const openError = new ResourceTooLarge({
      uri: "resource://r1_00000000000000000000000000000001",
      limit: RESOURCE_MODEL_INLINE_MAX_BYTES,
      limitKind: "operation",
      reportedBytes: RESOURCE_MODEL_INLINE_MAX_BYTES + 1,
      message: "Resource exceeds the inline limit",
    });

    const materialized = resultValue(
      await materializeStoredMessagesV1({
        messages: storedImageResource,
        blobStore,
        resourceAccess: resourceAccess({
          bytes: new Uint8Array(),
          mediaType: "image/png",
          classification: { kind: "image", mediaType: "image/png" },
          openError,
        }),
        resourceTarget: { family: "ai-sdk", supportsImage: true, supportsPdf: true },
      }),
    );

    expect(materialized[0]?.content).toContainEqual({
      type: "text",
      text: `[resource_inline_error uri="resource://r1_00000000000000000000000000000001" code="too_large" limit=${RESOURCE_MODEL_INLINE_MAX_BYTES}]`,
    });

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("uses filenames only to skip known text before signature verification", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "resource",
            uri: "resource://r1_00000000000000000000000000000001",
            filename: "photo.PNG",
            mediaType: "application/octet-stream",
          },
        ],
      },
    ] satisfies StoredMessageV1[];
    let expected: string | undefined;
    const access = resourceAccess({
      filename: "photo.PNG",
      mediaType: "application/octet-stream",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      classification: { kind: "image", mediaType: "image/png" },
    });
    const observedAccess = {
      ...access,
      open: async (...args: Parameters<typeof access.open>) => {
        expected = args[1].expected;
        return await access.open(...args);
      },
    };

    const materialized = resultValue(
      await materializeStoredMessagesV1({
        messages,
        blobStore,
        resourceAccess: observedAccess,
        resourceTarget: { family: "ai-sdk", supportsImage: true, supportsPdf: true },
      }),
    );

    expect(expected).toBe("any");
    expect(materialized[0]?.content).toContainEqual({
      type: "file",
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mediaType: "image/png",
      filename: "photo.PNG",
    });

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("treats stored and declared media types as informational when bytes classify differently", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const access = resourceAccess({
      filename: "upload",
      mediaType: "application/pdf",
      bytes,
      classification: { kind: "image", mediaType: "image/png" },
    });
    let expected: string | undefined;
    const observedAccess = {
      ...access,
      open: async (...args: Parameters<typeof access.open>) => {
        expected = args[1].expected;
        return await access.open(...args);
      },
    };
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "resource",
            uri: "resource://r1_00000000000000000000000000000001",
            filename: "upload",
            mediaType: "application/pdf",
          },
        ],
      },
    ] satisfies StoredMessageV1[];

    const materialized = resultValue(
      await materializeStoredMessagesV1({
        messages,
        blobStore,
        resourceAccess: observedAccess,
        resourceTarget: { family: "ai-sdk", supportsImage: true, supportsPdf: true },
      }),
    );

    expect(expected).toBe("any");
    expect(materialized[0]?.content).toContainEqual({
      type: "file",
      data: bytes,
      mediaType: "image/png",
      filename: "upload",
    });

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("sniffs absent media metadata without relying on a filename extension", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    let expected: string | undefined;
    const access = resourceAccess({
      filename: "upload",
      bytes,
      classification: { kind: "image", mediaType: "image/png" },
    });
    const observedAccess = {
      ...access,
      open: async (...args: Parameters<typeof access.open>) => {
        expected = args[1].expected;
        return await access.open(...args);
      },
    };
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "resource",
            uri: "resource://r1_00000000000000000000000000000001",
            filename: "upload",
          },
        ],
      },
    ] satisfies StoredMessageV1[];

    const materialized = resultValue(
      await materializeStoredMessagesV1({
        messages,
        blobStore,
        resourceAccess: observedAccess,
        resourceTarget: { family: "ai-sdk", supportsImage: true, supportsPdf: true },
      }),
    );

    expect(expected).toBe("any");
    expect(materialized[0]?.content).toContainEqual({
      type: "file",
      data: bytes,
      mediaType: "image/png",
      filename: "upload",
    });

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("cancels sniffed text instead of consuming it into provider bytes", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const uri = "resource://r1_00000000000000000000000000000001" as const;
    let cancelled = false;
    const access: Pick<ResourceAccess, "describe" | "open"> = {
      describe: () => Result.ok({ uri, filename: "upload" }),
      open: async (_uri, options) => {
        expect(options.expected).toBe("any");
        return Result.ok({
          descriptor: { uri, filename: "upload" },
          classification: { kind: "text", mediaType: "text/plain", encoding: "utf-8" },
          blob: {
            version: 1,
            objectId: "b1_00000000000000000000000000000000",
            sha256: "0".repeat(64),
            byteLength: 10,
          },
          stream: new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          completion: Promise.resolve(Result.ok({ sha256: "0".repeat(64), byteLength: 10 })),
        });
      },
    };
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "resource",
            uri,
            filename: "upload",
          },
        ],
      },
    ] satisfies StoredMessageV1[];

    const materialized = resultValue(
      await materializeStoredMessagesV1({
        messages,
        blobStore,
        resourceAccess: access,
        resourceTarget: { family: "ai-sdk", supportsImage: true, supportsPdf: true },
      }),
    );

    expect(cancelled).toBe(true);
    expect(materialized[0]?.content).toEqual([
      {
        type: "text",
        text: '[discord_attachment uri="resource://r1_00000000000000000000000000000001" filename="upload"]',
      },
    ]);

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("keeps every previously missed text filename marker-only without provider fetching", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    let openCount = 0;
    for (const extension of [".cjs", ".cts", ".hpp", ".htm", ".jsonc", ".mdx", ".mts", ".svg"]) {
      const filename = `notes${extension}`;
      const access = resourceAccess({
        filename,
        bytes: new TextEncoder().encode("plain text"),
        classification: { kind: "text", mediaType: "text/plain", encoding: "utf-8" },
        onOpen: () => {
          openCount += 1;
        },
      });
      const messages = [
        {
          role: "user",
          content: [
            {
              type: "resource",
              uri: "resource://r1_00000000000000000000000000000001",
              filename,
            },
          ],
        },
      ] satisfies StoredMessageV1[];

      const materialized = resultValue(
        await materializeStoredMessagesV1({
          messages,
          blobStore,
          resourceAccess: access,
          resourceTarget: { family: "ai-sdk", supportsImage: true, supportsPdf: true },
        }),
      );
      expect(materialized[0]?.content).toEqual([
        {
          type: "text",
          text: `[discord_attachment uri="resource://r1_00000000000000000000000000000001" filename="${filename}"]`,
        },
      ]);
    }

    expect(openCount).toBe(0);

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });
});
