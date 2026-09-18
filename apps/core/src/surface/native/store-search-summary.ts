import type { Database } from "bun:sqlite";
import { Result } from "better-result";
import { decodeNativeRecord, type NativePersistedRow, type NativeThreadRecord } from "./codec";
import {
  decodeNativeSummary,
  type NativeSummaryRow,
  type NativeThreadSummary,
} from "./search-summary-codec";
import { NativeStore, nativeStoreTransaction, type NativeStoreResult } from "./store";
import { nativeFailure } from "./errors";

export class NativeSummaryStore {
  constructor(private readonly params: { db: Database; store: NativeStore }) {}

  initialize(): NativeStoreResult<void> {
    return nativeStoreTransaction(this.params.db, () => {
      this.params.db.run(`CREATE TABLE IF NOT EXISTS native_thread_summaries (
        thread_id TEXT PRIMARY KEY, history_generation INTEGER NOT NULL, content_revision INTEGER NOT NULL,
        generated_at INTEGER NOT NULL, format_version INTEGER NOT NULL, data_json TEXT NOT NULL)`);
      return Result.ok(undefined);
    });
  }

  pruneDeleted(): NativeStoreResult<number> {
    return nativeStoreTransaction(this.params.db, () => {
      const deleted = this.params.db
        .query(`DELETE FROM native_thread_summaries
        WHERE NOT EXISTS(SELECT 1 FROM native_records t WHERE t.kind='thread'
          AND t.id=native_thread_summaries.thread_id
          AND json_extract(t.data_json,'$.value.deleted')=0
          AND json_extract(t.data_json,'$.value.historyGeneration')=native_thread_summaries.history_generation)`)
        .run();
      return Result.ok(deleted.changes);
    });
  }

  get(threadId: string): NativeStoreResult<NativeThreadSummary | null> {
    const self = this;
    return nativeStoreTransaction(this.params.db, () =>
      Result.gen(function* () {
        const thread = yield* self.params.store.getThreadRecord(threadId);
        if (thread.deleted || thread.mutationPending) return Result.ok(null);
        const row = self.params.db
          .query<NativeSummaryRow, [string, number]>(
            "SELECT format_version,data_json FROM native_thread_summaries WHERE thread_id=? AND history_generation=?",
          )
          .get(threadId, thread.historyGeneration);
        if (!row) return Result.ok(null);
        return decodeNativeSummary(row).map((decoded) => decoded.value);
      }),
    );
  }

  candidates(limit = 10): NativeStoreResult<NativeThreadRecord[]> {
    return nativeStoreTransaction(this.params.db, () => {
      const rows = this.params.db
        .query<
          NativePersistedRow,
          [number]
        >(`SELECT t.format_version,t.data_json FROM native_records t
        LEFT JOIN native_thread_summaries s ON s.thread_id=t.id
        WHERE t.kind='thread' AND json_extract(t.data_json,'$.value.deleted')=0 AND json_extract(t.data_json,'$.value.mutationPending')=0
        AND EXISTS(SELECT 1 FROM native_records r WHERE r.kind='turn' AND r.thread_id=t.id)
        AND (s.thread_id IS NULL OR s.history_generation<>json_extract(t.data_json,'$.value.historyGeneration') OR s.content_revision<json_extract(t.data_json,'$.value.revision'))
        ORDER BY COALESCE(s.generated_at,0),t.updated_at,t.id LIMIT ?`)
        .all(Math.min(100, Math.max(1, limit)));
      return Result.all(rows.map((row) => decodeNativeRecord(row))).map((records) =>
        records.flatMap((record) => (record.value.kind === "thread" ? [record.value.value] : [])),
      );
    });
  }

