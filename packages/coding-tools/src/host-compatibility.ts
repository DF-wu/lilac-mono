import type { Result as ResultType } from "better-result";

/** Converts an owned Result only where the public AI/tool compatibility contract requires rejection. */
export function adaptCodingToolResultToHost<T, E extends Error>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}
