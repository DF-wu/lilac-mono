import { describe, expect, it } from "bun:test";
import type { ModelCapabilityInfo } from "@stanley2058/lilac-utils";

import { supportsReadFileMedia } from "../src/model-message-media";

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
});
