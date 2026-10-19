import { describe, expect, it } from "bun:test";

import { coreConfigSchema } from "../core-config";

describe("core-config heartbeat", () => {
  it("accepts a valid heartbeat cron expression", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        heartbeat: {
          enabled: true,
          cron: "*/15 * * * *",
        },
      },
    });

    expect(parsed.surface.heartbeat.cron).toBe("*/15 * * * *");
  });

  it("rejects a heartbeat cron expression with the wrong field count", () => {
    expect(() =>
      coreConfigSchema.parse({
        surface: {
          heartbeat: {
            enabled: true,
            cron: "*/15 * * *",
          },
        },
      }),
    ).toThrow("cron expr must be 5 fields");
  });

  it("rejects the removed heartbeat every field", () => {
    expect(() =>
      coreConfigSchema.parse({
        surface: {
          heartbeat: {
            enabled: true,
            every: "30m",
          },
        },
      }),
    ).toThrow("surface.heartbeat.every has been removed; use surface.heartbeat.cron");
  });

  it.each(["discord/ops", "github/owner/repo#1", "native/thread-123"])(
    "accepts default output session %s",
    (destination) => {
      const parsed = coreConfigSchema.parse({
        surface: {
          heartbeat: {
            enabled: true,
            defaultOutputSession: destination,
          },
        },
      });

      expect(parsed.surface.heartbeat.defaultOutputSession).toBe(destination);
    },
  );

  it.each(["ops", "native/", "unsupported/thread-123"])(
    "rejects invalid default output session %s",
    (destination) => {
      expect(() =>
        coreConfigSchema.parse({
          surface: {
            heartbeat: {
              enabled: true,
              defaultOutputSession: destination,
            },
          },
        }),
      ).toThrow("expected <client>/<sessionIdOrAlias>");
    },
  );
});
