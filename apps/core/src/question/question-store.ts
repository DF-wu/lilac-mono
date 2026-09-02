import { Database } from "bun:sqlite";
import { classifyBunSqliteError, runBunSqliteTransaction } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { captureRuntimeError, projectCapturedRuntimeError } from "../runtime/error-format";
import { adaptToolResultToHost, preserveToolPanic } from "../tools/tool-result-adapters";
import {
  questionAnswersSchema,
  questionInputSchema,
  type QuestionActionToken,
  type QuestionAnswer,
  type QuestionCall,
  type QuestionCallState,
  type QuestionInput,
} from "./question-domain";

type QuestionCallRow = {
  question_call_id: string;
  request_delivery_id: string;
  request_id: string;
  tool_call_id: string;
  platform: string;
  session_id: string;
  user_id: string;
  input_json: string;
  current_index: number;
  answers_json: string;
  message_id: string | null;
  state: string;
  created_at: number;
  updated_at: number;
};

type QuestionTokenRow = {
  token_sha256: string;
  question_call_id: string;
  question_index: number;
  kind: string;
  option_index: number | null;
};

const questionCallStateSchema = z.enum(["pending", "answered", "cancelled", "interrupted"]);

export class QuestionStoreFailed extends TaggedError("QuestionStoreFailed")<{
  readonly operation: string;
  readonly code: string;
  readonly message: string;
}> {}

export class QuestionStoreCorrupt extends TaggedError("QuestionStoreCorrupt")<{
  readonly questionCallId: string;
  readonly message: string;
}> {}

export type QuestionStoreError = QuestionStoreFailed | QuestionStoreCorrupt;

function storeFailure(operation: string, cause: Error): QuestionStoreFailed | undefined {
  const classified = classifyBunSqliteError(cause);
  if (!classified) return undefined;
  return new QuestionStoreFailed({
    operation,
    code: classified.code,
    message: `Question store SQLite ${operation} failed`,
  });
}

function captureStoreOperation<T>(
  operation: string,
  effect: () => Awaited<T>,
): ResultType<T, QuestionStoreFailed> {
  const captured = Result.try({
    try: effect,
    catch: captureRuntimeError,
  });
  const outcome = captured.match<
    | { readonly kind: "ok"; readonly value: T }
    | { readonly kind: "error"; readonly captured: ReturnType<typeof captureRuntimeError> }
  >({
    ok: (value) => ({ kind: "ok", value }),
    err: (error) => ({ kind: "error", captured: error }),
  });
  if (outcome.kind === "ok") return Result.ok(outcome.value);
  const cause = preserveToolPanic(
    projectCapturedRuntimeError(outcome.captured, "Opaque question store failure"),
  );
  const failure = storeFailure(operation, cause);
  if (failure) return Result.err(failure);
  return adaptToolResultToHost(Result.err(cause));
}

function serializeQuestionAnswers(answers: readonly QuestionAnswer[]): string {
  return JSON.stringify(answers);
}

function parseStoredJson(value: string): ResultType<unknown, Error> {
  return Result.try({
    try: () => JSON.parse(value) as unknown,
    catch: () => new Error("Stored question JSON is malformed"),
  });
}

