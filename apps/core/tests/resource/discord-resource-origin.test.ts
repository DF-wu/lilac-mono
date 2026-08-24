import { describe, expect, it } from "bun:test";

import { Result, type Result as ResultType } from "better-result";

import type { DiscordResourceOriginV1, ResourceRecordV1 } from "../../src/resource/contracts";
import { ResourceOriginUnavailable } from "../../src/resource/errors";
import {
  SurfaceUnavailable,
  type SurfaceAdapter,
  type SurfaceOperationError,
} from "../../src/surface/adapter";
import { createDiscordResourceOriginAdapter } from "../../src/surface/discord/discord-resource-origin";
import type { SurfaceMessage } from "../../src/surface/types";

const RESOURCE_ID = "r1_0123456789abcdef0123456789abcdef" as const;

function resourceRecord(input?: {
  readonly ordinal?: number;
  readonly attachmentId?: string;
  readonly filename?: string;
  readonly declaredMediaType?: string;
  readonly reportedByteLength?: number;
}): ResourceRecordV1 & { readonly origin: DiscordResourceOriginV1 } {
  return {
    version: 1,
    resourceId: RESOURCE_ID,
    origin: {
      version: 1,
      kind: "discord-attachment",
      channelId: "channel-1",
      messageId: "message-1",
      ordinal: input?.ordinal ?? 0,
      ...(input?.attachmentId === undefined ? {} : { attachmentId: input.attachmentId }),
    },
    ...(input?.filename === undefined ? {} : { filename: input.filename }),
    ...(input?.declaredMediaType === undefined
      ? {}
      : { declaredMediaType: input.declaredMediaType }),
    ...(input?.reportedByteLength === undefined
      ? {}
      : { reportedByteLength: input.reportedByteLength }),
    createdAt: 1,
  };
}

function surfaceMessage(raw: unknown): SurfaceMessage {
  return {
    ref: {
      platform: "discord",
      channelId: "channel-1",
      messageId: "message-1",
    },
    session: { platform: "discord", channelId: "channel-1" },
    userId: "user-1",
    text: "message",
    ts: 1,
    raw,
  };
}

function readAdapter(
  result: ResultType<SurfaceMessage | null, SurfaceOperationError>,
): Pick<SurfaceAdapter, "readMsg"> {
  return { readMsg: async () => result };
}

function expectUnavailable(
  result: ResultType<unknown, ResourceOriginUnavailable>,
): ResourceOriginUnavailable {
  expect(result.status).toBe("error");
  if (result.status === "ok") throw new Error("expected unavailable origin");
  expect(result.error._tag).toBe("ResourceOriginUnavailable");
  return result.error;
}

