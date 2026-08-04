import { describe, expect, it } from "bun:test";

import {
  parseFriendlyByteSize,
  parseFriendlyByteSizeResult,
  parseFriendlyDurationMs,
  parseFriendlyDurationMsResult,
} from "../friendly-units";

describe("friendly units", () => {
  it("parses decimal and binary byte sizes", () => {
    expect(parseFriendlyByteSize("40KiB")).toBe(40 * 1024);
    expect(parseFriendlyByteSize("5MB")).toBe(5_000_000);
    expect(parseFriendlyByteSize("1.5MiB")).toBe(1.5 * 1024 * 1024);
    expect(parseFriendlyByteSize(123)).toBe(123);
  });

  it("parses durations with deterministic months", () => {
    expect(parseFriendlyDurationMs("1m")).toBe(60_000);
    expect(parseFriendlyDurationMs("6d")).toBe(6 * 24 * 60 * 60 * 1000);
    expect(parseFriendlyDurationMs("3mo")).toBe(3 * 30 * 24 * 60 * 60 * 1000);
  });

  it("rejects ambiguous, negative, unsupported, and unsafe values", () => {
    for (const value of ["1", "-1MiB", "1M", "1mB", "InfinityMiB", "1MiB trailing"]) {
      expect(() => parseFriendlyByteSize(value)).toThrow();
    }
    expect(() => parseFriendlyByteSize(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => parseFriendlyDurationMs("1min")).toThrow();
    expect(() => parseFriendlyDurationMs(-1)).toThrow();

    let caught: unknown;
    try {
      parseFriendlyByteSize("1wat");
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) expect(caught.constructor).toBe(Error);
  });

  it("returns typed failures without throwing", () => {
    const invalidBytes = parseFriendlyByteSizeResult("1wat");
    expect(invalidBytes.status).toBe("error");
    if (invalidBytes.status === "error") {
      expect(invalidBytes.error._tag).toBe("FriendlyUnitInvalid");
    }

    const duration = parseFriendlyDurationMsResult("2s");
    expect(duration.status).toBe("ok");
    if (duration.status === "ok") expect(duration.value).toBe(2_000);
  });
});
