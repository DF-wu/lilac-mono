import { z } from "zod";
import fs from "node:fs/promises";
import { basename } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { getDiscordUserAliasValue, type CoreConfig } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { isAdapterPlatform } from "../../shared/is-adapter-platform";
import { hasCacheBurstProvider, type SurfaceAdapter } from "../../surface/adapter";
import type {
  MsgRef,
  SessionRef,
  SurfaceAttachment,
  SurfaceMessage,
  SurfaceReactionDetail,
  SurfaceReactionSummary,
  SurfaceSessionParticipantsResult,
  SurfaceSession,
} from "../../surface/types";
import type { DiscordSearchService } from "../../surface/store/discord-search-store";
import type { RequestContext, ServerTool } from "../types";
import { parseToolInputPreservingZodError as parseToolInput } from "../validation-error-message";
import type { RecentAgentWriteSnapshot, TranscriptStore } from "../../transcript/transcript-store";
import { isHeartbeatSessionId } from "../../transcript/heartbeat-handoff";

import {
  bestEffortAliasForDiscordChannelId,
  resolveDiscordSessionId,
} from "./resolve-discord-session-id";
import { zodObjectToCliLines } from "./zod-cli";
import {
  formatToolPathForRequestContext,
  inferMimeTypeFromFilename,
  resolveToolPathForRequestContext,
} from "../../shared/attachment-utils";
import { getDiscordSurfaceDisplayText } from "../../surface/discord/discord-surface-display-text";
import {
  DISCORD_REFERENCE_TYPE_DEFAULT,
  DISCORD_REFERENCE_TYPE_FORWARD,
  normalizeDiscordRaw,
} from "../../surface/discord/discord-raw-normalizer";

import {
  isGithubIssueTriggerId,
  parseGithubRequestId,
  parseGithubSessionId,
} from "../../github/github-ids";
import { markGithubAgentComment } from "../../github/github-comment-marker";
import {
  createIssueComment,
  createIssueCommentReaction,
  createIssueReaction,
  deleteIssueComment,
  deleteIssueCommentReactionById,
  deleteIssueReactionById,
  editIssueComment,
  getGithubAppSlugOrNull,
  getPreferredGithubActorLoginOrNull,
  getIssue,
  getIssueComment,
  listIssueCommentReactions,
  listIssueComments,
  listIssueReactions,
  type GithubReaction,
} from "../../github/github-api";

class SurfaceToolFailure extends TaggedError("SurfaceToolFailure")<{
  readonly message: string;
}> {}

function adaptSurfaceResultToToolHost<TValue>(
  result: ResultType<TValue, SurfaceToolFailure>,
): TValue {
  if (result.status === "ok") return result.value;
  throw new Error(result.error.message);
}

function signalSurfaceFailureToToolHost(message: string): never {
  return adaptSurfaceResultToToolHost(Result.err(new SurfaceToolFailure({ message })));
}

const surfaceClientSchema = z
  .enum(["discord", "github", "whatsapp", "slack", "telegram", "web"])
  .describe("Surface client/platform (required if request client is unknown / not provided)");

type SurfaceClient = z.infer<typeof surfaceClientSchema>;

function isSurfaceClient(x: string): x is SurfaceClient {
  return (
    x === "discord" ||
    x === "github" ||
    x === "whatsapp" ||
    x === "slack" ||
    x === "telegram" ||
    x === "web"
  );
}

function inferDiscordOriginFromRequestId(
  requestId: string | undefined,
): { sessionId: string; messageId: string } | null {
  if (!requestId) return null;
  const m = /^discord:([^:]+):([^:]+)$/.exec(requestId);
  if (!m) return null;
  return { sessionId: m[1]!, messageId: m[2]! };
}

function inferGithubOriginFromRequestId(
  requestId: string | undefined,
): { sessionId: string; messageId: string } | null {
  if (!requestId) return null;
  const parsed = parseGithubRequestId({ requestId });
  if (!parsed) return null;
  return { sessionId: parsed.sessionId, messageId: parsed.triggerId };
}

function resolveClient(params: {
  inputClient?: SurfaceClient;
  ctx?: RequestContext;
}): SurfaceClient {
  const ctxClientRaw = params.ctx?.requestClient;
  const ctxClient =
    typeof ctxClientRaw === "string" &&
    isAdapterPlatform(ctxClientRaw) &&
    isSurfaceClient(ctxClientRaw)
      ? ctxClientRaw
      : "unknown";

  if (ctxClient !== "unknown") {
    if (params.inputClient && params.inputClient !== ctxClient) {
      signalSurfaceFailureToToolHost(
        `Client mismatch: context requestClient is '${ctxClient}' but input client is '${params.inputClient}'`,
      );
    }
    // context is authoritative
    return ctxClient;
  }

  if (!params.inputClient) {
    signalSurfaceFailureToToolHost(
      "surface tool requires --client when request client is unknown (set LILAC_REQUEST_CLIENT or pass --client=<client>)",
    );
  }

  return params.inputClient;
}

function ensureDiscordClient(client: SurfaceClient): "discord" {
  if (client !== "discord") {
    signalSurfaceFailureToToolHost(
      `surface tool: client '${client}' is not supported yet (supported: 'discord', 'github')`,
    );
  }
  return "discord";
}

function mustDiscordSurfaceConfig(cfg: CoreConfig) {
  const discord = cfg.surface.discord;
  if (!discord) signalSurfaceFailureToToolHost("surface.discord config missing");
  return discord;
}

function shouldAllowDiscordChannel(params: {
  cfg: CoreConfig;
  channelId: string;
  guildId?: string | null;
}): boolean {
  const discord = mustDiscordSurfaceConfig(params.cfg);

  const allowedChannelIds = new Set(discord.allowedChannelIds);
  const allowedGuildIds = new Set(discord.allowedGuildIds);

  if (allowedChannelIds.size === 0 && allowedGuildIds.size === 0) return false;

  if (allowedChannelIds.has(params.channelId)) return true;

  const gid = params.guildId ?? null;
  if (gid && allowedGuildIds.has(gid)) return true;

  return false;
}

function asDiscordSessionRef(
  channelId: string,
  guildId?: string,
  parentChannelId?: string,
): SessionRef {
  return {
    platform: "discord",
    channelId,
    guildId,
    parentChannelId,
  };
}

function asDiscordMsgRef(channelId: string, messageId: string): MsgRef {
  return { platform: "discord", channelId, messageId };
}

function asGithubSessionRef(sessionId: string): SessionRef {
  return { platform: "github", channelId: sessionId };
}

function asGithubMsgRef(sessionId: string, messageId: string): MsgRef {
  return { platform: "github", channelId: sessionId, messageId };
}

