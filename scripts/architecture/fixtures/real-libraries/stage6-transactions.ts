import { Database } from "bun:sqlite";

import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

class FixtureOperationFailed extends TaggedError("FixtureOperationFailed")<{
  readonly message: string;
}> {}

class FixtureDriverFailed extends TaggedError("FixtureDriverFailed")<{
  readonly message: string;
}> {}

class FixtureRollback<T, E> {
  constructor(readonly result: ResultType<T, E> & { readonly status: "error" }) {}
}

export class ExportedFixtureRollback<T, E> {
  constructor(readonly result: ResultType<T, E>) {}
}

export function classifyFixtureSqliteDriverError(cause: Error): FixtureDriverFailed | undefined {
  return cause.message.includes("SQLITE")
    ? new FixtureDriverFailed({ message: "classified SQLite fixture failure" })
    : undefined;
}

export function runFixtureSqliteTransaction<T, E>(
  database: Database,
  operation: () => ResultType<T, E>,
): ResultType<T, E | FixtureDriverFailed> {
  try {
    const value = database
      .transaction((): T => {
        const result = operation();
        if (result.status === "error") throw new FixtureRollback(result);
        return result.value;
      })
      .immediate();
    return Result.ok(value);
  } catch (cause) {
    if (cause instanceof FixtureRollback) return cause.result;
    if (Panic.is(cause)) throw cause;
    if (cause instanceof Error) {
      const driverFailure = classifyFixtureSqliteDriverError(cause);
      if (driverFailure) return Result.err(driverFailure);
    }
    throw cause;
  }
}

export function goodFixtureTransactionConsumer(database: Database, fail: boolean) {
  return runFixtureSqliteTransaction(database, () => {
    database.run("INSERT INTO fixture_values(value) VALUES ('written')");
    return fail
      ? Result.err(new FixtureOperationFailed({ message: "logical fixture failure" }))
      : Result.ok("committed");
  });
}

export function badFixtureTransactionConsumer(database: Database) {
  database.run("BEGIN");
  const transaction = database.transaction(() => Result.ok("not adapted"));
  database.run("COMMIT");
  return transaction.immediate();
}

export function rawDriverCallbackReturningErr(database: Database) {
  return database
    .transaction(() => Result.err(new FixtureOperationFailed({ message: "not rolled back" })))
    .immediate();
}

export function createFixtureDatabase(): Database {
  const database = new Database(":memory:");
  database.run("CREATE TABLE fixture_values (value TEXT NOT NULL)");
  return database;
}

export function fixtureRowCount(database: Database): number {
  const row = database
    .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM fixture_values")
    .get();
  return row?.count ?? 0;
}

export function fixturePanic(): Panic {
  return new Panic({ message: "fixture panic" });
}
