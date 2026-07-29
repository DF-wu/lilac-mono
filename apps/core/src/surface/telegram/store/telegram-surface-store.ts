import { Database } from "bun:sqlite";

import { configureSqliteConnection } from "../../../shared/sqlite";

/**
 * Local message index for the Telegram surface.
 *
 * Unlike Discord, the Bot API has no "fetch channel history" endpoint: a bot
 * can only ever see updates delivered to it. Reply context, `listMsg` and
 * unread tracking therefore have to be served from messages we recorded as
 * they arrived, which is what this store is for.
 */
export type DbTelegramMessage = {
  session_id: string;
  message_id: string;
  chat_id: string;
  thread_id: string | null;
  user_id: string;
  user_name: string | null;
  text: string;
  ts: number;
  edited_ts: number | null;
  reply_to_message_id: string | null;
  from_bot: number;
  deleted: number;
  raw_json: string | null;
};

export type DbTelegramSession = {
  session_id: string;
  chat_id: string;
  thread_id: string | null;
  title: string | null;
  kind: "channel" | "thread" | "dm";
  updated_ts: number;
};

export type DbTelegramIngressOutbox = {
  dedupe_key: string;
  payload_json: string;
  enqueued_ts: number;
  attempts: number;
  last_attempt_ts: number | null;
  last_error: string | null;
};

/** One inbound event still waiting to reach the bus. */
export type TelegramIngressEntry = {
  dedupeKey: string;
  payload: unknown;
  enqueuedTs: number;
  attempts: number;
  lastError?: string;
};

export type TelegramMessageRecord = {
  sessionId: string;
  messageId: string;
  chatId: string;
  threadId?: string;
  userId: string;
  userName?: string;
  text: string;
  ts: number;
  editedTs?: number;
  replyToMessageId?: string;
  fromBot: boolean;
  raw?: unknown;
};

function parseRawJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    // A corrupt row must not break history reads.
    return undefined;
  }
}

function toRecord(row: DbTelegramMessage): TelegramMessageRecord {
  const raw = parseRawJson(row.raw_json);

  return {
    ...(raw === undefined ? {} : { raw }),
    sessionId: row.session_id,
    messageId: row.message_id,
    chatId: row.chat_id,
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    userId: row.user_id,
    ...(row.user_name === null ? {} : { userName: row.user_name }),
    text: row.text,
    ts: row.ts,
    ...(row.edited_ts === null ? {} : { editedTs: row.edited_ts }),
    ...(row.reply_to_message_id === null ? {} : { replyToMessageId: row.reply_to_message_id }),
    fromBot: row.from_bot === 1,
  };
}