function parseIsoMs(iso: string | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

const GITHUB_REACTION_CONTENTS = [
  "+1",
  "-1",
  "laugh",
  "confused",
  "heart",
  "hooray",
  "rocket",
  "eyes",
] as const;

type GithubReactionContent = (typeof GITHUB_REACTION_CONTENTS)[number];

function githubReactionEmojiFromContent(content: string): string {
  switch (content) {
    case "+1":
      return "👍";
    case "-1":
      return "👎";
    case "laugh":
      return "😄";
    case "confused":
      return "😕";
    case "heart":
      return "❤️";
    case "hooray":
      return "🎉";
    case "rocket":
      return "🚀";
    case "eyes":
      return "👀";
    default:
      return content;
  }
}

function githubReactionContentFromInput(reaction: string): GithubReactionContent {
  const raw = reaction.trim();
  const alias = raw.startsWith(":") && raw.endsWith(":") ? raw.slice(1, -1) : raw;
  const normalized = alias.trim().toLowerCase();

  // Direct emoji shortcuts.
  switch (raw) {
    case "👍":
      return "+1";
    case "👎":
      return "-1";
    case "😄":
      return "laugh";
    case "😕":
      return "confused";
    case "❤️":
      return "heart";
    case "🎉":
      return "hooray";
    case "🚀":
      return "rocket";
    case "👀":
      return "eyes";
  }

  if (
    normalized === "+1" ||
    normalized === "thumbsup" ||
    normalized === "thumbs_up" ||
    normalized === "like"
  ) {
    return "+1";
  }
  if (
    normalized === "-1" ||
    normalized === "thumbsdown" ||
    normalized === "thumbs_down" ||
    normalized === "dislike"
  ) {
    return "-1";
  }
  if (normalized === "laugh" || normalized === "smile" || normalized === "grin") {
    return "laugh";
  }
  if (normalized === "confused" || normalized === "confusion" || normalized === "thinking") {
    return "confused";
  }
  if (normalized === "heart" || normalized === "love") {
    return "heart";
  }
  if (normalized === "hooray" || normalized === "tada" || normalized === "party") {
    return "hooray";
  }
  if (normalized === "rocket") {
    return "rocket";
  }
  if (normalized === "eyes") {
    return "eyes";
  }

  if ((GITHUB_REACTION_CONTENTS as readonly string[]).includes(normalized)) {
    return normalized as GithubReactionContent;
  }

  signalSurfaceFailureToToolHost(
    `Unsupported GitHub reaction '${reaction}'. Supported: ${GITHUB_REACTION_CONTENTS.join(", ")}, or emoji equivalents like 👍 👀 🚀`,
  );
}

const DEFAULT_OUTBOUND_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_OUTBOUND_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export async function loadLocalAttachments(params: {
  cwd: string;
  paths: string[];
  filenames?: string[];
  mimeTypes?: string[];
  context?: RequestContext | undefined;
}): Promise<SurfaceAttachment[]> {
  let totalBytes = 0;

  const out: SurfaceAttachment[] = [];

  for (let i = 0; i < params.paths.length; i++) {
    const inputPath = params.paths[i]!;
    const resolvedPath = resolveToolPathForRequestContext({
      cwd: params.cwd,
      inputPath,
      context: params.context,
    });

    const st = await fs.stat(resolvedPath);
    if (!st.isFile()) {
      signalSurfaceFailureToToolHost(
        `Not a file: ${formatToolPathForRequestContext({
          path: resolvedPath,
          context: params.context,
        })}`,
      );
    }

    if (st.size > DEFAULT_OUTBOUND_MAX_FILE_BYTES) {
      signalSurfaceFailureToToolHost(
        `Attachment too large (${st.size} bytes). Max is ${DEFAULT_OUTBOUND_MAX_FILE_BYTES} bytes: ${formatToolPathForRequestContext(
          {
            path: resolvedPath,
            context: params.context,
          },
        )}`,
      );
    }

    totalBytes += st.size;
    if (totalBytes > DEFAULT_OUTBOUND_MAX_TOTAL_BYTES) {
      signalSurfaceFailureToToolHost(
        `Total attachment bytes too large (${totalBytes} bytes). Max is ${DEFAULT_OUTBOUND_MAX_TOTAL_BYTES} bytes.`,
      );
    }

    const bytes = await fs.readFile(resolvedPath);

    const filename = (params.filenames && params.filenames[i]) ?? basename(resolvedPath);

    const typeFromBytes = await fileTypeFromBuffer(bytes);

    const mimeType =
      (params.mimeTypes && params.mimeTypes[i]) ??
      typeFromBytes?.mime ??
      inferMimeTypeFromFilename(filename);

    out.push({
      kind: mimeType.startsWith("image/") ? "image" : "file",
      mimeType,
      filename,
      bytes: new Uint8Array(bytes),
    });
  }

  return out;
}

type GuildIdResolver = {
  fetchGuildIdForChannel(channelId: string): Promise<string | null>;
};

type ReactionDetailsProvider = {
  listReactionDetails(msgRef: MsgRef): Promise<SurfaceReactionDetail[]>;
};

type SessionParticipantsProvider = {
  listSessionParticipants(
    sessionRef: SessionRef,
    opts?: { limit?: number },
  ): Promise<SurfaceSessionParticipantsResult>;
};

function hasGuildIdResolver(adapter: SurfaceAdapter): adapter is SurfaceAdapter & GuildIdResolver {
  return (
    "fetchGuildIdForChannel" in adapter && typeof adapter.fetchGuildIdForChannel === "function"
  );
}

function hasReactionDetailsProvider(
  adapter: SurfaceAdapter,
): adapter is SurfaceAdapter & ReactionDetailsProvider {
  return "listReactionDetails" in adapter && typeof adapter.listReactionDetails === "function";
}

function hasSessionParticipantsProvider(
  adapter: SurfaceAdapter,
): adapter is SurfaceAdapter & SessionParticipantsProvider {
  return (
    "listSessionParticipants" in adapter && typeof adapter.listSessionParticipants === "function"
  );
}

async function tryGetCachedSession(
  adapter: SurfaceAdapter,
  channelId: string,
): Promise<SurfaceSession | null> {
  const sessions = await adapter.listSessions();
  for (const s of sessions) {
    if (s.ref.platform !== "discord") continue;
    if (s.ref.channelId === channelId) return s;
  }
  return null;
}

async function resolveGuildIdForChannel(params: {
  adapter: SurfaceAdapter;
  channelId: string;
}): Promise<string | null> {
  const sess = await tryGetCachedSession(params.adapter, params.channelId);
  if (sess?.ref.platform === "discord") {
    return sess.ref.guildId ?? null;
  }

  if (hasGuildIdResolver(params.adapter)) {
    try {
      return await params.adapter.fetchGuildIdForChannel(params.channelId);
    } catch {
      return null;
    }
  }

  return null;
}

function buildDiscordUserAliasById(cfg: CoreConfig): Map<string, string> {
  const out = new Map<string, string>();
  const users = cfg.entity?.users ?? {};

  for (const [alias, rec] of Object.entries(users)) {
    const resolved = getDiscordUserAliasValue(rec);
    if (!resolved) continue;
    const userId = resolved.discordId;
    if (!out.has(userId)) {
      out.set(userId, alias);
    }
  }

  return out;
}

const baseInputSchema = z
  .object({
    client: surfaceClientSchema.optional(),
  })
  .strict();

const helpInputSchema = baseInputSchema;

const sessionsListLimitSchema = z
  .union([z.string(), z.number()])
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) return undefined;

    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
      ctx.addIssue({
        code: "custom",
        message: "Expected an integer from 1 to 1000.",
      });
      return z.NEVER;
    }

    return parsed;
  })
  .describe("Max sessions to return (default: all).");

function withDefaultSessionId(
  rawInput: Record<string, unknown>,
  ctx: RequestContext | undefined,
): Record<string, unknown> {
  const hasOwn = Object.prototype.hasOwnProperty.call(rawInput, "sessionId");
  const value = rawInput["sessionId"];

  // If explicitly provided (even null/empty), defer to schema validation.
  if (hasOwn && value !== undefined) return rawInput;

  const ctxSessionId =
    typeof ctx?.sessionId === "string" && ctx.sessionId.length > 0
      ? ctx.sessionId
      : (inferDiscordOriginFromRequestId(ctx?.requestId)?.sessionId ??
        inferGithubOriginFromRequestId(ctx?.requestId)?.sessionId);

  if (ctxSessionId) {
    return { ...rawInput, sessionId: ctxSessionId };
  }

  signalSurfaceFailureToToolHost(
    "surface tool requires --session-id when request session is unknown (set LILAC_SESSION_ID or pass --session-id=<id>)",
  );
}

function withDefaultMessageId(
  rawInput: Record<string, unknown>,
  ctx: RequestContext | undefined,
): Record<string, unknown> {
  const hasOwn = Object.prototype.hasOwnProperty.call(rawInput, "messageId");
  const value = rawInput["messageId"];

  // If explicitly provided (even null/empty), defer to schema validation.
  if (hasOwn && value !== undefined) return rawInput;

  const inferred = inferDiscordOriginFromRequestId(ctx?.requestId);
  if (inferred?.messageId) return { ...rawInput, messageId: inferred.messageId };

  const inferredGh = inferGithubOriginFromRequestId(ctx?.requestId);
  if (inferredGh?.messageId) return { ...rawInput, messageId: inferredGh.messageId };

  const rid = typeof ctx?.requestId === "string" ? ctx.requestId : undefined;
  const hint = rid ? ` (requestId='${rid}')` : " (no requestId in context)";

  signalSurfaceFailureToToolHost(
    `surface tool requires --message-id when origin message is unknown${hint}. ` +
      "This is expected for active-mode gated batches (requestId like 'req:<uuid>'); pass --message-id explicitly.",
  );
}

function mustPresentString(v: unknown, label: string): string {
  if (typeof v === "string" && v.length > 0) return v;
  signalSurfaceFailureToToolHost(`surface tool internal error: missing ${label}`);
}

type SurfaceMessageAttachmentKind = "image" | "video" | "audio" | "file";

type SurfaceMessageAttachmentMeta = {
  url: string;
  kind: SurfaceMessageAttachmentKind;
  filename?: string;
  mimeType?: string;
  size?: number;
};

const surfaceMessageAttachmentMetaSchema = z.object({
  url: z.string().min(1),
  filename: z.string().optional(),
  name: z.string().optional(),
  mimeType: z.string().optional(),
  contentType: z.string().optional(),
  size: z.number().finite().optional(),
});

const discordMessageTypeMetaSchema = z.object({
  discord: z.object({
    type: z.number().finite().optional(),
    typeName: z.string().optional(),
    system: z.boolean().optional(),
    isChat: z.boolean().optional(),
  }),
});

type SurfaceMessageAttachmentHints = {
  hasAttachments: boolean;
  attachmentCount: number;
  hasMedia: boolean;
  mediaCount: number;
  mediaKinds: SurfaceMessageAttachmentKind[];
};

type SurfaceMessageReference = {
  messageId?: string;
  channelId?: string;
  guildId?: string;
  type?: number;
};

