import fs from "node:fs/promises";
import path from "node:path";
import type { Result as ResultType } from "better-result";

import type {
  SubagentDelegationHandle,
  SubagentDelegationOutcome,
  SubagentDelegationRegistration,
  TrustedSubagentDelegationRegistration,
} from "../tools/subagent";
import type { ToolResultArtifactStore } from "../artifacts/tool-result-artifact-store";
import {
  DEFAULT_MAX_ACTIVE_WORKFLOW_RUNS,
  DurableWorkflowStore,
  signalDurableWorkflowReadErrorToHost,
  type CreateWorkflowInvocationError,
  type CreateWorkflowInvocationResult,
} from "./durable-workflow-store";
import {
  canonicalJsonSha256,
  sha256,
  validateWorkflowSource,
  validateWorkflowArgs,
  WORKFLOW_RUNTIME_VERSION,
} from "./workflow-definition";
import { WorkflowDefinitionStore } from "./workflow-definition-store";
import type { WorkflowCompletionTarget, WorkflowRevision, WorkflowRun } from "./workflow-domain";
import {
  adaptWorkflowArtifactResultToException,
  readWorkflowValueArtifact,
} from "./workflow-artifact-store";
import { resolveWorkflowSubagentToolResult } from "./workflow-subagent-output";

function adaptWorkflowInvocationResultToSubagentHost(
  result: ResultType<CreateWorkflowInvocationResult, CreateWorkflowInvocationError>,
): CreateWorkflowInvocationResult {
  if (result.status === "error") throw result.error;
  return result.value;
}

const GENERATED_WORKFLOW_NAME = "subagent-delegate";

function generatedSource(input: {
  profile: SubagentDelegationRegistration["profile"];
  model?: string;
  reasoning?: string;
  idleTimeoutMs: number;
}): string {
  const operationIdleTimeoutMs = Math.min(
    24 * 60 * 60 * 1_000,
    Math.max(1_000, Math.trunc(input.idleTimeoutMs)),
  );
  return `import { defineWorkflow } from "@lilac/workflow";

export default defineWorkflow({
  name: "${GENERATED_WORKFLOW_NAME}",
  description: "Generated one-agent delegation run",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["task", "profile"],
    properties: {
      task: { type: "string", minLength: 1 },
      profile: { type: "string", const: ${JSON.stringify(input.profile)} },
    },
  },
  resources: {
    agents: {
      maxConcurrent: 1,
      maxTotal: 1,
    },
    waits: [],
    maxNestingDepth: 1,
    operationIdleTimeoutMs: ${operationIdleTimeoutMs},
  },
  limits: {
    maxSourceBytes: 262144,
    maxInputBytes: 262144,
    maxOperationOutputBytes: 1048576,
    maxResultBytes: 1048576,
  },
  async run({ args, agent }) {
    return agent(args.task, {
      profile: args.profile,
      ${input.model ? `model: ${JSON.stringify(input.model)},` : ""}
      ${input.reasoning ? `reasoning: ${JSON.stringify(input.reasoning)},` : ""}
      label: "subagent " + args.profile,
    });
  },
});
`;
}

async function completionStatus(
  run: WorkflowRun,
  store: DurableWorkflowStore,
  dataDir: string,
  toolResultArtifacts?: ToolResultArtifactStore,
): Promise<SubagentDelegationOutcome> {
  if (run.state === "succeeded") {
    const revisionResult = store.getRevision(run.revisionId);
    if (revisionResult.status === "error")
      signalDurableWorkflowReadErrorToHost(revisionResult.error);
    const revision = revisionResult.value;
    if (!revision) throw new Error(`Subagent workflow revision disappeared: ${run.revisionId}`);
    let result = run.result;
    if (run.resultArtifactId) {
      const loaded = await readWorkflowValueArtifact({
        dataDir,
        artifactId: run.resultArtifactId,
        maxBytes: revision.limits.maxResultBytes,
      });
      result = adaptWorkflowArtifactResultToException(loaded);
    }
    const rawFinalText = typeof result === "string" ? result : JSON.stringify(result);
    const finalText =
      run.completionTarget.kind === "live_parent"
        ? await resolveWorkflowSubagentToolResult({
            finalText: rawFinalText,
            childSessionId: run.completionTarget.childSessionId,
            artifacts: toolResultArtifacts,
          })
        : rawFinalText;
    return { status: "resolved", finalText };
  }
  if (run.state === "cancelled") {
    return {
      status: "cancelled",
      finalText: "",
      detail: run.terminalDetail ?? "subagent cancelled",
    };
  }
  const operations = store.listOperations(run.runId, { limit: 1_000 });
  if (operations.status === "error") signalDurableWorkflowReadErrorToHost(operations.error);
  const timedOut = operations.value.some((operation) => operation.state === "timed_out");
  return {
    status: timedOut ? "timeout" : "failed",
    finalText: "",
    detail: run.terminalDetail ?? (timedOut ? "subagent timed out" : "subagent failed"),
  };
}

