import { describe, expect, test } from "bun:test";

import { captureError } from "../../src/shared/error-capture";

describe("captureError", () => {
  test("preserves Error identity without a separate opaque capture", () => {
    const cause = new Error("failed");

    expect(captureError(cause)).toEqual({ cause, captured: undefined });
  });

  test("wraps and retains a non-Error cause", () => {
    const cause = { reason: "failed" };
    const captured = captureError(cause, "Operation failed");

    expect(captured.cause.message).toBe("Operation failed");
    expect(captured.cause.cause).toBe(cause);
    expect(captured.captured).toBe(cause);
  });

  test("uses the shared fallback message by default", () => {
    expect(captureError("failed").cause.message).toBe("Unknown operation failure");
  });
});
