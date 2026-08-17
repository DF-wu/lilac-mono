import { describe, expect, it } from "bun:test";

import { isLikelyContextOverflowError } from "../context-overflow";

describe("isLikelyContextOverflowError", () => {
  it("matches common provider error messages", () => {
    expect(isLikelyContextOverflowError("maximum context length is 128000 tokens")).toBe(true);
    expect(isLikelyContextOverflowError("prompt is too long: 136621 tokens > 128000 maximum")).toBe(
      true,
    );
    expect(isLikelyContextOverflowError("context_length_exceeded")).toBe(true);
    expect(isLikelyContextOverflowError('{"type":"request_too_large"}')).toBe(true);
    expect(
      isLikelyContextOverflowError(
        "Prompt has 5,958,968 tokens, but the configured context size is 256,000 tokens",
      ),
    ).toBe(true);
    expect(
      isLikelyContextOverflowError("Input token count 200001 exceeds the maximum of 200000"),
    ).toBe(true);
  });

  it("matches nested Error causes", () => {
    const err = new Error("request failed");
    (err as Error & { cause?: unknown }).cause = {
      error: {
        message: "Input is too long for the context window",
      },
    };

    expect(isLikelyContextOverflowError(err)).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isLikelyContextOverflowError("rate limit exceeded")).toBe(false);
    expect(
      isLikelyContextOverflowError({
        message: "upstream timeout",
        statusCode: 504,
      }),
    ).toBe(false);
  });

  it("excludes throttling before broad token wording", () => {
    expect(isLikelyContextOverflowError("Rate limit: too many tokens submitted this minute")).toBe(
      false,
    );
    expect(isLikelyContextOverflowError("Too many requests: too many tokens")).toBe(false);
    expect(
      isLikelyContextOverflowError({
        message: "too many tokens",
        cause: { type: "throttling_error" },
      }),
    ).toBe(false);
  });
});
