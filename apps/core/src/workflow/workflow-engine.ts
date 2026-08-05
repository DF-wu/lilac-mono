import fs from "node:fs/promises";
import path from "node:path";

import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";
import {
  type DecodedLilacMessageForTopic,
  type DeliveryDisposition,
  type EventDeliveryDoneError,
  type EventDeliveryStartFailed,
  type EventDeliveryStopFailed,
  type EventFetchContractInvalid,
  type EventFetchTransportFailed,
  lilacEventTypes,
  outReqTopic,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
import {
  createLogger,
  formatTaggedErrorForLog,
  isPanic,
  type DurableResolvedModelRequest,
} from "@stanley2058/lilac-utils";

import { adaptToolResultToHost, preserveToolPanic } from "../tools/tool-result-adapters";
import {
  DurableWorkflowStore,
  signalDurableWorkflowReadErrorToHost,
  type DurableWorkflowReadError,
  type WorkflowRequestTerminalReceipt,
} from "./durable-workflow-store";
import {
  canonicalJson,
  canonicalJsonSha256,
  sha256,
  validateWorkflowArgsUnchecked,
  WORKFLOW_RUNTIME_VERSION,
} from "./workflow-definition";
import {
  jsonValueSchema,
  type JsonValue,
  type WorkflowOperation,
  type WorkflowOperationState,
  type WorkflowRevision,
  type WorkflowRun,
  type WorkflowUsage,
  type WorkflowWait,
} from "./workflow-domain";
import {
  startWorkflowSandbox,
  type WorkflowSandboxCall,
  type WorkflowSandboxRun,
  type WorkflowSandboxTerminationFailed,
} from "./workflow-sandbox";
import { compileWorkflowSourceResult } from "./workflow-source-compiler";
import {
  adaptWorkflowArtifactResultToException,
  readWorkflowValueArtifact,
  WORKFLOW_INLINE_VALUE_BYTES,
  writeWorkflowValueArtifact,
} from "./workflow-artifact-store";
import {
  workflowRequestPolicyIdentityProjection,
  type WorkflowRequestPolicy,
} from "./workflow-request-authority";
import {
  resolveWorkflowAgentOperationInputResult,
  workflowPipelineOptionsSchema,
  workflowWaitForReplyOptionsSchema,
  type ResolvedWorkflowAgentInput,
  type WorkflowAgentOperationInputInvalid,
} from "./workflow-operation-policy";
import { formatWorkflowErrorForLog } from "./workflow-error-log";
import { adaptEventPublishResultToHost } from "../shared/event-bus-result";

const WORKFLOW_LEASE_STALE_MS = 60_000;
const WORKFLOW_LEASE_HEARTBEAT_MS = 20_000;
const WORKFLOW_REQUEST_LEASE_STALE_MS = 30_000;

type DecodedWorkflowCallInput =
  | { readonly kind: "agent"; readonly input: ResolvedWorkflowAgentInput }
  | { readonly kind: "phase"; readonly input: z.output<typeof phaseInputSchema> }
  | { readonly kind: "parallel"; readonly input: z.output<typeof parallelInputSchema> }
  | { readonly kind: "pipeline"; readonly input: z.output<typeof pipelineInputSchema> }
  | {
      readonly kind: "waitForReply";
      readonly input: z.output<typeof workflowWaitForReplyOptionsSchema>;
    }
  | { readonly kind: "sleep"; readonly input: z.output<typeof sleepInputSchema> };

class WorkflowCallInputInvalid extends TaggedError("WorkflowCallInputInvalid")<{
  readonly kind: WorkflowSandboxCall["kind"];
  readonly message: string;
}> {}

function decodeWorkflowCallInput(input: {
  readonly call: WorkflowSandboxCall;
  readonly canonicalWorkspaceRoot: string;
}): ResultType<
  DecodedWorkflowCallInput,
  WorkflowAgentOperationInputInvalid | WorkflowCallInputInvalid
> {
  if (input.call.kind === "agent") {
    const resolved = resolveWorkflowAgentOperationInputResult({
      value: input.call.input,
      canonicalWorkspaceRoot: input.canonicalWorkspaceRoot,
    });
    if (resolved.status === "error") return Result.err(resolved.error);
    return Result.ok({ kind: "agent", input: resolved.value });
  }
  const invalid = (message: string) =>
    Result.err(
      new WorkflowCallInputInvalid({
        kind: input.call.kind,
        message,
      }),
    );
  switch (input.call.kind) {
    case "phase": {
      const decoded = phaseInputSchema.safeParse(input.call.input);
      return decoded.success
        ? Result.ok({ kind: input.call.kind, input: decoded.data })
        : invalid(decoded.error.issues[0]?.message ?? "Workflow call input is invalid");
    }
    case "parallel": {
      const decoded = parallelInputSchema.safeParse(input.call.input);
      return decoded.success
        ? Result.ok({ kind: input.call.kind, input: decoded.data })
        : invalid(decoded.error.issues[0]?.message ?? "Workflow call input is invalid");
    }
    case "pipeline": {
      const decoded = pipelineInputSchema.safeParse(input.call.input);
      return decoded.success
        ? Result.ok({ kind: input.call.kind, input: decoded.data })
        : invalid(decoded.error.issues[0]?.message ?? "Workflow call input is invalid");
    }
    case "waitForReply": {
      const decoded = workflowWaitForReplyOptionsSchema.safeParse(input.call.input);
      return decoded.success
        ? Result.ok({ kind: input.call.kind, input: decoded.data })
        : invalid(decoded.error.issues[0]?.message ?? "Workflow call input is invalid");
    }
    case "sleep": {
      const decoded = sleepInputSchema.safeParse(input.call.input);
      return decoded.success
        ? Result.ok({ kind: input.call.kind, input: decoded.data })
        : invalid(decoded.error.issues[0]?.message ?? "Workflow call input is invalid");
    }
  }
}

async function cancelWorkflowSandboxForEngineHost(sandbox: WorkflowSandboxRun): Promise<void> {
  const cancelled: ResultType<void, WorkflowSandboxTerminationFailed> = await sandbox.cancel();
  adaptToolResultToHost(cancelled);
}

async function loadWorkflowValueArtifact(input: {
  readonly dataDir: string;
  readonly artifactId: string;
  readonly maxBytes: number;
}): Promise<JsonValue> {
  const loaded = await readWorkflowValueArtifact(input);
  return adaptWorkflowArtifactResultToException(loaded);
}

const phaseInputSchema = z.strictObject({ name: z.string().min(1).max(200) });
const parallelInputSchema = z.strictObject({
  count: z.number().int().nonnegative(),
});
const pipelineInputSchema = z.strictObject({
  items: z.array(jsonValueSchema).max(10_000),
  options: workflowPipelineOptionsSchema,
});
const sleepInputSchema = z.union([z.number().finite().nonnegative(), z.string().min(1).max(100)]);

type AgentRequestResult = {
  state: "resolved" | "failed" | "cancelled" | "timed_out";
  output: string;
  detail: string | null;
  usage: WorkflowUsage | null;
  source?: "receipt" | "terminal_receipt" | "terminal_without_receipt";
};

class WorkflowExecutionFailed extends TaggedError("WorkflowExecutionFailed")<{
  readonly message: string;
}> {}

type WorkflowExecutionResult<T> = ResultType<T, WorkflowExecutionFailed>;

function workflowExecutionFailure(message: string): WorkflowExecutionFailed {
  return new WorkflowExecutionFailed({ message });
}

function signalWorkflowExecutionFailureToHost(result: WorkflowExecutionResult<void>): void {
  adaptToolResultToHost(result);
}

async function captureWorkflowExternal<T>(
  operation: () => Promise<T>,
): Promise<WorkflowExecutionResult<T>> {
  const [settled] = await Promise.allSettled([operation()]);
  if (settled.status === "rejected") {
    if (isPanic(settled.reason)) preserveToolPanic(settled.reason);
    const cause =
      settled.reason instanceof Error
        ? settled.reason
        : new Error("Opaque workflow operation failure");
    return Result.err(workflowExecutionFailure(boundedError(cause)));
  }
  return Result.ok(settled.value);
}

type ResolvedAgentSelection = {
  model: string;
  reasoning: NonNullable<ResolvedWorkflowAgentInput["options"]["reasoning"]> | null;
  request: DurableResolvedModelRequest;
};

type DurableAgentFallback = NonNullable<DurableResolvedModelRequest["fallbacks"]>[number];

const TERMINAL_RECEIPT_WAIT_MS = 250;
const IDLE_CANCEL_QUIESCENCE_WAIT_MS = 10_000;

type ActiveRun = {
  controller: AbortController;
  sandbox: WorkflowSandboxRun;
  promise: Promise<void>;
  nextHeartbeatAt: number;
};

type WorkflowEventSubscription = {
  readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
  stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
};

export class WorkflowWakeDeliveryFailed extends TaggedError("WorkflowWakeDeliveryFailed")<{
  readonly message: string;
}> {}

export class WorkflowOutputDeliveryFailed extends TaggedError("WorkflowOutputDeliveryFailed")<{
  readonly message: string;
}> {}

export class WorkflowLifecycleDeliveryFailed extends TaggedError(
  "WorkflowLifecycleDeliveryFailed",
)<{
  readonly message: string;
}> {}

export type WorkflowEventDeliveryError =
  | WorkflowWakeDeliveryFailed
  | WorkflowOutputDeliveryFailed
  | WorkflowLifecycleDeliveryFailed;

export function applyWorkflowEventDeliveryPolicy(
  error: WorkflowEventDeliveryError,
): DeliveryDisposition {
  switch (error._tag) {
    case "WorkflowWakeDeliveryFailed":
    case "WorkflowOutputDeliveryFailed":
      return "park-pending";
    case "WorkflowLifecycleDeliveryFailed":
      return "stop";
  }
}

class WorkflowReconciliationFetchFailed extends TaggedError("WorkflowReconciliationFetchFailed")<{
  readonly kind: "transport" | "contract";
  readonly topic: string;
  readonly cursor?: string;
  readonly message: string;
}> {}

export class WorkflowTimerTickFailed extends TaggedError("WorkflowTimerTickFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

class WorkflowTerminalReceiptMissing extends TaggedError("WorkflowTerminalReceiptMissing")<{
  readonly requestId: string;
  readonly message: string;
}> {}

export class WorkflowTerminalReceiptAdoptionFailed extends TaggedError(
  "WorkflowTerminalReceiptAdoptionFailed",
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

class WorkflowTerminalReceiptReconciliationFailed extends TaggedError(
  "WorkflowTerminalReceiptReconciliationFailed",
)<{
  readonly message: string;
}> {}

class WorkflowIdleCancellationPublishFailed extends TaggedError(
  "WorkflowIdleCancellationPublishFailed",
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

function toWorkflowReconciliationFetchFailed(
  error: EventFetchContractInvalid | EventFetchTransportFailed,
): WorkflowReconciliationFetchFailed {
  switch (error._tag) {
    case "EventFetchTransportFailed":
      return new WorkflowReconciliationFetchFailed({
        kind: "transport",
        topic: error.topic,
        message: `Workflow reconciliation could not fetch ${error.topic}`,
      });
    case "EventFetchContractInvalid":
      return new WorkflowReconciliationFetchFailed({
        kind: "contract",
        topic: error.topic,
        cursor: error.cursor,
        message: `Workflow reconciliation rejected an invalid ${error.topic} event at ${error.cursor}`,
      });
  }
}

function toWorkflowTerminalReceiptReconciliationFailed(
  error: DurableWorkflowReadError,
): WorkflowTerminalReceiptReconciliationFailed {
  switch (error._tag) {
    case "UnsupportedVersion":
    case "MalformedSerialization":
    case "CorruptPersistedFields":
      return new WorkflowTerminalReceiptReconciliationFailed({
        message: `Workflow terminal receipt is corrupt: ${error.message}`,
      });
    case "DurableWorkflowSqliteDriverFailure":
      return new WorkflowTerminalReceiptReconciliationFailed({
        message: `Workflow terminal receipt could not be read: ${error.message}`,
      });
  }
}

function eventDeliveryDoneDetail(label: string, error: EventDeliveryDoneError): string {
  switch (error._tag) {
    case "EventDeliveryTransportFailed":
      return `${label} delivery failed during ${error.operation}`;
    case "EventDeliveryStopped":
      return `${label} delivery stopped: ${error.reason}`;
  }
}

function requireWorkflowEngineSubscriptionStart(
  started: ResultType<WorkflowEventSubscription, EventDeliveryStartFailed>,
): WorkflowEventSubscription {
  if (started.status === "error") throw started.error;
  return started.value;
}

export async function runWorkflowTimerTick(
  operation: () => Promise<void>,
): Promise<ResultType<void, WorkflowTimerTickFailed>> {
  try {
    await operation();
    return Result.ok(undefined);
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new WorkflowTimerTickFailed({
        cause,
        message: `Workflow timer tick failed: ${boundedError(cause)}`,
      }),
    );
  }
}

function fetchWorkflowTerminalReceipt(
  store: DurableWorkflowStore,
  requestId: string,
): ResultType<
  WorkflowRequestTerminalReceipt,
  WorkflowTerminalReceiptMissing | DurableWorkflowReadError
> {
  const receiptResult = store.getWorkflowRequestTerminalReceipt(requestId);
  if (receiptResult.status === "error") return Result.err(receiptResult.error);
  const receipt = receiptResult.value;
  if (receipt) return Result.ok(receipt);
  return Result.err(
    new WorkflowTerminalReceiptMissing({
      requestId,
      message: "Workflow prompt publication was rejected without a terminal receipt",
    }),
  );
}

export async function captureWorkflowTerminalReceiptAdoption<T>(
  adopt: () => Promise<T>,
): Promise<ResultType<T, WorkflowTerminalReceiptAdoptionFailed>> {
  try {
    return Result.ok(await adopt());
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new WorkflowTerminalReceiptAdoptionFailed({
        cause,
        message: `Workflow terminal receipt could not be adopted: ${boundedError(cause)}`,
      }),
    );
  }
}

export async function captureWorkflowIdleCancellationPublication(
  bus: LilacBus,
  input: {
    readonly requestId: string;
    readonly sessionId: string;
    readonly dispatchEpoch?: string;
  },
): Promise<ResultType<void, WorkflowIdleCancellationPublishFailed>> {
  const published = await bus.publish(
    lilacEventTypes.CmdRequestMessage,
    { queue: "interrupt", messages: [], raw: { cancel: true, cancelQueued: true } },
    {
      headers: {
        request_id: input.requestId,
        session_id: input.sessionId,
        request_client: "unknown",
        ...(input.dispatchEpoch ? { workflow_dispatch_epoch: input.dispatchEpoch } : {}),
      },
    },
  );
  if (published.status === "error") {
    return Result.err(
      new WorkflowIdleCancellationPublishFailed({
        cause: published.error,
        message: "Workflow idle cancellation publication failed",
      }),
    );
  }
  return Result.ok(undefined);
}

async function stopWorkflowEventSubscription(
  label: string,
  subscription: WorkflowEventSubscription,
): Promise<readonly string[]> {
  const failures: string[] = [];
  const stopped = await subscription.stop();
  if (stopped.status === "error") failures.push(`${label} stop failed: ${stopped.error.message}`);
  const done = await subscription.done;
  if (done.status === "error") failures.push(eventDeliveryDoneDetail(label, done.error));
  return failures;
}

function failedAgentRequest(detail: string): AgentRequestResult {
  return { state: "failed", output: "", detail, usage: null };
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

function isTerminalOperation(state: WorkflowOperationState): boolean {
  return ["succeeded", "failed", "cancelled", "timed_out"].includes(state);
}

function operationId(pathValue: string): string {
  return `wfop:${sha256(pathValue).slice(0, 40)}`;
}

export function workflowAgentRequestId(
  runId: string,
  operationIdValue: string,
  attempt: number,
): string {
  return `wfr:${sha256(runId).slice(0, 20)}:${operationIdValue.slice(-20)}:${attempt}`;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 16_384);
}

export class WorkflowEngine {
  private readonly logger = createLogger({ module: "workflow-engine" });
  private readonly workerId = `workflow-engine:${process.pid}:${crypto.randomUUID()}`;
  private readonly active = new Map<string, ActiveRun>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private wakeSubscription: WorkflowEventSubscription | null = null;
  private tickPromise: Promise<void> | null = null;

  constructor(
    private readonly input: {
      bus: LilacBus;
      store: DurableWorkflowStore;
      dataDir: string;
      subscriptionId: string;
      now?: () => number;
      pollMs?: number;
      runClaimHeartbeatMs?: number;
      receiptPollMs?: number;
      loadSnapshot?: (revision: WorkflowRevision) => Promise<string>;
      compileSource?: (source: string, sourceSha256: string) => string;
      beforePromptPublication?: (input: {
        requestId: string;
        runId: string;
        operationId: string;
        dispatchEpoch: string;
        runOwnerId: string;
      }) => Promise<void>;
      createDispatchEpoch?: () => string;
      reportFatalPanic?: (panic: Panic) => void;
      validateAgentSelection?: (input: {
        profile: "explore" | "general" | "self";
        model?: string;
        reasoning?: ResolvedWorkflowAgentInput["options"]["reasoning"];
      }) => void | ResolvedAgentSelection | Promise<void | ResolvedAgentSelection>;
      resolveAgentFallbacks?: (input: {
        profile: "explore" | "general" | "self";
        model?: string;
        reasoning?: ResolvedWorkflowAgentInput["options"]["reasoning"];
      }) => readonly DurableAgentFallback[] | Promise<readonly DurableAgentFallback[]>;
      dispatchAgentRequest?: (input: {
        run: WorkflowRun;
        revision: WorkflowRevision;
        operation: WorkflowOperation;
        prompt: string;
        profile: "explore" | "general" | "self";
        model?: string;
        reasoning?: ResolvedWorkflowAgentInput["options"]["reasoning"];
        policy: WorkflowRequestPolicy;
        requestId: string;
        agentCwd: string;
        signal: AbortSignal;
        reconcile: boolean;
        dispatchEpoch: string;
        sessionId: string;
        publishRequest: boolean;
      }) => Promise<AgentRequestResult>;
    },
  ) {}

  async start(): Promise<void> {
    this.stopping = false;
    this.wakeSubscription = requireWorkflowEngineSubscriptionStart(
      await this.startWakeSubscription(),
    );
    const runningRuns = this.input.store.listRuns({ state: "running", limit: 1_000 });
    if (runningRuns.status === "error") signalDurableWorkflowReadErrorToHost(runningRuns.error);
    for (const run of runningRuns.value) {
      await this.claimAndLaunch(run, WORKFLOW_LEASE_STALE_MS);
    }
    const blockedRuns = this.input.store.listRuns({ state: "blocked", limit: 1_000 });
    if (blockedRuns.status === "error") signalDurableWorkflowReadErrorToHost(blockedRuns.error);
    for (const run of blockedRuns.value) {
      if (this.input.store.getManualReconciliationDetail(run.runId)) continue;
      this.input.store.transitionRun({
        runId: run.runId,
        from: "blocked",
        to: "queued",
        now: this.now(),
        detail: "Replaying durable workflow wait after restart",
      });
    }
    await this.requestTick();
    this.timer = setInterval(() => {
      void runWorkflowTimerTick(() => this.requestTick()).then((tick) => {
        if (tick.status === "error") {
          this.logger.error("Workflow timer tick failed", {
            ...formatTaggedErrorForLog(tick.error),
          });
        }
      });
    }, this.input.pollMs ?? 250);
    this.timer.unref?.();
  }

  private startWakeSubscription(): Promise<
    ResultType<WorkflowEventSubscription, EventDeliveryStartFailed>
  > {
    return this.input.bus.subscribeTopic(
      "evt.workflow",
      {
        mode: "fanout",
        subscriptionId: this.input.subscriptionId,
        consumerId: `${this.input.subscriptionId}:${process.pid}`,
        offset: { type: "now" },
        batch: { maxWaitMs: 500 },
      },
      async (): Promise<ResultType<void, WorkflowWakeDeliveryFailed>> => {
        if (this.stopping) {
          return Result.err(
            new WorkflowWakeDeliveryFailed({
              message: "Workflow engine is stopping before the durable wake can be handled",
            }),
          );
        }
        await this.requestTick();
        return Result.ok(undefined);
      },
      applyWorkflowEventDeliveryPolicy,
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const failures: unknown[] = [];
    const subscription = this.wakeSubscription;
    this.wakeSubscription = null;
    if (subscription) {
      const settled = await Promise.allSettled([
        Promise.resolve().then(() => stopWorkflowEventSubscription("workflow wake", subscription)),
      ]);
      if (settled[0]?.status === "rejected") failures.push(settled[0].reason);
      if (settled[0]?.status === "fulfilled") failures.push(...settled[0].value);
    }
    if (this.tickPromise) {
      const settled = await Promise.allSettled([this.tickPromise]);
      if (settled[0]?.status === "rejected") failures.push(settled[0].reason);
    }
    const active = [...this.active.values()];
    for (const run of active) run.controller.abort("shutdown");
    const cancellations = await Promise.allSettled(
      [...this.active.entries()].flatMap(([runId, run]) => [
        Promise.resolve().then(() => cancelWorkflowSandboxForEngineHost(run.sandbox)),
        Promise.resolve().then(async () =>
          signalWorkflowExecutionFailureToHost(await this.stopAgentRequests(runId)),
        ),
      ]),
    );
    for (const cancellation of cancellations) {
      if (cancellation.status === "rejected") failures.push(cancellation.reason);
    }
    await Promise.allSettled(active.map((run) => run.promise));
    this.active.clear();
    if (failures.length > 0) {
      adaptToolResultToHost(
        Result.err(
          workflowExecutionFailure(
            `Workflow engine stop failed while cancelling active work: ${failures.map(boundedError).join("; ")}`,
          ),
        ),
      );
    }
  }

  private now(): number {
    return this.input.now?.() ?? Date.now();
  }

  private requestTick(): Promise<void> {
    this.tickPromise ??= this.tick().finally(() => {
      this.tickPromise = null;
    });
    return this.tickPromise;
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    const cancellations: Promise<void>[] = [];
    for (const [runId, active] of this.active) {
      const runResult = this.input.store.getRun(runId);
      if (runResult.status === "error") signalDurableWorkflowReadErrorToHost(runResult.error);
      const run = runResult.value;
      if (!run || run.state === "cancelled" || run.state === "paused") {
        active.controller.abort(run?.state ?? "run_missing");
        cancellations.push(
          Promise.resolve().then(() => cancelWorkflowSandboxForEngineHost(active.sandbox)),
          Promise.resolve().then(async () =>
            signalWorkflowExecutionFailureToHost(await this.stopAgentRequests(runId)),
          ),
        );
      } else if (run.state !== "running" || run.claimedBy !== this.workerId) {
        active.controller.abort("workflow lease lost");
        cancellations.push(
          Promise.resolve().then(() => cancelWorkflowSandboxForEngineHost(active.sandbox)),
        );
      } else {
        const now = this.now();
        if (now < active.nextHeartbeatAt) continue;
        if (!this.input.store.refreshRunClaim(runId, this.workerId, now)) {
          active.controller.abort("workflow lease lost");
          cancellations.push(
            Promise.resolve().then(() => cancelWorkflowSandboxForEngineHost(active.sandbox)),
          );
          continue;
        }
        active.nextHeartbeatAt =
          now + (this.input.runClaimHeartbeatMs ?? WORKFLOW_LEASE_HEARTBEAT_MS);
      }
    }
    const settledCancellations = await Promise.allSettled(cancellations);
    const cancellationFailures = settledCancellations
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (cancellationFailures.length > 0) {
      const error = new AggregateError(
        cancellationFailures,
        "One or more workflow cancellations failed",
      );
      this.logger.error(
        "Workflow cancellation reconciliation failed",
        formatWorkflowErrorForLog(error),
      );
    }
    const queuedRuns = this.input.store.listRuns({ state: "queued", limit: 1_000 });
    if (queuedRuns.status === "error") signalDurableWorkflowReadErrorToHost(queuedRuns.error);
    for (const run of queuedRuns.value) {
      await this.claimAndLaunch(run);
    }
  }

  private async claimAndLaunch(run: WorkflowRun, staleAfterMs?: number): Promise<void> {
    if (this.active.has(run.runId) || this.stopping) return;
    const claimedAt = this.now();
    const claimed = this.input.store.tryClaimRun({
      runId: run.runId,
      claimerId: this.workerId,
      now: claimedAt,
      staleAfterMs,
    });
    if (!claimed) return;
    const controller = new AbortController();
    const sandboxResult = await this.createSandbox(claimed, controller.signal);
    if (sandboxResult.status === "error") {
      signalWorkflowExecutionFailureToHost(
        await this.finishRun(claimed, "failed", null, sandboxResult.error.message),
      );
      return;
    }
    const sandbox = sandboxResult.value;
    const promise = this.runSandbox(claimed, sandbox, controller.signal)
      .catch((error: unknown) => {
        if (Panic.is(error)) {
          this.input.reportFatalPanic?.(error);
          return;
        }
        const failure =
          error instanceof Error ? error : new Error("Opaque workflow sandbox run failure");
        this.logger.error("Workflow sandbox run failed", {
          runId: claimed.runId,
          ...formatWorkflowErrorForLog(failure),
        });
      })
      .finally(() => {
        this.active.delete(claimed.runId);
      });
    this.active.set(claimed.runId, {
      controller,
      sandbox,
      promise,
      nextHeartbeatAt: claimedAt + (this.input.runClaimHeartbeatMs ?? WORKFLOW_LEASE_HEARTBEAT_MS),
    });
  }

  private async loadSnapshot(revision: WorkflowRevision): Promise<WorkflowExecutionResult<string>> {
    if (this.input.loadSnapshot)
      return await captureWorkflowExternal(() => this.input.loadSnapshot!(revision));
    const snapshotPath = path.join(
      this.input.dataDir,
      "workflow-snapshots",
      `${revision.sourceSha256}.js`,
    );
    const loaded = await captureWorkflowExternal(async () => {
      const stats = await fs.lstat(snapshotPath);
      const source = await fs.readFile(snapshotPath, "utf8");
      return { stats, source };
    });
    if (loaded.status === "error") return Result.err(loaded.error);
    if (!loaded.value.stats.isFile() || loaded.value.stats.isSymbolicLink()) {
      return Result.err(workflowExecutionFailure("Invalid workflow snapshot file"));
    }
    const source = loaded.value.source;
    if (sha256(source) !== revision.sourceSha256) {
      return Result.err(workflowExecutionFailure("Workflow snapshot hash mismatch"));
    }
    if (revision.snapshotArtifactId !== `workflow-source:${revision.sourceSha256}`) {
      return Result.err(workflowExecutionFailure("Workflow snapshot artifact identity mismatch"));
    }
    return Result.ok(source);
  }

  private async createSandbox(
    run: WorkflowRun,
    signal: AbortSignal,
  ): Promise<WorkflowExecutionResult<WorkflowSandboxRun>> {
    const revisionResult = this.input.store.getRevision(run.revisionId);
    if (revisionResult.status === "error") {
      return Result.err(workflowExecutionFailure(revisionResult.error.message));
    }
    const revision = revisionResult.value;
    if (!revision) {
      return Result.err(workflowExecutionFailure(`Workflow revision not found: ${run.revisionId}`));
    }
    const initialIntegrity = this.assertPersistedIntegrity(run, revision);
    if (initialIntegrity.status === "error") return Result.err(initialIntegrity.error);
    if (revision.runtimeVersion !== WORKFLOW_RUNTIME_VERSION) {
      return Result.err(
        workflowExecutionFailure(`Unsupported workflow runtime: ${revision.runtimeVersion}`),
      );
    }
    const source = await this.loadSnapshot(revision);
    if (source.status === "error") return Result.err(source.error);
    const finalIntegrity = this.assertPersistedIntegrity(run, revision);
    if (finalIntegrity.status === "error") return Result.err(finalIntegrity.error);
    let compiled: WorkflowExecutionResult<string>;
    if (this.input.compileSource) {
      compiled = await captureWorkflowExternal(() =>
        Promise.resolve(this.input.compileSource!(source.value, revision.sourceSha256)),
      );
    } else {
      const result = compileWorkflowSourceResult(source.value, revision.sourceSha256);
      compiled =
        result.status === "error"
          ? Result.err(workflowExecutionFailure(result.error.message))
          : Result.ok(result.value);
    }
    if (compiled.status === "error") return Result.err(compiled.error);
    const semaphore = new Semaphore(revision.resources.agents.maxConcurrent);
    const sandbox = await captureWorkflowExternal(() =>
      Promise.resolve(
        startWorkflowSandbox({
          source: compiled.value,
          args: run.args,
          signal,
          reportFatalPanic: this.input.reportFatalPanic,
          onCall: async (call) => {
            const handled = await this.handleCall(run.runId, revision, call, semaphore, signal);
            return handled;
          },
        }),
      ),
    );
    return sandbox;
  }

  private assertPersistedIntegrity(
    run: WorkflowRun,
    revision: WorkflowRevision,
  ): WorkflowExecutionResult<void> {
    if (revision.revisionId.startsWith("wfr:")) {
      const expectedRevisionId = `wfr:${canonicalJsonSha256({
        canonicalProjectId: revision.canonicalProjectId,
        canonicalWorkspaceRoot: revision.canonicalWorkspaceRoot,
        scope: revision.scope,
        normalizedPath: revision.normalizedPath,
        sourceSha256: revision.sourceSha256,
        inputSchemaSha256: revision.inputSchemaSha256,
        resourcePolicySha256: revision.resourcePolicySha256,
        runtimeVersion: revision.runtimeVersion,
      })}`;
      if (revision.revisionId !== expectedRevisionId) {
        return Result.err(
          workflowExecutionFailure("Persisted workflow revision identity hash mismatch"),
        );
      }
    }
    if (canonicalJsonSha256(revision.inputSchema) !== revision.inputSchemaSha256) {
      return Result.err(workflowExecutionFailure("Persisted workflow input schema hash mismatch"));
    }
    if (
      canonicalJsonSha256({ resources: revision.resources, limits: revision.limits }) !==
      revision.resourcePolicySha256
    ) {
      return Result.err(
        workflowExecutionFailure("Persisted workflow resource policy hash mismatch"),
      );
    }
    const args = validateWorkflowArgsUnchecked({
      inputSchema: revision.inputSchema,
      args: run.args,
      maxInputBytes: revision.limits.maxInputBytes,
    });
    if (args.status === "error") return Result.err(workflowExecutionFailure(args.error.message));
    if (
      canonicalJsonSha256(args.value) !== run.argsSha256 ||
      canonicalJsonSha256(run.inputSchemaSnapshot) !== revision.inputSchemaSha256
    ) {
      return Result.err(workflowExecutionFailure("Persisted workflow invocation hash mismatch"));
    }
    if (
      run.origin.projectCwd !== revision.canonicalWorkspaceRoot ||
      path.resolve(run.origin.projectCwd) !== revision.canonicalWorkspaceRoot
    ) {
      return Result.err(
        workflowExecutionFailure(
          "Persisted workflow project cwd does not match its approved revision",
        ),
      );
    }
    return Result.ok(undefined);
  }

  private async runSandbox(
    run: WorkflowRun,
    sandbox: WorkflowSandboxRun,
    signal: AbortSignal,
  ): Promise<void> {
    const fail = async (detail: string): Promise<void> => {
      if (this.stopping) return;
      const currentResult = this.input.store.getRun(run.runId);
      if (currentResult.status === "error")
        signalDurableWorkflowReadErrorToHost(currentResult.error);
      const current = currentResult.value;
      if (!current || current.state === "cancelled" || current.state === "paused") return;
      signalWorkflowExecutionFailureToHost(await this.finishRun(run, "failed", null, detail));
    };
    const started = await captureWorkflowExternal(() => this.publishRun(run, "running", "queued"));
    if (started.status === "error") return await fail(started.error.message);
    const sandboxResult = await sandbox.result;
    if (sandboxResult.status === "error") return await fail(sandboxResult.error.message);
    if (signal.aborted || this.stopping) return;
    const revisionResult = this.input.store.getRevision(run.revisionId);
    if (revisionResult.status === "error") return await fail(revisionResult.error.message);
    const revision = revisionResult.value;
    if (!revision) return await fail("Workflow revision disappeared");
    if (
      Buffer.byteLength(canonicalJson(sandboxResult.value), "utf8") > revision.limits.maxResultBytes
    ) {
      return await fail(`Workflow result exceeds ${revision.limits.maxResultBytes} bytes`);
    }
    signalWorkflowExecutionFailureToHost(
      await this.finishRun(run, "succeeded", sandboxResult.value, "Workflow completed"),
    );
  }

  private async handleCall(
    runId: string,
    revision: WorkflowRevision,
    call: WorkflowSandboxCall,
    semaphore: Semaphore,
    signal: AbortSignal,
  ): Promise<WorkflowExecutionResult<JsonValue>> {
    const runResult = this.input.store.getRun(runId);
    if (runResult.status === "error") {
      return Result.err(workflowExecutionFailure(runResult.error.message));
    }
    const run = runResult.value;
    if (!run || run.state !== "running" || run.claimedBy !== this.workerId || signal.aborted)
      return Result.err(workflowExecutionFailure("Workflow is not running"));
    if (call.depth > revision.resources.maxNestingDepth) {
      return Result.err(
        workflowExecutionFailure(`Workflow nesting exceeds ${revision.resources.maxNestingDepth}`),
      );
    }
    const id = operationId(call.path);
    const parentOperationId = call.parentPath ? operationId(call.parentPath) : null;
    const decodedCallResult = decodeWorkflowCallInput({
      call,
      canonicalWorkspaceRoot: revision.canonicalWorkspaceRoot,
    });
    if (decodedCallResult.status === "error") {
      return Result.err(workflowExecutionFailure(decodedCallResult.error.message));
    }
    const decodedCall = decodedCallResult.value;
    const input = decodedCall.input;
    const inputSha256 = canonicalJsonSha256(input);
    const persistedKind =
      call.kind === "waitForReply" || call.kind === "sleep" ? "wait" : call.kind;
    const existingResult = this.input.store.getOperation(runId, id);
    if (existingResult.status === "error") {
      return Result.err(workflowExecutionFailure(existingResult.error.message));
    }
    const existing = existingResult.value;
    if (existing) {
      if (
        existing.callSiteId !== call.callSiteId ||
        existing.kind !== persistedKind ||
        existing.inputSha256 !== inputSha256
      ) {
        return Result.err(
          workflowExecutionFailure(`Workflow replay diverged at ${call.callSiteId}`),
        );
      }
      if (existing.state === "succeeded") {
        if (existing.resultArtifactId) {
          const loaded = await readWorkflowValueArtifact({
            dataDir: this.input.dataDir,
            artifactId: existing.resultArtifactId,
            maxBytes: revision.limits.maxOperationOutputBytes,
          });
          return loaded.status === "error"
            ? Result.err(workflowExecutionFailure(loaded.error.message))
            : Result.ok(loaded.value);
        }
        return Result.ok(existing.output);
      }
      if (isTerminalOperation(existing.state)) {
        return Result.err(
          workflowExecutionFailure(existing.error ?? `Cached operation ${existing.state}`),
        );
      }
      if (decodedCall.kind === "waitForReply" || decodedCall.kind === "sleep") {
        return await this.waitDurably(run, revision, existing, decodedCall, signal);
      }
      if (decodedCall.kind === "agent") {
        return await semaphore.use(() =>
          this.dispatchAgentSafely(run, revision, existing, decodedCall.input, signal, true),
        );
      }
      return await this.completeStructuralOperation(run, revision, existing);
    }

    if (decodedCall.kind === "agent") {
      if (this.input.store.countOperations(runId, "agent") >= revision.resources.agents.maxTotal) {
        return Result.err(
          workflowExecutionFailure(
            `Workflow agent total exceeds ${revision.resources.agents.maxTotal}`,
          ),
        );
      }
      const options = decodedCall.input.options;
      if (this.input.validateAgentSelection) {
        const validated = await captureWorkflowExternal(() =>
          Promise.resolve(
            this.input.validateAgentSelection!({
              profile: options.profile,
              ...(options.model ? { model: options.model } : {}),
              ...(options.reasoning ? { reasoning: options.reasoning } : {}),
            }),
          ),
        );
        if (validated.status === "error") return Result.err(validated.error);
      }
    }
    let parsedLabel: string | null;
    switch (decodedCall.kind) {
      case "agent":
        parsedLabel = decodedCall.input.options.label ?? null;
        break;
      case "waitForReply":
        parsedLabel = decodedCall.input.prompt ?? "Waiting for reply";
        break;
      case "sleep":
        parsedLabel = "Sleeping";
        break;
      case "parallel":
      case "pipeline":
      case "phase":
        parsedLabel = null;
        break;
    }
    const operation: WorkflowOperation = {
      runId,
      operationId: id,
      callSiteId: call.callSiteId,
      parentOperationId,
      phase: call.phase,
      label: parsedLabel,
      kind: persistedKind,
      input,
      inputSha256,
      state: "queued",
      attempt: 0,
      requestId: null,
      output: null,
      resultArtifactId: null,
      error: null,
      usage: null,
      claimedBy: null,
      claimedAt: null,
      createdAt: this.now(),
      startedAt: null,
      updatedAt: this.now(),
      terminalAt: null,
    };
    if (!this.input.store.createOperation(operation, this.workerId)) {
      return Result.err(workflowExecutionFailure(`Failed to journal workflow operation ${id}`));
    }
    const published = await captureWorkflowExternal(() =>
      this.publishOperation(revision, operation, "queued"),
    );
    if (published.status === "error") return Result.err(published.error);
    if (decodedCall.kind === "waitForReply" || decodedCall.kind === "sleep") {
      return await this.waitDurably(run, revision, operation, decodedCall, signal);
    }
    if (decodedCall.kind === "agent") {
      return await semaphore.use(() =>
        this.dispatchAgentSafely(run, revision, operation, decodedCall.input, signal, false),
      );
    }
    return await this.completeStructuralOperation(run, revision, operation);
  }

  private async waitDurably(
    run: WorkflowRun,
    revision: WorkflowRevision,
    operation: WorkflowOperation,
    call: Extract<DecodedWorkflowCallInput, { readonly kind: "waitForReply" | "sleep" }>,
    signal: AbortSignal,
  ): Promise<WorkflowExecutionResult<JsonValue>> {
    const waitKind = call.kind === "waitForReply" ? "reply" : "sleep";
    if (!revision.resources.waits.includes(waitKind)) {
      return Result.err(
        workflowExecutionFailure(`Workflow wait is not enabled by resource policy: ${waitKind}`),
      );
    }
    const now = this.now();
    const operationCreatedAt = operation.createdAt;
    const initialWait = this.input.store.getWait(run.runId, operation.operationId);
    if (initialWait.status === "error") {
      return Result.err(workflowExecutionFailure(initialWait.error.message));
    }
    let wait: WorkflowWait | null = initialWait.value;
    if (!wait) {
      if (call.kind === "waitForReply") {
        const options = call.input;
        const platform = options.platform ?? run.origin.client;
        const channelId = options.channelId ?? run.origin.sessionId;
        if (!platform || !channelId) {
          return Result.err(
            workflowExecutionFailure(
              "waitForReply requires a platform and channelId or an originating session",
            ),
          );
        }
        if (
          platform !== "discord" ||
          platform !== run.origin.client ||
          channelId !== run.origin.sessionId ||
          !run.origin.userId ||
          (options.fromUserId !== undefined && options.fromUserId !== run.origin.userId)
        ) {
          return Result.err(
            workflowExecutionFailure(
              "waitForReply is limited to the authenticated originating Discord session and user",
            ),
          );
        }
        wait = {
          runId: run.runId,
          operationId: operation.operationId,
          state: "pending",
          match: {
            kind: "reply",
            platform,
            channelId,
            messageId: options.messageId ?? null,
            fromUserId: options.fromUserId ?? run.origin.userId,
          },
          matchKey: `${platform}:${channelId}`,
          dueAt: null,
          deadlineAt:
            options.timeoutMs === undefined ? null : operationCreatedAt + options.timeoutMs,
          resolverCursor: null,
          result: null,
          resolvedBy: null,
          claimedBy: null,
          claimedAt: null,
          createdAt: now,
          updatedAt: now,
          resolvedAt: null,
        };
      } else {
        const value = call.input;
        const parsedTimestamp = typeof value === "string" ? Date.parse(value) : null;
        if (typeof value === "string" && !Number.isFinite(parsedTimestamp)) {
          return Result.err(workflowExecutionFailure(`Invalid sleep timestamp: ${value}`));
        }
        let dueAt: number;
        if (typeof value === "string") {
          dueAt = parsedTimestamp ?? now;
        } else if (value >= 100_000_000_000) {
          dueAt = Math.trunc(value);
        } else {
          dueAt = operationCreatedAt + Math.trunc(value);
        }
        wait = {
          runId: run.runId,
          operationId: operation.operationId,
          state: "pending",
          match: { kind: "sleep" },
          matchKey: `sleep:${dueAt}`,
          dueAt,
          deadlineAt: null,
          resolverCursor: null,
          result: null,
          resolvedBy: null,
          claimedBy: null,
          claimedAt: null,
          createdAt: now,
          updatedAt: now,
          resolvedAt: null,
        };
      }
      if (!this.input.store.createWait(wait, this.workerId)) {
        const concurrentlyCreatedResult = this.input.store.getWait(
          run.runId,
          operation.operationId,
        );
        if (concurrentlyCreatedResult.status === "error") {
          return Result.err(workflowExecutionFailure(concurrentlyCreatedResult.error.message));
        }
        const concurrentlyCreated = concurrentlyCreatedResult.value;
        if (!concurrentlyCreated) {
          return Result.err(
            workflowExecutionFailure(`Failed to journal workflow wait ${operation.operationId}`),
          );
        }
        wait = concurrentlyCreated;
      }
    } else if (
      (call.kind === "waitForReply" && wait.match.kind !== "reply") ||
      (call.kind === "sleep" && wait.match.kind !== "sleep")
    ) {
      return Result.err(
        workflowExecutionFailure(`Workflow wait replay diverged at ${operation.callSiteId}`),
      );
    }

    const initialOperation = this.input.store.getOperation(run.runId, operation.operationId);
    if (initialOperation.status === "error") {
      return Result.err(workflowExecutionFailure(initialOperation.error.message));
    }
    let current = initialOperation.value ?? operation;
    for (const next of ["dispatched", "running", "blocked"] as const) {
      if (
        (next === "dispatched" && current.state !== "queued") ||
        (next === "running" && current.state !== "dispatched") ||
        (next === "blocked" && current.state !== "running")
      ) {
        continue;
      }
      this.input.store.transitionOperation({
        runOwnerId: this.workerId,
        runId: run.runId,
        operationId: operation.operationId,
        from: current.state,
        to: next,
        now: this.now(),
      });
      const published = await captureWorkflowExternal(() =>
        this.publishOperation(revision, operation, next, current.state),
      );
      if (published.status === "error") return Result.err(published.error);
      const transitionedOperation = this.input.store.getOperation(run.runId, operation.operationId);
      if (transitionedOperation.status === "error") {
        return Result.err(workflowExecutionFailure(transitionedOperation.error.message));
      }
      current = transitionedOperation.value ?? current;
    }
    while (!signal.aborted) {
      const waitResult = this.input.store.getWait(run.runId, operation.operationId);
      if (waitResult.status === "error") {
        return Result.err(workflowExecutionFailure(waitResult.error.message));
      }
      wait = waitResult.value;
      if (!wait) return Result.err(workflowExecutionFailure("Durable workflow wait disappeared"));
      if (wait.state === "resolved" || wait.state === "expired" || wait.state === "cancelled") {
        const latestResult = this.input.store.getOperation(run.runId, operation.operationId);
        if (latestResult.status === "error") {
          return Result.err(workflowExecutionFailure(latestResult.error.message));
        }
        const latest = latestResult.value;
        if (wait.state === "resolved") {
          if (latest?.state === "blocked") {
            this.input.store.transitionOperation({
              runOwnerId: this.workerId,
              runId: run.runId,
              operationId: operation.operationId,
              from: "blocked",
              to: "succeeded",
              now: this.now(),
              output: wait.result,
            });
            const published = await captureWorkflowExternal(() =>
              this.publishOperation(revision, operation, "succeeded", "blocked"),
            );
            if (published.status === "error") return Result.err(published.error);
          }
          return Result.ok(wait.result);
        }
        if (latest?.state === "blocked") {
          const terminalState = wait.state === "expired" ? "timed_out" : "cancelled";
          this.input.store.transitionOperation({
            runOwnerId: this.workerId,
            runId: run.runId,
            operationId: operation.operationId,
            from: "blocked",
            to: terminalState,
            now: this.now(),
            error: wait.state === "expired" ? "Reply wait timed out" : "Wait cancelled",
          });
          const published = await captureWorkflowExternal(() =>
            this.publishOperation(revision, operation, terminalState, "blocked"),
          );
          if (published.status === "error") return Result.err(published.error);
        }
        return Result.err(
          workflowExecutionFailure(
            wait.state === "expired" ? "Reply wait timed out" : "Wait cancelled",
          ),
        );
      }
      await Bun.sleep(this.input.pollMs ?? 250);
    }
    return Result.err(workflowExecutionFailure("Workflow wait interrupted"));
  }

  private async completeStructuralOperation(
    run: WorkflowRun,
    revision: WorkflowRevision,
    operation: WorkflowOperation,
  ): Promise<WorkflowExecutionResult<JsonValue>> {
    let current = operation;
    let transitions: WorkflowOperationState[];
    switch (current.state) {
      case "queued":
        transitions = ["dispatched", "running", "succeeded"];
        break;
      case "dispatched":
        transitions = ["running", "succeeded"];
        break;
      case "running":
        transitions = ["succeeded"];
        break;
      case "blocked":
      case "succeeded":
      case "failed":
      case "cancelled":
      case "timed_out":
        transitions = [];
        break;
    }
    for (const to of transitions) {
      const changed = this.input.store.transitionOperation({
        runOwnerId: this.workerId,
        runId: run.runId,
        operationId: operation.operationId,
        from: current.state,
        to,
        now: this.now(),
        output: to === "succeeded" ? null : undefined,
      });
      if (!changed) {
        return Result.err(
          workflowExecutionFailure(`Failed structural operation transition to ${to}`),
        );
      }
      const published = await captureWorkflowExternal(() =>
        this.publishOperation(revision, operation, to, current.state),
      );
      if (published.status === "error") return Result.err(published.error);
      const updated = this.input.store.getOperation(run.runId, operation.operationId);
      if (updated.status === "error") {
        return Result.err(workflowExecutionFailure(updated.error.message));
      }
      current = updated.value ?? current;
    }
    return Result.ok(null);
  }

  private async dispatchAgent(
    run: WorkflowRun,
    revision: WorkflowRevision,
    operation: WorkflowOperation,
    input: ResolvedWorkflowAgentInput,
    signal: AbortSignal,
    reconcile: boolean,
  ): Promise<WorkflowExecutionResult<JsonValue>> {
    const { profile, model, reasoning } = input.options;
    const expectedRequestId = workflowAgentRequestId(
      run.runId,
      operation.operationId,
      operation.attempt,
    );
    if (operation.requestId && operation.requestId !== expectedRequestId) {
      return Result.err(
        workflowExecutionFailure("Persisted workflow operation request ID is not deterministic"),
      );
    }
    const reqId = expectedRequestId;
    const currentResult = this.input.store.getOperation(run.runId, operation.operationId);
    if (currentResult.status === "error") {
      return Result.err(workflowExecutionFailure(currentResult.error.message));
    }
    let current = currentResult.value ?? operation;
    const sessionId =
      run.completionTarget.kind === "live_parent"
        ? run.completionTarget.childSessionId
        : `workflow:${run.runId}:${operation.operationId}`;
    let adoptedTerminalReceipt = false;
    let ambiguousTerminalResult = false;
    const adoptReceipt = async (
      receipt: WorkflowRequestTerminalReceipt,
    ): Promise<WorkflowExecutionResult<AgentRequestResult>> => {
      if (
        receipt.requestId !== reqId ||
        receipt.runId !== run.runId ||
        receipt.operationId !== operation.operationId ||
        current.requestId !== reqId
      ) {
        return Result.err(
          workflowExecutionFailure(
            "Workflow terminal receipt does not match its deterministic operation",
          ),
        );
      }
      adoptedTerminalReceipt = true;
      return await captureWorkflowExternal(() => this.adoptTerminalReceipt(receipt, revision));
    };
    let result: AgentRequestResult;
    const handoffResult = await captureWorkflowExternal(() =>
      Promise.resolve(
        this.input.store.getWorkflowRequestDispatchHandoff({
          requestId: reqId,
          now: this.now(),
          staleAfterMs: WORKFLOW_REQUEST_LEASE_STALE_MS,
        }),
      ),
    );
    if (handoffResult.status === "error") return Result.err(handoffResult.error);
    const handoff = handoffResult.value;
    if (handoff.status === "receipt") {
      const adopted = await adoptReceipt(handoff.receipt);
      if (adopted.status === "error") return Result.err(adopted.error);
      result = adopted.value;
    } else {
      const agentCwd = input.options.cwd;
      const liveOwner = reconcile && handoff.status === "live";
      const selectionInput = {
        profile,
        ...(model ? { model } : {}),
        ...(reasoning ? { reasoning } : {}),
      };
      let currentSelection: void | ResolvedAgentSelection | undefined;
      if (handoff.status === "fresh" && this.input.validateAgentSelection) {
        const selected = await captureWorkflowExternal(() =>
          Promise.resolve(this.input.validateAgentSelection!(selectionInput)),
        );
        if (selected.status === "error") return Result.err(selected.error);
        currentSelection = selected.value;
      }
      let currentFallbacks: readonly DurableAgentFallback[] | undefined;
      if (handoff.status === "stale" && this.input.resolveAgentFallbacks) {
        const fallbacks = await captureWorkflowExternal(() =>
          Promise.resolve(this.input.resolveAgentFallbacks!(selectionInput)),
        );
        if (fallbacks.status === "error") return Result.err(fallbacks.error);
        currentFallbacks = fallbacks.value;
      }
      const currentConcreteSelection = currentSelection ?? {
        model: model ?? `profile-native:${profile}`,
        reasoning: reasoning ?? null,
        request: {
          spec: model ?? `profile-native:${profile}`,
          provider: "unresolved",
          modelId: model ?? `profile-native:${profile}`,
          ...(reasoning ? { reasoning } : {}),
          reasoningDisplay: "simple",
        },
      };
      let concreteSelection: ResolvedAgentSelection;
      switch (handoff.status) {
        case "live":
          concreteSelection = {
            model: handoff.policy.resolvedModelRequest.spec,
            reasoning: handoff.policy.resolvedModelRequest.reasoning ?? null,
            request: handoff.policy.resolvedModelRequest,
          };
          break;
        case "stale":
          concreteSelection = {
            model: handoff.policy.resolvedModelRequest.spec,
            reasoning: handoff.policy.resolvedModelRequest.reasoning ?? null,
            request: {
              ...handoff.policy.resolvedModelRequest,
              fallbacks: [...(currentFallbacks ?? [])],
            },
          };
          break;
        case "fresh":
          concreteSelection = currentConcreteSelection;
          break;
      }
      const dispatchEpoch = liveOwner
        ? handoff.dispatchEpoch
        : (this.input.createDispatchEpoch?.() ?? crypto.randomUUID());
      const newlyResolvedPolicy = {
        runId: run.runId,
        operationId: operation.operationId,
        dispatchEpoch,
        profile,
        model: model ?? null,
        reasoning: reasoning ?? null,
        resolvedModelRequest: concreteSelection.request,
        cwd: agentCwd,
        originSession: {
          requestId: run.origin.requestId,
          sessionId: run.origin.sessionId,
          client: run.origin.client,
          userId: run.origin.userId,
        },
        ...(run.completionTarget.kind === "live_parent" &&
        run.completionTarget.stableNamedContinuation === true
          ? {
              stableNamedContinuation: {
                sessionId: run.completionTarget.childSessionId,
                requestClient: run.completionTarget.parentRequestClient,
              },
            }
          : {}),
      } satisfies WorkflowRequestPolicy;
      let policy: WorkflowRequestPolicy;
      switch (handoff.status) {
        case "live":
          policy = { ...handoff.policy, dispatchEpoch };
          break;
        case "stale":
          policy = {
            ...handoff.policy,
            dispatchEpoch,
            resolvedModelRequest: concreteSelection.request,
          };
          break;
        case "fresh":
          policy = newlyResolvedPolicy;
          break;
      }
      if (
        handoff.status === "live" &&
        canonicalJson(workflowRequestPolicyIdentityProjection(policy)) !==
          canonicalJson(workflowRequestPolicyIdentityProjection(handoff.policy))
      ) {
        return Result.err(
          workflowExecutionFailure(
            "Live workflow dispatch policy diverged from its durable operation identity",
          ),
        );
      }
      let racedReceipt: WorkflowRequestTerminalReceipt | null = null;
      if (!liveOwner) {
        const dispatched = this.input.store.authorizeAgentDispatch({
          requestId: reqId,
          runId: run.runId,
          operationId: operation.operationId,
          runOwnerId: this.workerId,
          sessionId,
          platform: "unknown",
          policy,
          now: this.now(),
          staleOwnerBefore: this.now() - WORKFLOW_REQUEST_LEASE_STALE_MS,
        });
        if (!dispatched) {
          const racedReceiptResult = this.input.store.getWorkflowRequestTerminalReceipt(reqId);
          if (racedReceiptResult.status === "error") {
            return Result.err(workflowExecutionFailure(racedReceiptResult.error.message));
          }
          racedReceipt = racedReceiptResult.value;
          if (!racedReceipt) {
            return Result.err(
              workflowExecutionFailure("Workflow dispatch authorization was rejected"),
            );
          }
        }
      }
      if (racedReceipt) {
        const adopted = await adoptReceipt(racedReceipt);
        if (adopted.status === "error") return Result.err(adopted.error);
        result = adopted.value;
      } else {
        if (current.state === "queued") {
          const published = await captureWorkflowExternal(() =>
            this.publishOperation(revision, operation, "dispatched", "queued"),
          );
          if (published.status === "error") return Result.err(published.error);
          const dispatchedOperation = this.input.store.getOperation(
            run.runId,
            operation.operationId,
          );
          if (dispatchedOperation.status === "error") {
            return Result.err(workflowExecutionFailure(dispatchedOperation.error.message));
          }
          current = dispatchedOperation.value ?? current;
        }
        const request = {
          run,
          revision,
          operation: current,
          prompt: input.prompt,
          profile,
          model,
          reasoning,
          policy,
          requestId: reqId,
          agentCwd,
          signal,
          reconcile,
          dispatchEpoch,
          sessionId,
          publishRequest: !liveOwner,
        };
        const requested = await captureWorkflowExternal(() =>
          this.input.dispatchAgentRequest
            ? this.input.dispatchAgentRequest(request)
            : this.waitForAgentRequest(request),
        );
        if (requested.status === "error") return Result.err(requested.error);
        result = requested.value;
      }
      adoptedTerminalReceipt ||=
        result.source === "receipt" || result.source === "terminal_receipt";
      if (
        result.source === "terminal_without_receipt" ||
        (result.source === "terminal_receipt" && result.state === "cancelled")
      ) {
        ambiguousTerminalResult = true;
        this.input.store.blockAmbiguousTerminalLifecycleOperation({
          runId: run.runId,
          operationId: operation.operationId,
          requestId: reqId,
          runOwnerId: this.workerId,
          now: this.now(),
        });
      } else if (
        adoptedTerminalReceipt &&
        result.state === "cancelled" &&
        this.input.store.blockAmbiguousPausedCancelledOperation({
          runId: run.runId,
          operationId: operation.operationId,
          requestId: reqId,
          runOwnerId: this.workerId,
          now: this.now(),
        })
      ) {
        ambiguousTerminalResult = true;
      }
    }
    if (
      ambiguousTerminalResult ||
      (adoptedTerminalReceipt &&
        result.state === "cancelled" &&
        this.input.store.blockAmbiguousPausedCancelledOperation({
          runId: run.runId,
          operationId: operation.operationId,
          requestId: reqId,
          runOwnerId: this.workerId,
          now: this.now(),
        }))
    ) {
      return Result.err(
        workflowExecutionFailure(
          "Workflow terminal lifecycle is ambiguous and requires manual reconciliation",
        ),
      );
    }
    const latestResult = this.input.store.getOperation(run.runId, operation.operationId);
    if (latestResult.status === "error") {
      return Result.err(workflowExecutionFailure(latestResult.error.message));
    }
    let latest = latestResult.value;
    if (this.stopping) {
      return Result.err(workflowExecutionFailure("Workflow engine stopped for durable recovery"));
    }
    const currentRunResult = this.input.store.getRun(run.runId);
    if (currentRunResult.status === "error") {
      return Result.err(workflowExecutionFailure(currentRunResult.error.message));
    }
    const currentRun = currentRunResult.value;
    if (signal.aborted && currentRun?.state === "paused") {
      return Result.err(workflowExecutionFailure("Workflow operation paused for durable replay"));
    }
    if (currentRun?.claimedBy !== this.workerId) {
      return Result.err(
        workflowExecutionFailure("Workflow operation lease was lost before completion"),
      );
    }
    if (!latest || isTerminalOperation(latest.state)) {
      if (latest?.state === "succeeded") return Result.ok(latest.output);
      return Result.err(workflowExecutionFailure(latest?.error ?? "Agent operation ended"));
    }
    if (latest.state === "queued" && adoptedTerminalReceipt) {
      const transitioned = this.input.store.transitionOperation({
        runOwnerId: this.workerId,
        runId: run.runId,
        operationId: operation.operationId,
        from: "queued",
        to: "dispatched",
        now: this.now(),
      });
      if (!transitioned) {
        return Result.err(
          workflowExecutionFailure("Receipt-backed operation could not resume its journal"),
        );
      }
      const published = await captureWorkflowExternal(() =>
        this.publishOperation(revision, operation, "dispatched", "queued"),
      );
      if (published.status === "error") return Result.err(published.error);
      const dispatched = this.input.store.getOperation(run.runId, operation.operationId);
      if (dispatched.status === "error") {
        return Result.err(workflowExecutionFailure(dispatched.error.message));
      }
      latest = dispatched.value ?? latest;
    }
    let nextState: "succeeded" | "failed" | "cancelled" | "timed_out";
    switch (result.state) {
      case "resolved":
        nextState = "succeeded";
        break;
      case "failed":
        nextState = "failed";
        break;
      case "cancelled":
        nextState = "cancelled";
        break;
      case "timed_out":
        nextState = "timed_out";
        break;
    }
    if (result.state === "resolved" && !result.output) {
      return Result.err(
        workflowExecutionFailure("Agent request resolved without captured final output"),
      );
    }
    const outputBytes = Buffer.byteLength(canonicalJson(result.output), "utf8");
    if (outputBytes > revision.limits.maxOperationOutputBytes) {
      return Result.err(
        workflowExecutionFailure(
          `Agent output exceeds ${revision.limits.maxOperationOutputBytes} bytes`,
        ),
      );
    }
    let resultArtifactId: string | null = null;
    if (result.state === "resolved" && outputBytes > WORKFLOW_INLINE_VALUE_BYTES) {
      const persisted = await writeWorkflowValueArtifact({
        dataDir: this.input.dataDir,
        value: result.output,
        maxBytes: revision.limits.maxOperationOutputBytes,
      });
      if (persisted.status === "error") {
        return Result.err(workflowExecutionFailure(persisted.error.message));
      }
      resultArtifactId = persisted.value;
    }
    if (latest.state === "dispatched" && result.state === "resolved") {
      this.input.store.transitionOperation({
        runOwnerId: this.workerId,
        runId: run.runId,
        operationId: operation.operationId,
        from: "dispatched",
        to: "running",
        now: this.now(),
      });
      const published = await captureWorkflowExternal(() =>
        this.publishOperation(revision, operation, "running", "dispatched"),
      );
      if (published.status === "error") return Result.err(published.error);
    }
    const terminalOperation = this.input.store.getOperation(run.runId, operation.operationId);
    if (terminalOperation.status === "error") {
      return Result.err(workflowExecutionFailure(terminalOperation.error.message));
    }
    const terminalFrom = terminalOperation.value?.state ?? latest.state;
    const terminalized = this.input.store.terminalizeOperationAndExpireRequest({
      runOwnerId: this.workerId,
      runId: run.runId,
      operationId: operation.operationId,
      requestId: reqId,
      from: terminalFrom,
      to: nextState,
      now: this.now(),
      output: resultArtifactId ? null : result.output || null,
      resultArtifactId,
      error: result.state === "resolved" ? null : (result.detail ?? result.state),
      usage: result.usage,
    });
    if (!terminalized) {
      return Result.err(
        workflowExecutionFailure("Agent operation terminal transition lost its fenced lease"),
      );
    }
    const published = await captureWorkflowExternal(() =>
      this.publishOperation(revision, operation, nextState, terminalFrom),
    );
    if (published.status === "error") return Result.err(published.error);
    if (result.usage) {
      const usagePublished = await captureWorkflowExternal(() =>
        this.publishUsage(run, revision, operation.operationId),
      );
      if (usagePublished.status === "error") return Result.err(usagePublished.error);
    }
    if (nextState !== "succeeded") {
      return Result.err(workflowExecutionFailure(result.detail ?? `Agent request ${nextState}`));
    }
    return Result.ok(result.output);
  }

  private async dispatchAgentSafely(
    run: WorkflowRun,
    revision: WorkflowRevision,
    operation: WorkflowOperation,
    input: ResolvedWorkflowAgentInput,
    signal: AbortSignal,
    reconcile: boolean,
  ): Promise<WorkflowExecutionResult<JsonValue>> {
    const dispatched = await this.dispatchAgent(run, revision, operation, input, signal, reconcile);
    if (dispatched.status === "ok" || this.stopping) return dispatched;
    const currentRunResult = this.input.store.getRun(run.runId);
    if (currentRunResult.status === "error") return dispatched;
    const currentRun = currentRunResult.value;
    if (currentRun?.claimedBy !== this.workerId) return dispatched;
    if (signal.aborted && currentRun?.state === "paused") return dispatched;
    const currentResult = this.input.store.getOperation(run.runId, operation.operationId);
    if (currentResult.status === "error") return dispatched;
    const current = currentResult.value;
    if (current && !isTerminalOperation(current.state)) {
      const state = signal.aborted ? "cancelled" : "failed";
      if (current.state === "queued" && state === "failed") {
        this.input.store.transitionOperation({
          runOwnerId: this.workerId,
          runId: run.runId,
          operationId: operation.operationId,
          from: "queued",
          to: "dispatched",
          now: this.now(),
        });
      }
      const latestOperation = this.input.store.getOperation(run.runId, operation.operationId);
      if (latestOperation.status === "error") return dispatched;
      const from = latestOperation.value?.state ?? current.state;
      this.input.store.transitionOperation({
        runOwnerId: this.workerId,
        runId: run.runId,
        operationId: operation.operationId,
        from,
        to: state,
        now: this.now(),
        error: dispatched.error.message,
      });
      const published = await captureWorkflowExternal(() =>
        this.publishOperation(revision, operation, state, from),
      );
      if (published.status === "error") return Result.err(published.error);
    }
    return dispatched;
  }

  private async waitForAgentRequest(input: {
    run: WorkflowRun;
    revision: WorkflowRevision;
    operation: WorkflowOperation;
    prompt: string;
    profile: "explore" | "general" | "self";
    model?: string;
    reasoning?: ResolvedWorkflowAgentInput["options"]["reasoning"];
    policy: WorkflowRequestPolicy;
    requestId: string;
    agentCwd: string;
    signal: AbortSignal;
    reconcile: boolean;
    dispatchEpoch: string;
    sessionId: string;
    publishRequest: boolean;
  }): Promise<AgentRequestResult> {
    let output = "";
    let usage: WorkflowUsage | null = null;
    let detail: string | null = null;
    let settled = false;
    let idleTimedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let idleCancellationTimer: ReturnType<typeof setTimeout> | null = null;
    let receiptTimer: ReturnType<typeof setTimeout> | null = null;
    let readingReceipt = false;
    let settle: (value: AgentRequestResult) => void = () => {};
    const result = new Promise<AgentRequestResult>((resolve) => (settle = resolve));
    const finishResult = (value: AgentRequestResult): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (idleCancellationTimer) clearTimeout(idleCancellationTimer);
      if (receiptTimer) clearTimeout(receiptTimer);
      settle(value);
    };
    const readExactReceipt = (): ResultType<
      WorkflowRequestTerminalReceipt | null,
      WorkflowTerminalReceiptReconciliationFailed
    > => {
      const receiptResult = this.input.store.getWorkflowRequestTerminalReceipt(input.requestId);
      if (receiptResult.status === "error") {
        return Result.err(toWorkflowTerminalReceiptReconciliationFailed(receiptResult.error));
      }
      const receipt = receiptResult.value;
      if (!receipt) return Result.ok(null);
      if (
        receipt.requestId !== input.requestId ||
        receipt.runId !== input.run.runId ||
        receipt.operationId !== input.operation.operationId ||
        receipt.dispatchEpoch !== input.dispatchEpoch
      ) {
        return Result.err(
          new WorkflowTerminalReceiptReconciliationFailed({
            message: "Terminal lifecycle receipt does not match its exact workflow dispatch",
          }),
        );
      }
      return Result.ok(receipt);
    };
    const adoptReceipt = async (
      receipt: WorkflowRequestTerminalReceipt,
      source: "receipt" | "terminal_receipt",
    ): Promise<ResultType<void, WorkflowTerminalReceiptReconciliationFailed>> => {
      const adopted = await captureWorkflowTerminalReceiptAdoption(() =>
        this.adoptTerminalReceipt(receipt, input.revision),
      );
      if (adopted.status === "error") {
        return Result.err(
          new WorkflowTerminalReceiptReconciliationFailed({ message: adopted.error.message }),
        );
      }
      finishResult({
        ...adopted.value,
        ...(idleTimedOut
          ? { state: "timed_out" as const, detail: "Agent operation idle timeout" }
          : {}),
        source,
      });
      return Result.ok(undefined);
    };
    const finishReceiptFailure = (
      state: AgentRequestResult["state"],
      receiptFailure: WorkflowTerminalReceiptReconciliationFailed,
    ): void => {
      finishResult({
        state,
        output: "",
        detail: receiptFailure.message,
        usage: state === "failed" ? null : usage,
        source: "terminal_without_receipt",
      });
    };
    const pollReceipt = async (): Promise<void> => {
      if (settled || readingReceipt || this.stopping) return;
      readingReceipt = true;
      try {
        const receipt = readExactReceipt();
        if (receipt.status === "error") {
          finishReceiptFailure("failed", receipt.error);
          return;
        }
        if (!receipt.value) return;
        const adopted = await adoptReceipt(receipt.value, "receipt");
        if (adopted.status === "error") finishReceiptFailure("failed", adopted.error);
      } finally {
        readingReceipt = false;
      }
    };
    const waitForReceiptPoll = (): Promise<void> =>
      new Promise((resolve) => {
        receiptTimer = setTimeout(resolve, this.input.receiptPollMs ?? 25);
        receiptTimer.unref?.();
      });
    const pollReceipts = async (): Promise<AgentRequestResult> => {
      while (!settled && !this.stopping) {
        await waitForReceiptPoll();
        await pollReceipt();
      }
      return await new Promise<AgentRequestResult>(() => {});
    };
    const publishIdleCancellation = async (): Promise<void> => {
      while (!settled && idleTimedOut && !this.stopping && !input.signal.aborted) {
        const published = await captureWorkflowIdleCancellationPublication(this.input.bus, {
          requestId: input.requestId,
          sessionId: input.sessionId,
          dispatchEpoch: input.dispatchEpoch,
        });
        if (published.status === "ok") return;
        await Bun.sleep(100);
      }
    };
    const idleCancellationStart = Promise.withResolvers<void>();
    const idleCancellationDefect = idleCancellationStart.promise
      .then(() => publishIdleCancellation())
      .then(() => new Promise<AgentRequestResult>(() => {}));
    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (settled || idleTimedOut) return;
        idleTimedOut = true;
        idleCancellationTimer = setTimeout(() => {
          finishResult({
            state: "timed_out",
            output: "",
            detail:
              "Agent operation idle cancellation did not reach an exact terminal receipt after process-tree quiescence wait",
            usage,
            source: "terminal_without_receipt",
          });
        }, IDLE_CANCEL_QUIESCENCE_WAIT_MS);
        idleCancellationTimer.unref?.();
        idleCancellationStart.resolve();
      }, input.revision.resources.operationIdleTimeoutMs);
      idleTimer.unref?.();
    };
    const resetIdle = (): void => {
      if (!idleTimedOut) armIdle();
    };
    const suffix = `${input.requestId}:${crypto.randomUUID()}`;
    const handleOutputMessage = async (
      message: DecodedLilacMessageForTopic<ReturnType<typeof outReqTopic>>,
    ): Promise<void> => {
      if (
        message.headers?.request_id !== input.requestId ||
        message.headers?.workflow_dispatch_epoch !== input.dispatchEpoch
      ) {
        return;
      }
      resetIdle();
      if (message.type === lilacEventTypes.EvtAgentOutputDeltaText) output += message.data.delta;
      if (message.type === lilacEventTypes.EvtAgentOutputTextReset) output = message.data.text;
      if (message.type === lilacEventTypes.EvtAgentOutputResponseText) {
        output = message.data.finalText;
        usage = message.data.usage ?? null;
      }
    };
    const handleLifecycleMessage = async (
      message: DecodedLilacMessageForTopic<"evt.request">,
    ): Promise<ResultType<void, WorkflowTerminalReceiptReconciliationFailed>> => {
      if (
        message.type !== lilacEventTypes.EvtRequestLifecycleChanged ||
        message.headers?.request_id !== input.requestId ||
        message.headers?.workflow_dispatch_epoch !== input.dispatchEpoch
      ) {
        return Result.ok(undefined);
      }
      resetIdle();
      detail = message.data.detail ?? null;
      const currentResult = this.input.store.getOperation(
        input.run.runId,
        input.operation.operationId,
      );
      if (currentResult.status === "error") {
        return Result.err(toWorkflowTerminalReceiptReconciliationFailed(currentResult.error));
      }
      const current = currentResult.value;
      if (message.data.state === "running" && current?.state === "dispatched") {
        this.input.store.transitionOperation({
          runOwnerId: this.workerId,
          runId: input.run.runId,
          operationId: input.operation.operationId,
          from: "dispatched",
          to: "running",
          now: this.now(),
        });
        await this.publishOperation(input.revision, input.operation, "running", "dispatched");
      }
      const terminalState = message.data.state;
      if (
        terminalState !== "resolved" &&
        terminalState !== "failed" &&
        terminalState !== "cancelled"
      ) {
        return Result.ok(undefined);
      }

      readingReceipt = true;
      try {
        const deadline = Date.now() + TERMINAL_RECEIPT_WAIT_MS;
        while (!settled && !this.stopping) {
          const receipt = readExactReceipt();
          if (receipt.status === "error") {
            finishReceiptFailure(terminalState, receipt.error);
            return Result.err(receipt.error);
          }
          if (receipt.value) {
            if (receipt.value.state !== terminalState) {
              const mismatch = new WorkflowTerminalReceiptReconciliationFailed({
                message: `Terminal lifecycle state ${terminalState} does not match durable receipt state ${receipt.value.state}`,
              });
              finishReceiptFailure(terminalState, mismatch);
              return Result.err(mismatch);
            }
            const adopted = await adoptReceipt(receipt.value, "terminal_receipt");
            if (adopted.status === "error") {
              finishReceiptFailure(terminalState, adopted.error);
              return Result.err(adopted.error);
            }
            return Result.ok(undefined);
          }
          if (Date.now() >= deadline) break;
          await Bun.sleep(10);
        }
        finishResult({
          state: terminalState,
          output: "",
          detail: detail ?? "Terminal lifecycle arrived without its exact durable receipt",
          usage,
          source: "terminal_without_receipt",
        });
      } finally {
        readingReceipt = false;
      }
      return Result.ok(undefined);
    };
    const outSubscription = await this.input.bus.subscribeTopic(
      outReqTopic(input.requestId),
      { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 100 } },
      async (message): Promise<ResultType<void, WorkflowOutputDeliveryFailed>> => {
        if (this.stopping) {
          return Result.err(
            new WorkflowOutputDeliveryFailed({
              message: "Workflow engine is stopping before request output can be handled",
            }),
          );
        }
        await handleOutputMessage(message);
        return Result.ok(undefined);
      },
      applyWorkflowEventDeliveryPolicy,
    );
    if (outSubscription.status === "error") {
      return failedAgentRequest(
        `Workflow output subscription failed: ${outSubscription.error.message}`,
      );
    }
    const outSub = outSubscription.value;
    const evtSubscription = await this.input.bus.subscribeTopic(
      "evt.request",
      {
        mode: "fanout",
        subscriptionId: `workflow-request:${suffix}`,
        consumerId: suffix,
        ephemeral: true,
        offset: { type: "begin" },
        batch: { maxWaitMs: 100 },
      },
      async (message): Promise<ResultType<void, WorkflowLifecycleDeliveryFailed>> => {
        if (this.stopping) {
          return Result.err(
            new WorkflowLifecycleDeliveryFailed({
              message: "Workflow engine is stopping before request lifecycle can be handled",
            }),
          );
        }
        await handleLifecycleMessage(message);
        return Result.ok(undefined);
      },
      applyWorkflowEventDeliveryPolicy,
    );
    if (evtSubscription.status === "error") {
      const cleanupFailures = await stopWorkflowEventSubscription("workflow output", outSub);
      const detail = [
        `Workflow lifecycle subscription failed: ${evtSubscription.error.message}`,
        ...cleanupFailures,
      ].join("; ");
      return failedAgentRequest(detail);
    }
    const evtSub = evtSubscription.value;
    const abortStart = Promise.withResolvers<void>();
    let abortStarted = false;
    const abortCancellation = abortStart.promise.then(async (): Promise<AgentRequestResult> => {
      if (input.signal.reason !== "workflow lease lost" && input.signal.reason !== "shutdown") {
        const published = await captureWorkflowIdleCancellationPublication(this.input.bus, {
          requestId: input.requestId,
          sessionId: input.sessionId,
        });
        if (published.status === "error") {
          return failedAgentRequest(published.error.message);
        }
      }
      return { state: "cancelled", output: "", detail: "Agent request cancelled", usage };
    });
    const abort = (): void => {
      if (abortStarted) return;
      abortStarted = true;
      abortStart.resolve();
    };
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    let terminal: AgentRequestResult | null = null;
    let cleanupFailures: readonly string[] = [];
    let abortOutcome: PromiseSettledResult<AgentRequestResult> | null = null;
    try {
      armIdle();
      await pollReceipt();
      const receiptPollingDefect = pollReceipts();
      if (input.reconcile || input.publishRequest) {
        let outputCursor: string | undefined;
        do {
          const fetched = await this.input.bus.fetchTopic(outReqTopic(input.requestId), {
            offset: outputCursor ? { type: "cursor", cursor: outputCursor } : { type: "begin" },
            limit: 1_000,
          });
          if (fetched.status === "error") {
            const fetchFailure = toWorkflowReconciliationFetchFailed(fetched.error);
            terminal = failedAgentRequest(fetchFailure.message);
            finishResult(terminal);
            break;
          }
          for (const entry of fetched.value.messages) await handleOutputMessage(entry.msg);
          const previous = outputCursor;
          outputCursor = fetched.value.next;
          if (fetched.value.messages.length < 1_000 || !outputCursor || outputCursor === previous) {
            break;
          }
        } while (!settled);

        if (terminal === null) {
          let lifecycleCursor: string | undefined;
          do {
            const fetched = await this.input.bus.fetchTopic("evt.request", {
              offset: lifecycleCursor
                ? { type: "cursor", cursor: lifecycleCursor }
                : { type: "begin" },
              limit: 1_000,
            });
            if (fetched.status === "error") {
              const fetchFailure = toWorkflowReconciliationFetchFailed(fetched.error);
              terminal = failedAgentRequest(fetchFailure.message);
              finishResult(terminal);
              break;
            }
            for (const entry of fetched.value.messages) {
              const handled = await handleLifecycleMessage(entry.msg);
              if (handled.status === "error") break;
            }
            const previous = lifecycleCursor;
            lifecycleCursor = fetched.value.next;
            if (
              fetched.value.messages.length < 1_000 ||
              !lifecycleCursor ||
              lifecycleCursor === previous
            ) {
              break;
            }
          } while (!settled);
        }
      }
      if (input.publishRequest && !settled) {
        await this.input.beforePromptPublication?.({
          requestId: input.requestId,
          runId: input.run.runId,
          operationId: input.operation.operationId,
          dispatchEpoch: input.dispatchEpoch,
          runOwnerId: this.workerId,
        });
        const publicationClaimed = this.input.store.claimWorkflowRequestPromptPublication({
          requestId: input.requestId,
          runId: input.run.runId,
          operationId: input.operation.operationId,
          runOwnerId: this.workerId,
          now: this.now(),
        });
        if (!publicationClaimed) {
          const fetchedReceipt = fetchWorkflowTerminalReceipt(this.input.store, input.requestId);
          if (fetchedReceipt.status === "error") {
            terminal = failedAgentRequest(fetchedReceipt.error.message);
            finishResult(terminal);
          } else {
            terminal = await this.adoptTerminalReceipt(fetchedReceipt.value, input.revision);
          }
        } else {
          const liveParent =
            input.run.completionTarget.kind === "live_parent" ? input.run.completionTarget : null;
          adaptEventPublishResultToHost(
            await this.input.bus.publish(
              lilacEventTypes.CmdRequestMessage,
              {
                queue: "prompt",
                messages: [{ role: "user", content: input.prompt }],
                ...(input.model ? { modelOverride: input.model } : {}),
                raw: {
                  workflow: {
                    runId: input.run.runId,
                    operationId: input.operation.operationId,
                    dispatchEpoch: input.dispatchEpoch,
                  },
                  subagent: {
                    profile: input.profile,
                    depth: liveParent?.depth ?? 1,
                    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
                    ...(liveParent
                      ? {
                          parentRequestId: liveParent.parentRequestId,
                          parentToolCallId: liveParent.parentToolCallId,
                        }
                      : {}),
                  },
                },
              },
              {
                headers: {
                  request_id: input.requestId,
                  session_id: input.sessionId,
                  request_client: "unknown",
                  workflow_run_id: input.run.runId,
                  workflow_operation_id: input.operation.operationId,
                  workflow_dispatch_epoch: input.dispatchEpoch,
                },
              },
            ),
          );
        }
      }
      terminal ??= await Promise.race([
        result,
        abortCancellation,
        receiptPollingDefect,
        idleCancellationDefect,
        outSub.done.then((done) => {
          if (done.status === "error") {
            return failedAgentRequest(eventDeliveryDoneDetail("Workflow output", done.error));
          }
          return failedAgentRequest("Workflow output delivery ended before request completion");
        }),
        evtSub.done.then((done) => {
          if (done.status === "error") {
            return failedAgentRequest(eventDeliveryDoneDetail("Workflow lifecycle", done.error));
          }
          return failedAgentRequest("Workflow lifecycle delivery ended before request completion");
        }),
      ]);
    } finally {
      input.signal.removeEventListener("abort", abort);
      if (abortStarted) [abortOutcome] = await Promise.allSettled([abortCancellation]);
      cleanupFailures = (
        await Promise.all([
          stopWorkflowEventSubscription("workflow output", outSub),
          stopWorkflowEventSubscription("workflow lifecycle", evtSub),
        ])
      ).flat();
    }
    if (abortOutcome?.status === "rejected") throw abortOutcome.reason;
    if (abortOutcome?.status === "fulfilled" && abortOutcome.value.state === "failed") {
      terminal = abortOutcome.value;
    }
    if (cleanupFailures.length > 0) {
      if (terminal.state === "resolved") return failedAgentRequest(cleanupFailures.join("; "));
      return {
        ...terminal,
        detail: [terminal.detail, ...cleanupFailures]
          .filter((detail) => detail !== null)
          .join("; "),
      };
    }
    return terminal;
  }

  private async adoptTerminalReceipt(
    receipt: WorkflowRequestTerminalReceipt,
    revision: WorkflowRevision,
  ): Promise<AgentRequestResult> {
    const storedOutput = receipt.resultArtifactId
      ? await loadWorkflowValueArtifact({
          dataDir: this.input.dataDir,
          artifactId: receipt.resultArtifactId,
          maxBytes: revision.limits.maxOperationOutputBytes,
        })
      : receipt.output;
    if (receipt.state === "resolved" && typeof storedOutput !== "string") {
      return failedAgentRequest("Resolved workflow terminal receipt has no adoptable text output");
    }
    return {
      state: receipt.state,
      output: typeof storedOutput === "string" ? storedOutput : "",
      detail: receipt.detail,
      usage: receipt.usage,
      source: "receipt",
    };
  }

  private async stopAgentRequests(runId: string): Promise<WorkflowExecutionResult<void>> {
    const runResult = this.input.store.getRun(runId);
    if (runResult.status === "error") {
      return Result.err(workflowExecutionFailure(runResult.error.message));
    }
    const target = runResult.value?.completionTarget;
    const operationsResult = this.input.store.listOperations(runId, { limit: 1_000 });
    if (operationsResult.status === "error") {
      return Result.err(workflowExecutionFailure(operationsResult.error.message));
    }
    const operations = operationsResult.value.filter(
      (operation) => operation.kind === "agent" && operation.requestId !== null,
    );
    const cancellations = await Promise.allSettled(
      operations.flatMap((operation) => {
        const requestId = operation.requestId;
        if (!requestId) return [];
        return [
          this.input.bus.publish(
            lilacEventTypes.CmdRequestMessage,
            {
              queue: "interrupt",
              messages: [],
              raw: { cancel: true, cancelQueued: true, requiresActive: false },
            },
            {
              headers: {
                request_id: requestId,
                session_id:
                  target?.kind === "live_parent"
                    ? target.childSessionId
                    : `workflow:${runId}:${operation.operationId}`,
                request_client: "unknown",
              },
            },
          ),
        ];
      }),
    );
    const failures: string[] = [];
    for (const cancellation of cancellations) {
      if (cancellation.status === "rejected") {
        if (isPanic(cancellation.reason)) preserveToolPanic(cancellation.reason);
        const cause =
          cancellation.reason instanceof Error
            ? cancellation.reason
            : new Error("Opaque workflow cancellation failure");
        failures.push(boundedError(cause));
      } else if (cancellation.value.status === "error") {
        failures.push(cancellation.value.error.message);
      }
    }
    if (failures.length > 0) {
      return Result.err(
        workflowExecutionFailure(
          `Failed to cancel agent requests for workflow ${runId}: ${failures.join("; ")}`,
        ),
      );
    }
    return Result.ok(undefined);
  }

  private async finishRun(
    original: WorkflowRun,
    state: "succeeded" | "failed",
    result: JsonValue,
    detail: string,
  ): Promise<WorkflowExecutionResult<void>> {
    const currentResult = this.input.store.getRun(original.runId);
    if (currentResult.status === "error") {
      return Result.err(workflowExecutionFailure(currentResult.error.message));
    }
    const current = currentResult.value;
    if (!current || current.state !== "running" || current.claimedBy !== this.workerId) {
      return Result.ok(undefined);
    }
    const revisionResult = this.input.store.getRevision(current.revisionId);
    if (revisionResult.status === "error") {
      return Result.err(workflowExecutionFailure(revisionResult.error.message));
    }
    const revision = revisionResult.value;
    if (!revision) {
      return Result.err(
        workflowExecutionFailure(`Workflow revision not found: ${current.revisionId}`),
      );
    }
    let finalState = state;
    let finalResult = result;
    let finalDetail = detail;
    const operations = this.input.store.listOperations(current.runId, { limit: 1_000 });
    if (operations.status === "error") {
      return Result.err(workflowExecutionFailure(operations.error.message));
    }
    const activeOperations = operations.value.filter(
      (operation) => !isTerminalOperation(operation.state),
    );
    if (state === "succeeded" && activeOperations.length > 0) {
      finalState = "failed";
      finalResult = null;
      finalDetail = "Workflow returned with outstanding unawaited host operations";
    }
    const resultBytes = Buffer.byteLength(canonicalJson(finalResult), "utf8");
    let resultArtifactId: string | null = null;
    if (finalState === "succeeded" && resultBytes > WORKFLOW_INLINE_VALUE_BYTES) {
      const persisted = await writeWorkflowValueArtifact({
        dataDir: this.input.dataDir,
        value: finalResult,
        maxBytes: revision.limits.maxResultBytes,
      });
      if (persisted.status === "error") {
        return Result.err(workflowExecutionFailure(persisted.error.message));
      }
      resultArtifactId = persisted.value;
    }
    const changed = this.input.store.terminalizeRun({
      runId: current.runId,
      from: "running",
      to: finalState,
      ownerId: this.workerId,
      now: this.now(),
      detail: finalDetail,
      result: resultArtifactId ? null : finalResult,
      resultArtifactId,
    });
    if (!changed) {
      return Result.err(
        workflowExecutionFailure("Workflow terminal transition lost its fenced lease"),
      );
    }
    if (finalState === "failed") {
      for (const operation of activeOperations) {
        if (!operation.requestId) continue;
        const cancelled = await this.input.bus.publish(
          lilacEventTypes.CmdRequestMessage,
          { queue: "interrupt", messages: [], raw: { cancel: true, cancelQueued: true } },
          {
            headers: {
              request_id: operation.requestId,
              session_id:
                current.completionTarget.kind === "live_parent"
                  ? current.completionTarget.childSessionId
                  : `workflow:${current.runId}:${operation.operationId}`,
              request_client: "unknown",
            },
          },
        );
        if (cancelled.status === "error") {
          return Result.err(workflowExecutionFailure(cancelled.error.message));
        }
      }
    }
    const updatedResult = this.input.store.getRun(current.runId);
    if (updatedResult.status === "error") {
      return Result.err(workflowExecutionFailure(updatedResult.error.message));
    }
    const updated = updatedResult.value;
    if (!updated) return Result.ok(undefined);
    const runPublished = await captureWorkflowExternal(() =>
      this.publishRun(updated, finalState, "running"),
    );
    if (runPublished.status === "error") return Result.err(runPublished.error);
    const ready = await this.input.bus.publish(lilacEventTypes.EvtWorkflowResultReady, {
      runId: updated.runId,
      revisionId: updated.revisionId,
      state: finalState,
      summary: finalDetail.slice(0, 1_000),
      ts: this.now(),
    });
    if (ready.status === "error") return Result.err(workflowExecutionFailure(ready.error.message));
    return Result.ok(undefined);
  }

  private async publishRun(
    run: WorkflowRun,
    state: WorkflowRun["state"],
    previousState?: WorkflowRun["state"],
  ): Promise<void> {
    adaptEventPublishResultToHost(
      await this.input.bus.publish(lilacEventTypes.EvtWorkflowRunChanged, {
        runId: run.runId,
        revisionId: run.revisionId,
        state,
        previousState,
        ts: this.now(),
      }),
    );
  }

  private async publishOperation(
    revision: WorkflowRevision,
    operation: WorkflowOperation,
    state: WorkflowOperationState,
    previousState?: WorkflowOperationState,
  ): Promise<void> {
    adaptEventPublishResultToHost(
      await this.input.bus.publish(lilacEventTypes.EvtWorkflowOperationChanged, {
        runId: operation.runId,
        revisionId: revision.revisionId,
        operationId: operation.operationId,
        kind: operation.kind,
        state,
        previousState,
        phase: operation.phase ?? undefined,
        label: operation.label ?? undefined,
        ts: this.now(),
      }),
    );
    adaptEventPublishResultToHost(
      await this.input.bus.publish(lilacEventTypes.EvtWorkflowProgressRequested, {
        runId: operation.runId,
        revisionId: revision.revisionId,
        reason: "operation_changed",
        ts: this.now(),
      }),
    );
  }

  private async publishUsage(
    run: WorkflowRun,
    revision: WorkflowRevision,
    operationIdValue: string,
  ): Promise<void> {
    const operations = this.input.store.listOperations(run.runId, { limit: 1_000 });
    if (operations.status === "error") signalDurableWorkflowReadErrorToHost(operations.error);
    const aggregate = operations.value.reduce(
      (usage, operation) => ({
        inputTokens: usage.inputTokens + (operation.usage?.inputTokens ?? 0),
        outputTokens: usage.outputTokens + (operation.usage?.outputTokens ?? 0),
        totalTokens: usage.totalTokens + (operation.usage?.totalTokens ?? 0),
        agentCount: usage.agentCount + (operation.kind === "agent" ? 1 : 0),
        activeAgents:
          usage.activeAgents +
          (operation.kind === "agent" && ["dispatched", "running"].includes(operation.state)
            ? 1
            : 0),
      }),
      { inputTokens: 0, outputTokens: 0, totalTokens: 0, agentCount: 0, activeAgents: 0 },
    );
    adaptEventPublishResultToHost(
      await this.input.bus.publish(lilacEventTypes.EvtWorkflowUsageChanged, {
        runId: run.runId,
        revisionId: revision.revisionId,
        operationId: operationIdValue,
        usage: aggregate,
        ts: this.now(),
      }),
    );
  }
}
