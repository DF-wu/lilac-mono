import { describe, expect, it } from "bun:test";
import { TextInputStyle } from "discord.js";

import {
  buildDiscordQuestionCustomActionId,
  buildDiscordQuestionModal,
  buildDiscordQuestionModalCustomId,
  buildDiscordQuestionOptionActionId,
  DISCORD_QUESTION_CUSTOM_INPUT_ID,
  parseDiscordQuestionActionId,
  parseDiscordQuestionModalCustomId,
} from "../../../src/surface/discord/discord-question-interactions";

describe("Discord question interactions", () => {
  it("round-trips indexed option and custom action IDs", () => {
    const token = "85d381a4-fbb4-4414-8f07-a1b56578b48e";

    expect(parseDiscordQuestionActionId(buildDiscordQuestionOptionActionId(token, 2))).toEqual({
      kind: "option",
      token,
      optionIndex: 2,
    });
    expect(parseDiscordQuestionActionId(buildDiscordQuestionCustomActionId(token))).toEqual({
      kind: "custom",
      token,
    });
    expect(parseDiscordQuestionActionId("unrelated:v1:action")).toBeNull();
  });

  it("builds the custom response modal", () => {
    const token = "response-token";
    const json = buildDiscordQuestionModal(token).toJSON();

    expect(json.custom_id).toBe(buildDiscordQuestionModalCustomId(token));
    expect(parseDiscordQuestionModalCustomId(json.custom_id)).toBe(token);
    expect(json.title).toBe("Other response");
    const row = json.components[0];
    expect(row).toMatchObject({ type: 1 });
    if (!row || !("components" in row)) throw new Error("Modal input row is missing");
    expect(row.components[0]).toMatchObject({
      custom_id: DISCORD_QUESTION_CUSTOM_INPUT_ID,
      label: "Your answer",
      style: TextInputStyle.Paragraph,
      required: true,
      max_length: 4_000,
    });
  });

  it("rejects malformed IDs", () => {
    expect(parseDiscordQuestionActionId("question:v1:t:option:0")).toBeNull();
    expect(parseDiscordQuestionActionId("question:v1:t:option:x")).toBeNull();
    expect(parseDiscordQuestionModalCustomId("lilac_question_modal:v1:a:b")).toBeNull();
  });
});
