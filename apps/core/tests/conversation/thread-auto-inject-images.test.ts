import { describe, expect, it } from "bun:test";
import { collectDecisionAutoInjectImages } from "../../src/conversation/thread-auto-inject-images";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NMQEAAAjDMMC/ZzDBvlRA01vZJvwHAAAAAAAAAAAAbx2jxAE/i2AjOgAAAABJRU5ErkJggg==";
const limits = { maxBytesPerPart: 1024, maxBytesTotal: 2048 };

describe("decision image preparation", () => {
  it("reads images, materialized files, and SDK data variants using detected MIME types", async () => {
    const result = await collectDecisionAutoInjectImages({
      ...limits,
      content: [
        { type: "image", image: `data:image/png;base64,${png}` },
        {
          type: "file",
          mediaType: "image/png",
          data: { type: "data", data: Buffer.from(png, "base64") },
        },
        { type: "file", mediaType: "application/pdf", data: "ignored" },
      ],
    });
    expect(result.isOk() ? result.value : result.error).toEqual([
      `data:image/png;base64,${png}`,
      `data:image/png;base64,${png}`,
    ]);
  });

  it("fails when one image or combined images exceed configured limits", async () => {
    const part = { type: "image" as const, image: Buffer.from(png, "base64") };
    const oversized = await collectDecisionAutoInjectImages({
      ...limits,
      maxBytesPerPart: 10,
      content: [part],
    });
    const total = await collectDecisionAutoInjectImages({
      ...limits,
      maxBytesTotal: 100,
      content: [part, part],
    });
    expect(oversized.isErr()).toBe(true);
    expect(total.isErr()).toBe(true);
  });
});
