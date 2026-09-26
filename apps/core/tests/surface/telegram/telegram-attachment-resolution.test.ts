import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { EvtAdapterMessageCreatedData } from "@stanley2058/lilac-event-bus";
import type { Message, Update } from "grammy/types";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils/core-config/v2";
import type { CoreConfig } from "@stanley2058/lilac-utils";

import { hasSurfaceAttachmentResolver } from "../../../src/surface/adapter";
import { TelegramAdapter } from "../../../src/surface/telegram/telegram-adapter";
import { composeTelegramMessages } from "../../../src/surface/telegram/telegram-request-router-composition";
import type { AdapterEvent } from "../../../src/surface/events";
import { FakeBotApiServer } from "./fake-bot-api-server";
import { makeMessage } from "./telegram-fixtures";

const ALLOWED_CHAT = 1001;
const FAKE_TOKEN = "000000:fake-token";

function inboundMessage(overrides: Partial<Message> = {}): NonNullable<Update["message"]> {
  return makeMessage(overrides) as NonNullable<Update["message"]>;
}

const PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+9n0AAAAASUVORK5CYII=",
  ),
  (char) => char.charCodeAt(0),
);

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
const UNKNOWN_BINARY_BYTES = Uint8Array.from([0, 0xff, 0xfe, 0xfd]);

let server: FakeBotApiServer;
let adapter: TelegramAdapter | null = null;
let scratchDir = "";

function testConfig(telegram: Record<string, unknown> = {}): CoreConfig {
  const cfg = parseCoreConfigV2ToUniversal({
    configVersion: 2,
    surface: {
      telegram: {
        enabled: true,
        token: FAKE_TOKEN,
        botName: "lilac",
        allowedChatIds: [String(ALLOWED_CHAT)],
        dbPath: path.join(scratchDir, "telegram.db"),
        ...telegram,
      },
    },
  });
  return { ...cfg, agent: { ...cfg.agent, systemPrompt: "(test)" } };
}

async function connectAdapter(cfg: CoreConfig): Promise<TelegramAdapter> {
  const created = new TelegramAdapter({
    apiRoot: server.url,
    getConfig: async () => cfg,
  });
  await created.connect();
  await created.whenReady();
  adapter = created;
  return created;
}

beforeEach(async () => {
  server = new FakeBotApiServer();
  scratchDir = await mkdtemp(path.join(tmpdir(), "lilac-telegram-media-"));
});

afterEach(async () => {
  await adapter?.disconnect();
  adapter = null;
  await server.close();
  await rm(scratchDir, { force: true, recursive: true });
});

