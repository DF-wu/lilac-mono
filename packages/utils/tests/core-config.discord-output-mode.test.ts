import { describe, expect, it } from "bun:test";

import { coreConfigSchema } from "../core-config";

describe("coreConfigSchema surface.discord.outputMode", () => {
  it("accepts preview mode", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        discord: {
          botName: "lilac",
          outputMode: "preview",
        },
      },
    });

    expect(parsed.surface.discord.outputMode).toBe("preview");
  });

  it("accepts plain previewFinalOutputStyle", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        discord: {
          botName: "lilac",
          outputMode: "preview",
          previewFinalOutputStyle: "plain",
        },
      },
    });

    expect(parsed.surface.discord.previewFinalOutputStyle).toBe("plain");
  });

  it("keeps outputNotification optional by default", () => {
    const parsed = coreConfigSchema.parse({});
    expect(parsed.surface.discord.outputNotification).toBeUndefined();
  });

  it("accepts outputNotification=true", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        discord: {
          botName: "lilac",
          outputNotification: true,
        },
      },
    });

    expect(parsed.surface.discord.outputNotification).toBe(true);
  });

  it("accepts custom workingIndicators", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        discord: {
          botName: "lilac",
          workingIndicators: ["Planning", "Reading", "Tooling"],
        },
      },
    });

    expect(parsed.surface.discord.workingIndicators).toEqual(["Planning", "Reading", "Tooling"]);
  });

  it("keeps memberPresence optional by default", () => {
    const parsed = coreConfigSchema.parse({});
    expect(parsed.surface.discord.memberPresence).toBeUndefined();
  });

  it("accepts memberPresence=true", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        discord: {
          botName: "lilac",
          memberPresence: true,
        },
      },
    });

    expect(parsed.surface.discord.memberPresence).toBe(true);
  });

  it("accepts markdown table render experimental overrides", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        discord: {
          botName: "lilac",
          experimental: {
            markdownTableRender: {
              enabled: true,
              style: "ascii",
              maxWidth: 100,
              fallbackMode: "passthrough",
            },
          },
        },
      },
    });

    expect(parsed.surface.discord.experimental.markdownTableRender).toEqual({
      enabled: true,
      style: "ascii",
      maxWidth: 100,
      fallbackMode: "passthrough",
    });
  });
});
