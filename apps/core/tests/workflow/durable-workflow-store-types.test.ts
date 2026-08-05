import { expect, it } from "bun:test";

import type { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import type { WorkflowRun } from "../../src/workflow/workflow-domain";

type AssertFalse<T extends false> = T;
type GetRunResult = ReturnType<DurableWorkflowStore["getRun"]>;
type ListRunsResult = ReturnType<DurableWorkflowStore["listRuns"]>;

type GetRunIsNotDomain = AssertFalse<GetRunResult extends WorkflowRun | null ? true : false>;
type GetRunIsNotNullable = AssertFalse<null extends GetRunResult ? true : false>;
type ListRunsIsNotArray = AssertFalse<ListRunsResult extends readonly WorkflowRun[] ? true : false>;

function compileTimeReadContract(store: DurableWorkflowStore): void {
  const runResult = store.getRun("run-id");
  const runsResult = store.listRuns();

  // @ts-expect-error A read Result cannot be assigned to the nullable domain contract.
  const run: WorkflowRun | null = runResult;
  // @ts-expect-error A read Result has no WorkflowRun fields before explicit branching.
  const runId: string = runResult.runId;
  // @ts-expect-error A list Result has no array fields before explicit branching.
  const length: number = runsResult.length;
  void [run, runId, length];
}

void compileTimeReadContract;
void (false satisfies GetRunIsNotDomain | GetRunIsNotNullable | ListRunsIsNotArray);

it("keeps durable workflow reads as Result-only contracts", () => {
  expect(true).toBe(true);
});