function normalizeMimeTypeForAttachment(mimeType: string): string | undefined {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function inferAttachmentMimeType(params: {
  mimeType?: string;
  filename?: string;
  url: string;
}): string | undefined {
  if (params.mimeType) {
    const normalized = normalizeMimeTypeForAttachment(params.mimeType);
    if (normalized) return normalized;
  }

  if (params.filename) {
    const inferred = inferMimeTypeFromFilename(params.filename);
    if (inferred !== "application/octet-stream") return inferred;
  }

  const basenameFromUrl = URL.canParse(params.url)
    ? (() => {
        const pathBasename = basename(new URL(params.url).pathname);
        return pathBasename.length > 0 ? pathBasename : undefined;
      })()
    : undefined;

  if (basenameFromUrl) {
    const inferred = inferMimeTypeFromFilename(basenameFromUrl);
    if (inferred !== "application/octet-stream") return inferred;
  }

  return undefined;
}

function attachmentKindFromMimeType(mimeType: string | undefined): SurfaceMessageAttachmentKind {
  if (!mimeType) return "file";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

function normalizeAttachmentMeta(input: unknown): SurfaceMessageAttachmentMeta | null {
  const decoded = surfaceMessageAttachmentMetaSchema.safeParse(input);
  if (!decoded.success) return null;
  const attachment = decoded.data;
  const url = attachment.url;

  const filename = attachment.filename ?? attachment.name;

  const rawMimeType = attachment.mimeType ?? attachment.contentType;

  const mimeType = inferAttachmentMimeType({
    mimeType: rawMimeType,
    filename,
    url,
  });

  const size = attachment.size;

  return {
    url,
    kind: attachmentKindFromMimeType(mimeType),
    ...(filename ? { filename } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(size !== undefined ? { size } : {}),
  };
}

function extractAttachmentMetaFromList(list: readonly unknown[]): SurfaceMessageAttachmentMeta[] {
  const out: SurfaceMessageAttachmentMeta[] = [];
  for (const item of list) {
    const normalized = normalizeAttachmentMeta(item);
    if (normalized) out.push(normalized);
  }
  return out;
}

function getDiscordReferenceFromRaw(raw: unknown): SurfaceMessageReference | null {
  const normalized = normalizeDiscordRaw(raw);
  if (!normalized) return null;

  const ref = normalized.replyReference ?? normalized.reference;
  if (!ref) return null;

  return {
    ...(ref.messageId ? { messageId: ref.messageId } : {}),
    ...(ref.channelId ? { channelId: ref.channelId } : {}),
    ...(ref.guildId ? { guildId: ref.guildId } : {}),
    type: normalized.referenceType,
  };
}

function extractDiscordAttachmentMetaFromRaw(raw: unknown): SurfaceMessageAttachmentMeta[] {
  const normalized = normalizeDiscordRaw(raw);
  if (!normalized) return [];

  const snapshotAttachments = normalized.forwardSnapshot?.attachments;
  const attachments =
    snapshotAttachments && snapshotAttachments.length > 0
      ? snapshotAttachments
      : normalized.attachments;
  return extractAttachmentMetaFromList(attachments);
}

function getMessageAttachmentMeta(msg: SurfaceMessage): SurfaceMessageAttachmentMeta[] {
  if (msg.session.platform === "discord") {
    return extractDiscordAttachmentMetaFromRaw(msg.raw);
  }
  return [];
}

function getSurfaceMessageRichText(msg: SurfaceMessage): string {
  if (msg.session.platform === "discord") {
    return getDiscordSurfaceDisplayText({
      raw: msg.raw,
      fallbackText: msg.text,
    });
  }

  return msg.text;
}

function buildAttachmentHints(
  attachments: readonly SurfaceMessageAttachmentMeta[],
): SurfaceMessageAttachmentHints {
  const mediaFiles = attachments.filter((a) => a.kind !== "file");
  return {
    hasAttachments: attachments.length > 0,
    attachmentCount: attachments.length,
    hasMedia: mediaFiles.length > 0,
    mediaCount: mediaFiles.length,
    mediaKinds: Array.from(new Set(mediaFiles.map((a) => a.kind))),
  };
}

function getDiscordMessageTypeMetaFromRaw(raw: unknown): {
  typeId?: number;
  typeName?: string;
  isSystem?: boolean;
  isChat?: boolean;
} | null {
  const decoded = discordMessageTypeMetaSchema.safeParse(raw);
  if (!decoded.success) return null;
  const discord = decoded.data.discord;
  const typeId = discord.type;
  const typeName = discord.typeName;
  const isSystem = discord.system;
  const isChat = discord.isChat;

  if (
    typeId === undefined &&
    typeName === undefined &&
    isSystem === undefined &&
    isChat === undefined
  ) {
    return null;
  }

  return { typeId, typeName, isSystem, isChat };
}

function getDiscordMessageKind(meta: {
  isSystem?: boolean;
  isChat?: boolean;
}): "chat" | "system" | "unknown" {
  if (meta.isChat === true) return "chat";
  if (meta.isSystem === true) return "system";
  return "unknown";
}

function surfaceMessageKey(msg: SurfaceMessage): string {
  return `${msg.ref.channelId}:${msg.ref.messageId}`;
}

function isDiscordThreadStarterMessage(
  meta: { typeId?: number; typeName?: string } | null,
): boolean {
  return meta?.typeId === 21 || meta?.typeName === "ThreadStarterMessage";
}

async function resolveDiscordReferencedMessage(input: {
  adapter: SurfaceAdapter;
  cfg: CoreConfig;
  message: SurfaceMessage;
  alreadyFetchedByKey?: Map<string, SurfaceMessage>;
  fetchedReferenceByKey?: Map<string, Promise<SurfaceMessage | null>>;
}): Promise<SurfaceMessage | null> {
  const msg = input.message;
  if (msg.session.platform !== "discord") return null;

  const ref = getDiscordReferenceFromRaw(msg.raw);
  if (!ref?.messageId) return null;

  const referenceType = ref.type ?? DISCORD_REFERENCE_TYPE_DEFAULT;
  if (referenceType === DISCORD_REFERENCE_TYPE_FORWARD) return null;

  const meta = getDiscordMessageTypeMetaFromRaw(msg.raw);
  const refChannelId = ref.channelId ?? msg.session.channelId;
  const isSameSession = refChannelId === msg.session.channelId;
  const isThreadStarterParentReference =
    isDiscordThreadStarterMessage(meta) &&
    typeof msg.session.parentChannelId === "string" &&
    refChannelId === msg.session.parentChannelId;

  if (!isSameSession && !isThreadStarterParentReference) return null;

  if (
    !shouldAllowDiscordChannel({
      cfg: input.cfg,
      channelId: refChannelId,
      guildId: ref.guildId ?? msg.session.guildId,
    })
  ) {
    return null;
  }

  const targetKey = `${refChannelId}:${ref.messageId}`;
  const alreadyFetched = input.alreadyFetchedByKey?.get(targetKey);
  if (alreadyFetched) return alreadyFetched;

  let referencedPromise = input.fetchedReferenceByKey?.get(targetKey);
  if (!referencedPromise) {
    referencedPromise = input.adapter
      .readMsg({
        platform: "discord",
        channelId: refChannelId,
        messageId: ref.messageId,
      })
      .catch(() => null);
    input.fetchedReferenceByKey?.set(targetKey, referencedPromise);
  }

  const referenced = await referencedPromise;

  if (!referenced || referenced.session.platform !== "discord") return null;

  if (
    !shouldAllowDiscordChannel({
      cfg: input.cfg,
      channelId: referenced.session.channelId,
      guildId: referenced.session.guildId,
    })
  ) {
    return null;
  }

  return referenced;
}

async function mapWithConcurrency<T, R>(input: {
  items: readonly T[];
  concurrency: number;
  run: (item: T, index: number) => Promise<R>;
}): Promise<R[]> {
  const concurrency = Math.max(1, Math.floor(input.concurrency));
  const out = Array.from({ length: input.items.length }) as R[];
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, input.items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= input.items.length) return;
      out[index] = await input.run(input.items[index]!, index);
    }
  });

  await Promise.all(workers);
  return out;
}

async function resolveDiscordReferencedMessages(input: {
  adapter: SurfaceAdapter;
  cfg: CoreConfig;
  messages: readonly SurfaceMessage[];
}): Promise<Map<string, SurfaceMessage>> {
  const out = new Map<string, SurfaceMessage>();
  const alreadyFetchedByKey = new Map<string, SurfaceMessage>();
  const fetchedReferenceByKey = new Map<string, Promise<SurfaceMessage | null>>();

  for (const message of input.messages) {
    alreadyFetchedByKey.set(surfaceMessageKey(message), message);
  }

  await mapWithConcurrency({
    items: input.messages,
    concurrency: 8,
    run: async (message) => {
      const referenced = await resolveDiscordReferencedMessage({
        adapter: input.adapter,
        cfg: input.cfg,
        message,
        alreadyFetchedByKey,
        fetchedReferenceByKey,
      });
      if (referenced) out.set(surfaceMessageKey(message), referenced);
    },
  });

  return out;
}

const MESSAGE_LIST_ORDER_SCHEMA = z.enum(["ts_asc", "ts_desc"]);
type MessageListOrder = z.infer<typeof MESSAGE_LIST_ORDER_SCHEMA>;

const MESSAGE_SEARCH_ORDER_SCHEMA = z.enum(["relevance", "ts_asc", "ts_desc"]);
type MessageSearchOrder = z.infer<typeof MESSAGE_SEARCH_ORDER_SCHEMA>;

function compareMessageIdLike(a: string, b: string): number {
  if (/^\d+$/u.test(a) && /^\d+$/u.test(b)) {
    const ai = BigInt(a);
    const bi = BigInt(b);
    if (ai < bi) return -1;
    if (ai > bi) return 1;
    return 0;
  }
  return a.localeCompare(b);
}

function compareSurfaceMessageChronological(a: SurfaceMessage, b: SurfaceMessage): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return compareMessageIdLike(a.ref.messageId, b.ref.messageId);
}

function sortSurfaceMessages(
  messages: readonly SurfaceMessage[],
  order: MessageListOrder,
): SurfaceMessage[] {
  const sorted = [...messages].sort(compareSurfaceMessageChronological);
  if (order === "ts_desc") sorted.reverse();
  return sorted;
}

type SessionMeta = {
  platform: string;
  channelId: string;
  alias?: string;
  guildId?: string;
  parentChannelId?: string;
};

function toSessionMeta(session: SessionRef, cfg?: CoreConfig): SessionMeta {
  const alias =
    cfg && session.platform === "discord"
      ? bestEffortAliasForDiscordChannelId({
          channelId: session.channelId,
          cfg,
        })
      : undefined;

  if (session.platform === "discord") {
    return {
      platform: session.platform,
      channelId: session.channelId,
      alias,
      guildId: session.guildId,
      parentChannelId: session.parentChannelId,
    };
  }
  return {
    platform: session.platform,
    channelId: session.channelId,
    alias,
  };
}

function toPreviewText(text: string, maxChars = 128): { preview: string; truncated: boolean } {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return {
      preview: compact,
      truncated: false,
    };
  }

  return {
    preview: compact.slice(0, maxChars),
    truncated: true,
  };
}

