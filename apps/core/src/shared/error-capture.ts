export interface CapturedError {
  readonly cause: Error;
  readonly captured: unknown;
}

export function captureError(cause: unknown, message = "Unknown operation failure"): CapturedError {
  return cause instanceof Error
    ? { cause, captured: undefined }
    : { cause: new Error(message, { cause }), captured: cause };
}
