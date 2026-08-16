import { describe, expect, it } from "bun:test";
import { Panic } from "better-result";
import { GrammyError } from "grammy";

import { projectTelegramError } from "../../../src/surface/telegram/telegram-error-projection";

describe("Telegram error projection", () => {
  it("projects Bot API fields into a closed error value", () => {
    // Given
    const error = new GrammyError(
      "Call to sendMessage failed!",
      {
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 3 },
      },
      "sendMessage",
      {},
    );

    // When
    const projected = projectTelegramError(error, "Telegram operation failed");

    // Then
    expect(projected).toMatchObject({
      kind: "grammy",
      error,
      message: "Too Many Requests",
      errorCode: 429,
      retryAfterSeconds: 3,
    });
  });

  it("retains ordinary Error identity", () => {
    // Given
    const error = new Error("socket closed");

    // When
    const projected = projectTelegramError(error, "Telegram operation failed");

    // Then
    expect(projected.error).toBe(error);
    expect(projected.message).toBe("socket closed");
  });

  it("uses the boundary fallback for opaque failures", () => {
    // Given
    const opaque = { unexpected: true };

    // When
    const projected = projectTelegramError(opaque, "Telegram operation failed");

    // Then
    expect(projected).toMatchObject({
      kind: "opaque",
      message: "Telegram operation failed",
    });
    expect(projected.error).toBeInstanceOf(Error);
  });

  it("preserves Panic identity", () => {
    // Given
    const panic = new Panic({ message: "telegram invariant failed" });

    // When / Then
    expect(() => projectTelegramError(panic, "Telegram operation failed")).toThrow(panic);
  });
});