function toCompactMessage(
  msg: SurfaceMessage,
  opts: { includeRaw: boolean; includeAttachments: boolean; referenced?: SurfaceMessage },
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    messageId: msg.ref.messageId,
    userId: msg.userId,
    userName: msg.userName,
    richText: getSurfaceMessageRichText(msg),
    ts: msg.ts,
  };

  if (typeof msg.editedTs === "number") out["editedTs"] = msg.editedTs;
  if (typeof msg.deleted === "boolean") out["deleted"] = msg.deleted;

  if (msg.session.platform === "discord") {
    const meta = getDiscordMessageTypeMetaFromRaw(msg.raw);
    if (meta) {
      if (typeof meta.typeName === "string") out["platformMessageType"] = meta.typeName;
      else if (typeof meta.typeId === "number") out["platformMessageType"] = String(meta.typeId);
      out["platformMessageKind"] = getDiscordMessageKind(meta);
      if (opts.includeRaw) {
        if (typeof meta.typeId === "number") out["platformMessageTypeId"] = meta.typeId;
        if (typeof meta.isSystem === "boolean") out["platformIsSystem"] = meta.isSystem;
        if (typeof meta.isChat === "boolean") out["platformIsChat"] = meta.isChat;
      }
    }
  }

  const attachments = getMessageAttachmentMeta(msg);
  const mediaFiles = attachments.filter((a) => a.kind !== "file");
  const hints = buildAttachmentHints(attachments);

  out["attachmentCount"] = hints.attachmentCount;
  out["mediaCount"] = hints.mediaCount;
  out["mediaKinds"] = hints.mediaKinds;

  if (opts.includeRaw) {
    out["hasAttachments"] = hints.hasAttachments;
    out["hasMedia"] = hints.hasMedia;
  }

  if (opts.includeAttachments) {
    out["attachments"] = attachments;
    out["mediaFiles"] = mediaFiles;
  }

  if (opts.includeRaw && msg.raw !== undefined) {
    out["raw"] = msg.raw;
  }

  if (opts.referenced) {
    out["referenced"] = toCompactMessage(opts.referenced, {
      includeRaw: opts.includeRaw,
      includeAttachments: opts.includeAttachments,
    });
  }

  return out;
}

function buildMessagesListOutput(params: {
  session: SessionRef;
  cfg?: CoreConfig;
  messages: readonly SurfaceMessage[];
  order: MessageListOrder;
  includeRaw: boolean;
  includeAttachments: boolean;
  referencedByMessageKey?: Map<string, SurfaceMessage>;
}): {
  meta: {
    session: SessionMeta;
    order: MessageListOrder;
    count: number;
  };
  messages: Record<string, unknown>[];
} {
  const sorted = sortSurfaceMessages(params.messages, params.order);
  const session = sorted[0]?.session ?? params.session;

  return {
    meta: {
      session: toSessionMeta(session, params.cfg),
      order: params.order,
      count: sorted.length,
    },
    messages: sorted.map((msg) =>
      toCompactMessage(msg, {
        includeRaw: params.includeRaw,
        includeAttachments: params.includeAttachments,
        referenced: params.referencedByMessageKey?.get(surfaceMessageKey(msg)),
      }),
    ),
  };
}

function buildMessagesReadOutput(params: {
  session: SessionRef;
  cfg?: CoreConfig;
  message: SurfaceMessage | null;
  referenced?: SurfaceMessage | null;
  includeRaw: boolean;
}): {
  meta: {
    session: SessionMeta;
  };
  message: Record<string, unknown> | null;
} {
  const session = params.message?.session ?? params.session;
  return {
    meta: {
      session: toSessionMeta(session, params.cfg),
    },
    message: params.message
      ? toCompactMessage(params.message, {
          includeRaw: params.includeRaw,
          includeAttachments: true,
          referenced: params.referenced ?? undefined,
        })
      : null,
  };
}

const sessionsListInputSchema = baseInputSchema
  .extend({
    limit: sessionsListLimitSchema,
  })
  .strict();

const activitiesRecentAgentWritesInputSchema = baseInputSchema.extend({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Max recent writes to return (default: 20)."),
});

const sessionsListParticipantsInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target session/channel. If omitted, defaults to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
    ),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(2000)
    .optional()
    .describe("Max participants (default: 200)."),
});

const messagesListInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target session/channel. If omitted, defaults to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
    ),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Max messages (default: 50)"),
  beforeMessageId: z
    .string()
    .min(1)
    .optional()
    .describe("Optional message id cursor (list messages before this id)"),
  afterMessageId: z
    .string()
    .min(1)
    .optional()
    .describe("Optional message id cursor (list messages after this id)"),
  order: MESSAGE_LIST_ORDER_SCHEMA.optional().describe(
    "Optional sort order for returned messages (default: ts_desc).",
  ),
  includeRaw: z.coerce
    .boolean()
    .optional()
    .describe("Include raw platform payloads (default: false)."),
  includeAttachments: z.coerce
    .boolean()
    .optional()
    .describe(
      "Include full attachment/media metadata arrays (default: false; list always includes attachment/media hints).",
    ),
});

const messagesReadInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target session/channel. If omitted, defaults to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
    ),
  messageId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target message id. If omitted, may default to the origin message when requestId encodes it (e.g. 'discord:<sessionId>:<messageId>' or 'github:<OWNER/REPO#N>:<triggerId>').",
    ),
  includeRaw: z.coerce
    .boolean()
    .optional()
    .describe("Include raw platform payloads (default: false)."),
});

const messagesSearchInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target session/channel. If omitted, defaults to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
    ),
  query: z.string().min(1).describe("Search query (full-text, session-scoped)."),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Max matches (default: 20, max: 100)"),
  order: MESSAGE_SEARCH_ORDER_SCHEMA.optional().describe(
    "Sort order for hits (default: relevance).",
  ),
});

const optionalNonEmptyStringListInputSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(10)])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value : [value];
  });

const messagesSendInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target session/channel. If omitted, defaults to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
    ),
  text: z.string().min(1),
  replyToMessageId: z.string().min(1).optional(),
  silent: z.coerce
    .boolean()
    .optional()
    .describe("Disable all notifications for this message (mentions + reply ping)."),
  paths: optionalNonEmptyStringListInputSchema.describe(
    "Local file paths to attach (resolved relative to request cwd)",
  ),
  filenames: optionalNonEmptyStringListInputSchema.describe(
    "Optional filenames for each attachment",
  ),
  mimeTypes: optionalNonEmptyStringListInputSchema.describe(
    "Optional mime types for each attachment",
  ),
});

const messagesEditInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target session/channel. If omitted, defaults to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
    ),
  messageId: z.string().min(1),
  text: z.string().min(1),
});

const messagesDeleteInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target session/channel. If omitted, defaults to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
    ),
  messageId: z.string().min(1),
});

const reactionsListInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target session/channel. If omitted, defaults to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
    ),
  messageId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target message id. If omitted, may default to the origin message when requestId encodes it (e.g. 'discord:<sessionId>:<messageId>' or 'github:<OWNER/REPO#N>:<triggerId>').",
    ),
});

const reactionsListDetailedInputSchema = reactionsListInputSchema;

const reactionsAddInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target session/channel. If omitted, defaults to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
    ),
  messageId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target message id. If omitted, may default to the origin message when requestId encodes it (e.g. 'discord:<sessionId>:<messageId>' or 'github:<OWNER/REPO#N>:<triggerId>').",
    ),
  reaction: z.string().min(1).describe("Reaction emoji (e.g. 👍, ✅, :custom_emoji:)"),
});

const reactionsRemoveInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target session/channel. If omitted, defaults to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
    ),
  messageId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target message id. If omitted, may default to the origin message when requestId encodes it (e.g. 'discord:<sessionId>:<messageId>' or 'github:<OWNER/REPO#N>:<triggerId>').",
    ),
  reaction: z.string().min(1).describe("Reaction emoji (e.g. 👍, ✅, :custom_emoji:)"),
});

const defaultGithubApi = {
  getIssue,
  listIssueComments,
  createIssueComment,
  getIssueComment,
  editIssueComment,
  deleteIssueComment,

  createIssueReaction,
  createIssueCommentReaction,
  listIssueReactions,
  listIssueCommentReactions,
  deleteIssueReactionById,
  deleteIssueCommentReactionById,
  getGithubAppSlugOrNull,
  getPreferredGithubActorLoginOrNull,
};
export type GithubSurfaceApi = Omit<
  typeof defaultGithubApi,
  "getPreferredGithubActorLoginOrNull"
> & {
  getPreferredGithubActorLoginOrNull?: typeof getPreferredGithubActorLoginOrNull;
};

type SurfaceCallOptions = {
  signal?: AbortSignal;
  context?: RequestContext;
  messages?: readonly unknown[];
};

type SurfaceCallableEntry = {
  callableId: string;
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  primaryPositional?: {
    field: string;
  };
  hidden?: boolean;
  handler: (input: Record<string, unknown>, opts: SurfaceCallOptions) => Promise<unknown>;
};

export class Surface implements ServerTool {
  id = "surface";

  constructor(
    private readonly params: {
      adapter: SurfaceAdapter;
      githubApi?: GithubSurfaceApi;
      config?: CoreConfig;
      getConfig?: () => Promise<CoreConfig>;
      discordSearch?: DiscordSearchService;
      transcriptStore?: TranscriptStore;
    },
  ) {}

  async init(): Promise<void> {}
  async destroy(): Promise<void> {}

  async list() {
    return this.surfaceCallableEntries().map((entry) => ({
      callableId: entry.callableId,
      name: entry.name,
      description: entry.description,
      shortInput: zodObjectToCliLines(entry.inputSchema, {
        mode: "required",
      }),
      input: zodObjectToCliLines(entry.inputSchema),
      ...(entry.primaryPositional ? { primaryPositional: entry.primaryPositional } : {}),
      ...(entry.hidden !== undefined ? { hidden: entry.hidden } : {}),
    }));
  }

