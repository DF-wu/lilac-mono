import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { DisplayMessage, DisplayPart } from "@stanley2058/lilac-client-protocol";
import { Result } from "better-result";
import type { LimitOpts, SurfaceReactionDetail, SurfaceSessionParticipantsResult } from "../types";
import { decodeNativeRecord, type NativePersistedRow } from "./codec";
import { nativeFailure } from "./errors";
import { NativeStore, nativeStoreTransaction, type NativeStoreResult } from "./store";

export type NativeActionInput = {
  threadId: string;
  messageId: string;
  actionId: string;
  requestId: string;
  revision: number;
  commandId: string;
};
export type NativeActionDispatch = (
  actorId: string,
  input: NativeActionInput,
) => Promise<NativeStoreResult<void>>;

export type NativeSurfaceMessage = { message: DisplayMessage; position: number; index: number };
type MessageRow = NativePersistedRow & { position: number; message_index: number };
const MESSAGE_SELECT = `SELECT r.position,CAST(m.key AS INTEGER) AS message_index,1 AS format_version,json_object('kind','message','value',json(m.value)) AS data_json FROM native_records r,json_each(r.data_json,'$.value.messages') m WHERE r.kind='turn' AND r.thread_id=?`;

function decodeMessageRow(row: MessageRow): NativeStoreResult<NativeSurfaceMessage> {
  return decodeNativeRecord(row).andThen(({ value }) =>
    value.kind === "message"
      ? Result.ok({ message: value.value, position: row.position, index: row.message_index })
      : Result.err(nativeFailure("invalid", "Stored surface message has another record kind")),
  );
}

export class NativeSurfaceStore {
  constructor(
    private readonly db: Database,
    readonly store: NativeStore,
    private readonly dispatchAction?: NativeActionDispatch,
  ) {}

