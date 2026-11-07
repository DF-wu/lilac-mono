import { describe, expect, it } from "bun:test";

import { InputFile } from "grammy";

import type { SurfaceAttachment, TelegramSessionRef } from "../../../src/surface/types";
import {
  deliverTelegramAttachments,
  shouldSendAsPhoto,
  telegramAttachmentIndexText,
  type TelegramAttachmentApi,
} from "../../../src/surface/telegram/output/telegram-attachment-delivery";

type RecordedCall = {
  method: "sendPhoto" | "sendDocument";
  chatId: number;
  filename: string | undefined;
  opts: { message_thread_id?: number; disable_notification?: boolean };
};

function recorder(): { api: TelegramAttachmentApi; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let nextId = 100;

  const record = (method: RecordedCall["method"]) => {
    return async (
      chatId: number,
      file: InputFile,
      opts: { message_thread_id?: number; disable_notification?: boolean },
    ) => {
      calls.push({ method, chatId, filename: file.filename, opts });
      nextId += 1;
      return { message_id: nextId };
    };
  };

  return {
    calls,
    api: { sendPhoto: record("sendPhoto"), sendDocument: record("sendDocument") },
  };
}

function attachment(overrides: Partial<SurfaceAttachment> = {}): SurfaceAttachment {
  return {
    kind: "image",
    mimeType: "image/png",
    filename: "chart.png",
    bytes: new Uint8Array([1, 2, 3]),
    ...overrides,
  };
}

const session: TelegramSessionRef = { platform: "telegram", channelId: "1001" };

describe("shouldSendAsPhoto", () => {
  it("accepts the image types Telegram renders inline", () => {
    for (const mimeType of ["image/jpeg", "image/png", "image/webp", "image/gif"]) {
      expect(shouldSendAsPhoto(attachment({ mimeType }))).toBe(true);
    }
  });

  it("is case-insensitive about the mime type", () => {
    expect(shouldSendAsPhoto(attachment({ mimeType: "IMAGE/PNG" }))).toBe(true);
  });

  it("falls back to a document for images Telegram cannot render", () => {
    // sendPhoto rejects SVG outright, so it must not be attempted.
    expect(shouldSendAsPhoto(attachment({ mimeType: "image/svg+xml" }))).toBe(false);
  });

  it("never treats a file as a photo", () => {
    expect(shouldSendAsPhoto(attachment({ kind: "file", mimeType: "image/png" }))).toBe(false);
  });
});

describe("deliverTelegramAttachments", () => {
  it("does nothing when there is nothing to send", async () => {
    const { api, calls } = recorder();

    const delivery = await deliverTelegramAttachments({
      api,
      sessionRef: session,
      attachments: [],
      silent: false,
    });

    expect(delivery).toEqual({ uploaded: [] });
    expect(calls).toHaveLength(0);
  });

  it("uploads an image via sendPhoto and returns its ref", async () => {
    const { api, calls } = recorder();

    const delivery = await deliverTelegramAttachments({
      api,
      sessionRef: session,
      attachments: [attachment()],
      silent: false,
    });

    expect(calls).toMatchObject([{ method: "sendPhoto", chatId: 1001, filename: "chart.png" }]);
    expect(delivery.failure).toBeUndefined();
    expect(delivery.uploaded).toEqual([
      {
        ref: { platform: "telegram", channelId: "1001", messageId: "101" },
        messageId: 101,
        attachment: attachment(),
      },
    ]);
  });

  it("uploads a non-image via sendDocument", async () => {
    const { api, calls } = recorder();

    await deliverTelegramAttachments({
      api,
      sessionRef: session,
      attachments: [
        attachment({ kind: "file", mimeType: "application/pdf", filename: "report.pdf" }),
      ],
      silent: false,
    });

    expect(calls).toMatchObject([{ method: "sendDocument", filename: "report.pdf" }]);
  });

  it("preserves order across mixed attachment kinds", async () => {
    const { api, calls } = recorder();

    await deliverTelegramAttachments({
      api,
      sessionRef: session,
      attachments: [
        attachment({ filename: "a.png" }),
        attachment({ kind: "file", mimeType: "text/csv", filename: "b.csv" }),
        attachment({ filename: "c.png" }),
      ],
      silent: false,
    });

    expect(calls.map((c) => c.filename)).toEqual(["a.png", "b.csv", "c.png"]);
    expect(calls.map((c) => c.method)).toEqual(["sendPhoto", "sendDocument", "sendPhoto"]);
  });

  it("targets the forum topic when the session has one", async () => {
    const { api, calls } = recorder();

    await deliverTelegramAttachments({
      api,
      sessionRef: { platform: "telegram", channelId: "-1001234567890:7" },
      attachments: [attachment()],
      silent: false,
    });

    expect(calls[0]).toMatchObject({
      chatId: -1_001_234_567_890,
      opts: { message_thread_id: 7 },
    });
  });

  it("suppresses notifications when the stream is silent", async () => {
    const { api, calls } = recorder();

    await deliverTelegramAttachments({
      api,
      sessionRef: session,
      attachments: [attachment()],
      silent: true,
    });

    expect(calls[0]?.opts.disable_notification).toBe(true);
  });

  it("omits disable_notification when not silent", async () => {
    const { api, calls } = recorder();

    await deliverTelegramAttachments({
      api,
      sessionRef: session,
      attachments: [attachment()],
      silent: false,
    });

    expect(calls[0]?.opts.disable_notification).toBeUndefined();
  });
});

