import { describe, expect, it } from "bun:test";

import { questionInputSchema } from "../../src/question/question-domain";

describe("question input", () => {
  it("requires stable unique question and option IDs", () => {
    const decoded = questionInputSchema.safeParse({
      questions: [
        {
          id: "target",
          header: "Target",
          question: "Choose a target.",
          options: [
            { id: "same", label: "One", description: "First target." },
            { id: "same", label: "Two", description: "Second target." },
          ],
        },
      ],
    });

    expect(decoded.success).toBe(false);
  });

  it("rejects cards that cannot fit the Discord embed", () => {
    const decoded = questionInputSchema.safeParse({
      questions: [
        {
          id: "target",
          header: "Target",
          question: "q".repeat(2_000),
          options: [
            { id: "one", label: "One", description: "a".repeat(1_000) },
            { id: "two", label: "Two", description: "b".repeat(1_000) },
          ],
        },
      ],
    });

    expect(decoded.success).toBe(false);
  });
});
