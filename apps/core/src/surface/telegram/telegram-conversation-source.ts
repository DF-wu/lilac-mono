import type { Database } from "bun:sqlite";
import { Result } from "better-result";
import { z } from "zod";
import { CorruptPersistedFields, type PersistedDataError } from "@stanley2058/lilac-utils";

/**
 * Telegram as a conversation-memory source.
 *
 * Mirrors `surface/native/conversation-source.ts`: the Telegram history index
 * (`telegram-surface.db`) is attached to the conversation thread store and
 * projected through temp views with the same column contract the native
 * source uses, so the thread store can index, summarize, and search Telegram
 * chats without knowing the Telegram schema.
 *
 * Every Telegram session (a DM, a group chat, or one forum topic) is one
 * thread. The Bot API offers no run-in-progress signal, so `active` is always
 * 0 and summarization relies on the quiet period alone. Attachments are
 * projected as metadata only (a `file_id` plus declared name, type, and
 * size); resolving bytes needs the bot token and stays in the adapter.
 */

export type TelegramConversationSourceOptions = {
  readonly databasePath?: string;
  /**
   * Name reported as `user_name` for rows the bot wrote itself. The thread
   * store recognizes the main agent by user name (`mainAgentUserNames`), and
   * the adapter records its own messages under the Telegram username rather
   * than the configured `surface.telegram.botName`, so the view normalizes it.
   */
  readonly botName?: string;
};

function sqlString(input: string): string {
  return `'${input.replaceAll("'", "''")}'`;
}

export function installTelegramConversationSource(
  db: Database,
  options: TelegramConversationSourceOptions = {},
): void {
  if (options.databasePath)
    db.run("ATTACH DATABASE ? AS telegram_conversation", [options.databasePath]);
  db.run("DROP VIEW IF EXISTS temp.telegram_conversation_threads");
  db.run("DROP VIEW IF EXISTS temp.telegram_conversation_messages");
  if (!options.databasePath) {
    db.run(`CREATE TEMP VIEW telegram_conversation_threads AS SELECT
      '' AS id, '' AS chat_id, '' AS revision, 0 AS updated_at, 0 AS active WHERE 0`);
    db.run(`CREATE TEMP VIEW telegram_conversation_messages AS SELECT
      '' AS channel_id, '' AS message_id, '' AS user_id, '' AS user_name,
      '' AS text, 0 AS ts, 0 AS deleted, 0 AS ordinal WHERE 0`);
    return;
  }
  const botName = options.botName?.trim();
  const userName = botName
    ? `CASE WHEN m.from_bot=1 THEN ${sqlString(botName)} ELSE m.user_name END`
    : "m.user_name";
  // The revision changes whenever a message is added, edited, or deleted, so
  // a stale summary is rebuilt from the current text rather than patched.
  db.run(`CREATE TEMP VIEW telegram_conversation_threads AS SELECT
    s.session_id AS id, s.chat_id,
    COALESCE((SELECT COUNT(1) || ':' || MAX(m.ts) || ':' || MAX(COALESCE(m.edited_ts,0)) || ':' || SUM(m.deleted)
      FROM telegram_conversation.telegram_messages m WHERE m.session_id=s.session_id), '0') AS revision,
    COALESCE((SELECT MAX(m.ts) FROM telegram_conversation.telegram_messages m
      WHERE m.session_id=s.session_id), s.updated_ts) AS updated_at,
    0 AS active
    FROM telegram_conversation.telegram_sessions s`);
  db.run(`CREATE TEMP VIEW telegram_conversation_messages AS SELECT
    m.session_id AS channel_id, m.message_id, m.user_id, ${userName} AS user_name,
    m.text, m.ts, m.deleted,
    row_number() OVER (PARTITION BY m.session_id ORDER BY m.ts, CAST(m.message_id AS INTEGER))-1 AS ordinal
    FROM telegram_conversation.telegram_messages m`);
}

