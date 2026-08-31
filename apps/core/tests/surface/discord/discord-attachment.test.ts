import { describe, expect, it } from "bun:test";

import {
  hashIndexedDiscordAttachments,
  type DiscordIndexedAttachmentMeta,
} from "../../../src/surface/discord/discord-attachment";

describe("Discord attachment indexing", () => {
  it("treats reported MIME and size as informational metadata", () => {
    const advertised: DiscordIndexedAttachmentMeta[] = [
      {
        id: "a1",
        filename: "diagram.webp",
        mimeType: "image/webp",
        size: 123,
      },
    ];
    const transformed: DiscordIndexedAttachmentMeta[] = [
      {
        id: "a1",
        filename: "diagram.webp",
        mimeType: "image/png",
        size: 456,
      },
    ];

    expect(hashIndexedDiscordAttachments(transformed)).toBe(
      hashIndexedDiscordAttachments(advertised),
    );
  });

  it("keeps ordinal, attachment ID, and filename in attachment identity", () => {
    const attachments: DiscordIndexedAttachmentMeta[] = [
      { id: "a1", filename: "first.png" },
      { id: "a2", filename: "second.png" },
    ];
    const hash = hashIndexedDiscordAttachments(attachments);

    expect(
      hashIndexedDiscordAttachments([
        { id: "a2", filename: "second.png" },
        { id: "a1", filename: "first.png" },
      ]),
    ).not.toBe(hash);
    expect(
      hashIndexedDiscordAttachments([
        { id: "different", filename: "first.png" },
        { id: "a2", filename: "second.png" },
      ]),
    ).not.toBe(hash);
    expect(
      hashIndexedDiscordAttachments([
        { id: "a1", filename: "renamed.png" },
        { id: "a2", filename: "second.png" },
      ]),
    ).not.toBe(hash);
  });
});