describe("deliverTelegramAttachments partial success", () => {
  /** Fails the nth upload (1-based) and succeeds on every other one. */
  function failingAt(n: number): { api: TelegramAttachmentApi; calls: string[] } {
    const calls: string[] = [];
    let attempt = 0;
    let nextId = 200;

    const send = async (_chatId: number, file: InputFile) => {
      attempt += 1;
      calls.push(file.filename ?? "?");
      if (attempt === n) throw new Error(`upload ${n} failed`);
      nextId += 1;
      return { message_id: nextId };
    };

    return { calls, api: { sendPhoto: send, sendDocument: send } };
  }

  it("keeps the refs of uploads that already reached Telegram", async () => {
    // Upload 1 is visible in the chat whatever happens next. Dropping its ref
    // would leave a message no reply could ever resolve against.
    const { api } = failingAt(2);

    const delivery = await deliverTelegramAttachments({
      api,
      sessionRef: session,
      attachments: [attachment({ filename: "a.png" }), attachment({ filename: "b.png" })],
      silent: false,
    });

    expect(delivery.uploaded).toHaveLength(1);
    expect(delivery.uploaded[0]?.ref).toEqual({
      platform: "telegram",
      channelId: "1001",
      messageId: "201",
    });
    expect(delivery.uploaded[0]?.attachment.filename).toBe("a.png");
  });

  it("reports which attachment stopped the run", async () => {
    const { api } = failingAt(2);

    const delivery = await deliverTelegramAttachments({
      api,
      sessionRef: session,
      attachments: [attachment({ filename: "a.png" }), attachment({ filename: "b.png" })],
      silent: false,
    });

    expect(delivery.failure?.attachment?.filename).toBe("b.png");
    expect(delivery.failure?.error.error).toBeInstanceOf(Error);
  });

  it("does not attempt the attachments queued behind a failure", async () => {
    // A gap in the middle (1 and 3 delivered, 2 missing) reads as corruption;
    // a truncated prefix reads as an interruption, which is what happened.
    const { api, calls } = failingAt(2);

    const delivery = await deliverTelegramAttachments({
      api,
      sessionRef: session,
      attachments: [
        attachment({ filename: "a.png" }),
        attachment({ filename: "b.png" }),
        attachment({ filename: "c.png" }),
      ],
      silent: false,
    });

    expect(calls).toEqual(["a.png", "b.png"]);
    expect(delivery.uploaded.map((u) => u.attachment.filename)).toEqual(["a.png"]);
  });

  it("reports a first-upload failure with nothing uploaded", async () => {
    const { api } = failingAt(1);

    const delivery = await deliverTelegramAttachments({
      api,
      sessionRef: session,
      attachments: [attachment()],
      silent: false,
    });

    expect(delivery.uploaded).toEqual([]);
    expect(delivery.failure).toBeDefined();
  });

  it("never throws, so a delivered text reply is not lost to an upload fault", async () => {
    const { api } = failingAt(1);

    // The assertion is that the call resolves at all.
    await expect(
      deliverTelegramAttachments({
        api,
        sessionRef: session,
        attachments: [attachment()],
        silent: false,
      }),
    ).resolves.toBeDefined();
  });
});

describe("telegramAttachmentIndexText", () => {
  it("labels an image by kind and filename", () => {
    expect(telegramAttachmentIndexText(attachment({ filename: "chart.png" }))).toBe(
      "[image] chart.png",
    );
  });

  it("labels a file by kind and filename", () => {
    expect(telegramAttachmentIndexText(attachment({ kind: "file", filename: "report.pdf" }))).toBe(
      "[file] report.pdf",
    );
  });

  it("is never empty, so an indexed attachment is distinguishable from a blank message", () => {
    expect(telegramAttachmentIndexText(attachment({ filename: "" })).trim()).not.toBe("");
  });
});
