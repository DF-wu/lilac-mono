import { getDiscordSessionAliasValue, type CoreConfig } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";

class DiscordSessionResolutionInvalid extends TaggedError("DiscordSessionResolutionInvalid")<{
  readonly message: string;
}> {}

function adaptDiscordSessionResolutionResultToToolHost(
  result: ResultType<string, DiscordSessionResolutionInvalid>,
): string {
  if (result.status === "ok") return result.value;
  throw new Error(result.error.message);
}

function stripPrefix(s: string, prefix: string): string {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

function normalizeToken(raw: string): string {
  return raw.trim().replace(/^#+/u, "");
}

function decodeDiscordSessionId(input: {
  sessionId: string;
  cfg: CoreConfig;
}): ResultType<string, DiscordSessionResolutionInvalid> {
  const raw = input.sessionId.trim();
  if (raw.length === 0) {
    return Result.err(new DiscordSessionResolutionInvalid({ message: "sessionId is required" }));
  }

  // Channel mention: <#123>
  const mentionMatch = raw.match(/^<#[0-9]+>$/u);
  if (mentionMatch) {
    return Result.ok(raw.slice(2, -1));
  }

  // Raw channel id: 123
  if (/^[0-9]+$/u.test(raw)) {
    return Result.ok(raw);
  }

  // Common Discord session key shape used by other components.
  // Accept silently to keep the surface tool ergonomics forgiving.
  const sessionKeyMatch = raw.match(/^discord:channel:([0-9]+)$/u);
  if (sessionKeyMatch) {
    return Result.ok(sessionKeyMatch[1]!);
  }

  const token = normalizeToken(raw);
  const map = input.cfg.entity?.sessions?.discord ?? {};

  const tokenLc = token.toLowerCase();
  for (const [k, value] of Object.entries(map)) {
    const resolved = getDiscordSessionAliasValue(value);
    if (!resolved) continue;
    const keyLc = k.trim().replace(/^#+/u, "").toLowerCase();
    if (keyLc === tokenLc) {
      return Result.ok(resolved.discordId);
    }
  }

  if (raw.startsWith("req:")) {
    return Result.err(
      new DiscordSessionResolutionInvalid({
        message:
          `Invalid --session-id '${input.sessionId}': that looks like a requestId. ` +
          "Pass a Discord channel id (e.g. '1462714189553598555') or omit --session-id to use the active session.",
      }),
    );
  }

  return Result.err(
    new DiscordSessionResolutionInvalid({
      message: `Unknown sessionId alias '${input.sessionId}'. Expected a raw channelId, a <#channelId> mention, or one of the configured tokens in cfg.entity.sessions.discord.`,
    }),
  );
}

export function resolveDiscordSessionId(input: { sessionId: string; cfg: CoreConfig }): string {
  return adaptDiscordSessionResolutionResultToToolHost(decodeDiscordSessionId(input));
}

export function bestEffortAliasForDiscordChannelId(input: {
  channelId: string;
  cfg: CoreConfig;
}): string | undefined {
  const map = input.cfg.entity?.sessions?.discord ?? {};
  for (const [token, value] of Object.entries(map)) {
    const resolved = getDiscordSessionAliasValue(value);
    if (!resolved) continue;
    if (resolved.discordId === input.channelId) {
      return stripPrefix(token.trim().replace(/^#+/u, ""), "#");
    }
  }
  return undefined;
}