const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const telegramThreadProjectionSchema = z.array(
  z.object({
    id: z.string().min(1),
    chat_id: z.string().min(1),
    revision: z.string(),
    updated_at: timestamp,
  }),
);
const telegramMessageProjectionSchema = z.array(
  z.object({
    channel_id: z.string().min(1),
    message_id: z.string().min(1),
    user_id: z.string().min(1),
    user_name: z.string().nullable(),
    text: z.string(),
    ts: timestamp,
    deleted: z.number().int().min(0).max(1),
    ordinal: z.number().int().nonnegative(),
  }),
);
const telegramAttachmentProjectionSchema = z.array(
  z.object({
    id: z.string().min(1),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number().int().nonnegative(),
  }),
);
export type TelegramConversationAttachment = z.infer<
  typeof telegramAttachmentProjectionSchema
>[number];

function projectionFailure() {
  return new CorruptPersistedFields({
    table: "telegram_messages",
    field: "raw_json",
    recordId: "conversation-memory",
    version: 1,
    issueCode: "invalid-row-field",
    message: "Telegram conversation projection is invalid",
  });
}
export function decodeTelegramThreadProjection(rows: unknown) {
  const parsed = telegramThreadProjectionSchema.safeParse(rows);
  return parsed.success ? Result.ok(parsed.data) : Result.err(projectionFailure());
}
export function decodeTelegramMessageProjection(rows: unknown) {
  const parsed = telegramMessageProjectionSchema.safeParse(rows);
  return parsed.success ? Result.ok(parsed.data) : Result.err(projectionFailure());
}
export function decodeTelegramAttachmentProjection(rows: unknown) {
  const parsed = telegramAttachmentProjectionSchema.safeParse(rows);
  return parsed.success ? Result.ok(parsed.data) : Result.err(projectionFailure());
}
export function readTelegramConversationThreads(db: Database) {
  return decodeTelegramThreadProjection(
    db.query("SELECT id,chat_id,revision,updated_at FROM telegram_conversation_threads").all(),
  );
}
export function readTelegramConversationMessages(db: Database, sessionId: string) {
  return decodeTelegramMessageProjection(
    db
      .query(
        "SELECT * FROM telegram_conversation_messages WHERE channel_id=? AND deleted=0 ORDER BY ordinal",
      )
      .all(sessionId),
  );
}

/**
 * Attachment metadata from the stored Bot API message. A photo is a size
 * ladder, so the largest rendition stands for it; every other media kind is a
 * single object. The `file_id` is the stable handle the adapter's attachment
 * resolver understands.
 */
export function readTelegramConversationAttachments(
  db: Database,
  sessionId: string,
  messageId: string,
): Result<TelegramConversationAttachment[], PersistedDataError> {
  return decodeTelegramAttachmentProjection(
    db
      .query(`SELECT
    json_extract(a.value,'$.file_id') AS id,
    COALESCE(json_extract(a.value,'$.file_name'), a.kind) AS filename,
    COALESCE(json_extract(a.value,'$.mime_type'), CASE a.kind WHEN 'photo' THEN 'image/jpeg' ELSE 'application/octet-stream' END) AS mimeType,
    COALESCE(json_extract(a.value,'$.file_size'), 0) AS size
    FROM (
      SELECT 'photo' AS kind, p.value AS value, 0 AS ord
        FROM telegram_conversation.telegram_messages m, json_each(m.raw_json,'$.telegram.message.photo') p
        WHERE m.session_id=?1 AND m.message_id=?2
        ORDER BY COALESCE(json_extract(p.value,'$.file_size'),0) DESC, CAST(p.key AS INTEGER) DESC LIMIT 1
    ) a
    UNION ALL
    SELECT
    json_extract(m.raw_json, k.path || '.file_id') AS id,
    COALESCE(json_extract(m.raw_json, k.path || '.file_name'), k.kind) AS filename,
    COALESCE(json_extract(m.raw_json, k.path || '.mime_type'), 'application/octet-stream') AS mimeType,
    COALESCE(json_extract(m.raw_json, k.path || '.file_size'), 0) AS size
    FROM telegram_conversation.telegram_messages m
    JOIN (SELECT 'document' AS kind, '$.telegram.message.document' AS path
      UNION ALL SELECT 'video', '$.telegram.message.video'
      UNION ALL SELECT 'audio', '$.telegram.message.audio'
      UNION ALL SELECT 'voice', '$.telegram.message.voice'
      UNION ALL SELECT 'animation', '$.telegram.message.animation') k
    WHERE m.session_id=?1 AND m.message_id=?2 AND json_extract(m.raw_json, k.path || '.file_id') IS NOT NULL`)
      .all(sessionId, messageId),
  );
}