describe("TelegramAdapter.resolveAttachment", () => {
  it("resolves bytes via getFile and an authenticated download, sniffing the type", async () => {
    const connected = await connectAdapter(testConfig());
    server.setFile({ fileId: "photo-1", filePath: "photos/photo-1.jpg", bytes: PNG_BYTES });

    const resolved = await connected.resolveAttachment(
      { platform: "telegram", fileId: "photo-1", mimeType: "image/jpeg" },
      { maxBytes: 1024 },
    );

    const value = resolved.unwrap();
    expect(value.mediaType).toBe("image/png");
    expect([...value.bytes]).toEqual([...PNG_BYTES]);
    expect(server.callsOf("getFile")).toHaveLength(1);
    expect(server.callsOf("downloadFile")).toEqual([
      { method: "downloadFile", params: { file_path: "photos/photo-1.jpg" } },
    ]);
  });

  it("downloads a small body when the attachment ref overdeclares its size", async () => {
    const connected = await connectAdapter(testConfig());
    server.setFile({ fileId: "big-1", filePath: "documents/big-1.bin", bytes: PNG_BYTES });

    const resolved = await connected.resolveAttachment(
      { platform: "telegram", fileId: "big-1", size: 2048 },
      { maxBytes: 1024 },
    );

    expect([...resolved.unwrap().bytes]).toEqual([...PNG_BYTES]);
    expect(server.callsOf("getFile")).toHaveLength(1);
    expect(server.callsOf("downloadFile")).toHaveLength(1);
  });

  it("downloads a small body when getFile overdeclares its size", async () => {
    const connected = await connectAdapter(testConfig());
    server.setFile({
      fileId: "big-2",
      filePath: "documents/big-2.bin",
      bytes: PNG_BYTES,
      declaredSize: 5 * 1024 * 1024,
    });

    const resolved = await connected.resolveAttachment(
      { platform: "telegram", fileId: "big-2" },
      { maxBytes: 1024 },
    );

    expect([...resolved.unwrap().bytes]).toEqual([...PNG_BYTES]);
    expect(server.callsOf("downloadFile")).toHaveLength(1);
  });

  it("delivers a sniffed image despite hostile declared metadata", async () => {
    const connected = await connectAdapter(testConfig());
    server.setFile({ fileId: "spoof-image", filePath: "documents/archive.zip", bytes: PNG_BYTES });

    const resolved = await connected.resolveAttachment(
      {
        platform: "telegram",
        fileId: "spoof-image",
        filename: "archive.zip",
        mimeType: "application/zip",
      },
      { maxBytes: 1024 },
    );

    expect(resolved.unwrap().mediaType).toBe("image/png");
    expect(server.callsOf("downloadFile")).toHaveLength(1);
  });

  it("delivers a sniffed PDF despite hostile declared metadata", async () => {
    const connected = await connectAdapter(testConfig());
    server.setFile({ fileId: "spoof-pdf", filePath: "documents/photo.jpg", bytes: PDF_BYTES });

    const resolved = await connected.resolveAttachment(
      {
        platform: "telegram",
        fileId: "spoof-pdf",
        filename: "photo.jpg",
        mimeType: "image/jpeg",
      },
      { maxBytes: 1024 },
    );

    expect(resolved.unwrap().mediaType).toBe("application/pdf");
    expect(server.callsOf("downloadFile")).toHaveLength(1);
  });

  it("does not classify unknown binary bytes from a declared image MIME type", async () => {
    const connected = await connectAdapter(testConfig());
    server.setFile({
      fileId: "spoof-declared-image",
      filePath: "documents/spoof-declared-image.bin",
      bytes: UNKNOWN_BINARY_BYTES,
    });

    const resolved = await connected.resolveAttachment(
      { platform: "telegram", fileId: "spoof-declared-image", mimeType: "image/png" },
      { maxBytes: 1024 },
    );

    expect(resolved.unwrap().mediaType).toBeUndefined();
    expect(server.callsOf("downloadFile")).toHaveLength(1);
  });

  it("does not classify unknown binary bytes from a declared text MIME type", async () => {
    const connected = await connectAdapter(testConfig());
    server.setFile({
      fileId: "spoof-declared-text",
      filePath: "documents/spoof-declared-text.bin",
      bytes: UNKNOWN_BINARY_BYTES,
    });

    const resolved = await connected.resolveAttachment(
      { platform: "telegram", fileId: "spoof-declared-text", mimeType: "text/plain" },
      { maxBytes: 1024 },
    );

    expect(resolved.unwrap().mediaType).toBeUndefined();
    expect(server.callsOf("downloadFile")).toHaveLength(1);
  });

  it("does not classify unknown binary bytes from the filename", async () => {
    const connected = await connectAdapter(testConfig());
    server.setFile({
      fileId: "spoof-filename",
      filePath: "documents/spoof-filename.bin",
      bytes: UNKNOWN_BINARY_BYTES,
    });

    const resolved = await connected.resolveAttachment(
      { platform: "telegram", fileId: "spoof-filename", filename: "photo.png" },
      { maxBytes: 1024 },
    );

    expect(resolved.unwrap().mediaType).toBeUndefined();
    expect(server.callsOf("downloadFile")).toHaveLength(1);
  });

  it("does not classify unknown binary bytes from the HTTP Content-Type", async () => {
    const connected = await connectAdapter(testConfig());
    server.setFile({
      fileId: "spoof-http-type",
      filePath: "documents/spoof-http-type.bin",
      bytes: UNKNOWN_BINARY_BYTES,
      contentType: "image/png",
    });

    const resolved = await connected.resolveAttachment(
      { platform: "telegram", fileId: "spoof-http-type" },
      { maxBytes: 1024 },
    );

    expect(resolved.unwrap().mediaType).toBeUndefined();
    expect(server.callsOf("downloadFile")).toHaveLength(1);
  });

  it("leaves unknown valid UTF-8 unclassified despite hostile declared metadata", async () => {
    const connected = await connectAdapter(testConfig());
    server.setFile({
      fileId: "unknown-text",
      filePath: "documents/archive.zip",
      bytes: new TextEncoder().encode("alpha: 1\n"),
    });

    const resolved = await connected.resolveAttachment(
      {
        platform: "telegram",
        fileId: "unknown-text",
        filename: "archive.zip",
        mimeType: "application/zip",
      },
      { maxBytes: 1024 },
    );

    expect(resolved.unwrap().mediaType).toBeUndefined();
    expect(server.callsOf("downloadFile")).toHaveLength(1);
  });

  it("aborts mid-download when the declared size lies", async () => {
    const connected = await connectAdapter(testConfig());
    // Telegram claims the file is tiny; the body is much larger than the cap.
    server.setFile({
      fileId: "liar-1",
      filePath: "documents/liar-1.bin",
      bytes: new Uint8Array(64 * 1024),
      declaredSize: 16,
    });

    const resolved = await connected.resolveAttachment(
      { platform: "telegram", fileId: "liar-1" },
      { maxBytes: 1024 },
    );

    expect(resolved.match({ ok: () => "", err: (error) => error._tag })).toBe(
      "SurfaceAttachmentTooLarge",
    );
    expect(server.callsOf("downloadFile")).toHaveLength(1);
  });

  it("aborts mid-download when getFile reports no size at all", async () => {
    const connected = await connectAdapter(testConfig());
    server.setFile({
      fileId: "nosize-1",
      filePath: "documents/nosize-1.bin",
      bytes: new Uint8Array(64 * 1024),
      declaredSize: null,
    });

    const resolved = await connected.resolveAttachment(
      { platform: "telegram", fileId: "nosize-1" },
      { maxBytes: 1024 },
    );

    expect(resolved.match({ ok: () => "", err: (error) => error._tag })).toBe(
      "SurfaceAttachmentTooLarge",
    );
  });

  it("keeps the bot token out of download failure messages", async () => {
    const connected = await connectAdapter(testConfig());
    // No file registered: getFile falls back to the stub path and the download 404s.

    const resolved = await connected.resolveAttachment(
      { platform: "telegram", fileId: "missing-1" },
      { maxBytes: 1024 },
    );

    const message = resolved.match({ ok: () => "", err: (error) => error.message });
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(FAKE_TOKEN);
    expect(message).not.toContain("/bot0");
  });
});

