import type { Result as ResultType } from "better-result";

export function workflowStoreValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}