export class TelegramSurfaceStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    configureSqliteConnection(this.db);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS telegram_messages (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        thread_id TEXT,
        user_id TEXT NOT NULL,
        user_name TEXT,
        text TEXT NOT NULL DEFAULT '',
        ts INTEGER NOT NULL,
        edited_ts INTEGER,
        reply_to_message_id TEXT,
        from_bot INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        raw_json TEXT,
        PRIMARY KEY (session_id, message_id)
      );
    `);

    // Recent-first listing per session is the dominant read pattern.
    this.db.run(`
      CREATE INDEX IF NOT EXISTS telegram_messages_session_ts
        ON telegram_messages (session_id, ts DESC);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS telegram_sessions (
        session_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        thread_id TEXT,
        title TEXT,
        kind TEXT NOT NULL,
        updated_ts INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS telegram_read_state (
        session_id TEXT PRIMARY KEY,
        last_read_message_id TEXT NOT NULL,
        last_read_ts INTEGER NOT NULL
      );
    `);

    // Durable ingress queue.
    //
    // grammY advances its poll offset *before* running the update handler
    // (`lastTriedUpdateId = update.update_id` precedes `handleUpdate`), so a
    // failed publish can never be recovered by rethrowing or retrying inside
    // the handler — Telegram will not send that update again. The only way to
    // survive a bus outage or a crash mid-publish is to commit the event here
    // first and replay from this table afterwards.
    //
    // `dedupe_key` gives replay its exactly-once property: a redelivered or
    // re-enqueued event collides on the primary key instead of producing a
    // second bus message.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS telegram_ingress_outbox (
        dedupe_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        enqueued_ts INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_ts INTEGER,
        last_error TEXT
      );
    `);

    // Replay is oldest-first so ordering survives an outage.
    this.db.run(`
      CREATE INDEX IF NOT EXISTS telegram_ingress_outbox_enqueued
        ON telegram_ingress_outbox (enqueued_ts ASC);
    `);
  }

  /**
   * Records an inbound event that still has to reach the bus.
   *
   * Returns false when the key is already queued, so a redelivery cannot
   * enqueue the same event twice.
   */
  enqueueIngress(input: { dedupeKey: string; payload: unknown; ts: number }): boolean {
    const result = this.db
      .query(
        `INSERT INTO telegram_ingress_outbox (dedupe_key, payload_json, enqueued_ts)
         VALUES ($dedupe_key, $payload_json, $enqueued_ts)
         ON CONFLICT(dedupe_key) DO NOTHING`,
      )
      .run({
        $dedupe_key: input.dedupeKey,
        $payload_json: JSON.stringify(input.payload),
        $enqueued_ts: input.ts,
      });

    return result.changes > 0;
  }

  /** Oldest-first, so a backlog is replayed in arrival order. */
  listPendingIngress(input: { limit?: number } = {}): TelegramIngressEntry[] {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);

    return this.db
      .query<DbTelegramIngressOutbox, { $limit: number }>(
        `SELECT * FROM telegram_ingress_outbox
          ORDER BY enqueued_ts ASC, rowid ASC
          LIMIT $limit`,
      )
      .all({ $limit: limit })
      .map((row) => ({
        dedupeKey: row.dedupe_key,
        payload: JSON.parse(row.payload_json) as unknown,
        enqueuedTs: row.enqueued_ts,
        attempts: row.attempts,
        ...(row.last_error === null ? {} : { lastError: row.last_error }),
      }));
  }

  /** Called only after the bus has accepted the event. */
  deleteIngress(dedupeKey: string): void {
    this.db
      .query(`DELETE FROM telegram_ingress_outbox WHERE dedupe_key = $dedupe_key`)
      .run({ $dedupe_key: dedupeKey });
  }

  /**
   * Records a failed publish attempt without dropping the entry, so an
   * operator can see how long something has been stuck and why.
   */
  recordIngressFailure(input: { dedupeKey: string; error: string; ts: number }): void {
    this.db
      .query(
        `UPDATE telegram_ingress_outbox
            SET attempts = attempts + 1,
                last_attempt_ts = $ts,
                last_error = $error
          WHERE dedupe_key = $dedupe_key`,
      )
      .run({ $dedupe_key: input.dedupeKey, $error: input.error, $ts: input.ts });
  }

  countPendingIngress(): number {
    const row = this.db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM telegram_ingress_outbox`)
      .get();
    return row?.n ?? 0;
  }

  upsertMessage(record: TelegramMessageRecord): void {
    this.db
      .query(
        `INSERT INTO telegram_messages (
           session_id, message_id, chat_id, thread_id, user_id, user_name,
           text, ts, edited_ts, reply_to_message_id, from_bot, deleted, raw_json
         ) VALUES (
           $session_id, $message_id, $chat_id, $thread_id, $user_id, $user_name,
           $text, $ts, $edited_ts, $reply_to_message_id, $from_bot, 0, $raw_json
         )
         ON CONFLICT (session_id, message_id) DO UPDATE SET
           text = excluded.text,
           user_name = excluded.user_name,
           edited_ts = excluded.edited_ts,
           reply_to_message_id = excluded.reply_to_message_id,
           raw_json = excluded.raw_json`,
      )
      .run({
        $session_id: record.sessionId,
        $message_id: record.messageId,
        $chat_id: record.chatId,
        $thread_id: record.threadId ?? null,
        $user_id: record.userId,
        $user_name: record.userName ?? null,
        $text: record.text,
        $ts: record.ts,
        $edited_ts: record.editedTs ?? null,
        $reply_to_message_id: record.replyToMessageId ?? null,
        $from_bot: record.fromBot ? 1 : 0,
        $raw_json: record.raw === undefined ? null : JSON.stringify(record.raw),
      });
  }

  getMessage(input: { sessionId: string; messageId: string }): TelegramMessageRecord | null {
    const row = this.db
      .query<DbTelegramMessage, { $session_id: string; $message_id: string }>(
        `SELECT * FROM telegram_messages
          WHERE session_id = $session_id AND message_id = $message_id AND deleted = 0`,
      )
      .get({ $session_id: input.sessionId, $message_id: input.messageId });

    return row ? toRecord(row) : null;
  }

  /** Newest-first, matching how surfaces page backwards through history. */
  listMessages(input: {
    sessionId: string;
    limit?: number;
    beforeMessageId?: string;
    afterMessageId?: string;
  }): TelegramMessageRecord[] {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

    const clauses = ["session_id = $session_id", "deleted = 0"];
    const params: Record<string, string | number> = {
      $session_id: input.sessionId,
      $limit: limit,
    };

    // Telegram message ids increase monotonically within a chat, so numeric
    // comparison is a valid ordering cursor.
    if (input.beforeMessageId !== undefined) {
      clauses.push("CAST(message_id AS INTEGER) < CAST($before AS INTEGER)");
      params.$before = input.beforeMessageId;
    }
    if (input.afterMessageId !== undefined) {
      clauses.push("CAST(message_id AS INTEGER) > CAST($after AS INTEGER)");
      params.$after = input.afterMessageId;
    }

    const rows = this.db
      .query<DbTelegramMessage, typeof params>(
        `SELECT * FROM telegram_messages
          WHERE ${clauses.join(" AND ")}
          ORDER BY ts DESC, CAST(message_id AS INTEGER) DESC
          LIMIT $limit`,
      )
      .all(params);

    return rows.map(toRecord);
  }

  markDeleted(input: { sessionId: string; messageId: string }): void {
    this.db
      .query(
        `UPDATE telegram_messages SET deleted = 1
          WHERE session_id = $session_id AND message_id = $message_id`,
      )
      .run({ $session_id: input.sessionId, $message_id: input.messageId });
  }

  upsertSession(session: {
    sessionId: string;
    chatId: string;
    threadId?: string;
    title?: string;
    kind: DbTelegramSession["kind"];
    updatedTs: number;
  }): void {
    this.db
      .query(
        `INSERT INTO telegram_sessions (session_id, chat_id, thread_id, title, kind, updated_ts)
         VALUES ($session_id, $chat_id, $thread_id, $title, $kind, $updated_ts)
         ON CONFLICT (session_id) DO UPDATE SET
           title = excluded.title,
           kind = excluded.kind,
           updated_ts = excluded.updated_ts`,
      )
      .run({
        $session_id: session.sessionId,
        $chat_id: session.chatId,
        $thread_id: session.threadId ?? null,
        $title: session.title ?? null,
        $kind: session.kind,
        $updated_ts: session.updatedTs,
      });
  }

  listSessions(): DbTelegramSession[] {
    return this.db
      .query<DbTelegramSession, []>(
        `SELECT * FROM telegram_sessions ORDER BY updated_ts DESC LIMIT 200`,
      )
      .all();
  }

  markRead(input: { sessionId: string; messageId: string; ts: number }): void {
    this.db
      .query(
        `INSERT INTO telegram_read_state (session_id, last_read_message_id, last_read_ts)
         VALUES ($session_id, $message_id, $ts)
         ON CONFLICT (session_id) DO UPDATE SET
           last_read_message_id = excluded.last_read_message_id,
           last_read_ts = excluded.last_read_ts`,
      )
      .run({ $session_id: input.sessionId, $message_id: input.messageId, $ts: input.ts });
  }

  /** Oldest-first: unread is read as a catch-up transcript, not a history page. */
  listUnread(input: { sessionId: string; limit?: number }): TelegramMessageRecord[] {
    const state = this.db
      .query<{ last_read_ts: number; last_read_message_id: string }, { $session_id: string }>(
        `SELECT last_read_ts, last_read_message_id FROM telegram_read_state
          WHERE session_id = $session_id`,
      )
      .get({ $session_id: input.sessionId });

    const sinceTs = state?.last_read_ts ?? 0;
    const sinceId = state?.last_read_message_id ?? "0";
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

    // Telegram timestamps have one-second resolution, so `ts` alone cannot
    // separate messages that arrived in the same second. Tie-break on the
    // (numeric, monotonic) message id so a burst is not swallowed by the marker.
    const rows = this.db
      .query<
        DbTelegramMessage,
        { $session_id: string; $since_ts: number; $since_id: string; $limit: number }
      >(
        `SELECT * FROM telegram_messages
          WHERE session_id = $session_id AND deleted = 0 AND from_bot = 0
            AND (
              ts > $since_ts
              OR (ts = $since_ts AND CAST(message_id AS INTEGER) > CAST($since_id AS INTEGER))
            )
          ORDER BY ts ASC, CAST(message_id AS INTEGER) ASC
          LIMIT $limit`,
      )
      .all({
        $session_id: input.sessionId,
        $since_ts: sinceTs,
        $since_id: sinceId,
        $limit: limit,
      });

    return rows.map(toRecord);
  }
}
