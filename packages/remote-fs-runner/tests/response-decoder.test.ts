import { describe, expect, it } from "bun:test";

import { decodeDaemonResponseEnvelope } from "../src/cli";

describe("daemon response decoder", () => {
  it("rejects a successful envelope missing value", () => {
    expect(decodeDaemonResponseEnvelope({ ok: true })).toBeUndefined();
  });

  it("preserves an explicitly present undefined value", () => {
    const decoded = decodeDaemonResponseEnvelope({ ok: true, value: undefined });

    expect(decoded).toEqual({ ok: true, value: undefined });
    expect(decoded !== undefined && Object.hasOwn(decoded, "value")).toBe(true);
  });

  it("rejects malformed error envelopes", () => {
    expect(decodeDaemonResponseEnvelope({ ok: false })).toBeUndefined();
    expect(decodeDaemonResponseEnvelope({ ok: false, error: 42 })).toBeUndefined();
  });

  it("decodes a valid successful envelope", () => {
    const value = { content: "hello", lines: 1 };

    expect(decodeDaemonResponseEnvelope({ ok: true, value })).toEqual({ ok: true, value });
  });
});
