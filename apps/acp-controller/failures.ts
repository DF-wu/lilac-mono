import { TaggedError } from "better-result";

export type ExternalOperation =
  | "access-harness"
  | "cancel-session"
  | "close-harness"
  | "create-session"
  | "initialize-harness"
  | "list-sessions"
  | "load-session"
  | "probe-worker"
  | "prompt-session"
  | "read-run"
  | "read-session-index"
  | "remove-session-lock"
  | "session-index-work"
  | "set-session-mode"
  | "set-session-model"
  | "signal-worker"
  | "spawn-worker"
  | "terminate-worker"
  | "write-run"
  | "write-session-index"
  | "acquire-session-lock";

export class ExternalOperationFailed extends TaggedError("ExternalOperationFailed")<{
  readonly operation: ExternalOperation;
  readonly cause: unknown;
  readonly code?: string;
  readonly message: string;
}> {}

export class InvalidRunId extends TaggedError("InvalidRunId")<{
  readonly runId: string;
  readonly message: string;
}> {}

export class RunRecordMalformedSerialization extends TaggedError(
  "RunRecordMalformedSerialization",
)<{
  readonly runId: string;
  readonly message: string;
}> {}

export class RunRecordCorruptFields extends TaggedError("RunRecordCorruptFields")<{
  readonly runId: string;
  readonly message: string;
}> {}

export class SessionIndexMalformedSerialization extends TaggedError(
  "SessionIndexMalformedSerialization",
)<{
  readonly message: string;
}> {}

export class SessionIndexUnsupportedVersion extends TaggedError("SessionIndexUnsupportedVersion")<{
  readonly version: number;
  readonly message: string;
}> {}

export class SessionIndexCorruptFields extends TaggedError("SessionIndexCorruptFields")<{
  readonly message: string;
}> {}

export class SessionIndexLockTimedOut extends TaggedError("SessionIndexLockTimedOut")<{
  readonly message: string;
}> {}

export class WorkAndCleanupFailed<Primary> extends TaggedError("WorkAndCleanupFailed")<{
  readonly primary: Primary;
  readonly cleanup: ExternalOperationFailed;
  readonly message: string;
}> {}

export class HarnessUnavailable extends TaggedError("HarnessUnavailable")<{
  readonly harnessId: string;
  readonly message: string;
}> {}

export class SessionSelectionFailed extends TaggedError("SessionSelectionFailed")<{
  readonly message: string;
}> {}

export class RunInvariantFailed extends TaggedError("RunInvariantFailed")<{
  readonly runId: string;
  readonly message: string;
}> {}

export type RunStoreError =
  | ExternalOperationFailed
  | InvalidRunId
  | RunRecordMalformedSerialization
  | RunRecordCorruptFields;

export type SessionIndexCodecError =
  | SessionIndexMalformedSerialization
  | SessionIndexUnsupportedVersion
  | SessionIndexCorruptFields;

export type SessionStoreError =
  | ExternalOperationFailed
  | SessionIndexCodecError
  | SessionIndexLockTimedOut
  | WorkAndCleanupFailed<
      ExternalOperationFailed | SessionIndexCodecError | SessionIndexLockTimedOut
    >;

export function failureMessage(failure: { readonly message: string }): string {
  return failure.message;
}
