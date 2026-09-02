import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";

const QUESTION_ACTION_PREFIX = "question:v1:";
const QUESTION_MODAL_PREFIX = "lilac_question_modal:v1:";
export const DISCORD_QUESTION_CUSTOM_INPUT_ID = "answer";

export type DiscordQuestionAction =
  | { readonly kind: "option"; readonly token: string; readonly optionIndex: number }
  | { readonly kind: "custom"; readonly token: string };

export function buildDiscordQuestionOptionActionId(token: string, optionIndex: number): string {
  return `${QUESTION_ACTION_PREFIX}${token}:option:${optionIndex}`;
}

export function buildDiscordQuestionCustomActionId(token: string): string {
  return `${QUESTION_ACTION_PREFIX}${token}:custom`;
}

export function parseDiscordQuestionActionId(actionId: string): DiscordQuestionAction | null {
  if (!actionId.startsWith(QUESTION_ACTION_PREFIX)) return null;
  const rest = actionId.slice(QUESTION_ACTION_PREFIX.length);
  const optionMatch = /^(?<token>[^:]+):option:(?<index>[1-9][0-9]*)$/u.exec(rest);
  if (optionMatch?.groups) {
    const token = optionMatch.groups["token"];
    const optionIndex = Number(optionMatch.groups["index"]);
    if (token && Number.isSafeInteger(optionIndex)) {
      return { kind: "option", token, optionIndex };
    }
  }
  const customMatch = /^(?<token>[^:]+):custom$/u.exec(rest);
  const token = customMatch?.groups?.["token"];
  return token ? { kind: "custom", token } : null;
}

export function buildDiscordQuestionModalCustomId(token: string): string {
  return `${QUESTION_MODAL_PREFIX}${token}`;
}

export function parseDiscordQuestionModalCustomId(customId: string): string | null {
  if (!customId.startsWith(QUESTION_MODAL_PREFIX)) return null;
  const token = customId.slice(QUESTION_MODAL_PREFIX.length);
  return token.length > 0 && !token.includes(":") ? token : null;
}

export function buildDiscordQuestionModal(token: string): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(DISCORD_QUESTION_CUSTOM_INPUT_ID)
    .setLabel("Your answer")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4_000);
  return new ModalBuilder()
    .setCustomId(buildDiscordQuestionModalCustomId(token))
    .setTitle("Other response")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}