export function decodeQuestionCallRow(
  row: QuestionCallRow,
): ResultType<QuestionCall, QuestionStoreCorrupt> {
  const inputJson = parseStoredJson(row.input_json).match({
    ok: (value) => value,
    err: () => null,
  });
  const answersJson = parseStoredJson(row.answers_json).match({
    ok: (value) => value,
    err: () => null,
  });
  const input = questionInputSchema.safeParse(inputJson);
  const answers = questionAnswersSchema.safeParse(answersJson);
  const state = questionCallStateSchema.safeParse(row.state);
  if (
    !input.success ||
    !answers.success ||
    !state.success ||
    row.platform !== "discord" ||
    !Number.isSafeInteger(row.current_index) ||
    row.current_index < 0 ||
    row.current_index >= input.data.questions.length
  ) {
    return Result.err(
      new QuestionStoreCorrupt({
        questionCallId: row.question_call_id,
        message: "Stored question call is invalid",
      }),
    );
  }
  return Result.ok({
    questionCallId: row.question_call_id,
    requestDeliveryId: row.request_delivery_id,
    requestId: row.request_id,
    toolCallId: row.tool_call_id,
    platform: "discord",
    sessionId: row.session_id,
    userId: row.user_id,
    input: input.data,
    currentIndex: row.current_index,
    answers: answers.data,
    messageId: row.message_id,
    state: state.data,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export type ApplyQuestionAnswerResult =
  | { readonly disposition: "not-found" | "stale" | "unauthorized" }
  | { readonly disposition: "accepted"; readonly call: QuestionCall };

export class SqliteQuestionStore {
  readonly #database: Database;
  readonly #now: () => number;

  constructor(input: { readonly dbPath: string; readonly now?: () => number }) {
    this.#database = new Database(input.dbPath, { create: true, strict: true });
    this.#now = input.now ?? Date.now;
    this.#database.run("PRAGMA foreign_keys = ON");
    this.#database.run("PRAGMA journal_mode = WAL");
    this.#database.run(`
      CREATE TABLE IF NOT EXISTS agent_question_calls (
        question_call_id TEXT PRIMARY KEY NOT NULL,
        request_delivery_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform = 'discord'),
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        input_json TEXT NOT NULL,
        current_index INTEGER NOT NULL,
        answers_json TEXT NOT NULL,
        message_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'answered', 'cancelled', 'interrupted')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (request_delivery_id, tool_call_id),
        FOREIGN KEY (request_delivery_id) REFERENCES request_delivery_records(request_delivery_id)
          ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_question_tokens (
        token_sha256 TEXT PRIMARY KEY NOT NULL,
        question_call_id TEXT NOT NULL,
        question_index INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('option', 'custom')),
        option_index INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (question_call_id) REFERENCES agent_question_calls(question_call_id)
          ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS agent_question_calls_pending_idx
        ON agent_question_calls(state, created_at);
      CREATE INDEX IF NOT EXISTS agent_question_tokens_call_idx
        ON agent_question_tokens(question_call_id, question_index);
    `);
  }

  close(): void {
    this.#database.close();
  }

  getByIdentity(
    requestDeliveryId: string,
    toolCallId: string,
  ): ResultType<QuestionCall | null, QuestionStoreError> {
    const selected = captureStoreOperation("get-by-identity", () =>
      this.#database
        .query<QuestionCallRow, [string, string]>(
          `SELECT * FROM agent_question_calls
           WHERE request_delivery_id = ? AND tool_call_id = ?`,
        )
        .get(requestDeliveryId, toolCallId),
    );
    return selected.andThen((row) => (row ? decodeQuestionCallRow(row) : Result.ok(null)));
  }

  getById(questionCallId: string): ResultType<QuestionCall | null, QuestionStoreError> {
    const selected = captureStoreOperation("get-by-id", () => this.#selectCall(questionCallId));
    return selected.andThen((row) => (row ? decodeQuestionCallRow(row) : Result.ok(null)));
  }

  create(input: {
    readonly questionCallId: string;
    readonly requestDeliveryId: string;
    readonly requestId: string;
    readonly toolCallId: string;
    readonly sessionId: string;
    readonly userId: string;
    readonly questionInput: QuestionInput;
    readonly tokens: readonly QuestionActionToken[];
  }): ResultType<QuestionCall, QuestionStoreError> {
    const now = this.#now();
    return runBunSqliteTransaction(
      this.#database,
      () => {
        const inserted = this.#database
          .query<never, [string, string, string, string, string, string, string, number, number]>(
            `INSERT OR IGNORE INTO agent_question_calls (
              question_call_id, request_delivery_id, request_id, tool_call_id, platform,
              session_id, user_id, input_json, current_index, answers_json, message_id,
              state, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'discord', ?, ?, ?, 0, '[]', NULL, 'pending', ?, ?)`,
          )
          .run(
            input.questionCallId,
            input.requestDeliveryId,
            input.requestId,
            input.toolCallId,
            input.sessionId,
            input.userId,
            JSON.stringify(input.questionInput),
            now,
            now,
          );
        if (inserted.changes === 0) {
          return this.getByIdentity(input.requestDeliveryId, input.toolCallId).andThen((call) =>
            call
              ? Result.ok(call)
              : Result.err(
                  new QuestionStoreCorrupt({
                    questionCallId: input.questionCallId,
                    message: "Question identity conflict has no stored call",
                  }),
                ),
          );
        }
        for (const token of input.tokens) this.#insertToken(input.questionCallId, token, now);
        const row = this.#selectCall(input.questionCallId);
        return row
          ? decodeQuestionCallRow(row)
          : Result.err(
              new QuestionStoreCorrupt({
                questionCallId: input.questionCallId,
                message: "Created question call is missing",
              }),
            );
      },
      (cause) => storeFailure("create", cause),
    );
  }

  bindMessage(questionCallId: string, messageId: string): ResultType<void, QuestionStoreFailed> {
    return captureStoreOperation("bind-message", () => {
      this.#database
        .query<never, [string, number, string]>(
          `UPDATE agent_question_calls SET message_id = ?, updated_at = ?
           WHERE question_call_id = ? AND state = 'pending'`,
        )
        .run(messageId, this.#now(), questionCallId);
    });
  }

  replaceTokens(
    questionCallId: string,
    tokens: readonly QuestionActionToken[],
  ): ResultType<void, QuestionStoreFailed> {
    const now = this.#now();
    return runBunSqliteTransaction(
      this.#database,
      () => {
        this.#database
          .query<never, [string]>("DELETE FROM agent_question_tokens WHERE question_call_id = ?")
          .run(questionCallId);
        for (const token of tokens) this.#insertToken(questionCallId, token, now);
        return Result.ok(undefined);
      },
      (cause) => storeFailure("replace-tokens", cause),
    );
  }

  applyAnswer(input: {
    readonly tokenSha256: string;
    readonly platform: "discord";
    readonly channelId: string;
    readonly messageId: string;
    readonly userId: string;
    readonly answer:
      | { readonly kind: "option"; readonly optionIndex: number }
      | { readonly kind: "custom"; readonly text: string };
  }): ResultType<ApplyQuestionAnswerResult, QuestionStoreError> {
    const now = this.#now();
    return runBunSqliteTransaction(
      this.#database,
      () => {
        const token = this.#database
          .query<QuestionTokenRow, [string]>(
            "SELECT * FROM agent_question_tokens WHERE token_sha256 = ?",
          )
          .get(input.tokenSha256);
        if (!token) return Result.ok({ disposition: "not-found" });
        const row = this.#selectCall(token.question_call_id);
        if (!row) return Result.ok({ disposition: "not-found" });
        const decoded = decodeQuestionCallRow(row);
        const decodedOutcome = decoded.match<
          | { readonly kind: "call"; readonly call: QuestionCall }
          | { readonly kind: "error"; readonly error: QuestionStoreCorrupt }
        >({
          ok: (call) => ({ kind: "call", call }),
          err: (error) => ({ kind: "error", error }),
        });
        if (decodedOutcome.kind === "error") return Result.err(decodedOutcome.error);
        const call = decodedOutcome.call;
        if (call.state !== "pending" || token.question_index !== call.currentIndex) {
          return Result.ok({ disposition: "stale" });
        }
        if (
          call.platform !== input.platform ||
          call.sessionId !== input.channelId ||
          call.userId !== input.userId
        ) {
          return Result.ok({ disposition: "unauthorized" });
        }
        if (call.messageId !== input.messageId) {
          return Result.ok({ disposition: "stale" });
        }
        if (token.kind !== input.answer.kind) return Result.ok({ disposition: "stale" });
        if (
          input.answer.kind === "option" &&
          (token.option_index !== input.answer.optionIndex || token.option_index === null)
        ) {
          return Result.ok({ disposition: "stale" });
        }
        const question = call.input.questions[call.currentIndex];
        if (!question) return Result.ok({ disposition: "stale" });
        let answer: QuestionAnswer;
        if (input.answer.kind === "custom") {
          answer = {
            questionId: question.id,
            answer: { kind: "custom", text: input.answer.text },
          };
        } else {
          const option = question.options[input.answer.optionIndex - 1];
          if (!option) return Result.ok({ disposition: "stale" });
          answer = {
            questionId: question.id,
            answer: { kind: "option", optionId: option.id },
          };
        }
        const answers = [...call.answers, answer];
        const answered = call.currentIndex + 1 >= call.input.questions.length;
        const state: QuestionCallState = answered ? "answered" : "pending";
        const currentIndex = answered ? call.currentIndex : call.currentIndex + 1;
        this.#database
          .query<never, [number, string, string, number, string]>(
            `UPDATE agent_question_calls
             SET current_index = ?, answers_json = ?, state = ?, updated_at = ?
             WHERE question_call_id = ? AND state = 'pending'`,
          )
          .run(currentIndex, serializeQuestionAnswers(answers), state, now, call.questionCallId);
        this.#database
          .query<never, [string]>("DELETE FROM agent_question_tokens WHERE question_call_id = ?")
          .run(call.questionCallId);
        return Result.ok({
          disposition: "accepted",
          call: { ...call, currentIndex, answers, state, updatedAt: now },
        });
      },
      (cause) => storeFailure("apply-answer", cause),
    );
  }

  transitionPending(
    questionCallId: string,
    state: Extract<QuestionCallState, "cancelled" | "interrupted">,
  ): ResultType<void, QuestionStoreFailed> {
    return captureStoreOperation("transition-pending", () => {
      const now = this.#now();
      this.#database
        .query<never, [string, number, string]>(
          `UPDATE agent_question_calls SET state = ?, updated_at = ?
           WHERE question_call_id = ? AND state = 'pending'`,
        )
        .run(state, now, questionCallId);
      this.#database
        .query<never, [string]>("DELETE FROM agent_question_tokens WHERE question_call_id = ?")
        .run(questionCallId);
    });
  }

  interruptPending(): ResultType<QuestionCall[], QuestionStoreError> {
    return runBunSqliteTransaction(
      this.#database,
      () => {
        const rows = this.#database
          .query<QuestionCallRow, []>(
            "SELECT * FROM agent_question_calls WHERE state = 'pending' ORDER BY created_at",
          )
          .all();
        const calls: QuestionCall[] = [];
        for (const row of rows) {
          const decoded = decodeQuestionCallRow(row);
          const outcome = decoded.match<
            | { readonly kind: "call"; readonly call: QuestionCall }
            | { readonly kind: "error"; readonly error: QuestionStoreCorrupt }
          >({
            ok: (call) => ({ kind: "call", call }),
            err: (error) => ({ kind: "error", error }),
          });
          if (outcome.kind === "error") return Result.err(outcome.error);
          calls.push(outcome.call);
        }
        const now = this.#now();
        this.#database.run(
          "UPDATE agent_question_calls SET state = 'interrupted', updated_at = ? WHERE state = 'pending'",
          [now],
        );
        this.#database.run(
          `DELETE FROM agent_question_tokens
           WHERE question_call_id IN (
             SELECT question_call_id FROM agent_question_calls WHERE state = 'interrupted'
           )`,
        );
        return Result.ok(calls.map((call) => ({ ...call, state: "interrupted", updatedAt: now })));
      },
      (cause) => storeFailure("interrupt-pending", cause),
    );
  }

  #selectCall(questionCallId: string): QuestionCallRow | null {
    return (
      this.#database
        .query<QuestionCallRow, [string]>(
          "SELECT * FROM agent_question_calls WHERE question_call_id = ?",
        )
        .get(questionCallId) ?? null
    );
  }

  #insertToken(questionCallId: string, token: QuestionActionToken, now: number): void {
    this.#database
      .query<never, [string, string, number, string, number | null, number]>(
        `INSERT INTO agent_question_tokens (
          token_sha256, question_call_id, question_index, kind, option_index, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        token.tokenSha256,
        questionCallId,
        token.questionIndex,
        token.kind,
        token.optionIndex,
        now,
      );
  }
}
