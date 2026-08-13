import { getDiscordSessionAliasValue, type CoreConfig } from "@stanley2058/lilac-utils";
import { Result, type Result as ResultType } from "better-result";

import { hasSurfaceGuildIdResolver, type SurfaceAdapter } from "../adapter";
import { SurfaceToolTargetInvalid, type SurfaceToolTargetRouting } from "../protocol";
import type { SurfaceSession } from "../types";

function invalid(message: string): ResultType<never, SurfaceToolTargetInvalid> {
  return Result.err(new SurfaceToolTargetInvalid({ message }));
}

function mustDiscordSurfaceConfig(
  cfg: CoreConfig,
): ResultType<NonNullable<CoreConfig["surface"]["discord"]>, SurfaceToolTargetInvalid> {
  const discord = cfg.surface.discord;
  return discord ? Result.ok(discord) : invalid("surface.discord config missing");
}

function decodeDiscordSessionId(input: {
  sessionId: string;
  cfg: CoreConfig;
}): ResultType<string, SurfaceToolTargetInvalid> {
  const raw = input.sessionId.trim();
  if (raw.length === 0) return invalid("sessionId is required");

  const mentionMatch = raw.match(/^<#[0-9]+>$/u);
  if (mentionMatch) return Result.ok(raw.slice(2, -1));
  if (/^[0-9]+$/u.test(raw)) return Result.ok(raw);

  const sessionKeyMatch = raw.match(/^discord:channel:([0-9]+)$/u);
  if (sessionKeyMatch) return Result.ok(sessionKeyMatch[1]!);

  const token = raw.trim().replace(/^#+/u, "");
  const map = input.cfg.entity?.sessions?.discord ?? {};
  const tokenLc = token.toLowerCase();
  for (const [key, value] of Object.entries(map)) {
    const resolved = getDiscordSessionAliasValue(value);
    if (!resolved) continue;
    if (key.trim().replace(/^#+/u, "").toLowerCase() === tokenLc) {
      return Result.ok(resolved.discordId);
    }
  }

  if (raw.startsWith("req:")) {
    return invalid(
      `Invalid --session-id '${input.sessionId}': that looks like a requestId. ` +
        "Pass a Discord channel id (e.g. '1462714189553598555') or omit --session-id to use the active session.",
    );
  }

  return invalid(
    `Unknown sessionId alias '${input.sessionId}'. Expected a raw channelId, a <#channelId> mention, or one of the configured tokens in cfg.entity.sessions.discord.`,
  );
}

export function bestEffortAliasForDiscordChannelId(input: {
  channelId: string;
  cfg: CoreConfig;
}): string | undefined {
  const map = input.cfg.entity?.sessions?.discord ?? {};
  for (const [token, value] of Object.entries(map)) {
    const resolved = getDiscordSessionAliasValue(value);
    if (resolved?.discordId === input.channelId) {
      return token.trim().replace(/^#+/u, "");
    }
  }
  return undefined;
}

async function tryGetCachedSession(
  adapter: SurfaceAdapter,
  channelId: string,
): Promise<SurfaceSession | null> {
  const sessions = await adapter.listSessions();
  if (sessions.status === "error") return null;
  for (const session of sessions.value) {
    if (session.ref.platform === "discord" && session.ref.channelId === channelId) return session;
  }
  return null;
}

export async function resolveGuildIdForChannel(input: {
  adapter: SurfaceAdapter;
  channelId: string;
}): Promise<string | null> {
  const session = await tryGetCachedSession(input.adapter, input.channelId);
  if (session?.ref.platform === "discord") return session.ref.guildId ?? null;
  if (hasSurfaceGuildIdResolver(input.adapter)) {
    return await input.adapter.fetchGuildIdForChannel(input.channelId);
  }
  return null;
}

export function shouldAllowDiscordChannel(input: {
  cfg: CoreConfig;
  channelId: string;
  guildId?: string | null;
}): ResultType<boolean, SurfaceToolTargetInvalid> {
  const discord = mustDiscordSurfaceConfig(input.cfg);
  if (discord.status === "error") return discord;

  const allowedChannelIds = new Set(discord.value.allowedChannelIds);
  const allowedGuildIds = new Set(discord.value.allowedGuildIds);
  if (allowedChannelIds.size === 0 && allowedGuildIds.size === 0) return Result.ok(false);
  if (allowedChannelIds.has(input.channelId)) return Result.ok(true);
  return Result.ok(Boolean(input.guildId && allowedGuildIds.has(input.guildId)));
}

export const discordToolTargetRouting = {
  helpFallbackPriority: 0,
  inferRequestTarget: (requestId) => {
    if (!requestId) return null;
    const match = /^discord:([^:]+):([^:]+)$/u.exec(requestId);
    return match ? { sessionId: match[1]!, messageId: match[2]! } : null;
  },
  describeSessionIds: ({ contextSessionId, config }) => ({
    sessionIdFormats: {
      client: "discord",
      accepted: [
        { format: "123456789012345678", meaning: "Raw Discord channel id" },
        { format: "<#123456789012345678>", meaning: "Discord channel mention" },
        {
          format: "dev-chat",
          meaning:
            "Configured session alias (cfg.entity.sessions.discord maps alias -> channelId or { discord, comment })",
        },
        {
          format: "#dev-chat",
          meaning: "Configured session alias with optional leading # prefix",
        },
      ],
      notes: [
        "If the request has no session context, you must pass --session-id (or set LILAC_SESSION_ID). Some requests also allow inferring sessionId/messageId from requestId when it is 'discord:<sessionId>:<messageId>'.",
      ],
    },
    ...(contextSessionId
      ? {
          contextAlias: bestEffortAliasForDiscordChannelId({
            channelId: contextSessionId,
            cfg: config,
          }),
        }
      : {}),
  }),
  resolveSession: async ({ selector, adapter, getConfig }) => {
    const config = await getConfig();
    const channelId = decodeDiscordSessionId({ sessionId: selector, cfg: config });
    if (channelId.status === "error") return channelId;
    const guildId = await resolveGuildIdForChannel({ adapter, channelId: channelId.value });
    const allowed = shouldAllowDiscordChannel({
      cfg: config,
      channelId: channelId.value,
      guildId,
    });
    if (allowed.status === "error") return allowed;
    if (!allowed.value) return invalid(`Not allowed: channelId '${channelId.value}'`);
    return Result.ok({
      sessionRef: {
        platform: "discord",
        channelId: channelId.value,
        guildId: guildId ?? undefined,
        parentChannelId: undefined,
      },
      config,
    });
  },
} satisfies SurfaceToolTargetRouting<"discord">;
