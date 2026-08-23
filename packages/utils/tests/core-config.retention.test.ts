import { describe, expect, it } from "bun:test";

import { parseCoreConfigV1ToUniversal, parseCoreConfigV2ToUniversal } from "../core-config";

describe("core config retention", () => {
  it("uses the raised retention defaults for v1 and v2 universal config", () => {
    for (const parsed of [
      parseCoreConfigV1ToUniversal({ configVersion: 1 }),
      parseCoreConfigV2ToUniversal({ configVersion: 2 }),
    ]) {
      expect(parsed.agent.transcriptRetention).toEqual({
        maxAgeMs: { kind: "bounded", value: 180 * 24 * 60 * 60 * 1000 },
        maxRequests: { kind: "bounded", value: 10_000 },
      });
      expect(parsed.surface.discord.attachmentCache).toEqual({
        ttlMs: { kind: "bounded", value: 30 * 24 * 60 * 60 * 1000 },
      });
    }
  });

  it("parses bounded and unlimited v2 retention limits", () => {
    const bounded = parseCoreConfigV2ToUniversal({
      configVersion: 2,
      agent: {
        transcriptRetention: { maxAge: "12mo", maxRequests: 25_000 },
      },
      surface: { discord: { attachmentCache: { ttl: "6w" } } },
    });
    expect(bounded.agent.transcriptRetention).toEqual({
      maxAgeMs: { kind: "bounded", value: 12 * 30 * 24 * 60 * 60 * 1000 },
      maxRequests: { kind: "bounded", value: 25_000 },
    });
    expect(bounded.surface.discord.attachmentCache.ttlMs).toEqual({
      kind: "bounded",
      value: 6 * 7 * 24 * 60 * 60 * 1000,
    });

    const unlimited = parseCoreConfigV2ToUniversal({
      configVersion: 2,
      agent: {
        transcriptRetention: { maxAge: "unlimited", maxRequests: "unlimited" },
      },
      surface: { discord: { attachmentCache: { ttl: "unlimited" } } },
    });
    expect(unlimited.agent.transcriptRetention).toEqual({
      maxAgeMs: { kind: "unlimited" },
      maxRequests: { kind: "unlimited" },
    });
    expect(unlimited.surface.discord.attachmentCache.ttlMs).toEqual({ kind: "unlimited" });
  });

  it("rejects invalid v2 retention limits", () => {
    for (const raw of [
      { agent: { transcriptRetention: { maxAge: 0 } } },
      { agent: { transcriptRetention: { maxRequests: 0 } } },
      { surface: { discord: { attachmentCache: { ttl: "forever" } } } },
    ]) {
      expect(() => parseCoreConfigV2ToUniversal({ configVersion: 2, ...raw })).toThrow();
    }
  });

  it("keeps retention fields out of the frozen v1 input schema", () => {
    const unknownKeys: Array<readonly (string | number)[]> = [];
    const parsed = parseCoreConfigV1ToUniversal(
      {
        configVersion: 1,
        agent: { transcriptRetention: { maxAge: "unlimited" } },
        surface: { discord: { botName: "lilac", attachmentCache: { ttl: "unlimited" } } },
      },
      {
        onUnknownKey: (path) => unknownKeys.push(path),
      },
    );

    expect(unknownKeys).toEqual([
      ["agent", "transcriptRetention"],
      ["surface", "discord", "attachmentCache"],
    ]);
    expect(parsed.agent.transcriptRetention.maxAgeMs).toEqual({
      kind: "bounded",
      value: 180 * 24 * 60 * 60 * 1000,
    });
    expect(parsed.surface.discord.attachmentCache.ttlMs).toEqual({
      kind: "bounded",
      value: 30 * 24 * 60 * 60 * 1000,
    });
  });
});