  initialize(): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () => {
      this.db
        .run(`CREATE TABLE IF NOT EXISTS native_surface_reactions (thread_id TEXT NOT NULL,message_id TEXT NOT NULL,actor_id TEXT NOT NULL,emoji TEXT NOT NULL,PRIMARY KEY(thread_id,message_id,actor_id,emoji));
        CREATE TABLE IF NOT EXISTS native_surface_actions (actor_id TEXT NOT NULL,command_id TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(actor_id,command_id));`);
      return Result.ok(undefined);
    });
  }

  pruneDeleted(): NativeStoreResult<number> {
    return nativeStoreTransaction(this.db, () => {
      const inactive =
        "thread_id NOT IN (SELECT id FROM native_records WHERE kind='thread' AND json_extract(data_json,'$.value.deleted')=0)";
      const reactions = this.db.run(
        `DELETE FROM native_surface_reactions WHERE ${inactive}`,
      ).changes;
      const reads = this.db.run(`DELETE FROM native_surface_read WHERE ${inactive}`).changes;
      return Result.ok(reactions + reads);
    });
  }

  readMessage(
    actorId: string,
    threadId: string,
    messageId: string,
  ): NativeStoreResult<NativeSurfaceMessage | null> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        yield* this.store.authorizeThread(actorId, threadId);
        const row = this.db
          .query<MessageRow, [string, string]>(
            `${MESSAGE_SELECT} AND json_extract(m.value,'$.id')=? LIMIT 1`,
          )
          .get(threadId, messageId);
        return row ? decodeMessageRow(row) : Result.ok(null);
      }, this),
    );
  }

  listMessages(
    actorId: string,
    threadId: string,
    options: LimitOpts = {},
  ): NativeStoreResult<NativeSurfaceMessage[]> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        yield* this.store.authorizeThread(actorId, threadId);
        const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)));
        const cursorId = options.beforeMessageId ?? options.afterMessageId;
        const cursor = cursorId ? yield* this.readMessage(actorId, threadId, cursorId) : null;
        if (cursorId && !cursor)
          return Result.err(nativeFailure("not-found", "Message cursor is unavailable"));
        const ascending = options.afterMessageId !== undefined;
        const comparison = ascending ? ">" : "<";
        const condition = cursor
          ? ` AND (r.position,CAST(m.key AS INTEGER)) ${comparison} (?,?)`
          : "";
        const order = ascending ? "ASC" : "DESC";
        const rows = this.db
          .query<MessageRow, (string | number)[]>(
            `${MESSAGE_SELECT}${condition} ORDER BY r.position ${order},CAST(m.key AS INTEGER) ${order} LIMIT ? OFFSET ?`,
          )
          .all(
            threadId,
            ...(cursor ? [cursor.position, cursor.index] : []),
            limit,
            Math.max(0, (options.page ?? 1) - 1) * limit,
          );
        const messages = yield* Result.all(rows.map(decodeMessageRow));
        return Result.ok(ascending ? messages : messages.reverse());
      }, this),
    );
  }

  participants(
    actorId: string,
    threadId: string,
    limit = 100,
  ): NativeStoreResult<SurfaceSessionParticipantsResult> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const thread = yield* this.store.authorizeThread(actorId, threadId);
        const rows = this.db
          .query<{ id: string }, [string, string, number]>(
            "SELECT id FROM native_user_identity WHERE role IN ('owner','service') OR id=? OR id IN (SELECT user_id FROM native_grants WHERE thread_id=?) ORDER BY id LIMIT ?",
          )
          .all(thread.starterId, threadId, Math.min(200, Math.max(1, limit)));
        const users = yield* Result.all(rows.map((row) => this.store.getUser(row.id)));
        return Result.ok({
          source: "thread_members" as const,
          participants: users.map((user) => ({
            userId: user.id,
            userName: user.displayName,
            displayName: user.displayName,
          })),
        });
      }, this),
    );
  }

  setReaction(
    actorId: string,
    threadId: string,
    messageId: string,
    emoji: string,
    active: boolean,
    reactionActorId = actorId,
  ): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        yield* this.store.authorizeThread(actorId, threadId, true);
        const message = yield* this.readMessage(actorId, threadId, messageId);
        if (!message) return Result.err(nativeFailure("not-found", "Message is unavailable"));
        if (!emoji.trim() || emoji.length > 128)
          return Result.err(nativeFailure("invalid", "Reaction must contain 1 to 128 characters"));
        if (active) {
          this.db
            .query(
              "INSERT OR IGNORE INTO native_surface_reactions(thread_id,message_id,actor_id,emoji) VALUES(?,?,?,?)",
            )
            .run(threadId, messageId, reactionActorId, emoji);
          return this.refreshReactions(actorId, threadId, message.message);
        }
        this.db
          .query(
            "DELETE FROM native_surface_reactions WHERE thread_id=? AND message_id=? AND actor_id=? AND emoji=?",
          )
          .run(threadId, messageId, reactionActorId, emoji);
        return this.refreshReactions(actorId, threadId, message.message);
      }, this),
    );
  }

  private refreshReactions(
    actorId: string,
    threadId: string,
    message: DisplayMessage,
  ): NativeStoreResult<void> {
    return Result.gen(function* () {
      const details = yield* this.reactions(actorId, threadId, message.id);
      if (details.length > 64)
        return Result.err(
          nativeFailure("invalid", "A message can have at most 64 different reactions"),
        );
      const part: DisplayMessage["parts"][number] = {
        type: "data-reactions",
        id: `reactions_${message.id}`,
        data: {
          items: details.map((detail) => ({
            emoji: detail.emoji,
            count: detail.count,
            reacted: false,
          })),
        },
      };
      return this.store.updateSurfaceMessage(actorId, threadId, message.id, {
        ...message,
        parts: [...message.parts.filter((item) => item.type !== "data-reactions"), part],
      });
    }, this);
  }

  reactions(
    actorId: string,
    threadId: string,
    messageId: string,
  ): NativeStoreResult<SurfaceReactionDetail[]> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const message = yield* this.readMessage(actorId, threadId, messageId);
        if (!message) return Result.err(nativeFailure("not-found", "Message is unavailable"));
        const rows = this.db
          .query<{ emoji: string; actor_id: string }, [string, string]>(
            "SELECT emoji,actor_id FROM native_surface_reactions WHERE thread_id=? AND message_id=? ORDER BY emoji,actor_id",
          )
          .all(threadId, messageId);
        const details = new Map<string, SurfaceReactionDetail>();
        for (const row of rows) {
          const detail = details.get(row.emoji) ?? { emoji: row.emoji, count: 0, users: [] };
          detail.count++;
          detail.users.push({ userId: row.actor_id });
          details.set(row.emoji, detail);
        }
        return Result.ok([...details.values()]);
      }, this),
    );
  }

  markRead(
    actorId: string,
    threadId: string,
    readerId: string,
    messageId?: string,
  ): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const thread = yield* this.store.authorizeThread(actorId, threadId);
        const message = messageId
          ? yield* this.readMessage(actorId, threadId, messageId)
          : (yield* this.listMessages(actorId, threadId, { limit: 1 }))[0];
        if (messageId && !message)
          return Result.err(nativeFailure("not-found", "Message is unavailable"));
        if (!message) return Result.ok(undefined);
        const changed = this.db
          .query(
            "INSERT INTO native_surface_read(thread_id,reader_id,position,message_index,generation) VALUES(?,?,?,?,?) ON CONFLICT(thread_id,reader_id) DO UPDATE SET position=excluded.position,message_index=excluded.message_index,generation=excluded.generation WHERE generation != excluded.generation OR (position,message_index) < (excluded.position,excluded.message_index)",
          )
          .run(threadId, readerId, message.position, message.index, thread.historyGeneration);
        if (changed.changes > 0) this.store.notifyDisplayChanged(threadId);
        return Result.ok(undefined);
      }, this),
    );
  }

  unread(
    actorId: string,
    threadId: string,
    readerId: string,
  ): NativeStoreResult<NativeSurfaceMessage[]> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const thread = yield* this.store.authorizeThread(actorId, threadId);
        const read = this.db
          .query<{ position: number; message_index: number }, [string, string, number]>(
            "SELECT position,message_index FROM native_surface_read WHERE thread_id=? AND reader_id=? AND generation=?",
          )
          .get(threadId, readerId, thread.historyGeneration);
        const rows = this.db
          .query<MessageRow, [string, number, number]>(
            `${MESSAGE_SELECT} AND (r.position,CAST(m.key AS INTEGER)) > (?,?) ORDER BY r.position,CAST(m.key AS INTEGER) LIMIT 200`,
          )
          .all(threadId, read?.position ?? -1, read?.message_index ?? -1);
        return Result.all(rows.map(decodeMessageRow));
      }, this),
    );
  }
  personalizePart(
    actorId: string,
    threadId: string,
    messageId: string,
    part: DisplayPart,
  ): NativeStoreResult<DisplayPart> {
    if (part.type !== "data-reactions") return Result.ok(part);

    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        yield* this.store.authorizeThread(actorId, threadId);
        const rows = this.db
          .query<{ emoji: string }, [string, string, string]>(
            "SELECT emoji FROM native_surface_reactions WHERE thread_id=? AND message_id=? AND actor_id=?",
          )
          .all(threadId, messageId, actorId);
        const reacted = new Set(rows.map((row) => row.emoji));
        return Result.ok({
          ...part,
          data: {
            items: part.data.items.map((item) => ({ ...item, reacted: reacted.has(item.emoji) })),
          },
        });
      }, this),
    );
  }

  personalizeMessage(
    actorId: string,
    threadId: string,
    message: DisplayMessage,
  ): NativeStoreResult<DisplayMessage> {
    return Result.all(
      message.parts.map((part) => this.personalizePart(actorId, threadId, message.id, part)),
    ).map((parts) => ({ ...message, parts }));
  }

  markTurnRead(actorId: string, threadId: string, turnId: string): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        yield* this.store.authorizeThread(actorId, threadId);
        const row = this.db
          .query<MessageRow, [string, string]>(
            `${MESSAGE_SELECT} AND json_extract(r.data_json,'$.value.turnId')=? ORDER BY CAST(m.key AS INTEGER) DESC LIMIT 1`,
          )
          .get(threadId, turnId);
        if (!row) return Result.err(nativeFailure("not-found", "Turn is unavailable"));
        const message = yield* decodeMessageRow(row);
        return this.markRead(actorId, threadId, actorId, message.message.id);
      }, this),
    );
  }

  private actionStatus(
    actorId: string,
    input: NativeActionInput,
  ): NativeStoreResult<"ready" | "already-applied" | "stale"> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        yield* this.store.authorizeThread(actorId, input.threadId, true);
        const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
        const receipt = this.db
          .query<{ fingerprint: string }, [string, string]>(
            "SELECT fingerprint FROM native_surface_actions WHERE actor_id=? AND command_id=?",
          )
          .get(actorId, input.commandId);
        if (receipt)
          return receipt.fingerprint === fingerprint
            ? Result.ok("already-applied" as const)
            : Result.err(nativeFailure("conflict", "Action command ID was reused"));
        const row = yield* this.readMessage(actorId, input.threadId, input.messageId);
        const actions = row?.message.parts.find((part) => part.type === "data-actions");
        if (
          !actions ||
          actions.data.requestId !== input.requestId ||
          actions.data.revision !== input.revision
        )
          return Result.ok("stale" as const);
        if (
          !actions.data.actions.some(
            (action) => action.actionId === input.actionId && !action.disabled,
          )
        )
          return Result.ok("stale" as const);
        return Result.ok("ready" as const);
      }, this),
    );
  }

  async invokeAction(
    actorId: string,
    input: NativeActionInput,
  ): Promise<NativeStoreResult<{ outcome: "accepted" | "already-applied" | "stale" }>> {
    return Result.gen(async function* () {
      const status = yield* this.actionStatus(actorId, input);
      if (status !== "ready") return Result.ok({ outcome: status });
      if (!this.dispatchAction)
        return Result.err(nativeFailure("invalid", "Native action delivery is unavailable"));
      yield* Result.await(this.dispatchAction(actorId, input));
      yield* nativeStoreTransaction(this.db, () => {
        this.db
          .query(
            "INSERT OR IGNORE INTO native_surface_actions(actor_id,command_id,fingerprint) VALUES(?,?,?)",
          )
          .run(
            actorId,
            input.commandId,
            createHash("sha256").update(JSON.stringify(input)).digest("hex"),
          );
        return Result.ok(undefined);
      });
      return Result.ok({ outcome: "accepted" as const });
    }, this);
  }
}
