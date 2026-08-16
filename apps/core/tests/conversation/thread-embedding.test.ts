import { describe, expect, it } from "bun:test";

import { Panic } from "better-result";

import { createConversationThreadEmbeddingAdapterResolver } from "../../src/conversation/thread-embedding";

describe("conversation thread embedding adapter resolver", () => {
  it("preserves config loader defects instead of disabling embeddings", async () => {
    const defect = new Error("config loader defect");
    const resolveAdapter = createConversationThreadEmbeddingAdapterResolver(async () => {
      throw defect;
    });

    await expect(resolveAdapter()).rejects.toBe(defect);
  });

  it("preserves config loader Panic identity", async () => {
    const panic = new Panic({ message: "embedding config invariant failed" });
    const resolveAdapter = createConversationThreadEmbeddingAdapterResolver(async () => {
      throw panic;
    });

    await expect(resolveAdapter()).rejects.toBe(panic);
  });
});
