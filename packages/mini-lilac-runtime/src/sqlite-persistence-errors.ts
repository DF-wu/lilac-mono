import { classifyBunSqliteError } from "@stanley2058/lilac-utils";
import { TaggedError } from "better-result";

export class MiniLilacSqliteDriverFailure extends TaggedError("MiniLilacSqliteDriverFailure")<{
  readonly operation: string;
  readonly code: string;
  readonly message: string;
}> {}

export class MiniLilacSchemaMigrationFailure extends TaggedError(
  "MiniLilacSchemaMigrationFailure",
)<{
  readonly operation: string;
  readonly message: string;
}> {}

export class MiniLilacSchemaInitializationCombinedFailure extends TaggedError(
  "MiniLilacSchemaInitializationCombinedFailure",
)<{
  readonly operation: "initializeSchema" | "closeAfterInitializationFailure";
  readonly primary: Error;
  readonly cleanup: Error;
  readonly message: string;
}> {}

export class MiniLilacHistoryRecordMissing extends TaggedError("MiniLilacHistoryRecordMissing")<{
  readonly recordKind: string;
  readonly recordId: string;
  readonly message: string;
}> {}

export function classifyMiniLilacSqliteDriverFailure(
  operation: string,
  cause: Error,
): MiniLilacSqliteDriverFailure | undefined {
  const sqliteError = classifyBunSqliteError(cause);
  if (sqliteError === undefined) return undefined;
  return new MiniLilacSqliteDriverFailure({
    operation,
    code: sqliteError.code,
    message: "Mini Lilac SQLite operation failed",
  });
}
