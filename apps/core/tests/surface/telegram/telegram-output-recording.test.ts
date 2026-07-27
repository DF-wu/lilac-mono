import { describe, expect, it } from "bun:test";

import type { SurfaceAttachment, TelegramSessionRef } from "../../../src/surface/types";
import type { SurfaceOutputResult } from "../../../src/surface/adapter";
import {
  TelegramOutputStreamWithAttachments,
  type TelegramAttachmentApi,
  type TelegramDeliverableStream,
} from "../../../src/surface/telegram/output/telegram-attachment-delivery";

const session: TelegramSessionRef = { platform: "telegram", channelId: "1001" };

const RESULT: SurfaceOutputResult = {
  created: [{ platform: "telegram", channelId: "1001", messageId: "7" }],
  last: { platform: "telegram", channelId: "1001", messageId: "7" },
};

/**
 * A stand-in for the real stream. Only the three members the wrapper touches
 * after `finish()` matter here, so this stays a structural double rather than a
 * full fake of the streaming state machine.
 */
function fakeStream(input: {
  delivered?: { messageId: number; text: string }[];
  attachments?: SurfaceAttachment[];
  deliveredThrows?: boolean;
}): TelegramDeliverableStream {
  const stream: TelegramDeliverableStream = {
    finish: async () => RESULT,
    getDeliveredMessages: () => {
      if (input.deliveredThrows) throw new Error("index unavailable");
      return input.delivered ?? [];
    },
    takePendingAttachments: () => input.attachments ?? [],
    push: async () => undefined,
    abort: async () => undefined,
    getFinalTextMode: () => "full" as const,
  };

  return stream;
}

const noopApi: TelegramAttachmentApi = {
  sendPhoto: async () => ({ message_id: 1 }),
  sendDocument: async () => ({ message_id: 1 }),
};

function wrap(
  stream: TelegramDeliverableStream,
  overrides: Partial<{
    onDelivered: (m: readonly { messageId: number; text: string }[]) => void;
    onError: (e: unknown) => void;
    api: TelegramAttachmentApi;
  }> = {},
) {
  const errors: unknown[] = [];
  const delivered: (readonly { messageId: number; text: string }[])[] = [];

  const wrapper = new TelegramOutputStreamWithAttachments(stream, {
    api: overrides.api ?? noopApi,
    sessionRef: session,
    silent: false,
    onError: overrides.onError ?? ((e) => errors.push(e)),
    onDelivered: overrides.onDelivered ?? ((m) => delivered.push(m)),
  });

  return { wrapper, errors, delivered };
}

describe("recording the bot's own delivered output", () => {
  it("reports delivered messages so the adapter can index them", async () => {
    // Telegram never echoes the bot's own messages back as updates, so this
    // hook is the only chance to record them for later reply context.
    const stream = fakeStream({ delivered: [{ messageId: 7, text: "the answer" }] });
    const { wrapper, delivered } = wrap(stream);

    await wrapper.finish();

    expect(delivered).toEqual([[{ messageId: 7, text: "the answer" }]]);
  });

  it("reports every message of a multi-part reply", async () => {
    const stream = fakeStream({
      delivered: [
        { messageId: 7, text: "part one" },
        { messageId: 8, text: "part two" },
      ],
    });
    const { wrapper, delivered } = wrap(stream);

    await wrapper.finish();

    expect(delivered[0]).toHaveLength(2);
  });

  it("still returns the delivered reply when indexing fails", async () => {
    const stream = fakeStream({ deliveredThrows: true });
    const { wrapper, errors } = wrap(stream);

    const result = await wrapper.finish();

    expect(result).toEqual(RESULT);
    expect(errors).toHaveLength(1);
  });

  it("indexes before uploading attachments, so a failed upload cannot lose the record", async () => {
    const order: string[] = [];
    const stream = fakeStream({
      delivered: [{ messageId: 7, text: "answer" }],
      attachments: [
        {
          kind: "image",
          mimeType: "image/png",
          filename: "a.png",
          bytes: new Uint8Array([1]),
        },
      ],
    });

    const { wrapper } = wrap(stream, {
      onDelivered: () => order.push("indexed"),
      api: {
        sendPhoto: async () => {
          order.push("uploaded");
          throw new Error("upload failed");
        },
        sendDocument: async () => ({ message_id: 1 }),
      },
    });

    const result = await wrapper.finish();

    expect(order).toEqual(["indexed", "uploaded"]);
    // The text reply was already delivered; a failed upload must not discard it.
    expect(result).toEqual(RESULT);
  });

  it("appends successful attachment refs to the result", async () => {
    const stream = fakeStream({
      attachments: [
        {
          kind: "image",
          mimeType: "image/png",
          filename: "a.png",
          bytes: new Uint8Array([1]),
        },
      ],
    });

    const { wrapper } = wrap(stream, {
      api: {
        sendPhoto: async () => ({ message_id: 42 }),
        sendDocument: async () => ({ message_id: 0 }),
      },
    });

    const result = await wrapper.finish();

    expect(result.created).toHaveLength(2);
    expect(result.last).toEqual({ platform: "telegram", channelId: "1001", messageId: "42" });
  });
});
