import { TaggedError } from "better-result";

export type NativeStoreFailureCode =
  | "sqlite"
  | "not-found"
  | "forbidden"
  | "conflict"
  | "stale"
  | "invalid";

export class NativeStoreFailure extends TaggedError("NativeStoreFailure")<{
  readonly code: NativeStoreFailureCode;
  readonly message: string;
}> {}

export function nativeFailure(
  code: NativeStoreFailure["code"],
  message: string,
): NativeStoreFailure {
  return new NativeStoreFailure({ code, message });
}
