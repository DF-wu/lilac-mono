import { describe, expect, it } from "bun:test";

import { parseCoreConfig } from "../core-config";

describe("retained fork configuration across v2 and v3", () => {
  it.each([2, 3])(
    "preserves Telegram admission and hosted search in v%s",
    async (configVersion) => {
      const warnings: string[] = [];
      const config = await parseCoreConfig(
        {
          configVersion,
          surface: {
            telegram: {
              enabled: true,
              token: "test-bot-token",
              allowedChatIds: ["-100123"],
              allowedUserIds: ["42"],
              inboundMedia: { maxBytesPerAttachment: "2MiB" },
            },
          },
          tools: {
            web: {
              extract: { providers: ["openai", "tavily", "openai"] },
              openai: { model: "openai-compatible/search-model", searchContextSize: "high" },
            },
          },
        },
        { onUnknownKey: (key) => warnings.push(key.join(".")) },
      );

      expect(warnings).toEqual([]);
      expect(config.surface.telegram).toMatchObject({
        enabled: true,
        token: "test-bot-token",
        allowedChatIds: ["-100123"],
        allowedUserIds: ["42"],
        inboundMedia: { enabled: true, maxBytesPerAttachment: 2 * 1024 * 1024 },
      });
      expect(config.tools.web.extract.providers).toEqual(["openai", "tavily"]);
      expect(config.tools.web.openai).toEqual({
        model: "openai-compatible/search-model",
        searchContextSize: "high",
      });
    },
  );

  it("keeps v3 Telegram defaults disabled, fail closed, and independent across parses", async () => {
    const first = await parseCoreConfig({ configVersion: 3 });
    first.surface.telegram.allowedChatIds.push("mutated");
    first.surface.telegram.workingIndicators.push("mutated");
    const second = await parseCoreConfig({ configVersion: 3 });

    expect(second.surface.telegram.enabled).toBe(false);
    expect(second.surface.telegram.allowedChatIds).toEqual([]);
    expect(second.surface.telegram.workingIndicators).not.toContain("mutated");
    expect(second.tools.web.extract.providers).toEqual(["tavily"]);
    expect(second.tools.web.openai).toBeUndefined();
  });
});
