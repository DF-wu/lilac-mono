import { describe, expect, it } from "bun:test";

import {
  busMessageV2Schema,
  storedMessageV1Schema,
  storedResourcePartV1Schema,
} from "../blob-messages";

const RESOURCE_PART = {
  type: "resource" as const,
  uri: `resource://r1_${"ab".repeat(16)}`,
  filename: "diagram.png",
  mediaType: "image/png",
  size: 321,
};

describe("resource message parts", () => {
  it("preserves one strict resource identity on bus and stored messages", () => {
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "inspect" }, RESOURCE_PART],
    };

    expect(busMessageV2Schema.parse(message)).toEqual(message);
    expect(storedMessageV1Schema.parse(message)).toEqual(message);
    expect(storedResourcePartV1Schema.parse(RESOURCE_PART)).toEqual(RESOURCE_PART);
  });

  it("allows resource parts anywhere the internal contract allows file parts", () => {
    expect(storedMessageV1Schema.parse({ role: "assistant", content: [RESOURCE_PART] })).toEqual({
      role: "assistant",
      content: [RESOURCE_PART],
    });
    expect(
      storedMessageV1Schema.parse({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "inspect",
            output: { type: "content", value: [RESOURCE_PART] },
          },
        ],
      }),
    ).toMatchObject({
      role: "tool",
      content: [{ output: { value: [RESOURCE_PART] } }],
    });
  });

  it("rejects malformed or extended resource parts", () => {
    const invalidParts: readonly unknown[] = [
      { ...RESOURCE_PART, uri: "" },
      { ...RESOURCE_PART, uri: `resource://user@r1_${"ab".repeat(16)}` },
      { ...RESOURCE_PART, uri: `resource://r1_${"ab".repeat(16)}:443` },
      { ...RESOURCE_PART, uri: `resource://r1_${"ab".repeat(16)}/file` },
      { ...RESOURCE_PART, uri: `resource://r1_${"ab".repeat(16)}?download=1` },
      { ...RESOURCE_PART, uri: `resource://r1_${"ab".repeat(16)}#fragment` },
      { ...RESOURCE_PART, uri: `resource://r1_${"ab".repeat(15)}%61%62` },
      { ...RESOURCE_PART, uri: `resource://r1_${"AB".repeat(16)}` },
      { ...RESOURCE_PART, uri: `resource://r1_${"ab".repeat(16)}trailing` },
      { ...RESOURCE_PART, uri: `resource://r2_${"ab".repeat(16)}` },
      { ...RESOURCE_PART, mediaType: "" },
      { ...RESOURCE_PART, size: -1 },
      { ...RESOURCE_PART, size: 1.5 },
      { ...RESOURCE_PART, signedUrl: "https://example.com/private?token=secret" },
    ];
    for (const part of invalidParts) {
      expect(storedResourcePartV1Schema.safeParse(part).success).toBe(false);
    }
  });

  it("keeps historical blob parts valid", () => {
    expect(
      storedMessageV1Schema.safeParse({
        role: "user",
        content: [
          {
            type: "blob",
            blob: {
              version: 1,
              objectId: `b1_${"11".repeat(16)}`,
              sha256: "22".repeat(32),
              byteLength: 3,
            },
            mediaType: "image/png",
          },
        ],
      }).success,
    ).toBe(true);
  });
});
