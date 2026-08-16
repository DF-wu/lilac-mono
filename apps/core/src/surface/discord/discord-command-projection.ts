import type { CmdRequestMessageData } from "@stanley2058/lilac-event-bus";

import type { AdapterEvent } from "../events";
import { escapeSurfaceMetadataTags, formatSurfaceMetadataLine } from "../bridge/surface-metadata";

type DiscordCommandInvokedEvent = Extract<AdapterEvent, { type: "adapter.command.invoked" }>;

export function toBusDiscordCommandInvokedData(
  evt: DiscordCommandInvokedEvent,
): CmdRequestMessageData {
  const header = formatSurfaceMetadataLine({
    platform: evt.platform,
    ...(evt.userId ? { user_id: evt.userId } : {}),
    ...(evt.userName ? { user_name: evt.userName } : {}),
    message_time: new Date(evt.ts).toISOString(),
  });

  return {
    queue: "prompt",
    messages: [
      {
        role: "user",
        content: `${header}\n${escapeSurfaceMetadataTags(evt.text)}`.trimEnd(),
      },
    ],
    ...(evt.modelOverride ? { modelOverride: evt.modelOverride } : {}),
    raw: {
      ...(typeof evt.userId === "string" && evt.userId.length > 0
        ? { authenticatedActor: { platform: evt.platform, userId: evt.userId } }
        : {}),
      sessionMode: evt.sessionMode,
      sessionConfigId: evt.sessionConfigId,
      ...(evt.modelOverride ? { modelOverride: evt.modelOverride } : {}),
      customCommand: {
        name: evt.commandName,
        args: evt.args,
        ...(evt.prompt ? { prompt: evt.prompt } : {}),
        text: evt.text,
        source: "discord-slash",
      },
    },
  };
}