describe("composeTelegramMessages with inbound media", () => {
  async function deliverPhotoMessage(connected: TelegramAdapter): Promise<{
    event: EvtAdapterMessageCreatedData;
  }> {
    const events: AdapterEvent[] = [];
    const created = new Promise<AdapterEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), 10_000);
      void connected.subscribe((evt) => {
        events.push(evt);
        if (evt.type === "adapter.message.created") {
          clearTimeout(timer);
          resolve(evt);
        }
      });
    });

    server.setFile({ fileId: "photo-large", filePath: "photos/large.jpg", bytes: PNG_BYTES });
    server.enqueueMessage(
      inboundMessage({
        text: undefined,
        photo: [
          { file_id: "photo-small", file_unique_id: "s", width: 90, height: 90 },
          { file_id: "photo-large", file_unique_id: "l", width: 800, height: 600 },
        ],
      }),
    );

    const evt = await created;
    if (evt.type !== "adapter.message.created") throw new Error("unexpected event");
    return {
      event: {
        platform: "telegram",
        channelId: evt.message.session.channelId,
        messageId: evt.message.ref.messageId,
        userId: evt.message.userId,
        text: evt.message.text,
        ts: evt.message.ts,
        raw: evt.message.raw,
      },
    };
  }

  it("delivers an uncaptioned photo as a base64 file part with no token anywhere", async () => {
    const cfg = testConfig();
    const connected = await connectAdapter(cfg);
    expect(hasSurfaceAttachmentResolver(connected)).toBe(true);

    const { event } = await deliverPhotoMessage(connected);
    const composed = await composeTelegramMessages({
      adapter: connected,
      event,
      botUserId: "8792842071",
      botNames: ["lilac"],
      inboundMedia: cfg.surface.telegram.inboundMedia,
    });

    expect(composed.mediaDelivered).toBe(true);
    const last = composed.messages.at(-1);
    if (!last || typeof last.content === "string" || !Array.isArray(last.content)) {
      throw new Error("expected part-based user content");
    }
    const fileParts = last.content.filter((part) => part.type === "file");
    expect(fileParts).toEqual([
      {
        type: "file",
        data: Buffer.from(PNG_BYTES).toString("base64"),
        mediaType: "image/png",
        providerOptions: {
          lilac: {
            transient: {
              version: 1,
              source: "telegram-inbound-file",
            },
          },
        },
      },
    ]);

    const serialized = JSON.stringify(composed.messages);
    expect(serialized).not.toContain(FAKE_TOKEN);
    expect(serialized).not.toContain("api.telegram.org");
    expect(serialized).not.toContain(server.url);
  });

  it("re-resolves historical media from the stored raw envelope", async () => {
    const cfg = testConfig();
    const connected = await connectAdapter(cfg);
    const { event } = await deliverPhotoMessage(connected);

    // Compose twice: the second run re-reads the message from the local store
    // (raw_json) and must re-resolve the same file_id, as it would after the
    // temporary file_path expired and a fresh one was issued.
    await composeTelegramMessages({
      adapter: connected,
      event,
      botUserId: "8792842071",
      botNames: ["lilac"],
      inboundMedia: cfg.surface.telegram.inboundMedia,
    });
    const again = await composeTelegramMessages({
      adapter: connected,
      event,
      botUserId: "8792842071",
      botNames: ["lilac"],
      inboundMedia: cfg.surface.telegram.inboundMedia,
    });

    expect(again.mediaDelivered).toBe(true);
    expect(server.callsOf("getFile").length).toBeGreaterThanOrEqual(2);
    expect(server.callsOf("downloadFile").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps caption-only behavior when inbound media is disabled", async () => {
    const cfg = testConfig({ inboundMedia: { enabled: false } });
    const connected = await connectAdapter(cfg);

    // With delivery disabled the guard drops uncaptioned media, so use a
    // captioned photo: it must still route, with the media absent.
    const events: AdapterEvent[] = [];
    const created = new Promise<AdapterEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), 10_000);
      void connected.subscribe((evt) => {
        events.push(evt);
        if (evt.type === "adapter.message.created") {
          clearTimeout(timer);
          resolve(evt);
        }
      });
    });
    server.enqueueMessage(
      inboundMessage({
        text: undefined,
        caption: "look at this",
        photo: [{ file_id: "photo-large", file_unique_id: "l", width: 800, height: 600 }],
      }),
    );
    const evt = await created;
    if (evt.type !== "adapter.message.created") throw new Error("unexpected event");

    const composed = await composeTelegramMessages({
      adapter: connected,
      event: {
        platform: "telegram",
        channelId: evt.message.session.channelId,
        messageId: evt.message.ref.messageId,
        userId: evt.message.userId,
        text: evt.message.text,
        ts: evt.message.ts,
        raw: evt.message.raw,
      },
      botUserId: "8792842071",
      botNames: ["lilac"],
      inboundMedia: cfg.surface.telegram.inboundMedia,
    });

    expect(composed.mediaDelivered).toBe(false);
    expect(server.callsOf("getFile")).toHaveLength(0);
    const last = composed.messages.at(-1);
    expect(typeof last?.content).toBe("string");
    expect(String(last?.content)).toContain("look at this");
  });
});
