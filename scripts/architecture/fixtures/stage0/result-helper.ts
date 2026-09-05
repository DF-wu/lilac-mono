import { TaggedErrorBase } from "better-result";

class ImportedWireFailure extends TaggedErrorBase {
  override readonly _tag = "ImportedWireFailure";
}

export function importedThrowingMapper(): never {
  throw new ImportedWireFailure();
}

export interface FixtureCapturedError {
  readonly cause: Error;
  readonly captured: unknown;
}

export function captureFixtureError(
  cause: unknown,
  message = "Unknown fixture failure",
): FixtureCapturedError {
  return cause instanceof Error
    ? { cause, captured: undefined }
    : { cause: new Error(message, { cause }), captured: cause };
}
