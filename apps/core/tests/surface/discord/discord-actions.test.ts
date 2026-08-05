import { describe, expect, it } from "bun:test";
import { ButtonStyle } from "discord.js";

import {
  buildDiscordActionComponentsResult,
  buildDiscordActionCustomIdResult,
  parseDiscordActionCustomId,
} from "../../../src/surface/discord/discord-actions";

describe("Discord generic surface actions", () => {
  it("renders review/run controls with opaque IDs and parses interactions", () => {
    const token = "85d381a4-fbb4-4414-8f07-a1b56578b48e";
    const rowsResult = buildDiscordActionComponentsResult([
      { actionId: token, label: "Approve", style: "success" },
      { actionId: "cancel-token-123456", label: "Cancel", style: "danger" },
    ]);
    const customIdResult = buildDiscordActionCustomIdResult(token);
    expect(rowsResult.status).toBe("ok");
    expect(customIdResult.status).toBe("ok");
    if (rowsResult.status === "error" || customIdResult.status === "error") return;
    const rows = rowsResult.value;
    const customId = customIdResult.value;
    const json = rows[0]?.toJSON();
    expect(json?.components).toHaveLength(2);
    expect(json?.components[0]).toMatchObject({
      custom_id: customId,
      label: "Approve",
      style: ButtonStyle.Success,
    });
    expect(parseDiscordActionCustomId(customId)).toBe(token);
    expect(parseDiscordActionCustomId("lilac_cancel:v2:channel:m:message")).toBeNull();
  });

  it("returns typed validation failures", () => {
    const result = buildDiscordActionCustomIdResult("");

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error._tag).toBe("DiscordActionCustomIdInvalid");
    }
  });

  it("returns component validation failures without throwing", () => {
    const result = buildDiscordActionComponentsResult([
      { actionId: "", label: "Approve", style: "success" },
    ]);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error._tag).toBe("DiscordActionCustomIdInvalid");
    }
  });
});
