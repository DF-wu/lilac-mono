import type { Result as ResultType } from "better-result";

/** Converts an owned Result only where the public AI/tool compatibility contract requires rejection. */
export function adaptCodingToolResultToHost<T, E extends Error>(result: ResultType<T, E>): T {
  const outcome = result.match<{ type: "ok"; value: T } | { type: "error"; error: E }>({
    ok: (value) => ({ type: "ok" as const, value }),
    err: (error) => ({ type: "error" as const, error }),
  });
  if (outcome.type === "error") throw outcome.error;
  return outcome.value;
}
