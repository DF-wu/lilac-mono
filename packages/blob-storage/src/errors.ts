import { TaggedError } from "better-result";

export type BlobAdapterFailureKind =
  | "unavailable"
  | "authentication"
  | "authorization"
  | "throttled"
  | "timeout"
  | "io";

export class BlobInvalidConfiguration extends TaggedError("BlobInvalidConfiguration")<{
  readonly issues: readonly string[];
  readonly message: string;
}> {}

export class BlobInvalidInput extends TaggedError("BlobInvalidInput")<{
  readonly field: string;
  readonly message: string;
}> {}

export class BlobInvalidReference extends TaggedError("BlobInvalidReference")<{
  readonly issues: readonly string[];
  readonly message: string;
}> {}

export class BlobInvalidRetention extends TaggedError("BlobInvalidRetention")<{
  readonly message: string;
}> {}

export class BlobAdapterLayoutInvalid extends TaggedError("BlobAdapterLayoutInvalid")<{
  readonly adapter: "local" | "s3" | "memory";
  readonly message: string;
}> {}

export class BlobAdapterFailure extends TaggedError("BlobAdapterFailure")<{
  readonly adapter: "local" | "s3" | "memory";
  readonly kind: BlobAdapterFailureKind;
  readonly operation: string;
  readonly message: string;
}> {}

export class BlobUploadReservationFailed extends TaggedError("BlobUploadReservationFailed")<{
  readonly objectId: string;
  readonly failure: BlobAdapterFailure;
  readonly message: string;
}> {}

export class BlobStoreClosed extends TaggedError("BlobStoreClosed")<{
  readonly message: string;
}> {}

export class BlobUploadFailed extends TaggedError("BlobUploadFailed")<{
  readonly objectId: string;
  readonly reason: "source" | "write" | "expected_sha256" | "expected_byte_length" | "fenced";
  readonly message: string;
}> {}

export class BlobUploadInterrupted extends TaggedError("BlobUploadInterrupted")<{
  readonly objectId: string;
  readonly message: string;
}> {}

export class BlobResolveTimeout extends TaggedError("BlobResolveTimeout")<{
  readonly objectId: string;
  readonly timeoutMs: number;
  readonly message: string;
}> {}

export class BlobObjectAbsent extends TaggedError("BlobObjectAbsent")<{
  readonly objectId: string;
  readonly message: string;
}> {}

export class BlobObjectExpired extends TaggedError("BlobObjectExpired")<{
  readonly objectId: string;
  readonly expiresAt: number;
  readonly message: string;
}> {}

export class BlobIntegrityFailure extends TaggedError("BlobIntegrityFailure")<{
  readonly objectId: string;
  readonly reason: string;
  readonly message: string;
}> {}

export class BlobReadCancelled extends TaggedError("BlobReadCancelled")<{
  readonly objectId: string;
  readonly message: string;
}> {}

export class BlobReadSourceFailure extends TaggedError("BlobReadSourceFailure")<{
  readonly objectId: string;
  readonly message: string;
}> {}

export class BlobDeleteFailed extends TaggedError("BlobDeleteFailed")<{
  readonly objectId: string;
  readonly failure: BlobAdapterFailure;
  readonly message: string;
}> {}

export class BlobMaintenanceFailed extends TaggedError("BlobMaintenanceFailed")<{
  readonly failure: BlobAdapterFailure | BlobIntegrityFailure;
  readonly message: string;
}> {}

export class BlobCloseDeadlineExceeded extends TaggedError("BlobCloseDeadlineExceeded")<{
  readonly deadlineAtMs: number;
  readonly pendingFences: number;
  readonly message: string;
}> {}

export class BlobCloseFailed extends TaggedError("BlobCloseFailed")<{
  readonly failure: BlobAdapterFailure | BlobIntegrityFailure;
  readonly message: string;
}> {}

export class BlobOperationAndCleanupFailed extends TaggedError("BlobOperationAndCleanupFailed")<{
  readonly operation: string;
  readonly primary: BlobAdapterFailure | BlobUploadFailed | BlobUploadInterrupted;
  readonly cleanup: BlobAdapterFailure;
  readonly message: string;
}> {}

export type BlobStoreCreateError =
  | BlobInvalidConfiguration
  | BlobAdapterLayoutInvalid
  | BlobAdapterFailure;
export type BlobUploadStartError =
  | BlobInvalidInput
  | BlobInvalidRetention
  | BlobStoreClosed
  | BlobUploadReservationFailed;
export type BlobWriteError =
  | BlobUploadFailed
  | BlobUploadInterrupted
  | BlobOperationAndCleanupFailed;
export type BlobResolveError =
  | BlobInvalidReference
  | BlobInvalidInput
  | BlobObjectAbsent
  | BlobResolveTimeout
  | BlobUploadFailed
  | BlobUploadInterrupted
  | BlobIntegrityFailure
  | BlobAdapterFailure;
export type BlobReadError =
  | BlobInvalidReference
  | BlobObjectAbsent
  | BlobObjectExpired
  | BlobIntegrityFailure
  | BlobAdapterFailure;
export type BlobReadTerminalError =
  | BlobReadCancelled
  | BlobReadSourceFailure
  | BlobIntegrityFailure;
export type BlobDeleteError =
  | BlobInvalidReference
  | BlobDeleteFailed
  | BlobIntegrityFailure
  | BlobAdapterFailure;
export type BlobMaintenanceError =
  | BlobInvalidInput
  | BlobMaintenanceFailed
  | BlobOperationAndCleanupFailed;
export type BlobCloseError = BlobInvalidInput | BlobCloseDeadlineExceeded | BlobCloseFailed;
