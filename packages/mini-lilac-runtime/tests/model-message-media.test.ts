import { describe, expect, it } from "bun:test";
import type { ModelCapabilityInfo } from "@stanley2058/lilac-utils";
import type { ModelMessage } from "ai";

import {
  scrubReadFileMediaForModelView,
  supportsReadFileMedia,
  toolResultContentDisplayValue,
} from "../src/model-message-media";

function mediaResult(id: string, bytes: Buffer, mediaType = "image/png"): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "read_file",
        output: {
          type: "content",
          value: [
            { type: "text", text: `attached ${id}` },
            {
              type: "file",
              filename: `${id}.png`,
              mediaType,
              data: { type: "data", data: bytes.toString("base64") },
            },
          ],
        },
      },
    ],
  };
}

describe("read_file model-view media", () => {
  it("requires attachment plus both image and PDF input modalities", () => {
    const base = {
      provider: "test",
      model: "mock",
      limit: { context: 1, output: 1 },
    } satisfies ModelCapabilityInfo;
    expect(
      supportsReadFileMedia({
        ...base,
        attachment: true,
        modalities: { input: ["text", "image", "pdf"] },
      }),
    ).toBe(true);
    expect(
      supportsReadFileMedia({
        ...base,
        attachment: true,
        modalities: { input: ["text", "image"] },
      }),
    ).toBe(false);
    expect(
      supportsReadFileMedia({
        ...base,
        attachment: false,
        modalities: { input: ["text", "image", "pdf"] },
      }),
    ).toBe(false);
  });

  it("retains newest decoded media within per-part and total limits without changing canonical messages", () => {
    const messages = [
      mediaResult("old", Buffer.alloc(4, 1)),
      mediaResult("middle", Buffer.alloc(4, 2)),
      mediaResult("new", Buffer.alloc(4, 3)),
    ];
    const canonical = JSON.stringify(messages);
    const view = scrubReadFileMediaForModelView(messages, {
      maxBytesPerPart: 4,
      maxBytesTotal: 8,
    });

    expect(JSON.stringify(messages)).toBe(canonical);
    expect(JSON.stringify(view[0])).toContain("Image exceeds the inline limit");
    expect(JSON.stringify(view[0])).not.toContain(Buffer.alloc(4, 1).toString("base64"));
    expect(JSON.stringify(view[1])).toContain(Buffer.alloc(4, 2).toString("base64"));
    expect(JSON.stringify(view[2])).toContain(Buffer.alloc(4, 3).toString("base64"));

    const oversized = scrubReadFileMediaForModelView([mediaResult("large", Buffer.alloc(5))], {
      maxBytesPerPart: 4,
      maxBytesTotal: 20,
    });
    expect(JSON.stringify(oversized)).toContain("Image exceeds the inline limit");
  });

  it("removes tool-result media from an unsupported model view", () => {
    const view = scrubReadFileMediaForModelView([mediaResult("unsupported", Buffer.alloc(1))], {
      maxBytesPerPart: 0,
      maxBytesTotal: 0,
    });
    expect(JSON.stringify(view)).not.toContain(Buffer.alloc(1).toString("base64"));
    expect(JSON.stringify(view)).toContain("Image exceeds the inline limit");
  });

  it("bounds legacy inline media variants and removes their data from display values", () => {
    const encoded = Buffer.alloc(5, 7).toString("base64");
    const message: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "legacy-media",
          toolName: "plugin",
          output: {
            type: "content",
            value: [
              { type: "file-data", data: encoded, mediaType: "application/pdf", filename: "a.pdf" },
              { type: "image-data", data: encoded, mediaType: "image/png" },
            ],
          },
        },
      ],
    };

    const view = scrubReadFileMediaForModelView([message], {
      maxBytesPerPart: 4,
      maxBytesTotal: 20,
    });
    expect(JSON.stringify(view)).not.toContain(encoded);
    expect(JSON.stringify(view)).toContain("must be reduced");
    expect(JSON.stringify(view)).toContain("Resize the image");

    const part = message.content[0];
    if (part?.type !== "tool-result" || part.output.type !== "content") {
      throw new Error("missing content output");
    }
    expect(JSON.stringify(toolResultContentDisplayValue(part.output))).not.toContain(encoded);
  });

  it("bounds inline data URLs while preserving ordinary remote URLs", () => {
    const encoded = Buffer.alloc(5, 9).toString("base64");
    const remoteUrl = "https://example.test/image.png";
    const message: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "url-media",
          toolName: "plugin",
          output: {
            type: "content",
            value: [
              { type: "image-url", url: `data:image/png;base64,${encoded}` },
              { type: "file-url", url: `data:application/pdf;base64,${encoded}` },
              { type: "image-url", url: remoteUrl },
            ],
          },
        },
      ],
    };

    const view = scrubReadFileMediaForModelView([message], {
      maxBytesPerPart: 4,
      maxBytesTotal: 20,
    });
    expect(JSON.stringify(view)).not.toContain(encoded);
    expect(JSON.stringify(view)).toContain(remoteUrl);

    const part = message.content[0];
    if (part?.type !== "tool-result" || part.output.type !== "content") {
      throw new Error("missing content output");
    }
    const display = JSON.stringify(toolResultContentDisplayValue(part.output));
    expect(display).not.toContain(encoded);
    expect(display).toContain(remoteUrl);
  });
});