  private surfaceCallableEntries(): SurfaceCallableEntry[] {
    return [
      {
        callableId: "surface.help",
        name: "Surface Help",
        description:
          "Explain surface terminology (client/platform/sessionId/messageId) and common sessionId formats.",
        inputSchema: helpInputSchema,
        handler: (input, opts) => this.callHelp(input, opts.context),
      },
      {
        callableId: "surface.activities.recentAgentWrites",
        name: "Surface Activities Recent Agent Writes",
        description:
          "List recent visible writes produced by the agent, with session ids, message ids, and thin previews.",
        inputSchema: activitiesRecentAgentWritesInputSchema,
        handler: (input) => this.callActivitiesRecentAgentWrites(input),
      },
      {
        callableId: "surface.sessions.list",
        name: "Surface Sessions List",
        description: "List cached sessions. Provide --client if request client is unknown.",
        inputSchema: sessionsListInputSchema,
        handler: (input, opts) => this.callSessionsList(input, opts.context),
      },
      {
        callableId: "surface.sessions.listParticipants",
        name: "Surface Sessions List Participants",
        description:
          "List current Discord session participants (thread members when available; otherwise guild members).",
        inputSchema: sessionsListParticipantsInputSchema,
        handler: (input, opts) => this.callSessionsListParticipants(input, opts.context),
      },
      {
        callableId: "surface.messages.list",
        name: "Surface Messages List",
        description: "List messages for a session.",
        inputSchema: messagesListInputSchema,
        handler: (input, opts) => this.callMessagesList(input, opts.context),
      },
      {
        callableId: "surface.messages.read",
        name: "Surface Messages Read",
        description: "Read a message by id.",
        inputSchema: messagesReadInputSchema,
        handler: (input, opts) => this.callMessagesRead(input, opts.context),
      },
      {
        callableId: "surface.messages.search",
        name: "Surface Messages Search",
        description:
          "Deprecated: search indexed messages in a single Discord session. Prefer discovery.search for memory retrieval.",
        inputSchema: messagesSearchInputSchema,
        primaryPositional: {
          field: "query",
        },
        hidden: true,
        handler: (input, opts) => this.callMessagesSearch(input, opts.context),
      },
      {
        callableId: "surface.messages.send",
        name: "Surface Messages Send",
        description: "Send a message to a session.",
        inputSchema: messagesSendInputSchema,
        primaryPositional: {
          field: "text",
        },
        handler: (input, opts) => this.callMessagesSend(input, opts.context),
      },
      {
        callableId: "surface.messages.edit",
        name: "Surface Messages Edit",
        description: "Edit a message.",
        inputSchema: messagesEditInputSchema,
        handler: (input, opts) => this.callMessagesEdit(input, opts.context),
      },
      {
        callableId: "surface.messages.delete",
        name: "Surface Messages Delete",
        description: "Delete a message.",
        inputSchema: messagesDeleteInputSchema,
        handler: (input, opts) => this.callMessagesDelete(input, opts.context),
      },
      {
        callableId: "surface.reactions.list",
        name: "Surface Reactions List",
        description: "List reactions for a message (emoji + count).",
        inputSchema: reactionsListInputSchema,
        handler: (input, opts) => this.callReactionsList(input, opts.context),
      },
      {
        callableId: "surface.reactions.listDetailed",
        name: "Surface Reactions List Detailed",
        description: "List reactions for a message with per-user details.",
        inputSchema: reactionsListDetailedInputSchema,
        handler: (input, opts) => this.callReactionsListDetailed(input, opts.context),
      },
      {
        callableId: "surface.reactions.add",
        name: "Surface Reactions Add",
        description: "Add a reaction to a message.",
        inputSchema: reactionsAddInputSchema,
        handler: (input, opts) => this.callReactionsAdd(input, opts.context),
      },
      {
        callableId: "surface.reactions.remove",
        name: "Surface Reactions Remove",
        description: "Remove a reaction from a message.",
        inputSchema: reactionsRemoveInputSchema,
        handler: (input, opts) => this.callReactionsRemove(input, opts.context),
      },
    ];
  }

