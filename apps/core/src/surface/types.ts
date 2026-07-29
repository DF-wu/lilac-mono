import type { AdapterPlatform } from "@stanley2058/lilac-event-bus";

export type SurfacePlatform = Exclude<AdapterPlatform, "unknown"> | "unknown";

/**
 * Surfaces whose inbound messages flow through the shared request router and
 * its message-composition pipeline.
 *
 * GitHub is deliberately absent: its webhook handlers publish
 * `cmd.request.message` directly and never emit adapter message events.
 */
export type RoutedSurfacePlatform = "discord" | "telegram";

/**
 * Surfaces that can act as an authenticated principal for Level-2 tool
 * authority. A request from one of these carries a real, attributable actor.
 */
export type SurfacePrincipalPlatform = "discord" | "github" | "telegram";

export function isSurfacePrincipalPlatform(x: unknown): x is SurfacePrincipalPlatform {
  return x === "discord" || x === "github" || x === "telegram";
}

export type DiscordSessionRef = {
  platform: "discord";
  channelId: string;
  guildId?: string;
  parentChannelId?: string;
};

/**
 * GitHub session:
 * - channelId: "OWNER/REPO#<number>" (issue or PR)
 */
export type GithubSessionRef = {
  platform: "github";
  channelId: string;
};

/**
 * Telegram session:
 * - channelId: "<chat_id>" for private chats, groups and channels,
 *   "<chat_id>:<message_thread_id>" for forum topics.
 *
 * Use the helpers in `telegram/telegram-ids.ts` to build and parse this id
 * rather than doing string surgery at call sites.
 */
export type TelegramSessionRef = {
  platform: "telegram";
  channelId: string;
};

export type DiscordMsgRef = {
  platform: "discord";
  channelId: string;
  messageId: string;
};

/**
 * GitHub message reference:
 * - messageId: either issue/pr number (for PR description trigger) or an issue_comment id.
 */
export type GithubMsgRef = {
  platform: "github";
  channelId: string;
  messageId: string;
};

/**
 * Telegram message reference:
 * - channelId: the session id (see `TelegramSessionRef`).
 * - messageId: Telegram `message_id`, stringified.
 */
export type TelegramMsgRef = {
  platform: "telegram";
  channelId: string;
  messageId: string;
};

export type SessionRef = DiscordSessionRef | GithubSessionRef | TelegramSessionRef;
export type MsgRef = DiscordMsgRef | GithubMsgRef | TelegramMsgRef;

export type SurfaceSelf = {
  platform: SurfacePlatform;
  userId: string;
  userName: string;
};

export type SurfaceSession = {
  ref: SessionRef;
  title?: string;
  kind: "channel" | "thread" | "dm";
};

export type SurfaceMessage = {
  ref: MsgRef;
  session: SessionRef;
  userId: string;
  userName?: string;
  text: string;
  ts: number;
  editedTs?: number;
  deleted?: boolean;
  raw?: unknown;
};

export type SurfaceReactionUser = {
  userId: string;
  userName?: string;
};

export type SurfaceReactionDetail = {
  emoji: string;
  count: number;
  users: SurfaceReactionUser[];
};

export type SurfaceSessionParticipantActivity = {
  type: string;
  name?: string;
  state?: string;
  details?: string;
  url?: string;
  emoji?: string;
};

export type SurfaceSessionParticipant = {
  userId: string;
  userName?: string;
  displayName?: string;
  status?: string;
  activities?: SurfaceSessionParticipantActivity[];
};

export type SurfaceSessionParticipantsResult = {
  source: "thread_members" | "guild_members";
  participants: SurfaceSessionParticipant[];
};

export type SurfaceReactionSummary = {
  emoji: string;
  count: number;
};

export type LimitOpts = {
  limit?: number;
  /** Optional one-based page for adapters backed by page-number APIs. */
  page?: number;
  /**
   * Optional paging cursor.
   *
   * For Discord this is a message id; behavior is adapter-specific.
   */
  beforeMessageId?: string;
  /**
   * Optional paging cursor.
   *
   * For Discord this is a message id; behavior is adapter-specific.
   */
  afterMessageId?: string;
};

export type SurfaceAttachment = {
  kind: "image" | "file";
  mimeType: string;
  filename: string;
  bytes: Uint8Array;
};

export type SurfaceAction = {
  actionId: string;
  label: string;
  style: "primary" | "success" | "danger" | "secondary";
};

export type ContentOpts = {
  text?: string;
  format?: "markdown" | "plain";
  attachments?: SurfaceAttachment[];
  actions?: SurfaceAction[];
};

export type SendOpts = {
  replyTo?: MsgRef;
  /** Suppress surface notifications for this send (mentions + reply ping). */
  silent?: boolean;
};

export type AdapterCapabilities = {
  platform: SurfacePlatform;
  send: boolean;
  edit: boolean;
  delete: boolean;
  reactions: boolean;
  readHistory: boolean;
  threads: boolean;
  markRead: boolean;
};
