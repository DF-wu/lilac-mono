import type { Database } from "bun:sqlite";
import { Result } from "better-result";
import { z } from "zod";
import { CorruptPersistedFields } from "@stanley2058/lilac-utils";
import { NativeStore, nativeStoreTransaction, type NativeStoreResult } from "./store";
import type { NativeThreadRecord } from "./codec";
import { nativeFailure } from "./errors";

const searchRowSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  turnId: z.string(),
  messageId: z.string(),
  text: z.string(),
  authorId: z.string(),
  createdAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
  ordinal: z.number().int(),
});
export type NativeSearchMessage = z.infer<typeof searchRowSchema>;
export type NativeSearchInput = {
  query: string;
  threadId?: string;
  limit: number;
  offset?: number;
  authorId?: string;
  afterTs?: number;
  beforeTs?: number;
  direction?: "asc" | "desc";
};

const messageProjection = `WITH messages AS (
  SELECT t.id AS threadId, json_extract(t.data_json,'$.value.title') AS title,
    json_extract(r.data_json,'$.value.turnId') AS turnId,
    json_extract(m.value,'$.id') AS messageId,
    COALESCE((SELECT group_concat(json_extract(p.value,'$.text'), char(10)) FROM json_each(m.value,'$.parts') p WHERE json_extract(p.value,'$.type')='text'), '') AS text,
    COALESCE(json_extract(m.value,'$.metadata.authorId'), CASE json_extract(m.value,'$.role') WHEN 'assistant' THEN 'lilac' ELSE json_extract(t.data_json,'$.value.starterId') END) AS authorId,
    COALESCE(json_extract(m.value,'$.metadata.createdAt'), json_extract(t.data_json,'$.value.createdAt')) AS createdAt,
    row_number() OVER (PARTITION BY t.id ORDER BY r.position, CAST(m.key AS INTEGER)) - 1 AS ordinal
  FROM native_records t JOIN native_records r ON r.thread_id=t.id AND r.kind='turn'
  JOIN json_each(r.data_json,'$.value.messages') m
  WHERE t.kind='thread' AND json_extract(t.data_json,'$.value.deleted')=0 AND json_extract(t.data_json,'$.value.ephemeral') IS NULL
    AND (?='owner' OR json_extract(t.data_json,'$.value.starterId')=? OR EXISTS(SELECT 1 FROM native_grants g WHERE g.thread_id=t.id AND g.user_id=?))
)`;

function decodeSearchRows(rows: unknown[]): NativeStoreResult<NativeSearchMessage[]> {
  const parsed = z.array(searchRowSchema).safeParse(rows);
  if (!parsed.success)
    return Result.err(
      new CorruptPersistedFields({
        table: "native_records",
        field: "data_json",
        recordId: "search",
        version: 1,
        issueCode: "invalid-row-field",
        message: "Native search projection is invalid",
      }),
    );
  return Result.ok(parsed.data);
}

function decodeSearchCount(row: unknown): NativeStoreResult<{
  total: number;
  startMessageId: string | null;
  endMessageId: string | null;
}> {
  const parsed = z
    .object({
      total: z.number().int().nonnegative(),
      startMessageId: z.string().nullable(),
      endMessageId: z.string().nullable(),
    })
    .safeParse(row);
  if (!parsed.success)
    return Result.err(nativeFailure("sqlite", "Could not count thread messages"));
  return Result.ok(parsed.data);
}

export class NativeSearchStore {
  constructor(private readonly params: { db: Database; store: NativeStore }) {}

  searchMessages(
    userId: string,
    input: NativeSearchInput,
  ): NativeStoreResult<NativeSearchMessage[]> {
    const self = this;
    return nativeStoreTransaction(this.params.db, () =>
      Result.gen(function* () {
        const user = yield* self.params.store.getUser(userId);
        if (user.role === "service")
          return Result.err(
            nativeFailure("forbidden", "Service users cannot browse conversations"),
          );
        if (input.threadId) yield* self.params.store.authorizeThread(userId, input.threadId);
        const terms = input.query.trim().split(/\s+/u).filter(Boolean).slice(0, 32);
        if (terms.length === 0)
          return Result.err(nativeFailure("invalid", "Search query is required"));
        const filters: string[] = [];
        const values: (string | number)[] = [user.role, user.id, user.id];
        for (const term of terms) {
          filters.push("(instr(lower(text),lower(?))>0 OR instr(lower(title),lower(?))>0)");
          values.push(term, term);
        }
        if (input.threadId) {
          filters.push("threadId=?");
          values.push(input.threadId);
        }
        if (input.authorId) {
          filters.push("authorId=?");
          values.push(input.authorId);
        }
        if (input.afterTs !== undefined) {
          filters.push("createdAt>=?");
          values.push(input.afterTs);
        }
        if (input.beforeTs !== undefined) {
          filters.push("createdAt<=?");
          values.push(input.beforeTs);
        }
        values.push(Math.min(500, Math.max(1, input.limit)), Math.max(0, input.offset ?? 0));
        return decodeSearchRows(
          self.params.db
            .query(
              `${messageProjection} SELECT * FROM messages WHERE ${filters.join(" AND ")} ORDER BY createdAt ${input.direction === "asc" ? "ASC" : "DESC"}, threadId, ordinal DESC LIMIT ? OFFSET ?`,
            )
            .all(...values),
        );
      }),
    );
  }

  readThread(
    userId: string,
    threadId: string,
    input: { offset?: number; limit?: number } = {},
  ): NativeStoreResult<{
    thread: NativeThreadRecord;
    messages: NativeSearchMessage[];
    total: number;
    startMessageId: string | null;
    endMessageId: string | null;
  }> {
    const self = this;
    return nativeStoreTransaction(this.params.db, () =>
      Result.gen(function* () {
        const thread = yield* self.params.store.authorizeThread(userId, threadId);
        const user = yield* self.params.store.getUser(userId);
        const args = [user.role, user.id, user.id, threadId];
        const messages = yield* decodeSearchRows(
          self.params.db
            .query(
              `${messageProjection} SELECT * FROM messages WHERE threadId=? ORDER BY ordinal LIMIT ? OFFSET ?`,
            )
            .all(
              ...args,
              Math.min(200, Math.max(1, input.limit ?? 50)),
              Math.max(0, input.offset ?? 0),
            ),
        );
        const bounds = yield* decodeSearchCount(
          self.params.db
            .query(
              `${messageProjection} SELECT count(*) AS total, (SELECT messageId FROM messages WHERE threadId=? ORDER BY ordinal LIMIT 1) AS startMessageId, (SELECT messageId FROM messages WHERE threadId=? ORDER BY ordinal DESC LIMIT 1) AS endMessageId FROM messages WHERE threadId=?`,
            )
            .get(...args.slice(0, 3), threadId, threadId, threadId),
        );
        return Result.ok({ thread, messages, ...bounds });
      }),
    );
  }
}