  async call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: SurfaceCallOptions,
  ): Promise<unknown> {
    const entry = this.surfaceCallableEntries().find((item) => item.callableId === callableId);
    if (!entry) signalSurfaceFailureToToolHost(`Invalid callable ID '${callableId}'`);
    return await entry.handler(input, opts ?? {});
  }

  private async callHelp(rawInput: Record<string, unknown>, ctx: RequestContext | undefined) {
    const input = parseToolInput({
      callableId: "surface.help",
      input: rawInput,
      schema: helpInputSchema,
    });

    const ctxClientRaw = ctx?.requestClient;
    const ctxClient = isAdapterPlatform(ctxClientRaw) ? ctxClientRaw : "unknown";
    const effectiveClient = input.client ?? (ctxClient !== "unknown" ? ctxClient : undefined);
    const cfg = await this.getCfg();
    const contextSessionId = typeof ctx?.sessionId === "string" ? ctx.sessionId : null;
    const contextAlias =
      contextSessionId !== null && (ctxClient === "discord" || effectiveClient === "discord")
        ? bestEffortAliasForDiscordChannelId({
            channelId: contextSessionId,
            cfg,
          })
        : undefined;

    let sessionIdFormats;
    switch (effectiveClient) {
      case undefined:
      case "discord":
        sessionIdFormats = {
          client: "discord" as const,
          accepted: [
            {
              format: "123456789012345678",
              meaning: "Raw Discord channel id",
            },
            {
              format: "<#123456789012345678>",
              meaning: "Discord channel mention",
            },
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
        };
        break;
      case "github":
        sessionIdFormats = {
          client: "github" as const,
          accepted: [
            {
              format: "OWNER/REPO#123",
              meaning: "GitHub issue/PR thread",
            },
          ],
          notes: [
            "surface.sessions.list is not implemented for GitHub; use gh to discover issues/PRs.",
            "For GitHub triggers, surface tools can default sessionId/messageId from requestId when it is 'github:<OWNER/REPO#N>:<triggerId>'.",
          ],
        };
        break;
      case "whatsapp":
      case "slack":
      case "telegram":
      case "web":
        sessionIdFormats = {
          client: effectiveClient,
          accepted: [],
          notes: ["Only Discord and GitHub are implemented today."],
        };
        break;
    }

    return {
      tool: "surface" as const,
      supportedClients: ["discord", "github"] as const,
      context: {
        requestClient: ctxClient,
        sessionId: contextSessionId,
        alias: contextAlias,
      },
      terminology: {
        client:
          "Surface client/platform. If the request context has a known client (LILAC_REQUEST_CLIENT), --client is optional; otherwise pass --client explicitly.",
        session:
          "A conversation container. For Discord, a session maps to a channel; for GitHub, a session maps to an issue/PR thread.",
        sessionId:
          "The CLI/session selector used by most surface.* tools. If omitted, surface tools default to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
        alias:
          "Human-friendly Discord session alias from cfg.entity.sessions.discord. Prefer aliases over raw channel ids when available.",
        messageId:
          "A platform-specific message identifier inside a session/channel. Many surface tools can default this to the origin message when requestId is 'discord:<sessionId>:<messageId>' or 'github:<OWNER/REPO#N>:<triggerId>'.",
        replyToMessageId: "When sending a message, optionally reply to an existing messageId.",
        silent: "When true, suppress all notifications for this send (mentions + reply ping).",
        attachments:
          "Outbound: local files attached to a send (paths resolved relative to request cwd). Inbound: message attachment/media metadata is first-class on surface.messages.read and hinted on surface.messages.list.",
      },
      sessionIdFormats,
      relatedConfigKeys: {
        requestClientEnv: "LILAC_REQUEST_CLIENT",
        sessionIdEnv: "LILAC_SESSION_ID",
        discordSessionAliases: "cfg.entity.sessions.discord",
        surfaceAllowlistChannels: "cfg.surface.discord.allowedChannelIds",
        surfaceAllowlistGuilds: "cfg.surface.discord.allowedGuildIds",
      },
    };
  }

  private async getCfg(): Promise<CoreConfig> {
    if (this.params.config) return this.params.config;
    if (this.params.getConfig) return this.params.getConfig();
    signalSurfaceFailureToToolHost(
      "surface tool requires core config (tool server must be started with config)",
    );
  }

  private gh(): GithubSurfaceApi {
    return this.params.githubApi ?? defaultGithubApi;
  }

  private async readRecentAgentWriteText(row: RecentAgentWriteSnapshot): Promise<string> {
    if (row.client === "discord") {
      const msg = await this.params.adapter.readMsg(asDiscordMsgRef(row.sessionId, row.messageId));
      return msg?.text ?? row.finalText ?? "";
    }

    if (row.client === "github") {
      const thread = parseGithubSessionId(row.sessionId);

      if (
        isGithubIssueTriggerId({
          sessionId: row.sessionId,
          triggerId: row.messageId,
        })
      ) {
        const issue = await this.gh().getIssue({
          owner: thread.owner,
          repo: thread.repo,
          number: thread.number,
        });

        return typeof issue.body === "string" ? issue.body : (row.finalText ?? "");
      }

      const commentId = Number(row.messageId);
      if (!Number.isFinite(commentId) || commentId <= 0) {
        return row.finalText ?? "";
      }

      const comment = await this.gh().getIssueComment({
        owner: thread.owner,
        repo: thread.repo,
        commentId,
      });

      return typeof comment.body === "string" ? comment.body : (row.finalText ?? "");
    }

    return row.finalText ?? "";
  }

  private linkSentMessageToTranscript(ref: MsgRef, ctx: RequestContext | undefined): void {
    const requestId = ctx?.requestId;
    if (!requestId || !this.params.transcriptStore) return;
    if (!ctx?.sessionId || !isHeartbeatSessionId(ctx.sessionId)) return;

    try {
      this.params.transcriptStore.linkSurfaceMessagesToRequest({
        requestId,
        created: [ref],
        last: ref,
      });
    } catch {
      // Best-effort only. Do not fail the send on transcript linkage issues.
    }
  }

  private async callActivitiesRecentAgentWrites(rawInput: Record<string, unknown>) {
    const input = parseToolInput({
      callableId: "surface.activities.recentAgentWrites",
      input: rawInput,
      schema: activitiesRecentAgentWritesInputSchema,
    });
    const transcriptStore = this.params.transcriptStore;

    if (!transcriptStore?.listRecentAgentWrites) {
      signalSurfaceFailureToToolHost(
        "surface.activities.recentAgentWrites is unavailable: transcript store is not initialized.",
      );
    }

    const cfg = await this.getCfg();
    const targetLimit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 20)));

    const out: Array<{
      sessionId: string;
      messageId: string;
      alias?: string;
      client: string;
      requestId: string;
      preview: string;
      updatedTs: number;
      truncated: boolean;
    }> = [];

    let offset = 0;
    const pageSize = Math.min(200, Math.max(targetLimit, 20));

    while (out.length < targetLimit) {
      const rows = transcriptStore.listRecentAgentWrites({
        limit: pageSize,
        offset,
        client: input.client,
      });
      if (rows.length === 0) break;

      offset += rows.length;

      for (const row of rows) {
        if (row.client === "discord") {
          const guildId = await resolveGuildIdForChannel({
            adapter: this.params.adapter,
            channelId: row.sessionId,
          });

          if (
            !shouldAllowDiscordChannel({
              cfg,
              channelId: row.sessionId,
              guildId,
            })
          ) {
            continue;
          }
        }

        let text = row.finalText ?? "";
        try {
          text = await this.readRecentAgentWriteText(row);
        } catch {
          // Fall back to persisted finalText when the backing message cannot be fetched.
        }

        const preview = toPreviewText(text);

        out.push({
          sessionId: row.sessionId,
          messageId: row.messageId,
          alias:
            row.client === "discord"
              ? bestEffortAliasForDiscordChannelId({
                  channelId: row.sessionId,
                  cfg,
                })
              : undefined,
          client: row.client,
          requestId: row.requestId,
          preview: preview.preview,
          updatedTs: row.updatedTs,
          truncated: preview.truncated,
        });

        if (out.length >= targetLimit) break;
      }

      if (rows.length < pageSize) break;
    }

    return out;
  }

  private async listGithubReactions(params: {
    thread: { owner: string; repo: string; number: number };
    sessionId: string;
    messageId: string;
  }): Promise<GithubReaction[]> {
    if (
      isGithubIssueTriggerId({
        sessionId: params.sessionId,
        triggerId: params.messageId,
      })
    ) {
      return await this.gh().listIssueReactions({
        owner: params.thread.owner,
        repo: params.thread.repo,
        issueNumber: params.thread.number,
        limit: 100,
      });
    }

    const commentId = Number(params.messageId);
    if (!Number.isFinite(commentId) || commentId <= 0) {
      signalSurfaceFailureToToolHost(`Invalid GitHub commentId '${params.messageId}'`);
    }

    return await this.gh().listIssueCommentReactions({
      owner: params.thread.owner,
      repo: params.thread.repo,
      commentId,
      limit: 100,
    });
  }

  private async callSessionsList(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = parseToolInput({
      callableId: "surface.sessions.list",
      input: rawInput,
      schema: sessionsListInputSchema,
    });
    const client = resolveClient({ inputClient: input.client, ctx });
    if (client === "github") {
      signalSurfaceFailureToToolHost(
        "surface.sessions.list is not supported for GitHub. Use `gh` to list issues/PRs and then pass `--session-id OWNER/REPO#<number>` to other surface.* tools.",
      );
    }
    ensureDiscordClient(client);

    const cfg = await this.getCfg();
    const limit = input.limit ?? Number.POSITIVE_INFINITY;

    const sessions = await this.params.adapter.listSessions();
    const out: Array<{
      channelId: string;
      guildId?: string;
      parentChannelId?: string;
      kind: string;
      title?: string;
      alias?: string;
    }> = [];

    for (const s of sessions) {
      if (s.ref.platform !== "discord") continue;

      const channelId = s.ref.channelId;
      const guildId = s.ref.guildId;
      const parentChannelId = s.ref.parentChannelId;

      if (
        !shouldAllowDiscordChannel({
          cfg,
          channelId,
          guildId,
        })
      ) {
        continue;
      }

      out.push({
        channelId,
        guildId,
        parentChannelId,
        kind: s.kind,
        title: s.title,
        alias: bestEffortAliasForDiscordChannelId({
          channelId,
          cfg,
        }),
      });

      if (out.length >= limit) break;
    }

    return out;
  }

  private async callSessionsListParticipants(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = parseToolInput({
      callableId: "surface.sessions.listParticipants",
      input: withDefaultSessionId(rawInput, ctx),
      schema: sessionsListParticipantsInputSchema,
    });
    const client = resolveClient({ inputClient: input.client, ctx });
    if (client === "github") {
      signalSurfaceFailureToToolHost(
        "surface.sessions.listParticipants is not supported for GitHub. This callable is Discord-only.",
      );
    }
    ensureDiscordClient(client);

    if (!hasSessionParticipantsProvider(this.params.adapter)) {
      signalSurfaceFailureToToolHost(
        "surface.sessions.listParticipants requires an adapter that supports listing session participants",
      );
    }

    const cfg = await this.getCfg();

    const channelId = resolveDiscordSessionId({
      sessionId: mustPresentString(input.sessionId, "sessionId"),
      cfg,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });

    if (
      !shouldAllowDiscordChannel({
        cfg,
        channelId,
        guildId,
      })
    ) {
      signalSurfaceFailureToToolHost(`Not allowed: channelId '${channelId}'`);
    }

    const sessionRef = asDiscordSessionRef(channelId, guildId ?? undefined);
    const participants = await this.params.adapter.listSessionParticipants(sessionRef, {
      limit: input.limit,
    });

    return {
      meta: {
        session: toSessionMeta(sessionRef, cfg),
        source: participants.source,
        count: participants.participants.length,
      },
      participants: participants.participants,
    };
  }

  private async callMessagesList(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = parseToolInput({
      callableId: "surface.messages.list",
      input: withDefaultSessionId(rawInput, ctx),
      schema: messagesListInputSchema,
    });
    const client = resolveClient({ inputClient: input.client, ctx });
    const order: MessageListOrder = input.order ?? "ts_desc";
    const includeRaw = input.includeRaw ?? false;
    const includeAttachments = input.includeAttachments ?? false;

    if (client === "github") {
      const sessionId = mustPresentString(input.sessionId, "sessionId");
      if (input.beforeMessageId || input.afterMessageId) {
        signalSurfaceFailureToToolHost(
          "surface.messages.list for GitHub does not support before/after cursors; use --limit only.",
        );
      }

      const thread = parseGithubSessionId(sessionId);
      const limit = input.limit ?? 50;
      const comments = await this.gh().listIssueComments({
        owner: thread.owner,
        repo: thread.repo,
        number: thread.number,
        limit,
      });

      const sessionRef = asGithubSessionRef(sessionId);
      const messages: SurfaceMessage[] = comments.map((c) => {
        const login = c.user && typeof c.user.login === "string" ? c.user.login : undefined;
        const id = c.user && typeof c.user.id === "number" ? c.user.id : null;

        return {
          ref: asGithubMsgRef(sessionId, String(c.id)),
          session: sessionRef,
          userId: id !== null ? String(id) : (login ?? "unknown"),
          userName: login,
          text: typeof c.body === "string" ? c.body : "",
          ts: parseIsoMs(c.created_at),
          editedTs: parseIsoMs(c.updated_at),
          raw: {
            htmlUrl: typeof c.html_url === "string" ? c.html_url : undefined,
          },
        };
      });

      return buildMessagesListOutput({
        session: sessionRef,
        messages,
        order,
        includeRaw,
        includeAttachments,
      });
    }

    ensureDiscordClient(client);

    const cfg = await this.getCfg();

    const channelId = resolveDiscordSessionId({
      sessionId: mustPresentString(input.sessionId, "sessionId"),
      cfg,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg,
        channelId,
        guildId,
      })
    ) {
      signalSurfaceFailureToToolHost(`Not allowed: channelId '${channelId}'`);
    }

    const sessionRef = asDiscordSessionRef(channelId, guildId ?? undefined);

    if (hasCacheBurstProvider(this.params.adapter)) {
      await this.params.adapter.burstCache({
        sessionRef,
        reason: "surface_tool",
      });
    }

    const limit = input.limit ?? 50;
    const messages = await this.params.adapter.listMsg(sessionRef, {
      limit,
      beforeMessageId: input.beforeMessageId,
      afterMessageId: input.afterMessageId,
    });

    // Adapter store should only contain allowed messages, but keep tool-side filtering anyway.
    const filtered = messages.filter((m) => {
      if (m.session.platform !== "discord") return false;
      return shouldAllowDiscordChannel({
        cfg,
        channelId: m.session.channelId,
        guildId: m.session.guildId,
      });
    });

    const referencedByMessageKey = await resolveDiscordReferencedMessages({
      adapter: this.params.adapter,
      cfg,
      messages: filtered,
    });

    return buildMessagesListOutput({
      session: sessionRef,
      cfg,
      messages: filtered,
      order,
      includeRaw,
      includeAttachments,
      referencedByMessageKey,
    });
  }

  private async callMessagesRead(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = parseToolInput({
      callableId: "surface.messages.read",
      input: withDefaultMessageId(withDefaultSessionId(rawInput, ctx), ctx),
      schema: messagesReadInputSchema,
    });
    const client = resolveClient({ inputClient: input.client, ctx });
    const includeRaw = input.includeRaw ?? false;

    if (client === "github") {
      const sessionId = mustPresentString(input.sessionId, "sessionId");
      const messageId = mustPresentString(input.messageId, "messageId");
      const thread = parseGithubSessionId(sessionId);
      const sessionRef = asGithubSessionRef(sessionId);

      if (isGithubIssueTriggerId({ sessionId, triggerId: messageId })) {
        const issue = await this.gh().getIssue({
          owner: thread.owner,
          repo: thread.repo,
          number: thread.number,
        });

        const login =
          issue.user && typeof issue.user.login === "string" ? issue.user.login : undefined;
        const id = issue.user && typeof issue.user.id === "number" ? issue.user.id : null;

        const message: SurfaceMessage = {
          ref: asGithubMsgRef(sessionId, String(thread.number)),
          session: sessionRef,
          userId: id !== null ? String(id) : (login ?? "unknown"),
          userName: login,
          text: `Title: ${issue.title}\n\n${issue.body ?? ""}`.trim(),
          ts: parseIsoMs(issue.created_at),
          editedTs: parseIsoMs(issue.updated_at),
          raw: {
            title: issue.title,
            htmlUrl: typeof issue.html_url === "string" ? issue.html_url : undefined,
          },
        };

        return buildMessagesReadOutput({
          session: sessionRef,
          message,
          includeRaw,
        });
      }

      const commentId = Number(messageId);
      if (!Number.isFinite(commentId) || commentId <= 0) {
        signalSurfaceFailureToToolHost(`Invalid GitHub commentId '${messageId}'`);
      }

      const c = await this.gh().getIssueComment({
        owner: thread.owner,
        repo: thread.repo,
        commentId,
      });

      const login = c.user && typeof c.user.login === "string" ? c.user.login : undefined;
      const id = c.user && typeof c.user.id === "number" ? c.user.id : null;

      const message: SurfaceMessage = {
        ref: asGithubMsgRef(sessionId, String(c.id)),
        session: sessionRef,
        userId: id !== null ? String(id) : (login ?? "unknown"),
        userName: login,
        text: typeof c.body === "string" ? c.body : "",
        ts: parseIsoMs(c.created_at),
        editedTs: parseIsoMs(c.updated_at),
        raw: {
          htmlUrl: typeof c.html_url === "string" ? c.html_url : undefined,
        },
      };

      return buildMessagesReadOutput({
        session: sessionRef,
        message,
        includeRaw,
      });
    }

    ensureDiscordClient(client);

    const cfg = await this.getCfg();

    const channelId = resolveDiscordSessionId({
      sessionId: mustPresentString(input.sessionId, "sessionId"),
      cfg,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg,
        channelId,
        guildId,
      })
    ) {
      signalSurfaceFailureToToolHost(`Not allowed: channelId '${channelId}'`);
    }

    const msgRef = asDiscordMsgRef(channelId, mustPresentString(input.messageId, "messageId"));
    const sessionRef = asDiscordSessionRef(channelId, guildId ?? undefined);

    if (hasCacheBurstProvider(this.params.adapter)) {
      await this.params.adapter.burstCache({
        msgRef,
        sessionRef,
        reason: "surface_tool",
      });
    }

    const msg = await this.params.adapter.readMsg(msgRef);

    if (!msg) {
      return buildMessagesReadOutput({
        session: sessionRef,
        cfg,
        message: null,
        includeRaw,
      });
    }

    if (
      msg.session.platform !== "discord" ||
      !shouldAllowDiscordChannel({
        cfg,
        channelId: msg.session.channelId,
        guildId: msg.session.guildId,
      })
    ) {
      return buildMessagesReadOutput({
        session: sessionRef,
        cfg,
        message: null,
        includeRaw,
      });
    }

    const referenced = await resolveDiscordReferencedMessage({
      adapter: this.params.adapter,
      cfg,
      message: msg,
    });

    return buildMessagesReadOutput({
      session: sessionRef,
      cfg,
      message: msg,
      referenced,
      includeRaw,
    });
  }

  private async callMessagesSearch(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = parseToolInput({
      callableId: "surface.messages.search",
      input: withDefaultSessionId(rawInput, ctx),
      schema: messagesSearchInputSchema,
    });
    const client = resolveClient({ inputClient: input.client, ctx });

    if (client === "github") {
      signalSurfaceFailureToToolHost("surface.messages.search for GitHub is not supported yet.");
    }

    ensureDiscordClient(client);

    const search = this.params.discordSearch;
    if (!search) {
      signalSurfaceFailureToToolHost(
        "surface.messages.search is unavailable: Discord search index is not initialized.",
      );
    }

    const cfg = await this.getCfg();

    const channelId = resolveDiscordSessionId({
      sessionId: mustPresentString(input.sessionId, "sessionId"),
      cfg,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg,
        channelId,
        guildId,
      })
    ) {
      signalSurfaceFailureToToolHost(`Not allowed: channelId '${channelId}'`);
    }

    const sessionRef = asDiscordSessionRef(channelId, guildId ?? undefined);
    if (sessionRef.platform !== "discord") {
      signalSurfaceFailureToToolHost("surface.messages.search internal error");
    }

    const result = await search.searchSession({
      sessionRef,
      query: input.query,
      limit: input.limit,
    });

    const userAliasById = buildDiscordUserAliasById(cfg);
    const baseHits = result.hits.map((hit) => ({
      ...hit,
      userAlias: userAliasById.get(hit.userId),
    }));

    const order: MessageSearchOrder = input.order ?? "relevance";
    const hits =
      order === "relevance"
        ? baseHits
        : [...baseHits].sort((a, b) => compareSurfaceMessageChronological(a, b)).map((hit) => hit);

    if (order === "ts_desc") {
      hits.reverse();
    }

    const attachmentHintsByMessageId = new Map<string, SurfaceMessageAttachmentHints>();
    await Promise.all(
      hits.map(async (hit) => {
        try {
          const msg = await this.params.adapter.readMsg(hit.ref);
          const attachments = msg ? getMessageAttachmentMeta(msg) : [];
          attachmentHintsByMessageId.set(hit.ref.messageId, buildAttachmentHints(attachments));
        } catch {
          attachmentHintsByMessageId.set(hit.ref.messageId, buildAttachmentHints([]));
        }
      }),
    );

    return {
      meta: {
        session: toSessionMeta(sessionRef, cfg),
        order,
        count: hits.length,
      },
      query: input.query,
      heal: result.heal,
      hits: hits.map((hit) => ({
        messageId: hit.ref.messageId,
        userId: hit.userId,
        userName: hit.userName,
        userAlias: hit.userAlias,
        richText: hit.text,
        ts: hit.ts,
        editedTs: hit.editedTs,
        score: hit.score,
        ...(attachmentHintsByMessageId.get(hit.ref.messageId) ?? buildAttachmentHints([])),
      })),
    };
  }

  private async callMessagesSend(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = parseToolInput({
      callableId: "surface.messages.send",
      input: withDefaultSessionId(rawInput, ctx),
      schema: messagesSendInputSchema,
    });
    const client = resolveClient({ inputClient: input.client, ctx });

    if (client === "github") {
      const sessionId = mustPresentString(input.sessionId, "sessionId");
      const thread = parseGithubSessionId(sessionId);
      const sessionRef = asGithubSessionRef(sessionId);

      if (input.replyToMessageId) {
        signalSurfaceFailureToToolHost(
          "surface.messages.send for GitHub does not support replyToMessageId; post a normal comment and link the target instead.",
        );
      }

      const paths = input.paths ?? [];
      if (paths.length > 0) {
        signalSurfaceFailureToToolHost(
          "surface.messages.send for GitHub does not support attachments; use gh or upload elsewhere and link.",
        );
      }

      const res = await this.gh().createIssueComment({
        owner: thread.owner,
        repo: thread.repo,
        issueNumber: thread.number,
        body: markGithubAgentComment(input.text),
      });

      const ref = asGithubMsgRef(sessionId, String(res.id));
      this.linkSentMessageToTranscript(ref, ctx);
      return { ok: true as const, ref, session: toSessionMeta(sessionRef) };
    }

    ensureDiscordClient(client);

    const cfg = await this.getCfg();

    const channelId = resolveDiscordSessionId({
      sessionId: mustPresentString(input.sessionId, "sessionId"),
      cfg,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg,
        channelId,
        guildId,
      })
    ) {
      signalSurfaceFailureToToolHost(`Not allowed: channelId '${channelId}'`);
    }

    const sessionRef = asDiscordSessionRef(channelId, guildId ?? undefined);

    const replyTo = input.replyToMessageId
      ? asDiscordMsgRef(channelId, input.replyToMessageId)
      : undefined;

    const cwd = ctx?.cwd ?? process.cwd();

    const paths = input.paths ?? [];
    if (paths.length > 0) {
      if (paths.length > 10) {
        signalSurfaceFailureToToolHost(
          `Too many attachments (${paths.length}). Max is 10 per message.`,
        );
      }
    }

    const attachments =
      paths.length > 0
        ? await loadLocalAttachments({
            cwd,
            paths,
            filenames: input.filenames,
            mimeTypes: input.mimeTypes,
            context: ctx,
          })
        : [];

    const ref = await this.params.adapter.sendMsg(
      sessionRef,
      {
        text: input.text,
        attachments,
      },
      replyTo || input.silent === true
        ? {
            ...(replyTo ? { replyTo } : {}),
            ...(input.silent === true ? { silent: true } : {}),
          }
        : undefined,
    );

    this.linkSentMessageToTranscript(ref, ctx);

    return { ok: true as const, ref, session: toSessionMeta(sessionRef, cfg) };
  }

  private async callMessagesEdit(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = parseToolInput({
      callableId: "surface.messages.edit",
      input: withDefaultSessionId(rawInput, ctx),
      schema: messagesEditInputSchema,
    });
    const client = resolveClient({ inputClient: input.client, ctx });

    if (client === "github") {
      const sessionId = mustPresentString(input.sessionId, "sessionId");
      const thread = parseGithubSessionId(sessionId);

      if (isGithubIssueTriggerId({ sessionId, triggerId: input.messageId })) {
        signalSurfaceFailureToToolHost(
          "Editing the GitHub issue/PR body is not supported via surface.messages.edit. Use gh issue edit / gh pr edit.",
        );
      }

      const commentId = Number(input.messageId);
      if (!Number.isFinite(commentId) || commentId <= 0) {
        signalSurfaceFailureToToolHost(`Invalid GitHub commentId '${input.messageId}'`);
      }

      await this.gh().editIssueComment({
        owner: thread.owner,
        repo: thread.repo,
        commentId,
        body: input.text,
      });

      return { ok: true as const };
    }

    ensureDiscordClient(client);

    const cfg = await this.getCfg();

    const channelId = resolveDiscordSessionId({
      sessionId: mustPresentString(input.sessionId, "sessionId"),
      cfg,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg,
        channelId,
        guildId,
      })
    ) {
      signalSurfaceFailureToToolHost(`Not allowed: channelId '${channelId}'`);
    }

    await this.params.adapter.editMsg(asDiscordMsgRef(channelId, input.messageId), {
      text: input.text,
    });

    return { ok: true as const };
  }

  private async callMessagesDelete(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = parseToolInput({
      callableId: "surface.messages.delete",
      input: withDefaultSessionId(rawInput, ctx),
      schema: messagesDeleteInputSchema,
    });
    const client = resolveClient({ inputClient: input.client, ctx });

    if (client === "github") {
      const sessionId = mustPresentString(input.sessionId, "sessionId");
      const thread = parseGithubSessionId(sessionId);

      if (isGithubIssueTriggerId({ sessionId, triggerId: input.messageId })) {
        signalSurfaceFailureToToolHost(
          "Deleting the GitHub issue/PR body is not supported via surface.messages.delete. Use gh issue delete / gh pr (if applicable).",
        );
      }

      const commentId = Number(input.messageId);
      if (!Number.isFinite(commentId) || commentId <= 0) {
        signalSurfaceFailureToToolHost(`Invalid GitHub commentId '${input.messageId}'`);
      }

      await this.gh().deleteIssueComment({
        owner: thread.owner,
        repo: thread.repo,
        commentId,
      });

      return { ok: true as const };
    }

    ensureDiscordClient(client);

    const cfg = await this.getCfg();

    const channelId = resolveDiscordSessionId({
      sessionId: mustPresentString(input.sessionId, "sessionId"),
      cfg,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg,
        channelId,
        guildId,
      })
    ) {
      signalSurfaceFailureToToolHost(`Not allowed: channelId '${channelId}'`);
    }

    await this.params.adapter.deleteMsg(asDiscordMsgRef(channelId, input.messageId));
    return { ok: true as const };
  }

  private async callReactionsList(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = parseToolInput({
      callableId: "surface.reactions.list",
      input: withDefaultMessageId(withDefaultSessionId(rawInput, ctx), ctx),
      schema: reactionsListInputSchema,
    });
    const client = resolveClient({ inputClient: input.client, ctx });

    if (client === "github") {
      const sessionId = mustPresentString(input.sessionId, "sessionId");
      const messageId = mustPresentString(input.messageId, "messageId");
      const thread = parseGithubSessionId(sessionId);

      const reactions = await this.listGithubReactions({
        thread,
        sessionId,
        messageId,
      });

      const counts = new Map<string, number>();
      for (const r of reactions) {
        counts.set(r.content, (counts.get(r.content) ?? 0) + 1);
      }

      return Array.from(counts.entries()).map(([content, count]) => ({
        emoji: githubReactionEmojiFromContent(content),
        count,
      }));
    }

    ensureDiscordClient(client);

    const cfg = await this.getCfg();

    const channelId = resolveDiscordSessionId({
      sessionId: mustPresentString(input.sessionId, "sessionId"),
      cfg,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg,
        channelId,
        guildId,
      })
    ) {
      signalSurfaceFailureToToolHost(`Not allowed: channelId '${channelId}'`);
    }

    if (!hasReactionDetailsProvider(this.params.adapter)) {
      signalSurfaceFailureToToolHost(
        "surface.reactions.list requires an adapter that supports reaction details",
      );
    }

    const msgRef = asDiscordMsgRef(channelId, mustPresentString(input.messageId, "messageId"));

    if (hasCacheBurstProvider(this.params.adapter)) {
      await this.params.adapter.burstCache({
        msgRef,
        sessionRef: asDiscordSessionRef(channelId, guildId ?? undefined),
        reason: "surface_tool",
      });
    }

    const details = await this.params.adapter.listReactionDetails(msgRef);

    const out: SurfaceReactionSummary[] = details.map((d) => ({
      emoji: d.emoji,
      count: d.count,
    }));

    return out;
  }

  private async callReactionsListDetailed(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = parseToolInput({
      callableId: "surface.reactions.listDetailed",
      input: withDefaultMessageId(withDefaultSessionId(rawInput, ctx), ctx),
      schema: reactionsListDetailedInputSchema,
    });
    const client = resolveClient({ inputClient: input.client, ctx });

    if (client === "github") {
      const sessionId = mustPresentString(input.sessionId, "sessionId");
      const messageId = mustPresentString(input.messageId, "messageId");
      const thread = parseGithubSessionId(sessionId);

      const reactions = await this.listGithubReactions({
        thread,
        sessionId,
        messageId,
      });

      const byContent = new Map<
        string,
        { count: number; users: Array<{ userId: string; userName?: string }> }
      >();

      for (const r of reactions) {
        const entry = byContent.get(r.content) ?? { count: 0, users: [] };
        entry.count += 1;

        const login = r.user && typeof r.user.login === "string" ? r.user.login : undefined;
        const id = r.user && typeof r.user.id === "number" ? r.user.id : null;

        if (login || id !== null) {
          const userId = id !== null ? String(id) : login!;
          if (!entry.users.some((u) => u.userId === userId)) {
            entry.users.push({ userId, userName: login });
          }
        }

        byContent.set(r.content, entry);
      }

      const out: SurfaceReactionDetail[] = Array.from(byContent.entries()).map(([content, v]) => ({
        emoji: githubReactionEmojiFromContent(content),
        count: v.count,
        users: v.users,
      }));

      return out;
    }

    ensureDiscordClient(client);

    const cfg = await this.getCfg();

    const channelId = resolveDiscordSessionId({
      sessionId: mustPresentString(input.sessionId, "sessionId"),
      cfg,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg,
        channelId,
        guildId,
      })
    ) {
      signalSurfaceFailureToToolHost(`Not allowed: channelId '${channelId}'`);
    }

    if (!hasReactionDetailsProvider(this.params.adapter)) {
      signalSurfaceFailureToToolHost(
        "surface.reactions.listDetailed is not supported by the current adapter",
      );
    }

    const msgRef = asDiscordMsgRef(channelId, mustPresentString(input.messageId, "messageId"));

    if (hasCacheBurstProvider(this.params.adapter)) {
      await this.params.adapter.burstCache({
        msgRef,
        sessionRef: asDiscordSessionRef(channelId, guildId ?? undefined),
        reason: "surface_tool",
      });
    }

    return await this.params.adapter.listReactionDetails(msgRef);
  }

  private async callReactionsAdd(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = parseToolInput({
      callableId: "surface.reactions.add",
      input: withDefaultMessageId(withDefaultSessionId(rawInput, ctx), ctx),
      schema: reactionsAddInputSchema,
    });
    const client = resolveClient({ inputClient: input.client, ctx });

    if (client === "github") {
      const sessionId = mustPresentString(input.sessionId, "sessionId");
      const messageId = mustPresentString(input.messageId, "messageId");
      const thread = parseGithubSessionId(sessionId);
      const content = githubReactionContentFromInput(input.reaction);

      if (isGithubIssueTriggerId({ sessionId, triggerId: messageId })) {
        await this.gh().createIssueReaction({
          owner: thread.owner,
          repo: thread.repo,
          issueNumber: thread.number,
          content,
        });
      } else {
        const commentId = Number(messageId);
        if (!Number.isFinite(commentId) || commentId <= 0) {
          signalSurfaceFailureToToolHost(`Invalid GitHub commentId '${messageId}'`);
        }
        await this.gh().createIssueCommentReaction({
          owner: thread.owner,
          repo: thread.repo,
          commentId,
          content,
        });
      }

      return { ok: true as const };
    }

    ensureDiscordClient(client);

    const cfg = await this.getCfg();

    const channelId = resolveDiscordSessionId({
      sessionId: mustPresentString(input.sessionId, "sessionId"),
      cfg,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg,
        channelId,
        guildId,
      })
    ) {
      signalSurfaceFailureToToolHost(`Not allowed: channelId '${channelId}'`);
    }

    await this.params.adapter.addReaction(
      asDiscordMsgRef(channelId, mustPresentString(input.messageId, "messageId")),
      input.reaction,
    );

    return { ok: true as const };
  }

  private async callReactionsRemove(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = parseToolInput({
      callableId: "surface.reactions.remove",
      input: withDefaultMessageId(withDefaultSessionId(rawInput, ctx), ctx),
      schema: reactionsRemoveInputSchema,
    });
    const client = resolveClient({ inputClient: input.client, ctx });

    if (client === "github") {
      const sessionId = mustPresentString(input.sessionId, "sessionId");
      const messageId = mustPresentString(input.messageId, "messageId");
      const thread = parseGithubSessionId(sessionId);
      const content = githubReactionContentFromInput(input.reaction);

      const resolveActorLogin = this.gh().getPreferredGithubActorLoginOrNull;
      let actorLogin = resolveActorLogin ? await resolveActorLogin() : null;
      if (!actorLogin) {
        const slug = await this.gh().getGithubAppSlugOrNull();
        actorLogin = slug ? `${slug}[bot]` : null;
      }
      if (!actorLogin) {
        signalSurfaceFailureToToolHost(
          "Unable to resolve the outbound GitHub actor login (required to remove reactions safely). Use gh to remove the reaction instead.",
        );
      }

      const reactions = await this.listGithubReactions({
        thread,
        sessionId,
        messageId,
      });

      const mine = reactions.filter((r) => r.content === content && r.user?.login === actorLogin);

      if (isGithubIssueTriggerId({ sessionId, triggerId: messageId })) {
        for (const r of mine) {
          await this.gh().deleteIssueReactionById({
            owner: thread.owner,
            repo: thread.repo,
            issueNumber: thread.number,
            reactionId: r.id,
          });
        }
      } else {
        const commentId = Number(messageId);
        if (!Number.isFinite(commentId) || commentId <= 0) {
          signalSurfaceFailureToToolHost(`Invalid GitHub commentId '${messageId}'`);
        }
        for (const r of mine) {
          await this.gh().deleteIssueCommentReactionById({
            owner: thread.owner,
            repo: thread.repo,
            commentId,
            reactionId: r.id,
          });
        }
      }

      return { ok: true as const };
    }

    ensureDiscordClient(client);

    const cfg = await this.getCfg();

    const channelId = resolveDiscordSessionId({
      sessionId: mustPresentString(input.sessionId, "sessionId"),
      cfg,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg,
        channelId,
        guildId,
      })
    ) {
      signalSurfaceFailureToToolHost(`Not allowed: channelId '${channelId}'`);
    }

    await this.params.adapter.removeReaction(
      asDiscordMsgRef(channelId, mustPresentString(input.messageId, "messageId")),
      input.reaction,
    );

    return { ok: true as const };
  }
}
