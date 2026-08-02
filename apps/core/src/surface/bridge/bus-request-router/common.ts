import type { EvtAdapterMessageCreatedData } from "@stanley2058/lilac-event-bus";
import {
  getDiscordUserAliasValue,
  parseCoreConfig,
  type CoreConfig,
} from "@stanley2058/lilac-utils";

import type { MsgRef, RoutedSurfacePlatform } from "../../types";
import {
  formatDiscordMessageRequestId,
  formatGenericRequestId,
  formatQueuedRequestId,
  formatTelegramMessageRequestId,
} from "../request-ids";

export type SessionMode = "mention" | "active";
export type SessionSafetyMode = "trusted" | "restricted";

export function previewText(text: string, max = 200): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}...`;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sanitizeUserToken(name: string): string {
  return name.replace(/\s+/gu, "_").replace(/^@+/u, "");
}

const USER_MENTION_TOKEN_RE = /(^|[^A-Za-z0-9_])@([A-Za-z0-9_][A-Za-z0-9_.-]*)/gu;

function hasNonSelfMentionToken(input: { text: string; botNames: readonly string[] }): boolean {
  const selfNamesLc = new Set(
    input.botNames
      .map((name) => sanitizeUserToken(name).toLowerCase())
      .filter((name) => name.length > 0),
  );

  for (const m of input.text.matchAll(USER_MENTION_TOKEN_RE)) {
    const token = String(m[2] ?? "").trim();
    if (!token) continue;
    if (selfNamesLc.has(sanitizeUserToken(token).toLowerCase())) continue;
    return true;
  }

  return false;
}

export type { RoutedSurfacePlatform };

export function isRoutedSurfacePlatform(x: unknown): x is RoutedSurfacePlatform {
  return x === "discord" || x === "telegram";
}

export function resolveBotMentionNames(input: {
  cfg: CoreConfig;
  botUserId?: string;
  platform?: RoutedSurfacePlatform;
  /** Telegram handle; a second way users address the bot. */
  botUsername?: string;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const addName = (raw: string | undefined) => {
    if (typeof raw !== "string") return;
    const sanitized = sanitizeUserToken(raw);
    if (!sanitized) return;
    const key = sanitized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(sanitized);
  };

  const platform = input.platform ?? "discord";
  addName(
    platform === "telegram"
      ? input.cfg.surface.telegram.botName
      : input.cfg.surface.discord.botName,
  );
  addName(input.botUsername);

  // Entity aliases are keyed by Discord user id, so they only apply there.
  if (platform === "discord" && input.botUserId) {
    const users = input.cfg.entity?.users ?? {};
    for (const [alias, rec] of Object.entries(users)) {
      const resolved = getDiscordUserAliasValue(rec);
      if (!resolved || resolved.discordId !== input.botUserId) continue;
      addName(alias);
    }
  }

  return out;
}

export function compareMessagePosition(
  a: { ts: number; messageId: string },
  b: { ts: number; messageId: string },
): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.messageId.localeCompare(b.messageId);
}

export function normalizeGateText(text: string | undefined, max = 280): string | undefined {
  if (!text) return undefined;
  const normalized = text.trim().replace(/\s+/gu, " ");
  if (!normalized) return undefined;
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

function stripLeadingBotMentionPrefix(
  text: string,
  botNames: readonly string[],
): {
  hadLeadingMention: boolean;
  mentionPrefix: string;
  text: string;
} {
  const sanitizedBotNames = botNames
    .map((name) => sanitizeUserToken(name))
    .filter((name) => name.length > 0);
  const nameAlternation =
    sanitizedBotNames.length > 0
      ? `|@(?:${sanitizedBotNames.map((name) => escapeRegExp(name)).join("|")})`
      : "";
  const mentionRe = new RegExp(`^\\s*(?:<@!?[^>]+>${nameAlternation})(?:[,:]\\s*|\\s+)`, "iu");
  const m = text.match(mentionRe);
  if (!m) return { hadLeadingMention: false, mentionPrefix: "", text };
  return {
    hadLeadingMention: true,
    mentionPrefix: m[0],
    text: text.slice(m[0].length),
  };
}

const LEADING_INTERRUPT_COMMAND_RE = /^\s*(?:[:,]\s*)?!(?:interrupt|int)\b(?:\s+|$)/iu;
const LEADING_MODEL_OVERRIDE_RE = /^\s*(?:[:,]\s*)?!(?:m|model):([^\s]+)(?:\s+|$)/iu;
const DEFAULT_CONTINUE_DIRECTIVE_COUNT = 8;
const LEADING_CONTINUE_DIRECTIVE_RE = /^\s*(?:[:,]\s*)?!(?:continue|cont)(?:=(\d+))?(?:\s+|$)/iu;

export function parseLeadingModelOverride(input: {
  text: string;
  botNames: readonly string[];
}): string | undefined {
  const stripped = stripLeadingBotMentionPrefix(input.text, input.botNames);
  const target = stripped.hadLeadingMention ? stripped.text : input.text;
  const m = target.match(LEADING_MODEL_OVERRIDE_RE);
  if (!m) return undefined;

  const model = String(m[1] ?? "").trim();
  return model.length > 0 ? model : undefined;
}

export function parseLeadingContinueDirective(input: {
  text: string;
  botNames: readonly string[];
}): number | undefined {
  const stripped = stripLeadingBotMentionPrefix(input.text, input.botNames);
  const target = stripped.hadLeadingMention ? stripped.text : input.text;
  const m = target.match(LEADING_CONTINUE_DIRECTIVE_RE);
  if (!m) return undefined;

  if (m[1] === undefined) return DEFAULT_CONTINUE_DIRECTIVE_COUNT;

  const rawCount = Number.parseInt(String(m[1]).trim(), 10);
  if (!Number.isFinite(rawCount) || rawCount < 1) return undefined;
  return Math.min(200, rawCount);
}

export function stripLeadingModelOverrideDirective(input: {
  text: string;
  botNames: readonly string[];
}): string {
  const strippedMention = stripLeadingBotMentionPrefix(input.text, input.botNames);
  if (!strippedMention.hadLeadingMention) {
    return input.text.replace(LEADING_MODEL_OVERRIDE_RE, "").replace(/^\s+/u, "");
  }

  if (!LEADING_MODEL_OVERRIDE_RE.test(strippedMention.text)) {
    return input.text;
  }

  const remainder = strippedMention.text
    .replace(LEADING_MODEL_OVERRIDE_RE, "")
    .replace(/^\s+/u, "");
  return `${strippedMention.mentionPrefix}${remainder}`;
}

export function stripLeadingContinueDirective(input: {
  text: string;
  botNames: readonly string[];
}): string {
  const strippedMention = stripLeadingBotMentionPrefix(input.text, input.botNames);
  if (!strippedMention.hadLeadingMention) {
    return input.text.replace(LEADING_CONTINUE_DIRECTIVE_RE, "").replace(/^\s+/u, "");
  }

  if (!LEADING_CONTINUE_DIRECTIVE_RE.test(strippedMention.text)) {
    return input.text;
  }

  const remainder = strippedMention.text
    .replace(LEADING_CONTINUE_DIRECTIVE_RE, "")
    .replace(/^\s+/u, "");
  return `${strippedMention.mentionPrefix}${remainder}`;
}

export function parseSteerDirectiveMode(input: {
  text: string;
  botNames: readonly string[];
}): "steer" | "interrupt" {
  const stripped = stripLeadingBotMentionPrefix(input.text, input.botNames);
  if (!stripped.hadLeadingMention) return "steer";
  return LEADING_INTERRUPT_COMMAND_RE.test(stripped.text) ? "interrupt" : "steer";
}

export function stripLeadingInterruptDirective(input: {
  text: string;
  botNames: readonly string[];
}): string {
  const strippedMention = stripLeadingBotMentionPrefix(input.text, input.botNames);
  if (!strippedMention.hadLeadingMention) {
    return input.text.replace(LEADING_INTERRUPT_COMMAND_RE, "").replace(/^\s+/u, "");
  }

  if (!LEADING_INTERRUPT_COMMAND_RE.test(strippedMention.text)) {
    return input.text;
  }

  const remainder = strippedMention.text
    .replace(LEADING_INTERRUPT_COMMAND_RE, "")
    .replace(/^\s+/u, "");
  return `${strippedMention.mentionPrefix}${remainder}`;
}

export function shouldRunDirectReplyMentionGate(input: {
  replyToBot: boolean;
  mentionsBot: boolean;
  text: string;
  botNames: readonly string[];
}): boolean {
  if (!input.replyToBot) return false;
  if (input.mentionsBot) return false;
  return hasNonSelfMentionToken({ text: input.text, botNames: input.botNames });
}

export function consumerId(prefix: string): string {
  return `${prefix}:${process.pid}:${Math.random().toString(16).slice(2)}`;
}

export function randomRequestId(): string {
  return formatGenericRequestId();
}

export function bufferedPromptRequestIdForActiveRequest(activeRequestId: string): string {
  return formatQueuedRequestId(activeRequestId);
}

export function resolveSurfaceBotName(cfg: CoreConfig, platform: RoutedSurfacePlatform): string {
  return platform === "telegram" ? cfg.surface.telegram.botName : cfg.surface.discord.botName;
}

/**
 * Request id for a surface message. Each platform owns its own prefix so
 * `parseRequestId` can recover the reply target from the id alone.
 */
export function formatSurfaceMessageRequestId(input: {
  platform: RoutedSurfacePlatform;
  sessionId: string;
  messageId: string;
}): string {
  return input.platform === "telegram"
    ? formatTelegramMessageRequestId({
        sessionId: input.sessionId,
        messageId: input.messageId,
      })
    : formatDiscordMessageRequestId({
        channelId: input.sessionId,
        messageId: input.messageId,
      });
}

export function parseSurfaceMsgRefFromAdapterEvent(data: {
  platform: string;
  channelId: string;
  messageId: string;
}): MsgRef {
  if (!isRoutedSurfacePlatform(data.platform)) {
    throw new Error(`Unsupported platform '${data.platform}'`);
  }
  return {
    platform: data.platform,
    channelId: data.channelId,
    messageId: data.messageId,
  };
}

export function resolveSessionConfigId(input: {
  cfg: CoreConfig;
  sessionId: string;
  parentChannelId?: string;
}): string {
  const entry = input.cfg.surface.router.sessionModes[input.sessionId];
  if (
    entry &&
    (Object.prototype.hasOwnProperty.call(entry, "additionalPrompts") ||
      Object.prototype.hasOwnProperty.call(entry, "safetyMode"))
  ) {
    return input.sessionId;
  }

  const parentChannelId = input.parentChannelId?.trim();
  if (!parentChannelId) return input.sessionId;

  const parentEntry = input.cfg.surface.router.sessionModes[parentChannelId];
  if (
    parentEntry &&
    (Object.prototype.hasOwnProperty.call(parentEntry, "additionalPrompts") ||
      Object.prototype.hasOwnProperty.call(parentEntry, "safetyMode"))
  ) {
    return parentChannelId;
  }

  return input.sessionId;
}

export function getSessionMode(
  cfg: CoreConfig,
  sessionId: string,
  parentChannelId?: string,
): SessionMode {
  const threadMode = cfg.surface.router.sessionModes[sessionId]?.mode;
  if (threadMode) return threadMode;

  const parentId = parentChannelId?.trim();
  if (parentId) {
    const parentMode = cfg.surface.router.sessionModes[parentId]?.mode;
    if (parentMode) return parentMode;
  }

  return cfg.surface.router.defaultMode;
}

export function resolveSessionGateEnabled(
  cfg: CoreConfig,
  sessionId: string,
  parentChannelId?: string,
): boolean {
  const threadGate = cfg.surface.router.sessionModes[sessionId]?.gate;
  if (typeof threadGate === "boolean") return threadGate;

  const parentId = parentChannelId?.trim();
  const parentGate = parentId ? cfg.surface.router.sessionModes[parentId]?.gate : undefined;
  if (typeof parentGate === "boolean") return parentGate;

  return cfg.surface.router.activeGate.enabled;
}

export function resolveSessionSafetyMode(
  cfg: CoreConfig,
  sessionId: string,
  parentChannelId?: string,
): SessionSafetyMode {
  const threadSafetyMode = cfg.surface.router.sessionModes[sessionId]?.safetyMode;
  if (threadSafetyMode) return threadSafetyMode;

  const parentId = parentChannelId?.trim();
  if (parentId) {
    const parentSafetyMode = cfg.surface.router.sessionModes[parentId]?.safetyMode;
    if (parentSafetyMode) return parentSafetyMode;
  }

  return "trusted";
}

export function resolveSessionModelOverride(
  cfg: CoreConfig,
  sessionId: string,
  parentChannelId?: string,
): string | undefined {
  const threadModel = cfg.surface.router.sessionModes[sessionId]?.model;
  if (typeof threadModel === "string" && threadModel.trim().length > 0) {
    return threadModel.trim();
  }

  const parentId = parentChannelId?.trim();
  if (!parentId) return undefined;

  const parentModel = cfg.surface.router.sessionModes[parentId]?.model;
  if (typeof parentModel === "string" && parentModel.trim().length > 0) {
    return parentModel.trim();
  }

  return undefined;
}

export function buildDiscordUserAliasById(cfg: CoreConfig): Map<string, string> {
  const out = new Map<string, string>();
  const users = cfg.entity?.users ?? {};

  for (const [alias, rec] of Object.entries(users)) {
    const resolved = getDiscordUserAliasValue(rec);
    if (!resolved) continue;
    if (!out.has(resolved.discordId)) {
      out.set(resolved.discordId, alias);
    }
  }

  return out;
}

export type SurfaceRouterFlags = {
  isDMBased?: boolean;
  mentionsBot?: boolean;
  replyToBot?: boolean;
  replyToMessageId?: string;
  parentChannelId?: string;
  sessionModelOverride?: string;
  botUserId?: string;
};

/**
 * Reads the router flag envelope an adapter attaches to `raw`.
 *
 * Each adapter publishes its flags under a key named after its platform
 * (`raw.discord`, `raw.telegram`) with the same structure, so the router can
 * stay platform-agnostic while adapters keep their own normalization.
 */
export function getSurfaceFlags(
  raw: unknown,
  platform: RoutedSurfacePlatform = "discord",
): SurfaceRouterFlags {
  if (!raw || typeof raw !== "object") return {};
  const envelope = (raw as Record<string, unknown>)[platform];
  if (!envelope || typeof envelope !== "object") return {};

  const o = envelope as Record<string, unknown>;

  return {
    isDMBased: typeof o.isDMBased === "boolean" ? o.isDMBased : undefined,
    mentionsBot: typeof o.mentionsBot === "boolean" ? o.mentionsBot : undefined,
    replyToBot: typeof o.replyToBot === "boolean" ? o.replyToBot : undefined,
    replyToMessageId: typeof o.replyToMessageId === "string" ? o.replyToMessageId : undefined,
    parentChannelId: typeof o.parentChannelId === "string" ? o.parentChannelId : undefined,
    sessionModelOverride:
      typeof o.sessionModelOverride === "string" ? o.sessionModelOverride : undefined,
    botUserId: typeof o.botUserId === "string" ? o.botUserId : undefined,
  };
}

export type RouterConfigOverride = Record<string, unknown>;

function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function withDefaultToolsConfig(config: RouterConfigOverride): Promise<CoreConfig> {
  const parsed = await parseCoreConfig(config);
  const agent = isConfigRecord(config.agent) ? config.agent : {};
  const systemPrompt = typeof agent.systemPrompt === "string" ? agent.systemPrompt : "";

  return {
    ...parsed,
    agent: {
      ...parsed.agent,
      systemPrompt,
    },
  };
}

export type RouterAdapterMessage = EvtAdapterMessageCreatedData;
