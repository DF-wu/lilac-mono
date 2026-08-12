import {
  ActivityType,
  ApplicationCommandType,
  ApplicationCommandOptionType,
  type AutocompleteInteraction,
  type CacheWithLimitsOptions,
  type CacheType,
  Client,
  EmbedBuilder,
  type GuildMember,
  type ChatInputCommandInteraction,
  GatewayIntentBits,
  MessageFlags,
  type MessageContextMenuCommandInteraction,
  Options,
  PermissionFlagsBits,
  Partials,
  type Presence,
  type Interaction,
  type Message,
  type MessageReaction,
  type PartialMessage,
  type User,
} from "discord.js";
import { z } from "zod";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import type { CoreConfig, CustomCommandArgDef } from "@stanley2058/lilac-utils";
import {
  CUSTOM_COMMAND_PROMPT_ARG_KEY,
  createLogger,
  formatTaggedErrorForLog,
  getCoreConfig,
  resolveModelRefResult,
  resolveDiscordDbPath,
  resolveDiscordTokenResult,
} from "@stanley2058/lilac-utils";
import type {
  ContentOpts,
  DiscordMsgRef,
  DiscordSessionRef,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfaceSessionParticipant,
  SurfaceSessionParticipantsResult,
  SurfaceReactionDetail,
  SurfaceSelf,
  SurfaceSession,
} from "../types";
import type { AdapterEvent } from "../events";
import {
  SurfaceInvalidInput,
  SurfaceMessageNotFound,
  SurfacePermissionDenied,
  SurfacePlatformMismatch,
  SurfaceRateLimited,
  SurfaceSessionMismatch,
  SurfaceUnavailable,
  type SurfaceOperation,
  type SurfaceOperationError,
  type SurfaceOperationResult,
  type AdapterEventHandler,
  type AdapterSubscription,
  type SurfaceMergeBlockPlanOptions,
  type SurfaceReplyChainPlanOptions,
  type SurfaceSendPreparationInput,
  type StartOutputOpts,
  type SurfaceAdapter,
} from "../adapter";
import { surfaceExternalFallback } from "../adapter";
import { createDiscordEntityMapper, type EntityMapper } from "../../entity/entity-mapper";
import { DiscordSurfaceStore, type DbDiscordMessageRelation } from "../store/discord-surface-store";
import { splitByDiscordWindowOldestToNewest } from "./merge-window";
import { DiscordOutputStream, sendDiscordStyledMessage } from "./output/discord-output-stream";
import { parseCancelCustomId } from "./discord-cancel";
import { buildDiscordActionComponentsResult, parseDiscordActionCustomId } from "./discord-actions";

const discordNotFoundErrorSchema = z
  .object({ code: z.union([z.literal(10_003), z.literal(10_008)]) })
  .passthrough();

function discordNotFoundCode(error: unknown): 10_003 | 10_008 | null {
  const parsed = discordNotFoundErrorSchema.safeParse(error);
  return parsed.success ? parsed.data.code : null;
}

const discordOperationErrorSchema = z
  .object({
    code: z.number().int().optional(),
    status: z.number().int().optional(),
    retry_after: z.number().finite().nonnegative().optional(),
  })
  .passthrough();

export function classifyDiscordSurfaceError(
  operation: SurfaceOperation,
  error: unknown,
  message = "Discord operation failed",
): SurfaceOperationError | null {
  if (error instanceof DiscordAdapterUnavailable) {
    return new SurfaceUnavailable({ platform: "discord", operation, message: error.message });
  }
  const parsed = discordOperationErrorSchema.safeParse(error);
  if (!parsed.success) return null;
  const { code, status, retry_after: retryAfterSeconds } = parsed.data;
  if (code === 10_003 || code === 10_008 || status === 404) {
    return new SurfaceMessageNotFound({ platform: "discord", operation, message });
  }
  if (code === 50_001 || code === 50_013 || status === 401 || status === 403) {
    return new SurfacePermissionDenied({ platform: "discord", operation, message });
  }
  if (code === 20_028 || code === 20_029 || status === 429) {
    return new SurfaceRateLimited({
      platform: "discord",
      operation,
      ...(retryAfterSeconds === undefined
        ? {}
        : { retryAfterMs: Math.ceil(retryAfterSeconds * 1000) }),
      message,
    });
  }
  if (code === 50_035 || status === 400) {
    return new SurfaceInvalidInput({
      platform: "discord",
      operation,
      field: "request",
      message,
    });
  }
  if (status !== undefined && status >= 500) {
    return new SurfaceUnavailable({ platform: "discord", operation, message });
  }
  return null;
}

export function classifyDiscordSurfaceNotFound(
  error: unknown,
  message = "Discord resource not found",
): SurfaceMessageNotFound | null {
  const classified = classifyDiscordSurfaceError("read-message", error, message);
  return classified instanceof SurfaceMessageNotFound ? classified : null;
}
import { buildDiscordSessionDividerText } from "./discord-session-divider";
import { formatDiscordMessageRequestId, formatDiscordSlashRequestId } from "../bridge/request-ids";
import {
  isExplicitDiscordUserMention,
  isRoutableDiscordUserMessage,
  resolveTextSendableChannel,
  shouldAllowMessage,
  tryEditOrReplyEphemeral,
  tryReplyEphemeral,
} from "./discord-channel-guards";
import {
  buildForwardMessageSnapshots,
  collectDiscordAttachmentMeta,
  getChannelName,
  getDiscordMessageTypeName,
  getDisplayName,
  getForwardSnapshotPayload,
  getMessageEditedTs,
  getMessageEmbeds,
  getMessageTs,
  getReplyReference,
  getStoredTextFromDiscordMessage,
  isDiscordChatLikeMessage,
  normalizeDiscordReference,
  previewText,
  sortSurfaceParticipants,
  toSurfaceParticipantActivities,
} from "./discord-message-meta";
import {
  resolveDiscordSurfaceEditTargetResult,
  resolveEffectiveSessionModelOverride,
} from "./discord-session-model";
import type { MarkdownTableRenderOptions } from "../../shared/markdown-table-renderer";
import type { DiscordMarkdownMathRenderOptions } from "./output/discord-markdown-math-renderer";
import {
  customCommandInvocationErrorText,
  type CustomCommandManager,
} from "../../custom-commands/manager";
import { getSessionMode, resolveSessionConfigId } from "./discord-request-router/common";

export {
  hasExplicitDiscordUserMentionInContent,
  isExplicitDiscordUserMention,
  isRoutableDiscordUserMessage,
} from "./discord-channel-guards";
export {
  resolveDiscordSurfaceEditTargetResult,
  resolveEffectiveSessionModelOverride,
} from "./discord-session-model";

export type DiscordAdapterOptions = {
  /** Dependency injection for tests. */
  config?: CoreConfig;
  getConfig?: () => Promise<CoreConfig>;
  customCommands?: CustomCommandManager;
  /** Direct Core fatal-supervisor handoff. */
  reportFatalPanic: (panic: Panic) => void;
};

export const DISCORD_CACHE_LIMITS = {
  MessageManager: 200,
  GuildMemberManager: 256,
  PresenceManager: 256,
  ThreadMemberManager: 256,
  UserManager: 2_048,
  ReactionManager: 25,
  ReactionUserManager: 0,
} as const;

export const DISCORD_CACHE_SETTINGS = {
  ...Options.DefaultMakeCacheSettings,
  GuildMemberManager: {
    maxSize: DISCORD_CACHE_LIMITS.GuildMemberManager,
    keepOverLimit: (member) => member.id === member.client.user?.id,
  },
  PresenceManager: DISCORD_CACHE_LIMITS.PresenceManager,
  ThreadMemberManager: DISCORD_CACHE_LIMITS.ThreadMemberManager,
  UserManager: DISCORD_CACHE_LIMITS.UserManager,
  ReactionManager: DISCORD_CACHE_LIMITS.ReactionManager,
  ReactionUserManager: DISCORD_CACHE_LIMITS.ReactionUserManager,
} satisfies CacheWithLimitsOptions;

type DiscordAggregateCacheSizeKey = Exclude<
  keyof typeof DISCORD_CACHE_LIMITS,
  "ReactionManager" | "ReactionUserManager"
>;

export type DiscordAdapterCacheSnapshot = {
  perManagerLimits: typeof DISCORD_CACHE_LIMITS;
  aggregateSizes: Record<DiscordAggregateCacheSizeKey, number>;
};

export type DiscordAdapterHealthSnapshot = {
  connectionState: "idle" | "connecting" | "ready" | "disconnected";
  isReady: boolean;
  readyAt?: number;
  lastDisconnectAt?: number;
  lastDisconnectCode?: number;
  lastErrorAt?: number;
  lastError?: string;
  lastResumeAt?: number;
  lastGatewayEventAt?: number;
  gatewayPingMs?: number;
  lastGatewayPingAt?: number;
  cache?: DiscordAdapterCacheSnapshot;
};

export class DiscordAdapterUnavailable extends TaggedError("DiscordAdapterUnavailable")<{
  readonly message: string;
}> {}

export class DiscordPlatformUnsupported extends TaggedError("DiscordPlatformUnsupported")<{
  readonly platform: string;
  readonly message: string;
}> {}

export class DiscordChannelUnavailable extends TaggedError("DiscordChannelUnavailable")<{
  readonly channelId: string;
  readonly message: string;
}> {}

export class DiscordInvariantViolation extends TaggedError("DiscordInvariantViolation")<{
  readonly message: string;
}> {}

export class DiscordExternalCallFailed extends TaggedError("DiscordExternalCallFailed")<{
  readonly operation: string;
  readonly message: string;
}> {}

function discordSessionRefResult(
  operation: SurfaceOperation,
  sessionRef: SessionRef,
  refRole = "sessionRef",
): SurfaceOperationResult<DiscordSessionRef> {
  if (sessionRef.platform === "discord") return Result.ok(sessionRef);
  return Result.err(
    new SurfacePlatformMismatch({
      operation,
      refRole,
      expectedPlatform: "discord",
      receivedPlatform: sessionRef.platform,
      message: `Expected a Discord ${refRole}, received '${sessionRef.platform}'`,
    }),
  );
}

function discordMsgRefResult(
  operation: SurfaceOperation,
  msgRef: MsgRef,
  refRole = "msgRef",
): SurfaceOperationResult<DiscordMsgRef> {
  if (msgRef.platform === "discord") return Result.ok(msgRef);
  return Result.err(
    new SurfacePlatformMismatch({
      operation,
      refRole,
      expectedPlatform: "discord",
      receivedPlatform: msgRef.platform,
      message: `Expected a Discord ${refRole}, received '${msgRef.platform}'`,
    }),
  );
}

function discordNestedMsgRefResult(input: {
  operation: SurfaceOperation;
  sessionRef: DiscordSessionRef;
  msgRef: MsgRef;
  refRole: string;
}): SurfaceOperationResult<DiscordMsgRef> {
  const ref = discordMsgRefResult(input.operation, input.msgRef, input.refRole);
  if (ref.status === "error") return ref;
  if (ref.value.channelId === input.sessionRef.channelId) return ref;
  return Result.err(
    new SurfaceSessionMismatch({
      operation: input.operation,
      refRole: input.refRole,
      expectedSessionId: input.sessionRef.channelId,
      receivedSessionId: ref.value.channelId,
      message: `Discord ${input.refRole} belongs to session '${ref.value.channelId}'`,
    }),
  );
}

function prepareDiscordSendResult(
  sessionRef: SessionRef,
  input: SurfaceSendPreparationInput,
  opts?: SendOpts,
): SurfaceOperationResult<DiscordSessionRef> {
  const refResult = discordSessionRefResult("send-message", sessionRef);
  if (refResult.status === "error") return refResult;
  const discordRef = refResult.value;
  if (opts?.replyTo) {
    const reply = discordNestedMsgRefResult({
      operation: "send-message",
      sessionRef: discordRef,
      msgRef: opts.replyTo,
      refRole: "replyTo",
    });
    if (reply.status === "error") return reply;
  }
  const hasText = Boolean(input.text?.trim());
  if (!hasText && input.attachmentCount === 0 && input.actionCount === 0) {
    return Result.err(
      new SurfaceInvalidInput({
        platform: "discord",
        operation: "send-message",
        field: "content",
        message: "Discord message content must include text, an attachment, or an action",
      }),
    );
  }
  return Result.ok(discordRef);
}

async function captureDiscordOperation<T>(
  operation: SurfaceOperation,
  effect: () => Promise<T>,
): Promise<SurfaceOperationResult<T>> {
  try {
    return Result.ok(await effect());
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    const classified = classifyDiscordSurfaceError(operation, cause);
    if (classified) return Result.err(classified);
    throw cause;
  }
}

function externalCallFailure(operation: string): DiscordExternalCallFailed {
  return new DiscordExternalCallFailed({
    operation,
    message: `Discord SDK call failed: ${operation}`,
  });
}

function asDiscordSessionRef(input: {
  channelId: string;
  guildId?: string | null;
  parentChannelId?: string | null;
}): SessionRef {
  return {
    platform: "discord",
    channelId: input.channelId,
    guildId: input.guildId ?? undefined,
    parentChannelId: input.parentChannelId ?? undefined,
  };
}

function asDiscordMsgRef(channelId: string, messageId: string): MsgRef {
  return { platform: "discord", channelId, messageId };
}

function resolveMarkdownTableRenderOptions(
  cfg: CoreConfig | null | undefined,
): MarkdownTableRenderOptions | undefined {
  const tableRender = cfg?.surface.discord.markdownTableRender;
  if (!tableRender || tableRender.enabled !== true) {
    return undefined;
  }

  return {
    style: tableRender.style ?? "unicode",
    maxWidth: tableRender.maxWidth ?? 80,
    fallbackMode: tableRender.fallbackMode ?? "list",
  };
}

function resolveMarkdownMathRenderOptions(
  cfg: CoreConfig | null | undefined,
): DiscordMarkdownMathRenderOptions | undefined {
  const mathRender = cfg?.surface.discord.markdownMathRender;
  if (!mathRender || mathRender.enabled !== true) {
    return undefined;
  }

  return {
    maxWidth: mathRender.maxWidth,
    fallbackMode: mathRender.fallbackMode,
  };
}