describe("Discord resource origin", () => {
  it("resolves a current visible attachment through a fresh message read", async () => {
    const message = surfaceMessage({
      attachments: [
        {
          id: "attachment-1",
          url: "https://cdn.discordapp.com/attachments/1/2/current.png?ex=current-signature",
          filename: "current.png",
          mimeType: "image/png",
          size: 321,
        },
      ],
    });
    const reads: unknown[] = [];
    const resolver = createDiscordResourceOriginAdapter({
      readMsg: async (ref) => {
        reads.push(ref);
        return Result.ok(message);
      },
    });

    const resolved = await resolver.resolve({
      record: resourceRecord({ attachmentId: "attachment-1" }),
    });

    expect(resolved.status).toBe("ok");
    if (resolved.status === "error") throw resolved.error;
    expect(reads).toEqual([
      { platform: "discord", channelId: "channel-1", messageId: "message-1" },
    ]);
    expect(resolved.value).toEqual({
      url: new URL("https://cdn.discordapp.com/attachments/1/2/current.png?ex=current-signature"),
      filename: "current.png",
      declaredMediaType: "image/png",
      reportedByteLength: 321,
    });
  });

  it("uses forwarded snapshot attachments as the visible ordinal source", async () => {
    const message = surfaceMessage({
      reference: { type: 1, messageId: "original", channelId: "other-channel" },
      attachments: [
        {
          id: "hidden-top-level",
          url: "https://cdn.discordapp.com/attachments/hidden/top.png",
          filename: "hidden.png",
        },
      ],
      messageSnapshots: [
        {
          message: {
            attachments: [
              {
                id: "visible-0",
                url: "https://cdn.discordapp.com/attachments/visible/zero.png",
                filename: "zero.png",
              },
              {
                id: "visible-1",
                url: "https://media.discordapp.net/attachments/visible/one.png?sig=transient",
                filename: "one.png",
                mimeType: "image/png",
                size: 9,
              },
            ],
          },
        },
      ],
    });
    const resolver = createDiscordResourceOriginAdapter(readAdapter(Result.ok(message)));

    const resolved = await resolver.resolve({
      record: resourceRecord({ ordinal: 1, attachmentId: "visible-1" }),
    });

    expect(resolved.status).toBe("ok");
    if (resolved.status === "error") throw resolved.error;
    expect(resolved.value.filename).toBe("one.png");
    expect(resolved.value.url.hostname).toBe("media.discordapp.net");
  });

  it("accepts an edited message when the attachment ID is retained", async () => {
    const message = surfaceMessage({
      attachments: [
        {
          id: "stable-id",
          url: "https://cdn.discordapp.com/attachments/1/2/renamed.png?sig=new",
          filename: "renamed.png",
          mimeType: "image/png",
          size: 22,
        },
      ],
    });
    const resolver = createDiscordResourceOriginAdapter(readAdapter(Result.ok(message)));

    const resolved = await resolver.resolve({
      record: resourceRecord({
        attachmentId: "stable-id",
        filename: "old-name.png",
        declaredMediaType: "image/jpeg",
        reportedByteLength: 11,
      }),
    });

    expect(resolved.status).toBe("ok");
    if (resolved.status === "error") throw resolved.error;
    expect(resolved.value.filename).toBe("renamed.png");
    expect(resolved.value.reportedByteLength).toBe(22);
  });

  it("returns unavailable when the message was deleted", async () => {
    const resolver = createDiscordResourceOriginAdapter(readAdapter(Result.ok(null)));

    const error = expectUnavailable(
      await resolver.resolve({
        record: resourceRecord({ attachmentId: "private-attachment-id" }),
      }),
    );

    expect(error.retryable).toBe(false);
    expect(JSON.stringify(error)).not.toContain("private-attachment-id");
  });

  it("returns unavailable when the visible ordinal was removed", async () => {
    const resolver = createDiscordResourceOriginAdapter(
      readAdapter(Result.ok(surfaceMessage({ attachments: [] }))),
    );

    const error = expectUnavailable(
      await resolver.resolve({
        record: resourceRecord({
          ordinal: 2,
          attachmentId: "removed-attachment-id",
        }),
      }),
    );

    expect(error.retryable).toBe(false);
    expect(JSON.stringify(error)).not.toContain("removed-attachment-id");
  });

  it("rejects a mismatched attachment ID without exposing either ID", async () => {
    const message = surfaceMessage({
      attachments: [
        {
          id: "current-private-id",
          url: "https://cdn.discordapp.com/attachments/1/2/file.png?sig=private-query",
        },
      ],
    });
    const resolver = createDiscordResourceOriginAdapter(readAdapter(Result.ok(message)));

    const error = expectUnavailable(
      await resolver.resolve({
        record: resourceRecord({ attachmentId: "stored-private-id" }),
      }),
    );
    const serialized = JSON.stringify(error);

    expect(serialized).not.toContain("stored-private-id");
    expect(serialized).not.toContain("current-private-id");
    expect(serialized).not.toContain("private-query");
  });

  it("accepts the current visible ordinal when no attachment ID was stored", async () => {
    const message = surfaceMessage({
      attachments: [
        {
          url: "https://cdn.discordapp.com/attachments/1/2/transformed.png?sig=current",
          filename: "transformed.png",
          mimeType: "IMAGE/PNG",
          size: 99,
        },
      ],
    });
    const resolver = createDiscordResourceOriginAdapter(readAdapter(Result.ok(message)));

    const resolved = await resolver.resolve({
      record: resourceRecord({
        filename: "advertised.webp",
        declaredMediaType: "image/webp",
        reportedByteLength: 12,
      }),
    });

    expect(resolved.status).toBe("ok");
    if (resolved.status === "error") throw resolved.error;
    expect(resolved.value.filename).toBe("transformed.png");
    expect(resolved.value.declaredMediaType).toBe("image/png");
    expect(resolved.value.reportedByteLength).toBe(99);
  });

  it("redacts a signed URL from surface read failures", async () => {
    const resolver = createDiscordResourceOriginAdapter(
      readAdapter(
        Result.err(
          new SurfaceUnavailable({
            platform: "discord",
            operation: "read-message",
            message:
              "Discord failed at https://cdn.discordapp.com/attachments/1/2/file?secret=query",
          }),
        ),
      ),
    );

    const error = expectUnavailable(
      await resolver.resolve({
        record: resourceRecord({ attachmentId: "private-id" }),
      }),
    );
    const serialized = JSON.stringify(error);

    expect(error.retryable).toBe(true);
    expect(serialized).not.toContain("secret=query");
    expect(serialized).not.toContain("private-id");
  });
});
