import {
  type DeliveryDisposition,
  type EventDeliveryDoneError,
  type EventDeliveryStartFailed,
  type EventDeliveryStopFailed,
  lilacEventTypes,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
import { Result, TaggedError, type Panic, type Result as ResultType } from "better-result";
import { createLogger, formatTaggedErrorForLog, isPanic } from "@stanley2058/lilac-utils";

import type { ContentOpts, MsgRef } from "../surface/types";
import type {
  RegisteredSurfacePlatform,
  RegisteredSurfaceWorkflowProgressPort,
  WorkflowProgressOperationFailed,
} from "../surface/runtime-descriptor";
import { adaptToolResultToHost } from "../tools/tool-result-adapters";
import {
  DurableWorkflowStore,
  signalDurableWorkflowReadErrorToHost,
} from "./durable-workflow-store";
import { sha256 } from "./workflow-definition";
import {
  sameWorkflowProgressTarget,
  type WorkflowProgressPermanentFailure,
  type WorkflowRun,
  type WorkflowProgressTarget,
  type WorkflowSurfaceActionKind,
  type WorkflowSurfaceBinding,
} from "./workflow-domain";
import { formatWorkflowErrorForLog } from "./workflow-error-log";
import { workflowConsumerId } from "./workflow-consumer-id";
import {
  buildWorkflowProgressViewResult,
  renderWorkflowProgressView,
  toSurfaceActions,
  type WorkflowProgressView,
} from "./workflow-progress-view";

const MAX_WORKFLOW_PROGRESS_TIMER_DELAY_MS = 24 * 60 * 60 * 1_000;
const WORKFLOW_PROGRESS_STARTUP_RECONCILIATION_BATCH_SIZE = 1_000;
const MAX_WORKFLOW_PROGRESS_RECONCILIATION_RETRY_DELAY_MS = 60_000;

export interface WorkflowProgressCardService {
  ensureInitialCard(runId: string): Promise<MsgRef>;
  requestProjection(runId: string): void;
}

type CachedActions = {
  key: string;
  ids: Map<WorkflowSurfaceActionKind, string>;
  recordIds: string[];
  expiresAt: number;
};

class WorkflowProgressProjectorStopping extends TaggedError("WorkflowProgressProjectorStopping")<{
  readonly message: string;
}> {}

class WorkflowProgressProjectionFailed extends TaggedError("WorkflowProgressProjectionFailed")<{
  readonly message: string;
}> {}

type WorkflowProgressSurfaceCallFailureFields =
  | { readonly failureKind: "created"; readonly createdRef: MsgRef; readonly message: string }
  | { readonly failureKind: "not-found"; readonly createdRef: null; readonly message: string }
  | {
      readonly failureKind: "failed";
      readonly createdRef: null;
      readonly failure: WorkflowProgressOperationFailed;
      readonly message: string;
    };

class WorkflowProgressSurfaceCreated extends TaggedError("WorkflowProgressSurfaceCreated")<
  Extract<WorkflowProgressSurfaceCallFailureFields, { failureKind: "created" }>
> {}

class WorkflowProgressSurfaceNotFound extends TaggedError("WorkflowProgressSurfaceNotFound")<
  Extract<WorkflowProgressSurfaceCallFailureFields, { failureKind: "not-found" }>
> {}

class WorkflowProgressSurfaceCallFailed extends TaggedError("WorkflowProgressSurfaceCallFailed")<
  Extract<WorkflowProgressSurfaceCallFailureFields, { failureKind: "failed" }>
> {}

type WorkflowProgressSurfaceFailure =
  | WorkflowProgressSurfaceCreated
  | WorkflowProgressSurfaceNotFound
  | WorkflowProgressSurfaceCallFailed;

type WorkflowProgressProjectionError =
  | WorkflowProgressProjectionFailed
  | WorkflowProgressSurfaceFailure;

type WorkflowProgressProjectionResult<T> = ResultType<T, WorkflowProgressProjectionError>;

type WorkflowProgressPortRegistration = {
  readonly platform: RegisteredSurfacePlatform;
  readonly port: RegisteredSurfaceWorkflowProgressPort;
};

function workflowProgressProjectionFailure(message: string): WorkflowProgressProjectionFailed {
  return new WorkflowProgressProjectionFailed({ message });
}

function workflowProgressSurfaceCallFailure(
  input: WorkflowProgressSurfaceCallFailureFields,
): WorkflowProgressSurfaceFailure {
  switch (input.failureKind) {
    case "created":
      return new WorkflowProgressSurfaceCreated(input);
    case "not-found":
      return new WorkflowProgressSurfaceNotFound(input);
    case "failed":
      return new WorkflowProgressSurfaceCallFailed(input);
  }
}

function findWorkflowProgressPort(
  ports: ReadonlyMap<RegisteredSurfacePlatform, RegisteredSurfaceWorkflowProgressPort>,
  platform: string,
): WorkflowProgressPortRegistration | undefined {
  for (const [registeredPlatform, port] of ports) {
    if (registeredPlatform === platform) return { platform: registeredPlatform, port };
  }
  return undefined;
}

function workflowProgressConfigurationRevision(
  target: WorkflowProgressTarget,
  registration: WorkflowProgressPortRegistration | undefined,
): string {
  return registration ? registration.port.configurationRevision : `missing-port:${target.platform}`;
}

function adaptWorkflowProgressProjectionResultToHost<T>(
  result: WorkflowProgressProjectionResult<T>,
): T {
  return adaptToolResultToHost(result);
}

type WorkflowProgressProjectorSubscription = {
  readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
  stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
};

function workflowProgressProjectorDeliveryPolicy(
  error: WorkflowProgressProjectorStopping,
): DeliveryDisposition {
  switch (error._tag) {
    case "WorkflowProgressProjectorStopping":
      return "stop";
  }
}

function adaptWorkflowProgressSubscriptionStartResultToHost(
  started: ResultType<WorkflowProgressProjectorSubscription, EventDeliveryStartFailed>,
): WorkflowProgressProjectorSubscription {
  if (started.status === "error") throw started.error;
  return started.value;
}

function adaptWorkflowProgressSubscriptionStopResultToHost(
  stopped: ResultType<void, EventDeliveryStopFailed>,
): void {
  if (stopped.status === "error") throw stopped.error;
}

const WORKFLOW_CARD_TEXT_LIMIT = 4_000;

function correlateWorkflowProgressMessageRef(input: {
  readonly runTargetPlatform: RegisteredSurfacePlatform;
  readonly runTargetChannelId: string;
  readonly bindingTarget: WorkflowProgressTarget;
  readonly messageRef: {
    readonly platform: string;
    readonly channelId: string;
    readonly messageId: string;
  };
}): { readonly kind: "correlated"; readonly ref: MsgRef } | { readonly kind: "mismatch" } {
  if (
    input.bindingTarget.platform !== input.runTargetPlatform ||
    input.bindingTarget.channelId !== input.runTargetChannelId ||
    input.messageRef.channelId !== input.runTargetChannelId
  ) {
    return { kind: "mismatch" };
  }
  switch (input.runTargetPlatform) {
    case "discord":
      if (input.messageRef.platform !== "discord") return { kind: "mismatch" };
      return {
        kind: "correlated",
        ref: {
          platform: "discord",
          channelId: input.messageRef.channelId,
          messageId: input.messageRef.messageId,
        },
      };
    case "github":
      if (input.messageRef.platform !== "github") return { kind: "mismatch" };
      return {
        kind: "correlated",
        ref: {
          platform: "github",
          channelId: input.messageRef.channelId,
          messageId: input.messageRef.messageId,
        },
      };
  }
}

function limitContentText(content: ContentOpts): ContentOpts {
  return content.text && content.text.length > WORKFLOW_CARD_TEXT_LIMIT
    ? { ...content, text: content.text.slice(0, WORKFLOW_CARD_TEXT_LIMIT) }
    : content;
}

function retryAt(now: number, retryCount: number, retryAfterMs?: number): number {
  const localDelay = Math.min(300_000, 1_000 * 2 ** Math.min(retryCount - 1, 8));
  const providerDelay =
    retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.min(Math.ceil(retryAfterMs), MAX_WORKFLOW_PROGRESS_TIMER_DELAY_MS)
      : 0;
  return Math.ceil(now + Math.max(localDelay, providerDelay));
}

function boundedTimerDelay(delayMs: number): number {
  if (!Number.isFinite(delayMs)) {
    return delayMs > 0 ? MAX_WORKFLOW_PROGRESS_TIMER_DELAY_MS : 0;
  }
  return Math.min(MAX_WORKFLOW_PROGRESS_TIMER_DELAY_MS, Math.max(0, delayMs));
}

type WorkflowProgressScheduledTimeout = { cancel(): void };
type WorkflowProgressProjectionTimer = WorkflowProgressScheduledTimeout & { readonly at: number };
type WorkflowProgressReconciliationCursor = { readonly updatedAt: number; readonly runId: string };
type WorkflowProgressReconciliationPosition =
  | { readonly kind: "start" }
  | { readonly kind: "after"; readonly cursor: WorkflowProgressReconciliationCursor };

export class WorkflowProgressProjector implements WorkflowProgressCardService {
  private readonly logger = createLogger({ module: "workflow-progress-projector" });
  private readonly timers = new Map<string, WorkflowProgressProjectionTimer>();
  private readonly lastEditAt = new Map<string, number>();
  private readonly actions = new Map<string, CachedActions>();
  private readonly actionRotationTimers = new Map<string, WorkflowProgressScheduledTimeout>();
  private readonly projectionInFlight = new Map<
    string,
    Promise<WorkflowProgressProjectionResult<MsgRef | null>>
  >();
  private subscription: WorkflowProgressProjectorSubscription | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private actionOutboxDrain: Promise<void> | null = null;
  private reconciliationDrain: Promise<void> | null = null;
  private reconciliationRetryTimer: WorkflowProgressScheduledTimeout | null = null;
  private reconciliationPosition: WorkflowProgressReconciliationPosition | null = null;
  private reconciliationRetryCount = 0;
  private readonly reportedFatalPanics = new WeakSet<Panic>();
  private stopping = false;

  constructor(
    private readonly input: {
      bus: LilacBus;
      store: DurableWorkflowStore;
      ports: ReadonlyMap<RegisteredSurfacePlatform, RegisteredSurfaceWorkflowProgressPort>;
      subscriptionId: string;
      now?: () => number;
      coalesceMs?: number;
      minEditIntervalMs?: number;
      retryIntervalMs?: number;
      reconciliationBatchSize?: number;
      scheduleTimeout?: (callback: () => void, delayMs: number) => WorkflowProgressScheduledTimeout;
      reportFatalPanic: (panic: Panic) => void;
    },
  ) {}

  private superviseDetached(effect: () => Promise<void>, event: string): void {
    const operation = Promise.resolve().then(effect);
    void Promise.allSettled([operation]).then(([settled]) => {
      if (settled.status !== "rejected") return;
      if (isPanic(settled.reason)) {
        if (this.reportedFatalPanics.has(settled.reason)) return;
        this.reportedFatalPanics.add(settled.reason);
        this.input.reportFatalPanic(settled.reason);
        return;
      }
      const error =
        settled.reason instanceof Error
          ? settled.reason
          : new Error("Opaque detached workflow progress failure");
      this.logger.error(event, formatWorkflowErrorForLog(error));
    });
  }

  private scheduleTimeout(callback: () => void, delayMs: number): WorkflowProgressScheduledTimeout {
    const boundedDelayMs = boundedTimerDelay(delayMs);
    if (this.input.scheduleTimeout) return this.input.scheduleTimeout(callback, boundedDelayMs);
    const timer = setTimeout(callback, boundedDelayMs);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  }

  private startWorkflowProgressSubscriptionResult(): Promise<
    ResultType<WorkflowProgressProjectorSubscription, EventDeliveryStartFailed>
  > {
    return this.input.bus.subscribeTopic(
      "evt.workflow",
      {
        mode: "fanout",
        subscriptionId: this.input.subscriptionId,
        consumerId: workflowConsumerId(this.input.subscriptionId),
        offset: { type: "now" },
        batch: { maxWaitMs: 1_000 },
      },
      async (message): Promise<ResultType<void, WorkflowProgressProjectorStopping>> => {
        if (this.stopping) {
          return Result.err(
            new WorkflowProgressProjectorStopping({
              message: "Workflow progress projector is stopping",
            }),
          );
        }
        if (
          message.type === lilacEventTypes.EvtWorkflowRunChanged ||
          message.type === lilacEventTypes.EvtWorkflowOperationChanged ||
          message.type === lilacEventTypes.EvtWorkflowProgressRequested ||
          message.type === lilacEventTypes.EvtWorkflowUsageChanged ||
          message.type === lilacEventTypes.EvtWorkflowResultReady
        ) {
          this.requestProjection(message.data.runId);
        }
        return Result.ok(undefined);
      },
      workflowProgressProjectorDeliveryPolicy,
    );
  }

  private stopWorkflowProgressSubscriptionResult(
    subscription: WorkflowProgressProjectorSubscription,
  ): Promise<ResultType<void, EventDeliveryStopFailed>> {
    return subscription.stop();
  }

  async start(): Promise<void> {
    this.stopping = false;
    const subscription = adaptWorkflowProgressSubscriptionStartResultToHost(
      await this.startWorkflowProgressSubscriptionResult(),
    );
    this.subscription = subscription;
    this.superviseDetached(async () => {
      const done = await subscription.done;
      if (this.stopping) return;
      this.logger.error(
        "Workflow progress projector subscription terminated unexpectedly",
        done.status === "error"
          ? formatTaggedErrorForLog(done.error)
          : { error: "Subscription completed without being stopped" },
      );
    }, "Workflow progress projector subscription observer failed");

    await this.drainActionOutboxProjections();
    const reconciliationCursor = await this.reconcilePage();
    if (reconciliationCursor) {
      this.reconciliationPosition = { kind: "after", cursor: reconciliationCursor };
      this.startReconciliationDrain();
    }
    this.retryTimer = setInterval(() => {
      this.superviseDetached(async () => {
        this.retryDue();
        await this.drainActionOutboxProjections();
      }, "Workflow progress retry cycle failed");
    }, this.input.retryIntervalMs ?? 1_000);
    this.retryTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
    for (const timer of this.timers.values()) timer.cancel();
    for (const timer of this.actionRotationTimers.values()) timer.cancel();
    this.reconciliationRetryTimer?.cancel();
    this.reconciliationRetryTimer = null;
    this.timers.clear();
    this.actionRotationTimers.clear();
    const subscription = this.subscription;
    this.subscription = null;
    if (subscription) {
      adaptWorkflowProgressSubscriptionStopResultToHost(
        await this.stopWorkflowProgressSubscriptionResult(subscription),
      );
      const done = await subscription.done;
      if (done.status === "error" && done.error._tag !== "EventDeliveryStopped") {
        this.logger.error(
          "Workflow progress projector subscription terminated",
          formatTaggedErrorForLog(done.error),
        );
      }
    }
    await this.actionOutboxDrain;
    await this.reconciliationDrain;
    this.reconciliationDrain = null;
    this.reconciliationPosition = null;
    this.reconciliationRetryCount = 0;
    while (this.projectionInFlight.size > 0) {
      await Promise.allSettled(this.projectionInFlight.values());
    }
  }

  requestProjection(runId: string): void {
    if (this.stopping || this.timers.has(runId)) return;
    const now = this.input.now?.() ?? Date.now();
    const last = this.lastEditAt.get(runId) ?? 0;
    const delay = Math.max(
      this.input.coalesceMs ?? 250,
      last + (this.input.minEditIntervalMs ?? 1_000) - now,
    );
    this.scheduleProjectionAfter(runId, Math.max(0, delay));
  }

  private scheduleProjectionAfter(runId: string, delayMs: number): void {
    if (this.stopping) return;
    const now = this.input.now?.() ?? Date.now();
    const boundedDelayMs = boundedTimerDelay(delayMs);
    const at = now + boundedDelayMs;
    const existing = this.timers.get(runId);
    if (existing && existing.at <= at) return;
    existing?.cancel();
    const timeout = this.scheduleTimeout(() => {
      this.timers.delete(runId);
      this.superviseDetached(async () => {
        const projected = await this.project(runId);
        if (projected.status === "ok") return;
        this.logger.warn("Workflow projection failed", {
          runId,
          ...formatTaggedErrorForLog(projected.error),
        });
      }, "Workflow projection timer failed");
    }, boundedDelayMs);
    const timer = { at, cancel: timeout.cancel };
    this.timers.set(runId, timer);
  }

  private scheduleProjectionAt(runId: string, attemptAt: number, now: number): void {
    this.scheduleProjectionAfter(runId, Math.max(0, attemptAt - now));
  }

  async ensureInitialCard(runId: string): Promise<MsgRef> {
    const messageRef = adaptWorkflowProgressProjectionResultToHost(await this.project(runId, true));
    if (!messageRef) {
      return adaptWorkflowProgressProjectionResultToHost(
        Result.err(
          workflowProgressProjectionFailure(
            `Workflow run ${runId} has no supported durable progress target`,
          ),
        ),
      );
    }
    return messageRef;
  }

  async reconcile(): Promise<void> {
    if (this.stopping) return;
    this.reconciliationRetryTimer?.cancel();
    this.reconciliationRetryTimer = null;
    if (this.reconciliationDrain) return await this.reconciliationDrain;
    if (!this.reconciliationPosition) this.reconciliationPosition = { kind: "start" };
    this.startReconciliationDrain();
    await this.reconciliationDrain;
  }

  private startReconciliationDrain(): void {
    if (this.stopping || this.reconciliationDrain || !this.reconciliationPosition) return;
    const operation = Promise.resolve().then(async () => this.drainReconciliationPages());
    const drain = Promise.allSettled([operation]).then(([settled]) => {
      this.reconciliationDrain = null;
      if (settled.status === "fulfilled") return;
      if (isPanic(settled.reason)) {
        this.reconciliationPosition = null;
        this.reconciliationRetryCount = 0;
        if (this.reportedFatalPanics.has(settled.reason)) return;
        this.reportedFatalPanics.add(settled.reason);
        this.input.reportFatalPanic(settled.reason);
        return;
      }
      const error =
        settled.reason instanceof Error
          ? settled.reason
          : new Error("Opaque owned workflow progress failure");
      this.logger.error(
        "Workflow background projection reconciliation failed",
        formatWorkflowErrorForLog(error),
      );
      this.scheduleReconciliationRetry();
    });
    this.reconciliationDrain = drain;
  }

  private scheduleReconciliationRetry(): void {
    if (this.stopping || this.reconciliationRetryTimer || !this.reconciliationPosition) return;
    const delayMs = Math.min(
      MAX_WORKFLOW_PROGRESS_RECONCILIATION_RETRY_DELAY_MS,
      1_000 * 2 ** Math.min(this.reconciliationRetryCount, 6),
    );
    this.reconciliationRetryCount += 1;
    this.reconciliationRetryTimer = this.scheduleTimeout(() => {
      this.reconciliationRetryTimer = null;
      if (this.stopping) return;
      this.startReconciliationDrain();
    }, delayMs);
  }

  private async drainReconciliationPages(): Promise<void> {
    while (this.reconciliationPosition && !this.stopping) {
      const position = this.reconciliationPosition;
      const next = await this.reconcilePage(
        position.kind === "after" ? position.cursor : undefined,
      );
      this.reconciliationRetryCount = 0;
      this.reconciliationPosition = next ? { kind: "after", cursor: next } : null;
    }
  }

  private hasMatchingPermanentGate(run: WorkflowRun): boolean {
    const target = run.progressTarget;
    if (!target) return false;
    const bindingResult = this.input.store.getSurfaceBinding(run.runId);
    if (bindingResult.status === "error") signalDurableWorkflowReadErrorToHost(bindingResult.error);
    const binding = bindingResult.value;
    if (!binding?.permanentFailure || !sameWorkflowProgressTarget(binding.target, target)) {
      return false;
    }
    const registration = findWorkflowProgressPort(this.input.ports, target.platform);
    const configurationRevision = workflowProgressConfigurationRevision(target, registration);
    return binding.permanentFailure.configurationRevision === configurationRevision;
  }

  private async reconcilePage(
    after?: WorkflowProgressReconciliationCursor,
  ): Promise<WorkflowProgressReconciliationCursor | undefined> {
    const batchSize = Math.max(
      1,
      Math.floor(
        this.input.reconciliationBatchSize ?? WORKFLOW_PROGRESS_STARTUP_RECONCILIATION_BATCH_SIZE,
      ),
    );
    const runs = this.input.store.listRunsNeedingProjectionReconciliation({
      limit: batchSize,
      ...(after === undefined ? {} : { after }),
    });
    if (runs.status === "error") signalDurableWorkflowReadErrorToHost(runs.error);
    for (const run of runs.value) {
      if (this.stopping) return undefined;
      if (this.hasMatchingPermanentGate(run)) continue;
      const projected = await this.project(run.runId, false, true);
      if (projected.status === "error") {
        this.logger.warn("Workflow projection reconciliation failed", {
          runId: run.runId,
          ...formatTaggedErrorForLog(projected.error),
        });
      }
    }
    if (runs.value.length < batchSize) return undefined;
    const last = runs.value.at(-1);
    return last ? { updatedAt: last.updatedAt, runId: last.runId } : undefined;
  }

  private retryDue(): void {
    const now = this.input.now?.() ?? Date.now();
    const bindings = this.input.store.listSurfaceBindings({ dueBefore: now, limit: 1_000 });
    if (bindings.status === "error") {
      this.logger.warn(
        "Workflow projection retry read failed",
        formatTaggedErrorForLog(bindings.error),
      );
      return;
    }
    for (const binding of bindings.value) {
      this.requestProjection(binding.runId);
    }
  }

  private async drainActionOutboxProjections(): Promise<void> {
    if (this.actionOutboxDrain) return await this.actionOutboxDrain;
    const drain = this.drainPendingActionOutboxProjections();
    this.actionOutboxDrain = drain;
    try {
      await drain;
    } finally {
      if (this.actionOutboxDrain === drain) this.actionOutboxDrain = null;
    }
  }

  private async drainPendingActionOutboxProjections(): Promise<void> {
    const entries = this.input.store.listPendingActionOutboxProjections();
    if (entries.status === "error") {
      this.logger.warn(
        "Workflow action outbox projection read failed",
        formatTaggedErrorForLog(entries.error),
      );
      return;
    }
    for (const entry of entries.value) {
      const projected = await this.project(entry.runId);
      if (projected.status === "error") {
        this.logger.warn("Workflow action outbox projection failed", {
          outboxId: entry.outboxId,
          runId: entry.runId,
          ...formatTaggedErrorForLog(projected.error),
        });
        continue;
      }
      if (
        !this.input.store.markActionOutboxProjected({
          outboxId: entry.outboxId,
          now: this.input.now?.() ?? Date.now(),
        })
      ) {
        this.logger.warn("Workflow action outbox projection was already completed", {
          outboxId: entry.outboxId,
          runId: entry.runId,
        });
      }
    }
  }

  private async project(
    runId: string,
    requireMessage = false,
    verifyExisting = false,
  ): Promise<WorkflowProgressProjectionResult<MsgRef | null>> {
    const previous = this.projectionInFlight.get(runId);
    let projection: Promise<WorkflowProgressProjectionResult<MsgRef | null>>;
    projection = (async () => {
      if (previous) await previous;
      return await this.projectRun(runId, requireMessage, verifyExisting);
    })();
    this.projectionInFlight.set(runId, projection);
    try {
      return await projection;
    } finally {
      if (this.projectionInFlight.get(runId) === projection) {
        this.projectionInFlight.delete(runId);
      }
    }
  }

  private issueActions(
    runId: string,
    view: WorkflowProgressView,
    messageRef: MsgRef | null,
    now: number,
  ): CachedActions {
    const expectedUserId = view.run.origin.userId;
    const expectedPlatform = view.run.origin.client;
    const key = `${view.run.state}:${expectedPlatform}:${expectedUserId}:${view.availableActions.join(",")}`;
    const cached = this.actions.get(runId);
    if (cached?.key === key && cached.expiresAt > now + 60_000) return cached;

    this.input.store.expireActiveSurfaceActions(runId, now);
    const ids = new Map<WorkflowSurfaceActionKind, string>();
    const recordIds: string[] = [];
    const expiresAt = now + 86_400_000;
    if (
      expectedUserId &&
      expectedPlatform &&
      findWorkflowProgressPort(this.input.ports, expectedPlatform) !== undefined &&
      expectedPlatform === view.run.progressTarget?.platform
    ) {
      for (const kind of view.availableActions) {
        const token = crypto.randomUUID();
        const actionId = `wfaction:${crypto.randomUUID()}`;
        if (
          !this.input.store.createSurfaceAction({
            actionId,
            tokenSha256: sha256(token),
            runId,
            kind,
            expectedPlatform,
            expectedUserId,
            expectedMessageRef: messageRef,
            expiresAt: now + 86_400_000,
            consumedAt: null,
            consumedByPlatform: null,
            consumedByUserId: null,
            createdAt: now,
          })
        ) {
          continue;
        }
        ids.set(kind, token);
        recordIds.push(actionId);
      }
    }
    const next = { key, ids, recordIds, expiresAt };
    this.actions.set(runId, next);
    return next;
  }

  private writeRetryableFailure(
    binding: WorkflowSurfaceBinding,
    message: string,
    now: number,
    retryAfterMs?: number,
    overrides?: Partial<Pick<typeof binding, "messageRef" | "lastRenderedSha256">>,
  ): void {
    const retryCount = binding.retryCount + 1;
    const nextAttemptAt = retryAt(now, retryCount, retryAfterMs);
    this.input.store.upsertSurfaceBinding({
      ...binding,
      ...overrides,
      lastError: message,
      retryCount,
      nextAttemptAt,
      permanentFailure: null,
      updatedAt: now,
    });
    this.scheduleProjectionAt(binding.runId, nextAttemptAt, now);
  }

  private writePermanentFailure(
    binding: WorkflowSurfaceBinding,
    failure: WorkflowProgressPermanentFailure,
    now: number,
    overrides?: Partial<Pick<typeof binding, "messageRef" | "lastRenderedSha256">>,
  ): void {
    const nextBinding = {
      ...binding,
      ...overrides,
      lastError: failure.message,
      nextAttemptAt: null,
      permanentFailure: failure,
      updatedAt: now,
    };
    this.input.store.commitSurfaceBindingWithActionRevocation(nextBinding, now);
    this.invalidateActionCache(binding.runId);
  }

  private invalidateActionCache(runId: string): void {
    this.actions.delete(runId);
    const timer = this.actionRotationTimers.get(runId);
    timer?.cancel();
    this.actionRotationTimers.delete(runId);
  }

  private scheduleActionRotation(runId: string, issued: CachedActions, now: number): void {
    const prior = this.actionRotationTimers.get(runId);
    prior?.cancel();
    this.actionRotationTimers.delete(runId);
    if (this.stopping || issued.recordIds.length === 0) return;
    const timer = this.scheduleTimeout(
      () => {
        this.actionRotationTimers.delete(runId);
        this.superviseDetached(async () => {
          this.requestProjection(runId);
        }, "Workflow action rotation timer failed");
      },
      Math.max(1_000, issued.expiresAt - now - 60_000),
    );
    this.actionRotationTimers.set(runId, timer);
  }

  private async projectRun(
    runId: string,
    requireMessage: boolean,
    verifyExisting: boolean,
  ): Promise<WorkflowProgressProjectionResult<MsgRef | null>> {
    const runResult = this.input.store.getRun(runId);
    if (runResult.status === "error") {
      return Result.err(workflowProgressProjectionFailure(runResult.error.message));
    }
    const run = runResult.value;
    if (run?.progressTarget === null) {
      if (requireMessage) {
        return Result.err(
          workflowProgressProjectionFailure(
            `Workflow run ${runId} has no supported durable progress target`,
          ),
        );
      }
      return Result.ok(null);
    }

    const now = this.input.now?.() ?? Date.now();
    const viewResult = await buildWorkflowProgressViewResult({
      store: this.input.store,
      runId,
      now,
    });
    if (viewResult.status === "error") {
      return Result.err(workflowProgressProjectionFailure(viewResult.error.message));
    }
    const view = viewResult.value;
    const target = view.run.progressTarget;
    if (!target) {
      return Result.err(
        workflowProgressProjectionFailure(
          `Workflow run ${runId} has no supported durable progress target`,
        ),
      );
    }
    const registration = findWorkflowProgressPort(this.input.ports, target.platform);
    const existingResult = this.input.store.getSurfaceBinding(runId);
    if (existingResult.status === "error") {
      return Result.err(workflowProgressProjectionFailure(existingResult.error.message));
    }
    let existing: WorkflowSurfaceBinding | null = existingResult.value;
    let messageRef: MsgRef | null = null;
    if (existing && !sameWorkflowProgressTarget(existing.target, target)) {
      existing = {
        ...existing,
        target,
        messageRef: null,
        lastRenderedSha256: null,
        lastError: null,
        retryCount: 0,
        nextAttemptAt: null,
        permanentFailure: null,
        updatedAt: now,
      };
      this.input.store.commitSurfaceBindingWithActionRevocation(existing, now);
      this.invalidateActionCache(runId);
    }
    if (existing?.messageRef && registration) {
      const correlated = correlateWorkflowProgressMessageRef({
        runTargetPlatform: registration.platform,
        runTargetChannelId: target.channelId,
        bindingTarget: existing.target,
        messageRef: existing.messageRef,
      });
      switch (correlated.kind) {
        case "correlated":
          messageRef = correlated.ref;
          break;
        case "mismatch":
          existing = {
            ...existing,
            target,
            messageRef: null,
            lastRenderedSha256: null,
            lastError: null,
            retryCount: 0,
            nextAttemptAt: null,
            permanentFailure: null,
            updatedAt: now,
          };
          this.input.store.commitSurfaceBindingWithActionRevocation(existing, now);
          this.invalidateActionCache(runId);
          break;
      }
    }
    if (!existing) {
      existing = {
        runId,
        target,
        messageRef: null,
        lastRenderedSha256: null,
        lastError: null,
        retryCount: 0,
        nextAttemptAt: null,
        permanentFailure: null,
        createdAt: now,
        updatedAt: now,
      };
      this.input.store.upsertSurfaceBinding(existing);
    }
    if (existing.nextAttemptAt !== null && existing.nextAttemptAt > now) {
      this.scheduleProjectionAt(runId, existing.nextAttemptAt, now);
      if (!requireMessage) return Result.ok(messageRef);
      return Result.err(
        workflowProgressProjectionFailure(
          `Workflow progress retry is deferred until ${existing.nextAttemptAt}`,
        ),
      );
    }
    const configurationRevision = workflowProgressConfigurationRevision(target, registration);
    if (existing.permanentFailure) {
      if (existing.permanentFailure.configurationRevision === configurationRevision) {
        if (!requireMessage) return Result.ok(messageRef);
        return Result.err(workflowProgressProjectionFailure(existing.permanentFailure.message));
      }
      existing = {
        ...existing,
        lastError: null,
        retryCount: 0,
        nextAttemptAt: null,
        permanentFailure: null,
        updatedAt: now,
      };
      this.input.store.commitSurfaceBindingWithActionRevocation(existing, now);
      this.invalidateActionCache(runId);
    }
    if (!registration) {
      const message = `Workflow run ${runId} has no declared durable progress port`;
      this.writePermanentFailure(
        existing,
        {
          operation: "check-message",
          reason: "missing-port",
          configurationRevision,
          message,
          failedAt: now,
        },
        now,
      );
      if (!requireMessage) return Result.ok(messageRef);
      return Result.err(workflowProgressProjectionFailure(message));
    }
    const { platform, port } = registration;
    if (
      messageRef &&
      (verifyExisting || (existing.nextAttemptAt !== null && existing.nextAttemptAt <= now))
    ) {
      const checked = await port.checkMessage({
        channelId: messageRef.channelId,
        messageId: messageRef.messageId,
      });
      let found: boolean;
      switch (checked.status) {
        case "error": {
          switch (checked.error.kind) {
            case "failed": {
              const error = new WorkflowProgressSurfaceCallFailed({
                failureKind: "failed",
                createdRef: null,
                failure: checked.error.error,
                message: checked.error.error.message,
              });
              switch (error.failure.disposition) {
                case "retryable":
                  this.writeRetryableFailure(
                    existing,
                    error.message,
                    now,
                    error.failure.retryAfterMs,
                  );
                  break;
                case "permanent":
                  this.writePermanentFailure(
                    existing,
                    {
                      operation: error.failure.operation,
                      reason: error.failure.reason,
                      configurationRevision: port.configurationRevision,
                      message: error.message,
                      failedAt: now,
                    },
                    now,
                  );
                  if (!requireMessage) return Result.ok(messageRef);
                  break;
              }
              return Result.err(error);
            }
          }
        }
        case "ok":
          switch (checked.value) {
            case "found":
              found = true;
              break;
            case "missing":
              found = false;
              break;
          }
          break;
      }
      existing = {
        ...existing,
        messageRef: found ? existing.messageRef : null,
        lastRenderedSha256: found ? existing.lastRenderedSha256 : null,
        lastError: null,
        retryCount: 0,
        nextAttemptAt: null,
        permanentFailure: null,
        updatedAt: now,
      };
      this.input.store.upsertSurfaceBinding(existing);
      if (!found) messageRef = null;
    }

    const issued = this.issueActions(runId, view, messageRef, now);
    const content = limitContentText(
      renderWorkflowProgressView({
        view,
        platform,
        actions: toSurfaceActions({ view, actionIds: issued.ids }),
      }),
    );
    const renderedSha256 = sha256(
      JSON.stringify({
        text: content.text,
        actions: content.actions,
        revision: view.revision.sourceSha256,
      }),
    );
    if (messageRef && existing.lastRenderedSha256 === renderedSha256) {
      return Result.ok(messageRef);
    }

    let projected: ResultType<MsgRef, WorkflowProgressSurfaceFailure>;
    if (messageRef) {
      const edited = await port.edit(
        { channelId: messageRef.channelId, messageId: messageRef.messageId },
        content,
      );
      switch (edited.status) {
        case "ok":
          projected = Result.ok(messageRef);
          break;
        case "error":
          switch (edited.error.kind) {
            case "not-found":
              projected = Result.err(
                workflowProgressSurfaceCallFailure({
                  failureKind: "not-found",
                  createdRef: null,
                  message: "Workflow progress message was not found",
                }),
              );
              break;
            case "failed":
              projected = Result.err(
                workflowProgressSurfaceCallFailure({
                  failureKind: "failed",
                  createdRef: null,
                  failure: edited.error.error,
                  message: edited.error.error.message,
                }),
              );
              break;
          }
          break;
      }
    } else {
      const sent = await port.send({
        channelId: target.channelId,
        content,
        ...(target.replyToMessageId ? { replyToMessageId: target.replyToMessageId } : {}),
        silent: true,
      });
      switch (sent.status) {
        case "ok":
          projected = Result.ok(sent.value);
          break;
        case "error":
          switch (sent.error.kind) {
            case "created":
              projected = Result.err(
                workflowProgressSurfaceCallFailure({
                  failureKind: "created",
                  createdRef: sent.error.ref,
                  message: "Workflow progress message was created but could not be fully rendered",
                }),
              );
              break;
            case "failed":
              projected = Result.err(
                workflowProgressSurfaceCallFailure({
                  failureKind: "failed",
                  createdRef: null,
                  failure: sent.error.error,
                  message: sent.error.error.message,
                }),
              );
              break;
          }
          break;
      }
    }
    let error: WorkflowProgressSurfaceFailure;
    switch (projected.status) {
      case "ok": {
        const projectedRef = projected.value;
        this.input.store.commitSurfaceProjection({
          binding: {
            ...existing,
            target,
            messageRef: projectedRef,
            lastRenderedSha256: renderedSha256,
            lastError: null,
            retryCount: 0,
            nextAttemptAt: null,
            permanentFailure: null,
            updatedAt: now,
          },
          actionIds: issued.recordIds,
        });
        this.lastEditAt.set(runId, now);
        this.scheduleActionRotation(runId, issued, now);
        return Result.ok(projectedRef);
      }
      case "error":
        error = projected.error;
        break;
    }
    switch (error._tag) {
      case "WorkflowProgressSurfaceCreated":
        this.writeRetryableFailure(existing, error.message, now, undefined, {
          messageRef: error.createdRef,
          lastRenderedSha256: existing.lastRenderedSha256,
        });
        if (requireMessage) return Result.ok(error.createdRef);
        return Result.err(error);
      case "WorkflowProgressSurfaceNotFound":
        this.writeRetryableFailure(existing, error.message, now, undefined, {
          messageRef: null,
          lastRenderedSha256: null,
        });
        break;
      case "WorkflowProgressSurfaceCallFailed":
        switch (error.failure.disposition) {
          case "retryable":
            this.writeRetryableFailure(existing, error.message, now, error.failure.retryAfterMs, {
              messageRef,
              lastRenderedSha256: existing.lastRenderedSha256,
            });
            break;
          case "permanent":
            this.writePermanentFailure(
              existing,
              {
                operation: error.failure.operation,
                reason: error.failure.reason,
                configurationRevision: port.configurationRevision,
                message: error.message,
                failedAt: now,
              },
              now,
              {
                messageRef,
                lastRenderedSha256: existing.lastRenderedSha256,
              },
            );
            if (!requireMessage) return Result.ok(messageRef);
            break;
        }
        break;
    }
    if (requireMessage)
      return Result.err(
        workflowProgressProjectionFailure(
          `Workflow run ${runId} was persisted, but its initial progress card could not be created: ${error.message}`,
        ),
      );
    return Result.err(error);
  }
}
