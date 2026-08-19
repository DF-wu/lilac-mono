import { describe, expect, it } from "bun:test";
import { Result } from "better-result";

import type { UserContent } from "ai";

import {
  SurfaceAttachmentTooLarge,
  SurfaceUnavailable,
  type ResolvedSurfaceAttachment,
  type SurfaceAttachmentRef,
  type SurfaceAttachmentResolver,
} from "../../../src/surface/adapter";
import {
  appendTelegramMediaToUserContent,
  createTelegramInboundMediaBudget,
  formatTelegramAttachmentMarker,
  telegramInboundMedia,
  telegramInboundMediaFromRaw,
  type TelegramInboundMediaRef,
} from "../../../src/surface/telegram/telegram-inbound-media";
import { toTelegramRawEnvelope } from "../../../src/surface/telegram/telegram-raw";
import { makeMessage } from "./telegram-fixtures";

const PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+9n0AAAAASUVORK5CYII=",
  ),
  (char) => char.charCodeAt(0),
);

type ResolveCall = { ref: SurfaceAttachmentRef; maxBytes: number };

function stubResolver(input: {
  results?: ReadonlyMap<
    string,
    Awaited<ReturnType<SurfaceAttachmentResolver["resolveAttachment"]>>
  >;
  fallback?: ResolvedSurfaceAttachment;
}): SurfaceAttachmentResolver & { calls: ResolveCall[] } {
  const calls: ResolveCall[] = [];
  return {
    calls,
    resolveAttachment: async (ref, opts) => {
      calls.push({ ref, maxBytes: opts.maxBytes });
      const programmed = input.results?.get(ref.fileId);
      if (programmed) return programmed;
      return Result.ok(
        input.fallback ?? { kind: "bytes" as const, bytes: PNG_BYTES, mediaType: "image/png" },
      );
    },
  };
}

function budget(perAttachment: number, perRequest: number) {
  return createTelegramInboundMediaBudget({
    maxBytesPerAttachment: perAttachment,
    maxBytesPerRequest: perRequest,
  });
}

describe("telegramInboundMedia", () => {
  it("picks the largest photo size", () => {
    const message = makeMessage({
      text: undefined,
      caption: "pic",
      photo: [
        { file_id: "small", file_unique_id: "s", width: 90, height: 90, file_size: 100 },
        { file_id: "large", file_unique_id: "l", width: 800, height: 600, file_size: 5000 },
        { file_id: "medium", file_unique_id: "m", width: 320, height: 240 },
      ],
    });

    expect(telegramInboundMedia(message)).toEqual([
      { kind: "photo", fileId: "large", mimeType: "image/jpeg", size: 5000 },
    ]);
  });

  it("extracts document metadata", () => {
    const message = makeMessage({
      text: undefined,
      caption: "doc",
      document: {
        file_id: "doc-1",
        file_unique_id: "d",
        file_name: "report.pdf",
        mime_type: "application/pdf",
        file_size: 1234,
      },
    });

    expect(telegramInboundMedia(message)).toEqual([
      {
        kind: "document",
        fileId: "doc-1",
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 1234,
      },
    ]);
  });

  it("extracts voice metadata without a filename", () => {
    const message = makeMessage({
      text: undefined,
      voice: { file_id: "v-1", file_unique_id: "v", duration: 3, mime_type: "audio/ogg" },
    });

    expect(telegramInboundMedia(message)).toEqual([
      { kind: "voice", fileId: "v-1", mimeType: "audio/ogg" },
    ]);
  });
});

