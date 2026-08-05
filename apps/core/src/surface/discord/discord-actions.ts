import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import type { SurfaceAction } from "../types";

const ACTION_PREFIX = "lilac_action:v1:";
const CUSTOM_ID_MAX_LENGTH = 100;

export class DiscordActionCustomIdInvalid extends TaggedError("DiscordActionCustomIdInvalid")<{
  readonly message: string;
}> {}

export function buildDiscordActionCustomIdResult(
  actionId: string,
): ResultType<string, DiscordActionCustomIdInvalid> {
  const customId = `${ACTION_PREFIX}${actionId}`;
  if (!actionId || customId.length > CUSTOM_ID_MAX_LENGTH) {
    return Result.err(
      new DiscordActionCustomIdInvalid({
        message: "Discord surface action ID is empty or exceeds the custom_id limit",
      }),
    );
  }
  return Result.ok(customId);
}

export function parseDiscordActionCustomId(customId: string): string | null {
  if (!customId.startsWith(ACTION_PREFIX)) return null;
  const actionId = customId.slice(ACTION_PREFIX.length);
  return actionId.length > 0 ? actionId : null;
}

function buttonStyle(style: SurfaceAction["style"]): ButtonStyle {
  switch (style) {
    case "primary":
      return ButtonStyle.Primary;
    case "success":
      return ButtonStyle.Success;
    case "danger":
      return ButtonStyle.Danger;
    case "secondary":
      return ButtonStyle.Secondary;
  }
}

export function buildDiscordActionComponentsResult(
  actions: readonly SurfaceAction[],
): ResultType<ActionRowBuilder<ButtonBuilder>[], DiscordActionCustomIdInvalid> {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let index = 0; index < actions.length; index += 5) {
    const buttons: ButtonBuilder[] = [];
    for (const action of actions.slice(index, index + 5)) {
      const customId = buildDiscordActionCustomIdResult(action.actionId);
      if (customId.status === "error") return Result.err(customId.error);
      buttons.push(
        new ButtonBuilder()
          .setCustomId(customId.value)
          .setLabel(action.label)
          .setStyle(buttonStyle(action.style)),
      );
    }
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
  }
  return Result.ok(rows);
}
