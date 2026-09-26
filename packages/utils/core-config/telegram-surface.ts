import { z } from "zod";

import { parseFriendlyByteSize } from "../friendly-units";
import { cloneDefaultWorkingIndicators } from "../working-indicators";

/**
 * Fork-owned Telegram surface configuration: the universal config shape, its
 * defaults, and the v2 input schema. The upstream-owned `types.ts`, `v1.ts`,
 * and `v2.ts` only import from this module.
 *
 * Keep this module free of `../env`: `core-config/parse.ts` must stay importable
 * without a workspace root (see the portable-imports test). Runtime helpers
 * that need `env` live in `telegram-runtime.ts`.
 */

export type TelegramSurfaceConfig = {
  /** Telegram surface is opt-in; when false the adapter is never constructed. */
  enabled: boolean;
  /** Bot API token. Keep core-config.yaml private because this is a secret. */
  token?: string;
  /** Identity used for mention detection and prompt attribution. */
  botName: string;
  /** Resolved from getMe at connect time when omitted. */
  botUsername?: string;
  /** Empty means "deny all": the surface fails closed. */
  allowedChatIds: string[];
  /** Empty means "no user-level restriction" (chat allowlist still applies). */
  allowedUserIds: string[];
  dbPath?: string;
  /**
   * Bot API endpoint. Telegram supports self-hosted Bot API servers, which
   * raise the file-size limits; this also lets a verification run point at
   * a local endpoint. Defaults to https://api.telegram.org.
   */
  apiRoot?: string;
  /**
   * Telegram edits the streamed message in place, so on a successful run
   * both modes produce the same result. The mode only changes what happens
   * on cancellation: `preview` removes the streamed messages, `inline`
   * leaves the partial answer visible.
   */
  outputMode: "inline" | "preview";
  parseMode: "html" | "plain";
  /** Minimum gap between streaming editMessageText calls, per Bot API rate limits. */
  streamEditIntervalMs: number;
  outputNotification: boolean;
  workingIndicators: string[];
  /** Register the bot command menu via setMyCommands on connect. */
  commandMenu: boolean;
  markdownTableRender: {
    enabled: boolean;
    style: "unicode" | "ascii";
    maxWidth: number;
    fallbackMode: "list" | "passthrough";
  };
  /**
   * Inbound photo/document delivery to the model. Media is resolved from
   * Telegram at composition time via the stable `file_id` (never a URL, so
   * the bot token cannot leak into composed content or transcripts) and is
   * bounded by decoded-byte budgets before anything is published.
   */
  inboundMedia: {
    /** When false, media messages route on caption text only (media dropped). */
    enabled: boolean;
    /** Decoded-byte cap per attachment; larger media degrade to a metadata marker. */
    maxBytesPerAttachment: number;
    /** Decoded-byte budget across every attachment in one composed request. */
    maxBytesPerRequest: number;
  };
};

export const TELEGRAM_SURFACE_DEFAULTS = {
  enabled: false,
  botName: "lilac",
  outputMode: "preview",
  parseMode: "html",
  streamEditIntervalMs: 1500,
  outputNotification: true,
  commandMenu: true,
  markdownTableRender: {
    enabled: true,
    style: "unicode",
    maxWidth: 50,
    fallbackMode: "list",
  },
  inboundMedia: {
    enabled: true,
    maxBytesPerAttachment: 5 * 1024 * 1024,
    maxBytesPerRequest: 10 * 1024 * 1024,
  },
} as const;

/**
 * Shared by the v2 schema and by the v1 fallback so both config versions
 * produce an identical `surface.telegram` shape. The core-config drift test
 * asserts this equivalence.
 */
export function cloneDefaultTelegramSurface(): TelegramSurfaceConfig {
  return {
    ...TELEGRAM_SURFACE_DEFAULTS,
    allowedChatIds: [],
    allowedUserIds: [],
    workingIndicators: cloneDefaultWorkingIndicators(),
    markdownTableRender: { ...TELEGRAM_SURFACE_DEFAULTS.markdownTableRender },
    inboundMedia: { ...TELEGRAM_SURFACE_DEFAULTS.inboundMedia },
  };
}

const byteSizeSchema = z.preprocess(parseFriendlyByteSize, z.number().int().positive());

const telegramMarkdownTableRenderSchema = z
  .object({
    enabled: z.boolean().default(true),
    style: z.enum(["unicode", "ascii"]).default("unicode"),
    maxWidth: z.number().int().min(40).max(240).default(50),
    fallbackMode: z.enum(["list", "passthrough"]).default("list"),
  })
  .default({
    enabled: true,
    style: "unicode",
    maxWidth: 50,
    fallbackMode: "list",
  });

/** v2 input schema for `surface.telegram`. The v1 input shape is frozen and has no Telegram key. */
export const telegramSurfaceSchema = z
  .object({
    enabled: z.boolean().default(TELEGRAM_SURFACE_DEFAULTS.enabled),
    token: z.string().trim().min(1).optional(),
    tokenEnv: z
      .never({
        error:
          "surface.telegram.tokenEnv was removed; copy the token to surface.telegram.token and remove tokenEnv",
      })
      .optional(),
    botName: z
      .string()
      .min(1)
      .refine((s) => !/\s/u.test(s), "botName must not contain spaces")
      .default(TELEGRAM_SURFACE_DEFAULTS.botName),
    botUsername: z
      .string()
      .min(1)
      .refine((s) => !s.startsWith("@"), "botUsername must not include a leading '@'")
      .optional(),
    // Lazy defaults: a literal default is evaluated once at schema construction
    // and would then be shared (and mutable) across every parsed config.
    allowedChatIds: z.array(z.string().min(1)).default(() => []),
    allowedUserIds: z.array(z.string().min(1)).default(() => []),
    dbPath: z.string().min(1).optional(),
    apiRoot: z.url().optional(),
    outputMode: z.enum(["inline", "preview"]).default(TELEGRAM_SURFACE_DEFAULTS.outputMode),
    parseMode: z.enum(["html", "plain"]).default(TELEGRAM_SURFACE_DEFAULTS.parseMode),
    // Telegram throttles edits at roughly one per second per chat; going below
    // this reliably trips 429 retry_after responses during streaming.
    streamEditIntervalMs: z
      .number()
      .int()
      .min(500)
      .max(60_000)
      .default(TELEGRAM_SURFACE_DEFAULTS.streamEditIntervalMs),
    outputNotification: z.boolean().default(TELEGRAM_SURFACE_DEFAULTS.outputNotification),
    workingIndicators: z
      .array(z.string().trim().min(1))
      .min(1)
      .default(() => cloneDefaultWorkingIndicators()),
    commandMenu: z.boolean().default(TELEGRAM_SURFACE_DEFAULTS.commandMenu),
    markdownTableRender: telegramMarkdownTableRenderSchema,
    inboundMedia: z
      .object({
        enabled: z.boolean().default(TELEGRAM_SURFACE_DEFAULTS.inboundMedia.enabled),
        maxBytesPerAttachment: byteSizeSchema.default(
          TELEGRAM_SURFACE_DEFAULTS.inboundMedia.maxBytesPerAttachment,
        ),
        maxBytesPerRequest: byteSizeSchema.default(
          TELEGRAM_SURFACE_DEFAULTS.inboundMedia.maxBytesPerRequest,
        ),
      })
      .default(() => ({ ...TELEGRAM_SURFACE_DEFAULTS.inboundMedia })),
  })
  .default(() => cloneDefaultTelegramSurface());
