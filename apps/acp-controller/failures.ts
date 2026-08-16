import { TaggedError } from "better-result";

export type ExternalOperation =
  | "access-harness"
  | "cancel-session"
  | "close-run-cancellation-watch"
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
  | "remove-worker-signals"
  | "session-index-work"
  | "set-session-mode"
  | "set-session-model"
  | "signal-worker"
  | "spawn-worker"
  | "terminate-worker"
  | "worker-process"
  | "watch-run-cancellation"
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

export class RunCancellationMalformedSerialization extends TaggedError(
  "RunCancellationMalformedSerialization",
)<{
  readonly runId: string;
  readonly message: string;
}> {}

export class RunCancellationUnsupportedVersion extends TaggedError(
  "RunCancellationUnsupportedVersion",
)<{
  readonly runId: string;
  readonly version: number;
  readonly message: string;
}> {}

export class RunCancellationCorruptFields extends TaggedError("RunCancellationCorruptFields")<{
  readonly runId: string;
  readonly message: string;
}> {}

export class RunCancellationMarkerInvalidType extends TaggedError(
  "RunCancellationMarkerInvalidType",
)<{
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

export class WorkAndMonitorFailed<Primary, Monitor> extends TaggedError("WorkAndMonitorFailed")<{
  readonly primary: Primary;
  readonly monitor: Monitor;
  readonly message: string;
}> {}

export class MonitorTerminationFailed<Primary> extends TaggedError("MonitorTerminationFailed")<{
  readonly primary: Primary;
  readonly watcherCleanup?: ExternalOperationFailed;
  readonly termination?: ExternalOperationFailed;
  readonly message: string;
}> {}

export class WorkerLifecycleCleanupFailed<Primary> extends TaggedError(
  "WorkerLifecycleCleanupFailed",
)<{
  readonly primary?: Primary;
  readonly signalCleanup?: ExternalOperationFailed;
  readonly harnessCleanup?: ExternalOperationFailed;
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
  | RunRecordCorruptFields
  | RunCancellationMalformedSerialization
  | RunCancellationUnsupportedVersion
  | RunCancellationCorruptFields
  | RunCancellationMarkerInvalidType;

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
