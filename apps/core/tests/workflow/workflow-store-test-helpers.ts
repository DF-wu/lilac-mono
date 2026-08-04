import type { Result as ResultType } from "better-result";

import { normalizeWorkflowResourcePolicyResult } from "../../src/workflow/workflow-domain";

export function workflowStoreValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

export function normalizeWorkflowResourcePolicy(input: unknown) {
  return workflowStoreValue(normalizeWorkflowResourcePolicyResult(input));
}