export function resolveOutputNotificationEnabled(input: {
  configured?: boolean;
  silent?: boolean;
}): boolean {
  if (input.silent === true) return false;
  if (typeof input.configured === "boolean") return input.configured;
  return true;
}

function getLatestGatewayPingAt(client: Client): number | undefined {
  let latestGatewayPingAt: number | undefined;
  for (const shard of client.ws.shards.values()) {
    if (!Number.isFinite(shard.lastPingTimestamp) || shard.lastPingTimestamp < 0) {
      continue;
    }
    latestGatewayPingAt =
      latestGatewayPingAt === undefined
        ? shard.lastPingTimestamp
        : Math.max(latestGatewayPingAt, shard.lastPingTimestamp);
  }
  return latestGatewayPingAt;
}

function getDiscordCacheSnapshot(client: Client | null): DiscordAdapterCacheSnapshot {
  const aggregateSizes: DiscordAdapterCacheSnapshot["aggregateSizes"] = {
    MessageManager: 0,
    GuildMemberManager: 0,
    PresenceManager: 0,
    ThreadMemberManager: 0,
    UserManager: client?.users.cache.size ?? 0,
  };

  if (client) {
    for (const guild of client.guilds.cache.values()) {
      aggregateSizes.GuildMemberManager += guild.members.cache.size;
      aggregateSizes.PresenceManager += guild.presences.cache.size;
    }

    for (const channel of client.channels.cache.values()) {
      if ("isThread" in channel && channel.isThread()) {
        aggregateSizes.ThreadMemberManager += channel.members.cache.size;
      }
      if (!("messages" in channel)) continue;
      aggregateSizes.MessageManager += channel.messages.cache.size;
    }
  }

  return {
    perManagerLimits: { ...DISCORD_CACHE_LIMITS },
    aggregateSizes,
  };
}

function compareDiscordSnowflake(a: string, b: string): number {
  // Prefer numeric comparison (snowflakes are numeric strings).
  // Fall back to localeCompare if parsing fails.
  if (/^\d+$/u.test(a) && /^\d+$/u.test(b)) {
    const ai = BigInt(a);
    const bi = BigInt(b);
    if (ai < bi) return -1;
    if (ai > bi) return 1;
    return 0;
  }
  return a.localeCompare(b);
}

const CONTEXT_MENU_CANCEL_REQUEST_NAME = "Cancel Request";

const DISCORD_BOT_INVITE_SCOPES = "bot applications.commands";
const DISCORD_STANDARD_INVITE_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.SendMessagesInThreads |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.EmbedLinks |
  PermissionFlagsBits.AttachFiles |
  PermissionFlagsBits.AddReactions |
  PermissionFlagsBits.UseExternalEmojis;

function buildDiscordBotInviteUrl(input: { clientId: string; permissions: bigint }): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    scope: DISCORD_BOT_INVITE_SCOPES,
    permissions: input.permissions.toString(),
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export function buildDiscordSlashOption(arg: CustomCommandArgDef) {
  if (arg.type === "number") {
    return {
      type: ApplicationCommandOptionType.Number as const,
      name: arg.key,
      description: arg.description ?? arg.key,
      required: arg.required ?? false,
    };
  }
  if (arg.type === "boolean") {
    return {
      type: ApplicationCommandOptionType.Boolean as const,
      name: arg.key,
      description: arg.description ?? arg.key,
      required: arg.required ?? false,
    };
  }
  return {
    type: ApplicationCommandOptionType.String as const,
    name: arg.key,
    description: arg.description ?? arg.key,
    required: arg.required ?? false,
    ...(arg.choices?.length
      ? {
          choices: arg.choices.slice(0, 25).map((choice) => ({
            name: choice,
            value: choice,
          })),
        }
      : {}),
  };
}

function readDiscordSlashOption(
  interaction: ChatInputCommandInteraction<CacheType>,
  arg: CustomCommandArgDef,
): string | number | boolean | null {
  switch (arg.type) {
    case "string":
      return interaction.options.getString(arg.key);
    case "number":
      return interaction.options.getNumber(arg.key);
    case "boolean":
      return interaction.options.getBoolean(arg.key);
  }
}

function resolveDiscordSessionKind(
  isDm: boolean,
  parentChannelId: string | null,
): "channel" | "thread" | "dm" {
  if (isDm) return "dm";
  return parentChannelId ? "thread" : "channel";
}

export class DiscordAdapter implements SurfaceAdapter {
  private client: Client | null = null;
  private store: DiscordSurfaceStore | null = null;
  private cfg: CoreConfig | null = null;
  private entityMapper: EntityMapper | null = null;
  private coreConfigReloadHadError = false;
  private lastCoreConfigReloadError: string | null = null;
  private handlers = new Set<AdapterEventHandler>();
  private sessionModelOverrides = new Map<string, string>();

  private readonly logger = createLogger({
    module: "surface:discord",
  });

  private self: SurfaceSelf | null = null;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private appliedStatusMessage: string | null | undefined;
  private healthState: Omit<DiscordAdapterHealthSnapshot, "cache"> = {
    connectionState: "idle",
    isReady: false,
  };

  constructor(private readonly opts: DiscordAdapterOptions) {}

  async connect(): Promise<void> {
    if (this.client) return;

    this.healthState = {
      connectionState: "connecting",
      isReady: false,
    };

    const cfg = this.opts?.config ?? (await this.resolveCoreConfig());
    this.cfg = cfg;

    this.logger.debug("connecting", {
      botName: cfg.surface.discord.botName,
      tokenEnv: cfg.surface.discord.tokenEnv,
      allowedChannelIds: cfg.surface.discord.allowedChannelIds.length,
      allowedGuildIds: cfg.surface.discord.allowedGuildIds.length,
    });

    const dbPath = resolveDiscordDbPath(cfg);
    this.store = new DiscordSurfaceStore(dbPath);
    this.entityMapper = createDiscordEntityMapper({ cfg, store: this.store });

    this.logger.debug("discord store initialized", { dbPath });

    const tokenResult = resolveDiscordTokenResult(cfg);
    if (tokenResult.status === "error") {
      switch (tokenResult.error._tag) {
        case "DiscordTokenMissing":
          throw tokenResult.error;
      }
    }
    const token = tokenResult.value;

    const intents = [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ];

    if (cfg.surface.discord.memberPresence === true) {
      intents.push(GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences);
    }

    const client = new Client({
      intents,
      partials: [
        Partials.User,
        Partials.GuildMember,
        Partials.Message,
        Partials.Channel,
        Partials.Reaction,
        Partials.ThreadMember,
      ],
      makeCache: Options.cacheWithLimits(DISCORD_CACHE_SETTINGS),
    });

    client.on("clientReady", () => {
      this.superviseDiscordCallback("clientReady", async () => {
        const user = client.user;
        if (!user) return;

        const botName = cfg.surface.discord.botName;

        this.self = {
          platform: "discord",
          userId: user.id,
          userName: botName,
        };

        this.store?.upsertUserName({
          userId: user.id,
          username: botName,
          globalName: botName,
          displayName: botName,
          updatedTs: Date.now(),
        });

        this.logger.info("ready", {
          userId: user.id,
          botName,
        });
        this.noteGatewayEvent("ready");
        this.healthState = {
          ...this.healthState,
          connectionState: "ready",
          isReady: true,
          readyAt: Date.now(),
          lastDisconnectAt: undefined,
          lastDisconnectCode: undefined,
        };
        this.refreshGatewayPing(client);

        const applicationId = client.application?.id ?? user.id;
        this.logger.info(
          buildDiscordBotInviteUrl({
            clientId: applicationId,
            permissions: DISCORD_STANDARD_INVITE_PERMISSIONS,
          }),
        );
        this.logger.info(
          buildDiscordBotInviteUrl({
            clientId: applicationId,
            permissions: PermissionFlagsBits.Administrator,
          }),
        );

        // Register/refresh slash commands on boot.
        // Strategy:
        // 1) check existence
        // 2) ALWAYS update if exists
        // 3) register if not exist
        // This avoids stale command definitions when iterating.
        const registered = await Result.tryPromise({
          try: () => this.registerSlashCommands(),
          catch: surfaceExternalFallback(externalCallFailure("register-slash-commands")),
        });
        if (registered.status === "error") {
          this.logger.error("slash command registration failed", {
            ...formatTaggedErrorForLog(registered.error),
          });
        }

        this.applyConfiguredPresence({ client, force: true });

        // Discord can clear custom presence over time; refresh periodically.
        this.presenceTimer = setInterval(
          () => {
            this.superviseDiscordCallback("presence-refresh", () => {
              this.applyConfiguredPresence({ client, force: true });
            });
          },
          30 * 60 * 1000,
        );
      });
    });

    client.on("shardReady", () => {
      this.noteGatewayEvent("shardReady");
      this.healthState = {
        ...this.healthState,
        connectionState: "ready",
        isReady: true,
        readyAt: this.healthState.readyAt ?? Date.now(),
      };
      this.refreshGatewayPing(client);
    });

    client.on("shardResume", () => {
      this.noteGatewayEvent("shardResume");
      this.healthState = {
        ...this.healthState,
        connectionState: "ready",
        isReady: true,
        lastResumeAt: Date.now(),
      };
      this.refreshGatewayPing(client);
    });

    client.on("shardDisconnect", (event) => {
      this.noteGatewayEvent("shardDisconnect");
      this.healthState = {
        ...this.healthState,
        connectionState: "disconnected",
        isReady: false,
        lastDisconnectAt: Date.now(),
        lastDisconnectCode: typeof event?.code === "number" ? event.code : undefined,
      };
    });

    client.on("shardError", (error) => {
      this.noteGatewayEvent("shardError");
      this.healthState = {
        ...this.healthState,
        lastErrorAt: Date.now(),
        lastError: error instanceof Error ? error.message : String(error),
      };
    });

    client.on("invalidated", () => {
      this.noteGatewayEvent("invalidated");
      this.healthState = {
        ...this.healthState,
        connectionState: "disconnected",
        isReady: false,
        lastDisconnectAt: Date.now(),
        lastErrorAt: Date.now(),
        lastError: "Gateway session invalidated",
      };
    });

    client.on("raw", () => {
      this.noteGatewayEvent("raw");
      this.refreshGatewayPing(client);
    });

    client.on("messageCreate", (msg) => {
      this.superviseDiscordCallback("messageCreate", () => this.onMessageCreate(msg));
    });

    client.on("messageUpdate", (_old, next) => {
      this.superviseDiscordCallback("messageUpdate", async () => {
        const fetched = next.partial
          ? await Result.tryPromise({
              try: () => next.fetch(),
              catch: surfaceExternalFallback(null),
            })
          : Result.ok(next);
        const msg = fetched.status === "ok" ? fetched.value : null;
        if (!msg) return;
        await this.onMessageUpdate(msg);
      });
    });

    client.on("messageDelete", (deleted) => {
      this.superviseDiscordCallback("messageDelete", async () => {
        const fetched = deleted.partial
          ? await Result.tryPromise({
              try: () => deleted.fetch(),
              catch: surfaceExternalFallback(null),
            })
          : Result.ok(deleted);
        const msg = fetched.status === "ok" ? fetched.value : null;
        await this.onMessageDelete(msg, deleted.id, deleted.channelId);
      });
    });

    client.on("messageReactionAdd", (reaction, user) => {
      this.superviseDiscordCallback("messageReactionAdd", async () => {
        const fetched = reaction.partial
          ? await Result.tryPromise({
              try: () => reaction.fetch(),
              catch: surfaceExternalFallback(null),
            })
          : Result.ok(reaction);
        const r = fetched.status === "ok" ? fetched.value : null;
        if (!r) return;
        await this.onReactionAdd(
          r.message,
          r.emoji.toString(),
          user?.id,
          user?.username ?? undefined,
        );
      });
    });

    client.on("messageReactionRemove", (reaction, user) => {
      this.superviseDiscordCallback("messageReactionRemove", async () => {
        const fetched = reaction.partial
          ? await Result.tryPromise({
              try: () => reaction.fetch(),
              catch: surfaceExternalFallback(null),
            })
          : Result.ok(reaction);
        const r = fetched.status === "ok" ? fetched.value : null;
        if (!r) return;
        await this.onReactionRemove(
          r.message,
          r.emoji.toString(),
          user?.id,
          user?.username ?? undefined,
        );
      });
    });

    client.on("interactionCreate", (interaction) => {
      this.superviseDiscordCallback("interactionCreate", () =>
        this.onInteractionCreate(interaction),
      );
    });

    const loggedIn = await Result.tryPromise({
      try: () => client.login(token),
      catch: surfaceExternalFallback(externalCallFailure("client.login")),
    });
    if (loggedIn.status === "error") throw loggedIn.error;

    this.logger.debug("login ok");

    this.client = client;
  }

  async disconnect(): Promise<void> {
    this.logger.info("disconnecting");

    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
    const c = this.client;
    this.client = null;
    const store = this.store;
    this.store = null;
    this.entityMapper = null;

    const [destroyed] = await Promise.allSettled([Promise.resolve().then(() => c?.destroy())]);
    const [closed] = await Promise.allSettled([Promise.resolve().then(() => store?.close())]);
    this.healthState = {
      ...this.healthState,
      connectionState: "disconnected",
      isReady: false,
      lastDisconnectAt: Date.now(),
    };

    this.logger.info("disconnected");

    if (destroyed?.status === "rejected" && Panic.is(destroyed.reason)) {
      throw destroyed.reason;
    }
    if (closed?.status === "rejected") {
      const failure =
        closed.reason instanceof Error ? closed.reason : externalCallFailure("surface-store.close");
      throw failure;
    }
  }

