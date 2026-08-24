import { describe, expect, test } from "bun:test";

import {
  createResourceId,
  formatResourceUri,
  parseResourceUri,
  resourceRecordV1Schema,
} from "../../src/resource/contracts";

describe("resource URI contract", () => {
  test("creates and parses the exact versioned capability format", () => {
    const id = createResourceId(() => Uint8Array.from({ length: 16 }, (_, index) => index));

    expect(id).toBe("r1_000102030405060708090a0b0c0d0e0f");
    expect(
      parseResourceUri(formatResourceUri(id)).match({ ok: (value) => value, err: () => null }),
    ).toBe(id);
  });

  test.each([
    "http://r1_000102030405060708090a0b0c0d0e0f",
    "resource://user@r1_000102030405060708090a0b0c0d0e0f",
    "resource://r1_000102030405060708090a0b0c0d0e0f:80",
    "resource://r1_000102030405060708090a0b0c0d0e0f/",
    "resource://r1_000102030405060708090a0b0c0d0e0f/path",
    "resource://r1_000102030405060708090a0b0c0d0e0f?query",
    "resource://r1_000102030405060708090a0b0c0d0e0f#fragment",
    "resource://R1_000102030405060708090A0B0C0D0E0F",
    "resource://r1_%3000102030405060708090a0b0c0d0e0f",
    "resource://r1_000102030405060708090a0b0c0d0e0",
    "resource://r1_000102030405060708090a0b0c0d0e0f trailing",
  ])("rejects %s", (uri) => {
    expect(parseResourceUri(uri).match({ ok: () => null, err: (error) => error._tag })).toBe(
      "ResourceInvalidUri",
    );
  });
});

describe("resource record codec", () => {
  const valid = {
    version: 1,
    resourceId: "r1_000102030405060708090a0b0c0d0e0f",
    origin: {
      version: 1,
      kind: "discord-attachment",
      channelId: "channel",
      messageId: "message",
      ordinal: 0,
      attachmentId: "attachment",
    },
    filename: "notes.txt",
    declaredMediaType: "text/plain",
    reportedByteLength: 12,
    createdAt: 10,
  } as const;

  test("accepts the current strict record", () => {
    expect(resourceRecordV1Schema.safeParse(valid).success).toBe(true);
  });

  test("rejects extra, malformed, and future-version fields", () => {
    expect(
      resourceRecordV1Schema.safeParse({ ...valid, signedUrl: "https://example.test" }).success,
    ).toBe(false);
    expect(resourceRecordV1Schema.safeParse({ ...valid, resourceId: "row-1" }).success).toBe(false);
    expect(resourceRecordV1Schema.safeParse({ ...valid, version: 2 }).success).toBe(false);
    expect(
      resourceRecordV1Schema.safeParse({
        ...valid,
        origin: { ...valid.origin, version: 2 },
      }).success,
    ).toBe(false);
    expect(
      resourceRecordV1Schema.safeParse({ ...valid, declaredMediaType: "Text/Plain" }).success,
    ).toBe(false);
  });
});