export class WorkflowSubagentDispatcher {
  private readonly definitionsStores = new Map<string, Promise<WorkflowDefinitionStore>>();

  private constructor(
    private readonly input: {
      store: DurableWorkflowStore;
      dataDir: string;
      toolResultArtifacts?: ToolResultArtifactStore;
      now?: () => number;
      pollMs?: number;
      getMaxActiveRuns?: () => number | Promise<number>;
      onRunCreated?: (run: WorkflowRun) => Promise<void>;
      onRunCancelled?: (run: WorkflowRun, previousState: WorkflowRun["state"]) => Promise<void>;
    },
  ) {}

  static create(input: {
    store: DurableWorkflowStore;
    dataDir: string;
    toolResultArtifacts?: ToolResultArtifactStore;
    now?: () => number;
    pollMs?: number;
    getMaxActiveRuns?: () => number | Promise<number>;
    onRunCreated?: (run: WorkflowRun) => Promise<void>;
    onRunCancelled?: (run: WorkflowRun, previousState: WorkflowRun["state"]) => Promise<void>;
  }): WorkflowSubagentDispatcher {
    return new WorkflowSubagentDispatcher(input);
  }

  private async definitions(projectRoot: string): Promise<WorkflowDefinitionStore> {
    const requestedRoot = path.resolve(projectRoot);
    const stats = await fs.lstat(requestedRoot);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Subagent workflow project root must be a real directory: ${requestedRoot}`);
    }
    const canonicalRoot = await fs.realpath(requestedRoot);
    let definitions = this.definitionsStores.get(canonicalRoot);
    if (!definitions) {
      definitions = WorkflowDefinitionStore.create({
        workspaceRoot: canonicalRoot,
        dataDir: this.input.dataDir,
      });
      this.definitionsStores.set(canonicalRoot, definitions);
      definitions.catch(() => this.definitionsStores.delete(canonicalRoot));
    }
    return await definitions;
  }

  async delegate(
    registration: TrustedSubagentDelegationRegistration,
  ): Promise<SubagentDelegationHandle> {
    const definitions = await this.definitions(registration.projectRoot);
    const now = this.input.now?.() ?? Date.now();
    const source = generatedSource({
      profile: registration.profile,
      ...(registration.modelOverride ? { model: registration.modelOverride } : {}),
      ...(registration.reasoningOverride ? { reasoning: registration.reasoningOverride } : {}),
      idleTimeoutMs: registration.idleTimeoutMs,
    });
    const validation = validateWorkflowSource({
      name: GENERATED_WORKFLOW_NAME,
      source,
    });
    const snapshot = await definitions.createSnapshot(source, validation.sourceSha256);
    const revisionId = `wfrev:subagent:${sha256(
      [
        definitions.canonicalProjectId,
        validation.sourceSha256,
        validation.inputSchemaSha256,
        validation.resourcePolicySha256,
        WORKFLOW_RUNTIME_VERSION,
      ].join(":"),
    ).slice(0, 48)}`;
    const revision: WorkflowRevision = {
      revisionId,
      canonicalProjectId: definitions.canonicalProjectId,
      canonicalWorkspaceRoot: definitions.canonicalWorkspaceRoot,
      scope: "project",
      normalizedPath: ".lilac/internal/subagent-delegate.js",
      name: GENERATED_WORKFLOW_NAME,
      snapshotArtifactId: snapshot.artifactId,
      sourceSha256: validation.sourceSha256,
      inputSchemaSha256: validation.inputSchemaSha256,
      resourcePolicySha256: validation.resourcePolicySha256,
      metadata: validation.metadata,
      inputSchema: validation.inputSchema,
      resources: validation.resources,
      limits: validation.limits,
      runtimeVersion: WORKFLOW_RUNTIME_VERSION,
      createdAt: now,
    };
    const args = validateWorkflowArgs({
      inputSchema: revision.inputSchema,
      args: { task: registration.task, profile: registration.profile },
      maxInputBytes: revision.limits.maxInputBytes,
    });
    const runId = `wfrun:subagent:${crypto.randomUUID()}`;
    const completionTarget: WorkflowCompletionTarget = {
      kind: "live_parent",
      parentRequestId: registration.parentRequestId,
      parentSessionId: registration.parentSessionId,
      parentRequestClient: registration.fallbackSurface.platform,
      parentToolCallId: registration.parentToolCallId,
      childRequestId: registration.childRequestId,
      childSessionId: registration.childSessionId,
      profile: registration.profile,
      sessionName: registration.sessionName,
      stableNamedContinuation: registration.stableNamedContinuation,
      depth: registration.depth,
      reasoning: registration.reasoningOverride ?? null,
      fallbackToSurface: false,
      fallbackProgressTarget: null,
      deferredDelivery: registration.mode === "deferred",
    };
    const requestedRun: WorkflowRun = {
      runId,
      revisionId,
      state: "queued",
      inputSchemaSnapshot: revision.inputSchema,
      args,
      argsSha256: canonicalJsonSha256(args),
      origin: {
        requestId: registration.parentRequestId,
        sessionId: registration.fallbackSurface.sessionId,
        client: registration.fallbackSurface.platform,
        userId: registration.fallbackSurface.userId,
        projectCwd: definitions.canonicalWorkspaceRoot,
      },
      completionTarget,
      progressTarget: null,
      terminalDetail: null,
      result: null,
      resultArtifactId: null,
      claimedBy: null,
      claimedAt: null,
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      terminalAt: null,
    };
    const invocation = adaptWorkflowInvocationResultToSubagentHost(
      this.input.store.createInvocation({
        revision,
        run: requestedRun,
        maxActiveRuns: (await this.input.getMaxActiveRuns?.()) ?? DEFAULT_MAX_ACTIVE_WORKFLOW_RUNS,
      }),
    );
    if (invocation.status === "rejected_capacity") {
      throw new Error(
        `Subagent delegation was not created because global workflow capacity is full (${invocation.activeRuns}/${invocation.limit} active runs); wait for a workflow to finish or cancel one, then retry`,
      );
    }
    const { run } = invocation;
    await this.input.onRunCreated?.(run);
    const waitForCompletion = () => this.waitForCompletion(runId, registration.mode === "sync");

    return {
      runId,
      get completion() {
        return waitForCompletion();
      },
      cancel: async (detail) => {
        const currentResult = this.input.store.getRun(runId);
        if (currentResult.status === "error")
          signalDurableWorkflowReadErrorToHost(currentResult.error);
        const current = currentResult.value;
        if (!current || ["succeeded", "failed", "cancelled"].includes(current.state)) {
          return;
        }
        const cancelled = this.input.store.cancelRunAndChildren({
          runId,
          now: this.input.now?.() ?? Date.now(),
          detail,
        });
        if (cancelled?.state === "cancelled") {
          await this.input.onRunCancelled?.(cancelled, current.state);
        }
      },
    };
  }

  private async waitForCompletion(
    runId: string,
    acknowledgeSynchronousDelivery: boolean,
  ): Promise<SubagentDelegationOutcome> {
    const initialRunResult = this.input.store.getRun(runId);
    if (initialRunResult.status === "error")
      signalDurableWorkflowReadErrorToHost(initialRunResult.error);
    const initialRun = initialRunResult.value;
    if (!initialRun) throw new Error(`Subagent workflow run disappeared: ${runId}`);
    const revisionResult = this.input.store.getRevision(initialRun.revisionId);
    if (revisionResult.status === "error")
      signalDurableWorkflowReadErrorToHost(revisionResult.error);
    const revision = revisionResult.value;
    if (!revision)
      throw new Error(`Subagent workflow revision disappeared: ${initialRun.revisionId}`);
    const preDispatchDeadline = initialRun.createdAt + revision.resources.operationIdleTimeoutMs;

    while (true) {
      const runResult = this.input.store.getRun(runId);
      if (runResult.status === "error") signalDurableWorkflowReadErrorToHost(runResult.error);
      const run = runResult.value;
      if (!run) throw new Error(`Subagent workflow run disappeared: ${runId}`);
      if (["succeeded", "failed", "cancelled"].includes(run.state)) {
        const completion = await completionStatus(
          run,
          this.input.store,
          this.input.dataDir,
          this.input.toolResultArtifacts,
        );
        if (acknowledgeSynchronousDelivery) {
          this.input.store.markLiveParentCompletionDelivered(
            runId,
            this.input.now?.() ?? Date.now(),
          );
        }
        return completion;
      }

      const operations = this.input.store.listOperations(runId, { limit: 1_000 });
      if (operations.status === "error") signalDurableWorkflowReadErrorToHost(operations.error);
      const hasDispatchedAgentOperation = operations.value.some(
        (operation) => operation.kind === "agent" && operation.state !== "queued",
      );
      if (
        !hasDispatchedAgentOperation &&
        (this.input.now?.() ?? Date.now()) >= preDispatchDeadline
      ) {
        const cancelled = this.input.store.cancelRunAndChildren({
          runId,
          now: this.input.now?.() ?? Date.now(),
          detail: "Subagent idle timeout before agent dispatch",
        });
        if (cancelled?.state === "cancelled") {
          await this.input.onRunCancelled?.(cancelled, run.state);
          return {
            status: "timeout",
            finalText: "",
            detail: "Subagent idle timeout before agent dispatch",
          };
        }
        continue;
      }
      await Bun.sleep(this.input.pollMs ?? 100);
    }
  }
}