  getHealthSnapshot(options: { includeCache?: boolean } = {}): DiscordAdapterHealthSnapshot {
    if (this.client) {
      this.refreshGatewayPing(this.client);
    }
    return {
      ...this.healthState,
      ...(options.includeCache ? { cache: getDiscordCacheSnapshot(this.client) } : {}),
    };
  }

  async refreshCoreConfig(): Promise<void> {
    await this.reloadCoreConfigIfNeeded();
  }

  async getSelf(): Promise<SurfaceSelf> {
    if (this.self) return this.self;
    if (!this.client?.user || !this.cfg) {
      throw new DiscordAdapterUnavailable({ message: "DiscordAdapter not connected" });
    }
    return {
      platform: "discord",
      userId: this.client.user.id,
      userName: this.cfg.surface.discord.botName,
    };
  }

  async listSessions(): Promise<SurfaceOperationResult<SurfaceSession[]>> {
    const storeResult = this.storeResult();
    if (storeResult.status === "error") {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "list-sessions",
          message: storeResult.error.message,
        }),
      );
    }
    const store = storeResult.value;
    const sessions = store.listSessions();
    return Result.ok(
      sessions.map((s) => ({
        ref: asDiscordSessionRef({
          channelId: s.channel_id,
          guildId: s.guild_id,
          parentChannelId: s.parent_channel_id,
        }),
        title: s.name ?? undefined,
        kind: s.type,
      })),
    );
  }

  private async reloadCoreConfigIfNeeded(
    options: { readonly applyPresence?: boolean } = {},
  ): Promise<void> {
    if (this.opts?.config) return;

    const loaded = await Result.tryPromise({
      try: () => this.resolveCoreConfig(),
      catch: surfaceExternalFallback(externalCallFailure("load-core-config")),
    });
    if (loaded.status === "ok") {
      const cfg = loaded.value;
      this.cfg = cfg;
      if (options.applyPresence !== false) this.applyConfiguredPresence();

      if (this.coreConfigReloadHadError) {
        this.logger.info("core-config reload recovered", {
          path: "core-config.yaml",
        });
      }

      this.coreConfigReloadHadError = false;
      this.lastCoreConfigReloadError = null;
    } else {
      const msg = formatTaggedErrorForLog(loaded.error).errorMessage;
      if (!this.coreConfigReloadHadError || this.lastCoreConfigReloadError !== msg) {
        this.logger.warn("core-config reload failed; using last known config", {
          path: "core-config.yaml",
          error: msg,
        });
      }

      this.coreConfigReloadHadError = true;
      this.lastCoreConfigReloadError = msg;
    }
  }

  private async resolveCoreConfig(): Promise<CoreConfig> {
    return this.opts?.getConfig ? this.opts.getConfig() : getCoreConfig();
  }

  private applyConfiguredPresence(input: { client?: Client; force?: boolean } = {}): void {
    const client = input.client ?? this.client;
    if (!client?.user || !this.cfg) return;
    const user = client.user;

    const statusMessage = this.cfg.surface.discord.statusMessage?.trim() || null;
    if (!input.force && this.appliedStatusMessage === statusMessage) return;

    const applied = Result.try({
      try: () => {
        if (statusMessage) {
          user.setPresence({
            activities: [
              {
                name: statusMessage,
                state: statusMessage,
                type: ActivityType.Custom,
              },
            ],
            status: "online",
          });
        } else {
          user.setPresence({ activities: [], status: "online" });
        }
        this.appliedStatusMessage = statusMessage;
      },
      catch: surfaceExternalFallback(undefined),
    });
    void applied;
  }

  async burstCache(input: {
    msgRef?: MsgRef;
    sessionRef?: SessionRef;
    reason: "surface_tool" | "other";
  }): Promise<void> {
    void input.reason;

    const client = this.client;
    if (!client) return;

    const fromMsg =
      input.msgRef && input.msgRef.platform === "discord" ? input.msgRef.channelId : null;
    const fromSession =
      input.sessionRef && input.sessionRef.platform === "discord"
        ? input.sessionRef.channelId
        : null;
    const channelId = fromMsg ?? fromSession;
    if (!channelId) return;

    const fetched = await Result.tryPromise({
      try: () => client.channels.fetch(channelId),
      catch: surfaceExternalFallback(null),
    });
    const ch =
      client.channels.cache.get(channelId) ?? (fetched.status === "ok" ? fetched.value : null);
    if (!ch || !("messages" in ch) || !ch.messages?.cache) return;

    if (input.msgRef && input.msgRef.platform === "discord") {
      const cached = ch.messages.cache.get(input.msgRef.messageId);
      if (cached) {
        for (const r of cached.reactions.cache.values()) {
          r.users.cache.clear();
        }
        cached.reactions.cache.clear();
      }
      ch.messages.cache.delete(input.msgRef.messageId);
      return;
    }

    // "Latest view" reads generally want a fresh channel snapshot.
    ch.messages.cache.clear();
  }

  /** Lightweight Discord API fetch to get a channel's guildId (no history). */
  async fetchGuildIdForChannel(channelId: string): Promise<string | null> {
    const client = this.client;
    if (!client) {
      throw new DiscordAdapterUnavailable({ message: "DiscordAdapter not connected" });
    }

    const fetched = await Result.tryPromise({
      try: () => client.channels.fetch(channelId),
      catch: surfaceExternalFallback(null),
    });
    const ch = fetched.status === "ok" ? fetched.value : null;
    if (!ch) return null;

    return ch && "guildId" in ch ? ch.guildId : null;
  }

  async startOutput(
    sessionRef: SessionRef,
    opts?: StartOutputOpts,
  ): Promise<SurfaceOperationResult<import("../adapter").SurfaceOutputStream>> {
    const refResult = discordSessionRefResult("start-output", sessionRef);
    if (refResult.status === "error") return refResult;
    const discordRef = refResult.value;
    if (opts?.replyTo) {
      const reply = discordNestedMsgRefResult({
        operation: "start-output",
        sessionRef: discordRef,
        msgRef: opts.replyTo,
        refRole: "replyTo",
      });
      if (reply.status === "error") return reply;
    }
    for (const [index, created] of (opts?.resume?.created ?? []).entries()) {
      const resumed = discordNestedMsgRefResult({
        operation: "start-output",
        sessionRef: discordRef,
        msgRef: created,
        refRole: `resume.created[${index}]`,
      });
      if (resumed.status === "error") return resumed;
    }
    await this.reloadCoreConfigIfNeeded({
      applyPresence: opts?.preparationMode !== "paused-recovery",
    });

    const cfg = this.cfg;
    const clientResult = this.clientResult();
    if (clientResult.status === "error") {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "start-output",
          message: clientResult.error.message,
        }),
      );
    }
    const client = clientResult.value;
    if (!cfg) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "start-output",
          message: "DiscordAdapter not connected",
        }),
      );
    }
    const markdownTableRender = resolveMarkdownTableRenderOptions(cfg);
    const markdownMathRender = resolveMarkdownMathRenderOptions(cfg);

    // TODO: plumb config for smart splitting.
    const useSmartSplitting = true;

    return Result.ok(
      new DiscordOutputStream({
        client,
        sessionRef: discordRef,
        opts,
        useSmartSplitting,
        rewriteText: this.entityMapper?.rewriteOutgoingText,
        markdownTableRender,
        markdownMathRender,
        reasoningDisplayMode: cfg.agent.reasoningDisplay ?? "simple",
        outputMode: cfg.surface.discord.outputMode ?? "inline",
        outputPreviewModeFinalStyle: cfg.surface.discord.outputPreviewModeFinalStyle ?? "embed",
        outputNotification: resolveOutputNotificationEnabled({
          configured: cfg.surface.discord.outputNotification,
          silent: opts?.silent,
        }),
        workingIndicators: cfg.surface.discord.workingIndicators ?? ["Working"],
      }),
    );
  }

  async startTyping(
    sessionRef: SessionRef,
  ): Promise<SurfaceOperationResult<import("../adapter").TypingIndicatorSubscription>> {
    const refResult = discordSessionRefResult("start-typing", sessionRef);
    if (refResult.status === "error") return refResult;
    const clientResult = this.clientResult();
    if (clientResult.status === "error") {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "start-typing",
          message: clientResult.error.message,
        }),
      );
    }
    const client = clientResult.value;
    const discordRef = refResult.value;

    const fetched = await captureDiscordOperation("start-typing", () =>
      client.channels.fetch(discordRef.channelId),
    );
    if (fetched.status === "error") return fetched;
    const ch = fetched.value;

    const sendTyping = ch && "sendTyping" in ch ? ch.sendTyping : null;

    if (!sendTyping) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "start-typing",
          message: `Discord channel cannot accept typing indicators: ${discordRef.channelId}`,
        }),
      );
    }

    // Discord typing indicators last ~10s; refresh a bit earlier.
    const REFRESH_MS = 8000;

    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let consecutiveFailures = 0;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    const tick = async () => {
      if (stopped) return;
      const sent = await Result.tryPromise({
        try: () => sendTyping.call(ch),
        catch: surfaceExternalFallback(externalCallFailure("channel.sendTyping")),
      });
      if (sent.status === "ok") {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
        // Best-effort: avoid spamming if missing perms / rate-limited.
        if (consecutiveFailures >= 3) {
          stop();
        }
      }
    };

    const initial = await captureDiscordOperation("start-typing", () => sendTyping.call(ch));
    if (initial.status === "error") return initial;
    timer = setInterval(() => {
      this.superviseDiscordCallback("typing-indicator", tick);
    }, REFRESH_MS);

    return Result.ok({
      stop: async () => {
        stop();
        return Result.ok(undefined);
      },
    });
  }

  async prepareSendMsg(
    sessionRef: SessionRef,
    input: SurfaceSendPreparationInput,
    opts?: SendOpts,
  ): Promise<SurfaceOperationResult<void>> {
    const prepared = prepareDiscordSendResult(sessionRef, input, opts);
    return prepared.status === "error" ? prepared : Result.ok(undefined);
  }

  async sendMsg(
    sessionRef: SessionRef,
    content: ContentOpts,
    opts?: SendOpts,
  ): Promise<SurfaceOperationResult<MsgRef>> {
    const prepared = prepareDiscordSendResult(
      sessionRef,
      {
        text: content.text,
        attachmentCount: content.attachments?.length ?? 0,
        actionCount: content.actions?.length ?? 0,
      },
      opts,
    );
    if (prepared.status === "error") return prepared;
    const discordRef = prepared.value;
    await this.reloadCoreConfigIfNeeded();

    const cfg = this.cfg;
    const clientResult = this.clientResult();
    if (clientResult.status === "error") {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "send-message",
          message: clientResult.error.message,
        }),
      );
    }
    const client = clientResult.value;
    const markdownTableRender = resolveMarkdownTableRenderOptions(cfg);
    const markdownMathRender = resolveMarkdownMathRenderOptions(cfg);

    const useSmartSplitting = true;

    if (content.actions && content.actions.length > 0) {
      const fetched = await captureDiscordOperation("send-message", () =>
        client.channels.fetch(discordRef.channelId),
      );
      if (fetched.status === "error") return fetched;
      const channel = fetched.value;
      if (!channel || !("send" in channel)) {
        return Result.err(
          new SurfaceMessageNotFound({
            platform: "discord",
            operation: "send-message",
            message: `Discord channel not found: ${discordRef.channelId}`,
          }),
        );
      }
      const components = buildDiscordActionComponentsResult(content.actions);
      if (components.status === "error") {
        return Result.err(
          new SurfaceInvalidInput({
            platform: "discord",
            operation: "send-message",
            field: "content.actions",
            message: components.error.message,
          }),
        );
      }
      const text = this.entityMapper?.rewriteOutgoingText(content.text ?? "") ?? content.text ?? "";
      const sent = await captureDiscordOperation("send-message", async () =>
        channel.send({
          embeds: [new EmbedBuilder().setDescription(text || "*<empty_string>*")],
          components: components.value,
          files: content.attachments?.map((attachment) => ({
            attachment: Buffer.from(attachment.bytes),
            name: attachment.filename,
          })),
          reply:
            opts?.replyTo?.platform === "discord"
              ? { messageReference: opts.replyTo.messageId }
              : undefined,
          allowedMentions: { parse: [], repliedUser: false },
        }),
      );
      if (sent.status === "error") return sent;
      return Result.ok(asDiscordMsgRef(discordRef.channelId, sent.value.id));
    }

    return await sendDiscordStyledMessage({
      client,
      sessionRef: discordRef,
      content,
      opts: opts?.replyTo ? { replyTo: opts.replyTo } : undefined,
      useSmartSplitting,
      rewriteText: this.entityMapper?.rewriteOutgoingText,
      markdownTableRender,
      markdownMathRender,
      outputNotification: resolveOutputNotificationEnabled({
        configured: cfg?.surface.discord.outputNotification,
        silent: opts?.silent,
      }),
    });
  }

  async readMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage | null>> {
    const refResult = discordMsgRefResult("read-message", msgRef);
    if (refResult.status === "error") return refResult;
    const discordRef = refResult.value;

    const fetched = await captureDiscordOperation("read-message", () =>
      this.fetchDiscordMessage({
        channelId: discordRef.channelId,
        messageId: discordRef.messageId,
      }),
    );
    if (fetched.status === "error") return fetched;
    const msg = fetched.value;

    if (!msg) return Result.ok(null);

    const projected = this.toSurfaceMessageFromDiscordMessageResult(msg);
    if (projected.status === "error") {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "read-message",
          message: projected.error.message,
        }),
      );
    }
    return Result.ok(projected.value);
  }

  async listMsg(
    sessionRef: SessionRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const refResult = discordSessionRefResult("list-messages", sessionRef);
    if (refResult.status === "error") return refResult;
    const discordRef = refResult.value;

    const limit = Math.min(200, Math.max(1, opts?.limit ?? 50));

    const listed = await captureDiscordOperation("list-messages", () =>
      this.fetchDiscordMessages({
        channelId: discordRef.channelId,
        limit,
        beforeMessageId: opts?.beforeMessageId,
        afterMessageId: opts?.afterMessageId,
      }),
    );
    if (listed.status === "error") return listed;
    const messages = listed.value;

    const projected: SurfaceMessage[] = [];
    for (const message of messages) {
      const result = this.toSurfaceMessageFromDiscordMessageResult(message);
      if (result.status === "error") {
        return Result.err(
          new SurfaceUnavailable({
            platform: "discord",
            operation: "list-messages",
            message: result.error.message,
          }),
        );
      }
      projected.push(result.value);
    }
    return Result.ok(projected);
  }

  async editMsg(msgRef: MsgRef, content: ContentOpts): Promise<SurfaceOperationResult<void>> {
    const refResult = discordMsgRefResult("edit-message", msgRef);
    if (refResult.status === "error") return refResult;
    const clientResult = this.clientResult();
    if (clientResult.status === "error") {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "edit-message",
          message: clientResult.error.message,
        }),
      );
    }
    const client = clientResult.value;
    const discordRef = refResult.value;
    if (!client.user) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "edit-message",
          message: "Discord client user is unavailable",
        }),
      );
    }

    const channelResult = await captureDiscordOperation("edit-message", () =>
      client.channels.fetch(discordRef.channelId),
    );
    if (channelResult.status === "error") return channelResult;
    const channel = channelResult.value;
    if (!channel || !("messages" in channel) || !channel.messages?.fetch) {
      return Result.err(
        new SurfaceMessageNotFound({
          platform: "discord",
          operation: "edit-message",
          message: `Discord channel not found: ${discordRef.channelId}`,
        }),
      );
    }

    const messageResult = await captureDiscordOperation("edit-message", () =>
      channel.messages.fetch({ message: discordRef.messageId, cache: false, force: true }),
    );
    if (messageResult.status === "error") return messageResult;
    const msg = messageResult.value;

    const raw = content.text ?? "";
    const rewritten = this.entityMapper?.rewriteOutgoingText(raw) ?? raw;
    const editTarget = resolveDiscordSurfaceEditTargetResult({
      authorId: msg.author?.id,
      selfUserId: client.user.id,
      embedCount: msg.embeds.length,
      content: msg.content,
    });
    if (editTarget.status === "error") {
      return Result.err(
        new SurfacePermissionDenied({
          platform: "discord",
          operation: "edit-message",
          message: editTarget.error.message,
        }),
      );
    }

    const componentsResult =
      content.actions === undefined
        ? Result.ok(undefined)
        : buildDiscordActionComponentsResult(content.actions);
    if (componentsResult.status === "error") {
      return Result.err(
        new SurfaceInvalidInput({
          platform: "discord",
          operation: "edit-message",
          field: "content.actions",
          message: componentsResult.error.message,
        }),
      );
    }
    const components = componentsResult.value;
    const attachmentEdit =
      content.attachments === undefined
        ? {}
        : {
            attachments: [],
            files: content.attachments.map((attachment) => ({
              attachment: Buffer.from(attachment.bytes),
              name: attachment.filename,
            })),
          };

    if (editTarget.value === "content") {
      const edited = await captureDiscordOperation("edit-message", () =>
        msg.edit({ content: rewritten, components, ...attachmentEdit }),
      );
      return edited.status === "error" ? edited : Result.ok(undefined);
    }

    const existingEmbed = msg.embeds[0];
    if (!existingEmbed) {
      return Result.err(
        new SurfaceInvalidInput({
          platform: "discord",
          operation: "edit-message",
          field: "message",
          message: "Discord message embed could not be resolved for editing",
        }),
      );
    }

    const embed = new EmbedBuilder(existingEmbed.toJSON());
    embed.setDescription(rewritten);
    const edited = await captureDiscordOperation("edit-message", () =>
      msg.edit({ embeds: [embed], components, ...attachmentEdit }),
    );
    return edited.status === "error" ? edited : Result.ok(undefined);
  }

  async deleteMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<void>> {
    const refResult = discordMsgRefResult("delete-message", msgRef);
    if (refResult.status === "error") return refResult;
    const clientResult = this.clientResult();
    if (clientResult.status === "error") {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "delete-message",
          message: clientResult.error.message,
        }),
      );
    }
    const client = clientResult.value;
    const discordRef = refResult.value;

    const fetched = await captureDiscordOperation("delete-message", () =>
      client.channels.fetch(discordRef.channelId),
    );
    if (fetched.status === "error") return fetched;
    const channel = fetched.value;
    if (!channel || !("messages" in channel) || !channel.messages?.fetch) {
      return Result.err(
        new SurfaceMessageNotFound({
          platform: "discord",
          operation: "delete-message",
          message: `Discord channel not found: ${discordRef.channelId}`,
        }),
      );
    }

    const message = await captureDiscordOperation("delete-message", () =>
      channel.messages.fetch({ message: discordRef.messageId, cache: false, force: true }),
    );
    if (message.status === "error") return message;
    const deleted = await captureDiscordOperation("delete-message", () => message.value.delete());
    return deleted.status === "error" ? deleted : Result.ok(undefined);
  }

  async getReplyContext(
    msgRef: MsgRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const refResult = discordMsgRefResult("get-reply-context", msgRef);
    if (refResult.status === "error") return refResult;
    const discordRef = refResult.value;

    const limit = Math.min(100, Math.max(1, opts?.limit ?? 20));

    const listed = await captureDiscordOperation("get-reply-context", () =>
      this.fetchDiscordMessages({
        channelId: discordRef.channelId,
        limit,
        aroundMessageId: discordRef.messageId,
      }),
    );
    if (listed.status === "error") return listed;
    const messages = listed.value;

    const projected: SurfaceMessage[] = [];
    for (const message of messages) {
      const result = this.toSurfaceMessageFromDiscordMessageResult(message);
      if (result.status === "error") {
        return Result.err(
          new SurfaceUnavailable({
            platform: "discord",
            operation: "get-reply-context",
            message: result.error.message,
          }),
        );
      }
      projected.push(result.value);
    }
    return Result.ok(
      projected.sort((a, b) => {
        if (a.ts !== b.ts) return a.ts - b.ts;
        return compareDiscordSnowflake(a.ref.messageId, b.ref.messageId);
      }),
    );
  }

  async planReplyChain(
    msgRef: MsgRef,
    opts?: SurfaceReplyChainPlanOptions,
  ): Promise<SurfaceOperationResult<readonly MsgRef[]>> {
    const refResult = discordMsgRefResult("plan-reply-chain", msgRef);
    if (refResult.status === "error") return refResult;
    msgRef = refResult.value;

    const maxDepth = Math.min(100, Math.max(1, Math.floor(opts?.maxDepth ?? 20)));

    const out: MsgRef[] = [];
    const seen = new Set<string>();

    let currentChannelId = msgRef.channelId;
    let currentMessageId = msgRef.messageId;

    for (let depth = 0; depth < maxDepth; depth++) {
      const key = `${currentChannelId}:${currentMessageId}`;
      if (seen.has(key)) break;
      seen.add(key);

      const relation = await this.ensureMessageRelation("plan-reply-chain", {
        platform: "discord",
        channelId: currentChannelId,
        messageId: currentMessageId,
      });
      if (relation.status === "error") return relation;
      const rel = relation.value;

      if (!rel) {
        if (depth === 0) {
          out.push({
            platform: "discord",
            channelId: currentChannelId,
            messageId: currentMessageId,
          });
        }
        break;
      }

      out.push({
        platform: "discord",
        channelId: rel.channel_id,
        messageId: rel.message_id,
      });

      if (!rel.reply_to_message_id) break;

      const replyChannelId = rel.reply_to_channel_id ?? rel.channel_id;
      if (replyChannelId !== msgRef.channelId) break;
      currentChannelId = replyChannelId;
      currentMessageId = rel.reply_to_message_id;
    }

    out.reverse();
    return Result.ok(out);
  }

  async planMergeBlockEndingAt(
    msgRef: MsgRef,
    opts?: SurfaceMergeBlockPlanOptions,
  ): Promise<SurfaceOperationResult<readonly MsgRef[]>> {
    const refResult = discordMsgRefResult("plan-merge-block", msgRef);
    if (refResult.status === "error") return refResult;
    msgRef = refResult.value;

    const lookbackLimit = Math.min(200, Math.max(5, Math.floor(opts?.lookbackLimit ?? 50)));

    const relationResult = await this.ensureMessageRelation("plan-merge-block", msgRef);
    if (relationResult.status === "error") return relationResult;
    const relation = relationResult.value;
    if (!relation) return Result.ok([msgRef]);
    const store = this.store;
    if (!store) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "plan-merge-block",
          message: "DiscordAdapter not connected",
        }),
      );
    }

    const list = store.listMessageRelationsBeforeOrAt({
      channelId: relation.channel_id,
      messageId: relation.message_id,
      limit: lookbackLimit,
    });

    const targetIndex = list.findIndex((m) => m.message_id === relation.message_id);
    if (targetIndex < 0) {
      return Result.ok([
        {
          platform: "discord",
          channelId: relation.channel_id,
          messageId: relation.message_id,
        },
      ]);
    }

    const authorId = list[targetIndex]!.author_id;
    let runStart = targetIndex;
    for (let i = targetIndex - 1; i >= 0; i--) {
      const prev = list[i]!;
      if (prev.author_id !== authorId) break;
      runStart = i;
    }

    const run = list.slice(runStart, targetIndex + 1);

    const groups = splitByDiscordWindowOldestToNewest(
      run.map((m) => ({
        message: m,
        authorId: m.author_id,
        ts: m.ts,
        hardBreakBefore: Boolean(m.reply_to_message_id),
      })),
    );

    const endingGroup = groups[groups.length - 1] ?? [];
    if (endingGroup.length === 0) {
      return Result.ok([
        {
          platform: "discord",
          channelId: relation.channel_id,
          messageId: relation.message_id,
        },
      ]);
    }

    return Result.ok(
      endingGroup.map((item) => ({
        platform: "discord",
        channelId: item.message.channel_id,
        messageId: item.message.message_id,
      })),
    );
  }

  async addReaction(msgRef: MsgRef, reaction: string): Promise<SurfaceOperationResult<void>> {
    const refResult = discordMsgRefResult("add-reaction", msgRef);
    if (refResult.status === "error") return refResult;
    if (!reaction.trim()) {
      return Result.err(
        new SurfaceInvalidInput({
          platform: "discord",
          operation: "add-reaction",
          field: "reaction",
          message: "Reaction is required",
        }),
      );
    }
    const clientResult = this.clientResult();
    if (clientResult.status === "error") {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "add-reaction",
          message: clientResult.error.message,
        }),
      );
    }
    const client = clientResult.value;
    const discordRef = refResult.value;

    const fetched = await captureDiscordOperation("add-reaction", () =>
      client.channels.fetch(discordRef.channelId),
    );
    if (fetched.status === "error") return fetched;
    const channel = fetched.value;
    if (!channel || !("messages" in channel) || !channel.messages?.fetch) {
      return Result.err(
        new SurfaceMessageNotFound({
          platform: "discord",
          operation: "add-reaction",
          message: `Discord channel not found: ${discordRef.channelId}`,
        }),
      );
    }
    const message = await captureDiscordOperation("add-reaction", () =>
      channel.messages.fetch({
        message: discordRef.messageId,
        cache: false,
        force: true,
      }),
    );
    if (message.status === "error") return message;
    const reacted = await captureDiscordOperation("add-reaction", () =>
      message.value.react(reaction),
    );
    return reacted.status === "error" ? reacted : Result.ok(undefined);
  }

  async removeReaction(msgRef: MsgRef, reaction: string): Promise<SurfaceOperationResult<void>> {
    const refResult = discordMsgRefResult("remove-reaction", msgRef);
    if (refResult.status === "error") return refResult;
    if (!reaction.trim()) {
      return Result.err(
        new SurfaceInvalidInput({
          platform: "discord",
          operation: "remove-reaction",
          field: "reaction",
          message: "Reaction is required",
        }),
      );
    }
    const clientResult = this.clientResult();
    if (clientResult.status === "error") {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "remove-reaction",
          message: clientResult.error.message,
        }),
      );
    }
    const client = clientResult.value;
    const discordRef = refResult.value;

    const fetched = await captureDiscordOperation("remove-reaction", () =>
      client.channels.fetch(discordRef.channelId),
    );
    if (fetched.status === "error") return fetched;
    const channel = fetched.value;
    if (!channel || !("messages" in channel) || !channel.messages?.fetch) {
      return Result.err(
        new SurfaceMessageNotFound({
          platform: "discord",
          operation: "remove-reaction",
          message: `Discord channel not found: ${discordRef.channelId}`,
        }),
      );
    }
    const message = await captureDiscordOperation("remove-reaction", () =>
      channel.messages.fetch({
        message: discordRef.messageId,
        cache: false,
        force: true,
      }),
    );
    if (message.status === "error") return message;
    const resolvedReaction = message.value.reactions.resolve(reaction);
    if (!resolvedReaction) return Result.ok(undefined);
    const removed = await captureDiscordOperation("remove-reaction", () =>
      resolvedReaction.remove(),
    );
    return removed.status === "error" ? removed : Result.ok(undefined);
  }

  async listReactions(msgRef: MsgRef): Promise<SurfaceOperationResult<string[]>> {
    const refResult = discordMsgRefResult("list-reactions", msgRef);
    if (refResult.status === "error") return refResult;
    const discordRef = refResult.value;

    const fetched = await captureDiscordOperation("list-reactions", () =>
      this.fetchDiscordMessage({
        channelId: discordRef.channelId,
        messageId: discordRef.messageId,
      }),
    );
    if (fetched.status === "error") return fetched;
    const msg = fetched.value;
    if (!msg) {
      return Result.err(
        new SurfaceMessageNotFound({
          platform: "discord",
          operation: "list-reactions",
          message: `Discord message not found: ${discordRef.messageId}`,
        }),
      );
    }

    return Result.ok(
      [...new Set([...msg.reactions.cache.values()].map((r) => r.emoji.toString()))].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
  }

  async listReactionDetails(
    msgRef: MsgRef,
  ): Promise<SurfaceOperationResult<SurfaceReactionDetail[]>> {
    const refResult = discordMsgRefResult("list-reaction-details", msgRef);
    if (refResult.status === "error") return refResult;
    const storeResult = this.storeResult();
    if (storeResult.status === "error") {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "list-reaction-details",
          message: storeResult.error.message,
        }),
      );
    }
    const discordRef = refResult.value;
    const store = storeResult.value;

    const fetched = await captureDiscordOperation("list-reaction-details", () =>
      this.fetchDiscordMessage({
        channelId: discordRef.channelId,
        messageId: discordRef.messageId,
      }),
    );
    if (fetched.status === "error") return fetched;
    const msg = fetched.value;
    if (!msg) {
      return Result.err(
        new SurfaceMessageNotFound({
          platform: "discord",
          operation: "list-reaction-details",
          message: `Discord message not found: ${discordRef.messageId}`,
        }),
      );
    }

    const now = Date.now();

    const out: SurfaceReactionDetail[] = [];
    const reactions = [...msg.reactions.cache.values()];

    for (const reaction of reactions) {
      const emoji = reaction.emoji.toString();

      const users = await this.fetchAllReactionUsers("list-reaction-details", reaction, {
        maxUsers: 1000,
      });
      if (users.status === "error") return users;

      const list = [...users.value.values()]
        .map((u) => {
          const cached = store.getUserName(u.id);
          const cachedName =
            cached?.display_name ?? cached?.global_name ?? cached?.username ?? undefined;
          const liveName = (u.globalName ?? u.username) || undefined;
          const userName = cachedName ?? liveName;

          // Best-effort: keep the name caches warm for entity mapping.
          store.upsertUserName({
            userId: u.id,
            username: u.username,
            globalName: u.globalName ?? undefined,
            displayName: userName,
            updatedTs: now,
          });

          return { userId: u.id, userName };
        })
        .sort((a, b) => a.userId.localeCompare(b.userId));

      out.push({
        emoji,
        count: reaction.count ?? list.length,
        users: list,
      });
    }

    out.sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return a.emoji.localeCompare(b.emoji);
    });

    return Result.ok(out);
  }

  async listSessionParticipants(
    sessionRef: SessionRef,
    opts?: { limit?: number },
  ): Promise<SurfaceOperationResult<SurfaceSessionParticipantsResult>> {
    const refResult = discordSessionRefResult("list-session-participants", sessionRef);
    if (refResult.status === "error") return refResult;
    const discordRef = refResult.value;

    const cfg = this.cfg;
    const client = this.client;
    const store = this.store;
    if (!cfg || !client || !store) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "list-session-participants",
          message: "DiscordAdapter not connected",
        }),
      );
    }

    const fetched = await captureDiscordOperation("list-session-participants", () =>
      client.channels.fetch(discordRef.channelId),
    );
    if (fetched.status === "error") return fetched;
    const ch = fetched.value;
    if (!ch) {
      return Result.err(
        new SurfaceMessageNotFound({
          platform: "discord",
          operation: "list-session-participants",
          message: `Discord channel not found: ${discordRef.channelId}`,
        }),
      );
    }

    const guildId = "guildId" in ch ? ch.guildId : null;
    if (
      !shouldAllowMessage({
        cfg,
        channelId: discordRef.channelId,
        guildId,
      })
    ) {
      return Result.err(
        new SurfacePermissionDenied({
          platform: "discord",
          operation: "list-session-participants",
          message: `Not allowed: channelId '${discordRef.channelId}'`,
        }),
      );
    }

    const limit = Math.min(2000, Math.max(1, Math.floor(opts?.limit ?? 200)));

    if ("isThread" in ch && typeof ch.isThread === "function" && ch.isThread()) {
      const out: SurfaceSessionParticipant[] = [];
      let after: string | undefined;
      while (out.length < limit) {
        const pageLimit = Math.min(100, limit - out.length);
        const fetchedMembers = await captureDiscordOperation("list-session-participants", () =>
          ch.members.fetch({
            withMember: true,
            limit: pageLimit,
            ...(after ? { after } : {}),
            cache: false,
          }),
        );
        if (fetchedMembers.status === "error") return fetchedMembers;
        const members = fetchedMembers.value;
        if (members.size === 0) break;

        for (const threadMember of members.values()) {
          if (out.length >= limit) break;
          const userId = threadMember.id;
          if (!userId) continue;

          const member = threadMember.guildMember;
          const user = threadMember.user ?? member.user;
          out.push(
            this.toSurfaceSessionParticipant({
              store,
              userId,
              member,
              user,
              presence: member?.presence ?? ch.guild.presences.cache.get(userId) ?? null,
            }),
          );
        }

        after = members.lastKey() ?? undefined;
        if (!after || members.size < pageLimit) break;
      }

      return Result.ok({
        source: "thread_members",
        participants: sortSurfaceParticipants(out),
      });
    }

    const guild = "guild" in ch ? ch.guild : null;
    if (!guild) {
      return Result.ok({ source: "guild_members", participants: [] });
    }

    const out: SurfaceSessionParticipant[] = [];
    const seenUserIds = new Set<string>();

    let after: string | undefined;
    let exhausted = false;

    while (out.length < limit) {
      const pageLimit = Math.min(1000, Math.max(1, limit - out.length));
      const listed = await captureDiscordOperation("list-session-participants", () =>
        guild.members.list({ limit: pageLimit, ...(after ? { after } : {}), cache: false }),
      );
      if (listed.status === "error") return listed;
      const page = listed.value;

      if (page.size === 0) {
        exhausted = true;
        break;
      }

      for (const member of page.values()) {
        if (out.length >= limit) break;

        if ("permissionsFor" in ch && typeof ch.permissionsFor === "function") {
          const permissions = ch.permissionsFor(member);
          if (permissions && !permissions.has(PermissionFlagsBits.ViewChannel)) {
            continue;
          }
        }

        out.push(
          this.toSurfaceSessionParticipant({
            store,
            userId: member.id,
            member,
            user: member.user,
            presence: member.presence ?? guild.presences.cache.get(member.id) ?? null,
          }),
        );
        seenUserIds.add(member.id);
      }

      after = page.lastKey() ?? undefined;
      if (!after || page.size < pageLimit) {
        exhausted = true;
        break;
      }
    }

    if (out.length < limit && exhausted) {
      for (const member of guild.members.cache.values()) {
        if (out.length >= limit) break;
        if (seenUserIds.has(member.id)) continue;

        if ("permissionsFor" in ch && typeof ch.permissionsFor === "function") {
          const permissions = ch.permissionsFor(member);
          if (permissions && !permissions.has(PermissionFlagsBits.ViewChannel)) {
            continue;
          }
        }

        out.push(
          this.toSurfaceSessionParticipant({
            store,
            userId: member.id,
            member,
            user: member.user,
            presence: member.presence ?? guild.presences.cache.get(member.id) ?? null,
          }),
        );
        seenUserIds.add(member.id);
      }
    }

    return Result.ok({
      source: "guild_members",
      participants: sortSurfaceParticipants(out),
    });
  }

  private toSurfaceSessionParticipant(input: {
    store: DiscordSurfaceStore;
    userId: string;
    member?: GuildMember | null;
    user?: User | null;
    presence?: Presence | null;
  }): SurfaceSessionParticipant {
    const store = input.store;
    const now = Date.now();

    const user = input.user ?? input.member?.user ?? null;
    const userName = user?.username;
    const displayName = input.member?.displayName ?? user?.globalName ?? user?.username;
    const presence = input.presence ?? input.member?.presence ?? null;

    if (user) {
      store.upsertUserName({
        userId: input.userId,
        username: user.username,
        globalName: user.globalName ?? undefined,
        displayName,
        updatedTs: now,
      });
    }

    const out: SurfaceSessionParticipant = {
      userId: input.userId,
      ...(userName ? { userName } : {}),
      ...(displayName ? { displayName } : {}),
    };

    if (presence?.status) {
      out.status = presence.status;
    }

    const activities = toSurfaceParticipantActivities(presence);
    if (activities.length > 0) {
      out.activities = activities;
    }

    return out;
  }

  private async fetchAllReactionUsers(
    operation: SurfaceOperation,
    reaction: MessageReaction,
    opts: { maxUsers: number },
  ): Promise<SurfaceOperationResult<Map<string, User>>> {
    const out = new Map<string, User>();

    const pageLimit = 100;
    let after: string | undefined;

    while (out.size < opts.maxUsers) {
      const fetched = await captureDiscordOperation(operation, () =>
        reaction.users.fetch({ limit: pageLimit, ...(after ? { after } : {}) }),
      );
      if (fetched.status === "error") return fetched;
      const res = fetched.value;
      if (res.size === 0) break;

      for (const u of res.values()) {
        out.set(u.id, u);
      }

      if (res.size < pageLimit) break;
      after = res.lastKey() ?? undefined;
      if (!after) break;

      const expected = reaction.count;
      if (typeof expected === "number" && Number.isFinite(expected) && out.size >= expected) {
        break;
      }
    }

    return Result.ok(out);
  }

  async subscribe(handler: AdapterEventHandler): Promise<AdapterSubscription> {
    this.handlers.add(handler);
    return {
      stop: async () => {
        this.handlers.delete(handler);
      },
    };
  }

  async getUnRead(sessionRef: SessionRef): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const refResult = discordSessionRefResult("get-unread", sessionRef);
    if (refResult.status === "error") return refResult;
    const storeResult = this.storeResult();
    if (storeResult.status === "error") {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "get-unread",
          message: storeResult.error.message,
        }),
      );
    }
    const store = storeResult.value;
    const discordRef = refResult.value;

    const rs = store.getOrInitReadState(discordRef.channelId);

    // Best-effort: fetch a recent window and filter locally.
    const recent = await this.listMsg(sessionRef, { limit: 100 });
    if (recent.status === "error") return recent;

    const unread = recent.value.filter((m) => {
      if (m.deleted) return false;
      if (m.ts > rs.last_read_ts) return true;
      if (m.ts < rs.last_read_ts) return false;
      return compareDiscordSnowflake(m.ref.messageId, rs.last_read_message_id) > 0;
    });

    unread.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      return compareDiscordSnowflake(a.ref.messageId, b.ref.messageId);
    });

    return Result.ok(unread);
  }

  async markRead(
    sessionRef: SessionRef,
    upToMsgRef?: MsgRef,
  ): Promise<SurfaceOperationResult<void>> {
    const refResult = discordSessionRefResult("mark-read", sessionRef);
    if (refResult.status === "error") return refResult;
    const discordRef = refResult.value;
    let discordUpToRef: DiscordMsgRef | undefined;
    if (upToMsgRef) {
      const upToResult = discordNestedMsgRefResult({
        operation: "mark-read",
        sessionRef: discordRef,
        msgRef: upToMsgRef,
        refRole: "upToMsgRef",
      });
      if (upToResult.status === "error") return upToResult;
      discordUpToRef = upToResult.value;
    }
    const storeResult = this.storeResult();
    if (storeResult.status === "error") {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "mark-read",
          message: storeResult.error.message,
        }),
      );
    }
    const store = storeResult.value;

    if (discordUpToRef) {
      const fetched = await captureDiscordOperation("mark-read", () =>
        this.fetchDiscordMessage({
          channelId: discordUpToRef.channelId,
          messageId: discordUpToRef.messageId,
        }),
      );
      if (fetched.status === "error") return fetched;
      const msg = fetched.value;

      if (!msg) {
        return Result.err(
          new SurfaceMessageNotFound({
            platform: "discord",
            operation: "mark-read",
            message: `Discord message not found: ${discordUpToRef.messageId}`,
          }),
        );
      }

      store.setReadState({
        channelId: discordRef.channelId,
        lastReadTs: getMessageTs(msg),
        lastReadMessageId: msg.id,
      });
      return Result.ok(undefined);
    }

    const fetchedLatest = await captureDiscordOperation("mark-read", () =>
      this.fetchLatestDiscordMessage(discordRef.channelId),
    );
    if (fetchedLatest.status === "error") return fetchedLatest;
    const latest = fetchedLatest.value;
    if (!latest) return Result.ok(undefined);
    store.setReadState({
      channelId: discordRef.channelId,
      lastReadTs: getMessageTs(latest),
      lastReadMessageId: latest.id,
    });
    return Result.ok(undefined);
  }

  // --- internals ---

  private clientResult(): ResultType<Client, DiscordAdapterUnavailable> {
    if (this.client) return Result.ok(this.client);
    return Result.err(new DiscordAdapterUnavailable({ message: "DiscordAdapter not connected" }));
  }

  private storeResult(): ResultType<DiscordSurfaceStore, DiscordAdapterUnavailable> {
    if (this.store) return Result.ok(this.store);
    return Result.err(new DiscordAdapterUnavailable({ message: "DiscordAdapter not connected" }));
  }

  private async ensureMessageRelation(
    operation: "plan-reply-chain" | "plan-merge-block",
    msgRef: MsgRef,
  ): Promise<SurfaceOperationResult<DbDiscordMessageRelation | null>> {
    if (msgRef.platform !== "discord") {
      return Result.err(
        new SurfacePlatformMismatch({
          operation,
          refRole: "msgRef",
          expectedPlatform: "discord",
          receivedPlatform: msgRef.platform,
          message: `Expected a Discord msgRef, received '${msgRef.platform}'`,
        }),
      );
    }

    const store = this.store;
    if (!store) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation,
          message: "DiscordAdapter not connected",
        }),
      );
    }

    const existing = store.getMessageRelation(msgRef.channelId, msgRef.messageId);
    if (existing) return Result.ok(existing);

    const read = await this.readMsg(msgRef);
    if (read.status === "error") return read;

    return Result.ok(store.getMessageRelation(msgRef.channelId, msgRef.messageId));
  }

  private noteGatewayEvent(_event: string) {
    this.healthState = {
      ...this.healthState,
      lastGatewayEventAt: Date.now(),
    };
    if (this.client) {
      this.refreshGatewayPing(this.client);
    }
  }

  private refreshGatewayPing(client: Client) {
    const ping = client.ws.ping;
    const lastGatewayPingAt = getLatestGatewayPingAt(client);
    if ((!Number.isFinite(ping) || ping < 0) && lastGatewayPingAt === undefined) return;
    this.healthState = {
      ...this.healthState,
      ...(Number.isFinite(ping) && ping >= 0 ? { gatewayPingMs: ping } : {}),
      ...(lastGatewayPingAt !== undefined ? { lastGatewayPingAt } : {}),
    };
  }

  private upsertMessageRelationFromDiscordMessage(msg: Message, input?: { deleted?: boolean }) {
    const store = this.store;
    if (!store) return;

    const replyRef = getReplyReference(msg);

    store.upsertMessageRelation({
      channelId: msg.channelId,
      messageId: msg.id,
      guildId: msg.guildId ?? undefined,
      authorId: msg.author.id,
      authorName: getDisplayName(msg),
      ts: getMessageTs(msg),
      isChat: isDiscordChatLikeMessage(msg),
      replyToChannelId: replyRef?.channelId,
      replyToMessageId: replyRef?.messageId,
      deleted: input?.deleted,
      updatedTs: Date.now(),
    });
  }

  private reportDetachedPanic(panic: Panic): void {
    queueMicrotask(() => {
      this.opts.reportFatalPanic(panic);
    });
  }

  private superviseDiscordCallback(operation: string, callback: () => void | Promise<void>): void {
    const settlement = Promise.allSettled([Promise.resolve().then(callback)]);
    void settlement.then(([result]) => {
      if (!result || result.status === "fulfilled") return;
      if (Panic.is(result.reason)) {
        this.reportDetachedPanic(result.reason);
        return;
      }
      this.logger.error("Discord callback failed", { operation });
    });
  }

  private emit(evt: AdapterEvent) {
    for (const h of this.handlers) {
      Promise.resolve()
        .then(() => h(evt))
        .catch((cause) => {
          if (Panic.is(cause)) this.reportDetachedPanic(cause);
          // Ordinary event-handler failures remain best-effort.
        });
    }
  }

  private async emitAndWait(evt: AdapterEvent): Promise<void> {
    await Promise.all([...this.handlers].map(async (handler) => await handler(evt)));
  }

  private getParentChannelIdFromInteractionChannel(
    interaction: ChatInputCommandInteraction<CacheType> | AutocompleteInteraction<CacheType>,
  ): string | undefined {
    const channel = interaction.channel;
    if (!channel) return undefined;
    if (!("isThread" in channel) || typeof channel.isThread !== "function") return undefined;
    if (!channel.isThread()) return undefined;
    return channel.parentId ?? undefined;
  }

  private getEffectiveSessionModelOverride(input: {
    cfg?: CoreConfig;
    sessionId: string;
    parentChannelId?: string | null;
  }): string | undefined {
    const inMemoryOverride = this.getInMemorySessionModelOverride({
      sessionId: input.sessionId,
      parentChannelId: input.parentChannelId,
    });
    if (inMemoryOverride) return inMemoryOverride;

    const cfg = input.cfg;
    if (!cfg) return undefined;

    const threadModel = cfg.surface.router.sessionModes[input.sessionId]?.model;
    if (typeof threadModel === "string" && threadModel.trim().length > 0) {
      return threadModel.trim();
    }

    const parentId = input.parentChannelId?.trim();
    if (!parentId) return undefined;

    const parentModel = cfg.surface.router.sessionModes[parentId]?.model;
    if (typeof parentModel === "string" && parentModel.trim().length > 0) {
      return parentModel.trim();
    }

    return undefined;
  }

  private getInMemorySessionModelOverride(input: {
    sessionId: string;
    parentChannelId?: string | null;
  }): string | undefined {
    return resolveEffectiveSessionModelOverride({
      sessionId: input.sessionId,
      parentChannelId: input.parentChannelId,
      overrides: this.sessionModelOverrides,
    });
  }

  private getSessionModelRef(input: {
    cfg: CoreConfig;
    sessionId: string;
    parentChannelId?: string | null;
  }): string {
    return (
      this.getEffectiveSessionModelOverride({
        cfg: input.cfg,
        sessionId: input.sessionId,
        parentChannelId: input.parentChannelId,
      }) ?? input.cfg.models.main.model
    );
  }

  private async onInteractionCreate(interaction: Interaction<CacheType>) {
    if (interaction.isChatInputCommand()) {
      await this.onChatInputCommand(interaction);
      return;
    }

    if (interaction.isAutocomplete()) {
      await this.onAutocomplete(interaction);
      return;
    }

    if (interaction.isMessageContextMenuCommand()) {
      await this.onMessageContextMenuCommand(interaction);
      return;
    }

    if (!interaction.isButton()) return;

    const actionId = parseDiscordActionCustomId(interaction.customId);
    if (actionId) {
      const channelId = interaction.channelId;
      const messageId = interaction.message?.id;
      const userId = interaction.user?.id;
      if (!channelId || !messageId || !userId) {
        await tryReplyEphemeral(interaction, "Unable to authenticate this workflow action.");
        return;
      }
      const published = await Result.tryPromise({
        try: () =>
          this.emitAndWait({
            type: "adapter.action.invoked",
            platform: "discord",
            ts: Date.now(),
            actionId,
            userId,
            messageRef: { platform: "discord", channelId, messageId },
          }),
        catch: surfaceExternalFallback(externalCallFailure("surface-event-handler")),
      });
      if (published.status === "ok") {
        await tryReplyEphemeral(interaction, "Workflow action received.");
      } else {
        this.logger.error("workflow action durable publication failed", { actionId });
        await tryReplyEphemeral(
          interaction,
          "Workflow action could not be recorded. Please retry.",
        );
      }
      return;
    }

    const parsed = parseCancelCustomId(interaction.customId);
    if (!parsed) return;

    // Guard against mismatched sessions (e.g. copied components).
    if (interaction.channelId && parsed.sessionId !== interaction.channelId) {
      await tryReplyEphemeral(interaction, "This cancel button is not for this channel.");
      return;
    }

    this.emit({
      type: "adapter.request.cancel",
      platform: "discord",
      ts: Date.now(),
      requestId: parsed.requestId,
      sessionId: parsed.sessionId,
      cancelScope: "active_only",
      source: "button",
      userId: interaction.user?.id ?? undefined,
      messageId: interaction.message?.id ?? undefined,
    });

    // Acknowledge quickly; actual cancellation is handled asynchronously via the bus.
    await tryReplyEphemeral(interaction, "Cancel requested.");
  }

  private async onMessageContextMenuCommand(
    interaction: MessageContextMenuCommandInteraction<CacheType>,
  ): Promise<void> {
    if (interaction.commandName !== CONTEXT_MENU_CANCEL_REQUEST_NAME) return;

    const cfg = this.cfg;
    if (!cfg) {
      await tryReplyEphemeral(interaction, "Bot is not ready yet.");
      return;
    }

    const channelId = interaction.channelId;
    const guildId = interaction.guildId;
    if (!channelId) {
      await tryReplyEphemeral(interaction, "This command must be used in a channel.");
      return;
    }

    if (!shouldAllowMessage({ cfg, channelId, guildId })) {
      await tryReplyEphemeral(interaction, "Not allowed in this channel.");
      return;
    }

    const targetMessageId = interaction.targetMessage?.id;
    if (!targetMessageId) {
      await tryReplyEphemeral(interaction, "Could not resolve target message.");
      return;
    }

    this.emit({
      type: "adapter.request.cancel",
      platform: "discord",
      ts: Date.now(),
      requestId: formatDiscordMessageRequestId({ channelId, messageId: targetMessageId }),
      sessionId: channelId,
      cancelScope: "active_or_queued",
      source: "context_menu",
      userId: interaction.user?.id ?? undefined,
      messageId: targetMessageId,
    });

    await tryReplyEphemeral(interaction, "Cancel requested.");
  }

  private async registerSlashCommands(): Promise<void> {
    const client = this.client;
    if (!client) return;

    const app = client.application;
    if (!app) return;

    // Ensure the application is fetched (discord.js sometimes lazily loads it).
    await Result.tryPromise({
      try: () => app.fetch(),
      catch: surfaceExternalFallback(null),
    });

    const customOptions = (this.opts?.customCommands?.list() ?? []).map((cmd) => ({
      type: ApplicationCommandOptionType.Subcommand as const,
      name: cmd.def.name,
      description: cmd.def.description,
      options: [
        ...cmd.def.args.map((arg) => buildDiscordSlashOption(arg)),
        {
          type: ApplicationCommandOptionType.String as const,
          name: CUSTOM_COMMAND_PROMPT_ARG_KEY,
          description: "Extra prompt text for the assistant after the command runs",
          required: false,
        },
      ],
    }));

    if (customOptions.length > 24) {
      this.logger.warn("too many custom commands for /lilac; only first 24 will be registered", {
        discovered: customOptions.length,
      });
    }

    const slashDefinition = {
      name: "lilac",
      description: "Lilac bot commands",
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand as const,
          name: "divider",
          description: "Insert a session divider for context",
          options: [
            {
              type: ApplicationCommandOptionType.String as const,
              name: "label",
              description: "Optional label for the divider",
              required: false,
            },
          ],
        },
        ...customOptions.slice(0, 24),
      ],
    };

    const modelSlashDefinition = {
      name: "model",
      description: "View or switch this session model",
      options: [
        {
          type: ApplicationCommandOptionType.String as const,
          name: "model",
          description: "Model alias or provider/model",
          required: false,
          autocomplete: true,
        },
      ],
    };

    const cancelContextMenuDefinition = {
      name: CONTEXT_MENU_CANCEL_REQUEST_NAME,
      type: ApplicationCommandType.Message as const,
    };

    // Force-sync (bulk overwrite) so stale commands are removed.
    // This is intentional: we treat the current code's command list as the
    // source of truth for this application.
    const desired = [slashDefinition, modelSlashDefinition, cancelContextMenuDefinition];
    let syncFailed = false;
    const globalSync = await Result.tryPromise({
      try: () => app.commands.set(desired),
      catch: surfaceExternalFallback(externalCallFailure("application.commands.set")),
    });
    if (globalSync.status === "error") {
      syncFailed = true;
      this.logger.error("slash command sync failed", {
        ...formatTaggedErrorForLog(globalSync.error),
      });
    } else {
      this.logger.debug("slash command scope synced", {
        scope: "global",
        count: desired.length,
      });
    }

    // Global-only strategy: clear guild-scoped commands to avoid duplicate
    // entries in Discord command pickers.
    const fetchedGuilds = await Result.tryPromise({
      try: () => client.guilds.fetch(),
      catch: surfaceExternalFallback(externalCallFailure("client.guilds.fetch")),
    });
    if (fetchedGuilds.status === "error") {
      syncFailed = true;
      this.logger.error("guild slash command discovery failed", {
        ...formatTaggedErrorForLog(fetchedGuilds.error),
      });
    }
    const guilds = fetchedGuilds.status === "ok" ? fetchedGuilds.value : null;
    const guildIds = guilds ? [...guilds.keys()] : [];
    for (const guildId of guildIds) {
      const fetchedGuild = await Result.tryPromise({
        try: () => client.guilds.fetch(guildId),
        catch: surfaceExternalFallback(externalCallFailure("client.guilds.fetch")),
      });
      if (fetchedGuild.status === "error") {
        syncFailed = true;
        this.logger.error("guild slash command sync failed", {
          guildId,
          ...formatTaggedErrorForLog(fetchedGuild.error),
        });
        continue;
      }
      const guild = fetchedGuild.value;

      const guildSync = await Result.tryPromise({
        try: () => guild.commands.set([]),
        catch: surfaceExternalFallback(externalCallFailure("guild.commands.set")),
      });
      if (guildSync.status === "error") {
        syncFailed = true;
        this.logger.error("guild slash command sync failed", {
          guildId,
          ...formatTaggedErrorForLog(guildSync.error),
        });
      } else {
        this.logger.debug("slash command scope synced", {
          scope: "guild",
          guildId,
          count: 0,
        });
      }
    }
    if (!syncFailed) {
      this.logSlashCommandSyncSuccess(desired.length, guildIds.length);
    }
  }

  private logSlashCommandSyncSuccess(globalCount: number, guildCount: number): void {
    this.logger.info("slash commands synced", { globalCount, guildCount });
  }

  private async onChatInputCommand(
    interaction: ChatInputCommandInteraction<CacheType>,
  ): Promise<void> {
    await this.reloadCoreConfigIfNeeded();

    const cfg = this.cfg;
    const client = this.client;
    const self = this.self;

    if (!cfg || !client || !self) {
      // Not ready; best-effort ack.
      await tryReplyEphemeral(interaction, "Bot is not ready yet.");
      return;
    }

    if (interaction.commandName === "model") {
      await this.onModelCommand(interaction, cfg);
      return;
    }

    if (interaction.commandName !== "lilac") return;

    const channelId = interaction.channelId;
    const guildId = interaction.guildId;

    if (!channelId) {
      await tryReplyEphemeral(interaction, "This command must be used in a channel.");
      return;
    }

    if (!shouldAllowMessage({ cfg, channelId, guildId })) {
      await tryReplyEphemeral(interaction, "Not allowed in this channel.");
      return;
    }

    const subcommand = Result.try({
      try: () => interaction.options.getSubcommand(),
      catch: surfaceExternalFallback(null),
    });
    const sub = subcommand.status === "ok" ? subcommand.value : null;

    if (sub === "divider") {
      const label = interaction.options.getString("label");

      const content = buildDiscordSessionDividerText({
        label,
        createdByUserId: interaction.user?.id ?? null,
        createdByUserName: interaction.user?.username ?? null,
      });

      // Defer immediately to avoid the 3s interaction timeout.
      await Result.tryPromise({
        try: () => interaction.deferReply({ flags: MessageFlags.Ephemeral }),
        catch: surfaceExternalFallback(undefined),
      });

      const ch = await resolveTextSendableChannel(client, channelId);
      if (!ch) {
        await tryEditOrReplyEphemeral(interaction, "Channel not found or not text-based.");
        return;
      }

      const sent = await Result.tryPromise({
        try: async () => await ch.send({ content, allowedMentions: { parse: [] } }),
        catch: surfaceExternalFallback(externalCallFailure("channel.send-divider")),
      });
      if (sent.status === "error") {
        await tryEditOrReplyEphemeral(
          interaction,
          `Failed to insert divider: ${sent.error.message}`,
        );
        return;
      }

      await tryEditOrReplyEphemeral(interaction, "Inserted session divider.");
      return;
    }

    const custom = this.opts?.customCommands?.get(sub ?? "");
    if (!custom) {
      await tryReplyEphemeral(interaction, "Unknown subcommand.");
      return;
    }

    const customCommands = this.opts.customCommands;
    if (!customCommands) {
      await tryReplyEphemeral(interaction, "Unknown subcommand.");
      return;
    }
    const preparedArgs = Result.try({
      try: () => ({
        rawArgs: Object.fromEntries(
          custom.def.args.flatMap((arg) => {
            const value = readDiscordSlashOption(interaction, arg);
            return value === null ? [] : [[arg.key, value] as const];
          }),
        ),
        prompt: interaction.options.getString(CUSTOM_COMMAND_PROMPT_ARG_KEY),
      }),
      catch: surfaceExternalFallback(externalCallFailure("interaction.options")),
    });
    if (preparedArgs.status === "error") {
      await tryEditOrReplyEphemeral(
        interaction,
        `Failed to run custom command: ${preparedArgs.error.message}`,
      );
      return;
    }
    const parsedResult = customCommands.parseSlash({
      name: custom.def.name,
      rawArgs: preparedArgs.value.rawArgs,
      prompt: preparedArgs.value.prompt,
    });
    if (parsedResult.status === "error") {
      await tryEditOrReplyEphemeral(
        interaction,
        `Failed to run custom command: ${customCommandInvocationErrorText(parsedResult.error)}`,
      );
      return;
    }
    const parsed = parsedResult.value;
    const preview = customCommands.formatPreview(parsed);
    const parentChannelId = this.getParentChannelIdFromInteractionChannel(interaction);
    const sessionMode = getSessionMode(cfg, channelId, parentChannelId);
    const sessionConfigId = resolveSessionConfigId({
      cfg,
      sessionId: channelId,
      parentChannelId,
      guildId: guildId ?? undefined,
    });
    const modelOverride = this.getSessionModelRef({
      cfg,
      sessionId: channelId,
      parentChannelId,
    });

    const replied = await Result.tryPromise({
      try: () => interaction.reply({ content: preview, allowedMentions: { parse: [] } }),
      catch: surfaceExternalFallback(externalCallFailure("interaction.reply")),
    });
    if (replied.status === "error") {
      await tryEditOrReplyEphemeral(
        interaction,
        `Failed to run custom command: ${replied.error.message}`,
      );
      return;
    }

    this.emit({
      type: "adapter.command.invoked",
      platform: "discord",
      ts: Date.now(),
      requestId: formatDiscordSlashRequestId({
        channelId,
        interactionId: interaction.id,
      }),
      sessionId: channelId,
      commandName: custom.def.name,
      args: parsed.args,
      ...(parsed.prompt ? { prompt: parsed.prompt } : {}),
      text: parsed.text,
      userId: interaction.user?.id ?? undefined,
      userName:
        (interaction.member && "displayName" in interaction.member
          ? interaction.member.displayName
          : undefined) ??
        interaction.user?.globalName ??
        interaction.user?.username ??
        undefined,
      sessionMode,
      sessionConfigId,
      modelOverride,
    });
  }

  private async onAutocomplete(interaction: AutocompleteInteraction<CacheType>): Promise<void> {
    await this.reloadCoreConfigIfNeeded();

    const cfg = this.cfg;
    if (!cfg) {
      await Result.tryPromise({
        try: () => interaction.respond([]),
        catch: surfaceExternalFallback(undefined),
      });
      return;
    }

    if (interaction.commandName !== "model") return;

    const focused = interaction.options.getFocused(true);
    if (focused.name !== "model") return;

    const focusedValue =
      typeof focused.value === "string" || typeof focused.value === "number" ? focused.value : "";
    const query = `${focusedValue}`.trim().toLowerCase();
    const aliases = Object.keys(cfg.models.def ?? {}).sort((a, b) => a.localeCompare(b));
    if (aliases.length === 0) {
      await Result.tryPromise({
        try: () => interaction.respond([]),
        catch: surfaceExternalFallback(undefined),
      });
      return;
    }

    const sessionId = interaction.channelId;
    const parentChannelId = this.getParentChannelIdFromInteractionChannel(interaction);
    const current = sessionId
      ? this.getSessionModelRef({
          cfg,
          sessionId,
          parentChannelId,
        })
      : cfg.models.main.model;

    const choices: Array<{ name: string; value: string }> = [];
    if (aliases.includes(current) && current.toLowerCase().includes(query)) {
      choices.push({
        name: `${current} (current)`,
        value: current,
      });
    }

    for (const alias of aliases) {
      if (alias === current) continue;
      if (!alias.toLowerCase().includes(query)) continue;
      choices.push({ name: alias, value: alias });
      if (choices.length >= 25) break;
    }

    await Result.tryPromise({
      try: () => interaction.respond(choices.slice(0, 25)),
      catch: surfaceExternalFallback(undefined),
    });
  }

  private async onModelCommand(
    interaction: ChatInputCommandInteraction<CacheType>,
    cfg: CoreConfig,
  ): Promise<void> {
    const channelId = interaction.channelId;
    const guildId = interaction.guildId;

    if (!channelId) {
      await tryReplyEphemeral(interaction, "This command must be used in a channel.");
      return;
    }

    if (!shouldAllowMessage({ cfg, channelId, guildId })) {
      await tryReplyEphemeral(interaction, "Not allowed in this channel.");
      return;
    }

    const parentChannelId = this.getParentChannelIdFromInteractionChannel(interaction);
    const currentRef = this.getSessionModelRef({
      cfg,
      sessionId: channelId,
      parentChannelId,
    });

    const modelInput = interaction.options.getString("model");
    const trimmedModelInput = modelInput?.trim() ?? "";

    if (trimmedModelInput.length === 0) {
      let resolvedDisplay = currentRef;
      const resolved = resolveModelRefResult(
        cfg,
        { model: currentRef },
        "surface.discord.slash.model.current",
      );
      if (resolved.status === "ok") {
        resolvedDisplay = resolved.value.spec;
      } else {
        switch (resolved.error._tag) {
          case "ModelResolutionFailed":
            // Keep best-effort display when config changed and override is stale.
            break;
        }
      }

      await tryReplyEphemeral(
        interaction,
        `Current model for this session: \`${currentRef}\` (resolved: \`${resolvedDisplay}\`)`,
      );
      return;
    }

    const resolved = resolveModelRefResult(
      cfg,
      { model: trimmedModelInput },
      "surface.discord.slash.model.override",
    );
    if (resolved.status === "error") {
      switch (resolved.error._tag) {
        case "ModelResolutionFailed":
          await tryReplyEphemeral(interaction, `Invalid model: ${resolved.error.message}`);
          return;
      }
    }
    const resolvedSpec = resolved.value.spec;

    this.sessionModelOverrides.set(channelId, trimmedModelInput);

    await tryReplyEphemeral(
      interaction,
      `Session model set to \`${trimmedModelInput}\` (resolved: \`${resolvedSpec}\`)`,
    );
  }

  private async fetchDiscordMessage(input: {
    channelId: string;
    messageId: string;
  }): Promise<Message | null> {
    const cfg = this.cfg;
    const client = this.client;
    if (!cfg || !client) {
      throw new DiscordAdapterUnavailable({ message: "Discord adapter is not connected" });
    }

    let ch;
    try {
      ch = await client.channels.fetch(input.channelId);
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      if (discordNotFoundCode(cause) !== null) return null;
      throw cause;
    }
    if (!ch || !("messages" in ch) || !ch.messages?.fetch) return null;

    let msg;
    try {
      msg = await ch.messages.fetch({ message: input.messageId, cache: false, force: true });
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      if (discordNotFoundCode(cause) !== null) return null;
      throw cause;
    }

    if (
      !shouldAllowMessage({
        cfg,
        channelId: input.channelId,
        guildId: msg.guildId,
      })
    ) {
      return null;
    }

    return msg;
  }

  private async fetchLatestDiscordMessage(channelId: string): Promise<Message | null> {
    const list = await this.fetchDiscordMessages({ channelId, limit: 1 });
    return list[0] ?? null;
  }

  private async fetchDiscordMessages(input: {
    channelId: string;
    limit: number;
    beforeMessageId?: string;
    afterMessageId?: string;
    aroundMessageId?: string;
  }): Promise<Message[]> {
    const cfg = this.cfg;
    const client = this.client;
    if (!cfg || !client) {
      throw new DiscordAdapterUnavailable({ message: "Discord adapter is not connected" });
    }

    const ch = await client.channels.fetch(input.channelId);
    if (!ch || !("messages" in ch) || !ch.messages?.fetch) return [];

    // Allowlist is channel/guild scoped; for list operations the channel is authoritative.
    const guildId = "guildId" in ch ? ch.guildId : null;

    if (!shouldAllowMessage({ cfg, channelId: input.channelId, guildId })) {
      return [];
    }

    const limit = Math.min(200, Math.max(1, Math.floor(input.limit)));

    // `around` and `after` are not paged (Discord API caps at 100 anyway).
    if (input.aroundMessageId) {
      const res = await ch.messages.fetch({
        limit: Math.min(100, limit),
        around: input.aroundMessageId,
        cache: false,
      });
      return [...res.values()];
    }

    if (input.afterMessageId) {
      const res = await ch.messages.fetch({
        limit: Math.min(100, limit),
        after: input.afterMessageId,
        cache: false,
      });
      return [...res.values()];
    }

    // Default / before-cursor: page backwards using `before`.
    const out: Message[] = [];
    let before = input.beforeMessageId;

    while (out.length < limit) {
      const pageSize = Math.min(100, limit - out.length);
      const res = await ch.messages.fetch({
        limit: pageSize,
        before,
        cache: false,
      });

      const page = [...res.values()];
      if (page.length === 0) break;

      out.push(...page);

      // `res.values()` yields newest->oldest; the last entry is the oldest.
      before = page[page.length - 1]!.id;
    }

    return out;
  }

  private toSurfaceMessageFromDiscordMessageResult(
    msg: Message,
  ): ResultType<SurfaceMessage, DiscordAdapterUnavailable> {
    const cfg = this.cfg;
    const store = this.store;
    if (!cfg || !store) {
      return Result.err(new DiscordAdapterUnavailable({ message: "DiscordAdapter not connected" }));
    }

    const channelId = msg.channelId;
    const guildId = msg.guildId;

    const channelName = getChannelName(msg.channel);

    const parentChannelId =
      "isThread" in msg.channel && msg.channel.isThread() ? msg.channel.parentId : null;

    const sessionKind = resolveDiscordSessionKind(
      "isDMBased" in msg.channel &&
        typeof msg.channel.isDMBased === "function" &&
        msg.channel.isDMBased(),
      parentChannelId,
    );

    this.upsertMessageRelationFromDiscordMessage(msg);

    // Keep lightweight metadata caches warm (names/sessions), but do not cache message bodies.
    store.upsertSession({
      channelId,
      guildId: guildId ?? undefined,
      parentChannelId: parentChannelId ?? undefined,
      name: channelName,
      type: sessionKind,
      updatedTs: Date.now(),
      raw: {
        channel: { id: channelId, name: channelName, guildId, parentChannelId },
      },
    });

    if (channelName) {
      store.upsertChannelName({
        channelId,
        name: channelName,
        updatedTs: Date.now(),
      });
    }

    const authorName = getDisplayName(msg);

    store.upsertUserName({
      userId: msg.author.id,
      username: msg.author.username,
      globalName: msg.author.globalName ?? undefined,
      displayName: authorName,
      updatedTs: Date.now(),
    });

    const ts = getMessageTs(msg);
    const editedTs = getMessageEditedTs(msg);

    const attachments = collectDiscordAttachmentMeta(msg.attachments.values());
    const embeds = getMessageEmbeds(msg);
    const reference = normalizeDiscordReference(msg);
    const forwardSnapshot = getForwardSnapshotPayload(msg);
    const messageSnapshots = buildForwardMessageSnapshots(forwardSnapshot);
    const storedText = getStoredTextFromDiscordMessage({ msg, forwardSnapshot });
    const normalizedText = this.entityMapper?.normalizeIncomingText(storedText) ?? storedText;

    const sessionRef = asDiscordSessionRef({
      channelId,
      guildId,
      parentChannelId,
    });
    const sessionModelOverride = this.getInMemorySessionModelOverride({
      sessionId: channelId,
      parentChannelId,
    });

    return Result.ok({
      ref: asDiscordMsgRef(channelId, msg.id),
      session: sessionRef,
      userId: msg.author.id,
      userName: authorName,
      text: normalizedText,
      ts,
      editedTs,
      deleted: false,
      raw: {
        id: msg.id,
        channelId,
        guildId,
        authorId: msg.author.id,
        content: msg.content,
        embeds,
        reference: reference ?? undefined,
        messageSnapshots,
        editedTs,
        attachments,
        discord: {
          system: msg.system,
          type: msg.type,
          typeName: getDiscordMessageTypeName(msg),
          isChat: isDiscordChatLikeMessage(msg),
          referenceType: reference?.type,
          messageSnapshots,
          sessionModelOverride,
        },
      },
    });
  }

  private async onMessageCreate(msg: Message | PartialMessage) {
    if (msg.partial) {
      const fetched = await Result.tryPromise({
        try: () => msg.fetch(),
        catch: surfaceExternalFallback(null),
      });
      const full = fetched.status === "ok" ? fetched.value : null;
      if (!full) return;
      await this.onMessageCreate(full);
      return;
    }

    await this.reloadCoreConfigIfNeeded();

    const cfg = this.cfg;
    const store = this.store;
    const client = this.client;
    if (!cfg || !store || !client) return;

    // Only route real user chat messages to the request router.
    // We still want to record lightweight metadata (names/sessions) for context.
    const shouldEmitAdapterEvent = isRoutableDiscordUserMessage(msg);

    const guildId = msg.guildId;
    const channelId = msg.channelId;

    if (!shouldAllowMessage({ cfg, channelId, guildId })) {
      this.logger.debug("message ignored (not allowlisted)", {
        channelId,
        guildId,
        messageId: msg.id,
        userId: msg.author.id,
      });
      return;
    }

    this.upsertMessageRelationFromDiscordMessage(msg);

    this.logger.debug("message received", {
      channelId,
      guildId,
      messageId: msg.id,
      userId: msg.author.id,
      isBot: msg.author.bot,
      text:
        typeof msg.content === "string" && msg.content.trim().length > 0
          ? previewText(msg.content)
          : undefined,
    });

    const channelName = getChannelName(msg.channel);

    const parentChannelId =
      "isThread" in msg.channel && msg.channel.isThread() ? msg.channel.parentId : null;

    const sessionKind = resolveDiscordSessionKind(
      "isDMBased" in msg.channel &&
        typeof msg.channel.isDMBased === "function" &&
        msg.channel.isDMBased(),
      parentChannelId,
    );

    store.upsertSession({
      channelId,
      guildId: guildId ?? undefined,
      parentChannelId: parentChannelId ?? undefined,
      name: channelName,
      type: sessionKind,
      updatedTs: Date.now(),
      raw: {
        channel: { id: channelId, name: channelName, guildId, parentChannelId },
      },
    });

    if (channelName) {
      store.upsertChannelName({
        channelId,
        name: channelName,
        updatedTs: Date.now(),
      });
    }

    if (guildId) {
      for (const [roleId, role] of msg.mentions.roles) {
        store.upsertRoleName({
          guildId,
          roleId,
          name: role.name,
          updatedTs: Date.now(),
        });
      }
    }

    for (const [mentionedChannelId, ch] of msg.mentions.channels) {
      const name = "name" in ch ? ch.name : undefined;
      if (typeof name === "string") {
        store.upsertChannelName({
          channelId: mentionedChannelId,
          name,
          updatedTs: Date.now(),
        });
      }
    }

    const authorName = getDisplayName(msg);

    store.upsertUserName({
      userId: msg.author.id,
      username: msg.author.username,
      globalName: msg.author.globalName ?? undefined,
      displayName: authorName,
      updatedTs: Date.now(),
    });

    // Mentioned users
    for (const [id, u] of msg.mentions.users) {
      const member = msg.mentions.members?.get(id);
      const displayName =
        (member && "displayName" in member ? member.displayName : undefined) ??
        u.globalName ??
        u.username;
      store.upsertUserName({
        userId: id,
        username: u.username,
        globalName: u.globalName ?? undefined,
        displayName,
        updatedTs: Date.now(),
      });
    }

    const ts = getMessageTs(msg);
    const editedTs = getMessageEditedTs(msg);

    const attachments = collectDiscordAttachmentMeta(msg.attachments.values());
    const embeds = getMessageEmbeds(msg);
    const reference = normalizeDiscordReference(msg);
    const replyRef = getReplyReference(msg);
    const forwardSnapshot = getForwardSnapshotPayload(msg);
    const messageSnapshots = buildForwardMessageSnapshots(forwardSnapshot);
    const storedText = getStoredTextFromDiscordMessage({ msg, forwardSnapshot });
    const normalizedText = this.entityMapper?.normalizeIncomingText(storedText) ?? storedText;

    const sessionRef = asDiscordSessionRef({
      channelId,
      guildId,
      parentChannelId,
    });
    const sessionModelOverride = this.getInMemorySessionModelOverride({
      sessionId: channelId,
      parentChannelId,
    });

    // Trigger metadata for bus router is only needed when we emit an adapter event.
    if (!shouldEmitAdapterEvent) return;

    const botId = client.user?.id;
    if (!botId) return;

    const isMention = isExplicitDiscordUserMention({
      content: msg.content ?? "",
      userId: botId,
      hasParsedMention: msg.mentions.users.has(botId),
    });
    const isReplyToBot = await this.isReplyToBot(msg, botId);

    const surfaceMsg: SurfaceMessage = {
      ref: asDiscordMsgRef(channelId, msg.id),
      session: sessionRef,
      userId: msg.author.id,
      userName: authorName,
      text: normalizedText,
      ts,
      editedTs,
      raw: {
        content: msg.content,
        embeds,
        reference: reference ?? undefined,
        messageSnapshots,
        editedTs,
        attachments,
        discord: {
          id: msg.id,
          system: msg.system,
          type: msg.type,
          typeName: getDiscordMessageTypeName(msg),
          isChat: isDiscordChatLikeMessage(msg),
          isDMBased: sessionKind === "dm",
          botUserId: botId,
          mentionsBot: isMention,
          replyToBot: isReplyToBot,
          replyToMessageId: replyRef?.messageId,
          referenceType: reference?.type,
          guildId: guildId ?? undefined,
          parentChannelId: parentChannelId ?? undefined,
          sessionModelOverride,
          attachments,
          messageSnapshots,
        },
      },
    };

    this.emit({
      type: "adapter.message.created",
      platform: "discord",
      ts: Date.now(),
      message: surfaceMsg,
      channelName,
    });
  }

  private async isReplyToBot(msg: Message, botUserId: string): Promise<boolean> {
    const client = this.client;
    if (!client) return false;

    const replyRef = getReplyReference(msg);
    if (!replyRef) return false;

    const channel = msg.channel;
    if (!channel?.messages?.fetch) return false;
    const cached = channel.messages.cache.get(replyRef.messageId);
    if (cached) return cached.author?.id === botUserId;
    const fetched = await Result.tryPromise({
      try: () => channel.messages.fetch({ message: replyRef.messageId, cache: false, force: true }),
      catch: surfaceExternalFallback(null),
    });
    return fetched.status === "ok" && fetched.value?.author?.id === botUserId;
  }

  private async onMessageUpdate(msg: Message | PartialMessage) {
    if (msg.partial) {
      const fetched = await Result.tryPromise({
        try: () => msg.fetch(),
        catch: surfaceExternalFallback(null),
      });
      const full = fetched.status === "ok" ? fetched.value : null;
      if (!full) return;
      await this.onMessageUpdate(full);
      return;
    }
    const cfg = this.cfg;
    const store = this.store;
    if (!cfg || !store) return;

    const guildId = msg.guildId;
    const channelId = msg.channelId;
    if (!shouldAllowMessage({ cfg, channelId, guildId })) return;

    this.upsertMessageRelationFromDiscordMessage(msg);

    const channelName = getChannelName(msg.channel);

    const parentChannelId =
      "isThread" in msg.channel && msg.channel.isThread() ? msg.channel.parentId : null;

    const sessionKind = resolveDiscordSessionKind(
      "isDMBased" in msg.channel &&
        typeof msg.channel.isDMBased === "function" &&
        msg.channel.isDMBased(),
      parentChannelId,
    );

    store.upsertSession({
      channelId,
      guildId: guildId ?? undefined,
      parentChannelId: parentChannelId ?? undefined,
      name: channelName,
      type: sessionKind,
      updatedTs: Date.now(),
      raw: {
        channel: { id: channelId, name: channelName, guildId, parentChannelId },
      },
    });

    if (channelName) {
      store.upsertChannelName({
        channelId,
        name: channelName,
        updatedTs: Date.now(),
      });
    }

    const ts = getMessageTs(msg);
    const editedTs = getMessageEditedTs(msg);

    const attachments = collectDiscordAttachmentMeta(msg.attachments.values());
    const embeds = getMessageEmbeds(msg);
    const reference = normalizeDiscordReference(msg);
    const replyRef = getReplyReference(msg);
    const forwardSnapshot = getForwardSnapshotPayload(msg);
    const messageSnapshots = buildForwardMessageSnapshots(forwardSnapshot);
    const storedText = getStoredTextFromDiscordMessage({ msg, forwardSnapshot });
    const normalizedText = this.entityMapper?.normalizeIncomingText(storedText) ?? storedText;

    const sess = store.getSession(channelId);
    const sessionRef = asDiscordSessionRef({
      channelId,
      guildId,
      parentChannelId: sess?.parent_channel_id,
    });

    const authorName = getDisplayName(msg);

    store.upsertUserName({
      userId: msg.author.id,
      username: msg.author.username,
      globalName: msg.author.globalName ?? undefined,
      displayName: authorName,
      updatedTs: Date.now(),
    });

    const surfaceMsg: SurfaceMessage = {
      ref: asDiscordMsgRef(channelId, msg.id),
      session: sessionRef,
      userId: msg.author.id,
      userName: authorName,
      text: normalizedText,
      ts,
      editedTs,
      raw: {
        content: msg.content,
        embeds,
        reference: reference ?? undefined,
        messageSnapshots,
        editedTs,
        attachments,
        discord: {
          id: msg.id,
          system: msg.system,
          type: msg.type,
          typeName: getDiscordMessageTypeName(msg),
          isChat: isDiscordChatLikeMessage(msg),
          // Best-effort: Discord update event may not expose channel type reliably.
          isDMBased: sessionKind === "dm",
          mentionsBot: false,
          replyToBot: false,
          replyToMessageId: replyRef?.messageId,
          referenceType: reference?.type,
          guildId: guildId ?? undefined,
          parentChannelId: parentChannelId ?? undefined,
          attachments,
          messageSnapshots,
        },
      },
    };

    this.emit({
      type: "adapter.message.updated",
      platform: "discord",
      ts: Date.now(),
      message: surfaceMsg,
      channelName,
    });
  }

  private async onMessageDelete(msg: Message | null, messageId: string, channelId: string) {
    const cfg = this.cfg;
    const store = this.store;
    if (!cfg || !store) return;

    // We only persist immutable relation metadata + deletion state (no message body cache).
    let guildId: string | null = msg?.guildId ?? null;

    // If we didn't get a guild id from the event, best-effort resolve from channel.
    if (!guildId) {
      const client = this.client;
      const fetched = client
        ? await Result.tryPromise({
            try: () => client.channels.fetch(channelId),
            catch: surfaceExternalFallback(null),
          })
        : Result.ok(null);
      const ch = fetched.status === "ok" ? fetched.value : null;
      guildId = ch && "guildId" in ch ? ch.guildId : null;
    }

    // Allowlist check should still apply even when Discord sends partial delete events.
    if (!shouldAllowMessage({ cfg, channelId, guildId })) return;

    store.markMessageRelationDeleted({
      channelId,
      messageId,
      updatedTs: Date.now(),
    });

    const sess = store.getSession(channelId);
    const sessionRef = asDiscordSessionRef({
      channelId,
      guildId,
      parentChannelId: sess?.parent_channel_id,
    });

    this.emit({
      type: "adapter.message.deleted",
      platform: "discord",
      ts: Date.now(),
      messageRef: asDiscordMsgRef(channelId, messageId),
      session: sessionRef,
      channelName: sess?.name ?? undefined,
      raw: msg ? { discord: { id: msg.id } } : undefined,
    });
  }

  private async onReactionAdd(
    msg: Message | PartialMessage,
    reaction: string,
    userId?: string,
    userName?: string,
  ) {
    if (msg.partial) {
      const fetched = await Result.tryPromise({
        try: () => msg.fetch(),
        catch: surfaceExternalFallback(null),
      });
      const full = fetched.status === "ok" ? fetched.value : null;
      if (!full) return;
      await this.onReactionAdd(full, reaction, userId, userName);
      return;
    }
    const cfg = this.cfg;
    const store = this.store;
    if (!cfg || !store) return;

    const channelId = msg.channelId;
    const guildId = msg.guildId;
    if (!shouldAllowMessage({ cfg, channelId, guildId })) return;

    if (userId && userName) {
      store.upsertUserName({
        userId,
        username: userName,
        displayName: userName,
        updatedTs: Date.now(),
      });
    }

    const sess = store.getSession(channelId);
    const sessionRef = asDiscordSessionRef({
      channelId,
      guildId,
      parentChannelId: sess?.parent_channel_id,
    });

    this.emit({
      type: "adapter.reaction.added",
      platform: "discord",
      ts: Date.now(),
      messageRef: asDiscordMsgRef(channelId, msg.id),
      session: sessionRef,
      channelName: sess?.name ?? getChannelName(msg.channel),
      reaction,
      userId,
      userName,
      raw: { discord: { reaction } },
    });
  }

  private async onReactionRemove(
    msg: Message | PartialMessage,
    reaction: string,
    userId?: string,
    userName?: string,
  ) {
    if (msg.partial) {
      const fetched = await Result.tryPromise({
        try: () => msg.fetch(),
        catch: surfaceExternalFallback(null),
      });
      const full = fetched.status === "ok" ? fetched.value : null;
      if (!full) return;
      await this.onReactionRemove(full, reaction, userId, userName);
      return;
    }
    const cfg = this.cfg;
    const store = this.store;
    if (!cfg || !store) return;

    const channelId = msg.channelId;
    const guildId = msg.guildId;
    if (!shouldAllowMessage({ cfg, channelId, guildId })) return;

    if (userId && userName) {
      store.upsertUserName({
        userId,
        username: userName,
        displayName: userName,
        updatedTs: Date.now(),
      });
    }

    const sess = store.getSession(channelId);
    const sessionRef = asDiscordSessionRef({
      channelId,
      guildId,
      parentChannelId: sess?.parent_channel_id,
    });

    this.emit({
      type: "adapter.reaction.removed",
      platform: "discord",
      ts: Date.now(),
      messageRef: asDiscordMsgRef(channelId, msg.id),
      session: sessionRef,
      channelName: sess?.name ?? getChannelName(msg.channel),
      reaction,
      userId,
      userName,
      raw: { discord: { reaction } },
    });
  }
}
