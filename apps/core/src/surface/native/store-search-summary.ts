import type { ConversationThreadRunSummarizationInput } from "../../conversation/thread-service";
import { SUMMARY_QUIET_MS } from "../../conversation/thread-summary-policy";
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
          AND json_extract(t.data_json,'$.value.deleted')=0 AND json_extract(t.data_json,'$.value.ephemeral') IS NULL
          AND json_extract(t.data_json,'$.value.historyGeneration')=native_thread_summaries.history_generation)`)
        .run();
      return Result.ok(deleted.changes);
    });
  }

  get(threadId: string): NativeStoreResult<NativeThreadSummary | null> {
    return nativeStoreTransaction(this.params.db, () =>
      Result.gen(function* () {
        const thread = yield* this.params.store.getThreadRecord(threadId);
        if (thread.deleted || thread.mutationPending || thread.ephemeral) return Result.ok(null);
        const row = this.params.db
          .query<NativeSummaryRow, [string, number]>(
            "SELECT format_version,data_json FROM native_thread_summaries WHERE thread_id=? AND history_generation=?",
          )
          .get(threadId, thread.historyGeneration);
        if (!row) return Result.ok(null);
        return decodeNativeSummary(row).map((decoded) => decoded.value);
      }, this),
    );
  }

  clear(input: ConversationThreadRunSummarizationInput): NativeStoreResult<string[]> {
    return nativeStoreTransaction(this.params.db, () => {
      const ids = this.params.db
        .query<{ thread_id: string }, (string | number | null)[]>(`
        SELECT s.thread_id FROM native_thread_summaries s JOIN native_records t ON t.kind='thread' AND t.id=s.thread_id
        WHERE (? IS NULL OR t.id=?) AND (? IS NULL OR t.updated_at<=?) AND (? IS NULL OR t.updated_at>=?)
      `)
        .all(...this.scopeValues(input))
        .map((row) => row.thread_id);
      if (!input.dryRun) {
        for (const id of ids)
          this.params.db.query("DELETE FROM native_thread_summaries WHERE thread_id=?").run(id);
      }
      return Result.ok(ids);
    });
  }

  private scopeValues(input: ConversationThreadRunSummarizationInput): (string | number | null)[] {
    const id = input.threadId?.replace(/^native:/u, "") ?? null;
    return [
      id,
      id,
      input.beforeTs ?? null,
      input.beforeTs ?? null,
      input.afterTs ?? null,
      input.afterTs ?? null,
    ];
  }

  candidates(
    input: ConversationThreadRunSummarizationInput = {},
  ): NativeStoreResult<NativeThreadRecord[]> {
    return nativeStoreTransaction(this.params.db, () => {
      const rows = this.params.db
        .query<
          NativePersistedRow,
          (string | number | null)[]
        >(`SELECT t.format_version,t.data_json FROM native_records t
        LEFT JOIN native_thread_summaries s ON s.thread_id=t.id
        WHERE t.kind='thread' AND json_extract(t.data_json,'$.value.deleted')=0 AND json_extract(t.data_json,'$.value.ephemeral') IS NULL AND json_extract(t.data_json,'$.value.mutationPending')=0
        AND json_extract(t.data_json,'$.value.activeRunId') IS NULL
        AND t.updated_at<=?
        AND (? IS NULL OR t.id=?) AND (? IS NULL OR t.updated_at<=?) AND (? IS NULL OR t.updated_at>=?)
        AND (SELECT count(*) FROM native_records r WHERE r.kind='turn' AND r.thread_id=t.id
          AND json_extract(r.data_json,'$.value.state')='complete'
          AND EXISTS(SELECT 1 FROM json_each(r.data_json,'$.value.messages') m WHERE json_extract(m.value,'$.role')='user')
          AND EXISTS(SELECT 1 FROM json_each(r.data_json,'$.value.messages') m, json_each(m.value,'$.parts') p
            WHERE json_extract(m.value,'$.role')='assistant'
              AND ((json_extract(p.value,'$.type')='text' AND length(trim(json_extract(p.value,'$.text')))>0)
                OR json_extract(p.value,'$.type')='data-resource'))
        )>=2
        AND (?=1 OR s.thread_id IS NULL OR s.history_generation<>json_extract(t.data_json,'$.value.historyGeneration') OR s.content_revision<json_extract(t.data_json,'$.value.revision'))
        ORDER BY COALESCE(s.generated_at,0),t.updated_at,t.id`)
        .all(
          (input.now ?? Date.now()) - SUMMARY_QUIET_MS,
          ...this.scopeValues(input),
          input.force ? 1 : 0,
        );
      return Result.all(rows.map((row) => decodeNativeRecord(row))).map((records) =>
        records.flatMap((record) => (record.value.kind === "thread" ? [record.value.value] : [])),
      );
    });
  }

  put(value: NativeThreadSummary): NativeStoreResult<boolean> {
    return nativeStoreTransaction(this.params.db, () =>
      Result.gen(function* () {
        const current = yield* this.params.store.getThreadRecord(value.threadId);
        if (
          current.deleted ||
          current.mutationPending ||
          current.revision !== value.contentRevision ||
          current.historyGeneration !== value.historyGeneration
        )
          return Result.ok(false);
        const previous = yield* this.get(value.threadId);
        if (previous && previous.contentRevision > value.contentRevision) return Result.ok(false);
        this.params.db
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
      }, this),
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
    return nativeStoreTransaction(this.params.db, () =>
      Result.gen(function* () {
        const user = yield* this.params.store.getUser(userId);
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
        const rows = this.params.db
          .query<
            NativeSummaryRow,
            (string | number)[]
          >(`SELECT s.format_version,s.data_json FROM native_thread_summaries s JOIN native_records t ON t.kind='thread' AND t.id=s.thread_id
        WHERE json_extract(t.data_json,'$.value.deleted')=0 AND json_extract(t.data_json,'$.value.ephemeral') IS NULL AND json_extract(t.data_json,'$.value.mutationPending')=0
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
      }, this),
    );
  }
}
