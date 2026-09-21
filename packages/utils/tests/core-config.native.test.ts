import { describe, expect, it } from "bun:test";
import { parseCoreConfigV1ToUniversal, parseCoreConfigV2ToUniversal } from "../core-config";

describe("native surface configuration", () => {
  it("keeps existing installations disabled and retention independent", () => {
    expect(parseCoreConfigV1ToUniversal({}).surface.native.enabled).toBe(false);
    const native = parseCoreConfigV2ToUniversal({ configVersion: 2 }).surface.native;
    expect(native.enabled).toBe(false);
    expect(native.oldMessageSelectionMaxAgeMs).toBeNull();
    expect(native.storageRetentionMaxAgeMs).toBeNull();
    expect(native.installationId).toBeUndefined();
  });
  it("normalizes independent friendly durations and preserves explicit output mode", () => {
    const native = parseCoreConfigV2ToUniversal({
      configVersion: 2,
      surface: {
        native: {
          enabled: true,
          installationId: "test-install",
          outputStreaming: "complete",
          oldMessageSelectionMaxAgeMs: "1h",
          storageRetentionMaxAgeMs: "30d",
          crossThreadSend: { triggerRun: false },
        },
      },
    }).surface.native;
    expect(native.oldMessageSelectionMaxAgeMs).toBe(3_600_000);
    expect(native.storageRetentionMaxAgeMs).toBe(30 * 86400_000);
    expect(native.outputStreaming).toBe("complete");
    expect(native.crossThreadSend.triggerRun).toBe(false);
  });
  it("rejects enabled installations without identity or Clerk owner mapping", () => {
    expect(() => parseCoreConfigV2ToUniversal({ surface: { native: { enabled: true } } })).toThrow(
      "installationId",
    );
    expect(() =>
      parseCoreConfigV2ToUniversal({
        surface: { native: { enabled: true, installationId: "test", auth: { provider: "clerk" } } },
      }),
    ).toThrow("ownerProviderUserId");
  });
  it("does not recognize native input in v1", () => {
    const unknown: string[] = [];
    const cfg = parseCoreConfigV1ToUniversal(
      { surface: { native: { enabled: true } } },
      { onUnknownKey: (key) => unknown.push(key.join(".")) },
    );
    expect(cfg.surface.native.enabled).toBe(false);
    expect(unknown).toContain("surface.native");
  });
});

it("reserves the Lilac service identity", () => {
  expect(() =>
    parseCoreConfigV2ToUniversal({ surface: { native: { auth: { ownerId: "lilac" } } } }),
  ).toThrow("reserved");
});

it("defaults native titles to fast and accepts model slots or references", () => {
  expect(parseCoreConfigV1ToUniversal({}).surface.native.titleModel).toBe("fast");
  expect(parseCoreConfigV2ToUniversal({}).surface.native.titleModel).toBe("fast");
  for (const titleModel of ["main", "fast", "openai/gpt-4o-mini", "my-title-alias"])
    expect(
      parseCoreConfigV2ToUniversal({ surface: { native: { titleModel } } }).surface.native
        .titleModel,
    ).toBe(titleModel);
  expect(() =>
    parseCoreConfigV2ToUniversal({ surface: { native: { titleModel: " " } } }),
  ).toThrow();
});
