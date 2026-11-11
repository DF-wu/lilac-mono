import { describe, expect, it } from "bun:test";
import { Panic, Result, type Result as ResultType } from "better-result";

import type { SurfaceAttachment, TelegramSessionRef } from "../../../src/surface/types";
import {
  SurfaceOperationPartiallyCompleted,
  type SurfaceOutputResult,
} from "../../../src/surface/adapter";
import {
  TelegramOutputStreamWithAttachments,
  type TelegramAttachmentApi,
  type TelegramDeliverableStream,
} from "../../../src/surface/telegram/output/telegram-attachment-delivery";
import type { TelegramSurplusDeletionFailure } from "../../../src/surface/telegram/output/telegram-output-stream";

const session: TelegramSessionRef = { platform: "telegram", channelId: "1001" };

const RESULT: SurfaceOutputResult = {
  created: [{ platform: "telegram", channelId: "1001", messageId: "7" }],
  last: { platform: "telegram", channelId: "1001", messageId: "7" },
};

function resultValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

/**
 * A stand-in for the real stream. Only the three members the wrapper touches
 * after `finish()` matter here, so this stays a structural double rather than a
 * full fake of the streaming state machine.
 */
function fakeStream(input: {
  delivered?: { messageId: number; text: string }[];
  attachments?: SurfaceAttachment[];
  deliveredThrows?: boolean;
  finishThrows?: unknown;
  unreconciled?: TelegramSurplusDeletionFailure[];
}): TelegramDeliverableStream {
  const stream: TelegramDeliverableStream = {
    finish: async () => {
      if (input.finishThrows) throw input.finishThrows;
      return Result.ok(RESULT);
    },
    getDeliveredMessages: () => {
      if (input.deliveredThrows) throw new Error("index unavailable");
      return input.delivered ?? [];
    },
    takePendingAttachments: () => input.attachments ?? [],
    getSurplusDeletionFailures: () => input.unreconciled ?? [],
    push: async () => Result.ok("visible"),
    abort: async () => Result.ok(undefined),
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
    onError: (e: unknown, context?: Record<string, unknown>) => void;
    api: TelegramAttachmentApi;
  }> = {},
) {
  const errors: unknown[] = [];
  const delivered: (readonly { messageId: number; text: string }[])[] = [];
  const unreconciled: (readonly TelegramSurplusDeletionFailure[])[] = [];

  const wrapper = new TelegramOutputStreamWithAttachments(stream, {
    api: overrides.api ?? noopApi,
    sessionRef: session,
    silent: false,
    onError: overrides.onError ?? ((e) => errors.push(e)),
    onDelivered: overrides.onDelivered ?? ((m) => delivered.push(m)),
    onUnreconciled: (f) => unreconciled.push(f),
  });

  return { wrapper, errors, delivered, unreconciled };
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

    const result = resultValue(await wrapper.finish());

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
    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected partial attachment delivery");
    expect(result.error).toBeInstanceOf(SurfaceOperationPartiallyCompleted);
    expect(result.error).toMatchObject({ operation: "finish-output", created: RESULT.last });
  });

  it("indexes an uploaded attachment so a reply to it can resolve", async () => {
    // An attachment message has no text of its own. Without a row in the index
    // there is nothing for readMsg to return, and a reply chain that reaches
    // the attachment stops there.
    const stream = fakeStream({
      attachments: [
        { kind: "image", mimeType: "image/png", filename: "chart.png", bytes: new Uint8Array([1]) },
      ],
    });

    const { wrapper, delivered } = wrap(stream, {
      api: {
        sendPhoto: async () => ({ message_id: 42 }),
        sendDocument: async () => ({ message_id: 0 }),
      },
    });

    await wrapper.finish();

    expect(delivered.flat()).toContainEqual({ messageId: 42, text: "[image] chart.png" });
  });

  it("indexes the uploads that succeeded before a later one failed", async () => {
    // Upload 1 is in the chat. If only upload 2's failure is recorded, that
    // message stays permanently unresolvable as a reply target.
    let attempt = 0;
    const stream = fakeStream({
      delivered: [{ messageId: 7, text: "answer" }],
      attachments: [
        { kind: "image", mimeType: "image/png", filename: "a.png", bytes: new Uint8Array([1]) },
        { kind: "image", mimeType: "image/png", filename: "b.png", bytes: new Uint8Array([2]) },
      ],
    });

    const { wrapper, errors, delivered } = wrap(stream, {
      api: {
        sendPhoto: async () => {
          attempt += 1;
          if (attempt === 2) throw new Error("upload failed");
          return { message_id: 50 };
        },
        sendDocument: async () => ({ message_id: 0 }),
      },
    });

    const result = await wrapper.finish();

    expect(delivered.flat()).toContainEqual({ messageId: 50, text: "[image] a.png" });
    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected partial attachment delivery");
    expect(result.error).toBeInstanceOf(SurfaceOperationPartiallyCompleted);
    expect(result.error).toMatchObject({
      operation: "finish-output",
      created: { platform: "telegram", channelId: "1001", messageId: "50" },
    });
    expect(errors).toHaveLength(1);
  });

  it("tells the error reporter how much of the batch survived", async () => {
    let attempt = 0;
    const stream = fakeStream({
      attachments: [
        { kind: "image", mimeType: "image/png", filename: "a.png", bytes: new Uint8Array([1]) },
        { kind: "image", mimeType: "image/png", filename: "b.png", bytes: new Uint8Array([2]) },
      ],
    });

    const contexts: (Record<string, unknown> | undefined)[] = [];
    const { wrapper } = wrap(stream, {
      onError: (_e, context) => contexts.push(context),
      api: {
        sendPhoto: async () => {
          attempt += 1;
          if (attempt === 2) throw new Error("upload failed");
          return { message_id: 50 };
        },
        sendDocument: async () => ({ message_id: 0 }),
      },
    });

    await wrapper.finish();

    expect(contexts[0]).toEqual({ filename: "b.png", uploaded: 1, total: 2 });
  });

  it("still indexes the text reply when every upload fails", async () => {
    const stream = fakeStream({
      delivered: [{ messageId: 7, text: "answer" }],
      attachments: [
        { kind: "image", mimeType: "image/png", filename: "a.png", bytes: new Uint8Array([1]) },
      ],
    });

    const { wrapper, delivered } = wrap(stream, {
      api: {
        sendPhoto: async () => {
          throw new Error("upload failed");
        },
        sendDocument: async () => ({ message_id: 0 }),
      },
    });

    const result = await wrapper.finish();

    expect(delivered.flat()).toEqual([{ messageId: 7, text: "answer" }]);
    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected partial attachment delivery");
    expect(result.error).toMatchObject({
      _tag: "SurfaceOperationPartiallyCompleted",
      created: RESULT.last,
    });
  });

  it("keeps the reply when indexing the attachments throws", async () => {
    // Indexing is best-effort on both passes, not just the text one.
    const stream = fakeStream({
      attachments: [
        { kind: "image", mimeType: "image/png", filename: "a.png", bytes: new Uint8Array([1]) },
      ],
    });

    let call = 0;
    const { wrapper, errors } = wrap(stream, {
      onDelivered: () => {
        call += 1;
        if (call === 2) throw new Error("index unavailable");
      },
      api: {
        sendPhoto: async () => ({ message_id: 42 }),
        sendDocument: async () => ({ message_id: 0 }),
      },
    });

    const result = resultValue(await wrapper.finish());

    expect(errors).toHaveLength(1);
    expect(result.created).toHaveLength(2);
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

    const result = resultValue(await wrapper.finish());

    expect(result.created).toHaveLength(2);
    expect(result.last).toEqual({ platform: "telegram", channelId: "1001", messageId: "42" });
  });

  it("preserves Panic identity from the wrapped output stream", async () => {
    const panic = new Panic({ message: "output invariant failed" });
    const { wrapper } = wrap(fakeStream({ finishThrows: panic }));

    expect(wrapper.finish()).rejects.toBe(panic);
  });
});

describe("unreconciled surplus messages reach the adapter", () => {
  it("reports them so the runtime can log stale output", async () => {
    const stream = fakeStream({
      unreconciled: [{ messageId: 8, outcome: "unreconciled", reason: "message can't be deleted" }],
    });
    const { wrapper, unreconciled } = wrap(stream);

    await wrapper.finish();

    expect(unreconciled).toHaveLength(1);
    expect(unreconciled[0]?.[0]?.messageId).toBe(8);
  });

  it("stays quiet when everything reconciled", async () => {
    const { wrapper, unreconciled } = wrap(fakeStream({}));

    await wrapper.finish();

    expect(unreconciled).toHaveLength(0);
  });
});