  put(value: NativeThreadSummary): NativeStoreResult<boolean> {
    const self = this;
    return nativeStoreTransaction(this.params.db, () =>
      Result.gen(function* () {
        const current = yield* self.params.store.getThreadRecord(value.threadId);
        if (
          current.deleted ||
          current.mutationPending ||
          current.historyGeneration !== value.historyGeneration
        )
          return Result.ok(false);
        const previous = yield* self.get(value.threadId);
        if (previous && previous.contentRevision >= value.contentRevision) return Result.ok(false);
        self.params.db
          .query(`INSERT INTO native_thread_summaries(thread_id,history_generation,content_revision,generated_at,format_version,data_json)
        VALUES(?,?,?,?,1,?) ON CONFLICT(thread_id) DO UPDATE SET history_generation=excluded.history_generation,content_revision=excluded.content_revision,generated_at=excluded.generated_at,format_version=1,data_json=excluded.data_json`)
          .run(
            value.threadId,
            value.historyGeneration,
            value.contentRevision,
            value.generatedAt,
            JSON.stringify(value),
          );
        return Result.ok(true);
      }),
    );
  }

  search(
    userId: string,
    input: {
      query: string;
      limit: number;
      offset?: number;
      threadId?: string;
      participantId?: string;
      participantIdsAny?: readonly string[];
      beforeTs?: number;
      afterTs?: number;
    },
  ): NativeStoreResult<NativeThreadSummary[]> {
    const self = this;
    return nativeStoreTransaction(this.params.db, () =>
      Result.gen(function* () {
        const user = yield* self.params.store.getUser(userId);
        if (user.role === "service")
          return Result.err(
            nativeFailure("forbidden", "Service users cannot browse conversations"),
          );
        const terms = input.query.trim().split(/\s+/u).filter(Boolean).slice(0, 32);
        if (!terms.length) return Result.err(nativeFailure("invalid", "Search query is required"));
        const filters = terms.map(
          () =>
            "instr(lower(COALESCE((SELECT group_concat(value,' ') FROM json_tree(s.data_json,'$.summary') WHERE type='text'),'')),lower(?))>0",
        );
        const values: (string | number)[] = [...terms];
        if (input.threadId) {
          filters.push("t.id=?");
          values.push(input.threadId);
        }
        const participants = [
          ...new Set([
            ...(input.participantIdsAny ?? []),
            ...(input.participantId ? [input.participantId] : []),
          ]),
        ];
        if (participants.length > 0) {
          const slots = participants.map(() => "?").join(",");
          filters.push(
            `(json_extract(t.data_json,'$.value.starterId') IN (${slots}) OR EXISTS(SELECT 1 FROM native_records r JOIN json_each(r.data_json,'$.value.messages') m WHERE r.kind='turn' AND r.thread_id=t.id AND json_extract(m.value,'$.metadata.authorId') IN (${slots})))`,
          );
          values.push(...participants, ...participants);
        }
        if (input.beforeTs !== undefined) {
          filters.push("json_extract(t.data_json,'$.value.createdAt')<=?");
          values.push(input.beforeTs);
        }
        if (input.afterTs !== undefined) {
          filters.push("json_extract(t.data_json,'$.value.updatedAt')>=?");
          values.push(input.afterTs);
        }
        const rows = self.params.db
          .query<
            NativeSummaryRow,
            (string | number)[]
          >(`SELECT s.format_version,s.data_json FROM native_thread_summaries s JOIN native_records t ON t.kind='thread' AND t.id=s.thread_id
        WHERE json_extract(t.data_json,'$.value.deleted')=0 AND json_extract(t.data_json,'$.value.mutationPending')=0
        AND s.history_generation=json_extract(t.data_json,'$.value.historyGeneration')
        AND (?='owner' OR json_extract(t.data_json,'$.value.starterId')=? OR EXISTS(SELECT 1 FROM native_grants g WHERE g.thread_id=t.id AND g.user_id=?))
        AND ${filters.join(" AND ")} ORDER BY t.updated_at DESC,t.id LIMIT ? OFFSET ?`)
          .all(
            user.role,
            user.id,
            user.id,
            ...values,
            Math.min(101, Math.max(1, input.limit)),
            Math.max(0, input.offset ?? 0),
          );
        return Result.all(rows.map((row) => decodeNativeSummary(row))).map((records) =>
          records.map((record) => record.value),
        );
      }),
    );
  }
}
