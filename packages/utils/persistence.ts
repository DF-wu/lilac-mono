import { SQLiteError, type Database } from "bun:sqlite";

import { Panic, Result, TaggedError, type Err, type Result as ResultType } from "better-result";

export type PersistenceProvenance = "current" | "migrated" | "missing-defaulted";

export type DecodedPersistedValue<T> = {
  readonly value: T;
  readonly provenance: PersistenceProvenance;
};

export type PersistedDataIssueCode =
  | "unsupported-version"
  | "malformed-json"
  | "invalid-row-version"
  | "missing-required-field"
  | "invalid-row-field"
  | "invalid-string-array"
  | "mixed-string-array"
  | "invalid-aboutness"
  | "invalid-importance"
  | "invalid-transcript-row"
  | "invalid-transcript-messages"
  | "invalid-compaction-context"
  | "invalid-provider-state"
  | "invalid-surface-projection"
  | "invalid-lineage-manifest"
  | "digest-mismatch";

export type PersistedDataErrorContext = {
  readonly table: string;
  readonly field: string;
  readonly version: number;
  readonly issueCode: PersistedDataIssueCode;
  readonly recordId: string;
  readonly message: string;
};

export class UnsupportedVersion extends TaggedError(
  "UnsupportedVersion",
)<PersistedDataErrorContext> {}

export class MalformedSerialization extends TaggedError(
  "MalformedSerialization",
)<PersistedDataErrorContext> {}

export class CorruptPersistedFields extends TaggedError(
  "CorruptPersistedFields",
)<PersistedDataErrorContext> {}

export type PersistedDataError =
  | UnsupportedVersion
  | MalformedSerialization
  | CorruptPersistedFields;

export type BunSqliteDriverFailureClassifier<TDriverError extends Error> = (
  cause: Error,
) => TDriverError | undefined;

export type BunSqliteErrorClassification = {
  readonly code: string;
};

export function classifyBunSqliteError(cause: Error): BunSqliteErrorClassification | undefined {
  return Result.try({
    try: () => {
      if (!(cause instanceof SQLiteError)) return undefined;
      const code = cause.code;
      if (typeof code === "string") return { code };
      const errno = cause.errno;
      return typeof errno === "number" ? { code: `SQLITE_ERRNO_${errno}` } : undefined;
    },
    catch: () => undefined,
  }).match({ ok: (value) => value, err: () => undefined });
}

class BunSqliteRollbackSentinel<T, TOperationError> {
  readonly #result: Err<T, TOperationError>;

  constructor(result: Err<T, TOperationError>) {
    this.#result = result;
  }

  result(): Err<T, TOperationError> {
    return this.#result;
  }
}

function classifyBunSqliteDriverFailure<TDriverError extends Error>(
  cause: Error,
  classifyDriverFailure: BunSqliteDriverFailureClassifier<TDriverError>,
): TDriverError | undefined {
  return classifyDriverFailure(cause);
}

/**
 * Runs a synchronous logical operation in one immediate Bun SQLite transaction.
 * Expected operation failures roll back through a private exception that never
 * crosses this adapter boundary.
 */
export function runBunSqliteTransaction<T, TOperationError, TDriverError extends Error>(
  database: Database,
  operation: () => ResultType<T, TOperationError>,
  classifyDriverFailure: BunSqliteDriverFailureClassifier<TDriverError>,
): ResultType<T, TOperationError | TDriverError> {
  let rollbackSentinel: BunSqliteRollbackSentinel<T, TOperationError> | undefined;
  let callbackCompleted = false;

  const transaction = Result.try({
    try: () => ({
      value: database
        .transaction((): T => {
          const result = operation();
          if (result.status === "error") {
            rollbackSentinel = new BunSqliteRollbackSentinel(result);
            throw rollbackSentinel;
          }

          callbackCompleted = true;
          return result.value;
        })
        .immediate(),
    }),
    catch: (cause) => ({ cause }),
  });
  const transactionOutcome = transaction.match<
    | { readonly kind: "value"; readonly value: T }
    | { readonly kind: "cause"; readonly cause: unknown }
  >({
    ok: ({ value }) => ({ kind: "value", value }),
    err: ({ cause }) => ({ kind: "cause", cause }),
  });
  if (transactionOutcome.kind === "value") return Result.ok(transactionOutcome.value);
  const cause = transactionOutcome.cause;
  if (rollbackSentinel !== undefined && cause === rollbackSentinel) {
    return rollbackSentinel.result();
  }

  const panicObservation = Result.try({
    try: () => {
      if (Panic.is(cause)) throw cause;
    },
    catch: () => true,
  });
  const panicMustRethrow = panicObservation.match({
    ok: () => false,
    err: (value) => value,
  });
  if (panicMustRethrow) throw cause;

  if (rollbackSentinel !== undefined || callbackCompleted) {
    throw new Panic({
      message: "Bun SQLite transaction finalization failed; atomicity is unknown",
      cause,
    });
  }

  const causeIsError = Result.try({
    try: () => cause instanceof Error,
    catch: () => false,
  }).match({
    ok: (value) => value,
    err: (value) => value,
  });
  if (!causeIsError) throw cause;
  if (!(cause instanceof Error)) throw cause;

  const driverFailure = classifyBunSqliteDriverFailure(cause, classifyDriverFailure);
  if (driverFailure !== undefined) return Result.err(driverFailure);
  throw cause;
}