describe("telegramInboundMediaFromRaw", () => {
  it("round-trips media through the published raw envelope", () => {
    const message = makeMessage({
      text: undefined,
      caption: "pic",
      photo: [
        { file_id: "small", file_unique_id: "s", width: 90, height: 90 },
        { file_id: "large", file_unique_id: "l", width: 800, height: 600 },
      ],
    });
    const raw: unknown = JSON.parse(JSON.stringify(toTelegramRawEnvelope({ message })));

    expect(telegramInboundMediaFromRaw({ raw })).toEqual([
      { kind: "photo", fileId: "large", mimeType: "image/jpeg" },
    ]);
  });

  it("returns nothing for non-telegram raw values", () => {
    expect(telegramInboundMediaFromRaw({})).toEqual([]);
    expect(telegramInboundMediaFromRaw({ raw: { discord: {} } })).toEqual([]);
    expect(telegramInboundMediaFromRaw({ raw: "junk" })).toEqual([]);
  });
});

describe("appendTelegramMediaToUserContent", () => {
  it("delivers a photo as a base64 file part", async () => {
    const resolver = stubResolver({});
    const parts: Exclude<UserContent, string> = [];

    await appendTelegramMediaToUserContent({
      parts,
      media: [{ kind: "photo", fileId: "p-1", mimeType: "image/jpeg" }],
      resolver,
      budget: budget(1024, 4096),
    });

    expect(parts).toEqual([
      {
        type: "file",
        data: Buffer.from(PNG_BYTES).toString("base64"),
        mediaType: "image/png",
      },
    ]);
    expect(resolver.calls).toEqual([
      { ref: { platform: "telegram", fileId: "p-1", mimeType: "image/jpeg" }, maxBytes: 1024 },
    ]);
  });

  it("delivers a PDF document as a file part with its filename", async () => {
    const resolver = stubResolver({
      fallback: { kind: "bytes", bytes: PNG_BYTES, mediaType: "application/pdf" },
    });
    const parts: Exclude<UserContent, string> = [];

    await appendTelegramMediaToUserContent({
      parts,
      media: [
        {
          kind: "document",
          fileId: "d-1",
          filename: "report.pdf",
          mimeType: "application/pdf",
        },
      ],
      resolver,
      budget: budget(1024, 4096),
    });

    expect(parts).toEqual([
      {
        type: "file",
        data: Buffer.from(PNG_BYTES).toString("base64"),
        mediaType: "application/pdf",
        filename: "report.pdf",
      },
    ]);
  });

  it("inlines a text-extractable document with its marker header", async () => {
    const text = "alpha: 1\nbeta: 2\n";
    const resolver = stubResolver({
      fallback: {
        kind: "bytes",
        bytes: new TextEncoder().encode(text),
        mediaType: "text/plain",
      },
    });
    const parts: Exclude<UserContent, string> = [];
    const ref: TelegramInboundMediaRef = {
      kind: "document",
      fileId: "d-2",
      filename: "config.txt",
      mimeType: "text/plain",
      size: text.length,
    };

    await appendTelegramMediaToUserContent({
      parts,
      media: [ref],
      resolver,
      budget: budget(1024, 4096),
    });

    expect(parts).toEqual([
      { type: "text", text: `${formatTelegramAttachmentMarker(ref)}\n${text}` },
    ]);
  });

  it("degrades voice, audio and video to markers without resolving", async () => {
    const resolver = stubResolver({});
    const parts: Exclude<UserContent, string> = [];
    const media: TelegramInboundMediaRef[] = [
      { kind: "voice", fileId: "v-1", mimeType: "audio/ogg", size: 900 },
      { kind: "audio", fileId: "a-1", filename: "song.mp3", mimeType: "audio/mpeg" },
      { kind: "video", fileId: "vid-1", mimeType: "video/mp4" },
    ];

    await appendTelegramMediaToUserContent({
      parts,
      media,
      resolver,
      budget: budget(1024, 4096),
    });

    expect(resolver.calls).toEqual([]);
    expect(parts).toEqual(
      media.map((ref) => ({
        type: "text",
        text: `${formatTelegramAttachmentMarker(ref)}\n(unsupported media type; not delivered)`,
      })),
    );
  });

  it("degrades an unsupported binary document to a marker without resolving", async () => {
    const resolver = stubResolver({});
    const parts: Exclude<UserContent, string> = [];
    const ref: TelegramInboundMediaRef = {
      kind: "document",
      fileId: "d-3",
      filename: "backup.zip",
      mimeType: "application/zip",
    };

    await appendTelegramMediaToUserContent({
      parts,
      media: [ref],
      resolver,
      budget: budget(1024, 4096),
    });

    expect(resolver.calls).toEqual([]);
    expect(parts).toEqual([
      {
        type: "text",
        text: `${formatTelegramAttachmentMarker(ref)}\n(unsupported media type; not delivered)`,
      },
    ]);
  });

  it("marks an attachment the resolver rejects as too large", async () => {
    const resolver = stubResolver({
      results: new Map([
        [
          "p-1",
          Result.err(
            new SurfaceAttachmentTooLarge({
              platform: "telegram",
              maxBytes: 16,
              message: "too big",
            }),
          ),
        ],
      ]),
    });
    const parts: Exclude<UserContent, string> = [];
    const ref: TelegramInboundMediaRef = { kind: "photo", fileId: "p-1", mimeType: "image/jpeg" };

    await appendTelegramMediaToUserContent({
      parts,
      media: [ref],
      resolver,
      budget: budget(16, 4096),
    });

    expect(parts).toEqual([
      {
        type: "text",
        text: `${formatTelegramAttachmentMarker(ref)}\n(media exceeds the inbound media limit; not delivered)`,
      },
    ]);
  });

  it("marks an unavailable attachment without failing composition", async () => {
    const resolver = stubResolver({
      results: new Map([
        [
          "p-1",
          Result.err(
            new SurfaceUnavailable({
              platform: "telegram",
              operation: "resolve-attachment",
              message: "download failed",
            }),
          ),
        ],
      ]),
    });
    const parts: Exclude<UserContent, string> = [];
    const ref: TelegramInboundMediaRef = { kind: "photo", fileId: "p-1", mimeType: "image/jpeg" };

    await appendTelegramMediaToUserContent({
      parts,
      media: [ref],
      resolver,
      budget: budget(1024, 4096),
    });

    expect(parts).toEqual([
      {
        type: "text",
        text: `${formatTelegramAttachmentMarker(ref)}\n(media unavailable; not delivered)`,
      },
    ]);
  });

  it("spans one request budget across attachments and degrades past it", async () => {
    const resolver = stubResolver({});
    const parts: Exclude<UserContent, string> = [];
    const first: TelegramInboundMediaRef = { kind: "photo", fileId: "p-1", mimeType: "image/jpeg" };
    const second: TelegramInboundMediaRef = {
      kind: "photo",
      fileId: "p-2",
      mimeType: "image/jpeg",
    };

    // Request budget covers exactly one resolved photo.
    await appendTelegramMediaToUserContent({
      parts,
      media: [first, second],
      resolver,
      budget: budget(PNG_BYTES.byteLength, PNG_BYTES.byteLength),
    });

    expect(resolver.calls.map((call) => call.ref.fileId)).toEqual(["p-1"]);
    expect(parts).toEqual([
      {
        type: "file",
        data: Buffer.from(PNG_BYTES).toString("base64"),
        mediaType: "image/png",
      },
      {
        type: "text",
        text: `${formatTelegramAttachmentMarker(second)}\n(inbound media budget exhausted; not delivered)`,
      },
    ]);
  });

  it("caps each resolve at the smaller of the per-attachment and remaining budget", async () => {
    const resolver = stubResolver({
      fallback: { kind: "bytes", bytes: new Uint8Array(8), mediaType: "image/png" },
    });
    const parts: Exclude<UserContent, string> = [];

    await appendTelegramMediaToUserContent({
      parts,
      media: [
        { kind: "photo", fileId: "p-1", mimeType: "image/jpeg" },
        { kind: "photo", fileId: "p-2", mimeType: "image/jpeg" },
      ],
      resolver,
      budget: budget(100, 105),
    });

    expect(resolver.calls.map((call) => call.maxBytes)).toEqual([100, 97]);
  });
});
